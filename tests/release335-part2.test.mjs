// Kit 3.3.5 Part 2a: R1 (roadmap procedures and the no-rotation warning), R2 (hot-page reserve and router target) and
// F1's gate change (the overview comparison ignores CRLF exactly as roadmap-overview --check does).
// Written red first against the Part 2 base: every test here failed there, except R1-T9 (a deleted history file is
// recreated), R2-T10c (a page with nothing in it stays quiet), F1-T21 (a real difference stays a WARN) and F1-T24 (an
// unreadable overview stays an error), which pin behaviour that already held, or a degenerate case that must stay quiet. Each group names the one-token changes to its guard (mutants) that
// make a test in it fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {kitRoot, read, json, put, hash} from './helpers.mjs';
import defaults from '../engine/selftest-config.mjs';
import {runCheck} from '../engine/memory-check.mjs';
import {rotateRoadmap} from '../engine/memory-rotate.mjs';
import {generateMemoryIndex, writeMemoryIndex} from '../engine/memory-index.mjs';
import {generateOverview, overviewFresh} from '../engine/roadmap-overview.mjs';
import {ownedFiles, installedPath} from '../scripts/manifest.mjs';
import {NEW_CHECKS} from '../scripts/upgrade.mjs';

const today = '2026-11-12';
const NEW_IDS = ['repo.roadmap-no-rotation', 'repo.roadmap-rotation', 'config.roadmap-procedure', 'index.hot-reserve', 'router.target'];

// A repo folder and a memory folder in one temp root, the gate run over both (repo layer included).
function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'part2-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const memoryDir = path.join(root, 'memory'), repo = path.join(root, 'repo');
  fs.mkdirSync(memoryDir); fs.mkdirSync(repo);
  const config = structuredClone(defaults);
  config.caps.roadmapOverview.enabled = false;
  config.caps.roadmap.warnBytes = 1000; config.caps.roadmap.failBytes = 100000;
  put(path.join(memoryDir, 'MEMORY.md'), '# Memory\n');
  const f = {root, memoryDir, repo, config};
  f.put = (rel, text, base = repo) => put(path.join(base, rel), text);
  f.check = (extra = {}) => runCheck({memoryDir, repo, config, today, noGit: true, scope: 'all', ...extra});
  f.hits = (id, extra) => f.check(extra).findings.filter(x => x.check === id);
  f.ids = extra => f.check(extra).findings.map(x => x.check);
  f.roadmapPath = () => path.join(repo, config.caps.roadmap.path);
  f.historyPath = () => path.join(repo, config.caps.roadmapHistory.path);
  return f;
}
// Every file under a folder: bytes and modification time, so a touch shows as well as a write.
function snapshot(dir) {
  const out = {};
  for (const e of fs.readdirSync(dir, {recursive: true, withFileTypes: true})) if (e.isFile()) {
    const file = path.join(e.parentPath, e.name);
    out[path.relative(dir, file).replaceAll('\\', '/')] = [fs.readFileSync(file).toString('base64'), fs.statSync(file).mtimeMs];
  }
  return out;
}
const block = (date, size = 400) => `**${date} block ${date}**\n${'x'.repeat(size)}\n\n`;
const roadmap = (...blocks) => `# Roadmap\n\n## Open work\n\n${blocks.join('')}`;
const severities = hits => hits.map(x => x.severity);

// ---------------------------------------------------------------- R1: repo.roadmap-no-rotation
// Mutants: `roadmapBytes > warnBytes` to `>=` (T2); `!(plan.bytesRemoved > 0)` to `>= 0` (T1, T2, T3, T4, T5, T7) or
// without the `!` (T1, T3, T4); `write: false` to `write: true` (T5); `order !== undefined` to `===` (T1 to T7); the
// planner-refusal id changed to the warning's id (T6); procedure cut `200` to `300` (T7), its type guard `!==` to `===`
// (T7); a misspelt id in the memory-scope list (T8); the planner's `slice(0` to `slice(1` (T9); ROADMAPS left out of the
// owned-file pattern (T18); the invalid-procedure id's severity WARN to FAIL (T7, T15).

test('R1-T1 a roadmap with no Open work section over warnBytes warns, and repo.roadmap keeps its own size WARN', t => {
  const f = setup(t);
  f.put(f.config.caps.roadmap.path, '# Roadmap\n\nNo dated blocks here.\n' + 'y'.repeat(1200) + '\n');
  const [warn] = f.hits('repo.roadmap-no-rotation');
  assert.ok(warn, 'repo.roadmap-no-rotation emitted');
  assert.equal(warn.severity, 'WARN');
  assert.equal(warn.file, f.config.caps.roadmap.path);
  assert.equal(warn.value, fs.statSync(f.roadmapPath()).size);
  assert.match(warn.message, /rotation has nothing it may move/);
  assert.match(warn.message, /ROADMAPS\.md/);
  assert.match(warn.message, /caps\.roadmap\.procedure/);
  assert.deepEqual(severities(f.hits('repo.roadmap')), ['WARN']);
  assert.equal(f.hits('repo.roadmap-rotation').length, 0);
});

test('R1-T2 boundary: exactly warnBytes is quiet, one byte over warns (no Open work, nothing to rotate)', t => {
  const f = setup(t), warnBytes = f.config.caps.roadmap.warnBytes;
  const filled = n => '# Roadmap\n\n' + 'y'.repeat(n - 11);
  f.put(f.config.caps.roadmap.path, filled(warnBytes));
  assert.equal(fs.statSync(f.roadmapPath()).size, warnBytes);
  assert.deepEqual(f.ids().filter(id => id.startsWith('repo.roadmap')), []);
  f.put(f.config.caps.roadmap.path, filled(warnBytes + 1));
  assert.equal(fs.statSync(f.roadmapPath()).size, warnBytes + 1);
  assert.deepEqual(f.ids().filter(id => id.startsWith('repo.roadmap')).sort(), ['repo.roadmap', 'repo.roadmap-no-rotation']);
  // No roadmap file at all: nothing to size, nothing to plan.
  fs.rmSync(f.roadmapPath());
  assert.deepEqual(f.ids().filter(id => id.startsWith('repo.roadmap')), []);
});

test('R1-T3 four blocks with keepBlocks 6 over warnBytes are rotatable: repo.roadmap warns, no-rotation does not', t => {
  const f = setup(t);
  assert.equal(f.config.caps.roadmap.keepBlocks, 6);
  f.put(f.config.caps.roadmap.path, roadmap(block('2026-11-04'), block('2026-11-03'), block('2026-11-02'), block('2026-11-01')));
  assert.ok(fs.statSync(f.roadmapPath()).size > f.config.caps.roadmap.warnBytes);
  const size = fs.statSync(f.roadmapPath()).size, rotatable = fs.readFileSync(f.roadmapPath(), 'utf8');
  // Contrast: the same number of bytes with nothing the planner may move does warn.
  f.put(f.config.caps.roadmap.path, '# Roadmap\n\n' + 'y'.repeat(size - 11));
  assert.equal(f.hits('repo.roadmap-no-rotation').length, 1, 'same size, nothing movable: warns');
  f.put(f.config.caps.roadmap.path, rotatable);
  // The fixture is rotatable by the very planner the gate uses.
  assert.ok(rotateRoadmap({repo: f.repo, config: f.config, write: false, today}).bytesRemoved > 0);
  assert.deepEqual(severities(f.hits('repo.roadmap')), ['WARN']);
  assert.equal(f.hits('repo.roadmap-no-rotation').length, 0);
  assert.equal(f.hits('repo.roadmap-rotation').length, 0);
});

test('R1-T4 a roadmap still over after every removable block warns; one the planner can still shrink does not', t => {
  const f = setup(t);
  // Two blocks: the planner never removes the last two, so nothing is removable.
  f.put(f.config.caps.roadmap.path, roadmap(block('2026-11-02', 700), block('2026-11-01', 700)));
  assert.equal(rotateRoadmap({repo: f.repo, config: f.config, write: false, today}).bytesRemoved, 0);
  assert.deepEqual(severities(f.hits('repo.roadmap-no-rotation')), ['WARN']);
  // Three blocks: one is removable, so the planner reports bytes and the warning waits for the next run (T4b).
  f.put(f.config.caps.roadmap.path, roadmap(block('2026-11-03', 700), block('2026-11-02', 700), block('2026-11-01', 700)));
  assert.ok(rotateRoadmap({repo: f.repo, config: f.config, write: false, today}).bytesRemoved > 0);
  assert.equal(f.hits('repo.roadmap-no-rotation').length, 0);
  // Degenerate Open work: the heading with no dated block, and one dated block: nothing the planner may move.
  for (const [name, text] of [['no blocks', '# Roadmap\n\n## Open work\n\n' + 'y'.repeat(1200) + '\n'], ['one block', roadmap(block('2026-11-01', 1200))]]) {
    f.put(f.config.caps.roadmap.path, text);
    assert.equal(f.hits('repo.roadmap-no-rotation').length, 1, name);
  }
  // The configured order and keepBlocks go through to the planner and give the same verdict on the same blocks
  // (the order only breaks ties between blocks of one date, and keepBlocks 2 is the smallest the planner accepts).
  f.config.caps.roadmap.order = 'oldest-first';
  f.config.caps.roadmap.keepBlocks = 2;
  f.put(f.config.caps.roadmap.path, roadmap(block('2026-11-01', 700), block('2026-11-02', 700), block('2026-11-03', 700)));
  assert.equal(f.hits('repo.roadmap-no-rotation').length, 0);
  f.put(f.config.caps.roadmap.path, roadmap(block('2026-11-01', 700), block('2026-11-02', 700)));
  assert.equal(f.hits('repo.roadmap-no-rotation').length, 1);
});

test('R1-T5 the gate plans without writes: the folder is byte-identical, history absent or present, rotatable or not', t => {
  for (const history of [false, true]) for (const rotatable of [true, false]) {
    const f = setup(t), name = `history ${history}, rotatable ${rotatable}`;
    f.put(f.config.caps.roadmap.path, rotatable ? roadmap(block('2026-11-04'), block('2026-11-03'), block('2026-11-02'), block('2026-11-01')) : '# Roadmap\n\n' + 'y'.repeat(1700) + '\n');
    if (history) f.put(f.config.caps.roadmapHistory.path, '# Roadmap history\n\n## Older entries\n\nkept\n');
    const before = snapshot(f.root);
    const first = f.check().findings.map(x => x.check);
    assert.equal(first.includes('repo.roadmap-no-rotation'), !rotatable, name + ': the planner ran and decided');
    assert.deepEqual(snapshot(f.root), before, name + ': the gate left the folder as it was');
    if (rotatable) {
      // Planning directly without a write flag is just as quiet.
      assert.ok(rotateRoadmap({repo: f.repo, config: f.config, memoryDir: f.memoryDir, today}).moved > 0);
      assert.ok(rotateRoadmap({repo: f.repo, config: f.config, memoryDir: f.memoryDir, write: false, today}).moved > 0);
      assert.deepEqual(snapshot(f.root), before, name + ': planning left the folder as it was');
    }
    assert.equal(fs.existsSync(f.historyPath()), history, name + (history ? ': history still there' : ': history not created'));
    assert.deepEqual(f.check().findings.map(x => x.check), first, name + ': a second gate run sees the same roadmap');
  }
});

test('R1-T6 invalid input keeps its own diagnostic: never the no-rotation warning', t => {
  const f = setup(t), over = () => f.put(f.config.caps.roadmap.path, roadmap(block('2026-11-03', 700), block('2026-11-02', 700), block('2026-11-01', 700)));
  over();
  // (a) keepBlocks below the planner's minimum, and a non-number
  for (const keepBlocks of [1, 0, 'six', 2.5, -3]) {
    f.config.caps.roadmap.keepBlocks = keepBlocks;
    const found = f.check().findings.filter(x => x.check === 'repo.roadmap-rotation' || x.check === 'repo.roadmap-no-rotation');
    assert.deepEqual(found.map(x => [x.check, x.severity]), [['repo.roadmap-rotation', 'WARN']], String(keepBlocks));
    assert.match(found[0].message, /rotation cannot be planned: roadmap\.keepBlocks must be at least 2/);
    assert.equal(found[0].file, f.config.caps.roadmap.path);
  }
  f.config.caps.roadmap.keepBlocks = 6;
  // (b) an unknown order is the existing config.roadmap-order FAIL; neither new check runs on top of it
  f.config.caps.roadmap.order = 'sideways';
  let ids = f.ids();
  assert.ok(ids.includes('config.roadmap-order'));
  assert.ok(!ids.includes('repo.roadmap-rotation') && !ids.includes('repo.roadmap-no-rotation'));
  f.config.caps.roadmap.order = 'newest-first';
  // (c) a dated block with an impossible date
  f.put(f.config.caps.roadmap.path, roadmap(block('2026-13-45', 700), block('2026-11-02', 700), block('2026-11-01', 700)));
  const bad = f.check().findings.filter(x => x.check === 'repo.roadmap-rotation' || x.check === 'repo.roadmap-no-rotation');
  assert.deepEqual(bad.map(x => x.check), ['repo.roadmap-rotation']);
  assert.match(bad[0].message, /invalid roadmap block date: 2026-13-45/);
  // (d) a history path that cannot be read as a file
  over(); fs.mkdirSync(f.historyPath(), {recursive: true});
  ids = f.ids();
  assert.ok(ids.includes('repo.roadmap-rotation'));
  assert.ok(!ids.includes('repo.roadmap-no-rotation'));
  // Back to valid input: the diagnostic goes away with the cause.
  fs.rmSync(f.historyPath(), {recursive: true}); over();
  assert.ok(!f.ids().includes('repo.roadmap-rotation'));
});

test('R1-T7 caps.roadmap.procedure changes the guidance, never the predicate', t => {
  const f = setup(t);
  f.put(f.config.caps.roadmap.path, '# Roadmap\n\n' + 'y'.repeat(1200) + '\n');
  const plain = f.check().findings, base = plain.map(x => [x.check, x.severity, x.file, x.value]);
  const without = plain.find(x => x.check === 'repo.roadmap-no-rotation').message;
  f.config.caps.roadmap.procedure = 'move one block with the project\'s own mover, as AGENTS.md says';
  const named = f.check().findings;
  assert.deepEqual(named.map(x => [x.check, x.severity, x.file, x.value]), base, 'same findings, same order');
  const withIt = named.find(x => x.check === 'repo.roadmap-no-rotation').message;
  assert.match(withIt, /follow this project's procedure: move one block with the project's own mover, as AGENTS\.md says/);
  assert.doesNotMatch(withIt, /caps\.roadmap\.procedure/);
  assert.notEqual(withIt, without);
  // One line, at most 200 characters of it.
  f.config.caps.roadmap.procedure = 'step one\nstep two\r\n' + 'z'.repeat(400);
  const long = f.hits('repo.roadmap-no-rotation')[0].message;
  assert.ok(!/[\r\n]/.test(long));
  assert.ok(long.includes('step one step two z'));
  assert.ok(!long.includes('z'.repeat(201)));
  // An invalid value is guidance text gone wrong: one WARN of its own, never a FAIL (a FAIL would block commits and fail an
  // upgrade over wording), and then it is ignored, so the unset guidance returns.
  assert.deepEqual(plain.filter(x => x.severity === 'FAIL'), [], 'the fixture itself has no FAIL');
  for (const value of [123, '', '   ', {}, [], false, null]) {
    f.config.caps.roadmap.procedure = value;
    for (const scope of ['all', 'memory']) {
      const found = f.check({scope}).findings;
      const invalid = found.filter(x => x.check === 'config.roadmap-procedure');
      assert.deepEqual(invalid.map(x => [x.severity, x.file]), [['WARN', 'memory.config.json']], JSON.stringify(value) + ' ' + scope);
      assert.match(invalid[0].message, /^caps\.roadmap\.procedure has invalid value .*; ignoring it$/);
      assert.deepEqual(found.filter(x => x.severity === 'FAIL'), [], 'no FAIL: ' + JSON.stringify(value) + ' ' + scope);
      assert.equal(found.filter(x => x.check === 'config.caps').length, 0);
    }
    assert.equal(f.check().findings.find(x => x.check === 'repo.roadmap-no-rotation').message, without);
  }
});

test('R1-T8 the repo checks are evaluated only in the all scope, so allow entries are stale only there', t => {
  const f = setup(t);
  f.put(f.config.caps.roadmap.path, '# Roadmap\n\nshort\n');
  for (const check of ['repo.roadmap-no-rotation', 'repo.roadmap-rotation']) {
    // The entry's file is outside docs/ and brain/, so only the check id decides whether the memory scope judges it.
    f.config.allow = [{check, file: 'ROADMAP.md', reason: 'fixture', added: '2026-11-01'}];
    assert.equal(f.hits('config.allow-stale', {scope: 'all'}).length, 1, check + ' stale in the all scope');
    assert.equal(f.hits('config.allow-stale', {scope: 'memory'}).length, 0, check + ' not judged in the memory scope');
  }
  f.config.allow = [];
  assert.ok(f.check({scope: 'all'}).evaluated.includes('repo.roadmap-no-rotation'));
  assert.ok(!f.check({scope: 'memory'}).evaluated.includes('repo.roadmap-no-rotation'));
  // Over the limit, the memory scope still never plans a rotation (it never reads the repo layer).
  f.put(f.config.caps.roadmap.path, '# Roadmap\n\n' + 'y'.repeat(1200) + '\n');
  assert.deepEqual(f.ids({scope: 'memory'}).filter(id => id.startsWith('repo.roadmap')), []);
});

test('R1-T9 a history file deleted between two rotations is recreated with only the newly moved blocks', t => {
  const f = setup(t);
  f.config.caps.roadmap.warnBytes = 1000000; f.config.caps.roadmap.failBytes = 2000000;
  const days = n => Array.from({length: n}, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
  const lines = dates => roadmap(...[...dates].reverse().map(d => block(d, 60)));
  f.put(f.config.caps.roadmap.path, lines(days(8)));
  const options = {repo: f.repo, config: f.config, memoryDir: f.memoryDir, write: true, today};
  const first = rotateRoadmap(options);
  assert.equal(first.moved, 2); assert.equal(first.found, true);
  const history1 = read(f.historyPath());
  assert.ok(history1.includes('2026-10-01') && history1.includes('2026-10-02') && !history1.includes('2026-10-03'));
  fs.rmSync(f.historyPath());
  // Two newer blocks arrive; the next two oldest (03 and 04) move.
  f.put(f.config.caps.roadmap.path, roadmap(block('2026-10-10', 60), block('2026-10-09', 60), ...fs.readFileSync(f.roadmapPath(), 'utf8').match(/\*\*[\s\S]*?\n\n/g)));
  const second = rotateRoadmap({...options, today: '2026-11-13'});
  assert.equal(second.moved, 2); assert.equal(second.found, true); assert.equal(second.bytesRemoved, second.bytesAdded);
  const history2 = read(f.historyPath());
  assert.ok(fs.existsSync(f.historyPath()), 'recreated');
  assert.equal([...history2.matchAll(/^## Open work/gm)].length, 1, 'one moved-blocks section, nothing carried over');
  assert.match(history2, /^## Open work — dated blocks moved 2026-11-13\n\n/);
  // Blocks keep their file order (newest first), and only the second batch is in the new file.
  assert.deepEqual([...history2.matchAll(/^\*\*(\d{4}-\d{2}-\d{2}) /gm)].map(m => m[1]), ['2026-10-04', '2026-10-03']);
  assert.ok(!history2.includes('2026-11-12'), 'no heading from the first rotation');
});

// A FIFO cannot be made on every platform, so the kind of one path is stubbed: stat says "not a regular file" and any read of
// that path is recorded and refused. The tests assert the read never happens. Mutants: `!stat.isFile()` to
// `!stat.isDirectory()` and the ENOENT allowance misspelt (both in lib regularFileOrAbsent); the planner or the overview
// comparison not calling it.
function stubKind(t, target, kind = {isFile: () => false, isFIFO: () => true, isDirectory: () => false}) {
  const wanted = path.resolve(target).toLowerCase(), same = p => typeof p === 'string' && path.resolve(p).toLowerCase() === wanted;
  const realStat = fs.statSync, realRead = fs.readFileSync, reads = [];
  fs.statSync = function (p, ...rest) { return same(p) ? kind : realStat.call(this, p, ...rest); };
  fs.readFileSync = function (p, ...rest) { if (same(p)) { reads.push(String(p)); throw new Error('a read of the stubbed path'); } return realRead.call(this, p, ...rest); };
  const restore = () => { fs.statSync = realStat; fs.readFileSync = realRead; };
  t.after(restore);
  return {reads, restore};
}

test('R1-T22 a history destination that is not a regular file is refused before any read; an absent one is allowed', t => {
  const f = setup(t);
  f.put(f.config.caps.roadmap.path, roadmap(block('2026-11-04'), block('2026-11-03'), block('2026-11-02'), block('2026-11-01')));
  assert.equal(f.hits('repo.roadmap-rotation').length, 0, 'absent history on a rotatable roadmap: nothing to report');
  const stub = stubKind(t, f.historyPath());
  const found = f.check().findings.filter(x => x.check === 'repo.roadmap-rotation' || x.check === 'repo.roadmap-no-rotation');
  assert.deepEqual(found.map(x => [x.check, x.severity]), [['repo.roadmap-rotation', 'WARN']]);
  assert.match(found[0].message, /^rotation cannot be planned: roadmap history is not a regular file$/);
  assert.deepEqual(stub.reads, [], 'the history destination was never read');
  // The same refusal when the planner is asked to write, before it reads or writes anything.
  assert.throws(() => rotateRoadmap({repo: f.repo, config: f.config, memoryDir: f.memoryDir, write: true, today}), /roadmap history is not a regular file/);
  assert.deepEqual(stub.reads, []);
  // A folder is refused the same way (no stub: the real kind).
  stub.restore();
  fs.mkdirSync(f.historyPath(), {recursive: true});
  assert.match(f.hits('repo.roadmap-rotation')[0].message, /roadmap history is not a regular file/);
  fs.rmSync(f.historyPath(), {recursive: true});
  // And a regular file, and a link to one, are read as before.
  f.put(f.config.caps.roadmapHistory.path, '# Roadmap history\n');
  assert.equal(f.hits('repo.roadmap-rotation').length, 0);
});

test('F1-T25 an overview path that is not a regular file is refused before any read', t => {
  const f = overviewFixture(t);
  // The overview sits outside docs/ROADMAP*.md: the gate's own secret scan already reads every file of that name (before this
  // release too), so a path matching it would be read there first, at a site this release did not add.
  f.config.caps.roadmapOverview.path = 'docs/generated/roadmap-overview.md';
  f.put(f.config.caps.roadmapOverview.path, f.generated());
  assert.deepEqual(f.stale(), [], 'control: a regular, fresh overview');
  assert.equal(overviewFresh({repo: f.repo, config: f.config}), true);
  const stub = stubKind(t, f.overviewPath());
  const found = f.stale();
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'WARN');
  assert.match(found[0].message, /^roadmap overview is not a regular file$/);
  assert.throws(() => overviewFresh({repo: f.repo, config: f.config}), /roadmap overview is not a regular file/);
  assert.deepEqual(stub.reads, [], 'the overview path was never read');
  // Absent is still just stale.
  stub.restore(); fs.rmSync(f.overviewPath());
  assert.equal(overviewFresh({repo: f.repo, config: f.config}), false);
});

// ---------------------------------------------------------------- R2: index.hot-reserve
// Mutants: `free < reserve` to `free <= reserve` (T10, T10b, T11, T12); `caps.index.hotReserveBytes` read as
// `caps.index.pinSlackBytes` (T11); `split.total` to `split.pins` in the free-byte sum (T10, T10b, T11, T12); default
// `1024` to `1025` (T12); a misspelt key in the validated-keys table (T12); shipped value 1024 to 1025 in the config or
// the self-test config (T15).

function hotFixture(t, families = ['craft']) {
  const f = setup(t);
  f.config.caps.index.hotBytes = 8192;
  const router = families.map(name => `- [${name}](INDEX-${name}.md) OPEN BEFORE ${name} work.`).join('\n');
  f.put('MEMORY.md', `# Memory\n${router}\n`, f.memoryDir);
  let n = 0;
  for (const family of families) for (let i = 0; i < 3; i++) {
    const id = String(++n).padStart(3, '0');
    f.put(`lesson-${id}-example.md`, `---\nname: lesson-${id}-example\ndescription: "Useful lesson ${id}."\nmetadata:\n  type: feedback\n  route: ${family}\n  pin: true\n---\nBody ${id}.\n`, f.memoryDir);
  }
  f.budgets = () => generateMemoryIndex({memoryDir: f.memoryDir, config: f.config}).hotBudgets;
  return f;
}
const reserveHits = f => f.hits('index.hot-reserve', {scope: 'memory'});

test('R2-T10 a hot page with fewer than 1,024 bytes free before the recent-lesson fill warns; 1,024 does not', t => {
  const f = hotFixture(t), total = f.budgets().craft.total;
  assert.ok(total > 0);
  for (const [free, warns] of [[1023, true], [1024, false], [1025, false], [0, true], [-1, true], [1, true], [4000, false]]) {
    f.config.caps.index.hotBytes = total + free;
    writeMemoryIndex({memoryDir: f.memoryDir, config: f.config});
    const found = reserveHits(f);
    assert.equal(found.length, warns ? 1 : 0, `${free} bytes free`);
    if (!warns) continue;
    const [hit] = found;
    assert.equal(hit.severity, 'WARN');
    assert.equal(hit.file, 'INDEX-craft.md');
    assert.equal(hit.value, total);
    assert.match(hit.message, /INDEX-craft\.md has -?[\d,]+ of [\d,]+ hot bytes free before recent lessons \(reserve 1,024\)/);
    assert.match(hit.message, /move .* down a layer/);
    assert.match(hit.message, /never raise hotBytes/);
  }
});

test('R2-T10b the reserve is per hot page and counts only that page', t => {
  const f = hotFixture(t, ['craft', 'ops']), totals = f.budgets();
  // Give each page a different budget slack by growing one family.
  f.put('lesson-099-example.md', `---\nname: lesson-099-example\ndescription: "${'x'.repeat(190)}"\nmetadata:\n  type: feedback\n  route: ops\n  pin: true\n---\nBody.\n`, f.memoryDir);
  const grown = f.budgets();
  assert.ok(grown.ops.total > totals.ops.total && grown.craft.total === totals.craft.total);
  const files = () => reserveHits(f).map(x => x.file).sort();
  const settle = hotBytes => { f.config.caps.index.hotBytes = hotBytes; writeMemoryIndex({memoryDir: f.memoryDir, config: f.config}); };
  settle(grown.ops.total + 1023);       // ops has 1,023 free; craft, the smaller page, has more
  assert.deepEqual(files(), ['INDEX-ops.md']);
  settle(grown.craft.total + 1024);     // craft has exactly 1,024 free; ops, the larger page, has fewer
  assert.deepEqual(files(), ['INDEX-ops.md']);
  settle(grown.craft.total + 1023);     // now both pages are inside the reserve
  assert.deepEqual(files(), ['INDEX-craft.md', 'INDEX-ops.md']);
  settle(grown.ops.total + 1024);       // ops has exactly 1,024 free and craft more: neither warns
  assert.deepEqual(files(), []);
});

test('R2-T10c a family with no lessons has a tiny hot page: no reserve finding, nothing stale', t => {
  const f = hotFixture(t, ['craft']);
  f.put('MEMORY.md', '# Memory\n- [craft](INDEX-craft.md) OPEN BEFORE craft work.\n- [empty](INDEX-empty.md) OPEN BEFORE empty work.\n', f.memoryDir);
  writeMemoryIndex({memoryDir: f.memoryDir, config: f.config});
  const budgets = f.budgets();
  assert.ok(budgets.empty && budgets.empty.total > 0 && budgets.empty.budget - budgets.empty.total > 1024);
  assert.deepEqual(reserveHits(f), []);
  assert.deepEqual(f.hits('index.stale', {scope: 'memory'}), []);
  // With nothing generated at all the block never runs.
  const g = setup(t);
  assert.deepEqual(g.hits('index.hot-reserve', {scope: 'memory'}), []);
});

// Mutant: the free bytes measured on the final generated page (`Buffer.byteLength(expected.pages[...])`) instead of the
// pre-fill `split.total`.
test('R2-T22 the reserve is counted before the newest lessons fill the page: unpinned recent lessons never eat into it', t => {
  const f = hotFixture(t);
  for (let i = 1; i <= 6; i++) f.put(`lesson-10${i}-recent.md`, `---\nname: lesson-10${i}-recent\ndescription: "Recent lesson ${i} with a sentence long enough to take real room on the page."\nmetadata:\n  type: feedback\n  route: craft\n---\nBody.\n`, f.memoryDir);
  const total = f.budgets().craft.total, page = () => Buffer.byteLength(fs.readFileSync(path.join(f.memoryDir, 'INDEX-craft.md'), 'utf8'));
  // Exactly 1,024 free before the fill: no warning, although the fill leaves fewer than 1,024 free afterwards.
  f.config.caps.index.hotBytes = total + 1024;
  writeMemoryIndex({memoryDir: f.memoryDir, config: f.config});
  assert.ok(page() > total + 200, 'the fill added recent lessons: ' + page() + ' vs ' + total);
  assert.ok(f.config.caps.index.hotBytes - page() < 1024, 'fewer than 1,024 free after the fill');
  assert.deepEqual(reserveHits(f), [], 'free before the fill is exactly the reserve: no warning');
  // One byte less before the fill: the warning, whatever the fill does.
  f.config.caps.index.hotBytes = total + 1023;
  writeMemoryIndex({memoryDir: f.memoryDir, config: f.config});
  assert.equal(reserveHits(f).length, 1);
  assert.equal(reserveHits(f)[0].value, total);
  // A roomy budget fills the page right up and still warns about nothing.
  f.config.caps.index.hotBytes = total + 5000;
  writeMemoryIndex({memoryDir: f.memoryDir, config: f.config});
  assert.deepEqual(reserveHits(f), []);
});

test('R2-T11 caps.index.hotReserveBytes is its own setting: pinSlackBytes and pinWarnRoomBytes never move it', t => {
  const f = hotFixture(t), total = f.budgets().craft.total;
  f.config.caps.index.hotBytes = total + 700;
  writeMemoryIndex({memoryDir: f.memoryDir, config: f.config});
  // 700 free: warns at the default 1,024, is quiet at 700 and below
  assert.equal(reserveHits(f).length, 1);
  f.config.caps.index.hotReserveBytes = 700;
  assert.equal(reserveHits(f).length, 0);
  f.config.caps.index.hotReserveBytes = 701;
  assert.equal(reserveHits(f).length, 1);
  assert.match(reserveHits(f)[0].message, /\(reserve 701\)/);
  for (const [slack, room] of [[1, 1], [100000, 100000]]) {
    f.config.caps.index.pinSlackBytes = slack; f.config.caps.index.pinWarnRoomBytes = room;
    f.config.caps.index.hotReserveBytes = 701;
    assert.equal(reserveHits(f).length, 1, `slack ${slack}`);
    f.config.caps.index.hotReserveBytes = 700;
    assert.equal(reserveHits(f).length, 0, `slack ${slack}`);
  }
});

test('R2-T12 the reserve default and validation: a missing key uses 1,024, an invalid one is a config.caps FAIL and uses 1,024', t => {
  const f = hotFixture(t), total = f.budgets().craft.total;
  f.config.caps.index.hotBytes = total + 1023;
  writeMemoryIndex({memoryDir: f.memoryDir, config: f.config});
  delete f.config.caps.index.hotReserveBytes;       // a configuration from before this release
  assert.equal(reserveHits(f).length, 1);
  f.config.caps.index.hotBytes = total + 1024;
  writeMemoryIndex({memoryDir: f.memoryDir, config: f.config});
  assert.equal(reserveHits(f).length, 0, 'the default is exactly 1,024');
  f.config.caps.index.hotBytes = total + 1023;
  writeMemoryIndex({memoryDir: f.memoryDir, config: f.config});
  assert.equal(f.hits('config.caps', {scope: 'memory'}).length, 0);
  for (const value of ['1024', 0, -5, 1.5, 'abc', null]) {
    f.config.caps.index.hotReserveBytes = value;
    const result = f.check({scope: 'memory'});
    assert.deepEqual(result.findings.filter(x => x.check === 'config.caps').map(x => [x.severity, x.file, x.message]),
      [['FAIL', 'memory.config.json', `caps.index.hotReserveBytes has invalid value ${JSON.stringify(value)}; using default 1024`]], JSON.stringify(value));
    assert.equal(result.findings.filter(x => x.check === 'index.hot-reserve').length, 1, 'default applied');
  }
  // A malformed group falls back to the whole default group, reserve included.
  f.config.caps.index = 5;
  const result = f.check({scope: 'memory'});
  assert.ok(result.findings.some(x => x.check === 'config.caps' && /^caps\.index has invalid value 5; using defaults$/.test(x.message)));
});

// ---------------------------------------------------------------- R2: router.target
// Mutants: `f.bytes > target` to `>=` (T13, T14); `!sized` to `sized` (T13, T14); `targetBytes ?? 11264` to `?? 11265`
// (T14); a misspelt key in the validated-keys table (T14); severity WARN to FAIL (T13, T16); the id listed in NEW_CHECKS
// (T15).

const routerBytes = n => ('x'.repeat(99) + '\n').repeat(Math.floor(n / 100)) + 'x'.repeat(n % 100);
const routerState = (f, n) => {
  f.put('MEMORY.md', routerBytes(n), f.memoryDir);
  assert.equal(fs.statSync(path.join(f.memoryDir, 'MEMORY.md')).size, n);
  const found = f.check({scope: 'memory'}).findings.filter(x => x.check === 'router.target' || x.check === 'router.size');
  return found.map(x => `${x.check} ${x.severity}`);
};

test('R2-T13 router.target at target-1, target, target+1, warn, warn+1, fail, fail+1', t => {
  const f = setup(t), targetBytes = 11264, warnBytes = 12288, failBytes = 16384;
  assert.deepEqual([f.config.caps.router.warnBytes, f.config.caps.router.failBytes], [warnBytes, failBytes]);
  const expected = [
    [0, []],
    [targetBytes - 1, []],
    [targetBytes, []],
    [targetBytes + 1, ['router.target WARN']],
    [warnBytes, ['router.target WARN']],            // equality with warnBytes: router.size does not apply yet
    [warnBytes + 1, ['router.size WARN']],          // router.size takes over
    [failBytes, ['router.size WARN']],
    [failBytes + 1, ['router.size FAIL']],
  ];
  for (const [bytes, want] of expected) assert.deepEqual(routerState(f, bytes), want, `${bytes} bytes`);
  // The finding itself.
  f.put('MEMORY.md', routerBytes(targetBytes + 1), f.memoryDir);
  const [hit] = f.hits('router.target', {scope: 'memory'});
  assert.equal(hit.severity, 'WARN'); assert.equal(hit.file, 'MEMORY.md'); assert.equal(hit.value, targetBytes + 1);
  assert.match(hit.message, /^11,265 bytes \(target 11,264, warn 12,288\); /);
  assert.match(hit.message, /move detail down a layer/);
});

test('R2-T14 router.target setting: default for a missing key, validation, a configured value, a target above warn', t => {
  const f = setup(t);
  delete f.config.caps.router.targetBytes;           // a configuration from before this release
  assert.deepEqual(routerState(f, 11264), []);
  assert.deepEqual(routerState(f, 11265), ['router.target WARN']);
  assert.equal(f.hits('config.caps', {scope: 'memory'}).length, 0);
  for (const value of ['11264', 0, -5, 1.5, 'abc', null]) {
    f.config.caps.router.targetBytes = value;
    const result = f.check({scope: 'memory'});
    assert.deepEqual(result.findings.filter(x => x.check === 'config.caps').map(x => [x.severity, x.message]),
      [['FAIL', `caps.router.targetBytes has invalid value ${JSON.stringify(value)}; using default 11264`]], JSON.stringify(value));
    assert.equal(result.findings.filter(x => x.check === 'router.target').length, 1, 'default applied at 11,265 bytes');
  }
  f.config.caps.router.targetBytes = 5000;
  assert.deepEqual(routerState(f, 5000), []);
  assert.deepEqual(routerState(f, 5001), ['router.target WARN']);
  // A target above the warn line never fires before router.size does.
  f.config.caps.router.targetBytes = 20000;
  assert.deepEqual(routerState(f, 12289), ['router.size WARN']);
  assert.deepEqual(routerState(f, 11265), []);
  // Custom warn and fail lines move the boundaries the same way.
  f.config.caps.router.targetBytes = 1000; f.config.caps.router.warnBytes = 2000; f.config.caps.router.failBytes = 3000;
  for (const [bytes, want] of [[1000, []], [1001, ['router.target WARN']], [2000, ['router.target WARN']], [2001, ['router.size WARN']], [3001, ['router.size FAIL']]])
    assert.deepEqual(routerState(f, bytes), want, `${bytes} bytes, custom limits`);
});

// ---------------------------------------------------------------- R2: defaults, severities, upgrade list
test('R2-T15 shipped defaults, no new id in NEW_CHECKS, and a configuration from before this release gains no FAIL', t => {
  const shipped = json(path.join(kitRoot, 'engine/memory.config.json')).caps;
  for (const caps of [shipped, defaults.caps]) {
    assert.equal(caps.index.hotReserveBytes, 1024);
    assert.equal(caps.router.targetBytes, 11264);
    assert.ok(!Object.hasOwn(caps.roadmap, 'procedure'), 'procedure is optional: no default');
  }
  for (const id of NEW_IDS) assert.ok(!NEW_CHECKS.includes(id), id + ' is not in NEW_CHECKS, so upgrade does not roll back over it by that list');
  // What is guaranteed to an existing installation: every new key missing means its default, with no FAIL and no config finding.
  const f = setup(t);
  f.put(f.config.caps.roadmap.path, '# Roadmap\n\nshort\n');
  const before = f.check().findings;
  delete f.config.caps.index.hotReserveBytes; delete f.config.caps.router.targetBytes; delete f.config.caps.roadmap.procedure;
  const old = f.check().findings;
  assert.deepEqual(old.filter(x => x.severity === 'FAIL'), [], 'no FAIL from the missing keys');
  assert.deepEqual(old.map(x => [x.check, x.severity]), before.map(x => [x.check, x.severity]), 'the same findings as with the keys present');
  assert.deepEqual(old.filter(x => x.check.startsWith('config.')).map(x => x.check), before.filter(x => x.check.startsWith('config.')).map(x => x.check));
  // What is NOT guaranteed, stated here so nobody reads this test as more: an invalid R2 number follows the existing
  // config.caps convention (a FAIL that upgrade's post-check can see); invalid procedure text is only a WARN.
  f.config.caps.index.hotReserveBytes = 0; f.config.caps.router.targetBytes = '11264'; f.config.caps.roadmap.procedure = null;
  const bad = f.check().findings;
  assert.deepEqual(bad.filter(x => x.severity === 'FAIL').map(x => x.check), ['config.caps', 'config.caps']);
  assert.deepEqual(bad.filter(x => x.check === 'config.roadmap-procedure').map(x => x.severity), ['WARN']);
});

test('R2-T16 the new checks are WARN only, whatever the size or the state', t => {
  const f = hotFixture(t), total = f.budgets().craft.total;
  const seen = [];
  const collect = () => { for (const x of f.check().findings) if (NEW_IDS.includes(x.check)) seen.push(x); };
  f.config.caps.roadmap.failBytes = 10;           // roadmap far over even the fail line
  f.put(f.config.caps.roadmap.path, '# Roadmap\n\n' + 'y'.repeat(5000) + '\n');
  for (const free of [-5000, 0, 1023]) { f.config.caps.index.hotBytes = total + free; writeMemoryIndex({memoryDir: f.memoryDir, config: f.config}); collect(); }
  for (const bytes of [11265, 12288, 16385, 100000]) { f.put('MEMORY.md', routerBytes(bytes) + '\n- [craft](INDEX-craft.md) OPEN BEFORE craft work.\n', f.memoryDir); collect(); }
  assert.ok(seen.length >= 6, 'fixtures hit the new checks');
  assert.deepEqual([...new Set(seen.map(x => x.severity))], ['WARN']);
  assert.deepEqual([...new Set(seen.map(x => x.check))].sort(), ['index.hot-reserve', 'repo.roadmap-no-rotation', 'router.target']);
});

// ---------------------------------------------------------------- cap keys absent from a present group
// A project whose caps group is present but partial must never crash the gate, and no message may print a missing value.
// Mutants: `Number.isFinite(caps.router.warnBytes) ?` to `true ?` (T19, T20); the reserve message reading the raw cap
// `caps.index.hotReserveBytes` instead of `reserve` (T20, T12); `roadmapBytes > caps.roadmap.warnBytes` to
// `> (caps.roadmap.warnBytes ?? 0)` (T21); the planner's `keepBlocks ?? 6` to `?? 1` (T21).

test('R2-T19 a router group without warnBytes (or with a junk one) reports router.target and never crashes', t => {
  const f = setup(t);
  const text = routerBytes(11603);
  f.put('MEMORY.md', text, f.memoryDir);
  const run = () => f.check({scope: 'memory'}).findings.filter(x => x.check === 'router.target' || x.check === 'router.size');
  // The group as an older project may have it: line limits only, no byte limits at all.
  for (const [name, router] of [
    ['line limits only', {warnLines: 150, failLines: 200}],
    ['empty group', {}],
    ['warnBytes deleted', (({warnBytes, ...rest}) => rest)(f.config.caps.router)],
    ['warnBytes text', {...f.config.caps.router, warnBytes: 'abc'}],
    ['warnBytes object', {...f.config.caps.router, warnBytes: {}}],
  ]) {
    f.config.caps.router = router;
    const found = run();
    // router.size cannot fire without a warn line it can compare to (or, for text, never compares true).
    assert.deepEqual(found.map(x => x.check + ' ' + x.severity), ['router.target WARN'], name);
    assert.match(found[0].message, /^11,603 bytes \(target 11,264\); move detail down a layer/, name);
    assert.doesNotMatch(found[0].message, /undefined|NaN|\[object|warn/, name);
  }
  // null and [] read as 0 in the comparison, so router.size itself takes over: still no crash, still no router.target.
  for (const warnBytes of [null, []]) {
    f.config.caps.router = {...defaults.caps.router, warnBytes};
    assert.deepEqual(run().map(x => x.check + ' ' + x.severity), ['router.size WARN'], JSON.stringify(warnBytes));
  }
  // With a real warn line the message still names it (T13 pins the exact text).
  f.config.caps.router = {...defaults.caps.router};
  assert.match(run()[0].message, /^11,603 bytes \(target 11,264, warn 12,288\); /);
});

// One scenario that fires every new check: a router over its target, a hot page inside its reserve, a roadmap over its
// limit (with and without blocks the planner may move) and an overview that is missing.
function degenerateScenario(t, rotatable) {
  const f = hotFixture(t);
  const row = '- [craft](INDEX-craft.md) OPEN BEFORE craft work.\n';
  f.put('MEMORY.md', ('x'.repeat(99) + '\n').repeat(113) + row, f.memoryDir);
  f.config.caps.index.hotBytes = f.budgets().craft.total + 500;
  writeMemoryIndex({memoryDir: f.memoryDir, config: f.config});
  f.config.caps.roadmapOverview.enabled = true;
  f.put(f.config.caps.roadmap.path, rotatable ? roadmap(block('2026-11-04'), block('2026-11-03'), block('2026-11-02'), block('2026-11-01')) : '# Roadmap\n\n' + 'y'.repeat(1500) + '\n');
  return f;
}
const JUNK = [['deleted', undefined], ['null', null], ['text', 'abc'], ['zero', 0], ['negative', -1], ['fraction', 1.5], ['array', []], ['object', {}]];
// Every cap key the new code reads or passes on, with its group. (Groups that the gate already could not do without,
// such as a missing roadmap path, fail in the same place before and after this release and are not in the list.)
const CAP_READS = [['router', 'warnBytes'], ['router', 'failBytes'], ['router', 'targetBytes'], ['router', 'warnLines'], ['router', 'failLines'],
  ['index', 'hotBytes'], ['index', 'hotReserveBytes'], ['index', 'pinSlackBytes'],
  ['roadmap', 'warnBytes'], ['roadmap', 'failBytes'], ['roadmap', 'keepBlocks'], ['roadmap', 'order'], ['roadmap', 'procedure'],
  ['roadmapHistory', 'path'], ['roadmapOverview', 'enabled']];
const NEW_MESSAGE_IDS = ['router.target', 'index.hot-reserve', 'repo.roadmap-no-rotation'];

test('R2-T20 no cap key missing from, or junk in, a present group can crash the gate or put a missing value in a new message', t => {
  let ran = 0, fired = new Set();
  for (const rotatable of [false, true]) {
    const f = degenerateScenario(t, rotatable);
    const run = (name, change) => {
      const config = structuredClone(f.config);
      change(config.caps);
      let result;
      try { result = runCheck({memoryDir: f.memoryDir, repo: f.repo, config, today, noGit: true, scope: 'all'}); }
      catch (error) { assert.fail(`${rotatable ? 'rotatable' : 'unmovable'} roadmap, ${name}: the gate threw: ${error.message}`); }
      ran++;
      // A TypeError inside a check is caught and reported as another finding (index.stale for the hot pages): that is a crash
      // in disguise. Only the two reports that carry a planner or reader error on purpose may quote one.
      for (const x of result.findings) if (!['repo.roadmap-rotation', 'repo.roadmap-overview'].includes(x.check))
        assert.doesNotMatch(x.message, /Cannot read properties of (?:undefined|null)/, `${name}: ${x.check}`);
      for (const x of result.findings) if (NEW_MESSAGE_IDS.includes(x.check)) {
        fired.add(x.check);
        assert.doesNotMatch(x.message, /undefined|NaN|\[object/, `${name}: ${x.check}`);
      }
      return result;
    };
    const baseline = run('baseline', () => {});
    assert.deepEqual(NEW_MESSAGE_IDS.filter(id => baseline.findings.some(x => x.check === id)), rotatable ? ['router.target', 'index.hot-reserve'] : NEW_MESSAGE_IDS, 'the scenario reaches the new messages');
    for (const [group, key] of CAP_READS) for (const [label, value] of JUNK)
      run(`${group}.${key} ${label}`, caps => { if (value === undefined) delete caps[group][key]; else caps[group][key] = structuredClone(value); });
    for (const group of ['router', 'index', 'roadmap', 'roadmapHistory', 'roadmapOverview']) run(group + ' null', caps => { caps[group] = null; });
    for (const group of ['router', 'index', 'roadmapHistory']) run(group + ' empty', caps => { caps[group] = {}; });
    run('roadmapHistory deleted', caps => { delete caps.roadmapHistory; });
  }
  assert.ok(ran >= 2 * (CAP_READS.length * JUNK.length + 9), 'the matrix ran: ' + ran);
  assert.deepEqual([...fired].sort(), [...NEW_MESSAGE_IDS].sort());
});

test('R2-T21 an absent limit means no limit: no roadmap size finding, no planner run, and a missing keepBlocks takes its default', t => {
  for (const rotatable of [false, true]) {
    const f = degenerateScenario(t, rotatable), name = rotatable ? 'rotatable' : 'unmovable';
    const ids = change => { const config = structuredClone(f.config); change(config.caps); return runCheck({memoryDir: f.memoryDir, repo: f.repo, config, today, noGit: true, scope: 'all'}).findings.map(x => x.check); };
    assert.ok(ids(() => {}).includes('repo.roadmap'), name);
    const without = ids(caps => { delete caps.roadmap.warnBytes; });
    assert.ok(!without.includes('repo.roadmap') && !without.includes('repo.roadmap-no-rotation') && !without.includes('repo.roadmap-rotation'), name);
    if (!rotatable) continue;
    // keepBlocks missing: the planner's default of six applies, the roadmap is still rotatable, and nothing is reported.
    const missingKeep = ids(caps => { delete caps.roadmap.keepBlocks; });
    assert.ok(missingKeep.includes('repo.roadmap'));
    assert.ok(!missingKeep.includes('repo.roadmap-no-rotation') && !missingKeep.includes('repo.roadmap-rotation'));
  }
  // The default itself, on the planner: eight blocks, no byte pressure, keepBlocks missing -> six kept, two moved. (Under
  // byte pressure the planner shrinks to two blocks whatever the default, so only this case can tell six from two.)
  const g = setup(t);
  g.config.caps.roadmap.warnBytes = 1000000; g.config.caps.roadmap.failBytes = 2000000;
  delete g.config.caps.roadmap.keepBlocks;
  g.put(g.config.caps.roadmap.path, roadmap(...Array.from({length: 8}, (_, i) => block('2026-10-0' + (8 - i), 60))));
  const plan = rotateRoadmap({repo: g.repo, config: g.config, write: false, today});
  assert.deepEqual([plan.moved, plan.kept], [2, 6]);
  g.config.caps.roadmap.keepBlocks = 4;
  assert.deepEqual((({moved, kept}) => [moved, kept])(rotateRoadmap({repo: g.repo, config: g.config, write: false, today})), [4, 4]);
});

// ---------------------------------------------------------------- glossary and the procedures doc
test('R2-T17 the glossary defines every new check id, caps key, module and flag', () => {
  const text = read(path.join(kitRoot, 'docs/GLOSSARY.md'));
  const terms = new Map([...text.matchAll(/^\*\*([^*]+)\*\* - (.+)$/gm)].map(m => [m[1], m[2]]));
  for (const term of [...NEW_IDS, 'caps.checkpoint.mode', 'caps.roadmap.procedure', 'caps.index.hotReserveBytes', 'caps.router.targetBytes',
    'memory-session.mjs', '--session', '--files', '--files-only', '--memory-only', '--take', '--all', '--no-rotate'])
    assert.ok(terms.has(term), 'glossary entry for ' + term);
  // What the entries say matches what the code does (read from the code, not from memory).
  const entry = name => terms.get(name);
  assert.match(entry('--all'), /caps\.checkpoint\.mode/);
  assert.match(entry('--session'), /claim/);
  assert.match(entry('--files'), /claim/); assert.match(entry('--files'), /session mode/);
  assert.match(entry('--files-only'), /only the files? named/);
  assert.match(entry('--take'), /another/);
  assert.match(entry('--no-rotate'), /log, roadmap and hand-over|log, roadmap and handover/);
  assert.match(entry('--memory-only'), /memory-checkpoint\.mjs/); assert.match(entry('--memory-only'), /upgrade/i);
  assert.match(entry('index.hot-reserve'), /1,024/); assert.match(entry('index.hot-reserve'), /hotBytes/);
  assert.match(entry('router.target'), /11,264/);
  assert.match(entry('repo.roadmap-no-rotation'), /caps\.roadmap\.procedure/);
  assert.match(entry('caps.roadmap.procedure'), /guidance/);
  // Every flag the checkpoint's parser accepts for the save itself has an entry.
  const source = read(path.join(kitRoot, 'engine/memory-checkpoint.mjs'));
  const parsed = [...source.slice(source.indexOf('function parseArgs')).matchAll(/'(--[a-z-]+)'/g)].map(m => m[1]);
  for (const flag of ['--session', '--all', '--files', '--files-only', '--memory-only', '--no-rotate', '--take']) assert.ok(parsed.includes(flag), flag + ' is a real checkpoint flag');
});

test('R1-T18 docs/ROADMAPS.md gives the three procedures and ships as a kit-owned file', () => {
  const file = path.join(kitRoot, 'docs/ROADMAPS.md'), text = read(file);
  assert.ok(!text.includes('\r'), 'LF');
  for (const heading of ['## Open work with dated blocks', '## An anchored block mover', '## Anything else'])
    assert.ok(text.includes('\n' + heading + '\n'), heading);
  assert.match(text, /memory-rotate\.mjs roadmap/);
  assert.match(text, /repo\.roadmap-no-rotation/);
  assert.match(text, /caps\.roadmap\.procedure/);
  assert.match(text, /never a restructure/);
  assert.ok(ownedFiles(kitRoot).includes('docs/ROADMAPS.md'));
  assert.equal(installedPath('docs/ROADMAPS.md'), 'scripts/memory/ROADMAPS.md');
  assert.equal(json(path.join(kitRoot, 'MANIFEST.json')).files['docs/ROADMAPS.md'], hash(file), 'MANIFEST.json lists the current bytes');
});

// ---------------------------------------------------------------- F1 (gate part): CRLF and the overview
// Mutants: no `normalizeEol` on the stored side (T20, T22, T23) or on the generated side (T23) of overviewFresh; the shared
// normalizeEol reading a lone CR as a line ending, `/\r\n/g` to `/\r\n?/g` (T22).

function overviewFixture(t) {
  const f = setup(t);
  f.config.caps.roadmapOverview.enabled = true;
  f.put(f.config.caps.roadmap.path, '# Roadmap\n\nLast updated: 2026-11-12\n\n## Open work\n\n### Now\n- one item\n- another item\n');
  f.generated = () => generateOverview({repo: f.repo, config: f.config});
  f.overviewPath = () => path.join(f.repo, f.config.caps.roadmapOverview.path);
  f.stale = () => f.hits('repo.roadmap-overview', {scope: 'all'});
  f.cliCheck = () => spawnSync(process.execPath, [path.join(kitRoot, 'engine/roadmap-overview.mjs'), '--check', '--repo', f.repo], {encoding: 'utf8'});
  return f;
}
const crlf = text => text.replace(/\r?\n/g, '\r\n');

test('F1-T20 an overview that differs only in line endings is fresh for the gate and for --check', t => {
  const f = overviewFixture(t), output = f.generated();
  assert.ok(output.includes('\n') && !output.includes('\r'));
  for (const [name, stored] of [['LF', output], ['CRLF', crlf(output)], ['mixed', output.replace('\n', '\r\n')]]) {
    fs.mkdirSync(path.dirname(f.overviewPath()), {recursive: true});
    fs.writeFileSync(f.overviewPath(), stored);
    assert.deepEqual(f.stale(), [], name + ': no staleness finding');
    const cli = f.cliCheck();
    assert.equal(cli.status, 0, name + ': --check exit code');
    assert.match(cli.stdout, /roadmap overview: fresh/);
  }
});

test('F1-T21 different content keeps the WARN in every line ending, and --check keeps exit 1', t => {
  const f = overviewFixture(t), output = f.generated();
  const changed = output.replace('another item', 'another  item');
  assert.notEqual(changed, output);
  for (const [name, stored] of [['LF', changed], ['CRLF', crlf(changed)]]) {
    fs.writeFileSync(f.overviewPath(), stored);
    const found = f.stale();
    assert.deepEqual(found.map(x => [x.severity, x.file, x.message]), [['WARN', f.config.caps.roadmapOverview.path, 'stale or missing; regenerate with roadmap-overview.mjs --write']], name);
    const cli = f.cliCheck();
    assert.equal(cli.status, 1, name + ': --check exit code');
    assert.match(cli.stdout, /roadmap overview: stale or missing/);
  }
  // Missing overview: both say stale.
  fs.rmSync(f.overviewPath());
  assert.equal(f.stale().length, 1);
  assert.equal(f.cliCheck().status, 1);
});

test('F1-T22 the gate and --check agree on every ending: only CRLF is normalised, a lone CR is a real difference', t => {
  const f = overviewFixture(t), output = f.generated();
  assert.ok(output.includes('- one item\n- another item'), 'fixture line for the lone CR case');
  const cases = {
    'same': output, 'crlf': crlf(output), 'lone CR': output.replace('- one item\n', '- one item\r'), 'crlf plus trailing CR': crlf(output) + '\r',
    'no final newline': output.replace(/\n$/, ''), 'bom + crlf': String.fromCharCode(0xFEFF) + crlf(output), 'real change': output + 'extra\n',
  };
  const verdicts = {};
  for (const [name, stored] of Object.entries(cases)) {
    fs.writeFileSync(f.overviewPath(), stored);
    const gateStale = f.stale().length === 1, checkStale = f.cliCheck().status === 1;
    assert.equal(gateStale, checkStale, name + ': the gate and --check give one answer');
    verdicts[name] = gateStale;
  }
  assert.deepEqual(verdicts, {'same': false, 'crlf': false, 'lone CR': true, 'crlf plus trailing CR': true, 'no final newline': true, 'bom + crlf': false, 'real change': true});
});

test('F1-T23 a CRLF roadmap: the overview the writer made, then stored with all-LF or all-CRLF endings, stays fresh for the gate and --check', t => {
  const f = overviewFixture(t);
  // A roadmap with Windows line endings: the generated text carries a carriage return inside its release lines, so it
  // is neither all-LF nor all-CRLF, while a checkout or an editor stores the overview in one ending or the other.
  f.put(f.config.caps.roadmap.path, crlf(fs.readFileSync(f.roadmapPath(), 'utf8')));
  const output = f.generated();
  assert.ok(output.includes('\r') && output.includes('\n'), 'the generated text keeps carriage returns from the roadmap');
  const kit = path.join(kitRoot, 'engine/roadmap-overview.mjs');
  const written = spawnSync(process.execPath, [kit, '--write', '--repo', f.repo], {encoding: 'utf8'});
  assert.equal(written.status, 0, written.stderr);
  assert.deepEqual(f.stale(), [], 'as the writer left it');
  for (const [name, stored] of [['all-LF', output.replace(/\r\n/g, '\n')], ['all-CRLF', crlf(output)]]) {
    fs.writeFileSync(f.overviewPath(), stored);
    assert.deepEqual(f.stale(), [], name + ': the gate agrees with --check');
    assert.equal(f.cliCheck().status, 0, name);
  }
});

test('F1-T24 an overview path that is a folder is an error in the gate and in --check, not a stale verdict', t => {
  const f = overviewFixture(t);
  fs.mkdirSync(f.overviewPath(), {recursive: true});
  const found = f.stale();
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'WARN');
  assert.match(found[0].message, /^roadmap overview is not a regular file$/);
  assert.doesNotMatch(found[0].message, /stale or missing/);
  const cli = f.cliCheck();
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /^roadmap-overview: roadmap overview is not a regular file/);
});
