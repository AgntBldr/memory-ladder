// Kit 3.3.7, part A3: the release documentation says when an existing check widens. 3.3.6 widened hardrule.size (a card reached
// through a [[wikilink]] under the router's ## Hard rules now counts as a hard rule) and its notes said "no new check", which
// was read as "no new failure". Written red first at the 3.3.6 base; each test names its mutant (one small change that makes it fail).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {kitRoot} from './helpers.mjs';
import {NEW_CHECKS} from '../scripts/upgrade.mjs';

const doc = rel => fs.readFileSync(path.join(kitRoot, rel), 'utf8');
const caps = JSON.parse(doc('engine/memory.config.json')).caps.hardRule;

test('A3-D1 the limits the documents name are the gate limits of hardrule.size', () => { // mutant: change caps.hardRule.failBytes or warnBytes in engine/memory.config.json (or the number in a document)
  assert.deepEqual([caps.warnBytes, caps.failBytes], [2048, 4096]);
  const log = doc('CHANGELOG.md'), upgrade = doc('docs/UPGRADE.md');
  for (const text of [log.slice(log.indexOf('\n## 3.3.6\n'), log.indexOf('\n## 3.3.5\n')), upgrade.slice(upgrade.indexOf('## Checks a release widens'), upgrade.indexOf('## Planned writes'))]) {
    assert.ok(text.includes(`over ${caps.failBytes} bytes`), `names ${caps.failBytes}`);
    assert.ok(text.includes(`over ${caps.warnBytes}`), `names ${caps.warnBytes}`);
  }
});

test('A3-D2 the 3.3.6 entry carries a correction that names the widened check, the limits, the rollback and the fix', () => { // mutant: delete the Correction paragraph from the 3.3.6 entry, or move it below "## 3.3.5"
  const log = doc('CHANGELOG.md'), entry = log.slice(log.indexOf('\n## 3.3.6\n'), log.indexOf('\n## 3.3.5\n'));
  const at = entry.indexOf('Correction: 3.3.6 also widens an existing check.');
  assert.ok(at > 0, 'the correction is inside the 3.3.6 entry');
  const text = entry.slice(at);
  for (const part of ['`hardrule.size`', '`[[wikilink]]`', '`## Hard rules`', 'over 4096 bytes', 'WARN over 2048', 'restores itself', 'writing the new file before shortening the card', 'Checks a release widens']) assert.ok(text.includes(part), part);
  assert.ok(entry.includes('Cards reached through wikilinks under `## Hard rules` are classified as hard rules rather than ordinary topics.'), 'the original 3.3.6 text is kept');
});

test('A3-D3 UPGRADE.md has a section on checks a release widens, with the 3.3.6 row, what the update permits, and the preview with its limits', () => { // mutant: rename the heading "Checks a release widens", drop the 3.3.6 row, the pre-existing-failures sentences, the --config of the incoming command or the "preview, not a guarantee" paragraph
  const text = doc('docs/UPGRADE.md'), at = text.indexOf('## Checks a release widens');
  assert.ok(at > 0, 'the section exists');
  const section = text.slice(at, text.indexOf('## Planned writes')).replace(/\s+/g, ' ');
  assert.match(section, /\| 3\.3\.6 \| `hardrule\.size` \|/);
  // What the update permits: unchanged installed-gate FAILs of any id, and NEW_CHECKS ids recorded by check and file.
  for (const part of ['Unchanged installed-gate FAILs remain permitted.', 'For IDs in `NEW_CHECKS`, the incoming pre-run additionally records failures by check and file.', '`hardrule.size` is not in that list.', 'new FAIL']) assert.ok(section.includes(part), part);
  assert.ok(!section.includes('treats only the ids in its `NEW_CHECKS` list'), 'the old sentence is gone');
  // The preview: the merged configuration (the project\'s values plus the defaults it lacks) is built with the update\'s own merge and
  // handed to the incoming gate; the installed gate runs as the update runs it; findings are compared in full.
  for (const part of ['mergeDefaults', "defaults.engine_version", 'node engine/memory-check.mjs --memory-dir <copy> --repo <PROJECT> --config <merged> --json', 'node <PROJECT>/scripts/memory/memory-check.mjs --memory-dir <copy> --repo <PROJECT> --json', 'check, file, line, message and value', 'preview, not a guarantee', 'writing the new file before shortening the card']) assert.ok(section.includes(part), part);
  assert.ok(text.includes('see "Checks a release widens" below'), 'step 6 points at the section');
});

test('A3-D4 NEW_CHECKS does not list hardrule.size and the comment above it says why', () => { // mutant: add 'hardrule.size' to NEW_CHECKS, or restore the comment "3.3.6 adds none (its new checks only warn)"
  assert.deepEqual(NEW_CHECKS, ['config.path']);
  const source = doc('scripts/upgrade.mjs'), at = source.indexOf('export const NEW_CHECKS');
  const comment = source.slice(source.lastIndexOf('\n\n', at), at);
  for (const part of ['3.3.6 added no new check id', 'widened hardrule.size', 'FAIL over 4096 bytes', 'WARN over 2048', 'restores itself', 'deliberately not listed', '3.3.7 adds none and widens none']) assert.ok(comment.includes(part), part);
  assert.ok(!comment.includes('3.3.6 adds none'), 'the old sentence is gone');
});

test('B-D1 CHANGELOG has a 3.3.7 entry above the 3.3.6 entry: the upgrade line from 3.3.6, the fixes and "Widened checks: none."', () => { // mutant: move the 3.3.7 heading below "## 3.3.6", or drop the "Widened checks: none." line
  const log = doc('CHANGELOG.md'), at7 = log.indexOf('\n## 3.3.7\n'), at6 = log.indexOf('\n## 3.3.6\n');
  assert.ok(at7 > 0 && at7 < at6, '3.3.7 is above 3.3.6');
  const entry = log.slice(at7, at6);
  for (const part of ['Upgrade from 3.3.6 with `node scripts/upgrade.mjs --target <PROJECT> --check`', '--live-memory', 'upgrade: cannot read <file> (not a regular file)', 'Checks a release widens', '- Widened checks: none.', 'npm test']) assert.ok(entry.includes(part), part);
  assert.ok(JSON.parse(doc('engine/upgrades.json')).some(row => row.id === 'kit-3-3-7'), 'the ledger keeps the 3.3.7 row');
});
