import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { normalizeEol, matchEol, isDirect, isIndexPage, inRepoMemory, pathKey, slash } from '../engine/lib.mjs';
import {readJSON,write,writeJSON,run,resolveMemory,gate,freshMemoryWrites,finishMemory,memoryHook} from '../engine/memory-setup.mjs';
export {readJSON,write,writeJSON,run,resolveMemory,gate} from '../engine/memory-setup.mjs';
import { kitRoot, installedManifest, installedPath, ownedFiles } from './manifest.mjs';
import {typedBrainCount, brainIndexPairs, generateIndex} from '../engine/brain-index.mjs';
import {instructions,checkMemoryRouter,mirrorWrites,appendText,toolingHints,hostSnapshot,installReport,sameFile} from './install-safety.mjs';
export function options(argv) {
  if(argv.includes('--help') || argv.includes('-h')) return {help:true};
  const out = {};
  for(let i=0;i<argv.length;i++) {
    const key=argv[i];
    if(['--target','--memory-dir','--restore'].includes(key)) {
      if(!argv[i+1] || argv[i+1].startsWith('--')) throw new Error('Missing '+key);
      out[key.slice(2)] = argv[++i];
    } else if(['--no-guard','--no-gitignore-fix','--dry-run','--check','--force-skills','--backup','--accept-separate-memory'].includes(key)) out[key.slice(2)] = true;
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
  --no-gitignore-fix    Warn with every ignored installed file and matching .gitignore line;
                        continue even with excluded parents, without editing .gitignore.
  --dry-run             ${installScript?'Print planned writes without writing.':'Accepted by the shared parser; unused by upgrade.'}
  --backup              ${installScript?'Back up conflicting kit-owned files before installing.':'Accepted by the shared parser; upgrade always backs up changes.'}
  --force-skills        ${installScript?'Accepted by the shared parser; unused by install.':'Replace edited skills, including at the same version.'}
  --check               ${installScript?'Accepted by the shared parser; unused by install.':'Report version and local edits without writing.'}
  --restore <BACKUP>    ${installScript?'Accepted by the shared parser; unused by install.':'Restore files from an upgrade backup.'}
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
  const repo=spawnSync('git',['-C',target,'rev-parse','--is-inside-work-tree'],{encoding:'utf8'});
  if(repo.status!==0 && /not a git repository/.test(repo.stderr||'')) { console.log('gitignore audit skipped: host is not a Git repository'); return; }
  const candidates=[...new Set(paths.map(file=>slash(path.relative(target,file))).filter(file=>!file.startsWith('../')&&!path.isAbsolute(file)&&!/(?:^|\/)(?:KIT\.local\.json|\.kit-backup-[^/]*|\.memory\.lock[^/]*)($|\/)/.test(file)))];
  const hits=(cwd=target,extra=[])=>{
    const r=spawnSync('git',['-C',cwd,...extra,'check-ignore','--no-index','-v','-z','--stdin'],{encoding:'utf8',input:candidates.join('\0')+'\0'});
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
      const r=spawnSync('git',['-C',target,'check-ignore','--no-index','-v','--',parent+'/'],{encoding:'utf8'});
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
  } finally { fs.rmSync(scratch,{recursive:true,force:true}); }
  return [file,next];
}
export function install(opts, root = kitRoot) {
  if(Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node >=22 required');
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
  const configFile=path.join(engine,'memory.config.json');
  const projectConfig=readJSON(fs.existsSync(configFile)?configFile:path.join(root,'engine/memory.config.json'));
  const writeBrainIndex=projectConfig.caps?.brainIndex && typedBrainCount(target,projectConfig)>0;
  const memory=resolveMemory(target,opts['memory-dir']), version=fs.readFileSync(path.join(root,'VERSION'),'utf8').trim();
  if(pathKey(target)===pathKey(memory.dir)) throw new Error('memory must live in a dedicated folder; see CONVERT.md#move-root-memory-into-a-dedicated-folder');
  const inRepo=inRepoMemory(target,memory.dir);
  if(inRepo && spawnSync('git',['-C',target,'rev-parse','--is-inside-work-tree'],{encoding:'utf8'}).stdout?.trim()!=='true') throw new Error('in-repo memory requires a Git repository for its hook; initialize the host repository before installing');
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
  console.log('settings: '+(opts['no-guard']?'skipped (--no-guard)':local.guard===false?'skipped (KIT.local.json guard: false)':guardAdded?'guard hooks added (PreToolUse Bash|PowerShell, UserPromptSubmit)':'present'));
  const receipt={version,source:'memory-ladder-kit',installedAt:new Date().toISOString()};
  const planned = ownedFiles(root).map(f=>[path.join(target,installedPath(f)),fs.readFileSync(path.join(root,f))]);
  planned.push([path.join(engine,'MANIFEST.json'),Buffer.from(JSON.stringify(installedManifest(root),null,2)+'\n')]);
  const mirrors=mirrorWrites(target,planned,sources);
  planned.push(...mirrors);
  const conflicts=planned.filter(([file,data])=>fs.existsSync(file)&&(!fs.statSync(file).isFile()||normalizeEol(fs.readFileSync(file,'utf8'))!==normalizeEol(data)));
  if(conflicts.length&&!opts.backup) throw new Error('kit-owned destinations differ; use --backup:\n'+conflicts.map(([f])=>path.relative(target,f)).join('\n'));
  if(conflicts.some(([file])=>!fs.statSync(file).isFile())) throw new Error('kit-owned destination is not a file');
  for(const file of ['memory.config.json','recall-probes.json','upgrades.json']) if(!fs.existsSync(path.join(engine,file))) planned.push([path.join(engine,file),fs.readFileSync(path.join(root,'engine',file))]);
  if(!fs.existsSync(path.join(engine,'enforce-rules.json'))) planned.push([path.join(engine,'enforce-rules.json'),fs.readFileSync(path.join(root,'templates/enforce-rules.json'))]);
  if(inRepo) {
    const at=planned.findIndex(([file])=>file===configFile);
    if(at>=0) planned.splice(at,1);
    planned.push([configFile,JSON.stringify(projectConfig,null,2)+'\n']);
  }
  if(memory.custom && !inRepo) {
    if(local.memoryDir && path.resolve(local.memoryDir)!==path.resolve(memory.dir)) throw new Error('existing KIT.local.json differs; resolve its memoryDir before install');
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
  const agentsFile=!fs.existsSync(path.join(target,'AGENTS.md'))&&fs.existsSync(claudeFile)?claudeFile:path.join(target,'AGENTS.md'), agents=fs.existsSync(agentsFile)?fs.readFileSync(agentsFile,'utf8'):'';
  let gateInstructions=fs.readFileSync(path.join(root,'templates/AGENTS-memory-gate.md'),'utf8');
  if(inRepo) gateInstructions=gateInstructions.replace('gate, commit and push. Use `--no-push` or `--dry-run` when needed.', 'gate, then print staging paths and a suggested commit message. In in-repo memory, checkpoint never pushes and commits only with explicit `--commit` on the current branch; follow host branch rules. Use `--dry-run` to preview.');
  if(!/^## Memory gate/m.test(agents)) planned.push([agentsFile,appendText(agents,gateInstructions)]);
  if(!fs.existsSync(path.join(target,'CLAUDE.md'))) planned.push([path.join(target,'CLAUDE.md'),'@AGENTS.md\n']);
  else if(!sameFile(agentsFile,claudeFile)) {
    const claude = fs.readFileSync(claudeFile, 'utf8');
    if(!/^\s*@AGENTS\.md\s*$/m.test(claude)) planned.push([claudeFile,appendText(claude,'@AGENTS.md\n')]);
  }
  if(addHook || guardAdded) planned.push([settingsFile,JSON.stringify(settings,null,2)+'\n']);
  const newRepo=!inRepo && !fs.existsSync(path.join(memory.dir,'.git'));
  const brainPaths=writeBrainIndex?brainIndexPairs(target,projectConfig,generateIndex({repo:target,config:projectConfig})).pairs.map(([file])=>path.join(target,file)):[];
  const memoryPaths=inRepo&&fs.existsSync(memory.dir)?fs.readdirSync(memory.dir).filter(f=>fs.statSync(path.join(memory.dir,f)).isFile()).map(f=>path.join(memory.dir,f)):[];
  const ignorePlan=checkInstalledIgnores(target,[...planned.map(([file])=>file),receiptFile,configFile,...brainPaths,...memoryPaths,...(inRepo?[path.join(memory.dir,'.gitignore')]:[])],{...opts,memoryDir:inRepo?memory.dir:null});
  if(ignorePlan) planned.push(ignorePlan);
  if(opts['dry-run']) {
    for(const [file] of planned) console.log('WRITE '+file);
    console.log('WRITE '+receiptFile+' after baseline succeeds');
    for(const [file] of conflicts) console.log('BACKUP '+file);
    console.log('RATCHET missing index pins in '+configFile);
    console.log('HOOK '+path.join(inRepo?target:memory.dir,'.git/hooks/pre-commit')+' (preserve foreign hook; honor core.hooksPath)');
    if(newRepo) console.log('INIT and baseline commit '+memory.dir);
    if(writeBrainIndex) console.log('DRY brain index');
    console.log('GATE '+target); return;
  }

  const hostBefore=hostSnapshot(target,[...planned.map(([file])=>file),receiptFile,configFile,path.join(target,'.gitignore'),...brainPaths]);
  try {
  if(conflicts.length) {
    const backup=backupDirectory(engine);
    writeJSON(path.join(backup,'restore.json'),{files:conflicts.map(([file])=>({file:path.relative(target,file).split(path.sep).join('/'),existed:true}))});
    for(const [file] of conflicts) {
      const dest=path.join(backup,path.relative(target,file));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.renameSync(file,dest);
    }
    console.log('install backup: '+backup);
  }
  for(const [file,data] of planned) write(file,data);
  if(planned.some(([file,data])=>file===claudeFile&&String(data).includes('@AGENTS.md')&&hostBefore.get('CLAUDE.md')?.hash)) console.log('CLAUDE.md now imports AGENTS.md');
  for(const [file] of mirrors) console.log('skill mirror updated: '+path.relative(target,file));
  finishMemory({memory,target,engine,configFile,freshMemory,newRepo,inRepo,indexPages:files=>files.filter(f=>isIndexPage(f))});
  writeJSON(receiptFile,receipt);

  if(writeBrainIndex) {
    console.log(run(process.execPath,[path.join(engine,'brain-index.mjs'),'--write','--repo',target]));
    console.log('install: brain index written');
  } else console.log('brain index skipped: no typed nodes');

  toolingHints(target);
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
