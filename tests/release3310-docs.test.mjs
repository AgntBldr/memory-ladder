// Kit 3.3.10: the release notes. The changelog entry for 3.3.10 sits above the 3.3.9 entry and says, in plain words, what the release
// changed: the update from 3.3.9, the one definition of safe to compact and what it changes in a handover's verdict, the required
// `roadmap` input, draft lessons and the lesson tool's whole writes, the session start's notes, slash forms and stamp with seconds,
// the update's preview lines, the two new gate checks, "Widened checks: none." and the known limits. The upgrade ledger holds the
// 3.3.10 row, docs/UPGRADE.md gains no widening row, and NEW_CHECKS is unchanged with a comment that says why. Each test names its
// mutant (one small change that makes it fail).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {kitRoot} from './helpers.mjs';
import {NEW_CHECKS} from '../scripts/upgrade.mjs';

const doc = rel => fs.readFileSync(path.join(kitRoot, rel), 'utf8');
// The text of the 3.3.10 entry, from its heading to the 3.3.9 heading.
const entry = () => {
  const log = doc('CHANGELOG.md'), at10 = log.indexOf('\n## 3.3.10\n'), at9 = log.indexOf('\n## 3.3.9\n');
  assert.ok(at10 > 0 && at10 < at9, '3.3.10 is above 3.3.9');
  return log.slice(at10, at9);
};
const includesAll = (text, parts) => { for (const part of parts) assert.ok(text.includes(part), part); };

test('CHANGELOG has a 3.3.10 entry above the 3.3.9 entry: the upgrade line from 3.3.9, the summary, the gate checks and the ledger row', () => { // mutant: move the 3.3.10 heading below "## 3.3.9", drop "- Widened checks: none.", or change the id of the 3.3.10 ledger row
  const text = entry();
  includesAll(text, [
    'Upgrade from 3.3.9 with `node scripts/upgrade.mjs --target <PROJECT> --check`', '--live-memory',
    'by one definition', 'A full handover needs a new input, `roadmap`; without it the verdict is NOT SAFE.',
    '3.3.10 adds two gate checks, `lesson.draft` and `lesson.draft-text`, which cannot fire before a project\'s first draft lesson, and widens none.',
    '- New checks: `lesson.draft` (WARN, one per draft lesson) and `lesson.draft-text` (FAIL', 'Neither can fire before a project\'s first draft lesson.',
    'No check for an empty lesson file is added', '- Widened checks: none.', 'gets the same findings as under 3.3.9',
    'A project\'s own skill or script that builds a handover input must now pass `roadmap`', 'must use the exit status instead',
  ]);
  const rows = JSON.parse(doc('engine/upgrades.json'));
  assert.equal(rows.at(-1).id, 'kit-3-3-10');
  assert.ok(rows.at(-1).reason.startsWith('Upgrade from 3.3.9: preview with --check first'), 'the ledger row names the update from 3.3.9');
  for (const part of ['roadmap input', 'SAVE REFUSED', 'must use the exit status', 'Reports line']) assert.ok(rows.at(-1).reason.includes(part), 'the ledger row says: ' + part);
});

test('CHANGELOG says what safe to compact means and what changed in a handover\'s verdict', () => { // mutant: drop the sentence that a commit or a push is not one of the three, or the sentence about SAVE REFUSED
  includesAll(entry(), [
    'Safe to compact has one definition, the same in a handover\'s last line, in the handover skill and in the Reports line of the standard block',
    'memory is updated, learning is added (lessons written, saved as a draft to finish later, or stated as none), and the roadmap holds the current state',
    'A commit or a push is not one of the three.', 'The standard block changes one line, the Reports line, to say so.',
    'A project rule in `## Project rules` that contradicts it stays and is the project\'s to reconcile.',
    '`roadmap: "updated (<words>)"`, with words copied from the roadmap line the run added',
    '`roadmap: "nothing new (<words>)"`, with words copied from the line that already holds the state',
    'The words must be on one line of the roadmap when the handover ends, and a quote under 20 characters must be the whole line.',
    'A handover input without `roadmap` is NOT SAFE, and so is saying nothing about the roadmap.',
    'A handover writes no new kind of file. The note gains one field, `Roadmap`, that records the statement.',
    'The report can end with two lines: `NOT FINISHED - ...` and the verdict.',
    'A commit the gate stopped, a failed push, a failed close check and a stale brain log no longer turn the verdict to NOT SAFE.',
    'They still give a non-zero exit status and must be fixed before the session ends, with the command the next-step line names, not with a second handover.',
    'A full handover no longer fails on an uncommitted roadmap or log when memory is outside the project.',
    'now ends `SAVE REFUSED - ...` instead of `NOT SAFE TO COMPACT - ...`', 'The exit status is non-zero as before.',
    'A project script that looks for the words "NOT SAFE" to detect a failed handover must use the exit status.',
    'A handover now proves from disk what it was asked to save: the note, the state block, what the lesson batch wrote or the draft it saved, and the roadmap line it quoted.',
    'Anything missing or different at the end gives NOT SAFE, whatever happened to the commit.',
    'A lesson file that is empty, unfilled, or a draft without its text gives NOT SAFE on every full handover, and on every quick handover given lessons, until someone acts on the file, unless the project\'s gate allows that finding or another session has claimed the file.',
    'is checked for being on disk and for its form, not for its words (see Known limits)',
    'so no handover that is SAFE today becomes NOT SAFE by it',
    'A quick handover says SAFE only when it was given both the lessons and the roadmap statement; otherwise it says `STATE SAVED (quick)` and names what it did not check.',
    'Given a statement that does not hold, it now says NOT SAFE and exits non-zero.', 'Roadmap rotation is unchanged.',
  ]);
});

test('CHANGELOG says how a lesson is saved for later, where drafts are shown, how a draft is finished and how the lesson tool writes', () => { // mutant: drop "Saving the same text again makes no second file" or the sentence about a failed lesson batch
  includesAll(entry(), [
    '`lessons: "later (<what happened and the rule you would write>)"`', '`node scripts/memory/memory-lesson.mjs draft "<text>"`',
    'The text is at least 40 characters and 6 words.', 'with a `draft:` line under its metadata and the text under `**Draft:**`',
    'Saving the same text again makes no second file while a lesson file still holds that text under `**Draft:**`; once that paragraph is deleted, the same text makes a new draft.',
    'Every session start lists the drafts first, a SAFE handover counts them in its last line while any remain (`draft lessons to finish: <n>`), and the gate gives one WARN (`lesson.draft`) per draft.',
    'A draft is finished by editing its file: fill Why and How to apply, correct the title, description, kind and route, and delete the `draft:` line.',
    'replaces an existing lesson file by an atomic rename, and gives a new lesson its name only when its content is complete, so a failed write never leaves part of a lesson',
    'A failed lesson batch now prints how to run it again.', '(`none (already written: <files>)`)',
    'A recurrence can be recorded twice after a failed batch (see Known limits).',
  ]);
});

test('CHANGELOG says what the session start now prints and reads: the not-used lines, the slash forms and the stamp with seconds', () => { // mutant: drop the third not-used line, the usage line, or the sentence that old stamps are still read
  includesAll(entry(), [
    '`state block not used: it has no **Branch:** line; add "**Branch:** <branch>" to current-state.md (a handover writes it)`',
    '`state block not used: it is for <branch>`',
    '`state block not used: it has no time stamp, so the hand-over note of <HH:MM> leads; start the block with "**YYYY-MM-DD HH:MM:SS | @<sha> | full. <state>**" (a handover writes it)`',
    'it is copied on a fresh install only, and an update does not rewrite an existing file',
    '`new-session.mjs dispatch` now answers the exact messages `/new-session`, `/handover` and `/handover quick`',
    'gets the usage line `dispatch: use /new-session, /handover or /handover quick`', 'The prompt hook is unchanged: it still ignores every slash message',
    '`current-state.md` stamps gain seconds at the next handover', 'A stamp without seconds is still read, and nothing rewrites an old stamp.',
    'A project skill that writes the stamp itself keeps working with minute stamps; whether it moves to seconds is each project\'s own follow-up.',
    'A stamp with seconds leads when its time is equal to or later than the newest note\'s time, and a stamp without seconds leads when its minute is equal to or later than the note\'s minute.',
  ]);
});

test('CHANGELOG says what the update\'s preview prints, what the documents say and what the kit\'s own export refuses', () => { // mutant: drop the snapshot line, the not computed line or the sentence about LIMITS
  includesAll(entry(), [
    '`note: <id> begins with <n> sentence(s) of a kit line (<versions>); "keep" copies the whole unit, kit sentences included; edit ## Project rules after the update`',
    'The line is still kept or dropped whole, as decided.',
    '`UNDO SNAPSHOT <n> files, <size> MB to <folder> (<free> GB free)`', 'with nothing copied', 'the line ends `- NOT ENOUGH SPACE` and the preview exits non-zero',
    '`planned writes: not computed (<reason>)` instead of zeros',
    '"Example figures given in KB are invented examples."',
    'refuses a repository name made only of dots (the names `.` and `..`)', 'Both run only in the kit\'s own export; installed projects are unaffected.',
  ]);
});

test('CHANGELOG lists the known limits: the printed push, the agent\'s own statements, the point-in-time verdict, drafts, old stamps and the kept unit', () => { // mutant: drop the printed-push limit or the sentence that the push never runs inside a git hook
  const text = entry(), limits = text.slice(text.indexOf('\nKnown limits\n'));
  assert.ok(limits.length > 0 && text.includes('\nKnown limits\n'), 'the entry has a Known limits part');
  includesAll(limits, [
    'name `git -C <folder> push`', 'not under the kit\'s clean git environment', '(`GIT_DIR`, `GIT_WORK_TREE`, `GIT_NAMESPACE`, injected configuration)',
    'never inside a git hook', 'The checkpoint\'s hint (3.3.9 and earlier) is also unquoted.', 'one quoted, clean-environment push entry point',
    '`lessons: none (...)` is taken on the agent\'s word', 'a filler line that is quoted passes',
    'A file changed from outside the handover after that moment can undo saved knowledge without a NOT SAFE being printed.',
    'A file changed from outside between two attempts is seen only if the damage shows in its form',
    'counts twice toward the repeat thresholds until one line is deleted by hand', 'On a file system that refuses hard links the lesson tool stops with that reason and writes nothing.',
    'A draft\'s text is checked for length only', '`lesson.draft` is one WARN per draft',
    'A quoted roadmap line that the run\'s own rotation moves to the history file gives NOT SAFE',
    'ties by minute, so a note written later in the same minute loses to it',
    'can run its public test gate close to the gate\'s fixed time limit when the machine is busy', 'The limit is not raised: a run that reaches it fails', 'Keeping it repeats its kit sentences in `## Project rules`',
  ]);
});

test('UPGRADE.md gains no 3.3.10 widening row, NEW_CHECKS is unchanged and the comment above it says why', () => { // mutant: add a 3.3.10 row to the table of widened checks, add 'lesson.draft-text' to NEW_CHECKS, or delete the 3.3.10 sentence of the comment
  const text = doc('docs/UPGRADE.md'), at = text.indexOf('## Checks a release widens');
  assert.ok(at > 0, 'the section exists');
  const section = text.slice(at, text.indexOf('## Planned writes'));
  assert.ok(!/\|\s*3\.3\.10\s*\|/.test(section), 'no check widened, so no 3.3.10 row');
  assert.match(section, /\| 3\.3\.9 \| `config\.caps` \|/);
  assert.deepEqual(NEW_CHECKS, ['config.path']);
  const source = doc('scripts/upgrade.mjs'), start = source.indexOf('export const NEW_CHECKS');
  const comment = source.slice(source.lastIndexOf('\n\n', start), start).replace(/\s*\n\/\/\s*/g, ' ');
  includesAll(comment, ['3.3.10 adds lesson.draft (a WARN) and lesson.draft-text (a FAIL) and widens none', 'deliberately not listed here', 'which no earlier release writes, so an update meets none']);
});
