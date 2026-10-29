import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {fixture,put,read,json,ok,kitRoot} from './helpers.mjs';
import {parseFrontmatter} from '../engine/lib.mjs';
import {runCheck} from '../engine/memory-check.mjs';
import {migrateRoutes} from '../engine/memory-migrate.mjs';
import {withIgnores} from '../scripts/install.mjs';
import {hash} from '../scripts/manifest.mjs';
import {blocksSnapshot,blocksVerify} from '../engine/memory-conserve.mjs';
import {generateIndex,brainIndexPairs} from '../engine/brain-index.mjs';
import {generateOverview} from '../engine/roadmap-overview.mjs';
import {writeMemoryIndex} from '../engine/memory-index.mjs';
import {rotateLog} from '../engine/memory-rotate.mjs';
const config=()=>json(path.join(kitRoot,'engine/memory.config.json'));
test('strict installed skill frontmatter and legacy warning',t=>{
 const f=fixture(t);ok(f.install());
 for(const name of ['memory-ladder','memory-review']) {
  const file=path.join(f.target,'.claude/skills',name,'SKILL.md'),text=read(file),data=parseFrontmatter(text).data;
  assert.deepEqual(Object.keys(data).filter(k=>!['name','description','license','allowed-tools','metadata'].includes(k)),[]);
  assert.equal(data.metadata.engine_version,config().engine_version);
  put(file,text.replace(/metadata:\r?\n  engine_version:/,'engine_version:'));
 }
 const findings=runCheck({repo:f.target,memoryDir:f.memory,config:config()}).findings.filter(x=>x.check==='repo.skill-version');
 assert.equal(findings.length,2);assert.ok(findings.every(x=>x.severity==='WARN'&&/upgrade.*skill/i.test(x.message)));
});
for(const pattern of ['memory/','scripts/','']) test('ignore '+(pattern||'none'),t=>{
 const f=fixture(t);put(path.join(f.target,'.gitignore'),pattern+'\n');const r=f.install();
 if(pattern==='scripts/') {assert.notEqual(r.status,0);assert.match(r.stderr,/parent.*scripts|scripts.*parent/i);return;}
 ok(r);
 assert.equal(f.exec('git',['check-ignore','scripts/memory/lib.mjs']).status,1);
 if(pattern) {assert.match(read(path.join(f.target,'.gitignore')),/!\/scripts\/memory\//);assert.match(r.stdout,/\.gitignore:1:memory\//);}
});
test('no fix reports ignored files',t=>{
 const f=fixture(t);put(path.join(f.target,'.gitignore'),'memory/\n');const r=f.install(['--no-gitignore-fix']);
 assert.match(r.stdout+r.stderr,/\.gitignore:1:memory\//);assert.equal(read(path.join(f.target,'.gitignore')),'memory/\n');
});
for(const eol of ['\n','\r\n']) test('hand link labels '+JSON.stringify(eol),t=>{
 const f=fixture(t),body=['# Notes','','- [Precious label](topic.md)','- [[topic|Other label]]',''].join(eol);
 put(path.join(f.memory,'MEMORY.md'),'- [Work](INDEX-work.md) OPEN BEFORE work.'+eol);
 put(path.join(f.memory,'INDEX-work.md'),body);put(path.join(f.memory,'topic.md'),'---\nname: topic\ndescription: Topic\n---\nBody.\n');
 migrateRoutes({memoryDir:f.memory,config:config(),write:true});
 assert.ok(read(path.join(f.memory,'index-notes-work.md')).includes(body));
});
test('ignore append preserves CRLF',()=>{
 assert.equal(withIgnores('host\r\n').replace(/\r\n/g,'' ).includes('\n'),false);
});
test('same version legacy upgrade and identical mirrors',t=>{
 const f=fixture(t);ok(f.install());const manifestFile=path.join(f.target,'scripts/memory/MANIFEST.json'),manifest=json(manifestFile);
 for(const name of ['memory-ladder','memory-review']) {
  const rel='.claude/skills/'+name+'/SKILL.md',file=path.join(f.target,rel);
  const legacy=read(file).replace(/metadata:\r?\n  engine_version:/,'engine_version:').replace(/\r?\n/g,'\r\n');put(file,legacy);
  put(path.join(f.target,'.agents/skills',name,'SKILL.md'),legacy);manifest.files[rel]=hash(file);
 }
 put(manifestFile,JSON.stringify(manifest));ok(f.cli('scripts/upgrade.mjs',['--target',f.target]));
 for(const name of ['memory-ladder','memory-review']) {
  const text=read(path.join(f.target,'.claude/skills',name,'SKILL.md'));
  assert.ok(parseFrontmatter(text).data.metadata.engine_version);assert.ok(!text.replace(/\r\n/g,'').includes('\n'));
  assert.equal(read(path.join(f.target,'.agents/skills',name,'SKILL.md')),text);
 }
});
test('CRLF conserve blocks and generated checks',t=>{
 const f=fixture(t),cfg=config(),source=path.join(f.target,'source.md');
 put(source,'# Passage\n\n## Rule\nKeep this\n  continuation.\n');
 const baseline=blocksSnapshot({repo:f.target,sources:['source.md']});put(source,read(source).replace(/\n/g,'\r\n'));
 assert.ok(blocksVerify({repo:f.target,baseline,dests:['source.md']}).blocks.every(b=>b.status==='ok'));
 ok(f.install());
 put(path.join(f.target,'brain/test.md'),'---\nid: ref-test\ntype: reference\ntitle: Test\n---\nText.\n');
 const pairs=brainIndexPairs(f.target,cfg,generateIndex({repo:f.target,config:cfg})).pairs;
 for(const [file,text] of pairs) put(path.join(f.target,file),text.replace(/\r?\n/g,'\r\n'));
 assert.ok(!runCheck({repo:f.target,memoryDir:f.memory,config:cfg,noGit:true}).findings.some(f=>f.check==='repo.brain-index'&&/stale/.test(f.message)));
 const overview=path.join(f.target,cfg.caps.roadmapOverview.path);put(overview,generateOverview({repo:f.target,config:cfg}).replace(/\r?\n/g,'\r\n'));
 ok(f.cli('engine/roadmap-overview.mjs',['--repo',f.target,'--check']));
 for(const [file] of pairs) {ok(f.cli('engine/brain-index.mjs',['--repo',f.target,'--write']));assert.ok(!read(path.join(f.target,file)).replace(/\r\n/g,'').includes('\n'));}
 const index=path.join(f.memory,'INDEX-craft-sessions.md');
 if(fs.existsSync(index)) {put(index,read(index).replace(/\r?\n/g,'\r\n'));writeMemoryIndex({memoryDir:f.memory,config:cfg});assert.ok(!read(index).replace(/\r\n/g,'').includes('\n'));}
});
test('CRLF log retry recognizes an LF source passage',t=>{
 const f=fixture(t),cfg=config(),log=path.join(f.target,cfg.caps.brainLog.path),block='## [2026-10-01] First\nA passage\n  continued.\n';
 put(log,'# Log\n'+block+'## [2026-10-02] Second\nKeep.\n');
 const dest=path.join(path.dirname(log),'log-2026-10.md');put(dest,('# Archive\n'+block).replace(/\n/g,'\r\n'));
 rotateLog({repo:f.target,config:cfg,keep:1,write:true});
 assert.equal(read(dest).match(/A passage/g).length,1);assert.ok(!read(dest).replace(/\r\n/g,'').includes('\n'));
});
test('regenerated hook report contains both row texts',t=>{
 const f=fixture(t),before='- [My title](lesson-001-one.md) — Keep exact hook.';
 put(path.join(f.memory,'MEMORY.md'),'- [Work](INDEX-work.md) OPEN BEFORE work.\r\n');
 put(path.join(f.memory,'INDEX-work.md'),before+'\r\n');put(path.join(f.memory,'lesson-001-one.md'),'---\r\nname: one\r\ndescription: One\r\n---\r\nBody.\r\n');
 const r=migrateRoutes({memoryDir:f.memory,config:config(),write:true});
 assert.equal(r.regenerated[0].before,before);assert.equal(r.regenerated[0].reason,'regenerated as an index row');
 assert.ok(read(path.join(f.memory,'INDEX-work.md')).includes(r.regenerated[0].after));
 assert.ok(!read(path.join(f.memory,'INDEX-work.md')).replace(/\r\n/g,'').includes('\n'));
});
test('CRLF ORDER write proof rejects reordered notes and restores bytes',t=>{
 const f=fixture(t),body='# First\r\n- [Label](topic.md)\r\n# Last\r\n';
 put(path.join(f.memory,'MEMORY.md'),'- OPEN `INDEX-work.md` before work.\r\n');put(path.join(f.memory,'INDEX-work.md'),body);
 put(path.join(f.memory,'topic.md'),'---\r\nname: topic\r\ndescription: Topic\r\n---\r\nBody.\r\n');
 const original=fs.writeFileSync;let changed=false;
 t.mock.method(fs,'writeFileSync',(file,text,...args)=>{
  if(!changed&&path.basename(file)==='index-notes-work.md') {changed=true;text=String(text).replace('# First\r\n','').replace('# Last','# First\r\n# Last');}
  return original(file,text,...args);
 });
 assert.throws(()=>migrateRoutes({memoryDir:f.memory,config:config(),write:true}),/ORDER/);
 assert.equal(read(path.join(f.memory,'INDEX-work.md')),body);assert.ok(!fs.existsSync(path.join(f.memory,'index-notes-work.md')));
});
test('CRLF existing appended gate block is not duplicated',t=>{
 const f=fixture(t),agents=path.join(f.target,'AGENTS.md'),text='# Host\r\n\r\n## Memory gate\r\nKeep host instructions.\r\n';
 put(agents,text);ok(f.install());assert.equal(read(agents),text);
});
