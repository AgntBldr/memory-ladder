// The commands a report prints to finish a save are printed only when each is provably the right one: every path is quoted for sh with
// single quotes, the run's configuration and rotation are the ones the checkpoint is given, and the publication policy is honoured whether
// the save is uncommitted or committed. Otherwise the line says the finish is by hand, and why, and prints no command.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setup, put, read, kitRoot, helper, printedCommands, runPrinted, runInShell, rerunCommand, rerunByHandLine, byHandLine, assertCommittedAndPushed} from './handover-fixture.mjs';
import {shq} from '../engine/handover.mjs';

const stopped = () => { throw Error('commit stopped'); };
// A roadmap quote that no roadmap holds: the save has a cause, so it prints the re-run line.
const UNHELD = {roadmap: 'updated (A line that no roadmap holds at all, so this save is not safe.)'};
const batchStopped = () => { throw Error('batch refused in the test'); };
const bytes = text => Buffer.byteLength(text);

// The skill is where the agent reads what to do with a NOT FINISHED line: the finish lines, or the finish by hand line a report prints
// when no command can be printed safely.
test('the handover skill names the finish by hand line beside the finish lines', () => {
  const skill = read(path.join(kitRoot, 'skills/handover/SKILL.md'));
  assert.match(skill, /^NOT FINISHED = commit, push, close or log undone: with SAFE, run its finish lines or the finish by hand line, not \/handover\./m);
});
test('a path is quoted for sh with single quotes, and a path that cannot be is refused', () => {
  assert.equal(shq('D:\\work\\a b\\memory'), "'D:\\work\\a b\\memory'");
  assert.equal(shq('/tmp/m $HOME `id` "q"'), "'/tmp/m $HOME `id` \"q\"'");
  for (const refused of ["it's", 'a\nb', 'a\rb', 'a\tb', 'a\x00b', 'a\x7fb', 'a\u2028b', 'a\u2029b']) assert.equal(shq(refused), null, JSON.stringify(refused));
});

// A memory folder named m$XYZ x`y` expands, in double quotes, to the folder m x: another repository. Run through sh as printed, the
// command acts on the folder it names and on no other.
const TRICKY = 'm$XYZ x`y`';
// The repository the double-quoted name above would expand to: a folder named m x, with a commit of its own.
const decoyOf = f => {
  const decoy = path.join(f.root, 'm x');
  fs.mkdirSync(decoy); put(path.join(decoy, 'keep.md'), 'a different memory\n');
  f.git(decoy, 'init', '-b', 'main'); f.git(decoy, 'add', '.'); f.git(decoy, 'commit', '-m', 'decoy seed');
  return {decoy, before: f.git(decoy, 'rev-parse', 'HEAD')};
};
const assertUntouched = (f, {decoy, before}) => {
  assert.equal(f.git(decoy, 'rev-parse', 'HEAD'), before, 'the other repository has no new commit');
  assert.equal(f.git(decoy, 'status', '--porcelain'), '', 'the other repository was not touched');
};
test('a memory folder with a space, a $ and backticks: run through sh as printed, the right repository is committed and pushed and no other', t => {
  const f = setup(t, {memoryName: TRICKY}), other = decoyOf(f);
  const r = f.run({}, {checkpoint: stopped});
  assert.equal(r.code, 1, r.output);
  const [command] = printedCommands(r.output);
  assert.ok(command.includes("--memory-dir '") && command.includes(TRICKY), command);
  runPrinted(f, r.output);
  assertCommittedAndPushed(f, r.noteFile);
  assertUntouched(f, other);
});
test('a committed save that is not pushed, in a memory folder with a space, a $ and backticks: the printed push, run through sh, pushes that repository and no other', t => {
  const f = setup(t, {memoryName: TRICKY}), other = decoyOf(f), remote = f.git(f.holder, 'remote', 'get-url', 'origin');
  f.git(f.holder, 'remote', 'set-url', 'origin', 'missing.git');
  const r = f.run();
  assert.equal(r.code, 1, r.output);
  assert.match(f.finished(r.output), /^NOT FINISHED - memory committed, NOT pushed/);
  const [command, ...rest] = printedCommands(r.output);
  assert.equal(rest.length, 0, r.output);
  assert.ok(command.startsWith("git -C '") && command.endsWith("' push") && command.includes(TRICKY), command);
  f.git(f.holder, 'remote', 'set-url', 'origin', remote);
  runPrinted(f, r.output);
  assertCommittedAndPushed(f, r.noteFile);
  assertUntouched(f, other);
});

test('a path with a single quote gets no command: the finish is by hand, with the files and the memory folder', t => {
  const f = setup(t, {memoryName: "it's memory"});
  const r = f.run({}, {checkpoint: stopped});
  assert.equal(r.code, 1, r.output);
  assert.deepEqual(printedCommands(r.output), []);
  assert.match(byHandLine(r.output), /^a path holds a quote or a line break, so no command is printed; files: .*handovers\/000001-.*; memory: `.*it's memory`$/);
  assert.match(r.output, /\n\nNext: finish the items above by hand \(the finish by hand line below\); do not run \/handover again for them\n/);
});

test('a committed save whose memory folder has a single quote gets no push command either', t => {
  const f = setup(t, {memoryName: "it's memory"});
  f.git(f.holder, 'remote', 'set-url', 'origin', 'missing.git');
  const r = f.run();
  assert.equal(r.code, 1, r.output);
  assert.match(f.finished(r.output), /^NOT FINISHED - memory committed, NOT pushed/);
  assert.deepEqual(printedCommands(r.output), []);
  assert.match(byHandLine(r.output), /^a path holds a quote or a line break, so no command is printed; /);
});

// The checkpoint the report prints is the one the run used: the project's configuration file and rotation off.
test('a run with rotation off, and the project\'s configuration: the printed checkpoint keeps both, and rotation stays off when it runs', t => {
  const f = setup(t);
  const r = f.run({noRotate: true}, {checkpoint: stopped});
  assert.equal(r.code, 1, r.output);
  const [command] = printedCommands(r.output);
  assert.match(command, / --config '[^']*scripts[\\/]memory[\\/]memory\.config\.json' --no-rotate/);
  const [ran] = runPrinted(f, r.output);
  assert.match(ran.stdout, /rotate-log: skipped \(--no-rotate\)/);
  assertCommittedAndPushed(f, r.noteFile);
  // Without the option the same checkpoint rotates, so the line above is the flag's doing.
  const g = setup(t), s = g.run({}, {checkpoint: stopped});
  assert.doesNotMatch(printedCommands(s.output)[0], /--no-rotate/);
  assert.doesNotMatch(runPrinted(g, s.output)[0].stdout, /skipped \(--no-rotate\)/);
});

// A project whose configuration file names its own log: the checkpoint finds that log only when it is given the same file.
const ownLog = t => {
  const f = setup(t), file = path.join(f.repo, 'scripts/memory/memory.config.json'), config = JSON.parse(read(file));
  config.caps.brainLog.path = 'notes/LOG.md'; config.caps.brainLog.keepEntries = 1;
  put(file, JSON.stringify(config));
  const entry = (date, text) => `## [${date}] ${text}\n\nentry\n\n`;
  put(path.join(f.repo, 'notes/LOG.md'), '# Log\n\n' + entry('2026-01-05', 'oldest') + entry('2026-02-01', 'older') + entry(f.date, 'today'));
  f.commit();
  return f;
};
test('a project with its own log path: the printed checkpoint is given its configuration file, and run as printed it rotates that log', t => {
  const f = ownLog(t), r = f.run({}, {checkpoint: stopped});
  assert.equal(r.code, 1, r.output);
  assert.match(printedCommands(r.output)[0], / --config '[^']*memory\.config\.json'$/);
  const [ran] = runPrinted(f, r.output);
  assert.match(ran.stdout, /rotate-log: 2 moved/);
  assert.ok(fs.existsSync(path.join(f.repo, 'notes/log-2026-01.md')) && fs.existsSync(path.join(f.repo, 'notes/log-2026-02.md')), 'the project\'s own log was rotated');
  assertCommittedAndPushed(f, r.noteFile);
});
test('a project with its own log path and rotation off: the printed checkpoint keeps both, and run as printed it leaves that log alone', t => {
  const f = ownLog(t), log = path.join(f.repo, 'notes/LOG.md'), before = read(log);
  const r = f.run({noRotate: true}, {checkpoint: stopped});
  assert.equal(r.code, 1, r.output);
  assert.match(printedCommands(r.output)[0], / --config '[^']*memory\.config\.json' --no-rotate$/);
  const [ran] = runPrinted(f, r.output);
  assert.match(ran.stdout, /rotate-log: skipped \(--no-rotate\)/);
  assert.equal(read(log), before, 'the log is as it was');
  assert.deepEqual(fs.readdirSync(path.join(f.repo, 'notes')), ['LOG.md']);
  assertCommittedAndPushed(f, r.noteFile);
});
test('a roadmap or log path from the project overlay cannot be given to the checkpoint: the finish is by hand and says so', t => {
  const f = setup(t, {overlay: 'roadmap: docs/OTHER.md\nlog: notes/LOG.md, 100 lines\n'});
  put(path.join(f.repo, 'docs/OTHER.md'), read(f.roadmapFile)); f.commit();
  const r = f.run({}, {checkpoint: stopped});
  assert.equal(r.code, 1, r.output);
  assert.deepEqual(printedCommands(r.output), []);
  assert.match(byHandLine(r.output), /^this run used settings a checkpoint command cannot be given \(a roadmap or log path from the project overlay, or a configuration passed in by the caller\); files: `/);
});
test('a configuration passed in by the caller cannot be given to the checkpoint either: the finish is by hand', t => {
  const f = setup(t);
  const r = f.run({config: f.config}, {checkpoint: stopped});
  assert.equal(r.code, 1, r.output);
  assert.deepEqual(printedCommands(r.output), []);
  assert.match(byHandLine(r.output), /^this run used settings a checkpoint command cannot be given \(/);
});

// Publication policy, in both branches: a project that holds its memory commits and pushes it by hand unless the policy lets this tool;
// push: none is never pushed. A policy-blocked finish prints no command.
const commitsEverything = f => ({checkpoint({report}) {
  report('gate', 'ran');
  f.git(f.repo, 'add', '-A'); f.git(f.repo, 'commit', '-q', '-m', 'memory committed by hand');
  return {status: 0, sha: f.git(f.repo, 'rev-parse', 'HEAD')};
}});
for (const [policy, overlay, reason] of [['push: memory', 'push: memory\n', 'your project pushes memory by hand'], ['push: none', 'push: none\n', 'push is off \\(push: none\\), so memory stays on this disk until you push it'], ['another branch', 'branch: develop\n', 'your project pushes memory by hand']]) {
  test(`memory inside the project under ${policy}: an uncommitted save is finished by hand, never by a checkpoint that prints staging advice`, t => {
    const f = setup(t, {inRepo: true, overlay});
    const r = f.run({}, {checkpoint: stopped});
    assert.equal(r.code, 1, r.output);
    assert.match(f.finished(r.output), /^NOT FINISHED - memory NOT committed \(commit stopped\)/);
    assert.deepEqual(printedCommands(r.output), []);
    assert.match(byHandLine(r.output), /^your project commits memory by hand; files: .*(?:handovers\/000001-.*current-state|current-state.*handovers\/000001-)/);
  });
  test(`memory inside the project under ${policy}: a committed save is never pushed by a printed command`, t => {
    const f = setup(t, {inRepo: true, overlay});
    const r = f.run({}, commitsEverything(f));
    assert.equal(r.code, 1, r.output);
    assert.match(f.finished(r.output), /^NOT FINISHED - memory committed, NOT pushed/);
    assert.deepEqual(printedCommands(r.output), []);
    assert.doesNotMatch(r.output, /\bgit -C .* push/);
    assert.match(byHandLine(r.output), new RegExp('^' + reason));
  });
}
test('memory outside the project under push: none: an uncommitted save is committed without a push, a committed one gets no push command', t => {
  const f = setup(t, {overlay: 'push: none\n'});
  const r = f.run({}, {checkpoint: stopped});
  assert.match(printedCommands(r.output)[0], / --no-push$/);
  runPrinted(f, r.output);
  f.git(f.holder, 'cat-file', '-e', 'HEAD:' + path.relative(f.holder, r.noteFile).replaceAll('\\', '/'));
  assert.notEqual(f.git(f.bare, 'rev-parse', 'main'), f.git(f.holder, 'rev-parse', 'HEAD'), 'nothing was pushed');
  const g = setup(t, {overlay: 'push: none\n'}), s = g.run();
  assert.equal(s.code, 1, s.output);
  assert.deepEqual(printedCommands(s.output), []);
  assert.match(byHandLine(s.output), /^push is off \(push: none\)/);
});

// The re-run line, printed when a save has a cause, is a printed command like the finish lines: every path single-quoted for sh, and no
// command at all when a path cannot be quoted that way.
test('the re-run line, with a project, a memory folder, an input file and a batch file named with a space, a $ and backticks: run through sh as printed, it saves the lessons and no other repository is touched', t => {
  const f = setup(t, {memoryName: TRICKY}), other = decoyOf(f);
  // The project is a second checkout of the fixture's repository, in a folder named the same way.
  const repo = path.join(f.root, 'r$XYZ p`z`');
  f.git(f.repo, 'worktree', 'add', '-q', '-b', 'tricky-checkout', repo);
  const input = put(path.join(f.root, 'in$XYZ put`z`.json'), read(f.inputPath)), batch = put(path.join(f.root, 'b$XYZ at`z`.md'), read(f.batch()));
  const r = f.run({repo, input, lessons: batch}, {batchLessons: batchStopped});
  assert.equal(r.code, 1, r.output);
  assert.match(f.verdict(r.output), /^NOT SAFE TO COMPACT - /);
  const command = rerunCommand(r.output);
  assert.ok(command.startsWith("node '") && command.includes("--repo '") && command.includes('r$XYZ p`z`') && command.includes("--memory-dir '") && command.includes(TRICKY) && command.includes("--in '") && command.includes("--lessons '"), command);
  assert.match(r.output, /\n\nNext: fix the cause named in the verdict, then run the re-run line below; if there is none, run \/handover again\.\n/);
  const ran = runInShell(f, command);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /^SAFE TO COMPACT - memory saved; learning added \(1 lessons\)/m);
  assert.equal(f.lessons().length, 1);
  assertUntouched(f, other);
});
for (const [label, make] of [
  ['the memory folder', t => ({f: setup(t, {memoryName: "it's memory"}), run: {}})],
  ['the input file', t => { const f = setup(t); return {f, run: {input: put(path.join(f.root, "in't.json"), read(f.inputPath))}}; }],
  ['the batch file', t => { const f = setup(t); return {f, run: {lessons: put(path.join(f.root, "b'at.md"), read(f.batch()))}, deps: {batchLessons: batchStopped}}; }],
]) test(`a single quote in ${label} gets no re-run command: the line says re-run by hand, with the input file and the memory folder, and the Next line says so`, t => {
  const {f, run, deps} = make(t);
  f.saveInput({...f.defaults, ...UNHELD});
  if (run.input) put(run.input, read(f.inputPath));
  const r = f.run(run, {checkpoint: stopped, ...deps});
  assert.equal(r.code, 1, r.output);
  assert.match(f.verdict(r.output), /^NOT SAFE TO COMPACT - /);
  assert.equal(rerunCommand(r.output), null);
  assert.doesNotMatch(r.output, /^re-run: /m);
  // The line names the input file, the batch file when there is one, and the memory folder.
  const batch = run.lessons ? `; batch: \`${path.resolve(run.lessons)}\`` : '';
  assert.equal(rerunByHandLine(r.output), `a path holds a quote or a line break, so no command is printed; input: \`${path.resolve(run.input ?? f.inputPath)}\`${batch}; memory: \`${f.memoryDir}\``);
  assert.match(r.output, /\n\nNext: fix the cause named in the verdict, then re-run by hand \(the re-run by hand line below\); if there is none, run \/handover again\.\n/);
});
// Lessons that are already written are not part of a re-run (the retry text says so), so the by-hand line does not name their batch.
test('a re-run by hand does not name the batch file once its lessons are written', t => {
  const f = setup(t);
  f.saveInput({...f.defaults, ...UNHELD});
  const input = put(path.join(f.root, "in't.json"), read(f.inputPath));
  const r = f.run({input, lessons: f.batch()}, {checkpoint: stopped});
  assert.equal(r.code, 1, r.output);
  assert.equal(f.lessons().length, 1);
  assert.equal(rerunByHandLine(r.output), `a path holds a quote or a line break, so no command is printed; input: \`${input}\`; memory: \`${f.memoryDir}\``);
});
// A caller that passes its own configuration cannot have it carried by a command: the handover tool a command runs reads its own.
for (const withBatch of [false, true]) test(`a configuration passed in by the caller gives no re-run command: re-run by hand, naming the input file${withBatch ? ', the batch file' : ''} and the memory folder`, t => {
  const f = setup(t);
  f.saveInput({...f.defaults, ...UNHELD});
  const batch = withBatch ? f.batch() : null;
  const r = f.run({config: f.config, ...(batch ? {lessons: batch} : {})}, {checkpoint: stopped, ...(batch ? {batchLessons: batchStopped} : {})});
  assert.equal(r.code, 1, r.output);
  assert.match(f.verdict(r.output), /^NOT SAFE TO COMPACT - /);
  assert.equal(rerunCommand(r.output), null);
  assert.doesNotMatch(r.output, /^re-run: /m);
  assert.equal(rerunByHandLine(r.output), `this run was given its configuration by the caller, which a command cannot be given; input: \`${f.inputPath}\`${batch ? `; batch: \`${batch}\`` : ''}; memory: \`${f.memoryDir}\``);
  assert.match(r.output, /\n\nNext: fix the cause named in the verdict, then re-run by hand \(the re-run by hand line below\); if there is none, run \/handover again\.\n/);
});

// A command longer than 1500 characters could be cut by the output cap, and a cut command is a different command: it is not printed.
// The finish is by hand, with the files, as for a path that cannot be quoted.
test('a session save with many long file names: the finish command is too long to print safely, so no finish line is printed and the finish is by hand, with the files', t => {
  // The files of the save are the note, the state block, the lessons it wrote and the draft; the extra names stand for a session that
  // wrote more of them than a batch can.
  const names = Array.from({length: 30}, (_, i) => `lesson-${900 + i}-${'x'.repeat(60)}.md`);
  const f = setup(t, {session: true});
  const r = f.run({}, {beforeLock(ctx) { ctx.created.push(...names); }, checkpoint: stopped});
  assert.equal(r.code, 1, r.output);
  assert.match(f.finished(r.output), /^NOT FINISHED - memory NOT committed \(commit stopped\)/);
  assert.deepEqual(printedCommands(r.output), []);
  assert.doesNotMatch(r.output, /^(?:finish|then): /m);
  assert.match(byHandLine(r.output), /^the command is too long to print safely; files: .*handovers\/000001-.*; memory: `/);
  assert.match(r.output, /\n\nNext: finish the items above by hand \(the finish by hand line below\); do not run \/handover again for them\n/);
  // A few names still print: the limit is on the length of a command, not on a session.
  const g = setup(t, {session: true}), s = g.run({}, {beforeLock(ctx) { ctx.created.push(...names.slice(0, 2)); }, checkpoint: stopped});
  assert.equal(printedCommands(s.output).length, 1, s.output);
  assert.ok(printedCommands(s.output)[0].length <= 1500);
  assert.equal(byHandLine(s.output), null);
});
test('the limit is exact: a finish command of 1500 characters is printed whole, one of 1501 is not printed', t => {
  const run = extra => { const f = setup(t, {session: true}); return f.run({}, {beforeLock(ctx) { if (extra) ctx.created.push(extra); }, checkpoint: stopped}); };
  const base = printedCommands(run('').output)[0].length;
  // A name adds a space and two quotes to the command.
  const exact = run('n'.repeat(1500 - base - 3)), over = run('n'.repeat(1501 - base - 3));
  assert.equal(printedCommands(exact.output)[0]?.length, 1500, exact.output);
  assert.deepEqual(printedCommands(over.output), []);
  assert.match(byHandLine(over.output), /^the command is too long to print safely; files: /);
});
test('a re-run command that is too long to print safely is not printed: the line says re-run by hand, with the input file and the memory folder', t => {
  const f = setup(t);
  // Each long path is about 800 bytes whatever the length of the fixture's root (a short temporary folder on Linux, a long one on
  // Windows): two of them in one command are over the 1500-byte limit, one alone is under it.
  const deep = (g, name, file) => {
    const parts = [];
    for (let left = 800 - g.root.length - file.length - 1; left > 1; left -= 151) parts.push(name.repeat(Math.min(150, left - 1)));
    return path.join(g.root, ...parts, file);
  };
  const input = put(deep(f, 'i', '_input.json'), read(f.inputPath)), batch = put(deep(f, 'b', '_batch.md'), read(f.batch()));
  const r = f.run({input, lessons: batch}, {batchLessons: batchStopped});
  assert.equal(r.code, 1, r.output);
  assert.match(f.verdict(r.output), /^NOT SAFE TO COMPACT - /);
  assert.equal(rerunCommand(r.output), null);
  assert.doesNotMatch(r.output, /^re-run: /m);
  assert.equal(rerunByHandLine(r.output), `the command is too long to print safely; input: \`${input}\`; batch: \`${batch}\`; memory: \`${f.memoryDir}\``);
  assert.match(r.output, /\n\nNext: fix the cause named in the verdict, then re-run by hand \(the re-run by hand line below\); if there is none, run \/handover again\.\n/);
  // The same save with only the input at the long path (a cause, no batch) prints its command: it is under the limit.
  const g = setup(t);
  g.saveInput({...g.defaults, ...UNHELD});
  const s = g.run({input: put(deep(g, 'i', '_input.json'), read(g.inputPath))});
  assert.equal(s.code, 1, s.output);
  assert.ok(rerunCommand(s.output)?.length > 700 && rerunCommand(s.output).length <= 1500, s.output);
});

// The output cap counts UTF-8 bytes, so the limit does too: a command of CJK characters (three bytes each) can be under 1500 characters
// and far over 1500 bytes.
const CJK = '記';
test('a finish command of CJK file names, under 1500 characters and over 1500 bytes, is not printed: the finish is by hand', t => {
  const names = count => Array.from({length: count}, (_, i) => `lesson-${900 + i}-${CJK.repeat(80)}.md`);
  const f = setup(t, {session: true});
  const r = f.run({}, {beforeLock(ctx) { ctx.created.push(...names(5)); }, checkpoint: stopped});
  assert.equal(r.code, 1, r.output);
  assert.deepEqual(printedCommands(r.output), []);
  assert.match(byHandLine(r.output), /^the command is too long to print safely; files: /);
  // Three such names print: that command is under the limit in bytes too, and holds the CJK text.
  const g = setup(t, {session: true}), s = g.run({}, {beforeLock(ctx) { ctx.created.push(...names(3)); }, checkpoint: stopped});
  const [command] = printedCommands(s.output);
  assert.ok(command.includes(CJK) && bytes(command) <= 1500 && command.length < bytes(command), s.output);
});
test('a re-run command of CJK paths, under 1500 characters and over 1500 bytes, is not printed: re-run by hand', t => {
  const f = setup(t);
  const deep = (g, file) => path.join(g.root, ...Array(3).fill(CJK.repeat(80)), file);
  const input = put(deep(f, '入力.json'), read(f.inputPath)), batch = put(deep(f, '一括.md'), read(f.batch()));
  const r = f.run({input, lessons: batch}, {batchLessons: batchStopped});
  assert.equal(r.code, 1, r.output);
  assert.equal(rerunCommand(r.output), null);
  assert.match(rerunByHandLine(r.output), /^the command is too long to print safely; input: /);
  // The command a character count would have printed: under 1500 characters.
  const asPrinted = ['node', shq(helper), 'run', '--repo', shq(f.repo), '--memory-dir', shq(f.memoryDir), '--in', shq(input), '--over', 'x'.repeat(12), '--lessons', shq(batch)].join(' ');
  assert.ok(asPrinted.length < 1500 && bytes(asPrinted) > 1500, `${asPrinted.length} characters, ${bytes(asPrinted)} bytes`);
});
test('the re-run limit is exact: a re-run command of 1500 bytes is printed whole, one of 1501 bytes is not printed', t => {
  // The repository path is the one thing that varies: a name of k more characters makes the command k bytes longer.
  const run = k => {
    const f = setup(t);
    f.saveInput({...f.defaults, ...UNHELD});
    return f.run({}, {beforeLock(ctx) { ctx.repo += 'x'.repeat(k); }, checkpoint: stopped});
  };
  const base = bytes(rerunCommand(run(0).output));
  const exact = run(1500 - base), over = run(1501 - base);
  assert.equal(bytes(rerunCommand(exact.output) ?? ''), 1500, exact.output);
  assert.equal(rerunCommand(over.output), null);
  assert.match(rerunByHandLine(over.output), /^the command is too long to print safely; input: /);
});
// The steps of a finish plan count together: a checkpoint command and the push that follows it, each under the limit, are not printed
// when both come to more.
test('a finish plan of two commands, each under 1500 bytes and together over, is not printed', t => {
  const f = setup(t, {inRepo: true, session: true});
  const probe = f.run({}, {checkpoint: stopped});
  const [first, second] = printedCommands(probe.output);
  assert.ok(first && second, probe.output);
  // Names for the first command, enough to bring it within half the push command's length of the limit: each command is then under
  // 1500 bytes and the two together are over, whatever the length of the fixture's paths (the push is short on Linux).
  const g = setup(t, {inRepo: true, session: true});
  const name = 'n'.repeat(1500 - Math.floor(bytes(second) / 2) - bytes(first) - 3);
  const r = g.run({}, {beforeLock(ctx) { ctx.created.push(name); }, checkpoint: stopped});
  assert.deepEqual(printedCommands(r.output), []);
  assert.match(byHandLine(r.output), /^the command is too long to print safely; files: /);
});
// A printed command is checked in the capped output: when the cap would cut one that is under the limit, the report is built again with
// the by-hand line. The cap is made smaller by the test (dependencies.outputMax) so that a command a little under the limit is cut.
test('a finish command that the output cap would cut is not printed: the report is built again with the by-hand line', t => {
  const probe = setup(t, {session: true}).run({}, {checkpoint: stopped}), base = bytes(printedCommands(probe.output)[0]);
  const long = 'n'.repeat(1300 - base - 3); // one more name of that length brings the command to 1300 bytes
  const make = max => { const f = setup(t, {session: true}); return f.run({}, {beforeLock(ctx) { ctx.created.push(long); }, checkpoint: stopped, ...(max ? {outputMax: max} : {})}); };
  const whole = make(0), cap = bytes(whole.output) - 400;
  assert.equal(bytes(printedCommands(whole.output)[0]), 1300, whole.output);
  const r = make(cap);
  assert.deepEqual(printedCommands(r.output), [], r.output);
  assert.doesNotMatch(r.output, /^(?:finish|then): /m);
  assert.match(byHandLine(r.output), /^the command is too long to print safely; files: .*handovers\/000001-/);
  assert.ok(bytes(r.output) <= cap && !/\[cut; full output:/.test(r.output), `${bytes(r.output)} of ${cap}`);
  assert.match(r.output, /\n\nNext: finish the items above by hand \(the finish by hand line below\); do not run \/handover again for them\n/);
});
test('a re-run command that the output cap would cut is not printed: the report is built again with the by-hand line', t => {
  const run = (k, max) => {
    const f = setup(t);
    f.saveInput({...f.defaults, ...UNHELD});
    return f.run({}, {beforeLock(ctx) { ctx.repo += 'x'.repeat(k); }, checkpoint: stopped, ...(max ? {outputMax: max} : {})});
  };
  const k = 1300 - bytes(rerunCommand(run(0).output));
  const whole = run(k), cap = bytes(whole.output) - 20;
  assert.equal(bytes(rerunCommand(whole.output)), 1300, whole.output);
  const r = run(k, cap);
  assert.equal(rerunCommand(r.output), null, r.output);
  assert.doesNotMatch(r.output, /^re-run: /m);
  assert.match(rerunByHandLine(r.output), /^the command is too long to print safely; input: /);
  assert.ok(bytes(r.output) <= cap && !/\[cut; full output:/.test(r.output), `${bytes(r.output)} of ${cap}`);
  assert.match(r.output, /\n\nNext: fix the cause named in the verdict, then re-run by hand \(the re-run by hand line below\); if there is none, run \/handover again\.\n/);
});
