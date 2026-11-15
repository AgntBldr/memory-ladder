import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadConfig, read, memoryFiles, utf8Bytes, slash, mdLinks, wikilinks, cleanGitEnv} from './lib.mjs';
import {lessonIdentity, isGenerated, lessonField, routes, routerFamilies} from './memory-index.mjs';
import {runCheck} from './memory-check.mjs';
import {scanChains} from './memory-chains.mjs';

function run(bin, argv) {
  const result = spawnSync(bin, argv, {encoding:'utf8', maxBuffer:64 * 1024 * 1024, windowsHide:true, env:{...cleanGitEnv(), GIT_OPTIONAL_LOCKS:'0'}});
  if (result.error || result.status !== 0) throw result.error ?? Error(result.stderr.trim() || `Read-only subprocess exited ${result.status}`);
  return result.stdout;
}
const table = (headers, rows) => [headers, headers.map(()=>'---'), ...rows].map(row=>'| '+row.map(v=>String(v ?? '').replaceAll('|','\\|').replace(/[\r\n]/g,' ')).join(' | ')+' |').join('\n');

function main() {
  const opts={refs:[]},argv=process.argv.slice(2);
  for(let i=0;i<argv.length;i+=2) {
    const option=argv[i];
    if(!['--memory-dir','--repo','--out','--refs'].includes(option) || !argv[i+1] || argv[i+1].startsWith('--')) throw Error('Expected --memory-dir --repo --out and optional repeated --refs values');
    if(option==='--refs') opts.refs.push(argv[i+1]);else opts[option.slice(2)]=argv[i+1];
  }
  if (!opts['memory-dir'] || !opts.repo || !opts.out) throw Error('Required: --memory-dir --repo --out');
  const memoryDir = fs.realpathSync(opts['memory-dir']), repo = fs.realpathSync(opts.repo), out = path.resolve(opts.out);
  const files = memoryFiles(memoryDir), byFile = new Map(files.map(f=>[f.file,f]));
  const configFile=path.join(repo,'scripts/memory/memory.config.json');
  const config=fs.existsSync(configFile)?JSON.parse(read(configFile)):loadConfig();
  const gate=runCheck({memoryDir,repo,config,noGit:true});
  const git = (...argv)=>run('git',['-c','safe.directory='+slash(memoryDir),'-C',memoryDir,...argv]);
  let commit=null,log='';
  const gitDir=spawnSync('git',['-C',memoryDir,'rev-parse','--git-dir'],{encoding:'utf8',windowsHide:true,env:cleanGitEnv()});
  if(gitDir.status===0) {
    const head=spawnSync('git',['-C',memoryDir,'rev-parse','--verify','HEAD'],{encoding:'utf8',windowsHide:true,env:cleanGitEnv()});
    if(head.status===0) {commit=head.stdout.trim();log=git('-c','core.quotepath=false','log','--format=DATE:%cs','--name-only','--no-renames','--','*.md');}
  }
  const history = new Map();
  let date;
  for (const line of log.split(/\r?\n/)) {
    if (line.startsWith('DATE:')) date = line.slice(5);
    else if (byFile.has(line)) {
      const h = history.get(line) ?? {first:date,last:date};
      h.first = date; history.set(line,h);
    }
  }
  const aliases = new Map();
  for (const f of files) for (const key of [f.file,f.file.slice(0,-3),lessonField(f.data,'name')]) if (key) aliases.set(String(key).toLowerCase(),f.file);
  const links = text => [...mdLinks(text),...wikilinks(text)].map(x=>{
    let key = slash(x).split(/[#^]/)[0].replace(/^\.\//,'');
    try { key = decodeURIComponent(key); } catch {}
    return aliases.get(key.toLowerCase()) ?? key;
  });
  const outgoing = new Map(files.map(f=>[f.file,links(f.text)]));
  const scanned = scanChains(memoryDir,files), parts = new Map(scanned.parts.map(p=>[p.file,p]));
  const signals = new Map();
  for (const f of files) {
    const naming = /^(.+)-background(?:-(\d+))?\.md$/.exec(f.file);
    const declared = lessonField(f.data,'parent');
    const first = /^Part (\d+) of \[[^\]]*\]\(([^)]+)\)/.exec(f.body.trimStart().split(/\r?\n/)[0]);
    const present = [naming && 'filename',declared && 'parent',first && 'body'].filter(Boolean);
    if (parts.has(f.file) && !naming && /-(?:part-)?\d+\.md$/.test(f.file)) present.push('kit-filename');
    signals.set(f.file,present);
    if (!parts.has(f.file) && (naming || declared || first)) parts.set(f.file,{file:f.file,parent:declared || first?.[2] || naming[1]+'.md',n:first ? Number(first[1]) : naming ? Number(naming[2] ?? 1) : null});
  }
  const heads = new Set([...parts.values()].map(p=>p.parent));
  const external = new Map(files.map(f=>[f.file,[]]));
  const seen=new Set();
  function walk(rel) {
    const absolute = path.resolve(repo,rel);
    if(seen.has(absolute)) return;seen.add(absolute);
    if (!fs.existsSync(absolute)) return;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const e of fs.readdirSync(absolute).sort()) if (!['node_modules','.git'].includes(e)) {
        const next = slash(path.join(rel,e));
        walk(next);
      }
    } else if (stat.isFile()) {
      const raw = fs.readFileSync(absolute);
      if (raw.includes(0)) return;
      const text = raw.toString('utf8');
      for (const f of files) if (text.includes(f.file)) external.get(f.file).push(slash(path.relative(repo,absolute)));
    }
  }
  for (const root of ['AGENTS.md','CLAUDE.md','scripts','.claude','docs',config.brain?.dir ?? 'brain',...opts.refs]) walk(root);
  const probes = read(path.join(repo,'scripts/memory/recall-probes.json'));
  const rows = files.map(f=>{
    const field = key=>lessonField(f.data,key), p = parts.get(f.file), h = history.get(f.file);
    const dateValue = /^\d{4}-\d{2}-\d{2}/.exec(String(f.data.metadata?.date ?? ''))?.[0];
    const modified = /^\d{4}-\d{2}-\d{2}/.exec(String(f.data.metadata?.modified ?? ''))?.[0];
    const flags = {router:f.special==='router',generated_index:f.special==='index' && isGenerated(f.text),index_support:/^(index-notes-|memory-contents-|memory-block-)/.test(f.file),archive:f.special==='archive',state:f.state,hard_rule:f.hardRule,stub:f.stub,lesson_file:Boolean(lessonIdentity(f.file))};
    const sources = files.filter(s=>s.file!==f.file && outgoing.get(s.file).includes(f.file));
    const ext = [...new Set(external.get(f.file))].sort();
    const checks = [...new Set(gate.findings.filter(g=>slash(g.file)===f.file).map(g=>g.check))].sort();
    const type = field('type') ?? 'missing', route = [...new Set(routes(f.data))].sort();
    const cls = flags.router || flags.generated_index || flags.archive ? 'system' : flags.index_support ? 'index-support' : flags.state ? 'state' : flags.hard_rule ? 'hard-rule' : /roadmap-(forward|history|archive|wave)/.test(f.file) ? 'roadmap' : p ? 'chain-part' : heads.has(f.file) ? 'chain-head' : ext.length ? 'doc-referenced' : type==='feedback' && route.length ? 'candidate-routed' : checks.includes('link.orphan') ? 'orphan' : type==='feedback' ? 'candidate-unrouted' : 'other-'+type;
    return {file:f.file,name:field('name') ?? null,bytes:f.bytes,type,route,description_chars:String(field('description') ?? '').length,date:dateValue ?? modified ?? h?.first ?? null,date_source:dateValue ? 'date' : modified ? 'modified' : h ? 'git' : 'none',first_commit:h?.first ?? null,last_commit:h?.last ?? null,flags,chain:{role:p ? 'part' : heads.has(f.file) ? 'parent' : 'none',head:p?.parent ?? (heads.has(f.file) ? f.file : null),part:p?.n ?? null,signals:signals.get(f.file)},inbound:{files:sources.filter(s=>!isGenerated(s.text)).map(s=>s.file),count:sources.filter(s=>!isGenerated(s.text)).length,from_router:sources.some(s=>s.special==='router'),from_index:sources.some(s=>s.special==='index' && isGenerated(s.text)),from_archive:sources.some(s=>s.special==='archive')},outbound_links:outgoing.get(f.file).length,ext_refs:ext.slice(0,5),ext_ref_count:ext.length,in_probes:probes.includes(f.file),gate:checks,class:cls};
  }).sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0);
  const classes = new Map();
  for (const r of rows) classes.set(r.class,(classes.get(r.class) ?? 0)+1);
  const families = new Set([...routerFamilies(byFile.get('MEMORY.md')?.text ?? '',memoryDir).keys(),...rows.flatMap(r=>r.route)]);
  const projections = [...families].sort().map(family=>{
    const members = rows.filter(r=>r.route.includes(family) && !byFile.get(r.file).special), candidates = members.filter(r=>r.class==='candidate-routed');
    const non = members.filter(r=>r.class!=='candidate-routed');
    const hot = byFile.get(`INDEX-${family}.md`);
    if (!hot) throw Error('Missing hot page for route family');
    const header = hot.text.split(/(?<=\n)/).slice(0,((i)=>i<0?undefined:i)(hot.text.split(/(?<=\n)/).findIndex(line=>line.startsWith('- [') || /^\d+ older lessons:/.test(line)))).join('');
    const catalogLines = new Map();
    for (const f of files.filter(f=>f.file===`INDEX-${family}-all.md` || f.file.startsWith(`INDEX-${family}-all-`))) {
      for (const line of f.text.split(/(?<=\n)/)) if (line.startsWith('- [')) for (const target of mdLinks(line)) catalogLines.set(target,line);
    }
    if (members.some(r=>!catalogLines.has(r.file))) throw Error('Missing member catalog line');
    const projected = utf8Bytes(header)+non.reduce((n,r)=>n+utf8Bytes(catalogLines.get(r.file)),0);
    return [family,members.length,candidates.length,non.length,hot.bytes,projected,projected>8192?'OVER':''];
  });
  const byRow = new Map(rows.map(r=>[r.file,r]));
  const chainRows = [...heads].sort().map(head=>[head,byRow.get(head)?.class ?? 'missing',[...parts.values()].filter(p=>p.parent===head).sort((a,b)=>(a.n ?? Infinity)-(b.n ?? Infinity)||a.file.localeCompare(b.file)).map(p=>p.file).join(', '),[...parts.values()].filter(p=>p.parent===head).sort((a,b)=>(a.n ?? Infinity)-(b.n ?? Infinity)||a.file.localeCompare(b.file)).map(p=>p.file+': '+signals.get(p.file).join('+')).join('; ')]);
  const summary = [table(['Class','Count'],[...classes].sort().concat([['TOTAL',rows.length]])),table(['Route family','Members','Candidates','Non-candidates','Current hot bytes','Projected hot bytes','>8192'],projections),table(['Chain head','Head class','Parts in order','Signals'],chainRows),table(['Orphan / candidate-unrouted file','Type','Bytes','Inbound','Description chars'],rows.filter(r=>['orphan','candidate-unrouted'].includes(r.class)).map(r=>[r.file,r.type,r.bytes,r.inbound.count,r.description_chars])),table(['Doc-referenced file','First external reference'],rows.filter(r=>r.class==='doc-referenced').map(r=>[r.file,r.ext_refs[0]])),table(['Date coverage','Count'],[['date_source none',rows.filter(r=>r.date_source==='none').length]])].join('\n\n')+'\n';
  fs.mkdirSync(out,{recursive:true});
  for (const name of ['census.json','census-summary.md']) if (fs.existsSync(path.join(out,name)) && fs.lstatSync(path.join(out,name)).isSymbolicLink()) throw Error('Output file cannot be a link');
  fs.writeFileSync(path.join(out,'census.json'),JSON.stringify({generated_at:new Date().toISOString(),memory_dir_commit:commit,rows},null,2)+'\n');
  fs.writeFileSync(path.join(out,'census-summary.md'),summary);
  console.log(JSON.stringify({rows:rows.length,classes:Object.fromEntries([...classes].sort()),projections,gate_counts:{fail:gate.findings.filter(f=>f.severity==='FAIL' && !f.allowed).length,warn:gate.findings.filter(f=>f.severity==='WARN' && !f.allowed).length},date_source_none:rows.filter(r=>r.date_source==='none').length}));
}
try { main(); } catch (error) { console.error('Census failed: '+error.message); process.exitCode=1; }
