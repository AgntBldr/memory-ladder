import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { args, locations, isDirect, slash, read, toolDir, inRepoMemory } from './lib.mjs';

export const marker = '# memory-v3-gate (installed by scripts/memory/install-hooks.mjs; edit there)';
const shellQuoted = value => `"${slash(path.resolve(value)).replace(/["$`\\]/g, '\\$&')}"`;
export function install({ memoryDir, repo, uninstall = false }) {
  if (inRepoMemory(repo, memoryDir)) {
    const quoted = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const rel = slash(path.relative(repo, memoryDir));
    const command = `if git diff --cached --name-only -- ${quoted(rel + '/')} | grep -q .; then node scripts/memory/memory-check.mjs --hook --scope memory || exit $?; fi`;
    let hooksPathSet = false;
    try { childProcess.execFileSync('git',['-C',repo,'config','--get','core.hooksPath'],{encoding:'utf8',stdio:'pipe'}); hooksPathSet = true; } catch {}
    const preserved = {ok:true,message:`project hook preserved; add this line from the repo root:\n${command}`};
    if (hooksPathSet) return preserved;
    const gitHook = childProcess.execFileSync('git',['-C',repo,'rev-parse','--git-path','hooks/pre-commit'],{encoding:'utf8',stdio:'pipe'}).trim();
    const hook = path.resolve(repo,gitHook);
    if (fs.existsSync(hook)) {
      if (!read(hook).split(/\r?\n/).includes(marker)) return preserved;
      if (uninstall) { fs.unlinkSync(hook); return {ok:true,message:'kit hook removed'}; }
      return {ok:true,message:'kit hook present'};
    }
    if (uninstall) return {ok:true,message:'project hook is not installed'};
    fs.mkdirSync(path.dirname(hook),{recursive:true});
    fs.writeFileSync(hook,`#!/bin/sh\n${marker}\nif ! git diff --cached --name-only -- ${quoted(rel + '/')} | grep -q .; then exit 0; fi\nnode scripts/memory/memory-check.mjs --hook --scope memory\n`);
    if(process.platform!=='win32') fs.chmodSync(hook,0o755);
    return {ok:true,message:`in-repo memory gate hook installed: ${hook}`};
  }
  if (!memoryDir || !fs.existsSync(path.join(memoryDir, '.git')) || !fs.statSync(path.join(memoryDir, '.git')).isDirectory()) {
    return { ok: false, message: 'memory dir has no .git folder; hook not changed' };
  }
  let hooksPath = '';
  try { hooksPath = childProcess.execFileSync('git', ['-C', memoryDir, 'config', '--local', 'core.hooksPath'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim(); }
  catch { /* An unset hooksPath uses the repository's hooks directory. */ }
  const hook = path.join(hooksPath ? path.resolve(memoryDir, hooksPath) : path.join(memoryDir, '.git/hooks'), 'pre-commit');
  const exists = fs.existsSync(hook);
  const owned = exists && read(hook).split(/\r?\n/).includes(marker);
  if (exists && !owned) return { ok: false, message: 'foreign pre-commit hook; refusing to change it' };
  if (uninstall) {
    if (owned) fs.unlinkSync(hook);
    return { ok: true, message: owned ? 'memory gate hook removed' : 'memory gate hook is not installed' };
  }
  const installedGate = path.join(repo, 'scripts/memory/memory-check.mjs');
  const gate = fs.existsSync(installedGate) ? installedGate : path.join(toolDir, 'memory-check.mjs');
  if (!fs.existsSync(gate)) return { ok: false, message: 'memory-check.mjs not found in installed or running tool directory; hook not changed' };
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  const missingGate = gate === installedGate ? '' : `if [ ! -f ${shellQuoted(gate)} ]; then\n  echo "memory gate not found at "${shellQuoted(gate)}"; reinstall the hook with install-hooks.mjs"\n  exit 1\nfi\n`;
  const text = `#!/bin/sh\n${marker}\nif ! command -v node >/dev/null 2>&1; then\n  echo "memory gate skipped: node not found"\n  exit 0\nfi\n${missingGate}node ${shellQuoted(gate)} --hook --scope memory --memory-dir ${shellQuoted(memoryDir)}${gate === installedGate ? '' : ` --repo ${shellQuoted(repo)}`} || {\n  echo "memory gate failed: fix the FAIL lines above (or add a dated allow entry) and commit again"; exit 1; }\n`;
  fs.writeFileSync(hook, text);
  if (process.platform !== 'win32') fs.chmodSync(hook, 0o755);
  return { ok: true, message: `memory gate hook installed: ${hook}` };
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
