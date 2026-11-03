import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,ok,put,read,json,tree,kitRoot,hash} from './helpers.mjs';
import {mergeNewSessionHooks,sessionPermission,gateLinePlan,mirrorWrites,distributionRefusals} from '../scripts/install-safety.mjs';
import {ownedFiles} from '../scripts/manifest.mjs';
import {withMemoryLock} from '../engine/memory-lock.mjs';
const powerShellPermission='PowerShell(node scripts/memory/new-session.mjs:*)';
const session=json(path.join(kitRoot,'templates/settings.newsession.json'));
const command=session.hooks.UserPromptSubmit[0].hooks[0].command;
const skillFile='.claude/skills/new-session/SKILL.md';
const localFile='scripts/memory/KIT.local.json';
const manifestFile='scripts/memory/MANIFEST.json';
const gateLine=read(path.join(kitRoot,'templates/AGENTS-memory-gate.md')).split('\n').find(line=>line.startsWith('- Session phrases:'));
const upgrade=(f,args=[],options={})=>f.exec(process.execPath,[path.join(kitRoot,'scripts/upgrade.mjs'),'--target',f.target,...args],options);
const snapshot=f=>tree(f.root,{git:true,previous:true});
for (const installed of [false, true]) for (const slash of ['/', '\\']) test(`T8 fix3.1 quoted apostrophe path on ${installed ? 'upgrade' : 'install'}: ${slash}`, t => {
  const f = fixture(t), target = path.join(f.root, "O'Brien", 'project');
  fs.mkdirSync(path.dirname(target)); fs.renameSync(f.target, target); fs.mkdirSync(f.target);
  const run = () => f.cli(installed ? 'scripts/upgrade.mjs' : 'scripts/install.mjs', ['--target', target]);
  if (installed) ok(f.cli('scripts/install.mjs', ['--target', target]));
  const file = path.join(target, '.claude/settings.json'), settings = json(file);
  const own = `node "${path.join(target, 'scripts/memory/new-session.mjs').replaceAll('\\', '/').replaceAll('/', slash)}" detect`;
  settings.hooks = {UserPromptSubmit: [{hooks: [{type: 'command', command: own}]}]};
  put(file, JSON.stringify(settings)); ok(run());
  const hooks = json(file).hooks.UserPromptSubmit.flatMap(entry => entry.hooks).filter(hook => hook.command.includes('new-session.mjs'));
  assert.equal(hooks.length, 1); assert.equal(hooks[0].command, own);
});
const lockFiles=f=>fs.readdirSync(f.memory).filter(name=>name.startsWith('.memory.lock'));
const handoverFile='.claude/skills/handover/SKILL.md';
const overlay='## Session overlay\nroadmap: docs/ROADMAP.md | section: Open work\nbranch: main\nmain-only: no\ncheck: node check.cjs\nrules: private-rules.md\nafter-go: project-plan, project-check\nclose: project-check; node close.cjs\npush: none\nlog: docs/log.md, 20 lines\nboard: node board.cjs\npublic: no\n';
const stage2={SessionStart:'node "${CLAUDE_PROJECT_DIR:-.}/scripts/memory/wave-save.mjs" resume',PreCompact:'node "${CLAUDE_PROJECT_DIR:-.}/scripts/memory/wave-save.mjs" precompact'};
function handoverRouting(f,owned=true) {
  const helper=path.join(f.target,'scripts/memory/new-session.mjs'),before=snapshot(f);
  const detect=ok(f.exec(process.execPath,[helper,'detect'],{input:JSON.stringify({prompt:'handover'})}));
  const dispatch=ok(f.exec(process.execPath,[helper,'dispatch','--message','handover']));
  assert.equal(detect.stderr+dispatch.stderr,'');
  if(owned) {
    assert.match(JSON.parse(detect.stdout).hookSpecificOutput.additionalContext,/skill "handover" and args "full"/);
    assert.equal(dispatch.stdout,'Read .claude/skills/handover/SKILL.md and follow it (full).');
  } else assert.equal(detect.stdout+dispatch.stdout,'');
  assert.deepEqual(snapshot(f),before);
}
function denyWrites(f, locksOnly=false) {
  const preload=put(path.join(f.root,'deny-writes.cjs'),`const fs=require('node:fs');
for(const name of ['writeFileSync','appendFileSync','mkdirSync','renameSync','unlinkSync','rmSync','copyFileSync','linkSync','openSync']) {
  const original=fs[name];
  fs[name]=function(file,...args) {
    if(name==='openSync'&&args[0]==='r') return original.call(this,file,...args);
    if(${locksOnly} ? String(file).includes('.memory.lock') : true) throw Error('forbidden write attempt: '+file);
    return original.call(this,file,...args);
  };
}
require('node:module').syncBuiltinESMExports();
`);
  return {env:{...f.env,NODE_OPTIONS:'--require '+JSON.stringify(preload)}};
}

for(const marker of [null,'.agents','.codex']) test('T-H8 T-H10 install delivers handover and preserves filled overlay/add-on: '+marker,t=>{
  const f=fixture(t);
  // Remove the helper's placeholder files to exercise an empty project too.
  fs.unlinkSync(path.join(f.target,'AGENTS.md'));fs.unlinkSync(path.join(f.target,'.claude/settings.json'));
  if(marker) fs.mkdirSync(path.join(f.target,marker));
  if(marker) put(path.join(f.target,'AGENTS.md'),'# Host\n\n## Memory gate\n- Keep this rule.\n\n'+overlay);
  const addon='.claude/skills/project-check/SKILL.md',addonBytes='# Project check\nRun the private close check.\n';
  if(marker) put(path.join(f.target,addon),addonBytes);
  const original=marker?read(path.join(f.target,'AGENTS.md')):null;
  ok(f.install());
  assert.deepEqual(fs.readFileSync(path.join(f.target,handoverFile)),fs.readFileSync(path.join(kitRoot,'skills/handover/SKILL.md')));
  const manifest=json(path.join(f.target,manifestFile));
  assert.equal(Object.keys(manifest.files).length,Object.keys(json(path.join(kitRoot,'MANIFEST.json')).files).length);
  assert.equal(manifest.files[handoverFile],hash(path.join(kitRoot,'skills/handover/SKILL.md')));
  const mirror=path.join(f.target,'.agents/skills/handover/SKILL.md');
  assert.equal(fs.existsSync(mirror),Boolean(marker));
  if(marker) {
    assert.deepEqual(fs.readFileSync(mirror),fs.readFileSync(path.join(f.target,handoverFile)));
    assert.equal(read(path.join(f.target,'AGENTS.md')),original.replace('- Keep this rule.\n','- Keep this rule.\n'+gateLine+'\n'));
    assert.equal(read(path.join(f.target,addon)),addonBytes);assert.ok(!Object.hasOwn(manifest.files,addon));
  }
  assert.equal(read(path.join(f.target,'AGENTS.md')).split(gateLine).length,2);
  handoverRouting(f);
});

test('T-H8 foreign handover survives repeated force upgrades, stays silent, and named replacement backs up',t=>{
  const f=fixture(t),file=path.join(f.target,handoverFile),foreign='# Hand-written handover\nKeep the project close steps.\n';
  put(file,foreign);fs.mkdirSync(path.join(f.target,'.codex'));
  ok(f.install(['--force-skills','--backup']));
  for(const args of [[],[],['--force-skills']]) {
    ok(upgrade(f,args));assert.equal(read(file),foreign);
    assert.deepEqual(json(path.join(f.target,localFile)).foreignSkills,['handover']);
    assert.ok(!Object.hasOwn(json(path.join(f.target,manifestFile)).files,handoverFile));
    assert.ok(!fs.existsSync(path.join(f.target,'.agents/skills/handover/SKILL.md')));
    const before=snapshot(f),checked=ok(upgrade(f,['--check']));
    assert.match(checked.stdout,/foreign skill kept: .claude\/skills\/handover\/SKILL.md/);assert.deepEqual(snapshot(f),before);
    handoverRouting(f,false);
  }
  // Identical bytes do not transfer persisted ownership to the kit.
  put(file,read(path.join(kitRoot,'skills/handover/SKILL.md')));ok(upgrade(f,['--force-skills']));handoverRouting(f,false);
  assert.ok(!Object.hasOwn(json(path.join(f.target,manifestFile)).files,handoverFile));
  put(file,foreign);ok(upgrade(f,['--replace-skill','handover']));
  assert.equal(read(file),read(path.join(kitRoot,'skills/handover/SKILL.md')));
  assert.deepEqual(json(path.join(f.target,localFile)).foreignSkills,[]);
  assert.ok(fs.readdirSync(path.join(f.target,'scripts/memory')).filter(n=>n.startsWith('.kit-backup-')).some(n=>{
    const saved=path.join(f.target,'scripts/memory',n,handoverFile);return fs.existsSync(saved)&&read(saved)===foreign;
  }));
  assert.equal(read(path.join(f.target,'.agents/skills/handover/SKILL.md')),read(file));handoverRouting(f);
});

test('T8 hook merge keeps foreign guard and sibling commands; opt-out is exact and idempotent',()=>{
  const foreign={type:'command',command:'foreign guard'}, near={command:'node /foreign/scripts/memory/new-session.mjs detect'};
  const settings={hooks:{UserPromptSubmit:[{matcher:'host',hooks:[foreign,{command},near]}]},permissions:{allow:['Read',sessionPermission,'Write',sessionPermission],deny:['Bash(rm *)']}};
  assert.equal(mergeNewSessionHooks(settings,session),true);
  assert.deepEqual(settings.permissions.allow,['Read',sessionPermission,'Write',powerShellPermission]);
  assert.deepEqual(settings.hooks.UserPromptSubmit[0].hooks,[foreign,{command},near]);
  assert.equal(mergeNewSessionHooks(settings,session),false);
  assert.equal(mergeNewSessionHooks(settings,session,false),true);
  assert.deepEqual(settings.hooks.UserPromptSubmit,[{matcher:'host',hooks:[foreign,near]}]);
  assert.deepEqual(settings.permissions,{allow:['Read','Write'],deny:['Bash(rm *)']});
  assert.equal(mergeNewSessionHooks(settings,session,false),false);
});

test('T8 install dry-run and check report wiring and foreign skills without any writes',t=>{
  const f=fixture(t);put(path.join(f.target,skillFile),'# Foreign start\n');fs.mkdirSync(path.join(f.target,'.codex'));
  const before=snapshot(f);
  for(const flag of ['--dry-run','--check']) {
    const r=ok(f.install([flag]));
    for(const pattern of [/new-session hook: would add/,/Bash\(node scripts\/memory\/new-session.mjs:\*\)/,/Session phrases gate line: would add/,/WRITE/,/WARN foreign skill kept/,/Session overlay template:/]) assert.match(r.stdout,pattern);
    assert.doesNotMatch(r.stdout,/\badded\b|\bupdated\b/);
    assert.deepEqual(snapshot(f),before);
  }
});

test('T8 install preserves foreign hooks beside guard and independent phrase hook; refuses reinstall',t=>{
  const f=fixture(t),file=path.join(f.target,'.claude/settings.json');
  const foreign={hooks:[{type:'command',command:'foreign guard'}]};
  put(file,JSON.stringify({hooks:{UserPromptSubmit:[foreign]},permissions:{allow:['Read'],deny:['Write']}}));
  ok(f.install());
  const settings=json(file);
  assert.deepEqual(settings.hooks.UserPromptSubmit[0],foreign);
  assert.equal(settings.hooks.UserPromptSubmit.length,3);
  assert.equal(settings.hooks.UserPromptSubmit.filter(e=>e.hooks.some(h=>h.command===command)).length,1);
  assert.deepEqual(settings.permissions,{allow:['Read',sessionPermission,powerShellPermission],deny:['Write']});
  const before=snapshot(f);assert.equal(f.install().status,1);assert.deepEqual(snapshot(f),before);
});

test('T8 opt-out persists without guard and true restores hook and permission at equal version',t=>{
  const f=fixture(t);ok(f.install(['--no-guard']));
  const file=path.join(f.target,'.claude/settings.json'),local=path.join(f.target,localFile);
  assert.equal(json(file).hooks.UserPromptSubmit.length,1);assert.equal(json(file).hooks.PreToolUse,undefined);
  ok(upgrade(f,['--no-new-session-hook']));assert.equal(json(local).newSessionHook,false);
  assert.equal(json(file).hooks.UserPromptSubmit.length,0);assert.ok(!json(file).permissions.allow.includes(sessionPermission));
  ok(upgrade(f));assert.equal(json(file).hooks.UserPromptSubmit.length,0);
  put(local,JSON.stringify({...json(local),newSessionHook:true}));
  const before=snapshot(f);assert.equal(upgrade(f,['--check']).status,1);assert.deepEqual(snapshot(f),before);
  ok(upgrade(f));assert.equal(json(file).hooks.UserPromptSubmit.length,1);assert.ok(json(file).permissions.allow.includes(sessionPermission));
  const stable=tree(f.target);ok(upgrade(f));assert.deepEqual(tree(f.target),stable);
});

test('T8 install opt-out removes only the kit phrase entry and preserves preferences',t=>{
  const f=fixture(t),file=path.join(f.target,'.claude/settings.json');
  put(file,JSON.stringify({hooks:{UserPromptSubmit:[...session.hooks.UserPromptSubmit,{hooks:[{command:'foreign guard'}]}]},permissions:{allow:[sessionPermission,'Read']}}));
  put(path.join(f.target,localFile),JSON.stringify({extra:42}));ok(f.install(['--no-new-session-hook']));
  assert.deepEqual(json(file).permissions.allow,['Read']);
  assert.ok(json(file).hooks.UserPromptSubmit.some(e=>e.hooks.some(h=>h.command==='foreign guard')));
  assert.ok(!json(file).hooks.UserPromptSubmit.some(e=>e.hooks.some(h=>h.command===command)));
  assert.deepEqual(json(path.join(f.target,localFile)),{extra:42,newSessionHook:false});
});

test('T8 foreign skills are kept, persisted, never adopted or force-replaced; named replacement backs up',t=>{
  const f=fixture(t),names=['memory-ladder','memory-review','new-session','handover'];
  for(const name of names) put(path.join(f.target,`.claude/skills/${name}/SKILL.md`),'# Foreign '+name+'\n');
  const r=ok(f.install(['--force-skills','--backup']));assert.match(r.stdout,/WARN foreign skill kept/);
  for(const name of names) {
    assert.equal(read(path.join(f.target,`.claude/skills/${name}/SKILL.md`)),'# Foreign '+name+'\n');
    assert.ok(!Object.hasOwn(json(path.join(f.target,manifestFile)).files,`.claude/skills/${name}/SKILL.md`));
  }
  assert.deepEqual(json(path.join(f.target,localFile)).foreignSkills,names.sort());
  // Matching incoming bytes must not erase persisted foreign ownership on the next run.
  put(path.join(f.target,skillFile),read(path.join(kitRoot,'skills/new-session/SKILL.md')));
  ok(upgrade(f,['--force-skills']));assert.ok(!Object.hasOwn(json(path.join(f.target,manifestFile)).files,skillFile));
  put(path.join(f.target,skillFile),'# Foreign replacement backup\n');
  ok(upgrade(f,['--replace-skill','new-session']));
  assert.ok(Object.hasOwn(json(path.join(f.target,manifestFile)).files,skillFile));
  assert.ok(!json(path.join(f.target,localFile)).foreignSkills.includes('new-session'));
  assert.ok(fs.readdirSync(path.join(f.target,'scripts/memory')).filter(n=>n.startsWith('.kit-backup-')).some(n=>{
    const p=path.join(f.target,'scripts/memory',n,skillFile);return fs.existsSync(p)&&read(p)==='# Foreign replacement backup\n';
  }));
});

for(const name of ['new-session','handover']) test('T8 T-H8 explicit foreign replacement on install backs up without blanket backup flag: '+name,t=>{
  const f=fixture(t),skillFile=`.claude/skills/${name}/SKILL.md`;put(path.join(f.target,skillFile),'# Foreign\n');ok(f.install(['--replace-skill',name]));
  assert.equal(hash(path.join(f.target,skillFile)),hash(path.join(kitRoot,`skills/${name}/SKILL.md`)));
  const backup=fs.readdirSync(path.join(f.target,'scripts/memory')).find(n=>n.startsWith('.kit-backup-'));
  assert.equal(read(path.join(f.target,'scripts/memory',backup,skillFile)),'# Foreign\n');
});

test('T9 gate line is scoped, once, byte-preserving and warns without heading',t=>{
  const f=fixture(t),file=path.join(f.target,'AGENTS.md');
  for(const eol of ['\n','\r\n']) for(const prior of ['', '- Session phrases: old\n']) {
    const original=('# Host\n- Session phrases: outside\n## Memory gate\n- First\n'+prior+'- Last\n\nProse.\n## Other rules\n- other bullet\n- Session phrases: host custom\n## Session overlay\nafter-go: a | b\n').replaceAll('\n',eol);
    put(file,original);const plan=gateLinePlan(f.target,kitRoot);assert.ok(plan);
    const expected=prior?original.replace('- Session phrases: old',gateLine):original.replace('- Last'+eol,'- Last'+eol+gateLine+eol);
    assert.equal(plan[1],expected);put(file,plan[1]);assert.equal(gateLinePlan(f.target,kitRoot),null);
  }
  put(file,'## Other\n');assert.equal(gateLinePlan(f.target,kitRoot),null);assert.equal(read(file),'## Other\n');
  put(file,'## Memory gateway\n- Other\n');assert.equal(gateLinePlan(f.target,kitRoot),null);assert.equal(read(file),'## Memory gateway\n- Other\n');
  put(file,'## Memory gate');assert.equal(gateLinePlan(f.target,kitRoot)[1],'## Memory gate\n'+gateLine+'\n');
  fs.unlinkSync(file);put(path.join(f.target,'CLAUDE.md'),'## Memory gate\n- Last\n');assert.equal(path.basename(gateLinePlan(f.target,kitRoot)[0]),'CLAUDE.md');
});

test('T9 unknown unchanged files refuse before any write; edited files stay; retired files back up',t=>{
  const f=fixture(t);ok(f.install());
  const extra='scripts/memory/unknown.mjs',dest=put(path.join(f.target,extra),'// unknown\n'),m=json(path.join(f.target,manifestFile));
  m.files[extra]=hash(dest);put(path.join(f.target,manifestFile),JSON.stringify(m));
  const options=denyWrites(f,true);
  assert.deepEqual(lockFiles(f),[]);
  withMemoryLock(f.memory,()=>{
    const before=snapshot(f);
    for(const args of [[],['--check']]) {const r=upgrade(f,args,options);assert.equal(r.status,1);assert.match(r.stdout+r.stderr,/unknown owned file: scripts\/memory\/unknown.mjs; remove or restore the file, or list it in retired/);assert.doesNotMatch(r.stderr,/forbidden write|lock timed out/);assert.deepEqual(snapshot(f),before);assert.deepEqual(lockFiles(f),['.memory.lock']);}
  });
  assert.deepEqual(lockFiles(f),[]);
  put(dest,'// edited unknown\n');ok(upgrade(f,['--force-skills']));assert.equal(read(dest),'// edited unknown\n');
});

test('T9 T-H9 stage-2 wave-save hooks refuse install and upgrade before writes with guard disabled',t=>{
  for(const installed of [false,true]) for(const settingsName of ['settings.json','settings.local.json']) {
    const f=fixture(t);if(installed) ok(f.install(['--no-guard']));
    const file=path.join(f.target,'.claude',settingsName),settings=fs.existsSync(file)?json(file):{};
    const commands={...stage2,FutureEvent:'node scripts/memory/wave-save.mjs future',MixedCase:'node scripts/memory/Wave-Save.mjs resume',UpperCase:'node scripts/memory/WAVE-SAVE.MJS precompact'};
    settings.hooks??={};for(const [event,command] of Object.entries(commands)) settings.hooks[event]=[{hooks:[{command}]}];put(file,JSON.stringify(settings));
    put(path.join(f.target,'scripts/memory/wave-save.mjs'),'// presence does not grant awareness\n');
    fs.mkdirSync(f.memory,{recursive:true});
    const options=denyWrites(f,true);
    assert.deepEqual(lockFiles(f),[]);
    withMemoryLock(f.memory,()=>{
    const before=snapshot(f);
    for(const args of [[],['--check'],['--no-guard']]) {
      const r=installed?upgrade(f,args,options):f.install(args);assert.equal(r.status,1);
      for(const [event,command] of Object.entries(commands)) assert.ok((r.stdout+r.stderr).includes(`wave-save refused: ${event}: ${command}; ${settingsName}`));
      assert.match(r.stdout+r.stderr,/install a wave-save release that supports handover.*no override/);
      assert.doesNotMatch(r.stderr,/forbidden write|lock timed out/);
      assert.deepEqual(snapshot(f),before);
      assert.deepEqual(lockFiles(f),['.memory.lock']);
    }
    });
    assert.deepEqual(lockFiles(f),[]);
  }
});

test('T9 T-H9 only a true incoming ledger marker lifts the hook refusal',t=>{
  const f=fixture(t),root=path.join(f.root,'candidate');fs.mkdirSync(root);
  put(path.join(root,'MANIFEST.json'),JSON.stringify({files:{'engine/wave-save.mjs':{hash:'hash',supportsHandover:true}}}));
  put(path.join(root,'KIT.json'),JSON.stringify({waveSave:{supportsHandover:true}}));
  put(path.join(root,'engine/wave-save.mjs'),'// present\n');
  put(path.join(f.target,'.claude/settings.json'),JSON.stringify({hooks:{Stop:[{hooks:[{command:'node wave-save.mjs stop'}]}]}}));
  for(const waveSave of [undefined,{supportsHandover:false},{supportsHandover:'true'},{supportsHandover:1},true]) {
    put(path.join(root,'engine/upgrades.json'),JSON.stringify([{supportsHandover:true,waveSave}]));
    assert.equal(distributionRefusals(f.target,root).length,1);
  }
  put(path.join(root,'engine/upgrades.json'),JSON.stringify([{id:'old',waveSave:{supportsHandover:true}},{id:'later'}]));
  assert.deepEqual(distributionRefusals(f.target,root),[]);
});

test('T10 mirrors create for Codex only and only for current session skills',t=>{
  const f=fixture(t),names=['new-session','handover','memory-ladder','memory-review'];
  const planned=names.map(name=>[path.join(f.target,`.claude/skills/${name}/SKILL.md`),Buffer.from('# '+name+'\n')]);
  assert.deepEqual(mirrorWrites(f.target,planned,new Map()),[]);
  for(const marker of ['.agents/skills','.agents','.codex']) {
    const target=path.join(f.root,marker.replaceAll('/','-'));fs.mkdirSync(path.join(target,marker),{recursive:true});
    const copies=planned.map(([file,data])=>[path.join(target,path.relative(f.target,file)),data]);
    const result=mirrorWrites(target,copies,new Map());assert.equal(result.length,2);assert.deepEqual(result.map(([file])=>path.basename(path.dirname(file))),['new-session','handover']);
    for(const [file,data] of result) {assert.match(file,/\.agents[\\/]skills/);put(file,data);}
    assert.equal(mirrorWrites(target,copies,new Map()).length,2);
    for(const [file,data] of copies) put(file,data);
    const refreshed=mirrorWrites(target,copies.map(([file])=>[file,Buffer.from('# New revision\n')]),new Map());
    assert.equal(refreshed.length,2);assert.ok(refreshed.every(([,data])=>String(data)==='# New revision\n'));
  }
});

test('T10 install divergent mirror refuses or backs up explicit replacement; upgrade skips',t=>{
  const f=fixture(t),mirror=put(path.join(f.target,'.agents/skills/new-session/SKILL.md'),'# Divergent\n');
  const before=snapshot(f),r=f.install();assert.equal(r.status,1);assert.match(r.stderr,/skill mirror differs/);assert.deepEqual(snapshot(f),before);
  ok(f.install(['--replace-skill','new-session']));assert.equal(read(mirror),read(path.join(f.target,skillFile)));
  const backup=fs.readdirSync(path.join(f.target,'scripts/memory')).find(n=>n.startsWith('.kit-backup-'));
  assert.equal(read(path.join(f.target,'scripts/memory',backup,'.agents/skills/new-session/SKILL.md')),'# Divergent\n');
  put(mirror,'# Keep divergent\n');const checked=upgrade(f,['--check']);assert.match(checked.stdout,/WARN mirror differs:.*; kept; copy/);
  const applied=ok(upgrade(f,['--force-skills']));assert.match(applied.stdout,/WARN mirror differs:.*; kept; copy/);assert.equal(read(mirror),'# Keep divergent\n');
});

test('T10 equal-version upgrade repairs missing mirror hook permission and gate; restore round-trips',t=>{
  const f=fixture(t);ok(f.install());fs.mkdirSync(path.join(f.target,'.codex'));
  const settingsFile=path.join(f.target,'.claude/settings.json'),settings=json(settingsFile);
  settings.hooks.UserPromptSubmit=settings.hooks.UserPromptSubmit.filter(e=>!e.hooks.some(h=>h.command===command));settings.permissions.allow=[];put(settingsFile,JSON.stringify(settings));
  const agents=path.join(f.target,'AGENTS.md');put(agents,read(agents).replace(gateLine+'\n',''));
  const before=tree(f.target),checked=upgrade(f,['--check']);assert.equal(checked.status,1);assert.deepEqual(tree(f.target),before);
  const applied=ok(upgrade(f));assert.match(applied.stdout,/Session phrases gate line: added/);
  assert.equal(read(agents).split(gateLine).length,2);
  assert.equal(read(path.join(f.target,'.agents/skills/new-session/SKILL.md')),read(path.join(f.target,skillFile)));
  const mirror=path.join(f.target,'.agents/skills/new-session/SKILL.md');put(mirror,read(mirror).replace(/\r?\n/g,'\r\n'));
  const stable=tree(f.target,{previous:true});assert.match(ok(upgrade(f)).stdout,/same version and hashes; no-op/);assert.deepEqual(tree(f.target,{previous:true}),stable);
  const backup=path.join(f.target,'scripts/memory',fs.readdirSync(path.join(f.target,'scripts/memory')).find(n=>n.startsWith('.kit-backup-')));
  ok(upgrade(f,['--restore',backup]));assert.deepEqual(tree(f.target),before);
});

test('T11 new hook template is a kit-root read, never an owned project file',()=>{
  assert.ok(!ownedFiles(kitRoot).includes('templates/settings.newsession.json'));
  assert.equal(session.hooks.UserPromptSubmit.length,1);assert.deepEqual(session.hooks.UserPromptSubmit[0].hooks[0],{type:'command',shell:'bash',command,timeout:5});
});

for(const defect of ['gate','mirror','permission']) test('T10 equal-version repair of only missing '+defect,t=>{
  const f=fixture(t);ok(f.install());
  const agents=path.join(f.target,'AGENTS.md'),settingsFile=path.join(f.target,'.claude/settings.json');
  if(defect==='gate') put(agents,read(agents).replace(gateLine+'\n',''));
  if(defect==='mirror') fs.mkdirSync(path.join(f.target,'.codex'));
  if(defect==='permission') {const settings=json(settingsFile);settings.permissions.allow=settings.permissions.allow.filter(value=>value!==sessionPermission);put(settingsFile,JSON.stringify(settings));}
  const before=snapshot(f),checked=upgrade(f,['--check']);assert.equal(checked.status,1);assert.deepEqual(snapshot(f),before);
  assert.doesNotMatch(checked.stdout,/\badded\b|\bupdated\b/);
  ok(upgrade(f));assert.ok(read(agents).includes(gateLine));assert.ok(json(settingsFile).permissions.allow.includes(sessionPermission));
  if(defect==='mirror') assert.equal(read(path.join(f.target,'.agents/skills/new-session/SKILL.md')),read(path.join(f.target,skillFile)));
  assert.equal(upgrade(f,['--check']).status,0);
});

for(const name of ['new-session','handover']) test('T9 settled foreign skill checks clean, missing foreign skill installs once: '+name,t=>{
  const skillFile=`.claude/skills/${name}/SKILL.md`,f=fixture(t),file=path.join(f.target,skillFile);put(file,'# Host skill\n');ok(f.install());
  const before=snapshot(f);assert.equal(upgrade(f,['--check']).status,0);assert.deepEqual(snapshot(f),before);
  fs.unlinkSync(file);const missing=snapshot(f),checked=upgrade(f,['--check']);assert.equal(checked.status,1);assert.deepEqual(snapshot(f),missing);
  const result=ok(upgrade(f));assert.equal((result.stdout.match(/WARN foreign skill gone:/g)??[]).length,1);
  assert.equal(read(file),read(path.join(kitRoot,`skills/${name}/SKILL.md`)));
  assert.deepEqual(json(path.join(f.target,localFile)).foreignSkills,[]);
  assert.ok(Object.hasOwn(json(path.join(f.target,manifestFile)).files,skillFile));
  const next=ok(upgrade(f));assert.doesNotMatch(next.stdout,/foreign skill gone/);assert.equal(upgrade(f,['--check']).status,0);
});

test('T10 legacy mirrors refresh identical source and skip divergent copies',t=>{
  const f=fixture(t);
  for(const name of ['memory-ladder','memory-review']) {
    const source=put(path.join(f.target,`.claude/skills/${name}/SKILL.md`),'# Old kit\n');
    const mirror=put(path.join(f.target,`.agents/skills/${name}/SKILL.md`),'# Old kit\r\n');
    assert.deepEqual(mirrorWrites(f.target,[[source,'# New kit\n']],new Map(),{keepDivergent:true}),[[mirror,'# New kit\n']]);
    put(mirror,'# Host variant\n');
    assert.deepEqual(mirrorWrites(f.target,[[source,'# New kit\n']],new Map(),{keepDivergent:true}),[]);
    assert.equal(read(mirror),'# Host variant\n');
  }
});

test('T8 hook recognition accepts path quoting and variable spellings without reordering permissions',()=>{
  for(const prefix of ['','./','${CLAUDE_PROJECT_DIR}/','$CLAUDE_PROJECT_DIR/','${CLAUDE_PROJECT_DIR:-.}/']) for(const quote of ['',"'",'"']) {
    const own=`node ${quote}${prefix}scripts/memory/new-session.mjs${quote} ${quote}detect${quote}`;
    const settings={hooks:{UserPromptSubmit:[{hooks:[{command:own}]}]},permissions:{allow:['Read',sessionPermission,'Write',powerShellPermission]}};
    const before=structuredClone(settings);assert.equal(mergeNewSessionHooks(settings,session),false);assert.deepEqual(settings,before);
    mergeNewSessionHooks(settings,session,false);assert.deepEqual(settings.hooks.UserPromptSubmit,own===command?[]:before.hooks.UserPromptSubmit);assert.deepEqual(settings.permissions.allow,['Read','Write']);
  }
});

for (const variable of ['$CLAUDE_PROJECT_DIR', '${CLAUDE_PROJECT_DIR}']) for (const installed of [false, true]) test(`T8 fix2.2 quoted variable with unquoted path on ${installed ? 'upgrade' : 'install'}: ${variable}`, t => {
  const f = fixture(t);
  if (installed) ok(f.install());
  const file = path.join(f.target, '.claude/settings.json'), settings = json(file);
  const own = `node "${variable}"/scripts/memory/new-session.mjs detect`;
  settings.hooks = {UserPromptSubmit: [{hooks: [{type: 'command', command: own}]}]};
  put(file, JSON.stringify(settings));
  ok(installed ? upgrade(f) : f.install());
  const hooks = json(file).hooks.UserPromptSubmit.flatMap(entry => entry.hooks).filter(hook => hook.command.includes('new-session.mjs'));
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].command, own);
});

test('T8 malformed hook entries refuse install and upgrade before any write with named errors',t=>{
  for(const installed of [false,true]) {
    const f=fixture(t);if(installed) ok(f.install());
    const file=path.join(f.target,'.claude/settings.json'),options=denyWrites(f);
    for(const bad of [null,7,'host',false]) for(const nested of [false,true]) {
      put(file,JSON.stringify({hooks:{UserPromptSubmit:[nested?{hooks:[bad]}:bad]}}));
      const before=snapshot(f),result=installed?upgrade(f,[],options):f.install();
      assert.equal(result.status,1);assert.match(result.stderr,/settings.json hooks.UserPromptSubmit\[0\](?:\.hooks\[0\])? must be an object/);
      assert.doesNotMatch(result.stderr,/TypeError|forbidden write/);assert.deepEqual(snapshot(f),before);
    }
  }
});

test('T9 check never attempts writes or a memory lock for clean and pending projects',t=>{
  const f=fixture(t);ok(f.install());const options=denyWrites(f);
  for(const pending of [false,true]) {
    if(pending) put(path.join(f.target,'AGENTS.md'),read(path.join(f.target,'AGENTS.md')).replace(gateLine,'- Session phrases: old'));
    const before=snapshot(f),result=upgrade(f,['--check'],options);
    assert.equal(result.status,pending?1:0,result.stdout+result.stderr);assert.doesNotMatch(result.stderr,/forbidden write/);
    if(pending) assert.match(result.stdout,/Session phrases gate line: would update/);
    assert.deepEqual(snapshot(f),before);assert.deepEqual(lockFiles(f),[]);
  }
});

test('T9 install and updater recognize Memory gate with trailing text',t=>{
  const f=fixture(t),file=path.join(f.target,'AGENTS.md'),tail='## Other rules\n- other bullet\n- Session phrases: host custom\n';
  put(file,'## Memory gate (kit)\n- Existing rule\n'+tail);ok(f.install());
  assert.equal(read(file),'## Memory gate (kit)\n- Existing rule\n'+gateLine+'\n'+tail);
  put(file,read(file).replace(gateLine+'\n',''));ok(upgrade(f));
  assert.equal(read(file),'## Memory gate (kit)\n- Existing rule\n'+gateLine+'\n'+tail);
});
