import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture, put, ok, tree} from './helpers.mjs';
import {loadConfig, repoPath, pathKey, insideRepo, memoryLocation, brainPaths} from '../engine/lib.mjs';
import {runCheck, main, writeAllowlist} from '../engine/memory-check.mjs';
import {brainIndexPairs} from '../engine/brain-index.mjs';
import {generateOverview} from '../engine/roadmap-overview.mjs';
import {rotateLog} from '../engine/memory-rotate.mjs';
import {checkpoint} from '../engine/memory-checkpoint.mjs';
import {loadRules} from '../engine/memory-guard.mjs';
import {verify} from '../engine/memory-conserve.mjs';

for (const value of ['.', 'brain/..', 'C:', 'C:foo', 'jx.', '.. ', 'a /file', '.git', '.git/hooks/pre-commit', 'docs/.GiT/file', '.git/../docs', 'GIT~1/hooks/pre-commit', '.git::$INDEX_ALLOCATION/hooks/pre-commit', 'docs/x.md:stream']) test('repoPath rejects ambiguous spelling: ' + value, t => {
  const f = fixture(t);
  assert.throws(() => repoPath(f.target, value, 'test'), /must be a relative path/);
});
test('path keys tolerate NUL, dangling links and absent drives', t => {
  const f = fixture(t);
  assert.doesNotThrow(() => pathKey(f.target, 'bad\0name'));
  assert.doesNotThrow(() => insideRepo(f.target, 'bad\0name'));
  try { fs.symlinkSync(path.join(f.root,'missing'),path.join(f.target,'dangling'),process.platform==='win32'?'junction':'dir'); }
  catch(error) { if(['EPERM','EACCES','ENOSYS'].includes(error.code)) { t.skip(error.code);return; } throw error; }
  assert.doesNotThrow(() => pathKey(f.target,'dangling'));
  assert.throws(() => repoPath(f.target,'dangling/file','test'), /must be a relative path/);
  if (process.platform==='win32') {
    const drive='ZYXWVUTSRQPONMLKJIHGFED'.split('').find(c=>!fs.existsSync(c+':\\'));
    if(drive) assert.doesNotThrow(()=>insideRepo(f.target,drive+':\\x'));
  }
});
test('allowlist refuses config failures without modifying bytes or entries', t => {
  const f=fixture(t),config=loadConfig(),file=path.join(f.target,'config.json');
  config.allow=[{check:'link.dead',file:'old.md',reason:'keep',added:'2026-10-29'}];
  put(file,JSON.stringify(config));const before=fs.readFileSync(file),entries=structuredClone(config.allow);
  assert.throws(()=>writeAllowlist({result:{findings:[{check:'config.path',severity:'FAIL'}]},config,reason:'test',configFile:file}),/^Error: cannot write allowlist while config checks fail$/);
  assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(config.allow,entries);
});
test('missing saved location requires absolute path and untracked local config', t => {
  const f=fixture(t),local=path.join(f.target,'scripts/memory/KIT.local.json');
  const prior=process.env.CLAUDE_MEMORY_DIR;delete process.env.CLAUDE_MEMORY_DIR;
  t.after(()=>{if(prior!==undefined)process.env.CLAUDE_MEMORY_DIR=prior;});
  put(local,JSON.stringify({memoryDir:'missing-relative'}));assert.equal(memoryLocation(f.target).source,'default');
  put(local,JSON.stringify({memoryDir:path.join(f.root,'missing-absolute')}));assert.equal(memoryLocation(f.target).source,'KIT.local.json');
  f.git(f.target,'add','scripts/memory/KIT.local.json');assert.equal(memoryLocation(f.target).source,'default');
});
test('config labels strip controls and bound arbitrary keys', t => {
  const f=fixture(t),config=loadConfig();
  fs.mkdirSync(f.memory,{recursive:true});
  config.caps['evil\x1b[2K\rPASS\n'+'x'.repeat(200)]={path:'../outside'};
  const hit=runCheck({repo:f.target,memoryDir:f.memory,config,noGit:true}).findings.find(f=>f.check==='config.path');
  assert.doesNotMatch(hit.message,/[\x00-\x1f\x7f]/);assert.ok(hit.message.length<=160);
});
test('guard and brain reads reject escaping settings without exposing content', t => {
  const f=fixture(t),config=loadConfig();config.caps.guard.rules='../secret.json';
  delete config.caps.guard.kitRules;
  let result=loadRules({repo:f.target,config});assert.ok(result.rules.length>0);assert.equal(result.errors.length,1);
  config.brain={dir:'../outside'};assert.throws(()=>brainPaths(f.target,config),/brain.dir/);
  config.caps.guard.rules='rules.json';put(path.join(f.target,'rules.json'),'PRIVATE_CONTENT');
  result=loadRules({repo:f.target,config});assert.ok(result.errors.some(e=>e.reason===`rules file ${path.join(f.target,'rules.json')} is not valid JSON`));
  assert.ok(result.errors.every(e=>!e.reason.includes('PRIVATE_CONTENT')));
});

for (const [name,args,group,key] of [
  ['brain-index',['--write'],'brainIndex','allPath'],
  ['roadmap-overview',['--write'],'roadmapOverview','path'],
  ['memory-rotate',['log','--write'],'brainLog','path'],
  ['memory-checkpoint',['--dry-run'],'brainIndex','path'],
  ['install',[],'roadmapHistory','path']
]) for (const junction of [false,true]) test(name+' rejects its own escaping setting'+(junction?' through junction':''),t=>{
  const f=fixture(t);if(name!=='install')ok(f.install());else fs.mkdirSync(f.memory,{recursive:true});const config=loadConfig();
  let value='../outside.md';
  if(junction) {
    const outside=path.join(f.root,'outside');fs.mkdirSync(outside);
    try {fs.symlinkSync(outside,path.join(f.target,'escape'),process.platform==='win32'?'junction':'dir');}
    catch(error) {if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.skip(error.code);return;}throw error;}
    value='escape/file.md';
  }
  config.caps[group][key]=value;put(path.join(f.target,'scripts/memory/memory.config.json'),JSON.stringify(config));
  const before=tree(f.root,{git:true});
  const result=name==='install'?f.install():f.cli('scripts/memory/'+name+'.mjs',args,f.target);
  assert.equal(result.status,1);assert.ok(result.stderr.includes(`caps.${group}.${key} must be a relative path`));
  assert.deepEqual(tree(f.root,{git:true}),before);
  const gate=runCheck({repo:f.target,memoryDir:f.memory,config,noGit:true});
  assert.ok(gate.findings.some(f=>f.check==='config.path'&&f.severity==='FAIL'));
});

test('staged secret still blocks when a Markdown link contains NUL',t=>{
  const f=fixture(t);ok(f.install());
  const file=path.join(f.memory,'MEMORY.md');put(file,fs.readFileSync(file,'utf8')+'\n'+ 'sk-'+'a'.repeat(40)+'\n[broken](bad\0path.md)\n');
  f.git(f.memory,'add','MEMORY.md');
  const result=f.cli('scripts/memory/memory-check.mjs',['--hook','--scope','memory'],f.target);
  assert.equal(result.status,1);assert.match(result.stdout,/FAIL secret/);assert.match(result.stdout,/FAIL link.dead/);
});
test('dangling directory link is reported as link.dead by full gate',t=>{
  const f=fixture(t);ok(f.install());
  try {fs.symlinkSync(path.join(f.root,'missing'),path.join(f.memory,'shared'),process.platform==='win32'?'junction':'dir');}
  catch(error) {if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.skip(error.code);return;}throw error;}
  const file=path.join(f.memory,'MEMORY.md');put(file,fs.readFileSync(file,'utf8')+'\n[broken](shared/no.md)\n');
  const result=f.cli('scripts/memory/memory-check.mjs',[],f.target);
  assert.equal(result.status,1);assert.match(result.stdout,/FAIL link.dead/);assert.doesNotMatch(result.stdout,/memory-check: error/);
});

test('in-repo memory hook tolerates unrelated tracked dangling link',t=>{
  const f=fixture(t),memory=path.join(f.target,'notes');ok(f.install(['--memory-dir',memory]));
  try {fs.symlinkSync(path.join(f.root,'missing'),path.join(f.target,'dangling'),process.platform==='win32'?'junction':'dir');}
  catch(error) {if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.skip(error.code);return;}throw error;}
  const blob=ok(f.exec('git',['-C',f.target,'hash-object','-w','--stdin'],{input:'../missing'})).stdout.trim();
  f.git(f.target,'update-index','--add','--cacheinfo','120000',blob,'dangling');f.git(f.target,'add','notes');
  const result=ok(f.cli('scripts/memory/memory-check.mjs',['--hook','--scope','memory'],f.target));
  assert.match(result.stdout,/0 FAIL/);
});
test('absent saved drive gives clear memory-init and install diagnostics with explicit override',t=>{
  if(process.platform!=='win32'){t.skip('drive letters require Windows');return;}
  const drive='ZYXWVUTSRQPONMLKJIHGFED'.split('').find(c=>!fs.existsSync(c+':\\'));
  if(!drive){t.skip('no absent drive letter');return;}
  const f=fixture(t);ok(f.install());const saved=drive+':\\notes';
  put(path.join(f.target,'scripts/memory/KIT.local.json'),JSON.stringify({memoryDir:saved}));
  const requested=path.join(f.root,'override');
  const fresh=fixture(t);put(path.join(fresh.target,'scripts/memory/KIT.local.json'),JSON.stringify({memoryDir:saved}));
  for(const result of [fresh.install(['--memory-dir',requested]),f.cli('scripts/memory/memory-init.mjs',['--memory-dir',requested],f.target)]) {
    assert.equal(result.status,1);assert.ok(result.stderr.includes('The saved notes folder in KIT.local.json is '+saved));
    assert.doesNotMatch(result.stderr,/ENOENT|lstat/);
  }
});

for(const [name,group,run] of [
  ['brain-index','brainIndex',options=>brainIndexPairs(options.repo,options.config,{index:'',all:''})],
  ['roadmap-overview','roadmap',options=>generateOverview(options)],
  ['memory-rotate','brainLog',options=>rotateLog(options)],
  ['memory-checkpoint','brainLog',options=>checkpoint({...options,noPush:true,report:()=>{},git:()=>''})]
]) test('per-site '+name+' validates the value used after config validation',t=>{
  const f=fixture(t),config=loadConfig(),cap=config.caps[group],original=cap.path;let reads=0;
  fs.mkdirSync(f.memory,{recursive:true});
  // Expose a changed value only at the use site, so the blanket validator cannot mask a missing local guard.
  Object.defineProperty(cap,'path',{enumerable:true,get:()=>++reads===2?'../outside.md':original});
  assert.throws(()=>run({repo:f.target,memoryDir:f.memory,config}),{message:`caps.${group}.path must be a relative path inside the repo`});
});

for (const inRepo of [false,true]) test('default brain escape reports findings and blocks staged secrets, inRepo='+inRepo,t=>{
  const f=fixture(t),memory=inRepo?path.join(f.target,'notes'):f.memory;
  ok(f.install(inRepo?['--memory-dir',memory]:[]));
  const configFile=path.join(f.target,'scripts/memory/memory.config.json'),config=JSON.parse(fs.readFileSync(configFile,'utf8'));
  config.caps.brainLog.path='docs/log.md';config.caps.brainIndex.path='docs/index.md';
  config.caps.brainIndex.allPath='docs/index-all.md';config.caps.brainShared.paths=['docs/_shared/'];
  put(configFile,JSON.stringify(config));
  const outside=path.join(f.root,'vault');fs.mkdirSync(outside);
  try {fs.symlinkSync(outside,path.join(f.target,'brain'),process.platform==='win32'?'junction':'dir');}
  catch(error) {if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.skip(error.code);return;}throw error;}
  const planted='sk-'+'a'.repeat(40),file=path.join(memory,'MEMORY.md');
  put(file,fs.readFileSync(file,'utf8')+'\n'+planted+'\n');f.git(memory,'add','MEMORY.md');
  for(const args of [[],['--hook','--scope','memory'],['--session-start']]) {
    const result=f.cli('scripts/memory/memory-check.mjs',args,f.target);
    assert.equal(result.status,args.includes('--session-start')?0:1);
    assert.match(result.stdout,/FAIL config.path .* brain must be a relative path/);
    assert.doesNotMatch(result.stdout,/brain.dir must|memory gate: error|memory-check: error/);
    if(!args.includes('--session-start')) assert.match(result.stdout,/FAIL secret/);
    assert.ok(!result.stdout.includes(planted));
  }
  // An invalid date forces a post-extraction throw even after the brain-path fix.
  const fallback=f.cli('scripts/memory/memory-check.mjs',['--hook','--today','invalid'],f.target);
  assert.equal(fallback.status,1);assert.match(fallback.stdout,/FAIL secret/);
  assert.match(fallback.stdout,/memory gate: commit blocked: gate error after a secret was found: invalid --today date/);
  assert.ok(!fallback.stdout.includes(planted));
});

for(const [field,check] of [['moved_to','stub.target'],['brain','brain.pointer']]) test('raw NUL '+field+' reports '+check+' in full gate and hook',t=>{
  const f=fixture(t);ok(f.install());const file=path.join(f.memory,'MEMORY.md');
  put(file,fs.readFileSync(file,'utf8')+'\nsk-'+'a'.repeat(40)+'\n- [stub](stub.md) - moved\n');
  put(path.join(f.memory,'stub.md'),'---\nname: stub\ndescription: Moved elsewhere\ntype: reference\n'+field+': '+(field==='brain'?'brain/':'')+'x\0y.md\n---\nMoved.\n');
  f.git(f.memory,'add','-A');
  for(const args of [[],['--hook','--scope','memory']]) {
    const result=f.cli('scripts/memory/memory-check.mjs',args,f.target);
    assert.equal(result.status,1);assert.ok(result.stdout.includes('FAIL '+check));assert.match(result.stdout,/FAIL secret/);
    assert.doesNotMatch(result.stdout,/memory gate: error|memory-check: error/);
  }
});

test('post-extraction error without a staged secret remains fail-open',t=>{
  const f=fixture(t);ok(f.install());
  const result=f.cli('scripts/memory/memory-check.mjs',['--hook','--today','invalid'],f.target);
  assert.equal(result.status,0);assert.match(result.stdout,/^memory gate: error: invalid --today date; expected YYYY-MM-DD/);
});

test('fallback scan failure blocks and redacts its error',t=>{
  const f=fixture(t);ok(f.install());const original=fs.readFileSync,planted='sk-'+'a'.repeat(40);
  t.mock.method(fs,'readFileSync',function(file,...args) {
    if(String(file).includes('memory-stage-') && path.basename(String(file))==='MEMORY.md') throw new Error(planted);
    return original.call(this,file,...args);
  });
  const lines=[];t.mock.method(console,'log',line=>lines.push(line));
  assert.equal(main(['--hook','--repo',f.target,'--memory-dir',f.memory,'--today','invalid']),1);
  assert.match(lines.join('\n'),/memory gate: commit blocked: secret scan could not run: \[REDACTED:/);
  assert.ok(!lines.join('\n').includes(planted));
});

test('fallback secret error retains findings and redacts the CLI message',t=>{
  const f=fixture(t);ok(f.install());const planted='sk-'+'a'.repeat(40),file=path.join(f.memory,'MEMORY.md');
  put(file,fs.readFileSync(file,'utf8')+'\n'+planted+'\n');f.git(f.memory,'add','MEMORY.md');
  t.mock.method(globalThis,'structuredClone',()=>{throw new Error(planted);});
  const lines=[];t.mock.method(console,'log',line=>lines.push(line));
  assert.equal(main(['--hook','--repo',f.target,'--memory-dir',f.memory]),1);
  assert.match(lines.join('\n'),/FAIL secret/);
  assert.match(lines.join('\n'),/gate error after a secret was found: \[REDACTED:/);
  assert.ok(!lines.join('\n').includes(planted));
});

for (const extra of [[],['--today','invalid']]) test('snapshot cleanup failure keeps the staged secret block'+(extra.length?' after a gate error':''),t=>{
  const f=fixture(t);ok(f.install());const planted='sk-'+'a'.repeat(40),file=path.join(f.memory,'MEMORY.md'),original=fs.rmSync,left=[];
  put(file,fs.readFileSync(file,'utf8')+'\n'+planted+'\n');f.git(f.memory,'add','MEMORY.md');
  t.mock.method(fs,'rmSync',function(target,...args) {
    if(String(target).includes('memory-stage-')) { left.push(target);throw Object.assign(new Error('resource busy'),{code:'EBUSY'}); }
    return original.call(this,target,...args);
  });
  const lines=[],errors=[];t.mock.method(console,'log',line=>lines.push(line));t.mock.method(console,'error',line=>errors.push(line));
  try { assert.equal(main(['--hook','--repo',f.target,'--memory-dir',f.memory,...extra]),1);assert.match(lines.join('\n'),/FAIL secret/); }
  finally { for(const dir of left) original(dir,{recursive:true,force:true}); }
  assert.ok(left.length>0);assert.match(errors.join('\n'),/could not remove the staged copy .*memory-stage-/);
});
test('an unwritable temp folder blocks the hook instead of skipping the staged check',t=>{
  const f=fixture(t);ok(f.install());const file=path.join(f.memory,'MEMORY.md');
  put(file,fs.readFileSync(file,'utf8')+'\nsk-'+'a'.repeat(40)+'\n');f.git(f.memory,'add','MEMORY.md');
  const original=fs.mkdtempSync;
  t.mock.method(fs,'mkdtempSync',function(prefix,...args) {
    if(String(prefix).includes('memory-stage-')) throw Object.assign(new Error('permission denied'),{code:'EACCES'});
    return original.call(this,prefix,...args);
  });
  const lines=[];t.mock.method(console,'log',line=>lines.push(line));
  assert.equal(main(['--hook','--repo',f.target,'--memory-dir',f.memory]),1);
  assert.match(lines.join('\n'),/^memory gate: commit blocked: staged snapshot extraction failed: permission denied/m);
});
test('frontmatter keys named like object methods warn instead of stopping the gate',t=>{
  const f=fixture(t);ok(f.install());const names=Object.getOwnPropertyNames(Object.prototype);
  put(path.join(f.memory,'proto-keys.md'),'---\nname: proto-keys\ndescription: Keys named like object methods\n'+names.map(n=>n+': x\n').join('')+'metadata:\n  hasOwnProperty: z\n---\nBody.\n');
  const result=runCheck({repo:f.target,memoryDir:f.memory,config:loadConfig(),noGit:true});
  assert.equal(result.findings.find(x=>x.check==='fm.parse'&&x.file==='proto-keys.md')?.value,names.length+1);
});

test('invalid kit rules retain host deny and bundled rules',t=>{
  const f=fixture(t),config=loadConfig();config.caps.guard={kitRules:'../absent.json',rules:'rules.json'};
  const file=put(path.join(f.target,'config.json'),JSON.stringify(config));
  put(path.join(f.target,'rules.json'),JSON.stringify({version:1,rules:[{id:'host-deny',action:'deny',pattern:'git push --force',message:'force push denied'}]}));
  const result=loadRules({repo:f.target,config});assert.equal(result.errors.length,1);
  assert.ok(result.rules.some(r=>r.id==='host-deny'));assert.ok(result.rules.length>1);
  const cli=f.exec(process.execPath,[path.resolve('engine/memory-guard.mjs'),'pretooluse','--repo',f.target,'--config',file],{input:JSON.stringify({tool_name:'Bash',tool_input:{command:'git push --force origin main'}})});
  assert.equal(cli.status,2);assert.match(cli.stderr,/force push denied/);
});

for(const rules of ['../outside.json','']) test('invalid host rule path preserves kit rules: '+JSON.stringify(rules),t=>{
  const f=fixture(t),config=loadConfig();config.caps.guard={rules};
  const result=loadRules({repo:f.target,config});assert.equal(result.errors.length,1);assert.ok(result.rules.length>0);
});

test('case-variant tracked local config cannot recreate a missing folder',t=>{
  const f=fixture(t),local=put(path.join(f.target,'scripts/memory/KIT.local.json'),JSON.stringify({memoryDir:path.join(f.root,'missing')}));
  const blob=f.git(f.target,'hash-object','-w',local);
  f.git(f.target,'update-index','--add','--cacheinfo','100644',blob,'scripts/Memory/KIT.local.json');
  const probe=f.exec('git',['-C',f.target,'ls-files','--error-unmatch','--',':(icase)scripts/memory/KIT.local.json']);
  if(probe.status!==0){t.skip('Git does not support icase pathspec');return;}
  const prior=process.env.CLAUDE_MEMORY_DIR;delete process.env.CLAUDE_MEMORY_DIR;
  t.after(()=>{if(prior!==undefined)process.env.CLAUDE_MEMORY_DIR=prior;});
  assert.equal(memoryLocation(f.target).source,'default');
});

test('repoPath rejects canonical aliases into git metadata',t=>{
  const f=fixture(t);
  try {fs.symlinkSync(path.join(f.target,'.git'),path.join(f.target,'metadata'),process.platform==='win32'?'junction':'dir');}
  catch(error) {if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.skip(error.code);return;}throw error;}
  assert.throws(()=>repoPath(f.target,'metadata/hooks/pre-commit','test'),/must be a relative path/);
});

test('conserve rejects an escaping brain directory',t=>{
  const f=fixture(t),config=loadConfig();fs.mkdirSync(f.memory,{recursive:true});config.brain={dir:'../outside'};
  assert.throws(()=>verify({repo:f.target,memoryDir:f.memory,config,baseline:{union:[],files:{}}}),/brain.dir must be a relative path/);
});
