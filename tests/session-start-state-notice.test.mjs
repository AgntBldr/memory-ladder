import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {kitRoot, read} from './helpers.mjs';
import {localTime} from '../engine/lib.mjs';
import {parseBlock} from '../engine/session-core.mjs';
import {startFixture, NOTICE} from './session-start-fixture.mjs';

// The start uses a hand-written current-state.md block only when it names this branch and, when a note exists for the
// branch, carries a valid stamp that is not older than the note. When it does not, the start says why in one line.
const MINUTE = 60000;
const noticeLines = output => output.split('\n').filter(line => line.startsWith(NOTICE));
const NO_BRANCH = 'state block not used: it has no **Branch:** line; add "**Branch:** <branch>" to current-state.md (a handover writes it)';

test('a block with content and no Branch line is not used, and the start says why', t => {
  const f = startFixture(t);
  f.state('## CURRENT\n**Next action:** hand-written next\n**Open question:** hand-written question\n');
  const output = f.start();
  assert.deepEqual(noticeLines(output), [NO_BRANCH]);
  assert.match(output, /state: none recorded/);
  assert.doesNotMatch(output, /hand-written next|hand-written question|undated/);
});

test('a branchless block does not lead against a note either, and the reason is still given', t => {
  const f = startFixture(t), at = new Date(Date.now() - 10 * MINUTE);
  f.note(1, at);
  f.state(`## CURRENT\n**${f.stamp(new Date())} | @1234567 | full. branchless newer state**\n**Next action:** branchless next\n`);
  const output = f.start();
  assert.deepEqual(noticeLines(output), [NO_BRANCH]);
  assert.ok(output.includes(`last handover: ${localTime(at)} @abcdefa ${f.branch} - note-state-1`), output);
  assert.doesNotMatch(output, /branchless/);
});

test('a block for another branch is not used and names that branch on one line', t => {
  const f = startFixture(t);
  f.state('## CURRENT\n**Next action:** foreign next\n**Branch:** other-topic\n');
  const output = f.start();
  assert.deepEqual(noticeLines(output), ['state block not used: it is for other-topic']);
  assert.match(output, /state: none recorded/);
  assert.doesNotMatch(output, /foreign next/);
});

test('the other branch name is capped at 60 characters, whatever their width, and never split', t => {
  const f = startFixture(t), prefix = 'state block not used: it is for ';
  const printed = name => { f.state('## CURRENT\n**Next action:** x\n**Branch:** ' + name + '\n'); return noticeLines(f.start())[0]; };
  assert.equal(printed('b'.repeat(100)), prefix + 'b'.repeat(60));
  assert.equal(printed('b'.repeat(60)), prefix + 'b'.repeat(60));
  assert.equal(printed('b'.repeat(59)), prefix + 'b'.repeat(59));
  // 30 characters of 3 bytes each (90 bytes) are printed whole; 100 are cut at 60 characters.
  assert.equal(printed('界'.repeat(30)), prefix + '界'.repeat(30));
  assert.equal(printed('界'.repeat(100)), prefix + '界'.repeat(60));
  // Characters outside the basic plane are one character each, so a surrogate pair is never cut in half.
  assert.equal(printed('\u{1F600}'.repeat(100)), prefix + '\u{1F600}'.repeat(60));
  assert.equal(printed('a' + '\u{1F600}'.repeat(100)), prefix + 'a' + '\u{1F600}'.repeat(59));
});

test('a branch name with control characters is printed on one line', t => {
  const f = startFixture(t);
  f.state('## CURRENT\n**Next action:** x\n**Branch:** evil\x07name\x1b[31mred\u0085tail\u2028more\n');
  const output = f.start(), lines = noticeLines(output);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^state block not used: it is for evil name \[31mred tail$/);
  assert.doesNotMatch(output, /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/);
});

test('this branch, no valid stamp and a note: the note leads and the reason names the note time and the stamp format', t => {
  const f = startFixture(t), at = new Date(Date.now() - 30 * MINUTE);
  f.note(1, at);
  f.state(`## CURRENT\n**Next action:** unstamped next\n**Branch:** ${f.branch}\n`);
  const output = f.start();
  assert.deepEqual(noticeLines(output), [`state block not used: it has no time stamp, so the hand-over note of ${localTime(at).slice(11, 16)} leads; start the block with "**YYYY-MM-DD HH:MM:SS | @<sha> | full. <state>**" (a handover writes it)`]);
  assert.ok(output.includes(`last handover: ${localTime(at)} @abcdefa ${f.branch} - note-state-1`), output);
  assert.doesNotMatch(output, /unstamped next/);
});

test('an invalid stamp counts as no stamp', t => {
  const f = startFixture(t), at = new Date(Date.now() - 30 * MINUTE);
  f.note(1, at);
  f.state(`## CURRENT\n**2026-02-30 12:00:00 | @1234567 | full. impossible date**\n**Branch:** ${f.branch}\n`);
  const output = f.start();
  assert.equal(noticeLines(output).length, 1);
  assert.match(noticeLines(output)[0], /^state block not used: it has no time stamp, so the hand-over note of \d\d:\d\d leads;/);
});

test('this branch, no stamp and no note: the block leads and nothing new is printed', t => {
  const f = startFixture(t);
  f.state(`## CURRENT\nLegacy state\n**Next action:** inspect fixture\n**Branch:** ${f.branch}\n`);
  const output = f.start();
  assert.deepEqual(noticeLines(output), []);
  assert.match(output, /undated/); assert.match(output, /Legacy state/); assert.match(output, /Next action: inspect fixture/);
});

test('this branch with a stamp newer than the note: the block leads and nothing new is printed', t => {
  const f = startFixture(t), now = new Date();
  f.note(1, new Date(now.getTime() - 20 * MINUTE));
  f.state(`## CURRENT\n**${f.stamp(now)} | @1234567 | full. stamped state**\n**Branch:** ${f.branch}\n`);
  const output = f.start();
  assert.deepEqual(noticeLines(output), []);
  assert.match(output, /last handover: \d{4}-\d{2}-\d{2} \d\d:\d\d:\d\d @1234567 - stamped state/);
  assert.match(output, /older note:/);
});

test('this branch with a valid stamp older than the note: the note leads and nothing new is printed', t => {
  const f = startFixture(t), now = new Date();
  f.note(1, new Date(now.getTime() - 5 * MINUTE));
  f.state(`## CURRENT\n**${f.stamp(new Date(now.getTime() - 40 * MINUTE))} | @1234567 | full. older stamped state**\n**Branch:** ${f.branch}\n`);
  const output = f.start();
  assert.deepEqual(noticeLines(output), []);
  assert.ok(output.includes(`@abcdefa ${f.branch} - note-state-1`), output);
  assert.doesNotMatch(output, /older stamped state/);
});

test('an empty block, the starter text of this kit and of earlier kits print nothing new', t => {
  const f = startFixture(t), starter = read(path.join(kitRoot, 'templates/current-state.md'));
  const earlier = starter.replace(/Installation complete\..*\n$/s, 'Installation complete. Record the current task and next action here; overwrite this block at each checkpoint.\n');
  assert.notEqual(earlier, starter, 'the earlier starter differs from the current one');
  const cases = {'the shipped starter': starter, 'the earlier starter': earlier, 'an empty block': '## CURRENT\n', 'a blank block': '## CURRENT\n\n   \n', 'no state heading': 'Notes without a state heading.\n', 'no file text': ''};
  f.note(1, new Date(Date.now() - 10 * MINUTE));
  for (const [name, text] of Object.entries(cases)) {
    f.state(text);
    assert.deepEqual(noticeLines(f.start()), [], name);
  }
  fs.rmSync(f.stateFile);
  assert.deepEqual(noticeLines(f.start()), [], 'no current-state.md');
});

test('a block that keeps the starter sentence but adds a field is content, not the starter', t => {
  const f = startFixture(t);
  f.state('## CURRENT\nInstallation complete. Record the current task.\n**Next action:** real work\n');
  assert.deepEqual(noticeLines(f.start()), [NO_BRANCH]);
});

test('starter text followed or preceded by task prose is content, and only the exact starter bodies are exempt', t => {
  const f = startFixture(t), current = read(path.join(kitRoot, 'templates/current-state.md'));
  const heading = current.slice(0, current.indexOf('## CURRENT')), body = current.slice(current.indexOf('## CURRENT') + '## CURRENT'.length).trim();
  const earlier = 'Installation complete. Record the current task and next action here; overwrite this block at each checkpoint.';
  const prose = 'Task: fix payment retries. Next: inspect failed jobs.';
  const cases = {
    'a starter sentence then prose': `## CURRENT\nInstallation complete. ${prose}\n`,
    'the earlier starter then prose': `## CURRENT\n${earlier} ${prose}\n`,
    'the earlier starter then prose on the next line': `## CURRENT\n${earlier}\n${prose}\n`,
    'the current starter then prose': `${heading}## CURRENT\n\n${body}\n${prose}\n`,
    'prose then the earlier starter': `## CURRENT\n${prose}\n${earlier}\n`,
    'the earlier starter cut short': `## CURRENT\n${earlier.slice(0, -10)}\n`,
    'only the opening words': '## CURRENT\nInstallation complete.\n',
  };
  for (const [name, text] of Object.entries(cases)) { f.state(text); assert.deepEqual(noticeLines(f.start()), [NO_BRANCH], name); }
  // The exact starter bodies stay exempt, with any surrounding or wrapped white space.
  const exempt = {
    'the earlier starter': `## CURRENT\n${earlier}\n`,
    'the earlier starter, padded and wrapped': `## CURRENT\n\n  ${earlier.replace('the current task', 'the\ncurrent task')}  \n\n\n`,
    'the current starter, padded': `${heading}## CURRENT\n\n\n${body.replace('. Keep a line', '.\nKeep a line')}\n\n`,
  };
  for (const [name, text] of Object.entries(exempt)) { f.state(text); assert.deepEqual(noticeLines(f.start()), [], name); }
});

test('the starter template shows the Branch line and a stamp line, without a field or stamp the start could misread', () => {
  const starter = read(path.join(kitRoot, 'templates/current-state.md'));
  assert.ok(starter.includes('`**Branch:** <branch>`'), 'one example of the Branch line');
  assert.match(starter, /`\*\*\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| @[a-f0-9]{7} \| (?:full|quick)\. [^`]*\*\*`/, 'one example of the stamp line');
  const parsed = parseBlock(starter.slice(starter.indexOf('## CURRENT')));
  assert.equal(parsed.stamp, null); assert.deepEqual(parsed.fields, {});
});

test('the new-session skill names the Branch line and the stamp, and still fits its cap with a longer version', () => {
  const skill = read(path.join(kitRoot, 'skills/new-session/SKILL.md'));
  assert.ok(skill.includes('State block needs Branch: and stamp.'));
  // The release raises engine_version by one character (3.3.9 to 3.3.10): the file must still be within 1,536 bytes.
  assert.ok(Buffer.byteLength(skill.replace(/(engine_version: ")[^"]*"/, (_, start) => start + '3.3.10"')) <= 1536, 'SKILL.md with a two-digit patch number');
});

test('the README names both the Branch line and the stamp line a hand-written block needs', () => {
  const text = read(path.join(kitRoot, 'README.md'));
  assert.ok(text.includes('**Branch:** <this branch>'), 'the Branch line');
  assert.ok(text.includes('**YYYY-MM-DD HH:MM:SS | @<sha> | full. <state>**'), 'the stamp line');
});
