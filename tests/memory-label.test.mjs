import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {build, check, merge, sheet, clipBody} from '../engine/memory-label.mjs';
import * as settlement from '../engine/memory-label.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const families = ['craft-specs','craft-runs','craft-lanes','craft-tests','craft-measure','craft-verify','craft-delivery','craft-forms','craft-notes','pilot','craft-cloud','craft-tools','craft-retired'];
const routerText = families.map(f => `- OPEN BEFORE working on ${f} \u2192 [INDEX-${f}.md](INDEX-${f}.md)`).join('\n');
const put = (p, value) => { fs.mkdirSync(path.dirname(p), {recursive:true}); fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)); };
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const ids = s => [...s.matchAll(/^### (row-[a-z0-9]+\.md)$/gm)].map(m => m[1]);
const fixtureSampling = {expectedOurs:10, roundKinds:{mistake:1, practice:1, observation:1}, negatives:1, pilot:2, roundBundles:3, sentinels:2};

function fixture(t) {
  // All temporary writes remain inside the lane fence, including the fixture key.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'label-fixture-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const memory = path.join(root,'memory'), reference = path.join(root,'reference');
  const classes = ['candidate-routed','candidate-routed','other-project','other-reference','candidate-unrouted','orphan','chain-head','doc-referenced','other-project','candidate-routed'];
  const files = classes.map((_,i) => i === 0 ? 'feedback-probe.md' : `topic-${i}.md`);
  const referenceFiles = ['lesson-001-alpha.md','lesson-002-beta.md','lesson-003-gamma.md','lesson-004-delta.md','lesson-005-epsilon.md','reference-zeta.md'];
  const all = [...files,...referenceFiles];
  const bodies = files.map((_,i) => `# Safe title ${i}\nRead ${all.join(' and ')}; [[topic-1]].\nQuoted metadata.kind: observation; \`trigger: before acting\`; lesson-001 and feedback-.\n` + (i === 2 ? '\u00e9'.repeat(48).concat('\n').repeat(90) : 'Use a verified target before acting.\n'));
  function note(name, body, kind='mistake') { return `---\nname: ${name}\ndescription: A reusable example\nmetadata:\n  date: 2026-11-01\n  type: feedback\n  route: pilot\n  kind: ${kind}\n  kind_case: K6\n  takeaway: fix\n  pin: false\n  trigger: before acting\n  hook: secret hint\n  parent: secret parent\n---\n${body}`; }
  files.forEach((f,i) => put(path.join(memory,f),note(`Safe ${i}`,bodies[i])));
  referenceFiles.forEach((f,i) => put(path.join(reference,f),note(`Control ${i}`,`Verify the operation ${i} before reuse.\n`, ['mistake','practice','observation','mistake','practice','observation'][i])));
  const rows = files.map((file,i) => ({file,class:classes[i],route:i < 2 ? ['pilot'] : i === 4 || i === 5 ? [] : ['craft-tools'],date:'2026-11-01'}));
  const census = path.join(root,'census.json'); put(census,{rows});
  const options = {census,memory,reference,keyDir:path.join(root,'key'),out:path.join(root,'out'),seed:20261110,routerText};
  return {root,options,all,files,bodies};
}
function bundles(out, who='A') { return fs.readdirSync(path.join(out,'bundles')).filter(f => f.endsWith(`-${who}.md`)).sort(); }
function resultFor(text,key,who) {
  const result = {version:1,bundle:/^Bundle: (\S+)$/m.exec(text)[1],labeller:who,kinds:{},cases:{},confidence:{},lesson:{},trigger:{},disposition:{},reason:{},route:{},extract:{}};
  for (const id of ids(text)) {
    const row = key[id];
    result.kinds[id] = row.holdout_kind ?? 'mistake'; result.cases[id] = 'K6'; result.confidence[id] = .9;
    result.lesson[id] = !row.negative;
    if (row.negative) { result.disposition[id] = 'brain'; result.reason[id] = 'Project state only'; }
    else result.trigger[id] = 'before acting';
    if (row.needs_route) result.route[id] = 'craft-tools';
    if (row.no_rename) result.extract[id] = 'Verify before acting.';
  }
  return result;
}

test('build blinds all fields and filenames; deterministic A/B membership, keys, counts and byte limits', t => {
  const f = fixture(t); build(f.options,fixtureSampling);
  const {out,keyDir} = f.options, key = json(path.join(keyDir,'key.json')), holdout = json(path.join(keyDir,'holdout.json'));
  assert.equal(Object.values(key).filter(r => r.source === 'ours').length,10);
  assert.equal(Object.keys(holdout.kinds).length,5); assert.equal(holdout.unscored.length,1);
  assert.equal(Object.values(key).filter(r => r.sentinel).length,2);
  assert.equal(Object.values(key).filter(r => r.needs_route).length,2);
  assert.equal(Object.values(key).filter(r => r.no_rename).length,2);
  const seen = [];
  for (const name of bundles(out)) {
    const a = fs.readFileSync(path.join(out,'bundles',name),'utf8');
    const b = fs.readFileSync(path.join(out,'bundles',name.replace('-A.','-B.')),'utf8');
    assert.deepEqual(ids(a).sort(),ids(b).sort());
    if (ids(a).length > 1) assert.notDeepEqual(ids(a),ids(b));
    seen.push(...ids(a));
    for (const text of [a,b]) {
      for (const filename of [...f.all,...families.map(f => `INDEX-${f}.md`)]) assert.ok(!text.includes(filename),filename);
      assert.ok(!/\b(?:type|route|kind|kind_case|takeaway|pin|trigger|hook|parent):/.test(text),'No stripped key survives');
      assert.ok(!/feedback-|lesson-\d|\[\[topic-1\]\]/.test(text),'No identifying prefix survives');
      assert.ok(Buffer.byteLength(text) <= 100_000);
      assert.ok(ids(text).filter(id => key[id].source === 'ours').length <= 28);
      assert.ok(text.includes('## K0: decision order'));
      assert.ok(text.includes(fs.readFileSync(path.join(repo,'docs/LESSON-KINDS.md'),'utf8').trim()));
      assert.ok(text.includes('one reusable takeaway'));
      assert.equal(families.filter(f => text.includes(`Family ${f}:`)).length,13);
    }
  }
  assert.equal(new Set(seen).size,16); assert.equal(seen.length,16);
  const report = json(path.join(out,'build-report.json'));
  assert.equal(report.ours,10); assert.equal(report.excluded,0);
  for (const name of f.all) assert.ok(!JSON.stringify(report).includes(name));
  const second = {...f.options,out:path.join(f.root,'out2'),keyDir:path.join(f.root,'key2')}; build(second,fixtureSampling);
  function compare(a,b) { for (const name of fs.readdirSync(a)) { const pa=path.join(a,name),pb=path.join(b,name); if(fs.statSync(pa).isDirectory()) compare(pa,pb); else assert.deepEqual(fs.readFileSync(pa),fs.readFileSync(pb),name); } }
  compare(out,second.out); compare(keyDir,second.keyDir);
});

test('production composition, disjoint sentinels, exclusions and stratification at 419 rows', t => {
  const f=fixture(t), rows=[];
  const counts={'candidate-routed':189,'other-project':180,'other-reference':21,'candidate-unrouted':3,orphan:14,'chain-head':5,'doc-referenced':7};
  let number=0;
  for(const [cls,count] of Object.entries(counts)) for(let i=0;i<count;i++) {
    const file=`invented-${number++}.md`,route=['candidate-unrouted','orphan'].includes(cls)?[]:[families[i%13]];
    rows.push({file,class:cls,route,date:'2026-11-01'});
    const body=`# Invented operation ${number}\n`+('Verify the target, then read back the saved value.\n'.repeat(i%5===0 ? 140:22));
    put(path.join(f.options.memory,file),`---\nname: Operation ${number}\ndescription: An invented procedure\n---\n${body}`);
  }
  for(let i=0;i<169;i++) rows.push({file:`excluded-${i}.md`,class:'system',route:[]});
  put(f.options.census,{rows});
  for(let i=0;i<120;i++) {
    const kind=i<70?'mistake':i<96?'practice':'observation';
    put(path.join(f.options.reference,`lesson-${String(100+i).padStart(3,'0')}-invented.md`),`---\nname: Control ${i}\ndescription: Calibration\nmetadata:\n  kind: ${kind}\n---\nCheck invented control ${i}.\n`);
  }
  for(let i=0;i<25;i++) put(path.join(f.options.reference,`negative-${i}.md`),`---\nname: State ${i}\ndescription: Invented state\n---\nThe invented project has ${i} queues.\n`);
  const report=build(f.options),key=json(path.join(f.options.keyDir,'key.json'));
  assert.equal(report.ours,419);assert.equal(report.excluded,169);assert.deepEqual(report.classes,counts);
  assert.deepEqual(report.calibration,{lessons:60,kinds:{mistake:36,observation:11,practice:13},negatives:20,ours:10});
  const main=report.bundles.filter(b=>b.id.startsWith('b'));
  assert.equal(main.reduce((sum,b)=>sum+b.ours,0),409);assert.equal(report.sentinels,main.length*2);
  const seen=new Set();
  for(const bundle of report.bundles) {
    const text=fs.readFileSync(path.join(f.options.out,'bundles',`${bundle.id}-A.md`),'utf8');
    const members=ids(text);
    for(const id of members) {assert.ok(!seen.has(id));seen.add(id);}
    assert.ok(bundle.bytes.A<=100000 && bundle.bytes.B<=100000);assert.ok(bundle.ours<=28);
    if(bundle.id.startsWith('b')) {
      assert.equal(members.filter(id=>key[id].sentinel).length,2);
      assert.ok(new Set(members.filter(id=>key[id].source==='ours').map(id=>key[id].class)).size>=2);
      assert.ok(new Set(members.flatMap(id=>key[id].family)).size>=3);
    } else {assert.equal(members.length,30);assert.ok(members.every(id=>!key[id].sentinel));}
  }
  assert.equal(seen.size,419+80+main.length*2);
  assert.throws(()=>build(f.options),/already exists/);
});

test('unusable controls are excluded and insufficient samples fail without output', t => {
  const f=fixture(t), reference=f.options.reference;
  const excluded={
    'MEMORY.md':'router', 'ARCHIVE.md':'history', 'INDEX-craft-tools.md':'index', 'index-notes-x.md':'support',
    'topic-background.md':'detail', 'generated.md':'<!-- generated by memory-index.mjs; edit the lessons, not this file -->\nGenerated',
    'lesson-020-empty.md':'---\nname: Empty\nmetadata:\n  kind: practice\n---\n',
    'lesson-021-copy-2.md':'---\nname: Redirect\nmetadata:\n  kind: practice\n---\nSee [[lesson-002-beta]].',
    'lesson-001-pinned.md':'---\nname: Duplicate\nmetadata:\n  kind: mistake\n  pin: true\n---\nDuplicate pinned identity.\n',
  };
  for(const [name,content] of Object.entries(excluded)) put(path.join(reference,name),content);
  build(f.options,fixtureSampling);
  const key=json(path.join(f.options.keyDir,'key.json'));
  for(const row of Object.values(key)) assert.ok(!Object.hasOwn(excluded,row.file));
  const impossible={...f.options,out:path.join(f.root,'impossible'),keyDir:path.join(f.root,'impossible-key')};
  assert.throws(()=>build(impossible,{...fixtureSampling,negatives:99}),/Insufficient/);
  assert.equal(fs.existsSync(impossible.out),false);assert.equal(fs.existsSync(impossible.keyDir),false);
});

test('body cutoff respects UTF-8 bytes, complete lines, exact omitted count and 5000 threshold', () => {
  const body = '\u00e9'.repeat(48).concat('\n').repeat(90);
  const clipped = clipBody(body), match = /\[(\d+) bytes omitted\]/.exec(clipped);
  assert.ok(match); const [head,tail] = clipped.split(/\n\[\d+ bytes omitted\]\n/);
  assert.ok(Buffer.byteLength(head) <= 4000); assert.ok(Buffer.byteLength(tail) <= 1000);
  assert.ok(body.startsWith(head)); assert.ok(body.endsWith(tail));
  assert.equal(Number(match[1]),Buffer.byteLength(body)-Buffer.byteLength(head)-Buffer.byteLength(tail));
  assert.doesNotMatch(clipped,/\uFFFD/); assert.equal(clipBody('a'.repeat(5000)),'a'.repeat(5000));
  assert.equal(clipBody('a'.repeat(5001)),'\n[5001 bytes omitted]\n');
});

test('check accepts schema and rejects every missing, extra, enum, type and conditional fault', t => {
  const f=fixture(t); build(f.options,fixtureSampling); const key=json(path.join(f.options.keyDir,'key.json'));
  const text=fs.readFileSync(path.join(f.options.out,'bundles','b01-A.md'),'utf8'), valid=resultFor(text,key,'A');
  assert.doesNotThrow(() => check(text,valid));
  const id=ids(text).find(id => !key[id].needs_route && !key[id].no_rename);
  const unrouted=ids(text).find(id => key[id].needs_route), fixed=ids(text).find(id => key[id].no_rename);
  const faults = [
    v=>{delete v.kinds[id];}, v=>{delete v.confidence[id];},v=>{delete v.lesson[id];},
    v=>{v.kinds.extra='mistake';},v=>{v.trigger.extra='before acting';},v=>{v.kinds[id]='fix';},
    v=>{v.cases[id]='K99';},v=>{v.confidence[id]=1.1;},v=>{v.lesson[id]='true';},v=>{v.trigger[id]='after acting';},
    v=>{v.disposition[id]='topic';},v=>{v.reason[id]='bad row';},v=>{v.route[id]='craft-tools';},v=>{v.extract[id]='rule';},
    v=>{v.route[unrouted]='bogus';},v=>{delete v.route[unrouted];},v=>{delete v.extract[fixed];},
    v=>{v.extract[fixed]='two\nlines';},v=>{v.pin={};},v=>{v.takeaway={};},v=>{v.version=2;},
    v=>{v.bundle='wrong';},v=>{v.labeller='B';},v=>{v.kinds=[];},
    v=>{v.lesson[id]=false;},v=>{v.lesson[id]=false;delete v.trigger[id];v.disposition[id]='bad';},
    v=>{v.lesson[id]=false;delete v.trigger[id];v.disposition[id]='brain';},
    v=>{v.lesson[id]=false;delete v.trigger[id];v.disposition[id]='brain';v.reason[id]='word '.repeat(21);},
  ];
  for(const [i,mutate] of faults.entries()) {const bad=structuredClone(valid);mutate(bad);assert.throws(()=>check(text,bad),undefined,`fault ${i}`);}
  for(const bad of [null,[],true]) assert.throws(()=>check(text,bad));
  const resultPath=path.join(f.root,'result.json');put(resultPath,valid);
  const cli=spawnSync(process.execPath,[path.join(repo,'engine/memory-label.mjs'),'check','--bundle',path.join(f.options.out,'bundles','b01-A.md'),'--result',resultPath],{encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);
  put(resultPath,{});
  const bad=spawnSync(process.execPath,[path.join(repo,'engine/memory-label.mjs'),'check','--bundle',path.join(f.options.out,'bundles','b01-A.md'),'--result',resultPath],{encoding:'utf8'});
  assert.equal(bad.status,1); assert.ok(bad.stderr.trim());
});

test('merge validates coverage and scoreable holdouts; sheet ignores ancillary differences', t => {
  const f=fixture(t);build(f.options,fixtureSampling);const {out,keyDir}=f.options,key=json(path.join(keyDir,'key.json'));
  assert.throws(()=>merge({out,keyDir}));
  let changed, confidenceOnly;
  for(const who of ['A','B']) for(const filename of bundles(out,who)) {
    const text=fs.readFileSync(path.join(out,'bundles',filename),'utf8'),result=resultFor(text,key,who);
    if(who==='B' && result.bundle==='b01') {
      [changed,confidenceOnly]=ids(text).filter(id=>key[id].source==='ours');
      result.kinds[changed]='practice';result.trigger[changed]='when acting';result.confidence[changed]=.7;result.confidence[confidenceOnly]=.8;
    }
    put(path.join(out,'out',who,`${result.bundle}.json`),result);
  }
  merge({out,keyDir});sheet({out,keyDir});
  const score=spawnSync(process.execPath,[path.join(repo,'engine/memory-lesson.mjs'),'classify','--score',path.join(out,'A.holdout.kinds.json'),path.join(out,'B.holdout.kinds.json'),'--reference',path.join(keyDir,'holdout.json')],{encoding:'utf8',cwd:repo});
  assert.equal(score.status,0,score.stderr+score.stdout);assert.match(score.stdout,/historical.*PASS/);
  const rate=json(path.join(out,'lesson-holdout.json'));
  assert.equal(rate.A.lesson_true_rate,1);assert.equal(rate.B.lesson_false_rate,1);
  assert.deepEqual(Object.keys(json(path.join(out,'A.kinds.json'))),['version','kinds','cases','confidence']);
  const rows=fs.readFileSync(path.join(out,'settlement.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length,10);assert.equal(rows.filter(r=>r.settled_by==='pending').length,1);
  assert.equal(rows.find(r=>r.file===key[confidenceOnly].file).final.confidence,.8);
  const pending=rows.find(r=>r.file===key[changed].file);assert.deepEqual(pending.agreement,{kinds:false});
  assert.ok(fs.readFileSync(path.join(out,'disagreements.md'),'utf8').includes(key[changed].file));
  put(path.join(out,'out','A','extra.json'),{version:1});assert.throws(()=>merge({out,keyDir}));
});

function settlementFixture(t) {
  const f=fixture(t); build(f.options,fixtureSampling);
  const {out,keyDir}=f.options, key=json(path.join(keyDir,'key.json'));
  for(const who of ['A','B']) for(const filename of bundles(out,who)) {
    const text=fs.readFileSync(path.join(out,'bundles',filename),'utf8'),result=resultFor(text,key,who);
    put(path.join(out,'out',who,`${result.bundle}.json`),result);
  }
  merge(f.options); const rows=sheet(f.options);
  const base=rows.find(r=>!key[r.id].needs_route && !key[r.id].no_rename);
  const bundle=bundles(out).map(n=>fs.readFileSync(path.join(out,'bundles',n),'utf8')).find(s=>ids(s).includes(base.id));
  const render=bundle.slice(bundle.indexOf(`### ${base.id}`)).split(/(?=^### row-)/m)[0];
  for(let i=0;i<3;i++) {
    const id=`row-${1001+i}.md`,file=`pending-${i}.md`;
    key[id]={...key[base.id],file};
    put(path.join(f.options.memory,file),fs.readFileSync(path.join(f.options.memory,base.file))); 
    rows.push({...structuredClone(base),id,file,B:{...base.B,kinds:'practice'},agreement:{kinds:false},settled_by:'pending'});
    put(path.join(out,'bundles',`fixture-${i}.md`),bundle.split('## Rows')[0]+'## Rows\n\n'+render.replaceAll(base.id,id));
  }
  put(path.join(keyDir,'key.json'),key);
  const save=()=>put(path.join(out,'settlement.jsonl'),rows.map(JSON.stringify).join('\n')+'\n'); save();
  const readRows=()=>fs.readFileSync(path.join(out,'settlement.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  return {...f,key,rows,save,readRows,pending:rows.slice(-3)};
}

test('settle/emit: disputes split pending rows, preserve blind render and include instructions',t=>{
  const f=settlementFixture(t); settlement.disputes({...f.options,per:2});
  const dir=path.join(f.options.out,'settle'),files=fs.readdirSync(dir).sort();
  assert.deepEqual(files,['s01.md','s02.md']);
  const texts=files.map(n=>fs.readFileSync(path.join(dir,n),'utf8'));
  assert.deepEqual(texts.map(s=>ids(s).length),[2,1]);
  for(const s of texts) {
    for(const row of Object.values(f.key)) assert.ok(!s.includes(row.file),'No filename leak');
    assert.match(s,/## Reading harm/);assert.match(s,/caught and corrected before anyone used it/);
    assert.match(s,/memory-recall.mjs/); assert.match(s,/unclear/); assert.match(s,/Disagree: kinds/);
    assert.match(s,/confidence/); assert.match(s,/one reusable takeaway/);
  }
  settlement.disputes({...f.options,per:25});
  assert.deepEqual(fs.readdirSync(dir),['s01.md'],'No stale dispute shards');
});

test('settle/emit: decisions validate atomically and obey unclear, third and operator precedence',t=>{
  const f=settlementFixture(t),id=f.pending[0].id, final={...f.pending[0].A};
  const decide=(by,note='Evidence checked',values=final)=>{const p=path.join(f.root,'decision.json');put(p,{version:1,rows:{[id]:{final:values,settled_by:by,note}}}); return p;};
  const apply=(...decisions)=>settlement.settle({...f.options,decisions});
  apply(decide('unclear')); assert.equal(f.readRows().find(r=>r.id===id).settled_by,'pending');
  assert.equal(f.readRows().find(r=>r.id===id).note,'Evidence checked');
  apply(decide('case:K6')); assert.equal(f.readRows().find(r=>r.id===id).settled_by,'case:K6');
  apply(decide('test:s3')); assert.equal(f.readRows().find(r=>r.id===id).settled_by,'case:K6');
  apply(decide('operator')); apply(decide('case:K4'));
  assert.equal(f.readRows().find(r=>r.id===id).settled_by,'operator');
  const before=fs.readFileSync(path.join(f.options.out,'settlement.jsonl'),'utf8');
  assert.throws(()=>apply(decide('operator','word '.repeat(26))));
  assert.throws(()=>apply(decide('operator','Invalid',{...final,pin:true})));
  assert.equal(fs.readFileSync(path.join(f.options.out,'settlement.jsonl'),'utf8'),before);
  f.rows[0].settled_by='third';f.save();
  const p=path.join(f.root,'override.json');put(p,{version:1,rows:{[f.rows[0].id]:{final:f.rows[0].A,settled_by:'test:s3',note:'Test applies'}}});
  apply(p);assert.equal(f.readRows()[0].settled_by,'test:s3');
});

test('settle/emit: Third is blind, seeded, scored on 15 controls; majority and ties are logged',t=>{
  const f=settlementFixture(t); settlement.third({...f.options,seed:9});
  const p=path.join(f.options.out,'third','c01.md'),text=fs.readFileSync(p,'utf8');
  assert.equal(ids(text).length,18); assert.equal(new Set(ids(text)).size,18);
  for(const row of Object.values(f.key)) assert.ok(!text.includes(row.file),'No filename leak');
  assert.doesNotMatch(text,/pending|agreed|hold-out/i);
  settlement.third({...f.options,seed:9});assert.equal(fs.readFileSync(p,'utf8'),text);
  const result=resultFor(text,f.key,'C');
  result.kinds[f.pending[0].id]='practice';result.kinds[f.pending[1].id]='observation';
  result.confidence[f.pending[2].id]=.3; // Confidence is reconciled, never voted on.
  check(text,result);
  const decision=path.join(f.root,'third-result.json');put(decision,result);
  settlement.settle({...f.options,decisions:[decision],fromThird:true});
  const rows=f.readRows();
  assert.equal(rows.find(r=>r.id===f.pending[0].id).final.kinds,'practice');
  assert.equal(rows.find(r=>r.id===f.pending[0].id).settled_by,'third');
  assert.equal(rows.find(r=>r.id===f.pending[1].id).settled_by,'pending');
  assert.equal(rows.find(r=>r.id===f.pending[2].id).settled_by,'third');
  assert.equal(rows.find(r=>r.id===f.pending[2].id).final.confidence,.3);
  const log=fs.readFileSync(path.join(f.options.out,'third-log.md'),'utf8');
  assert.equal(log.split('\n').filter(s=>s.startsWith('| row-')).length,18);
  assert.match(log,/15\/15/);
});

test('settle/emit: map exclusions, extract batch dry-run, dispositions, pending evidence and exact UTF-8 projection',t=>{
  const f=settlementFixture(t),{out,memory,census}=f.options;
  for(const r of f.rows) if(r.settled_by==='agree') r.final={...r.A};
  const noRename=f.rows.filter(r=>f.key[r.id].no_rename);
  noRename.forEach((r,i)=>r.final.extract=`Before action ${i}: verify the target.`);
  const unrouted=f.rows.filter(r=>f.key[r.id].needs_route);
  unrouted[0].final.route='archive';unrouted[1].final.route='none';
  const non=f.rows.find(r=>!f.key[r.id].no_rename && !f.key[r.id].needs_route);
  non.final={kinds:'observation',confidence:.9,lesson:false,disposition:'brain',reason:'Project state only'};
  f.pending[0].note='Need evidence of reliance';f.save();
  const censusRows=json(census).rows;
  censusRows.find(r=>r.file===unrouted[0].file).inbound={files:['linking-topic.md']};put(census,{rows:censusRows});
  const headers={},lines={};
  for(const family of ['pilot','craft-tools']) {
    headers[family]=`# ${family}\n\n`;lines[family]=censusRows.filter(r=>r.route.includes(family)).map(r=>[r.file,`- [\u00c9 ${r.file}](${r.file}) \u2014 detail\n`]);
    put(path.join(memory,`INDEX-${family}.md`),headers[family]+lines[family].map(x=>x[1]).join(''));
    put(path.join(memory,`INDEX-${family}-all.md`),'# Catalog\n'+lines[family].map(x=>x[1]).join(''));
  }
  put(path.join(memory,'MEMORY.md'),routerText);
  const counts=settlement.emit(f.options),map=json(path.join(out,'promote-map.json'));
  assert.equal(map.version,1);assert.equal(counts.pending,3);assert.equal(counts.extracts,2);
  for(const r of [...noRename,...unrouted,non,...f.pending]) assert.ok(!Object.hasOwn(map.promote,r.file));
  assert.ok(Object.keys(map.promote).length>0);
  for(const value of Object.values(map.promote)) {assert.ok(!('pin' in value));assert.ok(!('date' in value));assert.ok(!('route' in value));}
  const batch=fs.readFileSync(path.join(out,'extract-batch.md'),'utf8');
  assert.match(batch,/Detail: \[\[topic-6\]\]\./);
  const child=spawnSync(process.execPath,[path.join(repo,'engine/memory-lesson.mjs'),'batch',path.join(out,'extract-batch.md'),'--dry-run','--memory-dir',memory,'--repo',repo],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr+child.stdout);
  const projection=fs.readFileSync(path.join(out,'family-projection.md'),'utf8');
  for(const family of ['pilot','craft-tools']) {
    const expected=Buffer.byteLength(headers[family])+lines[family].filter(([file])=>!(file in map.promote)).reduce((n,[,s])=>n+Buffer.byteLength(s),0);
    assert.ok(projection.includes(`| ${family} | ${expected} |`));
  }
  assert.match(fs.readFileSync(path.join(out,'dispositions.md'),'utf8'),/linking-topic.md/);
  const decisions=fs.readFileSync(path.join(out,'decision-table.md'),'utf8');
  assert.match(decisions,/Need evidence of reliance/);assert.match(decisions,/TODO/);assert.match(decisions,/pending-0.md/);
});

test('settle/emit: CLI repeated decisions, partial finals, counts-only emit and route promotion',t=>{
  const f=settlementFixture(t),{out,keyDir,memory,census}=f.options;
  const p1=path.join(f.root,'one.json'),p2=path.join(f.root,'two.json');
  const id=f.pending[0].id;
  put(p1,{version:1,rows:{[id]:{settled_by:'unclear',note:'Need a precedent'}}});
  put(p2,{version:1,rows:{[id]:{final:{kinds:'practice'},settled_by:'test:s3',note:'Reusable takeaway'}}});
  const cli=(command,args)=>spawnSync(process.execPath,[path.join(repo,'engine/memory-label.mjs'),command,'--key-dir',keyDir,'--out',out,...args],{encoding:'utf8'});
  const applied=cli('settle',['--decisions',p1,p2]);assert.equal(applied.status,0,applied.stderr);
  assert.equal(f.readRows().find(r=>r.id===id).final.kinds,'practice');
  const repeated=cli('settle',['--decisions',p1,'--decisions',p2]);assert.equal(repeated.status,0,repeated.stderr);
  assert.equal(cli('disputes',['--per','0']).status,1);
  assert.equal(cli('third',['--seed','4']).status,0);
  const text=fs.readFileSync(path.join(out,'third','c01.md'),'utf8'),result=resultFor(text,f.key,'C');
  const c=path.join(f.root,'c.json');put(c,result);
  const settled=cli('settle',['--from-third','--decisions',c]);assert.equal(settled.status,0,settled.stderr);
  const source=json(census).rows;
  for(const family of ['pilot','craft-tools']) {
    const lines=source.filter(r=>r.route.includes(family)).map(r=>`- [${r.file}](${r.file})\n`).join('');
    put(path.join(memory,`INDEX-${family}.md`),'# Hot\n'+lines);
    put(path.join(memory,`INDEX-${family}-all.md`),'# Catalog\n'+lines);
  }
  const output=cli('emit',['--census',census,'--memory',memory]);assert.equal(output.status,0,output.stderr);
  const counts=JSON.parse(output.stdout);assert.equal(counts.rows,13);
  assert.doesNotMatch(output.stdout,/pending-0|Verify before|topic-6/);
  const map=json(path.join(out,'promote-map.json'));
  for(const row of f.rows.filter(r=>f.key[r.id].needs_route)) assert.deepEqual(map.promote[row.file].route,['craft-tools']);
  const before=fs.readFileSync(path.join(out,'family-projection.md'),'utf8');
  put(path.join(memory,'INDEX-craft-tools-all.md'),'# Empty\n');
  assert.equal(cli('emit',['--census',census,'--memory',memory]).status,1);
  assert.equal(fs.readFileSync(path.join(out,'family-projection.md'),'utf8'),before);
});

test('settle/emit: projection includes split catalogs and over-budget warning',t=>{
  const f=settlementFixture(t),{memory,census,out}=f.options;
  const source=json(census).rows;
  for(const row of f.rows) if(row.settled_by==='agree') {
    row.A={kinds:'observation',confidence:.9,lesson:false,disposition:'topic',...(f.key[row.id].needs_route?{route:'craft-tools'}:{}),...(f.key[row.id].no_rename?{extract:''}:{})};
    row.B={...row.A};
    row.final={...row.A};
  }
  f.save();
  for(const family of ['pilot','craft-tools']) {
    const header=family==='craft-tools'?'# '+ 'x'.repeat(8192)+'\n':'# Empty header\n';
    put(path.join(memory,`INDEX-${family}.md`),header);
    const members=source.filter(r=>r.route.includes(family));
    put(path.join(memory,`INDEX-${family}-all.md`),'# Catalog\n');
    put(path.join(memory,`INDEX-${family}-all-2.md`),members.map(r=>`- [x](${r.file})\n`).join(''));
  }
  settlement.emit(f.options);
  assert.match(fs.readFileSync(path.join(out,'family-projection.md'),'utf8'),/OVER.*operator-approved split/);
  assert.match(fs.readFileSync(path.join(out,'dispositions.md'),'utf8'),/census inbound/);
});

test('sheet review: only five semantic dispute rules; agreed finals reconcile ancillary fields',t=>{
  const f=fixture(t),{out,keyDir}=f.options;
  const base={lesson:true,kinds:'mistake',confidence:.8,cases:'K3',trigger:'before acting'};
  const non={lesson:false,kinds:'observation',confidence:.8,disposition:'topic',reason:'A reason'};
  const cases=[
    ['lesson',base,{...non}, {},['lesson']],
    ['kind',base,{...base,kinds:'practice'}, {},['kinds']],
    ['disposition',non,{...non,disposition:'brain'}, {},['disposition']],
    ['route',{...base,route:'craft-tools'},{...base,route:'craft-notes'},{needs_route:true},['route']],
    ['extract',{...base,extract:'Verify first.'},{...base,extract:''},{no_rename:true},['extract']],
    ['confidence',base,{...base,confidence:.6},{},[]],
    ['reason',non,{...non,reason:'B reason'},{},[]],
    ['trigger',base,{...base,trigger:'before doing anything'},{},[]],
    ['case',base,{...base,cases:'K4',confidence:.9},{},[]],
    ['case-tie',base,{...base,cases:'K4'},{},[]],
    ['case-a',{...base,confidence:.9},{...base,cases:'K4'},{},[]],
    ['case-missing',base,{lesson:true,kinds:'mistake',confidence:.9},{},[]],
    ['trigger-missing',base,{lesson:true,kinds:'mistake',confidence:.8,cases:'K3'},{},[]],
    ['non-kind',non,{...non,kinds:'practice',disposition:undefined},{},[]],
    ['extract-short',{...base,extract:'Verify first.'},{...base,extract:'Verify the target first.'},{no_rename:true},[]],
    ['extract-none',{...base,extract:''},{...base,extract:'   '},{no_rename:true},[]],
    ['multiple',{...base,route:'craft-tools',extract:'Verify.'},{...non,route:'none',extract:''},{needs_route:true,no_rename:true},['lesson','route','extract']],
  ];
  const key={},A={version:1},B={version:1};
  for(const field of ['kinds','cases','confidence','lesson','trigger','disposition','reason','route','extract']) {A[field]={};B[field]={};}
  cases.forEach(([name,a,b,flags],i)=>{
    const id=`row-${i}.md`;key[id]={source:'ours',file:`${name}.md`,needs_route:false,no_rename:false,...flags};
    for(const [values,target] of [[a,A],[b,B]]) for(const [field,value] of Object.entries(values)) if(value!==undefined) target[field][id]=value;
  });
  put(path.join(keyDir,'key.json'),key);put(path.join(out,'A.json'),A);put(path.join(out,'B.json'),B);
  const rows=sheet(f.options),byName=Object.fromEntries(rows.map(r=>[r.file.replace('.md',''),r]));
  for(const [name,,, ,fields] of cases) {
    const r=byName[name];assert.equal(r.settled_by,fields.length?'pending':'agree',name);
    assert.deepEqual(r.agreement,Object.fromEntries(fields.map(field=>[field,false])),name);
    assert.equal(Object.hasOwn(r,'final'),!fields.length,name);
  }
  assert.equal(byName.confidence.final.confidence,.6);
  assert.equal(byName.reason.final.reason,'A reason');
  assert.equal(byName.trigger.final.trigger,'before acting');
  assert.equal(byName.case.final.cases,'K4');assert.equal(byName['case-a'].final.cases,'K3');
  assert.equal(byName['case-tie'].final.cases,undefined);assert.equal(byName['case-missing'].final.cases,undefined);
  assert.equal(byName['trigger-missing'].final.trigger,undefined);
  assert.equal(byName['non-kind'].final.disposition,'topic');assert.equal(byName['non-kind'].final.lesson,false);
  assert.equal(byName['extract-short'].final.extract,'Verify first.');assert.equal(byName['extract-none'].final.extract,'');
  const report=fs.readFileSync(path.join(out,'disagreements.md'),'utf8');
  for(const name of ['confidence','reason','trigger','case']) assert.ok(!report.includes(`## ${name}\n`));
  assert.equal(rows.filter(r=>r.settled_by==='pending').length,6);
});

const yes=(kind='mistake',extra={})=>({lesson:true,kinds:kind,confidence:.8,cases:'K3',trigger:'before checking the target',...extra});
const no=(disposition='topic',extra={})=>({lesson:false,kinds:'observation',confidence:.7,disposition,...(disposition==='topic'?{}:{reason:'Project state only'}),...extra});
const thirdRules=[
  {name:'lesson majority true requires matching kinds among true voters',A:no(),B:yes('practice'),C:yes('practice',{confidence:.6}),fields:['lesson'],want:{lesson:true,kinds:'practice',confidence:.6}},
  {name:'lesson majority false uses non-lesson pair disposition',A:yes(),B:no('brain'),C:no('brain',{confidence:.4,reason:'Different explanation'}),fields:['lesson'],want:{lesson:false,disposition:'brain',confidence:.4}},
  {name:'kind ignores the provisional kind of a non-lesson voter',A:no('topic',{kinds:'mistake'}),B:yes('mistake'),C:yes('practice'),fields:['lesson'],missing:'kinds'},
  {name:'kind majority uses the agreeing lesson pair cases',A:yes('mistake',{confidence:.95,cases:'K3'}),B:yes('practice',{confidence:.7,cases:'K4'}),C:yes('practice',{confidence:.9,cases:'K6',trigger:'before acting'}),fields:['kinds'],want:{kinds:'practice',cases:'K6',trigger:'before acting',confidence:.7}},
  {name:'three lesson kinds stay pending',A:yes('mistake'),B:yes('practice'),C:yes('observation'),fields:['kinds'],missing:'kinds'},
  {name:'disposition agrees with C despite different reason and confidence',A:no('brain',{reason:'A reason'}),B:no('archive',{confidence:.6}),C:no('archive',{confidence:.9,reason:'C reason'}),fields:['disposition'],want:{disposition:'archive',reason:'A reason',confidence:.6}},
  {name:'third disposition stays pending',A:no('brain'),B:no('archive'),C:no('other'),fields:['disposition'],missing:'disposition'},
  {name:'absent disposition means topic',A:no(),B:no('brain'),C:no(),fields:['disposition'],want:{disposition:'topic'},omitADisposition:true},
  {name:'route uses two votes and preserves undisputed lesson kind',A:yes('mistake',{route:'craft-tools'}),B:yes('mistake',{route:'craft-notes'}),C:yes('practice',{route:'craft-notes',confidence:.3}),fields:['route'],flags:{needs_route:true},want:{route:'craft-notes',kinds:'mistake',confidence:.3}},
  {name:'third route stays pending',A:yes('mistake',{route:'craft-tools'}),B:yes('mistake',{route:'craft-notes'}),C:yes('mistake',{route:'none'}),fields:['route'],flags:{needs_route:true},missing:'route'},
  {name:'ancillary fields differ without blocking; two true voters supply trigger',A:yes('mistake',{confidence:.9}),B:yes('practice',{confidence:.8,trigger:undefined}),C:yes('practice',{confidence:.5,trigger:'when acting'}),fields:['kinds'],want:{confidence:.5,trigger:'when acting'}},
  {name:'one trigger is omitted and tied case disagreement is omitted',A:yes('mistake',{trigger:undefined}),B:yes('practice',{cases:'K4',trigger:undefined}),C:yes('practice',{cases:'K6'}),fields:['kinds'],absent:['trigger','cases'],want:{kinds:'practice'}},
  {name:'extract votes on presence then takes shorter text',A:yes('mistake',{extract:''}),B:yes('mistake',{extract:'Verify the target before acting.'}),C:yes('mistake',{extract:'Verify first.'}),fields:['extract'],flags:{no_rename:true},want:{extract:'Verify first.'}},
  {name:'extract majority empty stays empty',A:yes('mistake',{extract:'Verify.'}),B:yes('mistake',{extract:''}),C:yes('mistake',{extract:''}),fields:['extract'],flags:{no_rename:true},want:{extract:''}},
];
for(const spec of thirdRules) test('Third review: '+spec.name,t=>{
  const f=settlementFixture(t),row=f.pending[0],id=row.id;
  row.A={...spec.A};row.B={...spec.B};delete row.final;
  if(spec.omitADisposition) delete row.A.disposition;
  row.agreement=Object.fromEntries(spec.fields.map(field=>[field,false]));
  Object.assign(f.key[id],spec.flags);put(path.join(f.options.keyDir,'key.json'),f.key);
  const file=path.join(f.options.out,'bundles','fixture-0.md');
  const flags=[f.key[id].needs_route?'needs_route':'',f.key[id].no_rename?'no_rename':''].filter(Boolean).join(' ')||'none';
  put(file,fs.readFileSync(file,'utf8').replace(/^Flags: .*$/m,`Flags: ${flags}`));f.save();
  settlement.third(f.options);
  const text=fs.readFileSync(path.join(f.options.out,'third','c01.md'),'utf8'),result=resultFor(text,f.key,'C');
  for(const field of Object.keys(result)) if(result[field] && typeof result[field]==='object') delete result[field][id];
  for(const [field,value] of Object.entries(spec.C)) if(value!==undefined) result[field][id]=value;
  const p=path.join(f.root,'c-review.json');put(p,result);
  settlement.settle({...f.options,decisions:[p],fromThird:true});
  const actual=f.readRows().find(r=>r.id===id);
  if(spec.missing) {assert.equal(actual.settled_by,'pending');assert.equal(actual.note,`Missing majority: ${spec.missing}`);assert.equal(actual.final,undefined);}
  else {assert.equal(actual.settled_by,'third');for(const [field,value] of Object.entries(spec.want)) assert.equal(actual.final[field],value,field);for(const field of spec.absent??[]) assert.equal(actual.final[field],undefined,field);}
});

test('emit review: unrouted extraction heads use settled family or become operator decisions',t=>{
  const f=settlementFixture(t),{out,keyDir,memory,census}=f.options;
  const heads=f.rows.filter(r=>f.key[r.id].no_rename);
  for(const row of heads) {
    f.key[row.id].family=[];f.key[row.id].needs_route=true;
    row.final={...row.A,route:row===heads[0]?'craft-tools':'none',extract:row===heads[0]?'Verify the selected family.':'Check before extraction.'};
  }
  put(path.join(keyDir,'key.json'),f.key);f.save();
  // Keep the saved blind flags consistent with the fixture key.
  for(const name of fs.readdirSync(path.join(out,'bundles'))) {
    const p=path.join(out,'bundles',name);let text=fs.readFileSync(p,'utf8');
    for(const row of heads) text=text.replace(`### ${row.id}\nFlags: no_rename`,`### ${row.id}\nFlags: needs_route no_rename`);
    put(p,text);
  }
  const source=json(census).rows;
  for(const family of ['pilot','craft-tools']) {
    const lines=source.filter(r=>r.route.includes(family)).map(r=>`- [x](${r.file})\n`).join('');
    put(path.join(memory,`INDEX-${family}.md`),'# Hot\n'+lines);
    put(path.join(memory,`INDEX-${family}-all.md`),'# Catalog\n'+lines);
  }
  settlement.emit(f.options);
  let batch=fs.readFileSync(path.join(out,'extract-batch.md'),'utf8');
  assert.match(batch,/## Verify the selected family\.\nkind: mistake\nroute: craft-tools/);
  assert.ok(!batch.includes('Check before extraction.'));
  let decisions=fs.readFileSync(path.join(out,'decision-table.md'),'utf8');
  assert.ok(decisions.includes(heads[1].file));assert.match(decisions,/extracted lesson needs a family/);
  assert.match(decisions,/Check before extraction\./);
  // Archive is a disposition, not an extraction family; missing settled route is
  // also reviewable when the head was not marked needs_route.
  heads[0].final.route='archive';
  delete heads[1].final.route;f.key[heads[1].id].needs_route=false;
  for(const name of fs.readdirSync(path.join(out,'bundles'))) {
    const p=path.join(out,'bundles',name);put(p,fs.readFileSync(p,'utf8').replace(`### ${heads[1].id}\nFlags: needs_route no_rename`,`### ${heads[1].id}\nFlags: no_rename`));
  }
  put(path.join(keyDir,'key.json'),f.key);f.save();settlement.emit(f.options);
  batch=fs.readFileSync(path.join(out,'extract-batch.md'),'utf8');assert.equal(batch,'');
  decisions=fs.readFileSync(path.join(out,'decision-table.md'),'utf8');
  assert.equal(decisions.split('extracted lesson needs a family').length-1,2);
  for(const row of heads) {assert.ok(decisions.includes(row.file));assert.ok(decisions.includes(row.final.extract));}
});


test('partial merge scores only named bundles and writes its filtered reference', t => {
  const f=fixture(t);build(f.options,fixtureSampling);
  const {out,keyDir}=f.options,key=json(path.join(keyDir,'key.json'));
  const selected=['r0-1','r0-2','r0-3'];
  for(const bundle of selected) for(const who of ['A','B']) {
    const text=fs.readFileSync(path.join(out,'bundles',`${bundle}-${who}.md`),'utf8');
    put(path.join(out,'out',who,`${bundle}.json`),resultFor(text,key,who));
  }
  const result=merge({...f.options,bundles:selected.join(',')});
  assert.equal(result.A.lessons,3);assert.equal(result.A.negatives,1);
  const reference=json(path.join(out,'holdout.json'));
  assert.equal(Object.keys(reference.kinds).length,3);assert.equal(reference.unscored.length,1);
  assert.equal(Object.keys(json(path.join(out,'A.json')).kinds).length,6);
  assert.throws(()=>merge(f.options),/missing|coverage/i);
});

test('build CLI accepts arbitrary reference memory and router without fixed project counts',t=>{
  const f=fixture(t);put(path.join(f.options.memory,'MEMORY.md'),routerText);
  for(let i=0;i<120;i++) put(path.join(f.options.reference,`lesson-${100+i}-control.md`),`---\nname: Control ${i}\ndescription: Reusable calibration\nmetadata:\n  kind: ${i<70?'mistake':i<96?'practice':'observation'}\n---\nCheck unique control ${i} before acting.\n`);
  for(let i=0;i<25;i++) put(path.join(f.options.reference,`negative-${i}.md`),`# State ${i}\nThe project has ${i} queues.\n`);
  const r=spawnSync(process.execPath,[path.join(repo,'engine/memory-label.mjs'),'build','--census',f.options.census,'--memory',f.options.memory,'--reference',f.options.reference,'--key-dir',f.options.keyDir,'--out',f.options.out],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  for(const name of bundles(f.options.out)) assert.match(fs.readFileSync(path.join(f.options.out,'bundles',name),'utf8'),/## Reading harm/);
});


test('emit previews each map row with the same promotion date precedence', async t=>{
  const f=settlementFixture(t),{memory,census,out}=f.options;
  const source=json(census).rows;
  for(const family of ['pilot','craft-tools']) {
    const lines=source.filter(r=>r.route.includes(family)).map(r=>`- [x](${r.file})\n`).join('');
    put(path.join(memory,`INDEX-${family}.md`),'# Hot\n'+lines);
    put(path.join(memory,`INDEX-${family}-all.md`),'# Catalog\n'+lines);
  }
  const eligible=f.rows.filter(r=>r.settled_by==='agree'&&!f.key[r.id].no_rename);
  put(path.join(memory,eligible[0].file),'---\nname: dated\nmetadata:\n  modified: 2026-09-01\n---\n# Event 2025-02-03\nA reusable rule.\n');
  const git=(...args)=>{const r=spawnSync('git',['-C',memory,'-c','user.name=fixture','-c','user.email=fixture@example.invalid',...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:path.join(f.root,'no-global'),GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_DATE:'2025-04-03T00:00:00Z',GIT_COMMITTER_DATE:'2025-04-03T00:00:00Z'}});assert.equal(r.status,0,r.stderr);};
  put(path.join(memory,eligible[1].file),'---\nname: git fallback\nmetadata:\n  modified: 2026-09-01\n---\nA reusable rule without a body date.\n');
  git('init');git('add',eligible[1].file);git('commit','-m','Fixture baseline');
  put(path.join(memory,eligible[2].file),'---\nname: modified fallback\nmetadata:\n  modified: 2026-09-01\n---\nAnother reusable rule without a date.\n');
  settlement.emit(f.options);
  const report=fs.readFileSync(path.join(out,'family-projection.md'),'utf8');
  assert.ok(report.includes(`| ${eligible[1].file} | 2025-04-03 | git |`));
  assert.ok(report.includes(`| ${eligible[2].file} | 2026-09-01 | modified |`));
  assert.match(report,/Date preview/);assert.ok(report.includes(`| ${eligible[0].file} | 2025-02-03 | body |`));
  const {promotionDate}=await import('../engine/memory-promote.mjs');
  const {memoryFiles}=await import('../engine/lib.mjs');
  const map=json(path.join(out,'promote-map.json'));
  for(const file of memoryFiles(memory).filter(f=>Object.hasOwn(map.promote,f.file))) {
    const date=promotionDate(file,memory,map.promote[file.file]);
    assert.ok(report.includes(`| ${file.file} | ${date?.date??''} | ${date?.date_source??'none'} |`));
  }
});
