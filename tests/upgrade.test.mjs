import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixture,ok,tree,json,read,put,bump,hash} from './helpers.mjs';

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
test('K.4 check catches edited engine, repeat and same-version upgrade are no-ops',t=>{
  const f=fixture(t);ok(f.install());const before=tree(f.target);assert.equal(f.install().status,1);assert.deepEqual(tree(f.target),before);
  ok(f.cli('scripts/upgrade.mjs',['--target',f.target]));assert.deepEqual(tree(f.target),before);
  const p=path.join(f.target,'scripts/memory/lib.mjs');put(p,read(p)+'\n// local\n');
  const r=f.cli('scripts/upgrade.mjs',['--target',f.target,'--check']);assert.equal(r.status,1);assert.match(r.stdout,/edited locally: scripts\/memory\/lib.mjs/);
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
  const check=f.cli('scripts/upgrade.mjs',['--target',f.target,'--check'],next);assert.equal(check.status,1);assert.match(check.stdout,/3.1.0 -> 3.1.1/);
  const r=ok(f.cli('scripts/upgrade.mjs',['--target',f.target],next));assert.match(r.stdout,/WARN edited skill skipped/);assert.equal(read(skill),local);
  const updated=json(path.join(engine,'memory.config.json'));assert.equal(updated.engine_version,'3.1.1');assert.deepEqual(updated.newDefault,{enabled:true});delete updated.newDefault;updated.engine_version=config.engine_version;assert.deepEqual(updated,config);
  for(const p of keep) assert.equal(read(path.join(f.target,p)),originals[p]);assert.equal(read(path.join(f.memory,'.git/hooks/pre-commit')),hook);
  assert.equal(hash(path.join(engine,'lib.mjs')),hash(path.join(next,'engine/lib.mjs')));
  assert.equal(json(path.join(engine,'KIT.json')).version,'3.1.1');
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
