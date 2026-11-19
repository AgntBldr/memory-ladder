import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {read, put} from './helpers.mjs';
import {localTime} from '../engine/lib.mjs';
import {parseBlock} from '../engine/session-core.mjs';
import {currentFromNote} from '../engine/handover.mjs';
import {startFixture} from './session-start-fixture.mjs';

// The CURRENT stamp is written with seconds and read with or without them. A stamp with seconds leads when it is equal to
// or later than the newest note of the branch; a stamp without seconds leads when its minute is equal to or later than
// the note's minute. A tie goes to the block: a handover writes the note first and the block second, from the same content.
const at = (hour, minute, second) => new Date(2026, 2, 5, hour, minute, second);
const day = '2026-03-05';

function blockWith(f, stampText, state = 'stamped state') {
  return `## CURRENT\n**${stampText} | @1234567 | full. ${state}**\n**Branch:** ${f.branch}\n`;
}
// What the start printed as the lead: the block's own stamp line, or the note.
function lead(f, output, stampText) {
  const block = output.includes(`last handover: ${stampText} @1234567 -`), note = output.includes(' @abcdefa ' + f.branch + ' - note-state-1');
  assert.notEqual(block, note, 'exactly one of the block and the note leads\n' + output);
  return block ? 'block' : 'note';
}

test('a handover\'s own block and note, written in the same second, lead with the block', t => {
  const f = startFixture(t);
  const file = f.note(1, at(12, 0, 40));
  const block = currentFromNote(read(file));
  assert.match(block, /^## CURRENT\n\*\*2026-03-05 12:00:40 \| @abcdefa \| full\. note-state-1\*\*\n/);
  f.state(block);
  const output = f.start();
  assert.match(output, /last handover: 2026-03-05 12:00:40 @abcdefa - note-state-1/);
  assert.match(output, /older note:/);
});

test('a stamp with seconds, saved 20 seconds after the note in the same minute, leads', t => {
  const f = startFixture(t);
  f.note(1, at(12, 0, 20));
  f.state(blockWith(f, `${day} 12:00:40`));
  assert.equal(lead(f, f.start(), `${day} 12:00:40`), 'block');
});

test('a stamp with seconds, saved 20 seconds before the note in the same minute, does not lead', t => {
  const f = startFixture(t);
  f.note(1, at(12, 0, 40));
  f.state(blockWith(f, `${day} 12:00:20`));
  assert.equal(lead(f, f.start(), `${day} 12:00:20`), 'note');
});

test('a stamp with seconds one second before the note does not lead, and one second after it does', t => {
  const f = startFixture(t);
  f.note(1, at(12, 0, 40));
  f.state(blockWith(f, `${day} 12:00:39`));
  assert.equal(lead(f, f.start(), `${day} 12:00:39`), 'note');
  f.state(blockWith(f, `${day} 12:00:41`));
  assert.equal(lead(f, f.start(), `${day} 12:00:41`), 'block');
});

test('a stamp without seconds in the note\'s minute leads, even when the note has later seconds', t => {
  const f = startFixture(t);
  f.note(1, at(12, 0, 40));
  f.state(blockWith(f, `${day} 12:00`));
  assert.equal(lead(f, f.start(), `${day} 12:00`), 'block');
});

test('a stamp without seconds one minute before the note\'s minute does not lead, and one minute after it does', t => {
  const f = startFixture(t);
  f.note(1, at(12, 0, 40));
  f.state(blockWith(f, `${day} 11:59`));
  assert.equal(lead(f, f.start(), `${day} 11:59`), 'note');
  f.state(blockWith(f, `${day} 12:01`));
  assert.equal(lead(f, f.start(), `${day} 12:01`), 'block');
});

test('a note time with fractions of a second is compared as written: a stamp of the same second does not lead, a later one does', t => {
  const f = startFixture(t);
  f.note(1, localTime(at(12, 0, 40)).replace(/(?=[+-]\d\d:\d\d$)/, '.900'));
  f.state(blockWith(f, `${day} 12:00:40`));
  assert.equal(lead(f, f.start(), `${day} 12:00:40`), 'note');
  f.state(blockWith(f, `${day} 12:00:41`));
  assert.equal(lead(f, f.start(), `${day} 12:00:41`), 'block');
  // A stamp without seconds still ties to the minute.
  f.state(blockWith(f, `${day} 12:00`));
  assert.equal(lead(f, f.start(), `${day} 12:00`), 'block');
  f.state(blockWith(f, `${day} 11:59`));
  assert.equal(lead(f, f.start(), `${day} 11:59`), 'note');
});

test('with no note, a stamp of either form leads', t => {
  const f = startFixture(t);
  for (const stampText of [`${day} 12:00:40`, `${day} 12:00`]) {
    f.state(blockWith(f, stampText));
    assert.match(f.start(), new RegExp(`last handover: ${stampText} @1234567 - stamped state`));
  }
});

test('both stamp forms parse and keep the time as written', () => {
  for (const time of ['2026-10-29 12:34', '2026-10-29 12:34:56', '2026-10-29 00:00:00', '2026-10-29 23:59:59']) {
    const parsed = parseBlock(`**${time} | @abcdefa | quick. Ready to review**\n`);
    assert.deepEqual(parsed.stamp, {time, sha: 'abcdefa', mode: 'quick'}, time);
    assert.equal(parsed.state, 'Ready to review');
  }
});

test('an invalid date, time or shape gives no stamp, in either form', () => {
  for (const time of ['2026-02-30 12:00', '2026-02-30 12:00:00', '2026-13-01 12:00', '2026-13-01 12:00:00', '2026-01-01 24:00', '2026-01-01 24:00:00',
    '2026-12-31 24:00:00', '2026-01-01 12:60', '2026-01-01 12:00:60', '2026-01-01 25:00:00', '2026-01-01 12:0', '2026-01-01 12:00:0', '2026-01-01 12:00:', '2026-01-01 12:00:000']) {
    const parsed = parseBlock(`**${time} | @abcdefa | full. Bad**\n`);
    assert.equal(parsed.stamp, null, time); assert.equal(parsed.state, '', time);
  }
});

test('the writer\'s block parses back to the same time, sha, mode and state', () => {
  for (const mode of ['full', 'quick']) {
    const note = `---\ntime: 2026-03-05T12:00:40+01:00\nbranch: "topic"\nsha: abcdefa\nmode: ${mode}\n---\n**Open question:** none\n**State:** round trip state\n**Waits on the user:** none\n**Next action:** 1. go\n**Lessons:** none\n**In flight:** none\n**Context:** here\n`;
    const parsed = parseBlock(currentFromNote(note));
    assert.deepEqual(parsed.stamp, {time: '2026-03-05 12:00:40', sha: 'abcdefa', mode});
    assert.equal(parsed.state, 'round trip state'); assert.equal(parsed.fields.Branch, 'topic');
  }
});

test('the board window starts at the stamp\'s second when only the block leads', t => {
  const f = startFixture(t);
  put(path.join(f.target, 'AGENTS.md'), '## Session overlay\nboard: https://claude.ai/artifact/ExampleBoardKey\n');
  f.state(blockWith(f, `${day} 12:00:40`));
  const since = /decidedAt after (\S+ \([^)]*\))\. Reply line/.exec(f.start())?.[1];
  assert.equal(since, at(12, 0, 40).toISOString().slice(0, 19) + 'Z (last handover)');
  f.state(blockWith(f, `${day} 12:00`));
  assert.equal(/decidedAt after (\S+ \([^)]*\))\. Reply line/.exec(f.start())?.[1], at(12, 0, 0).toISOString().slice(0, 19) + 'Z (last handover)');
});
