import {normalizeEol} from '../engine/lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const exists = file => fs.existsSync(file) && fs.statSync(file).isFile();
const inside = (root, file) => { const r=path.relative(root,file);return r!== '..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r); };
export function instructions(target) {
  const found=new Map();
  function visit(file) {
    if(!exists(file)) return;
    file=fs.realpathSync(file);
    if(found.has(file)) return;
    const text=fs.readFileSync(file,'utf8');found.set(file,text);
    for(const m of text.matchAll(/(?:^|\s)@([^\s`<>"()]+)/gm)) {
      const relative=path.resolve(path.dirname(file),m[1]),rooted=path.resolve(target,m[1]);
      visit(exists(relative)?relative:rooted);
    }
    for(const m of text.matchAll(/(?:@|\]\(|`)([^\s`<>"()]+\.md)\b/g)) {
      const relative=path.resolve(path.dirname(file),m[1]),rooted=path.resolve(target,m[1]);
      visit(exists(relative)?relative:rooted);
    }
  }
  for(const file of ['AGENTS.md','CLAUDE.md','CLAUDE.local.md']) visit(path.join(target,file));
  const rules=path.join(target,'.claude/rules');
  if(fs.existsSync(rules)) for(const name of fs.readdirSync(rules)) if(name.endsWith('.md')) visit(path.join(rules,name));
  return found;
}
export function checkMemoryRouter(target, memory, opts, sources) {
  const candidates=new Set();
  for(const [file,text] of sources) {
    for(const m of text.matchAll(/(?:[.\w-]+[\\/])*MEMORY\.md\b/gi)) {
      for(const base of [target,path.dirname(file)]) {const p=path.resolve(base,m[0]);if(inside(target,p)&&exists(p)) candidates.add(p);}
    }
  }
  for(const relative of ['.claude/memory/MEMORY.md','memory/MEMORY.md','MEMORY.md']) {
    const file=path.join(target,relative);
    if(exists(file)&&(relative.includes('/')||fs.readdirSync(target).some(n=>/^INDEX-.*\.md$/i.test(n)))) candidates.add(file);
  }
  for(const router of candidates) {
    const folder=path.dirname(router);
    if(path.resolve(memory.dir).toLowerCase()===folder.toLowerCase()) continue;
    const message=`in-repo memory router ${router}; would have gated ${memory.dir}`;
    if(!opts['accept-separate-memory']) throw new Error(message+'; refusing before writes. Use --accept-separate-memory to explicitly choose separate memory.');
    console.log('WARNING separate memory: '+message);
  }
}
export function mirrorWrites(target, planned, sources, {keepDivergent=false}={}) {
  const folders=new Set(['.agents/skills']);
  for(const text of sources.values()) for(const m of text.matchAll(/(?:[.\w-]+\/)+skills\b/g)) folders.add(m[0]);
  const result=[];
  for(const [file,data] of planned) {
    const relative=path.relative(path.join(target,'.claude/skills'),file);
    if(!inside(path.join(target,'.claude/skills'),file)||!exists(file)||path.basename(file)!=='SKILL.md') continue;
    for(const folder of folders) {
      const mirror=path.resolve(target,folder,relative);
      if(mirror===file||!inside(target,mirror)||!exists(mirror)) continue;
      if(normalizeEol(fs.readFileSync(mirror,'utf8'))!==normalizeEol(fs.readFileSync(file,'utf8'))) {
        if(keepDivergent) {console.log(`WARN skill mirror differs; skipped: ${mirror}`);continue;}
        throw new Error(`skill mirror differs: ${mirror} vs ${file}; neither changed`);
      }
      result.push([mirror,data]);
    }
  }
  return result;
}
export function appendText(text, block) {
  const eol=text.includes('\r\n')?'\r\n':'\n';
  return text+(text.endsWith('\n')?eol:eol+eol)+block.replace(/\r?\n/g,eol);
}
export function toolingHints(target) {
  if(fs.readdirSync(target).some(n=>/^eslint\.config\.|^\.eslintrc/.test(n))) console.log('Host eslint: if eslint . collects kit .mjs, exclude scripts/memory/** (flat config global ignores; legacy ignorePatterns).');
  const ts=path.join(target,'tsconfig.json');
  if(exists(ts)&&/"(?:allowJs|checkJs)"\s*:\s*true/.test(fs.readFileSync(ts,'utf8'))) console.log('Host tsconfig: allowJs/checkJs may collect kit .mjs; add scripts/memory/** to exclude when needed.');
}
export function sameFile(a,b) {
  if(a===b) return true;
  try {
    if(fs.realpathSync(a)===fs.realpathSync(b)) return true;
    const x=fs.statSync(a),y=fs.statSync(b);
    return Boolean(x.ino && y.ino && x.ino===y.ino && x.dev===y.dev);
  } catch {return false;}
}
export function hostSnapshot(target, paths=[]) {
  const result=new Map();
  for(const file of new Set(paths.map(file=>path.resolve(target,file)))) {
    const key=path.relative(target,file).split(path.sep).join('/');let fd;
    try {
      fd=fs.openSync(file,'r');const hash=createHash('sha256'),buffer=Buffer.alloc(64*1024);let size=0,n;
      while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0) {hash.update(buffer.subarray(0,n));size+=n;}
      result.set(key,{size,hash:hash.digest('hex')});
    } catch(error) {
      result.set(key,error.code==='ENOENT'?{missing:true}:{error:error.code||error.message});
    } finally {
      if(fd!==undefined) try {fs.closeSync(fd);}catch(error){result.set(key,{error:error.code||error.message});}
    }
  }
  return result;
}
export function installReport(target,before) {
  console.log('Install host file report (path | action | bytes before -> after):');
  for(const [file,data] of hostSnapshot(target,[...before.keys()])) {
    const old=before.get(file);
    if(old?.error||data.error) console.log(`${file} | read error | before: ${old?.error??'ok'}; after: ${data.error??'ok'}`);
    else if(old?.hash!==data.hash) console.log(`${file} | ${data.missing?'removed':old?.missing?'created':'modified'} | ${old?.size??0} -> ${data.size??0}`);
  }
  console.log('Self-test: node --test scripts/memory/memory.selftest.mjs');
  console.log('Optional npm script: "memory:test": "node --test scripts/memory/memory.selftest.mjs"');
}
