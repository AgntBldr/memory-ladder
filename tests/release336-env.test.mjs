// Kit 3.3.6, the git environment and lock-name group: inherited GIT_* variables must not reach the kit's git calls, and
// every lock file is recognised by the one predicate. Each test names the mutant (one small change to the fix) that makes
// it fail. A test marked "pin" guards behaviour that did not change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixture, ok, put, read, json, kitRoot} from './helpers.mjs';
import {J, foreignWorktree, foreignMissing, writer, aheadMemory, withEnv, elsewhere} from './fixtures-335.mjs';
import {cleanGitEnv, memorySlug} from '../engine/lib.mjs';
import {hookPlan, install as installHook} from '../engine/install-hooks.mjs';
import {promoteTopics} from '../engine/memory-promote.mjs';
import {runHandover} from '../engine/handover.mjs';

const url = file => pathToFileURL(path.join(kitRoot, file)).href;
const engine = name => path.join(kitRoot, 'engine', name);

// The project itself on a named branch, with an upstream and two commits that were never pushed.
function projectWithUpstream(f) {
  const bare = path.join(f.root, 'project-backup.git');
  f.git(f.target, 'checkout', '-q', '-b', 'work-branch');
  f.git(f.target, 'add', '-A'); f.git(f.target, 'commit', '-qm', 'project seed');
  f.git(f.root, 'init', '-q', '--bare', bare);
  f.git(f.target, 'remote', 'add', 'origin', bare); f.git(f.target, 'push', '-q', '-u', 'origin', 'work-branch');
  for (let i = 0; i < 2; i++) { put(path.join(f.target, `ahead-${i}.txt`), 'x\n'); f.git(f.target, 'add', `ahead-${i}.txt`); f.git(f.target, 'commit', '-qm', `ahead ${i}`); }
  return {sha: f.git(f.target, 'rev-parse', '--short=7', 'HEAD')};
}
// The state a foreign GIT_DIR must never change is this memory's own page, found by content only here.
const ONLY_HERE = '---\nname: only-here\ndescription: Zebra quartz marker page that exists in this project memory only.\n---\nZebra quartz marker body.\n';

// ---- Item 3: the effective hook mode is defined once. ----

test('S6-T1 the gate with --hook --session-start reports this memory\'s ahead count with GIT_DIR and GIT_WORK_TREE exported to a foreign linked worktree', t => {
  // Mutant: pass the raw hook flag (hook: hook) to runCheck, as 3.3.5 did, so the session run skips the remote block.
  const f = fixture(t); ok(f.install());
  aheadMemory(f); const {env} = foreignMissing(f);
  const result = writer(f, 'memory-check.mjs', ['--hook', '--session-start'], env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /FAIL repo\.ahead \. 12 commits ahead of upstream/);
});

test('S6-T1b the effective hook mode is defined once in the gate\'s main', () => {
  // Mutant: spell hook && !session at a second site again.
  const source = read(engine('memory-check.mjs'));
  assert.equal(source.match(/hook && !session/g).length, 1, 'one definition');
  assert.match(source, /const hookMode = hook && !session;/);
});

// ---- Item 4: read-only commands run git with the clean environment. ----

test('S6-T2 new-session brief reports this repository\'s branch, commit, ahead count and memory with GIT_DIR and GIT_WORK_TREE exported to a foreign linked worktree', t => {
  // Mutants: drop env from the git helper's gitResult call (branch, sha, ahead); drop it from the memoryLocation call in facts.
  const f = fixture(t); ok(f.install());
  const {sha} = projectWithUpstream(f), {env} = foreignWorktree(f);
  const out = ok(writer(f, 'new-session.mjs', ['brief', '--repo', f.target], env)).stdout;
  assert.ok(out.includes(` | work-branch@${sha} | `), out);
  assert.ok(out.includes(' | 2 ahead | '), out);
  assert.ok(out.includes(`memory: ${f.memory} `), out);
});

test('S6-T2 new-session start reports this repository\'s branch, commit and ahead count and finds no foreign worktree with GIT_DIR and GIT_WORK_TREE exported to a foreign linked worktree', t => {
  // Mutants: drop env from the mainWorktree call in facts; drop it from the git helper (the worktree list); drop f.digest
  // from start()'s output (the three facts then vanish and only the negative assertions would pass).
  const f = fixture(t); ok(f.install());
  const {sha} = projectWithUpstream(f), {env} = foreignWorktree(f);
  const out = ok(writer(f, 'new-session.mjs', ['start', '--repo', f.target], env)).stdout;
  assert.ok(out.includes(` | work-branch@${sha} | `), out);
  assert.ok(out.includes(' | 2 ahead | '), out);
  assert.doesNotMatch(out, /worktree of /);
  assert.doesNotMatch(out, /multiple worktrees/);
  assert.doesNotMatch(out, /flags:[^\n]*worktree/);
});

test('S6-T2 new-session open opens this project\'s page with GIT_DIR and GIT_WORK_TREE exported to a foreign linked worktree', t => {
  // Mutant: drop env from the memoryLocation call in open.
  const f = fixture(t); ok(f.install());
  put(path.join(f.memory, 'only-here.md'), ONLY_HERE); const {env} = foreignWorktree(f);
  const result = writer(f, 'new-session.mjs', ['open', 'only-here.md', '--repo', f.target], env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Zebra quartz marker body/);
});

test('S6-T2 memory-recall returns this project\'s page with GIT_DIR and GIT_WORK_TREE exported to a foreign linked worktree', t => {
  // Mutant: drop env from the locations call in memory-recall's main.
  const f = fixture(t); ok(f.install());
  put(path.join(f.memory, 'only-here.md'), ONLY_HERE); const {foreignMemory, env} = foreignWorktree(f);
  const result = writer(f, 'memory-recall.mjs', ['zebra quartz marker', '--repo', f.target, '--memory-only', '--json'], env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /only-here\.md/);
  assert.ok(fs.existsSync(foreignMemory), 'the foreign memory exists and was not the one searched');
});

test('S6-T2 memory-conserve snapshot lists this memory\'s files with GIT_DIR and GIT_WORK_TREE exported to a foreign linked worktree', t => {
  // Mutant: drop env from the locations call in memory-conserve's main.
  const f = fixture(t); ok(f.install());
  put(path.join(f.memory, 'only-here.md'), ONLY_HERE); const {env} = foreignWorktree(f), out = path.join(f.root, 'baseline.json');
  ok(writer(f, 'memory-conserve.mjs', ['snapshot', '--repo', f.target, '--out', out], env));
  assert.ok(Object.keys(json(out).files).includes('only-here.md'), Object.keys(json(out).files).join(' '));
});

test('S6-T2b every locations call in the engine passes a clean environment, except the two named files', () => {
  // Static, so the next command that copies the default is caught. Mutant: remove env from the call in memory-recall.
  const bare = [];
  for (const name of fs.readdirSync(path.join(kitRoot, 'engine')).filter(n => n.endsWith('.mjs')).sort()) {
    const text = read(engine(name));
    for (const match of text.matchAll(/(?<![\w$])(?<![^.]\.)locations\(/g)) {
      if (/function\s+$/.test(text.slice(Math.max(0, match.index - 12), match.index))) continue;
      let depth = 0, at = match.index + match[0].length - 1, end = at;
      for (; end < text.length; end++) { if (text[end] === '(') depth++; else if (text[end] === ')' && --depth === 0) break; }
      if (!/\benv\b/.test(text.slice(at, end))) bare.push(name);
    }
  }
  // install-hooks is clean through its own useGitEnvironment(cleanGitEnv); the selftest call is a plain unit case. The
  // gate's hook path passes its own environment object, so it names env too.
  assert.deepEqual(bare, ['install-hooks.mjs', 'memory-selftest-cases.mjs']);
  const session = read(engine('new-session.mjs'));
  for (const call of ['memoryLocation', 'mainWorktree', 'gitResult']) {
    const found = [...session.matchAll(new RegExp(`${call}\\([^;]*`, 'g'))].filter(m => !/^\w+\([^)]*\)\s*=>|import/.test(m[0]) && !session.slice(Math.max(0, m.index - 8), m.index).includes('function'));
    for (const m of found) assert.match(m[0], /env: ?cleanGitEnv\(\)/, `new-session ${call} call: ${m[0].slice(0, 90)}`);
  }
});

// ---- Item 5: the remaining unclean spawns, two missing variables, one identity probe. ----

test('S6-T3 cleanGitEnv drops GIT_NAMESPACE and GIT_CONFIG and keeps the variables that only name configuration files', () => {
  // Mutant: drop one of the two names from GIT_REDIRECTS.
  const clean = cleanGitEnv({GIT_NAMESPACE: 'zzz', GIT_CONFIG: 'x', git_config: 'y', GIT_CONFIG_GLOBAL: 'g', GIT_CONFIG_NOSYSTEM: '1', GIT_DIR: 'd', GIT_AUTHOR_NAME: 'a', PATH: 'p'});
  assert.deepEqual(Object.keys(clean).sort(), ['GIT_AUTHOR_NAME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'PATH']);
});

test('S6-T3 a checkpoint publication with GIT_NAMESPACE exported updates the branch itself and creates no namespace', t => {
  // Mutant: drop GIT_NAMESPACE from GIT_REDIRECTS (the push then lands under refs/namespaces and the check still passes).
  const f = fixture(t); ok(f.install());
  const bare = path.join(f.root, 'backup.git'), branch = f.git(f.memory, 'branch', '--show-current');
  f.git(f.root, 'init', '-q', '--bare', bare);
  f.git(f.memory, 'remote', 'add', 'origin', bare); f.git(f.memory, 'push', '-q', '-u', 'origin', branch);
  fs.appendFileSync(path.join(f.memory, '.gitignore'), '# a pending memory change\n');
  const result = f.exec(process.execPath, [path.join(f.target, 'scripts/memory/memory-checkpoint.mjs')], {env: {...f.env, GIT_NAMESPACE: 'zzz'}});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.git(bare, 'rev-parse', 'refs/heads/' + branch), f.git(f.memory, 'rev-parse', 'HEAD'), 'the branch is at the pushed commit');
  assert.equal(f.git(bare, 'for-each-ref', 'refs/namespaces'), '', 'no namespace was created');
});

test('S6-T3 the hook lookup finds core.hooksPath with GIT_CONFIG exported at an empty file', t => {
  // Mutant: drop GIT_CONFIG from GIT_REDIRECTS.
  const f = fixture(t), memoryDir = path.join(f.target, 'notes');
  fs.mkdirSync(memoryDir); f.git(f.target, 'config', 'core.hooksPath', 'project-hooks');
  const empty = put(path.join(f.root, 'empty.gitconfig'), '');
  const plan = withEnv({GIT_CONFIG: empty}, () => hookPlan({memoryDir, repo: f.target}));
  assert.equal(plan.status, 'preserved'); assert.equal(plan.reason, 'hooksPath');
});

// A repository elsewhere, with commits of its own, that an inherited GIT_DIR and GIT_WORK_TREE point at.
function elsewhereWithCommits(f) {
  const exported = elsewhere(f);
  for (const name of ['one', 'two']) f.git(exported.GIT_WORK_TREE, 'commit', '-q', '--allow-empty', '-m', 'elsewhere ' + name);
  return exported;
}
// A project in its own scan root with three commits, the last dated five days ago, and no memory folder.
function scanProject(f) {
  const root = path.join(f.root, 'scan-root'), project = path.join(root, 'proj'), home = path.join(f.root, 'scan-memory-home');
  fs.mkdirSync(project, {recursive: true}); fs.mkdirSync(home, {recursive: true});
  f.git(project, 'init', '-q');
  const five = new Date(Date.now() - 5 * 86400000).toISOString();
  for (const [i, when] of [['one', undefined], ['two', undefined], ['three', five]]) {
    put(path.join(project, `${i}.txt`), i + '\n'); f.git(project, 'add', '-A');
    const date = when ? {GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when} : {};
    ok(f.exec('git', ['-C', project, '-c', 'user.name=kit-test', '-c', 'user.email=kit-test@example.invalid', 'commit', '-qm', i], {env: {...f.env, ...date}}));
  }
  return {root, project, home, last: f.git(project, 'log', '-1', '--format=%cI')};
}

test('S6-T4 memory-fleet reports this project\'s commit facts and its cleanliness with GIT_DIR and GIT_WORK_TREE exported to another repository', t => {
  // Mutants, one case each: drop the clean environment from the options of the filter probe and of the git call (the
  // options object at the top of createGit); drop the two status checks from gate.committed (the dirty target then
  // reports committed).
  const f = fixture(t); ok(f.install());
  const scan = scanProject(f), exported = elsewhereWithCommits(f), memory = path.join(scan.home, memorySlug(scan.project), 'memory');
  put(path.join(memory, 'MEMORY.md'), '# Memory\n'); f.git(memory, 'init', '-q'); f.git(memory, 'add', '-A'); f.git(memory, 'commit', '-qm', 'memory seed');
  const scanRow = () => {
    const result = writer(f, 'memory-fleet.mjs', ['--root', scan.root, '--memory-home', scan.home, '--json'], {...f.env, ...exported});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout).projects.find(r => r.project === scan.project);
  };
  // Clean target and memory, dirty foreign repository: the target is committed.
  const foreignDirt = put(path.join(exported.GIT_WORK_TREE, 'foreign-dirt.txt'), 'x\n');
  const clean = scanRow();
  assert.equal(clean.lastCommit, scan.last, 'the last commit date is this project\'s');
  assert.equal(clean.commits30Days, 3, 'the commit count is this project\'s');
  assert.doesNotMatch(clean.status, /unreadable/);
  assert.equal(clean.gate.committed, true, 'a clean target is committed although the foreign repository is dirty');
  // Dirty target, clean foreign repository: the target is not committed.
  fs.rmSync(foreignDirt); put(path.join(scan.project, 'untracked.txt'), 'x\n');
  assert.equal(scanRow().gate.committed, false, 'a dirty target is not committed although the foreign repository is clean');
});

test('S6-T4 memory-census reports this memory\'s commit and file history with GIT_DIR and GIT_WORK_TREE exported to another repository', t => {
  // Mutants, one case each: drop the clean environment from the run helper (the history log); from the HEAD probe.
  const f = fixture(t); ok(f.install());
  const exported = elsewhereWithCommits(f), out = path.join(f.root, 'census-out');
  const head = f.git(f.memory, 'rev-parse', 'HEAD'), first = f.git(f.memory, 'log', '--format=%cs', '--', 'MEMORY.md').split(/\r?\n/).at(-1);
  const result = writer(f, 'memory-census.mjs', ['--memory-dir', f.memory, '--repo', f.target, '--out', out], {...f.env, ...exported});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const census = json(path.join(out, 'census.json'));
  assert.equal(census.memory_dir_commit, head, 'the commit is this memory\'s');
  assert.equal(census.rows.find(r => r.file === 'MEMORY.md').first_commit, first, 'the file history is this memory\'s');
});

// A driver that records the environment of every child process the kit starts, with the four variables exported.
function spyDriver(f, name, exported, body) {
  const log = path.join(f.root, name + '-children.json'), empty = put(path.join(f.root, name + '.gitconfig'), '');
  const script = put(path.join(f.root, name + '-driver.mjs'), `import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const seen = [], spawn = cp.spawnSync, names = /^(?:GIT_DIR|GIT_WORK_TREE|GIT_NAMESPACE|GIT_CONFIG)$/i;
cp.spawnSync = function (command, args, options) {
  const env = options?.env ?? process.env;
  seen.push({command: path.basename(String(command)).replace(/\\.exe$/i, ''), args: (args ?? []).slice(0, 5).map(String), leaked: Object.keys(env).filter(key => names.test(key))});
  return spawn.call(cp, command, args, options);
};
syncBuiltinESMExports();
process.on('exit', () => fs.writeFileSync(${J(log)}, JSON.stringify(seen)));
Object.assign(process.env, ${J({...exported, GIT_NAMESPACE: 'zzz', GIT_CONFIG: empty})});
${body}
`);
  return {script, log};
}
const children = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('S6-T4b the fleet gate child and the census git calls get no GIT_DIR from the environment (spawn spy)', t => {
  // Mutants: drop the clean environment from the gate child options in memory-fleet; from the census git-dir probe.
  const f = fixture(t); ok(f.install());
  const scan = scanProject(f), memory = path.join(scan.home, memorySlug(scan.project), 'memory');
  put(path.join(memory, 'MEMORY.md'), '# Memory\n');
  const exported = elsewhere(f);
  const fleet = spyDriver(f, 'fleet', exported, `const {fleet} = await import(${J(url('engine/memory-fleet.mjs'))});
fleet({roots: [${J(scan.root)}], memoryHome: ${J(scan.home)}});`);
  ok(f.exec(process.execPath, [fleet.script]));
  const seenFleet = children(fleet.log);
  assert.ok(seenFleet.some(e => e.command === 'git'), 'a git child was recorded');
  assert.ok(seenFleet.some(e => e.command === 'node'), 'the gate child was recorded');
  assert.deepEqual(seenFleet.filter(e => e.leaked.length), []);
  const out = path.join(f.root, 'spy-census-out');
  const census = spyDriver(f, 'census', exported, `process.argv = [process.execPath, ${J(engine('memory-census.mjs'))}, '--memory-dir', ${J(f.memory)}, '--repo', ${J(f.target)}, '--out', ${J(out)}];
await import(${J(url('engine/memory-census.mjs'))});`);
  ok(f.exec(process.execPath, [census.script]));
  const seenCensus = children(census.log);
  assert.ok(seenCensus.filter(e => e.command === 'git').length >= 2, 'the census git children were recorded');
  assert.deepEqual(seenCensus.filter(e => e.leaked.length), []);
});

test('S6-T5 setup commits the first notes with the fallback identity when git knows an author but no committer', t => {
  // Mutant: probe the author identity only (the committer probe dropped).
  const f = fixture(t);
  const config = put(path.join(f.root, 'author-only.gitconfig'), '[user]\n\tuseConfigOnly = true\n');
  const base = {...f.env, GIT_CONFIG_GLOBAL: config, GIT_AUTHOR_NAME: 'Author Only', GIT_AUTHOR_EMAIL: 'author-only@example.invalid'};
  for (const key of ['GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete base[key];
  const result = f.exec(process.execPath, [path.join(kitRoot, 'scripts/install.mjs'), '--target', f.target], {env: base});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Git has no saved author name and email; the first notes commit uses memory-ladder-kit/);
  assert.equal(f.git(f.memory, 'log', '-1', '--format=%cn'), 'memory-ladder-kit');
});

test('S6-T5 pin: setup keeps the user\'s identity when git knows both an author and a committer', t => {
  // Pin (green on 3.3.5). Mutant: always pass the fallback identity.
  const f = fixture(t);
  // The identity is saved in git's configuration, where the fallback's -c options would override it.
  const config = put(path.join(f.root, 'saved-identity.gitconfig'), '[user]\n\tname = Saved Identity\n\temail = saved@example.invalid\n');
  const env = {...f.env, GIT_CONFIG_GLOBAL: config};
  for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete env[key];
  const result = f.exec(process.execPath, [path.join(kitRoot, 'scripts/install.mjs'), '--target', f.target], {env});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /Git has no saved author name/);
  assert.equal(f.git(f.memory, 'log', '-1', '--format=%cn'), 'Saved Identity');
});

test('S6-T6 the installer and setup start no child with GIT_DIR, GIT_WORK_TREE, GIT_NAMESPACE or GIT_CONFIG exported (spawn spy)', t => {
  // Mutant: env: process.env on the baseline probe in memory-setup's finishMemoryLocked.
  const f = fixture(t);
  const spy = spyDriver(f, 'install', elsewhere(f), `const {install, options} = await import(${J(url('scripts/install.mjs'))});
install(options(['--target', ${J(f.target)}]));`);
  const result = f.exec(process.execPath, [spy.script]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const seen = children(spy.log);
  assert.ok(seen.some(e => e.command === 'git'), 'a git child was recorded: ' + J(seen));
  assert.ok(seen.some(e => e.command === 'git' && e.args.includes('--verify')), 'the baseline probe was recorded');
  assert.deepEqual(seen.filter(e => e.leaked.length), []);
});

// ---- Item 10: lock-name sites that name one lock where any lock is meant. ----

// A memory folder with one page the promote map moves; returns the map file.
function promoteMemory(f, memoryDir) {
  put(path.join(memoryDir, 'MEMORY.md'), '# Memory\n\n## Routes\n- [Craft](INDEX-craft-demo.md) OPEN BEFORE crafting.\n');
  put(path.join(memoryDir, 'alpha-note.md'), '---\nname: alpha-note\ndescription: Verify the measured result before another operation.\nmetadata:\n  type: feedback\n  route: [craft-demo]\n  date: 2026-01-02\n---\nKeep the violet calibration result.\n');
  return put(path.join(f.root, 'map.json'), JSON.stringify({version: 1, promote: {'alpha-note.md': {kind: 'mistake', trigger: 'before calibration'}}}));
}

test('S6-T13y the promote rehearsal copy holds neither the push lock nor a differently cased writer lock', t => {
  // Mutant: restore the exact-name test (entry.name==='.memory.lock') in the rehearsal copy.
  const f = fixture(t), memoryDir = path.join(f.root, 'promote-memory'), map = promoteMemory(f, memoryDir);
  const run = () => promoteTopics({memoryDir, map, check: () => ({findings: []})});
  const before = run().rehearsal;
  assert.ok(before.files > 0, 'the rehearsal copied files');
  put(path.join(memoryDir, '.memory.lock.push'), '{"pid": 1}\n'); put(path.join(memoryDir, '.MEMORY.LOCK'), '{"pid": 1}\n');
  assert.deepEqual(run().rehearsal, before, 'lock files are not copied');
});

test('S6-T13y the promote rehearsal copy holds no lock file that git tracks inside in-repo memory, and still copies the project\'s tracked files', t => {
  // The tracked-file path of the copy (git ls-files, used when a repo is supplied) is a second way in beside the directory
  // walk. The lock rule is scoped to memory: a project file outside memory whose name merely starts with the lock prefix is
  // an ordinary file. Mutants: copy every tracked path (drop the lock test from the tracked-file loop); apply the lock test
  // to the repo-relative path (isLockPath(file)), which drops the two prefix-named controls.
  const f = fixture(t), project = path.join(f.root, 'tracked-project'), memoryDir = path.join(project, 'notes');
  fs.mkdirSync(project); f.git(project, 'init', '-q');
  const map = promoteMemory(f, memoryDir);
  put(path.join(project, 'docs/readme.txt'), 'project file\n');
  f.git(project, 'add', '-A');
  const run = () => promoteTopics({memoryDir, repo: project, map, check: () => ({findings: []})});
  const before = run().rehearsal;
  assert.ok(before.files > 0, 'the rehearsal copied files');
  put(path.join(memoryDir, '.memory.lock'), '{"pid": 1}\n'); put(path.join(memoryDir, '.memory.lock.push'), '{"pid": 1}\n');
  f.git(project, 'add', '-f', '--', 'notes/.memory.lock', 'notes/.memory.lock.push');
  assert.match(f.git(project, 'ls-files'), /notes\/\.memory\.lock\.push/, 'both locks are tracked');
  assert.deepEqual(run().rehearsal, before, 'tracked lock files are not copied');
  // Controls: ordinary tracked project files are still copied, counted once; so are files outside memory whose name or
  // folder starts with the lock prefix.
  const extra = {'docs/second.txt': 'second project file\n', 'docs/.memory.lock-notes.md': 'prefix-named file\n', 'docs/.memory.lock-design/readme.md': 'prefix-named folder\n'};
  for (const [file, text] of Object.entries(extra)) { put(path.join(project, file), text); f.git(project, 'add', '--', file); }
  const after = run().rehearsal;
  assert.equal(after.files, before.files + 3);
  assert.equal(after.bytes, before.bytes + Object.values(extra).reduce((sum, text) => sum + Buffer.byteLength(text), 0));
});

test('S6-T13y new-session names the push lock as its own signal and keeps the writer-lock wording', t => {
  // Mutant: look at the writer lock only.
  const f = fixture(t); ok(f.install());
  put(path.join(f.memory, '.memory.lock'), 'operation');
  let out = ok(writer(f, 'new-session.mjs', ['brief', '--repo', f.target], f.env)).stdout;
  assert.match(out, /possible other session: \.memory\.lock \(operation lock\) - stage by path/);
  assert.doesNotMatch(out, /\.memory\.lock\.push/);
  fs.unlinkSync(path.join(f.memory, '.memory.lock')); put(path.join(f.memory, '.memory.lock.push'), 'publication');
  out = ok(writer(f, 'new-session.mjs', ['brief', '--repo', f.target], f.env)).stdout;
  assert.match(out, /possible other session: \.memory\.lock\.push \(publication lock\) - stage by path/);
  assert.doesNotMatch(out, /\(operation lock\)/);
});

test('S6-T13y both lock signals survive the signal cap with several worktrees and a 100-character main-checkout path', t => {
  // The signals share a 280-byte cap, so a lock entry placed after the optional ones is cut. Mutant: put the lock entries
  // after the worktree and recent-change signals again.
  const f = fixture(t), main = path.join(f.root, 'm'.repeat(100), 'main'), work = path.join(f.root, 'linked-work'), memory = path.join(f.root, 'cap-memory');
  fs.mkdirSync(main, {recursive: true}); f.git(main, 'init', '-q'); put(path.join(main, 'a.txt'), 'a\n'); f.git(main, 'add', '-A'); f.git(main, 'commit', '-qm', 'seed');
  f.git(main, 'worktree', 'add', '-q', '-b', 'cap-branch', work);
  put(path.join(memory, 'MEMORY.md'), '# Memory\n'); put(path.join(memory, '.memory.lock'), 'operation'); put(path.join(memory, '.memory.lock.push'), 'publication');
  const out = ok(f.exec(process.execPath, [engine('new-session.mjs'), 'brief', '--repo', work, '--memory-dir', memory], {env: f.env})).stdout;
  assert.ok(out.includes('possible other session: .memory.lock (operation lock) - stage by path'), out);
  assert.ok(out.includes('possible other session: .memory.lock.push (publication lock) - stage by path'), out);
});

// A quick handover whose lock wait times out at once; `prepare` runs just before the wait and may create lock files.
// Returns the report text of the refused run.
function handoverTimeout(t, prepare) {
  const f = fixture(t); ok(f.install());
  const branch = f.git(f.target, 'branch', '--show-current');
  fs.appendFileSync(path.join(f.target, 'AGENTS.md'), `\n## Session overlay\nbranch: ${branch}\npush: memory\n`);
  f.git(f.target, 'add', '-A'); f.git(f.target, 'commit', '-qm', 'seed');
  const bare = path.join(f.root, 'backup.git'), memoryBranch = f.git(f.memory, 'branch', '--show-current');
  f.git(f.root, 'init', '-q', '--bare', bare); f.git(f.memory, 'remote', 'add', 'origin', bare); f.git(f.memory, 'push', '-q', '-u', 'origin', memoryBranch);
  const input = put(path.join(f.root, 'input.json'), J({state: 'Ready to continue', question: 'Which next?', next: ['Review results'], waits: 'none', risks: 'none'}));
  let output = '';
  const result = withEnv({GIT_CONFIG_GLOBAL: f.env.GIT_CONFIG_GLOBAL, HOME: f.home, USERPROFILE: f.home}, () => runHandover({repo: f.target, memoryDir: f.memory, input, quick: true, now: new Date()}, {
    lockTimeoutMs: 1, output: text => { output += text; }, beforeLock: () => prepare(f),
  }));
  assert.equal(result.code, 1, output);
  return output.replace(/\\/g, '/');
}

test('S6-T13y the handover timeout report names the age and path of each lock file and keeps the file the wait named', t => {
  // Mutant: report the writer lock only.
  const output = handoverTimeout(t, f => { put(path.join(f.memory, '.memory.lock'), '{}'); put(path.join(f.memory, '.memory.lock.push'), '{}'); });
  assert.match(output, /memory lock timed out waiting for [^\n;]*\/\.memory\.lock(?![.\w])/, 'the wait names the writer lock');
  assert.match(output, /`[^`\n]*\/\.memory\.lock`, age \d+ s; /, 'the writer lock is reported');
  assert.match(output, /`[^`\n]*\/\.memory\.lock\.push`, age \d+ s; if no other session is running, remove it/, 'the push lock is reported');
});

test('S6-T13y the handover timeout report still names the writer lock when no lock file exists any more', t => {
  // The empty set: the lock is gone by the time the report is built (shown here by hiding both names from existsSync,
  // which is what the report asks). Mutant: report only the lock files that exist, with no fallback to the writer lock.
  const exists = fs.existsSync;
  let hidden = false;
  fs.existsSync = file => !(hidden && /[\\/]\.memory\.lock(?:\.push)?$/.test(String(file))) && exists(file);
  t.after(() => { fs.existsSync = exists; });
  const output = handoverTimeout(t, f => { put(path.join(f.memory, '.memory.lock'), '{}'); hidden = true; });
  assert.match(output, /`[^`\n]*\/\.memory\.lock`, age (?:\d+ s|unknown); if no other session is running, remove it/, 'the writer lock is named');
  assert.doesNotMatch(output, /\.memory\.lock\.push`, age/);
});

test('S6-T13y the session claim check recognises a lock name through the shared path predicate (static)', () => {
  // Pin: the replacement of parts.some(isLockName) by isLockPath(key) changes no outcome for a slash-separated key, so
  // this reads the source. Mutant: restore parts.some(isLockName) in claimKey.
  const source = read(engine('memory-session.mjs'));
  assert.match(source, /if \(isLockPath\(key\)\) fail\('lock file'\);/);
  assert.doesNotMatch(source, /parts\.some\(isLockName\)/);
});

// ---- Item 11b: a linked worktree of a bare repository. ----

test('S6-T14b pin: the memory hook is installed at the bare repository\'s own hook path from a worktree of a bare repository', t => {
  // Pin (green on 3.3.5; such a worktree is still treated as the main checkout). Mutant: linkedWorktree returns the
  // main record when the first worktree record is bare, so the install refuses as a linked worktree.
  const f = fixture(t);
  const source = path.join(f.root, 'source'), bare = path.join(f.root, 'bare.git'), work = path.join(f.root, 'bare-work');
  fs.mkdirSync(source); f.git(source, 'init', '-q'); put(path.join(source, 'a.txt'), 'a\n'); f.git(source, 'add', '-A'); f.git(source, 'commit', '-qm', 'seed');
  ok(f.exec('git', ['clone', '-q', '--bare', source, bare]));
  f.git(bare, 'worktree', 'add', '-q', '-b', 'bare-work-branch', work);
  const memoryDir = path.join(work, 'notes'); fs.mkdirSync(memoryDir);
  const result = installHook({memoryDir, repo: work});
  assert.equal(result.ok, true, result.message);
  const hook = path.join(bare, 'hooks', 'pre-commit');
  assert.ok(fs.existsSync(hook), 'the hook is at the bare repository\'s own path');
  assert.match(read(hook), /memory-v3-gate/);
});
