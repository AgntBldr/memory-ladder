import fs from 'node:fs';
import path from 'node:path';
import {args, locations, isDirect, loadConfig, memoryFiles, fmGet, mdLinks, listMd, requireMemory} from './lib.mjs';
import {withMemoryLock} from './memory-lock.mjs';
import {lessonIdentity, isGenerated, writeMemoryIndex} from './memory-index.mjs';

const patterns = [/^(.+)-background-(\d+)\.md$/, /^(.+)-background\.md$/, /^(.+)-part-(\d+)\.md$/, /^(.+)-(\d+)\.md$/];
const excluded = f => f.special || f.state || f.hardRule || lessonIdentity(f.file) || isGenerated(f.text);
const parentEligible = base => base && !lessonIdentity(base.file) && !base.special && !isGenerated(base.text);
export function scanChains(memoryDir, loadedFiles) {
  requireMemory(memoryDir);
  const files = loadedFiles ?? memoryFiles(memoryDir), byName = new Map(files.map(f => [f.file,f])), parts = [], problems = [];
  for (const f of files) {
    if (excluded(f) || f.stub) continue;
    const match = patterns.map(rx => rx.exec(f.file)).find(Boolean);
    const declared = fmGet(f.data,'parent');
    let parent, n = match ? Number(match[2] ?? 1) : null;
    if (typeof declared === 'string' && declared) {
      const base = byName.get(declared);
      if (!base) problems.push({file:f.file,kind:'parent-missing',detail:`parent ${declared} does not exist`});
      else if (base.file !== f.file && parentEligible(base)) parent = base.file;
    }
    if (!parent && match) {
      const base = byName.get(match[1] + '.md');
      if (parentEligible(base) && !base.stub) parent = base.file;
    }
    if (parent) parts.push({file:f.file,parent,n});
  }
  const groups = new Map();
  for (const part of parts) { if (!groups.has(part.parent)) groups.set(part.parent,[]); groups.get(part.parent).push(part); }
  for (const [parent, group] of groups) {
    const links = mdLinks(byName.get(parent).body);
    // Explicit parent parts without a numbered name take their number from parent order.
    for (const part of group) if (part.n === null) {
      const ordered = links.filter((file,i) => group.some(p=>p.file===file) && links.indexOf(file)===i);
      const at = ordered.indexOf(part.file);
      if (at >= 0) part.n = at + 1;
    }
    for (const part of group) {
      const first = byName.get(part.file).body.replace(/^\s*\n/,'').split(/\r?\n/)[0] ?? '';
      const line = /^Part (\d+) of \[([^\]]*)\]\(([^)]+)\)\.$/.exec(first);
      const expected = `Part ${part.n} of [${parent.slice(0,-3)}](${parent}).`;
      if (!line) problems.push({file:part.file,kind:'backlink',detail:`missing ${expected}`});
      else if (part.n !== null && Number(line[1]) !== part.n) problems.push({file:part.file,kind:'number',detail:`expected part ${part.n}, found ${Number(line[1])}`});
      else if (line[3] !== parent || line[2] !== parent.slice(0,-3)) problems.push({file:part.file,kind:'backlink',detail:`expected ${expected}`});
    }
    const ordered = [...group].sort((a,b) => (a.n ?? Infinity)-(b.n ?? Infinity)), nums = ordered.map(p=>p.n);
    if (nums.some((n,i)=>n !== i+1)) problems.push({file:parent,kind:'gap',detail:'part numbers must be consecutive from 1'});
    const indices = ordered.map(p=>links.indexOf(p.file));
    if (indices.some((n,i)=>n<0 || (i>0 && n<=indices[i-1]))) problems.push({file:parent,kind:'parent-order',detail:'parent must link every part in number order'});
  }
  return {parts,problems};
}
function bodyStart(raw) {
  const bom = raw.startsWith('\uFEFF') ? 1 : 0;
  const match = /^---[^\S\r\n]*\r?\n[\s\S]*?^---[^\S\r\n]*(?:\r?\n|$)/m.exec(raw.slice(bom));
  return match?.index === 0 ? bom + match[0].length : bom;
}
function transaction({memoryDir,config,write}, prepare) {
  requireMemory(memoryDir);
  const run = lock => {
    const result = prepare();
    if (!write || !result.changes.length) return result;
    const originals = new Map(listMd(memoryDir).map(file=>[file,fs.readFileSync(path.join(memoryDir,file))]));
    try {
      for (const change of result.changes) fs.writeFileSync(path.join(memoryDir,change.file),change.next);
      writeMemoryIndex({memoryDir,config,lock});
    } catch (error) {
      for (const file of listMd(memoryDir)) if (!originals.has(file)) fs.unlinkSync(path.join(memoryDir,file));
      for (const [file,bytes] of originals) fs.writeFileSync(path.join(memoryDir,file),bytes);
      throw error;
    }
    return result;
  };
  return write ? withMemoryLock(memoryDir,run,{timeoutMs:1000}) : run();
}
export function repairChains({memoryDir,write=false,config=loadConfig()} = {}) {
  return transaction({memoryDir,write,config},()=> {
    const scan=scanChains(memoryDir), changes=[];
    for (const part of scan.parts) {
      if (part.n === null || !scan.problems.some(p=>p.file===part.file && p.kind==='backlink')) continue;
      const bytes=fs.readFileSync(path.join(memoryDir,part.file)), original=bytes.toString('utf8'), k=bodyStart(original);
      if (!Buffer.from(original,'utf8').equals(bytes)) {
        scan.problems.push({file:part.file,kind:'invalid-utf8',detail:'invalid UTF-8 bytes; report only'});
        continue;
      }
      // Existing chain lines (including a wrong target) require human repair.
      if (/^\s*Part \d+ of /m.test(original.slice(k))) continue;
      const eol=original.match(/\r?\n/)?.[0] ?? '\n';
      const inserted=`Part ${part.n} of [${part.parent.slice(0,-3)}](${part.parent}).${eol}${/^(?:[ \t]*\r?\n)/.test(original.slice(k)) ? '' : eol}`;
      const next=original.slice(0,k)+inserted+original.slice(k);
      if (next.slice(0,k)!==original.slice(0,k) || next.slice(k+inserted.length)!==original.slice(k)) throw new Error('chain insertion proof failed');
      if (Buffer.byteLength(next)> (config.caps?.topic?.failBytes ?? 20480)) {
        scan.problems.push({file:part.file,kind:'size-cap',detail:'chain repair exceeds topic byte cap; report only'});
        continue;
      }
      changes.push({file:part.file,next});
    }
    return {...scan,changes};
  });
}
function packed(line,max,eol) {
  if (!/[.!?]\s+/.test(line)) return null;
  const sentences=line.split(/(?<=[.!?])(?<!\b\d+\.)\s+/), lines=[];
  for (const sentence of sentences) {
    if (lines.length && (lines.at(-1).length+1+sentence.length<=max || /^(?:[-*+]\s|>\s|#{1,6}\s|\d+[.)](?:\s|$)|={3,}|-{3,}|`{3,}|~{3,}|<!--|<\/?(?:details|div|table|pre|blockquote|p|ul|ol|h[1-6]|summary)(?:\s|\/?>))/i.test(sentence))) lines[lines.length-1]+=' '+sentence;
    else lines.push(sentence);
  }
  const next=lines.join(eol);
  // Multiple spaces and tabs are not silently normalized by the packing rule.
  return next!==line && next.replace(/\r?\n/g,' ')===line ? next : null;
}
function linePlan(memoryDir,max,loadedFiles) {
  if (!Number.isInteger(max) || max<1) throw new Error('line maximum must be a positive integer');
  const result=[];
  for (const f of loadedFiles ?? memoryFiles(memoryDir)) {
    if (f.special || isGenerated(f.text)) continue;
    const bytes=loadedFiles ? null : fs.readFileSync(path.join(memoryDir,f.file)), original=loadedFiles ? f.text : bytes.toString('utf8'), start=bodyStart(original);
    if (bytes && !Buffer.from(original,'utf8').equals(bytes)) {
      result.push({file:f.file,long:0,repairable:0,line:1,protected:0,message:'invalid UTF-8 bytes; report only',reportOnly:true,changed:false});
      continue;
    }
    let offset=0, fence=null, verbatim=false, long=0, repairable=0, first=null, protectedCount=0;
    const changes=[];
    const lines=original.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    for (let i=0;i<lines.length;i++) {
      const raw=lines[i], at=offset; offset+=raw.length;
      if (offset<=start) continue;
      const prefix=Math.max(0,start-at), line=raw.slice(prefix).replace(/\r?\n$/,'');
      const mark=/^ {0,3}(`{3,}|~{3,})/.exec(line);
      let protectedLine=Boolean(fence || verbatim);
      if (line.includes('<!-- BEGIN VERBATIM PAYLOAD -->')) { verbatim=true; protectedLine=true; }
      if (mark && !fence) { fence={char:mark[1][0],length:mark[1].length}; protectedLine=true; }
      else if (mark && fence && mark[1][0]===fence.char && mark[1].length>=fence.length && /^\s*$/.test(line.slice(mark[0].length))) { fence=null; protectedLine=true; }
      if (line.includes('<!-- END VERBATIM PAYLOAD -->')) { verbatim=false; protectedLine=true; }
      if (line.length<=max) continue;
      // Preserve visibility without counting fences/payloads toward topic.line.
      if (protectedLine) { protectedCount++; continue; }
      long++; first ??= i+1;
      const special=/^(?:\s|#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(line);
      const next=!protectedLine && !special ? packed(line,max,raw.endsWith('\r\n')?'\r\n':'\n') : null;
      if (next!==null) { repairable++; changes.push({at:at+prefix,length:line.length,next}); }
    }
    let next=original;
    for (const c of changes.reverse()) next=next.slice(0,c.at)+c.next+next.slice(c.at+c.length);
    if (long || protectedCount) result.push({file:f.file,long,repairable,line:first,protected:protectedCount,next,changed:next!==original});
  }
  return result;
}
export function scanLines(memoryDir,max=2000,loadedFiles) { requireMemory(memoryDir); return linePlan(memoryDir,max,loadedFiles).map(({next,changed,...r})=>r); }
export function repairLines({memoryDir,write=false,max=2000,config=loadConfig()} = {}) {
  return transaction({memoryDir,write,config},()=> {
    const plans=linePlan(memoryDir,max);
    return {files:plans.map(({next,changed,...r})=>r),changes:plans.filter(p=>p.changed).map(({file,next})=>({file,next}))};
  });
}
export function main(argv=process.argv.slice(2)) {
  try {
    const opts=args(argv.filter(x=>x!=='--write')), command=opts._.shift(), loc=locations(opts);
    const config=opts.config?JSON.parse(fs.readFileSync(opts.config,'utf8')):loadConfig(), write=argv.includes('--write');
    let result;
    if (command==='scan') result=scanChains(loc.memoryDir);
    else if(command==='repair') result=repairChains({...loc,config,write});
    else if(command==='lines') result=repairLines({...loc,config,write,max:config.caps?.topic?.warnLineChars ?? 2000});
    else throw new Error('usage: memory-chains.mjs scan|repair|lines [--write] [--json] [--memory-dir PATH] [--repo PATH]');
    if(opts.json) console.log(JSON.stringify(result,null,2));
    else {
      for(const p of result.problems ?? []) console.log(`${p.file}: ${p.kind}: ${p.detail}`);
      for(const f of result.files ?? []) console.log(`${f.file}:${f.line ?? '-'}: ${f.message ?? `${f.long} long lines (${f.repairable} repairable); ${f.protected} protected lines report only`}`);
      console.log(`chains ${command}: ${result.parts?.length ?? result.files?.length ?? 0} ${result.parts?'parts':'files'}${result.changes ? '; '+result.changes.length+(write?' files written':' files would change')+'; proof ok':''}`);
    }
    return 0;
  } catch(error) { console.error('memory-chains: '+error.message); return 1; }
}
if(isDirect(import.meta.url)) process.exitCode=main();
