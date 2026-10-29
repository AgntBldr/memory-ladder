import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fixture, put, read, json, ok, kitRoot, bump} from './helpers.mjs';
import {migrateRoutes} from '../engine/memory-migrate.mjs';
import {memoryLocation} from '../engine/lib.mjs';
import {fleet} from '../engine/memory-fleet.mjs';
import {runCheck} from '../engine/memory-check.mjs';
const cfg=()=>json(path.join(kitRoot,'engine/memory.config.json'));
test('325 in-repo docs and glossary cover mode, flag, config and ORDER',()=>{
  for(const file of ['README.md','docs/STARTER.md']) assert.match(read(path.join(kitRoot,file)),/## Memory inside the repo/);
  assert.match(read(path.join(kitRoot,'docs/CONVERT.md')),/## Move root memory into a dedicated folder/);
  for(const term of ['in-repo memory','memory.inRepoDir','--commit','ORDER','git unavailable','unreadable repo']) assert.ok(read(path.join(kitRoot,'docs/GLOSSARY.md')).includes('**'+term+'** - '),term);
});
function migration(t) {
  const f=fixture(t);
  const router='- OPEN `INDEX-craft-build.md` before building.\n';
  const body='# Build rules\n\n- OPEN BEFORE building: a SECOND checker\n  checks each sample output (see [[review-rule]]).\n  - Nested rule\n    - Deeper rule\n      continued [review](review-rule.md).\n';
  put(path.join(f.memory,'MEMORY.md'),router);
  put(path.join(f.memory,'INDEX-craft-build.md'),body);
  put(path.join(f.memory,'review-rule.md'),'---\nname: review-rule\ndescription: Review changes\n---\nReview.\n');
  return {f,router,body};
}
test('325 migration preserves contiguous hand blocks in source order',t=>{
  const {f,body}=migration(t);
  migrateRoutes({memoryDir:f.memory,config:cfg(),write:true});
  assert.ok(read(path.join(f.memory,'index-notes-craft-build.md')).endsWith(body));
});
test('325 router report before is literal original',t=>{
  const {f,router}=migration(t);
  const report=migrateRoutes({memoryDir:f.memory,config:cfg(),write:true});
  assert.equal(report.router[0].before,router);
  assert.equal(report.router[0].after,read(path.join(f.memory,'MEMORY.md')));
});
test('325 ORDER write assertion rejects reordered output and restores originals',t=>{
  const {f,body}=migration(t), original=fs.writeFileSync;
  let changed=false;
  t.mock.method(fs,'writeFileSync',(file,text,...args)=>{
    if(!changed && path.basename(file)==='index-notes-craft-build.md') {
      changed=true;text=String(text).replace('# Build rules\n','').replace('  checks each sample output (see [[review-rule]]).','  checks each sample output (see [[review-rule]]).\n# Build rules');
    }
    return original(file,text,...args);
  });
  assert.throws(()=>migrateRoutes({memoryDir:f.memory,config:cfg(),write:true}),/ORDER/);
  assert.equal(read(path.join(f.memory,'INDEX-craft-build.md')),body);
  assert.ok(!fs.existsSync(path.join(f.memory,'index-notes-craft-build.md')));
});
test('325 project hook skips unrelated stages and gates staged memory',t=>{
  const f=fixture(t), memory=path.join(f.target,'memory');ok(f.install(['--memory-dir',memory]));
  // Invalid memory must not block an unrelated project commit.
  put(path.join(memory,'MEMORY.md'),'[broken](missing.md)\n');
  put(path.join(f.target,'unrelated.txt'),'host');f.git(f.target,'add','unrelated.txt');
  f.git(f.target,'commit','-m','unrelated');
  f.git(f.target,'add','memory');
  const r=f.exec('git',['-c','user.name=test','-c','user.email=test@example.invalid','commit','-m','invalid memory']);
  assert.notEqual(r.status,0);assert.match(r.stdout+r.stderr,/FAIL/);
});
for(const [failure,expected] of [[{status:null,error:{code:'ENOENT'},stderr:''},'git unavailable'],[{status:128,stderr:'fatal: broken repository\nmore'},'unreadable repo (fatal: broken repository)']]) test('325 fleet '+expected,t=>{
  const f=fixture(t), original=childProcess.spawnSync;
  t.mock.method(childProcess,'spawnSync',(cmd,args,opts)=>cmd==='git'?{stdout:'',...failure}:original(cmd,args,opts));
  syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  assert.equal(fleet({roots:[f.root],memoryHome:path.join(f.root,'absent'),localFile:path.join(f.root,'absent')}).projects.find(p=>p.project===f.target).status,expected);
});
test('325 tracked resolver precedes local and resolves each checkout',t=>{
  const f=fixture(t);
  put(path.join(f.target,'scripts/memory/memory.config.json'),JSON.stringify({memory:{inRepoDir:'.claude/memory'}}));
  put(path.join(f.target,'scripts/memory/KIT.local.json'),JSON.stringify({memoryDir:f.home}));
  assert.equal(memoryLocation(f.target).dir,path.join(f.target,'.claude/memory'));
  assert.equal(memoryLocation(f.target,f.home).dir,f.home);
  const prior=process.env.CLAUDE_MEMORY_DIR;
  try {process.env.CLAUDE_MEMORY_DIR=f.home;assert.equal(memoryLocation(f.target).dir,f.home);}
  finally {if(prior===undefined) delete process.env.CLAUDE_MEMORY_DIR;else process.env.CLAUDE_MEMORY_DIR=prior;}
});
test('325 in-repo skips only memory repository allow checks',t=>{
  const f=fixture(t), memory=path.join(f.target,'memory');
  put(path.join(memory,'MEMORY.md'),'# Memory\n');
  const config=cfg();
  config.allow=['repo.remote','repo.ahead','repo.uncommitted','repo.skill-version'].map(check=>({check,file:'.',reason:'fixture',added:'2026-10-27'}));
  const stale=runCheck({memoryDir:memory,repo:f.target,config}).findings.filter(x=>x.check==='config.allow-stale');
  assert.equal(stale.length,1);assert.match(stale[0].message,/repo.skill-version/);
});
for(const kind of ['none','existing','hooksPath']) test('325 in-repo install and hook '+kind,t=>{
  const f=fixture(t), memory=path.join(f.target,'.claude/memory');
  const hook=path.join(f.target,kind==='hooksPath'?'.husky/pre-commit':'.git/hooks/pre-commit');
  if(kind!=='none') put(hook,'#!/bin/sh\necho host\n');
  if(kind==='hooksPath') f.git(f.target,'config','core.hooksPath','.husky');
  const out=ok(f.install(['--memory-dir',memory])).stdout;
  assert.equal(json(path.join(f.target,'scripts/memory/memory.config.json')).memory.inRepoDir,'.claude/memory');
  assert.ok(!fs.existsSync(path.join(memory,'.git')));
  assert.notEqual(f.exec('git',['rev-parse','--verify','HEAD']).status,0,'install must not commit');
  if(kind==='none') {assert.match(read(hook),/--hook --scope memory/);assert.match(read(hook),/diff.*--cached/);}
  else {assert.equal(read(hook),'#!/bin/sh\necho host\n');assert.match(out,/node .*--hook --scope memory/);}
  assert.match(out,/in-repo memory/);
  assert.match(read(path.join(f.target,'AGENTS.md')),/in-repo memory.*never pushes/);
  assert.match(read(path.join(f.target,'.claude/skills/memory-ladder/SKILL.md')),/in-repo memory.*never pushes/);
  if(kind==='hooksPath') {
    const empty=fixture(t);
    empty.git(empty.target,'config','core.hooksPath','');
    const message=ok(empty.install(['--memory-dir',path.join(empty.target,'memory')])).stdout;
    assert.match(message,/project hook preserved/);
    assert.ok(!fs.existsSync(path.join(empty.target,'pre-commit')));
    assert.ok(!fs.existsSync(path.join(empty.target,'.git/hooks/pre-commit')));
  }
});
test('325 root memory refused with conversion guidance before writes',t=>{
  const f=fixture(t);put(path.join(f.target,'MEMORY.md'),'# Memory\n');
  const r=f.install(['--memory-dir',f.target]);assert.notEqual(r.status,0);
  assert.match(r.stderr,/dedicated folder.*CONVERT.md/);
  assert.ok(!fs.existsSync(path.join(f.target,'scripts/memory/KIT.json')));
});
for(const commit of [false,true]) test('325 checkpoint in repo commit='+commit,t=>{
  const f=fixture(t), memory=path.join(f.target,'memory');ok(f.install(['--memory-dir',memory]));
  f.git(f.target,'add','.');f.git(f.target,'commit','-m','project baseline');
  const head=f.git(f.target,'rev-parse','HEAD'), branch=f.git(f.target,'branch','--show-current');
  put(path.join(f.target,'unrelated.txt'),'keep staged');f.git(f.target,'add','unrelated.txt');
  put(path.join(memory,'current-state.md'),read(path.join(memory,'current-state.md'))+'\nCheckpoint note.\n');
  const r=ok(f.cli('scripts/memory/memory-checkpoint.mjs',commit?['--commit']:[],f.target));
  assert.match(r.stdout,/push: skipped/);
  assert.equal(f.git(f.target,'branch','--show-current'),branch);
  assert.equal(f.git(f.target,'diff','--cached','--name-only'),'unrelated.txt');
  if(commit) {assert.notEqual(f.git(f.target,'rev-parse','HEAD'),head);assert.match(f.git(f.target,'show','--format=','--name-only','HEAD'),/memory\/current-state.md/);}
  else {assert.equal(f.git(f.target,'rev-parse','HEAD'),head);assert.match(r.stdout,/git add -- .*memory/);assert.match(r.stdout,/memory: checkpoint/);}
});
test('325 in-repo gate, SessionStart, recall, fleet, upgrade, worktree and clone',t=>{
  const f=fixture(t), memory=path.join(f.target,'memory');ok(f.install(['--memory-dir',memory]));
  const gate=jsonResult=>JSON.parse(ok(f.cli('scripts/memory/memory-check.mjs',['--json'],f.target)).stdout);
  assert.ok(!gate().findings.some(x=>['repo.remote','repo.ahead','repo.uncommitted','repo.not-git'].includes(x.check)));
  assert.match(ok(f.cli('scripts/memory/memory-check.mjs',['--session-start'],f.target)).stdout,/in-repo memory/);
  assert.match(ok(f.cli('scripts/memory/memory-recall.mjs',['current'],f.target)).stdout,/current-state/);
  const fleetResult=JSON.parse(ok(f.cli('engine/memory-fleet.mjs',['--root',f.root,'--memory-home',path.join(f.root,'absent'),'--json'])).stdout);
  assert.equal(fleetResult.projects.find(p=>p.project===f.target).status,'in-repo, current');
  const next=bump(f);ok(f.cli('scripts/upgrade.mjs',['--target',f.target],next));
  assert.equal(json(path.join(f.target,'scripts/memory/memory.config.json')).memory.inRepoDir,'memory');
  f.git(f.target,'add','.');f.git(f.target,'commit','-m','installed');
  const wt=path.join(f.root,'worktree');f.git(f.target,'worktree','add','-b','other',wt);
  assert.equal(memoryLocation(wt).dir,path.join(wt,'memory'));
  assert.match(ok(f.cli('scripts/memory/memory-check.mjs',['--session-start'],wt)).stdout,/in-repo memory/);
  const clone=path.join(f.root,'clone');f.git(f.root,'clone',f.target,clone);
  assert.equal(memoryLocation(clone).dir,path.join(clone,'memory'));
});
