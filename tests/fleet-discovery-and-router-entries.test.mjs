import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import childProcess from 'node:child_process';
import {fixture, put, read, json, kitRoot, ok, tree} from './helpers.mjs';
import {buildCorpus} from '../engine/memory-recall.mjs';
import {brainNameSet, memorySlug} from '../engine/lib.mjs';
import {generateIndex} from '../engine/brain-index.mjs';
import {runCheck} from '../engine/memory-check.mjs';
import {migrateRoutes} from '../engine/memory-migrate.mjs';
import {fleet} from '../engine/memory-fleet.mjs';
const cfg = () => json(path.join(kitRoot, 'engine/memory.config.json'));
function base(t) { const f = fixture(t); const memoryDir = path.join(f.root,'memory'); put(path.join(memoryDir,'MEMORY.md'),'# Memory\n'); return {...f, repo:f.target, memoryDir, config:cfg(), noGit:true}; }
test('configured brain node was not read', t => {
 const f=base(t); f.config.brain={...f.config.brain,dir:'knowledge'};
 put(path.join(f.repo,'knowledge/03-knowledge/node.md'),'---\nid: fct-custom\ntype: fact\nsummary: Configured discovery\n---\nConfigured discovery\n');
 assert.ok(buildCorpus(f).some(d=>d.path==='knowledge/03-knowledge/node.md'),'configured brain node was not read');
 assert.ok(brainNameSet(f.repo,f.config).has('fct-custom'));
 assert.match(generateIndex(f).all,/fct-custom/);
 put(path.join(f.memoryDir,'INDEX-build.md'),'# Build\n[[fct-custom]]\n');
 put(path.join(f.memoryDir,'MEMORY.md'),'- [Build](INDEX-build.md) OPEN BEFORE building.\n');
 assert.doesNotThrow(()=>migrateRoutes({...f,probesFile:path.join(f.root,'absent')}));
});
test('backtick router entries preserve wrapped triggers in gate and migration', t=>{
 const f=base(t);
 const router='- `INDEX-craft-build-workflow.md` OPEN BEFORE building\n  or testing every release.\n- `INDEX-craft-review.md` OPEN BEFORE reviewing\n  or approving any change.\n';
 put(path.join(f.memoryDir,'MEMORY.md'),router);
 for(const family of ['craft-build-workflow','craft-review']) {
 put(path.join(f.memoryDir,`INDEX-${family}.md`),`# Index\n- [Lesson](lesson-001-build.md)\n`);
 }
 put(path.join(f.memoryDir,'lesson-001-build.md'),'---\nname: Build\ndescription: Build safely\nroute: craft-build-workflow\n---\nBuild safely.\n');
 assert.equal(runCheck(f).findings.filter(x=>x.check==='route.unknown').length,0);
 migrateRoutes({...f,write:true,probesFile:path.join(f.root,'absent')});
 const after=read(path.join(f.memoryDir,'MEMORY.md'));
 assert.match(after,/\[INDEX-craft-build-workflow.md\]\(INDEX-craft-build-workflow.md\)/);
 for(const phrase of ['OPEN BEFORE building','or testing every release.','OPEN BEFORE reviewing','or approving any change.']) assert.ok(after.includes(phrase),phrase);
});
test('brain-index warning requires configured system folder', t=>{
 const f=base(t); put(path.join(f.repo,'brain/03-knowledge/node.md'),'# Node\n');
 assert.equal(runCheck(f).findings.filter(x=>x.check==='repo.brain-index').length,0);
 f.config.brain={...f.config.brain,dir:'knowledge'};
 put(path.join(f.repo,'brain/00-system/index.md'),'# Old brain\n');
 assert.equal(runCheck(f).findings.filter(x=>x.check==='repo.brain-index').length,0);
});
function fleetBase(t) { const f=fixture(t), home=path.join(f.root,'memories'); return {...f,home, options:{roots:[f.root],memoryHome:home,localFile:path.join(f.root,'absent.json')}, memory(project,slug=memorySlug(project)){return put(path.join(home,slug,'memory/MEMORY.md'),'# Memory\n');}}; }
test('fleet resolves depth two git repos and depth one non-git folders',t=>{
 const f=fleetBase(t), nested=path.join(f.root,'A/B'); fs.mkdirSync(nested,{recursive:true}); f.git(nested,'init'); f.memory(nested);
 assert.ok(fleet(f.options).projects.some(p=>p.project===nested && p.status==='not installed'));
});
test('fleet reports no repo for a non-git memory project',t=>{
 const f=fleetBase(t), folder=path.join(f.root,'plain');fs.mkdirSync(folder); f.memory(folder);
 assert.equal(fleet(f.options).projects.find(p=>p.project===folder).status,'no repo');
});
test('fleet runs marked vendored engine',t=>{
 const f=fleetBase(t), vendor=path.join(f.target,'memory-ladder-kit'); f.memory(f.target);
 put(path.join(vendor,'VERSION'),'1.2.3\n'); put(path.join(vendor,'VENDOR.md'),'Pinned kit\n');
 put(path.join(vendor,'engine/memory-check.mjs'),"console.log(JSON.stringify({findings:[{severity:'WARN',check:'vendor-proof'}]}));\n");
 const row=fleet({...f.options,projectGates:true}).projects.find(p=>p.project===f.target);
 assert.equal(row.status,'vendored'); assert.equal(row.kitVersion,'1.2.3'); assert.deepEqual(row.gate.warnChecks,['vendor-proof']);
});
test('fleet skips worktree memory status',t=>{
 const f=fleetBase(t); f.git(f.target,'add','.'); f.git(f.target,'commit','-m','fixture');
 const wt=path.join(f.root,'linked');f.git(f.target,'worktree','add','-b','fixture-worktree',wt);f.memory(wt);
 const row=fleet(f.options).projects.find(p=>p.project===wt);
 assert.equal(row.status,`worktree of ${f.target}`);assert.equal(row.gate.FAIL,null);
});
test('fleet git arguments allow ownership without config writes',t=>{
 const f=fleetBase(t), calls=[], original=childProcess.spawnSync;
 t.mock.method(childProcess,'spawnSync',(command,args,options)=>{if(command==='git') calls.push(args);return original(command,args,options);});
 syncBuiltinESMExports(); t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 fleet(f.options);assert.ok(calls.length);
 for(const args of calls) assert.deepEqual(args.slice(0,5),['--no-optional-locks','-c','core.fsmonitor=false','-c','core.untrackedCache=false']);
});
test('uninstalled FAILs and WARNs never feed fleet triggers',t=>{
 const f=fleetBase(t);const memory=path.dirname(f.memory(f.target)); put(path.join(memory,'bad.md'),'---\nname: broken\n---\nBad\n');
 f.git(f.target,'add','.');f.git(f.target,'commit','-m','fixture');f.git(memory,'init');f.git(memory,'add','.');f.git(memory,'commit','-m','fixture');
 const result=fleet(f.options), row=result.projects.find(p=>p.project===f.target);
 assert.ok(row.gate.FAIL>0);assert.equal(result.metrics.fleet.maxWarnProjects,0);
 assert.equal(result.triggers.find(t=>t.id==='ci-gate').state,'DORMANT');
});
test('orphan suggests hyphen-run slug match without changing files',t=>{
 const f=fleetBase(t);f.memory(f.target,memorySlug(f.target).replace(/-/g,'---')); const before=tree(f.root,{git:true});
 const row=fleet(f.options).projects.find(p=>!p.project);
 assert.equal(row.status,`orphan memory (maybe ${f.target})`);assert.deepEqual(tree(f.root,{git:true}),before);
});
test('already installed dry run succeeds but real install refuses',t=>{
 const f=fixture(t);put(path.join(f.target,'scripts/memory/KIT.json'),'{"version":"3.2.4"}\n');const before=tree(f.root,{git:true});
 assert.match(ok(f.install(['--dry-run'])).stdout,/already installed \(kit 3.2.4\); run scripts\/upgrade.mjs --check/);
 assert.notEqual(f.install().status,0);assert.deepEqual(tree(f.root,{git:true}),before);
});
test('shared backup branch instructions prevent project collisions',()=>{
 for(const file of ['README.md','docs/STARTER.md']) {const text=read(path.join(kitRoot,file));assert.ok(text.includes('git branch -m <project>'));assert.ok(text.includes('git push -u origin <project>'));assert.ok(text.includes('<project>/<tag>'));}
 assert.match(read(path.join(kitRoot,'docs/GLOSSARY.md')),/\*\*backup branch\*\* - /);
});

test('backtick migration preserves counted trigger words and unresolved names stay unresolved',t=>{
 const f=base(t), trigger='OPEN BEFORE consulting 12 lessons about builds';
 put(path.join(f.memoryDir,'MEMORY.md'),'- `INDEX-build.md` '+trigger+'\n  or reviewing the entire release.\n- `INDEX-missing.md` OPEN BEFORE missing.\n');
 put(path.join(f.memoryDir,'INDEX-build.md'),'# Build\n- [Build](lesson-001-build.md)\n');
 put(path.join(f.memoryDir,'lesson-001-build.md'),'---\nname: Build\ndescription: Build\nroute: build\n---\nBuild.\n');
 migrateRoutes({...f,write:true,probesFile:path.join(f.root,'absent')});
 const text=read(path.join(f.memoryDir,'MEMORY.md'));
 assert.ok(text.includes(trigger),'every word of the trigger must be retained');
 assert.ok(text.includes('  or reviewing the entire release.'));
 assert.ok(text.includes('`INDEX-missing.md`'));
});

test('install discovers configured brain system folder',t=>{
 const f=fixture(t), config=cfg();config.brain={dir:'knowledge'};
 config.caps.brainIndex.path='knowledge/00-system/index.md';config.caps.brainIndex.allPath='knowledge/00-system/index-all.md';
 put(path.join(f.target,'scripts/memory/memory.config.json'),JSON.stringify(config));
 put(path.join(f.target,'knowledge/03-knowledge/fct-schema.md'),'---\nid: fct-schema\ntype: fact\n---\n# Schema\n');
 assert.match(ok(f.install(['--dry-run'])).stdout,/DRY brain index/);
});
