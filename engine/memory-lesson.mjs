import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {lessonCases, validateKindCase, args, locations, isDirect, toolDir, readRequired, listMd, pathKey, normalizeEol, parseFrontmatter, insideRepo, loadConfig, memoryFiles, writeText} from './lib.mjs';
import {withMemoryLock} from './memory-lock.mjs';
import {routerFamilies, lessonIdentity, lessonField, isGenerated, writeMemoryIndex, gateCheckIds, enforceSentence, failSentence, KINDS, REPEAT_ENTRY} from './memory-index.mjs';
import {buildCorpus, search} from './memory-recall.mjs';
import {validDate} from './memory-rotate.mjs';
import {splitSections} from './memory-conserve.mjs';
import {runCheck, counts, findingLine} from './memory-check.mjs';

const kindError = 'kind must be mistake, practice or observation; run: node scripts/memory/memory-lesson.mjs new --kind <kind> --route <family> "<title>"';
function validateTakeaway(value) {
  if (value !== undefined && !['fix', 'method', 'know'].includes(value)) throw Error('takeaway must be fix, method or know');
}
function validateTrigger(trigger) {
  if (trigger !== undefined && (typeof trigger !== 'string' || !trigger.trim() || controls.test(trigger) || trigger.length > 200)) throw Error('trigger must be one line at most 200 characters');
}
function validateRepeatNote(note, today) {
  checkDate(today);
  note = String(note ?? '').trim();
  if (!note || controls.test(note) || `${today} ${note}`.length > 200) throw Error('repeat note must be one nonempty line without control characters; dated entry at most 200 characters; use a -- separator before a note starting with --');
  if (!/^(slip|not-recalled|rule-wrong|new-case): \S.*$/.test(note)) throw Error('repeat note must start with a cause and a colon: slip, not-recalled, rule-wrong or new-case');
  return note;
}
function captureCorpus(options) {
  const files = memoryFiles(options.memoryDir);
  const titles = new Map(files.map(f => [f.file, /^\*\*#\d+[a-z]*(?: \([^\n]*?\))?\.?\s+(.+?)\.?\*\*/m.exec(f.body)?.[1] ?? /^#\s+(.+)$/m.exec(f.body)?.[1] ?? f.data.name ?? f.file]));
  return buildCorpus({...options, files, memoryOnly: true}).map(d => ({...d, title: titles.get(d.path)})).filter(d => d.source === 'memory' && lessonIdentity(path.basename(d.path)));
}
export function similarLessons({corpus, query, exclude = [], k = 3}) {
  const excluded = value => exclude.some(x => x === value || x === path.basename(value) || String(x).replace(/^#/, '').padStart(3, '0') === lessonIdentity(path.basename(value)));
  return search(corpus.filter(d => d.source === 'memory' && lessonIdentity(path.basename(d.path)) && !excluded(d.path)), query, k)
    .map(r => ({file: r.path, id: lessonIdentity(path.basename(r.path)), title: String(corpus.find(d => d.path === r.path)?.title ?? r.hook).replace(/[\r\n]+/g, ' ').slice(0, 100), score: r.score}));
}
function printSimilar(similar, {title, created = false} = {}) {
  const label = title === undefined ? 'similar:' : `similar to ${quote(title)}:`;
  console.error(similar.length ? label : `${label} none`);
  for (const r of similar) console.error(`  #${r.id} ${r.title} (${r.score.toFixed(1)})`);
  if (similar.length) console.error(`if one of these is the same lesson, ${created ? 'delete the new file, then use' : 'use'}: memory-lesson.mjs repeat <id> "<cause>: <note>"`);
}

export function allocate(memoryDir, count) {
  const highest = listMd(memoryDir).reduce((max, file) => {
    const id = lessonIdentity(file), n = id ? BigInt(/^\d+/.exec(id)[0]) : 0n;
    return n > max ? n : max;
  }, 0n);
  return Array.from({length: count}, (_, i) => String(highest + BigInt(i + 1)).padStart(3, '0'));
}
const slugFor = title => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).replace(/-$/, '') || 'lesson';
const templateText = () => {
  const file = path.join(toolDir, 'templates/lesson.md');
  return normalizeEol(readRequired(fs.existsSync(file) ? file : path.join(toolDir, '../templates/lesson.md')));
};
const todayDefault = () => new Date().toISOString().slice(0, 10);
const checkDate = today => { if (!validDate(today)) throw Error('invalid --today date; expected YYYY-MM-DD'); };

const quote = value => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const controls = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;
function rollbackError(original, rollback) {
  try { rollback(); } catch (error) { throw new Error(`${original.message}; rollback failed: ${error.message}`, {cause: original}); }
  throw original;
}
function restoreAll(actions) {
  const failed = [], errors = [];
  for (const action of actions) {
    try { action(); } catch (error) { failed.push({action, message: error.message}); }
  }
  // Finish the first pass before retrying; report only steps that fail twice.
  for (const {action, message} of failed) {
    try { action(); } catch (error) { errors.push(`${message} (retry failed: ${error.message})`); }
  }
  if (errors.length) throw new Error(errors.join('; '));
}

// Put inline comments on their own line for the restricted frontmatter parser.
function blockMetadataComments(text) {
  text = normalizeEol(text);
  const front = parseFrontmatter(text).raw;
  return front ? text.replace(front, () => front.replace(/^metadata:[ \t]+(#.*)$/gm, 'metadata:\n  $1')) : text;
}

// Refuse ambiguous representations; verify the parsed value before any write.
export function spliceMetadata(text, key, value, {block = false} = {}) {
  text = blockMetadataComments(text);
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '', before = parseFrontmatter(text).data;
  const lines = normalizeEol(text.replace(/^\uFEFF/, '')).split('\n');
  if (!/^---\s*$/.test(lines[0])) lines.unshift('---', 'metadata:', '---');
  let end = lines.findIndex((line, i) => i > 0 && /^---\s*$/.test(line));
  if (end < 0) throw Error('unclosed frontmatter');
  if (Object.hasOwn(before, key)) throw Error(`top-level ${key} is not supported; move it into block metadata first`);
  if (lines.slice(1, end).some(line => /^metadata:/.test(line) && !/^metadata:\s*$/.test(line))) throw Error('flow-map metadata is not supported; convert it to block metadata first');
  let start = lines.findIndex((line, i) => i > 0 && i < end && /^metadata:\s*$/.test(line));
  if (start < 0) { lines.splice(end, 0, 'metadata:'); start = end; end++; }
  let stop = start + 1;
  while (stop < end && (!lines[stop].trim() || /^\s/.test(lines[stop]))) stop++;
  const indent = lines.slice(start + 1, stop).map(line => /^( +)[\w.-]+:/.exec(line)?.[1]).find(Boolean) ?? '  ';
  let at = lines.findIndex((line, i) => i > start && i < stop && line.startsWith(`${indent}${key}:`));
  let until = at + 1;
  if (at < 0) at = until = stop;
  else while (until < stop && (!lines[until].trim() || /^\s*/.exec(lines[until])[0].length > indent.length || lines[until].startsWith(`${indent}- `))) until++;
  const blanks = lines.slice(at + 1, until).filter(line => !line.trim());
  const replacement = block ? [`${indent}${key}:`, ...value.map(item => `${indent}  - ${quote(item)}`)] : [`${indent}${key}: ${key === 'kind' && KINDS.includes(value) ? value : quote(value)}`];
  replacement.push(...blanks);
  lines.splice(at, until - at, ...replacement);
  const result = bom + lines.join('\n'), after = parseFrontmatter(result).data;
  const remaining = [...(before.__warnings ?? [])].map(w => w.text);
  const newWarnings = (after.__warnings ?? []).some(w => { const at = remaining.indexOf(w.text); if (at < 0) return true; remaining.splice(at, 1); return false; });
  const preserved = Object.entries(before).every(([name, old]) => {
    if (name === '__warnings') return true;
    if (name === 'metadata' && old === null) return true;
    if (name === 'metadata' && old && typeof old === 'object' && !Array.isArray(old))
      return Object.entries(old).every(([sibling, prior]) => sibling === key || isDeepStrictEqual(after.metadata?.[sibling], prior));
    return isDeepStrictEqual(after[name], old);
  });
  if (after.__error || newWarnings || !preserved || !isDeepStrictEqual(lessonField(after, key), value)) throw Error(`metadata splice verification failed for ${key}: the lesson's frontmatter could not be updated safely; edit it by hand and rerun`);
  return result;
}

export function parseBatch(text, {errors: collectedErrors} = {}) {
  const errors = collectedErrors ?? [], result = [];
  for (const section of splitSections(normalizeEol(text), line => /^## /.test(line)).filter(s => s.kind === 'section')) {
    const sectionErrors = errors.length;
    const lines = section.text.split('\n'), blank = lines.findIndex((line, i) => i > 0 && !line.trim());
    const keys = lines.slice(1, blank < 0 ? lines.length : blank), parsed = parseFrontmatter(`---\n${keys.join('\n')}\n---\n`).data;
    for (const warning of parsed.__warnings ?? []) errors.push(`batch line ${section.line + warning.line - 1}: invalid or duplicate key`);
    for (const key of Object.keys(parsed).filter(k => !['route', 'description', 'pin', 'hook', 'supersedes', 'date', 'type', 'kind', 'takeaway', 'trigger', 'case', 'repeat-of', 'cause', '__warnings'].includes(k)))
      errors.push(`batch line ${section.line + 1 + keys.findIndex(l => l.startsWith(key + ':'))}: unknown key ${key}`);
    result.push({...parsed, invalid: errors.length > sectionErrors, title: lines[0].slice(3).trim(), line: section.line, body: (blank < 0 ? '' : lines.slice(blank + 1).join('\n')).replace(/^\s*\n/, '').replace(/\n*$/, '\n')});
  }
  if (!result.length) errors.push('batch requires at least one section');
  if (errors.length && !collectedErrors) throw Error(errors.join('\n'));
  return result;
}
function emptyPrompt(body) {
  const parts = body.split(/^\s*\*\*(?:Why:|How to apply:)\*\*\s*$/m);
  return parts.slice(1).some(part => !part.trim());
}
const generated = memoryDir => memoryFiles(memoryDir).filter(f => f.special === 'index' && isGenerated(f.text));
function snapshotPages(memoryDir) { return new Map(generated(memoryDir).map(f => [f.file, fs.readFileSync(path.join(memoryDir, f.file))])); }
function pageRestoreActions(memoryDir, snapshot) {
  return [
    ...generated(memoryDir).filter(f => !snapshot.has(f.file)).map(f => () => fs.unlinkSync(path.join(memoryDir, f.file))),
    ...[...snapshot].map(([file, bytes]) => () => fs.writeFileSync(path.join(memoryDir, file), bytes)),
  ];
}
function restorePages(memoryDir, snapshot) { restoreAll(pageRestoreActions(memoryDir, snapshot)); }
function regenerate(options, snapshot) {
  return snapshot.size ? Object.keys(writeMemoryIndex(options).pages).length : 0;
}
export function batchLessons({memoryDir, repo, file, route, today = todayDefault(), config = loadConfig(), dryRun = false, afterWrite = () => {}, lock, check = runCheck}) {
  // Tests can inject check to run the gate in isolated transactions.
  checkDate(today);
  if (!file) throw Error('batch requires FILE');
  file = path.resolve(file);
  if (file === path.resolve(memoryDir) || insideRepo(memoryDir, file)) throw Error('batch file must not be inside the memory folder');
  const errors = [], warnings = [], sections = parseBatch(readRequired(file), {errors});
  const families = routerFamilies(readRequired(path.join(memoryDir, 'MEMORY.md')), memoryDir), titles = new Set();
  for (const s of sections) {
    const error = message => { s.invalid = true; errors.push(`batch line ${s.line}: ${message}`); };
    if (!s.title || /[\r\n]/.test(s.title)) error('title must be a nonempty single line');
    if (titles.has(s.title)) error('duplicate title: ' + s.title); titles.add(s.title);
    if (s['repeat-of'] !== undefined) {
      const allowed = ['repeat-of', 'cause', 'description', 'date', 'invalid', 'title', 'line', 'body', '__warnings'];
      if (Object.keys(s).some(key => !allowed.includes(key)) || s.body.trim()) error('repeat-of sections carry only cause, description and date; detail belongs in the lesson');
      s.date ??= today;
      if (!validDate(s.date)) error('date must be YYYY-MM-DD');
      if (typeof s.description !== 'string' || !s.description.trim()) error('description must be a nonempty single line');
      try {
        validateRepeatNote(`${s.cause}: ${s.description ?? ''}`, validDate(s.date) ? s.date : today);
        s.target = targetFile(memoryDir, s['repeat-of']).file;
      } catch (e) { error(e.message); }
      continue;
    }
    if (!KINDS.includes(s.kind)) error(kindError);
    try { validateTakeaway(s.takeaway); } catch (e) { error(e.message); }
    try { validateKindCase(s.case); } catch (e) { error(e.message); }
    try { validateTrigger(s.trigger); } catch (e) { error(e.message); }
    const selected = s.route ?? route;
    s.route = [...new Set((Array.isArray(selected) ? selected : String(selected ?? '').split(',')).map(x => typeof x === 'string' ? x.trim() : x).filter(Boolean))];
    if (!s.route.length || s.route.some(x => !families.has(x))) error(`route.unknown: ${selected ?? '(missing)'}; known families: ${[...families.keys()].join(', ')}`);
    if (typeof s.description !== 'string' || !s.description.trim() || s.description.trim() === 'TODO') error('description must be nonempty and not TODO');
    else {
      if (s.description.length > config.caps.description.failChars) error(`description exceeds ${config.caps.description.failChars} characters`);
      else if (s.description.length > config.caps.description.warnChars) warnings.push(`batch line ${s.line}: description exceeds ${config.caps.description.warnChars} characters`);
      if (/Newest:/i.test(s.description)) error('description contains Newest:');
      if (controls.test(s.description)) error('description must not contain control characters');
    }
    if (!s.body.replace(/^\s*\*\*(?:Why:|How to apply:)\*\*\s*$/gm, '').trim()) error('body must be nonempty');
    if (emptyPrompt(s.body)) error('fill the empty **Why:** / **How to apply:** section');
    if (s.hook !== undefined && (typeof s.hook !== 'string' || s.hook.length > 200)) error('hook must be a string at most 200 characters');
    if (typeof s.hook === 'string' && controls.test(s.hook)) error('hook must not contain control characters');
    if (s.pin !== undefined && typeof s.pin !== 'boolean') error('pin must be boolean');
    if (s.supersedes !== undefined && (!Array.isArray(s.supersedes) || s.supersedes.some(n => typeof n !== 'string' || !listMd(memoryDir).includes(n)))) error('supersedes must list existing memory file names');
    s.date ??= today; if (!validDate(s.date)) error('date must be YYYY-MM-DD');
    s.type ??= 'feedback'; if (!['user', 'feedback', 'project', 'reference'].includes(s.type)) error('invalid type');
  }
  const creating = sections.filter(s => s['repeat-of'] === undefined), repeating = sections.filter(s => s['repeat-of'] !== undefined);
  const corpus = captureCorpus({memoryDir, repo, config});
  for (const s of creating) s.similar = similarLessons({corpus, query: s.title + ' ' + (s.description ?? ''), exclude: [...(Array.isArray(s.supersedes) ? s.supersedes : []), s.target].filter(Boolean)});
  const render = () => {
    const numbers = allocate(memoryDir, creating.length);
    return creating.flatMap((s, i) => {
      if (s.invalid) return [];
      try {
        const number = numbers[i], name = `lesson-${number}-${slugFor(s.title)}`;
        const words = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(), desc = words(s.description);
        const warning = `batch line ${s.line}: description only restates the filename or name; add useful context`;
        if (desc && ((' ' + words(name) + ' ').includes(' ' + desc + ' ') || desc === words(name)) && !warnings.includes(warning)) warnings.push(warning);
        const values = {name, number, kind: s.kind, title: s.title, date: s.date, route: quote(s.route), pin: String(s.pin ?? false)};
        let text = templateText().replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]).replace(/^description: "TODO"$/m, () => `description: ${quote(s.description ?? '')}`).replace(/^  type: feedback$/m, `  type: ${s.type}`);
        if (s.case !== undefined) text = spliceMetadata(text, 'kind_case', s.case);
        for (const key of ['hook', 'supersedes', 'trigger', 'takeaway']) if (s[key] !== undefined) text = spliceMetadata(text, key, s[key]);
        const {raw, body} = parseFrontmatter(text), heading = body.split('\n').find(l => l.trim());
        text = raw + '\n\n' + heading + '\n\n' + s.body;
        if (Buffer.byteLength(text) > config.caps.topic.failBytes) errors.push(`batch line ${s.line}: rendered lesson exceeds topic byte cap`);
        return [{file: name + '.md', text, similar: s.similar}];
      } catch (error) { errors.push(`batch line ${s.line}: ${error.message}`); return []; }
    });
  };
  const preview = render();
  if (errors.length) throw Error(errors.join('\n'));
  if (dryRun) {
    const totals = new Map();
    const repeated = repeating.map(s => {
      const repeats = (totals.get(s.target) ?? repeatsOf(targetFile(memoryDir, s.target)).length) + 1;
      totals.set(s.target, repeats); return {file: s.target, repeats};
    });
    return {created: preview.map(f => f.file), similar: preview.map(f => f.similar), titles: creating.map(s => s.title), repeated, pages: 0, findings: [], warnings};
  }
  return withMemoryLock(memoryDir, lock => {
    const rendered = render(), snapshot = snapshotPages(memoryDir), created = [], originals = new Map(), repeated = [];
    if (errors.length) throw Error(errors.join('\n'));
    const rollback = () => restoreAll([
      ...pageRestoreActions(memoryDir, snapshot),
      ...created.map(file => () => fs.unlinkSync(path.join(memoryDir, file))),
      ...[...originals].map(([file, bytes]) => () => fs.writeFileSync(path.join(memoryDir, file), bytes)),
    ]);
    let pages, findings, affected;
    try {
      for (const f of rendered) { fs.writeFileSync(path.join(memoryDir, f.file), f.text, {flag: 'wx'}); created.push(f.file); afterWrite(created.length, f.file); }
      for (const s of repeating) {
        const target = path.join(memoryDir, s.target);
        if (!originals.has(s.target)) originals.set(s.target, fs.readFileSync(target));
        const result = appendRepeat({memoryDir, repo, config, lock, id: s.target, today: s.date, note: `${s.cause}: ${s.description}`}, (f, text) => writeMetadata(memoryDir, f, text));
        repeated.push({file: result.file, repeats: result.repeats.length});
        afterWrite(created.length + repeated.length, result.file);
      }
      pages = regenerate({memoryDir, config, lock}, snapshot);
      findings = check({memoryDir, repo, config, today, scope: 'memory'}).findings;
      affected = new Set([...created, ...originals.keys(), ...snapshot.keys(), ...generated(memoryDir).map(f => f.file)]);
    } catch (error) { rollbackError(error, rollback); }
    if (findings.some(f => !f.allowed && f.severity === 'FAIL' && f.check !== 'lesson.enforce' && affected.has(f.file))) {
      try { rollback(); }
      catch (error) { throw new Error(`${findings.map(findingLine).join('\n')}; rollback failed: ${error.message}`, {cause: error}); }
      return {created: [], similar: [], repeated: [], pages: 0, findings, warnings, rolledBack: true};
    }
    return {created, similar: rendered.map(f => f.similar), titles: creating.map(s => s.title), repeated, pages, findings, warnings};
  }, {lock});
}

function targetFile(memoryDir, id) {
  if (!id) throw Error('missing lesson id');
  const files = memoryFiles(memoryDir).filter(f => !f.special && !f.stub);
  const identity = /^#?(\d+)([a-z]*)$/.exec(String(id));
  const normalized = identity ? identity[1].padStart(3, '0') + identity[2] : null;
  const found = files.filter(f => f.file === id || (normalized && lessonIdentity(f.file) === normalized));
  if (!found.length) throw Error('unknown lesson or memory file: ' + id);
  if (found.length > 1) throw Error('ambiguous duplicate identity: ' + found.map(f => f.file).join(', '));
  return {...found[0], data: parseFrontmatter(blockMetadataComments(found[0].text)).data};
}
function repeatsOf(f) {
  const repeats = lessonField(f.data, 'repeats') ?? [];
  if (!Array.isArray(repeats) || repeats.some(e => typeof e !== 'string' || e.length > 200 || !REPEAT_ENTRY.test(e) || !validDate(e.slice(0, 10)))) throw Error('repeat entries must read "YYYY-MM-DD <slip|not-recalled|rule-wrong|new-case|legacy>: note", at most 200 characters');
  return repeats;
}
function enforcement(value, {memoryDir, repo}) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) throw Error('enforcement must be a single line');
  const match = /^(hard-rule|check|hook|lesson-only) (\S.*)$/.exec(value.trim());
  if (!match) throw Error('expected hard-rule, check, hook or lesson-only and a target');
  const [, kind, where] = match;
  const repoFile = () => {
    if (!repo) return false;
    try {
      const target = fs.realpathSync(path.resolve(repo, where)), relative = path.relative(fs.realpathSync(repo), target);
      return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && fs.statSync(target).isFile();
    } catch { return false; }
  };
  if (kind === 'hard-rule' && !memoryFiles(memoryDir).some(f => pathKey(memoryDir, f.file) === pathKey(memoryDir, where) && f.hardRule)) throw Error('link it under ## Hard rules first');
  if (kind === 'hook' && !repoFile()) throw Error('hook path must be an existing file under the repo');
  if (kind === 'check' && !repoFile() && !gateCheckIds(readRequired(path.join(toolDir, 'memory-check.mjs'))).includes(where)) throw Error('check must be an emitted check id or an existing file under the repo');
  if (kind === 'lesson-only' && where.trim().length < 10) throw Error('lesson-only reason must be at least 10 characters');
  return {kind, where};
}
function escalation(f, options) {
  const repeats = repeatsOf(f), value = lessonField(f.data, 'enforced'), id = lessonIdentity(f.file) ?? f.file;
  const unenforced = () => repeats.length >= (options.config.caps.lesson?.failAfterRepeats ?? 4) ? failSentence({count: repeats.length, id}) : repeats.length >= (options.config.caps.lesson?.enforceAfterRepeats ?? 2) ? enforceSentence({count: repeats.length, last: repeats.map(e => e.slice(0, 10)).sort().at(-1), id}) : '';
  if (value === undefined) return unenforced();
  try {
    if (typeof value !== 'string' || !validDate(value.slice(0, 10)) || value[10] !== ' ') return unenforced();
    const {kind, where} = enforcement(value.slice(11), options), date = value.slice(0, 10), count = repeats.filter(e => e.slice(0, 10) > date).length;
    if (!count) return '';
    if (kind === 'lesson-only') return (options.config.caps.lesson?.lessonOnlyReturns ?? true) ? `repeated ${count} times after the lesson-only decision on ${date}; decide again: enforce it or record lesson-only anew` : '';
    return `repeated ${count} times after enforcement on ${date} (${kind} ${where}); the enforcement did not hold: strengthen it, then enforce again`;
  } catch { return unenforced(); }
}
function writeMetadata(memoryDir, f, text) {
  const file = path.join(memoryDir, f.file), bytes = fs.readFileSync(file);
  writeText(file, (bytes.toString('utf8').startsWith('\uFEFF') && !text.startsWith('\uFEFF') ? '\uFEFF' : '') + text);
}
function changeMetadata(options, action, after = result => result) {
  return withMemoryLock(options.memoryDir, lock => {
    const snapshot = snapshotPages(options.memoryDir), originals = new Map();
    const save = (f, text) => { const bytes = fs.readFileSync(path.join(options.memoryDir, f.file)); originals.set(f.file, bytes); writeText(path.join(options.memoryDir, f.file), (bytes.toString('utf8').startsWith('\uFEFF') && !text.startsWith('\uFEFF') ? '\uFEFF' : '') + text); };
    try {
      const result = action(save);
      if (originals.size) regenerate({...options, lock}, snapshot);
      return after(result);
    } catch (error) {
      rollbackError(error, () => {
        const errors = [], attempt = action => { try { action(); } catch (error) { errors.push(error); } };
        attempt(() => restoreAll([...originals].map(([file, bytes]) => () => fs.writeFileSync(path.join(options.memoryDir, file), bytes))));
        attempt(() => restorePages(options.memoryDir, snapshot));
        if (errors.length) { const [first, ...others] = errors; first.message += others.map(e => `; ${e.message}`).join(''); throw first; }
      });
    }
  }, {lock: options.lock});
}
function appendRepeat({memoryDir, repo, id, note, today, config, lock}, save) {
  note = validateRepeatNote(note, today);
  const f = targetFile(memoryDir, id), repeats = [...repeatsOf(f), `${today} ${note}`];
  const text = spliceMetadata(f.text, 'repeats', repeats, {block: true}); save(f, text);
  return {file: f.file, repeats, message: escalation({...f, data: parseFrontmatter(text).data}, {memoryDir, repo, config, lock})};
}
export function recordRepeat({memoryDir, repo, id, note, today = todayDefault(), config = loadConfig(), lock}) {
  checkDate(today);
  if (!id) throw Error('missing lesson id');
  note = validateRepeatNote(note, today);
  const options = {memoryDir, repo, config, lock};
  return changeMetadata(options, save => appendRepeat({...options, id, note, today}, save));
}
export function setEnforced({memoryDir, repo, id, value, today = todayDefault(), config = loadConfig(), lock}) {
  checkDate(today); const options = {memoryDir, repo, config, lock};
  return changeMetadata(options, save => {
    const f = targetFile(memoryDir, id), {kind, where} = enforcement(value, options), enforced = `${today} ${kind} ${where}`;
    save(f, spliceMetadata(f.text, 'enforced', enforced)); return {file: f.file, enforced};
  });
}
export function legacyRepeats({memoryDir}) {
  const items = [], prose = []; let undated = 0, leftAsProse = 0;
  for (const f of memoryFiles(memoryDir).filter(f => !f.special && !f.stub)) {
    const lines = normalizeEol(f.body).split('\n'); let previousDate, fence;
    for (let i = 0; i < lines.length; i++) {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
      if (fence) { if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null; continue; }
      if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) { fence = marker[1]; continue; }
      const lead = /^\*\*(Recurred|Repeated|Happened again|Fired again|Again|Amended|Confirmed)\b([^]*?)\*\*(.*)$/i.exec(lines[i].trim());
      if (!lead) continue;
      let paragraph = lines[i].trim();
      while (i + 1 < lines.length && lines[i + 1].trim() && !/^\s*(?:\*\*|#{1,6}\s|`{3,}|~{3,})/.test(lines[i + 1])) paragraph += '\n' + lines[++i];
      if (/^(Amended|Confirmed)$/i.test(lead[1])) { leftAsProse++; prose.push({file: f.file, note: paragraph.replace(/\s+/g, ' ').slice(0, 200)}); continue; }
      const date = /\d{4}-\d{2}-\d{2}/.exec(lead[0].slice(0, lead[0].lastIndexOf('**') + 2))?.[0] ?? /\d{4}-\d{2}-\d{2}/.exec(paragraph.slice(0, 200))?.[0] ?? (/same day/i.test(lead[2]) ? previousDate : undefined);
      if (date && validDate(date)) previousDate = date;
      const countMatch = /(?<![\w+-])([+-]?\d+|two|three|four|five|six|seven|eight|nine) (?:more )?times\b/i.exec(lead[2]);
      const words = {two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9};
      const numericCount = Math.max(1, /\btwice\b/i.test(lead[2]) ? 2 : countMatch ? Number(words[countMatch[1].toLowerCase()] ?? countMatch[1]) : 1);
      const count = Number.isSafeInteger(numericCount) ? numericCount : countMatch[1];
      const note = paragraph.slice(paragraph.indexOf('**', 2) + 2).replace(/[*`]/g, '').replace(/\s+/g, ' ').trim() || lead[1];
      if (!date || !validDate(date)) undated++;
      items.push({file: f.file, date: date && validDate(date) ? date : null, count, note: note.slice(0, 181 - (typeof count === 'number' && count > 1 && count <= 20 ? ` (${count} of ${count})`.length : 0))});
    }
  }
  const result = {files: new Set(items.map(i => i.file)).size, paragraphs: items.length, entries: items.reduce((n, i) => n + (i.date && typeof i.count === 'number' && i.count <= 20 ? i.count : 0), 0), undated, leftAsProse, items};
  Object.defineProperty(result, 'prose', {value: prose});
  return result;
}
export function convertLegacyRepeats({memoryDir, repo, config = loadConfig(), write = false, lock}) {
  if (!write) return legacyRepeats({memoryDir});
  const options = {memoryDir, repo, config, lock};
  return changeMetadata(options, save => {
    const result = legacyRepeats(options), messages = [];
    for (const file of new Set(result.items.filter(i => i.date && typeof i.count === 'number' && i.count <= 20).map(i => i.file))) {
      try {
        const f = targetFile(memoryDir, file), repeats = [...repeatsOf(f)];
        for (const item of result.items.filter(i => i.file === file && i.date && typeof i.count === 'number' && i.count <= 20)) for (let k = 1; k <= item.count; k++) {
          const entry = `${item.date} legacy: ${item.note}${item.count > 1 ? ` (${k} of ${item.count})` : ''}`;
          if (!repeats.includes(entry)) repeats.push(entry);
        }
        if (repeats.length !== repeatsOf(f).length) save(f, spliceMetadata(f.text, 'repeats', repeats, {block: true}));
        const message = escalation({...f, data: {...f.data, metadata: {...f.data.metadata, repeats}}}, options);
        if (message) messages.push(file + ': ' + message);
      } catch (error) { throw new Error(`${file}: ${error.message}`, {cause: error}); }
    }
    Object.defineProperty(result, 'messages', {value: messages});
    return result;
  });
}

export function newLesson({memoryDir, title, route, kind, takeaway, trigger, case: kindCase, pin = false, lock, today = new Date().toISOString().slice(0, 10)}) {
  if (!validDate(today)) throw new Error('invalid --today date; expected YYYY-MM-DD');
  if (!KINDS.includes(kind)) throw Error(kindError);
  validateTakeaway(takeaway);
  validateTrigger(trigger);
  validateKindCase(kindCase);
  return withMemoryLock(memoryDir, () => {
    const families = routerFamilies(readRequired(path.join(memoryDir, 'MEMORY.md')), memoryDir);
    const selected = [...new Set(String(route ?? '').split(',').map(x => x.trim()).filter(Boolean))];
    if (!selected.length || selected.some(x => !families.has(x))) throw new Error(`route.unknown: ${route ?? '(missing)'}; known families: ${[...families.keys()].join(', ')}`);
    if (typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title)) throw new Error('title must be a nonempty single line');
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).replace(/-$/, '') || 'lesson';
    const [number] = allocate(memoryDir, 1), name = `lesson-${number}-${slug}`;
    const templateFile = path.join(toolDir, 'templates/lesson.md');
    const template = readRequired(fs.existsSync(templateFile) ? templateFile : path.join(toolDir, '../templates/lesson.md'));
    const values = {name, number, kind, title, date: today, route: quote(selected), pin: String(Boolean(pin))};
    let text = template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]);
    if (takeaway !== undefined) text = spliceMetadata(text, 'takeaway', takeaway);
    if (kindCase !== undefined) text = spliceMetadata(text, 'kind_case', kindCase);
    if (trigger !== undefined) text = spliceMetadata(text, 'trigger', trigger);
    const file = path.join(memoryDir, name + '.md');
    fs.writeFileSync(file, text, {flag: 'wx'});
    return file;
  }, {lock});
}
export function classifyLessons({memoryDir, repo, file, write = false, today = todayDefault(), config = loadConfig(), lock}) {
  if (!file) throw Error('classify requires FILE');
  file = path.resolve(file);
  if (file === path.resolve(memoryDir) || insideRepo(memoryDir, file)) throw Error('classify file must not be inside the memory folder');
  let spec;
  const text = readRequired(file);
  try { spec = JSON.parse(text); } catch (e) { throw Error(`${file}: invalid JSON: ${e.message}`); }
  const errors = [], items = [], kinds = Object.fromEntries(KINDS.map(k => [k, 0]));
  if (spec?.version !== 1 || !spec.kinds || typeof spec.kinds !== 'object' || Array.isArray(spec.kinds)) throw Error('classify requires {"version": 1, "kinds": {"<memory file>": "<kind>"}}');
  for (const [name, kind] of Object.entries(spec.kinds)) {
    let f;
    try { f = targetFile(memoryDir, name); if (f.file !== name || !lessonIdentity(name)) throw Error('not a lesson file'); } catch (e) { errors.push(`classify ${name}: ${e.message}`); }
    if (!KINDS.includes(kind)) errors.push(`classify ${name}: kind must be mistake, practice or observation`);
    else { kinds[kind]++; if (f) items.push({f, kind}); }
  }
  if (errors.length) throw Error(errors.join('\n'));
  validateLabels(spec, 'classify', true);
  const unchanged = items.filter(({f, kind}) => lessonField(f.data, 'kind') === kind && (spec.cases?.[f.file] === undefined || lessonField(f.data, 'kind_case') === spec.cases[f.file]) && (spec.takeaways?.[f.file] === undefined || lessonField(f.data, 'takeaway') === spec.takeaways[f.file])).length;
  const takeaways = items.filter(({f}) => spec.takeaways?.[f.file] !== undefined && lessonField(f.data, 'takeaway') !== spec.takeaways[f.file]).length;
  let findings = [];
  if (write) changeMetadata({memoryDir, repo, config, lock}, save => {
    for (const {f, kind} of items) {
      const current = targetFile(memoryDir, f.file);
      try {
        let text = current.text;
        if (lessonField(current.data, 'kind') !== kind) text = spliceMetadata(text, 'kind', kind);
        if (spec.cases?.[f.file] !== undefined && lessonField(current.data, 'kind_case') !== spec.cases[f.file]) text = spliceMetadata(text, 'kind_case', spec.cases[f.file]);
        if (spec.takeaways?.[f.file] !== undefined && lessonField(current.data, 'takeaway') !== spec.takeaways[f.file]) text = spliceMetadata(text, 'takeaway', spec.takeaways[f.file]);
        if (text !== current.text) save(current, text);
      }
      catch (e) { throw Error(`${f.file}: ${e.message}`); }
    }
  }, () => { findings = runCheck({memoryDir, repo, config, today, scope: 'memory'}).findings; });
  return {lessons: items.length, kinds, unchanged, takeaways, findings};
}

const objectMap = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validateLabels(spec, role, validateCases = false) {
  const fail = (row, message) => { throw Error(`labels ${role} row ${JSON.stringify(row)}: ${message}`); };
  if (spec?.version !== 1 || !objectMap(spec.kinds)) fail('<document>', 'labels require version 1 and a kinds map');
  for (const [file, kind] of Object.entries(spec.kinds)) {
    if (!file.trim() || !KINDS.includes(kind)) fail(file, 'labels kinds must be mistake, practice or observation');
  }
  for (const key of ['cases', 'confidence', 'takeaways']) {
    if (spec[key] === undefined) continue;
    if (!objectMap(spec[key])) fail('<document>', 'labels ' + key + ' must be a map');
    for (const [file, value] of Object.entries(spec[key])) {
      if (!Object.hasOwn(spec.kinds, file)) fail(file, 'labels ' + key + ' row has no kind: ' + file);
      if (key === 'takeaways') {
        if (!['fix', 'method', 'know'].includes(value)) fail(file, 'labels takeaways must be fix, method or know');
      } else if (key === 'cases') {
        if (typeof value !== 'string') fail(file, 'labels cases must be strings');
        if (validateCases) try { validateKindCase(value); } catch (error) { fail(file, error.message); }
      } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail(file, 'labels confidence must be a number from 0 to 1');
    }
  }
  if (spec.unscored !== undefined) {
    if (!Array.isArray(spec.unscored)) fail('<document>', 'labels unscored must be an array of row names');
    spec.unscored.forEach((file, i) => {
      if (typeof file !== 'string' || !file.trim()) fail(`unscored[${i}]`, 'labels unscored must be an array of row names');
    });
  }
  return spec;
}
function readLabels(file, role) {
  let spec;
  try { spec = JSON.parse(readRequired(file)); } catch { throw Error(`labels ${role} row "<document>": cannot read labels JSON`); }
  return validateLabels(spec, role);
}
export function scoreLabels(aFile, bFile, referenceFile) {
  const a = readLabels(aFile, 'A'), b = readLabels(bFile, 'B'), reference = referenceFile === undefined ? null : readLabels(referenceFile, 'reference');
  const unscored = new Set(reference?.unscored ?? []);
  const shared = [...new Set([...Object.keys(a.kinds), ...Object.keys(b.kinds)])];
  const disagreements = shared.filter(file => a.kinds[file] !== b.kinds[file]).length;
  const perClass = labels => Object.fromEntries(KINDS.map(kind => [kind, shared.filter(file => labels.kinds[file] === kind).length]));
  const result = {compared: shared.length, disagreements, rate: shared.length ? disagreements / shared.length : 0, counts: {A: perClass(a), B: perClass(b)}};
  result.onlyInA = shared.filter(file => !Object.hasOwn(b.kinds, file));
  result.onlyInB = shared.filter(file => !Object.hasOwn(a.kinds, file));
  const allowed = Math.floor(shared.length * 6 / 40);
  result.kindTest = {allowed, disagreements, pass: shared.length > 0 && !result.onlyInA.length && !result.onlyInB.length && disagreements <= allowed};
  if (reference) {
    const rows = Object.keys(reference.kinds).filter(file => !unscored.has(file));
    const po = rows.filter(file => reference.kinds[file] !== 'mistake');
    if (!po.length) result.referenceWarning = 'reference has no practice or observation rows';
    result.mark = {historical: true, overall: Math.ceil(rows.length * 21 / 25), practiceObservation: Math.ceil(po.length * 7 / 10), disagreements: Math.floor(shared.length * 6 / 40)};
    result.baseline = {correct: rows.length - po.length, total: rows.length, practiceObservation: {correct: 0, total: po.length}};
    for (const [name, labels] of [['A', a], ['B', b]]) {
      const correct = rows.filter(file => labels.kinds[file] === reference.kinds[file]).length;
      const practiceCorrect = po.filter(file => labels.kinds[file] === reference.kinds[file]).length;
      result[name] = {historical: true, correct, total: rows.length, practiceObservation: {correct: practiceCorrect, total: po.length}, verdict: rows.length > 0 && shared.length > 0 && po.length > 0 && !result.onlyInA.length && !result.onlyInB.length && correct >= result.mark.overall && practiceCorrect >= result.mark.practiceObservation && disagreements <= result.mark.disagreements ? 'PASS' : 'FAIL'};
    }
  }
  return result;
}
function printScore(r) {
  console.log(`score: ${r.compared} rows compared; ${r.disagreements} A-B disagreements (${(r.rate * 100).toFixed(2)}%)`);
  for (const name of ['A', 'B']) console.log(`${name}: mistake ${r.counts[name].mistake}, practice ${r.counts[name].practice}, observation ${r.counts[name].observation}`);
  for (const side of ['A', 'B']) if (r['onlyIn' + side].length) console.log(`only in ${side}: ${r['onlyIn' + side].join(', ')}`);
  console.log(`disagreements <= ${r.kindTest.allowed}/${r.compared}`);
  console.log(`kind test: ${r.kindTest.pass ? 'PASS' : 'FAIL'}`);
  if (!r.mark) return;
  if (r.referenceWarning) console.log(r.referenceWarning);
  console.log(`historical mark: overall >= ${r.mark.overall}/${r.A.total} (84%); practice+observation >= ${r.mark.practiceObservation}/${r.A.practiceObservation.total} (70%); disagreements <= ${r.mark.disagreements}/${r.compared} (15%)`);
  console.log(`constant-mistake baseline: ${r.baseline.correct}/${r.baseline.total}; practice+observation 0/${r.baseline.practiceObservation.total}`);
  for (const name of ['A', 'B']) console.log(`${name}: reference ${r[name].correct}/${r[name].total}; practice+observation ${r[name].practiceObservation.correct}/${r[name].practiceObservation.total}; historical ${r[name].verdict}`);
}

export function main(argv = process.argv.slice(2)) {
  try {
    const separator = argv.indexOf('--'), flags = separator < 0 ? argv : argv.slice(0, separator);
    const opts = args(flags.filter(x => x !== '--write'));
    if (separator >= 0) opts._.push(...argv.slice(separator + 1));
    const command = opts._.shift();
    if (command === 'new') {
      const options = {...locations(opts), config: opts.config ? JSON.parse(readRequired(opts.config)) : loadConfig()};
      const similar = similarLessons({corpus: captureCorpus(options), query: opts._.join(' ')});
      const file = newLesson({...options, title: opts._.join(' '), route: opts.route, kind: opts.kind, takeaway: opts.takeaway, case: opts.case, trigger: opts.trigger, pin: opts.pin, today: opts.today});
      printSimilar(similar, {created: true});
      console.log(file);
      return 0;
    }
    const options = {...locations(opts), today: opts.today, config: opts.config ? JSON.parse(readRequired(opts.config)) : loadConfig()};
    if (command === 'classify') {
      if (opts.score !== undefined) {
        if (opts._.length !== 1 || opts.case !== undefined || flags.includes('--write')) throw Error('score requires two label files and cannot write or filter cases');
        const result = scoreLabels(opts.score, opts._[0], opts.reference);
        if (opts.json) console.log(JSON.stringify(result)); else printScore(result);
        return 0;
      }
      if (opts.case !== undefined) {
        if (flags.includes('--write')) throw Error('classify --case cannot write');
        validateKindCase(opts.case);
        const carriers = memoryFiles(options.memoryDir).filter(f => lessonIdentity(f.file) && lessonField(f.data, 'kind_case') === opts.case).map(f => f.file).sort();
        if (opts.json) console.log(JSON.stringify(carriers)); else for (const file of carriers) console.log(file);
        return 0;
      }
      const result = classifyLessons({...options, file: opts._[0], write: flags.includes('--write')});
      if (opts.json) console.log(JSON.stringify(result));
      else {
        console.log(`classify: ${result.lessons} lessons (mistake ${result.kinds.mistake}, practice ${result.kinds.practice}, observation ${result.kinds.observation}); ${result.unchanged} unchanged; takeaways ${result.takeaways}`);
        for (const finding of result.findings) console.log(findingLine(finding));
      }
      return counts(result).FAIL ? 1 : 0;
    }
    if (command === 'batch') {
      const result = batchLessons({...options, file: opts._[0], route: opts.route, dryRun: opts['dry-run']});
      if (opts.json) console.log(JSON.stringify({created: result.created.map((file, i) => ({file, similar: result.similar[i]})), repeated: result.repeated, pages: result.pages, findings: result.findings, rolledBack: Boolean(result.rolledBack)}));
      else {
        for (const warning of result.warnings) console.log('WARN ' + warning);
        for (const [i, similar] of result.similar.entries()) printSimilar(similar, {title: result.titles[i]});
        if (opts['dry-run']) {
          for (const file of result.created) console.log('would create ' + file);
          for (const r of result.repeated) console.log('would repeat #' + (lessonIdentity(r.file) ?? r.file));
        }
        else {
          if (result.rolledBack) console.log('batch: rolled back; nothing written');
          else {
            console.log([`batch: ${result.created.length} lessons from ${opts._[0]}`, ...result.created.map(f => '  ' + f)].join('\n'));
            for (const r of result.repeated) console.log(`  repeat #${lessonIdentity(r.file) ?? r.file}: ${r.repeats} repeats`);
            console.log(`index: ${result.pages} pages`);
          }
          for (const finding of result.findings) console.log(findingLine(finding));
          if (!result.rolledBack) { const count = counts(result); console.log(`gate: ${count.FAIL} FAIL, ${count.WARN} WARN (memory scope)`); }
        }
      }
      return counts(result).FAIL ? 1 : 0;
    } else if (command === 'repeat' && opts['from-legacy']) {
      const result = convertLegacyRepeats({...options, write: flags.includes('--write')});
      if (opts.json) { const {messages, ...summary} = result; console.log(JSON.stringify(summary)); }
      else {
        for (const item of result.items) console.log(`${item.file}: ${item.date ?? 'no date, record by hand'}; ${typeof item.count !== 'number' || item.count > 20 ? `count ${item.count} exceeds 20, record by hand` : `${item.count} entries`}; ${item.note}`);
        for (const item of result.prose) console.log(`${item.file}: left as prose; ${item.note}`);
        console.log(`legacy: ${result.files} files, ${result.paragraphs} paragraphs, ${result.entries} entries; ${result.leftAsProse} left as prose`);
        for (const message of result.messages ?? []) console.log(message);
      }
    } else if (command === 'repeat') {
      const result = recordRepeat({...options, id: opts._.shift(), note: opts._.join(' ')});
      console.log(`repeat: ${result.file}: ${result.repeats.length} repeats (${result.repeats.map(e => e.slice(0, 10)).join(', ')})`);
      if (result.message) console.log(result.message);
    } else if (command === 'enforce') {
      const result = setEnforced({...options, id: opts._.shift(), value: opts._.join(' ')}); console.log(`enforce: ${result.file}: ${result.enforced}`);
    } else throw new Error('expected subcommand: new, batch, repeat, enforce, classify');
    return 0;
  } catch (error) { console.error('memory-lesson: ' + error.message); return 1; }
}
if (isDirect(import.meta.url)) process.exitCode = main();
