import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {generateMemoryIndex} from '../engine/memory-index.mjs';
import {fixture,ok,tree,json,read,put,bump,hash,nextVersion,versionPattern,nextVersionPattern} from './helpers.mjs';

test('X1 upgrade refuses old manifest paths outside both kit folders before any writes',t=>{
  const f=fixture(t);ok(f.install());
  const sentinel=put(path.join(f.root,'outside.txt'),'sentinel');
  const file=path.join(f.target,'scripts/memory/MANIFEST.json'),original=json(file);
  for(const kind of ['traversal','absolute','project-file','engine-escape','skill-escape']) {
    const key=kind==='traversal'?'../../outside.txt':kind==='absolute'?sentinel:kind==='project-file'?'outside.txt':kind==='engine-escape'?'scripts/memory/../../outside.txt':'.claude/skills/../../outside.txt';
    put(path.join(f.target,'outside.txt'),'project sentinel');
    const manifest=structuredClone(original);
    manifest.files[key]=hash(sentinel);put(file,JSON.stringify(manifest));
    const before=tree(f.target,{git:true,previous:true});
    const r=f.cli('scripts/upgrade.mjs',['--target',f.target]);
    assert.equal(r.status,1);assert.ok((r.stdout+r.stderr).includes(key));
    assert.deepEqual(tree(f.target,{git:true,previous:true}),before);assert.equal(read(sentinel),'sentinel');
  }
});
test('K.4 equal version and hashes is a no-op, differing engine hashes upgrade',t=>{
  const f=fixture(t);ok(f.install());const before=tree(f.target);assert.equal(f.install().status,1);assert.deepEqual(tree(f.target),before);
  ok(f.cli('scripts/upgrade.mjs',['--target',f.target]));assert.deepEqual(tree(f.target),before); // spec 11.4: equal version and equal hashes is a no-op.
  const p=path.join(f.target,'scripts/memory/lib.mjs');put(p,read(p)+'\n// local\n');
  const r=f.cli('scripts/upgrade.mjs',['--target',f.target,'--check']);assert.equal(r.status,1);assert.match(r.stdout,/edited locally: scripts\/memory\/lib.mjs/);
  ok(f.cli('scripts/upgrade.mjs',['--target',f.target]));assert.deepEqual(tree(f.target),before); // spec 11.4: equal version with different engine hashes repairs drift.
});
test('K.4 injected failure after second copied file restores all bytes and exits 1',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f),before=tree(f.target);
  const driver=put(path.join(f.root,'interrupt.mjs'),`import {upgrade} from ${JSON.stringify(pathToFileURL(path.join(next,'scripts/upgrade.mjs')).href)};\nprocess.exitCode=upgrade({target:${JSON.stringify(f.target)}},${JSON.stringify(next)},{afterCopy:n=>{if(n===2)throw Error('injected after second copied file')}});\n`);
  const r=f.exec(process.execPath,[driver]);assert.equal(r.status,1);assert.match(r.stderr,/restored .*\.kit-backup-.*injected/);assert.deepEqual(tree(f.target),before);
  const backup=path.join(f.target,'scripts/memory',fs.readdirSync(path.join(f.target,'scripts/memory')).find(n=>n.startsWith('.kit-backup-')));
  for(const e of json(path.join(backup,'restore.json')).files) if(e.existed) assert.equal(read(path.join(f.target,e.file)),read(path.join(backup,e.file)));
  console.log('K.4 interrupted fixture: engine, skills, config, KIT and MANIFEST restored byte-for-byte; exit 1');
});
test('K.4 new release merges defaults, preserves project values, skips edited skill, force replaces it',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f),engine=path.join(f.target,'scripts/memory'),config=json(path.join(engine,'memory.config.json'));
  config.caps.topic.warnBytes=7777;config.measure.evidenceDir='proofs';config.local={owner:true};put(path.join(engine,'memory.config.json'),JSON.stringify(config));
  const keep=['scripts/memory/recall-probes.json','AGENTS.md','.claude/settings.json'];const originals=Object.fromEntries(keep.map(p=>[p,read(path.join(f.target,p))]));const hook=read(path.join(f.memory,'.git/hooks/pre-commit'));
  const skill=path.join(f.target,'.claude/skills/memory-review/SKILL.md');put(skill,read(skill)+'\nLocal instruction.\n');const local=read(skill);
  const check=f.cli('scripts/upgrade.mjs',['--target',f.target,'--check'],next);assert.equal(check.status,1);assert.match(check.stdout,new RegExp(versionPattern+' -> '+nextVersionPattern+'(?=\\s|$)')); // 3.2.1: version from VERSION
  const r=ok(f.cli('scripts/upgrade.mjs',['--target',f.target],next));assert.match(r.stdout,/WARN edited skill skipped/);assert.equal(read(skill),local);
  const updated=json(path.join(engine,'memory.config.json'));assert.equal(updated.engine_version,nextVersion);assert.deepEqual(updated.newDefault,{enabled:true});delete updated.newDefault;updated.engine_version=config.engine_version;assert.deepEqual(updated,config); // 3.2.1: version from VERSION
  for(const p of keep) assert.equal(read(path.join(f.target,p)),originals[p]);assert.equal(read(path.join(f.memory,'.git/hooks/pre-commit')),hook);
  assert.equal(hash(path.join(engine,'lib.mjs')),hash(path.join(next,'engine/lib.mjs')));
  assert.equal(json(path.join(engine,'KIT.json')).version,nextVersion); // 3.2.1: version from VERSION
  ok(f.cli('scripts/upgrade.mjs',['--target',f.target,'--force-skills'],next));assert.equal(read(skill),read(path.join(next,'skills/memory-review/SKILL.md')));
  assert.equal(json(path.join(engine,'MANIFEST.json')).files['.claude/skills/memory-review/SKILL.md'],hash(skill));
  console.log('K.4 upgrade fixture: defaults merged, project content preserved, edited skill skipped then forced; 0 FAIL');
});
test('K.4 gate failure restores config and every replaced file',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f),before=tree(f.target);
  const c=json(path.join(next,'engine/memory.config.json'));c.caps.router.failBytes=1;
  // Existing values win: force an actual gate failure through replaced engine code.
  put(path.join(next,'engine/memory-check.mjs'),'console.log("injected gate failure"); process.exitCode=1;\n');ok(f.cli('scripts/manifest.mjs',[],next));
  const r=f.cli('scripts/upgrade.mjs',['--target',f.target],next);assert.equal(r.status,1);assert.match(r.stderr,/restored .*\.kit-backup-/);assert.deepEqual(tree(f.target),before);
});

test('K1 archived generated pages upgrade and restore byte-for-byte', t => {
  const f = fixture(t);
  if (f.exec('git', ['-C', path.resolve('.'), 'rev-parse', '--verify', 'v3.2.1']).status !== 0) return t.skip('archive tag unavailable in public export');
  const old = path.join(f.root, 'old-kit'), archive = path.join(f.root, 'old.tar');
  fs.mkdirSync(old);
  ok(f.exec('git', ['-C', path.resolve('.'), 'archive', 'v3.2.1', '-o', archive]));
  ok(f.exec('tar', ['-xf', 'old.tar', '-C', 'old-kit'], {cwd: f.root}));
  ok(f.install([], old));
  const {pages: unchanged} = generateMemoryIndex({memoryDir: f.memory});
  for (const [name, text] of Object.entries(unchanged)) assert.equal(read(path.join(f.memory, name)), text, 'short after-link pages match archived engine bytes');
  put(path.join(f.memory, 'topic.md'), '---\nname: Topic\ndescription: ' + 'x'.repeat(383) + '\nmetadata:\n  type: feedback\n  route: craft-sessions\n---\nBody.\n');
  ok(f.cli('scripts/memory/memory-index.mjs', ['--write'], f.target));
  const pages = Object.fromEntries(fs.readdirSync(f.memory).filter(x => x.startsWith('INDEX-')).map(x => [x, fs.readFileSync(path.join(f.memory, x))]));
  const result = ok(f.cli('scripts/upgrade.mjs', ['--target', f.target]));
  assert.notDeepEqual(fs.readFileSync(path.join(f.memory, 'INDEX-craft-sessions.md')), pages['INDEX-craft-sessions.md']);
  const backup = result.stdout.match(/upgrade backup: (.+)/)[1].trim();
  ok(f.cli('scripts/upgrade.mjs', ['--target', f.target, '--restore', backup]));
  for (const [name, bytes] of Object.entries(pages)) assert.deepEqual(fs.readFileSync(path.join(f.memory, name)), bytes);
});

for (const router of ['missing', 'index-less', 'valid']) test('K round 3 regeneration report and guard ' + router, t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  put(path.join(f.memory, 'INDEX-obsolete.md'), '<!-- generated by memory-index.mjs; edit the lessons, not this file -->\nobsolete\r\n');
  if (router === 'missing') fs.unlinkSync(path.join(f.memory, 'MEMORY.md'));
  if (router === 'index-less') put(path.join(f.memory, 'MEMORY.md'), '# Memory\n');
  if (router === 'valid') for (let n = 0; n < 22; n++) put(path.join(f.memory, `INDEX-obsolete-${String(n).padStart(2, '0')}.md`), '<!-- generated by memory-index.mjs; edit the lessons, not this file -->\n');
  const before = tree(f.memory);
  const r = ok(f.cli('scripts/upgrade.mjs', ['--target', f.target], next));
  if (router === 'valid') {
    const report = r.stdout.split('\n').find(line => line.startsWith('regenerated '));
    assert.match(report, /^regenerated 2 generated pages; removed 23: /);
    const names = report.split(': ')[1].split(', ');
    assert.equal(names.length, 20);
    assert.ok(names.every(name => name.startsWith('INDEX-obsolete')));
    assert.ok(!fs.readdirSync(f.memory).some(name => name.startsWith('INDEX-obsolete')));
  }
  else { assert.match(r.stdout, new RegExp('WARN.*' + router)); assert.deepEqual(tree(f.memory), before); }
});
test('K round 3 gate failure after regeneration restores deleted pages and all memory bytes', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  put(path.join(f.memory, 'INDEX-obsolete.md'), '<!-- generated by memory-index.mjs; edit the lessons, not this file -->\nobsolete\r\n');
  const before = tree(f.memory);
  put(path.join(next, 'engine/memory-check.mjs'), `import fs from 'node:fs';
const memory = process.argv[process.argv.indexOf('--memory-dir') + 1];
if (fs.existsSync(memory + '/INDEX-obsolete.md')) throw Error('regeneration did not run');
console.log(JSON.stringify({findings:[{severity:'FAIL',check:'injected',file:'MEMORY.md',message:'after regeneration'}]})); process.exitCode=1;
`);
  ok(f.cli('scripts/manifest.mjs', [], next));
  const r = f.cli('scripts/upgrade.mjs', ['--target', f.target], next);
  assert.equal(r.status, 1); assert.match(r.stderr, /new FAIL: injected/);
  assert.deepEqual(tree(f.memory), before);
});
