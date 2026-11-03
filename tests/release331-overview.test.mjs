import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,ok,put,read,json,tree} from './helpers.mjs';
import {loadConfig} from '../engine/lib.mjs';
import {runCheck} from '../engine/memory-check.mjs';
import {checkpoint} from '../engine/memory-checkpoint.mjs';
function setup(t) {
  const f=fixture(t);ok(f.install(['--memory-dir',path.join(f.target,'memory')]));
  const config=loadConfig(),memoryDir=path.join(f.target,'memory');
  put(path.join(f.target,config.caps.roadmap.path),'# Roadmap\n\n## Open work\n\nNothing pending.\n');
  return {...f,repo:f.target,memoryDir,config};
}
test('overview defaults on, false suppresses findings, invalid values fail and act as true',t=>{
  const f=setup(t),check=()=>runCheck({...f,noGit:true}).findings;
  assert.equal(f.config.caps.roadmapOverview.enabled,true);
  assert.ok(check().some(x=>x.check==='repo.roadmap-overview'));
  f.config.caps.roadmapOverview.enabled=false;
  assert.ok(!check().some(x=>x.check==='repo.roadmap-overview'));
  for(const value of ['false',0,null,{},[]]) {
    f.config.caps.roadmapOverview.enabled=value;
    const findings=check();
    assert.ok(findings.some(x=>x.check==='config.caps'&&x.severity==='FAIL'&&x.message===`caps.roadmapOverview.enabled has invalid value ${JSON.stringify(value)}; using default true`));
    assert.ok(findings.some(x=>x.check==='repo.roadmap-overview'));
  }
  delete f.config.caps.roadmapOverview.enabled;
  assert.ok(check().some(x=>x.check==='repo.roadmap-overview'));
});
for(const existing of [false,true]) test(`overview off checkpoint leaves file untouched and excludes staging: existing=${existing}`,t=>{
  const f=setup(t),file=path.join(f.repo,f.config.caps.roadmapOverview.path),reports=[],calls=[];
  f.config.caps.roadmapOverview.enabled=false;
  if(existing) put(file,'# Host overview\r\nKeep bytes.\r\n');
  const before=fs.existsSync(file)?fs.readFileSync(file):null;
  checkpoint({...f,noPush:true,commit:true,report:(step,message)=>reports.push([step,message]),git:args=>{calls.push(args);return '';}});
  assert.ok(reports.some(([step,message])=>step==='roadmap-overview'&&message==='off'));
  assert.ok(calls.some(args=>args[0]==='add'));
  assert.ok(calls.every(args=>!args.includes(f.config.caps.roadmapOverview.path)));
  assert.deepEqual(fs.existsSync(file)?fs.readFileSync(file):null,before);
  const snapshot=tree(f.repo);reports.length=0;
  checkpoint({...f,dryRun:true,report:(step,message)=>reports.push([step,message])});
  assert.ok(reports.some(([step,message])=>step==='roadmap-overview'&&message==='off'));
  assert.deepEqual(tree(f.repo),snapshot);
});
test('overview off CLI write and check are no-ops while stdout preview remains available',t=>{
  const f=setup(t),configFile=path.join(f.repo,'scripts/memory/memory.config.json'),config=json(configFile);
  config.caps.roadmapOverview.enabled=false;put(configFile,JSON.stringify(config));
  const file=path.join(f.repo,config.caps.roadmapOverview.path);
  for(const existing of [false,true]) {
    if(existing) put(file,'# Existing overview\r\n');
    for(const flag of ['--write','--check']) {
      const before=tree(f.repo,{git:true}),result=ok(f.exec(process.execPath,[path.join(f.repo,'scripts/memory/roadmap-overview.mjs'),flag,'--repo',f.repo]));
      assert.equal(result.stdout.trim(),'roadmap overview: off (caps.roadmapOverview.enabled is false)');
      assert.deepEqual(tree(f.repo,{git:true}),before);
    }
    const result=ok(f.exec(process.execPath,[path.join(f.repo,'scripts/memory/roadmap-overview.mjs'),'--repo',f.repo]));
    assert.match(result.stdout,/^# Roadmap overview/);
  }
});
test('overview off excludes a configured file inside memory from the real Git index',t=>{
  const f=setup(t);
  f.config.caps.roadmapOverview={enabled:false,path:'memory/overview.txt'};
  const file=put(path.join(f.repo,f.config.caps.roadmapOverview.path),'Host overview.\n');
  f.git(f.repo,'add','.');f.git(f.repo,'commit','-m','seed host overview');
  put(file,'Host edit must stay unstaged.\r\n');
  checkpoint({...f,noPush:true,commit:true,report:()=>{},git:args=>f.git(f.repo,...args)});
  assert.equal(read(file),'Host edit must stay unstaged.\r\n');
  assert.equal(f.git(f.repo,'diff','--cached','--name-only','--',f.config.caps.roadmapOverview.path),'');
  assert.equal(f.git(f.repo,'diff','--name-only','--',f.config.caps.roadmapOverview.path),f.config.caps.roadmapOverview.path);
});
for(const enabled of [false,undefined]) test(`upgrade merges overview enabled default and preserves ${enabled}`,t=>{
  const f=setup(t),file=path.join(f.repo,'scripts/memory/memory.config.json'),config=json(file);
  if(enabled===undefined) delete config.caps.roadmapOverview.enabled;
  else config.caps.roadmapOverview.enabled=enabled;
  put(file,JSON.stringify(config));
  const receiptFile=path.join(f.repo,'scripts/memory/KIT.json'),receipt=json(receiptFile);
  receipt.version='3.3.0';put(receiptFile,JSON.stringify(receipt));
  ok(f.cli('scripts/upgrade.mjs',['--target',f.repo]));
  assert.equal(json(file).caps.roadmapOverview.enabled,enabled===undefined?true:false);
});
