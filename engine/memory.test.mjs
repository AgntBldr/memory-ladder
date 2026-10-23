import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import childProcess, { spawnSync } from 'node:child_process';
import { loadConfig, toolDir, parseFrontmatter, fmGet, mdLinks, wikilinks, walkMd, utf8Bytes, brainPaths, memoryDir, memorySlug, isDirect, pathKey, read, memoryFiles } from './lib.mjs';
import { runCheck, ratchetPins, writeAllowlist, findingLine, redact, main as checkMain } from './memory-check.mjs';
import { buildCorpus, search, runProbes, tokenize, humanResults } from './memory-recall.mjs';

test('kit memory precedence is flag, environment, receipt, then isolated home', async t => {
  const f = fixture(t), { locations } = await import('./lib.mjs');
  const homeMemory = path.join(f.root, '.claude/projects', memorySlug(f.repo), 'memory');
  fs.mkdirSync(homeMemory, { recursive: true });
  assert.equal(memoryDir(f.repo), homeMemory);
  f.putRepo('scripts/memory/KIT.local.json', JSON.stringify({ memoryDir: f.memoryDir }));
  assert.equal(memoryDir(f.repo), f.memoryDir);
  process.env.CLAUDE_MEMORY_DIR = path.join(f.root, 'environment');
  assert.equal(memoryDir(f.repo), process.env.CLAUDE_MEMORY_DIR);
  assert.equal(locations({ repo: f.repo, 'memory-dir': homeMemory }).memoryDir, homeMemory);
});

test('kit absent optional repo paths produce no findings; existing paths retain caps', t => {
  const f = fixture(t), optional = /^(repo\.(brain-log|brain-index|roadmap|roadmap-overview)|shelf\.|kit\.manifest)/;
  assert.deepEqual(f.check('all').findings.filter(x => optional.test(x.check)), []);
  for (const [key, id] of [['brainLog', 'repo.brain-log'], ['roadmap', 'repo.roadmap']]) {
    f.putRepo(f.config.caps[key].path, 'x'.repeat(f.config.caps[key].failBytes + 1));
    finding(f.check('all'), id, 'FAIL');
  }
  f.putRepo(f.config.caps.brainIndex.path, '# Existing');
  finding(f.check('all'), 'repo.brain-index', 'WARN');
  f.putRepo(f.config.caps.roadmapOverview.path, '# Stale');
  finding(f.check('all'), 'repo.roadmap-overview', 'WARN');
  f.putRepo(f.config.caps.shelf.path + '/old.md', '---\nstatus: shelved\nshelved: 2026-01-01\nreview: 2026-01-02\n---\n');
  finding(f.check('all'), 'shelf.review-due', 'WARN');
});

test('kit manifest hashes all owned entries, warns on missing or edited files and skill versions', async t => {
  const f = fixture(t), { createHash } = await import('node:crypto');
  const file = 'scripts/memory/owned.mjs', text = 'export const x = 1;\n';
  f.putRepo(file, text);
  f.putRepo('scripts/memory/KIT.json', JSON.stringify({ version: '3.1.0' }));
  finding(f.check('all'), 'kit.manifest', 'WARN', 'scripts/memory/MANIFEST.json');
  f.putRepo('scripts/memory/MANIFEST.json', JSON.stringify({ files: { [file]: createHash('sha256').update(text).digest('hex') } }));
  for (const name of ['memory-ladder', 'memory-review']) f.putRepo('.claude/skills/' + name + '/SKILL.md', '---\nengine_version: "3.1.0"\n---\n');
  assert.deepEqual(f.check('all').findings.filter(x => x.check === 'kit.manifest'), []);
  f.putRepo(file, 'edited');
  assert.equal(finding(f.check('all'), 'kit.manifest', 'WARN', file).message, 'edited locally: ' + file);
  fs.unlinkSync(path.join(f.repo, file));
  finding(f.check('all'), 'kit.manifest', 'WARN', file);
  f.putRepo('.claude/skills/memory-review/SKILL.md', '---\nengine_version: "3.0.0"\n---\n');
  assert.equal(finding(f.check('all'), 'kit.manifest', 'WARN', '.claude/skills/memory-review/SKILL.md').message, 'kit version 3.1.0, skills 3.0.0');
  assert.deepEqual(f.check('memory').findings.filter(x => x.check === 'kit.manifest'), []);
  f.config.allow.push({ check: 'kit.manifest', file: '*', reason: 'Fixture local customization', added: '2026-10-22' });
  assert.ok(!f.check('memory').findings.some(x => x.check === 'config.allow-stale' && x.message.includes('kit.manifest')));
  fs.unlinkSync(path.join(f.repo, 'scripts/memory/KIT.json'));
  assert.deepEqual(f.check('all').findings.filter(x => x.check === 'kit.manifest'), []);
});

test('kit migration custom source keeps stub name and nested fences preserve complete lesson body', async t => {
  const { migrateLessons, splitLessons } = await import('./memory-migrate.mjs'), f = fixture(t);
  const body = '**1. Outer**\r\n````markdown\r\n```js\r\n## 99. Not a lesson\r\n```\r\n~~~\r\n## 98. Still fenced\r\n~~~\r\n````\r\n## 2. Next\r\nBody.\r\n';
  f.put('custom-lessons.md', body);
  const split = splitLessons(body); assert.deepEqual(split.lessons.map(l => l.id), ['1', '2']);
  assert.equal(split.lessons.map(l => l.body).join(''), body);
  const r = migrateLessons({ memoryDir: f.memoryDir, source: 'custom-lessons.md', write: true });
  assert.equal(r.numbered, 2);
  assert.match(read(path.join(f.memoryDir, 'custom-lessons.md')), /moved_to:/);
  assert.ok(!fs.existsSync(path.join(f.memoryDir, 'lessons.md')));
});

test('kit measure writes configured evidence directory and default fallback', t => {
  const f = fixture(t), engine = path.join(f.repo, 'scripts/memory');
  fs.cpSync(toolDir, engine, { recursive: true });
  const configFile = path.join(engine, 'memory.config.json');
  for (const configured of [true, false]) {
    const config = structuredClone(f.config);
    if (configured) config.measure.evidenceDir = 'custom-evidence'; else delete config.measure.evidenceDir;
    fs.writeFileSync(configFile, JSON.stringify(config));
    const probes = f.probes([]), label = configured ? 'configured' : 'default';
    const r = spawnSync(process.execPath, [path.join(engine, 'memory-measure.mjs'), '--repo', f.repo, '--memory-dir', f.memoryDir, '--probe', probes, '--write', label], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const dir = path.join(f.repo, configured ? 'custom-evidence' : 'docs/evidence/memory');
    assert.equal(fs.readdirSync(dir).filter(n => n.endsWith('-' + label + '.json') || n.endsWith('-' + label + '.md')).length, 2);
  }
});

test('fix1 topic backgrounds are reachable without archive part entries', t => {
  const f = fixture(t);
  f.put('ARCHIVE.md', '# Archive\n- [Parent](parent.md)\n');
  f.put('parent.md', f.topic('parent', 'Topic', '', '[Background](parent-background.md)'));
  f.put('parent-background.md', f.topic('parent-background', 'Dated context', 'parent: parent.md\n', '[Next](parent-background-2.md)'));
  f.put('parent-background-2.md', f.topic('parent-background-2', 'Dated context', 'parent: parent.md\n', '[Parent](parent.md)'));
  const result = f.check();
  assert.ok(!result.findings.some(x => x.check === 'link.orphan' && x.file.startsWith('parent')));
  fs.unlinkSync(path.join(f.memoryDir, 'parent-background-2.md'));
  finding(f.check(), 'link.dead', 'FAIL', 'parent-background.md');
});

test('fix1 unrooted topic cycles remain orphans', t => {
  const f = fixture(t);
  f.put('island.md', f.topic('island', 'Topic', '', '[Other](island-background.md)'));
  f.put('island-background.md', f.topic('island-background', 'Context', '', '[Parent](island.md)'));
  finding(f.check(), 'link.orphan', 'WARN', 'island.md');
  finding(f.check(), 'link.orphan', 'WARN', 'island-background.md');
});
import { measure, readable } from './memory-measure.mjs';
import { snapshot, verify, distinctiveTokens } from './memory-conserve.mjs';
import * as conserve from './memory-conserve.mjs';
import { install, marker } from './install-hooks.mjs';

// Stage 3 contracts: fixtures only; production implementations are loaded lazily
// so absent CLIs produce individual red tests rather than hiding the suite.
const stage3Module = name => import(pathToFileURL(path.join(toolDir, name)).href);
function stage3Config(f) {
  f.config.caps.shelf = { path: 'docs/shelf', reviewDays: 90 };
  f.config.caps.brainShared = { paths: ['brain/_shared/'] };
  f.config.caps.roadmapOverview = { path: 'docs/ROADMAP-OVERVIEW.md' };
  Object.assign(f.config.caps.brainIndex, { allPath: 'brain/00-system/index-all.md', maxBytes: 12288 });
  f.config.caps.brainLog.keepEntries = 20;
  return f;
}
const stage3Node = (id, extra = '') => `---\nid: ${id}\ntype: concept\nstatus: active\nupdated: 2026-10-22\nsummary: Useful summary\n${extra}---\nBody.\n`;

test('stage3 rotate routes out-of-order months, preserves bytes and preamble, appends and is idempotent', async t => {
  const f = stage3Config(fixture(t)), { rotateLog } = await stage3Module('memory-rotate.mjs');
  const preamble = '# Log\n\n', entries = ['## [2026-07-02] One\nπ  \n\n', '## [2026-06-01] Two\n\n', '## [2026-07-01] Three\n', '## [2026-10-22] Four\n'];
  f.putRepo('brain/00-system/log.md', preamble + entries.join(''));
  f.putRepo('brain/00-system/log-2026-07.md', '# Existing\n\n');
  const opts = { repo: f.repo, config: f.config, keep: 1 };
  const dry = rotateLog(opts);
  assert.equal(dry.kept, 1); assert.equal(dry.moved, 3);
  assert.equal(fs.readFileSync(path.join(f.repo, 'brain/00-system/log.md'), 'utf8'), preamble + entries.join(''));
  const result = rotateLog({ ...opts, write: true });
  assert.equal(result.destinations.reduce((n, d) => n + d.bytes, 0) + utf8Bytes(entries[3]), utf8Bytes(entries.join('')));
  assert.equal(fs.readFileSync(path.join(f.repo, 'brain/00-system/log.md'), 'utf8'), preamble + entries[3]);
  assert.equal(fs.readFileSync(path.join(f.repo, 'brain/00-system/log-2026-07.md'), 'utf8'), '# Existing\n\n' + entries[0] + entries[2]);
  assert.equal(fs.readFileSync(path.join(f.repo, 'brain/00-system/log-2026-06.md'), 'utf8'), '# Operation log — 2026-06\n\nRotated from log.md by scripts/memory/memory-rotate.mjs; append-only; the newest entries are in log.md.\n\n' + entries[1]);
  assert.equal(rotateLog({ ...opts, write: true }).moved, 0);
});
test('stage3 rotate CLI keep override and default keep, JSON and nothing to rotate', t => {
  const f = fixture(t);
  f.putRepo('brain/00-system/log.md', '# Log\n' + Array.from({ length: 22 }, (_, i) => `## [2026-10-22] ${i}\n`).join(''));
  const dry = f.cli('memory-rotate.mjs', ['log', '--json']);
  assert.equal(dry.status, 0, dry.stderr); assert.equal(JSON.parse(dry.stdout).kept, 20);
  assert.equal(f.cli('memory-rotate.mjs', ['log', '--keep', '2', '--write']).status, 0);
  const second = f.cli('memory-rotate.mjs', ['log', '--keep', '2']);
  assert.equal(second.status, 0); assert.match(second.stdout, /nothing to rotate/);
});
test('stage3 rotate invalid dates name the line and refuse all writes', async t => {
  const f = stage3Config(fixture(t)), { rotateLog } = await stage3Module('memory-rotate.mjs');
  for (const date of ['2026-02-30', '2026-13-01', 'not-a-date']) {
    const text = `# Log\n## [2026-01-01] Valid\n## [${date}] Invalid\n`;
    f.putRepo('brain/00-system/log.md', text);
    assert.throws(() => rotateLog({ ...f, keep: 0, write: true }), /line 3/);
    assert.equal(fs.readFileSync(path.join(f.repo, 'brain/00-system/log.md'), 'utf8'), text);
    assert.ok(!fs.existsSync(path.join(f.repo, 'brain/00-system/log-2026-01.md')));
  }
});
test('stage3 rotate ignores nested backtick and tilde fenced headings', async t => {
  const f = stage3Config(fixture(t)), { rotateLog } = await stage3Module('memory-rotate.mjs');
  const text = '# Log\n## [2026-07-01] One\n````md\n## [invalid] hidden\n```\n## [2025-01-01] hidden too\n````\n~~~\n## [invalid] hidden\n~~~\n## [2026-10-22] Two\n';
  f.putRepo('brain/00-system/log.md', text);
  assert.equal(rotateLog({ ...f, keep: 1 }).moved, 1);
});
for (const [today, due] of [['2027-01-19', false], ['2027-01-20', true], ['2027-01-21', true]]) {
  test(`stage3 shelf review ${today}`, t => {
    const f = stage3Config(fixture(t));
    f.putRepo('docs/shelf/nested/program.md', '---\nstatus: shelved\nshelved: 2026-10-22\nreview: 2027-01-20\n---\nProgram\n');
    const r = runCheck({ ...f, scope: 'all', today });
    const found = r.findings.filter(x => x.check === 'shelf.review-due');
    assert.equal(found.length, due ? 1 : 0);
    if (due) { assert.equal(found[0].severity, 'WARN'); assert.equal(found[0].message, 'review due 2027-01-20 (shelved 2026-10-22)'); }
  });
}
test('stage3 shelf rejects missing and invalid fields, absent shelf is quiet, today CLI', t => {
  const f = stage3Config(fixture(t));
  assert.ok(!runCheck({ ...f, scope: 'all' }).findings.some(x => x.check.startsWith('shelf.')));
  for (const [key, value] of [['review', ''], ['review', '2027-02-30'], ['shelved', 'bad'], ['status', 'active']]) {
    const data = { status: 'shelved', shelved: '2026-10-22', review: '2027-01-20', [key]: value };
    f.putRepo('docs/shelf/program.md', '---\n' + Object.entries(data).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\n');
    assert.match(finding(runCheck({ ...f, scope: 'all' }), 'shelf.frontmatter', 'FAIL').message, new RegExp(key));
  }
  f.putRepo('docs/shelf/program.md', '---\nstatus: shelved\nshelved: 2026-10-22\nreview: 2027-01-20\n---\n');
  const r = f.cli('memory-check.mjs', ['--today', '2027-01-20', '--json']);
  finding(JSON.parse(r.stdout), 'shelf.review-due', 'WARN');
});
test('stage3 shared unresolved edges are external; local edges still warn; other checks still run', t => {
  const f = stage3Config(fixture(t));
  f.putRepo('brain/_shared/patterns/cpt-shared.md', stage3Node('cpt-shared', 'supports: ["[[pil-other]]"]\nstatus: active\n'));
  let result = runCheck({ ...f, scope: 'all' });
  assert.deepEqual(result.externalEdges, [{ file: 'brain/_shared/patterns/cpt-shared.md', key: 'supports', target: 'pil-other' }]);
  assert.ok(!result.findings.some(x => x.check === 'brain.edge')); finding(result, 'fm.parse', 'WARN');
  f.putRepo('brain/03-knowledge/process/cpt-local.md', stage3Node('cpt-local', 'supports: ["[[pil-other]]"]\n'));
  finding(runCheck({ ...f, scope: 'all' }), 'brain.edge', 'WARN', 'brain/03-knowledge/process/cpt-local.md');
  assert.match(f.cli('memory-check.mjs').stdout, /1 external edges in shared folders \(owned by the shared core; see --json externalEdges\)/);
  assert.doesNotMatch(f.cli('memory-check.mjs', ['--session-start']).stdout, /external edges/);
});
test('stage3 overview deterministic release continuations, lists, programs, sorted shelf and history', async t => {
  const f = stage3Config(fixture(t)), { generateOverview } = await stage3Module('roadmap-overview.mjs');
  f.putRepo('docs/ROADMAP.md', '# Roadmap\nLast updated: 2026-10-22\n  continuation\nCurrent release candidate: v1\n\n## Open work (today)\n### Needs action\n- **One**\n  - nested\n2. ' + 'x'.repeat(150) + '\n### Own work\n- Two\n## Active — program\n');
  f.putRepo('docs/ROADMAP-HISTORY.md', '# History\n## First\ntext\n## Last\n');
  for (const name of ['zeta', 'alpha']) f.putRepo(`docs/shelf/${name}.md`, `---\nname: ${name}\nshelved: 2026-10-22\nreview: 2027-01-20\nmoved_from: source-${name}\n---\n`);
  const result = generateOverview(f);
  assert.equal(result, generateOverview(f));
  assert.match(result, /Last updated: 2026-10-22\n  continuation\nCurrent release candidate: v1/);
  assert.match(result, /### Needs action \(2 items\)\n- One\n2\. x{137}…/);
  assert.match(result, /### Own work \(1 item\)/); assert.match(result, /- Active — program/);
  assert.ok(result.indexOf('| alpha |') < result.indexOf('| zeta |'));
  assert.match(result, /holds 2 sections; first "First", last "Last"/);
});
test('stage3 missing overview warns when source exists; write makes fresh, check does not write', async t => {
  const f = stage3Config(fixture(t));
  f.putRepo('docs/ROADMAP.md', '# Roadmap\n');
  finding(runCheck({ ...f, scope: 'all' }), 'repo.roadmap-overview', 'WARN');
  assert.equal(f.cli('roadmap-overview.mjs', ['--check']).status, 1);
  assert.equal(f.cli('roadmap-overview.mjs', ['--write']).status, 0);
  assert.equal(f.cli('roadmap-overview.mjs', ['--check']).status, 0);
  assert.ok(!runCheck({ ...f, scope: 'all' }).findings.some(x => x.check === 'repo.roadmap-overview'));
  f.putRepo('docs/ROADMAP-OVERVIEW.md', 'stale');
  finding(runCheck({ ...f, scope: 'all' }), 'repo.roadmap-overview', 'WARN');
  assert.equal(f.cli('roadmap-overview.mjs', ['--check']).status, 1);
  assert.equal(fs.readFileSync(path.join(f.repo, 'docs/ROADMAP-OVERVIEW.md'), 'utf8'), 'stale');
});
test('stage3 index preserves frontmatter, uses node dates, counts, sorts and emits all nodes', async t => {
  const f = stage3Config(fixture(t)), { generateIndex } = await stage3Module('brain-index.mjs');
  const fm = '---\ncustom: "verbatim"\nupdated: 2000-01-01\n---';
  f.putRepo('brain/00-system/index.md', fm + '\nold');
  f.putRepo('brain/00-system/agents-background.md', '# Agent background\n');
  f.putRepo('brain/01-pillars/pil-example.md', stage3Node('pil-example').replace('type: concept', 'type: pillar'));
  for (const id of ['cpt-b', 'cpt-a', 'cpt-c', 'cpt-d']) f.putRepo(`brain/03-knowledge/process/${id}.md`, stage3Node(id));
  f.putRepo('brain/02-projects/prj-one.md', stage3Node('prj-one').replace('type: concept', 'type: project'));
  f.putRepo('brain/02-projects/tsk-one.md', stage3Node('tsk-one').replace('type: concept', 'type: task').replace('status: active', 'status: done'));
  f.putRepo('brain/02-projects/evt-one.md', stage3Node('evt-one').replace('type: concept', 'type: event'));
  f.putRepo('brain/_templates/cpt-hidden.md', stage3Node('cpt-hidden'));
  f.putRepo('brain/_shared/patterns/cpt-shared.md', stage3Node('cpt-shared'));
  const r = generateIndex(f);
  assert.ok(r.index.startsWith(fm.replace('2000-01-01', '2026-10-22')));
  assert.match(r.index, /9 typed nodes; 1 knowledge domains/);
  assert.match(r.index, /Tasks: 1 \(1 done\/completed\/archived\). Events: 1/);
  assert.match(r.index, /\*\*process\*\* \(4\): \[\[cpt-a\]\], \[\[cpt-b\]\], \[\[cpt-c\]\]/);
  assert.match(r.index, /\[agents-background.md\]\(agents-background.md\)/);
  assert.match(r.all, /\[\[cpt-d\]\]/); assert.doesNotMatch(r.all, /cpt-hidden/);
  assert.deepEqual(r, generateIndex(f));
});
test('K.8 index defaults link existing system pages including the memory ladder', async t => {
  const f = fixture(t), { generateIndex } = await stage3Module('brain-index.mjs');
  const names = ['AGENTS.md', 'schema.md', 'edge-cases.md', 'skills-index.md', 'log.md', 'index-all.md', 'agents-background.md', 'memory-ladder.md'];
  for (const name of names) f.putRepo('brain/00-system/' + name, '# System page\n');
  for (const fallback of [false, true]) {
    if (fallback) delete f.config.caps.brainIndex.systemFiles;
    const system = generateIndex(f).index.split('## System\n')[1].split('\n\n## Pillar')[0];
    assert.equal(system, names.map(name => `- [${name}](${name})`).join('\n'));
  }
});

test('K.8 index omits every missing system page in configured and fallback lists', async t => {
  const f = fixture(t), { generateIndex } = await stage3Module('brain-index.mjs');
  f.putRepo('brain/00-system/AGENTS.md', '# System rules\n');
  for (const fallback of [false, true]) {
    if (fallback) delete f.config.caps.brainIndex.systemFiles;
    const output = generateIndex(f).index;
    assert.equal(output.split('## System\n')[1].split('\n\n## Pillar')[0], '- [AGENTS.md](AGENTS.md)');
    assert.doesNotMatch(output, /memory-ladder\.md/);
  }
});

test('K.8 config default places memory ladder after agents background', () => {
  const names = loadConfig().caps.brainIndex.systemFiles;
  assert.equal(names[names.indexOf('agents-background.md') + 1], 'memory-ladder.md');
});

test('K.8 first index write counts the generated all-nodes link before accepting the byte cap', async t => {
  const f = fixture(t), { generateIndex } = await stage3Module('brain-index.mjs');
  const original = '# Template index\n';
  f.putRepo('brain/00-system/index.md', original);
  f.config.caps.brainIndex.maxBytes = utf8Bytes(generateIndex(f).index);
  const config = f.putRepo('config.json', JSON.stringify(f.config));
  const result = f.cli('brain-index.mjs', ['--write', '--config', config]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exceeds/);
  assert.equal(read(path.join(f.repo, 'brain/00-system/index.md')), original);
  assert.ok(!fs.existsSync(path.join(f.repo, 'brain/00-system/index-all.md')));
});

test('stage3 index stale and fresh gate, CLI check, byte cap refuses both outputs', async t => {
  const f = stage3Config(fixture(t)), { generateIndex } = await stage3Module('brain-index.mjs');
  f.putRepo('brain/03-knowledge/process/cpt-one.md', stage3Node('cpt-one'));
  f.putRepo('brain/00-system/index.md', '[[cpt-one]] stale');
  assert.ok(runCheck({ ...f, scope: 'all' }).findings.some(x => x.check === 'repo.brain-index' && /stale/.test(x.message)));
  assert.equal(f.cli('brain-index.mjs', ['--check']).status, 1);
  assert.equal(f.cli('brain-index.mjs', ['--write']).status, 0);
  assert.equal(f.cli('brain-index.mjs', ['--check']).status, 0);
  assert.ok(!runCheck({ ...f, scope: 'all' }).findings.some(x => x.check === 'repo.brain-index'));
  f.config.caps.brainIndex.maxBytes = 10;
  assert.throws(() => generateIndex(f), /\d+ bytes/);
  const config = f.putRepo('config.json', JSON.stringify(f.config));
  assert.equal(f.cli('brain-index.mjs', ['--write', '--config', config]).status, 1);
});
test('stage3 conserve file snapshot records extras, verify reuses and accepts additional files', t => {
  const f = fixture(t);
  f.putRepo('AGENTS.md', 'https://unique.invalid/extra-token\n');
  const base = snapshot({ ...f, extraFiles: ['AGENTS.md'] });
  assert.deepEqual(base.extraFiles, ['AGENTS.md']);
  assert.equal(verify({ ...f, baseline: base }).count, 0);
  const retained = f.putRepo('retained.json', JSON.stringify(base));
  assert.equal(f.cli('memory-conserve.mjs', ['verify', '--baseline', retained]).status, 0);
  f.putRepo('AGENTS.md', '');
  assert.ok(verify({ ...f, baseline: base }).missing.includes('https://unique.invalid/extra-token'));
  f.putRepo('extra.md', 'https://unique.invalid/extra-token\n');
  assert.equal(verify({ ...f, baseline: base, extraFiles: ['extra.md'] }).count, 0);
  const out = path.join(f.root, 'tokens.json');
  assert.equal(f.cli('memory-conserve.mjs', ['snapshot', '--out', out, '--file', 'extra.md', '--file', 'AGENTS.md']).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).extraFiles, ['extra.md', 'AGENTS.md']);
  f.putRepo('extra.md', '');
  assert.equal(f.cli('memory-conserve.mjs', ['verify', '--baseline', out]).status, 1);
});

test('F1 CRLF fences ignore headings and rotation preserves raw bytes by date', async t => {
  const f = fixture(t), { rotateLog } = await stage3Module('memory-rotate.mjs');
  const preamble = '# Log\r\n```md\r\n## [2026-01-01] x | y\r\n```\r\n';
  const entry = '## [2026-06-02] real\r\n~~~\r\n## [2026-01-01] x | y\r\n~~~\r\n';
  const text = preamble + entry + '## [2026-10-22] keep\r\n';
  f.putRepo('brain/00-system/log.md', text);
  const parts = conserve.splitSections(text, line => /^## \[.*\] real$/.test(line));
  assert.equal(parts.filter(p => p.kind === 'section').length, 1);
  assert.equal(parts.map(p => p.text).join(''), text);
  const result = rotateLog({ ...f, keep: 1, write: true });
  assert.equal(result.moved, 1);
  assert.equal(result.destinations[0].file, 'brain/00-system/log-2026-06.md');
  assert.ok(read(path.join(f.repo, result.destinations[0].file)).endsWith(entry));
  assert.equal(read(path.join(f.repo, 'brain/00-system/log.md')), preamble + '## [2026-10-22] keep\r\n');
});

test('F2 overview counts lettered items and singular, with Unicode truncation', async t => {
  const f = fixture(t), { generateOverview } = await stage3Module('roadmap-overview.mjs');
  f.putRepo('docs/ROADMAP.md', '## Open work\n### Single\n2a. **One**\n  - nested\n### Long\n- ' + 'x'.repeat(137) + '😀more\n');
  const output = generateOverview(f);
  assert.match(output, /### Single \(1 item\)\n2a\. One\n/);
  assert.ok(output.includes('- ' + 'x'.repeat(137) + '😀…'));
});

test('F2 overview shelf fallback, code-point order and path tie-break', async t => {
  const f = fixture(t), { generateOverview } = await stage3Module('roadmap-overview.mjs');
  for (const [file, name, source] of [['fallback', '', 'fallback'], ['a', 'same', 'first'], ['b', 'same', 'second'], ['z', 'Z', 'upper'], ['lower', 'a', 'lower'], ['bmp', '\uE000', 'bmp'], ['astral', '😀', 'astral']]) {
    f.putRepo(`docs/shelf/${file}.md`, `---\n${name ? `name: ${name}\n` : ''}moved_from: ${source}\n---\n`);
  }
  const output = generateOverview(f);
  assert.match(output, /\| fallback \|/);
  assert.ok(output.indexOf('| Z |') < output.indexOf('| a |'));
  assert.ok(output.indexOf('| first |') < output.indexOf('| second |'));
  assert.ok(output.indexOf('| \uE000 |') < output.indexOf('| 😀 |'));
});

test('F2 overview history path comes from config', async t => {
  const f = fixture(t), { generateOverview } = await stage3Module('roadmap-overview.mjs');
  f.config.caps.roadmapHistory = { path: 'docs/custom-history.md' };
  f.putRepo('docs/custom-history.md', '# History\n## Custom\n');
  assert.match(generateOverview(f), /docs\/custom-history\.md holds 1 sections; first "Custom", last "Custom"/);
});

for (const [instant, due] of [['2027-01-19T23:30:00-05:00', true], ['2027-01-19T23:30:00Z', false]]) {
  test(`F4 shelf UTC boundary ${instant}`, t => {
    const f = fixture(t);
    f.putRepo('docs/shelf/program.md', '---\nstatus: shelved\nshelved: 2026-10-22\nreview: 2027-01-20\n---\n');
    const result = runCheck({ ...f, scope: 'all', now: new Date(instant) });
    assert.equal(result.findings.filter(x => x.check === 'shelf.review-due').length, due ? 1 : 0);
  });
}

test('F5 shelf enforces configured reviewDays at 90 and 91 days', t => {
  const f = fixture(t);
  for (const [review, fails] of [['2027-01-20', false], ['2027-01-21', true]]) {
    f.putRepo('docs/shelf/program.md', `---\nstatus: shelved\nshelved: 2026-10-22\nreview: ${review}\n---\n`);
    const findings = f.check('all').findings.filter(x => x.check === 'shelf.frontmatter');
    assert.equal(findings.length, fails ? 1 : 0);
    if (fails) { assert.equal(findings[0].severity, 'FAIL'); assert.match(findings[0].message, /2026-10-22.*2027-01-21.*90/); }
  }
  f.config.caps.shelf.reviewDays = 91;
  assert.ok(!f.check('all').findings.some(x => x.check === 'shelf.frontmatter'));
});

test('F6 rotate skips exact destination suffix after interrupted append', async t => {
  const f = fixture(t), { rotateLog } = await stage3Module('memory-rotate.mjs');
  const entries = ['## [2026-06-01] first\nraw  \n', '## [2026-06-02] second\n', '## [2026-06-03] third\n'];
  for (const completed of [1, 2, 3]) {
    f.putRepo('brain/00-system/log.md', '# Log\n' + entries.join(''));
    const dest = f.putRepo('brain/00-system/log-2026-06.md', '# Archive\n' + entries.slice(0, completed).join(''));
    rotateLog({ ...f, keep: 0, write: true });
    assert.equal(read(dest), '# Archive\n' + entries.join(''));
  }
});

test('F6 rotate separates an existing destination without a newline', async t => {
  const f = fixture(t), { rotateLog } = await stage3Module('memory-rotate.mjs');
  const entry = '## [2026-06-01] first\n';
  f.putRepo('brain/00-system/log.md', '# Log\n' + entry);
  const dest = f.putRepo('brain/00-system/log-2026-06.md', '# Archive');
  rotateLog({ ...f, keep: 0, write: true });
  assert.equal(read(dest), '# Archive\n' + entry);
});

test('F6 rotate atomically replaces log through temp rename and preserves it on failure', async t => {
  const f = fixture(t), { rotateLog } = await stage3Module('memory-rotate.mjs');
  const original = '# Log\n## [2026-06-01] first\n', file = f.putRepo('brain/00-system/log.md', original);
  const rename = fs.renameSync.bind(fs), calls = [];
  let fail = true;
  t.mock.method(fs, 'renameSync', (source, dest) => {
    assert.equal(dest, file); assert.notEqual(source, file);
    assert.equal(path.dirname(source), path.dirname(file));
    assert.equal(read(file), original); assert.equal(read(source), '# Log\n');
    calls.push(source);
    if (fail) throw new Error('simulated rename failure');
    return rename(source, dest);
  });
  assert.throws(() => rotateLog({ ...f, keep: 0, write: true }), /simulated rename failure/);
  assert.equal(read(file), original);
  fail = false;
  rotateLog({ ...f, keep: 0, write: true });
  assert.equal(calls.length, 2); assert.equal(read(file), '# Log\n');
  assert.ok(calls.every(file => !fs.existsSync(file)));
});

test('F6 rotate CLI rejects invalid keep and accepts zero', t => {
  const f = fixture(t);
  f.putRepo('brain/00-system/log.md', '# Log\n');
  for (const value of ['-1', '1.5', 'NaN', 'Infinity', ' ', '9007199254740992']) {
    const result = f.cli('memory-rotate.mjs', ['log', '--keep', value]);
    assert.equal(result.status, 1, value); assert.match(result.stderr, /--keep/);
  }
  assert.equal(f.cli('memory-rotate.mjs', ['log', '--keep', '0']).status, 0);
});

test('F7 index discovers pillar by type and uses configured system files', async t => {
  const f = fixture(t), { generateIndex } = await stage3Module('brain-index.mjs');
  f.putRepo('brain/01-pillars/pil-custom.md', stage3Node('pil-custom').replace('type: concept', 'type: pillar'));
  f.putRepo('brain/03-knowledge/cpt-fake.md', stage3Node('pil-example'));
  f.config.caps.brainIndex.systemFiles = ['rules.md', 'custom-background.md'];
  for (const name of f.config.caps.brainIndex.systemFiles) f.putRepo('brain/00-system/' + name, '# System page\n');
  const index = generateIndex(f).index;
  assert.match(index, /## Pillar\n\[\[pil-custom\]\]/);
  assert.doesNotMatch(index, /pil-example|agents-background\.md/);
  assert.match(index, /## System\n- \[rules.md\]\(rules.md\)\n- \[custom-background.md\]\(custom-background.md\)/);
});

test('F7 index ignores malformed updated values for recency and frontmatter', async t => {
  const f = fixture(t), { generateIndex } = await stage3Module('brain-index.mjs');
  f.putRepo('brain/00-system/index.md', '---\nupdated: 2000-01-01\n---\n');
  for (const [id, date] of [['a', 'zzz'], ['b', '2026-10-22T23:00:00Z'], ['c', '2026-10-22'], ['d', '2026-10-21'], ['e', '2026-10-20']]) {
    f.putRepo(`brain/03-knowledge/process/cpt-${id}.md`, stage3Node(`cpt-${id}`).replace('updated: 2026-10-22', `updated: ${date}`));
  }
  const index = generateIndex(f).index;
  assert.match(index, /^---\nupdated: 2026-10-22\n---/);
  assert.match(index, /\*\*process\*\* \(5\): \[\[cpt-c\]\], \[\[cpt-d\]\], \[\[cpt-e\]\]/);
});

test('F7 shelf uses fmGet and accepts quoted review dates', t => {
  const f = fixture(t);
  f.putRepo('docs/shelf/program.md', '---\nmetadata:\n  status: shelved\n  shelved: 2026-10-22\n  review: "2027-01-20"\n---\n');
  const result = runCheck({ ...f, scope: 'all', today: '2027-01-20' });
  assert.ok(!result.findings.some(x => x.check === 'shelf.frontmatter'));
  finding(result, 'shelf.review-due', 'WARN');
});

test('F8 overview generator errors warn without crashing gate', t => {
  const f = fixture(t), readdir = fs.readdirSync.bind(fs);
  f.putRepo('docs/ROADMAP.md', '# Roadmap\n');
  f.putRepo('docs/ROADMAP-OVERVIEW.md', 'stale');
  t.mock.method(fs, 'readdirSync', (dir, ...args) => {
    if (path.resolve(dir) === path.join(f.repo, 'docs/shelf')) throw new Error('overview test failure');
    return readdir(dir, ...args);
  });
  // Throw only from the generator, then let the shelf check proceed.
  const exists = fs.existsSync.bind(fs); let shelfChecks = 0;
  t.mock.method(fs, 'existsSync', file => path.resolve(file) === path.join(f.repo, 'docs/shelf') ? ++shelfChecks === 1 : exists(file));
  assert.match(finding(f.check('all'), 'repo.roadmap-overview', 'WARN').message, /overview test failure/);
});

test('F8 external edge filenames are redacted', t => {
  const f = fixture(t), fake = 'sk-' + 'a'.repeat(40);
  f.putRepo(`brain/_shared/${fake}.md`, stage3Node('cpt-shared', 'supports: ["[[pil-other]]"]\n'));
  const result = f.check('all');
  assert.equal(result.externalEdges[0].file, 'brain/_shared/[REDACTED:openai].md');
  assert.ok(!JSON.stringify(result).includes(fake));
});

test('F9 conserve default repo resolves without ReferenceError', t => {
  const f = fixture(t), exists = fs.existsSync.bind(fs);
  // Keep the default-repo path isolated from real content, including brain discovery.
  t.mock.method(fs, 'existsSync', file => path.resolve(file).startsWith(path.resolve(f.root) + path.sep) ? exists(file) : false);
  const base = snapshot({ memoryDir: f.memoryDir });
  assert.ok(base.union.length > 0);
  assert.throws(() => conserve.blocksSnapshot({ sources: ['missing.md'] }), /cannot read/);
});

test('F10 conversion skill preserves original-first, every destination and pre-adoption gates', t => {
  const { text, settings } = skillFixture(t, 'memory-ladder');
  const conversion = text.split('## Convert old memory with proof')[1].split('## Install')[0];
  assert.match(conversion, /Tag and snapshot the original FIRST/);
  assert.match(conversion, /name EVERY destination and legal cut point/);
  assert.match(conversion, /test recall and run the gate BEFORE adoption/);
});

function blockFixture(t, source, dest) {
  const f = fixture(t);
  f.putRepo('source.md', source); f.putRepo('dest.md', dest);
  assert.equal(typeof conserve.blocksSnapshot, 'function', 'block snapshot API exists');
  const baseline = conserve.blocksSnapshot({ repo: f.repo, sources: ['source.md'] });
  return { ...f, baseline, verify: extra => conserve.blocksVerify({ repo: f.repo, baseline, dests: ['dest.md'], ...extra }) };
}
test('setup blocks missing', t => {
  const f = blockFixture(t, '## A\nExact.\n', '## B\nOther.\n'), r = f.verify();
  assert.equal(r.count, 1); assert.equal(r.blocks[0].status, 'missing');
});
test('setup blocks altered reports destination', t => {
  const f = blockFixture(t, '## A\nExact.\n', '## A\nChanged.\n'), r = f.verify();
  assert.equal(r.count, 1); assert.equal(r.blocks[0].status, 'altered');
  assert.deepEqual(r.blocks[0].destinations.map(b => [b.source, b.index]), [['dest.md', 0]]);
  const heading = '## ' + 'x'.repeat(210), long = blockFixture(t, heading + ' A\nOld\n', heading + ' B\nNew\n');
  assert.equal(long.baseline.blocks[0].heading.length, 200); assert.equal(long.verify().blocks[0].status, 'missing');
  long.putRepo('dest.md', heading + ' A\nNew\n'); assert.equal(long.verify().blocks[0].status, 'altered');
});
test('setup blocks duplicated', t => {
  const f = blockFixture(t, '## A\nExact.\n', '## A\nExact.\n## A\nExact.\n');
  assert.equal(f.verify().blocks[0].status, 'duplicated'); assert.equal(f.verify().count, 1);
});
test('setup blocks baseline multiplicity two to two is ok', t => {
  const body = '## A\nExact.\n## A\nExact.\n', f = blockFixture(t, body, body);
  assert.equal(f.verify().count, 0); assert.deepEqual(f.verify().blocks.map(b => b.status), ['ok', 'ok']);
});
test('setup blocks partial multiplicity loss fails', t => {
  const f = blockFixture(t, '## A\nExact.\n## A\nExact.\n', '## A\nExact.\n');
  assert.ok(f.verify().count > 0); assert.ok(f.verify().blocks.some(b => b.status === 'missing'));
  f.putRepo('dest.md', '## A\nExact.\n## A\nChanged.\n');
  assert.equal(f.verify().blocks[1].status, 'altered');
  assert.equal(f.verify().blocks[1].destinations[0].index, 1);
});
test('setup blocks out-of-order stays source and destination local', t => {
  const f = blockFixture(t, '## A\nA\n## B\nB\n', '## B\nB\n## A\nA\n');
  assert.ok(f.verify().blocks.some(b => b.status === 'out-of-order')); assert.ok(f.verify().count > 0);
  f.putRepo('dest.md', '## A\nA\n'); f.putRepo('second.md', '## B\nB\n');
  assert.equal(f.verify({ dests: ['second.md', 'dest.md'] }).count, 0);
});
test('setup blocks shared hashes retain independent source order', t => {
  const f = fixture(t);
  f.putRepo('one.md', '## A\nA\n## Shared\nS\n');
  f.putRepo('two.md', '## Shared\nS\n## B\nB\n');
  const baseline = conserve.blocksSnapshot({ repo: f.repo, sources: ['one.md', 'two.md'] });
  const check = () => conserve.blocksVerify({ repo: f.repo, baseline, dests: ['dest.md'] });
  f.putRepo('dest.md', '## A\nA\n## Shared\nS\n## Shared\nS\n## B\nB\n');
  assert.equal(check().count, 0);
  f.putRepo('dest.md', '## Shared\nS\n## B\nB\n## A\nA\n## Shared\nS\n');
  assert.equal(check().count, 0);
  f.putRepo('dest.md', '## B\nB\n## Shared\nS\n## A\nA\n## Shared\nS\n');
  assert.ok(check().blocks.some(b => b.status === 'out-of-order'));
});
test('setup blocks fenced headings do not split', t => {
  const body = '## A\n````md\n## Hidden\n```\n## Still hidden\n````\n~~~\n## Also hidden\n~~~\n## B\nB\n';
  const f = blockFixture(t, body, body);
  assert.deepEqual(f.baseline.blocks.map(b => b.heading), ['## A', '## B']); assert.equal(f.verify().count, 0);
});
test('setup blocks preamble and exact bytes', t => {
  const body = '# Title\n\nπ  \n', f = blockFixture(t, body + '## A\nA', body + '## A\nA');
  const b = f.baseline.blocks[0];
  assert.equal(b.kind, 'preamble'); assert.equal(b.heading, '# Title'); assert.equal(b.index, 0); assert.equal(b.source, 'source.md');
  assert.equal(b.bytes, utf8Bytes(body)); assert.match(b.sha256, /^[a-f0-9]{64}$/); assert.equal(f.verify().count, 0);
  f.putRepo('dest.md', body.trimEnd() + '\n## A\nA'); assert.ok(f.verify().count > 0);
});
test('setup blocks accepted reason suppresses finding', t => {
  const f = blockFixture(t, '## A\nExact.\n', '');
  const r = f.verify({ accepted: { accepted: [{ source: 'source.md', heading: '## A', reason: 'Retired state in git.' }] } });
  assert.equal(r.count, 0); assert.equal(r.blocks[0].status, 'accepted'); assert.equal(r.blocks[0].reason, 'Retired state in git.');
  const blank = blockFixture(t, '\nPreamble\n', '');
  assert.equal(blank.verify({ accepted: { accepted: [{ source: 'source.md', heading: '', reason: 'Retired preamble.' }] } }).count, 0);
});
test('setup blocks accepted without reason rejected', t => {
  const f = blockFixture(t, '## A\nExact.\n', '');
  for (const reason of [undefined, '', ' ']) assert.throws(() => f.verify({ accepted: { accepted: [{ source: 'source.md', heading: '## A', reason }] } }), /require source, heading and reason/);
  const invalid = f.putRepo('accepted.json', 'null');
  assert.throws(() => f.verify({ accepted: invalid }), /require source, heading and reason/);
});
test('setup blocks CRLF source matches LF destination', t => {
  const f = blockFixture(t, '# Title\r\n## A\r\nπ\r\n', '# Title\n## A\nπ\n');
  assert.equal(f.verify().count, 0); assert.equal(f.baseline.blocks[1].bytes, utf8Bytes('## A\nπ\n'));
});
test('setup token verify finds docs shelf recursively', t => {
  const f = fixture(t); f.put('tokens.md', 'dec-shelved-token'); const baseline = snapshot(f);
  f.put('tokens.md', ''); f.putRepo('docs/shelf/nested/x.md', 'dec-shelved-token');
  assert.equal(verify({ ...f, baseline }).count, 0);
});
test('setup block CLI repeated paths JSON and exit codes', t => {
  const f = fixture(t), a = f.putRepo('a.md', '## A\nA\n'), b = f.putRepo('b.md', '## B\nB\n');
  const baseline = path.join(f.repo, 'blocks.json');
  const saved = f.cli('memory-conserve.mjs', ['blocks-snapshot', '--out', baseline, '--source', 'a.md', '--source', b]);
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(JSON.parse(read(baseline)).blocks.length, 2);
  const check = extra => f.cli('memory-conserve.mjs', ['blocks-verify', '--baseline', baseline, '--dest', a, '--dest', 'b.md', ...extra]);
  assert.equal(check([]).status, 0); assert.match(check([]).stdout, /ok: 2/);
  f.putRepo('b.md', '## B\nChanged\n'); const bad = check(['--json']);
  assert.equal(bad.status, 1); assert.equal(JSON.parse(bad.stdout).summary.altered, 1);
  assert.match(check([]).stdout, /b\.md#0.*b\.md#0/);
  const accepted = f.putRepo('accepted.json', JSON.stringify({ accepted: [{ source: 'b.md', heading: '## B', reason: 'Reviewed correction.' }] }));
  assert.equal(check(['--accepted', accepted]).status, 0);
});
test('setup session entries keep multiline entries whole', t => {
  const f = fixture(t); f.config.measure.startLogTailEntries = 2;
  const entries = ['## [2026-10-20] old\nOld\n', '## [2026-10-21] new\n' + 'Detail\n'.repeat(45), '## [2026-10-22] last\nLast\n'];
  f.putRepo('brain/00-system/log.md', '# Log\n' + entries.join(''));
  const r = measure({ ...f, probesFile: f.probes([]) });
  assert.equal(r.sessionStart.files.brainLogTail, utf8Bytes(entries.slice(-2).join('')));
});
test('setup session fewer than N entries excludes preamble', t => {
  const f = fixture(t); f.config.measure.startLogTailEntries = 10;
  const entry = '## [2026-10-22] only\nOne\nTwo'; f.putRepo('brain/00-system/log.md', '# Log\n\n' + entry);
  assert.equal(measure({ ...f, probesFile: f.probes([]) }).sessionStart.files.brainLogTail, utf8Bytes(entry));
});
test('setup session legacy preserves forty-line algorithm', t => {
  const f = fixture(t), lines = Array.from({ length: 60 }, (_, i) => `## [2026-10-22] entry ${i}\r\n`);
  f.putRepo('brain/00-system/log.md', lines.join('')); f.putRepo('AGENTS.md', 'abc'); f.putRepo('CLAUDE.md', '12345');
  const r = measure({ ...f, probesFile: f.probes([]) });
  const bytes = utf8Bytes(read(path.join(f.memoryDir, 'MEMORY.md'))) + 8 + utf8Bytes(lines.slice(-40).join(''));
  assert.equal(r.sessionStartLegacy.files.brainLogTail, utf8Bytes(lines.slice(-40).join('')));
  assert.equal(r.sessionStartLegacy.totalBytes, bytes); assert.equal(r.sessionStartLegacy.tokens, Math.round(bytes / 4));
  assert.match(readable(r), /Session start legacy/);
});
const memorySkills = ['memory-ladder', 'memory-review'].map(name => `.claude/skills/${name}/SKILL.md`);

test('setup fix bounded attribution keeps inversion with thirty shared blocks per source', t => {
  const f = fixture(t), shared = '## Shared\nSame\n';
  f.putRepo('one.md', shared.repeat(30) + '## A\nA\n## B\nB\n');
  f.putRepo('two.md', shared.repeat(30));
  const baseline = f.putRepo('blocks.json', JSON.stringify(conserve.blocksSnapshot({ repo: f.repo, sources: ['one.md', 'two.md'] })));
  const dest = f.putRepo('dest.md', shared.repeat(60) + '## B\nB\n## A\nA\n');
  const start = performance.now();
  const r = spawnSync(process.execPath, [path.join(toolDir, 'memory-conserve.mjs'), 'blocks-verify', '--baseline', baseline, '--dest', dest, '--repo', f.repo, '--json'], { encoding: 'utf8', timeout: 1800, maxBuffer: 4 * 1024 * 1024 });
  assert.ifError(r.error);
  assert.ok(performance.now() - start < 2000);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(JSON.parse(r.stdout).summary['out-of-order'] > 0);
});

test('setup fix repeated heading deletion is missing instead of pointing at intact copy', t => {
  const f = blockFixture(t, '## Same\nA\n## Same\nB\n', '## Same\nB\n');
  assert.deepEqual(f.verify().blocks.map(b => b.status), ['missing', 'ok']);
  assert.deepEqual(f.verify().blocks[0].destinations, []);
  f.putRepo('dest.md', '## Same\nChanged\n## Same\nB\n');
  assert.equal(f.verify().blocks[0].status, 'altered');
  assert.deepEqual(f.verify().blocks[0].destinations.map(b => b.index), [0]);
});

test('setup fix accepted index accepts A while same-heading B still fails', t => {
  const f = blockFixture(t, '## Same\nA\n## Same\nB\n', '');
  const r = f.verify({ accepted: { accepted: [{ source: 'source.md', heading: '## Same', index: 0, reason: 'Retired A only.' }] } });
  assert.deepEqual(r.blocks.map(b => b.status), ['accepted', 'missing']);
  assert.equal(r.count, 1);
});

test('setup fix ambiguous accepted heading requires an index', t => {
  const f = blockFixture(t, '## Same\nA\n## Same\nB\n', '');
  assert.throws(() => f.verify({ accepted: { accepted: [{ source: 'source.md', heading: '## Same', reason: 'Reviewed.' }] } }), /ambiguous.*source\.md.*## Same.*index/i);
});

test('setup fix accepted index must be a nonnegative integer', t => {
  const f = blockFixture(t, '## A\nA\n', '');
  for (const index of [-1, 0.5, '0', null]) assert.throws(() => f.verify({ accepted: { accepted: [{ source: 'source.md', heading: '## A', reason: 'Reviewed.', index }] } }), /index/);
});

test('setup fix unused accepted entry prints without failing', t => {
  const f = blockFixture(t, '## A\nA\n', '## A\nA\n');
  const baseline = f.putRepo('blocks.json', JSON.stringify(f.baseline));
  const accepted = f.putRepo('accepted.json', JSON.stringify({ accepted: [{ source: 'source.md', heading: '## A', index: 9, reason: 'Stale decision.' }] }));
  const r = f.cli('memory-conserve.mjs', ['blocks-verify', '--baseline', baseline, '--dest', 'dest.md', '--accepted', accepted]);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /unused accepted entry.*source\.md.*9.*## A/);
  assert.equal(f.verify({ accepted }).unusedAccepted.length, 1);
});

test('setup fix snapshot rejects missing and zero-block sources', t => {
  const f = fixture(t), out = path.join(f.repo, 'blocks.json');
  for (const source of ['missing.md', 'empty.md', 'bom.md']) {
    if (source !== 'missing.md') f.putRepo(source, source === 'bom.md' ? '\uFEFF' : '');
    const r = f.cli('memory-conserve.mjs', ['blocks-snapshot', '--out', out, '--source', source]);
    assert.equal(r.status, 1, `${source}: ${r.stdout}`);
    assert.match(r.stderr, source === 'missing.md' ? /cannot read.*missing\.md/ : /zero blocks/);
    assert.ok(!fs.existsSync(out));
  }
});

test('setup fix strips leading BOM before block splitting', t => {
  const f = blockFixture(t, '\uFEFF## A\r\nA\r\n', '## A\nA\n');
  assert.equal(f.baseline.blocks.length, 1);
  assert.equal(f.baseline.blocks[0].kind, 'section');
  assert.equal(f.verify().count, 0);
});

test('setup fix block trailing blank lines and missing final newline normalize', t => {
  const f = blockFixture(t, '## A\nA', '## A\nA\n\n \t\n## Extra\nExtra\n');
  assert.equal(f.verify().count, 0);
  assert.equal(f.baseline.blocks[0].bytes, utf8Bytes('## A\nA\n'));
  f.putRepo('dest.md', '## A\nA \n');
  assert.equal(f.verify().blocks[0].status, 'altered', 'retain trailing spaces on nonblank content lines');
});

test('setup fix text lists every non-ok class with source index and heading', t => {
  const f = blockFixture(t, '## Gone\nG\n## Changed\nC\n## Twice\nT\n## First\nF\n## Last\nL\n## Retired\nR\n', '## Changed\nNew\n## Twice\nT\n## Twice\nT\n## Last\nL\n## First\nF\n');
  const baseline = f.putRepo('blocks.json', JSON.stringify(f.baseline));
  const accepted = f.putRepo('accepted.json', JSON.stringify({ accepted: [{ source: 'source.md', heading: '## Retired', reason: 'Reviewed.' }] }));
  const r = f.cli('memory-conserve.mjs', ['blocks-verify', '--baseline', baseline, '--dest', 'dest.md', '--accepted', accepted]);
  assert.equal(r.status, 1);
  for (const [status, index, heading] of [['missing', 0, 'Gone'], ['altered', 1, 'Changed'], ['duplicated', 2, 'Twice'], ['out-of-order', 3, 'First'], ['accepted', 5, 'Retired']]) {
    assert.match(r.stdout, new RegExp(`${status} source\\.md#${index}.*## ${heading}`));
  }
  assert.match(r.stdout, /altered source\.md#1.*dest\.md#0/);
});

test('setup fix text limits block details to fifty lines', t => {
  const source = Array.from({ length: 53 }, (_, i) => `## Item ${i}\nValue ${i}\n`).join('');
  const f = blockFixture(t, source, ''), baseline = f.putRepo('blocks.json', JSON.stringify(f.baseline));
  const r = f.cli('memory-conserve.mjs', ['blocks-verify', '--baseline', baseline, '--dest', 'dest.md']);
  assert.equal(r.status, 1); assert.equal(r.stdout.split('\n').filter(line => line.startsWith('missing source.md#')).length, 50);
  assert.match(r.stdout, /… 3 more \(use --json\)/);
});

for (const mode of ['verify', 'blocks-verify']) test(`setup fix ${mode} reports cannot read baseline and accepted files`, t => {
  const f = blockFixture(t, '## A\nA\n', '## A\nA\n');
  const baseline = f.putRepo('blocks.json', JSON.stringify(mode === 'verify' ? snapshot(f) : f.baseline));
  for (const file of [path.join(f.repo, 'absent.json'), f.repo]) {
    for (const flag of ['--baseline', '--accepted']) {
      const argv = [mode, '--dest', 'dest.md', '--baseline', baseline, flag, file];
      const r = f.cli('memory-conserve.mjs', argv);
      assert.equal(r.status, 1); assert.ok(r.stderr.includes(`cannot read ${file}`), r.stderr);
      assert.doesNotMatch(r.stderr, /JSON|Unexpected/);
    }
  }
});

for (const key of ['startLogTailEntries', 'startLogTailLines']) test(`setup fix measure rejects invalid ${key}`, t => {
  const f = fixture(t), probesFile = f.probes([]);
  for (const value of [0, -1, 1.5, undefined, null, '10', NaN, Infinity]) {
    f.config.measure[key] = value;
    assert.throws(() => measure({ ...f, probesFile }), new RegExp(`measure\\.${key} must be a positive integer`));
  }
});

test('setup fix migrate lessons source and repo work through real CLI in dry run', t => {
  const f = fixture(t), body = '## 1. Source-specific lesson (2026-10-22)\nKeep this body.\n';
  const source = f.put('custom.md', body), before = fs.readdirSync(f.memoryDir).sort();
  const r = f.cli('memory-migrate.mjs', ['lessons', '--source', 'custom.md']);
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.numbered, 1); assert.equal(result.written, false);
  assert.ok(result.files[0].startsWith('lesson-001-source-specific'));
  assert.equal(read(source), body); assert.deepEqual(fs.readdirSync(f.memoryDir).sort(), before);
});

test('setup fix migrate repo selects its default memory directory', t => {
  const f = fixture(t), selected = path.join(f.root, '.claude', 'projects', memorySlug(f.repo), 'memory');
  fs.mkdirSync(selected, { recursive: true });
  fs.writeFileSync(path.join(selected, 'custom.md'), '## 1. Routed lesson (2026-10-22)\nBody\n');
  const env = { ...process.env, HOME: f.root, USERPROFILE: f.root };
  delete env.CLAUDE_MEMORY_DIR;
  const r = spawnSync(process.execPath, [path.join(toolDir, 'memory-migrate.mjs'), 'lessons', '--repo', f.repo, '--source', 'custom.md'], { encoding: 'utf8', env, timeout: 2000 });
  assert.ifError(r.error); assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).written, false);
});

test('setup fix ordering comment describes earliest eligible occurrence', () => {
  const code = read(path.join(toolDir, 'memory-conserve.mjs'));
  assert.match(code, /Prefer the earliest identical occurrence after/);
  assert.doesNotMatch(code, /Prefer a later identical occurrence/);
});

test('setup fix README documents BOM and block-end normalization', () => {
  const text = read(path.join(toolDir, 'README.md'));
  assert.match(text, /leading UTF-8 BOM/);
  assert.match(text, /trailing blank lines/);
  assert.match(text, /exactly one `\\n`/);
});

test('setup fix ladder retains routing recall and checkpoint imperatives', t => {
  const { text, settings } = skillFixture(t, 'memory-ladder');
  for (const rule of [
    /router gains a line only for a new hard rule or an active-work item/i,
    /OPEN BEFORE <activity>/, /OPEN when work touches <domain>/,
    /then OPEN the index/i, /never bulk-load topic files/i,
    /Delete a memory that proves wrong/, /Link related memories with `\[\[name\]\]`/,
    /ARCHIVE is never loaded by default/, /file, flag or number.*point-in-time/,
    /lesson with the why/, /roadmap's Open work/, /decision board/,
    /specs\/evidence.*temp folder.*`docs\/`/,
    /Extract by content, never by line number/,
  ]) assert.match(text.replace(/\n/g, ' '), rule);
  assert.ok(utf8Bytes(text) <= 8000);
});

test('setup fix ladder installation includes real hook and bootstrap instructions', t => {
  const { text, settings } = skillFixture(t, 'memory-ladder');
  const command = settings.hooks.SessionStart[0].hooks[0].command;
  assert.ok(text.includes(JSON.stringify(command)), 'copy the actual SessionStart command');
  for (const rule of [/\.claude\/projects\//, /git.*init/, /baseline commit/i, /## Hard rules/, /## Craft/, /install-hooks\.mjs --memory-dir/, /AGENTS\.md.*Memory gate/, /optional private remote/i]) assert.match(text.replace(/\n/g, ' '), rule);
});

test('setup fix review forbids increasing pins and removes obsolete duplicate memories', t => {
  const { text } = skillFixture(t, 'memory-review');
  assert.doesNotMatch(text, /derive a new pin/);
  assert.match(text.replace(/\n/g, ' '), /Never raise a pin or allow ceiling/);
  assert.match(text.replace(/\n/g, ' '), /Delete memories that are obsolete or superseded/);
  assert.match(text.replace(/\n/g, ' '), /Merge files that hold the same fact/);
  assert.ok(utf8Bytes(text) <= 8000);
});
test('setup skill version missing warns in all and session but skips hook', t => {
  const f = fixture(t); for (const file of memorySkills) f.putRepo(file, '---\nname: skill\n---\n');
  assert.equal(f.check('all').findings.filter(x => x.check === 'repo.skill-version' && x.severity === 'WARN').length, 2);
  const config = f.putRepo('config.json', JSON.stringify(f.config));
  const observed = [];
  const originalRun = fs.readFileSync.bind(fs);
  t.mock.method(fs, 'readFileSync', (file, ...rest) => {
    if (memorySkills.some(skill => pathKey(f.repo, skill) === pathKey(String(file)))) observed.push(String(file));
    return originalRun(file, ...rest);
  });
  assert.equal(f.cli('memory-check.mjs', ['--session-start', '--config', config]).status, 0);
  // Inspect the finding itself; unrelated warnings must not satisfy this assertion.
  for (const file of memorySkills) finding(f.check('all'), 'repo.skill-version', 'WARN', file);
  f.config.allow.push({ check: 'repo.skill-version', file: '*', reason: 'Fixture', added: '2026-10-22' });
  for (const scope of ['all', 'memory']) {
    const r = runCheck({ ...f, scope, hook: true });
    assert.ok(!r.findings.some(x => x.check === 'repo.skill-version' || (x.check === 'config.allow-stale' && x.message.includes('repo.skill-version'))));
  }
  observed.length = 0;
  const memory = runCheck({ ...f, scope: 'memory', hook: false });
  assert.ok(!memory.findings.some(x => x.check === 'repo.skill-version' || (x.check === 'config.allow-stale' && x.message.includes('repo.skill-version'))));
  assert.deepEqual(observed, [], 'memory scope must not read skill files even without --hook');
});
test('setup skill version mismatch warns', t => {
  const f = fixture(t); for (const file of memorySkills) f.putRepo(file, '---\nengine_version: "0.0.0"\n---\n');
  for (const file of memorySkills) finding(f.check('all'), 'repo.skill-version', 'WARN', file);
});
test('setup skill version match clears warning', t => {
  const f = fixture(t);
  for (const file of memorySkills) {
    f.putRepo(file, '---\nname: skill\n---\n'); finding(f.check('all'), 'repo.skill-version', 'WARN', file);
    f.putRepo(file, `---\nengine_version: "${f.config.engine_version}"\n---\n`);
  }
  assert.ok(!f.check('all').findings.some(x => x.check === 'repo.skill-version'));
});
test('setup skill version absent file produces nothing', t => {
  const f = fixture(t); f.putRepo(memorySkills[0], '---\nname: skill\n---\n');
  const r = f.check('all'); finding(r, 'repo.skill-version', 'WARN', memorySkills[0]);
  assert.ok(!r.findings.some(x => x.check === 'repo.skill-version' && x.file === memorySkills[1]));
  assert.ok(!runCheck({ ...f, repo: path.join(f.repo, 'empty') }).findings.some(x => x.check === 'repo.skill-version'));
});

test('stage2 splitter preserves mixed headings, dates, letters, duplicates and every body byte', async t => {
  const { splitLessons } = await import('./memory-migrate.mjs');
  const body = '\r\nPreamble.\r\n**149 (2026-09-08). Alpha title.**\r\nA.\r\n**#149 (2026-09-09). Duplicate.**\r\nB.\r\n**149b. Explicit letter.**\r\nC.\r\n## 2026-08-25\r\n**54b Next title.**\r\nD.\r\n**#54c Another title.**\r\nE.\r\n## 94. Hash heading.\r\nF.\r\n**7. Plain title.**\r\n**5.4 GB** is not a lesson.\r\n';
  const result = splitLessons('---\r\nname: source\r\n---\r\n' + body);
  assert.equal(result.lessons.map(l => l.body).join(''), body);
  assert.equal(result.report.bytesIn, Buffer.byteLength(body));
  assert.equal(result.report.bytesOut, result.report.bytesIn);
  assert.equal(result.report.numbered, 7);
  assert.deepEqual(result.lessons.map(l => l.id), ['0a', '149', '149a', '149b', '0b', '54b', '54c', '94', '7']);
  assert.equal(result.lessons.find(l => l.id === '54b').date, '2026-08-25');
  assert.equal(result.lessons.find(l => l.id === '149a').date, '2026-09-09');
  assert.equal(result.report.duplicates.length, 1);
  assert.ok(result.report.missingDates.includes('149b'));
  assert.deepEqual(result.report.unparsedLines, []);
  for (const l of result.lessons) {
    assert.ok(l.description.length <= 200);
    assert.ok(/^lesson-\d{3}[a-z]?-(?:[a-z0-9]+-){0,5}[a-z0-9]+\.md$/.test(l.file));
  }
});

test('stage2 splitter dry run, class indexes, stub and second-run no-op', async t => {
  const { migrateLessons } = await import('./memory-migrate.mjs');
  const f = fixture(t), source = 'lessons.md';
  const original = f.topic('source', 'Old', '', '**#8 (2026-10-21). Test source.**\nExact body.\n');
  f.put(source, original);
  const options = { memoryDir: f.memoryDir, classes: { '8': 'shipping' } };
  assert.equal(migrateLessons(options).numbered, 1);
  assert.equal(read(path.join(f.memoryDir, source)), original);
  const result = migrateLessons({ ...options, write: true });
  const stub = parseFrontmatter(read(path.join(f.memoryDir, source)));
  assert.deepEqual(stub.data.moved_to, ['INDEX-craft-shipping.md']);
  assert.ok(stub.body.includes('<name>:lessons.md'));
  assert.ok(stub.body.includes('lesson-054b-*'));
  assert.ok(utf8Bytes(stub.raw + stub.body) <= 4096);
  const lesson = parseFrontmatter(read(path.join(f.memoryDir, result.files[0])));
  assert.equal(lesson.data.metadata.lesson, '8');
  assert.equal(lesson.data.metadata.type, 'feedback');
  assert.equal(lesson.body, '**#8 (2026-10-21). Test source.**\nExact body.\n');
  assert.equal(migrateLessons({ ...options, write: true }).noop, true);
});

test('stage2 splitter refuses malformed candidates, invalid classes and clobbers before writes', async t => {
  const { migrateLessons } = await import('./memory-migrate.mjs');
  const f = fixture(t), source = 'lessons.md';
  f.put(source, f.topic('source', 'Old', '', '**#8 (2026-10-21). Test source.**\n**#9??? malformed\n'));
  assert.throws(() => migrateLessons({ memoryDir: f.memoryDir, write: true }), /unparsed/i);
  f.put(source, f.topic('source', 'Old', '', '**#8 (2026-10-21). Test source.**\n'));
  assert.throws(() => migrateLessons({ memoryDir: f.memoryDir, classes: {}, write: true }), /class/i);
  const r = migrateLessons({ memoryDir: f.memoryDir }); f.put(r.files[0], 'Existing');
  assert.throws(() => migrateLessons({ memoryDir: f.memoryDir, write: true }), /exists/i);
});

for (const file of ['MEMORY.md', 'INDEX-craft-verification.md']) test(`stage2 lessons.cite ${file}`, t => {
  const f = fixture(t); f.put(file, '# Activity\n#54b #54 #999\n');
  assert.ok(!f.check().findings.some(x => x.check === 'lessons.cite'));
  f.put('lesson-054b-test.md', f.topic('lesson-054b-test'));
  const citations = f.check().findings.filter(x => x.check === 'lessons.cite');
  assert.equal(citations.length, 2); assert.ok(citations.every(x => x.severity === 'FAIL'));
  assert.ok(citations.some(x => x.message.includes('#54 ')));
  assert.ok(!citations.some(x => x.message.includes('#54b ')));
});

for (const target of ['brain/03-knowledge/absent.md', 'elsewhere.md', 'brain/../outside.md']) test(`stage2 brain.pointer rejects ${target}`, t => {
  const f = fixture(t); f.putRepo('outside.md', 'outside');
  f.put('topic.md', f.topic('topic', 'Fact', `brain: ${target}\n`));
  finding(f.check(), 'brain.pointer', 'FAIL', 'topic.md');
});

test('stage2 brain.pointer accepts existing brain file', t => {
  const f = fixture(t); f.putRepo('brain/03-knowledge/fct-topic.md', '---\nid: fct-topic\ntype: fact\n---\nFact');
  f.put('topic.md', f.topic('topic', 'Fact', 'type: project\nbrain: brain/03-knowledge/fct-topic.md\n'));
  assert.ok(!f.check().findings.some(x => /^brain.pointer/.test(x.check)));
});

for (const type of ['project', 'reference']) for (const suffix of ['', '-2026-10', '-2026-10-21']) test(`stage2 brain.pointer-missing ${type} ${suffix}`, t => {
  const f = fixture(t); f.putRepo('brain/03-knowledge/node.md', `---\nid: fct-topic${suffix}\ntype: fact\n---\nFact`);
  f.put('topic.md', f.topic('topic', 'Fact', `metadata:\n  type: ${type}\n`));
  finding(f.check(), 'brain.pointer-missing', 'WARN', 'topic.md');
});

test('stage2 pointer warning does not fuzzy-match subjects or feedback', t => {
  const f = fixture(t); f.putRepo('brain/03-knowledge/node.md', '---\nid: fct-other-topic-2026-10-21\ntype: fact\n---\nFact');
  f.put('topic.md', f.topic('topic', 'Fact', 'type: project\n'));
  assert.ok(!f.check().findings.some(x => x.check === 'brain.pointer-missing'));
  f.putRepo('brain/03-knowledge/node.md', '---\nid: fct-topic\ntype: fact\n---\nFact');
  f.put('topic.md', f.topic('topic', 'Fact', 'type: feedback\n'));
  assert.ok(!f.check().findings.some(x => x.check === 'brain.pointer-missing'));
});

test('stage2 noGit skips every git invocation, reports incomplete coverage', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.memoryDir, '.git'));
  let calls = 0; t.mock.method(childProcess, 'execFileSync', () => { calls++; throw new Error('Forbidden'); });
  const result = runCheck({ ...f, noGit: true });
  assert.equal(calls, 0); finding(result, 'repo.git-skipped', 'WARN');
  assert.ok(!result.findings.some(x => x.check === 'config.allow-stale' && x.message.includes('repo.not-git')));
});

test('F2.1 next-line flow lists support trailing commas and apostrophes', () => {
  const data = parseFrontmatter("---\nrelated_to:\n  [\n    '[[dec-a]]',\n    '[[dec-b]]',\n    owner's-rule,\n    'owner''s rule',\n  ]\nafter: intact\n---").data;
  assert.deepEqual(data.related_to, ['[[dec-a]]', '[[dec-b]]', "owner's-rule", "owner's rule"]);
  assert.equal(data.after, 'intact');
});

for (const nextLine of [false, true]) test(`F2.1 unclosed flow is linear over 8000 lines nextLine=${nextLine}`, t => {
  const text = `---\nitems:${nextLine ? '\n  [' : ' ['}\n` + '  unfinished,\n'.repeat(8000) + 'next: intact\ntail: [\n  unfinished\n---\nBody';
  const start = performance.now(), result = parseFrontmatter(text), ms = performance.now() - start;
  assert.equal(result.data.items, '[');
  assert.equal(result.data.next, 'intact'); assert.equal(result.data.tail, '['); assert.equal(result.body, 'Body');
  assert.ok(ms < 200, `Parser took ${ms} ms`); t.diagnostic(`8000-line parser: ${ms.toFixed(2)} ms`);
});

test('F2.2 distinctive secret prefixes match escaped and embedded keys', t => {
  const f = fixture(t), key = secretExamples.anthropic;
  f.put('topic.md', f.topic('topic', 'Fact', '', ['\\n', 'KEY_', '%0A'].map(prefix => prefix + key).join('\n')));
  assert.equal(f.check().findings.filter(x => x.check === 'secret').length, 3);
  for (const prefix of ['\\n', 'KEY_', '%0A']) assert.equal(redact(prefix + key), prefix + '[REDACTED:anthropic]');
});

test('F2.2 all scope scans every brain markdown and repo instruction roadmap file', t => {
  const f = fixture(t), files = ['brain/top.md', 'brain/00-system/log.md', 'brain/.claude/SKILL.md', 'brain/_templates/node.md', 'brain/03-knowledge/README.md', 'brain/03-knowledge/node.md', 'AGENTS.md', 'CLAUDE.md', 'docs/ROADMAP.md', 'docs/ROADMAP-next.md'];
  for (const file of files) f.putRepo(file, secretExamples.anthropic);
  assert.deepEqual(f.check('all').findings.filter(x => x.check === 'secret').map(x => x.file).sort(), files.sort());
  assert.equal(f.check('memory').findings.filter(x => x.check === 'secret').length, 0);
});

test('F2.3 conserve extracts bare paths from markup line refs and fragments', () => {
  for (const [text, token] of [['[Index](INDEX-main.md)', 'INDEX-main.md'], ['**scripts/a.mjs**', 'scripts/a.mjs'], ['file.md:12', 'file.md'], ['file.md#sec', 'file.md'], ['href="foo/bar.json"', 'foo/bar.json'], ['`SKILL.md`', 'SKILL.md']]) assert.deepEqual(distinctiveTokens(text), [token]);
});

for (const [label, value] of [['null', ''], ['explicit-null', 'null'], ['empty', '""'], ['whitespace', '"   "'], ['number', '42'], ['boolean', 'true'], ['list', '[one]']]) test(`F2.4 desc.missing rejects ${label}`, t => {
  const f = fixture(t); f.put('topic.md', `---\nname: topic\ndescription: ${value}\n---\nBody`);
  finding(f.check(), 'desc.missing', 'FAIL', 'topic.md');
});

for (const kind of ['empty', 'dot', 'directory', 'parent', 'absolute', 'memory-escape', 'brain-directory', 'brain-escape', 'number']) test(`F2.5 stub.target rejects ${kind}`, t => {
  const f = fixture(t);
  f.put('folder/target.md', '# Target'); f.putRepo('brain/folder/target.md', '# Target');
  f.putRepo('outside.md', '# Outside'); fs.writeFileSync(path.join(f.root, 'x'), '# Outside');
  const targets = { empty: '', dot: '.', directory: 'folder', parent: '../x', absolute: path.join(f.memoryDir, 'topic.md'), 'memory-escape': '../repo/outside.md', 'brain-directory': 'brain/folder', 'brain-escape': 'brain/../outside.md', number: 42 };
  f.put('stub.md', f.topic('stub', 'Moved', `moved_to: ${JSON.stringify(targets[kind])}\n`));
  finding(f.check(), 'stub.target', 'FAIL', 'stub.md');
});

test('F2.6 hook installer ignores global hooksPath', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.memoryDir, '.git'));
  let calls = 0;
  t.mock.method(childProcess, 'execFileSync', (command, argv) => {
    calls++; assert.equal(command, 'git');
    if (argv.includes('--local')) throw new Error('No local value');
    return path.join(f.root, 'global-hooks');
  });
  assert.equal(install(f).ok, true); assert.equal(calls, 1);
  assert.ok(fs.existsSync(path.join(f.memoryDir, '.git/hooks/pre-commit')));
  assert.ok(!fs.existsSync(path.join(f.root, 'global-hooks')));
});

for (const missing of ['file', 'check']) test(`F2.7 allowlist writer retains invalid entry missing ${missing}`, t => {
  const f = fixture(t), entry = { check: 'router.line', file: 'MEMORY.md', reason: 'Baseline', added: '2026-10-21' };
  delete entry[missing]; f.config.allow.push(entry); f.put('MEMORY.md', 'x'.repeat(601));
  const configFile = f.putRepo('allow.json', JSON.stringify(f.config));
  const result = f.cli('memory-check.mjs', ['--scope', 'memory', '--config', configFile, '--write-allowlist', 'Baseline']);
  assert.equal(result.status, 0); assert.match(result.stdout, /entries added/); assert.doesNotMatch(result.stdout, /error/);
  const updated = JSON.parse(read(configFile)); assert.ok(updated.allow.some(x => JSON.stringify(x) === JSON.stringify(entry)));
  finding(runCheck({ ...f, config: updated, scope: 'memory' }), 'config.allow', 'FAIL');
  assert.equal(updated.allow.filter(x => x.check === 'router.line' && x.file === 'MEMORY.md').length, 1);
});

for (const words of ['cache caches', 'case cases', 'response responses', 'release releases', 'database databases', 'size sizes', 'name named names', 'use uses', 'rule rules', 'process processes', 'policy policies']) test(`F2.8 stems agree for ${words}`, () => {
  const stems = words.split(' ').map(word => tokenize(word)[0]); assert.equal(new Set(stems).size, 1);
  assert.deepEqual(tokenize('status bus'), ['status', 'bus']);
});

for (const ceiling of [NaN, Infinity, -Infinity, -1]) test(`F2.9 config.allow rejects ceiling ${ceiling}`, t => {
  const f = fixture(t); f.config.allow.push({ check: 'router.line', file: 'MEMORY.md', ceiling, reason: 'Baseline', added: '2026-10-21' });
  finding(f.check(), 'config.allow', 'FAIL');
});

test('F2.9 memory allowlist write preserves repo scope entries', t => {
  const f = fixture(t), entries = ['repo.brain-log', 'repo.brain-index', 'repo.roadmap', 'repo.agents', 'brain.edge'].map(check => ({ check, file: 'absent', reason: 'Repo baseline', added: '2026-10-21' }));
  f.config.allow.push(...entries);
  const configFile = f.putRepo('allow.json', JSON.stringify(f.config));
  const result = f.cli('memory-check.mjs', ['--scope', 'memory', '--config', configFile, '--write-allowlist', 'Baseline']);
  assert.equal(result.status, 0); assert.match(result.stdout, /0 entries added/);
  const updated = JSON.parse(read(configFile)); for (const entry of entries) assert.ok(updated.allow.some(x => JSON.stringify(x) === JSON.stringify(entry)));
});

for (const file of ['MEMORY.md', 'MEM*.md']) test(`F2.9 growth never duplicates or raises ceiling ${file}`, t => {
  const f = fixture(t); f.put('MEMORY.md', read(path.join(f.memoryDir, 'MEMORY.md')) + 'x'.repeat(602));
  const entry = { check: 'router.line', file, ceiling: 601, reason: 'Baseline', added: '2026-10-21' }; f.config.allow.push(entry);
  const configFile = f.putRepo('allow.json', JSON.stringify(f.config));
  for (let i = 0; i < 2; i++) {
    assert.equal(writeAllowlist({ result: f.check(), config: f.config, configFile, reason: 'Growth' }), 0);
    assert.deepEqual(f.config.allow.filter(x => x.check === 'router.line'), [entry]);
    assert.equal(finding(f.check(), 'router.line', 'FAIL').allowed, false);
  }
});

test('F2.9 secret filename is redacted in findings and largest stats', t => {
  const f = fixture(t), key = secretExamples.anthropic;
  f.put(key + '.md', f.topic('ordinary', 'Fact', '', 'x'.repeat(22000)));
  const result = f.check(); assert.ok(result.findings.some(x => x.file === '[REDACTED:anthropic].md'));
  assert.equal(result.stats.largest.file, '[REDACTED:anthropic].md'); assert.ok(!JSON.stringify(result).includes(key));
});

test('F2.9 secret allow reason is redacted', t => {
  const f = fixture(t); f.put('MEMORY.md', 'x'.repeat(601));
  f.config.allow.push({ check: 'router.line', file: 'MEMORY.md', reason: secretExamples.anthropic, added: '2026-10-21' });
  assert.equal(finding(f.check(), 'router.line', 'FAIL').reason, '[REDACTED:anthropic]');
});

test('F2.9 secret internal error is redacted', t => {
  const f = fixture(t), output = [];
  t.mock.method(console, 'log', value => output.push(value));
  t.mock.method(fs, 'readFileSync', () => { throw new Error('Cannot read ' + secretExamples.anthropic); });
  assert.equal(checkMain(['--memory-dir', f.memoryDir, '--repo', f.repo]), 1);
  assert.deepEqual(output, ['memory-check: error Cannot read [REDACTED:anthropic]']);
});

test('F2.9 secret ceiling suffix is redacted', t => {
  const f = fixture(t); f.put('MEMORY.md', 'x'.repeat(602));
  f.config.allow.push({ check: 'router.line', file: 'MEMORY.md', ceiling: 601, reason: 'Baseline', added: '2026-10-21' });
  // Inject at the numeric formatting boundary: config itself rejects string ceilings.
  t.mock.method(Math, 'max', () => secretExamples.anthropic);
  assert.ok(finding(f.check(), 'router.line', 'FAIL').message.endsWith('(grew past allowed ceiling [REDACTED:anthropic])'));
});

test('F2.9 single quoted values unescape doubled apostrophes', () => {
  assert.equal(parseFrontmatter("---\nname: 'owner''s rule'\n---").data.name, "owner's rule");
});

test('F2.9 hard rules also receive description checks', t => {
  const f = fixture(t); f.put('rule.md', '---\nname: rule\n---\nRule');
  finding(f.check(), 'desc.missing', 'FAIL', 'rule.md');
  f.put('rule.md', f.topic('rule', 'Newest: ' + 'x'.repeat(401)));
  finding(f.check(), 'desc.length', 'FAIL', 'rule.md'); finding(f.check(), 'desc.changelog', 'FAIL', 'rule.md');
});

test('F2.9 recall idf ranks rare above common at equal tf and length', () => {
  const doc = (name, word) => ({ path: name, terms: new Map([[tokenize(word)[0], 1]]), length: 1 });
  const result = search([doc('a-common', 'common'), doc('b-common', 'common'), doc('z-rare', 'rare')], 'common rare');
  assert.equal(result[0].path, 'z-rare'); assert.ok(result[0].score > result[1].score);
});

test('F2.9 recall length normalisation ranks shorter at equal tf', () => {
  const doc = (name, length) => ({ path: name, terms: new Map([['orchard', 1]]), length });
  const result = search([doc('a-long', 40), doc('z-short', 4)], 'orchard');
  assert.equal(result[0].path, 'z-short'); assert.ok(result[0].score > result[1].score);
});

for (const [field, weight] of [['name', 3], ['description', 2], ['id', 3], ['tags', 2], ['summary', 2], ['h1', 2]]) test(`F2.9 recall field weight ${field} beats body`, t => {
  const f = fixture(t), brain = ['id', 'tags', 'summary'].includes(field);
  const text = (value, body) => `---\n${field === 'h1' ? 'name' : field}: ${value}\n---\n${body}`;
  if (brain) {
    f.putRepo('brain/03-knowledge/z-field.md', text('orchard', 'neutral'));
    f.putRepo('brain/03-knowledge/a-body.md', text('neutral', 'orchard'));
  } else {
    f.put('z-field.md', text(field === 'h1' ? 'neutral' : 'orchard', field === 'h1' ? '# orchard' : 'neutral'));
    f.put('a-body.md', text('neutral', 'orchard'));
  }
  const corpus = buildCorpus(f), fieldDoc = corpus.find(x => x.path.endsWith('z-field.md')), bodyDoc = corpus.find(x => x.path.endsWith('a-body.md'));
  assert.equal(fieldDoc.terms.get('orchard'), weight + (field === 'h1' ? 1 : 0)); assert.equal(bodyDoc.terms.get('orchard'), 1);
  const results = search([bodyDoc, fieldDoc], 'orchard'); assert.equal(results[0].path, fieldDoc.path); assert.ok(results[0].score > results[1].score);
});

test('F2.9 recall body window excludes term at char 500', t => {
  const f = fixture(t); f.put('late.md', f.topic('late', 'Useful', '', 'x'.repeat(500) + ' orchard'));
  f.put('early.md', f.topic('early', 'Useful', '', 'orchard ' + 'x'.repeat(500)));
  assert.deepEqual(search(buildCorpus(f), 'orchard').map(x => x.path), ['early.md']);
});

for (const source of ['memory', 'brain']) test(`F2.9 recall --${source}-only filters results`, t => {
  const f = fixture(t); f.put('orchard.md', f.topic('orchard'));
  f.putRepo('brain/03-knowledge/orchard.md', '---\nid: orchard\nsummary: Orchard\n---\nBody');
  const result = f.cli('memory-recall.mjs', ['orchard', '--json', `--${source}-only`]); assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout).map(x => x.path), [source === 'memory' ? 'orchard.md' : 'brain/03-knowledge/orchard.md']);
});

test('F2.9 measure even median averages the two middle values', t => {
  const f = fixture(t); f.put('topic.md', f.topic('topic', 'Orchard', '', 'orchard')); f.put('rule.md', f.topic('rule', 'Orchard', '', 'orchard '.repeat(20)));
  const result = measure({ ...f, probesFile: f.probes([{ id: 'a', q: 'orchard', expect: ['topic.md'] }, { id: 'b', q: 'orchard', expect: ['rule.md'] }]) }).recall;
  for (const [field, median] of [['ladderBytes', 'medianLadderBytes'], ['searchBytes', 'medianSearchBytes']]) {
    const values = result.probes.map(x => x[field]); assert.ok(values.every(Number.isFinite)); assert.notEqual(values[0], values[1]);
    assert.equal(result.totals[median], (values[0] + values[1]) / 2);
  }
});

test('F2.9 conserve sha requires both hex letters and digits', () => {
  assert.deepEqual(distinctiveTokens('deadbeef'), []); assert.deepEqual(distinctiveTokens('1234567'), []);
  assert.deepEqual(distinctiveTokens('a1b2c3d'), ['a1b2c3d']);
});

function fixture(t) {
  // No git process may run, even when testing hook installation.
  t.mock.method(childProcess, 'execFileSync', () => { throw new Error('Git disabled in fixtures'); });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memv3-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const saved = Object.fromEntries(['HOME', 'USERPROFILE', 'CLAUDE_MEMORY_DIR'].map(k => [k, process.env[k]]));
  process.env.HOME = root; process.env.USERPROFILE = root; delete process.env.CLAUDE_MEMORY_DIR;
  t.after(() => { for (const [k,v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const memoryDir = path.join(root, 'memory'), repo = path.join(root, 'repo');
  fs.mkdirSync(memoryDir); fs.mkdirSync(repo);
  const writeAt = (base, file, text) => {
    const dest = path.join(base, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, text);
    return dest;
  };
  const put = (file, text) => writeAt(memoryDir, file, text);
  const putRepo = (file, text) => writeAt(repo, file, text);
  const topic = (name, desc = 'A compact useful fact.', extra = '', body = '# Useful fact\nPractical details.\n') => `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n${extra}---\n${body}`;
  put('MEMORY.md', '# Memory\n\n## Hard rules\n[Rule](rule.md)\n\n## Topics\n[Index](INDEX-main.md)\n[Archive](ARCHIVE.md)\n');
  put('INDEX-main.md', '# Topics\n[Topic](topic.md)\n');
  put('ARCHIVE.md', '# Archive\n');
  put('topic.md', topic('topic'));
  put('rule.md', topic('rule', 'Follow the verification rule.'));
  // Real caps, but never the live pins or allowlist: those change at every checkpoint.
  const config = { ...structuredClone(loadConfig()), pins: {}, allow: [] };
  config.pins['INDEX-main.md'] = 2000;
  // No git is initialized or invoked. This deliberate fixture warning is allowed.
  config.allow.push({ check: 'repo.not-git', file: '.', reason: 'Fixture has no git repository.', added: '2026-10-21' });
  const check = (scope = 'memory') => runCheck({ memoryDir, repo, scope, config, now: '2026-10-21' });
  const probes = spec => putRepo('probes.json', JSON.stringify({ version: 1, minPass: 0.8, probes: spec }));
  const cli = (file, argv = []) => {
    const result = spawnSync(process.execPath, [path.join(toolDir, file), ...argv, '--memory-dir', memoryDir, '--repo', repo], { encoding: 'utf8', timeout: 20000 });
    assert.ifError(result.error);
    return result;
  };
  return { root, memoryDir, repo, put, putRepo, topic, config, check, probes, cli };
}
function finding(result, check, severity, file) {
  const value = result.findings.find(f => f.check === check && f.severity === severity && (!file || f.file === file));
  assert.ok(value, `Expected ${severity} ${check}${file ? ` ${file}` : ''}`);
  return value;
}

test('healthy memory has zero non-allowed findings', t => {
  const f = fixture(t);
  assert.deepEqual(f.check().findings.filter(x => !x.allowed), []);
});
test('router byte failure', t => {
  const f = fixture(t); f.put('MEMORY.md', 'short line\n'.repeat(1800));
  finding(f.check(), 'router.size', 'FAIL');
});
test('router 601-character line failure has one-based line', t => {
  const f = fixture(t); f.put('MEMORY.md', '# Memory\n' + 'x'.repeat(601));
  assert.equal(finding(f.check(), 'router.line', 'FAIL').line, 2);
});
test('index exceeding pin fails', t => {
  const f = fixture(t); f.config.pins['INDEX-main.md'] = 1;
  finding(f.check(), 'index.pin', 'FAIL');
});
test('index missing pin fails', t => {
  const f = fixture(t); f.config.pins = {};
  finding(f.check(), 'index.missing-pin', 'FAIL');
});
test('index 451-character line fails', t => {
  const f = fixture(t); f.put('INDEX-main.md', 'x'.repeat(451));
  finding(f.check(), 'index.line', 'FAIL');
});
test('description 401 characters fails', t => {
  const f = fixture(t); f.put('topic.md', f.topic('topic', 'x'.repeat(401)));
  finding(f.check(), 'desc.length', 'FAIL');
});
test('description changelog marker fails case-insensitively', t => {
  const f = fixture(t); f.put('topic.md', f.topic('topic', 'newest: a change'));
  finding(f.check(), 'desc.changelog', 'FAIL');
});
test('two state headings fail with nested state metadata', t => {
  const f = fixture(t); f.put('topic.md', f.topic('topic', 'State.', 'metadata:\n  state: true\n', '# RESUME\n## CURRENT\n'));
  finding(f.check(), 'state.headings', 'FAIL');
});
test('4097-byte hard rule fails', t => {
  const f = fixture(t), base = f.topic('rule');
  f.put('rule.md', base + 'x'.repeat(4097 - utf8Bytes(base)));
  finding(f.check(), 'hardrule.size', 'FAIL');
});
test('missing stub target fails without orphan or topic-size findings', t => {
  const f = fixture(t); f.put('stub.md', f.topic('stub', 'Moved.', 'moved_to: absent.md\n', 'x'.repeat(21000)));
  const result = f.check(); finding(result, 'stub.target', 'FAIL');
  assert.equal(result.findings.some(x => x.file === 'stub.md' && ['link.orphan', 'topic.size'].includes(x.check)), false);
});
test('duplicate names fail', t => {
  const f = fixture(t); f.put('other.md', f.topic('topic'));
  finding(f.check(), 'name.duplicate', 'FAIL');
});
test('dead router link fails', t => {
  const f = fixture(t); f.put('MEMORY.md', '[Missing](missing.md#part)');
  finding(f.check(), 'link.dead', 'FAIL');
});
test('secret failure never contains fake key text', t => {
  const f = fixture(t), key = 'sk-ant-' + 'a'.repeat(40);
  f.put('topic.md', f.topic('topic', 'Fact.', '', key));
  const result = f.check(), secret = finding(result, 'secret', 'FAIL');
  assert.equal(secret.message.includes(key), false);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.match(secret.message, /anthropic/);
});
test('lesson count mismatch fails', t => {
  const f = fixture(t);
  for (let i = 1; i <= 3; i++) { const name = `lesson-00${i}-fact`; f.put(`${name}.md`, f.topic(name)); }
  f.put('MEMORY.md', '4 lessons\n');
  finding(f.check(), 'lessons.count', 'FAIL');
});
test('duplicate lesson number and suffix fails', t => {
  const f = fixture(t);
  for (const name of ['lesson-001a-one', 'lesson-001a-two']) f.put(`${name}.md`, f.topic(name));
  finding(f.check(), 'lessons.count', 'FAIL');
});
test('matching glob allow entry exempts the finding', t => {
  const f = fixture(t); f.put('MEMORY.md', 'x'.repeat(601));
  f.config.allow.push({ check: 'router.line', file: 'MEM*.md', reason: 'Fixture exception.', added: '2026-10-21' });
  const fail = finding(f.check(), 'router.line', 'FAIL');
  assert.equal(fail.allowed, true); assert.equal(fail.reason, 'Fixture exception.');
});
test('unused allow entry warns', t => {
  const f = fixture(t); f.config.allow.push({ check: 'router.line', file: 'MEMORY.md', reason: 'Old.', added: '2026-10-21' });
  finding(f.check(), 'config.allow-stale', 'WARN');
});
test('allow entry without reason fails', t => {
  const f = fixture(t); f.config.allow.push({ check: 'router.line', file: 'MEMORY.md', added: '2026-10-21' });
  finding(f.check(), 'config.allow', 'FAIL');
});
test('allow entry without date fails', t => {
  const f = fixture(t); f.config.allow.push({ check: 'router.line', file: 'MEMORY.md', reason: 'Old.' });
  finding(f.check(), 'config.allow', 'FAIL');
});
test('ratchet never raises pins, adds missing pins and removes obsolete pins', t => {
  const f = fixture(t); f.config.pins = { 'INDEX-main.md': 1, 'INDEX-old.md': 42 };
  f.put('INDEX-new.md', '# New\n');
  const configFile = path.join(f.root, 'config.json');
  ratchetPins({ memoryDir: f.memoryDir, config: f.config, configFile });
  assert.equal(f.config.pins['INDEX-main.md'], 1);
  assert.equal(f.config.pins['INDEX-new.md'], 6 + 1024);
  assert.equal(f.config.pins['INDEX-old.md'], undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')).pins, f.config.pins);
});
test('ratchet lowers oversized pins', t => {
  const f = fixture(t); const configFile = path.join(f.root, 'config.json');
  ratchetPins({ memoryDir: f.memoryDir, config: f.config, configFile });
  assert.equal(f.config.pins['INDEX-main.md'], fs.statSync(path.join(f.memoryDir, 'INDEX-main.md')).size + 1024);
});
test('allowlist writer deduplicates per-file findings and dates entries', t => {
  const f = fixture(t); f.put('MEMORY.md', 'x'.repeat(601) + '\n' + 'x'.repeat(601));
  const count = writeAllowlist({ result: f.check(), config: f.config, reason: 'Fixture.', configFile: path.join(f.root, 'config.json'), now: '2026-10-21' });
  assert.equal(count, 2); // Router line and rule orphan; the index still links topic.
  assert.equal(f.config.allow.filter(a => a.check === 'router.line').length, 1);
  assert.equal(f.config.allow.find(a => a.check === 'router.line').added, '2026-10-21');
});
test('session-start prints at most five lines on failure and exits zero', t => {
  const f = fixture(t); f.put('MEMORY.md', ('x'.repeat(601) + '\n').repeat(10));
  const result = f.cli('memory-check.mjs', ['--session-start']);
  assert.equal(result.status, 0); assert.ok(result.stdout.trim().split('\n').length <= 5);
  assert.match(result.stdout, /FAIL router.line/); assert.match(result.stdout, /memory gate: \d+ FAIL - run:/);
});
test('session-start missing memory prints exact message and exits zero', t => {
  const f = fixture(t); fs.rmSync(f.memoryDir, { recursive: true });
  const result = f.cli('memory-check.mjs', ['--session-start']);
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), 'memory gate: memory dir not found');
});
test('session-start internal errors remain one line and exit zero', t => {
  const f = fixture(t); const configFile = f.putRepo('bad.json', 'not json');
  const result = f.cli('memory-check.mjs', ['--session-start', '--config', configFile]);
  assert.equal(result.status, 0); assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.match(result.stdout, /^memory gate: error /);
});
test('fixture-only help smoke', t => {
  const f = fixture(t), result = f.cli('memory-check.mjs', ['--help']);
  assert.equal(result.status, 0); assert.match(result.stdout, /^Usage:/);
});
test('description query ranks the matching document first', t => {
  const f = fixture(t);
  f.put('topic.md', f.topic('topic', 'Orchard apples harvest cultivation.'));
  f.put('other.md', f.topic('other', 'Submarine navigation underwater.'));
  const corpus = buildCorpus(f);
  assert.equal(corpus.length, 3); assert.equal(search(corpus, 'orchard harvest', 3)[0].path, 'topic.md');
});
test('probes match any expected substring in the top three', t => {
  const f = fixture(t), probesFile = f.probes([
    { id: 'p01', q: 'useful fact', expect: ['missing', 'topic.md'], source: 'fixture' },
    { id: 'p02', q: 'useful fact', expect: ['absent.md'], source: 'fixture' },
  ]);
  const results = runProbes({ memoryDir: f.memoryDir, repo: f.repo, probesFile });
  assert.equal(results[0].pass, true); assert.equal(results[1].pass, false);
  const cli = f.cli('memory-recall.mjs', ['--probe', probesFile]);
  assert.equal(cli.status, 1); assert.match(cli.stdout, /p01 PASS rank/); assert.match(cli.stdout, /p02 FAIL top3:/);
});
test('probe CLI passes at minPass', t => {
  const f = fixture(t), probesFile = f.probes([{ id: 'p01', q: 'useful fact', expect: ['topic.md'], source: 'fixture' }]);
  const result = f.cli('memory-recall.mjs', ['--probe', probesFile]);
  assert.equal(result.status, 0); assert.match(result.stdout, /1\/1 pass \(100%\)/);
});
test('measure resolves first expect pattern and accounts for index bytes', t => {
  const f = fixture(t), probesFile = f.probes([{ id: 'p01', q: 'useful fact', expect: ['topic.md', 'rule.md'] }]);
  const result = measure({ ...f, probesFile }), p = result.recall.probes[0];
  assert.equal(p.ladderFile, 'topic.md');
  assert.equal(p.ladderBytes, ['MEMORY.md', 'INDEX-main.md', 'topic.md'].reduce((n, file) => n + fs.statSync(path.join(f.memoryDir, file)).size, 0));
  assert.equal(p.searchBytes, utf8Bytes(humanResults(search(buildCorpus(f), 'useful fact', 3)) + '\n') + fs.statSync(path.join(f.memoryDir, 'topic.md')).size);
  assert.match(readable(result), /Forgetting \(proxy\)/);
});
test('measure returns null for unreachable ladder and search', t => {
  const f = fixture(t), probesFile = f.probes([{ id: 'p01', q: 'nonexistentterm', expect: ['absent'] }]);
  const p = measure({ ...f, probesFile }).recall.probes[0];
  assert.equal(p.ladderBytes, null); assert.equal(p.ladderFile, null); assert.equal(p.searchBytes, null);
});
test('measure does not traverse indexes unlinked from router', t => {
  const f = fixture(t); f.put('MEMORY.md', '[Rule](rule.md)\n');
  const probesFile = f.probes([{ id: 'p01', q: 'useful fact', expect: ['topic.md'] }]);
  assert.equal(measure({ ...f, probesFile }).recall.probes[0].ladderBytes, null);
});
test('measure ladder supports linked brain files and skips memory stubs', t => {
  const f = fixture(t);
  f.putRepo('brain/03-knowledge/fact.md', '---\nid: fct-example\ntype: fact\nsummary: A useful fact.\n---\n# Fact\n');
  f.put('INDEX-main.md', '[Brain](../repo/brain/03-knowledge/fact.md)\n[Stub](stub.md)\n');
  f.put('stub.md', f.topic('stub', 'Moved.', 'moved_to: topic.md\n'));
  const probesFile = f.probes([{ id: 'p01', q: 'fact', expect: ['stub', 'fact.md'] }]);
  assert.equal(measure({ ...f, probesFile }).recall.probes[0].ladderFile, 'brain/03-knowledge/fact.md');
});
test('session legacy bytes use configured log tail and token divisor', t => {
  const f = fixture(t); f.config.measure.startLogTailLines = 2;
  f.putRepo('brain/00-system/log.md', 'first\nsecond\nthird\n'); f.putRepo('AGENTS.md', 'abc'); f.putRepo('CLAUDE.md', '12345');
  const probesFile = f.probes([]), result = measure({ ...f, probesFile });
  assert.equal(result.sessionStartLegacy.files.brainLogTail, utf8Bytes('second\nthird\n'));
  assert.equal(result.sessionStart.brainLogFullBytes, utf8Bytes('first\nsecond\nthird\n'));
  assert.equal(result.sessionStart.tokens, Math.round(result.sessionStart.totalBytes / 4));
});
test('forgetting counts individual lessons and dated corrections', t => {
  const f = fixture(t); f.put('lesson-001-first.md', f.topic('lesson-001-first', 'Lesson.', '', '2026-10-01 CORRECTION: was wrong.'));
  f.put('lesson-002-next.md', f.topic('lesson-002-next', 'Lesson.', '', '2026-09-01 Plain lesson.'));
  const result = measure({ ...f, probesFile: f.probes([]) }).forgetting;
  assert.deepEqual(result, { proxy: true, lessonsParsed: 2, corrections: 1, correctionsPerMonth: { '2026-10': 1 } });
});
test('forgetting parses numbered legacy lessons including suffixes', t => {
  const f = fixture(t); f.put('verification-lessons.md', f.topic('verification-lessons', 'Lessons.', '', '## 1. First\n2026-08-01 corrected\n**#2a - Next\n2026-09-01 repeated the mistake\n### 3: Third\nPlain observation.'));
  const result = measure({ ...f, probesFile: f.probes([]) }).forgetting;
  assert.equal(result.lessonsParsed, 3); assert.equal(result.corrections, 2);
  assert.deepEqual(result.correctionsPerMonth, { '2026-08': 1, '2026-09': 1 });
});
test('conserve accepts migration into any brain markdown', t => {
  const f = fixture(t); f.put('tokens.md', 'dec-conserved-thing');
  const baseline = snapshot(f); fs.unlinkSync(path.join(f.memoryDir, 'tokens.md'));
  f.putRepo('brain/00-system/history.md', 'dec-conserved-thing');
  assert.equal(verify({ ...f, baseline }).missing.includes('dec-conserved-thing'), false);
});
test('conserve reports lost tokens grouped by baseline files', t => {
  const f = fixture(t); f.put('tokens.md', 'dec-missing-thing');
  const baseline = snapshot(f); fs.unlinkSync(path.join(f.memoryDir, 'tokens.md'));
  const result = verify({ ...f, baseline });
  assert.deepEqual(result.missing, ['dec-missing-thing']); assert.deepEqual(result.byFile['tokens.md'], ['dec-missing-thing']);
});
test('conserve subtracts accepted tokens with reasons', t => {
  const f = fixture(t); f.put('tokens.md', 'dec-missing-thing');
  const baseline = snapshot(f); fs.unlinkSync(path.join(f.memoryDir, 'tokens.md'));
  const accepted = f.putRepo('accepted.json', JSON.stringify({ accepted: [{ token: 'dec-missing-thing', reason: 'Deliberately retired.' }] }));
  assert.equal(verify({ ...f, baseline, accepted }).count, 0);
});
test('conserve collects roadmap variants and unique union tokens', t => {
  const f = fixture(t); f.put('tokens.md', 'v3.2.1 v3.2.1');
  const baseline = snapshot(f); assert.equal(baseline.files['tokens.md'].sha256.length, 64);
  fs.unlinkSync(path.join(f.memoryDir, 'tokens.md')); f.putRepo('docs/ROADMAP-old.md', 'v3.2.1');
  assert.equal(verify({ ...f, baseline }).count, 0);
});
test('distinctive token regex families and URL punctuation', () => {
  const tokens = distinctiveTokens('abc1234 2026-10-21 https://example.test/a.,;: row_abcdef dec-example #12a v3.0.0 scripts/a.mjs');
  for (const token of ['abc1234', '2026-10-21', 'https://example.test/a', 'row_abcdef', 'dec-example', '#12a', 'v3.0.0', 'scripts/a.mjs']) assert.ok(tokens.includes(token), token);
});
test('hook installation writes marker and is idempotent without git init', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.memoryDir, '.git/hooks'), { recursive: true });
  assert.equal(install(f).ok, true);
  const hook = path.join(f.memoryDir, '.git/hooks/pre-commit'), text = fs.readFileSync(hook, 'utf8');
  assert.ok(text.includes(marker)); assert.ok(!text.includes('\r')); assert.match(text, /--scope memory --memory-dir/);
  assert.equal(install(f).ok, true); assert.equal(fs.readFileSync(hook, 'utf8'), text);
  if (process.platform !== 'win32') assert.equal(fs.statSync(hook).mode & 0o777, 0o755);
});
test('hook refuses overwrite of foreign pre-commit', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.memoryDir, '.git/hooks'), { recursive: true });
  const hook = path.join(f.memoryDir, '.git/hooks/pre-commit'); fs.writeFileSync(hook, '#!/bin/sh\necho foreign\n');
  assert.equal(install(f).ok, false); assert.equal(fs.readFileSync(hook, 'utf8'), '#!/bin/sh\necho foreign\n');
});
test('uninstall removes only an owned hook', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.memoryDir, '.git/hooks'), { recursive: true });
  install(f); assert.equal(install({ ...f, uninstall: true }).ok, true);
  const hook = path.join(f.memoryDir, '.git/hooks/pre-commit'); assert.equal(fs.existsSync(hook), false);
  fs.writeFileSync(hook, 'foreign'); assert.equal(install({ ...f, uninstall: true }).ok, false);
  assert.equal(fs.readFileSync(hook, 'utf8'), 'foreign');
});
test('install requires a .git folder', t => {
  const f = fixture(t); assert.equal(install(f).ok, false);
});
test('frontmatter parses escaped strings, both list styles and nesting', () => {
  const text = `---\nname: example\ndescription: ${JSON.stringify('quoted "value" and \nline')}\nlinks: ['[[x]]', "[[y]]"]\nitems:\n  - one\n  - 'two'\nmetadata:\n  state: true\n  stable: false\n---\n# Body`;
  const fm = parseFrontmatter(text);
  assert.equal(fm.data.description, 'quoted "value" and \nline');
  assert.deepEqual(fm.data.links, ['[[x]]', '[[y]]']); assert.deepEqual(fm.data.items, ['one', 'two']);
  assert.equal(fmGet(fm.data, 'state'), true); assert.equal(fmGet(fm.data, 'stable'), false);
  assert.equal(fm.body, '# Body'); assert.ok(fm.raw.startsWith('---'));
});
test('only an unclosed delimiter produces a frontmatter error', () => {
  const text = '---\nname: x', result = parseFrontmatter(text);
  assert.equal(result.data.__error, 'unclosed'); assert.equal(result.body, text); assert.equal(result.raw, '');
  assert.equal(parseFrontmatter('---\nname: "bad\n---\nbody').data.name, '"bad');
  assert.equal(parseFrontmatter('---\nmetadata:\n    deep: no\n---').data.metadata.deep, 'no');
});
test('link parsers strip anchors and aliases and ignore HTTP', () => {
  assert.deepEqual(mdLinks('[A](one.md#part) [B](https://example.test/a.md) [C](<two.md>)'), ['one.md', 'two.md']);
  assert.deepEqual(wikilinks('[[abc|alias]] [[xyz]]'), ['abc', 'xyz']);
});
test('brain discovery excludes system directories and includes shared nodes', t => {
  const f = fixture(t);
  for (const file of ['brain/top.md', 'brain/00-system/log.md', 'brain/_templates/x.md', 'brain/.claude/x.md', 'brain/.obsidian/x.md', 'brain/_shared/shared.md', 'brain/03-knowledge/fact.md']) f.putRepo(file, 'text');
  assert.deepEqual(brainPaths(f.repo), ['03-knowledge/fact.md', '_shared/shared.md']);
  assert.equal(walkMd(path.join(f.repo, 'brain')).length, 7);
});
test('brain checks detect missing metadata, duplicate ids and dead edges', t => {
  const f = fixture(t); f.putRepo('brain/03-knowledge/empty.md', '# Empty');
  f.putRepo('brain/03-knowledge/a.md', '---\nid: fct-one\ntype: fact\nsupports: ["[[missing]]"]\n---\nBody');
  f.putRepo('brain/03-knowledge/b.md', '---\nid: fct-one\ntype: fact\n---\nBody');
  const result = f.check('all'); finding(result, 'brain.frontmatter', 'FAIL'); finding(result, 'brain.duplicate-id', 'FAIL'); finding(result, 'brain.edge', 'WARN');
  assert.equal(f.check().findings.some(x => x.check.startsWith('brain.')), false);
});
test('memory wikilinks resolve shared brain ids in memory scope', t => {
  const f = fixture(t); f.putRepo('brain/_shared/shared.md', '---\nid: fct-shared\ntype: fact\n---\n');
  f.put('topic.md', f.topic('topic', 'Fact.', '', '[[fct-shared]] [[missing]]'));
  const warnings = f.check().findings.filter(x => x.check === 'wikilink.dead');
  assert.equal(warnings.length, 1); assert.equal(warnings[0].severity, 'WARN'); assert.match(warnings[0].message, /missing/);
});
test('hard-rule and state caps both apply', t => {
  const f = fixture(t); f.put('rule.md', f.topic('rule', 'State rule.', 'state: true\n', 'x'.repeat(8200)));
  const result = f.check(); finding(result, 'hardrule.size', 'FAIL'); finding(result, 'state.size', 'FAIL');
});
test('tokenizer removes stopwords and applies one light suffix stem', () => {
  assert.deepEqual(tokenize('The models running tested boxes cats'), ['model', 'runn', 'test', 'box', 'cat']);
});

function fakeGit(t, f, overrides = {}) {
  fs.mkdirSync(path.join(f.memoryDir, '.git'));
  f.config.allow = [];
  const calls = [];
  const replies = { 'rev-parse': 'true\n', remote: 'origin\n', status: '', 'rev-list': '0\n', log: '', ...overrides };
  t.mock.method(childProcess, 'execFileSync', (command, argv) => {
    assert.equal(command, 'git'); assert.deepEqual(argv.slice(0, 2), ['-C', f.memoryDir]);
    calls.push(argv.slice(2));
    const reply = replies[argv[2] === '-c' ? argv[4] : argv[2]];
    if (reply instanceof Error) throw reply;
    assert.notEqual(reply, undefined, 'Unexpected git operation');
    return reply;
  });
  return calls;
}
test('stale dates use one git history call and respect stable metadata', t => {
  const f = fixture(t);
  f.put('rule.md', f.topic('rule', 'Stable rule.', 'metadata:\n  stable: true\n'));
  const calls = fakeGit(t, f, { log: '\0' + '2026-10-20\n\nMEMORY.md\n\0' + '2026-01-01\n\ntopic.md\nrule.md\nMEMORY.md\n' });
  const result = f.check(); finding(result, 'stale', 'WARN', 'topic.md');
  assert.equal(result.findings.filter(x => x.check === 'stale').length, 1);
  assert.deepEqual(calls.filter(a => a.includes('log')), [['-c', 'core.quotepath=off', 'log', '--format=%x00%cs', '--name-only']]);
});
test('git remote warning is reported without running git', t => {
  const f = fixture(t); fakeGit(t, f, { remote: '' });
  finding(f.check(), 'repo.remote', 'WARN');
});
test('ahead count warns at the inclusive warning threshold', t => {
  const f = fixture(t); fakeGit(t, f, { 'rev-list': '1\n' });
  finding(f.check(), 'repo.ahead', 'WARN');
});
test('ahead count fails at the inclusive failure threshold', t => {
  const f = fixture(t); fakeGit(t, f, { 'rev-list': '10\n' });
  finding(f.check(), 'repo.ahead', 'FAIL');
});
test('uncommitted status warns', t => {
  const f = fixture(t); fakeGit(t, f, { status: ' M topic.md\n' });
  finding(f.check(), 'repo.uncommitted', 'WARN');
});
test('missing upstream and unavailable history skip their checks', t => {
  const f = fixture(t); fakeGit(t, f, { 'rev-list': new Error('no upstream'), log: new Error('no history') });
  assert.deepEqual(f.check().findings, []);
});
test('byte thresholds use UTF-8 bytes, not string length', t => {
  const f = fixture(t); f.put('topic.md', f.topic('topic', 'Fact.', '', '\u00e9'.repeat(10300)));
  finding(f.check(), 'topic.size', 'FAIL');
});
test('warning thresholds and exact failure boundary are distinct', t => {
  const f = fixture(t); f.put('MEMORY.md', 'x'.repeat(600));
  assert.equal(f.check().findings.some(x => x.check === 'router.line'), false);
  f.put('INDEX-main.md', 'x'.repeat(301)); finding(f.check(), 'index.line', 'WARN');
});
test('brain length checks are opt-in', t => {
  const f = fixture(t); f.putRepo('brain/03-knowledge/long.md', '---\nid: fct-long\ntype: fact\n---\n' + 'word '.repeat(351));
  assert.equal(f.check('all').findings.some(x => x.check === 'brain.length'), false);
  f.config.caps.brainNode.lengthChecks = true; finding(f.check('all'), 'brain.length', 'WARN');
});
test('1000-file gate fixture stays under the 5000 ms ceiling', t => {
  const f = fixture(t), links = [];
  for (let i = 0; i < 995; i++) {
    const name = `fact-${i}`; f.put(`${name}.md`, f.topic(name)); links.push(`[Fact](${name}.md)`);
  }
  f.put('ARCHIVE.md', links.join('\n'));
  const result = f.check();
  assert.equal(result.stats.files, 1000);
  assert.deepEqual(result.findings.filter(x => !x.allowed), []);
  assert.ok(result.stats.ms < 5000, `Gate took ${result.stats.ms} ms`);
  t.diagnostic(`1000-file gate: ${result.stats.ms} ms (no git processes)`);
});


// Fix round 1 regressions. Each R prefix corresponds to the review item.
test('R1 frontmatter preserves raw quotes, paths, tabs and partial scalar shapes', () => {
  const fm = parseFrontmatter(String.raw`---
description: "the "STOP and report" clause and D:\work\x path"
alternatives: [owner's call, b]
a.b: 1
bracket: [WIP] x
partial: "A" b
escaped: "raw "quote" and \"escaped\" \\ \n \t"
---
Body`);
  assert.equal(fm.data.description, String.raw`the "STOP and report" clause and D:\work\x path`);
  assert.deepEqual(fm.data.alternatives, ["owner's call", 'b']);
  assert.equal(fm.data['a.b'], 1);
  assert.equal(fm.data.bracket, '[WIP] x'); assert.equal(fm.data.partial, '"A" b');
  assert.equal(fm.data.escaped, 'raw "quote" and "escaped" \\ \n \t');
  assert.equal(parseFrontmatter('---\nx: "a\tb"\n---').data.x, 'a\tb');
  assert.equal(fm.data.__error, undefined);
});
test('R1 frontmatter supports BOM CRLF trailing delimiters and both block lists', t => {
  const f = fixture(t);
  const text = '\uFEFF--- \r\ndescription: valid\r\na:\r\n- one\r\n- two\r\nb:\r\n  - three\r\n  - four\r\n---\t\r\nBody';
  const fm = parseFrontmatter(text);
  assert.deepEqual(fm.data, { description: 'valid', a: ['one', 'two'], b: ['three', 'four'] });
  assert.equal(fm.body, 'Body');
  f.put('topic.md', text); f.put('MEMORY.md', '\uFEFF' + read(path.join(f.memoryDir, 'MEMORY.md')));
  assert.ok(!read(path.join(f.memoryDir, 'topic.md')).startsWith('\uFEFF'));
  assert.ok(!f.check().findings.some(x => ['fm.parse', 'desc.missing'].includes(x.check)));
  assert.ok(memoryFiles(f.memoryDir).find(x => x.file === 'rule.md').hardRule);
});
test('R1 frontmatter supports multiline flow lists, block scalars and object lists', () => {
  const fm = parseFrontmatter(`---
links: [
  "[[a]]",
  owner's call,
  b
]
folded: >-
  first
  second
clipped: >
  first
  second
literal: |
  first
  second
stripped: |-
  first
  second
edges:
  - type: supports
    target: "[[pat-x]]"
  - type: depends_on
    target: "[[pat-y]]"
after: retained
---`);
  assert.deepEqual(fm.data.links, ['[[a]]', "owner's call", 'b']);
  assert.equal(fm.data.folded, 'first second'); assert.equal(fm.data.clipped, 'first second\n');
  assert.equal(fm.data.literal, 'first\nsecond\n'); assert.equal(fm.data.stripped, 'first\nsecond');
  assert.deepEqual(fm.data.edges, [{ type: 'supports', target: '[[pat-x]]' }, { type: 'depends_on', target: '[[pat-y]]' }]);
  assert.equal(fm.data.after, 'retained');
});
test('R1 fm.parse warns once per file and preserves understood fields', t => {
  const f = fixture(t), text = '---\nname: topic\n???\ndescription: retained\n!bad\n---\nBody';
  const fm = parseFrontmatter(text);
  assert.deepEqual(fm.data.__warnings, [{ line: 3, text: '???' }, { line: 5, text: '!bad' }]);
  assert.equal(fm.data.description, 'retained');
  f.put('topic.md', text); f.putRepo('brain/03-knowledge/warn.md', text);
  const result = f.check('all');
  for (const file of ['topic.md', 'brain/03-knowledge/warn.md']) {
    const item = finding(result, 'fm.parse', 'WARN', file);
    assert.equal(item.line, 3); assert.equal(item.message, '2 frontmatter line(s) not understood');
    assert.equal(result.findings.filter(x => x.check === 'fm.parse' && x.file === file).length, 1);
  }
});
test('R1 R12 desc.missing true positive and unclosed frontmatter negative', t => {
  const f = fixture(t); f.put('topic.md', '---\nname: topic\n---\nBody');
  finding(f.check(), 'desc.missing', 'FAIL', 'topic.md');
  f.put('topic.md', '---\nname: topic');
  f.putRepo('brain/03-knowledge/bad.md', '---\nid: bad');
  const result = f.check('all');
  finding(result, 'fm.parse', 'FAIL', 'topic.md'); finding(result, 'fm.parse', 'FAIL', 'brain/03-knowledge/bad.md');
  assert.ok(!result.findings.some(x => x.check === 'desc.missing'));
  f.put('topic.md', '---\ndescription: ""\n---');
  finding(f.check(), 'desc.missing', 'FAIL');
});
const secretExamples = {
  anthropic: 'sk-ant-' + 'a'.repeat(40), openai: 'sk-proj-' + 'a'.repeat(40),
  aws: 'AKIA' + 'A'.repeat(16), github: 'ghp_' + 'a'.repeat(36), slack: 'xoxb-' + 'a'.repeat(20),
  'private-key': '-----BEGIN RSA PRIVATE KEY-----', google: 'AIza' + 'a'.repeat(35),
  jwt: 'eyJ' + 'a'.repeat(20) + '.' + 'b'.repeat(20) + '.' + 'c'.repeat(20), resend: 're_' + 'a'.repeat(20),
  stripe: 'sk_live_' + 'a'.repeat(20), 'github-pat': 'github_pat_' + 'a'.repeat(40),
  supabase: 'sbp_' + 'a'.repeat(40), webhook: 'whsec_' + 'a'.repeat(20),
};
for (const [name, key] of Object.entries(secretExamples)) test(`R2 R12 secret pattern ${name} positive and prefix policy`, t => {
  const f = fixture(t); f.put('topic.md', f.topic('topic', 'Fact.', '', key));
  const matches = f.check().findings.filter(x => x.check === 'secret');
  assert.equal(matches.length, 1); assert.equal(matches[0].severity, 'FAIL'); assert.match(matches[0].message, new RegExp(`pattern ${name}$`));
  assert.equal(redact(key), `[REDACTED:${name}]`);
  f.put('topic.md', f.topic('topic', 'Fact.', '', ['a', '0', '_', '-'].map(prefix => prefix + key).join('\n')));
  assert.equal(f.check().findings.filter(x => x.check === 'secret').length, name === 'openai' ? 0 : 4);
});
test('R2 secrets reject long task risk disk ids and report only one pattern per line', t => {
  const f = fixture(t);
  f.put('topic.md', f.topic('topic', 'Fact.', '', 'tsk-memory-engine-stage-one-build-toolset-0123456789\nrisk-' + 'a'.repeat(50) + '\ndisk-' + 'a'.repeat(50)));
  assert.ok(!f.check().findings.some(x => x.check === 'secret'));
  f.put('topic.md', f.topic('topic', 'Fact.', '', Object.values(secretExamples).join(' ')));
  assert.equal(f.check().findings.filter(x => x.check === 'secret').length, 1);
  f.put('topic.md', f.topic('topic', 'Fact.', '', 'rk_live_' + 'b'.repeat(20)));
  finding(f.check(), 'secret', 'FAIL');
});
test('R2 brain secrets and every diagnostic redact key-shaped targets in human and JSON', t => {
  const f = fixture(t), key = secretExamples.anthropic;
  f.put('MEMORY.md', `[x](${key}.md)`);
  f.put('topic.md', f.topic('topic', 'Fact.', '', `[[${key}]]`));
  f.put('stub.md', f.topic('stub', 'Moved.', `moved_to: ${key}.md\n`));
  f.putRepo('brain/03-knowledge/secret.md', `---\nid: fct-secret\ntype: fact\nsupports: ["[[${key}]]"]\n? ${key}\n---\n${key}`);
  const result = f.check('all');
  finding(result, 'secret', 'FAIL', 'brain/03-knowledge/secret.md');
  for (const id of ['link.dead', 'stub.target', 'wikilink.dead', 'brain.edge']) {
    const item = result.findings.find(x => x.check === id); assert.ok(item, id);
    assert.ok(item.message.includes('[REDACTED:anthropic]'), id);
  }
  finding(result, 'fm.parse', 'WARN', 'brain/03-knowledge/secret.md');
  assert.ok(!JSON.stringify(result).includes(key)); assert.ok(!result.findings.map(findingLine).join('\n').includes(key));
  const cli = f.cli('memory-check.mjs', ['--json']);
  assert.ok(!cli.stdout.includes(key)); assert.ok(cli.stdout.includes('[REDACTED:anthropic]'));
  assert.ok(!f.check('memory').findings.some(x => x.check === 'secret' && x.file.startsWith('brain/')));
});
test('R3 measured ceilings allow equality and expose growth with a suffix', t => {
  const f = fixture(t); f.put('MEMORY.md', 'x'.repeat(601));
  f.config.allow.push({ check: 'router.line', file: 'MEM*.md', ceiling: 601, reason: 'Baseline', added: '2026-10-21' });
  assert.equal(finding(f.check(), 'router.line', 'FAIL').allowed, true);
  f.put('MEMORY.md', 'x'.repeat(602));
  const item = finding(f.check(), 'router.line', 'FAIL');
  assert.equal(item.value, 602); assert.equal(item.allowed, false);
  assert.ok(item.message.endsWith('(grew past allowed ceiling 601)'));
});
test('R3 allowlist writer records max ceilings, excludes unsafe checks and converges', t => {
  const f = fixture(t); f.put('MEMORY.md', 'x'.repeat(601) + '\n' + 'y'.repeat(701));
  f.put('topic.md', '---\nname: topic'); f.put('secret.md', f.topic('secret', 'Fact.', '', secretExamples.openai));
  f.config.allow.push({ check: 'topic.size', file: 'old.md', reason: 'Retired', added: '2026-10-21' });
  const configFile = path.join(f.root, 'allow.json');
  const run = () => writeAllowlist({ result: f.check(), config: f.config, configFile, reason: 'Baseline' });
  assert.ok(run() > 0);
  assert.equal(f.config.allow.find(x => x.check === 'router.line').ceiling, 701);
  assert.ok(!f.config.allow.some(x => x.check === 'secret' || x.check.startsWith('config.') || x.check === 'fm.parse'));
  const first = read(configFile); assert.equal(run(), 0); assert.equal(read(configFile), first);
  assert.ok(!f.check().findings.some(x => x.check === 'config.allow-stale'));
});
test('R3 forbidden allow entries fail and fm.parse FAIL cannot be suppressed', t => {
  const f = fixture(t); f.put('topic.md', '---\nname: topic');
  for (const check of ['secret', 'config.allow', 'config.allow-stale', 'fm.parse']) f.config.allow.push({ check, file: '*', reason: 'Invalid', added: '2026-10-21' });
  const result = f.check();
  assert.equal(result.findings.filter(x => x.check === 'config.allow' && x.severity === 'FAIL').length, 3);
  assert.equal(finding(result, 'fm.parse', 'FAIL').allowed, false);
});
test('R3 allowlist staleness respects memory scope', t => {
  const f = fixture(t);
  const checks = ['repo.brain-log', 'repo.brain-index', 'repo.roadmap', 'repo.agents', 'brain.edge'];
  for (const check of checks) f.config.allow.push({ check, file: 'absent', reason: 'Repo baseline', added: '2026-10-21' });
  assert.ok(!f.check().findings.some(x => x.check === 'config.allow-stale'));
  assert.equal(f.check('all').findings.filter(x => x.check === 'config.allow-stale').length, checks.length);
});
test('R3 allowlist staleness skips checks the run did not evaluate', t => {
  const f = fixture(t);
  f.config.allow.push({ check: 'repo.remote', file: '.', reason: 'No remote yet', added: '2026-10-21' });
  f.config.allow.push({ check: 'fm.parse', file: 'brain/03-knowledge/x/dec-a.md', reason: 'Duplicate key', added: '2026-10-21' });
  const hookRun = runCheck({ memoryDir: f.memoryDir, repo: f.repo, scope: 'memory', config: f.config, now: '2026-10-21', hook: true });
  assert.deepEqual(hookRun.findings.filter(x => x.check === 'config.allow-stale').map(x => x.file), []);
  const memoryRun = runCheck({ memoryDir: f.memoryDir, repo: f.repo, scope: 'memory', config: f.config, now: '2026-10-21' });
  assert.ok(!memoryRun.findings.some(x => x.check === 'config.allow-stale' && x.file.startsWith('brain/')));
});
test('R3 1000 files by 1000 allow entries stays under the 5000 ms ceiling', t => {
  const f = fixture(t);
  for (let i = 0; i < 995; i++) f.put(`fact-${i}.md`, f.topic(`fact-${i}`));
  for (let i = 0; i < 1000; i++) f.config.allow.push({ check: 'link.orphan', file: `*${i}*.md`, reason: 'Baseline', added: '2026-10-21' });
  const result = f.check(); assert.equal(result.stats.files, 1000);
  // A ceiling, not a benchmark: the quadratic version took 2.2 s with no load; other sessions share this machine.
  assert.ok(result.stats.ms < 5000, `Gate took ${result.stats.ms} ms`);
  t.diagnostic(`1000 files x 1000 entries: ${result.stats.ms} ms`);
});
test('R4 isDirect resolves both real paths including Windows case differences', t => {
  const f = fixture(t), original = process.argv[1], calls = [];
  const alias = path.join(f.root, 'junction', 'check.mjs'), actual = path.join(f.root, 'real', 'check.mjs');
  process.argv[1] = alias; t.after(() => { process.argv[1] = original; });
  t.mock.method(fs, 'realpathSync', file => {
    calls.push(file);
    return file === alias && process.platform === 'win32' ? actual.toUpperCase() : actual;
  });
  assert.equal(isDirect(pathToFileURL(actual).href), true);
  assert.deepEqual(calls, [alias, actual]);
});
test('R5 stubs resolve string and list targets in memory and repo brain', t => {
  const f = fixture(t); f.putRepo('brain/03-knowledge/target.md', '# Target');
  f.put('stub.md', f.topic('stub', 'Moved.', 'moved_to: [topic.md, brain/03-knowledge/target.md]\n'));
  assert.ok(!f.check().findings.some(x => x.check === 'stub.target'));
  f.put('stub.md', f.topic('stub', 'Moved.', 'moved_to: brain/03-knowledge/target.md\n'));
  assert.ok(!f.check().findings.some(x => x.check === 'stub.target'));
  f.put('stub.md', f.topic('stub', 'Moved.', 'moved_to: [topic.md, brain/absent.md, absent.md]\n'));
  assert.equal(f.check().findings.filter(x => x.check === 'stub.target' && x.severity === 'FAIL').length, 2);
});
test('R5 Windows path spelling resolves links orphans hard rules and measure ladder', t => {
  const f = fixture(t), spelling = file => process.platform === 'win32' ? '.\\' + file.toUpperCase() : './' + file;
  f.put('MEMORY.md', `## Hard rules\n[Rule](${spelling('rule.md')})\n## Topics\n[Index](${spelling('INDEX-main.md')})`);
  f.put('INDEX-main.md', `[Topic](${spelling('topic.md')})`);
  const result = f.check(); assert.ok(!result.findings.some(x => ['link.dead', 'link.orphan'].includes(x.check)));
  assert.equal(memoryFiles(f.memoryDir).find(x => x.file === 'rule.md').hardRule, true);
  const measured = measure({ ...f, probesFile: f.probes([{ id: 'path', q: 'useful', expect: ['topic.md'] }]) });
  assert.equal(measured.recall.probes[0].ladderFile, 'topic.md');
  if (process.platform === 'win32') assert.equal(pathKey(f.memoryDir, '.\\TOPIC.md'), pathKey(f.memoryDir, 'topic.md'));
});
test('R6 slug replaces every nonalphanumeric and lookup keeps case fallback and override', t => {
  const f = fixture(t), old = process.env.CLAUDE_MEMORY_DIR;
  delete process.env.CLAUDE_MEMORY_DIR;
  t.after(() => { if (old === undefined) delete process.env.CLAUDE_MEMORY_DIR; else process.env.CLAUDE_MEMORY_DIR = old; });
  t.mock.method(os, 'homedir', () => f.root);
  assert.equal(memorySlug('C:\\Users\\x\\Repo\\.claude\\worktrees\\a.b'), 'C--Users-x-Repo--claude-worktrees-a-b');
  const repo = path.join(f.root, '.claude/worktrees/a.b'), projects = path.join(f.root, '.claude/projects');
  const slug = memorySlug(path.resolve(repo)), exact = path.join(projects, slug, 'memory');
  fs.mkdirSync(exact, { recursive: true }); assert.equal(memoryDir(repo), exact);
  fs.rmSync(path.join(projects, slug), { recursive: true });
  const lower = path.join(projects, slug.toLowerCase(), 'memory'); fs.mkdirSync(lower, { recursive: true });
  // Force the exact-case miss on case-insensitive filesystems to exercise fallback.
  const exists = fs.existsSync.bind(fs);
  t.mock.method(fs, 'existsSync', file => file === exact ? false : exists(file));
  assert.equal(memoryDir(repo), lower);
  process.env.CLAUDE_MEMORY_DIR = f.memoryDir; assert.equal(memoryDir(repo), f.memoryDir);
});
test('R7 brain discovery skips helper filenames in every case', t => {
  const f = fixture(t);
  for (const name of ['README.md', '_Manifest.MD', 'InDeX.md', 'node.md']) f.putRepo(`brain/03-knowledge/${name}`, 'body');
  assert.deepEqual(brainPaths(f.repo), ['03-knowledge/node.md']);
});
test('R7 brain duplicate ids ignore mirror pairs but retain duplicates within each side', t => {
  const f = fixture(t), node = '---\nid: fct-same\ntype: fact\n---\nBody';
  f.putRepo('brain/03-knowledge/a.md', node); f.putRepo('brain/_shared/a.md', node);
  assert.ok(!f.check('all').findings.some(x => x.check === 'brain.duplicate-id'));
  f.putRepo('brain/03-knowledge/b.md', node); f.putRepo('brain/_shared/b.md', node);
  assert.equal(f.check('all').findings.filter(x => x.check === 'brain.duplicate-id' && x.severity === 'FAIL').length, 2);
});
test('R7 brain.edge reads object-list targets as well as flat fields', t => {
  const f = fixture(t);
  f.putRepo('brain/03-knowledge/a.md', '---\nid: fct-a\ntype: fact\nedges:\n  - type: supports\n    target: "[[missing-object]]"\n  - type: supports\n    target: "[[fct-a]]"\nsupports: ["[[missing-flat]]"]\n---');
  const edges = f.check('all').findings.filter(x => x.check === 'brain.edge');
  assert.equal(edges.length, 2); assert.ok(edges.every(x => x.severity === 'WARN'));
  assert.ok(edges.some(x => x.message.includes('missing-object'))); assert.ok(edges.some(x => x.message.includes('missing-flat')));
});
test('R8 stemming handles plurals suffixes and expanded stopwords', () => {
  for (const [one, many] of [['rule', 'rules'], ['type', 'types'], ['name', 'names'], ['run', 'runs'], ['process', 'processes'], ['policy', 'policies'], ['push', 'pushes']]) assert.deepEqual(tokenize(many), tokenize(one));
  assert.deepEqual(tokenize('status bus'), ['status', 'bus']);
  assert.deepEqual(tokenize('how why what when where which who whom do does did should would could can i we you my our'), []);
  assert.deepEqual(tokenize('running tested'), ['runn', 'test']);
});
test('R8 name matches outrank body matches and stubs are excluded', t => {
  const f = fixture(t);
  f.put('orchard.md', f.topic('orchard', 'Useful.', '', 'Plain text'));
  f.put('body.md', f.topic('body', 'Useful.', '', 'orchard text'));
  f.put('stub.md', f.topic('orchard', 'orchard', 'moved_to: orchard.md\n', '# orchard'));
  const corpus = buildCorpus(f);
  assert.ok(!corpus.some(x => x.path === 'stub.md')); assert.equal(search(corpus, 'orchard')[0].path, 'orchard.md');
});
test('R8 probe counts only top three even when fourth result matches', t => {
  const f = fixture(t);
  for (const name of ['a', 'b', 'c', 'd']) f.put(`${name}.md`, f.topic(name, 'orchard', '', ''));
  const corpus = buildCorpus(f); assert.equal(search(corpus, 'orchard', 4)[3].path, 'd.md');
  const result = runProbes({ corpus, probes: { probes: [{ id: 'p', q: 'orchard', expect: ['d.md'] }] } })[0];
  assert.equal(result.pass, false); assert.equal(result.results.length, 3);
});
test('R8 probe CLI rounds percentages and reports missing files without JSON stack', t => {
  const f = fixture(t), probesFile = f.putRepo('probes.json', JSON.stringify({ version: 1, minPass: 0.57, probes: [] }));
  assert.match(f.cli('memory-recall.mjs', ['--probe', probesFile]).stdout, /minPass 57%/);
  const missing = path.join(f.root, 'missing.json'), result = f.cli('memory-recall.mjs', ['--probe', missing]);
  assert.equal(result.status, 1); assert.equal(result.stderr.trim(), `recall probes: file not found: ${missing}`);
});
test('R9 hook skips repo status checks but retains stale checks', t => {
  const f = fixture(t), calls = fakeGit(t, f, { remote: '', status: ' M topic.md', 'rev-list': '20', log: '\0' + '2026-01-01\ntopic.md\n' });
  const result = runCheck({ ...f, scope: 'memory', hook: true, now: '2026-10-21' });
  assert.ok(!result.findings.some(x => ['repo.remote', 'repo.ahead', 'repo.uncommitted'].includes(x.check)));
  assert.ok(!calls.some(x => ['remote', 'status', 'rev-list'].includes(x[0])));
  finding(result, 'stale', 'WARN', 'topic.md');
});
test('R9 hook allows internal errors but rejects ordinary FAIL findings', t => {
  const f = fixture(t), bad = f.putRepo('bad.json', '{');
  const error = f.cli('memory-check.mjs', ['--hook', '--scope', 'memory', '--config', bad]);
  assert.equal(error.status, 0); assert.match(error.stdout, /^memory gate: internal error, commit allowed: /);
  f.put('MEMORY.md', 'x'.repeat(601));
  const fail = f.cli('memory-check.mjs', ['--hook', '--scope', 'memory']);
  assert.equal(fail.status, 1); assert.match(fail.stdout, /FAIL router.line/);
});
test('R9 hook honors configured relative and absolute hooksPath with portable shell paths', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.memoryDir, '.git'));
  for (const configured of ['custom-hooks', path.join(f.root, 'absolute-hooks')]) {
    t.mock.method(childProcess, 'execFileSync', (command, argv) => {
      assert.equal(command, 'git'); assert.deepEqual(argv, ['-C', f.memoryDir, 'config', '--local', 'core.hooksPath']); return configured + '\n';
    });
    assert.equal(install(f).ok, true);
    const text = read(path.join(path.resolve(f.memoryDir, configured), 'pre-commit'));
    assert.match(text, /command -v node/); assert.match(text, /memory gate skipped: node not found/);
    assert.match(text, /--hook --scope memory/); assert.ok(!text.includes('\\'));
    assert.ok(text.includes(path.resolve(f.repo, 'scripts/memory/memory-check.mjs').replace(/\\/g, '/')));
    assert.ok(text.indexOf('command -v node') < text.indexOf('\nnode '));
  }
});
test('R9 state headings cannot cross line boundaries', t => {
  const f = fixture(t);
  f.put('topic.md', f.topic('topic', 'State', 'state: true\n', '#\nRESUME\n#\nCURRENT\n'));
  assert.ok(!f.check().findings.some(x => x.check === 'state.headings'));
  f.put('topic.md', f.topic('topic', 'State', 'state: true\n', '#\tRESUME\n## CURRENT\n'));
  assert.equal(finding(f.check(), 'state.headings', 'FAIL').value, 2);
});
test('R9 stale skips router indexes archive and disables git path quoting', t => {
  const f = fixture(t), calls = fakeGit(t, f, { log: '\0' + '2026-01-01\nMEMORY.md\nINDEX-main.md\nARCHIVE.md\ntopic.md\n' });
  const items = f.check().findings.filter(x => x.check === 'stale');
  assert.deepEqual(items.map(x => x.file), ['topic.md']);
  assert.ok(calls.some(x => x[0] === '-c' && x[1] === 'core.quotepath=off' && x[2] === 'log'));
});
test('R10 conserve path scanning is linear and trims path URL punctuation', t => {
  const start = performance.now(), tokens = distinctiveTokens('x'.repeat(30000));
  const ms = performance.now() - start; assert.ok(ms < 100, `Conserve took ${ms} ms`); assert.deepEqual(tokens, []);
  t.diagnostic(`30000-char conserve: ${ms.toFixed(2)} ms`);
  const found = distinctiveTokens('(["scripts/a.tsx")],;:!?* `scripts/b.mjs` https://example.test/a.,;:!?*)]>"\'');
  assert.ok(found.includes('scripts/a.tsx')); assert.ok(found.includes('scripts/b.mjs')); assert.ok(found.includes('https://example.test/a'));
  assert.ok(!distinctiveTokens('x'.repeat(201) + '.md').some(x => x.endsWith('.md')));
});
test('R10 conserve ignores originSessionId modified frontmatter but retains body tokens', () => {
  const tokens = distinctiveTokens('---\noriginSessionId: abc1234\nmodified: 2026-09-01\nkeep: 2026-08-01\n---\nmodified: 2026-10-01');
  assert.ok(!tokens.includes('abc1234')); assert.ok(!tokens.includes('2026-09-01'));
  assert.ok(tokens.includes('2026-08-01')); assert.ok(tokens.includes('2026-10-01'));
});
test('R11 forgetting uses explicit date or body date and narrow correction markers', t => {
  const f = fixture(t);
  const lessons = [
    ['date: 2026-06-01\nmodified: 2026-01-01\n', '2026-07-01 same mistake'],
    ['modified: 2026-01-01\n', '2026-08-01 repeat mistake'],
    ['modified: 2026-01-01\n', '2026-09-01 repeated the mistake'],
    ['', '2026-10-01 Try again twice.'], ['', 'Plain observation.'],
  ];
  lessons.forEach(([extra, body], i) => f.put(`lesson-00${i + 1}-x.md`, f.topic(`lesson-00${i + 1}-x`, 'Lesson', extra, body)));
  const result = measure({ ...f, probesFile: f.probes([]) }).forgetting;
  assert.equal(result.lessonsParsed, 5); assert.equal(result.corrections, 3);
  assert.deepEqual(result.correctionsPerMonth, { '2026-06': 1, '2026-08': 1, '2026-09': 1 });
});
test('R12 router.missing name.mismatch and link.orphan positive checks', t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.memoryDir, 'MEMORY.md'));
  finding(f.check(), 'router.missing', 'FAIL', 'MEMORY.md');
  f.put('orphan.md', f.topic('different'));
  const result = f.check(); finding(result, 'name.mismatch', 'WARN', 'orphan.md'); finding(result, 'link.orphan', 'WARN', 'orphan.md');
});
test('R12 index.size and archive.line positive checks carry measurements', t => {
  const f = fixture(t); f.put('INDEX-main.md', 'x'.repeat(24577)); f.put('ARCHIVE.md', 'x'.repeat(301));
  const result = f.check(); assert.equal(finding(result, 'index.size', 'FAIL').value, 24577);
  assert.equal(finding(result, 'archive.line', 'FAIL').value, 301);
});
for (const [key, id, severity] of [['brainLog', 'repo.brain-log', 'FAIL'], ['roadmap', 'repo.roadmap', 'FAIL'], ['agents', 'repo.agents', 'WARN']]) test(`R12 ${id} positive size check`, t => {
  const f = fixture(t), cap = f.config.caps[key], bytes = (cap.failBytes ?? cap.warnBytes) + 1;
  f.putRepo(cap.path, 'x'.repeat(bytes)); assert.equal(finding(f.check('all'), id, severity).value, bytes);
  assert.ok(!f.check().findings.some(x => x.check === id));
});
test('R12 repo.brain-index positive and resolved cases', t => {
  const f = fixture(t); f.putRepo(f.config.caps.brainIndex.path, '# Empty');
  finding(f.check('all'), 'repo.brain-index', 'WARN');
  f.putRepo(f.config.caps.brainIndex.path, '[[fct-example]]');
  assert.ok(!f.check('all').findings.some(x => x.check === 'repo.brain-index' && /no wikilinks/.test(x.message)));
});
for (const [file, capKey, id, extra] of [['MEMORY.md', 'router', 'router.size', ''], ['topic.md', 'topic', 'topic.size', ''], ['topic.md', 'state', 'state.size', 'state: true\n'], ['rule.md', 'hardRule', 'hardrule.size', '']]) test(`R12 ${id} warning branch carries bytes`, t => {
  const f = fixture(t), target = f.config.caps[capKey].warnBytes + 1;
  const base = file === 'MEMORY.md' ? '# Router\n' : f.topic(file.slice(0, -3), 'Useful', extra);
  f.put(file, base + 'x'.repeat(target - utf8Bytes(base)));
  assert.equal(finding(f.check(), id, 'WARN', file).value, target);
});
test('R12 index.pin room warning and description length warning carry values', t => {
  const f = fixture(t), bytes = fs.statSync(path.join(f.memoryDir, 'INDEX-main.md')).size;
  f.config.pins['INDEX-main.md'] = bytes + 399; f.put('topic.md', f.topic('topic', 'x'.repeat(201)));
  const result = f.check(); assert.equal(finding(result, 'index.pin', 'WARN').value, bytes);
  assert.equal(finding(result, 'desc.length', 'WARN').value, 201);
});
test('R12 lessons.count recognizes hard-won wording and INDEX claims', t => {
  const f = fixture(t); f.put('lesson-001-x.md', f.topic('lesson-001-x'));
  f.put('MEMORY.md', '2 hard-won lessons'); f.put('INDEX-main.md', '3 lessons');
  const result = f.check(); finding(result, 'lessons.count', 'FAIL', 'MEMORY.md'); finding(result, 'lessons.count', 'FAIL', 'INDEX-main.md');
});
test('R12 Hard rules end at next level-two heading and wikilinks resolve names and filenames', t => {
  const f = fixture(t);
  f.put('MEMORY.md', '## Hard rules\n[Rule](rule.md)\n## Topics\n[Topic](topic.md)');
  const files = memoryFiles(f.memoryDir);
  assert.equal(files.find(x => x.file === 'rule.md').hardRule, true); assert.equal(files.find(x => x.file === 'topic.md').hardRule, false);
  f.put('topic.md', f.topic('alias', 'Useful', '', '[[alias]] [[topic]] [[absent]]'));
  const items = f.check().findings.filter(x => x.check === 'wikilink.dead');
  assert.equal(items.length, 1); assert.match(items[0].message, /absent/);
});
test('R12 measure triggers totals maximum and searchHitRate', t => {
  const f = fixture(t); f.put('MEMORY.md', '## Hard rules\n[Rule](rule.md)\n[Topic](topic.md)');
  const probesFile = f.probes([{ id: 'yes', q: 'useful', expect: ['topic.md'] }, { id: 'no', q: 'zzzz', expect: ['missing'] }]);
  const result = measure({ ...f, probesFile });
  const bytes = ['rule.md', 'topic.md'].map(file => ({ file, bytes: fs.statSync(path.join(f.memoryDir, file)).size }));
  assert.equal(result.triggers.total, bytes.reduce((n, item) => n + item.bytes, 0));
  assert.deepEqual(result.triggers.max, bytes.sort((a, b) => b.bytes - a.bytes)[0]);
  assert.equal(result.recall.totals.searchHitRate, 0.5);
});
test('R12 conserve accepted requires a nonempty reason', t => {
  const f = fixture(t), baseline = snapshot(f);
  for (const reason of [undefined, '', ' ']) assert.throws(() => verify({ ...f, baseline, accepted: { accepted: [{ token: 'x', reason }] } }), /require token and reason/);
});
test('R12 session-start ok line has exact counts and engine text', t => {
  const f = fixture(t);
  f.putRepo('brain/03-knowledge/process/fct-example.md', stage3Node('fct-example'));
  assert.equal(f.cli('brain-index.mjs', ['--write']).status, 0);
  assert.equal(f.cli('roadmap-overview.mjs', ['--write']).status, 0);
  const configFile = f.putRepo('config.json', JSON.stringify(f.config));
  const result = f.cli('memory-check.mjs', ['--session-start', '--config', configFile]);
  assert.equal(result.status, 0); assert.equal(result.stdout.trim(), `memory gate: ok (1 allowed, 0 warn, engine ${f.config.engine_version})`);
});

test('R1 multiline flow lists close at the outer bracket and keep following fields', () => {
  const result = parseFrontmatter('---\nitems: [one,\n [[pat-x]]\n]\nafter: retained\npartial: [unfinished\nnext: intact\n---');
  assert.deepEqual(result.data.items, ['one', [['pat-x']]]);
  assert.equal(result.data.after, 'retained'); assert.equal(result.data.partial, '[unfinished'); assert.equal(result.data.next, 'intact');
});
test('R5 Windows filename matching includes pins wiki paths allow globs and probe expectations', t => {
  const f = fixture(t), spelling = file => process.platform === 'win32' ? file.toUpperCase() : file;
  f.config.pins = { [spelling('INDEX-main.md')]: 2000 };
  f.put('topic.md', f.topic('topic', 'Useful', '', `[[${spelling('rule')}]]`));
  f.put('orphan.md', f.topic('orphan'));
  f.config.allow.push({ check: 'link.orphan', file: spelling('orphan.md'), reason: 'Baseline', added: '2026-10-21' });
  const result = f.check(); assert.ok(!result.findings.some(x => ['index.missing-pin', 'wikilink.dead'].includes(x.check)));
  assert.equal(finding(result, 'link.orphan', 'WARN', 'orphan.md').allowed, true);
  const probesFile = f.probes([{ id: 'case', q: 'useful', expect: [spelling('topic.md')] }]);
  const metric = measure({ ...f, probesFile });
  assert.equal(metric.recall.probes[0].ladderFile, 'topic.md'); assert.equal(metric.recall.probes[0].searchHit, true);
});

const skillFixtureText = {
  "memory-ladder": "---\nname: memory-ladder\ndescription: Use the v3 memory ladder for capture, recall, the gate, converting old memory, and installation in this project.\nengine_version: \"3.1.0\"\n---\n\n# Memory ladder v3\n\nUse the [engine](../../engine/README.md); follow `AGENTS.md`,\n[the ladder and caps](../../engine/README.md) and authorized paths.\n\n## Route to the right layer\n\n- Keep hard-rule triggers, active work and craft/domain routing in `MEMORY.md`.\n  The router gains a line only for a new hard rule or an active-work item;\n  route everything else through an index and file. Keep hard-rule triggers visible.\n- Put activity pointers in `INDEX-craft-<activity>.md` and domain pointers in\n  `INDEX-<domain>.md`. Write router and index lines as triggers:\n  `OPEN BEFORE <activity>` / `OPEN when work touches <domain>`.\n- Give each lesson or fact one kebab-case file with frontmatter `name`, static\n  `description` (at most 200 characters), and `metadata.type` (`user`, `feedback`,\n  `project`, or `reference`). Explain what happened, why, and how to apply it.\n  Use absolute dates and exact identifiers.\n- Keep a state file with `state: true` and exactly one current block. Overwrite\n  that block at each checkpoint; use git to recover earlier state.\n- Move shipped router pointers into `ARCHIVE.md`, a ledger of pointers and tags,\n  never a body-text dump. ARCHIVE is never loaded by default.\n- Put project facts in `brain/` under its protocol. Keep only the agent-side rule\n  and a resolving `brain: brain/.../node.md` pointer in private memory.\n\n**State is overwritten. Facts are moved. History is git.**\nRead caps and pins from `scripts/memory/memory.config.json`. Never raise a pin or\nan allowlist ceiling to pass the gate. Move detail down a layer. Write and prove\nthe destination before shortening its pointer. Never grow old-name recovery stubs.\n\nKeep each hard-rule file at or below 2 KB. Retain every value needed to obey it:\npaths, commands, ids, quotas, and accounts. Move only explanation and history\ninto linked backgrounds.\n\n## Capture at the moment of learning\n\nRun recall before writing. Update the same idea; do not duplicate it. Give a new\nlesson a `lesson-NNN-<slug>.md` file, numbered highest existing number plus one.\nUse three digits and an optional lowercase suffix: `lesson-054b-<slug>.md`.\nMatch the gate's `lesson-\\d{3}[a-z]?-.+\\.md` pattern.\nAdd one line to its matching `INDEX-craft-*`. Bump router/index lesson counts.\nKeep distinct lessons out of journals.\n\nDo not duplicate repo records. Capture durable knowledge when learned.\nKeep an unresolved `[[wikilink]]` only as a marker for a lesson worth writing later;\ninspect its warning. Link related memories with `[[name]]`.\nDelete a memory that proves wrong; a wrong memory is worse than none.\nTreat a memory naming a file, flag or number as a point-in-time observation;\nverify it before asserting it.\n\nAt every checkpoint, update memory, write a lesson with the why, refresh the\nroadmap's Open work and the decision board, copy specs/evidence still in a temp folder into `docs/`,\nrun the gate, and commit and push the memory repo. Say that you did it.\nAt checkpoints also run:\n\n```sh\nnode scripts/memory/memory-rotate.mjs log --write\nnode scripts/memory/brain-index.mjs --write\nnode scripts/memory/roadmap-overview.mjs --write\n```\n\nShelf programs in `docs/shelf/<name>.md` with `shelved`/`review`; the gate warns on the review date.\n\nPreserve the current task's fences; report blocked writeback to its integration owner.\n\n## Recall before opening indexes\n\nRun from the repo:\n\n```sh\nnode scripts/memory/memory-recall.mjs \"<question>\"\n```\n\nRead relevant results; then OPEN the index named by the router's \"OPEN BEFORE …\"\nline for this activity before acting. Honor domain and hard-rule triggers;\nnever bulk-load topic files.\n\n## Gate\n\nAt session start and checkpoints, run:\n\n```sh\nnode scripts/memory/memory-check.mjs\n```\n\nUse `--json` for finding details. Use `--session-start` for the compact hook\nreport; it always exits zero, so use the normal gate to enforce FAIL findings.\nMemory pre-commit runs:\n\n```sh\nnode scripts/memory/memory-check.mjs --hook --scope memory\n```\n\nUse `--memory-dir PATH` and `--repo PATH`. Reserve `--no-git`\nfor fenced copies; report skipped checks. Match both skills' `engine_version`\nto config; `repo.skill-version` warns on missing or stale versions.\n\n## Convert old memory with proof\n\nFollow [conversion steps and proofs](../../docs/CONVERT.md).\nUse a git-excluded copy. Tag and snapshot the original FIRST; name EVERY destination and legal cut point.\nPreserve bodies verbatim and resolving old-name stubs.\nExtract by content, never by line number.\n\nRun both conservation modes before and after moving:\n\n```sh\nnode scripts/memory/memory-conserve.mjs snapshot --memory-dir COPY --out tokens.json\nnode scripts/memory/memory-conserve.mjs blocks-snapshot --out blocks.json --source SOURCE\nnode scripts/memory/memory-conserve.mjs verify --memory-dir COPY --baseline tokens.json\nnode scripts/memory/memory-conserve.mjs blocks-verify --baseline blocks.json --dest DESTINATION --json\n```\n\nRepeat `--source`/`--dest`; keep baselines outside moved sources. Give accepted\nexceptions reasons, source/heading and an index for repeated headings. Inspect\nmissing, altered, duplicated and out-of-order blocks; test recall and run the gate BEFORE adoption.\n\nHave a different model list every original imperative and check the rewrite,\nincluding operational values. Adopt only after review and both proofs pass;\ntoken presence alone cannot prove unchanged prose. Keep evidence outside `.memwork/`.\n\n## Install for this project\n\nLocate memory at `CLAUDE_MEMORY_DIR` if set; otherwise use\n`~/.claude/projects/<absolute-repo-path-slug>/memory`. Replace every non-alphanumeric\ncharacter in the absolute repo path with `-`. Substitute `MEMORY_PATH` below.\n\nCreate the directory, router and linked files; take a baseline commit:\n\n```md\n# Memory\n## Hard rules\n- [Rule](rule.md) — OPEN BEFORE <activity>.\n## Craft\n- [Activity](INDEX-craft-activity.md) — OPEN BEFORE <activity>.\n## Domains\n- [Domain](INDEX-domain.md) — OPEN when work touches <domain>.\n## Active work\n- [Current](current-state.md) — OPEN BEFORE resuming work.\n```\n\nUse resolving triggers, topic descriptions and state frontmatter `state: true`\nwith one `## CURRENT` block. Initialize pins with the ratchet; never raise them.\nRun from the project repository:\n\n```sh\ngit -C MEMORY_PATH init\nnode scripts/memory/memory-check.mjs --memory-dir MEMORY_PATH --ratchet-pins\nnode scripts/memory/memory-check.mjs --memory-dir MEMORY_PATH\ngit -C MEMORY_PATH add .\ngit -C MEMORY_PATH commit -m \"Baseline memory\"\nnode scripts/memory/install-hooks.mjs --memory-dir MEMORY_PATH --repo PROJECT_PATH\n```\n\nMerge this real hook into `.claude/settings.json`, preserving other settings:\n\n```json\n{\"hooks\":{\"SessionStart\":[{\"hooks\":[{\"type\":\"command\",\"shell\":\"bash\",\"command\":\"node \\\"${CLAUDE_PROJECT_DIR:-.}/scripts/memory/memory-check.mjs\\\" --session-start\",\"timeout\":10}]}]}}\n```\n\nAdd the AGENTS.md \"Memory gate\" block with these rules:\n- Run `node scripts/memory/memory-check.mjs` at session start and every checkpoint;\n  fix or report FAIL. Claude Code uses SessionStart; other agents run it manually.\n  The memory pre-commit runs `--hook --scope memory`.\n- Run `node scripts/memory/memory-recall.mjs \"<question>\"` before opening indexes;\n  then honor the router's required activity index before acting.\n- Overwrite state; move facts; keep history in git. Keep one current state block,\n  one lesson per file, and project facts in `brain/` with pointers from memory.\n  Never raise pins or allowlist ceilings to pass; move detail down a layer.\n\nOptional private remote: `git -C MEMORY_PATH remote add origin URL`, then\n`git -C MEMORY_PATH push -u origin HEAD`. Push at every checkpoint.\n",
  "memory-review": "---\nname: memory-review\ndescription: Audit this project's v3 memory with the Node gate and repair only reported FAIL or WARN findings. Use for memory review, checkpoint checks, or fixing stale, oversized, or broken memory.\nengine_version: \"3.1.0\"\n---\n\n# Review v3 memory\n\nRun from the project repository:\n\n```sh\nnode scripts/memory/memory-check.mjs\nnode scripts/memory/memory-check.mjs --json\n```\n\nUse `--memory-dir PATH` and `--repo PATH` for explicit targets. Act only on\nnon-allowed FAIL/WARN findings. Open only the flagged files and destinations\nneeded to repair them. Do not bulk-read memory. Use the\n[engine README](../../engine/README.md) for check details and the\n[memory ladder](../memory-ladder/SKILL.md) for capture and conversion rules.\n\nRepair the reported class:\n\n- `router.*`, `index.*`, `archive.*`, `topic.size`, `state.size`, and\n  `hardrule.size`: move detail into atomic files or linked backgrounds. Preserve\n  hooks and every operational value in hard rules. Keep hard-rule files at most\n  2 KB. Split an index by activity/domain when necessary. Never raise a pin or allow ceiling;\n  move detail down a layer.\n- `state.headings`: keep one current block; recover old state from git. Move\n  durable facts to their proper homes before replacing stale state.\n- `desc.*`: move changelog/detail to its proper file and write a static\n  description of at most 200 characters.\n- `link.*`, `stub.target`, `brain.pointer*`: repair the destination or pointer;\n  link orphan files from the appropriate index or parent. Preserve old-name\n  stubs and keep project facts in `brain/` with memory pointers.\n- `wikilink.dead` and `brain.edge`: correct the target or retain a deliberate\n  marker for a lesson worth writing later. Do not invent a fact to clear a flag.\n- `name.*`, `fm.parse`, `brain.frontmatter`, and `brain.duplicate-id`: repair\n  identity/frontmatter, or consolidate duplicate facts in one home and retarget\n  pointers. Keep recoverable history in git.\n- `lessons.count` and `lessons.cite`: reconcile numbered lesson files, cited\n  numbers, and router/index counts. Give each distinct lesson one file.\n- `repo.brain-log`, `repo.roadmap`, `repo.agents`, `repo.brain-index`, and\n  `brain.length`: move durable detail down a layer, retain navigation, and rotate\n  history only under an authorized migration with token and block proofs.\n- `stale`: read the description, then verify possibly changed facts against the\n  current source. Do not assume age alone proves a memory wrong.\n- `repo.not-git`, `repo.remote`, `repo.ahead`, and `repo.uncommitted`: inspect the\n  memory repo and complete its authorized git checkpoint. For `repo.git-skipped`,\n  report unavailable coverage and run without `--no-git` on the actual repo when\n  authorized.\n- `repo.skill-version`: compare these two skill files with the config and update\n  stale instructions and their `engine_version` together.\n- `config.*`: repair malformed allow entries, retire stale exceptions, and move\n  detail down a layer when a finding grows. Never increase a ceiling to pass.\n- `secret`: remove the credential from tracked content without echoing it;\n  report the exposure for authorized credential remediation. Never allow it.\n\nRerun the gate after repairs and report remaining findings. Use absolute dates,\nkeep one fact per file, and update rather than duplicate the same idea. Commit\nand push authorized memory changes at the checkpoint. Respect task fences.\nDelete memories that are obsolete or superseded. Merge files that hold the same fact;\nretarget their links and keep history in git.\n\nTreat `scripts/memory-health.ps1` in this skill's directory\n(`.claude/skills/memory-review/scripts/memory-health.ps1`) as retired in this\nproject and kept for history only. Do not delete or run it as the gate.\n"
};
function skillFixture(t, name) {
  const f = fixture(t);
  const file = f.putRepo('.claude/skills/' + name + '/SKILL.md', skillFixtureText[name]);
  f.putRepo('.claude/settings.json', "{\n  \"hooks\": {\n    \"SessionStart\": [\n      {\n        \"hooks\": [\n          {\n            \"type\": \"command\",\n            \"shell\": \"bash\",\n            \"command\": \"node \\\"${CLAUDE_PROJECT_DIR:-.}/scripts/memory/memory-check.mjs\\\" --session-start\",\n            \"timeout\": 10\n          }\n        ]\n      }\n    ]\n  }\n}\n");
  assert.equal(f.cli('memory-check.mjs', ['--session-start']).status, 0);
  return { text: read(file), settings: JSON.parse(read(path.join(f.repo, '.claude/settings.json'))) };
}
