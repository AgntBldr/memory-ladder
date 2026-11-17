// Kit 3.3.5 D1: the checkpoint says which folders it wrote into (spec Part 2, D1). Every run prints first
// `checkpoint: repo <canonical checkout>; memory <canonical memory folder> (<source>)`; a run against external memory ends
// with `repo files changed in <checkout>: <list> - commit them in that checkout` (`none` when nothing changed); a dry run
// prints `would change: <list>`. The list is what THIS invocation changed: an unrelated dirty path is never in it.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {kitRoot} from './helpers.mjs';
import {loadConfig, memorySlug} from '../engine/lib.mjs';
import {writeMemoryIndex} from '../engine/memory-index.mjs';
import {newLesson} from '../engine/memory-lesson.mjs';
import {generateOverview} from '../engine/roadmap-overview.mjs';
import {rotateLog, rotateHandovers} from '../engine/memory-rotate.mjs';
import * as S from '../engine/memory-session.mjs';
import * as cp from '../engine/memory-checkpoint.mjs';

const junction = (target, link) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
const topic = name => `---\nname: ${name}\ndescription: "${name} notes kept for the fixture."\nmetadata:\n  type: reference\n  route: craft\n---\n\n# ${name}\n\nBody of ${name}.\n`;
const ROUTER = '# Memory\n\n## Routing\n- [Craft](INDEX-craft.md) OPEN BEFORE testing.\n- [Ops](INDEX-ops.md) OPEN BEFORE operating.\n\n## Active work\n- [Current](current-state.md) OPEN BEFORE resuming.\n';
const CURRENT = '---\nname: current-state\ndescription: "Current task, next action and checkpoint handoff."\nmetadata:\n  type: project\n  state: true\n---\n\n## CURRENT\nold state\n';
const TODAY = '2026-11-12';
const ORIGINAL_ENV = Object.fromEntries(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'CLAUDE_MEMORY_DIR', 'HOME', 'USERPROFILE'].map(key => [key, process.env[key]]));
after(() => { for (const [key, value] of Object.entries(ORIGINAL_ENV)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
// A token the gate refuses, spelled in two pieces so this file never holds one.
const SECRET = 'gh' + 'p_' + 'A'.repeat(40);

function tree(dir, skip) {
  const out = {};
  const walk = rel => { for (const e of fs.readdirSync(path.join(dir, rel), {withFileTypes: true})) {
    const next = rel ? rel + '/' + e.name : e.name;
    if (skip(next, e.name)) continue;
    if (e.isDirectory()) walk(next); else if (e.isFile()) out[next] = fs.readFileSync(path.join(dir, next)).toString('base64');
  } };
  walk('');
  return out;
}
const diff = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(key => a[key] !== b[key]).sort();

// A project checkout on branch main, an external memory folder at the default location, optional brain and rotation setup.
function world(t, {mode = 'all', inRepo = false, brain = false, rotate = false, roadmap = true, remote = false, logPath = 'brain/00-system/log.md'} = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kit335d1-')));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const gitconfig = path.join(home, '.gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n name = kit-test\n email = kit-test@example.invalid\n[core]\n autocrlf = false\n longpaths = true\n[init]\n defaultBranch = main\n');
  // The newest fixture's home and git identity are the process's; the file's own after hook gives the original back.
  for (const [key, value] of Object.entries({GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', CLAUDE_MEMORY_DIR: undefined, HOME: home, USERPROFILE: home})) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => fs.rmSync(root, {recursive: true, force: true, maxRetries: 5}));
  const git = (dir, ...argv) => {
    const r = spawnSync('git', ['-C', dir, ...argv], {encoding: 'utf8', env: process.env});
    assert.equal(r.status, 0, `git ${argv.join(' ')}: ${r.stdout}${r.stderr}`);
    return r.stdout.trim();
  };
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, text); return file; };
  const project = path.join(root, 'project');
  fs.mkdirSync(project); git(project, 'init', '-b', 'main');
  const config = loadConfig();
  config.caps.checkpoint = {mode};
  if (rotate) { config.caps.brainLog.keepEntries = 3; config.caps.roadmap.keepBlocks = 2; config.caps.handovers.keepNotes = 2; }
  config.caps.brainLog.path = logPath;
  if (inRepo) config.memory = {inRepoDir: 'memory'};
  const configFile = path.join(project, 'scripts/memory/memory.config.json');
  put(configFile, JSON.stringify(config, null, 2) + '\n');
  put(path.join(project, 'scripts/memory/KIT.json'), JSON.stringify({version: config.engine_version}) + '\n');
  put(path.join(project, 'AGENTS.md'), '# Project\n');
  put(path.join(project, '.gitignore'), '.memory.lock*\n.memory.push.lock*\n.sessions/\n');
  if (roadmap) put(path.join(project, 'docs/ROADMAP.md'), '# Roadmap\n\n## Open work\n\n' + (rotate ? [1, 2, 3, 4, 5].map(n => `**2026-11-0${n}** block ${n}\n\n`).join('') : '**2026-11-01** first block\n\n**2026-11-02** second block\n\n'));
  if (brain) {
    put(path.join(project, logPath), '# Log\n\n' + (rotate ? ['2026-09-10', '2026-09-20', '2026-10-01', '2026-10-05', '2026-10-20', '2026-11-01'] : ['2026-11-01', '2026-11-02']).map(d => `## [${d}] note | entry ${d}\nBody.\n\n`).join(''));
    put(path.join(project, 'brain/01-pillars/pil-test.md'), '---\nid: pil-test\ntype: pillar\nstatus: active\nsummary: The fixture pillar.\nupdated: 2026-11-01\n---\n\n# Pillar\n');
  }
  const memoryDir = inRepo ? path.join(project, 'memory') : path.join(home, '.claude/projects', memorySlug(project), 'memory');
  put(path.join(memoryDir, '.gitignore'), '.memory.lock*\n.memory.push.lock*\n.sessions/\n');
  put(path.join(memoryDir, 'MEMORY.md'), ROUTER);
  put(path.join(memoryDir, 'current-state.md'), CURRENT);
  for (const name of ['alpha', 'beta']) put(path.join(memoryDir, `topic-${name}.md`), topic(`topic-${name}`));
  if (rotate) for (const [n, time] of [[1, '2026-08-01'], [2, '2026-08-02'], [3, '2026-09-01'], [4, '2026-09-02']])
    put(path.join(memoryDir, `handovers/00000${n}-${time}-1200.md`), `---\ntime: ${time}T12:00:00+00:00\nbranch: topic\nsha: abcdefa\nmode: full\n---\n**Open question:** none\nnote ${n}\n`);
  writeMemoryIndex({memoryDir, config});
  git(project, 'add', '.'); git(project, 'commit', '-m', 'project seed');
  if (!inRepo) { git(memoryDir, 'init', '-b', 'main'); git(memoryDir, 'add', '.'); git(memoryDir, 'commit', '-m', 'memory seed'); }
  if (remote) {
    const bare = path.join(root, 'remote.git'); git(root, 'init', '--bare', '-b', 'main', bare);
    git(memoryDir, 'remote', 'add', 'origin', bare); git(memoryDir, 'push', '-q', '-u', 'origin', 'main');
  }
  const w = {root, home, project, memoryDir, config, configFile, git, put, inRepo};
  w.lesson = (title, repo = project) => {
    const file = newLesson({memoryDir, repo, config, title, route: 'craft', kind: 'practice', today: TODAY});
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('description: "TODO"', `description: "${title} explained for the fixture."`).replace('**Why:**\n', '**Why:**\nBecause the fixture needs it.\n').replace('**How to apply:**', '**How to apply:**\nApply it in the test.'));
    return path.basename(file);
  };
  const base = ['--repo', project, '--memory-dir', memoryDir, '--config', configFile, '--today', TODAY];
  // The command line in this process, with every line of both streams in the order it was printed.
  w.run = (argv, {withBase = true, env = {}} = {}) => {
    const lines = [], out = [], err = [], log = console.log, error = console.error, before = {};
    for (const [key, value] of Object.entries(env)) { before[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    console.log = (...a) => { const line = a.map(String).join(' '); lines.push(line); out.push(line); };
    console.error = (...a) => { const line = a.map(String).join(' '); lines.push(line); err.push(line); };
    let status;
    try { status = cp.main([...(withBase ? base : []), ...argv]); }
    finally {
      console.log = log; console.error = error;
      for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
    return {status, lines, out, err};
  };
  // The same command as a real process: its own stdout and stderr, and its exit status.
  w.cli = (argv, {env = {}, cwd = root} = {}) => spawnSync(process.execPath, [path.join(kitRoot, 'engine/memory-checkpoint.mjs'), ...base, ...argv], {encoding: 'utf8', cwd, env: {...process.env, ...env}});
  // Programmatic call, as /handover and the other tests make it.
  w.save = (opts = {}) => {
    const lines = [];
    const result = cp.checkpoint({memoryDir, repo: project, config, today: TODAY, noPush: true, report: (step, message) => lines.push(`${step}: ${message}`), ...opts});
    return {result, lines};
  };
  w.memoryTree = (dir = memoryDir) => tree(dir, (rel, name) => name === '.git' || name === '.sessions' || /^\.memory\.(?:push\.)?lock/.test(name));
  w.repoTree = () => tree(project, (rel, name) => name === '.git' || (inRepo && rel === 'memory'));
  w.header = (source = '--memory-dir') => `checkpoint: repo ${project}; memory ${memoryDir} (${source})`;
  // Every ref, the index entries and the status of the repository that holds the memory.
  w.refs = () => { const holder = inRepo ? project : memoryDir; return [git(holder, 'rev-parse', 'HEAD'), git(holder, 'for-each-ref'), git(holder, 'ls-files', '--stage'), git(holder, 'status', '--porcelain')].join('\n--\n'); };
  // Every path a call writes, renames, removes or links, from the file-system functions that change anything. A call that
  // reads is not listed; a dry run may write only outside the project and the memory folder.
  w.writesDuring = run => {
    const targets = [], names = {writeFileSync: [0], appendFileSync: [0], mkdirSync: [0], unlinkSync: [0], rmSync: [0], rmdirSync: [0], renameSync: [0, 1], copyFileSync: [1], symlinkSync: [1], linkSync: [1]};
    const mocks = Object.entries(names).map(([name, positions]) => { const original = fs[name]; return t.mock.method(fs, name, function (...a) { for (const at of positions) if (typeof a[at] === 'string') targets.push(path.resolve(a[at])); return original.apply(this, a); }); });
    try { return {result: run(), targets}; } finally { for (const m of mocks) m.mock.restore(); }
  };
  w.inside = file => [project, memoryDir].some(dir => { const rel = path.relative(dir.toLowerCase(), path.resolve(file).toLowerCase()); return !rel.startsWith('..') && !path.isAbsolute(rel); });
  // The paths a run changed, from the bytes before and after.
  w.changed = run => {
    const before = [w.memoryTree(), w.repoTree()];
    const result = run();
    const after = [w.memoryTree(), w.repoTree()];
    return {result, memory: diff(before[0], after[0]), repo: diff(before[1], after[1])};
  };
  return w;
}
const headerLines = lines => lines.filter(line => line.startsWith('checkpoint: repo '));
const repoLine = (w, list) => `repo files changed in ${w.project}: ${list}`;
const lastReport = lines => lines.filter(line => !line.startsWith('memory-checkpoint: ')).at(-1);

// ---- the header ----

for (const [name, argv, setup] of [
  ['an all-sessions run', ['--no-push'], w => w.lesson('Own lesson')],
  ['a dry run', ['--dry-run'], w => w.lesson('Own lesson')],
  ['a session run', ['--session', '--no-push', '--files', 'topic-alpha.md'], w => w.put(path.join(w.memoryDir, 'topic-alpha.md'), topic('topic-alpha') + 'edit\n')],
  ['a session dry run', ['--session', '--dry-run', '--files', 'topic-alpha.md'], w => w.put(path.join(w.memoryDir, 'topic-alpha.md'), topic('topic-alpha') + 'edit\n')],
]) test(`D1 the header is the first line of ${name}, with both folders canonical and the flag as the source, printed once`, t => {
  const w = world(t); setup(w);
  const r = w.run(argv);
  assert.equal(r.status, 0, r.lines.join('\n'));
  assert.equal(r.lines[0], w.header(), r.lines.join('\n'));
  assert.equal(headerLines(r.lines).length, 1, r.lines.join('\n'));
  // The same command as a process: stdout starts with the header.
  const c = w.cli(['--dry-run']);
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.equal(c.stdout.split('\n')[0], w.header());
});

test('D1 a path spelled through a junction, with dot segments or a relative --repo is printed as its real path', t => {
  const w = world(t);
  const aliasMemory = path.join(w.root, 'alias-memory'), aliasProject = path.join(w.root, 'alias-project');
  junction(w.memoryDir, aliasMemory); junction(w.project, aliasProject);
  const spelled = [path.join(w.root, 'nowhere', '..', 'alias-project', '.'), path.join(aliasMemory, 'sub', '..')];
  const through = w.run(['--config', w.configFile, '--repo', spelled[0], '--memory-dir', spelled[1], '--dry-run'], {withBase: false});
  assert.equal(through.status, 0, through.lines.join('\n'));
  assert.equal(through.lines[0], w.header(), through.lines.join('\n'));
  // A relative --repo is resolved against the folder the command ran in.
  const c = spawnSync(process.execPath, [path.join(kitRoot, 'engine/memory-checkpoint.mjs'), '--repo', 'project', '--memory-dir', path.join('home', '.claude/projects', memorySlug(w.project), 'memory'), '--config', w.configFile, '--dry-run'], {encoding: 'utf8', cwd: w.root, env: process.env});
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.equal(c.stdout.split('\n')[0], w.header());
  if (process.platform === 'win32') {
    const lower = w.run(['--repo', w.project.toLowerCase(), '--memory-dir', w.memoryDir.toUpperCase(), '--config', w.configFile, '--dry-run'], {withBase: false});
    assert.equal(lower.lines[0], w.header(), 'the on-disk case is printed, not the case that was typed');
  }
});

test('D1 a memory folder that does not exist yet is printed as an absolute path, and the run keeps its old result', t => {
  const w = world(t);
  const missing = path.join(w.root, 'nowhere', '..', 'later', 'memory');
  const r = w.run(['--repo', w.project, '--memory-dir', missing, '--config', w.configFile], {withBase: false});
  assert.equal(r.lines[0], `checkpoint: repo ${w.project}; memory ${path.join(w.root, 'later', 'memory')} (--memory-dir)`, r.lines.join('\n'));
  assert.equal(r.status, 1, 'the base run fails on a missing memory folder; D1 refuses nothing new and accepts nothing new');
});

test('D1 the source names the flag, the environment, the configuration, KIT.local.json and the default', t => {
  const w = world(t);
  const alias = path.join(w.root, 'alias-memory'); junction(w.memoryDir, alias);
  const rows = [];
  rows.push(['--memory-dir', w.run(['--repo', w.project, '--memory-dir', alias, '--config', w.configFile, '--dry-run'], {withBase: false}), w.memoryDir]);
  rows.push(['CLAUDE_MEMORY_DIR', w.run(['--repo', w.project, '--config', w.configFile, '--dry-run'], {withBase: false, env: {CLAUDE_MEMORY_DIR: alias}}), w.memoryDir]);
  rows.push(['default', w.run(['--repo', w.project, '--config', w.configFile, '--dry-run'], {withBase: false}), w.memoryDir]);
  const local = path.join(w.project, 'scripts/memory/KIT.local.json');
  w.put(local, JSON.stringify({memoryDir: alias}) + '\n');
  rows.push(['KIT.local.json', w.run(['--repo', w.project, '--config', w.configFile, '--dry-run'], {withBase: false}), w.memoryDir]);
  fs.rmSync(local);
  const inside = path.join(w.project, 'memory'); fs.mkdirSync(inside);
  const configured = JSON.parse(fs.readFileSync(w.configFile, 'utf8')); configured.memory = {inRepoDir: 'memory'};
  w.put(w.configFile, JSON.stringify(configured, null, 2) + '\n');
  rows.push(['memory.inRepoDir', w.run(['--repo', w.project, '--config', w.configFile, '--dry-run'], {withBase: false}), inside]);
  for (const [source, r, memory] of rows) assert.equal(r.lines[0], `checkpoint: repo ${w.project}; memory ${memory} (${source})`, `${source}: ${r.lines.join('\n')}`);
});

test('D1 a caller that passes no source is named caller, one that passes it keeps it, and a caller that announced the header is not told twice', t => {
  const w = world(t);
  const plain = w.save();
  assert.equal(plain.lines[0], `checkpoint: repo ${w.project}; memory ${w.memoryDir} (caller)`, plain.lines.join('\n'));
  const named = w.save({memorySource: 'default'});
  assert.equal(named.lines[0], `checkpoint: repo ${w.project}; memory ${w.memoryDir} (default)`);
  const announced = w.save({announced: true});
  assert.equal(headerLines(announced.lines).length, 0, announced.lines.join('\n'));
});

test('D1 a report callback that throws on the header or the last line costs that line, never the run or its result', t => {
  const w = world(t); w.lesson('Own lesson');
  const lines = [];
  const result = cp.checkpoint({memoryDir: w.memoryDir, repo: w.project, config: w.config, today: TODAY, noPush: true, report: (step, message) => {
    if (step === 'checkpoint' || step.startsWith('repo files changed')) throw new Error('report failed');
    lines.push(`${step}: ${message}`);
  }});
  assert.equal(result.status, 0, result.error);
  assert.ok(result.sha, 'the commit was made');
  assert.ok(lines.some(line => line.startsWith('commit: ')), lines.join('\n'));
});

// ---- the header comes first on refusals, failures and exit 3 ----

test('D1 the header is first when the command line is refused, a failure follows it, and the status is the old status', t => {
  const w = world(t);
  const cases = [
    [['--memory-only'], /--memory-only needs session mode/],
    [['--files', 'topic-alpha.md'], /--files and --take need session mode/],
    [['--files-only'], /--files-only needs session mode/],
    [['--today', '2026-13-45'], /invalid --today date/],
    [['--session', '--all'], /choose --session or --all/],
    [['--bogus'], /unknown option --bogus/],
    [['--today'], /Missing --today value/],
    [['--no-such=1'], /is not supported; use --no-such 1/],
  ];
  for (const [argv, message] of cases) {
    const r = w.run(argv);
    assert.equal(r.status, 1, `${argv.join(' ')}: ${r.lines.join('\n')}`);
    assert.equal(r.lines[0], w.header(), `${argv.join(' ')}: ${r.lines.join('\n')}`);
    assert.equal(headerLines(r.lines).length, 1);
    assert.ok(r.err.some(line => message.test(line)), `${argv.join(' ')}: ${r.lines.join('\n')}`);
    // Every refusal, the command line's too, ends the way a run ends: external memory is known, so the files line says none.
    assert.equal(lastReport(r.out), repoLine(w, 'none'), `${argv.join(' ')}: ${r.lines.join('\n')}`);
  }
  // The flags that name the folders still count when another option is refused before them.
  const early = w.run(['--bogus', '--repo', w.project, '--memory-dir', w.memoryDir], {withBase: false});
  assert.equal(early.status, 1); assert.equal(early.lines[0], w.header());
  assert.equal(lastReport(early.out), repoLine(w, 'none'));
  // A command line that asks for a dry run prints no files line when it is refused either.
  const earlyDry = w.run(['--bogus', '--dry-run']);
  assert.equal(earlyDry.status, 1); assert.ok(!earlyDry.lines.some(line => line.startsWith('repo files changed in')), earlyDry.lines.join('\n'));
  // A configuration that cannot be read is refused after the header too.
  const config = w.run(['--repo', w.project, '--memory-dir', w.memoryDir, '--config', path.join(w.root, 'missing.json')], {withBase: false});
  assert.equal(config.status, 1, config.lines.join('\n')); assert.equal(config.lines[0], w.header());
  assert.equal(lastReport(config.out), repoLine(w, 'none'));
  // As a process, stdout starts with the header and the reason is on stderr.
  const c = w.cli(['--memory-only']);
  assert.equal(c.status, 1); assert.equal(c.stdout.split('\n')[0], w.header()); assert.match(c.stderr, /--memory-only needs session mode/);
});

test('D1 the header is first when the memory folder is not found or cannot be resolved', t => {
  const w = world(t);
  const other = path.join(w.root, 'other'); fs.mkdirSync(other); w.git(other, 'init', '-b', 'main');
  const none = w.run(['--repo', other, '--config', w.configFile, '--dry-run'], {withBase: false});
  assert.equal(none.status, 0, none.lines.join('\n'));
  assert.equal(none.lines[0], `checkpoint: repo ${other}; memory not found (default)`);
  assert.ok(none.lines.some(line => /^would change: could not be planned \(/.test(line)), 'a dry run that cannot plan says so and still succeeds: ' + none.lines.join('\n'));
  const real = w.run(['--repo', other, '--config', w.configFile], {withBase: false});
  assert.equal(real.status, 1); assert.equal(real.lines[0], `checkpoint: repo ${other}; memory not found (default)`);
  assert.ok(real.err.some(line => /memory dir not found/.test(line)));
  const bad = JSON.parse(fs.readFileSync(w.configFile, 'utf8')); bad.memory = {inRepoDir: '../outside'};
  w.put(w.configFile, JSON.stringify(bad) + '\n');
  const unresolved = w.run(['--repo', w.project, '--config', w.configFile, '--dry-run'], {withBase: false});
  assert.equal(unresolved.status, 1, unresolved.lines.join('\n'));
  assert.equal(unresolved.lines[0], `checkpoint: repo ${w.project}; memory unresolved (error below)`);
  assert.match(unresolved.err[0], /memory.inRepoDir must name a dedicated folder inside the repo/);
  assert.ok(!unresolved.lines.some(line => line.startsWith('repo files changed in')), 'the memory folder is not known, so there is no external memory to name: ' + unresolved.lines.join('\n'));
  // When the configuration file and the folders both fail, the first failure of the base order is the one reported.
  const both = w.run(['--repo', w.project, '--config', path.join(w.root, 'missing.json'), '--dry-run'], {withBase: false});
  assert.equal(both.status, 1, both.lines.join('\n'));
  assert.match(both.err[0], /Unexpected end of JSON input/, 'the configuration file is read first, as before: ' + both.lines.join('\n'));
  assert.ok(!both.err.some(line => /memory.inRepoDir/.test(line)), both.lines.join('\n'));
});

test('D1 the header is first on a failed run, and on exit 3 the last report is still the files line', t => {
  const w = world(t);
  w.put(path.join(w.memoryDir, 'topic-beta.md'), topic('topic-beta') + SECRET + '\n');
  const failed = w.run(['--no-push']);
  assert.equal(failed.status, 1, failed.lines.join('\n'));
  assert.equal(failed.lines[0], w.header());
  assert.ok(failed.err.some(line => /secret pattern/.test(line)), failed.lines.join('\n'));
  assert.equal(lastReport(failed.out), repoLine(w, 'docs/ROADMAP-OVERVIEW.md - commit them in that checkout'), 'the files the failed run left are listed: ' + failed.lines.join('\n'));
  // Exit 3: another live session claims the file this one names.
  const w2 = world(t, {mode: 'session'});
  const other = path.join(w2.root, 'b2'); w2.git(w2.project, 'worktree', 'add', '-q', '-b', 'b2', other);
  S.claimFiles({memoryDir: w2.memoryDir, repo: other, files: ['topic-alpha.md'], by: 'test'});
  w2.put(path.join(w2.memoryDir, 'topic-alpha.md'), topic('topic-alpha') + 'edit\n');
  const contended = w2.run(['--session', '--no-push', '--files', 'topic-alpha.md']);
  assert.equal(contended.status, 3, contended.lines.join('\n'));
  assert.equal(contended.lines[0], w2.header());
  assert.ok(contended.lines.some(line => line.startsWith('contended: topic-alpha.md')), contended.lines.join('\n'));
  assert.equal(lastReport(contended.out), repoLine(w2, 'docs/ROADMAP-OVERVIEW.md - commit them in that checkout'));
});

// ---- the end of the run ----

// A fixture with every output: a brain, a roadmap and a brain log and hand-overs that rotate, and a new lesson.
const full = (t, options = {}) => { const w = world(t, {brain: true, rotate: true, ...options}); w.lesson('Own lesson'); return w; };

test('D1 a run against external memory ends with exactly the checkout files it changed, and none when it changed nothing', t => {
  const w = full(t);
  const first = w.changed(() => w.run(['--no-push']));
  assert.equal(first.result.status, 0, first.result.lines.join('\n'));
  assert.ok(first.repo.length >= 5, 'the run rewrote the log, the roadmap, its history, the overview and the brain index: ' + first.repo.join(', '));
  assert.equal(lastReport(first.result.out), repoLine(w, `${first.repo.join(', ')} - commit them in that checkout`), first.result.lines.join('\n'));
  // The files are dirty now; a second run changes none of them and says so.
  const second = w.changed(() => w.run(['--no-push']));
  assert.equal(second.result.status, 0, second.result.lines.join('\n'));
  assert.deepEqual(second.repo, []);
  assert.equal(lastReport(second.result.out), repoLine(w, 'none'), second.result.lines.join('\n'));
});

test('D1 a path that was already dirty and this run did not change is never listed, in either mode', t => {
  for (const mode of ['all', 'session']) {
    const w = world(t, {brain: true, mode});
    const argv = mode === 'all' ? ['--no-push'] : ['--session', '--no-push'];
    ok(w.run(argv));
    // Unrelated dirt: a tracked file, an untracked file, and an uncommitted brain log entry the run does not rotate.
    fs.appendFileSync(path.join(w.project, 'AGENTS.md'), 'unrelated edit\n');
    w.put(path.join(w.project, 'scratch.txt'), 'untracked\n');
    fs.appendFileSync(path.join(w.project, 'brain/00-system/log.md'), '## [2026-11-03] note | late entry\nBody.\n\n');
    const second = w.changed(() => w.run(argv));
    assert.equal(second.result.status, 0, `${mode}: ${second.result.lines.join('\n')}`);
    assert.deepEqual(second.repo, [], mode);
    assert.equal(lastReport(second.result.out), repoLine(w, 'none'), `${mode}: ${second.result.lines.join('\n')}`);
  }
  function ok(r) { assert.equal(r.status, 0, r.lines.join('\n')); }
});

test('D1 a file this run changed and a failure then left behind is listed, in both modes', t => {
  // All-sessions: the run rewrites the repo outputs, then the gate refuses (a secret in memory); nothing is rolled back.
  const a = full(t);
  a.put(path.join(a.memoryDir, 'topic-beta.md'), topic('topic-beta') + SECRET + '\n');
  const all = a.changed(() => a.run(['--no-push']));
  assert.equal(all.result.status, 1, all.result.lines.join('\n'));
  assert.ok(all.repo.length >= 5, all.repo.join(', '));
  assert.equal(lastReport(all.result.out), repoLine(a, `${all.repo.join(', ')} - commit them in that checkout`), all.result.lines.join('\n'));
  assert.ok(all.result.err.some(line => /secret pattern/.test(line)));
  // Session: a repo output is written, then the next step fails.
  const s = world(t, {brain: true, mode: 'session'});
  const faulted = s.changed(() => s.save({session: true, faults: {afterRepoWrite() { throw new Error('injected failure after the first repo write'); }}}));
  assert.equal(faulted.result.result.status, 1, faulted.result.lines.join('\n'));
  assert.equal(faulted.repo.length, 1, 'only the first output was written: ' + faulted.repo.join(', '));
  assert.deepEqual(faulted.result.result.changed.repo, faulted.repo);
  assert.equal(faulted.result.lines.at(-1), repoLine(s, `${faulted.repo[0]} - commit them in that checkout`), faulted.result.lines.join('\n'));
});

test('D1 a path that could not be inspected is named, never reported as none', t => {
  const w = world(t);
  // The overview path is a folder: its bytes cannot be read before or after, and writing it fails.
  fs.mkdirSync(path.join(w.project, 'docs/ROADMAP-OVERVIEW.md'));
  const r = w.run(['--no-push']);
  assert.equal(r.status, 1, r.lines.join('\n'));
  const last = lastReport(r.out);
  assert.match(last, /^repo files changed in .*: could not inspect docs\/ROADMAP-OVERVIEW\.md - compare them by hand/, r.lines.join('\n'));
  assert.ok(!/: none$/.test(last));
});

test('D1 another session\'s work in its own checkout or in the shared memory is not this run\'s output', t => {
  const w = world(t, {mode: 'session'});
  const other = path.join(w.root, 'b2'); w.git(w.project, 'worktree', 'add', '-q', '-b', 'b2', other);
  fs.appendFileSync(path.join(other, 'docs/ROADMAP.md'), '**2026-11-09** only the other session wrote this\n');
  w.put(path.join(other, 'notes.txt'), 'other session\n');
  w.put(path.join(w.memoryDir, 'topic-beta.md'), topic('topic-beta') + 'edited by the other session\n');
  S.claimFiles({memoryDir: w.memoryDir, repo: other, files: ['topic-beta.md'], by: 'test'});
  w.put(path.join(w.memoryDir, 'topic-alpha.md'), topic('topic-alpha') + 'edit\n');
  const r = w.changed(() => w.run(['--session', '--no-push', '--files', 'topic-alpha.md']));
  assert.equal(r.result.status, 0, r.result.lines.join('\n'));
  assert.deepEqual(r.repo, ['docs/ROADMAP-OVERVIEW.md']);
  assert.equal(lastReport(r.result.out), repoLine(w, 'docs/ROADMAP-OVERVIEW.md - commit them in that checkout'), r.result.lines.join('\n'));
});

test('D1 memory inside the project is not external: its checkout line is not printed, and the old statuses stand', t => {
  const w = world(t, {inRepo: true, brain: true});
  const r = w.run(['--no-push']);
  assert.equal(r.status, 0, r.lines.join('\n'));
  assert.equal(r.lines[0], `checkpoint: repo ${w.project}; memory ${w.memoryDir} (--memory-dir)`);
  assert.ok(!r.lines.some(line => line.startsWith('repo files changed in')), r.lines.join('\n'));
  const dry = w.run(['--dry-run']);
  assert.equal(dry.status, 0, dry.lines.join('\n'));
  assert.equal(dry.lines.filter(line => line.startsWith('would change:')).length, 1);
});

test('D1 the statuses of a normal run, a dry run, a refusal, a contention and a failed push are the base statuses', t => {
  const w = world(t, {remote: true, mode: 'session'});
  w.put(path.join(w.memoryDir, 'topic-alpha.md'), topic('topic-alpha') + 'edit\n');
  const pushedOk = w.run(['--session', '--files', 'topic-alpha.md']);
  assert.equal(pushedOk.status, 0, pushedOk.lines.join('\n'));
  assert.ok(pushedOk.lines.some(line => line.startsWith('publication: ')), pushedOk.lines.join('\n'));
  assert.match(lastReport(pushedOk.out), /^repo files changed in /, 'the files line comes after the publication lines');
  assert.equal(w.run(['--session', '--dry-run']).status, 0);
  assert.equal(w.run(['--memory-only', '--all']).status, 1);
  // A push that cannot reach its remote is status 2, and its files line is still the last report.
  w.put(path.join(w.memoryDir, 'topic-alpha.md'), topic('topic-alpha') + 'second edit\n');
  w.git(w.memoryDir, 'remote', 'set-url', 'origin', path.join(w.root, 'missing-remote.git'));
  const pushed = w.run(['--session', '--files', 'topic-alpha.md']);
  assert.equal(pushed.status, 2, pushed.lines.join('\n'));
  assert.equal(pushed.lines[0], w.header());
  assert.ok(pushed.lines.some(line => line.startsWith('push: failed (')), pushed.lines.join('\n'));
  assert.match(lastReport(pushed.out), /^repo files changed in /);
});

// ---- dry runs ----

for (const [name, flags, claim] of [['', [], false], [' with --no-rotate', ['--no-rotate'], false], [' while another session holds a claim, so rotation waits', [], true]]) test(`D1 an all-sessions dry run${name} prints one would-change list, writes nothing, and the list is what the real run then changes`, t => {
  const w = full(t);
  if (claim) {
    const other = path.join(w.root, 'b2'); w.git(w.project, 'worktree', 'add', '-q', '-b', 'b2', other);
    S.claimFiles({memoryDir: w.memoryDir, repo: other, files: ['topic-beta.md'], by: 'test'});
  }
  const before = [w.memoryTree(), w.repoTree(), w.refs()];
  const {result: dry, targets} = w.writesDuring(() => w.run(['--dry-run', ...flags]));
  assert.equal(dry.status, 0, dry.lines.join('\n'));
  assert.deepEqual([w.memoryTree(), w.repoTree(), w.refs()], before, 'a dry run changes no byte, ref or index entry');
  assert.deepEqual(targets.filter(w.inside), [], 'a dry run writes, locks and removes nothing in the project or the memory folder, not even transiently');
  assert.equal(dry.lines[0], w.header());
  const would = dry.lines.filter(line => line.startsWith('would change:'));
  assert.equal(would.length, 1, dry.lines.join('\n'));
  assert.ok(!dry.lines.some(line => line.startsWith('repo files changed in')), 'a dry run prints no files line');
  const planned = would[0].slice('would change: '.length).split(', ').sort();
  // The same spy sees the real run write in the project and the memory folder, so its silence during the dry run means something.
  let spied;
  const real = w.changed(() => { spied = w.writesDuring(() => w.run(['--no-push', ...flags])); return spied.result; });
  assert.ok(spied.targets.filter(w.inside).length > 0, 'the spy sees the real run write');
  assert.equal(real.result.status, 0, real.result.lines.join('\n'));
  assert.deepEqual(planned, [...real.memory, ...real.repo].sort(), 'the plan and the run name the same paths');
  const rotated = real.repo.includes('docs/ROADMAP.md');
  assert.equal(rotated, !flags.length && !claim, 'rotation ran exactly when neither --no-rotate nor a claim stopped it: ' + real.repo.join(', '));
  assert.ok(real.memory.length >= 2 && real.repo.length >= (rotated ? 5 : 2), `${real.memory.join(', ')} | ${real.repo.join(', ')}`);
  // Nothing left to change: the plan is empty (the zero case prints the same way as the one case).
  const again = w.run(['--dry-run', ...flags]);
  assert.ok(again.lines.includes('would change: nothing'), again.lines.join('\n'));
});

test('D1 a roadmap that rotates always rewrites an overview that was current, and the dry run says so', t => {
  const w = full(t);
  assert.equal(w.run(['--no-push']).status, 0);
  fs.appendFileSync(path.join(w.project, 'docs/ROADMAP.md'), '**2026-11-06** block 6\n\n**2026-11-07** block 7\n\n');
  // Before the rotation the overview equals what would be generated, so only the rotation can make it change.
  const overview = path.join(w.project, 'docs/ROADMAP-OVERVIEW.md');
  assert.equal(generateOverview({repo: w.project, config: w.config}).replace(/\r\n/g, '\n'), fs.readFileSync(overview, 'utf8').replace(/\r\n/g, '\n'));
  const dry = w.run(['--dry-run']);
  const would = dry.lines.filter(line => line.startsWith('would change:'));
  assert.equal(would.length, 1, dry.lines.join('\n'));
  const real = w.changed(() => w.run(['--no-push']));
  assert.equal(real.result.status, 0, real.result.lines.join('\n'));
  assert.ok(real.repo.includes('docs/ROADMAP-OVERVIEW.md') && real.repo.includes('docs/ROADMAP.md'), real.repo.join(', '));
  assert.deepEqual(would[0].slice('would change: '.length).split(', ').sort(), [...real.memory, ...real.repo].sort());
});

test('D1 a dry run that cannot plan says so, keeps its status, and names a path that is not a regular file', t => {
  const bad = world(t, {brain: true});
  fs.appendFileSync(path.join(bad.project, 'brain/00-system/log.md'), '## [2026-13-45] bad | entry with an impossible date\nBody.\n\n');
  const date = bad.run(['--dry-run']);
  assert.equal(date.status, 0, date.lines.join('\n'));
  assert.ok(date.lines.some(line => /^would change: could not be planned \(invalid log date at line/.test(line)), date.lines.join('\n'));
  assert.equal(date.lines.filter(line => line.startsWith('would change:')).length, 1, 'no partial list beside the refusal');
  const dir = world(t);
  fs.mkdirSync(path.join(dir.project, 'docs/ROADMAP-OVERVIEW.md'));
  const kind = dir.run(['--dry-run']);
  assert.equal(kind.status, 0, kind.lines.join('\n'));
  assert.ok(kind.lines.includes('would change: could not be planned (docs/ROADMAP-OVERVIEW.md is not a regular file)'), kind.lines.join('\n'));
  const page = world(t);
  fs.rmSync(path.join(page.memoryDir, 'INDEX-ops.md')); fs.mkdirSync(path.join(page.memoryDir, 'INDEX-ops.md'));
  const memoryPage = page.run(['--dry-run']);
  assert.equal(memoryPage.status, 0, memoryPage.lines.join('\n'));
  assert.ok(memoryPage.lines.some(line => /^would change: could not be planned \(generated output refused: INDEX-ops\.md is not a regular file\)/.test(line)), memoryPage.lines.join('\n'));
});

const planned = lines => {
  const would = lines.filter(line => line.startsWith('would change:'));
  assert.equal(would.length, 1, lines.join('\n'));
  return would[0].slice('would change: '.length);
};
// Runs a call while `target` reports itself as a pipe, and records every attempt to read it.
function pretendPipe(t, target, run) {
  const fake = path.resolve(target).toLowerCase(), reads = [], lstat = fs.lstatSync;
  const mocks = [t.mock.method(fs, 'lstatSync', function (p, ...rest) { return path.resolve(String(p)).toLowerCase() === fake ? {isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false} : lstat.call(this, p, ...rest); })];
  for (const name of ['readFileSync', 'copyFileSync', 'openSync', 'createReadStream']) {
    const original = fs[name];
    mocks.push(t.mock.method(fs, name, function (...a) { if (path.resolve(String(a[0])).toLowerCase() === fake) reads.push(name); return original.apply(this, a); }));
  }
  try { return {result: run(), reads}; } finally { for (const m of mocks) m.mock.restore(); }
}

test('D1 a dry run reads nothing whose kind is not a regular file, whichever input is the pipe', t => {
  const w = full(t);
  for (const [target, rel] of [[path.join(w.memoryDir, 'MEMORY.md'), 'MEMORY.md'], [path.join(w.project, 'docs/ROADMAP.md'), 'docs/ROADMAP.md'], [path.join(w.project, 'brain/00-system/log.md'), 'brain/00-system/log.md']]) {
    const {result, reads} = pretendPipe(t, target, () => w.run(['--dry-run']));
    assert.equal(result.status, 0, result.lines.join('\n'));
    assert.ok(result.lines.includes(`would change: could not be planned (${rel} is not a regular file)`), `${rel}: ${result.lines.join('\n')}`);
    assert.deepEqual(reads, [], `${rel} was read although its kind is not a regular file`);
  }
});

test('D1 a rotation retried after an interruption: the plan, like the run, leaves a filled archive alone, wherever the log lives', t => {
  // The log in the brain folder (its archives are copied with the brain) and the log outside it (they are found next to the log).
  for (const logPath of ['brain/00-system/log.md', 'docs/OPLOG.md']) {
    const w = full(t, {logPath}), folder = path.join(w.memoryDir, 'handovers'), archive = path.posix.dirname(logPath) + '/log-2026-09.md';
    const logFile = path.join(w.project, logPath), original = fs.readFileSync(logFile);
    const notes = Object.fromEntries(fs.readdirSync(folder).map(name => [name, fs.readFileSync(path.join(folder, name))]));
    // The interrupted run: the archives are written, the log is not yet replaced and the loose notes are not yet removed.
    rotateLog({repo: w.project, memoryDir: w.memoryDir, config: w.config, write: true});
    rotateHandovers({memoryDir: w.memoryDir, config: w.config, write: true});
    fs.writeFileSync(logFile, original);
    for (const [name, bytes] of Object.entries(notes)) fs.writeFileSync(path.join(folder, name), bytes);
    assert.ok(fs.existsSync(path.join(w.project, archive)) && fs.existsSync(path.join(folder, 'archive-2026-08.md')), `${logPath}: the archives are there`);
    const dry = w.run(['--dry-run']);
    const list = planned(dry.lines).split(', ');
    assert.ok(list.includes(logPath) && list.includes('handovers/000001-2026-08-01-1200.md'), `${logPath}: the sources still change: ` + list.join(', '));
    assert.deepEqual(list.filter(file => /log-\d{4}-\d{2}\.md$|archive-/.test(file)), [], `${logPath}: a filled archive is not a change: ` + list.join(', '));
    const real = w.changed(() => w.run(['--no-push']));
    assert.equal(real.result.status, 0, `${logPath}: ` + real.result.lines.join('\n'));
    assert.deepEqual([...list].sort(), [...real.memory, ...real.repo].sort(), `${logPath}: the run changes exactly what the plan named`);
  }
});

test('D1 a brain folder with no markdown file is still a brain folder: the plan names its two index files, as the run does', t => {
  const w = world(t, {roadmap: false});
  fs.mkdirSync(path.join(w.project, 'brain'));
  const list = planned(w.run(['--dry-run']).lines).split(', ').sort();
  const real = w.changed(() => w.run(['--no-push']));
  assert.equal(real.result.status, 0, real.result.lines.join('\n'));
  assert.ok(real.repo.includes('brain/00-system/index.md') && real.repo.includes('brain/00-system/index-all.md'), real.repo.join(', '));
  assert.deepEqual(list, [...real.memory, ...real.repo].sort());
});

test('D1 a dry run refuses what the writer refuses: a generated page kept by hand, in the folder or staged', t => {
  const w = world(t);
  const page = path.join(w.memoryDir, 'INDEX-craft.md'), generated = fs.readFileSync(page, 'utf8');
  fs.writeFileSync(page, '# Craft\n\nKept by hand, with no generated marker.\n');
  const dry = w.run(['--dry-run']);
  assert.equal(dry.status, 0, dry.lines.join('\n'));
  assert.ok(dry.lines.includes('would change: could not be planned (run the route migration first; refusing to overwrite INDEX-craft.md)'), dry.lines.join('\n'));
  const real = w.run(['--no-push']);
  assert.equal(real.status, 1); assert.ok(real.err.some(line => line.includes('run the route migration first; refusing to overwrite INDEX-craft.md')), real.lines.join('\n'));
  // Staged by hand, the working copy generated again.
  fs.writeFileSync(page, '# Craft\n\nStaged by hand.\n'); w.git(w.memoryDir, 'add', 'INDEX-craft.md'); fs.writeFileSync(page, generated);
  const staged = w.run(['--dry-run']);
  assert.equal(staged.status, 0, staged.lines.join('\n'));
  assert.ok(staged.lines.includes('would change: could not be planned (run the route migration first; refusing to overwrite INDEX-craft.md (staged version is not generated))'), staged.lines.join('\n'));
  const realStaged = w.run(['--no-push']);
  assert.equal(realStaged.status, 1); assert.ok(realStaged.err.some(line => line.includes('(staged version is not generated)')), realStaged.lines.join('\n'));
});

// ---- what a run that failed before or while writing may list ----

test('D1 a save that never got past the lock lists nothing, whatever another writer changed while it waited', t => {
  const w = full(t);
  const logFile = path.join(w.project, 'brain/00-system/log.md'), topicFile = path.join(w.memoryDir, 'topic-beta.md');
  // A live owner holds the memory lock; the first wait is the moment the other writer edits two files, and the clock then jumps.
  w.put(path.join(w.memoryDir, '.memory.lock'), JSON.stringify({pid: process.pid, host: os.hostname(), time: new Date().toISOString(), token: 'held'}) + '\n');
  const now = Date.now; let skew = 0, edited = false;
  t.mock.method(Date, 'now', () => now() + skew);
  t.mock.method(Atomics, 'wait', () => {
    if (!edited) { edited = true; fs.appendFileSync(logFile, '## [2026-11-05] note | written by another writer\nBody.\n\n'); fs.appendFileSync(topicFile, 'edited meanwhile\n'); }
    skew = 40000; return 'timed-out';
  });
  const {result, lines} = w.save();
  assert.equal(result.status, 1, lines.join('\n'));
  assert.match(result.error, /memory lock timed out/);
  assert.ok(edited, 'the other writer did edit during the wait');
  assert.deepEqual(result.changed, {memory: [], repo: []});
  assert.equal(lines.at(-1), repoLine(w, 'none'), lines.join('\n'));
});

test('D1 an archive a failed rotation left is listed although the folder cannot be listed, and a memory folder that cannot be listed is named', t => {
  const w = full(t);
  const logFile = path.join(w.project, 'brain/00-system/log.md'), original = fs.readFileSync(logFile);
  const rename = fs.renameSync, readdir = fs.readdirSync;
  const denied = Object.assign(new Error('EACCES: permission denied'), {code: 'EACCES'});
  t.mock.method(fs, 'renameSync', function (from, to, ...rest) { if (/00-system[\\/]log\.md$/.test(String(to))) throw denied; return rename.call(this, from, to, ...rest); });
  t.mock.method(fs, 'readdirSync', function (dir, ...rest) { if (/[\\/]00-system$|[\\/]handovers$/.test(String(dir))) throw denied; return readdir.call(this, dir, ...rest); });
  const {result, lines} = w.save();
  t.mock.restoreAll();
  assert.equal(result.status, 1, lines.join('\n'));
  assert.ok(fs.readFileSync(logFile).equals(original), 'the log was not replaced');
  const archives = ['brain/00-system/log-2026-09.md', 'brain/00-system/log-2026-10.md'];
  for (const file of archives) assert.ok(fs.existsSync(path.join(w.project, file)), file + ' was created before the failure');
  assert.equal(lines.at(-1), repoLine(w, `${archives.join(', ')} - commit them in that checkout`), lines.join('\n'));
  assert.deepEqual(result.changed.repo, archives);
  assert.deepEqual(result.changed.memory, ['INDEX-craft-all.md', 'INDEX-craft.md'], 'the pages written before the failure, and nothing else, are this run\'s memory changes');
  // The folder of hand-over notes could not be listed either: that is named, not an empty folder.
  assert.ok(result.uninspected.some(u => u.layer === 'memory' && u.path === 'handovers/' && /EACCES/.test(u.error)), JSON.stringify(result.uninspected));
});

test('D1 the header is built for any spelling of the two folders without throwing', () => {
  const win = process.platform === 'win32';
  const spellings = [undefined, null, '', '.', 'relative/dir', '~/x', '\0bad', ...(win ? ['C:\\', '\\\\?\\C:\\a\\b', '\\\\?\\C:\\'] : ['/'])];
  for (const repo of spellings) for (const memoryDir of spellings) {
    const text = cp.checkpointHeader({repo, memoryDir});
    assert.match(text, /^repo .+; memory .+ \(caller\)$/, JSON.stringify([repo, memoryDir]));
    assert.equal(text.startsWith('repo unknown; '), !repo, JSON.stringify([repo, memoryDir]));
    assert.equal(text.includes('; memory not found ('), !memoryDir, JSON.stringify([repo, memoryDir]));
  }
  assert.equal(cp.checkpointHeader({repo: 'relative/dir'}), `repo ${path.resolve('relative/dir')}; memory not found (caller)`);
  if (win) for (const rest of ['', 'a\\b', 'Windows']) assert.equal(cp.checkpointHeader({repo: '\\\\?\\C:\\' + rest}), cp.checkpointHeader({repo: 'C:\\' + rest}), `the extended-length spelling of C:\\${rest} prints as the plain one`);
});

test('D1 a session dry run prints one would-change list, writes nothing, and takes no claim', t => {
  const w = world(t, {mode: 'session', brain: true});
  w.lesson('Own lesson');
  const before = [w.memoryTree(), w.repoTree(), w.refs(), fs.existsSync(path.join(w.memoryDir, '.sessions'))];
  const dry = w.run(['--session', '--dry-run', '--files', 'topic-alpha.md']);
  assert.equal(dry.status, 0, dry.lines.join('\n'));
  assert.deepEqual([w.memoryTree(), w.repoTree(), w.refs(), fs.existsSync(path.join(w.memoryDir, '.sessions'))], before);
  assert.equal(dry.lines[0], w.header());
  const would = dry.lines.filter(line => line.startsWith('would change:'));
  assert.equal(would.length, 1, dry.lines.join('\n'));
  assert.match(would[0], /lesson-\d+-own-lesson\.md/);
  assert.ok(!dry.lines.some(line => line.startsWith('repo files changed in')));
});
