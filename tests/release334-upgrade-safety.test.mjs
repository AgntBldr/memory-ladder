import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixture,ok,put,read,json,tree,bump,kitRoot,currentVersion,nextVersion} from './helpers.mjs';
import {marker} from '../engine/install-hooks.mjs';
import {isLockName} from '../engine/memory-lock.mjs';

// 3.3.4 update safety: the preview lists every write, live memory needs --live-memory,
// a linked worktree never receives the hook, and "memory not updated" exits 3.
const slash=value=>value.replace(/\\/g,'/');
const run=(f,target,args=[],root=kitRoot,options={})=>f.exec(process.execPath,[path.join(root,'scripts/upgrade.mjs'),'--target',target,...args],options);
const upgrade=(f,args=[],root=kitRoot,options={})=>run(f,f.target,args,root,options);
const lines=result=>result.stdout.split(/\r?\n/);
const errors=result=>result.stderr.split(/\r?\n/);
const hookOf=dir=>path.join(dir,'.git/hooks/pre-commit');
const bytes=file=>fs.existsSync(file)?fs.readFileSync(file).toString('base64'):null;
// Kit 3.3.5 E2.8 (c): the kit's one lock-name predicate, so a push lock left behind is caught too.
const withoutLock=snapshot=>Object.fromEntries(Object.entries(snapshot).filter(([file])=>!isLockName(path.posix.basename(file))));
const everything=f=>tree(f.root,{git:true,previous:true});
const lockFree=dir=>!fs.readdirSync(dir).some(isLockName);
const backupOf=result=>/upgrade backup: (.+)/.exec(result.stdout)[1].trim();
function copyMemory(f,name='copy') { const dir=path.join(f.root,name);fs.cpSync(f.memory,dir,{recursive:true});return dir; }
function addTopic(dir,name='topic-extra') {
  put(path.join(dir,name+'.md'),`---\nname: ${name}\ndescription: An extra topic that makes the generated index stale.\nmetadata:\n  type: feedback\n  route: craft-sessions\n---\nBody.\n`);
}
function handWrittenIndex(dir) {
  put(path.join(dir,'MEMORY.md'),'- [Craft](INDEX-craft.md) OPEN BEFORE testing.\n');
  put(path.join(dir,'INDEX-craft.md'),'# Notes\n271. [Topic](topic.md)\n');
  put(path.join(dir,'topic.md'),'---\nname: topic\ndescription: Useful.\n---\n');
}
function withWorktree(f) {
  f.git(f.target,'add','-A');f.git(f.target,'commit','-m','project');
  const wt=path.join(f.root,'wt');f.git(f.target,'worktree','add',wt);
  return wt;
}
function planned(result) {
  const project=[],memory=[];let hook=false;
  for(const line of lines(result)) {
    let m;
    if((m=/^(?:WRITE|DELETE) (\S+)/.exec(line))) project.push(m[1]);
    else if((m=/^MEMORY (?:WRITE|DELETE) (\S+)/.exec(line))) memory.push(m[1]);
    else if(/^HOOK .*: gate /.test(line)) hook=true;
  }
  return {project:project.sort(),memory:memory.sort(),hook};
}
const changed=(before,after)=>[...new Set([...Object.keys(before),...Object.keys(after)])].filter(file=>before[file]!==after[file]).sort();
const state=(f,memory,hook)=>({project:tree(f.target),memory:withoutLock(tree(memory)),hook:bytes(hook)});
function assertExact(f,memory,hook,args,root) {
  const before=state(f,memory,hook);
  const preview=upgrade(f,['--check',...args],root);
  assert.equal(preview.status,1,preview.stdout+preview.stderr);
  assert.deepEqual(state(f,memory,hook),before,'--check wrote nothing');
  const plan=planned(preview);
  ok(upgrade(f,args,root));
  const after=state(f,memory,hook);
  assert.deepEqual(plan.project,changed(before.project,after.project));
  assert.deepEqual(plan.memory,changed(before.memory,after.memory));
  assert.equal(plan.hook,before.hook!==after.hook);
  return {plan,preview};
}
function driver(f,root,opts,hooks,prelude='') {
  return put(path.join(f.root,'driver.mjs'),`import fs from 'node:fs';
import {upgrade} from ${JSON.stringify(pathToFileURL(path.join(root,'scripts/upgrade.mjs')).href)};
${prelude}
process.exitCode=upgrade(${JSON.stringify(opts)},${JSON.stringify(root)},{${hooks}});
`);
}
function junction(target,link) { fs.symlinkSync(target,link,'junction'); }
const b64=text=>Buffer.from(text).toString('base64');
// The states a rollback kept (S3): the manifest named by its message, each entry with its saved bytes.
function preserved(message) {
  const m=/; the states it replaced are kept in (.+) \(manifest (.+)\)$/.exec(message);
  assert.ok(m,'the rollback message names the kept states: '+message);
  assert.equal(path.dirname(m[2]),m[1]);
  return json(m[2]).entries.map(entry=>({...entry,bytes:entry.type==='file'?bytes(path.join(m[1],entry.id)):null}));
}
const statesOf=entries=>entries.map(entry=>[entry.path,entry.type,entry.bytes]).sort();
// A hook string that saves the paths of the run's snapshot entries to `log`.
const snapshotTo=log=>`afterSnapshot:s=>fs.writeFileSync(${JSON.stringify(log)},JSON.stringify([...s.entries.values()].map(e=>e.path)))`;
const pathsIn=log=>json(log).map(file=>slash(file).toLowerCase());
const keyIn=(f,rel)=>slash(path.join(f.target,rel)).toLowerCase();

test('A-T1 preview equals writes for a stale generated index',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const copy=copyMemory(f);addTopic(copy);
  const {plan,preview}=assertExact(f,copy,hookOf(copy),['--memory-dir',copy],next);
  assert.ok(plan.memory.includes('INDEX-craft-sessions.md'));assert.ok(plan.hook);
  assert.ok(lines(preview).includes('planned writes (--check writes nothing):'));
  assert.ok(lines(preview).includes('BACKUP scripts/memory/.kit-backup-<time>/ (created by the real run)'));
  assert.ok(lines(preview).includes(`MEMORY ${slash(copy)} (--memory-dir; copy)`));
  assert.ok(lines(preview).includes(`planned writes: ${plan.project.length} project, ${plan.memory.length} memory, 1 hook`));
  assert.equal(lines(preview).filter(Boolean).at(-1),`kit ${currentVersion} -> ${nextVersion}`);
});

test('A-T2 preview equals writes for a route migration',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  handWrittenIndex(f.memory);
  const copy=copyMemory(f);
  const {plan}=assertExact(f,copy,hookOf(copy),['--memory-dir',copy],next);
  assert.ok(plan.memory.includes('migration-routes-report.json'));assert.ok(plan.memory.includes('INDEX-craft.md'));
});

test('A-T3 a file the kit no longer ships is listed and deleted exactly',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const installed='scripts/memory/templates/lesson-batch.md';
  fs.rmSync(path.join(next,'templates/lesson-batch.md'));
  const ledger=path.join(next,'engine/upgrades.json'),rows=json(ledger);rows.at(-1).retired=[...(rows.at(-1).retired??[]),installed];put(ledger,JSON.stringify(rows,null,2));
  ok(f.cli('scripts/manifest.mjs',[],next));
  const preview=upgrade(f,['--check'],next);assert.equal(preview.status,1);
  assert.ok(lines(preview).includes('DELETE '+installed),preview.stdout);
  const before=tree(f.target);ok(upgrade(f,['--live-memory'],next));const after=tree(f.target);
  assert.deepEqual(Object.keys(before).filter(file=>!Object.hasOwn(after,file)),[installed]);
});

test('A-T4 check and dry-run write nothing and leave no temporary folder',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);handWrittenIndex(f.memory);
  const tmp=path.join(f.root,'tmp');fs.mkdirSync(tmp);
  const env={...f.env,TMPDIR:tmp,TMP:tmp,TEMP:tmp},before=everything(f);
  for(const flag of ['--check','--dry-run']) {
    const result=upgrade(f,[flag],next,{env});
    assert.equal(result.status,1,result.stdout+result.stderr);
    assert.ok(lines(result).some(line=>line.startsWith('MEMORY WRITE migration-routes-report.json')),'the route migration ran on a temporary copy');
    assert.deepEqual(everything(f),before);
    assert.deepEqual(fs.readdirSync(tmp),[]);
  }
});

for(const [label,setup,args,source] of [
  ['A-T5 KIT.local.json',f=>{const memory=path.join(f.root,'notes');ok(f.install(['--memory-dir',memory]));return {memory};},()=>[],'KIT.local.json'],
  ['A-T6 default folder',f=>{ok(f.install());return {memory:f.memory};},()=>[],'default'],
  ['A-T7 CLAUDE_MEMORY_DIR',f=>{const memory=path.join(f.root,'env-notes'),env={...f.env,CLAUDE_MEMORY_DIR:memory};ok(f.exec(process.execPath,[path.join(kitRoot,'scripts/install.mjs'),'--target',f.target],{env}));return {memory,env};},()=>[],'CLAUDE_MEMORY_DIR'],
  ['A-T8 explicit dir equal to live',f=>{const memory=path.join(f.root,'notes');ok(f.install(['--memory-dir',memory]));return {memory};},memory=>['--memory-dir',memory],'KIT.local.json'],
]) test(`${label}: a real update of live memory needs --live-memory`,t=>{
  const f=fixture(t);
  const {memory,env}=setup(f),next=bump(f),before=everything(f);
  const result=upgrade(f,args(memory),next,env?{env}:{});
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).includes(`upgrade: refusing to write live memory ${memory} (${source}) without --live-memory; preview with --check, rehearse with --memory-dir <copy>, or add --live-memory`),result.stderr);
  assert.deepEqual(everything(f),before);
  assert.ok(lockFree(memory));
  assert.ok(!fs.readdirSync(path.join(f.target,'scripts/memory')).some(name=>name.startsWith('.kit-backup-')));
});

test('A-T9 --live-memory allows the live update and the hook names the target gate',t=>{
  const f=fixture(t),memory=path.join(f.root,'notes');ok(f.install(['--memory-dir',memory]));const next=bump(f);
  ok(upgrade(f,['--live-memory'],next));
  assert.ok(read(hookOf(memory)).includes(`'${slash(path.join(f.target,'scripts/memory/memory-check.mjs'))}'`));
  assert.ok(read(hookOf(memory)).includes(`needed="${nextVersion}"`));
});

test('A-T10 --live-memory from a linked worktree is refused before any write',t=>{
  const f=fixture(t);ok(f.install());const wt=withWorktree(f),next=bump(f),before=everything(f);
  const result=run(f,wt,['--live-memory'],next);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).includes(`upgrade: refusing --live-memory from a linked worktree ${wt}; run it from the main checkout ${f.target}`),result.stderr);
  assert.deepEqual(everything(f),before);
});

test('A-T11 a rehearsal from a linked worktree never refreshes the hook',t=>{
  const f=fixture(t);ok(f.install());const wt=withWorktree(f),next=bump(f);
  const copy=copyMemory(f,'m2'),hook=hookOf(copy),hookBefore=bytes(hook),live=bytes(hookOf(f.memory));
  const preview=run(f,wt,['--check','--memory-dir',copy],next);
  assert.ok(lines(preview).includes(`HOOK not refreshed: ${slash(wt)} is a linked worktree of ${slash(f.target)}`),preview.stdout);
  const result=ok(run(f,wt,['--memory-dir',copy],next));
  assert.ok(lines(result).includes(`HOOK not refreshed: ${slash(wt)} is a linked worktree of ${slash(f.target)}`));
  assert.equal(json(path.join(wt,'scripts/memory/KIT.json')).version,nextVersion);
  assert.equal(bytes(hook),hookBefore);assert.equal(bytes(hookOf(f.memory)),live);
});

test('A-T12 install-hooks refuses a linked worktree; uninstall still works',t=>{
  const f=fixture(t),memory=path.join(f.root,'notes');ok(f.install(['--memory-dir',memory]));const wt=withWorktree(f);
  const hook=hookOf(memory),before=bytes(hook);
  const result=f.cli('engine/install-hooks.mjs',['--repo',wt,'--memory-dir',memory]);
  assert.equal(result.status,1);
  assert.equal(result.stdout.trim(),`refusing to point the memory hook at a linked worktree ${wt}; run install-hooks.mjs from the main checkout ${f.target}`);
  assert.equal(bytes(hook),before);
  assert.match(ok(f.cli('engine/install-hooks.mjs',['--repo',wt,'--memory-dir',memory,'--uninstall'])).stdout,/memory gate hook removed/);
  assert.ok(!fs.existsSync(hook));
});

test('A-T13 install into a linked worktree finishes without a hook',t=>{
  const f=fixture(t);f.git(f.target,'add','-A');f.git(f.target,'commit','-m','host');
  const wt=path.join(f.root,'wt');f.git(f.target,'worktree','add',wt);
  const result=ok(f.cli('scripts/install.mjs',['--target',wt]));
  const memory=path.join(f.home,'.claude/projects',wt.replace(/[^A-Za-z0-9]/g,'-'),'memory');
  assert.ok(lines(result).includes(`Hook skipped: ${wt} is a linked worktree of ${f.target}; from the main checkout run: node scripts/memory/install-hooks.mjs --repo . --memory-dir "${memory}"`),result.stdout);
  assert.ok(fs.existsSync(path.join(memory,'MEMORY.md')));assert.ok(!fs.existsSync(hookOf(memory)));
});

test('A-T14 a stale index at the same version exits 3 and the replay completes',t=>{
  const f=fixture(t);ok(f.install());addTopic(f.memory);const before=everything(f);
  const result=upgrade(f,['--live-memory']);
  assert.equal(result.status,3,result.stdout+result.stderr);
  assert.ok(lines(result).some(line=>line.startsWith(`upgrade: project files are at kit ${currentVersion}, but memory is not: stale generated pages: INDEX-craft-sessions`)),result.stdout);
  assert.ok(lines(result).includes(`upgrade: replay the memory steps with: node "${path.join(kitRoot,'scripts/upgrade.mjs')}" --target "${f.target}" --memory-only --live-memory (rehearse with --memory-dir <copy>)`));
  assert.deepEqual(everything(f),before);
  assert.match(ok(upgrade(f,['--memory-only','--live-memory'])).stdout,/upgrade: memory replay complete \([1-9]\d* memory files changed\)/);
  assert.equal(lines(ok(upgrade(f))).filter(Boolean).at(-1),'upgrade: same version and hashes; no-op');
});

test('A-T15 a pending route migration at the same version exits 3 naming the page',t=>{
  const f=fixture(t);ok(f.install());handWrittenIndex(f.memory);const before=everything(f);
  const result=upgrade(f);
  assert.equal(result.status,3,result.stdout+result.stderr);
  assert.match(result.stdout,/memory is not: route migration pending \(1 hand-written index pages: INDEX-craft\.md\)/);
  assert.deepEqual(everything(f),before);
});

test('A-T16 the same version with nothing pending is still a no-op',t=>{
  const f=fixture(t);ok(f.install());const before=everything(f);
  const result=ok(upgrade(f));
  assert.equal(lines(result).filter(Boolean).at(-1),'upgrade: same version and hashes; no-op');
  assert.deepEqual(everything(f),before);
  const preview=ok(upgrade(f,['--check']));
  assert.ok(lines(preview).includes(`HOOK ${slash(hookOf(f.memory))}: unchanged`));
  assert.ok(lines(preview).includes('planned writes: 0 project, 0 memory, 0 hook'));
});

test('A-T17 project files first, then --memory-only, equals the full update',t=>{
  // Both sequences run at the same project and memory paths, so the hook text is the same; the whole memory
  // folder is compared, .git included; only .memory.lock* is left out (statement 16).
  const f=fixture(t);ok(f.install());const next=bump(f);addTopic(f.memory);
  // A file under a backup-prefixed folder in memory must take part in the comparison like any other.
  const sentinel='.kit-backup-sentinel/sentinel.txt';put(path.join(f.memory,sentinel),'compared\n');
  const pristine={[f.target]:path.join(f.root,'pristine-project'),[f.memory]:path.join(f.root,'pristine-memory')};
  for(const [dir,saved] of Object.entries(pristine)) fs.cpSync(dir,saved,{recursive:true});
  const reset=()=>{ for(const [dir,saved] of Object.entries(pristine)) { fs.rmSync(dir,{recursive:true,force:true});fs.cpSync(saved,dir,{recursive:true}); } };
  const memory=()=>withoutLock(tree(f.memory,{git:true,previous:true}));
  ok(upgrade(f,['--live-memory'],next));const full=memory();
  assert.equal(full[sentinel],Buffer.from('compared\n').toString('base64'),'the backup-prefixed sentinel is in the compared tree');
  reset();
  const scratch=copyMemory(f,'scratch-memory');
  ok(upgrade(f,['--memory-dir',scratch],next));
  assert.equal(json(path.join(f.target,'scripts/memory/KIT.json')).version,nextVersion);
  assert.match(ok(upgrade(f,['--memory-only','--live-memory'],next)).stdout,/upgrade: memory replay complete \([1-9]\d* memory files changed\)/);
  assert.deepEqual(memory(),full);
});

test('A-T18 --memory-only is refused while project files are behind the kit',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f),copy=copyMemory(f),before=everything(f);
  const result=upgrade(f,['--memory-only','--memory-dir',copy],next);
  assert.equal(result.status,1);
  assert.ok(errors(result).includes(`upgrade: --memory-only needs project files at kit ${nextVersion}; found kit ${currentVersion}, engine files differ; run the full upgrade`),result.stderr);
  assert.deepEqual(everything(f),before);
});

test('A-T19 a hook naming another checkout is a planned change on its own',t=>{
  const f=fixture(t);ok(f.install());
  const hook=hookOf(f.memory),other=path.join(f.root,'elsewhere','project');put(hook,read(hook).replaceAll(slash(f.target),slash(other)));
  const before=everything(f),result=upgrade(f,['--check']);
  assert.equal(result.status,1);
  const expected=`HOOK ${slash(hook)}: gate ${slash(path.join(other,'scripts/memory/memory-check.mjs'))} -> ${slash(path.join(f.target,'scripts/memory/memory-check.mjs'))}; memory ${slash(f.memory)} -> ${slash(f.memory)}`;
  assert.ok(lines(result).some(line=>line.startsWith(expected)),result.stdout);
  assert.ok(lines(result).includes('planned writes: 0 project, 0 memory, 1 hook'));
  assert.deepEqual(everything(f),before);
});

test('A-T20 --memory-only --check prints only memory, hook and count lines',t=>{
  const f=fixture(t);ok(f.install());addTopic(f.memory);const before=everything(f);
  const result=upgrade(f,['--memory-only','--check']);
  assert.equal(result.status,1,result.stdout+result.stderr);
  const out=lines(result).filter(Boolean);
  for(const line of out) assert.match(line,/^(?:MEMORY|HOOK|UNDO SNAPSHOT|planned writes:) /);
  assert.ok(out.some(line=>line.startsWith('MEMORY WRITE INDEX-craft-sessions.md')));
  assert.ok(out.at(-1).startsWith('planned writes: 0 project, '));
  assert.deepEqual(everything(f),before);
});

test('A-T21 a hook naming a missing checkout is reported by the preview',t=>{
  const f=fixture(t);ok(f.install());
  const hook=hookOf(f.memory),gone=path.join(f.root,'deleted-checkout');put(hook,read(hook).replaceAll(slash(f.target),slash(gone)));
  const result=upgrade(f,['--check']);
  assert.ok(lines(result).includes(`WARN hook ${slash(hook)} names a missing checkout ${slash(gone)}; memory commits will fail until it is refreshed from the main checkout`),result.stdout);
});

test('A-T22 an absolute hooksPath in a copy cannot write the live hook',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const folder=path.join(f.root,'live-hooks'),liveHook=path.join(folder,'pre-commit'),sentinel=`#!/bin/sh\n${marker}\necho sentinel\n`;
  put(liveHook,sentinel);f.git(f.memory,'config','core.hooksPath',folder);
  const copy=copyMemory(f),before=everything(f);
  const preview=upgrade(f,['--check','--memory-dir',copy],next);
  assert.ok(lines(preview).some(line=>line.startsWith(`HOOK ${slash(liveHook)}: gate `)&&line.endsWith('(refused in a real run: it is live; add --live-memory)')),preview.stdout);
  const result=upgrade(f,['--memory-dir',copy],next);
  assert.equal(result.status,1);
  assert.ok(errors(result).includes(`upgrade: refusing to write ${liveHook} (hook): it is live; add --live-memory`),result.stderr);
  assert.deepEqual(everything(f),before);assert.equal(read(liveHook),sentinel);assert.ok(lockFree(copy));
});

test('A-T23 a relative hooksPath inside the copy changes only the copy hook',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const copy=copyMemory(f),inner=path.join(copy,'hooks','pre-commit');
  put(inner,`#!/bin/sh\n${marker}\necho copy\n`);f.git(copy,'config','core.hooksPath','hooks');
  const live=bytes(hookOf(f.memory)),copyDefault=bytes(hookOf(copy));
  ok(upgrade(f,['--memory-dir',copy],next));
  assert.ok(read(inner).includes(`--memory-dir '${slash(copy)}'`));
  assert.equal(bytes(hookOf(f.memory)),live);assert.equal(bytes(hookOf(copy)),copyDefault);
});

test('A-T24 a memory change between the two plans stops the run',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const file=path.join(f.memory,'current-state.md'),project=tree(f.target,{previous:true}),hook=bytes(hookOf(f.memory));
  const script=driver(f,next,{target:f.target,'live-memory':true},`afterPlan:()=>fs.appendFileSync(${JSON.stringify(file)},'drift\\n')`);
  const result=f.exec(process.execPath,[script]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).includes(`upgrade: memory or project files changed while planning (${file}); nothing written; run again`),result.stderr);
  assert.deepEqual(tree(f.target,{previous:true}),project);assert.equal(bytes(hookOf(f.memory)),hook);
  assert.ok(lockFree(f.memory));assert.match(read(file),/drift\n$/);
});

for(const [label,hooks,culprit] of [
  ['an unplanned memory file',file=>`afterCopy:n=>{if(n===1)fs.writeFileSync(${JSON.stringify(file)},'unplanned\\n')}`,(f,file)=>file],
  ['a failure right after the hook refresh',()=>`afterHook:()=>{throw Error('injected after the hook refresh')}`,f=>hookOf(f.memory)],
]) test(`A-T25 ${label} rolls back project files, memory and the hook`,t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const hook=hookOf(f.memory),extra=path.join(f.memory,'extra.txt');
  const start={project:tree(f.target),memory:withoutLock(tree(f.memory)),hook:bytes(hook),mode:fs.statSync(hook).mode};
  const result=f.exec(process.execPath,[driver(f,next,{target:f.target,'live-memory':true},hooks(extra))]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  const message=errors(result).find(line=>line.startsWith('upgrade: writes differed from the plan ('));
  assert.ok(message,result.stderr);
  assert.ok(message.startsWith(`upgrade: writes differed from the plan (${culprit(f,extra)}); restored `));assert.match(message,/\.kit-backup-/);
  assert.deepEqual(tree(f.target),start.project);assert.deepEqual(withoutLock(tree(f.memory)),start.memory);
  assert.equal(bytes(hook),start.hook);assert.equal(fs.statSync(hook).mode,start.mode);
});

test('A-T26 a restore can be previewed and restores a copy with --memory-dir',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const copy=copyMemory(f),hook=hookOf(copy),memory=withoutLock(tree(copy)),hookBefore=bytes(hook),project=tree(f.target);
  const backup=backupOf(ok(upgrade(f,['--memory-dir',copy],next)));
  assert.ok(json(path.join(backup,'restore.json')).hook,'the backup records the hook');
  const before=everything(f),preview=upgrade(f,['--restore',backup,'--check'],next);
  assert.equal(preview.status,1);
  const out=lines(preview);
  assert.ok(out.includes('RESTORE scripts/memory/KIT.json'),preview.stdout);
  assert.ok(out.includes(`MEMORY ${slash(copy)} (copy)`));
  assert.ok(out.some(line=>line.startsWith('MEMORY RESTORE ')));assert.ok(out.some(line=>line.startsWith('HOOK RESTORE ')));
  assert.deepEqual(everything(f),before);
  ok(upgrade(f,['--restore',backup,'--memory-dir',copy],next));
  assert.deepEqual(tree(f.target),project);assert.deepEqual(withoutLock(tree(copy)),memory);assert.equal(bytes(hook),hookBefore);
});

test('A-T27 a copied backup that names live memory is refused',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const backup=backupOf(ok(upgrade(f,['--live-memory'],next))),copied=path.join(f.root,'backup-copy');fs.cpSync(backup,copied,{recursive:true});
  const copy=copyMemory(f),before=everything(f);
  const first=upgrade(f,['--restore',copied],next);
  assert.equal(first.status,1);assert.match(first.stderr,/^upgrade: refusing to write .+ \(restore\): it is live; add --live-memory$/m);
  const second=upgrade(f,['--restore',copied,'--memory-dir',copy],next);
  assert.equal(second.status,1);
  assert.ok(errors(second).includes(`upgrade: backup ${copied} restores memory ${f.memory}, not ${copy}; nothing restored`),second.stderr);
  assert.deepEqual(everything(f),before);
});

test('A-T28 a junction in the copy to the live hook folder is refused',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const liveHooks=path.join(f.memory,'.git','hooks'),liveHook=path.join(liveHooks,'pre-commit'),sentinel=bytes(liveHook);
  const copy=copyMemory(f),link=path.join(copy,'hooks-link');junction(liveHooks,link);f.git(copy,'config','core.hooksPath','hooks-link');
  const preview=upgrade(f,['--check','--memory-dir',copy],next);
  assert.ok(lines(preview).some(line=>line.startsWith(`HOOK ${slash(path.join(link,'pre-commit'))}: gate `)&&line.endsWith('(refused in a real run: it is live; add --live-memory)')),preview.stdout);
  const result=upgrade(f,['--memory-dir',copy],next);
  assert.equal(result.status,1);
  assert.ok(errors(result).includes(`upgrade: refusing to write ${path.join(link,'pre-commit')} (hook): it is live; add --live-memory`),result.stderr);
  assert.equal(bytes(liveHook),sentinel);
});

test('A-T29 a memory folder that aliases live memory is live',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const alias=path.join(f.root,'alias');junction(f.memory,alias);const memory=withoutLock(tree(f.memory));
  const result=upgrade(f,['--memory-dir',alias],next);
  assert.equal(result.status,1);
  assert.ok(errors(result).includes(`upgrade: refusing to write live memory ${alias} (default) without --live-memory; preview with --check, rehearse with --memory-dir <copy>, or add --live-memory`),result.stderr);
  assert.deepEqual(withoutLock(tree(f.memory)),memory);assert.ok(lockFree(f.memory));
});

test('A-T30 a memory file in the copy that links into live memory is refused',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const copy=copyMemory(f);addTopic(copy);
  const page='INDEX-craft-sessions.md',linked=path.join(copy,page),live=path.join(f.memory,page);fs.rmSync(linked);
  try { fs.symlinkSync(live,linked,'file'); }
  catch(error) { if(['EPERM','EACCES'].includes(error.code)) return t.skip('this system forbids file symlinks ('+error.code+')'); throw error; }
  const before=bytes(live),result=upgrade(f,['--memory-dir',copy],next);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).includes(`upgrade: refusing to write ${linked} (memory file): it is live; add --live-memory`),result.stderr);
  assert.equal(bytes(live),before);
});

test('A-T31 a dangling hook folder link refuses before any write',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const copy=copyMemory(f),link=path.join(copy,'hooks-link');junction(path.join(f.root,'no-such-folder'),link);f.git(copy,'config','core.hooksPath','hooks-link');
  const before=everything(f),result=upgrade(f,['--memory-dir',copy],next);
  assert.equal(result.status,1);
  const message=errors(result).find(line=>line.startsWith('upgrade: cannot resolve '));
  assert.ok(message,result.stderr);
  assert.match(message,/^upgrade: cannot resolve .+ \([A-Z]+\); nothing written$/);
  assert.ok(message.startsWith(`upgrade: cannot resolve ${path.join(link,'pre-commit')} (`));
  assert.deepEqual(everything(f),before);
});

test('A-T32 a backup without a hook entry still restores and leaves the hook alone',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const project=tree(f.target),memory=withoutLock(tree(f.memory));
  const backup=backupOf(ok(upgrade(f,['--live-memory'],next))),file=path.join(backup,'restore.json'),recovery=json(file);
  assert.ok(recovery.hook);delete recovery.hook;put(file,JSON.stringify(recovery,null,2)+'\n');
  const hook=bytes(hookOf(f.memory));
  ok(upgrade(f,['--restore',backup,'--live-memory'],next));
  assert.deepEqual(tree(f.target),project);assert.deepEqual(withoutLock(tree(f.memory)),memory);assert.equal(bytes(hookOf(f.memory)),hook);
});

test('A-T34 a junction retargeted between the two plans stops the run',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const liveHooks=path.join(f.memory,'.git','hooks'),liveHook=path.join(liveHooks,'pre-commit');
  const copy=copyMemory(f),safe=path.join(copy,'safe-hooks'),link=path.join(copy,'hooks-link');
  put(path.join(safe,'pre-commit'),fs.readFileSync(liveHook));junction(safe,link);f.git(copy,'config','core.hooksPath','hooks-link');
  const live={bytes:bytes(liveHook),mode:fs.statSync(liveHook).mode};
  const retarget=`afterPlan:()=>{fs.rmSync(${JSON.stringify(link)});fs.symlinkSync(${JSON.stringify(liveHooks)},${JSON.stringify(link)},'junction');}`;
  const result=f.exec(process.execPath,[driver(f,next,{target:f.target,'memory-dir':copy},retarget)]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).includes(`upgrade: memory or project files changed while planning (${path.join(link,'pre-commit')}); nothing written; run again`),result.stderr);
  assert.ok(fs.existsSync(liveHook));assert.equal(bytes(liveHook),live.bytes);assert.equal(fs.statSync(liveHook).mode,live.mode);
});

const DAY_AGO=new Date(Date.now()-86400000);
const stamp=file=>[fs.statSync(file).mtimeMs,bytes(file)];
const generatedPage=dir=>fs.readdirSync(dir).filter(name=>/^INDEX-.*\.md$/.test(name)).find(name=>read(path.join(dir,name)).startsWith('<!-- generated by memory-index.mjs'));
const planRefusal=/^upgrade: cannot plan the memory steps \(.+\); nothing written$/;

test('A-T35 a memory planning failure in a rehearsal is refused before any write',t=>{
  const f=fixture(t);ok(f.install());handWrittenIndex(f.memory);
  // The copy's router is a hard link to the live router: an unplanned migration write would reach live memory.
  const copy=copyMemory(f),router=path.join(copy,'MEMORY.md'),live=path.join(f.memory,'MEMORY.md');
  fs.rmSync(router);fs.linkSync(live,router);fs.utimesSync(live,DAY_AGO,DAY_AGO);
  const blocked=put(path.join(f.root,'temp-is-a-file'),'');
  const env={...f.env,TMPDIR:blocked,TMP:blocked,TEMP:blocked},before=everything(f),live0=stamp(live);
  const preview=upgrade(f,['--memory-only','--check','--memory-dir',copy],kitRoot,{env});
  assert.equal(preview.status,1);
  assert.ok(errors(preview).some(line=>planRefusal.test(line)),preview.stderr);
  const result=upgrade(f,['--memory-only','--memory-dir',copy],kitRoot,{env});
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).some(line=>planRefusal.test(line)),result.stderr);
  assert.deepEqual(everything(f),before);assert.deepEqual(stamp(live),live0);assert.ok(lockFree(copy));
});

test('A-T36 an unchanged project file reached through a junction into live memory is not written',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);const copy=copyMemory(f);
  const templates=path.join(f.target,'scripts/memory/templates'),mirror=path.join(f.memory,'template-mirror');
  fs.cpSync(templates,mirror,{recursive:true});fs.rmSync(templates,{recursive:true});junction(mirror,templates);
  for(const name of fs.readdirSync(mirror)) fs.utimesSync(path.join(mirror,name),DAY_AGO,DAY_AGO);
  const stamps=()=>fs.readdirSync(mirror).map(name=>[name,...stamp(path.join(mirror,name))]);
  const before=stamps(),memory=withoutLock(tree(f.memory));
  const preview=upgrade(f,['--check','--memory-dir',copy],next);
  assert.ok(!lines(preview).some(line=>line.startsWith('WRITE scripts/memory/templates/')),preview.stdout);
  ok(upgrade(f,['--memory-dir',copy],next));
  assert.deepEqual(stamps(),before);assert.deepEqual(withoutLock(tree(f.memory)),memory);
});

test('A-T37 an unchanged generated page hard-linked to live memory is not written',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);const copy=copyMemory(f);
  const name=generatedPage(f.memory);assert.ok(name,'the fixture has a generated page');
  const live=path.join(f.memory,name),linked=path.join(copy,name);
  assert.equal(read(linked),read(live));fs.rmSync(linked);fs.linkSync(live,linked);fs.utimesSync(live,DAY_AGO,DAY_AGO);
  const live0=stamp(live),memory=withoutLock(tree(f.memory));
  const preview=upgrade(f,['--check','--memory-dir',copy],next);
  assert.ok(!lines(preview).includes('MEMORY WRITE '+name),preview.stdout);
  ok(upgrade(f,['--memory-dir',copy],next));
  assert.deepEqual(stamp(live),live0);assert.deepEqual(withoutLock(tree(f.memory)),memory);
});

test('A-T38 unplanned changes anywhere in the project are detected and undone',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const agents=path.join(f.target,'AGENTS.md'),kept=put(path.join(f.target,'src/host.txt'),'host\n'),created=path.join(f.target,'src/new.txt');
  const start={project:tree(f.target),memory:withoutLock(tree(f.memory)),hook:bytes(hookOf(f.memory))};
  // Every version change rewrites the standard block's begin marker, so AGENTS.md is a planned write: the
  // unplanned change lands right after it, and the kept state is the planned bytes plus the unplanned line.
  const hooks=`afterCopy:(n,file)=>{if(file==='AGENTS.md'){fs.appendFileSync(${JSON.stringify(agents)},'unplanned\\n');fs.writeFileSync(${JSON.stringify(created)},'new\\n');fs.rmSync(${JSON.stringify(kept)});}}`;
  const plannedAgents=read(agents).replace(`(memory kit ${currentVersion})`,`(memory kit ${nextVersion})`);assert.notEqual(plannedAgents,read(agents));
  const changedAgents=b64(plannedAgents+'unplanned\n');
  const result=f.exec(process.execPath,[driver(f,next,{target:f.target,'live-memory':true},hooks)]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  const message=errors(result).find(line=>line.startsWith('upgrade: writes differed from the plan ('));
  assert.ok(message,result.stderr);
  // Unplanned paths are named first, then planned destinations whose bytes differ (verifyScope's order).
  assert.ok(message.startsWith(`upgrade: writes differed from the plan (${kept}, ${created}, ${agents}); restored `),message);
  assert.deepEqual(tree(f.target),start.project);assert.deepEqual(withoutLock(tree(f.memory)),start.memory);
  assert.equal(bytes(hookOf(f.memory)),start.hook);
  // S3: the states the rollback replaced are kept under <backup>/unplanned, one manifest entry each.
  assert.deepEqual(statesOf(preserved(message)),[[agents,'file',changedAgents],[kept,'absent',null],[created,'file',b64('new\n')]].sort());
});

test('A-T39 a planned page that links inside the copy is backed up and rolled back',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const copy=copyMemory(f);addTopic(copy);
  const page='INDEX-craft-sessions.md',linked=path.join(copy,page),inner=path.join(copy,'pages',page);
  put(inner,fs.readFileSync(linked));fs.rmSync(linked);
  try { fs.symlinkSync(inner,linked,'file'); }
  catch(error) { if(['EPERM','EACCES'].includes(error.code)) return t.skip('this system forbids file symlinks ('+error.code+')'); throw error; }
  const before=bytes(inner),memory=withoutLock(tree(copy)),hook=bytes(hookOf(copy));
  const result=f.exec(process.execPath,[driver(f,next,{target:f.target,'memory-dir':copy},`afterHook:()=>{throw Error('injected after the hook refresh')}`)]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).some(line=>line.startsWith(`upgrade: writes differed from the plan (${hookOf(copy)}); restored `)),result.stderr);
  assert.ok(fs.lstatSync(linked).isSymbolicLink());assert.equal(bytes(inner),before);
  assert.deepEqual(withoutLock(tree(copy)),memory);assert.equal(bytes(hookOf(copy)),hook);
  const backup=backupOf(result),recovery=json(path.join(backup,'restore.json'));
  assert.ok(recovery.memory.files.includes(page));assert.equal(bytes(path.join(backup,'memory',page)),before);
});

test('A-T40 a same-version hook refresh keeps a durable backup and rolls back',t=>{
  const f=fixture(t);ok(f.install());
  const hook=hookOf(f.memory),other=path.join(f.root,'elsewhere','project');put(hook,read(hook).replaceAll(slash(f.target),slash(other)));
  const start={hook:bytes(hook),mode:fs.statSync(hook).mode,project:tree(f.target),memory:withoutLock(tree(f.memory))};
  const preview=upgrade(f,['--check']);
  assert.ok(lines(preview).includes('BACKUP scripts/memory/.kit-backup-<time>/ (created by the real run)'),preview.stdout);
  const result=f.exec(process.execPath,[driver(f,kitRoot,{target:f.target,'live-memory':true},`afterHook:()=>{throw Error('injected after the hook refresh')}`)]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).some(line=>line.startsWith(`upgrade: writes differed from the plan (${hook}); restored `)&&/\.kit-backup-/.test(line)),result.stderr);
  const recovery=json(path.join(backupOf(result),'restore.json'));
  assert.equal(recovery.hook.existed,true);assert.equal(recovery.hook.bytes,start.hook);
  assert.equal(bytes(hook),start.hook);assert.equal(fs.statSync(hook).mode,start.mode);
  assert.deepEqual(tree(f.target),start.project);assert.deepEqual(withoutLock(tree(f.memory)),start.memory);
});

for(const [label,change] of [
  ['a junction retargeted',({alias,live})=>`afterPlan:()=>{fs.rmSync(${JSON.stringify(alias)});fs.symlinkSync(${JSON.stringify(live)},${JSON.stringify(alias)},'junction');}`],
  ['a recovery map rewritten',({map,live})=>`afterPlan:()=>{const m=JSON.parse(fs.readFileSync(${JSON.stringify(map)}));m.memory.dir=${JSON.stringify(live)};fs.writeFileSync(${JSON.stringify(map)},JSON.stringify(m));}`],
]) test(`A-T41 ${label} while the restore takes the lock is refused`,t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const copy=copyMemory(f),alias=path.join(f.root,'alias');junction(copy,alias);
  const backup=backupOf(ok(upgrade(f,['--memory-dir',alias],next))),map=path.join(backup,'restore.json');
  const before={live:withoutLock(tree(f.memory,{git:true})),copy:withoutLock(tree(copy,{git:true})),project:tree(f.target)};
  const result=f.exec(process.execPath,[driver(f,next,{target:f.target,restore:backup,'memory-dir':alias},change({alias,live:f.memory,map}))]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).some(line=>line.startsWith('upgrade: memory or project files changed while planning (')&&line.endsWith('); nothing written; run again')),result.stderr);
  assert.deepEqual(withoutLock(tree(f.memory,{git:true})),before.live);assert.ok(lockFree(f.memory));
  assert.deepEqual(withoutLock(tree(copy,{git:true})),before.copy);assert.deepEqual(tree(f.target),before.project);
});

test('A-T42 a planned write to a hard-linked file is refused',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const copy=copyMemory(f),page='INDEX-craft-sessions.md',linked=path.join(copy,page),live=path.join(f.memory,page);
  fs.rmSync(linked);fs.linkSync(live,linked);addTopic(copy);
  const before=everything(f);
  const preview=upgrade(f,['--check','--memory-dir',copy],next);
  assert.ok(lines(preview).includes(`MEMORY WRITE ${page} (refused in a real run: it has 2 hard links; a write would change the other links too)`),preview.stdout);
  const result=upgrade(f,['--memory-dir',copy],next);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).includes(`upgrade: refusing to write ${linked} (memory file): it has 2 hard links; a write would change the other links too`),result.stderr);
  assert.deepEqual(everything(f),before);assert.ok(lockFree(copy));
});

// Runs upgrade() in a child process that records the path of every file-system write it makes, transient ones
// (the lock file, created and removed) included, and saves the list to `log` when the process exits.
function recordingDriver(f,root,opts,hooks,log) {
  return put(path.join(f.root,'recording-driver.mjs'),`import fs from 'node:fs';
const writes=[],save=fs.writeFileSync;
const at={writeFileSync:[0],appendFileSync:[0],mkdirSync:[0],copyFileSync:[1],renameSync:[0,1],unlinkSync:[0],rmSync:[0],rmdirSync:[0],symlinkSync:[1],linkSync:[1]};
for(const [name,places] of Object.entries(at)) { const original=fs[name]; fs[name]=function(...args) { for(const i of places) writes.push([name,String(args[i])]); return original.apply(this,args); }; }
process.on('exit',()=>save(${JSON.stringify(log)},JSON.stringify(writes)));
const {upgrade}=await import(${JSON.stringify(pathToFileURL(path.join(root,'scripts/upgrade.mjs')).href)});
process.exitCode=upgrade(${JSON.stringify(opts)},${JSON.stringify(root)},{${hooks}});
`);
}
const within=(dir,file)=>{ const a=slash(dir).toLowerCase(),b=slash(file).toLowerCase(); return b===a||b.startsWith(a+'/'); };

for(const label of ['update','restore']) test(`A-T43 ${label}: the lock goes in the folder the first plan resolved, never through a retargeted alias`,t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const copy=copyMemory(f),alias=path.join(f.root,'alias');junction(copy,alias);
  const backup=label==='restore'?backupOf(ok(upgrade(f,['--memory-dir',alias],next))):null;
  const live=withoutLock(tree(f.memory,{git:true,previous:true})),log=path.join(f.root,'writes.json');
  const opts={target:f.target,'memory-dir':alias,...(backup?{restore:backup}:{})};
  const retarget=`afterPlan:()=>{fs.rmSync(${JSON.stringify(alias)});fs.symlinkSync(${JSON.stringify(f.memory)},${JSON.stringify(alias)},'junction');}`;
  const result=f.exec(process.execPath,[recordingDriver(f,next,opts,retarget,log)]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).some(line=>line.startsWith('upgrade: memory or project files changed while planning (')),result.stderr);
  // The test's own retarget writes the alias itself; anything else at or under the alias or live memory is the run's.
  const writes=json(log).filter(([,file])=>slash(file).toLowerCase()!==slash(alias).toLowerCase());
  assert.deepEqual(writes.filter(([,file])=>within(f.memory,file)||within(alias,file)),[],'no write, transient or not, reached live memory');
  assert.ok(writes.some(([name,file])=>name==='writeFileSync'&&within(path.join(copy,'.memory.lock'),file)),'the lock was taken in the copy');
  assert.deepEqual(withoutLock(tree(f.memory,{git:true,previous:true})),live);assert.ok(lockFree(f.memory));assert.ok(lockFree(copy));
});

// A driver whose fs reports `link` as a file symlink to `to` (lstat and readlink); everything else is real. With
// `link`'s parent folder a junction to `to`'s folder, reads and writes through `link` reach `to` as they would
// through a real file symlink. Used where the system forbids file symlinks.
function emulatedLinkDriver(f,root,opts,hooks,link,to) {
  return put(path.join(f.root,'link-driver.mjs'),`import fs from 'node:fs';
import path from 'node:path';
const link=${JSON.stringify(link)}.toLowerCase(),to=${JSON.stringify(to)},is=file=>typeof file==='string'&&path.resolve(file).toLowerCase()===link;
const lstat=fs.lstatSync,readlink=fs.readlinkSync;
fs.lstatSync=function(file,...rest) {
  const stat=lstat.call(fs,file,...rest);
  if(!stat||!is(file)) return stat;
  return Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,{isSymbolicLink:()=>true,isFile:()=>false,isDirectory:()=>false});
};
fs.readlinkSync=function(file,...rest) { return is(file)?to:readlink.call(fs,file,...rest); };
const {upgrade}=await import(${JSON.stringify(pathToFileURL(path.join(root,'scripts/upgrade.mjs')).href)});
process.exitCode=upgrade(${JSON.stringify(opts)},${JSON.stringify(root)},{${hooks}});
`);
}
const failAfterHook=`afterHook:()=>{throw Error('injected after the hook refresh')}`;

for(const mode of ['emulated','real']) test(`A-T44 a linked hook whose file is under the copy's .git is restored by the rollback (${mode} link)`,t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const copy=copyMemory(f),folder=path.join(copy,'.git','kit-hooks'),referent=path.join(folder,'pre-commit');
  put(referent,fs.readFileSync(hookOf(copy)));
  let hook,script;
  if(mode==='real') {
    hook=hookOf(copy);fs.rmSync(hook);
    try { fs.symlinkSync(referent,hook,'file'); }
    catch(error) { if(['EPERM','EACCES'].includes(error.code)) return t.skip('this system forbids file symlinks ('+error.code+')'); throw error; }
    script=driver(f,next,{target:f.target,'memory-dir':copy},failAfterHook);
  } else {
    const links=path.join(copy,'hooks-link');junction(folder,links);f.git(copy,'config','core.hooksPath','hooks-link');
    hook=path.join(links,'pre-commit');
    script=emulatedLinkDriver(f,next,{target:f.target,'memory-dir':copy},failAfterHook,hook,referent);
  }
  const before=bytes(referent),memory=withoutLock(tree(copy));
  const result=f.exec(process.execPath,[script]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).some(line=>line.startsWith(`upgrade: writes differed from the plan (${hook}); restored `)),result.stderr);
  assert.equal(bytes(referent),before,'the file the hook link reaches has its original bytes');
  assert.deepEqual(withoutLock(tree(copy)),memory);
  if(mode==='real') assert.ok(fs.lstatSync(hook).isSymbolicLink());
});

test('A-T45 a planned page that links to a file under the copy\'s .git is restored by the rollback',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const copy=copyMemory(f);addTopic(copy);
  const page='INDEX-craft-sessions.md',linked=path.join(copy,page),referent=path.join(copy,'.git','pages',page);
  put(referent,fs.readFileSync(linked));fs.rmSync(linked);
  try { fs.symlinkSync(referent,linked,'file'); }
  catch(error) { if(['EPERM','EACCES'].includes(error.code)) return t.skip('this system forbids file symlinks ('+error.code+')'); throw error; }
  const before=bytes(referent);
  const result=f.exec(process.execPath,[driver(f,next,{target:f.target,'memory-dir':copy},failAfterHook)]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).some(line=>line.startsWith('upgrade: writes differed from the plan (')),result.stderr);
  assert.ok(fs.lstatSync(linked).isSymbolicLink());assert.equal(bytes(referent),before,'the page\'s file has its original bytes');
});

// ---- Addendum A-scope: the execution scope (S1, S2) and recovery that loses nothing (S3). ----
const J=JSON.stringify;
const liveRun=(f,next,hooks,prelude)=>f.exec(process.execPath,[driver(f,next,{target:f.target,'live-memory':true},hooks,prelude)]);
const differed=result=>errors(result).find(line=>line.startsWith('upgrade: writes differed from the plan ('))??'';

test('A-T46 an ignored folder is neither snapshotted nor compared; a foreign write there does not roll back',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  put(path.join(f.target,'.gitignore'),'build/\n');
  const build=path.join(f.target,'build');
  for(let i=0;i<2000;i++) put(path.join(build,'d'+(i%20),'f'+i+'.txt'),'built '+i+'\n');
  const log=path.join(f.root,'snapshot.json'),changed=path.join(build,'d0','f0.txt'),added=path.join(build,'new.txt');
  const result=liveRun(f,next,`${snapshotTo(log)},afterCopy:n=>{if(n===1){fs.writeFileSync(${J(changed)},'foreign\\n');fs.writeFileSync(${J(added)},'foreign\\n');}}`);
  assert.equal(result.status,0,result.stdout+result.stderr);
  const snapshot=pathsIn(log);
  assert.equal(snapshot.filter(file=>file.startsWith(keyIn(f,'build')+'/')).length,0,'nothing under the ignored folder is snapshotted');
  assert.ok(snapshot.includes(keyIn(f,'scripts/memory/KIT.json'))&&snapshot.includes(keyIn(f,'.gitignore')));
  assert.equal(read(changed),'foreign\n');assert.equal(read(added),'foreign\n');
});

test('A-T47 unplanned changes to ignored protected configuration are detected, undone and preserved',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  put(path.join(f.target,'.gitignore'),'.claude/settings.local.json\n');
  const local=path.join(f.target,'scripts/memory/KIT.local.json'),settings=put(path.join(f.target,'.claude/settings.local.json'),'{"local":true}\n');
  if(!fs.existsSync(local)) put(local,'{}\n');
  const start={local:bytes(local),settings:bytes(settings),project:tree(f.target)};
  const result=liveRun(f,next,`afterCopy:n=>{if(n===1){fs.writeFileSync(${J(local)},'{"changed":1}\\n');fs.writeFileSync(${J(settings)},'{"changed":2}\\n');}}`);
  assert.equal(result.status,1,result.stdout+result.stderr);
  const message=differed(result);
  assert.ok(message.includes(local)&&message.includes(settings),result.stderr);
  assert.equal(bytes(local),start.local);assert.equal(bytes(settings),start.settings);assert.deepEqual(tree(f.target),start.project);
  assert.deepEqual(statesOf(preserved(message)),[[local,'file',b64('{"changed":1}\n')],[settings,'file',b64('{"changed":2}\n')]].sort());
});

test('A-T48 a planned destination in an ignored folder holding foreign bytes is snapshotted, preserved and rolled back',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  put(path.join(f.target,'.gitignore'),'.claude/skills/\n');
  const skill='.claude/skills/memory-ladder/SKILL.md',file=path.join(f.target,skill),before=bytes(file),log=path.join(f.root,'snapshot.json');
  const result=liveRun(f,next,`${snapshotTo(log)},afterCopy:(n,name)=>{if(name===${J(skill)})fs.writeFileSync(${J(file)},'foreign\\n');}`);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(pathsIn(log).includes(keyIn(f,skill)),'the planned destination is snapshotted although git ignores it');
  const message=differed(result);
  assert.ok(message.includes(file),result.stderr);
  assert.equal(bytes(file),before);
  assert.deepEqual(statesOf(preserved(message)),[[file,'file',b64('foreign\n')]]);
});

test('A-T49 a new file, an ignore edit, an ignore input git does not list and a file dropped from the index, then ignored',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const ignore=put(path.join(f.target,'.gitignore'),'*.log\n'),tracked=put(path.join(f.target,'tracked.txt'),'tracked\n');
  f.git(f.target,'add','tracked.txt');
  const notes=path.join(f.target,'notes.txt'),hidden=path.join(f.target,'hidden.txt'),exclude=path.join(f.target,'.git','info','exclude');
  const start={ignore:bytes(ignore),exclude:bytes(exclude),project:tree(f.target)};
  const hooks=`afterCopy:n=>{if(n!==1)return;
    fs.writeFileSync(${J(notes)},'notes\\n');
    fs.appendFileSync(${J(ignore)},'hidden.txt\\n');fs.writeFileSync(${J(hidden)},'secret\\n');
    fs.appendFileSync(${J(exclude)},'# edited\\n');
    process.getBuiltinModule('node:child_process').execFileSync('git',['-C',${J(f.target)},'rm','--cached','-q','tracked.txt']);
    fs.appendFileSync(${J(exclude)},'tracked.txt\\n');
    fs.writeFileSync(${J(tracked)},'mutated\\n');}`;
  const result=liveRun(f,next,hooks);
  assert.equal(result.status,1,result.stdout+result.stderr);
  // Dropped from the index and then ignored, tracked.txt is gone from git's view: only the kept first inventory
  // still holds it, so its changed bytes must be preserved and its original put back.
  assert.equal(f.git(f.target,'ls-files','--','tracked.txt').trim(),'','tracked.txt is out of the index');
  const message=differed(result);
  for(const file of [notes,ignore,exclude,tracked]) assert.ok(message.includes(file),file+' named: '+result.stderr);
  assert.equal(bytes(ignore),start.ignore);assert.equal(bytes(exclude),start.exclude);assert.equal(read(tracked),'tracked\n');
  assert.ok(!fs.existsSync(notes));assert.equal(read(hidden),'secret\n','a file hidden by the ignore edit keeps its bytes');
  const states=statesOf(preserved(message));
  for(const state of [[notes,'file',b64('notes\n')],[tracked,'file',b64('mutated\n')]]) assert.ok(states.some(s=>J(s)===J(state)),J(state));
  assert.ok(states.some(([file,type])=>file===ignore&&type==='file'));
  assert.deepEqual(Object.keys(tree(f.target)).sort(),[...Object.keys(start.project),'hidden.txt'].sort());
});

const listRefusal=/^upgrade: cannot list the project files \(.+\); nothing written$/;
test('A-T50 a broken .git file refuses before the lock, with no fallback',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  fs.renameSync(path.join(f.target,'.git'),path.join(f.root,'project-git'));put(path.join(f.target,'.git'),'gitdir: '+path.join(f.root,'nowhere')+'\n');
  const before=everything(f),result=upgrade(f,['--live-memory'],next);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).some(line=>listRefusal.test(line)),result.stderr);
  assert.deepEqual(everything(f),before);assert.ok(lockFree(f.memory));
});

test('A-T50 a .git file in an ancestor folder refuses; the fallback needs a clean ancestry',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  fs.rmSync(path.join(f.target,'.git'),{recursive:true,force:true});put(path.join(f.root,'.git'),'gitdir: '+path.join(f.root,'nowhere')+'\n');
  const before=everything(f),result=upgrade(f,['--live-memory'],next);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).some(line=>listRefusal.test(line)),result.stderr);
  assert.deepEqual(everything(f),before);
});

for(const when of ['initially','after the writes']) test(`A-T50 a git warning with status zero ${when} ${when==='initially'?'refuses before the lock':'enters recovery'}`,t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const marker=path.join(f.root,'warn-now'),start={project:tree(f.target),memory:withoutLock(tree(f.memory)),hook:bytes(hookOf(f.memory))};
  // Git for Windows exits 0 while warning about an unreadable ignore input; the driver adds that warning to ls-files.
  const prelude=`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const spawn=cp.spawnSync;
cp.spawnSync=function(command,args,options){const r=spawn.call(cp,command,args,options);if(command==='git'&&args.includes('ls-files')&&fs.existsSync(${J(marker)})){const text="warning: unable to access 'ignore-input': Permission denied\\n";r.stderr=typeof r.stderr==='string'?r.stderr+text:Buffer.concat([r.stderr,Buffer.from(text)]);}return r;};
syncBuiltinESMExports();`;
  if(when==='initially') put(marker,'');
  const script=driver(f,next,{target:f.target,'live-memory':true},when==='initially'?'':`afterCopy:n=>{if(n===1)fs.writeFileSync(${J(marker)},'')}`,prelude);
  const before=everything(f),result=f.exec(process.execPath,[script]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  if(when==='initially') {
    assert.ok(errors(result).some(line=>listRefusal.test(line)&&line.includes('Permission denied')),result.stderr);
    assert.deepEqual(everything(f),before);
  } else {
    assert.ok(errors(result).some(line=>/^upgrade: restored .+\.kit-backup-.+: cannot list the project files \(.+Permission denied.*\)/.test(line)),result.stderr);
    assert.ok(!result.stderr.includes('nothing written'));
    assert.deepEqual(tree(f.target),start.project);assert.deepEqual(withoutLock(tree(f.memory)),start.memory);assert.equal(bytes(hookOf(f.memory)),start.hook);
  }
});

test('A-T50 a target outside any git work tree uses the whole tree minus a nested repository',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  fs.rmSync(path.join(f.target,'.git'),{recursive:true,force:true});
  const nested=path.join(f.target,'vendor','nested');put(path.join(nested,'lib.txt'),'lib\n');f.git(nested,'init');
  put(path.join(f.target,'notes','plain.txt'),'plain\n');
  const log=path.join(f.root,'snapshot.json'),result=liveRun(f,next,snapshotTo(log));
  assert.equal(result.status,0,result.stdout+result.stderr);
  const snapshot=pathsIn(log);
  assert.ok(snapshot.includes(keyIn(f,'notes/plain.txt'))&&snapshot.includes(keyIn(f,'AGENTS.md')),'the whole tree is in scope');
  assert.equal(snapshot.filter(file=>file.startsWith(keyIn(f,'vendor/nested'))).length,0,'the nested repository is not');
});

test('A-T51 a submodule and an untracked nested repository are out of scope; a destination in the submodule is in',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const skillRel='.claude/skills/memory-ladder',source=path.join(f.root,'skill-source');
  fs.cpSync(path.join(f.target,skillRel),source,{recursive:true});put(path.join(source,'sentinel.txt'),'submodule\n');
  f.git(source,'init');f.git(source,'add','-A');f.git(source,'commit','-q','-m','skill');
  fs.rmSync(path.join(f.target,skillRel),{recursive:true});
  f.git(f.target,'-c','protocol.file.allow=always','submodule','add','-q',source,skillRel);
  const nested=path.join(f.target,'vendor','nested');put(path.join(nested,'kept.txt'),'kept\n');f.git(f.target,'add','vendor/nested/kept.txt');
  f.git(nested,'init');put(path.join(nested,'sibling.txt'),'sibling\n');
  const rules=path.join(f.target,'.claude','rules');put(path.join(rules,'team.md'),'# Team rules\n');f.git(rules,'init');
  const sentinel=path.join(f.target,skillRel,'sentinel.txt'),sibling=path.join(nested,'sibling.txt'),log=path.join(f.root,'snapshot.json');
  const result=liveRun(f,next,`${snapshotTo(log)},afterCopy:n=>{if(n===1){fs.writeFileSync(${J(sentinel)},'foreign\\n');fs.writeFileSync(${J(sibling)},'foreign\\n');}}`);
  assert.equal(result.status,0,result.stdout+result.stderr);
  const snapshot=pathsIn(log);
  assert.ok(snapshot.includes(keyIn(f,skillRel+'/SKILL.md')),'the planned destination inside the submodule is in scope');
  assert.ok(snapshot.includes(keyIn(f,'vendor/nested/kept.txt')),'a file the outer index lists inside a nested repository stays in scope');
  assert.ok(snapshot.includes(keyIn(f,'.claude/rules/team.md')),'protected configuration inside a nested repository stays in scope');
  for(const rel of [skillRel+'/sentinel.txt','vendor/nested/sibling.txt']) assert.ok(!snapshot.includes(keyIn(f,rel)),rel+' is out of scope');
  assert.equal(read(sentinel),'foreign\n');assert.equal(read(sibling),'foreign\n');
});

test('A-T52 preservation keeps every replaced state under unplanned/ without collisions, then restores',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  put(path.join(f.target,'.gitignore'),'*.log\n');
  const data=put(path.join(f.target,'data.txt'),'data\n'),gone=put(path.join(f.target,'gone.txt'),'gone\n');
  const projectExtra=path.join(f.target,'extra.md'),memoryExtra=path.join(f.memory,'extra.md'),hook=hookOf(f.memory);
  const linked=path.join(f.root,'linked-dir'),linkedSentinel=put(path.join(linked,'sentinel.txt'),'linked\n'),memoryLink=path.join(f.memory,'linked-folder');
  const start={project:tree(f.target),memory:withoutLock(tree(f.memory)),hook:bytes(hook)};
  const hooks=`afterHook:()=>{
    fs.rmSync(${J(data)});fs.mkdirSync(${J(data)});fs.writeFileSync(${J(path.join(data,'inner.txt'))},'inner\\n');fs.writeFileSync(${J(path.join(data,'hidden.log'))},'hidden\\n');
    fs.mkdirSync(${J(path.join(data,'sub'))});fs.symlinkSync(${J(linked)},${J(path.join(data,'link'))},'junction');fs.symlinkSync(${J(linked)},${J(memoryLink)},'junction');
    fs.rmSync(${J(gone)});fs.writeFileSync(${J(projectExtra)},'project\\n');fs.writeFileSync(${J(memoryExtra)},'memory\\n');
    fs.writeFileSync(${J(hook)},'#!/bin/sh\\nforeign\\n');}`;
  const result=liveRun(f,next,hooks);
  assert.equal(result.status,1,result.stdout+result.stderr);
  const message=differed(result),kept=preserved(message);
  assert.equal(new Set(kept.map(entry=>entry.id)).size,kept.length,'every kept state has its own id');
  const states=statesOf(kept);
  for(const state of [[gone,'absent',null],[projectExtra,'file',b64('project\n')],[memoryExtra,'file',b64('memory\n')],[hook,'file',b64('#!/bin/sh\nforeign\n')]]) assert.ok(states.some(s=>J(s)===J(state)),J(state)+' in '+J(states));
  const folder=kept.find(entry=>entry.path===data);
  assert.equal(folder?.type,'directory');
  const root=path.dirname(/\(manifest (.+)\)$/.exec(message)[1]);
  assert.deepEqual(folder.contents.map(item=>[item.path,item.type]).sort(),[['hidden.log','file'],['inner.txt','file'],['link','link'],['sub','directory']]);
  assert.equal(read(path.join(root,folder.id,'hidden.log')),'hidden\n','the contents git does not list are kept too');
  // P2 metadata: folder modes and link kinds, for the top-level states and the folder's contents.
  const same=(a,b)=>slash(a).toLowerCase()===slash(b).toLowerCase();
  assert.equal(typeof folder.mode,'number');
  assert.equal(typeof folder.contents.find(item=>item.path==='sub').mode,'number');
  const inner=folder.contents.find(item=>item.path==='link');
  assert.equal(inner.linkType,'directory');assert.ok(same(inner.target,linked),inner.target);assert.equal(typeof inner.mode,'number');
  const top=kept.find(entry=>entry.path===memoryLink);
  assert.equal(top?.type,'link');assert.equal(top.linkType,'directory');assert.ok(same(top.target,linked),top.target);assert.equal(typeof top.mode,'number');
  assert.ok(!fs.existsSync(memoryLink),'the new link is removed');assert.equal(read(linkedSentinel),'linked\n','removing a link leaves its target alone');
  assert.deepEqual(tree(f.target),start.project);assert.deepEqual(withoutLock(tree(f.memory)),start.memory);assert.equal(bytes(hook),start.hook);
});

test('A-T52 a junction in place of unplanned/ is refused: nothing is destroyed, the snapshot and backup are kept',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const outside=path.join(f.root,'outside'),sentinel=put(path.join(outside,'sentinel.txt'),'outside\n'),extra=path.join(f.target,'extra.txt'),engine=path.join(f.target,'scripts/memory');
  const hooks=`afterCopy:n=>{if(n!==1)return;const backup=fs.readdirSync(${J(engine)}).find(name=>name.startsWith('.kit-backup-'));
    fs.symlinkSync(${J(outside)},${J(engine)}+'/'+backup+'/unplanned','junction');fs.writeFileSync(${J(extra)},'unplanned\\n');}`;
  const result=liveRun(f,next,hooks);
  assert.equal(result.status,1,result.stdout+result.stderr);
  const failure=errors(result).find(line=>line.startsWith('upgrade: rollback failed: '));
  assert.ok(failure,result.stderr);
  const snapshot=/every original in the scope is kept in (.+?); original:/.exec(failure)?.[1];
  assert.ok(snapshot&&fs.existsSync(snapshot),'the snapshot is kept');t.after(()=>fs.rmSync(snapshot,{recursive:true,force:true}));
  assert.ok(fs.existsSync(path.join(backupOf(result),'restore.json')),'the backup is kept');
  assert.equal(read(extra),'unplanned\n','the unexpected state is not destroyed');
  assert.deepEqual(fs.readdirSync(outside),['sentinel.txt']);assert.equal(read(sentinel),'outside\n');
});

test('A-T53 memory .git and an older memory backup are in the execution scope',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const gitSentinel=put(path.join(f.memory,'.git','kit-sentinel'),'git\n'),oldBackup=put(path.join(f.memory,'.kit-backup-old','sentinel.txt'),'old\n');
  const result=liveRun(f,next,`afterCopy:n=>{if(n===1){fs.writeFileSync(${J(gitSentinel)},'changed\\n');fs.writeFileSync(${J(oldBackup)},'changed\\n');}}`);
  assert.equal(result.status,1,result.stdout+result.stderr);
  const message=differed(result);
  assert.ok(message.includes(gitSentinel)&&message.includes(oldBackup),result.stderr);
  assert.equal(read(gitSentinel),'git\n');assert.equal(read(oldBackup),'old\n');
});

test('A-T53 with memory inside the project, this run\'s backup is left out while an older backup stays protected',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const memory=path.join(f.target,'scripts');
  for(const name of fs.readdirSync(f.memory)) if(name.endsWith('.md')) fs.copyFileSync(path.join(f.memory,name),path.join(memory,name));
  const old=put(path.join(f.target,'scripts/memory/.kit-backup-old/sentinel.txt'),'old\n');
  const result=f.exec(process.execPath,[driver(f,next,{target:f.target,'memory-dir':memory},`afterCopy:n=>{if(n===1)fs.writeFileSync(${J(old)},'changed\\n')}`)]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(differed(result).startsWith(`upgrade: writes differed from the plan (${old}); restored `),result.stderr);
  assert.equal(read(old),'old\n');
});

test('A-T54 an external input changed mid-run fails the run and is never written',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const config=f.env.GIT_CONFIG_GLOBAL;
  const result=liveRun(f,next,`afterCopy:n=>{if(n===1)fs.appendFileSync(${J(config)},'# changed during the run\\n')}`);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(differed(result).includes(config),result.stderr);
  assert.match(read(config),/# changed during the run\n$/,'recovery never writes a validation-only input');
});

test('A-T55 a .memory.lock-named file outside memory stays in scope (non-git host)',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  fs.rmSync(path.join(f.target,'.git'),{recursive:true,force:true});
  const notes=put(path.join(f.target,'.memory.lock-notes'),'host notes\n');
  const result=liveRun(f,next,`afterCopy:n=>{if(n===1)fs.writeFileSync(${J(notes)},'changed\\n')}`);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(differed(result).includes(notes),result.stderr);
  assert.equal(read(notes),'host notes\n');
});

// Adds "warning: unable to access ..." to every git ls-files result once `marker` exists (status stays zero).
const warnAfter=marker=>`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const spawn=cp.spawnSync;
cp.spawnSync=function(command,args,options){const r=spawn.call(cp,command,args,options);if(command==='git'&&args.includes('ls-files')&&fs.existsSync(${J(marker)})){const text="warning: unable to access 'ignore-input': Permission denied\\n";r.stderr=typeof r.stderr==='string'?r.stderr+text:Buffer.concat([r.stderr,Buffer.from(text)]);}return r;};
syncBuiltinESMExports();`;

test('A-T56 a file the first listing found stays in scope after it is ignored before the snapshot',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const ignore=put(path.join(f.target,'.gitignore'),'*.log\n'),listed=put(path.join(f.target,'listed.txt'),'listed\n');
  const hooks=`afterPlan:()=>fs.appendFileSync(${J(ignore)},'listed.txt\\n'),afterCopy:n=>{if(n===1)fs.writeFileSync(${J(listed)},'changed\\n')}`;
  const result=liveRun(f,next,hooks);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(differed(result).includes(listed),result.stderr);
  assert.equal(read(listed),'listed\n');
});

test('A-T56 a listing failure under the lock, before any write, takes the later-error path',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const marker=path.join(f.root,'warn-now'),start={project:tree(f.target),memory:withoutLock(tree(f.memory)),hook:bytes(hookOf(f.memory))};
  const result=liveRun(f,next,`afterPlan:()=>fs.writeFileSync(${J(marker)},'')`,warnAfter(marker));
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).some(line=>/^upgrade: restored .+\.kit-backup-.+: cannot list the project files \(.+Permission denied.*\)/.test(line)),result.stderr);
  assert.ok(!result.stderr.includes('nothing written'),result.stderr);
  assert.deepEqual(tree(f.target),start.project);assert.deepEqual(withoutLock(tree(f.memory)),start.memory);assert.equal(bytes(hookOf(f.memory)),start.hook);
});

test('A-T57 a .gitignore that info/exclude ignores is still an input: its change mid-run is named',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const ignore=put(path.join(f.target,'.gitignore'),'*.log\n');fs.appendFileSync(path.join(f.target,'.git','info','exclude'),'.gitignore\n');
  const hidden=path.join(f.target,'hidden.txt'),before=bytes(ignore);
  const result=liveRun(f,next,`afterCopy:n=>{if(n===1){fs.appendFileSync(${J(ignore)},'hidden.txt\\n');fs.writeFileSync(${J(hidden)},'secret\\n');}}`);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(differed(result).includes(ignore),result.stderr);
  assert.equal(bytes(ignore),before);assert.equal(read(hidden),'secret\n');
});

test('A-T57 an empty included git configuration file is snapshotted: its change mid-run is named and undone',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  // Inside the project's .git, so recovery restores it; empty, so git config --show-origin never names it.
  const included=put(path.join(f.target,'.git','included.gitconfig'),'');f.git(f.target,'config','include.path','included.gitconfig');
  const result=liveRun(f,next,`afterCopy:n=>{if(n===1)fs.writeFileSync(${J(included)},'[core]\\n\\tautocrlf = false\\n')}`);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(differed(result).includes(included),result.stderr);
  assert.ok(fs.existsSync(included),'the empty included file is put back, not removed');assert.equal(read(included),'');
});

test('A-T57 a missing system configuration candidate is recorded as absent: an empty one created mid-run is named',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const system=path.join(f.root,'system.gitconfig'),env={...f.env,GIT_CONFIG_SYSTEM:system};delete env.GIT_CONFIG_NOSYSTEM;
  const result=f.exec(process.execPath,[driver(f,next,{target:f.target,'live-memory':true},`afterCopy:n=>{if(n===1)fs.writeFileSync(${J(system)},'')}`)],{env});
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(differed(result).includes(system),result.stderr);
});

// A shim where `link` is a file symlink whose target text is kept in `spelling` and which reaches `referent`
// (lstat, readlink, realpath, realpath.native, stat; symlinkSync rewrites both). Where file symlinks are forbidden.
const linkShim=(link,referent,spelling)=>`import path from 'node:path';
const link=${J(link)}.toLowerCase(),is=file=>typeof file==='string'&&path.resolve(file).toLowerCase()===link,referent=${J(referent)};
const lstat=fs.lstatSync,stat=fs.statSync,readlink=fs.readlinkSync,real=fs.realpathSync,symlink=fs.symlinkSync,save=fs.writeFileSync;
fs.lstatSync=function(file,...rest){const s=lstat.call(fs,file,...rest);if(!s||!is(file))return s;return Object.assign(Object.create(Object.getPrototypeOf(s)),s,{isSymbolicLink:()=>true,isFile:()=>false,isDirectory:()=>false});};
fs.statSync=function(file,...rest){return stat.call(fs,is(file)?referent:file,...rest);};
fs.readlinkSync=function(file,...rest){return is(file)?fs.readFileSync(${J(spelling)},'utf8'):readlink.call(fs,file,...rest);};
const shim=function(file,...rest){return is(file)?referent:real.call(fs,file,...rest);};shim.native=function(file,...rest){return is(file)?referent:real.native.call(fs,file,...rest);};fs.realpathSync=shim;
fs.symlinkSync=function(to,file,...rest){if(!is(file))return symlink.call(fs,to,file,...rest);save.call(fs,file,fs.readFileSync(referent));save.call(fs,${J(spelling)},to);};`;

for(const mode of ['emulated','real']) test(`A-T58 an imported instruction link keeps its identity: a respelled alias and a missing import created mid-run are named (${mode} link)`,t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const shared=path.join(f.root,'shared'),referent=put(path.join(shared,'rules.md'),'# Shared rules\n'),via=path.join(f.root,'shared-via');junction(shared,via);
  const alias=path.join(f.root,'alias-rules.md'),missing=path.join(f.root,'missing-rules.md'),respelled=path.join(via,'rules.md'),spelling=path.join(f.root,'spelling.txt');
  put(path.join(f.target,'CLAUDE.md'),'@../alias-rules.md\n@../missing-rules.md\n');
  let script;
  if(mode==='real') {
    try { fs.symlinkSync(referent,alias,'file'); }
    catch(error) { if(['EPERM','EACCES'].includes(error.code)) return t.skip('this system forbids file symlinks ('+error.code+')'); throw error; }
    script=driver(f,next,{target:f.target,'live-memory':true},`afterCopy:n=>{if(n===1){fs.rmSync(${J(alias)});fs.symlinkSync(${J(respelled)},${J(alias)},'file');fs.writeFileSync(${J(missing)},'# now here\\n');}}`);
  } else {
    put(alias,fs.readFileSync(referent));put(spelling,referent);
    script=driver(f,next,{target:f.target,'live-memory':true},`afterCopy:n=>{if(n===1){fs.writeFileSync(${J(spelling)},${J(respelled)});fs.writeFileSync(${J(missing)},'# now here\\n');}}`,linkShim(alias,referent,spelling));
  }
  const result=f.exec(process.execPath,[script]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  const message=differed(result);
  assert.ok(message.includes(alias),'the respelled alias is named: '+result.stderr);
  assert.ok(message.includes(missing),'the missing import, now present, is named: '+result.stderr);
  assert.equal(read(referent),'# Shared rules\n');
});

test('A-T59 a folder above the backup swapped for a junction to an outside copy: preservation is refused there',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const engine=path.join(f.target,'scripts','memory'),outside=path.join(f.root,'outside-engine'),moved=path.join(f.root,'moved-engine'),extra=path.join(f.target,'extra.txt');
  // After the hook refresh: copy the engine folder (backup included) outside, move the real one aside, and put a
  // junction to the copy in its place; an unplanned file then forces a rollback that must keep states somewhere.
  const hooks=`afterHook:()=>{fs.cpSync(${J(engine)},${J(outside)},{recursive:true});fs.renameSync(${J(engine)},${J(moved)});fs.symlinkSync(${J(outside)},${J(engine)},'junction');fs.writeFileSync(${J(extra)},'unplanned\\n');}`;
  const result=liveRun(f,next,hooks);
  assert.equal(result.status,1,result.stdout+result.stderr);
  const failure=errors(result).find(line=>line.startsWith('upgrade: rollback failed: '));
  assert.ok(failure,result.stderr);
  const snapshot=/every original in the scope is kept in (.+?); original:/.exec(failure)?.[1];if(snapshot) t.after(()=>fs.rmSync(snapshot,{recursive:true,force:true}));
  const backup=fs.readdirSync(outside).find(name=>name.startsWith('.kit-backup-'));
  assert.ok(backup&&!fs.existsSync(path.join(outside,backup,'unplanned')),'nothing was kept under the outside copy');
  assert.ok(!fs.existsSync(path.join(moved,backup,'unplanned')),'nor under the real backup');
  assert.equal(read(extra),'unplanned\n','the unexpected state is not destroyed');
  fs.rmSync(engine);fs.renameSync(moved,engine);
});

// Fail closed (S2): a git input whose location cannot be established exactly refuses before the lock.
function assertInputRefusal(f,what,run) {
  const before=everything(f),result=run();
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).some(line=>line.startsWith(`upgrade: cannot establish the git input ${what} (`)&&line.endsWith('); nothing written')),result.stderr);
  assert.deepEqual(everything(f),before,'nothing written');
}
// A prelude that changes what `git var GIT_CONFIG_SYSTEM|GIT_CONFIG_GLOBAL` returns inside the run; `body` sees
// command, args, options and spawn (the real spawnSync).
const gitVar=body=>`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const spawn=cp.spawnSync;
cp.spawnSync=function(command,args,options){if(command!=='git'||!args.includes('var')||!args.some(a=>/^GIT_CONFIG_(SYSTEM|GLOBAL)$/.test(a)))return spawn.call(cp,command,args,options);${body}};
syncBuiltinESMExports();`;
// An older git whose built-in system file is KIT_TEST_SYSTEM: git var does not know the variables (it answers as
// real git does for any unknown one), and the system file is set only in git's environment, not the updater's.
const olderGit=`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const spawn=cp.spawnSync,system=process.env.KIT_TEST_SYSTEM;delete process.env.KIT_TEST_SYSTEM;
cp.spawnSync=function(command,args,options){if(command==='git'){if(args.includes('var'))args=args.map(a=>/^GIT_CONFIG_(SYSTEM|GLOBAL)$/.test(a)?'GIT_KIT_NO_SUCH_VARIABLE':a);options={...options,env:{...(options?.env??process.env),GIT_CONFIG_SYSTEM:system}};}return spawn.call(cp,command,args,options);};
syncBuiltinESMExports();`;

test('A-T60 a relative GIT_CONFIG_GLOBAL is refused before the lock',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const env={...f.env,GIT_CONFIG_GLOBAL:'kit-global.gitconfig'};
  assert.equal(f.exec('git',['-C',f.target,'var','GIT_CONFIG_GLOBAL'],{env}).stdout.trim(),'kit-global.gitconfig','git prints the relative value as it is');
  assertInputRefusal(f,'GIT_CONFIG_GLOBAL',()=>upgrade(f,['--live-memory'],next,{env}));
});

test('A-T60 an include path with %(prefix) is refused before the lock',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  f.git(f.target,'config','include.path','%(prefix)/etc/kit-example.gitconfig');
  assertInputRefusal(f,'include.path "%(prefix)/etc/kit-example.gitconfig"',()=>upgrade(f,['--live-memory'],next));
});

test('A-T60 a relative core.excludesFile is refused before the lock',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  f.git(f.target,'config','core.excludesFile','kit-ignore');
  assertInputRefusal(f,'core.excludesFile',()=>upgrade(f,['--live-memory'],next));
});

test('A-T61 git var failing with status 128 is refused before the lock, not taken for an older git',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const script=driver(f,next,{target:f.target,'live-memory':true},'',gitVar(`return {pid:0,output:[null,'','fatal: kit test failure\\n'],stdout:'',stderr:'fatal: kit test failure\\n',status:128,signal:null};`));
  assertInputRefusal(f,'GIT_CONFIG_SYSTEM',()=>f.exec(process.execPath,[script]));
});

test('A-T61 git var with status 0 and a warning is refused before the lock',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  assert.equal(f.exec('git',['-C',f.target,'var','GIT_CONFIG_GLOBAL']).status,0);
  const script=driver(f,next,{target:f.target,'live-memory':true},'',gitVar(`const r=spawn.call(cp,command,args,options);if(args.includes('GIT_CONFIG_GLOBAL'))r.stderr+='warning: kit test warning\\n';return r;`));
  assertInputRefusal(f,'GIT_CONFIG_GLOBAL',()=>f.exec(process.execPath,[script]));
});

test('A-T61 an older git: the missing system file git config --system names is recorded absent; created empty mid-run, the run is undone',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const C={LC_ALL:'C',LANG:'C'},unknown=f.exec('git',['-C',f.target,'var','GIT_KIT_NO_SUCH_VARIABLE'],{env:{...f.env,...C}});
  assert.deepEqual([unknown.status,unknown.stdout,unknown.stderr.replace(/\r?\n$/,'')],[129,'','usage: git var (-l | <variable>)'],'what every git answers for a variable it does not know');
  const system=path.join(f.root,'builtin-system.gitconfig'),env={...f.env,KIT_TEST_SYSTEM:system};delete env.GIT_CONFIG_NOSYSTEM;delete env.GIT_CONFIG_SYSTEM;
  const listed=f.exec('git',['-C',f.target,'config','--system','--list','--show-origin','-z'],{env:{...env,...C,GIT_CONFIG_SYSTEM:system}});
  assert.equal(listed.status,128);assert.match(listed.stderr,/^fatal: unable to read config file '.+': No such file or directory\r?\n$/);
  // Created empty mid-run: git no longer names it (no entries, no read error), so the listing under the lock
  // cannot establish it and the run takes the later-error path.
  const log=path.join(f.root,'inputs.json'),start={project:tree(f.target),memory:withoutLock(tree(f.memory))};
  const script=driver(f,next,{target:f.target,'live-memory':true},`afterSnapshot:s=>fs.writeFileSync(${J(log)},JSON.stringify([...s.inputs.values()])),afterCopy:n=>{if(n===1)fs.writeFileSync(${J(system)},'')}`,olderGit);
  const result=f.exec(process.execPath,[script],{env});
  assert.ok(json(log).map(file=>slash(file).toLowerCase()).includes(slash(system).toLowerCase()),'the missing system file is an input: '+fs.readFileSync(log,'utf8'));
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).some(line=>/^upgrade: restored .+\.kit-backup-.+: cannot establish the git input GIT_CONFIG_SYSTEM \(/.test(line)),result.stderr);
  assert.deepEqual(tree(f.target),start.project);assert.deepEqual(withoutLock(tree(f.memory)),start.memory);
});

test('A-T61 an older git with an existing system file that has no entries is refused before the lock',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const system=put(path.join(f.root,'builtin-system.gitconfig'),''),env={...f.env,KIT_TEST_SYSTEM:system};delete env.GIT_CONFIG_NOSYSTEM;delete env.GIT_CONFIG_SYSTEM;
  const script=driver(f,next,{target:f.target,'live-memory':true},'',olderGit);
  assertInputRefusal(f,'GIT_CONFIG_SYSTEM',()=>f.exec(process.execPath,[script],{env}));
});

// git config --show-origin names a repository's files relative to the work tree root, not to a target below it.
const relativeInclude=dir=>{ put(path.join(dir,'.git','included.gitconfig'),'[kit]\n\tprobe = 1\n'); };
test('A-T62 a target below the work tree root, where git names a configuration file relatively, is refused before the lock',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  // The project becomes a folder of a work tree rooted one level up.
  fs.rmSync(path.join(f.target,'.git'),{recursive:true,force:true});f.git(f.root,'init','-q');
  relativeInclude(f.root);f.git(f.root,'config','include.path','included.gitconfig');
  const origins=f.git(f.target,'config','--list','--show-origin');
  assert.match(origins,/^file:\.git\/included\.gitconfig\tkit\.probe=1$/m,'git names the included file relative to the root: '+origins);
  assertInputRefusal(f,'configuration file ".git/config"',()=>upgrade(f,['--live-memory'],next));
});

test('A-T62 the same relative include with the target at the work tree root still upgrades',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  relativeInclude(f.target);f.git(f.target,'config','include.path','included.gitconfig');
  ok(upgrade(f,['--live-memory'],next));
});

test('A-T63 a relative XDG_CONFIG_HOME is refused before the lock, never resolved against the updater folder',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  assertInputRefusal(f,'XDG_CONFIG_HOME',()=>upgrade(f,['--live-memory'],next,{env:{...f.env,XDG_CONFIG_HOME:'kit-xdg'}}));
});

test('A-T64 an older git that honours an exact GIT_CONFIG_SYSTEM records that empty system file instead of refusing',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const system=put(path.join(f.root,'explicit-system.gitconfig'),''),env={...f.env,GIT_CONFIG_SYSTEM:system};delete env.GIT_CONFIG_NOSYSTEM;
  const log=path.join(f.root,'inputs.json');
  const script=driver(f,next,{target:f.target,'live-memory':true},`afterSnapshot:s=>fs.writeFileSync(${J(log)},JSON.stringify([...s.inputs.values()]))`,gitVar(`return spawn.call(cp,command,args.map(a=>/^GIT_CONFIG_(SYSTEM|GLOBAL)$/.test(a)?'GIT_KIT_NO_SUCH_VARIABLE':a),options);`));
  const result=f.exec(process.execPath,[script],{env});
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.ok(json(log).map(file=>slash(file).toLowerCase()).includes(slash(system).toLowerCase()),fs.readFileSync(log,'utf8'));
});

test('A-T65 GIT_CONFIG_COUNT in the environment does not reach the listing: a file it would hide stays in scope',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const notes=put(path.join(f.target,'notes.txt'),'notes\n'),hide=put(path.join(f.root,'hide.ignore'),'notes.txt\n');
  const env={...f.env,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.excludesFile',GIT_CONFIG_VALUE_0:hide};
  const script=driver(f,next,{target:f.target,'live-memory':true},`afterCopy:n=>{if(n===1)fs.writeFileSync(${J(notes)},'changed\\n')}`);
  const result=f.exec(process.execPath,[script],{env});
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(differed(result).includes(notes),result.stderr);
  assert.equal(read(notes),'notes\n');
});

// rev-parse for the worktree check fails inside the run (the other git calls are real).
const worktreeUnknown=`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const spawn=cp.spawnSync;
cp.spawnSync=function(command,args,options){if(command==='git'&&args.includes('--git-common-dir')&&args.includes('--absolute-git-dir'))return {pid:0,output:[null,'','fatal: kit test failure\\n'],stdout:'',stderr:'fatal: kit test failure\\n',status:128,signal:null};return spawn.call(cp,command,args,options);};
syncBuiltinESMExports();`;
test('A-T66 a linked worktree whose state git cannot report is refused, not taken for a main checkout',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);const wt=withWorktree(f);
  const start={wt:tree(wt),memory:withoutLock(tree(f.memory))};
  const script=driver(f,next,{target:wt,'live-memory':true},'',worktreeUnknown);
  const result=f.exec(process.execPath,[script]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.match(result.stderr,/cannot tell whether .+ is a linked worktree \(git rev-parse exited 128: fatal: kit test failure\)/);
  assert.deepEqual(tree(wt),start.wt);assert.deepEqual(withoutLock(tree(f.memory)),start.memory);
});

test('A-T67 the target turning into a linked worktree under the lock is drift: nothing written',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const other=path.join(f.root,'other'),wtx=path.join(f.root,'wtx');fs.mkdirSync(other);
  f.git(other,'init','-q');put(path.join(other,'a.txt'),'a\n');f.git(other,'add','a.txt');f.git(other,'commit','-q','-m','a');f.git(other,'worktree','add','-q',wtx);
  const gitDir=path.join(f.target,'.git'),start={project:tree(f.target),memory:withoutLock(tree(f.memory))};
  const result=liveRun(f,next,`afterPlan:()=>{fs.renameSync(${J(gitDir)},${J(gitDir+'-real')});fs.copyFileSync(${J(path.join(wtx,'.git'))},${J(gitDir)});}`);
  if(fs.existsSync(gitDir+'-real')) { fs.rmSync(gitDir,{recursive:true,force:true});fs.renameSync(gitDir+'-real',gitDir); }
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).some(line=>/^upgrade: memory or project files changed while planning \(linked worktree state of .+\); nothing written; run again$/.test(line)),result.stderr);
  assert.deepEqual(tree(f.target),start.project);assert.deepEqual(withoutLock(tree(f.memory)),start.memory);
});

test('A-T68 a lock-named remnant in memory is not copied into the backup',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  put(path.join(f.memory,'.memory.lock.stale-kit'),'remnant\n');
  const result=upgrade(f,['--live-memory'],next);ok(result);
  const saved=path.join(backupOf(result),'memory');
  assert.ok(fs.existsSync(saved),'the backup holds memory files');
  assert.deepEqual(fs.readdirSync(saved).filter(name=>name.startsWith('.memory.lock')),[]);
});

test('A-T69 a restore map entry without a boolean existed is refused, not read as a delete',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const result=upgrade(f,['--live-memory'],next);ok(result);
  const backup=backupOf(result),map=path.join(backup,'restore.json'),recovery=json(map);
  const entry=recovery.files.find(e=>e.existed===true);assert.ok(entry,'an entry for a file that existed');
  delete entry.existed;fs.writeFileSync(map,JSON.stringify(recovery,null,2)+'\n');
  const file=path.join(f.target,entry.file),before=bytes(file);
  const restore=upgrade(f,['--restore',backup,'--live-memory'],next);
  assert.equal(restore.status,1,restore.stdout+restore.stderr);
  assert.match(restore.stderr,/invalid restore\.json/);
  assert.equal(bytes(file),before);
});

test('A-T70 an ancestor of a destination that cannot be read is refused, not passed over (emulated EACCES)',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const scripts=path.join(f.target,'scripts');
  const prelude=`import path from 'node:path';const lstat=fs.lstatSync;
fs.lstatSync=function(file,...rest){if(typeof file==='string'&&path.resolve(file).toLowerCase()===${J(scripts.toLowerCase())}&&/\\bat parents\\b/.test(new Error().stack)){const e=new Error('EACCES: permission denied, lstat');e.code='EACCES';throw e;}return lstat.call(fs,file,...rest);};`;
  const script=driver(f,next,{target:f.target,'live-memory':true},'',prelude);
  const before=everything(f),result=f.exec(process.execPath,[script]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).some(line=>line.includes(`cannot resolve ${scripts} (EACCES); nothing written`)),result.stderr);
  assert.deepEqual(everything(f),before);
});

test('A-T71 a special file in the scope is refused up front (emulated: this system cannot make a fifo)',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const special=put(path.join(f.target,'special.fifo'),'');
  const prelude=`import path from 'node:path';const lstat=fs.lstatSync;
fs.lstatSync=function(file,...rest){const s=lstat.call(fs,file,...rest);if(!s||typeof file!=='string'||path.resolve(file).toLowerCase()!==${J(special.toLowerCase())})return s;return Object.assign(Object.create(Object.getPrototypeOf(s)),s,{isFile:()=>false,isDirectory:()=>false,isSymbolicLink:()=>false,isFIFO:()=>true});};`;
  const script=driver(f,next,{target:f.target,'live-memory':true},'',prelude);
  const before=everything(f),result=f.exec(process.execPath,[script]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).some(line=>line===`upgrade: cannot protect the special file ${special} (a fifo, socket or device cannot be kept or restored); nothing written`),result.stderr);
  assert.deepEqual(everything(f),before);
});

test('A-T72 the restore memory mismatch compares fresh canonical folders, not a cached one',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const copyA=copyMemory(f,'copy-a'),copyB=copyMemory(f,'copy-b'),link=path.join(f.root,'memory-link');
  const result=upgrade(f,['--memory-dir',copyA],next);ok(result);
  const backup=backupOf(result);
  junction(copyA,link);
  // The process has seen the link reach copy-a (the path cache keeps that); then it is moved to copy-b.
  const prelude=`import {pathKey} from ${J(pathToFileURL(path.join(next,'engine/lib.mjs')).href)};
pathKey(${J(link)});fs.rmSync(${J(link)});fs.symlinkSync(${J(copyB)},${J(link)},'junction');`;
  const script=driver(f,next,{target:f.target,restore:backup,'memory-dir':link},'',prelude);
  const out=f.exec(process.execPath,[script]);
  assert.equal(out.status,1,out.stdout+out.stderr);
  assert.ok(errors(out).some(line=>/^upgrade: backup .+ restores memory .+copy-a, not .+memory-link; nothing restored$/.test(line)),out.stderr);
});

test('A-T63 an explicitly empty XDG_CONFIG_HOME is refused, not taken for unset',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  assertInputRefusal(f,'XDG_CONFIG_HOME',()=>upgrade(f,['--live-memory'],next,{env:{...f.env,XDG_CONFIG_HOME:''}}));
});

test('A-T63 an empty or a relative HOME is refused, naming HOME',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  for(const HOME of ['','kit-home']) assertInputRefusal(f,'HOME',()=>upgrade(f,['--live-memory'],next,{env:{...f.env,HOME}}));
});

test('A-T63 a relative USERPROFILE, with HOME unset, is refused, naming USERPROFILE',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);const copy=copyMemory(f);
  const env={...f.env,USERPROFILE:'kit-profile'};delete env.HOME;
  assertInputRefusal(f,'USERPROFILE',()=>upgrade(f,['--memory-dir',copy],next,{env}));
});

// The home folder is checked whenever the scope inventory runs, not only on the paths where git reads it: a set
// GIT_CONFIG_GLOBAL, XDG_CONFIG_HOME or core.excludesFile each used to let an empty or relative HOME through.
const homeCombos=[true,false].flatMap(global=>['full','unset'].map(xdg=>({global,xdg})));
const homeComboName=(combo,excludes)=>`GIT_CONFIG_GLOBAL ${combo.global?'set':'unset'}, XDG_CONFIG_HOME ${combo.xdg}, core.excludesFile ${excludes?'set':'unset'}`;
// `home` holds the HOME and USERPROFILE values for the run; undefined removes the variable.
function homeEnv(f,combo,home) {
  const env={...f.env,...home};
  for(const [name,value] of Object.entries(home)) if(value===undefined) delete env[name];
  if(!combo.global) delete env.GIT_CONFIG_GLOBAL;
  if(combo.xdg==='full') env.XDG_CONFIG_HOME=path.join(f.root,'xdg-config');
  else delete env.XDG_CONFIG_HOME;
  return env;
}
const setExcludesFile=f=>f.git(f.target,'config','core.excludesFile',path.join(f.root,'global-ignore'));
function inCase(label,body) {
  try { return body(); } catch(error) { error.message=label+': '+error.message; throw error; }
}
// The setup (install and bump) must not read the developer's XDG_CONFIG_HOME: an inherited $XDG_CONFIG_HOME/git/ignore
// could change the install. Each upgrade run below sets or removes the variable itself, through homeEnv.
function homeFixture(t) {
  const f=fixture(t);
  delete f.env.XDG_CONFIG_HOME;
  return f;
}

test('A-T63 an empty or a relative HOME is refused, naming HOME, whichever other git inputs are set',t=>{
  const f=homeFixture(t);ok(f.install());const next=bump(f);
  for(const excludes of [false,true]) {
    if(excludes) setExcludesFile(f);
    for(const combo of homeCombos) for(const HOME of ['','kit-home'])
      inCase(`HOME ${JSON.stringify(HOME)}, ${homeComboName(combo,excludes)}`,()=>assertInputRefusal(f,'HOME',()=>upgrade(f,['--live-memory'],next,{env:homeEnv(f,combo,{HOME})})));
  }
});

test('A-T63 a relative USERPROFILE, with HOME unset, is refused, naming USERPROFILE, whichever other git inputs are set',t=>{
  const f=homeFixture(t);ok(f.install());const next=bump(f);const copy=copyMemory(f);
  for(const excludes of [false,true]) {
    if(excludes) setExcludesFile(f);
    for(const combo of homeCombos)
      inCase(`USERPROFILE "kit-profile", HOME unset, ${homeComboName(combo,excludes)}`,()=>assertInputRefusal(f,'USERPROFILE',()=>upgrade(f,['--memory-dir',copy],next,{env:homeEnv(f,combo,{HOME:undefined,USERPROFILE:'kit-profile'})})));
  }
});

test('A-T63 a full HOME is not refused, with each combination of the other git inputs',t=>{
  let next;
  for(const excludes of [false,true]) for(const combo of homeCombos) inCase(homeComboName(combo,excludes),()=>{
    const f=homeFixture(t);ok(f.install());next??=bump(f);
    if(excludes) setExcludesFile(f);
    const result=ok(upgrade(f,['--live-memory'],next,{env:homeEnv(f,combo,{})}));
    assert.ok(!errors(result).some(line=>line.startsWith('upgrade: cannot establish the git input')),result.stderr);
  });
});

test('A-T66 GIT_DIR and GIT_WORK_TREE naming another repository cannot make a linked worktree look like a main checkout',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);const wt=withWorktree(f);
  const other=path.join(f.root,'other');fs.mkdirSync(other);f.git(other,'init','-q');
  const start={wt:tree(wt),memory:withoutLock(tree(f.memory))};
  const result=run(f,wt,['--live-memory'],next,{env:{...f.env,GIT_DIR:path.join(other,'.git'),GIT_WORK_TREE:other}});
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).some(line=>line.startsWith('upgrade: refusing --live-memory from a linked worktree ')),result.stderr);
  assert.deepEqual(tree(wt),start.wt);assert.deepEqual(withoutLock(tree(f.memory)),start.memory);
});

test('A-T73 hookPlan and the gate child get no GIT_DIR from the environment',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const log=path.join(f.root,'git-env.json');
  const prelude=`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
import {hookPlan} from ${J(pathToFileURL(path.join(next,'engine/install-hooks.mjs')).href)};
const seen=[];let phase='hookPlan';
const record=(command,args,options)=>{if(command==='git'||(command===process.execPath&&args.some(a=>/memory-check\\.mjs$/.test(a))))seen.push({phase,command:command==='git'?'git':'gate',gitDir:'GIT_DIR' in (options?.env??process.env)});};
const spawn=cp.spawnSync,execFile=cp.execFileSync;
cp.spawnSync=function(command,args,options){record(command,args,options);return spawn.call(cp,command,args,options);};
cp.execFileSync=function(command,args,options){record(command,args,options);return execFile.call(cp,command,args,options);};
syncBuiltinESMExports();
process.on('exit',()=>fs.writeFileSync(${J(log)},JSON.stringify(seen)));
process.env.GIT_DIR=${J(path.join(f.root,'no-such-repo','.git'))};
hookPlan({memoryDir:${J(f.memory)},repo:${J(f.target)}});
phase='upgrade';`;
  const result=f.exec(process.execPath,[driver(f,next,{target:f.target,'live-memory':true},'',prelude)]);
  const seen=json(log);
  assert.ok(seen.some(e=>e.phase==='hookPlan'&&e.command==='git'),'hookPlan ran git: '+J(seen));
  assert.ok(seen.some(e=>e.phase==='upgrade'&&e.command==='gate'),'the gate ran: '+J(seen)+result.stderr);
  assert.deepEqual(seen.filter(e=>(e.phase==='hookPlan'||e.command==='gate')&&e.gitDir),[],J(seen));
});

test('A-T74 a special file at the top of memory is refused before any read (emulated fifo)',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);
  const pipe=put(path.join(f.memory,'pipe'),'');
  const prelude=`import path from 'node:path';const lstat=fs.lstatSync,readFile=fs.readFileSync,is=file=>typeof file==='string'&&path.resolve(file).toLowerCase()===${J(pipe.toLowerCase())};
fs.lstatSync=function(file,...rest){const s=lstat.call(fs,file,...rest);if(!s||!is(file))return s;return Object.assign(Object.create(Object.getPrototypeOf(s)),s,{isFile:()=>false,isDirectory:()=>false,isSymbolicLink:()=>false,isFIFO:()=>true});};
fs.readFileSync=function(file,...rest){if(is(file))throw new Error('kit test: this read would block');return readFile.call(fs,file,...rest);};`;
  const script=driver(f,next,{target:f.target,'live-memory':true},'',prelude);
  const before=everything(f),result=f.exec(process.execPath,[script]);
  assert.notEqual(result.status,0,result.stdout+result.stderr);
  assert.match(result.stderr,/cannot protect the special file .+pipe \(a fifo, socket or device cannot be kept or restored\); nothing written/);
  assert.ok(!result.stderr.includes('this read would block'),result.stderr);
  assert.deepEqual(everything(f),before);
});

// ---- The input check compares the selection after the writes with the plan's prediction. ----
// A copy of this kit, installable, whose README is `readme(text)`.
function kitCopy(f,name,readme) {
  const root=path.join(f.root,name);fs.mkdirSync(root);
  for(const entry of fs.readdirSync(kitRoot)) {
    const source=path.join(kitRoot,entry),relative=path.relative(source,f.root);
    if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))) continue;
    fs.cpSync(source,path.join(root,entry),{recursive:true});
  }
  const doc=path.join(root,'engine/README.md');put(doc,readme(read(doc)));
  ok(f.cli('scripts/manifest.mjs',[],root));return root;
}
// A project whose instructions name the kit's README (and any `mentions`), and a new kit whose README is `readme(old)`.
// With `installed`, the project was installed from a kit whose README is `installed(text)`.
function reach(t,{readme=text=>text+'\nSee `kit-fix-new-doc.md`.\n',installed=null,mentions=[]}={}) {
  const f=fixture(t);ok(installed?f.install([],kitCopy(f,'old-kit',installed)):f.install());
  fs.appendFileSync(path.join(f.target,'AGENTS.md'),['','Kit notes: `scripts/memory/README.md`',...mentions.map(file=>'Also: `'+file+'`'),''].join('\n'));
  const next=bump(f),doc=path.join(next,'engine/README.md'),old=read(doc),changed=readme(old);
  assert.notEqual(changed,old,'the new kit README changed');
  put(doc,changed);ok(f.cli('scripts/manifest.mjs',[],next));
  return {f,next};
}
const gatePasses=f=>ok(f.exec(process.execPath,[path.join(f.target,'scripts/memory/memory-check.mjs'),'--repo',f.target,'--memory-dir',f.memory,'--no-git']));
const completed=result=>{
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.ok(lines(result).some(line=>line.startsWith('upgrade: complete (')),result.stdout);
  assert.ok(!result.stderr.includes('writes differed from the plan'),result.stderr);
};
const named=(message,file)=>message.toLowerCase().includes(file.toLowerCase());

test('A-T75 an update whose instructions reach a rewritten kit document completes when that document names new files',t=>{
  const {f,next}=reach(t);
  completed(upgrade(f,['--live-memory'],next));
  assert.ok(read(path.join(f.target,'scripts/memory/README.md')).includes('kit-fix-new-doc.md'),'the README was rewritten');
  gatePasses(f);
});

test('A-T76 an update completes when the rewritten document stops naming a file the instructions reached through it',t=>{
  const {f,next}=reach(t,{installed:text=>text+'\nSee `kit-fix-old-doc.md`.\n',readme:text=>text+'\nA line that names no file.\n'});
  assert.ok(read(path.join(f.target,'scripts/memory/README.md')).includes('kit-fix-old-doc.md'),'the installed README names the file');
  completed(upgrade(f,['--live-memory'],next));
  assert.ok(!read(path.join(f.target,'scripts/memory/README.md')).includes('kit-fix-old-doc.md'),'the README was rewritten');
  gatePasses(f);
});

test('A-T77 a file the plan deletes is no longer followed: the names it held are predicted gone',t=>{
  const f=fixture(t);ok(f.install());
  fs.appendFileSync(path.join(f.target,'AGENTS.md'),'\nUpgrade notes: `scripts/memory/UPGRADE.md`\n');
  const next=bump(f),installed='scripts/memory/UPGRADE.md';
  fs.rmSync(path.join(next,'docs/UPGRADE.md'));
  const ledger=path.join(next,'engine/upgrades.json'),rows=json(ledger);rows.at(-1).retired=[...(rows.at(-1).retired??[]),installed];put(ledger,JSON.stringify(rows,null,2));
  ok(f.cli('scripts/manifest.mjs',[],next));
  assert.ok(lines(upgrade(f,['--check'],next)).includes('DELETE '+installed));
  completed(upgrade(f,['--live-memory'],next));
  assert.ok(!fs.existsSync(path.join(f.target,installed)));
  gatePasses(f);
});

test('A-T78 a name the merged configuration adds is read from the planned configuration',t=>{
  const f=fixture(t);ok(f.install());
  const configFile=path.join(f.target,'scripts/memory/memory.config.json'),config=json(configFile);
  delete config.caps.guard.kitRules;put(configFile,JSON.stringify(config,null,2)+'\n');
  const next=bump(f),defaults=path.join(next,'engine/memory.config.json'),nextConfig=json(defaults);
  nextConfig.caps.guard.kitRules='docs/kit-rules-extra.json';put(defaults,JSON.stringify(nextConfig,null,2)+'\n');ok(f.cli('scripts/manifest.mjs',[],next));
  completed(upgrade(f,['--live-memory'],next));
  assert.equal(json(configFile).caps.guard.kitRules,'docs/kit-rules-extra.json','the merged configuration holds the new name');
});

test('A-T79 an outside writer adds a mention to an instruction file the plan does not write: refused and undone',t=>{
  const {f,next}=reach(t);
  const local=put(path.join(f.target,'CLAUDE.local.md'),'Local notes.\n'),start=tree(f.target);
  const result=liveRun(f,next,`afterCopy:n=>{if(n===1)fs.appendFileSync(${J(local)},'See \`outside-added.md\`.\\n')}`);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(named(differed(result),local),result.stderr);
  assert.equal(read(local),'Local notes.\n');assert.deepEqual(tree(f.target),start);
});

test('A-T80 an outside writer deletes an instruction input the plan does not touch: refused and undone',t=>{
  const {f,next}=reach(t,{mentions:['docs/notes.md']});
  const notes=put(path.join(f.target,'docs/notes.md'),'# Notes\n'),start=tree(f.target);
  const result=liveRun(f,next,`afterCopy:n=>{if(n===1)fs.rmSync(${J(notes)})}`);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(named(differed(result),notes),result.stderr);
  assert.equal(read(notes),'# Notes\n');assert.deepEqual(tree(f.target),start);
});

// Outside the project, folder links the instructions reach through: swapping one changes the file a mention
// resolves to without changing any file that was in the snapshot, so only the input selection can name it.
function folderLinks(f,names) {
  const dirs={};
  for(const name of names) { dirs[name]=path.join(f.root,name);put(path.join(dirs[name],'guide.md'),'# Guide\n'); }
  return dirs;
}
const swapLink=(link,to)=>`afterCopy:n=>{if(n===1){fs.rmSync(${J(link)});fs.symlinkSync(${J(to)},${J(link)},'junction');}}`;

test('A-T81 a mention that resolves to a new file mid-run is an added input, named and undone',t=>{
  const {f,next}=reach(t,{mentions:['../via/guide.md','../keep/guide.md']});
  const dirs=folderLinks(f,['a']),empty=path.join(f.root,'c'),via=path.join(f.root,'via'),keep=path.join(f.root,'keep'),start=tree(f.target);
  fs.mkdirSync(empty);junction(dirs.a,via);junction(dirs.a,keep);
  const result=liveRun(f,next,swapLink(via,empty));
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(named(differed(result),path.join(empty,'guide.md')),'the added input is named: '+result.stderr);
  assert.ok(!named(differed(result),path.join(dirs.a,'guide.md')),'the input that stayed is not named: '+result.stderr);
  assert.deepEqual(tree(f.target),start);
});

test('A-T82 a mention that stops reaching a file mid-run is a dropped input, named and undone',t=>{
  const {f,next}=reach(t,{mentions:['../via/guide.md','../other/guide.md']});
  const dirs=folderLinks(f,['a','b']),via=path.join(f.root,'via'),other=path.join(f.root,'other'),start=tree(f.target);
  junction(dirs.a,via);junction(dirs.b,other);
  const result=liveRun(f,next,swapLink(via,dirs.b));
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(named(differed(result),path.join(dirs.a,'guide.md')),'the dropped input is named: '+result.stderr);
  assert.ok(!named(differed(result),path.join(dirs.b,'guide.md')),'the input that stayed is not named: '+result.stderr);
  assert.deepEqual(tree(f.target),start);
});

// The predicted selection is made with the first plan and again under the lock: a selection that changed in between
// (as an outside writer's change lands at the afterPlan point) is refused under the lock, before any write. Before
// that, the first listing's selection was only compared after the writes.
test('A-T83 a selection that changed between the first listing and the lock is refused under the lock, nothing written',t=>{
  const {f,next}=reach(t,{mentions:['../via/guide.md','../other/guide.md']});
  const dirs=folderLinks(f,['a','b']),via=path.join(f.root,'via'),other=path.join(f.root,'other'),start=tree(f.target,{previous:true});
  junction(dirs.a,via);junction(dirs.b,other);
  const result=liveRun(f,next,`afterPlan:()=>{fs.rmSync(${J(via)});fs.symlinkSync(${J(dirs.b)},${J(via)},'junction');}`);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).some(line=>line.startsWith('upgrade: memory or project files changed while planning (')&&named(line,path.join(dirs.a,'guide.md'))),'the input the first listing found is named: '+result.stderr);
  assert.equal(differed(result),'','refused before any write, not undone after one');
  assert.deepEqual(tree(f.target,{previous:true}),start);
});

// Existing files that only the rewritten README reaches: one in the project that git ignores, one outside the project.
function reachedOnlyByTheNewReadme(t) {
  const made=reach(t,{readme:text=>text+'\nSee `docs/ignored-guide.md` and `../outside-guide.md`.\n'}),{f}=made;
  put(path.join(f.target,'.gitignore'),'docs/ignored-guide.md\n');
  return {...made,ignored:put(path.join(f.target,'docs/ignored-guide.md'),'# Ignored guide\n'),outside:put(path.join(f.root,'outside-guide.md'),'# Outside guide\n')};
}

test('A-T84 a file only the new documents reach, ignored by git or outside the project, is kept and the update completes',t=>{
  const {f,next,ignored,outside}=reachedOnlyByTheNewReadme(t);
  completed(upgrade(f,['--live-memory'],next));
  assert.equal(read(ignored),'# Ignored guide\n');assert.equal(read(outside),'# Outside guide\n');
  assert.ok(read(path.join(f.target,'scripts/memory/README.md')).includes('outside-guide.md'),'the README was rewritten');
});

test('A-T85 a file only the new documents reach is snapshotted before the writes: changed mid-run, it is named and put back, not deleted',t=>{
  const {f,next,ignored}=reachedOnlyByTheNewReadme(t);
  const result=liveRun(f,next,`afterCopy:n=>{if(n===1)fs.writeFileSync(${J(ignored)},'# Changed mid-run\\n')}`);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(named(differed(result),ignored),result.stderr);
  assert.equal(read(ignored),'# Ignored guide\n');
});

// A project whose instructions name the live hook (and then `more`), and a new kit whose rewritten hook ends with a
// line that names `kit-fix-hook-doc.md`.
function hookThatNamesADocument(f,more='') {
  ok(f.install());
  const hook=hookOf(f.memory);
  fs.appendFileSync(path.join(f.target,'AGENTS.md'),`\nThe hook: @${slash(hook)}\n${more}`);
  const next=bump(f),file=path.join(next,'engine/install-hooks.mjs'),head='export function hookText({ memoryDir, repo, version = loadConfig().engine_version }) {';
  assert.ok(read(file).includes(head));
  put(file,read(file).replace(head,'export function hookText(options) { return hookTextBase(options)+"# See `kit-fix-hook-doc.md`\\n"; }\nfunction hookTextBase({ memoryDir, repo, version = loadConfig().engine_version }) {'));
  ok(f.cli('scripts/manifest.mjs',[],next));
  assert.ok(lines(upgrade(f,['--check'],next)).some(line=>line.startsWith('HOOK ')),'the update rewrites the hook');
  return {next,hook};
}

test('A-T86 a name the planned hook adds is predicted: the update completes with the hook rewritten',t=>{
  const f=fixture(t),{next,hook}=hookThatNamesADocument(f),before=read(hook);
  completed(upgrade(f,['--live-memory'],next));
  assert.ok(read(hook).includes('kit-fix-hook-doc.md')&&read(hook)!==before,'the hook was rewritten with the new name');
});

test('A-T87 a selection that changes after the hook is written, with the hook bytes intact, is refused and undone',t=>{
  const f=fixture(t),dirs=folderLinks(f,['a','b']),via=path.join(f.root,'via');
  junction(dirs.a,via);
  const {next,hook}=hookThatNamesADocument(f,'Also: `../via/guide.md`\n');
  const start={project:tree(f.target),memory:withoutLock(tree(f.memory)),hook:bytes(hook)};
  const result=liveRun(f,next,`afterHook:()=>{fs.rmSync(${J(via)});fs.symlinkSync(${J(dirs.b)},${J(via)},'junction');}`);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(named(differed(result),path.join(dirs.a,'guide.md')),'the dropped input is named: '+result.stderr);
  assert.ok(named(differed(result),path.join(dirs.b,'guide.md')),'the added input is named: '+result.stderr);
  assert.ok(!named(differed(result),hook),'the hook bytes were intact: '+result.stderr);
  assert.deepEqual(tree(f.target),start.project);assert.deepEqual(withoutLock(tree(f.memory)),start.memory);assert.equal(bytes(hook),start.hook);
});

// An existing git-ignored document that only the new README reaches; it names `old-child.md`.
function guideOnlyTheNewReadmeReaches(t) {
  const made=reach(t,{readme:text=>text+'\nSee `docs/ignored-guide.md`.\n'}),{f}=made;
  put(path.join(f.target,'.gitignore'),'docs/ignored-guide.md\n');
  return {...made,guide:put(path.join(f.target,'docs/ignored-guide.md'),'# Ignored guide\nSee `old-child.md`.\n')};
}
// The outside writer's change lands between the first plan and the lock (the afterPlan point): the update is refused
// under the lock, before any write, and writes nothing.
for(const [name,text] of [['names a different file','# Ignored guide\nSee `foreign-child.md`.\n'],['changes only its text','# Ignored guide\nSee `old-child.md`. Reworded.\n']]) test(`A-T88 a document only the new README reaches that ${name} between the plan and the lock refuses the update, nothing written`,t=>{
  const {f,next,guide}=guideOnlyTheNewReadmeReaches(t);
  const start={project:tree(f.target,{previous:true}),memory:withoutLock(tree(f.memory)),hook:bytes(hookOf(f.memory))};
  const result=liveRun(f,next,`afterPlan:()=>fs.writeFileSync(${J(guide)},${J(text)})`);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).some(line=>line.startsWith('upgrade: memory or project files changed while planning (')&&named(line,guide)),result.stderr);
  assert.equal(differed(result),'','refused before any write, not undone after one');
  assert.deepEqual(tree(f.target,{previous:true}),{...start.project,[slash(path.relative(f.target,guide))]:b64(text)});
  assert.deepEqual(withoutLock(tree(f.memory)),start.memory);assert.equal(bytes(hookOf(f.memory)),start.hook);
});

// The memory folder is, or is linked as, .claude/rules, so every .md page in it is an instruction root. The router
// routes `widgets` and no longer `craft-sessions`: the update writes the two widgets pages and deletes the two
// craft-sessions pages. A deleted page is no longer a root and nothing else names it, so only a listing of the
// folder that follows the plan predicts the selection the writes leave.
function reroute(f,memory) {
  const router=path.join(memory,'MEMORY.md'),row='- [Sessions](INDEX-craft-sessions.md) — OPEN BEFORE a checkpoint, handoff or memory write.';
  assert.ok(read(router).includes(row));
  put(router,read(router).replace(row,'- [Widgets](INDEX-widgets.md) — OPEN BEFORE widget work.'));
  const next=bump(f),plan=lines(upgrade(f,['--check','--live-memory'],next));
  for(const line of ['MEMORY WRITE INDEX-widgets.md','MEMORY WRITE INDEX-widgets-all.md','MEMORY DELETE INDEX-craft-sessions.md','MEMORY DELETE INDEX-craft-sessions-all.md']) assert.ok(plan.includes(line),line+'\n'+plan.join('\n'));
  return next;
}
const rerouted=(memory)=>{
  for(const page of ['INDEX-widgets.md','INDEX-widgets-all.md']) assert.ok(fs.existsSync(path.join(memory,page)),page+' was written');
  for(const page of ['INDEX-craft-sessions.md','INDEX-craft-sessions-all.md']) assert.ok(!fs.existsSync(path.join(memory,page)),page+' was deleted');
};

test('A-T89 a memory folder that is .claude/rules: the pages the update writes and deletes there are predicted as instruction roots',t=>{
  const f=fixture(t),rules=path.join(f.target,'.claude/rules');
  ok(f.install(['--memory-dir',rules]));
  const next=reroute(f,rules);
  completed(upgrade(f,['--live-memory'],next));
  rerouted(rules);
});

test('A-T90 a .claude/rules folder that is a link to the memory folder: the same pages are predicted',t=>{
  const f=fixture(t);
  ok(f.install());
  junction(f.memory,path.join(f.target,'.claude/rules'));
  const next=reroute(f,f.memory);
  completed(upgrade(f,['--live-memory'],next));
  rerouted(f.memory);
});

test('A-T91 a file only the new documents reach that is a fifo is refused up front, before any write (emulated fifo)',t=>{
  const {f,next}=reach(t,{readme:text=>text+'\nSee `docs/pipe-guide.md`.\n'});
  put(path.join(f.target,'.gitignore'),'docs/pipe-guide.md\n');
  const pipe=put(path.join(f.target,'docs/pipe-guide.md'),'');
  const prelude=`import path from 'node:path';const lstat=fs.lstatSync,stat=fs.statSync,readFile=fs.readFileSync,is=file=>typeof file==='string'&&path.resolve(file).toLowerCase()===${J(pipe.toLowerCase())};
const fifo=s=>Object.assign(Object.create(Object.getPrototypeOf(s)),s,{isFile:()=>false,isDirectory:()=>false,isSymbolicLink:()=>false,isFIFO:()=>true});
fs.lstatSync=function(file,...rest){const s=lstat.call(fs,file,...rest);return s&&is(file)?fifo(s):s;};
fs.statSync=function(file,...rest){const s=stat.call(fs,file,...rest);return s&&is(file)?fifo(s):s;};
fs.readFileSync=function(file,...rest){if(is(file))throw new Error('kit test: this read would block');return readFile.call(fs,file,...rest);};`;
  const script=driver(f,next,{target:f.target,'live-memory':true},'',prelude),before=everything(f);
  const result=f.exec(process.execPath,[script]);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(errors(result).some(line=>line===`upgrade: cannot protect the special file ${pipe} (a fifo, socket or device cannot be kept or restored); nothing written`),result.stderr);
  assert.ok(!result.stderr.includes('this read would block'),result.stderr);
  assert.deepEqual(everything(f),before,'nothing was written, not even a backup');
});

// The installed README names a document through a folder link outside the project; the new README no longer does. Both
// predictions (before the lock and under it) leave that name out, so comparing them cannot see the link move: only the
// selection before the writes, listed twice, names it.
test('A-T92 a document only the installed README reaches, switched between the first listing and the lock, is refused and undone though the new README no longer names it',t=>{
  const {f,next}=reach(t,{installed:text=>text+'\nSee `../via/guide.md`.\n',readme:text=>text+'\nA line that names no file.\n'});
  const dirs=folderLinks(f,['a','b']),via=path.join(f.root,'via');
  junction(dirs.a,via);
  assert.ok(read(path.join(f.target,'scripts/memory/README.md')).includes('../via/guide.md'),'the installed README names the document');
  assert.ok(!read(path.join(next,'engine/README.md')).includes('../via/guide.md'),'the new README does not');
  const start={project:tree(f.target),memory:withoutLock(tree(f.memory)),hook:bytes(hookOf(f.memory))};
  const result=liveRun(f,next,`afterPlan:()=>{fs.rmSync(${J(via)});fs.symlinkSync(${J(dirs.b)},${J(via)},'junction');}`);
  assert.equal(result.status,1,result.stdout+result.stderr);
  assert.ok(!lines(result).some(line=>line.startsWith('upgrade: complete (')),result.stdout);
  assert.ok(named(differed(result),path.join(dirs.a,'guide.md')),'the document the first listing found is named: '+result.stderr);
  assert.ok(named(differed(result),path.join(dirs.b,'guide.md')),'the document the lock-time listing found is named: '+result.stderr);
  assert.deepEqual(tree(f.target),start.project);assert.deepEqual(withoutLock(tree(f.memory)),start.memory);assert.equal(bytes(hookOf(f.memory)),start.hook);
});

// The memory folder is .claude/rules. The router names `INDEX-widgets-2.md`, a numbered page of the family `widgets`
// that is not on disk, so the update creates `INDEX-widgets.md` and `INDEX-widgets-all.md` and no document names either
// of them: only the listing of the folder after the plan's writes reaches them.
test('A-T93 a page the update creates in a memory folder that is .claude/rules, and nothing names, is predicted from the folder listing',t=>{
  const f=fixture(t),rules=path.join(f.target,'.claude/rules');
  ok(f.install(['--memory-dir',rules]));
  const router=path.join(rules,'MEMORY.md'),row='- [Sessions](INDEX-craft-sessions.md) — OPEN BEFORE a checkpoint, handoff or memory write.';
  assert.ok(read(router).includes(row));
  put(router,read(router).replace(row,row+'\n- [Widgets](INDEX-widgets-2.md) — OPEN BEFORE widget work.'));
  const next=bump(f),plan=lines(upgrade(f,['--check','--live-memory'],next));
  for(const line of ['MEMORY WRITE INDEX-widgets.md','MEMORY WRITE INDEX-widgets-all.md']) assert.ok(plan.includes(line),line+'\n'+plan.join('\n'));
  assert.ok(!plan.some(line=>line.startsWith('MEMORY DELETE ')),'the update only adds pages: '+plan.join('\n'));
  for(const page of fs.readdirSync(rules).filter(name=>name.endsWith('.md'))) assert.ok(!/INDEX-widgets(?:-all)?\.md/.test(read(path.join(rules,page))),page+' names a page the update creates');
  completed(upgrade(f,['--live-memory'],next));
  for(const page of ['INDEX-widgets.md','INDEX-widgets-all.md']) assert.ok(fs.existsSync(path.join(rules,page)),page+' was written');
});

test('statement 17 help lines for --live-memory and --memory-only',async()=>{
  const {usage,options}=await import('../scripts/install.mjs');
  const upgradeHelp=usage('upgrade').split('\n'),installHelp=usage('install').split('\n');
  assert.ok(upgradeHelp.includes('  --live-memory         Allow writes to the configured (live) memory folder and its hook; refused in a linked worktree.'));
  assert.ok(upgradeHelp.includes('  --memory-only         Replay only the memory steps when project files are already at this kit version.'));
  for(const flag of ['--live-memory','--memory-only']) assert.ok(installHelp.includes(`  ${flag.padEnd(22)}Accepted by the shared parser; unused by install.`));
  assert.deepEqual([options(['--target','.','--live-memory'])['live-memory'],options(['--target','.','--memory-only'])['memory-only']],[true,true]);
});
