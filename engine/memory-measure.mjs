import fs from 'node:fs';
import path from 'node:path';
import { args, locations, requireMemory, isDirect, toolDir, loadConfig, memoryFiles,
  read, mdLinks, utf8Bytes, pathKey, fmGet, pathIncludes } from './lib.mjs';
import { buildCorpus, search, humanResults, loadProbes } from './memory-recall.mjs';
import { runCheck, counts } from './memory-check.mjs';

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
};
const sum = values => values.reduce((a, b) => a + b, 0);
function forgetting(files) {
  let lessons = files.filter(f => /^lesson-\d{3}[a-z]?.*\.md$/.test(f.file)).map(f => ({ body: f.body, date: fmGet(f.data, 'date') }));
  if (!lessons.length) {
    const text = files.find(f => f.file.startsWith('verification-lessons'))?.body || '';
    const markers = [...text.matchAll(/^\s*(?:#{2,3}\s*|\*\*\s*#?)(\d{1,3})[a-z]?(?=[\s.:)\u2014\u2013-])/gm)];
    lessons = markers.map((m, i) => ({ body: text.slice(m.index, markers[i + 1]?.index ?? text.length) }));
  }
  const correction = /\b(CORRECTION|corrected|I said|was wrong|false claim|overclaim|retract(?:ed)?|same mistake|repeat(?:ed)? (?:the )?mistake|re-?learn(?:ed)?|recurr(?:ed|ence)|second time)\b/i;
  const perMonth = {};
  let corrections = 0;
  for (const lesson of lessons) {
    if (!correction.test(lesson.body)) continue;
    corrections++;
    const date = lesson.date ?? /\b\d{4}-\d{2}-\d{2}\b/.exec(lesson.body)?.[0];
    if (date) perMonth[String(date).slice(0, 7)] = (perMonth[String(date).slice(0, 7)] || 0) + 1;
  }
  return { proxy: true, lessonsParsed: lessons.length, corrections, correctionsPerMonth: perMonth };
}
export function measure({ memoryDir, repo, config = loadConfig(), probesFile = path.join(toolDir, 'recall-probes.json'), noGit = false }) {
  for (const key of ['startLogTailEntries', 'startLogTailLines']) {
    if (!Number.isInteger(config.measure?.[key]) || config.measure[key] <= 0)
      throw new Error(`measure.${key} must be a positive integer`);
  }
  requireMemory(memoryDir);
  const files = memoryFiles(memoryDir), corpus = buildCorpus({ memoryDir, repo });
  const router = files.find(f => f.special === 'router');
  const log = read(path.join(repo, config.caps.brainLog.path));
  // A terminal newline terminates the last line; it is not an extra empty line.
  const logLines = log.match(/[^\n]*\n|[^\n]+$/g) || [];
  const legacyTail = logLines.slice(-config.measure.startLogTailLines).join('');
  const entries = [...log.matchAll(/^## \[/gm)];
  const tailStart = entries[Math.max(0, entries.length - config.measure.startLogTailEntries)]?.index;
  const tail = tailStart === undefined ? '' : log.slice(tailStart);
  const startFiles = { 'MEMORY.md': router?.bytes || 0,
    'AGENTS.md': utf8Bytes(read(path.join(repo, 'AGENTS.md'))),
    'CLAUDE.md': utf8Bytes(read(path.join(repo, 'CLAUDE.md'))),
    brainLogTail: utf8Bytes(tail) };
  const total = sum(Object.values(startFiles));
  const sessionStart = { files: startFiles, totalBytes: total, tokens: Math.round(total / config.measure.bytesPerToken), brainLogFullBytes: utf8Bytes(log) };
  const legacyFiles = { ...startFiles, brainLogTail: utf8Bytes(legacyTail) }, legacyTotal = sum(Object.values(legacyFiles));
  const sessionStartLegacy = { files: legacyFiles, totalBytes: legacyTotal, tokens: Math.round(legacyTotal / config.measure.bytesPerToken), brainLogFullBytes: utf8Bytes(log) };
  const hard = files.filter(f => f.hardRule).map(f => ({ file: f.file, bytes: f.bytes }));
  const triggers = { files: hard, total: sum(hard.map(f => f.bytes)), max: hard.reduce((a, b) => b.bytes > a.bytes ? b : a, { file: null, bytes: 0 }) };
  const direct = new Set(mdLinks(router?.body || '').map(p => pathKey(memoryDir, p)));
  const indexes = files.filter(f => f.special === 'index' && direct.has(pathKey(memoryDir, f.file)))
    .map(f => ({ ...f, links: new Set(mdLinks(f.text).map(p => pathKey(memoryDir, p))) }));
  const probes = loadProbes(probesFile).probes;
  const rows = probes.map(p => {
    let ladderFile = null, ladderBytes = null;
    for (const pattern of p.expect) {
      for (const doc of corpus) {
        if (doc.stub || !pathIncludes(doc.path, pattern)) continue;
        const absolute = pathKey(doc.source === 'memory' ? memoryDir : repo, doc.path);
        const index = indexes.find(f => f.links.has(absolute));
        if (direct.has(absolute) || index) {
          ladderFile = doc.path;
          ladderBytes = (router?.bytes || 0) + (direct.has(absolute) ? 0 : index.bytes) + doc.bytes;
          break;
        }
      }
      if (ladderFile !== null) break;
    }
    const results = search(corpus, p.q, 3);
    const hit = results.find(r => p.expect.some(pattern => pathIncludes(r.path, pattern)));
    return { id: p.id, ladderBytes, ladderFile, searchHit: Boolean(hit), searchRank: hit?.rank ?? null,
      searchBytes: hit ? utf8Bytes(humanResults(results) + (results.length ? '\n' : '')) + hit.bytes : null };
  });
  const ladder = rows.map(r => r.ladderBytes).filter(n => n !== null);
  const searched = rows.map(r => r.searchBytes).filter(n => n !== null);
  const recall = { probes: rows, totals: { probes: rows.length, ladderReachable: ladder.length,
    medianLadderBytes: median(ladder), totalLadderBytes: sum(ladder),
    searchHitRate: rows.length ? searched.length / rows.length : 0,
    medianSearchBytes: median(searched), totalSearchBytes: sum(searched) } };
  const gateResult = runCheck({ memoryDir, repo, config, scope: 'all', noGit });
  const gate = { ...counts(gateResult), largest: gateResult.stats.largest, totalMemoryBytes: gateResult.stats.bytes,
    topicsOverWarn: files.filter(f => f.topic && f.bytes > config.caps.topic.warnBytes).length };
  return { sessionStart, sessionStartLegacy, triggers, recall, gate, forgetting: forgetting(files) };
}
const cell = value => String(value ?? '-').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
export function readable(result) {
  const s = result.sessionStart, t = result.triggers, r = result.recall.totals, g = result.gate, f = result.forgetting;
  const lines = ['# Memory v3 metrics', '', '| Metric | Value |', '| --- | --- |',
    `| Session start | ${s.totalBytes} bytes; ${s.tokens} estimated tokens |`,
    `| Session start legacy | ${result.sessionStartLegacy.totalBytes} bytes; ${result.sessionStartLegacy.tokens} estimated tokens |`,
    `| Brain log (full) | ${s.brainLogFullBytes} bytes |`,
    `| Triggers | ${t.total} bytes; max ${cell(t.max.file)} (${t.max.bytes} bytes) |`,
    `| Recall ladder | ${r.ladderReachable}/${r.probes} reachable; median ${cell(r.medianLadderBytes)}; total ${r.totalLadderBytes} bytes |`,
    `| Recall search | ${Math.round(r.searchHitRate * 100)}% hit; median ${cell(r.medianSearchBytes)}; total ${r.totalSearchBytes} bytes |`,
    `| Gate | ${g.FAIL} FAIL; ${g.WARN} WARN; ${g.allowed} allowed; ${g.totalMemoryBytes} memory bytes |`,
    `| Largest memory file | ${cell(g.largest.file)} (${g.largest.bytes} bytes); ${g.topicsOverWarn} topics over warning cap |`,
    `| Forgetting (proxy) | ${f.lessonsParsed} lessons; ${f.corrections} corrections |`, '',
    '## Session inputs', '', '| File | Bytes |', '| --- | ---: |',
    ...Object.entries(s.files).map(([file, bytes]) => `| ${cell(file)} | ${bytes} |`), '',
    '## Hard-rule triggers', '', '| File | Bytes |', '| --- | ---: |',
    ...t.files.map(file => `| ${cell(file.file)} | ${file.bytes} |`), '',
    '## Recall probes', '', '| Probe | Ladder file | Ladder bytes | Search hit | Rank | Search bytes |', '| --- | --- | ---: | --- | ---: | ---: |',
    ...result.recall.probes.map(p => `| ${cell(p.id)} | ${cell(p.ladderFile)} | ${cell(p.ladderBytes)} | ${p.searchHit} | ${cell(p.searchRank)} | ${cell(p.searchBytes)} |`), '',
    '## Corrections by month (proxy)', '', '| Month | Corrections |', '| --- | ---: |',
    ...Object.entries(f.correctionsPerMonth).sort().map(([month, count]) => `| ${month} | ${count} |`), ''];
  return lines.join('\n');
}
export function main(argv = process.argv.slice(2)) {
  try {
    const opts = args(argv);
    if (opts.help) { console.log('Usage: memory-measure.mjs [--json] [--write LABEL] [--probe FILE] [--memory-dir PATH] [--repo PATH]'); return 0; }
    const loc = locations(opts);
    const config = loadConfig();
    config.measure ??= { startLogTailEntries: 10, startLogTailLines: 40, bytesPerToken: 4 };
    let dir;
    if (opts.write) {
      dir = path.resolve(loc.repo, config.measure?.evidenceDir || 'docs/evidence/memory');
      const inside = (root, dest) => { const rel = path.relative(root, dest); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
      if (!inside(loc.repo, dir)) throw new Error('measure.evidenceDir resolves outside the repo');
      let existing = dir;
      while (!fs.existsSync(existing)) existing = path.dirname(existing);
      if (!inside(fs.realpathSync(loc.repo), fs.realpathSync(existing))) throw new Error('measure.evidenceDir resolves outside the repo');
    }
    const result = measure({ ...loc, config, probesFile: typeof opts.probe === 'string' ? opts.probe : undefined, noGit: Boolean(opts['no-git']) });
    if (opts.write) {
      if (!/^[a-zA-Z0-9_-]+$/.test(opts.write)) throw new Error('label must contain only letters, digits, underscores or hyphens');
      fs.mkdirSync(dir, { recursive: true });
      const base = path.join(dir, `${new Date().toISOString().slice(0, 10)}-${opts.write}`);
      fs.writeFileSync(`${base}.json`, JSON.stringify(result, null, 2) + '\n');
      fs.writeFileSync(`${base}.md`, readable(result));
    }
    console.log(opts.json ? JSON.stringify(result, null, 2) : readable(result));
    return 0;
  } catch (error) { console.error(`memory-measure: ${error.message}`); return 1; }
}
if (isDirect(import.meta.url)) process.exitCode = main();
