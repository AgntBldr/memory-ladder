import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { args, isDirect, loadConfig, repoRoot, readRequired, utf8Bytes } from './lib.mjs';
import { splitSections } from './memory-conserve.mjs';

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function rotateLog({ repo = repoRoot(), config = loadConfig(), keep = config.caps.brainLog.keepEntries, write = false } = {}) {
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
      if (!fs.existsSync(dest)) fs.writeFileSync(dest, current, 'utf8');
      // An interrupted run may have appended several entries before replacing log.md.
      let prefix = '', completed = 0;
      for (const [index, text] of texts.entries()) {
        prefix += text;
        if (current.endsWith(prefix)) completed = index + 1;
      }
      for (const text of texts.slice(completed)) {
        if (current.endsWith(text)) continue;
        const append = (current.endsWith('\n') ? '' : '\n') + text;
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
export function main(argv = process.argv.slice(2)) {
  try {
    const opts = args(argv.filter(arg => arg !== '--write'));
    if (opts.help) { console.log('Usage: memory-rotate.mjs log [--repo PATH] [--keep N] [--write] [--json]'); return 0; }
    if (opts._[0] !== 'log') throw new Error('expected log');
    const result = rotateLog({ repo: path.resolve(opts.repo || repoRoot()), keep: opts.keep, write: argv.includes('--write') });
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else if (!result.moved) console.log('nothing to rotate');
    else { for (const d of result.destinations) console.log(`${d.file}: ${d.entries} entries, ${d.bytes} bytes`); console.log(`kept: ${result.kept} entries`); }
    return 0;
  } catch (error) { console.error(`memory-rotate: ${error.message}`); return 1; }
}
if (isDirect(import.meta.url)) process.exitCode = main();
