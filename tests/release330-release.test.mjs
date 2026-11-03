import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fixture,ok,put,read,json,tree,kitRoot,hash} from './helpers.mjs';
import {localTime,atomicWrite,porcelainEntries,gitResult,mainWorktree} from '../engine/lib.mjs';
import {readOverlay} from '../engine/session-core.mjs';
const upgrade=(f,args=[],root=kitRoot)=>f.cli('scripts/upgrade.mjs',['--target',f.target,...args],root);
function candidate(f) {
  const root=path.join(f.root,'candidate');
  for(const name of ['engine','scripts','templates','skills','docs','VERSION','MANIFEST.json']) fs.cpSync(path.join(kitRoot,name),path.join(root,name),{recursive:true});
  return root;
}
function gate(f) {ok(f.exec(process.execPath,[path.join(f.target,'scripts/memory/memory-check.mjs')]));}

for(const installed of [false,true]) test('T-H9 ledger awareness through '+(installed?'upgrade':'install')+' and file-only refusal',t=>{
  const f=fixture(t),root=candidate(f);
  if(installed) ok(f.install());
  const file=path.join(f.target,'.claude/settings.json'),settings=json(file);
  settings.hooks??={};settings.hooks.FutureEvent=[{hooks:[{command:'node scripts/memory/WAVE-SAVE.MJS resume'}]}];put(file,JSON.stringify(settings));
  put(path.join(root,'engine/wave-save.mjs'),'// Presence alone grants no awareness.\n');
  ok(f.cli('scripts/manifest.mjs',[],root));
  const run=args=>installed?upgrade(f,args,root):f.install(args,root),before=tree(f.root,{git:true,previous:true});
  for(const args of [[],['--check']]) {
    const refused=run(args);assert.equal(refused.status,1);
    assert.match(refused.stdout+refused.stderr,/install a wave-save release that supports handover; no override/);
    assert.deepEqual(tree(f.root,{git:true,previous:true}),before);
  }
  const ledger=path.join(root,'engine/upgrades.json');
  put(ledger,JSON.stringify([...json(ledger),{id:'future-wave-save',title:'Wave-save handover support',verdict:'never',scope:'project',reason:'Supports handover.',waveSave:{supportsHandover:true}}]));
  ok(run([]));gate(f);
  assert.equal(json(file).hooks.FutureEvent[0].hooks[0].command,settings.hooks.FutureEvent[0].hooks[0].command);
  assert.equal(hash(path.join(f.target,'.claude/skills/handover/SKILL.md')),hash(path.join(root,'skills/handover/SKILL.md')));
});

test('T8 settled permission is present and missing permission would allow',t=>{
  const f=fixture(t);ok(f.install());
  const present=ok(upgrade(f,['--check']));
  assert.match(present.stdout,/permission Bash\(node scripts\/memory\/new-session.mjs:\*\): present/);
  const file=path.join(f.target,'.claude/settings.json'),settings=json(file);settings.permissions.allow=[];put(file,JSON.stringify(settings));
  const missing=upgrade(f,['--check']);assert.equal(missing.status,1);assert.match(missing.stdout,/permission .*: would allow/);
});

for(const installed of [false,true]) test('T8 validates each settings file once per phase on '+(installed?'upgrade':'install'),t=>{
  const f=fixture(t),root=candidate(f);if(installed) ok(f.install());
  const file=path.join(root,'scripts/install-safety.mjs');
  put(file,read(file).replace("function validateHooks(settings, file='settings.json') {","function validateHooks(settings, file='settings.json') { console.log('VALIDATED '+file);"));
  for(const args of [[],['--check']]) {
    // Preview first for install so both invocations start without a receipt.
    const actual=installed?args:args.length?[]:['--check'];
    const result=ok(installed?upgrade(f,actual,root):f.install(actual,root));
    assert.deepEqual(result.stdout.split(/\r?\n/).filter(line=>line.startsWith('VALIDATED ')),Array(installed&&!actual.length?2:1).fill(['VALIDATED settings.json','VALIDATED settings.local.json']).flat());
  }
});

test('T10 replacement keeps divergent mirror with one actionable warning',t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.target,'.codex'));ok(f.install());
  const mirror=path.join(f.target,'.agents/skills/handover/SKILL.md'),source=path.join(f.target,'.claude/skills/handover/SKILL.md');
  put(mirror,'# Host mirror\n');put(source,'# Host source\n');
  const result=ok(upgrade(f,['--replace-skill','handover']));
  assert.equal(read(mirror),'# Host mirror\n');
  const warnings=result.stdout.split(/\r?\n/).filter(line=>line.startsWith('WARN mirror differs: '));
  assert.deepEqual(warnings,[`WARN mirror differs: ${mirror}; kept; copy ${source} to ${mirror} to refresh after reviewing host edits`]);
  fs.copyFileSync(source,mirror);ok(upgrade(f,['--check']));gate(f);
});

test('T9 unknown owned file removal remedy reaches a clean installed gate',t=>{
  const f=fixture(t);ok(f.install());
  const extra='scripts/memory/unknown.mjs',file=put(path.join(f.target,extra),'// unknown\n'),manifest=path.join(f.target,'scripts/memory/MANIFEST.json'),data=json(manifest);
  data.files[extra]=hash(file);put(manifest,JSON.stringify(data));
  assert.equal(upgrade(f).status,1);fs.unlinkSync(file);ok(upgrade(f));gate(f);
});

test('T0 T3 overlay recognizes every line ending and refuses a lone-CR duplicate',t=>{
  const f=fixture(t);ok(f.install());
  for(const eol of ['\r\n','\n','\r']) {
    put(path.join(f.target,'AGENTS.md'),['## Session overlay','check: node first.mjs','check: node second.mjs','board: node board.mjs','## Other','push: none'].join(eol));
    assert.deepEqual(readOverlay(f.target),{check:'node second.mjs',board:'node board.mjs'});
    const result=ok(f.exec(process.execPath,[path.join(kitRoot,'engine/new-session.mjs'),'start','--repo',f.target]));
    assert.match(result.stdout,/overlay check: refused \(duplicate key\)/);
    assert.doesNotMatch(result.stdout,/add-on check:/);
  }
});

test('shared local clock preserves offset and seconds',()=>{
  for(const [offset,suffix] of [[-345,'+05:45'],[210,'-03:30'],[0,'+00:00']]) {
    const date={getTimezoneOffset:()=>offset,getFullYear:()=>2026,getMonth:()=>0,getDate:()=>2,getHours:()=>3,getMinutes:()=>4,getSeconds:()=>5};
    assert.equal(localTime(date),'2026-01-02T03:04:05'+suffix);
  }
});

test('shared atomic write preserves bytes and cleans temp after a failed rename',t=>{
  const f=fixture(t),file=put(path.join(f.target,'state'),'old'),raw=Buffer.from([0,255,13,10]);
  atomicWrite(file,raw);assert.deepEqual(fs.readFileSync(file),raw);
  t.mock.method(fs,'renameSync',()=>{throw Error('rename blocked');});
  assert.throws(()=>atomicWrite(file,'new'),/rename blocked/);assert.deepEqual(fs.readFileSync(file),raw);
  assert.deepEqual(fs.readdirSync(f.target).filter(name=>name.endsWith('.tmp')),[]);
});

test('shared porcelain parser counts renames once and optionally keeps source paths',()=>{
  const raw='R  new name\0old name\0?? untracked\0 M dirty\0';
  const expected=[{code:'R ',file:'new name'},{code:'??',file:'untracked'},{code:' M',file:'dirty'}];
  assert.deepEqual(porcelainEntries(raw),expected);
  assert.deepEqual(porcelainEntries(raw,{includeSources:true}),[expected[0],{code:'R ',file:'old name'},...expected.slice(1)]);
});

test('shared git runner preserves caller limits and raw results',t=>{
  const calls=[];
  t.mock.method(childProcess,'spawnSync',(cmd,argv,options)=>{calls.push({cmd,argv,options});return {status:0,stdout:' value \n'};});syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const result=gitResult('repo',['status'],{timeout:2000,maxBuffer:1024*1024,encoding:'buffer'});
  assert.equal(result.stdout,' value \n');
  assert.deepEqual(calls[0],{cmd:'git',argv:['--no-optional-locks','-C','repo','status'],options:{encoding:'buffer',timeout:2000,windowsHide:true,maxBuffer:1024*1024}});
  mainWorktree('repo');assert.equal(calls[1].options.timeout,10000);assert.equal(calls[1].options.encoding,'utf8');
});
