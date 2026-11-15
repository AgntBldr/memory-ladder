// Kit 3.3.5 lane E: sessions, claims and the ledger (spec E2). A session is one checkout on one branch; it claims the
// memory files it writes, and a session-mode checkpoint commits only its own claims. Ledgers live in
// <memory>/.sessions/<id>.json, are replaced atomically under the memory lock, and only by their own session.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {isDirect, loadConfig, readRequired, slash, locations, cleanGitEnv} from './lib.mjs';
import {withMemoryLock, isLockPath, PUSH_LOCK} from './memory-lock.mjs';

export const SESSIONS = '.sessions';
export const STALE = 'stale';
export {PUSH_LOCK};
const fold = value => process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value;
const within = (root, file) => {
  const rel = path.relative(fold(root), fold(file));
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};
const sameOrWithin = (root, file) => fold(path.resolve(root)) === fold(path.resolve(file)) || within(root, file);

// Every git call here is literal (E2.3): pathspec magic and glob characters in a file name never widen a selection.
// E2.8 (e): every call starts from the cleaned environment (lib.mjs cleanGitEnv), so an inherited GIT_DIR or
// GIT_WORK_TREE never points a ledger inspection or a save at another repository; only `env` given here adds them.
export function gitRun(dir, argv, {literal = true, env, input, timeout = 120000} = {}) {
  const r = spawnSync('git', [...(literal ? ['--literal-pathspecs'] : []), '--no-optional-locks', '-C', dir, ...argv],
    {encoding: input instanceof Buffer ? undefined : 'utf8', windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024, env: {...cleanGitEnv(process.env), ...env}, input});
  if (r.error) throw r.error;
  return r;
}
export function gitOut(dir, argv, options) {
  const r = gitRun(dir, argv, options);
  if (r.status !== 0) throw new Error(`git ${argv.find(a => !a.startsWith('-')) ?? ''} failed: ${String(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}
export const sessionId = (checkout, branch) => createHash('sha256').update(`${checkout}\n${branch}`).digest('hex').slice(0, 16);
// E2.1: canonical checkout path (on-disk case, junctions resolved) and the branch from git symbolic-ref.
export function sessionOf(repo) {
  const checkout = fs.realpathSync.native(path.resolve(repo));
  const r = gitRun(checkout, ['symbolic-ref', '--short', '-q', 'HEAD'], {literal: false});
  const branch = r.status === 0 ? r.stdout.trim() : '';
  if (!branch) throw new Error(`checkpoint: --session needs a branch (detached HEAD in ${checkout})`);
  return {id: sessionId(checkout, branch), checkout, branch};
}
export function sessionMode(config) {
  const mode = config?.caps?.checkpoint?.mode ?? 'all';
  if (!['all', 'session'].includes(mode)) throw new Error('caps.checkpoint.mode must be all or session');
  return mode;
}
const realMemory = memoryDir => fs.realpathSync.native(memoryDir);
// Resolve a path canonically even when it, or some of its parents, do not exist yet: existing ancestors are resolved.
export function canonicalize(file) {
  const suffix = [];
  let current = path.resolve(file);
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), ...suffix); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      let stat;
      try { stat = fs.lstatSync(current); } catch {}
      if (stat?.isSymbolicLink()) throw new Error('dangling link: ' + current);
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current)); current = parent;
    }
  }
}
// A directory the kit reads or writes ledgers in must be a real directory inside memory, never a link or junction.
export function sessionDir(memoryDir, rel = SESSIONS, {create = false} = {}) {
  const dir = path.join(memoryDir, rel);
  let stat;
  try { stat = fs.lstatSync(dir); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!create) return null;
    if (rel !== SESSIONS) sessionDir(memoryDir, SESSIONS, {create: true});
    fs.mkdirSync(dir); stat = fs.lstatSync(dir);
    // The ledger folder ignores itself, so no ledger is ever committed even where the memory .gitignore lacks .sessions/.
    if (rel === SESSIONS && !stat.isSymbolicLink() && stat.isDirectory()) fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', {flag: 'wx'});
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${slash(rel)} refused: must be a real directory inside memory, not a link or junction`);
  if (!within(realMemory(memoryDir), fs.realpathSync.native(dir))) throw new Error(`${slash(rel)} refused: resolves outside memory`);
  return dir;
}
// Fresh containment and file-type check for one ledger, temp or generated-output path (E2.3 Codex text).
export function checkedFile(memoryDir, file, label = 'file') {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') { checkParent(memoryDir, file, label); return null; } throw error; }
  if (!stat.isFile()) throw new Error(`${label} refused: ${slash(path.relative(memoryDir, file))} is not a regular file`);
  if (!within(realMemory(memoryDir), fs.realpathSync.native(file))) throw new Error(`${label} refused: ${slash(path.relative(memoryDir, file))} resolves outside memory`);
  return stat;
}
function checkParent(memoryDir, file, label) {
  if (!within(realMemory(memoryDir), canonicalize(file))) throw new Error(`${label} refused: ${slash(path.relative(memoryDir, file))} resolves outside memory`);
}
// E2.3: a claim key is one memory-relative file; never a directory, glob or pathspec; never git, ledger or lock files.
export function claimKey(memoryDir, file) {
  const raw = String(file ?? '');
  const fail = why => { throw new Error(`claim refused: ${raw} (${why})`); };
  if (!raw.trim() || /[\0\r\n]/.test(raw)) fail('not a file name');
  if (/[*?]/.test(raw)) fail('a glob, not a file');
  if (/^:/.test(raw)) fail('a pathspec, not a file');
  if (/[\\/]$/.test(raw) || raw === '.' || raw === '..') fail('a directory, not a file');
  // Review P1: a file-system error while inspecting the path (EACCES, EIO, ...) is indeterminate, not proof that
  // the key is invalid: it carries code CLAIM_INDETERMINATE so a persisted claim keeps protecting the file. Deliberate
  // refusals (fail) carry no code.
  const indeterminate = error => { throw Object.assign(new Error(`claim refused: ${raw} (could not inspect: ${error.message})`), {code: 'CLAIM_INDETERMINATE', cause: error}); };
  const root = realMemory(memoryDir), absolute = path.resolve(memoryDir, raw);
  let canonical;
  try { canonical = canonicalize(absolute); } catch (error) { if (error.code) indeterminate(error); fail(error.message); }
  if (!within(root, canonical)) fail('outside memory');
  const key = slash(path.relative(root, canonical)), parts = key.split('/');
  if (parts.some(part => part.toLowerCase() === '.git')) fail('inside .git');
  if (parts[0].toLowerCase() === SESSIONS) fail('session ledger');
  if (isLockPath(key)) fail('lock file');
  let stat;
  try { stat = fs.lstatSync(absolute); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) indeterminate(error); }
  if (stat && stat.isDirectory() && !stat.isSymbolicLink()) fail('a directory, not a file');
  if (stat && !stat.isFile()) fail('not a regular file');
  return key;
}
export function claimKeys(memoryDir, files) {
  const keys = [], errors = [];
  for (const file of files) { try { keys.push(claimKey(memoryDir, file)); } catch (error) { errors.push(error.message); } }
  if (errors.length) throw new Error(errors.join('\n') + '\nnothing claimed');
  return [...new Set(keys)];
}
const LEDGER = /^[0-9a-f]{16}\.json$/;
// The memory-relative spelling of a key without touching the file system; null when it leaves memory lexically.
function lexicalKey(memoryDir, key) {
  if (typeof key !== 'string' || !key.trim() || /[\0\r\n*?]/.test(key) || /^:/.test(key) || path.isAbsolute(key) || path.win32.isAbsolute(key)) return null;
  const rel = path.relative(path.resolve(memoryDir), path.resolve(memoryDir, key));
  return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel) ? slash(rel) : null;
}
// Review P1-1: a ledger whose ownership cannot be read is 'unreadable' (every operation that needs ownership refuses);
// a readable ledger with bad fields is 'malformed', and every valid memory path it names stays an unresolved claim.
function parseLedger(memoryDir, name, text) {
  const problems = [];
  let ledger;
  try { ledger = JSON.parse(text); } catch { return {ledger: null, problems: ['not valid JSON']}; }
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) return {ledger: null, problems: ['not an object']};
  if (!ledger.claims || typeof ledger.claims !== 'object' || Array.isArray(ledger.claims)) return {ledger: null, problems: ['claims must be an object']};
  if (ledger.version !== 1) problems.push('version must be 1');
  for (const key of ['id', 'checkout', 'branch', 'updated']) if (typeof ledger[key] !== 'string' || !ledger[key]) problems.push(`missing ${key}`);
  if (typeof ledger.checkout === 'string' && typeof ledger.branch === 'string' && (ledger.id !== name.slice(0, 16) || sessionId(ledger.checkout, ledger.branch) !== ledger.id)) problems.push('id, checkout or branch does not match the file name');
  const claims = {};
  for (const [key, claim] of Object.entries(ledger.claims)) {
    let canonical;
    try { canonical = claimKey(memoryDir, key); }
    catch (error) {
      // A conclusively invalid key (glob, directory, outside memory, .git, ledger, lock) protects nothing and is dropped;
      // one whose inspection failed stays an unresolved claim under its lexical memory path (review P1).
      const lexical = error.code ? lexicalKey(memoryDir, key) : null;
      if (!lexical) { problems.push(error.message); continue; }
      problems.push(`claim ${key} could not be inspected (${error.cause?.code ?? error.code}); kept as an unresolved claim on ${lexical}`);
      claims[lexical] = {since: typeof claim?.since === 'string' ? claim.since : '(unknown)', by: typeof claim?.by === 'string' ? claim.by : '(unknown)', headAtClaim: null, malformed: true};
      continue;
    }
    const record = claim && typeof claim === 'object' && typeof claim.since === 'string' && typeof claim.by === 'string' && (claim.headAtClaim === null || /^[0-9a-f]{40,64}$/.test(claim.headAtClaim ?? ''));
    if (canonical === key && record) { claims[key] = claim; continue; }
    problems.push(`claim refused: ${key} (${canonical !== key ? 'not canonical' : 'invalid record'}); kept as an unresolved claim on ${canonical}`);
    claims[canonical] = {since: typeof claim?.since === 'string' ? claim.since : '(unknown)', by: typeof claim?.by === 'string' ? claim.by : '(unknown)', headAtClaim: null, malformed: true};
  }
  return {ledger: {...ledger, claims}, problems};
}
// Stale needs confirmed evidence (E2.7): the checkout's folder is absent while its parent folder exists, or git in the
// checkout names another branch (or a detached HEAD). Anything that cannot be confirmed leaves the ledger live.
function staleness(checkout) {
  if (typeof checkout !== 'string' || !path.isAbsolute(checkout)) return {problem: 'checkout is not an absolute path'};
  try { fs.lstatSync(checkout); }
  catch (error) {
    if (error.code !== 'ENOENT') return {problem: `checkout cannot be inspected: ${error.code}`};
    try { return fs.statSync(path.dirname(checkout)).isDirectory() ? {stale: 'checkout removed'} : {problem: 'checkout parent is not a folder'}; }
    catch (parentError) { return {problem: `checkout absence cannot be confirmed: parent ${parentError.code}`}; }
  }
  try {
    const r = gitRun(checkout, ['symbolic-ref', '--short', '-q', 'HEAD'], {literal: false, timeout: 10000});
    if (r.status !== 0 && r.status !== 1) return {problem: `git inspection failed: ${String(r.stderr).trim() || 'git failed'}`};
    return {branch: r.status === 0 ? r.stdout.trim() : null};
  } catch (error) { return {problem: `git inspection failed: ${error.message}`}; }
}
export function readLedgers(memoryDir) {
  const dir = sessionDir(memoryDir);
  if (!dir) return [];
  const result = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === STALE || name === '.gitignore' || name.endsWith('.tmp')) continue;
    const file = path.join(dir, name), rel = `${SESSIONS}/${name}`;
    if (!LEDGER.test(name)) { result.push({file: rel, id: null, state: 'unreadable', problems: ['not a ledger file name'], claims: {}}); continue; }
    let text;
    try { checkedFile(memoryDir, file, 'ledger'); text = readRequired(file); }
    catch (error) { result.push({file: rel, id: name.slice(0, 16), state: 'unreadable', problems: [error.message], claims: {}}); continue; }
    const {ledger, problems} = parseLedger(memoryDir, name, text);
    if (!ledger) { result.push({file: rel, id: name.slice(0, 16), state: 'unreadable', problems, claims: {}}); continue; }
    const entry = {file: rel, id: name.slice(0, 16), checkout: ledger.checkout, branch: ledger.branch, updated: ledger.updated, claims: ledger.claims, problems, state: problems.length ? 'malformed' : 'live'};
    if (!problems.length) {
      const seen = staleness(ledger.checkout);
      if (seen.stale) { entry.state = 'stale'; entry.reason = seen.stale; }
      else if (seen.problem) { entry.state = 'malformed'; entry.problems = [seen.problem]; }
      else if (seen.branch !== ledger.branch) { entry.state = 'stale'; entry.reason = seen.branch ? `checkout is on ${seen.branch}` : 'checkout is detached'; }
    }
    result.push(entry);
  }
  return result;
}
const unreadableText = ledger => `ledger ${ledger.file} is unreadable (${ledger.problems.join('; ')}); ownership cannot be established: repair it, or move it to ${SESSIONS}/${STALE}/ once its session's work is saved`;
export function refuseUnreadable(ledgers) {
  const bad = ledgers.filter(l => l.state === 'unreadable');
  if (bad.length) throw Object.assign(new Error(bad.map(unreadableText).join('\n')), {code: 'LEDGER_UNREADABLE'});
}
export function memoryHead(memoryDir) {
  const r = gitRun(memoryDir, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], {literal: false});
  return r.status === 0 ? r.stdout.trim() : null;
}
// E2.6: a claim is resolved only when it was released (absent from the ledger) or completed: a commit since the claim
// touched the file, and now worktree and index equal HEAD, with membership checked explicitly.
export function claimResolved(memoryDir, key, claim) {
  if (claim?.malformed) return false;
  const head = memoryHead(memoryDir);
  if (!head) return false;
  const range = claim.headAtClaim ? [`${claim.headAtClaim}..HEAD`] : ['HEAD'];
  const log = gitRun(memoryDir, ['log', '--format=%H', ...range, '--', key]);
  if (log.status !== 0 || !log.stdout.trim()) return false;
  return matchesHead(memoryDir, key);
}
// Worktree and index both equal HEAD for one file, with membership checked explicitly (tracked and present, or absent
// from HEAD, index and worktree); an existing untracked file never matches.
export function matchesHead(memoryDir, key) {
  if (gitRun(memoryDir, ['diff', '--quiet', 'HEAD', '--', key]).status !== 0) return false;
  if (gitRun(memoryDir, ['diff', '--cached', '--quiet', 'HEAD', '--', key]).status !== 0) return false;
  const inHead = gitRun(memoryDir, ['ls-tree', '--name-only', 'HEAD', '--', key]).stdout.trim() !== '';
  const inIndex = gitRun(memoryDir, ['ls-files', '--cached', '--', key]).stdout.trim() !== '';
  const exists = fs.existsSync(path.join(memoryDir, key));
  return (inHead && inIndex && exists) || (!inHead && !inIndex && !exists);
}
// Unresolved claims of every other live or malformed session (stale ledgers never block): key -> holders. An unreadable
// ledger refuses (review P1-1): what it protects cannot be known.
export function foreignClaims(memoryDir, ownId, {ledgers = readLedgers(memoryDir)} = {}) {
  refuseUnreadable(ledgers);
  const result = new Map();
  for (const ledger of ledgers) {
    if (ledger.state === 'stale' || (ledger.id === ownId && ledger.state === 'live')) continue;
    for (const [key, claim] of Object.entries(ledger.claims)) {
      if (claimResolved(memoryDir, key, claim)) continue;
      if (!result.has(key)) result.set(key, []);
      result.get(key).push({checkout: ledger.checkout ?? '(unknown)', branch: ledger.branch ?? '(unknown)', since: claim.since, state: ledger.state, id: ledger.id});
    }
  }
  return result;
}
export const holderText = holder => `${holder.checkout} on ${holder.branch} since ${holder.since}`;
export function pendingOther(memoryDir, ownId) {
  let count = 0;
  for (const holders of foreignClaims(memoryDir, ownId).values()) if (holders.length) count++;
  return count;
}
export function ownLedger(memoryDir, session, {ledgers = readLedgers(memoryDir)} = {}) {
  const found = ledgers.find(l => l.id === session.id);
  if (found && found.state === 'unreadable') throw new Error(unreadableText(found));
  if (found && found.state === 'malformed') throw new Error(`ledger ${found.file} is malformed (${found.problems.join('; ')}); fix it or move it to ${SESSIONS}/${STALE}/`);
  return {version: 1, id: session.id, checkout: session.checkout, branch: session.branch, updated: found?.updated ?? new Date().toISOString(), claims: {...(found?.claims ?? {})}};
}
export function unresolvedOwn(memoryDir, ledger) {
  return Object.keys(ledger.claims).filter(key => !claimResolved(memoryDir, key, ledger.claims[key])).sort();
}
// Only the owning session writes its ledger, atomically (temp + rename) inside a checked .sessions directory.
export function writeLedger(memoryDir, ledger, {dropResolved = true, keep = []} = {}) {
  const dir = sessionDir(memoryDir, SESSIONS, {create: true});
  const claims = {};
  for (const [key, claim] of Object.entries(ledger.claims)) if (!dropResolved || keep.includes(key) || !claimResolved(memoryDir, key, claim)) claims[key] = claim;
  const next = {version: 1, id: ledger.id, checkout: ledger.checkout, branch: ledger.branch, updated: new Date().toISOString(), claims};
  const dest = path.join(dir, `${ledger.id}.json`), temp = path.join(dir, `${ledger.id}.json.${randomUUID()}.tmp`);
  checkedFile(memoryDir, dest, 'ledger');
  try {
    fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', {flag: 'wx'});
    checkedFile(memoryDir, temp, 'ledger temp');
    checkedFile(memoryDir, dest, 'ledger');
    fs.renameSync(temp, dest);
  } finally {
    // Remove whatever is left at the temp name (a file, or a link swapped in), never what a link points to.
    let left = null;
    try { left = fs.lstatSync(temp); } catch {}
    if (left) { try { if (left.isDirectory() && !left.isSymbolicLink()) fs.rmdirSync(temp); else fs.unlinkSync(temp); } catch { try { fs.rmdirSync(temp); } catch {} } }
  }
  return next;
}
// E2.4 and E5: claim inside the caller's lock; refuses a file another live session claims unless it is in take.
export function claimFiles({memoryDir, repo, files, by = 'claim', take = [], lock, session}) {
  return withMemoryLock(memoryDir, () => {
    session ??= sessionOf(repo);
    const keys = claimKeys(memoryDir, files), takeKeys = new Set(take.length ? claimKeys(memoryDir, take) : []);
    const ledgers = readLedgers(memoryDir), own = ownLedger(memoryDir, session, {ledgers}), foreign = foreignClaims(memoryDir, session.id, {ledgers});
    const refused = keys.filter(key => foreign.has(key) && !takeKeys.has(key));
    if (refused.length) throw Object.assign(new Error(refused.map(key => `claim refused: ${key} is claimed by ${foreign.get(key).map(holderText).join('; ')}`).join('\n') + '\nnothing claimed'), {code: 'CLAIM_CONTENDED', contended: refused.map(key => ({key, holders: foreign.get(key)}))});
    const head = memoryHead(memoryDir), now = new Date().toISOString(), overrode = [];
    for (const key of keys) {
      if (foreign.has(key)) overrode.push({key, holders: foreign.get(key)});
      const prior = own.claims[key];
      if (!prior || claimResolved(memoryDir, key, prior)) own.claims[key] = {since: now, by, headAtClaim: head};
    }
    writeLedger(memoryDir, own, {keep: keys});
    return {session, claimed: keys, overrode};
  }, {lock});
}
// Writers that are session-aware call this inside their own lock acquisition, before writing (E2.4).
export function writerClaim({memoryDir, repo, config, lock}, files, by) {
  if (sessionMode(config ?? loadConfig()) !== 'session') return null;
  if (!repo) throw new Error(`${by}: session mode needs the project checkout (--repo) to claim ${files.join(', ')}`);
  return claimFiles({memoryDir, repo, files, by, lock});
}
// Coordinated maintenance (E2.4, E6): exclusive steps refuse while another live ledger holds unresolved claims.
// E2.8 (a): the refusal names each holding session and the files it claims. An unreadable ledger refuses through
// foreignClaims with its own message.
export function refuseWhilePending({memoryDir, repo, label, ownId}) {
  if (!memoryDir || !fs.existsSync(memoryDir)) return;
  if (ownId === undefined && repo) { try { ownId = sessionOf(repo).id; } catch { ownId = null; } }
  const pending = foreignClaims(memoryDir, ownId), sessions = new Map();
  for (const [key, holders] of pending) for (const holder of holders) {
    const name = `${holder.checkout} on ${holder.branch}${holder.state === 'live' ? '' : ` (${holder.state} ledger)`}`;
    if (!sessions.has(name)) sessions.set(name, []);
    sessions.get(name).push(key);
  }
  if (pending.size) throw new Error(`${label} refused: ${pending.size} files pending in other sessions: ${[...sessions].map(([name, keys]) => `${name} claims ${keys.sort().join(', ')}`).join('; ')}; see memory-session list`);
}
export function releaseFiles({memoryDir, repo, files, lock, session}) {
  return withMemoryLock(memoryDir, () => {
    session ??= sessionOf(repo);
    const keys = claimKeys(memoryDir, files), own = ownLedger(memoryDir, session), released = keys.filter(key => Object.hasOwn(own.claims, key));
    for (const key of released) delete own.claims[key];
    writeLedger(memoryDir, own);
    return {released, missing: keys.filter(key => !released.includes(key))};
  }, {lock});
}
export function pruneLedgers({memoryDir, apply = false, lock}) {
  const run = () => {
    const stale = readLedgers(memoryDir).filter(l => l.state === 'stale');
    if (apply && stale.length) {
      const dest = sessionDir(memoryDir, `${SESSIONS}/${STALE}`, {create: true});
      for (const ledger of stale) {
        const from = path.join(memoryDir, ledger.file);
        checkedFile(memoryDir, from, 'ledger');
        let to = path.join(dest, path.basename(ledger.file));
        for (let n = 1; fs.existsSync(to); n++) to = path.join(dest, `${ledger.id}-${n}.json`);
        checkedFile(memoryDir, to, 'stale ledger');
        fs.renameSync(from, to);
      }
    }
    return {stale, moved: apply ? stale.length : 0};
  };
  return apply ? withMemoryLock(memoryDir, run, {lock}) : run();
}
export function listSessions({memoryDir, repo}) {
  let session = null;
  try { session = sessionOf(repo); } catch {}
  const ledgers = readLedgers(memoryDir), lines = [];
  const own = ledgers.find(l => l.id === session?.id);
  lines.push(session ? `this session: ${session.checkout} (${session.branch}) ${session.id}` : 'this session: none (detached HEAD or not a checkout)');
  if (own && own.state === 'live') for (const key of unresolvedOwn(memoryDir, own)) lines.push(`  claim: ${key} (since ${own.claims[key].since}, by ${own.claims[key].by})`);
  for (const ledger of ledgers.filter(l => l !== own || l.state !== 'live')) {
    if (ledger.state === 'unreadable') { lines.push(`unreadable: ${ledger.file}: ${ledger.problems.join('; ')}`); continue; }
    if (ledger.state === 'malformed') { lines.push(`malformed: ${ledger.file}${ledger.checkout ? ` ${ledger.checkout} (${ledger.branch})` : ''}: ${ledger.problems.join('; ')}`); }
    else if (ledger.state === 'stale') lines.push(`stale: ${ledger.file} ${ledger.checkout} (${ledger.branch}): ${ledger.reason}`);
    else lines.push(`live: ${ledger.file} ${ledger.checkout} (${ledger.branch})`);
    if (ledger.state !== 'stale') for (const key of Object.keys(ledger.claims).filter(key => !claimResolved(memoryDir, key, ledger.claims[key])).sort()) lines.push(`  claim: ${key} (since ${ledger.claims[key].since})`);
  }
  return {session, ledgers, text: lines.join('\n')};
}
export function main(argv = process.argv.slice(2)) {
  try {
    const command = argv[0], rest = argv.slice(1), opts = {_: []};
    for (let i = 0; i < rest.length; i++) {
      if (['--repo', '--memory-dir'].includes(rest[i])) { if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`Missing ${rest[i]} value`); opts[rest[i].slice(2)] = rest[++i]; }
      else if (rest[i] === '--apply') opts.apply = true;
      else if (rest[i].startsWith('--')) throw new Error('unknown option ' + rest[i]);
      else opts._.push(rest[i]);
    }
    if (!['claim', 'list', 'release', 'prune'].includes(command)) throw new Error('usage: memory-session.mjs claim <file>...|list|release <file>...|prune [--apply] [--repo PATH] [--memory-dir PATH]');
    // E2.8 (e): which memory (KIT.local.json, the main checkout) is found with the cleaned git environment too.
    const loc = locations(opts, {env: cleanGitEnv()});
    if (!loc.memoryDir || !fs.existsSync(loc.memoryDir)) throw new Error('memory dir not found');
    if (command === 'list') { console.log(listSessions(loc).text); return 0; }
    if (command === 'prune') {
      const result = pruneLedgers({memoryDir: loc.memoryDir, apply: Boolean(opts.apply)});
      for (const ledger of result.stale) console.log(`stale: ${ledger.file} ${ledger.checkout} (${ledger.branch}): ${ledger.reason}`);
      console.log(opts.apply ? `prune: ${result.moved} moved to ${SESSIONS}/${STALE}/` : `prune: ${result.stale.length} stale; run with --apply to move them to ${SESSIONS}/${STALE}/`);
      return 0;
    }
    if (!opts._.length) throw new Error(`${command} needs at least one file`);
    if (command === 'claim') { const result = claimFiles({...loc, files: opts._, by: 'memory-session claim'}); console.log(`claimed: ${result.claimed.join(', ')}`); return 0; }
    const result = releaseFiles({...loc, files: opts._});
    console.log(`released: ${result.released.join(', ') || 'none'}${result.missing.length ? `; not claimed by this session: ${result.missing.join(', ')}` : ''}`);
    return 0;
  } catch (error) { console.error('memory-session: ' + error.message); return 1; }
}
if (isDirect(import.meta.url)) process.exitCode = main();
export {sameOrWithin, within};
