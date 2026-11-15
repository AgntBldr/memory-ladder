import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {promoteTopics} from '../engine/memory-promote.mjs';
import * as migrate from '../engine/memory-migrate.mjs';
import {loadConfig, parseFrontmatter, memoryFiles} from '../engine/lib.mjs';
import {writeMemoryIndex, generatedMarker} from '../engine/memory-index.mjs';
import {runCheck} from '../engine/memory-check.mjs';
import {fixture, put, read, json, tree, ok} from './helpers.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const hashes = root => Object.fromEntries(Object.entries(tree(root, {git:true})).map(([file, bytes]) => [file, digest(Buffer.from(bytes, 'base64'))]));
const note = (name, meta = '  date: 2026-01-02\n', body = 'Keep the violet calibration result.\n') => `---\nname: ${name}\ndescription: Verify the measured result before another operation.\ncustom: "retain: this"\nmetadata:\n  type: feedback\n  route: [craft-demo]\n  unknown: [one, two]\n${meta}---\n\n${body}`;
function setup(t) {
  const f = fixture(t), memoryDir = path.join(f.root, 'memory'), also = path.join(f.target, 'brain');
  put(path.join(memoryDir, 'MEMORY.md'), '# Memory\n\n## Hard rules\n- [Rule](rule.md)\n\n## Routes\n- [Craft](INDEX-craft-demo.md) OPEN BEFORE crafting.\n- [Checks](INDEX-check-demo.md) OPEN BEFORE checking.\n');
  put(path.join(memoryDir, 'alpha-note.md'), note('alpha-note'));
  put(path.join(memoryDir, 'beta-note.md'), note('beta-note', '  modified: 2026-01-01T12:00:00Z\n').replaceAll('\n', '\r\n'));
  put(path.join(memoryDir, 'lesson-007-existing.md'), note('lesson-007-existing', '  date: 2025-12-01\n  kind: practice\n  lesson: "007"\n'));
  put(path.join(memoryDir, 'rule.md'), note('rule', '', 'Never discard the measured result.\n'));
  put(path.join(memoryDir, 'state.md'), note('state', '  state: true\n'));
  put(path.join(memoryDir, 'head.md'), note('head', '', '[Part](head-background.md)\n'));
  put(path.join(memoryDir, 'head-background.md'), note('head-background', '', 'Part 1 of [head](head.md).\n'));
  put(path.join(memoryDir, 'undated.md'), note('undated', ''));
  put(path.join(memoryDir, 'ARCHIVE.md'), '# Archive\n');
  put(path.join(memoryDir, 'references.md'), note('references', '', '[[alpha-note]] [[alpha-note|alias]] [[alpha-note.md]] [a](alpha-note.md) [b](alpha-note.md#anchor) [c](./alpha-note.md)\n'));
  put(path.join(also, 'nested', 'references.md'), '[[alpha-note]] [a](alpha-note.md#anchor)\n');
  put(path.join(also, 'node_modules', 'skip.md'), '[[alpha-note]]\n');
  put(path.join(also, '.git', 'skip.md'), '[[alpha-note]]\n');
  put(path.join(also, 'skip.txt'), 'alpha-note.md\n');
  const config = loadConfig();
  config.pins = {'craft-demo':['alpha-note.md']};
  const configFile = put(path.join(f.target, 'scripts/memory/memory.config.json'), JSON.stringify(config));
  const probesFile = put(path.join(f.target, 'scripts/memory/recall-probes.json'), JSON.stringify({version:1,minPass:1,probes:[{id:'violet',q:'violet calibration',expect:['alpha-note.md']}]}));
  writeMemoryIndex({memoryDir,config});
  const map = {version:1,promote:{'alpha-note.md':{kind:'mistake',trigger:'before calibration',case:'K3',pin:false},'beta-note.md':{kind:'observation',route:['check-demo']}}};
  const mapFile = put(path.join(f.root, 'map.json'), JSON.stringify(map));
  const options = {memoryDir,repo:f.target,map:mapFile,also:[also]};
  const cli = (args = []) => f.cli('engine/memory-migrate.mjs', ['promote','--memory-dir',memoryDir,'--repo',f.target,'--map',mapFile,'--also',also,...args]);
  return {...f,memoryDir,also,config,configFile,probesFile,map,mapFile,options,cli};
}
const promote = options => promoteTopics(options);

test('promote dry run predicts proofs without changing any file', t => {
  const f = setup(t), before = hashes(f.root), r = JSON.parse(ok(f.cli()).stdout);
  assert.equal(r.written,false); assert.equal(r.rows.length,2);
  assert.ok(r.proof.bodies.every(x => x.before === x.after));
  assert.deepEqual(r.proof.recall.regressions,[]); assert.deepEqual(r.proof.gate.newFails,[]);
  assert.equal(r.proof.remainingReferences,0); assert.deepEqual(hashes(f.root),before);
});
test('promote numbers chronologically after existing ids and preserves LF and CRLF bodies', t => {
  const f = setup(t), bodies = new Map(['alpha-note.md','beta-note.md'].map(n=>[n,Buffer.from(migrate.rawBody(read(path.join(f.memoryDir,n))))]));
  const r = promote({...f.options,write:true});
  assert.deepEqual(r.rows.map(x=>[x.old,x.number,x.date,x.date_source]),[['beta-note.md','008','2026-01-01','modified'],['alpha-note.md','009','2026-01-02','metadata.date']]);
  for (const row of r.rows) { assert.deepEqual(Buffer.from(migrate.rawBody(read(path.join(f.memoryDir,row.new)))),bodies.get(row.old)); assert.equal(row.sha256_body,digest(bodies.get(row.old))); }
  const fm = parseFrontmatter(read(path.join(f.memoryDir,r.rows[1].new))).data;
  assert.equal(fm.name,'lesson-009-alpha-note'); assert.equal(fm.custom,'retain: this');
  assert.deepEqual(fm.metadata.unknown,['one','two']); assert.equal(fm.metadata.type,'feedback');
  assert.equal(fm.metadata.source,'alpha-note.md'); assert.equal(fm.metadata.kind_case,'K3'); assert.equal(fm.metadata.pin,false); assert.equal(fm.metadata.trigger,'before calibration');
  assert.deepEqual(fm.metadata.route,['craft-demo']);
  const evidence = json(path.join(f.memoryDir,r.mapFile)); assert.deepEqual(evidence.rows,r.rows);
  assert.match(r.mapFile,/^promote-map-\d{8}T\d{6}\.json$/);
});
test('promote rewrites each link form recursively plus probes and config pins', t => {
  const f = setup(t), r = promote({...f.options,write:true}), name = r.rows.find(x=>x.old==='alpha-note.md').new, stem = name.slice(0,-3);
  assert.ok(read(path.join(f.memoryDir,'references.md')).endsWith(`[[${stem}]] [[${stem}|alias]] [[${name}]] [a](${name}) [b](${name}#anchor) [c](./${name})\n`));
  assert.equal(read(path.join(f.also,'nested/references.md')),`[[${stem}]] [a](${name}#anchor)\n`);
  assert.equal(read(path.join(f.also,'node_modules/skip.md')),'[[alpha-note]]\n');
  assert.equal(read(path.join(f.also,'.git/skip.md')),'[[alpha-note]]\n'); assert.equal(read(path.join(f.also,'skip.txt')),'alpha-note.md\n');
  assert.deepEqual(json(f.probesFile).probes[0].expect,[name]); assert.deepEqual(json(f.configFile).pins['craft-demo'],[name]);
  assert.equal(r.proof.recall.before[0].pass,true); assert.equal(r.proof.recall.after[0].pass,true);
  assert.equal(r.proof.remainingReferences,0); assert.ok(r.links.some(x=>x.count===6));
});
test('promote reports every refusal while writing eligible rows', t => {
  const f = setup(t);
  put(path.join(f.memoryDir,'generated.md'),generatedMarker+'\nGenerated.\n');
  put(path.join(f.memoryDir,'protected.md'),note('protected'));
  put(path.join(f.memoryDir,'invalid.md'),note('invalid'));
  put(path.join(f.memoryDir,'unknown.md'),note('unknown'));
  const protect = put(path.join(f.root,'protect.txt'),'protected.md\r\n');
  const expected = {'lesson-007-existing.md':'already a lesson','generated.md':'generated page','MEMORY.md':'special file','ARCHIVE.md':'special file','state.md':'state','rule.md':'hard-rule','head.md':'chain head','head-background.md':'chain part','protected.md':'protected','absent.md':'missing file','invalid.md':'invalid kind','unknown.md':'unknown route family','undated.md':'no date'};
  for (const file of Object.keys(expected)) f.map.promote[file] = {kind:'practice'};
  f.map.promote['invalid.md'].kind='wrong'; f.map.promote['unknown.md'].route=['absent-demo']; put(f.mapFile,JSON.stringify(f.map));
  const r = promote({...f.options,protect,write:true});
  assert.equal(r.rows.length,2);
  for (const [file,reason] of Object.entries(expected)) assert.ok(r.refused.some(x=>x.file===file&&x.reason.includes(reason)),`${file}: ${JSON.stringify(r.refused)}`);
});
test('promote refuses a target collision without overwriting bytes', t => {
  const f = setup(t); f.map.promote={'alpha-note.md':{kind:'practice'}}; put(f.mapFile,JSON.stringify(f.map));
  const target = path.join(f.memoryDir,'lesson-008-alpha-note.md'); fs.mkdirSync(target);
  const r = promote({...f.options,write:true}); assert.equal(r.rows.length,0); assert.match(r.refused[0].reason,/collision/); assert.ok(fs.statSync(target).isDirectory());
});
test('promote second write is byte-identical and reports already promoted', t => {
  const f = setup(t); promote({...f.options,write:true}); const before = hashes(f.root), r = promote({...f.options,write:true});
  assert.deepEqual(r.rows,[]); assert.deepEqual(r.refused,[]); assert.equal(r.skipped.length,2); assert.ok(r.skipped.every(x=>x.reason==='already promoted')); assert.deepEqual(hashes(f.root),before);
});
test('promote uses first git commit date and breaks date ties by filename', t => {
  const f = setup(t); f.git(f.memoryDir,'init');
  for (const n of ['zeta-note','gamma-note']) put(path.join(f.memoryDir,n+'.md'),note(n,''));
  f.git(f.memoryDir,'add','.'); ok(f.exec('git',['-C',f.memoryDir,'commit','-m','Fixture'],{env:{...f.env,GIT_AUTHOR_DATE:'2025-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2025-01-01T00:00:00Z'}}));
  f.map.promote={'zeta-note.md':{kind:'practice'},'gamma-note.md':{kind:'practice'}}; put(f.mapFile,JSON.stringify(f.map));
  const r = promote(f.options); assert.deepEqual(r.rows.map(x=>[x.old,x.date,x.date_source]),[['gamma-note.md','2025-01-01','git'],['zeta-note.md','2025-01-01','git']]);
});
test('E2.8 (e) promote reads this memory\'s git dates and this project\'s tracked files with GIT_DIR and GIT_WORK_TREE exported to a foreign linked worktree', t => {
  const f = setup(t); f.git(f.target,'add','AGENTS.md','.claude/settings.json'); f.git(f.memoryDir,'init');
  for (const n of ['zeta-note','gamma-note']) put(path.join(f.memoryDir,n+'.md'),note(n,''));
  f.git(f.memoryDir,'add','.'); ok(f.exec('git',['-C',f.memoryDir,'commit','-m','Fixture'],{env:{...f.env,GIT_AUTHOR_DATE:'2025-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2025-01-01T00:00:00Z'}}));
  f.map.promote={'zeta-note.md':{kind:'practice'},'gamma-note.md':{kind:'practice'}}; put(f.mapFile,JSON.stringify(f.map));
  put(path.join(f.target,'untracked.bin'),Buffer.alloc(64)); // left out by this project's git listing, kept by a plain walk
  const plain = promote(f.options);
  // A foreign checkout and its linked worktree, with a tracked file this project does not have.
  const foreign = path.join(f.root,'foreign'), wt = path.join(f.root,'foreign-wt'); fs.mkdirSync(foreign); f.git(foreign,'init','-q','-b','main');
  put(path.join(foreign,'foreign-only.md'),'[[gamma-note]]\n'); f.git(foreign,'add','-A'); f.git(foreign,'commit','-qm','foreign'); f.git(foreign,'worktree','add','-q',wt);
  const values = {GIT_DIR: f.git(wt,'rev-parse','--absolute-git-dir'), GIT_WORK_TREE: wt}, saved = {GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE};
  Object.assign(process.env, values);
  let r;
  try { r = promote(f.options); }
  finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  assert.deepEqual(r.rows.map(x=>[x.old,x.date,x.date_source]),[['gamma-note.md','2025-01-01','git'],['zeta-note.md','2025-01-01','git']]);
  assert.deepEqual(r.rehearsal, plain.rehearsal);
});
test('promote keeps long default slugs and crosses three-digit ids', t => {
  const f = setup(t), stem='a-very-long-topic-name-that-must-never-be-truncated-by-the-promotion-command';
  put(path.join(f.memoryDir,'lesson-999-existing.md'),note('existing','  kind: practice\n  date: 2025-01-01\n'));
  put(path.join(f.memoryDir,stem+'.md'),note(stem)); f.map.promote={[stem+'.md']:{kind:'practice'}}; put(f.mapFile,JSON.stringify(f.map));
  const r = promote(f.options); assert.equal(r.rows[0].new,`lesson-1000-${stem}.md`);
});
test('promote shrinks a crowded hot page without new gate FAILs', t => {
  const f = setup(t); f.map.promote={};
  for(let i=0;i<100;i++) { const n=`sample-${String(i).padStart(3,'0')}`; put(path.join(f.memoryDir,n+'.md'),note(n)); f.map.promote[n+'.md']={kind:'practice'}; }
  put(f.mapFile,JSON.stringify(f.map)); writeMemoryIndex({memoryDir:f.memoryDir,config:f.config});
  const before=fs.statSync(path.join(f.memoryDir,'INDEX-craft-demo.md')).size;
  assert.ok(before>8192);
  const r=promote({...f.options,write:true}); assert.deepEqual(r.proof.gate.newFails,[]);
  const after=fs.statSync(path.join(f.memoryDir,'INDEX-craft-demo.md')).size; assert.ok(after<before,`${before} -> ${after}`); assert.ok(after<=8192);
});
test('promote injected recall regression rolls back memory and external files', t => {
  const f = setup(t), before=hashes(f.root);
  assert.throws(()=>promote({...f.options,write:true,afterWrite:()=>put(f.probesFile,JSON.stringify({version:1,minPass:1,probes:[{id:'violet',q:'impossible-token',expect:['absent.md']}]}))}),/proof/i);
  assert.deepEqual(hashes(f.root),before);
});
test('promote injected new gate FAIL rolls back all bytes', t => {
  const f=setup(t), before=hashes(f.root); let calls=0;
  assert.throws(()=>promote({...f.options,write:true,check:options=>{const r=runCheck(options); if(++calls>2) r.findings.push({severity:'FAIL',check:'injected.failure',file:'MEMORY.md',message:'fixture'}); return r;}}),/proof/i);
  assert.deepEqual(hashes(f.root),before);
});
test('promote cross-linked bodies change only by reversible planned rewrites', t => {
  const f=setup(t);
  put(path.join(f.memoryDir,'alpha-note.md'),note('alpha-note','  date: 2026-01-02\n','Violet calibration [[beta-note|detail]]\n'));
  put(path.join(f.memoryDir,'beta-note.md'),note('beta-note','  date: 2026-01-01\n','[Detail](./alpha-note.md#anchor)\n').replaceAll('\n','\r\n'));
  const originals=new Map(['alpha-note.md','beta-note.md'].map(n=>[n,migrate.rawBody(read(path.join(f.memoryDir,n)))]));
  const before=hashes(f.root),dry=promote(f.options); assert.deepEqual(hashes(f.root),before);
  const r=promote({...f.options,write:true});
  for(const result of [dry,r]) for(const row of result.rows) {
    const p=result.proof.bodies.find(p=>p.old===row.old);
    assert.equal(row.sha256_body,digest(originals.get(row.old))); assert.equal(row.link_rewrites,1);
    assert.equal(p.after,row.sha256_expected); assert.equal(p.reversed,row.sha256_body); assert.equal(p.reversible,true);
  }
  assert.match(read(path.join(f.memoryDir,r.rows[0].new)),/\[Detail\]\(\.\/lesson-009-alpha-note.md#anchor\)\r\n$/);
  assert.deepEqual(json(path.join(f.memoryDir,r.mapFile)).rows,r.rows);
});
test('promote rejects invalid usage and unsafe map paths before writes', t => {
  const f=setup(t), before=hashes(f.root);
  for(const args of [['--map=x'],['--protect'],['--unknown']]) assert.equal(f.cli(args).status,1);
  assert.deepEqual(hashes(f.root),before);
  for(const map of [{version:2,promote:{}},{version:1,promote:{'../outside.md':{kind:'practice'}}}]) {put(f.mapFile,JSON.stringify(map)); assert.equal(f.cli(['--write']).status,1);}
});
test('promote lock failure does not mutate memory', t => {
  const f=setup(t); put(path.join(f.memoryDir,'.memory.lock'),JSON.stringify({pid:1,host:'fixture-other-host',time:new Date().toISOString()})); const before=hashes(f.root);
  const r=f.cli(['--write']); assert.equal(r.status,1); assert.match(r.stderr,/lock/); assert.deepEqual(hashes(f.root),before);
});
test('promote repeated also options and a custom slug work through the write CLI', t => {
  const f=setup(t), second=path.join(f.root,'extra'); put(path.join(second,'nested/ref.md'),'[[alpha-note|kept label]]\n');
  f.map.promote['alpha-note.md'].slug='calibration-check'; put(f.mapFile,JSON.stringify(f.map));
  const r=JSON.parse(ok(f.cli(['--also',second,'--write'])).stdout);
  assert.equal(r.rows[1].new,'lesson-009-calibration-check.md'); assert.equal(read(path.join(second,'nested/ref.md')),'[[lesson-009-calibration-check|kept label]]\n');
});
test('promote rewrites exact prose and code filenames in bodies and also roots', t => {
  const f=setup(t),text='`alpha-note.md` alpha-note.md ../alpha-note.md alpha-note-extra.md xalpha-note.md alpha-note\n';
  put(path.join(f.memoryDir,'beta-note.md'),note('beta-note','  date: 2026-01-01\n',text));
  put(path.join(f.memoryDir,'references.md'),note('references','',text));
  put(path.join(f.also,'plain.md'),'---\nmetadata:\n  source: alpha-note.md\ncustom:\n  source: alpha-note.md\n---\n'+text);
  const r=JSON.parse(ok(f.cli(['--write'])).stdout),name=r.rows[1].new;
  const expected=text.replaceAll('alpha-note.md',name).replace('x'+name,'xalpha-note.md');
  assert.equal(migrate.rawBody(read(path.join(f.memoryDir,r.rows[0].new))),'\n'+expected);
  assert.equal(migrate.rawBody(read(path.join(f.memoryDir,'references.md'))),'\n'+expected);
  assert.equal(read(path.join(f.also,'plain.md')),'---\nmetadata:\n  source: alpha-note.md\ncustom:\n  source: '+name+'\n---\n'+expected);
  assert.equal(r.rows[0].link_rewrites,3); assert.equal(r.proof.remainingReferences,0);
});
test('promote preserves a body containing inner frontmatter fences', t => {
  const f=setup(t); const text='Intro\n---\nexample: retained\n---\nTail\n'; put(path.join(f.memoryDir,'bare.md'),text);
  f.git(f.memoryDir,'init'); f.git(f.memoryDir,'add','bare.md'); f.git(f.memoryDir,'commit','-m','Fixture');
  f.map.promote={'bare.md':{kind:'practice',route:['craft-demo']}}; put(f.mapFile,JSON.stringify(f.map));
  const r=promote({...f.options,write:true}); assert.equal(migrate.rawBody(read(path.join(f.memoryDir,r.rows[0].new))),text);
});
test('promote never silently replaces invalid UTF-8 bytes', t => {
  const f=setup(t); fs.appendFileSync(path.join(f.memoryDir,'alpha-note.md'),Buffer.from([0xff])); const before=hashes(f.root);
  assert.throws(()=>promote({...f.options,write:true}),/UTF-8|proof/); assert.deepEqual(hashes(f.root),before);
});
test('promote dry and write proofs agree when recall depends on an also directory', t => {
  const f=setup(t); put(path.join(f.also,'nested/ref.md'),'---\nid: dec-example\ntype: decision\n---\nUnique quartz [[alpha-note]]\n');
  put(f.probesFile,JSON.stringify({version:1,minPass:1,probes:[{id:'quartz',q:'quartz lesson-009-alpha-note',expect:['brain/nested/ref.md']}]}));
  const before=hashes(f.root), predicted=promote(f.options); assert.deepEqual(hashes(f.root),before);
  const actual=promote({...f.options,write:true});
  assert.deepEqual(predicted.proof.recall.after,actual.proof.recall.after);
});
test('promote compares individual probes even when probe ids repeat', t => {
  const f=setup(t), probes=json(f.probesFile); probes.probes.push({...probes.probes[0]}); put(f.probesFile,JSON.stringify(probes)); const before=hashes(f.root);
  assert.throws(()=>promote({...f.options,write:true,afterWrite:()=>{const p=json(f.probesFile);p.probes[0].q='impossible-token';put(f.probesFile,JSON.stringify(p));}}),/proof/i);
  assert.deepEqual(hashes(f.root),before);
});

test('review1 non-promoted destinations leave body bytes identical', t=>{
  const f=setup(t),file=path.join(f.memoryDir,'alpha-note.md');
  put(file,note('alpha-note','  date: 2026-01-02\n','Violet calibration [[undated]] [Detail](undated.md) `undated.md`\n').replaceAll('\n','\r\n'));
  const before=Buffer.from(migrate.rawBody(read(file))),r=promote({...f.options,write:true}),row=r.rows[1];
  assert.equal(row.link_rewrites,0);assert.equal(row.sha256_expected,digest(before));
  assert.deepEqual(Buffer.from(migrate.rawBody(read(path.join(f.memoryDir,row.new)))),before);
  assert.equal(r.proof.bodies[1].reversible,true);
});
test('review1 an unplanned body edit fails measured proof and restores every input', t=>{
  for(const edit of ['extra text','invalid bytes']) {
    const f=setup(t);
    if(edit==='invalid bytes') fs.appendFileSync(path.join(f.memoryDir,'beta-note.md'),'\uFFFD\n');
    const dry=promote(f.options);assert.equal(dry.proof.bodies[0].reversible,true);const before=hashes(f.root);
    assert.throws(()=>promote({...f.options,write:true,afterWrite:()=>{
      const file=path.join(f.memoryDir,dry.rows[0].new);
      if(edit==='extra text') fs.appendFileSync(file,'Planted extra edit.\n');
      else {const bytes=fs.readFileSync(file),at=bytes.indexOf(Buffer.from('\uFFFD'));fs.writeFileSync(file,Buffer.concat([bytes.subarray(0,at),Buffer.from([0xff]),bytes.subarray(at+3)]));}
    }}),error=>{
      assert.match(error.message,/proof/);assert.equal(error.report.rolledBack,true);assert.equal(error.report.proof.bodies[0].reversible,false);return true;
    });assert.deepEqual(hashes(f.root),before);
  }
});
test('review1 git rehearsal excludes untracked bulk and nested worktrees with visible cost', t=>{
  const f=setup(t); f.git(f.target,'add','AGENTS.md','.claude/settings.json');
  const before=hashes(f.root),baseline=promote(f.options);assert.deepEqual(hashes(f.root),before);
  assert.ok(baseline.rehearsal.files>0);assert.ok(baseline.rehearsal.bytes>0);
  put(path.join(f.target,'.claude/worktrees/x/.git'),'gitdir: elsewhere\n');
  for(let i=0;i<50;i++) {put(path.join(f.target,'.claude/worktrees/x',`${i}.txt`),'nested'.repeat(100));put(path.join(f.target,'big',`${i}.bin`),Buffer.alloc(1024));}
  const polluted=hashes(f.root),r=promote(f.options);assert.deepEqual(r.rehearsal,baseline.rehearsal);assert.deepEqual(hashes(f.root),polluted);
  assert.equal(r.proof.recall.after[0].pass,true);assert.deepEqual(r.proof.gate.newFails,[]);
});
test('review1 non-git rehearsal skips nested repositories and node_modules', t=>{
  const f=setup(t),repo=path.join(f.root,'plain-project');fs.mkdirSync(repo);
  for(const file of ['memory.config.json','recall-probes.json']) put(path.join(repo,'scripts/memory',file),read(path.join(f.target,'scripts/memory',file)));
  const options={...f.options,repo},baseline=promote(options);assert.ok(baseline.rehearsal.files>0);
  put(path.join(repo,'nested-file/.git'),'gitdir: elsewhere\n');put(path.join(repo,'nested-file/a.txt'),'hidden');
  put(path.join(repo,'nested-dir/.git/config'),'hidden');put(path.join(repo,'nested-dir/b.txt'),'hidden');
  put(path.join(repo,'node_modules/c.txt'),'hidden');
  assert.deepEqual(promote(options).rehearsal,baseline.rehearsal);
});
test('review1 date precedence uses map metadata and body before migration timestamps', t=>{
  const f=setup(t);
  put(path.join(f.memoryDir,'alpha-note.md'),note('alpha-note','  modified: 2026-10-07T12:00:00Z\n','**What happened (2026-08-03).** Violet calibration\n'));
  put(path.join(f.memoryDir,'beta-note.md'),note('beta-note','  modified: 2026-10-06T12:00:00Z\n','**What happened (2026-07-02).**\n'));
  put(path.join(f.memoryDir,'map-note.md'),note('map-note','  date: 2026-09-01\n','2026-01-01\n'));
  put(path.join(f.memoryDir,'meta-note.md'),note('meta-note','  date: 2026-06-01\n','2026-01-01\n'));
  f.map.promote['map-note.md']={kind:'practice',date:'2026-05-01'};f.map.promote['meta-note.md']={kind:'practice'};put(f.mapFile,JSON.stringify(f.map));
  const r=promote({...f.options,write:true});
  assert.deepEqual(r.rows.map(r=>[r.old,r.date,r.date_source]),[['map-note.md','2026-05-01','map'],['meta-note.md','2026-06-01','metadata.date'],['beta-note.md','2026-07-02','body'],['alpha-note.md','2026-08-03','body']]);
  assert.deepEqual(r.dates,{map:1,metadata:1,body:2,git:0,modified:0});
  assert.equal(parseFrontmatter(read(path.join(f.memoryDir,r.rows[0].new))).data.metadata.date,'2026-05-01');
});
test('review1 body dates ignore fenced code and stop after ten nonblank eligible lines', t=>{
  const f=setup(t);
  put(path.join(f.memoryDir,'alpha-note.md'),note('alpha-note','  modified: 2026-10-07T12:00:00Z\n','```md\n2020-01-01\n```\n~~~text\n2021-01-01\n~~~\n\n2026-08-03 Violet calibration\n'));
  put(path.join(f.memoryDir,'beta-note.md'),note('beta-note','  modified: 2026-10-06T12:00:00Z\n',Array.from({length:10},(_,i)=>`Line ${i}\n\n`).join('')+'2022-01-01\n'));
  const r=promote(f.options);assert.deepEqual(r.rows.map(r=>[r.date,r.date_source]),[['2026-08-03','body'],['2026-10-06','modified']]);
  for(const date of ['2026-02-30','2026-8-3',null]) {f.map.promote['alpha-note.md'].date=date;put(f.mapFile,JSON.stringify(f.map));assert.throws(()=>promote(f.options),/date/);}
});
test('review1 first git commit outranks metadata modified', t=>{
  const f=setup(t);f.git(f.memoryDir,'init');f.git(f.memoryDir,'add','beta-note.md');
  ok(f.exec('git',['-C',f.memoryDir,'commit','-m','Fixture'],{env:{...f.env,GIT_AUTHOR_DATE:'2025-04-03T00:00:00Z',GIT_COMMITTER_DATE:'2025-04-03T00:00:00Z'}}));
  const r=promote(f.options);assert.equal(r.rows[0].date,'2025-04-03');assert.equal(r.rows[0].date_source,'git');assert.equal(r.dates.git,1);
});
test('review1 optional stubs preserve source endings and types and remain idempotent', t=>{
  const f=setup(t);put(path.join(f.memoryDir,'beta-note.md'),read(path.join(f.memoryDir,'beta-note.md')).replace('metadata:\r\n  type: feedback','type: reference\r\nmetadata:'));
  const r=JSON.parse(ok(f.cli(['--stubs','--write'])).stdout);
  for(const row of r.rows) {
    const stem=row.new.slice(0,-3),eol=row.old==='beta-note.md'?'\r\n':'\n',type=row.old==='beta-note.md'?'reference':'feedback';
    const expected=`---\nname: ${row.old.slice(0,-3)}\ndescription: "Moved to ${stem} on ${r.created.slice(0,10)} (numbered lesson)."\nmoved_to: ${row.new}\nmetadata:\n  type: ${type}\n---\n\n[Open ${stem}](${row.new})\n`.replaceAll('\n',eol);
    assert.equal(read(path.join(f.memoryDir,row.old)),expected);assert.equal(row.stub,true);
    const file=memoryFiles(f.memoryDir).find(f=>f.file===row.old);assert.equal(file.stub,true);assert.equal(file.topic,false);
  }
  const findings=runCheck({...f.options,config:json(f.configFile),noGit:true}).findings;
  assert.ok(!findings.some(x=>r.rows.some(r=>r.old===x.file)&&/orphan|^topic\./.test(x.check)));
  const before=hashes(f.root),again=JSON.parse(ok(f.cli(['--stubs','--write'])).stdout);assert.equal(again.skipped.length,2);assert.deepEqual(again.refused,[]);assert.deepEqual(hashes(f.root),before);
  const g=setup(t),plain=promote({...g.options,write:true});for(const row of plain.rows) {assert.equal(row.stub,false);assert.equal(fs.existsSync(path.join(g.memoryDir,row.old)),false);}
});
test('toolkit external proof catches JSON keys and prose that exact value rewrites leave behind', t=>{
  const f=setup(t),config=json(f.configFile);
  config.extra={'alpha-note.md':'unchanged key',prose:'Read alpha-note.md later.',exact:'alpha-note.md'};put(f.configFile,JSON.stringify(config));
  const before=hashes(f.root),r=promote(f.options);
  assert.equal(r.proof.remainingReferences,0);
  assert.ok(r.external_references.some(hit=>hit.file.endsWith('memory.config.json')));
  assert.throws(()=>promote({...f.options,write:true}),/proof failed/);
  assert.deepEqual(hashes(f.root),before);
});


test('toolkit rollback preserves all memory bytes after a measured proof failure',t=>{
  const f=setup(t),before=hashes(f.memoryDir);
  assert.throws(()=>promote({...f.options,write:true,afterWrite:()=>{throw Error('injected after regeneration');}}),/injected/);
  assert.deepEqual(hashes(f.memoryDir),before);
});

test('toolkit external scan ignores source provenance, including multiline values',t=>{
  const f=setup(t),scan=path.join(f.root,'reference.md');
  put(scan,'---\nmetadata:\n  source: |\n    alpha-note.md\n---\nNo live references.\n');
  const result=promote({...f.options,scan:[scan]});assert.deepEqual(result.external_references,[]);
});
