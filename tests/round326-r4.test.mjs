import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fixture,put,read,kitRoot} from './helpers.mjs';
import {checkRouterTriggers,migrateRoutes} from '../engine/memory-migrate.mjs';
import {runCheck} from '../engine/memory-check.mjs';
import config from '../engine/selftest-config.mjs';
for(const text of ['read BEFORE a','WHEN a','TRIGGER: hooks fire','OPEN BEFORE a,\n  b or c.','OPEN BEFORE a [Craft](INDEX-craft.md) and after link']) test('conservation '+text,()=>{
 assert.throws(()=>checkRouterTriggers(text,text.startsWith('OPEN')?'OPEN BEFORE a,':''),/migration router trigger loss/);
});
function setup(t,rows){const f=fixture(t);put(path.join(f.memory,'MEMORY.md'),rows.join('\n')+'\n');for(const suffix of ['','-2'])put(path.join(f.memory,'INDEX-craft'+suffix+'.md'),'# Craft\n');return f;}
test('mixed vocabulary overflow retains own row',t=>{const rows=['- [Craft](INDEX-craft.md) — OPEN BEFORE craft work.','- [More](INDEX-craft-2.md) — '+'context '.repeat(50)+'; WHEN debugging production; read BEFORE deploying.'];const f=setup(t,rows);migrateRoutes({memoryDir:f.memory,config,write:true});assert.equal(read(path.join(f.memory,'MEMORY.md')),rows.join('\n').replace('INDEX-craft-2.md','INDEX-craft.md')+'\n');});
test('any family row satisfies triggers',t=>{const f=setup(t,['| OPEN when handling scraped input | [Craft](INDEX-craft.md) |','- Adversarial source rule. See [INDEX-craft](INDEX-craft.md).']);migrateRoutes({memoryDir:f.memory,config,write:true});assert.deepEqual(runCheck({memoryDir:f.memory,repo:f.target,config,noGit:true}).findings.filter(x=>['route.trigger','index.trigger'].includes(x.check)),[]);});
for(const [description,stem,warn] of [['install','topic-installation-notes',false],['pi','topic-pi-day',true],['x','topic-example',false]])test('whole word '+description,t=>{const f=setup(t,[]);put(path.join(f.memory,stem+'.md'),`---\nname: other\ndescription: ${description}\n---\nBody\n`);assert.equal(runCheck({memoryDir:f.memory,repo:f.target,config,noGit:true}).findings.some(x=>x.check==='desc.slug'),warn);});
test('inbox markdown rule is not parse FAIL',t=>{const f=setup(t,[]);put(path.join(f.target,'brain/99-inbox/hr.md'),'---\nA quick note.\n');assert.deepEqual(runCheck({memoryDir:f.memory,repo:f.target,config,noGit:true}).findings.filter(x=>x.check==='fm.parse'&&x.severity==='FAIL'),[]);});
import {writeMemoryIndex,generatedMarker} from '../engine/memory-index.mjs';
test('triggered shard satisfies generated family index',t=>{const f=setup(t,['- [Craft](INDEX-craft.md) — Reference material.','- [More](INDEX-craft-2.md) — WHEN debugging production.']);for(const suffix of ['','-2'])put(path.join(f.memory,'INDEX-craft'+suffix+'.md'),generatedMarker+'\n# Craft\n');writeMemoryIndex({memoryDir:f.memory,config});assert.deepEqual(runCheck({memoryDir:f.memory,repo:f.target,config,noGit:true}).findings.filter(x=>['route.trigger','index.trigger'].includes(x.check)),[]);});
