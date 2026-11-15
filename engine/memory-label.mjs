import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promotionDate} from './memory-promote.mjs';
import {parseFrontmatter} from './lib.mjs';
import {lessonIdentity, isGenerated} from './memory-index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const document = name => read(fs.existsSync(path.join(HERE,name)) ? path.join(HERE,name) : path.join(HERE,'../docs',name));
const CLASSES = ['candidate-routed','other-project','other-reference','candidate-unrouted','orphan','chain-head','doc-referenced'];
const KINDS = ['mistake','practice','observation'];
const FIELDS = ['kinds','cases','confidence','lesson','trigger','disposition','reason','route','extract'];
const MAX_BYTES = 100_000;
const PRODUCTION = Object.freeze({roundKinds:{mistake:36,practice:13,observation:11}, negatives:20, pilot:10, roundBundles:3, sentinels:2});
const read = p => fs.readFileSync(p, 'utf8');
const readJSON = p => JSON.parse(read(p));
const bytes = s => Buffer.byteLength(s, 'utf8');
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const own = (x,k) => Object.hasOwn(x,k);
const fail = message => { throw Error(message); };
const write = (p, data) => { fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p,typeof data === 'string' ? data : JSON.stringify(data,null,2)+'\n'); };
const field = (data,key) => data.metadata?.[key] ?? data[key];
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const single = value => String(value ?? '').replace(/[\r\n]+/g,' ');

function rng(seed) {
  let state = Number(seed) >>> 0;
  return () => { state += 0x6D2B79F5; let t=state; t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; };
}
function shuffle(items, random) {
  const a=[...items]; for(let i=a.length-1;i>0;i--) {const j=Math.floor(random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a;
}
function section(text, number) {
  const found = new RegExp(`^## ${number}\\. [^\\n]*\\n([\\s\\S]*?)(?=^## \\d+\\.|$(?![\\s\\S]))`,'m').exec(text);
  if(!found) fail(`Missing document section ${number}`); return found[0].trim();
}

export function clipBody(body) {
  if(bytes(body)<=5000) return body;
  const lines=body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let head='',tail='';
  for(const line of lines) {if(bytes(head+line)>4000) break;head+=line;}
  for(let i=lines.length-1;i>=0;i--) {if(bytes(lines[i]+tail)>1000) break;tail=lines[i]+tail;}
  return `${head}\n[${bytes(body)-bytes(head)-bytes(tail)} bytes omitted]\n${tail}`;
}

function redactor(files) {
  const names=[...new Set(files)].sort((a,b)=>b.length-a.length);
  const re = names.length ? new RegExp(names.map(escape).join('|'),'gi') : null;
  const stems = names.map(f=>f.replace(/\.md$/i,''));
  const stemRE=stems.length ? new RegExp(`(?<![\\w-])(?:${stems.map(escape).join('|')})(?![\\w-])`,'gi') : null;
  return text => {
    let value=String(text);
    if(re) value=value.replace(re,'[a memory file]');
    if(stemRE) value=value.replace(stemRE,'[a memory file]');
    return value.replace(/(?:lesson-\d+[a-z]*(?:-[\w.-]*)?|feedback-[\w.-]*)/gi,'[a memory file]')
      .replace(/[\w.-]+\.md\b/gi,'[a memory file]')
      .replace(/`(?:metadata\.)?(?:filename|type|route|kind|kind_case|takeaway|pin|trigger|hook|parent):[^`\n]*`/g,'[metadata omitted]')
      .replace(/(?:metadata\.)?\b(?:filename|type|route|kind|kind_case|takeaway|pin|trigger|hook|parent):[ \t]*(?:"[^"\n]*"|'[^'\n]*'|\[[^\]\n]*\]|[^\s,;.)}`\n]+)?/g,'[metadata omitted]');
  };
}
function loadNote(dir,file) {
  if(path.basename(file)!==file || !file.endsWith('.md')) fail('Unsafe memory filename');
  const text=read(path.join(dir,file)), parsed=parseFrontmatter(text);
  if(parsed.data.__error || parsed.data.__warnings?.length) fail('Memory frontmatter cannot be parsed safely');
  return {file,text,...parsed};
}
function renderRow(row, redact) {
  // Frontmatter is allowlisted; body key lines are also hidden if metadata was quoted there.
  const body=row.body.replace(/^\s*(?:filename|type|route|kind|kind_case|takeaway|pin|trigger|hook|parent):[^\n]*(?:\n|$)/gm,'');
  const flags=[row.needs_route && 'needs_route',row.no_rename && 'no_rename'].filter(Boolean).join(' ');
  // Indent body content so a source heading cannot impersonate another bundle row.
  const visible=clipBody(redact(body)).split('\n').map(line=>'    '+line).join('\n');
  return `### ${row.id}\nFlags: ${flags || 'none'}\nname: ${single(redact(row.data.name ?? ''))}\ndescription: ${single(redact(row.data.description ?? ''))}\ndate: ${single(row.date ?? field(row.data,'date') ?? '')}\n\n${visible}\n\n`;
}
function familyLines(router,redact) {
  const found=new Map();
  for(const line of router.split(/\r?\n/)) {
    const m=/\]\(INDEX-([\w-]+)\.md\)/.exec(line);
    if(m && !found.has(m[1]) && !/-all(?:-\d+)?$/.test(m[1])) found.set(m[1],redact(line));
  }
  if(!found.size) fail('No router families found');
  return [...found].map(([family,line])=>`Family ${family}: ${line}`).join('\n');
}
function bundleText(id,who,header,rows) {
  return `# Blind labelling bundle\nBundle: ${id}\nLabeller: ${who}\n\n${header}\n\n## Rows\n\n${rows.map(r=>r.render).join('')}`;
}
const tally = (rows,key) => Object.fromEntries([...new Set(rows.map(r=>r[key]))].sort().map(value=>[value,rows.filter(r=>r[key]===value).length]));

// Balance class and family occupancy while enforcing exact byte and row caps.
function pack(rows,n,headerBytes,reserve=0,maxRows=Infinity) {
  const bins=Array.from({length:n},()=>[]);
  for(const row of rows) {
    const available=bins.map((bin,i)=>({bin,i,size:bin.reduce((s,r)=>s+bytes(r.render),0)}))
      .filter(x=>x.bin.length<maxRows && x.bin.filter(r=>r.source==='ours').length+(row.source==='ours'?1:0)<=28 && x.size+bytes(row.render)+headerBytes+reserve<=MAX_BYTES);
    if(!available.length) return null;
    available.sort((a,b)=> {
      const cost=x=>x.bin.length*10 + x.bin.filter(r=>r.class===row.class).length*3 + x.bin.reduce((s,r)=>s+r.family.filter(f=>row.family.includes(f)).length,0);
      return cost(a)-cost(b) || a.size-b.size || a.i-b.i;
    });
    available[0].bin.push(row);
  }
  return bins;
}
function take(pool,count,label) {
  if(pool.length<count) fail(`Insufficient eligible ${label}: need ${count}, have ${pool.length}`);
  return pool.splice(0,count);
}
function weightedCounts(total) {
  const weights=[.6,13/60,11/60], counts=weights.map(w=>Math.floor(total*w));
  const order=weights.map((w,i)=>({i,r:total*w-counts[i]})).sort((a,b)=>b.r-a.r || a.i-b.i);
  for(let i=0,left=total-counts.reduce((a,b)=>a+b,0);i<left;i++) counts[order[i].i]++;
  return counts;
}

// Sampling overrides support fixture calibration; normal runs use the documented reference sample.
export function build(options,sampling=PRODUCTION) {
  const {census,memory,reference,keyDir,out}=options;
  const seed=Number(options.seed ?? 20261110);
  if(!Number.isInteger(seed) || seed<0 || seed>0xffffffff) fail('seed must be a uint32');
  const random=rng(seed), censusRows=readJSON(census).rows;
  if(!Array.isArray(censusRows)) fail('census requires rows');
  if(new Set(censusRows.map(r=>r.file)).size!==censusRows.length) fail('Duplicate census filename');
  const selected=censusRows.filter(r=>CLASSES.includes(r.class));

  const ours=selected.map(row=> {
    const family=Array.isArray(row.route)?row.route:row.route?[row.route]:[];
    return {...loadNote(memory,row.file),source:'ours',class:row.class,family,date:row.date,needs_route:family.length===0 || ['candidate-unrouted','orphan'].includes(row.class),no_rename:['chain-head','doc-referenced'].includes(row.class)};
  });
  const referenceFiles=fs.readdirSync(reference).filter(f=>f.endsWith('.md')).sort();
  const notes=referenceFiles.map(file=>loadNote(reference,file)).filter(r=>!isGenerated(r.text) && !/^(?:MEMORY|ARCHIVE)\.md$|^INDEX-|^index-notes-|-background|-[23]\.md$/i.test(r.file) && r.body.trim());
  const seenIdentities=new Set(),seenBodies=new Set();
  // Prefer unpinned originals when the same identity/body also exists as a pinned copy.
  const lessons=notes.filter(r=>lessonIdentity(r.file)).sort((a,b)=>Number(Boolean(field(a.data,'pin')))-Number(Boolean(field(b.data,'pin'))) )
    .filter(r=> {
      const identity=lessonIdentity(r.file),body=r.body.trim();
      if(seenIdentities.has(identity) || seenBodies.has(body) || /^(?:See\s+)?(?:\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\))\.?$/i.test(body)) return false;
      seenIdentities.add(identity);seenBodies.add(body);return KINDS.includes(field(r.data,'kind'));
    }).map(r=>({...r,source:'reference',class:'holdout',family:[],needs_route:false,no_rename:false,holdout_kind:field(r.data,'kind')}));
  const pools=Object.fromEntries(KINDS.map(kind=>[kind,shuffle(lessons.filter(r=>r.holdout_kind===kind),random)]));
  const roundLessons=KINDS.flatMap(kind=>take(pools[kind],sampling.roundKinds[kind],kind));
  const negatives=take(shuffle(notes.filter(r=>!lessonIdentity(r.file)),random),sampling.negatives,'negative topics')
    .map(r=>({...r,source:'reference',class:'negative',family:[],needs_route:false,no_rename:false,negative:true}));
  const pilotFamily=ours.find(r=>r.family.length)?.family[0];
  const pilotPool=shuffle(ours.filter(r=>r.family.includes(pilotFamily)),random);
  pilotPool.push(...shuffle(ours.filter(r=>!r.family.includes(pilotFamily)),random));
  const pilot=take(pilotPool,Math.min(sampling.pilot,ours.length),'pilot rows');
  const remaining=shuffle(ours.filter(r=>!pilot.includes(r)),random);
  const redact=redactor([...censusRows.map(r=>r.file),...referenceFiles]);
  const lessonTest='## Selection rule\nA file becomes a lesson when its core is one reusable takeaway that should change behaviour in a later task and stays true whatever the project state.';
  const labelling=document('LABELLING.md');
  const readingHarm=/^## Reading harm\r?\n[\s\S]*?(?=^## |$(?![\s\S]))/m.exec(labelling)?.[0];
  if(!readingHarm) fail('Missing Reading harm in LABELLING.md');
  const header=[document('LESSON-KINDS.md').trim(),lessonTest,
    '## Families\n'+familyLines(options.routerText ?? read(path.join(memory,'MEMORY.md')),redact),
    section(labelling,2),readingHarm.trim()].join('\n\n');
  const allCandidates=[...ours,...roundLessons,...negatives,...Object.values(pools).flat()];
  // Shuffle IDs over both sources, without a project-specific numerical range.
  shuffle(allCandidates,random).forEach((row,i)=>{row.id=`row-${String(i+1).padStart(4,'0')}.md`;row.render=renderRow(row,redact);});
  const headerBytes=bytes(bundleText('r0-1','A',header,[]));
  const roundRows=shuffle([...roundLessons,...negatives,...pilot],random);
  const round=pack(roundRows,sampling.roundBundles,headerBytes,0,Math.ceil(roundRows.length/sampling.roundBundles));
  if(!round || round.some(bin=>!bin.length)) fail('Calibration cannot fit its bundles within byte limits');
  const poolLessons=Object.values(pools).flat();
  const reserve=sampling.sentinels*Math.max(0,...poolLessons.map(r=>bytes(r.render)));
  let main,n=Math.max(1,Math.ceil(remaining.length/28));
  for(;n<=Math.max(1,remaining.length);n++) {main=pack(remaining,n,headerBytes,reserve,28);if(main) break;}
  if(!main) fail('A row cannot fit the bundle byte limit');
  const quotas=weightedCounts(main.length*sampling.sentinels);
  const sentinels=KINDS.flatMap((kind,i)=>take(pools[kind],quotas[i],`sentinel ${kind}`)).map(r=>({...r,sentinel:true}));
  const orderedSentinels=shuffle(sentinels,random);
  main.forEach(bin=>bin.push(...orderedSentinels.splice(0,sampling.sentinels)));
  const bundles=[...round.map((rows,i)=>({id:`r0-${i+1}`,rows})),...main.map((rows,i)=>({id:`b${String(i+1).padStart(2,'0')}`,rows}))];
  const used=bundles.flatMap(b=>b.rows),key={},holdout={version:1,kinds:{},unscored:[]};
  for(const row of [...used].sort((a,b)=>a.id.localeCompare(b.id))) {
    key[row.id]={source:row.source,file:row.file,class:row.class,family:row.family,needs_route:row.needs_route,no_rename:row.no_rename,
      ...(row.holdout_kind?{holdout_kind:row.holdout_kind}:{}),...(row.negative?{negative:true}:{}),...(row.sentinel?{sentinel:true}:{})};
    if(row.holdout_kind) holdout.kinds[row.id]=row.holdout_kind;
    if(row.negative) holdout.unscored.push(row.id);
  }
  const outputs=[],report={version:1,seed,ours:ours.length,excluded:censusRows.length-ours.length,classes:tally(ours,'class'),
    needs_route:used.filter(r=>r.needs_route).map(r=>r.id).sort(),no_rename:used.filter(r=>r.no_rename).map(r=>r.id).sort(),
    calibration:{lessons:roundLessons.length,kinds:tally(roundLessons,'holdout_kind'),negatives:negatives.length,ours:pilot.length},sentinels:sentinels.length,bundles:[]};
  for(const bundle of bundles) {
    const a=shuffle(bundle.rows,random);let b=shuffle(bundle.rows,random);
    if(a.length>1 && a.every((r,i)=>r===b[i])) b=[...b.slice(1),b[0]];
    const entry={id:bundle.id,rows:a.length,ours:a.filter(r=>r.source==='ours').length,classes:tally(a,'class'),bytes:{}};
    for(const [who,rows] of [['A',a],['B',b]]) {
      const text=bundleText(bundle.id,who,header,rows);
      if(bytes(text)>MAX_BYTES) fail('Bundle exceeds 100 KB');
      if(/feedback-|lesson-\d|\b(?:filename|type|route|kind|kind_case|takeaway|pin|trigger|hook|parent):/.test(text)) fail('Blinding invariant failed; no output written');
      entry.bytes[who]=bytes(text);outputs.push([path.join(out,'bundles',`${bundle.id}-${who}.md`),text]);
    }
    // The unqualified path is the canonical A copy; labellers use explicit A/B paths.
    outputs.push([path.join(out,'bundles',`${bundle.id}.md`),bundleText(bundle.id,'A',header,a)]);report.bundles.push(entry);
  }
  outputs.push([path.join(out,'prompt.md'),'Read only the bundle file named below. Return only the JSON object specified in section 2 in its header. Label every row, including non-lessons. Use the bundle and labeller values in that file. Do not read sibling bundles, results, keys or source memories.\n\nBundle file: <absolute bundle path supplied by the orchestrator>\n'],
    [path.join(out,'build-report.json'),report],[path.join(keyDir,'key.json'),key],[path.join(keyDir,'holdout.json'),holdout]);
  // Never overwrite a previous build or key: its already-labelled IDs must remain stable.
  if(outputs.some(([p])=>fs.existsSync(p))) fail('Build destination already exists; use fresh output and key directories');
  for(const [p,data] of outputs) write(p,data);
  return report;
}

function parseBundle(text) {
  const bundle=/^Bundle: ([\w-]+)$/m.exec(text)?.[1],labeller=/^Labeller: ([ABC])$/m.exec(text)?.[1];
  const rows={};
  for(const m of text.matchAll(/^### (row-[a-z0-9]+\.md)\nFlags: ([^\n]*)$/gm)) {
    if(own(rows,m[1])) fail('Duplicate bundle row');rows[m[1]]={needs_route:m[2].split(' ').includes('needs_route'),no_rename:m[2].split(' ').includes('no_rename')};
  }
  const families=[...text.matchAll(/^Family ([\w-]+):/gm)].map(m=>m[1]);
  if(!bundle || !labeller || !Object.keys(rows).length || !families.length) fail('Malformed bundle');
  return {bundle,labeller,rows,families};
}
export function check(text,result) {
  const spec=parseBundle(text),keys=Object.keys(spec.rows);
  if(!object(result) || result.version!==1) fail('Result requires a version 1 object');
  for(const k of Object.keys(result)) if(!['version','bundle','labeller',...FIELDS].includes(k)) fail(`Unexpected result field ${k}`);
  if(result.bundle!==spec.bundle || result.labeller!==spec.labeller) fail('Bundle or labeller mismatch');
  for(const name of FIELDS) {
    if(result[name]===undefined && !['kinds','confidence','lesson'].includes(name)) continue;
    if(!object(result[name])) fail(`${name} must be a map`);
    for(const id of Object.keys(result[name])) if(!own(spec.rows,id)) fail(`${name}: extra row ${id}`);
  }
  for(const id of keys) {
    const get=field=>result[field]?.[id],has=field=>own(result[field] ?? {},id);
    const error=message=>fail(`${id}: ${message}`);
    if(!KINDS.includes(get('kinds'))) error('missing or invalid kind');
    if(typeof get('confidence')!=='number' || !Number.isFinite(get('confidence')) || get('confidence')<0 || get('confidence')>1) error('missing or invalid confidence');
    if(typeof get('lesson')!=='boolean') error('missing or invalid lesson');
    if(has('cases') && !/^K(?:[0-9]|10)$/.test(get('cases'))) error('invalid case');
    if(has('trigger') && (!get('lesson') || typeof get('trigger')!=='string' || !/^(before|when) \S[^\r\n]*$/.test(get('trigger')))) error('trigger requires a lesson and before/when prefix');
    if(get('lesson')) {if(has('disposition') || has('reason')) error('disposition/reason only apply to non-lessons');}
    else {
      if(!['topic','brain','archive','other'].includes(get('disposition'))) error('non-lesson requires a disposition');
      if(get('disposition')!=='topic' && !has('reason')) error('non-topic disposition requires a reason');
      if(has('reason') && (typeof get('reason')!=='string' || !get('reason').trim() || get('reason').trim().split(/\s+/).length>20)) error('reason must be 1–20 words');
    }
    if(spec.rows[id].needs_route) {if(![...spec.families,'archive','none'].includes(get('route'))) error('needs_route requires a valid route');}
    else if(has('route')) error('route only applies to needs_route');
    if(spec.rows[id].no_rename) {if(typeof get('extract')!=='string' || /[\r\n]/.test(get('extract'))) error('no_rename requires a one-line extract or empty string');}
    else if(has('extract')) error('extract only applies to no_rename');
  }
  return result;
}

const labels = who => ({version:1,labeller:who,...Object.fromEntries(FIELDS.map(f=>[f,{}]))});
function kindsOnly(result,ids=Object.keys(result.kinds)) {
  return {version:1,...Object.fromEntries(['kinds','cases','confidence'].map(f=>[f,Object.fromEntries(ids.filter(id=>own(result[f],id)).map(id=>[id,result[f][id]]))]))};
}
function rowValues(result,id) {return Object.fromEntries(FIELDS.filter(f=>own(result[f],id)).map(f=>[f,result[f][id]]));}
export function merge({keyDir,out,bundles}) {
  const selected=bundles ? (Array.isArray(bundles)?bundles:bundles.split(',')) : null;
  if(selected && (!selected.length || selected.some(id=>!/^[-\w]+$/.test(id)) || new Set(selected).size!==selected.length)) fail('Invalid bundle selection');
  const key=readJSON(path.join(keyDir,'key.json')),reference=readJSON(path.join(keyDir,'holdout.json'));
  const totals={A:labels('A'),B:labels('B')};
  for(const who of ['A','B']) {
    const dir=path.join(out,'out',who),bundleDir=path.join(out,'bundles');
    const bundleFiles=fs.readdirSync(bundleDir).filter(f=>f.endsWith(`-${who}.md`) && (!selected || selected.includes(f.slice(0,-5)))).sort();
    if(selected && bundleFiles.length!==selected.length) fail('Unknown selected bundle');
    const expected=bundleFiles.map(f=>f.replace(`-${who}.md`,'.json')).sort();
    const actual=fs.readdirSync(dir).filter(f=>f.endsWith('.json') && (!selected || selected.includes(f.slice(0,-5)))).sort();
    if(JSON.stringify(expected)!==JSON.stringify(actual)) fail(`${who}: missing or extra bundle results`);
    const seen=new Set();
    for(const file of bundleFiles) {
      const result=check(read(path.join(bundleDir,file)),readJSON(path.join(dir,file.replace(`-${who}.md`,'.json'))));
      for(const id of Object.keys(result.kinds)) {if(seen.has(id) || !own(key,id)) fail(`${who}: duplicate or unknown row ${id}`);seen.add(id);}
      for(const f of FIELDS) Object.assign(totals[who][f],result[f] ?? {});
    }
    if(!selected && seen.size!==Object.keys(key).length) fail(`${who}: incomplete row coverage`);
  }
  if(selected) {
    reference.kinds=Object.fromEntries(Object.entries(reference.kinds).filter(([id])=>own(totals.A.kinds,id)));
    reference.unscored=reference.unscored.filter(id=>own(totals.A.kinds,id));
  }
  const referenceIds=[...Object.keys(reference.kinds),...reference.unscored];
  for(const id of referenceIds) if(!own(key,id)) fail('Unknown holdout reference row');
  const rates={},extras={};
  for(const who of ['A','B']) {
    const value=totals[who];
    const lessonIds=Object.keys(reference.kinds),negativeIds=reference.unscored;
    const lessonTrue=lessonIds.filter(id=>value.lesson[id]).length,negativeFalse=negativeIds.filter(id=>!value.lesson[id]).length;
    rates[who]={lessons:lessonIds.length,lesson_true:lessonTrue,lesson_true_rate:lessonIds.length?lessonTrue/lessonIds.length:null,
      negatives:negativeIds.length,lesson_false:negativeFalse,lesson_false_rate:negativeIds.length?negativeFalse/negativeIds.length:null};
    extras[who]=Object.fromEntries(FIELDS.filter(f=>!['kinds','cases','confidence'].includes(f)).map(f=>[f,value[f]]));
  }
  for(const who of ['A','B']) {
    write(path.join(out,`${who}.json`),totals[who]);write(path.join(out,`${who}.kinds.json`),kindsOnly(totals[who]));
    write(path.join(out,`${who}.holdout.kinds.json`),kindsOnly(totals[who],referenceIds));
  }
  write(path.join(out,'holdout.json'),reference);
  write(path.join(out,'extras.json'),extras);write(path.join(out,'lesson-holdout.json'),rates);
  return rates;
}
export function sheet({keyDir,out}) {
  const key=readJSON(path.join(keyDir,'key.json')),a=readJSON(path.join(out,'A.json')),b=readJSON(path.join(out,'B.json'));
  for(const value of [a,b]) if(JSON.stringify(Object.keys(value.kinds).sort())!==JSON.stringify(Object.keys(key).sort())) fail('Settlement needs complete merged labels');
  const rows=[],disagreements=Object.fromEntries(FIELDS.map(f=>[f,[]]));
  for(const [id,row] of Object.entries(key).filter(([,r])=>r.source==='ours').sort((a,b)=>a[1].file.localeCompare(b[1].file))) {
    const A=rowValues(a,id),B=rowValues(b,id),agreement={};
    const extractA=(A.extract ?? '').trim(),extractB=(B.extract ?? '').trim();
    if(A.lesson!==B.lesson) agreement.lesson=false;
    if(A.lesson===true && B.lesson===true && A.kinds!==B.kinds) agreement.kinds=false;
    if(A.lesson===false && B.lesson===false && (A.disposition ?? 'topic')!==(B.disposition ?? 'topic')) agreement.disposition=false;
    if(row.needs_route && A.route!==B.route) agreement.route=false;
    if(row.no_rename && Boolean(extractA)!==Boolean(extractB)) agreement.extract=false;
    const disputed=Object.keys(agreement),settled_by=disputed.length?'pending':'agree';
    const record={file:row.file,id,A,B,agreement,settled_by};
    if(!disputed.length) {
      // Non-lessons still need a provisional kind for the existing result schema.
      const final={lesson:A.lesson,kinds:A.kinds,confidence:Math.min(A.confidence,B.confidence)};
      if(!A.lesson) {final.disposition=A.disposition ?? 'topic';if(A.reason!==undefined) final.reason=A.reason;}
      if(row.needs_route) final.route=A.route;
      const kindCase=A.cases===B.cases ? A.cases : A.confidence>B.confidence ? A.cases : B.confidence>A.confidence ? B.cases : undefined;
      if(kindCase!==undefined) final.cases=kindCase;
      if(A.lesson && A.trigger && B.trigger) final.trigger=A.trigger.length<=B.trigger.length ? A.trigger : B.trigger;
      if(row.no_rename) final.extract=extractA && extractB ? (A.extract.length<=B.extract.length ? A.extract : B.extract) : '';
      record.final=final;
    }
    rows.push(record);
    for(const f of disputed) disagreements[f].push(`- ${row.file}: A ${JSON.stringify(A[f] ?? null)}; B ${JSON.stringify(B[f] ?? null)}`);
  }
  write(path.join(out,'settlement.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  write(path.join(out,'disagreements.md'),'# Pending settlement\n\n'+Object.entries(disagreements).filter(([,rows])=>rows.length).map(([f,rows])=>`## ${f}\n\n${rows.join('\n')}`).join('\n\n')+'\n');
  return rows;
}

const pending = row => ['pending','unclear'].includes(row.settled_by);
const finalValues = row => row.final ?? (row.settled_by==='agree' ? row.A : undefined);
const table = (heads,rows) => [heads,heads.map(()=>'---'),...rows].map(row=>'| '+row.map(v=>single(v).replaceAll('|','\\|')).join(' | ')+' |').join('\n');
function settlementInputs({keyDir,out}) {
  const key=readJSON(path.join(keyDir,'key.json'));
  const rows=read(path.join(out,'settlement.jsonl')).split(/\r?\n/).filter(s=>s.trim()).map(s=>JSON.parse(s));
  const seen=new Set();
  for(const row of rows) {
    if(!key[row.id] || key[row.id].source!=='ours' || key[row.id].file!==row.file || seen.has(row.id)) fail('Invalid settlement row identity');
    if(!object(row.A) || !object(row.B)) fail('Missing settlement readings');
    seen.add(row.id);
  }
  if(Object.entries(key).some(([id,r])=>r.source==='ours' && !seen.has(id))) fail('Incomplete settlement ledger');
  return {key,rows};
}
function savedBundles(out) {
  const renders=new Map();let header;
  for(const file of fs.readdirSync(path.join(out,'bundles')).filter(f=>f.endsWith('.md')).sort()) {
    const text=read(path.join(out,'bundles',file)),start=text.indexOf('\n## Rows\n');
    if(start<0) continue;
    header ??= text.slice(text.indexOf('\n\n')+2,start).trim();
    const matches=[...text.matchAll(/^### (row-[a-z0-9]+\.md)\nFlags: [^\n]*\n/gm)];
    for(let i=0;i<matches.length;i++) {
      const render=text.slice(matches[i].index,matches[i+1]?.index ?? text.length).trimEnd()+'\n\n';
      if(renders.has(matches[i][1]) && renders.get(matches[i][1])!==render) fail('Conflicting saved blind renders');
      renders.set(matches[i][1],render);
    }
  }
  if(!header) fail('Missing saved bundle header');
  return {header,renders};
}
function blindRow(saved,id) {
  const render=saved.renders.get(id);if(!render) fail(`Missing blind row ${id}`);return {id,render};
}
function saveSettlement(out,rows) {write(path.join(out,'settlement.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');}

export function disputes({keyDir,out,per=25}) {
  per=Number(per);if(!Number.isInteger(per) || per<1) fail('per must be a positive integer');
  const {key,rows}=settlementInputs({keyDir,out}),saved=savedBundles(out),selected=rows.filter(pending);
  const redact=redactor(Object.values(key).map(r=>r.file));
  const header=saved.header+
    '\n\n## Settlement job\nFor each row return {"final": {<field>: value...}, "settled_by": "case:Kn" | "test:s3" | "precedent:<lesson file>" | "unclear", "note": "<= 25 words"}. Return a JSON object {"version":1,"rows":{<id>:<decision>}}. Resolve lesson, kind, disposition and route in that order. Keep a trigger only when both proposals have compatible meaning; choose the shorter. Answer unclear rather than guess.\n'+
    'You may use memory-recall.mjs --memory-dir <reference memory> "<row title>" read-only. Cite the lesson file used as precedent.\n';
  const outputs=[];
  for(let i=0;i<selected.length;i+=per) {
    const body=selected.slice(i,i+per).map(row=>blindRow(saved,row.id).render+
      'Disagree: '+Object.keys(row.agreement ?? {}).filter(f=>row.agreement[f]===false).join(', ')+'\n\n'+
      table(['Field','A','B'],FIELDS.map(f=>[f,redact(JSON.stringify(row.A[f] ?? null)),redact(JSON.stringify(row.B[f] ?? null))]))+'\n\n').join('');
    outputs.push([`s${String(i/per+1).padStart(2,'0')}.md`,header+'\n\n## Rows\n\n'+body]);
  }
  const dir=path.join(out,'settle');fs.mkdirSync(dir,{recursive:true});
  for(const [name,text] of outputs) write(path.join(dir,name),text);
  for(const name of fs.readdirSync(dir)) if(/^s\d+\.md$/.test(name) && !outputs.some(([n])=>n===name)) fs.unlinkSync(path.join(dir,name));
  return {pending:selected.length,files:outputs.length};
}

export function third({keyDir,out,seed=20261110}) {
  seed=Number(seed);if(!Number.isInteger(seed) || seed<0 || seed>0xffffffff) fail('seed must be a uint32');
  const {key,rows}=settlementInputs({keyDir,out}),saved=savedBundles(out),random=rng(seed);
  const agreed=take(shuffle(rows.filter(r=>r.settled_by==='agree'),random),10,'agreed controls');
  const holdouts=take(shuffle(Object.entries(key).filter(([,r])=>r.source==='reference' && KINDS.includes(r.holdout_kind)),random),5,'hold-out controls');
  const mix={version:1,seed,rows:{}};
  for(const row of rows.filter(pending)) mix.rows[row.id]={role:'pending'};
  for(const row of agreed) mix.rows[row.id]={role:'agreed',expected:finalValues(row)};
  for(const [id,row] of holdouts) mix.rows[id]={role:'holdout',expected:{kinds:row.holdout_kind,lesson:true}};
  const selected=shuffle(Object.keys(mix.rows),random).map(id=>blindRow(saved,id));
  const text=bundleText('c01','C',saved.header,selected);
  // No role, previous label, real filename or control score goes in the blind bundle.
  write(path.join(out,'third','c01.md'),text);write(path.join(keyDir,'third-key.json'),mix);
  return {rows:selected.length,controls:15,pending:rows.filter(pending).length};
}

function validateFinal(values,id,key,saved) {
  if(!object(values)) fail('final must be an object');
  const result={version:1,bundle:'validation',labeller:'C'};
  for(const [f,value] of Object.entries(values)) {
    if(!FIELDS.includes(f)) fail(`Unexpected final field ${f}`);
    result[f]={[id]:value};
  }
  check(bundleText('validation','C',saved.header,[blindRow(saved,id)]),result);
}
function mayReplace(row,by) {
  return by==='operator' || (row.settled_by!=='operator' && ['pending','unclear','third'].includes(row.settled_by));
}
function thirdFinal(row,C,meta) {
  const {A,B}=row,voters=[A,B,C],ties=[];
  const disputed=field=>row.agreement?.[field]===false;
  const shortest=values=>values.reduce((a,b)=>a.length<=b.length?a:b);
  const majority=(read,eligible=voters)=> {
    for(const voter of eligible) {
      const pair=eligible.filter(other=>read(other)===read(voter));
      if(pair.length>=2) return {value:read(voter),pair:pair.slice(0,2)};
    }
    return null;
  };
  const lesson=disputed('lesson')?majority(v=>v.lesson)?.value:A.lesson;
  if(typeof lesson!=='boolean') ties.push('lesson');
  const final={lesson,kinds:A.kinds,confidence:Math.min(...voters.map(v=>v.confidence))};
  let casePair=[A,B];
  if(lesson) {
    if(disputed('kinds') || disputed('lesson')) {
      const vote=majority(v=>v.kinds,voters.filter(v=>v.lesson===true));
      if(!vote) ties.push('kinds');
      else {final.kinds=vote.value;casePair=vote.pair;}
    }
    const triggers=voters.filter(v=>v.lesson===true && v.trigger).map(v=>v.trigger);
    if(triggers.length>=2) final.trigger=shortest(triggers);
  } else if(lesson===false) {
    if(disputed('disposition') || disputed('lesson')) {
      const vote=majority(v=>v.disposition ?? 'topic',voters.filter(v=>v.lesson===false));
      if(!vote) ties.push('disposition');
      else {final.disposition=vote.value;casePair=vote.pair;}
    } else final.disposition=A.disposition ?? 'topic';
    // Preserve A's reason as sheet does; if A voted lesson, use the winning
    // non-lesson reading so a newly settled non-topic has a valid reason.
    const reason=A.reason ?? casePair.find(v=>v.lesson===false && v.reason)?.reason;
    if(reason!==undefined) final.reason=reason;
  }
  const [left,right]=casePair;
  const kindCase=left.cases===right.cases ? left.cases : left.confidence>right.confidence ? left.cases : right.confidence>left.confidence ? right.cases : undefined;
  if(kindCase!==undefined) final.cases=kindCase;
  if(meta.needs_route) {
    if(disputed('route')) {
      const vote=majority(v=>v.route);
      if(!vote) ties.push('route');else final.route=vote.value;
    } else final.route=A.route;
  }
  if(meta.no_rename) {
    const hasExtract=v=>Boolean(v.extract?.trim());
    if(disputed('extract')) {
      const vote=majority(hasExtract);
      final.extract=vote.value?shortest(vote.pair.map(v=>v.extract)):'';
    } else final.extract=hasExtract(A) && hasExtract(B)?shortest([A.extract,B.extract]):'';
  }
  return {final,ties};
}
export function settle({keyDir,out,decisions,fromThird=false}) {
  if(!Array.isArray(decisions) || !decisions.length) fail('At least one decision file required');
  const {key,rows}=settlementInputs({keyDir,out}),saved=savedBundles(out),byId=new Map(rows.map(r=>[r.id,r]));
  let log;
  if(fromThird) {
    if(decisions.length!==1) fail('Provide one complete Third result');
    const text=read(path.join(out,'third','c01.md')),result=check(text,readJSON(decisions[0]));
    const mix=readJSON(path.join(keyDir,'third-key.json'));
    if(mix.version!==1 || JSON.stringify(Object.keys(mix.rows).sort())!==JSON.stringify(Object.keys(result.kinds).sort())) fail('Third mix does not match result');
    let known=0,correct=0,kindCorrect=0,lessonCorrect=0;const lines=[];
    for(const id of Object.keys(result.kinds)) {
      const C=rowValues(Object.fromEntries(FIELDS.map(f=>[f,result[f] ?? {}])),id),row=byId.get(id),control=mix.rows[id];
      let outcome='control';
      if(control.role!=='pending') {
        known++;if(C.kinds===control.expected.kinds) kindCorrect++;if(C.lesson===control.expected.lesson) lessonCorrect++;
        if(Object.entries(control.expected).every(([f,v])=>C[f]===v)) correct++;
      }
      if(row) {
        row.C=C;
        if(control.role==='pending' && mayReplace(row,'third')) {
          const {final,ties}=thirdFinal(row,C,key[id]);
          if(!ties.length) try {validateFinal(final,id,key,saved);} catch {ties.push('conditional schema');}
          if(ties.length) {row.settled_by='pending';delete row.final;row.note='Missing majority: '+ties.join(', ');outcome=row.note;}
          else {row.final=final;row.settled_by='third';delete row.note;outcome='third';}
        } else if(control.role==='pending') outcome='preserved '+row.settled_by;
      }
      lines.push([id,JSON.stringify(row?.A ?? null),JSON.stringify(row?.B ?? null),JSON.stringify(C),outcome]);
    }
    if(known!==15) fail('Third requires exactly 15 known controls');
    log='# Third settlement\n\n'+`Known rows (all expected fields): ${correct}/${known}; kinds: ${kindCorrect}/${known}; lesson: ${lessonCorrect}/${known}.\n\n`+table(['ID','A','B','C','Outcome'],lines)+'\n';
  } else {
    for(const filename of decisions) {
      const input=readJSON(filename);
      if(!object(input) || input.version!==1 || !object(input.rows) || Object.keys(input).some(k=>!['version','rows'].includes(k))) fail('Expected version 1 decision rows');
      for(const [id,decision] of Object.entries(input.rows)) {
        const row=byId.get(id);if(!row) fail('Unknown decision row');
        if(!object(decision) || Object.keys(decision).some(f=>!['final','settled_by','note'].includes(f))) fail('Invalid decision');
        const by=decision.settled_by;
        if(typeof by!=='string' || !/^(?:case:K(?:[0-9]|10)|test:s3|precedent:lesson-[\w-]+\.md|unclear|operator)$/.test(by)) fail('Invalid settlement citation');
        if(typeof decision.note!=='string' || decision.note.trim().split(/\s+/).length>25 || /[\r\n]/.test(decision.note)) fail('note must be at most 25 words on one line');
        const final={...Object.fromEntries(FIELDS.filter(f=>row.A[f]===row.B[f] && row.A[f]!==undefined).map(f=>[f,row.A[f]])),...decision.final};
        if(by!=='unclear') {
          if(!object(decision.final)) fail('Missing final');
          // A full final object can intentionally omit optional fields from old readings.
          if(['kinds','lesson','confidence'].every(f=>own(decision.final,f))) {for(const f of Object.keys(final)) delete final[f];Object.assign(final,decision.final);}
          validateFinal(final,id,key,saved);
        }
        if(!mayReplace(row,by)) continue;
        row.note=decision.note;
        if(by==='unclear') {row.settled_by='pending';delete row.final;}
        else {row.final=final;row.settled_by=by;}
      }
    }
  }
  saveSettlement(out,rows);if(log!==undefined) write(path.join(out,'third-log.md'),log);
  return {rows:rows.length,pending:rows.filter(pending).length};
}

function familyProjection(census,memory,promote) {
  const families=[...new Set(census.flatMap(r=>r.route ?? []))].sort(),result=[];
  for(const family of families) {
    if(!/^[\w-]+$/.test(family)) fail('Invalid census family');
    const hot=read(path.join(memory,`INDEX-${family}.md`)).split(/(?<=\n)/);
    const first=hot.findIndex(line=>line.startsWith('- [') || /^\d+ older lessons:/.test(line));
    const header=hot.slice(0,first<0 ? hot.length : first).join(''),lines=new Map();
    for(const file of fs.readdirSync(memory).filter(f=>f===`INDEX-${family}-all.md` || new RegExp(`^INDEX-${escape(family)}-all-\\d+\\.md$`).test(f))) {
      for(const line of read(path.join(memory,file)).split(/(?<=\n)/)) if(line.startsWith('- [')) {
        for(const m of line.matchAll(/\]\(([^)]+\.md)\)/g)) lines.set(m[1],line);
      }
    }
    let projected=bytes(header);
    for(const row of census.filter(r=>(r.route ?? []).includes(family) && !own(promote,r.file))) {
      if(!lines.has(row.file)) fail('Missing member catalog line');projected+=bytes(lines.get(row.file));
    }
    result.push([family,projected,projected>8192?'OVER — TODO: brain/archive, remove a second route, or operator-approved split':'']);
  }
  return '# Family projection\n\n'+table(['Family','Projected hot bytes','>8192 / pending lawful move'],result)+'\n';
}
export function emit({keyDir,out,census,memory}) {
  const {key,rows}=settlementInputs({keyDir,out}),source=readJSON(census).rows,saved=savedBundles(out);
  if(!Array.isArray(source)) fail('census requires rows');
  const censusByFile=new Map(source.map(r=>[r.file,r])),promote={},extracts=[],groups={brain:[],archive:[],topic:[],other:[]},routes=[],decisions=[];
  const counts={rows:rows.length,lesson_true:0,lesson_false:0,kinds:Object.fromEntries(KINDS.map(k=>[k,0])),map_rows:0,extracts:0,dispositions:0,pending:0};
  for(const row of rows) {
    const meta=key[row.id],final=finalValues(row),entry=censusByFile.get(row.file);
    if(pending(row)) {
      counts.pending++;const title=entry?.name ?? /^name: (.*)$/m.exec(blindRow(saved,row.id).render)?.[1] ?? '';
      decisions.push([row.file,title,JSON.stringify(row.A),JSON.stringify(row.B),JSON.stringify(row.C ?? null),row.note || 'Case, reusable-takeaway test or cited precedent needed','TODO']);continue;
    }
    validateFinal(final,row.id,key,saved);counts[final.lesson?'lesson_true':'lesson_false']++;counts.kinds[final.kinds]++;
    if(final.lesson && CLASSES.includes(meta.class) && !meta.no_rename && !['chain-head','doc-referenced'].includes(meta.class) && !['archive','none'].includes(final.route)) {
      promote[row.file]={kind:final.kinds,...(meta.needs_route?{route:[final.route]}:{}),...(final.trigger?{trigger:final.trigger}:{}),...(final.cases?{case:final.cases}:{})};
    }
    if(meta.no_rename && final.extract?.trim()) {
      const rule=final.extract.trim(),family=meta.family?.[0] ?? (meta.needs_route?final.route:undefined);
      if(family && !['archive','none'].includes(family)) {
        extracts.push(`## ${rule}\nkind: ${final.kinds}\nroute: ${family}\ndescription: ${JSON.stringify(rule.slice(0,200))}\n\n**Rule.** ${rule}\nDetail: [[${row.file.replace(/\.md$/,'')}]].\n`);
      } else {
        decisions.push([row.file,rule,JSON.stringify(row.A),JSON.stringify(row.B),JSON.stringify(row.C ?? null),'extracted lesson needs a family','TODO']);
      }
    }
    if(!final.lesson) {groups[final.disposition].push([row.file,final.reason ?? '',meta.needs_route?final.route:meta.family.join(', ')]);counts.dispositions++;}
    if(meta.needs_route || meta.class==='orphan') {
      const inbound=entry?.inbound,files=Array.isArray(inbound)?inbound:inbound?.files ?? inbound?.sources ?? [];
      const topic=files.find(f=>typeof f==='string' && !/^(INDEX-|MEMORY\.|ARCHIVE\.)/.test(f));
      routes.push([row.file,final.route ?? meta.family.join(', '),topic ?? 'TODO — census inbound has no linking topic filenames']);
    }
  }
  const dates=Object.entries(promote).map(([file,settings])=> {
    const date=promotionDate(loadNote(memory,file),memory,settings);
    return [file,date?.date ?? '',date?.date_source ?? 'none'];
  });
  const dateCounts=Object.fromEntries(['map','metadata.date','body','git','modified','none'].map(source=>[source,dates.filter(row=>row[2]===source).length]));
  const projection=familyProjection(source,memory,promote)+'\n## Date preview\n\n'+table(['Source','Map rows'],Object.entries(dateCounts))+'\n\n'+table(['File','Date','Source'],dates)+'\n';
  const outputs={
    'promote-map.json':{version:1,promote},'extract-batch.md':extracts.join('\n'),
    'dispositions.md':'# Dispositions\n\n'+Object.entries(groups).map(([name,items])=>`## ${name}\n\n`+table(['File','Reason','Family'],items)).join('\n\n')+'\n\n## Orphans and unrouted rows\n\n'+table(['File','Settled route','Suggested linking topic'],routes)+'\n',
    'decision-table.md':'# Pending operator decisions\n\n'+table(['File','Title','A','B','C','Missing evidence','Recommendation'],decisions)+'\n',
    'family-projection.md':projection,
  };
  for(const [name,data] of Object.entries(outputs)) write(path.join(out,name),data);
  counts.map_rows=Object.keys(promote).length;counts.extracts=extracts.length;return counts;
}

export function main(argv=process.argv.slice(2)) {
  try {
    const [command,...args]=argv,options={};
    for(let i=0;i<args.length;i+=2) {
      if(command==='settle' && args[i]==='--from-third') {if(options['from-third']) fail('Duplicate option from-third');options['from-third']=true;i--;continue;}
      if(!/^--[a-z-]+$/.test(args[i]) || !args[i+1] || args[i+1].startsWith('--')) fail('Expected --option value pairs');
      const name=args[i].slice(2);
      if(command==='settle' && name==='decisions') {
        options.decisions ??=[];options.decisions.push(args[i+1]);
        while(args[i+2] && !args[i+2].startsWith('--')) {options.decisions.push(args[i+2]);i++;}
        continue;
      }
      if(own(options,name)) fail(`Duplicate option ${name}`);options[name]=args[i+1];
    }
    const required={build:['census','memory','reference','key-dir','out'],check:['bundle','result'],merge:['key-dir','out'],sheet:['key-dir','out'],disputes:['key-dir','out'],settle:['key-dir','out','decisions'],third:['key-dir','out'],emit:['key-dir','out','census','memory']}[command];
    if(!required) fail('Expected build, check, merge, sheet, disputes, settle, third or emit');
    for(const name of required) if(!options[name]) fail(`Missing --${name}`);
    const optional={merge:['bundles'],build:['seed'],disputes:['per'],settle:['from-third'],third:['seed']}[command] ?? [];
    for(const name of Object.keys(options)) if(!required.includes(name) && !optional.includes(name)) fail(`Unknown option --${name}`);
    const normalized={...options,keyDir:options['key-dir'],fromThird:options['from-third']};
    if(command==='build') {const report=build(normalized);console.log(`Built ${report.ours} project rows in ${report.bundles.length} bundles; ${report.sentinels} sentinels`);}
    if(command==='check') {check(read(options.bundle),readJSON(options.result));console.log('Valid bundle result');}
    if(command==='merge') {merge(normalized);console.log('Merged A and B');}
    if(command==='sheet') {const rows=sheet(normalized);console.log(`Settlement: ${rows.length} rows; ${rows.filter(r=>r.settled_by==='pending').length} pending`);}
    const commands={disputes,settle,third,emit};
    if(own(commands,command)) console.log(JSON.stringify(commands[command](normalized)));
    return 0;
  } catch(error) {console.error(`memory-label: ${error.message}`);return 1;}
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) process.exitCode=main();
