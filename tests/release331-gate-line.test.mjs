import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,ok,put,read,tree,kitRoot} from './helpers.mjs';
import {gateLinePlan} from '../scripts/install-safety.mjs';
const reports=read(path.join(kitRoot,'templates/AGENTS-memory-gate.md')).split(/\r?\n/).find(s=>s.startsWith('- Reports:'));
const line=read(path.join(kitRoot,'templates/AGENTS-memory-gate.md')).split(/\r?\n/).find(s=>s.startsWith('- Session phrases:'));
for(const eol of ['\n','\r\n']) for(const indent of ['  ','\t']) for(const repair of [false,true]) test(`wrapped gate ${repair?'repair':'insertion'} ${JSON.stringify(eol)} ${JSON.stringify(indent)}`,t=>{
  const f=fixture(t),file=path.join(f.target,'AGENTS.md');
  const head='# Host\n## Memory gate\n- Run the gate at session start.\n- Never\n';
  const tail=indent+"restore the old state without the operator's word.\n"+indent+'Keep this clause too.\n';
  const end='\n## Other\n- Keep host wording.\n';
  const source=(head+(repair?line+'\n':'')+tail+end).replaceAll('\n',eol);
  const expected=(head+tail+line+'\n'+reports+'\n'+end).replaceAll('\n',eol);
  put(file,source);
  for(const opts of [{check:true},{'dry-run':true},{}]) {
    assert.equal(gateLinePlan(f.target,kitRoot,opts)[1],expected);
    assert.equal(read(file),source);
  }
  put(file,expected);assert.equal(gateLinePlan(f.target,kitRoot),null);assert.equal(read(file),expected);
  // A line after an existing continuation is also a misplaced line.
  if(repair) {
    put(file,(head+indent+'First clause.\n'+line+'\n'+tail+end).replaceAll('\n',eol));
    assert.equal(gateLinePlan(f.target,kitRoot)[1],(head+indent+'First clause.\n'+tail+line+'\n'+reports+'\n'+end).replaceAll('\n',eol));
    put(file,gateLinePlan(f.target,kitRoot)[1]);assert.equal(gateLinePlan(f.target,kitRoot),null);
  }
});
for(const command of ['install','upgrade']) for(const name of ['AGENTS.md','CLAUDE.md']) test(`${command} repairs wrapped gate in ${name}, previews and repeat are byte preserving`,t=>{
  const f=fixture(t);
  if(command==='upgrade') ok(f.install());
  const file=path.join(f.target,name);
  if(name==='CLAUDE.md') fs.unlinkSync(path.join(f.target,'AGENTS.md'));
  const source="## Memory gate\r\n- Never\r\n"+line+"\r\n\trestore the old state without the operator's word.\r\n";
  put(file,source);
  const run=args=>f.cli(`scripts/${command}.mjs`,['--target',f.target,...args]);
  for(const flag of ['--check','--dry-run']) {
    const before=tree(f.root,{git:true,previous:true}),result=run([flag]);
    assert.ok([0,1].includes(result.status),result.stderr);
    assert.ok(result.stdout.includes('Session phrases gate line: would update in '+name));
    assert.ok(result.stdout.includes('Reports gate line: would add in '+name));
    assert.deepEqual(tree(f.root,{git:true,previous:true}),before);
  }
  assert.ok(ok(run([])).stdout.includes('Session phrases gate line: updated in '+name));
  const expected=source.replace(line+'\r\n','')+line+'\r\n'+reports+'\r\n';
  assert.equal(read(file),expected);
  const before=tree(f.target);
  const repeat=ok(f.cli('scripts/upgrade.mjs',['--target',f.target]));
  assert.match(repeat.stdout,/Session phrases gate line: present/);
  assert.deepEqual(tree(f.target),before);
});

for(const label of ['Session phrases','Reports']) for(const eol of ['\n','\r\n']) test(`${label} custom continuation stays with its bullet ${JSON.stringify(eol)}`,t=>{
  const f=fixture(t),file=path.join(f.target,'AGENTS.md'),managed='- '+label+': first half';
  const prefix='## Memory gate\n- X\n'+(label==='Reports'?line+'\n':'');
  const source=(prefix+'- '+label+': first half\n  second half\n  - user child\n').replaceAll('\n',eol);
  put(file,source);
  const result=gateLinePlan(f.target,kitRoot)?.[1]??source;
  assert.ok(result.includes(managed+eol+'  second half'+eol+'  - user child'+eol));
  assert.ok(result.includes('- X'+eol+(label==='Reports'?line+eol:'')+managed));
  put(file,result);assert.equal(gateLinePlan(f.target,kitRoot),null);
});
for(const label of ['Session phrases','Reports']) for(const ending of ['', '\n','\r\n']) test(`${label} shipped repair preserves ending ${JSON.stringify(ending)}`,t=>{
  const f=fixture(t),file=path.join(f.target,'AGENTS.md'),eol=ending||'\n';
  const source='## Memory gate'+eol+(label==='Reports'?line+eol:'')+'- Never'+eol+(label==='Reports'?reports:line)+'  '+eol+'  restore'+ending;
  put(file,source);
  const result=gateLinePlan(f.target,kitRoot)[1];
  assert.ok(result.includes(label==='Session phrases'?'- Never'+eol+'  restore'+eol:reports+eol+'  restore'));
  assert.equal(result.endsWith('\n'),Boolean(ending));
  if(ending==='\r\n') assert.ok(!result.replaceAll('\r\n','').includes('\n'));
  put(file,result);assert.equal(gateLinePlan(f.target,kitRoot),null);
});
test('both lines are named by missing-heading warning without writes',t=>{
  const f=fixture(t),file=path.join(f.target,'AGENTS.md');put(file,'## Other\n');
  const messages=[],log=console.log;console.log=message=>messages.push(message);
  try {for(let i=0;i<2;i++) assert.equal(gateLinePlan(f.target,kitRoot),null);} finally {console.log=log;}
  assert.deepEqual(messages,Array(2).fill('WARN Memory gate heading missing; add: '+line+'\n'+reports));
  assert.equal(read(file),'## Other\n');
});
for(const command of ['install','upgrade']) test(`${command} Reports refresh previews and repeat`,t=>{
  const f=fixture(t);if(command==='upgrade') ok(f.install());
  const file=path.join(f.target,'AGENTS.md');put(file,'## Memory gate\n'+line+'\n- Reports: old\n');
  const run=args=>f.cli(`scripts/${command}.mjs`,['--target',f.target,...args]);
  for(const flag of ['--check','--dry-run']) {
    const before=tree(f.root,{git:true,previous:true}),result=run([flag]);
    assert.ok([0,1].includes(result.status),result.stderr);
    assert.match(result.stdout,/Reports gate line: would update in AGENTS.md/);
    assert.deepEqual(tree(f.root,{git:true,previous:true}),before);
  }
  assert.match(ok(run([])).stdout,/Reports gate line: updated in AGENTS.md/);
  assert.ok(read(file).includes(line+'\n'+reports));
  const before=tree(f.target);assert.match(ok(f.cli('scripts/upgrade.mjs',['--target',f.target])).stdout,/Reports gate line: present in AGENTS.md/);
  assert.deepEqual(tree(f.target),before);
});

for(const eol of ['\n','\r\n']) test(`missing Session phrases is restored before existing Reports ${JSON.stringify(eol)}`,t=>{
  const f=fixture(t),file=path.join(f.target,'AGENTS.md');
  const source=['## Memory gate','- Host rule',reports,'## Other','Keep.',''].join(eol);
  put(file,source);
  const result=gateLinePlan(f.target,kitRoot)[1];
  assert.equal(result,source.replace(reports,line+eol+reports));
  put(file,result);assert.equal(gateLinePlan(f.target,kitRoot),null);
});

for(const indent of ['  - my sub','\tmy note']) test(`Reports never moves: ${JSON.stringify(indent)}`,t=>{
  const f=fixture(t),file=path.join(f.target,'AGENTS.md');
  for(const source of [`## Memory gate\n- A\n${line}\n${reports}\n${indent}\n`, `## Memory gate\n- A\n${reports}\n${indent}\n`]) {
    put(file,source);const result=gateLinePlan(f.target,kitRoot)?.[1]??source;
    assert.ok(result.includes(reports+'\n'+indent+'\n'));
    put(file,result);assert.equal(gateLinePlan(f.target,kitRoot),null);
  }
});
test('custom Session continuation warns exactly and stays intact on two runs',t=>{
  const f=fixture(t),file=path.join(f.target,'AGENTS.md');
  const source='## Memory gate\n- X\n- Session phrases: custom first half\n  custom second half\n';
  put(file,source);
  for(let i=0;i<2;i++) {
    const messages=[],log=console.log;console.log=s=>messages.push(s);let plan;
    try {plan=gateLinePlan(f.target,kitRoot);} finally {console.log=log;}
    assert.deepEqual(messages.filter(s=>s.startsWith('WARN')),['WARN custom Session phrases line has continuation lines; kept as is; replace the whole bullet, including its indented lines, with: '+line]);
    if(i===0) {assert.equal(plan[1],source+reports+'\n');put(file,plan[1]);}
    else assert.equal(plan,null);
  }
});

test('historical kit Session phrases remain repairable when template wording changes',t=>{
  const f=fixture(t),file=path.join(f.target,'AGENTS.md'),future=path.join(f.root,'future-kit');
  const newer=line+' New kit wording.';
  put(path.join(future,'templates/AGENTS-memory-gate.md'),'## Memory gate\n'+newer+'\n'+reports+'\n');
  put(file,'## Memory gate\n- Never\n'+line+'\n  lose this clause.\n');
  const result=gateLinePlan(f.target,future)[1];
  assert.equal(result,'## Memory gate\n- Never\n  lose this clause.\n'+newer+'\n'+reports+'\n');
  put(file,result);assert.equal(gateLinePlan(f.target,future),null);
});

for(const eol of ['\n','\r\n']) for(const kind of ['missing','shipped','custom']) test(`loose continuation ${kind} ${JSON.stringify(eol)} on two runs`,t=>{
  const f=fixture(t),file=path.join(f.target,'AGENTS.md');
  const custom='- Session phrases: custom';
  const source=('## Memory gate\n- A\n'+(kind==='missing'?'':(kind==='shipped'?line:custom)+'\n')+'\n  loose para of A\n').replaceAll('\n',eol);
  const expected=(kind==='custom'?source:'## Memory gate'+eol+'- A'+eol+eol+'  loose para of A'+eol+line+eol)+reports+eol;
  put(file,source);
  const result=gateLinePlan(f.target,kitRoot)[1];assert.equal(result,expected);
  put(file,result);assert.equal(gateLinePlan(f.target,kitRoot),null);assert.equal(read(file),expected);
});
for(const eol of ['\n','\r\n']) for(const continuation of ['  user note','  - nested bullet','\n  loose note']) test(`custom Reports keeps whole bullet ${JSON.stringify(eol)} ${JSON.stringify(continuation)}`,t=>{
  const f=fixture(t),file=path.join(f.target,'AGENTS.md');
  const source=('## Memory gate\n- A\n'+line+'\n- Reports: custom\n'+continuation+'\n').replaceAll('\n',eol);
  put(file,source);
  for(let i=0;i<2;i++) {
    const messages=[],log=console.log;console.log=s=>messages.push(s);
    try {assert.equal(gateLinePlan(f.target,kitRoot),null);} finally {console.log=log;}
    assert.deepEqual(messages,['Session phrases gate line: present in AGENTS.md','WARN custom Reports line has continuation lines; kept as is; replace the whole bullet, including its indented lines, with: '+reports]);
    assert.equal(read(file),source);
  }
});
