import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {runCheck} from '../engine/memory-check.mjs';
import {buildCorpus} from '../engine/memory-recall.mjs';
import {measure, readable} from '../engine/memory-measure.mjs';
import defaults from '../engine/selftest-config.mjs';
import {parseFrontmatter} from '../engine/lib.mjs';
const today = '2026-10-27';
const engine = path.resolve('engine');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate327-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const memoryDir = path.join(root, 'memory'), repo = path.join(root, 'repo');
  fs.mkdirSync(memoryDir); fs.mkdirSync(repo);
  const config = structuredClone(defaults);
  // Deliberately exercise unmerged project configurations in every case.
  delete config.caps.lesson; delete config.caps.guard;
  delete config.caps.router.warnLines; delete config.caps.router.failLines; delete config.caps.topic.warnLineChars;
  const put = (file, text, base = memoryDir) => { const p = path.join(base, file); fs.mkdirSync(path.dirname(p), {recursive: true}); fs.writeFileSync(p, text); return p; };
  put('MEMORY.md', '# Memory\n');
  const lesson = (meta = {}, body = 'Apply the rule.', id = '001') => put(`lesson-${id}-example.md`, `---\nname: lesson-${id}-example\ndescription: Useful guidance for verification.\nmetadata:\n  type: feedback\n${Object.entries({kind:'mistake',...meta}).map(([k,v]) => `  ${k}: ${JSON.stringify(v)}\n`).join('')}---\n\n**#${id}. Example.**\n\n${body}\n`);
  const check = (extra = {}) => runCheck({memoryDir, repo, config, today, noGit: true, scope: 'memory', ...extra});
  const cli = (name, argv = []) => { const cp = put('config.json', JSON.stringify(config), root); return spawnSync(process.execPath, [path.join(engine, name+'.mjs'), '--memory-dir', memoryDir, '--repo', repo, '--config', cp, '--today', today, ...argv], {encoding: 'utf8'}); };
  return {root, memoryDir, repo, config, put, lesson, check, cli};
}
const hits = (f, id, extra) => f.check(extra).findings.filter(x => x.check === id);
const repeats = n => Array.from({length:n}, () => `${today} slip: repeated mistake`);

test('327 router.lines boundaries and terminal newline with old config', t => {
  const f=setup(t);
  for (const [n,severity] of [[0,null],[150,null],[151,'WARN'],[200,'WARN'],[201,'FAIL']]) for (const ending of ['', '\n']) {
    f.put('MEMORY.md', n ? Array(n).fill('x').join('\n')+ending : '');
    const h=hits(f,'router.lines'); assert.equal(h[0]?.severity ?? null,severity); if(severity) assert.equal(h[0].value,n);
  }
});
test('327 lesson.repeats shape date cause and 200 character boundary', t => {
  const f=setup(t), prefix=`${today} slip: `;
  for(const value of [null,'x',[3],['2026-02-30 slip: invalid'],[`${today} unknown: invalid`],[prefix+'x'.repeat(201-prefix.length)]]) {
    f.lesson({repeats:value}); assert.equal(hits(f,'lesson.repeats')[0]?.severity,'FAIL');
  }
  for(const value of [[],[prefix+'x'.repeat(200-prefix.length)], ...['slip','not-recalled','rule-wrong','new-case','legacy'].map(c=>[`${today} ${c}: note`])]) {
    f.lesson({repeats:value}); assert.equal(hits(f,'lesson.repeats').length,0);
  }
});
test('327 lesson.enforce no decision boundaries and configurable caps', t => {
  const f=setup(t);
  for(const [n,s] of [[1,null],[2,'WARN'],[3,'WARN'],[4,'FAIL']]) { f.lesson({repeats:repeats(n)}); const h=hits(f,'lesson.enforce'); assert.equal(h[0]?.severity??null,s); if(s) assert.equal(h[0].value,n); }
  f.config.caps.lesson={enforceAfterRepeats:5,failAfterRepeats:6}; assert.equal(hits(f,'lesson.enforce').length,0);
  f.config.caps.lesson={enforceAfterRepeats:5,failAfterRepeats:1}; f.lesson({repeats:repeats(1)}); assert.equal(hits(f,'lesson.enforce')[0]?.severity,'FAIL');
});
test('327 lesson.enforce decision strict date and lesson-only switch', t => {
  const f=setup(t);
  for(const decision of ['check topic.size','lesson-only deliberate judgment']) for(const [n,s] of [[0,null],[1,'WARN'],[4,'FAIL']]) {
    f.lesson({enforced:`${today} ${decision}`,repeats:[...repeats(4),...Array(n).fill('2026-10-28 slip: later')]});
    const h=hits(f,'lesson.enforce'); assert.equal(h[0]?.severity??null,s); if(s) assert.equal(h[0].value,n);
  }
  f.config.caps.lesson={lessonOnlyReturns:false}; assert.equal(hits(f,'lesson.enforce').length,0);
});
test('327 lesson.enforced validates targets and invalid decisions retain escalation', t => {
  const f=setup(t); f.put('hook.mjs','',f.repo);
  f.put('rule.md','---\ndescription: A rule.\n---\nRule.\n'); f.put('MEMORY.md','# Memory\n## Hard rules\n- [Rule](rule.md)\n');
  for(const v of [3,'bad','2026-02-30 check topic.size',`${today} check nonexistent`,`${today} hook ../outside`,`${today} hard-rule missing.md`,`${today} lesson-only short`]) {
    f.lesson({enforced:v,repeats:repeats(4)}); assert.equal(hits(f,'lesson.enforced')[0]?.severity,'WARN'); assert.equal(hits(f,'lesson.enforce')[0]?.severity,'FAIL');
  }
  for(const v of ['check topic.size','check hook.mjs','hook hook.mjs','hard-rule rule.md','lesson-only deliberate judgment']) { f.lesson({enforced:`${today} ${v}`}); assert.equal(hits(f,'lesson.enforced').length,0); }
});
test('327 lesson.kind validates present fields and aggregates missing kinds', t => {
  const f=setup(t);
  for(const kind of ['wrong',null,3]) { f.lesson({kind}); assert.equal(hits(f,'lesson.kind')[0]?.severity,'FAIL'); }
  for(const kind of ['mistake','practice','observation']) { f.lesson({kind}); assert.equal(hits(f,'lesson.kind').length,0); }
  for(const id of ['001','002','003']) { const p=f.lesson({},'Body',id); fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('  kind: "mistake"\n','')); }
  const h=hits(f,'lesson.kind-missing'); assert.equal(h.length,1); assert.equal(h[0].value,3); assert.equal(h[0].file,'MEMORY.md');
});
test('327 lesson.trigger required only after a repeat', t => {
  const f=setup(t); f.lesson(); assert.equal(hits(f,'lesson.trigger').length,0);
  f.lesson({repeats:repeats(1)}); assert.equal(hits(f,'lesson.trigger')[0]?.severity,'WARN');
  f.lesson({repeats:repeats(1),trigger:'before shipping'}); assert.equal(hits(f,'lesson.trigger').length,0);
});
test('327 date.future today tomorrow later across all date fields', t => {
  const f=setup(t);
  for(const [date,s] of [[today,null],['2026-10-28','WARN'],['2026-10-29','FAIL']]) for(const field of ['date','modified','repeats','enforced']) {
    f.lesson({[field]:field==='repeats'?[`${date} slip: note`]:field==='enforced'?`${date} check topic.size`:field==='modified'?date+'T12:00:00Z':date});
    const h=hits(f,'date.future'); assert.equal(h[0]?.severity??null,s); if(s) assert.match(h[0].message,new RegExp(field));
  }
});
test('327 enforce.rules both files overrides validation and lesson references', t => {
  const f=setup(t); f.lesson(); f.config.caps.guard={kitRules:'kit.json',rules:'host.json'};
  const rule={id:'sample',action:'warn',pattern:'hazard',message:'Use a file.'};
  const rules=(kit,host=[])=> { f.put('kit.json',JSON.stringify({version:1,rules:kit}),f.repo); f.put('host.json',JSON.stringify({version:1,rules:host}),f.repo); };
  for(const bad of [{pattern:'['},{pattern:'.*'},{unless:'.*'},{unless:'['},{action:'bad'},{tools:['Other']},{lesson:'999'}]) {
    rules([rule],[{id:'sample',...bad}]); assert.equal(hits(f,'enforce.rules')[0]?.severity,'FAIL');
  }
  rules([rule,rule]); assert.ok(hits(f,'enforce.rules').some(h=>h.message.includes('unique ids')));
  for(const file of ['kit.json','host.json']) { rules([rule]); f.put(file,'{',f.repo); assert.ok(hits(f,'enforce.rules').some(h=>h.message.includes('not valid JSON'))); }
  rules([rule],[{id:'sample',lesson:['001']}]); assert.equal(hits(f,'enforce.rules').length,0);
  f.lesson({enforced:`${today} hook host.json`}); rules([rule]); assert.equal(hits(f,'enforce.rules')[0]?.severity,'WARN');
  rules([rule],[{id:'sample',lesson:'001'}]); assert.equal(hits(f,'enforce.rules').length,0);
  rules([rule],[{id:'sample',unless:'.*'}]); assert.equal(hits(f,'enforce.rules',{quick:true})[0]?.severity,'FAIL');
  assert.equal(hits(f,'enforce.rules',{repo:undefined}).length,0);
});
test('327 split.chain aggregated and topic.line thresholds with protected blocks', t => {
  const f=setup(t); f.put('topic.md','---\ndescription: Useful topic.\n---\n[Part](topic-1.md)\n');
  f.put('topic-1.md','---\ndescription: Useful part.\n---\n'+ 'x'.repeat(2000)+'\n');
  assert.equal(hits(f,'split.chain')[0]?.value,1); assert.equal(hits(f,'topic.line').length,0);
  f.put('topic-1.md','---\ndescription: Useful part.\n---\nPart 1 of [topic](topic.md).\n'+ 'x'.repeat(2001)+'\n  '+ 'x'.repeat(2001)+'\n```\n'+'x'.repeat(2100)+'\n```\n<!-- BEGIN VERBATIM PAYLOAD -->\n'+'x'.repeat(2100)+'\n<!-- END VERBATIM PAYLOAD -->\n');
  assert.equal(hits(f,'split.chain').length,0); const h=hits(f,'topic.line'); assert.equal(h[0]?.value,2); assert.equal(h[0]?.line,5); assert.match(h[0].message,/0 repairable/);
});
for(const [id,damage] of [['chars.replacement','\uFFFD'],['chars.mojibake','\u00e2\u20ac\u201d'],['chars.lost-dash','word ? word']]) test(`327 ${id} one finding per file code skipped`,t=> {
  const f=setup(t); f.lesson({},damage+'\n'+damage+'\n`'+damage+'`\n```\n'+damage+'\n```');
  const h=hits(f,id); assert.equal(h.length,1); assert.equal(h[0].value,2); assert.equal(h[0].severity,'WARN');
  f.put('AGENTS.md',damage,f.repo); assert.equal(hits(f,id,{scope:'all'}).length,1);
});
test('327 lesson.unfilled-body exact prompt sections only',t=> {
  const f=setup(t);
  for(const body of ['**Why:**\n\n**How to apply:**\nText','**Why:**','**How to apply:**\n ']) { f.lesson({},body); assert.equal(hits(f,'lesson.unfilled-body')[0]?.severity,'FAIL'); }
  for(const body of ['', 'Free form lesson', '**Why:** inline answer','**Why:**\nAnswer\n**How to apply:**\nAnswer']) { f.lesson({},body); assert.equal(hits(f,'lesson.unfilled-body').length,0); }
});
test('327 quick scope skips exactly repair checks and session repeats are capped sorted',t=> {
  const f=setup(t);
  f.put('topic.md','---\ndescription: Useful topic.\n---\n[Part](topic-1.md)\n');
  f.put('topic-1.md','---\ndescription: Useful part.\n---\n'+ '\uFFFD\u00e2\u20ac\u201d word ? word '+'x'.repeat(2001)+'\n');
  for(const [id,n] of [['001',2],['002',4],['003',6],['004',5]]) f.lesson({repeats:repeats(n)},'Body',id);
  const full=f.check().findings, quick=f.check({quick:true}).findings;
  assert.deepEqual([...new Set(full.filter(h=>!quick.some(q=>q.check===h.check&&q.file===h.file)).map(h=>h.check))].sort(),['chars.lost-dash','chars.mojibake','chars.replacement','split.chain','topic.line']);
  const r=f.cli('memory-check',['--session-start','--no-git']); assert.equal(r.status,0); assert.match(r.stdout,/^repeats: #003 \(6, no decision; FAIL\), #004 \(5, no decision; FAIL\), #002 \(4, no decision; FAIL\)$/m);
});
test('327 recall weighted kind trigger memoryOnly and CLI kind filter',t=> {
  const f=setup(t); f.lesson({kind:'practice',trigger:'quartz'},'Body'); f.lesson({kind:'mistake',trigger:'quartz'},'Body','002');
  f.put('brain/10-reference/topic.md','---\nid: ref-topic\ntype: reference\nsummary: quartz\n---\nquartz',f.repo);
  const all=buildCorpus(f), mem=buildCorpus({...f,memoryOnly:true}); assert.ok(all.length>mem.length); assert.equal(mem.length,2); assert.equal(mem[0].kind,'practice'); assert.equal(mem[0].terms.get('quartz'),2); assert.equal(mem[0].terms.get('practic'),1);
  const r=f.cli('memory-recall',['quartz','--kind','practice','--json']); assert.equal(r.status,0); const results=JSON.parse(r.stdout); assert.equal(results.length,1); assert.match(results[0].path,/001/);
  assert.equal(f.cli('memory-recall',['quartz','--kind','bad']).status,1);
});
test('327 measurement repeat totals months causes and readable output',t=> {
  const f=setup(t); f.lesson({repeats:['2026-09-30 slip: one',`${today} not-recalled: two`,`${today} legacy: three`]});
  const probesFile=f.put('probes.json',JSON.stringify({version:1,minPass:0,probes:[]}),f.root);
  const m=measure({...f,probesFile,noGit:true}); assert.equal(m.forgetting.repeats,3); assert.deepEqual(m.forgetting.repeatsPerMonth,{'2026-09':1,'2026-10':2}); assert.deepEqual(m.forgetting.repeatsByCause,{slip:1,'not-recalled':1,legacy:1}); assert.match(readable(m),/0 corrections; 3 repeats/);
});
test('327 real batch gate fourth repeat fails but retains repeat and created lesson',t=> {
  const f=setup(t); f.lesson({repeats:repeats(3),trigger:'before testing'});
  f.put('MEMORY.md','# Memory\n- [Craft](INDEX-craft.md) OPEN BEFORE testing.\n'); f.put('INDEX-craft.md','# Craft\n'); f.config.pins['INDEX-craft.md']=1024;
  const batch=f.put('batch.md','## Repeat\nrepeat-of: 1\ncause: slip\ndescription: Fourth repeat.\n\n## Created\nkind: practice\nroute: craft\ndescription: Useful verification advice.\n\nApply the rule.\n',f.root);
  const r=f.cli('memory-lesson',['batch',batch,'--json']); assert.equal(r.status,1); const result=JSON.parse(r.stdout); assert.equal(result.repeated[0].repeats,4); assert.equal(result.created.length,1); assert.ok(result.findings.some(h=>h.check==='lesson.enforce'&&h.severity==='FAIL')); assert.equal(parseFrontmatter(fs.readFileSync(path.join(f.memoryDir,'lesson-001-example.md'),'utf8')).data.metadata.repeats.length,4);
});
test('327 largest session fixture runtime and missing-key compatibility',t=> {
  const f=setup(t); for(let n=1;n<=340;n++) f.lesson({},'Body',String(n).padStart(3,'0'));
  const started=performance.now(), r=f.cli('memory-check',['--session-start','--no-git']); assert.equal(r.status,0); assert.doesNotMatch(r.stdout,/memory gate: error/); console.log(`327 session-start: 340 lessons, ${Math.round(performance.now()-started)} ms`);
});


test('session CLI quick scope and counts exclude repair checks', t => {
  const f=setup(t);
  f.put('topic.md','---\ndescription: Useful topic.\n---\n[Part](topic-1.md)\n');
  f.put('topic-1.md','---\ndescription: Useful part.\n---\n\uFFFD'+'x'.repeat(2001)+'\n');
  const full=f.cli('memory-check',['--no-git','--json']);
  const quick=f.cli('memory-check',['--no-git','--session-start']);
  const findings=JSON.parse(full.stdout).findings;
  for(const id of ['chars.replacement','split.chain','topic.line']) assert.ok(findings.some(h=>h.check===id));
  const expected=f.check({quick:true,scope:'all'}).findings.filter(h=>!h.allowed&&h.severity==='WARN').length;
  assert.equal(quick.status,0); assert.match(quick.stdout,new RegExp(`^memory gate: ok \\(0 allowed, ${expected} warn, engine .+\\)\\n$`));
});
test('generated pages and brain nodes exclude chars with exact decode message',t=> {
  const f=setup(t), damage='\u00e2\u20ac\u201d';
  f.put('INDEX-test.md','<!-- generated by memory-index.mjs; edit the lessons, not this file -->\n'+damage);
  f.put('brain/10-reference/topic.md','---\nid: ref-topic\ntype: reference\nsummary: Example\n---\n'+damage,f.repo);
  assert.deepEqual(hits(f,'chars.mojibake',{scope:'all'}),[]);
  f.lesson({},damage);
  assert.equal(hits(f,'chars.mojibake')[0].message,'1 line(s) with mojibake, first at line 11; first decodes to U+2014 EM DASH');
});
test('invalid decisions use all repeat thresholds including deleted hooks',t=> {
  const f=setup(t); f.put('deleted.mjs','',f.repo); fs.unlinkSync(path.join(f.repo,'deleted.mjs'));
  for(const enforced of ['x',`${today} hook scripts/memory/missing.json`,`${today} hook deleted.mjs`]) for(const [n,severity] of [[2,'WARN'],[4,'FAIL']]) {
    f.lesson({enforced,repeats:repeats(n)});
    assert.equal(hits(f,'lesson.enforce')[0]?.severity,severity);
    assert.equal(hits(f,'lesson.enforced')[0]?.severity,'WARN');
  }
});
test('both rules paths require lesson references and existing outside targets warn',async t=> {
  const f=setup(t); f.config.caps.guard={kitRules:'kit.json',rules:'host.json'};
  for(const file of ['kit.json','host.json']) f.put(file,JSON.stringify({version:1,rules:[]}),f.repo);
  for(const file of ['kit.json','host.json']) {
    f.lesson({enforced:`${today} hook ${file}`});
    assert.equal(hits(f,'enforce.rules')[0]?.message,`rules file ${file}: lesson enforced by hook ${file} but no rule names #001`);
  }
  const outside=f.put('outside.mjs','',f.root);
  for(const kind of ['hook','check']) { f.lesson({enforced:`${today} ${kind} ${outside}`}); assert.equal(hits(f,'lesson.enforced')[0]?.severity,'WARN'); }
  await t.test('symlink containment',st=> {
    try { fs.symlinkSync(outside,path.join(f.repo,'linked.mjs')); } catch(e) { if(['EPERM','EACCES','ENOTSUP'].includes(e.code)) return st.skip(`symlinks unavailable: ${e.code}`); throw e; }
    f.lesson({enforced:`${today} hook linked.mjs`}); assert.equal(hits(f,'lesson.enforced')[0]?.severity,'WARN');
  });
});
test('stale allows suppressed only for quick skipped checks',t=> {
  const f=setup(t);
  f.config.allow=['chars.mojibake','chars.replacement','chars.lost-dash','topic.line','split.chain'].map(check=>({check,file:'absent.md',reason:'fixture',added:today}));
  assert.equal(hits(f,'config.allow-stale',{quick:true}).length,0);
  assert.equal(hits(f,'config.allow-stale').length,5);
  const r=f.cli('memory-check',['--session-start','--no-git']); assert.equal(r.status,0); assert.match(r.stdout,new RegExp(`0 allowed, ${f.check({quick:true,scope:'all'}).findings.filter(h=>!h.allowed&&h.severity==='WARN').length} warn`));
});
test('session repeats after decision and allowed findings excluded',t=> {
  const f=setup(t); f.lesson({enforced:'2026-10-26 check topic.size',repeats:repeats(4)});
  let r=f.cli('memory-check',['--session-start','--no-git']); assert.match(r.stdout,/^repeats: #001 \(4, after decision; FAIL\)$/m);
  f.config.allow=[{check:'lesson.enforce',file:'lesson-001-example.md',reason:'fixture',added:today}];
  r=f.cli('memory-check',['--session-start','--no-git']); assert.doesNotMatch(r.stdout,/^repeats:/m); assert.match(r.stdout,/1 allowed/);
});
test('missing kit rules warn only with installed guard hook',t=> {
  const f=setup(t); f.config.caps.guard={kitRules:'scripts/memory/missing.json'};
  assert.equal(hits(f,'enforce.rules').length,0);
  f.put('.claude/settings.json',JSON.stringify({hooks:{PreToolUse:[{hooks:[{type:'command',command:'node scripts/memory/memory-guard.mjs pretooluse'}]}]}}),f.repo);
  assert.deepEqual(hits(f,'enforce.rules').map(h=>[h.severity,h.file,h.message]),[['WARN','scripts/memory/missing.json','rules file scripts/memory/missing.json is missing; the command guard has no kit rules; run upgrade']]);
  assert.equal(hits(f,'enforce.rules',{repo:undefined}).length,0);
});
test('rules problems distinct and repo relative',t=> {
  const f=setup(t); f.config.caps.guard={kitRules:'kit.json',rules:'host.json'};
  const rule={id:'sample',action:'warn',pattern:'hazard',message:'Use a file.'};
  for(const file of ['kit.json','host.json']) f.put(file,JSON.stringify({version:1,rules:[rule,rule,rule]}),f.repo);
  assert.deepEqual(hits(f,'enforce.rules').map(h=>h.message).sort(),['rules file host.json: rules must have unique ids: sample','rules file kit.json: rules must have unique ids: sample']);
  for(const file of ['kit.json','host.json']) f.put(file,'{',f.repo);
  let parseError;
  try { JSON.parse('{'); } catch(error) { parseError=error.message.replace(/[\r\n]+/g,' '); }
  for(const h of hits(f,'enforce.rules')) { assert.equal(h.message,`rules file ${h.file} is not valid JSON: ${parseError}`); assert.ok(!h.message.includes(f.repo)); }
});
for(const [key,fallback] of [['topic.warnLineChars',2000],['lesson.enforceAfterRepeats',2],['lesson.failAfterRepeats',4],['lesson.lessonOnlyReturns',true],['guard.kitRules','scripts/memory/enforce-rules.kit.json'],['guard.rules','scripts/memory/enforce-rules.json'],['router.warnLines',150],['router.failLines',200]]) test(`config.caps validates ${key} and applies default`,t=> {
  const f=setup(t), [group,name]=key.split('.');
  f.put('MEMORY.md',Array(key==='router.warnLines'?151:201).fill('x').join('\n'));
  f.put('topic.md','---\ndescription: Useful topic.\n---\n'+'x'.repeat(2001));
  f.lesson({repeats:repeats(4)}); f.lesson({repeats:repeats(2)},'Body','002');
  f.lesson({enforced:'2026-10-26 lesson-only deliberate judgment',repeats:repeats(1)},'Body','003');
  if(group==='guard') f.put(fallback,JSON.stringify({version:1,rules:[{id:'default-rule',action:'warn',pattern:'hazard',message:'Use a file.',lesson:'999'}]}),f.repo);
  f.config.caps[group]??={};
  f.config.caps[group][name]=fallback;
  const expected=f.check().findings;
  const values=group==='guard'?[0,-5,1.5,null,'','   ',false]:['2000',0,-5,1.5,'abc',null];
  for(const value of values) {
    f.config.caps[group][name]=value;
    const result=f.check();
    assert.deepEqual(result.findings.filter(h=>h.check!=='config.caps'),expected);
    assert.deepEqual(result.findings.filter(h=>h.check==='config.caps').map(h=>[h.severity,h.file,h.message]),[['FAIL','memory.config.json',`caps.${key} has invalid value ${JSON.stringify(value)}; using default ${JSON.stringify(fallback)}`]]);
    const r=f.cli('memory-check',['--no-git','--scope','memory']); assert.equal(r.status,1); assert.match(r.stdout,/FAIL config\.caps/); assert.doesNotMatch(r.stdout,/memory-check: error/);
  }
});


test('every new lesson message is verbatim at its threshold',t=> {
  const f=setup(t);
  const message=(id)=>hits(f,id)[0]?.message;
  f.lesson({repeats:repeats(2)});
  assert.equal(message('lesson.enforce'),'repeated 2 times (last 2026-10-27); decide where the mistake is visible: in the command (hook), in a file (check), or only in judgment (hard-rule card or lesson-only), then run memory-lesson.mjs enforce 001 "<hook|check|hard-rule|lesson-only> <where>"');
  assert.equal(message('lesson.trigger'),'repeated lesson has no trigger; add metadata.trigger ("before ..." or "when ...")');
  f.lesson({repeats:repeats(4)});
  assert.equal(message('lesson.enforce'),'repeated 4 times with no recorded decision; record one with memory-lesson.mjs enforce 001 "<hook|check|hard-rule|lesson-only> <where>" (lesson-only with a reason counts)');
  for(const n of [1,4]) {
    f.lesson({enforced:'2026-10-26 lesson-only deliberate judgment',repeats:repeats(n)});
    assert.equal(message('lesson.enforce'),`repeated ${n} times after the lesson-only decision on 2026-10-26; decide again: enforce it or record lesson-only anew`);
    assert.equal(hits(f,'lesson.enforce')[0].severity,n===4?'FAIL':'WARN');
  }
  f.lesson({enforced:'2026-10-26 check topic.size',repeats:repeats(1)});
  assert.equal(message('lesson.enforce'),'repeated 1 times after the decision on 2026-10-26 (check topic.size); decide again');
  f.lesson({enforced:'x',kind:'wrong',repeats:['bad']},'**Why:**');
  assert.equal(message('lesson.enforced'),'enforced must name a valid date and hard-rule card, check, repo hook file or lesson-only reason of at least 10 characters');
  assert.equal(message('lesson.kind'),'kind "wrong" is not mistake, practice or observation');
  assert.equal(message('lesson.repeats'),'repeat entries must read "YYYY-MM-DD <slip|not-recalled|rule-wrong|new-case|legacy>: note", at most 200 characters');
  assert.equal(message('lesson.unfilled-body'),'fill the empty **Why:** / **How to apply:** section');
  const p=f.lesson(); fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('  kind: "mistake"\n',''));
  assert.equal(message('lesson.kind-missing'),'1 lessons have no metadata.kind; classify them with memory-lesson.mjs classify FILE --write');
  f.lesson({date:'2026-10-29'}); assert.equal(message('date.future'),'date 2026-10-29 is later than today (2026-10-27)');
});
test('router chain line and character messages verbatim',t=> {
  const f=setup(t);
  for(const [n,word,cap] of [[151,'warn',150],[201,'max',200]]) {
    f.put('MEMORY.md',Array(n).fill('x').join('\n'));
    assert.equal(hits(f,'router.lines')[0]?.message,`${n} lines (${word} ${cap}; Claude Code loads only the first 200 lines of MEMORY.md)`);
  }
  f.put('topic.md','---\ndescription: Useful topic.\n---\n[Part](topic-1.md)\n');
  f.put('topic-1.md','---\ndescription: Useful part.\n---\n'+'x'.repeat(2001));
  assert.equal(hits(f,'split.chain')[0]?.message,'1 split-chain problems (back links, numbering, parent order); run memory-chains.mjs scan, then repair --write');
  assert.equal(hits(f,'topic.line')[0]?.message,'1 lines over 2000 characters (0 repairable), first at line 4; memory-chains.mjs lines --write recuts paragraphs; list items and lines without a sentence end need a hand cut');
  f.lesson({},'\uFFFD word ? word');
  assert.equal(hits(f,'chars.replacement')[0]?.message,'1 line(s) with U+FFFD REPLACEMENT CHARACTER, first at line 11');
  assert.equal(hits(f,'chars.lost-dash')[0]?.message,'1 line(s) with a possible lost dash (U+003F QUESTION MARK), first at line 11');
  f.lesson({},'\u00e2\u20ac'); assert.equal(hits(f,'chars.mojibake')[0]?.message,'1 line(s) with mojibake, first at line 11; undecodable');
});
test('enforce.rules validation messages verbatim',t=> {
  const f=setup(t); f.config.caps.guard={kitRules:'kit.json',rules:'host.json'};
  const rule={id:'sample',action:'warn',pattern:'hazard',message:'Use a file.'};
  const cases=[
    [{version:2,rules:[]},'rules file requires version 1 and a rules array'],
    [{version:1,rules:[{...rule,id:'BAD'}]},'rule id must match ^[a-z][a-z0-9-]*$'],
    ...[[{action:'bad'},'action must be deny, warn or off'],[{tools:['Other']},'tools must be Bash or PowerShell'],[{message:''},'message must be 1-200 characters on one line'],[{lesson:3},'lesson must be a string or array of lesson identities'],[{lesson:'999'},'lesson #999 not found'],[{pattern:3},'pattern must be a string'],[{pattern:'.*'},'pattern matches the empty string'],[{unless:'.*'},'unless matches the empty string'],[{unless:3},'unless must be a string'],[{pattern:'['},'pattern does not compile: Invalid regular expression: /[/: Unterminated character class'],[{unless:'['},'unless does not compile: Invalid regular expression: /[/: Unterminated character class']].map(([override,msg])=>[{version:1,rules:[{...rule,...override}]},'rule sample: '+msg]),
  ];
  for(const file of ['kit.json','host.json']) for(const [data,reason] of cases) {
    for(const name of ['kit.json','host.json']) f.put(name,JSON.stringify({version:1,rules:[]}),f.repo);
    f.put(file,JSON.stringify(data),f.repo);
    assert.deepEqual(hits(f,'enforce.rules').map(h=>h.message),[`rules file ${file}: ${reason}`]);
  }
});


test('full gate reads each topic once for chain line and chars scans',t=> {
  const f=setup(t);
  f.put('topic.md','---\ndescription: Useful topic.\n---\n[Part](topic-1.md)\n');
  const part=f.put('topic-1.md','---\ndescription: Useful part.\n---\n\uFFFD'+'x'.repeat(2001)+'\n');
  const original=fs.readFileSync; let reads=0;
  fs.readFileSync=function(file,...args) { if(typeof file==='string' && path.resolve(file)===part) reads++; return original.call(this,file,...args); };
  let result;
  try { result=f.check(); } finally { fs.readFileSync=original; }
  for(const check of ['split.chain','topic.line','chars.replacement']) assert.ok(result.findings.some(h=>h.check===check));
  assert.equal(reads,1,'the loaded topic serves all three scans');
});

test('junction containment rejects outside hook targets', t => {
  const f=setup(t);
  const outside=path.join(f.root,'outside');
  f.put('hook.mjs','',outside);
  fs.symlinkSync(outside,path.join(f.repo,'linked'),'junction');
  f.lesson({enforced:`${today} hook linked/hook.mjs`,repeats:repeats(4)});
  assert.equal(hits(f,'lesson.enforced')[0]?.severity,'WARN');
  assert.equal(hits(f,'lesson.enforce')[0]?.severity,'FAIL');
});

test('rules JSON message retains parse error', t => {
  const f=setup(t); f.config.caps.guard={kitRules:'kit.json',rules:'host.json'};
  let reason;
  try { JSON.parse('{'); } catch(error) { reason=error.message.replace(/[\r\n]+/g,' '); }
  for(const file of ['kit.json','host.json']) {
    for(const name of ['kit.json','host.json']) f.put(name,JSON.stringify({version:1,rules:[]}),f.repo);
    f.put(file,'{',f.repo);
    assert.deepEqual(hits(f,'enforce.rules').map(h=>[h.severity,h.file,h.message]),[['FAIL',file,`rules file ${file} is not valid JSON: ${reason}`]]);
  }
});

test('rules read error has one relative prefix', t => {
  const f=setup(t); f.config.caps.guard={kitRules:'kit.json',rules:'host.json'};
  for(const file of ['kit.json','host.json']) f.put(file,JSON.stringify({version:1,rules:[]}),f.repo);
  const original=fs.readFileSync;
  for(const file of ['kit.json','host.json']) {
    const target=path.join(f.repo,file);
    fs.readFileSync=function(p,...args) {
      if(p===target) throw Object.assign(new Error(`EACCES: permission denied, open '${target}'`),{code:'EACCES'});
      return original.call(this,p,...args);
    };
    try {
      assert.deepEqual(hits(f,'enforce.rules').map(h=>[h.severity,h.file,h.message]),[['FAIL',file,`rules file ${file} is not valid JSON: EACCES: permission denied, open '${file}'`]]);
    } finally { fs.readFileSync=original; }
  }
});
