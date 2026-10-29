import fs from 'node:fs';
import path from 'node:path';
import { normalizeEol, matchEol, writeText, parseFrontmatter, fmGet, isDirect, requireMemory, utf8Bytes, locations, memoryFiles, brainNameSet, pathSpelling, isIndexPage, indexFamily, mdLinks, wikilinks, read, loadConfig, toolDir } from './lib.mjs';
import { redact, memoryWikilink, memoryNameIndex } from './lib.mjs';
import {withMemoryLock} from './memory-lock.mjs';
import {triggerVocabulary, hasTrigger, generateMemoryIndex, isGenerated, routes, routerFamilies, resolveRouter, isRoutingRow, lessonIdentity} from './memory-index.mjs';
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
  for (const l of lessons) fs.writeFileSync(path.join(memoryDir, l.file), matchEol(lessonText(l, source), text));
  for (const [index, lines] of indexes) {
    const dest = path.join(memoryDir, index);
    const prior = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : `# INDEX — craft: ${index.slice(12, -3)}\n\nOPEN BEFORE ${index.slice(12, -3)} work.\n`;
    fs.writeFileSync(dest, matchEol(prior + '\n' + lines.join(''), prior));
  }
  fs.writeFileSync(sourcePath, matchEol(stub, text));
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
// Compare trigger alternatives only in MEMORY.md; notes cannot satisfy this invariant.
export function checkRouterTriggers(before, after) {
  const norm = text => withoutLessonCounts(text).replace(/\]\(INDEX-([^)]+)\.md\)/g, (_, name) => `](INDEX-${indexFamily('INDEX-' + name + '.md')}.md)`).toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?;:,]+$/, '').trim();
  const triggers = text => {
    const lines = [];
    text.split(/\r?\n/).forEach((line, i) => {
      if (/^[ \t]+\S/.test(line) && lines.length && !isRoutingRow(line)) {
        if (/^[ \t]+(?:[a-z,;]|(?:[Aa]nd|[Oo]r)\b)/.test(line)) lines.at(-1).text = lines.at(-1).text.replace(/[.!?]\s*$/, '');
        lines.at(-1).text += ' ' + line.trim();
      }
      else lines.push({text: line, number: i + 1});
    });
    return lines.flatMap(({text: line, number}) => {
    const i = number - 1;
    const entries = [];
    const cell = /^\s*\|\s*([^|]+)\|/.exec(line);
    if (cell && /\]\(INDEX-/.test(line)) entries.push({key: 'cell:' + norm(cell[1]), line: i + 1});
    for (const part of line.replace(/\[[^\]]*\]\([^)]*\)|`INDEX-[^`]*`/g, ' ').split(/;\s*|(?<=[.!?])\s+/)) for (const match of part.matchAll(new RegExp('(' + triggerVocabulary + ')(?:\\s+(BEFORE|WHEN)\\b)?\\s*:?\\s*([^|;]*?)(?=' + triggerVocabulary + '|$|[|;])', 'gi'))) {
      const body = match[3];
      for (const clause of body.split(/,\s*|\s+(?:or|and)\s+/i)) if (norm(clause.replace(/^(?:or|and)\s+/i, ''))) entries.push({key: norm(match[2] ?? match[1]) + ':' + norm(clause.replace(/^(?:or|and)\s+/i, '')), line: i + 1});
    }
    return entries;
  });
  };
  const planned = new Set(triggers(after).map(entry => entry.key));
  for (const entry of triggers(before)) if (!planned.has(entry.key)) throw new Error('migration router trigger loss: MEMORY.md line ' + entry.line);
}
export function migrateRoutes(options) {
  return options.write ? withMemoryLock(options.memoryDir, lock => migrateRoutesUnlocked({...options, lock}), {lock: options.lock}) : migrateRoutesUnlocked(options);
}
function migrateRoutesUnlocked({memoryDir, repo, config = loadConfig(), write = false, beforeWrite = () => {}, probesFile = path.join(toolDir, 'recall-probes.json')}) {
  requireMemory(memoryDir);
  const files = memoryFiles(memoryDir), indexes = files.filter(f => f.special === 'index' && !f.stub && !isGenerated(f.text));
  if (!indexes.length) return {noop: true, families: [], router: [], navigation: []};
  const hooks = new Map(), handText = [], keptPages = [], regenerated = [];
  const updates = new Map(), payload = new Map(), notes = new Map(), byFile = new Map(files.map(f => [f.file, f]));
  const brainNames = repo ? brainNameSet(repo, config) : new Set();
  const memoryNames = memoryNameIndex(files);
  const resolve = link => memoryWikilink(link, memoryNames, brainNames);
  const absoluteLink = text => /\[[^\]\n]*\]\(\s*<?[A-Za-z]:[\\/]/.test(text);
  const targets = text => [...mdLinks(text).filter(link => !path.isAbsolute(link) && path.dirname(path.resolve(memoryDir, link)) === path.resolve(memoryDir)).map(link => path.basename(path.resolve(memoryDir, link))), ...wikilinks(text).flatMap(link => {
    const target = resolve(link);
    return target === 'brain' ? [] : [target?.file ?? link];
  })];
  const closure = (names, lookup, source = 'generated index') => {
    const found = new Set(), visit = name => {
      if (found.has(name)) return;
      const f = lookup.get(name);
      if (!f) throw new Error(`${source}: broken link to ${name}; fix or delete the row first`);
      found.add(name);
      const moved = fmGet(f.data, 'moved_to');
      // Index destinations are navigation, never membership in the linking family.
      for (const target of moved === undefined ? [] : Array.isArray(moved) ? moved : [moved]) if (!isIndexPage(target)) visit(target);
    };
    for (const name of names) visit(name);
    return [...found].filter(name => !lookup.get(name).special);
  };
  for (const index of indexes) {
    const family = indexFamily(index.file);
    if (!payload.has(family)) payload.set(family, new Set());
    const kept = [], blocks = [];
    const lines = rawBody(index.text).match(/[^\n]*\n|[^\n]+$/g) ?? [];
    for (let i = 0; i < lines.length; i++) {
      let text = lines[i];
      // A list item owns all indented continuations, including nested lists.
      if (/^\s*(?:[-*+]\s|\d+[.)]\s)/.test(text)) {
        while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) text += lines[++i];
      }
      blocks.push(text);
    }
    const keep = (text, source) => { kept.push(text); notes.set(family, (notes.get(family) ?? '') + text); handText.push({source,text}); };
    for (const [i, block] of blocks.entries()) {
      const line = block.replace(/\r?\n$/, '');
      const linked = targets(line), source = `${index.file}:${i + 1}`;
      for (const target of linked) for (const name of closure([target], byFile, source)) payload.get(family).add(name);
      const wiki = wikilinks(line), brainOnly = wiki.filter(link => resolve(link) === 'brain');
      const mdCount = mdLinks(line).length, allLinkCount = [...line.matchAll(/\[[^\]]*\]\([^)]*\)/g)].length;
      const linkCount = mdCount + wiki.length - brainOnly.length;
      if (line.includes('\n') || linkCount > linked.length || (!linked.length && brainOnly.length) || absoluteLink(line)) {
        keep(block, source);
        continue;
      }
      if (!linked.length) { keep(block, source); continue; }
      const row = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?/, '');
      const linkPattern = /\[[^\]]*\]\([^)]*\)|\[\[[^\]]+\]\]/g;
      const nonLink = row.replace(linkPattern, '').trim();
      if (!nonLink && !brainOnly.length && allLinkCount === mdCount) {
        const target = linked[0], f = byFile.get(target);
        const label = /^\[([^\]]*)\]\([^)]*\)$/.exec(row)?.[1] ?? /^\[\[[^|\]]+\|([^\]]+)\]\]$/.exec(row)?.[1] ?? /^\[\[([^\]]+)\]\]$/.exec(row)?.[1];
        const id = lessonIdentity(target);
        const generatedLabel = id ? '#' + id : String(fmGet(f?.data ?? {}, 'name') ?? target).replace(/[\r\n]+/g, ' ');
        if (linked.length === 1 && [generatedLabel, target, target.replace(/\.md$/, '')].includes(label)) regenerated.push({source,target,before:line,reason:'regenerated as an index row'});
        else keep(block, source);
        continue;
      }
      const match = /^(?:\[[^\]]*\]\([^)]*\)|\[\[[^\]]+\]\])\s*[\u2014\u2013-]\s*(.+)$/.exec(row);
      if (!match || linked.length !== 1) {
        keep(block, source);
        continue;
      }
      const target = linked[0], f = byFile.get(target);
      const hook = match[1].trim();
      handText.push({source, text: hook});
      if (linked.length === 1 && /^lesson-.*\.md$/.test(target) && /^(?:\uFEFF)?---\r?\n/.test(f.text) && hook.length <= 200 && (!hooks.has(target) || hooks.get(target) === hook)) {
        hooks.set(target, hook); regenerated.push({source, target, before: line, reason: 'regenerated as an index row'});
      } else keep(block, source);
    }
    keptPages.push({source:index.file, family, lines:kept.join('').split(/\r?\n/).filter(line=>line.trim())});
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
  const originalRouter = read(path.join(memoryDir, 'MEMORY.md'));
  const protectedLines = new Set();
  let wrapped = false;
  originalRouter.split(/\r?\n/).forEach((line, i) => {
    const next = originalRouter.split(/\r?\n/)[i + 1] ?? '';
    const continues = /^[ \t]+(?:[a-z,;]|(?:[Aa]nd|[Oo]r)\b)/.test(next);
    const triggerWrap = isRoutingRow(line) && /^[ \t]+\S/.test(next) && (continues || (hasTrigger(line) && !/[.!?]\s*$/.test(line)) || hasTrigger(next));
    const converted = resolveRouter(line, memoryDir) !== line || triggerWrap;
    wrapped = converted || (wrapped && /^[ \t]+\S/.test(line));
    if (wrapped) protectedLines.add(i);
  });
  const routerText = resolveRouter(originalRouter, memoryDir), routerLines = routerText.match(/[^\n]*\n|[^\n]+$/g) ?? [], groups = new Map(), router = [];
  routerLines.forEach((line, i) => {
    if (!isRoutingRow(line)) { protectedLines.add(i); return; }
    const m = /\[[^\]]*\]\((INDEX-([A-Za-z0-9-]+)\.md)\)([^\r\n]*)/.exec(line);
    if (m && (/^\s*\|/.test(line) || line.slice(0, m.index).replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?/, '').trim())) protectedLines.add(i);
    if (!m || /-all(?:-\d+)?$/.test(m[2])) return;
    const family = indexFamily(m[1]);
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push({i, line, m});
  });
  for (const family of payload.keys()) if (!groups.has(family)) throw new Error('route.unknown: index family missing from router: ' + family);
  for (const [family, rows] of groups) {
    // Table, pre-link and legacy backtick entries keep their exact text, including wrapping.
    // Normalize destinations without folding prose or stripping lesson counts.
    if (rows.some(row => protectedLines.has(row.i))) {
      for (const row of rows) {
        const after = row.line.replace(/\]\(INDEX-[^)]+\.md\)/, `](INDEX-${family}.md)`);
        routerLines[row.i] = after;
        protectedLines.add(row.i);
        router.push({before: (originalRouter.match(/[^\n]*\n|[^\n]+$/g) ?? [])[row.i], after});
      }
      continue;
    }
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
    const limit = Math.min(config.caps.index.failLineChars, config.caps.router.failLineChars - prefix.length - separator.length);
    const isTrigger = hasTrigger;
    // An existing trigger row may already exceed the cap. Never move it to notes
    // just to make a merged row fit: retain separate, normalized router rows.
    if (rows.some(row => hasTrigger(row.m[3]) && row.m[3].length > limit) || withoutLessonCounts(sentence(mergeRouterSentences(clauses.filter(isTrigger)))).length > limit) {
      const seenProse = new Set();
      for (const row of rows) {
        const parts = row.m[3].replace(/^[\s\u2014\u2013-]*/, '').split(/;\s*|(?<=[.!?])\s+/).filter(part => {
          if (/^continues INDEX-/.test(part) && indexes.some(index => part.includes(index.file.slice(0, -3)))) return false;
          if (isTrigger(part)) return true;
          if (seenProse.has(part)) return false;
          seenProse.add(part); return true;
        });
        const head = row.line.slice(0, row.m.index) + row.m[0].slice(0, row.m[0].length - row.m[3].length).replace(/\]\(INDEX-[^)]+\.md\)$/, `](INDEX-${family}.md)`);
        const ending = row.line.endsWith('\r\n') ? '\r\n' : row.line.endsWith('\n') ? '\n' : '';
        const after = head + /^[\s\u2014\u2013-]*/.exec(row.m[3])[0] + withoutLessonCounts(sentence(parts)) + ending;
        routerLines[row.i] = after;
        router.push({before: (originalRouter.match(/[^\n]*\n|[^\n]+$/g) ?? [])[row.i], after});
      }
      continue;
    }
    const kept = [];
    for (const clause of clauses) {
      if (withoutLessonCounts(sentence(mergeRouterSentences([...kept, clause, ...clauses.filter(c => isTrigger(c) && !kept.includes(c) && c !== clause)]))).length <= limit) kept.push(clause);
      else notes.set(family, (notes.get(family) ?? '') + clause + '\n');
    }
    const after = prefix + separator + withoutLessonCounts(sentence(mergeRouterSentences(kept)));
    if (after.length > config.caps.router.failLineChars) throw new Error(`merged router line exceeds ${config.caps.router.failLineChars} characters: ${family}`);
    routerLines[first.i] = after + eol;
    for (const row of rows) {
      router.push({before: (originalRouter.match(/[^\n]*\n|[^\n]+$/g) ?? [])[row.i], after: row === first ? after + eol : ''});
      if (row !== first) {
        notes.set(family, (notes.get(family) ?? '') + row.line);
        routerLines[row.i] = '';
        for(let i=row.i+1;i<routerLines.length&&/^[ \t]+\S/.test(routerLines[i])&&!isRoutingRow(routerLines[i]);i++) {
          notes.set(family,notes.get(family)+routerLines[i]);routerLines[i]='';
        }
      }
    }
  }
  const notePages = new Map();
  for (const [family, prose] of notes) {
    const source = (indexes.find(index => index.file === `INDEX-${family}.md`) ?? indexes.find(index => indexFamily(index.file) === family))?.text ?? originalRouter;
    const crlf = (source.match(/\r\n/g) ?? []).length;
    const eol = crlf > (source.match(/\n/g) ?? []).length - crlf ? '\r\n' : '\n';
    const names = []; notePages.set(family, names);
    let part = 1, body = '';
    const stem = () => `index-notes-${family}${part === 1 ? '' : '-' + part}`;
    const header = () => `---\nname: ${stem()}\ndescription: "Notes preserved from the ${family} indexes."\nmetadata:\n  type: reference\n  stable: true\n  route: ${JSON.stringify([family])}\n---\n`.replaceAll('\n', eol);
    const flush = () => {
      const name = stem() + '.md';
      if (byFile.has(name)) throw new Error('Target exists: ' + name);
      updates.set(name, header() + body); navigation.push(name); names.push(name); part++; body = '';
    };
    for (const line of normalizeEol(prose).replaceAll('\n', eol).match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      if (body && utf8Bytes(header() + body + line) > config.caps.topic.failBytes) flush();
      if (utf8Bytes(header() + line) <= config.caps.topic.failBytes) { body += line; continue; }
      // A single long line may span pages; join page bodies for conservation proofs.
      // Iterate code points so UTF-8 characters are never cut in half.
      let used = utf8Bytes(header() + body);
      for (const character of line) {
        const bytes = utf8Bytes(character);
        if (used + bytes > config.caps.topic.failBytes) { if (body) flush(); used = utf8Bytes(header()); }
        if (used + bytes > config.caps.topic.failBytes) throw new Error('topic cap cannot fit notes frontmatter: ' + family);
        body += character; used += bytes;
      }
    }
    if (body) flush();
  }
  updates.set('MEMORY.md', routerLines.map((line, i) => protectedLines.has(i) ? line : withoutLessonCounts(line)).join(''));
  for (const index of indexes) if (index.file !== `INDEX-${indexFamily(index.file)}.md`) {
    const target = `INDEX-${indexFamily(index.file)}.md`;
    updates.set(index.file, `---\nname: ${index.file.slice(0, -3)}\ndescription: "Index moved to ${target}."\nmoved_to: ${target}\n---\n\n[Open index](${target})\n`); navigation.push(index.file);
  }
  const virtual = () => [...new Set([...byFile.keys(), ...updates.keys()])].filter(file => /\.md$/i.test(file)).map(file => {
    const text = updates.get(file) ?? byFile.get(file).text, fm = parseFrontmatter(text);
    return {...byFile.get(file), file, text, ...fm, special: file === 'MEMORY.md' ? 'router' : isIndexPage(file) ? 'index' : null, stub: fmGet(fm.data, 'moved_to') !== undefined};
  });
  const generated = generateMemoryIndex({memoryDir, config, files: virtual()});
  for (const [file, text] of Object.entries(generated.pages)) { updates.set(file, text); navigation.push(file); }
  for (const row of regenerated) {
    row.after = Object.values(generated.pages).flatMap(text=>normalizeEol(text).split('\n')).find(line=>mdLinks(line).includes(row.target));
    if (!row.after) throw new Error('migration missing regenerated index row: '+row.source);
  }
  const joinedNotes = getText => [...notePages.values()].map(names => names.map(file => rawBody(getText(file) ?? '')).join('')).join('\n');
  const plannedText = normalizeEol(virtual().map(f => f.text).join('\n') + '\n' + joinedNotes(file => updates.get(file)));
  const checkOrder = getText => { for (const page of keptPages) {
    const output = (notePages.get(page.family) ?? []).map(file => rawBody(getText(file) ?? '')).join('').split(/\r?\n/);
    let cursor = 0;
    for (const line of page.lines) {
      while (cursor < output.length && output[cursor] !== line) cursor++;
      if (cursor === output.length) throw new Error('migration ORDER: ' + page.source);
      cursor++;
    }
  } };
  for (const row of router) if (row.after === '' && !plannedText.includes(normalizeEol(row.before))) throw new Error('migration router text loss: ' + row.before);
  for (const {source, text} of handText) if (!plannedText.includes(normalizeEol(text))) throw new Error('migration hand text loss: ' + source);
  checkRouterTriggers(originalRouter, updates.get('MEMORY.md'));
  for (const row of router) {
    row.moved = row.after === '' ? [...notePages.values()].flat().filter(file => normalizeEol(updates.get(file)).includes(normalizeEol(row.before))) : [];
  }
  checkOrder(file => updates.get(file));
  const families = [...payload].map(([family, names]) => {
    const reachable = new Set(Object.entries(generated.pages).filter(([file]) => file === `INDEX-${family}.md` || new RegExp('^INDEX-' + family + '-all(?:-\\d+)?\\.md$').test(file)).flatMap(([, text]) => mdLinks(text)));
    const lookup = new Map(virtual().map(f => [f.file, f]));
    const before = [...names].sort(), after = closure([...reachable].filter(name => lookup.has(name)), lookup).filter(name => memberships.has(name)).sort();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('migration payload loss: ' + family);
    return {family, before, after};
  });
  let recall = null;
  if (fs.existsSync(probesFile) && repo) {
    const before = runProbes({memoryDir, repo, config, probesFile}).filter(p => p.pass).length;
    const after = runProbes({corpus: buildCorpus({memoryDir, repo, config, files: virtual()}), probesFile}).filter(p => p.pass).length;
    if (after < before) throw new Error(`migration recall loss: ${before} -> ${after}`);
    recall = {before, after};
  }
  const report = {families, router, navigation: navigation.sort(), recall, regenerated};
  let ignore = read(path.join(memoryDir, '.gitignore'));
  if (!ignore.split(/\r?\n/).includes('.memory.lock*')) ignore += (ignore && !ignore.endsWith('\n') ? '\n' : '') + '.memory.lock*\n';
  updates.set('.gitignore', ignore);
  updates.set('migration-routes-report.json', JSON.stringify(report, null, 2) + '\n');
  for (const file of generated.removed) updates.set(file, null);
  if (write) {
    beforeWrite({created: [...updates].filter(([file, text]) => text !== null && !fs.existsSync(path.join(memoryDir, file))).map(([file]) => file)});
    const originals = new Map([...updates.keys()].map(file => [file, fs.existsSync(path.join(memoryDir, file)) ? fs.readFileSync(path.join(memoryDir, file)) : null]));
    try {
      for (const [file, text] of updates) { if (text === null) fs.unlinkSync(path.join(memoryDir, file)); else fs.writeFileSync(path.join(memoryDir, file), matchEol(text, originals.get(file)?.toString() ?? text)); }
      checkRouterTriggers(originalRouter, read(path.join(memoryDir, 'MEMORY.md')));
      checkOrder(file => read(path.join(memoryDir,file)));
      const written = normalizeEol(memoryFiles(memoryDir).map(f=>f.text).join('\n') + '\n' + joinedNotes(file => read(path.join(memoryDir,file))));
      for (const index of indexes) for (const line of normalizeEol(rawBody(index.text)).split('\n')) {
        if (line.trim() && !written.split('\n').includes(line) && !regenerated.some(row=>normalizeEol(row.before)===line && written.split('\n').includes(row.after))) throw new Error('migration hand line loss: '+index.file+': '+line);
      }
    }
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
      writeText(path.join(loc.memoryDir, 'MEMORY.md'), router);
      return {...result, routes: migrateRoutes({...loc, lock})};
    });
    else result = migrateLessons(loc);
    console.log(redact(JSON.stringify(result, null, 2))); return 0;
  } catch (error) { console.error(redact(`memory-migrate: ${error.message}`)); return 1; }
}
if (isDirect(import.meta.url)) process.exitCode = main();
