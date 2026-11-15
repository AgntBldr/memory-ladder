import fs from 'node:fs';
import path from 'node:path';
import {isDirect,loadConfig,memoryFiles,fmGet,requireMemory} from './lib.mjs';
import {isGenerated} from './memory-index.mjs';
import {buildCorpus,search} from './memory-recall.mjs';

const readJSON=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function context({memoryDir,repo}) {
  requireMemory(memoryDir);
  const configFile=repo && path.join(repo,'scripts/memory/memory.config.json');
  const config=configFile && fs.existsSync(configFile)?readJSON(configFile):loadConfig();
  const files=memoryFiles(memoryDir);
  return {files,corpus:buildCorpus({memoryDir,repo,config,files:files.filter(f=>!isGenerated(f.text))})};
}
const rank=(corpus,query,file)=>search(corpus,query,10).find(row=>row.path===file)?.rank ?? null;
export function selfQuery(file) {
  const prose=file.body.replace(/^#{1,6} .*$/gm,'').trim();
  const sentence=(prose.match(/[^.!?]+(?:[.!?](?=\s|$)|$)/g) ?? [])
    .map(s=>s.trim().replace(/\s+/g,' ')).find(s=>s.length>30) ?? '';
  return [String(fmGet(file.data,'description') ?? '').trim(),sentence.slice(0,200)].filter(Boolean).join(' ');
}
export function snapshot(options) {
  const {files,corpus}=context(options);
  return {version:1,k:10,rows:files.filter(f=>!['router','archive'].includes(f.special) && !isGenerated(f.text))
    .map(f=>{const query=selfQuery(f);return {file:f.file,query,rank:rank(corpus,query,f.file)};})};
}
export function compare({before,map,...options}) {
  const saved=typeof before==='string'?readJSON(before):before;
  if(saved?.version!==1 || saved.k!==10 || !Array.isArray(saved.rows) || saved.rows.some(r=>typeof r.file!=='string'||typeof r.query!=='string'||(r.rank!==null&&(!Number.isInteger(r.rank)||r.rank<1||r.rank>10)))) throw Error('Invalid self-recall snapshot');
  const names=new Map();
  if(map) {
    const input=typeof map==='string'?readJSON(map):map;
    if(input?.version!==1 || !Array.isArray(input.rows)) throw Error('Invalid promotion name map');
    for(const row of input.rows) {
      if(typeof row.old!=='string'||typeof row.new!=='string'||names.has(row.old)) throw Error('Invalid promotion name map row');
      names.set(row.old,row.new);
    }
  }
  const {corpus}=context(options);
  const rows=saved.rows.map(row=> {
    const file=names.get(row.file) ?? row.file,after=rank(corpus,row.query,file);
    return {file:row.file,current:file,before:row.rank,after,worse:(after??11)>(row.rank??11)};
  });
  return {version:1,queries:rows.length,regressions:rows.filter(r=>r.worse),rows};
}
export function main(argv=process.argv.slice(2)) {
  try {
    const [command,...rest]=argv,options={};
    if(!['snapshot','compare'].includes(command)) throw Error('Expected snapshot or compare');
    const allowed=command==='snapshot'?['memory-dir','repo','out']:['memory-dir','repo','before','map'];
    for(let i=0;i<rest.length;i+=2) {
      const key=rest[i].slice(2),value=rest[i+1];
      if(!rest[i].startsWith('--')||!allowed.includes(key)||!value||value.startsWith('--')||Object.hasOwn(options,key)) throw Error('Expected unique --option value pairs');
      options[key]=value;
    }
    for(const key of ['memory-dir','repo',command==='snapshot'?'out':'before']) if(!options[key]) throw Error(`Missing --${key}`);
    options.memoryDir=options['memory-dir'];
    if(command==='snapshot') {
      const result=snapshot(options);fs.mkdirSync(path.dirname(path.resolve(options.out)),{recursive:true});
      fs.writeFileSync(options.out,JSON.stringify(result,null,2)+'\n');console.log(`self-recall snapshot: ${result.rows.length} queries`);return 0;
    }
    const result=compare(options);console.log(JSON.stringify(result,null,2));return result.regressions.length?1:0;
  } catch(error) {console.error('memory-selfrecall: '+error.message);return 1;}
}
if(isDirect(import.meta.url)) process.exitCode=main();
