import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,ok,read,put,json,tree,kitRoot} from './helpers.mjs';
import {rawBody,splitLessons} from '../engine/memory-migrate.mjs';
import {verify} from '../engine/memory-conserve.mjs';
test('K.3 scripted conversion preserves 40 lessons plus preamble and leaves exactly three agent-step FAILs',t=>{
  const f=fixture(t);ok(f.install());const mem=f.memory;
  const topic=(name,body,extra='')=>'---\nname: '+name+'\ndescription: "Useful fixture context."\n'+extra+'---\n'+body;
  const bodies=Array.from({length:40},(_,i)=>{
    const n=i+1,id=n===40?'40a':String(n),styles=['**'+id+'. Heading**','**#'+id+' Heading**','## '+id+'. Heading','### #'+id+' Heading','#### '+id+' Heading','##### #'+id+' Heading','###### '+id+' Heading'];
    return styles[i%styles.length]+'\r\nBody for #'+id+'; retain 2026-10-22 and example-'+id+'.md.\r\n'+(i===0?'````markdown\r\n```js\r\n## 999. Fenced example\r\n```\r\n````\r\n':'')+'\r\n';
  });
  const source='Preamble context.\r\n\r\n'+bodies.join('');put(path.join(mem,'lessons.md'),source);
  put(path.join(mem,'current-state.md'),topic('current-state','## RESUME one\nOne.\n## RESUME two\nTwo.\n## CURRENT\nThree.\n','state: true\n'));
  for(const name of ['rule-one','rule-two']) { const header=topic(name,''); put(path.join(mem,name+'.md'),header+'x'.repeat(15360-Buffer.byteLength(header))); }
  put(path.join(mem,'MEMORY.md'),'# Memory\n## Hard rules\n- [One](rule-one.md)\n- [Two](rule-two.md)\n## Craft\n- [Sessions](INDEX-craft-sessions.md) OPEN BEFORE session work.\n- [Lessons](lessons.md)\n## Active work\n- [Current](current-state.md)\n- [Fact](shared-fact.md)\n- [Copy](shared-fact-copy.md)\n');
  put(path.join(f.target,'brain/03-knowledge/core/fct-shared-fact.md'),'---\nid: fct-shared-fact\ntype: fact\nsummary: Shared fixture fact\n---\nA durable fact has one home.\n');
  for(const name of ['shared-fact','shared-fact-copy']) put(path.join(mem,name+'.md'),topic(name,'A durable fact has one home.\n','metadata:\n  type: reference\n'));
  const engine='scripts/memory/';const cli=(name,args=[])=>f.cli(engine+name,['--repo',f.target,'--memory-dir',mem,...args],f.target);
  f.git(mem,'add','.');f.git(mem,'-c','core.hooksPath='+path.join(f.root,'baseline-hooks'),'commit','-m','Conversion fixture baseline');f.git(mem,'tag','synthetic-before-conversion');
  const baseline=path.join(f.root,'tokens.json');ok(cli('memory-conserve.mjs',['snapshot','--out',baseline]));
  const before=tree(mem),dry=ok(f.cli(engine+'memory-migrate.mjs',['convert','--source','lessons.md','--repo',f.target,'--memory-dir',mem],f.target));assert.deepEqual(tree(mem),before);
  const dryReport=JSON.parse(dry.stdout);assert.equal(dryReport.numbered,40);assert.equal(dryReport.unnumbered.length,1);
  // conversion includes route migration; retain all conservation assertions.
  const report=JSON.parse(ok(f.cli(engine+'memory-migrate.mjs',['convert','--source','lessons.md','--repo',f.target,'--memory-dir',mem,'--write'],f.target)).stdout);
  assert.equal(report.files.length,41);assert.equal(report.numbered,40);assert.ok(report.files.some(n=>n.startsWith('lesson-000a-')));
  const restored=report.files.map(n=>rawBody(read(path.join(mem,n)))).join('');assert.deepEqual(Buffer.from(restored),Buffer.from(source));
  assert.deepEqual(report.ids,splitLessons(source).report.ids);
  const index=read(path.join(mem,'INDEX-craft-verification.md'));assert.equal(index.split('\n').filter(l=>l.startsWith('- [#')).length,41);
  assert.match(read(path.join(mem,'lessons.md')),/moved_to:.*INDEX-craft-verification.md/);
  ok(cli('memory-check.mjs',['--ratchet-pins']));
  const verified=ok(cli('memory-conserve.mjs',['verify','--baseline',baseline]));assert.match(verified.stdout,/missing: 0 tokens/);
  assert.equal(verify({baseline,memoryDir:mem,repo:f.target}).count,0);
  const gate=cli('memory-check.mjs',['--json']);assert.equal(gate.status,1);const findings=JSON.parse(gate.stdout).findings;
  assert.deepEqual(findings.filter(x=>x.severity==='FAIL'&&!x.allowed).map(x=>x.check).sort(),['hardrule.size','hardrule.size','state.headings']);
  assert.deepEqual(findings.filter(x=>/^(lessons\.|stub\.|link\.|index\.(pin|missing-pin))/.test(x.check)),[]);
  const probes=put(path.join(f.root,'probes.json'),JSON.stringify({version:1,minPass:0.8,probes:[{id:'current',q:'current state resume',expect:['current-state.md'],source:'fixture'}]}));ok(cli('memory-recall.mjs',['--probe',probes]));
  console.log('K.3 fixture: 40 ids, 41 files, 41 index lines; body bytes identical; verify count: 0; exactly 3 expected FAILs (state.headings, hardrule.size x2)');
});
test('CONVERT whole-file block proof conserves order, rejects altered blocks and records accepted reasons',t=>{
  const f=fixture(t);ok(f.install());const source=put(path.join(f.target,'whole.md'),'Preamble\n## First\nAlpha\n## Second\nBeta\n'),baseline=path.join(f.root,'blocks.json');
  const cli=args=>f.cli('scripts/memory/memory-conserve.mjs',[...args,'--repo',f.target,'--memory-dir',f.memory],f.target);
  ok(cli(['blocks-snapshot','--source',source,'--out',baseline]));
  const dest=put(path.join(f.target,'moved.md'),read(source));let r=ok(cli(['blocks-verify','--baseline',baseline,'--dest',dest,'--json']));assert.match(r.stdout,/"missing": 0/);
  put(dest,read(dest).replace('Beta','Changed'));r=cli(['blocks-verify','--baseline',baseline,'--dest',dest,'--json']);assert.equal(r.status,1);
  const accepted=put(path.join(f.root,'accepted.json'),JSON.stringify({accepted:[{source:'whole.md',heading:'## Second',reason:'Reviewed fixture change; original retained by baseline.'}]}));ok(cli(['blocks-verify','--baseline',baseline,'--dest',dest,'--accepted',accepted,'--json']));
});
