import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadConfig} from '../engine/lib.mjs';
import {runCheck} from '../engine/memory-check.mjs';
import {writeMemoryIndex} from '../engine/memory-index.mjs';

function fixture(t, ids = ['001']) {
  const memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cite-'));
  t.after(() => fs.rmSync(memoryDir, {recursive: true, force: true}));
  const config = loadConfig();
  config.pins['INDEX-craft-checks.md'] = 2048;
  const put = (file, text) => fs.writeFileSync(path.join(memoryDir, file), text +
    (file === 'MEMORY.md' && !text.includes('INDEX-craft-checks.md') ? '- [Craft](INDEX-craft-checks.md) OPEN BEFORE testing.\n' : ''));
  put('MEMORY.md', '# Memory\n- [Craft](INDEX-craft-checks.md) OPEN BEFORE testing.\n');
  put('INDEX-craft-checks.md', '# Checks\n');
  for (const id of ids) put(`lesson-${id}-x.md`, `---\nname: lesson-${id}-x\ndescription: Keep checks useful.\nmetadata:\n  type: feedback\n  route: craft-checks\n  kind: practice\n---\n# Checks\nKeep checks useful.\n`);
  const check = () => runCheck({memoryDir, config, scope: 'memory', noGit: true}).findings;
  return {memoryDir, config, put, check, cites: () => check().filter(f => f.check === 'lessons.cite' && f.severity === 'FAIL')};
}

for (const page of ['MEMORY.md', 'INDEX-craft-checks.md']) {
  test(`bare project numbers are not citations in ${page}`, t => {
    const f = fixture(t);
    f.put(page, '# Checks\n- [Craft](INDEX-craft-checks.md) OPEN BEFORE testing.\n' + [
      'release #201 failed build #202 after an import change; PR #203 fixed it',
      'waiting on PR #44',
      'while #44 is open',
      'all five (#410-414)',
      'on PR #57 until it lands',
      '(the #1 cause of rework)',
      'https://example.com/issue/#288 and `#299`',
      '`lesson #288` and ``lesson #299``',
      'lesson `example` #288; lesson [status](https://example.com/) #299',
      '```md\nlesson #288\n[#299](lesson-001-x.md)\n```',
      '[status](https://example.com/#288)',
    ].join('\n') + '\n');
    assert.deepEqual(f.check().filter(x => x.severity === 'FAIL'), []);
  });

  test(`numbered links check existence and target identity in ${page}`, t => {
    const missing = fixture(t);
    missing.put(page, '[#015](lesson-015-x.md)\n');
    assert.deepEqual(missing.cites().map(x => x.message), ['#015 has no matching lesson file']);
    assert.ok(missing.check().some(x => x.check === 'link.dead'));
    const present = fixture(t, ['015', '016']);
    present.put(page, '[#015](lesson-015-x.md)\n');
    assert.deepEqual(present.check().filter(x => x.severity === 'FAIL'), []);
    present.put(page, '[#015](lesson-016-x.md)\n');
    assert.deepEqual(present.cites().map(x => x.message), ['#015 links to lesson #016; numbers must match']);
    present.put(page, '[#15](./lesson-015-x.md)\n');
    assert.deepEqual(present.check().filter(x => x.severity === 'FAIL'), []);
  });

  test(`explicit lesson words and continuing lists in ${page}`, t => {
    const f = fixture(t, ['077']);
    f.put(page, 'lesson #077\n(lesson #077, #282)\n');
    assert.deepEqual(f.cites().map(x => [x.message, x.line]), [['#282 has no matching lesson file', 2]]);
    f.put(page, 'LESSONS #077, #282 and #283\n');
    assert.deepEqual(f.cites().map(x => x.message), ['#282 has no matching lesson file', '#283 has no matching lesson file']);
    f.put(page, '[lesson #282](https://example.com/)\n');
    assert.deepEqual(f.cites().map(x => x.message), ['#282 has no matching lesson file']);
    f.put(page, 'lesson #077, PR #282 and #283\n');
    assert.deepEqual(f.cites(), []);
  });
}

test('zero lessons preserve the citation-check opt out', t => {
  const f = fixture(t, []);
  f.put('MEMORY.md', 'lesson #077\n[#015](lesson-016-x.md)\n');
  assert.deepEqual(f.cites(), []);
});

test('generated indexes with numeric and suffixed lessons pass the gate', t => {
  const f = fixture(t, ['015', '016', '077', '114c', '1000']);
  fs.unlinkSync(path.join(f.memoryDir, 'INDEX-craft-checks.md'));
  writeMemoryIndex(f);
  assert.deepEqual(f.check().filter(x => x.severity === 'FAIL'), []);
});
