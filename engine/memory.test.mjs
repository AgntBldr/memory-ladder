import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {after} from 'node:test';
import config from './selftest-config.mjs';

// Run all imports and CLI children beside fixture config, never host config or receipts.
const source=path.dirname(fileURLToPath(import.meta.url));
const runtime=fs.mkdtempSync(path.join(os.tmpdir(),'memory-selftest-'));
for(const entry of fs.readdirSync(source,{withFileTypes:true})) {
  if(entry.isFile()&&(entry.name.endsWith('.mjs')||['README.md','recall-probes.json','upgrades.json'].includes(entry.name)))
    fs.copyFileSync(path.join(source,entry.name),path.join(runtime,entry.name));
}
fs.writeFileSync(path.join(runtime,'memory.config.json'),JSON.stringify(config));
if(fs.existsSync(path.join(source,'templates'))) fs.cpSync(path.join(source,'templates'),path.join(runtime,'templates'),{recursive:true});
const saved=process.env.CLAUDE_MEMORY_DIR;
delete process.env.CLAUDE_MEMORY_DIR;
after(()=>{
  if(saved!==undefined) process.env.CLAUDE_MEMORY_DIR=saved;
  fs.rmSync(runtime,{recursive:true,force:true});
});
await import(pathToFileURL(path.join(runtime,'memory-selftest-cases.mjs')).href);
