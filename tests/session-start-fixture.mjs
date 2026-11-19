import path from 'node:path';
import {createHash} from 'node:crypto';
import {fixture, put, ok, kitRoot} from './helpers.mjs';
import {loadConfig, localTime} from '../engine/lib.mjs';

// A project with the kit's session files installed, an in-repo memory folder, and the two skills owned by the manifest.
// Shared by the session-start tests: the state-block notice, the slash forms and the stamp precision.
export const helper = path.join(kitRoot, 'engine/new-session.mjs');
const hash = text => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
export const NOTICE = 'state block not used:';

export function startFixture(t) {
  const f = fixture(t), memoryDir = path.join(f.target, 'memory'), config = loadConfig(), files = {};
  config.memory = {inRepoDir: 'memory'};
  put(path.join(f.target, 'scripts/memory/memory.config.json'), JSON.stringify(config));
  put(path.join(f.target, 'scripts/memory/KIT.json'), JSON.stringify({version: config.engine_version}));
  for (const skill of ['new-session', 'handover']) {
    const relative = `.claude/skills/${skill}/SKILL.md`, text = '# Fixture skill\nRead the helper output.\n';
    put(path.join(f.target, relative), text); files[relative] = hash(text);
  }
  put(path.join(f.target, 'scripts/memory/MANIFEST.json'), JSON.stringify({files}));
  put(path.join(memoryDir, 'MEMORY.md'), '# Memory\n');
  put(path.join(f.target, '.gitignore'), 'memory/.memory.lock\n');
  f.git(f.target, 'add', '.'); f.git(f.target, 'commit', '-m', 'fixture');
  const branch = f.git(f.target, 'branch', '--show-current');
  const cli = (args, input, options = {}) => f.exec(process.execPath, [helper, ...args, '--repo', f.target], {input, ...options});
  const stateFile = path.join(memoryDir, 'current-state.md');
  // A hand-over note on this branch. `time` is a Date (written in the engine's own local-time form, with seconds) or a
  // string written as it is, for a time with fractions of a second.
  const note = (seq, time, onBranch = branch) => put(path.join(memoryDir, 'handovers', `${String(seq).padStart(6, '0')}-2026-01-01-1200.md`),
    `---\ntime: ${typeof time === 'string' ? time : localTime(time)}\nbranch: ${JSON.stringify(onBranch)}\nsha: abcdefa\nmode: full\n---\n**Open question:** question-${seq}\n**State:** note-state-${seq}\n**Waits on the user:** none\n**Next action:** step-${seq}\n`);
  const state = text => put(stateFile, text);
  // The stamp as a hand-written block or the writer would show it: local time, with or without seconds.
  const stamp = (time, seconds = true) => localTime(time).slice(0, seconds ? 19 : 16).replace('T', ' ');
  return {...f, memoryDir, branch, cli, note, state, stateFile, stamp, config, start: (...args) => ok(cli(['start', ...args])).stdout};
}
