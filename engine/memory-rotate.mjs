import {atomicWrite, repoPath, validateConfigPaths, handoverFiles} from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeEol, matchEol, args, isDirect, loadConfig, repoRoot, readRequired, utf8Bytes, locations, read, roadmapOrder, cleanGitEnv, regularFileOrAbsent } from './lib.mjs';
import {withMemoryLock} from './memory-lock.mjs';
import {refuseWhilePending} from './memory-session.mjs';
import { splitSections } from './memory-conserve.mjs';

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function rotateLog(options = {}) {
  validateConfigPaths(options.repo ?? repoRoot(), options.config ?? loadConfig());
  if (options.write) rotateLogUnlocked({...options, write: false});
  return options.write ? withMemoryLock(options.memoryDir ?? options.repo ?? repoRoot(), () => rotateLogUnlocked(options), {lock: options.lock}) : rotateLogUnlocked(options);
}
function rotateLogUnlocked({ repo = repoRoot(), config = loadConfig(), keep = config.caps.brainLog.keepEntries, write = false } = {}) {
  if (typeof keep === 'string' && !/^\d+$/.test(keep)) throw new Error('--keep must be a nonnegative integer');
  keep = Number(keep);
  if (!Number.isSafeInteger(keep) || keep < 0) throw new Error('--keep must be a nonnegative integer');
  const file = repoPath(repo, config.caps.brainLog.path, 'caps.brainLog.path'), text = readRequired(file);
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
  for (const destination of destinations) repoPath(repo, destination.file, 'caps.brainLog.path');
  if (write && moved.length) {
    for (const [i, [month, texts]] of [...groups].entries()) {
      const dest = repoPath(repo, destinations[i].file, 'caps.brainLog.path');
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
    atomicWrite(file, parts.filter(p => p.kind === 'preamble').map(p => p.text).join('') + kept.map(p => p.text).join(''), {encoding: 'utf8'});
  }
  return { moved: moved.length, kept: kept.length, destinations };
}
export function rotateRoadmap(options = {}) {
  validateConfigPaths(options.repo ?? repoRoot(), options.config ?? loadConfig());
  roadmapOrder(options.config ?? loadConfig());
  return options.write ? withMemoryLock(options.memoryDir ?? options.repo ?? repoRoot(), () => rotateRoadmapUnlocked(options), {lock: options.lock}) : rotateRoadmapUnlocked(options);
}
function rotateRoadmapUnlocked({repo = repoRoot(), config = loadConfig(), write = false, today = new Date().toISOString().slice(0, 10)} = {}) {
  if (!validDate(today)) throw new Error('invalid roadmap rotation date');
  const file = repoPath(repo, config.caps.roadmap.path, 'caps.roadmap.path'), text = readRequired(file);
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
  const payload = [...moved].sort((a, b) => a.start - b.start).map(b => b.text).join(''), historyFile = repoPath(repo, config.caps.roadmapHistory.path, 'caps.roadmapHistory.path');
  regularFileOrAbsent(historyFile, 'roadmap history');
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
export function rotateHandovers(options = {}) {
  // Kit 3.3.5 E2.4/E6: moving hand-over notes is coordinated maintenance; it refuses while another live session holds
  // unresolved claims (the all-sessions checkpoint reports "rotation waits" before it gets here). Review P1-3: the check
  // runs inside the same lock acquisition that covers the moves, so no claim can land between the check and the writes.
  if (!options.write || options.dryRun) return rotateHandoversUnlocked(options);
  if (!options.lock) options.beforeLock?.();
  return withMemoryLock(options.memoryDir, () => {
    refuseWhilePending({memoryDir: options.memoryDir, repo: options.repo, label: 'rotate handovers'});
    return rotateHandoversUnlocked(options);
  }, {lock: options.lock});
}
function rotateHandoversUnlocked({memoryDir, config = loadConfig(), keep = config.caps.handovers?.keepNotes ?? 20, write = false, dryRun = false} = {}) {
  if (typeof keep === 'string' && !/^\d+$/.test(keep)) throw new Error('--keep must be a nonnegative integer');
  keep = Number(keep);
  if (!Number.isSafeInteger(keep) || keep < 0) throw new Error('--keep must be a nonnegative integer');
  const files = handoverFiles(memoryDir);
  if (files.some(f => f.error)) throw new Error('cannot read handovers for rotation');
  const notes = files.filter(f => f.kind === 'note').sort((a, b) => b.file.localeCompare(a.file));
  const moved = notes.slice(Math.max(1, keep)).filter(f => f.valid), destinations = [];
  const contains = (archive, name, raw) => {
    const marker = Buffer.from(`## ${name}\n`), at = archive.indexOf(marker);
    if (at < 0) return false;
    const expected = Buffer.concat([marker, raw, Buffer.from('\n\n')]);
    const end = at + expected.length;
    if ((at && archive[at - 1] !== 10) || archive.indexOf(marker, at + marker.length) >= 0 || !archive.subarray(at, end).equals(expected) || (end < archive.length && archive.subarray(end, end + 3).toString() !== '## ')) throw new Error('handover archive differs from loose note: ' + name);
    return true;
  };
  for (const note of [...moved].sort((a, b) => a.file.localeCompare(b.file))) {
    const name = path.basename(note.file), relative = `handovers/archive-${note.data.time.slice(0, 7)}.md`, dest = path.join(memoryDir, relative);
    let current = Buffer.alloc(0);
    if (fs.existsSync(dest)) {
      if (!fs.lstatSync(dest).isFile()) throw new Error('handover archive is not a regular file');
      current = fs.readFileSync(dest);
    }
    const found = contains(current, name, note.raw);
    if (write && !dryRun) {
      if (!found) {
        const next = Buffer.concat([current, Buffer.from(current.length && current.at(-1) !== 10 ? '\n' : ''), Buffer.from(`## ${name}\n`), note.raw, Buffer.from('\n\n')]);
        atomicWrite(dest, next);
      }
      if (!contains(fs.readFileSync(dest), name, note.raw)) throw new Error('handover archive verification failed');
      const source = path.join(memoryDir, note.file);
      if (!fs.readFileSync(source).equals(note.raw)) throw new Error('handover changed during rotation');
      fs.unlinkSync(source);
    }
    const destination = destinations.find(d => d.file === relative);
    if (destination) { destination.entries++; destination.bytes += note.bytes; }
    else destinations.push({file: relative, entries: 1, bytes: note.bytes});
  }
  return {moved: moved.length, kept: notes.length - moved.length, destinations};
}
export function main(argv = process.argv.slice(2)) {
  try {
    const opts = args(argv.filter(arg => arg !== '--write'));
    if (opts.help) { console.log('Usage: memory-rotate.mjs log|roadmap|handovers [--repo PATH] [--memory-dir PATH] [--keep N] [--write] [--dry-run] [--json]'); return 0; }
    if (!['log', 'roadmap', 'handovers'].includes(opts._[0])) throw new Error('expected log, roadmap or handovers');
    const loc = locations(opts, {env: cleanGitEnv()});
    const config = loadConfig(), input = opts._[0] === 'log' ? config.caps.brainLog.path : config.caps.roadmap.path;
    validateConfigPaths(loc.repo, config);
    if (opts._[0] !== 'handovers' && !fs.existsSync(path.join(loc.repo, input))) { console.log('nothing to rotate: no existing input'); return 0; }
    const result = ({log: rotateLog, roadmap: rotateRoadmap, handovers: rotateHandovers}[opts._[0]])({...loc, memoryDir: loc.memoryDir ?? loc.repo, keep: opts.keep, write: argv.includes('--write') && !opts['dry-run'], today: opts.today});
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else if (!result.moved) console.log('nothing to rotate');
    else { for (const d of result.destinations ?? []) console.log(`${d.file}: ${d.entries} entries, ${d.bytes} bytes`); console.log(`kept: ${result.kept} entries`); if (result.bytesRemoved !== undefined) console.log(`proof: ${result.bytesRemoved} bytes removed = ${result.bytesAdded} bytes added; every moved block found: ${result.found}`); }
    return 0;
  } catch (error) { console.error(`memory-rotate: ${error.message}`); return 1; }
}
if (isDirect(import.meta.url)) process.exitCode = main();
