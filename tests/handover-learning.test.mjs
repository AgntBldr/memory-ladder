// Learning is the second condition: lessons written, a lesson saved as a draft to finish later, or a stated none. The verdict reads
// what this run's batch wrote back from the disk, and no lesson file may be empty or unfilled on any save.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setup, snapshot, input, NONE, STATEMENT, LATER, put, read, ok, kitRoot, rerunCommand, runInShell} from './handover-fixture.mjs';
import {parseFrontmatter} from '../engine/lib.mjs';
import {runCheck} from '../engine/memory-check.mjs';
import {checkpoint} from '../engine/memory-checkpoint.mjs';
import {batchLessons} from '../engine/memory-lesson.mjs';

const DRAFT = 'lesson-001-the-gate-stayed-green-after-a-rotation-moved.md';
const later = text => `later (${text})`;
const gate = f => runCheck({memoryDir: f.memoryDir, repo: f.repo, config: f.config, scope: 'memory'}).findings.filter(x => !x.allowed);
// The re-run line a failed save prints, run as printed through sh in another process.
const rerun = (f, output) => {
  const line = rerunCommand(output);
  assert.ok(line, output);
  assert.ok(line.startsWith('node '), line);
  return runInShell(f, line);
};
const modes = [['outside', false], ['inside', true]];

for (const [label, inRepo] of modes) {
  test(`a lesson saved for later: SAFE with the draft file in the save's commit and one warning, memory ${label} the project`, t => {
    const f = setup(t, {inRepo});
    f.saveInput({...f.defaults, lessons: later(LATER)});
    const r = f.run();
    assert.equal(r.code, 0, r.output);
    assert.equal(f.verdict(r.output), `SAFE TO COMPACT - memory saved; lesson saved as a draft (${DRAFT}); roadmap updated ("Kit work is under way and nothing is blocked."); draft lessons to finish: 1`);
    assert.deepEqual(f.lessons(), [DRAFT]);
    const text = read(path.join(f.memoryDir, DRAFT)), data = parseFrontmatter(text).data;
    assert.match(data.metadata.draft, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(text, new RegExp(`\\n\\*\\*Draft:\\*\\* ${LATER.replace(/[.*+?^${}()|[\]\\;,]/g, '\\$&')}\\n\\n\\*\\*Why:\\*\\*\\n\\n\\*\\*How to apply:\\*\\*\\n$`));
    assert.deepEqual(data.metadata.route, ['craft-sessions']);
    assert.equal(f.git(f.holder, 'show', `HEAD:${inRepo ? 'memory/' : ''}${DRAFT}`), text.replace(/\n$/, ''));
    assert.match(read(r.noteFile), /\*\*Lessons:\*\* draft lesson-001-/);
    const found = gate(f);
    assert.deepEqual(found.filter(x => x.severity === 'FAIL'), []);
    assert.deepEqual(found.filter(x => x.check === 'lesson.draft').map(x => x.file), [DRAFT]);
  });
}
test('a draft text under 40 characters or under 6 words is refused as input', t => {
  const f = setup(t), before = snapshot(f);
  for (const text of ['Too short to be a lesson here.', 'Supercalifragilisticexpialidocious-supercalifragilisticexpialidocious rule']) {
    f.saveInput({...f.defaults, lessons: later(text)});
    const r = f.run();
    assert.equal(r.code, 1);
    assert.match(r.output, /^SAVE REFUSED - lessons: draft text must say what happened and the rule you would write, not a title/);
  }
  assert.deepEqual(snapshot(f), before);
});
test('the same save tried again three times, the commit stopped each time: one draft file, byte-identical, each run SAFE with NOT FINISHED', t => {
  const f = setup(t);
  f.saveInput({...f.defaults, lessons: later(LATER)});
  let first;
  for (let i = 0; i < 3; i++) {
    const r = f.run({over: 'none'}, {checkpoint() { throw Error('commit stopped'); }});
    assert.equal(r.code, 1);
    assert.match(f.verdict(r.output), /^SAFE TO COMPACT - memory saved; lesson saved as a draft \(lesson-001-/);
    assert.match(f.finished(r.output), /^NOT FINISHED - memory NOT committed \(commit stopped[^)]*\): an overwrite by another session could not be undone$/);
    assert.deepEqual(f.lessons(), [DRAFT]);
    first ??= read(path.join(f.memoryDir, DRAFT));
    assert.equal(read(path.join(f.memoryDir, DRAFT)), first);
  }
});
test('the retry with a changed later text writes a second draft; both are counted', t => {
  const f = setup(t);
  f.saveInput({...f.defaults, lessons: later(LATER)});
  assert.equal(f.run().code, 0);
  f.saveInput({...f.defaults, lessons: later(LATER.replace('green', 'quiet'))});
  const r = f.run({over: 'none'});
  assert.equal(r.code, 0, r.output);
  assert.equal(f.lessons().length, 2);
  assert.match(f.verdict(r.output), /; draft lessons to finish: 2$/);
});
for (const [what, patch, extra] of [
  ['lessons: none', {lessons: NONE}, {}],
  ['lessons: none with --replace', {lessons: NONE}, {replace: '000001'}],
  ['a changed state', {lessons: NONE, state: 'A different state of the work'}, {}],
]) test(`the retry with ${what} leaves the draft byte-identical and counts it in the last line`, t => {
  const f = setup(t);
  f.saveInput({...f.defaults, lessons: later(LATER)});
  const first = f.run({}, {checkpoint() { throw Error('commit stopped'); }}), before = read(path.join(f.memoryDir, DRAFT));
  assert.equal(first.code, 1);
  f.saveInput({...f.defaults, ...patch});
  const r = f.run({over: first.token, ...extra});
  assert.equal(r.code, 0, r.output);
  assert.equal(read(path.join(f.memoryDir, DRAFT)), before);
  assert.match(f.verdict(r.output), /^SAFE TO COMPACT - memory saved; no learning stated \(no new learning this session\); roadmap updated .*; draft lessons to finish: 1$/);
});
test('the retry in quick mode with lessons left out leaves the draft in place, and a quick later writes the same draft', t => {
  const f = setup(t, {full: false});
  f.saveInput({...input, lessons: later(LATER)});
  const first = f.run(); assert.equal(first.code, 0, first.output);
  assert.deepEqual(f.lessons(), [DRAFT]);
  const before = read(path.join(f.memoryDir, DRAFT));
  f.saveInput(input);
  const second = f.run({over: 'none'}); assert.equal(second.code, 0, second.output);
  assert.equal(read(path.join(f.memoryDir, DRAFT)), before);
  assert.deepEqual(f.lessons(), [DRAFT]);
  assert.match(f.verdict(first.output), /^STATE SAVED \(quick\) - memory saved; lesson saved as a draft \(/);
});

// Finishing a draft is an edit of the file, and no lesson file may be empty or unfilled on any later save.
test('finishing a draft: no warning, the count is 0, and a save is SAFE without the draft words', t => {
  const f = setup(t);
  f.saveInput({...f.defaults, lessons: later(LATER)});
  assert.equal(f.run().code, 0);
  const file = path.join(f.memoryDir, DRAFT);
  put(file, read(file).replace(/^  draft: .*\n/m, '').replace('**Why:**\n', '**Why:**\nA green gate hid a missing lesson.\n').replace('**How to apply:**\n', '**How to apply:**\nList the pages after every move.\n').replace('description: "DRAFT, to finish: ', 'description: "'));
  f.saveInput({...f.defaults, state: 'After finishing the draft'});
  const r = f.run({over: 'none'});
  assert.equal(r.code, 0, r.output);
  assert.doesNotMatch(f.verdict(r.output), /draft/);
  assert.equal(gate(f).filter(x => x.check === 'lesson.draft').length, 0);
});
const damaged = [
  ['the draft line deleted from an unfilled draft', text => text.replace(/^  draft: .*\n/m, '')],
  ['the draft cut to its front matter', text => text.slice(0, text.indexOf('\n---\n', 4) + 5)],
  ['the draft emptied to zero bytes', () => ''],
];
for (const [what, change] of damaged) for (const quick of [false, true]) test(`${what} is NOT SAFE on every later save, whatever its input: ${quick ? 'quick with lessons given' : 'full'}`, t => {
  const f = setup(t, {full: !quick});
  f.saveInput({...f.defaults, lessons: later(LATER)});
  assert.equal(f.run().code, 0);
  const file = path.join(f.memoryDir, DRAFT);
  put(file, change(read(file)));
  for (const [i, lessons] of [NONE, 'none (a different reason for this save)', later(LATER.replace('green', 'quiet'))].entries()) {
    f.saveInput({...f.defaults, lessons, state: `Save ${i}`});
    const r = f.run({over: 'none'});
    assert.equal(r.code, 1, r.output);
    assert.match(f.verdict(r.output), new RegExp(`^NOT SAFE TO COMPACT - .*learning: ${DRAFT.replace('.', '\\.')} is not a finished lesson or a draft with its text`), r.output);
    assert.doesNotMatch(r.output, /git (?:checkout|restore|show)|from HEAD|HEAD:|restore from|overwrite (?:it|the file|the lesson)/i, 'no text tells the caller to overwrite a file from HEAD');
  }
});
test('a lesson file the project allows to stay unfilled is not a cause', t => {
  const f = setup(t);
  const config = JSON.parse(read(path.join(f.repo, 'scripts/memory/memory.config.json')));
  config.allow = [{check: 'lesson.unfilled-body', file: 'lesson-009-*', reason: 'kept unfilled on purpose in this fixture', added: '2026-11-17'}];
  put(path.join(f.repo, 'scripts/memory/memory.config.json'), JSON.stringify(config)); f.commit();
  put(path.join(f.memoryDir, 'lesson-009-unfilled-on-purpose.md'), `---\nname: lesson-009-unfilled-on-purpose\ndescription: "An unfilled lesson that the project allows."\nmetadata:\n  type: feedback\n  kind: practice\n  lesson: "009"\n  date: 2026-11-17\n  route: ["craft-sessions"]\n---\n\n**#009. Unfilled.**\n\n**Why:**\n\n**How to apply:**\n`);
  const r = f.run();
  assert.equal(r.code, 0, r.output);
  assert.match(f.verdict(r.output), /^SAFE TO COMPACT - /);
});

// What the batch wrote is read back from the disk when the run ends: with the checkpoint succeeding (the file changes after the
// commit) and with the commit stopped (the file changes before the checkpoint, so the gate refuses it).
const tamper = {
  'a created lesson file emptied': (f, name) => fs.writeFileSync(path.join(f.memoryDir, name), ''),
  'a created lesson file cut to half': (f, name) => { const file = path.join(f.memoryDir, name), text = read(file); fs.writeFileSync(file, text.slice(0, Math.floor(text.length / 2))); },
};
for (const [what, change] of Object.entries(tamper)) for (const stopped of [false, true]) test(`${what}, ${stopped ? 'with the commit stopped' : 'with the checkpoint succeeding'}: NOT SAFE naming the file`, t => {
  const f = setup(t), batch = f.batch(), head = f.git(f.holder, 'rev-parse', 'HEAD');
  let stopFired = false;
  const hook = stopped ? {afterCurrent: ctx => change(f, ctx.created[0]), checkpoint() { stopFired = true; throw Error('commit stopped'); }} : {beforeVerify: ctx => change(f, ctx.created[0])};
  const r = f.run({lessons: batch}, hook);
  assert.equal(r.code, 1, r.output);
  assert.match(f.verdict(r.output), /^NOT SAFE TO COMPACT - learning: not on disk as written: lesson-001-capture-1\.md/);
  if (stopped) { assert.ok(stopFired, 'the checkpoint injection fired'); assert.equal(f.git(f.holder, 'rev-parse', 'HEAD'), head, 'HEAD did not move'); }
});
for (const stopped of [false, true]) test(`a recurrence entry reverted, ${stopped ? 'with the commit stopped' : 'with the checkpoint succeeding'}: NOT SAFE naming the file`, t => {
  const f = setup(t);
  assert.equal(f.run({lessons: f.batch()}).code, 0);
  const lesson = path.join(f.memoryDir, 'lesson-001-capture-1.md'), original = read(lesson), head = f.git(f.holder, 'rev-parse', 'HEAD');
  const repeat = put(path.join(f.root, 'repeat.md'), '## Repeat\nrepeat-of: 1\ncause: slip\ndescription: did it again\n');
  f.saveInput({...f.defaults, state: 'Second save'});
  // With the commit stopped the checkpoint itself is made to fail, so the revert is the only thing the final proof can find.
  let stopFired = false;
  const hooks = stopped ? {afterCurrent: () => fs.writeFileSync(lesson, original), checkpoint() { stopFired = true; throw Error('commit stopped'); }} : {beforeVerify: () => fs.writeFileSync(lesson, original)};
  const r = f.run({lessons: repeat, over: 'none'}, hooks);
  assert.equal(r.code, 1, r.output);
  assert.match(f.verdict(r.output), /^NOT SAFE TO COMPACT - learning: not on disk as written: lesson-001-capture-1\.md/);
  if (stopped) { assert.ok(stopFired, 'the checkpoint injection fired'); assert.equal(f.git(f.holder, 'rev-parse', 'HEAD'), head, 'HEAD did not move'); }
});

// The lesson tool never leaves a part of a lesson under a lesson's name, so the printed recovery of a failed batch works.
const sectionFailing = (t, which) => {
  const real = fs.writeFileSync; let temps = 0;
  t.mock.method(fs, 'writeFileSync', (name, text, options) => {
    if (/lesson-[^/\\]*\.tmp$/.test(String(name)) && ++temps === which) { real(name, String(text).slice(0, Math.floor(String(text).length / 2)), options); throw Error('disk full injected'); }
    return real(name, text, options);
  });
};
for (const [label, which, count] of [['the only section', 1, 1], ['the second of two sections', 2, 2]]) test(`a creation that fails half way: NOT SAFE, the printed re-run writes the lessons whole and is SAFE: ${label}`, t => {
  const f = setup(t), batch = f.batch(count);
  sectionFailing(t, which);
  const r = f.run({lessons: batch});
  t.mock.restoreAll();
  assert.equal(r.code, 1, r.output);
  assert.match(f.verdict(r.output), /learning: lesson batch not written \(disk full injected\)/);
  assert.match(r.output, /re-run: /);
  assert.match(r.output, /--lessons /);
  assert.deepEqual(f.lessons(), []);
  const second = rerun(f, r.output);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /^SAFE TO COMPACT - memory saved; learning added \(\d lessons\); /m);
  assert.equal(f.lessons().length, count);
  for (const name of f.lessons()) assert.match(read(path.join(f.memoryDir, name)), /\*\*Why:\*\*\nPartial writes can lose a session\./);
});
test('a batch with a recurrence whose rollback cannot restore: the report prints the re-run and the could-not-undo line, and the re-run is SAFE', t => {
  const f = setup(t);
  assert.equal(f.run({lessons: f.batch()}).code, 0);
  const target = path.join(f.memoryDir, 'lesson-001-capture-1.md'), original = read(target), repeat = put(path.join(f.root, 'repeat.md'), '## Repeat\nrepeat-of: 1\ncause: slip\ndescription: did it again\n');
  f.saveInput({...f.defaults, state: 'Second save'});
  const rename = fs.renameSync; let renames = 0;
  t.mock.method(fs, 'renameSync', (from, to) => { if (to === target && ++renames >= 2) throw Error('restore injected'); return rename(from, to); });
  const failing = (args) => batchLessons({...args, check: () => ({findings: [{check: 'lesson.repeats', severity: 'FAIL', file: 'lesson-001-capture-1.md', message: 'injected'}]})});
  const r = f.run({lessons: repeat, over: 'none'}, {batchLessons: failing});
  t.mock.restoreAll();
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /rollback failed/);
  // The recurrence entry it added is still on disk and uncommitted: read from the repository, since the batch returned no result to remember.
  assert.match(f.finished(r.output), /^NOT FINISHED - memory NOT committed \(the run stopped before the checkpoint: /);
  assert.match(r.output, /^uncommitted: `lesson-001-capture-1\.md`$/m);
  assert.match(r.output, /the batch stopped and could not undo everything: a lesson it created is named by the re-run's duplicate refusal \(follow that instruction\); a recurrence entry it added stays, and the re-run adds it again/);
  assert.match(r.output, /re-run: /);
  const whole = read(target);
  assert.ok(whole === original || whole.startsWith(original.replace(/\n$/, '').split('\n').slice(0, 3).join('\n')), 'a whole lesson');
  assert.match(whole, /\*\*Why:\*\*\nPartial writes can lose a session\./);
  const second = rerun(f, r.output);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const entries = parseFrontmatter(read(target)).data.metadata.repeats;
  assert.ok(entries.length >= 1 && entries.length <= 2, String(entries.length));
  assert.match(read(target), /\*\*Why:\*\*\nPartial writes can lose a session\./);
});
// The recurrence target already showed as modified before the run, so its status is the same after a failed rollback: only its content
// tells that the batch changed it.
test('a recurrence target that was already uncommitted, with a rollback that cannot restore it: the report still lists it, from its content', t => {
  const f = setup(t);
  assert.equal(f.run({lessons: f.batch()}).code, 0);
  const target = path.join(f.memoryDir, 'lesson-001-capture-1.md');
  fs.appendFileSync(target, '\nA hand edit that is not committed yet.\n');
  // The test helper trims what git prints, which drops the leading space of the first line.
  assert.match(f.git(f.holder, 'status', '--porcelain'), /^\s?M lesson-001-capture-1\.md$/m, 'dirty before the run');
  const dirty = read(target), repeat = put(path.join(f.root, 'repeat.md'), '## Repeat\nrepeat-of: 1\ncause: slip\ndescription: did it again\n');
  f.saveInput({...f.defaults, state: 'Second save'});
  const rename = fs.renameSync; let renames = 0;
  t.mock.method(fs, 'renameSync', (from, to) => { if (to === target && ++renames >= 2) throw Error('restore injected'); return rename(from, to); });
  const failing = args => batchLessons({...args, check: () => ({findings: [{check: 'lesson.repeats', severity: 'FAIL', file: 'lesson-001-capture-1.md', message: 'injected'}]})});
  const r = f.run({lessons: repeat, over: 'none'}, {batchLessons: failing});
  t.mock.restoreAll();
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /rollback failed/);
  assert.notEqual(read(target), dirty, 'the batch left its recurrence entry in the file');
  assert.match(f.finished(r.output), /^NOT FINISHED - memory NOT committed \(the run stopped before the checkpoint: /);
  assert.match(r.output, /^uncommitted: `lesson-001-capture-1\.md`$/m);
});
test('a batch that created a lesson and whose rollback cannot delete it: the re-run meets the duplicate refusal, and following it is SAFE with the lesson whole', t => {
  const f = setup(t), batch = f.batch();
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', name => { if (/lesson-001-capture-1\.md$/.test(String(name))) throw Error('delete injected'); return unlink(name); });
  const failing = args => batchLessons({...args, check: () => ({findings: [{check: 'lesson.repeats', severity: 'FAIL', file: 'lesson-001-capture-1.md', message: 'injected'}]})});
  const r = f.run({lessons: batch}, {batchLessons: failing});
  t.mock.restoreAll();
  assert.equal(r.code, 1, r.output);
  assert.deepEqual(f.lessons(), ['lesson-001-capture-1.md']);
  // The lesson it created could not be deleted: it is on disk and uncommitted, and the report says so though no result names it.
  assert.match(f.finished(r.output), /^NOT FINISHED - memory NOT committed \(the run stopped before the checkpoint: /);
  assert.match(r.output, /^uncommitted: `lesson-001-capture-1\.md`$/m);
  const second = rerun(f, r.output);
  assert.equal(second.status, 1);
  assert.match(second.stdout, /^SAVE REFUSED - lessons already written: lesson-001-capture-1\.md; set input lessons: none \(already written: lesson-001-capture-1\.md\); re-run without --lessons/);
  f.saveInput({...f.defaults, lessons: 'none (already written: lesson-001-capture-1.md)'});
  const third = f.run({over: 'none'});
  assert.equal(third.code, 0, third.output);
  assert.match(f.verdict(third.output), /; lessons already written \(lesson-001-capture-1\.md\); /);
  assert.match(read(path.join(f.memoryDir, 'lesson-001-capture-1.md')), /Verify the committed bytes and publication\./);
});

// A lock that times out after the batch wrote a lesson is not a refusal: the lesson is on disk, memory is not saved, and the retry finishes it.
test('a lock timeout after the batch wrote a lesson is NOT SAFE with memory not saved, and the printed retry is SAFE with one copy of the lesson', t => {
  const f = setup(t), lock = path.join(f.memoryDir, '.memory.lock');
  const r = f.run({lessons: f.batch()}, {lockTimeoutMs: 1, beforeLock() { put(lock, '{}'); }});
  assert.equal(r.code, 1, r.output);
  assert.match(f.verdict(r.output), /^NOT SAFE TO COMPACT - memory not saved: the run stopped before the note \(memory lock timed out/);
  assert.match(r.output, /lessons already written: `lesson-001-capture-1\.md`; set input lessons: none \(already written: `lesson-001-capture-1\.md`\) before retry\./);
  assert.deepEqual(f.lessons(), ['lesson-001-capture-1.md']);
  fs.unlinkSync(lock);
  f.saveInput({...f.defaults, lessons: 'none (already written: lesson-001-capture-1.md)'});
  const second = rerun(f, r.output);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /^SAFE TO COMPACT - memory saved; lessons already written \(lesson-001-capture-1\.md\); /m);
  assert.deepEqual(f.lessons(), ['lesson-001-capture-1.md']);
});

// The 3.3.9 retry works as it did: the instruction names the files, the input says so, and no lesson is written twice.
test('the retry after a failed first attempt: the instruction names the files, the re-run is SAFE and writes no lesson file', t => {
  const f = setup(t), batch = f.batch(2);
  f.saveInput({...f.defaults, roadmap: undefined});
  const first = f.run({lessons: batch}, {checkpoint() { throw Error('commit stopped'); }});
  assert.equal(first.code, 1);
  assert.match(first.output, /lessons already written: `lesson-001-capture-1\.md`, `lesson-002-capture-2\.md`; set input lessons: none \(already written: `lesson-001-capture-1\.md`, `lesson-002-capture-2\.md`\) before retry\./);
  const lessons = f.lessons();
  f.saveInput({...f.defaults, lessons: 'none (already written: lesson-001-capture-1.md, lesson-002-capture-2.md)'});
  const second = f.run({over: first.token});
  assert.equal(second.code, 0, second.output);
  assert.match(f.verdict(second.output), /^SAFE TO COMPACT - memory saved; lessons already written \(lesson-001-capture-1\.md, lesson-002-capture-2\.md\); /);
  assert.deepEqual(f.lessons(), lessons);
});
test('an input written by hand in the retry form is accepted with the lessons on disk, and NOT SAFE with one of the files emptied', t => {
  const f = setup(t);
  assert.equal(f.run({lessons: f.batch(2)}).code, 0);
  f.saveInput({...f.defaults, lessons: 'none (already written: lesson-001-capture-1.md, lesson-002-capture-2.md)', state: 'Hand written retry'});
  const accepted = f.run({over: 'none'}); assert.equal(accepted.code, 0, accepted.output);
  fs.writeFileSync(path.join(f.memoryDir, 'lesson-002-capture-2.md'), '');
  const emptied = f.run({over: 'none'});
  assert.equal(emptied.code, 1);
  assert.match(f.verdict(emptied.output), /learning: lesson-002-capture-2\.md is not a finished lesson or a draft with its text/);
  f.saveInput({...f.defaults, lessons: 'none (an unrelated reason for this save)', state: 'A new save'});
  const unrelated = f.run({over: 'none'});
  assert.equal(unrelated.code, 1);
  assert.match(f.verdict(unrelated.output), /learning: lesson-002-capture-2\.md is not a finished lesson or a draft with its text/);
});

// Nothing in the checkpoint touches a lesson file or the state block: indexes, rotation, the gate, the commit and the push.
for (const [label, inRepo] of modes) test(`no step of the checkpoint rewrites a lesson file or the state block, memory ${label} the project`, t => {
  const f = setup(t, {inRepo}), stateFile = path.join(f.memoryDir, 'current-state.md');
  const lessonTexts = () => f.lessons().map(name => read(path.join(f.memoryDir, name)));
  f.saveInput({...f.defaults, lessons: later(LATER)});
  let seen;
  const r = f.run({lessons: f.batch(2)}, {checkpoint(options) {
    seen = {state: read(stateFile), names: f.lessons(), texts: lessonTexts()};
    const result = checkpoint(options);
    assert.equal(read(stateFile), seen.state);
    assert.deepEqual(f.lessons(), seen.names);
    assert.deepEqual(lessonTexts(), seen.texts);
    return result;
  }});
  assert.equal(r.code, 0, r.output);
  assert.equal(seen.names.length, 3, 'two lessons of the batch and the draft were on disk when the checkpoint ran');
});

// The draft line is read from the files at the start, so a draft written long ago and a branch that never saw it still show it.
test('25 later saves on another branch archive every note of the first branch, and a start on the first branch and one on a third both print the draft line first', t => {
  const f = setup(t), helper = path.join(kitRoot, 'engine/new-session.mjs');
  const start = dir => f.exec(process.execPath, [helper, 'start', '--repo', dir, '--memory-dir', f.memoryDir]).stdout;
  f.saveInput({...f.defaults, lessons: later(LATER)});
  assert.equal(f.run().code, 0);
  const first = f.notes()[0], other = f.other();
  for (let i = 0; i < 25; i++) {
    f.saveInput({...f.defaults, state: 'Save ' + i + ' on the other branch'});
    const r = f.run({repo: other, over: 'none'});
    assert.equal(r.code, 0, r.output);
  }
  assert.equal(f.notes().includes(first), false, 'the first branch\'s note was archived');
  assert.equal(f.notes().length, 20);
  const third = path.join(f.root, 'third'); f.git(f.repo, 'worktree', 'add', '-q', '-b', 'third', third);
  for (const dir of [f.repo, third]) {
    const lines = start(dir).split('\n'), at = lines.findIndex(line => line.startsWith('draft lessons to finish')), lead = lines.findIndex(line => /^(last handover:|state:|state block not used|no hand-over note)/.test(line));
    assert.equal(lines[at], `draft lessons to finish (1): ${DRAFT}`);
    assert.ok(at > 0 && at < lead, lines.join('\n'));
  }
});

test('a retry that names a lesson file which is not on disk is NOT SAFE, naming the file', t => {
  const f = setup(t);
  f.saveInput({...f.defaults, lessons: 'none (already written: lesson-999-missing.md)'});
  const r = f.run();
  assert.equal(r.code, 1, r.output);
  assert.equal(f.verdict(r.output), 'NOT SAFE TO COMPACT - learning: not on disk as written: lesson-999-missing.md');
});
test('the check after a draft was saved names that draft, not a new one, and writes nothing', t => {
  const f = setup(t);
  f.saveInput({...f.defaults, lessons: later(LATER)});
  assert.equal(f.run().code, 0);
  const before = snapshot(f), checked = f.run({check: true});
  assert.equal(checked.code, 0, checked.output);
  assert.ok(checked.output.includes(`plan: lessons draft ${DRAFT};`), checked.output);
  assert.deepEqual(snapshot(f), before);
});
test('a draft that cannot be composed refuses the save before anything is written', t => {
  const f = setup(t);
  put(path.join(f.memoryDir, 'MEMORY.md'), '# Memory router\n\nNo routing rows are listed here.\n');
  f.saveInput({...f.defaults, lessons: later(LATER)});
  const before = snapshot(f), r = f.run();
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /^SAVE REFUSED - the draft lesson cannot be composed: the router has no routing family/);
  assert.deepEqual(snapshot(f), before);
});

// The printed recovery never gives up an unsaved draft text: the input keeps `later (...)`, and only the completed batch is left out.
test('a draft write that fails after the batch wrote: the printed recovery keeps the draft text and, run as printed, saves it', t => {
  const f = setup(t), batch = f.batch();
  f.saveInput({...f.defaults, lessons: later(LATER)});
  let fired = false;
  const r = f.run({lessons: batch}, {draftLesson() { fired = true; throw Error('draft write injected'); }});
  assert.ok(fired, 'the injection fired');
  assert.equal(r.code, 1, r.output);
  assert.deepEqual(f.lessons(), ['lesson-001-capture-1.md'], 'the batch is written, the draft is not');
  assert.match(f.verdict(r.output), /^NOT SAFE TO COMPACT - .*learning: draft not on disk/);
  assert.match(r.output, /lessons already written: `lesson-001-capture-1\.md`; keep lessons: later \(\.\.\.\) as it is and re-run without --lessons; the draft text is not saved until a save completes\./);
  assert.doesNotMatch(r.output, /none \(already written/);
  assert.doesNotMatch(r.output, /--lessons '/, 'the printed re-run leaves the completed batch out');
  // The batch given again is refused with the same advice, and nothing more is written.
  const again = f.run({lessons: batch, over: 'none'});
  assert.equal(again.code, 1);
  assert.match(again.output, /^SAVE REFUSED - lessons already written: lesson-001-capture-1\.md; keep lessons: later \(\.\.\.\) as it is and re-run without --lessons/);
  assert.deepEqual(f.lessons(), ['lesson-001-capture-1.md']);
  // The exact printed recovery, run in another process with the input unchanged, saves the draft text and is SAFE.
  const done = rerun(f, r.output);
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.match(f.verdict(done.stdout), /^SAFE TO COMPACT - memory saved; lesson saved as a draft \(lesson-002-/);
  assert.equal(f.lessons().length, 2);
  const draft = f.lessons().find(name => name !== 'lesson-001-capture-1.md');
  assert.ok(read(path.join(f.memoryDir, draft)).includes(`**Draft:** ${LATER}`));
});

test('a draft text on a retry is not refused for lessons an earlier unfinished save wrote: it is saved beside them', t => {
  const f = setup(t), batch = f.batch();
  const first = f.run({lessons: batch}, {checkpoint() { throw Error('commit stopped'); }});
  assert.equal(first.created.length, 1);
  f.saveInput({...f.defaults, lessons: later(LATER)});
  const r = f.run({over: first.token});
  assert.equal(r.code, 0, r.output);
  assert.match(f.verdict(r.output), /^SAFE TO COMPACT - memory saved; lesson saved as a draft \(lesson-002-/);
  assert.equal(f.lessons().length, 2);
});

// What an "already written" input names is read the same way by every check: with or without the code spans the recovery line prints,
// and a name that is not a lesson file in memory, or is not a regular file, is a cause.
const writtenInput = names => 'none (already written: ' + names.join(', ') + ')';
for (const [what, names, prepare, cause] of [
  ['a missing lesson in code spans', ['`lesson-999-missing.md`'], () => {}, /^NOT SAFE TO COMPACT - learning: not on disk as written: lesson-999-missing\.md$/],
  ['a directory named like a lesson', ['lesson-998-directory.md'], f => fs.mkdirSync(path.join(f.memoryDir, 'lesson-998-directory.md')), /^NOT SAFE TO COMPACT - learning: not on disk as written: lesson-998-directory\.md$/],
  ['an entry that is not a lesson file', ['lesson-001-capture-1.md', 'notes.txt'], () => {}, /^NOT SAFE TO COMPACT - learning: already written names something that is not a lesson file: notes\.txt$/],
  ['a path', ['../lesson-001-capture-1.md'], () => {}, /^NOT SAFE TO COMPACT - learning: already written names something that is not a lesson file: \.\.\/lesson-001-capture-1\.md$/],
]) test(`an input naming ${what} as already written is NOT SAFE`, t => {
  const f = setup(t);
  assert.equal(f.run({lessons: f.batch()}).code, 0);
  prepare(f);
  f.saveInput({...f.defaults, lessons: writtenInput(names), state: 'A retry'});
  const r = f.run({over: 'none'});
  assert.equal(r.code, 1, r.output);
  assert.match(f.verdict(r.output), cause);
});
test('the printed recovery form, names in code spans, is accepted when the files are there', t => {
  const f = setup(t);
  assert.equal(f.run({lessons: f.batch(2)}).code, 0);
  f.saveInput({...f.defaults, lessons: writtenInput(['`lesson-001-capture-1.md`', '`lesson-002-capture-2.md`']), state: 'A retry'});
  const r = f.run({over: 'none'});
  assert.equal(r.code, 0, r.output);
  assert.match(f.verdict(r.output), /^SAFE TO COMPACT - memory saved; lessons already written \(/);
});
