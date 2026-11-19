// A commit, a push, the gate as a whole, the brain log and the close steps are operational: each is reported on its own line
// above the verdict, with what it puts at risk, and none of them changes the verdict. The three conditions are proved from the
// disk at the end of the run, whatever the checkpoint did.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {setup, snapshot, input, NONE, STATEMENT, LATER, put, read, ok, printedCommands, runPrinted, byHandLine, assertCommittedAndPushed} from './handover-fixture.mjs';
import {parseHandover, localTime} from '../engine/lib.mjs';
import {readCurrent, listNotes} from '../engine/session-core.mjs';
import {currentFromNote, mergeCurrent} from '../engine/handover.mjs';
import {claimFiles} from '../engine/memory-session.mjs';
import {composeDraft} from '../engine/memory-lesson.mjs';

const RISK_NOT_COMMITTED = 'an overwrite by another session could not be undone';
const RISK_NOT_PUSHED = 'it exists on this disk only';
const modes = [['outside', false], ['inside', true]];
const SAFE_START = /^SAFE TO COMPACT - memory saved; no learning stated \(no new learning this session\); roadmap updated \(/;
// A memory file with an unclosed front matter: a gate FAIL that has nothing to do with the three conditions.
// With memory inside the project the broken file is committed and pushed first: an uncommitted memory file is refused before anything is written.
const brokenFile = f => {
  put(path.join(f.memoryDir, 'topic-broken.md'), '---\nname: topic-broken\n');
  if (f.inRepo) { f.commit(); f.git(f.repo, 'push'); }
};

for (const [label, inRepo] of modes) {
  test(`a gate FAIL that stops the commit: SAFE with NOT FINISHED and its risk, a non-zero exit, memory ${label} the project`, t => {
    const f = setup(t, {inRepo}); brokenFile(f);
    const r = f.run();
    assert.equal(r.code, 1, r.output);
    assert.match(f.verdict(r.output), SAFE_START);
    assert.match(f.finished(r.output), new RegExp(`^NOT FINISHED - memory NOT committed \\(.*\\): ${RISK_NOT_COMMITTED}$`));
    assert.match(r.output, /\n\nNext: finish the items above \(to run: the finish line below\); do not run \/handover again for them\n/);
    assert.doesNotMatch(r.output, /re-run:/);
    assert.equal(read(r.noteFile), r.note, 'the note is on disk');
    const listed = /^uncommitted: (.*)$/m.exec(r.output)?.[1];
    assert.ok(listed && listed.includes('`current-state.md`') && /`handovers\/000001-[^`]+\.md`/.test(listed), r.output);
    // The printed commands are built from the run: in a project that holds its memory the checkpoint commits with --commit and a second
    // step pushes; with memory outside it the checkpoint commits and pushes. Run as printed, once the gate FAIL is cleared, they finish the save.
    const commands = printedCommands(r.output);
    assert.equal(commands.length, inRepo ? 2 : 1, r.output);
    assert.match(commands[0], new RegExp(`^node '[^']*memory-checkpoint\\.mjs' --repo '[^']*' --memory-dir '[^']*' --config '[^']*memory\\.config\\.json'${inRepo ? ' --commit' : ''}$`));
    if (inRepo) assert.match(commands[1], /^git -C '[^']*' push$/);
    fs.rmSync(path.join(f.memoryDir, 'topic-broken.md'));
    runPrinted(f, r.output);
    assertCommittedAndPushed(f, r.noteFile);
  });
  test(`the same gate FAIL with one lesson file emptied is NOT SAFE, memory ${label} the project`, t => {
    const f = setup(t, {inRepo}); brokenFile(f);
    const first = f.run({lessons: f.batch()});
    assert.equal(first.code, 1);
    fs.writeFileSync(path.join(f.memoryDir, 'lesson-001-capture-1.md'), '');
    const r = f.run({over: 'none'});
    assert.equal(r.code, 1);
    assert.match(f.verdict(r.output), /^NOT SAFE TO COMPACT - learning: lesson-001-capture-1\.md is not a finished lesson or a draft with its text/);
    assert.match(f.finished(r.output), /^NOT FINISHED - memory NOT committed/);
  });
  test(`a push that fails after the commit: SAFE with NOT FINISHED, the next step names the push, and that command alone finishes it, memory ${label} the project`, t => {
    const f = setup(t, {inRepo});
    f.git(f.holder, 'remote', 'set-url', 'origin', 'missing.git');
    const r = f.run();
    assert.equal(r.code, 1, r.output);
    assert.match(f.verdict(r.output), SAFE_START);
    assert.match(f.finished(r.output), new RegExp(`^NOT FINISHED - memory committed, NOT pushed \\(push failed: .*\\): ${RISK_NOT_PUSHED}$`));
    assert.match(r.output, /\n\nNext: finish the items above \(to run: the finish line below\); do not run \/handover again for them\n/);
    assert.equal(printedCommands(r.output).length, 1, r.output);
    assert.match(printedCommands(r.output)[0], /^git -C .* push$/);
    assert.doesNotMatch(r.output, /re-run:/);
    // The remote is repaired, then the printed command alone finishes the save.
    f.git(f.holder, 'remote', 'set-url', 'origin', f.bare);
    runPrinted(f, r.output);
    assertCommittedAndPushed(f, r.noteFile);
  });
}
test('a checkpoint that fails after the files are written: the note is on disk, the verdict reads the disk, NOT FINISHED says memory is not committed', t => {
  const f = setup(t), r = f.run({}, {checkpoint() { throw Error('checkpoint crashed'); }});
  assert.equal(r.code, 1);
  assert.match(f.verdict(r.output), SAFE_START);
  assert.equal(f.finished(r.output), `NOT FINISHED - memory NOT committed (checkpoint crashed): ${RISK_NOT_COMMITTED}`);
  // The printed command, run as printed, commits the save and pushes it.
  runPrinted(f, r.output);
  assertCommittedAndPushed(f, r.noteFile);
  assert.equal(f.git(f.holder, 'status', '--porcelain'), '', 'nothing is left uncommitted');
});
test('a push that fails in session mode (a failed publication) is operational too', t => {
  const f = setup(t, {session: true});
  f.git(f.holder, 'remote', 'set-url', 'origin', 'missing.git');
  const r = f.run();
  assert.equal(r.code, 1, r.output);
  assert.match(f.verdict(r.output), SAFE_START);
  assert.match(f.finished(r.output), /^NOT FINISHED - memory committed, NOT pushed \(push failed: /);
  assert.doesNotMatch(r.output, /re-run:/);
});
test('push: none is NOT FINISHED with a SAFE verdict when the three hold', t => {
  const f = setup(t, {remote: false, overlay: 'push: none\n'}), r = f.run();
  assert.equal(r.code, 1);
  assert.match(f.verdict(r.output), SAFE_START);
  assert.equal(f.finished(r.output), `NOT FINISHED - memory committed, NOT pushed (HEAD not pushed (push: none)): ${RISK_NOT_PUSHED}`);
  // Under push: none no push command is ever printed: the finish is by hand and says why.
  assert.deepEqual(printedCommands(r.output), []);
  assert.doesNotMatch(r.output, /\bgit -C .* push/);
  assert.match(byHandLine(r.output), /^push is off \(push: none\), so memory stays on this disk until you push it; files: `handovers\/000001-[^`]+\.md`, `current-state\.md`; memory: `/);
  assert.match(r.output, /\n\nNext: finish the items above by hand \(the finish by hand line below\); do not run \/handover again for them\n/);
});
test('with no remote the commit is the whole publication: SAFE, no NOT FINISHED, exit 0', t => {
  const f = setup(t, {remote: false}), r = f.run();
  assert.equal(r.code, 0, r.output);
  assert.equal(f.finished(r.output), '');
  assert.match(r.output, /memory [0-9a-f]{7} local only, no remote/);
});
test('a failed close check and a log not updated today each give NOT FINISHED, a SAFE verdict and a non-zero exit', t => {
  const f = setup(t, {overlay: 'close: step-a\n'});
  f.saveInput({...f.defaults, closed: {'step-a': 'failed'}});
  const close = f.run();
  assert.equal(close.code, 1);
  assert.match(f.verdict(close.output), SAFE_START);
  assert.equal(f.finished(close.output), 'NOT FINISHED - close FAILED: step-a');
  const g = setup(t);
  put(path.join(g.repo, 'brain/00-system/log.md'), '# Log\n\n## [2001-01-01] old | entry\n'); g.commit();
  const log = g.run();
  assert.equal(log.code, 1);
  assert.match(g.verdict(log.output), SAFE_START);
  assert.equal(g.finished(log.output), 'NOT FINISHED - log not updated today (brain/00-system/log.md)');
});
test('operational failures never excuse a cause: NOT SAFE keeps its causes beside NOT FINISHED', t => {
  const f = setup(t, {remote: false, overlay: 'push: none\n'});
  f.saveInput({...f.defaults, roadmap: undefined});
  const r = f.run();
  assert.equal(r.code, 1);
  assert.match(f.verdict(r.output), /^NOT SAFE TO COMPACT - roadmap: record this run's state in docs\/ROADMAP\.md/);
  assert.match(f.finished(r.output), /^NOT FINISHED - memory committed, NOT pushed/);
  assert.ok(r.output.indexOf('NOT FINISHED') < r.output.indexOf('NOT SAFE TO COMPACT'));
  assert.match(r.output, /re-run: /);
});
test('the report keeps the three last lines whole within 1536 bytes with the longest endings and a long path', t => {
  const f = setup(t, {overlay: 'close: step-a\n', memoryName: 'm'.repeat(120)});
  put(path.join(f.repo, 'brain/00-system/log.md'), '# Log\n\n## [2001-01-01] old | entry\n'); f.commit();
  brokenFile(f);
  const words = 'Kit work is under way with every item running and nothing blocked at all today'.slice(0, 78);
  put(f.roadmapFile, read(f.roadmapFile) + `- ${words}\n`); f.commit();
  f.saveInput({...f.defaults, closed: {'step-a': 'failed'}, lessons: `later (${LATER})`, roadmap: `nothing new (${words})`});
  const r = f.run();
  assert.equal(r.code, 1);
  // The report is everything before the recovery text that follows it.
  const report = r.output.split(/\n(?:uncommitted|finish|then|full output):/)[0];
  assert.ok(Buffer.byteLength(report) <= 1536 + 64, String(Buffer.byteLength(report)));
  const parts = report.trimEnd().split('\n\n'), at = parts.findIndex(part => part.startsWith('NOT FINISHED'));
  assert.ok(at > 0 && parts.length >= at + 3, report);
  const [notFinished, verdict, next] = parts.slice(at, at + 3);
  assert.match(notFinished, /^NOT FINISHED - memory NOT committed \(.*\): an overwrite by another session could not be undone; close FAILED: step-a; log not updated today \(brain\/00-system\/log\.md\)$/);
  assert.match(verdict, /^SAFE TO COMPACT - memory saved; lesson saved as a draft \(lesson-001-[a-z-]+\.md\); roadmap already holds it \("[^"]{70,80}"\); draft lessons to finish: 1$/);
  assert.match(next, /^Next: finish the items above \(to run: the finish line below\); do not run \/handover again for them$/);
});

// Proof, not a cause: the cases where the state block or a lesson file is not this run's, and the verdict is still SAFE.
test('session mode, another session holds current-state.md: only this run\'s note is the proof, and the pending notice stands', t => {
  const f = setup(t, {session: true});
  claimFiles({memoryDir: f.memoryDir, repo: f.other(), files: ['current-state.md']});
  const before = read(path.join(f.memoryDir, 'current-state.md')), r = f.run();
  assert.equal(r.code, 0, r.output);
  assert.match(f.verdict(r.output), SAFE_START);
  assert.match(r.output, /current-state\.md is pending in .* \(other\); your note is handovers\//);
  assert.equal(read(path.join(f.memoryDir, 'current-state.md')), before);
});
test('a block with a later stamp from another session, whose note is on disk, is not a cause: both notes are kept', t => {
  const f = setup(t), later = new Date(f.now.getTime() + 3600000);
  const r = f.run({}, {beforeVerify(ctx) {
    const note = `---\ntime: ${localTime(later)}\nbranch: "other"\nsha: abcdefa\nmode: full\n---\n**Open question:** none\n**State:** another session saved after this one\n**Waits on the user:** none\n**Next action:** 1. carry on\n**Lessons:** ${NONE}\n`;
    put(path.join(ctx.memoryDir, 'handovers', `000002-${f.date}-${localTime(later).slice(11, 16).replace(':', '')}.md`), note);
    put(ctx.currentFile, mergeCurrent(read(ctx.currentFile), currentFromNote(note)));
  }});
  assert.equal(r.code, 0, r.output);
  assert.match(f.verdict(r.output), SAFE_START);
  assert.equal(listNotes(f.memoryDir, {max: 5, sinceHours: 100}).length, 2);
});
// A draft that is reused is not claimed again by the lesson tool, so the session save lists it itself: an existing draft that no
// session claimed and nothing committed still goes into the save's own commit.
test('a reused draft, uncommitted and claimed by no session, is in the session save\'s commit', t => {
  const f = setup(t, {session: true});
  const plan = composeDraft({memoryDir: f.memoryDir, text: LATER, today: f.date, config: f.config});
  put(path.join(f.memoryDir, plan.file), plan.text);
  f.saveInput({...f.defaults, lessons: `later (${LATER})`});
  const r = f.run();
  assert.equal(r.code, 0, r.output);
  assert.match(f.verdict(r.output), new RegExp(`lesson saved as a draft \\(${plan.file.replace('.', '\\.')}\\)`));
  assert.deepEqual(f.lessons(), [plan.file], 'the existing draft was reused, not written again');
  assert.match(f.git(f.holder, 'show', '--name-only', '--format=', 'HEAD'), new RegExp(`^${plan.file.replace('.', '\\.')}$`, 'm'));
});
// A checkpoint that commits past a gate FAIL, or commits the note and not the draft, is reached by injecting the checkpoint.
test('a gate FAIL that stands after the commit is NOT FINISHED with its words, the verdict unchanged', t => {
  const f = setup(t, {remote: false}); brokenFile(f);
  const r = f.run({}, {checkpoint({report}) {
    report('gate', 'ran');
    f.git(f.holder, 'add', '-A'); f.git(f.holder, 'commit', '-q', '-m', 'commit past the gate');
    return {status: 0, sha: f.git(f.holder, 'rev-parse', 'HEAD').trim(), exceptions: []};
  }});
  assert.equal(r.code, 1, r.output);
  assert.match(f.verdict(r.output), SAFE_START);
  assert.match(f.finished(r.output), /^NOT FINISHED - gate FAIL \(.*topic-broken/);
  assert.doesNotMatch(f.finished(r.output), /NOT committed|NOT pushed/);
});
test('a draft that is not in the commit is NOT FINISHED with its name, though the note is', t => {
  const f = setup(t, {remote: false});
  f.saveInput({...f.defaults, lessons: `later (${LATER})`});
  const r = f.run({}, {checkpoint() {
    const note = fs.readdirSync(path.join(f.memoryDir, 'handovers'))[0];
    f.git(f.holder, 'add', '--', 'handovers/' + note); f.git(f.holder, 'commit', '-q', '-m', 'the note only');
    return {status: 0, sha: f.git(f.holder, 'rev-parse', 'HEAD').trim(), exceptions: []};
  }});
  assert.equal(r.code, 1, r.output);
  assert.match(f.verdict(r.output), /lesson saved as a draft/);
  assert.match(f.finished(r.output), /^NOT FINISHED - memory NOT committed \(lesson missing in HEAD: lesson-001-the-gate-stayed-green[^)]*\)/);
});
test('a block with a later stamp whose note is not on disk is a cause', t => {
  const f = setup(t), later = new Date(f.now.getTime() + 3600000);
  const r = f.run({}, {beforeVerify(ctx) {
    const note = `---\ntime: ${localTime(later)}\nbranch: "other"\nsha: abcdefa\nmode: full\n---\n**Open question:** none\n**State:** another session saved after this one\n**Waits on the user:** none\n**Next action:** 1. carry on\n**Lessons:** ${NONE}\n`;
    put(ctx.currentFile, mergeCurrent(read(ctx.currentFile), currentFromNote(note)));
  }});
  assert.equal(r.code, 1, r.output);
  assert.equal(f.verdict(r.output), "NOT SAFE TO COMPACT - memory not saved: current-state.md does not hold this run's state");
});
test('a block that is neither this run\'s nor a later save with its note on disk is a cause', t => {
  const f = setup(t);
  const r = f.run({}, {beforeVerify(ctx) { put(ctx.currentFile, 'hand-edited unrelated state\n'); }});
  assert.equal(r.code, 1);
  assert.equal(f.verdict(r.output), "NOT SAFE TO COMPACT - memory not saved: current-state.md does not hold this run's state");
});
test('the note changed after it was written is a cause naming the note', t => {
  const f = setup(t);
  const r = f.run({}, {beforeVerify(ctx) { put(ctx.noteFile, read(ctx.noteFile).replace('Ready to continue', 'Tampered state')); }});
  assert.equal(r.code, 1);
  assert.match(f.verdict(r.output), /^NOT SAFE TO COMPACT - memory not saved: note handovers\/000001-.*\.md is not on disk as written/);
});
test('a replaced older note that this run\'s own checkpoint moved to its month archive is proved there, byte for byte', t => {
  const f = setup(t), config = JSON.parse(read(path.join(f.repo, 'scripts/memory/memory.config.json')));
  config.caps.handovers = {keepNotes: 1};
  put(path.join(f.repo, 'scripts/memory/memory.config.json'), JSON.stringify(config));
  const stopped = f.run({}, {checkpoint() { throw Error('commit stopped'); }});
  assert.equal(stopped.code, 1);
  const newer = `---\ntime: ${localTime(new Date(f.now.getTime() + 60000))}\nbranch: "other"\nsha: abcdefa\nmode: full\n---\n**Open question:** none\n**State:** a newer note of another branch\n**Waits on the user:** none\n**Next action:** 1. carry on\n**Lessons:** ${NONE}\n`;
  put(path.join(f.memoryDir, 'handovers', `000002-${f.date}-2359.md`), newer);
  f.git(f.memoryDir, 'add', 'handovers/000002-' + f.date + '-2359.md'); f.git(f.memoryDir, '-c', 'user.name=x', '-c', 'user.email=x@example.invalid', 'commit', '-m', 'newer note');
  const archive = path.join(f.memoryDir, 'handovers', `archive-${f.date.slice(0, 7)}.md`);
  const r = f.run({replace: '000001', over: stopped.token});
  // The verdict is SAFE: the note is in the archive, byte for byte. (The unchanged commit check looks for the loose note in the saved commit.)
  assert.match(f.verdict(r.output), SAFE_START, r.output);
  assert.equal(fs.existsSync(r.noteFile), false, 'the loose note was archived');
  assert.ok(read(archive).includes(`## ${path.basename(r.noteFile)}\n${r.note}\n\n`));
  // One byte of that archive entry changed after the checkpoint: the note is no longer on disk as written.
  const g = setup(t);
  const gconfig = JSON.parse(read(path.join(g.repo, 'scripts/memory/memory.config.json'))); gconfig.caps.handovers = {keepNotes: 1};
  put(path.join(g.repo, 'scripts/memory/memory.config.json'), JSON.stringify(gconfig));
  const first = g.run({}, {checkpoint() { throw Error('commit stopped'); }});
  put(path.join(g.memoryDir, 'handovers', `000002-${g.date}-2359.md`), newer);
  g.git(g.memoryDir, 'add', 'handovers/000002-' + g.date + '-2359.md'); g.git(g.memoryDir, '-c', 'user.name=x', '-c', 'user.email=x@example.invalid', 'commit', '-m', 'newer note');
  const gone = g.run({replace: '000001', over: first.token}, {beforeVerify() { const file = path.join(g.memoryDir, 'handovers', `archive-${g.date.slice(0, 7)}.md`); put(file, read(file).replace('Ready to continue', 'Ready to Continue')); }});
  assert.equal(gone.code, 1, gone.output);
  assert.match(g.verdict(gone.output), /^NOT SAFE TO COMPACT - memory not saved: note handovers\/000001-.*\.md is not on disk as written/);
});
test('session mode: an unfilled lesson claimed by another live session is left out of the rule, and an unclaimed one is a cause', t => {
  const f = setup(t, {session: true}), body = name => `---\nname: ${name}\ndescription: "An unfilled lesson kept by a session."\nmetadata:\n  type: feedback\n  kind: practice\n  lesson: "009"\n  date: 2026-11-17\n  route: ["craft-sessions"]\n---\n\n**#009. Unfilled.**\n\n**Why:**\n\n**How to apply:**\n`;
  const file = put(path.join(f.memoryDir, 'lesson-009-unfilled-elsewhere.md'), body('lesson-009-unfilled-elsewhere'));
  claimFiles({memoryDir: f.memoryDir, repo: f.other(), files: ['lesson-009-unfilled-elsewhere.md']});
  const claimed = f.run();
  assert.equal(claimed.code, 0, claimed.output);
  assert.match(f.verdict(claimed.output), SAFE_START);
  const g = setup(t, {session: true});
  put(path.join(g.memoryDir, 'lesson-008-unfilled-unclaimed.md'), body('lesson-008-unfilled-unclaimed').replace('009', '008'));
  const open = g.run();
  assert.equal(open.code, 1);
  assert.match(g.verdict(open.output), /learning: lesson-008-unfilled-unclaimed\.md is not a finished lesson or a draft with its text/);
  assert.ok(fs.existsSync(file));
});
test('a draft saved in session mode is in the save\'s own commit', t => {
  const f = setup(t, {session: true});
  f.saveInput({...f.defaults, lessons: `later (${LATER})`});
  const r = f.run();
  assert.equal(r.code, 0, r.output);
  assert.match(f.verdict(r.output), /lesson saved as a draft \(lesson-001-/);
  assert.match(f.git(f.holder, 'show', '--name-only', '--format=', 'HEAD'), /^lesson-001-the-gate-stayed-green-after-a-rotation-moved\.md$/m);
});

for (const [label, inRepo] of modes) {
  test(`a stop after the state block, with all three holding, is SAFE with NOT FINISHED and the checkpoint command, memory ${label} the project`, t => {
    const f = setup(t, {inRepo});
    const r = f.run({}, {afterCurrent() { throw Error('stopped after the state block'); }});
    assert.equal(r.code, 1, r.output);
    assert.match(f.verdict(r.output), SAFE_START);
    assert.match(f.finished(r.output), new RegExp(`^NOT FINISHED - memory NOT committed \\(the run stopped before the checkpoint: stopped after the state block\\): ${RISK_NOT_COMMITTED}$`));
    assert.match(r.output, /\n\nNext: finish the items above \(to run: the finish line below\); do not run \/handover again for them\n/);
    assert.doesNotMatch(r.output, /re-run:/);
    assert.equal(read(r.noteFile), r.note, 'the note is on disk');
    // Run as printed, the commands commit the note and the state block and push them, whether the project holds the memory or not.
    runPrinted(f, r.output);
    assertCommittedAndPushed(f, r.noteFile);
    assert.equal(f.git(f.holder, 'show', 'HEAD:' + path.relative(f.holder, f.memoryDir + '/current-state.md').replaceAll('\\', '/')), read(path.join(f.memoryDir, 'current-state.md')).trim());
  });
  test(`a long reason keeps its risk words whole, memory ${label} the project`, t => {
    // The longest reason (180 characters) plus the risk words is more than the 240 characters an item had before.
    const f = setup(t, {inRepo}), name = 'topic-' + 'b'.repeat(150);
    put(path.join(f.memoryDir, name + '.md'), `---\nname: ${name}\n`);
    if (inRepo) { f.commit(); f.git(f.repo, 'push'); }
    const r = f.run();
    assert.equal(r.code, 1, r.output);
    const line = f.finished(r.output);
    assert.ok(line.includes(name), 'the reason is kept to 180 characters');
    assert.ok(line.endsWith(`): ${RISK_NOT_COMMITTED}`), line);
    assert.ok(line.length > 'NOT FINISHED - '.length + 240, 'longer than the old item cap');
  });
  test(`a stop after the note that names a cause still reports the uncommitted save, and keeps the re-run line, memory ${label} the project`, t => {
    const f = setup(t, {inRepo});
    const r = f.run({}, {afterNote() { throw Error('stopped after the note'); }});
    assert.equal(r.code, 1, r.output);
    assert.match(f.verdict(r.output), /^NOT SAFE TO COMPACT - memory not saved: current-state\.md does not hold this run's state$/);
    assert.match(f.finished(r.output), new RegExp(`^NOT FINISHED - memory NOT committed \\(the run stopped before the checkpoint: stopped after the note\\): ${RISK_NOT_COMMITTED}$`));
    assert.match(r.output, /Next: fix the cause named in the verdict, then run the re-run line below/);
    assert.match(r.output, /re-run: /);
  });
}
test('a run that stopped before it wrote anything reports no uncommitted memory', t => {
  const f = setup(t, {full: true});
  const r = f.run({lessons: f.batch()}, {batchLessons() { throw Error('batch refused in the test'); }});
  assert.equal(r.code, 1, r.output);
  assert.match(f.verdict(r.output), /^NOT SAFE TO COMPACT - /);
  assert.equal(f.finished(r.output), '');
  assert.deepEqual(f.lessons(), []);
});

// The commit commands are built from the run: a session save lists the files itself, and a reused draft that no session claimed needs it.
test('a reused draft no session claimed, with the checkpoint stopped: the printed session command lists it, and run as printed it commits and pushes', t => {
  const f = setup(t, {session: true});
  const plan = composeDraft({memoryDir: f.memoryDir, text: LATER, today: f.date, config: f.config});
  put(path.join(f.memoryDir, plan.file), plan.text);
  f.saveInput({...f.defaults, lessons: `later (${LATER})`});
  const r = f.run({}, {checkpoint() { throw Error('commit stopped'); }});
  assert.equal(r.code, 1, r.output);
  assert.match(f.finished(r.output), /^NOT FINISHED - memory NOT committed \(commit stopped\)/);
  assert.match(r.output, new RegExp(`^uncommitted: .*\`${plan.file.replace('.', '\\.')}\``, 'm'));
  const [command] = printedCommands(r.output);
  assert.ok(command.includes(' --session --files ') && command.includes(`'${plan.file}'`), command);
  runPrinted(f, r.output);
  assertCommittedAndPushed(f, path.join(f.memoryDir, plan.file));
  assertCommittedAndPushed(f, r.noteFile);
});
// What is left uncommitted is read from the memory repository. A batch that stopped part way names no lesson, yet the lesson files it left
// are this save's remainder, except one another session claimed.
test('a batch that stopped part way: the lesson files it left are listed from the disk; one another session claimed, or one already there, is not', t => {
  const f = setup(t, {session: true}), batch = f.batch();
  put(path.join(f.memoryDir, 'lesson-001-already-there.md'), 'half');
  const partial = () => {
    put(path.join(f.memoryDir, 'lesson-002-claimed-elsewhere.md'), 'half');
    put(path.join(f.memoryDir, 'lesson-003-left-behind.md'), 'half');
    claimFiles({memoryDir: f.memoryDir, repo: f.other(), files: ['lesson-002-claimed-elsewhere.md']});
    throw Error('batch stopped half way');
  };
  const r = f.run({lessons: batch}, {batchLessons: partial});
  assert.equal(r.code, 1, r.output);
  assert.match(f.finished(r.output), /^NOT FINISHED - memory NOT committed \(the run stopped before the checkpoint: batch stopped half way\)/);
  assert.match(r.output, /^uncommitted: `lesson-003-left-behind\.md`$/m);
  // A cause is named, so the re-run line is the way on and no finish line is printed beside it.
  assert.match(r.output, /re-run: /);
  assert.doesNotMatch(r.output, /^(?:finish|then): /m);
});
// The commands follow the run's publication policy: with no remote, or push: none, the checkpoint is told not to push.
for (const [label, remote, overlay] of [['no remote', false, ''], ['push: none', true, 'push: none\n']]) test(`the printed checkpoint command keeps the run's publication policy, ${label}`, t => {
  const f = setup(t, {remote, overlay}), r = f.run({}, {checkpoint() { throw Error('commit stopped'); }});
  assert.equal(r.code, 1, r.output);
  const [command] = printedCommands(r.output);
  assert.ok(command.endsWith(' --no-push'), command);
  runPrinted(f, r.output);
  f.git(f.holder, 'cat-file', '-e', 'HEAD:' + path.relative(f.holder, r.noteFile).replaceAll('\\', '/'));
});
// With nothing written, a failure in the end phase is the refusal it always was: it is thrown to the caller, which says nothing was written.
test('a failure in the end phase with nothing written is not turned into a report about a save', t => {
  const f = setup(t);
  assert.throws(() => f.run({}, {beforeLock(ctx) { ctx.data = null; throw Error('stopped before the lock'); }}), /Cannot read properties of null/);
  assert.deepEqual(f.notes(), []);
});
// The brain log is not one of the three conditions: a log that cannot be read at the end is an operational item, with the verdict intact.
test('a brain log that cannot be read at the end is NOT FINISHED and never a refusal: the three conditions are still proved', t => {
  const f = setup(t), log = path.join(f.repo, 'brain/00-system/log.md');
  put(log, `# Log\n\n## [${f.date}] today | entry\n`); f.commit();
  const r = f.run({}, {beforeVerify() { fs.rmSync(log); fs.mkdirSync(log); }});
  assert.equal(r.code, 1, r.output);
  assert.doesNotMatch(r.output, /SAVE REFUSED|Nothing was written/);
  assert.match(f.verdict(r.output), SAFE_START);
  assert.match(f.finished(r.output), /^NOT FINISHED - the brain log could not be read \(/);
  assert.match(r.output, /checks: roadmap current, log NOT read/);
  assert.equal(read(r.noteFile), r.note, 'the note is on disk');
});
// A failure nothing above foresaw, once anything is written, says what it could not do: the proof did not run, so the verdict is not safe.
test('a failure nobody foresaw in the end phase, after the note is saved, is NOT FINISHED beside a not-safe verdict, never a refusal', t => {
  const f = setup(t);
  const r = f.run({}, {afterCurrent(ctx) { ctx.data = null; }});
  assert.equal(r.code, 1, r.output);
  assert.doesNotMatch(r.output, /SAVE REFUSED|Nothing was written/);
  assert.match(r.output, /^NOT FINISHED - the final report could not be built \(/m);
  assert.match(f.verdict(r.output), /^NOT SAFE TO COMPACT - the three conditions could not be proved \(/);
  assert.equal(read(r.noteFile), r.note, 'the note is on disk');
});

// The log of a failed or unfinished save is a convenience: when it cannot be written (a full disk) after the note is saved, the
// verdict, the operational lines and the recovery guidance are still printed, and nothing says that nothing was written.
test('a diagnostic log that cannot be written changes nothing the operator is told except the log line', t => {
  const real = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (name, ...rest) => {
    if (/handover-[0-9a-f-]{36}\.log$/.test(String(name))) throw Object.assign(new Error('ENOSPC: no space left on device, write'), {code: 'ENOSPC'});
    return real(name, ...rest);
  });
  const f = setup(t);
  const stopped = f.run({}, {checkpoint() { throw Error('commit stopped'); }});
  assert.equal(stopped.code, 1, stopped.output);
  assert.doesNotMatch(stopped.output, /SAVE REFUSED|Nothing was written/);
  assert.match(f.verdict(stopped.output), SAFE_START);
  assert.match(f.finished(stopped.output), /^NOT FINISHED - memory NOT committed \(commit stopped.*; the diagnostic log could not be written \(ENOSPC/);
  assert.match(stopped.output, /full output: not saved \(ENOSPC: no space left on device/);
  assert.equal(read(stopped.noteFile), stopped.note, 'the note is on disk');
  // With a cause the re-run line is still printed.
  const g = setup(t);
  g.saveInput({...g.defaults, roadmap: 'updated (A line that no roadmap holds at all, so this save is not safe.)'});
  const caused = g.run({}, {checkpoint() { throw Error('commit stopped'); }});
  assert.equal(caused.code, 1, caused.output);
  assert.doesNotMatch(caused.output, /SAVE REFUSED|Nothing was written/);
  assert.match(g.verdict(caused.output), /^NOT SAFE TO COMPACT - roadmap: /);
  assert.match(caused.output, /full output: not saved \(ENOSPC/);
  assert.match(caused.output, /re-run: /);
});

// A status that cannot be read is an operational item on every path, not only on the path with nothing else wrong.
const failingStatus = (t, {from = 2, what = '--porcelain=v1', also = '', code = 'ENOBUFS', text = 'ENOBUFS'} = {}) => {
  const original = childProcess.execFileSync;
  let calls = 0;
  t.mock.method(childProcess, 'execFileSync', (cmd, args, options) => {
    if (cmd === 'git' && args.includes(what) && (!also || args.includes(also)) && ++calls >= from) throw Object.assign(Error(text), {code});
    return original(cmd, args, options);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
};
test('a status overflow beside a missing roadmap quote: NOT SAFE with its cause and re-run line, and NOT FINISHED names the status', t => {
  const f = setup(t);
  f.saveInput({...f.defaults, roadmap: 'updated (A line that no roadmap holds at all, so this save is not safe.)'});
  failingStatus(t);
  const r = f.run();
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /^NOT FINISHED - the report could not read the project status \(git status output exceeds 16 MiB/m);
  assert.match(r.output, /^NOT SAFE TO COMPACT - roadmap: /m);
  assert.match(r.output, /re-run: /);
  assert.doesNotMatch(r.output, /SAVE REFUSED|Nothing was written/);
});
test('a status overflow beside an uncommitted save: both are on the NOT FINISHED line', t => {
  const f = setup(t);
  failingStatus(t);
  const r = f.run({}, {checkpoint() { throw Error('commit stopped'); }});
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /^NOT FINISHED - memory NOT committed \(commit stopped\): .*; the report could not read the project status \(/m);
  assert.match(r.output, /^SAFE TO COMPACT - /m);
});
// What this save left uncommitted is read from the memory repository; when that cannot be read the run's own record stands in and the
// failed read is reported too.
test('a memory status that cannot be read at the end is its own NOT FINISHED item and the run\'s own record stands in for it', t => {
  const f = setup(t);
  failingStatus(t, {from: 1, what: '--porcelain', also: '-z', code: 'EIO', text: 'status unreadable'});
  const r = f.run({}, {checkpoint() { throw Error('commit stopped'); }});
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /^NOT FINISHED - memory NOT committed \(commit stopped\): [^;]*; the memory status could not be read \(status unreadable\); what is uncommitted is not known/m);
  assert.doesNotMatch(r.output, /^uncommitted: /m);
  assert.match(r.output, /^SAFE TO COMPACT - /m);
});
