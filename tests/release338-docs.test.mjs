// Kit 3.3.8: the release notes. The changelog entry for 3.3.8 sits above the 3.3.7 entry and says what the release changed: the
// update from 3.3.7, the home-folder refusal that widens (the update's own check, not a gate check), "New checks: none." and the
// upgrade ledger row. docs/UPGRADE.md lists the same refusal under "Checks a release widens". Each test names its mutant (one small
// change that makes it fail).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {kitRoot} from './helpers.mjs';

const doc = rel => fs.readFileSync(path.join(kitRoot, rel), 'utf8');
// The refusal comes before any change to the project or its memory folder; the update can already have written a temporary copy
// of the memory while it planned, so no text says that nothing at all is written. The same words stand in the changelog entry,
// the UPGRADE.md row and the ledger row. A deleted line in the standard block is warned about but has no text to report.
const REFUSAL_BEFORE_SHORT = 'before any change to the project or its memory folder';
const REFUSAL_BEFORE = 'The update refuses ' + REFUSAL_BEFORE_SHORT + ': set the variable to a full path and run it again.';
const OVERSTATED = 'before it writes anything';
const EDIT_REPORT = 'A block with an edit inside it is still warned about; text added or changed inside it is also reported as an `edit-inside-block` entry, and a deleted line is warned about without an entry.';

test('B-D2 CHANGELOG has a 3.3.8 entry above the 3.3.7 entry: the upgrade line from 3.3.7, the home-folder refusal, "New checks: none." and the ledger row', () => { // mutant: move the 3.3.8 heading below "## 3.3.7", drop the "- New checks: none." line, change the last ledger id, or put "before it writes anything" back in the entry or the ledger row
  const log = doc('CHANGELOG.md'), at8 = log.indexOf('\n## 3.3.8\n'), at7 = log.indexOf('\n## 3.3.7\n');
  assert.ok(at8 > 0 && at8 < at7, '3.3.8 is above 3.3.7');
  const entry = log.slice(at8, at7);
  for (const part of ['Upgrade from 3.3.7 with `node scripts/upgrade.mjs --target <PROJECT> --check`', '--live-memory', 'an empty or relative `HOME` (or `USERPROFILE`, the fallback when `HOME` is unset) on every platform', 'A fresh install, a `--check` preview and a project that is not a git repository', REFUSAL_BEFORE, EDIT_REPORT, '- New checks: none.', 'not a gate check', 'Checks a release widens']) assert.ok(entry.includes(part), part);
  assert.ok(!entry.includes(OVERSTATED), 'the refusal does not promise that nothing at all is written');
  const rows = JSON.parse(doc('engine/upgrades.json'));
  assert.equal(rows.at(-1).id, 'kit-3-3-8');
  assert.ok(rows.at(-1).reason.startsWith('Upgrade from 3.3.7: preview with --check first'), 'the ledger row names the update from 3.3.7');
  assert.ok(rows.at(-1).reason.includes(REFUSAL_BEFORE_SHORT) && !rows.at(-1).reason.includes(OVERSTATED), 'the ledger row says the refusal comes before any change to the project or its memory folder');
});

test('B-D3 UPGRADE.md lists the 3.3.8 home-folder refusal under "Checks a release widens" as the update\'s own refusal, not a gate check', () => { // mutant: delete the 3.3.8 row or the sentence after the table, or put "before it writes anything" back in the row
  const text = doc('docs/UPGRADE.md'), at = text.indexOf('## Checks a release widens');
  assert.ok(at > 0, 'the section exists');
  const section = text.slice(at, text.indexOf('## Planned writes')).replace(/\s+/g, ' ');
  assert.match(section, /\| 3\.3\.8 \| The update's own check of the home folder \(not a gate check\) \|/);
  for (const part of ['`USERPROFILE` when `HOME` is unset', REFUSAL_BEFORE_SHORT, 'nothing written', 'so it needs no `NEW_CHECKS` entry']) assert.ok(section.includes(part), part);
  assert.ok(!section.includes(OVERSTATED), 'the row does not promise that nothing at all is written');
});
