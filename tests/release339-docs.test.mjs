// Kit 3.3.9: the release notes. The changelog entry for 3.3.9 sits above the 3.3.8 entry and says what the release changed: the
// update from 3.3.8, the project's own checks that every save runs (the key, a failing check ending a finished save with status 1,
// the project push that follows an in-repository handover), "New checks: none.", the widened config.caps check with the rollback it
// causes, and the upgrade ledger row. docs/UPGRADE.md lists the same widening under "Checks a release widens", and NEW_CHECKS does not
// list config.caps. Each test names its mutant (one small change that makes it fail).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {kitRoot} from './helpers.mjs';
import {NEW_CHECKS} from '../scripts/upgrade.mjs';

const doc = rel => fs.readFileSync(path.join(kitRoot, rel), 'utf8');

test('CHANGELOG has a 3.3.9 entry above the 3.3.8 entry: the upgrade line from 3.3.8, the project checks, "New checks: none.", the widened config.caps check and the ledger row', () => { // mutant: move the 3.3.9 heading below "## 3.3.8", drop the "- New checks: none." line, change the id of the 3.3.9 ledger row, or write "byte for byte" into the entry again
  const log = doc('CHANGELOG.md'), at9 = log.indexOf('\n## 3.3.9\n'), at8 = log.indexOf('\n## 3.3.8\n');
  assert.ok(at9 > 0 && at9 < at8, '3.3.9 is above 3.3.8');
  const entry = log.slice(at9, at8);
  for (const part of [
    'Upgrade from 3.3.8 with `node scripts/upgrade.mjs --target <PROJECT> --check`', '--live-memory',
    '`caps.checkpoint.checks`', 'after the save and its push', 'git\'s redirect variables', 'status 1', 'keeps every saved change and commit',
    'a push failure keeps status 2', 'the project push that follows the save', 'Nothing changes for a project without the key',
    '- New checks: none.', '`config.caps` now FAILs a malformed `caps.checkpoint.checks`', 'has its update rolled back as a new FAIL', 'Checks a release widens',
    'are kept, with the same values in the same order', 'written again in two-space JSON',
  ]) assert.ok(entry.includes(part), part);
  assert.ok(!/byte[ -]for[ -]byte/.test(entry), 'the update rewrites the configuration file, so the entry promises values and order, not bytes');
  const rows = JSON.parse(doc('engine/upgrades.json'));
  const row = rows.find(candidate => candidate.id === 'kit-3-3-9');
  assert.ok(row, 'the ledger keeps the 3.3.9 row');
  assert.ok(row.reason.startsWith('Upgrade from 3.3.8: preview with --check first'), 'the ledger row names the update from 3.3.8');
  assert.ok(row.reason.includes('config.caps'), 'the ledger row names the widened check');
});

test('UPGRADE.md lists the 3.3.9 widening of config.caps under "Checks a release widens", with the rollback it causes and the three states that do not fail', () => { // mutant: delete the 3.3.9 row or the paragraph after the table, or write "byte for byte" into it again
  const text = doc('docs/UPGRADE.md'), at = text.indexOf('## Checks a release widens');
  assert.ok(at > 0, 'the section exists');
  const section = text.slice(at, text.indexOf('## Planned writes')).replace(/\s+/g, ' ');
  assert.match(section, /\| 3\.3\.9 \| `config\.caps` \|/);
  for (const part of ['before 3.3.9 the key was ignored', 'one new FAIL', 'A valid list, an empty list and an absent key pass',
    'is deliberately not in `NEW_CHECKS`', 'upgrade: restored <backup>: new FAIL: config.caps memory.config.json',
    'valid or empty keeps it, with the same values in the same order', 'written again in two-space JSON']) assert.ok(section.includes(part), part);
  assert.ok(!/byte[ -]for[ -]byte/.test(section), 'the update rewrites the configuration file, so the section promises values and order, not bytes');
});

test('NEW_CHECKS does not list config.caps and the comment above it says why', () => { // mutant: add 'config.caps' to NEW_CHECKS (the update would then finish with a failing gate), or delete the 3.3.9 sentence of the comment
  assert.deepEqual(NEW_CHECKS, ['config.path']);
  const source = doc('scripts/upgrade.mjs'), at = source.indexOf('export const NEW_CHECKS');
  const comment = source.slice(source.lastIndexOf('\n\n', at), at).replace(/\s*\n\/\/\s*/g, ' ');
  for (const part of ['3.3.9 adds none and widens config.caps', 'a malformed caps.checkpoint.checks is now a FAIL', 'deliberately not listed here either', 'restores itself']) assert.ok(comment.includes(part), part);
});
