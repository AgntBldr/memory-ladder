// The kit standard block, the Project rules section and sorting an old memory section on a first update.
// Fixtures use synthetic lines only; no ledger file and no Git tags are needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {fixture, ok, put, read, json, tree, kitRoot, currentVersion, nextVersion, bump, assertInstructionSpans} from './helpers.mjs';
import {standardBlockPlan} from '../scripts/install-safety.mjs';
import {preview} from '../scripts/instructions-sort.mjs';

const template = read(path.join(kitRoot, 'templates/AGENTS-memory-gate.md'));
const BEGIN = version => `<!-- kit standard block (memory kit ${version}): begin. The kit replaces everything up to the end marker on every update; put project rules under "## Project rules". -->`;
const END = '<!-- kit standard block: end -->';
const RULES_LINE = 'Rules for this project only. The kit adds old lines here once, when it sorts them on a first update; it never edits or removes them.';
const eolOf = (text, eol) => text.replace(/\r?\n/g, eol);
const block = (eol = '\n', version = currentVersion) => eolOf(BEGIN(version) + '\n' + template + END + '\n', eol);
const IMPORT = '@AGENTS.md';
const importBlock = (eol = '\n', version = currentVersion) => eolOf(BEGIN(version) + '\n' + IMPORT + '\n' + END + '\n', eol);
const rules = (kept = [], eol = '\n') => eolOf('## Project rules\n' + RULES_LINE + '\n' + (kept.length ? '\n' + kept.map(line => line + '\n').join('') : ''), eol);
const unitId = text => createHash('sha256').update(text.replace(/\r\n/g, '\n').split('\n').map(line => line.replace(/[ \t]+$/, '')).join('\n')).digest('hex').slice(0, 12);
const first60 = text => Array.from(text.replace(/\r\n/g, '\n').replace(/\n[ \t]*/g, ' ')).slice(0, 60).join('');
const SESSION_330 = '- Session phrases: when a message is only "We are starting a new session - read this and let me know when we can start" or "handover" (or /new-session, /handover), run `node scripts/memory/new-session.mjs dispatch --message "<the message>"` and follow its output; never inside a subagent or `codex exec` brief. Offer /handover at a stage end or on wrap-up.';
const REPORTS_331 = '- Reports: never a wall of text. Group facts under short bold headings, one fact per bullet, a blank line between groups. Link every file you name (a path relative to the project root) and every board or page by its full URL. End finished work by saying whether it is safe to compact; say yes only if /handover reported it since the last change.';
const SESSION_NOW = '- Session phrases: when a message is only "We are starting a new session - read this and let me know when we can start" or "handover" (or /new-session, /handover), run `node scripts/memory/new-session.mjs dispatch --message "<the message>"` and follow its output; never inside a subagent or `codex exec` brief. Run /handover only when the operator asks for it; do not offer it unprompted.';
const REPORTS_NOW = '- Reports: never a wall of text. Group facts under short bold headings, one fact per bullet, a blank line between groups. Link every file you name (a path relative to the project root) and every board or page by its full URL. End finished work by saying whether it is safe to compact; say yes only when memory and the work are committed and pushed and the memory gate has no FAIL. /handover is not required for it.';
// The memory gate section as a 3.3.1 install wrote it.
const old331 = template.replace(SESSION_NOW, SESSION_330).replace(REPORTS_NOW, REPORTS_331);
const CUSTOM = '- Synthetic project rule: keep the widget log tidy.';
const withCustom = (text, unit = CUSTOM) => text.replace('- Claude Code uses SessionStart', unit + '\n- Claude Code uses SessionStart');
const sortTool = path.join(kitRoot, 'scripts/instructions-sort.mjs');

function installed(t) {
  const f = fixture(t);
  ok(f.install());
  const agents = path.join(f.target, 'AGENTS.md'), claude = path.join(f.target, 'CLAUDE.md');
  const run = (args = [], base = kitRoot) => f.cli('scripts/upgrade.mjs', ['--target', f.target, ...args], base);
  const sort = args => f.exec(process.execPath, [sortTool, ...args]);
  const backups = () => fs.readdirSync(path.join(f.target, 'scripts/memory')).filter(name => name.startsWith('.kit-backup-')).sort().map(name => path.join(f.target, 'scripts/memory', name));
  return {...f, agents, claude, run, sort, backups};
}
// An installed project whose instruction files look like an older kit wrote them (no markers yet).
function oldShape(f, text = '\n\n' + old331) { put(f.agents, text); put(f.claude, '@AGENTS.md\n'); return text; }
function decide(f, dir, outcome, extra = {}) {
  const file = path.join(dir, 'decisions.json'), decisions = json(file);
  for (const value of Object.values(decisions.decisions)) Object.assign(value, {outcome, reason: 'Synthetic reason for ' + outcome + '.', decidedBy: 'fixture operator'}, extra);
  put(file, JSON.stringify(decisions, null, 2));
  return file;
}
const ledgerFile = (f, entries) => put(path.join(f.root, 'sorting-ledger.json'), JSON.stringify({version: 1, entries: entries.map(entry => Buffer.from(JSON.stringify(entry), 'utf8').toString('base64'))}));
const entry = (text, outcome, scope, project, reason) => ({id: unitId(text), text, outcome, scope, reason, decidedBy: 'operator ' + project, source: 'decision', matched: [], project, date: '2026-01-02'});

test('B-T1 fresh install appends the block and Project rules and keeps LF or CRLF', t => {
  const f = fixture(t), before = tree(f.root, {git: true});
  const dry = ok(f.install(['--dry-run']));
  assert.ok(dry.stdout.split(/\r?\n/).includes('INSTRUCTIONS AGENTS.md: standard block add; first update: yes'));
  assert.ok(dry.stdout.split(/\r?\n/).includes('INSTRUCTIONS CLAUDE.md: standard block add; first update: yes'));
  assert.deepEqual(tree(f.root, {git: true}), before);
  ok(f.install());
  const agents = read(path.join(f.target, 'AGENTS.md'));
  assert.equal(agents, '\n\n' + block() + '\n' + rules());
  assertInstructionSpans('', agents);
  assert.equal(read(path.join(f.target, 'CLAUDE.md')), importBlock());
  const g = fixture(t);
  put(path.join(g.target, 'AGENTS.md'), '# Host\r\nKeep this.\r\n');put(path.join(g.target, 'CLAUDE.md'), '# Claude host\r\n');
  ok(g.install());
  const crlf = read(path.join(g.target, 'AGENTS.md'));
  assert.equal(crlf, '# Host\r\nKeep this.\r\n\r\n' + block('\r\n') + '\r\n' + rules([], '\r\n'));
  assert.ok(!crlf.replaceAll('\r\n', '').includes('\n'));
  assert.equal(read(path.join(g.target, 'CLAUDE.md')), '# Claude host\r\n\r\n' + importBlock('\r\n'));
  assertInstructionSpans('# Host\r\nKeep this.\r\n', crlf);
});

test('B-T2 an update replaces only the block; bytes before and after stay', t => {
  const f = installed(t);
  const edited = '# Before the block\n' + read(f.agents) + '\n## After\nKeep these bytes.\n';
  put(f.agents, edited);put(f.claude, 'Claude intro.\n' + read(f.claude) + 'Claude tail.\n');
  const claudeBefore = read(f.claude), next = bump(f);
  const result = ok(f.run(['--live-memory'], next));
  assert.ok(result.stdout.split(/\r?\n/).includes('INSTRUCTIONS AGENTS.md: standard block replace; first update: no'));
  assert.equal(read(f.agents), edited.replace(BEGIN(currentVersion), BEGIN(nextVersion)));
  assertInstructionSpans(edited, read(f.agents));
  assert.equal(read(f.claude), claudeBefore.replace(BEGIN(currentVersion), BEGIN(nextVersion)));
  const settled = tree(f.target);
  assert.match(ok(f.run([], next)).stdout, /same version and hashes; no-op/);
  assert.deepEqual(tree(f.target), settled);
});

test('B-T3 a local edit inside the block warns, is replaced, and the backup and report keep it', t => {
  const f = installed(t), original = read(f.agents);
  const line = '- Claude Code uses SessionStart; this project edited the kit line.';
  // One kit line edited and one deleted: a changed line counts once, so two lines differ.
  const edited = original.replace(/^- Claude Code uses SessionStart[^\n]*$/m, line).replace(REPORTS_NOW + '\n', '');
  put(f.agents, edited);
  const warning = `WARN AGENTS.md standard block differs from kit ${currentVersion} text (2 lines); the update replaces it; move lines you need to "## Project rules" first`;
  const before = tree(f.root, {git: true, previous: true}), checked = f.run(['--check']);
  assert.equal(checked.status, 1);
  assert.ok(checked.stdout.split(/\r?\n/).includes(warning), checked.stdout);
  assert.deepEqual(tree(f.root, {git: true, previous: true}), before);
  const applied = ok(f.run());
  assert.ok(applied.stdout.split(/\r?\n/).includes(warning), applied.stdout);
  assert.equal(read(f.agents), original);
  const backup = f.backups().at(-1);
  assert.equal(read(path.join(backup, 'AGENTS.md')), edited);
  const report = json(path.join(backup, 'instructions-report.json'));
  const kept = report.entries.find(entry => entry.source === 'edit-inside-block');
  assert.equal(Buffer.from(kept.text64, 'base64').toString('utf8'), line);
  assert.deepEqual([kept.outcome, kept.reason, kept.decidedBy], ['replace', 'edit inside the standard block, replaced', 'kit']);
});

test('B-T4 damaged markers refuse before any write', t => {
  const f = installed(t), good = read(f.agents), begin = BEGIN(currentVersion);
  for (const [what, text] of [
    ['begin without end', good.replace(END + '\n', '')],
    ['end without begin', good.replace(begin + '\n', '')],
    ['two begin markers', good.replace(begin, begin + '\n' + begin)],
    ['end before begin', good.replace(begin, '@@').replace(END, begin).replace('@@', END)],
  ]) {
    put(f.agents, text);
    const before = tree(f.root, {git: true, previous: true}), result = f.run();
    assert.equal(result.status, 1, what);
    assert.ok(result.stderr.includes(`upgrade: AGENTS.md standard block markers are damaged (${what}); fix them by hand or restore the file, then run again`), result.stderr);
    assert.deepEqual(tree(f.root, {git: true, previous: true}), before, what);
  }
});

test('B-T5 an old section of shipped kit wording is replaced without questions', t => {
  const f = installed(t), before = oldShape(f);
  const checked = f.run(['--check']);
  assert.equal(checked.status, 1);
  const lines = checked.stdout.split(/\r?\n/);
  assert.ok(lines.includes(`REPLACE ${unitId('## Memory gate')} (kit pre-3.2.0..v3.3.7): ## Memory gate`));
  assert.ok(lines.includes(`REPLACE ${unitId(SESSION_330)} (kit v3.3.0..v3.3.3): ${first60(SESSION_330)}`));
  assert.ok(lines.includes(`REPLACE ${unitId(REPORTS_331)} (kit v3.3.1..v3.3.3): ${first60(REPORTS_331)}`));
  assert.ok(!lines.some(line => /^(?:UNCLEAR|KEEP|DROP) /.test(line)));
  const applied = ok(f.run());
  assert.equal(read(f.agents), '\n\n' + block() + '\n' + rules());
  assertInstructionSpans(before, read(f.agents));
  assert.equal(read(f.claude), importBlock());
  const report = json(path.join(f.backups().at(-1), 'instructions-report.json'));
  assert.equal(report.entries.filter(entry => entry.file === 'AGENTS.md').length, old331.split('\n').filter(line => line.trim()).length);
  assert.ok(report.entries.every(entry => entry.outcome === 'replace' && entry.scope === 'general' && entry.decidedBy === 'kit'));
  assert.ok(applied.stdout.includes(`instructions: ${report.entries.length} replaced, 0 kept in Project rules, 0 dropped; report: ${path.join(f.backups().at(-1), 'instructions-report.json')}`));
  assert.ok(applied.stdout.includes('lesson: close this update with a "what we learned" lesson: node scripts/memory/memory-lesson.mjs new --route <family> --kind observation "What we learned: kit ' + currentVersion + ' instructions update"'));
});

for (const outcome of ['keep', 'drop']) test(`B-T6 unclear lines stop the update; a ${outcome} decision applies`, t => {
  const f = installed(t), before = oldShape(f, withCustom('\n\n' + old331)), out = path.join(f.root, 'sorting');
  const snapshot = tree(f.root, {git: true, previous: true}), refused = f.run();
  assert.equal(refused.status, 1);
  assert.ok(refused.stderr.includes(`upgrade: AGENTS.md has 1 unclear lines in its old memory section; write decisions with: node "${sortTool}" preview --target "${f.target}" --out <folder>, fill <folder>/decisions.json, then run again with --instructions-decisions <folder>/decisions.json`), refused.stderr);
  assert.ok(refused.stdout.split(/\r?\n/).includes(`UNCLEAR ${unitId(CUSTOM)}: ${first60(CUSTOM)}`));
  assert.deepEqual(tree(f.root, {git: true, previous: true}), snapshot);
  ok(f.sort(['preview', '--target', f.target, '--out', out]));
  const draft = json(path.join(out, 'decisions.json'));
  assert.deepEqual(draft.decisions, {[unitId(CUSTOM)]: {text: CUSTOM, outcome: '', scope: 'project', reason: '', decidedBy: ''}});
  const decisions = decide(f, out, outcome);
  const applied = ok(f.run(['--instructions-decisions', decisions]));
  const label = outcome === 'keep' ? `KEEP ${unitId(CUSTOM)} -> Project rules (decision): ` : `DROP ${unitId(CUSTOM)} (decision): `;
  assert.ok(applied.stdout.split(/\r?\n/).includes(label + first60(CUSTOM)));
  assert.equal(read(f.agents), '\n\n' + block() + '\n' + rules(outcome === 'keep' ? [CUSTOM] : []));
  assertInstructionSpans(before, read(f.agents), {kept: outcome === 'keep' ? [CUSTOM] : []});
  const report = json(path.join(f.backups().at(-1), 'instructions-report.json'));
  const row = report.entries.find(entry => entry.id === unitId(CUSTOM));
  assert.deepEqual({...row, text64: Buffer.from(row.text64, 'base64').toString('utf8')}, {id: unitId(CUSTOM), text64: CUSTOM, outcome, scope: 'project',
    reason: 'Synthetic reason for ' + outcome + '.', decidedBy: 'fixture operator', source: 'decision', matched: [], project: path.basename(f.target), file: 'AGENTS.md', date: row.date});
  assert.match(row.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(applied.stdout.includes(`instructions: to keep these decisions for later projects, add the report to your kit's sorting ledger, from a kit branch: node "${sortTool}" ledger-add --from "${path.join(f.backups().at(-1), 'instructions-report.json')}" --project ${path.basename(f.target)} --ledger <ledger file>`));
  if (outcome === 'drop') assert.ok(!read(f.agents).includes(CUSTOM));
});


test('B-T8 a general ledger entry decides by itself', t => {
  const f = installed(t), before = oldShape(f, withCustom('\n\n' + old331));
  const ledger = ledgerFile(f, [entry(CUSTOM, 'keep', 'general', 'project-x', 'Every project keeps this rule.')]);
  const applied = ok(f.run(['--instructions-ledger', ledger]));
  assert.ok(applied.stdout.split(/\r?\n/).includes(`KEEP ${unitId(CUSTOM)} -> Project rules (general ledger project-x, 2026-01-02): ${first60(CUSTOM)}`));
  assert.ok(!applied.stdout.includes('UNCLEAR'));
  assertInstructionSpans(before, read(f.agents), {kept: [CUSTOM]});
  const row = json(path.join(f.backups().at(-1), 'instructions-report.json')).entries.find(item => item.id === unitId(CUSTOM));
  assert.deepEqual([row.outcome, row.scope, row.source, row.reason, row.decidedBy], ['keep', 'general', 'ledger', 'general ledger entry project-x, 2026-01-02: Every project keeps this rule.', 'operator project-x']);
});

test('B-T10 the proof blocks a lost unit before any write', t => {
  const f = installed(t);
  oldShape(f);
  const driver = put(path.join(f.root, 'drop-unit.mjs'), `import {upgrade} from ${JSON.stringify(pathToFileURL(path.join(kitRoot, 'scripts/upgrade.mjs')).href)};
try { process.exitCode = upgrade({target: ${JSON.stringify(f.target)}}, undefined, {instructions: {afterSort: units => { units.splice(1, 1); }}}); }
catch (error) { console.error('upgrade: ' + error.message); process.exitCode = 1; }
`);
  const before = tree(f.root, {git: true, previous: true}), result = f.exec(process.execPath, [driver]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes('upgrade: instructions proof failed: P2; nothing written'), result.stderr);
  assert.deepEqual(tree(f.root, {git: true, previous: true}), before);
});

test('a real first update without an old section writes an empty report and the reminders; a later run writes none', t => {
  const f = installed(t);
  put(f.agents, '# Host\nNo memory section here.\n');put(f.claude, IMPORT + '\n');
  const applied = ok(f.run()), lines = applied.stdout.split(/\r?\n/);
  assert.ok(lines.includes('INSTRUCTIONS AGENTS.md: standard block add; first update: yes'));
  const reportPath = path.join(f.backups().at(-1), 'instructions-report.json'), report = json(reportPath);
  assert.deepEqual([report.project, report.entries], [path.basename(f.target), []]);
  assert.ok(lines.includes(`instructions: 0 replaced, 0 kept in Project rules, 0 dropped; report: ${reportPath}`), applied.stdout);
  assert.ok(lines.includes(`instructions: to keep these decisions for later projects, add the report to your kit's sorting ledger, from a kit branch: node "${sortTool}" ledger-add --from "${reportPath}" --project ${path.basename(f.target)} --ledger <ledger file>`));
  assert.ok(lines.includes(`lesson: close this update with a "what we learned" lesson: node scripts/memory/memory-lesson.mjs new --route <family> --kind observation "What we learned: kit ${currentVersion} instructions update"`));
  const reports = () => f.backups().filter(dir => fs.existsSync(path.join(dir, 'instructions-report.json'))).length, count = reports();
  const again = ok(f.run());
  assert.doesNotMatch(again.stdout, /^instructions: /m);
  assert.equal(reports(), count);
});

test('an instruction file that is not UTF-8 refuses before any write', t => {
  const host = Buffer.concat([Buffer.from('# Host\nCaf'), Buffer.from([0xe9]), Buffer.from(' rule saved as Windows-1252.\n')]);
  const f = planned(t, host), result = f.plan();
  assert.equal(result.refusalKind, 'encoding');
  assert.equal(result.refusal, 'AGENTS.md is not UTF-8 text (first invalid byte at offset 10); save it as UTF-8, then run again; nothing written');
  assert.deepEqual(result.writes, []);
  const claude = planned(t, '# Host\n', Buffer.concat([Buffer.from('Claude caf'), Buffer.from([0xe9]), Buffer.from('\n')])).plan();
  assert.equal(claude.refusal, 'CLAUDE.md is not UTF-8 text (first invalid byte at offset 10); save it as UTF-8, then run again; nothing written');
  const errors = [], log = console.log, error = console.error;
  console.log = () => {};console.error = line => errors.push(line);
  try { assert.equal(preview({target: f.target}), 1); } finally { console.log = log;console.error = error; }
  assert.deepEqual(errors, ['preview: ' + result.refusal]);
  const before = tree(f.root, {git: true}), run = f.install();
  assert.equal(run.status, 1);assert.ok(run.stderr.includes(result.refusal), run.stderr);
  assert.deepEqual(tree(f.root, {git: true}), before);
  assert.ok(fs.readFileSync(path.join(f.target, 'AGENTS.md')).equals(host));
});

test('B-T19 the template and the handover skill carry the confirmed wording', () => {
  const lines = template.split('\n');
  assert.equal(lines[11], SESSION_NOW);assert.equal(lines[12], REPORTS_NOW);
  const skill = read(path.join(kitRoot, 'skills/handover/SKILL.md')), description = skill.split('\n').find(line => line.startsWith('description:'));
  assert.ok(description.endsWith('Run only when asked; never offered unprompted.'));
  assert.ok(!skill.includes('Offer at stage end/wrap-up; the user decides.'));
});

// Tests below that check only sorting and placement plan in-process, without an install: the plan's writes are
// exactly the bytes install and upgrade write (they pass them through unchanged). The tests above run the CLI.
function planned(t, agents, claude) {
  const f = fixture(t);
  if (agents === null) fs.unlinkSync(path.join(f.target, 'AGENTS.md')); else put(path.join(f.target, 'AGENTS.md'), agents);
  if (claude !== undefined) put(path.join(f.target, 'CLAUDE.md'), claude);
  const plan = (opts = {}, hooks = {}, root = kitRoot) => {
    const lines = [], log = console.log, before = tree(f.root, {git: true});
    console.log = line => lines.push(line);
    let result;
    try { result = standardBlockPlan(f.target, root, opts, hooks); } finally { console.log = log; }
    assert.deepEqual(tree(f.root, {git: true}), before, 'planning writes nothing');
    return {...result, lines, written: name => result.writes.find(([file]) => path.basename(file) === name)?.[1]};
  };
  const decisions = map => put(path.join(f.root, 'decisions.json'), JSON.stringify({version: 1, project: 'fixture', decisions: Object.fromEntries(Object.entries(map).map(([text, outcome]) => [unitId(text), {outcome, reason: 'Fixture ' + outcome + '.', decidedBy: 'fixture'}]))}));
  return {...f, plan, decisions};
}

for (const eol of ['\n', '\r\n']) test(`B-T7 a bullet with continuation lines moves whole ${JSON.stringify(eol)}`, t => {
  const unit = '- Synthetic wrapped rule\n  second line of the rule\n\n\tthird line after a blank line';
  const before = eolOf(withCustom('\n\n' + old331, unit), eol), f = planned(t, before);
  assert.deepEqual(f.plan().plans[0].plan.unclear.map(item => item.raw), [eolOf(unit, eol)]);
  const result = f.plan({'instructions-decisions': f.decisions({[unit]: 'keep'})});
  assert.equal(result.written('AGENTS.md'), eolOf('\n\n' + block() + '\n' + rules([unit]), eol));
  assertInstructionSpans(before, result.written('AGENTS.md'), {kept: [eolOf(unit, eol)]});
});

test('B-T9 conflicting general ledger entries leave the line unclear and show both', t => {
  const f = planned(t, withCustom('\n\n' + old331)), out = path.join(f.root, 'sorting');
  const entries = [entry(CUSTOM, 'keep', 'general', 'project-x', 'Keep it.'), entry(CUSTOM, 'drop', 'general', 'project-z', 'Drop it.')];
  const ledger = ledgerFile(f, entries), result = f.plan({'instructions-ledger': ledger});
  assert.equal(result.refusalKind, 'unclear');assert.match(result.refusal, /^AGENTS.md has 1 unclear lines/);assert.deepEqual(result.writes, []);
  assert.ok(result.lines.includes(`UNCLEAR ${unitId(CUSTOM)} (ledger conflict): ${first60(CUSTOM)}`));
  const log = console.log;console.log = () => {};
  try { assert.equal(preview({target: f.target, out, ledger}), 0); } finally { console.log = log; }
  const row = json(path.join(out, 'sort-report.json')).entries.find(item => item.id === unitId(CUSTOM));
  assert.equal(row.outcome, 'unclear');assert.deepEqual(row.matched, entries);
  // A decision settles the conflict; the report still carries both conflicting entries.
  const decided = f.plan({'instructions-ledger': ledger, 'instructions-decisions': f.decisions({[CUSTOM]: 'keep'})});
  assert.equal(decided.refusal, null);
  const settled = decided.report.entries.find(item => item.id === unitId(CUSTOM));
  assert.deepEqual([settled.outcome, settled.source, settled.matched], ['keep', 'decision', entries]);
});

test('B-T11 the session phrases and reports lines stay byte-identical inside the block', t => {
  const before = '# Host\n\n' + template + '\n## Next\nKeep.\n', result = planned(t, before).plan();
  for (const line of [SESSION_NOW, REPORTS_NOW]) {
    assert.ok(result.lines.includes(`REPLACE ${unitId(line)} (current template): ${first60(line)}`));
    assert.equal(result.written('AGENTS.md').split(line + '\n').length, 2);
  }
  assert.equal(result.written('AGENTS.md'), '# Host\n\n' + block() + '\n' + rules() + '\n## Next\nKeep.\n');
  assertInstructionSpans(before, result.written('AGENTS.md'));
});

test('B-T12 a "Memory ladder" heading takes the block; its subsections stay', t => {
  const intro = 'Synthetic ladder intro line.', rule = '- Synthetic ladder rule.';
  const before = '# Host\n\n# Memory ladder: synthetic\n\n' + intro + '\n' + rule + '\n\n## Sub\nSub stays.\n', f = planned(t, before);
  const sorted = f.plan({check: true});
  assert.ok(!sorted.lines.some(line => /heading missing/.test(line)));
  assert.deepEqual(sorted.lines.filter(line => line.startsWith('UNCLEAR')), [`UNCLEAR ${unitId(intro)}: ${intro}`, `UNCLEAR ${unitId(rule)}: ${rule}`]);
  const result = f.plan({'instructions-decisions': f.decisions({[intro]: 'drop', [rule]: 'keep'})});
  assert.equal(result.written('AGENTS.md'), '# Host\n\n# Memory ladder: synthetic\n\n' + block() + '\n' + rules([rule]) + '\n## Sub\nSub stays.\n');
  assertInstructionSpans(before, result.written('AGENTS.md'), {kept: [rule]});
});

test('B-T13 without an old section the block is appended and nothing else changes', t => {
  const before = '# Host\nNo memory section here.\n', result = planned(t, before).plan();
  assert.ok(!result.lines.some(line => /heading missing/.test(line)));
  assert.equal(result.written('AGENTS.md'), before + '\n' + block() + '\n' + rules());
  assertInstructionSpans(before, result.written('AGENTS.md'));
});

test('B-T14 CLAUDE.md holds only the import block; a CLAUDE.md-only project gets the full block', t => {
  const f = planned(t, '\n\n' + old331, 'Claude intro.\n' + IMPORT + '\nClaude tail.\n'), result = f.plan();
  assert.equal(result.written('CLAUDE.md'), 'Claude intro.\n' + importBlock() + 'Claude tail.\n');
  assert.doesNotMatch(result.written('CLAUDE.md'), /Project rules\n/);
  for (const [file, data] of result.writes) put(file, data);
  assert.deepEqual(f.plan().writes, []);
  assert.equal(planned(t, '\n\n' + old331, 'Claude only text.\n').plan().written('CLAUDE.md'), 'Claude only text.\n\n' + importBlock());
  const text = '# Claude host\n\n' + old331, only = planned(t, null, text).plan();
  assert.ok(only.lines.includes('INSTRUCTIONS CLAUDE.md: standard block add; first update: yes'));
  assert.equal(only.written('CLAUDE.md'), '# Claude host\n\n' + block() + '\n' + rules());
  assertInstructionSpans(text, only.written('CLAUDE.md'));
  assert.equal(only.writes.length, 1);
});

test('B-T15 the preview tool writes only its two files outside the project', t => {
  const f = planned(t, withCustom('\n\n' + old331)), sort = args => f.exec(process.execPath, [sortTool, ...args]);
  const out = path.join(f.root, 'sorting'), before = tree(f.target, {git: true, previous: true});
  const result = ok(sort(['preview', '--target', f.target, '--out', out]));
  assert.match(result.stdout, /preview: 14 units: 13 replace, 0 keep, 0 drop, 1 unclear/);
  assert.deepEqual(fs.readdirSync(out).sort(), ['decisions.json', 'sort-report.json']);
  assert.deepEqual(tree(f.target, {git: true, previous: true}), before);
  const inside = sort(['preview', '--target', f.target, '--out', path.join(f.target, 'sorting')]);
  assert.equal(inside.status, 1);assert.match(inside.stderr, /preview: --out must be outside the project/);
  assert.ok(!fs.existsSync(path.join(f.target, 'sorting')));
  assert.equal(sort(['preview']).status, 2);
});

test('B-T20 kit wording outside the old section is warned about and kept', t => {
  const shipped = template.split('\n').find(line => line.startsWith('- Claude Code uses SessionStart'));
  const text = '\n\n' + old331 + '\n## Other\n' + shipped + '\n', result = planned(t, text).plan({check: true});
  assert.ok(result.lines.includes(`WARN AGENTS.md:${text.split('\n').lastIndexOf(shipped) + 1} repeats kit wording outside the standard block`));
  assert.ok(result.written('AGENTS.md').endsWith('## Other\n' + shipped + '\n'));
  assertInstructionSpans(text, result.written('AGENTS.md'));
});

test('B-T21 an existing Project rules section above the old section gets the kept unit', t => {
  const before = '## Project rules\nFirst project line.\nSecond project line.\n\n' + withCustom(old331), f = planned(t, before);
  const after = f.plan({'instructions-ledger': ledgerFile(f, [entry(CUSTOM, 'keep', 'general', 'project-x', 'Keep.')])}).written('AGENTS.md');
  assert.equal(after, '## Project rules\nFirst project line.\nSecond project line.\n' + CUSTOM + '\n\n' + block());
  assert.equal((after.match(/^## Project rules$/gm) ?? []).length, 1);
  assertInstructionSpans(before, after, {kept: [CUSTOM]});
  // The span check itself: the same bytes inserted between two existing project lines must fail it.
  const moved = after.replace('First project line.\nSecond project line.\n' + CUSTOM + '\n', 'First project line.\n' + CUSTOM + '\nSecond project line.\n');
  assert.notEqual(moved, after);
  assert.throws(() => assertInstructionSpans(before, moved, {kept: [CUSTOM]}), /kept lines inserted exactly after the last line of the existing Project rules section/);
});

test('B-T22 an existing Project rules section below the old section gets the kept unit', t => {
  const tail = '\n## Between\nStays exactly.\n\n## Project rules\nFirst project line.\nSecond project line.';
  const before = withCustom(old331) + tail, f = planned(t, before);
  const after = f.plan({'instructions-ledger': ledgerFile(f, [entry(CUSTOM, 'keep', 'general', 'project-x', 'Keep.')])}).written('AGENTS.md');
  assert.equal(after, block() + tail + '\n' + CUSTOM + '\n');
  assertInstructionSpans(before, after, {kept: [CUSTOM]});
});

test('B-T25 a project entry from another project is only a suggestion', t => {
  const f = planned(t, withCustom('\n\n' + old331));
  const result = f.plan({'instructions-ledger': ledgerFile(f, [entry(CUSTOM, 'drop', 'project', 'project-x', 'Not needed there.')])});
  assert.ok(result.lines.includes(`UNCLEAR ${unitId(CUSTOM)} (suggested drop by project-x, 2026-01-02: Not needed there.): ${first60(CUSTOM)}`));
  assert.equal(result.refusalKind, 'unclear');assert.deepEqual(result.writes, []);
});

test('decisions files are checked before any write', t => {
  const f = planned(t, withCustom('\n\n' + old331)), id = unitId(CUSTOM), file = path.join(f.root, 'decisions.json');
  for (const [decisions, message] of [
    [{'unknown-unit': {outcome: 'keep', reason: 'x'}}, 'decisions file names unknown unit unknown-unit'],
    [{[id]: {outcome: 'keep', reason: ' '}}, `decision ${id} has no reason`],
    [{[id]: {outcome: 'keep', reason: 'x', scope: 'team'}}, `decision ${id} has an unknown scope team`],
  ]) {
    put(file, JSON.stringify({version: 1, project: 'p', decisions}));
    const result = f.plan({'instructions-decisions': file});
    assert.equal(result.refusal, message);assert.deepEqual(result.writes, []);
  }
});

test('the plan is pure and its proof rejects a changed render', t => {
  const f = planned(t, '\n\n' + old331, IMPORT + '\n');
  const result = f.plan();
  assert.equal(result.refusal, null);assert.equal(result.writes.length, 2);
  const broken = f.plan({}, {afterRender: text => text.replace('- Claude Code uses', '- Claude Code used')});
  assert.equal(broken.refusal, 'instructions proof failed: P1; nothing written');
});

const warnLine = (version, n) => `WARN AGENTS.md standard block differs from kit ${version} text (${n} lines); the update replaces it; move lines you need to "## Project rules" first`;
test('deleted, duplicated and reordered block lines warn before the block is replaced', t => {
  const installedText = block() + '\n' + rules();
  const cases = [
    ['deleted', installedText.replace(REPORTS_NOW + '\n', ''), 1],
    ['duplicated', installedText.replace(REPORTS_NOW + '\n', REPORTS_NOW + '\n' + REPORTS_NOW + '\n'), 1],
    ['reordered', installedText.replace(SESSION_NOW + '\n' + REPORTS_NOW + '\n', REPORTS_NOW + '\n' + SESSION_NOW + '\n'), 1],
    ['blank lines only', installedText.replace(SESSION_NOW + '\n', SESSION_NOW + '\n\n'), 0],
  ];
  for (const [what, text, n] of cases) {
    assert.notEqual(text, installedText, what);
    const result = planned(t, text).plan({check: true}), main = result.plans[0].plan;
    assert.deepEqual([main.action, main.editLines], ['replace', n], what);
    assert.equal(result.lines.includes(warnLine(currentVersion, n)), n > 0, what);
    assert.equal(result.written('AGENTS.md'), installedText, what);
  }
  assert.deepEqual(planned(t, installedText).plan().writes, []);
});

test('a block from an older kit is compared with that kit\'s text when the catalog has it', t => {
  const oldBody = template.replace(REPORTS_NOW, REPORTS_331), nonBlank = text => text.split('\n').filter(line => line.trim());
  const f = planned(t, BEGIN('3.3.4-old') + '\n' + oldBody + END + '\n\n' + rules());
  const kit = path.join(f.root, 'kit');
  put(path.join(kit, 'VERSION'), currentVersion + '\n');
  for (const file of ['templates/AGENTS-memory-gate.md', 'templates/CLAUDE-standard-block.md']) put(path.join(kit, file), read(path.join(kitRoot, file)));
  const catalog = json(path.join(kitRoot, 'templates/shipped-instruction-lines.json'));
  put(path.join(kit, 'templates/shipped-instruction-lines.json'), JSON.stringify({...catalog, bodies: {'v3.3.4-old': [nonBlank(oldBody)]}}));
  const clean = f.plan({check: true}, {}, kit);
  assert.deepEqual([clean.plans[0].plan.action, clean.plans[0].plan.editLines], ['replace', 0]);
  assert.ok(!clean.lines.some(line => line.startsWith('WARN')), clean.lines.join('\n'));
  assert.equal(clean.written('AGENTS.md'), block() + '\n' + rules());
  put(path.join(f.target, 'AGENTS.md'), BEGIN('3.3.4-old') + '\n' + oldBody.replace(SESSION_NOW + '\n', '') + END + '\n\n' + rules());
  assert.ok(f.plan({check: true}, {}, kit).lines.includes(warnLine('3.3.4-old', 1)));
  // A version the catalog does not know is compared with this kit's text, and the warning names this kit.
  put(path.join(f.target, 'AGENTS.md'), BEGIN('3.3.4-unknown') + '\n' + oldBody + END + '\n\n' + rules());
  assert.ok(f.plan({check: true}, {}, kit).lines.includes(warnLine(currentVersion, 1)));
});
