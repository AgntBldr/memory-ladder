import fs from 'node:fs';
import path from 'node:path';
import {KINDS} from './memory-index.mjs';
import { args, locations, isDirect, toolDir, requireMemory, memoryFiles, brainPaths,
  parseFrontmatter, fmGet, read, utf8Bytes, pathIncludes, loadConfig } from './lib.mjs';

const stopwords = new Set(('how why where whom does did should would could a an and are as at be been but by can do for from had has have he her his i if in into is it its me my no not of on or our she so than that the their them then there these they this to too us was we were what when which who will with you your').split(' '));
export function tokenize(text) {
  return String(text).toLowerCase().split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2 && !stopwords.has(t))
    .map(t => {
      if (t.length > 4 && t.endsWith('ies')) t = t.slice(0, -3) + 'y';
      else if (t.endsWith('sses')) t = t.slice(0, -2);
      else if (/(?:ch|sh|x|z|s)es$/.test(t)) t = t.slice(0, t.length > 4 ? -2 : -1);
      else if (t.length > 3 && /[^sui]s$/.test(t)) t = t.slice(0, -1);
      if (t.length > 5 && t.endsWith('ing')) t = t.slice(0, -3);
      else if (t.length > 4 && t.endsWith('ed')) t = t.slice(0, -2);
      if (t.length > 3 && t.endsWith('e')) t = t.slice(0, -1);
      return t;
    });
}
const firstH1 = body => /^#\s+(.+)$/m.exec(body)?.[1] || '';
function document(file, text, fm, source) {
  const get = key => fmGet(fm.data, key) ?? '';
  const hook = String(get(source === 'memory' ? 'description' : 'summary'));
  const kind = fm.data.metadata?.kind ?? fm.data.kind;
  const takeaway = fm.data.metadata?.takeaway ?? fm.data.takeaway;
  const trigger = fm.data.metadata?.trigger ?? fm.data.trigger;
  const fields = source === 'memory'
    ? [[get('name'), 3], [hook, 2], [firstH1(fm.body), 2], [fm.body.slice(0, 400), 1], [kind ?? '', 1], [takeaway ?? '', 1], [trigger ?? '', 2]]
    : [[get('id'), 3], [hook, 2], [Array.isArray(get('tags')) ? get('tags').join(' ') : get('tags'), 2], [firstH1(fm.body), 2], [fm.body.slice(0, 400), 1]];
  const terms = new Map();
  let length = 0;
  for (const [value, weight] of fields) {
    for (const term of tokenize(value)) { terms.set(term, (terms.get(term) || 0) + weight); length += weight; }
  }
  return { path: file, source, kind, takeaway, bytes: utf8Bytes(text), hook: hook.slice(0, 160), terms, length,
    stub: fmGet(fm.data, 'moved_to') !== undefined };
}
export function buildCorpus({ memoryDir, repo, files, config = loadConfig(), memoryOnly = false }) {
  const corpus = [];
  if (memoryDir) {
    for (const f of files ?? memoryFiles(memoryDir)) {
      if (!f.special && !f.stub) corpus.push(document(f.file, f.text, f, 'memory'));
    }
  }
  for (const file of memoryOnly ? [] : brainPaths(repo, config)) {
    const text = read(path.join(repo, config.brain?.dir ?? 'brain', file));
    corpus.push(document(`${config.brain?.dir ?? 'brain'}/${file}`, text, parseFrontmatter(text), 'brain'));
  }
  return corpus;
}
export function search(corpus, query, k = 5) {
  if (!Number.isInteger(k) || k < 1) throw new Error('k must be a positive integer');
  if (!corpus.length) return [];
  const queryTerms = [...new Set(tokenize(query))];
  const avgLength = corpus.reduce((n, d) => n + d.length, 0) / corpus.length || 1;
  const df = new Map(queryTerms.map(term => [term, corpus.filter(d => d.terms.has(term)).length]));
  return corpus.map(d => {
    let score = 0;
    for (const term of queryTerms) {
      const tf = d.terms.get(term) || 0;
      if (!tf) continue;
      const idf = Math.log(1 + (corpus.length - df.get(term) + 0.5) / (df.get(term) + 0.5));
      score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * d.length / avgLength));
    }
    return { score, path: d.path, hook: d.hook, bytes: d.bytes, ...(d.takeaway === undefined ? {} : {takeaway: d.takeaway}) };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, k).map((r, i) => ({ rank: i + 1, ...r }));
}
export const humanResults = results => results.map(r => `${r.rank}. ${r.score.toFixed(1)}  ${r.path} - ${r.hook.replace(/[\r\n]+/g, ' ')}${!['fix', 'method', 'know'].includes(r.takeaway) ? '' : '\n   takeaway: ' + r.takeaway}`).join('\n');
export function loadProbes(probesFile) {
  if (!fs.existsSync(probesFile)) throw new Error(`recall probes: file not found: ${probesFile}`);
  const spec = JSON.parse(read(probesFile));
  if (spec.version !== 1 || !Number.isFinite(spec.minPass) || spec.minPass < 0 || spec.minPass > 1 || !Array.isArray(spec.probes)) throw new Error('Invalid probe specification');
  for (const p of spec.probes) {
    if (typeof p.id !== 'string' || typeof p.q !== 'string' || !Array.isArray(p.expect) || !p.expect.length || p.expect.some(s => typeof s !== 'string' || !s)) throw new Error('Invalid probe');
  }
  return spec;
}
export function runProbes({ corpus, memoryDir, repo, config = loadConfig(), probesFile = path.join(toolDir, 'recall-probes.json'), probes }) {
  const docs = corpus ?? buildCorpus({ memoryDir, repo, config });
  const spec = probes ?? loadProbes(probesFile);
  return spec.probes.map(p => {
    const results = search(docs, p.q, 3);
    const hit = results.find(r => p.expect.some(pattern => pathIncludes(r.path, pattern)));
    return { id: p.id, pass: Boolean(hit), rank: hit?.rank ?? null, path: hit?.path ?? null, results };
  });
}
export function main(argv = process.argv.slice(2)) {
  try {
    const opts = args(argv);
    if (opts.help) { console.log('Usage: memory-recall.mjs "query" [--k 5] [--json] [--kind mistake|practice|observation] [--takeaway fix|method|know] [--memory-only|--brain-only] [--probe [FILE]] [--memory-dir PATH] [--repo PATH]'); return 0; }
    const loc = locations(opts);
    if (opts['memory-only'] && opts['brain-only']) throw new Error('Choose one source filter');
    if (opts['memory-only']) requireMemory(loc.memoryDir);
    if (opts.kind !== undefined && !KINDS.includes(opts.kind)) throw new Error('kind must be mistake, practice or observation');
    if (opts.takeaway !== undefined && !['fix', 'method', 'know'].includes(opts.takeaway)) throw new Error('takeaway must be fix, method or know');
    let corpus = buildCorpus({...loc, memoryOnly: Boolean(opts['memory-only']), config: opts.config ? JSON.parse(read(opts.config)) : loadConfig()});
    if (opts.takeaway !== undefined) corpus = corpus.filter(d => d.takeaway === opts.takeaway);
    if (opts.kind !== undefined) corpus = corpus.filter(d => d.kind === opts.kind);
    if (opts['memory-only']) corpus = corpus.filter(d => d.source === 'memory');
    if (opts['brain-only']) corpus = corpus.filter(d => d.source === 'brain');
    if (opts.probe) {
      const probes = loadProbes(opts.probe === true ? path.join(toolDir, 'recall-probes.json') : opts.probe);
      const results = runProbes({ corpus, probes });
      const passed = results.filter(p => p.pass).length;
      const rate = results.length ? passed / results.length : 0;
      if (opts.json) console.log(JSON.stringify({ results, passed, total: results.length, rate, minPass: probes.minPass }, null, 2));
      else {
        for (const r of results) console.log(r.pass ? `${r.id} PASS rank ${r.rank} ${r.path}` : `${r.id} FAIL top3: ${r.results.map(d => d.path).join(', ')}`);
        console.log(`recall probes: ${passed}/${results.length} pass (${Math.round(rate * 100)}%), minPass ${Math.round(probes.minPass * 100)}%`);
      }
      return rate < probes.minPass ? 1 : 0;
    }
    const results = search(corpus, opts._.join(' '), opts.k === undefined ? 5 : Number(opts.k));
    console.log(opts.json ? JSON.stringify(results, null, 2) : humanResults(results));
    return 0;
  } catch (error) { console.error(error.message.startsWith('recall probes: file not found:') ? error.message : `memory-recall: ${error.message}`); return 1; }
}
if (isDirect(import.meta.url)) process.exitCode = main();
