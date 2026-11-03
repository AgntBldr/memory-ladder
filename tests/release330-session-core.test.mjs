import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as core from '../engine/session-core.mjs';
import {put, tree} from './helpers.mjs';

const fixture = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-core-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; };
const phrase = 'We are starting a new session - read this and let me know when we can start';
const note = (dir, seq, time, body = '**Open question:** same\n**State:** ready\n') => put(path.join(dir, 'handovers', `${String(seq).padStart(6, '0')}-2026-01-01-1200.md`), `---\ntime: ${time}\nbranch: topic\nsha: abcdefa\nmode: full\n---\n${body}`);

test('T0 frozen exports and arities', () => {
  assert.deepEqual(Object.keys(core).sort(), ['capOutput', 'capText', 'listNotes', 'matchPhrase', 'parseBlock', 'readCurrent', 'readOverlay', 'stateToken'].sort());
  for (const [name, arity] of Object.entries({stateToken: 1, readCurrent: 1, parseBlock: 1, readOverlay: 1, capText: 2, capOutput: 2, matchPhrase: 1, listNotes: 2})) assert.equal(core[name].length, arity, name);
});
test('T0 token covers raw dirty bytes including legacy empty and NUL', t => {
  const dir = fixture(t), file = path.join(dir, 'current-state.md');
  assert.equal(core.stateToken(dir), null);
  for (const text of ['', 'legacy', 'outside A\n## CURRENT\nsame', 'outside B\n## CURRENT\nsame', '\0', '\r\n']) {
    put(file, text);
    assert.equal(core.stateToken(dir), createHash('sha256').update(text).digest('hex').slice(0, 12));
  }
});
test('T0 CURRENT grammar headings fields and overlay boundaries', t => {
  const dir = fixture(t), block = '## CURRENT\n**2026-10-29 12:34 | @abcdefa | quick. Ready to review**\n**Open question:** choose?\n**RESUME HERE:** next\n**WAITS ON THE OWNER:** yes\n**LIVE RISKS:** none\n';
  put(path.join(dir, 'current-state.md'), '# RESUME\n' + block + '## Other\n**State:** excluded\n');
  const current = core.readCurrent(dir), parsed = core.parseBlock(block);
  assert.equal(current.block, block); assert.equal(current.headings.length, 2);
  assert.deepEqual(parsed.stamp, {time: '2026-10-29 12:34', sha: 'abcdefa', mode: 'quick'});
  assert.equal(parsed.state, 'Ready to review'); assert.equal(current.fields['Open question'], 'choose?');
  assert.equal(current.fields['RESUME HERE'], 'next'); assert.equal(current.fields.State, undefined);
  put(path.join(dir, 'AGENTS.md'), 'rules: outside\n## Session overlay\nRules: private.md\nMAIN-only: yes\nroadmap: docs/plan.md | section: Open work\n## Other\nrules: ignored\n');
  assert.deepEqual(core.readOverlay(dir), {rules: 'private.md', 'main-only': 'yes', roadmap: 'docs/plan.md | section: Open work'});
  assert.equal(core.parseBlock('**2026-02-30 12:00 | @abcdefa | full. Bad**').stamp, null);
});
test('T0 readers never throw on missing unreadable NUL or directory inputs', t => {
  const dir = fixture(t);
  for (const arg of [null, undefined, path.join(dir, 'absent'), '\0', dir]) {
    assert.doesNotThrow(() => core.stateToken(arg)); assert.doesNotThrow(() => core.readCurrent(arg));
    assert.doesNotThrow(() => core.readOverlay(arg)); assert.deepEqual(core.listNotes(arg), []);
  }
  for (const name of ['current-state.md', 'AGENTS.md', 'handovers']) fs.mkdirSync(path.join(dir, name));
  assert.equal(core.stateToken(dir), null); assert.equal(core.readCurrent(dir).token, null); assert.deepEqual(core.readOverlay(dir), {}); assert.deepEqual(core.listNotes(dir), []);
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => { if (String(file).startsWith(dir)) throw Error('unreadable'); return read(file, ...args); });
  assert.equal(core.stateToken(dir), null); assert.equal(core.readCurrent(dir).token, null); assert.deepEqual(core.readOverlay(dir), {}); assert.deepEqual(core.listNotes(dir), []);
});

test('T0 overlay returns unknown lowercased keys and real duplicate values without sentinels',t=>{
  const dir=fixture(t);
  put(path.join(dir,'AGENTS.md'),'## Session overlay\nCustom-key: retained\nCHECK: first\ncheck: second\n__proto__: plain\nempty:\n## Other\nignored: value\n');
  const overlay=core.readOverlay(dir);
  assert.equal(overlay['custom-key'],'retained');assert.equal(overlay.check,'second');assert.equal(overlay.__proto__,'plain');assert.equal(overlay.empty,'');
  assert.deepEqual(Object.keys(overlay).sort(),['custom-key','check','__proto__','empty'].sort());
  for(const value of Object.values(overlay)) {assert.equal(typeof value,'string');assert.ok(!value.includes('\0'));}
});
test('T0 listNotes seq order window duplicates invalid caps and read-only', t => {
  const dir = fixture(t), recent = new Date().toISOString(), old = '2020-01-01T12:00:00+00:00';
  note(dir, 1, recent, '**Open question:** same\nfirst body');
  note(dir, 2, recent, '**Open question:** same\nsecond body');
  note(dir, 3, old); note(dir, 4, old);
  note(dir, 5, recent, 'x'.repeat(7000));
  const bad = note(dir, 6, 'bad');
  put(path.join(dir, 'handovers', 'archive-2026-01.md'), 'container'); put(path.join(dir, 'handovers', 'stray.md'), 'stray');
  const before = tree(dir), notes = core.listNotes(dir);
  assert.deepEqual(notes.map(n => n.seq), ['000004', '000002', '000001']);
  assert.notEqual(notes[1].body, notes[2].body); assert.equal(notes[0].time, old);
  assert.deepEqual(tree(dir), before); assert.equal(core.listNotes(dir, {max: 1}).length, 1);
  note(dir, 3, '2099-01-01T00:00:00Z'); assert.deepEqual(core.listNotes(dir).map(n => n.seq), ['000004', '000002', '000001']);
  put(bad, '\0'); assert.equal(core.listNotes(dir).length, 3);
  put(bad, fs.readFileSync(note(dir, 7, recent, '\u754c'.repeat(900))));
  assert.ok(Buffer.byteLength(core.listNotes(dir)[0].body) <= 2048);
  const numeric = note(dir, 8, recent); put(numeric, fs.readFileSync(numeric, 'utf8').replace('sha: abcdefa', 'sha: 0000001').replace('branch: topic', 'branch: 123'));
  assert.equal(core.listNotes(dir)[0].sha, '0000001'); assert.equal(core.listNotes(dir)[0].branch, '123');
  const array = note(dir, 9, recent); put(array, fs.readFileSync(array, 'utf8').replace('sha: abcdefa', 'sha: [abcdefa]')); assert.equal(core.listNotes(dir)[0].seq, '000008');
});
test('T0 listNotes stops opening bodies after three eligible notes', t => {
  const dir = fixture(t), now = new Date().toISOString();
  for (let i = 1; i <= 4; i++) note(dir, i, now);
  const read = fs.readFileSync, opened = [];
  t.mock.method(fs, 'readFileSync', (file, ...args) => { if (String(file).includes('handovers')) opened.push(file); return read(file, ...args); });
  assert.equal(core.listNotes(dir).length, 3); assert.equal(opened.length, 3);
});
test('T0 byte caps preserve UTF-8 and overflow logs preserve full text', t => {
  const dir = fixture(t), text = '\u754c'.repeat(3000);
  for (const max of [0, 1, 4, 5, 6, 17, 2048]) { const value = core.capText(text, max); assert.ok(Buffer.byteLength(value) <= max); assert.ok(!value.includes('\ufffd')); }
  assert.equal(core.capText('small', 10), 'small'); assert.equal(core.capOutput('small'), 'small');
  t.mock.method(os, 'tmpdir', () => dir);
  const capped = core.capOutput(text, {max: 4000, label: '../overflow'});
  assert.ok(Buffer.byteLength(capped) <= 4000); assert.match(capped, /\[cut; full output:/);
  assert.equal(fs.readFileSync(path.join(dir, 'memory-session', fs.readdirSync(path.join(dir, 'memory-session'))[0]), 'utf8'), text);
});

const positives = [phrase, phrase.toUpperCase(), phrase.toLowerCase(), phrase + '.', phrase + '!', phrase + '?', phrase + ':;,', phrase.replace(' - ', ' '), phrase.replace(' - ', '\u2014'), phrase.replace('We are', "We're"), phrase.replace('We are', 'We\u2019re'), phrase.replaceAll(' ', '  '), '\n' + phrase + '\n', phrase + '\nGoal: repair', phrase.replace(' - ', '--')];
for (const [i, text] of positives.entries()) test(`T1 start positive ${i + 1}`, () => assert.equal(core.matchPhrase(text).kind, 'start'));
const negatives = ['a new session', 'starting a new session', 'we are starting a new session', "we're starting a new session", 'we\u2019re starting a new session', 'start of session', 'new-session', "let's start a new session", 'new session', 'start a new session', 'session start', 'start session', 'new chat', 'begin session', 'begin a new session', 'fresh session', 'lets start', 'lets start a new session', 'start new session', 'save memory', 'prepare for compact', 'safe to compact', 'add to memory, learning, and update roadmap', '/compact', '/new-session', '/' + phrase, '', phrase + ' now', 'Please ' + phrase, phrase + '\n\nmore', phrase + '\nmore', '```\n' + phrase + '\n```', '"' + phrase + '"', "'" + phrase + "'", '\u201c' + phrase + '\u201d', '\u2018' + phrase + '\u2019', '`' + phrase + '`', phrase + '\nNote: wrong', 'handover\nGoal: wrong', {prompt: phrase, agent_id: ''}, {prompt: phrase, agent_type: null}, {prompt: phrase, agent_id: 'worker'}, '\u201c' + phrase + '\u201d\nGoal: ignored'];
for (const [i, text] of negatives.entries()) test(`T1 excluded message ${i + 1}`, () => assert.equal(core.matchPhrase(text).kind, null));
for (const text of ['handover', 'hand over', 'do a handover', 'lets do a handover', 'end session', 'end of session', 'session end', 'quick handover']) test(`T1 handover table ${text}`, () => {
  assert.deepEqual(core.matchPhrase(text + '\nNote: saved'), {kind: 'handover', quick: text === 'quick handover', text: 'saved'});
});
test('T1 payload cap and parent prompt shape', () => {
  assert.equal(core.matchPhrase({prompt: phrase}).kind, 'start');
  assert.equal(core.matchPhrase(phrase + '\nGoal: ' + 'x'.repeat(300)).text.length, 200);
  assert.equal(core.matchPhrase("let's do a handover").kind, 'handover');
});

test('T1 apostrophes are removed only inside words and payload uses code points', () => {
  for (const text of [phrase + "'.", phrase + '\u2019.', phrase.replace(/start$/, "'start'."), phrase.replace(/start$/, '\u2018start\u2019.')]) assert.equal(core.matchPhrase(text).kind, null, text);
  assert.equal(core.matchPhrase(phrase + '\nGoal: ' + 'x'.repeat(199) + '\u{1f600}tail').text, 'x'.repeat(199) + '\u{1f600}');
});
test('T0 oversized overlay retains keys', t => {
  const dir = fixture(t);
  put(path.join(dir, 'AGENTS.md'), '## Session overlay\nrules: rules.md\nroadmap: plan.md | section: Open\n' + 'x'.repeat(1500));
  assert.deepEqual(core.readOverlay(dir), {rules: 'rules.md', roadmap: 'plan.md | section: Open'});
});
test('T0 raw note scalar strings are valid', t => {
  const dir = fixture(t);
  for (const [i, branch] of ['1.5', 'true', '123'].entries()) {
    const file = note(dir, i + 1, new Date().toISOString());
    put(file, fs.readFileSync(file, 'utf8').replace('branch: topic', 'branch: ' + branch).replace('sha: abcdefa', 'sha: 0123456'));
    const newest = core.listNotes(dir)[0];
    assert.equal(newest.branch, branch); assert.equal(newest.sha, '0123456'); assert.equal(newest.mode, 'full');
  }
});
