import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,put,read,json,ok,kitRoot,tree,currentVersion} from './helpers.mjs';
import {install as hook,marker} from '../engine/install-hooks.mjs';
import {matchEol,writeText} from '../engine/lib.mjs';
import {migrateRoutes} from '../engine/memory-migrate.mjs';
const config=()=>json(path.join(kitRoot,'engine/memory.config.json'));
for(const mode of ['in-repo','separate']) test('failing gate skips hook '+mode,t=>{
 const f=fixture(t),memory=mode==='in-repo'?path.join(f.target,'.claude/memory'):f.memory;
 put(path.join(memory,'MEMORY.md'),'- [State](current-state.md)\n- [Lesson](lesson-001-x.md)\n');
 put(path.join(memory,'current-state.md'),'---\nname: current-state\n---\nState.\n');
 put(path.join(memory,'lesson-001-x.md'),'---\nname: lesson-001-x\ndescription: X\n---\nX.\n');
 const r=f.install(['--memory-dir',memory]);assert.equal(r.status,1);
 assert.equal(fs.existsSync(path.join(mode==='in-repo'?f.target:memory,'.git/hooks/pre-commit')),false);
 assert.match(r.stdout+r.stderr,/FAIL/);assert.match(r.stdout+r.stderr,/node scripts\/memory\/install-hooks\.mjs .*--memory-dir/);
});
for(const pattern of ['.claude/','.claude/*','scripts/']) test('preflight refuses without writes '+pattern,t=>{
 const f=fixture(t);put(path.join(f.target,'.gitignore'),pattern+'\n');const before=tree(f.target),r=f.install();
 assert.equal(r.status,1);assert.deepEqual(tree(f.target),before);assert.equal(fs.existsSync(f.memory),false);
});
test('700 link rows regenerate and custom prose splits in order',t=>{
 const f=fixture(t);put(path.join(f.memory,'MEMORY.md'),'- [Craft](INDEX-craft.md) OPEN BEFORE craft.\n');
 const rows=[];for(let n=1;n<=700;n++) {const name=`lesson-${String(n).padStart(3,'0')}-a`;rows.push(`- [${name}](${name}.md)\n`);put(path.join(f.memory,name+'.md'),`---\nname: ${name}\ndescription: A\n---\nBody.\n`);}
 const custom=Array.from({length:300},(_,n)=>`- [Custom words ${n} ${'detail '.repeat(10)}](lesson-001-a.md)\n`).join('');
 put(path.join(f.memory,'INDEX-craft.md'),rows.join('')+custom);
 const result=migrateRoutes({memoryDir:f.memory,config:config(),write:true});assert.equal(result.regenerated.length,700);
 const notes=result.navigation.filter(n=>/^index-notes-craft/.test(n)).sort((a,b)=>Number(/-(\d+)\.md$/.exec(a)?.[1]??1)-Number(/-(\d+)\.md$/.exec(b)?.[1]??1));
 assert.ok(notes.length>1);let joined='';for(const file of notes){const text=read(path.join(f.memory,file));assert.ok(Buffer.byteLength(text)<=config().caps.topic.failBytes);joined+=text.replace(/^---\n[\s\S]*?\n---\n/,'');}
 assert.equal(joined,custom);
});
test('fleet isolates malformed config',t=>{
 const f=fixture(t);put(path.join(f.target,'scripts/memory/memory.config.json'),'{bad');
 const other=path.join(f.root,'other');fs.mkdirSync(other);f.git(other,'init');
 const r=ok(f.cli('engine/memory-fleet.mjs',['--root',f.root,'--memory-home',path.join(f.root,'absent'),'--json']));
 const rows=JSON.parse(r.stdout).projects;assert.match(rows.find(p=>p.project===f.target).status,/^bad config \(.+\)$/);assert.ok(rows.find(p=>p.project===other));
});
test('private memory ignore is never negated',t=>{
 const f=fixture(t);put(path.join(f.target,'.gitignore'),'docs/memory/\n');const before=tree(f.target);
 const r=f.install(['--memory-dir',path.join(f.target,'docs/memory')]);assert.equal(r.status,1);assert.deepEqual(tree(f.target),before);assert.match(r.stdout+r.stderr,/memory.*ignored|ignored.*memory/i);
});
test('kept legacy skill warns without perpetual check failure',t=>{
 const f=fixture(t);ok(f.install());const file=path.join(f.target,'.claude/skills/memory-ladder/SKILL.md');
 put(file,read(file).replace(/metadata:\r?\n  engine_version:/,'engine_version:')+'\nHost addition.\n');
 const r=ok(f.cli('scripts/upgrade.mjs',['--target',f.target,'--check']));assert.match(r.stdout,/WARN.*metadata.engine_version/);assert.equal((r.stdout.match(/WARN/g)||[]).length,1);
});
test('owned hook recognition and uninstall preserve host hook',t=>{
 const f=fixture(t),memoryDir=path.join(f.target,'memory'),file=path.join(f.target,'.git/hooks/pre-commit');fs.mkdirSync(memoryDir);
 assert.ok(hook({repo:f.target,memoryDir}).ok);assert.match(read(file),new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 assert.match(hook({repo:f.target,memoryDir}).message,/kit hook present/);
 hook({repo:f.target,memoryDir,uninstall:true});assert.equal(fs.existsSync(file),false);
 put(file,'#!/bin/sh\necho host\n');hook({repo:f.target,memoryDir,uninstall:true});assert.equal(read(file),'#!/bin/sh\necho host\n');
});
test('non-git in-repo host refuses before writes',t=>{
 const f=fixture(t),target=path.join(f.root,'plain');fs.mkdirSync(target);const before=tree(target);
 const r=f.cli('scripts/install.mjs',['--target',target,'--memory-dir',path.join(target,'memory')]);assert.equal(r.status,1);assert.deepEqual(tree(target),before);assert.match(r.stderr,/in-repo memory.*git repository/i);
});
test('mixed line endings preserve unchanged lines and majority for changes',t=>{
 const f=fixture(t),file=path.join(f.target,'mixed.txt'),original='one\r\ntwo\nthree\nfour\n';
 assert.equal(matchEol('one\ntwo\nTHREE\nfour\nnew\n',original),'one\r\ntwo\nTHREE\nfour\nnew\n');
 put(file,original);writeText(file,original+'new\n');assert.equal(read(file),original+'new\n');
 assert.equal(matchEol('four\n'+original,original),'four\n'+original);
 assert.equal(matchEol('one\ntwo\nTHREE\nfour\nnew\n','one\ntwo\r\nthree\r\nfour\r\n'),'one\ntwo\r\nTHREE\r\nfour\r\nnew\r\n');
});
test('fleet in-repo version status',t=>{
 const f=fixture(t);ok(f.install(['--memory-dir',path.join(f.target,'memory')]));
 const scan=()=>JSON.parse(ok(f.cli('engine/memory-fleet.mjs',['--root',f.root,'--memory-home',path.join(f.root,'absent'),'--json'])).stdout).projects.find(p=>p.project===f.target);
 assert.equal(scan().status,'in-repo, current');put(path.join(f.target,'scripts/memory/KIT.json'),JSON.stringify({version:'0.0.1'}));assert.equal(scan().status,'in-repo, behind');
});
