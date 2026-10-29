import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,ok,tree,read,json,kitRoot,put} from './helpers.mjs';
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
  assert.equal(ordered[2],`next: git -C "${f.memory}" remote add origin <PRIVATE_REMOTE>`);
  assert.equal(ordered[3],`next: git -C "${f.memory}" push -u origin HEAD`);
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
});

test('memory-init refuses differing KIT.local.json memoryDir before creating folder',t=>{
  const f=fixture(t);ok(f.install());
  const localFile=path.join(f.target,'scripts/memory/KIT.local.json');
  put(localFile,JSON.stringify({memoryDir:path.join(f.root,'other-memory')},null,2)+'\n');
  const memory=path.join(f.root,'requested-memory');
  const init=f.cli('scripts/memory/memory-init.mjs',['--memory-dir',memory],f.target);
  assert.equal(init.status,1);
  assert.match(init.stderr,/existing KIT\.local\.json differs; resolve its memoryDir before install/);
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
  assert.match(failed.stderr,/memory path exists but is not a usable folder/);
  assert.deepEqual(tree(f.target,{git:true}),before);
});

test('memory-init refuses existing file memory path without changing state',t=>{
  const f=fixture(t);ok(f.install());
  const memory=path.join(f.root,'not-a-folder.txt');
  fs.writeFileSync(memory,'x\n');
  const before=tree(f.target,{git:true});
  const failed=f.cli('scripts/memory/memory-init.mjs',['--memory-dir',memory],f.target);
  assert.equal(failed.status,1);
  assert.match(failed.stderr,/memory path exists but is not a usable folder/);
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
  assert.match(failed.stderr,/memory\.config\.json names an in-repo memory folder \(memory\.inRepoDir\); remove that setting or use --memory-dir <that folder>/);
  assert.ok(!fs.existsSync(memory));
});
