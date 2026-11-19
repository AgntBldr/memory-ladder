import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID, createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stateToken, readCurrent, parseBlock, readOverlay, capText, capOutput, listNotes} from './session-core.mjs';
import {localTime, atomicWrite as atomic, porcelainEntries, redact, parseHandover, memoryLocation, loadConfig, parseFrontmatter, inRepoMemory, repoPath, validateConfigPaths, isDirect, mainWorktree, pathKey, memoryFiles, cleanGitEnv} from './lib.mjs';
import {withMemoryLock, LOCK_NAMES} from './memory-lock.mjs';
import {batchLessons, parseBatch, draftLesson, composeDraft, findDraft, checkDraftText} from './memory-lesson.mjs';
import {rotateRoadmap, rotateLog} from './memory-rotate.mjs';
import {checkpoint, publish} from './memory-checkpoint.mjs';
import {runCheck, counts, findingLine} from './memory-check.mjs';
import {isGenerated, lessonField} from './memory-index.mjs';
import {sessionMode, sessionOf, foreignClaims, claimFiles} from './memory-session.mjs';

// Safe to compact means three things and only these three. Every verdict below, the handover skill, the README, the glossary
// entry and the standard Reports line say the same three, and word the third one the same two ways.
export const SAFE_CONDITIONS = ['memory is updated', 'learning is added', 'the roadmap holds the current state'];
export const ROADMAP_FORMS = ['you updated it', 'you name the line that already holds it'];
export const SAFE_MEANING = `Safe to compact means all three hold: ${SAFE_CONDITIONS[0]}; ${SAFE_CONDITIONS[1]} (lessons written, saved as a draft to finish later, or stated as none); ${SAFE_CONDITIONS[2]} (${ROADMAP_FORMS[0]}, or ${ROADMAP_FORMS[1]}). A commit or a push is not one of the three.`;
const draftsText = drafts => drafts ? `; draft lessons to finish: ${drafts}` : '';
export const FULL_SAFE = (learning, roadmap, drafts = 0) => `SAFE TO COMPACT - memory saved; ${learning}; ${roadmap}${draftsText(drafts)}`;
export const QUICK_SAFE = (learning, roadmap, drafts = 0) => `SAFE TO COMPACT (quick) - memory saved; ${learning}; ${roadmap}${draftsText(drafts)}`;
export const SAVE_REFUSED = reason => `SAVE REFUSED - ${String(reason).replace(/\.+$/, '')}. Nothing was written, so compact safety was not checked.`;
export const NEXT = 'Next: new conversation, then `/new-session`.';
const STATE_SAVED_TAIL = 'This is not a safe-to-compact verdict: pass both, or run /handover.';
const LESSONS_FORMS = 'none (<reason, at least 10 characters>) or later (<what happened and the rule you would write, at least 40 characters and 6 words>)';
const ROADMAP_FORMS_TEXT = 'updated (<words copied from a roadmap line>) or nothing new (<words copied from a roadmap line>)';
const bytes = text => Buffer.byteLength(text);
const read = file => fs.readFileSync(file, 'utf8');
const singleLine = text => String(text).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '');
const capped = (text, options) => {
  const logDir = path.join(os.tmpdir(), 'memory-session');
  return capOutput(text, options).replaceAll(logDir, singleLine(logDir));
};
const git = (dir, argv, options = {}) => execFileSync('git', ['--no-optional-locks', '-C', dir, ...argv], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 120000, env: cleanGitEnv(), ...options});
const maybeGit = (dir, argv, {trim = true, ...options} = {}) => { try { const text = git(dir, argv, options); return trim ? text.trim() : text; } catch { return null; } };
const relative = (dir, file) => path.relative(dir, file).replaceAll('\\', '/');
const hasHead = (dir, file) => maybeGit(dir, ['cat-file', '-e', 'HEAD:' + relative(dir, file)]) !== null;
const safe = (text, label) => { if (redact(text) !== text) throw Error(`${label}: secret refused`); };
function checkGate(options) {
  const prior = process.env.GIT_OPTIONAL_LOCKS;
  process.env.GIT_OPTIONAL_LOCKS = '0';
  try { return runCheck(options); }
  finally { if (prior === undefined) delete process.env.GIT_OPTIONAL_LOCKS; else process.env.GIT_OPTIONAL_LOCKS = prior; }
}
function captureDiagnostics(run, diagnostics) {
  const log = console.log, error = console.error;
  console.log = console.error = (...items) => diagnostics.push(redact(items.map(String).join(' ')));
  try { return run(); }
  finally { console.log = log; console.error = error; }
}
function status(repo) {
  let raw;
  try { raw = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {maxBuffer: 16 * 1024 * 1024}); }
  catch (error) { if (error.code === 'ENOBUFS') throw Error('git status output exceeds 16 MiB; reduce untracked files before handover'); throw error; }
  return porcelainEntries(raw, {includeSources: true});
}
// The names an "already written" input lists: the recovery line prints each in a code span, a hand-written input may not. Every
// consumer reads them the same way, and a name is good only when it is a lesson file directly in memory and a regular file.
const unquoteName = entry => /^`([^`]+)`$/.exec(entry)?.[1] ?? entry;
const isLessonName = name => /^lesson-[^/\\`]*\.md$/.test(name);
const isRegularFile = file => { try { return fs.lstatSync(file).isFile(); } catch { return false; } };
function writtenNames(memoryDir, text) {
  const names = text?.split(', ').map(unquoteName);
  return names?.length && new Set(names).size === names.length && names.every(name => isLessonName(name) && isRegularFile(path.join(memoryDir, name))) ? names : [];
}
// The retry that follows lessons a run already wrote. A draft text is never given up for it: the input keeps `later (...)`, and only
// the completed batch is left out of the re-run.
const writtenRetry = (names, later) => later
  ? 'keep lessons: later (...) as it is and re-run without --lessons; the draft text is not saved until a save completes'
  : 'set input lessons: none (already written: ' + names.join(', ') + '); re-run without --lessons';
function pendingLessons(ctx) {
  if (!fs.existsSync(ctx.notesDir)) return [];
  const pushed = !maybeGit(ctx.holder, ['remote']) || maybeGit(ctx.holder, ['merge-base', '--is-ancestor', 'HEAD', '@{upstream}']) !== null;
  for (const name of fs.readdirSync(ctx.notesDir).sort().reverse()) {
    if (!/^\d{6}-\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(name)) continue;
    const file = path.join(ctx.notesDir, name), note = parseHandover(read(file));
    if (!note.valid || note.data.branch !== ctx.branch || note.data.sha !== ctx.sha || (pushed && hasHead(ctx.holder, file))) continue;
    const fields = parseBlock(note.body).fields;
    if (fields.State !== ctx.data.state || fields['Open question'] !== ctx.data.question || fields['Next action'] !== ctx.data.next.map((s, i) => `${i + 1}. ${s}`).join(' ')) continue;
    const names = writtenNames(ctx.memoryDir, fields.Lessons);
    if (names.length) return names;
  }
  return [];
}
// The forms of the lessons input: none (<reason>) and later (<text>). A later text is checked here, as a draft lesson text is
// checked by the lesson tool. Any other string is left to the caller, which knows whether a batch was given.
function lessonsForm(value, quick) {
  const later = /^later \(([^]*)\)$/.exec(value);
  if (later) {
    try { return {form: 'later', text: checkDraftText(later[1])}; }
    catch (error) { throw Error('lessons: ' + error.message + '; e.g. "later (what happened and the rule you would write, in one line)"'); }
  }
  if (/^none \(.{10,}\)$/.test(value)) return {form: 'none', reason: value.slice(6, -1)};
  if (quick) throw Error('lessons must be ' + LESSONS_FORMS + ' in a quick handover; a batch needs a full handover');
  return null;
}
// The same normal form for the quote and for the roadmap lines: lower case, no emphasis marks, one space between words.
const normaliseQuote = text => String(text).toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
function roadmapStatement(value) {
  const match = /^(updated|nothing new) \((.+)\)$/.exec(value);
  if (!match) throw Error('roadmap must be ' + ROADMAP_FORMS_TEXT + ', e.g. "updated (Kit 3.3.10 under way)"');
  if (!normaliseQuote(match[2])) throw Error('roadmap words must be copied from a roadmap line; formatting alone is not a quote');
  return {form: match[1], words: match[2].trim(), text: value};
}
// A quote of 20 characters or more must be inside one roadmap line; a shorter one must be a whole line (its list marker apart),
// so one short word never matches every roadmap.
function roadmapHolds(text, words) {
  const quote = normaliseQuote(words), lines = String(text).split(/\r?\n/);
  return quote.length < 20 ? lines.some(line => normaliseQuote(line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')) === quote) : lines.some(line => normaliseQuote(line).includes(quote));
}
function inputFile(file, quick, memoryDir, steps) {
  const example = 'JSON object, e.g. {"state":"ready","next":["review"]}';
  const closedShape = steps.length ? `closed: ${JSON.stringify(Object.fromEntries(steps.map(step => [step, 'ok'])))} for the overlay's close: steps ${steps.join('; ')}` : 'closed: omit it (the overlay has no close: steps)';
  const shape = key => key === 'closed' ? closedShape : key === 'next' ? 'next requires 1-3 single-line strings, e.g. ["review"] (or "review")' : `${key} must be a string, e.g. "${key === 'state' ? 'ready' : key === 'lessons' ? 'none (no new learning this session)' : key === 'roadmap' ? 'updated (Kit 3.3.10 under way)' : 'none'}"`;
  if (!file) throw Error('missing --in file: ' + example);
  let raw;
  try { raw = read(file).replace(/^\uFEFF/, ''); }
  catch (error) { throw Error(error.message + '; input must be a readable ' + example); }
  try { safe(raw, 'input'); } catch (error) { throw Error(error.message + '; ' + example); }
  let data;
  try { data = JSON.parse(raw); } catch { throw Error('input must be a ' + example); }
  const caps = {state: 240, question: 320, next: 480, waits: 240, risks: 240, constraints: 240, closed: 320, lessons: 320, roadmap: 160};
  if (!data || Array.isArray(data) || typeof data !== 'object') throw Error('input must be a ' + example);
  const originalBytes = bytes(JSON.stringify(data));
  for (const key of ['waits', 'risks', 'constraints']) if (Array.isArray(data[key]) && data[key].every(value => typeof value === 'string')) data[key] = data[key].join('; ');
  if (typeof data.next === 'string') data.next = [data.next];
  let droppedBytes = 0;
  if (typeof data.closed === 'string' && bytes(data.closed) > caps.closed) throw Error(`closed exceeds ${caps.closed} B; ${closedShape}`);
  if (!steps.length && (data.closed == null || typeof data.closed === 'string' || (typeof data.closed === 'object' && !Array.isArray(data.closed) && !Object.keys(data.closed).length))) {
    const beforeDrop = bytes(JSON.stringify(data));
    delete data.closed;
    droppedBytes = beforeDrop - bytes(JSON.stringify(data));
  }
  if (steps.length && typeof data.closed === 'string') {
    const beforeConversion = bytes(JSON.stringify(data));
    const pairs = data.closed.split(/[,;]/).map(pair => /^\s*(.+?)\s*[:=]\s*(ok|failed)\s*$/.exec(pair));
    if (pairs.some(pair => !pair) || new Set(pairs.map(pair => pair[1])).size !== pairs.length) throw Error(closedShape);
    data.closed = Object.fromEntries(pairs.map(pair => [pair[1], pair[2]]));
    droppedBytes = beforeConversion - bytes(JSON.stringify(data));
  }
  if (data.closed !== undefined && (!data.closed || Array.isArray(data.closed) || typeof data.closed !== 'object' || Object.values(data.closed).some(value => !['ok', 'failed'].includes(value)))) throw Error(closedShape);
  for (const step of steps) if (!Object.hasOwn(data.closed || {}, step)) throw Error('closed missing close step: ' + step + '; ' + closedShape);
  if (Object.keys(data.closed || {}).some(step => !steps.includes(step))) throw Error('closed names an unknown close step; ' + closedShape);
  // A printed recovery adds this member after the original input passed its cap.
  const retryBytes = !quick && writtenNames(memoryDir, /^none \(already written: (.+)\)$/.exec(data.lessons || '')?.[1]).length
    ? bytes(JSON.stringify({lessons: data.lessons})) - 1 : 0;
  // Preserve whitespace/escape overhead while charging normalized values to the same caps.
  const wholeCap = quick ? 1184 : 1952;
  if (bytes(raw) - originalBytes + bytes(JSON.stringify(data)) + droppedBytes - retryBytes > wholeCap) throw Error('input exceeds ' + wholeCap + ' B; ' + example);
  for (const [key, value] of Object.entries(data)) {
    if (!Object.hasOwn(caps, key)) throw Error('unknown input field: ' + key + '; keys: ' + Object.keys(caps).join(', ') + '; ' + example);
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (bytes(text) > caps[key]) throw Error(`${key} exceeds ${caps[key]} B; ${shape(key)}`);
    // The words of a roadmap statement are copied from a roadmap line, which may carry its own bold marks.
    if (/SAFE TO COMPACT|[\u0000-\u001f\u007f]/.test(typeof value === 'string' ? value : '') || (text.includes('**') && key !== 'roadmap')) throw Error(`${key}: control, label or verdict text refused; ${shape(key)}`);
    if (!['next', 'closed'].includes(key) && typeof value !== 'string') throw Error(shape(key));
  }
  if (!data.state?.trim()) throw Error('state is required; ' + shape('state'));
  if (data.lessons !== undefined) lessonsForm(data.lessons, quick);
  if (data.roadmap !== undefined) roadmapStatement(data.roadmap);
  if (!Array.isArray(data.next) || data.next.length < 1 || data.next.length > 3 || data.next.some(x => typeof x !== 'string' || !x.trim() || /[\r\n\x00-\x1f]|\*\*|SAFE TO COMPACT/.test(x))) throw Error(shape('next'));
  return {...data, question: data.question?.trim() || 'none', waits: data.waits?.trim() || 'none', risks: data.risks?.trim() || 'none'};
}
const template = '---\nname: current-state\ndescription: "Current task, next action and checkpoint handoff."\nmetadata:\n  type: project\n  state: true\n---\n\n';
export function currentFromNote(note) {
  const parsed = parseHandover(note);
  if (!parsed.valid) throw Error('invalid note frontmatter');
  return currentBlock(parsed.body, parsed.data);
}
function currentBlock(body, {time, sha, mode, branch}) {
  const fields = parseBlock(body).fields;
  const lines = [`## CURRENT`, `**${time.slice(0, 19).replace('T', ' ')} | @${sha} | ${mode}. ${fields.State}**`];
  for (const key of ['Open question', 'Next action', 'Constraints', 'In flight', 'Waits on the user', 'Context']) if (fields[key]) lines.push(`**${key}:** ${fields[key]}`);
  // Kit 3.3.5 E9: the branch is written in the same atomic write as the block, so the start helper can filter by it.
  if (typeof branch === 'string' && branch.trim()) lines.push(`**Branch:** ${singleLine(branch)}`);
  return lines.join('\n') + '\n';
}
export function mergeCurrent(original, block) {
  original = original.replace(/^\uFEFF/, '');
  if (original.includes('\0')) throw Error('CURRENT contains NUL');
  const headings = [...original.matchAll(/^#{1,6}[ \t].*\b(RESUME|CURRENT)\b[^\r\n]*\r?$/gmi)];
  if (headings.length > 1) throw Error('CURRENT whole file has multiple state headings');
  let text = original;
  if (headings.length) {
    const start = headings[0].index, rest = original.slice(start + headings[0][0].length);
    const end = /\r?\n#{1,2}(?:[ \t]|$)/m.exec(rest);
    text = original.slice(0, start) + block + (end ? rest.slice(end.index + (rest[end.index] === '\r' ? 2 : 1)) : '');
  } else text += (text.endsWith('\n') || !text ? '' : '\n') + block;
  if (!/^---\r?\n/.test(text)) text = template + text;
  if (bytes(text) > 4096) throw Error('CURRENT whole file exceeds 4096 B');
  if ((text.match(/^#{1,6}[ \t].*\b(RESUME|CURRENT)\b/gmi) ?? []).length !== 1) throw Error('CURRENT whole file must have one state heading');
  return text;
}
// The note's Lessons field: the files a batch wrote, then a draft as "draft <file>", or the input's own text.
function lessonsNote(ctx, batchFiles, draftFile) {
  const parts = [];
  if (batchFiles) parts.push(batchFiles.join(', '));
  else if (!ctx.later) parts.push(ctx.quick && ctx.data.lessons === undefined ? 'skipped (quick)' : ctx.data.lessons ?? 'pending batch');
  if (draftFile) parts.push('draft ' + draftFile);
  return parts.filter(Boolean).join(', ');
}
function noteBody(ctx, lessons) {
  const {data, branch, repo, dirty, overlay} = ctx;
  const lines = [
    `**Open question:** ${data.question}`, `**State:** ${data.state}`, `**Waits on the user:** ${data.waits}`,
    `**Next action:** ${data.next.map((s, i) => `${i + 1}. ${s}`).join(' ')}`, `**Lessons:** ${lessons}`];
  if (ctx.statement) lines.push(`**Roadmap:** ${singleLine(ctx.statement.text)}`);
  if (data.constraints) lines.push(`**Constraints:** ${data.constraints}`);
  const changes = dirty === null ? ctx.statusUnavailable : `${dirty.length} (${capText(dirty.slice(0, 6).map(x => singleLine(x.file)).join(', ') || 'none', 300)})`;
  lines.push(`**In flight:** uncommitted ${changes}; close ${ctx.close}; risks ${data.risks}`,
    `**Context:** ${singleLine(repo)}; ${singleLine(branch)}; ${overlay.scratch || 'none'}`);
  return lines.join('\n') + '\n';
}
function noteContent(ctx, lessons) {
  const {time, branch, sha, quick} = ctx;
  const body = noteBody(ctx, lessons);
  const text = ['---', `time: ${time}`, `branch: ${JSON.stringify(branch)}`, `sha: ${sha}`, `mode: ${quick ? 'quick' : 'full'}`, '---', body].join('\n');
  safe(text, 'note candidate');
  if (bytes(text) > 3072) throw Error('note candidate exceeds 3072 B');
  return {text, body};
}
function noteText(ctx, lessons) {
  const {text} = noteContent(ctx, lessons);
  if (!parseHandover(text).valid) throw Error('invalid note candidate');
  return text;
}
function replaceFile(ctx) {
  const seq = ctx.replace;
  if (!seq) return null;
  if (!/^\d{6}$/.test(seq)) throw Error('--replace requires a six-digit seq');
  const names = fs.existsSync(ctx.notesDir) ? fs.readdirSync(ctx.notesDir).filter(n => n.startsWith(seq + '-') && /^\d{6}-\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(n)) : [];
  if (names.length !== 1) throw Error('--replace: unknown or ambiguous loose note ' + seq);
  const file = repoPath(ctx.memoryDir, 'handovers/' + names[0], 'note');
  if (hasHead(ctx.holder, file)) throw Error('--replace: note already in HEAD; use a plain run');
  const parsed = parseHandover(read(file));
  if (!parsed.valid || parsed.data.branch !== ctx.branch) throw Error('--replace: note belongs to another branch or is invalid');
  return file;
}
function nextSeq(ctx) {
  let highest = 0;
  if (fs.existsSync(ctx.notesDir)) for (const name of fs.readdirSync(ctx.notesDir)) {
    if (/^\d{6}-\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(name)) highest = Math.max(highest, Number(name.slice(0, 6)));
    if (/^archive-\d{4}-\d{2}\.md$/.test(name)) for (const m of read(repoPath(ctx.memoryDir, 'handovers/' + name, 'archive')).matchAll(/^## (\d{6})-/gm)) highest = Math.max(highest, Number(m[1]));
  }
  if (highest >= 999999) throw Error('note sequence exhausted');
  return String(highest + 1).padStart(6, '0');
}
function dirtyPreflight(ctx) {
  const {repo, config, inRepo, dirty, memoryDir, noRotate} = ctx, touched = new Set();
  const exists = key => !noRotate && fs.existsSync(repoPath(repo, config.caps[key].path, key));
  if (exists('roadmap')) {
    const rotation = rotateRoadmap({repo, config});
    if (rotation.moved) { touched.add(config.caps.roadmap.path); touched.add(config.caps.roadmapHistory.path); }
  }
  if (exists('brainLog')) {
    const rotation = rotateLog({repo, config});
    if (rotation.moved) { touched.add(config.caps.brainLog.path); rotation.destinations.forEach(d => touched.add(d.file)); }
  }
  if (inRepo) {
    const staged = dirty.filter(d => d.code[0] !== ' ' && d.code[0] !== '?');
    if (staged.length) throw Error('staged index: unstage or commit these first: ' + staged.slice(0, 6).map(d => singleLine(d.file)).join(', ') + (staged.length > 6 ? `; ${staged.length - 6} more` : ''));
    const upstream = maybeGit(repo, ['rev-parse', '--verify', '@{upstream}']);
    if (upstream && Number(git(repo, ['rev-list', '--count', '@{upstream}..HEAD']).trim())) throw Error('outgoing project commit: review and push it; to run: git push');
    if (!upstream && git(repo, ['remote']).trim()) throw Error('project upstream missing: configure and push it first');
    touched.add(config.caps.roadmap.path); touched.add(config.caps.brainLog.path);
    const prefix = relative(repo, memoryDir) + '/';
    for (const d of dirty) if (d.file.startsWith(prefix)) {
      const name = d.file.slice(prefix.length);
      const generated = /^INDEX[^/]*\.md$/.test(name) && fs.existsSync(path.join(memoryDir, name)) && isGenerated(read(path.join(memoryDir, name)));
      if (!generated && !/^(?:current-state\.md|lesson-[^/]+\.md|handovers\/.*|\.memory\.lock.*)$/.test(name)) touched.add(d.file);
    }
  }
  const refused = dirty.filter(d => touched.has(d.file));
  // Memory outside the project is refused only when a rotation is due and would write an uncommitted file; inside the project the save
  // would sweep the roadmap and the log into its commit. Either way nothing was written, and the way out is to commit the file.
  if (refused.length) throw Error('commit ' + refused.map(d => singleLine(d.file)).join(', ') + ' first' + (inRepo ? '' : ', or re-run with --no-rotate'));
}
function validateLessons(data, options) {
  if (options.quick && options.lessons) throw Error('quick forbids --lessons; a batch needs a full handover; pass lessons: ' + LESSONS_FORMS + ' or omit it, e.g. {"state":"ready","next":["review"]}');
  if (!options.quick && !options.lessons && !lessonsForm(data.lessons || '', false)) throw Error('full needs --lessons or lessons: ' + LESSONS_FORMS + ', e.g. "none (no new learning this session)"');
}
function validateBatch(file) {
  const raw = read(file); safe(raw, 'batch');
  const sections = parseBatch(raw);
  if (sections.length > 3) throw Error('batch accepts at most 3 sections');
  for (const section of sections.filter(s => s['repeat-of'] === undefined)) for (const label of ['Why:', 'How to apply:']) {
    const pieces = section.body.split('**' + label + '**');
    if (pieces.length !== 2 || !pieces[1].split(/\*\*(?:Why:|How to apply:)\*\*/)[0].trim()) throw Error('batch requires filled **' + label + '**');
  }
  return sections;
}
function validateInput(options, memoryDir, overlay, context) {
  const steps = (/^<.*>$/.test(overlay.close || '') ? '' : overlay.close || '').split(';').map(x => x.trim()).filter(Boolean);
  if (steps.length > 3) throw Error('close supports at most 3 steps');
  const data = inputFile(options.input, options.quick, memoryDir, steps);
  // A stated none or a draft text needs no acknowledgement of lessons an earlier run wrote: both keep what is on disk.
  const later = /^later \(/.test(data.lessons || '');
  const pending = context && !options.quick && (options.lessons || !/^(?:none|later) \(.{10,}\)$/.test(data.lessons || '')) ? pendingLessons({...context, data}) : [];
  if (pending.length) throw Error('lessons already written; ' + writtenRetry(pending, later) + '; if this is a different batch, change state');
  validateLessons(data, options);
  const sections = options.lessons ? validateBatch(options.lessons) : [];
  const closeFailures = options.skipClose ? (steps.length ? steps : ['skipped']) : steps.filter(s => data.closed[s] === 'failed');
  const close = closeFailures.length ? 'FAILED: ' + closeFailures.join('; ') + (options.skipClose ? ' (skipped: ' + singleLine(options.skipClose) + ')' : '') : steps.map(s => s + '=ok').join('; ') || 'none';
  return {data, closeFailures, close, sections};
}
function prepare(options) {
  const repo = path.resolve(options.repo || process.env.CLAUDE_PROJECT_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
  const memoryDir = memoryLocation(repo, options.memoryDir, {env: cleanGitEnv()}).dir;
  const missingMemory = !memoryDir || !fs.existsSync(memoryDir) || !fs.statSync(memoryDir).isDirectory();
  if (missingMemory) {
    const refusal = Error('memory folder missing; run node scripts/memory/memory-init.mjs');
    // Refuse first, then recover a read-only candidate when the input validates.
    try {
      const overlay = Object.fromEntries(Object.entries(readOverlay(repo)).map(([key, value]) => [key, singleLine(value)]));
      const input = validateInput(options, memoryDir, overlay);
      let rawStatus = null, statusUnavailable = 'status unavailable';
      try { rawStatus = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {maxBuffer: 16 * 1024 * 1024}); }
      catch (error) { if (/not a git repository/i.test(String(error.stderr))) statusUnavailable = 'not a git repository'; }
      const sha = maybeGit(repo, ['rev-parse', '--verify', 'HEAD'])?.slice(0, 7) || 'no commit';
      const ctx = {...options, repo, overlay, ...input,
        dirty: rawStatus === null ? null : porcelainEntries(rawStatus, {includeSources: true}),
        statusUnavailable,
        branch: maybeGit(repo, ['branch', '--show-current']) || (sha === 'no commit' ? 'unborn' : 'detached'),
        sha,
        time: localTime(options.now ?? new Date()), mode: options.quick ? 'quick' : 'full'};
      const {body} = noteContent(ctx, options.quick ? 'skipped (quick)' : input.data.lessons || 'pending batch');
      refusal.block = currentBlock(body, ctx);
    } catch (error) { refusal.message += '; ' + error.message; }
    throw refusal;
  }
  const baseline = options.over === undefined ? stateToken(memoryDir) : options.over === 'none' ? null : options.over;
  if (baseline !== null && !/^[a-f0-9]{12}$/.test(baseline)) throw Error('--over requires a 12-hex token or none');
  const configFile = path.join(repo, 'scripts/memory/memory.config.json');
  const config = structuredClone(options.config ?? (fs.existsSync(configFile) ? JSON.parse(read(configFile)) : loadConfig()));
  const overlay = Object.fromEntries(Object.entries(readOverlay(repo)).map(([key, value]) => [key, singleLine(value)]));
  const configRead = JSON.stringify(config);
  for (const [key, group] of [['roadmap', 'roadmap'], ['log', 'brainLog']]) if (overlay[key] && !options.config)
    config.caps[group].path = (key === 'log' ? overlay[key].replace(/,\s*\d+\s+lines?$/, '') : overlay[key].split(/\s*\|\s*section:\s*/)[0]).trim();
  validateConfigPaths(repo, config);
  // What a checkpoint command can be told: the checkpoint reads its own configuration (the project's file, or the default), so a run
  // that used any other (an injected one, or an overlay roadmap or log path) cannot be finished by a printed command.
  const configStands = !options.config && JSON.stringify(config) === configRead;
  const branch = git(repo, ['branch', '--show-current']).trim(), sha = git(repo, ['rev-parse', 'HEAD']).trim().slice(0, 7);
  if (!branch) throw Error('detached HEAD: select a branch first');
  if (overlay['main-only'] === 'yes' && pathKey(mainWorktree(repo, {env: cleanGitEnv()})) !== pathKey(repo)) throw Error('main-only overlay requires the main worktree');
  const push = overlay.push || 'memory';
  if (!['memory', 'project', 'none'].includes(push)) throw Error('invalid overlay push policy');
  const inRepo = inRepoMemory(repo, memoryDir), holder = inRepo ? repo : memoryDir;
  git(holder, ['rev-parse', '--verify', 'HEAD']);
  const dirty = status(repo);
  // Kit 3.3.5 E4/E6: session mode never rotates; --no-rotate skips rotation and its preflight.
  const session = sessionMode(config) === 'session' ? sessionOf(repo) : null;
  dirtyPreflight({repo, config, inRepo, dirty, memoryDir, noRotate: Boolean(options.noRotate || session)});
  const notesDir = repoPath(memoryDir, 'handovers', 'handovers'), currentFile = repoPath(memoryDir, 'current-state.md', 'CURRENT');
  const preflight = {...options, repo, memoryDir, holder, branch, notesDir};
  replaceFile(preflight);
  if (!options.replace) nextSeq(preflight);
  const {data, closeFailures, close, sections} = validateInput(options, memoryDir, overlay, {...preflight, sha});
  const ctx = {...options, repo, memoryDir, config, overlay, branch, sha, data, baseline, inRepo, holder, push, session,
    notesDir, currentFile, configStands, configFile: fs.existsSync(configFile) ? configFile : null,
    time: localTime(options.now ?? new Date()), dirty, closeFailures, close};
  ctx.waiting = !inRepo ? (maybeGit(holder, ['log', '--format=%h', '@{upstream}..HEAD']) || '').split('\n').filter(Boolean) : [];
  ctx.commit = inRepo && push === 'project' && overlay.branch === branch;
  const form = data.lessons === undefined ? null : lessonsForm(data.lessons, options.quick);
  ctx.later = form?.form === 'later' ? form.text : null;
  ctx.statement = data.roadmap === undefined ? null : roadmapStatement(data.roadmap);
  // A quick handover is judged only for what it was told: lessons and roadmap are each given or not.
  ctx.given = {lessons: !options.quick || data.lessons !== undefined, roadmap: ctx.statement !== null};
  if (ctx.later) {
    // The draft is composed now, with no write, so a draft that cannot be made refuses the save before anything is written.
    ctx.draftExisting = findDraft(memoryDir, ctx.later);
    if (!ctx.draftExisting) {
      try { ctx.draftPlan = composeDraft({memoryDir, text: ctx.later, today: ctx.time.slice(0, 10), config}); }
      catch (error) { throw Error('the draft lesson cannot be composed: ' + error.message); }
    }
  }
  ctx.lessons = lessonsNote(ctx, null, ctx.later ? ctx.draftExisting ?? ctx.draftPlan.name + '.md' : null);
  if (options.lessons) {
    ctx.preview = batchLessons({memoryDir, repo, file: options.lessons, config, dryRun: true});
    const existing = memoryFiles(memoryDir).filter(f => /^lesson-.*\.md$/.test(f.file));
    const creating = sections.filter(s => s['repeat-of'] === undefined);
    const slug = name => name.replace(/^lesson-\d+[a-z]*-/, '').replace(/\.md$/, '');
    const matches = ctx.preview.created.map((name, i) => existing.filter(f => slug(f.file) === slug(name) && f.data.description === creating[i].description).map(f => f.file));
    const duplicates = matches.flat();
    if (duplicates.length) {
      const allDuplicate = matches.length === sections.length && matches.every(files => files.length);
      throw Error('lessons already written: ' + duplicates.join(', ') + (allDuplicate ? '; ' + writtenRetry(duplicates, Boolean(ctx.later)) :'; remove the duplicate section(s) from the batch, or use repeat-of, then re-run'));
    }
    ctx.lessons = lessonsNote(ctx, [...ctx.preview.created, ...ctx.preview.repeated.map(r => r.file)], ctx.later ? ctx.draftExisting ?? ctx.draftPlan.name + '.md' : null);
  }
  mergeCurrent(fs.existsSync(ctx.currentFile) ? read(ctx.currentFile) : '', currentFromNote(noteText(ctx, ctx.lessons)));
  ctx.initialFailures = checkGate({memoryDir, repo, config}).findings.filter(f => f.severity === 'FAIL' && !f.allowed).map(findingLine);
  return ctx;
}
// What is on the disk when the run ends decides the verdict, never what this process remembers. The three conditions of safe to
// compact are proved here, once, from the files themselves: this run's note and state block, this run's learning, and the roadmap
// line the run points at. Everything else (the commit, the push, the gate as a whole, the brain log, the close steps) is
// operational: it is reported on its own line and never changes the verdict.
const hashOf = bytes => createHash('sha256').update(bytes).digest('hex');
// A reason or a quote in one line: its own lines joined by "; ", white space made single, cut to a byte count.
const short = (text, max = 100) => capText(String(text).split(/\r?\n/).map(singleLine).filter(Boolean).join('; ').replace(/\s+/g, ' '), max);
function noteOnDisk(ctx) {
  const want = Buffer.from(ctx.note);
  let onDisk = null;
  try { onDisk = fs.readFileSync(ctx.noteFile); } catch (error) { if (error.code !== 'ENOENT') return false; }
  if (onDisk) return onDisk.equals(want);
  // This run's own checkpoint may have moved the note to its month archive, which keeps the same bytes under "## <name>".
  let archive;
  try { archive = fs.readFileSync(path.join(ctx.notesDir, `archive-${ctx.time.slice(0, 7)}.md`)); } catch { return false; }
  const marker = Buffer.from(`## ${path.basename(ctx.noteFile)}\n`), expected = Buffer.concat([marker, want, Buffer.from('\n\n')]), at = archive.indexOf(marker);
  return at >= 0 && (!at || archive[at - 1] === 10) && archive.subarray(at, at + expected.length).equals(expected);
}
const stampMs = stamp => Date.parse(stamp.time.replace(' ', 'T'));
function stateHolds(ctx) {
  const current = readCurrent(ctx.memoryDir), want = currentFromNote(ctx.note);
  if (current.block === want) return true;
  // Another session saved after this one: its block carries a later stamp and its note is on disk. Both notes are kept.
  const own = parseBlock(want).stamp;
  if (!current.stamp || !own || !(stampMs(current.stamp) > stampMs(own))) return false;
  try {
    for (const name of fs.readdirSync(ctx.notesDir).filter(n => /^\d{6}-\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(n)).sort().reverse()) {
      try { if (currentFromNote(read(path.join(ctx.notesDir, name))) === current.block) return true; } catch {}
    }
  } catch {}
  return false;
}
function logCheck(ctx) {
  const name = ctx.config.caps.brainLog.path;
  let file;
  try { file = repoPath(ctx.repo, name, 'brainLog'); } catch { return {text: 'log no brain'}; }
  if (!fs.existsSync(file)) return {text: 'log no brain'};
  // The log is not one of the three conditions: a log that cannot be read is an operational item, never a refusal and never a cause.
  let dates, today;
  try { dates = [...read(file).matchAll(/^## \[(\d{4}-\d{2}-\d{2})\]/gm)].map(m => m[1]); today = [ctx.time.slice(0, 10), (ctx.now ?? new Date()).toISOString().slice(0, 10)]; }
  catch (error) { return {text: 'log NOT read', failure: `the brain log could not be read (${short(redact(String(error.message)), 120)})`}; }
  if (!dates.length) return {text: 'log skipped (no dated heading)'};
  return dates.some(d => today.includes(d)) ? {text: 'log current'} : {text: 'log NOT current', failure: `log not updated today (${name})`};
}
// What this save left uncommitted is read from the memory repository itself, never from what this process remembers: the files of
// the save (the note, the state block, the lessons and the draft it wrote, and any file the run attempted to write) that git still
// shows as new or changed. A batch that stopped part way (its rollback may have failed) names no lesson, so a lesson file whose
// content differs from what it held before the batch counts too, unless another session claimed it; that needs the content hashes
// taken before the batch, and without them the remainder is reported as unknown.
const SAVE_FILE = /^(?:current-state\.md|lesson-[^/]+\.md|handovers\/\d{6}-[^/]+\.md)$/;
function memoryStatus(ctx) {
  const folder = ctx.inRepo ? relative(ctx.repo, ctx.memoryDir) : '.', prefix = ctx.inRepo ? folder + '/' : '';
  const raw = git(ctx.holder, ['status', '--porcelain', '-z', '--untracked-files=all', '--', folder], {maxBuffer: 16 * 1024 * 1024});
  return porcelainEntries(raw).filter(d => d.file.startsWith(prefix)).map(d => ({code: d.code, file: d.file.slice(prefix.length)})).filter(d => SAVE_FILE.test(d.file));
}
// The content of every lesson file directly in memory: what a batch may touch.
function lessonHashes(memoryDir) {
  const hashes = new Map();
  for (const name of fs.readdirSync(memoryDir)) {
    const file = path.join(memoryDir, name);
    if (/^lesson-[^/\\]*\.md$/.test(name) && fs.lstatSync(file).isFile()) hashes.set(name, hashOf(fs.readFileSync(file)));
  }
  return hashes;
}
const saveFiles = ctx => [...new Set([...(ctx.noteFile ? [relative(ctx.memoryDir, ctx.noteFile)] : []), ...(ctx.currentWritten ? ['current-state.md'] : []), ...(ctx.created ?? []), ...(ctx.draftFile ? [ctx.draftFile] : [])])];
function uncommittedFiles(ctx, options) {
  const now = memoryStatus(ctx), known = new Set([...saveFiles(ctx), ...(ctx.attempts ?? [])]), before = ctx.lessonBefore;
  // The state block is this save's only while the file still holds this run's block: a later save by another session replaced it, and
  // what that session left uncommitted is its own.
  if (known.has('current-state.md') && ctx.note && readCurrent(ctx.memoryDir).block !== currentFromNote(ctx.note)) known.delete('current-state.md');
  const partial = Boolean(options.lessons) && (!ctx.batch || ctx.batch.rolledBack);
  if (partial && !before) return {files: now.filter(d => known.has(d.file)).map(d => d.file), unknown: true};
  const foreign = partial && ctx.session ? new Set(foreignClaims(ctx.memoryDir, ctx.session.id).keys()) : new Set();
  const changed = name => { try { return before.get(name) !== hashOf(fs.readFileSync(path.join(ctx.memoryDir, name))); } catch { return true; } };
  return {files: now.filter(d => known.has(d.file) || (partial && d.file.startsWith('lesson-') && !foreign.has(d.file) && changed(d.file))).map(d => d.file), unknown: false};
}
// Phase 5. Reads the disk; writes nothing.
function prove(ctx, options, state) {
  const causes = [], pieces = {learning: [], roadmap: null}, full = !ctx.quick;
  const learningGiven = full || ctx.given.lessons, roadmapGiven = full || ctx.given.roadmap;
  // Memory: the note, then the state block.
  if (!ctx.noteFile || !ctx.written) causes.push(`memory not saved: the run stopped before the note (${short(state.error?.message ?? 'no note was written')})`);
  else if (!noteOnDisk(ctx)) causes.push(`memory not saved: note ${relative(ctx.memoryDir, ctx.noteFile)} is not on disk as written`);
  else if (!ctx.currentPending && !stateHolds(ctx)) causes.push("memory not saved: current-state.md does not hold this run's state");
  // Learning: what this run's batch wrote, the retry form, the draft, and the rule for every lesson file.
  let drafts = 0;
  if (learningGiven) {
    if (options.lessons) {
      if (!ctx.batch || ctx.batch.rolledBack) causes.push(`learning: lesson batch not written (${short(state.batchError ?? state.error?.message ?? 'no batch result')})`);
      else {
        for (const {file, sha256} of ctx.batch.expected?.created ?? []) {
          let ok = false;
          try { ok = hashOf(fs.readFileSync(path.join(ctx.memoryDir, file))) === sha256; } catch {}
          if (!ok) causes.push(`learning: not on disk as written: ${file}`);
        }
        for (const {file, entry} of ctx.batch.expected?.repeated ?? []) {
          let ok = false;
          try { ok = (lessonField(parseFrontmatter(read(path.join(ctx.memoryDir, file))).data, 'repeats') ?? []).includes(entry); } catch {}
          if (!ok) causes.push(`learning: not on disk as written: ${file}`);
        }
        if (ctx.batch.created.length) pieces.learning.push(`learning added (${ctx.batch.created.length} lessons)`);
        if (ctx.batch.repeated.length) pieces.learning.push('repeats recorded');
      }
    }
    const already = options.lessons ? null : /^none \(already written: (.+)\)$/.exec(ctx.data.lessons ?? '');
    if (already) {
      for (const entry of already[1].split(', ')) {
        const name = unquoteName(entry);
        if (!isLessonName(name)) causes.push(`learning: already written names something that is not a lesson file: ${short(entry, 60)}`);
        else if (!isRegularFile(path.join(ctx.memoryDir, name))) causes.push(`learning: not on disk as written: ${name}`);
      }
      pieces.learning.push(`lessons already written (${short(already[1], 80)})`);
    } else if (!options.lessons && !ctx.later && ctx.data.lessons !== undefined) pieces.learning.push(`no learning stated (${short(ctx.data.lessons.replace(/^none \(|\)$/g, ''), 80)})`);
    if (ctx.later) {
      const file = findDraft(ctx.memoryDir, ctx.later);
      if (!file) causes.push(`learning: draft not on disk: ${ctx.draftFile ?? (ctx.draftPlan ? ctx.draftPlan.name + '.md' : 'no file was written')}`);
      else pieces.learning.push(`lesson saved as a draft (${file})`);
    }
    // No lesson file may be empty or unfilled, whoever wrote it and whenever: each is a cause on every save until someone acts on it.
    try {
      const findings = checkGate({memoryDir: ctx.memoryDir, repo: ctx.repo, config: ctx.config, scope: 'memory'}).findings;
      let foreign = new Set();
      if (ctx.session) foreign = new Set(foreignClaims(ctx.memoryDir, ctx.session.id).keys());
      const bad = new Set(findings.filter(f => f.severity === 'FAIL' && !f.allowed && /^lesson-[^/\\]*\.md$/.test(f.file) && ['lesson.unfilled', 'lesson.unfilled-body', 'lesson.draft-text', 'desc.missing'].includes(f.check) && !foreign.has(f.file)).map(f => f.file));
      for (const file of [...bad].sort()) causes.push(`learning: ${file} is not a finished lesson or a draft with its text`);
      drafts = findings.filter(f => f.check === 'lesson.draft').length;
    } catch (error) { causes.push(`learning: the lesson files could not be checked (${short(error.message)})`); }
  }
  if (!pieces.learning.length) pieces.learning.push('no learning stated');
  // The roadmap: the quoted words are read once, here, from the file as it is now.
  let roadmapFound = false;
  if (roadmapGiven) {
    const name = ctx.config.caps.roadmap.path;
    if (!ctx.statement) causes.push(`roadmap: record this run's state in ${name}, then pass roadmap: updated (<words of the line>)`);
    else {
      let text = null;
      try { text = fs.readFileSync(repoPath(ctx.repo, name, 'roadmap'), 'utf8'); } catch {}
      if (text === null || !text.trim()) causes.push(`roadmap: no file at ${name}`);
      else if (!roadmapHolds(text, ctx.statement.words)) causes.push(`roadmap: "${short(ctx.statement.words, 80)}" is not on a line of ${name}; write the line, or pass words that are there`);
      else { roadmapFound = true; pieces.roadmap = `roadmap ${ctx.statement.form === 'updated' ? 'updated' : 'already holds it'} ("${short(ctx.statement.words, 80)}")`; }
    }
  }
  const log = full ? logCheck(ctx) : null;
  return {causes, learning: pieces.learning.join(', '), roadmap: pieces.roadmap ?? 'roadmap not stated', drafts, log,
    checksText: full ? `roadmap ${roadmapFound ? 'current' : 'NOT current'}, ${log.text}` : roadmapGiven ? `roadmap ${roadmapFound ? 'current' : 'NOT current'}` : 'skipped'};
}
function verify(ctx) {
  // Kit 3.3.5 E8 (both modes): verify the SHA the checkpoint saved and its verified publication on the
  // actual remote, never a later HEAD or a cached upstream ref: another session may commit after this save.
  const saved = /^[0-9a-f]{40,64}$/.test(ctx.result?.sha ?? '') ? ctx.result.sha : 'HEAD';
  const failures = [];
  if (ctx.noteFile) {
    const note = maybeGit(ctx.holder, ['show', saved + ':' + relative(ctx.holder, ctx.noteFile)]);
    // Compare raw blobs, never CURRENT, status or a marker in the note.
    if (note === null || !git(ctx.holder, ['show', saved + ':' + relative(ctx.holder, ctx.noteFile)], {encoding: null}).equals(Buffer.from(ctx.note))) failures.push('own note not byte-identical in HEAD');
  }
  for (const file of [...ctx.created, ...(ctx.draftFile ? [ctx.draftFile] : [])]) if (maybeGit(ctx.holder, ['cat-file', '-e', saved + ':' + relative(ctx.holder, path.join(ctx.memoryDir, file))]) === null) failures.push('lesson missing in HEAD: ' + file);
  const committed = failures.length === 0;
  const remote = git(ctx.holder, ['remote']).trim();
  let pushed = !remote;
  if (remote) pushed = ctx.result?.publication?.verified === true && ctx.result.publication.sha === saved;
  if (!pushed || ctx.push === 'none') failures.push('HEAD not pushed' + (ctx.push === 'none' ? ' (push: none)' : ''));
  return {failures, committed, pushed: pushed && ctx.push !== 'none', local: !remote};
}
// A path for sh (a POSIX shell, Git Bash on Windows): single quotes, inside which nothing expands. A path that holds a single quote
// or a control character cannot be quoted that way, and no command is printed for it.
export const shq = text =>/['\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(text) ? null : "'" + text + "'";
const CHECKPOINT_TOOL = fileURLToPath(new URL('./memory-checkpoint.mjs', import.meta.url));
const BY_HAND = {
  quote: 'a path holds a quote or a line break, so no command is printed',
  config: 'this run used settings a checkpoint command cannot be given (a roadmap or log path from the project overlay, or a configuration passed in by the caller)',
  commits: 'your project commits memory by hand',
  pushes: 'your project pushes memory by hand',
  off: 'push is off (push: none), so memory stays on this disk until you push it',
  long: 'the command is too long to print safely',
  callerConfig: 'this run was given its configuration by the caller, which a command cannot be given',
};
// The most the commands of one finish plan, or the re-run command, may come to, in UTF-8 bytes (the output cap counts bytes, and a path
// of 1100 CJK characters is 3300 of them). A longer one could be cut by the output cap, and a cut command is a different command.
const MAX_COMMAND = 1500;
// How to finish a save the run could not finish: the commands, or why it is done by hand. A command is printed only when it is the
// one the run would have run: the same memory and project folders, configuration, rotation, mode, commit and push policy. In a project
// that holds its memory the checkpoint only commits, and only where the policy lets this tool commit (with --commit); the push is a
// second step. Otherwise the finish is by hand and says why, with the files and the memory folder.
// Steps that together come to more than MAX_COMMAND bytes are not printed either: the finish is by hand.
function finishPlan(ctx, options, notCommitted, listed) {
  const plan = commandsToFinish(ctx, options, notCommitted, listed);
  return plan.steps.reduce((sum, step) => sum + bytes(step), 0) > MAX_COMMAND ? {steps: [], byHand: {reason: BY_HAND.long, files: listed.length ? listed : saveFiles(ctx)}} : plan;
}
function commandsToFinish(ctx, options, notCommitted, listed) {
  const remote = (maybeGit(ctx.holder, ['remote']) ?? '').trim(), pushOff = ctx.push === 'none' || !remote;
  const dir = ctx.inRepo ? ctx.repo : ctx.memoryDir;
  const byHand = reason => ({steps: [], byHand: {reason, files: listed.length ? listed : saveFiles(ctx)}});
  if (!notCommitted) {
    if (ctx.push === 'none') return byHand(BY_HAND.off);
    if (ctx.inRepo && !ctx.commit) return byHand(BY_HAND.pushes);
    const target = shq(dir);
    return target ? {steps: ['git -C ' + target + ' push']} : byHand(BY_HAND.quote);
  }
  if (ctx.inRepo && !ctx.commit) return byHand(BY_HAND.commits);
  if (!ctx.configStands) return byHand(BY_HAND.config);
  // A session save lists its files itself: what the run wrote, and any file it set out to write that the disk shows uncommitted.
  const files = ctx.session ? [...new Set([...saveFiles(ctx), ...listed])] : [];
  const quoted = [CHECKPOINT_TOOL, ctx.repo, ctx.memoryDir, ctx.configFile ?? '', ...files].map(shq);
  if (quoted.includes(null)) return byHand(BY_HAND.quote);
  const [tool, repo, memory, config, ...names] = quoted;
  const args = ['node', tool, '--repo', repo, '--memory-dir', memory];
  if (ctx.configFile) args.push('--config', config);
  if (options.noRotate) args.push('--no-rotate');
  if (ctx.session) args.push('--session', '--files', ...names);
  if (ctx.commit) args.push('--commit');
  if (pushOff) args.push('--no-push');
  const steps = [args.join(' ')];
  if (ctx.commit && !pushOff) steps.push('git -C ' + repo + ' push');
  return {steps};
}
// The operational failures, each with what it puts at risk. They never change the verdict, and never remove a cause.
// `disk` is what the memory repository shows at the end: {files, unknown} (what this save left uncommitted) or {error}.
function operationalItems(ctx, options, state, pub, proof, disk) {
  const items = [];
  let plan = {steps: []};
  const first = state.error ? 'the run stopped before the checkpoint: ' + state.error.message : state.p4 ?? pub.failures[0] ?? (ctx.gateFailures?.length ? ctx.gateFailures[0] : null);
  // What is uncommitted is read from the disk. The run's own record stands in only when the disk cannot be read, and then says so.
  // A run that wrote nothing and left nothing uncommitted has nothing to report; a cause that stopped the run does not hide it.
  const wroteHere = Boolean(ctx.written || ctx.created?.length || ctx.draftWritten), files = disk.files ?? [];
  const notCommitted = files.length > 0 || (wroteHere && !pub.committed);
  if (disk.error) items.push(`the memory status could not be read (${disk.error}); what is uncommitted is not known`);
  if (ctx.snapshotError) items.push(`the lesson files could not be read before the batch (${ctx.snapshotError})${disk.unknown ? '; what the batch left uncommitted is not known' : ''}`);
  if (!wroteHere && !notCommitted) plan = {steps: []};
  else if (notCommitted) { items.unshift(`memory NOT committed (${short(first ?? 'the checkpoint did not commit', 180)}): an overwrite by another session could not be undone`); plan = finishPlan(ctx, options, true, files); }
  else if (!pub.pushed) { items.unshift(`memory committed, NOT pushed (${short(first ?? 'publication not verified', 180)}): it exists on this disk only`); plan = finishPlan(ctx, options, false, files); }
  else if (state.p4) items.unshift(`the checkpoint reported a failure after the commit (${short(state.p4, 120)})`);
  if (!state.error) {
    if (pub.committed && ctx.gateFailures?.length) items.push(`gate FAIL (${short(ctx.gateFailures[0], 120)})`);
    if (ctx.gateFailures === undefined && !state.p4) items.push('checkpoint gate not verified');
  }
  for (const step of ctx.closeFailures) items.push(`close FAILED: ${step}`);
  if (proof.log?.failure) items.push(proof.log.failure);
  return {items, ...plan};
}
function backtickRun(text, minimum = 1) {
  return '`'.repeat(Math.max(minimum, ...[...text.matchAll(/`+/g)].map(m => m[0].length + 1)));
}
function codeSpan(text) {
  const fence = backtickRun(text), pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return fence + pad + text + pad + fence;
}
// The last line of the report: a safe verdict, a verdict that names what is missing, or (quick mode) a saved state that says
// what it did not check. `failures` are the causes; a SAFE verdict needs none.
function verdictOf(ctx, failures, checks) {
  const learning = capText(checks.learning ?? (ctx.batch ? ctx.batch.created.length ? 'learning added (' + ctx.batch.created.length + ' lessons)' : 'repeats recorded' : 'learning: ' + ctx.lessons), 160);
  const roadmap = capText(checks.verdict ?? 'roadmap not stated', 140), given = ctx.given ?? {lessons: false, roadmap: false};
  if (failures.length) return 'NOT SAFE TO COMPACT - ' + failures.slice(0, 3).map(x => capText(x.replace(/[\r\n]+/g, ' '), 150)).join('; ');
  if (ctx.quick && !(given.lessons && given.roadmap)) {
    const holds = [given.lessons ? learning : '', given.roadmap ? roadmap : ''].filter(Boolean), missing = [given.lessons ? '' : 'learning', given.roadmap ? '' : 'roadmap'].filter(Boolean);
    return 'STATE SAVED (quick) - memory saved; ' + holds.map(x => x + '; ').join('') + 'not checked: ' + missing.join(' and ') + '. This is not a safe-to-compact verdict: pass both, or run /handover.';
  }
  return (ctx.quick ? QUICK_SAFE : FULL_SAFE)(learning, roadmap, ctx.draftCount ?? 0);
}
function report(ctx, failures, checks, publication, maxOutput = Infinity) {
  failures = failures.map(singleLine);
  const operational = (ctx.operational ?? []).map(singleLine);
  const mode = ctx.quick ? 'quick' : 'full', memSha = maybeGit(ctx.holder, ['rev-parse', 'HEAD'])?.slice(0, 7) || 'unknown';
  const generated = new Set([...(ctx.config.caps.roadmapOverview.enabled === false ? [] : [ctx.config.caps.roadmapOverview.path]), ctx.config.caps.brainIndex.path, ctx.config.caps.brainIndex.allPath]);
  let open;
  try { open = status(ctx.repo); }
  catch (error) {
    // A status that cannot be read costs the report its open-files line, nothing more: the failure is an operational item on every
    // path (a cause, another item or neither), and the line shows the status the run began with.
    const item = singleLine(`the report could not read the project status (${short(redact(String(error.message)), 150)})`);
    if (!operational.includes(item)) operational.push(item);
    if (ctx.operational && !ctx.operational.includes(item)) ctx.operational.push(item);
    open = ctx.dirty ?? [];
  }
  const names = open.slice(0, 6).map(d => codeSpan(singleLine(d.file)) + (generated.has(d.file) ? ' [generated]' : '')).join(', ');
  const gate = ctx.gate ? `${ctx.gate.FAIL} FAIL, ${ctx.gate.WARN} WARN` : 'not run';
  const committed = publication.local ? 'committed locally (no remote), gate green' : 'committed and pushed, gate green';
  const verdict = verdictOf(ctx, failures, checks);
  const next = failures.length ? (ctx.rerun === 'by hand' ? 'Next: fix the cause named in the verdict, then re-run by hand (the re-run by hand line below); if there is none, run /handover again.' : 'Next: fix the cause named in the verdict, then run the re-run line below; if there is none, run /handover again.')
    : operational.length ? (ctx.finish === 'by hand' ? 'Next: finish the items above by hand (the finish by hand line below); do not run /handover again for them' : `Next: finish the items above (to run: ${ctx.finish ? 'the finish line below' : 'the steps named above'}); do not run /handover again for them`)
    : verdict.startsWith('STATE SAVED') ? 'Next: before compacting, run /handover (full) or pass both lessons and roadmap.' : NEXT;
  const notFinished = operational.length ? 'NOT FINISHED - ' + operational.slice(0, 3).map(x => capText(x.replace(/[\r\n]+/g, ' '), 260)).join('; ') + (operational.length > 3 ? `; +${operational.length - 3} more` : '') : null;
  const lines = [
    `${codeSpan(capText(singleLine(ctx.repo), 180))} | ${capText(ctx.branch, 60)} @ ${ctx.sha} | ${capText(ctx.command || 'to run: git status', 210)}`,
    `handover ${mode} ${ctx.time.slice(11, 16)} token:${ctx.digest || ctx.baseline || 'none'} note:${ctx.seq || 'none'} | Q: ${[...ctx.data.question].slice(0, 80).join('')}`,
    `lessons: ${capText(ctx.quick && !ctx.given?.lessons ? 'skipped' : ctx.lessons, 240)}  checks: ${checks.text}`,
    `close: ${capText(ctx.close, 100)}  gate: ${gate}${ctx.gateFailures?.length ? ' | FAIL: ' + capText(ctx.gateFailures.slice(0, 2).join('; '), 180) : ''}`,
    publication.pushed ? `memory ${memSha} ${publication.local ? 'local only, no remote' : 'pushed'}${ctx.waiting.length ? '; included waiting ' + ctx.waiting.slice(0, 3).join(', ') : ''}` : (ctx.written ? 'saved locally, NOT pushed: ' : 'note not written: ') + capText(ctx.pubReason || failures[0] || operational[0] || 'publication not verified', 100),
    `open: ${open.length} uncommitted project files (they do not affect the verdict; ${capText(names || 'none', 180)})`, ...(notFinished ? [notFinished] : []), verdict, next];
  // Kit 3.3.5 E4: another live session holds current-state.md, so only this session's note was written.
  if (ctx.currentPending) lines.splice(1, 0, `current-state.md is pending in ${ctx.currentPending.checkout} (${ctx.currentPending.branch}); your note is ${relative(ctx.memoryDir, ctx.noteFile)}`);
  const tailCount = notFinished ? 3 : 2;
  lines.forEach((line, i) => { lines[i] = (i < lines.length - tailCount ? '- ' : '') + singleLine(line); });
  // Reserve the bytes of the last two or three lines (NOT FINISHED, the verdict, the next step) even when paths or diagnostics are long.
  const baselineLine = ctx.over === undefined ? '\ntoken baseline: run began (no --over supplied).\n' : '';
  const tail = lines.slice(-tailCount).join('\n\n'), head = capText(lines.slice(0, -tailCount).join('\n'), 1535 - bytes(tail) - bytes(baselineLine) - 2);
  let output = capped(head + '\n\n' + tail + '\n', {max: 1536, label: 'handover-report'});
  if (ctx.warning && ctx.written) {
    const warning = `- warning: another session handed over at ${ctx.otherTime || 'unknown'}; both notes kept\n`;
    const text = ctx.replaced.replace(/(?:\r?\n)+$/, ''), fence = backtickRun(text, 3);
    const framing = '\n' + fence + 'text\n\n' + fence + '\n';
    const allowance = Math.min(2048, maxOutput - bytes(output) - bytes(baselineLine));
    const block = allowance >= bytes(warning + framing) ? '\n' + fence + 'text\n' + capText(text, allowance - bytes(warning + framing)) + '\n' + fence + '\n' : '';
    if (block) {
      const split = output.indexOf('\n', output.indexOf('\n') + 1);
      output = output.slice(0, split + 1) + warning + output.slice(split + 1) + block;
    }
  }
  output += baselineLine;
  return redact(output);
}
// Dependencies permit deterministic failure/crash tests; the CLI exposes no injection flags.
export function runHandover(options = {}, dependencies = {}) {
  const emit = dependencies.output ?? (text => process.stdout.write(text));
  const diagnostics = [];
  let ctx;
  try { ctx = prepare(options); }
  catch (error) {
    // Nothing was written: a refusal says so and gives no verdict about compacting.
    const failure = redact(String(error.message)), block = error.block ? error.block.split('\n').map(singleLine).join('\n') : '';
    emit(capped(capText(SAVE_REFUSED(failure.split('\n').map(singleLine).join('; ')) + '\n' + block, 4000), {label: 'handover-refused'}));
    return {code: 1};
  }
  if (options.check) {
    emit(capped(capText(`check: validate and preflight passed; no writes\nplan: lessons ${singleLine(ctx.lessons)}; note then CURRENT under lock; checkpoint ${ctx.inRepo ? ctx.commit ? 'commit and push project' : 'print staging command' : 'commit memory'}; verify own note and lessons in HEAD and pushed; ${ctx.quick ? 'check only what was stated' : 'read back lessons, roadmap and log'}\n`, 1536), {max: 1536, label: 'handover-check'}));
    return {code: 0};
  }
  ctx.created = []; ctx.draftFile = null; ctx.operational = []; ctx.attempts = new Set();
  // The content of every lesson file before the batch, so a batch that stops part way can be told from what was already there.
  if (options.lessons) { try { ctx.lessonBefore = lessonHashes(ctx.memoryDir); } catch (error) { ctx.snapshotError = short(redact(String(error.message)), 120); } }
  const state = {phase: 1, error: null, p4: null, batchError: null, batchThrew: false};
  // Phases 1 to 3 write: the lesson batch and the draft, the note, the state block. A throw stops the later writes, never the proof.
  try {
    if (options.lessons) {
      try {
        ctx.batch = captureDiagnostics(() => (dependencies.batchLessons ?? batchLessons)({memoryDir: ctx.memoryDir, repo: ctx.repo, file: options.lessons, config: ctx.config}), diagnostics);
      } catch (error) { state.batchThrew = true; state.batchError = redact(String(error.message)); throw error; }
      if (ctx.batch.rolledBack) { ctx.lessons = 'none (batch rolled back)'; state.batchError = 'lesson batch rolled back: ' + ctx.batch.findings.map(findingLine).join('; '); throw Error(state.batchError); }
      ctx.created = [...ctx.batch.created, ...ctx.batch.repeated.map(r => r.file)];
      ctx.lessons = lessonsNote(ctx, ctx.created, null);
    }
    if (ctx.later) {
      ctx.attempts.add(ctx.draftExisting ?? ctx.draftPlan.name + '.md');
      ctx.draft = captureDiagnostics(() => (dependencies.draftLesson ?? draftLesson)({memoryDir: ctx.memoryDir, repo: ctx.repo, config: ctx.config, text: ctx.later, today: ctx.time.slice(0, 10)}), diagnostics);
      ctx.draftFile = ctx.draft.file; ctx.draftWritten = ctx.draft.created;
      ctx.lessons = lessonsNote(ctx, options.lessons ? ctx.created : null, ctx.draftFile);
    }
    state.phase = 2;
    (dependencies.beforeLock ?? (() => {}))(ctx);
    withMemoryLock(ctx.memoryDir, lock => {
      const current = readCurrent(ctx.memoryDir);
      ctx.warning = current.token !== ctx.baseline;
      if (ctx.warning) {
        ctx.replaced = current.block; const other = listNotes(ctx.memoryDir, {max: 1})[0];
        ctx.otherTime = other?.time.slice(11, 16) || current.stamp?.time.slice(11, 16);
      }
      const replacement = replaceFile(ctx);
      ctx.seq = replacement ? ctx.replace : nextSeq(ctx);
      ctx.noteFile = replacement || repoPath(ctx.memoryDir, `handovers/${ctx.seq}-${ctx.time.slice(0, 10)}-${ctx.time.slice(11, 16).replace(':', '')}.md`, 'note');
      ctx.note = noteText(ctx, ctx.lessons);
      const original = fs.existsSync(ctx.currentFile) ? read(ctx.currentFile) : '';
      mergeCurrent(original, currentFromNote(ctx.note));
      // Kit 3.3.5 E4: in session mode claim the note and current-state.md before writing; when another live session
      // holds current-state.md, write and claim only this session's note and leave current-state.md untouched.
      if (ctx.session) {
        const held = foreignClaims(ctx.memoryDir, ctx.session.id).get('current-state.md');
        if (held) ctx.currentPending = held[0];
        claimFiles({memoryDir: ctx.memoryDir, repo: ctx.repo, files: [relative(ctx.memoryDir, ctx.noteFile), ...(held ? [] : ['current-state.md'])], by: 'handover', lock, session: ctx.session});
      }
      // A file is marked as attempted before it is written: a write that stops part way leaves a file the end phase must still find.
      ctx.attempts.add(relative(ctx.memoryDir, ctx.noteFile));
      fs.mkdirSync(ctx.notesDir, {recursive: true});
      if (replacement) atomic(ctx.noteFile, ctx.note);
      else fs.writeFileSync(ctx.noteFile, ctx.note, {flag: 'wx'});
      ctx.written = true;
      state.phase = 3;
      (dependencies.afterNote ?? (() => {}))(ctx);
      const written = read(ctx.noteFile);
      if (!ctx.currentPending) { ctx.attempts.add('current-state.md'); atomic(ctx.currentFile, mergeCurrent(original, currentFromNote(written))); ctx.currentWritten = true; }
      ctx.digest = stateToken(ctx.memoryDir);
    }, {timeoutMs: dependencies.lockTimeoutMs, note: message => diagnostics.push(message)});
    (dependencies.afterCurrent ?? (() => {}))(ctx);
  } catch (error) { state.error = {phase: state.phase, message: redact(String(error.message))}; }
  const wrote = () => Boolean(ctx.written || ctx.created.length || ctx.draftWritten);
  // Anything this run may have written: what it knows it wrote, a batch that stopped part way, or a file it set out to write.
  const touched = () => wrote() || Boolean(options.lessons && state.batchThrew) || ctx.attempts.size > 0;
  const lockText = text => {
    if (!/memory lock timed out/.test(text)) return text;
    // Kit 3.3.6: the report names every lock file that exists (the writer lock and the push lock), each with its age. The
    // timeout text above it keeps the file the wait named; with no lock file left, the writer lock is named, age unknown.
    const files = LOCK_NAMES.map(name => path.join(ctx.memoryDir, name)), present = files.filter(file => fs.existsSync(file));
    const ageOf = file => { try { return Math.max(0, Math.floor((Date.now() - fs.statSync(file).mtimeMs) / 1000)) + ' s'; } catch { return 'unknown'; } };
    return text + (present.length ? present : files.slice(0, 1)).map(file => `; lock ${singleLine(file)}, age ${ageOf(file)}`).join('') + '; if no other session is running, remove it';
  };
  const codeSpanLocks = text => LOCK_NAMES.reduce((acc, name) => {
    // A lock path is wrapped whole: the writer lock's path is a prefix of the push lock's, so it must not be followed by a name character.
    const file = singleLine(path.join(ctx.memoryDir, name));
    return acc.replace(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w.-])', 'g'), () => codeSpan(file));
  }, text);
  // A lock that timed out before the first write is a refusal, not evidence that knowledge is missing.
  if (state.error && !wrote() && /memory lock timed out/.test(state.error.message)) {
    emit(capped(capText(SAVE_REFUSED(codeSpanLocks(lockText(state.error.message).split('\n').map(singleLine).join('; '))) + '\n', 4000), {label: 'handover-refused'}));
    return {code: 1, ...ctx};
  }
  // Phase 4: indexes, rotation, the gate, the commit, the push. A throw here undoes nothing; it is an operational failure.
  let publication = {pushed: false, committed: false, failures: []};
  if (!state.error) {
    try {
      const remote = git(ctx.holder, ['remote']).trim();
      const sessionFiles = [relative(ctx.memoryDir, ctx.noteFile), ...(ctx.currentPending ? [] : ['current-state.md']), ...ctx.created, ...(ctx.draftFile ? [ctx.draftFile] : [])];
      const result = captureDiagnostics(() => (dependencies.checkpoint ?? checkpoint)({memoryDir: ctx.memoryDir, repo: ctx.repo, config: ctx.config,
        noPush: ctx.push === 'none' || !remote, commit: ctx.commit, ...(options.noRotate ? {noRotate: true} : {}), ...(ctx.session ? {session: true, files: sessionFiles} : {}),
        report: (step, message) => {
          diagnostics.push(`${step}: ${message}`);
          // In session mode the structured result is the gate evidence; an unscoped gate is never the success test (E4).
          if (step === 'gate' && !ctx.session) {
            const checked = checkGate({memoryDir: ctx.memoryDir, repo: ctx.repo, config: ctx.config});
            ctx.gate = counts(checked); ctx.gateFailures = checked.findings.filter(f => f.severity === 'FAIL' && !f.allowed).map(findingLine);
          }
          if (step === 'commit') ctx.command = message.includes('git add --') ? 'to run: ' + message.slice(message.indexOf('git add --')).split('\n')[0] : 'ran: git commit';
        }}), diagnostics);
      ctx.result = result;
      // E12.1: the checkpoint returns status 1 instead of throwing, in both modes.
      if (!ctx.session && result.status === 1) throw Error(result.error);
      if (ctx.session) {
        if (result.gate) { ctx.gate = {FAIL: result.gate.fails.length, WARN: result.gate.warns.length}; ctx.gateFailures = result.gate.fails.map(f => findingLine({severity: 'FAIL', ...f})); }
        if (result.status === 1) throw Error('checkpoint failed: ' + result.error);
        const contended = result.exceptions.filter(e => e.kind === 'contended');
        if (contended.length) throw Error('contended: ' + contended.map(e => `${e.file} (${e.detail})`).join('; '));
        if (result.status === 2) throw Error('push failed: ' + result.publication.error);
        ctx.gate ??= {FAIL: 0, WARN: 0}; ctx.gateFailures ??= [];
      }
      if (result.pushFailed) throw Error('push failed: ' + result.push);
      if (ctx.inRepo && ctx.commit && remote) {
        // In-repo memory is published with the project: push, then verify the saved SHA on the project's actual remote
        // branch, recorded as the checkpoint result's publication.
        result.publication = publish({memoryDir: ctx.memoryDir, sha: result.sha, git: (argv, options = {}) => git(ctx.repo, argv, options)});
        if (!result.publication.verified) throw Error('push failed: ' + (result.publication.error ?? 'publication not verified'));
        ctx.command = 'ran: git commit; git push';
      }
      else if (!ctx.inRepo && remote && ctx.push !== 'none') ctx.command = 'ran: git commit; git push';
      (dependencies.beforeVerify ?? (() => {}))(ctx);
    } catch (error) {
      state.p4 = redact(String(error.message));
      if (ctx.written && !ctx.session) {
        try { const checked = checkGate({memoryDir: ctx.memoryDir, repo: ctx.repo, config: ctx.config}); ctx.gate = counts(checked); ctx.gateFailures = checked.findings.filter(f => f.severity === 'FAIL' && !f.allowed).map(findingLine); } catch {}
        if (ctx.gateFailures?.length) state.p4 += ctx.gateFailures.some(f => ctx.initialFailures.includes(f)) ? '; gate FAIL pre-existed handover' : '; gate FAIL after write';
      }
    }
    try { publication = verify(ctx); } catch (error) { publication = {pushed: false, committed: false, failures: [short(error.message)]}; }
  }
  // Phase 5: the proof, from the disk as it is now. One guarded end phase: once anything was written, a read or a write that fails here
  // is caught where it happens and becomes an operational item (NOT FINISHED, a non-zero exit), never a refusal that says nothing was
  // written. The three conditions are proved from what could be read; an input that cannot be read is a cause only where the
  // condition it serves is then unproved (the state block, a lesson, the draft, the roadmap line), never the log or the status.
  const conclude = () => {
  const proof = prove(ctx, options, state);
  let disk = {files: []};
  if (touched() || options.lessons || ctx.later) {
    try { disk = uncommittedFiles(ctx, options); } catch (error) { disk = {error: short(redact(String(error.message)), 120)}; }
  }
  const {items, steps, byHand} = operationalItems(ctx, options, state, publication, proof, disk);
  ctx.operational = items; ctx.finish = steps.length ? 'the finish line below' : byHand ? 'by hand' : null; ctx.draftCount = proof.drafts;
  ctx.pubReason = state.error ? short(state.error.message) : state.p4 ?? publication.failures[0];
  const checks = {text: proof.checksText, verdict: proof.roadmap, learning: proof.learning};
  if (!proof.causes.length && !items.length) {
    // The three conditions are proved. A report that cannot read the project status records that as an operational item and shows the
    // status the run began with: the verdict stands, and the exit is non-zero through the path below.
    const success = capped(report(ctx, [], checks, publication), {label: 'handover'});
    if (!items.length) { emit(success); return {code: 0, ...ctx, token: ctx.digest}; }
  }
  // Build recovery guidance first so the parallel block yields its budget. With force, no command is printed: each is a by-hand line.
  let build = () => ({block: '', commands: []});
  if (touched()) {
    // The log is a convenience: a full disk or a blocked temporary folder must not hide a verdict that is already computed.
    const stopped = state.error ? `stopped in phase ${state.error.phase} of 5: ${state.error.message}` : null;
    let log = null, logFailure = null;
    try {
      const dir = path.join(os.tmpdir(), 'memory-session'); fs.mkdirSync(dir, {recursive: true});
      log = path.join(dir, 'handover-' + randomUUID() + '.log');
      fs.writeFileSync(log, redact([...diagnostics, stopped, state.p4, ...proof.causes].filter(Boolean).join('\n')) + '\n');
    } catch (error) { log = null; logFailure = short(redact(String(error.message)), 100); items.push(`the diagnostic log could not be written (${logFailure})`); }
    const fullOutput = log ? `full output: ${codeSpan(singleLine(log))}` : `full output: not saved (${logFailure})`;
    const names = files => files.slice(0, 6).map(file => codeSpan(singleLine(file))).join(', ') + (files.length > 6 ? `; +${files.length - 6} more` : '');
    const listed = disk.files ?? [];
    build = force => {
    let output = '';
    const commands = []; // the commands this block prints, each as printed
    if (listed.length || disk.unknown) output +=`\nuncommitted: ${listed.length ? names(listed) : ''}${disk.unknown ? `${listed.length ? '; ' : ''}unknown (the lesson files could not be read before the batch)` : ''}\n`;
    // A cause brings the re-run line, which redoes the checkpoint; without one, these commands finish the save, or the line says why it
    // is done by hand (a policy of the project, a path or a setting no command can carry), with the files and the memory folder.
    if (!proof.causes.length) {
      const hand = force && steps.length ? {reason: BY_HAND.long, files: listed.length ? listed : saveFiles(ctx)} : byHand;
      if (force && steps.length) ctx.finish = 'by hand';
      if (!force) steps.forEach((step, i) => { const line = codeSpan(singleLine(step)); commands.push(line); output += `\n${i ? 'then' : 'finish'}: ${line}\n`; });
      if (hand) output += `\nfinish by hand: ${hand.reason}; files: ${hand.files.length ? names(hand.files) : 'none'}; memory: ${codeSpan(singleLine(ctx.memoryDir))}\n`;
    }
    if (proof.causes.length) {
      // Every path is single-quoted for sh, as in the finish lines. A path that cannot be quoted that way is re-run by hand, and so is a
      // run given its configuration by the caller: the command the handover tool is run with reads its own, so it would run another one.
      let byHandReason = options.config ? BY_HAND.callerConfig : null;
      const shPath = file => { const text = shq(file); if (text === null) byHandReason ??= BY_HAND.quote; return text; };
      const args = ['node', shPath(fileURLToPath(import.meta.url)), 'run', '--repo', shPath(ctx.repo), '--memory-dir', shPath(ctx.memoryDir), '--in', shPath(path.resolve(options.input))];
      if (options.quick) args.push('--quick');
      if (options.noRotate) args.push('--no-rotate');
      args.push('--over', ctx.digest || ctx.baseline || 'none');
      if (ctx.written && !hasHead(ctx.holder, ctx.noteFile)) args.push('--replace', ctx.seq);
      else if (!ctx.written && options.replace) {
        try { replaceFile(ctx); args.push('--replace', options.replace); } catch {}
      }
      if (ctx.created?.length) {
        const spans = ctx.created.map(file => codeSpan(singleLine(file))).join(', ');
        output += ctx.later
          ? `\nlessons already written: ${spans}; keep lessons: later (...) as it is and re-run without --lessons; the draft text is not saved until a save completes.\n`
          : `\nlessons already written: ${spans}; set input lessons: none (already written: ${spans}) before retry.\n`;
      }
      else if (options.lessons) args.push('--lessons', shPath(path.resolve(options.lessons)));
      if (state.batchThrew && /rollback failed/.test(state.batchError ?? '')) output += '\nthe batch stopped and could not undo everything: a lesson it created is named by the re-run\'s duplicate refusal (follow that instruction); a recurrence entry it added stays, and the re-run adds it again\n';
      if (ctx.closeFailures.length) output += '\nAfter doing the close step(s), set each step to ok in closed, remove --skip-close, then re-run.\n';
      byHandReason ??= force || bytes(args.join(' ')) > MAX_COMMAND ? BY_HAND.long : null;
      ctx.rerun = byHandReason ? 'by hand' : null;
      const rerunLine = codeSpan(args.join(' '));
      if (!byHandReason) commands.push(rerunLine);
      output += byHandReason
        ? `\n${fullOutput}\n\nre-run by hand: ${byHandReason}; input: ${codeSpan(singleLine(path.resolve(options.input)))}${options.lessons && !ctx.created?.length ? `; batch: ${codeSpan(singleLine(path.resolve(options.lessons)))}` : ''}; memory: ${codeSpan(singleLine(ctx.memoryDir))}\n`
        : `\n${fullOutput}\n\nre-run: ${rerunLine}\n`;
    } else output += `\n${fullOutput}\n`;
    return {block: output, commands};
    };
  }
  const assemble = force => {
    const built = build(force);
    let block = built.block;
    if (state.error && /memory lock timed out/.test(state.error.message)) block += '\n' + codeSpanLocks(lockText(state.error.message).split('\n').map(singleLine).join('; ')) + '\n';
    return {text: report(ctx, proof.causes, checks, publication, 4000 - bytes(block)) + block, commands: built.commands};
  };
  // The commands are checked on the real artifact. A command the output cap cut is a different command, so when any printed command is
  // not whole in the capped output, the report is built again with by-hand lines in its place (dependencies.outputMax is for the tests).
  const max = dependencies.outputMax ?? 4000;
  let made = assemble(false), final = capped(made.text, {label: 'handover-failure', max});
  if (made.commands.some(command => !final.includes(command))) { made = assemble(true); final = capped(made.text, {label: 'handover-failure', max}); }
  emit(final);
  return {code: 1, ...ctx, token: ctx.digest};
  };
  try { return conclude(); }
  catch (error) {
    // A failure nothing above foresaw. With nothing written the refusal below is true; with anything written it is not, so the
    // run says what it could not do: the proof did not run, so the verdict is not safe, and the files it wrote may be uncommitted.
    if (!touched()) throw error;
    const detail = short(redact(String(error?.message ?? error)), 150);
    emit(capped([`- ${codeSpan(capText(singleLine(ctx.repo), 180))} | ${capText(singleLine(ctx.branch), 60)} @ ${ctx.sha}`,
      `NOT FINISHED - the final report could not be built (${detail}); what this run wrote may be uncommitted: read git status in the memory folder`,
      `NOT SAFE TO COMPACT - the three conditions could not be proved (${detail})`,
      'Next: run /handover again; whatever this run wrote is on disk.'].join('\n\n') + '\n', {label: 'handover-failure'}));
    return {code: 1, ...ctx, token: ctx.digest};
  }
}
export function main(argv = process.argv.slice(2)) {
  try {
    const command = argv.shift();
    if (!['run', 'check'].includes(command)) throw Error('usage: handover.mjs run|check --in <file> [--lessons <batch>] [--over <token>] [--replace <seq>] [--quick] [--no-rotate]');
    const options = {check: command === 'check'}, keys = {'--in': 'input', '--lessons': 'lessons', '--over': 'over', '--replace': 'replace', '--repo': 'repo', '--memory-dir': 'memoryDir', '--skip-close': 'skipClose'};
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--quick') { options.quick = true; continue; }
      if (argv[i] === '--no-rotate') { options.noRotate = true; continue; }
      const key = keys[argv[i]];
      if (!key || options[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('invalid or missing option: ' + argv[i]);
      options[key] = argv[++i];
    }
    return runHandover(options).code;
  } catch (error) { process.stdout.write(capped(capText(SAVE_REFUSED(redact(error.message).split('\n').map(singleLine).join('; ')) + '\n', 4000), {label: 'handover'})); return 1; }
}
if (isDirect(import.meta.url)) process.exitCode = main();
