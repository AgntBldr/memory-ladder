// Kit 3.3.5 E2.8: the kit upgrade is an exclusive maintenance step (lane E merged with 3.3.4 lanes A and B).
// Each test was written red first against that merge, before these fixes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixture, ok, put, read, json, bump, kitRoot} from './helpers.mjs';
import {J, lockName, state, upgrade, backupOf, repo, claim, driver, claimPrelude, afterPlanHook, withEnv, elsewhere, refusedBy, STUB, GENERATED, migrationMemory, CRAFT_STUB, foreignWorktree, foreignMissing, writer, aheadMemory} from './fixtures-335.mjs';
import {readLedgers} from '../engine/memory-session.mjs';
import {finishMemory} from '../engine/memory-setup.mjs';
import {writeMemoryIndex, stagedOutputs} from '../engine/memory-index.mjs';
import {withMemoryLock, PUSH_LOCK} from '../engine/memory-lock.mjs';
import {ledgerAdd} from '../scripts/instructions-sort.mjs';

test('I1 E2.8 (a) a live claim in live memory refuses the live upgrade before any write, naming the session and the file', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const holder = claim(f), before = state(f);
  refusedBy(upgrade(f, next, ['--live-memory']), holder);
  assert.deepEqual(state(f), before);
  // The first check refuses before the run lists files or takes the lock.
  const marker = path.join(f.root, 'planned.txt');
  refusedBy(f.exec(process.execPath, [driver(f, next, afterPlanHook(marker))]), holder);
  assert.ok(!fs.existsSync(marker), 'refused before afterPlan');
});

for (const kind of ['upgrade', 'restore']) test(`I19 E2.8 (a) a claim taken after the first check refuses the ${kind} under the lock, before any write`, t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const backup = kind === 'restore' ? backupOf(ok(upgrade(f, next, ['--live-memory']))) : null;
  const claimant = repo(f, 'late', 'feature-late'), marker = path.join(f.root, 'planned.txt'), before = state(f);
  const result = f.exec(process.execPath, [driver(f, next, afterPlanHook(marker, claimant, f.memory), claimPrelude, backup ? {restore: backup} : {})]);
  assert.ok(fs.existsSync(marker), 'the first check passed');
  refusedBy(result, fs.realpathSync.native(claimant));
  const notes = snapshot => Object.fromEntries(Object.entries(snapshot).filter(([file]) => !file.startsWith('.sessions/')));
  const after = state(f);
  assert.deepEqual(notes(after.memory), notes(before.memory)); assert.deepEqual(after.project, before.project); assert.equal(after.hook, before.hook);
});

test('I2 E2.8 (a) a malformed ledger\'s claim refuses the live upgrade', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  claim(f);
  const dir = path.join(f.memory, '.sessions'), [name] = fs.readdirSync(dir).filter(n => /^[0-9a-f]{16}\.json$/.test(n));
  fs.renameSync(path.join(dir, name), path.join(dir, '1111111111111111.json'));
  assert.deepEqual(readLedgers(f.memory).map(l => l.state), ['malformed']);
  const before = state(f), result = upgrade(f, next, ['--live-memory']);
  refusedBy(result);
  assert.match(result.stderr, /\(malformed ledger\) claims current-state\.md/);
  assert.deepEqual(state(f), before);
});

test('I3 E2.8 (a) an unreadable ledger refuses the live upgrade', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  put(path.join(f.memory, '.sessions', '2222222222222222.json'), '{not json');
  const before = state(f), result = upgrade(f, next, ['--live-memory']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /upgrade refused: ledger \.sessions\/2222222222222222\.json is unreadable \(not valid JSON\).*; nothing written/);
  assert.deepEqual(state(f), before);
});

test('I4 E2.8 (a) only stale ledgers never block the live upgrade', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const holder = claim(f);
  fs.rmSync(holder, {recursive: true, force: true});
  assert.deepEqual(readLedgers(f.memory).map(l => l.state), ['stale']);
  ok(upgrade(f, next, ['--live-memory']));
  assert.equal(json(path.join(f.target, 'scripts/memory/KIT.json')).version, read(path.join(next, 'VERSION')).trim());
});

test('I5 E2.8 (a) the --memory-only replay is refused by a live claim', t => {
  const f = fixture(t); ok(f.install());
  put(path.join(f.memory, 'topic-extra.md'), '---\nname: topic-extra\ndescription: An extra topic that makes the generated index stale.\nmetadata:\n  type: feedback\n  route: craft-sessions\n---\nBody.\n');
  const holder = claim(f), before = state(f);
  refusedBy(upgrade(f, kitRoot, ['--memory-only', '--live-memory']), holder);
  assert.deepEqual(state(f), before);
});

test('I6 E2.8 (a) a restore of live memory is refused by a live claim', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const backup = backupOf(ok(upgrade(f, next, ['--live-memory'])));
  const holder = claim(f), before = state(f);
  refusedBy(upgrade(f, next, ['--restore', backup, '--live-memory']), holder);
  assert.deepEqual(state(f), before);
});

test('I7 E2.8 (a) a rehearsal on a copy is unaffected by claims, in live memory or copied with it', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  claim(f);
  const copy = path.join(f.root, 'copy'); fs.cpSync(f.memory, copy, {recursive: true});
  ok(upgrade(f, next, ['--memory-dir', copy]));
});

test('I8 E2.8 (b) a held push lock refuses the upgrade with nothing changed', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const lock = put(path.join(f.memory, '.memory.lock.push'), JSON.stringify({pid: process.pid, host: os.hostname(), time: new Date().toISOString(), token: 'held'}) + '\n');
  const held = read(lock), before = state(f);
  const result = upgrade(f, next, ['--live-memory']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /upgrade: the push lock .*\.memory\.lock\.push is held \(memory lock timed out waiting for .*\.memory\.lock\.push\); a publication may be running, or a stopped run left it \(a dead run's lock is broken after 10 minutes\); nothing written; run again/);
  assert.deepEqual(state(f), before); assert.equal(read(lock), held);
  assert.ok(!fs.existsSync(path.join(f.memory, '.memory.lock')), 'the memory lock is released');
});

test('I9 E2.8 (b) a publication during the upgrade\'s window is refused by the push lock and pushes nothing', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const log = path.join(f.root, 'publication.json');
  const prelude = `import {publish} from ${J(pathToFileURL(path.join(next, 'engine/memory-checkpoint.mjs')).href)};`;
  const hooks = `afterSnapshot: () => { let called = false;
    const result = publish({memoryDir: ${J(f.memory)}, sha: null, lockTimeoutMs: 200, git: () => { called = true; return ''; }});
    fs.writeFileSync(${J(log)}, JSON.stringify({...result, called})); }`;
  ok(f.exec(process.execPath, [driver(f, next, hooks, prelude)]));
  const publication = json(log);
  assert.equal(publication.called, false, 'git was never run'); assert.equal(publication.pushed, false);
  assert.match(publication.error, /memory lock timed out waiting for .*\.memory\.lock\.push/);
});

test('I10 E2.8 (c) lock files survive the rollback, are never recorded, and a restore never rewrites them', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const old = put(path.join(f.memory, '.memory.lock.push.stale-old'), 'old foreign\n'), oldTime = fs.statSync(old).mtimeMs;
  const fresh = path.join(f.memory, '.memory.lock.stale-fresh'), freshPush = path.join(f.memory, '.memory.lock.push.stale-fresh');
  const start = state(f);
  const hooks = `afterCopy: n => { if (n === 1) { fs.writeFileSync(${J(fresh)}, 'fresh\\n'); fs.writeFileSync(${J(freshPush)}, 'fresh push\\n'); throw Error('injected after the first copy'); } }`;
  const result = f.exec(process.execPath, [driver(f, next, hooks)]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /upgrade: restored .*: injected after the first copy/);
  const untouched = () => {
    assert.equal(read(old), 'old foreign\n'); assert.equal(fs.statSync(old).mtimeMs, oldTime, 'never rewritten');
    assert.equal(read(fresh), 'fresh\n'); assert.equal(read(freshPush), 'fresh push\n');
  };
  untouched(); assert.deepEqual(state(f), start);
  const backup = backupOf(result), map = path.join(backup, 'restore.json'), recovery = json(map);
  assert.deepEqual([...recovery.memory.files, ...recovery.memory.created].filter(lockName), [], 'no lock file is recorded');
  ok(upgrade(f, next, ['--restore', backup, '--live-memory']));
  untouched();
  // A backup that names lock files (as one written before this rule could) still never rewrites or deletes them.
  put(path.join(backup, 'memory', '.memory.lock.push.stale-old'), 'from the backup\n');
  put(map, JSON.stringify({...recovery, memory: {...recovery.memory, files: [...recovery.memory.files, '.memory.lock.push.stale-old'], created: [...recovery.memory.created, '.memory.lock.push.stale-fresh']}}, null, 2) + '\n');
  ok(upgrade(f, next, ['--restore', backup, '--live-memory']));
  untouched();
});

test('I11 E2.8 (c) setup and the upgrade write the one lock pattern, which covers both locks, to memory\'s .gitignore', t => {
  const f = fixture(t); ok(f.install());
  const ignore = path.join(f.memory, '.gitignore'), lines = () => read(ignore).split(/\r?\n/).filter(Boolean);
  assert.deepEqual(lines(), ['.memory.lock*']);
  put(ignore, 'private.txt\n');
  const next = bump(f), result = ok(upgrade(f, next, ['--live-memory']));
  assert.deepEqual(lines(), ['private.txt', '.memory.lock*']);
  // Both locks were held while the backup and the created-file record were written; neither records them.
  const recovery = json(path.join(backupOf(result), 'restore.json'));
  assert.deepEqual([...recovery.memory.files, ...recovery.memory.created].filter(lockName), []);
  assert.ok(!fs.readdirSync(f.memory).some(lockName), 'both locks are released');
});

test('I20 E2.8 (c) a route migration plans no lock file and keeps the one lock pattern', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  put(path.join(f.memory, 'MEMORY.md'), '- [Craft](INDEX-craft.md) OPEN BEFORE testing.\n');
  put(path.join(f.memory, 'INDEX-craft.md'), '# Notes\n271. [Topic](topic.md)\n');
  put(path.join(f.memory, 'topic.md'), '---\nname: topic\ndescription: Useful.\n---\n');
  put(path.join(f.memory, '.gitignore'), '.memory.lock*\n');
  const old = put(path.join(f.memory, '.memory.lock.push.stale-old'), 'old foreign\n'), time = fs.statSync(old).mtimeMs;
  const preview = upgrade(f, next, ['--check', '--live-memory']);
  assert.ok(/^MEMORY WRITE INDEX-craft\.md/m.test(preview.stdout), 'a migration is planned: ' + preview.stdout);
  assert.ok(!/\.memory\.lock\.push/.test(preview.stdout), preview.stdout);
  ok(upgrade(f, next, ['--live-memory']));
  assert.equal(read(old), 'old foreign\n'); assert.equal(fs.statSync(old).mtimeMs, time);
  assert.deepEqual(read(path.join(f.memory, '.gitignore')).split(/\r?\n/).filter(Boolean), ['.memory.lock*']);
});

test('I12 E2.8 (d) an unmarked stub at a generated path survives the upgrade, which refuses and names it', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const page = put(path.join(f.memory, 'INDEX-craft-sessions.md'), STUB), before = state(f);
  const result = upgrade(f, next, ['--live-memory']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stderr.includes('upgrade: cannot plan the memory steps (run the route migration first; refusing to overwrite INDEX-craft-sessions.md); nothing written'), result.stderr);
  assert.equal(read(page), STUB); assert.deepEqual(state(f), before);
});

test('I13 E2.8 (d) a staged unmarked version at a generated path refuses the upgrade too', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const page = path.join(f.memory, 'INDEX-craft-sessions.md'), generated = read(page);
  put(page, 'hand version\n'); f.git(f.memory, 'add', 'INDEX-craft-sessions.md'); put(page, generated);
  const before = state(f), result = upgrade(f, next, ['--live-memory']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stderr.includes('refusing to overwrite INDEX-craft-sessions.md (staged version is not generated)); nothing written'), result.stderr);
  assert.deepEqual(state(f), before);
  assert.equal(f.git(f.memory, 'show', ':INDEX-craft-sessions.md'), 'hand version');
});

test('I14 E2.8 (e) with GIT_DIR and GIT_WORK_TREE exported elsewhere a live ledger stays live, and setup and the upgrade refuse', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  claim(f);
  const exported = elsewhere(f);
  withEnv(exported, () => {
    assert.deepEqual(readLedgers(f.memory).map(l => l.state), ['live']);
    assert.throws(() => finishMemory({memory: {dir: f.memory}, target: f.target, engine: path.join(kitRoot, 'engine'), configFile: path.join(f.target, 'scripts/memory/memory.config.json')}),
      /memory setup refused: 1 files pending in other sessions: .* claims current-state\.md/);
  });
  const before = state(f);
  refusedBy(upgrade(f, next, ['--live-memory'], {...f.env, ...exported}));
  assert.deepEqual(state(f), before);
});

test('I15 E2.8 (e) sweep: with GIT_DIR exported elsewhere the index writer still reads memory\'s own staged versions', t => {
  const f = fixture(t); ok(f.install());
  const page = path.join(f.memory, 'INDEX-craft-sessions.md'), generated = read(page);
  put(page, 'hand version\n'); f.git(f.memory, 'add', 'INDEX-craft-sessions.md'); put(page, generated);
  const config = json(path.join(f.target, 'scripts/memory/memory.config.json'));
  withEnv(elsewhere(f), () => assert.throws(() => writeMemoryIndex({memoryDir: f.memory, config}), /refusing to overwrite INDEX-craft-sessions\.md \(staged version is not generated\)/));
});

test('I16 E2.8 (e) sweep: with GIT_DIR exported elsewhere a checkpoint commits to memory, never to that repository', t => {
  const f = fixture(t); ok(f.install());
  const exported = elsewhere(f);
  f.git(exported.GIT_WORK_TREE, 'commit', '-q', '--allow-empty', '-m', 'elsewhere base');
  const theirs = f.git(exported.GIT_WORK_TREE, 'rev-parse', 'HEAD'), ours = f.git(f.memory, 'rev-parse', 'HEAD');
  fs.appendFileSync(path.join(f.memory, '.gitignore'), '# a pending memory change\n');
  ok(f.exec(process.execPath, [path.join(f.target, 'scripts/memory/memory-checkpoint.mjs'), '--memory-dir', f.memory, '--repo', f.target, '--no-push'], {env: {...f.env, ...exported}}));
  assert.notEqual(f.git(f.memory, 'rev-parse', 'HEAD'), ours, 'memory has the new commit');
  assert.equal(f.git(f.memory, 'status', '--porcelain'), '', 'the change is committed in memory');
  assert.equal(f.git(exported.GIT_WORK_TREE, 'rev-parse', 'HEAD'), theirs, 'the other repository is untouched');
});

test('I17 E2.8 (e) sweep: ledger-add reads the branch of the ledger\'s own folder, not an exported GIT_DIR', t => {
  const f = fixture(t);
  const ledger = path.join(repo(f, 'kit-copy', 'main'), 'ledger.json');
  withEnv(elsewhere(f), () => assert.throws(() => ledgerAdd({ledger, from: path.join(f.root, 'report.json'), project: 'p'}), /ledger-add: refusing on branch main/));
});

test('I18 E2.8 (c) one lock-name predicate and one .gitignore line', async () => {
  const {isLockName, withLockIgnores, LOCK_IGNORES, LOCK_NAMES, PUSH_LOCK} = await import('../engine/memory-lock.mjs');
  assert.equal(PUSH_LOCK, '.memory.lock.push'); assert.deepEqual(LOCK_NAMES, ['.memory.lock', '.memory.lock.push']);
  for (const name of ['.memory.lock', '.memory.lock.stale-1', '.memory.lock.push', '.memory.lock.push.stale-1', '.MEMORY.LOCK']) assert.ok(isLockName(name), name);
  // The push lock's spelling from before the release is an ordinary file name.
  for (const name of ['memory.lock', 'x.memory.lock', '.memory.push.lock', '.memory.loc', '.sessions', 'MEMORY.md']) assert.ok(!isLockName(name), name);
  assert.deepEqual(LOCK_IGNORES, ['.memory.lock*']);
  assert.equal(withLockIgnores(''), '.memory.lock*\n');
  assert.equal(withLockIgnores('a'), 'a\n.memory.lock*\n');
  // A memory that already holds the line, as every memory set up before does, gets no write.
  for (const text of ['x\n.memory.lock*\n', '.memory.lock*\r\n']) assert.equal(withLockIgnores(text), text);
});

// ---- Fixes after the Codex high review of the integration: each finding's path, written red first. ----

test('I22 E2.8 (d) a route migration never replaces an unmarked stub at a generated path: refused, named, nothing written', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const page = migrationMemory(f, CRAFT_STUB), before = state(f);
  const result = upgrade(f, next, ['--live-memory']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stderr.includes('upgrade: cannot plan the memory steps (run the route migration first; refusing to overwrite INDEX-craft.md); nothing written'), result.stderr);
  assert.equal(read(page), CRAFT_STUB); assert.deepEqual(state(f), before);
});

test('I23 E2.8 (d) a route migration never replaces a generated page whose staged version is unmarked', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const page = migrationMemory(f, 'hand version\n');
  f.git(f.memory, 'add', 'INDEX-craft.md'); put(page, GENERATED + '# Craft\n');
  const before = state(f), result = upgrade(f, next, ['--live-memory']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stderr.includes('refusing to overwrite INDEX-craft.md (staged version is not generated)); nothing written'), result.stderr);
  assert.deepEqual(state(f), before); assert.equal(f.git(f.memory, 'show', ':INDEX-craft.md'), 'hand version');
});

test('I24 E2.8 (d) a restore never writes over an unmarked stub at a generated path', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const backup = backupOf(ok(upgrade(f, next, ['--live-memory'])));
  const page = put(path.join(f.memory, 'INDEX-craft-sessions.md'), STUB), before = state(f);
  const result = upgrade(f, next, ['--restore', backup, '--live-memory']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stderr.includes('upgrade: restore refused (run the route migration first; refusing to overwrite INDEX-craft-sessions.md); nothing restored'), result.stderr);
  assert.equal(read(page), STUB); assert.deepEqual(state(f), before);
  // A stub written after the first check is refused under the lock.
  const generated = fs.readFileSync(path.join(backup, 'memory', 'INDEX-craft-sessions.md')); fs.writeFileSync(page, generated);
  const late = f.exec(process.execPath, [driver(f, next, `afterPlan: () => fs.writeFileSync(${J(page)}, ${J(STUB)})`, '', {restore: backup})]);
  assert.equal(late.status, 1, late.stdout + late.stderr);
  assert.ok(late.stderr.includes('upgrade: restore refused (run the route migration first; refusing to overwrite INDEX-craft-sessions.md); nothing restored'), late.stderr);
  assert.equal(read(page), STUB);
});

test('I25 E2.8 (c) tracked lock files in an in-repo memory stay out of the rollback; a similar name outside memory is still rolled back', t => {
  const f = fixture(t), memory = path.join(f.target, 'memory'); ok(f.install(['--memory-dir', memory])); const next = bump(f);
  // Root-level lock names (not the live locks) and the live names inside a sub-folder, all tracked by the project.
  const sentinels = ['.memory.lock.stale-foreign', '.memory.lock.push.stale-foreign', 'sub/.memory.lock', 'sub/.memory.lock.push'].map(name => put(path.join(memory, name), 'tracked ' + name + '\n'));
  const outside = put(path.join(f.target, '.memory.lock.stale-foreign'), 'project file\n');
  f.git(f.target, 'add', '-A'); f.git(f.target, 'add', '-f', '--', ...sentinels, outside); f.git(f.target, 'commit', '-qm', 'tracked sentinels');
  // While the run holds its locks, a foreign process rewrites each of them; then the run fails and rolls back.
  const hooks = `afterCopy: n => { if (n === 1) { for (const file of ${J([...sentinels, outside])}) fs.writeFileSync(file, 'foreign\\n'); throw Error('injected after the first copy'); } }`;
  const result = f.exec(process.execPath, [driver(f, next, hooks)]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /upgrade: restored .*: injected after the first copy/);
  for (const file of sentinels) assert.equal(read(file), 'foreign\n', 'a lock file in memory is never rolled back: ' + file);
  assert.equal(read(outside), 'project file\n', 'a similar name outside memory is in scope and rolled back');
});

test('I26 E2.8 (e) the memory-session CLI finds this project\'s memory with GIT_DIR and GIT_WORK_TREE exported to a foreign linked worktree', t => {
  const f = fixture(t); ok(f.install());
  const {foreignMemory, env} = foreignWorktree(f), script = path.join(f.target, 'scripts/memory/memory-session.mjs');
  ok(f.exec(process.execPath, [script, 'claim', 'current-state.md'], {env}));
  assert.deepEqual(readLedgers(f.memory).map(l => [l.state, Object.keys(l.claims)]), [['live', ['current-state.md']]]);
  assert.ok(!fs.existsSync(path.join(foreignMemory, '.sessions')), 'the foreign memory is untouched');
  assert.match(ok(f.exec(process.execPath, [script, 'list'], {env})).stdout, /current-state\.md/);
  // Another session's claim on the same file is refused from the same environment.
  const other = repo(f, 'other', 'feature-other');
  const refused = f.exec(process.execPath, [script, 'claim', 'current-state.md', '--repo', other, '--memory-dir', f.memory], {env});
  assert.equal(refused.status, 1, refused.stdout + refused.stderr); assert.match(refused.stderr, /claim refused: current-state\.md is claimed by /);
});

test('I27 E2.8 (e) the checkpoint CLI saves this project\'s memory with GIT_DIR and GIT_WORK_TREE exported to a foreign linked worktree', t => {
  const f = fixture(t); ok(f.install());
  const {foreignMemory, env} = foreignWorktree(f), ours = f.git(f.memory, 'rev-parse', 'HEAD');
  fs.appendFileSync(path.join(f.memory, '.gitignore'), '# a pending memory change\n');
  ok(f.exec(process.execPath, [path.join(f.target, 'scripts/memory/memory-checkpoint.mjs'), '--no-push'], {env}));
  assert.notEqual(f.git(f.memory, 'rev-parse', 'HEAD'), ours, 'this project\'s memory has the new commit');
  assert.equal(f.exec('git', ['-C', foreignMemory, 'rev-parse', '--verify', '-q', 'HEAD']).status, 1, 'the foreign memory has no commit');
});

test('I28 E2.8 (e) the lesson CLI writes and reads this project\'s memory with GIT_DIR and GIT_WORK_TREE exported to a foreign linked worktree', t => {
  const f = fixture(t); ok(f.install());
  const {foreignMemory, env} = foreignMissing(f);
  const created = ok(writer(f, 'memory-lesson.mjs', ['new', '--route', 'craft-sessions', '--kind', 'practice', 'Check the git environment before resolving memory'], env)).stdout.trim().split(/\r?\n/).at(-1);
  assert.equal(path.dirname(path.resolve(created)), path.resolve(f.memory), created);
  assert.ok(fs.existsSync(created), 'the lesson is in this project\'s memory');
  assert.deepEqual(JSON.parse(ok(writer(f, 'memory-lesson.mjs', ['repeat', '--from-legacy', '--json'], env)).stdout).items, []);
  assert.ok(!fs.existsSync(foreignMemory), 'the foreign memory is never created');
});

test('I29 E2.8 (e) the chains, chars, migrate, rotate and index CLIs find this project\'s memory with GIT_DIR and GIT_WORK_TREE exported to a foreign linked worktree', t => {
  const f = fixture(t); ok(f.install());
  const {foreignMemory, env} = foreignMissing(f);
  for (const [name, args] of [['memory-chains.mjs', ['scan', '--json']], ['memory-chars.mjs', ['repair', '--json']], ['memory-migrate.mjs', ['routes', '--dry-run']]]) {
    const result = writer(f, name, args, env);
    assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
  }
  // Two hand-over notes in this memory: keeping one moves the older (a rotation that found no memory moves none).
  for (const [seq, day] of [['000001', '01'], ['000002', '02']]) put(path.join(f.memory, 'handovers', `${seq}-2026-11-${day}-1000.md`), `---\ntime: 2026-11-${day}T10:00:00+00:00\nbranch: "main"\nsha: abcdef${seq.at(-1)}\nmode: quick\n---\n**State:** note ${seq}\n`);
  assert.equal(JSON.parse(ok(writer(f, 'memory-rotate.mjs', ['handovers', '--keep', '1', '--json'], env)).stdout).moved, 1);
  assert.match(ok(writer(f, 'memory-index.mjs', [], env)).stdout, /^memory index: \d+ pages/m);
  assert.ok(!fs.existsSync(foreignMemory), 'the foreign memory is never created');
});

test('I30 E2.8 (e) the handover CLI saves this project\'s note on this branch with GIT_DIR and GIT_WORK_TREE exported to a foreign linked worktree', t => {
  const f = fixture(t); ok(f.install());
  const {foreignMemory, env} = foreignMissing(f);
  const branch = f.git(f.target, 'branch', '--show-current'), memoryBranch = f.git(f.memory, 'branch', '--show-current');
  fs.appendFileSync(path.join(f.target, 'AGENTS.md'), `\n## Session overlay\nbranch: ${branch}\npush: memory\nmain-only: yes\n`);
  f.git(f.target, 'add', '-A'); f.git(f.target, 'commit', '-qm', 'seed');
  const bare = path.join(f.root, 'backup.git'); f.git(f.root, 'init', '--bare', bare);
  f.git(f.memory, 'remote', 'add', 'origin', bare); f.git(f.memory, 'push', '-q', '-u', 'origin', memoryBranch);
  const input = put(path.join(f.root, 'input.json'), J({state: 'Ready to continue', question: 'Which next?', next: ['Review results'], waits: 'none', risks: 'none'}));
  const result = writer(f, 'handover.mjs', ['run', '--repo', f.target, '--in', input, '--quick'], env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^SAFE TO COMPACT/m);
  assert.ok(result.stdout.includes(`${branch} @ ${f.git(f.target, 'rev-parse', 'HEAD').slice(0, 7)}`), result.stdout);
  const notes = fs.readdirSync(path.join(f.memory, 'handovers'));
  assert.equal(notes.length, 1, notes.join(' '));
  const note = read(path.join(f.memory, 'handovers', notes[0]));
  assert.ok(note.includes(`\nbranch: "${branch}"\nsha: ${f.git(f.target, 'rev-parse', 'HEAD').slice(0, 7)}\n`), note);
  assert.equal(f.git(f.memory, 'rev-parse', 'HEAD'), f.git(bare, 'rev-parse', memoryBranch), 'this project\'s memory is committed and pushed');
  assert.ok(!fs.existsSync(foreignMemory), 'the foreign memory is never created');
});

// ---- Second review of the fixes: the gate the writers run in-process, cleanup evidence, check before use. ----

test('I31 E2.8 (e) the checkpoint CLI\'s gate sees this memory\'s unpushed commits with GIT_DIR and GIT_WORK_TREE exported to a foreign linked worktree', t => {
  const f = fixture(t); ok(f.install());
  const {head} = aheadMemory(f), {env} = foreignMissing(f);
  fs.appendFileSync(path.join(f.memory, '.gitignore'), '# a pending memory change\n');
  const result = writer(f, 'memory-checkpoint.mjs', ['--no-push'], env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /FAIL repo\.ahead \. 12 commits ahead of upstream/);
  assert.equal(f.git(f.memory, 'rev-parse', 'HEAD'), head, 'a failing gate commits nothing');
});

test('I32 E2.8 (e) the handover CLI\'s gate sees this memory\'s unpushed commits with GIT_DIR and GIT_WORK_TREE exported to a foreign linked worktree', t => {
  const f = fixture(t); ok(f.install());
  const branch = f.git(f.target, 'branch', '--show-current');
  fs.appendFileSync(path.join(f.target, 'AGENTS.md'), `\n## Session overlay\nbranch: ${branch}\npush: memory\n`);
  f.git(f.target, 'add', '-A'); f.git(f.target, 'commit', '-qm', 'seed');
  const {bare, branch: memoryBranch, head} = aheadMemory(f), {env} = foreignMissing(f), pushed = f.git(bare, 'rev-parse', memoryBranch);
  const input = put(path.join(f.root, 'input.json'), J({state: 'Ready to continue', question: 'Which next?', next: ['Review results'], waits: 'none', risks: 'none'}));
  const result = writer(f, 'handover.mjs', ['run', '--repo', f.target, '--in', input, '--quick'], env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^NOT SAFE TO COMPACT/m);
  assert.match(result.stdout, /repo\.ahead/);
  assert.equal(f.git(f.memory, 'rev-parse', 'HEAD'), head, 'a failing gate commits nothing');
  assert.equal(f.git(bare, 'rev-parse', memoryBranch), pushed, 'and pushes nothing');
});

test('I33 E2.8 (e) the standalone gate finds this memory and its git state with GIT_DIR and GIT_WORK_TREE exported to a foreign linked worktree', t => {
  const f = fixture(t); ok(f.install());
  aheadMemory(f); const {foreignMemory, env} = foreignMissing(f);
  const result = writer(f, 'memory-check.mjs', [], env);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(`memory: ${f.memory}`), result.stdout);
  assert.match(result.stdout, /FAIL repo\.ahead \. 12 commits ahead of upstream/);
  assert.doesNotMatch(result.stdout, /repo\.not-git/);
  assert.ok(!fs.existsSync(foreignMemory), 'the foreign memory is never created');
});

test('I34 E2.8 (e) the gate\'s --hook path still reads git\'s own GIT_DIR and GIT_WORK_TREE; outside the hook they are ignored', t => {
  const f = fixture(t);
  // A work tree with no .git of its own: only the exported variables lead git to its repository, as in a hook.
  const work = path.join(f.root, 'work'), gitDir = path.join(f.root, 'separate.git'), memory = path.join(work, 'memory');
  f.git(f.root, 'init', '-q', '--separate-git-dir', gitDir, work); fs.rmSync(path.join(work, '.git'));
  put(path.join(memory, 'MEMORY.md'), '# Memory\n');
  const env = {...f.env, GIT_DIR: gitDir, GIT_WORK_TREE: work}, identity = ['-c', 'user.name=kit-test', '-c', 'user.email=kit-test@example.invalid'];
  ok(f.exec('git', [...identity, 'add', '-A'], {cwd: work, env})); ok(f.exec('git', [...identity, 'commit', '-qm', 'seed'], {cwd: work, env}));
  const gate = extra => {
    const result = f.exec(process.execPath, [path.join(kitRoot, 'engine/memory-check.mjs'), ...extra, '--json', '--repo', work, '--memory-dir', memory], {cwd: work, env});
    return JSON.parse(result.stdout).findings.map(finding => finding.check);
  };
  assert.ok(!gate(['--hook', '--scope', 'memory']).includes('repo.not-git'), 'the hook reads the repository git named');
  assert.ok(gate(['--scope', 'memory']).includes('repo.not-git'), 'outside the hook the exported variables are ignored');
});

test('I35 E2.8 (d) a planning copy that cannot be removed never replaces the refusal', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const page = migrationMemory(f, CRAFT_STUB), before = state(f), marker = path.join(f.root, 'cleanup-failed');
  const prelude = `const rm = fs.rmSync; fs.rmSync = (target, options) => { if (String(target).includes('kit-upgrade-plan-')) { fs.writeFileSync(${J(marker)}, 'busy\\n'); throw Object.assign(new Error('EBUSY: resource busy or locked, rmdir ' + target), {code: 'EBUSY'}); } return rm(target, options); };`;
  const result = f.exec(process.execPath, [driver(f, next, '', prelude)]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(fs.existsSync(marker), 'the cleanup ran and failed');
  assert.ok(result.stderr.includes('upgrade: cannot plan the memory steps (run the route migration first; refusing to overwrite INDEX-craft.md); nothing written'), result.stderr);
  assert.doesNotMatch(result.stderr, /EBUSY/);
  assert.equal(read(page), CRAFT_STUB); assert.deepEqual(state(f), before);
});

test('I36 E2.8 (d) a restore refuses a fifo, socket or device at a generated path before reading it', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const backup = backupOf(ok(upgrade(f, next, ['--live-memory'])));
  const page = path.join(f.memory, 'INDEX-craft-sessions.md'), marker = path.join(f.root, 'fifo-read'), before = state(f);
  // The page shows as a fifo to every kind check (stat and the directory listing); reading it records the read and fails.
  const prelude = `import path from 'node:path';
const page = ${J(page)}, same = file => path.resolve(String(file)).toLowerCase() === page.toLowerCase();
const stat = fs.statSync, readFile = fs.readFileSync, readdir = fs.readdirSync;
fs.statSync = (file, ...rest) => { const result = stat(file, ...rest); if (result && same(file)) { result.isFile = () => false; result.isFIFO = () => true; } return result; };
fs.readFileSync = (file, ...rest) => { if (same(file)) { fs.writeFileSync(${J(marker)}, 'read\\n'); throw Object.assign(new Error('EAGAIN: a fifo read would wait'), {code: 'EAGAIN'}); } return readFile(file, ...rest); };
fs.readdirSync = (dir, options) => { const list = readdir(dir, options); if (!options?.withFileTypes) return list; return list.map(entry => same(path.join(String(dir), entry.name)) ? Object.assign(Object.create(Object.getPrototypeOf(entry)), entry, {isFile: () => false, isFIFO: () => true}) : entry); };`;
  const result = f.exec(process.execPath, [driver(f, next, '', prelude, {restore: backup})]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  // Kit 3.3.6 item 7 (a): safety() refuses a special file at any restore destination with one message, before the
  // generated-output check (which stays as a second guard).
  assert.ok(result.stderr.includes(`upgrade: refusing to write ${page} (restore): it is a fifo, socket or device`), result.stderr);
  assert.ok(!fs.existsSync(marker), 'the page is never read');
  assert.deepEqual(state(f), before);
});

test('I37 E2.8 (e) memory-measure --write measures this project\'s memory with GIT_DIR and GIT_WORK_TREE exported to a foreign linked worktree', t => {
  const f = fixture(t); ok(f.install());
  const {foreignMemory, env} = foreignMissing(f);
  ok(writer(f, 'memory-measure.mjs', ['--write', 'probe', '--no-git'], env));
  const written = fs.readdirSync(path.join(f.target, 'docs/evidence/memory')).filter(name => name.endsWith('-probe.json'));
  assert.equal(written.length, 1, written.join(' '));
  assert.ok(!fs.existsSync(foreignMemory), 'the foreign memory is never created');
});

// ---- The release fixtures: an upgrade leaves memory as committed as it found it; staged means staged. ----
test('I38 E2.8 (d) the staged versions of generated pages are the index entries that differ from HEAD, not every tracked page', t => {
  const f = fixture(t), memory = path.join(f.root, 'staged-memory');
  fs.mkdirSync(memory); f.git(memory, 'init', '-q');
  const page = put(path.join(memory, 'INDEX-craft.md'), '# Craft\n');
  f.git(memory, 'add', '.'); f.git(memory, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'a hand-written page');
  // A route migration rewrote the working copy; the index still holds the committed version, so nothing is staged.
  put(page, GENERATED + '# Craft\n');
  assert.deepEqual([...stagedOutputs(memory)], []);
  f.git(memory, 'add', 'INDEX-craft.md');
  assert.deepEqual([...stagedOutputs(memory)], [['INDEX-craft.md', GENERATED + '# Craft\n']]);
  put(page, 'hand again\n'); f.git(memory, 'add', 'INDEX-craft.md');
  assert.deepEqual([...stagedOutputs(memory)], [['INDEX-craft.md', 'hand again\n']]);
});

test('I39 E2.8 (d) an upgrade regenerates a page whose committed version is hand-written when nothing is staged', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const page = path.join(f.memory, 'INDEX-craft-sessions.md'), generated = read(page);
  put(page, '# Craft sessions\n'); f.git(f.memory, 'add', '.'); f.git(f.memory, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'a hand-written page');
  // The working copy carries the marker again (as after a route migration) and the index matches HEAD.
  put(page, generated);
  const result = upgrade(f, next, ['--live-memory']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /staged version is not generated/);
  assert.ok(read(page).startsWith(GENERATED), 'the page is still generated');
});

test('I40 E2.8 (c) an upgrade of a memory that holds the one .memory.lock* line writes nothing to it, and that line covers the push lock', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const bare = path.join(f.root, 'backup.git'), branch = f.git(f.memory, 'branch', '--show-current');
  f.git(f.root, 'init', '-q', '--bare', bare); f.git(f.memory, 'remote', 'add', 'origin', bare);
  // The .gitignore every memory set up before this release has, committed and pushed.
  put(path.join(f.memory, '.gitignore'), '.memory.lock*\n'); f.git(f.memory, 'add', '.gitignore');
  if (f.git(f.memory, 'status', '--porcelain')) f.git(f.memory, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'the lock line');
  f.git(f.memory, 'push', '-q', '-u', 'origin', branch);
  assert.equal(f.git(f.memory, 'status', '--porcelain'), '');
  ok(upgrade(f, next, ['--live-memory']));
  assert.equal(f.git(f.memory, 'status', '--porcelain'), '', 'the upgrade leaves the memory repo clean');
  assert.equal(read(path.join(f.memory, '.gitignore')), '.memory.lock*\n');
  withMemoryLock(f.memory, () => assert.equal(f.git(f.memory, 'status', '--porcelain'), '', 'a held push lock is ignored'), {name: PUSH_LOCK});
  assert.match(ok(f.cli('scripts/memory/memory-check.mjs', ['--repo', f.target, '--memory-dir', f.memory], f.target)).stdout, /0 FAIL, 0 WARN/);
});
