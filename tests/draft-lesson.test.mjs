// A lesson saved for later is written at once as a draft lesson file: a real lesson with one extra front matter line and the
// text under **Draft:**. The gate counts it, the lesson tools read it, and finishing it is an edit of the same file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture, ok, put, read, tree, kitRoot} from './helpers.mjs';
import {parseFrontmatter, loadConfig, memoryFiles} from '../engine/lib.mjs';
import {writeMemoryIndex} from '../engine/memory-index.mjs';
import {runCheck} from '../engine/memory-check.mjs';
import * as session from '../engine/memory-session.mjs';
import {buildCorpus, search} from '../engine/memory-recall.mjs';
import {draftLesson, classifyLessons, recordRepeat, newLesson, batchLessons, findDraft} from '../engine/memory-lesson.mjs';

const date = '2026-10-27';
const TEXT = 'The gate stayed green after a rotation moved the lesson index, so a missing lesson went unseen; list the pages after every move.';
function setup(t) {
  const f = fixture(t);
  fs.mkdirSync(f.memory, {recursive: true});
  put(path.join(f.memory, 'MEMORY.md'), '# Memory\n- [Craft](INDEX-craft.md) OPEN BEFORE testing.\n- [Ops](INDEX-ops.md) OPEN BEFORE operating.\n');
  const options = {memoryDir: f.memory, repo: f.target, config: loadConfig(), today: date};
  writeMemoryIndex(options);
  const findings = (check, extra = {}) => runCheck({...options, scope: 'memory', noGit: true, ...extra}).findings.filter(x => !x.allowed && (!check || x.check === check));
  return {...f, ...options, findings, draftFiles: () => fs.readdirSync(f.memory).filter(n => /^lesson-/.test(n)).sort()};
}
const data = file => parseFrontmatter(read(file)).data;
const expectedText = (text = TEXT, number = '001', name = 'the-gate-stayed-green-after-a-rotation-moved') => `---
name: lesson-${number}-${name}
description: ${JSON.stringify('DRAFT, to finish: ' + text.slice(0, 110))}
metadata:
  type: feedback
  # Optional kind_case: Kn, set by new --case or classify --write; see LESSON-KINDS.md.
  kind: observation
  # Optional takeaway: fix | method | know; set by hand, never by models by default.
  lesson: "${number}"
  date: ${date}
  route: ["craft"]
  pin: false
  draft: "${date}"
---

**#${number} (${date}). ${text.split(/\s+/).slice(0, 8).join(' ')}.**

**Draft:** ${text}

**Why:**

**How to apply:**
`;

test('a draft lesson is a numbered lesson file made from the template, with the text under Draft and both prompts empty', t => {
  const f = setup(t), result = draftLesson({...f, text: TEXT});
  assert.deepEqual(result, {file: 'lesson-001-the-gate-stayed-green-after-a-rotation-moved.md', created: true});
  assert.equal(read(path.join(f.memory, result.file)), expectedText());
  const front = data(path.join(f.memory, result.file));
  assert.equal(front.metadata.draft, date); assert.equal(front.metadata.kind, 'observation'); assert.deepEqual(front.metadata.route, ['craft']);
  assert.deepEqual(f.draftFiles(), [result.file]);
});

test('the next lesson number follows the draft, and the same text is written once however often it is tried', t => {
  const f = setup(t), first = draftLesson({...f, text: TEXT}), before = tree(f.memory);
  for (let i = 0; i < 3; i++) assert.deepEqual(draftLesson({...f, text: TEXT}), {file: first.file, created: false});
  assert.deepEqual(tree(f.memory), before);
  assert.equal(findDraft(f.memory, TEXT), first.file);
  assert.equal(findDraft(f.memory, TEXT + ' '), null);
  const other = draftLesson({...f, text: TEXT.replace('green', 'quiet')});
  assert.equal(other.created, true); assert.match(other.file, /^lesson-002-/);
  assert.equal(f.draftFiles().length, 2);
  const lesson = newLesson({...f, title: 'Plain', route: 'craft', kind: 'practice'});
  assert.match(path.basename(lesson), /^lesson-003-/);
});

for (const [why, text] of [
  ['under 40 characters', 'Too short to be a lesson here.'],
  ['under 6 words', 'Supercalifragilisticexpialidocious-supercalifragilisticexpialidocious rule'],
  ['a secret', 'The key sk-' + 'a'.repeat(40) + ' was pasted into the memory by mistake, so rotate it.'],
  ['bold marks', 'The rule is **never** to skip the check when a rotation moves the index again.'],
  ['a line break', 'First line of what happened and\nthe rule to write from it, in two lines of text.'],
  ['not a string', 42],
  ['over the byte cap of a lesson', Array(6000).fill('word').join(' ')],
]) test('a draft text is refused when it is ' + why + ', and nothing is written', t => {
  const f = setup(t), before = tree(f.memory);
  assert.throws(() => draftLesson({...f, text}), /draft text|secret refused|byte cap/);
  assert.deepEqual(tree(f.memory), before);
});

test('a date that is not a date is refused, and nothing is written', t => {
  const f = setup(t), before = tree(f.memory);
  for (const today of ['2026-13-45', 'yesterday', '']) assert.throws(() => draftLesson({...f, text: TEXT, today}));
  assert.deepEqual(tree(f.memory), before);
});

test('the gate gives one lesson.draft warning for a draft, no failure, and nothing for the route', t => {
  const f = setup(t), {file} = draftLesson({...f, text: TEXT});
  writeMemoryIndex(f);
  const found = f.findings();
  assert.deepEqual(found.filter(x => x.severity === 'FAIL').map(x => `${x.check} ${x.file}`), []);
  const drafts = found.filter(x => x.check === 'lesson.draft');
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].severity, 'WARN'); assert.equal(drafts[0].file, file);
  assert.equal(drafts[0].message, `draft since ${date}: fill Why and How to apply, then delete the draft line`);
  assert.equal(found.some(x => /^route\./.test(x.check)), false);
});

test('the index and recall find a draft by a word of its text', t => {
  const f = setup(t), {file} = draftLesson({...f, text: TEXT});
  writeMemoryIndex(f);
  assert.match(read(path.join(f.memory, 'INDEX-craft.md')), new RegExp(`\\[#001\\]\\(${file}\\)`));
  const files = memoryFiles(f.memory), corpus = buildCorpus({...f, files, memoryOnly: true});
  assert.equal(search(corpus, 'rotation index unseen', 3)[0]?.path, file);
});

test('a draft is read by classify, repeat and the claims like any lesson', t => {
  const f = setup(t), {file} = draftLesson({...f, text: TEXT});
  assert.equal(classifyLessons({...f, file: put(path.join(f.root, 'kinds.json'), JSON.stringify({version: 1, kinds: {[file]: 'practice'}})), write: true}).lessons, 1);
  assert.equal(data(path.join(f.memory, file)).metadata.kind, 'practice');
  assert.equal(recordRepeat({...f, id: '1', note: 'slip: again'}).repeats.length, 1);
  assert.equal(data(path.join(f.memory, file)).metadata.draft, date);
  const batch = put(path.join(f.root, 'batch.md'), `## Next\nkind: mistake\nroute: craft\ndescription: "Remember this rule when testing."\n\n**Why:**\nA rule that was missed.\n\n**How to apply:**\nApply it.\n`);
  assert.deepEqual(batchLessons({...f, file: batch}).created, ['lesson-002-next.md']);
});

test('finishing a draft is an edit of the file: the draft line removed, both prompts filled', t => {
  const f = setup(t), {file} = draftLesson({...f, text: TEXT}), full = path.join(f.memory, file);
  put(full, read(full).replace(/^  draft: .*\n/m, '').replace('**Why:**\n', '**Why:**\nA green gate hid a missing lesson.\n').replace('**How to apply:**\n', '**How to apply:**\nList the pages after every move.\n').replace('description: "DRAFT, to finish: ', 'description: "'));
  writeMemoryIndex(f);
  assert.deepEqual(f.findings().filter(x => x.severity === 'FAIL' || /^lesson\.draft/.test(x.check)), []);
  // A finished lesson that keeps its Draft paragraph still matches the same text; one that dropped the paragraph does not.
  assert.equal(findDraft(f.memory, TEXT), file);
  put(full, read(full).replace(/^\*\*Draft:\*\* .*\n\n/m, ''));
  assert.equal(findDraft(f.memory, TEXT), null);
});

test('the draft line deleted from an unfilled draft is an unfilled lesson, as for any lesson', t => {
  const f = setup(t), {file} = draftLesson({...f, text: TEXT}), full = path.join(f.memory, file);
  put(full, read(full).replace(/^  draft: .*\n/m, ''));
  assert.deepEqual(f.findings('lesson.unfilled-body').map(x => x.file), [file]);
  assert.equal(f.findings('lesson.draft').length, 0);
});

test('a draft without its text, with a bad date or cut to its front matter is a failure', t => {
  const f = setup(t), {file} = draftLesson({...f, text: TEXT}), full = path.join(f.memory, file), original = read(full);
  const cases = [
    ['no Draft paragraph', original.replace(/^\*\*Draft:\*\* .*\n\n/m, ''), 'lesson.draft-text'],
    ['a Draft paragraph under 40 characters', original.replace(TEXT, 'too short'), 'lesson.draft-text'],
    ['a date that is not a date', original.replace(`draft: "${date}"`, 'draft: "yesterday"'), 'lesson.draft-text'],
    ['a draft line with no value', original.replace(`draft: "${date}"`, 'draft:'), 'lesson.draft-text'],
    ['cut to its front matter', original.slice(0, original.indexOf('\n---\n', 4) + 5), 'lesson.draft-text'],
  ];
  for (const [label, text, check] of cases) {
    put(full, text);
    // The pages are regenerated from the damaged file, as a checkpoint would, so only the draft itself can fail.
    writeMemoryIndex(f);
    const failures = f.findings().filter(x => x.severity === 'FAIL');
    assert.deepEqual(failures.map(x => x.check), [check], label);
    assert.equal(failures[0].file, file);
    assert.doesNotMatch(failures[0].message, /HEAD|overwrite|git checkout|restore from/i, label);
  }
  put(full, original); writeMemoryIndex(f);
  assert.deepEqual(f.findings().filter(x => x.severity === 'FAIL'), []);
});

test('a Draft paragraph wrapped over several lines counts as one text', t => {
  const f = setup(t), {file} = draftLesson({...f, text: TEXT}), full = path.join(f.memory, file);
  // The first lines of the file hold the same words in the title and the description; the break goes into the Draft paragraph itself.
  const wrapped = read(full).replace(/^(\*\*Draft:\*\* .*?) moved the lesson/m, '$1\nmoved the lesson');
  assert.notEqual(wrapped, read(full));
  assert.match(wrapped, /^\*\*Draft:\*\* [^\n]*\nmoved the lesson [^\n]*\n\n\*\*Why:\*\*/m);
  put(full, wrapped); writeMemoryIndex(f);
  assert.deepEqual(f.findings().filter(x => x.severity === 'FAIL'), []);
  assert.equal(f.findings('lesson.draft').length, 1);
  assert.equal(findDraft(f.memory, TEXT), file);
});

test('in session mode a draft is claimed by the session that writes it, so another session sees the new file as taken', t => {
  const f = setup(t), prior = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = f.env.GIT_CONFIG_GLOBAL;
  t.after(() => { if (prior === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prior; });
  const config = loadConfig(); config.caps.checkpoint = {mode: 'session'};
  put(path.join(f.target, '.gitignore'), '.memory.lock*\n.sessions/\n'); put(path.join(f.memory, '.gitignore'), '.memory.lock*\n.sessions/\n');
  f.git(f.target, 'add', '.'); f.git(f.target, 'commit', '-m', 'seed');
  f.git(f.memory, 'init', '-b', 'main'); f.git(f.memory, 'add', '.'); f.git(f.memory, 'commit', '-m', 'memory seed');
  const [one, two] = ['s1', 's2'].map(name => { const dir = path.join(f.root, name); f.git(f.target, 'worktree', 'add', '-q', '-b', name, dir); return dir; });
  const {file, created} = draftLesson({memoryDir: f.memory, repo: one, config, text: TEXT, today: date});
  assert.equal(created, true);
  assert.ok(JSON.parse(read(path.join(f.memory, '.sessions', session.sessionOf(one).id + '.json'))).claims[file], 'the writer holds a claim on the file');
  assert.equal(session.foreignClaims(f.memory, session.sessionOf(two).id).has(file), true, 'another session sees the claim');
  assert.equal(session.foreignClaims(f.memory, session.sessionOf(one).id).has(file), false);
});

test('a lesson file of zero bytes already fails the existing checks, so no check for it is added', t => {
  const f = setup(t), {file} = draftLesson({...f, text: TEXT}), full = path.join(f.memory, file);
  put(full, '');
  const checks = f.findings().filter(x => x.severity === 'FAIL' && x.file === file).map(x => x.check).sort();
  assert.deepEqual(checks, ['desc.missing', 'route.missing']);
  assert.equal(f.findings('lesson.empty').length, 0);
  // Without generated index pages there is no route check, and the description check still fails the file.
  for (const name of fs.readdirSync(f.memory).filter(n => /^INDEX-/.test(n))) fs.unlinkSync(path.join(f.memory, name));
  put(path.join(f.memory, 'MEMORY.md'), '# Memory\n');
  assert.deepEqual(f.findings().filter(x => x.severity === 'FAIL' && x.file === file).map(x => x.check), ['desc.missing']);
});

test('the lesson tool saves a draft from the command line, the same file as the function, and a second call writes nothing', t => {
  const f = setup(t), run = text => f.exec(process.execPath, [path.join(kitRoot, 'engine/memory-lesson.mjs'), 'draft', '--memory-dir', f.memory, '--repo', f.target, '--today', date, text]);
  const first = ok(run(TEXT));
  assert.equal(first.stdout.trim(), path.join(f.memory, 'lesson-001-the-gate-stayed-green-after-a-rotation-moved.md'));
  assert.equal(read(first.stdout.trim()), expectedText());
  const before = tree(f.memory), second = ok(run(TEXT));
  assert.equal(second.stdout.trim(), first.stdout.trim());
  assert.match(second.stderr, /already written/);
  assert.deepEqual(tree(f.memory), before);
  const refused = run('too short');
  assert.equal(refused.status, 1); assert.match(refused.stderr, /memory-lesson: draft text/);
});
