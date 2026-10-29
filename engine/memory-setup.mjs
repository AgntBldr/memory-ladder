import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {matchEol,isIndexPage,memoryLocation,memorySlug,slash} from './lib.mjs';
import {writeMemoryIndex,isGenerated} from './memory-index.mjs';
export function readJSON(f) {
  try { return JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,'')); }
  catch(e) { throw new Error(`cannot read ${f}: ${String(e.message).replace(/[\r\n]+/g,' ')}`); }
}
export const write = (f, data) => { fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f,fs.existsSync(f)?matchEol(data,fs.readFileSync(f,'utf8')):data); };
export const writeJSON = (f, data) => write(f,JSON.stringify(data,null,2)+'\n');
export function run(command, argv, opts = {}) {
  const r = spawnSync(command,argv,{encoding:'utf8',timeout:120000,...opts});
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
export function finishMemory({memory,target,engine,configFile,freshMemory,newRepo,inRepo,indexPages=files=>files.filter(f=>isIndexPage(f))}) {
  fs.mkdirSync(memory.dir,{recursive:true});
  if(newRepo) run('git',['-C',memory.dir,'init']);
  const needsBaseline=!inRepo && spawnSync('git',['-C',memory.dir,'rev-parse','--verify','HEAD'],{encoding:'utf8'}).status!==0;
  const config=readJSON(configFile);
  if(freshMemory) {
    writeMemoryIndex({memoryDir:memory.dir,config});
  }
  {
    const ignore=path.join(memory.dir,'.gitignore'),text=fs.existsSync(ignore)?fs.readFileSync(ignore,'utf8'):'';
    if(!text.split(/\r?\n/).includes('.memory.lock*')) write(ignore,text+(text&&!text.endsWith('\n')?'\n':'')+'.memory.lock*\n');
  }
  const indexes=indexPages(fs.readdirSync(memory.dir)).filter(f=>!isGenerated(fs.readFileSync(path.join(memory.dir,f),'utf8')));
  if(indexes.some(f=>!Object.keys(config.pins||{}).some(k=>k.toLowerCase()===f.toLowerCase()))) {
    if(!config.pins) { config.pins={};writeJSON(configFile,config); }
    run(process.execPath,[path.join(engine,'memory-check.mjs'),'--repo',target,'--memory-dir',memory.dir,'--ratchet-pins']);
  }
  if(needsBaseline) {
    let identity=[];
    try { run('git',['-C',memory.dir,'var','GIT_AUTHOR_IDENT']); }
    catch { identity=['-c','user.name=memory-ladder-kit','-c','user.email=kit@localhost']; console.log('Git has no saved author name and email; the first notes commit uses memory-ladder-kit (kit@localhost) only for this commit.'); }
    run('git',['-C',memory.dir,'add','.']);
    run('git',['-C',memory.dir,...identity,'commit','-m','Baseline memory']);
  }
}
export function memoryHook(target,memory) {
  const engine=path.join(target,'scripts/memory');
  const hook=spawnSync(process.execPath,[path.join(engine,'install-hooks.mjs'),'--memory-dir',memory.dir,'--repo',target],{encoding:'utf8'});
  if(hook.error || (hook.status!==0 && !hook.stdout.includes('foreign pre-commit'))) throw new Error(hook.error?.message || hook.stdout+hook.stderr);
  console.log(hook.stdout.trim());
}
