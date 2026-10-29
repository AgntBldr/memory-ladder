import fs from 'node:fs';
import path from 'node:path';
import {args, locations, isDirect, loadConfig, memoryFiles, listMd, requireMemory, pathSpelling} from './lib.mjs';
import {withMemoryLock} from './memory-lock.mjs';
import {isGenerated, writeMemoryIndex} from './memory-index.mjs';

// The five undefined bytes in the Windows-1252 extension block are not mappings.
export const cp1252 = new Map([
  [0x80,0x20ac],[0x82,0x201a],[0x83,0x192],[0x84,0x201e],[0x85,0x2026],[0x86,0x2020],[0x87,0x2021],
  [0x88,0x2c6],[0x89,0x2030],[0x8a,0x160],[0x8b,0x2039],[0x8c,0x152],[0x8e,0x17d],
  [0x91,0x2018],[0x92,0x2019],[0x93,0x201c],[0x94,0x201d],[0x95,0x2022],[0x96,0x2013],[0x97,0x2014],
  [0x98,0x2dc],[0x99,0x2122],[0x9a,0x161],[0x9b,0x203a],[0x9c,0x153],[0x9e,0x17e],[0x9f,0x178],
]);
const reverse = new Map([...cp1252].map(([b,p])=>[p,b]));
const continuation = '[\\u0080-\\u00BF'+[...cp1252.values()].map(p=>'\\u'+p.toString(16).padStart(4,'0')).join('')+']';
const sequence = `(?:[\\u00C2\\u00C3]${continuation}|\\u00E2${continuation}${continuation})`;
const runs = () => new RegExp(`${sequence}+|\\u00E2\\u20AC(?:[^${continuation.slice(1,-1)}]|$)`,'gu');
export function decodeRun(run) {
  try {
    const bytes=Array.from(run,c=> { const p=c.codePointAt(0); if(reverse.has(p)) return reverse.get(p); if(p<=255) return p; throw new Error('not a byte'); });
    const decoded=new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(bytes));
    const roundtrip=Array.from(Buffer.from(decoded,'utf8'),b=> {
      if (b>=0x80 && b<=0x9f && !cp1252.has(b)) throw new Error('unmapped Windows-1252 byte');
      return String.fromCodePoint(cp1252.get(b) ?? b);
    }).join('');
    return roundtrip===run ? decoded : null;
  } catch { return null; }
}
const names = new Map([[0x2014,'EM DASH'],[0x2013,'EN DASH'],[0x2018,'LEFT SINGLE QUOTATION MARK'],[0x2019,'RIGHT SINGLE QUOTATION MARK'],[0x201c,'LEFT DOUBLE QUOTATION MARK'],[0x201d,'RIGHT DOUBLE QUOTATION MARK'],[0x2026,'HORIZONTAL ELLIPSIS'],[0x2192,'RIGHTWARDS ARROW'],[0xab,'LEFT-POINTING DOUBLE ANGLE QUOTATION MARK'],[0xbb,'RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK'],[0xf8,'LATIN SMALL LETTER O WITH STROKE'],[0xc2,'LATIN CAPITAL LETTER A WITH CIRCUMFLEX'],[0xc3,'LATIN CAPITAL LETTER A WITH TILDE'],[0xe2,'LATIN SMALL LETTER A WITH CIRCUMFLEX'],[0x20ac,'EURO SIGN'],[0xfffd,'REPLACEMENT CHARACTER']]);
export const codePoints = text => Array.from(text,c=> {const p=c.codePointAt(0); return 'U+'+p.toString(16).toUpperCase().padStart(4,'0')+(names.has(p)?' '+names.get(p):'');}).join(' ');
// Offset-preserving masking: repair and scan see exactly the same prose spans.
export function proseLines(text) {
  const result=[]; let offset=0, fence=null, indented=false, list=false, blockIndent=null;
  const fm=/^\uFEFF?---[^\S\r\n]*\r?\n[\s\S]*?^---[^\S\r\n]*(?:\r?\n|$)/m.exec(text);
  const fmEnd=fm?.index===0 ? fm[0].length : 0;
  const lines=text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  for(let i=0;i<lines.length;i++) {
    const raw=lines[i], line=raw.replace(/\r?\n$/,''), at=offset; offset+=raw.length;
    if(at<fmEnd) {
      let masked=' '.repeat(line.length);
      const indent=line.match(/^ */)[0].length;
      if(blockIndent!==null && indent>blockIndent) masked=line;
      else {
        blockIndent=null;
        // Only scalar values are prose. Quoted keys and flow collections stay intact.
        const field=/^(\s*(?:-\s+)?(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:#][^:]*):[ \t]*)(.*)$/.exec(line);
        if(field) {
          const value=field[2];
          if(/^[|>][-+0-9]*\s*(?:#.*)?$/.test(value)) blockIndent=indent;
          else if(!/^[\[{&*!]/.test(value)) masked=' '.repeat(field[1].length)+value;
        }
      }
      result.push({line:i+1,offset:at,text:line,prose:masked}); continue;
    }
    if(/^ {0,3}(?:[-*+] |\d+[.)] )/.test(line)) list=true;
    else if(line.trim() && !/^\s/.test(line)) list=false;
    if(!list && /^(?: {4}|\t)/.test(line) && (indented || i===0 || !lines[i-1].trim())) { indented=true; continue; }
    if(line.trim()) indented=false;
    const mark=/^ {0,3}(`{3,}|~{3,})/.exec(line);
    if(fence) { if(mark && mark[1][0]===fence.char && mark[1].length>=fence.length && /^\s*$/.test(line.slice(mark[0].length))) fence=null; continue; }
    if(mark) { fence={char:mark[1][0],length:mark[1].length}; continue; }
    let masked=line;
    const ticks=/`+/g; let m;
    while((m=ticks.exec(line))) {
      const endRx=new RegExp('(?<!`)`{'+m[0].length+'}(?!`)','g'); endRx.lastIndex=ticks.lastIndex;
      const end=endRx.exec(line); if(!end) continue;
      const finish=end.index+end[0].length;
      masked=masked.slice(0,m.index)+' '.repeat(finish-m.index)+masked.slice(finish); ticks.lastIndex=finish;
    }
    result.push({line:i+1,offset:at,text:line,prose:masked});
  }
  return result;
}
export function scanChars(text) {
  const findings=new Map();
  const add=(check,line,description,decoded) => {
    if(findings.has(check)) { findings.get(check).value++; return; }
    findings.set(check,{check,line,value:1,description,decoded});
  };
  for(const line of proseLines(text)) {
    if(/\uFFFD/u.test(line.prose)) add('chars.replacement',line.line,'U+FFFD REPLACEMENT CHARACTER');
    const m=runs().exec(line.prose);
    if(m) add('chars.mojibake',line.line,'mojibake',decodeRun(m[0]));
    if(/(?<=[\p{L}\p{N}]) \? (?=\p{L})/u.test(line.prose)) add('chars.lost-dash',line.line,'a possible lost dash (U+003F QUESTION MARK)');
  }
  return [...findings.values()].map(({description,decoded,...f})=>({...f,message:`${f.value} line(s) with ${description}, first at line ${f.line}${f.check==='chars.mojibake' ? decoded===null?'; undecodable':'; first decodes to '+codePoints(decoded):''}`}));
}
const allowed = (file,config) => (config.allow ?? []).some(a=> {
  if(a.check!=='chars.mojibake' || typeof a.file!=='string') return false;
  const rx=new RegExp('^'+pathSpelling(a.file).split('*').map(p=>p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$');
  return rx.test(pathSpelling(file));
});
export function repairChars({memoryDir,write=false,config=loadConfig()} = {}) {
  requireMemory(memoryDir);
  const run=lock=> {
    const changes=[],items=[];
    for(const f of memoryFiles(memoryDir)) {
      if(isGenerated(f.text)) continue;
      const bytes=fs.readFileSync(path.join(memoryDir,f.file)), original=bytes.toString('utf8'), edits=[];
      if(!Buffer.from(original,'utf8').equals(bytes)) {
        items.push({file:f.file,line:1,message:'invalid UTF-8 bytes; report only',reportOnly:true}); continue;
      }
      for(const line of proseLines(original)) {
        const outside=line.prose.replace(runs(),'');
        for(const m of line.prose.matchAll(runs())) {
          const decoded=decodeRun(m[0]);
          const reportOnly=decoded===null || allowed(f.file,config) || /mojibake|cp1252|Windows-1252|U\+FFFD|encoding/i.test(line.text) || outside.includes(decoded);
          const message=codePoints(m[0])+' -> '+(decoded===null?'undecodable':codePoints(decoded))+(reportOnly?'; report only':'');
          items.push({file:f.file,line:line.line,message,reportOnly});
          if(!reportOnly) edits.push({at:line.offset+m.index,run:m[0],decoded});
        }
        for(const finding of scanChars(line.prose).filter(x=>x.check!=='chars.mojibake')) items.push({file:f.file,line:line.line,message:finding.message.replace(/first at line \d+/,`first at line ${line.line}`)+'; report only',reportOnly:true});
      }
      if(!edits.length) continue;
      let next='',cursor=0,removed=0,added=0;
      for(const e of edits) { next+=original.slice(cursor,e.at)+e.decoded; cursor=e.at+e.run.length; removed+=Buffer.byteLength(e.run); added+=Buffer.byteLength(e.decoded); }
      next+=original.slice(cursor);
      let oldAt=0,newAt=0;
      for(const e of edits) {
        const length=e.at-oldAt;
        if(original.slice(oldAt,e.at)!==next.slice(newAt,newAt+length) || decodeRun(e.run)!==e.decoded) throw new Error('character conservation proof failed');
        oldAt=e.at+e.run.length; newAt+=length+e.decoded.length;
      }
      if(original.slice(oldAt)!==next.slice(newAt) || Buffer.byteLength(original)-removed!==Buffer.byteLength(next)-added) throw new Error('character conservation proof failed');
      changes.push({file:f.file,next});
    }
    if(write && changes.length) {
      const originals=new Map(listMd(memoryDir).map(file=>[file,fs.readFileSync(path.join(memoryDir,file))]));
      try {
        for(const c of changes) fs.writeFileSync(path.join(memoryDir,c.file),c.next);
        writeMemoryIndex({memoryDir,config,lock});
      } catch(error) {
        for(const file of listMd(memoryDir)) if(!originals.has(file)) fs.unlinkSync(path.join(memoryDir,file));
        for(const [file,bytes] of originals) fs.writeFileSync(path.join(memoryDir,file),bytes);
        throw error;
      }
    }
    const remaining=memoryFiles(memoryDir).filter(f=>!isGenerated(f.text)).reduce((n,f)=>n+(scanChars(f.text).find(x=>x.check==='chars.mojibake')?.value ?? 0),0);
    return {items,sequences:items.filter(i=>!i.reportOnly).length,files:changes.length,proof:true,remaining};
  };
  return write?withMemoryLock(memoryDir,run,{timeoutMs:1000}):run();
}
export function main(argv=process.argv.slice(2)) {
  try {
    const opts=args(argv.filter(x=>x!=='--write')), command=opts._.shift();
    if(command!=='repair') throw new Error('usage: memory-chars.mjs repair [--write] [--json] [--memory-dir PATH] [--repo PATH]');
    const result=repairChars({...locations(opts),write:argv.includes('--write'),config:opts.config?JSON.parse(fs.readFileSync(opts.config,'utf8')):loadConfig()});
    if(opts.json) console.log(JSON.stringify(result,null,2));
    else {
      for(const i of result.items) console.log(`${i.file}:${i.line}: ${i.message}`);
      console.log(`repair: ${result.sequences} sequences in ${result.files} files; proof ok`);
      console.log(`chars.mojibake: ${result.remaining} lines remaining`);
    }
    return 0;
  } catch(error) { console.error('memory-chars: '+error.message); return 1; }
}
if(isDirect(import.meta.url)) process.exitCode=main();
