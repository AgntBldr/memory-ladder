import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {lessonCases, parseFrontmatter} from '../engine/lib.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const put = (p, s) => { fs.mkdirSync(path.dirname(p), {recursive:true}); fs.writeFileSync(p, s); return p; };
function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit328-')), repo = path.join(tmp, 'repo'), memory = path.join(tmp, 'memory'), engine = path.join(repo, 'scripts/memory');
  fs.mkdirSync(memory); fs.cpSync(path.join(root, 'engine'), engine, {recursive:true});
  fs.cpSync(path.join(root, 'templates'), path.join(engine, 'templates'), {recursive:true});
  fs.copyFileSync(path.join(root, 'docs/LESSON-KINDS.md'), path.join(engine, 'LESSON-KINDS.md'));
  put(path.join(memory, 'MEMORY.md'), '# Memory\n- [First](INDEX-first.md) OPEN BEFORE testing.\n- [Second](INDEX-second.md) OPEN BEFORE checking.\n');

  t.after(() => fs.rmSync(tmp, {recursive:true, force:true}));
  const cli = (tool, args) => spawnSync(process.execPath, [path.join(engine, tool+'.mjs'), '--repo', repo, '--memory-dir', memory, '--today', '2026-10-28', ...args], {encoding:'utf8', windowsHide:true});
  assert.equal(cli('memory-index', ['--write']).status, 0);
  const lesson = (...args) => cli('memory-lesson', args);
  const gate = () => JSON.parse(cli('memory-check', ['--no-git', '--json']).stdout);
  const labels = (name, kinds, extra={}) => put(path.join(tmp, name+'.json'), JSON.stringify({version:1,kinds,...extra}));
  const row = (extra='') => put(path.join(memory, 'lesson-001-example.md'), '---\nname: lesson-001-example\ndescription: A reusable test rule.\nmetadata:\n  type: feedback\n  kind: mistake\n  route: ["first"]\n  date: 2026-10-28\n'+extra+'---\n\n**#001. Example.**\n\nApply a reusable check.\n');
  return {tmp,repo,memory,engine,cli,lesson,gate,labels,row};
}
const ok = r => { assert.equal(r.status, 0, r.stderr+r.stdout); return r; };
const metadata = p => parseFrontmatter(fs.readFileSync(p,'utf8')).data.metadata;
test('328 new case, route order and separator', t => {
  const f=setup(t), r=ok(f.lesson('new','--kind','practice','--route','second','--route','first','--case','K4','Verify before use'));
  const m=metadata(r.stdout.trim()); assert.equal(m.kind_case,'K4'); assert.deepEqual(m.route,['second','first']);
  ok(f.lesson('new','--kind','mistake','--route','first','--','--title=value'));
});
test('328 new rejects unknown case and equals syntax before writing', t => {
  const f=setup(t);
  for(const [args,message] of [ [['--case','K99'],'unknown kind case K99; see LESSON-KINDS.md'], [['--route=first'],'--route=first is not supported; use --route first'], [['--today=2026-10-28'],'--today=2026-10-28 is not supported; use --today 2026-10-28'] ]) {
    const r=f.lesson('new','--kind','practice','--route','first',...args,'Example'); assert.equal(r.status,1); assert.equal(r.stderr,'memory-lesson: '+message+'\n');
  }
  assert.equal(fs.readdirSync(f.memory).filter(x=>x.startsWith('lesson-')).length,0);
});
test('328 batch case dry run, write and invalid case atomicity', t => {
  const f=setup(t), batch=id=>put(path.join(f.tmp,'batch.md'),`## Deliberate check\nkind: practice\ncase: ${id}\nroute: first\ndescription: Catch errors before relying on a result.\n\nUse a deliberate check.\n`);
  ok(f.lesson('batch',batch('K4'),'--dry-run')); assert.equal(fs.existsSync(path.join(f.memory,'lesson-001-deliberate-check.md')),false);
  ok(f.lesson('batch',batch('K4'))); assert.equal(metadata(path.join(f.memory,'lesson-001-deliberate-check.md')).kind_case,'K4');
  const r=f.lesson('batch',batch('K99')); assert.equal(r.status,1); assert.equal(r.stderr,'memory-lesson: batch line 1: unknown kind case K99; see LESSON-KINDS.md\n');
  assert.equal(fs.readdirSync(f.memory).filter(x=>x.startsWith('lesson-')).length,1);
});
test('328 classify writes case even when kind unchanged, filters and validates', t => {
  const f=setup(t), row=f.row(), name=path.basename(row), file=f.labels('labels',{[name]:'mistake'},{cases:{[name]:'K3'},confidence:{[name]:0.9}});
  ok(f.lesson('classify',file)); assert.equal(metadata(row).kind_case,undefined);
  assert.equal(ok(f.lesson('classify',file,'--write')).stdout.split('\n')[0],'classify: 1 lessons (mistake 1, practice 0, observation 0); 0 unchanged; takeaways 0');
  assert.equal(metadata(row).kind_case,'K3');
  assert.equal(ok(f.lesson('classify','--case','K3')).stdout,'lesson-001-example.md\n');
  assert.deepEqual(JSON.parse(ok(f.lesson('classify','--case','K3','--json')).stdout),['lesson-001-example.md']);
  assert.equal(ok(f.lesson('classify','--case','K4')).stdout,'');
  assert.match(ok(f.lesson('classify',file)).stdout,/1 unchanged/);
  ok(f.lesson('classify',f.labels('no-case',{[name]:'practice'}),'--write')); assert.equal(metadata(row).kind_case,'K3');
  ok(f.lesson('classify',file,'--write'));
  const bad=f.labels('bad',{[name]:'practice'},{cases:{[name]:'K99'}}), r=f.lesson('classify',bad,'--write'); assert.equal(r.status,1); assert.equal(r.stderr,'memory-lesson: labels classify row "lesson-001-example.md": unknown kind case K99; see LESSON-KINDS.md\n'); assert.equal(metadata(row).kind,'mistake');
});
test('328 gate case missing, unknown and superseded are warnings only', t => {
  const f=setup(t); f.row('  kind_case: K99\n');
  let findings=f.gate().findings.filter(x=>x.check.startsWith('kind.case'));
  assert.deepEqual(findings.map(x=>[x.severity,x.check,x.message]),[['WARN','kind.case','unknown kind case K99; see LESSON-KINDS.md']]);
  assert.ok(f.cli('memory-check',['--no-git']).stdout.split('\n').includes('WARN kind.case lesson-001-example.md unknown kind case K99; see LESSON-KINDS.md'));
  f.row('  kind_case: K4\n'); fs.appendFileSync(path.join(f.engine,'LESSON-KINDS.md'),'\n## K11\nQuestion: Changed rule?\nClassification: Use the new rule.\nExample: A generic check.\nStatus: current\nsupersedes: K4\n');
  findings=f.gate().findings.filter(x=>x.check.startsWith('kind.case'));
  assert.deepEqual(findings.map(x=>[x.severity,x.check,x.message]),[['WARN','kind.case-superseded','kind case K4 is superseded by K11; relabel with classify --write']]);
  assert.ok(f.cli('memory-check',['--no-git']).stdout.split('\n').includes('WARN kind.case-superseded lesson-001-example.md kind case K4 is superseded by K11; relabel with classify --write'));
  fs.unlinkSync(path.join(f.engine,'LESSON-KINDS.md'));
  assert.deepEqual(f.gate().findings.filter(x=>x.check==='kind.case').map(x=>x.message),['LESSON-KINDS.md is missing; cannot validate kind case K4']);
  assert.ok(f.cli('memory-check',['--no-git']).stdout.split('\n').includes('WARN kind.case lesson-001-example.md LESSON-KINDS.md is missing; cannot validate kind case K4'));
  assert.equal(f.lesson('new','--kind','practice','--route','first','--case','K4','Missing book').stderr,'memory-lesson: LESSON-KINDS.md is missing; cannot validate kind case K4\n');
  f.row(); assert.equal(f.gate().findings.filter(x=>x.check.startsWith('kind.case')).length,0);
});
test('328 score exact report, reference, unscored and JSON', t => {
  const f=setup(t), kinds={a:'mistake',b:'practice',c:'observation',d:'mistake'}, a=f.labels('a',kinds), b=f.labels('b',{...kinds,d:'observation'}), ref=f.labels('ref',kinds,{unscored:['d']});
  const r=ok(f.lesson('classify','--score',a,b,'--reference',ref));
  assert.equal(r.stdout,'score: 4 rows compared; 1 A-B disagreements (25.00%)\nA: mistake 2, practice 1, observation 1\nB: mistake 1, practice 1, observation 2\ndisagreements <= 0/4\nkind test: FAIL\nhistorical mark: overall >= 3/3 (84%); practice+observation >= 2/2 (70%); disagreements <= 0/4 (15%)\nconstant-mistake baseline: 1/3; practice+observation 0/2\nA: reference 3/3; practice+observation 2/2; historical FAIL\nB: reference 3/3; practice+observation 2/2; historical FAIL\n');
  const j=JSON.parse(ok(f.lesson('classify','--score',a,b,'--reference',ref,'--json')).stdout); assert.equal(j.compared,4); assert.equal(j.A.verdict,'FAIL');
  assert.equal(ok(f.lesson('classify','--score',a,b)).stdout,'score: 4 rows compared; 1 A-B disagreements (25.00%)\nA: mistake 2, practice 1, observation 1\nB: mistake 1, practice 1, observation 2\ndisagreements <= 0/4\nkind test: FAIL\n');
});
test('328 score enforces all three thresholds and missing predictions count wrong', t => {
  const f=setup(t), kinds=Object.fromEntries(Array.from({length:25},(_,i)=>['row'+i,i<15?'mistake':i<20?'practice':'observation'])), ref=f.labels('ref',kinds);
  const almost={...kinds}; for(let i=15;i<19;i++) almost['row'+i]='mistake';
  const a=f.labels('a',almost), b=f.labels('b',almost);
  let j=JSON.parse(ok(f.lesson('classify','--score',a,b,'--reference',ref,'--json')).stdout); assert.equal(j.A.correct,21); assert.equal(j.A.practiceObservation.correct,6); assert.equal(j.A.verdict,'FAIL');
  assert.ok(ok(f.lesson('classify','--score',a,b,'--reference',ref)).stdout.split('\n').includes('A: reference 21/25; practice+observation 6/10; historical FAIL'));
  delete almost.row19; const missing=f.labels('missing',almost); j=JSON.parse(ok(f.lesson('classify','--score',missing,b,'--reference',ref,'--json')).stdout); assert.equal(j.A.correct,20);
  const different=f.labels('different',kinds); j=JSON.parse(ok(f.lesson('classify','--score',different,b,'--reference',ref,'--json')).stdout); assert.equal(j.A.correct,25); assert.equal(j.A.verdict,'FAIL');
  const empty=f.labels('empty',{});
  for(const [left,right,reference] of [[empty,empty,ref],[a,b,empty]]) assert.equal(JSON.parse(ok(f.lesson('classify','--score',left,right,'--reference',reference,'--json')).stdout).A.verdict,'FAIL');
});
test('328 score rejects bad input', t => {
  const f=setup(t), a=f.labels('a',{a:'mistake'});
  for(const [spec,message] of [
    [{version:2,kinds:{}},'labels require version 1 and a kinds map'],
    [{version:1,kinds:{a:'recipe'}},'labels kinds must be mistake, practice or observation'],
    [{version:1,kinds:{a:'mistake'},confidence:{a:2}},'labels confidence must be a number from 0 to 1'],
    [{version:1,kinds:{a:'mistake'},cases:{a:4}},'labels cases must be strings'],
    [{version:1,kinds:{a:'mistake'},unscored:'a'},'labels unscored must be an array of row names'],
    [{version:1,kinds:{a:'mistake'},cases:[]},'labels cases must be a map'],
    [{version:1,kinds:{a:'mistake'},confidence:[]},'labels confidence must be a map'],
    [{version:1,kinds:{a:'mistake'},cases:{b:'K4'}},'labels cases row has no kind: b'],
    [{version:1,kinds:{a:'mistake'},confidence:{b:1}},'labels confidence row has no kind: b']
  ]) {
    const b=put(path.join(f.tmp,'bad.json'),JSON.stringify(spec)), r=f.lesson('classify','--score',a,b);
    assert.equal(r.status,1); const row = spec.cases?.b !== undefined || spec.confidence?.b !== undefined ? 'b' : spec.kinds?.a && !Array.isArray(spec.cases) && !Array.isArray(spec.confidence) && spec.unscored === undefined ? 'a' : '<document>';
    assert.equal(r.stderr,`memory-lesson: labels B row ${JSON.stringify(row)}: ${message}\n`);
  }
  const missing=f.lesson('classify','--score',a); assert.equal(missing.status,1); assert.equal(missing.stderr,'memory-lesson: score requires two label files and cannot write or filter cases\n');
  const invalid=put(path.join(f.tmp,'invalid.json'),'{'); assert.equal(f.lesson('classify','--score',a,invalid).stderr,'memory-lesson: labels B row "<document>": cannot read labels JSON\n');

});
for(const [group,value] of [['topic',null],['router',5],['lesson',[]],['description','bad']]) test('328 caps group '+group, t => {
  const f=setup(t), file=path.join(f.engine,'memory.config.json'), config=JSON.parse(fs.readFileSync(file)); config.caps[group]=value; put(file,JSON.stringify(config));
  if(group==='topic') put(path.join(f.memory,'topic.md'),'---\nname: topic\ndescription: Read before a long task.\n---\n'+'word '.repeat(5000));
  if(group==='router') fs.appendFileSync(path.join(f.memory,'MEMORY.md'),'\n'.repeat(201));
  if(group==='lesson') f.row('  repeats: '+JSON.stringify(Array(4).fill('2026-10-28 slip: repeated'))+'\n');
  if(group==='description') { const row=f.row(); put(row,fs.readFileSync(row,'utf8').replace('A reusable test rule.','x'.repeat(401))); }
  assert.ok(f.gate().findings.some(x=>x.severity==='FAIL' && x.check===({topic:'topic.size',router:'router.lines',lesson:'lesson.enforce',description:'desc.length'}[group])));
  const findings=f.gate().findings.filter(x=>x.check==='config.caps'); assert.equal(findings.length,1); assert.equal(findings[0].severity,'FAIL'); assert.equal(findings[0].message,`caps.${group} has invalid value ${JSON.stringify(value)}; using defaults`);
  assert.ok(f.cli('memory-check',['--no-git']).stdout.split('\n').includes(`FAIL config.caps memory.config.json caps.${group} has invalid value ${JSON.stringify(value)}; using defaults`));
});
test('328 enforce rejects junction escapes for hook and check', t => {
  const f=setup(t); f.row(); const outside=path.join(f.tmp,'outside'); put(path.join(outside,'check.mjs'),'// check\n'); fs.symlinkSync(outside,path.join(f.repo,'escape'),process.platform==='win32'?'junction':'dir');
  for(const kind of ['hook','check']) {const r=f.lesson('enforce','1',kind+' escape/check.mjs'); assert.equal(r.status,1); assert.equal(r.stderr,'memory-lesson: '+(kind==='hook'?'hook path must be an existing file under the repo':'check must be an emitted check id or an existing file under the repo')+'\n');}
  put(path.join(f.repo,'check.mjs'),'// check\n'); ok(f.lesson('enforce','1','check check.mjs'));
  const inside=path.join(f.repo,'inside'); put(path.join(inside,'check.mjs'),'// check\n'); fs.symlinkSync(inside,path.join(f.repo,'safe-link'),process.platform==='win32'?'junction':'dir');
  ok(f.lesson('enforce','1','hook safe-link/check.mjs'));
});
test('328 invalid enforcement explains escalation at WARN and FAIL', t => {
  const f=setup(t);
  for(const n of [2,4]) {
    f.row('  enforced: invalid\n  repeats: '+JSON.stringify(Array(n).fill('2026-10-28 slip: repeated'))+'\n');
    const finding=f.gate().findings.find(x=>x.check==='lesson.enforce'); assert.equal(finding.severity,n===2?'WARN':'FAIL'); const prefix=n===2?'repeated 2 times (last 2026-10-28); decide where the mistake is visible: in the command (hook), in a file (check), or only in judgment (hard-rule card or lesson-only), then run memory-lesson.mjs enforce 001 "<hook|check|hard-rule|lesson-only> <where>"':'repeated 4 times with no recorded decision; record one with memory-lesson.mjs enforce 001 "<hook|check|hard-rule|lesson-only> <where>" (lesson-only with a reason counts)';
    const message=prefix+'; the recorded decision is invalid: enforced must name a valid date and hard-rule card, check, repo hook file or lesson-only reason of at least 10 characters';
    assert.equal(finding.message,message); assert.ok(f.cli('memory-check',['--no-git']).stdout.split('\n').includes(`${finding.severity} lesson.enforce lesson-001-example.md ${message}`));
  }
});

test('328 fix score union, unsure reference and omissions', t => {
  const f=setup(t), kinds=Object.fromEntries(Array.from({length:40},(_,i)=>['row'+i,i<15||i>=25?'mistake':i<20?'practice':'observation']));
  const other={...kinds}; for(let i=34;i<40;i++) other['row'+i]='practice';
  const a=f.labels('a',kinds), b=f.labels('b',other), reference=Object.fromEntries(Object.entries(kinds).slice(0,25));
  for(const unscored of [[],['row0']]) {
    const ref=f.labels('ref',reference,{unscored}), j=JSON.parse(ok(f.lesson('classify','--score',a,b,'--reference',ref,'--json')).stdout);
    assert.equal(j.compared,40); assert.equal(j.disagreements,6); assert.equal(j.mark.disagreements,6); assert.equal(j.A.verdict,'PASS'); assert.equal(j.B.verdict,'PASS');
  }
  for(const omitted of [6,7]) {
  const incomplete={...kinds}; for(let i=40-omitted;i<40;i++) delete incomplete['row'+i];
  const short=f.labels('short',incomplete), ref=f.labels('ref',reference);
  for(const [left,right,side] of [[a,short,'A'],[short,a,'B']]) {
    const j=JSON.parse(ok(f.lesson('classify','--score',left,right,'--reference',ref,'--json')).stdout);
    assert.equal(j.compared,40); assert.equal(j.disagreements,omitted); assert.equal(j.A.verdict,'FAIL'); assert.equal(j.B.verdict,'FAIL');
    assert.ok(ok(f.lesson('classify','--score',left,right)).stdout.split('\n').includes(`only in ${side}: ${Array.from({length:omitted},(_,i)=>'row'+(40-omitted+i)).join(', ')}`));
  }
  }
});
test('328 fix overall-only failure and empty comparison rate', t => {
  const f=setup(t), kinds=Object.fromEntries(Array.from({length:25},(_,i)=>['r'+i,i<15?'mistake':'practice'])), wrong={...kinds};
  for(let i=0;i<5;i++) wrong['r'+i]='observation';
  const a=f.labels('a',wrong), ref=f.labels('ref',kinds);
  const j=JSON.parse(ok(f.lesson('classify','--score',a,a,'--reference',ref,'--json')).stdout);
  assert.equal(j.A.correct,20); assert.equal(j.A.practiceObservation.correct,10); assert.equal(j.A.verdict,'FAIL');
  const empty=f.labels('empty',{}), r=JSON.parse(ok(f.lesson('classify','--score',empty,empty,'--reference',ref,'--json')).stdout);
  assert.equal(r.rate,0); assert.equal(r.A.verdict,'FAIL');
  assert.ok(ok(f.lesson('classify','--score',empty,empty)).stdout.startsWith('score: 0 rows compared; 0 A-B disagreements (0.00%)\n'));
});
test('328 fix no reference practice or observation cannot pass', t => {
  const f=setup(t), a=f.labels('a',{a:'mistake',b:'practice'});
  for(const ref of [f.labels('only',{a:'mistake'}),f.labels('skip',{a:'mistake',b:'practice'},{unscored:['b']})]) {
    const j=JSON.parse(ok(f.lesson('classify','--score',a,a,'--reference',ref,'--json')).stdout);
    assert.equal(j.A.verdict,'FAIL'); assert.equal(j.B.verdict,'FAIL');
    assert.equal(j.referenceWarning,'reference has no practice or observation rows');
    assert.ok(ok(f.lesson('classify','--score',a,a,'--reference',ref)).stdout.split('\n').includes('reference has no practice or observation rows'));
  }
});
test('328 fix real citation shape and role-row diagnostics', t => {
  const f=setup(t), name='lesson-001-example.md';
  // Same version/labeller/kinds/cases/confidence shape as the blind evidence; public-safe row.
  const a=f.labels('a',{[name]:'mistake'},{labeller:'first',cases:{[name]:'K0-2'},confidence:{[name]:0.7}});
  ok(f.lesson('classify','--score',a,a,'--reference',a));
  for(const [spec,row,message] of [
    [{kinds:{'':'mistake'}},'', 'labels kinds must be mistake, practice or observation'],
    [{unscored:[4]},'unscored[0]','labels unscored must be an array of row names'],
    [{unscored:[' ']},'unscored[0]','labels unscored must be an array of row names'],
    [{cases:{[name]:null}},name,'labels cases must be strings']
  ]) for(const role of ['A','B','reference']) {
    const bad=f.labels('bad', {[name]:'mistake'}, spec);
    const args=role==='A'?[bad,a]:role==='B'?[a,bad]:[a,a,'--reference',bad];
    const r=f.lesson('classify','--score',...args); assert.equal(r.status,1);
    assert.equal(r.stderr,`memory-lesson: labels ${role} row ${JSON.stringify(row)}: ${message}\n`);
  }
  assert.equal(f.lesson('classify','--score',a,a,'--reference',path.join(f.tmp,'missing.json')).stderr,'memory-lesson: labels reference row "<document>": cannot read labels JSON\n');
});
test('328 fix CLI guards and case listing identity', t => {
  const f=setup(t), a=f.labels('a',{});
  for(const flag of ['case','score','reference']) {
    const r=f.lesson('classify','--'+flag,'K4','--'+flag,'K4'); assert.equal(r.status,1); assert.equal(r.stderr,`memory-lesson: --${flag} given twice\n`);
  }
  for(const tail of [['--case','K4'],['--write']]) assert.equal(f.lesson('classify','--score',a,a,...tail).stderr,'memory-lesson: score requires two label files and cannot write or filter cases\n');
  assert.equal(f.lesson('classify','--case','K4','--write').stderr,'memory-lesson: classify --case cannot write\n');
  assert.equal(f.lesson('classify','--case','K99').stderr,'memory-lesson: unknown kind case K99; see LESSON-KINDS.md\n');
  const row=f.row('  kind_case: K4\n'); put(path.join(f.memory,'topic-example.md'),fs.readFileSync(row,'utf8').replaceAll('lesson-001-example','topic-example'));
  assert.equal(ok(f.lesson('classify','--case','K4')).stdout,'lesson-001-example.md\n');
});
test('328 fix casebook headings, reset and supersedes syntax', t => {
  const f=setup(t), book=path.join(f.engine,'LESSON-KINDS.md');
  fs.appendFileSync(book,'\n### K11: Colon\nsupersedes: K4, K5\n### K12 Space\nsupersedes: K6 K7\n### Other\nsupersedes: K2\n### K13\nprose supersedes: K3\n');
  for(const id of ['K11','K12']) ok(f.lesson('new','--kind','practice','--route','first','--case',id,id));
  for(const [id,replacement] of [['K4','K11'],['K5','K11'],['K6','K12'],['K7','K12'],['K2',null],['K3',null],['K0',null]]) {
    f.row(`  kind_case: ${id}\n`); const findings=f.gate().findings.filter(x=>x.check.startsWith('kind.case'));
    if(id==='K0') assert.equal(findings[0]?.message,'unknown kind case K0; see LESSON-KINDS.md');
    else if(replacement) assert.equal(findings[0]?.message,`kind case ${id} is superseded by ${replacement}; relabel with classify --write`);
    else assert.deepEqual(findings,[]);
  }
});
test('328 fix shipped casebook and kit layout', () => {
  const text=fs.readFileSync(path.join(root,'docs/LESSON-KINDS.md'),'utf8'), book=lessonCases();
  assert.equal(book.missing,false); assert.equal(book.ids.has('K0'),false); assert.ok(Buffer.byteLength(text)<4096);
  for(let i=1;i<=10;i++) {
    assert.ok(book.ids.has('K'+i)); const section=text.split('### K'+i+'\n')[1]?.split('\n### ')[0];
    for(const field of ['Question','Classification','Example','Status']) assert.match(section??'',new RegExp('^'+field+':','m'));
  }
  assert.match(text,/Mistake: something went wrong/); assert.match(text,/Practice: something worked and should be done again/);
  const labelling=fs.readFileSync(path.join(root,'docs/LABELLING.md'),'utf8');
  assert.match(labelling,/Label every row; doubt goes in `confidence`/);
  assert.match(labelling,/`kind:` and `kind_case:` removed; K0 step 1\ndoes not apply in a blind run/);
  assert.ok(labelling.includes('an optional historical `--reference` file, such as a hold-out key, may list'));
  assert.ok(labelling.includes('`unscored` rows; labellers still label every row'));
  assert.match(fs.readFileSync(path.join(root,'docs/UPGRADE.md'),'utf8'),/## 3\.2\.8\n\nUpgrade from 3\.2\.7:/);
  assert.match(fs.readFileSync(path.join(root,'templates/lesson-batch.md'),'utf8'),/Optional keys include `case: K4`/);
  const command=fs.readFileSync(path.join(root,'engine/README.md'),'utf8').split('\n').find(x=>x.startsWith('| `memory-lesson.mjs classify`'));
  assert.match(command,/--case Kn/); assert.match(command,/--score A\.json B\.json/);
  assert.match(text,/### Kn/); assert.match(text.replace(/\s+/g,' '),/a wrong thing pushed, merged, deployed or published/);
  for(const id of Array.from({length:10},(_,i)=>i+1)) assert.match(text.split('### K'+id+'\n')[1].split('\n### ')[0],/Status: current/);
});
test('328 fix group defaults match shipped caps', () => {
  const source=fs.readFileSync(path.join(root,'engine/memory-check.mjs'),'utf8');
  const literal=/const groupDefaults = (\{[\s\S]*?\n  \});/.exec(source)[1];
  const defaults=Function('return ('+literal+')')(), caps=JSON.parse(fs.readFileSync(path.join(root,'engine/memory.config.json'))).caps;
  assert.deepEqual(defaults,Object.fromEntries(Object.entries(caps).filter(([,v])=>v && typeof v==='object' && !Array.isArray(v))));
});


test('328 takeaway new values, omission and CLI guards', t => {
  const f=setup(t);
  for(const value of ['fix','method','know']) {
    const r=ok(f.lesson('new','--kind','practice','--route','first','--takeaway',value,value));
    assert.equal(metadata(r.stdout.trim()).takeaway,value);
  }
  assert.equal(metadata(ok(f.lesson('new','--kind','practice','--route','first','Omitted')).stdout.trim()).takeaway,undefined);
  for(const [tail,message] of [
    [['--takeaway','bad'],'takeaway must be fix, method or know'],
    [['--takeaway','fix','--takeaway','know'],'--takeaway given twice'],
    [['--takeaway'],'Missing --takeaway value'],
    [['--takeaway=fix'],'--takeaway=fix is not supported; use --takeaway fix']
  ]) {
    const r=f.lesson('new','--kind','practice','--route','first','Guard',...tail);
    assert.equal(r.status,1); assert.equal(r.stderr,'memory-lesson: '+message+'\n');
  }
  assert.equal(fs.readdirSync(f.memory).filter(x=>x.startsWith('lesson-')).length,4);
});

test('328 takeaway batch dry run, write, validation and atomicity', t => {
  const f=setup(t), batch=value=>put(path.join(f.tmp,'batch.md'),'## Capture\nkind: practice\nroute: first\ndescription: Catch errors before use.\ntakeaway: '+value+'\n\nApply the check.\n');
  for(const value of ['fix','method','know']) {
    ok(f.lesson('batch',batch(value),'--dry-run'));
    ok(f.lesson('batch',batch(value)));
  }
  for(const file of fs.readdirSync(f.memory).filter(x=>x.startsWith('lesson-'))) assert.ok(['fix','method','know'].includes(metadata(path.join(f.memory,file)).takeaway));
  for(const value of ['bad','null','false','[]','']) {
    const r=f.lesson('batch',batch(value)); assert.equal(r.status,1);
    assert.equal(r.stderr,'memory-lesson: batch line 1: takeaway must be fix, method or know\n');
  }
  assert.equal(fs.readdirSync(f.memory).filter(x=>x.startsWith('lesson-')).length,3);
});

test('328 takeaway classify preview, write, preserve and validate maps', t => {
  const f=setup(t), row=f.row(), name=path.basename(row), kinds={[name]:'mistake'};
  for(const value of ['fix','method','know']) {
    const file=f.labels('labels',kinds,{takeaways:{[name]:value}}), before=fs.readFileSync(row,'utf8');
    assert.equal(ok(f.lesson('classify',file)).stdout.split('\n')[0],'classify: 1 lessons (mistake 1, practice 0, observation 0); 0 unchanged; takeaways 1');
    assert.equal(fs.readFileSync(row,'utf8'),before);
    ok(f.lesson('classify',file,'--write')); assert.equal(metadata(row).takeaway,value);
    assert.equal(ok(f.lesson('classify',file)).stdout.split('\n')[0],'classify: 1 lessons (mistake 1, practice 0, observation 0); 1 unchanged; takeaways 0');
  }
  f.row('  takeaway: method\n');
  ok(f.lesson('classify',f.labels('omit',kinds),'--write')); assert.equal(metadata(row).takeaway,'method');
  for(const [takeaways,key,message] of [
    [[], '<document>', 'labels takeaways must be a map'],
    [null, '<document>', 'labels takeaways must be a map'],
    [{other:'fix'}, 'other', 'labels takeaways row has no kind: other'],
    ...['bad',null,false,[],{}].map(v=>[{[name]:v},name,'labels takeaways must be fix, method or know'])
  ]) {
    const r=f.lesson('classify',f.labels('bad',kinds,{takeaways}),'--write'); assert.equal(r.status,1);
    assert.equal(r.stderr,'memory-lesson: labels classify row '+JSON.stringify(key)+': '+message+'\n');
    assert.equal(metadata(row).takeaway,'method');
  }
});

test('328 takeaway gate warns only on present invalid values', t => {
  const f=setup(t);
  for(const value of [undefined,'fix','method','know','bad','null','false','[]','']) {
    f.row(value===undefined?'':'  takeaway: '+value+'\n');
    ok(f.cli('memory-index',['--write']));
    const findings=f.gate().findings.filter(x=>x.check==='lesson.takeaway');
    if(value===undefined || ['fix','method','know'].includes(value)) assert.deepEqual(findings,[]);
    else {
      const message = `takeaway ${JSON.stringify(metadata(path.join(f.memory,'lesson-001-example.md')).takeaway)} must be fix, method or know`;
      assert.deepEqual(findings.map(x=>[x.severity,x.message]),[['WARN',message]]);
      const r=ok(f.cli('memory-check',['--no-git']));
      assert.ok(r.stdout.split('\n').includes('WARN lesson.takeaway lesson-001-example.md '+message));
    }
  }
});

test('328 takeaway recall filter, search document, output and guards', t => {
  const f=setup(t);
  for(const [i,value] of ['fix','method','know',undefined].entries()) {
    const row=f.row(value===undefined?'':'  takeaway: '+value+'\n');
    fs.renameSync(row,path.join(f.memory,'lesson-00'+(i+2)+'-example.md'));
  }
  for(const value of ['fix','method','know']) {
    const args=['example','--memory-only','--takeaway',value];
    const results=JSON.parse(ok(f.cli('memory-recall',[...args,'--json'])).stdout);
    assert.equal(results.length,1); assert.equal(results[0].takeaway,value);
    assert.ok(ok(f.cli('memory-recall',args)).stdout.includes('takeaway: '+value));
    assert.equal(JSON.parse(ok(f.cli('memory-recall',[value,'--memory-only','--json'])).stdout).length,1);
    assert.deepEqual(JSON.parse(ok(f.cli('memory-recall',[...args,'--kind','practice','--json'])).stdout),[]);
  }
  assert.equal(JSON.parse(ok(f.cli('memory-recall',['example','--memory-only','--json'])).stdout).length,4);
  assert.equal(f.cli('memory-recall',['example','--takeaway','bad']).stderr,'memory-recall: takeaway must be fix, method or know\n');
  assert.equal(f.cli('memory-recall',['example','--takeaway','fix','--takeaway','know']).stderr,'memory-recall: --takeaway given twice\n');
  assert.equal(ok(f.cli('memory-recall',['--help'])).stdout,'Usage: memory-recall.mjs "query" [--k 5] [--json] [--kind mistake|practice|observation] [--takeaway fix|method|know] [--memory-only|--brain-only] [--probe [FILE]] [--memory-dir PATH] [--repo PATH]\n');
});

test('328 takeaway docs keep person-set and model fields separate', () => {
  for(const file of ['docs/LESSON-KINDS.md','docs/LABELLING.md','docs/GLOSSARY.md','skills/memory-ladder/SKILL.md','skills/memory-review/SKILL.md','templates/lesson.md','templates/lesson-batch.md','CHANGELOG.md']) {
    const text=fs.readFileSync(path.join(root,file),'utf8'); assert.match(text,/takeaway/);
  }
  assert.match(fs.readFileSync(path.join(root,'docs/LESSON-KINDS.md'),'utf8'),/Models label `kind`; people set optional `metadata.takeaway`/);
  assert.match(fs.readFileSync(path.join(root,'docs/LABELLING.md'),'utf8'),/at most 6 of 40 disagreements/);
  assert.match(fs.readFileSync(path.join(root,'scripts/upgrade.mjs'),'utf8'),/export const NEW_CHECKS = \[\];/);
});


test('328 kind verdict at boundary, excess, missing rows and empty input', t => {
  const f=setup(t), kinds=Object.fromEntries(Array.from({length:40},(_,i)=>['r'+i,'mistake'])), a=f.labels('a',kinds);
  for(const [n,missing,pass] of [[6,false,true],[7,false,false],[1,true,false]]) {
    const other={...kinds}; for(let i=0;i<n;i++) { if(missing) delete other['r'+i]; else other['r'+i]='practice'; }
    const b=f.labels('b',other);
    for(const [left,right] of [[a,b],[b,a]]) for(const reference of [[],['--reference',a]]) {
      const args=['classify','--score',left,right,...reference], report=ok(f.lesson(...args));
      assert.ok(report.stdout.split('\n').includes('disagreements <= 6/40'));
      assert.ok(report.stdout.split('\n').includes('kind test: '+(pass?'PASS':'FAIL')));
      assert.deepEqual(JSON.parse(ok(f.lesson(...args,'--json')).stdout).kindTest,{allowed:6,disagreements:n,pass});
    }
  }
  const empty=f.labels('empty',{});
  assert.ok(ok(f.lesson('classify','--score',empty,empty)).stdout.endsWith('disagreements <= 0/0\nkind test: FAIL\n'));
  assert.deepEqual(JSON.parse(ok(f.lesson('classify','--score',empty,empty,'--json')).stdout).kindTest,{allowed:0,disagreements:0,pass:false});
});

test('328 partial map and kind changes preserve unlisted takeaways and count changes', t => {
  const f=setup(t), row=f.row('  takeaway: method\n'), name=path.basename(row), other=path.join(f.memory,'lesson-002-example.md');
  put(other,fs.readFileSync(row,'utf8').replaceAll('001','002').replace('takeaway: method','takeaway: fix'));
  const labels=f.labels('partial',{[name]:'practice',[path.basename(other)]:'practice'},{takeaways:{[path.basename(other)]:'know'}});
  const expected='classify: 2 lessons (mistake 0, practice 2, observation 0); 0 unchanged; takeaways 1';
  assert.equal(ok(f.lesson('classify',labels)).stdout.split('\n')[0],expected);
  assert.equal(metadata(other).takeaway,'fix');
  assert.equal(ok(f.lesson('classify',labels,'--write')).stdout.split('\n')[0],expected);
  assert.equal(metadata(row).takeaway,'method'); assert.equal(metadata(other).takeaway,'know');
  ok(f.lesson('classify',f.labels('kind-only',{[name]:'observation'}),'--write'));
  assert.equal(metadata(row).kind,'observation'); assert.equal(metadata(row).takeaway,'method');
});

test('328 top-level takeaway reads and write refusals', t => {
  const f=setup(t), row=f.row(); put(row,fs.readFileSync(row,'utf8').replace('metadata:','takeaway: method\nmetadata:'));
  assert.deepEqual(f.gate().findings.filter(x=>x.check==='lesson.takeaway'),[]);
  assert.ok(ok(f.cli('memory-recall',['example','--memory-only'])).stdout.split('\n').includes('   takeaway: method'));
  const before=fs.readFileSync(row,'utf8'), labels=f.labels('labels',{[path.basename(row)]:'practice'},{takeaways:{[path.basename(row)]:'fix'}});
  const r=f.lesson('classify',labels,'--write'); assert.equal(r.status,1);
  assert.equal(r.stderr,'memory-lesson: lesson-001-example.md: top-level takeaway is not supported; move it into block metadata first\n');
  assert.equal(fs.readFileSync(row,'utf8'),before);
  put(row,before.replace('takeaway: method','takeaway: bad'));
  assert.deepEqual(f.gate().findings.filter(x=>x.check==='lesson.takeaway').map(x=>[x.severity,x.message]),[['WARN','takeaway \"bad\" must be fix, method or know']]);
  put(row,before);
  const template=path.join(f.engine,'templates/lesson.md'); put(template,fs.readFileSync(template,'utf8').replace('metadata:','takeaway: method\nmetadata:'));
  const created=f.lesson('new','--kind','practice','--route','first','--takeaway','fix','Refused');
  assert.equal(created.status,1); assert.equal(created.stderr,'memory-lesson: top-level takeaway is not supported; move it into block metadata first\n');
});

test('328 recall suppresses invalid values and gate escapes diagnostic', t => {
  const f=setup(t);
  for(const value of ['bad',['fix'],'\u001b[31mred','line\nnext']) {
    f.row('  takeaway: '+JSON.stringify(value)+'\n');
    const report=ok(f.cli('memory-recall',['example','--memory-only'])); assert.ok(!report.stdout.includes('takeaway:')); assert.ok(!report.stdout.includes('\u001b'));
    const message='takeaway '+JSON.stringify(value)+' must be fix, method or know';
    assert.deepEqual(f.gate().findings.filter(x=>x.check==='lesson.takeaway').map(x=>[x.severity,x.message]),[['WARN',message]]);
    assert.ok(f.cli('memory-check',['--no-git']).stdout.split('\n').includes('WARN lesson.takeaway lesson-001-example.md '+message));
  }
});

test('328 shipped docs reject retired labelling guidance', t => {
  const read=file=>fs.readFileSync(path.join(root,file),'utf8');
  assert.ok(read('engine/README.md').split('\n').find(line=>line.startsWith('Capture:')).includes('[--takeaway fix|method|know]'));
  assert.doesNotMatch(read('CHANGELOG.md'),/<B.json> `|these three lines/);
  assert.ok(read('docs/LABELLING.md').includes('6 of 40 (15%) passes the kind test; above 10%, each disagreement still needs a\ncase id before writing. Target at most 5%.'));
  const f=setup(t), reason='Upgrade from 3.2.7: preview and apply; verify installed LESSON-KINDS.md and settings present, preserve host files, gate, round-trip kind_case via new and classify, and label every row independently and score the pair with classify --score A.json B.json (at most 6 of 40 disagreements, scaled); person-set labels are hand-set takeaways. See LABELLING.md.';
  assert.ok(ok(f.cli('memory-measure',[])).stdout.split('\n').includes('| kit-3-2-8 | '+reason+' | - | NEVER |'));
  for(const file of ['docs/LESSON-KINDS.md','docs/LABELLING.md']) assert.ok(fs.readFileSync(path.join(root,file),'utf8').includes('Models never set ' + String.fromCharCode(96) + 'takeaway' + String.fromCharCode(96) + ' by default.'),file);
});



test('328 casebook sections are byte-identical', () => {
  const section=file=>{
    const text=fs.readFileSync(path.join(root,file),'utf8');
    const match=text.match(/^## Lesson casebook \(3\.2\.8\)[\s\S]*?(?=^## |$(?![\s\S]))/m);
    assert.ok(match,file); return Buffer.from(match[0]);
  };
  const source=section('skills/memory-ladder/SKILL.md');
  for(const file of ['skills/memory-review/SKILL.md','docs/HOW-IT-WORKS.md','engine/README.md']) assert.deepEqual(section(file),source,file);
});

test('328 historical reference verdicts and documentation', t => {
  const f=setup(t), a=f.labels('a',{a:'mistake',b:'practice'});
  for(const [ref,verdict] of [[a,'PASS'],[f.labels('wrong',{a:'observation',b:'practice'}),'FAIL']]) {
    const args=['classify','--score',a,a,'--reference',ref];
    const text=ok(f.lesson(...args)).stdout;
    assert.deepEqual(text.split('\n').filter(line=>/(?<!historical )(?:PASS|FAIL)$/.test(line)),['kind test: PASS']);
    assert.ok(text.includes('historical mark: overall >= '));
    for(const side of ['A','B']) assert.match(text,new RegExp('^'+side+': reference .*; historical '+verdict+'$','m'));
    const json=JSON.parse(ok(f.lesson(...args,'--json')).stdout);
    assert.equal(json.mark.historical,true);
    for(const side of ['A','B']) { assert.equal(json[side].historical,true); assert.equal(json[side].verdict,verdict); }
  }
  for(const file of ['docs/GLOSSARY.md','docs/LABELLING.md']) {
    const text=fs.readFileSync(path.join(root,file),'utf8');
    for(const phrase of ['historical mark:','historical PASS','historical FAIL','historical: true']) assert.ok(text.includes(phrase),file+': '+phrase);
  }
  assert.ok(fs.readFileSync(path.join(root,'CHANGELOG.md'),'utf8').split('## 3.2.7')[0].includes('optional historical `--reference` score reports'));
});
