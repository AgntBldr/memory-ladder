// Kit 3.3.6, the update (scripts/upgrade.mjs, and the operator-named inputs scripts/install-safety.mjs reads for it):
// spec items 1, 2, 6, 7, 9, 11a, 12, 18, 21 and 23. The two tests marked pin guard behaviour that did not change. The
// comment beside each test names its mutant: the one small change to the code that makes it fail. This system cannot make a fifo, and may forbid file symlinks: both are emulated in the run's own
// process (the preludes below), as the 3.3.4 and 3.3.5 tests do.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixture, ok, put, read, json, tree, bump, kitRoot, nextVersion, hash} from './helpers.mjs';
import {J, lockless, hookOf, bytes, state, upgrade, backupOf, claim, STUB} from './fixtures-335.mjs';
import {isLockPath} from '../engine/memory-lock.mjs';
import {newCheckFailures} from '../scripts/upgrade.mjs';

const lines = text => String(text).split(/\r?\n/);
const last = text => lines(text).filter(Boolean).at(-1);
// The update as the CLI runs it (its errors printed as scripts/upgrade.mjs prints them), with test hooks and a prelude
// that runs in the same process first. `opts` adds to {target, 'live-memory': true}.
function cli(f, root, {hooks = '', prelude = '', opts = {}, env} = {}) {
  const script = put(path.join(f.root, 'cli-driver.mjs'), `import fs from 'node:fs';
import path from 'node:path';
import {upgrade} from ${J(pathToFileURL(path.join(root, 'scripts/upgrade.mjs')).href)};
${prelude}
try { process.exitCode = upgrade(${J({target: f.target, 'live-memory': true, ...opts})}, ${J(root)}, {${hooks}}); }
catch (error) { console.error('upgrade: ' + String(error.message).replace(/[\\r\\n]+/g, ' ')); process.exitCode = 1; }
`);
  return f.exec(process.execPath, [script], env ? {env} : {});
}
// A fifo, socket or device as every kind check sees it (lstat, stat and a directory listing). A read or a copy of one
// appends its path to `marker` and fails, as a blocked read would never return. With {armed: false} the files are
// ordinary until a hook calls globalThis.armSpecial() (a file that turns special after planning).
const specialShim = (files, marker, {armed = true} = {}) => `{
const specials = new Set(${J(files.map(file => path.resolve(file).toLowerCase()))});
let on = ${armed}; globalThis.armSpecial = () => { on = true; };
const is = file => on && typeof file === 'string' && specials.has(path.resolve(file).toLowerCase());
const fifo = s => Object.assign(Object.create(Object.getPrototypeOf(s)), s, {isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false, isFIFO: () => true});
const real = {lstat: fs.lstatSync, stat: fs.statSync, readFile: fs.readFileSync, copyFile: fs.copyFileSync, readdir: fs.readdirSync};
const blocked = file => { fs.appendFileSync(${J(marker)}, path.resolve(file) + '\\n'); throw Object.assign(new Error('EAGAIN: a read of a fifo would wait: ' + file), {code: 'EAGAIN'}); };
fs.lstatSync = function (file, ...rest) { const s = real.lstat.call(fs, file, ...rest); return s && is(file) ? fifo(s) : s; };
fs.statSync = function (file, ...rest) { const s = real.stat.call(fs, file, ...rest); return s && is(file) ? fifo(s) : s; };
fs.readFileSync = function (file, ...rest) { if (is(file)) blocked(file); return real.readFile.call(fs, file, ...rest); };
fs.copyFileSync = function (from, ...rest) { if (is(from)) blocked(from); return real.copyFile.call(fs, from, ...rest); };
fs.readdirSync = function (dir, options) { const list = real.readdir.call(fs, dir, options); return options?.withFileTypes ? list.map(entry => is(path.join(String(dir), entry.name)) ? fifo(entry) : entry) : list; };
}`;
// A file symlink where this system forbids one (the 3.3.4 linkShim, extended): the link is a regular backing file that
// this process sees as a link. lstat and a directory listing with file types call it a symbolic link (so memoryFiles
// leaves it out, as it does a real link); stat, realpath, readlink, exists, reads, writes and copies go to the file it
// reaches. Other processes (git, the gate) see the backing file, which starts with the same bytes.
const linkShim = links => `{
const links = new Map(${J(Object.entries(links).map(([link, to]) => [path.resolve(link).toLowerCase(), to]))});
const to = file => typeof file === 'string' ? links.get(path.resolve(file).toLowerCase()) : undefined;
const asLink = s => Object.assign(Object.create(Object.getPrototypeOf(s)), s, {isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false});
const real = {lstat: fs.lstatSync, stat: fs.statSync, readlink: fs.readlinkSync, realpath: fs.realpathSync, native: fs.realpathSync.native, exists: fs.existsSync, readFile: fs.readFileSync, writeFile: fs.writeFileSync, copyFile: fs.copyFileSync, readdir: fs.readdirSync};
fs.lstatSync = function (file, ...rest) { const s = real.lstat.call(fs, file, ...rest); return s && to(file) ? asLink(s) : s; };
fs.statSync = function (file, ...rest) { return real.stat.call(fs, to(file) ?? file, ...rest); };
fs.readlinkSync = function (file, ...rest) { return to(file) ?? real.readlink.call(fs, file, ...rest); };
const realpath = function (file, ...rest) { return to(file) ? real.native.call(fs, to(file)) : real.realpath.call(fs, file, ...rest); };
realpath.native = function (file, ...rest) { return real.native.call(fs, to(file) ?? file, ...rest); };
fs.realpathSync = realpath;
fs.existsSync = function (file) { return real.exists.call(fs, to(file) ?? file); };
fs.readFileSync = function (file, ...rest) { return real.readFile.call(fs, to(file) ?? file, ...rest); };
fs.writeFileSync = function (file, ...rest) { return real.writeFile.call(fs, to(file) ?? file, ...rest); };
fs.copyFileSync = function (from, ...rest) { return real.copyFile.call(fs, to(from) ?? from, ...rest); };
fs.readdirSync = function (dir, options) { const list = real.readdir.call(fs, dir, options); return options?.withFileTypes ? list.map(entry => to(path.join(String(dir), entry.name)) ? asLink(entry) : entry) : list; };
}`;
// File symlinks: native ones where this system allows them, else the emulation above (never a skip). `state` is what a
// test compares to prove a link unchanged: its target text, or the emulation's backing bytes.
function linked(f, links) {
  const probe = path.join(f.root, 'link-probe'), target = put(path.join(f.root, 'link-probe-target'), '');
  let native = true;
  try { fs.symlinkSync(target, probe, 'file'); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; native = false; }
  fs.rmSync(probe, {force: true}); fs.rmSync(target, {force: true});
  for (const [link, to] of Object.entries(links)) native ? fs.symlinkSync(to, link, 'file') : put(link, fs.readFileSync(to));
  return {native, prelude: native ? '' : linkShim(links), state: link => native ? fs.readlinkSync(link) : bytes(link)};
}
const special = file => `upgrade: cannot protect the special file ${file} (a fifo, socket or device cannot be kept or restored); nothing written`;
function refusedAsSpecial(f, result, file, marker, before) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(lines(result.stderr).includes(special(file)), result.stdout + result.stderr);
  assert.ok(!fs.existsSync(marker), 'never read: ' + (fs.existsSync(marker) ? read(marker) : ''));
  assert.deepEqual(state(f), before);
}
// fs.rmSync fails with EBUSY for a path that holds `name` (as a Windows temporary folder can), after recording it.
const busy = (name, marker) => `{ const remove = fs.rmSync;
fs.rmSync = function (target, ...rest) { if (String(target).includes(${J(name)})) { fs.appendFileSync(${J(marker)}, String(target) + '\\n'); throw Object.assign(new Error('EBUSY: resource busy or locked, rmdir ' + target), {code: 'EBUSY'}); } return remove.call(fs, target, ...rest); }; }`;
const leftBehind = marker => fs.existsSync(marker) ? lines(read(marker)).filter(Boolean) : [];
const removeLeft = marker => { for (const dir of leftBehind(marker)) fs.rmSync(dir, {recursive: true, force: true}); };
const note = dir => `could not remove ${dir}; delete it by hand (EBUSY: resource busy or locked, rmdir ${dir})`;
// Records each path this process makes or writes (mkdtemp, mkdir, writeFile, a copy's destination) in `log`.
// (appendFileSync writes through writeFileSync, so the recording itself is not recorded.)
const writes = log => `{ let recording = false;
for (const [name, at] of [['mkdtempSync', 0], ['mkdirSync', 0], ['writeFileSync', 0], ['copyFileSync', 1]]) {
  const original = fs[name];
  fs[name] = function (...args) {
    if (!recording) { recording = true; try { fs.appendFileSync(${J(log)}, path.resolve(String(args[at])) + '\\n'); } finally { recording = false; } }
    return original.apply(this, args);
  };
} }`;
const within = (dir, file) => { const a = path.resolve(dir).toLowerCase(), b = path.resolve(file).toLowerCase(); return b === a || b.startsWith(a + path.sep); };
const tempAt = (f, dir) => ({...f.env, TEMP: dir, TMP: dir, TMPDIR: dir});
const insideMessage = (dir, folder) => `upgrade: the temporary folder ${fs.realpathSync.native(dir)} is inside ${folder}; set TEMP and TMP to a folder outside the project and the memory folder; nothing written`;
// A route migration (as A-T15): a handwritten index page the router names.
function handWrittenIndex(dir) {
  put(path.join(dir, 'MEMORY.md'), '- [Craft](INDEX-craft.md) OPEN BEFORE testing.\n');
  put(path.join(dir, 'INDEX-craft.md'), '# Notes\n271. [Topic](topic.md)\n');
  put(path.join(dir, 'topic.md'), '---\nname: topic\ndescription: Useful.\n---\n');
}
const addTopic = dir => put(path.join(dir, 'topic-extra.md'), '---\nname: topic-extra\ndescription: An extra topic that makes the generated index stale.\nmetadata:\n  type: feedback\n  route: craft-sessions\n---\nBody.\n');
const CRAFT_STUB = '---\nname: INDEX-craft\ndescription: "Moved by hand."\nmoved_to: topic.md\n---\n\nSee topic.\n';
const PLAN_REFUSAL = name => `upgrade: cannot plan the memory steps (run the route migration first; refusing to overwrite ${name}); nothing written`;
const RESTORE_REFUSAL = name => `upgrade: restore refused (run the route migration first; refusing to overwrite ${name}); nothing restored`;
const CLAIM_REFUSAL = /^upgrade refused: 1 files pending in other sessions: .* claims current-state\.md; see memory-session list; nothing written$/;

// ---- Item 6: planning reads a planned or named path only after its kind check. ----

test('S6-T7a item 6: a special file at the hook path is never read while planning; the run refuses, nothing written', t => { // mutant: drop the guard before the hook read in planHook
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const hook = hookOf(f.memory), marker = path.join(f.root, 'special-read'), before = state(f);
  refusedAsSpecial(f, cli(f, next, {prelude: specialShim([hook], marker)}), hook, marker, before);
});

// S6-T7c and S6-T7c2 reach the kind check inside lib.mjs read() (spec item 8) first.
test('S6-T7c item 6: a special planned generated page that the listing does not show is refused, never read', t => { // mutant: drop the stat inside read()
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const page = path.join(f.memory, 'INDEX-craft-sessions.md'), marker = path.join(f.root, 'special-read'), before = state(f);
  refusedAsSpecial(f, cli(f, next, {prelude: specialShim([page], marker)}), page, marker, before);
});

test('S6-T7c2 item 6: a special expected generated page on a same-version run is refused, never read', t => { // mutant: drop the stat inside read()
  const f = fixture(t); ok(f.install());
  const page = path.join(f.memory, 'INDEX-craft-sessions.md'), marker = path.join(f.root, 'special-read'), before = state(f);
  refusedAsSpecial(f, cli(f, kitRoot, {prelude: specialShim([page], marker)}), page, marker, before);
});

test('S6-T7z item 6: a special project memory.config.json is refused where planning first reads it (the memory location), never read', t => { // mutant: drop the kind check inside lib.mjs readRequired()
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const file = path.join(f.target, 'scripts/memory/memory.config.json'), marker = path.join(f.root, 'special-read'), before = state(f);
  // memoryLocation reads it through readKitJSON and readRequired, before projectConfig()'s own guard is reached.
  const result = cli(f, next, {prelude: specialShim([file], marker)});
  assert.equal(result.status, 1, result.stdout + result.stderr);
  // Kit 3.3.7 (A2): the file is named once. 3.3.6 printed "cannot read <file>: cannot read <file> (not a regular file)": readKitJSON
  // prefixed its own wording to the message readRequired had already written. The run under test is otherwise unchanged.
  assert.ok(lines(result.stderr).includes(`upgrade: cannot read ${file} (not a regular file)`), result.stdout + result.stderr);
  assert.ok(!fs.existsSync(marker), 'never read: ' + (fs.existsSync(marker) ? read(marker) : ''));
  assert.deepEqual(state(f), before);
});

test('S6-T7d item 6: a special file at a kit file the old manifest lists is refused before planning reads it', t => { // mutant: drop the guard before the hash of the edited-file list
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const file = path.join(f.target, 'scripts/memory/memory-recall.mjs'), marker = path.join(f.root, 'special-read'), before = state(f);
  refusedAsSpecial(f, cli(f, next, {prelude: specialShim([file], marker)}), file, marker, before);
});

test('S6-T7e item 6: a special receipt (KIT.json) is refused before it is read', t => { // mutant: drop the guard before the receipt read
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const file = path.join(f.target, 'scripts/memory/KIT.json'), marker = path.join(f.root, 'special-read'), before = state(f);
  refusedAsSpecial(f, cli(f, next, {prelude: specialShim([file], marker)}), file, marker, before);
});

test('S6-T7f item 6: a special --instructions-decisions file is refused with the special-file message, never read', t => { // mutant: drop the guard in readDecisions
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const file = put(path.join(f.root, 'decisions.json'), '{}\n'), marker = path.join(f.root, 'special-read'), before = state(f);
  refusedAsSpecial(f, cli(f, next, {prelude: specialShim([file], marker), opts: {'instructions-decisions': file}}), file, marker, before);
});

test('S6-T7g item 6: a special memory .gitignore on an update with no route migration is refused, never read', t => { // mutant: drop the guard in predictMemory's before()
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const file = path.join(f.memory, '.gitignore'), marker = path.join(f.root, 'special-read'), before = state(f);
  refusedAsSpecial(f, cli(f, next, {prelude: specialShim([file], marker)}), file, marker, before);
});

test('S6-T7h item 6: a special --instructions-ledger file is refused with the special-file message, never read', t => { // mutant: drop the guard in loadLedger
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const file = put(path.join(f.root, 'ledger.json'), '[]\n'), marker = path.join(f.root, 'special-read'), before = state(f);
  refusedAsSpecial(f, cli(f, next, {prelude: specialShim([file], marker), opts: {'instructions-ledger': file}}), file, marker, before);
});

// The earlier existence checks of scripts/install-safety.mjs that planning runs (each row's file is stat'ed first there):
// a stat error other than ENOENT or ENOTDIR on an existing file is refused with the cannot-resolve wording, not printed as
// the raw Node error. statSync fails with EACCES for that one file; existsSync still finds it.
const deniedStat = file => `{ const stat = fs.statSync, denied = ${J(path.resolve(file).toLowerCase())};
fs.statSync = function (file, ...rest) { if (typeof file === 'string' && path.resolve(file).toLowerCase() === denied) throw Object.assign(new Error('EACCES: permission denied, stat ' + file), {code: 'EACCES'}); return stat.call(fs, file, ...rest); }; }`;
const manifestOf = f => path.join(f.target, 'scripts/memory/MANIFEST.json');
for (const [id, label, mutant, setup] of [
  ['S6-T7k', 'an existing .claude/settings.json', "isRegular back to exists in distributionRefusals' settings check",
    f => path.join(f.target, '.claude', 'settings.json')],
  ['S6-T7l', 'an owned file the new kit retired', "isRegular back to exists in distributionRefusals' old-manifest check",
    f => { const file = put(path.join(f.target, 'scripts/memory/retired-tool.mjs'), '// retired\n'), manifest = json(manifestOf(f));
      manifest.files['scripts/memory/retired-tool.mjs'] = hash(file); put(manifestOf(f), JSON.stringify(manifest, null, 2) + '\n'); return file; }],
  ['S6-T7m', 'a kit skill the old manifest does not list', "isRegular back to exists in skillPlan's new-skill check",
    f => { const manifest = json(manifestOf(f)); delete manifest.files['.claude/skills/memory-review/SKILL.md']; put(manifestOf(f), JSON.stringify(manifest, null, 2) + '\n');
      return path.join(f.target, '.claude/skills/memory-review/SKILL.md'); }],
  ['S6-T7n', 'a skill mirror', "isRegular back to exists in mirrorWrites' mirror check",
    f => put(path.join(f.target, '.agents/skills/memory-review/SKILL.md'), read(path.join(f.target, '.claude/skills/memory-review/SKILL.md')))],
  ['S6-T7o', 'AGENTS.md', "isRegular back to exists in standardBlockPlan's choice of the instruction file",
    f => path.join(f.target, 'AGENTS.md')],
  ['S6-T7p', 'CLAUDE.md', "isRegular back to exists in standardBlockPlan's import-block check",
    f => path.join(f.target, 'CLAUDE.md')],
  ['S6-T7q', 'a .claude/rules file', "isRegular back to exists at the top of instructions()' visit",
    f => put(path.join(f.target, '.claude/rules/house-rules.md'), '# House rules\n')],
  ['S6-T7r', 'a file AGENTS.md names', "isRegular back to exists in instructions()' choice of a mention's path",
    f => { fs.appendFileSync(path.join(f.target, 'AGENTS.md'), '\nAlso: `docs/guide.md`\n'); return put(path.join(f.target, 'docs/guide.md'), '# Guide\n'); }],
]) test(`${id} item 6: a stat error on ${label} is refused with the cannot-resolve wording, nothing written`, t => { // mutant: see the row
  t.diagnostic('mutant: ' + mutant);
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const file = setup(f), before = state(f);
  const result = cli(f, next, {prelude: deniedStat(file)});
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(lines(result.stderr).includes(`upgrade: cannot resolve ${file} (EACCES); nothing written`), result.stdout + result.stderr);
  assert.deepEqual(state(f), before);
});

// The other planning guards of item 6, each the first read of its file for its fixture (the file is special from the
// start), and the one under the lock (the file turns special after the first plan, at the afterPlan hook).
for (const [id, label, mutant, fileOf, hooks] of [
  ['S6-T7v', 'KIT.local.json', 'drop the guard before the KIT.local.json read', f => put(path.join(f.target, 'scripts/memory/KIT.local.json'), fs.existsSync(path.join(f.target, 'scripts/memory/KIT.local.json')) ? read(path.join(f.target, 'scripts/memory/KIT.local.json')) : '{}\n')],
  ['S6-T7w', 'the installed MANIFEST.json', 'drop the guard before the MANIFEST.json read while planning', f => path.join(f.target, 'scripts/memory/MANIFEST.json')],
  ['S6-T7x', 'an installed kit skill', 'drop the guard before the hashes of a skill mirror source', f => path.join(f.target, '.claude/skills/memory-ladder/SKILL.md')],
  ['S6-T7y', 'an engine file the update compares first', 'drop the guard before the hash of the engine-changed test', f => path.join(f.target, 'scripts/memory/brain-index.mjs')],
  ['S6-T7aa', 'the kit folder .gitignore', 'drop the guard before the kit-folder .gitignore read', f => path.join(f.target, 'scripts/memory/.gitignore')],
  ['S6-T7ab', 'MANIFEST.json, turned special after the first plan', 'drop the guard before the MANIFEST.json read under the lock', f => path.join(f.target, 'scripts/memory/MANIFEST.json'), 'afterPlan: () => globalThis.armSpecial()'],
]) test(`${id} item 6: a special file at ${label} is refused before it is read, nothing written`, t => { // mutant: see the row
  t.diagnostic('mutant: ' + mutant);
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const file = fileOf(f), marker = path.join(f.root, 'special-read'), before = state(f);
  refusedAsSpecial(f, cli(f, next, {hooks: hooks ?? '', prelude: specialShim([file], marker, {armed: !hooks})}), file, marker, before);
});

// writeBackup reads each original after the plans and the snapshot; a file that turns special there (at the afterSnapshot
// hook, after every earlier check passed) is refused before any read and before the backup folder exists.
function backupRefused(t, fileOf, prepare = () => {}) {
  const f = fixture(t); ok(f.install()); const next = bump(f); prepare(f);
  const file = fileOf(f), marker = path.join(f.root, 'special-read'), before = state(f), engine = path.join(f.target, 'scripts/memory');
  const backups = () => fs.readdirSync(engine).filter(name => name.startsWith('.kit-backup-'));
  const result = cli(f, next, {hooks: 'afterSnapshot: () => globalThis.armSpecial()', prelude: specialShim([file], marker, {armed: false})});
  refusedAsSpecial(f, result, file, marker, before);
  assert.ok(!/upgrade backup:/.test(result.stdout), result.stdout); assert.deepEqual(backups(), [], 'no backup folder is made');
}

test('S6-T7s item 6: a planned project file that turns special after the snapshot is refused by writeBackup, no backup made', t => { // mutant: drop the guard of the project originals in writeBackup
  backupRefused(t, f => path.join(f.target, 'scripts/memory/lib.mjs'));
});

test('S6-T7t item 6: a planned memory page that turns special after the snapshot is refused by writeBackup, no backup made', t => { // mutant: drop the guard of the linked-page read in writeBackup
  backupRefused(t, f => path.join(f.memory, 'INDEX-craft-sessions.md'), f => addTopic(f.memory));
});

test('S6-T7u item 6, static: writeBackup kind-checks the original of every planned file it reads', async () => { // mutant: drop the guard of the created-page read in writeBackup (at run time the linked-page check meets every such page first)
  const source = fs.readFileSync(path.join(kitRoot, 'scripts/upgrade.mjs'), 'utf8');
  const body = /\nfunction writeBackup\([^)]*\) \{\n([\s\S]*?)\n\}\n/.exec(source)?.[1] ?? '';
  for (const name of ['originals', 'linked', 'created']) {
    const line = body.split('\n').find(text => text.trimStart().startsWith(`const ${name}=`)) ?? '';
    assert.match(line, /bytesOf\(checked\(/, `${name}: ${line}`);
    assert.doesNotMatch(line.replace(/bytesOf\(checked\(/g, ''), /bytesOf\(/, `${name} has an unchecked read: ${line}`);
  }
});

// ---- Item 7: every write and copy path checks the kind. ----

// An installed project updated once: its backup is what the restores below read.
function restorable(t) {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  return {f, next, backup: backupOf(ok(upgrade(f, next, ['--live-memory'])))};
}
function restoreRefused(f, result, file, marker, before) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(lines(result.stderr).includes(`upgrade: refusing to write ${file} (restore): it is a fifo, socket or device`), result.stdout + result.stderr);
  assert.ok(!fs.existsSync(marker), 'never read: ' + (fs.existsSync(marker) ? read(marker) : ''));
  assert.deepEqual(state(f), before);
}

test('S6-T8a item 7: a restore refuses a special project file before writing anything', t => { // mutant: drop the kind reason in safety()
  const {f, next, backup} = restorable(t);
  const file = path.join(f.target, 'scripts/memory/lib.mjs'), marker = path.join(f.root, 'special-read'), before = state(f);
  restoreRefused(f, cli(f, next, {prelude: specialShim([file], marker), opts: {restore: backup}}), file, marker, before);
});

test('S6-T8b item 7: a restore refuses a special memory file that is not a generated page', t => { // mutant: drop the kind reason in safety()
  const {f, next, backup} = restorable(t);
  const file = path.join(f.memory, 'current-state.md'), marker = path.join(f.root, 'special-read'), before = state(f);
  restoreRefused(f, cli(f, next, {prelude: specialShim([file], marker), opts: {restore: backup}}), file, marker, before);
});

test('S6-T8c item 7: a restore with --live-memory refuses a special file at the saved hook path', t => { // mutant: drop the kind reason in safety()
  const {f, next, backup} = restorable(t);
  const hook = json(path.join(backup, 'restore.json')).hook.path, marker = path.join(f.root, 'special-read'), before = state(f);
  restoreRefused(f, cli(f, next, {prelude: specialShim([hook], marker), opts: {restore: backup}}), hook, marker, before);
});

test('S6-T8d item 7: a route migration never copies a memory link whose referent is special', t => { // mutant: drop the guard before the referent copy in simulateMemory
  const f = fixture(t); ok(f.install()); const next = bump(f); handWrittenIndex(f.memory);
  const referent = put(path.join(f.root, 'outside-note.md'), '# Outside note\n'), link = path.join(f.memory, 'linked-note.md');
  put(link, fs.readFileSync(referent));
  const marker = path.join(f.root, 'special-read'), before = state(f);
  // Always the emulated link: a native one would reach the referent without the emulated fifo.
  refusedAsSpecial(f, cli(f, next, {prelude: specialShim([referent], marker) + '\n' + linkShim({[link]: referent})}), link, marker, before);
});

test('S6-T8e item 7: a destination whose stat fails is refused with the cannot-resolve wording, nothing written', t => { // mutant: drop the unresolved marking of a stat error in safety()
  const {f, next, backup} = restorable(t);
  const file = path.join(f.target, 'scripts/memory/lib.mjs'), before = state(f);
  const denied = `{ const stat = fs.statSync, denied = ${J(path.resolve(file).toLowerCase())};
fs.statSync = function (file, ...rest) { if (typeof file === 'string' && path.resolve(file).toLowerCase() === denied) throw Object.assign(new Error('EACCES: permission denied, stat ' + file), {code: 'EACCES'}); return stat.call(fs, file, ...rest); }; }`;
  const result = cli(f, next, {prelude: denied, opts: {restore: backup}});
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(lines(result.stderr).includes(`upgrade: cannot resolve ${file} (EACCES); nothing written`), result.stdout + result.stderr);
  assert.deepEqual(state(f), before);
});

// ---- Item 1: a linked generated destination is read through, not taken for absent. ----

test('S6-T9a item 1: a generated page that links to an unmarked stub is refused by the preview and the run, nothing written', t => { // mutant: files.find(...) alone in generatedOutputs
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const page = path.join(f.memory, 'INDEX-craft-sessions.md'), inner = put(path.join(f.memory, 'pages', 'INDEX-craft-sessions.md'), STUB);
  fs.rmSync(page);
  const link = linked(f, {[page]: inner}), before = state(f), seen = link.state(page);
  const preview = cli(f, next, {prelude: link.prelude, opts: {check: true}});
  assert.equal(preview.status, 1, preview.stdout + preview.stderr);
  assert.ok(lines(preview.stdout).includes(PLAN_REFUSAL('INDEX-craft-sessions.md')), preview.stdout + preview.stderr);
  const result = cli(f, next, {prelude: link.prelude});
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(lines(result.stderr).includes(PLAN_REFUSAL('INDEX-craft-sessions.md')), result.stdout + result.stderr);
  assert.equal(read(inner), STUB); assert.equal(link.state(page), seen); assert.deepEqual(state(f), before);
});

test('S6-T9b item 1: a restore never writes through a link at a generated page to an unmarked stub, at the first check or under the lock', t => { // mutant: files.find(...) alone in generatedOutputs
  const {f, next, backup} = restorable(t);
  const page = path.join(f.memory, 'INDEX-craft-sessions.md'), inner = put(path.join(f.memory, 'pages', 'INDEX-craft-sessions.md'), STUB);
  const saved = fs.readFileSync(path.join(backup, 'memory', 'INDEX-craft-sessions.md'));
  fs.rmSync(page);
  const link = linked(f, {[page]: inner}), before = state(f);
  const first = cli(f, next, {prelude: link.prelude, opts: {restore: backup}});
  assert.equal(first.status, 1, first.stdout + first.stderr);
  assert.ok(lines(first.stderr).includes(RESTORE_REFUSAL('INDEX-craft-sessions.md')), first.stdout + first.stderr);
  assert.equal(read(inner), STUB); assert.deepEqual(state(f), before);
  // At the first check the link reaches the restored bytes (nothing to refuse); the stub lands before the lock.
  fs.writeFileSync(inner, saved);
  const late = cli(f, next, {hooks: `afterPlan: () => fs.writeFileSync(${J(inner)}, ${J(STUB)})`, prelude: link.prelude, opts: {restore: backup}});
  assert.equal(late.status, 1, late.stdout + late.stderr);
  assert.ok(lines(late.stderr).includes(RESTORE_REFUSAL('INDEX-craft-sessions.md')), late.stdout + late.stderr);
  assert.equal(read(inner), STUB);
});

test('S6-T9c item 1, pin: a planned page that links to a marked generated page is still updated, backed up and rolled back', t => { // pin (green at the base, as A-T39); mutant: refuse every link at a generated page
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const copy = path.join(f.root, 'copy'); fs.cpSync(f.memory, copy, {recursive: true}); addTopic(copy);
  const page = 'INDEX-craft-sessions.md', linkPath = path.join(copy, page), inner = put(path.join(copy, 'pages', page), fs.readFileSync(linkPath));
  fs.rmSync(linkPath);
  const link = linked(f, {[linkPath]: inner});
  const before = bytes(inner), seen = link.state(linkPath), memory = lockless(tree(copy)), hook = bytes(hookOf(copy));
  const result = cli(f, next, {hooks: `afterHook: () => { throw Error('injected after the hook refresh'); }`, prelude: link.prelude, opts: {'memory-dir': copy, 'live-memory': false}});
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(lines(result.stderr).some(line => line.startsWith(`upgrade: writes differed from the plan (${hookOf(copy)}); restored `)), result.stdout + result.stderr);
  assert.equal(link.state(linkPath), seen); assert.equal(bytes(inner), before);
  assert.deepEqual(lockless(tree(copy)), memory); assert.equal(bytes(hookOf(copy)), hook);
  const backup = backupOf(result), recovery = json(path.join(backup, 'restore.json'));
  assert.ok(recovery.memory.files.includes(page), 'the linked page is backed up'); assert.equal(bytes(path.join(backup, 'memory', page)), before);
});

// ---- Item 9: a cleanup error never replaces the real result. ----

test('S6-T11a item 9: a verified update whose snapshot folder cannot be removed still exits 0 and names the folder', t => { // mutant: fs.rmSync again in execute's finally
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const marker = path.join(f.root, 'busy');
  try {
    const result = cli(f, next, {prelude: busy('kit-upgrade-scope-', marker)});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(last(result.stdout), /^upgrade: complete \(/);
    const [dir] = leftBehind(marker);
    assert.ok(dir, 'the removal ran and failed');
    assert.ok(lines(result.stderr).includes(note(dir)), result.stderr);
  } finally { removeLeft(marker); }
});

test('S6-T11b item 9: a run that rolls back and cannot remove its snapshot folder exits 1 with the original reason', t => { // mutant: fs.rmSync again in execute's finally
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const marker = path.join(f.root, 'busy'), before = state(f);
  try {
    const result = cli(f, next, {hooks: `afterCopy: n => { if (n === 1) throw Error('injected after the first copy'); }`, prelude: busy('kit-upgrade-scope-', marker)});
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const runLines = lines(result.stderr).filter(line => line.startsWith('upgrade: '));
    assert.match(runLines.at(-1) ?? '', /^upgrade: restored .+: injected after the first copy$/, result.stderr);
    const [dir] = leftBehind(marker);
    assert.ok(dir, 'the removal ran and failed'); assert.ok(lines(result.stderr).includes(note(dir)), result.stderr);
    assert.deepEqual(state(f), before);
  } finally { removeLeft(marker); }
});

test('S6-T11c item 9: the new-check preflight returns its findings when its scratch folder cannot be removed', t => { // mutant: fs.rmSync again in newCheckFailures' finally
  const f = fixture(t); ok(f.install());
  const config = json(path.join(f.target, 'scripts/memory/memory.config.json')); config.caps.brainLog.path = '../outside.md';
  const expected = newCheckFailures(kitRoot, f.target, f.memory, config);
  assert.deepEqual(expected.map(finding => finding.check), ['config.path'], 'a FAIL the preflight reports');
  const remove = fs.rmSync, left = [], notes = [];
  t.mock.method(fs, 'rmSync', (target, ...rest) => { if (String(target).includes('kit-new-checks-')) { left.push(String(target)); throw Object.assign(new Error('EBUSY: resource busy or locked, rmdir ' + target), {code: 'EBUSY'}); } return remove.call(fs, target, ...rest); });
  t.mock.method(console, 'error', line => { notes.push(line); });
  let found;
  try { found = newCheckFailures(kitRoot, f.target, f.memory, config); }
  finally { t.mock.restoreAll(); for (const dir of left) fs.rmSync(dir, {recursive: true, force: true}); }
  assert.deepEqual(found, expected);
  assert.equal(left.length, 1, 'the removal ran and failed'); assert.deepEqual(notes, [note(left[0])]);
});

test('S6-T11d item 9: a snapshot copy that fails is the error printed, not the failed removal of its folder', t => { // mutant: fs.rmSync again in takeSnapshot's catch
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const agents = path.join(f.target, 'AGENTS.md'), marker = path.join(f.root, 'busy'), before = state(f);
  const failCopy = `{ const copy = fs.copyFileSync, from = ${J(path.resolve(agents).toLowerCase())};
fs.copyFileSync = function (source, dest, ...rest) { if (typeof source === 'string' && path.resolve(source).toLowerCase() === from && String(dest).includes('kit-upgrade-scope-')) throw Object.assign(new Error('EACCES: permission denied, copyfile ' + source), {code: 'EACCES'}); return copy.call(fs, source, dest, ...rest); }; }`;
  try {
    const result = cli(f, next, {prelude: failCopy + '\n' + busy('kit-upgrade-scope-', marker)});
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(lines(result.stderr).includes(`upgrade: EACCES: permission denied, copyfile ${agents}`), result.stderr);
    assert.ok(!lines(result.stderr).some(line => line.startsWith('upgrade: EBUSY')), result.stderr);
    const [dir] = leftBehind(marker);
    assert.ok(dir, 'the removal ran and failed'); assert.ok(lines(result.stderr).includes(note(dir)), result.stderr);
    assert.deepEqual(state(f), before);
  } finally { removeLeft(marker); }
});

test('S6-T11g item 9: a change between the plan and the lock is refused as drift when the snapshot folder cannot be removed', t => { // mutant: fs.rmSync again in takeSnapshot's catch
  const f = fixture(t); ok(f.install()); const next = bump(f);
  // The A-T83 drift: a mention reaches its file through a junction that is retargeted between the plan and the lock.
  const a = path.join(f.root, 'a'), b = path.join(f.root, 'b'), via = path.join(f.root, 'via'), other = path.join(f.root, 'other');
  put(path.join(a, 'guide.md'), '# Guide\n'); put(path.join(b, 'guide.md'), '# Guide\n');
  fs.symlinkSync(a, via, 'junction'); fs.symlinkSync(b, other, 'junction');
  fs.appendFileSync(path.join(f.target, 'AGENTS.md'), '\nAlso: `../via/guide.md`\nAlso: `../other/guide.md`\n');
  const marker = path.join(f.root, 'busy'), before = state(f);
  try {
    const result = cli(f, next, {hooks: `afterPlan: () => { fs.rmSync(${J(via)}); fs.symlinkSync(${J(b)}, ${J(via)}, 'junction'); }`, prelude: busy('kit-upgrade-scope-', marker)});
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(lines(result.stderr).some(line => line.startsWith('upgrade: memory or project files changed while planning (')), result.stderr);
    assert.ok(!lines(result.stderr).some(line => line.startsWith('upgrade: EBUSY')), result.stderr);
    const [dir] = leftBehind(marker);
    assert.ok(dir, 'the removal ran and failed'); assert.ok(lines(result.stderr).includes(note(dir)), result.stderr);
    assert.deepEqual(state(f), before);
  } finally { removeLeft(marker); }
});

// ---- Item 2: the restore reads a lock name in any component of a map entry. ----

test('S6-T12 item 2: a restore map naming lock files in a subfolder or behind ./ never rewrites or deletes them', t => { // mutant: isLockName (the whole path) again in restorePlan
  const names = ['sub/.memory.lock.push.stale-created', 'sub/.memory.lock.stale-saved', './.memory.lock.stale-dotted', 'sub\\.memory.lock'];
  for (const name of names) assert.equal(isLockPath(name), true, name);
  assert.equal(isLockPath('.memory.push.lock'), false); assert.equal(isLockPath('sub/note.md'), false);
  const {f, next, backup} = restorable(t);
  const map = path.join(backup, 'restore.json'), recovery = json(map), live = new Map();
  for (const name of names) {
    live.set(name, put(path.resolve(f.memory, name), 'held by a session: ' + name + '\n'));
    put(path.resolve(backup, 'memory', name), 'from the backup\n');
  }
  const kept = put(path.join(f.memory, 'sub', 'note.md'), 'edited after the update\n');
  put(path.join(backup, 'memory', 'sub', 'note.md'), 'saved note\n');
  put(map, JSON.stringify({...recovery, memory: {...recovery.memory, files: [...recovery.memory.files, ...names, 'sub/note.md'], created: [...recovery.memory.created, ...names]}}, null, 2) + '\n');
  const preview = upgrade(f, next, ['--restore', backup, '--check', '--live-memory']);
  assert.ok(lines(preview.stdout).includes('MEMORY RESTORE sub/note.md'), preview.stdout);
  assert.ok(!/\.memory\.lock/.test(preview.stdout), preview.stdout);
  ok(upgrade(f, next, ['--restore', backup, '--live-memory']));
  for (const [name, file] of live) assert.equal(read(file), 'held by a session: ' + name + '\n', name);
  assert.equal(read(kept), 'saved note\n', 'the other entry of the same map is restored');
});

// ---- Item 11a: a folder that vanishes during the path checks refuses. ----

test('S6-T14a item 11a, pin: a destination folder that cannot be resolved during the checks refuses the update, nothing written', t => { // pin (green at the base); mutant: resolve() lets an ENOENT from realpath through as absent
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const folder = path.join(f.target, 'scripts', 'memory'), before = state(f);
  const vanished = `{ const native = fs.realpathSync.native, folder = ${J(folder.toLowerCase())};
fs.realpathSync.native = function (file, ...rest) { if (typeof file === 'string' && path.resolve(file).toLowerCase() === folder && /\\bat parents\\b/.test(new Error().stack)) throw Object.assign(new Error('ENOENT: no such file or directory, realpath ' + file), {code: 'ENOENT'}); return native.call(fs, file, ...rest); }; }`;
  const result = cli(f, next, {prelude: vanished});
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(lines(result.stderr).includes(`upgrade: cannot resolve ${folder} (ENOENT); nothing written`), result.stdout + result.stderr);
  assert.deepEqual(state(f), before);
});

// ---- Item 12: the same-version stub refusal and the preview's refusals. ----

test('S6-T15a item 12a: a same-version run with an unmarked stub at a planned page exits 1 with the reason, no replay line', t => { // mutant: skip the replay refusal on the same-version path
  const f = fixture(t); ok(f.install());
  fs.appendFileSync(path.join(f.memory, 'MEMORY.md'), '- [Craft](INDEX-craft.md) OPEN BEFORE testing.\n');
  put(path.join(f.memory, 'topic.md'), '---\nname: topic\ndescription: Useful.\nmetadata:\n  type: feedback\n  route: craft\n---\nBody.\n');
  put(path.join(f.memory, 'INDEX-craft.md'), CRAFT_STUB);
  const before = state(f);
  const preview = upgrade(f, kitRoot, ['--check', '--live-memory']);
  assert.equal(preview.status, 1, preview.stdout + preview.stderr);
  assert.ok(lines(preview.stdout).includes(PLAN_REFUSAL('INDEX-craft.md')), preview.stdout + preview.stderr);
  const result = upgrade(f, kitRoot, ['--live-memory']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(lines(result.stderr).includes(PLAN_REFUSAL('INDEX-craft.md')), result.stdout + result.stderr);
  assert.ok(!/--memory-only/.test(result.stdout + result.stderr), 'no replay line: ' + result.stdout);
  assert.deepEqual(state(f), before);
});

test('S6-T15b item 12b: the preview names the pending-claims refusal of the real run and exits 1', t => { // mutant: drop the claims check in printPreview
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const holder = claim(f), before = state(f);
  const preview = upgrade(f, next, ['--check', '--live-memory']);
  assert.equal(preview.status, 1, preview.stdout + preview.stderr);
  const line = lines(preview.stdout).find(text => CLAIM_REFUSAL.test(text));
  assert.ok(line && line.includes(holder), preview.stdout);
  assert.deepEqual(state(f), before);
  const real = upgrade(f, next, ['--live-memory']);
  assert.ok(lines(real.stderr).includes(line), 'the real run prints the same refusal on stderr: ' + real.stderr);
  assert.deepEqual(state(f), before);
});

test('S6-T15c item 12b: a restore preview names the generated-output and the claims refusals of the real restore', t => { // mutant: drop restoreOutputs, or the claims check, in the restore's --check branch
  const {f, next, backup} = restorable(t);
  const page = put(path.join(f.memory, 'INDEX-craft-sessions.md'), STUB), before = state(f);
  const preview = upgrade(f, next, ['--restore', backup, '--check', '--live-memory']);
  assert.equal(preview.status, 1, preview.stdout + preview.stderr);
  assert.ok(lines(preview.stdout).includes(RESTORE_REFUSAL('INDEX-craft-sessions.md')), preview.stdout);
  assert.deepEqual(state(f), before);
  // With the saved page back, a live claim is the refusal the real restore gives.
  fs.writeFileSync(page, fs.readFileSync(path.join(backup, 'memory', 'INDEX-craft-sessions.md')));
  const holder = claim(f), held = state(f);
  const claimed = upgrade(f, next, ['--restore', backup, '--check', '--live-memory']);
  assert.equal(claimed.status, 1, claimed.stdout + claimed.stderr);
  assert.ok(lines(claimed.stdout).some(line => CLAIM_REFUSAL.test(line) && line.includes(holder)), claimed.stdout);
  assert.ok(!lines(claimed.stdout).some(line => line.startsWith('upgrade: restore refused')), claimed.stdout);
  assert.deepEqual(state(f), held);
});

test('S6-T15d item 12b: the preview of a downgrade names the refusal and exits 1', t => { // mutant: drop the downgrade line in printPreview
  const f = fixture(t); ok(f.install());
  const receipt = path.join(f.target, 'scripts/memory/KIT.json');
  put(receipt, JSON.stringify({...json(receipt), version: nextVersion}, null, 2) + '\n');
  const before = state(f);
  const preview = upgrade(f, kitRoot, ['--check']);
  assert.equal(preview.status, 1, preview.stdout + preview.stderr);
  assert.ok(lines(preview.stdout).includes('upgrade: Refusing a downgrade'), preview.stdout);
  const real = upgrade(f, kitRoot, []);
  assert.equal(real.status, 1, real.stdout + real.stderr);
  assert.ok(lines(real.stderr).includes('upgrade: Refusing a downgrade'), real.stderr);
  assert.deepEqual(state(f), before);
});

// ---- Item 18: the update's scratch folders are never inside the project or memory. ----

test('S6-T20b item 18: a preview of a route migration with TEMP inside the project refuses, nothing written', t => { // mutant: the planning copy's folder made without the location check
  const f = fixture(t); ok(f.install()); const next = bump(f); handWrittenIndex(f.memory);
  const tmp = path.join(f.target, '.tmp'); fs.mkdirSync(tmp);
  const before = state(f), result = upgrade(f, next, ['--check', '--live-memory'], tempAt(f, tmp));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(lines(result.stderr).includes(insideMessage(tmp, f.target)), result.stdout + result.stderr);
  assert.deepEqual(fs.readdirSync(tmp), []); assert.deepEqual(state(f), before);
});

test('S6-T20c item 18: a route migration with TEMP inside the project refuses while planning, before any scratch write there', t => { // mutant: the planning copy's folder made without the location check
  const f = fixture(t); ok(f.install()); const next = bump(f); handWrittenIndex(f.memory);
  const tmp = path.join(f.target, '.tmp'), log = path.join(f.root, 'writes'); fs.mkdirSync(tmp);
  const before = state(f), result = cli(f, next, {prelude: writes(log), env: tempAt(f, tmp)});
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(lines(result.stderr).includes(insideMessage(tmp, f.target)), result.stdout + result.stderr);
  assert.deepEqual((fs.existsSync(log) ? lines(read(log)) : []).filter(file => file && within(tmp, file)), []);
  assert.deepEqual(state(f), before);
});

test('S6-T20d item 18: an update with no route migration and TEMP inside memory refuses before any scratch write, with no rollback', t => { // mutant: the new-check preflight's folder made without the location check
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const tmp = path.join(f.memory, '.tmp'), log = path.join(f.root, 'writes'); fs.mkdirSync(tmp);
  const before = state(f), result = cli(f, next, {prelude: writes(log), env: tempAt(f, tmp)});
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(lines(result.stderr).includes(insideMessage(tmp, f.memory)), result.stdout + result.stderr);
  assert.ok(!/upgrade backup:/.test(result.stdout) && !/restored/.test(result.stderr), 'refused before the backup: ' + result.stdout + result.stderr);
  assert.deepEqual((fs.existsSync(log) ? lines(read(log)) : []).filter(file => file && within(tmp, file)), []);
  assert.deepEqual(fs.readdirSync(tmp), []); assert.deepEqual(state(f), before);
});

test('S6-T20g item 18: a --memory-only replay with TEMP inside memory refuses at the scope snapshot, its first scratch folder', t => { // mutant: the scope snapshot's folder made without the location check (the replay makes no new-check or planning copy)
  const f = fixture(t); ok(f.install()); addTopic(f.memory);
  const tmp = path.join(f.memory, '.tmp'), log = path.join(f.root, 'writes'); fs.mkdirSync(tmp);
  const before = state(f), result = cli(f, kitRoot, {prelude: writes(log), opts: {'memory-only': true}, env: tempAt(f, tmp)});
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(lines(result.stderr).includes(insideMessage(tmp, f.memory)), result.stdout + result.stderr);
  assert.ok(!/upgrade backup:/.test(result.stdout) && !/restored/.test(result.stderr), 'refused before the backup: ' + result.stdout + result.stderr);
  assert.deepEqual((fs.existsSync(log) ? lines(read(log)) : []).filter(file => file && within(tmp, file)), []);
  assert.deepEqual(fs.readdirSync(tmp), []); assert.deepEqual(state(f), before);
});

// ---- Item 21: the read fingerprints do not depend on listing order. ----

test('S6-T21 item 21: two .claude/rules names linked to one document, listed in another order under the lock, still complete the update', t => { // mutant: drop both listing sorts (disk view and planned view); either sort alone masks the other's removal for this fixture
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const shared = put(path.join(f.target, 'docs', 'shared-rules.md'), '# Shared rules\n'), rules = path.join(f.target, '.claude', 'rules');
  fs.mkdirSync(rules, {recursive: true});
  const link = linked(f, {[path.join(rules, 'a-rules.md')]: shared, [path.join(rules, 'b-rules.md')]: shared});
  // From the afterPlan hook on (after the first listing, before the lock), the rules folder is listed in reverse.
  const flip = `{ const readdir = fs.readdirSync, folder = ${J(rules.toLowerCase())};
globalThis.flipRules = () => { fs.readdirSync = function (dir, options) { const list = readdir.call(fs, dir, options); return typeof dir === 'string' && path.resolve(dir).toLowerCase() === folder && !options?.withFileTypes ? [...list].reverse() : list; }; }; }`;
  const result = cli(f, next, {hooks: 'afterPlan: () => globalThis.flipRules()', prelude: link.prelude + '\n' + flip});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(last(result.stdout), /^upgrade: complete \(/);
});

// Each listing on its own: the disk view's (a folder as the system lists it) and the planned view's (the plan's creations
// and deletions applied). The views are imported inside the tests so this file still loads where they are not exported.
function orderFolder(t, names) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kit-order-')));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  for (const name of names) put(path.join(dir, name), '# ' + name + '\n');
  return dir;
}

test('S6-T21b item 21: the disk view lists a folder sorted, whatever order the system returns', async t => { // mutant: drop the sort of the disk view's list()
  const {diskViewOf} = await import('../scripts/upgrade.mjs');
  const dir = orderFolder(t, ['a-rules.md', 'b-rules.md', 'c-rules.md']), readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (folder, ...rest) => { const list = readdir.call(fs, folder, ...rest); return String(folder) === dir && !rest[0]?.withFileTypes ? [...list].reverse() : list; });
  assert.deepEqual(diskViewOf().list(dir), ['a-rules.md', 'b-rules.md', 'c-rules.md']);
});

test('S6-T21c item 21: the planned view lists a folder sorted, with the plan\'s creations and deletions applied', async t => { // mutant: drop the sort of the planned view's list()
  const {plannedView} = await import('../scripts/upgrade.mjs');
  const dir = orderFolder(t, ['b-rules.md', 'c-rules.md']);
  // The plan creates a name that sorts first and deletes one on disk: added at the end, it must still list in order.
  const view = plannedView([[path.join(dir, 'a-rules.md'), Buffer.from('# a\n')], [path.join(dir, 'c-rules.md'), null]], {resolved: new Map()}, new Map());
  assert.deepEqual(view.list(dir), ['a-rules.md', 'b-rules.md']);
});

// ---- Item 23: instruction files outside the project are compared by digest, never copied. ----

test('S6-T23 item 23: instruction files outside the project, named by a full or a ../ path, are never copied to the temporary folder', t => { // mutant: copy every file entry again in takeSnapshot
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const absolute = put(path.join(f.root, 'outside-absolute.md'), '# Outside, named by its full path\n');
  const relative = put(path.join(f.root, 'outside-relative.md'), '# Outside, named relatively\n');
  fs.appendFileSync(path.join(f.target, 'AGENTS.md'), `\nAlso: \`${absolute.replace(/\\/g, '/')}\`\nAlso: \`../outside-relative.md\`\n`);
  const log = path.join(f.root, 'copied');
  const spy = `{ const copy = fs.copyFileSync; fs.copyFileSync = function (from, ...rest) { fs.appendFileSync(${J(log)}, path.resolve(String(from)).toLowerCase() + '\\n'); return copy.call(fs, from, ...rest); }; }`;
  const result = cli(f, next, {prelude: spy});
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(last(result.stdout), /^upgrade: complete \(/);
  const copied = lines(read(log)).filter(Boolean);
  assert.ok(copied.includes(path.resolve(f.target, 'AGENTS.md').toLowerCase()), 'the snapshot copied the files in the project');
  for (const file of [absolute, relative]) assert.ok(!copied.includes(path.resolve(file).toLowerCase()), file + ' was copied');
  assert.equal(read(absolute), '# Outside, named by its full path\n'); assert.equal(read(relative), '# Outside, named relatively\n');
});
