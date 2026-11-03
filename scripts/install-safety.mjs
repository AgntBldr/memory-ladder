import {normalizeEol, pathKey} from '../engine/lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {installedManifest, hash} from './manifest.mjs';
import {readJSON} from '../engine/memory-setup.mjs';
const exists = file => fs.existsSync(file) && fs.statSync(file).isFile();
const inside = (root, file) => { const r=path.relative(root,file);return r!== '..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r); };
export function instructions(target) {
  const found=new Map();
  function visit(file) {
    if(!exists(file)) return;
    file=fs.realpathSync(file);
    if(found.has(file)) return;
    const text=fs.readFileSync(file,'utf8');found.set(file,text);
    for(const m of text.matchAll(/(?:^|\s)@([^\s`<>"()]+)/gm)) {
      const relative=path.resolve(path.dirname(file),m[1]),rooted=path.resolve(target,m[1]);
      visit(exists(relative)?relative:rooted);
    }
    for(const m of text.matchAll(/(?:@|\]\(|`)([^\s`<>"()]+\.md)\b/g)) {
      const relative=path.resolve(path.dirname(file),m[1]),rooted=path.resolve(target,m[1]);
      visit(exists(relative)?relative:rooted);
    }
  }
  for(const file of ['AGENTS.md','CLAUDE.md','CLAUDE.local.md']) visit(path.join(target,file));
  const rules=path.join(target,'.claude/rules');
  if(fs.existsSync(rules)) for(const name of fs.readdirSync(rules)) if(name.endsWith('.md')) visit(path.join(rules,name));
  return found;
}
export function checkMemoryRouter(target, memory, opts, sources) {
  const candidates=new Set();
  for(const [file,text] of sources) {
    for(const m of text.matchAll(/(?:[.\w-]+[\\/])*MEMORY\.md\b/gi)) {
      for(const base of [target,path.dirname(file)]) {const p=path.resolve(base,m[0]);if(inside(target,p)&&exists(p)) candidates.add(p);}
    }
  }
  for(const relative of ['.claude/memory/MEMORY.md','memory/MEMORY.md','MEMORY.md']) {
    const file=path.join(target,relative);
    if(exists(file)&&(relative.includes('/')||fs.readdirSync(target).some(n=>/^INDEX-.*\.md$/i.test(n)))) candidates.add(file);
  }
  for(const router of candidates) {
    const folder=path.dirname(router);
    if(path.resolve(memory.dir).toLowerCase()===folder.toLowerCase()) continue;
    const message=`in-repo memory router ${router}; would have gated ${memory.dir}`;
    if(!opts['accept-separate-memory']) throw new Error(message+'; refusing before writes. Use --accept-separate-memory to explicitly choose separate memory.');
    console.log('WARNING separate memory: '+message);
  }
}
const sessionSkills=['new-session','handover'];
export function mirrorWrites(target, planned, sources, {keepDivergent=false,replaceSkills=[]}={}) {
  const folders=new Set(['.agents/skills']);
  for(const text of sources.values()) for(const m of text.matchAll(/(?:[.\w-]+\/)+skills\b/g)) folders.add(m[0]);
  const result=[];
  for(const [file,data] of planned) {
    const relative=path.relative(path.join(target,'.claude/skills'),file);
    if(!inside(path.join(target,'.claude/skills'),file)||path.basename(file)!=='SKILL.md') continue;
    const name=relative.split(path.sep)[0];
    for(const folder of folders) {
      const mirror=path.resolve(target,folder,relative);
      const codex=sessionSkills.includes(name)&&folder==='.agents/skills'&&['.agents','.codex'].some(dir=>fs.existsSync(path.join(target,dir)));
      if(!sessionSkills.includes(name)&&!exists(file)) continue;
      if(mirror===file||!inside(target,mirror)||(!exists(mirror)&&!codex)) continue;
      if(exists(mirror)&&normalizeEol(fs.readFileSync(mirror,'utf8'))!==normalizeEol(data)&&(!exists(file)||normalizeEol(fs.readFileSync(mirror,'utf8'))!==normalizeEol(fs.readFileSync(file,'utf8')))) {
        if(keepDivergent) {console.log(`WARN mirror differs: ${mirror}; kept; copy ${file} to ${mirror} to refresh after reviewing host edits`);continue;}
        if(!replaceSkills.includes(name)) throw new Error(`skill mirror differs: ${mirror} vs ${file}; use --replace-skill ${name}; neither changed`);
      }
      result.push([mirror,data]);
    }
  }
  return result;
}
export const sessionPermission='Bash(node scripts/memory/new-session.mjs:*)';
const sessionPermissions=[sessionPermission,'PowerShell(node scripts/memory/new-session.mjs:*)'];
function validateHooks(settings, file='settings.json') {
  if(!settings||typeof settings!=='object'||Array.isArray(settings)) throw Error(file+' must be an object');
  if(settings.hooks==null) return;
  if(typeof settings.hooks!=='object'||Array.isArray(settings.hooks)) throw Error(file+' hooks must be an object');
  for(const [event,entries] of Object.entries(settings.hooks)) {
    if(!Array.isArray(entries)) throw Error(file+' hooks.'+event+' must be an array');
    for(const [i,entry] of entries.entries()) {
      const label=file+' hooks.'+event+'['+i+']';
      if(!entry||typeof entry!=='object'||Array.isArray(entry)) throw Error(label+' must be an object');
      if(entry.hooks===undefined) continue;
      if(!Array.isArray(entry.hooks)) throw Error(label+'.hooks must be an array');
      for(const [j,hook] of entry.hooks.entries()) if(!hook||typeof hook!=='object'||Array.isArray(hook)) throw Error(label+'.hooks['+j+'] must be an object');
    }
  }
}
export function mergeNewSessionHooks(settings, template, enabled=true, target=process.cwd()) {
  const before=JSON.stringify(settings);
  const ours=command=>{
    if(typeof command!=='string') return false;
    const match=/^node(?:\.exe)?\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+(?:detect|"detect"|'detect')$/.exec(command);
    if(!match) return false;
    const script=(match[1]??match[2]??match[3].replace(/["']/g,'')).replaceAll('\\','/').replace(/^(?:\$\{CLAUDE_PROJECT_DIR(?::-\.)?\}|\$CLAUDE_PROJECT_DIR)\//,'./');
    return pathKey(target,script)===pathKey(target,'scripts/memory/new-session.mjs');
  };
  settings.hooks ??= {};
  if(typeof settings.hooks!=='object'||Array.isArray(settings.hooks)) throw Error('settings.json hooks must be an object');
  const entries=settings.hooks.UserPromptSubmit??[];
  if(!Array.isArray(entries)) throw Error('hooks.UserPromptSubmit must be an array');
  let kept=false;
  const next=entries.flatMap(entry=>{
    if(!Array.isArray(entry?.hooks)) return [entry];
    const hooks=entry.hooks.filter(h=>{
      if(!enabled ? h?.command!==template.hooks.UserPromptSubmit[0].hooks[0].command : !ours(h?.command)) return true;
      if(!enabled||kept) return false;
      kept=true;return true;
    });
    return hooks.length ? [{...entry,hooks}] : entry.hooks.length ? [] : [entry];
  });
  if(enabled&&!kept) next.push(...structuredClone(template.hooks.UserPromptSubmit));
  if(enabled||settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit=next;
  if(enabled) settings.permissions ??= {};
  if(settings.permissions) {
    if(typeof settings.permissions!=='object'||Array.isArray(settings.permissions)) throw Error('settings.json permissions must be an object');
    const allow=settings.permissions.allow??[];
    if(!Array.isArray(allow)) throw Error('permissions.allow must be an array');
    const seen=new Set();
    const next=allow.filter(value=>!sessionPermissions.includes(value)||(enabled&&!seen.has(value)&&seen.add(value)));
    if(enabled) for(const permission of sessionPermissions) if(!seen.has(permission)) next.push(permission);
    if(enabled||settings.permissions.allow) settings.permissions.allow=next;
  }
  return JSON.stringify(settings)!==before;
}
export function sessionSettings(settings,local,opts,root) {
  if(opts['no-new-session-hook']) local.newSessionHook=false;
  const enabled=local.newSessionHook!==false;
  const present=new Set(Array.isArray(settings.permissions?.allow)?settings.permissions.allow:[]);
  const template=JSON.parse(fs.readFileSync(path.join(root,'templates/settings.newsession.json'),'utf8'));
  const changed=mergeNewSessionHooks(settings,template,enabled,opts.target);
  const preview=opts.check||opts['dry-run'];
  console.log(`new-session hook: ${changed?(enabled?(preview?'would add (UserPromptSubmit)':'added (UserPromptSubmit)'):(preview?'would remove (opt-out)':'removed (opt-out)')):'unchanged'}`);
  for(const permission of sessionPermissions) console.log(`permission ${permission}: ${enabled?(present.has(permission)?'present':preview?'would allow':'allowed'):(present.has(permission)?preview?'would remove':'removed':'absent')}`);
  if(!enabled&&(settings.hooks?.UserPromptSubmit??[]).some(entry=>entry.hooks?.some(h=>typeof h.command==='string'&&h.command.includes('new-session.mjs')))) console.log('hand-wired new-session hook kept; opt-out removes only the exact kit command');
  console.log('Session overlay template: scripts/memory/templates/AGENTS-session-overlay.md');
  return changed;
}
export function skillPlan(target,root,oldManifest,local,opts) {
  const next=installedManifest(root), skills=Object.keys(next.files).filter(file=>/^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(file));
  const replaceSkills=Array.isArray(opts['replace-skill'])?opts['replace-skill']:opts['replace-skill']?[opts['replace-skill']]:[];
  for(const name of replaceSkills) if(!skills.includes(`.claude/skills/${name}/SKILL.md`)) throw Error('Unknown kit skill: '+name);
  const foreign=new Set(local.foreignSkills??[]), kept=[];
  for(const file of skills) {
    const name=file.split('/')[2],dest=path.join(target,file);
    if(replaceSkills.includes(name)) { foreign.delete(name);continue; }
    if(foreign.has(name)&&!exists(dest)) { foreign.delete(name);console.log(`WARN foreign skill gone: ${file}; ${opts.check||opts['dry-run']?'would install':'installing'} kit skill`); }
    if(foreign.has(name)||(!Object.hasOwn(oldManifest?.files??{},file)&&exists(dest)&&hash(dest)!==next.files[file])) {
      foreign.add(name);kept.push(file);delete next.files[file];
      console.log(`WARN foreign skill kept: ${file}; use --replace-skill ${name}`);
    }
  }
  if(foreign.size||local.foreignSkills) local.foreignSkills=[...foreign].sort();
  return {next,kept,replaceSkills};
}
export function gateLinePlan(target,root,opts={}) {
  const file=path.join(target,fs.existsSync(path.join(target,'AGENTS.md'))?'AGENTS.md':'CLAUDE.md');
  const text=exists(file)?fs.readFileSync(file,'utf8'):'';
  const line=fs.readFileSync(path.join(root,'templates/AGENTS-memory-gate.md'),'utf8').split(/\r?\n/).find(line=>line.startsWith('- Session phrases:'));
  const block=/^## Memory gate(?:[ \t][^\r\n]*)?(?:\r?\n|$)[\s\S]*?(?=^#{1,2} |$(?![\s\S]))/m.exec(text);
  if(!block) { console.log('WARN Memory gate heading missing; add: '+line);return null; }
  const old=block[0],eol=old.includes('\r\n')?'\r\n':'\n';
  let updated;
  if(/^- Session phrases:[^\r\n]*/m.test(old)) updated=old.replace(/^- Session phrases:[^\r\n]*/m,line);
  else {
    const bullets=[...old.matchAll(/^- [^\r\n]*(?:\r?\n|$)/gm)],last=bullets.at(-1);
    const at=last?last.index+last[0].length:old.includes('\n')?old.indexOf('\n')+1:old.length;
    updated=old.slice(0,at)+(at&&!old.slice(0,at).endsWith('\n')?eol:'')+line+eol+old.slice(at);
  }
  if(updated===old) {console.log('Session phrases gate line: present');return null;}
  const updating=/^- Session phrases:/m.test(old),preview=opts.check||opts['dry-run'];
  console.log('Session phrases gate line: '+(preview?(updating?'would update':'would add'):(updating?'updated':'added'))+' in '+path.basename(file));
  return [file,text.slice(0,block.index)+updated+text.slice(block.index+old.length)];
}
export function distributionRefusals(target,root,oldManifest) {
  const read=readJSON;
  const ledger=read(path.join(root,'engine/upgrades.json'));
  const aware=ledger.some(row=>row.waveSave?.supportsHandover===true);
  const refused=[];
  for(const file of ['settings.json','settings.local.json']) {
    const settingsFile=path.join(target,'.claude',file),settings=exists(settingsFile)?read(settingsFile):{};
    validateHooks(settings,file);
    for(const [event,entries] of Object.entries(settings.hooks??{})) for(const entry of entries) for(const hook of entry.hooks??[]) {
      if(typeof hook.command==='string'&&hook.command.toLowerCase().includes('wave-save.mjs')&&!aware) refused.push(`wave-save refused: ${event}: ${hook.command}; ${file}; install a wave-save release that supports handover; no override`);
    }
  }
  if(oldManifest) {
    const next=installedManifest(root),retired=new Set(ledger.flatMap(row=>row.retired??[]));
    for(const [file,expected] of Object.entries(oldManifest.files)) {
      const dest=path.resolve(target,file);
      if(!['scripts/memory','.claude/skills'].some(folder=>dest!==path.join(target,folder)&&inside(path.join(target,folder),dest))) throw Error('old manifest path outside kit folders: '+file);
      if(!Object.hasOwn(next.files,file)&&exists(dest)&&hash(dest)===expected&&!retired.has(file)) refused.push('unknown owned file: '+file+'; remove or restore the file, or list it in retired');
    }
  }
  return refused;
}
export function appendText(text, block) {
  const eol=text.includes('\r\n')?'\r\n':'\n';
  return text+(text.endsWith('\n')?eol:eol+eol)+block.replace(/\r?\n/g,eol);
}
export function toolingHints(target) {
  if(fs.readdirSync(target).some(n=>/^eslint\.config\.|^\.eslintrc/.test(n))) console.log('Host eslint: if eslint . collects kit .mjs, exclude scripts/memory/** (flat config global ignores; legacy ignorePatterns).');
  const ts=path.join(target,'tsconfig.json');
  if(exists(ts)&&/"(?:allowJs|checkJs)"\s*:\s*true/.test(fs.readFileSync(ts,'utf8'))) console.log('Host tsconfig: allowJs/checkJs may collect kit .mjs; add scripts/memory/** to exclude when needed.');
}
export function sameFile(a,b) {
  if(a===b) return true;
  try {
    if(fs.realpathSync(a)===fs.realpathSync(b)) return true;
    const x=fs.statSync(a),y=fs.statSync(b);
    return Boolean(x.ino && y.ino && x.ino===y.ino && x.dev===y.dev);
  } catch {return false;}
}
export function hostSnapshot(target, paths=[]) {
  const result=new Map();
  for(const file of new Set(paths.map(file=>path.resolve(target,file)))) {
    const key=path.relative(target,file).split(path.sep).join('/');let fd;
    try {
      fd=fs.openSync(file,'r');const hash=createHash('sha256'),buffer=Buffer.alloc(64*1024);let size=0,n;
      while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0) {hash.update(buffer.subarray(0,n));size+=n;}
      result.set(key,{size,hash:hash.digest('hex')});
    } catch(error) {
      result.set(key,error.code==='ENOENT'?{missing:true}:{error:error.code||error.message});
    } finally {
      if(fd!==undefined) try {fs.closeSync(fd);}catch(error){result.set(key,{error:error.code||error.message});}
    }
  }
  return result;
}
export function installReport(target,before) {
  console.log('Install host file report (path | action | bytes before -> after):');
  for(const [file,data] of hostSnapshot(target,[...before.keys()])) {
    const old=before.get(file);
    if(old?.error||data.error) console.log(`${file} | read error | before: ${old?.error??'ok'}; after: ${data.error??'ok'}`);
    else if(old?.hash!==data.hash) console.log(`${file} | ${data.missing?'removed':old?.missing?'created':'modified'} | ${old?.size??0} -> ${data.size??0}`);
  }
  console.log('Self-test: node --test scripts/memory/memory.selftest.mjs');
  console.log('Optional npm script: "memory:test": "node --test scripts/memory/memory.selftest.mjs"');
}
