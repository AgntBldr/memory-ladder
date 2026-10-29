import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeEol, matchEol, args, isDirect, loadConfig, repoRoot, readRequired, utf8Bytes, locations, read, roadmapOrder } from './lib.mjs';
import {withMemoryLock} from './memory-lock.mjs';
import { splitSections } from './memory-conserve.mjs';

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function rotateLog(options = {}) {
  return options.write ? withMemoryLock(options.memoryDir ?? options.repo ?? repoRoot(), () => rotateLogUnlocked(options), {lock: options.lock}) : rotateLogUnlocked(options);
}
function rotateLogUnlocked({ repo = repoRoot(), config = loadConfig(), keep = config.caps.brainLog.keepEntries, write = false } = {}) {
  if (typeof keep === 'string' && !/^\d+$/.test(keep)) throw new Error('--keep must be a nonnegative integer');
  keep = Number(keep);
  if (!Number.isSafeInteger(keep) || keep < 0) throw new Error('--keep must be a nonnegative integer');
  const file = path.join(repo, config.caps.brainLog.path), text = readRequired(file);
  const parts = splitSections(text, line => /^## \[/.test(line));
  const entries = parts.filter(p => p.kind === 'section');
  for (const entry of entries) {
    const date = /^## \[(\d{4}-\d{2}-\d{2})\]/.exec(entry.heading)?.[1];
    if (!validDate(date)) throw new Error(`invalid log date at line ${entry.line}: ${entry.heading}`);
    entry.month = date.slice(0, 7);
  }
  const moved = entries.slice(0, Math.max(0, entries.length - keep));
  const kept = entries.slice(moved.length), groups = new Map();
  for (const entry of moved) {
    if (!groups.has(entry.month)) groups.set(entry.month, []);
    groups.get(entry.month).push(entry.text);
  }
  const destinations = [...groups].map(([month, texts]) => ({
    file: path.posix.join(path.posix.dirname(config.caps.brainLog.path), `log-${month}.md`),
    entries: texts.length, bytes: utf8Bytes(texts.join('')),
  }));
  if (write && moved.length) {
    for (const [i, [month, texts]] of [...groups].entries()) {
      const dest = path.join(repo, destinations[i].file);
      let current = fs.existsSync(dest) ? readRequired(dest) : `# Operation log — ${month}\n\nRotated from log.md by scripts/memory/memory-rotate.mjs; append-only; the newest entries are in log.md.\n\n`;
      if (!fs.existsSync(dest)) { current = matchEol(current, text); fs.writeFileSync(dest, current, 'utf8'); }
      // An interrupted run may have appended several entries before replacing log.md.
      let prefix = '', completed = 0;
      for (const [index, text] of texts.entries()) {
        prefix += text;
        if (normalizeEol(current).endsWith(normalizeEol(prefix))) completed = index + 1;
      }
      for (const text of texts.slice(completed)) {
        if (normalizeEol(current).endsWith(normalizeEol(text))) continue;
        const append = matchEol((current.endsWith('\n') ? '' : '\n') + text, current);
        fs.appendFileSync(dest, append, 'utf8');
        current += append;
      }
    }
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, parts.filter(p => p.kind === 'preamble').map(p => p.text).join('') + kept.map(p => p.text).join(''), { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temp, file);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  return { moved: moved.length, kept: kept.length, destinations };
}
export function rotateRoadmap(options = {}) {
  roadmapOrder(options.config ?? loadConfig());
  return options.write ? withMemoryLock(options.memoryDir ?? options.repo ?? repoRoot(), () => rotateRoadmapUnlocked(options), {lock: options.lock}) : rotateRoadmapUnlocked(options);
}
function rotateRoadmapUnlocked({repo = repoRoot(), config = loadConfig(), write = false, today = new Date().toISOString().slice(0, 10)} = {}) {
  if (!validDate(today)) throw new Error('invalid roadmap rotation date');
  const file = path.join(repo, config.caps.roadmap.path), text = readRequired(file);
  const section = /^## Open work\b[^\r\n]*\r?\n/m.exec(text);
  const empty = {moved: 0, kept: 0, bytesRemoved: 0, bytesAdded: 0, found: true};
  if (!section) return empty;
  const start = section.index + section[0].length;
  const endMatch = /^#{1,3} /m.exec(text.slice(start));
  const end = endMatch ? start + endMatch.index : text.length;
  const body = text.slice(start, end), starts = [...body.matchAll(/^\*\*(\d{4}-\d{2}-\d{2})[^\r\n]*(?:\r?\n|$)/gm)];
  const blocks = starts.map((match, i) => ({date: match[1], start: start + match.index,
    end: start + (starts[i + 1]?.index ?? body.length), text: body.slice(match.index, starts[i + 1]?.index ?? body.length)}));
  for (const block of blocks) if (!validDate(block.date)) throw new Error('invalid roadmap block date: ' + block.date);
  const newestFirst = roadmapOrder(config) === 'newest-first';
  const oldest = [...blocks].sort((a, b) => a.date.localeCompare(b.date) || (newestFirst ? b.start - a.start : a.start - b.start));
  const keep = config.caps.roadmap.keepBlocks ?? 6;
  if (!Number.isInteger(keep) || keep < 2) throw new Error('roadmap.keepBlocks must be at least 2');
  const moved = oldest.slice(0, Math.max(0, oldest.length - keep));
  let bytes = utf8Bytes(text) - moved.reduce((n, b) => n + utf8Bytes(b.text), 0);
  for (const block of oldest.slice(moved.length)) {
    if (bytes <= config.caps.roadmap.warnBytes || blocks.length - moved.length <= 2) break;
    moved.push(block); bytes -= utf8Bytes(block.text);
  }
  if (!moved.length) return {...empty, kept: blocks.length};
  const payload = [...moved].sort((a, b) => a.start - b.start).map(b => b.text).join(''), historyFile = path.join(repo, config.caps.roadmapHistory.path);
  const history = read(historyFile), eol = (history || text).includes('\r\n') ? '\r\n' : '\n', heading = `## Open work — dated blocks moved ${today}${eol}${eol}`;
  const first = [...history.matchAll(/^## (?!Open work)[^\r\n]*/gm)][0]?.index ?? history.length;
  const nextHistory = history.slice(0, first) + (first && !history.slice(0, first).endsWith('\n') ? eol : '') + heading + payload + (first < history.length && !payload.endsWith('\n') ? eol : '') + history.slice(first);
  let next = text;
  for (const block of [...moved].sort((a, b) => b.start - a.start)) next = next.slice(0, block.start) + next.slice(block.end);
  const result = {moved: moved.length, kept: blocks.length - moved.length, bytesRemoved: utf8Bytes(text) - utf8Bytes(next), bytesAdded: utf8Bytes(payload), found: moved.every(b => normalizeEol(nextHistory).includes(normalizeEol(b.text)))};
  if (!result.found || result.bytesRemoved !== result.bytesAdded) throw new Error('roadmap conservation failed');
  if (write) {
    fs.mkdirSync(path.dirname(historyFile), {recursive: true});
    fs.writeFileSync(historyFile, matchEol(nextHistory, history || text));
    fs.writeFileSync(file, next);
  }
  return result;
}
export function main(argv = process.argv.slice(2)) {
  try {
    const opts = args(argv.filter(arg => arg !== '--write'));
    if (opts.help) { console.log('Usage: memory-rotate.mjs log [--repo PATH] [--keep N] [--write] [--json]'); return 0; }
    if (!['log', 'roadmap'].includes(opts._[0])) throw new Error('expected log or roadmap');
    const loc = locations(opts);
    const config = loadConfig(), input = opts._[0] === 'log' ? config.caps.brainLog.path : config.caps.roadmap.path;
    if (!fs.existsSync(path.join(loc.repo, input))) { console.log('nothing to rotate: no existing input'); return 0; }
    const result = (opts._[0] === 'log' ? rotateLog : rotateRoadmap)({...loc, memoryDir: loc.memoryDir ?? loc.repo, keep: opts.keep, write: argv.includes('--write'), today: opts.today});
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else if (!result.moved) console.log('nothing to rotate');
    else { for (const d of result.destinations ?? []) console.log(`${d.file}: ${d.entries} entries, ${d.bytes} bytes`); console.log(`kept: ${result.kept} entries`); if (result.bytesRemoved !== undefined) console.log(`proof: ${result.bytesRemoved} bytes removed = ${result.bytesAdded} bytes added; every moved block found: ${result.found}`); }
    return 0;
  } catch (error) { console.error(`memory-rotate: ${error.message}`); return 1; }
}
if (isDirect(import.meta.url)) process.exitCode = main();
