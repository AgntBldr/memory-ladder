import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, fmGet, isDirect, requireMemory, utf8Bytes, locations, memoryFiles, mdLinks, wikilinks, read, loadConfig, toolDir } from './lib.mjs';
import { redact } from './lib.mjs';
import {withMemoryLock} from './memory-lock.mjs';
import {generateMemoryIndex, isGenerated, routes, routerFamilies} from './memory-index.mjs';
import {buildCorpus, runProbes} from './memory-recall.mjs';

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
const marker = /^(?:\*\*#?|#{2,6}[ \t]+#?)(\d+[a-z]*)(?=\.(?:\s|$)|\s|[—–-])(?:[ \t]*\([^\r\n]*?\))?[.]?[ \t]*(?:[—–-][ \t]*)?/;

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
    else if (/^(?:\*\*#\d|#{2,6}\s+\d+)/.test(line)) unparsedLines.push(i + 1);
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
export function migrateLessons(options) {
  return options.write ? withMemoryLock(options.memoryDir, () => migrateLessonsUnlocked(options), {lock: options.lock}) : migrateLessonsUnlocked(options);
}
function migrateLessonsUnlocked({ memoryDir, source = sourceDefault, classes, tag = '<name>', write = false }) {
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

function spliceRoutes(text, selected, key = 'route') {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)(^---[ \t]*(?:\r?\n|$))/m.exec(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (!match || match.index !== 0) return `---${eol}metadata:${eol}  ${key}: ${JSON.stringify(selected)}${eol}---${eol}` + text;
  let header = match[1];
  const lines = header.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let metadata = false, inserted = false;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^metadata:\s*$/.test(line.trimEnd())) { metadata = true; out.push(line, `  ${key}: ${JSON.stringify(selected)}${eol}`); inserted = true; continue; }
    if (/^\S/.test(line) && line.trim()) metadata = false;
    if (line.startsWith(key + ':') || (metadata && line.startsWith('  ' + key + ':'))) {
      const indent = /^ */.exec(line)[0].length;
      while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^ */.exec(lines[i + 1])[0].length > indent || /^- /.test(lines[i + 1]))) i++;
      continue;
    }
    out.push(line);
  }
  if (!inserted) out.push(`metadata:${eol}  ${key}: ${JSON.stringify(selected)}${eol}`);
  return text.slice(0, match[0].indexOf(match[1])) + out.join('') + match[2] + text.slice(match[0].length);
}
const withoutLessonCounts = text => text.replace(/\b\d+ (?:hard-won )?lessons\b/gi, (match, offset) =>
  /(?:^|[.!?]\s+|\n\s*)$/.test(text.slice(0, offset)) ? 'Lessons' : 'lessons');
function mergeRouterSentences(parts) {
  const result = [], leads = new Map();
  const normalize = text => text.toLowerCase().trim().replace(/^(?:or|and)\s+/, '').replace(/[.!?;:,]+$/, '').trim();
  for (const text of parts) {
    const match = /^(OPEN\s+(?:BEFORE|when))\s+(.+?)([.!?]*)$/i.exec(text);
    if (!match) { if (!result.includes(text)) result.push(text); continue; }
    const key = match[1].toLowerCase(), previous = leads.get(key);
    if (!previous) {
      const entry = {text, lead: match[1], body: match[2], end: match[3]};
      leads.set(key, entry); result.push(entry); continue;
    }
    const split = body => {
      const seen = new Set();
      return body.split(/,\s*|\s+(?:or|and)\s+(?!.*\s+(?:or|and)\s+)/i)
        .map(c => c.trim().replace(/^(?:or|and)\s+/i, '').replace(/[.!?;:,]+$/, '').trim())
        .filter(c => { const key = normalize(c); if (!key || seen.has(key)) return false; seen.add(key); return true; });
    };
    const clauses = split(previous.body), incoming = split(match[2]);
    const seen = new Set(clauses.map(normalize));
    // Keep a shared closing alternative last while inserting new triggers before it.
    const closing = clauses.at(-1), sharedClosing = normalize(incoming.at(-1) ?? '') === normalize(closing ?? '');
    if (sharedClosing) clauses.pop();
    for (const clause of incoming) if (!seen.has(normalize(clause))) { clauses.push(clause); seen.add(normalize(clause)); }
    if (sharedClosing) clauses.push(closing);
    previous.body = clauses.length > 1 ? clauses.slice(0, -1).join(', ') + ' or ' + clauses.at(-1) : clauses[0];
    previous.text = previous.lead + ' ' + previous.body + previous.end;
  }
  return result.map(part => typeof part === 'string' ? part : part.text);
}
export function migrateRoutes(options) {
  return options.write ? withMemoryLock(options.memoryDir, lock => migrateRoutesUnlocked({...options, lock}), {lock: options.lock}) : migrateRoutesUnlocked(options);
}
function migrateRoutesUnlocked({memoryDir, repo, config = loadConfig(), write = false, beforeWrite = () => {}, probesFile = path.join(toolDir, 'recall-probes.json')}) {
  requireMemory(memoryDir);
  const files = memoryFiles(memoryDir), indexes = files.filter(f => f.special === 'index' && !f.stub && !isGenerated(f.text));
  if (!indexes.length) return {noop: true, families: [], router: [], navigation: []};
  const hooks = new Map(), handText = [];
  const updates = new Map(), payload = new Map(), notes = new Map(), byFile = new Map(files.map(f => [f.file, f]));
  const familyOf = file => file.slice(6, -3).replace(/-\d+$/, '');
  const targets = text => [...mdLinks(text), ...wikilinks(text).map(link => {
    const target = files.find(f => f.file === link || f.file === link + '.md' || fmGet(f.data, 'name') === link);
    return target?.file ?? link;
  })];
  const closure = (names, lookup, source = 'generated index') => {
    const found = new Set(), visit = name => {
      if (found.has(name)) return;
      const f = lookup.get(name);
      if (!f) throw new Error(`${source}: broken link to ${name}; fix or delete the row first`);
      found.add(name);
      const moved = fmGet(f.data, 'moved_to');
      // Index destinations are navigation, never membership in the linking family.
      for (const target of moved === undefined ? [] : Array.isArray(moved) ? moved : [moved]) if (!target.startsWith('INDEX-')) visit(target);
    };
    for (const name of names) visit(name);
    return [...found].filter(name => !lookup.get(name).special);
  };
  for (const index of indexes) {
    const family = familyOf(index.file);
    if (!payload.has(family)) payload.set(family, new Set());
    for (const [i, line] of index.text.split(/\r?\n/).entries()) {
      const linked = targets(line), source = `${index.file}:${i + 1}`;
      for (const target of linked) for (const name of closure([target], byFile, source)) payload.get(family).add(name);
      if (!linked.length) continue;
      const row = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?/, '');
      const linkPattern = /\[[^\]]*\]\([^)]*\)|\[\[[^\]]+\]\]/g;
      const nonLink = row.replace(linkPattern, '').trim();
      if (!nonLink) continue;
      const match = /^(?:\[[^\]]*\]\([^)]*\)|\[\[[^\]]+\]\])\s*[\u2014\u2013-]\s*(.+)$/.exec(row);
      if (!match || linked.length !== 1) {
        handText.push({source, text: line});
        notes.set(family, (notes.get(family) ?? '') + line + '\n');
        continue;
      }
      const target = linked[0], f = byFile.get(target);
      const hook = match[1].trim();
      handText.push({source, text: hook});
      if (linked.length === 1 && /^lesson-.*\.md$/.test(target) && /^(?:\uFEFF)?---\r?\n/.test(f.text) && hook.length <= 200 && (!hooks.has(target) || hooks.get(target) === hook)) hooks.set(target, hook);
      else notes.set(family, (notes.get(family) ?? '') + line + '\n');
    }
    const prose = (rawBody(index.text).match(/[^\n]*\n|[^\n]+$/g) ?? []).filter(line => !mdLinks(line).length && !wikilinks(line).length).join('');
    if (prose.trim()) { notes.set(family, (notes.get(family) ?? '') + prose); handText.push({source: index.file, text: prose}); }
  }
  const memberships = new Map();
  for (const [family, names] of payload) for (const name of names) {
    if (!memberships.has(name)) memberships.set(name, []);
    memberships.get(name).push(family);
  }
  const orphans = files.filter(f => /^lesson-.*\.md$/.test(f.file) && !memberships.has(f.file));
  if (orphans.length) throw new Error('orphan lessons: ' + orphans.map(f => f.file).join(', '));
  for (const [name, families] of memberships) updates.set(name, spliceRoutes(byFile.get(name).text, [...new Set([...routes(byFile.get(name).data), ...families])].sort()));
  for (const [name, hook] of hooks) updates.set(name, spliceRoutes(updates.get(name) ?? byFile.get(name).text, hook, 'hook'));
  const navigation = [];
  const routerText = read(path.join(memoryDir, 'MEMORY.md')), routerLines = routerText.match(/[^\n]*\n|[^\n]+$/g) ?? [], groups = new Map(), router = [];
  routerLines.forEach((line, i) => {
    const m = /\[[^\]]*\]\((INDEX-([A-Za-z0-9-]+)\.md)\)([^\r\n]*)/.exec(line);
    if (!m || /-all(?:-\d+)?$/.test(m[2])) return;
    const family = m[2].replace(/-\d+$/, '');
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push({i, line, m});
  });
  for (const family of payload.keys()) if (!groups.has(family)) throw new Error('route.unknown: index family missing from router: ' + family);
  for (const [family, rows] of groups) {
    const first = rows.find(r => r.m[2] === family) ?? rows[0], clauses = [];
    const separator = /^[\s\u2014\u2013-]*/.exec(first.m[3])[0];
    for (const row of [first, ...rows.filter(r => r !== first)]) for (const clause of row.m[3].replace(/^[\s\u2014\u2013-]*/, '').split(/;\s*|(?<=[.!?])\s+/)) {
      const normalized = clause.replace(/^[\u2014\u2013-]\s*/, '').trim();
      if (/^continues INDEX-/.test(normalized) && indexes.some(index => normalized.includes(index.file.slice(0, -3)))) continue;
      if (normalized && !clauses.some(c => c.replace(/[.;]+$/, '') === normalized.replace(/[.;]+$/, ''))) clauses.push(normalized);
    }
    const eol = first.line.endsWith('\r\n') ? '\r\n' : first.line.endsWith('\n') ? '\n' : '';
    const prefix = first.line.slice(0, first.m.index) + first.m[0].slice(0, first.m[0].length - first.m[3].length).replace(/\]\(INDEX-[^)]+\.md\)$/, `](INDEX-${family}.md)`);
    const sentence = parts => parts.reduce((text, part) => text + (text ? /[.!?]$/.test(text) ? ' ' : '; ' : '') + part, '');
    const kept = [];
    for (const clause of clauses) {
      if (sentence(mergeRouterSentences([...kept, clause])).length <= Math.min(config.caps.index.failLineChars, config.caps.router.failLineChars - prefix.length - separator.length)) kept.push(clause);
      else notes.set(family, (notes.get(family) ?? '') + clause + '\n');
    }
    const after = prefix + separator + withoutLessonCounts(sentence(mergeRouterSentences(kept)));
    if (after.length > config.caps.router.failLineChars) throw new Error(`merged router line exceeds ${config.caps.router.failLineChars} characters: ${family}`);
    routerLines[first.i] = after + eol;
    for (const row of rows) { router.push({before: row.line, after: row === first ? after + eol : ''}); if (row !== first) routerLines[row.i] = ''; }
  }
  for (const [family, prose] of notes) {
    const name = `index-notes-${family}.md`;
    if (byFile.has(name)) throw new Error('Target exists: ' + name);
    updates.set(name, `---\nname: index-notes-${family}\ndescription: "Notes preserved from the ${family} indexes."\nmetadata:\n  type: reference\n  stable: true\n  route: ${JSON.stringify([family])}\n---\n` + prose);
    navigation.push(name);
  }
  updates.set('MEMORY.md', withoutLessonCounts(routerLines.join('')));
  for (const index of indexes) if (index.file !== `INDEX-${familyOf(index.file)}.md`) {
    const target = `INDEX-${familyOf(index.file)}.md`;
    updates.set(index.file, `---\nname: ${index.file.slice(0, -3)}\ndescription: "Index moved to ${target}."\nmoved_to: ${target}\n---\n\n[Open index](${target})\n`); navigation.push(index.file);
  }
  const virtual = () => [...new Set([...byFile.keys(), ...updates.keys()])].filter(file => file.endsWith('.md')).map(file => {
    const text = updates.get(file) ?? byFile.get(file).text, fm = parseFrontmatter(text);
    return {...byFile.get(file), file, text, ...fm, special: file === 'MEMORY.md' ? 'router' : file.startsWith('INDEX-') ? 'index' : null, stub: fmGet(fm.data, 'moved_to') !== undefined};
  });
  const generated = generateMemoryIndex({memoryDir, config, files: virtual()});
  for (const [file, text] of Object.entries(generated.pages)) { updates.set(file, text); navigation.push(file); }
  const plannedText = virtual().map(f => f.text).join('\n');
  for (const {source, text} of handText) if (!plannedText.includes(text)) throw new Error('migration hand text loss: ' + source);
  const families = [...payload].map(([family, names]) => {
    const reachable = new Set(Object.entries(generated.pages).filter(([file]) => file === `INDEX-${family}.md` || new RegExp('^INDEX-' + family + '-all(?:-\\d+)?\\.md$').test(file)).flatMap(([, text]) => mdLinks(text)));
    const lookup = new Map(virtual().map(f => [f.file, f]));
    const before = [...names].sort(), after = closure([...reachable].filter(name => lookup.has(name)), lookup).filter(name => memberships.has(name)).sort();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('migration payload loss: ' + family);
    return {family, before, after};
  });
  let recall = null;
  if (fs.existsSync(probesFile) && repo) {
    const before = runProbes({memoryDir, repo, probesFile}).filter(p => p.pass).length;
    const after = runProbes({corpus: buildCorpus({memoryDir, repo, files: virtual()}), probesFile}).filter(p => p.pass).length;
    if (after < before) throw new Error(`migration recall loss: ${before} -> ${after}`);
    recall = {before, after};
  }
  const report = {families, router, navigation: navigation.sort(), recall};
  let ignore = read(path.join(memoryDir, '.gitignore'));
  if (!ignore.split(/\r?\n/).includes('.memory.lock*')) ignore += (ignore && !ignore.endsWith('\n') ? '\n' : '') + '.memory.lock*\n';
  updates.set('.gitignore', ignore);
  updates.set('migration-routes-report.json', JSON.stringify(report, null, 2) + '\n');
  for (const file of generated.removed) updates.set(file, null);
  if (write) {
    beforeWrite({created: [...updates].filter(([file, text]) => text !== null && !fs.existsSync(path.join(memoryDir, file))).map(([file]) => file)});
    const originals = new Map([...updates.keys()].map(file => [file, fs.existsSync(path.join(memoryDir, file)) ? fs.readFileSync(path.join(memoryDir, file)) : null]));
    try { for (const [file, text] of updates) { if (text === null) fs.unlinkSync(path.join(memoryDir, file)); else fs.writeFileSync(path.join(memoryDir, file), text); } }
    catch (error) { for (const [file, data] of originals) { if (data === null) fs.rmSync(path.join(memoryDir, file), {force: true}); else fs.writeFileSync(path.join(memoryDir, file), data); } throw error; }
  }
  return report;
}
export function main(argv = process.argv.slice(2)) {
  try {
    const options = {};
    const commandIndex = argv.findIndex(x => ['lessons', 'routes', 'convert'].includes(x)), command = argv.splice(commandIndex, 1)[0];
    if (commandIndex < 0) throw new Error('Usage: memory-migrate.mjs lessons|routes|convert [--memory-dir D] [--write|--dry-run]');
    for (let i = 0; i < argv.length; i++) {
      const key = argv[i];
      if (key === '--write') options.write = true;
      else if (key === '--dry-run') options.dryRun = true;
      else if (['--memory-dir', '--repo', '--source', '--classes', '--tag'].includes(key)) {
        const value = argv[++i];
        if (!value || value.startsWith('--')) throw new Error(`Missing ${key} value`);
        options[{ '--memory-dir': 'memory-dir', '--repo': 'repo', '--source': 'source', '--classes': 'classes', '--tag': 'tag' }[key]] = key === '--classes' ? JSON.parse(fs.readFileSync(value, 'utf8')) : value;
      } else throw new Error(`Unknown option ${key}`);
    }
    const loc = {...options, ...locations(options), write: Boolean(options.write && !options.dryRun)};
    let result;
    if (command === 'routes') result = migrateRoutes(loc);
    else if (command === 'convert' && loc.write) result = withMemoryLock(loc.memoryDir, lock => {
      const result = migrateLessons({...loc, lock});
      let router = read(path.join(loc.memoryDir, 'MEMORY.md'));
      for (const index of result.indexes ?? []) if (!router.includes('(' + index + ')')) router += `\n- [${index.slice(6, -3)}](${index}) OPEN BEFORE ${index.slice(6, -3)} work.\n`;
      fs.writeFileSync(path.join(loc.memoryDir, 'MEMORY.md'), router);
      return {...result, routes: migrateRoutes({...loc, lock})};
    });
    else result = migrateLessons(loc);
    console.log(redact(JSON.stringify(result, null, 2))); return 0;
  } catch (error) { console.error(redact(`memory-migrate: ${error.message}`)); return 1; }
}
if (isDirect(import.meta.url)) process.exitCode = main();
