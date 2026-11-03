import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {gitResult, porcelainEntries, isDirect, loadConfig, memoryLocation, mainWorktree, readKitJSON, parseFrontmatter, redact, insideRepo, pathKey, validateConfigPaths, toolDir, repoRoot} from './lib.mjs';
import {readCurrent, parseBlock, readOverlay, capText, capOutput, matchPhrase, listNotes} from './session-core.mjs';

export const FIRST_REPLY_TEMPLATE = `**<abs path>** - \`<branch>\` @ \`<sha>\` - kit <version>[ - flags: ...]
- Git: <n> changed, <n> untracked; <n> ahead|no upstream
- Gate: <gate line>; memory: <dir> (<source>)

**Where we left off**
- Last handover: <time> @<sha7> <branch> - <state line>|stale <date> vs HEAD <date>|undated|none recorded
- Open question: <question>
- Also handed over (24 h): <time> <branch>: <question>
- Log: <newest line>

**Waiting on you**
- <item>: <link>
- Rulings: <n|board: not readable here>
- Conflicts: <AGENTS.md vs overlay vs rules file>

**This session**
- Goal: <restated>|none given - what is this session for?
- First step: <action> - build <model>, review <different model>, because <why>
- <named-yes item> - yes or no?

Waiting for your go.`;
const startNudge = 'new-session: the message is a start phrase. Invoke the Skill tool with skill "new-session" and args "sentence" before anything else; its only step runs the read-only start helper.';
const safeText = file => { try { const raw = fs.readFileSync(file); return raw.includes(0) ? '' : raw.toString('utf8'); } catch { return ''; } };
const stampTime = stamp => stamp ? Date.parse(stamp.time.replace(' ', 'T')) : NaN;
const field = (fields, ...names) => { const entries = Object.entries(fields); return names.map(name => entries.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]).find(Boolean) ?? ''; };
const existsDir = dir => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } };
const defaultRepo = () => process.env.CLAUDE_PROJECT_DIR || (path.basename(toolDir) === 'memory' ? repoRoot() : path.resolve(toolDir, '..'));
class Refusal extends Error {}
const git = (repo, ...argv) => {
  const result = gitResult(repo, argv, {encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024});
  return result.status === 0 ? result.stdout.trimEnd() : null;
};
function owned(repo, skill) {
  try {
    const file = `.claude/skills/${skill}/SKILL.md`, manifest = readKitJSON(path.join(repo, 'scripts/memory/MANIFEST.json'));
    const hash = createHash('sha256').update(fs.readFileSync(path.join(repo, file), 'utf8').replace(/\r\n/g, '\n')).digest('hex');
    return manifest.files?.[file] === hash;
  } catch { return false; }
}
function options(argv) {
  const out = {_: []};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    if (['--rules', '--help'].includes(arg)) { out[arg.slice(2)] = true; continue; }
    if (!['--repo', '--memory-dir', '--entry', '--goal', '--message'].includes(arg) || argv[i + 1] === undefined) throw new Refusal('invalid or missing option: ' + arg);
    out[arg.slice(2)] = argv[++i];
  }
  if (out.entry !== undefined && !['slash', 'sentence'].includes(out.entry)) throw new Refusal('entry must be slash or sentence');
  return out;
}
function inputJSON() {
  return new Promise(resolve => {
    const parts = []; let bytes = 0, done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); process.stdin.removeAllListeners('data'); process.stdin.removeAllListeners('end'); process.stdin.removeAllListeners('error'); process.stdin.pause(); process.stdin.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(null), 1000);
    process.stdin.on('error', () => finish(null));
    process.stdin.on('data', chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) finish(null); else parts.push(chunk); });
    process.stdin.on('end', () => { try { finish(JSON.parse(Buffer.concat(parts).toString('utf8').replace(/^\uFEFF/, ''))); } catch { finish(null); } });
  });
}
function boundedSection(file, heading, max) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(4096), decoder = new StringDecoder('utf8'); let pending = '', output = '', active = false, count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      pending += decoder.write(buffer.subarray(0, count));
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) {
        if (/^#{1,6}\s/.test(line)) {
          if (active) return capText(output, max);
          active = line.replace(/^#+\s*/, '').trim() === heading;
        }
        if (active) { output += line + '\n'; if (Buffer.byteLength(output) > max) return capText(output, max); }
      }
      if (pending.length > 65536) { if (active) return capText(output + pending, max); pending = ''; }
    }
    return capText(output + (active ? pending + decoder.end() : ''), max);
  } catch { return 'roadmap: not readable here'; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function tail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size, buffer = Buffer.alloc(Math.min(size, 8192));
    fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    let offset = 0;
    while (offset < buffer.length && (buffer[offset] & 0xc0) === 0x80) offset++;
    return buffer.subarray(offset).toString('utf8').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  } catch { return 'not readable here'; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function recall(memoryDir, repo, config, goal, {buildCorpus, search}) {
  if (!goal) return [];
  try {
    const files = fs.readdirSync(memoryDir).filter(name => /\.md$/i.test(name) && !/^(?:MEMORY|ARCHIVE|INDEX[^/]*|current-state)\.md$/i.test(name)).flatMap(file => {
      const absolute = path.join(memoryDir, file);
      if (!fs.lstatSync(absolute).isFile()) return [];
      const text = safeText(absolute); return [{file, text, ...parseFrontmatter(text)}];
    });
    return search(buildCorpus({memoryDir, repo, config, files}), goal, 3).slice(0, 2);
  } catch { return []; }
}
function gateFacts({repo, config, memoryDir, hasKit, hasMemory}, {runCheck, counts, findingLine}) {
  let gate = hasKit ? 'memory dir not found' : 'no memory kit here', failures = [];
  if (hasKit && hasMemory) {
    const optionalLocks = process.env.GIT_OPTIONAL_LOCKS;
    process.env.GIT_OPTIONAL_LOCKS = '0';
    try { const checked = runCheck({memoryDir, repo, config, quick: true}), count = counts(checked); gate = `${count.FAIL} FAIL, ${count.WARN} WARN, ${count.allowed} allowed`; failures = checked.findings.filter(f => f.severity === 'FAIL' && !f.allowed).slice(0, 2).map(findingLine); }
    catch (error) { gate = 'FAIL: ' + error.message; failures = [gate]; }
    finally { if (optionalLocks === undefined) delete process.env.GIT_OPTIONAL_LOCKS; else process.env.GIT_OPTIONAL_LOCKS = optionalLocks; }
  }
  return {gate, failures};
}
function metaPart(f) {
  const {repo, branch, sha, changed, untracked, ahead, hasKit, config, gate, hasMemory, memoryDir, location, current} = f;
  const token = `token: ${current.token ?? 'none'}`;
  return capText(`${repo} | ${branch}@${sha} | ${changed} changed, ${untracked} untracked | ${ahead === null ? 'no upstream' : ahead + ' ahead'} | kit ${hasKit ? config.engine_version : 'absent'}${f.flags ? ' | flags: ' + f.flags : ''}\ngate: ${gate} | memory: ${hasMemory ? memoryDir : 'memory dir not found: ' + (memoryDir ?? 'unresolved')} (${location.source})`, 439 - Buffer.byteLength(token)) + '\n' + token;
}
function leadPart({notes, current, headDate, failures}) {
  const newest = notes[0], currentLeads = current.stamp && (!newest || stampTime(current.stamp) > Date.parse(newest.time));
  const selected = newest && !currentLeads ? newest : null, parsed = parseBlock(selected?.body ?? current.block), fields = parsed.fields;
  let lead;
  if (selected) lead = `last handover: ${selected.time} @${selected.sha} ${selected.branch} - ${field(fields, 'State') || 'state: none recorded'}\n${selected.file}`;
  else if (current.stamp) lead = `last handover: ${current.stamp.time} @${current.stamp.sha} - ${parsed.state}\n${current.file}${newest ? '\nolder note: ' + newest.time + ' ' + newest.file : ''}`;
  else if (current.block) {
    const data = parseFrontmatter(safeText(current.file)).data, modified = data.modified ?? data.metadata?.modified;
    const stale = current.block.startsWith('## CURRENT\n') && Number.isFinite(Date.parse(modified)) && Date.parse(headDate) - Date.parse(modified) > 86400000;
    lead = (stale ? `stale ${modified} vs HEAD ${headDate}` : 'undated') + '\n' + current.block;
  } else lead = 'state: none recorded';
  const question = field(fields, 'Open question'), waits = field(fields, 'Waits on the user', 'WAITS ON THE OWNER'), next = field(fields, 'Next action', 'RESUME HERE');
  if (question && question.toLowerCase() !== 'none') lead += '\nQ: ' + question;
  lead += '\nwaits on you: ' + (waits.split('|').length > 3 ? `see ${selected?.file ?? current.file} (Waits section)` : waits || 'none');
  for (const label of ['Next action', 'Lessons', 'Constraints', 'In flight', 'LIVE RISKS']) if (field(fields, label)) lead += `\n${label}: ${field(fields, label)}`;
  return {text: capText((failures.length ? capText(failures.join('\n'), 400) + '\n' : '') + lead, 1600), next};
}
function signalsPart({repo, main, hasMemory, memoryDir, current, notes}) {
  const newest = notes[0];
  const signals = [];
  if (pathKey(main) !== pathKey(repo)) signals.push('worktree of ' + main);
  const worktrees = git(repo, 'worktree', 'list', '--porcelain');
  if ((worktrees?.match(/^worktree /gm) ?? []).length > 1) signals.push('possible other session: multiple worktrees - stage by path');
  if (hasMemory && fs.existsSync(path.join(memoryDir, '.memory.lock'))) signals.push('possible other session: .memory.lock (operation lock) - stage by path');
  try { if (hasMemory && [memoryDir, current.file, newest?.file].filter(Boolean).some(file => Date.now() - fs.statSync(file).mtimeMs < 3600000)) signals.push('possible other session: memory changed <60 min - stage by path'); } catch {}
  return capText(signals.join('\n'), 280);
}
function otherNotesPart(notes) {
  if (notes.length < 2) return '';
  const label = 'other (possible parallel):\n', selected = notes.slice(1, 3);
  const budget = Math.floor((240 - Buffer.byteLength(label) - (selected.length - 1)) / selected.length);
  return label + selected.map(n => {
    const time = n.time.slice(11, 16), file = 'handovers/' + path.basename(n.file);
    const branch = capText(n.branch, Math.max(0, budget - Buffer.byteLength(`${time}  ${file}`) - 1));
    const base = `${time} ${branch}  ${file}`;
    const question = capText([...n.question].slice(0, 60).join(''), Math.max(0, budget - Buffer.byteLength(base)));
    return `${time} ${branch} ${question} ${file}`;
  }).join('\n');
}
function overlayPath(repo, value, key, conflicts) {
  const file = path.resolve(repo, value);
  if (insideRepo(repo, file)) return file;
  conflicts.push(`overlay ${key} outside repo: ignored`);
  return null;
}
function logPart({repo, overlay, conflicts}) {
  if (!overlay.log) return '';
  const file = overlayPath(repo, overlay.log.replace(/,\s*\d+\s+lines?$/, ''), 'log', conflicts);
  return file ? capText('log: ' + tail(file), 160) : '';
}
function roadmapPart({repo, overlay, conflicts}) {
  if (!overlay.roadmap) return '';
  const [name, section] = overlay.roadmap.split(/\s*\|\s*section:\s*/);
  const file = overlayPath(repo, name, 'roadmap', conflicts);
  return file ? (section ? boundedSection(file, section, 400) : 'roadmap: name a section in the overlay') : '';
}
function unpushedPart({ahead}) { return capText(ahead !== null && Number(ahead) > 0 ? `unpushed: ${ahead} project commits` : '', 80); }
function recallPart(pointers) { return capText(pointers.map(p => `recall: ${p.path} - ${p.hook}`).join('\n'), 300); }
function effectiveOverlay(repo, conflicts = []) {
  const overlay = readOverlay(repo), placeholders = [];
  const keys = new Set(['roadmap', 'branch', 'main-only', 'check', 'rules', 'after-go', 'close', 'push', 'log', 'board', 'public']);
  const seen = new Set(), duplicates = new Set();
  const lines = safeText(path.join(repo, 'AGENTS.md')).split(/\r\n|[\r\n]/);
  let active = false;
  for (const line of lines) {
    if (!active) { if (line.trimEnd() === '## Session overlay') active = true; continue; }
    if (/^#{1,2}(?:\s|$)/.test(line)) break;
    const match = /^([\w-]+):/.exec(line);
    if (!match || match[1].toLowerCase() === 'precedence') continue;
    const key = match[1].toLowerCase();
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  for (const key of seen) {
    if (!keys.has(key)) { conflicts.push(`overlay ${key}: refused (unknown key)`); delete overlay[key]; }
    if (duplicates.has(key)) { conflicts.push(`overlay ${key}: refused (duplicate key)`); delete overlay[key]; }
  }
  for (const [key, value] of Object.entries(overlay)) {
    if (['check', 'board'].includes(key) && (!value || Buffer.byteLength(value) > 120 || /[^A-Za-z0-9 ._/:=@%+,-]/.test(value))) {
      conflicts.push(`overlay ${key}: refused`); delete overlay[key];
    } else if (/[<>]/.test(value) || (['branch', 'main-only', 'push', 'public'].includes(key) && value.includes('|'))) {
      placeholders.push(key); delete overlay[key];
    }
  }
  if (placeholders.length) conflicts.push('overlay placeholders: ' + placeholders.join(', '));
  return overlay;
}
function facts(opts, check, recallApi) {
  const repo = path.resolve(opts.repo || defaultRepo()), configFile = path.join(repo, 'scripts/memory/memory.config.json');
  const config = fs.existsSync(configFile) ? readKitJSON(configFile) : loadConfig();
  validateConfigPaths(repo, config);
  const conflicts = [], overlay = effectiveOverlay(repo, conflicts), location = memoryLocation(repo, opts['memory-dir'], {list: false});
  const memoryDir = location.dir, hasMemory = existsDir(memoryDir), hasKit = fs.existsSync(path.join(repo, 'scripts/memory/KIT.json')) || fs.existsSync(path.join(repo, 'scripts/memory/MANIFEST.json'));
  const branch = git(repo, 'branch', '--show-current') || 'detached/unavailable', sha = git(repo, 'rev-parse', '--short=7', 'HEAD') || 'unknown';
  const rows = porcelainEntries(git(repo, 'status', '--porcelain=v1', '-z') ?? '');
  let changed = 0, untracked = 0;
  for (const row of rows) { if (row.code === '??') untracked++; else changed++; }
  const ahead = git(repo, 'rev-list', '--count', '@{upstream}..HEAD'), headDate = git(repo, 'log', '-1', '--format=%cI'), main = mainWorktree(repo);
  const f = {repo, config, overlay, location, memoryDir, hasMemory, hasKit, branch, sha, changed, untracked, ahead, headDate, main};
  Object.assign(f, gateFacts(f, check));
  f.current = hasKit && hasMemory ? readCurrent(memoryDir) : readCurrent(null);
  f.notes = hasKit && hasMemory ? listNotes(memoryDir, {sinceHours: config.caps?.handovers?.windowHours ?? 24}) : [];
  const lead = leadPart(f), pointers = hasKit && hasMemory ? recall(memoryDir, repo, config, opts.goal, recallApi) : [];
  f.conflicts = conflicts;
  if (Buffer.byteLength(boundedSection(path.join(repo, 'AGENTS.md'), 'Session overlay', 1501)) > 1500) conflicts.push('overlay over 1,500 B');
  if (overlay.branch && branch !== overlay.branch) conflicts.push(`overlay branch ${overlay.branch}; current ${branch}`);
  if (overlay['main-only'] === 'yes' && pathKey(main) !== pathKey(repo)) conflicts.push('overlay main-only: yes; current worktree');
  const signals = signalsPart(f);
  f.flags = [signals.includes('possible other session:') ? 'other session' : '', pathKey(main) !== pathKey(repo) ? 'worktree' : ''].filter(Boolean).join(', ');
  const parts = [metaPart(f), lead.text, otherNotesPart(f.notes), logPart(f), roadmapPart(f), signals, unpushedPart(f), recallPart(pointers)];
  const action = !hasKit ? 'no memory kit here; review git facts' : !hasMemory ? 'run node scripts/memory/memory-init.mjs - yes or no?' : f.failures.length ? 'fix or report the gate failures' : lead.next || 'agree the goal and first action';
  const followups = [...(overlay.rules ? ['open --rules'] : []), ...pointers.map(p => 'open ' + JSON.stringify(p.path))];
  const footer = `${overlay.board ? 'rulings: pending board add-on\n' : ''}${conflicts.length ? 'conflicts: ' + capText(conflicts.join('; '), 200) + '\n' : ''}goal: ${capText(opts.goal || 'none given - what is this session for?', 100)}\nfirst step: ${capText(action, 160)} - build session model, review different model, because independent review.`;
  parts[1] = capText(parts[1], 1100) + '\n' + capText(footer, 499);
  parts.splice(2, 0, 'Precedence: AGENTS.md > overlay > rules. Name conflicts. No chores before go.');
  return {digest: capText(redact(parts.filter(Boolean).join('\n')), 3500), followups, addons: ['check', 'board'].filter(key => overlay[key]).map(key => `${key}: ${overlay[key]}`)};
}
export async function brief(opts = {}) { return facts(opts, await import('./memory-check.mjs'), await import('./memory-recall.mjs')).digest; }
export async function start(opts = {}) {
  const f = facts(opts, await import('./memory-check.mjs'), await import('./memory-recall.mjs'));
  const addons = f.addons.length ? '\nAdd-ons (at most 2; run; keep only first 1,024 B via | head -c 1024): ' + f.addons.join('; ') + '.' : '';
  const render = calls => 'reply using the template in `.claude/skills/new-session/SKILL.md`.'
    + (calls.length ? '\nRead next with this helper: ' + calls.join('; ') + '.' : '') + addons
    + '\nhandovers/<name> hints are for later, not to open now.\nWaiting for your go.';
  const followups = [];
  for (const call of f.followups) if (Buffer.byteLength(render([...followups, call])) <= 499) followups.push(call);
  const instructions = render(followups);
  return capOutput(f.digest + '\n' + instructions, {label: 'start'});
}
export function open(opts = {}) {
  const repo = path.resolve(opts.repo || defaultRepo()), overlay = effectiveOverlay(repo), configFile = path.join(repo, 'scripts/memory/memory.config.json');
  const config = fs.existsSync(configFile) ? readKitJSON(configFile) : loadConfig(), memoryDir = memoryLocation(repo, opts['memory-dir'], {list: false}).dir;
  validateConfigPaths(repo, config);
  const requested = opts.rules ? overlay.rules : opts._?.[1];
  if (!requested) throw new Refusal(opts.rules ? 'no rules file named in Session overlay' : 'open needs a path');
  let file = path.resolve(repo, requested.replace(/^~[\\/]/, os.homedir() + path.sep));
  if (!opts.rules && !path.isAbsolute(requested) && memoryDir && !fs.existsSync(file)) file = path.resolve(memoryDir, requested);
  if ([requested, file, pathKey(file)].some(value => value.split(/[\\/]/).some(part => part.toLowerCase() === '.git'))) throw new Refusal('open refuses .git paths');
  if (!opts.rules) {
    const roots = [memoryDir, path.join(repo, config.brain?.dir ?? 'brain')].filter(Boolean);
    if (!roots.some(root => insideRepo(root, file))) throw new Refusal('open refuses paths outside memory or brain');
    if (/^(?:ARCHIVE|MEMORY|INDEX[^/]*|archive-\d{4}-\d{2})\.md$/i.test(path.basename(file))) throw new Refusal('open refuses archives and generated indexes');
  }
  let raw;
  try { raw = fs.readFileSync(file); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM'].includes(error.code)) throw new Refusal(error.message);
    throw error;
  }
  if (raw.includes(0)) throw new Refusal('open refuses NUL bytes');
  const text = redact(raw.toString('utf8')), max = opts.rules ? 4000 : 1536;
  if (opts.rules && Buffer.byteLength(text) > max) {
    const tail = `[cut; full file: ${file}]`;
    return capOutput(capText(text, Math.max(0, max - Buffer.byteLength(tail))).replace(/\[cut\]$/, '') + capText(tail, max), {label: 'rules'});
  }
  return capOutput(capText(text, max), {label: 'open'});
}
export async function main(argv = process.argv.slice(2)) {
  const detect = argv[0] === 'detect';
  try {
    const opts = options(argv), command = opts._[0];
    let output = '';
    if (detect) {
      const payload = await inputJSON(), match = matchPhrase(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null);
      const repo = path.resolve(opts.repo || defaultRepo());
      if (match.kind && owned(repo, match.kind === 'start' ? 'new-session' : 'handover')) {
        const nudge = match.kind === 'start' ? startNudge : `handover: the message is a handover phrase. Invoke the Skill tool with skill "handover" and args "${match.quick ? 'quick' : 'full'}" first.`;
        output = JSON.stringify({hookSpecificOutput: {hookEventName: 'UserPromptSubmit', additionalContext: nudge}});
      }
    } else if (command === 'dispatch') {
      const match = matchPhrase(opts.message), repo = path.resolve(opts.repo || defaultRepo());
      if (match.kind && owned(repo, match.kind === 'start' ? 'new-session' : 'handover')) output = match.kind === 'start' ? await start({...opts, goal: match.text, entry: 'sentence'}) : `Read .claude/skills/handover/SKILL.md and follow it (${match.quick ? 'quick' : 'full'}).${match.text ? '\nNote: ' + match.text : ''}`;
    } else if (command === 'start') output = await start(opts);
    else if (command === 'brief') output = await brief(opts);
    else if (command === 'open') output = open(opts);
    else if (opts.help) output = 'Usage: new-session.mjs detect|dispatch --message TEXT|start [--entry slash|sentence] [--goal TEXT]|brief|open PATH|open --rules';
    else throw new Refusal('expected detect, dispatch, start, brief or open');
    if (output) process.stdout.write(capOutput(redact(output), {max: detect ? 300 : 4000, label: command}));
    return 0;
  } catch (error) {
    if (detect) return 0;
    if (error instanceof Refusal) {
      process.stderr.write(capOutput(capText(redact(`new-session refused: ${error.message}\nAsk how to proceed. Waiting for your go.`), 4000), {label: 'refusal'}));
      return 1;
    }
    let log = 'unavailable';
    try {
      const dir = path.join(os.tmpdir(), 'memory-session');
      fs.mkdirSync(dir, {recursive: true});
      log = path.join(dir, `failure-${Date.now()}-${process.pid}.log`);
      fs.writeFileSync(log, redact(error.stack || String(error)));
    } catch { log = 'unavailable'; }
    process.stderr.write(capOutput(redact(`new-session helper failed: ${error.message}; log: ${log}\nAsk how to proceed. Waiting for your go.`), {label: 'failure'}));
    return 1;
  }
}
if (isDirect(import.meta.url)) process.exitCode = await main();
