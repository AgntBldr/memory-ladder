import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fixture, put, read, kitRoot, ok, currentVersion} from './helpers.mjs';
import {stateToken, listNotes, readCurrent} from '../engine/session-core.mjs';

const skill = read(path.join(kitRoot, 'skills/handover/SKILL.md'));
const bytes = text => Buffer.byteLength(text);

test('NOT SAFE instruction names verdict cause and fallback handover', () => {
  assert.match(skill, /NOT SAFE: fix verdict cause; re-run \(none: \/handover\); never re-pass --lessons once written\./);
});
const phrases = ['handover', 'hand over', 'do a handover', 'lets do a handover', 'end session', 'end of session', 'session end', 'quick handover'];
const wave = ['save memory', 'prepare for compact', 'safe to compact', 'add to memory, learning, and update roadmap'];
const positives = phrases.flatMap(p => [p, p.toUpperCase(), '  ' + p.replaceAll(' ', '  \t') + '  ', p + '\nNote: Resume at the open question']).concat(["let's do a handover", 'hand-over', 'handover!']);
const negatives = ['We are starting a new session - read this and let me know when we can start',
  'a new session', 'starting a new session', 'we are starting a new session', "we're starting a new session", 'start of session', 'new-session', "let's start a new session", 'new session', 'start a new session', 'session start', 'start session', 'new chat', 'begin session', 'begin a new session', 'fresh session', 'lets start', 'lets start a new session', 'start new session',
  ...wave, '/compact', 'handover now', 'please handover', 'end session please', 'handover\nmore', 'handover\nGoal: wrong', 'handover\nNote: yes\nmore', '"handover"', "'handover'", '`handover`', '\u201chandover\u201d', '```\nhandover\n```', '', 'quick handover later'];
function routed(t) {
  const f = fixture(t), target = path.join(f.target, '.claude/skills/handover/SKILL.md');
  put(target, skill);
  put(path.join(f.target, 'scripts/memory/MANIFEST.json'), JSON.stringify({files: {'.claude/skills/handover/SKILL.md': createHash('sha256').update(skill).digest('hex')}}));
  const cli = args => ok(f.cli('engine/new-session.mjs', [...args, '--repo', f.target]));
  const detect = payload => ok(f.exec(process.execPath, [path.join(kitRoot, 'engine/new-session.mjs'), 'detect', '--repo', f.target], {input: JSON.stringify(payload)})).stdout;
  const dispatch = message => cli(['dispatch', '--message', message]).stdout;
  return {...f, targetSkill: target, detect, dispatch};
}

test('all eight phrases in case spacing and Note variants through detect and dispatch', t => {
  const f = routed(t); assert.ok(positives.length >= 20);
  for (const message of positives) {
    const quick = message.trim().toLowerCase().replace(/\s+/g, ' ').startsWith('quick handover');
    const raw = f.detect({prompt: message}), nudge = JSON.parse(raw).hookSpecificOutput.additionalContext;
    assert.equal(nudge, `handover: the message is a handover phrase. Invoke the Skill tool with skill "handover" and args "${quick ? 'quick' : 'full'}" first.`);
    assert.ok(bytes(nudge) <= 240); assert.doesNotMatch(nudge, /Resume at/);
    assert.equal(f.dispatch(message), `Read .claude/skills/handover/SKILL.md and follow it (${quick ? 'quick' : 'full'}).${message.includes('Note:') ? '\nNote: Resume at the open question' : ''}`);
  }
});

test('negatives never trigger handover and subagent hook payloads stay silent', t => {
  const f = routed(t); assert.ok(negatives.length >= 30);
  for (const message of negatives) {
    assert.equal(f.detect({prompt: message}), '', message);
    assert.equal(f.dispatch(message), '', message);
  }
  for (const extra of [{agent_id: ''}, {agent_type: null}, {agent_id: 'worker'}]) assert.equal(f.detect({prompt: 'handover', ...extra}), '');
});

test('slash commands invoke the skill directly, the frozen hook stays silent and dispatch answers the exact forms', t => {
  const f = routed(t);
  for (const message of ['/handover', '/handover quick', '/handover\nNote: Resume', '/handover quick\nNote: Resume']) {
    assert.equal(f.detect({prompt: message}), '');
    assert.equal(f.dispatch(message), `Read .claude/skills/handover/SKILL.md and follow it (${message.startsWith('/handover quick') ? 'quick' : 'full'}).${message.includes('Note:') ? '\nNote: Resume' : ''}`);
  }
  assert.match(skill, /description: \/handover, \/handover quick/);
  assert.match(skill, /Put Note: text in state within its cap/);
  assert.match(skill, /Full by default: \/handover, phrases without "quick"/);
});

test('foreign skill hash gets neither nudge nor dispatch', t => {
  const f = routed(t); fs.appendFileSync(f.targetSkill, '\nForeign change.\n');
  for (const message of positives) { assert.equal(f.detect({prompt: message}), ''); assert.equal(f.dispatch(message), ''); }
});

test('text caps contract and forbidden delegation', () => {
  assert.ok(bytes(skill) <= 1984, `SKILL.md ${bytes(skill)} B`);
  assert.doesNotMatch(skill, /\$ARGUMENTS|\b(?:(?:sub[ -]?)?agents?|Task|Sonnet|Opus|Haiku|GPT(?:-\d[^\s]*)?|Gemini|Claude|Codex)\b|codex exec|claude -p/i);
  assert.match(skill, new RegExp('engine_version: "' + currentVersion.replaceAll('.', '\\.') + '"'));
  const description = skill.split('\n').find(line => line.startsWith('description:'));
  for (const p of wave) assert.ok(!description.toLowerCase().includes(p));
  for (const p of phrases) assert.ok(description.includes(p));
  for (const text of ['Run only when asked; never offered unprompted.', 'Omit constraints for default.', 'close: steps first', 'ok/failed in closed', 'recall twice', '<=3 lessons outside memory', 'Write temp JSON outside the project', '--quick', '--lessons <batch>', '--over <last token> (start line or last handover report)', 'printed report verbatim + <=1 line', 'never type SAFE yourself', 'fix verdict cause; re-run (none: /handover); never re-pass --lessons once written', 'full 2 (5 with lessons), quick 2']) assert.ok(skill.includes(text), text);
  const overlay = read(path.join(kitRoot, 'templates/AGENTS-session-overlay.md'));
  assert.ok(bytes(overlay) <= 1536);
  assert.match(overlay, /close: .*run these before \/handover's run, reports each ok\|failed: missing refuses the save, failed ends NOT FINISHED>/);
  assert.doesNotMatch(overlay, /NOT SAFE/);
  assert.match(overlay, /push: .*defaults to memory; project only in-repo/);
});

function installed(t) {
  const f = fixture(t), memory = path.join(f.root, 'memory');
  Object.assign(f.env, {CLAUDE_PROJECT_DIR: f.target});
  ok(f.install(['--memory-dir', memory]));
  // Explicit skill copy keeps this fixture focused on the interaction contract.
  fs.cpSync(path.join(kitRoot, 'skills/handover'), path.join(f.target, '.claude/skills/handover'), {recursive: true});
  put(path.join(f.target, 'AGENTS.md'), read(path.join(f.target, 'AGENTS.md')) + '\n## Session overlay\nbranch: main\npush: memory\n');
  put(path.join(f.target, 'docs/ROADMAP.md'), '# Roadmap\n\n## Open work (as of ' + new Date().toISOString().slice(0, 10) + ')\n\nReview next stage.\n');
  f.git(f.target, 'checkout', '-b', 'main'); f.git(f.target, 'add', '.'); f.git(f.target, 'commit', '-m', 'project seed');
  const bare = path.join(f.root, 'backup.git'); f.git(f.root, 'init', '--bare', bare);
  f.git(memory, 'remote', 'add', 'origin', bare); f.git(memory, 'push', '-u', 'origin', 'HEAD');
  const cli = (file, args = [], options = {}) => f.exec(process.execPath, ['scripts/memory/' + file, ...args], options);
  return {...f, memory, cli};
}

// Transport is recorded before parsing or checking: no stdout/stderr/envelope bytes disappear.
function interaction(f, {quick = false, lessons = false, over = stateToken(f.memory), parallel = false, worst = false} = {}) {
  const calls = [], hook = ok(f.cli('new-session.mjs', ['detect'], {input: JSON.stringify({prompt: quick ? 'quick handover' : 'handover'})}));
  assert.equal(hook.stderr, '', 'hook stderr');
  const nudge = JSON.parse(hook.stdout).hookSpecificOutput.additionalContext;
  assert.ok(bytes(nudge) <= 240);
  const record = (kind, request, action) => {
    const result = action(); const response = {status: result.status ?? 0, stdout: result.stdout ?? '', stderr: result.stderr ?? ''};
    for (const text of [response.stdout, response.stderr, response.stdout + response.stderr]) assert.ok(text.length <= 4000, kind + ' uncapped output');
    assert.equal(response.stderr, '', kind + ' stderr');
    assert.equal(response.status, 0, response.stdout + response.stderr);
    const envelope = bytes(JSON.stringify({kind, request, ...response})) - bytes(response.stdout) - bytes(response.stderr) - bytes(request.content ?? '');
    calls.push({kind, stdout: bytes(response.stdout), stderr: bytes(response.stderr), envelope});
    return response;
  };
  const commands = [...skill.matchAll(/`(node [^`]+)`/g)].map(m => m[1]);
  assert.ok(commands.includes('node scripts/memory/handover.mjs run --in <file>'));
  assert.ok(commands.includes('node scripts/memory/memory-recall.mjs "<question>"'));
  // Execute any additional prescribed commands too: a fifth call cannot hide in skill prose.
  const extras = commands.filter(c => !/^(?:node scripts\/memory\/handover\.mjs run --in <file>|node scripts\/memory\/memory-recall\.mjs "<question>")$/.test(c));
  for (const command of extras) {
    const [, file, ...args] = command.split(' ');
    record('extra', command, () => f.exec(process.execPath, [file, ...args]));
  }
  let batch = '', batchFile;
  if (lessons) {
    for (const question of ['verify committed bytes', 'handover publication']) record('recall', question, () => f.cli('memory-recall.mjs', [question]));
    batch = '## Verify publication\nkind: practice\nroute: craft-sessions\ndescription: Compare saved notes with committed bytes before declaring completion.\n\n**Why:**\nA local note can survive while its push fails.\n\n**How to apply:**\nCheck the committed note and upstream before compacting.\n';
    if (worst) batch = batch.trimEnd() + '\n' + 'Check publication before declaring completion. '.repeat(60).slice(0, 2700 - bytes(batch));
    batchFile = path.join(f.root, 'lessons.md');
    record('write-batch', {file: batchFile, content: batch}, () => { put(batchFile, batch); return {}; });
  }
  // A safe handover states its learning (a batch, or none) and quotes the roadmap line the fixture holds; a quick one states both too.
  const data = {state: 'Ready for review', question: 'Which stage next?', next: ['Review results'], waits: 'none', risks: 'none', roadmap: 'nothing new (Review next stage.)', ...(quick || !lessons ? {lessons: 'none (no new learning this session)'} : {})};
  if (worst) Object.assign(data, {state: 's'.repeat(240), question: 'q'.repeat(quick ? 240 : 320), next: ['n'.repeat(quick ? 300 : 470)], waits: 'w'.repeat(quick ? 100 : 240), risks: 'r'.repeat(quick ? 30 : 200)});
  const raw = JSON.stringify(data), input = worst ? raw + ' '.repeat((quick ? 1184 : 1952) - bytes(raw)) : raw, inputFile = path.join(f.root, 'input.json');
  record('write-input', {file: inputFile, content: input}, () => { put(inputFile, input); return {}; });
  const args = ['run', '--in', inputFile, '--over', over ?? 'none', ...(quick ? ['--quick'] : []), ...(lessons ? ['--lessons', batchFile] : [])];
  const result = record('run', args, () => f.cli('handover.mjs', args));
  assert.equal(calls.length, lessons ? 5 : 2, 'extra interaction call');
  assert.deepEqual(calls.map(c => c.kind), lessons ? ['recall', 'recall', 'write-batch', 'write-input', 'run'] : ['write-input', 'run']);
  assert.match(result.stdout, /^SAFE TO COMPACT/m); assert.doesNotMatch(result.stdout, /NOT SAFE|re-run:/);
  assert.match(result.stdout, /roadmap already holds it/);
  let warning = '';
  if (parallel) {
    const bullet = result.stdout.match(/^- warning: another session handed over at .*; both notes kept\n/m)?.[0];
    const block = result.stdout.match(/\n```text\n[\s\S]*?\n```\n/)?.[0];
    assert.ok(bullet && block);warning = bullet + block;
    assert.ok(result.stdout.indexOf(block) > result.stdout.indexOf('Next:'));
    assert.ok(bytes(warning) <= 2048);assert.match(block, /```text\n## CURRENT\n/);
  } else assert.doesNotMatch(result.stdout, /warning: another session/);
  const output = calls.reduce((n, c) => n + c.stdout + c.stderr, 0) - bytes(warning);
  const parts = {hook: bytes(hook.stdout) + bytes(hook.stderr), skill: bytes(skill), input: bytes(input), batch: bytes(batch),
    stdoutStderr: output, envelopes: calls.reduce((n, c) => n + c.envelope, 0), reply: quick ? 512 : 1024, callAllowance: quick ? 384 : 768};
  assert.ok(bytes(result.stdout) - bytes(warning) <= (quick ? 1024 : 1536));
  if (worst) {
    assert.equal(parts.input, quick ? 1184 : 1952);
    if (lessons) {
      assert.equal(parts.batch, 2700);
      for (const call of calls.filter(c => c.kind === 'recall')) assert.ok(call.stdout >= 740 && call.stdout <= 790, 'recall near 768 B: ' + call.stdout);
    }
  }
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  assert.ok(total <= (quick ? 5376 : 12288), JSON.stringify({total, parts}));
  const notes = listNotes(f.memory);
  assert.equal(f.git(f.memory, 'rev-parse', 'HEAD'), f.git(f.memory, 'rev-parse', '@{u}'));
  assert.equal(f.git(f.memory, 'show', 'HEAD:' + path.relative(f.memory, notes[0].file).replaceAll('\\', '/')), read(notes[0].file).trimEnd());
  if (lessons) { assert.equal(fs.readdirSync(f.memory).filter(n => /^lesson-/.test(n)).length, 1); assert.match(read(notes[0].file), /lesson-001-verify-publication.md/); }
  return {total, parts, calls, warning: bytes(warning), budget: quick ? 5376 : 12288, planned: quick ? 5307 : 12231};
}

for (const mode of ['full-none', 'full-lessons', 'quick', 'parallel']) test('executed ' + mode + ' counts every byte and call', t => {
  const f = installed(t), over = stateToken(f.memory);
  if (mode === 'parallel') {
    interaction(f, {over});
    assert.notEqual(stateToken(f.memory), over);
  }
  const measured = interaction(f, {quick: mode === 'quick', lessons: mode === 'full-lessons', parallel: mode === 'parallel', over});
  if (mode === 'parallel') { assert.equal(listNotes(f.memory).length, 2); assert.match(readCurrent(f.memory).block, /Ready for review/); }
  t.diagnostic(mode + ' ' + JSON.stringify(measured));
});


for (const quick of [false, true]) test('executed worst-case ' + (quick ? 'quick' : 'full') + ' budgets', t => {
  const f = installed(t);
  for (let i = 1; i <= 5; i++) put(path.join(f.memory, `recall-${i}.md`), `---\nname: recall-${i}\ndescription: ${'verify committed bytes handover publication ' + 'x'.repeat(87)}\nmetadata:\n  type: reference\n---\n\n# Publication checks\nVerify committed bytes and handover publication.\n`);
  ok(f.cli('memory-index.mjs', ['write']));
  f.git(f.memory, 'add', '.'); f.git(f.memory, 'commit', '-m', 'recall fixtures'); f.git(f.memory, 'push');
  const measured = interaction(f, {quick, lessons: !quick, worst: true});
  t.diagnostic('worst-' + (quick ? 'quick' : 'full') + ' ' + JSON.stringify(measured));
});
