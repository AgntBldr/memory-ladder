import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fixture,ok,put,read,json,kitRoot,bump} from './helpers.mjs';
import {hostSnapshot,installReport,checkMemoryRouter,instructions} from '../scripts/install-safety.mjs';
import {routerFamilies} from '../engine/memory-index.mjs';
import {runCheck} from '../engine/memory-check.mjs';
import {mainWorktree,memorySlug} from '../engine/lib.mjs';
import {fleet} from '../engine/memory-fleet.mjs';
import {migrateRoutes} from '../engine/memory-migrate.mjs';
const cfg=()=>json(path.join(kitRoot,'engine/memory.config.json'));
test('release version and log hygiene',()=>{
 assert.equal(read(path.join(kitRoot,'VERSION')).trim(),'3.2.11');
 assert.equal(cfg().engine_version,'3.2.11');
});
test('log hygiene',()=>{
 assert.ok(!fs.readdirSync(path.join(kitRoot,'tests')).some(n=>/^round4-.*\.log$/.test(n)));
 assert.match(read(path.join(kitRoot,'.gitignore')),/^tests\/\*\.log$/m);
});
test('snapshot never reads unrelated large or locked files',t=>{
 const f=fixture(t), unrelated=put(path.join(f.target,'large.bin'),Buffer.alloc(1024*1024)), wanted=path.join(f.target,'AGENTS.md');
 for(const method of ['readFileSync','openSync']) {const original=fs[method];t.mock.method(fs,method,(file,...args)=>{assert.notEqual(file,unrelated,'unrelated file read');return original(file,...args);});}
 const before=hostSnapshot(f.target,[wanted]);assert.equal(before.size,1);assert.equal(before.get('AGENTS.md').size,0);assert.match(before.get('AGENTS.md').hash,/^[a-f0-9]{64}$/);
 assert.doesNotThrow(()=>installReport(f.target,before));
});
test('snapshot records read errors without throwing from report',t=>{
 const f=fixture(t), file=path.join(f.target,'AGENTS.md'), before=hostSnapshot(f.target,[file]), original=fs.openSync;
 t.mock.method(fs,'openSync',(p,...args)=>{if(p===file) throw Object.assign(new Error('locked'),{code:'EBUSY'});return original(p,...args);});
 const lines=[];t.mock.method(console,'log',x=>lines.push(x));assert.doesNotThrow(()=>installReport(f.target,before));assert.match(lines.join('\n'),/AGENTS.md.*EBUSY/);
});
for(const kind of ['hard','symbolic']) test(`${kind} linked instructions written once`,t=>{
 const f=fixture(t), a=path.join(f.target,'AGENTS.md'), c=path.join(f.target,'CLAUDE.md');put(a,'# Host\n');
 try {if(kind==='hard') fs.linkSync(a,c);else fs.symlinkSync(a,c,'file');}catch(e){if(kind==='symbolic'&&['EPERM','EACCES','ENOSYS'].includes(e.code)){t.skip('OS does not permit file symlinks: '+e.code);return;}throw e;}
 ok(f.install());assert.match(read(a),/## Memory gate/);assert.doesNotMatch(read(a),/@AGENTS.md/);assert.equal(read(a),read(c));
});
for(const row of ['- **OPEN BEFORE verifying:** [INDEX-v.md](INDEX-v.md)','Verification: [INDEX-v.md](INDEX-v.md)','| Verification | [INDEX-v.md](INDEX-v.md) |','- Verification: `INDEX-v.md`']) test('routing '+row,t=>{
 const f=fixture(t);put(path.join(f.memory,'INDEX-v.md'),'# V\n');assert.ok(routerFamilies(row,f.memory).has('v'));
 assert.equal(routerFamilies('State (v: [index](INDEX-v.md)) — current-state is the truth.',f.memory).size,0);
});
for(const divergent of [false,true]) test(`upgrade mirror divergent=${divergent}`,t=>{
 const f=fixture(t);ok(f.install());const canonical=path.join(f.target,'.claude/skills/memory-ladder/SKILL.md'), mirror=put(path.join(f.target,'.agents/skills/memory-ladder/SKILL.md'),divergent?'# Local\n':read(canonical)), next=bump(f);
 const out=ok(f.cli('scripts/upgrade.mjs',['--target',f.target],next)).stdout;
 if(divergent){assert.equal(read(mirror),'# Local\n');assert.match(out,/mirror.*(?:differs|divergent|skipped)/);}else {assert.equal(read(mirror),read(canonical));assert.match(out,/mirror updated/);}
});
test('fleet safe git arguments and kit gate by default',t=>{
 const f=fixture(t), home=path.join(f.root,'memories'), memory=path.join(home,memorySlug(f.target),'memory');put(path.join(memory,'MEMORY.md'),'# Memory\n');
 const projectGate=put(path.join(f.target,'scripts/memory/memory-check.mjs'),'throw new Error("project executed");');
 const config=cfg();config.caps.router.failBytes=1;put(path.join(f.target,'scripts/memory/memory.config.json'),JSON.stringify(config));
 const calls=[], original=childProcess.spawnSync;t.mock.method(childProcess,'spawnSync',(cmd,args,opts)=>{calls.push([cmd,args]);return original(cmd,args,opts);});syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
 const row=fleet({roots:[f.root],memoryHome:home,localFile:path.join(f.root,'absent')}).projects.find(p=>p.project===f.target);
 assert.equal(row.gate.source,'kit gate');assert.ok(row.gate.FAIL>0,'project config used');assert.ok(!calls.some(([,args])=>args.includes(projectGate)));
 for(const [cmd,args] of calls.filter(([cmd])=>cmd==='git')) {assert.ok(args.includes('core.fsmonitor=false'));assert.ok(args.includes('log.showSignature=false'));assert.ok(!args.some(x=>x.startsWith('safe.directory=')));}
});
test('handwritten all index kept during install',t=>{
 const f=fixture(t);put(path.join(f.target,'brain/01-pillars/pil-example.md'),'---\nid: pil-example\ntype: pillar\nsummary: Example\n---\n');const file=put(path.join(f.target,'brain/00-system/index-all.md'),'# Handwritten all\n');
 const out=ok(f.install()).stdout;assert.equal(read(file),'# Handwritten all\n');assert.match(out,/kept hand-written index:.*index-all.md/);assert.match(read(path.join(f.target,'brain/00-system/index-all-generated.md')),/Static index/);
});
test('fleet status never executes clean filters',t=>{
 const f=fixture(t), home=path.join(f.root,'memories'),memory=path.join(home,memorySlug(f.target),'memory'), marker=path.join(f.root,'filter-ran');
 put(path.join(memory,'MEMORY.md'),'# Memory\n');f.git(memory,'init');f.git(memory,'add','.');f.git(memory,'commit','-m','fixture');
 put(path.join(f.target,'sample.data'),'before\n');f.git(f.target,'add','.');f.git(f.target,'commit','-m','fixture');
 const script=put(path.join(f.root,'filter.mjs'),`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'ran');process.stdin.pipe(process.stdout);`);
 put(path.join(f.target,'.gitattributes'),'*.data filter=probe\n');f.git(f.target,'config','filter.probe.clean',`node "${script.replaceAll('\\','/')}"`);put(path.join(f.target,'sample.data'),'after!\n');
 fleet({roots:[f.root],memoryHome:home,localFile:path.join(f.root,'absent')});assert.ok(!fs.existsSync(marker),'project clean filter ran');
});
test('installed selftest ignores host config local and environment',t=>{
 const f=fixture(t);ok(f.install());const config=cfg();config.caps.roadmap.path='roadmap.md';config.caps.router.failLineChars=1200;config.brain={dir:'custom-brain'};
 put(path.join(f.target,'scripts/memory/memory.config.json'),JSON.stringify(config));put(path.join(f.target,'scripts/memory/KIT.local.json'),'{"memoryDir":"host-only"}');
 const env={...f.env,CLAUDE_MEMORY_DIR:path.join(f.root,'host-env')};delete env.NODE_TEST_CONTEXT; const r=f.exec(process.execPath,['--test',path.join(f.target,'scripts/memory/memory.selftest.mjs')],{env,timeout:120000});assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/# tests 385/);
});
test('resolved environment memory accepted',t=>{const f=fixture(t), dir=path.join(f.target,'.claude/memory');put(path.join(dir,'MEMORY.md'),'# Memory');assert.doesNotThrow(()=>checkMemoryRouter(f.target,{dir},{},instructions(f.target)));});
test('bare first worktree keeps current checkout',t=>{const f=fixture(t), bare=path.join(f.root,'bare.git'), wt=path.join(f.root,'checkout');f.git(f.target,'add','.');f.git(f.target,'commit','-m','fixture');f.git(f.root,'clone','--bare',f.target,bare);f.git(bare,'worktree','add',wt);assert.equal(mainWorktree(wt),wt);});
test('missing ledger warns malformed fails',t=>{const f=fixture(t);put(path.join(f.memory,'MEMORY.md'),'# Memory');const file=path.join(f.root,'upgrades.json'),check=()=>runCheck({repo:f.target,memoryDir:f.memory,config:cfg(),noGit:true,upgradesFile:file}).findings.find(x=>x.check==='config.upgrades');assert.equal(check().severity,'WARN');put(file,'{');assert.equal(check().severity,'FAIL');});
for(const source of ['CLAUDE.local.md','.claude/rules/memory.md','existence']) test('router discovery '+source,t=>{const f=fixture(t);const folder=source==='existence'?'memory':'notes';put(path.join(f.target,folder,'MEMORY.md'),'# Memory');if(source!=='existence')put(path.join(f.target,source),'Router: notes/MEMORY.md\n');const r=f.install(['--dry-run']);assert.equal(r.status,1);assert.match(r.stderr,/in-repo memory router/);});
test('prose without router does not refuse',t=>{const f=fixture(t);put(path.join(f.target,'AGENTS.md'),'Memory is in-repo: notes is a planned folder.\n');ok(f.install(['--dry-run']));});
test('independent CLAUDE import reported',t=>{const f=fixture(t);put(path.join(f.target,'CLAUDE.md'),'# Independent instructions\n');assert.match(ok(f.install()).stdout,/^CLAUDE.md now imports AGENTS.md$/m);});
test('submodule is not a worktree',t=>{const f=fixture(t), source=path.join(f.root,'source');fs.mkdirSync(source);f.git(source,'init');put(path.join(source,'README.md'),'source');f.git(source,'add','.');f.git(source,'commit','-m','fixture');f.git(f.target,'-c','protocol.file.allow=always','submodule','add',source,'child');const row=fleet({roots:[f.root],memoryHome:path.join(f.root,'none'),localFile:path.join(f.root,'absent')}).projects.find(p=>p.project===path.join(f.target,'child'));assert.equal(row.status,`submodule of ${f.target}`);});
test('merged row takes wrapped continuation with it',t=>{const f=fixture(t);put(path.join(f.memory,'MEMORY.md'),'- [V](INDEX-v.md) OPEN BEFORE verifying.\n- [More](INDEX-v-2.md) OPEN BEFORE testing.\n  Keep the wrapped condition with this row.\n');for(const name of ['INDEX-v.md','INDEX-v-2.md'])put(path.join(f.memory,name),'# Index\n');migrateRoutes({repo:f.target,memoryDir:f.memory,config:cfg(),write:true,probesFile:path.join(f.root,'absent')});assert.doesNotMatch(read(path.join(f.memory,'MEMORY.md')),/wrapped condition/);assert.match(read(path.join(f.memory,'index-notes-v.md')),/More.*\n  Keep the wrapped condition/);});
