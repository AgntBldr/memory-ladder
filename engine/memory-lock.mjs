import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {requireMemory, pathKey} from './lib.mjs';

const held = new WeakSet();
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
export function withMemoryLock(memoryDir, run, {lock, timeoutMs = 30000, note = console.error} = {}) {
  requireMemory(memoryDir);
  const file = path.join(memoryDir, '.memory.lock');
  if (lock) {
    if (!held.has(lock) || lock.dir !== pathKey(memoryDir)) throw new Error('invalid memory lock ownership');
    return run(lock);
  }
  const started = Date.now(), token = {dir: pathKey(memoryDir)};
  const transient = error => ['EPERM', 'EBUSY'].includes(error.code);
  let transientSince;
  const retry = error => {
    const now = Date.now();
    if (transient(error)) transientSince ??= now;
    else transientSince = undefined;
    if (now - started >= timeoutMs || (transientSince !== undefined && now - transientSince >= 2000)) {
      if (transient(error)) {
        const hint = error.code === 'EPERM' ? 'the memory folder is not writable here' : 'the lock file is busy or held by another process';
        error.message = `${error.code}: memory lock ${file}; ${hint}`;
        throw error;
      }
      throw new Error('memory lock timed out waiting for ' + file);
    }
    sleep(Math.min(50, Math.max(0, timeoutMs - (now - started)), transientSince === undefined ? 50 : Math.max(0, 2000 - (now - transientSince))));
  };
  const text = JSON.stringify({pid: process.pid, host: os.hostname(), time: new Date().toISOString(), token: randomUUID()}) + '\n';
  for (;;) {
    try { fs.writeFileSync(file, text, {flag: 'wx'}); break; }
    catch (error) {
      if (transient(error)) { retry(error); continue; }
      if (error.code !== 'EEXIST') throw error;
    }
    let current, stat;
    try { stat = fs.statSync(file); current = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT' || transient(error)) { retry(error); continue; }
      throw error;
    }
    transientSince = undefined;
    let owner;
    try { owner = JSON.parse(current); } catch { owner = {}; }
    if (owner?.host && owner.host !== os.hostname()) throw new Error('memory lock belongs to another host; inspect it manually: ' + owner.host);
    const valid = owner && Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.host === 'string' && Number.isFinite(Date.parse(owner.time));
    if ((!valid && Date.now() - stat.mtimeMs > 600000) || (valid && owner.host === os.hostname() && Date.now() - Date.parse(owner.time) > 600000 && !alive(owner.pid))) {
      const stale = file + '.stale-' + randomUUID();
      try { fs.renameSync(file, stale); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      let remove = false;
      try {
        const moved = fs.statSync(stale);
        if (moved.ino !== stat.ino || moved.mtimeMs !== stat.mtimeMs || fs.readFileSync(stale, 'utf8') !== current) {
          // A different owner won the race. Restore without replacing a newer owner.
          try { fs.linkSync(stale, file); remove = true; }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            note('memory lock contention during stale break; inspect ' + stale);
          }
          continue;
        }
        remove = true;
        note('memory lock: broke stale dead-pid lock'); continue;
      } finally { if (remove) fs.rmSync(stale, {force: true}); }
    }
    if (Date.now() - started >= timeoutMs) throw new Error('memory lock timed out waiting for ' + file);
    sleep(Math.min(50, timeoutMs));
  }
  held.add(token);
  try { return run(token); }
  finally {
    held.delete(token);
    try { if (fs.readFileSync(file, 'utf8') === text) fs.unlinkSync(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
