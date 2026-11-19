import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess, {spawn} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {pathToFileURL} from 'node:url';
import {fixture, put, read, tree, kitRoot, ok} from './helpers.mjs';
import {runHandover, currentFromNote, mergeCurrent} from '../engine/handover.mjs';
import {stateToken, readCurrent, listNotes, parseBlock} from '../engine/session-core.mjs';
import {loadConfig, parseHandover} from '../engine/lib.mjs';
import {checkpoint} from '../engine/memory-checkpoint.mjs';
import {batchLessons} from '../engine/memory-lesson.mjs';
import {runCheck} from '../engine/memory-check.mjs';
import {writeMemoryIndex} from '../engine/memory-index.mjs';

// A quick save given neither lessons nor a roadmap statement is a saved state, not a verdict.
const QUICK_SAVED = 'STATE SAVED (quick) - memory saved; not checked: learning and roadmap. This is not a safe-to-compact verdict: pass both, or run /handover.';
const FULL_SAFE = learning => `SAFE TO COMPACT - memory saved; ${learning}; roadmap already holds it ("Nothing pending.")`;
const NEXT = 'Next: new conversation, then `/new-session`.';
const NEXT_QUICK = 'Next: before compacting, run /handover (full) or pass both lessons and roadmap.';
function stripSpan(text) {
  const match = /^(`+)(.*)\1$/.exec(text.split('\n')[0]);
  assert.ok(match, text);
  return match[2].startsWith(' ') && match[2].endsWith(' ') ? match[2].slice(1, -1) : match[2];
}
const helper = path.join(kitRoot, 'engine/handover.mjs');
const initial = '---\nname: current-state\ndescription: Current work.\nmetadata:\n  type: project\n  state: true\n---\n\n## CURRENT\nold state\n';
const input = {state: 'Ready to continue', question: 'Which next?', next: ['Review results'], waits: 'none', risks: 'none'};
// A full handover states the roadmap line the fixture holds; a quick one is not asked to.
const roadmapStatement = 'nothing new (Nothing pending.)';
// Words that are on no line of the roadmap: a save that gives them has a cause, so a failure that follows prints the re-run line.
const unheld = {roadmap: 'updated (A line that no roadmap holds at all, so this save is not safe.)'};
const none = 'none (no new learning this session)';
function setup(t, {inRepo = false, remote = true, overlay = '', full = false} = {}) {
  const now = new Date(), date = now.toISOString().slice(0, 10);
  const f = fixture(t), repo = f.target, memoryDir = inRepo ? path.join(repo, 'memory') : path.join(f.root, 'memory');
  const prior = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = f.env.GIT_CONFIG_GLOBAL;
  t.after(() => { if (prior === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prior; });
  fs.mkdirSync(memoryDir);
  put(path.join(repo, 'AGENTS.md'), `## Session overlay\nbranch: main\npush: ${inRepo ? 'project' : 'memory'}\n${overlay}`);
  f.git(repo, 'checkout', '-b', 'main');
  const config = loadConfig();
  if (inRepo) config.memory = {inRepoDir: 'memory'};
  put(path.join(repo, 'scripts/memory/memory.config.json'), JSON.stringify(config));
  put(path.join(repo, 'scripts/memory/KIT.json'), JSON.stringify({version: config.engine_version}));
  put(path.join(repo, '.gitignore'), '.memory.lock*\n');
  put(path.join(repo, 'docs/ROADMAP.md'), `# Roadmap\n\n## Open work (as of ${date})\n\nNothing pending.\n`);
  put(path.join(memoryDir, '.gitignore'), '.memory.lock*\n');
  put(path.join(memoryDir, 'MEMORY.md'), '# Memory\n\n## Craft\n- [Sessions](INDEX-craft-sessions.md) OPEN BEFORE testing.\n\n## Active work\n- [Current](current-state.md) OPEN BEFORE resuming.\n');
  put(path.join(memoryDir, 'current-state.md'), initial);
  writeMemoryIndex({memoryDir, config});
  f.git(repo, 'add', '.'); f.git(repo, 'commit', '-m', 'project seed');
  if (!inRepo) { f.git(memoryDir, 'init', '-b', 'main'); f.git(memoryDir, 'add', '.'); f.git(memoryDir, 'commit', '-m', 'memory seed'); }
  const holder = inRepo ? repo : memoryDir;
  let bare;
  if (remote) {
    bare = path.join(f.root, 'backup.git'); f.git(f.root, 'init', '--bare', bare);
    f.git(holder, 'remote', 'add', 'origin', bare); f.git(holder, 'push', '-u', 'origin', 'main');
  }
  const inputPath = put(path.join(f.root, 'input.json'), JSON.stringify({...input, ...(full ? {lessons: none, roadmap: roadmapStatement} : {})}));
  const options = {repo, memoryDir, input: inputPath, quick: !full};
  const run = (opts = {}, deps = {}) => {
    let output = '';
    const result = runHandover({...options, now, ...opts}, {...deps, output: text => { output += text; }});
    return {...result, output};
  };
  const cli = (extra = [], command = 'run') => f.exec(process.execPath, [helper, command, '--repo', repo, '--memory-dir', memoryDir, '--in', inputPath, ...(!full ? ['--quick'] : []), ...extra]);
  const saveInput = data => put(inputPath, JSON.stringify(full && data.roadmap === undefined ? {...data, roadmap: roadmapStatement} : data));
  const commit = (dir = repo) => { f.git(dir, 'add', '.'); f.git(dir, 'commit', '-m', 'fixture change'); };
  const batch = (count = 1) => put(path.join(f.root, 'batch.md'), Array.from({length: count}, (_, i) => `## Capture ${i + 1}\nkind: practice\nroute: craft-sessions\ndescription: Check resulting bytes before declaring completion ${i + 1}.\n\n**Why:**\nPartial writes can lose a session.\n\n**How to apply:**\nVerify the committed bytes and publication.\n`).join('\n'));
  return {...f, date, repo, memoryDir, holder, bare, config, inputPath, options, run, cli, saveInput, commit, batch};
}
const snapshot = f => ({repo: tree(f.repo), memory: tree(f.memoryDir)});
const success = r => { assert.equal(r.code, 0, r.output); assert.match(r.output, /^(?:SAFE TO COMPACT|STATE SAVED)/m); return r; };
const refused = (f, opts, pattern, deps) => {
  const before = snapshot(f), r = f.run(opts, deps);
  assert.equal(r.code, 1, r.output); assert.match(r.output, pattern); assert.doesNotMatch(r.output, /^SAFE TO COMPACT/m);
  assert.deepEqual(snapshot(f), before); return r;
};

const fullRefused = (f, opts, pattern, deps) => {
  const before = fs.readdirSync(f.memoryDir).filter(n => /^lesson-/.test(n));
  const r = refused(f, {quick: false, lessons: f.batch(), ...opts}, pattern, deps);
  assert.deepEqual(fs.readdirSync(f.memoryDir).filter(n => /^lesson-/.test(n)), before);
  return r;
};

test('normalizes no-close prose arrays and next before caps on first run', t => {
  const f = setup(t);
  for (const closed of [undefined, null, '', {}, 'No close steps. '.repeat(20)]) {
    f.saveInput({...input, next: 'Review results', waits: ['one', 'two'], risks: ['none'], constraints: ['keep scope'], closed});
    const r = success(f.run());
    const note = read(r.noteFile);
    assert.match(note, /Waits on the user:\*\* one; two/);
    assert.match(note, /Next action:\*\* 1\. Review results/);
    assert.match(note, /close none/);
  }
  f.saveInput({...input, waits: ['a'.repeat(119), 'b'.repeat(119)]});
  assert.equal(f.run({check: true}).code, 0, 'joined value is exactly 240 B');
  f.saveInput({...input, waits: ['a'.repeat(120), 'b'.repeat(119)]});
  refused(f, {}, /waits exceeds 240 B/);
});
test('close pairs accept each step exactly once and name expected shape on refusals', t => {
  const f = setup(t, {overlay: 'close: lint; review\n'});
  for (const closed of ['lint=ok; review: ok', 'review=ok, lint: ok', {lint: 'ok', review: 'ok'}]) {
    f.saveInput({...input, closed}); success(f.run());
  }
  for (const closed of [undefined, null, '', {}, 'all done', 'lint=ok; lint=ok; review=ok', 'lint=ok', 'lint=ok; review=ok; extra=ok', {lint: 'yes', review: 'ok'}]) {
    f.saveInput({...input, closed});
    refused(f, {}, /closed: \{"lint":"ok","review":"ok"\} for the overlay's close: steps lint; review/);
  }
  f.saveInput({...input, closed: 'lint=ok; review=failed'});
  const failed = f.run(); assert.equal(failed.code, 1); assert.match(failed.output, /close FAILED: review/);
});
test('input refusals explain shape with one-line example', t => {
  const f = setup(t);
  for (const key of ['state', 'question', 'lessons', 'waits', 'risks', 'constraints', 'next', 'closed']) {
    f.saveInput({...input, [key]: 7});
    const r = f.run(); assert.equal(r.code, 1); assert.match(r.output, key === 'closed' ? /closed: omit it \(the overlay has no close: steps\)/ : /e\.g\./);
  }
  put(f.inputPath, '{broken'); assert.match(f.run().output, /JSON object.*e\.g\./);
});
test('missing memory and detached HEAD precede invalid input', t => {
  const f = setup(t); put(f.inputPath, '{broken');
  assert.match(f.run({memoryDir: path.join(f.root, 'absent')}).output, /memory folder missing/);
  f.git(f.repo, 'checkout', '--detach'); assert.match(f.run().output, /detached HEAD/);
});
for (const quick of [false, true]) test('lessons example is usable: quick=' + quick, t => {
  const f = setup(t, {full: !quick});
  f.saveInput({...input, lessons: 7});
  const r = refused(f, {check: true}, /e\.g\. "none \(no new learning this session\)"/);
  f.saveInput({...input, lessons: /e\.g\. "([^"]+)"/.exec(r.output)[1]});
  assert.equal(f.run({check: true}).code, 0);
});

for (const quick of [false, true]) test('converted closed respects its original string bytes: quick=' + quick, t => {
  const f = setup(t, {full: !quick, overlay: 'close: lint\n'}), base = {...input, ...(!quick ? {lessons: none} : {})};
  for (const closed of ['lint:ok' + ' '.repeat(314), 'lint:ok' + ' '.repeat(100000)]) {
    f.saveInput({...base, closed});
    refused(f, {check: true}, /closed exceeds 320 B; closed: \{"lint":"ok"\}/);
  }
});

for (const quick of [false, true]) test('whole-input cap retains converted closed bytes: quick=' + quick, t => {
  const f = setup(t, {full: !quick, overlay: 'close: lint\n'}), base = {...input, ...(!quick ? {lessons: none} : {})};
  const raw = JSON.stringify({...base, closed: 'lint:ok' + ' '.repeat(313)}), cap = quick ? 1184 : 1952;
  put(f.inputPath, raw + ' '.repeat(cap - Buffer.byteLength(raw)));
  assert.equal(f.run({check: true}).code, 0, 'exact whole-input cap');
  put(f.inputPath, raw + ' '.repeat(cap - Buffer.byteLength(raw) + 1));
  refused(f, {check: true}, new RegExp('input exceeds ' + cap + ' B'));
  // A compact string is smaller than its object form; charge the original, not the object.
  const short = JSON.stringify({...base, closed: 'lint:ok'});
  put(f.inputPath, short + ' '.repeat(cap - Buffer.byteLength(short)));
  assert.equal(f.run({check: true}).code, 0, 'compact string at exact whole-input cap');
});

for (const quick of [false, true]) test('dropped closed respects field and whole-input caps: quick=' + quick, t => {
  const f = setup(t, {full: !quick}), base = {...input, ...(!quick ? {lessons: none} : {})};
  for (const closed of ['x'.repeat(321), 'x'.repeat(100000), '\u00e9'.repeat(161)]) {
    f.saveInput({...base, closed});
    refused(f, {check: true}, /closed exceeds 320 B/);
  }
  const raw = JSON.stringify({...base, closed: '\u00e9'.repeat(160)}), cap = quick ? 1184 : 1952;
  put(f.inputPath, raw + ' '.repeat(cap - Buffer.byteLength(raw)));
  assert.equal(f.run({check: true}).code, 0, 'exact whole-input cap');
  put(f.inputPath, raw + ' '.repeat(cap - Buffer.byteLength(raw) + 1));
  refused(f, {check: true}, new RegExp('input exceeds ' + cap + ' B'));
});

for (const key of ['waits', 'risks', 'constraints']) test('arrays contain only strings: ' + key, t => {
  const f = setup(t);
  for (const value of [[1, 2], [['a']], [null], [{a: 1}]]) {
    f.saveInput({...input, [key]: value});
    refused(f, {check: true}, new RegExp(key + ' must be a string'));
  }
});

for (const kind of ['cap', 'label']) test('closed object shape on ' + kind, t => {
  const step = kind === 'cap' ? 'x'.repeat(312) : '**lint**';
  const f = setup(t, {overlay: 'close: ' + step + '\n'});
  f.saveInput({...input, closed: {[step]: 'ok'}});
  const r = refused(f, {check: true}, kind === 'cap' ? /closed exceeds 320 B/ : /closed: control, label or verdict text refused/);
  assert.ok(r.output.includes('closed: ' + JSON.stringify({[step]: 'ok'}) + " for the overlay's close: steps " + step));
});

test('handover rename lists both dirty paths', t => {
  const f = setup(t);
  f.git(f.repo, 'mv', 'docs/ROADMAP.md', 'docs/renamed.md');
  const result = success(f.run());
  assert.match(result.output, /open: 2 uncommitted project files.*`docs\/renamed.md`, `docs\/ROADMAP.md`/);
  assert.match(read(result.noteFile), /uncommitted 2 \(docs\/renamed.md, docs\/ROADMAP.md\)/);
});

test('verdict separates failed close and stale roadmap', t => {
  const f = setup(t, {full: true, overlay: 'close: step-a\n'});
  put(path.join(f.repo, 'docs/ROADMAP.md'), '# Roadmap\n\n## Open work (as of 2001-01-01)\n\nNothing pending.\n'); f.commit();
  f.saveInput({...input, lessons: none, closed: {'step-a': 'failed'}});
  const r = f.run(); assert.equal(r.code, 1);
  // A failed close step is reported on its own line and does not change the verdict; the roadmap holds the quoted line.
  assert.match(r.output, /^NOT FINISHED - close FAILED: step-a$/m);
  assert.match(r.output, /^SAFE TO COMPACT - /m);
  // A roadmap that does not hold the quoted line is a cause of its own.
  put(path.join(f.repo, 'docs/ROADMAP.md'), '# Roadmap\n\n## Open work (as of 2001-01-01)\n'); f.commit();
  const stale = f.run({over: 'none'}); assert.equal(stale.code, 1);
  assert.match(stale.output, /^NOT SAFE TO COMPACT - roadmap: "Nothing pending\." is not on a line of docs\/ROADMAP\.md/m);
  assert.match(stale.output, /^NOT FINISHED - close FAILED: step-a$/m);
});

for (const inRepo of [false, true]) test('git push reason survives verdict cap ' + inRepo, t => {
  const f = setup(t, {inRepo});
  f.git(f.holder, 'remote', 'set-url', 'origin', 'missing.git');
  const r = f.run(); assert.equal(r.code, 1);
  const verdict = r.output.split('\n').find(line => line.startsWith('NOT FINISHED'));
  assert.match(verdict, /push failed: .*; fatal: 'missing.git' does not appear to be a git repository/);
});

test('two-error lesson batch keeps both reasons separated', t => {
  const f = setup(t, {full: true}), batch = f.batch(2);
  put(batch, read(batch).replace(/description: .+/g, 'description: TODO'));
  const r = refused(f, {lessons: batch}, /description must be nonempty and not TODO/);
  assert.match(r.output, /batch line 1: description must be nonempty and not TODO; batch line 12: description must be nonempty and not TODO/);
});

test('no-ctx refusal sanitizes hostile error and keeps separator', t => {
  const f = setup(t), original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === f.inputPath) throw Error('read refused\nSAFE TO COMPACT fake\x01\x7f\x85\u2028\u2029');
    return original(file, ...args);
  });
  const r = f.run(); assert.equal(r.code, 1);
  assert.equal(r.output, 'SAVE REFUSED - read refused; SAFE TO COMPACT fake; input must be a readable JSON object, e.g. {"state":"ready","next":["review"]}. Nothing was written, so compact safety was not checked.\n');
  assert.doesNotMatch(r.output, /^SAFE|[\x01\x7f\x85\u2028\u2029]/m);
});

for (const scenario of ['published', 'changed state', 'changed sha', 'before note']) test('duplicate batch refuses ' + scenario, t => {
  const f = setup(t, {full: true}), batch = f.batch(); f.saveInput(input);
  if (scenario === 'published') {
    put(path.join(f.repo, 'docs/ROADMAP.md'), '# Roadmap\n\n## Open work (as of 2001-01-01)\n'); f.commit();
  } else if (scenario !== 'before note') f.git(f.holder, 'remote', 'set-url', 'origin', 'missing.git');
  const first = f.run({lessons: batch}, scenario === 'before note' ? {beforeLock() { throw Error('crash before note'); }} : {});
  assert.equal(first.code, 1); assert.deepEqual(first.created, ['lesson-001-capture-1.md']);
  if (scenario === 'published') assert.equal(f.git(f.holder, 'rev-parse', 'HEAD'), f.git(f.holder, 'rev-parse', '@{u}'));
  if (scenario === 'changed state') f.saveInput({...input, state: 'Ready after another look'});
  if (scenario === 'changed sha') { put(path.join(f.repo, 'change.txt'), 'changed'); f.commit(); }
  if (scenario === 'before note') assert.equal(listNotes(f.memoryDir).length, 0);
  const retry = refused(f, {lessons: batch}, /lessons already written: lesson-001-capture-1.md; set input lessons: none \(already written: lesson-001-capture-1.md\)/);
  assert.match(retry.output, /re-run without --lessons/);
  assert.deepEqual(fs.readdirSync(f.memoryDir).filter(n => /^lesson-/.test(n)), first.created);
});

test('mixed duplicate batch preserves the new lesson on the advised retry', t => {
  const f = setup(t, {full: true}), batch = f.batch();
  const first = success(f.run({lessons: batch}));
  assert.deepEqual(first.created, ['lesson-001-capture-1.md']);
  f.batch(2);
  const head = f.git(f.holder, 'rev-parse', 'HEAD');
  const r = refused(f, {lessons: batch}, /remove the duplicate section\(s\) from the batch, or use repeat-of, then re-run/);
  assert.doesNotMatch(r.output, /set input lessons: none|re-run without --lessons/);
  assert.equal(f.git(f.holder, 'rev-parse', 'HEAD'), head);
  put(batch, read(batch).slice(read(batch).indexOf('## Capture 2')));
  const retry = success(f.run({lessons: batch}));
  assert.deepEqual(retry.created, ['lesson-002-capture-2.md']);
  assert.deepEqual(fs.readdirSync(f.memoryDir).filter(n => /^lesson-/.test(n)), [...first.created, ...retry.created]);
  assert.match(f.git(f.holder, 'show', 'HEAD:' + retry.created[0]), /completion 2/);
  assert.match(read(listNotes(f.memoryDir)[0].file), /lesson-002-capture-2.md/);
});

for (const changed of ['state', 'sha']) test('retry identity allows different batch after changed ' + changed, t => {
  const f = setup(t, {full: true}), batch = f.batch(); f.saveInput(input);
  f.git(f.holder, 'remote', 'set-url', 'origin', 'missing.git');
  const first = f.run({lessons: batch}); assert.equal(first.code, 1); assert.equal(first.created.length, 1);
  put(batch, read(batch).replace('## Capture 1', '## Different capture'));
  refused(f, {lessons: batch}, /if this is a different batch, change state/);
  if (changed === 'state') f.saveInput({...input, state: 'Different batch ready'});
  else { put(path.join(f.repo, 'change.txt'), 'changed'); f.commit(); }
  f.git(f.holder, 'remote', 'set-url', 'origin', f.bare);
  const r = success(f.run({lessons: batch}));
  assert.deepEqual(r.created, ['lesson-002-different-capture.md']);
});

for (const changed of ['title', 'description']) test('duplicate comparison requires both fields ' + changed, t => {
  const f = setup(t, {full: true}), batch = f.batch(); success(f.run({lessons: batch}));
  put(batch, changed === 'title' ? read(batch).replace('## Capture 1', '## Capture other') : read(batch).replace('completion 1.', 'completion differently.'));
  success(f.run({lessons: batch}));
  assert.equal(fs.readdirSync(f.memoryDir).filter(n => /^lesson-/.test(n)).length, 2);
});

test('oversized input and repeated lesson names get no retry exemption', t => {
  const f = setup(t, {full: true});
  for (const names of [Array(14).fill('MEMORY.md'), ['MEMORY.md'], ['lesson-existing.md', 'lesson-existing.md']]) {
    put(path.join(f.memoryDir, 'lesson-existing.md'), 'exists');
    const raw = JSON.stringify({...input, lessons: 'none (already written: ' + names.join(', ') + ')'});
    put(f.inputPath, raw + ' '.repeat((names.length === 14 ? 2136 : 1953) - Buffer.byteLength(raw)));
    refused(f, {check: true}, /input exceeds 1952 B/);
  }
});

test('CLI round trip note grammar, frontmatter, CURRENT from note and exact quick report', t => {
  const f = setup(t), r = ok(f.cli()), notes = listNotes(f.memoryDir);
  assert.equal(notes.length, 1);
  assert.match(path.basename(notes[0].file), /^000001-\d{4}-\d{2}-\d{2}-\d{4}\.md$/);
  const note = read(notes[0].file), parsed = parseHandover(note);
  assert.equal(parsed.valid, true); assert.equal(parsed.data.branch, 'main'); assert.equal(parsed.data.mode, 'quick');
  assert.ok(Buffer.byteLength(note) <= 3072);
  assert.equal(readCurrent(f.memoryDir).block, currentFromNote(note));
  assert.equal(parseBlock(currentFromNote(note)).state, input.state);
  assert.ok(read(path.join(f.memoryDir, 'current-state.md')).startsWith(initial.split('## CURRENT')[0]));
  assert.equal(f.git(f.holder, 'rev-parse', 'HEAD'), f.git(f.holder, 'rev-parse', '@{u}'));
  assert.ok(r.stdout.includes(QUICK_SAVED + '\n\n' + NEXT_QUICK));
  assert.match(r.stdout, /handover quick \d\d:\d\d token:[a-f0-9]{12} note:000001 \| Q: Which next\?/);
  assert.match(r.stdout, /lessons: skipped  checks: skipped/);
  assert.ok(r.stdout.split('\n').slice(0,6).every(line => line.startsWith('- ')));
  assert.match(r.stdout, /\n\nSTATE SAVED[^\n]*\n\nNext:/);
  assert.match(r.stdout, /close: none  gate: 0 FAIL, \d+ WARN/);
  assert.ok(Buffer.byteLength(r.stdout) <= 1536); assert.ok(r.stdout.trim().split('\n').length <= 12);
});

for (const original of ['', 'legacy text\n', '# RESUME\nlegacy state\n', initial + '## Other\nkeep exactly\n']) test('empty/legacy/preserved file ' + JSON.stringify(original.slice(0, 15)), t => {
  const f = setup(t); put(path.join(f.memoryDir, 'current-state.md'), original);
  success(f.run());
  const result = read(path.join(f.memoryDir, 'current-state.md'));
  assert.match(result, /^---\n/); assert.equal(readCurrent(f.memoryDir).headings.length, 1);
  if (original.includes('## Other')) assert.ok(result.endsWith('## Other\nkeep exactly\n'));
  if (original === 'legacy text\n') assert.match(result, /legacy text/);
});

for (const extra of ['\n# RESUME\nother', '\n### CURRENT\nother', '\n## Other\n' + 'x'.repeat(4100)]) test('whole-file refusal ' + extra.slice(0, 20), t => {
  const f = setup(t); put(path.join(f.memoryDir, 'current-state.md'), initial + extra);
  refused(f, {}, /whole file/);
  const findings = runCheck({memoryDir: f.memoryDir, repo: f.repo, config: f.config}).findings;
  assert.ok(findings.some(x => /state/.test(x.check) && ['WARN', 'FAIL'].includes(x.severity)));
});

test('caps, secret, verdict injection and missing memory refuse without writes', t => {
  const f = setup(t);
  const crlf = initial.replaceAll('\n', '\r\n') + '## Other\r\nkeep\r\n';
  const merged = mergeCurrent(crlf, '## CURRENT\nnew\n');
  assert.ok(merged.startsWith(crlf.split('## CURRENT')[0])); assert.ok(merged.endsWith('## Other\r\nkeep\r\n'));
  for (const [data, pattern] of [[{...input, state: 'x'.repeat(241)}, /state exceeds/], [{...input, question: 'sk-' + 'a'.repeat(40)}, /secret refused/], [{...input, state: 'SAFE TO COMPACT'}, /verdict/], [{...input, next: []}, /next requires/], [{...input, extra: 1}, /unknown input/]]) {
    f.saveInput(data); refused(f, {}, pattern);
  }
  f.saveInput(input); refused(f, {memoryDir: path.join(f.root, 'absent')}, /run node scripts\/memory\/memory-init.mjs/);
  f.saveInput({...input, next: ['x'.repeat(479)], question: 'y'.repeat(320), waits: 'z'.repeat(240), risks: 'r'.repeat(240), constraints: 'c'.repeat(240)}); refused(f, {}, /input exceeds 1184/);
  f.saveInput(input);
  put(path.join(f.repo, 'AGENTS.md'), read(path.join(f.repo, 'AGENTS.md')) + 'scratch: ' + 'x'.repeat(3000) + '\n');
  refused(f, {}, /note candidate exceeds 3072/);
});

test('CURRENT parses disk note, and wx never overwrites a collision', t => {
  const f = setup(t), oldWrite = fs.writeFileSync, oldRename = fs.renameSync;
  let noteWritten = false;
  t.mock.method(fs, 'writeFileSync', (file, text, options) => {
    if (/handovers[/\\]000001-.*\.md$/.test(String(file))) {
      assert.equal(options.flag, 'wx'); assert.equal(read(path.join(f.memoryDir, 'current-state.md')), initial);
      noteWritten = true;
      return oldWrite(file, String(text).replace('Ready to continue', 'Changed on disk'), options);
    }
    return oldWrite(file, text, options);
  });
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(to).endsWith('current-state.md')) assert.ok(noteWritten, 'note must precede CURRENT');
    return oldRename(from, to);
  });
  const r = f.run(); assert.equal(r.code, 1); assert.match(r.output, /own note not byte-identical/);
  assert.match(readCurrent(f.memoryDir).block, /Changed on disk/);
  t.mock.restoreAll();
  const g = setup(t);
  t.mock.method(fs, 'writeFileSync', (file, text, options) => {
    if (/handovers[/\\]000001-.*\.md$/.test(String(file))) oldWrite(file, 'collision');
    return oldWrite(file, text, options);
  });
  const collision = g.run(); assert.equal(collision.code, 1); assert.equal(readCurrent(g.memoryDir).block, '## CURRENT\nold state\n');
  assert.equal(read(path.join(g.memoryDir, 'handovers', fs.readdirSync(path.join(g.memoryDir, 'handovers'))[0])), 'collision');
});

test('token is compared after lock acquisition and covers unchanged-status bytes', t => {
  const f = setup(t), file = path.join(f.memoryDir, 'current-state.md');
  put(file, initial + '## Other\nA\n');
  const over = stateToken(f.memoryDir), before = f.git(f.memoryDir, 'status', '--porcelain');
  const secret = 'sk-' + 'a'.repeat(40);
  const r = success(f.run({over}, {beforeLock() { put(file, initial.replace('old state', 'old state ' + secret) + '## Other\nB\n'); }}));
  assert.match(r.output, /warning: another session handed over at .*; both notes kept/);
  assert.ok(!r.output.includes(secret)); assert.match(r.output, /REDACTED/);
  assert.ok(before.includes('current-state.md'));
  assert.equal(r.baseline, over);
});

test('two real processes same token equal clock keep two notes, later warning, start lists both', async t => {
  const f = setup(t), over = stateToken(f.memoryDir), fixed = new Date().toISOString();
  const driver = put(path.join(f.root, 'parallel.mjs'), `import fs from 'node:fs';\nimport {runHandover} from ${JSON.stringify(pathToFileURL(helper).href)};\nconst options = JSON.parse(process.argv[2]); options.now = new Date(options.now);\nconst ready = process.argv[3], go = process.argv[4];\nconst result = runHandover(options, {beforeLock() { fs.writeFileSync(ready, 'ready'); const start = Date.now(); while (!fs.existsSync(go)) { if (Date.now()-start > 15000) throw Error('barrier timeout'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } }});\nprocess.exitCode = result.code;\n`);
  const go = path.join(f.root, 'go');
  const launch = id => {
    const ready = path.join(f.root, 'ready' + id), args = {...f.options, over, now: fixed};
    const child = spawn(process.execPath, [driver, JSON.stringify(args), ready, go], {env: f.env, windowsHide: true});
    let output = ''; child.stdout.on('data', x => { output += x; }); child.stderr.on('data', x => { output += x; });
    return {ready, done: new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve({code, output})); })};
  };
  const a = launch('a'), b = launch('b');
  const deadline = Date.now() + 20000;
  while ((!fs.existsSync(a.ready) || !fs.existsSync(b.ready)) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  put(go, 'go'); const results = await Promise.all([a.done, b.done]); results.forEach(success);
  const notes = listNotes(f.memoryDir); assert.deepEqual(notes.map(n => n.seq), ['000002', '000001']);
  assert.equal(notes[0].time, notes[1].time);
  const later = results.find(r => r.output.includes('note:000002')), earlier = results.find(r => r.output.includes('note:000001'));
  assert.match(later.output, /warning: another session handed over at \d\d:\d\d; both notes kept/); assert.doesNotMatch(earlier.output, /warning:/);
  assert.ok(later.output.includes('**Open question:** Which next?'));
  assert.equal(readCurrent(f.memoryDir).block, currentFromNote(read(notes[0].file)));
  const start = ok(f.exec(process.execPath, [path.join(kitRoot, 'engine/new-session.mjs'), 'start', '--repo', f.repo, '--memory-dir', f.memoryDir])).stdout;
  assert.ok(start.indexOf('000002-') < start.indexOf('000001-'), start);
});

test('archive seq dominates clock and identical identity never merges', t => {
  const f = setup(t), old = new Date('2020-01-01T12:00:00Z');
  put(path.join(f.memoryDir, 'handovers/archive-2020-01.md'), '## 000123-2020-01-01-1200.md\narchived\n');
  const a = success(f.run({now: old})); assert.equal(a.seq, '000124');
  f.saveInput({...input, state: 'Different body'});
  const b = success(f.run({now: new Date('2019-01-01T12:00:00Z')})); assert.equal(b.seq, '000125');
  assert.equal(fs.readdirSync(path.join(f.memoryDir, 'handovers')).filter(n => /^\d/.test(n)).length, 2);
  assert.equal(listNotes(f.memoryDir)[0].seq, '000125');
});

test('real process crash between note and CURRENT leaves recoverable note and no SAFE', t => {
  const f = setup(t), driver = put(path.join(f.root, 'crash.mjs'), `import {runHandover} from ${JSON.stringify(pathToFileURL(helper).href)};\nrunHandover(JSON.parse(process.argv[2]), {afterNote() { process.exit(23); }});\n`);
  const r = f.exec(process.execPath, [driver, JSON.stringify(f.options)]);
  assert.equal(r.status, 23); assert.doesNotMatch(r.stdout, /SAFE TO COMPACT/);
  assert.equal(read(path.join(f.memoryDir, 'current-state.md')), initial); assert.equal(listNotes(f.memoryDir).length, 1);
  const start = ok(f.exec(process.execPath, [path.join(kitRoot, 'engine/new-session.mjs'), 'start', '--repo', f.repo, '--memory-dir', f.memoryDir])).stdout;
  assert.match(start, /000001-/);
  // A dead-pid lock younger than ten minutes is intentionally not broken by the existing lock helper.
  fs.unlinkSync(path.join(f.memoryDir, '.memory.lock'));
  success(f.run({replace: '000001'})); assert.equal(listNotes(f.memoryDir).length, 1);
});

// Kit 3.3.5 E8: the verdict reads the SHA the checkpoint saved and that SHA's verified publication on
// the actual remote, in both modes; a commit made after the save (another session's) never changes it. The failing cases
// therefore change what the checkpoint saves or publishes, and 'later commit' pins that a later unpushed HEAD is ignored.
for (const change of ['CURRENT', 'note', 'unpushed', 'later commit']) test('verdict uses only committed own note and pushed HEAD: ' + change, t => {
  const f = setup(t);
  let noteFile;
  const r = f.run({}, {afterNote(ctx) { noteFile = ctx.noteFile; }, checkpoint(options) {
    if (change === 'note') put(noteFile, read(noteFile).replace(input.state, 'Tampered state'));
    return checkpoint(change === 'unpushed' ? {...options, noPush: true} : options);
  }, beforeVerify(ctx) {
    if (change === 'CURRENT') put(ctx.currentFile, 'hand-edited unrelated CURRENT\n');
    if (change === 'later commit') { put(path.join(f.memoryDir, 'unrelated.txt'), 'waiting commit\n'); f.commit(f.memoryDir); }
  }});
  // A state block that is not this run's is a cause now (the verdict reads the files); a later commit of another session is not.
  if (change === 'later commit') success(r);
  else if (change === 'CURRENT') { assert.equal(r.code, 1); assert.match(r.output, /NOT SAFE TO COMPACT - memory not saved: current-state\.md does not hold this run's state/); }
  else { assert.equal(r.code, 1); assert.match(r.output, change === 'note' ? /own note not byte-identical/ : /HEAD not pushed/); }
});

test('failed gate retry token, replace retains seq, rejects committed/foreign/unknown before batch', t => {
  const f = setup(t); f.saveInput({...input, ...unheld});
  const fail = f.run({}, {checkpoint() { throw Error('injected gate FAIL'); }});
  assert.equal(fail.code, 1); assert.match(fail.output, /--replace 000001/); assert.match(fail.output, /full output:/);
  f.saveInput({...input, state: 'Repaired body'});
  const retry = success(f.run({replace: '000001', over: fail.token}));
  assert.doesNotMatch(retry.output, /warning:/); assert.equal(listNotes(f.memoryDir).length, 1);
  assert.equal(retry.noteFile, fail.noteFile); assert.match(read(retry.noteFile), /Repaired body/);
  f.saveInput({...input, lessons: none});
  refused(f, {quick: false, lessons: f.batch(), replace: '000001'}, /already in HEAD/);
  refused(f, {quick: false, lessons: f.batch(), replace: '123456'}, /unknown/);
  const own = read(retry.noteFile).replace('branch: "main"', 'branch: "other"');
  put(path.join(f.memoryDir, 'handovers/000002-2026-01-01-1200.md'), own);
  refused(f, {quick: false, lessons: f.batch(), replace: '000002'}, /another branch/);
});

test('replacement eligibility is rechecked under lock', t => {
  const f = setup(t), first = f.run({}, {checkpoint() { throw Error('stop'); }});
  const old = read(first.noteFile);
  const r = f.run({replace: first.seq}, {beforeLock() { f.commit(f.memoryDir); }});
  assert.equal(r.code, 1); assert.match(r.output, /already in HEAD/); assert.equal(read(first.noteFile), old);
});

for (const count of [1, 2, 3]) test('valid lesson batch ' + count + ' before note, names in HEAD', t => {
  const f = setup(t, {full: true}), r = success(f.run({lessons: f.batch(count)}, {afterNote(ctx) {
    assert.equal(fs.readdirSync(f.memoryDir).filter(n => /^lesson-/.test(n)).length, count);
    assert.equal(read(ctx.currentFile), initial);
  }}));
  assert.equal(r.created.length, count);
  for (const file of r.created) { assert.ok(read(r.noteFile).includes(file)); assert.ok(f.git(f.holder, 'show', 'HEAD:' + file)); }
  assert.ok(r.output.includes(FULL_SAFE(`learning added (${count} lessons)`)));
});

test('repeat-of existing schema is reused and published', t => {
  const f = setup(t, {full: true}), first = success(f.run({lessons: f.batch()}));
  const batch = put(path.join(f.root, 'repeat.md'), `## Repeated once\nrepeat-of: ${first.created[0]}\ncause: slip\ndescription: Validation was skipped a second time.\n`);
  const r = success(f.run({lessons: batch})); assert.deepEqual(r.created, first.created);
  assert.match(f.git(f.memoryDir, 'show', 'HEAD:' + first.created[0]), /Validation was skipped/);
  const different = f.batch(); put(different, read(different).replace('## Capture 1', '## Another capture'));
  // Kit 3.3.5 E8: the saved SHA is the evidence, so the lesson is lost before the save, not after it.
  const lost = f.run({lessons: different}, {afterCurrent(ctx) { fs.rmSync(path.join(f.memoryDir, ctx.created[0])); }});
  assert.equal(lost.code, 1); assert.match(lost.output, /lesson missing in HEAD/);
});

for (const kind of ['missing Why', 'empty Why', 'missing How', 'empty How', 'TODO', 'four', 'secret', 'inside']) test('batch refuses without any write: ' + kind, t => {
  const f = setup(t, {full: true}); let file = f.batch(kind === 'four' ? 4 : 1), raw = read(file);
  if (kind === 'missing Why') raw = raw.replace('**Why:**', 'Reason:');
  if (kind === 'empty Why') raw = raw.replace('Partial writes can lose a session.', '');
  if (kind === 'missing How') raw = raw.replace('**How to apply:**', 'Apply:');
  if (kind === 'empty How') raw = raw.replace('Verify the committed bytes and publication.', '');
  if (kind === 'TODO') raw = raw.replace(/description: .*/, 'description: TODO');
  if (kind === 'secret') raw += 'sk-' + 'a'.repeat(40);
  if (kind === 'inside') file = path.join(f.memoryDir, 'batch.md');
  put(file, raw); refused(f, {lessons: file}, /batch|description/);
});

test('real batch rollback leaves no lesson, note or CURRENT change', t => {
  const f = setup(t, {full: true}), file = f.batch(), before = snapshot(f);
  const r = f.run({lessons: file}, {batchLessons(options) {
    return batchLessons({...options, check: () => ({findings: [{severity: 'FAIL', file: 'lesson-001-capture-1.md', check: 'injected', message: 'rollback'}]})});
  }});
  assert.equal(r.code, 1); assert.match(r.output, /rolled back/); assert.deepEqual(snapshot(f), before);
});

for (const inRepo of [false, true]) {
  test(`${inRepo ? 'in-repo' : 'separate'} publishes selected paths only, lock released, no token passed`, t => {
    const f = setup(t, {inRepo}), projectHead = f.git(f.repo, 'rev-parse', 'HEAD');
    put(path.join(f.repo, 'uncommitted-code.js'), 'project work\n');
    let waiting;
    if (!inRepo) { put(path.join(f.memoryDir, 'foreign.txt'), 'waiting memory work\n'); f.commit(f.memoryDir); waiting = f.git(f.memoryDir, 'rev-parse', 'HEAD'); }
    const r = success(f.run({}, {checkpoint(options) {
      assert.equal(fs.existsSync(path.join(f.memoryDir, '.memory.lock')), false);
      assert.equal(options.lock, undefined); assert.equal(options.token, undefined);
      return checkpoint(options);
    }}));
    assert.equal(f.git(f.repo, 'ls-files', 'uncommitted-code.js'), '');
    assert.match(r.output, /uncommitted-code.js/);
    assert.equal(f.git(f.holder, 'rev-parse', 'HEAD'), f.git(f.holder, 'rev-parse', '@{u}'));
    if (!inRepo) { assert.equal(f.git(f.repo, 'rev-parse', 'HEAD'), projectHead); f.git(f.memoryDir, 'merge-base', '--is-ancestor', waiting, '@{u}'); assert.ok(r.output.includes(waiting.slice(0, 7))); }
  });

  for (const destination of ['roadmap', 'history', 'log', 'monthly']) test(`dirty rotation ${destination} refuses unchanged (${inRepo})`, t => {
    const f = setup(t, {inRepo});
    put(path.join(f.repo, 'docs/ROADMAP.md'), `## Open work (as of ${f.date})\n` + Array.from({length: 8}, (_, i) => `**2026-01-${String(i + 1).padStart(2, '0')}** Work\nDetails.\n`).join(''));
    put(path.join(f.repo, 'brain/00-system/log.md'), Array.from({length: 22}, (_, i) => `## [2026-01-${String(i + 1).padStart(2, '0')}] work\nDetails.\n`).join(''));
    put(path.join(f.repo, 'docs/ROADMAP-HISTORY.md'), '# History\n'); put(path.join(f.repo, 'brain/00-system/log-2026-01.md'), '# History\n');
    f.commit(); if (inRepo) f.git(f.repo, 'push');
    const names = {roadmap: 'docs/ROADMAP.md', history: 'docs/ROADMAP-HISTORY.md', log: 'brain/00-system/log.md', monthly: 'brain/00-system/log-2026-01.md'};
    const name = names[destination]; put(path.join(f.repo, name), read(path.join(f.repo, name)) + 'hand edit\n');
    fullRefused(f, {}, new RegExp(name.replaceAll('.', '\\.')));
  });

  test(`generated files and loose leftovers are exempt (${inRepo})`, t => {
    const f = setup(t, {inRepo});
    put(path.join(f.repo, 'docs/ROADMAP-OVERVIEW.md'), 'dirty generated\n');
    put(path.join(f.memoryDir, 'INDEX-craft-sessions.md'), '<!-- generated by memory-index.mjs; edit the lessons, not this file -->\ndirty\n');
    const failed = f.run({}, {checkpoint() { throw Error('stop before checkpoint'); }});
    assert.equal(failed.code, 1);
    success(f.run({replace: failed.seq, over: failed.token}));
  });

  test(`push failure then manual/plain retry (${inRepo})`, t => {
    const f = setup(t, {inRepo});
    f.git(f.bare, 'config', 'receive.denyCurrentBranch', 'ignore');
    put(path.join(f.bare, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n'); fs.chmodSync(path.join(f.bare, 'hooks/pre-receive'), 0o755);
    const failed = f.run(); assert.equal(failed.code, 1); assert.match(failed.output, /push failed|rejected/);
    assert.doesNotMatch(failed.output, /--replace/);
    fs.unlinkSync(path.join(f.bare, 'hooks/pre-receive'));
    if (inRepo) { fullRefused(f, {}, /outgoing project commit.*git push/); f.git(f.repo, 'push'); }
    const r = success(f.run({over: failed.token})); assert.equal(r.seq, '000002'); assert.equal(listNotes(f.memoryDir).length, 2);
  });

  test(`interrupted rotation destination refuses, recovery succeeds (${inRepo})`, t => {
    const f = setup(t, {inRepo});
    put(path.join(f.repo, 'docs/ROADMAP.md'), `## Open work (as of ${f.date})\n` + Array.from({length: 8}, (_, i) => `**2026-01-${String(i + 1).padStart(2, '0')}** Work\nDetails.\n`).join(''));
    f.commit(); if (inRepo) f.git(f.repo, 'push');
    put(path.join(f.repo, 'docs/ROADMAP-HISTORY.md'), '# Interrupted archive\n');
    fullRefused(f, {}, /ROADMAP-HISTORY.md.*|reconcile interrupted rotation/);
    f.commit(); if (inRepo) f.git(f.repo, 'push'); success(f.run());
  });
}

test('in-repo dirty memory, staged index and outgoing commit refuse unchanged', t => {
  const f = setup(t, {inRepo: true});
  put(path.join(f.memoryDir, 'topic.md'), 'hand-edited memory\n'); fullRefused(f, {}, /memory\/topic.md/);
  fs.unlinkSync(path.join(f.memoryDir, 'topic.md'));
  const router = path.join(f.memoryDir, 'MEMORY.md'), original = read(router);
  put(router, original + 'hand edit\n'); fullRefused(f, {}, /memory\/MEMORY.md/); put(router, original);
  put(path.join(f.repo, 'code.js'), 'code\n'); f.git(f.repo, 'add', 'code.js'); fullRefused(f, {}, /staged index/);
  f.git(f.repo, 'commit', '-m', 'outgoing'); fullRefused(f, {}, /outgoing project commit/);
  f.git(f.repo, 'push'); success(f.run());
});

test('in-repo failed commit leaves staged index, recovery then succeeds', t => {
  const f = setup(t, {inRepo: true});
  put(path.join(f.repo, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n'); fs.chmodSync(path.join(f.repo, '.git/hooks/pre-commit'), 0o755);
  f.saveInput({...input, ...unheld});
  const failed = f.run(); assert.equal(failed.code, 1); assert.match(failed.output, /--replace/);
  f.saveInput(input);
  fullRefused(f, {}, /staged index/); fs.unlinkSync(path.join(f.repo, '.git/hooks/pre-commit'));
  f.git(f.repo, 'commit', '-m', 'manual recovery'); f.git(f.repo, 'push'); success(f.run());
});

test('in-repo completed rotation after gate failure needs manual source commit', t => {
  const f = setup(t, {inRepo: true});
  put(path.join(f.repo, 'docs/ROADMAP.md'), `## Open work (as of ${f.date})\n` + Array.from({length: 8}, (_, i) => `**2026-01-${String(i + 1).padStart(2, '0')}** Work\nDetails.\n`).join(''));
  f.commit(); f.git(f.repo, 'push');
  f.saveInput({...input, ...unheld});
  const fail = f.run({}, {afterCurrent() { put(path.join(f.memoryDir, 'handovers/stray.md'), 'sk-' + 'a'.repeat(40)); }});
  assert.equal(fail.code, 1); assert.match(fail.output, /gate.*FAIL|secret/);
  fs.unlinkSync(path.join(f.memoryDir, 'handovers/stray.md'));
  f.saveInput(input);
  fullRefused(f, {}, /ROADMAP.md/); f.commit(); f.git(f.repo, 'push'); success(f.run());
});

test('separate completed rotation after gate failure retries without dirty-source refusal', t => {
  const f = setup(t);
  put(path.join(f.repo, 'docs/ROADMAP.md'), `## Open work (as of ${f.date})\n` + Array.from({length: 8}, (_, i) => `**2026-01-${String(i + 1).padStart(2, '0')}** Work\nDetails.\n`).join(''));
  f.commit();
  f.saveInput({...input, ...unheld});
  const fail = f.run({}, {afterCurrent() { put(path.join(f.memoryDir, 'handovers/stray.md'), 'sk-' + 'a'.repeat(40)); }});
  assert.equal(fail.code, 1); fs.unlinkSync(path.join(f.memoryDir, 'handovers/stray.md'));
  f.saveInput(input);
  success(f.run({replace: fail.seq, over: fail.token}));
});

for (const push of ['none', 'memory', 'wrong-branch']) test('in-repo publication policy ' + push, t => {
  const f = setup(t, {inRepo: true, overlay: push === 'wrong-branch' ? 'branch: other\n' : 'push: ' + push + '\n'});
  const before = f.git(f.repo, 'rev-parse', 'HEAD'), r = f.run();
  assert.equal(r.code, 1); assert.match(r.output, /^NOT FINISHED - memory NOT committed/m);
  assert.equal(f.git(f.repo, 'rev-parse', 'HEAD'), before); assert.match(r.output, /to run: git add --/);
});

test('separate push:none is NOT SAFE, no remote exception is explicit', t => {
  const f = setup(t, {overlay: 'push: none\n'}), r = f.run(); assert.equal(r.code, 1); assert.match(r.output, /HEAD not pushed/);
  const g = setup(t, {remote: false}); const local = success(g.run()); assert.match(local.output, /local only, no remote/);
});

test('overlay paths participate in dirty preflight', t => {
  const f = setup(t, {inRepo: true, overlay: 'roadmap: custom-plan.md | section: Open work\nlog: custom-log.md, 5 lines\n'});
  put(path.join(f.repo, 'custom-plan.md'), `## Open work (as of ${f.date})\n`); put(path.join(f.repo, 'custom-log.md'), `## [${f.date}] done\n`);
  f.commit(); f.git(f.repo, 'push'); put(path.join(f.repo, 'custom-log.md'), 'dirty\n');
  fullRefused(f, {}, /custom-log.md/);
});

test('full exact verdict, no brain and budget', t => {
  const f = setup(t, {full: true}), r = success(f.run());
  assert.ok(r.output.includes(FULL_SAFE('no learning stated (no new learning this session)'))); assert.match(r.output, /checks: roadmap current, log no brain/);
  assert.ok(Buffer.byteLength(r.output) <= 1536); assert.ok(r.output.trim().split('\n').length <= 12);
});

// The roadmap and the log are read, never written, by the run's own checks. Only the quoted roadmap line decides the verdict; the log is reported.
for (const condition of ['old heading', 'uncommitted edit', 'absent', 'no dated heading', 'quote not on a line', 'old log', 'uncommitted log']) test('read-only full checks ' + condition, t => {
  const f = setup(t, {full: true}); const roadmap = path.join(f.repo, 'docs/ROADMAP.md'), log = path.join(f.repo, 'brain/00-system/log.md');
  if (condition === 'old heading') put(roadmap, '## Open work (as of 2000-01-01)\n\nNothing pending.\n');
  if (condition === 'uncommitted edit') put(roadmap, read(roadmap) + 'hand edit\n');
  if (condition === 'absent') fs.unlinkSync(roadmap);
  if (condition === 'no dated heading') put(roadmap, '# Different format\n\nNothing pending.\n');
  if (condition === 'quote not on a line') put(roadmap, '## Open work (as of 2000-01-01)\n');
  if (condition.includes('log')) put(log, '## [2000-01-01] old\n');
  if (!condition.startsWith('uncommitted')) f.commit();
  const before = fs.existsSync(roadmap) ? read(roadmap) : null;
  const r = f.run();
  if (condition === 'absent') { assert.equal(r.code, 1, r.output); assert.match(r.output, /^NOT SAFE TO COMPACT - roadmap: no file at docs\/ROADMAP\.md/m); }
  else if (condition === 'quote not on a line') { assert.equal(r.code, 1, r.output); assert.match(r.output, /^NOT SAFE TO COMPACT - roadmap: "Nothing pending\." is not on a line of docs\/ROADMAP\.md/m); }
  else if (condition.includes('log')) { assert.equal(r.code, 1, r.output); assert.match(r.output, /^NOT FINISHED - log not updated today \(brain\/00-system\/log\.md\)$/m); assert.match(r.output, /^SAFE TO COMPACT - /m); }
  else { success(r); assert.match(r.output, /^SAFE TO COMPACT - /m); }
  assert.equal(fs.existsSync(roadmap) ? read(roadmap) : null, before);
});

test('quick skips stale checks; missing and unknown close entries refuse before lessons', t => {
  const f = setup(t); put(path.join(f.repo, 'docs/ROADMAP.md'), '## Open work (as of 2000-01-01)\n'); success(f.run());
  refused(f, {quick: false}, /full needs/);
  refused(f, {lessons: f.batch()}, /quick forbids --lessons/);
  put(path.join(f.repo, 'AGENTS.md'), read(path.join(f.repo, 'AGENTS.md')) + 'close: review; verify\n');
  fullRefused(f, {}, /closed missing close step: review/);
  f.saveInput({...input, closed: {review: 'ok', verify: 'ok', unknown: 'ok'}});
  fullRefused(f, {}, /closed names an unknown close step/);
  f.saveInput({...input, closed: {review: 'ok', verify: 'ok'}}); success(f.run());
});

for (const inRepo of [false, true]) test(`check writes nothing including git metadata/temp; validates replace and batch (${inRepo})`, t => {
  const f = setup(t, {inRepo, full: true}), batch = f.batch();
  const before = tree(f.root, {git: true});
  const r = ok(f.cli(['--lessons', batch], 'check'));
  assert.match(r.stdout, /plan: lessons lesson-001/); assert.doesNotMatch(r.stdout, /^SAFE TO COMPACT/m);
  assert.deepEqual(tree(f.root, {git: true}), before);
  refused(f, {check: true, lessons: batch, replace: '999999'}, /unknown/);
});

test('every output is capped, diagnostics redact secrets and failure never says SAFE', t => {
  const f = setup(t); f.saveInput({...input, ...unheld});
  const r = f.run({}, {checkpoint() { throw Error('failure '.repeat(3000) + 'sk-' + 'a'.repeat(40)); }});
  assert.equal(r.code, 1); assert.ok(Buffer.byteLength(r.output) <= 4000); assert.doesNotMatch(r.output, /sk-a{40}|^SAFE TO COMPACT/m);
  assert.match(r.output, /full output:/); assert.match(r.output, /--replace 000001/);
});

for (const change of ['frontmatter', 'other section']) test('outside-block token change warns: ' + change, t => {
  const f = setup(t), file = path.join(f.memoryDir, 'current-state.md');
  put(file, initial + '## Other\nA\n');
  const over = stateToken(f.memoryDir);
  const r = success(f.run({over}, {beforeLock() {
    put(file, change === 'frontmatter' ? read(file).replace('Current work.', 'Changed description.') : read(file).replace('## Other\nA', '## Other\nB'));
  }}));
  assert.match(r.output, /warning: another session handed over at .*; both notes kept/);
});

test('sequential stale --over warns after completed handover', t => {
  const f = setup(t), over = stateToken(f.memoryDir);
  success(f.run({over}));
  const r = success(f.run({over}));
  assert.match(r.output, /warning: another session handed over at .*; both notes kept/);
});

for (const reason of ['CURRENT growth', 'lock timeout', 'seq growth', 'note growth', 'replace changed']) test('orphan recovery names lessons and exact retry: ' + reason, t => {
  const f = setup(t, {full: true}), file = path.join(f.memoryDir, 'current-state.md');
  let replace;
  if (reason === 'replace changed') replace = f.run({}, {checkpoint() { throw Error('stop'); }}).seq;
  const before = read(file);
  const r = f.run({lessons: f.batch(), ...(replace ? {replace} : {})}, {lockTimeoutMs: 1, beforeLock(ctx) {
    if (reason === 'CURRENT growth') put(file, before + '## Other\n' + 'x'.repeat(4100));
    if (reason === 'lock timeout') put(path.join(f.memoryDir, '.memory.lock'), '{}');
    if (reason === 'seq growth') put(path.join(f.memoryDir, 'handovers/archive-2026-01.md'), '## 999999-2026-01-01-1200.md\n');
    if (reason === 'note growth') ctx.overlay.scratch = 'x'.repeat(3100);
    if (reason === 'replace changed') f.commit(f.memoryDir);
  }});
  assert.equal(r.code, 1, r.output); assert.equal(r.created.length, 1);
  assert.doesNotMatch(r.output, /saved locally|both notes kept|^SAFE TO COMPACT/m);
  assert.ok(r.output.includes('lessons: none (already written: ' + r.created.map(file => '`' + file + '`').join(', ') + ')'));
  assert.match(r.output, /\n\nfull output: .*\.log`\n\nre-run: `node .* run .*--in /);
  assert.match(r.output, /\n\nNext: fix the cause named in the verdict, then run the re-run line below; if there is none, run \/handover again\./);
  assert.doesNotMatch(r.output.split('re-run: ')[1], /--lessons/);
  if (reason === 'lock timeout') {
    assert.match(r.output, /\n\nmemory lock timed out/);
    assert.match(r.output, /\.memory\.lock`, age \d+ s; if no other session is running, remove it/);
  }
  if (!['CURRENT growth', 'replace changed'].includes(reason)) return;
  if (reason === 'CURRENT growth') put(file, before);
  else assert.doesNotMatch(r.output.split('re-run: ')[1], /--replace/);
  f.saveInput({...input, lessons: 'none (already written: ' + r.created.join(', ') + ')'});
  const command = stripSpan(r.output.split('re-run: ')[1]);
  const args = [...command.matchAll(/'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2]);
  const rerun = ok(f.exec(process.execPath, args.slice(1)));
  assert.match(rerun.stdout, /^SAFE TO COMPACT/m);
  assert.deepEqual(fs.readdirSync(f.memoryDir).filter(n => /^lesson-/.test(n)), r.created);
});

test('seq exhaustion and dry-run note size refuse before batch', t => {
  const f = setup(t, {full: true});
  const archive = put(path.join(f.memoryDir, 'handovers/archive-2026-01.md'), '## 999999-2026-01-01-1200.md\n');
  fullRefused(f, {}, /note sequence exhausted/); fs.unlinkSync(archive);
  put(path.join(f.repo, 'AGENTS.md'), read(path.join(f.repo, 'AGENTS.md')) + 'scratch: ' + 'x'.repeat(3000) + '\n');
  fullRefused(f, {}, /note candidate exceeds 3072/);
});

// A failed close step is reported on its own line above a verdict that is decided by the three conditions: the note and the lessons are published.
for (const skip of [false, true]) test('failed close publishes note and reports it as not finished: ' + skip, t => {
  const f = setup(t, {full: true, overlay: 'close: review; verify\n'});
  f.saveInput({...input, lessons: none, closed: {review: 'ok', verify: skip ? 'ok' : 'failed'}});
  const r = f.run({lessons: f.batch(), ...(skip ? {skipClose: 'review unavailable'} : {})});
  assert.equal(r.code, 1, r.output);
  assert.ok(r.output.includes(skip ? 'close: FAILED: review; verify (skipped: review unavailable)' : 'close: FAILED: verify'));
  assert.match(r.output, skip ? /^NOT FINISHED - close FAILED: review; close FAILED: verify$/m : /^NOT FINISHED - close FAILED: verify$/m);
  assert.match(r.output, /^SAFE TO COMPACT - memory saved; learning added \(1 lessons\); /m);
  assert.doesNotMatch(r.output, /re-run:|--replace/);
  assert.equal(f.git(f.holder, 'show', 'HEAD:' + path.relative(f.holder, r.noteFile).replaceAll('\\', '/')) + '\n', read(r.noteFile));
  assert.equal(f.git(f.holder, 'rev-parse', 'HEAD'), f.git(f.holder, 'rev-parse', '@{u}'));
  f.saveInput({...input, lessons: 'none (already written: ' + r.created.map(file => '`' + file + '`').join(', ') + ')', closed: {review: 'ok', verify: 'ok'}});
  success(f.run({over: r.token}));
});

for (const row of [
  {name: 'missing batch', edit: file => file + '.missing', error: /ENOENT/},
  {name: 'secret batch', edit: file => put(file, read(file) + 'sk-' + 'a'.repeat(40)), error: /batch: secret refused/},
  {name: 'four sections', count: 4, error: /batch accepts at most 3 sections/},
  {name: 'empty Why', edit: file => put(file, read(file).replace('Partial writes can lose a session.', '')), error: /batch requires filled \*\*Why:\*\*/},
  {name: 'empty How', edit: file => put(file, read(file).replace('Verify the committed bytes and publication.', '')), error: /batch requires filled \*\*How to apply:\*\*/},
]) test('missing memory validates ' + row.name, t => {
  const f = setup(t, {full: true, remote: false});
  const batch = f.batch(row.count), lessons = row.edit ? row.edit(batch) : batch;
  const before = tree(f.root, {git: true});
  const normal = f.run({lessons, check: true});
  assert.equal(normal.code, 1); assert.match(normal.output, row.error);
  const r = f.exec(process.execPath, [helper, 'run', '--repo', f.repo, '--memory-dir', path.join(f.root, 'absent'), '--in', f.inputPath, '--lessons', lessons]);
  assert.equal(r.status, 1); assert.equal(r.stderr, '');
  assert.match(r.stdout, /^SAVE REFUSED - memory folder missing/);
  assert.match(r.stdout, row.error); assert.doesNotMatch(r.stdout, /## CURRENT|^SAFE TO COMPACT/m);
  assert.deepEqual(tree(f.root, {git: true}), before);
});

test('missing memory accepts a valid three-section batch without writes', t => {
  const f = setup(t, {full: true, remote: false}), lessons = f.batch(3);
  const before = tree(f.root, {git: true});
  const r = f.run({memoryDir: path.join(f.root, 'absent'), lessons});
  assert.equal(r.code, 1); assert.match(r.output, /^SAVE REFUSED - memory folder missing[^\n]*\n## CURRENT\n/);
  assert.deepEqual(tree(f.root, {git: true}), before);
});

for (const quick of [false, true]) test('missing memory committed header time mode and dirty files quick=' + quick, t => {
  const f = setup(t, {full: !quick, remote: false});
  put(path.join(f.repo, 'AGENTS.md'), read(path.join(f.repo, 'AGENTS.md')) + '\n');
  put(path.join(f.repo, 'pending.txt'), 'pending\n');
  const sha = f.git(f.repo, 'rev-parse', 'HEAD').slice(0, 7), before = tree(f.root, {git: true});
  for (const [now, stamp] of [[new Date(2024, 1, 3, 4, 5), '2024-02-03 04:05:00'], [new Date(2027, 10, 12, 13, 14, 15), '2027-11-12 13:14:15']]) {
    const r = f.run({memoryDir: path.join(f.root, 'absent'), now});
    assert.equal(r.code, 1); assert.match(r.output, /^SAVE REFUSED - memory folder missing/);
    const header = r.output.split('\n')[2];
    assert.match(header, /^\*\*\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \| @[a-f0-9]{7} \| (full|quick)\./);
    assert.equal(header, `**${stamp} | @${sha} | ${quick ? 'quick' : 'full'}. Ready to continue**`);
    assert.match(r.output, /\*\*In flight:\*\* uncommitted 2 \(AGENTS\.md, pending\.txt\);/);
    assert.deepEqual(tree(f.root, {git: true}), before);
  }
});

test('missing memory labels detached HEAD with its real sha', t => {
  const f = setup(t, {remote: false});
  f.git(f.repo, 'checkout', '--detach');
  const sha = f.git(f.repo, 'rev-parse', 'HEAD').slice(0, 7), before = tree(f.root, {git: true});
  const r = f.run({memoryDir: path.join(f.root, 'absent')});
  assert.equal(r.code, 1); assert.ok(r.output.includes(`| @${sha} | quick.`));
  assert.match(r.output, /; detached; none/); assert.doesNotMatch(r.output, /unborn|no commit/);
  assert.deepEqual(tree(f.root, {git: true}), before);
});

for (const code of ['ENOBUFS', 'EACCES', 'dubious ownership']) test('missing memory labels unavailable git status ' + code, t => {
  const f = setup(t, {remote: false}), original = childProcess.execFileSync;
  t.mock.method(childProcess, 'execFileSync', (cmd, args, options) => {
    if (cmd === 'git' && (args.includes('--porcelain=v1') || code === 'dubious ownership')) throw Object.assign(Error('git failed'), {code, stderr: 'fatal: ' + code});
    return original(cmd, args, options);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const before = tree(f.root, {git: true}), r = f.run({memoryDir: path.join(f.root, 'absent')});
  assert.equal(r.code, 1); assert.match(r.output, /## CURRENT/);
  assert.match(r.output, /uncommitted status unavailable;/);
  assert.doesNotMatch(r.output, /not a git repository/);
  assert.deepEqual(tree(f.root, {git: true}), before);
});

test('missing memory precedes input validation without writes', t => {
  const f = setup(t, {full: true}), missing = path.join(f.root, 'absent');
  const before = tree(f.root, {git: true});
  const r = f.run({memoryDir: missing}); assert.equal(r.code, 1);
  assert.match(r.output, /SAVE REFUSED/); assert.match(r.output, /run node scripts\/memory\/memory-init.mjs/);
  assert.match(r.output, /^SAVE REFUSED - memory folder missing[^\n]*\n## CURRENT\n/);
  assert.match(r.output, /Ready to continue/);
  assert.match(r.output, /Open question:\*\* Which next\?/);
  assert.match(r.output, /Next action:\*\* 1\. Review results/);
  assert.deepEqual(tree(f.root, {git: true}), before);
  f.saveInput({...input, state: 'x'.repeat(241)});
  const bad = f.run({memoryDir: missing}); assert.match(bad.output, /memory folder missing/); assert.doesNotMatch(bad.output, /## CURRENT/);
  assert.match(bad.output, /state exceeds 240 B; state must be a string/);
});

for (const row of [
  {name: 'full without lessons and without --lessons', quick: false, data: input, error: /full needs --lessons or lessons: none/},
  {name: 'quick with a short lessons reason', quick: true, data: {...input, lessons: 'none (short)'}, error: /lessons must be none \(<reason/},
  {name: 'four next steps', quick: true, data: {...input, next: ['one', 'two', 'three', 'four']}, error: /next requires 1-3 single-line strings/},
  {name: 'four close steps', quick: true, overlay: 'close: one; two; three; four\n', data: {...input, closed: {one: 'ok', two: 'ok', three: 'ok', four: 'ok'}}, error: /close supports at most 3 steps/},
]) test('missing memory refuses ' + row.name, t => {
  const f = setup(t, {full: !row.quick, overlay: row.overlay}), missing = path.join(f.root, 'absent');
  f.saveInput(row.data);
  const before = tree(f.root, {git: true});
  const r = f.exec(process.execPath, [helper, 'run', '--repo', f.repo, '--memory-dir', missing, '--in', f.inputPath, ...(row.quick ? ['--quick'] : [])]);
  assert.equal(r.status, 1); assert.equal(r.stderr, '');
  assert.match(r.stdout, /^SAVE REFUSED - memory folder missing; run node scripts\/memory\/memory-init.mjs;/);
  assert.match(r.stdout, row.error); assert.doesNotMatch(r.stdout, /## CURRENT|^SAFE TO COMPACT/m);
  assert.deepEqual(tree(f.root, {git: true}), before);
});

for (const quick of [false, true]) for (const noGit of [false, true]) test(`missing memory recovery quick=${quick} noGit=${noGit}`, t => {
  const f = fixture(t), repo = noGit ? path.join(f.root, 'plain') : f.target, memory = path.join(f.root, 'absent');
  if (noGit) fs.mkdirSync(repo);
  const file = path.join(f.root, 'input.json');
  // A workspace-local TEMP must not make the plain fixture inherit the kit's repo.
  const cli = () => f.exec(process.execPath, [helper, 'run', '--repo', repo, '--memory-dir', memory, '--in', file, ...(quick ? ['--quick'] : [])], {env: {...f.env, GIT_CEILING_DIRECTORIES: f.root}});
  for (const valid of [true, false]) {
    put(file, JSON.stringify({...input, ...(!quick ? {lessons: none} : {}), ...(!valid ? {next: []} : {})}));
    const before = tree(f.root, {git: true}), r = cli();
    assert.equal(r.status, 1); assert.equal(r.stderr, '');
    assert.match(r.stdout, /^SAVE REFUSED - memory folder missing; run node scripts\/memory\/memory-init.mjs/);
    assert.doesNotMatch(r.stdout, /Command failed|fatal:|^SAFE TO COMPACT/m);
    if (valid) {
      assert.match(r.stdout, /\n## CURRENT\n/); assert.match(r.stdout, /@no commit/);
      assert.match(r.stdout, /Ready to continue/); assert.match(r.stdout, /Next action:\*\* 1\. Review results/);
      if (noGit) assert.match(r.stdout, /not a git repository/);
    } else {
      assert.match(r.stdout, /next requires 1-3 single-line strings/); assert.doesNotMatch(r.stdout, /## CURRENT/);
    }
    assert.deepEqual(tree(f.root, {git: true}), before);
  }
});

test('--over none supports absent CURRENT and BOM is stripped once', t => {
  const f = setup(t), file = path.join(f.memoryDir, 'current-state.md'); fs.unlinkSync(file);
  const r = success(f.run({over: 'none'})); assert.doesNotMatch(r.output, /warning:/);
  put(file, '\uFEFF' + initial); success(f.run());
  assert.equal(read(file).charCodeAt(0), 45); assert.equal((read(file).match(/^name: current-state$/gm) || []).length, 1);
  assert.equal((read(file).match(/^---$/gm) || []).length, 2);
});

test('full input 1952 B cap and JSON escaped secret candidate refuse', t => {
  const f = setup(t, {full: true});
  put(f.inputPath, JSON.stringify({...input, lessons: none}) + ' '.repeat(1952));
  fullRefused(f, {}, /input exceeds 1952 B/);
  const secret = 'sk-' + 'a'.repeat(40);
  put(f.inputPath, JSON.stringify({...input, question: secret, lessons: none}).replace(secret, [...secret].map(c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).join('')));
  fullRefused(f, {}, /note candidate: secret refused/);
});

test('CURRENT uses temp wx plus rename, template pinned, sha is HEAD sliced to seven', t => {
  assert.equal(mergeCurrent('', '## CURRENT\nnew\n').split('## CURRENT')[0], read(path.join(kitRoot, 'templates/current-state.md')).split('## CURRENT')[0]);
  const f = setup(t), file = path.join(f.memoryDir, 'current-state.md'), writes = [], renames = [];
  const write = fs.writeFileSync, rename = fs.renameSync;
  t.mock.method(fs, 'writeFileSync', (name, body, options) => { if (String(name).startsWith(file)) writes.push({name, body, options}); return write(name, body, options); });
  t.mock.method(fs, 'renameSync', (from, to) => { if (to === file) renames.push({from, to}); return rename(from, to); });
  const expected = f.git(f.repo, 'rev-parse', 'HEAD').slice(0, 7), r = success(f.run());
  assert.equal(parseHandover(read(r.noteFile)).data.sha, expected);
  assert.equal(writes.length, 1); assert.notEqual(writes[0].name, file); assert.equal(writes[0].options.flag, 'wx');
  assert.deepEqual(renames, [{from: writes[0].name, to: file}]); assert.equal(fs.existsSync(writes[0].name), false);
  assert.doesNotMatch(read(helper), /--short/);
});

test('main-only linked worktree refuses full batch', t => {
  const f = setup(t, {full: true, overlay: 'main-only: yes\n'});
  const linked = path.join(f.root, 'linked'); f.git(f.repo, 'worktree', 'add', '-b', 'linked', linked);
  fullRefused(f, {repo: linked}, /main-only overlay requires the main worktree/);
});

test('push none without remote is reported as not finished', t => {
  const f = setup(t, {full: true, remote: false, overlay: 'push: none\n'}), r = f.run();
  assert.equal(r.code, 1); assert.match(r.output, /^NOT FINISHED - memory committed, NOT pushed \(HEAD not pushed \(push: none\)\)/m); assert.match(r.output, /^SAFE TO COMPACT - /m);
});

for (const full of [false, true]) test('literal no-remote verdict: ' + full, t => {
  const f = setup(t, {full, remote: false}), r = success(f.run());
  const verdict = full ? FULL_SAFE('no learning stated (no new learning this session)') : QUICK_SAVED;
  assert.ok(r.output.includes(verdict + '\n\n' + (full ? NEXT : NEXT_QUICK)));
  assert.match(r.output, /memory [0-9a-f]{7} local only, no remote/);
});

// The brain log is reported, never judged: a dated heading for today, none, or no brain at all.
for (const variant of ['log current', 'log without a dated heading', 'no brain']) test('literal log-check verdict: ' + variant, t => {
  const f = setup(t, {full: true});
  if (variant !== 'no brain') { put(path.join(f.repo, 'brain/00-system/log.md'), variant === 'log current' ? `## [${f.date}] done\n` : '# Log\n'); f.commit(); }
  const r = success(f.run());
  assert.ok(r.output.includes(FULL_SAFE('no learning stated (no new learning this session)') + '\n\n' + NEXT));
  assert.match(r.output, new RegExp('checks: roadmap current, ' + {'log current': 'log current', 'log without a dated heading': 'log skipped \\(no dated heading\\)', 'no brain': 'log no brain'}[variant]));
});

test('repeats-only literal learning verdict', t => {
  const f = setup(t, {full: true}), first = success(f.run({lessons: f.batch()}));
  const batch = put(path.join(f.root, 'repeat.md'), `## Again\nrepeat-of: ${first.created[0]}\ncause: slip\ndescription: The same omission recurred.\n`);
  const r = success(f.run({lessons: batch}));
  assert.ok(r.output.includes('SAFE TO COMPACT - memory saved; repeats recorded; roadmap already holds it ("Nothing pending.")'));
});

test('report saturates exact 1536 B cap with literal tail', t => {
  const f = setup(t, {full: true});
  for (let i = 0; i < 6; i++) put(path.join(f.repo, String(i) + 'd'.repeat(190)), 'dirty\n');
  const r = success(f.run({}, {beforeVerify(ctx) {
    ctx.branch = 'b'.repeat(60); ctx.command = 'ran: ' + 'c'.repeat(210); ctx.data.question = 'q'.repeat(80);
    ctx.close = 's'.repeat(100); ctx.lessons = 'none (' + 'l'.repeat(230) + ')'; ctx.waiting = ['a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80)];
  }}));
  // The first three waiting items are shown whole, so they fill the report past its cap whatever the length of the fixture's paths
  // (with Linux's short temporary folder the 40-character items left it 20 bytes short).
  assert.equal(Buffer.byteLength(r.output), 1536); assert.ok(r.output.includes('[cut]'));
  assert.ok(r.output.endsWith(FULL_SAFE('no learning stated (no new learning this session)') + '\n\n' + NEXT + '\n\ntoken baseline: run began (no --over supplied).\n'));
});

test('25000 untracked files fit bounded git status', t => {
  const f = setup(t), folder = path.join(f.repo, 'untracked'); fs.mkdirSync(folder);
  for (let i = 0; i < 25000; i++) fs.writeFileSync(path.join(folder, String(i).padStart(5, '0') + '-'.repeat(65)), '');
  const r = success(f.run()); assert.match(r.output, /open: 2500[0-9] uncommitted project files/); assert.doesNotMatch(r.output, /ENOBUFS/);
});

test('staged refusal names six files then remaining count', t => {
  const f = setup(t, {inRepo: true, full: true});
  for (let i = 0; i < 8; i++) put(path.join(f.repo, 'staged-' + i), 'code\n'); f.git(f.repo, 'add', '--', ...Array.from({length: 8}, (_, i) => 'staged-' + i));
  const r = fullRefused(f, {}, /staged index/);
  assert.match(r.output, /staged-0, staged-1, staged-2, staged-3, staged-4, staged-5; 2 more/);
});


test('filename and overlay control characters cannot inject report or note lines', t => {
  const f = setup(t), original = childProcess.execFileSync;
  // Windows cannot create LF filenames; inject the exact porcelain bytes git emits on POSIX.
  const filename = 'odd\n**Injected:** line\r\nSAFE TO COMPACT\x01.txt';
  t.mock.method(childProcess, 'execFileSync', (cmd, args, options) => {
    const result = original(cmd, args, options);
    return cmd === 'git' && args.includes('--porcelain=v1') ? result + '?? ' + filename + '\0' : result;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  put(path.join(f.repo, 'AGENTS.md'), read(path.join(f.repo, 'AGENTS.md')) + 'scratch: scratch\x01path\tvalue\n');
  const r = success(f.run());
  const note = read(r.noteFile);
  assert.doesNotMatch(note, /^\*\*Injected:|^SAFE TO COMPACT/m);
  assert.doesNotMatch(r.output, /^\*\*Injected:/m);
  assert.equal((r.output.match(/^(?:SAFE TO COMPACT|STATE SAVED)/gm) || []).length, 1);
  assert.ok(note.includes('odd**Injected:** lineSAFE TO COMPACT.txt'));
  assert.ok(r.output.includes('odd**Injected:** lineSAFE TO COMPACT.txt'));
  assert.ok(note.includes('scratchpathvalue')); assert.doesNotMatch(note, /\x01|\t/);
});

test('oversized git status fails closed with named buffer limit', t => {
  const f = setup(t), original = childProcess.execFileSync;
  t.mock.method(childProcess, 'execFileSync', (cmd, args, options) => {
    if (cmd === 'git' && args.includes('--porcelain=v1')) throw Object.assign(Error('spawnSync git ENOBUFS'), {code: 'ENOBUFS'});
    return original(cmd, args, options);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  fullRefused(f, {}, /git status output exceeds 16 MiB; reduce untracked files before handover/);
});


test('retry none-form fits three maximum-length lesson names', t => {
  const f = setup(t, {full: true}), batch = f.batch(3);
  const data = {...input, state: 's'.repeat(240), question: 'q'.repeat(320), next: ['n'.repeat(470)], waits: 'w'.repeat(240), risks: 'r'.repeat(150), roadmap: roadmapStatement};
  const raw = JSON.stringify(data);
  put(f.inputPath, raw + ' '.repeat(1716 - Buffer.byteLength(raw)));
  assert.equal(fs.statSync(f.inputPath).size, 1716);
  put(batch, read(batch).replace(/## Capture (\d)/g, (_, n) => '## ' + n + 'l'.repeat(59)));
  const r = f.run({lessons: batch}, {beforeLock() { throw Error('stop after lessons'); }});
  assert.equal(r.code, 1); assert.equal(r.created.length, 3);
  const lessons = 'none (already written: ' + r.created.join(', ') + ')';
  assert.ok(Buffer.byteLength(lessons) > 240);
  const retry = read(f.inputPath).trimEnd().slice(0, -1) + ',"lessons":' + JSON.stringify(lessons) + '}' + ' '.repeat(1716 - Buffer.byteLength(raw));
  put(f.inputPath, retry); assert.ok(Buffer.byteLength(retry) > 1952);
  const command = stripSpan(r.output.split('re-run: ')[1]);
  const args = [...command.matchAll(/'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2]);
  assert.match(ok(f.exec(process.execPath, args.slice(1))).stdout, /^SAFE TO COMPACT/m);
  assert.deepEqual(fs.readdirSync(f.memoryDir).filter(n => /^lesson-/.test(n)), r.created);
  put(f.inputPath, retry + ' '.repeat(236));
  assert.equal(f.run({check: true}).code, 0, 'net exactly 1952 B accepted');
  put(f.inputPath, retry + ' '.repeat(237));
  refused(f, {}, /input exceeds 1952 B/);
  for (const names of [r.created.map(name => name.replace('lesson-00', 'lesson-100')), r.created.map(name => name.replace(/lesson-(\d+)-/, 'lesson-$1b-'))]) {
    for (let i = 0; i < names.length; i++) fs.copyFileSync(path.join(f.memoryDir, r.created[i]), path.join(f.memoryDir, names[i]));
    const addition = 'none (already written: ' + names.join(', ') + ')';
    const text = raw.slice(0, -1) + ',"lessons":' + JSON.stringify(addition) + '}';
    put(f.inputPath, text + ' '.repeat(1716 - Buffer.byteLength(raw)));
    assert.ok(fs.statSync(f.inputPath).size > 1952);
    assert.equal(f.run({check: true}).code, 0, 'retry accepts the filenames that the lesson engine supports');
    put(f.inputPath, read(f.inputPath).replace('already written:', 'ordinary reason:'));
    refused(f, {}, /input exceeds 1952 B/);
  }
});

// Kit 3.3.5 E2.8 (e): lib.mjs holds the one git environment cleaner, which names configuration variables only to delete
// them. That definition and its function are matched word for word and left out of the scan; any other mention, and
// any change to them, is still refused.
const CLEANER = String.raw`export const GIT_REDIRECTS = /^(?:GIT_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_COMMON_DIR|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM|GIT_NAMESPACE|GIT_CONFIG|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_LITERAL_PATHSPECS|GIT_GLOB_PATHSPECS|GIT_NOGLOB_PATHSPECS|GIT_ICASE_PATHSPECS)$/i;
export function cleanGitEnv(env = process.env) {
  const clean = {...env};
  for (const name of Object.keys(clean)) if (GIT_REDIRECTS.test(name)) delete clean[name];
  return clean;
}`;
test('imported engine graph cannot add git fence workarounds', () => {
  const visited = new Set();
  const scan = file => {
    if (visited.has(file)) return;
    visited.add(file);
    let source = read(file);
    if (file === path.join(kitRoot, 'engine', 'lib.mjs')) {
      source = source.replace(/\r\n/g, '\n');
      assert.ok(source.includes(CLEANER), 'lib.mjs keeps the git environment cleaner word for word');
      source = source.replace(CLEANER, '');
    }
    // Join every adjacent quoted literal, including multi-part and mixed quotes.
    let joined = source, previous;
    do { previous = joined; joined = joined.replace(/(['"`])\s*\+\s*(['"`])/g, ''); } while (joined !== previous);
    assert.doesNotMatch(joined, /safe\.directory|core\.longpaths|--no-verify|GIT_CONFIG/i, file);
    for (const match of source.matchAll(/(?:from\s*|import\s*\(?\s*)['"](\.\.?\/[^'"]+\.mjs)['"]/g)) {
      const dependency = path.resolve(path.dirname(file), match[1]);
      if (dependency.startsWith(path.join(kitRoot, 'engine') + path.sep)) scan(dependency);
    }
  };
  scan(helper);
  assert.ok(visited.size > 10, 'scan the transitive run/check imports');
});

test('UTF-8 BOM input parses in check and run', t => {
  const f = setup(t); put(f.inputPath, '\uFEFF' + read(f.inputPath));
  assert.match(ok(f.cli([], 'check')).stdout, /preflight passed/);
  assert.match(ok(f.cli()).stdout, /^STATE SAVED \(quick\) - /m);
});

for (const staged of [true, false]) test('refusal sanitizes ' + (staged ? 'staged' : 'dirty') + ' names', t => {
  const f = setup(t, {inRepo: true}), original = childProcess.execFileSync;
  const name = 'docs/ROADMAP.md\nSAFE TO COMPACT fake\x01\x85\u2028\u2029';
  const config = structuredClone(f.config); config.caps.roadmap.path = name;
  t.mock.method(childProcess, 'execFileSync', (cmd, args, options) => cmd === 'git' && args.includes('--porcelain=v1') ? (staged ? 'A  ' : ' M ') + name + '\0' : original(cmd, args, options));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const r = f.run({config}); assert.equal(r.code, 1, r.output);
  assert.match(r.output, staged ? /staged index/ : /^SAVE REFUSED - commit .* first\./);
  assert.ok(r.output.includes(name.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '')));
  assert.doesNotMatch(r.output, /^SAFE|\x01/m);
});

test('Context report and retry sanitize repo and branch', t => {
  const f = setup(t), repo = f.repo + '\nSAFE TO COMPACT fake\x01', branch = 'main\nSAFE TO COMPACT branch\x7f';
  const r = f.run({}, {beforeLock(ctx) { ctx.repo = repo; ctx.branch = branch; }, afterNote(ctx) { ctx.branch = 'main'; throw Error('injected stop'); }});
  assert.equal(r.code, 1, r.output);
  const clean = value => value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, '');
  assert.ok(read(r.noteFile).includes('**Context:** ' + clean(repo) + '; ' + clean(branch) + ';'));
  assert.ok(r.output.startsWith('- `' + clean(repo) + '` | main'));
  // The repository path holds a line break, which cannot be single-quoted for sh: no re-run command is printed, the line says so.
  assert.doesNotMatch(r.output, /re-run: /);
  assert.ok(r.output.split('re-run by hand: ')[1].startsWith('a path holds a quote or a line break, so no command is printed; input: '));
  assert.doesNotMatch(r.output, /^SAFE|[\x01\x7f]/m);
});


test('status overflow after publication is NOT FINISHED, never a cause: the proved verdict stands', t => {
  const f = setup(t, {full: true}), original = childProcess.execFileSync;
  let calls = 0;
  t.mock.method(childProcess, 'execFileSync', (cmd, args, options) => {
    if (cmd === 'git' && args.includes('--porcelain=v1') && ++calls > 1) throw Object.assign(Error('ENOBUFS'), {code: 'ENOBUFS'});
    return original(cmd, args, options);
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const r = f.run({lessons: f.batch()});
  // The three conditions were proved before the report was built, so a report that cannot read the status is an operational failure:
  // the verdict stands, NOT FINISHED names it, the exit is non-zero and no re-run line is needed.
  assert.equal(r.code, 1);
  assert.match(r.output, /^NOT FINISHED - the report could not read the project status \(git status output exceeds 16 MiB/m);
  assert.match(r.output, /^SAFE TO COMPACT - memory saved; learning added \(1 lessons\); /m);
  assert.match(r.output, /lessons: lesson-001-capture-1\.md/);
  assert.match(r.output, /full output: .*\.log/); assert.doesNotMatch(r.output, /re-run: |^NOT SAFE/m);
});

test('quick lock timeout prints file age and removal hint without a note', t => {
  const f = setup(t);
  const r = f.run({}, {lockTimeoutMs: 1, beforeLock() { put(path.join(f.memoryDir, '.memory.lock'), '{}'); }});
  assert.equal(r.code, 1); assert.match(r.output, /\.memory\.lock`, age \d+ s; if no other session is running, remove it/);
  assert.doesNotMatch(r.output, /saved locally|both notes kept/);
});


test('written lessons then push failure refuses unchanged retries and duplicate batch', t => {
  const f = setup(t, {full: true}), batch = f.batch();
  f.saveInput(input);
  f.git(f.holder, 'remote', 'set-url', 'origin', path.join(f.root, 'missing.git'));
  const first = f.run({lessons: batch});
  assert.equal(first.code, 1); assert.equal(first.created.length, 1);
  assert.match(first.output, /push failed/);
  for (const opts of [{}, {lessons: batch}]) {
    const retry = refused(f, opts, /set input lessons: none \(already written: lesson-001-capture-1.md\); re-run without --lessons/);
    assert.doesNotMatch(retry.output, /full needs --lessons/);
    assert.match(retry.output, /if this is a different batch, change state/);
    assert.deepEqual(fs.readdirSync(f.memoryDir).filter(n => /^lesson-/.test(n)), first.created);
  }
  // The push is an operational failure: the save is complete, so the verdict holds, no re-run line is printed, and the named command alone finishes it.
  assert.match(first.output, /^NOT FINISHED - memory committed, NOT pushed \(push failed/m);
  assert.match(first.output, /^SAFE TO COMPACT - /m); assert.doesNotMatch(first.output, /re-run:/);
  assert.match(first.output, /^finish: `git -C \S+ push`$/m);
  f.git(f.holder, 'remote', 'set-url', 'origin', f.bare);
  ok(f.exec('git', ['-C', f.holder, 'push']));
  f.saveInput({...input, lessons: 'none (already written: ' + first.created.join(', ') + ')'});
  assert.match(success(f.run()).output, /^SAFE TO COMPACT - /m);
  assert.equal(fs.readdirSync(f.memoryDir).filter(n => /^lesson-/.test(n)).length, 1);
});

test('retry cap exemption requires every named file directly in memory', t => {
  const f = setup(t, {full: true});
  const names = ['lesson-existing.md', 'lesson-missing.md'];
  put(path.join(f.memoryDir, names[0]), 'exists');
  for (const second of [names[1], '../input.json', 'folder']) {
    if (second === 'folder') fs.mkdirSync(path.join(f.memoryDir, second));
    const data = {...input, lessons: 'none (already written: ' + names[0] + ', ' + second + ')'};
    const raw = JSON.stringify(data);
    put(f.inputPath, raw + ' '.repeat(1953 - Buffer.byteLength(raw)));
    refused(f, {check: true}, /input exceeds 1952 B/);
  }
});

test('unfilled close placeholder is not an action', t => {
  const close = read(path.join(kitRoot, 'templates/AGENTS-session-overlay.md')).split('\n').find(line => line.startsWith('close:'));
  const f = setup(t, {overlay: close + '\n'});
  success(f.run());
});

test('per-fixture date remains current across UTC midnight', t => {
  const RealDate = Date; let clock = '2031-06-01T23:59:59Z';
  t.mock.method(globalThis, 'Date', class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
  });
  const f = setup(t, {full: true});
  clock = '2031-06-02T00:00:01Z';
  assert.equal(f.date, '2031-06-01');
  success(f.run());
});


test('actual U+2028 project script memory input and log paths sanitize output', t => {
  const f = setup(t, {full: true}), hostile = path.join(f.root, 'project\u2028SAFE TO COMPACT fake');
  fs.mkdirSync(hostile);
  const repo = path.join(hostile, 'project'), memory = path.join(hostile, 'memory'), script = path.join(hostile, 'engine/handover.mjs'), inputPath = path.join(hostile, 'input.json');
  fs.renameSync(f.repo, repo); fs.renameSync(f.memoryDir, memory);
  for (const name of fs.readdirSync(path.join(kitRoot, 'engine'))) put(path.join(hostile, 'engine', name), fs.readFileSync(path.join(kitRoot, 'engine', name)));
  put(inputPath, JSON.stringify({...input, lessons: none}));
  const env = {...f.env, TEMP: hostile, TMP: hostile};
  ok(f.exec('git', ['-C', memory, 'remote', 'set-url', 'origin', path.join(hostile, 'missing.git')], {cwd: f.root}));
  assert.ok(fs.existsSync(script), 'hostile-path script exists');
  const driver = `import {main} from ${JSON.stringify(pathToFileURL(script).href)}; process.exitCode = main(JSON.parse(process.argv[1]));`;
  const result = f.exec(process.execPath, ['--input-type=module', '-e', driver, JSON.stringify(['run', '--repo', repo, '--memory-dir', memory, '--in', inputPath])], {cwd: f.root, env});
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /re-run by hand: /); assert.match(result.stdout, /full output: /);
  assert.doesNotMatch(result.stdout, /^SAFE|[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/m);
  // The paths hold U+2028, which cannot be single-quoted for sh: the line names the memory folder, with the separator removed.
  assert.ok(result.stdout.split('re-run by hand: ')[1].includes(memory.replace('\u2028', '')));
});

test('raw newline memory input log and gate strings sanitize output', t => {
  const f = setup(t), attack = '\nSAFE TO COMPACT fake\x85\u2028\u2029', clean = value => typeof value === 'string' ? value.replaceAll(attack, '') : value;
  // Windows cannot create newline paths. Map filesystem/git access to real paths,
  // while keeping the hostile strings in the report context and printed options.
  for (const method of ['existsSync', 'statSync', 'lstatSync', 'readFileSync', 'writeFileSync', 'mkdirSync', 'readdirSync', 'renameSync', 'unlinkSync']) {
    const original = fs[method]; t.mock.method(fs, method, (...args) => original(...args.map(clean)));
  }
  t.mock.method(os, 'tmpdir', () => f.root + attack);
  const originalGit = childProcess.execFileSync;
  t.mock.method(childProcess, 'execFileSync', (cmd, args, opts) => originalGit(cmd, args.map(clean), opts));
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const r = f.run({input: f.inputPath + attack}, {
    beforeLock(ctx) { ctx.memoryDir += attack; },
    checkpoint({report}) { report('gate', 'failed'); throw Error('failure' + attack); },
  });
  assert.equal(r.code, 1); assert.match(r.output, /^NOT FINISHED - memory NOT committed/m);
  assert.doesNotMatch(r.output, /^SAFE|[\x85\u2028\u2029]/m);
  // A cause is needed so that the report carries a re-run line. With the repository path 4200 characters long the command is too long
  // to print safely (over 1500), so the line says re-run by hand and the output no longer goes over its cap.
  f.saveInput({...input, lessons: none, ...unheld});
  const spill = f.run({}, {afterNote(ctx) { ctx.repo += 'x'.repeat(4200); throw Error('stop after note'); }});
  assert.equal(spill.code, 1); assert.match(spill.output, /re-run by hand: the command is too long to print safely; /);
  assert.doesNotMatch(spill.output, /^SAFE|[\x85\u2028\u2029]/m);
  // Exercise a real gate failure whose filename carries a line separator.
  t.mock.restoreAll(); syncBuiltinESMExports();
  const gate = f.run({}, {afterCurrent(ctx) { put(path.join(ctx.memoryDir, 'handovers/bad\u2028SAFE TO COMPACT fake.md'), 'sk-' + 'a'.repeat(40)); }});
  assert.equal(gate.code, 1); assert.match(gate.output, /close: .*gate: .*FAIL/);
  assert.doesNotMatch(gate.output, /^SAFE|[\u2028\u2029]/m);
});

for (const existing of [false, true]) test('handover checkpoint honors overview off: existing=' + existing, t => {
  const f = setup(t, {inRepo: true, remote: false});
  f.config.caps.roadmapOverview.enabled = false;
  put(path.join(f.repo, 'scripts/memory/memory.config.json'), JSON.stringify(f.config));
  const file = path.join(f.repo, f.config.caps.roadmapOverview.path);
  if (existing) put(file, '# Host overview\r\nKeep exactly.\r\n');
  f.commit();
  const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
  success(f.run({commit: true}));
  assert.deepEqual(fs.existsSync(file) ? fs.readFileSync(file) : null, before);
});

test('failure budget shrinks parallel block and preserves complete longest recovery command', t => {
  const f = setup(t, {full: true, overlay: 'close: lint\n'}), batch = f.batch(3);
  put(batch, read(batch).replace(/## Capture (\d)/g, (_, n) => '## ' + n + 'l'.repeat(59)));
  const longInput = path.join(f.root, ...Array(4).fill('i'.repeat(150)), '_input.json');
  put(longInput, JSON.stringify({...input, ...unheld, closed: {lint: 'failed'}}));
  const r = f.run({input: longInput, lessons: batch, skipClose: true}, {
    afterCurrent(ctx) {
      ctx.warning = true; ctx.otherTime = '11:59'; ctx.replaced = '## CURRENT\n' + 'x'.repeat(4000) + '\n\n';
      ctx.command = 'x'.repeat(210); ctx.branch = 'b'.repeat(60);
      throw Error('push failed: ' + 'x'.repeat(200) + '\n' + 'y'.repeat(200) + '\n' + 'z'.repeat(200));
    }
  });
  assert.equal(r.code, 1); assert.equal(r.created.length, 3);
  assert.match(r.output, /lessons already written: `lesson-/);
  assert.match(r.output, /After doing the close step\(s\), set each step to ok/);
  const command = stripSpan(r.output.split('re-run: ')[1]);
  const expected = ['node', "'"+helper+"'", 'run', '--repo', "'"+f.repo+"'", '--memory-dir', "'"+f.memoryDir+"'", '--in', "'"+longInput+"'", '--over', r.token, '--replace', '000001'].join(' ');
  assert.equal(command, expected); assert.ok(r.output.endsWith('re-run: `'+expected+'`\n'));
  assert.ok(Buffer.byteLength(r.output)<=4000, Buffer.byteLength(r.output));
  assert.doesNotMatch(r.output, /\[cut; full output:/);
  const block=r.output.match(/\n```text\n[\s\S]*?\n```\n/)[0];
  assert.ok(Buffer.byteLength(block)<1900); assert.match(block, /\[cut\]/);
  // The roadmap quote that no roadmap holds is the cause that gives the re-run line; above it NOT FINISHED names the uncommitted save
  // (the run stopped before the checkpoint) and the failed close step.
  assert.match(r.output, /\n\nNOT FINISHED - memory NOT committed \(the run stopped before the checkpoint: push failed: [^)]*\): an overwrite by another session could not be undone; close FAILED: lint\n\nNOT SAFE TO COMPACT - roadmap: /);
  assert.ok(r.output.includes('Next: fix the cause named in the verdict, then run the re-run line below; if there is none, run /handover again.'));
});
