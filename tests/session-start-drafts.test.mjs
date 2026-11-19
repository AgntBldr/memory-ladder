import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {put, read} from './helpers.mjs';
import {draftLesson} from '../engine/memory-lesson.mjs';
import {writeMemoryIndex} from '../engine/memory-index.mjs';
import {startFixture} from './session-start-fixture.mjs';

// Every draft lesson in the memory folder is named first in the lead section of a start, read from the files as they are now,
// whatever branch wrote it and whichever note or state block leads. One line of at most 240 bytes: the names that fit, then
// "+<k> more".
const LABEL = /^draft lessons to finish \((\d+)\): /;
const WORDS = ['gate', 'index', 'recall', 'rotation', 'batch', 'commit', 'branch', 'session', 'notes', 'claims', 'pages', 'review'];
const textFor = i => `The ${WORDS[i % WORDS.length]} step number ${i} stayed quiet after a change, so the problem went unseen; check it after every change.`;

function withDrafts(f, count, text = textFor) {
  put(path.join(f.memoryDir, 'MEMORY.md'), '# Memory\n- [Craft](INDEX-craft.md) OPEN BEFORE testing.\n');
  const names = [];
  for (let i = 0; i < count; i++) names.push(draftLesson({memoryDir: f.memoryDir, repo: f.target, config: f.config, text: text(i), today: '2026-11-17'}).file);
  writeMemoryIndex({memoryDir: f.memoryDir, repo: f.target, config: f.config});
  return names;
}
// A state block with the front matter the gate wants, so the only lines the start prints besides the lead are the ones under test.
const FRONT = '---\nname: current-state\ndescription: "Current work."\nmetadata:\n  type: project\n  state: true\n---\n\n';
const block = (f, text) => f.state(FRONT + text);
const lines = output => output.split('\n');
const draftLine = output => lines(output).find(line => LABEL.test(line));
// The lead section starts right after the facts block; the draft line is its first line.
const leadStart = output => lines(output).findIndex(line => LABEL.test(line));
const stamped = (f, fields = '') => `## CURRENT\n**${f.stamp(new Date())} | @1234567 | full. block-state**\n**Next action:** block-next\n${fields}**Branch:** ${f.branch}\n`;

test('no draft lesson, no draft line', t => {
  const f = startFixture(t);
  block(f,stamped(f));
  const output = f.start();
  assert.equal(draftLine(output), undefined);
  assert.doesNotMatch(output, /draft lessons/);
});

test('a lesson that is finished or not a draft is not counted', t => {
  const f = startFixture(t), [name] = withDrafts(f, 1), full = path.join(f.memoryDir, name);
  put(full, read(full).replace(/^  draft: .*\n/m, ''));
  assert.equal(draftLine(f.start()), undefined);
  put(path.join(f.memoryDir, 'lesson-002-other.md'), '---\nname: lesson-002-other\ndescription: "Another."\nmetadata:\n  type: feedback\n---\nA draft: is only a draft when the front matter says so.\n');
  assert.equal(draftLine(f.start()), undefined);
});

test('one draft: the line is the first line of the lead section when the state block leads', t => {
  const f = startFixture(t), [name] = withDrafts(f, 1);
  block(f,stamped(f));
  const all = lines(f.start()), at = all.findIndex(line => LABEL.test(line));
  assert.equal(all[at], `draft lessons to finish (1): ${name}`);
  assert.match(all[at + 1], /^last handover: .* - block-state$/);
  assert.doesNotMatch(all[at - 1], /^last handover:/);
});

test('one draft: the line is the first line of the lead section when a note leads', t => {
  const f = startFixture(t), [name] = withDrafts(f, 1);
  f.note(1, new Date(Date.now() - 30 * 60000));
  block(f,`## CURRENT\n**${f.stamp(new Date(Date.now() - 3 * 3600000))} | @1234567 | full. older-block**\n**Branch:** ${f.branch}\n`);
  const all = lines(f.start()), at = all.findIndex(line => LABEL.test(line));
  assert.equal(all[at], `draft lessons to finish (1): ${name}`);
  assert.match(all[at + 1], /^last handover: .* - note-state-1$/);
});

test('one draft: the line stays first when a state block is not used and the note leads (the shape of the session-mode pending case)', t => {
  const f = startFixture(t), [name] = withDrafts(f, 1);
  f.note(1, new Date(Date.now() - 30 * 60000));
  block(f,'## CURRENT\n**Next action:** foreign next\n**Branch:** other-topic\n');
  const all = lines(f.start()), at = all.findIndex(line => LABEL.test(line));
  assert.equal(all[at], `draft lessons to finish (1): ${name}`);
  assert.match(all[at + 1], /^state block not used: it is for other-topic$/);
  assert.ok(all.some(line => /^last handover: .* - note-state-1$/.test(line)));
});

test('no note and no state block: the line is still there, before the no-record line', t => {
  const f = startFixture(t), [name] = withDrafts(f, 1);
  const all = lines(f.start()), at = all.findIndex(line => LABEL.test(line));
  assert.equal(all[at], `draft lessons to finish (1): ${name}`);
  assert.equal(all[at + 1], 'state: none recorded');
});

test('a draft written on another branch is listed, and a draft is listed on any branch', t => {
  const f = startFixture(t), names = withDrafts(f, 2);
  f.git(f.target, 'checkout', '-b', 'other-topic');
  assert.ok(draftLine(f.start()).endsWith(names.join(', ')));
  f.git(f.target, 'checkout', f.branch);
  assert.match(draftLine(f.start()), /^draft lessons to finish \(2\): /);
});

test('every draft is named, in file name order, up to the 240-byte limit and then "+<k> more"', t => {
  const f = startFixture(t), names = withDrafts(f, 12), line = draftLine(f.start());
  const body = line.replace(LABEL, ''), shown = body.replace(/ \+\d+ more$/, '').split(', ');
  assert.match(line,/^draft lessons to finish \(12\): /);
  assert.deepEqual(shown, names.slice(0, shown.length));
  assert.ok(shown.length >= 1 && shown.length < 12, line);
  assert.equal(body.endsWith(` +${12 - shown.length} more`), true, line);
  assert.ok(Buffer.byteLength(line) <= 240, String(Buffer.byteLength(line)));
  // One more name would not have fit.
  const next = `draft lessons to finish (12): ${names.slice(0, shown.length + 1).join(', ')}${shown.length + 1 < 12 ? ` +${11 - shown.length} more` : ''}`;
  assert.ok(Buffer.byteLength(next) > 240, next);
});

test('a few drafts all fit and no "more" is printed', t => {
  const f = startFixture(t), names = withDrafts(f, 3), line = draftLine(f.start());
  assert.equal(line, `draft lessons to finish (3): ${names.join(', ')}`);
  assert.ok(Buffer.byteLength(line) <= 240);
});

test('with the lead at its maximum the draft line is whole, first, and the section stays within 1,600 bytes', t => {
  const f = startFixture(t), names = withDrafts(f, 12), long = 'x'.repeat(300);
  put(path.join(f.memoryDir, 'MEMORY.md'), '# Memory\n- [Craft](INDEX-craft.md) OPEN BEFORE testing.\n');
  f.note(1, new Date(Date.now() - 30 * 60000));
  block(f,`## CURRENT\n**${f.stamp(new Date())} | @1234567 | full. ${long}**\n**Open question:** ${long}\n**Next action:** ${long}\n**Constraints:** ${long}\n**In flight:** ${long}\n**Waits on the user:** ${long}\n**Context:** ${long}\n**Branch:** ${f.branch}\n`);
  const output = f.start(), all = lines(output), at = all.findIndex(line => LABEL.test(line)), end = all.findIndex(line => line.startsWith('first step:'));
  assert.ok(at > 0 && end > at, output);
  const line = all[at];
  assert.ok(Buffer.byteLength(line) <= 240);
  assert.match(line, /^draft lessons to finish \(12\): lesson-/);
  assert.match(line, / \+\d+ more$/);
  // The section is the draft line, the rest of the lead and the goal and first-step footer: 1,600 bytes, the draft line included.
  const section = all.slice(at, end + 1).join('\n');
  assert.ok(Buffer.byteLength(section) <= 1600, String(Buffer.byteLength(section)));
  assert.ok(section.includes('xxxx'), 'the rest of the lead is cut, not dropped');
});

test('a draft in the memory folder that cannot be read does not stop the start', t => {
  const f = startFixture(t), [name] = withDrafts(f, 1);
  put(path.join(f.memoryDir, 'lesson-002-broken.md'), '---\nname: lesson-002-broken\ndescription: "Broken\n');
  put(path.join(f.memoryDir, 'lesson-003-empty.md'), '');
  assert.equal(draftLine(f.start()), `draft lessons to finish (1): ${name}`);
});

test('the draft line is read from the files at the start, not from a record: deleting the draft file removes the line', t => {
  const f = startFixture(t), [name] = withDrafts(f, 2);
  assert.match(draftLine(f.start()), /^draft lessons to finish \(2\): /);
  fs.unlinkSync(path.join(f.memoryDir, name));
  assert.match(draftLine(f.start()), /^draft lessons to finish \(1\): /);
});
