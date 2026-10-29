import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {fixture,ok,tree,json,read,put,bump,hash,kitRoot,nextVersion,versionPattern} from './helpers.mjs';
import * as updater from '../scripts/upgrade.mjs';
import {memorySlug} from '../engine/lib.mjs';
const engine = f => path.join(f.target,'scripts/memory');
const gate = (f,args=[]) => f.cli('scripts/memory/memory-check.mjs',args,f.target);
const findings = f => JSON.parse(gate(f,['--json']).stdout).findings;
const backups = f => fs.readdirSync(engine(f)).filter(n=>n.startsWith('.kit-backup-')).map(n=>path.join(engine(f),n));

test('F1 installed skill links and section locators resolve',t=>{
  const f=fixture(t);ok(f.install());
  for(const name of ['memory-ladder','memory-review']) {
    const file=path.join(f.target,'.claude/skills',name,'SKILL.md'),text=read(file);
    const prose=text.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm,'');
    for(const [,link] of prose.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if(/^(?:https?:|#)/.test(link)) continue;
      assert.match(link,/^\.\.\/\.\.\/\.\.\/scripts\/memory\/(?:README|CONVERT|UPGRADE)\.md(?:#.*)?$/);
      assert.ok(fs.existsSync(path.resolve(path.dirname(file),link.split('#')[0])),link);
    }
    assert.match(text,/README\.md#section-list/);
  }
  const manifest=json(path.join(engine(f),'MANIFEST.json'));
  for(const name of ['CONVERT.md','UPGRADE.md']) assert.equal(manifest.files['scripts/memory/'+name],hash(path.join(engine(f),name)));
});
test('F2 reinstall refuses without any writes',t=>{
  const f=fixture(t);ok(f.install());const before=tree(f.root,{git:true});
  const r=f.install();assert.equal(r.status,1);assert.match(r.stderr,new RegExp('already installed \\(kit '+versionPattern+'\\); run scripts/upgrade\\.mjs')); // 3.2.1: version from VERSION
  assert.deepEqual(tree(f.root,{git:true}),before);
});
test('F2 foreign owned bytes require backup before install',t=>{
  const f=fixture(t),file=put(path.join(engine(f),'lib.mjs'),'foreign bytes\r\n'),before=tree(f.root,{git:true});
  const r=f.install();assert.equal(r.status,1);assert.match(r.stderr,/lib\.mjs/);assert.deepEqual(tree(f.root,{git:true}),before);
  ok(f.install(['--backup']));assert.notEqual(read(file),'foreign bytes\r\n');
  assert.equal(read(path.join(backups(f)[0],'scripts/memory/lib.mjs')),'foreign bytes\r\n');
});
test('F3 CLAUDE-only layout receives the gate in CLAUDE',t=>{
  const f=fixture(t);fs.unlinkSync(path.join(f.target,'AGENTS.md'));put(path.join(f.target,'CLAUDE.md'),'Local rules.\n');
  ok(f.install());assert.ok(!fs.existsSync(path.join(f.target,'AGENTS.md')));assert.match(read(path.join(f.target,'CLAUDE.md')),/Local rules\.\n[\s\S]*## Memory gate/);
});
test('F4 differently cased installer and upgrader paths execute',{skip:process.platform!=='win32'},t=>{
  const f=fixture(t);
  // Exercise loaders that canonicalize the module URL but preserve argv spelling.
  const load=(file,args)=>{
    const actual=path.join(kitRoot,'scripts',file),cased=actual.toUpperCase().replace(/\.MJS$/,'.mjs');
    return f.exec(process.execPath,['--input-type=module','-e',`process.argv=[process.execPath,${JSON.stringify(cased)},...${JSON.stringify(args)}];await import(${JSON.stringify(pathToFileURL(actual).href)});`]);
  };
  assert.match(ok(load('install.mjs',['--target',f.target,'--dry-run'])).stdout,/WRITE/);
  const r=ok(f.exec(process.execPath,[path.join(kitRoot,'scripts/install.mjs').toUpperCase().replace(/\.MJS$/,'.mjs'),'--target',f.target]));assert.match(r.stdout,/install wall time/);
  const u=ok(f.exec(process.execPath,[path.join(kitRoot,'scripts/upgrade.mjs').toUpperCase().replace(/\.MJS$/,'.mjs'),'--target',f.target,'--check']));assert.match(u.stdout,new RegExp('kit '+versionPattern+'(?=\\s|$)')); // 3.2.1: version from VERSION
  assert.match(ok(load('upgrade.mjs',['--target',f.target,'--check'])).stdout,new RegExp('kit '+versionPattern+'(?=\\s|$)')); // 3.2.1: version from VERSION
});
test('F5 empty initialized memory repo receives exactly one baseline',t=>{
  const f=fixture(t);fs.mkdirSync(f.memory,{recursive:true});f.git(f.memory,'init');ok(f.install());assert.equal(f.git(f.memory,'rev-list','--count','HEAD'),'1');
});
test('F5 failed baseline can retry install and create its first commit',t=>{
  const f=fixture(t);fs.mkdirSync(f.memory,{recursive:true});f.git(f.memory,'init');
  const hook=put(path.join(f.memory,'.git/hooks/pre-commit'),'#!/bin/sh\nexit 1\n');fs.chmodSync(hook,0o755);
  assert.equal(f.install().status,1);assert.ok(!fs.existsSync(path.join(engine(f),'KIT.json')));
  assert.notEqual(f.exec('git',['-C',f.memory,'rev-parse','--verify','HEAD']).status,0);
  fs.unlinkSync(hook);ok(f.install());assert.equal(f.git(f.memory,'rev-list','--count','HEAD'),'1');
});
test('F6 pre-existing FAIL is reported and does not roll back upgrade',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f);put(path.join(f.memory,'current-state.md'),read(path.join(f.memory,'current-state.md'))+'\n## RESUME old\nHistory\n');
  const r=ok(f.cli('scripts/upgrade.mjs',['--target',f.target],next));assert.match(r.stdout,/pre-existing FAIL.*state.headings/);assert.equal(json(path.join(engine(f),'KIT.json')).version,nextVersion); // 3.2.1: version from VERSION
});
test('F6 NEW FAIL rolls back despite existing failures',t=>{
  const f=fixture(t);ok(f.install());put(path.join(f.memory,'current-state.md'),read(path.join(f.memory,'current-state.md'))+'\n## RESUME old\nHistory\n');
  const next=bump(f),before=tree(f.target);const check=path.join(next,'engine/memory-check.mjs');
  put(check,read(check).replace('const originals = [...findings];',"add('FAIL', 'test.new', 'MEMORY.md', null, 'new regression');\n  const originals = [...findings];"));ok(f.cli('scripts/manifest.mjs',[],next));
  const r=f.cli('scripts/upgrade.mjs',['--target',f.target],next);assert.equal(r.status,1);assert.match(r.stderr,/new FAIL.*test.new/);assert.deepEqual(tree(f.target),before);
});
test('F6 unique backups, removed files, restore command and ignore rules',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f),obsolete=put(path.join(engine(f),'obsolete.mjs'),'old release\r\n');
  put(path.join(next,'engine/added.mjs'),'// new release file\n');ok(f.cli('scripts/manifest.mjs',[],next));
  const mp=path.join(engine(f),'MANIFEST.json'),m=json(mp);m.files['scripts/memory/obsolete.mjs']=hash(obsolete);put(mp,JSON.stringify(m));const before=tree(f.target);
  ok(f.cli('scripts/upgrade.mjs',['--target',f.target],next));assert.ok(!fs.existsSync(obsolete));assert.ok(fs.existsSync(path.join(engine(f),'added.mjs')));const first=backups(f)[0];
  assert.ok(json(path.join(first,'restore.json')).files.some(x=>x.file==='scripts/memory/obsolete.mjs'&&x.existed));
  const saved=tree(first);ok(f.cli('scripts/upgrade.mjs',['--target',f.target,'--force-skills'],next));assert.equal(backups(f).length,2);assert.deepEqual(tree(first),saved);
  assert.match(read(path.join(engine(f),'.gitignore')),/\.kit-backup-\*\//);assert.match(f.git(f.target,'check-ignore',path.join(first,'restore.json')),/restore.json/);
  ok(f.cli('scripts/upgrade.mjs',['--target',f.target,'--restore',first],next));assert.deepEqual(tree(f.target),before);assert.equal(read(obsolete),'old release\r\n');
});
test('F6 rollback EPERM reports recoverable backup and restore works later',t=>{
  const f=fixture(t);ok(f.install());const next=bump(f),before=tree(f.target);
  const driver=put(path.join(f.root,'locked.mjs'),`import fs from 'node:fs'; import {upgrade} from ${JSON.stringify(pathToFileURL(path.join(next,'scripts/upgrade.mjs')).href)};
process.exitCode=upgrade({target:${JSON.stringify(f.target)}},${JSON.stringify(next)},{afterCopy:n=>{if(n===2){fs.writeFileSync=()=>{throw Object.assign(Error('EPERM locked'),{code:'EPERM'})};throw Error('interrupted')}}});`);
  const r=f.exec(process.execPath,[driver]);assert.equal(r.status,1);assert.match(r.stderr,/rollback.*EPERM.*\.kit-backup-/);assert.doesNotMatch(r.stderr,/at upgrade/);
  ok(f.cli('scripts/upgrade.mjs',['--target',f.target,'--restore',backups(f)[0]],next));assert.deepEqual(tree(f.target),before);
});
test('F6 prerelease ordering and invalid versions never use NaN',()=>{
  assert.equal(updater.newer('3.1.0','3.1.0-beta'),true);assert.equal(updater.newer('3.1.0-beta','3.1.0'),false);
  assert.equal(updater.newer('3.1.0-beta.10','3.1.0-beta.2'),true);assert.equal(updater.newer('3.1.0+build','3.1.0'),false);
  assert.throws(()=>updater.newer('oops','3.1.0'),/version/);
});
test('F7 CRLF hashes equal LF hashes in manifest and gate',t=>{
  const f=fixture(t);ok(f.install());const p=path.join(engine(f),'lib.mjs'),before=hash(p);put(p,read(p).replace(/\r?\n/g,'\r\n'));assert.equal(hash(p),before);
  assert.ok(!findings(f).some(x=>x.check==='kit.manifest'));assert.equal(read(path.join(kitRoot,'.gitattributes')),'* text=auto eol=lf\n');
});
test('F7 malformed and missing manifest and unreadable entry warn without crash',t=>{
  const f=fixture(t);ok(f.install());const p=path.join(engine(f),'MANIFEST.json'),original=read(p);
  put(p,'{broken');assert.ok(findings(f).some(x=>x.check==='kit.manifest'&&x.severity==='WARN'));
  fs.unlinkSync(p);assert.ok(findings(f).some(x=>x.check==='kit.manifest'&&/missing/i.test(x.message)));
  put(p,original);const entry=path.join(engine(f),'README.md');fs.unlinkSync(entry);fs.mkdirSync(entry);assert.ok(findings(f).some(x=>x.check==='kit.manifest'&&/README/.test(x.file)));
});
test('F8 generated checks key on source existence, including missing and stale outputs',t=>{
  const f=fixture(t);ok(f.install());const ids=['repo.brain-index','repo.roadmap-overview'];assert.ok(!findings(f).some(x=>ids.includes(x.check)));
  put(path.join(f.target,'brain/03-knowledge/fct-example.md'),'---\nid: fct-example\ntype: fact\n---\n');fs.mkdirSync(path.join(f.target,'brain/00-system'),{recursive:true});put(path.join(f.target,'docs/ROADMAP.md'),'# Roadmap\n\n## Open work\n- Work\n');
  for(const id of ids) assert.ok(findings(f).some(x=>x.check===id),id);
  put(path.join(f.target,'brain/00-system/index.md'),'stale');put(path.join(f.target,'docs/ROADMAP-OVERVIEW.md'),'stale');
  for(const id of ids) assert.ok(findings(f).some(x=>x.check===id),id);
  fs.rmSync(path.join(f.target,'brain'),{recursive:true});fs.unlinkSync(path.join(f.target,'docs/ROADMAP.md'));assert.ok(!findings(f).some(x=>ids.includes(x.check)));
});
test('F9 old config defaults evidence dir; outside paths refused before writes',t=>{
  const f=fixture(t);ok(f.install());const p=path.join(engine(f),'memory.config.json'),c=json(p);delete c.measure;put(p,JSON.stringify(c));
  ok(f.cli('scripts/memory/memory-measure.mjs',['--write','old'],f.target));assert.ok(fs.existsSync(path.join(f.target,'docs/evidence/memory')));
  for(const dir of ['../escaped',path.join(f.root,'absolute-escape')]) {
    c.measure={evidenceDir:dir};put(p,JSON.stringify(c));const before=tree(f.root,{git:true});const r=f.cli('scripts/memory/memory-measure.mjs',['--write','escape'],f.target);
    assert.equal(r.status,1);assert.match(r.stderr,/evidenceDir.*outside/);assert.deepEqual(tree(f.root,{git:true}),before);
  }
});
test('F10 local-only memory record, precedence, missing fallthrough, source line and slug parity',t=>{
  const f=fixture(t),local=path.join(f.root,'local-memory');ok(f.install(['--memory-dir',local]));
  assert.ok(!Object.hasOwn(json(path.join(engine(f),'KIT.json')),'memoryDir'));assert.equal(json(path.join(engine(f),'KIT.local.json')).memoryDir,local);
  assert.match(read(path.join(engine(f),'.gitignore')),/KIT\.local\.json/);
  assert.match(f.git(f.target,'check-ignore',path.join(engine(f),'KIT.local.json')),/KIT.local.json/);
  assert.match(ok(gate(f)).stdout,/memory: .*\(KIT.local.json\)/);assert.doesNotMatch(ok(gate(f,['--session-start'])).stdout,/memory: /);
  const other=path.join(f.root,'env-memory');fs.cpSync(local,other,{recursive:true});f.env.CLAUDE_MEMORY_DIR=other;
  assert.match(ok(gate(f)).stdout,/memory: .*\(CLAUDE_MEMORY_DIR\)/);assert.match(ok(gate(f,['--memory-dir',local])).stdout,/memory: .*\(--memory-dir\)/);
  delete f.env.CLAUDE_MEMORY_DIR;fs.cpSync(local,f.memory,{recursive:true});put(path.join(engine(f),'KIT.local.json'),JSON.stringify({memoryDir:path.join(f.root,'absent')}));
  assert.match(ok(gate(f)).stdout,/memory: .*\(default\)/);assert.equal(path.basename(path.dirname(f.memory)),memorySlug(path.resolve(f.target)));
});
for(const name of ['KIT.json','KIT.local.json']) test('F10 malformed '+name+' gives one-line named error',t=>{
  const f=fixture(t);ok(f.install());put(path.join(engine(f),name),'{bad');const r=gate(f);assert.equal(r.status,1);
  assert.match(r.stdout+r.stderr,new RegExp(name.replaceAll('.','\\.')));assert.doesNotMatch(r.stdout+r.stderr,/SyntaxError|at JSON.parse/);assert.equal((r.stdout+r.stderr).trim().split(/\r?\n/).length,1);
});
test('F11 BOM settings read; existing hook preserves exact bytes',t=>{
  // Install preserves bytes when all shipped hooks already exist, including the guard hooks.
  const f=fixture(t),p=path.join(f.target,'.claude/settings.json'),settings=json(path.join(kitRoot,'templates/settings.sessionstart.json'));
  Object.assign(settings.hooks,json(path.join(kitRoot,'templates/settings.guard.json')).hooks);
  const bytes='\uFEFF'+JSON.stringify(settings)+'\r\n';put(p,bytes);const result=ok(f.install());assert.equal(read(p),bytes);
  assert.ok(result.stdout.split(/\r?\n/).includes('settings: present'));
});
for(const value of [[],42,null,'scalar']) test('F11 non-object settings '+JSON.stringify(value)+' refuses before writes',t=>{
  const f=fixture(t);put(path.join(f.target,'.claude/settings.json'),JSON.stringify(value));const before=tree(f.root,{git:true});const r=f.install();assert.equal(r.status,1);assert.match(r.stderr,/settings.json.*object/);assert.deepEqual(tree(f.root,{git:true}),before);
});
test('F11 existing pins do not ratchet when initializing empty git history',t=>{
  const f=fixture(t);fs.mkdirSync(f.memory,{recursive:true});for(const name of ['MEMORY.md','INDEX-craft-sessions.md','current-state.md']) put(path.join(f.memory,name),read(path.join(kitRoot,'templates',name)));
  const c=json(path.join(kitRoot,'engine/memory.config.json'));c.pins={'INDEX-craft-sessions.md':7000};const raw=JSON.stringify(c);put(path.join(engine(f),'memory.config.json'),raw);ok(f.install());assert.equal(read(path.join(engine(f),'memory.config.json')),raw);
});
test('F12 acquisition heading and portable conversion',()=>{
  const readme=read(path.join(kitRoot,'README.md')),convert=read(path.join(kitRoot,'docs/CONVERT.md'));
  assert.match(convert,/git clone --no-hardlinks <MEMORY> <COPY>/);assert.match(convert,/--tag <name>/);assert.doesNotMatch(convert,/pre-v3-\d/);
  assert.match(convert.split('\n')[6],/pins.*initialized when missing.*never raised/i);
});
test('F13 notes source yields notes stub and supplied recovery tag',t=>{
  const f=fixture(t);ok(f.install());put(path.join(f.memory,'notes.md'),'## 1. A lesson\nRetain this.\n');
  ok(f.cli('scripts/memory/memory-migrate.mjs',['lessons','--memory-dir',f.memory,'--source','notes.md','--tag','my-baseline','--write'],f.target));
  const stub=read(path.join(f.memory,'notes.md'));assert.match(stub,/name: notes\n/);assert.match(stub,/moved_to:/);assert.match(stub,/show my-baseline:notes.md/);
  assert.ok(!fs.existsSync(path.join(f.memory,'lessons.md')));
});
