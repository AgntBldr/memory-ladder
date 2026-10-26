import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {isDirect} from '../engine/lib.mjs';
import {kitRoot, installedManifest, ownedFiles, installedPath, hash} from './manifest.mjs';
import {options, usage, readJSON, write, writeJSON, resolveMemory, backupDirectory, withIgnores} from './install.mjs';
import {withMemoryLock} from '../engine/memory-lock.mjs';
import {migrateRoutes} from '../engine/memory-migrate.mjs';
import {memoryFiles} from '../engine/lib.mjs';
import {isGenerated, generateMemoryIndex, writeMemoryIndex} from '../engine/memory-index.mjs';

export function mergeDefaults(current, defaults) {
  const result=structuredClone(current);
  for(const [key,value] of Object.entries(defaults)) {
    if(!Object.hasOwn(result,key)) result[key]=structuredClone(value);
    else if(value && typeof value==='object' && !Array.isArray(value) && result[key] && typeof result[key]==='object' && !Array.isArray(result[key])) result[key]=mergeDefaults(result[key],value);
  }
  return result;
}
function versionParts(value) {
  const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if(!match) throw new Error('Invalid version: '+value);
  const pre=match[4]?.split('.')||[];
  if(pre.some(p=>/^0\d+$/.test(p))) throw new Error('Invalid version: '+value);
  return {core:match.slice(1,4).map(BigInt),pre};
}
export function newer(a,b) {
  const x=versionParts(a),y=versionParts(b);
  for(let i=0;i<3;i++) if(x.core[i]!==y.core[i]) return x.core[i]>y.core[i];
  if(!x.pre.length||!y.pre.length) return !x.pre.length&&Boolean(y.pre.length);
  for(let i=0;i<Math.max(x.pre.length,y.pre.length);i++) {
    if(x.pre[i]===y.pre[i]) continue;
    if(x.pre[i]===undefined||y.pre[i]===undefined) return y.pre[i]===undefined;
    const xn=/^\d+$/.test(x.pre[i]),yn=/^\d+$/.test(y.pre[i]);
    return xn&&yn ? BigInt(x.pre[i])>BigInt(y.pre[i]) : xn!==yn ? yn : x.pre[i]>y.pre[i];
  }
  return false;
}
function inside(root,file) {
  const absolute=path.resolve(root,file),rel=path.relative(root,absolute);
  if(!rel || rel==='..' || rel.startsWith('..'+path.sep) || path.isAbsolute(rel)) throw new Error('backup path escapes root: '+file);
  return absolute;
}
export function restore(target,backup,lock) {
  const recovery=readJSON(path.join(backup,'restore.json')),entries=recovery.files;
  if(recovery.memory && !lock) return withMemoryLock(recovery.memory.dir, held => restore(target,backup,held));
  if(!Array.isArray(entries)) throw new Error('invalid restore.json files');
  // Validate the complete recovery map and read its bytes before restoring anything.
  const originals=entries.map(e=>({dest:inside(target,e.file),data:e.existed?fs.readFileSync(inside(backup,e.file)):null}));
  for(const {dest,data} of originals) {
    if(data===null) { if(fs.existsSync(dest)) fs.unlinkSync(dest); }
    else write(dest,data);
  }
  if(recovery.memory) {
    const saved=recovery.memory;
    const values=saved.files.map(file=>({file,data:fs.readFileSync(inside(path.join(backup,'memory'),file))}));
    for(const file of saved.created ?? []) if(file!=='.memory.lock' && fs.existsSync(inside(saved.dir,file))) fs.unlinkSync(inside(saved.dir,file));
    for(const {file,data} of values) write(inside(saved.dir,file),data);
  }
}
function gateFailures(target,memory) {
  const r=spawnSync(process.execPath,[path.join(target,'scripts/memory/memory-check.mjs'),'--repo',target,'--memory-dir',memory,'--json'],{encoding:'utf8',timeout:120000});
  if(r.error || ![0,1].includes(r.status)) throw new Error('gate could not run: '+(r.error?.message||r.stderr));
  let result;
  try { result=JSON.parse(r.stdout); if(!Array.isArray(result.findings)) throw new Error(); }
  catch { throw new Error('gate did not return findings: '+(r.stdout+r.stderr).trim()); }
  const fails=result.findings.filter(f=>f.severity==='FAIL'&&!f.allowed);
  if(r.status===1&&!fails.length) throw new Error('gate exited 1 without FAIL findings');
  return fails;
}
const failKey=f=>JSON.stringify([f.check,f.file,f.line??null,f.message,f.value??null]);
function ensureLockIgnore(memory) {
  const file=path.join(memory,'.gitignore'),text=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
  if(!text.split(/\r?\n/).includes('.memory.lock*')) fs.appendFileSync(file,(text&&!text.endsWith('\n')?'\n':'')+'.memory.lock*\n');
}
export function upgrade(opts, root=kitRoot, hooks={}) {
  if(opts.restore) return upgradeUnlocked(opts,root,hooks);
  const memory=resolveMemory(path.resolve(opts.target),opts['memory-dir']).dir;
  return withMemoryLock(memory,lock=>upgradeUnlocked(opts,root,{...hooks,lock}));
}
function upgradeUnlocked(opts, root=kitRoot, {afterCopy=()=>{},afterMigrate=()=>{},lock}={}) {
  const target=path.resolve(opts.target),engine=path.join(target,'scripts/memory');
  if(opts.restore) {
    const backup=path.resolve(opts.restore);
    try { restore(target,backup);console.log('upgrade: restored '+backup);return 0; }
    catch(e) { throw new Error(`restore failed: ${e.message}; backup: ${backup}`); }
  }
  const receipt=readJSON(path.join(engine,'KIT.json')),oldManifest=readJSON(path.join(engine,'MANIFEST.json'));
  // Installed manifests already contain installedPath-mapped destinations.
  // Validate every old key before executing project code or creating a backup.
  for(const file of Object.keys(oldManifest.files)) {
    const dest=path.resolve(target,file);
    const allowed=[engine,path.join(target,'.claude/skills')].some(folder=>{
      const rel=path.relative(folder,dest);
      return rel!==''&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);
    });
    if(!allowed) throw new Error('old manifest path outside kit folders: '+file);
  }
  const nextManifest=installedManifest(root),version=nextManifest.version;
  const engineChanged=Object.entries(nextManifest.files).some(([file,expected])=>file.startsWith('scripts/memory/')&&(!fs.existsSync(inside(target,file))||hash(inside(target,file))!==expected));
  const edited=Object.keys(oldManifest.files).filter(f=>!fs.existsSync(inside(target,f))||hash(inside(target,f))!==oldManifest.files[f]);
  if(opts.check) {
    for(const f of edited) console.log('edited locally: '+f);
    console.log('kit '+receipt.version+' -> '+version);
    return newer(version,receipt.version)||edited.length||engineChanged ? 1 : 0;
  }
  if(newer(receipt.version,version)) throw new Error('Refusing a downgrade');
  if(version===receipt.version&&!engineChanged&&!opts['force-skills']) {
    ensureLockIgnore(resolveMemory(target,opts['memory-dir']).dir);
    console.log('upgrade: same version and hashes; no-op');return 0;
  }
  const memory=resolveMemory(target,opts['memory-dir']).dir;
  const before=gateFailures(target,memory),prior=new Set(before.map(failKey));
  for(const f of before) console.log(`pre-existing FAIL ${f.check} ${f.file}: ${f.message}`);
  const same=version===receipt.version&&!engineChanged;
  const migration=!newer('3.2.0',version)&&memoryFiles(memory).some(f=>f.special==='index'&&!f.stub&&!isGenerated(f.text));
  const replace=ownedFiles(root).filter(f=>!same||f.startsWith('skills/')).filter(f=>{
    const installed=installedPath(f);
    if(f.startsWith('skills/')&&edited.includes(installed)&&!opts['force-skills']) { console.log('WARN edited skill skipped: '+installed);return false; }
    return true;
  });
  const updates=new Map(replace.map(f=>[installedPath(f),fs.readFileSync(path.join(root,f))]));
  if(!same) {
    for(const f of Object.keys(oldManifest.files)) if(!Object.hasOwn(nextManifest.files,f)) updates.set(f,null);
    const defaults=readJSON(path.join(root,'engine/memory.config.json'));
    const config=mergeDefaults(readJSON(path.join(engine,'memory.config.json')),defaults);
    config.engine_version=defaults.engine_version;
    updates.set('scripts/memory/memory.config.json',JSON.stringify(config,null,2)+'\n');
  }
  for(const f of Object.keys(nextManifest.files)) if(f.startsWith('.claude/skills/')&&!updates.has(f)) nextManifest.files[f]=oldManifest.files[f]??nextManifest.files[f];
  updates.set('scripts/memory/KIT.json',JSON.stringify({...receipt,version},null,2)+'\n');
  updates.set('scripts/memory/MANIFEST.json',JSON.stringify(nextManifest,null,2)+'\n');
  const ignoreFile=path.join(engine,'.gitignore'),ignore=fs.existsSync(ignoreFile)?fs.readFileSync(ignoreFile,'utf8'):'';
  if(withIgnores(ignore)!==ignore) updates.set('scripts/memory/.gitignore',withIgnores(ignore));
  const originals=[...updates.keys()].map(file=>({file,data:fs.existsSync(inside(target,file))?fs.readFileSync(inside(target,file)):null}));
  const backup=backupDirectory(engine);
  for(const {file,data} of originals) if(data!==null) write(inside(backup,file),data);
  let memoryBackup;
  {
    const files=fs.readdirSync(memory,{withFileTypes:true}).filter(e=>e.isFile()&&e.name!=='.memory.lock').map(e=>e.name);
    for(const file of files) write(path.join(backup,'memory',file),fs.readFileSync(path.join(memory,file)));
    memoryBackup={dir:memory,files,created:files.includes('.gitignore')?[]:['.gitignore']};
  }
  const recovery={files:originals.map(({file,data})=>({file,existed:data!==null})),failuresBefore:before,memory:memoryBackup};
  const saveRecovery=()=>{
    const pending=path.join(backup,'restore.json.tmp');
    fs.writeFileSync(pending,JSON.stringify(recovery,null,2)+'\n',{flush:true});
    fs.renameSync(pending,path.join(backup,'restore.json'));
  };
  saveRecovery();
  console.log('upgrade backup: '+backup);
  try {
    let count=0;
    for(const [f,data] of updates) {
      const dest=inside(target,f);
      if(data===null) { if(fs.existsSync(dest)) fs.unlinkSync(dest); }
      else write(dest,data);
      afterCopy(++count,f);
    }
    if(migration) {
      migrateRoutes({memoryDir:memory,repo:target,config:readJSON(path.join(engine,'memory.config.json')),probesFile:path.join(engine,'recall-probes.json'),write:true,lock,
        beforeWrite: ({created}) => { memoryBackup.created=[...new Set([...memoryBackup.created,...created])]; saveRecovery(); }});
      afterMigrate();
    }
    if (memoryFiles(memory).some(f => f.special === 'index' && isGenerated(f.text))) {
      const options = {memoryDir: memory, config: readJSON(path.join(engine, 'memory.config.json')), lock};
      const planned = generateMemoryIndex(options);
      if (!Object.keys(planned.pages).length) {
        const reason = fs.existsSync(path.join(memory, 'MEMORY.md')) ? 'index-less router' : 'missing router';
        console.log(`WARN ${reason}: generated pages left unchanged for the gate`);
      } else {
        memoryBackup.created = [...new Set([...memoryBackup.created, ...Object.keys(planned.pages).filter(file => !memoryBackup.files.includes(file))])];
        saveRecovery();
        const result = writeMemoryIndex(options);
        console.log(`regenerated ${Object.keys(result.pages).length} generated pages; removed ${result.removed.length}: ${result.removed.slice(0, 20).join(', ')}`);
      }
    }
    ensureLockIgnore(memory);
    memoryBackup.created=fs.readdirSync(memory,{withFileTypes:true}).filter(e=>e.isFile()&&e.name!=='.memory.lock'&&!memoryBackup.files.includes(e.name)).map(e=>e.name);
    saveRecovery();
    const after=gateFailures(target,memory),added=after.filter(f=>!prior.has(failKey(f)));
    if(added.length) throw new Error('new FAIL: '+added.map(f=>f.check+' '+f.file+': '+f.message).join('; '));
    console.log(`upgrade: complete (${after.length} pre-existing FAIL remain)`);return 0;
  } catch(e) {
    try { restore(target,backup,lock);console.error(`upgrade: restored ${backup}: ${e.message}`); }
    catch(recovery) { console.error(`upgrade: rollback failed: ${recovery.message}; backup: ${backup}; run scripts/upgrade.mjs --target "${target}" --restore "${backup}"; original: ${e.message}`); }
    return 1;
  }
}
if(isDirect(import.meta.url)) {
  try {
    const opts=options(process.argv.slice(2));
    if(opts.help) console.log(usage('upgrade'));
    else process.exitCode=upgrade(opts);
  }
  catch(e) { console.error('upgrade: '+String(e.message).replace(/[\r\n]+/g,' '));process.exitCode=1; }
}
