import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture, put, read} from './helpers.mjs';
import {migrateRoutes, checkRouterTriggers} from '../engine/memory-migrate.mjs';

function routeFixture(t, lines, eol = '\n') {
  const f = fixture(t);
  put(path.join(f.memory, 'MEMORY.md'), lines.join(eol) + eol);
  for (const name of ['infra', 'infra-2']) put(path.join(f.memory, `INDEX-${name}.md`), '# Infra\n\n- [Lesson](lesson.md) - maintain tools\n');
  put(path.join(f.memory, 'lesson.md'), '---\nname: lesson\ndescription: maintain tools\nmetadata:\n  type: feedback\n---\nMaintain tools.\n');
  return f;
}
const first = '- [Infra](INDEX-infra.md) - OPEN when work touches a sample toolchain.';
const second = '- [Infra 2](INDEX-infra-2.md) - OPEN when work touches builds, packages, the ExampleRunner, etc.';
for (const ending of ['.', '!', '?']) test('K327 untriggered wrapped row before triggered sibling: ' + ending, t => {
  const lines = ['- [Infra](INDEX-infra.md) - tooling pages.', '  see the docs.', second.replace(/\.$/, ending)];
  const f = routeFixture(t, lines);
  assert.doesNotThrow(() => migrateRoutes({memoryDir: f.memory, write: true}));
  assert.equal(read(path.join(f.memory, 'MEMORY.md')), lines.join('\n').replaceAll('(INDEX-infra-2.md)', '(INDEX-infra.md)') + '\n');
});
for (const continuation of ['Or disk usage.', 'And disk usage.', ', disk usage.', '; OPEN when checking disk usage.']) test('K327 continuation preserved and loss detected: ' + continuation, t => {
  const lines = [first, second, '  ' + continuation];
  const f = routeFixture(t, lines);
  assert.throws(() => checkRouterTriggers(lines.join('\n'), [first, second].join('\n')), /migration router trigger loss: MEMORY.md line 2/);
  migrateRoutes({memoryDir: f.memory, write: true});
  assert.equal(read(path.join(f.memory, 'MEMORY.md')), lines.join('\n').replaceAll('(INDEX-infra-2.md)', '(INDEX-infra.md)') + '\n');
});
test('K327 CRLF wrapped router preserves continuation', t => {
  const lines = [first, second, '  or disk usage.'];
  const f = routeFixture(t, lines, '\r\n');
  assert.match(read(path.join(f.memory, 'MEMORY.md')), /\r\n/);
  migrateRoutes({memoryDir: f.memory, write: true});
  assert.equal(read(path.join(f.memory, 'MEMORY.md')), lines.join('\r\n').replaceAll('(INDEX-infra-2.md)', '(INDEX-infra.md)') + '\r\n');
});
for (const position of ['first', 'second']) test('K327 wrapped alternative stays in router: ' + position, t => {
  const lines = position === 'second' ? [first, second, '  or disk usage.'] : [second, '  or disk usage.', first];
  const f = routeFixture(t, lines);
  migrateRoutes({memoryDir: f.memory, write: true});
  assert.equal(read(path.join(f.memory, 'MEMORY.md')), lines.join('\n').replaceAll('(INDEX-infra-2.md)', '(INDEX-infra.md)') + '\n');
  for (const file of fs.readdirSync(f.memory).filter(name => name.startsWith('index-notes-'))) assert.doesNotMatch(read(path.join(f.memory, file)), /disk usage/);
});
test('K327 trigger invariant rejects a lost wrapped alternative', () => {
  const before = [first, second, '  or disk usage.'].join('\n');
  assert.throws(() => checkRouterTriggers(before, [first, second].join('\n')), /migration router trigger loss: MEMORY.md line 2/);
  checkRouterTriggers(before, before.replaceAll('(INDEX-infra-2.md)', '(INDEX-infra.md)'));
});
test('K327 capitalized continuation retains existing merge', t => {
  const f = routeFixture(t, [first, second, '  Also the toolchain.']);
  migrateRoutes({memoryDir: f.memory, write: true});
  const router = read(path.join(f.memory, 'MEMORY.md'));
  assert.equal(router.split('\n').filter(line => line.startsWith('- [')).length, 1);
  assert.doesNotMatch(router, /Also the toolchain/);
  assert.match(read(path.join(f.memory, 'index-notes-infra.md')), /  Also the toolchain\./);
});
