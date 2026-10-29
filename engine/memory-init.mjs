import fs from 'node:fs';
import path from 'node:path';
import {isDirect,toolDir,inRepoMemory,parseFrontmatter,slash,repoRoot,pathKey} from './lib.mjs';
import {resolveMemory,readJSON,write,freshMemoryWrites,finishMemory,run,memoryHook} from './memory-setup.mjs';
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

export function main(argv=process.argv.slice(2)) {
  try {
    if(Number(process.versions.node.split('.')[0])<22) throw new Error('Node >=22 required');
    const target=repoRoot(),engine=path.join(target,'scripts/memory');
    if(!fs.existsSync(path.join(engine,'KIT.json'))) throw new Error('kit not installed; run node <KIT>/scripts/install.mjs --target .');
    let requested,dry=false;
    for(let i=0;i<argv.length;i++) {
      if(argv[i]==='--dry-run') dry=true;
      else if(argv[i]==='--memory-dir' && argv[i+1] && !argv[i+1].startsWith('--')) requested=argv[++i];
      else throw new Error('Unknown or incomplete option '+argv[i]);
    }
    const memory=resolveMemory(target,requested);
    console.log(`memory: ${memory.dir} (${memory.source})`);
    let memoryPathExists=false;
    try { fs.lstatSync(memory.dir); memoryPathExists=true; }
    catch(error) {
      if(error?.code!=='ENOENT') throw error;
    }
    if(memoryPathExists && !fs.existsSync(memory.dir)) throw new Error(`memory path exists but is not a usable folder: ${memory.dir}`);
    let memoryDirState='missing';
    if(fs.existsSync(memory.dir)) {
      if(!fs.statSync(memory.dir).isDirectory()) throw new Error(`memory path exists but is not a usable folder: ${memory.dir}`);
      if(fs.existsSync(path.join(memory.dir,'MEMORY.md'))) {
        console.log('memory already exists: '+memory.dir);return 0;
      }
      if(fs.readdirSync(memory.dir).length===0) memoryDirState='existing-empty';
      else throw new Error(`memory folder exists, is not empty and has no MEMORY.md: ${memory.dir}; nothing was changed. Move its files somewhere else, or choose another folder with --memory-dir`);
    }
    const configFile=path.join(engine,'memory.config.json'),config=readJSON(configFile);
    const planned=freshMemoryWrites(memory.dir,path.join(toolDir,'templates'));
    const inRepo=inRepoMemory(target,memory.dir);
    if(memory.custom && !inRepo && config.memory?.inRepoDir!==undefined) {
      throw new Error('memory.config.json names an in-repo memory folder (memory.inRepoDir); remove that setting or use --memory-dir <that folder>');
    }
    const localFile=path.join(engine,'KIT.local.json');
    const localBeforeExists=fs.existsSync(localFile);
    const localBefore=localBeforeExists?fs.readFileSync(localFile):null;
    const local=localBeforeExists?readJSON(localFile):{};
    if(memory.custom && !inRepo && local.memoryDir && pathKey(local.memoryDir)!==pathKey(memory.dir)) {
      throw new Error('existing KIT.local.json differs; resolve its memoryDir before install');
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
    if(dry) {
      if(memoryDirState==='missing') console.log('MKDIR '+memory.dir);
      for(const [file] of planned) console.log('WRITE '+file);
      for(const [file] of persistWrites) console.log('WRITE '+file);
      if(!inRepo) console.log('INIT '+path.join(memory.dir,'.git')+' (Git metadata and sample hooks)');
      const files=planned.map(([file,data])=>({file:path.basename(file),text:String(data),...parseFrontmatter(String(data)),special:path.basename(file)==='MEMORY.md'?'router':null}));
      const index=generateMemoryIndex({memoryDir:memory.dir,config,files});
      for(const file of Object.keys(index.pages)) console.log('WRITE '+path.join(memory.dir,file));
      console.log('WRITE and remove '+path.join(memory.dir,'.memory.lock'));
      console.log('WRITE '+path.join(memory.dir,'.gitignore'));
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
      try {
        for(const [file,data] of persistWrites) write(file,data);
        for(const [file,data] of planned) write(file,data);
        finishMemory({memory,target,engine,configFile,freshMemory:true,newRepo:!inRepo,inRepo});
        const output=run(process.execPath,[path.join(engine,'memory-check.mjs'),'--repo',target,'--memory-dir',memory.dir]);
        console.log(output.split(/\r?\n/).filter(line=>!line.startsWith('memory: ')).join('\n'));
        memoryHook(target,memory);
      } catch(error) {
        const rollbackProblems=[];
        try { fs.writeFileSync(configFile,configBefore); }
        catch(restoreError) { rollbackProblems.push(`could not restore ${configFile}: ${restoreError.message}`); }
        try {
          if(!localBeforeExists) fs.rmSync(localFile,{force:true});
          else fs.writeFileSync(localFile,localBefore);
        } catch(restoreError) { rollbackProblems.push(`could not restore ${localFile}: ${restoreError.message}`); }
        if(memoryDirState==='existing-empty') {
          try {
            for(const entry of fs.readdirSync(memory.dir)) fs.rmSync(path.join(memory.dir,entry),{recursive:true,force:true});
          } catch(removeError) {
            rollbackProblems.push(`could not clean ${memory.dir}: ${removeError.message}`);
          }
        } else {
          try { fs.rmSync(createdTop,{recursive:true,force:true}); }
          catch(removeError) { rollbackProblems.push(`could not remove ${createdTop}: ${removeError.message}`); }
        }
        if(rollbackProblems.length===0) {
          error.message+='\nmemory-init rolled back its changes; fix the problem above and run it again.';
        } else {
          error.message+='\nmemory-init rollback could not complete: '+rollbackProblems.join('; ');
        }
        throw error;
      }
    }
    if(!inRepo) {
      console.log(`next: git -C "${memory.dir}" remote add origin <PRIVATE_REMOTE>`);
      console.log(`next: git -C "${memory.dir}" push -u origin HEAD`);
    }
    return 0;
  } catch(error) {console.error('memory-init: '+error.message);return 1;}
}
if(isDirect(import.meta.url)) process.exitCode=main();
