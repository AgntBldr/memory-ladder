import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { kitRoot, files, hash } from '../scripts/manifest.mjs';
export { kitRoot, files, hash };
export const read = f => fs.readFileSync(f,'utf8');
export const currentVersion = read(path.join(kitRoot,'VERSION')).trim();
export const nextVersion = currentVersion.replace(/^(\d+\.\d+\.)(\d+)(?:[-+].*)?$/, (_, prefix, patch) => prefix + (Number(patch) + 1));
export const versionPattern = currentVersion.replaceAll('.', '\\.');
export const nextVersionPattern = nextVersion.replaceAll('.', '\\.');
export const json = f => JSON.parse(read(f));
export function put(f,s) { fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f,s); return f; }
export function tree(root,{git=false,previous=false}={}) {
  return Object.fromEntries(files(root).filter(f=>(git||!f.split('/').includes('.git'))&&(previous||!f.split('/').some(p=>p.startsWith('.kit-backup-')))).map(f=>[f,fs.readFileSync(path.join(root,f)).toString('base64')]));
}
export function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'kit-'))), target=path.join(root,'project'),home=path.join(root,'home');
  fs.mkdirSync(target); fs.mkdirSync(home);
  const env={...process.env,HOME:home,USERPROFILE:home,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(home,'.gitconfig')};
  delete env.CLAUDE_MEMORY_DIR;
  put(env.GIT_CONFIG_GLOBAL,'[user]\n name = kit-test\n email = kit-test@example.invalid\n[core]\n autocrlf = false\n longpaths = true\n');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const exec=(command,args,opts={})=>{
    const r=spawnSync(command,args,{encoding:'utf8',env,cwd:target,timeout:120000,...opts}); assert.ifError(r.error);return r;
  };
  const git=(dir,...args)=>{const r=exec('git',['-C',dir,'-c','user.name=kit-test','-c','user.email=kit-test@example.invalid',...args]);assert.equal(r.status,0,r.stdout+r.stderr);return r.stdout.trim();};
  git(target,'init');
  put(path.join(target,'AGENTS.md'),'');put(path.join(target,'.claude/settings.json'),'{"unrelated":{"keep":true}}\n');
  const cli=(file,args=[],base=kitRoot)=>exec(process.execPath,[path.join(base,file),...args]);
  const install=(args=[],base=kitRoot)=>cli('scripts/install.mjs',['--target',target,...args],base);
  return {root,target,home,env,exec,git,cli,install,memory:path.join(home,'.claude/projects',target.replace(/[^A-Za-z0-9]/g,'-'),'memory')};
}
export function ok(r) { assert.equal(r.status,0,r.stdout+r.stderr); return r; }
export function bump(f) {
  const root=path.join(f.root,'new-kit'); fs.mkdirSync(root);
  // Permit workspace-local temporary fixtures without copying the fixtures into themselves.
  for(const entry of fs.readdirSync(kitRoot)) {
    const source=path.join(kitRoot,entry),relative=path.relative(source,f.root);
    if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))) continue;
    fs.cpSync(source,path.join(root,entry),{recursive:true});
  }
  put(path.join(root,'VERSION'),nextVersion+'\n');
  const config=json(path.join(root,'engine/memory.config.json'));config.engine_version=nextVersion;config.newDefault={enabled:true};
  put(path.join(root,'engine/memory.config.json'),JSON.stringify(config,null,2)+'\n');
  for(const name of ['memory-ladder','memory-review']) {
    const p=path.join(root,'skills',name,'SKILL.md');put(p,read(p).replace('engine_version: "'+currentVersion+'"','engine_version: "'+nextVersion+'"'));
  }
  const engine=path.join(root,'engine/lib.mjs');put(engine,read(engine)+'\n// New release fixture.\n');
  ok(f.cli('scripts/manifest.mjs',[],root));return root;
}
