import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { args, locations, isDirect, slash, read, toolDir, inRepoMemory, loadConfig, mainWorktree, pathKey, gitResult, useGitEnvironment, GIT_REDIRECTS, cleanGitEnv } from './lib.mjs';

// The one git environment cleaner lives in lib.mjs (kit 3.3.5 E2.8 (e)); the installer and updater keep importing it
// from here.
export { GIT_REDIRECTS, cleanGitEnv };
// A process that loads this module (the installer, the updater, install-hooks itself) gives lib.mjs's worktree
// calls the clean environment too.
useGitEnvironment(cleanGitEnv);

export const marker = '# memory-v3-gate (installed by scripts/memory/install-hooks.mjs; edit there)';
export const shellQuoted = value => !value.includes("'") ? "'" + slash(path.resolve(value)) + "'" : `"${slash(path.resolve(value)).replace(/["$`\\]/g, '\\$&')}"`;
function versionGuard(repo, version = loadConfig().engine_version) {
  // Inline in the hook so even an older checkout is checked before loading its gate.
  if (!/^[0-9]+[.][0-9]+[.][0-9]+(?:-[0-9A-Za-z.-]+)?(?:[+][0-9A-Za-z.-]+)?$/.test(version)) throw Error('invalid installing engine version');
  const code = `const fs=require("node:fs"),path=require("node:path");
const repo=process.argv[1],needed=${JSON.stringify(version)},receipt=path.join(repo,"scripts/memory/KIT.json");
if(fs.existsSync(receipt)) {
 const used=JSON.parse(fs.readFileSync(receipt,"utf8")).version;
 const parse=v=>/^([0-9]+)[.]([0-9]+)[.]([0-9]+)(?:-([0-9A-Za-z.-]+))?(?:[+][0-9A-Za-z.-]+)?$/.exec(v);
 const a=parse(used),b=parse(needed);
 if(!a||!b) {console.error("memory gate: invalid engine version at "+repo);process.exit(1);}
 const older=()=>{
  for(let i=1;i<=3;i++) if(BigInt(a[i])!==BigInt(b[i])) return BigInt(a[i])<BigInt(b[i]);
  if(!a[4]||!b[4]) return Boolean(a[4]&&!b[4]);
  const x=a[4].split("."),y=b[4].split(".");
  for(let i=0;i<Math.max(x.length,y.length);i++) {
   if(x[i]===y[i]) continue;
   if(x[i]===undefined||y[i]===undefined) return x[i]===undefined;
   const xn=/^[0-9]+$/.test(x[i]),yn=/^[0-9]+$/.test(y[i]);
   return xn&&yn ? BigInt(x[i])<BigInt(y[i]) : xn!==yn ? xn : x[i]<y[i];
  }
  return false;
 };
 if(older()) {console.error("memory gate: checkout engine "+used+" is older than hook engine "+needed+" at "+repo);process.exit(1);}
}`;
  return `node -e '${code}' ${shellQuoted(repo)} || exit $?\n`;
}
// The linked-worktree check shared by the installer and the updater: the main checkout of a
// linked worktree, else null. Same rules as mainWorktree, with one git call when not linked. It never fails
// open: a result it cannot establish throws, so an unknown is never taken for a main checkout.
export function linkedWorktree(repo) {
  const unknown = reason => new Error(`cannot tell whether ${repo} is a linked worktree (${reason})`);
  // A linked worktree's root holds a .git file; a real .git folder (not a link) marks a main checkout, so no git
  // call is needed. A linked .git goes through git like anything else.
  let stat = null;
  try { stat = fs.lstatSync(path.join(repo, '.git')); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw unknown(error.code); }
  if (stat?.isDirectory()) return null;
  const dirs = gitResult(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--absolute-git-dir'], {env: {...cleanGitEnv(), LC_ALL: 'C', LANG: 'C'}});
  const err = String(dirs.stderr ?? '').trim();
  // Outside any repository there is no worktree to link.
  if (!stat && dirs.status === 128 && err === 'fatal: not a git repository (or any of the parent directories): .git') return null;
  const [common, dir] = dirs.status === 0 && !dirs.error ? dirs.stdout.trim().split(/\r?\n/) : [];
  if (!common || !dir) throw unknown(`git rev-parse exited ${dirs.status}${err ? ': ' + err.split(/\r?\n/)[0] : ''}`);
  if (pathKey(common) === pathKey(dir)) return null;
  const list = gitResult(repo, ['worktree', 'list', '--porcelain', '-z'], {env: cleanGitEnv()});
  if (list.status !== 0 || !list.stdout.startsWith('worktree ')) throw unknown(`git worktree list exited ${list.status}`);
  // As mainWorktree: a bare main repository has no main checkout to name.
  if (list.stdout.split('\0\0')[0].split('\0').includes('bare')) return null;
  const main = list.stdout.slice(9).split('\0')[0];
  return pathKey(main) === pathKey(repo) ? null : path.resolve(main);
}
// The exact text install() writes for this memory and repo; reads only whether the installed gate exists.
export function hookText({ memoryDir, repo, version = loadConfig().engine_version }) {
  if (inRepoMemory(repo, memoryDir)) {
    const quoted = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const rel = slash(path.relative(repo, memoryDir));
    return `#!/bin/sh\n${marker}\nif ! git diff --cached --name-only -- ${quoted(rel + '/')} | grep -q .; then exit 0; fi\n${versionGuard(repo, version)}node scripts/memory/memory-check.mjs --hook --scope memory\n`;
  }
  const installedGate = path.join(repo, 'scripts/memory/memory-check.mjs');
  const gate = fs.existsSync(installedGate) ? installedGate : path.join(toolDir, 'memory-check.mjs');
  const missingGate = gate === installedGate ? '' : `if [ ! -f ${shellQuoted(gate)} ]; then\n  echo "memory gate not found at "${shellQuoted(gate)}"; reinstall the hook with install-hooks.mjs"\n  exit 1\nfi\n`;
  return `#!/bin/sh\n${marker}\nif ! command -v node >/dev/null 2>&1; then\n  echo "memory gate skipped: node not found"\n  exit 0\nfi\n${missingGate}${versionGuard(repo, version)}node ${shellQuoted(gate)} --hook --scope memory --memory-dir ${shellQuoted(memoryDir)}${gate === installedGate ? '' : ` --repo ${shellQuoted(repo)}`} || {\n  echo "memory gate failed: fix the FAIL lines above (or add a dated allow entry) and commit again"; exit 1; }\n`;
}
// Pure: computes the hook path, its current text and the exact text install() would write. Writes nothing.
// status: 'write' (next holds the text), 'preserved' (host-owned or foreign hook), 'error' or 'worktree'.
export function hookPlan({ memoryDir, repo, version = loadConfig().engine_version }) {
  const main = linkedWorktree(repo);
  if (main) return { status: 'worktree', main, message: `refusing to point the memory hook at a linked worktree ${repo}; run install-hooks.mjs from the main checkout ${main}` };
  if (inRepoMemory(repo, memoryDir)) {
    const quoted = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const rel = slash(path.relative(repo, memoryDir));
    const command = `if git diff --cached --name-only -- ${quoted(rel + '/')} | grep -q .; then node scripts/memory/memory-check.mjs --hook --scope memory || exit $?; fi`;
    let hooksPathSet = false;
    try { childProcess.execFileSync('git',['-C',repo,'config','--get','core.hooksPath'],{encoding:'utf8',stdio:'pipe',env:cleanGitEnv()}); hooksPathSet = true; } catch {}
    const preserved = `project hook preserved; add this line to your pre-commit hook (create one if none exists), not as a one-time terminal command:\n${command}`;
    if (hooksPathSet) return { status: 'preserved', reason: 'hooksPath', inRepo: true, message: preserved };
    const gitHook = childProcess.execFileSync('git',['-C',repo,'rev-parse','--git-path','hooks/pre-commit'],{encoding:'utf8',stdio:'pipe',env:cleanGitEnv()}).trim();
    const hook = path.resolve(repo,gitHook);
    const exists = fs.existsSync(hook), current = exists ? read(hook) : null;
    if (exists && !current.split(/\r?\n/).includes(marker)) return { status: 'preserved', reason: 'foreign', inRepo: true, hook, exists, current, message: preserved };
    const next = hookText({ memoryDir, repo, version });
    return { status: 'write', inRepo: true, hook, exists, current, next, message: exists ? 'kit hook present; checks before saving a Git commit' : `in-repo memory gate hook installed; checks before saving a Git commit: ${hook}` };
  }
  if (!memoryDir || !fs.existsSync(path.join(memoryDir, '.git')) || !fs.statSync(path.join(memoryDir, '.git')).isDirectory()) {
    return { status: 'error', message: 'The notes folder has no .git folder; initialize it with git init in that folder, then run this command again.' };
  }
  let hooksPath = '';
  try { hooksPath = childProcess.execFileSync('git', ['-C', memoryDir, 'config', '--local', 'core.hooksPath'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, env: cleanGitEnv() }).trim(); }
  catch { /* An unset hooksPath uses the repository's hooks directory. */ }
  const hook = path.join(hooksPath ? path.resolve(memoryDir, hooksPath) : path.join(memoryDir, '.git/hooks'), 'pre-commit');
  const exists = fs.existsSync(hook), current = exists ? read(hook) : null;
  const owned = exists && current.split(/\r?\n/).includes(marker);
  const installedGate = path.join(repo, 'scripts/memory/memory-check.mjs');
  const gate = fs.existsSync(installedGate) ? installedGate : path.join(toolDir, 'memory-check.mjs');
  if (!fs.existsSync(gate)) return { status: 'error', hook, exists, current, owned, message: 'memory-check.mjs not found in installed or running tool directory; reinstall the memory kit, then run this command again.' };
  if (exists && !owned) return { status: 'preserved', reason: 'foreign', hook, exists, current, owned, message: `foreign pre-commit hook preserved; add this line to your pre-commit hook (create one if none exists), not as a one-time terminal command:\nnode ${shellQuoted(gate)} --hook --scope memory --memory-dir ${shellQuoted(memoryDir)} --repo ${shellQuoted(repo)} || exit $?` };
  const next = hookText({ memoryDir, repo, version });
  return { status: 'write', hook, exists, current, owned, gate, next, message: `memory gate hook installed; checks before saving a Git commit: ${hook}` };
}
function uninstallHook({ memoryDir, repo }) {
  if (inRepoMemory(repo, memoryDir)) {
    const quoted = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const rel = slash(path.relative(repo, memoryDir));
    const command = `if git diff --cached --name-only -- ${quoted(rel + '/')} | grep -q .; then node scripts/memory/memory-check.mjs --hook --scope memory || exit $?; fi`;
    let hooksPathSet = false;
    try { childProcess.execFileSync('git',['-C',repo,'config','--get','core.hooksPath'],{encoding:'utf8',stdio:'pipe',env:cleanGitEnv()}); hooksPathSet = true; } catch {}
    const preserved = {ok:true,message:`project hook preserved; add this line to your pre-commit hook (create one if none exists), not as a one-time terminal command:\n${command}`};
    if (hooksPathSet) return preserved;
    const gitHook = childProcess.execFileSync('git',['-C',repo,'rev-parse','--git-path','hooks/pre-commit'],{encoding:'utf8',stdio:'pipe',env:cleanGitEnv()}).trim();
    const hook = path.resolve(repo,gitHook);
    if (fs.existsSync(hook)) {
      if (!read(hook).split(/\r?\n/).includes(marker)) return preserved;
      fs.unlinkSync(hook); return {ok:true,message:'kit hook removed'};
    }
    return {ok:true,message:'project hook is not installed'};
  }
  if (!memoryDir || !fs.existsSync(path.join(memoryDir, '.git')) || !fs.statSync(path.join(memoryDir, '.git')).isDirectory()) {
    return { ok: false, message: 'The notes folder has no .git folder; initialize it with git init in that folder, then run this command again.' };
  }
  let hooksPath = '';
  try { hooksPath = childProcess.execFileSync('git', ['-C', memoryDir, 'config', '--local', 'core.hooksPath'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, env: cleanGitEnv() }).trim(); }
  catch { /* An unset hooksPath uses the repository's hooks directory. */ }
  const hook = path.join(hooksPath ? path.resolve(memoryDir, hooksPath) : path.join(memoryDir, '.git/hooks'), 'pre-commit');
  const exists = fs.existsSync(hook);
  const owned = exists && read(hook).split(/\r?\n/).includes(marker);
  if (exists && !owned) return {ok:false,message:'foreign pre-commit hook preserved; remove only your memory-check line from the existing hook to stop its checks.'};
  if (owned) fs.unlinkSync(hook);
  return { ok: true, message: owned ? 'memory gate hook removed' : 'memory gate hook is not installed' };
}
export function install({ memoryDir, repo, uninstall = false }) {
  if (uninstall) return uninstallHook({ memoryDir, repo });
  const plan = hookPlan({ memoryDir, repo });
  if (plan.status === 'worktree') return { ok: false, message: plan.message };
  if (plan.status === 'preserved') return { ok: Boolean(plan.inRepo), message: plan.message };
  if (plan.status === 'error') return { ok: false, message: plan.message };
  fs.mkdirSync(path.dirname(plan.hook), { recursive: true });
  fs.writeFileSync(plan.hook, plan.next);
  if (process.platform !== 'win32') fs.chmodSync(plan.hook, 0o755);
  return { ok: true, message: plan.message };
}
export function main(argv = process.argv.slice(2)) {
  try {
    const opts = args(argv);
    if (opts.help) { console.log('Usage: install-hooks.mjs [--uninstall] [--memory-dir PATH] [--repo PATH]'); return 0; }
    const result = install({ ...locations(opts), uninstall: Boolean(opts.uninstall) });
    console.log(result.message);
    return result.ok ? 0 : 1;
  } catch (error) { console.error(`install-hooks: ${error.message}`); return 1; }
}
if (isDirect(import.meta.url)) process.exitCode = main();
