// Kit 3.3.6 lane Z: the checkpoint, the gate's named-file reads and the shared cleanup, write and hard-rule helpers.
// Items 7(c), 8, 9 (engine sites), 10 (checkpoint sites), 15, 16, 17, 18 (checkpoint sites), 19, 20, 24 and the test-speed
// cut of item 14 (the installed-selftest test). Each test was written red first against the base (kit 3.3.6 step 0) and the
// comment beside it names its mutant: the one small change to the code that makes the test fail. A test that pins
// behaviour the base already has is marked pin. This system cannot make a fifo, so a special file is emulated: statSync
// and lstatSync report it as neither a file nor a folder, readdirSync with file types stops listing it as a file where a
// listing would otherwise reach it first, and a marker records every attempt to read it.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {kitRoot, fixture, put as putFile, ok as okResult} from './helpers.mjs';
import {loadConfig, memorySlug, read, readRequired, hardRuleTargets, writeText} from '../engine/lib.mjs';
import {writeMemoryIndex} from '../engine/memory-index.mjs';
import {newLesson} from '../engine/memory-lesson.mjs';
import {runCheck, counts} from '../engine/memory-check.mjs';
import {withMemoryLock} from '../engine/memory-lock.mjs';
import {promoteTopics} from '../engine/memory-promote.mjs';
import {checkInstalledIgnores} from '../scripts/install.mjs';
import * as cp from '../engine/memory-checkpoint.mjs';
import {gitRun as realGitRun} from '../engine/memory-session.mjs';

const TODAY = '2026-11-12';
const ORIGINAL_ENV = Object.fromEntries(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'CLAUDE_MEMORY_DIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR'].map(key => [key, process.env[key]]));
after(() => { for (const [key, value] of Object.entries(ORIGINAL_ENV)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
const topic = name => `---\nname: ${name}\ndescription: "${name} notes kept for the fixture."\nmetadata:\n  type: reference\n  route: craft\n---\n\n# ${name}\n\nBody of ${name}.\n`;
const ROUTER = '# Memory\n\n## Routing\n- [Craft](INDEX-craft.md) OPEN BEFORE testing.\n- [Ops](INDEX-ops.md) OPEN BEFORE operating.\n\n## Active work\n- [Current](current-state.md) OPEN BEFORE resuming.\n';
const CURRENT = '---\nname: current-state\ndescription: "Current task, next action and checkpoint handoff."\nmetadata:\n  type: project\n  state: true\n---\n\n## CURRENT\nold state\n';
const PILLAR = '---\nid: pil-test\ntype: pillar\nstatus: active\nsummary: The fixture pillar.\nupdated: 2026-11-01\n---\n\n# Pillar\n';

// A project checkout on branch main, memory outside it (or inside it with inRepo), optional brain, rotation and session mode.
// The fixture of tests/release335-d1.test.mjs in the parts this file needs.
// With nested, the project is the folder outer/proj of the git repository that starts at outer (its prefix is proj/); a string
// names the folder instead of proj (a leading space is allowed in a folder name).
function world(t, {mode = 'all', inRepo = false, inRepoDir = 'memory', brain = false, rotate = false, roadmap = true, nested = false, tweak = () => {}} = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kit336z-')));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const gitconfig = path.join(home, '.gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n name = kit-test\n email = kit-test@example.invalid\n[core]\n autocrlf = false\n longpaths = true\n[init]\n defaultBranch = main\n');
  for (const [key, value] of Object.entries({GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', CLAUDE_MEMORY_DIR: undefined, HOME: home, USERPROFILE: home})) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => fs.rmSync(root, {recursive: true, force: true, maxRetries: 5}));
  const git = (dir, ...argv) => {
    const r = spawnSync('git', ['-C', dir, ...argv], {encoding: 'utf8', env: process.env});
    assert.equal(r.status, 0, `git ${argv.join(' ')}: ${r.stdout}${r.stderr}`);
    return r.stdout.trim();
  };
  const put = (file, text) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, text); return file; };
  const nestedName = typeof nested === 'string' ? nested : 'proj';
  const gitRoot = nested ? path.join(root, 'outer') : path.join(root, 'project'), project = nested ? path.join(gitRoot, nestedName) : gitRoot;
  fs.mkdirSync(project, {recursive: true}); git(gitRoot, 'init', '-b', 'main');
  const config = loadConfig();
  config.caps.checkpoint = {mode};
  if (rotate) { config.caps.brainLog.keepEntries = 3; config.caps.roadmap.keepBlocks = 2; config.caps.handovers.keepNotes = 2; }
  if (inRepo) config.memory = {inRepoDir};
  tweak(config);
  const configFile = path.join(project, 'scripts/memory/memory.config.json');
  put(configFile, JSON.stringify(config, null, 2) + '\n');
  put(path.join(project, 'scripts/memory/KIT.json'), JSON.stringify({version: config.engine_version}) + '\n');
  put(path.join(project, 'AGENTS.md'), '# Project\n');
  put(path.join(project, '.gitignore'), '.memory.lock*\n.memory.push.lock*\n.sessions/\n');
  if (roadmap) put(path.join(project, 'docs/ROADMAP.md'), '# Roadmap\n\n## Open work\n\n' + (rotate ? [1, 2, 3, 4, 5].map(n => `**2026-11-0${n}** block ${n}\n\n`).join('') : '**2026-11-01** first block\n\n**2026-11-02** second block\n\n'));
  if (brain) {
    put(path.join(project, config.caps.brainLog.path), '# Log\n\n' + (rotate ? ['2026-09-10', '2026-09-20', '2026-10-01', '2026-10-05', '2026-10-20', '2026-11-01'] : ['2026-11-01', '2026-11-02']).map(d => `## [${d}] note | entry ${d}\nBody.\n\n`).join(''));
    put(path.join(project, 'brain/01-pillars/pil-test.md'), PILLAR);
  }
  const memoryDir = inRepo ? path.join(project, inRepoDir) : path.join(home, '.claude/projects', memorySlug(project), 'memory');
  put(path.join(memoryDir, '.gitignore'), '.memory.lock*\n.memory.push.lock*\n.sessions/\n');
  put(path.join(memoryDir, 'MEMORY.md'), ROUTER);
  put(path.join(memoryDir, 'current-state.md'), CURRENT);
  for (const name of ['alpha', 'beta']) put(path.join(memoryDir, `topic-${name}.md`), topic(`topic-${name}`));
  writeMemoryIndex({memoryDir, config});
  git(project, 'add', '.'); git(project, 'commit', '-m', 'project seed');
  if (!inRepo) { git(memoryDir, 'init', '-b', 'main'); git(memoryDir, 'add', '.'); git(memoryDir, 'commit', '-m', 'memory seed'); }
  const w = {root, home, project, memoryDir, config, configFile, git, put, inRepo};
  w.overview = path.join(project, 'docs/ROADMAP-OVERVIEW.md');
  w.lesson = title => {
    const file = newLesson({memoryDir, repo: project, config, title, route: 'craft', kind: 'practice', today: TODAY});
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('description: "TODO"', `description: "${title} explained for the fixture."`).replace('**Why:**\n', '**Why:**\nBecause the fixture needs it.\n').replace('**How to apply:**', '**How to apply:**\nApply it in the test.'));
    return path.basename(file);
  };
  const base = ['--repo', project, '--memory-dir', memoryDir, '--config', configFile, '--today', TODAY];
  // The command line in this process: every line of both streams in order, and the status.
  w.run = (argv, {env = {}} = {}) => {
    const lines = [], out = [], err = [], log = console.log, error = console.error, before = {};
    for (const [key, value] of Object.entries(env)) { before[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    console.log = (...a) => { const line = a.map(String).join(' '); lines.push(line); out.push(line); };
    console.error = (...a) => { const line = a.map(String).join(' '); lines.push(line); err.push(line); };
    let status;
    try { status = cp.main([...base, ...argv]); }
    finally {
      console.log = log; console.error = error;
      for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
    return {status, lines, out, err};
  };
  // A programmatic call; hook sees every report as (step, message).
  w.go = (opts = {}, hook = () => {}) => {
    const lines = [];
    const result = cp.checkpoint({memoryDir, repo: project, config: w.config, today: TODAY, noPush: true, ...opts,
      report: (step, message) => { lines.push(`${step}: ${message}`); hook(step, message); }});
    return {result, lines};
  };
  const walk = (dir, skip) => {
    const out = {};
    const go = rel => { for (const e of fs.readdirSync(path.join(dir, rel), {withFileTypes: true})) {
      const next = rel ? rel + '/' + e.name : e.name;
      if (skip(next, e.name)) continue;
      if (e.isDirectory()) go(next); else if (e.isFile()) out[next] = fs.readFileSync(path.join(dir, next)).toString('base64');
    } };
    go('');
    return out;
  };
  w.memoryTree = ({sessions = false} = {}) => walk(memoryDir, (rel, name) => name === '.git' || (!sessions && name === '.sessions') || /^\.memory\.lock/i.test(name));
  w.repoTree = () => walk(project, (rel, name) => name === '.git' || (inRepo && rel === inRepoDir));
  w.refs = () => { const holder = inRepo ? project : memoryDir; return [git(holder, 'rev-parse', 'HEAD'), git(holder, 'for-each-ref'), git(holder, 'ls-files', '--stage'), git(holder, 'status', '--porcelain')].join('\n--\n'); };
  // untrimmed: the first name of a project folder that starts with a space must keep it
  w.committed = () => spawnSync('git', ['-C', inRepo ? project : memoryDir, 'show', '--name-only', '--format=', 'HEAD'], {encoding: 'utf8', env: process.env}).stdout.split('\n').filter(Boolean).map(file => nested && inRepo && file.startsWith(nestedName + '/') ? file.slice(nestedName.length + 1) : file).sort();
  w.writesDuring = run => {
    const targets = [], names = {writeFileSync: [0], appendFileSync: [0], mkdirSync: [0], unlinkSync: [0], rmSync: [0], rmdirSync: [0], renameSync: [0, 1], copyFileSync: [1], symlinkSync: [1], linkSync: [1]};
    const mocks = Object.entries(names).map(([name, positions]) => { const original = fs[name]; return t.mock.method(fs, name, function (...a) { for (const at of positions) if (typeof a[at] === 'string') targets.push(path.resolve(a[at])); return original.apply(this, a); }); });
    try { return {result: run(), targets}; } finally { for (const m of mocks) m.mock.restore(); }
  };
  w.inside = file => [project, memoryDir].some(dir => { const rel = path.relative(dir.toLowerCase(), path.resolve(file).toLowerCase()); return !rel.startsWith('..') && !path.isAbsolute(rel); });
  return w;
}
const repoLine = (w, list) => `repo files changed in ${w.project}: ${list}`;

// What a fifo, socket or device shows to a kind check: neither a file nor a folder.
const SPECIAL = {isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false, isFIFO: () => true};
const keyOf = file => path.resolve(String(file)).toLowerCase();
// Targets report themselves as special from now on; every attempt to read one is recorded in `reads`. With hide, a
// listing no longer shows a target as a file (a real fifo is not a file entry of its folder).
function pretendSpecial(t, targets, {hide = true} = {}) {
  const fake = new Set(targets.map(keyOf)), reads = [];
  for (const name of ['statSync', 'lstatSync']) { const original = fs[name]; t.mock.method(fs, name, function (file, ...rest) { return fake.has(keyOf(file)) ? SPECIAL : original.call(this, file, ...rest); }); }
  for (const name of ['readFileSync', 'openSync', 'copyFileSync', 'createReadStream', 'writeFileSync']) { const original = fs[name]; t.mock.method(fs, name, function (file, ...rest) { if (fake.has(keyOf(file))) reads.push(name); return original.call(this, file, ...rest); }); }
  if (hide) {
    const original = fs.readdirSync;
    t.mock.method(fs, 'readdirSync', function (dir, ...rest) {
      const out = original.call(this, dir, ...rest);
      if (!rest[0]?.withFileTypes) return out;
      return out.map(entry => fake.has(keyOf(path.join(dir, entry.name))) ? {name: entry.name, parentPath: dir, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false} : entry);
    });
  }
  return {reads};
}
// The target becomes special once armed. A stat of a path under `disarmUnder` while armed makes it a regular file again
// (the real file on disk); reads of the target after arming are recorded.
function lateSpecial(t, target, {disarmUnder} = {}) {
  const fake = keyOf(target), under = disarmUnder && keyOf(disarmUnder), state = {armed: false, everArmed: false, readsAfter: []};
  const stat = fs.statSync, readFile = fs.readFileSync;
  t.mock.method(fs, 'statSync', function (file, ...rest) {
    const key = keyOf(file);
    if (state.armed && under && key.startsWith(under) && key !== fake) state.armed = false;
    return state.armed && key === fake ? SPECIAL : stat.call(this, file, ...rest);
  });
  t.mock.method(fs, 'readFileSync', function (file, ...rest) { if (state.everArmed && keyOf(file) === fake) state.readsAfter.push(String(file)); return readFile.call(this, file, ...rest); });
  state.arm = () => { state.armed = true; state.everArmed = true; };
  return state;
}
// The targets exist as ordinary files but a stat of them fails with `code` (an access or I/O error, not an absent path); every
// attempt to read or write one is recorded in `reads`.
function statFails(t, targets, code) {
  const fake = new Set(targets.map(keyOf)), reads = [], stat = fs.statSync;
  t.mock.method(fs, 'statSync', function (file, ...rest) {
    if (fake.has(keyOf(file))) throw Object.assign(new Error(`${code}: emulated stat failure, stat '${file}'`), {code});
    return stat.call(this, file, ...rest);
  });
  for (const name of ['readFileSync', 'openSync', 'writeFileSync']) { const original = fs[name]; t.mock.method(fs, name, function (file, ...rest) { if (fake.has(keyOf(file))) reads.push(name); return original.call(this, file, ...rest); }); }
  return {reads};
}
const notRegular = result => result.findings.filter(f => /is not a regular file/.test(f.message));
const gate = (w, config = w.config) => runCheck({memoryDir: w.memoryDir, repo: w.project, config, today: TODAY, noGit: true});

// ---- item 8: named repository files that are not regular files ----

test('3.3.6 gate: AGENTS.md that is not a regular file gives two WARNs and no FAIL, and is never read', t => { // mutants: remove the stat in read() (no WARN at all); remove the new catch at the secret scan (the gate throws)
  const w = world(t), baseline = gate(w);
  assert.deepEqual(notRegular(baseline), [], 'the baseline names no special file');
  const marker = pretendSpecial(t, [path.join(w.project, 'AGENTS.md')]);
  const result = gate(w), found = notRegular(result);
  assert.deepEqual(found.map(f => f.check).sort(), ['repo.agents', 'secret']);
  assert.ok(found.every(f => f.severity === 'WARN' && f.file === 'AGENTS.md'), JSON.stringify(found));
  assert.ok(found.some(f => f.message === 'AGENTS.md is not a regular file; not scanned'), JSON.stringify(found));
  assert.equal(counts(result).FAIL, counts(baseline).FAIL, 'the gate\'s exit is the baseline\'s');
  assert.deepEqual(marker.reads, []);
});

test('3.3.6 gate: a roadmap that is not a regular file gives one WARN and skips every check that needs its text', t => { // mutant: remove the stat in read() (no WARN, the overview check reads it)
  const w = world(t, {rotate: true}), baseline = gate(w);
  assert.deepEqual(notRegular(baseline), []);
  const marker = pretendSpecial(t, [path.join(w.project, 'docs/ROADMAP.md')]);
  const result = gate(w), found = notRegular(result);
  assert.deepEqual(found.map(f => f.check), ['repo.roadmap']);
  assert.equal(found[0].severity, 'WARN');
  assert.equal(counts(result).FAIL, counts(baseline).FAIL);
  assert.deepEqual(marker.reads, []);
  for (const id of ['repo.roadmap-rotation', 'repo.roadmap-overview', 'repo.roadmap-order', 'repo.roadmap-no-rotation']) assert.ok(!result.findings.some(f => f.check === id), `${id} reports nothing for a roadmap it cannot read`);
});

test('3.3.6 gate: a roadmap history that is not a regular file gives a rotation WARN and an overview WARN', t => { // mutant: remove the stat in read() (the overview check reads the history; its WARN is stale or missing, not the kind)
  const w = world(t, {rotate: true, tweak: config => { config.caps.roadmap.warnBytes = 100; config.caps.roadmap.failBytes = 100000; }});
  w.put(path.join(w.project, 'docs/ROADMAP.md'), '# Roadmap\n\n' + 'Preamble line that makes the roadmap longer than the warn size.\n'.repeat(4) + '\n## Open work\n\n' + [1, 2, 3, 4, 5].map(n => `**2026-11-0${n}** block ${n}\n\n`).join(''));
  w.put(path.join(w.project, 'docs/ROADMAP-HISTORY.md'), '# History\n');
  const baseline = gate(w);
  assert.deepEqual(notRegular(baseline), []);
  const marker = pretendSpecial(t, [path.join(w.project, 'docs/ROADMAP-HISTORY.md')]);
  const result = gate(w), found = notRegular(result);
  assert.deepEqual(found.map(f => f.check).sort(), ['repo.roadmap-overview', 'repo.roadmap-rotation']);
  assert.ok(found.every(f => f.severity === 'WARN'), JSON.stringify(found));
  assert.equal(counts(result).FAIL, counts(baseline).FAIL);
  assert.deepEqual(marker.reads, []);
});

test('3.3.6 gate: a kit receipt that is not a regular file gives the one manifest WARN the receipt read already gave', t => { // mutant: remove the guard before the direct read of KIT.json (the gate reads the file)
  const w = world(t);
  w.put(path.join(w.project, 'scripts/memory/MANIFEST.json'), JSON.stringify({version: w.config.engine_version, files: {}}) + '\n');
  const baseline = gate(w);
  assert.deepEqual(notRegular(baseline), []);
  const marker = pretendSpecial(t, [path.join(w.project, 'scripts/memory/KIT.json')]);
  const result = gate(w), found = notRegular(result);
  assert.deepEqual(found.map(f => f.check), ['kit.manifest']);
  assert.equal(found[0].severity, 'WARN');
  assert.match(found[0].message, /scripts\/memory\/KIT\.json is not a regular file/);
  assert.equal(counts(result).FAIL, counts(baseline).FAIL);
  assert.deepEqual(marker.reads, []);
});

test('3.3.6 gate: a manifest-listed kit file that is not a regular file is one manifest WARN and is never read', t => { // mutant: remove the guard before the manifest-listed read (the gate reads the file)
  const w = world(t);
  const listed = 'scripts/memory/listed.mjs';
  w.put(path.join(w.project, listed), 'export default 1;\n');
  w.put(path.join(w.project, 'scripts/memory/MANIFEST.json'), JSON.stringify({version: w.config.engine_version, files: {[listed]: 'a'.repeat(64)}}) + '\n');
  const marker = pretendSpecial(t, [path.join(w.project, listed)], {hide: false});
  const found = notRegular(gate(w));
  assert.deepEqual(found.map(f => [f.check, f.severity, f.file]), [['kit.manifest', 'WARN', listed]]);
  assert.deepEqual(marker.reads, []);
});

test('3.3.6 read, readRequired and a session dry run: only a fifo, socket or device is refused, absent files and folders behave as before', t => { // mutants: remove the stat in read(), in readRequired(), or in readBytes; refuse a folder too (the pinned wording changes)
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kit336z-read-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, 'page.md'), dir = path.join(root, 'folder'), absent = path.join(root, 'absent.md'), fifo = path.join(root, 'fifo.md');
  fs.writeFileSync(file, String.fromCharCode(0xFEFF) + 'text\n'); fs.mkdirSync(dir);
  // pin: what the helpers did already
  assert.equal(read(file), 'text\n'); assert.equal(readRequired(file), 'text\n');
  assert.equal(read(absent), '');
  assert.throws(() => readRequired(absent), {message: `cannot read ${absent}`});
  assert.throws(() => read(dir), {code: 'EISDIR'});
  assert.throws(() => readRequired(dir), {message: `cannot read ${dir}`});
  const marker = pretendSpecial(t, [fifo], {hide: false});
  assert.throws(() => read(fifo), {message: `${fifo} is not a regular file`});
  assert.throws(() => readRequired(fifo), {message: `cannot read ${fifo} (not a regular file)`});
  assert.deepEqual(marker.reads, []);
  // readBytes is private to the checkpoint: a session dry run reaches it through the plan of the overview.
  t.mock.restoreAll();
  const w = world(t, {mode: 'session'});
  const reached = pretendSpecial(t, [w.overview], {hide: false});
  const r = w.run(['--session', '--dry-run']);
  assert.equal(r.status, 1, r.lines.join('\n'));
  assert.ok(r.err.some(line => /docs[\\/]ROADMAP-OVERVIEW\.md is not a regular file/.test(line)), r.lines.join('\n'));
  assert.deepEqual(reached.reads, []);
});

test('3.3.6 checkpoint: an all-sessions run refuses a repo output that is not a regular file before it writes or reads it, and changes no other repo file', t => { // mutants: drop the kind check in the output writer (the run writes it); refuse before recording
  const w = world(t);
  const repoBefore = w.repoTree(), marker = pretendSpecial(t, [w.overview], {hide: false});
  const r = w.run(['--no-push']);
  assert.equal(r.status, 1, r.lines.join('\n'));
  assert.ok(r.err.some(line => /^memory-checkpoint: docs\/ROADMAP-OVERVIEW\.md is not a regular file/.test(line)), r.lines.join('\n'));
  assert.ok(!fs.existsSync(w.overview), 'the overview was not written');
  assert.deepEqual(w.repoTree(), repoBefore, 'no other repo file changed');
  assert.deepEqual(marker.reads, []);
  assert.match(r.out.at(-1), /^repo files changed in .*: could not inspect docs\/ROADMAP-OVERVIEW\.md - compare them by hand/, 'the file is listed as not inspected: ' + r.lines.join('\n'));
});

// ---- items 17 and 7(c): the repo files this run changed, and the kind check in the output writer ----

test('3.3.6 checkpoint: an all-sessions run lists none of a file another writer changed when it wrote none itself', t => { // mutant: restore the unconditional record before the repo outputs
  const w = world(t, {tweak: config => { config.caps.roadmapOverview.enabled = false; }});
  const {result, lines} = w.go({}, step => { if (step === 'brain-index') w.put(w.overview, 'another writer\n'); });
  assert.equal(result.status, 0, lines.join('\n'));
  assert.deepEqual(result.changed.repo, []);
  assert.equal(lines.at(-1), repoLine(w, 'none'), lines.join('\n'));
});

test('3.3.6 checkpoint: a session run lists the brain index files that appeared after planning', t => { // mutant: fill the recorded paths from the plan made before the lock, as the base does
  const w = world(t, {mode: 'session'});
  const {result, lines} = w.go({session: true}, step => { if (step === 'rotate-handovers') w.put(path.join(w.project, 'brain/01-pillars/pil-test.md'), PILLAR); });
  assert.equal(result.status, 0, lines.join('\n'));
  assert.deepEqual(result.changed.repo, ['brain/00-system/index-all.md', 'brain/00-system/index.md', 'docs/ROADMAP-OVERVIEW.md']);
  assert.equal(lines.at(-1), repoLine(w, 'brain/00-system/index-all.md, brain/00-system/index.md, docs/ROADMAP-OVERVIEW.md - commit them in that checkout'), lines.join('\n'));
});

test('3.3.6 checkpoint: a session run stops at an output that turned special after planning, keeps the memory commit and lists the output as not inspected', t => { // mutants: do not refuse the kind; record with readBytes (it throws before the record)
  const w = world(t, {mode: 'session'});
  w.put(path.join(w.memoryDir, 'topic-alpha.md'), topic('topic-alpha') + 'edit\n');
  const late = lateSpecial(t, w.overview), head = w.git(w.memoryDir, 'rev-parse', 'HEAD');
  const {result, lines} = w.go({session: true, files: ['topic-alpha.md']}, step => { if (step === 'brain-index') late.arm(); });
  assert.equal(result.status, 1, lines.join('\n'));
  assert.match(result.error, /docs\/ROADMAP-OVERVIEW\.md is not a regular file/);
  assert.ok(result.sha && result.sha !== head, 'the memory commit stands');
  assert.equal(w.git(w.memoryDir, 'rev-parse', 'HEAD'), result.sha);
  assert.deepEqual(result.uninspected, [{layer: 'repo', path: 'docs/ROADMAP-OVERVIEW.md', error: 'ENOTFILE'}]);
  assert.ok(lines.some(line => /^changed: could not inspect repo:docs\/ROADMAP-OVERVIEW\.md \(ENOTFILE\); compare them by hand$/.test(line)), lines.join('\n'));
  assert.ok(!fs.existsSync(w.overview), 'the overview was not written');
});

test('3.3.6 checkpoint: an output that was special when recorded and a regular file at settlement is reported, not compared', t => { // mutant: compare the bytes before checking the recorded error (settle throws on the missing bytes)
  const w = world(t, {mode: 'session'});
  w.put(w.overview, '# stale overview\n');
  w.lesson('Own lesson');
  w.put(path.join(w.memoryDir, 'topic-alpha.md'), topic('topic-alpha') + 'edit\n');
  const late = lateSpecial(t, w.overview, {disarmUnder: w.memoryDir});
  let outcome;
  assert.doesNotThrow(() => { outcome = w.go({session: true, files: ['topic-alpha.md']}, step => { if (step === 'brain-index') late.arm(); }); });
  const {result, lines} = outcome;
  assert.equal(result.status, 1, lines.join('\n'));
  assert.deepEqual(result.uninspected, [{layer: 'repo', path: 'docs/ROADMAP-OVERVIEW.md', error: 'ENOTFILE'}]);
  assert.equal(late.readsAfter.length, 1, 'settlement read the regular bytes once: ' + late.readsAfter.join(', '));
  assert.equal(fs.readFileSync(w.overview, 'utf8'), '# stale overview\n', 'the overview was not rewritten');
});

// ---- item 10: lock names in the checkpoint ----

test('3.3.6 checkpoint: the memory snapshot skips every spelling of a lock file and keeps the obsolete push-lock name', t => { // mutant: the base pattern at the snapshot (a case variant is listed, the old name is skipped)
  const w = world(t);
  const {result, lines} = w.go({}, step => {
    if (step === 'memory-index') for (const name of ['.Memory.Lock.stale-1', '.memory.lock.push.stale-2', '.memory.push.lock']) w.put(path.join(w.memoryDir, name), 'x\n');
  });
  assert.equal(result.status, 0, lines.join('\n'));
  assert.deepEqual(result.changed.memory, ['.memory.push.lock']);
});

test('3.3.6 checkpoint: the changed-path list of a session run skips every spelling of a lock file and keeps the obsolete push-lock name', t => { // mutant: the base pattern at the changed-path list (a case variant is listed, the old name is skipped)
  const w = world(t, {mode: 'session'});
  w.put(path.join(w.memoryDir, '.gitignore'), '.sessions/\n');
  w.git(w.memoryDir, 'add', '-A'); w.git(w.memoryDir, 'commit', '-m', 'stop ignoring locks');
  for (const name of ['.Memory.Lock.stale-3', 'sub/.memory.lock.push.stale-4', '.memory.push.lock']) w.put(path.join(w.memoryDir, name), 'x\n');
  const {result, lines} = w.go({session: true});
  assert.equal(result.status, 0, lines.join('\n'));
  assert.deepEqual(result.exceptions.filter(e => e.kind === 'unclaimed').map(e => e.file).sort(), ['.memory.push.lock']);
});

// ---- item 15: a failed atomic write keeps its error and names the file it left ----

for (const inRepo of [false, true]) test(`3.3.6 checkpoint: a log rotation whose rename and temp-file removal both fail names the leftover file (${inRepo ? 'memory inside the project' : 'external memory'})`, t => { // mutant: drop the residue push in the atomic write (the removal error replaces the rename error and nothing is named)
  const w = world(t, {brain: true, rotate: true, inRepo});
  w.lesson('Own lesson');
  const rename = fs.renameSync, unlink = fs.unlinkSync;
  t.mock.method(fs, 'renameSync', function (from, to, ...rest) { if (/00-system[\\/]log\.md$/.test(String(to))) throw Object.assign(new Error('EACCES: rename blocked'), {code: 'EACCES'}); return rename.call(this, from, to, ...rest); });
  t.mock.method(fs, 'unlinkSync', function (file, ...rest) { if (/\.tmp$/.test(String(file))) throw Object.assign(new Error('EBUSY: temp file busy'), {code: 'EBUSY'}); return unlink.call(this, file, ...rest); });
  const {result, lines} = w.go();
  t.mock.restoreAll();
  assert.equal(result.status, 1, lines.join('\n'));
  assert.match(result.error, /rename blocked/, 'the rename error is the error: ' + result.error);
  const left = result.uninspected.filter(u => u.error === 'left behind');
  assert.equal(left.length, 1, JSON.stringify(result.uninspected));
  assert.equal(left[0].layer, 'repo');
  assert.match(left[0].path, /00-system[\\/]log\.md\.[0-9a-f-]+\.tmp$/);
  assert.ok(fs.existsSync(left[0].path), 'the leftover file is there');
  assert.ok(lines.some(line => /^changed: could not inspect .*\.tmp \(left behind\)/.test(line)), lines.join('\n'));
  if (!inRepo) assert.match(lines.at(-1), /^repo files changed in .*could not inspect .*\.tmp/, lines.join('\n'));
});

// ---- item 16: repoRoot ----

test('3.3.6 checkpoint: without --repo, in an installed layout whose folders cannot be resolved, the header and the cause are printed', () => { // mutant: remove repoRoot from the import (ReferenceError, no header)
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kit336z-layout-')));
  try {
    const engine = path.join(root, 'proj/scripts/memory');
    fs.mkdirSync(path.dirname(engine), {recursive: true});
    fs.cpSync(path.join(kitRoot, 'engine'), engine, {recursive: true});
    fs.writeFileSync(path.join(engine, 'KIT.json'), '{broken');
    const env = {...process.env}; delete env.CLAUDE_MEMORY_DIR;
    const r = spawnSync(process.execPath, [path.join(engine, 'memory-checkpoint.mjs'), '--dry-run'], {encoding: 'utf8', cwd: path.join(root, 'proj'), env});
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const lines = r.stdout.split('\n');
    assert.equal(lines[0], `checkpoint: repo ${path.join(root, 'proj')}; memory unresolved (error below)`, r.stdout + r.stderr);
    assert.match(r.stderr, /^memory-checkpoint: cannot read .*KIT\.json/m);
    assert.doesNotMatch(r.stderr, /ReferenceError/);
  } finally { fs.rmSync(root, {recursive: true, force: true, maxRetries: 5}); }
});

// ---- item 18: the checkpoint's scratch folders ----

test('3.3.6 checkpoint: a dry run whose temporary folder is inside the project says it cannot plan and writes nothing in the project or memory', t => { // mutant: remove the scratch-folder guard in the dry run's plan
  const w = world(t);
  const inside = path.join(w.project, '.tmp'); fs.mkdirSync(inside);
  const before = [w.memoryTree(), w.repoTree(), w.refs()];
  const {result: r, targets} = w.writesDuring(() => w.run(['--dry-run'], {env: {TEMP: inside, TMP: inside, TMPDIR: inside}}));
  assert.equal(r.status, 0, r.lines.join('\n'));
  assert.ok(r.lines.some(line => /^would change: could not be planned \(the temporary folder .* is inside .*; set TEMP and TMP to a folder outside the project and the memory folder\)$/.test(line)), r.lines.join('\n'));
  assert.deepEqual(targets.filter(w.inside), [], 'nothing is written, made or removed in the project or the memory folder');
  assert.deepEqual([w.memoryTree(), w.repoTree(), w.refs()], before);
});

for (const mode of ['all', 'session']) test(`3.3.6 checkpoint: a real ${mode} run whose temporary folder is inside the memory folder refuses before it takes a claim, writes a page or commits`, t => { // mutant: remove the check at the start of a real run (the session guard at the candidate folder refuses after the claim is written; an all-sessions run does not refuse at all)
  const w = world(t, {mode});
  const inside = path.join(w.memoryDir, '.tmp'); fs.mkdirSync(inside);
  w.put(path.join(w.memoryDir, 'topic-alpha.md'), topic('topic-alpha') + 'edit\n');
  const before = [w.memoryTree({sessions: true}), w.repoTree(), w.refs()];
  const r = w.run(mode === 'session' ? ['--session', '--no-push', '--files', 'topic-alpha.md'] : ['--no-push'], {env: {TEMP: inside, TMP: inside, TMPDIR: inside}});
  assert.equal(r.status, 1, r.lines.join('\n'));
  assert.ok(r.err.some(line => /^memory-checkpoint: the temporary folder .* is inside .*; set TEMP and TMP to a folder outside the project and the memory folder$/.test(line)), r.lines.join('\n'));
  assert.deepEqual([w.memoryTree({sessions: true}), w.repoTree(), w.refs()], before, 'no claim, no page, no commit, no repo file');
});

// ---- item 19: the dry run's copy holds the non-markdown system files ----

test('3.3.6 checkpoint: a dry run does not list the brain index as changing because of a system file that is not markdown', t => { // mutant: drop the placeholder loop in the dry run's copy
  const w = world(t, {brain: true, tweak: config => { config.caps.brainIndex.systemFiles = [...config.caps.brainIndex.systemFiles, 'policy.txt']; }});
  w.put(path.join(w.project, 'brain/00-system/policy.txt'), 'policy\n');
  const first = w.run(['--no-push']);
  assert.equal(first.status, 0, first.lines.join('\n'));
  assert.match(fs.readFileSync(path.join(w.project, 'brain/00-system/index.md'), 'utf8'), /\[policy\.txt\]\(policy\.txt\)/, 'the real run lists the system file');
  const dry = w.run(['--dry-run']);
  assert.equal(dry.status, 0, dry.lines.join('\n'));
  assert.ok(dry.lines.includes('would change: nothing'), 'the real run changes nothing more, so the plan names nothing: ' + dry.lines.join('\n'));
});

// ---- item 20: a hard-rule card linked by wikilink ----

test('3.3.6 lib: hardRuleTargets still reads only inline links (pin); the wikilink cards come from the same heading through memoryFiles', () => { // mutant: none for the pin; the selftest case beside R12 covers the wikilink form
  assert.deepEqual(hardRuleTargets('## Hard rules\n[Rule](rule.md)\n[[card]]\n## Topics\n[Topic](topic.md)'), ['rule.md']);
});

// ---- item 24: the checkpoint and the operator's uncommitted files ----

const outputsOf = files => files.filter(f => /^(?:brain\/00-system\/|docs\/ROADMAP)/.test(f));
const failingStatus = () => ({status: 128, stdout: ' M brain/00-system/index.md\0 M docs/ROADMAP.md\0', stderr: 'fatal: injected status failure\n'});
// Only the n-th git call (1-based, every call counts) fails; the others are the real git. A dry run asks once per planned file
// and a --commit once per output group, so this is the call that fails after others have answered.
const failingAt = n => { let calls = 0; return (dir, argv, options) => ++calls === n ? failingStatus() : realGitRun(dir, argv, options); };
// The call itself throws (git is missing: spawn ENOENT).
const missingGit = () => { throw Object.assign(new Error('spawn git ENOENT'), {code: 'ENOENT'}); };
const commit = (w, message) => { w.git(w.project, 'add', '-A'); w.git(w.project, 'commit', '-m', message); };

test('3.3.6 checkpoint: a dry run names the repo outputs it would rewrite that are already modified, and only those', t => { // mutants: drop the line; print the line whatever git reports; trust the output of a failed status (a failed git with parseable output prints a line); print the paths that answered when another call did not
  const w = world(t, {brain: true});
  // A project that never ran a checkpoint has no output file yet: nothing is modified.
  const fresh = w.run(['--dry-run']);
  assert.ok(fresh.lines.some(line => line.startsWith('would change: ') && line !== 'would change: nothing'), fresh.lines.join('\n'));
  assert.ok(!fresh.lines.some(line => line.startsWith('already modified:')), fresh.lines.join('\n'));
  // The outputs exist and are committed; one is edited by hand.
  assert.equal(w.run(['--no-push']).status, 0);
  commit(w, 'outputs committed');
  assert.ok(w.run(['--dry-run']).lines.includes('would change: nothing'));
  fs.appendFileSync(path.join(w.project, 'brain/00-system/index.md'), 'hand edit\n');
  const dry = w.run(['--dry-run']);
  assert.ok(dry.lines.includes('would change: brain/00-system/index.md'), dry.lines.join('\n'));
  assert.ok(dry.lines.includes(`already modified: brain/00-system/index.md (uncommitted in ${w.project}); a real run rewrites them`), dry.lines.join('\n'));
  // git cannot answer: no line, even when the failed call printed what looks like an entry.
  const failed = w.go({dryRun: true, gitRun: failingStatus});
  assert.equal(failed.result.status, 0, failed.lines.join('\n'));
  assert.ok(failed.lines.includes('would change: brain/00-system/index.md'), failed.lines.join('\n'));
  assert.ok(!failed.lines.some(line => line.startsWith('already modified:')), failed.lines.join('\n'));
  // git is missing: no line either
  const missing = w.go({dryRun: true, gitRun: missingGit});
  assert.equal(missing.result.status, 0, missing.lines.join('\n'));
  assert.ok(!missing.lines.some(line => line.startsWith('already modified:')), missing.lines.join('\n'));
  // several planned files, both modified; the second answer fails: no line at all, not the one path that did answer
  fs.appendFileSync(path.join(w.project, 'brain/00-system/index-all.md'), 'hand edit\n');
  const both = w.go({dryRun: true});
  assert.ok(both.lines.includes(`already modified: brain/00-system/index-all.md, brain/00-system/index.md (uncommitted in ${w.project}); a real run rewrites them`), both.lines.join('\n'));
  const partial = w.go({dryRun: true, gitRun: failingAt(2)});
  assert.equal(partial.result.status, 0, partial.lines.join('\n'));
  assert.ok(partial.lines.some(line => line.startsWith('would change: ') && line.includes('index.md') && line.includes('index-all.md')), partial.lines.join('\n'));
  assert.ok(!partial.lines.some(line => line.startsWith('already modified:')), partial.lines.join('\n'));
});

test('3.3.6 checkpoint: a session dry run names the repo outputs it would rewrite that are already modified', t => { // mutant: drop the line from the session dry run
  const w = world(t, {mode: 'session', brain: true});
  assert.equal(w.run(['--session', '--no-push']).status, 0);
  commit(w, 'outputs committed');
  fs.appendFileSync(path.join(w.project, 'brain/00-system/index-all.md'), 'hand edit\n');
  const dry = w.run(['--session', '--dry-run']);
  assert.equal(dry.status, 0, dry.lines.join('\n'));
  assert.ok(dry.lines.includes(`already modified: brain/00-system/index-all.md (uncommitted in ${w.project}); a real run rewrites them`), dry.lines.join('\n'));
});

test('3.3.6 checkpoint: --commit in a project with memory inside it leaves out an output group that was uncommitted before the run, and names it', t => { // mutant: commit the selected paths unfiltered
  const w = world(t, {inRepo: true, brain: true, rotate: true});
  fs.appendFileSync(path.join(w.project, 'docs/ROADMAP.md'), '**2026-11-06** operator edit\n\n');
  const {result, lines} = w.go({commit: true});
  assert.equal(result.status, 0, lines.join('\n'));
  const files = w.committed();
  assert.ok(files.includes('brain/00-system/log.md') && files.includes('brain/00-system/index.md') && files.includes('brain/00-system/index-all.md'), 'the clean groups are committed: ' + files.join(', '));
  assert.deepEqual(files.filter(f => /^docs\//.test(f)), [], 'neither the roadmap nor its history or overview is committed');
  assert.ok(lines.includes('commit: left out (uncommitted before this checkpoint): docs/ROADMAP.md, docs/ROADMAP-OVERVIEW.md, docs/ROADMAP-HISTORY.md; commit them yourself'), lines.join('\n'));
  assert.match(fs.readFileSync(path.join(w.project, 'docs/ROADMAP.md'), 'utf8'), /operator edit/, 'the edit stays in the working file');
  assert.ok(fs.existsSync(path.join(w.project, 'docs/ROADMAP-HISTORY.md')), 'the rotation was written');
  assert.match(w.git(w.project, 'status', '--porcelain'), /docs\/ROADMAP\.md/, 'the roadmap is still uncommitted');
});

test('3.3.6 checkpoint: --commit in a clean project commits every selected path and prints no left-out line', t => { // mutant: leave a group out whatever git reports
  const w = world(t, {inRepo: true, brain: true, rotate: true});
  const {result, lines} = w.go({commit: true});
  assert.equal(result.status, 0, lines.join('\n'));
  const files = w.committed();
  for (const file of ['docs/ROADMAP.md', 'docs/ROADMAP-HISTORY.md', 'docs/ROADMAP-OVERVIEW.md', 'brain/00-system/log.md', 'brain/00-system/index.md', 'brain/00-system/index-all.md']) assert.ok(files.includes(file), `${file} in ${files.join(', ')}`);
  assert.ok(!lines.some(line => /^commit: left out/.test(line)), lines.join('\n'));
});

test('3.3.6 checkpoint: an untracked brain index left by an earlier run without --commit is left out of the next --commit, with index-all', t => { // mutant: take the porcelain code set without untracked files
  const w = world(t, {inRepo: true, brain: true});
  assert.equal(w.go().result.status, 0);
  w.git(w.project, 'add', 'docs/ROADMAP-OVERVIEW.md'); w.git(w.project, 'commit', '-m', 'overview committed');
  assert.match(w.git(w.project, 'status', '--porcelain', '--untracked-files=all'), /\?\? brain\/00-system\/index\.md/);
  w.lesson('Own lesson');
  const {result, lines} = w.go({commit: true});
  assert.equal(result.status, 0, lines.join('\n'));
  assert.ok(result.sha && w.committed().some(f => /^memory\/lesson-/.test(f)), 'the run committed the memory folder: ' + w.committed().join(', '));
  assert.deepEqual(outputsOf(w.committed()), [], 'no output file is committed: ' + w.committed().join(', '));
  assert.ok(lines.includes('commit: left out (uncommitted before this checkpoint): brain/00-system/index.md, brain/00-system/index-all.md; commit them yourself'), lines.join('\n'));
});

test('3.3.6 checkpoint: --commit when git cannot report the status leaves every output group out, commits the memory folder and names the failure', t => { // mutants: treat a failed status as none modified; trust the output of a failed status; unknown for the failing group only
  // the first call fails; the third (the last group) fails after two answered clean; git is missing: each case has its own project
  const cases = [[failingStatus, 'fatal: injected status failure'], [failingAt(3), 'fatal: injected status failure'], [missingGit, 'spawn git ENOENT']];
  for (const [gitRun, why] of cases) {
    const w = world(t, {inRepo: true, brain: true, rotate: true});
    w.lesson('Own lesson');
    const {result, lines} = w.go({commit: true, gitRun});
    assert.equal(result.status, 0, lines.join('\n'));
    const files = w.committed();
    assert.ok(files.some(f => /^memory\/lesson-.*own-lesson\.md$/.test(f)), 'the memory folder is committed: ' + files.join(', '));
    assert.deepEqual(outputsOf(files), [], 'no output file is committed: ' + files.join(', '));
    const line = lines.find(l => l.startsWith('commit: left out'));
    assert.match(line, new RegExp(`^commit: left out \\(git status failed: ${why}\\): .*docs/ROADMAP\\.md.*brain/00-system/index\\.md.*; commit them yourself$`), lines.join('\n'));
  }
});

test('3.3.6 checkpoint: --commit with the memory folder around the brain index still leaves a left-out output out of the commit', t => { // mutant: drop the exclude pathspecs (the memory folder pathspec takes the outputs in)
  const w = world(t, {inRepo: true, inRepoDir: 'brain', brain: true});
  w.lesson('Own lesson');
  const {result, lines} = w.go({commit: true, gitRun: failingStatus});
  assert.equal(result.status, 0, lines.join('\n'));
  const files = w.committed();
  assert.ok(files.some(f => /^brain\/lesson-.*own-lesson\.md$/.test(f)), 'the memory folder is committed: ' + files.join(', '));
  assert.deepEqual(outputsOf(files), [], 'no output file is committed: ' + files.join(', '));
  assert.ok(lines.some(l => l.startsWith('commit: left out (git status failed:') && /brain\/00-system\/index\.md/.test(l)), lines.join('\n'));
});

test('3.3.6 checkpoint: without --commit the printed git add suggestion is unchanged even when an output was modified (pin)', t => { // mutant: filter the suggestion too
  const w = world(t, {inRepo: true, brain: true, rotate: true});
  fs.appendFileSync(path.join(w.project, 'docs/ROADMAP.md'), '**2026-11-06** operator edit\n\n');
  const {result, lines} = w.go();
  assert.equal(result.status, 0, lines.join('\n'));
  const suggestion = lines.find(l => l.startsWith('commit: in-repo memory; from repo root: git add --'));
  assert.ok(suggestion && suggestion.includes("'docs/ROADMAP.md'") && suggestion.includes("'brain/00-system/index.md'"), lines.join('\n'));
  assert.ok(!lines.some(l => l.startsWith('commit: left out')), lines.join('\n'));
});

// ---- item 9: a cleanup error never replaces the real result ----

const busy = target => Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${target}'`), {code: 'EBUSY'});

test('3.3.6 promote: a rehearsal folder that cannot be removed leaves the proof result intact and is named', t => { // mutant: put the unguarded removal back in the finally
  const f = fixture(t), memoryDir = path.join(f.root, 'memory'), also = path.join(f.target, 'brain');
  const note = (name, body = 'Keep the violet calibration result.\n') => `---\nname: ${name}\ndescription: Verify the measured result before another operation.\ncustom: "retain: this"\nmetadata:\n  type: feedback\n  route: [craft-demo]\n  date: 2026-01-02\n---\n\n${body}`;
  putFile(path.join(memoryDir, 'MEMORY.md'), '# Memory\n\n## Routes\n- [Craft](INDEX-craft-demo.md) OPEN BEFORE crafting.\n');
  putFile(path.join(memoryDir, 'alpha-note.md'), note('alpha-note'));
  putFile(path.join(also, 'nested', 'references.md'), '[[alpha-note]]\n');
  const config = loadConfig(); config.pins = {'craft-demo': ['alpha-note.md']};
  putFile(path.join(f.target, 'scripts/memory/memory.config.json'), JSON.stringify(config));
  putFile(path.join(f.target, 'scripts/memory/recall-probes.json'), JSON.stringify({version: 1, minPass: 1, probes: [{id: 'violet', q: 'violet calibration', expect: ['alpha-note.md']}]}));
  writeMemoryIndex({memoryDir, config});
  const mapFile = putFile(path.join(f.root, 'map.json'), JSON.stringify({version: 1, promote: {'alpha-note.md': {kind: 'mistake', trigger: 'before calibration', case: 'K3', pin: false}}}));
  const rm = fs.rmSync, notes = [];
  t.mock.method(console, 'error', line => notes.push(String(line)));
  t.mock.method(fs, 'rmSync', function (file, ...rest) { if (/memory-promote-[^\\/]*$/.test(String(file))) throw busy(String(file)); return rm.call(this, file, ...rest); });
  const result = promoteTopics({memoryDir, repo: f.target, map: mapFile, also: [also]});
  assert.equal(result.written, false);
  assert.equal(result.rows.length, 1);
  assert.ok(notes.some(line => /could not remove .*memory-promote-.*delete it by hand/.test(line)), notes.join('\n'));
});

test('3.3.6 install: an ignore-audit scratch folder that cannot be removed leaves the audit result unchanged and is named', t => { // mutant: put the unguarded removal back in the finally
  const f = fixture(t);
  putFile(path.join(f.target, '.gitignore'), 'scripts/memory/\n');
  putFile(path.join(f.target, 'scripts/memory/KIT.json'), '{}\n');
  const rm = fs.rmSync, notes = [];
  t.mock.method(console, 'error', line => notes.push(String(line)));
  t.mock.method(fs, 'rmSync', function (file, ...rest) { if (/kit-ignore-[^\\/]*$/.test(String(file))) throw busy(String(file)); return rm.call(this, file, ...rest); });
  const logs = []; t.mock.method(console, 'log', line => logs.push(String(line)));
  const plan = checkInstalledIgnores(f.target, [path.join(f.target, 'scripts/memory/KIT.json')], {});
  assert.equal(plan[0], path.join(f.target, '.gitignore'));
  assert.match(plan[1], /!\/scripts\/memory\//);
  assert.ok(logs.some(line => /^WARN ignored installed file:/.test(line)), logs.join('\n'));
  assert.ok(notes.some(line => /could not remove .*kit-ignore-.*delete it by hand/.test(line)), notes.join('\n'));
});

test('3.3.6 memory lock: a stale lock whose removal fails is broken, the lock is acquired and the note names the stale file', t => { // mutant: put the unguarded removal back in the finally
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kit336z-lock-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, '.memory.lock'), time = new Date(Date.now() - 700000).toISOString();
  fs.writeFileSync(file, JSON.stringify({pid: 2147483647, host: os.hostname(), time}));
  const rm = fs.rmSync, notes = [];
  t.mock.method(fs, 'rmSync', function (target, ...rest) { if (/\.memory\.lock\.stale-/.test(String(target))) throw busy(String(target)); return rm.call(this, target, ...rest); });
  assert.equal(withMemoryLock(root, () => 'acquired', {note: line => notes.push(String(line))}), 'acquired');
  assert.ok(notes.some(line => /could not remove .*\.memory\.lock\.stale-.*delete it by hand/.test(line)), notes.join('\n'));
  assert.ok(!fs.existsSync(file), 'the lock itself was released');
});

// ---- review fixes ----

test('3.3.6 read helpers: a stat error that is not an absent path propagates through each helper\'s own error path and nothing is read', t => { // mutant: swallow every stat error in the kind check again (the read goes ahead without knowing the kind)
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kit336z-staterr-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, 'page.md');
  fs.writeFileSync(file, 'text\n');
  const marker = statFails(t, [file], 'EACCES');
  assert.throws(() => read(file), {code: 'EACCES'});
  assert.throws(() => readRequired(file), {message: `cannot read ${file}`});
  assert.deepEqual(marker.reads, []);
  // readBytes is private to the checkpoint: a session dry run reaches it through the plan of the overview.
  t.mock.restoreAll();
  const w = world(t, {mode: 'session'});
  w.put(w.overview, '# overview\n');
  const reached = statFails(t, [w.overview], 'EACCES');
  const r = w.run(['--session', '--dry-run']);
  assert.equal(r.status, 1, r.lines.join('\n'));
  assert.ok(r.err.some(line => /EACCES/.test(line)), r.lines.join('\n'));
  assert.deepEqual(reached.reads, []);
});

test('3.3.6 lib: writeText refuses a fifo, socket or device before it reads or writes it, and keeps its behaviour for absent files, ordinary files, folders and stat errors', t => { // mutant: remove the kind check from writeText
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kit336z-writetext-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const absent = path.join(root, 'absent.md'), crlf = path.join(root, 'crlf.md'), dir = path.join(root, 'folder'), fifo = path.join(root, 'fifo.md'), denied = path.join(root, 'denied.md');
  // pin: what writeText did already
  writeText(absent, 'one\ntwo\n');
  assert.equal(fs.readFileSync(absent, 'utf8'), 'one\ntwo\n');
  fs.writeFileSync(crlf, 'a\r\nb\r\n');
  writeText(crlf, 'x\ny\n');
  assert.equal(fs.readFileSync(crlf, 'utf8'), 'x\r\ny\r\n', 'the line endings of the destination are kept');
  fs.mkdirSync(dir);
  assert.throws(() => writeText(dir, 'x\n'), {code: 'EISDIR'});
  fs.writeFileSync(fifo, 'must not be touched\n'); fs.writeFileSync(denied, 'must not be touched\n');
  const special = pretendSpecial(t, [fifo], {hide: false});
  assert.throws(() => writeText(fifo, 'x\n'), {message: `${fifo} is not a regular file`});
  assert.deepEqual(special.reads, []);
  const failing = statFails(t, [denied], 'EACCES');
  assert.throws(() => writeText(denied, 'x\n'), {code: 'EACCES'});
  assert.deepEqual(failing.reads, []);
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(fifo, 'utf8'), 'must not be touched\n');
});

test('3.3.6 checkpoint: a session run reports a main brain index that turned special after planning as not inspected, not as unchanged', t => { // mutant: remove the record and kind check before the generator's read of the main index
  const w = world(t, {mode: 'session', brain: true});
  const first = w.go({session: true});
  assert.equal(first.result.status, 0, first.lines.join('\n'));
  const index = path.join(w.project, 'brain/00-system/index.md');
  assert.ok(fs.existsSync(index), 'the first run wrote the main index');
  const late = lateSpecial(t, index);
  const {result, lines} = w.go({session: true}, step => { if (step === 'commit') late.arm(); });
  assert.equal(result.status, 1, lines.join('\n'));
  assert.deepEqual(result.uninspected, [{layer: 'repo', path: 'brain/00-system/index.md', error: 'ENOTFILE'}]);
  assert.ok(lines.some(line => /^changed: could not inspect repo:brain\/00-system\/index\.md \(ENOTFILE\); compare them by hand$/.test(line)), lines.join('\n'));
});

// A configured path may be spelled with a dot part or, on Windows, backslashes. Git, not this code, reads the spelling (pin C1:
// it normalises ./ and .. and, on Windows, \ the way the writer's path.resolve did), and every line names the path as the
// configuration spells it (the same spelling the `would change` line and the commit's include list use).
const SPELLINGS = ['./docs/ROADMAP.md', 'docs/../docs/ROADMAP.md', ...(process.platform === 'win32' ? ['docs\\ROADMAP.md', '.\\docs\\ROADMAP.md'] : [])];
test('3.3.6 checkpoint: the dry run names an already-modified roadmap whichever way the configured path is spelled (pin of C1; git reads the spelling)', t => { // no kit code to mutate: the spelling goes to git as configured
  for (const spelling of SPELLINGS) {
    const w = world(t, {brain: true, rotate: true, tweak: config => { config.caps.roadmap.path = spelling; }});
    fs.appendFileSync(path.join(w.project, 'docs/ROADMAP.md'), '**2026-11-06** operator edit\n\n');
    const dry = w.run(['--dry-run']);
    assert.equal(dry.status, 0, dry.lines.join('\n'));
    // the writer reports the path with forward slashes; the line names it the way `would change` does
    const name = spelling.replaceAll('\\', '/'), planned = dry.lines.find(line => line.startsWith('would change: ')).slice('would change: '.length).split(', ');
    assert.ok(planned.includes(name), `${name} is planned: ${planned.join(', ')}`);
    assert.ok(dry.lines.includes(`already modified: ${name} (uncommitted in ${w.project}); a real run rewrites them`), `${spelling}: ${dry.lines.join('\n')}`);
  }
});

test('3.3.6 checkpoint: --commit leaves out an already-modified roadmap group whichever way the configured path is spelled (pin of C1)', t => { // no kit code to mutate: the spelling goes to git as configured
  for (const spelling of SPELLINGS) {
    const w = world(t, {inRepo: true, brain: true, rotate: true, tweak: config => { config.caps.roadmap.path = spelling; }});
    fs.appendFileSync(path.join(w.project, 'docs/ROADMAP.md'), '**2026-11-06** operator edit\n\n');
    const {result, lines} = w.go({commit: true});
    assert.equal(result.status, 0, `${spelling}: ${lines.join('\n')}`);
    assert.deepEqual(w.committed().filter(f => /^docs\//.test(f)), [], `${spelling}: neither the roadmap nor its history or overview is committed: ` + w.committed().join(', '));
    assert.ok(lines.includes(`commit: left out (uncommitted before this checkpoint): ${spelling}, docs/ROADMAP-OVERVIEW.md, docs/ROADMAP-HISTORY.md; commit them yourself`), `${spelling}: ${lines.join('\n')}`);
    assert.match(w.git(w.project, 'status', '--porcelain'), /docs\/ROADMAP\.md/, `${spelling}: the roadmap is still uncommitted`);
  }
});

test('3.3.6 checkpoint: --commit leaves the whole brain log group out when a tracked archive was deleted before the run', t => { // mutant: take the archives from a listing of the folder on disk only, not from the status of the folder
  const w = world(t, {inRepo: true, brain: true, rotate: true});
  assert.equal(w.go({commit: true}).result.status, 0);
  const archive = 'brain/00-system/log-2026-09.md';
  assert.ok(w.git(w.project, 'ls-files', archive), 'the first run committed the archive');
  fs.rmSync(path.join(w.project, archive));
  w.config.caps.brainLog.keepEntries = 2; // this run rotates one more entry: log.md and log-2026-10.md change
  w.lesson('Own lesson');
  const {result, lines} = w.go({commit: true});
  assert.equal(result.status, 0, lines.join('\n'));
  const files = w.committed();
  assert.ok(files.some(f => /^memory\/lesson-/.test(f)), 'the memory folder is committed: ' + files.join(', '));
  assert.deepEqual(files.filter(f => /^brain\/00-system\/log/.test(f)), [], 'no member of the log group is committed: ' + files.join(', '));
  assert.ok(lines.some(line => /^commit: left out \(uncommitted before this checkpoint\): .*brain\/00-system\/log\.md.*; commit them yourself$/.test(line)), lines.join('\n'));
  assert.match(w.git(w.project, 'status', '--porcelain'), /D brain\/00-system\/log-2026-09\.md/, 'the deletion is still the operator\'s');
});

// ---- review fixes: exact identities, a status query that matches whatever the case, a project below the repository root ----

test('3.3.6 checkpoint: files in or below the log folder that look like outputs of another folder mark no group, and the clean outputs are committed', t => { // mutants: ask git about the whole log folder; write the archive glob as **/log-*.md
  const w = world(t, {inRepo: true, brain: true, rotate: true});
  // nested lookalikes, an ordinary file in the log folder itself, and an archive-named file one folder deeper
  const lookalikes = ['brain/00-system/snapshot/docs/ROADMAP.md', 'brain/00-system/snapshot/brain/00-system/log-2026-09.md', 'brain/00-system/notes.md', 'brain/00-system/snapshot/log-2026-09.md'];
  for (const file of lookalikes) w.put(path.join(w.project, file), 'lookalike\n');
  commit(w, 'lookalikes committed');
  for (const file of lookalikes) fs.appendFileSync(path.join(w.project, file), 'edited by the operator\n');
  // the dry run first (the outputs would change, so it asks): nothing of the outputs is already modified
  const dry = w.go({dryRun: true});
  assert.ok(dry.lines.some(line => line.startsWith('would change:') && line.includes('ROADMAP.md')), dry.lines.join('\n'));
  assert.ok(!dry.lines.some(line => line.startsWith('already modified:')), dry.lines.join('\n'));
  const {result, lines} = w.go({commit: true});
  assert.equal(result.status, 0, lines.join('\n'));
  assert.ok(!lines.some(line => line.startsWith('commit: left out')), lines.join('\n'));
  const files = w.committed();
  for (const file of ['docs/ROADMAP.md', 'docs/ROADMAP-HISTORY.md', 'docs/ROADMAP-OVERVIEW.md', 'brain/00-system/log.md', 'brain/00-system/index.md', 'brain/00-system/index-all.md']) assert.ok(files.includes(file), `${file} in ${files.join(', ')}`);
  for (const file of lookalikes) assert.ok(!files.includes(file), `${file} is the operator's, not an output`);
});

// A configured path may differ in case from the tracked file on a file system that ignores case; git's pathspecs are
// case-sensitive, so the query itself has to match whatever the case.
const caseless = w => { try { return fs.existsSync(path.join(w.project, 'docs/roadmap.md')); } catch { return false; } };

test('3.3.6 checkpoint: the dry run names an already-modified roadmap whose configured path differs from the tracked file only in case (real git status)', t => { // mutant: a literal pathspec without the icase magic
  const w = world(t, {brain: true, rotate: true, tweak: config => { config.caps.roadmap.path = 'docs/roadmap.md'; }});
  if (!caseless(w)) { t.skip('this file system is case-sensitive: a path of another case is another file'); return; }
  fs.appendFileSync(path.join(w.project, 'docs/ROADMAP.md'), '**2026-11-06** operator edit\n\n');
  const dry = w.run(['--dry-run']);
  assert.equal(dry.status, 0, dry.lines.join('\n'));
  assert.ok(dry.lines.includes(`already modified: docs/roadmap.md (uncommitted in ${w.project}); a real run rewrites them`), dry.lines.join('\n'));
});

test('3.3.6 checkpoint: --commit leaves out an already-modified roadmap group whose configured path differs from the tracked file only in case (real git status)', t => { // mutant: a literal pathspec without the icase magic
  const w = world(t, {inRepo: true, brain: true, rotate: true, tweak: config => { config.caps.roadmap.path = 'docs/roadmap.md'; }});
  if (!caseless(w)) { t.skip('this file system is case-sensitive: a path of another case is another file'); return; }
  fs.appendFileSync(path.join(w.project, 'docs/ROADMAP.md'), '**2026-11-06** operator edit\n\n');
  const {result, lines} = w.go({commit: true});
  assert.equal(result.status, 0, lines.join('\n'));
  assert.deepEqual(w.committed().filter(f => /^docs\//i.test(f)), [], 'no roadmap file is committed: ' + w.committed().join(', '));
  assert.ok(lines.includes('commit: left out (uncommitted before this checkpoint): docs/roadmap.md, docs/ROADMAP-OVERVIEW.md, docs/ROADMAP-HISTORY.md; commit them yourself'), lines.join('\n'));
  assert.match(w.git(w.project, 'status', '--porcelain'), /docs\/ROADMAP\.md/, 'the roadmap is still uncommitted');
});

test('3.3.6 checkpoint: a project in a folder of the git repository still marks a modified roadmap, in the dry run and in --commit (pin)', t => { // mutant: keep the repository-root prefix on git's paths
  const dry = world(t, {nested: true, brain: true, rotate: true});
  fs.appendFileSync(path.join(dry.project, 'docs/ROADMAP.md'), '**2026-11-06** operator edit\n\n');
  const line = dry.run(['--dry-run']).lines.find(l => l.startsWith('already modified:'));
  assert.equal(line, `already modified: docs/ROADMAP.md (uncommitted in ${dry.project}); a real run rewrites them`);
  const w = world(t, {nested: true, inRepo: true, brain: true, rotate: true});
  fs.appendFileSync(path.join(w.project, 'docs/ROADMAP.md'), '**2026-11-06** operator edit\n\n');
  const {result, lines} = w.go({commit: true});
  assert.equal(result.status, 0, lines.join('\n'));
  assert.deepEqual(w.committed().filter(f => /^docs\//.test(f)), [], 'no roadmap file is committed: ' + w.committed().join(', '));
  assert.ok(lines.includes('commit: left out (uncommitted before this checkpoint): docs/ROADMAP.md, docs/ROADMAP-OVERVIEW.md, docs/ROADMAP-HISTORY.md; commit them yourself'), lines.join('\n'));
});

test('3.3.6 checkpoint: --commit with the memory folder around the brain index leaves out a clean output of a left group whose configured path differs from the tracked file only in case (real git)', t => { // mutant: an exclude pathspec without the icase magic
  const w = world(t, {inRepo: true, inRepoDir: 'brain', brain: true});
  if (!caseless(w)) { t.skip('this file system is case-sensitive: a path of another case is another file'); return; }
  assert.equal(w.go({}).result.status, 0);
  commit(w, 'outputs committed');
  assert.ok(w.git(w.project, 'ls-files', 'brain/00-system/index-all.md'), 'the brain index list is tracked');
  w.config.caps.brainIndex.allPath = 'brain/00-system/INDEX-ALL.md';
  fs.appendFileSync(path.join(w.project, 'brain/00-system/index.md'), 'hand edit\n');
  w.put(path.join(w.project, 'brain/01-pillars/pil-two.md'), PILLAR.replace('pil-test', 'pil-two')); // a new node: the brain index list changes
  w.lesson('Own lesson');
  const {result, lines} = w.go({commit: true});
  assert.equal(result.status, 0, lines.join('\n'));
  const files = w.committed();
  assert.ok(files.some(f => /^brain\/lesson-.*own-lesson\.md$/.test(f)), 'the memory folder is committed: ' + files.join(', '));
  assert.deepEqual(files.filter(f => /^brain\/00-system\/index/i.test(f)), [], 'neither half of the index pair is committed: ' + files.join(', '));
  assert.ok(lines.some(l => /^commit: left out \(uncommitted before this checkpoint\): .*index\.md.*; commit them yourself$/.test(l)), lines.join('\n'));
});

// ---- item 24 redesign: the git behaviour the check relies on, pinned against real git before any kit code uses it ----
// These pins run git itself (no kit code is under test): a failure here means the installed git cannot carry the design.

const rawGit = (dir, argv) => spawnSync('git', ['-C', dir, ...argv], {encoding: 'utf8', env: process.env});
const listed = r => r.stdout.split('\0').filter(Boolean).map(entry => entry.slice(3));
const STATUS_Z = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--'];
const ARCHIVE_GLOB = ':(glob,icase)brain/00-system/log-[0-9][0-9][0-9][0-9]-[0-9][0-9].md';

test('3.3.6 checkpoint: git pin C1, a literal icase pathspec given as ./docs/ROADMAP.md (and docs\\ROADMAP.md on Windows) lists the modified roadmap (pin)', t => { // no kit code to mutate
  const w = world(t, {brain: true, rotate: true});
  fs.appendFileSync(path.join(w.project, 'docs/ROADMAP.md'), '**2026-11-06** operator edit\n\n');
  const spellings = ['./docs/ROADMAP.md', 'docs/../docs/ROADMAP.md', 'docs//ROADMAP.md', ...(process.platform === 'win32' ? ['docs\\ROADMAP.md', '.\\docs\\ROADMAP.md'] : [])];
  for (const spelling of spellings) {
    const r = rawGit(w.project, [...STATUS_Z, `:(literal,icase)${spelling}`]);
    assert.equal(r.status, 0, `${spelling}: ${r.stderr}`);
    assert.deepEqual(listed(r), ['docs/ROADMAP.md'], spelling);
  }
  const clean = rawGit(w.project, [...STATUS_Z, ':(literal,icase)./docs/ROADMAP-HISTORY.md']);
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout, '', 'a path that is not modified lists nothing');
});

test('3.3.6 checkpoint: git pin C2, icase reaches untracked and deleted entries and the archive glob does not cross a folder (pin)', t => { // no kit code to mutate
  const w = world(t, {brain: true, rotate: true});
  const archive = 'brain/00-system/log-2026-09.md', nested = 'brain/00-system/snapshot/brain/00-system/log-2026-09.md';
  w.put(path.join(w.project, archive), 'archive\n'); w.put(path.join(w.project, nested), 'lookalike\n');
  commit(w, 'archive and lookalike tracked');
  fs.rmSync(path.join(w.project, archive));
  fs.appendFileSync(path.join(w.project, nested), 'edited\n');
  w.put(path.join(w.project, 'docs/ROADMAP-OVERVIEW.md'), 'untracked overview\n');
  const untracked = rawGit(w.project, [...STATUS_Z, ':(literal,icase)docs/roadmap-overview.md']);
  assert.equal(untracked.status, 0, untracked.stderr);
  assert.deepEqual(listed(untracked), ['docs/ROADMAP-OVERVIEW.md'], 'an untracked file is listed under icase with --untracked-files=all');
  const deleted = rawGit(w.project, [...STATUS_Z, ARCHIVE_GLOB]);
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.deepEqual(listed(deleted), [archive], 'the deleted tracked archive is listed, the lookalike three folders deeper is not');
  const upper = rawGit(w.project, [...STATUS_Z, ARCHIVE_GLOB.replace('log-', 'LOG-')]);
  assert.deepEqual(listed(upper), [archive], 'icase: an uppercase pattern lists the same archive');
  for (const other of ['brain/00-system/notes.md', 'brain/00-system/snapshot/log-2026-09.md', 'brain/00-system/log-2026-9.md']) {
    w.put(path.join(w.project, other), 'other\n');
    assert.ok(!listed(rawGit(w.project, [...STATUS_Z, ARCHIVE_GLOB])).includes(other), `${other} is not an archive`);
  }
});

test('3.3.6 checkpoint: git pin C3, add, diff --cached and commit honour exclude with glob and icase and accept an exclude that matches nothing (pin)', t => { // no kit code to mutate
  const w = world(t, {brain: true, rotate: true});
  const files = ['brain/00-system/LOG-2026-09.md', 'brain/00-system/log-2026-10.md', 'brain/00-system/notes.md', 'docs/ROADMAP.md', 'docs/OTHER.md'];
  for (const file of files) w.put(path.join(w.project, file), 'a\n');
  commit(w, 'files tracked');
  for (const file of files) fs.appendFileSync(path.join(w.project, file), 'edited\n');
  const include = ['brain', 'docs'];
  const excludes = [ARCHIVE_GLOB.replace(':(glob,icase)', ':(exclude,glob,icase)'), ':(exclude,literal,icase)docs/roadmap.md', ':(exclude,glob,icase)docs/never-[0-9].md'];
  const add = rawGit(w.project, ['add', '--', ...include, ...excludes]);
  assert.equal(add.status, 0, add.stderr);
  const staged = rawGit(w.project, ['diff', '--cached', '--name-only', '--', ...include, ...excludes]);
  assert.deepEqual(staged.stdout.split('\n').filter(Boolean).sort(), ['brain/00-system/notes.md', 'docs/OTHER.md']);
  const done = rawGit(w.project, ['commit', '-q', '-m', 'only the clean ones', '--', ...include, ...excludes]);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(rawGit(w.project, ['show', '--name-only', '--format=', 'HEAD']).stdout.split('\n').filter(Boolean).sort(), ['brain/00-system/notes.md', 'docs/OTHER.md']);
  assert.deepEqual(listed(rawGit(w.project, [...STATUS_Z, '.'])).sort(), ['brain/00-system/LOG-2026-09.md', 'brain/00-system/log-2026-10.md', 'docs/ROADMAP.md'], 'the excluded files are still the operator\'s');
});

test('3.3.6 checkpoint: git pin C4, porcelain v1 prints nothing for a clean pathspec whatever the deferred status configuration says (pin)', t => { // no kit code to mutate
  const w = world(t, {brain: true, rotate: true});
  const config = ['-c', 'status.branch=true', '-c', 'status.showUntrackedFiles=no', '-c', 'status.relativePaths=false', '-c', 'status.short=false'];
  const clean = rawGit(w.project, [...config, ...STATUS_Z, ':(literal,icase)docs/roadmap.md']);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stdout, '', 'no branch header, nothing else');
  fs.appendFileSync(path.join(w.project, 'docs/ROADMAP.md'), 'edit\n');
  w.put(path.join(w.project, 'docs/ROADMAP-OVERVIEW.md'), 'untracked\n');
  const dirty = rawGit(w.project, [...config, ...STATUS_Z, ':(literal,icase)docs/roadmap.md', ':(literal,icase)docs/roadmap-overview.md']);
  assert.deepEqual(listed(dirty).sort(), ['docs/ROADMAP-OVERVIEW.md', 'docs/ROADMAP.md'], 'an untracked file is listed although the configuration hides untracked files');
});

// ---- item 24 redesign: git decides every match ----

test('3.3.6 checkpoint: a project in a repository folder whose name starts with a space is read by git from that folder: the dry run names a modified roadmap and --commit leaves its group out', t => { // mutant: run git at the repository root, so the pathspecs name another folder
  const dry = world(t, {nested: ' proj', brain: true, rotate: true});
  fs.appendFileSync(path.join(dry.project, 'docs/ROADMAP.md'), '**2026-11-06** operator edit\n\n');
  const line = dry.run(['--dry-run']).lines.find(l => l.startsWith('already modified:'));
  assert.equal(line, `already modified: docs/ROADMAP.md (uncommitted in ${dry.project}); a real run rewrites them`);
  const w = world(t, {nested: ' proj', inRepo: true, brain: true, rotate: true});
  fs.appendFileSync(path.join(w.project, 'docs/ROADMAP.md'), '**2026-11-06** operator edit\n\n');
  const {result, lines} = w.go({commit: true});
  assert.equal(result.status, 0, lines.join('\n'));
  const files = w.committed();
  assert.deepEqual(files.filter(f => /^docs\//.test(f)), [], 'no roadmap file is committed: ' + files.join(', '));
  assert.ok(files.includes('brain/00-system/log.md') && files.includes('brain/00-system/index.md'), 'the clean groups are committed: ' + files.join(', '));
  assert.ok(lines.includes('commit: left out (uncommitted before this checkpoint): docs/ROADMAP.md, docs/ROADMAP-OVERVIEW.md, docs/ROADMAP-HISTORY.md; commit them yourself'), lines.join('\n'));
});

test('3.3.6 checkpoint: --commit leaves the log group out when a tracked archive spelled in capitals was edited, with the memory folder around it, on every file system', t => { // mutant: write the archive glob without icase
  const w = world(t, {inRepo: true, inRepoDir: 'brain', brain: true});
  const archive = 'brain/00-system/LOG-2026-09.md';
  w.put(path.join(w.project, archive), 'archive\n');
  commit(w, 'archive tracked');
  fs.appendFileSync(path.join(w.project, archive), 'operator edit\n');
  w.lesson('Own lesson');
  const {result, lines} = w.go({commit: true, noRotate: true});
  assert.equal(result.status, 0, lines.join('\n'));
  const files = w.committed();
  assert.ok(files.some(f => /^brain\/lesson-.*own-lesson\.md$/.test(f)), 'the memory folder is committed: ' + files.join(', '));
  assert.deepEqual(files.filter(f => /00-system\/log-2026-09\.md$/i.test(f)), [], 'the edited archive is not committed: ' + files.join(', '));
  assert.match(w.git(w.project, 'status', '--porcelain'), /M brain\/00-system\/LOG-2026-09\.md/, 'the edit is still the operator\'s');
});

test('3.3.6 checkpoint: inherited pathspec-mode variables change neither the check nor the commit (the dry run names, --commit leaves out, the lock stays out)', t => { // mutant: leave the four pathspec variables in the git environment
  for (const [name, value] of [['GIT_LITERAL_PATHSPECS', '1'], ['GIT_GLOB_PATHSPECS', '1'], ['GIT_NOGLOB_PATHSPECS', '1'], ['GIT_ICASE_PATHSPECS', '1']]) {
    const dry = world(t, {brain: true, rotate: true});
    fs.appendFileSync(path.join(dry.project, 'docs/ROADMAP.md'), '**2026-11-06** operator edit\n\n');
    const w = world(t, {inRepo: true, brain: true, rotate: true});
    // the lock names are ignored by the fixture; only the exclude pathspec may keep the lock out of this commit
    for (const dir of [w.project, w.memoryDir]) w.put(path.join(dir, '.gitignore'), '.sessions/\n');
    commit(w, 'lock names no longer ignored');
    fs.appendFileSync(path.join(w.project, 'docs/ROADMAP.md'), '**2026-11-06** operator edit\n\n');
    process.env[name] = value;
    try {
      const line = dry.run(['--dry-run']).lines.find(l => l.startsWith('already modified:'));
      assert.equal(line, `already modified: docs/ROADMAP.md (uncommitted in ${dry.project}); a real run rewrites them`, name);
      const {result, lines} = w.go({commit: true});
      assert.equal(result.status, 0, `${name}: ${lines.join('\n')}`);
      assert.ok(lines.includes('commit: left out (uncommitted before this checkpoint): docs/ROADMAP.md, docs/ROADMAP-OVERVIEW.md, docs/ROADMAP-HISTORY.md; commit them yourself'), `${name}: ${lines.join('\n')}`);
    } finally { delete process.env[name]; }
    const files = w.committed();
    assert.deepEqual(files.filter(f => /^docs\//.test(f) || /\.memory\.lock/.test(f)), [], `${name}: neither a roadmap file nor the lock is committed: ` + files.join(', '));
    assert.ok(files.includes('brain/00-system/log.md'), `${name}: the clean groups are committed: ` + files.join(', '));
  }
});

test('3.3.6 checkpoint: a log folder with glob characters keeps its deleted archive in the log group (the folder is escaped in the archive glob)', t => { // mutant: write the folder into the archive glob unescaped
  const w = world(t, {inRepo: true, brain: true, rotate: true, tweak: config => { config.caps.brainLog.path = 'brain/00-system/sys[1]/log.md'; }});
  const first = w.go({commit: true});
  assert.equal(first.result.status, 0, first.lines.join('\n') + '\n' + String(first.result.error));
  const archive = 'brain/00-system/sys[1]/log-2026-09.md';
  assert.ok(w.git(w.project, 'ls-files', archive), 'the first run committed the archive');
  w.put(path.join(w.project, 'brain/00-system/sys1/log-2026-09.md'), 'a folder the unescaped class [1] would match\n');
  commit(w, 'decoy tracked');
  fs.rmSync(path.join(w.project, archive));
  w.config.caps.brainLog.keepEntries = 2; // this run rotates one more entry: the log and log-2026-10.md change
  w.lesson('Own lesson');
  const {result, lines} = w.go({commit: true});
  assert.equal(result.status, 0, lines.join('\n'));
  const files = w.committed();
  assert.ok(files.some(f => /^memory\/lesson-/.test(f)), 'the memory folder is committed: ' + files.join(', '));
  assert.deepEqual(files.filter(f => /^brain\/00-system\/sys\[1\]\//.test(f)), [], 'no member of the log group is committed: ' + files.join(', '));
  assert.ok(lines.some(line => /^commit: left out \(uncommitted before this checkpoint\): brain\/00-system\/sys\[1\]\/log\.md/.test(line)), lines.join('\n'));
  assert.match(w.git(w.project, 'status', '--porcelain'), /D brain\/00-system\/sys\[1\]\/log-2026-09\.md/, 'the deletion is still the operator\'s');
});

test('3.3.6 checkpoint: a brain log at the project root keeps its deleted archive in the log group (the archive glob has no folder part)', t => { // mutant: drop the archive glob from the log group's pathspecs
  const w = world(t, {inRepo: true, brain: true, rotate: true, tweak: config => { config.caps.brainLog.path = 'log.md'; }});
  const first = w.go({commit: true});
  assert.equal(first.result.status, 0, first.lines.join('\n') + '\n' + String(first.result.error));
  assert.ok(w.git(w.project, 'ls-files', 'log-2026-09.md'), 'the first run committed the archive at the project root');
  fs.rmSync(path.join(w.project, 'log-2026-09.md'));
  w.config.caps.brainLog.keepEntries = 2; // this run rotates one more entry: the log and log-2026-10.md change
  w.lesson('Own lesson');
  const {result, lines} = w.go({commit: true});
  assert.equal(result.status, 0, lines.join('\n'));
  const files = w.committed();
  assert.ok(files.some(f => /^memory\/lesson-/.test(f)), 'the memory folder is committed: ' + files.join(', '));
  assert.deepEqual(files.filter(f => /^log/.test(f)), [], 'no member of the log group is committed: ' + files.join(', '));
  assert.ok(lines.some(line => /^commit: left out \(uncommitted before this checkpoint\): log\.md/.test(line)), lines.join('\n'));
  assert.match(w.git(w.project, 'status', '--porcelain'), /D log-2026-09\.md/, 'the deletion is still the operator\'s');
});

// ---- item 24 redesign, bounded fix: literal includes, and the overview taken from the writer, not from the rotation ----

test('3.3.6 checkpoint: a written archive in a log folder with glob characters is committed and a modified decoy in the folder its class would match is not', t => { // mutant: drop :(literal) from the positive includes
  const w = world(t, {inRepo: true, brain: true, rotate: true, tweak: config => { config.caps.brainLog.path = 'brain/00-system/sys[1]/log.md'; }});
  const decoy = 'brain/00-system/sys1/log-2026-09.md';
  w.put(path.join(w.project, decoy), 'decoy\n');
  commit(w, 'decoy tracked');
  fs.appendFileSync(path.join(w.project, decoy), 'operator edit\n');
  const {result, lines} = w.go({commit: true});
  assert.equal(result.status, 0, lines.join('\n') + '\n' + String(result.error));
  const files = w.committed();
  assert.ok(files.includes('brain/00-system/sys[1]/log-2026-09.md') && files.includes('brain/00-system/sys[1]/log.md'), 'the log and the archive this run wrote are committed: ' + files.join(', '));
  assert.ok(!files.includes(decoy), 'the decoy is not committed: ' + files.join(', '));
  assert.ok(!lines.some(line => line.startsWith('commit: left out')), lines.join('\n'));
  assert.match(w.git(w.project, 'status', '--porcelain'), /M brain\/00-system\/sys1\/log-2026-09\.md/, 'the decoy keeps the operator\'s edit');
});

test('3.3.6 checkpoint: --commit --no-rotate commits an overview the writer generated although no rotation ran', t => { // mutant: take the overview from the rotation result only
  const w = world(t, {inRepo: true, brain: true});
  assert.ok(!fs.existsSync(path.join(w.project, 'docs/ROADMAP-OVERVIEW.md')), 'the overview does not exist yet');
  const {result, lines} = w.go({commit: true, noRotate: true});
  assert.equal(result.status, 0, lines.join('\n') + '\n' + String(result.error));
  const files = w.committed();
  assert.ok(files.includes('docs/ROADMAP-OVERVIEW.md') && files.includes('brain/00-system/index.md') && files.includes('brain/00-system/index-all.md'), 'the generated outputs are committed: ' + files.join(', '));
  assert.ok(!lines.some(line => line.startsWith('commit: left out')), lines.join('\n'));
});

test('3.3.6 checkpoint: --commit --no-rotate with a modified roadmap names the generated overview as left out and does not commit it', t => { // mutant: take the overview from the rotation result only
  const w = world(t, {inRepo: true, brain: true});
  fs.appendFileSync(path.join(w.project, 'docs/ROADMAP.md'), '**2026-11-06** operator edit\n\n');
  const {result, lines} = w.go({commit: true, noRotate: true});
  assert.equal(result.status, 0, lines.join('\n') + '\n' + String(result.error));
  const files = w.committed();
  assert.deepEqual(files.filter(f => /^docs\//.test(f)), [], 'no roadmap file is committed: ' + files.join(', '));
  assert.ok(files.includes('brain/00-system/index.md'), 'the clean group is committed: ' + files.join(', '));
  assert.ok(lines.includes('commit: left out (uncommitted before this checkpoint): docs/ROADMAP-OVERVIEW.md; commit them yourself'), lines.join('\n'));
  assert.ok(fs.existsSync(path.join(w.project, 'docs/ROADMAP-OVERVIEW.md')), 'the overview is on disk');
});
