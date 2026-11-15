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
// An instruction file after an update differs from before only in span 1 (the old section, or the old block,
// or the appended end) and span 2 (kept lines added at the end of an existing Project rules section).
// The block must hold the template, and every other byte, Project rules included, must be unchanged.
export function assertInstructionSpans(before,after,{kept=[],body=read(path.join(kitRoot,'templates/AGENTS-memory-gate.md'))}={}) {
  const eol=after.includes('\r\n')?'\r\n':'\n',lines=text=>text.match(/[^\n]*\n|[^\n]+$/g)??[];
  const begin=/^<!-- kit standard block \(memory kit [0-9][0-9A-Za-z.+-]*\): begin\.[^\r\n]*(?:\r?\n|$)/gm,end=/^<!-- kit standard block: end -->[ \t]*(?:\r?\n|$)/gm;
  const b=[...after.matchAll(begin)],e=[...after.matchAll(end)];
  assert.equal(b.length,1,'exactly one begin marker');assert.equal(e.length,1,'exactly one end marker');
  assert.ok(b[0].index<e[0].index,'begin before end');
  assert.equal(after.slice(b[0].index+b[0][0].length,e[0].index).replace(/\r\n/g,'\n'),body.replace(/\r\n/g,'\n'),'block equals the template');
  let start=b[0].index,stop=e[0].index+e[0][0].length,oldStart,oldStop;
  const ob=[...before.matchAll(begin)],oe=[...before.matchAll(end)];
  const trimmed=text=>{const all=lines(text);while(all.length>1&&!/\S/.test(all.at(-1))) all.pop();return all.join('');};
  const rulesLine='Rules for this project only. The kit adds old lines here once, when it sorts them on a first update; it never edits or removes them.';
  const hadRules=/^## Project rules[ \t]*\r?$/m.test(before);
  if(ob.length) { oldStart=ob[0].index;oldStop=oe[0].index+oe[0][0].length; }
  else {
    const gate=/^## Memory gate(?:[ \t][^\r\n]*)?(?:\r?\n|$)[\s\S]*?(?=^#{1,2} |(?![\s\S]))/m.exec(before);
    if(gate) { oldStart=gate.index;oldStop=oldStart+trimmed(gate[0]).length; }
    else {
      const ladder=/^#{1,3} [^\r\n]*Memory ladder[^\r\n]*(?:\r?\n|$)/im.exec(before);
      if(ladder) {
        const rest=before.slice(ladder.index+ladder[0].length),body=/^[\s\S]*?(?=^#{1,6}(?:[ \t]|\r?$)|(?![\s\S]))/m.exec(rest)[0];
        const lead=/^(?:[ \t]*\r?\n)*/.exec(body)[0].length;
        oldStart=ladder.index+ladder[0].length+lead;oldStop=oldStart+trimmed(body.slice(lead)).length;
        if(!/\S/.test(body)) oldStop=oldStart;
      } else { oldStart=oldStop=before.length;start-=before.endsWith('\n')?eol.length:2*eol.length;assert.equal(after.slice(start,b[0].index),before.endsWith('\n')?eol:eol+eol,'append separator'); }
    }
    if(!hadRules) {
      const section=eol+'## Project rules'+eol+rulesLine+eol+(kept.length?eol+kept.map(line=>line+eol).join(''):'');
      assert.equal(after.slice(stop,stop+section.length),section,'new Project rules section after the block');
      stop+=section.length;
    }
  }
  const remainder=after.slice(0,start)+after.slice(stop),unchanged=before.slice(0,oldStart)+before.slice(oldStop);
  if(hadRules&&kept.length&&!ob.length) {
    // Span 2 is derived from the original alone: the end of the last non-blank line of the existing Project rules
    // section, which ends at the next # or ## heading, at a block marker, or at the end of the file.
    const all=lines(before),offsets=[];let offset=0;
    for(const line of all) { offsets.push(offset);offset+=line.length; }
    const head=all.findIndex(line=>/^## Project rules[ \t]*\r?\n?$/.test(line));
    let stop=head+1;
    while(stop<all.length&&!/^#{1,2} /.test(all[stop])&&!/^<!-- kit standard block/.test(all[stop])) stop++;
    let last=stop-1;
    while(last>head&&!/\S/.test(all[last])) last--;
    const insertAt=offsets[last]+all[last].length,unterminated=!all[last].endsWith('\n');
    assert.ok(insertAt<=oldStart||insertAt>=oldStop,'the Project rules section lies outside the old section');
    const at=insertAt<=oldStart?insertAt:insertAt-(oldStop-oldStart);
    // A last line without a line ending gets one first; that ending is part of the inserted bytes.
    const inserted=(unterminated?eol:'')+kept.map(line=>line+eol).join('');
    assert.equal(remainder,unchanged.slice(0,at)+inserted+unchanged.slice(at),'kept lines inserted exactly after the last line of the existing Project rules section; every other byte unchanged');
    return;
  }
  assert.equal(remainder,unchanged,'only the standard block spans changed');
}
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
  for(const name of ['memory-ladder','memory-review','new-session','handover']) {
    const p=path.join(root,'skills',name,'SKILL.md');put(p,read(p).replace('engine_version: "'+currentVersion+'"','engine_version: "'+nextVersion+'"'));
  }
  const engine=path.join(root,'engine/lib.mjs');put(engine,read(engine)+'\n// New release fixture.\n');
  ok(f.cli('scripts/manifest.mjs',[],root));return root;
}
