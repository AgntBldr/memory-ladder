// What a run reports it left uncommitted rests on evidence of what it wrote: the content of the lesson files before a batch, and the files
// it set out to write, marked before they are written. A snapshot that could not be taken is reported, and the remainder is then unknown,
// never silently empty; a write that stops part way leaves a file the end phase still finds.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setup, put, read, LATER, printedCommands, runPrinted, assertCommittedAndPushed} from './handover-fixture.mjs';
import {composeDraft} from '../engine/memory-lesson.mjs';

const SECOND_BATCH = '## Another\nkind: practice\nroute: craft-sessions\ndescription: Read every lesson before the batch touches any of them.\n\n**Why:**\nA stopped batch needs a before.\n\n**How to apply:**\nHash the lessons first.\n';
// The snapshot read is the one that goes through lessonHashes: no other read of the file fails.
const failSnapshotRead = (t, name) => {
  const real = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (new Error().stack.includes('lessonHashes') && String(file).endsWith(name)) throw Object.assign(new Error('EIO: i/o error, read'), {code: 'EIO'});
    return real(file, ...rest);
  });
};

test('a lesson snapshot that cannot be read before the batch is NOT FINISHED even when the batch succeeded: exit 1, not a silent 0', t => {
  const f = setup(t);
  assert.equal(f.run({lessons: f.batch()}).code, 0);
  const second = put(path.join(f.root, 'batch2.md'), SECOND_BATCH);
  f.saveInput({...f.defaults, state: 'Second save'});
  failSnapshotRead(t, 'lesson-001-capture-1.md');
  const r = f.run({lessons: second});
  t.mock.restoreAll();
  assert.equal(r.code, 1, r.output);
  assert.match(f.verdict(r.output), /^SAFE TO COMPACT - memory saved; learning added \(1 lessons\)/);
  assert.match(f.finished(r.output), /^NOT FINISHED - the lesson files could not be read before the batch \(EIO: i\/o error, read\)$/);
  assert.doesNotMatch(r.output, /^uncommitted: /m);
});

test('a batch that stopped part way when the snapshot could not be read: the remainder is reported as unknown, never as empty', t => {
  const f = setup(t);
  assert.equal(f.run({lessons: f.batch()}).code, 0);
  const second = put(path.join(f.root, 'batch2.md'), SECOND_BATCH);
  f.saveInput({...f.defaults, state: 'Second save'});
  failSnapshotRead(t, 'lesson-001-capture-1.md');
  const r = f.run({lessons: second}, {batchLessons() { put(path.join(f.memoryDir, 'lesson-002-left-behind.md'), 'half'); throw Error('batch stopped half way'); }});
  t.mock.restoreAll();
  assert.equal(r.code, 1, r.output);
  assert.match(f.finished(r.output), /^NOT FINISHED - the lesson files could not be read before the batch \(EIO: i\/o error, read\); what the batch left uncommitted is not known$/);
  assert.match(r.output, /^uncommitted: unknown \(the lesson files could not be read before the batch\)$/m);
  assert.match(f.verdict(r.output), /^NOT SAFE TO COMPACT - /);
});

// A write that stops part way: the note is marked as attempted before it is written, so the file a prefix left is found at the end.
const partialNote = (t, after = () => {}) => {
  const real = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, data, options) => {
    if (/handovers[\\/]\d{6}-[^\\/]+\.md$/.test(String(file)) && options?.flag === 'wx') {
      real(file, String(data).slice(0, 40), options);
      after();
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), {code: 'ENOSPC'});
    }
    return real(file, data, options);
  });
};
test('a note write that stops after a prefix: the file is listed as uncommitted, a re-run line is printed, and nothing says nothing was written', t => {
  partialNote(t);
  const f = setup(t);
  const r = f.run();
  t.mock.restoreAll();
  assert.equal(r.code, 1, r.output);
  assert.doesNotMatch(r.output, /SAVE REFUSED|Nothing was written/);
  assert.match(f.verdict(r.output), /^NOT SAFE TO COMPACT - memory not saved: the run stopped before the note \(ENOSPC/);
  assert.match(f.finished(r.output), /^NOT FINISHED - memory NOT committed \(the run stopped before the checkpoint: ENOSPC/);
  assert.match(r.output, /^uncommitted: `handovers\/000001-[^`]+\.md`$/m);
  assert.match(r.output, /re-run: /);
  assert.equal(f.notes().length, 1, 'the prefix is on disk');
});
test('a note write that stops after a prefix, then a failure nobody foresaw: not a refusal that says nothing was written', t => {
  let ctx;
  partialNote(t, () => { ctx.data = null; });
  const f = setup(t);
  const r = f.run({}, {beforeLock(c) { ctx = c; }});
  t.mock.restoreAll();
  assert.equal(r.code, 1, r.output);
  assert.doesNotMatch(r.output, /SAVE REFUSED|Nothing was written/);
  assert.match(r.output, /^NOT FINISHED - the final report could not be built \(/m);
  assert.match(f.verdict(r.output), /^NOT SAFE TO COMPACT - the three conditions could not be proved \(/);
});
test('a draft write that stops after a prefix: the draft is attempted before it is written, so it is listed as uncommitted', t => {
  const f = setup(t);
  const plan = composeDraft({memoryDir: f.memoryDir, text: LATER, today: f.date, config: f.config});
  f.saveInput({...f.defaults, lessons: `later (${LATER})`});
  const r = f.run({}, {draftLesson() { put(path.join(f.memoryDir, plan.file), plan.text.slice(0, 30)); throw Error('draft write stopped'); }});
  assert.equal(r.code, 1, r.output);
  assert.doesNotMatch(r.output, /SAVE REFUSED|Nothing was written/);
  assert.match(f.finished(r.output), /^NOT FINISHED - memory NOT committed \(the run stopped before the checkpoint: draft write stopped\)/);
  assert.match(r.output, new RegExp('^uncommitted: `' + plan.file.replace('.', '\\.') + '`$', 'm'));
  assert.match(r.output, /re-run: /);
});
test('a state block write that stops: the file is attempted before it is written, so the end phase inspects it', t => {
  const f = setup(t);
  const real = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to).endsWith('current-state.md')) { fs.copyFileSync(from, to); throw Object.assign(new Error('EIO: i/o error, rename'), {code: 'EIO'}); }
    return real(from, to);
  });
  const r = f.run();
  t.mock.restoreAll();
  assert.equal(r.code, 1, r.output);
  assert.doesNotMatch(r.output, /SAVE REFUSED|Nothing was written/);
  assert.match(f.finished(r.output), /^NOT FINISHED - memory NOT committed /);
  assert.match(r.output, /^uncommitted: .*`current-state\.md`/m);
});
// A session save lists its files itself, and the printed command lists what the run set out to write that the disk shows uncommitted:
// here the state block, which the run never recorded as written.
test('a state block write that stops, in session mode: the printed session command lists the state block too, and run as printed it commits it', t => {
  const f = setup(t, {session: true});
  const real = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to).endsWith('current-state.md')) { fs.copyFileSync(from, to); throw Object.assign(new Error('EIO: i/o error, rename'), {code: 'EIO'}); }
    return real(from, to);
  });
  const r = f.run();
  t.mock.restoreAll();
  assert.equal(r.code, 1, r.output);
  assert.match(f.finished(r.output), /^NOT FINISHED - memory NOT committed /);
  const [command] = printedCommands(r.output);
  assert.ok(command.includes(' --session --files ') && command.includes("'current-state.md'") && /'handovers\/000001-[^']+\.md'/.test(command), command);
  runPrinted(f, r.output);
  assertCommittedAndPushed(f, r.noteFile);
  assert.equal(f.git(f.holder, 'show', 'HEAD:current-state.md'), read(path.join(f.memoryDir, 'current-state.md')).trim());
  assert.equal(f.git(f.holder, 'status', '--porcelain'), '', 'nothing of the save is left uncommitted');
});
