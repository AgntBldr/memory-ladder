import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {manifest,ownedFiles} from '../scripts/manifest.mjs';
import {fixture,ok,read,json,put,kitRoot,files} from './helpers.mjs';

test('K.8 README documents help and CHANGELOG records the three shipped follow-ups',()=>{
  const readme=read(path.join(kitRoot,'README.md'));
  assert.match(readme.split('```')[1],/node scripts\/install\.mjs --help/);
  assert.doesNotMatch(readme, /## Unreleased \(after v3\.1\.0-beta\)/);
  const section=read(path.join(kitRoot,'CHANGELOG.md')).split('## 3.2.0\n\n')[1]?.split('\n\n')[0];
  assert.ok(section);
  const bullets=section.trim().split('\n').filter(line=>line.startsWith('- '));
  assert.equal(bullets.length,3);
  assert.match(bullets[0],/memory-ladder\.md.*exist/);
  assert.match(bullets[1],/install.*brain index/i);
  assert.match(bullets[2],/--help.*-h/);
});
test('K.1 VERSION equals engine version, manifest matches every owned file and encoding is clean',()=>{
  assert.equal(read(path.join(kitRoot,'VERSION')).trim(),json(path.join(kitRoot,'engine/memory.config.json')).engine_version);
  assert.deepEqual(json(path.join(kitRoot,'MANIFEST.json')),manifest());
  assert.ok(ownedFiles(kitRoot).includes('engine/memory.test.mjs'));assert.ok(!ownedFiles(kitRoot).includes('engine/memory.config.json'));
  for(const file of files(kitRoot).filter(f=>!/^docs\/diagrams\/png\/[^/]+\.png$/.test(f)&&!f.split('/').some(part=>part==='.git'||part==='node_modules'))) {const data=fs.readFileSync(path.join(kitRoot,file));assert.ok(!data.includes(Buffer.from([239,187,191])),file+' BOM');assert.ok(!data.includes(13),file+' CRLF');}
});
test('fresh install supports documented first checkpoint, probes and undo hook',t=>{
  const f=fixture(t);ok(f.install());const args=['--repo',f.target,'--memory-dir',f.memory];
  ok(f.cli('scripts/memory/memory-recall.mjs',[...args,'--probe'],f.target));
  ok(f.cli('scripts/memory/memory-measure.mjs',[...args,'--write','first'],f.target));
  const remote=path.join(f.root,'backup.git');f.git(f.root,'init','--bare',remote);f.git(f.memory,'remote','add','origin',remote);f.git(f.memory,'push','-u','origin','HEAD');
  assert.match(ok(f.cli('scripts/memory/memory-check.mjs',args,f.target)).stdout,/0 FAIL, 0 WARN, 0 allowed/);
  ok(f.cli('scripts/memory/install-hooks.mjs',[...args,'--uninstall'],f.target));assert.ok(!fs.existsSync(path.join(f.memory,'.git/hooks/pre-commit')));
});
test('distributed skills retain conversion and hard-rule operational constraints',()=>{
  const ladder=read(path.join(kitRoot,'skills/memory-ladder/SKILL.md')).replace(/\n/g,' '),review=read(path.join(kitRoot,'skills/memory-review/SKILL.md')).replace(/\n/g,' ');
  for(const rule of [/at or below 2 KB/,/paths, commands, ids, quotas, and accounts/,/Tag and snapshot the original FIRST/,/name EVERY destination and legal cut point/,/different model list every original imperative/,/test recall and run the gate BEFORE adoption/,/Never raise a pin/,/one current block/]) assert.match(ladder,rule);
  assert.match(review,/Never raise a pin or allow ceiling/);assert.match(review,/at most\s+2 KB/);
});
