import test from 'node:test';
import {loadConfig} from '../engine/lib.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixture, ok, read, put, json, tree, kitRoot} from './helpers.mjs';

test('3.2.1 installed engine accepts an older project systemFiles list', t => {
  const f = fixture(t), engine = path.join(f.root, 'engine');
  fs.cpSync(path.join(kitRoot, 'engine'), engine, {recursive: true});
  const file = path.join(engine, 'memory.config.json'), config = json(file);
  config.caps.brainIndex.systemFiles = config.caps.brainIndex.systemFiles.filter(name => name !== 'memory-ladder.md');
  config.caps.router.failBytes = 1;
  config.caps.roadmap.path = 'roadmap.md';
  put(file, JSON.stringify(config, null, 2) + '\n');
  const env = {...f.env}; delete env.NODE_TEST_CONTEXT;
  const args = ['--test', '--test-reporter=tap', '--test-name-pattern=K\\.8 index omits every missing system page|F7 index discovers pillar by type and uses configured system files|R12 router\\.size warning branch carries bytes', path.join(engine, 'memory.test.mjs')];
  const result = ok(f.exec(process.execPath, args, {env}));
  assert.match(result.stdout, /^# fail 0\r?$/m);
  assert.ok(Number(result.stdout.match(/^# pass (\d+)/m)?.[1]) >= 3);
  // Redirect the copy to HOST config, rather than deleting the runtime config.
  const entry = path.join(engine, 'memory.test.mjs');
  put(entry, read(entry).replace('JSON.stringify(config)', "fs.readFileSync(path.join(source,'memory.config.json'))"));
  const broken = f.exec(process.execPath, args, {env});
  assert.equal(broken.status, 1); assert.match(broken.stdout, /not ok .*R12 router\.size warning branch carries bytes/);
  assert.doesNotMatch(broken.stderr, /ENOENT/);
  console.log('Hostile host-config copy: '+broken.stdout.match(/^not ok .*R12 router\.size warning branch carries bytes/m)[0]);
  console.log('Isolated copy: '+result.stdout.match(/^# pass \d+/m)[0]+', # fail 0');
});

test('S8 install generates starter pages and owns the installed capture template', t => {
  const f = fixture(t); ok(f.install());
  assert.match(read(path.join(f.memory, 'INDEX-craft-sessions.md')), /^<!-- generated/);
  assert.ok(fs.existsSync(path.join(f.memory, 'INDEX-craft-sessions-all.md')));
  assert.ok(json(path.join(f.target, 'scripts/memory/MANIFEST.json')).files['scripts/memory/templates/lesson.md']);
  const result = ok(f.cli('scripts/memory/memory-lesson.mjs', ['new', '--kind', 'mistake', '--route', 'craft-sessions', 'Installed capture'], f.target));
  assert.match(read(result.stdout.trim()), /description: "TODO"/);
});

test('S8 equal version equal hashes is a no-op and differing engine hashes upgrade', t => {
  const f = fixture(t); ok(f.install()); const before = tree(f.target);
  ok(f.cli('scripts/upgrade.mjs', ['--target', f.target])); assert.deepEqual(tree(f.target), before);
  const file = path.join(f.target, 'scripts/memory/lib.mjs'); put(file, read(file) + '\n// Local drift.\n');
  ok(f.cli('scripts/upgrade.mjs', ['--target', f.target]));
  assert.equal(read(file), read(path.join(kitRoot, 'engine/lib.mjs')));
});

test('S8 upgrade and route migration share a backup and restore both on forced failure', t => {
  const f = fixture(t); ok(f.install());
  const engine = path.join(f.target, 'scripts/memory'), receipt = json(path.join(engine, 'KIT.json'));
  receipt.version = '3.0.0'; put(path.join(engine, 'KIT.json'), JSON.stringify(receipt));
  put(path.join(f.memory, 'MEMORY.md'), '- [Craft](INDEX-craft.md) Before tests.\n');
  put(path.join(f.memory, 'INDEX-craft.md'), '# Keep prose\n- [Lesson](lesson-001-one.md)\n');
  put(path.join(f.memory, 'lesson-001-one.md'), '---\nname: lesson-001-one\ndescription: Useful.\n---\nBody.\r\n');
  const target = tree(f.target), memory = tree(f.memory);
  const driver = put(path.join(f.root, 'failure.mjs'), `import {upgrade} from ${JSON.stringify(pathToFileURL(path.join(kitRoot, 'scripts/upgrade.mjs')).href)};\nprocess.exitCode = upgrade({target: ${JSON.stringify(f.target)}}, ${JSON.stringify(kitRoot)}, {afterMigrate: () => {throw Error('forced after migration');}});\n`);
  const result = f.exec(process.execPath, [driver]);
  assert.equal(result.status, 1); assert.match(result.stderr, /forced after migration/);
  assert.deepEqual(tree(f.target), target); assert.deepEqual(tree(f.memory), memory);
});

test('S9 release defaults and documentation use generated capture and checkpoint', () => {
  const config = json(path.join(kitRoot, 'engine/memory.config.json'));
  assert.equal(config.engine_version, '3.2.9'); // Deliberate release pin: update only for a release.
  assert.equal(config.engine_version, read(path.join(kitRoot, 'VERSION')).trim());
  assert.equal(config.caps.index.hotBytes, 8192); assert.equal(config.caps.roadmap.keepBlocks, 6);
  assert.deepEqual(config.caps.stale.types, ['project', 'reference']);
  for (const file of ['README.md', 'docs/STARTER.md', 'engine/README.md', 'skills/memory-ladder/SKILL.md', 'templates/AGENTS-memory-gate.md']) {
    const text = read(path.join(kitRoot, file));
    assert.match(text, /memory-lesson\.mjs new/); assert.match(text, /memory-checkpoint\.mjs/);
    assert.doesNotMatch(text, /Bump router\/index lesson counts/);
  }
  assert.match(read(path.join(kitRoot, 'CHANGELOG.md')), /3\.2\.0/);
});

test('K.8 index defaults link existing system pages including the memory ladder', async t => {
  const base = fixture(t), f = {repo: base.target, config: loadConfig(), putRepo: (name, text) => put(path.join(base.target, name), text)};
  const { generateIndex } = await import('../engine/brain-index.mjs');
  const names = ['AGENTS.md', 'schema.md', 'edge-cases.md', 'skills-index.md', 'log.md', 'index-all.md', 'agents-background.md', 'memory-ladder.md'];
  for (const name of names) f.putRepo('brain/00-system/' + name, '# System page\n');
  for (const fallback of [false, true]) {
    if (fallback) delete f.config.caps.brainIndex.systemFiles;
    const system = generateIndex(f).index.split('## System\n')[1].split('\n\n## Pillar')[0];
    assert.equal(system, names.map(name => `- [${name}](${name})`).join('\n'));
  }
});

test('K.8 config default places memory ladder after agents background', () => {
  const names = loadConfig().caps.brainIndex.systemFiles;
  assert.equal(names[names.indexOf('agents-background.md') + 1], 'memory-ladder.md');
});

test('K8 release retains a literal pin', () => {
  assert.match(read(path.join(kitRoot, 'tests/release32.test.mjs')), /assert\.equal\(config\.engine_version, '3\.2\.9'\)/);
});
test('K9 index documentation explains shortening', () => {
  const text = read(path.join(kitRoot, 'engine/README.md'));
  assert.match(text, /warnLineChars/); assert.ok(text.includes('\u2026'));
});
