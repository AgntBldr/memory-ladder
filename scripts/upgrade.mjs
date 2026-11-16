import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import util from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {isDirect,normalizeEol,matchEol,inRepoMemory,pathKey,canonicalPathFresh,slash,read,isIndexPage,refuseSpecial,removeQuietly,scratchFolder} from '../engine/lib.mjs';
import {marker as hookMarker,hookText,linkedWorktree,cleanGitEnv} from '../engine/install-hooks.mjs';
import {kitRoot, installedManifest, ownedFiles, installedPath, hash} from './manifest.mjs';
import {options, usage, readJSON, write, writeJSON, resolveMemory, backupDirectory, withIgnores, mergeGuardHooks} from './install.mjs';
import {withMemoryLock,isLockName,isLockPath,withLockIgnores,PUSH_LOCK} from '../engine/memory-lock.mjs';
import {migrateRoutes} from '../engine/memory-migrate.mjs';
import {memoryFiles} from '../engine/lib.mjs';
import {isGenerated, generateMemoryIndex, writeMemoryIndex, outputRefusal, stagedOutputs} from '../engine/memory-index.mjs';
import {refuseWhilePending} from '../engine/memory-session.mjs';
import {instructions,mirrorWrites} from './install-safety.mjs';
import {sessionSettings,skillPlan,standardBlockPlan,instructionsReportLines,distributionRefusals} from './install-safety.mjs';

// FAIL-capable gate check ids that older installs may not pass yet. The upgrade preflights them with the incoming
// engine and reports a failing one as pre-existing instead of rolling back. config.path stays for upgrades from
// before 3.2.12. 3.3.6 added no new check id (the ones it added only warn) but widened hardrule.size: a card reached
// through a [[wikilink]] under the router's "## Hard rules" now counts as a hard rule (FAIL over 4096 bytes, WARN over 2048).
// An update from 3.3.5 or older with such a card over 4096 bytes fails the new gate and restores itself. hardrule.size is
// deliberately not listed here: listing it would let that update finish with a failing gate. See "Checks a release widens"
// in docs/UPGRADE.md. 3.3.7 adds none and widens none. 3.3.8 adds none and widens none of the gate's checks.
export const NEW_CHECKS = ['config.path'];
const newFailKey=f=>JSON.stringify([f.check,f.file]);
// The gate's "git status" refreshes a repository's index when it may; during an update that would be a write
// nobody planned (into the memory repository's .git), so the update runs the gate without optional locks.
const gateEnv=()=>({...cleanGitEnv(),GIT_OPTIONAL_LOCKS:'0'});
// Kit 3.3.6 item 18: every scratch folder of the update is made outside the project and the memory folder. Each one is
// made before the backup and every planned write, so its location refusal stops the run with nothing written; it is the
// run's own refusal, never read as a memory-planning error. A file-system error making the folder (it carries a code)
// keeps the path it took before (A-T35: an unusable TEMP is a memory-planning failure in a rehearsal).
class ScratchRefusal extends Error {}
function scratch(prefix,outside) {
  try { return scratchFolder(prefix,outside); }
  catch(error) {
    if(error.code) throw error;
    throw new ScratchRefusal(/nothing written$/.test(error.message)?error.message:error.message+'; nothing written');
  }
}
export function newCheckFailures(root,target,memory,config) {
  const dir=scratch('kit-new-checks-',[target,memory]);
  try {
    const file=path.join(dir,'config.json'); fs.writeFileSync(file,JSON.stringify(config));
    const r=spawnSync(process.execPath,[path.join(root,'engine/memory-check.mjs'),'--repo',target,'--memory-dir',memory,'--config',file,'--json'],{encoding:'utf8',timeout:120000,env:gateEnv()});
    if(r.error || ![0,1].includes(r.status)) return [];
    const result=JSON.parse(r.stdout);
    if(!Array.isArray(result.findings)) return [];
    return result.findings.filter(f=>f.severity==='FAIL'&&!f.allowed&&NEW_CHECKS.includes(f.check));
  } catch { return []; }
  // Kit 3.3.6 item 9: a folder that cannot be removed is named on stderr; it never replaces the list.
  finally { removeQuietly(dir); }
}
export function upgradeHints(root,target,memory) {
  try {
    const r=spawnSync(process.execPath,[path.join(root,'engine/memory-lesson.mjs'),'repeat','--from-legacy','--json','--memory-dir',memory,'--repo',target],{encoding:'utf8',timeout:20000,env:gateEnv()});
    if(!r.error && r.status===0) {
      const result=JSON.parse(r.stdout);
      if(result.files>0 && result.entries>0) console.log(`WARN ${result.files} files carry legacy repeat paragraphs; run node "${path.join(target,'scripts/memory/memory-lesson.mjs')}" repeat --from-legacy --memory-dir "${memory}" (dry run), then add --write`);
    }
  } catch {}
  for(const file of ['AGENTS.md','CLAUDE.md']) {
    if(!fs.existsSync(path.join(target,file))) continue;
    let text;
    try { text=fs.readFileSync(path.join(target,file),'utf8'); }
    catch(e) { console.log(`WARN ${file} unreadable: ${e.message}`); continue; }
    text.split(/\r?\n/).forEach((line,i)=>{
      if(/memory-lesson\.mjs new --route/.test(line) && !/--kind\b/.test(line)) console.log(`WARN ${file}:${i+1} still says "memory-lesson.mjs new --route <family>"; add --kind <mistake|practice|observation>`);
    });
  }
}

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
// The optional hook entry of restore.json (3.3.4 and later): canonical path, existence, bytes and mode.
function hookEntry(entry) {
  if(!entry||typeof entry.path!=='string'||!path.isAbsolute(entry.path)||typeof entry.existed!=='boolean'||(entry.existed&&typeof entry.bytes!=='string')) throw new Error('invalid restore.json hook');
  return {path:entry.path,existed:entry.existed,data:entry.existed?Buffer.from(entry.bytes,'base64'):null,mode:Number.isInteger(entry.mode)?entry.mode:null};
}
function restoreHook(hook) {
  if(!hook.existed) { if(fs.existsSync(hook.path)) fs.unlinkSync(hook.path); return; }
  fs.mkdirSync(path.dirname(hook.path),{recursive:true});
  fs.writeFileSync(hook.path,hook.data);
  if(process.platform!=='win32'&&hook.mode!==null) fs.chmodSync(hook.path,hook.mode&0o7777);
}
function gateFailures(target,memory) {
  const r=spawnSync(process.execPath,[path.join(target,'scripts/memory/memory-check.mjs'),'--repo',target,'--memory-dir',memory,'--json'],{encoding:'utf8',timeout:120000,env:gateEnv()});
  if(r.error || ![0,1].includes(r.status)) throw new Error('gate could not run: '+(r.error?.message||r.stderr));
  let result;
  try { result=JSON.parse(r.stdout); if(!Array.isArray(result.findings)) throw new Error(); }
  catch { throw new Error('gate did not return findings: '+(r.stdout+r.stderr).trim()); }
  const fails=result.findings.filter(f=>f.severity==='FAIL'&&!f.allowed);
  if(r.status===1&&!fails.length) throw new Error('gate exited 1 without FAIL findings');
  return fails;
}
const failKey=f=>JSON.stringify([f.check,f.file,f.line??null,f.message,f.value??null]);
// The lock pattern (E2.8 (c): one .memory.lock* line covers both locks), from the one list memory-setup uses too.
function ensureLockIgnore(memory) {
  const file=path.join(memory,'.gitignore'),text=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
  if(withLockIgnores(text)!==text) write(file,withLockIgnores(text));
}
// Kept for callers of 3.3.3: refreshes an existing kit hook and only warns on failure.
// The update itself plans the hook (planHook) and refreshes it as its last write.
export function refreshMemoryHook(target,memory) {
  try {
    const location=hookLocation(target,memory);
    if(!location.hook||!fs.existsSync(location.hook)||!fs.readFileSync(location.hook,'utf8').split(/\r?\n/).includes(hookMarker)) return;
    const result=spawnSync(process.execPath,[path.join(target,'scripts/memory/install-hooks.mjs'),'--repo',target,'--memory-dir',memory],{encoding:'utf8',windowsHide:true,timeout:30000,env:gateEnv()});
    if(result.error||result.status!==0) throw Error(result.error?.message||result.stderr||result.stdout||'hook installer failed');
  } catch(error) {
    console.log('WARN memory hook refresh skipped: '+oneLine(error.message));
  }
}

// ---- Planning: everything below reads only; it never writes the project, memory or hook. ----
const oneLine=text=>String(text).replace(/[\r\n]+/g,' ').trim();
const sha=data=>createHash('sha256').update(data).digest('hex');
const keyOf=value=>process.platform==='win32'?slash(value).toLowerCase():process.platform==='darwin'?value.toLowerCase():value;
const contains=(root,key)=>key===root||key.startsWith(root.endsWith('/')||root.endsWith(path.sep)?root:root+(process.platform==='win32'?'/':path.sep));
const bytesOf=file=>{ try { return fs.readFileSync(file); } catch(error) { if(['ENOENT','ENOTDIR'].includes(error.code)) return null; throw error; } };
// Kit 3.3.6 item 6 (check before use): a planned destination and a named configuration file are kind-checked right
// before planning reads them. Absent passes; a fifo, socket or device refuses (never read), as entryState does later.
const checked=file=>{ refuseSpecial(file); return file; };
const specialAt=file=>{ let stat; try { stat=fs.statSync(file); } catch(error) { if(['ENOENT','ENOTDIR'].includes(error.code)) return false; throw error; } return !stat.isFile()&&!stat.isDirectory(); };
function entryState(file) {
  let stat;
  try { stat=fs.lstatSync(file); } catch(error) { if(['ENOENT','ENOTDIR'].includes(error.code)) return 'absent'; throw error; }
  // The kind comes before any read: a fifo, socket or device (here or behind a link) is refused, never read.
  const special=()=>new Error(`cannot protect the special file ${file} (a fifo, socket or device cannot be kept or restored); nothing written`);
  if(stat.isSymbolicLink()) {
    let to='',seen='absent',behind=null;
    try { to=fs.readlinkSync(file); } catch {}
    try { behind=fs.statSync(file); } catch {}
    if(behind&&!behind.isDirectory()&&!behind.isFile()) throw special();
    try { if(behind) seen=behind.isDirectory()?'directory':sha(fs.readFileSync(file)); } catch {}
    return 'link:'+to+':'+seen;
  }
  if(stat.isDirectory()) return 'directory';
  if(!stat.isFile()) throw special();
  return sha(fs.readFileSync(file));
}
function captured(run,quiet) {
  const lines=[],original=console.log;
  console.log=(...args)=>lines.push(util.format(...args));
  try { return {value:run(),lines}; }
  catch(error) { console.log=original; if(!quiet) for(const line of lines) console.log(line); throw error; }
  finally { console.log=original; }
}
// Mirrors refreshMemoryHook's early returns: where the kit hook for this memory lives.
function hookLocation(target,memory) {
  const inRepo=inRepoMemory(target,memory),repo=inRepo?target:memory;
  if(!repo||!fs.existsSync(path.join(repo,'.git'))) return {inRepo,reason:`no kit hook at ${slash(path.join(repo??'','.git/hooks/pre-commit'))}`};
  const git=argv=>spawnSync('git',['-C',repo,...argv],{env:listEnv(),encoding:'utf8',windowsHide:true,timeout:10000});
  const configured=git(['config',...(inRepo?[]:['--local']),'--get','core.hooksPath']);
  if(configured.error||![0,1].includes(configured.status)) throw Error(configured.error?.message||configured.stderr||'cannot locate hook');
  // Project hooksPath belongs to the host, including paths containing a kit marker.
  if(inRepo&&configured.status===0) return {inRepo,reason:'project core.hooksPath is set (host-owned)'};
  if(!inRepo) return {inRepo,hook:path.join(configured.stdout.trim()?path.resolve(memory,configured.stdout.trim()):path.join(memory,'.git/hooks'),'pre-commit')};
  const location=git(['rev-parse','--git-path','hooks/pre-commit']);
  if(location.error||location.status!==0) throw Error(location.error?.message||location.stderr||'cannot locate hook');
  return {inRepo,hook:path.resolve(repo,location.stdout.trim())};
}
const unquote=q=>q.startsWith("'")?q.slice(1,-1):q.slice(1,-1).replace(/\\(["$`\\])/g,'$1');
// The gate and memory folder a kit hook names; in-repo hooks run the checkout's relative gate.
function hookTargets(text) {
  const quoted=`('[^']*'|"(?:\\\\.|[^"\\\\])*")`;
  const named=new RegExp(`^node ${quoted} --hook --scope memory --memory-dir ${quoted}`,'m').exec(text);
  if(named) {
    const gate=unquote(named[1]);
    return {gate,memory:unquote(named[2]),checkout:/scripts\/memory\/memory-check\.mjs$/.test(gate)?slash(path.resolve(gate,'../../..')):slash(path.dirname(gate))};
  }
  const staged=/git diff --cached --name-only -- '((?:[^']|'\\'')*)\/'/.exec(text);
  return {gate:'scripts/memory/memory-check.mjs',memory:staged?staged[1].replaceAll("'\\''","'"):'?',checkout:null};
}
function planHook(target,memory,version,worktree,location) {
  if(location.error) return {warn:'WARN memory hook refresh skipped: '+oneLine(location.error.message)};
  const info={location:location.hook??null};
  let current=null;
  // A special hook is never read: the guard's refusal becomes this WARN, and finishPlan's entryState refuses the run.
  try { current=location.hook&&fs.existsSync(location.hook)?fs.readFileSync(checked(location.hook)):null; }
  catch(error) { return {...info,warn:'WARN memory hook refresh skipped: '+oneLine(error.message)}; }
  const owned=current!==null&&current.toString('utf8').split(/\r?\n/).includes(hookMarker);
  if(owned) {
    info.named=hookTargets(current.toString('utf8'));
    if(info.named.checkout&&!fs.existsSync(info.named.gate)) info.broken=`WARN hook ${slash(location.hook)} names a missing checkout ${info.named.checkout}; memory commits will fail until it is refreshed from the main checkout`;
  }
  if(worktree) return {...info,reason:`${slash(target)} is a linked worktree of ${slash(worktree)}`};
  if(location.reason) return {...info,reason:location.reason};
  if(current===null) return {...info,reason:`no kit hook at ${slash(location.hook)}`};
  if(!owned) return {...info,reason:`foreign hook at ${slash(location.hook)}`};
  // install-hooks.mjs refuses a separate memory whose .git is not a folder; so does the plan.
  if(!location.inRepo&&!fs.statSync(path.join(memory,'.git')).isDirectory()) return {...info,warn:'WARN memory hook refresh skipped: The notes folder has no .git folder; initialize it with git init in that folder, then run this command again.'};
  // The text install-hooks.mjs writes (hookText, shared with hookPlan); the refresh is verified against it.
  let text;
  try { text=hookText({memoryDir:memory,repo:target,version}); }
  catch(error) { return {...info,warn:'WARN memory hook refresh skipped: '+oneLine(error.message)}; }
  const next=Buffer.from(text);
  return {...info,hook:location.hook,current,mode:fs.statSync(location.hook).mode,next,change:!next.equals(current),nextNamed:hookTargets(text)};
}
// Exactly what the index step and the lock line would write, computed without writing anything.
function predictMemory(memory,config,{index=true}={}) {
  const changes=new Map(),log=[];
  const files=memoryFiles(memory),before=file=>bytesOf(checked(path.join(memory,file)));
  if(index&&files.some(f=>f.special==='index'&&isGenerated(f.text))) {
    const planned=generateMemoryIndex({memoryDir:memory,config});
    if(!Object.keys(planned.pages).length) log.push(`WARN ${fs.existsSync(path.join(memory,'MEMORY.md'))?'index-less router':'missing router'}: generated pages left unchanged for the gate`);
    else {
      // E2.8 (d): writeMemoryIndex's own rule (worktree and staged versions): an unmarked stub is hand content too.
      const refusal=generatedOutputs(memory,[...Object.keys(planned.pages),...planned.removed],{files});
      if(refusal) throw new Error(refusal);
      for(const [file,text] of Object.entries(planned.pages)) {
        const old=before(file),next=Buffer.from(matchEol(text,old===null?text:old.toString('utf8')));
        if(old===null||!next.equals(old)) changes.set(file,next);
      }
      for(const file of planned.removed) changes.set(file,null);
      // The line memorySteps prints for the same index step.
      log.push(`regenerated ${Object.keys(planned.pages).length} generated pages; removed ${planned.removed.length}: ${planned.removed.slice(0,20).join(', ')}`);
    }
  }
  const ignore=changes.has('.gitignore')?changes.get('.gitignore'):before('.gitignore'),text=ignore===null?'':ignore.toString('utf8');
  if(withLockIgnores(text)!==text) {
    const next=withLockIgnores(text);
    changes.set('.gitignore',Buffer.from(ignore===null?next:matchEol(next,text)));
  }
  return {changes,log};
}
// The memory steps of 3.3.3 (route migration, index regeneration, the lock line). Since 3.3.4 they run only
// on the temporary copy of a rehearsal; the real run writes the bytes they produced there.
function memorySteps({memory,config,repo,probesFile,migration,log}) {
  const load=()=>structuredClone(config);
  if(migration) migrateRoutes({memoryDir:memory,repo,config:load(),probesFile,write:true});
  if (memoryFiles(memory).some(f => f.special === 'index' && isGenerated(f.text))) {
    const options = {memoryDir: memory, config: load()};
    const planned = generateMemoryIndex(options);
    if (!Object.keys(planned.pages).length) {
      const reason = fs.existsSync(path.join(memory, 'MEMORY.md')) ? 'index-less router' : 'missing router';
      log(`WARN ${reason}: generated pages left unchanged for the gate`);
    } else {
      const result = writeMemoryIndex(options);
      log(`regenerated ${Object.keys(result.pages).length} generated pages; removed ${result.removed.length}: ${result.removed.slice(0, 20).join(', ')}`);
    }
  }
  ensureLockIgnore(memory);
}
// E2.8 (d): every path that writes or removes a generated page (the index step, the route migration, a restore) checks
// each one against memory's ORIGINAL working and staged versions with the index writer's own rule (outputRefusal),
// read before any simulation can replace them. Only the handwritten index pages a route migration converts (its
// `inputs`), and a page that already holds exactly the bytes a restore writes (`writes`), may be replaced unmarked.
function generatedOutputs(memory,names,{files=memoryFiles(memory),inputs=new Set(),writes=null}={}) {
  const staged=stagedOutputs(memory);
  for(const name of names) {
    if(!isIndexPage(name)||inputs.has(name)) continue;
    if(writes?.has(name)) {
      // Check before use: a fifo, socket or device (here or behind a link) is refused, never read.
      if(specialAt(path.join(memory,name))) return `${name} is a fifo, socket or device; it is never read or written`;
      const now=bytesOf(path.join(memory,name)),next=writes.get(name);
      if(now===null?next===null:next!==null&&now.equals(next)) continue;
    }
    // Kit 3.3.6 item 1: `files` holds regular files only; any other entry there (a link) is read through, so the
    // marker check sees what a write would replace. read() follows the link and strips a BOM like memoryFiles.
    const dest=path.join(memory,name);
    const refusal=outputRefusal(name,files.find(f=>f.file===name)??(fs.existsSync(dest)?{text:read(dest)}:undefined),staged);
    if(refusal) return refusal;
  }
  return null;
}
// A route migration cannot be computed without writing, so it runs on a temporary copy of the
// top-level memory files (the set the backup copies). Links stay links, pointing inside the copy.
function simulateMemory(memory,config,target,probesFile) {
  const dir=scratch('kit-upgrade-plan-',[target,memory]),links=path.join(dir,'.kit-plan-links');
  // The originals, read before the copy is made: the migration's inputs and every generated page it may replace.
  const files=memoryFiles(memory),inputs=migrationInputs(files);
  try {
    const original=new Map(),log=[];
    for(const entry of fs.readdirSync(memory,{withFileTypes:true})) {
      if(isLockName(entry.name)) continue;
      const source=path.join(memory,entry.name);
      if(entry.isFile()) { fs.copyFileSync(source,path.join(dir,entry.name)); original.set(entry.name,fs.readFileSync(source)); }
      else if(entry.isSymbolicLink()) {
        let stat=null;try { stat=fs.statSync(source); } catch {}
        if(stat?.isDirectory()) continue;
        fs.mkdirSync(links,{recursive:true});
        const inner=path.join(links,entry.name);
        // Kit 3.3.6 item 7 (b): the link's referent is kind-checked before it is copied and read.
        if(stat) fs.copyFileSync(checked(source),inner);
        original.set(entry.name,stat?fs.readFileSync(source):null);
        fs.symlinkSync(inner,path.join(dir,entry.name),'file');
      }
    }
    memorySteps({memory:dir,config,repo:target,probesFile,migration:true,log:line=>log.push(line)});
    const after=new Map();
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      if(isLockName(entry.name)||entry.name==='.kit-plan-links') continue;
      if(entry.isFile()||entry.isSymbolicLink()) after.set(entry.name,bytesOf(path.join(dir,entry.name)));
    }
    const changes=new Map();
    for(const name of new Set([...original.keys(),...after.keys()])) {
      const old=original.get(name)??null,next=after.get(name)??null;
      if(next===null&&old!==null) changes.set(name,null);
      else if(next!==null&&(old===null||!next.equals(old))) changes.set(name,next);
    }
    const refusal=generatedOutputs(memory,changes.keys(),{files,inputs});
    if(refusal) throw new Error(refusal);
    return {changes,log};
  } finally {
    // A temporary copy that cannot be removed (EBUSY, EPERM on Windows) is left behind; it never replaces the result or refusal.
    try { fs.rmSync(dir,{recursive:true,force:true}); } catch {}
  }
}
// The generated pages whose bytes differ from what the index step would write now.
const stalePages=(memory,expected)=>Object.entries(expected.pages).filter(([file,text])=>read(path.join(memory,file)).replace(/\r\n/g,'\n')!==text).map(([file])=>file);
// The handwritten index pages a route migration converts (its `inputs`, as simulateMemory builds them).
const migrationInputs=files=>new Set(files.filter(f=>f.special==='index'&&!f.stub&&!isGenerated(f.text)).map(f=>f.file));
// Kit 3.3.6 item 12a: on the same-version path, a stale or obsolete page the replay would refuse (an unmarked page that
// is not a migration input, or an unmarked staged version) is the run's refusal (exit 1), so no replay line is printed
// for a replay that cannot run. A failure to compute the pages is left to memoryPending, which reports it as pending.
function replayRefusal(memory,config) {
  const files=memoryFiles(memory);
  if(!files.some(f=>isGenerated(f.text))) return null;
  let expected,stale;
  try { expected=generateMemoryIndex({memoryDir:memory,config}); stale=stalePages(memory,expected); }
  catch { return null; }
  return generatedOutputs(memory,[...stale,...expected.removed],{files,inputs:migrationInputs(files)});
}
// Statement 13: the same-version path refuses while memory lags the project files.
function memoryPending(memory,config,version) {
  const list=names=>names.slice(0,5).join(', ')+(names.length>5?`, +${names.length-5} more`:'');
  const files=memoryFiles(memory),reasons=[];
  const hand=files.filter(f=>f.special==='index'&&!f.stub&&!isGenerated(f.text)).map(f=>f.file);
  if(!newer('3.2.0',version)&&hand.length) reasons.push(`route migration pending (${hand.length} hand-written index pages: ${list(hand)})`);
  if(files.some(f=>isGenerated(f.text))) {
    try {
      const expected=generateMemoryIndex({memoryDir:memory,config});
      const stale=stalePages(memory,expected);
      if(stale.length) reasons.push(`stale generated pages: ${list(stale)}`);
      if(expected.removed.length) reasons.push(`obsolete generated pages: ${list(expected.removed)}`);
    } catch(error) { reasons.push(`stale generated pages: MEMORY.md (${oneLine(error.message)})`); }
  }
  return reasons.length?reasons.join('; '):null;
}
// Fresh canonical keys on both sides (never the cache); a folder that cannot be resolved is an error.
const sameFolder=(a,b)=>keyOf(canonicalPathFresh(a))===keyOf(canonicalPathFresh(b));
function predictProject(target,updates) {
  const changes=[];
  for(const [file,data] of updates) {
    const dest=inside(target,file),old=bytesOf(checked(dest));
    if(data===null) { if(old!==null) changes.push({file:slash(file),bytes:null}); continue; }
    const next=old===null?Buffer.from(data):Buffer.from(matchEol(data,old.toString('utf8')));
    if(old===null||!next.equals(old)) changes.push({file:slash(file),bytes:next});
  }
  return changes.sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);
}
function planUnprinted(opts, root, hooks={}) {
  const target=path.resolve(opts.target),engine=path.join(target,'scripts/memory');
  const receipt=readJSON(checked(path.join(engine,'KIT.json'))),oldManifest=readJSON(checked(path.join(engine,'MANIFEST.json')));
  const refusals=distributionRefusals(target,root,oldManifest);
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
  const localFile=path.join(engine,'KIT.local.json'),local=fs.existsSync(localFile)?readJSON(checked(localFile)):{};
  const localBefore=JSON.stringify(local);
  const skipGuard=opts['no-guard'] || local.guard===false;
  const settingsFile=path.join(target,'.claude/settings.json');
  const settings=fs.existsSync(settingsFile)?readJSON(checked(settingsFile)):{};
  if(!settings || typeof settings!=='object' || Array.isArray(settings)) throw new Error('settings.json must be an object');
  const guardAdded=!skipGuard && mergeGuardHooks(settings,readJSON(path.join(root,'templates/settings.guard.json')));
  if(opts['no-guard']) local.guard=false;
  const sessionChanged=sessionSettings(settings,local,opts,root);
  const skills=skillPlan(target,root,oldManifest,local,opts);
  for(const file of skills.kept) delete nextManifest.files[file];
  const localChanged=JSON.stringify(local)!==localBefore;
  const instructionPlan=standardBlockPlan(target,root,{...opts,inRepo:inRepoMemory(target,resolveMemory(target,opts['memory-dir']).dir)},hooks.instructions);
  const gateUpdate=instructionPlan.writes.length>0;
  const mirrorSources=ownedFiles(root).filter(f=>f.startsWith('skills/')&&!skills.kept.includes(installedPath(f))).filter(f=>{
    const file=installedPath(f),dest=checked(path.join(target,file));
    return !fs.existsSync(dest)||hash(dest)===oldManifest.files[file]||hash(dest)===nextManifest.files[file]||opts['force-skills']||skills.replaceSkills.includes(file.split('/')[2]);
  }).map(f=>[path.join(target,installedPath(f)),fs.readFileSync(path.join(root,f))]);
  const mirrors=mirrorWrites(target,mirrorSources,instructions(target),{keepDivergent:true}).filter(([file,data])=>!fs.existsSync(file)||normalizeEol(fs.readFileSync(checked(file),'utf8'))!==normalizeEol(data));
  for(const [file] of mirrors) console.log('skill mirror planned: '+path.relative(target,file));
  const seedMissing=!fs.existsSync(path.join(engine,'enforce-rules.json'));
  console.log('settings: '+(opts['no-guard']?'skipped (--no-guard)':local.guard===false?'skipped (KIT.local.json guard: false)':guardAdded?`guard hooks ${opts.check ? 'would add' : 'added'} (PreToolUse Bash|PowerShell, UserPromptSubmit)`:'present'));
  const engineChanged=Object.entries(nextManifest.files).some(([file,expected])=>file.startsWith('scripts/memory/')&&(!fs.existsSync(inside(target,file))||hash(checked(inside(target,file)))!==expected));
  const edited=Object.keys(oldManifest.files).filter(f=>!fs.existsSync(inside(target,f))||hash(checked(inside(target,f)))!==oldManifest.files[f]);
  const keptSkills=edited.filter(f=>f.endsWith('/SKILL.md')&&fs.existsSync(inside(target,f))&&!opts['force-skills']&&!skills.replaceSkills.includes(f.split('/')[2]));
  const legacy=Object.keys(oldManifest.files).filter(f=>f.endsWith('/SKILL.md')&&fs.existsSync(inside(target,f))&&/^engine_version:/m.test(fs.readFileSync(checked(inside(target,f)),'utf8')));
  const legacySkills=legacy.some(f=>!keptSkills.includes(f));
  for(const f of legacy.filter(f=>keptSkills.includes(f))) console.log('WARN kept host-edited skill '+f+': manually move top-level engine_version to metadata.engine_version.');
  const memory=resolveMemory(target,opts['memory-dir']),live=opts['memory-dir']?resolveMemory(target,undefined):memory;
  // Damaged markers, unclear lines, a bad decisions or ledger file and a failed proof refuse the run before the
  // lock. --memory-only plans no project write, so the instruction file is not its concern (statement 15).
  const instructionRefusal=opts['memory-only']?null:instructionPlan.refusal;
  const plan={root,target,engine,receipt,refusals,version,edited,runLog:[],updates:new Map(),projectChanges:[],memoryChanges:[],memoryLog:[],hook:{},
    memory:memory.dir,memorySource:memory.source,memoryOnly:Boolean(opts['memory-only']),instructions:instructionPlan,instructionRefusal,
    checkExit:Boolean(refusals.length||instructionRefusal||newer(version,receipt.version)||edited.some(f=>!keptSkills.includes(f))||engineChanged||legacySkills||guardAdded||sessionChanged||gateUpdate||mirrors.length||localChanged||seedMissing),
    noop:version===receipt.version&&!engineChanged&&!legacySkills&&!opts['force-skills']&&!skills.replaceSkills.length&&!guardAdded&&!sessionChanged&&!gateUpdate&&!mirrors.length&&!localChanged&&!seedMissing,
    same:version===receipt.version&&!engineChanged};
  // Never fails open: an unknown worktree state is kept as a refusal (made after the S2 listing, so a listing
  // failure keeps its own message), and no hook is planned.
  try { plan.worktree=linkedWorktree(target); }
  catch(error) { plan.worktree=null; plan.worktreeError=`upgrade: ${oneLine(error.message)}; nothing written`; }
  plan.isLive=!opts['memory-dir']||sameFolder(memory.dir,live.dir);
  plan.rehearsal=plan.isLive?null:memory.dir;
  plan.memoryMissing=!fs.existsSync(memory.dir)||!fs.statSync(memory.dir).isDirectory();
  // One hook lookup per folder: when the run's memory is the live folder, its hook is the live hook.
  let runLocation,liveHook=null;
  try { runLocation=hookLocation(target,memory.dir); } catch(error) { runLocation={error}; }
  if(plan.isLive) liveHook=runLocation.hook??null;
  else try { liveHook=hookLocation(target,live.dir).hook??null; } catch {}
  plan.live={dir:live.dir,source:live.source,hook:liveHook};
  if(plan.memoryOnly&&!plan.same) plan.memoryOnlyRefusal=`upgrade: --memory-only needs project files at kit ${version}; found kit ${receipt.version}${engineChanged?', engine files differ':''}; run the full upgrade`;
  // A refused run writes nothing, so its plan stays empty and never touches a temporary folder.
  if(refusals.length||instructionRefusal||newer(receipt.version,version)||plan.memoryOnlyRefusal) return finishPlan(plan);
  const projectConfig=()=>readJSON(checked(path.join(engine,'memory.config.json')));
  let memoryConfig;
  if(!plan.noop&&!plan.memoryOnly) {
    const same=plan.same;
    const defaults=readJSON(path.join(root,'engine/memory.config.json'));
    const mergedConfig=mergeDefaults(projectConfig(),defaults);
    mergedConfig.engine_version=defaults.engine_version;
    plan.mergedConfig=mergedConfig;
    const replace=ownedFiles(root).filter(f=>!same||f.startsWith('skills/')).filter(f=>{
      const installed=installedPath(f);
      if(skills.kept.includes(installed)) return false;
      if(f.startsWith('skills/')&&edited.includes(installed)&&!opts['force-skills']&&!skills.replaceSkills.includes(installed.split('/')[2])) { if(!legacy.includes(installed)) plan.runLog.push('WARN edited skill skipped: '+installed);return false; }
      return true;
    });
    const updates=new Map(replace.map(f=>[installedPath(f),fs.readFileSync(path.join(root,f))]));
    if(guardAdded||sessionChanged) updates.set('.claude/settings.json',JSON.stringify(settings,null,2)+'\n');
    if(localChanged) updates.set('scripts/memory/KIT.local.json',JSON.stringify(local,null,2)+'\n');
    for(const [file,data] of instructionPlan.writes) updates.set(slash(path.relative(target,file)),data);
    if(seedMissing) updates.set('scripts/memory/enforce-rules.json',fs.readFileSync(path.join(root,'templates/enforce-rules.json')));
    for(const [file,data] of mirrors) {
      updates.set(path.relative(target,file).split(path.sep).join('/'),data);
      plan.runLog.push('skill mirror updated: '+path.relative(target,file));
    }
    if(!same) {
      for(const f of Object.keys(oldManifest.files)) if(!Object.hasOwn(nextManifest.files,f)&&!skills.kept.includes(f)) {
        if(fs.existsSync(inside(target,f)) && hash(checked(inside(target,f))) === oldManifest.files[f]) updates.set(f,null);
        else plan.runLog.push('kept locally edited retired file: '+f);
      }
      updates.set('scripts/memory/memory.config.json',JSON.stringify(mergedConfig,null,2)+'\n');
      if(!fs.existsSync(path.join(engine,'upgrades.json'))) updates.set('scripts/memory/upgrades.json',fs.readFileSync(path.join(root,'engine/upgrades.json')));
    }
    for(const f of Object.keys(nextManifest.files)) if(f.startsWith('.claude/skills/')&&!updates.has(f)) nextManifest.files[f]=oldManifest.files[f]??nextManifest.files[f];
    updates.set('scripts/memory/KIT.json',JSON.stringify({...receipt,version},null,2)+'\n');
    updates.set('scripts/memory/MANIFEST.json',JSON.stringify(nextManifest,null,2)+'\n');
    const ignoreFile=path.join(engine,'.gitignore'),ignore=fs.existsSync(ignoreFile)?fs.readFileSync(checked(ignoreFile),'utf8'):'';
    if(withIgnores(ignore)!==ignore) updates.set('scripts/memory/.gitignore',withIgnores(ignore));
    plan.updates=updates;
    plan.projectChanges=predictProject(target,updates);
    memoryConfig=updates.has('scripts/memory/memory.config.json')?JSON.parse(JSON.stringify(mergedConfig)):projectConfig();
  } else memoryConfig=projectConfig();
  if(plan.memoryMissing) return finishPlan(plan);
  if(plan.noop&&!plan.memoryOnly) {
    // Kit 3.3.6 item 12a: a refusal the replay would give stops this run (exit 1) instead of suggesting the replay.
    const refusal=replayRefusal(memory.dir,memoryConfig);
    if(refusal) plan.memoryError=refusal;
    else plan.pending=memoryPending(memory.dir,memoryConfig,version);
    if(plan.pending||plan.memoryError) return finishPlan(plan);
  }
  // A full run (new version, project repairs or --memory-only) runs every memory step; the same-version
  // no-op path writes at most the lock line and the hook.
  const full=!plan.noop||plan.memoryOnly;
  plan.migration=full&&!newer('3.2.0',version)&&memoryFiles(memory.dir).some(f=>f.special==='index'&&!f.stub&&!isGenerated(f.text));
  try {
    const result=plan.migration?simulateMemory(memory.dir,memoryConfig,target,path.join(engine,'recall-probes.json')):predictMemory(memory.dir,memoryConfig,{index:full});
    plan.memoryChanges=[...result.changes].map(([file,bytes])=>({file,bytes})).sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);
    plan.memoryLog=result.log;
  } catch(error) { if(error instanceof ScratchRefusal) throw error; plan.memoryError=oneLine(error.message); }
  plan.hook=plan.worktreeError?{location:null,reason:plan.worktreeError}:planHook(target,memory.dir,memoryConfig.engine_version,plan.worktree,runLocation);
  // Statement 22: every run that writes keeps a durable backup; only a run that changes nothing has none.
  plan.backup=full||plan.memoryChanges.length>0||Boolean(plan.hook.change);
  return finishPlan(plan);
}
function finishPlan(plan) {
  const {target,engine,memory}=plan,destinations=[];
  for(const change of plan.projectChanges) destinations.push({path:path.join(target,change.file),kind:'project',label:'project file',line:(change.bytes===null?'DELETE ':'WRITE ')+change.file});
  if(plan.backup) destinations.push({path:path.join(engine,'.kit-backup-<time>'),kind:'backup',label:'backup',line:'BACKUP scripts/memory/.kit-backup-<time>/ (created by the real run)'});
  for(const change of plan.memoryChanges) destinations.push({path:path.join(memory,change.file),kind:'memory',label:'memory file',line:(change.bytes===null?'MEMORY DELETE ':'MEMORY WRITE ')+change.file});
  if(plan.hook.change) destinations.push({path:plan.hook.hook,kind:'hook',label:'hook',line:`HOOK ${slash(plan.hook.hook)}: gate ${plan.hook.named.gate} -> ${plan.hook.nextNamed.gate}; memory ${plan.hook.named.memory} -> ${plan.hook.nextNamed.memory}`});
  plan.destinations=destinations;
  // What the plan read: every top-level memory entry, the hook file and each planned project file.
  const fingerprint=new Map();
  if(!plan.memoryMissing) for(const entry of fs.readdirSync(memory,{withFileTypes:true})) if(!isLockName(entry.name)&&!entry.isDirectory()) fingerprint.set(path.join(memory,entry.name),entryState(path.join(memory,entry.name)));
  if(plan.hook.location) fingerprint.set(plan.hook.location,entryState(plan.hook.location));
  for(const file of plan.updates.keys()) fingerprint.set(path.join(target,file),entryState(path.join(target,file)));
  plan.fingerprint=fingerprint;
  plan.signature=[...plan.projectChanges.map(c=>[path.join(target,c.file),c.bytes===null?'delete':sha(c.bytes)]),
    ...plan.memoryChanges.map(c=>[path.join(memory,c.file),c.bytes===null?'delete':sha(c.bytes)]),
    ...(plan.hook.change?[[plan.hook.hook,sha(plan.hook.next)]]:[]),
    ['pending',String(plan.pending??'')],['memory error',String(plan.memoryError??'')]];
  return plan;
}
function makePlan(opts,root,quiet=false,hooks={}) {
  const {value,lines}=captured(()=>planUnprinted(opts,root,hooks),quiet);
  value.log=lines;
  return value;
}
const counts=plan=>[plan.projectChanges.length,plan.memoryChanges.length,plan.hook.change?1:0];

// ---- Safety: statements 6, 8, 20 and 21 of the 3.3.4 contract. ----
function liveFlagRefusal(plan,opts) {
  if(opts['live-memory']&&plan.worktree) return `upgrade: refusing --live-memory from a linked worktree ${plan.target}; run it from the main checkout ${plan.worktree}`;
  if(plan.isLive&&!opts['live-memory']&&(plan.memoryChanges.length||plan.hook.change)) return `upgrade: refusing to write live memory ${plan.memory} (${plan.live.source}) without --live-memory; preview with --check, rehearse with --memory-dir <copy>, or add --live-memory`;
  return null;
}
// A hard link has nothing to resolve: writing one name of a file changes every other name, wherever it is,
// so a destination file with other names is refused (statement 20, "anything else is refused").
function hardLinks(file) {
  let stat;
  try { stat=fs.statSync(file); } catch { return null; }
  return stat.isFile()&&stat.nlink>1?`it has ${stat.nlink} hard links; a write would change the other links too`:null;
}
// A plan whose memory steps could not be computed is incomplete: the run writes nothing (fail closed).
const memoryRefusal=plan=>`upgrade: cannot plan the memory steps (${plan.memoryError}); nothing written`;
// E2.8 (a): a run with --live-memory on the live folder (a full update, the --memory-only replay or a restore) is an
// exclusive maintenance step, like memory-init and memory-setup: the same pending-claims check refuses it while any
// live, malformed or unreadable ledger holds unresolved claims. `dir` is the folder the memory lock is taken in, read
// directly (never the planning copy); a rehearsal with --memory-dir <copy> is not checked.
function claimsRefusal(plan,opts,dir) {
  if(!opts['live-memory']||!plan.isLive||!dir) return null;
  try { refuseWhilePending({memoryDir:dir,label:'upgrade',ownId:null}); return null; }
  catch(error) { const text=oneLine(error.message); return (text.startsWith('upgrade refused')?text:'upgrade refused: '+text)+'; nothing written'; }
}
// E2.8 (b): the push lock is held with the memory lock for the whole plan-write-verify window, so no session
// publishes (and moves memory's .git refs) during the run. A held push lock refuses after a short bounded wait.
const PUSH_WAIT_MS=2000;
function withPushLock(dir,run) {
  let entered=false;
  try { return withMemoryLock(dir,()=>{ entered=true; return run(); },{name:PUSH_LOCK,timeoutMs:PUSH_WAIT_MS}); }
  catch(error) {
    if(entered) throw error;
    console.error(`upgrade: the push lock ${path.join(dir,PUSH_LOCK)} is held (${oneLine(error.message)}); a publication may be running, or a stopped run left it (a dead run's lock is broken after 10 minutes); nothing written; run again`);
    return 1;
  }
}
// Resolves every destination, its existing parents, the target, the memory and rehearsal folders and the live
// set on canonical paths (no cache), then classifies each destination. Fails closed on any resolution error.
// `resolved` holds comparison keys, `exact` the canonical paths themselves; `lock` is the memory folder's.
function safety(plan,opts) {
  const resolved=new Map(),exact=new Map(),reasons=new Map();
  const resolve=file=>{
    if(resolved.has(file)) return resolved.get(file);
    let value;
    try { value=canonicalPathFresh(file); }
    catch(error) { throw Object.assign(new Error(`upgrade: cannot resolve ${file} (${error.code??'error'}); nothing written`),{unresolved:true}); }
    exact.set(file,value);resolved.set(file,keyOf(value)); return keyOf(value);
  };
  const parents=file=>{
    for(let dir=path.dirname(file);;dir=path.dirname(dir)) {
      // Only a folder that is not there (a race) is passed over; any other failure refuses, like resolve().
      try { fs.lstatSync(dir); resolve(dir); }
      catch(error) { if(error.unresolved) throw error; if(!['ENOENT','ENOTDIR'].includes(error.code)) throw Object.assign(new Error(`upgrade: cannot resolve ${dir} (${error.code??'error'}); nothing written`),{unresolved:true}); }
      if(path.dirname(dir)===dir) break;
    }
  };
  // Kit 3.3.6 item 7 (a): every destination's kind, after the hard-link test (stat follows a link to what it reaches). A
  // fifo, socket or device is refused for the plan, the preview and the restore alike, and again under the lock; a stat
  // error other than ENOENT or ENOTDIR is unresolved, like resolve()'s, so the refusal never prints the raw error.
  const kind=file=>{
    let stat;
    try { stat=fs.statSync(file); }
    catch(error) { if(['ENOENT','ENOTDIR'].includes(error.code)) return null; throw Object.assign(new Error(`upgrade: cannot resolve ${file} (${error.code??'error'}); nothing written`),{unresolved:true}); }
    return stat.isFile()||stat.isDirectory()?null:'it is a fifo, socket or device';
  };
  try {
    const target=resolve(plan.target),liveDir=resolve(plan.live.dir),liveHook=plan.live.hook?resolve(plan.live.hook):null;
    const rehearsal=plan.rehearsal?resolve(plan.rehearsal):null;
    if(plan.memory) resolve(plan.memory);
    if(plan.hook.location) resolve(plan.hook.location);
    for(const destination of plan.destinations) {
      const key=resolve(destination.path);parents(destination.path);
      let reason=null;
      if(contains(liveDir,key)||key===liveHook) reason=opts['live-memory']?null:'it is live; add --live-memory';
      else if(rehearsal&&contains(rehearsal,key)) reason=null;
      else if(['project','backup'].includes(destination.kind)&&contains(target,key)) reason=null;
      else reason=`it is outside the rehearsal folder ${plan.rehearsal??'(no --memory-dir copy given)'}`;
      reason??=hardLinks(destination.path);
      reason??=kind(destination.path);
      if(reason) reasons.set(destination,reason);
    }
  } catch(error) { if(error.unresolved) return {resolved,exact,reasons,error:error.message}; throw error; }
  const [first,reason]=[...reasons][0]??[];
  return {resolved,exact,reasons,lock:plan.memory?exact.get(plan.memory):null,refusal:first?`upgrade: refusing to write ${first.path} (${first.label}): ${reason}`:null};
}
function firstDifference(a,b) {
  for(const key of [...new Set([...a.keys(),...b.keys()])].sort()) if(a.get(key)!==b.get(key)) return key;
  return null;
}
// Destinations first, so a link retargeted between the plans is named by the file it would write.
function resolvedDifference(destinations,first,second) {
  for(const destination of destinations) if(first.get(destination.path)!==second.get(destination.path)) return destination.path;
  return firstDifference(first,second);
}
function planDifference(first,second) {
  const changed=firstDifference(first.fingerprint,second.fingerprint);
  if(changed) return changed;
  for(let i=0;i<Math.max(first.signature.length,second.signature.length);i++) {
    const [a,b]=[first.signature[i],second.signature[i]];
    if(!a||!b||a[0]!==b[0]||a[1]!==b[1]) return (a??b)[0];
  }
  return null;
}
// Names the differing paths, at most ten of them in the message.
class PlanDifference extends Error {
  constructor(files) {
    files=[...new Set([files].flat())];
    super('writes differed from the plan ('+files.slice(0,10).join(', ')+(files.length>10?`, +${files.length-10} more`:'')+')');
    this.files=files;
  }
}

// ---- Preview ----
function printPreview(plan,opts) {
  const check=safety(plan,opts),mark=destination=>check.reasons.has(destination)?` (refused in a real run: ${check.reasons.get(destination)})`:'';
  const lines=[],refused=[];
  // Kit 3.3.6 item 12b (rule R7): the preview names the real run's refusals that need no lock and no scope inventory:
  // the downgrade here, memory planning and the pending claims below. The lock-time checks stay real-run only.
  if(newer(plan.receipt.version,plan.version)) refused.push('upgrade: Refusing a downgrade');
  if(plan.memoryOnlyRefusal) refused.push(plan.memoryOnlyRefusal);
  if(plan.worktreeError) refused.push(plan.worktreeError);
  const flag=opts['live-memory']&&plan.worktree?liveFlagRefusal(plan,opts):null;
  if(flag) refused.push(flag);
  if(check.error) refused.push(check.error);
  if(plan.pending) refused.push(`upgrade: project files are at kit ${plan.version}, but memory is not: ${plan.pending}`,replayLine(plan));
  if(plan.memoryMissing) refused.push('WARN memory dir not found: '+plan.memory);
  if(plan.memoryError) refused.push(memoryRefusal(plan));
  // claimsRefusal reads the ledgers and runs read-only git queries; it writes nothing.
  const claims=claimsRefusal(plan,opts,check.lock);
  if(claims) refused.push(claims);
  if(plan.hook.broken) lines.push(plan.hook.broken);
  if(plan.hook.warn) lines.push(plan.hook.warn);
  if(!plan.memoryOnly) {
    lines.push('planned writes (--check writes nothing):');
    for(const destination of plan.destinations.filter(d=>['project','backup'].includes(d.kind))) lines.push(destination.line+mark(destination));
  }
  lines.push(`MEMORY ${slash(plan.memory)} (${plan.memorySource}; ${plan.isLive?'live':'copy'})`);
  for(const destination of plan.destinations.filter(d=>d.kind==='memory')) lines.push(destination.line+mark(destination));
  const hook=plan.destinations.find(d=>d.kind==='hook');
  if(hook) lines.push(hook.line+mark(hook));
  else if(plan.hook.reason) lines.push('HOOK not refreshed: '+plan.hook.reason);
  else if(plan.hook.hook) lines.push(`HOOK ${slash(plan.hook.hook)}: unchanged`);
  const [p,m,h]=counts(plan);
  lines.push(`planned writes: ${p} project, ${m} memory, ${h} hook`);
  if(plan.memoryOnly) {
    for(const line of refused) console.error(line);
    for(const line of lines.filter(line=>/^(?:MEMORY|HOOK|planned writes:) /.test(line))) console.log(line);
    return refused.length||m||h||check.reasons.size?1:0;
  }
  for(const line of plan.log) console.log(line);
  for(const message of plan.refusals) console.log(message);
  if(plan.instructionRefusal) console.log('upgrade: '+plan.instructionRefusal);
  for(const f of plan.edited) console.log('edited locally: '+f);
  for(const line of refused) console.log(line);
  for(const line of lines) console.log(line);
  console.log('kit '+plan.receipt.version+' -> '+plan.version);
  return plan.checkExit||p||m||h||refused.length||check.reasons.size ? 1 : 0;
}
const replayLine=plan=>`upgrade: replay the memory steps with: node "${path.join(plan.root,'scripts/upgrade.mjs')}" --target "${plan.target}" --memory-only --live-memory (rehearse with --memory-dir <copy>)`;

// ---- Execution ----
// The execution scope of statements 3 and 22, as amended by Addendum A-scope (S1). It is the union of:
//  1. the git-visible project files (tracked, and untracked but not ignored; submodule gitlinks and nested
//     repositories left out), or, for a target positively outside any git work tree, the whole target tree
//     without nested repositories;
//  2. the protected host configuration and the git inputs that select point 1 or locate the hook, ignored or
//     not, each recorded even when absent;
//  3. every planned destination and the hook: the file a write reaches and, for a link, the link itself;
//  4. the whole memory folder except .memory.lock*, its .git and older backup folders included.
// Points 2-4 override the exclusions of point 1; only this run's backup folder is left out of points 1 and 4.
// A protected input outside both the target and the memory folder is validation-only: compared, never written.
// Folders are walked, links are recorded and never followed. Before the first write every regular file in the
// scope is copied to a temporary snapshot; the snapshot's keys stay in scope for the whole run (S2).
class ListError extends Error {}
// A git input whose location cannot be established exactly (S2, fail closed): refused before the lock, and a
// later failure under it, like any listing error.
class InputError extends ListError { constructor(what,reason) { super(`${what} (${reason})`); } }
// A special file (fifo, socket, device) in the scope: it cannot be copied to the snapshot or made again.
class SpecialError extends ListError {}
const listReason=error=>error instanceof SpecialError?`cannot protect the special file ${error.message} (a fifo, socket or device cannot be kept or restored)`:error instanceof InputError?`cannot establish the git input ${error.message}`:`cannot list the project files (${error.message})`;
// A path git prints or a configuration value names is used only when it is a full path (a drive or share root on
// Windows, / elsewhere); a relative one is never joined with a guessed folder.
const fullPath=file=>process.platform==='win32'?/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(file):file.startsWith('/');
const exactInput=(what,file)=>{ if(!fullPath(file)) throw new InputError(what,`${JSON.stringify(file)} is not a full path`); return path.resolve(file); };
// Listing calls use the one clean git environment (lib.mjs cleanGitEnv), without optional locks, in English.
const listEnv=()=>({...cleanGitEnv(),GIT_OPTIONAL_LOCKS:'0',LC_ALL:'C',LANG:'C'});
function git(cwd,args,env=listEnv()) {
  const r=spawnSync('git',['-C',cwd,...args],{env,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:512*1024*1024});
  if(r.error) throw new ListError(`git ${args[0]} could not run (${r.error.code??oneLine(r.error.message)})`);
  return r;
}
// S2 complete output: a spawn error, a nonzero status or any diagnostic (even with status zero) is a failure.
function gitOutput(cwd,args) {
  const r=git(cwd,args),err=String(r.stderr).trim();
  if(r.status!==0) throw new ListError(`git ${args.join(' ')} exited ${r.status}${err?': '+oneLine(err):''}`);
  if(err) throw new ListError(`git ${args.join(' ')} reported: ${oneLine(err)}`);
  return r.stdout;
}
const nulRecords=text=>{ if(text&&!text.endsWith('\0')) throw new ListError('git output ended early'); return text.split('\0').slice(0,-1); };
// S2 fallback: 'git' inside a work tree; 'tree' only for a positively identified non-repository whose ancestors,
// lexical and resolved, up to the drive or share root hold no .git entry; anything else is an error.
function projectMode(target) {
  const r=git(target,['rev-parse','--is-inside-work-tree']),err=String(r.stderr).trim();
  if(r.status===0&&!err&&r.stdout.trim()==='true') return 'git';
  if(r.status!==128||err!=='fatal: not a git repository (or any of the parent directories): .git')
    throw new ListError(`git rev-parse --is-inside-work-tree exited ${r.status}${err?': '+oneLine(err):`, printed ${oneLine(r.stdout)||'nothing'}`}`);
  let real;
  try { real=canonicalPathFresh(target); } catch(error) { throw new ListError(`cannot resolve ${target} (${error.code??'error'})`); }
  for(const start of [path.resolve(target),real]) for(let dir=start;;dir=path.dirname(dir)) {
    const marker=path.join(dir,'.git');
    try { fs.lstatSync(marker); } catch(error) { if(['ENOENT','ENOTDIR'].includes(error.code)) { if(path.dirname(dir)===dir) break; continue; } throw new ListError(`cannot inspect ${marker} (${error.code})`); }
    throw new ListError(`${marker} exists, but git found no repository`);
  }
  return 'tree';
}
// Point 1 for a work tree: cached entries (gitlinks left out) and untracked files that are not ignored, minus
// nested repositories (a trailing slash, or any folder between the target and the file holding a .git entry).
function gitVisible(target) {
  const files=new Set(),boundary=new Map();
  for(const record of nulRecords(gitOutput(target,['ls-files','-z','--stage','--cached']))) {
    const m=/^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t([\s\S]+)$/.exec(record);
    if(!m) throw new ListError('malformed git ls-files record '+JSON.stringify(record.slice(0,80)));
    if(m[1]!=='160000') files.add(m[4]);
  }
  const nested=rel=>{
    const parts=rel.split('/');
    for(let i=1;i<parts.length;i++) {
      const dir=parts.slice(0,i).join('/');
      if(!boundary.has(dir)) {
        let found=true;
        try { fs.lstatSync(path.join(target,dir,'.git')); } catch(error) { if(!['ENOENT','ENOTDIR'].includes(error.code)) throw new ListError(`cannot inspect ${path.join(target,dir,'.git')} (${error.code})`); found=false; }
        boundary.set(dir,found);
      }
      if(boundary.get(dir)) return true;
    }
    return false;
  };
  for(const rel of nulRecords(gitOutput(target,['ls-files','-z','--others','--exclude-standard']))) if(!rel.endsWith('/')&&!files.has(rel)&&!nested(rel)) files.add(rel);
  return files;
}
// What an include names: ~/ is the home folder, and a relative path is read from the folder of the file that
// names it. Anything git would interpolate itself (%(...), ~user), a path rooted without a drive, or a relative
// include outside a configuration file is refused rather than guessed.
// The home and XDG folders git starts from: each must be a full path. Empty, relative or missing is refused,
// never resolved against the updater's folder.
// An unset variable falls through to the next source; a set one that is empty or relative is refused.
function homeBase() {
  for(const name of ['HOME','USERPROFILE']) {
    const value=process.env[name];
    if(value===undefined) continue;
    if(!value||!fullPath(value)) throw new InputError(name,`${JSON.stringify(value)} is not a full path`);
    return path.resolve(value);
  }
  const value=os.homedir();
  if(!value||!fullPath(value)) throw new InputError('the home folder',`${JSON.stringify(value??'')} is not a full path`);
  return path.resolve(value);
}
function xdgBase() {
  const value=process.env.XDG_CONFIG_HOME;
  if(value===undefined) return path.join(homeBase(),'.config');
  if(!value||!fullPath(value)) throw new InputError('XDG_CONFIG_HOME',`${JSON.stringify(value)} is not a full path`);
  return path.resolve(value);
}
function includeTarget(key,value,from) {
  const what=`${key} ${JSON.stringify(value)}`;
  if(value.includes('%(')) throw new InputError(what,'git expands %(...) itself');
  if(value.startsWith('~/')) return path.join(homeBase(),value.slice(2));
  if(value.startsWith('~')) throw new InputError(what,'only ~/ is resolved here');
  if(fullPath(value)) return path.resolve(value);
  if(path.isAbsolute(value)) throw new InputError(what,'a rooted path without a drive');
  if(!from) throw new InputError(what,'a relative include outside a configuration file');
  return path.resolve(path.dirname(from),value);
}
// What every git answers for a variable git var does not know; an older git (before 2.42) answers so for
// GIT_CONFIG_SYSTEM and GIT_CONFIG_GLOBAL. Status 129, nothing on stdout, exactly the usage line on stderr.
const unknownVariable=r=>r.status===129&&r.stdout===''&&String(r.stderr).replace(/\r?\n$/,'')==='usage: git var (-l | <variable>)';
// An older git's system file. GIT_CONFIG_NOSYSTEM, read as git reads a boolean (git parses it), turns it off.
// A GIT_CONFIG_SYSTEM this git honours (it names a probe path that does not exist) is that exact file, empty or
// not. Otherwise it is the one `git config --system` reads: its entries name it, and a missing one is named by
// git's read error (recorded absent). An existing file without entries leaves it unknown: refused.
function olderSystemFile(target) {
  const off=process.env.GIT_CONFIG_NOSYSTEM;
  if(off!==undefined) {
    const r=git(target,['-c','kit.nosystem='+off,'config','--bool','--get','kit.nosystem']),err=String(r.stderr).trim(),value=String(r.stdout).trim();
    if(r.status!==0||err||!['true','false'].includes(value)) throw new InputError('GIT_CONFIG_NOSYSTEM',`git config --bool exited ${r.status}${err?': '+oneLine(err):''}`);
    if(value==='true') return [];
  }
  const given=process.env.GIT_CONFIG_SYSTEM;
  if(given!==undefined) {
    const probe=path.join(os.tmpdir(),`kit-system-probe-${randomUUID()}.gitconfig`);
    const r=git(target,['config','--system','--list'],{...listEnv(),GIT_CONFIG_SYSTEM:probe}),named=/^fatal: unable to read config file '(.+)': No such file or directory$/.exec(String(r.stderr).replace(/\r?\n$/,''));
    if(r.status===128&&named&&keyOf(path.resolve(named[1]))===keyOf(probe)) return [exactInput('GIT_CONFIG_SYSTEM',given)];
  }
  const r=git(target,['config','--system','--list','--show-origin','-z']),err=String(r.stderr).replace(/\r?\n$/,'');
  if(r.status===0&&!err) {
    const listed=nulRecords(r.stdout);
    if(!listed.length) throw new InputError('GIT_CONFIG_SYSTEM','an older git without git var GIT_CONFIG_SYSTEM, and the system file has no entries that name it');
    if(listed.length%2) throw new ListError('malformed git config --system --show-origin output');
    return listed.filter((_,i)=>i%2===0).map(origin=>{
      if(!origin.startsWith('file:')) throw new InputError('GIT_CONFIG_SYSTEM',`origin ${JSON.stringify(origin)}`);
      return exactInput('GIT_CONFIG_SYSTEM',origin.slice(5));
    });
  }
  const missing=/^fatal: unable to read config file '(.+)': No such file or directory$/.exec(err);
  if(r.status===128&&r.stdout===''&&missing) return [exactInput('GIT_CONFIG_SYSTEM',missing[1])];
  throw new InputError('GIT_CONFIG_SYSTEM',`git config --system exited ${r.status}${err?': '+oneLine(err):''}`);
}
// Point 2's git inputs, whether git shows them or not: ignore files above the target up to the work tree root and
// every .gitignore in the target that applies (an ignored one included; one inside an ignored folder does not
// apply), info/exclude, the configured or default excludes file, every configuration file git reads, every
// include target (empty or missing included), and the system and global candidates git var names (absent ones
// recorded too). A location that cannot be established exactly raises InputError (fail closed).
function gitInputs(target) {
  // The home folder must be a full path on every platform and whatever git reads: a set XDG_CONFIG_HOME,
  // core.excludesFile or GIT_CONFIG_GLOBAL would otherwise let an empty or relative HOME through unchecked.
  homeBase();
  const inputs=[];
  const top=keyOf(canonicalPathFresh(gitOutput(target,['rev-parse','--show-toplevel']).trim())),atRoot=keyOf(canonicalPathFresh(target))===top;
  for(let dir=canonicalPathFresh(target);keyOf(dir)!==top&&path.dirname(dir)!==dir;) { dir=path.dirname(dir); inputs.push(path.join(dir,'.gitignore')); }
  inputs.push(...gitOutput(target,['rev-parse','--git-path','info/exclude','--git-path','config','--git-path','config.worktree']).split(/\r?\n/).filter(Boolean).map(file=>path.resolve(target,file)));
  const excludes=git(target,['config','--path','--get','core.excludesFile']),excludesError=String(excludes.stderr).trim();
  if(excludesError||![0,1].includes(excludes.status)) throw new ListError(`git config core.excludesFile exited ${excludes.status}${excludesError?': '+oneLine(excludesError):''}`);
  inputs.push(excludes.status===0?exactInput('core.excludesFile',excludes.stdout.trim()):path.join(xdgBase(),'git','ignore'));
  for(const rel of nulRecords(gitOutput(target,['ls-files','-z','--others','--ignored','--exclude-standard','--directory'])))
    if(!rel.endsWith('/')&&path.posix.basename(rel)==='.gitignore') inputs.push(path.join(target,rel));
  const listed=nulRecords(gitOutput(target,['config','--list','--show-origin','-z']));
  if(listed.length%2) throw new ListError('malformed git config --show-origin output');
  for(let i=0;i<listed.length;i+=2) {
    const origin=listed[i].startsWith('file:')?listed[i].slice(5):null;
    // git names a repository's configuration files relative to the work tree root; below it, refused (fail closed).
    if(origin!==null&&!fullPath(origin)&&!atRoot) throw new InputError(`configuration file ${JSON.stringify(origin)}`,'git names it relative to the work tree root, and the target is below that root');
    const from=origin!==null?path.resolve(target,origin):null,[key,...rest]=listed[i+1].split('\n'),value=rest.join('\n');
    if(from) inputs.push(from);
    if(/^include(?:if\..+)?\.path$/i.test(key)&&value) inputs.push(includeTarget(key,value,from));
  }
  for(const name of ['GIT_CONFIG_SYSTEM','GIT_CONFIG_GLOBAL']) {
    const r=git(target,['var',name]),out=String(r.stdout),err=String(r.stderr).trim(),files=out.split(/\r?\n/).filter(Boolean);
    // Status 0, no diagnostic: the full paths git names. Status 1, nothing printed: none (GIT_CONFIG_NOSYSTEM).
    // The unknown-variable answer: an older git; the global files are the env value (if any) and the home ones.
    // Anything else (another status, any diagnostic) is refused.
    if(r.status===0&&!err&&files.length) inputs.push(...files.map(file=>exactInput(name,file)));
    else if(r.status===1&&out===''&&!err) continue;
    else if(unknownVariable(r)) inputs.push(...(name==='GIT_CONFIG_SYSTEM'?olderSystemFile(target):[...(process.env.GIT_CONFIG_GLOBAL?[exactInput(name,process.env.GIT_CONFIG_GLOBAL)]:[]),path.join(homeBase(),'.gitconfig'),path.join(xdgBase(),'git','config')]));
    else throw new InputError(name,`git var ${name} exited ${r.status}${err?': '+oneLine(err):`, printed ${oneLine(out)||'nothing'}`}`);
  }
  return inputs;
}
// How the input walk reads files: from disk, or with the plan's writes applied. A walk over the second view is the
// prediction of the selection the writes leave; it is the same walk (one function serves both), with the plan's
// bytes in place of the disk's for the files the plan writes, and the plan's creations and deletions in the
// .claude/rules listing. `reads`, when given, collects what the walk took from disk (path -> the hash of the bytes it
// used, or the kind of what is not a regular file), so a later prediction can tell whether any of it moved. Both views
// are exported for the listing-order tests only (kit 3.3.6 item 21).
export function diskViewOf(reads) {
  const note=(file,state)=>{ reads?.set(file,state); };
  return {
    exists(file) {
      let isFile=false;
      try { isFile=fs.statSync(file).isFile(); } catch {}
      if(!isFile) { let kind='unreadable'; try { kind=scopeEntry(file).kind; } catch {} note(file,kind); }
      return isFile;
    },
    load(file) {
      const real=fs.realpathSync(file);
      let bytes=null;
      return {real,text:()=>{ bytes??=fs.readFileSync(real); note(file,sha(bytes)); return bytes.toString('utf8'); }};
    },
    // Kit 3.3.6 item 21: sorted, so the walk meets aliases of one file in the same order in every listing.
    list(dir) { try { return fs.readdirSync(dir).sort(); } catch { return []; } },
  };
}
const diskView=diskViewOf();
// `writes` is every file the plan writes, as [path, planned bytes] (null for a delete); `check` resolved each one. A
// file the plan does not write is read from disk; a change to one during the run is named by the scope comparison
// after the writes.
export function plannedView(writes,check,reads) {
  const disk=diskViewOf(reads),planned=new Map(writes.map(([file,bytes])=>[check.resolved.get(file),bytes]));
  const plannedBytes=file=>{ try { return planned.get(keyOf(canonicalPathFresh(file))); } catch { return undefined; } };
  return {
    exists(file) { const bytes=plannedBytes(file); return bytes===undefined?disk.exists(file):bytes!==null; },
    load(file) { const bytes=plannedBytes(file); return bytes===undefined?disk.load(file):{real:canonicalPathFresh(file),text:()=>bytes.toString('utf8')}; },
    // The names a folder holds after the writes: those on disk, plus the plan's creations, minus its deletions.
    list(dir) {
      const names=new Set(disk.list(dir));
      let here;
      try { here=keyOf(canonicalPathFresh(dir)); } catch { return [...names]; }
      for(const [file,bytes] of writes) {
        let parent;
        try { parent=keyOf(canonicalPathFresh(path.dirname(file))); } catch { continue; }
        if(parent!==here) continue;
        const name=path.basename(file);
        for(const present of names) if(keyOf(present)===keyOf(name)) names.delete(present);
        if(bytes!==null) names.add(name);
      }
      return [...names].sort();
    },
  };
}
// Point 2's host configuration, relative to the target unless an instruction file imports something elsewhere;
// from a linked worktree, also the main checkout's receipt and local settings (lib.mjs reads them there). The
// configuration's own names, the .claude/rules listing and the instruction walk are all read through `view`.
function hostInputs(plan,view=diskView) {
  const target=plan.target,file=rel=>path.join(target,rel);
  const inputs=['KIT.local.json','KIT.json','MANIFEST.json','memory.config.json','recall-probes.json','upgrades.json','enforce-rules.json','enforce-rules.kit.json','.gitignore']
    .map(name=>file('scripts/memory/'+name)).concat(['AGENTS.md','CLAUDE.md','CLAUDE.local.md','.claude/settings.json','.claude/settings.local.json'].map(file));
  let config={};
  const configFile=file('scripts/memory/memory.config.json');
  try { if(view.exists(configFile)) config=JSON.parse(view.load(configFile).text().replace(/^\uFEFF/,'')); } catch {}
  for(const value of [config.caps?.guard?.rules,config.caps?.guard?.kitRules,config.caps?.agents?.path]) if(typeof value==='string') inputs.push(path.resolve(target,value));
  for(const name of view.list(file('.claude/rules'))) if(name.endsWith('.md')) inputs.push(file('.claude/rules/'+name));
  inputs.push(...instructionPaths(target,view));
  if(plan.worktree) for(const name of ['KIT.json','KIT.local.json']) inputs.push(path.join(plan.worktree,'scripts/memory',name));
  return inputs;
}
// The instruction files install-safety.mjs:15-27 reads, found the same way but kept by the path that names them:
// an import's own spelling (so a link keeps its identity next to its referent) and a missing reference (absent).
function instructionPaths(target,view=diskView) {
  const seen=new Set(),found=[];
  const visit=file=>{
    found.push(file);
    if(!view.exists(file)) return;
    const {real,text}=view.load(file);
    if(seen.has(real)) return;
    seen.add(real);
    const content=text();
    for(const pattern of [/(?:^|\s)@([^\s`<>"()]+)/gm,/(?:@|\]\(|`)([^\s`<>"()]+\.md)\b/g]) for(const m of content.matchAll(pattern)) {
      const relative=path.resolve(path.dirname(real),m[1]),rooted=path.resolve(target,m[1]);
      visit(view.exists(relative)?relative:rooted);
    }
  };
  for(const name of ['AGENTS.md','CLAUDE.md','CLAUDE.local.md']) visit(path.join(target,name));
  try { for(const name of view.list(path.join(target,'.claude/rules'))) if(name.endsWith('.md')) visit(path.join(target,'.claude/rules',name)); } catch {}
  return found;
}
// The file a path reaches (its canonical path) and, when the path itself is a link, the link under its own path.
function referentAndLink(file,exact) {
  let real;
  try { real=exact?.get(file)??canonicalPathFresh(file); } catch(error) { throw new ListError(`cannot resolve ${file} (${error.code??'error'})`); }
  const pairs=[[keyOf(real),real]];
  let stat=null;
  try { stat=fs.lstatSync(file); } catch {}
  if(stat?.isSymbolicLink()) { const own=path.join(exact?.get(path.dirname(file))??canonicalPathFresh(path.dirname(file)),path.basename(file)); pairs.push([keyOf(own),own]); }
  return pairs;
}
// Point 3, fixed for the run: every planned destination and the hook location.
function scopeExtras(plan,check) {
  const files=plan.destinations.filter(d=>d.kind!=='backup').map(d=>d.path);
  if(plan.hook.location) files.push(plan.hook.location);
  return files.flatMap(file=>referentAndLink(file,check.exact));
}
function scopeEntry(file) {
  let stat;
  try { stat=fs.lstatSync(file); } catch(error) { if(['ENOENT','ENOTDIR'].includes(error.code)) return {kind:'absent'}; throw error; }
  if(stat.isSymbolicLink()) {
    let directory=false;
    try { directory=fs.statSync(file).isDirectory(); } catch {}
    return {kind:'link',to:fs.readlinkSync(file),directory};
  }
  if(stat.isDirectory()) return {kind:'directory'};
  // Any write changes ctime, so an unchanged stamp means unchanged bytes.
  if(stat.isFile()) return {kind:'file',stamp:[stat.size,stat.mtimeMs,stat.ctimeMs,stat.ino,stat.mode].join(':'),mode:stat.mode};
  return {kind:'other'};
}
// Every path in scope now: Map key -> {path, scope}. `skip` is this run's backup folder once it exists.
// With `lenient` (recovery), a listing failure leaves out only what git would have listed. With `predict` (the first
// listing and the snapshot: {files, hook, reads} from plannedViews, views of the state after the plan's writes, the
// second one after the hook too), the result also holds `predicted`, the input selection those writes leave (the
// two phases, and `reads`, what the prediction took from disk), and lists it in the scope as well.
function inventory(plan,mode,extra,skip,{lenient=false,predict=null}={}) {
  const found=new Map(),target=canonicalPathFresh(plan.target),memory=canonicalPathFresh(plan.memory);
  const targetKey=keyOf(target),memoryKey=keyOf(memory),skipKey=skip?keyOf(canonicalPathFresh(skip)):null;
  const skipped=key=>skipKey!==null&&contains(skipKey,key);
  // Lock files are left out only inside memory (S1 point 4); elsewhere such a name is an ordinary file. E2.8 (c): the
  // one exclusion every insertion goes through (destinations, inputs, the memory walk, git-visible files of an in-repo
  // memory, the project walk): a lock file, or anything under a lock-named folder, inside memory.
  const memoryLock=key=>contains(memoryKey,key)&&key!==memoryKey&&isLockPath(key.slice(memoryKey.length));
  const add=(key,file,scope)=>{ if(!memoryLock(key)&&!found.has(key)) found.set(key,{path:file,scope}); };
  const walk=(dir,real,scope,{nested=false}={})=>{
    let list;
    try { list=fs.readdirSync(dir,{withFileTypes:true}); } catch(error) { if(['ENOENT','ENOTDIR'].includes(error.code)) return; throw error; }
    for(const entry of list) {
      const file=path.join(dir,entry.name),inner=path.join(real,entry.name),key=keyOf(inner);
      if(memoryLock(key)||skipped(key)) continue;
      if(entry.isDirectory()&&nested&&fs.existsSync(path.join(file,'.git'))) continue;
      add(key,file,scope);
      if(entry.isDirectory()) walk(file,inner,scope,{nested});
    }
  };
  const listed=run=>{ try { return run(); } catch(error) { if(lenient&&error instanceof ListError) return []; throw error; } };
  // Point 3 first, then point 2 (an input outside the target and memory is validation-only), point 4, point 1.
  for(const [key,file] of extra) add(key,file,'destination');
  const hostList=hostInputs(plan),gitList=mode==='git'?listed(()=>gitInputs(plan.target)):[];
  // The effective selection of inputs: every input path as the entries it names (a link and its referent).
  const select=host=>{
    const chosen=new Map();
    for(const input of [...host,...gitList]) for(const [key,file] of listed(()=>referentAndLink(input))) chosen.set(key,file);
    return chosen;
  };
  found.inputs=select(hostList);
  // What the plan's writes leave: the same walk over the planned state. Git's inputs are taken as they are now.
  if(predict) found.predicted={files:select(hostInputs(plan,predict.files)),hook:predict.hook?select(hostInputs(plan,predict.hook)):null,reads:predict.reads};
  for(const chosen of [found.inputs,found.predicted?.files,found.predicted?.hook]) if(chosen) for(const [key,file] of chosen) add(key,file,contains(targetKey,key)||contains(memoryKey,key)?'config':'external');
  add(memoryKey,memory,'memory');walk(plan.memory,memory,'memory');
  if(mode==='git') { for(const rel of listed(()=>gitVisible(plan.target))) { const key=keyOf(path.join(target,rel)); if(!skipped(key)) add(key,path.join(plan.target,rel),'project'); } }
  else walk(plan.target,target,'project',{nested:true});
  return found;
}
// Every file the plan writes, as [path, planned bytes] (null for a delete), in plan order; the hook is not one of them.
const plannedWrites=plan=>[...plan.projectChanges.map(c=>[path.join(plan.target,c.file),c.bytes]),...plan.memoryChanges.map(c=>[path.join(plan.memory,c.file),c.bytes])];
// The views of the state after the plan's writes (project and memory files, then the hook, the last write), and the
// `reads` both of them fill: what a prediction took from disk.
function plannedViews(plan,check) {
  const reads=new Map(),writes=plannedWrites(plan);
  return {files:plannedView(writes,check,reads),hook:plan.hook.change?plannedView([...writes,[plan.hook.hook,plan.hook.next]],check,reads):null,reads};
}
// The first difference between two predictions, the one made with the first plan and the one made under the lock. It
// names a path, or is null. In order: a file both predictions read whose state changed (the file to name), then an
// input in one selection and not the other (either phase), then a file only one of them read.
function predictionDifference(first,now) {
  const keys=[...new Set([...first.reads.keys(),...now.reads.keys()])].sort();
  const changed=keys.find(key=>first.reads.has(key)&&now.reads.has(key)&&first.reads.get(key)!==now.reads.get(key));
  if(changed) return changed;
  for(const phase of ['files','hook']) {
    const [before,after]=[first[phase]??new Map(),now[phase]??new Map()];
    for(const key of [...new Set([...before.keys(),...after.keys()])].sort()) if(!before.has(key)||!after.has(key)) return before.get(key)??after.get(key);
  }
  return keys.find(key=>first.reads.get(key)!==now.reads.get(key))??null;
}
// A prediction under the lock that is not the one made with the first plan: an outside writer changed an input
// between them (it is refused with the lock-time message of applyUpgrade, before any write).
class PredictionDrift extends Error { constructor(file) { super(file); this.file=file; } }
// The snapshot covers the first listing's inventory and whatever the listing under the lock adds (S2), and the
// input selection the plan's writes will leave (so an input that only the writes reach has a state to compare).
// That prediction is made again here, under the lock and before any write, and compared with the first listing's
// (made with the first plan); the one kept is the one that passed. A listing failure here does not throw: the
// snapshot keeps `listError`, and the run takes the later-error path.
function takeSnapshot(plan,check,listing) {
  const extra=scopeExtras(plan,check),{mode}=listing,predict=plannedViews(plan,check);
  const dir=scratch('kit-upgrade-scope-',[plan.target,plan.memory]);
  try {
    let current,listError=null;
    try { current=inventory(plan,mode,extra,null,{predict}); }
    catch(error) { if(!(error instanceof ListError)) throw error; listError=error; current=inventory(plan,mode,extra,null,{lenient:true,predict}); }
    // A partial listing (an error under the lock) takes the later-error path below; a whole one must predict what the first did.
    const moved=listError||!listing.initial.predicted?null:predictionDifference(listing.initial.predicted,current.predicted);
    if(moved) throw new PredictionDrift(moved);
    const entries=new Map();
    let n=0;
    for(const [key,{path:file,scope}] of new Map([...listing.initial,...current])) {
      const entry={path:file,scope,...scopeEntry(file)};
      if(entry.kind==='other'&&!listError) listError=new SpecialError(file);
      // Kit 3.3.6 item 23: a file outside the project and memory (scope external) is compared, never written or
      // restored, so it keeps a digest instead of a copy in the temporary folder.
      if(entry.kind==='file'&&scope==='external') entry.digest=sha(fs.readFileSync(file));
      else if(entry.kind==='file') { entry.copy=path.join(dir,String(n++)); fs.copyFileSync(file,entry.copy); }
      entries.set(key,entry);
    }
    // `inputs` is the selection before the writes (both listings); `drift` holds what the two listings did not agree
    // on, which only an outside writer between them can cause; `predicted` is the selection the writes leave.
    const drift=new Map([...listing.initial.inputs].filter(([key])=>!current.inputs.has(key)).concat([...current.inputs].filter(([key])=>!listing.initial.inputs.has(key))));
    return {dir,entries,extra,mode,skip:null,listError,inputs:new Map([...listing.initial.inputs,...current.inputs]),drift,predicted:current.predicted};
  } catch(error) {
    // Kit 3.3.6 item 9: the real error (a copy failure, the drift refusal) is thrown; a failed removal is only named.
    removeQuietly(dir); throw error;
  }
}
const contentOf=entry=>entry.kind==='file'?(entry.digest??sha(fs.readFileSync(entry.copy??entry.path))):entry.kind==='link'?'link:'+entry.to:entry.kind;
const sameEntry=(a,b)=>a.kind===b.kind&&(a.kind==='file'?a.stamp===b.stamp:a.kind!=='link'||a.to===b.to);
const folderOnly=change=>['absent','directory'].includes(change.before.kind)&&['absent','directory'].includes(change.now.kind);
// Every scope entry that is no longer what the snapshot recorded, in key order (a folder before its files). The
// kept inventory (the snapshot's keys) is always compared, whatever git lists now.
function scopeChanges(plan,snapshot,options) {
  const now=new Map(),listed=inventory(plan,snapshot.mode,snapshot.extra,snapshot.skip,options);
  for(const [key,{path:file,scope}] of listed) now.set(key,{path:file,scope,...scopeEntry(file)});
  for(const [key,entry] of snapshot.entries) if(!now.has(key)) now.set(key,{path:entry.path,scope:entry.scope,...scopeEntry(entry.path)});
  const changes=[];
  for(const key of [...now.keys()].sort()) {
    const entry=now.get(key),before=snapshot.entries.get(key)??{kind:'absent',path:entry.path,scope:entry.scope};
    if(!sameEntry(before,entry)) changes.push({key,path:before.path,scope:before.scope,before,now:entry});
  }
  return {now,changes,inputs:listed.inputs};
}
// Statement 22: the scope changed exactly as planned. `expected` maps a destination's key to its path and
// planned content ('absent' or the SHA-256 of the planned bytes); keys in `skip` are not checked yet. `selection` is
// the input selection the writes done so far were predicted to leave (snapshot.predicted: the prediction that was
// compared with the first plan's under the lock, before the first write).
function verifyScope(plan,snapshot,expected,skip,selection) {
  const {now,changes,inputs}=scopeChanges(plan,snapshot),differing=[];
  // The effective selection of point-2 inputs is compared on its own, with the plan's prediction and not with the
  // selection before the writes (the writes can change it): an input added or dropped that the prediction does not
  // hold is a difference. So is any input the two listings before the writes did not agree on.
  for(const [key,file] of inputs) if(!selection.has(key)) differing.push(file);
  for(const [key,file] of selection) if(!inputs.has(key)) differing.push(file);
  differing.push(...snapshot.drift.values());
  for(const change of changes) {
    if(skip.has(change.key)||expected.has(change.key)||folderOnly(change)) continue;
    if(contentOf(change.now)!==contentOf(change.before)) differing.push(change.path);
  }
  for(const [key,{file,want}] of expected) {
    if(skip.has(key)) continue;
    const entry=now.get(key)??{kind:'absent'};
    if((entry.kind==='file'?sha(fs.readFileSync(entry.path)):entry.kind)!==want) differing.push(file);
  }
  if(differing.length) throw new PlanDifference(differing);
}
// S3: before any destructive step, every state the rollback would overwrite or remove, unless it is exactly
// what the plan wrote, is kept under <backup>/unplanned with a generated ID and a manifest entry; a folder is
// kept whole. Every write is checked first: the backup must still resolve to `authorised` (its canonical path when
// it was created, so a folder above it swapped for a link is caught), every folder from the backup down to the
// destination must be a real folder, not a link, and the destination's folder must resolve inside `authorised`.
// Nothing is overwritten.
function preserveStates(backup,authorised,changes,expected) {
  const kept=[];
  for(const change of changes) {
    const {before,now}=change,planned=expected.get(change.key);
    if(now.kind==='absent') { if(before.kind!=='absent') kept.push({change,type:'absent'}); continue; }
    if(now.kind==='directory') { if(!['directory','absent'].includes(before.kind)) kept.push({change,type:'directory'}); continue; }
    if(now.kind==='file'&&planned&&sha(fs.readFileSync(now.path))===planned.want) continue;
    kept.push({change,type:now.kind});
  }
  if(!kept.length) return null;
  const root=path.join(backup,'unplanned'),refuse=reason=>{ throw new Error('refusing to keep unplanned states: '+reason); };
  const guard=dest=>{
    if(keyOf(canonicalPathFresh(backup))!==keyOf(authorised)) refuse(`${backup} no longer resolves to ${authorised}`);
    for(let dir=path.dirname(dest);;dir=path.dirname(dir)) {
      const stat=fs.lstatSync(dir);
      if(stat.isSymbolicLink()||!stat.isDirectory()) refuse(`${dir} is a link or not a folder`);
      if(dir===backup) break;
      if(path.dirname(dir)===dir) refuse(`${dest} is outside ${backup}`);
    }
    if(!contains(keyOf(authorised),keyOf(canonicalPathFresh(path.dirname(dest))))) refuse(`${dest} resolves outside ${authorised}`);
  };
  guard(root);
  try { fs.mkdirSync(root); } catch(error) { if(error.code!=='EEXIST') throw error; }
  guard(path.join(root,'x'));
  const keep=(file,data)=>{ guard(file); fs.writeFileSync(file,data,{flag:'wx'}); if(!fs.readFileSync(file).equals(data)) throw new Error('kept bytes differ: '+file); return sha(data); };
  const copyFolder=(from,to,rel='',contents=[])=>{
    guard(to);fs.mkdirSync(to);
    for(const entry of fs.readdirSync(from,{withFileTypes:true})) {
      const source=path.join(from,entry.name),dest=path.join(to,entry.name),inner=rel?rel+'/'+entry.name:entry.name;
      if(entry.isSymbolicLink()) contents.push({path:inner,type:'link',...linkState(source)});
      else if(entry.isDirectory()) { contents.push({path:inner,type:'directory',mode:fs.lstatSync(source).mode}); copyFolder(source,dest,inner,contents); }
      else if(entry.isFile()) contents.push({path:inner,type:'file',sha256:keep(dest,fs.readFileSync(source)),mode:fs.lstatSync(source).mode});
      else contents.push({path:inner,type:'other',mode:fs.lstatSync(source).mode});
    }
    return contents;
  };
  const entries=[];
  for(const {change,type} of kept) {
    const id=randomUUID(),record={id,path:change.path,scope:change.scope,type,before:change.before.kind};
    if(type==='file') { record.sha256=keep(path.join(root,id),fs.readFileSync(change.now.path)); record.mode=change.now.mode; }
    else if(type==='link') Object.assign(record,linkState(change.now.path));
    else if(type==='directory') { record.mode=fs.lstatSync(change.now.path).mode; record.contents=copyFolder(change.now.path,path.join(root,id)); }
    else if(type==='other') record.mode=fs.lstatSync(change.now.path).mode;
    entries.push(record);
  }
  const manifest=path.join(root,`manifest-${randomUUID()}.json`);
  keep(manifest,Buffer.from(JSON.stringify({entries},null,2)+'\n'));
  return {root,manifest};
}
// What a kept link needs to be made again: its target text, whether that target is a folder or a file (or is
// missing), and the link's own mode.
function linkState(file) {
  let linkType='missing';
  try { linkType=fs.statSync(file).isDirectory()?'directory':'file'; } catch {}
  return {target:fs.readlinkSync(file),linkType,mode:fs.lstatSync(file).mode};
}
// Puts every changed scope entry back as the snapshot recorded it, after keeping what it replaces (S3), then
// checks that nothing is left different. Validation-only inputs are never written.
function rollbackScope(plan,snapshot,expected,backup,authorised) {
  const restorable=change=>change.scope!=='external'&&change.now.scope!=='external';
  const changes=scopeChanges(plan,snapshot,{lenient:true}).changes.filter(restorable);
  const kept=preserveStates(backup,authorised,changes,expected);
  // What should not be there: anything created, and an entry replaced by another kind or another link target.
  for(const {before,now} of changes) {
    if(['file','link','other'].includes(now.kind)&&(before.kind!==now.kind||before.kind==='link')) fs.rmSync(now.path,{force:true});
    else if(now.kind==='directory'&&!['directory','absent'].includes(before.kind)) fs.rmSync(now.path,{recursive:true,force:true});
  }
  for(const {before} of changes) {
    if(before.kind==='directory') fs.mkdirSync(before.path,{recursive:true});
    else if(before.kind==='file') { writeBytes(before.path,fs.readFileSync(before.copy)); if(process.platform!=='win32') fs.chmodSync(before.path,before.mode&0o7777); }
    else if(before.kind==='link') fs.symlinkSync(before.to,before.path,before.directory?(process.platform==='win32'?'junction':'dir'):'file');
  }
  for(const {before,now} of changes.toReversed()) if(before.kind==='absent'&&now.kind==='directory') try { fs.rmdirSync(now.path); } catch {}
  // Every entry it acted on is checked again; a path that only became visible now (S2, hidden additions) is left alone.
  const left=changes.find(change=>{ const now=scopeEntry(change.path); return !folderOnly({before:change.before,now})&&contentOf({...now,path:change.path})!==contentOf(change.before); });
  if(left) throw new Error('rollback left '+left.path+' different');
  return kept;
}
// Each write is one planned operation with its planned bytes; nothing is recomputed while writing.
function writeBytes(file,data) { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,data); }
function applyChanges(root,changes,after=()=>{}) {
  let count=0;
  for(const {file,bytes} of changes) {
    const dest=inside(root,file);
    if(bytes===null) { if(fs.existsSync(dest)) fs.unlinkSync(dest); }
    else writeBytes(dest,bytes);
    after(++count,file);
  }
}
// The hook refresh writes the planned text (hookText, as install-hooks.mjs would) to the checked hook path.
function refreshHook(plan,hooks) {
  try {
    writeBytes(plan.hook.hook,plan.hook.next);
    if(process.platform!=='win32') fs.chmodSync(plan.hook.hook,0o755);
    hooks.afterHook?.();
    if(!fs.readFileSync(plan.hook.hook).equals(plan.hook.next)) throw Error('hook bytes differ');
  } catch { throw new PlanDifference(plan.hook.hook); }
}
// Statement 22: gate, scope snapshot, durable backup, the planned writes, gate, comparison, the hook, comparison.
// `listing` is the first (unlocked) listing: its mode ('git' or 'tree') and inventory, kept for the run (S2).
function execute(plan,opts,root,{afterCopy=()=>{},afterMigrate=()=>{},afterHook,afterSnapshot},check,listing) {
  const {resolved}=check;
  // Only a run that changes nothing skips the backup (statement 14's no-op).
  if(!plan.backup) { console.log('upgrade: same version and hashes; no-op');return 0; }
  const {target,engine,memory,version}=plan;
  const before=gateFailures(target,memory),prior=new Set(before.map(failKey));
  for(const f of before) console.log(`pre-existing FAIL ${f.check} ${f.file}: ${f.message}`);
  const listed=!plan.same&&!plan.memoryOnly?newCheckFailures(root,target,memory,plan.mergedConfig):[];
  const listedPrior=new Set(listed.map(newFailKey));
  for(const f of listed) console.log(`pre-existing FAIL (new check in ${version}) ${f.check} ${f.file}: ${f.message}`);
  for(const line of plan.runLog) console.log(line);
  let snapshot;
  try { snapshot=takeSnapshot(plan,check,listing??firstListing(plan,check)); }
  catch(error) {
    if(error instanceof PredictionDrift) return planDrift(error.file);
    if(error instanceof ListError) { console.error(`upgrade: ${listReason(error)}; stopped under the memory lock before the first write`);return 1; }
    throw error;
  }
  afterSnapshot?.(snapshot);
  // What the plan writes, by destination key; the hook joins it as the last write (statement 22, step 3).
  const expected=new Map(plannedWrites(plan).map(([file,bytes])=>[resolved.get(file),{file,want:bytes===null?'absent':sha(bytes)}]));
  const hookKey=plan.hook.change?resolved.get(plan.hook.hook):null;
  if(plan.hook.change) expected.set(hookKey,{file:plan.hook.hook,want:sha(plan.hook.next)});
  let keepSnapshot=false;
  try {
    const {backup,authorised,recovery,files,created,saveRecovery}=writeBackup(plan,before);
    snapshot.skip=backup;
    // A real first update keeps its sorting report in the backup folder (statement 10).
    const reportPath=!plan.memoryOnly&&plan.instructions.report?path.join(backup,'instructions-report.json'):null;
    if(reportPath) fs.writeFileSync(reportPath,JSON.stringify(plan.instructions.report,null,2)+'\n');
    console.log('upgrade backup: '+backup);
    try {
      // A listing failure under the lock is a later failure (S2): recovery runs with the kept inventory.
      if(snapshot.listError) throw snapshot.listError;
      // Step 1: exactly the planned project and memory writes, in plan order.
      applyChanges(target,plan.projectChanges,afterCopy);
      applyChanges(memory,plan.memoryChanges);
      // As in 3.3.3, the map also names any other file that appeared in memory, so a restore removes it too.
      const present=fs.readdirSync(memory,{withFileTypes:true}).filter(e=>e.isFile()&&!isLockName(e.name)&&!files.includes(e.name)).map(e=>e.name);
      recovery.memory.created=[...new Set([...created,...present])];
      saveRecovery();
      for(const line of plan.memoryLog) console.log(line);
      if(plan.migration) afterMigrate();
      const after=gateFailures(target,memory),added=after.filter(f=>!prior.has(failKey(f))&&!listedPrior.has(newFailKey(f)));
      if(added.length) throw new Error('new FAIL: '+added.map(f=>f.check+' '+f.file+': '+f.message).join('; '));
      // Step 2: every change in the scope is a planned one, with the planned bytes.
      verifyScope(plan,snapshot,expected,new Set([hookKey]),snapshot.predicted.files);
      // Step 3: the hook is the last write, outside the gate; then the whole scope is compared once more.
      if(plan.hook.change) {
        refreshHook(plan,{afterHook});
        verifyScope(plan,snapshot,expected,new Set(),snapshot.predicted.hook);
      }
      // Statement 14: the same-version path (lock line, hook) ends with the unchanged no-op line.
      if(plan.noop&&!plan.memoryOnly) { console.log('upgrade: same version and hashes; no-op');return 0; }
      upgradeHints(root,target,memory);
      if(reportPath) for(const line of instructionsReportLines(root,plan.instructions,reportPath,opts)) console.log(line);
      if(plan.memoryOnly) { console.log(`upgrade: memory replay complete (${plan.memoryChanges.length} memory files changed)`);return 0; }
      const listedCount=after.filter(f=>listedPrior.has(newFailKey(f))).length;
      console.log(`upgrade: complete (${after.length} pre-existing FAIL remain${listedCount?`, ${listedCount} of them from checks new in ${version}`:''})`);return 0;
    } catch(e) {
      // A later listing failure, like any other failure here, enters recovery with the kept inventory (S2).
      const reason=e instanceof ListError?listReason(e):e.message;
      const command=`scripts/upgrade.mjs --target "${target}" --restore "${backup}"${plan.isLive?' --live-memory':` --memory-dir "${memory}"`}`;
      try {
        const kept=rollbackScope(plan,snapshot,expected,backup,authorised);
        const tail=kept?`; the states it replaced are kept in ${kept.root} (manifest ${kept.manifest})`:'';
        console.error(e instanceof PlanDifference?`upgrade: ${e.message}; restored ${backup}${tail}`:`upgrade: restored ${backup}: ${reason}${tail}`);
      }
      catch(failure) {
        keepSnapshot=true;
        console.error(`upgrade: rollback failed: ${failure.message}; backup: ${backup}; run ${command}; every original in the scope is kept in ${snapshot.dir}; original: ${reason}`);
      }
      return 1;
    }
    // Kit 3.3.6 item 9: a snapshot folder that cannot be removed is named on stderr; the result (0 after a verified
    // update, 1 after a rollback) stands.
  } finally { if(!keepSnapshot) removeQuietly(snapshot.dir); }
}
const listRefusal=error=>`upgrade: ${listReason(error)}; nothing written`;
// The refusal for a change between the first plan and the lock (the plans, the destinations' resolution and the
// prediction of the input selection are all compared there); one message, one exit, whichever comparison finds it.
const planDrift=file=>{ console.error(`upgrade: memory or project files changed while planning (${file}); nothing written; run again`);return 1; };
// S2: the first listing, made before the lock; it fixes the listing mode and the inventory kept for the run. It also
// holds the prediction of the input selection the plan's writes leave (`initial.predicted`), made with the first plan:
// the files it reaches are in the inventory, so a special file among them is refused here, before any write.
function firstListing(plan,check) {
  const mode=projectMode(plan.target),initial=inventory(plan,mode,scopeExtras(plan,check),null,{predict:plannedViews(plan,check)});
  for(const {path:file} of initial.values()) if(scopeEntry(file).kind==='other') throw new SpecialError(file);
  return {mode,initial};
}
// The durable backup: the original of every planned project file and the memory files, and a recovery map that
// names every planned creation and the hook before the first write, so a restore after a crash undoes them.
function writeBackup(plan,failuresBefore) {
  const {target,engine,memory}=plan;
  // Kit 3.3.6 item 6: every original is kind-checked and read before the backup folder is made, so a refusal leaves
  // no partial backup.
  const originals=plan.projectChanges.map(({file})=>({file,data:bytesOf(checked(inside(target,file)))}));
  const regular=fs.readdirSync(memory,{withFileTypes:true}).filter(e=>e.isFile()&&!isLockName(e.name)).map(e=>e.name);
  // A planned page may be a link the checks allowed (inside the rehearsal folder); its original bytes, the
  // referent's, are saved under its name, and a restore writes them back through the link.
  const linked=plan.memoryChanges.map(c=>c.file).filter(file=>!regular.includes(file)&&bytesOf(checked(path.join(memory,file)))!==null);
  const files=[...regular,...linked];
  const created=plan.memoryChanges.filter(c=>c.bytes!==null&&!files.includes(c.file)&&bytesOf(checked(path.join(memory,c.file)))===null).map(c=>c.file);
  const backup=backupDirectory(engine),authorised=canonicalPathFresh(backup);
  for(const {file,data} of originals) if(data!==null) write(inside(backup,file),data);
  for(const file of files) write(path.join(backup,'memory',file),fs.readFileSync(path.join(memory,file)));
  const recovery={files:originals.map(({file,data})=>({file,existed:data!==null})),failuresBefore,memory:{dir:memory,files,created}};
  if(plan.hook.change) recovery.hook={path:canonicalPathFresh(plan.hook.hook),existed:true,bytes:plan.hook.current.toString('base64'),mode:plan.hook.mode};
  const saveRecovery=()=>{
    const pending=path.join(backup,'restore.json.tmp');
    fs.writeFileSync(pending,JSON.stringify(recovery,null,2)+'\n',{flush:true});
    fs.renameSync(pending,path.join(backup,'restore.json'));
  };
  saveRecovery();
  return {backup,authorised,recovery,files,created,saveRecovery};
}
function applyUpgrade(opts,root,hooks) {
  const plan=makePlan(opts,root,false,hooks);
  if(!plan.memoryOnly) for(const line of plan.log) console.log(line);
  if(plan.refusals.length) throw Error(plan.refusals.join('\n'));
  if(plan.instructionRefusal) throw Error(plan.instructionRefusal);
  if(newer(plan.receipt.version,plan.version)) throw new Error('Refusing a downgrade');
  if(plan.memoryOnlyRefusal) { console.error(plan.memoryOnlyRefusal);return 1; }
  if(opts['live-memory']&&plan.worktree) { console.error(liveFlagRefusal(plan,opts));return 1; }
  if(plan.pending) { console.log(`upgrade: project files are at kit ${plan.version}, but memory is not: ${plan.pending}`);console.log(replayLine(plan));return 3; }
  if(plan.memoryMissing) throw new Error('memory dir not found');
  if(plan.memoryError) { console.error(memoryRefusal(plan));return 1; }
  if(plan.hook.reason&&plan.worktree) console.log('HOOK not refreshed: '+plan.hook.reason);
  if(plan.hook.warn) console.log(plan.hook.warn);
  const refusal=liveFlagRefusal(plan,opts);
  if(refusal) { console.error(refusal);return 1; }
  const first=safety(plan,opts);
  if(first.error||first.refusal) { console.error(first.error??first.refusal);return 1; }
  // E2.8 (a): before the first write, in the folder the lock will be taken in; again under both locks below.
  const claims=claimsRefusal(plan,opts,first.lock);
  if(claims) { console.error(claims);return 1; }
  // S2: a run that writes lists the project files before the lock; a failure refuses here.
  let listing=null;
  if(plan.backup) {
    try { listing=firstListing(plan,first); }
    catch(error) { if(error instanceof ListError) { console.error(listRefusal(error));return 1; } throw error; }
  }
  if(plan.worktreeError) { console.error(plan.worktreeError);return 1; }
  hooks.afterPlan?.(plan);
  // The lock goes in the memory folder as the first check resolved it: a link retargeted since then cannot
  // move the lock file; the second resolution below still compares every path.
  return withMemoryLock(first.lock,()=>withPushLock(first.lock,()=>{
    // Distribution is checked again once the lock is held, as before 3.3.4.
    const refusedNow=distributionRefusals(plan.target,root,readJSON(checked(path.join(plan.engine,'MANIFEST.json'))));
    if(refusedNow.length) throw Error(refusedNow.join('\n'));
    // Statement 21 under the lock: plan again, resolve again (no cache), compare, and only then write.
    const again=makePlan(opts,root,true,hooks);
    if(again.instructionRefusal) throw Error(again.instructionRefusal);
    if(again.worktreeError) { console.error(again.worktreeError);return 1; }
    // Whether the target is a linked worktree is part of the plan: a change under the lock is drift (it is
    // compared first, since a new worktree can also move where memory resolves).
    if(String(again.worktree??'')!==String(plan.worktree??'')) { console.error(`upgrade: memory or project files changed while planning (linked worktree state of ${again.target}); nothing written; run again`);return 1; }
    if(again.memoryError) { console.error(memoryRefusal(again));return 1; }
    const second=safety(again,opts);
    const drift=planDrift;
    if(second.error) { console.error(second.error);return 1; }
    const moved=resolvedDifference(again.destinations,first.resolved,second.resolved);
    if(moved) return drift(moved);
    const changed=planDifference(plan,again);
    if(changed) return drift(changed);
    if(second.refusal) { console.error(second.refusal);return 1; }
    // E2.8 (a): under both locks, just before the first write; no ledger changes while the memory lock is held.
    const claimsNow=claimsRefusal(again,opts,first.lock);
    if(claimsNow) { console.error(claimsNow);return 1; }
    return execute(again,opts,root,hooks,second,listing);
  }));
}

// ---- Restore: an undo is checked like any write (statement 23). ----
// The plan reads the recovery map and every byte the restore would write, with a fingerprint of each; a real
// restore makes it again under the memory lock, compares, and writes only what the second plan holds.
function restorePlan(opts) {
  const target=path.resolve(opts.target),backup=path.resolve(opts.restore),map=path.join(backup,'restore.json');
  const text=fs.readFileSync(map),recovery=JSON.parse(text);
  if(!Array.isArray(recovery.files)) throw new Error('invalid restore.json files');
  // Each entry names a file and says whether it existed; anything else could turn a restore into a delete.
  for(const e of recovery.files) if(!e||typeof e!=='object'||typeof e.file!=='string'||typeof e.existed!=='boolean') throw new Error('invalid restore.json files entry '+JSON.stringify(e));
  const destinations=[],writes=[],fingerprint=new Map([[map,sha(text)]]);
  const restoreOf=(file,kind,line)=>destinations.push({path:file,kind,label:'restore',line});
  const original=file=>{ const data=fs.readFileSync(file); fingerprint.set(file,sha(data)); return data; };
  for(const e of recovery.files) {
    const dest=inside(target,e.file);
    restoreOf(dest,'project',(e.existed?'RESTORE ':'RESTORE DELETE ')+slash(e.file));
    writes.push({file:dest,data:e.existed?original(inside(backup,e.file)):null});
  }
  const memory=recovery.memory?path.resolve(recovery.memory.dir):null;
  if(memory) {
    if(!Array.isArray(recovery.memory.files)||!recovery.memory.files.every(file=>typeof file==='string')) throw new Error('invalid restore.json memory files');
    if(recovery.memory.created!==undefined&&(!Array.isArray(recovery.memory.created)||!recovery.memory.created.every(file=>typeof file==='string'))) throw new Error('invalid restore.json memory created');
    // Kit 3.3.6 item 2: a map entry is a lock file when any component of its relative path is a lock name.
    const created=(recovery.memory.created??[]).filter(file=>!isLockPath(file)),saved=recovery.memory.files.filter(file=>!isLockPath(file));
    for(const file of saved) restoreOf(inside(memory,file),'memory','MEMORY RESTORE '+file);
    for(const file of created) restoreOf(inside(memory,file),'memory','MEMORY RESTORE DELETE '+file);
    // As in 3.3.3: files the run created go first, then every saved memory file is written back.
    for(const file of created) writes.push({file:inside(memory,file),data:null});
    for(const file of saved) writes.push({file:inside(memory,file),data:original(inside(path.join(backup,'memory'),file))});
  }
  const savedHook=recovery.hook?hookEntry(recovery.hook):null;
  if(savedHook) restoreOf(savedHook.path,'hook','HOOK RESTORE '+slash(savedHook.path));
  const live=resolveMemory(target,undefined);
  let liveHook=null;
  try { liveHook=hookLocation(target,live.dir).hook??null; } catch {}
  const isLive=memory!==null&&sameFolder(memory,live.dir);
  const given=opts['memory-dir']?path.resolve(opts['memory-dir']):null;
  return {target,backup,memory,destinations,writes,savedHook,fingerprint,isLive,worktree:linkedWorktree(target),live:{dir:live.dir,source:live.source,hook:liveHook},
    rehearsal:given&&!sameFolder(given,live.dir)?given:null,hook:{location:null},
    mismatch:given&&memory&&!sameFolder(memory,given)?`upgrade: backup ${backup} restores memory ${memory}, not ${given}; nothing restored`:null};
}
function applyRestore(plan) {
  for(const {file,data} of plan.writes) {
    if(data!==null) writeBytes(file,data);
    else if(fs.existsSync(file)) fs.unlinkSync(file);
  }
  if(plan.savedHook) restoreHook(plan.savedHook);
}
// E2.8 (d): a restore writes or deletes a generated page only over a version carrying the marker (or one that already
// holds the restored bytes); checked before the lock and again under it.
function restoreOutputs(plan) {
  if(!plan.memory) return null;
  const inMemory=plan.writes.filter(w=>path.dirname(w.file)===plan.memory);
  const refusal=generatedOutputs(plan.memory,inMemory.map(w=>path.basename(w.file)),{writes:new Map(inMemory.map(w=>[path.basename(w.file),w.data]))});
  return refusal?`upgrade: restore refused (${refusal}); nothing restored`:null;
}
function restoreRun(opts,hooks) {
  const plan=restorePlan(opts),check=safety(plan,opts);
  const line=destination=>destination.line+(check.reasons.has(destination)?` (refused in a real run: ${check.reasons.get(destination)})`:'');
  if(opts.check) {
    // Kit 3.3.6 item 12b: the claims and generated-output refusals of a real restore are named here too (rule R7).
    const refused=[plan.mismatch,check.error,claimsRefusal(plan,opts,check.lock),restoreOutputs(plan)].filter(Boolean);
    for(const message of refused) console.log(message);
    for(const destination of plan.destinations.filter(d=>d.kind==='project')) console.log(line(destination));
    if(plan.memory) console.log(`MEMORY ${slash(plan.memory)} (${plan.isLive?'live':'copy'})`);
    for(const destination of plan.destinations.filter(d=>d.kind!=='project')) console.log(line(destination));
    return plan.destinations.length||refused.length||check.reasons.size?1:0;
  }
  if(opts['live-memory']&&plan.worktree) { console.error(`upgrade: refusing --live-memory from a linked worktree ${plan.target}; run it from the main checkout ${plan.worktree}`);return 1; }
  if(plan.mismatch) { console.error(plan.mismatch);return 1; }
  if(check.error||check.refusal) { console.error(check.error??check.refusal);return 1; }
  // E2.8 (a): a restore of live memory is exclusive too: checked here and again under both locks.
  const claims=claimsRefusal(plan,opts,check.lock);
  if(claims) { console.error(claims);return 1; }
  const outputs=restoreOutputs(plan);
  if(outputs) { console.error(outputs);return 1; }
  hooks.afterPlan?.(plan);
  // Statement 21 for an undo: under the lock, plan again, resolve again (no cache), compare, then write.
  const run=()=>{
    const again=restorePlan(opts),second=safety(again,opts);
    if(second.error) { console.error(second.error);return 1; }
    const changed=(String(again.worktree??'')!==String(plan.worktree??'')?'linked worktree state of '+again.target:null)??resolvedDifference(again.destinations,check.resolved,second.resolved)??firstDifference(plan.fingerprint,again.fingerprint);
    if(changed) { console.error(`upgrade: memory or project files changed while planning (${changed}); nothing written; run again`);return 1; }
    if(again.mismatch) { console.error(again.mismatch);return 1; }
    if(second.refusal) { console.error(second.refusal);return 1; }
    const claimsNow=claimsRefusal(again,opts,check.lock);
    if(claimsNow) { console.error(claimsNow);return 1; }
    const outputsNow=restoreOutputs(again);
    if(outputsNow) { console.error(outputsNow);return 1; }
    try { applyRestore(again);console.log('upgrade: restored '+again.backup);return 0; }
    catch(e) { throw new Error(`restore failed: ${e.message}; backup: ${again.backup}`); }
  };
  // The lock goes in the memory folder as the first check resolved it (see applyUpgrade); the push lock with it (E2.8 (b)).
  return plan.memory?withMemoryLock(check.lock,()=>withPushLock(check.lock,run)):run();
}

export function upgrade(opts, root=kitRoot, hooks={}) {
  if(opts['dry-run']) opts={...opts,check:true};
  if(opts.restore) return restoreRun(opts,hooks);
  if(opts.check) return printPreview(makePlan(opts,root,false,hooks),opts);
  return applyUpgrade(opts,root,hooks);
}
if(isDirect(import.meta.url)) {
  try {
    const opts=options(process.argv.slice(2));
    if(opts.help) console.log(usage('upgrade'));
    else process.exitCode=upgrade(opts);
  }
  catch(e) { console.error('upgrade: '+String(e.message).replace(/[\r\n]+/g,' '));process.exitCode=1; }
}
