import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,put,read,json,tree,ok,currentVersion} from './helpers.mjs';
import {writeMemoryIndex,generateMemoryIndex,generatedMarker} from '../engine/memory-index.mjs';
import {loadConfig,memoryFiles} from '../engine/lib.mjs';
import {runCheck} from '../engine/memory-check.mjs';
import {promoteTopics} from '../engine/memory-promote.mjs';
import {install} from '../engine/install-hooks.mjs';

const note=(name,meta='',body='Violet calibration requires a verified measurement before reuse.\n')=>`---\nname: ${name}\ndescription: Violet calibration measurements\nmetadata:\n  type: feedback\n  route: [craft-demo]\n${meta}---\n${body}`;
function setup(t) {
  const f=fixture(t),memoryDir=path.join(f.root,'memory'),config=loadConfig();
  put(path.join(memoryDir,'MEMORY.md'),'# Memory\n\n## Hard rules\n- [Rule](rule.md)\n\n## Routes\n- [Craft](INDEX-craft-demo.md) OPEN BEFORE crafting.\n');
  put(path.join(memoryDir,'alpha-note.md'),note('alpha-note','  date: 2026-01-02\n'));
  put(path.join(memoryDir,'rule.md'),note('rule','','Keep the measured result.\n'));
  put(path.join(memoryDir,'ARCHIVE.md'),'# Archive\n');
  put(path.join(f.target,'scripts/memory/memory.config.json'),JSON.stringify(config));
  writeMemoryIndex({memoryDir,config});
  const map=put(path.join(f.root,'map.json'),JSON.stringify({version:1,promote:{'alpha-note.md':{kind:'practice'}}}));
  return {...f,memoryDir,config,map};
}

test('census classes, configurable references and exact projection; output outside repository',t=>{
  const f=setup(t);
  for(const [file,meta,body] of [
    ['state.md','  state: true\n','Saved project state.'],
    ['head.md','','[Part](head-background.md)'],
    ['head-background.md','','Part 1 of [head](head.md).'],
    ['doc.md','','Documented procedure.'],
    ['extra.md','','Another documented procedure.'],
    ['knowledge.md','','Knowledge reference.'],
    ['roadmap-forward.md','','Next project steps.'],
  ]) put(path.join(f.memoryDir,file),note(file,meta,body));
  f.config.brain={dir:'knowledge'};
  put(path.join(f.target,'scripts/memory/memory.config.json'),JSON.stringify(f.config));
  put(path.join(f.target,'docs/usage.md'),'doc.md\n');
  put(path.join(f.target,'knowledge/overview.md'),'knowledge.md\n');
  const extra=put(path.join(f.root,'extra/usage.txt'),'extra.md\n');
  writeMemoryIndex({memoryDir:f.memoryDir,config:f.config});
  f.git(f.memoryDir,'init');f.git(f.memoryDir,'add','.');f.git(f.memoryDir,'commit','-m','Fixture baseline');
  const before=tree(f.memoryDir),out=path.join(f.root,'evidence');
  const r=ok(f.cli('engine/memory-census.mjs',['--memory-dir',f.memoryDir,'--repo',f.target,'--out',out,'--refs',path.dirname(extra),'--refs',extra]));
  assert.deepEqual(tree(f.memoryDir),before);
  const rows=json(path.join(out,'census.json')).rows,by=Object.fromEntries(rows.map(r=>[r.file,r]));
  for(const [file,cls] of Object.entries({'MEMORY.md':'system','state.md':'state','rule.md':'hard-rule','head.md':'chain-head','head-background.md':'chain-part','roadmap-forward.md':'roadmap','alpha-note.md':'candidate-routed','doc.md':'doc-referenced','extra.md':'doc-referenced','knowledge.md':'doc-referenced'})) assert.equal(by[file].class,cls,file);
  assert.deepEqual(by['doc.md'].ext_refs,['docs/usage.md']);assert.equal(by['extra.md'].ext_ref_count,1);
  const projection=JSON.parse(r.stdout).projections.find(r=>r[0]==='craft-demo');
  const hot=read(path.join(f.memoryDir,'INDEX-craft-demo.md')),header=hot.slice(0,hot.indexOf('- ['));
  const catalog=read(path.join(f.memoryDir,'INDEX-craft-demo-all.md')).split(/(?<=\n)/);
  const non=rows.filter(r=>r.route.includes('craft-demo')&&r.class!=='candidate-routed'&&r.class!=='system');
  const bytes=Buffer.byteLength(header)+non.reduce((n,r)=>n+Buffer.byteLength(catalog.find(line=>line.includes(`](${r.file})`))),0);
  assert.equal(projection[5],bytes);assert.equal(projection[1],projection[2]+projection[3]);
});

test('census reports the actual filesystem error',t=>{
  const f=setup(t),bad=path.join(f.root,'absent-memory');
  const r=f.cli('engine/memory-census.mjs',['--memory-dir',bad,'--repo',f.target,'--out',path.join(f.root,'out')]);
  assert.equal(r.status,1);assert.match(r.stderr,/ENOENT/);assert.ok(r.stderr.includes('absent-memory'));
});

test('selfrecall snapshot queries, rename identity and a worse rank fails',t=>{
  const f=setup(t);
  put(path.join(f.memoryDir,'generated.md'),generatedMarker+'\nGenerated content.\n');
  const snapshot=path.join(f.root,'snapshot.json');
  ok(f.cli('engine/memory-selfrecall.mjs',['snapshot','--memory-dir',f.memoryDir,'--repo',f.target,'--out',snapshot]));
  const before=json(snapshot),row=before.rows.find(r=>r.file==='alpha-note.md');
  assert.ok(row.query.includes('Violet calibration requires'));assert.equal(row.rank,1);
  assert.ok(before.rows.every(r=>!['MEMORY.md','ARCHIVE.md','generated.md'].includes(r.file)&&!r.file.startsWith('INDEX-')));
  const renamed='lesson-001-alpha.md';fs.renameSync(path.join(f.memoryDir,'alpha-note.md'),path.join(f.memoryDir,renamed));
  const map=put(path.join(f.root,'names.json'),JSON.stringify({version:1,rows:[{old:'alpha-note.md',new:renamed}]}));
  const args=['compare','--before',snapshot,'--memory-dir',f.memoryDir,'--repo',f.target,'--map',map];
  ok(f.cli('engine/memory-selfrecall.mjs',args));
  put(path.join(f.memoryDir,renamed),'# Unrelated\nAn unrelated body about amber paint.\n');
  const r=f.cli('engine/memory-selfrecall.mjs',args);assert.equal(r.status,1);assert.match(r.stdout,/alpha-note.md/);assert.match(r.stdout,/worse|regression/i);
});

test('selfrecall caps the body sentence at 200 characters and preserves snapshot queries',t=>{
  const f=setup(t);put(path.join(f.memoryDir,'alpha-note.md'),note('alpha-note','','Short.\n'+ 'Violet '.repeat(60)+'.\n'));
  const out=path.join(f.root,'snapshot.json');ok(f.cli('engine/memory-selfrecall.mjs',['snapshot','--memory-dir',f.memoryDir,'--repo',f.target,'--out',out]));
  const row=json(out).rows.find(r=>r.file==='alpha-note.md');assert.equal(row.query,'Violet calibration measurements '+('Violet '.repeat(60)+'.').slice(0,200));
  put(path.join(f.memoryDir,'alpha-note.md'),note('alpha-note','','Unrelated text with enough characters to become the query.'));
  const r=f.cli('engine/memory-selfrecall.mjs',['compare','--before',out,'--memory-dir',f.memoryDir,'--repo',f.target]);
  assert.ok([0,1].includes(r.status));assert.equal(json(out).rows.find(r=>r.file==='alpha-note.md').query,row.query);
});

test('promote scan reports file and line, fails write proof and leaves roots unchanged',t=>{
  const f=setup(t),scan=path.join(f.root,'external');put(path.join(scan,'guide.txt'),'Header\n[[alpha-note]] and alpha-note.md\n');
  const before=tree(f.memoryDir),external=tree(scan),options={memoryDir:f.memoryDir,repo:f.target,map:f.map,scan:[scan]};
  const result=promoteTopics(options);assert.equal(result.external_references.length,1);assert.equal(result.external_references[0].line,2);
  assert.ok(result.external_references[0].file.endsWith('guide.txt'));
  assert.throws(()=>promoteTopics({...options,write:true}),/proof failed/);
  assert.deepEqual(tree(f.memoryDir),before);assert.deepEqual(tree(scan),external);
});

test('promote default scan roots and repeatable scan CLI',t=>{
  const f=setup(t);put(path.join(f.target,'AGENTS.md'),'alpha-note.md\n');
  const scan=put(path.join(f.root,'scan.txt'),'[[alpha-note]]\n');
  const r=f.cli('engine/memory-migrate.mjs',['promote','--memory-dir',f.memoryDir,'--repo',f.target,'--map',f.map,'--scan',scan,'--scan',scan]);
  ok(r);const report=JSON.parse(r.stdout);assert.equal(report.external_references.length,2);
});

test('promote scan uses rehearsed rewrites and exempts protected old files',t=>{
  const f=setup(t),also=path.join(f.target,'docs');put(path.join(also,'guide.md'),'[[alpha-note]]\n');
  const result=promoteTopics({memoryDir:f.memoryDir,repo:f.target,map:f.map,also:[also],write:true});
  assert.deepEqual(result.external_references,[]);assert.match(read(path.join(also,'guide.md')),/lesson-001/);
  put(path.join(f.target,'AGENTS.md'),'alpha-note.md\n');
  assert.throws(()=>promoteTopics({memoryDir:f.memoryDir,repo:f.target,map:f.map,write:true}),/proof failed/);
  put(path.join(f.target,'AGENTS.md'),'');
  put(path.join(f.memoryDir,'beta-note.md'),note('beta-note','  date: 2026-02-01\n'));
  put(path.join(f.target,'AGENTS.md'),'beta-note.md\n');
  const protect=put(path.join(f.root,'protect.txt'),'beta-note.md\n'),map=put(path.join(f.root,'beta-map.json'),JSON.stringify({version:1,promote:{'beta-note.md':{kind:'practice'}}}));
  const exempt=promoteTopics({memoryDir:f.memoryDir,repo:f.target,map,protect,write:true});
  assert.equal(exempt.refused[0].reason,'protected file');assert.equal(exempt.external_references.length,1);assert.equal(exempt.external_references[0].protected,true);
});

test('hot budget warning measures topic and pin bytes and supports an allow ceiling',t=>{
  const f=setup(t);f.config.caps.index.hotBytes=200;
  put(path.join(f.memoryDir,'lesson-001-pinned.md'),note('pinned','  kind: practice\n  pin: true\n  date: 2026-01-01\n'));
  writeMemoryIndex({memoryDir:f.memoryDir,config:f.config});
  const finding=runCheck({memoryDir:f.memoryDir,repo:f.target,config:f.config,noGit:true}).findings.find(f=>f.check==='index.hot-budget');
  assert.match(finding.message,/topics [\d,]+ \+ pins [\d,]+ of 200 bytes/);assert.match(finding.message,/topics never leave the hot page.*LESSON-CONVERSION.md/);
  assert.equal(typeof finding.value,'number');assert.ok(finding.value>200);
  const expected=generateMemoryIndex({memoryDir:f.memoryDir,config:f.config});assert.equal(finding.value,expected.hotBudgets['craft-demo'].total);
  f.config.allow=[...(f.config.allow??[]),{check:'index.hot-budget',file:'INDEX-craft-demo.md',ceiling:finding.value,reason:'Fixture ceiling',added:'2026-01-01',until:'2099-01-01'}];
  const allowed=runCheck({memoryDir:f.memoryDir,repo:f.target,config:f.config,noGit:true}).findings.find(f=>f.check==='index.hot-budget');assert.equal(allowed.allowed,true);
});

test('regeneration and promotion create only their documented files',t=>{
  const f=setup(t),names=['ARCHIVE.md','MEMORY.md','alpha-note.md','rule.md',...Object.keys(generateMemoryIndex({memoryDir:f.memoryDir,config:f.config}).pages)];
  assert.deepEqual(fs.readdirSync(f.memoryDir).sort(),names.sort());
  promoteTopics({memoryDir:f.memoryDir,repo:f.target,map:f.map,write:true});
  assert.deepEqual(fs.readdirSync(f.memoryDir).filter(name=>!/^lesson-[0-9]+-|^promote-map-.*[.]json$/.test(name)).sort(),names.filter(name=>name!=='alpha-note.md').sort());
});

test('installed hook rejects older engine before gate, accepts equal and refreshes owned hooks',t=>{
  const f=setup(t);f.git(f.memoryDir,'init');
  const receipt=path.join(f.target,'scripts/memory/KIT.json');put(receipt,JSON.stringify({version:'3.3.2'}));
  put(path.join(f.target,'scripts/memory/memory-check.mjs'),"console.log('gate ran');\n");
  const hook=path.join(f.memoryDir,'.git/hooks/pre-commit');assert.equal(install({memoryDir:f.memoryDir,repo:f.target}).ok,true);
  const run=()=>f.exec('git',['-C',f.memoryDir,'hook','run','pre-commit']);
  const older=run();assert.equal(older.status,1);assert.match(older.stdout+older.stderr,/3\.3\.2.*3\.3\.9|3\.3\.9.*3\.3\.2/);assert.ok((older.stdout+older.stderr).includes(f.target.replaceAll('\\','/')));assert.doesNotMatch(older.stdout,/gate ran/);
  put(receipt,JSON.stringify({version:currentVersion}));const equal=ok(run());assert.match(equal.stdout+equal.stderr,/gate ran/);
  put(hook,read(hook).split('\n').slice(0,2).join('\n')+'\necho legacy\n');install({memoryDir:f.memoryDir,repo:f.target});assert.doesNotMatch(read(hook),/echo legacy/);
  put(hook,'#!/bin/sh\necho foreign\n');install({memoryDir:f.memoryDir,repo:f.target});assert.equal(read(hook),'#!/bin/sh\necho foreign\n');
});

test('install ships both conversion docs and upgrade refreshes an existing owned hook',t=>{
  const f=fixture(t);ok(f.install());
  for(const file of ['LESSON-CONVERSION.md','LESSON-CONVERSION-PROMPT.md']) assert.ok(fs.existsSync(path.join(f.target,'scripts/memory',file)));
  const hook=path.join(f.memory,'.git/hooks/pre-commit');put(hook,read(hook).split('\n').slice(0,2).join('\n')+'\necho legacy\n');
  ok(f.cli('scripts/upgrade.mjs',['--target',f.target,'--live-memory']));assert.doesNotMatch(read(hook),/echo legacy/);assert.ok(read(hook).includes(`needed="${currentVersion}"`));
});


test('lesson rollback restores the exact memory file set and init plans documented files',async t=>{
  const f=setup(t),before=tree(f.memoryDir);
  const batch=put(path.join(f.root,'batch.md'),'## Verify the gauge\nkind: practice\nroute: craft-demo\ndescription: Read the gauge before changing the measured setting.\n\nCheck the gauge before proceeding.\n');
  const {batchLessons}=await import('../engine/memory-lesson.mjs');
  assert.throws(()=>batchLessons({memoryDir:f.memoryDir,repo:f.target,file:batch,config:f.config,check:()=>{throw Error('injected gate');}}),/injected gate/);
  assert.deepEqual(tree(f.memoryDir),before);
  const {planInit}=await import('../engine/memory-init.mjs');
  const plan=planInit({memoryDir:f.memoryDir,planned:[],config:f.config,inRepo:false});
  assert.deepEqual([...plan.owned].sort(),['.git','.gitignore','.memory.lock',...Object.keys(generateMemoryIndex({memoryDir:f.memoryDir,config:f.config,files:[]}).pages)].sort());
});
