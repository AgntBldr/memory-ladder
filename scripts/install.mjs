import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { isDirect, memorySlug, memoryLocation } from '../engine/lib.mjs';
import {writeMemoryIndex, isGenerated} from '../engine/memory-index.mjs';
import { kitRoot, installedManifest, installedPath, ownedFiles } from './manifest.mjs';
export function readJSON(f) {
  try { return JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,'')); }
  catch(e) { throw new Error(`cannot read ${f}: ${String(e.message).replace(/[\r\n]+/g,' ')}`); }
}
export const write = (f, data) => { fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f,data); };
export const writeJSON = (f, data) => write(f,JSON.stringify(data,null,2)+'\n');
export function run(command, argv, opts = {}) {
  const r = spawnSync(command,argv,{encoding:'utf8',timeout:120000,...opts});
  if(r.error || r.status !== 0) throw new Error(r.error?.message || (r.stdout+r.stderr).trim() || command+' exited '+r.status);
  return r.stdout.trim();
}
export function options(argv) {
  if(argv.includes('--help') || argv.includes('-h')) return {help:true};
  const out = {};
  for(let i=0;i<argv.length;i++) {
    const key=argv[i];
    if(['--target','--memory-dir','--restore'].includes(key)) {
      if(!argv[i+1] || argv[i+1].startsWith('--')) throw new Error('Missing '+key);
      out[key.slice(2)] = argv[++i];
    } else if(['--dry-run','--check','--force-skills','--backup'].includes(key)) out[key.slice(2)] = true;
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
  --dry-run             ${installScript?'Print planned writes without writing.':'Accepted by the shared parser; unused by upgrade.'}
  --backup              ${installScript?'Back up conflicting kit-owned files before installing.':'Accepted by the shared parser; upgrade always backs up changes.'}
  --force-skills        ${installScript?'Accepted by the shared parser; unused by install.':'Replace edited skills, including at the same version.'}
  --check               ${installScript?'Accepted by the shared parser; unused by install.':'Report version and local edits without writing.'}
  --restore <BACKUP>    ${installScript?'Accepted by the shared parser; unused by install.':'Restore files from an upgrade backup.'}
  --help (-h)           Show this help and exit.
`;
}
export function resolveMemory(target, requested) {
  const resolved = memoryLocation(target,requested);
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return {dir:resolved.dir || path.join(home,'.claude/projects',memorySlug(path.resolve(target)),'memory'),custom:resolved.source!=='default'};
}
export const ignoreText = '.kit-backup-*/\nKIT.local.json\n';
export function withIgnores(text='') {
  for(const line of ignoreText.trim().split('\n')) if(!text.split(/\r?\n/).includes(line)) text+=(text && !text.endsWith('\n')?'\n':'')+line+'\n';
  return text;
}
export function backupDirectory(engine) {
  fs.mkdirSync(engine,{recursive:true});
  const prefix=path.join(engine,'.kit-backup-'+new Date().toISOString().replace(/[:.]/g,'-'));
  for(let i=0;;i++) {
    const dir=prefix+(i?'-'+i:'');
    try { fs.mkdirSync(dir); return dir; } catch(e) { if(e.code!=='EEXIST') throw e; }
  }
}
export function gate(target, memoryDir) {
  const output = run(process.execPath,[path.join(target,'scripts/memory/memory-check.mjs'),'--repo',target,'--memory-dir',memoryDir]);
  console.log(output); return output.split(/\r?\n/).at(-1);
}
export function install(opts, root = kitRoot) {
  if(Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node >=22 required');
  const started=performance.now(), target=path.resolve(opts.target), engine=path.join(target,'scripts/memory');
  const receiptFile=path.join(engine,'KIT.json');
  if(fs.existsSync(receiptFile)) throw new Error(`already installed (kit ${readJSON(receiptFile).version}); run scripts/upgrade.mjs`);
  const settingsFile=path.join(target,'.claude/settings.json');
  // Parse every existing JSON needed by installation before the first write.
  const settings = fs.existsSync(settingsFile) ? readJSON(settingsFile) : {};
  if(!settings || typeof settings!=='object' || Array.isArray(settings)) throw new Error('settings.json must be an object');
  const configFile=path.join(engine,'memory.config.json');
  const projectConfig=readJSON(fs.existsSync(configFile)?configFile:path.join(root,'engine/memory.config.json'));
  const writeBrainIndex=fs.existsSync(path.join(target,'brain/00-system/')) && projectConfig.caps?.brainIndex;
  const memory=resolveMemory(target,opts['memory-dir']), version=fs.readFileSync(path.join(root,'VERSION'),'utf8').trim();
  const session=readJSON(path.join(root,'templates/settings.sessionstart.json')).hooks.SessionStart[0];
  settings.hooks ??= {};
  if(typeof settings.hooks!=='object' || Array.isArray(settings.hooks)) throw new Error('settings.json hooks must be an object');
  settings.hooks.SessionStart ??= [];
  if(!Array.isArray(settings.hooks.SessionStart)) throw new Error('hooks.SessionStart must be an array');
  const addHook=!settings.hooks.SessionStart.some(e=>e?.hooks?.some(h=>h?.command===session.hooks[0].command));
  if(addHook) settings.hooks.SessionStart.push(session);
  const receipt={version,source:'memory-ladder-kit',installedAt:new Date().toISOString()};
  const planned = ownedFiles(root).map(f=>[path.join(target,installedPath(f)),fs.readFileSync(path.join(root,f))]);
  planned.push([path.join(engine,'MANIFEST.json'),Buffer.from(JSON.stringify(installedManifest(root),null,2)+'\n')]);
  const conflicts=planned.filter(([file,data])=>fs.existsSync(file)&&(!fs.statSync(file).isFile()||!fs.readFileSync(file).equals(data)));
  if(conflicts.length&&!opts.backup) throw new Error('kit-owned destinations differ; use --backup:\n'+conflicts.map(([f])=>path.relative(target,f)).join('\n'));
  if(conflicts.some(([file])=>!fs.statSync(file).isFile())) throw new Error('kit-owned destination is not a file');
  for(const file of ['memory.config.json','recall-probes.json']) if(!fs.existsSync(path.join(engine,file))) planned.push([path.join(engine,file),fs.readFileSync(path.join(root,'engine',file))]);
  if(memory.custom) planned.push([path.join(engine,'KIT.local.json'),JSON.stringify({memoryDir:memory.dir},null,2)+'\n']);
  const ignoreFile=path.join(engine,'.gitignore');
  const ignored=fs.existsSync(ignoreFile)?fs.readFileSync(ignoreFile,'utf8'):'';
  if(withIgnores(ignored)!==ignored) planned.push([ignoreFile,withIgnores(ignored)]);
  const freshMemory=!fs.existsSync(path.join(memory.dir,'MEMORY.md'));
  if(freshMemory) for(const file of ['MEMORY.md','current-state.md']) {
    if(!fs.existsSync(path.join(memory.dir,file))) planned.push([path.join(memory.dir,file),fs.readFileSync(path.join(root,'templates',file))]);
  }
  const claudeFile=path.join(target,'CLAUDE.md');
  const agentsFile=!fs.existsSync(path.join(target,'AGENTS.md'))&&fs.existsSync(claudeFile)?claudeFile:path.join(target,'AGENTS.md'), agents=fs.existsSync(agentsFile)?fs.readFileSync(agentsFile,'utf8'):'';
  if(!/^## Memory gate/m.test(agents)) planned.push([agentsFile,agents+(agents.endsWith('\n')?'\n':'\n\n')+fs.readFileSync(path.join(root,'templates/AGENTS-memory-gate.md'),'utf8')]);
  if(!fs.existsSync(path.join(target,'CLAUDE.md'))) planned.push([path.join(target,'CLAUDE.md'),'@AGENTS.md\n']);
  if(addHook) planned.push([settingsFile,JSON.stringify(settings,null,2)+'\n']);
  const newRepo=!fs.existsSync(path.join(memory.dir,'.git'));
  if(opts['dry-run']) {
    for(const [file] of planned) console.log('WRITE '+file);
    console.log('WRITE '+receiptFile+' after baseline succeeds');
    for(const [file] of conflicts) console.log('BACKUP '+file);
    console.log('RATCHET missing index pins in '+configFile);
    console.log('HOOK '+path.join(memory.dir,'.git/hooks/pre-commit')+' (preserve foreign hook; honor core.hooksPath)');
    if(newRepo) console.log('INIT and baseline commit '+memory.dir);
    if(writeBrainIndex) console.log('DRY brain index');
    console.log('GATE '+target); return;
  }
  if(conflicts.length) {
    const backup=backupDirectory(engine);
    writeJSON(path.join(backup,'restore.json'),{files:conflicts.map(([file])=>({file:path.relative(target,file).split(path.sep).join('/'),existed:true}))});
    for(const [file] of conflicts) {
      const dest=path.join(backup,path.relative(target,file));fs.mkdirSync(path.dirname(dest),{recursive:true});fs.renameSync(file,dest);
    }
    console.log('install backup: '+backup);
  }
  for(const [file,data] of planned) write(file,data);
  fs.mkdirSync(memory.dir,{recursive:true});
  if(newRepo) run('git',['-C',memory.dir,'init']);
  const needsBaseline=spawnSync('git',['-C',memory.dir,'rev-parse','--verify','HEAD'],{encoding:'utf8'}).status!==0;
  const config=readJSON(configFile);
  if(freshMemory) {
    writeMemoryIndex({memoryDir:memory.dir,config});
  }
  {
    const ignore=path.join(memory.dir,'.gitignore'),text=fs.existsSync(ignore)?fs.readFileSync(ignore,'utf8'):'';
    if(!text.split(/\r?\n/).includes('.memory.lock*')) write(ignore,text+(text&&!text.endsWith('\n')?'\n':'')+'.memory.lock*\n');
  }
  const indexes=fs.readdirSync(memory.dir).filter(f=>/^INDEX-.*\.md$/i.test(f)&&!isGenerated(fs.readFileSync(path.join(memory.dir,f),'utf8')));
  if(indexes.some(f=>!Object.keys(config.pins||{}).some(k=>k.toLowerCase()===f.toLowerCase()))) {
    if(!config.pins) { config.pins={};writeJSON(configFile,config); }
    run(process.execPath,[path.join(engine,'memory-check.mjs'),'--repo',target,'--memory-dir',memory.dir,'--ratchet-pins']);
  }
  if(needsBaseline) {
    let identity=[];
    try { run('git',['-C',memory.dir,'var','GIT_AUTHOR_IDENT']); }
    catch { identity=['-c','user.name=memory-ladder-kit','-c','user.email=kit@localhost']; console.log('No git identity; baseline uses memory-ladder-kit <kit@localhost> for this commit only'); }
    run('git',['-C',memory.dir,'add','.']);
    run('git',['-C',memory.dir,...identity,'commit','-m','Baseline memory']);
  }
  writeJSON(receiptFile,receipt);
  const hook=spawnSync(process.execPath,[path.join(engine,'install-hooks.mjs'),'--memory-dir',memory.dir,'--repo',target],{encoding:'utf8'});
  if(hook.error || (hook.status!==0 && !hook.stdout.includes('foreign pre-commit'))) throw new Error(hook.error?.message || hook.stdout+hook.stderr);
  console.log(hook.stdout.trim());
  if(writeBrainIndex) {
    run(process.execPath,[path.join(engine,'brain-index.mjs'),'--write','--repo',target]);
    console.log('install: brain index written');
  }
  console.log('install wall time: '+Math.round(performance.now()-started)+' ms');
  return gate(target,memory.dir);
}
if(isDirect(import.meta.url)) {
  try {
    const opts=options(process.argv.slice(2));
    if(opts.help) console.log(usage('install'));
    else install(opts);
  } catch(e) { console.error('install: '+e.message); process.exitCode=1; }
}
