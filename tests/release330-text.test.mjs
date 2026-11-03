import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture, put, read, tree, kitRoot, ok, currentVersion} from './helpers.mjs';
import {parseHandover} from '../engine/lib.mjs';
import {spawnSync} from 'node:child_process';
import {listNotes, matchPhrase, capText, readOverlay} from '../engine/session-core.mjs';
import {FIRST_REPLY_TEMPLATE} from '../engine/new-session.mjs';

const phrase = 'We are starting a new session - read this and let me know when we can start';
const gateLine = '- Session phrases: when a message is only "We are starting a new session - read this and let me know when we can start" or "handover" (or /new-session, /handover), run `node scripts/memory/new-session.mjs dispatch --message "<the message>"` and follow its output; never inside a subagent or `codex exec` brief. Offer /handover at a stage end or on wrap-up.';
const skill = read(path.join(kitRoot, 'skills/new-session/SKILL.md'));
const bytes = text => Buffer.byteLength(text);
const noDelegation = text => assert.doesNotMatch(text.replaceAll('.claude/skills/new-session/SKILL.md', ''), /\b(?:sub[ -]?agents?|Task|Sonnet|Opus|Haiku|GPT(?:-\d[^\s]*)?|Gemini|Claude|Codex)\b/i);

test('T6 shipped text caps, exact reply template, entry and goal contract', () => {
  assert.ok(bytes(skill) <= 1536, `SKILL.md ${bytes(skill)} B`);
  assert.doesNotMatch(skill, /```/);
  assert.match(skill, /plain text with no code fence/);
  assert.ok(skill.includes("First line: start's line 1, copied exactly."));
  assert.equal(FIRST_REPLY_TEMPLATE.split('\n')[0], '<abs path> | <branch>@<sha> | <n> changed, <n> untracked | <n> ahead/no upstream | kit <version>[ | flags: ...]');
  assert.doesNotMatch(FIRST_REPLY_TEMPLATE, /^\d+[.)] /m);
  assert.doesNotMatch(skill, /\$ARGUMENTS/);
  noDelegation(skill);
  assert.ok(skill.includes(FIRST_REPLY_TEMPLATE));
  assert.ok(skill.includes('metadata:\n  engine_version: "' + currentVersion + '"'));
  assert.ok(skill.includes('the whole message "' + phrase + '"'));
  assert.ok(skill.includes("node scripts/memory/new-session.mjs start --entry <slash|sentence> [--goal '<text>']"));
  assert.ok(skill.includes('Args "sentence": entry sentence; goal from Goal: line. Else slash; strip /new-session and leading Goal:.'));
  assert.ok(skill.includes("Single-quote goal; bash: ' as '\\''; PowerShell: ' as ''."));
  assert.match(skill, /Run only follow-ups named by start\. Write nothing/);
  assert.ok(skill.includes("( ) notes: do not print; fill <...>; end exactly `Waiting for your go.`."));
});

test('T6 gate line is verbatim and last; overlay has every key and precedence', () => {
  const gate = read(path.join(kitRoot, 'templates/AGENTS-memory-gate.md'));
  assert.equal(bytes(gateLine), 356); assert.ok(bytes(gateLine) <= 360);
  assert.equal(gate.split('\n').filter(line => line.startsWith('- ')).at(-1), gateLine);
  const overlay = read(path.join(kitRoot, 'templates/AGENTS-session-overlay.md'));
  assert.ok(bytes(overlay) <= 1536);
  assert.match(overlay, /^## Session overlay\n/);
  assert.deepEqual(overlay.split('\n').filter(line => /^[a-z-]+: /.test(line)).map(line => line.split(':')[0]), ['roadmap', 'branch', 'main-only', 'check', 'rules', 'after-go', 'close', 'push', 'log', 'board', 'public']);
  assert.match(overlay, /AGENTS.md outside overlay > overlay > rules file > kit defaults/);
  for (const line of ['branch: <branch>', 'main-only: yes|no', 'push: <memory|project|none; /handover defaults to memory; project only in-repo>', 'public: yes|no']) assert.ok(overlay.split('\n').includes(line));
  assert.match(overlay, /A public repo carries no path, name, board or cost line/);
});

for (const ending of [' ', '\t']) test(`S1 carryover note opener ${JSON.stringify(ending)} preserves branch 1.5`, t => {
  const f = fixture(t), text = note(1).replace('---\n', '---' + ending + '\n').replace('topic-1', '1.5');
  const parsed = parseHandover(text);
  assert.equal(parsed.valid, true); assert.equal(parsed.data.branch, '1.5');
  put(path.join(f.root, 'handovers/000001-2026-01-01-1200.md'), text);
  assert.equal(listNotes(f.root)[0].branch, '1.5');
});

function installed(t) {
  const f = fixture(t), memory = path.join(f.target, 'memory'), tmp = path.join(f.root, 'tmp');
  fs.mkdirSync(tmp);
  ok(f.install(['--memory-dir', memory]));
  assert.equal(read(path.join(f.target, '.claude/skills/new-session/SKILL.md')), skill);
  assert.equal(read(path.join(f.target, 'scripts/memory/templates/AGENTS-session-overlay.md')), read(path.join(kitRoot, 'templates/AGENTS-session-overlay.md')));
  const env = {...f.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, CLAUDE_PROJECT_DIR: f.target};
  const cli = (args, options = {}) => f.exec(process.execPath, ['scripts/memory/new-session.mjs', ...args], {env, ...options});
  return {...f, memory, tmp, env, cli};
}

test('S1 carryover expected refusals print bounded messages and write no log', t => {
  const f = installed(t), before = tree(f.root, {git: true});
  for (const [args, message] of [
    [['open', path.join(f.root, 'outside.md')], /outside memory or brain/],
    [['start', '--bad-option'], /invalid or missing option/],
    [['start', '--entry', 'wrong'], /entry must be slash or sentence/],
    [['unknown'], /expected detect/],
    [['open', 'missing.md'], /ENOENT/],
    [['open', '--rules'], /no rules file/],
    [['start', '--' + 'x'.repeat(6000)], /new-session refused:/],
  ]) {
    const result = f.cli(args);
    assert.equal(result.status, 1); assert.equal(result.stdout, '');
    assert.match(result.stderr, message); assert.doesNotMatch(result.stderr, /; log:/);
    assert.ok(bytes(result.stderr) <= 4000);
    assert.deepEqual(tree(f.root, {git: true}), before);
  }
});

function note(seq, extra = '') {
  return `---\ntime: ${new Date(Date.now() - 3600000).toISOString()}\nbranch: topic-${seq}\nsha: abcdefa\nmode: full\n---\n**Open question:** question-${seq}\n**State:** state-${seq}\n**Waits on the user:** none\n**Next action:** inspect fixture\n${extra}`;
}

function largeInputs(f, withNotes) {
  put(path.join(f.memory, 'current-state.md'), '## CURRENT\n' + '\u754c'.repeat(7000));
  if (withNotes) for (let i = 1; i <= 25; i++) put(path.join(f.memory, `handovers/${String(i).padStart(6, '0')}-2026-01-01-1200.md`), note(i, '\u754c'.repeat(i === 25 ? 2200 : 700)));
  for (let i = 0; i < 50; i++) put(path.join(f.memory, `recall-${String(i).padStart(2, '0')}.md`), '---\nname: needle\ndescription: needle recall fixture\n---\n' + '\u754c'.repeat(2000));
  const rules = put(path.join(f.home, 'rules.md'), '\u754c'.repeat(3000));
  put(path.join(f.target, 'AGENTS.md'), `## Session overlay\nrules: ${rules}\nlog: log.md, 1 lines\nroadmap: plan.md | section: Open\n`);
  put(path.join(f.target, 'log.md'), ('\u754c'.repeat(10000) + '\n').repeat(3));
  put(path.join(f.target, 'plan.md'), '## Open\n' + '\u754c'.repeat(10000));
  return rules;
}

function namedCalls(output) {
  const line = output.split('\n').find(line => line.startsWith('Read next with this helper: '));
  if (!line) return [];
  const text = line.slice('Read next with this helper: '.length, -1), calls = [];
  let rest = text;
  while (rest) {
    const match = /^open (--rules|"(?:[^"\\]|\\.)*")(?:; |$)/.exec(rest);
    assert.ok(match, 'unparseable follow-up: ' + rest);
    calls.push(['open', match[1] === '--rules' ? '--rules' : JSON.parse(match[1])]);
    rest = rest.slice(match[0].length);
  }
  assert.equal(new Set(calls.map(call => JSON.stringify(call))).size, calls.length, 'extra duplicate call');
  assert.ok(calls.length <= 3, 'extra open call');
  return calls;
}

test('T7 slash Goal prefix and sentence give the same goal line', t => {
  const f = installed(t), slash = '/new-session Goal: x';
  const goal = slash.slice('/new-session'.length).trim().replace(/^Goal:\s*/i, '');
  const slashOutput = ok(f.cli(['start', '--entry', 'slash', '--goal', goal])).stdout;
  const sentenceOutput = ok(f.cli(['dispatch', '--message', phrase + '\nGoal: x'])).stdout;
  const line = output => output.split('\n').find(value => value.startsWith('goal:'));
  assert.equal(matchPhrase(phrase + '\nGoal: x').text, goal);
  assert.equal(line(slashOutput), 'goal: x'); assert.equal(line(sentenceOutput), line(slashOutput));
});

test('T7 real bash preserves dollar, backtick and apostrophe in the goal', t => {
  const candidates = process.platform === 'win32'
    ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'] : ['bash'];
  const bash = candidates.find(command => spawnSync(command, ['--version'], {encoding: 'utf8', windowsHide: true}).status === 0);
  if (!bash) { t.skip('bash missing; real shell quoting probe unavailable'); return; }
  const f = installed(t), goal = "$HOME `printf expanded` don't expand";
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const before = tree(f.root, {git: true});
  const result = ok(f.exec(bash, ['--noprofile', '--norc', '-c',
    quote(process.execPath.replaceAll('\\', '/')) + ' scripts/memory/new-session.mjs start --entry slash --goal ' + quote(goal)], {env: f.env}));
  assert.equal(result.stdout.split('\n').find(line => line.startsWith('goal:')), 'goal: ' + goal);
  assert.deepEqual(tree(f.root, {git: true}), before);
});

test('T7 check and board refuse unsafe characters and duplicate keys without executing', t => {
  const f = installed(t);
  for (const value of ['', 'rm -rf ~', 'node -e "x"', ...[';', '&', '|', '>', '<', '`', '$(', '\u2028', '\u2029', '\u0085', '\t'].map(token => 'node check.cjs ' + token + ' second')]) {
    put(path.join(f.target, 'AGENTS.md'), '## Session overlay\ncheck: ' + value + '\nboard: fixture-board\n');
    const before = tree(f.root, {git: true}), output = ok(f.cli(['start'])).stdout;
    assert.match(output, /conflicts:.*overlay check: refused/);
    assert.doesNotMatch(output, /Add-ons[^\n]*check:/);
    assert.match(output, /Add-ons[^\n]*board: fixture-board/);
    assert.deepEqual(tree(f.root, {git: true}), before);
    put(path.join(f.target, 'AGENTS.md'), '## Session overlay\nboard: ' + value + '\n');
    const board=ok(f.cli(['start'])).stdout;assert.match(board,/conflicts:.*overlay board: refused/);assert.doesNotMatch(board,/Add-ons|rulings:/);
  }
  for(const key of ['check','board','rules']) {
    put(path.join(f.target,'AGENTS.md'),`## Session overlay\n${key}: first\n${key}: second\n`);
    const output=ok(f.cli(['start'])).stdout;assert.match(output,new RegExp(`overlay ${key}: refused \\(duplicate key\\)`));assert.doesNotMatch(output,/Add-ons|Read next/);
  }
  put(path.join(f.target,'AGENTS.md'),'## Session overlay\nCustom-key: first\nCUSTOM-key: second\n');
  const unknown=ok(f.cli(['start'])).stdout;
  assert.match(unknown,/conflicts:.*overlay custom-key: refused \(unknown key\).*overlay custom-key: refused \(duplicate key\)/);
});

test('T7 overlay values end on their own line and filled pipes are values; commands are shown and capped',t=>{
  const f=installed(t);
  put(path.join(f.target,'AGENTS.md'),'## Session overlay\ncheck: node check.cjs\nProse is not a command.\nafter-go: a | b\nboard: node board.cjs\nPrecedence: this is prose\n');
  assert.deepEqual(readOverlay(f.target),{check:'node check.cjs','after-go':'a | b',board:'node board.cjs'});
  const output=ok(f.cli(['start'])).stdout;assert.match(output,/Add-ons[^\n]*check: node check.cjs; board: node board.cjs/);assert.match(output,/rulings: pending board add-on/);assert.doesNotMatch(output,/not readable here|overlay placeholders/);
  const command='node scripts/'+ 'a'.repeat(103)+'.mjs';assert.equal(bytes(command),120);
  put(path.join(f.target,'AGENTS.md'),`## Session overlay\ncheck: ${command}\nboard: ${command}\n`);
  const full=ok(f.cli(['start'])).stdout,addons=full.split('\n').find(line=>line.startsWith('Add-ons'));
  assert.ok(addons.includes('check: '+command+'; board: '+command+'.'));assert.doesNotMatch(addons,/\[cut\]/);
  assert.match(addons,/run; keep only first 1,024 B via \| head -c 1024/);
  assert.ok(bytes(full.slice(full.indexOf('reply using the template')))<=500);
  for(const key of ['check','board']) {
    put(path.join(f.target,'AGENTS.md'),`## Session overlay\n${key}: ${command}x\n`);
    const long=ok(f.cli(['start'])).stdout;assert.match(long,new RegExp(`conflicts:.*overlay ${key}: refused`));assert.doesNotMatch(long,/Add-ons/);
  }
});

test('T7 placeholder overlays are ignored and named as conflicts', t => {
  const f = installed(t), template = read(path.join(kitRoot, 'templates/AGENTS-session-overlay.md'));
  put(path.join(f.target, 'AGENTS.md'), template);
  const output = ok(f.cli(['start'])).stdout;
  const conflicts = output.split('\n').find(line => line.startsWith('conflicts:'));
  for (const key of ['roadmap', 'branch', 'main-only', 'check', 'rules', 'after-go', 'close', 'push', 'log', 'board', 'public']) assert.ok(conflicts.includes(key), key);
  assert.deepEqual(namedCalls(output), []); assert.doesNotMatch(output, /Add-ons|overlay branch <branch>|rulings:/);
  assert.match(f.cli(['open', '--rules']).stderr, /no rules file named/);
  for (const value of ['<branch>', 'main|other', 'main | other', 'main>']) {
    put(path.join(f.target, 'AGENTS.md'), '## Session overlay\nbranch: ' + value + '\n');
    const result = ok(f.cli(['start'])).stdout;
    assert.match(result, /conflicts: overlay placeholders: branch/);
    assert.doesNotMatch(result, /overlay branch /);
  }
});

for (const scenario of ['notes', 'current', 'failing-git', 'unreadable-memory', 'rules-error', 'long-names', 'digest-cap', 'addons']) test(`T7 executed start: ${scenario}`, t => {
  const f = installed(t), rules = largeInputs(f, scenario !== 'current');
  let env = f.env;
  if (scenario === 'addons') {
    put(path.join(f.target, 'check.cjs'), "process.stdout.write('c'.repeat(2048));");
    put(path.join(f.target, 'board.cjs'), "process.stdout.write('b'.repeat(2048));");
    fs.appendFileSync(path.join(f.target, 'AGENTS.md'), 'check: node check.cjs\nboard: node board.cjs\n');
    const guard = put(path.join(f.root, 'no-addons.cjs'), `const cp = require('node:child_process');
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
  const original = cp[key];
  cp[key] = function(...args) {
    if (/check\\.cjs|board\\.cjs/.test(JSON.stringify(args.slice(0, 2)))) throw Error('start executed an add-on');
    return original.apply(this, args);
  };
}
require('node:module').syncBuiltinESMExports();
`);
    env = {...env, NODE_OPTIONS: '--require ' + JSON.stringify(guard)};
  }
  if (['long-names', 'digest-cap'].includes(scenario)) {
    for (let i = 0; i < 3; i++) {
      const name = String(i) + 'x'.repeat(76) + '.md';
      assert.equal(name.length, 80);
      put(path.join(f.memory, name), '---\nname: needle\ndescription: needle ' + 'd'.repeat(120) + '\n---\n' + '\u754c'.repeat(2000));
    }
  }
  if (scenario === 'digest-cap') {
    put(path.join(f.memory, 'handovers/000024-2026-01-01-1200.md'), note(24).replace('state-24', 'state-24 ' + 's'.repeat(1800)));
    for (const seq of [22, 23]) put(path.join(f.memory, `handovers/0000${seq}-2026-01-01-1200.md`), note(seq).replace(`topic-${seq}`, 't'.repeat(80)));
    fs.appendFileSync(path.join(f.target, 'AGENTS.md'), 'branch: expected\n');
    const preload = put(path.join(f.root, 'git-facts.cjs'), `const cp = require('node:child_process');
const original = cp.spawnSync;
cp.spawnSync = function(command, args, options) {
  if (command === 'git') {
    let stdout;
    if (args.includes('--git-common-dir')) stdout = 'common';
    else if (args.includes('--absolute-git-dir')) stdout = 'worktree';
    else if (args.includes('worktree')) stdout = 'worktree ' + ${JSON.stringify(path.join(f.root, 'w'.repeat(200)))} + (args.includes('-z') ? '\\0\\0' : '\\n\\nworktree other\\n');
    else if (args.includes('--show-current')) stdout = 'branch-' + 'b'.repeat(300);
    else if (args.includes('--count')) stdout = '9'.repeat(90);
    if (stdout !== undefined) return {status: 0, stdout, stderr: ''};
  }
  return original.call(this, command, args, options);
};
require('node:module').syncBuiltinESMExports();
`);
    env = {...env, CLAUDE_MEMORY_DIR: f.memory, NODE_OPTIONS: '--require ' + JSON.stringify(preload)};
  }
  if (scenario === 'failing-git') env = {...env, PATH: ''};
  if (['unreadable-memory', 'rules-error'].includes(scenario)) {
    const preload = put(path.join(f.root, 'deny.cjs'), `const fs = require('node:fs'), path = require('node:path');
const denied = ${JSON.stringify(scenario === 'unreadable-memory' ? f.memory : rules)};
for (const key of ['readFileSync', 'readdirSync', 'openSync']) {
  const original = fs[key];
  fs[key] = function(file, ...args) {
    const absolute = path.resolve(String(file));
    if (absolute === denied || absolute.startsWith(denied + path.sep)) throw Object.assign(Error('fixture denied ' + 'x'.repeat(6000)), {code: 'EACCES'});
    return original.call(this, file, ...args);
  };
}
`);
    env = {...env, NODE_OPTIONS: '--require ' + JSON.stringify(preload)};
  }
  const before = tree(f.root, {git: true}), outputs = [];
  const run = (args, limit, options = {}) => {
    const result = f.cli(args, {env, ...options});
    for (const stream of ['stdout', 'stderr']) {
      assert.ok(result[stream].length <= 4000, `${args[0]} ${stream} character cap`);
      assert.ok(bytes(result[stream]) <= limit, `${args.join(' ')} ${stream} byte cap: ${bytes(result[stream])}`);
      assert.ok(!result[stream].includes('\ufffd'), 'split UTF-8 sequence');
    }
    assert.ok(bytes(result.stdout) + bytes(result.stderr) <= limit, 'combined output cap');
    outputs.push({call: args.join(' '), stdout: bytes(result.stdout), stderr: bytes(result.stderr)});
    return result;
  };
  const goal = scenario === 'digest-cap' ? "needle don't break it " + 'g'.repeat(100) : "needle don't break it";
  const detected = ok(run(['detect'], 300, {input: JSON.stringify({prompt: phrase + '\nGoal: ' + goal})}));
  const nudge = JSON.parse(detected.stdout).hookSpecificOutput.additionalContext;
  assert.match(nudge, /skill "new-session" and args "sentence"/); noDelegation(nudge);
  // Follow the skill's entry/Goal mapping without shell interpolation of the apostrophe.
  const started = ok(run(['start', '--entry', 'sentence', '--goal', goal], 4000));
  noDelegation(started.stdout);
  assert.ok(started.stdout.includes('goal: ' + capText(goal, 100)));
  const instruction = started.stdout.indexOf('reply using the template in `.claude/skills/new-session/SKILL.md`');
  assert.ok(instruction >= 0); assert.ok(bytes(started.stdout.slice(instruction)) <= 500);
  assert.ok(bytes(started.stdout.slice(0, instruction).trimEnd()) <= 3500);
  assert.match(started.stdout.slice(instruction), /handovers\/<name> hints are for later, not to open now/);
  if (scenario === 'digest-cap') assert.ok(bytes(started.stdout.slice(0, instruction).trimEnd()) >= 3490, 'digest fixture saturates cap: ' + bytes(started.stdout.slice(0, instruction).trimEnd()) + '\n' + started.stdout);
  assert.match(started.stdout, /Waiting for your go\.$/);
  if (scenario === 'failing-git') assert.match(started.stdout, /detached\/unavailable@unknown/);
  if (scenario === 'unreadable-memory') assert.match(started.stdout, /FAIL|not readable|state: none recorded/);
  else if (scenario === 'current') assert.match(started.stdout, /undated/);
  else { assert.match(started.stdout, /state-24/); assert.doesNotMatch(started.stdout, /state-25/); }
  const calls = namedCalls(started.stdout);
  assert.equal(calls.length, scenario === 'unreadable-memory' ? 1 : 3, 'exact follow-up count');
  assert.deepEqual(calls[0], ['open', '--rules']);
  for (const call of calls) {
    const result = run(call, call[1] === '--rules' ? 4000 : 1536);
    if (scenario === 'rules-error' && call[1] === '--rules') { assert.equal(result.status, 1); assert.match(result.stderr, /fixture denied/); }
    else { ok(result); noDelegation(result.stdout); }
  }
  assert.equal(outputs.length, scenario === 'unreadable-memory' ? 3 : 5, 'extra helper call');
  if (['long-names', 'digest-cap'].includes(scenario)) assert.ok(calls.slice(1).every(call => path.basename(call[1]).length === 80), 'long recall names selected');
  const addonUses = [], addonLine = started.stdout.split('\n').find(line => line.startsWith('Add-ons '));
  if (scenario === 'addons') {
    assert.ok(addonLine, 'both add-ons named');
    assert.match(addonLine, /at most 2; run; keep only first [\d,]+ B via \| head -c 1024/);
    assert.match(addonLine, /check: node check.cjs; board: node board.cjs/);
    assert.ok(started.stdout.indexOf(addonLine) > started.stdout.indexOf('Read next with this helper:'));
    const allowance = Number(/keep only first ([\d,]+) B/.exec(addonLine)[1].replaceAll(',', ''));
    const overlay = readOverlay(f.target);
    for (const key of ['check', 'board']) {
      // A local stand-in for the board connector; execute only calls named by start.
      const [command, ...args] = overlay[key].split(' ');
      const result = ok(f.exec(command, args, {env}));
      assert.equal(bytes(result.stdout), 2048); assert.equal(result.stderr, '');
      const used = capText(result.stdout + result.stderr, allowance);
      assert.ok(bytes(used) <= 1024, `${key} add-on byte cap`);
      addonUses.push({key, raw: bytes(result.stdout), used: bytes(used)});
    }
  } else assert.equal(addonLine, undefined);
  const addonBytes = addonUses.reduce((sum, addon) => sum + addon.raw, 0);
  assert.ok(addonUses.length <= 2); assert.ok(addonUses.reduce((sum,addon)=>sum+addon.used,0) <= 2048, 'add-on used total cap');
  if(scenario==='addons') assert.equal(addonBytes,4096,'raw add-on bytes counted before clipping');
  const parts = {envelope: outputs[0].stdout + outputs[0].stderr, skill: bytes(skill), start: outputs[1].stdout + outputs[1].stderr,
    rules: outputs[2].stdout + outputs[2].stderr, recall: outputs.slice(3).reduce((n, out) => n + out.stdout + out.stderr, 0), reply: 1280, overhead: 320};
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  t.diagnostic(JSON.stringify({scenario, calls: outputs.length + addonUses.length, coreCalls: outputs.length, parts, total, addonUses, addonBytes, combined: total + addonBytes, coreBudget: 14508, ceiling: 20480, streams: outputs}));
  assert.ok(total <= 14508, `core budget ${total}/14508`);
  assert.ok(total + addonBytes <= 20480, `outer ceiling ${total}/20480`);
  assert.deepEqual(tree(f.root, {git: true}), before, 'start interaction writes nothing');
});
