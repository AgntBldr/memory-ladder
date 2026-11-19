import {normalizeEol, pathKey, refuseSpecial} from '../engine/lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {installedManifest, hash} from './manifest.mjs';
import {readJSON} from '../engine/memory-setup.mjs';
import {planText,proveText,shippedIndex,unitLine,unitNote,inRepoVariant,bodyLines,parseLedger,reportEntry} from './instructions-block.mjs';
const exists = file => fs.existsSync(file) && fs.statSync(file).isFile();
// Kit 3.3.6 item 6: the kind check the update and the install make before they plan or read a named file:
// true for a regular file, false when absent (or a folder). A stat error other than ENOENT or ENOTDIR, and a fifo, socket
// or device, refuse with refuseSpecial's wording (`cannot resolve <file> (<code>); nothing written`) before anything is
// read. checkMemoryRouter and toolingHints keep exists(): the first reads none of its candidates, the second runs after
// the install's writes and must never fail it.
const isRegular = file => { refuseSpecial(file); return exists(file); };
const inside = (root, file) => { const r=path.relative(root,file);return r!== '..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r); };
export function instructions(target) {
  const found=new Map();
  function visit(file) {
    if(!isRegular(file)) return;
    file=fs.realpathSync(file);
    if(found.has(file)) return;
    const text=fs.readFileSync(file,'utf8');found.set(file,text);
    for(const m of text.matchAll(/(?:^|\s)@([^\s`<>"()]+)/gm)) {
      const relative=path.resolve(path.dirname(file),m[1]),rooted=path.resolve(target,m[1]);
      visit(isRegular(relative)?relative:rooted);
    }
    for(const m of text.matchAll(/(?:@|\]\(|`)([^\s`<>"()]+\.md)\b/g)) {
      const relative=path.resolve(path.dirname(file),m[1]),rooted=path.resolve(target,m[1]);
      visit(isRegular(relative)?relative:rooted);
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
      if(!sessionSkills.includes(name)&&!isRegular(file)) continue;
      if(mirror===file||!inside(target,mirror)||(!isRegular(mirror)&&!codex)) continue;
      if(isRegular(mirror)&&normalizeEol(fs.readFileSync(mirror,'utf8'))!==normalizeEol(data)&&(!isRegular(file)||normalizeEol(fs.readFileSync(mirror,'utf8'))!==normalizeEol(fs.readFileSync(file,'utf8')))) {
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
    if(foreign.has(name)&&!isRegular(dest)) { foreign.delete(name);console.log(`WARN foreign skill gone: ${file}; ${opts.check||opts['dry-run']?'would install':'installing'} kit skill`); }
    if(foreign.has(name)||(!Object.hasOwn(oldManifest?.files??{},file)&&isRegular(dest)&&hash(dest)!==next.files[file])) {
      foreign.add(name);kept.push(file);delete next.files[file];
      console.log(`WARN foreign skill kept: ${file}; use --replace-skill ${name}`);
    }
  }
  if(foreign.size||local.foreignSkills) local.foreignSkills=[...foreign].sort();
  return {next,kept,replaceSkills};
}
// Decisions for unclear lines: {"version":1,"project":"<name>","decisions":{"<unit id>":{"outcome","scope","reason","decidedBy"}}}.
// An empty outcome means "not decided yet"; the unit stays unclear.
export function readDecisions(file) {
  let json;
  // Kit 3.3.6 item 6: a file the operator names is kind-checked first; the refusal passes the catch below unchanged.
  refuseSpecial(file);
  try { json=JSON.parse(fs.readFileSync(file,'utf8')); } catch { throw Error(`${file} is not a decisions file`); }
  if(!json||typeof json!=='object'||json.version!==1||!json.decisions||typeof json.decisions!=='object'||Array.isArray(json.decisions)) throw Error(`${file} is not a decisions file`);
  const map=new Map();
  for(const [id,decision] of Object.entries(json.decisions)) {
    if(!decision||typeof decision!=='object'||Array.isArray(decision)) throw Error(`decision ${id} is not an object`);
    if(decision.outcome===undefined||decision.outcome==='') { map.set(id,null);continue; }
    if(!['keep','drop'].includes(decision.outcome)) throw Error(`decision ${id} has an unknown outcome ${decision.outcome}`);
    if(typeof decision.reason!=='string'||!decision.reason.trim()) throw Error(`decision ${id} has no reason`);
    const scope=decision.scope??'project';
    if(!['project','general'].includes(scope)) throw Error(`decision ${id} has an unknown scope ${scope}`);
    map.set(id,{outcome:decision.outcome,scope,reason:decision.reason,decidedBy:typeof decision.decidedBy==='string'?decision.decidedBy:''});
  }
  return {project:typeof json.project==='string'&&json.project?json.project:null,map};
}
// The sorting ledger is read from the kit the update runs from: --instructions-ledger, else every ledger/*.json.
export function loadLedger(root,file) {
  const dir=path.join(root,'ledger');
  const files=file?[path.resolve(file)]:fs.existsSync(dir)?fs.readdirSync(dir).filter(name=>name.endsWith('.json')).sort().map(name=>path.join(dir,name)):[];
  const entries=[];
  for(const ledger of files) {
    // Kit 3.3.6 item 6: kind-checked before the read; the refusal passes the catch below unchanged.
    refuseSpecial(ledger);
    try { entries.push(...parseLedger(JSON.parse(fs.readFileSync(ledger,'utf8')))); }
    catch { throw Error(`${ledger} is not a sorting ledger`); }
  }
  return entries;
}
// Plans the kit standard block in the instruction file (AGENTS.md, else CLAUDE.md) and the import block in CLAUDE.md.
// Nothing is written here. A refusal is returned, never thrown, so previews can print it.
export function standardBlockPlan(target,root,opts={},hooks={}) {
  const log=opts.quiet?()=>{}:console.log;
  const result={writes:[],refusal:null,refusalKind:null,plans:[],report:null,summary:null,file:null,project:null};
  const refuse=(kind,message)=>Object.assign(result,{refusal:message,refusalKind:kind});
  const agentsFile=path.join(target,'AGENTS.md'),claudeFile=path.join(target,'CLAUDE.md');
  const file=isRegular(agentsFile)?agentsFile:isRegular(claudeFile)?claudeFile:opts.install?agentsFile:null;
  if(!file) { log('WARN no AGENTS.md or CLAUDE.md; the kit standard block was not added');return result; }
  result.file=file;
  let decisions=null,ledger;
  try {
    if(opts['instructions-decisions']) decisions=readDecisions(path.resolve(opts['instructions-decisions']));
    ledger=loadLedger(root,opts['instructions-ledger']);
  } catch(error) { return refuse('input',error.message); }
  const version=fs.readFileSync(path.join(root,'VERSION'),'utf8').trim();
  const template=fs.readFileSync(path.join(root,'templates/AGENTS-memory-gate.md'),'utf8');
  const catalogFile=path.join(root,'templates/shipped-instruction-lines.json');
  const catalog=fs.existsSync(catalogFile)?JSON.parse(fs.readFileSync(catalogFile,'utf8')):null;
  const shipped=shippedIndex(catalog,[template,inRepoVariant(template)]);
  // What the kit named in a block's begin marker wrote there: this kit's template, else the catalog's lines for that tag.
  const bodies=markerVersion=>markerVersion===version?[template,inRepoVariant(template)].map(bodyLines)
    :Array.isArray(catalog?.bodies?.['v'+markerVersion])?catalog.bodies['v'+markerVersion]:null;
  const importBody=fs.readFileSync(path.join(root,'templates/CLAUDE-standard-block.md'),'utf8');
  const targets=[{file,kind:'full',body:opts.inRepo?inRepoVariant(template):template}];
  if(file===agentsFile&&(isRegular(claudeFile)||opts.install)&&!(isRegular(claudeFile)&&sameFile(agentsFile,claudeFile))) targets.push({file:claudeFile,kind:'import',body:importBody});
  for(const entry of targets) {
    const present=isRegular(entry.file),raw=present?fs.readFileSync(entry.file):Buffer.alloc(0),text=raw.toString('utf8');
    const name=path.relative(target,entry.file).split(path.sep).join('/');
    // The plan and its proof work on text; that equals working on bytes only when the bytes decode losslessly.
    const encoded=Buffer.from(text,'utf8');
    if(!encoded.equals(raw)) {
      let at=0;while(at<raw.length&&raw[at]===encoded[at]) at++;
      return refuse('encoding',`${name} is not UTF-8 text (first invalid byte at offset ${at}); save it as UTF-8, then run again; nothing written`);
    }
    const plan=planText({text,exists:present,version,body:entry.body,kind:entry.kind,shipped,decisions:decisions?.map,ledger,bodies:entry.kind==='full'?bodies:null,hooks:entry.kind==='full'?hooks:{}});
    if(plan.damage) return refuse('damaged',`${name} standard block markers are damaged (${plan.damage}); fix them by hand or restore the file, then run again`);
    result.plans.push({...entry,name,text,present,plan});
  }
  for(const {name,plan} of result.plans) {
    log(`INSTRUCTIONS ${name}: standard block ${plan.action??'add'}; first update: ${plan.firstUpdate?'yes':'no'}`);
    for(const unit of plan.units) {
      log(unitLine(unit));
      // Display only: the line is still kept or dropped whole, as decided.
      const note=unit.outcome==='unclear'?unitNote(unit,shipped):null;
      if(note) log(note);
    }
    if(plan.editLines) log(`WARN ${name} standard block differs from kit ${plan.comparedTo??version} text (${plan.editLines} lines); the update replaces it; move lines you need to "## Project rules" first`);
    for(const line of plan.repeats) log(`WARN ${name}:${line} repeats kit wording outside the standard block`);
  }
  const main=result.plans[0];
  if(decisions) for(const [id,decision] of decisions.map) {
    const unit=main.plan.units.find(unit=>unit.id===id);
    if(!unit) return refuse('decisions',`decisions file names unknown unit ${id}`);
    if(decision&&unit.outcome==='replace') log(`WARN decision ${id} ignored: kit wording is always replaced`);
  }
  const unclear=main.plan.unclear??[];
  if(unclear.length) return refuse('unclear',`${main.name} has ${unclear.length} unclear lines in its old memory section; write decisions with: node "${path.join(root,'scripts/instructions-sort.mjs')}" preview --target "${target}" --out <folder>, fill <folder>/decisions.json, then run again with --instructions-decisions <folder>/decisions.json`);
  for(const {file:dest,text,body,plan} of result.plans) {
    if(plan.action==='unchanged') continue;
    const failure=plan.proofFailure??proveText({text,plan,body,version});
    if(failure) return refuse('proof',`instructions proof failed: ${failure}; nothing written`);
    result.writes.push([dest,plan.newText]);
  }
  const project=decisions?.project||path.basename(target),date=new Date().toISOString().slice(0,10);
  const edited=unit=>({...unit,outcome:'replace',scope:'project',reason:'edit inside the standard block, replaced',decidedBy:'kit',source:'edit-inside-block',matched:[]});
  const entries=result.plans.flatMap(({name,plan})=>[...plan.units,...plan.edits.map(edited)].map(unit=>reportEntry(unit,{project,file:name,date})));
  result.project=project;
  result.summary={replaced:entries.filter(e=>e.outcome==='replace').length,kept:entries.filter(e=>e.outcome==='keep').length,dropped:entries.filter(e=>e.outcome==='drop').length};
  // An upgrade that makes a first update always leaves a report, even with no units; install only when it sorted units.
  const firstWritten=result.plans.some(({plan})=>plan.firstUpdate&&plan.action!=='unchanged');
  if(result.writes.length&&(entries.length||(firstWritten&&!opts.install))) result.report={version:1,kit:version,project,date,entries};
  return result;
}
// The lines a real run prints after it wrote a sorting report.
export function instructionsReportLines(root,result,reportPath,opts={}) {
  const {replaced,kept,dropped}=result.summary,version=fs.readFileSync(path.join(root,'VERSION'),'utf8').trim();
  return [
    `instructions: ${replaced} replaced, ${kept} kept in Project rules, ${dropped} dropped; report: ${reportPath}`,
    `instructions: to keep these decisions for later projects, add the report to your kit's sorting ledger, from a kit branch: node "${path.join(root,'scripts/instructions-sort.mjs')}" ledger-add --from "${reportPath}" --project ${result.project} --ledger ${opts['instructions-ledger']?'"'+path.resolve(opts['instructions-ledger'])+'"':'<ledger file>'}`,
    `lesson: close this update with a "what we learned" lesson: node scripts/memory/memory-lesson.mjs new --route <family> --kind observation "What we learned: kit ${version} instructions update"`,
  ];
}

export function distributionRefusals(target,root,oldManifest) {
  const read=readJSON;
  const ledger=read(path.join(root,'engine/upgrades.json'));
  const aware=ledger.some(row=>row.waveSave?.supportsHandover===true);
  const refused=[];
  for(const file of ['settings.json','settings.local.json']) {
    const settingsFile=path.join(target,'.claude',file),settings=isRegular(settingsFile)?read(settingsFile):{};
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
      if(!Object.hasOwn(next.files,file)&&isRegular(dest)&&hash(dest)===expected&&!retired.has(file)) refused.push('unknown owned file: '+file+'; remove or restore the file, or list it in retired');
    }
  }
  return refused;
}
export function appendText(text, block) {
  const eol=text.includes('\r\n')?'\r\n':'\n';
  return text+(text.endsWith('\n')?eol:eol+eol)+block.replace(/\r?\n/g,eol);
}
const readText=file=>{try {return fs.readFileSync(file,'utf8');} catch {return '';}};
// Hints only: nothing here writes a file or fails an install.
export function toolingHints(target) {
  let names=[];
  try {names=fs.readdirSync(target);} catch {}
  const at=name=>path.join(target,name);
  let pkg=null;
  try {pkg=JSON.parse(readText(at('package.json')));} catch {}
  const pkgKey=key=>Boolean(pkg)&&typeof pkg==='object'&&Object.hasOwn(pkg,key);
  const eslintFiles=names.filter(n=>/^eslint\.config\.(?:js|mjs|cjs|ts|mts|cts)$/.test(n)||/^\.eslintrc(?:\.(?:js|cjs|json|yaml|yml))?$/.test(n));
  if(eslintFiles.length||pkgKey('eslintConfig')) {
    const texts=[...eslintFiles,'.eslintignore'].map(n=>readText(at(n)));
    if(pkgKey('eslintConfig')) texts.push(JSON.stringify(pkg.eslintConfig));
    if(!texts.some(text=>text.includes('scripts/memory'))) console.log('Host eslint: if eslint . collects kit .mjs, exclude scripts/memory/** (flat config global ignores; legacy ignorePatterns).');
  }
  const ts=at('tsconfig.json');
  if(exists(ts)&&/"(?:allowJs|checkJs)"\s*:\s*true/.test(fs.readFileSync(ts,'utf8'))) console.log('Host tsconfig: allowJs/checkJs may collect kit .mjs; add scripts/memory/** to exclude when needed.');
  // Biome reads biome.json before biome.jsonc (docs list the files in that order).
  const biome=['biome.json','biome.jsonc'].find(n=>names.includes(n));
  if(biome&&!readText(at(biome)).includes('scripts/memory')) console.log(`Host Biome: ${biome} covers scripts/memory; exclude it ("!scripts/memory" in files.includes for Biome 2, "scripts/memory/**" in files.ignore for Biome 1). Never reformat kit files: they are hashed.`);
  const prettier=names.some(n=>/^\.prettierrc(?:\.(?:json|json5|yaml|yml|toml|js|cjs|mjs))?$/.test(n)||/^prettier\.config\.(?:js|cjs|mjs)$/.test(n))||pkgKey('prettier');
  if(prettier&&!readText(at('.prettierignore')).includes('scripts/memory')) console.log('Host Prettier: Prettier covers scripts/memory; add scripts/memory/ to .prettierignore. Never reformat kit files: they are hashed.');
}
// Kit 3.3.6: the one clean git environment, imported beside its only user in this file.
import {cleanGitEnv} from '../engine/lib.mjs';
// On Windows, Git warns "LF will be replaced by CRLF" for kit files unless core.safecrlf is set (any value). Returns the note or null.
export function lineEndingNote(target,platform=process.platform,gitCommand='git') {
  if(platform!=='win32') return null;
  const r=spawnSync(gitCommand,['-C',target,'config','--get','core.safecrlf'],{encoding:'utf8',timeout:10000,windowsHide:true,env:cleanGitEnv()});
  if(r.error||r.status!==1) return null;
  return 'NOTE line endings: on Windows Git warns "LF will be replaced by CRLF" for kit files; to silence it for every project run: git config --global core.safecrlf false';
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
