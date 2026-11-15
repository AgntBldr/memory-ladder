import {validateConfigPaths} from '../engine/lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { normalizeEol, matchEol, isDirect, isIndexPage, inRepoMemory, pathKey, slash, removeQuietly } from '../engine/lib.mjs';
import { cleanGitEnv } from '../engine/install-hooks.mjs';
import {readJSON,write,writeJSON,run,resolveMemory,gate,freshMemoryWrites,finishMemory,memoryHook} from '../engine/memory-setup.mjs';
export {readJSON,write,writeJSON,run,resolveMemory,gate} from '../engine/memory-setup.mjs';
import { kitRoot, installedManifest, installedPath, ownedFiles } from './manifest.mjs';
import {typedBrainCount, brainIndexPairs, generateIndex} from '../engine/brain-index.mjs';
import {instructions,checkMemoryRouter,mirrorWrites,appendText,toolingHints,hostSnapshot,installReport} from './install-safety.mjs';
import {sessionSettings,skillPlan,standardBlockPlan,instructionsReportLines,distributionRefusals,lineEndingNote} from './install-safety.mjs';
export {mergeNewSessionHooks} from './install-safety.mjs';
function hints(target) {
  toolingHints(target);
  const note=lineEndingNote(target);
  if(note) console.log(note);
}
export function options(argv) {
  if(argv.includes('--help') || argv.includes('-h')) return {help:true};
  const out = {};
  for(let i=0;i<argv.length;i++) {
    const key=argv[i];
    if(['--target','--memory-dir','--restore','--replace-skill','--instructions-decisions','--instructions-ledger'].includes(key)) {
      if(!argv[i+1] || argv[i+1].startsWith('--')) throw new Error('Missing '+key);
      if(key==='--replace-skill') (out['replace-skill']??=[]).push(argv[++i]);
      else out[key.slice(2)] = argv[++i];
    } else if(['--no-new-session-hook','--no-guard','--no-gitignore-fix','--dry-run','--check','--force-skills','--backup','--accept-separate-memory','--live-memory','--memory-only'].includes(key)) out[key.slice(2)] = true;
    else throw new Error('Unknown option '+key);
  }
  if(!out.target) throw new Error('--target is required');
  out.target = path.resolve(out.target); return out;
}
export function usage(script) {
  const installScript=script==='install';
  return `Usage: node scripts/${script}.mjs --target <PROJECT> [options]

  --target <PROJECT>     Project root.
  --memory-dir <MEMORY>  Use this private memory directory.
  --accept-separate-memory  Explicitly accept a separate memory despite an in-repo router.
  --no-guard            Skip guard hooks and persist guard: false in KIT.local.json.
  --no-new-session-hook Remove the phrase hook and its permission; persist the opt-out.
  --replace-skill <NAME> Back up and replace this kit skill, including a foreign skill.
  --no-gitignore-fix    Warn with every ignored installed file and matching .gitignore line;
                        continue even with excluded parents, without editing .gitignore.
  --dry-run             ${installScript?'Print planned writes without writing.':'Alias for --check; report planned changes without writing.'}
  --backup              ${installScript?'Back up conflicting kit-owned files before installing.':'Accepted by the shared parser; upgrade always backs up changes.'}
  --force-skills        ${installScript?'Accepted by the shared parser; unused by install.':'Replace edited skills, including at the same version.'}
  --check               ${installScript?'Report the installation plan without writing.':'Report hooks, gate line, mirrors, foreign and unknown files without writing.'}
  --restore <BACKUP>    ${installScript?'Accepted by the shared parser; unused by install.':'Restore files from an upgrade backup.'}
  --live-memory         ${installScript?'Accepted by the shared parser; unused by install.':'Allow writes to the configured (live) memory folder and its hook; refused in a linked worktree.'}
  --memory-only         ${installScript?'Accepted by the shared parser; unused by install.':'Replay only the memory steps when project files are already at this kit version.'}
  --instructions-decisions <FILE>  Keep or drop decisions for unclear lines in an old memory section;
                        write the file with scripts/instructions-sort.mjs preview --out <FOLDER>.
  --instructions-ledger <FILE>     Read this sorting ledger instead of the kit's ledger folder.
  --help (-h)           Show this help and exit.
`;
}
export function mergeGuardHooks(settings, template) {
  settings.hooks ??= {};
  if(typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) throw Error('settings.json hooks must be an object');
  let added=false;
  for(const [event,command] of [['PreToolUse','pretooluse'],['UserPromptSubmit','prompt']]) {
    settings.hooks[event] ??= [];
    if(!Array.isArray(settings.hooks[event])) throw Error('hooks.'+event+' must be an array');
    const present=settings.hooks[event].some(entry=>entry?.hooks?.some(h=>typeof h?.command==='string' && new RegExp('memory-guard\\.mjs["\\\']?\\s+'+command+'(?:\\s|$)').test(h.command)));
    if(!present) { settings.hooks[event].push(...structuredClone(template.hooks[event])); added=true; }
  }
  return added;
}
export const ignoreText = '.kit-backup-*/\nKIT.local.json\nfleet.local.json\n';
export function withIgnores(text='') {
  const original=text;
  for(const line of ignoreText.trim().split('\n')) if(!text.split(/\r?\n/).includes(line)) text+=(text && !text.endsWith('\n')?'\n':'')+line+'\n';
  return matchEol(text,original);
}
export function backupDirectory(engine) {
  fs.mkdirSync(engine,{recursive:true});
  const prefix=path.join(engine,'.kit-backup-'+new Date().toISOString().replace(/[:.]/g,'-'));
  for(let i=0;;i++) {
    const dir=prefix+(i?'-'+i:'');
    try { fs.mkdirSync(dir); return dir; } catch(e) { if(e.code!=='EEXIST') throw e; }
  }
}
export function checkInstalledIgnores(target, paths, opts) {
  const repo=spawnSync('git',['-C',target,'rev-parse','--is-inside-work-tree'],{encoding:'utf8',env:cleanGitEnv()});
  if(repo.status!==0 && /not a git repository/.test(repo.stderr||'')) { console.log('gitignore audit skipped: host is not a Git repository'); return; }
  const candidates=[...new Set(paths.map(file=>slash(path.relative(target,file))).filter(file=>!file.startsWith('../')&&!path.isAbsolute(file)&&!/(?:^|\/)(?:KIT\.local\.json|\.kit-backup-[^/]*|\.memory\.lock[^/]*)($|\/)/.test(file)))];
  const hits=(cwd=target,extra=[])=>{
    const r=spawnSync('git',['-C',cwd,...extra,'check-ignore','--no-index','-v','-z','--stdin'],{encoding:'utf8',input:candidates.join('\0')+'\0',env:cleanGitEnv()});
    if(r.error||![0,1].includes(r.status)) throw new Error('git check-ignore failed: '+(r.error?.message||r.stderr));
    const parts=r.stdout.split('\0'),rows=[];
    for(let i=0;i+3<parts.length;i+=4) if(!parts[i+2].startsWith('!')) rows.push({source:parts[i],line:parts[i+1],pattern:parts[i+2],file:parts[i+3]});
    return rows;
  };
  const ignored=hits();
  for(const hit of ignored) console.log(`WARN ignored installed file: ${hit.source}:${hit.line}:${hit.pattern}\t${hit.file}`);
  if(!ignored.length) return;
  if(opts.memoryDir) {
    const rel=slash(path.relative(target,opts.memoryDir));
    if(ignored.some(hit=>hit.file===rel||hit.file.startsWith(rel+'/'))) throw new Error('in-repo memory is ignored; refusing to make private memory trackable: '+rel);
  }
  if(opts['no-gitignore-fix']) return;
  const folders=new Set(ignored.map(hit=>hit.file.startsWith('scripts/memory/')?'scripts/memory':hit.file.startsWith('.claude/skills/')?hit.file.split('/').slice(0,3).join('/'):path.posix.dirname(hit.file)));
  const file=path.join(target,'.gitignore'),old=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
  for(const folder of folders) {
    const parent=path.posix.dirname(folder);
    if(parent!=='.') {
      const r=spawnSync('git',['-C',target,'check-ignore','--no-index','-v','--',parent+'/'],{encoding:'utf8',env:cleanGitEnv()});
      if(r.status===0&&!r.stdout.split('\t')[0].split(':').at(-1).startsWith('!')) throw new Error(`cannot un-ignore kit folder ${folder}: parent directory ${parent}/ excluded by ${r.stdout.trim()}`);
    }
  }
  const rules=[...folders].map(folder=>folder==='.'?null:`!/${folder}/`).filter(Boolean);
  if(rules.length!==folders.size) throw new Error('cannot un-ignore installed root file with a narrow kit-folder negation');
  const next=appendText(old,'# Keep installed memory-ladder kit files trackable\n'+rules.join('\n')+'\n');
  // Validate planned rules in an isolated worktree; the host is still untouched.
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'kit-ignore-'));
  try {
    for(const candidate of candidates) {
      let dir=path.posix.dirname(candidate);
      while(dir!=='.') {
        const source=path.join(target,dir,'.gitignore');
        if(fs.existsSync(source)) { const dest=path.join(scratch,dir,'.gitignore'); fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.copyFileSync(source,dest); }
        dir=path.posix.dirname(dir);
      }
    }
    fs.writeFileSync(path.join(scratch,'.gitignore'),next);
    const gitDir=run('git',['-C',target,'rev-parse','--absolute-git-dir']);
    const remaining=hits(scratch,['--git-dir='+gitDir,'--work-tree='+scratch]);
    if(remaining.length) throw new Error('cannot un-ignore installed files: '+remaining.map(h=>`${h.file}: ${h.source}:${h.line}:${h.pattern}`).join('; '));
  } finally { removeQuietly(scratch); } // kit 3.3.6 item 9: a scratch folder that cannot be removed is noted, never thrown over the audit result
  return [file,next];
}
export function install(opts, root = kitRoot) {
  if(Number(process.versions.node.split('.')[0]) < 22) throw new Error('Install Node.js 22 or newer, then run this command again.');
  const started=performance.now(), target=path.resolve(opts.target), engine=path.join(target,'scripts/memory');
  const receiptFile=path.join(engine,'KIT.json');
  if(fs.existsSync(receiptFile)) {
    const message = `already installed (kit ${readJSON(receiptFile).version}); run scripts/upgrade.mjs --check`;
    if(opts['dry-run']) { console.log(message); return; }
    throw new Error(message);
  }
  const settingsFile=path.join(target,'.claude/settings.json');
  // Parse every existing JSON needed by installation before the first write.
  const settings = fs.existsSync(settingsFile) ? readJSON(settingsFile) : {};
  if(!settings || typeof settings!=='object' || Array.isArray(settings)) throw new Error('settings.json must be an object');
  const refusals=distributionRefusals(target,root);
  if(refusals.length) throw Error(refusals.join('\n'));
  const configFile=path.join(engine,'memory.config.json');
  const projectConfig=readJSON(fs.existsSync(configFile)?configFile:path.join(root,'engine/memory.config.json'));
  try { validateConfigPaths(target, projectConfig); }
  catch (error) { throw new Error('edit scripts/memory/memory.config.json: ' + error.message.replace('inside the repo', 'inside the project')); }
  const writeBrainIndex=projectConfig.caps?.brainIndex && typedBrainCount(target,projectConfig)>0;
  const memory=resolveMemory(target,opts['memory-dir']), version=fs.readFileSync(path.join(root,'VERSION'),'utf8').trim();
  if(pathKey(target)===pathKey(memory.dir)) throw new Error('memory must live in a dedicated folder; see CONVERT.md#move-root-memory-into-a-dedicated-folder');
  const inRepo=inRepoMemory(target,memory.dir);
  if(inRepo && spawnSync('git',['-C',target,'rev-parse','--is-inside-work-tree'],{encoding:'utf8',env:cleanGitEnv()}).stdout?.trim()!=='true') throw new Error('in-repo memory requires a Git repository for its hook; initialize the host repository before installing');
  if(inRepo) { projectConfig.memory ??= {}; projectConfig.memory.inRepoDir=slash(path.relative(target,memory.dir)); }
  const sources=instructions(target);
  checkMemoryRouter(target,memory,opts,sources);
  if(writeBrainIndex) brainIndexPairs(target,projectConfig,generateIndex({repo:target,config:projectConfig}));
  const session=readJSON(path.join(root,'templates/settings.sessionstart.json')).hooks.SessionStart[0];
  settings.hooks ??= {};
  if(typeof settings.hooks!=='object' || Array.isArray(settings.hooks)) throw new Error('settings.json hooks must be an object');
  settings.hooks.SessionStart ??= [];
  if(!Array.isArray(settings.hooks.SessionStart)) throw new Error('hooks.SessionStart must be an array');
  const addHook=!settings.hooks.SessionStart.some(e=>e?.hooks?.some(h=>h?.command===session.hooks[0].command));
  if(addHook) settings.hooks.SessionStart.push(session);
  const localFile=path.join(engine,'KIT.local.json'), local=fs.existsSync(localFile)?readJSON(localFile):{};
  const localBefore=JSON.stringify(local);
  const skipGuard=opts['no-guard'] || local.guard===false;
  const guardAdded=!skipGuard && mergeGuardHooks(settings,readJSON(path.join(root,'templates/settings.guard.json')));
  const sessionChanged=sessionSettings(settings,local,opts,root);
  console.log('settings: '+(opts['no-guard']?'skipped (--no-guard)':local.guard===false?'skipped (KIT.local.json guard: false)':guardAdded?(opts.check||opts['dry-run']?'guard hooks: would add':'guard hooks added')+' (PreToolUse Bash|PowerShell, UserPromptSubmit)':'present'));
  const receipt={version,source:'memory-ladder-kit',installedAt:new Date().toISOString()};
  const oldManifestFile=path.join(engine,'MANIFEST.json');
  const skills=skillPlan(target,root,fs.existsSync(oldManifestFile)?readJSON(oldManifestFile):null,local,opts);
  const planned = ownedFiles(root).filter(f=>!skills.kept.includes(installedPath(f))).map(f=>[path.join(target,installedPath(f)),fs.readFileSync(path.join(root,f))]);
  planned.push([path.join(engine,'MANIFEST.json'),Buffer.from(JSON.stringify(skills.next,null,2)+'\n')]);
  const mirrors=mirrorWrites(target,planned,sources,{replaceSkills:skills.replaceSkills});
  planned.push(...mirrors);
  const conflicts=planned.filter(([file,data])=>fs.existsSync(file)&&(!fs.statSync(file).isFile()||normalizeEol(fs.readFileSync(file,'utf8'))!==normalizeEol(data)));
  const unapproved=conflicts.filter(([file])=>!skills.replaceSkills.some(name=>['.claude','.agents'].some(dir=>file===path.join(target,dir,'skills',name,'SKILL.md'))));
  if(unapproved.length&&!opts.backup) throw new Error('kit-owned destinations differ; use --backup:\n'+unapproved.map(([f])=>path.relative(target,f)).join('\n'));
  if(conflicts.some(([file])=>!fs.statSync(file).isFile())) throw new Error('kit-owned destination is not a file');
  for(const file of ['memory.config.json','recall-probes.json','upgrades.json']) if(!fs.existsSync(path.join(engine,file))) planned.push([path.join(engine,file),fs.readFileSync(path.join(root,'engine',file))]);
  if(!fs.existsSync(path.join(engine,'enforce-rules.json'))) planned.push([path.join(engine,'enforce-rules.json'),fs.readFileSync(path.join(root,'templates/enforce-rules.json'))]);
  if(inRepo) {
    const at=planned.findIndex(([file])=>file===configFile);
    if(at>=0) planned.splice(at,1);
    planned.push([configFile,JSON.stringify(projectConfig,null,2)+'\n']);
  }
  if(memory.custom && !inRepo) {
    if(local.memoryDir && pathKey(local.memoryDir)!==pathKey(memory.dir)) throw new Error(`The saved notes folder in KIT.local.json is ${local.memoryDir}, but you requested ${memory.dir}. Use the saved folder or update memoryDir in scripts/memory/KIT.local.json before retrying.`);
    local.memoryDir=memory.dir;
  }
  if(opts['no-guard']) local.guard=false;
  if(JSON.stringify(local)!==localBefore) planned.push([localFile,JSON.stringify(local,null,2)+'\n']);
  const ignoreFile=path.join(engine,'.gitignore');
  const ignored=fs.existsSync(ignoreFile)?fs.readFileSync(ignoreFile,'utf8'):'';
  if(withIgnores(ignored)!==ignored) planned.push([ignoreFile,withIgnores(ignored)]);
  const freshMemory=!fs.existsSync(path.join(memory.dir,'MEMORY.md'));
  if(freshMemory) planned.push(...freshMemoryWrites(memory.dir,path.join(root,'templates')));
  const claudeFile=path.join(target,'CLAUDE.md');
  const claudeImported=fs.existsSync(claudeFile)&&/^\s*@AGENTS\.md\s*$/m.test(fs.readFileSync(claudeFile,'utf8'));
  // The kit standard block and Project rules in AGENTS.md (or a CLAUDE.md-only project), and the import block in CLAUDE.md.
  const instructionPlan=standardBlockPlan(target,root,{...opts,inRepo,install:true});
  if(instructionPlan.refusal) { if(!(opts.check||opts['dry-run'])) throw new Error(instructionPlan.refusal); console.log('install: '+instructionPlan.refusal); }
  planned.push(...instructionPlan.writes);
  if(addHook || guardAdded || sessionChanged) planned.push([settingsFile,JSON.stringify(settings,null,2)+'\n']);
  const newRepo=!inRepo && !fs.existsSync(path.join(memory.dir,'.git'));
  const brainPaths=writeBrainIndex?brainIndexPairs(target,projectConfig,generateIndex({repo:target,config:projectConfig})).pairs.map(([file])=>path.join(target,file)):[];
  const memoryPaths=inRepo&&fs.existsSync(memory.dir)?fs.readdirSync(memory.dir).filter(f=>fs.statSync(path.join(memory.dir,f)).isFile()).map(f=>path.join(memory.dir,f)):[];
  const ignorePlan=checkInstalledIgnores(target,[...planned.map(([file])=>file),receiptFile,configFile,...brainPaths,...memoryPaths,...(inRepo?[path.join(memory.dir,'.gitignore')]:[])],{...opts,memoryDir:inRepo?memory.dir:null});
  if(ignorePlan) planned.push(ignorePlan);
  if(opts['dry-run']||opts.check) {
    for(const [file] of planned) console.log('WRITE '+file);
    console.log('WRITE '+receiptFile+' after baseline succeeds');
    for(const [file] of conflicts) console.log('BACKUP '+file);
    console.log('RATCHET missing index pins in '+configFile);
    console.log('HOOK '+path.join(inRepo?target:memory.dir,'.git/hooks/pre-commit')+' (preserve foreign hook; honor core.hooksPath)');
    if(newRepo) console.log('INIT and baseline commit '+memory.dir);
    if(writeBrainIndex) console.log('DRY brain index');
    hints(target);
    console.log('GATE '+target); return;
  }

  const hostBefore=hostSnapshot(target,[...planned.map(([file])=>file),receiptFile,configFile,path.join(target,'.gitignore'),...brainPaths]);
  try {
  let reportPath=null;
  if(conflicts.length||instructionPlan.report) {
    const backup=backupDirectory(engine);
    // A sorted instruction file is copied, not moved: its original bytes stay restorable beside the report.
    const sorted=instructionPlan.report?[instructionPlan.file]:[];
    writeJSON(path.join(backup,'restore.json'),{files:[...conflicts.map(([file])=>file),...sorted].map(file=>({file:path.relative(target,file).split(path.sep).join('/'),existed:true}))});
    for(const [file] of conflicts) {
      const dest=path.join(backup,path.relative(target,file));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.renameSync(file,dest);
    }
    for(const file of sorted) write(path.join(backup,path.relative(target,file)),fs.readFileSync(file));
    if(instructionPlan.report) { reportPath=path.join(backup,'instructions-report.json');writeJSON(reportPath,instructionPlan.report); }
    console.log('install backup: '+backup);
  }
  for(const [file,data] of planned) write(file,data);
  if(!claudeImported&&planned.some(([file,data])=>file===claudeFile&&String(data).includes('@AGENTS.md')&&hostBefore.get('CLAUDE.md')?.hash)) console.log('CLAUDE.md now imports AGENTS.md');
  if(reportPath) for(const line of instructionsReportLines(root,instructionPlan,reportPath,opts)) console.log(line);
  for(const [file] of mirrors) console.log('skill mirror updated: '+path.relative(target,file));
  finishMemory({memory,target,engine,configFile,freshMemory,newRepo,inRepo,indexPages:files=>files.filter(f=>isIndexPage(f))});
  writeJSON(receiptFile,receipt);

  if(writeBrainIndex) {
    console.log(run(process.execPath,[path.join(engine,'brain-index.mjs'),'--write','--repo',target]));
    console.log('install: brain index written');
  } else console.log('brain index skipped: no typed nodes');

  hints(target);
  console.log('install wall time: '+Math.round(performance.now()-started)+' ms');
  let summary;
  try { summary=gate(target,memory.dir); }
  catch(error) {
    console.log(error.message);
    console.log('Hook skipped: fix the FAILs, then from the project root run:');
    console.log('node scripts/memory/install-hooks.mjs --repo . --memory-dir '+JSON.stringify(slash(memory.dir)));
    throw error;
  }
  memoryHook(target,memory);
  return summary;
  } finally { installReport(target,hostBefore); }
}
if(isDirect(import.meta.url)) {
  try {
    const opts=options(process.argv.slice(2));
    if(opts.help) console.log(usage('install'));
    else install(opts);
  } catch(e) { console.error('install: '+e.message); process.exitCode=1; }
}
