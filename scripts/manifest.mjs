import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const hash = file => createHash('sha256').update(fs.readFileSync(file,'utf8').replace(/\r\n/g,'\n')).digest('hex');
export function files(root, rel = '') {
  return fs.readdirSync(path.join(root, rel), {withFileTypes:true}).flatMap(e => {
    const p = path.posix.join(rel, e.name);
    return e.isDirectory() ? files(root, p) : e.isFile() ? [p] : [];
  }).sort();
}
export const ownedFiles = root => files(root).filter(f => /^engine\/(?:[^/]+\.mjs|README\.md)$/.test(f) || f === 'engine/enforce-rules.kit.json' || f === 'templates/MEMORY.md' || f === 'templates/current-state.md' || f === 'templates/lesson.md' || f === 'templates/lesson-batch.md' || /^docs\/(CONVERT|UPGRADE|GLOSSARY|LESSON-KINDS|LABELLING)\.md$/.test(f) || f.startsWith('skills/'));
export const installedPath = f => f === 'engine/memory.test.mjs' ? 'scripts/memory/memory.selftest.mjs' : f.startsWith('engine/') ? 'scripts/memory/' + f.slice(7) : f.startsWith('templates/') ? 'scripts/memory/' + f : f.startsWith('docs/') ? 'scripts/memory/' + f.slice(5) : '.claude/' + f;
export function manifest(root = kitRoot) {
  return {version:fs.readFileSync(path.join(root,'VERSION'),'utf8').trim(),files:Object.fromEntries(ownedFiles(root).map(f=>[f,hash(path.join(root,f))]))};
}
export function installedManifest(root = kitRoot) {
  const m = JSON.parse(fs.readFileSync(path.join(root,'MANIFEST.json'),'utf8'));
  return {...m,files:Object.fromEntries(Object.entries(m.files).map(([f,h])=>[installedPath(f),h]))};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const m = manifest();
  fs.writeFileSync(path.join(kitRoot,'MANIFEST.json'),JSON.stringify(m,null,2)+'\n');
  console.log('manifest: '+Object.keys(m.files).length+' owned files');
}
