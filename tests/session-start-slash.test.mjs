import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ok, tree} from './helpers.mjs';
import {matchPhrase, matchSlash} from '../engine/session-core.mjs';
import {startFixture} from './session-start-fixture.mjs';

// `dispatch` answers /new-session, /handover and /handover quick, for an agent that has no slash skills. The prompt hook
// (`detect`) keeps rejecting every slash message: Claude Code runs the skill itself, and a nudge would run it twice.
const USAGE = 'dispatch: use /new-session, /handover or /handover quick';
const FULL = 'Read .claude/skills/handover/SKILL.md and follow it (full).';
const QUICK = 'Read .claude/skills/handover/SKILL.md and follow it (quick).';
const dispatch = (f, message) => ok(f.cli(['dispatch', '--message', message])).stdout;

test('each of the three exact slash forms is answered by dispatch', t => {
  const f = startFixture(t);
  const start = dispatch(f, '/new-session');
  assert.ok(start.startsWith(f.target) && start.endsWith('Waiting for your go.'), start);
  assert.match(start, /goal: none given - what is this session for\?/);
  assert.equal(dispatch(f, '/handover'), FULL);
  assert.equal(dispatch(f, '/handover quick'), QUICK);
});

test('the optional second line gives the goal or the note, as for the sentence forms', t => {
  const f = startFixture(t);
  assert.match(dispatch(f, '/new-session\nGoal: ship the fix'), /goal: ship the fix/);
  assert.match(dispatch(f, '/new-session\r\nGoal: crlf goal'), /goal: crlf goal/);
  assert.equal(dispatch(f, '/handover\nNote: saved'), FULL + '\nNote: saved');
  assert.equal(dispatch(f, '/handover quick\nNote: saved'), QUICK + '\nNote: saved');
  assert.equal(dispatch(f, '/handover\nnote:   spaced'), FULL + '\nNote: spaced');
  assert.equal(dispatch(f, '/handover\nNote: ' + 'x'.repeat(300)), FULL + '\nNote: ' + 'x'.repeat(200));
});

test('the forms are trimmed and case-insensitive', t => {
  const f = startFixture(t);
  assert.equal(dispatch(f, '  /HANDOVER  \n'), FULL);
  assert.equal(dispatch(f, '/Handover Quick'), QUICK);
  assert.equal(dispatch(f, '\t/handover   quick\t'), QUICK);
  assert.ok(dispatch(f, ' /NEW-SESSION ').endsWith('Waiting for your go.'));
});

test('any other message that starts with /new-session or /handover prints the usage line and exits zero', t => {
  const f = startFixture(t);
  for (const message of ['/handover full', '/handoverx', '/handover-now', '/new-session now', '/new-sessions', '/handover quick now', '/handover quickly',
    '/handover\nGoal: x', '/new-session\nNote: x', '/handover\nNote: a\nNote: b', '/new-session\nGoal: a\n\nmore', '/handover:', '/HANDOVER FULL']) {
    const result = f.cli(['dispatch', '--message', message]);
    assert.equal(result.status, 0, message); assert.equal(result.stdout, USAGE, message); assert.equal(result.stderr, '', message);
  }
});

test('a quoted slash form, another slash command and a bare slash print nothing', t => {
  const f = startFixture(t);
  for (const message of ['"/handover"', "'/new-session'", '`/handover quick`', '\u201c/handover\u201d', '/other', '/', '/ handover', 'run /handover', 'x/new-session', '']) {
    const result = f.cli(['dispatch', '--message', message]);
    assert.equal(result.status, 0, message); assert.equal(result.stdout + result.stderr, '', message);
  }
});

test('the sentence forms are answered as before', t => {
  const f = startFixture(t);
  assert.ok(dispatch(f, 'We are starting a new session - read this and let me know when we can start').endsWith('Waiting for your go.'));
  assert.equal(dispatch(f, 'handover'), FULL);
  assert.equal(dispatch(f, 'quick handover\nNote: saved'), QUICK + '\nNote: saved');
  assert.equal(f.cli(['dispatch', '--message', '"handover"']).stdout, '');
});

test('the ownership check applies to the slash forms and to their usage line, per skill', t => {
  const f = startFixture(t), skill = name => path.join(f.target, `.claude/skills/${name}/SKILL.md`);
  fs.appendFileSync(skill('handover'), 'foreign edit');
  for (const message of ['/handover', '/handover quick', '/handover\nNote: x', '/handover full', '/handoverx']) assert.equal(f.cli(['dispatch', '--message', message]).stdout, '', message);
  assert.ok(dispatch(f, '/new-session').endsWith('Waiting for your go.'));
  assert.equal(dispatch(f, '/new-session now'), USAGE);
  fs.appendFileSync(skill('new-session'), 'foreign edit');
  for (const message of ['/new-session', '/new-session\nGoal: x', '/new-session now']) assert.equal(f.cli(['dispatch', '--message', message]).stdout, '', message);
});

test('dispatch writes nothing for a slash form', t => {
  const f = startFixture(t), before = tree(f.root, {git: true});
  for (const message of ['/new-session', '/handover', '/handover quick\nNote: saved', '/handover full']) dispatch(f, message);
  assert.deepEqual(tree(f.root, {git: true}), before);
});

test('detect, the prompt hook, stays silent for every slash form', t => {
  const f = startFixture(t);
  for (const prompt of ['/new-session', '/handover', '/handover quick', '/new-session\nGoal: x', '/handover\nNote: x', '/handover full', '/HANDOVER']) {
    assert.equal(f.cli(['detect'], JSON.stringify({prompt})).stdout, '', prompt);
  }
  assert.match(f.cli(['detect'], JSON.stringify({prompt: 'handover'})).stdout, /Invoke the Skill tool/);
});

test('matchSlash answers only the three forms, and matchPhrase still rejects every slash message', () => {
  assert.deepEqual(matchSlash('/new-session'), {kind: 'start', quick: false, text: '', usage: false, skill: 'new-session'});
  assert.deepEqual(matchSlash('/new-session\nGoal: g'), {kind: 'start', quick: false, text: 'g', usage: false, skill: 'new-session'});
  assert.deepEqual(matchSlash('/handover'), {kind: 'handover', quick: false, text: '', usage: false, skill: 'handover'});
  assert.deepEqual(matchSlash('/handover quick\nNote: n'), {kind: 'handover', quick: true, text: 'n', usage: false, skill: 'handover'});
  assert.deepEqual(matchSlash('/handover full'), {kind: null, quick: false, text: '', usage: true, skill: 'handover'});
  assert.deepEqual(matchSlash('/new-session x'), {kind: null, quick: false, text: '', usage: true, skill: 'new-session'});
  for (const other of ['/other', 'handover', '"/handover"', '', null, undefined, 7, {prompt: '/handover'}]) assert.deepEqual(matchSlash(other), {kind: null, quick: false, text: '', usage: false, skill: null}, String(other));
  for (const message of ['/new-session', '/handover', '/handover quick', '/handover\nNote: n']) assert.equal(matchPhrase(message).kind, null, message);
});
