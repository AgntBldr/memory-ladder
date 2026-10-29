import {writeText} from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {args, locations, isDirect, loadConfig, read, roadmapOrder, inRepoMemory, slash} from './lib.mjs';
import {withMemoryLock} from './memory-lock.mjs';
import {writeMemoryIndex} from './memory-index.mjs';
import {rotateLog, rotateRoadmap, validDate} from './memory-rotate.mjs';
import {generateIndex} from './brain-index.mjs';
import {generateOverview} from './roadmap-overview.mjs';
import {runCheck, counts, findingLine} from './memory-check.mjs';

export function checkpoint({memoryDir, repo, config = loadConfig(), dryRun = false, noPush = false, commit = false,
  today = new Date().toISOString().slice(0, 10), report = (step, message) => console.log(`${step}: ${message}`),
  git = (argv, options = {}) => execFileSync('git', ['-C', inRepoMemory(repo,memoryDir) ? repo : memoryDir, ...argv], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options})}) {
  if (!validDate(today)) throw new Error('invalid --today date; expected YYYY-MM-DD');
  roadmapOrder(config);
  const inRepo = inRepoMemory(repo,memoryDir);
  const steps = ['memory-index', 'rotate-log', 'rotate-roadmap', 'brain-index', 'roadmap-overview', 'gate', 'commit', 'push'];
  if (dryRun) { for (const step of steps) report(step, (step === 'push' && (noPush || inRepo)) || (step === 'commit' && inRepo && !commit) ? 'skipped' : 'dry-run'); return {dryRun: true}; }
  return withMemoryLock(memoryDir, lock => {
    const options = {memoryDir, repo, config, today, lock, write: true};
    const indexes = writeMemoryIndex(options); report('memory-index', `${Object.keys(indexes.pages).length} pages`);
    const exists = key => fs.existsSync(path.join(repo, config.caps[key].path));
    const log = exists('brainLog') ? rotateLog(options) : null;
    report('rotate-log', log ? `${log.moved} moved` : 'absent');
    const roadmap = exists('roadmap') ? rotateRoadmap(options) : null;
    report('rotate-roadmap', roadmap ? `${roadmap.moved} moved; proof ${roadmap.bytesRemoved} = ${roadmap.bytesAdded} bytes; found ${roadmap.found}` : 'absent');
    if (fs.existsSync(path.join(repo, config.brain?.dir ?? 'brain'))) {
      // Use the same first-write handling as the standalone generator.
      const output = generateIndex({repo, config}), allFile = path.join(repo, config.caps.brainIndex.allPath);
      if (!fs.existsSync(allFile)) {
        fs.mkdirSync(path.dirname(allFile), {recursive: true}); fs.writeFileSync(allFile, output.all);
        try { output.index = generateIndex({repo, config}).index; }
        catch (error) { fs.unlinkSync(allFile); throw error; }
      }
      for (const [name, text] of [[config.caps.brainIndex.path, output.index], [config.caps.brainIndex.allPath, output.all]]) {
        const file = path.join(repo, name); fs.mkdirSync(path.dirname(file), {recursive: true}); writeText(file, text);
      }
    }
    report('brain-index', fs.existsSync(path.join(repo, config.brain?.dir ?? 'brain')) ? 'written' : 'absent');
    if (exists('roadmap')) {
      const file = path.join(repo, config.caps.roadmapOverview.path);
      fs.mkdirSync(path.dirname(file), {recursive: true}); writeText(file, generateOverview({repo, config}));
    }
    report('roadmap-overview', exists('roadmap') ? 'written' : 'absent');
    const checked = runCheck({memoryDir, repo, config, today}), failures = checked.findings.filter(f => f.severity === 'FAIL' && !f.allowed);
    report('gate', `${counts(checked).FAIL} FAIL`);
    if (failures.length) throw new Error(failures.map(findingLine).join('\n'));
    if (inRepo) {
      const paths = [slash(path.relative(repo,memoryDir))];
      if(log) paths.push(config.caps.brainLog.path, ...log.destinations.map(d=>d.file));
      if(roadmap) paths.push(config.caps.roadmap.path, config.caps.roadmapOverview.path, ...(roadmap.moved ? [config.caps.roadmapHistory.path] : []));
      if(fs.existsSync(path.join(repo,config.brain?.dir ?? 'brain'))) paths.push(config.caps.brainIndex.path,config.caps.brainIndex.allPath);
      const selected = [...new Set(paths), ':(exclude,glob)**/.memory.lock*'];
      const message = `memory: checkpoint ${today}`;
      if (!commit) {
        const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
        report('commit', `in-repo memory; from repo root: git add -- ${selected.map(quote).join(' ')}\nSuggested commit message: ${message}`);
      } else {
        git(['add','--',...selected]);
        if(git(['diff','--cached','--name-only','--',...selected]).trim()) {git(['commit','-m',message,'--',...selected]);report('commit','created on current branch');}
        else report('commit','no changes');
      }
      report('push','skipped (in-repo memory)');
      return {push:'skipped',pushFailed:false};
    }
    git(['add', '--all', '--', '.', ':(exclude,glob)**/.memory.lock*']);
    if (git(['diff', '--cached', '--name-only', '--', '.', ':(exclude,glob)**/.memory.lock*']).trim() || git(['status', '--porcelain', '--', '.', ':(exclude,glob)**/.memory.lock*']).trim()) { git(['commit', '-m', `memory: checkpoint ${today}`, '--', '.', ':(exclude,glob)**/.memory.lock*']); report('commit', 'created'); }
    else report('commit', 'no changes');
    let push = noPush ? 'skipped' : 'ok', pushFailed = false;
    if (!noPush) try { git(['push'], {timeout: 120000}); } catch (error) { pushFailed = true; push = error.code === 'ETIMEDOUT' ? 'push timed out after 120 seconds' : String(error.message).trim(); }
    report('push', push); return {push, pushFailed};
  });
}
export function main(argv = process.argv.slice(2)) {
  try {
    const todayIndex = argv.indexOf('--today');
    if (todayIndex >= 0 && (!argv[todayIndex + 1] || argv[todayIndex + 1].startsWith('--'))) throw new Error('Missing --today value');
    const opts = args(argv), config = opts.config ? JSON.parse(read(opts.config)) : loadConfig();
    const result = checkpoint({...locations(opts), config, dryRun: opts['dry-run'], noPush: opts['no-push'], commit: opts.commit, today: opts.today}); return result.pushFailed ? 2 : 0;
  } catch (error) { console.error('memory-checkpoint: ' + error.message); return 1; }
}
if (isDirect(import.meta.url)) process.exitCode = main();
