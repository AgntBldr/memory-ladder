import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fixture,ok,put,read} from './helpers.mjs';
test('installed in-repo hook commits indexed sibling links and blocks dead links',t=>{
  const f=fixture(t),memory=path.join(f.target,'memory');
  put(path.join(f.target,'docs/a.md'),'# Document\n');
  ok(f.install(['--memory-dir',memory]));
  const router=path.join(memory,'MEMORY.md');put(router,read(router)+'\n[Document](../docs/a.md)\n');
  f.git(f.target,'add','.');
  const commit=()=>f.exec('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','Memory update']);
  const first=ok(commit());assert.match(first.stdout+first.stderr,/0 FAIL/);
  put(router,read(router).replace('../docs/a.md','../docs/missing.md'));f.git(f.target,'add','memory');
  const blocked=commit();assert.notEqual(blocked.status,0);assert.match(blocked.stdout+blocked.stderr,/link.dead/);
  assert.equal(f.git(f.target,'rev-list','--count','HEAD'),'1');
});
