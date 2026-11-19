// Safe to compact means three things and only these: memory is updated, learning is added, and the roadmap holds the current state.
// A commit, a push, the gate as a whole, the brain log and the close steps are reported on their own line and never change the verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setup, snapshot, input, ROADMAP_LINE, NONE, STATEMENT, put, read, ok} from './handover-fixture.mjs';
import {parseHandover} from '../engine/lib.mjs';
import {readCurrent, listNotes} from '../engine/session-core.mjs';
import {currentFromNote} from '../engine/handover.mjs';
import {rotateRoadmap} from '../engine/memory-rotate.mjs';

const SAFE = /^SAFE TO COMPACT - memory saved; no learning stated \(no new learning this session\); roadmap updated \("Kit work is under way and nothing is blocked\."\)$/;
const modes = [['outside', false], ['inside', true]];

for (const [label, inRepo] of modes) {
  test(`all three conditions met with five uncommitted project files: SAFE and the open line, memory ${label} the project`, t => {
    const f = setup(t, {inRepo});
    for (let i = 0; i < 5; i++) put(path.join(f.repo, `scratch/file-${i}.txt`), 'x');
    const r = f.run();
    assert.equal(r.code, 0, r.output);
    assert.match(f.verdict(r.output), SAFE);
    assert.equal(f.finished(r.output), '');
    // The five files, and the roadmap overview the checkpoint generates.
    assert.match(r.output, new RegExp(String.raw`open: ${inRepo ? 5 : 6} uncommitted project files \(they do not affect the verdict; .*scratch/file-0\.txt`));
    assert.match(r.output, /\n\nNext: new conversation, then `\/new-session`\.\n/);
  });

  test(`each of the three missing alone gives NOT SAFE naming it, memory ${label} the project`, t => {
    // Memory: the run stops after the note, so the state block was not written.
    const a = setup(t, {inRepo}), memory = a.run({}, {afterNote() { throw Error('stopped after the note'); }});
    assert.equal(memory.code, 1);
    assert.equal(a.verdict(memory.output), "NOT SAFE TO COMPACT - memory not saved: current-state.md does not hold this run's state");
    // The note is on disk and uncommitted: NOT FINISHED says so beside the cause, and the re-run line stays.
    assert.match(a.finished(memory.output), /^NOT FINISHED - memory NOT committed \(the run stopped before the checkpoint: stopped after the note\): an overwrite by another session could not be undone$/);
    assert.equal(read(memory.noteFile), memory.note);
    assert.match(memory.output, /--replace 000001/);
    // Learning: a lesson saved for later whose file is gone at the end.
    const b = setup(t, {inRepo});
    b.saveInput({...b.defaults, lessons: `later (${'The gate stayed green after a rotation moved the lesson index, so a missing lesson went unseen.'})`});
    const learning = b.run({}, {beforeVerify() { for (const name of b.lessons()) fs.unlinkSync(path.join(b.memoryDir, name)); }});
    assert.equal(learning.code, 1);
    assert.match(b.verdict(learning.output), /^NOT SAFE TO COMPACT - learning: draft not on disk: lesson-001-the-gate-stayed-green-after-a-rotation-moved\.md$/);
    // Roadmap: no statement.
    const c = setup(t, {inRepo});
    c.saveInput({...c.defaults, roadmap: undefined});
    const roadmap = c.run();
    assert.equal(roadmap.code, 1);
    assert.equal(c.verdict(roadmap.output), "NOT SAFE TO COMPACT - roadmap: record this run's state in docs/ROADMAP.md, then pass roadmap: updated (<words of the line>)");
    assert.equal(c.notes().length, 1, 'memory and learning were still saved');
    assert.equal(readCurrent(c.memoryDir).block, currentFromNote(read(listNotes(c.memoryDir)[0].file)));
  });

  test(`a save writes no new kind of file: the note gains one field and the state block is unchanged, memory ${label} the project`, t => {
    const f = setup(t, {inRepo}), before = new Set(Object.keys(snapshot(f).memory));
    const r = f.run();
    assert.equal(r.code, 0, r.output);
    const added = Object.keys(snapshot(f).memory).filter(name => !before.has(name)).sort();
    assert.deepEqual(added, ['handovers/' + path.basename(r.noteFile)]);
    const note = read(r.noteFile), parsed = parseHandover(note);
    assert.deepEqual(Object.keys(parsed.data).sort(), ['branch', 'mode', 'sha', 'time']);
    assert.match(note, new RegExp(`\\*\\*Lessons:\\*\\* ${NONE.replace(/[()]/g, '\\$&')}\\n\\*\\*Roadmap:\\*\\* ${STATEMENT.replace(/[().]/g, '\\$&')}\\n`));
    const block = readCurrent(f.memoryDir).block;
    assert.equal(block, currentFromNote(note));
    assert.doesNotMatch(block, /Roadmap/);
  });
}

// What the three conditions do not include: each is reported, none changes the verdict.
test('the brain log is not a condition: a log with no entry for today is an operational line', t => {
  const f = setup(t);
  put(path.join(f.repo, 'brain/00-system/log.md'), '# Log\n\n## [2001-01-01] old | entry\n'); f.commit();
  const r = f.run();
  assert.equal(r.code, 1);
  assert.match(f.verdict(r.output), SAFE);
  assert.equal(f.finished(r.output), 'NOT FINISHED - log not updated today (brain/00-system/log.md)');
  assert.match(r.output, /\n\nNext: finish the items above \(to run: /);
  assert.doesNotMatch(r.output, /re-run:/);
});
test('an uncommitted roadmap or log does not fail a handover with memory outside the project', t => {
  const f = setup(t);
  put(f.roadmapFile, read(f.roadmapFile) + '\n- Another line added by hand.\n');
  const r = f.run();
  assert.equal(r.code, 0, r.output);
  assert.match(f.verdict(r.output), SAFE);
});

// The roadmap statement: words copied from one line of the roadmap, read once at the end.
const roadmapOf = lines => `# Roadmap\n\n## Open work (as of DATE)\n\n${lines.join('\n')}\n`;
const roadmapCases = [
  ['words that differ from the line only in case, bold marks and spacing', roadmapOf([`- **${ROADMAP_LINE}**`]), `updated (  KIT   work is UNDER way and nothing is blocked.  )`, true],
  ['words split over two lines', roadmapOf(['- Kit work is under way', '  and nothing is blocked.']), STATEMENT, false],
  ['a roadmap with no dated heading', `# Roadmap\n\n- ${ROADMAP_LINE}\n`, STATEMENT, true],
  ['a short line quoted whole', roadmapOf(['- No open work.']), 'nothing new (No open work.)', true],
  ['a short line written with bold marks and a star marker', roadmapOf(['* **No open work.**']), 'nothing new (No open work.)', true],
  ['a short line written with a numbered marker', roadmapOf(['3. No open work.']), 'nothing new (No open work.)', true],
  ['one short word', roadmapOf(['- No open work.']), 'updated (open)', false],
  ['one short word padded with marks that make it over 20 characters as typed', roadmapOf(['- No open work.']), 'updated (****__open__****____)', false],
  ['words that are in no line', roadmapOf(['- Something else entirely holds the state of the work.']), STATEMENT, false],
];
for (const [label, roadmap, statement, safe] of roadmapCases) test(`roadmap words: ${label}`, t => {
  const f = setup(t, {roadmap});
  f.saveInput({...f.defaults, roadmap: statement});
  const r = f.run();
  assert.equal(r.code, safe ? 0 : 1, r.output);
  if (safe) assert.match(f.verdict(r.output), /^SAFE TO COMPACT - memory saved; /);
  else assert.match(f.verdict(r.output), /^NOT SAFE TO COMPACT - roadmap: "[^"]*" is not on a line of docs\/ROADMAP\.md; write the line, or pass words that are there$/);
  assert.equal(f.notes().length, 1, 'memory is saved either way');
});
test('the two forms are worded apart in the verdict, and a second save with the same words is met again', t => {
  const f = setup(t, {roadmap: roadmapOf(['- No open work.'])});
  f.saveInput({...f.defaults, roadmap: 'nothing new (No open work.)'});
  for (let i = 0; i < 2; i++) {
    const r = f.run({replace: undefined}); assert.equal(r.code, 0, r.output);
    assert.match(f.verdict(r.output), /; roadmap already holds it \("No open work\."\)$/);
    assert.doesNotMatch(f.verdict(r.output), /roadmap updated/);
  }
  f.saveInput({...f.defaults, roadmap: 'updated (No open work.)'});
  assert.match(f.verdict(f.run().output), /; roadmap updated \("No open work\."\)$/);
});
for (const [label, statement] of [['empty words', 'updated ()'], ['formatting only', 'updated (** __ ** __)'], ['the none form', 'none (nothing to add today)'], ['a bare word', 'updated'], ['a made-up form', 'maybe (Kit work)']]) test(`a malformed roadmap statement is refused as input and nothing is written: ${label}`, t => {
  const f = setup(t), before = snapshot(f);
  f.saveInput({...f.defaults, roadmap: statement});
  const r = f.run();
  assert.equal(r.code, 1);
  assert.match(r.output, /^SAVE REFUSED - roadmap (must be|words must be)/);
  assert.match(r.output, /\. Nothing was written, so compact safety was not checked\.\n$/);
  assert.doesNotMatch(r.output, /^(SAFE|NOT SAFE)/m);
  assert.deepEqual(snapshot(f), before);
});
// The input's caps: a roadmap statement is at most 160 bytes, and the whole input grows by that (1,952 full, 1,184 quick).
test('a roadmap statement of 160 bytes is accepted and one of 161 is refused as input', t => {
  const f = setup(t), statement = bytes => 'updated (' + 'x'.repeat(bytes - 10) + ')';
  f.saveInput({...f.defaults, roadmap: statement(160)});
  assert.equal(f.run({check: true}).code, 0);
  f.saveInput({...f.defaults, roadmap: statement(161)});
  const refused = f.run({check: true});
  assert.equal(refused.code, 1);
  assert.match(refused.output, /^SAVE REFUSED - roadmap exceeds 160 B; /);
});
for (const [label, full, cap] of [['full', true, 1952], ['quick', false, 1184]]) test(`the whole input is capped at ${cap} bytes in a ${label} handover`, t => {
  const f = setup(t, {full}), raw = JSON.stringify(full ? f.defaults : input), pad = size => raw + ' '.repeat(size - Buffer.byteLength(raw));
  put(f.inputPath, pad(cap));
  assert.equal(f.run({check: true}).code, 0, `${cap} bytes accepted`);
  put(f.inputPath, pad(cap + 1));
  const refused = f.run({check: true});
  assert.equal(refused.code, 1);
  assert.match(refused.output, new RegExp(`^SAVE REFUSED - input exceeds ${cap} B; `));
});
test('nothing is remembered about the roadmap between saves: the same words are judged each time against the file as it is', t => {
  const f = setup(t, {roadmap: roadmapOf(['- Something else entirely holds the state of the work.'])});
  const missing = 'updated (Kit 3.3.10 build is under way with every item running)';
  const cause = /^NOT SAFE TO COMPACT - roadmap: "Kit 3\.3\.10 build is under way with every item running" is not on a line of docs\/ROADMAP\.md/;
  for (const [statement, args] of [[missing, {}], ['nothing new (Kit 3.3.10 build is under way with every item running)', {}], [missing, {over: 'none'}]]) {
    f.saveInput({...f.defaults, roadmap: statement});
    const r = f.run(args);
    assert.equal(r.code, 1, r.output);
    assert.match(f.verdict(r.output), cause);
  }
  // With --replace: the note of a save whose commit was stopped is still loose, so this run replaces it and judges the same words the same way.
  const g = setup(t, {roadmap: roadmapOf(['- Something else entirely holds the state of the work.'])});
  g.saveInput({...g.defaults, roadmap: missing});
  const first = g.run({}, {checkpoint() { throw Error('commit stopped'); }});
  assert.equal(first.code, 1);
  assert.match(g.verdict(first.output), cause);
  const replaced = g.run({replace: '000001', over: first.token});
  assert.equal(replaced.code, 1, replaced.output);
  assert.match(g.verdict(replaced.output), cause);
  put(f.roadmapFile, roadmapOf(['- Kit 3.3.10 build is under way with every item running']).replace('DATE', f.date));
  for (const statement of [missing, 'nothing new (Kit 3.3.10 build is under way with every item running)']) {
    f.saveInput({...f.defaults, roadmap: statement});
    const r = f.run({over: 'none'});
    assert.equal(r.code, 0, r.output);
    assert.match(f.verdict(r.output), statement.startsWith('updated') ? /roadmap updated/ : /roadmap already holds it/);
  }
});
for (const [label, inRepo] of modes) test(`the roadmap read at the end: a new line, committed or not, is found; a line removed during the run is not, memory ${label} the project`, t => {
  const f = setup(t, {inRepo});
  put(f.roadmapFile, read(f.roadmapFile) + '- A brand new line about this run.\n');
  if (inRepo) { f.commit(); f.git(f.repo, 'push'); }
  f.saveInput({...f.defaults, roadmap: 'updated (A brand new line about this run.)'});
  const found = f.run(); assert.equal(found.code, 0, found.output);
  f.saveInput({...f.defaults, roadmap: 'updated (A brand new line about this run.)'});
  const gone = f.run({over: 'none'}, {afterCurrent() { put(f.roadmapFile, read(f.roadmapFile).replace('- A brand new line about this run.\n', '')); }});
  assert.equal(gone.code, 1);
  assert.match(f.verdict(gone.output), /^NOT SAFE TO COMPACT - roadmap: "A brand new line about this run\." is not on a line of docs\/ROADMAP\.md/);
  if (inRepo) { f.commit(); f.git(f.repo, 'push'); }
  const deleted = f.run({over: 'none'}, {afterCurrent() { fs.unlinkSync(f.roadmapFile); }});
  assert.equal(deleted.code, 1);
  assert.match(f.verdict(deleted.output), /^NOT SAFE TO COMPACT - roadmap: no file at docs\/ROADMAP\.md/);
});
test('words that are only in the history file are not found', t => {
  const f = setup(t);
  put(path.join(f.repo, 'docs/ROADMAP-HISTORY.md'), '# History\n\n- Only the history holds this old line about the build.\n');
  f.saveInput({...f.defaults, roadmap: 'updated (Only the history holds this old line about the build.)'});
  const r = f.run();
  assert.equal(r.code, 1);
  assert.match(f.verdict(r.output), /^NOT SAFE TO COMPACT - roadmap: "Only the history holds/);
});
// Roadmap rotation is the previous release's: this run's checkpoint moves the oldest dated blocks to the history file, and a quote
// from a block it moved is not on a line of the roadmap any more. A quote from a block it keeps is.
const datedBlocks = n => Array.from({length: n}, (_, i) => `**2026-11-${String(10 + i).padStart(2, '0')} block ${i}**\n- Line ${i} of the block about the build.\n`).reverse().join('\n');
test('a rotation in this run that moves other blocks is SAFE and writes what the same rotation writes alone; a quote from a block it moved is NOT SAFE', t => {
  const roadmap = `# Roadmap\n\n## Open work\n\n${datedBlocks(8)}`, history = f => path.join(f.repo, 'docs/ROADMAP-HISTORY.md');
  const kept = setup(t, {roadmap});
  kept.saveInput({...kept.defaults, roadmap: 'updated (Line 7 of the block about the build.)'});
  const r = kept.run();
  assert.equal(r.code, 0, r.output);
  assert.match(kept.verdict(r.output), /; roadmap updated \("Line 7 of the block about the build\."\)$/);
  assert.doesNotMatch(read(kept.roadmapFile), /block 0\*\*/);
  const twin = setup(t, {roadmap});
  rotateRoadmap({repo: twin.repo, config: twin.config, memoryDir: twin.memoryDir, write: true});
  assert.equal(read(kept.roadmapFile), read(twin.roadmapFile), 'the roadmap is what the rotation writes alone');
  assert.equal(read(history(kept)), read(history(twin)), 'the history file is what the rotation writes alone');
  const moved = setup(t, {roadmap});
  moved.saveInput({...moved.defaults, roadmap: 'updated (Line 0 of the block about the build.)'});
  const gone = moved.run();
  assert.equal(gone.code, 1);
  assert.match(moved.verdict(gone.output), /^NOT SAFE TO COMPACT - roadmap: "Line 0 of the block about the build\." is not on a line of docs\/ROADMAP\.md/);
});
for (const [what, change] of [['an uncommitted change made before the run', f => put(f.roadmapFile, read(f.roadmapFile) + '- Earlier edit by hand.\n')], ['an update committed earlier the same day', f => { put(f.roadmapFile, read(f.roadmapFile) + '- Earlier edit by hand.\n'); f.commit(); }]]) test(`${what} is not the quoted line: words that are not in the file give NOT SAFE`, t => {
  const f = setup(t); change(f);
  f.saveInput({...f.defaults, roadmap: 'updated (This run wrote a line that is not in the file.)'});
  const r = f.run();
  assert.equal(r.code, 1);
  assert.match(f.verdict(r.output), /^NOT SAFE TO COMPACT - roadmap: "This run wrote a line that is not in the file\."/);
});

// Quick mode gives the verdict only for what it was told, and never words "not checked" as "not met".
const QUICK_TAIL = 'This is not a safe-to-compact verdict: pass both, or run /handover.';
test('quick: neither lessons nor roadmap given is a saved state, exit 0, never SAFE', t => {
  const f = setup(t, {full: false}), r = f.run();
  assert.equal(r.code, 0, r.output);
  assert.equal(f.verdict(r.output), `STATE SAVED (quick) - memory saved; not checked: learning and roadmap. ${QUICK_TAIL}`);
  assert.doesNotMatch(r.output, /^SAFE|NOT SAFE/m);
  assert.match(r.output, /lessons: skipped {2}checks: skipped/);
  assert.ok(Buffer.byteLength(r.output) <= 1536);
});
test('quick: one of the two given and holding names what holds and what was not checked, exit 0', t => {
  const f = setup(t, {full: false});
  f.saveInput({...input, lessons: NONE});
  const a = f.run(); assert.equal(a.code, 0, a.output);
  assert.equal(f.verdict(a.output), `STATE SAVED (quick) - memory saved; no learning stated (no new learning this session); not checked: roadmap. ${QUICK_TAIL}`);
  f.saveInput({...input, roadmap: STATEMENT});
  const b = f.run({over: 'none'}); assert.equal(b.code, 0, b.output);
  assert.equal(f.verdict(b.output), `STATE SAVED (quick) - memory saved; roadmap updated ("${ROADMAP_LINE}"); not checked: learning. ${QUICK_TAIL}`);
});
test('quick: both given and holding is SAFE (quick), exit 0', t => {
  const f = setup(t, {full: false});
  f.saveInput({...input, lessons: NONE, roadmap: STATEMENT});
  const r = f.run(); assert.equal(r.code, 0, r.output);
  assert.equal(f.verdict(r.output), 'SAFE TO COMPACT (quick) - memory saved; no learning stated (no new learning this session); roadmap updated ("Kit work is under way and nothing is blocked.")');
});
test('quick: a given condition that fails, or a memory proof that fails, is NOT SAFE with a non-zero exit', t => {
  const f = setup(t, {full: false});
  f.saveInput({...input, roadmap: 'updated (Words that are not in the roadmap anywhere at all.)'});
  const a = f.run(); assert.equal(a.code, 1);
  assert.match(f.verdict(a.output), /^NOT SAFE TO COMPACT - roadmap: "Words that are not in the roadmap anywhere at all\."/);
  f.saveInput(input);
  const b = f.run({over: 'none'}, {afterNote() { throw Error('stopped after the note'); }}); assert.equal(b.code, 1);
  assert.equal(f.verdict(b.output), "NOT SAFE TO COMPACT - memory not saved: current-state.md does not hold this run's state");
});
test('quick: a refusal before any write is SAVE REFUSED, and a batch is refused', t => {
  const f = setup(t, {full: false}), before = snapshot(f);
  f.saveInput({...input, lessons: 'none (short)'});
  const a = f.run(); assert.equal(a.code, 1); assert.match(a.output, /^SAVE REFUSED - lessons must be none \(<reason/);
  f.saveInput(input);
  const b = f.run({lessons: f.batch()}); assert.equal(b.code, 1); assert.match(b.output, /^SAVE REFUSED - quick forbids --lessons/);
  assert.deepEqual(snapshot(f), before);
});
test('quick: an operational failure puts NOT FINISHED above the last line and exits non-zero', t => {
  const f = setup(t, {full: false, remote: false, overlay: 'push: none\n'});
  const r = f.run();
  assert.equal(r.code, 1);
  assert.match(f.finished(r.output), /^NOT FINISHED - memory committed, NOT pushed \(HEAD not pushed \(push: none\)\): it exists on this disk only$/);
  assert.match(f.verdict(r.output), /^STATE SAVED \(quick\)/);
  assert.ok(r.output.indexOf('NOT FINISHED') < r.output.indexOf('STATE SAVED'));
});
test('a quick handover on the command line exits 0 for a saved state', t => {
  const f = setup(t, {full: false}), r = ok(f.cli());
  assert.match(r.stdout, /\n\nSTATE SAVED \(quick\) - memory saved; not checked: learning and roadmap\. /);
});

// A refusal is not evidence that knowledge is missing: it says so, exits non-zero and leaves every file as it was.
test('refusals print SAVE REFUSED, never a verdict, and leave the memory folder unchanged', t => {
  const f = setup(t), before = snapshot(f), refused = (r, pattern) => {
    assert.equal(r.code, 1, r.output);
    assert.match(r.output, pattern);
    assert.match(r.output, /Nothing was written, so compact safety was not checked\./);
    assert.doesNotMatch(r.output, /^(SAFE|NOT SAFE)|NOT SAFE/m);
    assert.deepEqual(snapshot(f), before);
  };
  put(f.inputPath, '{broken'); refused(f.run(), /^SAVE REFUSED - input must be a JSON object/);
  f.saveInput({...f.defaults, state: ''}); refused(f.run(), /^SAVE REFUSED - state is required/);
  f.saveInput(f.defaults);
  refused(f.run({memoryDir: path.join(f.root, 'absent')}), /^SAVE REFUSED - memory folder missing; run node scripts\/memory\/memory-init\.mjs/);
});
test('a command line usage error is a refusal, not NOT SAFE', t => {
  const f = setup(t), r = f.exec(process.execPath, [path.join(import.meta.dirname, '../engine/handover.mjs'), 'bogus']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^SAVE REFUSED - usage: handover\.mjs run\|check/);
  assert.doesNotMatch(r.stdout, /NOT SAFE/);
});
test('memory inside the project: an uncommitted roadmap is a refusal that says what to commit', t => {
  const f = setup(t, {inRepo: true});
  put(f.roadmapFile, read(f.roadmapFile) + '- Uncommitted line.\n');
  const before = snapshot(f), r = f.run();
  assert.equal(r.code, 1);
  assert.match(r.output, /^SAVE REFUSED - commit docs\/ROADMAP\.md first\. Nothing was written, so compact safety was not checked\.\n$/);
  assert.doesNotMatch(r.output, /NOT SAFE|roadmap not updated/);
  assert.deepEqual(snapshot(f), before);
});
test('memory outside the project: a rotation is due and the roadmap is uncommitted is a refusal that names the way out', t => {
  const f = setup(t);
  put(f.roadmapFile, `# Roadmap\n\n## Open work\n\n${datedBlocks(8)}`);
  const before = snapshot(f), r = f.run();
  assert.equal(r.code, 1);
  assert.match(r.output, /^SAVE REFUSED - commit docs\/ROADMAP\.md first, or re-run with --no-rotate\. Nothing was written, so compact safety was not checked\.\n$/);
  assert.doesNotMatch(r.output, /NOT SAFE|roadmap not updated/);
  assert.deepEqual(snapshot(f), before);
  f.saveInput({...f.defaults, roadmap: 'updated (Line 7 of the block about the build.)'});
  const again = f.run({noRotate: true});
  assert.equal(again.code, 0, again.output);
  assert.match(f.verdict(again.output), /^SAFE TO COMPACT - /);
});
test('a duplicate lesson section is a refusal that names the retry form', t => {
  const f = setup(t), batch = f.batch();
  assert.equal(f.run({lessons: batch}).code, 0);
  const before = snapshot(f), r = f.run({lessons: batch, over: 'none'});
  assert.equal(r.code, 1);
  assert.match(r.output, /^SAVE REFUSED - (lessons already written: lesson-001-capture-1\.md; set input lessons: none \(already written: lesson-001-capture-1\.md\); re-run without --lessons|lessons already written)/);
  assert.deepEqual(snapshot(f), before);
});
test('the preflight is a refusal: a staged project file, with memory inside the project', t => {
  const f = setup(t, {inRepo: true});
  put(path.join(f.repo, 'staged.txt'), 'x'); f.git(f.repo, 'add', 'staged.txt');
  const before = snapshot(f), r = f.run();
  assert.equal(r.code, 1);
  assert.match(r.output, /^SAVE REFUSED - staged index: unstage or commit these first: staged\.txt\. Nothing was written/);
  assert.deepEqual(snapshot(f), before);
});
test('a lock that timed out before the first write is a refusal', t => {
  const f = setup(t), before = snapshot(f);
  const r = f.run({}, {lockTimeoutMs: 1, beforeLock() { put(path.join(f.memoryDir, '.memory.lock'), '{}'); }});
  assert.equal(r.code, 1);
  assert.match(r.output, /^SAVE REFUSED - memory lock timed out/);
  assert.match(r.output, /Nothing was written, so compact safety was not checked\.\n$/);
  assert.doesNotMatch(r.output, /NOT SAFE/);
  const after = snapshot(f);
  assert.deepEqual(Object.keys(after.memory).filter(k => !k.endsWith('.memory.lock')), Object.keys(before.memory));
});
