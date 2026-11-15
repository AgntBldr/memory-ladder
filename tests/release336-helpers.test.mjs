// Kit 3.3.6 step 0: unit tests of the four shared helpers (refuseSpecial, removeQuietly and scratchFolder in
// engine/lib.mjs; isLockPath in engine/memory-lock.mjs). No caller uses them yet. The comment beside each test names its
// mutant: the one small change to the helper that makes the test fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {refuseSpecial, removeQuietly, scratchFolder} from '../engine/lib.mjs';
import {isLockPath} from '../engine/memory-lock.mjs';
import {withEnv} from './fixtures-335.mjs';

// A canonical scratch folder for one test, removed when it ends.
function folder(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kit-helpers-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
}
// What a fifo, socket or device shows to a kind check: neither a file nor a folder. This system cannot make a fifo.
const SPECIAL = {isFile: () => false, isDirectory: () => false, isFIFO: () => true};
const stat = fs.statSync, native = fs.realpathSync.native, remove = fs.rmSync;
// statSync answers the table's entry for a path (an error code to throw, an Error to throw, or a stat-like result) and
// the real answer for every other path.
function statAs(t, table) {
  t.mock.method(fs, 'statSync', (file, ...rest) => {
    const key = String(file);
    if (!table.has(key)) return stat(file, ...rest);
    const answer = table.get(key);
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'string') throw Object.assign(new Error(`${answer}: emulated, stat '${key}'`), {code: answer});
    return answer;
  });
}
const busy = target => Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${target}'`), {code: 'EBUSY'});
const failRemoval = (t, target) => t.mock.method(fs, 'rmSync', (file, options) => { if (String(file) === target) throw busy(target); return remove(file, options); });
const tempAt = (dir, run) => withEnv({TEMP: dir, TMP: dir, TMPDIR: dir}, run);
const inside = (base, outer) => `the temporary folder ${base} is inside ${outer}; set TEMP and TMP to a folder outside the project and the memory folder`;

test('3.3.6 refuseSpecial lets a regular file and a folder through', t => { // mutant: refuse a folder (drop the isDirectory test)
  const root = folder(t), file = path.join(root, 'page.md'), dir = path.join(root, 'sub');
  fs.writeFileSync(file, 'text\n'); fs.mkdirSync(dir);
  assert.equal(refuseSpecial(file), undefined);
  assert.equal(refuseSpecial(dir), undefined);
});

test('3.3.6 refuseSpecial treats a path that is absent, or below a file, as absent', t => { // mutant: stop returning for ENOENT or for ENOTDIR
  const root = folder(t), file = path.join(root, 'page.md'), below = path.join(file, 'below.md');
  fs.writeFileSync(file, 'text\n');
  assert.equal(refuseSpecial(path.join(root, 'missing.md')), undefined);
  // A stat below a file says ENOTDIR on POSIX and ENOENT on Windows; emulate it so both spellings are proved here.
  statAs(t, new Map([[below, 'ENOTDIR']]));
  assert.equal(refuseSpecial(below), undefined);
});

test('3.3.6 refuseSpecial refuses a fifo, socket or device with the text of the update\'s own check', t => { // mutant: return for a special file (drop the throw)
  const root = folder(t), special = path.join(root, 'page.md');
  statAs(t, new Map([[special, SPECIAL]]));
  assert.throws(() => refuseSpecial(special), {message: `cannot protect the special file ${special} (a fifo, socket or device cannot be kept or restored); nothing written`});
});

test('3.3.6 refuseSpecial refuses a stat error that is not an absent path, naming the file and the code', t => { // mutant: return for every stat error (fail open)
  const root = folder(t), file = path.join(root, 'page.md');
  for (const code of ['EACCES', 'EPERM', 'ELOOP', 'EIO']) {
    t.mock.restoreAll();
    statAs(t, new Map([[file, code]]));
    assert.throws(() => refuseSpecial(file), {message: `cannot resolve ${file} (${code}); nothing written`});
  }
  // An error without a code is named by its own message, never as (undefined).
  t.mock.restoreAll();
  statAs(t, new Map([[file, new Error('emulated failure')]]));
  assert.throws(() => refuseSpecial(file), {message: `cannot resolve ${file} (emulated failure); nothing written`});
});

test('3.3.6 removeQuietly removes a file and a folder tree and says nothing', t => { // mutant: drop recursive from the removal
  const root = folder(t), file = path.join(root, 'one.txt'), tree = path.join(root, 'tree'), notes = [];
  fs.writeFileSync(file, 'text\n'); fs.mkdirSync(path.join(tree, 'deeper'), {recursive: true}); fs.writeFileSync(path.join(tree, 'deeper', 'two.txt'), 'text\n');
  assert.equal(removeQuietly(file, {note: line => notes.push(line)}), true);
  assert.equal(removeQuietly(tree, {note: line => notes.push(line)}), true);
  assert.ok(!fs.existsSync(file) && !fs.existsSync(tree), 'both are gone');
  assert.deepEqual(notes, []);
});

test('3.3.6 removeQuietly treats an absent target as removed', t => { // mutant: drop force from the removal
  const root = folder(t), notes = [];
  assert.equal(removeQuietly(path.join(root, 'missing'), {note: line => notes.push(line)}), true);
  assert.deepEqual(notes, []);
});

test('3.3.6 removeQuietly turns a removal error into one note and false, and never throws', t => { // mutant: let the removal error out (drop the catch), or note twice
  const root = folder(t), target = path.join(root, 'kept'), notes = [];
  fs.mkdirSync(target); failRemoval(t, target);
  assert.equal(removeQuietly(target, {note: line => notes.push(line)}), false);
  assert.deepEqual(notes, [`could not remove ${target}; delete it by hand (${busy(target).message})`]);
  assert.ok(fs.existsSync(target), 'the folder is still there; only the report changed');
});

test('3.3.6 removeQuietly writes its note to stderr when it is given none', t => { // mutant: write the default note to stdout, or to nowhere
  const root = folder(t), target = path.join(root, 'kept'), errors = [], logs = [];
  fs.mkdirSync(target); failRemoval(t, target);
  t.mock.method(console, 'error', line => errors.push(line)); t.mock.method(console, 'log', line => logs.push(line));
  assert.equal(removeQuietly(target), false);
  assert.deepEqual(errors, [`could not remove ${target}; delete it by hand (${busy(target).message})`]);
  assert.deepEqual(logs, []);
});

test('3.3.6 removeQuietly returns false even when its note throws', t => { // mutant: call the note outside its own try
  const root = folder(t), target = path.join(root, 'kept'), calls = [];
  fs.mkdirSync(target); failRemoval(t, target);
  assert.equal(removeQuietly(target, {note: line => { calls.push(line); throw new Error('stderr is closed'); }}), false);
  assert.equal(calls.length, 1);
});

test('3.3.6 scratchFolder makes its folder under the temporary folder when that is outside every given folder', t => { // mutant: invert the containment test, so an outside folder is refused
  const root = folder(t), tmp = path.join(root, 'tmp'), project = path.join(root, 'project'), memory = path.join(root, 'memory');
  for (const dir of [tmp, project, memory]) fs.mkdirSync(dir);
  const made = tempAt(tmp, () => scratchFolder('plan-', [project, memory]));
  assert.equal(path.dirname(made), tmp);
  assert.ok(path.basename(made).startsWith('plan-') && path.basename(made).length > 'plan-'.length, made);
  assert.deepEqual(fs.readdirSync(made), []);
  // An empty list, and no list, check nothing and still make the folder.
  for (const args of [['a-', []], ['b-']]) assert.ok(fs.statSync(tempAt(tmp, () => scratchFolder(...args))).isDirectory());
});

test('3.3.6 scratchFolder refuses a temporary folder inside any given folder, and makes nothing', t => { // mutant: check only the first folder of the list
  const root = folder(t), project = path.join(root, 'project'), memory = path.join(root, 'memory');
  const inProject = path.join(project, '.tmp'), inMemory = path.join(memory, '.tmp');
  for (const dir of [inProject, inMemory]) fs.mkdirSync(dir, {recursive: true});
  assert.throws(() => tempAt(inProject, () => scratchFolder('plan-', [project, memory])), {message: inside(inProject, project)});
  assert.throws(() => tempAt(inMemory, () => scratchFolder('plan-', [project, memory])), {message: inside(inMemory, memory)});
  assert.deepEqual([fs.readdirSync(inProject), fs.readdirSync(inMemory)], [[], []]);
});

test('3.3.6 scratchFolder counts a temporary folder that is the given folder itself as inside', t => { // mutant: refuse only a strictly inner folder (an equal one passes)
  const root = folder(t), project = path.join(root, 'project');
  fs.mkdirSync(project);
  assert.throws(() => tempAt(project, () => scratchFolder('plan-', [project])), {message: inside(project, project)});
  assert.deepEqual(fs.readdirSync(project), []);
});

test('3.3.6 scratchFolder does not count a sibling that shares the given folder\'s name as inside', t => { // mutant: compare the keys with startsWith and no separator
  const root = folder(t), project = path.join(root, 'project'), sibling = path.join(root, 'project-tmp');
  fs.mkdirSync(project); fs.mkdirSync(sibling);
  assert.equal(path.dirname(tempAt(sibling, () => scratchFolder('plan-', [project]))), sibling);
});

test('3.3.6 scratchFolder resolves a linked temporary folder before it checks, and reports the real one', t => { // mutant: use os.tmpdir() as spelled, without resolving it
  const root = folder(t), project = path.join(root, 'project'), real = path.join(project, '.tmp'), link = path.join(root, 'linked-tmp');
  fs.mkdirSync(real, {recursive: true});
  // A junction needs no privilege on Windows. Where a link cannot be made the resolution is emulated, never skipped.
  try { fs.symlinkSync(real, link, 'junction'); }
  catch { fs.mkdirSync(link); t.mock.method(fs.realpathSync, 'native', file => String(file) === link ? real : native(file)); }
  assert.throws(() => tempAt(link, () => scratchFolder('plan-', [project])), {message: inside(real, project)});
  assert.deepEqual(fs.readdirSync(real), []);
});

test('3.3.6 scratchFolder skips a given folder that does not exist', t => { // mutant: refuse a folder that cannot be resolved (drop the ENOENT skip)
  const root = folder(t), tmp = path.join(root, 'tmp'), project = path.join(root, 'project');
  fs.mkdirSync(tmp); fs.mkdirSync(project);
  const made = tempAt(tmp, () => scratchFolder('plan-', [path.join(root, 'absent'), project]));
  assert.equal(path.dirname(made), tmp);
});

test('3.3.6 scratchFolder keeps checking the folders after a missing one', t => { // mutant: stop the check at the first folder that is missing
  const root = folder(t), project = path.join(root, 'project'), tmp = path.join(project, '.tmp');
  fs.mkdirSync(tmp, {recursive: true});
  assert.throws(() => tempAt(tmp, () => scratchFolder('plan-', [path.join(root, 'absent'), project])), {message: inside(tmp, project)});
});

test('3.3.6 scratchFolder refuses when a given folder cannot be resolved for a reason other than being absent', t => { // mutant: skip every resolution error (fail open)
  const root = folder(t), tmp = path.join(root, 'tmp'), project = path.join(root, 'project');
  fs.mkdirSync(tmp); fs.mkdirSync(project);
  t.mock.method(fs.realpathSync, 'native', file => { if (String(file) === project) throw Object.assign(new Error('EACCES: permission denied'), {code: 'EACCES'}); return native(file); });
  assert.throws(() => tempAt(tmp, () => scratchFolder('plan-', [project])), {message: `cannot resolve ${project} (EACCES); nothing written`});
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('3.3.6 isLockPath finds a lock name in any component of a relative path', () => { // mutant: test the whole path with isLockName, which anchors at the start
  for (const file of ['sub/.memory.lock.push.stale-created', './.memory.lock.stale-dotted', 'a/b/.memory.lock.push', 'sub//.memory.lock', '.memory.lock/child', '.memory.lock', '.memory.lock.push']) assert.equal(isLockPath(file), true, file);
});

test('3.3.6 isLockPath reads a backslash as a separator too', () => { // mutant: split on / only
  for (const file of ['sub\\.memory.lock', '.\\.memory.lock.stale-saved', 'a\\b/.memory.lock.push']) assert.equal(isLockPath(file), true, file);
});

test('3.3.6 isLockPath ignores case, as every lock-name test does', () => { // mutant: drop the i flag from the name test
  for (const file of ['.MEMORY.LOCK', 'sub/.Memory.Lock.Push', 'SUB\\.MEMORY.LOCK.STALE-1']) assert.equal(isLockPath(file), true, file);
});

test('3.3.6 isLockPath does not treat an ordinary name as a lock', () => { // mutant: match the lock spelling anywhere in a component (includes instead of a prefix test)
  for (const file of ['sub/note.md', '.memory.push.lock', 'sub/.memory.push.lock', 'memory.lock', 'x.memory.lock', 'sub/x.memory.lock.push', '.memory.loc', '.sessions/.ledger.json', '', '.', './', '..', 'sub//']) assert.equal(isLockPath(file), false, JSON.stringify(file));
});
