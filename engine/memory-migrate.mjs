import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, fmGet, isDirect, requireMemory, utf8Bytes, locations } from './lib.mjs';
import { redact } from './memory-check.mjs';

const sourceDefault = 'lessons.md';
export const activities = ['verification', 'shipping', 'orchestration', 'specs', 'sessions'];
export function rawBody(text) {
  return text.replace(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}
const clean = s => s.replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim();
export const summary = (s, max = 200) => {
  s = clean(s);
  return s.length <= max ? s : s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
};
const slug = s => (clean(s).toLowerCase().match(/[a-z0-9]+/g) || ['preamble']).slice(0, 6).join('-');
const numberKey = s => s.replace(/^0+(?=\d)/, '');
const marker = /^(?:\*\*#?|#{2,6}[ \t]+#?)(\d{1,3}[a-z]?)(?=\.(?:\s|$)|\s|[—–-])(?:[ \t]*\([^\r\n]*?\))?[.]?[ \t]*(?:[—–-][ \t]*)?/;

export function splitLessons(text) {
  const body = rawBody(text), lines = [...body.matchAll(/[^\n]*\n|[^\n]+$/g)];
  const starts = [], unparsedLines = [];
  let nearestDate = null, fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i][0].replace(/\r?\n$/, '');
    const markerFence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (markerFence && markerFence[1][0] === fence.char && markerFence[1].length >= fence.length && !markerFence[2].trim()) fence = null;
      continue;
    }
    if (markerFence) { fence = { char: markerFence[1][0], length: markerFence[1].length }; continue; }
    const date = /^#{1,6}\s+(20\d\d-\d\d-\d\d)\b/.exec(line);
    if (date) {
      nearestDate = date[1]; starts.push({ offset: lines[i].index, id: null, date: nearestDate }); continue;
    }
    const m = marker.exec(line);
    if (m) starts.push({ offset: lines[i].index, id: numberKey(m[1]), date: nearestDate, prefix: m[0] });
    else if (/^(?:\*\*#\d|#{2,6}\s+\d{1,3}(?!\d))/.test(line)) unparsedLines.push(i + 1);
  }
  if (!starts.length || starts[0].offset > 0) starts.unshift({ offset: 0, id: null, date: null });
  const reserved = new Set(starts.map(s => s.id).filter(Boolean)), used = new Set(), duplicates = [], missingDates = [];
  const free = n => {
    for (const letter of 'abcdefghijklmnopqrstuvwxyz') if (!reserved.has(n + letter) && !used.has(n + letter)) return n + letter;
    throw new Error(`No free suffix for lesson ${n}`);
  };
  const lessons = starts.map((s, i) => {
    const block = body.slice(s.offset, starts[i + 1]?.offset ?? body.length);
    let id = s.id;
    if (id && used.has(id)) { id = free(id.replace(/[a-z]$/, '')); duplicates.push({ original: s.id, assigned: id }); }
    if (!id) id = free('0');
    used.add(id);
    const heading = s.prefix ? block.slice(s.prefix.length).split('**')[0].split(/\r?\n\r?\n/)[0] : block.split(/\r?\n\r?\n/).find(x => x.trim()) || 'Preamble';
    const title = clean(heading.replace(/\(20\d\d-\d\d-\d\d[^)]*\)/g, ''));
    const titleBlock = s.prefix ? s.prefix + heading : heading;
    const date = /\b20\d\d-\d\d-\d\d\b/.exec(titleBlock)?.[0] || s.date;
    if (!date) missingDates.push(id);
    const padded = id.replace(/^\d+/, n => n.padStart(3, '0'));
    return { id, originalId: s.id, file: `lesson-${padded}-${slug(title)}.md`, title,
      description: summary(title), date, body: block };
  });
  return { lessons, report: { lessonsFound: lessons.length, numbered: starts.filter(s => s.id).length,
    ids: lessons.map(l => l.id), duplicates, letters: lessons.filter(l => l.originalId && /[a-z]$/.test(l.id)).map(l => l.id),
    unnumbered: lessons.filter(l => !l.originalId).map(l => l.id), missingDates,
    bytesIn: utf8Bytes(body), bytesOut: lessons.reduce((n, l) => n + utf8Bytes(l.body), 0), unparsedLines } };
}

export function lessonText(l, source = sourceDefault) {
  return `---\nname: ${l.file.slice(0, -3)}\ndescription: ${JSON.stringify(l.description)}\nmetadata:\n  type: feedback\n  lesson: "${l.id}"\n  date: ${l.date || 'null'}\n  source: ${source}\n---\n` + l.body;
}
export function migrateLessons({ memoryDir, source = sourceDefault, classes, tag = '<name>', write = false }) {
  requireMemory(memoryDir);
  if (typeof tag !== 'string' || !/^(?:<name>|[A-Za-z0-9][A-Za-z0-9._/-]*)$/.test(tag)) throw new Error('invalid recovery tag');
  if (path.basename(source) !== source || !source.endsWith('.md')) throw new Error('source must be a Markdown filename');
  const sourcePath = path.join(memoryDir, source), text = fs.readFileSync(sourcePath, 'utf8');
  if (fmGet(parseFrontmatter(text).data, 'moved_to') !== undefined) return { noop: true, message: `${source} is already a stub; nothing to do` };
  const { lessons, report } = splitLessons(text);
  const indexes = new Map();
  for (const l of lessons) {
    const activity = classes === undefined ? 'verification' : classes[l.id];
    if (!activities.includes(activity)) throw new Error(`Missing or invalid class for lesson ${l.id}`);
    const index = `INDEX-craft-${activity}.md`;
    if (!indexes.has(index)) indexes.set(index, []);
    indexes.get(index).push(`- [#${l.id}](${l.file}) — ${summary(l.title, 110)}\n`);
  }
  const result = { ...report, files: lessons.map(l => l.file), indexes: [...indexes.keys()], written: write };
  if (!write) return result;
  if (report.unparsedLines.length) throw new Error(`Unparsed lesson candidates at lines ${report.unparsedLines.join(', ')}`);
  if (!report.numbered) throw new Error('No numbered lessons found');
  for (const l of lessons) if (fs.existsSync(path.join(memoryDir, l.file))) throw new Error(`Target exists: ${l.file}`);
  const exceptions = [...report.duplicates.map(d => `#${d.original} duplicate → #${d.assigned}`),
    ...report.unnumbered.map(id => `#${id}: unnumbered block`)];
  const stub = `---\nname: ${source.slice(0, -3)}\ndescription: "Lessons split into individual files, routed by craft activity."\nmoved_to: ${JSON.stringify([...indexes.keys()])}\n---\n` +
    '\nLesson #N lives in `lesson-NNN-*.md`, zero-padded; letters as in #54b → `lesson-054b-*`.\n' +
    `Exceptions: ${exceptions.join('; ') || 'none'}.\n\nRecovery: \`git -C "${memoryDir}" show ${tag}:${source}\`.\n`;
  if (utf8Bytes(stub) > 4096) throw new Error('Stub exceeds 4 KB');
  for (const l of lessons) fs.writeFileSync(path.join(memoryDir, l.file), lessonText(l, source));
  for (const [index, lines] of indexes) {
    const dest = path.join(memoryDir, index);
    const prior = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : `# INDEX — craft: ${index.slice(12, -3)}\n\nOPEN BEFORE ${index.slice(12, -3)} work.\n`;
    fs.writeFileSync(dest, prior + '\n' + lines.join(''));
  }
  fs.writeFileSync(sourcePath, stub);
  return result;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = {};
    if (argv.shift() !== 'lessons') throw new Error('Usage: memory-migrate.mjs lessons [--memory-dir D] [--repo PATH] [--source FILE] [--classes FILE] [--tag NAME] [--write]');
    for (let i = 0; i < argv.length; i++) {
      const key = argv[i];
      if (key === '--write') options.write = true;
      else if (['--memory-dir', '--repo', '--source', '--classes', '--tag'].includes(key)) {
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw new Error(`Missing ${key} value`);
        options[{ '--memory-dir': 'memory-dir', '--repo': 'repo', '--source': 'source', '--classes': 'classes', '--tag': 'tag' }[key]] = key === '--classes' ? JSON.parse(fs.readFileSync(value, 'utf8')) : value;
      } else throw new Error(`Unknown option ${key}`);
    }
    console.log(redact(JSON.stringify(migrateLessons({ ...options, ...locations(options) }), null, 2))); return 0;
  } catch (error) { console.error(redact(`memory-migrate: ${error.message}`)); return 1; }
}
if (isDirect(import.meta.url)) process.exitCode = main();
