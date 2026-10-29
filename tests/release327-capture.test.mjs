import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {fixture, ok, put, read, tree, kitRoot} from './helpers.mjs';
import {parseFrontmatter, loadConfig} from '../engine/lib.mjs';
import {writeMemoryIndex} from '../engine/memory-index.mjs';
const api = () => import('../engine/memory-lesson.mjs');
const date = '2026-10-27';
function setup(t) {
  const f = fixture(t); ok(f.install());
  put(path.join(f.memory, 'MEMORY.md'), '# Memory\n- [Craft](INDEX-craft.md) OPEN BEFORE testing.\n');
  for (const file of fs.readdirSync(f.memory).filter(n => /^INDEX-/.test(n))) fs.unlinkSync(path.join(f.memory, file));
  const options = {memoryDir: f.memory, repo: f.target, config: loadConfig(), today: date};
  writeMemoryIndex(options);
  const cli = (...args) => f.cli('scripts/memory/memory-lesson.mjs', ['--memory-dir', f.memory, '--repo', f.target, '--today', date, ...args], f.target);
  const batch = (text, name = 'batch.md') => put(path.join(f.root, name), text);
  const lesson = (id = '001', body = 'Useful body.\n', eol = '\n') => put(path.join(f.memory, `lesson-${id}-example.md`), (`---\nname: lesson-${id}-example\ndescription: A useful lesson for testing.\nmetadata:\n  type: feedback\n  lesson: "${id}"\n  date: ${date}\n  route: ["craft"]\n---\n\n**#${id}. Example.**\n\n${body}`).replaceAll('\n', eol));
  return {...f, ...options, cli, batch, lesson};
}
const section = (title, keys = '', body = 'Apply this rule when testing.\n') => `## ${title}\nkind: mistake\nroute: craft\ndescription: "Remember this rule when testing."\n${keys}\n${body}`;
const data = file => parseFrontmatter(read(file)).data;

for (const command of ['classify --write', 'repeat']) test(`${command} restores every byte after first original restore fails once`, async t => {
  const f = setup(t), lessons = ['001', '002', '003'].map(id => f.lesson(id));
  writeMemoryIndex(f);
  put(path.join(f.memory, 'INDEX-craft-all.md'), '# Hand page\n');
  const before = tree(f.memory), mod = await api(), original = fs.writeFileSync;
  const file = f.batch(JSON.stringify({version: 1, kinds: Object.fromEntries(lessons.map(p => [path.basename(p), 'practice']))}));
  let fired = false;
  try {
    fs.writeFileSync = (target, ...args) => {
      if (!fired && target === lessons[0] && Buffer.isBuffer(args[0])) { fired = true; throw Error('first original restore injected'); }
      return original(target, ...args);
    };
    assert.throws(() => command === 'repeat' ? mod.recordRepeat({...f, id: '1', note: 'slip: again'}) : mod.classifyLessons({...f, file, write: true}), {message: 'run the route migration first; refusing to overwrite INDEX-craft-all.md'});
  } finally { fs.writeFileSync = original; }
  assert.equal(fired, true);
  assert.deepEqual(tree(f.memory), before);
});

test('restores both regenerated pages after first page restore fails once', async t => {
  const f = setup(t); f.lesson(); writeMemoryIndex(f);
  const before = tree(f.memory), pages = Object.keys(before).filter(n => n.startsWith('INDEX-'));
  assert.equal(pages.length, 2);
  const {batchLessons} = await api(), original = fs.writeFileSync;
  let armed = false, fired = false;
  try {
    fs.writeFileSync = (target, ...args) => {
      if (armed && !fired && pages.includes(path.basename(target))) { fired = true; throw Error('first page restore injected'); }
      return original(target, ...args);
    };
    assert.throws(() => batchLessons({...f, file: f.batch(section('Created') + repeatSection()), check() {
      for (const page of pages) assert.notEqual(tree(f.memory)[page], before[page]);
      armed = true; throw Error('check injected');
    }}), {message: 'check injected'});
  } finally { fs.writeFileSync = original; }
  assert.equal(fired, true);
  assert.deepEqual(tree(f.memory), before);
});

test('K327 batch renders three filled lessons and regenerates pages', t => {
  const f = setup(t); const old = path.basename(f.lesson('000'));
  const file = f.batch(section('First', `pin: true\nhook: "Short useful hook."\nsupersedes: ["${old}"]\ntype: reference\ndate: 2026-10-26\n`) + section('Second') + section('Third'));
  const r = ok(f.cli('batch', file)); assert.match(r.stdout, /gate: 0 FAIL/);
  const first = path.join(f.memory, 'lesson-001-first.md');
  assert.equal(data(first).description, 'Remember this rule when testing.');
  assert.deepEqual(data(first).metadata, {type: 'reference', kind: 'mistake', lesson: '001', date: '2026-10-26', route: ['craft'], pin: true, hook: 'Short useful hook.', supersedes: [old]});
  assert.match(read(first), /\*\*#001 \(2026-10-26\)/); assert.match(read(first), /Apply this rule/); assert.doesNotMatch(read(first), /TODO/);
  assert.match(read(path.join(f.memory, 'INDEX-craft.md')), /lesson-003-third/);
});
test('K327 batch collects TODO and blank prompt errors without writes', t => {
  const f = setup(t), before = tree(f.memory);
  const r = f.cli('batch', f.batch(section('First').replace('Remember this rule when testing.', 'TODO') + section('Second', '', '**Why:**\n\n**How to apply:**\nUse tests.\n') + section('Third', 'unknown: true\n')));
  assert.equal(r.status, 1); assert.match(r.stderr, /TODO/); assert.match(r.stderr, /empty \*\*Why:\*\*/); assert.match(r.stderr, /unknown key unknown/); assert.deepEqual(tree(f.memory), before);
});
test('K327 batch rejects an unknown route in section two atomically', t => {
  const f = setup(t), before = tree(f.memory);
  const r = f.cli('batch', f.batch(section('First') + section('Second').replace('route: craft', 'route: missing') + section('Third')));
  assert.equal(r.status, 1); assert.match(r.stderr, /route.unknown/); assert.deepEqual(tree(f.memory), before);
});
test('K327 batch rolls back after the second write', async t => {
  const f = setup(t), before = tree(f.memory), {batchLessons} = await api();
  assert.throws(() => batchLessons({...f, file: f.batch(section('First') + section('Second')), afterWrite(n) { if (n === 2) throw Error('injected write'); }}), /injected write/);
  assert.deepEqual(tree(f.memory), before);
});
test('K327 concurrent batches allocate disjoint ranges', async t => {
  const f = setup(t);
  const run = name => new Promise((resolve, reject) => {
    const file = f.batch(section(name + ' one') + section(name + ' two'), name + '.md');
    const script = `import fs from 'node:fs'; import {batchLessons} from ${JSON.stringify(pathToFileURL(path.join(f.target, 'scripts/memory/memory-lesson.mjs')).href)};
      if (process.argv.length !== 1 || process.execArgv.length !== 3 || process.execArgv[2].includes(Object.keys(process.env).find(k => k.startsWith('CAPTURE_ARGV_')))) throw Error('unexpected child argv');
      const root=${JSON.stringify(f.root)}; fs.writeFileSync(root+'/'+${JSON.stringify(name)}+'.ready','');
      const deadline=Date.now()+10000; while(fs.readdirSync(root).filter(n=>n.endsWith('.ready')).length<2) { if(Date.now()>deadline) throw Error('barrier timeout'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); }
      console.log(JSON.stringify(batchLessons(${JSON.stringify({memoryDir: f.memoryDir, repo: f.repo, config: f.config, today: f.today, file})})));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {env: {...f.env, CAPTURE_ARGV_SENTINEL: 'environment only'}}); let out = '', err = '';
    child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b); child.on('error', reject); child.on('close', code => resolve({code, out, err}));
  });
  const results = await Promise.all([run('First'), run('Second')]);
  for (const r of results) assert.equal(r.code, 0, r.err);
  assert.deepEqual(fs.readdirSync(f.memory).filter(n => /^lesson-/.test(n)).map(n => n.slice(7, 10)).sort(), ['001', '002', '003', '004']);
});
test('K327 batch refuses a file in memory and dry run writes nothing', t => {
  const f = setup(t), inside = put(path.join(f.memory, 'batch.md'), section('First')), before = tree(f.memory);
  const bad = f.cli('batch', inside); assert.equal(bad.status, 1); assert.match(bad.stderr, /inside.*memory/); assert.deepEqual(tree(f.memory), before);
  const r = ok(f.cli('batch', f.batch(section('First')), '--dry-run')); assert.match(r.stdout, /would create lesson-001/); assert.deepEqual(tree(f.memory), before);
});
test('K327 batch parser preserves fenced headings and CRLF bodies', async t => {
  const f = setup(t), {parseBatch} = await api();
  const body = '```md\n## Not a section\n```\n---\nFree form body.\n';
  const parsed = parseBatch(section('First', '', body).replaceAll('\n', '\r\n'));
  assert.equal(parsed.length, 1); assert.equal(parsed[0].body, body);
  ok(f.cli('batch', f.batch(section('First', '', body).replaceAll('\n', '\r\n'))));
  assert.ok(!read(path.join(f.memory, 'lesson-001-first.md')).includes('\r'));
});
test('K327 batch validates scalar keys, title, descriptions and body', t => {
  const f = setup(t);
  for (const text of ['', section('Same') + section('Same'), section('First', 'alien: true\n'), section('First', 'pin: yes\n'), section('First', 'hook: true\n'), section('First', 'type: invalid\n'), section('First', 'date: 2026-02-30\n'), section('First', 'supersedes: ["missing.md"]\n'), section('First', '', '**Why:**\n\n**How to apply:**\n'), section('First').replace('Remember this rule when testing.', 'Newest: bad'), section('First').replace('Remember this rule when testing.', 'x'.repeat(401))]) {
    const before = tree(f.memory), r = f.cli('batch', f.batch(text)); assert.equal(r.status, 1, text); assert.match(r.stderr, /batch (line|requires)/); assert.deepEqual(tree(f.memory), before);
  }
});
test('K327 repeats always append, preserve CRLF and body, and escalate', t => {
  const f = setup(t), file = f.lesson('001', 'Body remains: `D:\\work\\example`.\n', '\r\n'), body = read(file).split('---\r\n')[2];
  ok(f.cli('repeat', '1', 'slip: pushed: hook did not run')); const r = ok(f.cli('repeat', '#1', 'slip: pushed: hook did not run'));
  assert.deepEqual(data(file).metadata.repeats, [`${date} slip: pushed: hook did not run`, `${date} slip: pushed: hook did not run`]);
  assert.equal(read(file).split('---\r\n')[2], body); assert.ok(!/(?<!\r)\n/.test(read(file)));
  assert.match(r.stdout, /repeated 2 times.*decide where the mistake is visible/); assert.match(read(path.join(f.memory, 'INDEX-craft.md')), /\(2 repeats\)/);
});
test('K327 repeat rejects oversized, multiline, unknown and ambiguous targets', t => {
  const f = setup(t); f.lesson();
  for (const [id, note] of [['1', 'slip: ' + 'x'.repeat(190)], ['1', 'slip: two\nlines'], ['999', 'slip: note']]) {
    const before = tree(f.memory), r = f.cli('repeat', id, note); assert.equal(r.status, 1); assert.deepEqual(tree(f.memory), before);
  }
  put(path.join(f.memory, 'lesson-001-duplicate.md'), read(path.join(f.memory, 'lesson-001-example.md')));
  const before = tree(f.memory), r = f.cli('repeat', '1', 'slip: note'); assert.equal(r.status, 1); assert.match(r.stderr, /duplicate|ambiguous/); assert.deepEqual(tree(f.memory), before);
});
test('K327 enforce validates hard-rule, hook, check and lesson-only targets', t => {
  const f = setup(t), file = f.lesson(); put(path.join(f.memory, 'rule.md'), 'A hard rule.\n');
  for (const value of ['hard-rule rule.md', 'hook missing.mjs', 'hook ../outside.mjs', 'check nonsense', 'lesson-only too short']) {
    const before = tree(f.memory), r = f.cli('enforce', '1', value); assert.equal(r.status, 1, value); assert.deepEqual(tree(f.memory), before);
  }
  put(path.join(f.memory, 'MEMORY.md'), read(path.join(f.memory, 'MEMORY.md')) + '\n## Hard rules\n- [Rule](rule.md)\n');
  put(path.join(f.target, 'guard.mjs'), '// guard\n');
  for (const value of ['hard-rule rule.md', 'hook guard.mjs', 'check router.size', 'check guard.mjs', 'lesson-only deliberate decision']) {
    ok(f.cli('enforce', '1', value)); assert.equal(data(file).metadata.enforced, `${date} ${value}`);
  }
});
test('K327 enforcement same-day quiet, next-day returns, overwrite and permanent decision', t => {
  const f = setup(t), file = f.lesson(); put(path.join(f.target, 'guard.mjs'), '// guard\n');
  ok(f.cli('repeat', '1', 'slip: first')); ok(f.cli('repeat', '1', 'slip: second')); ok(f.cli('enforce', '1', 'hook guard.mjs'));
  const same = ok(f.cli('repeat', '1', 'slip: same day')); assert.doesNotMatch(same.stdout, /did not hold|decide where the mistake is visible/);
  const next = ok(f.cli('repeat', '1', 'slip: next day', '--today', '2026-10-28')); assert.match(next.stdout, /repeated 1 times after enforcement on 2026-10-27/);
  ok(f.cli('enforce', '1', 'lesson-only deliberate decision', '--today', '2026-10-28'));
  assert.match(data(file).metadata.enforced, /^2026-10-28/);
  const later = ok(f.cli('repeat', '1', 'slip: later', '--today', '2026-10-29')); assert.match(later.stdout, /after the lesson-only decision/);
  const configFile = path.join(f.target, 'scripts/memory/memory.config.json'), config = JSON.parse(read(configFile));
  config.caps.lesson = {lessonOnlyReturns: false}; put(configFile, JSON.stringify(config));
  assert.doesNotMatch(ok(f.cli('repeat', '1', 'slip: permanent', '--today', '2026-10-30')).stdout, /decide again/);
  put(file, read(file).replace(/^  enforced:.*$/m, '  enforced: "2026-10-27 hook missing.mjs"'));
  assert.match(ok(f.cli('repeat', '1', 'slip: enforcement is no longer valid')).stdout, /with no recorded decision/);
});
test('K327 legacy dry-run JSON is lock-free and conversion is idempotent', t => {
  const f = setup(t), prose = '**Recurred twice on 2026-10-27:** pushed again.\n**Recurred 3 more times the same day** same issue.\n\n**Recurred 3 more times (2026-10-27)** another issue.\n\n**Amended 2026-10-26:** explanation.\n\n**Repeated** undated.\n', file = f.lesson('001', prose);
  put(path.join(f.memory, 'topic.md'), '---\nname: topic\ndescription: Topic for testing repeat conversion.\nmetadata:\n  type: reference\n  route: craft\n---\nTopic title\n\n**Again, (2026-10-27)** topic issue.\n');
  const before = tree(f.memory); fs.mkdirSync(path.join(f.memory, '.memory.lock'));
  const dry = ok(f.cli('repeat', '--from-legacy', '--json')), summary = JSON.parse(dry.stdout);
  assert.deepEqual(Object.keys(summary), ['files', 'paragraphs', 'entries', 'undated', 'leftAsProse', 'items']);
  assert.equal(summary.files, 2); assert.equal(summary.entries, 9); assert.equal(summary.undated, 1); assert.equal(summary.leftAsProse, 1);
  fs.rmdirSync(path.join(f.memory, '.memory.lock')); assert.deepEqual(tree(f.memory), before);
  ok(f.cli('repeat', '--write', '--from-legacy')); assert.equal(data(file).metadata.repeats.length, 8);
  assert.ok(data(file).metadata.repeats.every(x => x.startsWith(`${date} legacy: `))); assert.ok(data(file).metadata.repeats.some(x => x.endsWith('(2 of 2)'))); assert.ok(read(file).includes(prose));
  const after = tree(f.memory); ok(f.cli('repeat', '--from-legacy', '--write')); assert.deepEqual(tree(f.memory), after);
});
test('K327 metadata splice replaces continuations and creates metadata', async () => {
  const {spliceMetadata} = await api();
  const text = '---\nname: sample\nmetadata:\n  repeats:\n    - "old"\n  route: ["craft"]\n---\nBody.\n';
  const result = spliceMetadata(text, 'repeats', ['2026-10-27 new: note'], {block: true});
  assert.deepEqual(parseFrontmatter(result).data.metadata, {repeats: ['2026-10-27 new: note'], route: ['craft']});
  assert.match(result, /    - "2026-10-27 new: note"/);
  assert.equal(parseFrontmatter(spliceMetadata('---\nname: sample\n---\nBody.\n', 'enforced', 'dated decision')).data.metadata.enforced, 'dated decision');
});

test('K327 batch restores generated pages after partial regeneration and gate failure', async t => {
  const f = setup(t), {batchLessons} = await api(), file = f.batch(section('First'));
  fs.unlinkSync(path.join(f.memory, 'INDEX-craft-all.md'));
  const before = tree(f.memory), original = fs.writeFileSync;
  let injected = false;
  fs.writeFileSync = (name, ...args) => {
    const result = original(name, ...args);
    if (!injected && String(name).endsWith('INDEX-craft-all.md')) { injected = true; throw Error('injected regeneration'); }
    return result;
  };
  try { assert.throws(() => batchLessons({...f, file}), /injected regeneration/); }
  finally { fs.writeFileSync = original; }
  assert.deepEqual(tree(f.memory), before);
  const result = batchLessons({...f, file: f.batch(section('Broken', 'hook: "[Missing](missing.md)"\n'))});
  assert.ok(result.findings.some(x => x.severity === 'FAIL')); assert.deepEqual(result.created, []); assert.deepEqual(tree(f.memory), before);
});
test('K327 batch keeps lessons for unrelated FAIL and honors route override and JSON', t => {
  const f = setup(t), old = f.lesson('099'); put(old, read(old).replace('A useful lesson for testing.', 'TODO'));
  const r = f.cli('batch', f.batch(section('First')), '--route', 'unknown', '--json');
  assert.equal(r.status, 1); const result = JSON.parse(r.stdout);
  assert.equal(result.rolledBack, false); assert.deepEqual(result.created.map(x => x.file), ['lesson-100-first.md']); assert.ok(fs.existsSync(path.join(f.memory, result.created[0].file)));
  assert.deepEqual(data(path.join(f.memory, result.created[0].file)).metadata.route, ['craft']);
});
test('K327 metadata operations restore lesson and index on regeneration failure', async t => {
  const f = setup(t), {recordRepeat, setEnforced} = await api(); f.lesson();
  put(path.join(f.memory, 'INDEX-craft-all.md'), '# User-owned page\n'); const before = tree(f.memory);
  assert.throws(() => recordRepeat({...f, id: '1', note: 'slip: repeat'}), /refusing to overwrite/); assert.deepEqual(tree(f.memory), before);
  assert.throws(() => setEnforced({...f, id: '1', value: 'check router.size'}), /refusing to overwrite/); assert.deepEqual(tree(f.memory), before);
});
test('K327 legacy counts a topic starting with a repeat and stops at bold leads', t => {
  const f = setup(t);
  put(path.join(f.memory, 'topic.md'), '---\nname: topic\ndescription: Useful topic for conversion.\n---\n**Again (2026-10-27)** first occurrence\n**Confirmed 2026-10-27** stays prose\n');
  const result = JSON.parse(ok(f.cli('repeat', '--from-legacy', '--json')).stdout);
  assert.equal(result.entries, 1); assert.equal(result.leftAsProse, 1);
});
test('K327 new remains byte-identical to the rendered template', t => {
  const f = setup(t), r = ok(f.cli('new', '--kind', 'mistake', '--route', 'craft', '--pin', 'Original title'));
  const values = {name: 'lesson-001-original-title', number: '001', title: 'Original title', date, route: '["craft"]', pin: 'true', kind: 'mistake'};
  assert.equal(read(r.stdout.trim()), read(path.join(kitRoot, 'templates/lesson.md')).replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]));
});

for (const [label, text] of [
  ['four-space children', '---\nmetadata:\n    type: feedback\n---\nBody.\n'],
  ['spaced delimiter', '--- \nmetadata:\n  type: feedback\n---\nBody.\n'],
  ['same-indent list', '---\nmetadata:\n  repeats:\n  - "old"\n  type: feedback\n---\nBody.\n'],
]) test(`splice ${label}`, async () => {
  const {spliceMetadata} = await api(), value = ['2026-10-27 new'];
  const result = spliceMetadata(text, 'repeats', value, {block: true}), parsed = parseFrontmatter(result).data;
  assert.deepEqual(parsed.metadata.repeats, value); assert.equal(parsed.__warnings, undefined);
  assert.equal(parsed.metadata.type, 'feedback'); assert.ok(result.endsWith('Body.\n'));
});

test('refuses flow metadata and top-level repeats without writes', async t => {
  const f = setup(t), {recordRepeat} = await api(), file = f.lesson();
  for (const [text, refusal] of [[read(file).replace(/metadata:\n(?:  .*\n)+/, 'metadata: {type: feedback}\n'), /flow-map metadata/], [read(file).replace('metadata:', 'repeats: ["2026-10-26 slip: old"]\nmetadata:'), /top-level repeats/]]) {
    put(file, text); const before = tree(f.memory);
    assert.throws(() => recordRepeat({...f, id: '1', note: 'slip: new'}), refusal);
    assert.deepEqual(tree(f.memory), before);
  }
});

test('splice escapes separators', async () => {
  const {spliceMetadata} = await api(), value = 'one\u2028two\u2029three';
  const result = spliceMetadata('---\nmetadata:\n  type: feedback\n---\n', 'hook', value);
  assert.deepEqual(parseFrontmatter(result).data.metadata.hook, value);
  assert.doesNotMatch(result, /[\u2028\u2029]/);
});

test('repeat rejects all control characters unchanged', async t => {
  const f = setup(t), {recordRepeat} = await api(); f.lesson(); const before = tree(f.memory);
  for (const c of ['\u2028', '\u2029', '\t', '\0', '\u007f', '\u0085']) {
    assert.throws(() => recordRepeat({...f, id: '1', note: 'slip: a' + c + 'b'}), /repeat note/);
    assert.deepEqual(tree(f.memory), before);
  }
});

test('repeat quoted Windows paths round-trip on topic filename', t => {
  const f = setup(t), file = f.lesson(), topic = path.join(f.memory, 'topic.md'); fs.renameSync(file, topic);
  const note = 'slip: a "quote", a \\ and D:\\work\\x\\'; ok(f.cli('repeat', 'topic.md', note));
  assert.deepEqual(data(topic).metadata.repeats, [`${date} ${note}`]);
});

test('repeat and enforce preserve BOM and blank lines', t => {
  const f = setup(t), file = f.lesson();
  put(file, '\uFEFF' + read(file).replace('  type: feedback', '  repeats: ["2026-10-26 slip: old"]\n\n  enforced: "2026-10-26 check router.size"\n\n  type: feedback'));
  ok(f.cli('repeat', '1', 'slip: new')); ok(f.cli('enforce', '1', 'check router.size'));
  const text = fs.readFileSync(file, 'utf8'); assert.ok(text.startsWith('\uFEFF---'));
  assert.match(text, /new"\n\n  enforced:/); assert.match(text, /router.size"\n\n  type:/);
});

test('legacy caps counts and lists manual paragraphs while skipping fences and headings', t => {
  const f = setup(t), file = f.lesson('001', '```md\n**Again 2026-10-27** fenced\n```\n\n**Recurred 5000 times 2026-10-27** enormous\n\n**Recurred 0 times 2026-10-27** zero\n### Heading\nnot part of note\n\n**Amended** explanation\n\n**Repeated** undated words\n');
  const result = JSON.parse(ok(f.cli('repeat', '--from-legacy', '--json')).stdout);
  assert.equal(result.entries, 1); assert.equal(result.items.length, 3);
  for (const item of result.items) assert.deepEqual(Object.keys(item), ['file', 'date', 'count', 'note']);
  assert.equal(result.items[1].note, 'zero'); assert.equal(result.items[1].count, 1);
  const out = ok(f.cli('repeat', '--from-legacy')).stdout;
  assert.match(out, /lesson-001-example.md:.*record by hand.*enormous/);
  assert.match(out, /lesson-001-example.md:.*left as prose.*Amended.*explanation/);
  assert.match(out, /lesson-001-example.md:.*no date, record by hand.*undated words/);
  ok(f.cli('repeat', '--from-legacy', '--write')); assert.deepEqual(data(file).metadata.repeats, [`${date} legacy: zero`]);
});

test('batch dry-run ignores lock and shipped template validates', t => {
  const f = setup(t); f.lesson(); put(path.join(f.memory, 'MEMORY.md'), '# Memory\n- [Craft](INDEX-craft-sessions.md) OPEN BEFORE testing.\n');
  fs.mkdirSync(path.join(f.memory, '.memory.lock')); const before = tree(f.memory);
  ok(f.cli('batch', path.join(kitRoot, 'templates/lesson-batch.md'), '--dry-run')); assert.deepEqual(tree(f.memory), before);
});

test('batch routes and written section body are exact', t => {
  const f = setup(t), body = 'A "quote" and `D:\\work\\x\\`.\n\n### Detail\nSpacing  stays.\n';
  put(path.join(f.memory, 'MEMORY.md'), read(path.join(f.memory, 'MEMORY.md')) + '- [Other](INDEX-other.md) OPEN BEFORE other work.\n');
  for (const [title, route] of [['Comma', 'craft, other'], ['Flow', '["craft", "other"]']]) {
    ok(f.cli('batch', f.batch(section(title, '', body).replace('route: craft', 'route: ' + route))));
    const file = path.join(f.memory, `lesson-${title === 'Comma' ? '001' : '002'}-${title.toLowerCase()}.md`);
    assert.deepEqual(data(file).metadata.route, ['craft', 'other']);
    assert.equal(parseFrontmatter(read(file)).body.replace(/^\n\*\*[^\n]+\*\*\n\n/, ''), body);
  }
});

test('batch gate failure explicitly reports rollback', t => {
  const f = setup(t), before = tree(f.memory), r = f.cli('batch', f.batch(section('Broken', 'hook: "[Missing](missing.md)"\n')));
  assert.equal(r.status, 1); assert.match(r.stdout, /batch: rolled back; nothing written/); assert.match(r.stdout, /FAIL/); assert.doesNotMatch(r.stdout, /batch: 0 lessons|index:|gate:/); assert.deepEqual(tree(f.memory), before);
  const json = f.cli('batch', f.batch(section('Broken', 'hook: "[Missing](missing.md)"\n')), '--json');
  assert.equal(JSON.parse(json.stdout).rolledBack, true); assert.deepEqual(tree(f.memory), before);
});

test('description precheck matches filename and ignores empty normalized words', async t => {
  const f = setup(t), {batchLessons} = await api();
  const a = batchLessons({...f, dryRun: true, file: f.batch(section('First').replace('Remember this rule when testing.', 'lesson 001 first'))});
  assert.ok(a.warnings.some(w => /restates/.test(w)));
  const b = batchLessons({...f, dryRun: true, file: f.batch(section('\u6771\u4eac').replace('Remember this rule when testing.', '\u6771\u4eac'))});
  assert.equal(b.warnings.length, 0);
});

test('batch collects topic cap with other validation errors', async t => {
  const f = setup(t), {batchLessons} = await api(), before = tree(f.memory);
  f.config.caps.topic.failBytes = 500;
  assert.throws(() => batchLessons({...f, file: f.batch(section('Huge', '', 'body '.repeat(300) + '\n') + section('Invalid').replace('Remember this rule when testing.', 'TODO'))}), error => /topic byte cap/.test(error.message) && /TODO/.test(error.message));
  assert.deepEqual(tree(f.memory), before);
});

test('CLI diagnostics separator and normalized hard-rule path', t => {
  const f = setup(t), file = f.lesson();
  assert.match(f.cli('unknown').stderr, /new.*batch.*repeat.*enforce/);
  assert.match(f.cli('repeat').stderr, /missing lesson id/);
  assert.match(f.cli('repeat', '1').stderr, /-- separator/);
  ok(f.cli('repeat', '1', '--', 'slip: --write')); assert.deepEqual(data(file).metadata.repeats, [`${date} slip: --write`]);
  put(path.join(f.memory, 'rule.md'), 'Rule.\n');
  put(path.join(f.memory, 'MEMORY.md'), read(path.join(f.memory, 'MEMORY.md')) + '\n## Hard rules\n- [Rule](rule.md)\n');
  ok(f.cli('enforce', '1', 'hard-rule ./rule.md'));
});

test('rollback reports original error before restoration error', async t => {
  const f = setup(t), {batchLessons, recordRepeat} = await api(), original = fs.writeFileSync;
  try {
    fs.writeFileSync = (file, ...args) => { if (String(file).includes('INDEX-craft')) throw Error('restore failed'); return original(file, ...args); };
    assert.throws(() => batchLessons({...f, file: f.batch(section('First')), afterWrite() { throw Error('original failed'); }}), /original failed[\s\S]*restore failed/);
  } finally { fs.writeFileSync = original; }
  const file = f.lesson();
  try {
    fs.writeFileSync = (name, ...args) => { if (String(name) === file) throw Error('lesson write failed'); if (String(name).includes('INDEX-craft')) throw Error('restore failed'); return original(name, ...args); };
    assert.throws(() => recordRepeat({...f, id: path.basename(file), note: 'slip: new'}), /lesson write failed[\s\S]*rollback failed/);
  } finally { fs.writeFileSync = original; }
});


test('docs describe optional supersedes and date', () => {
  const template = read(path.join(kitRoot, 'templates/lesson-batch.md')), row = read(path.join(kitRoot, 'engine/README.md')).split('\n').find(l => l.startsWith('| `memory-lesson.mjs batch`'));
  for (const text of [template, row]) { assert.match(text, /optional/i); assert.match(text, /supersedes/); assert.match(text, /date/); }
  for (const file of ['engine/README.md', 'docs/GLOSSARY.md']) {
    const text = read(path.join(kitRoot, file));
    for (const pattern of [/20 repeats/, /[Ff]enced code/, /[Ff]low-map metadata/, /top-level target keys/, /-- separator|-- "--option-like note"/]) assert.match(text, pattern);
  }
});


test('splice verification rejects lossy values and new warnings', async () => {
  const {spliceMetadata} = await api(), text = '---\nmetadata:\n  type: feedback\n---\n';
  assert.throws(() => spliceMetadata(text, 'hook', NaN), /verification.*the lesson's frontmatter could not be updated safely; edit it by hand and rerun/);
  assert.throws(() => spliceMetadata(text, '__warnings', 'bad'), /verification/);
});

test('legacy nonpositive counts become one and twenty is the maximum automatic count', async t => {
  const f = setup(t), file = f.lesson('001', '**Recurred 0 times 2026-10-27** zero\n\n**Recurred 20 times 2026-10-27** twenty\n\n**Recurred 21 times 2026-10-27** manual\n\n**Recurred -5 times 2026-10-27** negative\n'), {convertLegacyRepeats} = await api();
  const result = convertLegacyRepeats({...f, write: true}); assert.equal(result.entries, 22);
  assert.equal(data(file).metadata.repeats.length, 22); assert.equal(data(file).metadata.repeats[0], `${date} legacy: zero`);
  assert.ok(data(file).metadata.repeats.at(-2).endsWith('(20 of 20)')); assert.equal(data(file).metadata.repeats.at(-1), `${date} legacy: negative`);
});





test('legacy prose listing and fence/heading boundaries', t => {
  const f = setup(t), file = f.lesson('001', '~~~md\n**Again 2026-10-27** fenced\n~~~\n\n**Again 2026-10-27** included\n# Heading\nexcluded\n\n**Confirmed** preserved words\n');
  put(file, read(file).replace('**#001. Example.**\n\n', ''));
  const r = JSON.parse(ok(f.cli('repeat', '--from-legacy', '--json')).stdout);
  assert.equal(r.items.length, 1); assert.equal(r.items[0].note, 'included');
  assert.match(ok(f.cli('repeat', '--from-legacy')).stdout, /lesson-001-example.md: left as prose;.*preserved words/);
});

test('replacement preserves blank lines without BOM', async () => {
  const {spliceMetadata} = await api();
  const text = '---\nmetadata:\n\n  repeats: []\n\n  type: feedback\n---\n';
  assert.equal(spliceMetadata(text, 'repeats', ['new']), text.replace('repeats: []', 'repeats: ["new"]'));
});

test('batch rejects controls in description and hook before writes', async t => {
  const f = setup(t), {batchLessons} = await api(), before = tree(f.memory);
  for (const key of ['description', 'hook']) {
    const text = section('First', key === 'hook' ? 'hook: "a\\tb"\n' : '').replace(key === 'description' ? 'Remember this rule when testing.' : 'absent', 'a\\tb');
    assert.throws(() => batchLessons({...f, file: f.batch(text)}), /control characters/); assert.deepEqual(tree(f.memory), before);
  }
});

test('gate findings precede rollback failure', async t => {
  const f = setup(t), {batchLessons} = await api(), original = fs.unlinkSync;
  try {
    fs.unlinkSync = file => { if (String(file).endsWith('lesson-001-broken.md')) throw Error('unlink failed'); return original(file); };
    assert.throws(() => batchLessons({...f, file: f.batch(section('Broken', 'hook: "[Missing](missing.md)"\n'))}), /FAIL link.dead[\s\S]*rollback failed: unlink failed/);
  } finally { fs.unlinkSync = original; }
});

for (const key of ['hook', 'supersedes']) test(`batch collects nested ${key} and TODO errors`, t => {
  const f = setup(t), before = tree(f.memory);
  const r = f.cli('batch', f.batch(section('Nested', `${key}:\n  a: 1\n`) + section('Invalid').replace('Remember this rule when testing.', 'TODO')));
  assert.equal(r.status, 1); assert.match(r.stderr, new RegExp(`batch line 1: ${key} must`));
  assert.match(r.stderr, /batch line \d+: description.*TODO/); assert.doesNotMatch(r.stderr, /splice verification/);
  assert.deepEqual(tree(f.memory), before);
});

test('render failures join validation errors with batch lines', async t => {
  const f = setup(t), {batchLessons} = await api(), before = tree(f.memory), original = fs.readFileSync;
  fs.readFileSync = (file, ...args) => String(file).replaceAll('\\', '/').endsWith('/templates/lesson.md') ? '---\nmetadata: {type: feedback}\n---\nHeading\n' : original(file, ...args);
  try {
    assert.throws(() => batchLessons({...f, file: f.batch(section('Render', 'hook: valid\n') + section('Invalid').replace('Remember this rule when testing.', 'TODO'))}), e => {
      assert.match(e.message, /batch line 1:.*flow-map/); assert.match(e.message, /batch line \d+:.*TODO/); return true;
    });
  } finally { fs.readFileSync = original; }
  assert.deepEqual(tree(f.memory), before);
});

test('legacy refusal identifies lesson and restores earlier conversions', t => {
  const f = setup(t); f.lesson('001', '**Again 2026-10-27** first\n');
  const file = f.lesson('002', '**Again 2026-10-27** second\n');
  put(file, read(file).replace(/metadata:\n(?:  .*\n)+/, 'metadata: {type: feedback}\n'));
  const before = tree(f.memory), r = f.cli('repeat', '--from-legacy', '--write');
  assert.equal(r.status, 1); assert.match(r.stderr, /lesson-002-example.md: flow-map metadata/); assert.deepEqual(tree(f.memory), before);
});

test('repeat trims surrounding controls before validation', async t => {
  const f = setup(t), file = f.lesson(), {recordRepeat} = await api();
  recordRepeat({...f, id: '1', note: '\n\t slip: useful note \t\n'});
  assert.deepEqual(data(file).metadata.repeats, [`${date} slip: useful note`]);
});

test('unsafe legacy counts retain digits and require manual recording', t => {
  const f = setup(t), digits = '9'.repeat(400); f.lesson('001', `**Again ${digits} times 2026-10-27** huge\n\n**Again 9007199254740993 times 2026-10-27** unsafe\n`);
  const before = tree(f.memory), result = JSON.parse(ok(f.cli('repeat', '--from-legacy', '--write', '--json')).stdout);
  assert.deepEqual(result.items.map(i => i.count), [digits, '9007199254740993']); assert.equal(result.entries, 0);
  const out = ok(f.cli('repeat', '--from-legacy')).stdout; assert.ok(out.includes(digits)); assert.match(out, /record by hand/); assert.deepEqual(tree(f.memory), before);
});

test('metadata comment is block metadata', async t => {
  const {spliceMetadata} = await api();
  const result = spliceMetadata('---\nname: sample\nmetadata: # comment\n  type: feedback\n---\nBody\n', 'hook', 'new');
  assert.deepEqual(parseFrontmatter(result).data, {name: 'sample', metadata: {type: 'feedback', hook: 'new'}});
  assert.match(result, /metadata:\n  # comment/);
  const f = setup(t), file = f.lesson(), {recordRepeat} = await api();
  put(file, read(file).replace('metadata:', 'metadata: # existing\n  repeats: ["2026-10-26 slip: old"]'));
  recordRepeat({...f, id: '1', note: 'slip: new'});
  assert.deepEqual(data(file).metadata.repeats, ['2026-10-26 slip: old', `${date} slip: new`]);
  for (const eol of ['\n', '\r\n']) {
    const empty = '---\nmetadata: # empty\n---\nBody\n'.replaceAll('\n', eol);
    assert.deepEqual(parseFrontmatter(spliceMetadata(empty, 'hook', 'new')).data.metadata, {hook: 'new'});
  }
});

test('splice preserves sibling and top-level parsed values', async () => {
  const {spliceMetadata} = await api();
  for (const tail of ['  sibling: null\n', 'top: null\n']) {
    const text = `---\nname: sample\nmetadata:\n  hook: old\n${tail}  # boundary\n---\nBody\n`;
    const result = spliceMetadata(text, 'hook', 'new'), before = parseFrontmatter(text).data, after = parseFrontmatter(result).data;
    before.metadata.hook = 'new'; assert.deepEqual(after, before);
  }
});


const repeatSection = (keys = '', body = '') => `## Repeat example\nrepeat-of: 1\ncause: slip\ndescription: did it again\n${keys}\n${body}`;
test('new requires kind, preserves template, validates trigger and keeps stdout path-only', async t => {
  const f = setup(t), {spliceMetadata} = await api();
  const bad = f.cli('new', '--route', 'craft', 'Example');
  assert.equal(bad.status, 1); assert.match(bad.stderr, /kind must be mistake, practice or observation; run: node scripts\/memory\/memory-lesson.mjs new --kind <kind> --route <family> "<title>"/);
  const empty = ok(f.cli('new', '--kind', 'practice', '--route', 'craft', '--trigger', 'before testing', 'Example'));
  const file = path.join(f.memory, 'lesson-001-example.md'); assert.equal(empty.stdout, file + '\n'); assert.match(empty.stderr, /similar: none/);
  const values = {name: 'lesson-001-example', number: '001', title: 'Example', date, route: '["craft"]', pin: 'false', kind: 'practice'};
  assert.equal(read(file), spliceMetadata(read(path.join(kitRoot, 'templates/lesson.md')).replace(/\{\{(\w+)\}\}/g, (_, k) => values[k]), 'trigger', 'before testing'));
  const next = ok(f.cli('new', '--kind', 'observation', '--route', 'craft', 'Example'));
  assert.equal(next.stdout, path.join(f.memory, 'lesson-002-example.md') + '\n'); assert.match(next.stderr, /similar:\n  #001 Example \([\d.]+\)/);
  assert.match(next.stderr, /repeat <id> "<cause>: <note>"/);
  const {similarLessons} = await api(), {buildCorpus} = await import('../engine/memory-recall.mjs');
  f.lesson('003'); f.lesson('004'); f.lesson('005');
  const corpus = buildCorpus(f), matches = similarLessons({corpus, query: 'Example', exclude: ['001', 'lesson-002-example.md']});
  assert.equal(matches.length, 3); assert.deepEqual(new Set(matches.map(x => x.id)), new Set(['003', '004', '005']));
  assert.deepEqual(similarLessons({corpus: corpus.map(d => ({...d, source: 'brain'})), query: 'Example'}), []);
  for (const trigger of ['x'.repeat(201), 'two\nlines']) assert.equal(f.cli('new', '--kind', 'practice', '--route', 'craft', '--trigger', trigger, 'Bad').status, 1);
});
test('mixed batch allocates only creations and reports repeats and similar JSON', t => {
  const f = setup(t), old = f.lesson();
  const file = f.batch(section('Example practice').replace('kind: mistake', 'kind: practice') + repeatSection() + section('Another'));
  const dry = ok(f.cli('batch', file, '--dry-run')); assert.match(dry.stdout, /would repeat #001/); assert.match(dry.stderr, /similar to "Example practice":/);
  const result = JSON.parse(ok(f.cli('batch', file, '--json')).stdout);
  assert.deepEqual(result.created.map(x => x.file), ['lesson-002-example-practice.md', 'lesson-003-another.md']);
  assert.ok(result.created[0].similar.length > 0); assert.equal(result.pages, 2);
  assert.deepEqual(result.repeated, [{file: path.basename(old), repeats: 1}]);
  assert.deepEqual(data(old).metadata.repeats, [`${date} slip: did it again`]);
  assert.match(read(path.join(f.memory, 'INDEX-craft.md')), /\(practice\)/);
});
test('invalid repeat sections and missing batch kind are atomic', t => {
  const f = setup(t); f.lesson();
  for (const text of [repeatSection('', 'Body'), repeatSection('route: craft\n'), repeatSection().replace('cause: slip\n', ''), section('Missing').replace('kind: mistake\n', '')]) {
    const before = tree(f.memory), r = f.cli('batch', f.batch(text)); assert.equal(r.status, 1); assert.match(r.stderr, /batch line/); assert.deepEqual(tree(f.memory), before);
  }
});
test('batch keeps enforcement FAIL but rolls back other affected FAIL and thrown repeat writes', async t => {
  const f = setup(t), old = f.lesson(), {batchLessons, recordRepeat} = await api();
  const {counts} = await import('../engine/memory-check.mjs');
  for (let i = 0; i < 3; i++) recordRepeat({...f, id: '1', note: 'slip: again'});
  const file = f.batch(section('Created') + repeatSection()); let checks = 0;
  // The gate supplies the real check. Inject only its result; exercise the actual transaction.
  const originalWrite = fs.writeFileSync; let pageWrites = 0, locks = 0, result;
  fs.writeFileSync = (name, ...args) => {
    if (path.basename(String(name)).startsWith('INDEX-')) pageWrites++;
    if (path.basename(String(name)) === '.memory.lock') locks++;
    return originalWrite(name, ...args);
  };
  try { result = batchLessons({...f, file, check() { checks++; return {findings: [{check: 'lesson.enforce', severity: 'FAIL', file: path.basename(old), message: 'four repeats'}]}; }}); }
  finally { fs.writeFileSync = originalWrite; }
  assert.equal(pageWrites, 2); assert.equal(locks, 1);
  assert.equal(checks, 1); assert.equal(result.rolledBack, undefined); assert.equal(result.findings[0].severity, 'FAIL'); assert.equal(counts(result).FAIL, 1); assert.equal(data(old).metadata.repeats.length, 4); assert.equal(result.created.length, 1);
  const before = tree(f.memory);
  assert.throws(() => batchLessons({...f, file, afterWrite(n) { if (n === 2) throw Error('after repeat'); }}), /after repeat/); assert.deepEqual(tree(f.memory), before);
  const rejected = batchLessons({...f, file, check: () => ({findings: [{check: 'lesson.repeats', severity: 'FAIL', file: path.basename(old), message: 'invalid'}]})});
  assert.equal(rejected.rolledBack, true); assert.deepEqual(tree(f.memory), before);
});
test('causes and exact second and fourth escalation sentences', async t => {
  const f = setup(t), file = f.lesson(), {enforceSentence, failSentence} = await import('../engine/memory-index.mjs');
  assert.equal(enforceSentence({count: 2, last: date, id: '001'}), `repeated 2 times (last ${date}); decide where the mistake is visible: in the command (hook), in a file (check), or only in judgment (hard-rule card or lesson-only), then run memory-lesson.mjs enforce 001 "<hook|check|hard-rule|lesson-only> <where>"`);
  assert.equal(failSentence({count: 4, id: '001'}), 'repeated 4 times with no recorded decision; record one with memory-lesson.mjs enforce 001 "<hook|check|hard-rule|lesson-only> <where>" (lesson-only with a reason counts)');
  for (const note of ['did it again', 'legacy: again', 'slip:']) { const before = tree(f.memory); assert.equal(f.cli('repeat', '1', note).status, 1); assert.deepEqual(tree(f.memory), before); }
  ok(f.cli('repeat', '1', 'slip: did it again'));
  const second = ok(f.cli('repeat', '1', 'not-recalled: again')); assert.ok(second.stdout.includes(enforceSentence({count: 2, last: date, id: '001'})));
  ok(f.cli('repeat', '1', 'rule-wrong: again')); const fourth = ok(f.cli('repeat', '1', 'new-case: again')); assert.ok(fourth.stdout.includes(failSentence({count: 4, id: '001'})));
  assert.equal(data(file).metadata.repeats[0], `${date} slip: did it again`);
  const legacy = f.lesson('002', `**Recurred twice on ${date}:** ${'long '.repeat(100)}\n`);
  ok(f.cli('repeat', '--from-legacy', '--write'));
  assert.ok(data(legacy).metadata.repeats.every(e => e.length <= 200 && e.startsWith(`${date} legacy: `)));
  const converted = tree(f.memory); ok(f.cli('repeat', '--from-legacy', '--write')); assert.deepEqual(tree(f.memory), converted);
  put(file, read(file).replace('slip: did it again', 'no cause')); const malformed = tree(f.memory);
  assert.match(f.cli('repeat', '1', 'slip: again').stderr, /repeat entries must read/); assert.deepEqual(tree(f.memory), malformed);
});
test('classify validates all entries, dry runs, writes kinds and preserves BOM', async t => {
  const f = setup(t), one = f.lesson(), two = f.lesson('002'); put(one, '\uFEFF' + read(one));
  const file = f.batch(JSON.stringify({version: 1, kinds: {[path.basename(one)]: 'practice', [path.basename(two)]: 'observation'}}), 'kinds.json');
  const before = tree(f.memory), dry = ok(f.cli('classify', file)); assert.match(dry.stdout, /classify: 2 lessons \(mistake 0, practice 1, observation 1\); 0 unchanged/); assert.deepEqual(tree(f.memory), before);
  ok(f.cli('classify', file, '--write')); assert.equal(data(one).metadata.kind, 'practice'); assert.ok(read(one).startsWith('\uFEFF')); assert.match(read(path.join(f.memory, 'INDEX-craft.md')), /\(observed\)/);
  assert.match(ok(f.cli('classify', file)).stdout, /2 unchanged/);
  const {classifyLessons} = await api();
  put(file, JSON.stringify({version: 1, kinds: {[path.basename(one)]: 'mistake', [path.basename(two)]: 'mistake'}}));
  put(path.join(f.memory, 'INDEX-craft-all.md'), '# Hand page\n');
  const rollback = tree(f.memory); assert.throws(() => classifyLessons({...f, file, write: true}), /refusing to overwrite/); assert.deepEqual(tree(f.memory), rollback);
  const after = tree(f.memory); for (const kinds of [{missing: 'practice'}, {[path.basename(one)]: 'unknown'}]) { put(file, JSON.stringify({version: 1, kinds})); assert.equal(f.cli('classify', file, '--write').status, 1); assert.deepEqual(tree(f.memory), after); }
});

test('rollback attempts originals and creations after page restore fails', async t => {
  const f = setup(t), old = f.lesson(), before = tree(f.memory), {batchLessons} = await api();
  const original = fs.writeFileSync; let restoring = false;
  try {
    fs.writeFileSync = (file, ...args) => { if (restoring && path.basename(String(file)) === 'INDEX-craft.md') throw Error('page restore injected'); return original(file, ...args); };
    assert.throws(() => batchLessons({...f, file: f.batch(section('Created') + repeatSection()), afterWrite(n) { if (n === 2) { restoring = true; throw Error('transaction injected'); } }}), /transaction injected; rollback failed: page restore injected/);
  } finally { fs.writeFileSync = original; }
  assert.deepEqual(tree(f.memory), before);
});

test('batch similar labels creations and omits repeats and empty hints', t => {
  const f = setup(t); f.lesson();
  const r = ok(f.cli('batch', f.batch(section('Example practice') + section('Example observation') + repeatSection()), '--dry-run'));
  assert.match(r.stderr, /similar to "Example practice":/); assert.match(r.stderr, /similar to "Example observation":/);
  assert.equal((r.stderr.match(/similar to/g) ?? []).length, 2);
  const file = f.batch(repeatSection()), repeat = ok(f.cli('batch', file));
  assert.equal(repeat.stderr, ''); assert.ok(repeat.stdout.startsWith(`batch: 0 lessons from ${file}\n  repeat #001:`));
});

test('new hints only for matches and excludes TODO from query', t => {
  const f = setup(t);
  assert.equal(ok(f.cli('new', '--kind', 'practice', '--route', 'craft', 'Unique')).stderr, 'similar: none\n');
  const matched = ok(f.cli('new', '--kind', 'practice', '--route', 'craft', 'Unique'));
  assert.match(matched.stderr, /delete the new file, then use: memory-lesson.mjs repeat <id> "<cause>: <note>"/);
  assert.equal(ok(f.cli('new', '--kind', 'practice', '--route', 'craft', 'Zyxwv')).stderr, 'similar: none\n');
});

test('classify splice error identifies lesson and restores bytes', t => {
  const f = setup(t), one = f.lesson(), two = f.lesson('002');
  put(two, read(two).replace(/metadata:\n(?:  .*\n)+/, 'metadata: {type: feedback}\n'));
  const before = tree(f.memory), file = f.batch(JSON.stringify({version: 1, kinds: {[path.basename(one)]: 'practice', [path.basename(two)]: 'practice'}}));
  const r = f.cli('classify', file, '--write'); assert.equal(r.status, 1);
  assert.match(r.stderr, /lesson-002-example.md: flow-map metadata/); assert.deepEqual(tree(f.memory), before);
});

test('classify refuses inside memory and collects nonlesson and kind errors', t => {
  const f = setup(t); f.lesson(); put(path.join(f.memory, 'notes.md'), '# Notes\n');
  const spec = JSON.stringify({version: 1, kinds: {}}), inside = put(path.join(f.memory, 'kinds.json'), spec);
  assert.match(f.cli('classify', inside, '--write').stderr, /classify file must not be inside the memory folder/);
  const before = tree(f.memory), r = f.cli('classify', f.batch(JSON.stringify({version: 1, kinds: {'notes.md': 'practice', missing: 'bogus'}})), '--write');
  assert.equal(r.status, 1); assert.match(r.stderr, /classify notes.md: not a lesson file/); assert.match(r.stderr, /classify missing:.*\n.*classify missing: kind must/); assert.deepEqual(tree(f.memory), before);
});

test('two repeats of one lesson roll back to first snapshot on gate FAIL', async t => {
  const f = setup(t), old = f.lesson(), before = tree(f.memory), {batchLessons} = await api();
  const r = batchLessons({...f, file: f.batch(repeatSection() + repeatSection().replace('Repeat example', 'Second repeat')), check: () => ({findings: [{check: 'lesson.repeats', severity: 'FAIL', file: path.basename(old), message: 'injected'}]})});
  assert.equal(r.rolledBack, true); assert.deepEqual(tree(f.memory), before);
});

for (const style of ['BOM', 'CRLF']) test(`batch repeat preserves ${style} lesson content`, t => {
  const f = setup(t), file = f.lesson('001', 'Useful body.\n', style === 'CRLF' ? '\r\n' : '\n');
  if (style === 'BOM') put(file, '\uFEFF' + read(file));
  const before = read(file); ok(f.cli('batch', f.batch(repeatSection())));
  assert.deepEqual(data(file).metadata.repeats, [`${date} slip: did it again`]);
  assert.equal(read(file).replace(/^  repeats:\r?\n    - .*\r?\n/m, ''), before);
});

test('batch rejects bogus kind and long or multiline trigger atomically', t => {
  const f = setup(t), before = tree(f.memory);
  for (const text of [section('Bad').replace('kind: mistake', 'kind: bogus'), section('Bad', `trigger: "${'x'.repeat(201)}"\n`), section('Bad', 'trigger: "two\\nlines"\n')]) {
    const r = f.cli('batch', f.batch(text)); assert.equal(r.status, 1); assert.match(r.stderr, /batch line 1: (kind|trigger) must/); assert.deepEqual(tree(f.memory), before);
  }
});

test('CLI cannot inject check to bypass batch gate', t => {
  const f = setup(t), before = tree(f.memory), r = f.cli('batch', f.batch(section('Broken', 'hook: "[Missing](missing.md)"\n')), '--check', 'ignored');
  assert.equal(r.status, 1); assert.match(r.stdout, /FAIL link.dead/); assert.match(r.stdout, /rolled back/); assert.deepEqual(tree(f.memory), before);
});

test('batch dates and classify JSON syntax have contextual diagnostics', t => {
  const f = setup(t); f.lesson();
  for (const text of [section('Bad', 'date: yesterday\n'), repeatSection('date: yesterday\n')]) assert.match(f.cli('batch', f.batch(text)).stderr, /batch line 1: date must be YYYY-MM-DD/);
  const file = f.batch('{broken', 'bad.json'), r = f.cli('classify', file);
  assert.equal(r.status, 1); assert.ok(r.stderr.includes(file + ': invalid JSON:'));
});

test('kind splice is unquoted and whitespace trigger is refused', async t => {
  const {spliceMetadata} = await api(); assert.match(spliceMetadata('---\nmetadata:\n  type: feedback\n---\n', 'kind', 'practice'), /^  kind: practice$/m);
  const f = setup(t), before = tree(f.memory), r = f.cli('new', '--kind', 'practice', '--route', 'craft', '--trigger', '   ', 'Bad');
  assert.equal(r.status, 1); assert.match(r.stderr, /trigger must/); assert.deepEqual(tree(f.memory), before);
});

for (const step of ['original write', 'created unlink']) test(`batch retries one-shot ${step} and restores every byte`, async t => {
  const f = setup(t), old = f.lesson(), {batchLessons} = await api();
  writeMemoryIndex(f);
  const before = tree(f.memory), file = f.batch(section('Created') + repeatSection());
  const method = step === 'original write' ? 'writeFileSync' : 'unlinkSync', original = fs[method];
  const target = step === 'original write' ? old : path.join(f.memory, 'lesson-002-created.md');
  const failure = Error('check injected'); let armed = false, attempts = 0, caught;
  try {
    fs[method] = (name, ...args) => {
      if (armed && name === target && ++attempts === 1) throw Error(`${step} injected`);
      return original(name, ...args);
    };
    try { batchLessons({...f, file, check() {
      assert.notDeepEqual(tree(f.memory), before);
      armed = true; throw failure;
    }}); } catch (error) { caught = error; }
  } finally { fs[method] = original; }
  assert.deepEqual(tree(f.memory), before);
  assert.equal(attempts, 2);
  assert.equal(caught, failure);
  assert.equal(caught.message, 'check injected');
});

test('rollback reports persistent steps once with both attempts and omits recovered steps', async t => {
  const f = setup(t), old = f.lesson(), {batchLessons} = await api();
  writeMemoryIndex(f);
  const file = f.batch(section('Created') + repeatSection()), original = fs.writeFileSync;
  const failure = Error('check injected'); let armed = false, pageAttempts = 0, lessonAttempts = 0;
  try {
    fs.writeFileSync = (name, ...args) => {
      if (armed && path.basename(name) === 'INDEX-craft.md') throw Error(`page restore attempt ${++pageAttempts}`);
      if (armed && name === old && ++lessonAttempts === 1) throw Error('original restore recovered');
      return original(name, ...args);
    };
    assert.throws(() => batchLessons({...f, file, check() { armed = true; throw failure; }}), error => {
      assert.equal(error.message, 'check injected; rollback failed: page restore attempt 1 (retry failed: page restore attempt 2)');
      assert.equal(error.cause, failure);
      return true;
    });
  } finally { fs.writeFileSync = original; }
  assert.equal(pageAttempts, 2);
  assert.equal(lessonAttempts, 2);
  assert.equal(data(old).metadata.repeats, undefined);
  assert.equal(fs.existsSync(path.join(f.memory, 'lesson-002-created.md')), false);
});

// Exercise installed CLI parsing and the existing comma normalization together.
function routeSetup(t) {
  const f = setup(t);
  put(path.join(f.memory, 'MEMORY.md'), '# Memory\n' + ['craft-shipping', 'craft-sessions', 'craft-testing'].map(name => '- [' + name + '](INDEX-' + name + '.md) OPEN BEFORE testing.\n').join(''));
  writeMemoryIndex(f);
  return f;
}
for (const [label, flags, expected] of [
  ['repeated', ['--route', 'craft-shipping', '--route', 'craft-sessions'], ['craft-shipping', 'craft-sessions']],
  ['comma', ['--route', 'craft-shipping,craft-sessions'], ['craft-shipping', 'craft-sessions']],
  ['mixed deduplicated', ['--route', 'craft-shipping', '--route', 'craft-sessions,craft-testing,craft-shipping'], ['craft-shipping', 'craft-sessions', 'craft-testing']],
]) test('route fix new ' + label, t => {
  const f = routeSetup(t);
  ok(f.cli('new', '--kind', 'practice', ...flags, 'Routes'));
  assert.deepEqual(data(path.join(f.memory, 'lesson-001-routes.md')).metadata.route, expected);
});
for (const flags of [
  ['--route', 'missing', '--route', 'craft-shipping'],
  ['--route', 'missing,craft-shipping'],
]) test('route fix unknown ' + flags.join(' '), t => {
  const f = routeSetup(t), before = tree(f.memory);
  const r = f.cli('new', '--kind', 'practice', ...flags, 'Unknown');
  assert.equal(r.status, 1); assert.match(r.stderr, /route.unknown: missing,craft-shipping; known families:/);
  assert.deepEqual(tree(f.memory), before);
});
for (const [key, values] of [['kind', ['practice', 'observation']], ['trigger', ['before shipping', 'before testing']]]) test('route fix duplicate ' + key, t => {
  const f = routeSetup(t), before = tree(f.memory);
  const flags = key === 'kind' ? [] : ['--kind', 'practice'];
  const r = f.cli('new', ...flags, '--route', 'craft-shipping', '--' + key, values[0], '--' + key, values[1], 'Duplicate');
  assert.equal(r.status, 1); assert.equal(r.stderr, 'memory-lesson: --' + key + ' given twice\n');
  assert.deepEqual(tree(f.memory), before);
});
test('route fix repeated today keeps last value', t => {
  const f = routeSetup(t);
  ok(f.cli('new', '--kind', 'practice', '--route', 'craft-shipping', '--today', '2026-10-28', 'Today'));
  assert.equal(data(path.join(f.memory, 'lesson-001-today.md')).metadata.date, '2026-10-28');
});
test('route fix batch repeated default route', t => {
  const f = routeSetup(t);
  const file = f.batch(section('Batch routes').replace('route: craft\n', ''));
  ok(f.cli('batch', file, '--route', 'craft-shipping', '--route', 'craft-sessions'));
  assert.deepEqual(data(path.join(f.memory, 'lesson-001-batch-routes.md')).metadata.route, ['craft-shipping', 'craft-sessions']);
});
