import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isDirect, memorySlug, inRepoMemory} from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const operators = {'<': (a,b) => a < b, '>': (a,b) => a > b, '>=': (a,b) => a >= b, '<=': (a,b) => a <= b, '==': (a,b) => a === b};
export function loadUpgrades(file = path.join(here, 'upgrades.json')) {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(entries)) throw new Error('ledger must be an array');
  const ids = new Set();
  for (const e of entries) {
    if (!e || !/^[a-z][a-z0-9-]*$/.test(e.id ?? '') || ids.has(e.id) ||
        !['title', 'reason'].every(k => typeof e[k] === 'string' && e[k].trim()) ||
        !['trigger', 'never'].includes(e.verdict) || !['project', 'fleet'].includes(e.scope)) throw new Error('invalid ledger entry');
    ids.add(e.id);
    if (e.verdict === 'trigger' && (!e.trigger || !/^[a-zA-Z][\w.]*$/.test(e.trigger.metric ?? '') ||
        !Object.hasOwn(operators, e.trigger.op) || !Number.isFinite(e.trigger.value) ||
        (e.trigger.consecutive !== undefined && (!Number.isInteger(e.trigger.consecutive) || e.trigger.consecutive < 1)))) throw new Error('invalid trigger: ' + e.id);
  }
  return entries;
}
export function evaluateUpgrades(entries, scope, metrics, history = []) {
  const get = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);
  return entries.filter(e => e.scope === scope).map(e => {
    const t = e.trigger, current = t ? get(metrics, t.metric) : null;
    const condition = t ? `${t.metric} ${t.op} ${t.value}${t.consecutive > 1 ? ` (${t.consecutive} consecutive)` : ''}` : e.reason;
    let state = 'NEVER';
    if (e.verdict !== 'never') {
      const values = [current, ...history.slice(0, (t.consecutive ?? 1) - 1).map(p => get(p, t.metric))];
      state = !Number.isFinite(current) ? 'UNKNOWN' : !operators[t.op](current, t.value) ? 'DORMANT' :
        values.some(v => Number.isFinite(v) && !operators[t.op](v, t.value)) ? 'DORMANT' :
        values.length < (t.consecutive ?? 1) || values.some(v => !Number.isFinite(v)) ? 'UNKNOWN' : 'FIRED';
    }
    return {id: e.id, condition, current: current ?? null, state};
  });
}
export function triggerTable(rows, title = 'TRIGGERS') {
  const cell = v => String(v ?? '-').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
  return [`## ${title}`, '', '| ID | Condition | Current | State |', '| --- | --- | --- | --- |',
    ...rows.map(r => `| ${cell(r.id)} | ${cell(r.condition)} | ${cell(r.current)} | ${r.state} |`), ''].join('\n');
}
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const plain = file => {
  try {
    for (let current = path.resolve(file); ; current = path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) return false;
      if (path.dirname(current) === current) return true;
    }
  } catch { return false; }
};
const directories = dir => fs.existsSync(dir) && plain(dir) ? fs.readdirSync(dir, {withFileTypes: true}).filter(e => e.isDirectory() && !e.isSymbolicLink()) : [];
const createGit = () => {
 const probes = new Map(), errors = new Map();
 const failed = (repo, r) => { errors.set(repo, r.error?.code === 'ENOENT' ? 'git unavailable' : /dubious ownership/i.test(r.stderr ?? '') ? 'unsafe owner (git ownership guard)' : 'unreadable repo (' + (r.stderr?.trim().split(/\r?\n/)[0] || r.error?.message || 'git failed') + ')'); return null; };
 const git = (repo, ...args) => {
  const base=['--no-optional-locks','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','log.showSignature=false','-C',repo];
  const options={encoding:'utf8',timeout:10000,windowsHide:true,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_NO_LAZY_FETCH:'1'}};
  // A same-size modified file can make status run clean/process filters while hashing.
  // Reading config does not execute those drivers; mask every configured driver by name.
  if (!probes.has(repo)) {
  const configured=spawnSync('git',[...base,'config','--null','--name-only','--get-regexp','^filter\\..*\\.(clean|process|required)$'],options);
  if(![0,1].includes(configured.status)) { probes.set(repo, null); return failed(repo, configured); }
  const drivers=new Set(configured.stdout.split('\0').filter(Boolean).map(key=>key.replace(/\.(?:clean|process|required)$/,'')));
  const disabled=[...drivers].flatMap(key=>['-c',key+'.clean=','-c',key+'.process=','-c',key+'.required=false']);
  probes.set(repo, disabled);
  }
  const disabled = probes.get(repo);
  if (disabled === null) return null;
  const r = spawnSync('git', [...base,...disabled,...args], options);
  return r.status === 0 ? r.stdout.trim() : failed(repo, r);
 };
 git.error = repo => errors.get(repo);
 return git;
};
function memoryStats(dir) {
  const result = {files: 0, bytes: 0, lessonBytes: 0, generatedIndexBytes: 0};
  if (!dir) return result;
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.md')) continue;
    const text = fs.readFileSync(path.join(dir, entry.name)), size = text.length;
    result.files++; result.bytes += size;
    if (/^lesson-/.test(entry.name)) result.lessonBytes += size;
    if (/^INDEX-/.test(entry.name) && text.toString('utf8').startsWith('<!-- generated by memory-index.mjs;')) result.generatedIndexBytes += size;
  }
  return result;
}
const older = (version, current) => {
  const parts = v => /^\d+\.\d+\.\d+/.exec(v)?.[0].split('.').map(Number);
  const a = parts(version), b = parts(current);
  if (!a || !b) return false;
  for (let i=0;i<3;i++) if (a[i] !== b[i]) return a[i] < b[i];
  return version.includes('-') && !current.includes('-');
};
export function fleet({roots = [], memoryHome = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.claude/projects'), exclude = [], localFile = path.join(here, 'fleet.local.json'), projectGates = false} = {}) {
  const git = createGit();
  const local = fs.existsSync(localFile) ? readJSON(localFile) : {};
  for (const key of ['roots', 'exclude']) if (local[key] !== undefined && (!Array.isArray(local[key]) || local[key].some(v => typeof v !== 'string' || !v))) throw new Error('invalid fleet.local.json');
  roots = [...new Set([...roots, ...(local.roots ?? [])].map(p => path.resolve(p)))];
  const patterns = [...exclude, ...(local.exclude ?? [])].map(s => s.toLowerCase());
  const excluded = new Set(), projects = new Map(), slugs = new Map();
  const skip = (project, name) => patterns.some(p => project.toLowerCase().includes(p) || name.toLowerCase().includes(p));
  const ownVersionFile = path.join(here, '../VERSION');
  const version = fs.existsSync(ownVersionFile) ? fs.readFileSync(ownVersionFile, 'utf8').trim() : readJSON(path.join(here, 'KIT.json')).version;
  const repository = project => !plain(path.join(project, '.git')) ? false :
    git(project, 'rev-parse', '--is-inside-work-tree') === 'true' ? true : git.error(project) ?? 'unreadable repo (git failed)';
  const scan = (root, depth = 0) => {
    // Memory repositories belong to the memory scan, not project discovery.
    if (path.resolve(root) === path.resolve(memoryHome)) return;
    for (const entry of directories(root)) {
      if (entry.name === '.git') continue;
      const project = path.join(root, entry.name), slug = memorySlug(project).toLowerCase();
      if (skip(project, slug)) { excluded.add(slug); continue; }
      const isRepo = repository(project);
      if (depth === 0 || isRepo) slugs.set(slug, project);
      if (isRepo) projects.set(project, {project, memory: null});
      if (depth < 1) scan(project, depth + 1);
    }
  };
  for (const root of roots) {
    if (skip(root, path.basename(root))) { excluded.add(root.toLowerCase()); continue; }
    scan(root);
  }
  if (!skip(memoryHome, path.basename(memoryHome))) for (const entry of directories(memoryHome)) {
    const slug = entry.name.toLowerCase(), project = slugs.get(slug), folder = path.join(memoryHome, entry.name);
    if (skip(project ?? '', entry.name) || excluded.has(slug)) { excluded.add(slug); continue; }
    const memory = path.join(folder, 'memory');
    if (!plain(memory) || !fs.statSync(memory).isDirectory()) continue;
    projects.set(project ?? folder, {project: project ?? null, memory, memoryFolder: entry.name});
  }
  const rows = [];
  for (const p of projects.values()) {
    const repoState = p.project && repository(p.project);
    let inRepo = false, configError;
    try { if (p.project) {
      const configFile = path.join(p.project, 'scripts/memory/memory.config.json');
      if (plain(configFile) && readJSON(configFile).memory?.inRepoDir) {
        // Fleet uses tracked project configuration, never the operator's env override.
        const rel = readJSON(configFile).memory.inRepoDir;
        const dir = typeof rel === 'string' ? path.resolve(p.project, rel) : null;
        if (dir && inRepoMemory(p.project,dir) && plain(dir) && fs.statSync(dir).isDirectory()) {p.memory=dir; inRepo=true;}
      }
    } } catch (error) { configError = String(error.message).replace(/[\r\n]+/g, ' '); }
    const isRepo = repoState === true;
    const gitFile = p.project && path.join(p.project, '.git');
    const isWorktree = isRepo && fs.statSync(gitFile).isFile() && /^gitdir:/i.test(fs.readFileSync(gitFile, 'utf8'));
    const common = isWorktree ? git(p.project, 'rev-parse', '--path-format=absolute', '--git-common-dir') : null;
    const mainRepo = common ? path.dirname(path.resolve(p.project, common)) : p.project;
    const moduleParent=common?.replaceAll('\\','/').match(/^(.*)\/\.git\/modules\//)?.[1];
    const vendor = p.project && directories(p.project).map(e => path.join(p.project, e.name)).find(dir =>
      plain(path.join(dir, 'engine/memory-check.mjs')) && plain(path.join(dir, 'VERSION')) &&
      fs.readdirSync(dir).some(name => /^(?:vendor|vendored|vendoring)(?:[.-].*)?$/i.test(name) && plain(path.join(dir, name))));
    const receipt = p.project && path.join(p.project, 'scripts/memory/KIT.json');
    const installed = receipt && plain(receipt);
    let kitVersion = '-';
    if (installed) { try { kitVersion = readJSON(receipt).version ?? '-'; } catch {} }
    if (!installed && vendor) kitVersion = fs.readFileSync(path.join(vendor, 'VERSION'), 'utf8').trim();
    const stats = memoryStats(isWorktree && !inRepo ? null : p.memory), installedGate = p.project && path.join(p.project, 'scripts/memory/memory-check.mjs');
    const gateFile = projectGates && installedGate && plain(installedGate) ? installedGate : projectGates && vendor ? path.join(vendor, 'engine/memory-check.mjs') : path.join(here, 'memory-check.mjs');
    const gate = {source: gateFile === installedGate ? 'project gate' : projectGates && vendor ? 'vendored gate' : 'kit gate', FAIL: null, WARN: null, warnChecks: [], committed: false};
    if (!configError && p.memory && (!isWorktree || inRepo)) {
      const configFile=p.project && path.join(p.project,'scripts/memory/memory.config.json');
      const configArgs=configFile&&plain(configFile)?['--config',configFile]:vendor&&plain(path.join(vendor,'engine/memory.config.json'))?['--config',path.join(vendor,'engine/memory.config.json')]:[];
      const r = spawnSync(process.execPath, [gateFile, '--json', '--no-git', '--repo', p.project ?? p.memory, '--memory-dir', p.memory,...configArgs], {encoding: 'utf8', timeout: 30000, windowsHide: true, env: {...process.env, GIT_OPTIONAL_LOCKS: '0'}});
      try {
        const result = JSON.parse(r.stdout), findings = result.findings.filter(f => !f.allowed);
        gate.FAIL = findings.filter(f => f.severity === 'FAIL').length;
        gate.WARN = findings.filter(f => f.severity === 'WARN').length;
        gate.warnChecks = [...new Set(findings.filter(f => f.severity === 'WARN').map(f => f.check))];
      } catch { gate.error = 'gate did not return valid JSON'; }
      gate.committed = Boolean(p.project && git(p.project, 'rev-parse', 'HEAD') && git(p.memory, 'rev-parse', 'HEAD') && git(p.project, 'status', '--porcelain') === '' && git(p.memory, 'status', '--porcelain') === '');
    }
    const possible = !p.project && [...slugs].find(([slug]) => slug.replace(/-+/g, '-') === p.memoryFolder.toLowerCase().replace(/-+/g, '-'))?.[1];
    const status = configError ? `bad config (${configError})` : !p.project ? (possible ? `orphan memory (maybe ${possible})` : 'orphan memory') :
      typeof repoState === 'string' ? repoState : moduleParent ? `submodule of ${path.normalize(moduleParent)}` : inRepo ? `in-repo, ${!installed ? 'not installed' : older(kitVersion, version) ? 'behind' : 'current'}` : isWorktree ? `worktree of ${mainRepo}` : !isRepo ? 'no repo' : !p.memory ? 'no memory' :
      !installed ? (vendor ? 'vendored' : 'not installed') : older(kitVersion, version) ? 'behind' : 'current';
    rows.push({...p, kitVersion, memoryFiles: stats.files, memoryKB: stats.bytes / 1024, ...stats,
      lastCommit: p.project ? git(p.project, 'log', '-1', '--format=%cI') : null,
      commits30Days: p.project ? Number(git(p.project, 'rev-list', '--count', '--since=30 days ago', 'HEAD') ?? 0) : 0, gate, status});
  }
  const eligible = rows.filter(r => ['current', 'behind', 'vendored', 'in-repo, current', 'in-repo, behind'].includes(r.status));
  const warn = new Map();
  for (const row of eligible) for (const id of row.gate.warnChecks.filter(id => id !== 'repo.git-skipped')) warn.set(id, (warn.get(id) ?? 0) + 1);
  const metrics = {fleet: {
    tinyIndexProjects: eligible.filter(r => r.kitVersion !== '-' && r.bytes < 15 * 1024 && r.generatedIndexBytes > r.lessonBytes).length,
    maxWarnProjects: Math.max(0, ...warn.values()),
    warnProjectsByCheck: Object.fromEntries([...warn].sort(([a], [b]) => a.localeCompare(b))),
    committedFailProjects: eligible.some(r => r.gate.committed && r.gate.FAIL > 0) ? eligible.filter(r => r.gate.committed && r.gate.FAIL > 0).length : eligible.some(r => r.project && !r.gate.committed) ? null : 0
  }};
  return {version, excluded: excluded.size, projects: rows, metrics, triggers: evaluateUpgrades(loadUpgrades(), 'fleet', metrics)};
}
export function main(argv = process.argv.slice(2)) {
  try {
    const options = {roots: [], exclude: []}; let json = false;
    for (let i=0;i<argv.length;i++) {
      const arg = argv[i];
      if (arg === '--help') { console.log('Usage: memory-fleet.mjs [--root DIR] [--memory-home DIR] [--exclude PATTERN] [--project-gates] [--json]\n--root and --exclude are repeatable. Read-only; kit gate by default. --project-gates executes trusted project code. Local defaults: fleet.local.json.'); return 0; }
      if (arg === '--json') { json = true; continue; }
      if (arg === '--project-gates') { options.projectGates = true; continue; }
      if (!['--root', '--memory-home', '--exclude'].includes(arg) || !argv[i+1] || argv[i+1].startsWith('--')) throw new Error('invalid fleet arguments');
      const value = argv[++i];
      if (arg === '--root') options.roots.push(value);
      else if (arg === '--exclude') options.exclude.push(value);
      else options.memoryHome = value;
    }
    const result = fleet(options);
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Fleet ${result.version}; excluded: ${result.excluded}\n\n| Project | Kit | Files | KB | Last commit | Commits / 30d | FAIL | WARN | Gate | Status |\n| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | --- | --- |`);
      for (const r of result.projects) console.log(`| ${r.project ?? r.memoryFolder} | ${r.kitVersion} | ${r.memoryFiles} | ${r.memoryKB.toFixed(1)} | ${r.lastCommit ?? '-'} | ${r.commits30Days} | ${r.gate.FAIL ?? '-'} | ${r.gate.WARN ?? '-'} | ${r.gate.source} | ${r.status} |`);
      console.log('\nCounted WARN checks: ' + (Object.entries(result.metrics.fleet.warnProjectsByCheck).map(([id, count]) => id + '=' + count).join(', ') || 'none') + ' (excluded: repo.git-skipped)');
      console.log('\n' + triggerTable(result.triggers, 'FLEET TRIGGERS'));
    }
    return 0;
  } catch { console.error('memory-fleet: scan failed (paths withheld)'); return 1; }
}
if (isDirect(import.meta.url)) process.exitCode = main();
