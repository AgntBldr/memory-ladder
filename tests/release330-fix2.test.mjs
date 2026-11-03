import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fixture} from './helpers.mjs';
import {withMemoryLock} from '../engine/memory-lock.mjs';

for (const operation of ['writeFileSync', 'statSync', 'readFileSync']) for (const code of ['EPERM', 'EBUSY']) {
  test(`fix2.6 fix3.5 permanent ${operation} ${code} stops under 3 seconds with a cause-specific hint`, t => {
    const f = fixture(t), dir = path.join(f.root, 'memory'); fs.mkdirSync(dir);
    const file = path.join(dir, '.memory.lock'), original = fs[operation], write = fs.writeFileSync;
    const error = Object.assign(Error(`${code}: ${code === 'EPERM' ? 'operation not permitted' : 'resource busy'}, ${operation} '${file}'`), {code});
    let attempts = 0;
    if (operation !== 'writeFileSync') t.mock.method(fs, 'writeFileSync', (target, ...args) => {
      if (target === file) throw Object.assign(Error('exists'), {code: 'EEXIST'});
      return write(target, ...args);
    });
    if (operation === 'readFileSync') t.mock.method(fs, 'statSync', (target, ...args) => target === file ? {mtimeMs: Date.now()} : fs.lstatSync(target, ...args));
    t.mock.method(fs, operation, (target, ...args) => {
      if (target === file) { attempts++; throw error; }
      return original(target, ...args);
    });
    const started = Date.now();
    const options = operation === 'writeFileSync' && code === 'EPERM' ? {} : {timeoutMs: 4000};
    assert.throws(() => withMemoryLock(dir, () => assert.fail('must not acquire'), options), value => {
      assert.equal(value.code, code);
      assert.ok(value.message.includes(file));
      assert.equal((value.message.match(new RegExp(code, 'g')) || []).length, 1);
      assert.match(value.message, code === 'EPERM' ? /the memory folder is not writable here/ : /the lock file is busy or held by another process/);
      if (code === 'EBUSY') assert.doesNotMatch(value.message, /not writable/);
      return true;
    });
    assert.ok(Date.now() - started < 3000);
    assert.ok(attempts > 1, 'still allows a transient retry window');
  });
}

test('fix2.6 successful owner inspection resets the consecutive transient window', t => {
  const f = fixture(t), dir = path.join(f.root, 'memory'); fs.mkdirSync(dir);
  const file = path.join(dir, '.memory.lock'), write = fs.writeFileSync, read = fs.readFileSync, stat = fs.statSync;
  let elapsed = 0, inspected = false;
  const start = Date.now();
  t.mock.method(Date, 'now', () => start + elapsed);
  t.mock.method(Atomics, 'wait', (_array, _index, _value, ms) => { elapsed += ms; return 'timed-out'; });
  t.mock.method(fs, 'writeFileSync', (target, ...args) => {
    if (target === file && elapsed < 3900) {
      const code = elapsed >= 1900 && !inspected ? 'EEXIST' : elapsed % 100 ? 'EPERM' : 'EBUSY';
      throw Object.assign(Error('busy'), {code});
    }
    return write(target, ...args);
  });
  t.mock.method(fs, 'statSync', (target, ...args) => target === file && !inspected ? {mtimeMs: start} : stat(target, ...args));
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    if (target === file && !inspected) {
      inspected = true;
      return JSON.stringify({pid: process.pid, host: os.hostname(), time: new Date(start).toISOString()});
    }
    return read(target, ...args);
  });
  assert.equal(withMemoryLock(dir, () => 'acquired'), 'acquired');
  assert.equal(inspected, true);
  assert.equal(elapsed, 3900);
});
