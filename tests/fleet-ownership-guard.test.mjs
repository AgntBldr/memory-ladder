import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fixture,put} from './helpers.mjs';
import {memorySlug} from '../engine/lib.mjs';
import {fleet} from '../engine/memory-fleet.mjs';

for (const withMemory of [true, false]) test(`ownership guard reported with memory=${withMemory}`, t => {
  const f=fixture(t), home=path.join(f.root,'memories');
  const memory=path.join(home,memorySlug(f.target),'memory');
  if(withMemory) put(path.join(memory,'MEMORY.md'),'# Memory\n');
  const original=childProcess.spawnSync, calls=[];
  t.mock.method(childProcess,'spawnSync',(cmd,args,opts)=>{
    if(cmd==='git') {
      calls.push(args);
      if(args[args.indexOf('-C')+1]===f.target) return {status:128,stdout:'',stderr:'fatal: detected dubious ownership in repository'};
    }
    return original(cmd,args,opts);
  });
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const row=fleet({roots:[f.root],memoryHome:home,localFile:path.join(f.root,'absent')}).projects.find(p=>p.project===f.target);
  assert.ok(row,'project scan must retain refused repositories');
  assert.equal(row.status,'unsafe owner (git ownership guard)');
  assert.equal(row.memoryFiles,withMemory?1:0);
  assert.equal(row.bytes,withMemory?9:0);
  assert.equal(calls.filter(args=>args.includes('--get-regexp')).length,1,'failed probe cached');
  assert.ok(!calls.flat().some(arg=>arg.includes('safe.directory')));
});

 test('filter probes cached per repo and refreshed per scan', t => {
  const f=fixture(t), calls=[], original=childProcess.spawnSync;
  t.mock.method(childProcess,'spawnSync',(cmd,args,opts)=>{
    if(cmd==='git' && args.includes('--get-regexp')) calls.push(args[args.indexOf('-C')+1]);
    return original(cmd,args,opts);
  });
  syncBuiltinESMExports();
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const options={roots:[f.root],memoryHome:path.join(f.root,'absent'),localFile:path.join(f.root,'absent')};
  fleet(options);
  assert.deepEqual(calls,[f.target]);
  fleet(options);
  assert.deepEqual(calls,[f.target,f.target]);
 });
