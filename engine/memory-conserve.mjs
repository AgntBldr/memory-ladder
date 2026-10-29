import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { args, locations, repoRoot, requireMemory, isDirect, listMd, walkMd, read, readRequired, utf8Bytes, parseFrontmatter, pathKey, loadConfig, repoPath } from './lib.mjs';

const patterns = {
  sha: /\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g,
  date: /\b20\d\d-\d\d-\d\d\b/g,
  url: /https?:\/\/[^\s)>\]"'\x60]+/g,
  rowid: /\b(?:lst|cap|fld|acc|usr|job|wh|evt|row)_[A-Za-z0-9]{6,}\b/g,
  brainid: /\b(?:dec|fct|pat|cpt|con|hyp|prj|tsk|ref|src|pbk|pil|evt)-[a-z0-9-]{4,}\b/g,
  lesson: /#\d{1,3}[a-z]?\b/g,
  version: /\bv\d+\.\d+\.\d+\b/g,
};
export function distinctiveTokens(text) {
  const fm = parseFrontmatter(text);
  if (fm.raw) text = fm.raw.split(/\r?\n/).filter(line => !/^\s*(?:originSessionId|modified):/.test(line)).join('\n') + '\n' + fm.body;
  const tokens = new Set();
  for (const part of text.split(/[\s\x60()\[\]<>"'*,;]+/)) {
    const candidate = part.replace(/:\d+$/, '').replace(/#.*$/, '').replace(/^[.(]+/, '').replace(/[.,;:!?]+$/, '');
    if (/^[\w./-]{1,200}\.(?:ts|tsx|mjs|cjs|js|json|md|toml|ps1|sql|yml|yaml)$/.test(candidate)) tokens.add(candidate);
  }
  for (const [name, pattern] of Object.entries(patterns)) {
    for (const match of text.matchAll(pattern)) tokens.add(name === 'url' ? match[0].replace(/[.,;:!?*)\]>"']+$/, '') : match[0]);
  }
  return [...tokens].sort();
}
export function snapshot({ memoryDir, repo = repoRoot(), extraFiles = [] }) {
  requireMemory(memoryDir);
  const files = {}, union = new Set();
  for (const name of listMd(memoryDir)) {
    const text = read(path.join(memoryDir, name)), tokens = distinctiveTokens(text);
    files[name] = { bytes: utf8Bytes(text), sha256: createHash('sha256').update(text, 'utf8').digest('hex'), tokens };
    for (const token of tokens) union.add(token);
  }
  for (const file of extraFiles) {
    const text = readRequired(path.join(repo, file)), tokens = distinctiveTokens(text);
    files[`repo:${file}`] = { bytes: utf8Bytes(text), sha256: hash(text), tokens };
    for (const token of tokens) union.add(token);
  }
  return { takenAt: new Date().toISOString(), extraFiles, files, union: [...union].sort() };
}
export function verify({ baseline, memoryDir, repo, accepted, extraFiles = [], config = loadConfig() }) {
  requireMemory(memoryDir);
  const base = typeof baseline === 'string' ? JSON.parse(readRequired(baseline)) : baseline;
  if (!base || !Array.isArray(base.union) || !base.files) throw new Error('Invalid baseline');
  const approval = typeof accepted === 'string' ? JSON.parse(readRequired(accepted)) : accepted;
  if (approval && (!Array.isArray(approval.accepted) || approval.accepted.some(e => typeof e.token !== 'string' || typeof e.reason !== 'string' || !e.reason.trim()))) throw new Error('Accepted tokens require token and reason');
  const union = new Set((approval?.accepted || []).map(e => e.token));
  const paths = [
    ...new Set([...(base.extraFiles || []), ...extraFiles].map(file => path.join(repo, file))),
    ...listMd(memoryDir).map(file => path.join(memoryDir, file)),
    ...walkMd(repoPath(repo, config.brain?.dir ?? 'brain', config.brain?.dir === undefined ? 'brain' : 'brain.dir')).map(file => path.join(repo, config.brain?.dir ?? 'brain', file)),
    ...walkMd(path.join(repo, 'docs/shelf')).map(file => path.join(repo, 'docs/shelf', file)),
    ...listMd(path.join(repo, 'docs')).filter(file => /^ROADMAP.*\.md$/.test(file)).map(file => path.join(repo, 'docs', file)),
  ];
  for (const file of paths) for (const token of distinctiveTokens(read(file))) union.add(token);
  const missing = [...new Set(base.union)].filter(token => !union.has(token)).sort();
  const missingSet = new Set(missing), byFile = {};
  for (const [file, info] of Object.entries(base.files)) {
    const lost = info.tokens.filter(token => missingSet.has(token));
    if (lost.length) byFile[file] = lost;
  }
  return { missing, count: missing.length, byFile };
}

const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
// Shared fence-aware splitter. Raw slices preserve every byte; block proofs
// retain their established normalization separately below.
export function splitSections(text, isHeading = line => line.startsWith('## ')) {
  const blocks = [];
  let start = 0, offset = 0, lineNumber = 1, startLine = 1;
  let heading = text.split('\n', 1)[0], kind = 'preamble', fence = null;
  const push = end => { if (end !== start) blocks.push({ text: text.slice(start, end), heading, kind, line: startLine }); };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const content = line.replace(/\r?\n$|\r$/, '');
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(content);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
    } else {
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
      if (open && (open[1][0] !== '`' || !open[2].includes('`'))) fence = open[1];
      else if (isHeading(content)) { push(offset); start = offset; startLine = lineNumber; heading = content; kind = 'section'; }
    }
    offset += line.length;
    lineNumber++;
  }
  push(text.length);
  return blocks;
}
function splitBlocks(text, source) {
  text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  return splitSections(text).map(({ text, kind, heading }, index) => {
    const body = text.replace(/(?:\n[ \t]*)+$/, '') + '\n';
    return { source, index, kind, heading: heading.slice(0, 200), headingSha256: hash(heading), bytes: utf8Bytes(body), sha256: hash(body) };
  });
}
function collectBlocks(repo, paths, flag) {
  if (!Array.isArray(paths) || !paths.length) throw new Error(`requires --${flag} PATH`);
  const seen = new Set(), blocks = [];
  for (const file of paths) {
    const absolute = path.resolve(repo, file), key = pathKey(absolute);
    if (seen.has(key)) continue;
    seen.add(key);
    const source = path.relative(repo, absolute).replace(/\\/g, '/');
    const found = splitBlocks(readRequired(absolute), source);
    if (flag === 'source' && !found.length) throw new Error(`source ${source} has zero blocks`);
    blocks.push(...found);
  }
  return blocks;
}
export function blocksSnapshot({ repo = repoRoot(), sources }) {
  return { takenAt: new Date().toISOString(), blocks: collectBlocks(repo, sources, 'source') };
}
const groupBy = (items, key) => {
  const groups = new Map();
  for (const item of items) {
    const value = key(item);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(item);
  }
  return groups;
};
function orderedAttribution(blocks, destinations, baseHashes, byHash) {
  // Only ambiguous multi-source matches need this search. A destination copy may
  // belong to either source, but each baseline occurrence can be consumed once.
  const candidates = groupBy(blocks.map((b, id) => ({ ...b, id })), b => b.sha256);
  const sequence = destinations.filter(d => baseHashes.has(d.sha256) &&
    byHash.get(d.sha256).length <= baseHashes.get(d.sha256).length);
  const used = new Set(), last = new Map(), failed = new Set();
  // A bounded proof may clear a false inversion; an exhausted proof must never
  // clear it. Count candidate attempts, not just memo states, and cap recursion.
  let steps = 0, exhausted = false;
  const visit = pos => {
    if (pos === sequence.length) return true;
    if (pos >= 512 || exhausted) return false;
    const state = `${pos}|${[...used].sort((a, b) => a - b).join(',')}|${JSON.stringify([...last])}`;
    if (failed.has(state)) return false;
    const d = sequence[pos];
    for (const b of candidates.get(d.sha256)) {
      if (++steps > 10000) { exhausted = true; return false; }
      const key = `${d.source}\0${b.source}`, previous = last.get(key);
      if (used.has(b.id) || b.index <= (previous ?? -1)) continue;
      used.add(b.id); last.set(key, b.index);
      if (visit(pos + 1)) return true;
      used.delete(b.id);
      if (previous === undefined) last.delete(key); else last.set(key, previous);
      if (exhausted) return false;
    }
    failed.add(state);
    return false;
  };
  return visit(0);
}
export function blocksVerify({ repo = repoRoot(), baseline, dests, accepted }) {
  const base = typeof baseline === 'string' ? JSON.parse(readRequired(baseline)) : baseline;
  if (!base || !Array.isArray(base.blocks) || base.blocks.some(b =>
    typeof b.source !== 'string' || typeof b.heading !== 'string' || !Number.isInteger(b.index) || b.index < 0 ||
    !Number.isInteger(b.bytes) || b.bytes < 0 || !/^[a-f0-9]{64}$/.test(b.sha256))) throw new Error('Invalid block baseline');
  const approval = typeof accepted === 'string' ? JSON.parse(readRequired(accepted)) : accepted;
  if (accepted !== undefined && (!approval || !Array.isArray(approval.accepted) || approval.accepted.some(e =>
    !e || typeof e.source !== 'string' || !e.source.trim() || typeof e.heading !== 'string' ||
    typeof e.reason !== 'string' || !e.reason.trim()))) throw new Error('Accepted blocks require source, heading and reason');
  const decisions = new Map(), unusedAccepted = [];
  for (const entry of approval?.accepted || []) {
    if (entry.index !== undefined && (!Number.isInteger(entry.index) || entry.index < 0))
      throw new Error('Accepted block index must be a nonnegative integer');
    const matches = base.blocks.filter(b => b.source === entry.source && b.heading === entry.heading);
    if (matches.length > 1 && entry.index === undefined)
      throw new Error(`ambiguous accepted entry ${entry.source} ${entry.heading}; provide index`);
    const selected = matches.filter(b => entry.index === undefined || entry.index === b.index);
    if (!selected.length) unusedAccepted.push(entry);
    for (const b of selected) if (!decisions.has(b)) decisions.set(b, entry);
  }
  const destinations = collectBlocks(repo, dests, 'dest');
  const byHash = groupBy(destinations, b => b.sha256), baseHashes = groupBy(base.blocks, b => b.sha256);
  const byHeading = groupBy(destinations, b => b.headingSha256);
  const used = new Map();
  const blocks = base.blocks.map(b => {
    const matches = byHash.get(b.sha256) || [], expected = baseHashes.get(b.sha256).length;
    const occurrence = used.get(b.sha256) || 0; used.set(b.sha256, occurrence + 1);
    const altered = (byHeading.get(b.headingSha256 || hash(b.heading)) || []).filter(d => !baseHashes.has(d.sha256));
    const status = matches.length > expected ? 'duplicated' : occurrence < matches.length ? 'ok' : altered.length ? 'altered' : 'missing';
    return { ...b, status, expected, actual: matches.length, destinations: status === 'altered' ? altered : matches, findings: status === 'ok' ? [] : [status] };
  });
  // Each destination must be an order-preserving subsequence of each source.
  // Prefer the earliest identical occurrence after previous, so repeated blocks are not false inversions.
  for (const source of groupBy(blocks, b => b.source).values()) {
    const candidates = groupBy(source.sort((a, b) => a.index - b.index), b => b.sha256);
    for (const dest of groupBy(destinations, b => b.source).values()) {
      let previous = -1;
      for (const d of dest) {
        const choices = candidates.get(d.sha256);
        if (!choices) continue;
        const next = choices.find(b => b.index > previous);
        if (next) { previous = next.index; continue; }
        // Extra copies already fail multiplicity; do not call them ordering failures too.
        if ((byHash.get(d.sha256)?.length || 0) > baseHashes.get(d.sha256).length) continue;
        for (const b of choices) {
          if (!b.findings.includes('out-of-order')) b.findings.push('out-of-order');
          if (b.status === 'ok') b.status = 'out-of-order';
        }
      }
    }
  }
  const ambiguous = [...baseHashes.values()].some(items => new Set(items.map(b => b.source)).size > 1);
  if (ambiguous && blocks.some(b => b.findings.includes('out-of-order')) &&
    orderedAttribution(blocks, destinations, baseHashes, byHash)) {
    for (const b of blocks) {
      b.findings = b.findings.filter(f => f !== 'out-of-order');
      if (b.status === 'out-of-order') b.status = 'ok';
    }
  }
  for (const [i, b] of blocks.entries()) {
    const decision = decisions.get(base.blocks[i]);
    if (decision && b.findings.length) { b.status = 'accepted'; b.reason = decision.reason; }
  }
  const summary = Object.fromEntries(['ok', 'missing', 'altered', 'duplicated', 'out-of-order', 'accepted'].map(status =>
    [status, blocks.filter(b => b.status === status).length]));
  return { blocks, summary, unusedAccepted, count: blocks.filter(b => !['ok', 'accepted'].includes(b.status)).length };
}
export function main(argv = process.argv.slice(2)) {
  try {
    const opts = args(argv);
    if (opts.help) { console.log('Usage: memory-conserve.mjs snapshot --out FILE | verify --baseline FILE | blocks-snapshot --out FILE --source PATH [--source PATH ...] | blocks-verify --baseline FILE --dest PATH [--dest PATH ...] [--accepted FILE] [--json] [--memory-dir PATH] [--repo PATH]'); return 0; }
    // Block mode does not need or discover a private memory directory.
    if (opts._[0] === 'blocks-snapshot' || opts._[0] === 'blocks-verify') {
      const repo = path.resolve(opts.repo || repoRoot());
      if (opts._[0] === 'blocks-snapshot') {
        if (!opts.out) throw new Error('blocks-snapshot requires --out FILE');
        fs.writeFileSync(opts.out, JSON.stringify(blocksSnapshot({ repo, sources: opts.source }), null, 2) + '\n');
        console.log(`blocks-snapshot: ${opts.out}`); return 0;
      }
      if (!opts.baseline) throw new Error('blocks-verify requires --baseline FILE');
      const result = blocksVerify({ repo, baseline: opts.baseline, dests: opts.dest, accepted: opts.accepted });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else {
        for (const [status, count] of Object.entries(result.summary)) console.log(`${status}: ${count} blocks`);
        const nonOk = result.blocks.filter(b => b.status !== 'ok');
        for (const b of nonOk.slice(0, 50)) {
          const where = b.status === 'altered' ? ` -> ${b.destinations.map(d => `${d.source}#${d.index}`).join(', ')}` : '';
          console.log(`${b.status} ${b.source}#${b.index} ${b.heading}${where}`);
        }
        if (nonOk.length > 50) console.log(`… ${nonOk.length - 50} more (use --json)`);
        for (const e of result.unusedAccepted) console.log(`unused accepted entry ${e.source}${e.index === undefined ? '' : `#${e.index}`} ${e.heading}`);
      }
      return result.count ? 1 : 0;
    }
    const loc = locations(opts);
    if (opts._[0] === 'snapshot') {
      if (!opts.out) throw new Error('snapshot requires --out FILE');
      fs.writeFileSync(opts.out, JSON.stringify(snapshot({ ...loc, extraFiles: opts.file }), null, 2) + '\n');
      console.log(`snapshot: ${opts.out}`);
      return 0;
    }
    if (opts._[0] !== 'verify' || !opts.baseline) throw new Error('verify requires --baseline FILE');
    const result = verify({ ...loc, baseline: opts.baseline, accepted: opts.accepted, extraFiles: opts.file });
    console.log(`missing: ${result.count} tokens`);
    for (const [file, tokens] of Object.entries(result.byFile)) {
      console.log(`${file}:`);
      for (const token of tokens) console.log(`  ${token}`);
    }
    return result.count ? 1 : 0;
  } catch (error) { console.error(`memory-conserve: ${error.message}`); return 1; }
}
if (isDirect(import.meta.url)) process.exitCode = main();
