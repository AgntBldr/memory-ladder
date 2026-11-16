// Kit 3.3.5: a save touches only its own session's work (spec Part 1, tests E10 and E12).
// Fixture: a memory git repo with a local bare remote and the kit's real pre-commit hook; two checkouts of one project on
// branches b1 and b2 (sessions S1 and S2). Barriers between processes synchronise on hook entry, never on sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {kitRoot} from './helpers.mjs';
import {loadConfig, mdLinks} from '../engine/lib.mjs';
import {writeMemoryIndex, generatedMarker} from '../engine/memory-index.mjs';
import {newLesson} from '../engine/memory-lesson.mjs';
import {install as installHook} from '../engine/install-hooks.mjs';
import * as session from '../engine/memory-session.mjs';
import * as cp from '../engine/memory-checkpoint.mjs';

const engine = name => path.join(kitRoot, 'engine', name);
const junction = (target, link) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
const unlink = link => { try { fs.rmdirSync(link); } catch { fs.unlinkSync(link); } };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const topic = (name, route = 'craft') => `---\nname: ${name}\ndescription: "${name} notes kept for the fixture."\nmetadata:\n  type: reference\n  route: ${route}\n---\n\n# ${name}\n\nBody of ${name}.\n`;
const ROUTER = '# Memory\n\n## Routing\n- [Craft](INDEX-craft.md) OPEN BEFORE testing.\n- [Ops](INDEX-ops.md) OPEN BEFORE operating.\n\n## Active work\n- [Current](current-state.md) OPEN BEFORE resuming.\n';
const CURRENT = '---\nname: current-state\ndescription: "Current task, next action and checkpoint handoff."\nmetadata:\n  type: project\n  state: true\n---\n\n## CURRENT\nold state\n';

export function world(t, {inRepo = false, remote = true, hook = true, mode = 'session', topics = ['alpha', 'beta']} = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kit335-')));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const gitconfig = path.join(home, '.gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n name = kit-test\n email = kit-test@example.invalid\n[core]\n autocrlf = false\n longpaths = true\n[init]\n defaultBranch = main\n');
  const saved = {};
  for (const [key, value] of Object.entries({GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', CLAUDE_MEMORY_DIR: undefined})) { saved[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, {recursive: true, force: true, maxRetries: 5});
  });
  const env = {...process.env};
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
  if (inRepo) config.memory = {inRepoDir: 'memory'};
  put(path.join(project, 'AGENTS.md'), '# Project\n');
  // An installed engine copy, so the real pre-commit hook runs the installed gate with this fixture's own config.
  for (const name of fs.readdirSync(path.join(kitRoot, 'engine'))) if (name !== 'memory.config.json' && fs.statSync(path.join(kitRoot, 'engine', name)).isFile()) fs.copyFileSync(path.join(kitRoot, 'engine', name), put(path.join(project, 'scripts/memory', name), ''));
  fs.copyFileSync(path.join(kitRoot, 'docs/LESSON-KINDS.md'), path.join(project, 'scripts/memory/LESSON-KINDS.md'));
  put(path.join(project, 'scripts/memory/memory.config.json'), JSON.stringify(config, null, 2) + '\n');
  put(path.join(project, 'scripts/memory/KIT.json'), JSON.stringify({version: config.engine_version}) + '\n');
  put(path.join(project, '.gitignore'), '.memory.lock*\n.sessions/\n');
  put(path.join(project, 'docs/ROADMAP.md'), '# Roadmap\n\n## Open work\n\n**2026-11-01** first block\n\n**2026-11-02** second block\n');
  const memoryRoot = inRepo ? path.join(project, 'memory') : path.join(root, 'memory');
  const seedMemory = dir => {
    put(path.join(dir, '.gitignore'), '.memory.lock*\n.sessions/\n');
    put(path.join(dir, 'MEMORY.md'), ROUTER);
    put(path.join(dir, 'current-state.md'), CURRENT);
    for (const name of topics) put(path.join(dir, `topic-${name}.md`), topic(`topic-${name}`));
    writeMemoryIndex({memoryDir: dir, config});
  };
  seedMemory(memoryRoot);
  git(project, 'add', '.'); git(project, 'commit', '-m', 'project seed');
  if (!inRepo) { git(memoryRoot, 'init', '-b', 'main'); git(memoryRoot, 'add', '.'); git(memoryRoot, 'commit', '-m', 'memory seed'); }
  const holder = inRepo ? project : memoryRoot;
  let bare = null;
  if (remote) {
    bare = path.join(root, 'remote.git'); git(root, 'init', '--bare', '-b', 'main', bare);
    git(holder, 'remote', 'add', 'origin', bare); git(holder, 'push', '-q', '-u', 'origin', 'main');
  }
  if (hook) {
    const result = installHook({memoryDir: memoryRoot, repo: project});
    assert.ok(result.ok, result.message);
  }
  const sessions = {};
  for (const name of ['b1', 'b2']) {
    const repo = path.join(root, name);
    git(project, 'worktree', 'add', '-q', '-b', name, repo);
    sessions[name === 'b1' ? 'S1' : 'S2'] = {name, repo, branch: name, memoryDir: inRepo ? path.join(repo, 'memory') : memoryRoot};
  }
  const w = {root, home, env, project, memoryDir: memoryRoot, bare, holder, config, git, put, inRepo, ...sessions};
  w.read = (file, s = w.S1) => fs.readFileSync(path.join(s.memoryDir, file), 'utf8');
  w.write = (file, text, s = w.S1) => put(path.join(s.memoryDir, file), text);
  w.tracked = (s = w.S1, ref = 'HEAD') => git(s.inRepo ? s.repo : s.memoryDir, 'ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean);
  w.newLesson = (s, title, {fill = true, route = 'craft'} = {}) => {
    const file = newLesson({memoryDir: s.memoryDir, repo: s.repo, config, title, route, kind: 'practice', today: '2026-11-12'});
    if (fill) fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('description: "TODO"', `description: "${title} explained for the fixture."`).replace('**Why:**\n', '**Why:**\nBecause the fixture needs it.\n').replace('**How to apply:**', '**How to apply:**\nApply it in the test.'));
    return path.basename(file);
  };
  w.claim = (s, files, extra = {}) => session.claimFiles({memoryDir: s.memoryDir, repo: s.repo, files, ...extra});
  w.ledger = s => {
    const id = session.sessionOf(s.repo).id, file = path.join(s.memoryDir, '.sessions', id + '.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  };
  w.indexEntries = (s = w.S1) => git(s.inRepo ? s.repo : s.memoryDir, 'ls-files', '--stage');
  w.snapshot = (dir = w.memoryDir) => {
    const out = {};
    const walk = rel => { for (const e of fs.readdirSync(path.join(dir, rel), {withFileTypes: true})) {
      const next = rel ? rel + '/' + e.name : e.name;
      if (e.name === '.git' || e.name === '.sessions' || /^\.memory\.(?:push\.)?lock/.test(e.name)) continue;
      if (e.isDirectory()) walk(next); else if (e.isFile()) out[next] = fs.readFileSync(path.join(dir, next)).toString('base64');
    } };
    walk(''); return out;
  };
  // The hook gate reads the installed config: keep it equal to the in-process config.
  w.saveConfig = () => { for (const dir of [project, ...(inRepo ? [w.S1.repo, w.S2.repo] : [])]) put(path.join(dir, 'scripts/memory/memory.config.json'), JSON.stringify(config, null, 2) + '\n'); };
  w.hookPath = () => w.git(holder, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-commit');
  w.lines = [];
  w.save = (s, opts = {}) => cp.checkpoint({memoryDir: s.memoryDir, repo: s.repo, config: w.config, session: true, today: '2026-11-12', report: (step, message) => w.lines.push(`${step}: ${message}`), ...opts});
  w.configFile = path.join(project, 'scripts/memory/memory.config.json');
  w.cli = (s, argv, options = {}) => spawnSync(process.execPath, [engine('memory-checkpoint.mjs'), '--repo', s.repo, '--memory-dir', s.memoryDir, '--config', w.configFile, '--today', '2026-11-12', ...argv], {encoding: 'utf8', env: process.env, ...options});
  w.committed = (sha, s = w.S1) => git(s.inRepo ? s.repo : s.memoryDir, 'diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha).split('\n').filter(Boolean).map(f => w.inRepo ? f.replace(/^memory\//, '') : f).sort();
  w.show = (sha, file, s = w.S1) => git(s.inRepo ? s.repo : s.memoryDir, 'show', `${sha}:${w.inRepo ? 'memory/' : ''}${file}`);
  w.head = (s = w.S1) => git(s.inRepo ? s.repo : s.memoryDir, 'rev-parse', 'HEAD');
  w.remoteHead = () => git(w.root, '--git-dir', w.bare, 'rev-parse', 'refs/heads/main');
  w.refs = (s = w.S1) => git(s.inRepo ? s.repo : s.memoryDir, 'for-each-ref', '--format=%(refname) %(objectname)') + '\n' + git(s.inRepo ? s.repo : s.memoryDir, 'rev-parse', 'HEAD');
  w.ledgers = () => { const dir = path.join(w.memoryDir, '.sessions'); return fs.existsSync(dir) ? Object.fromEntries(fs.readdirSync(dir).filter(n => n.endsWith('.json')).map(n => [n, fs.readFileSync(path.join(dir, n), 'utf8')])) : {}; };
  return w;
}
const gateFails = result => (result.gate?.fails ?? []).map(f => `${f.check} ${f.file}`);
// Every link in every generated page of a commit resolves inside that commit's tree.
function linksResolve(w, sha) {
  const pages = w.git(w.memoryDir, 'ls-tree', '--name-only', sha).split('\n').filter(f => /^INDEX-.*\.md$/.test(f));
  for (const page of pages) for (const link of mdLinks(w.show(sha, page)))
    assert.equal(spawnSync('git', ['-C', w.memoryDir, 'cat-file', '-e', `${sha}:${link}`]).status, 0, `${page} links ${link} missing in ${sha}`);
  return pages;
}

// E-T7 paths: directory, glob, .git, .sessions, lock and junction-out paths are refused; a mixed batch claims nothing.
test('E-T7 claim keys refuse directories, globs, git, ledger, lock and junction-out paths; a mixed batch claims nothing', t => {
  const w = world(t, {hook: false, remote: false});
  const outside = path.join(w.root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'x.md'), 'outside\n');
  junction(outside, path.join(w.memoryDir, 'out'));
  fs.mkdirSync(path.join(w.memoryDir, 'handovers'), {recursive: true});
  for (const bad of ['handovers', 'handovers/', 'lesson-*.md', 'topic-?.md', ':(glob)*.md', '.git/config', '.sessions/0123456789012345.json', '.memory.lock', '.memory.lock.push', 'out/x.md', '../outside/x.md', 'out'])
    assert.throws(() => session.claimKey(w.memoryDir, bad), /claim refused/, bad);
  assert.throws(() => w.claim(w.S1, ['topic-alpha.md', 'lesson-*.md']), /nothing claimed/);
  assert.equal(w.ledger(w.S1), null, 'a refused batch writes no ledger');
  const result = w.claim(w.S1, ['topic-alpha.md', 'new-file.md']);
  assert.deepEqual(result.claimed, ['topic-alpha.md', 'new-file.md']);
});

test('E-T7 persisted claims and ledger paths are re-validated on every read, write, rename and delete', t => {
  const w = world(t, {hook: false, remote: false});
  w.claim(w.S1, ['topic-alpha.md']);
  const id = session.sessionOf(w.S1.repo).id, file = path.join(w.memoryDir, '.sessions', id + '.json');
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  ledger.claims['../outside.md'] = {since: new Date().toISOString(), by: 'edited', headAtClaim: null};
  fs.writeFileSync(file, JSON.stringify(ledger));
  const read = session.readLedgers(w.memoryDir).find(l => l.id === id);
  assert.equal(read.state, 'malformed');
  assert.match(read.problems.join('\n'), /claim refused: \.\.\/outside\.md/);
  assert.ok(!Object.hasOwn(read.claims, '../outside.md'), 'the outside claim is never used');
  assert.throws(() => w.claim(w.S1, ['topic-beta.md']), /malformed/);
  assert.match(session.listSessions({memoryDir: w.memoryDir, repo: w.S2.repo}).text, /malformed: \.sessions\//);
  // A .sessions junction and a .sessions/stale junction are refused before any ledger read or write.
  const outside = path.join(w.root, 'outside-ledgers'); fs.mkdirSync(outside);
  fs.rmSync(path.join(w.memoryDir, '.sessions'), {recursive: true});
  junction(outside, path.join(w.memoryDir, '.sessions'));
  assert.throws(() => w.claim(w.S2, ['topic-beta.md']), /\.sessions refused/);
  assert.throws(() => session.readLedgers(w.memoryDir), /\.sessions refused/);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was written through the junction');
  unlink(path.join(w.memoryDir, '.sessions'));
  fs.mkdirSync(path.join(w.memoryDir, '.sessions'));
  junction(outside, path.join(w.memoryDir, '.sessions', 'stale'));
  w.claim(w.S2, ['topic-beta.md']);
  w.git(w.project, 'worktree', 'remove', '--force', w.S2.repo);
  assert.throws(() => session.pruneLedgers({memoryDir: w.memoryDir, apply: true}), /\.sessions\/stale refused/);
  unlink(path.join(w.memoryDir, '.sessions', 'stale'));
  // A ledger, a ledger temp file or a generated output that is a junction or points out of memory is refused.
  const s2id = session.sessionOf(w.S1.repo).id;
  const ledgerFile = path.join(w.memoryDir, '.sessions', s2id + '.json');
  fs.rmSync(ledgerFile, {force: true}); junction(outside, ledgerFile);
  assert.throws(() => w.claim(w.S1, ['topic-beta.md']), /not a regular file/);
  assert.equal(session.readLedgers(w.memoryDir).find(l => l.id === s2id).state, 'unreadable');
  assert.throws(() => session.checkedFile(w.memoryDir, ledgerFile, 'ledger temp'), /ledger temp refused/);
  const page = path.join(w.memoryDir, 'INDEX-ops-all.md'); fs.rmSync(page); junction(outside, page);
  assert.throws(() => session.checkedFile(w.memoryDir, page, 'generated output'), /generated output refused/);
  assert.throws(() => session.checkedFile(w.memoryDir, path.join(w.memoryDir, 'out-of-memory', '..', '..', 'x.md'), 'generated output'), /resolves outside memory/);
});

test('E-T7 a file name with pathspec metacharacters is resolved literally by every git call, claim resolution included', t => {
  const w = world(t, {hook: false, remote: false});
  w.write('[a].md', topic('[a]')); w.write('a.md', topic('a'));
  w.git(w.memoryDir, 'add', '--', '[a].md', 'a.md'); w.git(w.memoryDir, 'commit', '-q', '-m', 'two files');
  w.claim(w.S1, ['[a].md']);
  w.write('[a].md', topic('[a]') + 'edited\n');
  w.write('a.md', topic('a') + 'edited\n');
  w.git(w.memoryDir, 'add', '--', 'a.md'); w.git(w.memoryDir, 'commit', '-q', '-m', 'only a.md');
  const own = session.ownLedger(w.memoryDir, session.sessionOf(w.S1.repo));
  assert.equal(session.claimResolved(w.memoryDir, '[a].md', own.claims['[a].md']), false, 'a commit of a.md never resolves [a].md');
  assert.throws(() => w.claim(w.S2, ['[a].md']), /claimed by/);
  w.claim(w.S2, ['a.md']);
});

// E-T2b claims of new files and reservations.
test('E-T2b a new lesson and a clean reservation stay live until committed or released', t => {
  const w = world(t, {hook: false, remote: false});
  const lesson = w.newLesson(w.S1, 'Reserved lesson', {fill: false});
  assert.ok(w.ledger(w.S1).claims[lesson], 'memory-lesson new claims its file in session mode');
  const list = session.listSessions({memoryDir: w.memoryDir, repo: w.S2.repo}).text;
  assert.match(list, new RegExp(`claim: ${lesson.replace(/[.]/g, '\\.')}`));
  assert.equal(session.foreignClaims(w.memoryDir, session.sessionOf(w.S2.repo).id).has(lesson), true, 'untracked lesson is unresolved');
  w.claim(w.S1, ['topic-alpha.md']);
  assert.throws(() => w.claim(w.S2, ['topic-alpha.md']), /claim refused: topic-alpha\.md is claimed by .* on b1/);
  assert.equal(session.foreignClaims(w.memoryDir, session.sessionOf(w.S2.repo).id).has('topic-alpha.md'), true, 'a clean reservation is live');
  session.releaseFiles({memoryDir: w.memoryDir, repo: w.S1.repo, files: ['topic-alpha.md']});
  w.claim(w.S2, ['topic-alpha.md']);
  assert.ok(fs.existsSync(path.join(w.memoryDir, lesson)), 'release never touches the file');
});

// E-T8 ledger life.
test('E-T8 resolution after commit under CRLF working files with LF in git; staged-but-uncommitted keeps the claim', t => {
  const w = world(t, {hook: false, remote: false});
  w.write('.gitattributes', 'crlf.md text\n');
  w.git(w.memoryDir, 'add', '.gitattributes'); w.git(w.memoryDir, 'commit', '-q', '-m', 'attributes');
  w.claim(w.S1, ['crlf.md']);
  w.write('crlf.md', topic('crlf').replace(/\n/g, '\r\n'));
  w.git(w.memoryDir, 'add', 'crlf.md');
  const id = session.sessionOf(w.S1.repo).id;
  const live = () => session.foreignClaims(w.memoryDir, session.sessionOf(w.S2.repo).id).has('crlf.md');
  assert.equal(live(), true, 'staged but uncommitted keeps the claim');
  w.git(w.memoryDir, 'commit', '-q', '-m', 'crlf');
  assert.equal(w.git(w.memoryDir, 'show', 'HEAD:crlf.md').includes('\r'), false, 'git holds LF');
  assert.ok(fs.readFileSync(path.join(w.memoryDir, 'crlf.md'), 'utf8').includes('\r\n'), 'the working file keeps CRLF');
  assert.equal(live(), false, 'committed: resolved by path-aware normalisation');
  assert.ok(id);
});

test('E-T8 stale and malformed ledgers in list; malformed blocks contention; a crash between commit and ledger update recovers', t => {
  const w = world(t, {hook: false, remote: false});
  w.claim(w.S2, ['topic-beta.md']);
  w.git(w.project, 'worktree', 'add', '-q', '-b', 'b3', path.join(w.root, 'b3'));
  w.claim({repo: path.join(w.root, 'b3'), memoryDir: w.memoryDir}, ['gone.md']);
  w.git(w.project, 'worktree', 'remove', '--force', path.join(w.root, 'b3'));
  w.git(w.S2.repo, 'checkout', '-q', '-b', 'b2-other');
  fs.writeFileSync(path.join(w.memoryDir, '.sessions', '0123456789012345.json'), '{not json');
  const s1 = session.sessionOf(w.S1.repo);
  const copy = JSON.parse(fs.readFileSync(path.join(w.memoryDir, '.sessions', session.sessionId(fs.realpathSync.native(w.S2.repo), 'b2') + '.json'), 'utf8'));
  copy.claims = {'topic-alpha.md': {since: new Date().toISOString(), by: 'test', headAtClaim: session.memoryHead(w.memoryDir)}};
  fs.writeFileSync(path.join(w.memoryDir, '.sessions', '9876543210987654.json'), JSON.stringify(copy));
  const list = session.listSessions({memoryDir: w.memoryDir, repo: w.S1.repo}).text;
  assert.match(list, /stale: .*checkout removed/);
  assert.match(list, /stale: .*checkout is on b2-other/);
  assert.match(list, /unreadable: \.sessions\/0123456789012345\.json: not valid JSON/);
  assert.match(list, /malformed: \.sessions\/9876543210987654\.json.*does not match/);
  // Unreadable ownership cannot be established, so claims refuse until it is repaired.
  assert.throws(() => w.claim(w.S1, ['topic-beta.md']), /ledger \.sessions\/0123456789012345\.json is unreadable/);
  fs.unlinkSync(path.join(w.memoryDir, '.sessions', '0123456789012345.json'));
  assert.throws(() => w.claim(w.S1, ['topic-alpha.md']), /claim refused: topic-alpha\.md/, 'a malformed ledger blocks contention');
  w.claim(w.S1, ['topic-beta.md'], {}); // a stale ledger never blocks
  assert.equal(session.pruneLedgers({memoryDir: w.memoryDir}).stale.length, 2);
  // Crash between commit and ledger update: the claim is committed by git, the ledger still lists it.
  w.write('topic-beta.md', topic('topic-beta') + 'edited\n');
  w.git(w.memoryDir, 'add', 'topic-beta.md'); w.git(w.memoryDir, 'commit', '-q', '-m', 'committed before the ledger update');
  assert.ok(w.ledger(w.S1).claims['topic-beta.md'], 'ledger not yet updated');
  assert.equal(session.foreignClaims(w.memoryDir, 'ffffffffffffffff').has('topic-beta.md'), false, 'others already see it resolved');
  w.claim(w.S1, ['next.md']);
  assert.equal(w.ledger(w.S1).claims['topic-beta.md'], undefined, 'the next call drops the resolved claim');
  assert.equal(s1.branch, 'b1');
  assert.equal(session.pruneLedgers({memoryDir: w.memoryDir, apply: true}).moved, 2);
  assert.equal(fs.readdirSync(path.join(w.memoryDir, '.sessions', 'stale')).length, 2);
});

test('E2.1 detached HEAD refuses session identity', t => {
  const w = world(t, {hook: false, remote: false});
  w.git(w.S1.repo, 'checkout', '-q', '--detach');
  assert.throws(() => session.sessionOf(w.S1.repo), /checkpoint: --session needs a branch \(detached HEAD in /);
});

// E-T1 unfinished foreign lesson.
test('E-T1 a foreign unfinished lesson and foreign unclaimed edits neither enter nor shape this session\'s save', t => {
  const w = world(t);
  const foreign = w.newLesson(w.S2, 'Foreign unfinished', {fill: false});
  const foreignBytes = fs.readFileSync(path.join(w.memoryDir, foreign));
  w.write('MEMORY.md', w.read('MEMORY.md').replace('## Active work', '- [Extra](INDEX-extra.md) OPEN BEFORE extra work.\n\n## Active work'));
  w.write('topic-beta.md', w.read('topic-beta.md').replace('topic-beta notes kept for the fixture.', 'CHANGED BY S2'));
  const own = w.newLesson(w.S1, 'Own finished');
  const result = w.save(w.S1);
  assert.equal(result.status, 0, result.error ?? JSON.stringify(result.exceptions));
  assert.deepEqual(gateFails(result), []);
  assert.deepEqual(w.committed(result.sha), ['INDEX-craft-all.md', 'INDEX-craft.md', own].sort());
  for (const page of ['INDEX-craft.md', 'INDEX-craft-all.md']) {
    const text = w.show(result.sha, page);
    assert.ok(text.includes(own) && !text.includes(foreign), page);
    assert.ok(text.includes('topic-beta notes kept for the fixture.') && !text.includes('CHANGED BY S2'), page + ' is not shaped by the foreign topic edit');
  }
  assert.ok(!w.tracked().includes('INDEX-extra.md'), 'the foreign router row shapes no page');
  assert.ok(!fs.existsSync(path.join(w.memoryDir, 'INDEX-extra.md')));
  assert.deepEqual(fs.readFileSync(path.join(w.memoryDir, foreign)), foreignBytes);
  assert.equal(w.git(w.memoryDir, 'status', '--porcelain', '--', foreign), `?? ${foreign}`);
  assert.match(w.read('MEMORY.md'), /INDEX-extra/); assert.match(w.read('topic-beta.md'), /CHANGED BY S2/);
  assert.ok(result.exceptions.some(e => e.kind === 'unclaimed' && e.file === 'MEMORY.md'));
  assert.ok(w.lines.some(line => /unclaimed: 2 changed memory files \(not this session's\); see memory-session list/.test(line)), w.lines.join('\n'));
  assert.equal(result.publication.verified, true); assert.equal(w.remoteHead(), result.sha);
});

// E-T2 foreign staged changes and the generated-output exception.
test('E-T2 foreign staged blobs, modes and working bytes survive; a marked staged page is replaced and reported', t => {
  const w = world(t, {topics: ['alpha', 'beta', 'gamma', 'delta']});
  w.write('topic-alpha.md', topic('topic-alpha') + 'staged by S2\n');
  w.write('new-s2.md', topic('new-s2'));
  w.git(w.memoryDir, 'add', 'topic-alpha.md', 'new-s2.md'); w.git(w.memoryDir, 'rm', '-q', 'topic-beta.md');
  w.write('topic-gamma.md', topic('topic-gamma') + 'staged version\n'); w.git(w.memoryDir, 'add', 'topic-gamma.md');
  w.write('topic-gamma.md', topic('topic-gamma') + 'working version\n');
  const watched = ['topic-alpha.md', 'new-s2.md', 'topic-beta.md', 'topic-gamma.md'];
  const stage = () => w.git(w.memoryDir, 'ls-files', '--stage', '--', ...watched);
  const bytes = () => watched.map(f => fs.existsSync(path.join(w.memoryDir, f)) ? fs.readFileSync(path.join(w.memoryDir, f)).toString('base64') : null);
  const [beforeStage, beforeBytes] = [stage(), bytes()];
  const own = w.newLesson(w.S1, 'Own lesson');
  const result = w.save(w.S1);
  assert.equal(result.status, 0, result.error);
  assert.deepEqual(w.committed(result.sha), ['INDEX-craft-all.md', 'INDEX-craft.md', own].sort());
  assert.equal(stage(), beforeStage); assert.deepEqual(bytes(), beforeBytes);
  assert.match(w.show(result.sha, 'INDEX-craft.md'), /topic-beta/, 'the foreign deletion does not shape the page');
  // A marked generated page staged by S2 is replaced and reported.
  w.write('INDEX-ops.md', w.read('INDEX-ops.md') + 'staged by S2\n'); w.git(w.memoryDir, 'add', 'INDEX-ops.md');
  const second = w.newLesson(w.S1, 'Second own lesson');
  const replaced = w.save(w.S1);
  assert.equal(replaced.status, 0, replaced.error);
  assert.ok(replaced.exceptions.some(e => e.kind === 'replaced-staged-generated' && e.file === 'INDEX-ops.md'));
  assert.ok(w.lines.some(line => /replaced staged generated page INDEX-ops\.md/.test(line)));
  assert.ok(w.committed(replaced.sha).includes(second));
  // An unmarked staged version at a generated path is refused, and nothing is committed.
  const head = w.head();
  w.write('INDEX-craft.md', '# hand-written craft index\n'); w.git(w.memoryDir, 'add', 'INDEX-craft.md');
  w.write('INDEX-craft.md', w.show('HEAD', 'INDEX-craft.md') + '\n');
  w.newLesson(w.S1, 'Third own lesson');
  const refused = w.save(w.S1);
  assert.equal(refused.status, 1); assert.match(refused.error, /refusing to overwrite INDEX-craft\.md \(staged version is not generated\)/);
  assert.equal(w.head(), head);
});

// E-T2c candidate materialisation.
test('E-T2c the candidate matches checkout-index bytes; export attributes neither omit nor substitute', t => {
  const w = world(t, {hook: false});
  const filters = path.join(w.root, 'filters'); fs.mkdirSync(filters);
  fs.writeFileSync(path.join(filters, 'smudge.cjs'), "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d.replace(/stored/g,'SMUDGED')));\n");
  fs.writeFileSync(path.join(filters, 'clean.cjs'), "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d.replace(/SMUDGED/g,'stored')));\n");
  const q = file => `"${process.execPath.replace(/\\/g, '/')}" "${path.join(filters, file).replace(/\\/g, '/')}"`;
  w.git(w.memoryDir, 'config', 'filter.up.smudge', q('smudge.cjs')); w.git(w.memoryDir, 'config', 'filter.up.clean', q('clean.cjs'));
  w.write('.gitattributes', 'exp-ignore.md export-ignore\nexp-subst.md export-subst\ncrlf-edge.md text eol=crlf\nfiltered.md filter=up\n');
  w.write('exp-ignore.md', topic('exp-ignore')); w.write('exp-subst.md', topic('exp-subst') + '$Format:%H$\n');
  const edge = topic('crlf-edge'); w.write('crlf-edge.md', edge + 'x'.repeat(8192 - Buffer.byteLength(edge) - 1) + '\n');
  w.write('filtered.md', topic('filtered') + 'SMUDGED words\n');
  w.git(w.memoryDir, 'add', '.'); w.git(w.memoryDir, 'commit', '-q', '-m', 'attributes');
  w.claim(w.S1, ['crlf-edge.md', 'filtered.md']);
  fs.writeFileSync(path.join(w.memoryDir, 'crlf-edge.md'), fs.readFileSync(path.join(w.memoryDir, 'crlf-edge.md'), 'utf8').replace('Body', 'Edited body'));
  w.write('filtered.md', topic('filtered') + 'SMUDGED words, edited\n');
  const candidate = cp.materialiseCandidate({memoryDir: w.memoryDir, repo: w.S1.repo, own: ['crlf-edge.md', 'filtered.md']});
  t.after(() => candidate.cleanup());
  // The hook's representation: the same files staged into a fresh index from H, extracted by checkout-index.
  const index = path.join(w.root, 'hook.index'), out = path.join(w.root, 'hook-out') + '/';
  const env = {...process.env, GIT_INDEX_FILE: index};
  for (const argv of [['read-tree', 'HEAD'], ['add', '--', 'crlf-edge.md', 'filtered.md'], ['checkout-index', '-a', '--prefix=' + out.replace(/\\/g, '/')]])
    assert.equal(spawnSync('git', ['-C', w.memoryDir, ...argv], {env}).status, 0, argv.join(' '));
  for (const file of ['exp-ignore.md', 'exp-subst.md', 'crlf-edge.md', 'filtered.md', 'MEMORY.md', 'topic-alpha.md'])
    assert.deepEqual(fs.readFileSync(path.join(candidate.dir, file)), fs.readFileSync(path.join(out, file)), file);
  assert.match(fs.readFileSync(path.join(candidate.dir, 'exp-subst.md'), 'utf8'), /\$Format:%H\$/);
  assert.ok(fs.readFileSync(path.join(candidate.dir, 'crlf-edge.md'), 'utf8').includes('Edited body'));
  assert.ok(fs.readFileSync(path.join(candidate.dir, 'crlf-edge.md'), 'utf8').includes('\r\n'));
  assert.match(fs.readFileSync(path.join(candidate.dir, 'filtered.md'), 'utf8'), /SMUDGED words, edited/);
});

test('E-T2c in-repo memory: an unrelated staged brain addition does not satisfy a link; the file in H does', t => {
  // With the project's real in-repo pre-commit hook.
  const w = world(t, {inRepo: true, remote: false});
  assert.match(fs.readFileSync(w.hookPath(), 'utf8'), /memory-check\.mjs --hook/);
  const s = w.S1;
  w.claim(s, ['MEMORY.md']);
  w.write('MEMORY.md', w.read('MEMORY.md', s).replace('## Active work', '## Archive\n- [Brain x](../brain/x.md) background.\n\n## Active work'), s);
  w.put(path.join(s.repo, 'brain/x.md'), '# x\n'); w.git(s.repo, 'add', 'brain/x.md');
  const blocked = w.save(s, {commit: true});
  assert.equal(blocked.status, 1);
  assert.ok(gateFails(blocked).includes('link.dead MEMORY.md'), JSON.stringify(blocked.gate));
  w.git(s.repo, 'commit', '-q', '-m', 'brain x', '--', 'brain/x.md');
  const saved = w.save(s, {commit: true});
  assert.equal(saved.status, 0, saved.error ?? JSON.stringify(saved.gate?.fails));
  assert.deepEqual(w.committed(saved.sha, s), ['MEMORY.md']);
});

// E-T3 shared-index regeneration.
test('E-T3 two sessions save in turn; each commit\'s pages resolve in its own tree and an obsolete catalog leaves with the commit that obsoletes it', t => {
  // With the real pre-commit hook, which reads the same (saved) config.
  const w = world(t, {topics: ['alpha', 'beta', 'gamma', 'delta']});
  const big = structuredClone(w.config); big.caps.index.failBytesAbsolute = 100000;
  const probe = path.join(w.root, 'probe'); fs.cpSync(w.memoryDir, probe, {recursive: true, filter: src => !src.includes('.git')});
  writeMemoryIndex({memoryDir: probe, config: big});
  w.config.caps.index.failBytesAbsolute = Buffer.byteLength(fs.readFileSync(path.join(probe, 'INDEX-craft-all.md'))) + Buffer.byteLength('[Next](INDEX-craft-all-2.md)\n') + 40;
  w.saveConfig(); assert.ok(fs.existsSync(w.hookPath()));
  const l1 = w.newLesson(w.S1, 'S1 lesson');
  const l2 = w.newLesson(w.S2, 'S2 lesson', {route: 'ops'});
  w.claim(w.S2, ['topic-beta.md']); fs.unlinkSync(path.join(w.memoryDir, 'topic-beta.md'));
  w.write('MEMORY.md', w.read('MEMORY.md') + '\nS2 router note.\n');
  const first = w.save(w.S1);
  assert.equal(first.status, 0, first.error ?? JSON.stringify(first.gate?.fails));
  assert.ok(w.committed(first.sha).includes('INDEX-craft-all-2.md'));
  assert.ok(!w.committed(first.sha).includes(l2));
  const pages1 = linksResolve(w, first.sha);
  for (const page of pages1) assert.ok(!w.show(first.sha, page).includes(l2), page);
  assert.ok(w.show(first.sha, 'INDEX-craft.md').includes('topic-beta'), 'S2\'s deletion is not reflected');
  const second = w.save(w.S2);
  assert.equal(second.status, 0, second.error ?? JSON.stringify(second.gate?.fails));
  const files = w.committed(second.sha);
  assert.ok(files.includes(l2) && files.includes('topic-beta.md') && files.includes('INDEX-craft-all-2.md'), files.join(', '));
  assert.ok(!w.tracked().includes('INDEX-craft-all-2.md'), 'the obsolete catalog is removed in the commit that obsoletes it');
  assert.ok(!files.includes('MEMORY.md'), 'the unclaimed router change is not committed');
  linksResolve(w, second.sha);
  assert.ok(w.show(second.sha, 'INDEX-craft.md').includes(l1));
});

// E-T4 same-file contention.
test('E-T4 checkpoint contention: excluded, status 3, reconciled --take, then the foreign claim resolves', t => {
  const w = world(t);
  w.claim(w.S1, ['topic-alpha.md']);
  assert.throws(() => w.claim(w.S2, ['topic-alpha.md']), /claim refused/, 'cooperative refusal');
  // Pre-existing conflicting ownership: a second live ledger holding the same path.
  const s2 = session.sessionOf(w.S2.repo);
  fs.writeFileSync(path.join(w.memoryDir, '.sessions', s2.id + '.json'), JSON.stringify({version: 1, id: s2.id, checkout: s2.checkout, branch: s2.branch, updated: new Date().toISOString(), claims: {'topic-alpha.md': {since: '2026-11-12T08:00:00.000Z', by: 'test', headAtClaim: session.memoryHead(w.memoryDir)}}}));
  w.write('topic-alpha.md', topic('topic-alpha') + 'edited by S1\n');
  const own = w.newLesson(w.S1, 'Own lesson');
  const result = w.save(w.S1);
  assert.equal(result.status, 3);
  assert.ok(!w.committed(result.sha).includes('topic-alpha.md') && w.committed(result.sha).includes(own));
  assert.ok(w.lines.some(line => line.includes(`contended: topic-alpha.md (also claimed by ${s2.checkout} on b2 since 2026-11-12T08:00:00.000Z)`)), w.lines.join('\n'));
  assert.deepEqual(result.exceptions.filter(e => e.kind === 'contended').map(e => e.file), ['topic-alpha.md']);
  w.lines.length = 0;
  const only = w.save(w.S1);
  assert.equal(only.status, 3);
  assert.ok(w.lines.some(line => /nothing committed: every selected file is contended/.test(line)), w.lines.join('\n'));
  const taken = w.save(w.S1, {take: ['topic-alpha.md']});
  assert.equal(taken.status, 0, taken.error);
  assert.ok(w.committed(taken.sha).includes('topic-alpha.md'));
  assert.ok(w.lines.some(line => line.includes(`took topic-alpha.md over the claim of ${s2.checkout} on b2`)), w.lines.join('\n'));
  assert.equal(session.foreignClaims(w.memoryDir, session.sessionOf(w.S1.repo).id).has('topic-alpha.md'), false, 'the foreign claim resolves once its bytes equal HEAD');
});

// E-T6 restoration.
test('E-T6 failures in generation, the gate and the pre-commit hook restore working files and index entries', t => {
  const w = world(t);
  w.write('INDEX-ops.md', w.read('INDEX-ops.md') + 'stale\n'); w.git(w.memoryDir, 'add', 'INDEX-ops.md');
  const own = w.newLesson(w.S1, 'Own lesson');
  const before = () => [w.snapshot(), w.indexEntries()];
  const [files0, index0] = before();
  const generation = w.save(w.S1, {faults: {afterPageWrite() { throw new Error('injected generation failure'); }}});
  assert.equal(generation.status, 1); assert.match(generation.error, /injected generation failure/);
  assert.deepEqual(w.snapshot(), files0); assert.equal(w.indexEntries(), index0);
  const gate = w.save(w.S1, {faults: {beforeGate() { fs.appendFileSync(path.join(w.memoryDir, 'INDEX-craft.md'), 'changed again\n'); throw new Error('injected gate failure'); }}});
  assert.equal(gate.status, 1);
  assert.match(fs.readFileSync(path.join(w.memoryDir, 'INDEX-craft.md'), 'utf8'), /changed again/, 'a page changed again after this run wrote it is kept');
  assert.ok(w.lines.some(line => /kept INDEX-craft\.md \(changed after this run wrote it\)/.test(line)), w.lines.join('\n'));
  w.git(w.memoryDir, 'checkout', '--', 'INDEX-craft.md');
  const [files1, index1] = before();
  const unfilled = w.newLesson(w.S1, 'Unfilled own lesson', {fill: false});
  const gated = w.save(w.S1);
  assert.equal(gated.status, 1); assert.ok(gateFails(gated).includes(`lesson.unfilled ${unfilled}`));
  fs.unlinkSync(path.join(w.memoryDir, unfilled)); session.releaseFiles({memoryDir: w.memoryDir, repo: w.S1.repo, files: [unfilled]});
  assert.deepEqual(w.snapshot(), files1); assert.equal(w.indexEntries(), index1);
  const hook = path.join(w.memoryDir, '.git/hooks/pre-commit'), original = fs.readFileSync(hook, 'utf8');
  fs.writeFileSync(hook, '#!/bin/sh\necho injected hook failure\nexit 1\n');
  const hooked = w.save(w.S1);
  assert.equal(hooked.status, 1); assert.match(hooked.error, /injected hook failure/);
  assert.deepEqual(w.snapshot(), files1); assert.equal(w.indexEntries(), index1);
  fs.writeFileSync(hook, original);
  const saved = w.save(w.S1);
  assert.equal(saved.status, 0, saved.error); assert.ok(w.committed(saved.sha).includes(own));
});

// E-T7 a generated output that is a junction is refused by the checkpoint.
test('E-T7 a generated output that is a junction is refused before any write', t => {
  const w = world(t, {hook: false});
  const outside = path.join(w.root, 'outside'); fs.mkdirSync(outside);
  fs.rmSync(path.join(w.memoryDir, 'INDEX-craft-all.md')); junction(outside, path.join(w.memoryDir, 'INDEX-craft-all.md'));
  w.newLesson(w.S1, 'Own lesson');
  const result = w.save(w.S1);
  assert.equal(result.status, 1); assert.match(result.error, /generated output refused: INDEX-craft-all\.md/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

// E-T7b git health in candidate mode.
test('E-T7b repo.ahead FAIL comes from the real holder, also when nothing is committed; repo.uncommitted names foreign work', t => {
  const w = world(t, {hook: false});
  const pending = w.newLesson(w.S2, 'Foreign pending', {fill: false});
  const warned = w.save(w.S1);
  assert.equal(warned.status, 0, warned.error);
  const uncommitted = warned.gate.warns.find(f => f.check === 'repo.uncommitted');
  assert.ok(uncommitted && uncommitted.message.includes(pending), JSON.stringify(warned.gate.warns));
  for (let i = 0; i < 10; i++) w.git(w.memoryDir, 'commit', '-q', '--allow-empty', '-m', 'local ' + i);
  const empty = w.save(w.S1, {noPush: true});
  assert.equal(empty.status, 1); assert.ok(gateFails(empty).includes('repo.ahead .'), JSON.stringify(empty.gate));
  w.newLesson(w.S1, 'Own lesson');
  const head = w.head(), blocked = w.save(w.S1, {noPush: true});
  assert.equal(blocked.status, 1); assert.ok(gateFails(blocked).includes('repo.ahead .')); assert.equal(w.head(), head);
});

// E-T9 rotation.
function rotationWorld(t) {
  const w = world(t, {hook: false});
  const repo = w.S1.repo;
  w.put(path.join(repo, 'brain/00-system/log.md'), '# Log\n\n' + Array.from({length: 25}, (_, i) => `## [2026-10-${String(i + 1).padStart(2, '0')}] op | entry ${i}\n`).join(''));
  w.put(path.join(repo, 'docs/ROADMAP.md'), '# Roadmap\n\n## Open work\n\n' + Array.from({length: 8}, (_, i) => `**2026-10-${String(20 - i).padStart(2, '0')}** block ${i}\n\n`).join(''));
  for (let i = 1; i <= 22; i++) w.write(`handovers/${String(i).padStart(6, '0')}-2026-11-01-${String(1000 + i)}.md`, `---\ntime: 2026-11-01T10:${String(i).padStart(2, '0')}:00+01:00\nbranch: "b1"\nsha: 1234567\nmode: quick\n---\n**State:** note ${i}\n`);
  w.git(w.memoryDir, 'add', '.'); w.git(w.memoryDir, 'commit', '-q', '-m', 'handovers');
  const watched = () => {
    const out = {};
    for (const f of ['brain/00-system/log.md', 'docs/ROADMAP.md', 'docs/ROADMAP-HISTORY.md', 'brain/00-system/log-2026-10.md']) out[f] = fs.existsSync(path.join(repo, f)) ? fs.readFileSync(path.join(repo, f), 'base64') : null;
    const dir = path.join(w.memoryDir, 'handovers');
    for (const f of fs.readdirSync(dir)) out['handovers/' + f] = fs.readFileSync(path.join(dir, f), 'base64');
    return out;
  };
  return {w, watched};
}
test('E-T9 --no-rotate and session mode leave the roadmap, history, log, archives and handovers byte-identical', t => {
  const {w, watched} = rotationWorld(t), before = watched();
  const all = w.save(w.S1, {session: false, noRotate: true, noPush: true});
  assert.equal(all.status, 0, all.error);
  for (const step of ['rotate-log', 'rotate-roadmap', 'rotate-handovers']) assert.ok(w.lines.includes(`${step}: skipped (--no-rotate)`), w.lines.join('\n'));
  assert.deepEqual(watched(), before);
  w.newLesson(w.S1, 'Own lesson');
  const sessionSave = w.save(w.S1, {noPush: true});
  assert.equal(sessionSave.status, 0, sessionSave.error);
  assert.deepEqual(watched(), before);
});
test('E-T9 an all-sessions run waits for other sessions\' claims, then rotates as today', t => {
  const {w, watched} = rotationWorld(t), before = watched();
  w.claim(w.S2, ['topic-beta.md']);
  const waits = w.save(w.S1, {session: false, noPush: true});
  assert.equal(waits.status, 0, waits.error);
  assert.ok(w.lines.some(line => /rotation waits: 1 files pending in other sessions/.test(line)), w.lines.join('\n'));
  assert.ok(waits.exceptions.some(e => e.kind === 'rotation-waits'));
  assert.deepEqual(watched(), before);
  session.releaseFiles({memoryDir: w.memoryDir, repo: w.S2.repo, files: ['topic-beta.md']});
  const rotated = w.save(w.S1, {session: false, noPush: true});
  assert.equal(rotated.status, 0, rotated.error);
  const after = watched();
  assert.notEqual(after['brain/00-system/log.md'], before['brain/00-system/log.md']);
  assert.ok(after['brain/00-system/log-2026-10.md']);
  assert.ok(after['docs/ROADMAP-HISTORY.md']);
  assert.ok(Object.keys(after).some(f => /handovers\/archive-2026-11\.md/.test(f)));
});

// E-T11 modes and dry run.
test('E-T11 mode all commits every pending change like 3.3.4; session mode equals --session; --all overrides', t => {
  const w = world(t, {hook: false});
  const foreign = w.newLesson(w.S2, 'Foreign lesson');
  w.write('topic-beta.md', topic('topic-beta') + 'unclaimed edit\n');
  const own = w.newLesson(w.S1, 'Own lesson');
  const viaConfig = w.save(w.S1, {session: undefined, noPush: true});
  assert.deepEqual(viaConfig.effective, {session: true, memoryOnly: false, filesOnly: false});
  assert.deepEqual(w.committed(viaConfig.sha), ['INDEX-craft-all.md', 'INDEX-craft.md', own].sort());
  const pending = spawnSync('git', ['-C', w.memoryDir, 'status', '--porcelain', '-z', '--untracked-files=all'], {encoding: 'utf8'}).stdout.split('\0').filter(Boolean).map(l => l.slice(3)).sort();
  assert.ok(pending.includes('topic-beta.md') && pending.includes(foreign), pending.join(', '));
  const overridden = w.save(w.S1, {session: undefined, all: true, noPush: true});
  assert.deepEqual(overridden.effective, {session: false, memoryOnly: false, filesOnly: false});
  const files = w.committed(overridden.sha);
  for (const file of pending) assert.ok(files.includes(file), `all mode commits ${file} like 3.3.4`);
  assert.ok(files.includes(foreign) && files.includes('topic-beta.md'));
  delete w.config.caps.checkpoint;
  w.write('topic-alpha.md', topic('topic-alpha') + 'another edit\n');
  const absent = w.save(w.S1, {session: undefined, noPush: true});
  assert.equal(absent.effective.session, false);
  assert.deepEqual(w.committed(absent.sha), ['topic-alpha.md']);
});
test('E-T11 --dry-run leaves files, ledgers, index and refs unchanged', t => {
  const w = world(t);
  w.newLesson(w.S1, 'Own lesson'); w.newLesson(w.S2, 'Foreign lesson', {fill: false});
  const before = [w.snapshot(), w.ledgers(), w.indexEntries(), w.refs()];
  const dry = w.save(w.S1, {dryRun: true});
  assert.equal(dry.status, 0, dry.error);
  assert.deepEqual([w.snapshot(), w.ledgers(), w.indexEntries(), w.refs()], before);
  assert.ok(w.lines.some(line => /would change: .*lesson-\d+-own-lesson\.md/.test(line)), w.lines.join('\n'));
});
// The all-sessions commit compared with a 3.3.4 reference run on an identical fixture.
test('E-T11 mode all commits the same tree as the 3.3.4 reference sequence on an identical fixture', t => {
  const scenario = w => {
    w.newLesson(w.S2, 'Foreign lesson'); w.newLesson(w.S1, 'Own lesson');
    w.write('topic-beta.md', topic('topic-beta') + 'unclaimed edit\n');
    w.write('MEMORY.md', w.read('MEMORY.md') + '\nRouter note.\n');
    w.write('loose.txt', 'not markdown\n');
    fs.rmSync(path.join(w.memoryDir, 'topic-alpha.md'));
  };
  const a = world(t, {mode: 'all', remote: false}), b = world(t, {mode: 'all', remote: false});
  scenario(a); scenario(b);
  const saved = a.save(a.S1, {session: undefined, noPush: true});
  assert.equal(saved.status, 0, saved.error); assert.equal(saved.effective.session, false);
  // 3.3.4 reference: regenerate the pages, then add --all with the lock exclusion and commit everything.
  writeMemoryIndex({memoryDir: b.memoryDir, config: b.config});
  b.git(b.memoryDir, 'add', '--all', '--', '.', ':(exclude,glob)**/.memory.lock*');
  b.git(b.memoryDir, 'commit', '-q', '-m', 'memory: checkpoint 2026-11-12');
  assert.equal(a.git(a.memoryDir, 'rev-parse', 'HEAD^{tree}'), b.git(b.memoryDir, 'rev-parse', 'HEAD^{tree}'));
  assert.deepEqual(a.snapshot(), b.snapshot());
});
test('E-T11 in-repo memory: the --commit path follows the same selection rules', t => {
  // With the project's real in-repo pre-commit hook.
  const w = world(t, {inRepo: true, remote: false});
  const s = w.S1;
  w.write('topic-beta.md', topic('topic-beta') + 'unclaimed edit\n', s);
  const own = w.newLesson(s, 'Own lesson');
  const result = w.save(s, {commit: true});
  assert.equal(result.status, 0, result.error ?? JSON.stringify(result.gate?.fails));
  assert.deepEqual(w.committed(result.sha, s), ['INDEX-craft-all.md', 'INDEX-craft.md', own].sort());
  assert.match(w.git(s.repo, 'status', '--porcelain'), /topic-beta\.md/);
});

// E-T12 the returned shape per status, effective values, and equality with the CLI exit status.
test('E-T12 the result shape for status 0, 1, 2 and 3 equals the CLI exit status', t => {
  const w = world(t);
  const shape = r => {
    for (const key of ['status', 'sha', 'exceptions', 'gate', 'publication', 'changed', 'effective', 'error']) assert.ok(Object.hasOwn(r, key), key);
    assert.deepEqual(Object.keys(r.publication).sort(), ['error', 'pushed', 'sha', 'verified']);
    assert.deepEqual(Object.keys(r.changed).sort(), ['memory', 'repo']);
    assert.deepEqual(r.effective, {session: true, memoryOnly: false, filesOnly: false});
  };
  const own = w.newLesson(w.S1, 'Own lesson');
  const ok = w.save(w.S1); shape(ok);
  assert.equal(ok.status, 0); assert.equal(ok.error, null); assert.match(ok.sha, /^[0-9a-f]{40}$/);
  assert.deepEqual(ok.gate.fails, []); assert.ok(ok.gate.evaluated.includes('repo.ahead') && ok.gate.evaluated.includes('lesson.unfilled'));
  assert.ok(ok.changed.memory.includes('INDEX-craft.md'));
  assert.ok(!ok.changed.memory.includes(own), 'the lesson bytes were not changed by this invocation');
  assert.equal(w.cli(w.S1, ['--session']).status, 0);
  const early = w.save(w.S1, {today: 'not-a-date'}); shape(early);
  assert.equal(early.status, 1); assert.equal(early.gate, null); assert.match(early.error, /invalid --today/);
  assert.equal(w.cli(w.S1, ['--session', '--today', 'bad']).status, 1);
  w.newLesson(w.S1, 'After commit');
  const late = w.save(w.S1, {faults: {afterCommit() { throw new Error('injected after commit'); }}}); shape(late);
  assert.equal(late.status, 1); assert.match(late.sha, /^[0-9a-f]{40}$/); assert.equal(w.head(), late.sha);
  assert.match(late.error, /injected after commit/); assert.ok(late.changed.memory.length);
  fs.renameSync(w.bare, w.bare + '.away');
  w.newLesson(w.S1, 'Unpublished');
  const unpublished = w.save(w.S1); shape(unpublished);
  assert.equal(unpublished.status, 2); assert.equal(unpublished.publication.verified, false); assert.ok(unpublished.publication.error);
  assert.equal(w.cli(w.S1, ['--session']).status, 2);
  fs.renameSync(w.bare + '.away', w.bare);
  w.claim(w.S1, ['topic-alpha.md']);
  const s2 = session.sessionOf(w.S2.repo);
  fs.writeFileSync(path.join(w.memoryDir, '.sessions', s2.id + '.json'), JSON.stringify({version: 1, id: s2.id, checkout: s2.checkout, branch: s2.branch, updated: new Date().toISOString(), claims: {'topic-alpha.md': {since: new Date().toISOString(), by: 'test', headAtClaim: session.memoryHead(w.memoryDir)}}}));
  w.write('topic-alpha.md', topic('topic-alpha') + 'contended\n');
  const contended = w.save(w.S1); shape(contended);
  assert.equal(contended.status, 3);
  assert.equal(w.cli(w.S1, ['--session']).status, 3);
});

// E-T13 publication-only retry.
test('E-T13 a commit left unpublished is published by a later empty-selection save, verified against the remote', t => {
  const w = world(t);
  w.newLesson(w.S1, 'Own lesson');
  fs.renameSync(w.bare, w.bare + '.away');
  const failed = w.save(w.S1);
  assert.equal(failed.status, 2);
  w.git(w.memoryDir, 'update-ref', 'refs/remotes/origin/main', failed.sha);
  const stale = w.save(w.S1);
  assert.equal(stale.status, 2, 'a stale tracking ref is never evidence'); assert.equal(stale.publication.verified, false);
  fs.renameSync(w.bare + '.away', w.bare);
  let later;
  const retry = w.save(w.S1, {faults: {beforePublish() { w.git(w.memoryDir, 'commit', '-q', '--allow-empty', '-m', 'concurrent local commit'); later = w.head(); }}});
  assert.equal(retry.status, 0, retry.error ?? retry.publication.error);
  assert.equal(retry.sha, failed.sha); assert.equal(retry.publication.sha, failed.sha); assert.equal(retry.publication.verified, true);
  assert.notEqual(later, retry.sha, 'the later HEAD is never the evidence');
  assert.equal(spawnSync('git', ['-C', w.memoryDir, 'merge-base', '--is-ancestor', failed.sha, w.remoteHead()]).status, 0);
});

// E-T14 read-only candidate gate.
test('E-T14 --session --dry-run returns a gate with a foreign unfinished lesson present and changes nothing', t => {
  const w = world(t);
  w.newLesson(w.S2, 'Foreign unfinished', {fill: false});
  w.newLesson(w.S1, 'Own lesson');
  const before = [w.snapshot(), w.ledgers(), w.indexEntries(), w.refs()];
  const dry = w.save(w.S1, {dryRun: true});
  assert.equal(dry.status, 0, dry.error);
  assert.deepEqual(gateFails(dry), []); assert.ok(dry.gate.evaluated.length);
  assert.deepEqual([w.snapshot(), w.ledgers(), w.indexEntries(), w.refs()], before);
  assert.equal(w.save(w.S1).status, 0);
});

// E-T15 planned outputs with expected fingerprints.
test('E-T15 a dry run plans the exact bytes the real run writes', t => {
  const w = world(t);
  const repo = w.S1.repo;
  w.put(path.join(repo, 'brain/00-system/log.md'), '# Log\n\n## [2026-11-12] op | one\n');
  w.put(path.join(repo, 'brain/02-projects/prj-one.md'), '---\nid: prj-one\ntype: project\nsummary: One project.\n---\n');
  w.newLesson(w.S1, 'Own lesson');
  const dry = w.save(w.S1, {dryRun: true});
  assert.equal(dry.status, 0, dry.error);
  assert.ok(dry.planned.memory.some(p => p.path === 'INDEX-craft.md' && p.action === 'write'));
  assert.ok(dry.planned.repo.some(p => p.path === w.config.caps.brainIndex.path));
  const real = w.save(w.S1);
  assert.equal(real.status, 0, real.error);
  for (const p of dry.planned.memory) assert.equal(p.action === 'delete' ? null : sha256(fs.readFileSync(path.join(w.memoryDir, p.path))), p.sha256, p.path);
  for (const p of dry.planned.repo) assert.equal(sha256(fs.readFileSync(path.join(repo, p.path))), p.sha256, p.path);
});

// E-T16 memory-only checkpoint.
test('E-T16 --memory-only runs no repo writer, defers stale repo outputs and keeps the memory commit and publication', t => {
  const w = world(t);
  const repo = w.S1.repo, old = new Date('2026-01-01T00:00:00Z');
  w.put(path.join(repo, 'brain/00-system/log.md'), '# Log\n\n## [2026-11-12] op | one\n');
  w.put(path.join(repo, 'brain/02-projects/prj-one.md'), '---\nid: prj-one\ntype: project\nsummary: One project.\n---\n');
  assert.equal(w.save(w.S1, {noPush: true}).status, 0, 'repo outputs written fresh by a normal save');
  const outputs = [w.config.caps.brainIndex.path, w.config.caps.brainIndex.allPath, w.config.caps.roadmapOverview.path];
  for (const f of outputs) fs.utimesSync(path.join(repo, f), old, old);
  const repoState = () => [outputs.map(f => [fs.readFileSync(path.join(repo, f), 'base64'), fs.statSync(path.join(repo, f)).mtimeMs]), w.git(repo, 'ls-files', '--stage'), w.git(repo, 'rev-parse', 'HEAD'), w.git(repo, 'for-each-ref')];
  const inRepo = world(t, {inRepo: true, hook: false, remote: false});
  // A spy on every file-system writer; nothing under the project checkout may be written.
  const realRepo = fs.realpathSync.native(repo).toLowerCase(), writes = [], mocks = [];
  const under = p => typeof p === 'string' && path.resolve(p).toLowerCase().startsWith(realRepo + path.sep);
  // openSync counts only when it opens for writing (readFileSync opens through it for reading); fd writers need such an open.
  const writing = flags => typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0 : /[wa+]/.test(String(flags ?? 'r'));
  for (const name of ['writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'mkdirSync', 'copyFileSync', 'cpSync', 'utimesSync', 'truncateSync', 'symlinkSync', 'linkSync', 'openSync']) {
    const original = fs[name];
    mocks.push(t.mock.method(fs, name, function (target, ...rest) { if ((name !== 'openSync' || writing(rest[0])) && (under(target) || ((name === 'renameSync' || name === 'copyFileSync' || name === 'cpSync' || name === 'symlinkSync' || name === 'linkSync') && under(rest[0])))) writes.push(`${name} ${target}`); return original.call(this, target, ...rest); }));
  }
  t.after(() => mocks.forEach(m => m.mock.restore()));
  const before = repoState();
  w.newLesson(w.S1, 'Fresh outputs');
  const fresh = w.save(w.S1, {memoryOnly: true});
  assert.deepEqual(writes, [], 'no repo writer ran');
  assert.equal(fresh.status, 0, fresh.error);
  assert.deepEqual(fresh.effective, {session: true, memoryOnly: true, filesOnly: false});
  assert.deepEqual(fresh.changed.repo, []); assert.deepEqual(fresh.deferred.repo, []);
  assert.deepEqual(repoState(), before, 'no repo writer ran, not even an identical rewrite');
  assert.equal(fresh.publication.verified, true);
  w.put(path.join(repo, 'brain/02-projects/prj-two.md'), '---\nid: prj-two\ntype: project\nsummary: Two.\n---\n');
  fs.appendFileSync(path.join(repo, 'docs/ROADMAP.md'), '\n### Next\n- a third item\n');
  w.newLesson(w.S1, 'Stale outputs');
  const before2 = repoState();
  const dry = w.save(w.S1, {memoryOnly: true, dryRun: true});
  assert.deepEqual(dry.planned.repo, []);
  assert.deepEqual([...dry.deferred.repo].sort(), [w.config.caps.brainIndex.path, w.config.caps.brainIndex.allPath, w.config.caps.roadmapOverview.path].sort());
  w.put(path.join(repo, 'brain/02-projects/prj-three.md'), '---\nid: prj-three\ntype: project\nsummary: Three.\n---\n');
  writes.length = 0;
  const stale = w.save(w.S1, {memoryOnly: true});
  assert.equal(stale.status, 0, stale.error);
  assert.deepEqual(writes, [], 'no repo writer ran on stale inputs either');
  assert.deepEqual(stale.changed.repo, []);
  assert.ok(stale.deferred.repo.includes(w.config.caps.brainIndex.path) && stale.deferred.repo.includes(w.config.caps.roadmapOverview.path));
  assert.deepEqual(repoState(), before2, 'outputs, index, HEAD and refs unchanged');
  mocks.forEach(m => m.mock.restore());
  const refusedInRepo = inRepo.save(inRepo.S1, {memoryOnly: true});
  assert.equal(refusedInRepo.status, 1); assert.match(refusedInRepo.error, /--memory-only needs external memory/);
  assert.equal(refusedInRepo.effective.memoryOnly, false);
  const refusedAll = w.save(w.S1, {session: false, memoryOnly: true});
  assert.equal(refusedAll.status, 1); assert.match(refusedAll.error, /--memory-only needs session mode/);
  assert.equal(refusedAll.effective.memoryOnly, false);
});

// E-T17 files-only selection.
test('E-T17 --files-only commits only the named claimed files and their pages', t => {
  const w = world(t);
  w.claim(w.S1, ['MEMORY.md']);
  w.write('MEMORY.md', w.read('MEMORY.md') + '\nOwn router edit.\n');
  const lesson = w.newLesson(w.S1, 'Named lesson');
  const dry = w.save(w.S1, {files: [lesson], filesOnly: true, dryRun: true});
  const result = w.save(w.S1, {files: [lesson], filesOnly: true});
  assert.equal(result.status, 0, result.error);
  assert.deepEqual(result.effective, {session: true, memoryOnly: false, filesOnly: true});
  assert.deepEqual(w.committed(result.sha), ['INDEX-craft-all.md', 'INDEX-craft.md', lesson].sort());
  assert.deepEqual(dry.selected, [lesson]);
  assert.deepEqual(dry.planned.memory.map(p => p.path).sort(), ['INDEX-craft-all.md', 'INDEX-craft.md']);
  assert.match(w.git(w.memoryDir, 'status', '--porcelain', '--', 'MEMORY.md'), /M MEMORY\.md/);
  assert.ok(w.ledger(w.S1).claims['MEMORY.md'], 'the router edit stays claimed');
  const retry = w.save(w.S1, {files: [lesson], filesOnly: true});
  assert.equal(retry.status, 0); assert.equal(retry.sha, result.sha, 'a publication-only retry selects the same set, now committed');
  assert.deepEqual(retry.selected, dry.selected);
  // A fresh --files claim on an already-saved file is a reservation that stays live until released (E2.6).
  assert.ok(w.ledger(w.S1).claims[lesson], 'the retry\'s fresh claim stays');
  assert.ok(session.foreignClaims(w.memoryDir, session.sessionOf(w.S2.repo).id).has(lesson), 'and blocks other sessions');
  session.releaseFiles({memoryDir: w.memoryDir, repo: w.S1.repo, files: [lesson]});
  assert.equal(w.ledger(w.S1).claims[lesson], undefined);
  assert.match(w.git(w.memoryDir, 'status', '--porcelain', '--', 'MEMORY.md'), /M MEMORY\.md/);
  const none = w.save(w.S1, {filesOnly: true});
  assert.equal(none.status, 0); assert.equal(none.sha, result.sha); assert.equal(none.effective.filesOnly, true);
  assert.match(w.git(w.memoryDir, 'status', '--porcelain', '--', 'MEMORY.md'), /M MEMORY\.md/);
  const outside = w.save(w.S1, {session: false, filesOnly: true, files: [lesson]});
  assert.equal(outside.status, 1); assert.match(outside.error, /--files-only needs session mode/); assert.equal(outside.effective.filesOnly, false);
  const union = w.save(w.S1, {files: [lesson]});
  assert.equal(union.status, 0); assert.ok(w.committed(union.sha).includes('MEMORY.md'), 'without --files-only the union commits the router');
});

// E-T5 publication.
test('E-T5 the memory lock is free during a blocked push; concurrent pushes publish both SHAs, verified, never forced', async t => {
  const w = world(t);
  const barrier = path.join(w.root, 'barrier'); fs.mkdirSync(barrier);
  const slash = p => p.replace(/\\/g, '/');
  fs.writeFileSync(path.join(w.memoryDir, '.git/hooks/pre-push'), `#!/bin/sh\ntouch "${slash(barrier)}/entered-$$"\nwhile [ ! -f "${slash(barrier)}/release" ]; do sleep 0.05; done\nexit 0\n`);
  if (process.platform !== 'win32') fs.chmodSync(path.join(w.memoryDir, '.git/hooks/pre-push'), 0o755);
  const run = s => new Promise(resolve => {
    const child = spawn(process.execPath, [engine('memory-checkpoint.mjs'), '--session', '--repo', s.repo, '--memory-dir', s.memoryDir, '--config', w.configFile, '--today', '2026-11-12'], {env: process.env});
    let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
    child.on('close', code => resolve({code, out}));
  });
  const until = async predicate => { for (let i = 0; i < 2400 && !predicate(); i++) await new Promise(r => setTimeout(r, 25)); assert.ok(predicate(), 'barrier not reached'); };
  w.newLesson(w.S1, 'S1 lesson');
  const first = run(w.S1);
  await until(() => fs.readdirSync(barrier).some(n => n.startsWith('entered-')));
  const s1sha = w.head();
  const s2lesson = w.newLesson(w.S2, 'S2 lesson');
  assert.ok(fs.existsSync(path.join(w.memoryDir, s2lesson)), 'memory-lesson new succeeds while a push is blocked');
  const second = run(w.S2);
  await until(() => w.head() !== s1sha);
  const s2sha = w.head();
  fs.writeFileSync(path.join(barrier, 'release'), '');
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.code, 0, a.out); assert.equal(b.code, 0, b.out);
  assert.match(a.out, new RegExp(`publication: ${s1sha} verified`)); assert.match(b.out, new RegExp(`publication: ${s2sha} verified`));
  for (const sha of [s1sha, s2sha]) assert.equal(spawnSync('git', ['-C', w.memoryDir, 'merge-base', '--is-ancestor', sha, w.remoteHead()]).status, 0);
  assert.equal(w.remoteHead(), s2sha);
});

// E2.4 writers: claim-based writers claim; standalone generation follows the generated-output policy; standalone
// hand-over rotation and the exclusive setup steps refuse while another session holds unresolved claims.
test('E2.4 writers claim in session mode; standalone index, rotation and setup follow their classification', async t => {
  const w = world(t, {hook: false, remote: false});
  const {recordRepeat} = await import('../engine/memory-lesson.mjs');
  const {rotateHandovers} = await import('../engine/memory-rotate.mjs');
  const {finishMemory} = await import('../engine/memory-setup.mjs');
  const lesson = w.newLesson(w.S1, 'Repeated lesson');
  w.git(w.memoryDir, 'add', lesson); w.git(w.memoryDir, 'commit', '-q', '-m', 'lesson');
  recordRepeat({memoryDir: w.memoryDir, repo: w.S2.repo, config: w.config, id: lesson, note: 'slip: again', today: '2026-11-12'});
  assert.ok(w.ledger(w.S2).claims[lesson], 'the repeat writer claims the lesson it edits');
  assert.throws(() => recordRepeat({memoryDir: w.memoryDir, repo: w.S1.repo, config: w.config, id: lesson, note: 'slip: once more', today: '2026-11-12'}), /claim refused/);
  assert.throws(() => rotateHandovers({memoryDir: w.memoryDir, repo: w.S1.repo, config: w.config, write: true}), /rotate handovers refused: 1 files pending in other sessions/);
  assert.throws(() => finishMemory({memory: {dir: w.memoryDir}, target: w.project, engine: path.join(kitRoot, 'engine'), configFile: w.configFile}), /memory setup refused: 1 files pending/);
  w.write('INDEX-craft.md', '# hand-written\n'); w.git(w.memoryDir, 'add', 'INDEX-craft.md');
  w.write('INDEX-craft.md', w.git(w.memoryDir, 'show', 'HEAD:INDEX-craft.md') + '\n');
  assert.throws(() => writeMemoryIndex({memoryDir: w.memoryDir, config: w.config}), /refusing to overwrite INDEX-craft\.md \(staged version is not generated\)/);
});

// E-T10 hand-overs filtered by branch, and the non-interactive /handover.
const note = (seq, time, branch, state) => `---\ntime: ${time}\nbranch: ${JSON.stringify(branch)}\nsha: 1234567\nmode: quick\n---\n**Open question:** none\n**State:** ${state}\n**Waits on the user:** none\n**Next action:** 1. continue ${state}\n**Lessons:** skipped (quick)\n`;
const noteName = (seq, time) => `handovers/${String(seq).padStart(6, '0')}-${time.slice(0, 10)}-${time.slice(11, 13)}${time.slice(14, 16)}.md`;
test('E-T10 the lead hand-over is the current branch\'s; foreign and branchless CURRENT never lead', async t => {
  const w = world(t, {hook: false});
  const {brief} = await import('../engine/new-session.mjs');
  const {listNotes} = await import('../engine/session-core.mjs');
  const at = minutes => new Date(Date.now() - minutes * 60000).toISOString().slice(0, 19) + 'Z';
  w.write(noteName(1, at(90)), note(1, at(90), 'b1', 'b1 work'));
  for (let i = 2; i <= 5; i++) w.write(noteName(i, at(90 - i * 10)), note(i, at(90 - i * 10), 'b2', `b2 work ${i}`));
  assert.deepEqual(listNotes(w.memoryDir, {branch: 'b1'}).map(n => n.branch), ['b1']);
  const opts = s => ({repo: s.repo, 'memory-dir': w.memoryDir});
  let digest = await brief(opts(w.S1));
  assert.match(digest, /last handover: .* b1 - b1 work/); assert.doesNotMatch(digest, /last handover: .* b2/);
  const stamp = new Date(Date.now() - 5 * 60000), local = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')} ${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`;
  const current = branchLine => CURRENT.replace('## CURRENT\nold state\n', `## CURRENT\n**${local} | @1234567 | quick. newer state**\n**Next action:** 1. foreign next${branchLine}\n`);
  w.write('current-state.md', current(''));
  digest = await brief(opts(w.S1));
  assert.match(digest, /last handover: .* b1 - b1 work/, 'a branchless legacy CURRENT never leads'); assert.doesNotMatch(digest, /foreign next|newer state/);
  w.write('current-state.md', current('\n**Branch:** b2'));
  digest = await brief(opts(w.S1));
  assert.match(digest, /last handover: .* b1 - b1 work/, 'a b2 CURRENT never leads on b1'); assert.doesNotMatch(digest, /foreign next|newer state/);
  w.git(w.project, 'worktree', 'add', '-q', '-b', 'b3', path.join(w.root, 'b3'));
  digest = await brief({repo: path.join(w.root, 'b3'), 'memory-dir': w.memoryDir});
  assert.match(digest, /no hand-over note for b3/);
  assert.match(digest, /other branches \(not picked\):\n.*b2.*000005-.*\n.*b2.*000004-/);
  w.git(w.project, 'worktree', 'add', '-q', '-b', 'b4', path.join(w.root, 'b4'));
  w.write('current-state.md', current('\n**Branch:** b4'));
  digest = await brief({repo: path.join(w.root, 'b4'), 'memory-dir': w.memoryDir});
  assert.match(digest, /last handover: .* - newer state/, 'a matching CURRENT with no loose note leads');
});

test('E-T10 non-interactive /handover with stdin closed: note, checkpoint, publication verified, exit 0', t => {
  const w = world(t);
  const input = w.put(path.join(w.root, 'input.json'), JSON.stringify({state: 'ready to continue', next: ['review the result']}));
  const r = spawnSync(process.execPath, [engine('handover.mjs'), 'run', '--repo', w.S1.repo, '--memory-dir', w.memoryDir, '--in', input, '--quick', '--no-rotate'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /SAFE TO COMPACT \(quick\)/);
  const notes = fs.readdirSync(path.join(w.memoryDir, 'handovers'));
  assert.equal(notes.length, 1);
  assert.equal(w.git(w.memoryDir, 'status', '--porcelain', '--', 'handovers', 'current-state.md'), '');
  assert.equal(w.remoteHead(), w.head());
  assert.match(w.read('current-state.md'), /\*\*Branch:\*\* b1/);
});

test('E-T4 a /handover while another session holds current-state.md writes and commits only its own note', t => {
  const w = world(t);
  w.claim(w.S2, ['current-state.md']);
  const before = fs.readFileSync(path.join(w.memoryDir, 'current-state.md'));
  const input = w.put(path.join(w.root, 'input.json'), JSON.stringify({state: 'ready to continue', next: ['review the result']}));
  const r = spawnSync(process.execPath, [engine('handover.mjs'), 'run', '--repo', w.S1.repo, '--memory-dir', w.memoryDir, '--in', input, '--quick'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env});
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [noteFile] = fs.readdirSync(path.join(w.memoryDir, 'handovers'));
  const s2 = session.sessionOf(w.S2.repo);
  assert.ok(r.stdout.includes(`current-state.md is pending in ${s2.checkout} (b2); your note is handovers/${noteFile}`), r.stdout);
  assert.deepEqual(fs.readFileSync(path.join(w.memoryDir, 'current-state.md')), before);
  assert.ok(w.tracked().includes(`handovers/${noteFile}`));
  assert.equal(w.remoteHead(), w.head());
});

// ---- Ownership checks inside the lock, unmarked stubs, structured failure results and saved-SHA verification: one regression per case. ----
const engineURL = name => JSON.stringify(pathToFileURL(engine(name)).href);
const until = async (predicate, label) => { for (let i = 0; i < 2400 && !predicate(); i++) await new Promise(r => setTimeout(r, 25)); assert.ok(predicate(), label + ': barrier not reached'); };
const child = (file, argv) => new Promise(resolve => {
  const p = spawn(process.execPath, [file, ...argv], {env: process.env});
  let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
  p.on('close', code => resolve({code, out}));
});
const STUB = name => `---\nname: ${name}\ndescription: "Moved by hand."\nmoved_to: topic-alpha.md\n---\n\nSee topic-alpha.\n`;

test('a malformed claim record still blocks; its valid path stays an unresolved claim', t => {
  const w = world(t);
  w.claim(w.S2, ['topic-beta.md']); w.write('topic-beta.md', topic('topic-beta') + 'S2 dirty work\n');
  const s2 = session.sessionOf(w.S2.repo), file = path.join(w.memoryDir, '.sessions', s2.id + '.json');
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8')); delete ledger.claims['topic-beta.md'].headAtClaim;
  fs.writeFileSync(file, JSON.stringify(ledger));
  assert.throws(() => w.claim(w.S1, ['topic-beta.md']), /claim refused: topic-beta\.md is claimed by/);
  const head = w.head(), result = w.save(w.S1, {files: ['topic-beta.md']});
  assert.equal(result.status, 3, result.error); assert.equal(w.head(), head, 'nothing committed'); assert.deepEqual(result.selected, []);
  assert.ok(result.malformed.some(m => m.file === `.sessions/${s2.id}.json`), JSON.stringify(result.malformed));
  assert.ok(w.lines.some(line => line.startsWith(`malformed ledger: .sessions/${s2.id}.json`)), w.lines.join('\n'));
});
test('an unreadable ledger refuses claims and saves; stale needs confirmed absence', t => {
  const w = world(t);
  fs.mkdirSync(path.join(w.memoryDir, '.sessions'), {recursive: true});
  fs.writeFileSync(path.join(w.memoryDir, '.sessions', '0123456789012345.json'), '{not json');
  assert.throws(() => w.claim(w.S1, ['topic-alpha.md']), /ledger \.sessions\/0123456789012345\.json is unreadable/);
  const saved = w.save(w.S1);
  assert.equal(saved.status, 1); assert.match(saved.error, /unreadable/);
  assert.match(session.listSessions({memoryDir: w.memoryDir, repo: w.S1.repo}).text, /unreadable: \.sessions\/0123456789012345\.json/);
  fs.unlinkSync(path.join(w.memoryDir, '.sessions', '0123456789012345.json'));
  // A checkout whose folder cannot be confirmed absent (its parent is missing too) is not stale: its claims block.
  const checkout = path.join(w.root, 'missing-parent', 'b9'), id = session.sessionId(checkout, 'b9');
  fs.writeFileSync(path.join(w.memoryDir, '.sessions', id + '.json'), JSON.stringify({version: 1, id, checkout, branch: 'b9', updated: new Date().toISOString(), claims: {'topic-alpha.md': {since: '2026-11-12T08:00:00.000Z', by: 'test', headAtClaim: session.memoryHead(w.memoryDir)}}}));
  assert.notEqual(session.readLedgers(w.memoryDir).find(l => l.id === id).state, 'stale');
  assert.throws(() => w.claim(w.S1, ['topic-alpha.md']), /claim refused: topic-alpha\.md/);
});

test('recovery after a failure runs inside the original memory lock', t => {
  const w = world(t);
  w.newLesson(w.S1, 'Own lesson');
  const lock = path.join(w.memoryDir, '.memory.lock'), seen = [];
  const result = w.save(w.S1, {faults: {beforeGate() { throw new Error('injected gate failure'); }, afterRestore() { seen.push(fs.existsSync(lock)); }}});
  assert.equal(result.status, 1);
  assert.deepEqual(seen, [true], 'restore ran while the lock was held');
});

test('standalone hand-over rotation checks ownership inside the lock that covers its writes', async t => {
  const w = world(t, {hook: false});
  for (let i = 1; i <= 3; i++) w.write(`handovers/00000${i}-2026-11-01-100${i}.md`, `---\ntime: 2026-11-01T10:0${i}:00+01:00\nbranch: "b1"\nsha: 1234567\nmode: quick\n---\n**State:** note ${i}\n`);
  w.git(w.memoryDir, 'add', '.'); w.git(w.memoryDir, 'commit', '-q', '-m', 'notes');
  const dir = path.join(w.root, 'drivers'), marks = path.join(w.root, 'marks'); fs.mkdirSync(dir); fs.mkdirSync(marks);
  const holder = w.put(path.join(dir, 'holder.mjs'), `import fs from 'node:fs';\nimport {withMemoryLock} from ${engineURL('memory-lock.mjs')};\nimport {claimFiles} from ${engineURL('memory-session.mjs')};\nconst [memoryDir, repo, file, ready, go] = process.argv.slice(2);\nwithMemoryLock(memoryDir, lock => { fs.writeFileSync(ready, ''); while (!fs.existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); claimFiles({memoryDir, repo, files: [file], lock}); });\n`);
  const rotator = w.put(path.join(dir, 'rotator.mjs'), `import fs from 'node:fs';\nimport {rotateHandovers} from ${engineURL('memory-rotate.mjs')};\nconst [memoryDir, repo, waiting] = process.argv.slice(2);\ntry { const r = rotateHandovers({memoryDir, repo, write: true, keep: 1, beforeLock: () => fs.writeFileSync(waiting, '')}); console.log('rotated ' + r.moved); } catch (error) { console.log('refused: ' + error.message); process.exitCode = 3; }\n`);
  const held = child(holder, [w.memoryDir, w.S2.repo, 'handovers/000001-2026-11-01-1001.md', path.join(marks, 'ready'), path.join(marks, 'go')]);
  await until(() => fs.existsSync(path.join(marks, 'ready')), 'holder');
  const rotation = child(rotator, [w.memoryDir, w.S1.repo, path.join(marks, 'waiting')]);
  await until(() => fs.existsSync(path.join(marks, 'waiting')), 'rotator');
  fs.writeFileSync(path.join(marks, 'go'), '');
  const [h, r] = await Promise.all([held, rotation]);
  assert.equal(h.code, 0, h.out);
  assert.equal(r.code, 3, r.out); assert.match(r.out, /refused: rotate handovers refused: 1 files pending in other sessions/);
  assert.ok(fs.existsSync(path.join(w.memoryDir, 'handovers/000001-2026-11-01-1001.md')), 'the claimed note is not archived');
});
test('setup exclusion is checked inside the lock that covers its writes', async t => {
  const w = world(t, {hook: false});
  const dir = path.join(w.root, 'drivers'), marks = path.join(w.root, 'marks'); fs.mkdirSync(dir); fs.mkdirSync(marks);
  const holder = w.put(path.join(dir, 'holder.mjs'), `import fs from 'node:fs';\nimport {withMemoryLock} from ${engineURL('memory-lock.mjs')};\nimport {claimFiles} from ${engineURL('memory-session.mjs')};\nconst [memoryDir, repo, file, ready, go] = process.argv.slice(2);\nwithMemoryLock(memoryDir, lock => { fs.writeFileSync(ready, ''); while (!fs.existsSync(go)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); claimFiles({memoryDir, repo, files: [file], lock}); });\n`);
  const setup = w.put(path.join(dir, 'setup.mjs'), `import fs from 'node:fs';\nimport {finishMemory} from ${engineURL('memory-setup.mjs')};\nconst [memoryDir, target, engine, configFile, waiting] = process.argv.slice(2);\ntry { finishMemory({memory: {dir: memoryDir}, target, engine, configFile, beforeLock: () => fs.writeFileSync(waiting, '')}); console.log('setup done'); } catch (error) { console.log('refused: ' + error.message); process.exitCode = 3; }\n`);
  const held = child(holder, [w.memoryDir, w.S2.repo, 'topic-alpha.md', path.join(marks, 'ready'), path.join(marks, 'go')]);
  await until(() => fs.existsSync(path.join(marks, 'ready')), 'holder');
  const running = child(setup, [w.memoryDir, w.project, path.join(kitRoot, 'engine'), w.configFile, path.join(marks, 'waiting')]);
  await until(() => fs.existsSync(path.join(marks, 'waiting')), 'setup');
  fs.writeFileSync(path.join(marks, 'go'), '');
  const [h, s] = await Promise.all([held, running]);
  assert.equal(h.code, 0, h.out); assert.equal(s.code, 3, s.out); assert.match(s.out, /memory setup refused: 1 files pending/);
});

test('an unmarked stub at a generated path is never overwritten (worktree, staged and standalone)', t => {
  const w = world(t);
  const head = w.head(), stub = STUB('INDEX-ops');
  w.write('INDEX-ops.md', stub);
  w.newLesson(w.S1, 'Own lesson');
  const worktree = w.save(w.S1);
  assert.equal(worktree.status, 1); assert.match(worktree.error, /refusing to overwrite INDEX-ops\.md/);
  assert.equal(w.read('INDEX-ops.md'), stub); assert.equal(w.head(), head);
  assert.throws(() => writeMemoryIndex({memoryDir: w.memoryDir, config: w.config}), /refusing to overwrite INDEX-ops\.md/);
  w.git(w.memoryDir, 'add', 'INDEX-ops.md'); w.write('INDEX-ops.md', w.show('HEAD', 'INDEX-ops.md') + '\n');
  const staged = w.save(w.S1);
  assert.equal(staged.status, 1); assert.match(staged.error, /refusing to overwrite INDEX-ops\.md \(staged version is not generated\)/);
  assert.equal(w.head(), head);
});

test('an empty --files-only selection only publishes: no pages, no repo outputs, no commit, even with stale pages', t => {
  const w = world(t, {hook: false});
  w.write('INDEX-ops.md', w.read('INDEX-ops.md') + 'stale committed line\n');
  w.git(w.memoryDir, 'commit', '-q', '-am', 'stale page in H'); w.git(w.memoryDir, 'push', '-q');
  w.put(path.join(w.S1.repo, 'brain/02-projects/prj-one.md'), '---\nid: prj-one\ntype: project\nsummary: One project.\n---\n');
  const head = w.head(), before = w.snapshot();
  const result = w.save(w.S1, {filesOnly: true});
  assert.equal(result.status, 0, result.error);
  assert.deepEqual(result.selected, []); assert.equal(result.sha, head); assert.equal(w.head(), head, 'no commit');
  assert.deepEqual(w.snapshot(), before, 'no generated output applied');
  assert.ok(!fs.existsSync(path.join(w.S1.repo, w.config.caps.brainIndex.path)), 'no repo output applied');
  assert.deepEqual(result.changed, {memory: [], repo: []});
  assert.ok(result.gate && Array.isArray(result.gate.evaluated) && result.gate.evaluated.length, 'read-only gate evidence');
  assert.equal(result.publication.verified, true);
});

test('in-repo brain pointers and moved_to targets resolve against the proposed tree', t => {
  const w = world(t, {inRepo: true, remote: false});
  const s = w.S1;
  w.claim(s, ['topic-alpha.md', 'moved.md']);
  w.write('topic-alpha.md', topic('topic-alpha').replace('route: craft\n', 'route: craft\nbrain: brain/x.md\n'), s);
  w.write('moved.md', '---\nname: moved\ndescription: "Moved to the brain."\nmoved_to: brain/y.md\n---\n', s);
  w.put(path.join(s.repo, 'brain/x.md'), '# x\n'); w.git(s.repo, 'add', 'brain/x.md');
  w.put(path.join(s.repo, 'brain/y.md'), '# y\n');
  const blocked = w.save(s, {commit: true});
  assert.equal(blocked.status, 1);
  assert.ok(gateFails(blocked).includes('brain.pointer topic-alpha.md'), JSON.stringify(blocked.gate?.fails));
  assert.ok(gateFails(blocked).includes('stub.target moved.md'), JSON.stringify(blocked.gate?.fails));
  w.git(s.repo, 'add', 'brain/y.md'); w.git(s.repo, 'commit', '-q', '-m', 'brain targets', '--', 'brain/x.md', 'brain/y.md');
  const saved = w.save(s, {commit: true});
  assert.equal(saved.status, 0, saved.error ?? JSON.stringify(saved.gate?.fails));
});

test('checkpoint() returns structured status 1 in all-sessions mode too, with the evidence so far', t => {
  const w = world(t, {mode: 'all', hook: false, remote: false});
  const early = w.save(w.S1, {session: undefined, today: 'not-a-date'});
  assert.equal(early.status, 1); assert.match(early.error, /invalid --today/); assert.equal(early.gate, null); assert.equal(early.effective.session, false);
  const unfilled = w.newLesson(w.S1, 'Unfilled', {fill: false});
  const gated = w.save(w.S1, {session: undefined, noPush: true});
  assert.equal(gated.status, 1); assert.ok(gateFails(gated).includes(`lesson.unfilled ${unfilled}`)); assert.match(gated.error, /lesson\.unfilled/);
  assert.ok(gated.changed.memory.includes('INDEX-craft.md'), 'pages written before the FAIL are reported');
  assert.equal(w.cli(w.S1, ['--all', '--no-push']).status, 1);
});

test('failure results list the changes left behind: kept pages and partial repo writes', t => {
  const w = world(t);
  w.newLesson(w.S1, 'Own lesson');
  const kept = w.save(w.S1, {faults: {beforeGate() { fs.appendFileSync(path.join(w.memoryDir, 'INDEX-craft.md'), 'changed again\n'); throw new Error('injected'); }}});
  assert.equal(kept.status, 1); assert.deepEqual(kept.changed.memory, ['INDEX-craft.md']);
  w.git(w.memoryDir, 'checkout', '--', 'INDEX-craft.md');
  w.put(path.join(w.S1.repo, 'brain/02-projects/prj-one.md'), '---\nid: prj-one\ntype: project\nsummary: One project.\n---\n');
  const partial = w.save(w.S1, {faults: {afterRepoWrite() { throw new Error('injected repo writer failure'); }}});
  assert.equal(partial.status, 1); assert.match(partial.error, /injected repo writer failure/);
  assert.ok(partial.changed.repo.length >= 1, JSON.stringify(partial.changed));
  for (const file of partial.changed.repo) assert.ok(fs.existsSync(path.join(w.S1.repo, file)), file);
});

test('/handover in session mode with in-repo memory verifies the saved SHA on the project remote', t => {
  const w = world(t, {inRepo: true});
  const s = w.S1;
  w.put(path.join(s.repo, 'AGENTS.md'), '# Project\n\n## Session overlay\nbranch: b1\npush: project\n');
  w.git(s.repo, 'commit', '-q', '-am', 'overlay'); w.git(s.repo, 'push', '-q', '-u', 'origin', 'b1');
  const input = w.put(path.join(w.root, 'input.json'), JSON.stringify({state: 'ready to continue', next: ['review the result']}));
  const r = spawnSync(process.execPath, [engine('handover.mjs'), 'run', '--repo', s.repo, '--in', input, '--quick'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: process.env});
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /SAFE TO COMPACT \(quick\)/);
  assert.equal(w.git(w.root, '--git-dir', w.bare, 'rev-parse', 'refs/heads/b1'), w.git(s.repo, 'rev-parse', 'HEAD'));
});
test('an all-sessions /handover verifies its saved SHA, not a later unpublished HEAD', async t => {
  const w = world(t, {mode: 'all'});
  const {runHandover} = await import('../engine/handover.mjs');
  const input = w.put(path.join(w.root, 'input.json'), JSON.stringify({state: 'ready to continue', next: ['review the result']}));
  let output = '';
  const result = runHandover({repo: w.S1.repo, memoryDir: w.memoryDir, input, quick: true}, {output: text => { output += text; }, beforeVerify() {
    w.write('other-session.md', topic('other-session')); w.git(w.memoryDir, 'add', 'other-session.md'); w.git(w.memoryDir, 'commit', '-q', '--no-verify', '-m', 'another session, not pushed');
  }});
  assert.equal(result.code, 0, output); assert.match(output, /SAFE TO COMPACT/);
});

test('E-T2c the real gate and hook agree at a CRLF byte boundary', t => {
  const w = world(t);
  w.write('.gitattributes', 'edge.md text eol=crlf\n'); w.git(w.memoryDir, 'add', '.gitattributes'); w.git(w.memoryDir, 'commit', '-q', '-m', 'attributes');
  const head = topic('edge'), line = 'e'.repeat(99) + '\n', fail = w.config.caps.topic.failBytes;
  const lines = Math.floor((fail - Buffer.byteLength(head)) / line.length);
  const lf = head + line.repeat(lines);
  assert.ok(Buffer.byteLength(lf) <= fail && Buffer.byteLength(lf.replace(/\n/g, '\r\n')) > fail, 'the LF bytes pass, the checkout bytes do not');
  w.claim(w.S1, ['edge.md']); w.write('edge.md', lf);
  const blocked = w.save(w.S1);
  assert.equal(blocked.status, 1); assert.ok(gateFails(blocked).includes('topic.size edge.md'), JSON.stringify(blocked.gate?.fails));
  w.git(w.memoryDir, 'add', 'edge.md');
  const hooked = spawnSync('git', ['-C', w.memoryDir, 'commit', '-m', 'edge'], {encoding: 'utf8', env: process.env});
  assert.notEqual(hooked.status, 0, 'the real hook blocks the same bytes'); assert.match(hooked.stdout + hooked.stderr, /topic\.size edge\.md/);
  w.git(w.memoryDir, 'reset', '-q', '--', 'edge.md');
  w.write('edge.md', head + line.repeat(lines - 3));
  const saved = w.save(w.S1);
  assert.equal(saved.status, 0, saved.error ?? JSON.stringify(saved.gate?.fails)); assert.ok(w.committed(saved.sha).includes('edge.md'));
});

test('E-T7 the ledger temp file lives in .sessions, is renamed into place, and a swapped-in junction is refused', t => {
  const w = world(t, {hook: false, remote: false});
  const sessions = path.join(fs.realpathSync.native(w.memoryDir), '.sessions'), id = session.sessionOf(w.S1.repo).id;
  const write = fs.writeFileSync, rename = fs.renameSync, events = [];
  let m1 = t.mock.method(fs, 'writeFileSync', function (file, ...rest) { const r = write.call(this, file, ...rest); if (/\.json\.[0-9a-f-]+\.tmp$/.test(String(file))) events.push(['write', String(file)]); return r; });
  const m2 = t.mock.method(fs, 'renameSync', function (from, to) { events.push(['rename', String(from), String(to)]); return rename.call(this, from, to); });
  w.claim(w.S1, ['topic-alpha.md']);
  m1.mock.restore(); m2.mock.restore();
  assert.equal(events.length, 2, JSON.stringify(events));
  assert.equal(path.dirname(events[0][1]).toLowerCase(), sessions.toLowerCase());
  assert.deepEqual(events[1].slice(1).map(p => p.toLowerCase()), [events[0][1].toLowerCase(), path.join(sessions, id + '.json').toLowerCase()]);
  assert.deepEqual(fs.readdirSync(sessions).filter(n => n.endsWith('.tmp')), []);
  const ledgerBefore = fs.readFileSync(path.join(sessions, id + '.json'));
  const outside = path.join(w.root, 'outside'); fs.mkdirSync(outside);
  m1 = t.mock.method(fs, 'writeFileSync', function (file, ...rest) { const r = write.call(this, file, ...rest); if (/\.json\.[0-9a-f-]+\.tmp$/.test(String(file))) { fs.unlinkSync(file); junction(outside, file); } return r; });
  assert.throws(() => w.claim(w.S1, ['topic-beta.md']), /ledger temp refused/);
  m1.mock.restore();
  assert.deepEqual(fs.readFileSync(path.join(sessions, id + '.json')), ledgerBefore);
  assert.deepEqual(fs.readdirSync(outside), []); assert.deepEqual(fs.readdirSync(sessions).filter(n => n.endsWith('.tmp')), [], 'the swapped link is removed');
  const m3 = t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('injected rename failure'), {code: 'EIO'}); });
  assert.throws(() => w.claim(w.S1, ['topic-beta.md']), /injected rename failure/);
  m3.mock.restore();
  assert.deepEqual(fs.readFileSync(path.join(sessions, id + '.json')), ledgerBefore);
  assert.deepEqual(fs.readdirSync(sessions).filter(n => n.endsWith('.tmp')), []);
});

test('standalone memory-index restores every output when a later write fails, inside its lock', t => {
  const w = world(t, {hook: false, remote: false});
  w.newLesson(w.S1, 'Own lesson'); w.write('INDEX-ops.md', w.read('INDEX-ops.md') + 'stale\n');
  const pages = () => Object.fromEntries(fs.readdirSync(w.memoryDir).filter(n => /^INDEX-/.test(n)).map(n => [n, fs.readFileSync(path.join(w.memoryDir, n), 'base64')]));
  const before = pages(), lock = path.join(w.memoryDir, '.memory.lock'), write = fs.writeFileSync, calls = [];
  let count = 0;
  const m = t.mock.method(fs, 'writeFileSync', function (file, ...rest) {
    if (/INDEX-[^\\/]*\.md$/.test(String(file))) { calls.push(fs.existsSync(lock)); if (++count === 2) throw new Error('injected page write failure'); }
    return write.call(this, file, ...rest);
  });
  assert.throws(() => writeMemoryIndex({memoryDir: w.memoryDir, repo: w.S1.repo, config: w.config}), /injected page write failure/);
  m.mock.restore();
  assert.deepEqual(pages(), before, 'every page is restored');
  assert.ok(calls.length > 2 && calls.every(Boolean), 'writes and restores happen under the lock');
});

// ---- An unreadable claimed path, unreadable outputs after a failed save, and a failed lock release after a commit. ----
test('R2-2 a claimed path whose inspection fails (EACCES) stays an unresolved blocker', t => {
  const w = world(t, {hook: false, remote: false});
  w.claim(w.S2, ['topic-beta.md']);
  const s1 = session.sessionOf(w.S1.repo).id, s2 = session.sessionOf(w.S2.repo).id;
  const native = fs.realpathSync.native, target = path.join(fs.realpathSync.native(w.memoryDir), 'topic-beta.md').toLowerCase();
  const m = t.mock.method(fs.realpathSync, 'native', function (file, ...rest) {
    if (String(file).toLowerCase() === target) throw Object.assign(new Error(`EACCES: permission denied, realpath '${file}'`), {code: 'EACCES'});
    return native.call(this, file, ...rest);
  });
  const ledger = session.readLedgers(w.memoryDir).find(l => l.id === s2);
  assert.equal(ledger.state, 'malformed'); assert.match(ledger.problems.join('\n'), /topic-beta\.md could not be inspected/);
  assert.ok(session.foreignClaims(w.memoryDir, s1).has('topic-beta.md'), 'the claim keeps blocking');
  assert.equal(session.pendingOther(w.memoryDir, s1), 1, 'maintenance still waits');
  assert.throws(() => w.claim(w.S1, ['topic-beta.md']), /claim refused: topic-beta\.md/);
  m.mock.restore();
  assert.equal(session.readLedgers(w.memoryDir).find(l => l.id === s2).state, 'live', 'once readable, the ledger is live again');
});

test('R2-3 a failed save whose outputs then cannot be read returns status 1 with the original error, in both modes', t => {
  const eacces = file => Object.assign(new Error(`EACCES: permission denied, open '${file}'`), {code: 'EACCES'});
  // All-sessions mode: the page writer fails, then an output cannot be read while changes are collected.
  const a = world(t, {mode: 'all', hook: false, remote: false});
  a.newLesson(a.S1, 'Own lesson');
  const write = fs.writeFileSync, read = fs.readFileSync;
  let failed = false;
  let mw = t.mock.method(fs, 'writeFileSync', function (file, ...rest) { if (/INDEX-craft\.md$/.test(String(file))) { failed = true; throw new Error('injected writer failure'); } return write.call(this, file, ...rest); });
  let mr = t.mock.method(fs, 'readFileSync', function (file, ...rest) { if (failed && /INDEX-ops\.md$/.test(String(file))) throw eacces(file); return read.call(this, file, ...rest); });
  let all;
  assert.doesNotThrow(() => { all = a.save(a.S1, {session: undefined, noPush: true}); });
  mw.mock.restore(); mr.mock.restore();
  assert.equal(all.status, 1); assert.match(all.error, /injected writer failure/);
  assert.ok(all.uninspected.some(u => u.path === 'INDEX-ops.md' && /EACCES/.test(u.error)), JSON.stringify(all.uninspected));
  // Session mode: a page write fails, then recovery and change collection cannot read the pages.
  const s = world(t, {hook: false, remote: false});
  s.newLesson(s.S1, 'Own lesson');
  failed = false;
  mr = t.mock.method(fs, 'readFileSync', function (file, ...rest) { if (failed && /INDEX-craft(?:-all)?\.md$/.test(String(file))) throw eacces(file); return read.call(this, file, ...rest); });
  let own;
  assert.doesNotThrow(() => { own = s.save(s.S1, {faults: {afterPageWrite() { failed = true; throw new Error('injected writer failure'); }}}); });
  mr.mock.restore();
  assert.equal(own.status, 1); assert.match(own.error, /injected writer failure/);
  assert.ok(own.uninspected.some(u => u.path === 'INDEX-craft.md'), JSON.stringify(own.uninspected));
  assert.ok(s.lines.some(line => /could not inspect/.test(line)), s.lines.join('\n'));
});

test('R2-4 all-sessions mode keeps the commit SHA when the lock cleanup fails after the commit', t => {
  const w = world(t, {mode: 'all', hook: false, remote: false});
  w.newLesson(w.S1, 'Own lesson');
  let committed = false;
  const git = (argv, options = {}) => {
    const r = spawnSync('git', ['-C', w.memoryDir, ...argv], {encoding: 'utf8', ...options});
    if (r.status !== 0) throw new Error(`git ${argv[0]}: ${r.stderr}`);
    if (argv[0] === 'commit') committed = true;
    return r.stdout;
  };
  const unlink = fs.unlinkSync;
  const m = t.mock.method(fs, 'unlinkSync', function (file, ...rest) { if (committed && path.basename(String(file)) === '.memory.lock') throw Object.assign(new Error('EPERM: injected lock cleanup failure'), {code: 'EPERM'}); return unlink.call(this, file, ...rest); });
  const result = w.save(w.S1, {session: undefined, noPush: true, git});
  m.mock.restore();
  assert.ok(committed, 'the commit happened');
  assert.equal(result.status, 1); assert.match(result.error, /injected lock cleanup failure/);
  assert.match(result.sha ?? '', /^[0-9a-f]{40}$/); assert.equal(result.sha, w.head());
});

// ---- Candidate-folder removal and cleanup failures: each keeps the original error and adds the cleanup error. ----
const CLEANUP_FAILURE = 'EPERM: injected candidate cleanup failure';
// Candidate folders whose removal was injected to fail are removed here, after the mocks are restored.
const dropLeftovers = result => { for (const e of result?.cleanupErrors ?? []) { const m = /could not remove the candidate folder (.+?): /.exec(e); if (m) fs.rmSync(m[1], {recursive: true, force: true}); } };
const failCandidateRemoval = t => {
  const rm = fs.rmSync;
  return t.mock.method(fs, 'rmSync', function (file, ...rest) { if (/memory-candidate-/.test(String(file))) throw Object.assign(new Error(CLEANUP_FAILURE), {code: 'EPERM'}); return rm.call(this, file, ...rest); });
};
test('R3-2 a candidate-folder removal failure after a successful session commit returns status 1 with the SHA and the evidence', t => {
  const w = world(t, {hook: false});
  w.newLesson(w.S1, 'Own lesson');
  const m = failCandidateRemoval(t);
  let result;
  assert.doesNotThrow(() => { result = w.save(w.S1); });
  m.mock.restore(); dropLeftovers(result);
  assert.equal(result.status, 1); assert.match(result.error, /could not remove the candidate folder .*injected candidate cleanup failure/);
  assert.match(result.sha ?? '', /^[0-9a-f]{40}$/); assert.equal(result.sha, w.head());
  assert.deepEqual(result.gate.fails, []); assert.ok(result.gate.evaluated.length);
  assert.equal(result.publication.verified, true); assert.equal(w.remoteHead(), result.sha);
  assert.ok(result.changed.memory.includes('INDEX-craft.md'), JSON.stringify(result.changed));
  assert.ok(result.cleanupErrors.some(e => e.includes(CLEANUP_FAILURE)), JSON.stringify(result.cleanupErrors));
});
test('R3-2 a candidate-folder removal failure after a failed gate keeps the gate error and adds the cleanup error', t => {
  const w = world(t, {hook: false});
  const unfilled = w.newLesson(w.S1, 'Unfilled own lesson', {fill: false});
  const head = w.head(), m = failCandidateRemoval(t);
  let result;
  assert.doesNotThrow(() => { result = w.save(w.S1); });
  m.mock.restore(); dropLeftovers(result);
  assert.equal(result.status, 1); assert.match(result.error, /lesson\.unfilled/); assert.doesNotMatch(result.error, /injected candidate cleanup failure/);
  assert.ok(gateFails(result).includes(`lesson.unfilled ${unfilled}`));
  assert.ok(result.cleanupErrors.some(e => e.includes(CLEANUP_FAILURE)), JSON.stringify(result.cleanupErrors));
  assert.equal(w.head(), head);
});
// Cleanup after a failure inside the candidate build and in materialiseCandidate.
test('R3-sweep a candidate build failure keeps its own error when the candidate folder cannot be removed', t => {
  const w = world(t, {hook: false, remote: false});
  w.write('.gitignore', w.read('.gitignore') + 'ignored.md\n'); w.git(w.memoryDir, 'add', '.gitignore'); w.git(w.memoryDir, 'commit', '-q', '-m', 'ignore one file');
  w.claim(w.S1, ['ignored.md']); w.write('ignored.md', topic('ignored'));
  const m = failCandidateRemoval(t);
  let result;
  assert.doesNotThrow(() => { result = w.save(w.S1, {noPush: true}); });
  m.mock.restore(); dropLeftovers(result);
  assert.equal(result.status, 1); assert.match(result.error, /ignored/); assert.doesNotMatch(result.error, /injected candidate cleanup failure/);
  assert.ok(result.cleanupErrors.some(e => e.includes(CLEANUP_FAILURE)), JSON.stringify(result.cleanupErrors));
});
test('R3-sweep materialiseCandidate keeps the extraction error when the candidate folder cannot be removed', t => {
  const w = world(t, {hook: false, remote: false});
  const mk = fs.mkdirSync;
  const m1 = t.mock.method(fs, 'mkdirSync', function (dir, ...rest) { if (/memory-candidate-/.test(String(dir)) && path.basename(String(dir)) === 'tree') throw Object.assign(new Error('EIO: injected extraction failure'), {code: 'EIO'}); return mk.call(this, dir, ...rest); });
  const m2 = failCandidateRemoval(t);
  let thrown;
  try { cp.materialiseCandidate({memoryDir: w.memoryDir, own: []}); } catch (error) { thrown = error; }
  m1.mock.restore(); m2.mock.restore(); dropLeftovers({cleanupErrors: thrown?.cleanupErrors});
  assert.ok(thrown, 'the extraction failure is thrown');
  assert.match(thrown.message, /injected extraction failure/);
  assert.ok((thrown.cleanupErrors ?? []).some(e => e.includes(CLEANUP_FAILURE)), JSON.stringify(thrown.cleanupErrors));
});
// A failed recovery is part of the structured result.
test('R3-sweep a recovery that fails is recorded in cleanupErrors next to the original error', t => {
  const w = world(t, {hook: false, remote: false});
  w.newLesson(w.S1, 'Own lesson');
  const read = fs.readFileSync;
  let failed = false;
  const m = t.mock.method(fs, 'readFileSync', function (file, ...rest) { if (failed && /INDEX-craft(?:-all)?\.md$/.test(String(file))) throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), {code: 'EACCES'}); return read.call(this, file, ...rest); });
  let result;
  assert.doesNotThrow(() => { result = w.save(w.S1, {faults: {afterPageWrite() { failed = true; throw new Error('injected writer failure'); }}}); });
  m.mock.restore();
  assert.equal(result.status, 1); assert.match(result.error, /injected writer failure/);
  assert.ok(result.cleanupErrors.some(e => /^restore failed: .*EACCES/.test(e)), JSON.stringify(result.cleanupErrors));
});
// A lock that cannot be released after a failed run never replaces that run's error.
test('R3-sweep a lock release failure after a failed all-sessions run keeps the gate error', t => {
  const w = world(t, {mode: 'all', hook: false, remote: false});
  const unfilled = w.newLesson(w.S1, 'Unfilled', {fill: false});
  const unlink = fs.unlinkSync;
  const m = t.mock.method(fs, 'unlinkSync', function (file, ...rest) { if (path.basename(String(file)) === '.memory.lock') throw Object.assign(new Error('EPERM: injected lock release failure'), {code: 'EPERM'}); return unlink.call(this, file, ...rest); });
  const result = w.save(w.S1, {session: undefined, noPush: true});
  m.mock.restore();
  assert.equal(result.status, 1); assert.match(result.error, /lesson\.unfilled/); assert.doesNotMatch(result.error, /injected lock release failure/);
  assert.ok(gateFails(result).includes(`lesson.unfilled ${unfilled}`));
  assert.ok(result.cleanupErrors.some(e => /was not released: EPERM: injected lock release failure/.test(e)), JSON.stringify(result.cleanupErrors));
});

// ---- The repo-output cleanup in writeRepoOutputs. ----
test('R4 a failed brain-index regeneration keeps its error when the first-written catalog cannot be removed', t => {
  const w = world(t, {hook: false, remote: false});
  const repo = w.S1.repo, allPath = w.config.caps.brainIndex.allPath, allFile = path.join(repo, allPath);
  w.put(path.join(repo, 'brain/02-projects/prj-one.md'), '---\nid: prj-one\ntype: project\nsummary: One project.\n---\n');
  w.newLesson(w.S1, 'Own lesson');
  assert.ok(!fs.existsSync(allFile), 'the catalog is written for the first time');
  const read = fs.readFileSync, unlink = fs.unlinkSync;
  let armed = false;
  // Once the catalog is first written, regeneration cannot read a node (EIO) and the catalog cannot be removed (EPERM).
  const m1 = t.mock.method(fs, 'readFileSync', function (file, ...rest) { if (armed && /prj-one\.md$/.test(String(file))) throw Object.assign(new Error('EIO: injected generation failure'), {code: 'EIO'}); return read.call(this, file, ...rest); });
  const m2 = t.mock.method(fs, 'unlinkSync', function (file, ...rest) { if (armed && path.resolve(String(file)) === path.resolve(allFile)) throw Object.assign(new Error('EPERM: injected unlink failure'), {code: 'EPERM'}); return unlink.call(this, file, ...rest); });
  let result;
  assert.doesNotThrow(() => { result = w.save(w.S1, {noPush: true, faults: {afterRepoWrite(file) { if (file === allPath) armed = true; }}}); });
  m1.mock.restore(); m2.mock.restore();
  // Node's internal rimraf may have captured the mocked unlinkSync if it first loaded during the save: disarm it too.
  assert.ok(armed, 'the first catalog write happened'); armed = false;
  assert.equal(result.status, 1); assert.match(result.error, /EIO: injected generation failure/); assert.doesNotMatch(result.error, /injected unlink failure/);
  assert.ok(result.cleanupErrors.some(e => /could not remove the first-written brain index .*EPERM: injected unlink failure/.test(e)), JSON.stringify(result.cleanupErrors));
  assert.match(result.sha ?? '', /^[0-9a-f]{40}$/); assert.equal(result.sha, w.head(), 'the memory commit before the repo writer is kept');
});
