// Kit 3.3.7, part A2: a file that cannot be read is named once. readKitJSON used to put "cannot read <file>: " in front of
// every error, including the one readRequired already words "cannot read <file>" or "cannot read <file> (not a regular
// file)", so a special project memory.config.json printed "cannot read <file>: cannot read <file> (not a regular file)".
// Written red first at the 3.3.6 base; each test names its mutant (the one small change that makes it fail).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture, put} from './helpers.mjs';
import {readKitJSON} from '../engine/lib.mjs';

test('A2-T1 a missing file and a folder are named once', t => { // mutant: readKitJSON puts "cannot read <file>: " back in front of every error
  const f = fixture(t), missing = path.join(f.root, 'absent.json'), folder = path.join(f.root, 'folder.json');
  fs.mkdirSync(folder);
  for (const file of [missing, folder]) assert.throws(() => readKitJSON(file), {message: `cannot read ${file}`});
});

test('A2-T2 a fifo, socket or device is named once, with the reason after it', t => { // mutant: readKitJSON puts "cannot read <file>: " back in front of every error
  const f = fixture(t), file = put(path.join(f.root, 'special.json'), '{}\n'), real = fs.statSync;
  // This system cannot make a fifo: the kind check sees one (neither a file nor a folder) for this path only.
  fs.statSync = (target, ...rest) => {
    const stat = real(target, ...rest);
    return typeof target === 'string' && path.resolve(target) === path.resolve(file) ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {isFile: () => false, isDirectory: () => false}) : stat;
  };
  try { assert.throws(() => readKitJSON(file), {message: `cannot read ${file} (not a regular file)`}); }
  finally { fs.statSync = real; }
});

test('A2-T3 content that is read but cannot be used keeps its reason after the file name', t => { // mutant: readKitJSON drops the "cannot read <file>: " prefix for these errors
  const f = fixture(t), broken = put(path.join(f.root, 'broken.json'), '{broken'), list = put(path.join(f.root, 'list.json'), '[]\n');
  assert.throws(() => readKitJSON(broken), error => error.message.startsWith(`cannot read ${broken}: `) && error.message.length > `cannot read ${broken}: `.length && !error.message.includes('\n'));
  assert.throws(() => readKitJSON(list), {message: `cannot read ${list}: expected an object`});
});

test('A2-T4 an object is returned as it is', t => { // mutant: readKitJSON returns undefined or throws for a good file
  const f = fixture(t), file = put(path.join(f.root, 'good.json'), '{"a":1}\n');
  assert.deepEqual(readKitJSON(file), {a: 1});
});
