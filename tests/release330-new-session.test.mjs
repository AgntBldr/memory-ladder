import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fixture, put, read, tree, kitRoot, ok} from './helpers.mjs';
import {loadConfig, memoryLocation, memorySlug} from '../engine/lib.mjs';
import {stateToken} from '../engine/session-core.mjs';
import {start, open, FIRST_REPLY_TEMPLATE} from '../engine/new-session.mjs';

const phrase = 'We are starting a new session - read this and let me know when we can start';
const helper = path.join(kitRoot, 'engine/new-session.mjs');

test('real start first line and template describe the same ordered segments', t => {
  const f = session(t);
  const line = ok(f.cli(['start'])).stdout.split('\n')[0];
  assert.match(line, /^.+ \| .+@\S+ \| \d+ changed, \d+ untracked \| (no upstream|\d+ ahead) \| kit \S+( \| flags: .+)?$/);
  const template = FIRST_REPLY_TEMPLATE.split('\n')[0];
  assert.equal(template, '**<abs path>** - `<branch>` @ `<sha>` - kit <version>[ - flags: ...]');
  assert.equal(FIRST_REPLY_TEMPLATE.split('\n')[1], '- Git: <n> changed, <n> untracked; <n> ahead|no upstream');
  const [folder, revision, changes, upstream, version] = line.split(' | ');
  assert.equal(folder, f.target); assert.match(revision, /@\S+$/);
  assert.match(changes, /^\d+ changed, \d+ untracked$/); assert.match(upstream, /^(no upstream|\d+ ahead)$/); assert.match(version, /^kit /);
  assert.equal(read(path.join(kitRoot, 'skills/new-session/SKILL.md')).split('\n').find(line => line.startsWith('**<abs path>**')), template);
});

test('start line one carries flags while retaining signal details', t => {
  const f = session(t);
  const output = ok(f.cli(['start'])).stdout;
  assert.match(output.split('\n')[0], /\| flags: other session/);
  assert.match(output, /possible other session: memory changed/);
  const old = new Date(Date.now() - 7200000);
  fs.utimesSync(f.memoryDir, old, old);
  assert.doesNotMatch(ok(f.cli(['start'])).stdout.split('\n')[0], /\| flags:/);
  const worktree = path.join(f.root, 'other');
  f.git(f.target, 'worktree', 'add', '-b', 'other', worktree);
  const other = ok(f.exec(process.execPath, [helper, 'start', '--repo', worktree])).stdout;
  assert.match(other.split('\n')[0], /\| flags: other session, worktree/);
  assert.match(other, /worktree of /);
});
test('start counts a staged rename once', t => {
  const f = session(t);
  f.git(f.target, 'mv', 'AGENTS.md', 'renamed.md');
  assert.match(ok(f.cli(['start'])).stdout.split('\n')[0], /\| 1 changed, 0 untracked \|/);
});

test('subfolder cwd uses environment or installed repo, never payload cwd', t => {
  const f = session(t), installed = path.join(f.target, 'scripts/memory');
  for (const name of fs.readdirSync(path.join(kitRoot, 'engine')).filter(name => name.endsWith('.mjs'))) fs.copyFileSync(path.join(kitRoot, 'engine', name), path.join(installed, name));
  const sub = path.join(f.target, 'scripts'), input = JSON.stringify({prompt: phrase, cwd: sub});
  for (const withEnv of [false, true]) {
    const env = {...f.env}; delete env.CLAUDE_PROJECT_DIR;
    if (withEnv) env.CLAUDE_PROJECT_DIR = f.target;
    const result = ok(f.exec(process.execPath, [path.join(installed, 'new-session.mjs'), 'detect'], {cwd: sub, input, env}));
    assert.match(result.stdout, /Invoke the Skill tool/);
  }
});
test('other notes retain both full paths and branches within 240 bytes', t => {
  const f = session(t), dir = path.join(f.root, 'm'.repeat(90 - f.root.length - 1));
  assert.equal(dir.length, 90); fs.renameSync(f.memoryDir, dir);
  for (let i = 1; i <= 3; i++) {
    const file = f.note(i), text = read(file).replace('topic-' + i, String(i).repeat(40)).replace('question-' + i, 'q'.repeat(60));
    put(path.join(dir, 'handovers', path.basename(file)), text);
  }
  const output = ok(f.cli(['start', '--memory-dir', dir])).stdout;
  const other = output.slice(output.indexOf('other (possible parallel):')).split('\n').slice(0, 3).join('\n');
  assert.ok(Buffer.byteLength(other) <= 240);
  for (const i of [1, 2]) {
    assert.ok(other.includes(String(i).repeat(40)));
    assert.ok(other.includes(`handovers/00000${i}-2026-01-01-1200.md`));
  }
});
test('oversized overlay is parsed and reported as a conflict', t => {
  const f = session(t);
  put(path.join(f.target, 'AGENTS.md'), '## Session overlay\nrules: rules.md\nroadmap: plan.md | section: Open\n' + 'x'.repeat(1500));
  put(path.join(f.target, 'plan.md'), '## Open\nretained roadmap\n');
  const output = ok(f.cli(['start'])).stdout;
  assert.match(output, /conflicts:.*overlay over 1,500 B/); assert.match(output, /retained roadmap/); assert.match(output, /open --rules/);
});
test('overlay log and roadmap cannot read outside repo', t => {
  const f = session(t), outside = put(path.join(f.root, 'secret.txt'), '## Open\nPRIVATE_FIXTURE_VALUE\n');
  for (const value of ['../secret.txt', outside]) {
    put(path.join(f.target, 'AGENTS.md'), `## Session overlay\nlog: ${value}\nroadmap: ${value} | section: Open\n`);
    const output = ok(f.cli(['start'])).stdout;
    assert.doesNotMatch(output, /PRIVATE_FIXTURE_VALUE/);
    assert.match(output, /conflicts:.*overlay log outside repo: ignored.*overlay roadmap outside repo: ignored/);
  }
});
test('open refuses git segments in memory and brain', t => {
  const f = session(t);
  for (const root of [f.memoryDir, path.join(f.target, 'brain')]) {
    const file = put(path.join(root, '.git/config'), 'PRIVATE_GIT_VALUE');
    const result = f.cli(['open', file]);
    assert.equal(result.status, 1); assert.match(result.stderr, /open refuses .git paths/); assert.doesNotMatch(result.stdout, /PRIVATE_GIT_VALUE/);
  }
});
test('handover window follows installed config', t => {
  const f = session(t); f.note(1, new Date(Date.now() - 2 * 3600000).toISOString()); f.note(2);
  f.config.caps.handovers.windowHours = 1;
  put(path.join(f.target, 'scripts/memory/memory.config.json'), JSON.stringify(f.config));
  const output = ok(f.cli(['start'])).stdout;
  assert.match(output, /topic-2/); assert.doesNotMatch(output, /topic-1/);
});
test('gate matches SessionStart quick counts', async t => {
  const f = session(t), {runCheck, counts} = await import('../engine/memory-check.mjs');
  put(path.join(f.memoryDir, 'topic.md'), '---\nname: fixture\ndescription: fixture description\n---\n' + 'x'.repeat(2500));
  const options = {repo: f.target, memoryDir: f.memoryDir, config: f.config};
  const quick = counts(runCheck({...options, quick: true})), full = counts(runCheck(options));
  assert.notEqual(quick.WARN, full.WARN);
  assert.ok(ok(f.cli(['start'])).stdout.includes(`gate: ${quick.FAIL} FAIL, ${quick.WARN} WARN, ${quick.allowed} allowed`));
});
test('legacy RESUME HERE is undated state with next action', t => {
  const f = session(t);
  put(path.join(f.memoryDir, 'current-state.md'), '---\nmodified: 2000-01-01\n---\n# RESUME HERE\nLegacy state\n**Next action:** inspect fixture\n');
  const output = ok(f.cli(['start'])).stdout;
  assert.match(output, /undated/); assert.match(output, /Legacy state/); assert.match(output, /Next action: inspect fixture/); assert.doesNotMatch(output, /state: none recorded|stale 2000/);
});
test('crash writes one stack log and leaves all other bytes unchanged', t => {
  const f = session(t), tmp = path.join(f.root, 'tmp'); fs.mkdirSync(tmp);
  put(path.join(f.memoryDir, 'crash.md'), 'fixture');
  const preload = put(path.join(f.root, 'crash.cjs'), "const fs = require('node:fs'); const read = fs.readFileSync; fs.readFileSync = function(file, ...args) { if (String(file).endsWith('crash.md')) throw Error('injected unexpected failure'); return read.call(this, file, ...args); };\n");
  const before = tree(f.root, {git: true}), env = {...f.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, NODE_OPTIONS: '--require ' + JSON.stringify(preload)};
  const result = f.cli(['open', 'crash.md'], undefined, {env});
  assert.equal(result.status, 1);
  const log = /new-session helper failed: .*injected unexpected failure; log: ([^\r\n]+)/.exec(result.stderr)?.[1];
  assert.ok(log, result.stderr); assert.equal(path.dirname(log), path.join(tmp, 'memory-session'));
  assert.match(read(log), /Error: .*injected unexpected failure\n\s+at/);
  const after = tree(f.root, {git: true}); delete after[path.relative(f.root, log).replaceAll('\\', '/')];
  assert.deepEqual(after, before);
});
test('memory resolver opt-out skips project listing and preserves default fallback', t => {
  const f = session(t), config = path.join(f.target, 'scripts/memory/memory.config.json'); fs.unlinkSync(config);
  for (const [key, value] of Object.entries({USERPROFILE: f.home, HOME: f.home, CLAUDE_MEMORY_DIR: ''})) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const projects = path.join(f.home, '.claude/projects'), slug = memorySlug(f.target), alternate = path.join(projects, slug.toUpperCase(), 'memory');
  fs.mkdirSync(alternate, {recursive: true});
  const exists = fs.existsSync, readDir = fs.readdirSync, exact = path.join(projects, slug, 'memory'); let scans = 0;
  t.mock.method(fs, 'existsSync', file => String(file) === exact ? false : exists(file));
  t.mock.method(fs, 'readdirSync', (dir, ...args) => { if (dir === projects) scans++; return readDir(dir, ...args); });
  assert.equal(memoryLocation(f.target, undefined, {list: false}).dir, null); assert.equal(scans, 0);
  assert.equal(memoryLocation(f.target).dir, alternate); assert.equal(scans, 1);
  t.mock.method(fs, 'readdirSync', () => { throw Error('denied'); });
  assert.doesNotThrow(() => memoryLocation(f.target, undefined, {list: false}));
});
const hash = text => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
function session(t) {
  const f = fixture(t), memoryDir = path.join(f.target, 'memory'), config = loadConfig(), files = {};
  config.memory = {inRepoDir: 'memory'};
  put(path.join(f.target, 'scripts/memory/memory.config.json'), JSON.stringify(config));
  put(path.join(f.target, 'scripts/memory/KIT.json'), JSON.stringify({version: config.engine_version}));
  for (const skill of ['new-session', 'handover']) {
    const relative = `.claude/skills/${skill}/SKILL.md`, text = '# Fixture skill\nRead the helper output.\n';
    put(path.join(f.target, relative), text); files[relative] = hash(text);
  }
  put(path.join(f.target, 'scripts/memory/MANIFEST.json'), JSON.stringify({files}));
  put(path.join(memoryDir, 'MEMORY.md'), '# Memory\n');
  put(path.join(f.target, '.gitignore'), 'memory/.memory.lock\n');
  f.git(f.target, 'add', '.'); f.git(f.target, 'commit', '-m', 'fixture');
  const cli = (args, input, options = {}) => f.exec(process.execPath, [helper, ...args, '--repo', f.target], {input, ...options});
  const note = (seq, time = new Date().toISOString(), body = '') => put(path.join(memoryDir, 'handovers', `${String(seq).padStart(6, '0')}-2026-01-01-1200.md`), `---\ntime: ${time}\nbranch: topic-${seq}\nsha: abcdefa\nmode: full\n---\n**Open question:** question-${seq}\n**State:** state-${seq}\n**Waits on the user:** none\n**Next action:** step-${seq}\n${body}`);
  return {...f, memoryDir, cli, note, config};
}
for (const [name, input] of [['bad JSON', '{bad'], ['empty', ''], ['oversize', 'x'.repeat(5 * 1024 * 1024)]]) test(`${name} exits zero silent under 700ms`, async t => {
  const f = session(t), before = performance.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, 'detect', '--repo', f.target], {cwd: f.target, env: f.env, windowsHide: true});
    let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.on('error', reject); child.on('close', status => resolve({status, stdout, stderr}));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
  assert.equal(result.status, 0); assert.equal(result.stdout + result.stderr, ''); assert.ok(performance.now() - before < 700);
});
test('open stdin ends silently at the one-second deadline', async t => {
  const f = session(t), before = performance.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, 'detect', '--repo', f.target], {cwd: f.target, env: f.env, windowsHide: true});
    let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.on('error', reject); child.on('close', code => resolve({code, stdout, stderr}));
    child.stdin.on('error', () => {}); child.stdin.write('{');
  });
  const elapsed = performance.now() - before;
  assert.equal(result.code, 0); assert.equal(result.stdout + result.stderr, ''); assert.ok(elapsed >= 900 && elapsed < 3000, String(elapsed));
});
test('BOM envelope is bounded and never repeats goal or note', t => {
  const f = session(t);
  for (const prompt of [phrase + '\nGoal: private payload', 'quick handover\nNote: private payload']) {
    const result = ok(f.cli(['detect'], '\uFEFF' + JSON.stringify({prompt})));
    assert.equal(result.stderr, ''); assert.ok(Buffer.byteLength(result.stdout) <= 300); assert.doesNotMatch(result.stdout, /private payload/);
    const envelope = JSON.parse(result.stdout); assert.equal(envelope.hookSpecificOutput.hookEventName, 'UserPromptSubmit'); assert.match(envelope.hookSpecificOutput.additionalContext, /Invoke the Skill tool/);
  }
});
test('ownership is per installed skill and normalizes EOL', t => {
  const f = session(t), skill = path.join(f.target, '.claude/skills/new-session/SKILL.md'), manifest = path.join(f.target, 'scripts/memory/MANIFEST.json');
  put(skill, read(skill).replaceAll('\n', '\r\n')); assert.ok(f.cli(['detect'], JSON.stringify({prompt: phrase})).stdout);
  fs.appendFileSync(skill, 'edited'); assert.equal(f.cli(['detect'], JSON.stringify({prompt: phrase})).stdout, '');
  assert.ok(f.cli(['detect'], JSON.stringify({prompt: 'handover'})).stdout);
  put(manifest, JSON.stringify({files: {'skills/new-session/SKILL.md': hash(read(skill))}}));
  assert.equal(f.cli(['detect'], JSON.stringify({prompt: phrase})).stdout, '');
  assert.equal(f.cli(['detect'], JSON.stringify({prompt: 'handover'})).stdout, '');
  put(manifest, '{bad'); assert.equal(f.cli(['detect'], JSON.stringify({prompt: phrase})).stdout, '');
});
test('slash quoted and agent inputs remain silent', t => {
  const f = session(t);
  for (const payload of [phrase, [phrase], null, {prompt: '/new-session'}, {prompt: '"' + phrase + '"'}, {prompt: phrase, agent_id: null}, {prompt: 'handover', agent_type: ''}]) assert.equal(f.cli(['detect'], JSON.stringify(payload)).stdout, '');
});
// Literal first-reply contract shared by the skill and helper.
test('exact first-reply template constant', () => {
  assert.equal(FIRST_REPLY_TEMPLATE, `**<abs path>** - \`<branch>\` @ \`<sha>\` - kit <version>[ - flags: ...]
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

Waiting for your go.`);
});
test('start and dispatch preserve project memory and temp bytes', t => {
  const f = session(t); f.note(1);
  const tmp = path.join(f.root, 'tmp'); fs.mkdirSync(tmp);
  const env = {...f.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp}, before = tree(f.root, {git: true});
  for (const args of [['start', '--entry', 'slash', '--goal', "don't break it"], ['start', '--entry', 'sentence'], ['dispatch', '--message', phrase]]) {
    const result = ok(f.cli(args, undefined, {env})); assert.equal(result.stderr, ''); assert.match(result.stdout, /Waiting for your go\.$/); assert.deepEqual(tree(f.root, {git: true}), before);
  }
  for (const name of fs.readdirSync(path.join(kitRoot, 'engine')).filter(name => name.endsWith('.mjs'))) fs.copyFileSync(path.join(kitRoot, 'engine', name), path.join(f.target, 'scripts/memory', name));
  const installedBefore = tree(f.root, {git: true});
  const installed = ok(f.exec(process.execPath, [path.join(f.target, 'scripts/memory/new-session.mjs'), 'start'], {cwd: f.root, env}));
  assert.ok(installed.stdout.startsWith(f.target)); assert.deepEqual(tree(f.root, {git: true}), installedBefore);
});
test('newest seq leads, two recent others, CURRENT wins only when newer', t => {
  const f = session(t), now = Date.now(), recent = new Date(now - 3600000).toISOString();
  f.note(1, recent); f.note(2, recent); f.note(3, '2020-01-01T00:00:00Z'); f.note(4, '2020-01-01T00:00:00Z');
  let output = ok(f.cli(['start'])).stdout;
  assert.match(output, /last handover: 2020-01-01T00:00:00Z @abcdefa topic-4 - state-4/); assert.match(output, /Q: question-4/);
  assert.match(output, /topic-2/); assert.match(output, /topic-1/); assert.doesNotMatch(output, /topic-3|commits.since|credit:/i);
  const current = path.join(f.memoryDir, 'current-state.md');
  put(current, '## CURRENT\n**2021-01-01 12:00 | @defabca | quick. manual state**\n**Open question:** manual question\n');
  output = ok(f.cli(['start'])).stdout; assert.match(output, /last handover: 2021-01-01 12:00 @defabca - manual state/); assert.match(output, /older note:/); assert.match(output, new RegExp('token: ' + stateToken(f.memoryDir)));
  put(current, read(current).replace('2021-', '2019-')); assert.match(ok(f.cli(['start'])).stdout, /last handover: 2020-01-01T/);
  fs.rmSync(path.join(f.memoryDir, 'handovers'), {recursive: true}); assert.match(ok(f.cli(['start'])).stdout, /last handover: 2019-01-01/);
});
test('stale direction undated and missing states', t => {
  const f = session(t), file = path.join(f.memoryDir, 'current-state.md');
  assert.match(ok(f.cli(['start'])).stdout, /state: none recorded/);
  put(file, '---\nmodified: 2000-01-01\n---\n## CURRENT\nLegacy state\n'); assert.match(ok(f.cli(['start'])).stdout, /stale 2000-01-01 vs HEAD/);
  put(file, read(file).replace('2000-', '2099-')); assert.doesNotMatch(ok(f.cli(['start'])).stdout, /stale 2099-/);
  put(file, '## CURRENT\nLegacy state\n'); assert.match(ok(f.cli(['start'])).stdout, /undated/);
  fs.rmSync(f.memoryDir, {recursive: true}); const output = ok(f.cli(['start'])).stdout;
  assert.match(output, /memory dir not found/); assert.match(output, /memory-init\.mjs - yes or no/);
  fs.rmSync(path.join(f.target, 'scripts/memory'), {recursive: true}); assert.match(ok(f.cli(['start'])).stdout, /no memory kit here/);
});
test('operation lock is only a possible session and unpushed commits are named', t => {
  const f = session(t); f.git(f.target, 'branch', 'upstream'); f.git(f.target, 'branch', '--set-upstream-to=upstream');
  put(path.join(f.target, 'work.txt'), 'new'); f.git(f.target, 'add', 'work.txt'); f.git(f.target, 'commit', '-m', 'ahead');
  put(path.join(f.memoryDir, '.memory.lock'), 'operation');
  const output = ok(f.cli(['start'])).stdout;
  assert.match(output, /possible other session: \.memory.lock \(operation lock\)/); assert.match(output, /unpushed: 1 project commits/);
});
test('worktree evidence and overlay conflicts are explicit', t => {
  const f = session(t), work = path.join(f.root, 'worktree');
  f.git(f.target, 'worktree', 'add', '-b', 'other', work);
  put(path.join(work, 'AGENTS.md'), '## Session overlay\nmain-only: yes\nbranch: expected\n');
  const result = ok(f.exec(process.execPath, [helper, 'start', '--repo', work], {cwd: work}));
  assert.match(result.stdout, /worktree of/); assert.match(result.stdout, /possible other session: multiple worktrees/); assert.match(result.stdout, /conflicts:/);
});
test('dispatch checks ownership and the received quotes, handover never writes', t => {
  const f = session(t);
  assert.equal(f.cli(['dispatch', '--message', '"' + phrase + '"']).stdout, '');
  assert.ok(f.cli(['dispatch', '--message', phrase]).stdout);
  const before = tree(f.root); const handover = ok(f.cli(['dispatch', '--message', 'quick handover\nNote: saved'])).stdout;
  assert.match(handover, /Read \.claude\/skills\/handover\/SKILL.md.*quick/); assert.deepEqual(tree(f.root), before);
  fs.appendFileSync(path.join(f.target, '.claude/skills/new-session/SKILL.md'), 'foreign'); assert.equal(f.cli(['dispatch', '--message', phrase]).stdout, '');
});
test('digest caps redact and preserve the closing instruction with large inputs', t => {
  const f = session(t), secret = 'sk-' + 'A'.repeat(40);
  put(path.join(f.memoryDir, 'current-state.md'), '## CURRENT\n' + secret + '\n' + '\u754c'.repeat(7000));
  for (let i = 1; i <= 25; i++) f.note(i, new Date().toISOString(), i === 25 ? 'x'.repeat(7000) : '\u754c'.repeat(700));
  put(path.join(f.target, 'AGENTS.md'), '## Session overlay\nlog: log.md, 1 lines\nroadmap: plan.md | section: Open\n');
  put(path.join(f.target, 'log.md'), 'line '.repeat(10000)); put(path.join(f.target, 'plan.md'), '## Open\n' + 'row '.repeat(10000));
  f.git(f.target, 'branch', '-m', 'b'.repeat(120));
  const result = ok(f.cli(['start', '--goal', secret + 'x'.repeat(300)]));
  assert.ok(Buffer.byteLength(result.stdout) <= 4000); assert.match(result.stdout, /\[cut\]/); assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret)); assert.match(result.stdout, /Waiting for your go\.$/);
  assert.equal((result.stdout.match(/^FAIL /gm) ?? []).length, 2);
  assert.ok(result.stdout.includes('token: ' + stateToken(f.memoryDir)));
  assert.ok(Buffer.byteLength(ok(f.cli(['brief'])).stdout) <= 3500);
});
test('three selected bodies only; archives are gate-only reads', async t => {
  const f = session(t); for (let i = 1; i <= 4; i++) f.note(i);
  const readFile = fs.readFileSync, stackReads = [];
  t.mock.method(fs, 'readFileSync', (file, ...args) => { if (String(file).includes('handovers') && new Error().stack.includes('listNotes')) stackReads.push(file); return readFile(file, ...args); });
  await start({repo: f.target}); assert.equal(stackReads.length, 3); assert.ok(!stackReads.some(file => file.includes('000001-')));
});
test('core followups rules and two recall files fit executed budget', t => {
  const f = session(t), rules = put(path.join(f.root, 'rules.md'), '\u754c'.repeat(2000));
  put(path.join(f.target, 'AGENTS.md'), `## Session overlay\nrules: ${rules}\nboard: read-only example\ncheck: read-only example\n`);
  for (let i = 0; i < 50; i++) put(path.join(f.memoryDir, `topic-${i}.md`), '---\nname: topic\ndescription: Zebras testing context.\n---\n' + 'zebras '.repeat(1000));
  const envelope = ok(f.cli(['detect'], JSON.stringify({prompt: phrase}))).stdout;
  const initial = ok(f.cli(['start', '--goal', 'zebras']));
  const calls = [...initial.stdout.matchAll(/open (--rules|"[^"\n]+")/g)].map(m => m[1] === '--rules' ? ['open', '--rules'] : ['open', JSON.parse(m[1])]);
  assert.equal(calls.length, 3); let bytes = Buffer.byteLength(envelope) + Buffer.byteLength(initial.stdout + initial.stderr) + 1536 + 1280 + 320;
  for (const call of calls) { const result = ok(f.cli(call)); assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 4000); bytes += Buffer.byteLength(result.stdout + result.stderr); }
  assert.ok(bytes <= 14508, String(bytes));
});
test('failing git and unreadable memory produce bounded diagnostics', t => {
  const f = session(t), env = {...f.env, PATH: ''};
  const result = ok(f.cli(['start'], undefined, {env})); assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 4000); assert.match(result.stdout, /unknown/);
  fs.rmSync(f.memoryDir, {recursive: true}); put(f.memoryDir, 'not a folder'); assert.match(ok(f.cli(['start'])).stdout, /memory dir not found/);
});
test('open caps bytes allows a note and refuses outside paths and junction escapes', t => {
  const f = session(t), file = f.note(1, new Date().toISOString(), '\u754c'.repeat(2000));
  const result = ok(f.cli(['open', file])); assert.ok(Buffer.byteLength(result.stdout) <= 1536); assert.match(result.stdout, /\[cut\]$/); assert.ok(!result.stdout.includes('\ufffd'));
  const outside = put(path.join(f.root, 'outside.md'), 'outside'); assert.equal(f.cli(['open', outside]).status, 1);
  assert.equal(f.cli(['open', '../outside.md']).status, 1);
  const junction = path.join(f.memoryDir, 'escape');
  fs.symlinkSync(f.root, junction, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(f.cli(['open', path.join(junction, 'outside.md')]).status, 1); fs.unlinkSync(junction);
});
test('rules use overlay path and full-file marker; all errors are capped redacted', t => {
  const f = session(t), secret = 'sk-' + 'B'.repeat(40), rules = put(path.join(f.root, 'rules.md'), secret + '\n' + '\u754c'.repeat(2000));
  put(path.join(f.target, 'AGENTS.md'), `## Session overlay\nrules: ${rules}\n`);
  const output = ok(f.cli(['open', '--rules'])).stdout;
  assert.ok(Buffer.byteLength(output) <= 4000); assert.match(output, /\[cut; full file: .*rules\.md\]$/); assert.doesNotMatch(output, new RegExp(secret));
  const result = f.cli(['open', secret + 'x'.repeat(6000)]); assert.equal(result.status, 1); assert.ok(Buffer.byteLength(result.stderr) <= 4000); assert.doesNotMatch(result.stderr, new RegExp(secret));
  assert.throws(() => open({repo: f.target, _: ['open', path.join(f.memoryDir, 'MEMORY.md')]}), /archives and generated/);
});
