import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fixture, put, read, json, tree, ok, kitRoot, bump} from './helpers.mjs';
import {lineEndingNote, toolingHints} from '../scripts/install-safety.mjs';

const NOTE = 'NOTE line endings: on Windows Git warns "LF will be replaced by CRLF" for kit files; to silence it for every project run: git config --global core.safecrlf false';
const ESLINT = 'Host eslint: if eslint . collects kit .mjs, exclude scripts/memory/** (flat config global ignores; legacy ignorePatterns).';
const TSCONFIG = 'Host tsconfig: allowJs/checkJs may collect kit .mjs; add scripts/memory/** to exclude when needed.';
const biomeLine = file => `Host Biome: ${file} covers scripts/memory; exclude it ("!scripts/memory" in files.includes for Biome 2, "scripts/memory/**" in files.ignore for Biome 1). Never reformat kit files: they are hashed.`;
const PRETTIER = 'Host Prettier: Prettier covers scripts/memory; add scripts/memory/ to .prettierignore. Never reformat kit files: they are hashed.';
const count = (text, needle) => text.split(needle).length - 1;
const preview = f => ok(f.install(['--dry-run'])).stdout;

// The hints are plain console output; the matrices below call toolingHints on a bare folder and read what it prints.
function bare(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kit-hints-')));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
function hintsOf(dir) {
  const lines = [], log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { toolingHints(dir); } finally { console.log = log; }
  return lines.join('\n');
}

test('C-T12 the line-ending note needs win32 and an unset core.safecrlf', t => {
  const f = fixture(t), saved = [process.env.GIT_CONFIG_GLOBAL, process.env.GIT_CONFIG_NOSYSTEM];
  process.env.GIT_CONFIG_GLOBAL = f.env.GIT_CONFIG_GLOBAL; process.env.GIT_CONFIG_NOSYSTEM = '1';
  t.after(() => {
    for (const [name, value] of [['GIT_CONFIG_GLOBAL', saved[0]], ['GIT_CONFIG_NOSYSTEM', saved[1]]]) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  });
  const base = read(f.env.GIT_CONFIG_GLOBAL);
  assert.equal(lineEndingNote(f.target, 'win32'), NOTE);
  assert.equal(lineEndingNote(f.target, 'linux'), null);
  assert.equal(lineEndingNote(f.target, 'darwin'), null);
  assert.equal(lineEndingNote(f.target, 'win32', 'kit-test-no-such-git-command'), null, 'git missing: nothing');
  for (const value of ['false', 'warn', 'true']) {
    put(f.env.GIT_CONFIG_GLOBAL, base + `[core]\n\tsafecrlf = ${value}\n`);
    assert.equal(lineEndingNote(f.target, 'win32'), null, 'any value counts as set: ' + value);
  }
  put(f.env.GIT_CONFIG_GLOBAL, base);
  assert.equal(lineEndingNote(f.target, 'win32'), NOTE);
  f.git(f.target, 'config', 'core.safecrlf', 'false');
  assert.equal(lineEndingNote(f.target, 'win32'), null, 'a setting in the target repository counts too');
});

test('C-T12 install prints the note once, in the preview and in the real run, on Windows only', t => {
  const f = fixture(t), expected = process.platform === 'win32' ? 1 : 0;
  const before = tree(f.target);
  assert.equal(count(preview(f), NOTE), expected);
  assert.equal(count(ok(f.install(['--check'])).stdout, NOTE), expected);
  assert.deepEqual(tree(f.target), before, 'the preview writes nothing');
  assert.equal(count(ok(f.install()).stdout, NOTE), expected);
  const g = fixture(t);
  put(g.env.GIT_CONFIG_GLOBAL, read(g.env.GIT_CONFIG_GLOBAL) + '[core]\n\tsafecrlf = warn\n');
  assert.equal(count(preview(g), NOTE), 0);
  assert.equal(count(ok(g.install()).stdout, NOTE), 0);
});

test('C-T13 and C-T14 install and upgrade never touch .gitattributes and write no CR byte', t => {
  const f = fixture(t), attributes = path.join(f.target, '.gitattributes');
  const noCR = () => {
    const names = Object.keys(json(path.join(f.target, 'scripts/memory/MANIFEST.json')).files);
    assert.ok(names.length > 40, 'the manifest names the installed kit files: ' + names.length);
    for (const name of [...names, 'scripts/memory/MANIFEST.json']) assert.ok(!fs.readFileSync(path.join(f.target, name)).includes(13), name + ' has a CR byte');
    return names.length;
  };
  ok(f.install());
  assert.ok(!fs.existsSync(attributes), 'install does not create .gitattributes');
  const installed = noCR(), next = bump(f);
  ok(f.cli('scripts/upgrade.mjs', ['--target', f.target, '--live-memory'], next));
  assert.ok(!fs.existsSync(attributes), 'upgrade does not create .gitattributes');
  assert.ok(noCR() >= installed);
  // A host that has the file keeps its exact bytes through both commands.
  const g = fixture(t), mine = Buffer.from('* text=auto\r\n*.sh text eol=lf\r\n# host rule\r\n'), kept = path.join(g.target, '.gitattributes');
  fs.writeFileSync(kept, mine);
  ok(g.install());
  assert.deepEqual(fs.readFileSync(kept), mine, 'install leaves the bytes');
  ok(g.cli('scripts/upgrade.mjs', ['--target', g.target, '--live-memory'], next));
  assert.deepEqual(fs.readFileSync(kept), mine, 'upgrade leaves the bytes');
});

test('C-T15 Biome: the hint is in the preview and after a real install, and the Biome file is never edited', t => {
  const f = fixture(t), file = path.join(f.target, 'biome.json'), original = '{"files":{"includes":["**"]}}\n';
  put(file, original);
  const before = tree(f.target);
  assert.equal(count(preview(f), biomeLine('biome.json')), 1);
  assert.deepEqual(tree(f.target), before, 'the preview writes nothing');
  put(file, '{"files":{"includes":["**","!scripts/memory"]}}\n');
  assert.doesNotMatch(preview(f), /Host Biome/);
  put(file, original);
  assert.equal(count(ok(f.install()).stdout, biomeLine('biome.json')), 1);
  assert.equal(read(file), original);
});

test('C-T15 Biome: both file names, both documented forms, and biome.json is read before biome.jsonc', t => {
  const dir = bare(t);
  for (const name of ['biome.json', 'biome.jsonc']) {
    const file = path.join(dir, name);
    put(file, '{"files":{"includes":["**"]}}\n');
    assert.equal(hintsOf(dir), biomeLine(name));
    for (const covered of ['{"files":{"includes":["**","!scripts/memory"]}}\n', '{"files":{"ignore":["scripts/memory/**"]}}\n']) {
      put(file, covered);
      assert.equal(hintsOf(dir), '', name + ' ' + covered);
    }
    fs.rmSync(file);
  }
  put(path.join(dir, 'biome.json'), '{"files":{"includes":["**","!scripts/memory"]}}\n'); put(path.join(dir, 'biome.jsonc'), '{}\n');
  assert.equal(hintsOf(dir), '');
  put(path.join(dir, 'biome.json'), '{}\n');
  assert.equal(hintsOf(dir), biomeLine('biome.json'));
});

test('C-T16 Prettier: the hint is in the preview and after a real install, and nothing is written', t => {
  const f = fixture(t);
  put(path.join(f.target, '.prettierrc'), '{}\n');
  const before = tree(f.target);
  assert.equal(count(preview(f), PRETTIER), 1);
  assert.deepEqual(tree(f.target), before, 'the preview writes nothing');
  put(path.join(f.target, '.prettierignore'), 'dist/\nscripts/memory/\n');
  assert.doesNotMatch(preview(f), /Host Prettier/);
  fs.rmSync(path.join(f.target, '.prettierignore'));
  assert.equal(count(ok(f.install()).stdout, PRETTIER), 1);
});

test('C-T16 Prettier: every configuration form, and only without scripts/memory in .prettierignore', t => {
  for (const [label, files] of [
    ['.prettierrc', {'.prettierrc': '{}\n'}],
    ['.prettierrc.json', {'.prettierrc.json': '{}\n'}],
    ['.prettierrc.toml', {'.prettierrc.toml': 'semi = false\n'}],
    ['.prettierrc.mjs', {'.prettierrc.mjs': 'export default {};\n'}],
    ['prettier.config.cjs', {'prettier.config.cjs': 'module.exports = {};\n'}],
    ['package.json prettier key', {'package.json': '{"name":"host","prettier":{"semi":false}}\n'}],
  ]) {
    const dir = bare(t);
    for (const [name, text] of Object.entries(files)) put(path.join(dir, name), text);
    assert.equal(hintsOf(dir), PRETTIER, label);
    put(path.join(dir, '.prettierignore'), 'dist/\n');
    assert.equal(hintsOf(dir), PRETTIER, label + ' with an unrelated .prettierignore');
    put(path.join(dir, '.prettierignore'), 'dist/\nscripts/memory/\n');
    assert.equal(hintsOf(dir), '', label + ' with scripts/memory ignored');
  }
  const none = bare(t);
  put(path.join(none, '.prettierignore'), 'dist/\n');
  put(path.join(none, 'package.json'), '{"name":"host","scripts":{"format":"prettier --write ."}}\n');
  assert.equal(hintsOf(none), '', 'no configuration, no hint');
  put(path.join(none, 'package.json'), '{broken');
  assert.equal(hintsOf(none), '', 'an unreadable package.json is not an error');
});

test('C-T17 the ESLint and tsconfig lines are today\'s text, now also in the preview', t => {
  const f = fixture(t);
  put(path.join(f.target, 'eslint.config.mjs'), 'export default [];\n'); put(path.join(f.target, 'tsconfig.json'), '{"compilerOptions":{"allowJs":true,"checkJs":true}}');
  const before = tree(f.target), out = preview(f);
  assert.equal(count(out, ESLINT), 1); assert.equal(count(out, TSCONFIG), 1);
  assert.ok(out.indexOf(ESLINT) < out.indexOf('GATE '), 'before the closing GATE line');
  assert.deepEqual(tree(f.target), before);
  const real = ok(f.install()).stdout;
  assert.equal(count(real, ESLINT), 1); assert.equal(count(real, TSCONFIG), 1);
  assert.match(real, /eslint.*scripts\/memory\/\*\*/i); assert.match(real, /tsconfig.*scripts\/memory\/\*\*/i);
});

test('C-T17 ESLint: every configuration form, suppressed when scripts/memory is already named', t => {
  for (const [label, files] of [
    ['.eslintrc', {'.eslintrc': '{}\n'}],
    ['.eslintrc.json', {'.eslintrc.json': '{}\n'}],
    ['.eslintrc.yml', {'.eslintrc.yml': 'root: true\n'}],
    ['eslint.config.js', {'eslint.config.js': 'module.exports = [];\n'}],
    ['eslint.config.ts', {'eslint.config.ts': 'export default [];\n'}],
    ['package.json eslintConfig', {'package.json': '{"name":"host","eslintConfig":{"root":true}}\n'}],
  ]) {
    const dir = bare(t), [first] = Object.keys(files);
    for (const [name, text] of Object.entries(files)) put(path.join(dir, name), text);
    assert.equal(hintsOf(dir), ESLINT, label);
    put(path.join(dir, '.eslintignore'), 'dist/\n');
    assert.equal(hintsOf(dir), ESLINT, label + ' with an unrelated .eslintignore');
    put(path.join(dir, '.eslintignore'), 'dist/\nscripts/memory/**\n');
    assert.equal(hintsOf(dir), '', label + ' with scripts/memory in .eslintignore');
    fs.rmSync(path.join(dir, '.eslintignore'));
    if (first === 'package.json') put(path.join(dir, first), '{"name":"host","eslintConfig":{"ignorePatterns":["scripts/memory/**"]}}\n');
    else put(path.join(dir, first), read(path.join(dir, first)) + '// scripts/memory/** is ignored here\n');
    assert.equal(hintsOf(dir), '', label + ' with scripts/memory in the configuration');
  }
  const scripts = bare(t);
  put(path.join(scripts, 'package.json'), '{"name":"host","scripts":{"memory:check":"node scripts/memory/memory-check.mjs"},"eslintConfig":{"root":true}}\n');
  assert.equal(hintsOf(scripts), ESLINT, 'a script that mentions scripts/memory does not hide the hint');
  put(path.join(scripts, 'package.json'), '{"name":"host","scripts":{"memory:check":"node scripts/memory/memory-check.mjs"}}\n');
  assert.equal(hintsOf(scripts), '', 'no ESLint configuration, no hint');
});

test('C-T18 tests/memory-label.test.mjs is ASCII and carries the five escaped characters', () => {
  const text = read(path.join(kitRoot, 'tests/memory-label.test.mjs'));
  assert.ok(!/[^\x00-\x7f]/.test(text), 'ASCII only');
  for (const escape of ['\\u2192', "'\\u00e9'", '/\\uFFFD/', '\\u00c9', '\\u2014']) assert.ok(text.includes(escape), escape);
});
