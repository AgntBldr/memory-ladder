import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Keep caller-specific process limits and output handling at the call site.
export const gitResult = (repo, argv, options = {}) => spawnSync('git', ['--no-optional-locks', '-C', repo, ...argv], {encoding: 'utf8', timeout: 10000, windowsHide: true, ...options});
// The environment lib's own worktree calls give git. The installer and updater set their clean one
// (install-hooks.mjs cleanGitEnv); a command that must not follow the caller's variables passes cleanGitEnv() itself
// (kit 3.3.6: the read-only commands do); only the gate's --hook path keeps the caller's, since the gate also runs
// inside git's own pre-commit hook, where git's variables describe the commit being checked.
let gitEnvironment = () => process.env;
export function useGitEnvironment(make) { gitEnvironment = make; }
// One clean git environment for every git call the installer and updater make (and the gate they run), and for
// every git call of memory-session (kit 3.3.5 E2.8 (e)): no variable that points git at another repository, index or
// object store, changes how it finds the repository, selects a ref namespace (kit 3.3.6: a push or a listing under one
// lands in another place), changes how a pathspec is read (kit 3.3.6: literal, glob, noglob and icase mode turn a pathspec
// magic into a file name or make the call die), or adds configuration, the legacy single-file variable included. The variables that only name
// the global and system configuration files stay: they name inputs. The gate's --hook path does not use it: there git's
// variables describe the commit being checked. The definition below names configuration variables only to remove
// them; the handover import-graph fence checks it word for word (tests/release330-handover.test.mjs).
export const GIT_REDIRECTS = /^(?:GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM|GIT_NAMESPACE|GIT_CONFIG|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_LITERAL_PATHSPECS|GIT_GLOB_PATHSPECS|GIT_NOGLOB_PATHSPECS|GIT_ICASE_PATHSPECS)$/i;
export function cleanGitEnv(env = process.env) {
  const clean = {...env};
  for (const name of Object.keys(clean)) if (GIT_REDIRECTS.test(name)) delete clean[name];
  return clean;
}
export function localTime(date) {
  const pad = n => String(n).padStart(2, '0'), offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}
// Kit 3.3.6 item 15: a failing removal of the temp file never replaces the failure that made it necessary. That failure
// stays the thrown error and carries the temp path in `residue`, so a caller that reports (the checkpoint) can name the
// file left behind. With no earlier failure the removal error is thrown, as before.
export function atomicWrite(file, data, options = {}) {
  const temp = file + '.' + randomUUID() + '.tmp';
  let failed = false, failure;
  try { fs.writeFileSync(temp, data, {flag: 'wx', ...options}); fs.renameSync(temp, file); }
  catch (error) { failed = true; failure = error; throw error; }
  finally {
    if (fs.existsSync(temp)) {
      try { fs.unlinkSync(temp); }
      catch (error) {
        if (!failed) throw error;
        if (failure && typeof failure === 'object') (failure.residue ??= []).push(temp);
      }
    }
  }
}
export function porcelainEntries(raw, {includeSources = false} = {}) {
  const rows = raw.split('\0').filter(Boolean), result = [];
  for (let i = 0; i < rows.length; i++) {
    const code = rows[i].slice(0, 2);
    result.push({code, file: rows[i].slice(3)});
    if (/[RC]/.test(code)) {
      const source = rows[++i];
      if (includeSources) result.push({code, file: source});
    }
  }
  return result;
}

export const toolDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = () => path.resolve(toolDir, '../..');
export const normalizeEol = text => String(text).replace(/\r\n/g, '\n');
export const matchEol = (text, original) => {
  const prior = String(original).match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const crlf = prior.filter(line => line.endsWith('\r\n')).length;
  const lf = prior.filter(line => line.endsWith('\n')).length - crlf;
  const eol = crlf > lf ? '\r\n' : '\n';
  const next = normalizeEol(text).match(/[^\n]*\n|[^\n]+$/g) ?? [];
  // Preserve common edges, then find the longest ordered set of unchanged lines.
  // Matching greedily can mistake an inserted duplicate for a later original line.
  const kept = new Map();
  let start = 0, endOld = prior.length, endNew = next.length;
  while (start < endOld && start < endNew && normalizeEol(prior[start]) === next[start]) { kept.set(start, prior[start]); start++; }
  while (endOld > start && endNew > start && normalizeEol(prior[endOld - 1]) === next[endNew - 1]) { kept.set(--endNew, prior[--endOld]); }
  const positions = new Map();
  for (let i = start; i < endOld; i++) { const key = normalizeEol(prior[i]); if (!positions.has(key)) positions.set(key, []); positions.get(key).push(i); }
  const tails = [], chains = [];
  for (let i = start; i < endNew; i++) {
    const candidates = positions.get(next[i]) ?? [];
    for (let j = candidates.length - 1; j >= 0; j--) {
      const at = candidates[j]; let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (tails[mid] < at) lo = mid + 1; else hi = mid; }
      if (tails[lo] === at) continue;
      chains[lo] = {old:at, next:i, previous:lo ? chains[lo - 1] : null}; tails[lo] = at;
    }
  }
  for (let link = chains.at(-1); link; link = link.previous) kept.set(link.next, prior[link.old]);
  return next.map((line, i) => kept.get(i) ?? line.replace(/\n$/, eol)).join('');
};
// Kit 3.3.6 item 8 sweep: the kind check comes first, because the line-ending read of the destination (and the write) of a
// fifo, socket or device blocks. Absent, an ordinary file and a folder behave as before.
export function writeText(file, text) { refuseSpecialRead(file); fs.writeFileSync(file, matchEol(text, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : text)); }
export const utf8Bytes = s => Buffer.byteLength(s, 'utf8');
export const slash = s => s.replace(/\\/g, '/');
// Kit 3.3.6 item 8: the kind check of the read helpers. A fifo, socket or device must never be read (a read of one blocks).
// True only for an existing entry that is neither a file nor a folder (stat follows links); an absent path (ENOENT, ENOTDIR)
// and a folder are false, so each still behaves as it did (the read that follows reports it). Any other stat error means the
// kind is unknown: it propagates, and each helper reports it through its own error path (fail closed; spec section 2).
function isSpecial(file) {
  let stat;
  try { stat = fs.statSync(file); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
  return !stat.isFile() && !stat.isDirectory();
}
export function read(file) {
  if (isSpecial(file)) throw Object.assign(new Error(`${file} is not a regular file`), {code: 'ENOTFILE'});
  try { return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return '';
    throw error;
  }
}
// A read that a gate check newly reaches must not block on a FIFO, a device or a socket. True for a
// regular file, false when absent; anything else (a folder too) is refused before any read. stat follows links, so a link
// to a regular file is a regular file.
export function regularFileOrAbsent(file, label) {
  let stat;
  try { stat = fs.statSync(file); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
  if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
  return true;
}
export function readRequired(file) {
  try {
    if (isSpecial(file)) throw Object.assign(new Error(`cannot read ${file} (not a regular file)`), {code: 'ENOTFILE'});
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) { throw error?.code === 'ENOTFILE' ? error : new Error(`cannot read ${file}`); }
}
// Kit 3.3.6 item 8: the same kind check for a caller that reads bytes (the checkpoint's readBytes). Throws for a fifo, socket
// or device; returns normally for everything else.
export function refuseSpecialRead(file) {
  if (isSpecial(file)) throw Object.assign(new Error(`${file} is not a regular file`), {code: 'ENOTFILE'});
}
export const loadConfig = () => JSON.parse(read(path.join(toolDir, 'memory.config.json')));
export const pathSpelling = value => process.platform === 'win32' ? slash(value).toLowerCase() : value;
const canonicalDirectories = new Map();
export function canonicalPath(file) {
  const suffix = [];
  let parent = path.resolve(file);
  for (;;) {
    try {
      if (canonicalDirectories.has(parent)) return path.join(canonicalDirectories.get(parent), ...suffix);
      const stat = fs.lstatSync(parent);
      if (stat.isDirectory() || stat.isSymbolicLink()) {
        const real = fs.realpathSync(parent);
        if (fs.statSync(parent).isDirectory()) canonicalDirectories.set(parent, real);
        return path.join(real, ...suffix);
      }
      return path.join(canonicalPath(path.dirname(parent)), path.basename(parent), ...suffix);
    }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      // A dangling link must not be treated as a future ordinary directory.
      let stat;
      try { stat = fs.lstatSync(parent); }
      catch (statError) { if (!['ENOENT', 'ENOTDIR'].includes(statError.code)) throw statError; }
      if (stat?.isSymbolicLink()) throw error;
      const next = path.dirname(parent);
      if (next === parent) throw error;
      suffix.unshift(path.basename(parent)); parent = next;
    }
  }
}
// Uncached: every call resolves the deepest existing ancestor again, so a link
// retargeted between two calls is seen. Same fail-closed rules as canonicalPath.
export function canonicalPathFresh(file) {
  const suffix = [];
  let parent = path.resolve(file);
  for (;;) {
    let stat;
    try { stat = fs.lstatSync(parent); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const next = path.dirname(parent);
      if (next === parent) throw error;
      suffix.unshift(path.basename(parent)); parent = next;
      continue;
    }
    // realpath of an existing entry follows every link in the chain; a dangling link throws.
    return path.join(fs.realpathSync.native(parent), ...suffix);
  }
}
const canonicalKeys = new Map();
export function pathKeyFor(platform, ...parts) {
  const resolved = path.resolve(...parts);
  let value = canonicalKeys.get(resolved) ?? resolved;
  if (!canonicalKeys.has(resolved)) try {
    value = canonicalPath(resolved);
    if (fs.existsSync(resolved)) canonicalKeys.set(resolved, value);
  } catch {}
  return platform === 'win32' ? slash(value).toLowerCase() : platform === 'darwin' ? value.toLowerCase() : value;
}
export const pathKey = (...parts) => pathKeyFor(process.platform, ...parts);
const contained = (root, file) => {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
};
// Kit 3.3.6 step 0: the kind check that comes before a read of a planned destination or a file the operator names. stat
// follows links, so a link to a regular file is a regular file and a dangling link is absent. Absent (ENOENT, ENOTDIR),
// a regular file and a folder return (a folder is the caller's own read to report); a fifo, socket or device, and any
// other stat error, throw before the caller reads, so planning never blocks on one.
export function refuseSpecial(file) {
  let stat;
  try { stat = fs.statSync(file); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
    throw new Error(`cannot resolve ${file} (${error.code ?? error.message}); nothing written`);
  }
  if (!stat.isFile() && !stat.isDirectory()) throw new Error(`cannot protect the special file ${file} (a fifo, socket or device cannot be kept or restored); nothing written`);
}
// Kit 3.3.6 step 0: a cleanup that must never replace the real result. Removes target (a file or a folder tree; absent is
// fine); a failure becomes one note line and false, and neither the failure nor a note that throws leaves this function.
// The default note writes one line to stderr.
export function removeQuietly(target, {note = console.error} = {}) {
  try { fs.rmSync(target, {recursive: true, force: true}); return true; }
  catch (error) {
    try { note(`could not remove ${target}; delete it by hand (${error.message})`); } catch {}
    return false;
  }
}
// Kit 3.3.6 step 0: a scratch folder that is never inside the project or the memory folder. The temporary folder is
// canonicalised once, checked against every existing folder of outside (canonical keys; equal counts as inside; a folder
// that does not exist cannot hold it and is skipped) and the scratch folder is made under that same canonical path, so the
// folder checked is the folder used. Throws before anything is made.
export function scratchFolder(prefix, outside = []) {
  const base = fs.realpathSync.native(os.tmpdir()), baseKey = pathKey(base);
  for (const folder of outside) {
    let real;
    try { real = fs.realpathSync.native(folder); }
    catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw new Error(`cannot resolve ${folder} (${error.code ?? error.message}); nothing written`);
    }
    if (contained(pathKey(real), baseKey)) throw new Error(`the temporary folder ${base} is inside ${folder}; set TEMP and TMP to a folder outside the project and the memory folder`);
  }
  return fs.mkdtempSync(path.join(base, prefix));
}
export function repoPath(repo, relative, label) {
  const fail = () => { throw new Error(`${label} must be a relative path inside the repo`); };
  if (typeof relative !== 'string' || !relative.trim() || path.posix.isAbsolute(relative) || path.win32.parse(relative).root !== '' || relative.split(/[\\/]/).some(part => part.toLowerCase() === '.git' || /^git~\d+$/i.test(part) || part.includes(':') || (part !== '.' && part !== '..' && /[. ]$/.test(part)))) fail();
  const absolute = path.resolve(repo, relative);
  if (absolute === path.resolve(repo) || !contained(path.resolve(repo), absolute)) fail();
  try {
    const root = pathSpelling(canonicalPath(repo)), target = pathSpelling(canonicalPath(absolute));
    if (target === root || !contained(root, target) || path.relative(root, target).split(/[\\/]/).some(part => part.toLowerCase() === '.git')) fail();
  }
  catch { fail(); }
  return absolute;
}
export function configPaths(config) {
  const paths = [];
  for (const [group, cap] of Object.entries(config.caps ?? {})) {
    if (!cap || typeof cap !== 'object') continue;
    for (const key of ['path', 'allPath', 'rules', 'kitRules'])
      if (Object.hasOwn(cap, key)) paths.push([`caps.${group}.${key}`, cap[key]]);
    if (Object.hasOwn(cap, 'paths')) {
      if (!Array.isArray(cap.paths)) paths.push([`caps.${group}.paths`, cap.paths]);
      else cap.paths.forEach((value, i) => paths.push([`caps.${group}.paths[${i}]`, value]));
    }
  }
  for (const [group, key] of [['brain', 'dir'], ['memory', 'inRepoDir'], ['measure', 'evidenceDir']])
    if (config[group] && Object.hasOwn(config[group], key)) paths.push([`${group}.${key}`, config[group][key]]);
  return paths.map(([label, value]) => [label.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120), value]);
}
export function validateConfigPaths(repo, config) {
  for (const [label, value] of configPaths(config)) repoPath(repo, value, label);
}
export const pathIncludes = (file, pattern) => pathSpelling(file).includes(pathSpelling(pattern));
export function isDirect(url) {
  if (!process.argv[1]) return false;
  try { return pathKey(fs.realpathSync(process.argv[1])) === pathKey(fs.realpathSync(fileURLToPath(url))); }
  catch { return false; }
}
export const memorySlug = repo => repo.replace(/[^A-Za-z0-9]/g, '-');
// `env`: the git environment for these calls; a session-aware command passes cleanGitEnv() (kit 3.3.5 E2.8 (e)), the
// gate keeps the default (the caller's, or the one useGitEnvironment set).
export function mainWorktree(repo, {env = gitEnvironment()} = {}) {
  const git = (...argv) => {
    const r = gitResult(repo, ['rev-parse', ...argv], {env});
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const common = git('--path-format=absolute', '--git-common-dir'), dir = git('--absolute-git-dir');
  if (!common || !dir || pathKey(common) === pathKey(dir)) return repo;
  // The common directory belongs to the main checkout, including separate-git-dir setups.
  const r = gitResult(repo, ['worktree','list','--porcelain','-z'], {env});
  return r.status === 0 && r.stdout.startsWith('worktree ') && !r.stdout.split('\0\0')[0].split('\0').includes('bare') ? r.stdout.slice(9).split('\0')[0] : repo;
}

export function readKitJSON(file) {
  try {
    const value = JSON.parse(readRequired(file));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
    return value;
  } catch (error) {
    // Kit 3.3.7: readRequired's own errors already name the file ("cannot read <file>", "cannot read <file> (not a regular
    // file)"); the file is named once. Any other reason (bad JSON, not an object) follows the file name.
    const reason = String(error.message).replace(/[\r\n]+/g, ' ');
    throw new Error(reason.startsWith('cannot read ') ? reason : `cannot read ${file}: ${reason}`);
  }
}
export function memoryLocation(repo = repoRoot(), requested, {list = true, env = gitEnvironment()} = {}) {
  if (requested) return { dir: path.resolve(requested), source: '--memory-dir' };
  if (process.env.CLAUDE_MEMORY_DIR) return { dir: path.resolve(process.env.CLAUDE_MEMORY_DIR), source: 'CLAUDE_MEMORY_DIR' };
  const configFile = path.join(repo, 'scripts/memory/memory.config.json');
  if (fs.existsSync(configFile)) {
    const configured = readKitJSON(configFile).memory?.inRepoDir;
    if (configured !== undefined) {
      if (typeof configured !== 'string' || !configured || path.isAbsolute(configured) || path.win32.isAbsolute(configured) || !insideRepo(repo, path.resolve(repo, configured)))
        throw new Error('memory.inRepoDir must name a dedicated folder inside the repo; see CONVERT.md#move-root-memory-into-a-dedicated-folder');
      return {dir: path.resolve(repo, configured), source: 'memory.inRepoDir'};
    }
  }
  repo = mainWorktree(repo, {env});
  const receipt = path.join(repo, 'scripts/memory/KIT.json');
  if (fs.existsSync(receipt)) readKitJSON(receipt);
  const local = path.join(repo, 'scripts/memory/KIT.local.json');
  if (fs.existsSync(local)) {
    const configured = readKitJSON(local).memoryDir;
    if (configured && typeof configured !== 'string') throw new Error(`invalid memoryDir in ${local}`);
    if (configured) {
      const exists = fs.existsSync(path.resolve(configured));
      const tracked = !exists && path.isAbsolute(configured) ? spawnSync('git', ['-C', repo, 'ls-files', '--error-unmatch', '--', ':(icase)scripts/memory/KIT.local.json'], {encoding:'utf8',timeout:10000,windowsHide:true,env}) : null;
      if ((exists && fs.statSync(path.resolve(configured)).isDirectory()) ||
          (!exists && path.isAbsolute(configured) && tracked.status === 1))
        return { dir: path.resolve(configured), source: 'KIT.local.json' };
    }
  }
  const slug = memorySlug(path.resolve(repo));
  const projects = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.claude/projects');
  const exact = path.join(projects, slug, 'memory');
  if (fs.existsSync(exact)) return { dir: exact, source: 'default' };
  if (!list || !fs.existsSync(projects)) return { dir: null, source: 'default' };
  const match = fs.readdirSync(projects, { withFileTypes: true }).find(e =>
    e.isDirectory() && e.name.toLowerCase() === slug.toLowerCase() &&
    fs.existsSync(path.join(projects, e.name, 'memory')));
  return { dir: match ? path.join(projects, match.name, 'memory') : null, source: 'default' };
}
export const memoryDir = (repo = repoRoot()) => memoryLocation(repo).dir;
export function insideRepo(repo, dir) {
  if (!repo || !dir) return false;
  const rel = path.relative(pathKey(repo), pathKey(dir));
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
export const inRepoMemory = (repo, dir) => insideRepo(repo, dir) && !fs.existsSync(path.join(dir, '.git'));

function splitList(text) {
  const parts = [];
  let start = 0, quote = '', escaped = false, depth = 0, itemStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (quote === '"' && c === '\\') { escaped = true; continue; }
    if (quote) {
      if (quote === "'" && c === "'" && text[i + 1] === "'") i++;
      else if (c === quote) quote = '';
    }
    else if ((c === '"' || c === "'") && itemStart) { quote = c; itemStart = false; }
    else if (c === '[') { depth++; itemStart = true; }
    else if (c === ']') depth--;
    else if (c === ',') { if (depth === 0) { parts.push(text.slice(start, i)); start = i + 1; } itemStart = true; }
    else if (!/\s/.test(c)) itemStart = false;
  }
  parts.push(text.slice(start));
  return parts;
}

// Return the closing bracket of a complete flow list, ignoring quoted brackets.
function flowEnd(text, state = { depth: 0, quote: '', escaped: false, itemStart: true }) {
  let { depth, quote, escaped, itemStart } = state;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaped) { escaped = false; continue; }
    if (quote) {
      if (c === '\\' && quote === '"') escaped = true;
      else if (quote === "'" && c === "'" && text[i + 1] === "'") i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (itemStart && (c === '"' || c === "'")) { quote = c; itemStart = false; }
    else if (c === '[') { depth++; itemStart = true; }
    else if (c === ']') { if (--depth === 0) return i; }
    else if (c === ',') itemStart = true;
    else if (!/\s/.test(c)) itemStart = false;
  }
  Object.assign(state, { depth, quote, escaped, itemStart });
  return -1;
}

function scalar(text) {
  const s = text.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); }
    catch { return s.slice(1, -1).replace(/\\(["\\nt])/g, (_, c) => ({ n: '\n', t: '\t' }[c] ?? c)); }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('[') && flowEnd(s) === s.length - 1) return splitList(s.slice(1, -1)).filter(part => part.trim()).map(scalar);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  return s;
}

export function parseFrontmatter(text) {
  text = text.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  if (!/^---\s*$/.test(lines[0])) return { data: {}, body: text, raw: '' };
  const end = lines.findIndex((line, i) => i > 0 && /^---\s*$/.test(line));
  if (end < 0) return { data: { __error: 'unclosed' }, body: text, raw: '' };
  const warnings = [], data = {};
  const indent = line => /^\s*/.exec(line)[0].length;
  const keyLine = /^([\w.-]+):(?:[ \t]+(.*)|[ \t]*)$/;
  const warn = i => warnings.push({ line: i + 1, text: lines[i] });
  const assign = (obj, key, value, i) => {
    if (['__proto__', 'prototype', '__warnings', '__error'].includes(key) || Object.hasOwn(Object.prototype, key) || Object.hasOwn(obj, key)) warn(i);
    else obj[key] = value;
  };
  let i = 1;
  function value(raw, level) {
    const s = (raw ?? '').trim();
    if (/^[>|]-?$/.test(s)) {
      const block = [];
      while (i < end && (!lines[i].trim() || indent(lines[i]) > level)) block.push(lines[i++]);
      const nonempty = block.filter(l => l.trim());
      const margin = nonempty.length ? Math.min(...nonempty.map(indent)) : 0;
      const content = block.map(l => l.slice(margin));
      let result = content.join('\n');
      if (s[0] === '>') result = result.replace(/([^\n])\n(?=[^\n])/g, '$1 ');
      return result.replace(/\n+$/, '') + (s.endsWith('-') ? '' : '\n');
    }
    if (s.startsWith('[')) {
      const state = { depth: 0, quote: '', escaped: false, itemStart: true }, parts = [s];
      let closed = flowEnd(s, state) >= 0;
      while (i < end && !closed) {
        // A new mapping field is not a continuation of a malformed flow value.
        if (keyLine.test(lines[i].trim())) break;
        const part = ' ' + lines[i++].trim();
        parts.push(part); closed = flowEnd(part, state) >= 0;
      }
      return closed ? scalar(parts.join('')) : s;
    }
    if (s) return scalar(s);
    while (i < end && (!lines[i].trim() || /^\s*#/.test(lines[i]))) i++;
    if (i < end && indent(lines[i]) > level && lines[i].trim().startsWith('[')) return value(lines[i++].trim(), level);
    if (i < end && (indent(lines[i]) > level || (indent(lines[i]) === level && /^-\s/.test(lines[i].trim())))) {
      return block(indent(lines[i]), /^-\s/.test(lines[i].trim()));
    }
    return null;
  }
  function block(level, list, obj = list ? [] : {}) {
    while (i < end) {
      const line = lines[i], trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) { i++; continue; }
      const n = indent(line);
      if (n < level || (list && n === level && !/^-\s/.test(trimmed))) break;
      const at = i++;
      if (n !== level) { warn(at); continue; }
      if (list) {
        const item = /^-\s+(.*)$/.exec(trimmed);
        if (!item) { warn(at); continue; }
        const kv = keyLine.exec(item[1]);
        if (kv) {
          const entry = {};
          assign(entry, kv[1], value(kv[2], level + 2), at);
          if (i < end && indent(lines[i]) > level) block(indent(lines[i]), false, entry);
          obj.push(entry);
        } else obj.push(value(item[1], level));
      } else {
        const kv = keyLine.exec(trimmed);
        if (!kv) { warn(at); continue; }
        assign(obj, kv[1], value(kv[2], level), at);
      }
    }
    return obj;
  }
  block(0, false, data);
  if (warnings.length) data.__warnings = warnings;
  return { data, body: lines.slice(end + 1).join('\n'), raw: lines.slice(0, end + 1).join('\n') };
}

export function fmGet(data, key) {
  if (Object.hasOwn(data, key)) return data[key];
  for (const obj of Object.values(data)) {
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && Object.hasOwn(obj, key)) return obj[key];
  }
  return undefined;
}

export function mdLinks(text) {
  return [...text.matchAll(/\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g)]
    .map(m => m[1].replace(/^<|>$/g, '').split('#')[0])
    .filter(s => !/^[a-z][a-z0-9+.-]*:/i.test(s) && /\.md$/i.test(s));
}
export const wikilinks = text => [...text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map(m => m[1].replace(/\\$/, ''));
export function resolveWikilink(name, ...lookups) {
  const stripped = name.split(/[#^]/)[0];
  for (const lookup of lookups) {
    const found = lookup(name) || (stripped && stripped !== name ? lookup(stripped) : undefined);
    if (found) return found;
  }
}
export function memoryNameIndex(files) {
  const names = new Map();
  for (const f of files) {
    const name = fmGet(f.data, 'name'), keys = [f.file, f.file.replace(/\.md$/i, '')];
    if (['string', 'number', 'boolean'].includes(typeof name) && String(name)) keys.push(String(name));
    for (const value of keys) {
      const key = pathSpelling(value);
      if (!names.has(key)) names.set(key, f);
    }
  }
  return names;
}
export const memoryWikilink = (name, names, brainNames) => resolveWikilink(name,
  link => names.get(pathSpelling(link)),
  link => brainNames.has(pathSpelling(link)) ? 'brain' : undefined);
export function roadmapOrder(config) {
  const order = config.caps.roadmap.order === undefined ? 'newest-first' : config.caps.roadmap.order;
  if (!['newest-first', 'oldest-first'].includes(order)) throw new Error('caps.roadmap.order must be newest-first or oldest-first');
  return order;
}
export function listMd(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && /\.md$/i.test(e.name)).map(e => e.name).sort();
}
export function walkMd(dir, { skipDirs = [] } = {}) {
  if (!dir || !fs.existsSync(dir)) return [];
  const result = [], skipped = new Set(skipDirs);
  function walk(rel) {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const next = path.join(rel, e.name);
      if (e.isDirectory() && !skipped.has(e.name)) walk(next);
      else if (e.isFile() && /\.md$/i.test(e.name)) result.push(slash(next));
    }
  }
  walk('');
  return result.sort();
}
export const brainPaths = (repo, config = loadConfig()) => walkMd(repoPath(repo, config.brain?.dir ?? 'brain', config.brain?.dir === undefined ? 'brain' : 'brain.dir'), {
  skipDirs: ['00-system', '_templates', '.claude', '.agents', '.obsidian'],
}).filter(p => p.includes('/') && !/^(?:readme|_manifest|index)\.md$/i.test(path.basename(p)));
export function brainNamesFromNodes(nodes) {
  return new Set(nodes.flatMap(f => [path.basename(f.file).replace(/\.md$/i, ''), fmGet(f.data, 'id')]).filter(name => typeof name === 'string' && name).map(pathSpelling));
}
export function brainNameSet(repo, config = loadConfig()) {
  return brainNamesFromNodes(brainPaths(repo, config).map(file => ({file, ...parseFrontmatter(read(path.join(repo, config.brain?.dir ?? 'brain', file)))})));
}
export function hardRuleTargets(router) {
  const lines = router.split(/\r?\n/);
  let active = false;
  const result = [];
  for (const line of lines) {
    if (/^##\s/.test(line)) active = /^##\s+Hard rules/i.test(line);
    if (active) result.push(...mdLinks(line));
  }
  return result;
}
// Kit 3.3.6 item 20: the cards a router lists under ## Hard rules as [[wikilinks]] (a name, a file name, [[card|alias]],
// [[card#heading]]). A name resolves only once the files are parsed, so memoryFiles resolves these in a second pass.
export function hardRuleWikilinks(router) {
  let active = false;
  const result = [];
  for (const line of router.split(/\r?\n/)) {
    if (/^##\s/.test(line)) active = /^##\s+Hard rules/i.test(line);
    if (active) result.push(...wikilinks(line));
  }
  return result;
}
export const isIndexPage = file => file.startsWith('INDEX-') && /\.md$/i.test(file);
export function indexFamily(file) {
  const stem = file.slice(6, -3), parts = stem.split('-');
  return parts.length > 1 && /^\d{1,3}$/.test(parts.at(-1)) && !/^\d{4}$/.test(parts.at(-2)) ? parts.slice(0, -1).join('-') : stem;
}
export function parseHandover(text) {
  const fm = parseFrontmatter(text), header = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] ?? '';
  for (const key of ['branch', 'sha', 'mode']) {
    const raw = new RegExp('^' + key + ':[ \\t]*(.*)$', 'm').exec(header)?.[1].trim();
    if (raw !== undefined && !/^[\[\]{|>]/.test(raw)) fm.data[key] = /^["']/.test(raw) ? scalar(raw) : raw;
  }
  const {time, branch, sha, mode} = fm.data;
  const valid = !text.includes('\0') && !fm.data.__error && !fm.data.__warnings && typeof time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(time) && Number.isFinite(Date.parse(time)) && new Date(time.slice(0, 10)).toISOString().slice(0, 10) === time.slice(0, 10) && typeof branch === 'string' && Boolean(branch.trim()) && typeof sha === 'string' && /^[a-f0-9]{7}$/.test(sha) && ['full', 'quick'].includes(mode);
  return {...fm, valid};
}
export function handoverFiles(memoryDir) {
  try {
    const dir = path.join(memoryDir, 'handovers');
    let names;
    try { names = fs.readdirSync(dir).filter(name => /\.md$/i.test(name)).sort(); }
    catch (error) { return error.code === 'ENOENT' ? [] : [{file: 'handovers/', kind: 'stray', text: '', bytes: 0, error: 'cannot read handovers folder'}]; }
    return names.map(name => {
      const file = 'handovers/' + name, kind = /^\d{6}-\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(name) ? 'note' : /^archive-\d{4}-\d{2}\.md$/.test(name) ? 'archive' : 'stray';
      try {
        const absolute = path.join(dir, name);
        if (!fs.lstatSync(absolute).isFile()) throw new Error('not a regular file');
        const raw = fs.readFileSync(absolute), text = raw.toString('utf8');
        return {file, kind, ...parseHandover(text), raw, text, bytes: raw.length};
      } catch { return {file, kind, text: '', bytes: 0, valid: false, error: 'cannot read handover file'}; }
    });
  } catch { return []; }
}
export function memoryFiles(dir) {
  const router = read(path.join(dir, 'MEMORY.md')), hard = new Set(hardRuleTargets(router).map(p => pathKey(dir, p)));
  const rows = listMd(dir).map(file => {
    const text = read(path.join(dir, file)), fm = parseFrontmatter(text);
    const special = /^MEMORY\.md$/i.test(file) ? 'router' : isIndexPage(file) ? 'index' : /^ARCHIVE\.md$/i.test(file) ? 'archive' : null;
    const stub = fmGet(fm.data, 'moved_to') !== undefined;
    const state = fmGet(fm.data, 'state') === true;
    const hardRule = hard.has(pathKey(dir, file));
    return { file, text, ...fm, bytes: utf8Bytes(text), special, stub, state, hardRule,
      topic: !special && !stub && !state && !hardRule };
  });
  // Kit 3.3.6 item 20: a wikilink under ## Hard rules names its card through the parsed names, so it is resolved here.
  const wikilinked = hardRuleWikilinks(router);
  if (wikilinked.length) {
    const names = memoryNameIndex(rows);
    for (const name of wikilinked) {
      const card = resolveWikilink(name, link => names.get(pathSpelling(link)));
      if (card) { card.hardRule = true; card.topic = false; }
    }
  }
  return rows;
}

export function lessonCases() {
  const installed = path.basename(toolDir) === 'memory';
  const file = path.join(toolDir, installed ? 'LESSON-KINDS.md' : '../docs/LESSON-KINDS.md');
  const text = read(file), ids = new Set(), superseded = new Map();
  let current;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^#{2,3} (K[1-9]\d*)(?::|\s|$)/.exec(line);
    if (/^#{1,6}(?:\s|$)/.test(line)) current = undefined;
    if (heading) { current = heading[1]; ids.add(current); }
    const prior = /^supersedes: (K[1-9]\d*(?:(?:,\s*|\s+)K[1-9]\d*)*)\s*$/.exec(line);
    if (prior && current) for (const id of prior[1].split(/[,\s]+/)) superseded.set(id, current);
  }
  return {missing: !fs.existsSync(file), ids, superseded};
}
export function validateKindCase(id) {
  if (id === undefined) return;
  const book = lessonCases();
  if (book.missing) throw Error('LESSON-KINDS.md is missing; cannot validate kind case ' + String(id));
  if (!book.ids.has(id)) throw Error('unknown kind case ' + String(id) + '; see LESSON-KINDS.md');
}

export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  const values = new Set(['memory-dir', 'repo', 'scope', 'k', 'write', 'out', 'baseline', 'accepted', 'write-allowlist', 'config', 'today', 'keep', 'route', 'takeaway', 'kind', 'trigger', 'tool', 'case', 'score', 'reference']);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { out._.push(argv[i]); continue; }
    if (argv[i].includes('=')) throw new Error(argv[i] + ' is not supported; use ' + argv[i].replace('=', ' '));
    const key = argv[i].slice(2);
    if (key === 'source' || key === 'dest' || key === 'file') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing --${key} value`);
      (out[key] ??= []).push(argv[++i]);
    } else if (values.has(key)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing --${key} value`);
      if (['kind', 'takeaway', 'trigger', 'case', 'score', 'reference'].includes(key) && Object.hasOwn(out, key)) throw new Error('--' + key + ' given twice');
      const value = argv[++i];
      out[key] = key === 'route' && Object.hasOwn(out, key) ? out[key] + ',' + value : value;
    } else if (key === 'probe') out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else out[key] = true;
  }
  return out;
}
export function locations(opts, {env = gitEnvironment()} = {}) {
  const repo = path.resolve(opts.repo || repoRoot());
  const memory = memoryLocation(repo, opts['memory-dir'], {env});
  return { repo, memoryDir: memory.dir, memorySource: memory.source };
}
export function requireMemory(dir) {
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('memory dir not found');
}

export const secretSources = {
  anthropic: /sk-\x61nt-[A-Za-z0-9_-]{20,}/,
  openai: /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{32,}/,
  aws: /AK\x49A[0-9A-Z]{16}/,
  github: /gh[pousr]_[A-Za-z0-9]{36,}/,
  slack: /xox[baprs]-[A-Za-z0-9-]{10,}/,
  'private-key': /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  google: /AI\x7aa[0-9A-Za-z_-]{35}/,
  jwt: /ey\x4a[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
  resend: /r\x65_[A-Za-z0-9]{20,}/,
  stripe: /(?:sk|rk)_live_[A-Za-z0-9]{20,}/,
  'github-pat': /github_\x70at_[A-Za-z0-9_]{40,}/,
  supabase: /sb\x70_[a-f0-9]{40}/,
  webhook: /wh\x73ec_[A-Za-z0-9]{20,}/,
};
const secrets = secretSources;
const redactions = Object.entries(secrets).map(([name, pattern]) => [name, new RegExp(pattern.source, 'g')]);
export function redact(text) {
  text = String(text);
  for (const [name, pattern] of redactions) text = text.replace(pattern, `[REDACTED:${name}]`);
  return text;
}
