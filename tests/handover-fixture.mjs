import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fixture, put, read, tree, kitRoot, ok} from './helpers.mjs';
import {runHandover} from '../engine/handover.mjs';
import {loadConfig} from '../engine/lib.mjs';
import {writeMemoryIndex} from '../engine/memory-index.mjs';

// A project, a memory folder (outside the project, or inside it) with a remote, a roadmap and the handover tool. Shared by the
// handover verdict tests. `run` calls the tool in this process; `cli` runs the installed file. The default input is a full
// handover that states no learning and quotes the roadmap line the fixture holds, so a test removes or changes one thing.
export const helper = path.join(kitRoot, 'engine/handover.mjs');
export const ROADMAP_LINE = 'Kit work is under way and nothing is blocked.';
export const NONE = 'none (no new learning this session)';
export const STATEMENT = `updated (${ROADMAP_LINE})`;
export const LATER = 'The gate stayed green after a rotation moved the lesson index, so a missing lesson went unseen; list the pages after every move.';
export const input = {state: 'Ready to continue', question: 'Which next?', next: ['Review results'], waits: 'none', risks: 'none'};
const initial = '---\nname: current-state\ndescription: Current work.\nmetadata:\n  type: project\n  state: true\n---\n\n## CURRENT\nold state\n';
export function setup(t, {inRepo = false, remote = true, overlay = '', full = true, session = false, memoryName = 'memory', roadmap = `# Roadmap\n\n## Open work (as of DATE)\n\n- ${ROADMAP_LINE}\n`} = {}) {
  const now = new Date(), date = now.toISOString().slice(0, 10);
  const f = fixture(t), repo = f.target, memoryDir = inRepo ? path.join(repo, 'memory') : path.join(f.root, memoryName);
  const prior = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = f.env.GIT_CONFIG_GLOBAL;
  t.after(() => { if (prior === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prior; });
  fs.mkdirSync(memoryDir);
  put(path.join(repo, 'AGENTS.md'), `## Session overlay\nbranch: main\npush: ${inRepo ? 'project' : 'memory'}\n${overlay}`);
  f.git(repo, 'checkout', '-b', 'main');
  const config = loadConfig();
  if (inRepo) config.memory = {inRepoDir: 'memory'};
  if (session) config.caps.checkpoint = {mode: 'session'};
  put(path.join(repo, 'scripts/memory/memory.config.json'), JSON.stringify(config));
  put(path.join(repo, 'scripts/memory/KIT.json'), JSON.stringify({version: config.engine_version}));
  put(path.join(repo, '.gitignore'), '.memory.lock*\n.sessions/\n');
  put(path.join(repo, 'docs/ROADMAP.md'), roadmap.replace('DATE', date));
  put(path.join(memoryDir, '.gitignore'), '.memory.lock*\n.sessions/\n');
  put(path.join(memoryDir, 'MEMORY.md'), '# Memory\n\n## Craft\n- [Sessions](INDEX-craft-sessions.md) OPEN BEFORE testing.\n\n## Active work\n- [Current](current-state.md) OPEN BEFORE resuming.\n');
  put(path.join(memoryDir, 'current-state.md'), initial);
  writeMemoryIndex({memoryDir, config});
  f.git(repo, 'add', '.'); f.git(repo, 'commit', '-m', 'project seed');
  if (!inRepo) { f.git(memoryDir, 'init', '-b', 'main'); f.git(memoryDir, 'add', '.'); f.git(memoryDir, 'commit', '-m', 'memory seed'); }
  const holder = inRepo ? repo : memoryDir;
  let bare;
  if (remote) {
    bare = path.join(f.root, 'backup.git'); f.git(f.root, 'init', '--bare', bare);
    f.git(holder, 'remote', 'add', 'origin', bare); f.git(holder, 'push', '-u', 'origin', 'main');
  }
  const defaults = {...input, ...(full ? {lessons: NONE, roadmap: STATEMENT} : {})};
  const inputPath = put(path.join(f.root, 'input.json'), JSON.stringify(defaults));
  const options = {repo, memoryDir, input: inputPath, quick: !full};
  const run = (opts = {}, deps = {}) => {
    let output = '';
    const result = runHandover({...options, now, ...opts}, {...deps, output: text => { output += text; }});
    return {...result, output};
  };
  const cli = (extra = [], command = 'run') => f.exec(process.execPath, [helper, command, '--repo', repo, '--memory-dir', memoryDir, '--in', inputPath, ...(!full ? ['--quick'] : []), ...extra]);
  const saveInput = data => put(inputPath, JSON.stringify(data));
  const commit = (dir = repo) => { f.git(dir, 'add', '.'); f.git(dir, 'commit', '-m', 'fixture change'); };
  const batch = (count = 1, route = 'craft-sessions') => put(path.join(f.root, 'batch.md'), Array.from({length: count}, (_, i) => `## Capture ${i + 1}\nkind: practice\nroute: ${route}\ndescription: Check resulting bytes before declaring completion ${i + 1}.\n\n**Why:**\nPartial writes can lose a session.\n\n**How to apply:**\nVerify the committed bytes and publication.\n`).join('\n'));
  const lessons = () => fs.readdirSync(memoryDir).filter(name => /^lesson-/.test(name)).sort();
  const notes = () => fs.existsSync(path.join(memoryDir, 'handovers')) ? fs.readdirSync(path.join(memoryDir, 'handovers')).filter(name => /^\d{6}-/.test(name)).sort() : [];
  const verdict = output => output.split('\n').find(line => /^(SAFE TO COMPACT|NOT SAFE TO COMPACT|SAVE REFUSED|STATE SAVED)/.test(line)) ?? '';
  const finished = output => output.split('\n').find(line => line.startsWith('NOT FINISHED')) ?? '';
  const roadmapFile = path.join(repo, 'docs/ROADMAP.md');
  // A second checkout on its own branch: another session, when session mode is on.
  const other = () => { const dir = path.join(f.root, 'other'); if (!fs.existsSync(dir)) f.git(repo, 'worktree', 'add', '-q', '-b', 'other', dir); return dir; };
  return {...f, other, date, now, repo, memoryDir, holder, bare, config, inputPath, options, run, cli, saveInput, commit, batch, lessons, notes, verdict, finished, roadmapFile, defaults, inRepo};
}
export const snapshot = f => ({repo: tree(f.repo), memory: tree(f.memoryDir)});
// The commands a report prints to finish a save: a `finish:` line and, for a project that holds its memory, a `then:` line. They are run
// as printed, each through sh -c (a POSIX shell, Git Bash on Windows), so every expansion the printed text allows really happens.
export const printedCommands = output => [...output.matchAll(/^(?:finish|then): (`+)(.*)\1$/gm)].map(m => m[2]);
// A POSIX shell: sh on the path, or the one Git for Windows ships next to git.
const posixShell = (() => {
  const gitRoot = spawnSync('git', ['--exec-path'], {encoding: 'utf8', windowsHide: true}).stdout?.trim();
  const candidates = ['sh', ...(process.platform === 'win32' ? ['C:/Program Files/Git/usr/bin/sh.exe', 'C:/Program Files/Git/bin/sh.exe', ...(gitRoot ? [path.resolve(gitRoot, '../../../usr/bin/sh.exe')] : [])] : [])];
  return candidates.find(command => spawnSync(command, ['-c', 'exit 0'], {windowsHide: true}).status === 0);
})();
export function runInShell(f, command) {
  assert.ok(posixShell, 'a POSIX shell (sh) is needed to run a printed command as printed');
  return f.exec(posixShell, ['-c', command]);
}
export function runPrinted(f, output) {
  const commands = printedCommands(output);
  assert.ok(commands.length > 0, 'the report prints a finish line:\n' + output);
  return commands.map(command => {
    const r = runInShell(f, command);
    assert.equal(r.status, 0, command + '\n' + r.stdout + r.stderr);
    return r;
  });
}
// The re-run line a save with a cause prints: one command, run as printed through sh, or a `re-run by hand:` line with its reason, the
// input file and the memory folder.
export const rerunCommand = output => /^re-run: (`+)(.*)\1$/m.exec(output)?.[2] ?? null;
export const rerunByHandLine = output => /^re-run by hand: (.*)$/m.exec(output)?.[1] ?? null;
// The line that says a finish is done by hand: its reason, the files it lists and the memory folder. No command is printed beside it.
export const byHandLine = output => /^finish by hand: (.*)$/m.exec(output)?.[1] ?? null;
// The save is committed and published when the file is in HEAD and HEAD is what the remote holds.
export function assertCommittedAndPushed(f, file) {
  f.git(f.holder, 'cat-file', '-e', 'HEAD:' + path.relative(f.holder, file).replaceAll('\\', '/'));
  assert.equal(f.git(f.bare, 'rev-parse', 'main'), f.git(f.holder, 'rev-parse', 'HEAD'), 'HEAD is what the remote holds');
}
export {fixture, put, read, tree, kitRoot, ok};
