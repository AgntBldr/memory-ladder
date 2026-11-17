import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {requireMemory, pathKey, removeQuietly} from './lib.mjs';

const held = new WeakSet();
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
// name selects the lock file: '.memory.lock' serialises memory writers; '.memory.lock.push' serialises publication
// (kit 3.3.5 E7) and never blocks memory writers. Both use the same ownership, staleness and timeout rules, and each is
// only ever opened, read, broken or removed by its exact name. The push lock's name starts with the memory lock's, so the
// one .memory.lock* ignore line every memory already has covers it, and no existing .gitignore needs a new line.
export const LOCK_NAMES = ['.memory.lock', '.memory.lock.push'];
export const PUSH_LOCK = '.memory.lock.push';
// E2.8 (c): the one predicate for lock files (both locks, and the .stale-<id> names a stale break leaves). Every scope
// comparison, fingerprint, backup, restore, created-file record and claim key uses it; case is ignored, as claim keys
// always did.
export const isLockName = name => /^\.memory\.lock/i.test(String(name));
// Kit 3.3.6 step 0: the same predicate for a relative path (a restore map entry, a scope path, a changed-path list). A path
// names a lock when any of its components does, whichever of / and \ separates them; an empty component and a . component
// (as in ./.memory.lock.x or sub//.memory.lock) are never lock names, so the name test itself skips them.
export const isLockPath = relative => String(relative).split(/[\\/]/).some(part => isLockName(part));
// The memory .gitignore line that keeps both locks out of git; setup and the upgrade append it when it is missing.
export const LOCK_IGNORES = ['.memory.lock*'];
export function withLockIgnores(text) {
  const lines = text.split(/\r?\n/), missing = LOCK_IGNORES.filter(line => !lines.includes(line));
  return missing.length ? text + (text && !text.endsWith('\n') ? '\n' : '') + missing.map(line => line + '\n').join('') : text;
}
export function withMemoryLock(memoryDir, run, {lock, timeoutMs = 30000, note = console.error, name = '.memory.lock'} = {}) {
  requireMemory(memoryDir);
  if (!LOCK_NAMES.includes(name)) throw new Error('invalid lock name ' + name);
  const file = path.join(memoryDir, name);
  if (lock) {
    if (!held.has(lock) || lock.dir !== pathKey(memoryDir) || (lock.name ?? '.memory.lock') !== name) throw new Error('invalid memory lock ownership');
    return run(lock);
  }
  const started = Date.now(), token = {dir: pathKey(memoryDir), name};
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
      } finally { if (remove) removeQuietly(stale, {note}); } // kit 3.3.6 item 9: a stale file that cannot be removed is noted; the acquire goes on
    }
    if (Date.now() - started >= timeoutMs) throw new Error('memory lock timed out waiting for ' + file);
    sleep(Math.min(50, timeoutMs));
  }
  held.add(token);
  // Kit 3.3.5: a failed release never replaces the error run() threw; it is attached to
  // that error as cleanupErrors and noted. After a successful run the release failure is thrown as before.
  // Either way the error that leaves this call carries `lockNotReleased` (the lock file), so a caller that must not act
  // beside a lock it cannot confirm free can tell that failure from any other.
  const release = original => {
    held.delete(token);
    try { if (fs.readFileSync(file, 'utf8') === text) fs.unlinkSync(file); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      if (original === null) throw Object.assign(error, {lockNotReleased: file});
      const message = `memory lock ${file} was not released: ${error.message}`;
      if (original && typeof original === 'object') { (original.cleanupErrors ??= []).push(message); original.lockNotReleased = file; }
      try { note(message); } catch {}
    }
  };
  let value;
  try { value = run(token); }
  catch (error) { release(error ?? {}); throw error; }
  release(null);
  return value;
}
