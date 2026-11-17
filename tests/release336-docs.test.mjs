// Kit 3.3.6 docs (spec item 13, S6-T16): the release documentation names what changed in 3.3.6 and drops the
// 3.3.5 wording it replaces. Each test names its mutant (one small change to the document that makes it fail).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {kitRoot} from './helpers.mjs';

const doc = rel => fs.readFileSync(path.join(kitRoot, rel), 'utf8');

test('S6-T16a UPGRADE.md lists GIT_NAMESPACE, GIT_CONFIG and the four pathspec-mode variables as cleaned', () => {
  // mutant: remove `GIT_NAMESPACE` from the cleaned-variables list in docs/UPGRADE.md
  const text = doc('docs/UPGRADE.md');
  for (const name of ['GIT_NAMESPACE', 'GIT_CONFIG', 'GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS']) {
    assert.ok(text.includes(`\`${name}\``), `${name} is listed`);
  }
});

test('S6-T16b UPGRADE.md has no 3.3.5 fifo sentence and no "Known limits in 3.3.5" heading; it has the 3.3.6 heading', () => {
  // mutant: restore the sentence "and it is still open in 3.3.5" or the heading "Known limits in 3.3.5"
  const text = doc('docs/UPGRADE.md');
  assert.ok(!text.includes('still open in 3.3.5'), 'no "still open in 3.3.5"');
  assert.ok(!text.includes('Known limits in 3.3.5'), 'no "Known limits in 3.3.5"');
  assert.ok(text.includes('Known limits in 3.3.6'), 'the 3.3.6 heading is present');
});

test('S6-T16c UPGRADE.md 3.3.6 limits name the junction lock copy, the --commit memory folder and the non-ASCII case limit', () => {
  // mutant: delete the three item 24 and link bullets from the "Known limits in 3.3.6" section
  const text = doc('docs/UPGRADE.md');
  const section = text.slice(text.indexOf('Known limits in 3.3.6'));
  assert.ok(section.includes('junction'), 'junction bullet');
  assert.ok(section.includes('`--commit`'), '--commit bullet');
  assert.ok(section.includes('assume-unchanged'), 'assume-unchanged bullet');
});

test('S6-T16d CHANGELOG has a 3.3.6 entry above the 3.3.5 entry', () => {
  // mutant: move the 3.3.6 heading below "## 3.3.5"
  const text = doc('CHANGELOG.md');
  const at6 = text.indexOf('\n## 3.3.6\n'), at5 = text.indexOf('\n## 3.3.5\n');
  assert.ok(at6 > 0, '3.3.6 heading exists');
  assert.ok(at6 < at5, '3.3.6 is above 3.3.5');
});
