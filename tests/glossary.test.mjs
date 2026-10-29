import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture, ok, put, read, json, kitRoot, bump} from './helpers.mjs';

const glossary = () => read(path.join(kitRoot, 'docs/GLOSSARY.md'));
// The gate passes literal ids to add(), size(), lineCaps(), or the [cap, id]
// dispatch table. Match add's second argument (including conditional severity),
// size's first, lineCaps' second, and [camelCase cap, dotted id] tuples.
// This is a source-shape guard, not a JS parser; extend it if dispatch changes.
// No check-id list is maintained.
const checkIds = source => [...new Set([...source.matchAll(/\badd\([^,\n]+,\s*['"]([a-z][a-z.-]*)['"]|\bsize\(['"]([^'"]+)['"]|\blineCaps\(\w+,\s*['"]([^'"]+)['"]|\[['"][a-zA-Z]+['"],\s*['"]([a-z]+\.[a-z-]+)['"]\]/g)].map(m => m[1] ?? m[2] ?? m[3] ?? m[4]))].sort();

test('glossary defines every gate check id extracted from source', () => {
  const text = glossary(), entries = new Set([...text.matchAll(/^\*\*([^*]+)\*\* - /gm)].map(m => m[1]));
  assert.ok(!text.startsWith('\uFEFF') && !text.includes('\r'), 'UTF-8 without BOM, LF');
  for (const section of text.split(/^## /m).slice(1)) {
    const names = [...section.matchAll(/^\*\*([^*]+)\*\* - (.+)$/gm)];
    for (const entry of names) assert.match(entry[2], /\. Where: .+\. See also: .+\.$/, entry[1]);
    const terms = names.map(m => m[1]);
    assert.deepEqual(terms, [...terms].sort((a, b) => a.localeCompare(b, 'en', {sensitivity: 'base'})), section.split('\n')[0]);
  }
  const ids = checkIds(read(path.join(kitRoot, 'engine/memory-check.mjs')));
  assert.ok(ids.length > 0);
  assert.deepEqual(ids.filter(id => !entries.has(id)), [], 'undocumented check ids');
});

test('glossary names every caps key recursively and every engine module', () => {
  const text = glossary();
  function visit(object, prefix) {
    for (const [key, value] of Object.entries(object)) {
      const name = prefix + '.' + key;
      assert.ok(text.includes('`' + name + '`') || text.includes('**' + name + '** - '), 'undocumented cap: ' + name);
      if (value && typeof value === 'object' && !Array.isArray(value)) visit(value, name);
    }
  }
  visit(json(path.join(kitRoot, 'engine/memory.config.json')).caps, 'caps');
  for (const file of fs.readdirSync(path.join(kitRoot, 'engine')).filter(f => f.endsWith('.mjs')))
    assert.ok(text.includes(file), 'undocumented engine module: ' + file);
});

test('install ships glossary and upgrade replaces it with the new release bytes', t => {
  const f = fixture(t);
  ok(f.install());
  const dest = path.join(f.target, 'scripts/memory/GLOSSARY.md');
  assert.equal(read(dest), glossary());
  assert.ok(json(path.join(f.target, 'scripts/memory/MANIFEST.json')).files['scripts/memory/GLOSSARY.md']);
  const next = bump(f), updated = glossary() + '\nUpgrade fixture text.\n';
  put(path.join(next, 'docs/GLOSSARY.md'), updated);
  ok(f.cli('scripts/manifest.mjs', [], next));
  ok(f.cli('scripts/upgrade.mjs', ['--target', f.target], next));
  assert.equal(read(dest), updated);
  assert.equal(json(path.join(f.target, 'scripts/memory/MANIFEST.json')).files['scripts/memory/GLOSSARY.md'],
    json(path.join(next, 'MANIFEST.json')).files['docs/GLOSSARY.md']);
});
