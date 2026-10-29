import fs from 'node:fs';
import path from 'node:path';
import {isDirect,toolDir,inRepoMemory,parseFrontmatter,slash,repoRoot,pathKey} from './lib.mjs';
import {resolveMemory,readJSON,write,freshMemoryWrites,finishMemory,run,memoryHook} from './memory-setup.mjs';
import {shellQuoted} from './install-hooks.mjs';
import {generateMemoryIndex} from './memory-index.mjs';

function pathExistsNoFollow(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch(error) {
    if(error?.code==='ENOENT') return false;
    throw error;
  }
}

export function planInit({memoryDir, planned, config, inRepo}) {
  const files=planned.map(([file,data])=>({file:path.basename(file),text:String(data),...parseFrontmatter(String(data)),special:path.basename(file)==='MEMORY.md'?'router':null}));
  const index=generateMemoryIndex({memoryDir,config,files});
  const entries=[...planned.map(([file])=>({file,action:'WRITE '})),
    ...Object.keys(index.pages).map(file=>({file:path.join(memoryDir,file),action:'WRITE '})),
    {file:path.join(memoryDir,'.memory.lock'),action:'WRITE and remove '},
    {file:path.join(memoryDir,'.gitignore'),action:'WRITE '}];
  if(!inRepo) entries.push({file:path.join(memoryDir,'.git'),action:'INIT ',recursive:true,suffix:' (Git metadata and sample hooks)'});
  const owned=new Set(entries.map(({file})=>path.relative(memoryDir,file).split(path.sep)[0]));
  return {entries,owned};
}

export function rollbackInit({memoryDir,owned,state,createdTop,configFile,configBefore,localFile,localBeforeExists,localBefore,persistWrites=[],entries=[]}) {
  const problems=[],left=[];
  const written = new Set(persistWrites.map(([file])=>file));
  try { if(written.has(configFile) && (!fs.existsSync(configFile) || !fs.readFileSync(configFile).equals(configBefore))) fs.writeFileSync(configFile,configBefore); }
  catch(error) { problems.push(`could not restore ${configFile}: ${error.message}`); }
  try {
    if(written.has(localFile)) {
      if(localBeforeExists) fs.writeFileSync(localFile,localBefore);
      else fs.rmSync(localFile,{force:true});
    }
  } catch(error) { problems.push(`could not restore ${localFile}: ${error.message}`); }
  for(const name of owned) {
    if(typeof name!=='string' || !name || name==='.' || name==='..' || path.isAbsolute(name) || path.win32.parse(name).root || /[\\/]/.test(name)) { problems.push(`invalid owned name: ${name}`); continue; }
    const file=path.join(memoryDir,name);
    try { fs.rmSync(file,{recursive:entries.some(entry=>entry.file===file && entry.recursive===true),force:true}); }
    catch(error) { problems.push(`could not remove ${file}: ${error.message}`); }
  }
  const remaining=folder=>{
    try { return fs.readdirSync(folder).map(name=>path.join(folder,name)); }
    catch(error) {
      if(error.code!=='ENOENT') problems.push(`could not inspect ${folder}: ${error.message}`);
      return [];
    }
  };
  left.push(...remaining(memoryDir));
  if(state==='missing') {
    for(let folder=path.resolve(memoryDir);;) {
      try { fs.rmdirSync(folder); }
      catch(error) {
        if(error.code==='ENOTEMPTY'||error.code==='EEXIST') { left.push(...remaining(folder)); break; }
        if(error.code!=='ENOENT') { problems.push(`could not remove ${folder}: ${error.message}`); break; }
      }
      if(folder===path.resolve(createdTop)) break;
      const parent=path.dirname(folder);
      if(parent===folder) break;
      folder=parent;
    }
  }
  return {left:[...new Set(left)],problems};
}

export function main(argv=process.argv.slice(2)) {
  try {
    if(Number(process.versions.node.split('.')[0])<22) throw new Error('Install Node.js 22 or newer, then run this command again.');
    const target=repoRoot(),engine=path.join(target,'scripts/memory');
    if(!fs.existsSync(path.join(engine,'KIT.json'))) throw new Error('Install the memory kit in this project first; replace KIT_FOLDER with your downloaded kit folder:\nnode "KIT_FOLDER/scripts/install.mjs" --target .');
    let requested,dry=false;
    for(let i=0;i<argv.length;i++) {
      if(argv[i]==='--dry-run') dry=true;
      else if(argv[i]==='--memory-dir' && argv[i+1] && !argv[i+1].startsWith('--')) requested=argv[++i];
      else throw new Error('Unknown or incomplete option '+argv[i]+'. Use --dry-run or --memory-dir followed by a quoted folder path.');
    }
    const memory=resolveMemory(target,requested);
    console.log(`memory: ${memory.dir} (${memory.source})`);
    let memoryPathExists=false;
    try { fs.lstatSync(memory.dir); memoryPathExists=true; }
    catch(error) {
      if(error?.code!=='ENOENT') throw error;
    }
    if(memoryPathExists && !fs.existsSync(memory.dir)) throw new Error(`This path is a file or broken link: ${memory.dir}. Choose another notes folder with --memory-dir followed by a quoted folder path, or repair the link and retry.`);
    let memoryDirState='missing';
    if(fs.existsSync(memory.dir)) {
      if(!fs.statSync(memory.dir).isDirectory()) throw new Error(`This path is a file or broken link: ${memory.dir}. Choose another notes folder with --memory-dir followed by a quoted folder path, or repair the link and retry.`);
      if(fs.existsSync(path.join(memory.dir,'MEMORY.md'))) {
        console.log('memory already exists: '+memory.dir+'. Nothing was changed. To check it, run node scripts/memory/memory-check.mjs');
        return 0;
      }
      if(fs.readdirSync(memory.dir).length===0) memoryDirState='existing-empty';
      else throw new Error(`memory folder exists, is not empty and has no MEMORY.md: ${memory.dir}; nothing was changed. Move its files somewhere else, or choose another folder with --memory-dir`);
    }
    if(dry) console.log('Preview only: no files will be changed.');
    const configFile=path.join(engine,'memory.config.json'),config=readJSON(configFile);
    const planned=freshMemoryWrites(memory.dir,path.join(toolDir,'templates'));
    const inRepo=inRepoMemory(target,memory.dir);
    if(memory.custom && !inRepo && config.memory?.inRepoDir!==undefined) {
      throw new Error(`memory.config.json names an in-repo memory folder: ${path.resolve(target,config.memory.inRepoDir)}, but you requested ${memory.dir}. Use the configured folder or remove memory.inRepoDir from scripts/memory/memory.config.json before retrying.`);
    }
    const localFile=path.join(engine,'KIT.local.json');
    const localBeforeExists=fs.existsSync(localFile);
    const localBefore=localBeforeExists?fs.readFileSync(localFile):null;
    const local=localBeforeExists?readJSON(localFile):{};
    if(memory.custom && !inRepo && local.memoryDir && pathKey(local.memoryDir)!==pathKey(memory.dir)) {
      throw new Error(`The saved notes folder in KIT.local.json is ${local.memoryDir}, but you requested ${memory.dir}. Use the saved folder or update memoryDir in scripts/memory/KIT.local.json before retrying.`);
    }
    const configBefore=fs.readFileSync(configFile);
    const configNext=structuredClone(config);
    const localNext=structuredClone(local);
    const persistWrites=[];
    if(inRepo) {
      configNext.memory ??= {};
      configNext.memory.inRepoDir=slash(path.relative(target,memory.dir));
      if(JSON.stringify(configNext)!==JSON.stringify(config)) persistWrites.push([configFile,JSON.stringify(configNext,null,2)+'\n']);
    } else if(memory.custom) {
      localNext.memoryDir=memory.dir;
      if(JSON.stringify(localNext)!==JSON.stringify(local)) persistWrites.push([localFile,JSON.stringify(localNext,null,2)+'\n']);
    }
    const {entries,owned}=planInit({memoryDir:memory.dir,planned,config:configNext,inRepo});
    if(dry) {
      if(memoryDirState==='missing') console.log('MKDIR '+memory.dir);
      for(const {file,action,suffix=''} of entries) console.log(action+file+suffix);
      for(const [file] of persistWrites) console.log('WRITE '+file);
      if(!inRepo) console.log('WRITE Git index and baseline commit in '+path.join(memory.dir,'.git'));
      console.log('GATE '+target+' (dry-run; not executed)');
      console.log('HOOK '+path.join(inRepo?target:memory.dir,'.git/hooks/pre-commit')+' (preserve foreign hook; honor core.hooksPath)');
    } else {
      let createdTop=path.resolve(memory.dir);
      if(memoryDirState==='missing') {
        while(!pathExistsNoFollow(createdTop)) {
          const parent=path.dirname(createdTop);
          if(parent===createdTop) break;
          if(pathExistsNoFollow(parent)) break;
          createdTop=parent;
        }
      }
      const completedPersistWrites=[];
      try {
        for(const [file,data] of persistWrites) { write(file,data); completedPersistWrites.push([file,data]); }
        for(const [file,data] of planned) write(file,data);
        finishMemory({memory,target,engine,configFile,freshMemory:true,newRepo:!inRepo,inRepo});
        const output=run(process.execPath,[path.join(engine,'memory-check.mjs'),'--repo',target,'--memory-dir',memory.dir]);
        console.log(output.split(/\r?\n/).filter(line=>!line.startsWith('memory: ')).join('\n'));
        memoryHook(target,memory);
      } catch(error) {
        const {left,problems}=rollbackInit({memoryDir:memory.dir,owned,state:memoryDirState,createdTop,configFile,configBefore,localFile,localBeforeExists,localBefore,persistWrites:completedPersistWrites,entries});
        if(problems.length) error.message+='\nmemory-init rollback could not complete: '+problems.join('; ')+(left.length?'; left in place: '+left.join(', '):'');
        else if(left.length) error.message+='\nmemory-init rolled back what it created; these entries were left in place: '+left.join(', ')+'. Review them before you run it again.';
        else error.message+='\nmemory-init rolled back its changes; fix the problem above and run it again.';
        throw error;
      }
    }
    if(dry) console.log('If you have no backup to restore, run again without --dry-run to create your notes.');
    else if(!inRepo) {
      console.log('Optional: create a private repository on GitHub, then replace PRIVATE_REMOTE_URL in the first command with its address:');
      console.log(`next: git -C ${shellQuoted(memory.dir)} remote add origin PRIVATE_REMOTE_URL`);
      console.log(`next: git -C ${shellQuoted(memory.dir)} push -u origin HEAD`);
    } else console.log('Review and commit the new notes with your project.');
    return 0;
  } catch(error) {console.error('memory-init: '+error.message);return 1;}
}
if(isDirect(import.meta.url)) process.exitCode=main();
