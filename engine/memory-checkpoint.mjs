import {repoPath, validateConfigPaths} from './lib.mjs';
import {writeText, matchEol, normalizeEol} from './lib.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {args, locations, isDirect, loadConfig, read, roadmapOrder, inRepoMemory, slash, pathKey, cleanGitEnv, repoRoot, regularFileOrAbsent, refuseSpecialRead, scratchFolder, removeQuietly} from './lib.mjs';
import {withMemoryLock, isLockName, isLockPath} from './memory-lock.mjs';
import {writeMemoryIndex, generateMemoryIndex, stagedOutputs, isGenerated} from './memory-index.mjs';
import {rotateLog, rotateRoadmap, rotateHandovers, validDate} from './memory-rotate.mjs';
import {generateIndex} from './brain-index.mjs';
import {generateOverview} from './roadmap-overview.mjs';
import {runCheck, counts, findingLine} from './memory-check.mjs';
import * as S from './memory-session.mjs';

const sha256 = data => createHash('sha256').update(data).digest('hex');
const pick = f => ({check: f.check, file: f.file, line: f.line ?? null, message: f.message});
const gateOf = checked => ({fails: checked.findings.filter(f => f.severity === 'FAIL' && !f.allowed).map(pick), warns: checked.findings.filter(f => f.severity === 'WARN' && !f.allowed).map(pick), evaluated: checked.evaluated ?? []});
// uninspected: paths whose bytes could not be read while changes were collected, {layer, path, error}.
// cleanupErrors: cleanup, recovery and lock-release failures; they never replace the original error.
const blank = effective => ({status: 0, sha: null, exceptions: [], gate: null, publication: {sha: null, pushed: false, verified: false, error: null}, changed: {memory: [], repo: []}, uninspected: [], cleanupErrors: [], effective, error: null});
// A cleanup failure is folded into the structured result: added to cleanupErrors, and on an exit that had no error it
// makes the result status 1 with that message. The original error, SHA, gate, publication and changed paths stay.
function cleanupFailed(result, report, message) {
  result.cleanupErrors.push(message);
  if (!result.error) { result.status = 1; result.error = message; }
  try { report('cleanup', message); } catch {}
}
// Remove a temp folder after a failure without ever replacing that failure.
function removeAfterFailure(error, remove, what) {
  try { remove(); }
  catch (cleanupError) { if (error && typeof error === 'object') (error.cleanupErrors ??= []).push(`could not remove ${what}: ${cleanupError.message}`); }
}
const LOCK_EXCLUDES = [':(exclude,glob)**/.memory.lock*']; // both locks: the push lock is .memory.lock.push
// Ledgers never enter an all-sessions commit. git refuses a pathspec naming an ignored path, so the ledger folder is
// excluded explicitly only when it exists and the memory .gitignore does not already ignore it.
function excludes(memoryDir, git, inRepoPrefix = '') {
  if (!fs.existsSync(path.join(memoryDir, S.SESSIONS))) return LOCK_EXCLUDES;
  let ignored = false;
  try { git(['check-ignore', '-q', '--', inRepoPrefix + S.SESSIONS + '/0000000000000000.json']); ignored = true; } catch {}
  return ignored ? LOCK_EXCLUDES : [...LOCK_EXCLUDES, `:(exclude,literal)${inRepoPrefix}${S.SESSIONS}`];
}
// Kit 3.3.6 item 8: a fifo, socket or device is refused before the read (a read of one blocks); absent is null as before.
const readBytes = file => { refuseSpecialRead(file); try { return fs.readFileSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const sameBytes = (a, b) => a === null || b === null ? a === b : Buffer.compare(a, b) === 0;
// Change collection never throws: an unreadable path is reported as uninspected, never as a crash
// that would replace the original error.
// A path that exists and is not a regular file is never read (a folder, a pipe): its kind is the error.
const inspect = file => {
  try {
    let stat = null;
    try { stat = fs.statSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat && !stat.isFile()) return {error: 'ENOTFILE'};
    return {bytes: readBytes(file)};
  } catch (error) { return {error: String(error.code ?? error.message)}; }
};
function reportUninspected(result, report) {
  if (!result.uninspected.length) return;
  try { report('changed', `could not inspect ${result.uninspected.map(u => `${u.layer}:${u.path} (${u.error})`).join(', ')}; compare them by hand`); } catch {}
}

// ---- D1: which folders a save wrote into ----
// The first line of every run names the checkout and the memory folder it works in; the last line of a run against external
// memory names the checkout files this invocation changed. A path is canonical when it is resolved the way the session
// ledger resolves a checkout (links and junctions followed, on-disk case); a path that cannot be resolved keeps its absolute
// spelling, so printing a line never refuses a run.
const defaultReport = (step, message) => console.log(`${step}: ${message}`);
// The extended-length prefix is a spelling, not a place: `\\?\C:\x` is printed as `C:\x`, also when the folder does not exist yet.
const plainSpelling = dir => process.platform === 'win32' ? String(dir).replace(/^\\\\\?\\(?=[A-Za-z]:(?:[\\/]|$))/, '') : String(dir);
const folderText = dir => { const spelled = plainSpelling(dir); try { return S.canonicalize(spelled); } catch { try { return path.resolve(spelled); } catch { return spelled; } } };
// `memorySource` names where the folder came from (`--memory-dir`, `CLAUDE_MEMORY_DIR`, `memory.inRepoDir`,
// `KIT.local.json`, `default`, as lib.mjs memoryLocation names them); a caller that resolved the folder itself says `caller`.
export function checkpointHeader({repo, memoryDir, memorySource}) {
  return `repo ${repo ? folderText(repo) : 'unknown'}; memory ${memoryDir ? folderText(memoryDir) : 'not found'} (${memorySource ?? 'caller'})`;
}
// The paths in the checkout this invocation changed and left uncommitted, as a report step and message that print as
// `repo files changed in <checkout>: <list> - commit them in that checkout`. `none` is printed, never silence, and an empty
// list never stands for a list that could not be collected: a path that could not be read is named instead.
export function repoFilesReport(repo, changed, uninspected = []) {
  const left = uninspected.filter(u => u.layer === 'repo' || u.layer === 'all').map(u => u.path === '.' ? 'the output paths' : u.path);
  const listed = changed.join(', ');
  const message = left.length ? `${listed ? listed + '; ' : ''}could not inspect ${left.join(', ')} - compare them by hand and commit what changed in that checkout`
    : listed ? `${listed} - commit them in that checkout` : 'none';
  return [`repo files changed in ${repo ? folderText(repo) : 'unknown'}`, message];
}

// ---- Kit 3.3.6 item 24: the operator's uncommitted files ----
// Git decides every match; this code compares no path. Each call runs in the project folder (gitRun's -C, the folder the
// commit uses), so a pathspec is relative to the project and git keeps the repository prefix itself. A configured output is
// named to git by its configured string, raw, after `literal,icase`: git normalises ./ and .. (and \ on Windows) the way the
// writer's path.resolve did, and icase makes the match blind to case on every file system (on a case-sensitive one a case
// twin of an output then leaves its group out: over-protection, never a leak). The archives of the brain log are one glob,
// one level, in the log's folder. Code decides two things about a path: which writer produced a written path (structure, at
// the commit) and the glob spelling of the log's folder (lexical, globFolder). The pathspecs of a group are built once per run
// (outputSpecs); the same lists give the check and, with `exclude` added, the commit's exclusions.
// A group is modified when `git status --porcelain=v1 -z --untracked-files=all -- <its pathspecs>` exits 0 and prints anything
// (staged, unstaged, untracked and deleted entries all count), clean when it exits 0 and prints nothing; anything else (a
// status that is not 0, a thrown call) is unknown, and unknown is never "none modified". Nothing git prints is parsed except
// the first line of its message.
const firstLine = text => String(text ?? '').trim().split('\n')[0];
const spec = file => `:(literal,icase)${file}`;
const exclusion = pathspec => pathspec.replace(/^:\(/, ':(exclude,');
const globFolder = folder => folder.replace(/[[*?]/g, ch => `[${ch}]`);
function outputSpecs(config) {
  const folder = slash(path.dirname(config.caps.brainLog.path));
  const archives = `:(glob,icase)${folder === '.' ? '' : globFolder(folder) + '/'}log-[0-9][0-9][0-9][0-9]-[0-9][0-9].md`;
  const {roadmap, roadmapHistory, roadmapOverview, brainIndex} = config.caps;
  return [
    [spec(config.caps.brainLog.path), archives],
    [spec(roadmap.path), spec(roadmapHistory.path), ...(roadmapOverview.enabled === false ? [] : [spec(roadmapOverview.path)])],
    [spec(brainIndex.path), spec(brainIndex.allPath)],
  ];
}
function statusOf(repo, specs, gitRun) {
  try {
    const r = gitRun(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...specs], {literal: false});
    if (r.status !== 0) return {known: false, why: firstLine(r.stderr) || `git status exited ${r.status}`};
    return {known: true, modified: String(r.stdout).length > 0};
  } catch (error) { return {known: false, why: firstLine(error?.message) || 'git status failed'}; }
}
// The dry run's line: the outputs a real run rewrites that are already modified, one status call per path. No line when the
// list is empty or when any call did not answer (never the paths that did).
function reportAlreadyModified({repo, files, gitRun, report}) {
  const modified = [];
  for (const file of new Set(files)) {
    const state = statusOf(repo, [spec(file)], gitRun);
    if (!state.known) return;
    if (state.modified) modified.push(file);
  }
  if (modified.length) report('already modified', `${modified.join(', ')} (uncommitted in ${folderText(repo)}); a real run rewrites them`);
}
// The repo outputs of an in-repo all-sessions save fall into three groups that move together, so a commit never holds one
// half of a generated pair: the brain log with its archives, the roadmap with its history and overview, the brain index with
// index-all. `left` says the group was modified before the run, or that git could not say (unknown for one group is unknown
// for all).
function groupStatus(repo, groups, gitRun) {
  const states = [];
  for (const specs of groups) {
    const state = statusOf(repo, specs, gitRun);
    if (!state.known) return groups.map(() => ({left: true, why: state.why}));
    states.push({left: state.modified, why: null});
  }
  return states;
}

// E12.1: checkpoint({memoryDir, repo, config, session, files, filesOnly, memoryOnly, take, noRotate, noPush, dryRun, commit,
// today, report, memorySource, announced, gitRun}). gitRun (kit 3.3.6, default the session module's) is the one call that reads
// `git status` for item 24; a test injects a failing one. Without session mode (the default caps.checkpoint.mode "all"), the 3.3.4
// checkpoint runs, with E6's rotation refusal, E7's push lock and the structured result added. In both modes operational
// errors return the structured result with status 1 and the evidence gathered so far (E12.1); nothing throws.
// D1: the header is the first report of the run (`announced` says the caller, the command line, already printed it) and a
// run against external memory ends with the checkout files it changed; a dry run prints `would change` instead.
export function checkpoint(options) {
  const report = options.report ?? defaultReport;
  // Printing never changes a run: a report callback that throws costs the line, not the result.
  const say = (...line) => { try { report(...line); } catch {} };
  if (!options.announced) say('checkpoint', checkpointHeader(options));
  const inRepo = inRepoMemory(options.repo, options.memoryDir);
  const result = checkpointRun({...options, report, inRepo});
  if (!options.dryRun && !inRepo) say(...repoFilesReport(options.repo, result.changed.repo, result.uninspected));
  return result;
}
// The refusal text when the temporary folder is inside the project or the memory folder, else null. It asks scratchFolder
// (so the rule has one definition) and removes the folder it makes; any other failure of that call is not this check's: a
// run that needs a scratch folder meets it again where it makes one.
function temporaryFolderRefusal(repo, memoryDir) {
  let made;
  try { made = scratchFolder('memory-start-', [repo, memoryDir].filter(Boolean)); }
  catch (error) { return /^the temporary folder /.test(String(error?.message)) ? error.message : null; }
  removeQuietly(made);
  return null;
}
function checkpointRun(options) {
  const {memoryDir, repo, config = loadConfig(), session, all = false, files = [], filesOnly = false, memoryOnly = false, take = [], noRotate = false,
    today = new Date().toISOString().slice(0, 10), report, inRepo} = options;
  const effective = {session: false, memoryOnly: false, filesOnly: false};
  const refuse = message => ({...blank(effective), status: 1, error: message});
  // Kit 3.3.6 item 18: a real run starts only when the temporary folder is outside the project and the memory folder. The
  // check comes first because a session run takes its locks and writes a fresh --files claim before it makes its candidate
  // folder, and a refusal there would leave that claim behind. A dry run keeps its own check where it makes its copy.
  if (!options.dryRun) { const message = temporaryFolderRefusal(repo, memoryDir); if (message) return refuse(message); }
  let mode;
  try { mode = S.sessionMode(config); } catch (error) { return refuse(error.message); }
  const useSession = !all && (session === true || (session === undefined && mode === 'session'));
  effective.session = useSession;
  if (memoryOnly && !useSession) return refuse('--memory-only needs session mode (--session or caps.checkpoint.mode "session")');
  if (memoryOnly && inRepo) return refuse('--memory-only needs external memory; this memory is inside the project repo');
  if (filesOnly && !useSession) return refuse('--files-only needs session mode (--session or caps.checkpoint.mode "session")');
  if ((files.length || take.length) && !useSession) return refuse('--files and --take need session mode');
  effective.memoryOnly = Boolean(memoryOnly); effective.filesOnly = Boolean(filesOnly);
  if (useSession) return sessionCheckpoint({...options, config, today, report, inRepo, effective, files, take, filesOnly: Boolean(filesOnly), memoryOnly: Boolean(memoryOnly), noRotate});
  return allCheckpoint({...options, config, today, report, inRepo, effective});
}

// The 3.3.4 checkpoint, unchanged in what it commits; rotation waits for other sessions' claims (E6) and the push runs
// after the memory lock is released, under the push lock, verifying the saved SHA (E7).
function allCheckpoint(options) {
  const result = blank(options.effective);
  // memory: the memory files before the save wrote anything (taken under the lock); attempts: the repo outputs a step was
  // about to write and their bytes then. Neither exists until the save is past the lock, so a save that never got that far
  // lists nothing (D1).
  const evidence = {memory: null, attempts: null};
  try { return allCheckpointRun(options, result, evidence); }
  catch (error) {
    // Keep the original error and the evidence so far; collecting the changes can only add uninspected paths.
    collectChanged(result, evidence, options.memoryDir);
    // Kit 3.3.6 item 15: a temp file an atomic write could not remove is named, as a file left behind.
    for (const temp of error?.residue ?? []) result.uninspected.push({layer: 'repo', path: temp, error: 'left behind'});
    reportUninspected(result, options.report);
    // A lock release that failed after run() threw is attached to that error, never thrown instead of it.
    result.cleanupErrors.push(...(error?.cleanupErrors ?? []));
    return {...result, status: 1, error: String(error?.message ?? error).trim(), push: 'not run', pushFailed: false};
  }
}
function allCheckpointRun({memoryDir, repo, config, dryRun = false, noPush = false, commit = false, noRotate = false, today, report, inRepo,
  git = (argv, options = {}) => execFileSync('git', ['-C', inRepo ? repo : memoryDir, ...argv], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: cleanGitEnv(), ...options}), faults = {}, gitRun = S.gitRun}, result, evidence) {
  validateConfigPaths(repo, config);
  if (!validDate(today)) throw new Error('invalid --today date; expected YYYY-MM-DD');
  roadmapOrder(config);
  const steps = ['memory-index', 'rotate-log', 'rotate-roadmap', 'rotate-handovers', 'brain-index', 'roadmap-overview', 'gate', 'commit', 'push'];
  if (dryRun) {
    for (const step of steps) report(step, step === 'roadmap-overview' && config.caps.roadmapOverview.enabled === false ? 'off' : step.startsWith('rotate-') && noRotate ? 'skipped (--no-rotate)' : (step === 'push' && (noPush || inRepo)) || (step === 'commit' && inRepo && !commit) ? 'skipped' : 'dry-run');
    // D1: the one list of what a real run would change. A plan that cannot be made says so and changes no status.
    // A copy that could not be removed is reported and recorded as a cleanup error; a dry run's status stays what it was.
    const leftover = errors => { for (const message of errors ?? []) { result.cleanupErrors.push(message); report('cleanup', message); } };
    let planned = false;
    try {
      const plan = plannedChanges({memoryDir, repo, config, noRotate, today});
      result.changed = plan.changed;
      report('would change', [...result.changed.memory, ...result.changed.repo].join(', ') || 'nothing');
      planned = true;
      leftover(plan.cleanupErrors);
    } catch (error) { report('would change', `could not be planned (${String(error?.message ?? error).trim().split('\n')[0]})`); leftover(error?.cleanupErrors); }
    if (planned) reportAlreadyModified({repo, files: result.changed.repo, gitRun, report});
    return {...result, dryRun: true};
  }
  if (!noRotate && fs.existsSync(repoPath(repo, config.caps.brainLog.path, 'caps.brainLog.path'))) rotateLog({repo, config});
  const locked = withMemoryLock(memoryDir, lock => {
    evidence.memory = memorySnapshot(memoryDir); evidence.attempts = new Map();
    // Kit 3.3.6 item 24: which output groups were already modified, read once before the writes that rewrite them. Only a
    // --commit in a project with memory inside it uses it.
    const specs = inRepo && commit ? outputSpecs(config) : null, dirty = specs ? groupStatus(repo, specs, gitRun) : null;
    const {log, roadmap, outputs} = applyWrites({memoryDir, repo, config, today, lock, noRotate, report, waitsOf: () => rotationWaits(memoryDir, repo),
      onWaits: waits => result.exceptions.push({kind: 'rotation-waits', file: null, detail: waits}), record: files => recordAttempts(evidence.attempts, repo, files)});
    const checked = runCheck({memoryDir, repo, config, today}), failures = checked.findings.filter(f => f.severity === 'FAIL' && !f.allowed);
    result.gate = gateOf(checked);
    report('gate', `${counts(checked).FAIL} FAIL`);
    if (failures.length) throw new Error(failures.map(findingLine).join('\n'));
    if (inRepo) {
      // The written paths, assigned to a group by the writer that produced them (log: the log and the archives a rotation
      // made; roadmap: the roadmap and, when this run moved blocks, its history, from the roadmap rotation, and the overview
      // from the repo outputs writer, whether or not a rotation ran; index: the brain index pair, from the same writer).
      const memoryFolder = slash(path.relative(repo,memoryDir));
      const written = [
        log ? [config.caps.brainLog.path, ...log.destinations.map(d=>d.file)] : [],
        [...(roadmap ? [config.caps.roadmap.path] : []), ...outputs.overview, ...(roadmap?.moved ? [config.caps.roadmapHistory.path] : [])],
        outputs.index,
      ];
      const paths = [memoryFolder, ...written.flat()];
      const extras = [...(config.caps.roadmapOverview.enabled === false ? [exclusion(spec(config.caps.roadmapOverview.path))] : []), ...excludes(memoryDir, git, memoryFolder + '/')];
      const selected = [...new Set(paths), ...extras];
      const message = `memory: checkpoint ${today}`;
      if (!commit) {
        const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
        report('commit', `in-repo memory; from repo root: git add -- ${selected.map(quote).join(' ')}\nSuggested commit message: ${message}`);
      } else {
        // Kit 3.3.6 item 24: a group that was modified before the run (or whose status git could not tell) is left out of the
        // commit whole: its written paths are not included and every pathspec of the group is excluded (the same lists the
        // check used), so it stays out when the memory folder around it would take it in. The memory folder is never left out.
        const left = dirty.map(group => group.left);
        const leftOut = [...new Set(written.flatMap((files, i) => left[i] ? files : []))];
        const excluded = specs.flatMap((group, i) => left[i] ? group.map(exclusion) : []);
        // Every positive include is literal (a `[`, `*` or `?` in a written path or in the memory folder is a file name, never a
        // glob that could select another file); the exclusions keep their own magic. Add, diff --cached and commit take this list.
        const include = [...new Set([memoryFolder, ...written.flatMap((files, i) => left[i] ? [] : files)])].map(file => `:(literal)${file}`);
        const commitPaths = [...include, ...excluded, ...extras];
        git(['add','--',...commitPaths]);
        // E12.1: the saved SHA is recorded the moment the commit exists, before any cleanup.
        if(git(['diff','--cached','--name-only','--',...commitPaths]).trim()) {git(['commit','-m',message,'--',...commitPaths]);result.sha=headOf(git);report('commit','created on current branch');}
        else report('commit','no changes');
        if (leftOut.length) {
          const why = dirty.find(group => group.why)?.why;
          report('commit', `left out (${why ? `git status failed: ${why}` : 'uncommitted before this checkpoint'}): ${leftOut.join(', ')}; commit them yourself`);
        }
      }
      report('push','skipped (in-repo memory)');
      return {inRepoDone: true};
    }
    const EXCLUDES = excludes(memoryDir, git);
    git(['add', '--all', '--', '.', ...EXCLUDES]);
    if (git(['diff', '--cached', '--name-only', '--', '.', ...EXCLUDES]).trim() || git(['status', '--porcelain', '--', '.', ...EXCLUDES]).trim()) { git(['commit', '-m', `memory: checkpoint ${today}`, '--', '.', ...EXCLUDES]); result.sha = headOf(git); report('commit', 'created'); }
    else report('commit', 'no changes');
    return {sha: result.sha ?? headOf(git)};
  });
  collectChanged(result, evidence, memoryDir);
  reportUninspected(result, report);
  if (locked.inRepoDone) { result.sha ??= headOf(git); return {...result, push: 'skipped', pushFailed: false}; }
  result.sha = locked.sha;
  let push = noPush ? 'skipped' : 'ok', pushFailed = false;
  if (!noPush) {
    result.publication = publish({memoryDir, sha: locked.sha, git: (argv, opts) => git(argv, opts), faults});
    if (!result.publication.verified) { pushFailed = true; push = result.publication.error ?? 'publication not verified'; }
    result.status = pushFailed ? 2 : 0;
  } else result.publication = {sha: locked.sha, pushed: false, verified: false, error: null};
  report('push', pushFailed ? `failed (${push}); commit ${locked.sha ?? 'HEAD'} is local - run git -C ${memoryDir} push` : push);
  if (!noPush && result.publication.verified) report('publication', `${result.publication.sha} verified`);
  return {...result, push, pushFailed};
}
// An unreadable ledger hides what it protects, so rotation waits for it like for a pending claim. The real run
// and the dry run's plan ask this one question.
function rotationWaits(memoryDir, repo) {
  let ownId = null;
  try { ownId = S.sessionOf(repo).id; } catch {}
  try { const pending = S.pendingOther(memoryDir, ownId); return pending ? `rotation waits: ${pending} files pending in other sessions` : null; }
  catch (error) { if (error.code !== 'LEDGER_UNREADABLE') throw error; return 'rotation waits: ' + error.message.split('\n')[0]; }
}
// The writes of an all-sessions save, in order: the generated pages, the three rotations, the repo outputs. The real run calls
// this under the memory lock; the dry run calls the same function on private copies of what the writers read (D1),
// so what a dry run lists is what the writers decide: their kind checks, their preservation refusals and their
// deduplication. `record` is told the repo paths a step may write, just before that step starts.
function applyWrites({memoryDir, repo, config, today, lock, noRotate, report, waitsOf, onWaits = () => {}, staged, record = () => {}}) {
  const options = {memoryDir, repo, config, today, lock, write: true};
  const indexes = writeMemoryIndex({...options, ...(staged ? {staged} : {})}); report('memory-index', `${Object.keys(indexes.pages).length} pages`);
  const exists = key => fs.existsSync(path.join(repo, config.caps[key].path));
  const waits = noRotate ? null : waitsOf();
  if (waits) onWaits(waits);
  const rotate = !noRotate && !waits;
  let log = null, roadmap = null, handovers = null;
  if (rotate && exists('brainLog')) {
    // The archives a rotation appends to are named by the planner, the same read the writer makes; no folder is listed.
    record([config.caps.brainLog.path, ...rotateLog({repo, config}).destinations.map(d => d.file)]);
    log = rotateLog(options);
  }
  report('rotate-log', noRotate ? 'skipped (--no-rotate)' : waits ?? (log ? `${log.moved} moved` : 'absent'));
  if (rotate && exists('roadmap')) { record([config.caps.roadmap.path, config.caps.roadmapHistory.path]); roadmap = rotateRoadmap(options); }
  report('rotate-roadmap', noRotate ? 'skipped (--no-rotate)' : waits ?? (roadmap ? `${roadmap.moved} moved; proof ${roadmap.bytesRemoved} = ${roadmap.bytesAdded} bytes; found ${roadmap.found}` : 'absent'));
  if (rotate) handovers = rotateHandovers(options);
  report('rotate-handovers', noRotate ? 'skipped (--no-rotate)' : waits ?? `${handovers.moved} moved`);
  // Kit 3.3.6 item 17: the repo outputs are recorded by the writer, one by one, just before it writes each (and decides to).
  const outputs = writeRepoOutputs({repo, config, report, beforeWrite: rel => record([rel])});
  return {log, roadmap, handovers, waits, outputs};
}
// ---- D1: the dry run's private copies ----
// Only what the writers read is copied, and an entry that is not a regular file is refused before it is read: a pipe named
// MEMORY.md must not hang a dry run.
function copyFile(from, to, rel) {
  let stat;
  try { stat = fs.lstatSync(from); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isFile()) throw new Error(`${slash(rel)} is not a regular file`);
  fs.mkdirSync(path.dirname(to), {recursive: true}); fs.copyFileSync(from, to);
}
// The markdown files of a folder as the writers list them (regular files only), also those of its folders when `deep`. A
// markdown name that is not a regular file is kept as an empty folder: the writers never read it, and a generated-page
// writer refuses it as it would refuse the original.
function copyMarkdown(from, to, rel = '', deep = false) {
  let entries;
  try { entries = fs.readdirSync(from, {withFileTypes: true}); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  fs.mkdirSync(to, {recursive: true});
  for (const e of entries) {
    const next = rel ? rel + '/' + e.name : e.name;
    if (e.isFile() && /\.md$/i.test(e.name)) copyFile(path.join(from, e.name), path.join(to, e.name), next);
    else if (deep && e.isDirectory()) copyMarkdown(path.join(from, e.name), path.join(to, e.name), next, true);
    else if (!deep && /\.md$/i.test(e.name)) fs.mkdirSync(path.join(to, e.name), {recursive: true});
  }
}
function copyRepoInputs(repo, config, to) {
  const files = [[config.caps.brainLog.path, 'caps.brainLog.path'], [config.caps.roadmap.path, 'caps.roadmap.path'], [config.caps.roadmapHistory.path, 'caps.roadmapHistory.path'],
    [config.caps.roadmapOverview.path, 'caps.roadmapOverview.path'], [config.caps.brainIndex.path, 'caps.brainIndex.path'], [config.caps.brainIndex.allPath, 'caps.brainIndex.allPath']];
  for (const [rel, label] of files) copyFile(repoPath(repo, rel, label), path.join(to, rel), rel);
  // The archives next to the brain log: a rotation deduplicates against them.
  const logFolder = path.posix.dirname(slash(config.caps.brainLog.path));
  let names = [];
  try { names = fs.readdirSync(path.join(repo, logFolder)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of names) if (/^log-\d{4}-\d{2}\.md$/.test(name)) copyFile(path.join(repo, logFolder, name), path.join(to, logFolder, name), logFolder + '/' + name);
  for (const folder of [config.brain?.dir ?? 'brain', config.caps.shelf?.path].filter(Boolean)) copyMarkdown(path.join(repo, folder), path.join(to, folder), slash(folder), true);
  // Kit 3.3.6 item 19: the brain index lists a system file when it exists, and the copy holds markdown only. A configured system
  // file that is not markdown gets an empty placeholder (the generator checks existence only), so the plan matches the run.
  for (const name of config.caps.brainIndex?.systemFiles ?? []) {
    const rel = path.posix.join(slash(config.brain?.dir ?? 'brain'), '00-system', slash(name)), real = repoPath(repo, rel, 'caps.brainIndex.systemFiles');
    const mirror = path.join(to, rel);
    if (fs.existsSync(real) && !fs.existsSync(mirror)) { fs.mkdirSync(path.dirname(mirror), {recursive: true}); fs.writeFileSync(mirror, ''); }
  }
}
// D1: what an all-sessions run would change. The real writers run on private copies of their inputs and the bytes are
// compared afterwards: the kind checks, the refusal to replace hand-kept pages (working or staged), the deduplication of an
// interrupted rotation and the rotation question are the writers' own. Nothing in the memory folder or the checkout is
// written, locked or removed. A plan that cannot be made throws; the copies are always removed.
function plannedChanges({memoryDir, repo, config, noRotate, today}) {
  if (!memoryDir || !fs.existsSync(memoryDir)) throw new Error('memory dir not found');
  // Kit 3.3.6 item 18: refused when the temporary folder is inside the project or the memory folder (nothing is made then).
  const scratch = scratchFolder('memory-plan-', [repo, memoryDir]);
  let changed = null, failure = null;
  const cleanupErrors = [];
  try {
    const memory = path.join(scratch, 'memory'), mirror = path.join(scratch, 'repo');
    fs.mkdirSync(memory); fs.mkdirSync(mirror);
    copyFile(path.join(memoryDir, 'MEMORY.md'), path.join(memory, 'MEMORY.md'), 'MEMORY.md');
    copyMarkdown(memoryDir, memory); copyMarkdown(path.join(memoryDir, 'handovers'), path.join(memory, 'handovers'), 'handovers');
    copyRepoInputs(repo, config, mirror);
    const evidence = {memory: memorySnapshot(memory), attempts: new Map()}, staged = stagedOutputs(memoryDir);
    withMemoryLock(memory, lock => applyWrites({memoryDir: memory, repo: mirror, config, today, lock, noRotate, staged, report: () => {},
      waitsOf: () => rotationWaits(memoryDir, repo), record: files => recordAttempts(evidence.attempts, mirror, files)}), {note: () => {}});
    const collected = {changed: {memory: [], repo: []}, uninspected: []};
    collectChanged(collected, evidence, memory);
    if (collected.uninspected.length) throw new Error(`could not inspect ${collected.uninspected.map(u => `${u.layer}:${u.path} (${u.error})`).join(', ')}`);
    changed = collected.changed;
  } catch (error) { failure = error; }
  try { fs.rmSync(scratch, {recursive: true, force: true, maxRetries: 3}); }
  catch (error) { cleanupErrors.push(`could not remove ${scratch}: ${error.message}`); }
  if (failure) { (failure.cleanupErrors ??= []).push(...cleanupErrors); throw failure; }
  return {changed, cleanupErrors};
}
function headOf(git) { try { const sha = String(git(['rev-parse', 'HEAD'])).trim(); return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null; } catch { return null; } }

// E7: publication is serialised by the push lock, never blocks memory writers and never forces. The evidence is the
// actual remote branch (ls-remote), never a later HEAD or only a cached tracking ref. /handover reuses it for the
// in-repo project push, so both modes verify the saved SHA against the actual remote.
export function publish(options) {
  try { return publishLocked(options); }
  catch (error) { return {sha: options.sha, pushed: false, verified: false, error: String(error.message).trim().split('\n')[0]}; }
}
// lockTimeoutMs bounds the wait for the push lock (an upgrade holds it for its whole window, E2.8 (b)).
function publishLocked({memoryDir, sha, git, faults = {}, lockTimeoutMs = 120000}) {
  const publication = {sha, pushed: false, verified: false, error: null};
  return withMemoryLock(memoryDir, () => {
    faults.beforePublish?.();
    try { git(['push'], {timeout: 120000}); publication.pushed = true; }
    catch (error) { publication.error = error.code === 'ETIMEDOUT' ? 'push timed out after 120 seconds' : String(error.message).trim(); }
    if (!sha) { publication.error ??= 'no commit to publish'; return publication; }
    try {
      const branch = String(git(['symbolic-ref', '--short', 'HEAD'])).trim();
      const remote = String(git(['config', '--get', `branch.${branch}.remote`])).trim(), merge = String(git(['config', '--get', `branch.${branch}.merge`])).trim();
      if (!remote || !merge) throw new Error(`no upstream for ${branch}`);
      const tip = String(git(['ls-remote', remote, merge], {timeout: 120000})).split('\t')[0].trim();
      if (!/^[0-9a-f]{40,64}$/.test(tip)) throw new Error(`remote branch ${merge} not found`);
      const contained = () => { try { git(['merge-base', '--is-ancestor', sha, tip]); return true; } catch { return false; } };
      let ok = contained();
      if (!ok) { try { git(['fetch', '-q', remote, merge], {timeout: 120000}); } catch {} ok = contained(); }
      if (!ok) throw new Error(`${sha.slice(0, 7)} is not on ${remote} ${merge}`);
      publication.verified = true; publication.error = null;
    } catch (error) { if (!publication.error) publication.error = String(error.message).trim().split('\n')[0]; }
    return publication;
  }, {name: S.PUSH_LOCK, timeoutMs: lockTimeoutMs});
}

// Repo outputs are written as 3.3.4 writes them; planning computes the exact bytes without writing (E12.4).
function repoOutputPlan({repo, config}) {
  const plan = [];
  if (fs.existsSync(path.join(repo, config.brain?.dir ?? 'brain'))) {
    const allFile = repoPath(repo, config.caps.brainIndex.allPath, 'caps.brainIndex.allPath');
    const assume = fs.existsSync(allFile) ? [] : [path.posix.basename(slash(config.caps.brainIndex.allPath))];
    const output = generateIndex({repo, config, assumeExists: assume});
    plan.push([config.caps.brainIndex.path, output.index, 'caps.brainIndex.path'], [config.caps.brainIndex.allPath, output.all, 'caps.brainIndex.allPath']);
  }
  if (config.caps.roadmapOverview.enabled !== false && fs.existsSync(path.join(repo, config.caps.roadmap.path))) plan.push([config.caps.roadmapOverview.path, generateOverview({repo, config}), 'caps.roadmapOverview.path']);
  return plan.map(([file, text, label]) => {
    const absolute = repoPath(repo, file, label), current = readBytes(absolute);
    const bytes = Buffer.from(matchEol(text, current === null ? text : current.toString('utf8')));
    return {path: slash(file), absolute, text, bytes, current, stale: current === null || normalizeEol(current.toString('utf8')) !== normalizeEol(text)};
  });
}
// Kit 3.3.6 items 17 and 7(c): beforeWrite(rel, absolute) is called immediately before each write, so a caller records what the
// path held then (a path this run never writes is never recorded). Then the kind is checked: a fifo, socket or device (or a
// folder) at an output is refused before it is written or read. The record comes first, so a refused path is still reported
// as one that could not be inspected.
// It returns the configured names it wrote, by writer: `index` (the brain index pair) and `overview`. The commit takes its
// written outputs from this, not from the rotation results, so an output is included and named whether or not a rotation ran.
function writeRepoOutputs({repo, config, report, afterWrite = () => {}, beforeWrite = () => {}}) {
  const wrote = {index: [], overview: []};
  const before = (name, absolute) => { beforeWrite(name, absolute); regularFileOrAbsent(absolute, slash(name)); };
  if (fs.existsSync(path.join(repo, config.brain?.dir ?? 'brain'))) {
    // The generator reads the main index (its front matter) before the writes below, so that output is recorded and
    // kind-checked first: a main index that turned special after planning is then reported as not inspected, not as unknown.
    before(config.caps.brainIndex.path, repoPath(repo, config.caps.brainIndex.path, 'caps.brainIndex.path'));
    // Use the same first-write handling as the standalone generator.
    const output = generateIndex({repo, config}), allFile = repoPath(repo, config.caps.brainIndex.allPath, 'caps.brainIndex.allPath');
    if (!fs.existsSync(allFile)) {
      before(config.caps.brainIndex.allPath, allFile);
      fs.mkdirSync(path.dirname(allFile), {recursive: true}); fs.writeFileSync(allFile, output.all); afterWrite(config.caps.brainIndex.allPath);
      try { output.index = generateIndex({repo, config}).index; }
      // Removing the first-written catalog never replaces the generation error; its failure is
      // attached to that error as cleanupErrors, which the checkpoint result carries.
      catch (error) { removeAfterFailure(error, () => fs.unlinkSync(allFile), `the first-written brain index ${allFile}`); throw error; }
    }
    for (const [name, text] of [[config.caps.brainIndex.path, output.index], [config.caps.brainIndex.allPath, output.all]]) {
      const file = repoPath(repo, name, name === config.caps.brainIndex.allPath ? 'caps.brainIndex.allPath' : 'caps.brainIndex.path'); before(name, file);
      fs.mkdirSync(path.dirname(file), {recursive: true}); writeText(file, text); afterWrite(name); wrote.index.push(name);
    }
  }
  report('brain-index', fs.existsSync(path.join(repo, config.brain?.dir ?? 'brain')) ? 'written' : 'absent');
  const roadmap = fs.existsSync(path.join(repo, config.caps.roadmap.path));
  if (config.caps.roadmapOverview.enabled !== false && roadmap) {
    const file = repoPath(repo, config.caps.roadmapOverview.path, 'caps.roadmapOverview.path'); before(config.caps.roadmapOverview.path, file);
    fs.mkdirSync(path.dirname(file), {recursive: true}); writeText(file, generateOverview({repo, config})); afterWrite(config.caps.roadmapOverview.path); wrote.overview.push(config.caps.roadmapOverview.path);
  }
  report('roadmap-overview', config.caps.roadmapOverview.enabled === false ? 'off' : roadmap ? 'written' : 'absent');
  return wrote;
}
// D1's list for E12.1 changed: paths whose bytes or existence this invocation changed.
// Memory: the files of the folder and of its folders one level down. A folder that cannot be listed is an entry with an error,
// reported as uninspected, never an empty folder; a folder that is not there is empty.
function memorySnapshot(dir) {
  const files = new Map();
  const walk = rel => {
    let entries;
    try { entries = fs.readdirSync(path.join(dir, rel), {withFileTypes: true}); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) files.set(rel ? rel + '/' : '.', {error: String(error.code ?? error.message)}); return; }
    for (const e of entries) {
      const next = rel ? rel + '/' + e.name : e.name;
      if (e.name === '.git' || e.name === S.SESSIONS || isLockName(e.name)) continue;
      if (e.isDirectory() && !rel) walk(next); else if (e.isFile()) files.set(next, inspect(path.join(dir, next)));
    }
  };
  walk('');
  return files;
}
// Repo outputs: a path counts only when this run was about to write it. A step records its paths and their bytes just before
// it starts (the first record of a path wins), so a run that wrote nothing lists nothing, and a path another writer changed
// meanwhile is not this run's.
function recordAttempts(attempts, repo, files) {
  for (const file of files) {
    const key = slash(file), absolute = path.join(repo, file);
    if (!attempts.has(key)) attempts.set(key, {absolute, ...inspect(absolute)});
  }
}
// evidence: {memory, attempts} as the save recorded them; a part that was never recorded changed nothing.
function collectChanged(result, evidence, memoryDir) {
  try {
    const uninspected = [], changed = {memory: [], repo: []};
    if (evidence.memory) {
      const before = evidence.memory, after = memorySnapshot(memoryDir);
      changed.memory = [...new Set([...before.keys(), ...after.keys()])].sort().filter(key => {
        const x = before.get(key) ?? {bytes: null}, y = after.get(key) ?? {bytes: null};
        if (x.error || y.error) { uninspected.push({layer: 'memory', path: key, error: x.error ?? y.error}); return false; }
        return !sameBytes(x.bytes, y.bytes);
      });
    }
    for (const key of [...(evidence.attempts?.keys() ?? [])].sort()) {
      const prior = evidence.attempts.get(key), now = inspect(prior.absolute);
      if (prior.error || now.error) uninspected.push({layer: 'repo', path: key, error: prior.error ?? now.error});
      else if (!sameBytes(prior.bytes, now.bytes)) changed.repo.push(key);
    }
    result.changed = changed; result.uninspected.push(...uninspected);
  } catch (error) { result.uninspected.push({layer: 'all', path: '.', error: String(error.code ?? error.message)}); }
}

// ---- Session mode (E3) ----
function holderRoot(memoryDir) { return S.gitOut(memoryDir, ['rev-parse', '--show-toplevel'], {literal: false}).trim(); }
function memoryPrefix(memoryDir, root) {
  const rel = slash(path.relative(fs.realpathSync.native(root), fs.realpathSync.native(memoryDir)));
  return rel ? rel + '/' : '';
}
function indexEntry(root, full, env) {
  const line = S.gitOut(root, ['ls-files', '--stage', '--', full], {env}).split('\n').find(Boolean);
  if (!line) return null;
  const [meta, file] = line.split('\t'), [mode, blob, stage] = meta.split(' ');
  return {mode, blob, stage, file, line};
}
function treeEntry(root, rev, full) {
  if (!rev) return null;
  const line = S.gitOut(root, ['ls-tree', rev, '--', full]).split('\n').find(Boolean);
  if (!line) return null;
  const [meta] = line.split('\t'), [mode, , blob] = meta.split(' ');
  return {mode, blob};
}
// E3.2: the candidate is H plus this session's staged-equivalent blobs, built in an isolated GIT_INDEX_FILE whose new
// objects go to a temporary object directory, then materialised with the hook's checkout-index extraction.
export function candidateIndex({memoryDir, own, head = S.memoryHead(memoryDir), repo}) {
  const root = holderRoot(memoryDir), prefix = memoryPrefix(memoryDir, root);
  // Kit 3.3.6 item 18: the candidate folder is never inside the project or the memory folder.
  const temp = scratchFolder('memory-candidate-', [repo, memoryDir].filter(Boolean));
  try {
    const objects = path.join(temp, 'objects'); fs.mkdirSync(objects);
    const real = S.gitOut(root, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], {literal: false}).trim();
    const env = {GIT_INDEX_FILE: path.join(temp, 'index'), GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: real};
    if (head) S.gitOut(root, ['read-tree', head], {env, literal: false}); else S.gitOut(root, ['read-tree', '--empty'], {env, literal: false});
    const present = own.filter(key => { try { return fs.lstatSync(path.join(memoryDir, key)).isFile(); } catch { return false; } });
    const absent = own.filter(key => !present.includes(key));
    if (present.length) S.gitOut(memoryDir, ['add', '--', ...present], {env});
    if (absent.length) S.gitOut(memoryDir, ['rm', '--cached', '-q', '--ignore-unmatch', '--', ...absent], {env});
    return {root, prefix, temp, env, head, cleanup: () => fs.rmSync(temp, {recursive: true, force: true, maxRetries: 3})};
  } catch (error) { removeAfterFailure(error, () => fs.rmSync(temp, {recursive: true, force: true, maxRetries: 3}), `the candidate folder ${temp}`); throw error; }
}
function materialise(candidate, name) {
  const out = path.join(candidate.temp, name);
  fs.mkdirSync(out);
  const entries = S.gitRun(candidate.root, ['ls-files', '--cached', '--full-name', '-z', '--', candidate.prefix || '.'], {env: candidate.env, input: Buffer.alloc(0)}).stdout;
  const r = S.gitRun(candidate.root, ['checkout-index', '--force', '-z', '--stdin', '--prefix=' + slash(out) + '/'], {env: candidate.env, input: Buffer.from(entries), literal: false});
  if (r.status !== 0) throw new Error('candidate extraction failed: ' + String(r.stderr).trim());
  const dir = path.join(out, candidate.prefix); fs.mkdirSync(dir, {recursive: true});
  return dir;
}
export function materialiseCandidate({memoryDir, own, head, repo}) {
  const candidate = candidateIndex({memoryDir, own, head, repo});
  try { return {dir: materialise(candidate, 'tree'), cleanup: candidate.cleanup}; }
  catch (error) { removeAfterFailure(error, candidate.cleanup, `the candidate folder ${candidate.temp}`); throw error; }
}
// Links to in-repo files outside memory resolve against the proposed commit tree (H plus own), never the real index.
function proposedLinks(candidate, memoryDir) {
  if (!candidate.prefix) return undefined;
  const rows = S.gitRun(candidate.root, ['ls-files', '--cached', '-z'], {env: candidate.env}).stdout.split('\0').filter(Boolean);
  const fold = file => process.platform === 'win32' || process.platform === 'darwin' ? slash(file).toLowerCase() : slash(file);
  const paths = new Set(rows.map(row => fold(path.resolve(candidate.root, row))));
  const within = (base, file) => { const rel = path.relative(base, file); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
  const resolve = target => {
    if (path.isAbsolute(target) || path.win32.isAbsolute(target)) return undefined;
    const absolute = path.resolve(memoryDir, target);
    if (within(memoryDir, absolute) || !within(candidate.root, absolute)) return undefined;
    return paths.has(fold(absolute)) || paths.has(pathKey(absolute));
  };
  // The gate also resolves moved_to and brain targets through it, relative to this base.
  resolve.base = memoryDir;
  return resolve;
}
const unique = list => [...new Set(list)];
function changedMemoryPaths(memoryDir) {
  const out = (argv) => S.gitOut(memoryDir, argv).split('\n').map(s => s.trim()).filter(Boolean);
  return unique([...out(['diff', '--name-only', '--relative', '--', '.']), ...out(['diff', '--cached', '--name-only', '--relative', 'HEAD', '--', '.']), ...out(['ls-files', '--others', '--exclude-standard', '--', '.'])])
    .filter(f => !f.startsWith(S.SESSIONS + '/') && !isLockPath(f)).sort();
}
function sessionCheckpoint(ctx) {
  const {memoryDir, repo, config, files, take, filesOnly, memoryOnly, noPush = false, dryRun = false, commit = false, today, report, inRepo, effective, faults = {}, gitRun = S.gitRun} = ctx;
  const result = {...blank(effective), malformed: []};
  const mutated = {written: new Map(), snapshot: new Map(), index: new Map(), indexAfter: new Map()};
  // Snapshots taken by this invocation before it changes a memory page or a repo output; on every exit,
  // changed lists the paths that still differ from them (kept pages and partial repo writes included). Kit 3.3.6 item 17:
  // a repo output is recorded by the writer, just before it writes it, as what inspect() found (an error such as ENOTFILE
  // included), so an output that appeared after planning is recorded and one that turned special is reported.
  const repoBefore = new Map();
  let candidate, committed = false, root;
  // Collection never throws; a path it cannot read is reported as uninspected. A path whose recorded inspection
  // was an error is reported, never compared: it has no bytes to compare.
  const settle = () => {
    if (dryRun) return;
    const uninspected = [], differs = (layer, file, prior, absolute, priorError) => {
      const now = inspect(absolute), error = priorError ?? now.error;
      if (error) { uninspected.push({layer, path: file, error}); return false; }
      return !sameBytes(prior, now.bytes);
    };
    result.changed = {
      memory: [...mutated.snapshot.keys()].filter(file => differs('memory', file, mutated.snapshot.get(file), path.join(memoryDir, file))).sort(),
      repo: [...repoBefore].filter(([file, s]) => differs('repo', file, s.bytes, s.absolute, s.error)).map(([file]) => file).sort()};
    result.uninspected = uninspected;
    reportUninspected(result, report);
  };
  try {
    validateConfigPaths(repo, config);
    if (!validDate(today)) throw new Error('invalid --today date; expected YYYY-MM-DD');
    roadmapOrder(config);
    const session = S.sessionOf(repo);
    report('session', `${session.checkout} (${session.branch})`);
    const repoPlan = memoryOnly ? null : repoOutputPlan({repo, config});
    if (memoryOnly) result.deferred = {repo: repoOutputPlan({repo, config}).filter(p => p.stale).map(p => p.path)};
    function lockedSave() {
      root = holderRoot(memoryDir);
      const prefix = memoryPrefix(memoryDir, root), full = key => prefix + key;
      const H = S.memoryHead(memoryDir);
      if (!H) throw new Error('memory has no commit yet; make the first commit before a session save');
      // E3.1 selection: own unresolved claims plus --files (claimed now); --files-only selects only the named files.
      // An unreadable ledger refuses (ownLedger / foreignClaims throw); a malformed one blocks and is reported.
      const ledgers = S.readLedgers(memoryDir), own = S.ownLedger(memoryDir, session, {ledgers}), foreign = S.foreignClaims(memoryDir, session.id, {ledgers});
      for (const ledger of ledgers.filter(l => l.state === 'malformed')) {
        result.malformed.push({file: ledger.file, problems: ledger.problems});
        report('malformed ledger', `${ledger.file}: ${ledger.problems.join('; ')}; its claims stay unresolved until it is repaired`);
      }
      const fileKeys = S.claimKeys(memoryDir, files), takeKeys = S.claimKeys(memoryDir, take);
      const ownUnresolved = S.unresolvedOwn(memoryDir, own);
      const wanted = filesOnly ? unique([...fileKeys, ...takeKeys]) : unique([...ownUnresolved, ...fileKeys, ...takeKeys]);
      const contended = wanted.filter(key => foreign.has(key) && !takeKeys.includes(key)).sort();
      const selected = wanted.filter(key => !contended.includes(key)).sort();
      for (const key of contended) {
        const holders = foreign.get(key).map(S.holderText).join('; ');
        result.exceptions.push({kind: 'contended', file: key, detail: `also claimed by ${holders}`});
        report('contended', `${key} (also claimed by ${holders})`);
      }
      for (const key of selected.filter(key => foreign.has(key))) report('take', `took ${key} over the claim of ${foreign.get(key).map(h => `${h.checkout} on ${h.branch}`).join('; ')}`);
      // E2.6: a file named with --files is claimed now and stays claimed until a commit completes it or it is
      // released, also when it already equals HEAD.
      const fresh = unique([...fileKeys, ...takeKeys]).filter(key => !contended.includes(key) && (!own.claims[key] || !ownUnresolved.includes(key)));
      if (!dryRun && fresh.length) {
        const now = new Date().toISOString();
        for (const key of fresh) own.claims[key] = {since: now, by: 'memory-checkpoint --files', headAtClaim: H};
        S.writeLedger(memoryDir, own, {keep: fresh});
      }
      result.selected = selected;
      // E3.1: --files-only with nothing selected only publishes: no generated or repo output is applied and
      // nothing is committed; the read-only candidate gate still runs as evidence.
      const publishOnly = filesOnly && !selected.length;
      // E5: changed memory files claimed by no one are reported, never committed.
      const claimedAnywhere = new Set([...ownUnresolved, ...fileKeys, ...takeKeys, ...foreign.keys()]);
      const generatedFile = f => { try { return /^INDEX-[^/]*\.md$/.test(f) && fs.lstatSync(path.join(memoryDir, f)).isFile() && isGenerated(read(path.join(memoryDir, f))); } catch { return false; } };
      const unclaimed = changedMemoryPaths(memoryDir).filter(f => !claimedAnywhere.has(f) && !generatedFile(f));
      if (unclaimed.length) {
        for (const file of unclaimed) result.exceptions.push({kind: 'unclaimed', file, detail: 'changed; claimed by no session'});
        report('unclaimed', `${unclaimed.length} changed memory files (not this session's); see memory-session list`);
      }
      // E3.2 candidate tree and E3.3 generated outputs.
      candidate = candidateIndex({memoryDir, repo, own: selected, head: H});
      const ownChanged = selected.length ? S.gitOut(memoryDir, ['diff-index', '--cached', '--name-only', '--relative', H, '--', ...selected], {env: candidate.env}).split('\n').filter(Boolean) : [];
      const genDir = materialise(candidate, 'gen');
      const generated = generateMemoryIndex({memoryDir: genDir, config});
      const outputs = [];
      // E3.3: only a version carrying the generated marker may be replaced or deleted, working or staged;
      // an unmarked moved_to stub at a generated path is hand content too. A publication-only save applies nothing.
      const policy = (file, removal) => {
        const absolute = path.join(memoryDir, file);
        S.checkedFile(memoryDir, absolute, 'generated output');
        const current = readBytes(absolute);
        if (!publishOnly && current !== null && !isGenerated(current.toString('utf8'))) throw new Error(`run the route migration first; refusing to ${removal ? 'delete' : 'overwrite'} ${file}`);
        const staged = indexEntry(root, full(file)), headEntry = treeEntry(root, H, full(file));
        let stagedByOther = false;
        if (staged && (!headEntry || staged.blob !== headEntry.blob)) {
          const text = S.gitOut(root, ['cat-file', 'blob', staged.blob], {literal: false});
          if (!publishOnly && !isGenerated(text)) throw new Error(`run the route migration first; refusing to ${removal ? 'delete' : 'overwrite'} ${file} (staged version is not generated)`);
          stagedByOther = true;
        }
        return {absolute, current, staged, headEntry, stagedByOther};
      };
      for (const [file, text] of Object.entries(generated.pages)) {
        const p = policy(file, false), bytes = Buffer.from(matchEol(text, p.current === null ? text : p.current.toString('utf8')));
        outputs.push({file, action: 'write', bytes, ...p});
      }
      for (const file of generated.removed) outputs.push({file, action: 'delete', bytes: null, ...policy(file, true)});
      // Insert generated outputs into the isolated index, as git add would stage the bytes the real run writes.
      const info = [];
      for (const o of outputs) {
        if (o.action === 'write') {
          o.blob = S.gitRun(memoryDir, ['hash-object', '-w', '--path=' + o.file, '--stdin'], {env: candidate.env, input: o.bytes}).stdout.toString().trim();
          info.push(`100644 ${o.blob}\t${full(o.file)}`);
        } else info.push(`0 ${'0'.repeat(40)}\t${full(o.file)}`);
      }
      if (info.length) { const r = S.gitRun(root, ['update-index', '--index-info'], {env: candidate.env, input: Buffer.from(info.join('\n') + '\n'), literal: false}); if (r.status !== 0) throw new Error('candidate index update failed: ' + String(r.stderr).trim()); }
      const inCommit = o => o.action === 'write' ? o.blob !== o.headEntry?.blob : Boolean(o.headEntry);
      const pagesChanged = publishOnly ? [] : outputs.filter(inCommit).map(o => o.file);
      const toWrite = publishOnly ? [] : outputs.filter(o => o.action === 'write' ? !sameBytes(o.current, o.bytes) : o.current !== null);
      const replaced = publishOnly ? [] : outputs.filter(o => o.stagedByOther && (o.action === 'delete' || o.staged.blob !== o.blob));
      result.planned = {memory: toWrite.map(o => ({path: o.file, action: o.action, sha256: o.bytes === null ? null : sha256(o.bytes)})), repo: repoPlan && !publishOnly ? repoPlan.filter(p => !sameBytes(p.current, p.bytes)).map(p => ({path: p.path, action: 'write', sha256: sha256(p.bytes)})) : []};
      report('memory-index', publishOnly ? `${Object.keys(generated.pages).length} pages checked; none applied (publication only)` : `${Object.keys(generated.pages).length} pages`);
      for (const step of ['rotate-log', 'rotate-roadmap', 'rotate-handovers']) report(step, 'skipped (session mode)');
      // Mutation starts here (never in a dry run): snapshot, then write the generated outputs.
      if (!dryRun) {
        for (const o of toWrite) mutated.snapshot.set(o.file, o.current);
        for (const o of toWrite) {
          S.checkedFile(memoryDir, o.absolute, 'generated output');
          mutated.written.set(o.file, o.bytes); mutated.failed = o.file;
          if (o.action === 'write') fs.writeFileSync(o.absolute, o.bytes); else fs.unlinkSync(o.absolute);
          mutated.failed = null;
          faults.afterPageWrite?.();
        }
      }
      // E3.5 gate on the candidate (content) and the real holder (git health).
      const gateDir = materialise(candidate, 'gate');
      faults.beforeGate?.();
      const checked = runCheck({memoryDir: gateDir, repo, config, today, stagedLinkExists: proposedLinks(candidate, memoryDir), candidate: {gitDir: memoryDir}});
      result.gate = gateOf(checked);
      report('gate', `${counts(checked).FAIL} FAIL`);
      if (result.gate.fails.length) throw Object.assign(new Error(checked.findings.filter(f => f.severity === 'FAIL' && !f.allowed).map(findingLine).join('\n')), {gate: true});
      for (const o of replaced) { result.exceptions.push({kind: 'replaced-staged-generated', file: o.file, detail: 'a marked generated page staged by another session'}); report('memory-index', `replaced staged generated page ${o.file}`); }
      const commitPaths = unique([...ownChanged, ...pagesChanged, ...replaced.map(o => o.file)]).sort();
      const treeChanged = S.gitOut(root, ['write-tree'], {env: candidate.env, literal: false}).trim() !== S.gitOut(root, ['rev-parse', H + '^{tree}'], {literal: false}).trim();
      if (dryRun) {
        result.changed = {memory: unique([...ownChanged, ...toWrite.map(o => o.file)]).sort(), repo: result.planned.repo.map(p => p.path)};
        report('would change', [...result.changed.memory, ...result.changed.repo].join(', ') || 'nothing');
        reportAlreadyModified({repo, files: result.changed.repo, gitRun, report});
        return {sha: H, committed: false, publishOnly};
      }
      if (publishOnly) {
        report('commit', contended.length ? 'nothing committed: every selected file is contended' : 'nothing selected (--files-only); publication only');
        return {sha: H, committed: false, publishOnly};
      }
      if (inRepo && !commit) {
        const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
        report('commit', `in-repo memory; from repo root: git add -- ${commitPaths.map(p => quote(full(p))).join(' ') || '(nothing of this session\'s)'}\nSuggested commit message: memory: checkpoint ${today} (${session.branch})`);
        return {sha: H, committed: false};
      }
      if (!commitPaths.length || !treeChanged) {
        if (replaced.length) S.gitOut(memoryDir, ['add', '-A', '--', ...replaced.map(o => o.file)]);
        report('commit', contended.length && !selected.length ? 'nothing committed: every selected file is contended' : 'nothing of this session\'s to commit');
        return {sha: H, committed: false};
      }
      // E3.6: literal, file-only staging and commit; entries other sessions staged stay staged and out of the commit.
      for (const file of commitPaths) mutated.index.set(file, indexEntry(root, full(file)));
      const addable = commitPaths.filter(file => fs.existsSync(path.join(memoryDir, file)) || mutated.index.get(file) || treeEntry(root, H, full(file)));
      S.gitOut(memoryDir, ['add', '-A', '--', ...addable]);
      for (const file of commitPaths) mutated.indexAfter.set(file, indexEntry(root, full(file)));
      const message = `memory: checkpoint ${today} (${session.branch})`;
      const r = S.gitRun(memoryDir, ['commit', '--only', '-q', '-m', message, '--', ...addable]);
      if (r.status !== 0) throw new Error(`commit failed: ${String(r.stdout + r.stderr).trim()}`);
      committed = true;
      const sha = S.memoryHead(memoryDir);
      result.sha = sha;
      report('commit', `created ${sha.slice(0, 7)} (${commitPaths.length} files)`);
      faults.afterCommit?.();
      return {sha, committed: true};
    }
    const locked = withMemoryLock(memoryDir, lock => {
      try { return lockedSave(); }
      catch (error) {
        // Recovery runs inside the original lock acquisition, so no other writer can change a file between
        // recovery's comparison and its replacement.
        if (!committed && !dryRun) {
          // A failed recovery is part of the structured result, never a replacement for the error.
          try { restoreRun({memoryDir, root, mutated, report}); } catch (restoreError) { report('restore', 'failed: ' + restoreError.message); result.cleanupErrors.push('restore failed: ' + restoreError.message); }
          faults.afterRestore?.();
        }
        throw error;
      }
    });
    result.sha = locked.sha;
    // E3.7: record and publish. Only the owner rewrites its ledger; completed claims drop out (E2.6), and reservations
    // stay until a commit completes them or they are released.
    if (!dryRun) {
      withMemoryLock(memoryDir, () => {
        const own = S.ownLedger(memoryDir, session);
        if (Object.keys(own.claims).length) S.writeLedger(memoryDir, own);
      });
    }
    if (!memoryOnly && !dryRun && !locked.publishOnly) {
      writeRepoOutputs({repo, config, report, afterWrite: file => faults.afterRepoWrite?.(file), beforeWrite: (rel, absolute) => {
        const key = slash(rel);
        if (!repoBefore.has(key)) repoBefore.set(key, {absolute, ...inspect(absolute)});
      }});
    } else if (memoryOnly) { report('brain-index', 'deferred (--memory-only)'); report('roadmap-overview', 'deferred (--memory-only)'); }
    else if (locked.publishOnly) { report('brain-index', 'skipped (publication only)'); report('roadmap-overview', 'skipped (publication only)'); }
    settle();
    if (inRepo) report('push', 'skipped (in-repo memory)');
    else if (dryRun || noPush) { result.publication = {sha: result.sha, pushed: false, verified: false, error: null}; report('push', dryRun ? 'dry-run' : 'skipped'); }
    else {
      result.publication = publish({memoryDir, sha: result.sha, git: (argv, opts = {}) => {
        const r = S.gitRun(memoryDir, argv, {literal: false, timeout: opts.timeout ?? 120000});
        if (r.error) throw r.error;
        if (r.status !== 0) throw new Error(String(r.stderr || r.stdout).trim() || `git ${argv[0]} exited ${r.status}`);
        return r.stdout;
      }, faults});
      if (result.publication.verified) report('publication', `${result.sha} verified`);
      else report('push', `failed (${result.publication.error}); commit ${result.sha} is local - run git -C ${memoryDir} push`);
    }
    result.status = !inRepo && !dryRun && !noPush && !result.publication.verified ? 2 : result.exceptions.some(e => e.kind === 'contended') ? 3 : 0;
    return result;
  } catch (error) {
    settle();
    result.cleanupErrors.push(...(error?.cleanupErrors ?? []));
    result.status = 1; result.error = String(error?.message ?? error).trim();
    report('error', result.error.split('\n')[0]);
    return result;
  } finally {
    // The candidate folder's removal can fail after its retries; that failure is folded into the
    // returned result and never escapes checkpoint() or replaces the original error.
    if (candidate) {
      try { candidate.cleanup(); }
      catch (cleanupError) { cleanupFailed(result, report, `could not remove the candidate folder ${candidate.temp}: ${cleanupError.message}`); }
    }
  }
}
// E3.3 rule: restore working files and index entries this operation changed, unless they changed again since; keep those.
// Runs inside the save's own lock acquisition.
function restoreRun({memoryDir, root, mutated, report}) {
  for (const [file, wrote] of mutated.written) {
    const absolute = path.join(memoryDir, file), now = readBytes(absolute), prior = mutated.snapshot.get(file) ?? null;
    if (sameBytes(now, prior)) continue;
    // The page whose write failed may be partly written, so it is restored whatever its bytes are now.
    if (!sameBytes(now, wrote) && file !== mutated.failed) { report('restore', `kept ${file} (changed after this run wrote it); compare it with git -C ${memoryDir} diff -- ${file}`); continue; }
    S.checkedFile(memoryDir, absolute, 'generated output');
    if (prior === null) fs.rmSync(absolute, {force: true}); else fs.writeFileSync(absolute, prior);
  }
  if (!root || !mutated.indexAfter.size) return;
  const prefix = memoryPrefix(memoryDir, root), lines = [];
  for (const [file, after] of mutated.indexAfter) {
    const now = indexEntry(root, prefix + file);
    if ((now?.line ?? null) !== (after?.line ?? null)) { report('restore', `kept index entry ${file} (changed after this run staged it)`); continue; }
    const prior = mutated.index.get(file);
    lines.push(prior ? `${prior.mode} ${prior.blob} ${prior.stage}\t${prefix + file}` : `0 ${'0'.repeat(40)}\t${prefix + file}`);
  }
  if (lines.length) S.gitOut(root, ['update-index', '--index-info'], {input: Buffer.from(lines.join('\n') + '\n'), literal: false});
}

function parseArgs(argv) {
  const out = {files: [], take: []}, flags = {'--session': 'session', '--all': 'all', '--files-only': 'filesOnly', '--memory-only': 'memoryOnly', '--no-rotate': 'noRotate', '--no-push': 'noPush', '--dry-run': 'dryRun', '--commit': 'commit'};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flags[arg]) { out[flags[arg]] = true; continue; }
    if (arg === '--files' || arg === '--take') {
      const list = arg === '--files' ? out.files : out.take;
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing ${arg} value`);
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) list.push(argv[++i]);
      continue;
    }
    if (['--repo', '--memory-dir', '--config', '--today'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing ${arg} value`);
      out[arg.slice(2)] = argv[++i]; continue;
    }
    if (arg.includes('=')) throw new Error(arg + ' is not supported; use ' + arg.replace('=', ' '));
    throw new Error('unknown option ' + arg);
  }
  if (out.session && out.all) throw new Error('choose --session or --all');
  return out;
}
// D1: the first output of every run, a refused one included, names the folders; a command line that cannot be parsed still
// names the --repo and --memory-dir it carried. Values are read the way parseArgs reads them (the last one wins, a value never
// starts with `--`).
function scanLocations(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (['--repo', '--memory-dir'].includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
  return out;
}
export function main(argv = process.argv.slice(2)) {
  // The command line, then the configuration, then the folders: the first failure is the one reported, in that order.
  let opts, config, location, failure;
  try { opts = parseArgs(argv); } catch (error) { failure = error; opts = scanLocations(argv); }
  if (!failure) try { config = opts.config ? JSON.parse(read(opts.config)) : loadConfig(); } catch (error) { failure = error; }
  // E2.8 (e): the memory and checkout are found with the cleaned git environment, as every save git call is.
  try { location = locations(opts, {env: cleanGitEnv()}); } catch (error) { failure ??= error; }
  console.log('checkpoint: ' + (location ? checkpointHeader(location) : `repo ${folderText(path.resolve(opts.repo || repoRoot()))}; memory unresolved (error below)`));
  if (failure) {
    // The run that never started changed nothing: with external memory known, the end of the run says so, as for a refusal.
    if (location?.memoryDir && !argv.includes('--dry-run') && !inRepoMemory(location.repo, location.memoryDir)) console.log(repoFilesReport(location.repo, [], []).join(': '));
    console.error('memory-checkpoint: ' + failure.message); return 1;
  }
  try {
    const result = checkpoint({...location, config, announced: true, session: opts.session ? true : undefined, all: Boolean(opts.all), files: opts.files, take: opts.take,
      filesOnly: Boolean(opts.filesOnly), memoryOnly: Boolean(opts.memoryOnly), noRotate: Boolean(opts.noRotate), dryRun: Boolean(opts.dryRun), noPush: Boolean(opts.noPush), commit: Boolean(opts.commit), today: opts.today});
    if (result.error) console.error('memory-checkpoint: ' + result.error);
    return result.status ?? (result.pushFailed ? 2 : 0);
  } catch (error) { console.error('memory-checkpoint: ' + error.message); return 1; }
}
if (isDirect(import.meta.url)) process.exitCode = main();
