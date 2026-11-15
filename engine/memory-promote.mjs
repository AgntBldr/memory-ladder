import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {memoryFiles, parseFrontmatter, loadConfig, requireMemory, walkMd, read, atomicWrite, cleanGitEnv, removeQuietly} from './lib.mjs';
import {KINDS, lessonIdentity, routes, routerFamilies, isGenerated, writeMemoryIndex} from './memory-index.mjs';
import {spliceMetadata} from './memory-lesson.mjs';
import {scanChains} from './memory-chains.mjs';
import {writerClaim} from './memory-session.mjs';
import {withMemoryLock, isLockName, isLockPath} from './memory-lock.mjs';
import {runCheck} from './memory-check.mjs';
import {buildCorpus, loadProbes, runProbes} from './memory-recall.mjs';
import {validDate} from './memory-rotate.mjs';

const body = text => /^(?:\uFEFF)?---[^\S\r\n]*\r?\n/.test(text) ? text.replace(/^(?:\uFEFF)?---[^\S\r\n]*\r?\n[\s\S]*?^---[^\S\r\n]*(?:\r?\n|$)/m, '') : text;
const sha = text => createHash('sha256').update(text).digest('hex');
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const mdFiles = dir => walkMd(dir, {skipDirs:['.git','node_modules']}).map(f=>path.join(dir,f));
const escaped = s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const within = (root,file) => {const rel=path.relative(root,file);return rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};

// Only metadata.source is exempt; a different object's source is ordinary text.
function transformText(text, transform) {
  const originalBody = body(text), front = text.slice(0,text.length-originalBody.length);
  let metadata=false,indent=null,source=false;
  return front.split(/(?<=\n)/).map(line=> {
    if(/^metadata:\s*(?:#.*)?$/.test(line.trimEnd())) {metadata=true;indent=null;source=false;}
    else if(/^\S/.test(line)) {metadata=false;source=false;}
    const child=/^([ \t]+)([\w.-]+):/.exec(line);
    if(metadata&&child) {
      indent??=child[1].length;
      if(child[1].length===indent) source=child[2]==='source';
    }
    return metadata&&source?line:transform(line);
  }).join('') + transform(originalBody);
}
function rewrite(text, rows, {frontmatter=true}={}) {
  let count=0;
  if(!rows.length) return {next:text,count};
  const targets=new Map(rows.map(r=>[r.old,r.new]));
  // Extensionless wiki targets and exact filename tokens share one pass. Markdown
  // destinations, code spans and prose therefore have identical boundaries.
  const pattern=new RegExp(`\\[\\[(${rows.map(r=>escaped(r.old.slice(0,-3))).join('|')})(?=\\||\\]\\])|(?<![\\w.-])(${rows.map(r=>escaped(r.old)).join('|')})(?![\\w.-])`,'g');
  const replace=value=>value.replace(pattern,(match,stem,file)=> {
    count++;
    return stem===undefined?targets.get(file):'[['+targets.get(stem+'.md').slice(0,-3);
  });
  const next=frontmatter?transformText(text,replace):replace(text);
  return {next,count};
}
function rewriteJson(text, rows) {
  const names=new Map(rows.map(r=>[r.old,r.new])); let count=0;
  JSON.parse(text); // Do not repair invalid JSON silently.
  const next=text.replace(/"(?:[^"\\]|\\.)*"/g,(token,offset)=> {
    if(/^\s*:/.test(text.slice(offset+token.length))) return token;
    const value=JSON.parse(token);
    if(!names.has(value)) return token;
    count++; return JSON.stringify(names.get(value));
  });
  return {next,count};
}
const remaining = (text,rows) => rewrite(text,rows).count;
export function promotionDate(file,memoryDir,settings={}) {
  if(settings.date!==undefined) return {date:settings.date,date_source:'map'};
  if(validDate(file.data.metadata?.date)) return {date:file.data.metadata.date,date_source:'metadata.date'};
  let fence=null,lines=0;
  for(const line of body(file.text).split(/\r?\n/)) {
    const mark=/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if(fence) {if(mark&&mark[1][0]===fence[0]&&mark[1].length>=fence.length&&!mark[2].trim()) fence=null;continue;}
    if(mark) {fence=mark[1];continue;}
    if(!line.trim()) continue;
    if(++lines>10) break;
    const date=[...line.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(m=>m[0]).find(validDate);
    if(date) return {date,date_source:'body'};
  }
  try {
    const dates=execFileSync('git',['--no-optional-locks','-C',memoryDir,'log','--follow','--format=%aI','--',file.file],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,windowsHide:true,env:cleanGitEnv()}).trim().split(/\r?\n/);
    const date=dates.at(-1)?.slice(0,10);
    if(validDate(date)) return {date,date_source:'git'};
  } catch { /* An untracked note has no trustworthy fallback date. */ }
  const modified=typeof file.data.metadata?.modified==='string' ? file.data.metadata.modified.slice(0,10) : '';
  if(validDate(modified)) return {date:modified,date_source:'modified'};
  return null;
}
function promotedText(file,row,settings) {
  const originalBody=body(file.text), eol=file.text.match(/\r?\n/)?.[0]??'\n';
  let front=file.text.slice(0,file.text.length-originalBody.length);
  if(!front) front='---\n---\n';
  front=front.replace(/\r\n/g,'\n');
  const name=row.new.slice(0,-3);
  if(/^name:/m.test(front)) {
    // Remove a block-valued name as a whole, retaining all following siblings.
    front=front.replace(/^name:[^\n]*(?:\n(?:[ \t]+[^\n]*|[ \t]*)(?=\n))*\n/m,`name: ${JSON.stringify(name)}\n`);
  } else front=front.replace(/^(\uFEFF)?---[^\n]*\n/,`$&name: ${JSON.stringify(name)}\n`);
  const values={kind:settings.kind,lesson:row.number,source:row.old};
  if(row.date_source==='map'||!validDate(file.data.metadata?.date)) values.date=row.date;
  for(const field of ['route','trigger','pin']) if(Object.hasOwn(settings,field)) values[field]=settings[field];
  if(Object.hasOwn(settings,'case')) values.kind_case=settings.case;
  for(const [field,value] of Object.entries(values)) front=spliceMetadata(front,field,value);
  const after=parseFrontmatter(front).data;
  for(const [field,value] of Object.entries(file.data)) {
    if(field==='name'||field==='__warnings') continue;
    if(field==='metadata') {
      for(const [nested,prior] of Object.entries(value??{})) if(!Object.hasOwn(values,nested)&&!isDeepStrictEqual(after.metadata?.[nested],prior)) throw Error('frontmatter preservation proof failed: '+nested);
    } else if(!isDeepStrictEqual(after[field],value)) throw Error('frontmatter preservation proof failed: '+field);
  }
  if(after.name!==name) throw Error('frontmatter name proof failed');
  return front.replaceAll('\n',eol)+originalBody;
}
function gateFails(result) {
  return result.findings.filter(f=>f.severity==='FAIL'&&!f.allowed).map(({check,file,message})=>({check,file,message}));
}
const failedProof = p => p.bodies.some(b=>b.expected!==b.after||!b.reversible)||p.remainingReferences||p.recall.regressions.length||p.gate.newFails.length||(p.external_references??[]).some(hit=>!hit.protected);
function proof({rows,beforeBodies,beforeRecall,beforeGate,readFile,markdown,jsonFiles,checkOptions,check,probesFile,config,repo,memoryDir}) {
  const inverse=rows.map(row=>({old:row.new,new:row.old}));
  const bodies=rows.map(row=> {
    const bytes=fs.readFileSync(path.join(memoryDir,row.new)),text=bytes.toString('utf8'),written=body(text);
    const writtenBytes=bytes.subarray(Buffer.byteLength(text.slice(0,text.length-written.length)));
    const reversed=rewrite(written,inverse,{frontmatter:false}).next;
    return {old:row.old,new:row.new,before:row.sha256_body,expected:row.sha256_expected,after:sha(writtenBytes),reversed:sha(reversed),reversible:Buffer.from(written).equals(writtenBytes)&&Buffer.from(reversed).equals(Buffer.from(beforeBodies.get(row.old)))};
  });
  const afterRecall=probesFile ? runProbes({corpus:buildCorpus({memoryDir,repo,config}),probes:JSON.parse(readFile(probesFile))}) : [];
  const regressions=beforeRecall.filter((p,i)=>p.pass&&!(afterRecall[i]?.id===p.id&&afterRecall[i].pass)).map(p=>p.id);
  const afterGate=gateFails(check({...checkOptions,config}));
  const rename=new Map(rows.map(r=>[r.old,r.new]));
  const canonical=f=>JSON.stringify({...f,file:rename.get(f.file)??f.file,message:rows.reduce((s,r)=>s.replaceAll(r.old,r.new),f.message??'')});
  const prior=new Set(beforeGate.map(canonical));
  const newFails=afterGate.filter(f=>!prior.has(canonical(f)));
  let remainingReferences=0;
  for(const file of markdown) {
    const text=readFile(file),data=parseFrontmatter(text).data;
    if(data.moved_to!==undefined||data.metadata?.moved_to!==undefined) continue;
    remainingReferences+=remaining(text,rows);
  }
  for(const file of jsonFiles) remainingReferences+=rewriteJson(readFile(file),rows).count;
  return {bodies,remainingReferences,recall:{before:beforeRecall,after:afterRecall,regressions},gate:{before:beforeGate,after:afterGate,newFails}};
}

function stageInputs({repo,memoryDir,also,jsonFiles,config,temp,staged}) {
  const copied=new Map(),brain=repo?path.resolve(repo,config.brain?.dir??'brain'):null;
  const copy=file=> {
    const stat=fs.lstatSync(file);
    if(!stat.isFile()) return;
    fs.mkdirSync(path.dirname(staged(file)),{recursive:true});
    fs.copyFileSync(file,staged(file));copied.set(key(file),stat.size);
  };
  const tree=(root,repoMode=false)=> {
    const walk=dir=> {
      fs.mkdirSync(staged(dir),{recursive:true});
      for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
        const source=path.join(dir,entry.name);
        if(key(source)===key(temp)||entry.isSymbolicLink()||isLockName(entry.name)) continue;
        if(entry.isDirectory()) {
          if(repoMode) {
            if(entry.name==='.git'||entry.name==='node_modules'||fs.existsSync(path.join(source,'.git'))) continue;
          } else if(['.git','node_modules'].includes(entry.name)&&!(brain&&within(brain,source))) continue;
          walk(source);
        } else if(entry.isFile()) copy(source);
      }
    };
    walk(root);
  };
  if(repo) {
    const gitArgs=['--no-optional-locks','-C',repo],options={encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000,windowsHide:true,maxBuffer:32*1024*1024,env:cleanGitEnv()};
    let tracked=false;
    try {tracked=execFileSync('git',[...gitArgs,'rev-parse','--is-inside-work-tree'],options).trim()==='true';} catch { /* A non-git repository uses the bounded tree walk. */ }
    if(tracked) {
      fs.mkdirSync(staged(repo),{recursive:true});
      const files=execFileSync('git',[...gitArgs,'ls-files','-z'],options).split('\0').filter(Boolean);
      for(const file of files) {
        const source=path.resolve(repo,file);
        if(!within(repo,source)||!fs.existsSync(source)) continue;
        // The memory walk skips every lock name; a lock file that git tracks (force-added) inside memory is skipped by the
        // same rule, on its memory-relative path. A project file outside memory is ordinary whatever its name starts with.
        if(within(memoryDir,source)&&isLockPath(path.relative(memoryDir,source))) continue;
        let parent=source,symlink=false;
        while(key(parent)!==key(repo)) {if(fs.lstatSync(parent).isSymbolicLink()) {symlink=true;break;}parent=path.dirname(parent);}
        if(!symlink) copy(source);
      }
    } else tree(repo,true);
    for(const file of jsonFiles) copy(file);
  }
  // Explicit memory and --also roots may be untracked. Overlay them independently
  // even when the tracked repository is their ancestor; count each input once.
  for(const root of new Set([memoryDir,...also])) tree(root);
  return {files:copied.size,bytes:[...copied.values()].reduce((sum,n)=>sum+n,0)};
}

function externalReferences(roots,rows,protectedFiles,readFile=read) {
  const hits=[],seen=new Set();
  function visit(file) {
    const absolute=path.resolve(file),id=key(absolute);
    if(seen.has(id)) return;seen.add(id);
    if(!fs.existsSync(absolute)) return;
    const stat=fs.lstatSync(absolute);if(stat.isSymbolicLink()) return;
    if(stat.isDirectory()) {
      for(const name of fs.readdirSync(absolute).sort()) if(!['.git','node_modules'].includes(name)) visit(path.join(absolute,name));
      return;
    }
    if(!stat.isFile() || /^promote-map-.*\.json$/.test(path.basename(absolute))) return;
    const text=readFile(absolute);if(text===null || text.includes('\0')) return;
    // Mask source provenance while retaining line numbers for diagnostics.
    const searchable=transformText(text,value=>value.replace(/[^\n]/g,'\0'));
    const lines=text.split(/\r?\n/),mask=searchable.split(/\r?\n/);
    for(let i=0;i<lines.length;i++) {
      if(mask[i]===lines[i]) continue;
      for(const row of rows) if(remaining(lines[i],[row])) hits.push({file:absolute.replaceAll('\\','/'),line:i+1,old:row.old,protected:protectedFiles.has(row.old)});
    }
  }
  for(const root of roots) visit(root);
  return hits;
}

export function promoteTopics({memoryDir,repo,map,also=[],scan=[],protect,stubs=false,write=false,lock,check=runCheck,afterWrite=()=>{}}={}) {
  requireMemory(memoryDir);
  memoryDir=path.resolve(memoryDir); repo=repo?path.resolve(repo):undefined; also=also.map(dir=>path.resolve(dir));
  if(!map) throw Error('promote requires --map MAP.json');
  const spec=JSON.parse(fs.readFileSync(map,'utf8'));
  if(spec.version!==1||!plain(spec.promote)) throw Error('invalid promote map: expected version 1 and promote object');
  for(const [file,settings] of Object.entries(spec.promote)) {
    if(!/^[^/\\\x00-\x1f]+\.md$/.test(file)||file==='..'||!plain(settings)) throw Error('invalid promote map row: '+file);
    if(settings.slug!==undefined&&!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(settings.slug)) throw Error('invalid promote slug: '+file);
    if(settings.pin!==undefined&&typeof settings.pin!=='boolean') throw Error('invalid promote pin: '+file);
    if(Object.hasOwn(settings,'date')&&!validDate(settings.date)) throw Error('invalid promote date: '+file+'; expected YYYY-MM-DD');
    if(settings.trigger!==undefined&&(typeof settings.trigger!=='string'||!settings.trigger.trim()||/[\r\n]/.test(settings.trigger))) throw Error('invalid promote trigger: '+file);
  }
  for(const dir of also) requireMemory(dir);
  const run=token=> {
    const files=memoryFiles(memoryDir),byName=new Map(files.map(f=>[f.file,f])),refused=[],skipped=[],rows=[];
    const families=routerFamilies(read(path.join(memoryDir,'MEMORY.md')),memoryDir),chains=scanChains(memoryDir,files);
    const heads=new Set(chains.parts.map(p=>p.parent)),parts=new Set(chains.parts.map(p=>p.file));
    const protectedFiles=new Set(protect?fs.readFileSync(protect,'utf8').split(/\r?\n/).map(s=>s.trim()).filter(Boolean):[]);
    const candidates=[];
    for(const [old,settings] of Object.entries(spec.promote)) {
      const f=byName.get(old); let reason;
      if(files.some(lesson=>lessonIdentity(lesson.file)&&lesson.data.metadata?.source===old&&(!f||(f.stub&&(f.data.moved_to??f.data.metadata?.moved_to)===lesson.file)))) {skipped.push({file:old,reason:'already promoted'});continue;}
      if(!f) reason='missing file';
      else if(lessonIdentity(old)) reason='already a lesson';
      else if(isGenerated(f.text)) reason='generated page';
      else if(f.special||f.stub) reason='special file';
      else if(f.state) reason='state: true';
      else if(f.hardRule) reason='hard-rule file';
      else if(heads.has(old)) reason='chain head';
      else if(parts.has(old)) reason='chain part';
      else if(protectedFiles.has(old)) reason='protected file';
      else if(!KINDS.includes(settings.kind)) reason='invalid kind';
      else {
        const route=Object.hasOwn(settings,'route')?settings.route:routes(f.data);
        if(!Array.isArray(route)||route.some(r=>!families.has(r))) reason='unknown route family';
      }
      const date=reason?null:promotionDate(f,memoryDir,settings);
      if(!reason&&!date) reason='no date';
      if(reason) refused.push({file:old,reason}); else candidates.push({old,settings,f,...date});
    }
    let highest=files.reduce((n,f)=> {const id=lessonIdentity(f.file);return id&&BigInt(id.match(/^\d+/)[0])>n?BigInt(id.match(/^\d+/)[0]):n;},0n);
    candidates.sort((a,b)=>a.date.localeCompare(b.date)||(a.old<b.old?-1:a.old>b.old?1:0));
    const updates=new Map(), originals=new Map(),beforeBodies=new Map();
    for(const c of candidates) {
      if(!Buffer.from(c.f.text).equals(fs.readFileSync(path.join(memoryDir,c.old)))) throw Error('invalid UTF-8 body; promotion proof cannot preserve '+c.old);
      const number=(highest+1n).toString().padStart(3,'0'),name=`lesson-${number}-${c.settings.slug??c.old.slice(0,-3)}.md`;
      if(fs.existsSync(path.join(memoryDir,name))) {refused.push({file:c.old,reason:'target name collision: '+name});continue;}
      const row={old:c.old,new:name,number,date:c.date,date_source:c.date_source,sha256_body:sha(body(c.f.text)),stub:stubs};
      const next=promotedText(c.f,row,c.settings);
      highest++;rows.push(row);beforeBodies.set(c.old,body(c.f.text));
      updates.set(path.join(memoryDir,c.old),null);updates.set(path.join(memoryDir,name),next);
    }
    for(const row of rows) {
      const expected=rewrite(beforeBodies.get(row.old),rows,{frontmatter:false});
      row.sha256_expected=sha(expected.next);row.link_rewrites=expected.count;
    }
    const configFile=repo?path.join(repo,'scripts/memory/memory.config.json'):null;
    const probesFile=repo&&fs.existsSync(path.join(repo,'scripts/memory/recall-probes.json'))?path.join(repo,'scripts/memory/recall-probes.json'):null;
    const config=configFile&&fs.existsSync(configFile)?JSON.parse(read(configFile)):loadConfig();
    const checkOptions={memoryDir,repo,config,noGit:true};
    const beforeGate=gateFails(check(checkOptions));
    const beforeRecall=probesFile?runProbes({memoryDir,repo,config,probes:loadProbes(probesFile)}):[];
    const markdown=[...new Map([memoryDir,...also].flatMap(mdFiles).map(file=>[key(file),file])).values()];
    const jsonFiles=[configFile,probesFile].filter(file=>file&&fs.existsSync(file));
    const links=[];
    for(const file of [...markdown,...jsonFiles]) {
      const renamed=rows.find(r=>key(file)===key(path.join(memoryDir,r.old)));
      const target=renamed?path.join(memoryDir,renamed.new):file;
      const text=updates.get(target)??read(file);
      if(markdown.includes(file)&&isGenerated(text)) continue;
      const {next,count}=jsonFiles.includes(file)?rewriteJson(text,rows):rewrite(text,rows);
      if(count) {updates.set(target,next);links.push({file:path.relative(memoryDir,target).replaceAll('\\','/'),count});}
    }
    const readPlanned=file=>updates.has(file)?updates.get(file):read(file);
    const nextConfig=configFile&&fs.existsSync(configFile)?JSON.parse(readPlanned(configFile)):config;
    const created=new Date().toISOString(),dates={map:0,metadata:0,body:0,git:0,modified:0};
    for(const row of rows) dates[row.date_source==='metadata.date'?'metadata':row.date_source]++;
    const result={version:1,created,written:write&&rows.length>0,rows,refused,skipped,links,dates,rehearsal:{files:0,bytes:0}};
    const scanRoots=[...(repo?['AGENTS.md','CLAUDE.md','scripts','.claude','docs'].map(file=>path.join(repo,file)):[]),...scan];
    const scanRows=[...rows,...skipped.map(row=>({old:row.file,new:row.file})),...refused.filter(row=>protectedFiles.has(row.file)).map(row=>({old:row.file,new:row.file}))];
    const scanProof=(planned=false)=> {
      result.external_references=externalReferences(scanRoots,scanRows,protectedFiles,planned?file=>updates.has(file)?updates.get(file):read(file):read);
      result.proof.external_references=result.external_references;
    };
    if(stubs) for(const row of rows) {
      const f=byName.get(row.old),eol=f.text.match(/\r?\n/)?.[0]??'\n',stem=row.new.slice(0,-3),type=f.data.metadata?.type??f.data.type??'feedback';
      const scalar=value=>/^[a-zA-Z0-9_-]+$/.test(String(value))?String(value):JSON.stringify(value);
      updates.set(path.join(memoryDir,row.old),`---\nname: ${scalar(row.old.slice(0,-3))}\ndescription: "Moved to ${stem} on ${created.slice(0,10)} (numbered lesson)."\nmoved_to: ${row.new}\nmetadata:\n  type: ${scalar(type)}\n---\n\n[Open ${stem}](${row.new})\n`.replaceAll('\n',eol));
    }
    if(!rows.length) {
      result.proof={bodies:[],remainingReferences:0,recall:{before:beforeRecall,after:beforeRecall,regressions:[]},gate:{before:beforeGate,after:beforeGate,newFails:[]}};
      scanProof();
      if(write&&failedProof(result.proof)) {result.preflightFailed=true;throw Object.assign(Error('promote proof failed; original files unchanged'),{report:result});}
      return result;
    }
    {
      // Rehearse against independent copies, preserving relative root topology.
      // Repo staging is tracked-only when possible; explicit small roots overlay it.
      const temp=fs.mkdtempSync(path.join(os.tmpdir(),'memory-promote-'));
      try {
        const staged=file=> {const abs=path.resolve(file),root=path.parse(abs).root;return path.join(temp,Buffer.from(root).toString('hex'),path.relative(root,abs));};
        result.rehearsal=stageInputs({repo,memoryDir,also,jsonFiles,config,temp,staged});
        for(const [file,text] of updates) {
          const dest=staged(file);
          if(text===null) fs.rmSync(dest,{force:true}); else fs.writeFileSync(dest,text);
        }
        const stagedMemory=staged(memoryDir),stagedRepo=repo?staged(repo):undefined;
        const generated=writeMemoryIndex({memoryDir:stagedMemory,config:nextConfig});
        result.proof=proof({rows,beforeBodies,beforeRecall,beforeGate,readFile:read,markdown:[...new Set([memoryDir,...also].flatMap(dir=>mdFiles(staged(dir))))],jsonFiles:jsonFiles.map(staged),checkOptions:{...checkOptions,memoryDir:stagedMemory,repo:stagedRepo},check,probesFile:probesFile?staged(probesFile):null,config:nextConfig,repo:stagedRepo,memoryDir:stagedMemory});
        // Apply exactly the generated bytes that passed the rehearsal proof.
        for(const file of Object.keys(generated.pages)) updates.set(path.join(memoryDir,file),read(path.join(stagedMemory,file)));
        for(const file of generated.removed) updates.set(path.join(memoryDir,file),null);
      } finally {removeQuietly(temp);} // kit 3.3.6 item 9: a removal that fails is noted, never thrown over the proof result
      scanProof(true);
      if(!write) return result;
      if(failedProof(result.proof)) {
        result.written=false;result.preflightFailed=true;
        throw Object.assign(Error('promote proof failed in rehearsal; original files unchanged'),{report:result});
      }
    }
    // Like route conversion, retain literal original bytes and restore every
    // affected file on error. The memory lock spans planning, proof and recovery.
    for(const file of [...markdown,...jsonFiles,...updates.keys()]) if(!originals.has(file)) originals.set(file,fs.existsSync(file)?fs.readFileSync(file):null);
    const stamp=created.replace(/[-:]/g,'').slice(0,15),mapFile=`promote-map-${stamp}.json`;
    const evidence=path.join(memoryDir,mapFile);
    if(fs.existsSync(evidence)) throw Error('promotion evidence collision: '+mapFile);
    originals.set(evidence,null);
    // Kit 3.3.5 E2.4: claim the memory files this promotion creates, edits or deletes (generated pages follow E3.3).
    const inMemory=file=>{const rel=path.relative(memoryDir,file);return rel&&!rel.startsWith('..')&&!path.isAbsolute(rel);};
    const generatedPage=file=>/^INDEX-[^/]*\.md$/.test(file)&&fs.existsSync(path.join(memoryDir,file))&&isGenerated(read(path.join(memoryDir,file)));
    writerClaim({memoryDir,repo,config,lock:token},[...updates.keys(),evidence].filter(inMemory).map(file=>path.relative(memoryDir,file).split(path.sep).join('/')).filter(file=>!generatedPage(file)),'memory-promote');
    try {
      for(const [file,text] of updates) {if(text===null) fs.unlinkSync(file);else atomicWrite(file,text);}
      afterWrite();
      const measuredConfig=configFile&&fs.existsSync(configFile)?JSON.parse(read(configFile)):nextConfig;
      result.proof=proof({rows,beforeBodies,beforeRecall,beforeGate,readFile:read,markdown:[...new Set([memoryDir,...also].flatMap(mdFiles))],jsonFiles,checkOptions,check,probesFile,config:measuredConfig,repo,memoryDir});
      scanProof();
      if(failedProof(result.proof)) throw Object.assign(Error('promote proof failed; restored original files'),{report:result});
      fs.writeFileSync(evidence,JSON.stringify({version:1,created,rows,refused,links},null,2)+'\n',{flag:'wx'});
      result.mapFile=mapFile;
      return result;
    } catch(error) {
      for(const file of mdFiles(memoryDir)) if(!originals.has(file)) fs.unlinkSync(file);
      const failures=[];
      for(const [file,bytes] of originals) try {if(bytes===null) fs.rmSync(file,{force:true});else fs.writeFileSync(file,bytes);} catch(e) {failures.push(e.message);}
      if(failures.length) throw Error(error.message+'; rollback failed: '+failures.join('; '),{cause:error});
      if(error.report) {error.report.written=false;error.report.rolledBack=true;}
      throw error;
    }
  };
  return write?withMemoryLock(memoryDir,run,{lock,timeoutMs:1000}):run();
}
