import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {capText} from '../engine/session-core.mjs';
import {QUICK_SAFE, FULL_SAFE, NEXT} from '../engine/handover.mjs';
const source=fs.readFileSync(new URL('../engine/handover.mjs',import.meta.url),'utf8');
let openFiles=[{file:'src/one.mjs'},{file:'docs/two.md'}];
// Exercise the actual report body with bounded, deterministic Git and output dependencies.
const report=Function('capText','bytes','singleLine','maybeGit','status','capped','redact','QUICK_SAFE','FULL_SAFE','NEXT',
  source.slice(source.indexOf('function backtickRun('),source.indexOf('// Dependencies permit'))+'return report;')(
  capText,Buffer.byteLength,s=>String(s).replace(/[\r\n]/g,' '),()=> '1234567',()=>openFiles,s=>s,s=>s,QUICK_SAFE,FULL_SAFE,NEXT);
const long='x'.repeat(2000);
function context(extra={}) {return {repo:long,branch:long,sha:'1234567',command:long,quick:false,time:'2026-11-03 12:00',digest:'dddddddddddd',seq:'000001',data:{question:long},lessons:long.slice(0,400),close:long,gate:{FAIL:9,WARN:9},gateFailures:[long,long],waiting:[long,long,long],config:{caps:{roadmapOverview:{path:'overview.md'},brainIndex:{path:'index.md',allPath:'all.md'}}},holder:'.',written:true,dirty:[],...extra};}
for(const quick of [false,true]) for(const failed of [false,true]) for(const baseline of [false,true]) test(`report reserve quick=${quick} failed=${failed} baseline=${baseline}`,()=>{
  const ctx=context({quick,...(baseline?{}:{over:'dddddddddddd'})});
  const failures=failed?[long,long,long]:[];
  const out=report(ctx,failures,{text:long,verdict:'roadmap current, log not checked (no brain)'},{pushed:!failed});
  assert.ok(Buffer.byteLength(out)<=1536,Buffer.byteLength(out));
  assert.match(out,/\n\n(?:NOT )?SAFE TO COMPACT[^\n]*\n\nNext:/);
  assert.ok(out.includes(failed?'Next: fix the cause named in the verdict, then run the re-run line below; if there is none, run /handover again.':NEXT));
  if(baseline) assert.ok(out.endsWith('\n\ntoken baseline: run began (no --over supplied).\n'));
  if(failed) assert.doesNotMatch(out,/new conversation/);
});
test('parallel allowance includes bullet and fence and retains the base report',()=>{
  const ctx=context({warning:true,otherTime:'11:59',replaced:'## CURRENT\n'+long.repeat(3)});
  const out=report(ctx,[long,long,long],{text:long},{pushed:false});
  const bullet=out.match(/^- warning:.*\n/m)[0],block=out.match(/\n```text\n[\s\S]*\n```\n/)[0];
  assert.ok(Buffer.byteLength(bullet+block)<=2048);
  assert.ok(Buffer.byteLength(out.replace(bullet,'').replace(block,''))<=1536);
  assert.ok(out.indexOf(block)>out.indexOf('Next:'));
  assert.ok(out.includes(bullet+'- lessons:'));
});
test('open files are individually code formatted',()=>{
  const out=report(context({repo:'.',branch:'main',command:'git status',lessons:'none',close:'none',gateFailures:[],waiting:[],data:{question:'next?'}}),[],{text:'skipped',verdict:'roadmap current'},{pushed:true});
  assert.ok(out.includes('(`src/one.mjs`, `docs/two.md`)'));
});

test('parallel fence contains handwritten backticks and strips trailing blank lines',()=>{
  const ctx=context({warning:true,otherTime:'11:59',replaced:'## CURRENT\n```\nhandwritten\n\n\n'});
  const out=report(ctx,[],{text:'skipped',verdict:'current'},{pushed:true});
  assert.ok(out.includes('\n````text\n## CURRENT\n```\nhandwritten\n````\n'));
});
test('code spans preserve Windows paths and backtick runs exactly',()=>{
  const span=Function(source.slice(source.indexOf('function backtickRun('),source.indexOf('function report('))+'return codeSpan;')();
  assert.equal(span('C:\\work\\x\\.claude\\_in.json'),'`C:\\work\\x\\.claude\\_in.json`');
  assert.equal(span('a`b'),'``a`b``');
  assert.equal(span('`a``'),'``` `a`` ```');
  assert.equal(span('a``b'),'```a``b```');
  const ctx=context({repo:'C:\\work\\_repo`',branch:'main',command:'git status',lessons:'none',close:'none',gateFailures:[],waiting:[],data:{question:'next?'}});
  assert.ok(report(ctx,[],{text:'skipped',verdict:'current'},{pushed:true}).startsWith('- `` C:\\work\\_repo` `` |'));
  const saved=openFiles;openFiles=[{file:'`odd``'}, {file:'C:\\work\\_file'}];
  try {
    const out=report(ctx,[],{text:'skipped',verdict:'current'},{pushed:true});
    assert.ok(out.includes('(``` `odd`` ```, `C:\\work\\_file`)'));
  } finally {openFiles=saved;}
});
