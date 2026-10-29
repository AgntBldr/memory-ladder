import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture,put,read,json,ok,kitRoot,tree} from './helpers.mjs';
import {migrateRoutes} from '../engine/memory-migrate.mjs';

for(const pattern of ['.claude/','scripts/']) for(const dry of [false,true]) test(`ignored parent ${pattern} dry=${dry}`,t=>{
 const f=fixture(t);put(path.join(f.target,'.gitignore'),pattern+'\n');const before=tree(f.target);
 const r=ok(f.install(['--memory-dir',f.memory,'--no-gitignore-fix',...(dry?['--dry-run']:[])]));
 assert.equal(read(path.join(f.target,'.gitignore')),pattern+'\n');
 assert.equal(fs.existsSync(path.join(f.target,'scripts/memory/KIT.json')),!dry);
 if(dry) {assert.deepEqual(tree(f.target),before);assert.equal(fs.existsSync(f.memory),false);}
 const paths=dry?r.stdout.split(/\r?\n/).filter(l=>l.startsWith('WRITE ')).map(l=>l.slice(6).replace(/ after baseline succeeds$/,'')):Object.keys(tree(f.target)).map(p=>path.join(f.target,p));
 const candidates=paths.map(p=>path.relative(f.target,p).replaceAll('\\','/')).filter(p=>p.startsWith(pattern)&&!p.endsWith('/KIT.local.json'));
 assert.ok(candidates.length>1);
 for(const file of candidates) assert.ok(r.stdout.includes(`.gitignore:1:${pattern}\t${file}`),file);
});

for(const eol of ['\r\n','\n']) test(`new notes use source ${JSON.stringify(eol)}`,t=>{
 const f=fixture(t);put(path.join(f.memory,'MEMORY.md'),'- [Craft](INDEX-craft.md) OPEN BEFORE craft.\n');
 put(path.join(f.memory,'INDEX-craft.md'),Array.from({length:13},(_,i)=>`Hand note ${i}.${eol}`).join(''));
 migrateRoutes({memoryDir:f.memory,config:json(path.join(kitRoot,'engine/memory.config.json')),write:true});
 const notes=read(path.join(f.memory,'index-notes-craft.md'));
 assert.equal((notes.match(eol==='\r\n'?/(?<!\r)\n/g:/\r\n/g)||[]).length,0);
 assert.ok(notes.includes('Hand note 12.'));
});
