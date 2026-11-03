import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture, put, read, json, kitRoot, ok} from './helpers.mjs';
import {withMemoryLock} from '../engine/memory-lock.mjs';
import {mergeNewSessionHooks, sessionSettings, distributionRefusals} from '../scripts/install-safety.mjs';
import {readCurrent} from '../engine/session-core.mjs';
import {FIRST_REPLY_TEMPLATE} from '../engine/new-session.mjs';

const permissions = ['Bash', 'PowerShell'].map(tool => `${tool}(node scripts/memory/new-session.mjs:*)`);
const template = json(path.join(kitRoot, 'templates/settings.newsession.json'));
test('both permissions added once and removed; accurate real and preview reports', () => {
  const settings = {}, local = {}, lines = [], log = console.log;
  console.log = line => lines.push(line);
  try {
    sessionSettings(settings, local, {}, kitRoot);
    assert.deepEqual(settings.permissions.allow, permissions);
    for (const permission of permissions) assert.ok(lines.some(line => line.includes(`permission ${permission}: allowed`)));
    settings.permissions.allow.push(...permissions);
    mergeNewSessionHooks(settings, template);
    assert.deepEqual(settings.permissions.allow, permissions);
    for (const opts of [{}, {check: true}]) {
      lines.length = 0; sessionSettings(settings, local, opts, kitRoot);
      for (const permission of permissions) assert.ok(lines.some(line => line.includes(`permission ${permission}: present`)));
    }
    lines.length = 0; sessionSettings(structuredClone(settings), {}, {'no-new-session-hook': true, check: true}, kitRoot);
    for (const permission of permissions) assert.ok(lines.some(line => line.includes(`permission ${permission}: would remove`)));
    lines.length = 0; sessionSettings(settings, local, {'no-new-session-hook': true}, kitRoot);
    for (const permission of permissions) assert.ok(lines.some(line => line.includes(`permission ${permission}: removed`)));
    assert.deepEqual(settings.permissions.allow, []); assert.equal(local.newSessionHook, false);
    for (const opts of [{}, {check: true}]) {
      lines.length = 0; sessionSettings(settings, local, opts, kitRoot);
      for (const permission of permissions) assert.ok(lines.some(line => line.includes(`permission ${permission}: absent`)));
    }
    lines.length = 0; sessionSettings(settings, {newSessionHook: true}, {check: true}, kitRoot);
    for (const permission of permissions) assert.ok(lines.some(line => line.includes(`permission ${permission}: would allow`)));
  } finally { console.log = log; }
});
test('same installed helper spellings are present and opt-out reports kept hand-wired hook', t => {
  const f = fixture(t);
  for (const script of ['./scripts/memory/new-session.mjs', '.\\scripts\\memory\\new-session.mjs', path.join(f.target, 'scripts/memory/new-session.mjs')]) for (const node of ['node', 'node.exe']) {
    const command = `${node} "${script}" detect`, settings = {hooks: {UserPromptSubmit: [{hooks: [{command}]}]}, permissions: {allow: [...permissions]}};
    assert.equal(mergeNewSessionHooks(settings, template, true, f.target), false, command);
    const lines = [], log = console.log; console.log = line => lines.push(line);
    try { sessionSettings(settings, {}, {'no-new-session-hook': true, target: f.target}, kitRoot); }
    finally { console.log = log; }
    assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, command);
    assert.ok(lines.some(line => /hand-wired.*kept/.test(line)));
  }
});
for (const operation of ['writeFileSync', 'statSync', 'readFileSync']) for (const code of ['EPERM', 'EBUSY']) {
  test(`lock retries ${operation} ${code} and preserves timeout error identity`, t => {
    const f = fixture(t), dir = path.join(f.root, 'memory'); fs.mkdirSync(dir);
    const file = path.join(dir, '.memory.lock'), original = fs[operation], write = fs.writeFileSync;
    const error = Object.assign(Error('pending deletion'), {code}); let attempts = 0, permanent = false;
    if (operation !== 'writeFileSync') t.mock.method(fs, 'writeFileSync', (target, ...args) => {
      if (target === file && (attempts === 0 || permanent)) throw Object.assign(Error('exists'), {code: 'EEXIST'});
      return write(target, ...args);
    });
    t.mock.method(fs, operation, (target, ...args) => {
      if (target === file && (permanent || attempts++ === 0)) throw error;
      return original(target, ...args);
    });
    // stat succeeds before the read fault, without requiring a real competing process.
    if (operation === 'readFileSync') t.mock.method(fs, 'statSync', (target, ...args) => target === file ? {mtimeMs: Date.now()} : fs.lstatSync(target, ...args));
    assert.equal(withMemoryLock(dir, () => 'acquired', {timeoutMs: 300}), 'acquired');
    permanent = true;
    assert.throws(() => withMemoryLock(dir, () => assert.fail('acquired'), {timeoutMs: 20}), value => value === error);
  });
}
test('skills expose shapes verbatim report and an unnumbered start template', () => {
  const handover = read(path.join(kitRoot, 'skills/handover/SKILL.md'));
  assert.match(handover, /strings state 240, question\/lessons 320, waits\/risks\/constraints 240 B/);
  assert.match(handover, /closed: \{step: ok\|failed\} for overlay close: steps only/);
  assert.match(handover, /Reply: printed report verbatim \+ <=1 line; never type SAFE/);
  const skill = read(path.join(kitRoot, 'skills/new-session/SKILL.md'));
  assert.equal(FIRST_REPLY_TEMPLATE.split('\n')[0], '**<abs path>** - `<branch>` @ `<sha>` - kit <version>[ - flags: ...]');
  assert.doesNotMatch(FIRST_REPLY_TEMPLATE, /^\d+ /m);
  assert.ok(skill.includes(FIRST_REPLY_TEMPLATE));
  assert.match(skill, /one bullet per item.*omit empty groups and lines saying none \(not Goal\)/);
  assert.match(skill, /`Waiting for your go\.`/);
});
test('public host setup and release remedies', () => {
  const readme = read(path.join(kitRoot, 'README.md')), starter = read(path.join(kitRoot, 'docs/STARTER.md')), changes = read(path.join(kitRoot, 'CHANGELOG.md')).split('## 3.2.12')[0];
  assert.match(readme, /workspace-write[\s\S]*\.git[\s\S]*Claude Code/);
  for (const text of [readme, starter]) {
    assert.doesNotMatch(text, /the two procedures/);
    assert.match(text, /\.claude\/skills\/new-session\/`/);
    assert.match(text, /\.claude\/skills\/handover\/`/);
    assert.match(text, /\.agents\/skills/);
  }
  assert.match(starter, /UserPromptSubmit[^\n]*phrase/);
  const commit = starter.slice(starter.indexOf('5. **Commit'), starter.indexOf('6. **First'));
  for (const skill of ['new-session', 'handover']) {
    assert.ok(commit.includes(`.claude/skills/${skill}/`));
    assert.ok(readme.split('\n').find(line => line.includes('git add scripts/memory')).includes(`.claude/skills/${skill}`));
  }
  assert.match(commit, /\.agents\/skills/);
  assert.match(changes, /install refuses unless `--replace-skill/);
  assert.match(changes, /settings\.local\.json[\s\S]*remove the hook/);
});
test('both permissions persist through install upgrade opt-out and restoration', t => {
  const f = fixture(t); ok(f.install());
  const file = path.join(f.target, '.claude/settings.json');
  const upgrade = args => f.cli('scripts/upgrade.mjs', ['--target', f.target, ...args]);
  assert.deepEqual(json(file).permissions.allow, permissions);
  const settings = json(file); settings.permissions.allow = [permissions[0]]; put(file, JSON.stringify(settings));
  const preview = upgrade(['--check']); assert.equal(preview.status, 1);
  assert.ok(preview.stdout.includes(`permission ${permissions[0]}: present`));
  assert.ok(preview.stdout.includes(`permission ${permissions[1]}: would allow`));
  ok(upgrade([])); assert.deepEqual(json(file).permissions.allow, permissions);
  ok(upgrade(['--no-new-session-hook'])); assert.deepEqual(json(file).permissions.allow, []);
  ok(upgrade([])); assert.deepEqual(json(file).permissions.allow, []);
  const local = path.join(f.target, 'scripts/memory/KIT.local.json'); put(local, JSON.stringify({...json(local), newSessionHook: true}));
  ok(upgrade([])); assert.deepEqual(json(file).permissions.allow, permissions);
});
test('only incoming ledger accepts boolean true', t => {
  const f = fixture(t), root = path.join(f.root, 'kit');
  put(path.join(f.target, '.claude/settings.json'), JSON.stringify({hooks: {Stop: [{hooks: [{command: 'node wave-save.mjs'}]}]}}));
  put(path.join(f.target, 'scripts/memory/upgrades.json'), JSON.stringify([{waveSave: {supportsHandover: true}}]));
  for (const marker of [1, false, 'true', undefined]) {
    put(path.join(root, 'engine/upgrades.json'), JSON.stringify([{waveSave: {supportsHandover: marker}}]));
    assert.equal(distributionRefusals(f.target, root).length, 1);
  }
});
test('CURRENT accepts lone CR line ends', t => {
  const f = fixture(t);
  put(path.join(f.root, 'current-state.md'), '## CURRENT\r**State:** ready\r**Open question:** next?\r## Other\rignored\r');
  const current = readCurrent(f.root);
  assert.equal(current.fields.State, 'ready'); assert.equal(current.fields['Open question'], 'next?');
  assert.doesNotMatch(current.block, /ignored/);
});
test('upgrade rechecks distribution after acquiring the lock', t => {
  const f = fixture(t); ok(f.install());
  const settings = path.join(f.target, '.claude/settings.json');
  const preload = put(path.join(f.root, 'race.cjs'), `const fs = require('node:fs'); const write = fs.writeFileSync; fs.writeFileSync = function(file, ...args) { const result = write.call(this, file, ...args); if (String(file).endsWith('.memory.lock')) { const file = ${JSON.stringify(settings)}; const data = JSON.parse(fs.readFileSync(file)); data.hooks.Stop = [{hooks:[{command:'node wave-save.mjs stop'}]}]; write(file, JSON.stringify(data)); } return result; };`);
  const result = f.exec(process.execPath, ['--require', preload, path.join(kitRoot, 'scripts/upgrade.mjs'), '--target', f.target]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /wave-save refused/);
  assert.ok(!fs.readdirSync(path.join(f.target, 'scripts/memory')).some(name => name.startsWith('.kit-backup-')));
});
