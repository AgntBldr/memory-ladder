// A lesson file is only ever seen whole: an existing file is replaced by a rename, a new one is published by a hard link
// from a complete temporary file, and the batch reports what it wrote (`expected`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {fixture, put, read, tree, kitRoot} from './helpers.mjs';
import {parseFrontmatter, loadConfig} from '../engine/lib.mjs';
import {writeMemoryIndex} from '../engine/memory-index.mjs';
import {batchLessons, newLesson, recordRepeat, allocate, draftLesson} from '../engine/memory-lesson.mjs';

const date = '2026-10-27', BOM = String.fromCharCode(0xfeff);
function setup(t) {
  const f = fixture(t);
  fs.mkdirSync(f.memory, {recursive: true});
  put(path.join(f.memory, 'MEMORY.md'), '# Memory\n- [Craft](INDEX-craft.md) OPEN BEFORE testing.\n');
  const options = {memoryDir: f.memory, repo: f.target, config: loadConfig(), today: date};
  writeMemoryIndex(options);
  const batch = (text, name = 'batch.md') => put(path.join(f.root, name), text);
  const lesson = (id = '001', eol = '\n', bom = '') => put(path.join(f.memory, `lesson-${id}-example.md`), bom + (`---\nname: lesson-${id}-example\ndescription: A useful lesson for testing.\nmetadata:\n  type: feedback\n  lesson: "${id}"\n  date: ${date}\n  route: ["craft"]\n---\n\n**#${id}. Example.**\n\nUseful body.\n`).replaceAll('\n', eol));
  return {...f, ...options, batch, lesson};
}
const section = (title, keys = '') => `## ${title}\nkind: mistake\nroute: craft\ndescription: "Remember this rule when testing."\n${keys}\n**Why:**\nA rule that was missed.\n\n**How to apply:**\nApply this rule when testing.\n`;
const repeatSection = (title = 'Repeat example', cause = 'slip') => `## ${title}\nrepeat-of: 1\ncause: ${cause}\ndescription: did it again\n`;
const DRAFT_TEXT = 'The gate stayed green after a rotation moved the lesson index, so a missing lesson went unseen; list the pages after every move.';
const lessonNames = dir => fs.readdirSync(dir).filter(name => /^lesson-/.test(name)).sort();
const sha = text => createHash('sha256').update(text).digest('hex');
// Writes half of a temporary lesson file and fails, as a full disk would.
function failHalfWay(t) {
  const original = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (name, text, options) => {
    if (/lesson-[^/\\]*\.tmp$/.test(String(name))) { original(name, String(text).slice(0, Math.floor(String(text).length / 2)), options); throw Error('disk full injected'); }
    return original(name, text, options);
  });
}

test('a recurrence whose rename fails leaves the lesson byte-identical and no temporary file', t => {
  const f = setup(t), file = f.lesson(), before = tree(f.memory);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => { if (to === file) throw Error('rename injected'); return rename(from, to); });
  assert.throws(() => recordRepeat({...f, id: '1', note: 'slip: again'}), /rename injected/);
  t.mock.restoreAll();
  assert.deepEqual(tree(f.memory), before);
  assert.deepEqual(fs.readdirSync(f.memory).filter(name => name.endsWith('.tmp')), []);
});

test('a lesson replaced in place keeps its line ends and byte order mark', t => {
  for (const [eol, bom] of [['\r\n', ''], ['\n', BOM], ['\r\n', BOM]]) {
    const f = setup(t), file = f.lesson('001', eol, bom), before = read(file);
    recordRepeat({...f, id: '1', note: 'slip: again'});
    const after = read(file);
    assert.equal(after.startsWith(BOM), bom !== '');
    assert.equal(after.replace(/^  repeats:\r?\n    - .*\r?\n/m, ''), before);
    assert.equal((after.match(/\r?\n/g) ?? []).every(x => x === eol), true);
  }
});

for (const kind of ['batch', 'batch, second of two', 'new', 'draft']) test(`a creation that fails half way leaves no file under the lesson's name, no temporary file and the number free: ${kind}`, t => {
  const f = setup(t), before = tree(f.memory);
  if (kind === 'batch, second of two') {
    const original = fs.writeFileSync; let temps = 0;
    t.mock.method(fs, 'writeFileSync', (name, text, options) => {
      if (/lesson-[^/\\]*\.tmp$/.test(String(name)) && ++temps === 2) { original(name, String(text).slice(0, 40), options); throw Error('disk full injected'); }
      return original(name, text, options);
    });
  } else failHalfWay(t);
  const run = () => kind === 'draft' ? draftLesson({...f, text: DRAFT_TEXT}) : kind === 'new' ? newLesson({...f, title: 'Half written', route: 'craft', kind: 'practice'}) : batchLessons({...f, file: f.batch(section('First') + (kind === 'batch' ? '' : section('Second')))});
  assert.throws(run, /disk full injected/);
  t.mock.restoreAll();
  assert.deepEqual(lessonNames(f.memory), []);
  assert.deepEqual(tree(f.memory), before);
  assert.deepEqual(allocate(f.memory, 1), ['001']);
});

for (const kind of ['batch', 'new', 'draft']) test(`a name that appears between the temporary write and the link is never replaced: ${kind}`, t => {
  const f = setup(t), link = fs.linkSync, other = 'someone else wrote this\n';
  let target;
  t.mock.method(fs, 'linkSync', (from, to) => { target = to; put(to, other); return link(from, to); });
  assert.throws(() => kind === 'draft' ? draftLesson({...f, text: DRAFT_TEXT}) : kind === 'new' ? newLesson({...f, title: 'Raced', route: 'craft', kind: 'practice'}) : batchLessons({...f, file: f.batch(section('Raced'))}), error => error.code === 'EEXIST');
  t.mock.restoreAll();
  assert.equal(read(target), other);
  assert.deepEqual(lessonNames(f.memory), [path.basename(target)]);
});

for (const code of ['EPERM', 'ENOSYS', 'EOPNOTSUPP']) test(`a file system that refuses hard links stops the tool with the reason and writes nothing: ${code}`, t => {
  const f = setup(t), before = tree(f.memory);
  t.mock.method(fs, 'linkSync', () => { throw Object.assign(Error(`${code}: not supported`), {code}); });
  assert.throws(() => newLesson({...f, title: 'No links', route: 'craft', kind: 'practice'}), error => error.code === code && /refused a hard link \(.*\)/.test(error.message) && error.message.includes('lesson-001-no-links.md'));
  assert.throws(() => batchLessons({...f, file: f.batch(section('No links'))}), /refused a hard link/);
  assert.throws(() => draftLesson({...f, text: DRAFT_TEXT}), error => error.code === code && /refused a hard link \(.*\)/.test(error.message) && error.message.includes('lesson-001-the-gate-stayed-green-after-a-rotation-moved.md'));
  t.mock.restoreAll();
  assert.deepEqual(tree(f.memory), before);
});

test('a temporary file that cannot be removed is reported, and the lesson is whole', t => {
  const f = setup(t), unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', name => { if (/lesson-[^/\\]*\.tmp$/.test(String(name))) throw Object.assign(Error('EBUSY: busy'), {code: 'EBUSY'}); return unlink(name); });
  const result = batchLessons({...f, file: f.batch(section('Whole'))});
  t.mock.restoreAll();
  assert.deepEqual(result.created, ['lesson-001-whole.md']);
  assert.ok(result.warnings.some(w => /lesson-001-whole\.md is whole; the temporary file .*\.tmp could not be removed/.test(w)), result.warnings.join('|'));
  const strays = fs.readdirSync(f.memory).filter(name => name.endsWith('.tmp'));
  assert.equal(strays.length, 1);
  assert.equal(read(path.join(f.memory, 'lesson-001-whole.md')).includes('**Why:**\nA rule that was missed.'), true);
  const lines = []; t.mock.method(console, 'error', (...items) => lines.push(items.join(' ')));
  t.mock.method(fs, 'unlinkSync', name => { if (/lesson-002[^/\\]*\.tmp$/.test(String(name))) throw Object.assign(Error('EBUSY: busy'), {code: 'EBUSY'}); return unlink(name); });
  newLesson({...f, title: 'Second', route: 'craft', kind: 'practice'});
  assert.ok(lines.some(line => /memory-lesson: lesson-002-second\.md is whole; the temporary file .*could not be removed/.test(line)), lines.join('|'));
  t.mock.method(fs, 'unlinkSync', name => { if (/lesson-003[^/\\]*\.tmp$/.test(String(name))) throw Object.assign(Error('EBUSY: busy'), {code: 'EBUSY'}); return unlink(name); });
  const draft = draftLesson({...f, text: DRAFT_TEXT});
  assert.deepEqual(draft, {file: 'lesson-003-the-gate-stayed-green-after-a-rotation-moved.md', created: true});
  assert.ok(lines.some(line => /memory-lesson: lesson-003-the-gate-stayed-green-after-a-rotation-moved\.md is whole; the temporary file .*could not be removed/.test(line)), lines.join('|'));
});

test('the batch says what it wrote: the hash of each created file and the entry of each recurrence', t => {
  const f = setup(t); f.lesson();
  const result = batchLessons({...f, file: f.batch(section('Created one') + section('Created two') + repeatSection())});
  assert.deepEqual(result.created, ['lesson-002-created-one.md', 'lesson-003-created-two.md']);
  assert.deepEqual(result.expected.created.map(x => x.file), result.created);
  for (const entry of result.expected.created) assert.equal(entry.sha256, sha(fs.readFileSync(path.join(f.memory, entry.file))));
  assert.deepEqual(result.expected.repeated, [{file: 'lesson-001-example.md', entry: `${date} slip: did it again`}]);
  assert.deepEqual(parseFrontmatter(read(path.join(f.memory, 'lesson-001-example.md'))).data.metadata.repeats, [`${date} slip: did it again`]);
  assert.deepEqual(result.repeated, [{file: 'lesson-001-example.md', repeats: 1}]);
  const rolled = batchLessons({...f, file: f.batch(section('Rolled back')), check: () => ({findings: [{check: 'lesson.repeats', severity: 'FAIL', file: 'lesson-004-rolled-back.md', message: 'injected'}]})});
  assert.equal(rolled.rolledBack, true);
  assert.deepEqual(rolled.expected, {created: [], repeated: []});
});

// The same operation under the previous release and under this one gives the same bytes in every file.
const referenceTag = 'v3.3.9';
const hasTag = spawnSync('git', ['-C', kitRoot, 'rev-parse', '--verify', '--quiet', 'refs/tags/' + referenceTag], {encoding: 'utf8', windowsHide: true}).status === 0;
test('repeat, enforce and classify --write give the same bytes as the previous release, CRLF and BOM files included', {skip: hasTag ? false : 'kit tags unavailable'}, async t => {
  const f = setup(t), reference = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-ref-'));
  t.after(() => fs.rmSync(reference, {recursive: true, force: true}));
  const archive = spawnSync('git', ['-C', kitRoot, 'archive', '--format=tar', referenceTag, 'engine', 'templates'], {maxBuffer: 1 << 28, windowsHide: true});
  assert.equal(archive.status, 0, String(archive.stderr));
  // The archive is read here, so no `tar` program (and no choice between two of them) is needed: 512-byte headers, names under 100 characters.
  for (let at = 0; at + 512 <= archive.stdout.length && archive.stdout[at] !== 0;) {
    const header = archive.stdout.subarray(at, at + 512), name = header.subarray(0, 100).toString().replace(/\0.*$/s, ''), size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, '').trim() || '0', 8), type = String.fromCharCode(header[156]);
    if (type === '0' || type === '\0') { fs.mkdirSync(path.dirname(path.join(reference, name)), {recursive: true}); fs.writeFileSync(path.join(reference, name), archive.stdout.subarray(at + 512, at + 512 + size)); }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  assert.ok(fs.existsSync(path.join(reference, 'engine/memory-lesson.mjs')) && fs.existsSync(path.join(reference, 'templates/lesson.md')));
  const old = await import(pathToFileURL(path.join(reference, 'engine/memory-lesson.mjs')).href + '?reference');
  f.lesson('001'); f.lesson('002', '\r\n'); f.lesson('003', '\n', BOM); f.lesson('004', '\r\n', BOM);
  writeMemoryIndex(f);
  const twin = path.join(f.root, 'twin'); fs.cpSync(f.memory, twin, {recursive: true});
  const kinds = put(path.join(f.root, 'kinds.json'), JSON.stringify({version: 1, kinds: {'lesson-001-example.md': 'practice', 'lesson-002-example.md': 'observation', 'lesson-003-example.md': 'practice', 'lesson-004-example.md': 'mistake'}}));
  const steps = api => memoryDir => {
    const options = {...f, memoryDir};
    for (const id of ['1', '2', '3', '4']) api.recordRepeat({...options, id, note: 'slip: again'});
    for (const id of ['1', '2', '3', '4']) api.setEnforced({...options, id, value: 'lesson-only because the fixture says so'});
    api.classifyLessons({...options, file: kinds, write: true});
  };
  steps(old)(twin); steps({recordRepeat, setEnforced: (await import('../engine/memory-lesson.mjs')).setEnforced, classifyLessons: (await import('../engine/memory-lesson.mjs')).classifyLessons})(f.memory);
  assert.deepEqual(tree(f.memory), tree(twin));
});
