import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {matchEol,isIndexPage,memoryLocation,memorySlug,slash} from './lib.mjs';
import {cleanGitEnv} from './install-hooks.mjs';
import {writeMemoryIndex,isGenerated} from './memory-index.mjs';
import {refuseWhilePending} from './memory-session.mjs';
import {withMemoryLock,withLockIgnores} from './memory-lock.mjs';
export function readJSON(f) {
  try { return JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,'')); }
  catch(e) { throw new Error(`cannot read ${f}: ${String(e.message).replace(/[\r\n]+/g,' ')}`); }
}
export const write = (f, data) => { fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f,fs.existsSync(f)?matchEol(data,fs.readFileSync(f,'utf8')):data); };
export const writeJSON = (f, data) => write(f,JSON.stringify(data,null,2)+'\n');
export function run(command, argv, opts = {}) {
  const r = spawnSync(command,argv,{encoding:'utf8',timeout:120000,...opts,env:cleanGitEnv(opts.env??process.env)});
  if(r.error || r.status !== 0) throw new Error(r.error?.message || (r.stdout+r.stderr).trim() || command+' exited '+r.status);
  return r.stdout.trim();
}
export function resolveMemory(target, requested) {
  const resolved = memoryLocation(target,requested);
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return {dir:resolved.dir || path.join(home,'.claude/projects',memorySlug(path.resolve(target)),'memory'),custom:resolved.source!=='default',source:resolved.source};
}
export function gate(target, memoryDir) {
  const output = run(process.execPath,[path.join(target,'scripts/memory/memory-check.mjs'),'--repo',target,'--memory-dir',memoryDir]);
  console.log(output); return output.split(/\r?\n/).at(-1);
}

export function freshMemoryWrites(memoryDir,templates) {
  return ['MEMORY.md','current-state.md'].filter(file=>!fs.existsSync(path.join(memoryDir,file))).map(file=>[path.join(memoryDir,file),fs.readFileSync(path.join(templates,file))]);
}
export function finishMemory({memory,target,engine,configFile,freshMemory,newRepo,inRepo,indexPages=files=>files.filter(f=>isIndexPage(f)),lock,beforeLock}) {
  // Kit 3.3.5 E2.4: setup regenerates pages and edits memory's .gitignore, so it is exclusive: it refuses while any live
  // session holds unresolved claims. The check runs inside the lock acquisition that covers every write.
  fs.mkdirSync(memory.dir,{recursive:true});
  if(!lock) beforeLock?.();
  return withMemoryLock(memory.dir,held=>{
    refuseWhilePending({memoryDir:memory.dir,label:'memory setup',ownId:null});
    finishMemoryLocked({memory,target,engine,configFile,freshMemory,newRepo,inRepo,indexPages,lock:held});
  },{lock});
}
function finishMemoryLocked({memory,target,engine,configFile,freshMemory,newRepo,inRepo,indexPages,lock}) {
  if(newRepo) run('git',['-C',memory.dir,'init']);
  const needsBaseline=!inRepo && spawnSync('git',['-C',memory.dir,'rev-parse','--verify','HEAD'],{encoding:'utf8',env:cleanGitEnv()}).status!==0;
  const config=readJSON(configFile);
  if(freshMemory) {
    writeMemoryIndex({memoryDir:memory.dir,config,lock});
  }
  {
    // E2.8 (c): the lock pattern that covers both locks, from the one list the upgrade uses too.
    const ignore=path.join(memory.dir,'.gitignore'),text=fs.existsSync(ignore)?fs.readFileSync(ignore,'utf8'):'';
    if(withLockIgnores(text)!==text) write(ignore,withLockIgnores(text));
  }
  const indexes=indexPages(fs.readdirSync(memory.dir)).filter(f=>!isGenerated(fs.readFileSync(path.join(memory.dir,f),'utf8')));
  if(indexes.some(f=>!Object.keys(config.pins||{}).some(k=>k.toLowerCase()===f.toLowerCase()))) {
    if(!config.pins) { config.pins={};writeJSON(configFile,config); }
    run(process.execPath,[path.join(engine,'memory-check.mjs'),'--repo',target,'--memory-dir',memory.dir,'--ratchet-pins']);
  }
  if(needsBaseline) {
    let identity=[];
    // Kit 3.3.6: a commit needs both identities; an author known without a committer (author variables only) fails the commit.
    try { run('git',['-C',memory.dir,'var','GIT_AUTHOR_IDENT']); run('git',['-C',memory.dir,'var','GIT_COMMITTER_IDENT']); }
    catch { identity=['-c','user.name=memory-ladder-kit','-c','user.email=kit@localhost']; console.log('Git has no saved author name and email; the first notes commit uses memory-ladder-kit (kit@localhost) only for this commit.'); }
    run('git',['-C',memory.dir,'add','.']);
    run('git',['-C',memory.dir,...identity,'commit','-m','Baseline memory']);
  }
}
export function memoryHook(target,memory) {
  const engine=path.join(target,'scripts/memory');
  const hook=spawnSync(process.execPath,[path.join(engine,'install-hooks.mjs'),'--memory-dir',memory.dir,'--repo',target],{encoding:'utf8',env:cleanGitEnv()});
  // A linked worktree never receives the hook: like a foreign hook, it is reported, not fatal.
  if(!hook.error && hook.status!==0 && hook.stdout.includes('refusing to point the memory hook at a linked worktree')) {
    const main=hook.stdout.split('run install-hooks.mjs from the main checkout ')[1]?.trim();
    console.log(`Hook skipped: ${target} is a linked worktree of ${main}; from the main checkout run: node scripts/memory/install-hooks.mjs --repo . --memory-dir "${memory.dir}"`);
    return;
  }
  if(hook.error || (hook.status!==0 && !hook.stdout.includes('foreign pre-commit'))) throw new Error(hook.error?.message || hook.stdout+hook.stderr);
  console.log(hook.stdout.trim());
}
