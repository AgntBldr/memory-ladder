import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture, put, tree, ok} from './helpers.mjs';
import {loadConfig, repoPath, pathKey, pathKeyFor, insideRepo, inRepoMemory, memoryLocation} from '../engine/lib.mjs';
import {runCheck} from '../engine/memory-check.mjs';
import {checkpoint} from '../engine/memory-checkpoint.mjs';
import {rotateLog, rotateRoadmap} from '../engine/memory-rotate.mjs';

const configFile = f => path.join(f.target, 'scripts/memory/memory.config.json');
function link(t, target, name) {
  try { fs.symlinkSync(target, name, process.platform === 'win32' ? 'junction' : 'dir'); return true; }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('directory links unavailable: ' + error.code); return false; } throw error; }
}
for (const value of ['../outside.md', '/outside.md', 'C:\\outside.md', '', null, 42]) {
  test('install refuses without writes: ' + JSON.stringify(value), t => {
    const f = fixture(t), config = loadConfig();
    config.caps.brainIndex.allPath = value;
    put(configFile(f), JSON.stringify(config));
    const before = tree(f.root, {git: true});
    const result = f.install();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /edit scripts\/memory\/memory.config.json: caps.brainIndex.allPath must be a relative path inside the project/);
    assert.deepEqual(tree(f.root, {git: true}), before);
  });
}
test('install refuses a junction or symlink escape without writes', t => {
  const f = fixture(t), outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  if (!link(t, outside, path.join(f.target, 'escape'))) return;
  const config = loadConfig(); config.caps.roadmapHistory.path = 'escape/new/history.md';
  put(configFile(f), JSON.stringify(config));
  const before = tree(f.root, {git: true});
  const result = f.install(); assert.equal(result.status, 1);
  assert.match(result.stderr, /caps.roadmapHistory.path must be a relative path inside the project/);
  assert.deepEqual(tree(f.root, {git: true}), before);
});
test('each generator refuses invalid paths before writing or skipping absent inputs', t => {
  const f = fixture(t); ok(f.install());
  const config = loadConfig(); config.caps.roadmapHistory.path = '../outside.md';
  put(configFile(f), JSON.stringify(config));
  const before = tree(f.root, {git: true});
  for (const [file, args] of [['brain-index', ['--write']], ['roadmap-overview', ['--write']], ['memory-rotate', ['log', '--write']], ['memory-rotate', ['roadmap', '--write']], ['memory-checkpoint', ['--dry-run']]]) {
    const r = f.cli('scripts/memory/' + file + '.mjs', args, f.target);
    assert.equal(r.status, 1, file + r.stdout + r.stderr);
    assert.match(r.stderr, /caps.roadmapHistory.path must be a relative path inside the repo/);
    assert.deepEqual(tree(f.root, {git: true}), before);
  }
  for (const run of [rotateLog, rotateRoadmap, checkpoint])
    assert.throws(() => run({repo: f.target, memoryDir: f.memory, config, write: true, dryRun: true}), /caps.roadmapHistory.path/);
});
test('config.path fails and cannot be allowlisted in either scope', t => {
  const f = fixture(t); fs.mkdirSync(f.memory, {recursive: true});
  const config = loadConfig(); config.caps.brainLog.path = '../outside.md';
  config.allow = [{check: 'config.path', file: '*', reason: 'test', added: '2026-10-29'}];
  for (const scope of ['all', 'memory']) {
    const result = runCheck({repo: f.target, memoryDir: f.memory, config, scope, noGit: true});
    const hit = result.findings.find(f => f.check === 'config.path');
    assert.equal(hit.severity, 'FAIL'); assert.equal(hit.allowed, false);
    assert.equal(hit.message, 'caps.brainLog.path must be a relative path inside the repo');
  }
});
test('ordinary relative paths work for install and generators', t => {
  const f = fixture(t), config = loadConfig(); config.caps.brainIndex.path = 'brain/00-system/custom.md';
  put(configFile(f), JSON.stringify(config));
  put(path.join(f.target, 'brain/03-knowledge/example.md'), '---\nid: example\ntype: fact\n---\n');
  put(path.join(f.target, 'docs/ROADMAP.md'), '# Roadmap\n');
  ok(f.install());
  for (const [name, args] of [['brain-index', ['--write']], ['roadmap-overview', ['--write']], ['memory-rotate', ['roadmap', '--write']], ['memory-checkpoint', ['--dry-run']]])
    ok(f.cli('scripts/memory/' + name + '.mjs', args, f.target));
  assert.ok(fs.existsSync(path.join(f.target, 'brain/00-system/custom.md')));
  assert.equal(repoPath(f.target, 'new/file.md', 'test'), path.join(f.target, 'new/file.md'));
});
test('canonical keys and containment follow existing and future directory aliases', t => {
  const f = fixture(t), alias = path.join(f.root, 'alias');
  if (!link(t, f.target, alias)) return;
  fs.mkdirSync(path.join(f.target, 'notes'));
  for (const suffix of ['notes', 'not-created/child']) {
    assert.equal(pathKey(f.target, suffix), pathKey(alias, suffix));
    assert.equal(insideRepo(f.target, path.join(alias, suffix)), true);
    assert.equal(inRepoMemory(alias, path.join(f.target, suffix)), true);
  }
  assert.equal(insideRepo(f.target, alias), false);
  assert.equal(insideRepo(f.target, f.home), false);
  assert.equal(insideRepo(alias, f.home), false);
  assert.equal(pathKey(f.target, 'notes', '..', 'future'), pathKey(f.target, 'future'));
});
test('platform case folding is explicit and ordinary containment is unchanged', t => {
  const f = fixture(t);
  for (const platform of ['darwin', 'win32']) assert.equal(pathKeyFor(platform, '/Data/Me/x'), pathKeyFor(platform, '/data/me/x'));
  assert.notEqual(pathKeyFor('linux', '/Data/Me/x'), pathKeyFor('linux', '/data/me/x'));
  assert.equal(insideRepo(f.target, f.target), false);
  assert.equal(insideRepo(f.target, path.join(f.target, 'new')), true);
  assert.equal(insideRepo(f.target, f.target + '-other'), false);
});
test('deleted saved notes are named by the gate and recreated at their saved location', t => {
  const f = fixture(t), saved = path.join(f.root, 'saved');
  ok(f.install(['--memory-dir', saved])); fs.rmSync(saved, {recursive: true, force: true});
  const r = f.cli('scripts/memory/memory-check.mjs', [], f.target);
  assert.equal(r.status, 1); assert.ok(r.stdout.includes('memory dir not found: ' + saved));
  const session = ok(f.cli('scripts/memory/memory-check.mjs', ['--session-start'], f.target));
  assert.ok(session.stdout.includes('memory dir not found: ' + saved));
  assert.match(session.stdout, /run node scripts\/memory\/memory-init.mjs/);
  ok(f.cli('scripts/memory/memory-init.mjs', [], f.target));
  assert.ok(fs.existsSync(path.join(saved, 'MEMORY.md'))); assert.equal(fs.existsSync(f.memory), false);
});
test('saved missing location preserves flag, environment and in-repo precedence and ignores a file', t => {
  const f = fixture(t), saved = path.join(f.root, 'saved'), env = process.env.CLAUDE_MEMORY_DIR;
  t.after(() => { if (env === undefined) delete process.env.CLAUDE_MEMORY_DIR; else process.env.CLAUDE_MEMORY_DIR = env; });
  delete process.env.CLAUDE_MEMORY_DIR;
  put(path.join(f.target, 'scripts/memory/KIT.local.json'), JSON.stringify({memoryDir: saved}));
  assert.deepEqual(memoryLocation(f.target), {dir: saved, source: 'KIT.local.json'});
  process.env.CLAUDE_MEMORY_DIR = path.join(f.root, 'environment');
  assert.equal(memoryLocation(f.target).source, 'CLAUDE_MEMORY_DIR');
  assert.equal(memoryLocation(f.target, path.join(f.root, 'flag')).source, '--memory-dir');
  delete process.env.CLAUDE_MEMORY_DIR;
  put(configFile(f), JSON.stringify({memory: {inRepoDir: 'notes'}}));
  assert.deepEqual(memoryLocation(f.target), {dir: path.join(f.target, 'notes'), source: 'memory.inRepoDir'});
  fs.unlinkSync(configFile(f)); put(saved, 'file');
  assert.equal(memoryLocation(f.target).source, 'default');
});

test('install and memory-init accept a saved location through a directory alias', t => {
  const f = fixture(t), real = path.join(f.root, 'real'), alias = path.join(f.root, 'alias');
  fs.mkdirSync(real);
  if (!link(t, real, alias)) return;
  put(path.join(f.target, 'scripts/memory/KIT.local.json'), JSON.stringify({memoryDir: path.join(real, 'notes')}));
  ok(f.install(['--memory-dir', path.join(alias, 'notes')]));
  ok(f.cli('scripts/memory/memory-init.mjs', ['--memory-dir', path.join(real, 'notes')], f.target));
  assert.ok(fs.existsSync(path.join(real, 'notes/MEMORY.md')));
});
