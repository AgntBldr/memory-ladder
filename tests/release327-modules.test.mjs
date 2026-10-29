import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guard = () => import('../engine/memory-guard.mjs');
const chains = () => import('../engine/memory-chains.mjs');
const chars = () => import('../engine/memory-chars.mjs');
const config = () => JSON.parse(fs.readFileSync(path.join(root, 'engine/memory.config.json'), 'utf8'));
const nl = String.fromCharCode(10), bt = String.fromCharCode(96);
const damaged = (...points) => String.fromCodePoint(...points);
const dash = damaged(0xe2, 0x20ac, 0x201d);
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modules327-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const put = (name, text) => { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, text); return file; };
  put('MEMORY.md', '# Memory\n');
  return {dir, put, read: name => fs.readFileSync(path.join(dir, name), 'utf8')};
}
function rulesFixture(t, overrides = []) {
  const f = fixture(t);
  f.put('scripts/memory/enforce-rules.kit.json', fs.readFileSync(path.join(root, 'engine/enforce-rules.kit.json')));
  f.put('scripts/memory/enforce-rules.json', JSON.stringify({version:1, rules:overrides}));
  return f;
}
function cli(module, argv, input) {
  const r = spawnSync(process.execPath, [path.join(root, 'engine', module + '.mjs'), ...argv], {input, encoding:'utf8', timeout:10000, windowsHide:true});
  assert.ifError(r.error); return r;
}
const context = r => JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
const hook = (f, command, tool_name = 'Bash') => cli('memory-guard', ['pretooluse', '--repo', f.dir], JSON.stringify({tool_name, tool_input:{command}, cwd:f.dir}));
const positives = [
  ['inline-script-path', `node -e "require('/d/work/check.mjs')"`],
  ['inline-script-path', String.raw`node -e "fs.readFileSync('D:\\work\\note.md')"`],
  ['inline-script-path', `node -e "console.log(${bt}value${bt})"`],
  ['inline-script-path', String.raw`python -c "open('D:\\work\\note')"`],
  ['inline-script-path', `node -e 'require("/d/work/check.mjs")'`],
  ['inline-script-path', `node --input-type=module -e "import('/d/work/check.mjs')"`],
  ...[
    'node check.mjs | tail -1 && git commit -m checked',
    'node check.mjs 2>&1 | tail -4 && git push',
    "npm test | grep -E '^# (pass|fail)' && git push origin main",
    "node scripts/audit.mjs | tail -1 && node --test tests/unit.test.mjs | grep -E '^# (tests|pass|fail)' && git commit && git push",
    'node check.mjs | tail -1 && git -C repo push',
    'node check.mjs | tail -1 && git add -A && git commit -m checked',
    'node check.mjs | tail -1 || git push',
    'node check.mjs | tail -1 &&' + nl + 'git push',
    'node check.mjs | tail -1 && git -C "dir with space" push',
  ].map(c => ['piped-gate', c]),
  ...[
    'node check.mjs | Select-Object -Last 1; if ($?) { git push }',
    'npm test | select -Last 20; git commit -m checked',
    'node check.mjs | Select-Object -Last 1 && git push',
    'node check.mjs | Select-Object -Last 1; & git push',
    'node check.mjs | Select-Object -Last 1; git.exe push',
    'npm test | Out-String; git -C "dir with space" push',
  ].map(c => ['piped-gate-ps', c, 'PowerShell']),
];
const benign = [
  'pnpm install --frozen-lockfile', 'pnpm test', 'pnpm -r typecheck', 'pnpm lint | tail -20',
  'pnpm build | tee build.log', 'pnpm exec prettier --check .', 'pnpm dev', 'pnpm list --depth 0',
  'npm ci', 'npm run build', 'npm run lint | head -30', 'npm run check | grep warning',
  'npm test && git push', 'npm test | tail -20 && echo ok', 'npm run docs -- --out D:/work/docs',
  'git status --porcelain | wc -l && git commit -m checked', 'git diff | head -50 && git add .',
  'git fetch origin | tail -5 && git commit -m fetched', 'git log --oneline | head -3',
  'git log | tail -5', 'git -C repo log | head -2 && echo ok', 'git diff --check',
  'git show HEAD:package.json', 'git branch --show-current', 'git ls-files', 'git rev-parse HEAD',
  'git commit -F D:/work/message.txt', String.raw`git commit -m "fix D:\work path"`,
  String.raw`git commit -m "docs: never run node -e with D:\work paths"`,
  "git commit -F - <<'MSG'" + nl + 'Document the release.' + nl + 'MSG',
  'gh pr view 12 --json state | head -c 200', 'gh pr list', 'gh issue list --state open',
  'gh run view 12 --log | tail -20', 'gh repo view',
  'node scripts/check.mjs D:/work/input.md', 'node scripts/build.mjs --out D:/work/dist',
  'node scripts/memory/memory-lesson.mjs new --kind mistake --route build "Test first"',
  'node scripts/memory/memory-guard.mjs test D:/work/command.txt',
  'node -e "console.log(process.version)"', 'node -p "1+1"',
  'python -c "import json;print(1)"', 'node -e "x" > /d/work/out.txt',
  'node -e "console.log(' + String.fromCharCode(92) + bt + 'value' + String.fromCharCode(92) + bt + ')"',
  `node -e 'console.log(${bt}value${bt})'`, 'node -e "console.log(a/b/c)"',
  'node -e "fetch(\'https://example.invalid/a/b\')"', 'node -e "require(\'./a/b\')"',
  'node -e "require(\'/D/work/a\')"', 'node -e "console.log(\'prefixD:\\work\')"',
  'node check.mjs | tail -1; git push', 'node check.mjs | tail -1' + nl + 'git push',
  'node check.mjs | tail -1 && echo done', 'set -o pipefail; node check.mjs | tail -1 && git push',
  'grep -q TODO note.md && git commit -m checked', 'cat report.txt | head -5 && git commit -m checked',
  'ls docs | sort && git commit -m checked', 'echo ok | tee log && git push',
  'printf ok | tail -1 && git push', 'sed -n 1p note.md | head -1 && git push',
];
for (const [id, command, tool = 'Bash'] of positives) test('327 guard positive ' + id + ' ' + positives.findIndex(x => x[1] === command), async t => {
  const f = rulesFixture(t), {loadRules, matchRules} = await guard();
  assert.ok(matchRules(loadRules({repo:f.dir}).rules, command, tool).some(r => r.id === id));
});
test('327 guard benign corpus has at least 50 commands and zero hits', async t => {
  const f = rulesFixture(t), {loadRules, matchRules} = await guard();
  assert.ok(benign.length >= 50);
  for (const command of benign) assert.deepEqual(matchRules(loadRules({repo:f.dir}).rules, command, 'Bash').map(r => r.id), [], command);
  for (const command of ['git log | Select-Object -First 3', 'npm test; git push', 'node check.mjs | Select-Object -Last 1; Write-Host ok']) assert.deepEqual(matchRules(loadRules({repo:f.dir}).rules, command, 'PowerShell'), []);
});
test('327 guard starter warn, deny override lessons, off and tool isolation', t => {
  const f = rulesFixture(t), c = positives[0][1];
  let r = hook(f,c); assert.equal(r.status,0); assert.match(context(r), /rule inline-script-path/);
  f.put('scripts/memory/enforce-rules.json', JSON.stringify({version:1,rules:[{id:'inline-script-path',action:'deny',lesson:['802','803']}]}));
  r=hook(f,c); assert.equal(r.status,2); assert.match(r.stderr,/lesson #802, #803/); assert.match(r.stderr,/If the matched text is only inside a commit message or heredoc, write it to a file and pass the file\./);
  for (const tool of ['PowerShell','Read']) { r=hook(f,c,tool); assert.equal(r.status,0); assert.equal(r.stdout,''); }
  f.put('scripts/memory/enforce-rules.json', JSON.stringify({version:1,rules:[{id:'inline-script-path',action:'off'},{id:'piped-gate-ps',action:'deny'}]}));
  assert.equal(hook(f,c).stdout,''); assert.equal(hook(f,positives.at(-1)[1],'PowerShell').status,2);
});
for (const mode of ['stdin','missing','json','regex']) test('327 guard fails open ' + mode, t => {
  const f=rulesFixture(t);
  if(mode==='missing') fs.unlinkSync(path.join(f.dir,'scripts/memory/enforce-rules.json'));
  if(mode==='json') f.put('scripts/memory/enforce-rules.json','{');
  if(mode==='regex') f.put('scripts/memory/enforce-rules.json',JSON.stringify({version:1,rules:[{id:'bad',pattern:'[',action:'deny',message:'bad'}]}));
  const r=mode==='stdin'?cli('memory-guard',['pretooluse','--repo',f.dir],'{'):hook(f,positives[0][1]);
  assert.equal(r.status,0);
  if(mode==='missing') { assert.doesNotMatch(context(r),/skipped|ENOENT/); assert.match(context(r),/rule inline-script-path/); }
  else assert.match(context(r),/memory guard: skipped .*; run the memory gate/);
  if(mode==='regex') assert.match(context(r),/rule inline-script-path/);
});
test('327 loadRules validation skips invalid entries and retains valid rules', async t => {
  const f=rulesFixture(t), {loadRules}=await guard();
  const invalid=[{id:'duplicate'},{id:'duplicate'},{id:'action',action:'block'},{id:'empty',pattern:'a*'},{id:'unless',unless:'a*'},{id:'compile',pattern:'['},{id:'tools',tools:['Read']},{id:'Bad'},{id:'message',message:''}];
  f.put('scripts/memory/enforce-rules.json',JSON.stringify({version:1,rules:invalid.map(r=>({action:'deny',pattern:'hazard',message:'hazard',...r}))}));
  const result=loadRules({repo:f.dir}); assert.equal(result.rules.length,3); assert.ok(result.errors.length>=8);
  assert.match(JSON.stringify(result.errors),/empty string/);
});
test('327 guard prompt, test PATH, replay text and JSONL, performance', async t => {
  const f=rulesFixture(t);
  assert.match(cli('memory-guard',['prompt']).stdout.trim(),/^clock: \d{4}-\d{2}-\d{2} \d{2}:\d{2} local \([+-]\d{2}:\d{2}\) \| \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
  const file=f.put('commands.txt',positives[0][1]);
  assert.match(cli('memory-guard',['test',file,'--repo',f.dir]).stdout,/match: inline-script-path \(warn\)/);
  assert.match(cli('memory-guard',['test',file,'--tool','PowerShell','--repo',f.dir]).stdout,/no rule matches/);
  for(const content of [[...benign,positives[0][1]].join(nl), [...benign,positives[0][1]].map(command=>JSON.stringify({command})).join(nl)]) {
    f.put('commands.txt',content); const r=cli('memory-guard',['replay',file,'--repo',f.dir]); assert.equal(r.status,0); assert.match(r.stdout,/inline-script-path: 1\//); assert.match(r.stdout,/%/);
  }
  const {loadRules,matchRules,replay}=await guard(), rules=loadRules({repo:f.dir}).rules;
  const replayed=replay(rules,Array.from({length:25},()=>JSON.stringify({command:positives[0][1]})).join(nl));
  assert.equal(replayed[0].count,25); assert.equal(replayed[0].hits.length,20); assert.equal(replayed[0].rate,100);
  assert.ok(replay(rules,'{ npm test; }'+nl+positives[0][1]).some(r=>r.id==='inline-script-path' && r.count===1 && r.total===2));
  const start=performance.now(); matchRules(rules,'node check.mjs | tail -1 && git '+Array.from({length:100},(_,i)=>'-x'+i).join(' ')+' log','Bash');
  assert.ok(performance.now()-start<1000);
  const at=performance.now(); hook(f,positives[0][1]); t.diagnostic('guard one-command process runtime ms: '+(performance.now()-at).toFixed(2));
});
test('327 installed guard finds adjacent kit rules and manifest classification', async t => {
  const f=fixture(t), {ownedFiles,installedPath}=await import('../scripts/manifest.mjs');
  assert.ok(ownedFiles(root).includes('engine/enforce-rules.kit.json'));
  assert.equal(installedPath('engine/enforce-rules.kit.json'),'scripts/memory/enforce-rules.kit.json');
  assert.ok(!ownedFiles(root).includes('templates/enforce-rules.json')); assert.ok(!ownedFiles(root).includes('templates/settings.guard.json'));
  const settings=JSON.parse(fs.readFileSync(path.join(root,'templates/settings.guard.json'),'utf8'));
  assert.equal(settings.hooks.PreToolUse[0].matcher,'Bash|PowerShell');
  for(const name of ['PreToolUse','UserPromptSubmit']) { const h=settings.hooks[name][0].hooks[0]; assert.equal(h.timeout,5); assert.equal(h.shell,'bash'); assert.match(h.command,/memory-guard\.mjs/); }
  const starter=JSON.parse(fs.readFileSync(path.join(root,'engine/enforce-rules.kit.json'),'utf8'));
  assert.equal(starter.rules.length,3); assert.ok(starter.rules.every(r=>r.action==='warn' && r.lesson===undefined));
  for(const file of ['memory-guard.mjs','lib.mjs','enforce-rules.kit.json','memory.config.json']) f.put('scripts/memory/'+file,fs.readFileSync(path.join(root,'engine',file)));
  f.put('scripts/memory/enforce-rules.json','{"version":1,"rules":[]}');
  const r=spawnSync(process.execPath,[path.join(f.dir,'scripts/memory/memory-guard.mjs'),'pretooluse','--repo',f.dir],{input:JSON.stringify({tool_name:'Bash',tool_input:{command:positives[0][1]}}),encoding:'utf8'});
  assert.equal(r.status,0); assert.match(context(r),/rule inline-script-path/); assert.doesNotMatch(context(r),/skipped/);
});
test('327 chains precedence, parent stub, exclusions, gaps, numbering and parent order', async t => {
  const f=fixture(t), {scanChains}=await chains();
  f.put('x.md','# Parent\n[third](x-part-03.md)\n[first](x-background.md)\n');
  f.put('x-background.md','body\n'); f.put('x-background-2.md','Part 9 of [x](x.md).\n'); f.put('x-part-03.md','body\n'); f.put('x-5.md','body\n');
  f.put('stub.md','---\nmoved_to: x.md\n---\n[p](detail-part-01.md)\n');
  f.put('detail-part-01.md','---\nparent: stub.md\n---\nbody\n');
  f.put('orphan-2.md','---\nparent: absent.md\n---\nbody\n');
  f.put('dated-2026-10-27.md','body\n'); f.put('lesson-001-rule.md','body\n'); f.put('lesson-001-rule-background.md','body\n');
  f.put('x-6.md','---\nstate: true\n---\nbody\n'); f.put('x-7.md','body\n'); f.put('MEMORY.md','# Memory\n## Hard rules\n[rule](x-7.md)\n');
  f.put('x-8.md','<!-- generated by memory-index.mjs; edit the lessons, not this file -->\n');
  f.put('missing-background.md','body\n'); f.put('missing-background-2.md','body\n');
  const r=scanChains(f.dir);
  assert.deepEqual(r.parts.map(p=>[p.file,p.parent,p.n]).sort(),[['detail-part-01.md','stub.md',1],['x-5.md','x.md',5],['x-background-2.md','x.md',2],['x-background.md','x.md',1],['x-part-03.md','x.md',3]].sort());
  for(const kind of ['backlink','number','gap','parent-missing','parent-order']) assert.ok(r.problems.some(p=>p.kind===kind),kind);
  f.put('x-9.md','---\nparent: absent.md\n---\nBody.\n');
  const fallback=scanChains(f.dir); assert.ok(fallback.parts.some(p=>p.file==='x-9.md' && p.parent==='x.md' && p.n===9));
  assert.ok(fallback.problems.some(p=>p.file==='x-9.md' && p.kind==='parent-missing'));
});
test('327 chain repair insertion proof BOM CRLF, dry run, idempotence and cap refusal', async t => {
  const f=fixture(t), {repairChains}=await chains(), original='\uFEFF---\r\nname: Part\r\n---\r\nOriginal body.\r\n';
  f.put('x.md','[part](x-part-01.md)\n'); f.put('x-part-01.md',original);
  repairChains({memoryDir:f.dir}); assert.equal(f.read('x-part-01.md'),original);
  repairChains({memoryDir:f.dir,write:true});
  const k=original.indexOf('Original'), next=f.read('x-part-01.md'); assert.equal(next,original.slice(0,k)+'Part 1 of [x](x.md).\r\n\r\n'+original.slice(k));
  repairChains({memoryDir:f.dir,write:true}); assert.equal(f.read('x-part-01.md'),next);
  f.put('x-part-01.md',original); const c=config(); c.caps.topic.failBytes=Buffer.byteLength(original)+1;
  assert.ok(repairChains({memoryDir:f.dir,write:true,config:c}).problems.some(p=>p.kind==='size-cap')); assert.equal(f.read('x-part-01.md'),original);
});
test('327 lines packs sentences with exact proof and protects special lines and verbatim', async t => {
  const f=fixture(t), {scanLines,repairLines}=await chains();
  const paragraph=Array.from({length:100},()=> 'A sentence with enough text.').join(' ');
  const original='\uFEFF---\r\nname: Topic\r\n---\r\n'+paragraph+'\r\n```\n'+paragraph+'\n```\n| '+paragraph+' |\n- '+paragraph+'\n  '+paragraph+'\n> '+paragraph+'\n# '+paragraph+'\n<!-- BEGIN VERBATIM PAYLOAD -->\n'+paragraph+'\n<!-- END VERBATIM PAYLOAD -->\n'+'x'.repeat(2500)+'\n';
  f.put('topic.md',original); const r=scanLines(f.dir,2000).find(x=>x.file==='topic.md'); assert.equal(r.repairable,1); assert.equal(r.protected,2); assert.equal(r.long,7);
  repairLines({memoryDir:f.dir,write:true,max:2000}); const next=f.read('topic.md');
  const start=original.indexOf(paragraph), end=next.indexOf('\r\n```'); const recut=next.slice(start,end);
  assert.equal(recut.replace(/\r?\n/g,' '),paragraph); assert.ok(recut.split(/\r?\n/).every(l=>l.length<=2000));
  assert.equal(next.slice(0,start),original.slice(0,start)); assert.equal(next.slice(end),original.slice(start+paragraph.length));
  repairLines({memoryDir:f.dir,write:true,max:2000}); assert.equal(f.read('topic.md'),next);
});
test('327 chars C2 C3 E2, undecodable, code skipping, line aggregation and names', async () => {
  const {scanChars,decodeRun,cp1252}=await chars(); assert.equal(cp1252.size,27);
  for(const [bad,good] of [[damaged(0xc2,0xab),damaged(0xab)],[damaged(0xc3,0xb8),damaged(0xf8)],[dash,damaged(0x2014)]]) assert.equal(decodeRun(bad),good);
  assert.equal(decodeRun(damaged(0xc2,0x80)),null);
  const r=scanChars(dash+' '+dash+'\n'+damaged(0xe2,0x20ac)+'"\n'+damaged(0xfffd)+'\nword ? word\n```\n'+dash+'\n```\n'+bt+dash+bt+'\n');
  assert.equal(r.find(x=>x.check==='chars.mojibake').value,2); assert.match(r.find(x=>x.check==='chars.mojibake').message,/U\+2014 EM DASH/);
  assert.ok(r.some(x=>x.check==='chars.replacement')); assert.ok(r.some(x=>x.check==='chars.lost-dash'));
  assert.match(JSON.stringify(scanChars(damaged(0xe2,0x20ac)+'"')),/undecodable/);
});
test('327 chars repair deliberate examples, allow entries, mixed EOL and conservation', async t => {
  const f=fixture(t), {repairChars}=await chars();
  const protectedLines=['mojibake','cp1252','Windows-1252','U+FFFD','encoding'].map(x=>x+' '+dash);
  const original='\uFEFF'+dash+'\r\n'+protectedLines.join('\n')+'\r\n'+dash+' '+damaged(0x2014)+'\n'+bt+dash+bt+'\r\n~~~\n'+dash+'\n~~~\n';
  f.put('topic.md',original); f.put('allowed.md',dash+'\n'); f.put('metadata.md','---\nname: '+dash+'\n---\nClean body.\n');
  const c=config(); c.allow.push({check:'chars.mojibake',file:'allowed.md',reason:'example',added:'2026-10-28'});
  repairChars({memoryDir:f.dir,config:c}); assert.equal(f.read('topic.md'),original);
  const r=repairChars({memoryDir:f.dir,config:c,write:true}); assert.equal(f.read('topic.md'),original.replace(dash,damaged(0x2014))); assert.equal(f.read('allowed.md'),dash+'\n'); assert.ok(r.items.some(x=>x.reportOnly));
  assert.equal(f.read('metadata.md'),'---\nname: '+damaged(0x2014)+'\n---\nClean body.\n');
});
for(const module of ['chars','chains','lines']) test('327 '+module+' regeneration failure restores all snapshots', async t => {
  const f=fixture(t); f.put('MEMORY.md','# Memory\n- [build](INDEX-build.md) BEFORE building\n'); f.put('INDEX-build.md','handwritten page\n');
  const original=module==='chars'?dash+'\n':module==='chains'?'Body.\n':Array.from({length:100},()=> 'A sentence with enough text.').join(' ')+'\n';
  f.put('x.md','[part](x-1.md)\n'); f.put('x-1.md',original);
  const api=module==='chars'?await chars():await chains(), fn=api[module==='chars'?'repairChars':module==='chains'?'repairChains':'repairLines'];
  assert.throws(()=>fn({memoryDir:f.dir,write:true,max:2000}),/refusing to overwrite/);
  assert.equal(f.read('x-1.md'),original); assert.equal(f.read('INDEX-build.md'),'handwritten page\n'); assert.ok(!fs.existsSync(path.join(f.dir,'.memory.lock')));
});
test('327 write CLI parsing and F15 imports', t => {
  const f=fixture(t); f.put('x.md','[part](x-1.md)\n'); f.put('x-1.md',dash+'\n');
  for(const [module,command] of [['memory-chars','repair'],['memory-chains','repair'],['memory-chains','lines']]) {
    const r=cli(module,['--write',command,'--memory-dir',f.dir,'--repo',f.dir]); assert.equal(r.status,0,r.stderr); assert.ok(r.stdout.length);
    const source=fs.readFileSync(path.join(root,'engine',module+'.mjs'),'utf8'); assert.doesNotMatch(source,/from ['"]\.\/memory-(?:check|lesson)\.mjs/);
  }
});

for(const envRoot of [true,false]) test('guard subdir root '+envRoot,t=> {
 const f=rulesFixture(t,[{id:'inline-script-path',action:'deny'}]);
 const c=config(); c.caps.guard={kitRules:'scripts/memory/enforce-rules.kit.json',rules:'scripts/memory/enforce-rules.json'};
 const cfg=f.put('guard-config.json',JSON.stringify(c));
 fs.mkdirSync(path.join(f.dir,'sub')); const env={...process.env}; delete env.CLAUDE_PROJECT_DIR; if(envRoot) env.CLAUDE_PROJECT_DIR=f.dir;
 for(const layout of ['engine','scripts/memory']) {
  const location=(envRoot?'separate-toolkit/':'')+layout;
  for(const name of ['memory-guard.mjs','lib.mjs','memory.config.json']) f.put(location+'/'+name,fs.readFileSync(path.join(root,'engine',name)));
  const r=spawnSync(process.execPath,[path.join(f.dir,location,'memory-guard.mjs'),'pretooluse','--config',cfg],{env,cwd:path.join(f.dir,'sub'),encoding:'utf8',input:JSON.stringify({cwd:path.join(f.dir,'sub'),tool_name:'Bash',tool_input:{command:positives[0][1]}})});
  assert.equal(r.status,2,r.stdout+r.stderr); assert.doesNotMatch(r.stdout+r.stderr,/skipped/);
 }
});
test('broken rule preserves deny and BOM stdin',t=> {
 const f=rulesFixture(t,[{id:'inline-script-path',action:'deny'},{id:'broken',pattern:'[',action:'deny',message:'broken'}]);
 for(const bom of ['', '\uFEFF']) {const r=cli('memory-guard',['pretooluse','--repo',f.dir],bom+JSON.stringify({tool_name:'Bash',tool_input:{command:positives[0][1]}})); assert.equal(r.status,2); assert.match(r.stdout+r.stderr,/skipped broken/);}
});
for(const kind of ['quoted','long']) test('guard performance '+kind,t=> {
 const command=kind==='quoted'?'a | tail && git '+('-c "key=value" '.repeat(40))+'log':('$(x | head) '.repeat(5000)).slice(0,50000);
 const script='import {loadRules,matchRules} from '+JSON.stringify(new URL('../engine/memory-guard.mjs',import.meta.url).href)+'; const rules=loadRules().rules; const c='+JSON.stringify(command)+'; for(const tool of ["Bash","PowerShell"]) {const start=performance.now(); matchRules(rules,tool==="PowerShell"?c.replace("a | tail &&", "a | Select-Object;"):c,tool); const ms=performance.now()-start; console.log(ms); if(ms>=50) process.exitCode=1;}';
 const r=spawnSync(process.execPath,['--input-type=module'],{input:script,encoding:'utf8',timeout:2000,windowsHide:true}); assert.ifError(r.error); assert.equal(r.status,0,r.stdout+r.stderr); t.diagnostic(kind+' runtime ms: '+r.stdout.trim());
});
test('guard cap assignment and replay',async t=> {
 const f=rulesFixture(t),{loadRules,matchRules}=await guard(),rules=loadRules().rules;
 assert.equal(matchRules(rules,'x'.repeat(4000)+'; '+positives[0][1]).length,0); assert.equal(matchRules(rules,'VAR=$(git log | head) && git push').length,0);
 const file=f.put('replay.jsonl',JSON.stringify({command:positives[0][1]+'\n'+'x'.repeat(300)})); const r=cli('memory-guard',['replay',file,'--repo',f.dir]);
 const hit=r.stdout.split(/\r?\n/).find(l=>l.startsWith('  line ')); assert.ok(hit.slice(hit.indexOf(': ')+2).length<=200); assert.match(hit,/\\n/); assert.doesNotMatch(r.stdout,/\nx{10}/);
});
test('chars C2 C3 outside-run evidence',async t=> {
 const f=fixture(t),{repairChars}=await chars();
 for(const p of [0xa7,0xb7,0xb0,0xa0]) f.put('c'+p+'.md',damaged(0xc2,p)+' '+damaged(0xc2,p)+'\n');
 f.put('c3.md',damaged(0xc3,0xb8)+'\n'); f.put('example.md',damaged(0xc2,0xa7)+' '+damaged(0xa7)+'\n'); repairChars({memoryDir:f.dir,write:true});
 for(const p of [0xa7,0xb7,0xb0,0xa0]) assert.equal(f.read('c'+p+'.md'),damaged(p)+' '+damaged(p)+'\n');
 assert.equal(f.read('c3.md'),damaged(0xf8)+'\n'); assert.equal(f.read('example.md'),damaged(0xc2,0xa7)+' '+damaged(0xa7)+'\n');
});
test('invalid UTF8 preserved',async t=> {
 const f=fixture(t),{repairChars}=await chars(),bytes=Buffer.concat([Buffer.from(dash+'\n'),Buffer.from([0xe9])]); f.put('invalid.md',bytes);
 const r=repairChars({memoryDir:f.dir,write:true}); assert.deepEqual(fs.readFileSync(path.join(f.dir,'invalid.md')),bytes); assert.ok(r.items.some(i=>/UTF-8/.test(i.message)&&i.reportOnly));
});
test('frontmatter values and indented code',async t=> {
 const f=fixture(t),{repairChars,scanChars}=await chars(),original='---\ndescription: "'+dash+'"\n'+dash+': keep\nsummary: |\n  '+dash+'\n---\n\n    '+dash+'\n\n- list\n    '+dash+'\n'; f.put('topic.md',original);
 const r=repairChars({memoryDir:f.dir,write:true}); assert.equal(f.read('topic.md'),'---\ndescription: "'+damaged(0x2014)+'"\n'+dash+': keep\nsummary: |\n  '+damaged(0x2014)+'\n---\n\n    '+dash+'\n\n- list\n    '+damaged(0x2014)+'\n'); assert.equal(scanChars(original).find(x=>x.check==='chars.mojibake').value,3); assert.equal(r.remaining,0);
});
test('chain parents CRLF blank and cap isolation',async t=> {
 const f=fixture(t),{scanChains,repairChains}=await chains(); f.put('MEMORY.md','# Memory\n## Hard rules\n[rule](hard.md)\n'); f.put('hard.md','[part](hard-1.md)\n'); f.put('hard-1.md','Body.\n');
 f.put('state.md','---\nstate: true\n---\n[part](state-1.md)\n'); f.put('state-1.md','Part 1 of [state](state.md).\r\n\r\nBody.\r\n'); f.put('large.md','[part](large-1.md)\n'); f.put('large-1.md','x'.repeat(200)+'\n'); f.put('blank.md','[part](blank-1.md)\n'); f.put('blank-1.md','---\nname: Part\n---\n\nBody.\n');
 const scan=scanChains(f.dir); for(const parent of ['hard.md','state.md']) assert.ok(scan.parts.some(p=>p.parent===parent)); assert.ok(!scan.problems.some(p=>p.file==='state-1.md'&&p.kind==='backlink'));
 const c=config(); c.caps.topic.failBytes=150; const r=repairChains({memoryDir:f.dir,write:true,config:c}); assert.match(f.read('hard-1.md'),/^Part 1/); assert.equal(f.read('large-1.md'),'x'.repeat(200)+'\n'); assert.ok(r.problems.some(p=>p.file==='large-1.md'&&p.kind==='size-cap')); assert.doesNotMatch(f.read('blank-1.md'),/\n\n\n/);
});
for(const marker of ['- ','* ','+ ','> ','# ','1. ','===','---','~~~',bt.repeat(3)]) test('packing marker '+marker,async t=> {
 const f=fixture(t),{repairLines}=await chains(),original='A long sentence. '+marker+'next sentence. Another safe sentence.'; f.put('topic.md',original); repairLines({memoryDir:f.dir,write:true,max:18}); const next=f.read('topic.md'); assert.equal(next.replace(/\r?\n/g,' '),original); assert.ok(!next.split('\n').slice(1).some(l=>l.startsWith(marker)));
 f.put('topic.md','A long sentence. '+marker+'next sentence.'); assert.equal(repairLines({memoryDir:f.dir,max:18}).changes.length,0);
});
test('paragraph pipe repair',async t=> {const f=fixture(t),{repairLines}=await chains(); f.put('topic.md','A | paragraph sentence. Another sentence.'); assert.equal(repairLines({memoryDir:f.dir,max:25}).changes.length,1);});
for(const kind of ['chars','chains','lines']) test('held lock '+kind,async t=> {
 const f=fixture(t); f.put('x.md','[part](x-1.md)\n'); f.put('x-1.md',dash+' sentence. Another sentence.\n'); const lock=JSON.stringify({pid:process.pid,host:os.hostname(),time:new Date().toISOString()}); f.put('.memory.lock',lock);
 const api=kind==='chars'?await chars():await chains(),fn=api[kind==='chars'?'repairChars':kind==='chains'?'repairChains':'repairLines'],original=f.read('x-1.md'); assert.throws(()=>fn({memoryDir:f.dir,write:true,max:10}),/lock timed out/); assert.equal(f.read('x-1.md'),original); assert.equal(f.read('.memory.lock'),lock);
});
test('CLI writes chars chains lines',t=> {
 const f=fixture(t); f.put('x.md','[part](x-1.md)\n'); f.put('x-1.md',dash+'\n'); f.put('long.md',('Sentence with text. '.repeat(150)).trim()+'\n');
 for(const [module,command] of [['memory-chars','repair'],['memory-chains','repair'],['memory-chains','lines']]) assert.equal(cli(module,[command,'--write','--memory-dir',f.dir,'--repo',f.dir]).status,0);
 assert.equal(f.read('x-1.md'),'Part 1 of [x](x.md).\n\n'+damaged(0x2014)+'\n'); assert.ok(f.read('long.md').trim().split('\n').length>1);
});

test('frontmatter protects quoted and flow keys and block prose',async t=> {
 const f=fixture(t),{repairChars}=await chars();
 const original='---\n"key:'+dash+'": '+dash+'\nflow: {"'+dash+'": "keep"}\nsummary: |\n  '+dash+': '+dash+'\n---\nBody.\n';
 f.put('topic.md',original); repairChars({memoryDir:f.dir,write:true});
 assert.equal(f.read('topic.md'),'---\n"key:'+dash+'": '+damaged(0x2014)+'\nflow: {"'+dash+'": "keep"}\nsummary: |\n  '+damaged(0x2014)+': '+damaged(0x2014)+'\n---\nBody.\n');
});

test('chain parent exclusions preserve hard-rule state and declared stub parents', async t => {
  const f=fixture(t), {scanChains}=await chains();
  f.put('MEMORY.md','# Memory\n## Hard rules\n[rule](hard.md)\n');
  f.put('ARCHIVE.md','# Archive\n'); f.put('INDEX-build.md','# Index\n');
  f.put('gen.md','<!-- generated by memory-index.mjs; edit the lessons, not this file -->\n');
  f.put('lesson-001-note.md','# Lesson\n');
  for(const [file,parent] of [['extra.md','MEMORY.md'],['archive-extra.md','ARCHIVE.md'],['index-extra.md','INDEX-build.md'],['plain-2.md','gen.md'],['notes-2.md','lesson-001-note.md']]) f.put(file,'---\nparent: '+parent+'\n---\nBody.\n');
  for(const file of ['MEMORY-2.md','ARCHIVE-2.md','gen-2.md','lesson-001-note-2.md']) f.put(file,'Body.\n');
  f.put('hard.md','# Hard rule\n'); f.put('state.md','---\nstate: true\n---\nBody.\n');
  f.put('stub.md','---\nmoved_to: hard.md\n---\nBody.\n'); f.put('stub-2.md','Body.\n');
  for(const parent of ['hard','state','stub']) f.put(parent+'-extra.md','---\nparent: '+parent+'.md\n---\nBody.\n');
  for(const parent of ['hard','state']) f.put(parent+'-2.md','Body.\n');
  assert.deepEqual(scanChains(f.dir).parts.map(p=>[p.file,p.parent]).sort(), [['hard-2.md','hard.md'],['hard-extra.md','hard.md'],['state-2.md','state.md'],['state-extra.md','state.md'],['stub-extra.md','stub.md']].sort());
});
for(const command of ['repair','lines']) test(''+command+' write preserves and reports invalid UTF-8', t => {
  const f=fixture(t), bytes=Buffer.concat([Buffer.from(('A sentence with enough text. '.repeat(100)).trim()+'\n'),Buffer.from([0xe9])]);
  f.put('topic.md','[part](topic-1.md)\n'); const file=f.put('topic-1.md',bytes);
  for(const json of [false,true]) {
    const r=cli('memory-chains',[command,'--write','--memory-dir',f.dir,'--repo',f.dir,...(json?['--json']:[])]);
    assert.equal(r.status,0,r.stderr); assert.deepEqual(fs.readFileSync(file),bytes);
    assert.match(r.stdout,/invalid UTF-8 bytes; report only/);
    if(json) assert.deepEqual(JSON.parse(r.stdout).changes,[]);
  }
});
for(const marker of ['<!-- comment -->','<details>','<div>','<table>','<pre>','<blockquote>','<p>','<ul>','<ol>','<h1>','<h2>','<h3>','<h4>','<h5>','<h6>','<summary>','<DIV class="note">']) test('packing HTML marker '+marker, async t => {
  const f=fixture(t), {repairLines}=await chains(), original='A long sentence. '+marker+'next sentence. Another safe sentence.';
  f.put('topic.md',original); repairLines({memoryDir:f.dir,write:true,max:18}); const next=f.read('topic.md');
  assert.equal(next.replace(/\r?\n/g,' '),original); assert.ok(!next.split('\n').slice(1).some(l=>l.startsWith(marker)));
  f.put('topic.md','A long sentence. '+marker+'next sentence.'); assert.equal(repairLines({memoryDir:f.dir,max:18}).changes.length,0);
});


test('missing host is silent and missing kit remains guard error',async t=> {
  const f=rulesFixture(t); fs.unlinkSync(path.join(f.dir,'scripts/memory/enforce-rules.json'));
  assert.deepEqual((await guard()).loadRules({repo:f.dir,config:config()}).errors,[]);
  assert.equal(hook(f,'echo benign').stdout,'');
  fs.unlinkSync(path.join(f.dir,'scripts/memory/enforce-rules.kit.json'));
  assert.equal((await guard()).loadRules({repo:f.dir,config:config()}).errors.length,1);
  assert.match(context(hook(f,'echo benign')),/skipped.*enforce-rules\.kit\.json/);
});
