import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fixture, put, json, kitRoot, tree, ok, read} from './helpers.mjs';
import {generateMemoryIndex} from '../engine/memory-index.mjs';
import {measure} from '../engine/memory-measure.mjs';
import {runCheck} from '../engine/memory-check.mjs';

function catalogFixture(t) {
  const f = fixture(t), memoryDir = path.join(f.root, 'memory');
  put(path.join(memoryDir, 'MEMORY.md'), '# Memory\n- [Build](INDEX-build.md) Build lessons.\n');
  const config = json(path.join(kitRoot, 'engine/memory.config.json'));
  config.caps.index.hotBytes = 350;
  for (let i = 1; i <= 12; i++) put(path.join(memoryDir, `lesson-${String(i).padStart(3, '0')}-build.md`),
    `---\nname: Build ${i}\ndescription: Build lesson ${i}\ntype: reference\nroute: build\n---\nBuild details ${i}.\n`);
  const {pages} = generateMemoryIndex({memoryDir, config});
  for (const [file, text] of Object.entries(pages)) put(path.join(memoryDir, file), text);
  const probesFile = put(path.join(f.root, 'probes.json'), JSON.stringify({version: 1, minPass: 0, probes: [{id: 'oldest', q: 'Build details', expect: ['lesson-001-build.md']}]}));
  return {...f, memoryDir, repo: f.target, config, probesFile, noGit: true};
}

test('oldest generated lesson is reachable through catalog with all path bytes', t => {
  const f = catalogFixture(t), p = measure(f).recall.probes[0];
  assert.equal(p.ladderFile, 'lesson-001-build.md');
  assert.equal(p.ladderHop, 'catalog');
  assert.equal(p.ladderBytes, ['MEMORY.md', 'INDEX-build.md', 'INDEX-build-all.md', p.ladderFile]
    .reduce((n, file) => n + fs.statSync(path.join(f.memoryDir, file)).size, 0));
});

test('gate agrees with catalog walk and warns about a routed missing lesson', t => {
  const f = catalogFixture(t);
  assert.equal(runCheck(f).findings.filter(x => x.check === 'index.unreachable').length, 0);
  for (const file of ['INDEX-build.md', 'INDEX-build-all.md']) {
    const p = path.join(f.memoryDir, file);
    put(p, fs.readFileSync(p, 'utf8').split('\n').filter(line => !line.includes('lesson-001-build.md')).join('\n'));
  }
  assert.equal(measure(f).recall.probes[0].ladderFile, null);
  const findings = runCheck(f).findings.filter(x => x.check === 'index.unreachable');
  assert.deepEqual(findings.map(x => [x.severity, x.file]), [['WARN', 'lesson-001-build.md']]);
});

test('fleet reports projects and orphans without changing any fixture bytes or exposing exclusions', t => {
  const f = fixture(t), home = path.join(f.root, 'memories');
  put(path.join(f.target, 'scripts/memory/KIT.json'), JSON.stringify({version: '0.1.0'}));
  const slug = f.target.replace(/[^A-Za-z0-9]/g, '-');
  put(path.join(home, slug, 'memory/MEMORY.md'), '# Memory\n');
  put(path.join(home, 'missing-project', 'memory/MEMORY.md'), '# Orphan\n');
  put(path.join(home, 'SECRET-project', 'memory/MEMORY.md'), '# Excluded\n');
  const hashes = () => Object.fromEntries(Object.entries(tree(f.root, {git: true})).map(([file, bytes]) => [file, createHash('sha256').update(Buffer.from(bytes, 'base64')).digest('hex')]));
  const before = hashes();
  const r = ok(f.cli('engine/memory-fleet.mjs', ['--root', f.root, '--memory-home', home, '--exclude', 'SECRET', '--json']));
  const result = JSON.parse(r.stdout);
  assert.equal(result.excluded, 1);
  assert.doesNotMatch(r.stdout, /SECRET/i);
  assert.deepEqual(result.projects.map(p => p.status).sort(), ['behind', 'orphan memory']);
  assert.equal(result.projects.find(p => p.status === 'behind').gate.source, 'kit gate');
  assert.deepEqual(hashes(), before);
});

test('ledger evaluates dormant fired never unknown and consecutive evidence', async () => {
  const {evaluateUpgrades} = await import('../engine/memory-fleet.mjs');
  const entry = {id: 'search', title: 'Search', verdict: 'trigger', scope: 'project', reason: 'Recall', trigger: {metric: 'recall.totals.searchHitRate', op: '<', value: 0.8}};
  const metric = n => ({recall: {totals: {searchHitRate: n}}});
  const state = (e, current, history = []) => evaluateUpgrades([e], 'project', current, history)[0].state;
  assert.equal(state(entry, metric(1)), 'DORMANT');
  assert.equal(state(entry, metric(0.5)), 'FIRED');
  assert.equal(state({...entry, verdict: 'never'}, {}), 'NEVER');
  assert.equal(state(entry, {}), 'UNKNOWN');
  const twice = {...entry, trigger: {...entry.trigger, consecutive: 2}};
  assert.equal(state(twice, metric(0.5)), 'UNKNOWN');
  assert.equal(state(twice, metric(0.5), [metric(0.4)]), 'FIRED');
  assert.equal(state(twice, metric(0.5), [metric(1)]), 'DORMANT');
});

test('malformed ledger produces config.upgrades FAIL instead of crashing', t => {
  const f = catalogFixture(t), upgradesFile = put(path.join(f.root, 'upgrades.json'), '{broken');
  const findings = runCheck({...f, upgradesFile}).findings;
  assert.ok(findings.some(x => x.check === 'config.upgrades' && x.severity === 'FAIL'));
});

for (const [script, args] of [['memory-index', []], ['brain-index', []], ['roadmap-overview', []], ['memory-rotate', ['log']], ['memory-rotate', ['roadmap']]])
  test(`missing input: ${script} ${args.join(' ')} exits zero without writes`, t => {
    const f = fixture(t), before = tree(f.root, {git: true});
    ok(f.cli(`engine/${script}.mjs`, [...args, '--repo', f.target, '--memory-dir', path.join(f.root, 'absent-memory'), '--write']));
    assert.deepEqual(tree(f.root, {git: true}), before);
  });

test('install adds one AGENTS import to an existing CLAUDE file', t => {
  const f = fixture(t);
  put(path.join(f.target, 'CLAUDE.md'), '# Instructions\n');
  ok(f.install());
  assert.equal(read(path.join(f.target, 'CLAUDE.md')), '# Instructions\n\n' + '@AGENTS.md\n');
  const g = fixture(t);
  put(path.join(g.target, 'CLAUDE.md'), '# Instructions\n' + '@AGENTS.md\n');
  ok(g.install());
  assert.equal(read(path.join(g.target, 'CLAUDE.md')).match(/^@AGENTS.md$/gm).length, 1);
});

test('first-install memory label and shared-parser help are already accurate', t => {
  const f = fixture(t), result = ok(f.cli('scripts/install.mjs', ['--help']));
  assert.match(result.stdout, /--memory-dir <MEMORY>\s+Use this private memory directory/);
  for (const flag of ['--restore', '--force-skills', '--check', '--backup', '--dry-run']) assert.ok(result.stdout.includes(flag));
});

test('install brain tests do not resolve home in the parent process', () => {
  assert.doesNotMatch(read(path.join(kitRoot, 'tests/install.test.mjs')), /import \{install\} from/);
});

test('how-it-works guide ships six light/dark diagrams and real sanitized install output', () => {
  const file = path.join(kitRoot, 'docs/HOW-IT-WORKS.md');
  assert.ok(fs.existsSync(file), 'guide exists');
  const guide = read(file);
  assert.ok(Buffer.byteLength(guide) < 25 * 1024);
  assert.doesNotMatch(guide, /Delivery status|pending rendering|installer was previewed|demo\/transcript/);
  assert.equal((guide.match(/<picture>/g) ?? []).length, 6);
  assert.equal((guide.match(/prefers-color-scheme: dark/g) ?? []).length, 6);
  assert.match(guide, /memory gate hook installed: ~\/memory\/\.git\/hooks\/pre-commit/);
  for (const name of ['memory-architecture', 'session-sequence', 'lesson-lifecycle', 'records-lifecycle', 'gate-dataflow', 'where-things-live']) {
    assert.ok(fs.existsSync(path.join(kitRoot, 'docs/diagrams', name + '.json')));
    for (const theme of ['light', 'dark']) {
      const png = fs.readFileSync(path.join(kitRoot, `docs/diagrams/png/${name}.${theme}.png`));
      assert.equal(png.readUInt32BE(16), 1440); assert.equal(png.readUInt32BE(20), 900);
    }
  }
  for (const href of [...guide.replace(/```[^]*?```/g, '').matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)|(?:src|srcset)="([^"#]+)"/g)].map(m => m[1] ?? m[2]))
    if (!/^https?:/.test(href)) assert.ok(fs.existsSync(path.resolve(path.dirname(file), href)), href);
});

test('fleet does not read a kit through an out-of-root directory junction', async t => {
  const {fleet} = await import('../engine/memory-fleet.mjs');
  const f = fixture(t), outside = fixture(t), home = path.join(f.root, 'memories');
  put(path.join(outside.root, 'scripts/memory/KIT.json'), '{"version":"0.0.1"}');
  fs.symlinkSync(path.join(outside.root, 'scripts'), path.join(f.target, 'scripts'), 'junction');
  put(path.join(home, f.target.replace(/[^A-Za-z0-9]/g, '-'), 'memory/MEMORY.md'), '# Memory\n');
  const result = fleet({roots: [f.root], memoryHome: home, localFile: path.join(f.root, 'absent.json')});
  assert.equal(result.projects[0].kitVersion, '-');
});

test('measurement human report includes the finding hop', t => {
  const f = catalogFixture(t);
  const r = ok(f.cli('engine/memory-measure.mjs', ['--repo', f.repo, '--memory-dir', f.memoryDir, '--probe', f.probesFile, '--no-git']));
  assert.match(r.stdout, /\| catalog \|/);
});

test('installed local fleet preferences are ignored and the ledger is shipped', t => {
  const f = fixture(t); ok(f.install());
  assert.match(read(path.join(f.target, 'scripts/memory/.gitignore')), /^fleet\.local\.json$/m);
  assert.deepEqual(json(path.join(f.target, 'scripts/memory/upgrades.json')), json(path.join(kitRoot, 'engine/upgrades.json')));
});

test('project triggers read earlier write outputs from the same evidence folder', t => {
  const f = catalogFixture(t);
  put(f.probesFile, JSON.stringify({version: 1, minPass: 0, probes: [{id: 'miss', q: 'nonexistentword', expect: ['missing.md']}]}));
  const args = ['--repo', f.repo, '--memory-dir', f.memoryDir, '--probe', f.probesFile, '--no-git', '--json'];
  const first = JSON.parse(ok(f.cli('engine/memory-measure.mjs', [...args, '--write', 'first'])).stdout);
  assert.equal(first.upgrades.find(e => e.id === 'vector-search').state, 'UNKNOWN');
  const second = JSON.parse(ok(f.cli('engine/memory-measure.mjs', [...args, '--write', 'second'])).stdout);
  assert.equal(second.upgrades.find(e => e.id === 'vector-search').state, 'FIRED');
  assert.equal(second.upgrades.find(e => e.id === 'search-whole-files').state, 'FIRED');
});

test('fleet ledger thresholds and exclusion defaults are evaluated without opening excluded folders', async t => {
  const {fleet, loadUpgrades, evaluateUpgrades} = await import('../engine/memory-fleet.mjs');
  const entries = loadUpgrades(), metrics = {fleet: {tinyIndexProjects: 2, maxWarnProjects: 3, committedFailProjects: 1}};
  assert.deepEqual(evaluateUpgrades(entries, 'fleet', metrics).map(e => e.state), ['FIRED', 'FIRED', 'FIRED']);
  assert.deepEqual(evaluateUpgrades(entries, 'fleet', {fleet: {tinyIndexProjects: 1, maxWarnProjects: 2, committedFailProjects: 0}}).map(e => e.state), ['DORMANT', 'DORMANT', 'DORMANT']);
  assert.deepEqual(evaluateUpgrades(entries, 'fleet', {}).map(e => e.state), ['UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
  const f = fixture(t), excludedProject = path.join(f.root, 'excluded-project'); fs.mkdirSync(excludedProject);
  const localFile = put(path.join(f.root, 'fleet.local.json'), JSON.stringify({roots: [f.root], exclude: ['EXCLUDED']}));
  const realRead = fs.readFileSync, realList = fs.readdirSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => { assert.ok(!String(file).includes(excludedProject)); return realRead(file, ...args); });
  t.mock.method(fs, 'readdirSync', (file, ...args) => { assert.ok(!String(file).includes(excludedProject)); return realList(file, ...args); });
  const result = fleet({localFile, memoryHome: path.join(f.root, 'absent')});
  assert.equal(result.excluded, 1);
  assert.ok(!JSON.stringify(result).includes('excluded-project'));
});
