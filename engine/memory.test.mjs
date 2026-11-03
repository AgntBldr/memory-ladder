import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import config from './selftest-config.mjs';

// Run all imports and CLI children beside fixture config, never host config or receipts.
const source=path.dirname(fileURLToPath(import.meta.url));
const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'memory-selftest-'));
for(const entry of fs.readdirSync(source,{withFileTypes:true})) {
  if(entry.isFile()&&(entry.name.endsWith('.mjs')||['README.md','recall-probes.json','upgrades.json'].includes(entry.name)))
    fs.copyFileSync(path.join(source,entry.name),path.join(runtime,entry.name));
}
fs.writeFileSync(path.join(runtime,'memory.config.json'),JSON.stringify(config));
const templates=fs.existsSync(path.join(source,'templates'))?path.join(source,'templates'):path.join(source,'../templates');
if(fs.existsSync(templates)) fs.cpSync(templates,path.join(runtime,'templates'),{recursive:true});
const saved=process.env.CLAUDE_MEMORY_DIR;
delete process.env.CLAUDE_MEMORY_DIR;
process.once('exit',()=>{
  if(saved!==undefined) process.env.CLAUDE_MEMORY_DIR=saved;
  fs.rmSync(runtime,{recursive:true,force:true});
});
const {default: test} = await import('node:test');
const {default: assert} = await import('node:assert/strict');
const {execFileSync} = await import('node:child_process');
const {handoverFiles} = await import(pathToFileURL(path.join(runtime, 'lib.mjs')).href);
const {runCheck, stagedCheck} = await import(pathToFileURL(path.join(runtime, 'memory-check.mjs')).href);
const {rotateHandovers} = await import(pathToFileURL(path.join(runtime, 'memory-rotate.mjs')).href);
const {checkpoint} = await import(pathToFileURL(path.join(runtime, 'memory-checkpoint.mjs')).href);
function notesFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-test-')), repo = path.join(root, 'project'), memoryDir = path.join(root, 'memory');
  fs.mkdirSync(repo); fs.mkdirSync(memoryDir);
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const put = (name, text) => { const file = path.join(memoryDir, name); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, text); return file; };
  const note = (seq, text = '', time = '2026-01-01T12:00:00+00:00') => put(`handovers/${String(seq).padStart(6, '0')}-2026-01-01-1200.md`, `---\ntime: ${time}\nbranch: topic\nsha: abcdefa\nmode: full\n---\n**Open question:** none\n${text}`);
  const git = (dir, ...argv) => execFileSync('git', ['-C', dir, ...argv], {encoding: 'utf8', stdio: 'pipe'});
  put('MEMORY.md', '# Memory\n');
  return {root, repo, memoryDir, config: structuredClone(config), put, note, git};
}
const noteFindings = f => runCheck({...f, noGit: true, scope: 'memory'}).findings.filter(x => x.file.startsWith('handovers/'));
const noteSnapshot = dir => Object.fromEntries(fs.readdirSync(dir, {recursive: true, withFileTypes: true}).filter(e => e.isFile()).map(e => { const file = path.join(e.parentPath, e.name); return [path.relative(dir, file), fs.readFileSync(file).toString('base64')]; }));

test('T13 raw note scalar strings pass the gate', t => {
  const f = notesFixture(t);
  for (const [i, branch] of ['1.5', 'true', '123'].entries()) {
    const file = f.note(i + 1);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('branch: topic', 'branch: ' + branch).replace('sha: abcdefa', 'sha: 0123456'));
    const note = handoverFiles(f.memoryDir).at(-1);
    assert.equal(note.data.branch, branch); assert.equal(note.data.sha, '0123456'); assert.equal(note.valid, true);
    assert.deepEqual(noteFindings(f), []);
  }
});
test('T13 rotation appends each archive batch in ascending seq order', t => {
  const f = notesFixture(t);
  for (let i = 1; i <= 6; i++) f.note(i, 'body ' + i, i % 2 ? '2026-01-01T12:00:00Z' : '2026-02-01T12:00:00Z');
  rotateHandovers({...f, keep: 1, write: true});
  for (const [month, seqs] of [['01', ['000001', '000003', '000005']], ['02', ['000002', '000004']]]) {
    const text = fs.readFileSync(path.join(f.memoryDir, `handovers/archive-2026-${month}.md`), 'utf8');
    assert.deepEqual([...text.matchAll(/^## (\d{6})-/gm)].map(m => m[1]), seqs);
  }
});

test('T13 no folder and valid note are clean; listing never throws', t => {
  const f = notesFixture(t); assert.deepEqual(handoverFiles(f.memoryDir), []); assert.deepEqual(noteFindings(f), []);
  f.note(1); assert.deepEqual(noteFindings(f), []);
  const file = f.note(2); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('sha: abcdefa', 'sha: 0000001').replace('branch: topic', 'branch: 123')); assert.deepEqual(noteFindings(f), []);
  for (const dir of [null, undefined, '\0', path.join(f.root, 'missing')]) assert.doesNotThrow(() => handoverFiles(dir));
});
test('T13 malformed unreadable directory and NUL notes are findings', t => {
  const f = notesFixture(t), file = f.note(1);
  fs.writeFileSync(file, '\0'); assert.ok(noteFindings(f).some(x => x.check === 'handover.frontmatter'));
  fs.unlinkSync(file); fs.mkdirSync(file); assert.ok(noteFindings(f).some(x => x.check === 'handover.read'));
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => { if (String(file).includes('handovers')) throw Error('denied'); return read(file, ...args); });
  assert.doesNotThrow(() => handoverFiles(f.memoryDir)); assert.ok(noteFindings(f).some(x => x.check === 'handover.read'));
});
for (const field of ['time', 'branch', 'sha', 'mode']) for (const missing of [true, false]) test(`T13 ${field} ${missing ? 'missing' : 'bad'} fails`, t => {
  const f = notesFixture(t), file = f.note(1), text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace(new RegExp('^' + field + ':.*\\n', 'm'), missing ? '' : field + ': ' + ({time: '2026-02-30T12:00:00+00:00', branch: '[]', sha: 'no', mode: 'other'}[field]) + '\n'));
  assert.ok(noteFindings(f).some(x => x.check === 'handover.frontmatter' && x.severity === 'FAIL'));
  if (field === 'sha') { fs.writeFileSync(file, text.replace('sha: abcdefa', 'sha: [abcdefa]')); assert.ok(noteFindings(f).some(x => x.check === 'handover.frontmatter')); }
});
test('T13 loose size thresholds and count use defaults', t => {
  const f = notesFixture(t);
  for (const [length, severity] of [[3200, 'WARN'], [6200, 'FAIL']]) {
    f.note(1, 'x'.repeat(length)); assert.ok(noteFindings(f).some(x => x.check === 'handover.size' && x.severity === severity));
  }
  for (let i = 1; i <= 41; i++) f.note(i);
  assert.ok(noteFindings(f).some(x => x.check === 'handover.count' && x.severity === 'WARN'));
});
for (const length of [4000, 7000, 102401]) test(`T13 archive ${length} is a container with WARN-only size`, t => {
  const f = notesFixture(t); f.put('handovers/archive-2026-01.md', 'x'.repeat(length));
  const findings = noteFindings(f);
  assert.deepEqual(findings.map(x => [x.check, x.severity]), length > 102400 ? [['handover.archive-size', 'WARN']] : []);
});
test('T13 stray warns', t => { const f = notesFixture(t); f.put('handovers/other.md', 'stray'); assert.ok(noteFindings(f).some(x => x.check === 'handover.stray' && x.severity === 'WARN')); });
for (const kind of ['note', 'archive', 'stray']) for (const fallback of [false, true]) test(`T13 secret ${kind} ${fallback ? 'fallback' : 'main'} scan fails`, t => {
  const f = notesFixture(t), secret = 'sk-' + 'A'.repeat(40);
  if (kind === 'note') f.note(1, secret); else f.put(`handovers/${kind === 'archive' ? 'archive-2026-01' : 'other'}.md`, secret);
  if (!fallback) assert.ok(noteFindings(f).some(x => x.check === 'secret' && x.severity === 'FAIL'));
  else {
    f.git(f.memoryDir, 'init'); f.git(f.memoryDir, 'add', '.');
    assert.throws(() => stagedCheck({...f, scope: 'invalid', hook: true, noGit: true}), error => error.code === 'STAGED_SECRET' && error.secretFindings.some(x => x.file.startsWith('handovers/')));
  }
});
test('T13 rotation uses seq, conserves bytes and keeps newest even with keep zero', t => {
  const f = notesFixture(t);
  for (let i = 1; i <= 21; i++) f.note(i, 'body ' + i, i === 1 ? '2026-02-01T12:00:00+00:00' : '2026-01-01T12:00:00+00:00');
  const oldest = path.join(f.memoryDir, 'handovers/000001-2026-01-01-1200.md'), raw = fs.readFileSync(oldest);
  const before = noteSnapshot(f.memoryDir); assert.equal(rotateHandovers({...f}).moved, 1); assert.deepEqual(noteSnapshot(f.memoryDir), before);
  assert.equal(rotateHandovers({...f, write: true}).moved, 1);
  assert.ok(!fs.existsSync(oldest));
  assert.ok(fs.readFileSync(path.join(f.memoryDir, 'handovers/archive-2026-02.md')).equals(Buffer.concat([Buffer.from('## 000001-2026-01-01-1200.md\n'), raw, Buffer.from('\n\n')])));
  assert.equal(rotateHandovers({...f, keep: 0, write: true}).kept, 1);
  assert.ok(fs.existsSync(path.join(f.memoryDir, 'handovers/000021-2026-01-01-1200.md')));
});
test('T13 interrupted rotation resumes once and refuses different archived bytes', t => {
  const f = notesFixture(t), oldest = f.note(1, 'old\r\n'); f.note(2);
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', file => { if (file === oldest) throw Error('interrupted'); return unlink(file); });
  assert.throws(() => rotateHandovers({...f, keep: 1, write: true}), /interrupted/);
  const archive = path.join(f.memoryDir, 'handovers/archive-2026-01.md'), saved = fs.readFileSync(archive);
  t.mock.restoreAll(); rotateHandovers({...f, keep: 1, write: true}); assert.ok(fs.readFileSync(archive).equals(saved)); assert.ok(!fs.existsSync(oldest));
  f.note(1, 'different'); assert.throws(() => rotateHandovers({...f, keep: 1, write: true}), /differs/); assert.ok(fs.existsSync(oldest));
});
test('T13 archive verification precedes removal and dry run writes nothing', t => {
  const f = notesFixture(t), oldest = f.note(1); f.note(2);
  const before = noteSnapshot(f.memoryDir); rotateHandovers({...f, keep: 1, write: true, dryRun: true}); assert.deepEqual(noteSnapshot(f.memoryDir), before);
  execFileSync(process.execPath, [path.join(runtime, 'memory-rotate.mjs'), 'handovers', '--repo', f.repo, '--memory-dir', f.memoryDir, '--keep', '1', '--write', '--dry-run'], {stdio: 'pipe'});
  assert.deepEqual(noteSnapshot(f.memoryDir), before);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => { if (String(to).includes('archive-')) { fs.writeFileSync(to, 'corrupt'); return; } return rename(from, to); });
  assert.throws(() => rotateHandovers({...f, keep: 1, write: true}), /verification/); assert.ok(fs.existsSync(oldest));
});
for (const inRepo of [false, true]) test(`T13 checkpoint stages handovers in ${inRepo ? 'in-repo' : 'separate'} layout`, t => {
  const f = notesFixture(t);
  if (inRepo) { fs.renameSync(f.memoryDir, path.join(f.repo, 'memory')); f.memoryDir = path.join(f.repo, 'memory'); }
  const dir = inRepo ? f.repo : f.memoryDir; f.git(dir, 'init');
  const note = path.join(f.memoryDir, 'handovers/000001-2026-01-01-1200.md'); fs.mkdirSync(path.dirname(note)); fs.writeFileSync(note, '---\ntime: 2026-01-01T12:00:00+00:00\nbranch: topic\nsha: abcdefa\nmode: full\n---\n');
  const calls = [];
  checkpoint({...f, commit: true, noPush: true, report: () => {}, git: argv => { calls.push(argv); if (argv[0] === 'add') return f.git(dir, ...argv); return ''; }});
  assert.ok(calls.some(args => args[0] === 'add')); assert.match(f.git(dir, 'ls-files'), /handovers\/000001-/);
});
await import(pathToFileURL(path.join(runtime,'memory-selftest-cases.mjs')).href);
