import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const toolDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = () => path.resolve(toolDir, '../..');
export const normalizeEol = text => String(text).replace(/\r\n/g, '\n');
export const matchEol = (text, original) => {
  const prior = String(original).match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const crlf = prior.filter(line => line.endsWith('\r\n')).length;
  const lf = prior.filter(line => line.endsWith('\n')).length - crlf;
  const eol = crlf > lf ? '\r\n' : '\n';
  const next = normalizeEol(text).match(/[^\n]*\n|[^\n]+$/g) ?? [];
  // Preserve common edges, then find the longest ordered set of unchanged lines.
  // Matching greedily can mistake an inserted duplicate for a later original line.
  const kept = new Map();
  let start = 0, endOld = prior.length, endNew = next.length;
  while (start < endOld && start < endNew && normalizeEol(prior[start]) === next[start]) { kept.set(start, prior[start]); start++; }
  while (endOld > start && endNew > start && normalizeEol(prior[endOld - 1]) === next[endNew - 1]) { kept.set(--endNew, prior[--endOld]); }
  const positions = new Map();
  for (let i = start; i < endOld; i++) { const key = normalizeEol(prior[i]); if (!positions.has(key)) positions.set(key, []); positions.get(key).push(i); }
  const tails = [], chains = [];
  for (let i = start; i < endNew; i++) {
    const candidates = positions.get(next[i]) ?? [];
    for (let j = candidates.length - 1; j >= 0; j--) {
      const at = candidates[j]; let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (tails[mid] < at) lo = mid + 1; else hi = mid; }
      if (tails[lo] === at) continue;
      chains[lo] = {old:at, next:i, previous:lo ? chains[lo - 1] : null}; tails[lo] = at;
    }
  }
  for (let link = chains.at(-1); link; link = link.previous) kept.set(link.next, prior[link.old]);
  return next.map((line, i) => kept.get(i) ?? line.replace(/\n$/, eol)).join('');
};
export function writeText(file, text) { fs.writeFileSync(file, matchEol(text, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : text)); }
export const utf8Bytes = s => Buffer.byteLength(s, 'utf8');
export const slash = s => s.replace(/\\/g, '/');
export function read(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return '';
    throw error;
  }
}
export function readRequired(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
  catch { throw new Error(`cannot read ${file}`); }
}
export const loadConfig = () => JSON.parse(read(path.join(toolDir, 'memory.config.json')));
export const pathSpelling = value => process.platform === 'win32' ? slash(value).toLowerCase() : value;
export const pathKey = (...parts) => pathSpelling(path.resolve(...parts));
export const pathIncludes = (file, pattern) => pathSpelling(file).includes(pathSpelling(pattern));
export function isDirect(url) {
  if (!process.argv[1]) return false;
  try { return pathKey(fs.realpathSync(process.argv[1])) === pathKey(fs.realpathSync(fileURLToPath(url))); }
  catch { return false; }
}
export const memorySlug = repo => repo.replace(/[^A-Za-z0-9]/g, '-');
export function mainWorktree(repo) {
  const git = (...argv) => {
    const r = spawnSync('git', ['--no-optional-locks', '-C', repo, 'rev-parse', ...argv], {encoding:'utf8',timeout:10000,windowsHide:true});
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const common = git('--path-format=absolute', '--git-common-dir'), dir = git('--absolute-git-dir');
  if (!common || !dir || pathKey(common) === pathKey(dir)) return repo;
  // The common directory belongs to the main checkout, including separate-git-dir setups.
  const r = spawnSync('git', ['--no-optional-locks','-C',repo,'worktree','list','--porcelain','-z'], {encoding:'utf8',timeout:10000,windowsHide:true});
  return r.status === 0 && r.stdout.startsWith('worktree ') && !r.stdout.split('\0\0')[0].split('\0').includes('bare') ? r.stdout.slice(9).split('\0')[0] : repo;
}

export function readKitJSON(file) {
  try {
    const value = JSON.parse(readRequired(file));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
    return value;
  } catch (error) { throw new Error(`cannot read ${file}: ${String(error.message).replace(/[\r\n]+/g, ' ')}`); }
}
export function memoryLocation(repo = repoRoot(), requested) {
  if (requested) return { dir: path.resolve(requested), source: '--memory-dir' };
  if (process.env.CLAUDE_MEMORY_DIR) return { dir: path.resolve(process.env.CLAUDE_MEMORY_DIR), source: 'CLAUDE_MEMORY_DIR' };
  const configFile = path.join(repo, 'scripts/memory/memory.config.json');
  if (fs.existsSync(configFile)) {
    const configured = readKitJSON(configFile).memory?.inRepoDir;
    if (configured !== undefined) {
      if (typeof configured !== 'string' || !configured || path.isAbsolute(configured) || path.win32.isAbsolute(configured) || !insideRepo(repo, path.resolve(repo, configured)))
        throw new Error('memory.inRepoDir must name a dedicated folder inside the repo; see CONVERT.md#move-root-memory-into-a-dedicated-folder');
      return {dir: path.resolve(repo, configured), source: 'memory.inRepoDir'};
    }
  }
  repo = mainWorktree(repo);
  const receipt = path.join(repo, 'scripts/memory/KIT.json');
  if (fs.existsSync(receipt)) readKitJSON(receipt);
  const local = path.join(repo, 'scripts/memory/KIT.local.json');
  if (fs.existsSync(local)) {
    const configured = readKitJSON(local).memoryDir;
    if (configured && typeof configured !== 'string') throw new Error(`invalid memoryDir in ${local}`);
    if (configured && fs.existsSync(path.resolve(configured)) && fs.statSync(path.resolve(configured)).isDirectory())
      return { dir: path.resolve(configured), source: 'KIT.local.json' };
  }
  const slug = memorySlug(path.resolve(repo));
  const projects = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.claude/projects');
  const exact = path.join(projects, slug, 'memory');
  if (fs.existsSync(exact)) return { dir: exact, source: 'default' };
  if (!fs.existsSync(projects)) return { dir: null, source: 'default' };
  const match = fs.readdirSync(projects, { withFileTypes: true }).find(e =>
    e.isDirectory() && e.name.toLowerCase() === slug.toLowerCase() &&
    fs.existsSync(path.join(projects, e.name, 'memory')));
  return { dir: match ? path.join(projects, match.name, 'memory') : null, source: 'default' };
}
export const memoryDir = (repo = repoRoot()) => memoryLocation(repo).dir;
export function insideRepo(repo, dir) {
  if (!repo || !dir) return false;
  const rel = path.relative(path.resolve(repo), path.resolve(dir));
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
export const inRepoMemory = (repo, dir) => insideRepo(repo, dir) && !fs.existsSync(path.join(dir, '.git'));

function splitList(text) {
  const parts = [];
  let start = 0, quote = '', escaped = false, depth = 0, itemStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && c === '\\') { escaped = true; continue; }
    if (quote) {
      if (quote === "'" && c === "'" && text[i + 1] === "'") i++;
      else if (c === quote) quote = '';
    }
    else if ((c === '"' || c === "'") && itemStart) { quote = c; itemStart = false; }
    else if (c === '[') { depth++; itemStart = true; }
    else if (c === ']') depth--;
    else if (c === ',') { if (depth === 0) { parts.push(text.slice(start, i)); start = i + 1; } itemStart = true; }
    else if (!/\s/.test(c)) itemStart = false;
  }
  parts.push(text.slice(start));
  return parts;
}

// Return the closing bracket of a complete flow list, ignoring quoted brackets.
function flowEnd(text, state = { depth: 0, quote: '', escaped: false, itemStart: true }) {
  let { depth, quote, escaped, itemStart } = state;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (c === '\\' && quote === '"') escaped = true;
      else if (quote === "'" && c === "'" && text[i + 1] === "'") i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (itemStart && (c === '"' || c === "'")) { quote = c; itemStart = false; }
    else if (c === '[') { depth++; itemStart = true; }
    else if (c === ']') { if (--depth === 0) return i; }
    else if (c === ',') itemStart = true;
    else if (!/\s/.test(c)) itemStart = false;
  }
  Object.assign(state, { depth, quote, escaped, itemStart });
  return -1;
}

function scalar(text) {
  const s = text.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); }
    catch { return s.slice(1, -1).replace(/\\(["\\nt])/g, (_, c) => ({ n: '\n', t: '\t' }[c] ?? c)); }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('[') && flowEnd(s) === s.length - 1) return splitList(s.slice(1, -1)).filter(part => part.trim()).map(scalar);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  return s;
}

export function parseFrontmatter(text) {
  text = text.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0])) return { data: {}, body: text, raw: '' };
  const end = lines.findIndex((line, i) => i > 0 && /^---\s*$/.test(line));
  if (end < 0) return { data: { __error: 'unclosed' }, body: text, raw: '' };
  const warnings = [], data = {};
  const indent = line => /^\s*/.exec(line)[0].length;
  const keyLine = /^([\w.-]+):(?:[ \t]+(.*)|[ \t]*)$/;
  const warn = i => warnings.push({ line: i + 1, text: lines[i] });
  const assign = (obj, key, value, i) => {
    if (['__proto__', 'prototype', 'constructor', '__warnings', '__error'].includes(key) || Object.hasOwn(obj, key)) warn(i);
    else obj[key] = value;
  };
  let i = 1;
  function value(raw, level) {
    const s = (raw ?? '').trim();
    if (/^[>|]-?$/.test(s)) {
      const block = [];
      while (i < end && (!lines[i].trim() || indent(lines[i]) > level)) block.push(lines[i++]);
      const nonempty = block.filter(l => l.trim());
      const margin = nonempty.length ? Math.min(...nonempty.map(indent)) : 0;
      const content = block.map(l => l.slice(margin));
      let result = content.join('\n');
      if (s[0] === '>') result = result.replace(/([^\n])\n(?=[^\n])/g, '$1 ');
      return result.replace(/\n+$/, '') + (s.endsWith('-') ? '' : '\n');
    }
    if (s.startsWith('[')) {
      const state = { depth: 0, quote: '', escaped: false, itemStart: true }, parts = [s];
      let closed = flowEnd(s, state) >= 0;
      while (i < end && !closed) {
        // A new mapping field is not a continuation of a malformed flow value.
        if (keyLine.test(lines[i].trim())) break;
        const part = ' ' + lines[i++].trim();
        parts.push(part); closed = flowEnd(part, state) >= 0;
      }
      return closed ? scalar(parts.join('')) : s;
    }
    if (s) return scalar(s);
    while (i < end && (!lines[i].trim() || /^\s*#/.test(lines[i]))) i++;
    if (i < end && indent(lines[i]) > level && lines[i].trim().startsWith('[')) return value(lines[i++].trim(), level);
    if (i < end && (indent(lines[i]) > level || (indent(lines[i]) === level && /^-\s/.test(lines[i].trim())))) {
      return block(indent(lines[i]), /^-\s/.test(lines[i].trim()));
    }
    return null;
  }
  function block(level, list, obj = list ? [] : {}) {
    while (i < end) {
      const line = lines[i], trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) { i++; continue; }
      const n = indent(line);
      if (n < level || (list && n === level && !/^-\s/.test(trimmed))) break;
      const at = i++;
      if (n !== level) { warn(at); continue; }
      if (list) {
        const item = /^-\s+(.*)$/.exec(trimmed);
        if (!item) { warn(at); continue; }
        const kv = keyLine.exec(item[1]);
        if (kv) {
          const entry = {};
          assign(entry, kv[1], value(kv[2], level + 2), at);
          if (i < end && indent(lines[i]) > level) block(indent(lines[i]), false, entry);
          obj.push(entry);
        } else obj.push(value(item[1], level));
      } else {
        const kv = keyLine.exec(trimmed);
        if (!kv) { warn(at); continue; }
        assign(obj, kv[1], value(kv[2], level), at);
      }
    }
    return obj;
  }
  block(0, false, data);
  if (warnings.length) data.__warnings = warnings;
  return { data, body: lines.slice(end + 1).join('\n'), raw: lines.slice(0, end + 1).join('\n') };
}

export function fmGet(data, key) {
  if (Object.hasOwn(data, key)) return data[key];
  for (const obj of Object.values(data)) {
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && Object.hasOwn(obj, key)) return obj[key];
  }
  return undefined;
}

export function mdLinks(text) {
  return [...text.matchAll(/\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g)]
    .map(m => m[1].replace(/^<|>$/g, '').split('#')[0])
    .filter(s => !/^[a-z][a-z0-9+.-]*:/i.test(s) && /\.md$/i.test(s));
}
export const wikilinks = text => [...text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map(m => m[1].replace(/\\$/, ''));
export function resolveWikilink(name, ...lookups) {
  const stripped = name.split(/[#^]/)[0];
  for (const lookup of lookups) {
    const found = lookup(name) || (stripped && stripped !== name ? lookup(stripped) : undefined);
    if (found) return found;
  }
}
export function memoryNameIndex(files) {
  const names = new Map();
  for (const f of files) {
    const name = fmGet(f.data, 'name'), keys = [f.file, f.file.replace(/\.md$/i, '')];
    if (['string', 'number', 'boolean'].includes(typeof name) && String(name)) keys.push(String(name));
    for (const value of keys) {
      const key = pathSpelling(value);
      if (!names.has(key)) names.set(key, f);
    }
  }
  return names;
}
export const memoryWikilink = (name, names, brainNames) => resolveWikilink(name,
  link => names.get(pathSpelling(link)),
  link => brainNames.has(pathSpelling(link)) ? 'brain' : undefined);
export function roadmapOrder(config) {
  const order = config.caps.roadmap.order === undefined ? 'newest-first' : config.caps.roadmap.order;
  if (!['newest-first', 'oldest-first'].includes(order)) throw new Error('caps.roadmap.order must be newest-first or oldest-first');
  return order;
}
export function listMd(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && /\.md$/i.test(e.name)).map(e => e.name).sort();
}
export function walkMd(dir, { skipDirs = [] } = {}) {
  if (!dir || !fs.existsSync(dir)) return [];
  const result = [], skipped = new Set(skipDirs);
  function walk(rel) {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const next = path.join(rel, e.name);
      if (e.isDirectory() && !skipped.has(e.name)) walk(next);
      else if (e.isFile() && /\.md$/i.test(e.name)) result.push(slash(next));
    }
  }
  walk('');
  return result.sort();
}
export const brainPaths = (repo, config = loadConfig()) => walkMd(path.join(repo, config.brain?.dir ?? 'brain'), {
  skipDirs: ['00-system', '_templates', '.claude', '.agents', '.obsidian'],
}).filter(p => p.includes('/') && !/^(?:readme|_manifest|index)\.md$/i.test(path.basename(p)));
export function brainNamesFromNodes(nodes) {
  return new Set(nodes.flatMap(f => [path.basename(f.file).replace(/\.md$/i, ''), fmGet(f.data, 'id')]).filter(name => typeof name === 'string' && name).map(pathSpelling));
}
export function brainNameSet(repo, config = loadConfig()) {
  return brainNamesFromNodes(brainPaths(repo, config).map(file => ({file, ...parseFrontmatter(read(path.join(repo, config.brain?.dir ?? 'brain', file)))})));
}
export function hardRuleTargets(router) {
  const lines = router.split(/\r?\n/);
  let active = false;
  const result = [];
  for (const line of lines) {
    if (/^##\s/.test(line)) active = /^##\s+Hard rules/i.test(line);
    if (active) result.push(...mdLinks(line));
  }
  return result;
}
export const isIndexPage = file => file.startsWith('INDEX-') && /\.md$/i.test(file);
export function indexFamily(file) {
  const stem = file.slice(6, -3), parts = stem.split('-');
  return parts.length > 1 && /^\d{1,3}$/.test(parts.at(-1)) && !/^\d{4}$/.test(parts.at(-2)) ? parts.slice(0, -1).join('-') : stem;
}
export function memoryFiles(dir) {
  const hard = new Set(hardRuleTargets(read(path.join(dir, 'MEMORY.md'))).map(p => pathKey(dir, p)));
  return listMd(dir).map(file => {
    const text = read(path.join(dir, file)), fm = parseFrontmatter(text);
    const special = /^MEMORY\.md$/i.test(file) ? 'router' : isIndexPage(file) ? 'index' : /^ARCHIVE\.md$/i.test(file) ? 'archive' : null;
    const stub = fmGet(fm.data, 'moved_to') !== undefined;
    const state = fmGet(fm.data, 'state') === true;
    const hardRule = hard.has(pathKey(dir, file));
    return { file, text, ...fm, bytes: utf8Bytes(text), special, stub, state, hardRule,
      topic: !special && !stub && !state && !hardRule };
  });
}

export function lessonCases() {
  const installed = path.basename(toolDir) === 'memory';
  const file = path.join(toolDir, installed ? 'LESSON-KINDS.md' : '../docs/LESSON-KINDS.md');
  const text = read(file), ids = new Set(), superseded = new Map();
  let current;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^#{2,3} (K[1-9]\d*)(?::|\s|$)/.exec(line);
    if (/^#{1,6}(?:\s|$)/.test(line)) current = undefined;
    if (heading) { current = heading[1]; ids.add(current); }
    const prior = /^supersedes: (K[1-9]\d*(?:(?:,\s*|\s+)K[1-9]\d*)*)\s*$/.exec(line);
    if (prior && current) for (const id of prior[1].split(/[,\s]+/)) superseded.set(id, current);
  }
  return {missing: !fs.existsSync(file), ids, superseded};
}
export function validateKindCase(id) {
  if (id === undefined) return;
  const book = lessonCases();
  if (book.missing) throw Error('LESSON-KINDS.md is missing; cannot validate kind case ' + String(id));
  if (!book.ids.has(id)) throw Error('unknown kind case ' + String(id) + '; see LESSON-KINDS.md');
}

export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  const values = new Set(['memory-dir', 'repo', 'scope', 'k', 'write', 'out', 'baseline', 'accepted', 'write-allowlist', 'config', 'today', 'keep', 'route', 'takeaway', 'kind', 'trigger', 'tool', 'case', 'score', 'reference']);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { out._.push(argv[i]); continue; }
    if (argv[i].includes('=')) throw new Error(argv[i] + ' is not supported; use ' + argv[i].replace('=', ' '));
    const key = argv[i].slice(2);
    if (key === 'source' || key === 'dest' || key === 'file') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing --${key} value`);
      (out[key] ??= []).push(argv[++i]);
    } else if (values.has(key)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing --${key} value`);
      if (['kind', 'takeaway', 'trigger', 'case', 'score', 'reference'].includes(key) && Object.hasOwn(out, key)) throw new Error('--' + key + ' given twice');
      const value = argv[++i];
      out[key] = key === 'route' && Object.hasOwn(out, key) ? out[key] + ',' + value : value;
    } else if (key === 'probe') out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else out[key] = true;
  }
  return out;
}
export function locations(opts) {
  const repo = path.resolve(opts.repo || repoRoot());
  const memory = memoryLocation(repo, opts['memory-dir']);
  return { repo, memoryDir: memory.dir, memorySource: memory.source };
}
export function requireMemory(dir) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('memory dir not found');
}

export const secretSources = {
  anthropic: /sk-\x61nt-[A-Za-z0-9_-]{20,}/,
  openai: /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{32,}/,
  aws: /AK\x49A[0-9A-Z]{16}/,
  github: /gh[pousr]_[A-Za-z0-9]{36,}/,
  slack: /xox[baprs]-[A-Za-z0-9-]{10,}/,
  'private-key': /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  google: /AI\x7aa[0-9A-Za-z_-]{35}/,
  jwt: /ey\x4a[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
  resend: /r\x65_[A-Za-z0-9]{20,}/,
  stripe: /(?:sk|rk)_live_[A-Za-z0-9]{20,}/,
  'github-pat': /github_\x70at_[A-Za-z0-9_]{40,}/,
  supabase: /sb\x70_[a-f0-9]{40}/,
  webhook: /wh\x73ec_[A-Za-z0-9]{20,}/,
};
const secrets = secretSources;
const redactions = Object.entries(secrets).map(([name, pattern]) => [name, new RegExp(pattern.source, 'g')]);
export function redact(text) {
  text = String(text);
  for (const [name, pattern] of redactions) text = text.replace(pattern, `[REDACTED:${name}]`);
  return text;
}
