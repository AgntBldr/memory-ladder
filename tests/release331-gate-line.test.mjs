// 3.3.1 tested line-level repairs of two gate lines. Since 3.3.4 the kit owns one marked standard block and sorts
// an old section into units on a first update. Each 3.3.1 scenario is kept below in its block-model form.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,ok,put,read,tree,kitRoot,assertInstructionSpans} from './helpers.mjs';
import {standardBlockPlan} from '../scripts/install-safety.mjs';
const template=read(path.join(kitRoot,'templates/AGENTS-memory-gate.md'));
const reports=template.split(/\r?\n/).find(s=>s.startsWith('- Reports:'));
const line=template.split(/\r?\n/).find(s=>s.startsWith('- Session phrases:'));
const units=result=>result.plans[0].plan.units.map(unit=>[unit.raw,unit.outcome]);
// Plans AGENTS.md (or CLAUDE.md) in a fixture; decisions keep or drop units by their exact text.
function plan(f,text,decisions={},{name='AGENTS.md',root=kitRoot}={}) {
  if(name==='CLAUDE.md') fs.rmSync(path.join(f.target,'AGENTS.md'),{force:true});
  put(path.join(f.target,name),text);
  const first=standardBlockPlan(f.target,root,{quiet:true});
  if(!Object.keys(decisions).length) return first;
  const ids=Object.fromEntries(first.plans[0].plan.units.map(unit=>[unit.raw,unit.id]));
  const file=put(path.join(f.root,'decisions.json'),JSON.stringify({version:1,project:'fixture',decisions:Object.fromEntries(Object.entries(decisions).map(([raw,outcome])=>{
    assert.ok(ids[raw],'no unit '+JSON.stringify(raw));return [ids[raw],{outcome,reason:'fixture '+outcome,decidedBy:'fixture'}];
  }))}));
  return {...standardBlockPlan(f.target,root,{quiet:true,'instructions-decisions':file}),decisions:file};
}
const written=(result,name='AGENTS.md')=>result.writes.find(([file])=>path.basename(file)===name)?.[1];

for(const eol of ['\n','\r\n']) for(const indent of ['  ','\t']) for(const repair of [false,true]) test(`wrapped bullet is one unit, never split ${repair?'(3.3.0 insertion shape)':'(plain)'} ${JSON.stringify(eol)} ${JSON.stringify(indent)}`,t=>{
  const f=fixture(t),head='# Host\n## Memory gate\n- Run the gate at session start.\n- Never\n';
  const tail=indent+"restore the old state without the operator's word.\n"+indent+'Keep this clause too.\n',end='\n## Other\n- Keep host wording.\n';
  const source=(head+(repair?line+'\n':'')+tail+end).replaceAll('\n',eol);
  const wrapped=(repair?line+'\n':'- Never\n')+tail.slice(0,-1);
  const expected=[['## Memory gate','replace'],['- Run the gate at session start.','unclear'],...(repair?[['- Never','unclear']]:[]),[wrapped.replaceAll('\n',eol),'unclear']];
  const sorted=plan(f,source);
  assert.deepEqual(units(sorted),expected);assert.equal(sorted.refusalKind,'unclear');assert.deepEqual(sorted.writes,[]);
  assert.equal(read(path.join(f.target,'AGENTS.md')),source);
  const keep=Object.fromEntries(expected.filter(([,outcome])=>outcome==='unclear').map(([raw])=>[raw,'keep']));
  const applied=plan(f,source,keep),after=written(applied);
  assert.equal(applied.refusal,null);
  assertInstructionSpans(source,after,{kept:Object.keys(keep)});
  assert.ok(after.includes(wrapped.replaceAll('\n',eol)+eol),'continuation stays with its bullet');
  assert.ok(after.endsWith(('\n## Other\n- Keep host wording.\n').replaceAll('\n',eol)));
  if(eol==='\r\n') assert.ok(!after.replaceAll('\r\n','').includes('\n'));
});

for(const command of ['install','upgrade']) for(const name of ['AGENTS.md','CLAUDE.md']) test(`${command} sorts a wrapped gate in ${name}; previews and repeat are byte preserving`,t=>{
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
    assert.ok(result.stdout.includes(`INSTRUCTIONS ${name}: standard block add; first update: yes`));
    assert.equal(result.stdout.split(/\r?\n/).filter(s=>s.startsWith('UNCLEAR ')).length,2);
    assert.deepEqual(tree(f.root,{git:true,previous:true}),before);
  }
  const refused=run([]);assert.equal(refused.status,1);assert.match(refused.stderr,new RegExp(`${name} has 2 unclear lines in its old memory section`));
  const decisions=plan(f,source,{'- Never':'keep',[line+"\r\n\trestore the old state without the operator's word."]:'keep'},{name}).decisions;
  put(file,source);
  ok(run(['--instructions-decisions',decisions]));
  assertInstructionSpans(source,read(file),{kept:['- Never',line+"\r\n\trestore the old state without the operator's word."]});
  const before=tree(f.target);
  assert.match(ok(f.cli('scripts/upgrade.mjs',['--target',f.target])).stdout,new RegExp(`INSTRUCTIONS ${name}: standard block unchanged; first update: no`));
  assert.deepEqual(tree(f.target),before);
});

for(const ending of ['', '\n','\r\n']) test(`an unterminated last unit is kept whole and gets the file's line ending ${JSON.stringify(ending)}`,t=>{
  const f=fixture(t),eol=ending||'\n';
  const source='## Memory gate'+eol+'- Never'+eol+line+'  '+eol+'  restore'+ending;
  const unit=line+'  '+eol+'  restore',applied=plan(f,source,{'- Never':'keep',[unit]:'keep'});
  const after=written(applied);
  assert.equal(after,source.slice(0,0)+applied.plans[0].plan.spans.new1);
  assert.ok(after.endsWith('- Never'+eol+unit+eol));
  assertInstructionSpans(source,after,{kept:['- Never',unit]});
});

test('without a Memory gate heading there is no warning and the block is appended',t=>{
  const f=fixture(t),file=path.join(f.target,'AGENTS.md');put(file,'## Other\n');
  const messages=[],log=console.log;console.log=message=>messages.push(message);
  let result;
  try {result=standardBlockPlan(f.target,kitRoot);} finally {console.log=log;}
  assert.ok(!messages.some(message=>/heading missing/.test(message)));
  assert.deepEqual(messages,['INSTRUCTIONS AGENTS.md: standard block add; first update: yes']);
  assertInstructionSpans('## Other\n',written(result));
  assert.equal(read(file),'## Other\n');
});

for(const command of ['install','upgrade']) test(`${command}: an old custom Reports line is unclear; dropped, the block holds the template line`,t=>{
  const f=fixture(t);if(command==='upgrade') ok(f.install());
  const file=path.join(f.target,'AGENTS.md'),source='## Memory gate\n'+line+'\n- Reports: old\n';put(file,source);
  const run=args=>f.cli(`scripts/${command}.mjs`,['--target',f.target,...args]);
  for(const flag of ['--check','--dry-run']) {
    const before=tree(f.root,{git:true,previous:true}),result=run([flag]);
    assert.ok([0,1].includes(result.status),result.stderr);
    assert.match(result.stdout,/^UNCLEAR [0-9a-f]{12}: - Reports: old$/m);assert.match(result.stdout,/^REPLACE [0-9a-f]{12} \(current template\): - Session phrases/m);
    assert.deepEqual(tree(f.root,{git:true,previous:true}),before);
  }
  const decisions=plan(f,source,{'- Reports: old':'drop'}).decisions;
  ok(run(['--instructions-decisions',decisions]));
  assert.ok(read(file).includes(line+'\n'+reports+'\n'));assert.ok(!read(file).includes('- Reports: old'));
  assertInstructionSpans(source,read(file));
  const before=tree(f.target);assert.match(ok(f.cli('scripts/upgrade.mjs',['--target',f.target])).stdout,/standard block unchanged/);
  assert.deepEqual(tree(f.target),before);
});

for(const eol of ['\n','\r\n']) test(`the block holds every template line in order, whatever was missing ${JSON.stringify(eol)}`,t=>{
  const f=fixture(t),source=['## Memory gate','- Host rule',reports,'## Other','Keep.',''].join(eol);
  const after=written(plan(f,source,{'- Host rule':'keep'}));
  assert.ok(after.includes(line+eol+reports+eol));
  assert.ok(after.endsWith('## Other'+eol+'Keep.'+eol));
  assertInstructionSpans(source,after,{kept:['- Host rule']});
});

for(const indent of ['  - my sub','\tmy note']) test(`a template line followed by an indented line is one unit and stays whole: ${JSON.stringify(indent)}`,t=>{
  const f=fixture(t);
  for(const source of [`## Memory gate\n- A\n${line}\n${reports}\n${indent}\n`, `## Memory gate\n- A\n${reports}\n${indent}\n`]) {
    const sorted=plan(f,source);
    assert.deepEqual(units(sorted).at(-1),[reports+'\n'+indent,'unclear']);
    const after=written(plan(f,source,{'- A':'keep',[reports+'\n'+indent]:'keep'}));
    assert.ok(after.includes(reports+'\n'+indent+'\n'));
    assertInstructionSpans(source,after,{kept:['- A',reports+'\n'+indent]});
  }
});

test('a custom Session phrases bullet with continuation is one unclear unit, intact on two plans',t=>{
  const f=fixture(t),source='## Memory gate\n- X\n- Session phrases: custom first half\n  custom second half\n',unit='- Session phrases: custom first half\n  custom second half';
  for(let i=0;i<2;i++) {
    const sorted=plan(f,source);
    assert.deepEqual(units(sorted),[['## Memory gate','replace'],['- X','unclear'],[unit,'unclear']]);
    assert.equal(read(path.join(f.target,'AGENTS.md')),source);
  }
  const after=written(plan(f,source,{'- X':'drop',[unit]:'keep'}));
  assert.ok(after.endsWith('\n'+unit+'\n'));
  put(path.join(f.target,'AGENTS.md'),after);assert.deepEqual(standardBlockPlan(f.target,kitRoot,{quiet:true}).writes,[]);
});

test('old shipped wording stays kit wording when the template wording changes',t=>{
  const f=fixture(t),future=path.join(f.root,'future-kit');
  for(const file of ['VERSION','templates/shipped-instruction-lines.json','templates/CLAUDE-standard-block.md']) put(path.join(future,file),fs.readFileSync(path.join(kitRoot,file)));
  put(path.join(future,'templates/AGENTS-memory-gate.md'),'## Memory gate\n'+line+' New kit wording.\n'+reports+'\n');
  const old330='- Session phrases: when a message is only "We are starting a new session - read this and let me know when we can start" or "handover" (or /new-session, /handover), run `node scripts/memory/new-session.mjs dispatch --message "<the message>"` and follow its output; never inside a subagent or `codex exec` brief. Offer /handover at a stage end or on wrap-up.';
  const source='## Memory gate\n- Never\n'+old330+'\n  lose this clause.\n- Keep\n'+old330+'\n';
  const sorted=plan(f,source,{},{root:future});
  assert.deepEqual(units(sorted),[['## Memory gate','replace'],['- Never','unclear'],[old330+'\n  lose this clause.','unclear'],['- Keep','unclear'],[old330,'replace']]);
  assert.equal(sorted.plans[0].plan.units.at(-1).label,'kit v3.3.0..v3.3.3');
});

for(const eol of ['\n','\r\n']) for(const kind of ['missing','shipped','custom']) test(`a blank line then an indented line continues the bullet: ${kind} ${JSON.stringify(eol)}`,t=>{
  const f=fixture(t),custom='- Session phrases: custom';
  const source=('## Memory gate\n- A\n'+(kind==='missing'?'':(kind==='shipped'?line:custom)+'\n')+'\n  loose para of A\n').replaceAll('\n',eol);
  const last=(kind==='missing'?'- A':kind==='shipped'?line:custom)+eol+eol+'  loose para of A';
  const sorted=plan(f,source);
  assert.deepEqual(units(sorted).at(-1),[last,'unclear']);
  const decided=Object.fromEntries(units(sorted).filter(([,outcome])=>outcome==='unclear').map(([raw])=>[raw,'keep']));
  const after=written(plan(f,source,decided));
  assert.ok(after.includes(last+eol));
  assertInstructionSpans(source,after,{kept:Object.keys(decided)});
});
for(const eol of ['\n','\r\n']) for(const continuation of ['  user note','  - nested bullet','\n  loose note']) test(`a custom Reports bullet keeps its whole continuation ${JSON.stringify(eol)} ${JSON.stringify(continuation)}`,t=>{
  const f=fixture(t),source=('## Memory gate\n- A\n'+line+'\n- Reports: custom\n'+continuation+'\n').replaceAll('\n',eol);
  const unit=('- Reports: custom\n'+continuation).replaceAll('\n',eol);
  assert.deepEqual(units(plan(f,source)).at(-1),[unit,'unclear']);
  const after=written(plan(f,source,{'- A':'drop',[unit]:'keep'}));
  assert.ok(after.endsWith(eol+unit+eol));
  assertInstructionSpans(source,after,{kept:[unit]});
});
