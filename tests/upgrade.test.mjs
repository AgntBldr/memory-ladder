import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {generateMemoryIndex,gateCheckIds} from '../engine/memory-index.mjs';
import {fixture,ok,tree,json,read,put,bump,hash,nextVersion,versionPattern,nextVersionPattern} from './helpers.mjs';

test('L4 guard merge preserves foreign hooks and is idempotent', async () => {
  const {mergeGuardHooks,options,usage} = await import('../scripts/install.mjs');
  assert.equal(options(['--target','.','--no-guard'])['no-guard'],true);
  assert.ok(usage('install').split('\n').includes('  --no-guard            Skip guard hooks and persist guard: false in KIT.local.json.'));
  const template = json(path.resolve('templates/settings.guard.json'));
  const settings = {unrelated: true, hooks: {PreToolUse: [{hooks: [{command: 'foreign'}]}]}};
  assert.equal(mergeGuardHooks(settings, template),true);
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'foreign');
  assert.deepEqual(settings.hooks.PreToolUse[1], template.hooks.PreToolUse[0]);
  assert.deepEqual(settings.hooks.UserPromptSubmit, template.hooks.UserPromptSubmit);
  const before = structuredClone(settings);
  assert.equal(mergeGuardHooks(settings, template),false);
  assert.deepEqual(settings, before);
  for(const hooks of [[],42,'bad']) assert.throws(()=>mergeGuardHooks({hooks},template),{message:'settings.json hooks must be an object'});
  for(const event of ['PreToolUse','UserPromptSubmit']) assert.throws(()=>mergeGuardHooks({hooks:{[event]:{}}},template),{message:`hooks.${event} must be an array`});
});

test('L4 install no-guard persists with memoryDir and upgrade honors it', t => {
  const f = fixture(t);
  ok(f.install(['--no-guard', '--memory-dir', f.memory]));
  const local = json(path.join(f.target, 'scripts/memory/KIT.local.json'));
  assert.equal(local.guard, false); assert.equal(local.memoryDir, f.memory);
  const r = ok(f.cli('scripts/upgrade.mjs', ['--target', f.target], bump(f)));
  assert.ok(r.stdout.split(/\r?\n/).includes('settings: skipped (KIT.local.json guard: false)'));
  assert.equal(json(path.join(f.target, '.claude/settings.json')).hooks.PreToolUse, undefined);
});

test('L4 upgrade creates missing settings, plans hooks, and prints instructions hint verbatim', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  fs.unlinkSync(path.join(f.target, '.claude/settings.json'));
  put(path.join(f.target, 'AGENTS.md'), 'memory-lesson.mjs new --route craft-sessions "Title"\n');
  const check = f.cli('scripts/upgrade.mjs', ['--target', f.target, '--check'], next);
  assert.equal(check.status, 1);
  assert.ok(check.stdout.split(/\r?\n/).includes('settings: guard hooks would be added (PreToolUse Bash|PowerShell, UserPromptSubmit)'));
  assert.ok(!fs.existsSync(path.join(f.target, '.claude/settings.json')));
  const r = ok(f.cli('scripts/upgrade.mjs', ['--target', f.target], next));
  assert.ok(r.stdout.split(/\r?\n/).includes('WARN AGENTS.md:1 still says "memory-lesson.mjs new --route <family>"; add --kind <mistake|practice|observation>'));
  assert.ok(r.stdout.split(/\r?\n/).includes('settings: guard hooks added (PreToolUse Bash|PowerShell, UserPromptSubmit)'));
  assert.equal(json(path.join(f.target, '.claude/settings.json')).hooks.PreToolUse[0].matcher, 'Bash|PowerShell');
});

test('L4 listed new FAIL is pre-existing while changed message retains check-file identity', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  const file = path.join(next, 'engine/memory-check.mjs');
  put(file, read(file).replace('const originals = [...findings];', "add('FAIL', 'router.lines', 'MEMORY.md', null, repo && fs.existsSync(path.join(repo, 'scripts/memory/new-marker.mjs')) ? 'after' : 'before');\n  const originals = [...findings];"));
  put(path.join(next, 'scripts/upgrade.mjs'), read(path.join(next, 'scripts/upgrade.mjs')).replace("export const NEW_CHECKS = ['config.path'];", "export const NEW_CHECKS = ['router.lines'];"));
  put(path.join(next, 'engine/new-marker.mjs'), '// marker\n');
  ok(f.cli('scripts/manifest.mjs', [], next));
  const r = ok(f.cli('scripts/upgrade.mjs', ['--target', f.target], next));
  assert.ok(r.stdout.split(/\r?\n/).includes(`pre-existing FAIL (new check in ${nextVersion}) router.lines MEMORY.md: before`));
  assert.ok(r.stdout.split(/\r?\n/).includes(`upgrade: complete (1 pre-existing FAIL remain, 1 of them from checks new in ${nextVersion})`));
});

test('L4 broken legacy hint child cannot break upgrade and final line stays identical', t => {
  const f = fixture(t); ok(f.install()); const next = bump(f);
  put(path.join(next, 'engine/memory-lesson.mjs'), "throw Error('broken');\n");
  ok(f.cli('scripts/manifest.mjs', [], next));
  const r = ok(f.cli('scripts/upgrade.mjs', ['--target', f.target], next));
  assert.equal(r.stdout.trim().split(/\r?\n/).at(-1), 'upgrade: complete (0 pre-existing FAIL remain)');
});

test('L4 listed check on a different file after replacement still rolls back', t => {
  const f=fixture(t);ok(f.install());const next=bump(f),file=path.join(next,'engine/memory-check.mjs'),before=tree(f.target);
  put(file,read(file).replace('const originals = [...findings];', "add('FAIL', 'router.lines', repo && fs.existsSync(path.join(repo, 'scripts/memory/new-marker.mjs')) ? 'different.md' : 'MEMORY.md', null, 'injected');\n  const originals = [...findings];"));
  put(path.join(next,'scripts/upgrade.mjs'),read(path.join(next,'scripts/upgrade.mjs')).replace("export const NEW_CHECKS = ['config.path'];","export const NEW_CHECKS = ['router.lines'];"));
  put(path.join(next,'engine/new-marker.mjs'),'// marker\n');ok(f.cli('scripts/manifest.mjs',[],next));
  const r=f.cli('scripts/upgrade.mjs',['--target',f.target],next);assert.equal(r.status,1);assert.match(r.stderr,/new FAIL: router.lines different.md: injected/);assert.deepEqual(tree(f.target),before);
});

test('L4 NEW_CHECKS is exactly the new FAIL-capable registry', async () => {
  const {NEW_CHECKS}=await import('../scripts/upgrade.mjs');
  assert.deepEqual(NEW_CHECKS, ['config.path']);
});

test('L4 tolerant pre-run filters severity, allowed and unlisted IDs and cleans temporary config', async t => {
  const {newCheckFailures,NEW_CHECKS}=await import('../scripts/upgrade.mjs');
  NEW_CHECKS.push('router.lines'); t.after(() => NEW_CHECKS.pop());
  const f=fixture(t),root=path.join(f.root,'stub-kit'),file=path.join(root,'engine/memory-check.mjs'),seen=path.join(f.root,'seen.json');
  const finding={severity:'FAIL',check:'router.lines',file:'MEMORY.md',message:'before'};
  for(const [body,expected] of [
    ['console.log("not JSON")',[]], ['throw Error("broken")',[]],
    [`console.log(JSON.stringify({findings:[${JSON.stringify(finding)}]}));process.exitCode=2`,[]],
    ['console.log(JSON.stringify({findings:{}}))',[]],
    [`console.log(JSON.stringify({findings:${JSON.stringify([finding,{...finding,allowed:true},{...finding,severity:'WARN'},{...finding,check:'test.new'}])}}));process.exitCode=1`,[finding]],
  ]) {
    put(file,`import fs from 'node:fs'; const file=process.argv[process.argv.indexOf('--config')+1];fs.writeFileSync(${JSON.stringify(seen)},JSON.stringify({file,config:JSON.parse(fs.readFileSync(file))}));\n${body}`);
    assert.deepEqual(newCheckFailures(root,f.target,f.memory,{engine_version:nextVersion}),expected);
    const observed=json(seen);assert.equal(observed.config.engine_version,nextVersion);assert.ok(!fs.existsSync(observed.file));
  }
});

test('L4 upgrade no-guard CLI persists on same-version and keeps custom preferences', t => {
  const f=fixture(t);ok(f.install(['--no-guard','--memory-dir',f.memory]));
  const localFile=path.join(f.target,'scripts/memory/KIT.local.json');put(localFile,JSON.stringify({memoryDir:f.memory,extra:42}));
  assert.equal(f.cli('scripts/upgrade.mjs',['--target',f.target,'--check','--no-guard']).status,1);
  const r=ok(f.cli('scripts/upgrade.mjs',['--target',f.target,'--no-guard']));
  assert.ok(r.stdout.split(/\r?\n/).includes('settings: skipped (--no-guard)'));
  assert.deepEqual(json(localFile),{memoryDir:f.memory,extra:42,guard:false});
  const again=ok(f.cli('scripts/upgrade.mjs',['--target',f.target]));
  assert.ok(again.stdout.split(/\r?\n/).includes('settings: skipped (KIT.local.json guard: false)'));
});

test('L4 install guard-only local preference accepts custom memory and seeds rules without replacing host', t => {
  const f=fixture(t),engine=path.join(f.target,'scripts/memory');
  put(path.join(engine,'KIT.local.json'),JSON.stringify({guard:false,extra:7}));
  put(path.join(engine,'enforce-rules.json'),' {"version":1,"rules":[]}\n');
  const r=ok(f.install(['--memory-dir',f.memory]));
  assert.ok(r.stdout.split(/\r?\n/).includes('settings: skipped (KIT.local.json guard: false)'));
  assert.deepEqual(json(path.join(engine,'KIT.local.json')),{guard:false,extra:7,memoryDir:f.memory});
  assert.equal(read(path.join(engine,'enforce-rules.json')),' {"version":1,"rules":[]}\n');
  ok(f.cli('scripts/upgrade.mjs',['--target',f.target],bump(f)));
  assert.equal(read(path.join(engine,'enforce-rules.json')),' {"version":1,"rules":[]}\n');
  const other=fixture(t),localFile=path.join(other.target,'scripts/memory/KIT.local.json');
  fs.mkdirSync(other.memory,{recursive:true});
  const bytes=' '+JSON.stringify({guard:false,memoryDir:other.memory})+'\n';put(localFile,bytes);
  ok(other.install(['--no-guard','--memory-dir',other.memory]));assert.equal(read(localFile),bytes);
});

test('L4 installed guard present message and both hooks are idempotent', t => {
  const f=fixture(t),settingsFile=path.join(f.target,'.claude/settings.json');
  const r=ok(f.install());assert.ok(r.stdout.split(/\r?\n/).includes('settings: guard hooks added (PreToolUse Bash|PowerShell, UserPromptSubmit)'));
  assert.deepEqual(json(path.join(f.target,'scripts/memory/enforce-rules.json')),{version:1,rules:[]});
  const before=read(settingsFile);
  const u=ok(f.cli('scripts/upgrade.mjs',['--target',f.target]));assert.ok(u.stdout.split(/\r?\n/).includes('settings: present'));assert.equal(read(settingsFile),before);
  assert.deepEqual(json(path.join(f.target,'scripts/memory/enforce-rules.json')),{version:1,rules:[]});
  assert.equal(read(path.join(f.target,'scripts/memory/enforce-rules.kit.json')),read(path.resolve('engine/enforce-rules.kit.json')));
});

test('L4 instruction hint covers both files and ignores corrected lines without changing bytes', async t => {
  const {upgradeHints}=await import('../scripts/upgrade.mjs');
  const f=fixture(t),root=path.join(f.root,'hints');
  put(path.join(root,'engine/memory-lesson.mjs'),'console.log(JSON.stringify({files:0,entries:0}));');
  const lines=[];const original=console.log;
  for(const file of ['AGENTS.md','CLAUDE.md']) put(path.join(f.target,file),'heading\nmemory-lesson.mjs new --route a\nmemory-lesson.mjs new --route a --kind mistake\n');
  const before=tree(f.target);
  try {console.log=s=>lines.push(s);upgradeHints(root,f.target,f.memory);} finally {console.log=original;}
  assert.deepEqual(lines,['AGENTS.md','CLAUDE.md'].map(file=>`WARN ${file}:2 still says "memory-lesson.mjs new --route <family>"; add --kind <mistake|practice|observation>`));
  assert.deepEqual(tree(f.target),before);
});

test('L4 hint child is lock-free bounded and tolerant with exact legacy output', async t => {
  const {upgradeHints}=await import('../scripts/upgrade.mjs');
  const f=fixture(t),original=childProcess.spawnSync,log=console.log,lines=[];
  try {
    console.log=s=>lines.push(s);
    for(const result of [{status:0,stdout:'{"files":2,"entries":3}'},{status:1,stdout:'{"files":2,"entries":3}'},{status:0,stdout:'invalid'},{status:0,stdout:'{"files":0,"entries":3}'},{status:0,stdout:'{"files":2,"entries":0}'},{status:0,error:Error('timeout'),stdout:'{"files":2,"entries":3}'},null]) {
      childProcess.spawnSync=(node,args,options)=>{
        assert.equal(node,process.execPath);assert.equal(options.timeout,20000);assert.equal(options.encoding,'utf8');
        assert.deepEqual(args,[path.join(f.root,'engine/memory-lesson.mjs'),'repeat','--from-legacy','--json','--memory-dir',f.memory,'--repo',f.target]);
        if(!result) throw Error('spawn failure');return result;
      };syncBuiltinESMExports();upgradeHints(f.root,f.target,f.memory);
    }
  } finally {childProcess.spawnSync=original;syncBuiltinESMExports();console.log=log;}
  assert.deepEqual(lines,[`WARN 2 files carry legacy repeat paragraphs; run node "${path.join(f.target,'scripts/memory/memory-lesson.mjs')}" repeat --from-legacy --memory-dir "${f.memory}" (dry run), then add --write`]);
});

test('L4 same-version check plans missing settings and host rules without writing',t=>{
  for(const missing of ['.claude/settings.json','scripts/memory/enforce-rules.json']) {
  const f=fixture(t);ok(f.install());fs.unlinkSync(path.join(f.target,missing));
  const before=tree(f.target),r=f.cli('scripts/upgrade.mjs',['--target',f.target,'--check']);
  assert.equal(r.status,1);assert.deepEqual(tree(f.target),before);
  ok(f.cli('scripts/upgrade.mjs',['--target',f.target]));
  assert.equal(json(path.join(f.target,'.claude/settings.json')).hooks.PreToolUse[0].matcher,'Bash|PowerShell');
  assert.deepEqual(json(path.join(f.target,'scripts/memory/enforce-rules.json')),{version:1,rules:[]});
  }
});

test('L4 install adds guard when SessionStart is already present and when settings are absent',t=>{
  for(const present of [true,false]) {
    const f=fixture(t),file=path.join(f.target,'.claude/settings.json');
    if(present) put(file,JSON.stringify(json(path.resolve('templates/settings.sessionstart.json'))));else fs.unlinkSync(file);
    const r=ok(f.install());assert.ok(r.stdout.split(/\r?\n/).includes('settings: guard hooks added (PreToolUse Bash|PowerShell, UserPromptSubmit)'));
    const settings=json(file);assert.equal(settings.hooks.SessionStart.length,1);
    assert.deepEqual(settings.hooks.PreToolUse,json(path.resolve('templates/settings.guard.json')).hooks.PreToolUse);
    assert.deepEqual(settings.hooks.UserPromptSubmit,json(path.resolve('templates/settings.guard.json')).hooks.UserPromptSubmit);
  }
});

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
  ok(f.cli('scripts/upgrade.mjs',['--target',f.target]));assert.deepEqual(tree(f.target),before); // equal version and equal hashes is a no-op.
  const p=path.join(f.target,'scripts/memory/lib.mjs');put(p,read(p)+'\n// local\n');
  const r=f.cli('scripts/upgrade.mjs',['--target',f.target,'--check']);assert.equal(r.status,1);assert.match(r.stdout,/edited locally: scripts\/memory\/lib.mjs/);
  ok(f.cli('scripts/upgrade.mjs',['--target',f.target]));assert.deepEqual(tree(f.target),before); // equal version with different engine hashes repairs drift.
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
  if (f.exec('git', ['-C', path.resolve('.'), 'rev-parse', '--verify', 'v3.2.1']).status !== 0) return t.skip('archive tag unavailable');
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

for (const router of ['missing', 'index-less', 'valid']) test('regeneration report and guard ' + router, t => {
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
test('gate failure after regeneration restores deleted pages and all memory bytes', t => {
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

for(const [label,contents] of [['array','[]'],['null','null'],['empty',''],['non-JSON','{ broken']]) {
  for(const mode of ['enabled','flag','local']) test(`upgrade settings validation ${label} ${mode}`, t => {
    const f=fixture(t);ok(f.install());
    const file=path.join(f.target,'.claude/settings.json');put(file,contents);
    if(mode==='local') put(path.join(f.target,'scripts/memory/KIT.local.json'),JSON.stringify({guard:false}));
    const before=tree(f.target),args=['--target',f.target,...(mode==='flag'?['--no-guard']:[])];
    const r=f.cli('scripts/upgrade.mjs',args);
    assert.doesNotMatch(r.stdout,/guard hooks added/);
    if(mode==='enabled') {
      assert.equal(r.status,1);
      assert.match(r.stderr,label==='array'||label==='null'?/settings.json must be an object/:/cannot read .*settings.json:/);
      assert.deepEqual(tree(f.target),before);
      assert.ok(!fs.readdirSync(path.join(f.target,'scripts/memory')).some(name=>name.startsWith('.kit-backup-')));
    } else {
      ok(r);assert.equal(read(file),contents);
      assert.match(r.stdout,/settings: skipped/);
      if(mode==='flag') assert.equal(json(path.join(f.target,'scripts/memory/KIT.local.json')).guard,false);
    }
  });
}

test('upgrade hints tolerate unreadable instruction files and continue', async t => {
  const {upgradeHints}=await import('../scripts/upgrade.mjs');
  const f=fixture(t),lines=[],log=console.log;
  fs.unlinkSync(path.join(f.target,'AGENTS.md'));
  fs.mkdirSync(path.join(f.target,'AGENTS.md'));
  fs.mkdirSync(path.join(f.target,'CLAUDE.md'));
  try {console.log=line=>lines.push(line);assert.doesNotThrow(()=>upgradeHints(f.root,f.target,f.memory));}
  finally {console.log=log;}
  for(const file of ['AGENTS.md','CLAUDE.md']) assert.ok(lines.some(line=>line.startsWith(`WARN ${file} unreadable: `)&&line.length>`WARN ${file} unreadable: `.length));
});

function assertRegisteredChecks(ids,source) {
  const registered=gateCheckIds(source);
  for(const id of ids) assert.ok(registered.includes(id),`NEW_CHECKS id missing from gate: ${id}`);
}
test('upgrade NEW_CHECKS exist in gate and comparison rejects missing IDs', async () => {
  const {NEW_CHECKS}=await import('../scripts/upgrade.mjs');
  const source=read(path.resolve('engine/memory-check.mjs'));
  assertRegisteredChecks(NEW_CHECKS,source);
  assert.throws(()=>assertRegisteredChecks([...NEW_CHECKS,'lesson.typo'],source),/lesson.typo/);
  assert.throws(()=>assertRegisteredChecks(['lesson.kind'],source.replaceAll('lesson.kind','removed.kind')),/lesson.kind/);
});
