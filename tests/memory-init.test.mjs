import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,ok,tree,read,json,kitRoot,put} from './helpers.mjs';
import {shellQuoted} from '../engine/install-hooks.mjs';
import {planInit,rollbackInit} from '../engine/memory-init.mjs';
import {freshMemoryWrites} from '../engine/memory-setup.mjs';
import {ownedFiles} from '../scripts/manifest.mjs';

test('memory-init restores a deleted fresh install byte for byte without host writes',t=>{
  const f=fixture(t);ok(f.install());
  const expected=tree(f.memory),host=tree(f.target,{git:true});
  fs.rmSync(f.memory,{recursive:true,force:true});
  const dryBefore=tree(f.root,{git:true});
  const dry=ok(f.cli('scripts/memory/memory-init.mjs',['--dry-run'],f.target));
  assert.match(dry.stdout,/WRITE/);assert.deepEqual(tree(f.root,{git:true}),dryBefore);
  const r=ok(f.cli('scripts/memory/memory-init.mjs',[],f.target));
  assert.match(r.stdout,/0 FAIL, 1 WARN/);assert.match(r.stdout,/\(default\)/);
  const lines=r.stdout.trim().split(/\r?\n/),ordered=lines.filter(line=>/^(memory: |memory-check |next: )/.test(line));
  assert.equal(ordered.length,4);assert.match(ordered[0],/^memory: .* \(default\)$/);
  assert.match(ordered[1],/^memory-check .*0 FAIL, 1 WARN/);
  assert.equal(ordered[2],`next: git -C ${shellQuoted(f.memory)} remote add origin PRIVATE_REMOTE_URL`);
  assert.equal(ordered[3],`next: git -C ${shellQuoted(f.memory)} push -u origin HEAD`);
  assert.ok(lines.includes('Optional: create a private repository on GitHub, then replace PRIVATE_REMOTE_URL in the first command with its address:'));
  assert.deepEqual(tree(f.memory),expected);assert.deepEqual(tree(f.target,{git:true}),host);
  const memoryPrefix=path.relative(f.root,f.memory).replaceAll(path.sep,'/')+'/';
  const outside=entries=>Object.fromEntries(Object.entries(entries).filter(([file])=>!file.startsWith(memoryPrefix)));
  assert.deepEqual(outside(tree(f.root,{git:true})),outside(dryBefore));
  assert.equal(f.git(f.memory,'rev-list','--count','HEAD'),'1');
  assert.equal(f.git(f.memory,'log','-1','--format=%s'),'Baseline memory');
  assert.deepEqual(f.git(f.memory,'show','--pretty=format:','--name-only','HEAD').split(/\r?\n/).filter(Boolean).sort(),Object.keys(expected).sort());
  assert.match(read(path.join(f.memory,'.git/hooks/pre-commit')),/memory-v3-gate/);
  const before=tree(f.root,{git:true});ok(f.cli('scripts/memory/memory-init.mjs',[],f.target));assert.deepEqual(tree(f.root,{git:true}),before);
});

test('memory-init templates are owned and resolver is shared',async()=>{
  for(const file of ['MEMORY.md','current-state.md']) {
    assert.ok(ownedFiles(kitRoot).includes('templates/'+file));
    assert.ok(Object.hasOwn(json(path.join(kitRoot,'MANIFEST.json')).files,'templates/'+file));
  }
  const installer=await import('../scripts/install.mjs'),shared=await import('../engine/memory-setup.mjs');
  assert.equal(installer.resolveMemory,shared.resolveMemory);
  const init=read(path.join(kitRoot,'engine/memory-init.mjs'));
  assert.match(init,/import .*resolveMemory.*from '.\/memory-setup.mjs'/);
  assert.doesNotMatch(init,/function resolveMemory|memoryLocation\(/);
});

test('memory-init --memory-dir outside repo persists location and reuses it',t=>{
  const f=fixture(t);ok(f.install());
  fs.rmSync(f.memory,{recursive:true,force:true});
  const memory=path.join(f.root,'external-memory');
  const first=ok(f.cli('scripts/memory/memory-init.mjs',['--memory-dir',memory],f.target));
  assert.match(first.stdout,new RegExp(`memory: ${memory.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')} \\(--memory-dir\\)`));
  assert.equal(json(path.join(f.target,'scripts/memory/KIT.local.json')).memoryDir,memory);
  const check=ok(f.cli('scripts/memory/memory-check.mjs',[],f.target));
  assert.match(check.stdout,/0 FAIL/);
  const second=ok(f.cli('scripts/memory/memory-init.mjs',[],f.target));
  assert.match(second.stdout,new RegExp(`memory already exists: ${memory.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`));
  assert.ok(!fs.existsSync(f.memory));
});

test('memory-init treats an empty existing default memory folder as missing',t=>{
  const f=fixture(t);ok(f.install());
  fs.rmSync(f.memory,{recursive:true,force:true});
  fs.mkdirSync(f.memory,{recursive:true});
  assert.equal(fs.readdirSync(f.memory).length,0);
  const init=ok(f.cli('scripts/memory/memory-init.mjs',[],f.target));
  assert.match(init.stdout,/0 FAIL, 1 WARN/);
  assert.match(init.stdout,/\(default\)/);
  assert.equal(f.git(f.memory,'rev-list','--count','HEAD'),'1');
  assert.equal(f.git(f.memory,'log','-1','--format=%s'),'Baseline memory');
  const check=ok(f.cli('scripts/memory/memory-check.mjs',[],f.target));
  assert.match(check.stdout,/0 FAIL/);
});

test('memory-init creates inside an empty existing custom outside folder and persists KIT.local.json',t=>{
  const f=fixture(t);ok(f.install());
  fs.rmSync(f.memory,{recursive:true,force:true});
  const memory=path.join(f.root,'external-memory');
  fs.mkdirSync(memory,{recursive:true});
  const init=ok(f.cli('scripts/memory/memory-init.mjs',['--memory-dir',memory],f.target));
  assert.match(init.stdout,/0 FAIL, 1 WARN/);
  assert.equal(json(path.join(f.target,'scripts/memory/KIT.local.json')).memoryDir,memory);
  const check=ok(f.cli('scripts/memory/memory-check.mjs',[],f.target));
  assert.match(check.stdout,/0 FAIL/);
});

test('memory-init refuses a non-empty folder without MEMORY.md and leaves it unchanged',t=>{
  const f=fixture(t);ok(f.install());
  fs.rmSync(f.memory,{recursive:true,force:true});
  const memory=path.join(f.root,'occupied-memory');
  fs.mkdirSync(memory,{recursive:true});
  const keepFile=path.join(memory,'keep.bin');
  const before=Buffer.from([0,1,2,3,255,4,5]);
  fs.writeFileSync(keepFile,before);
  const failed=f.cli('scripts/memory/memory-init.mjs',['--memory-dir',memory],f.target);
  assert.equal(failed.status,1);
  assert.match(failed.stderr,new RegExp(`memory folder exists, is not empty and has no MEMORY\\.md: ${memory.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}; nothing was changed. Move its files somewhere else, or choose another folder with --memory-dir`));
  assert.deepEqual(fs.readFileSync(keepFile),before);
});

test('memory-init --memory-dir in repo writes inRepoDir and prints no next lines',t=>{
  const f=fixture(t);ok(f.install());
  const memory=path.join(f.target,'memory');
  const init=ok(f.cli('scripts/memory/memory-init.mjs',['--memory-dir',memory],f.target));
  assert.equal(json(path.join(f.target,'scripts/memory/memory.config.json')).memory.inRepoDir,'memory');
  f.git(f.target,'add','memory');
  const hook=ok(f.cli('scripts/memory/memory-check.mjs',['--hook','--scope','memory'],f.target));
  assert.match(hook.stdout,/0 FAIL/);
  assert.doesNotMatch(init.stdout,/^next:/m);
  assert.ok(init.stdout.trim().split(/\r?\n/).includes('Review and commit the new notes with your project.'));
  const planned=['MEMORY.md','current-state.md'].map(name=>[path.join(memory,name),read(path.join(kitRoot,'templates',name))]);
  const {owned}=planInit({memoryDir:memory,planned,config:json(path.join(f.target,'scripts/memory/memory.config.json')),inRepo:true});
  assert.ok(fs.readdirSync(memory).every(name=>owned.has(name)));
  assert.ok(!owned.has('.git'));
});

test('memory-init refuses differing KIT.local.json memoryDir before creating folder',t=>{
  const f=fixture(t);ok(f.install());
  const localFile=path.join(f.target,'scripts/memory/KIT.local.json');
  put(localFile,JSON.stringify({memoryDir:path.join(f.root,'other-memory')},null,2)+'\n');
  const memory=path.join(f.root,'requested-memory');
  const init=f.cli('scripts/memory/memory-init.mjs',['--memory-dir',memory],f.target);
  assert.equal(init.status,1);
  assert.match(init.stderr,/The saved notes folder in KIT\.local\.json is .*but you requested .*Use the saved folder or update memoryDir/);
  assert.ok(!fs.existsSync(memory));
});

test('memory-init rolls back folder and persistence when a gate fail occurs after writes',t=>{
  const f=fixture(t);ok(f.install());
  const configFile=path.join(f.target,'scripts/memory/memory.config.json');
  const config=json(configFile);
  config.caps.router.failBytes=1;
  put(configFile,JSON.stringify(config,null,2)+'\n');
  const memory=path.join(f.root,'rollback-memory');
  const failed=f.cli('scripts/memory/memory-init.mjs',['--memory-dir',memory],f.target);
  assert.equal(failed.status,1);
  assert.match(failed.stderr,/memory-init rolled back its changes; fix the problem above and run it again\./);
  assert.doesNotMatch(failed.stderr,/Hook skipped:/);
  assert.doesNotMatch(failed.stdout,/memory-check .*1 FAIL/);
  assert.ok(!fs.existsSync(memory));
  assert.ok(!fs.existsSync(path.join(f.target,'scripts/memory/KIT.local.json')));
  assert.match(failed.stderr,/memory-check .*1 FAIL/);
});

test('memory-init rolls back folder and persistence when a later step fails',t=>{
  const f=fixture(t);ok(f.install());
  const memory=path.join(f.root,'rollback-memory');
  const failed=f.exec(process.execPath,[path.join(f.target,'scripts/memory/memory-init.mjs'),'--memory-dir',memory],{
    cwd:f.target,
    env:{...f.env,PATH:''},
  });
  assert.equal(failed.status,1);
  assert.match(failed.stderr,/git/i);
  assert.ok(!fs.existsSync(memory));
  assert.ok(!fs.existsSync(path.join(f.target,'scripts/memory/KIT.local.json')));
  const rerun=ok(f.cli('scripts/memory/memory-init.mjs',['--memory-dir',memory],f.target));
  assert.match(rerun.stdout,/0 FAIL/);
});

test('memory-init rollback keeps a pre-existing empty custom folder and rerun succeeds',t=>{
  const f=fixture(t);ok(f.install());
  fs.rmSync(f.memory,{recursive:true,force:true});
  const memory=path.join(f.root,'rollback-empty-existing');
  fs.mkdirSync(memory,{recursive:true});
  const failed=f.exec(process.execPath,[path.join(f.target,'scripts/memory/memory-init.mjs'),'--memory-dir',memory],{
    cwd:f.target,
    env:{...f.env,PATH:''},
  });
  assert.equal(failed.status,1);
  assert.ok(fs.existsSync(memory));
  assert.deepEqual(fs.readdirSync(memory),[]);
  const rerun=ok(f.cli('scripts/memory/memory-init.mjs',['--memory-dir',memory],f.target));
  assert.match(rerun.stdout,/0 FAIL/);
});

test('memory-init finds project root from script when run in subfolder by absolute path',t=>{
  const f=fixture(t);ok(f.install());
  const src=path.join(f.target,'src');
  fs.mkdirSync(src,{recursive:true});
  const memory=path.join(f.root,'absolute-memory');
  const script=path.join(f.target,'scripts/memory/memory-init.mjs');
  const init=f.exec(process.execPath,[script,'--memory-dir',memory],{cwd:src});
  assert.equal(init.status,0,init.stdout+init.stderr);
  assert.ok(fs.existsSync(memory));
  const check=ok(f.cli('scripts/memory/memory-check.mjs',[],f.target));
  assert.match(check.stdout,/0 FAIL/);
});

test('memory-init --dry-run with --memory-dir prints persistence WRITE and changes nothing',t=>{
  const f=fixture(t);ok(f.install());
  const memory=path.join(f.root,'dry-run-memory');
  const before=tree(f.root,{git:true});
  const dry=ok(f.cli('scripts/memory/memory-init.mjs',['--dry-run','--memory-dir',memory],f.target));
  const localFile=path.join(f.target,'scripts/memory/KIT.local.json');
  assert.match(dry.stdout,new RegExp(`WRITE .*${path.basename(localFile).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`));
  assert.deepEqual(tree(f.root,{git:true}),before);
  assert.ok(!fs.existsSync(memory));
});

test('memory-init --dry-run on an empty existing folder prints writes, no mkdir, and changes nothing',t=>{
  const f=fixture(t);ok(f.install());
  fs.rmSync(f.memory,{recursive:true,force:true});
  const memory=path.join(f.root,'dry-existing');
  fs.mkdirSync(memory,{recursive:true});
  const before=tree(f.root,{git:true});
  const dry=ok(f.cli('scripts/memory/memory-init.mjs',['--dry-run','--memory-dir',memory],f.target));
  assert.match(dry.stdout,/WRITE /);
  assert.doesNotMatch(dry.stdout,/^MKDIR /m);
  assert.deepEqual(tree(f.root,{git:true}),before);
  assert.deepEqual(fs.readdirSync(memory),[]);
});

test('memory-init in-repo rollback removes created nested parents and restores CRLF config bytes',t=>{
  const f=fixture(t);ok(f.install());
  const configFile=path.join(f.target,'scripts/memory/memory.config.json');
  const original=fs.readFileSync(configFile);
  const crlf=Buffer.from(original.toString('utf8').replace(/\r?\n/g,'\r\n'),'utf8');
  fs.writeFileSync(configFile,crlf);
  const memory=path.join(f.target,'docs','mem');
  const failed=f.exec(process.execPath,[path.join(f.target,'scripts/memory/memory-init.mjs'),'--memory-dir',memory],{
    cwd:f.target,
    env:{...f.env,PATH:''},
  });
  assert.equal(failed.status,1);
  assert.ok(!fs.existsSync(memory));
  assert.ok(!fs.existsSync(path.join(f.target,'docs')));
  assert.deepEqual(fs.readFileSync(configFile),crlf);
  assert.match(failed.stderr,/git/i);
});

test('memory-init outside-repo rollback removes newly created ancestor directories',t=>{
  const f=fixture(t);ok(f.install());
  fs.mkdirSync(path.join(f.root,'ext'),{recursive:true});
  fs.writeFileSync(path.join(f.root,'ext','keep.txt'),'keep\n');
  const memory=path.join(f.root,'ext','a','b');
  const failed=f.exec(process.execPath,[path.join(f.target,'scripts/memory/memory-init.mjs'),'--memory-dir',memory],{
    cwd:f.target,
    env:{...f.env,PATH:''},
  });
  assert.equal(failed.status,1);
  assert.ok(!fs.existsSync(memory));
  assert.ok(fs.existsSync(path.join(f.root,'ext','keep.txt')));
  assert.ok(fs.existsSync(f.target));
});

test('memory-init rollback restores pre-existing KIT.local.json byte for byte',t=>{
  const f=fixture(t);ok(f.install());
  fs.rmSync(f.memory,{recursive:true,force:true});
  const localFile=path.join(f.target,'scripts/memory/KIT.local.json');
  const original=Buffer.from('{\r\n  "note": "keep"\r\n}\r\n','utf8');
  fs.writeFileSync(localFile,original);
  const memory=path.join(f.root,'rollback-memory');
  const failed=f.exec(process.execPath,[path.join(f.target,'scripts/memory/memory-init.mjs'),'--memory-dir',memory],{
    cwd:f.target,
    env:{...f.env,PATH:''},
  });
  assert.equal(failed.status,1);
  assert.deepEqual(fs.readFileSync(localFile),original);
});

test('memory-init rollback for a custom path under a dangling link does not delete the link',t=>{
  const f=fixture(t);ok(f.install());
  const link=path.join(f.root,'dangling-root');
  const target=path.join(f.root,'missing-target');
  fs.symlinkSync(target,link,process.platform==='win32'?'junction':'dir');
  const memory=path.join(link,'a','b');
  const failed=f.exec(process.execPath,[path.join(f.target,'scripts/memory/memory-init.mjs'),'--memory-dir',memory],{
    cwd:f.target,
    env:{...f.env,PATH:''},
  });
  assert.equal(failed.status,1);
  const stat=fs.lstatSync(link);
  assert.ok(stat.isSymbolicLink());
  assert.ok(!fs.existsSync(path.join(f.target,'scripts/memory/KIT.local.json')));
});

test('memory-init refuses unusable dangling memory path without changing state',t=>{
  const f=fixture(t);ok(f.install());
  const memory=path.join(f.root,'dangling-memory');
  const target=path.join(f.root,'missing-target');
  fs.symlinkSync(target,memory,process.platform==='win32'?'junction':'dir');
  const before=tree(f.target,{git:true});
  const failed=f.cli('scripts/memory/memory-init.mjs',['--memory-dir',memory],f.target);
  assert.equal(failed.status,1);
  assert.match(failed.stderr,/This path is a file or broken link/);
  assert.deepEqual(tree(f.target,{git:true}),before);
});

test('memory-init refuses existing file memory path without changing state',t=>{
  const f=fixture(t);ok(f.install());
  const memory=path.join(f.root,'not-a-folder.txt');
  fs.writeFileSync(memory,'x\n');
  const before=tree(f.target,{git:true});
  const failed=f.cli('scripts/memory/memory-init.mjs',['--memory-dir',memory],f.target);
  assert.equal(failed.status,1);
  assert.match(failed.stderr,/This path is a file or broken link/);
  assert.deepEqual(tree(f.target,{git:true}),before);
});

test('memory-init refuses outside repo custom path when memory.inRepoDir is configured',t=>{
  const f=fixture(t);ok(f.install());
  const configFile=path.join(f.target,'scripts/memory/memory.config.json');
  const config=json(configFile);
  config.memory={inRepoDir:'memory'};
  put(configFile,JSON.stringify(config,null,2)+'\n');
  const memory=path.join(f.root,'custom-memory');
  const failed=f.cli('scripts/memory/memory-init.mjs',['--memory-dir',memory],f.target);
  assert.equal(failed.status,1);
  assert.match(failed.stderr,/memory\.config\.json names an in-repo memory folder: .*but you requested .*remove memory\.inRepoDir/);
  assert.ok(!fs.existsSync(memory));
});


test('memory-init owned plan covers successful entries and dry-run names',t=>{
  const f=fixture(t);ok(f.install());
  fs.rmSync(f.memory,{recursive:true,force:true});
  const planned=freshMemoryWrites(f.memory,path.join(kitRoot,'templates'));
  const {owned}=planInit({memoryDir:f.memory,planned,config:json(path.join(f.target,'scripts/memory/memory.config.json')),inRepo:false});
  const dry=ok(f.cli('scripts/memory/memory-init.mjs',['--dry-run'],f.target)).stdout;
  const printed=new Set();
  for(const line of dry.split(/\r?\n/)) {
    const match=line.match(/^(?:WRITE (?:and remove )?|INIT )(.*)$/);
    if(!match || !match[1].startsWith(f.memory+path.sep)) continue;
    printed.add(match[1].slice(f.memory.length+1).split(' (')[0].split(path.sep)[0]);
  }
  assert.deepEqual([...printed].sort(),[...owned].sort());
  assert.match(dry,/Preview only: no files will be changed\./);
  assert.ok(dry.trim().endsWith('If you have no backup to restore, run again without --dry-run to create your notes.'));
  ok(f.cli('scripts/memory/memory-init.mjs',[],f.target));
  assert.deepEqual(fs.readdirSync(f.memory).sort(),[...owned].filter(name=>name!=='.memory.lock').sort());
});
for(const state of ['existing-empty','missing']) test('memory-init rollback preserves foreign entries in '+state,t=>{
  const f=fixture(t),createdTop=path.join(f.root,'created'),memoryDir=path.join(createdTop,'nested');
  const configFile=put(path.join(f.target,'config.json'),'changed'),localFile=put(path.join(f.target,'local.json'),'changed');
  const configBefore=Buffer.from('\ufeff{"saved":true}\r\n'),localBefore=Buffer.from('{"local":true}\r\n');
  put(path.join(memoryDir,'MEMORY.md'),'owned');put(path.join(memoryDir,'.git','config'),'owned');
  const foreign=put(path.join(memoryDir,'foreign.txt'),'keep');
  const result=rollbackInit({memoryDir,owned:new Set(['MEMORY.md','.git']),state,createdTop,configFile,configBefore,localFile,localBeforeExists:true,localBefore,persistWrites:[[configFile],[localFile]],entries:[{file:path.join(memoryDir,'.git'),recursive:true}]});
  assert.deepEqual(result.problems,[]);assert.deepEqual(result.left,[foreign]);
  assert.equal(read(foreign),'keep');assert.deepEqual(fs.readdirSync(memoryDir),['foreign.txt']);
  assert.deepEqual(fs.readFileSync(configFile),configBefore);assert.deepEqual(fs.readFileSync(localFile),localBefore);
});
test('memory-init rollback preserves foreign entries in a created ancestor',t=>{
  const f=fixture(t),createdTop=path.join(f.root,'created'),memoryDir=path.join(createdTop,'nested');
  put(path.join(memoryDir,'MEMORY.md'),'owned');const foreign=put(path.join(createdTop,'foreign.txt'),'keep');
  const configFile=put(path.join(f.target,'config.json'),'changed'),localFile=path.join(f.target,'local.json');
  const result=rollbackInit({memoryDir,owned:new Set(['MEMORY.md']),state:'missing',createdTop,configFile,configBefore:Buffer.from('{}'),localFile,localBeforeExists:false});
  assert.deepEqual(result,{left:[foreign],problems:[]});assert.ok(!fs.existsSync(memoryDir));assert.equal(read(foreign),'keep');
});

test('memory-init existing notes dry-run prints only location and unchanged message', t=>{
  const f=fixture(t);ok(f.install());
  const result=ok(f.cli('scripts/memory/memory-init.mjs',['--dry-run'],f.target));
  assert.deepEqual(result.stdout.trim().split(/\r?\n/),[
    `memory: ${f.memory} (default)`,
    `memory already exists: ${f.memory}. Nothing was changed. To check it, run node scripts/memory/memory-check.mjs`
  ]);
});
test('memory-init rollback rejects invalid names and preserves unwritten persistence', t=>{
  const f=fixture(t),memoryDir=path.join(f.root,'notes');fs.mkdirSync(memoryDir);
  const configFile=put(path.join(f.target,'config.json'),'concurrent edit'),localFile=put(path.join(f.target,'local.json'),'concurrent creation');
  const sibling=put(path.join(f.root,'sib.txt'),'keep');
  const names=['','.', '..','../sib.txt','a/b','a\\b',sibling];
  const result=rollbackInit({memoryDir,owned:new Set(names),state:'existing-empty',configFile,configBefore:Buffer.from('old'),localFile,localBeforeExists:false});
  assert.equal(result.problems.length,names.length);assert.equal(read(sibling),'keep');
  assert.equal(read(configFile),'concurrent edit');assert.equal(read(localFile),'concurrent creation');
});
test('memory-init rollback reports owned directory and leaves project git intact', t=>{
  const f=fixture(t),memoryDir=path.join(f.target,'notes');fs.mkdirSync(path.join(memoryDir,'MEMORY.md'),{recursive:true});
  const before=tree(path.join(f.target,'.git'));
  const result=rollbackInit({memoryDir,owned:new Set(['MEMORY.md']),entries:[],state:'existing-empty'});
  assert.equal(result.problems.length,1);assert.deepEqual(result.left,[path.join(memoryDir,'MEMORY.md')]);
  assert.deepEqual(tree(path.join(f.target,'.git')),before);
});
test('memory-init rollback unlinks an owned junction without touching its target', t=>{
  const f=fixture(t),memoryDir=path.join(f.root,'notes'),other=path.join(f.root,'other');fs.mkdirSync(memoryDir);put(path.join(other,'keep'),'keep');
  const file=path.join(memoryDir,'.git');
  try { fs.symlinkSync(other,file,process.platform==='win32'?'junction':'dir'); }
  catch(error) { if(['EPERM','EACCES','ENOSYS'].includes(error.code)) { t.skip(error.code);return; } throw error; }
  const result=rollbackInit({memoryDir,owned:new Set(['.git']),entries:[{file,recursive:true}],state:'existing-empty'});
  assert.deepEqual(result,{left:[],problems:[]});assert.equal(read(path.join(other,'keep')),'keep');
});

for(const problem of [false,true]) test('memory-init main reports '+(problem?'incomplete rollback':'foreign entry left in place')+' exactly',t=>{
  const f=fixture(t);ok(f.install());const memory=path.join(f.root,'failed-notes');
  const script=path.join(f.target,'scripts/memory/memory-init.mjs');
  const injected=problem
    ? "const originalRemove=fs.rmSync; fs.rmSync=(file,options)=>{if(file===path.join(memory.dir,'MEMORY.md')) throw new Error('injected removal failure');return originalRemove(file,options);}; throw new Error('injected');"
    : "fs.writeFileSync(path.join(memory.dir,'foreign.txt'),'keep'); throw new Error('injected');";
  put(script,read(script).replace('finishMemory({memory,target,engine,configFile,freshMemory:true,newRepo:!inRepo,inRepo});',injected));
  const result=f.cli('scripts/memory/memory-init.mjs',['--memory-dir',memory],f.target);
  assert.equal(result.status,1);
  const expected=problem
    ? `memory-init rollback could not complete: could not remove ${path.join(memory,'MEMORY.md')}: injected removal failure; left in place: ${path.join(memory,'MEMORY.md')}`
    : `memory-init rolled back what it created; these entries were left in place: ${path.join(memory,'foreign.txt')}. Review them before you run it again.`;
  assert.deepEqual(result.stderr.trim().split(/\r?\n/),['memory-init: injected',expected]);
});
test('memory-init main explains foreign project hook exactly',t=>{
  const f=fixture(t);ok(f.install());const memory=path.join(f.target,'notes');
  put(path.join(f.target,'.git/hooks/pre-commit'),'#!/bin/sh\nexit 0\n');
  const result=ok(f.cli('scripts/memory/memory-init.mjs',['--memory-dir',memory],f.target));
  assert.ok(result.stdout.split(/\r?\n/).includes('project hook preserved; add this line to your pre-commit hook (create one if none exists), not as a one-time terminal command:'));
});

test('memory-init rollback does not rewrite unchanged config bytes',t=>{
  const f=fixture(t),memoryDir=path.join(f.root,'notes');fs.mkdirSync(memoryDir);
  const configFile=put(path.join(f.target,'config.json'),'same bytes'),configBefore=fs.readFileSync(configFile),writes=[];
  const original=fs.writeFileSync;t.mock.method(fs,'writeFileSync',(file,...args)=>{writes.push(file);return original(file,...args);});
  const result=rollbackInit({memoryDir,owned:new Set(),state:'existing-empty',configFile,configBefore,persistWrites:[[configFile]]});
  assert.deepEqual(result,{left:[],problems:[]});assert.deepEqual(writes,[]);
});
