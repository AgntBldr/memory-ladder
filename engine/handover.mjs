import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stateToken, readCurrent, parseBlock, readOverlay, capText, capOutput, listNotes} from './session-core.mjs';
import {localTime, atomicWrite as atomic, porcelainEntries, redact, parseHandover, memoryLocation, loadConfig, inRepoMemory, repoPath, validateConfigPaths, isDirect, mainWorktree, pathKey, memoryFiles} from './lib.mjs';
import {withMemoryLock} from './memory-lock.mjs';
import {batchLessons, parseBatch} from './memory-lesson.mjs';
import {rotateRoadmap, rotateLog} from './memory-rotate.mjs';
import {checkpoint} from './memory-checkpoint.mjs';
import {runCheck, counts, findingLine} from './memory-check.mjs';
import {isGenerated} from './memory-index.mjs';

export const QUICK_SAFE = 'SAFE TO COMPACT (quick) - state written; learning, roadmap and log not checked; committed and pushed, gate green';
export const FULL_SAFE = (learning, dates = 'roadmap and log current', publication = 'committed and pushed, gate green') => `SAFE TO COMPACT - state written; ${learning}; ${dates}; ${publication}`;
export const NEXT = 'Next: new conversation, then `/new-session`.';
const bytes = text => Buffer.byteLength(text);
const read = file => fs.readFileSync(file, 'utf8');
const singleLine = text => String(text).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '');
const capped = (text, options) => {
  const logDir = path.join(os.tmpdir(), 'memory-session');
  return capOutput(text, options).replaceAll(logDir, singleLine(logDir));
};
const quote = text => '"' + singleLine(text).replaceAll('"', '\\"') + '"';
const git = (dir, argv, options = {}) => execFileSync('git', ['--no-optional-locks', '-C', dir, ...argv], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 120000, ...options});
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
function writtenNames(memoryDir, text) {
  const names = text?.split(', ');
  return names?.length && new Set(names).size === names.length && names.every(name => {
    if (!/^lesson-.*\.md$/.test(name) || /[/\\]/.test(name)) return false;
    try { return fs.lstatSync(path.join(memoryDir, name)).isFile(); } catch { return false; }
  }) ? names : [];
}
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
function inputFile(file, quick, memoryDir, steps) {
  const example = 'JSON object, e.g. {"state":"ready","next":["review"]}';
  const closedShape = steps.length ? `closed: ${JSON.stringify(Object.fromEntries(steps.map(step => [step, 'ok'])))} for the overlay's close: steps ${steps.join('; ')}` : 'closed: omit it (the overlay has no close: steps)';
  const shape = key => key === 'closed' ? closedShape : key === 'next' ? 'next requires 1-3 single-line strings, e.g. ["review"] (or "review")' : key === 'lessons' && quick ? 'quick forbids lessons; omit lessons' : `${key} must be a string, e.g. "${key === 'state' ? 'ready' : key === 'lessons' ? 'none (no new learning this session)' : 'none'}"`;
  if (!file) throw Error('missing --in file: ' + example);
  let raw;
  try { raw = read(file).replace(/^\uFEFF/, ''); }
  catch (error) { throw Error(error.message + '; input must be a readable ' + example); }
  try { safe(raw, 'input'); } catch (error) { throw Error(error.message + '; ' + example); }
  let data;
  try { data = JSON.parse(raw); } catch { throw Error('input must be a ' + example); }
  const caps = {state: 240, question: 320, next: 480, waits: 240, risks: 240, constraints: 240, closed: 320, lessons: 320};
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
  if (bytes(raw) - originalBytes + bytes(JSON.stringify(data)) + droppedBytes - retryBytes > (quick ? 1024 : 1792)) throw Error('input exceeds ' + (quick ? 1024 : 1792) + ' B; ' + example);
  for (const [key, value] of Object.entries(data)) {
    if (!Object.hasOwn(caps, key)) throw Error('unknown input field: ' + key + '; keys: ' + Object.keys(caps).join(', ') + '; ' + example);
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (bytes(text) > caps[key]) throw Error(`${key} exceeds ${caps[key]} B; ${shape(key)}`);
    if (/SAFE TO COMPACT|[\u0000-\u001f\u007f]/.test(typeof value === 'string' ? value : '') || text.includes('**')) throw Error(`${key}: control, label or verdict text refused; ${shape(key)}`);
    if (!['next', 'closed'].includes(key) && typeof value !== 'string') throw Error(shape(key));
  }
  if (!data.state?.trim()) throw Error('state is required; ' + shape('state'));
  if (!Array.isArray(data.next) || data.next.length < 1 || data.next.length > 3 || data.next.some(x => typeof x !== 'string' || !x.trim() || /[\r\n\x00-\x1f]|\*\*|SAFE TO COMPACT/.test(x))) throw Error(shape('next'));
  return {...data, question: data.question?.trim() || 'none', waits: data.waits?.trim() || 'none', risks: data.risks?.trim() || 'none'};
}
const template = '---\nname: current-state\ndescription: "Current task, next action and checkpoint handoff."\nmetadata:\n  type: project\n  state: true\n---\n\n';
export function currentFromNote(note) {
  const parsed = parseHandover(note);
  if (!parsed.valid) throw Error('invalid note frontmatter');
  return currentBlock(parsed.body, parsed.data);
}
function currentBlock(body, {time, sha, mode}) {
  const fields = parseBlock(body).fields;
  const lines = [`## CURRENT`, `**${time.slice(0, 16).replace('T', ' ')} | @${sha} | ${mode}. ${fields.State}**`];
  for (const key of ['Open question', 'Next action', 'Constraints', 'In flight', 'Waits on the user', 'Context']) if (fields[key]) lines.push(`**${key}:** ${fields[key]}`);
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
function noteBody(ctx, lessons) {
  const {data, branch, repo, dirty, overlay} = ctx;
  const lines = [
    `**Open question:** ${data.question}`, `**State:** ${data.state}`, `**Waits on the user:** ${data.waits}`,
    `**Next action:** ${data.next.map((s, i) => `${i + 1}. ${s}`).join(' ')}`, `**Lessons:** ${lessons}`];
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
  const {repo, config, inRepo, dirty, memoryDir} = ctx, touched = new Set();
  const exists = key => fs.existsSync(repoPath(repo, config.caps[key].path, key));
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
  if (refused.length) throw Error('commit or stash these first (reconcile interrupted rotation destinations by hand): ' + refused.map(d => singleLine(d.file)).join(', '));
}
function validateLessons(data, options) {
  if (options.quick && (options.lessons || data.lessons !== undefined)) throw Error('quick forbids lessons; omit lessons and --lessons, e.g. {"state":"ready","next":["review"]}');
  if (!options.quick && !options.lessons && !/^none \(.{10,}\)$/.test(data.lessons || '')) throw Error('full needs --lessons or lessons: none (reason >= 10 chars), e.g. "none (no new learning this session)"');
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
  const pending = context && !options.quick && (options.lessons || !/^none \(.{10,}\)$/.test(data.lessons || '')) ? pendingLessons({...context, data}) : [];
  if (pending.length) throw Error('lessons already written; set input lessons: none (already written: ' + pending.join(', ') + '); re-run without --lessons; if this is a different batch, change state');
  validateLessons(data, options);
  const sections = options.lessons ? validateBatch(options.lessons) : [];
  const closeFailures = options.skipClose ? (steps.length ? steps : ['skipped']) : steps.filter(s => data.closed[s] === 'failed');
  const close = closeFailures.length ? 'FAILED: ' + closeFailures.join('; ') + (options.skipClose ? ' (skipped: ' + singleLine(options.skipClose) + ')' : '') : steps.map(s => s + '=ok').join('; ') || 'none';
  return {data, closeFailures, close, sections};
}
function prepare(options) {
  const repo = path.resolve(options.repo || process.env.CLAUDE_PROJECT_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
  const memoryDir = memoryLocation(repo, options.memoryDir).dir;
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
  for (const [key, group] of [['roadmap', 'roadmap'], ['log', 'brainLog']]) if (overlay[key] && !options.config)
    config.caps[group].path = (key === 'log' ? overlay[key].replace(/,\s*\d+\s+lines?$/, '') : overlay[key].split(/\s*\|\s*section:\s*/)[0]).trim();
  validateConfigPaths(repo, config);
  const branch = git(repo, ['branch', '--show-current']).trim(), sha = git(repo, ['rev-parse', 'HEAD']).trim().slice(0, 7);
  if (!branch) throw Error('detached HEAD: select a branch first');
  if (overlay['main-only'] === 'yes' && pathKey(mainWorktree(repo)) !== pathKey(repo)) throw Error('main-only overlay requires the main worktree');
  const push = overlay.push || 'memory';
  if (!['memory', 'project', 'none'].includes(push)) throw Error('invalid overlay push policy');
  const inRepo = inRepoMemory(repo, memoryDir), holder = inRepo ? repo : memoryDir;
  git(holder, ['rev-parse', '--verify', 'HEAD']);
  const dirty = status(repo);
  dirtyPreflight({repo, config, inRepo, dirty, memoryDir});
  const notesDir = repoPath(memoryDir, 'handovers', 'handovers'), currentFile = repoPath(memoryDir, 'current-state.md', 'CURRENT');
  const preflight = {...options, repo, memoryDir, holder, branch, notesDir};
  replaceFile(preflight);
  if (!options.replace) nextSeq(preflight);
  const {data, closeFailures, close, sections} = validateInput(options, memoryDir, overlay, {...preflight, sha});
  const ctx = {...options, repo, memoryDir, config, overlay, branch, sha, data, baseline, inRepo, holder, push,
    notesDir, currentFile,
    time: localTime(options.now ?? new Date()), dirty, closeFailures, close};
  ctx.waiting = !inRepo ? (maybeGit(holder, ['log', '--format=%h', '@{upstream}..HEAD']) || '').split('\n').filter(Boolean) : [];
  ctx.commit = inRepo && push === 'project' && overlay.branch === branch;
  ctx.lessons = options.quick ? 'skipped (quick)' : data.lessons;
  if (options.lessons) {
    ctx.preview = batchLessons({memoryDir, repo, file: options.lessons, config, dryRun: true});
    const existing = memoryFiles(memoryDir).filter(f => /^lesson-.*\.md$/.test(f.file));
    const creating = sections.filter(s => s['repeat-of'] === undefined);
    const slug = name => name.replace(/^lesson-\d+[a-z]*-/, '').replace(/\.md$/, '');
    const matches = ctx.preview.created.map((name, i) => existing.filter(f => slug(f.file) === slug(name) && f.data.description === creating[i].description).map(f => f.file));
    const duplicates = matches.flat();
    if (duplicates.length) {
      const allDuplicate = matches.length === sections.length && matches.every(files => files.length);
      throw Error('lessons already written: ' + duplicates.join(', ') + (allDuplicate ? '; set input lessons: none (already written: ' + duplicates.join(', ') + '); re-run without --lessons' : '; remove the duplicate section(s) from the batch, or use repeat-of, then re-run'));
    }
    ctx.lessons = [...ctx.preview.created, ...ctx.preview.repeated.map(r => r.file)].join(', ');
  }
  mergeCurrent(fs.existsSync(ctx.currentFile) ? read(ctx.currentFile) : '', currentFromNote(noteText(ctx, ctx.lessons)));
  ctx.initialFailures = checkGate({memoryDir, repo, config}).findings.filter(f => f.severity === 'FAIL' && !f.allowed).map(findingLine);
  return ctx;
}
function fullChecks(ctx) {
  if (ctx.quick) return {text: 'skipped', failures: []};
  const today = [ctx.time.slice(0, 10), (ctx.now ?? new Date()).toISOString().slice(0, 10)], failures = [], results = [];
  for (const [label, group, pattern] of [['roadmap', 'roadmap', /^## Open work \(as of (\d{4}-\d{2}-\d{2})\)/m], ['log', 'brainLog', /^## \[(\d{4}-\d{2}-\d{2})\]/gm]]) {
    const name = ctx.config.caps[group].path, file = repoPath(ctx.repo, name, group);
    if (!fs.existsSync(file)) {
      results.push(label + (label === 'log' ? ' no brain' : ' NOT current: update and commit'));
      if (label === 'roadmap') failures.push(name + ': update and commit');
      continue;
    }
    const dates = [...read(file).matchAll(new RegExp(pattern.source, 'gm'))].map(m => m[1]);
    const dirty = git(ctx.repo, ['status', '--porcelain', '--', name]).trim();
    const current = !dirty && (!dates.length || dates.some(d => today.includes(d)));
    results.push(label + (current ? dates.length ? ' current' : ' skipped (no dated heading)' : ' NOT current: update and commit'));
    if (!current) failures.push(name + ': update and commit');
  }
  const skipped = results.map(s => s.includes('no brain') ? 'no brain' : s.includes('skipped (') ? 'no dated heading' : null);
  const verdict = skipped.every(Boolean) ? `roadmap and log not checked (${[...new Set(skipped)].join('; ')})` : skipped[0] ? `roadmap not checked (${skipped[0]}), log current` : skipped[1] ? `roadmap current, log not checked (${skipped[1]})` : 'roadmap and log current';
  return {text: results.join(', '), failures, verdict};
}
function verify(ctx) {
  const failures = [], note = maybeGit(ctx.holder, ['show', 'HEAD:' + relative(ctx.holder, ctx.noteFile)]);
  // Compare raw blobs, never CURRENT, status or a marker in the note.
  if (note === null || !git(ctx.holder, ['show', 'HEAD:' + relative(ctx.holder, ctx.noteFile)], {encoding: null}).equals(Buffer.from(ctx.note))) failures.push('own note not byte-identical in HEAD');
  for (const file of ctx.created) if (!hasHead(ctx.holder, path.join(ctx.memoryDir, file))) failures.push('lesson missing in HEAD: ' + file);
  const remote = git(ctx.holder, ['remote']).trim();
  let pushed = !remote;
  if (remote) pushed = maybeGit(ctx.holder, ['merge-base', '--is-ancestor', 'HEAD', '@{upstream}']) !== null;
  if (!pushed || ctx.push === 'none') failures.push('HEAD not pushed' + (ctx.push === 'none' ? ' (push: none)' : ''));
  return {failures, pushed: pushed && ctx.push !== 'none', local: !remote};
}
function report(ctx, failures, checks, publication) {
  failures = failures.map(singleLine);
  const mode = ctx.quick ? 'quick' : 'full', memSha = maybeGit(ctx.holder, ['rev-parse', 'HEAD'])?.slice(0, 7) || 'unknown';
  const generated = new Set([ctx.config.caps.roadmapOverview.path, ctx.config.caps.brainIndex.path, ctx.config.caps.brainIndex.allPath]);
  let open;
  try { open = status(ctx.repo); }
  catch (error) { if (!failures.length) throw error; open = ctx.dirty; }
  const names = open.slice(0, 6).map(d => singleLine(d.file) + (generated.has(d.file) ? ' [generated]' : '')).join(', ');
  const gate = ctx.gate ? `${ctx.gate.FAIL} FAIL, ${ctx.gate.WARN} WARN` : 'not run';
  const learning = ctx.batch ? ctx.batch.created.length ? 'learning added with the WHY' : 'learning: repeats recorded' : 'learning: ' + ctx.lessons;
  const committed = publication.local ? 'committed locally (no remote), gate green' : 'committed and pushed, gate green';
  const successVerdict = ctx.quick ? QUICK_SAFE.replace('committed and pushed, gate green', committed) : FULL_SAFE(learning, checks.verdict, committed);
  const verdict = failures.length ? 'NOT SAFE TO COMPACT - ' + failures.slice(0, 3).map(x => capText(x.replace(/[\r\n]+/g, ' '), 150)).join('; ') : successVerdict;
  const lines = [
    `${capText(singleLine(ctx.repo), 180)} | ${capText(ctx.branch, 60)} @ ${ctx.sha} | ${capText(ctx.command || 'to run: git status', 210)}`,
    `handover ${mode} ${ctx.time.slice(11, 16)} token:${ctx.digest || ctx.baseline || 'none'} note:${ctx.seq || 'none'} | Q: ${[...ctx.data.question].slice(0, 80).join('')}`,
    `lessons: ${capText(ctx.quick ? 'skipped' : ctx.lessons, 240)}  checks: ${checks.text}`,
    `close: ${capText(ctx.close, 100)}  gate: ${gate}${ctx.gateFailures?.length ? ' | FAIL: ' + capText(ctx.gateFailures.slice(0, 2).join('; '), 180) : ''}`,
    publication.pushed ? `memory ${memSha} ${publication.local ? 'local only, no remote' : 'pushed'}${ctx.waiting.length ? '; included waiting ' + ctx.waiting.slice(0, 3).join(', ') : ''}` : (ctx.written ? 'saved locally, NOT pushed: ' : 'note not written: ') + capText(failures[0] || 'publication not verified', 100),
    `open: ${open.length} uncommitted files not committed by handover (${capText(names || 'none', 180)})`, verdict, NEXT].map(singleLine);
  // Reserve verdict and next-step bytes even when paths or diagnostics are long.
  const baselineLine = ctx.over === undefined ? 'token baseline: run began (no --over supplied).\n' : '';
  const tail = lines.slice(-2).join('\n'), head = capText(lines.slice(0, -2).join('\n'), 1535 - bytes(tail) - bytes(baselineLine) - 1);
  let output = capped(head + '\n' + tail + '\n', {max: 1536, label: 'handover-report'});
  if (ctx.warning && ctx.written) {
    const warning = `warning: another session handed over at ${ctx.otherTime || 'unknown'}; both notes kept\n${capText(ctx.replaced, 1536)}`;
    const split = output.indexOf('\n', output.indexOf('\n') + 1);
    output = output.slice(0, split + 1) + capped(warning, {max: 2048, label: 'handover-parallel'}) + '\n' + output.slice(split + 1);
  }
  output += baselineLine;
  return redact(output);
}
// Dependencies permit deterministic failure/crash tests; the CLI exposes no injection flags.
export function runHandover(options = {}, dependencies = {}) {
  const emit = dependencies.output ?? (text => process.stdout.write(text));
  let ctx, checks = {text: 'skipped', failures: []}, publication = {pushed: false}, failure, block;
  const diagnostics = [];
  try {
    ctx = prepare(options);
    if (options.check) {
      emit(capped(capText(`check: validate and preflight passed; no writes\nplan: lessons ${singleLine(ctx.lessons)}; note then CURRENT under lock; checkpoint ${ctx.inRepo ? ctx.commit ? 'commit and push project' : 'print staging command' : 'commit memory'}; verify own note and lessons in HEAD and pushed; ${ctx.quick ? 'skip date checks' : 'read-only roadmap/log checks'}\n`, 1536), {max: 1536, label: 'handover-check'}));
      return {code: 0};
    }
    ctx.created = [];
    if (ctx.lessons && options.lessons) {
      ctx.batch = captureDiagnostics(() => (dependencies.batchLessons ?? batchLessons)({memoryDir: ctx.memoryDir, repo: ctx.repo, file: options.lessons, config: ctx.config}), diagnostics);
      if (ctx.batch.rolledBack) { ctx.lessons = 'none (batch rolled back)'; throw Error('lesson batch rolled back: ' + ctx.batch.findings.map(findingLine).join('; ')); }
      ctx.created = [...ctx.batch.created, ...ctx.batch.repeated.map(r => r.file)];
      ctx.lessons = ctx.created.join(', ');
    }
    (dependencies.beforeLock ?? (() => {}))(ctx);
    withMemoryLock(ctx.memoryDir, () => {
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
      fs.mkdirSync(ctx.notesDir, {recursive: true});
      if (replacement) atomic(ctx.noteFile, ctx.note);
      else fs.writeFileSync(ctx.noteFile, ctx.note, {flag: 'wx'});
      ctx.written = true;
      (dependencies.afterNote ?? (() => {}))(ctx);
      const written = read(ctx.noteFile);
      atomic(ctx.currentFile, mergeCurrent(original, currentFromNote(written)));
      ctx.digest = stateToken(ctx.memoryDir);
    }, {timeoutMs: dependencies.lockTimeoutMs, note: message => diagnostics.push(message)});
    (dependencies.afterCurrent ?? (() => {}))(ctx);
    const remote = git(ctx.holder, ['remote']).trim();
    const result = captureDiagnostics(() => (dependencies.checkpoint ?? checkpoint)({memoryDir: ctx.memoryDir, repo: ctx.repo, config: ctx.config,
      noPush: ctx.push === 'none' || !remote, commit: ctx.commit,
      report: (step, message) => {
        diagnostics.push(`${step}: ${message}`);
        if (step === 'gate') {
          const checked = checkGate({memoryDir: ctx.memoryDir, repo: ctx.repo, config: ctx.config});
          ctx.gate = counts(checked); ctx.gateFailures = checked.findings.filter(f => f.severity === 'FAIL' && !f.allowed).map(findingLine);
        }
        if (step === 'commit') ctx.command = message.includes('git add --') ? 'to run: ' + message.slice(message.indexOf('git add --')).split('\n')[0] : 'ran: git commit';
      }}), diagnostics);
    if (result.pushFailed) throw Error('push failed: ' + result.push);
    if (ctx.inRepo && ctx.commit && remote) {
      try { git(ctx.repo, ['push']); } catch (error) { throw Error('push failed: ' + error.message); }
      ctx.command = 'ran: git commit; git push';
    }
    else if (!ctx.inRepo && remote && ctx.push !== 'none') ctx.command = 'ran: git commit; git push';
    (dependencies.beforeVerify ?? (() => {}))(ctx);
    publication = verify(ctx);
    checks = fullChecks(ctx);
    const failures = [...ctx.closeFailures.map(s => 'close FAILED: ' + s), ...publication.failures, ...(ctx.gateFailures ?? ['checkpoint gate not verified']), ...checks.failures];
    if (failures.length) throw Error(failures.join('\n'));
    emit(capped(report(ctx, [], checks, publication), {label: 'handover'}));
    return {code: 0, ...ctx, token: ctx.digest};
  } catch (error) {
    failure = redact(String(error.message));
    if (!ctx && error.block) block = error.block.split('\n').map(singleLine).join('\n');
    if (ctx && /memory lock timed out/.test(failure)) {
      const lockFile = path.join(ctx.memoryDir, '.memory.lock');
      let age = 'unknown';
      try { age = Math.max(0, Math.floor((Date.now() - fs.statSync(lockFile).mtimeMs) / 1000)) + ' s'; } catch {}
      failure += `; lock ${singleLine(lockFile)}, age ${age}; if no other session is running, remove it`;
    }
  }
  if (!ctx) {
    emit(capped(capText('NOT SAFE TO COMPACT - ' + failure.split('\n').map(singleLine).join('; ') + '\n' + (block || ''), 4000), {label: 'handover-refused'}));
    return {code: 1};
  }
  if (options.lessons && !ctx.batch) ctx.lessons = 'none (batch failed)';
  if (ctx.written) {
    try { const checked = checkGate({memoryDir: ctx.memoryDir, repo: ctx.repo, config: ctx.config}); ctx.gate = counts(checked); ctx.gateFailures = checked.findings.filter(f => f.severity === 'FAIL' && !f.allowed).map(findingLine); } catch {}
    if (ctx.gateFailures?.length) failure += ctx.gateFailures.some(f => ctx.initialFailures.includes(f)) ? '\ngate FAIL pre-existed handover' : '\ngate FAIL after write';
  }
  let output = report(ctx, failure.split('\n'), checks, publication);
  if (ctx.written || ctx.created?.length) {
    const dir = path.join(os.tmpdir(), 'memory-session'); fs.mkdirSync(dir, {recursive: true});
    const log = path.join(dir, 'handover-' + randomUUID() + '.log');
    fs.writeFileSync(log, redact([...diagnostics, failure].join('\n')) + '\n');
    const args = ['node', quote(fileURLToPath(import.meta.url)), 'run', '--repo', quote(singleLine(ctx.repo)), '--memory-dir', quote(ctx.memoryDir), '--in', quote(path.resolve(options.input))];
    if (options.quick) args.push('--quick');
    args.push('--over', ctx.digest || ctx.baseline || 'none');
    if (ctx.written && !hasHead(ctx.holder, ctx.noteFile)) args.push('--replace', ctx.seq);
    else if (!ctx.written && options.replace) {
      try { replaceFile(ctx); args.push('--replace', options.replace); } catch {}
    }
    if (ctx.created?.length) output += `lessons already written: ${singleLine(ctx.created.join(', '))}; set input lessons: none (already written: ${singleLine(ctx.created.join(', '))}) before retry.\n`;
    else if (options.lessons) args.push('--lessons', quote(path.resolve(options.lessons)));
    if (ctx.closeFailures.length) output += 'After doing the close step(s), set each step to ok in closed, remove --skip-close, then re-run.\n';
    output += `full output: ${singleLine(log)}\nre-run: ${args.join(' ')}\n`;
  }
  if (/memory lock timed out/.test(failure)) output += failure.split('\n').map(singleLine).join('; ') + '\n';
  emit(capped(output, {label: 'handover-failure'}));
  return {code: 1, ...ctx, token: ctx.digest};
}
export function main(argv = process.argv.slice(2)) {
  try {
    const command = argv.shift();
    if (!['run', 'check'].includes(command)) throw Error('usage: handover.mjs run|check --in <file> [--lessons <batch>] [--over <token>] [--replace <seq>] [--quick]');
    const options = {check: command === 'check'}, keys = {'--in': 'input', '--lessons': 'lessons', '--over': 'over', '--replace': 'replace', '--repo': 'repo', '--memory-dir': 'memoryDir', '--skip-close': 'skipClose'};
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--quick') { options.quick = true; continue; }
      const key = keys[argv[i]];
      if (!key || options[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('invalid or missing option: ' + argv[i]);
      options[key] = argv[++i];
    }
    return runHandover(options).code;
  } catch (error) { process.stdout.write(capped(capText('NOT SAFE TO COMPACT - ' + redact(error.message).split('\n').map(singleLine).join('; ') + '\n', 4000), {label: 'handover'})); return 1; }
}
if (isDirect(import.meta.url)) process.exitCode = main();
