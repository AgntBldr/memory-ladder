import {normalizeEol, writeText, lessonCases} from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { validDate } from './memory-rotate.mjs';
import { generateOverview } from './roadmap-overview.mjs';
import { generateIndex, typedBrainCount, brainIndexPairs } from './brain-index.mjs';
import {generateMemoryIndex, isGenerated, lessonIdentity, lessonField, routes, routerFamilies, ladderWalk, hasTrigger, KINDS, REPEAT_ENTRY, gateCheckIds, enforceSentence, failSentence} from './memory-index.mjs';
import {loadRules} from './memory-guard.mjs';
import {scanChains, scanLines} from './memory-chains.mjs';
import {scanChars} from './memory-chars.mjs';
import {loadUpgrades} from './memory-fleet.mjs';
import { args, locations, requireMemory, isDirect, toolDir, loadConfig, memoryFiles,
  brainPaths, brainNamesFromNodes, walkMd, listMd, parseFrontmatter, fmGet, read, mdLinks, wikilinks, resolveWikilink, memoryWikilink, memoryNameIndex, roadmapOrder, utf8Bytes, pathKey, pathSpelling, inRepoMemory } from './lib.mjs';

import {secretSources as secrets, redact} from './lib.mjs';
export {redact} from './lib.mjs';
const edgeFields = ['supports', 'contradicts', 'depends_on', 'derived_from', 'related_to',
  'part_of', 'preceded_by', 'followed_by', 'authored_by', 'tagged_with'];
const stem = p => path.basename(p).replace(/\.md$/i, '');
const descriptionWords = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const pinKey = (pins, file) => Object.keys(pins).find(key => pathKey(key) === pathKey(file));
const glob = s => new RegExp(`^${s.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, process.platform === 'win32' ? 'i' : '');
const validAllow = entry => Boolean(entry && typeof entry.reason === 'string' && entry.reason.trim() &&
  /^\d{4}-\d{2}-\d{2}$/.test(entry.added ?? '') && typeof entry.check === 'string' && entry.check &&
  typeof entry.file === 'string' && (entry.ceiling === undefined || (Number.isFinite(entry.ceiling) && entry.ceiling >= 0)) &&
  entry.check !== 'secret' && !entry.check.startsWith('config.'));

function stubTargetExists(target, memoryDir, repo, config) {
  if (typeof target !== 'string' || !target.trim() || path.isAbsolute(target) || path.win32.isAbsolute(target)) return false;
  const prefix = (config.brain?.dir ?? 'brain').replaceAll('\\', '/') + '/';
  const brain = target.replaceAll('\\', '/').startsWith(prefix);
  const root = brain ? path.join(repo, config.brain?.dir ?? 'brain') : memoryDir;
  const absolute = path.resolve(root, brain ? target.slice(prefix.length) : target);
  const inside = (base, file) => {
    const rel = path.relative(base, file);
    return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
  };
  if (!inside(root, absolute)) return false;
  try {
    return fs.statSync(absolute).isFile() && inside(fs.realpathSync(root), fs.realpathSync(absolute));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function gitState(dir, files, caps, now, add, hook, inRepo = false) {
  const git = (...argv) => {
    try { return childProcess.execFileSync('git', ['-C', dir, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, maxBuffer: 32 * 1024 * 1024 }); }
    catch { return null; }
  };
  const top = git('rev-parse', '--show-toplevel')?.trim();
  const atTop = Boolean(top && pathKey(fs.realpathSync(dir)) === pathKey(fs.realpathSync(top)));
  if (git('rev-parse', '--is-inside-work-tree')?.trim() !== 'true' ||
      (!inRepo && !atTop && !git('ls-files', '--', '.')?.trim())) {
    add('WARN', 'repo.not-git', '.', null, 'memory dir is not a git repo');
    return;
  }
  if (!hook && !inRepo) {
    const remote = git('remote');
    if (remote !== null && !remote.trim()) add('WARN', 'repo.remote', '.', null, 'memory repo has no remote');
    const status = git('status', '--porcelain', ...(atTop ? [] : ['--', '.']));
    if (status?.trim()) add('WARN', 'repo.uncommitted', '.', null, 'memory repo has uncommitted changes');
    const ahead = git('rev-list', '--count', '@{upstream}..HEAD');
    if (ahead !== null && Number(ahead) >= caps.repoAhead.warn) add(Number(ahead) >= caps.repoAhead.fail ? 'FAIL' : 'WARN', 'repo.ahead', '.', null, `${Number(ahead)} commits ahead of upstream`, Number(ahead));
  }
  const subtree = fs.existsSync(path.join(dir, '.git')) ? [] : ['--relative', '--', '.'];
  const log = git('-c', 'core.quotepath=off', 'log', '--format=%x00%cs', '--name-only', ...subtree);
  if (log === null) return;
  const dates = new Map();
  let date = null;
  for (const line of log.split(/\r?\n/)) {
    if (line.startsWith('\0')) date = line.slice(1).trim();
    else if (date && line && !dates.has(pathKey(dir, line))) dates.set(pathKey(dir, line), date);
  }
  for (const f of files) {
    if (f.special || (!f.state && !(caps.stale?.types ?? ['project', 'reference']).includes(fmGet(f.data, 'type'))) || fmGet(f.data, 'stable') === true || !dates.has(pathKey(dir, f.file))) continue;
    const days = (new Date(now).getTime() - Date.parse(dates.get(pathKey(dir, f.file)))) / 86400000;
    if (days > caps.staleDays) add('WARN', 'stale', f.file, null, `last committed ${Math.floor(days)} days ago`, Math.floor(days));
  }
}

// An allow entry can only go stale for a check this run actually evaluated: memory scope skips the
// repo layer (repo checks and anything under brain/ or docs/), and --hook skips the remote/ahead/dirty checks.
function notEvaluated(entry, scope, hook, noGit = false, inRepo = false, quick = false) {
  if (quick && /^(?:split\.chain|topic\.line|chars\.)/.test(entry.check)) return true;
  if (inRepo && /^repo\.(?:remote|ahead|uncommitted)$/.test(entry.check)) return true;
  if (scope === 'memory' && entry.check === 'kit.manifest') return true;
  if (noGit && /^(?:stale|repo\.(?:not-git|remote|ahead|uncommitted))$/.test(entry.check)) return true;
  if (hook && /^repo\.(?:remote|ahead|uncommitted|skill-version)$/.test(entry.check)) return true;
  if (scope !== 'memory') return false;
  return /^(?:brain\.|repo\.(?:brain-log|brain-index|roadmap|roadmap-order|roadmap-overview|agents|skill-version)$)/.test(entry.check) || /^(?:brain|docs)\//.test(pathSpelling(entry.file));
}

export function runCheck({ memoryDir, repo, scope = 'all', config = loadConfig(), now = new Date(), today = new Date(now).toISOString().slice(0, 10), hook = false, noGit = false, quick = false, upgradesFile }) {
  const started = performance.now();
  requireMemory(memoryDir);
  if (!['all', 'memory'].includes(scope)) throw new Error('scope must be all or memory');
  if (!validDate(today)) throw new Error('invalid --today date; expected YYYY-MM-DD');
  config = {...config, caps: structuredClone(config.caps)};
  const caps = config.caps, findings = [], externalEdges = [];
  const add = (severity, check, file, line, message, value) => findings.push({ severity, check, file, line,
    message: redact(message), ...(value === undefined ? {} : { value }), allowed: false, reason: null });
  // Fixed kit defaults: malformed host groups cannot supply their own fallback.
  const groupDefaults = {
    lesson: {"enforceAfterRepeats": 2, "failAfterRepeats": 4, "lessonOnlyReturns": true},
    guard: {"kitRules": "scripts/memory/enforce-rules.kit.json", "rules": "scripts/memory/enforce-rules.json"},
    router: {"warnBytes": 12288, "failBytes": 16384, "failLineChars": 600, "warnLines": 150, "failLines": 200},
    index: {"pinSlackBytes": 1024, "pinWarnRoomBytes": 400, "warnLineChars": 300, "failLineChars": 450, "failBytesAbsolute": 24576, "hotBytes": 8192},
    archive: {"failLineChars": 300},
    topic: {"warnBytes": 8192, "failBytes": 20480, "warnLineChars": 2000},
    state: {"warnBytes": 4096, "failBytes": 8192, "maxStateHeadings": 1},
    hardRule: {"warnBytes": 2048, "failBytes": 4096},
    description: {"warnChars": 200, "failChars": 400},
    repoAhead: {"warn": 1, "fail": 10},
    brainLog: {"path": "brain/00-system/log.md", "warnBytes": 51200, "failBytes": 102400, "keepEntries": 20},
    brainIndex: {"path": "brain/00-system/index.md", "allPath": "brain/00-system/index-all.md", "maxBytes": 12288, "systemFiles": ["AGENTS.md", "schema.md", "edge-cases.md", "skills-index.md", "log.md", "index-all.md", "agents-background.md", "memory-ladder.md"]},
    roadmap: {"order": "newest-first", "path": "docs/ROADMAP.md", "warnBytes": 61440, "failBytes": 81920, "keepBlocks": 6},
    agents: {"path": "AGENTS.md", "warnBytes": 16384},
    brainNode: {"lengthChecks": false, "warnBodyWords": 350, "warnSummaryChars": 200},
    shelf: {"path": "docs/shelf", "reviewDays": 90},
    brainShared: {"paths": ["brain/_shared/"]},
    roadmapOverview: {"path": "docs/ROADMAP-OVERVIEW.md"},
    roadmapHistory: {"path": "docs/ROADMAP-HISTORY.md"},
    stale: {"types": ["project", "reference"]},
  };
  for (const [group, fallback] of Object.entries(groupDefaults)) {
    if (Object.hasOwn(caps, group) && (caps[group] === null || typeof caps[group] !== 'object' || Array.isArray(caps[group]))) {
      add('FAIL', 'config.caps', 'memory.config.json', null, `caps.${group} has invalid value ${JSON.stringify(caps[group])}; using defaults`);
      caps[group] = structuredClone(fallback);
    }
  }
  const capDefaults = {
    topic: {warnLineChars: 2000},
    lesson: {enforceAfterRepeats: 2, failAfterRepeats: 4, lessonOnlyReturns: true},
    guard: {kitRules: 'scripts/memory/enforce-rules.kit.json', rules: 'scripts/memory/enforce-rules.json'},
    router: {warnLines: 150, failLines: 200},
  };
  for (const [group, entries] of Object.entries(capDefaults)) for (const [key, fallback] of Object.entries(entries)) {
    const value = caps[group]?.[key];
    if (value === undefined) continue;
    const valid = typeof fallback === 'number' ? Number.isInteger(value) && value > 0 : typeof fallback === 'boolean' ? typeof value === 'boolean' : typeof value === 'string' && value.trim().length > 0;
    if (!valid) {
      add('FAIL', 'config.caps', 'memory.config.json', null, `caps.${group}.${key} has invalid value ${JSON.stringify(value)}; using default ${JSON.stringify(fallback)}`);
      caps[group][key] = fallback;
    }
  }
  try { loadUpgrades(upgradesFile); }
  catch (error) { add(error.code==='ENOENT'?'WARN':'FAIL', 'config.upgrades', 'upgrades.json', null, error.code==='ENOENT'?'missing deferred-upgrade ledger':'invalid deferred-upgrade ledger'); }
  let order;
  try { order = roadmapOrder(config); }
  catch (error) { add('FAIL', 'config.roadmap-order', 'memory.config.json', null, `${error.message}; got ${JSON.stringify(caps.roadmap.order)}`); }
  const parseCheck = f => {
    if (f.data.__error) add(f.inbox ? 'WARN' : 'FAIL', 'fm.parse', f.file, 1, 'unclosed frontmatter');
    else if (f.data.__warnings?.length) add('WARN', 'fm.parse', f.file, f.data.__warnings[0].line,
      `${f.data.__warnings.length} frontmatter line(s) not understood`, f.data.__warnings.length);
  };
  const scanSecrets = f => f.text.split(/\r?\n/).forEach((line, i) => {
    for (const [name, pattern] of Object.entries(secrets)) {
      if (pattern.test(line)) { add('FAIL', 'secret', f.file, i + 1, `${f.file}:${i + 1} secret pattern ${name}`); break; }
    }
  });
  const size = (id, file, bytes, cap) => {
    if (bytes > cap.failBytes) add('FAIL', id, file, null, `${bytes} bytes (max ${cap.failBytes})`, bytes);
    else if (bytes > cap.warnBytes) add('WARN', id, file, null, `${bytes} bytes (warn ${cap.warnBytes})`, bytes);
  };
  const lineCaps = (f, id, cap) => f.text.split(/\r?\n/).forEach((line, i) => {
    if (line.length > cap.failLineChars) add('FAIL', id, f.file, i + 1, `line is ${line.length} chars (max ${cap.failLineChars})`, line.length);
    else if (line.length > cap.warnLineChars) add('WARN', id, f.file, i + 1, `line is ${line.length} chars (warn ${cap.warnLineChars})`, line.length);
  });
  const files = memoryFiles(memoryDir), memoryNames = memoryNameIndex(files);
  const knownChecks = gateCheckIds(read(path.join(toolDir, 'memory-check.mjs')));
  const guard = repo ? loadRules({repo, config}) : {rules: [], errors: []};
  const relativeRules = file => path.relative(repo, file).replaceAll('\\', '/');
  const ruleProblems = new Set();
  const ruleProblem = (severity, file, message) => {
    const relative = relativeRules(file), key = `${relative}\0${message}`;
    if (ruleProblems.has(key)) return;
    ruleProblems.add(key);
    add(severity, 'enforce.rules', relative, null, message);
  };
  for (const error of guard.errors) if (fs.existsSync(error.file)) {
    const relative = relativeRules(error.file);
    const reason = error.reason.replaceAll(error.file, relative);
    const message = reason.startsWith(`rules file ${relative} is not valid JSON: `) ? reason : `rules file ${relative}: ${reason}`;
    ruleProblem('FAIL', error.file, message);
  }
  if (repo) {
    const kitFile = caps.guard?.kitRules ? path.resolve(repo, caps.guard.kitRules) : path.join(toolDir, 'enforce-rules.kit.json');
    let settings;
    try { settings = JSON.parse(read(path.join(repo, '.claude/settings.json'))); } catch {}
    const hasGuard = value => value && typeof value === 'object' && (typeof value.command === 'string' && value.command.includes('memory-guard.mjs') || Object.values(value).some(hasGuard));
    if (!fs.existsSync(kitFile) && hasGuard(settings?.hooks)) ruleProblem('WARN', kitFile, `rules file ${relativeRules(kitFile)} is missing; the command guard has no kit rules; run upgrade`);
  }
  const lessonIds = new Set(files.map(f => lessonIdentity(f.file)).filter(Boolean));
  for (const rule of guard.rules) for (const id of [rule.lesson ?? []].flat()) if (!lessonIds.has(id))
    ruleProblem('FAIL', rule.file, `rules file ${relativeRules(rule.file)}: rule ${rule.id}: lesson #${id} not found`);
  if (!quick) {
    const problems = scanChains(memoryDir, files).problems;
    if (problems.length) add('WARN', 'split.chain', 'MEMORY.md', null, `${problems.length} split-chain problems (back links, numbering, parent order); run memory-chains.mjs scan, then repair --write`, problems.length);
    const max = caps.topic.warnLineChars ?? 2000;
    for (const f of scanLines(memoryDir, max, files)) if (f.long)
      add('WARN', 'topic.line', f.file, f.line, `${f.long} lines over ${max} characters (${f.repairable} repairable), first at line ${f.line}; memory-chains.mjs lines --write recuts paragraphs; list items and lines without a sentence end need a hand cut`, f.long);
    for (const f of files.filter(f => !isGenerated(f.text))) for (const hit of scanChars(f.text)) {
      if (hit.check === 'chars.replacement') add('WARN', 'chars.replacement', f.file, hit.line, hit.message, hit.value);
      if (hit.check === 'chars.mojibake') add('WARN', 'chars.mojibake', f.file, hit.line, hit.message, hit.value);
      if (hit.check === 'chars.lost-dash') add('WARN', 'chars.lost-dash', f.file, hit.line, hit.message, hit.value);
    }
  }
  const reachable = ladderWalk(memoryDir, files);
  const listed = new Set(files.filter(f => f.special === 'index').flatMap(f => mdLinks(f.text).map(link => pathKey(memoryDir, link))));
  for (const f of files) {
    if (f.special || f.stub || f.state || /(?:^|[-_.])notes(?:[-_.]|$)/i.test(f.file)) continue;
    const key = pathKey(memoryDir, f.file);
    if ((routes(f.data).length || listed.has(key)) && !reachable.has(key))
      add('WARN', 'index.unreachable', f.file, null, 'not reachable from MEMORY.md through index and catalog pages');
  }
  const memoryPaths = new Set(files.map(f => pathKey(memoryDir, f.file)));
  const brains = (repo ? brainPaths(repo, config) : []).map(file => {
    const text = read(path.join(repo, config.brain?.dir ?? 'brain', file));
    return { file: `${config.brain?.dir ?? 'brain'}/${file}`, inbox: pathSpelling(file).startsWith('99-inbox/'), text, ...parseFrontmatter(text) };
  });
  const brainNames = brainNamesFromNodes(brains);
  const brainSubjects = new Set(brains.map(f => fmGet(f.data, 'id')).filter(id => typeof id === 'string')
    .map(id => id.replace(/^[a-z]{3}-/, '').replace(/-\d{4}-\d{2}(?:-\d{2})?$/, '')));
  const names = new Map(), linked = new Set();
  for (const f of files) {
    const name = fmGet(f.data, 'name');
    if (name) {
      if (names.has(name)) add('FAIL', 'name.duplicate', f.file, null, `name also used by ${names.get(name)}`);
      else names.set(name, f.file);
      if (pathSpelling(String(name)) !== pathSpelling(stem(f.file))) add('WARN', 'name.mismatch', f.file, null, 'name differs from filename');
    }
    if (f.special) {
      for (const target of mdLinks(f.text)) {
        const absolute = pathKey(memoryDir, target);
        linked.add(absolute);
        if (!memoryPaths.has(absolute) && (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile())) {
          const line = f.text.split(/\r?\n/).findIndex(text => mdLinks(text).includes(target)) + 1;
          add('FAIL', 'link.dead', f.file, line || null, `missing target ${target}`);
        }
      }
    }
  }
  // Backgrounds are reached through their topic, not duplicated in ARCHIVE.
  // Walk only existing memory targets from the established navigation roots;
  // unrooted cycles must remain orphans.
  const byPath = new Map(files.map(f => [pathKey(memoryDir, f.file), f]));
  const queue = [...linked], visited = new Set();
  for (let i = 0; i < queue.length; i++) {
    const key = queue[i];
    if (visited.has(key)) continue;
    visited.add(key);
    const parent = byPath.get(key);
    if (!parent) continue;
    for (const target of mdLinks(parent.text)) {
      const absolute = pathKey(memoryDir, target);
      if (byPath.has(absolute)) {
        if (!linked.has(absolute)) { linked.add(absolute); queue.push(absolute); }
      } else if (/-background(?:-\d+)?\.md$/i.test(target)) {
        add('FAIL', 'link.dead', parent.file, null, `missing background target ${target}`);
      }
    }
  }
  if (!files.some(f => f.special === 'router')) add('FAIL', 'router.missing', 'MEMORY.md', null, 'router is missing');
  for (const f of files) {
    if (f.special === 'router') {
      size('router.size', f.file, f.bytes, caps.router); lineCaps(f, 'router.line', caps.router);
      const lines = f.text ? f.text.replace(/\r?\n$/, '').split(/\r?\n/).length : 0;
      if (lines > (caps.router.failLines ?? 200)) add('FAIL', 'router.lines', f.file, null, `${lines} lines (max ${caps.router.failLines ?? 200}; Claude Code loads only the first 200 lines of MEMORY.md)`, lines);
      else if (lines > (caps.router.warnLines ?? 150)) add('WARN', 'router.lines', f.file, null, `${lines} lines (warn ${caps.router.warnLines ?? 150}; Claude Code loads only the first 200 lines of MEMORY.md)`, lines);
    }
    if (f.special === 'index') {
      if (!isGenerated(f.text) && !f.stub) {
      const pin = config.pins[pinKey(config.pins, f.file)];
      if (pin === undefined) add('FAIL', 'index.missing-pin', f.file, null, 'index has no pin');
      else if (f.bytes > pin) add('FAIL', 'index.pin', f.file, null, `${f.bytes} bytes exceeds pin ${pin}`, f.bytes);
      else if (pin - f.bytes < caps.index.pinWarnRoomBytes) add('WARN', 'index.pin', f.file, null, `${pin - f.bytes} bytes of pin room remain`, f.bytes);
      }
      if ((!isGenerated(f.text) || /-all(?:-\d+)?\.md$/.test(f.file)) && f.bytes > caps.index.failBytesAbsolute) add('FAIL', 'index.size', f.file, null, `${f.bytes} bytes (max ${caps.index.failBytesAbsolute})`, f.bytes);
      lineCaps(f, 'index.line', caps.index);
    }
    if (f.special === 'archive') lineCaps(f, 'archive.line', caps.archive);
    if (f.topic) size('topic.size', f.file, f.bytes, caps.topic);
    if (f.state) {
      size('state.size', f.file, f.bytes, caps.state);
      const headings = f.text.split(/\r?\n/).filter(line => /^#{1,6}[ \t].*\b(RESUME|CURRENT)\b/i.test(line));
      if (headings.length > caps.state.maxStateHeadings) add('FAIL', 'state.headings', f.file, null, `${headings.length} state headings (max ${caps.state.maxStateHeadings})`, headings.length);
    }
    if (f.hardRule) size('hardrule.size', f.file, f.bytes, caps.hardRule);
    if (!f.special) {
      const desc = fmGet(f.data, 'description');
      if (!f.data.__error && (typeof desc !== 'string' || !desc.trim())) add('FAIL', 'desc.missing', f.file, null, 'description is missing');
      else if (typeof desc === 'string') {
        const words = descriptionWords(desc);
        if (words && ((' ' + descriptionWords(stem(f.file)) + ' ').includes(' ' + words + ' ') || words === descriptionWords(fmGet(f.data, 'name'))))
          add('WARN', 'desc.slug', f.file, null, 'description only restates the filename or name; add useful context');
        if (desc.length > caps.description.failChars) add('FAIL', 'desc.length', f.file, null, `description is ${desc.length} chars (max ${caps.description.failChars})`, desc.length);
        else if (desc.length > caps.description.warnChars) add('WARN', 'desc.length', f.file, null, `description is ${desc.length} chars (warn ${caps.description.warnChars})`, desc.length);
        if (/Newest:/i.test(desc)) add('FAIL', 'desc.changelog', f.file, null, 'description contains a changelog marker');
      }
      if (!f.stub && !linked.has(pathKey(memoryDir, f.file))) add('WARN', 'link.orphan', f.file, null, 'file is not reachable from router, index or archive');
    }
    if (f.stub) {
      const moved = fmGet(f.data, 'moved_to');
      for (const target of Array.isArray(moved) ? moved : [moved]) {
        if (!stubTargetExists(target, memoryDir, repo, config)) add('FAIL', 'stub.target', f.file, null, `moved_to target is missing or invalid: ${String(target)}`);
      }
    }
    const pointer = fmGet(f.data, 'brain');
    if (pointer !== undefined) {
      if (typeof pointer !== 'string' || !pointer.replaceAll('\\', '/').startsWith((config.brain?.dir ?? 'brain').replaceAll('\\', '/') + '/') || !stubTargetExists(pointer, memoryDir, repo, config))
        add('FAIL', 'brain.pointer', f.file, null, 'brain pointer target is missing or invalid');
    } else if (['project', 'reference'].includes(fmGet(f.data, 'type')) && brainSubjects.has(fmGet(f.data, 'name'))) {
      add('WARN', 'brain.pointer-missing', f.file, null, 'same-subject brain node exists; add a brain pointer');
    }
    for (const target of new Set(wikilinks(f.text))) {
      if (!memoryWikilink(target, memoryNames, brainNames)) add('WARN', 'wikilink.dead', f.file, null, `unresolved wikilink ${target}`);
    }
    parseCheck(f);
    scanSecrets(f);
  }
  const casebook = lessonCases();
  const generated = files.some(f => isGenerated(f.text));
  const families = routerFamilies(read(path.join(memoryDir, 'MEMORY.md')), memoryDir);
  for (const [family, trigger] of families) if (!hasTrigger(trigger)) add('FAIL', 'route.trigger', 'MEMORY.md', null, `family ${family} has no OPEN/trigger line; add OPEN BEFORE or WHEN to its routing row`);
  for (const f of files.filter(f => f.special === 'index' && isGenerated(f.text) && !/-all(?:-\d+)?\.md$/i.test(f.file)))
    if (!hasTrigger(f.text.split(/\r?\n/).slice(0,8).join('\n'))) add('FAIL', 'index.trigger', f.file, null, 'generated hot page has no trigger in its first 8 lines; fix its router row and regenerate');
  for (const f of files.filter(f => !f.special && !f.stub)) {
    const id = lessonIdentity(f.file) ?? f.file;
    const future = (field, value) => {
      if (typeof value !== 'string') return;
      const date = value.slice(0, 10);
      if (!validDate(date) || date <= today) return;
      const message = `${field} ${date} is later than today (${today})`;
      if ((Date.parse(date) - Date.parse(today)) / 86400000 > 1) add('FAIL', 'date.future', f.file, null, message);
      else add('WARN', 'date.future', f.file, null, message);
    };
    future('date', lessonField(f.data, 'date')); future('modified', lessonField(f.data, 'modified'));
    const rawRepeats = lessonField(f.data, 'repeats'), enforced = lessonField(f.data, 'enforced');
    const validRepeats = rawRepeats === undefined || (Array.isArray(rawRepeats) && rawRepeats.every(e => typeof e === 'string' && e.length <= 200 && REPEAT_ENTRY.test(e) && validDate(e.slice(0, 10))));
    if (!validRepeats) add('FAIL', 'lesson.repeats', f.file, null, 'repeat entries must read "YYYY-MM-DD <slip|not-recalled|rule-wrong|new-case|legacy>: note", at most 200 characters');
    const repeats = validRepeats ? rawRepeats ?? [] : [];
    for (const entry of Array.isArray(rawRepeats) ? rawRepeats : []) future('repeats', entry);
    future('enforced', enforced);
    let decision = typeof enforced === 'string' && !/[\r\n]/.test(enforced) && /^(\d{4}-\d{2}-\d{2}) (hard-rule|check|hook|lesson-only) (\S[^\r\n]*)$/.exec(enforced);
    let validDecision = enforced === undefined;
    if (decision && validDate(decision[1])) {
      const [, , kind, where] = decision;
      const repoFile = () => {
        if (!repo) return false;
        try {
          const target = fs.realpathSync(path.resolve(repo, where)), relative = path.relative(fs.realpathSync(repo), target);
          return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && fs.statSync(target).isFile();
        } catch { return false; }
      };
      validDecision = kind === 'lesson-only' ? where.trim().length >= 10 : kind === 'hard-rule' ? files.some(item => item.hardRule && pathKey(memoryDir, item.file) === pathKey(memoryDir, where)) : kind === 'hook' ? !repo || repoFile() : knownChecks.includes(where) || repoFile();
      const rulesPaths = repo ? [caps.guard?.kitRules ?? path.join(toolDir, 'enforce-rules.kit.json'), caps.guard?.rules ?? 'scripts/memory/enforce-rules.json'].map(p => pathKey(repo, p)) : [];
      if (repo && validDecision && kind === 'hook' && rulesPaths.includes(pathKey(repo, where)) && !guard.rules.some(r => [r.lesson ?? []].flat().includes(id)))
        ruleProblem('WARN', path.resolve(repo, where), `rules file ${relativeRules(path.resolve(repo, where))}: lesson enforced by hook ${relativeRules(path.resolve(repo, where))} but no rule names #${id}`);
    }
    if (!validDecision) add('WARN', 'lesson.enforced', f.file, null, 'enforced must name a valid date and hard-rule card, check, repo hook file or lesson-only reason of at least 10 characters');
    if (!validDecision) decision = null;
    if (validRepeats) {
      const count = decision ? repeats.filter(e => e.slice(0, 10) > decision[1]).length : repeats.length;
      const returns = !decision || decision[2] !== 'lesson-only' || (caps.lesson?.lessonOnlyReturns ?? true);
      if (returns && count >= Math.min(decision ? 1 : caps.lesson?.enforceAfterRepeats ?? 2, caps.lesson?.failAfterRepeats ?? 4)) {
        const fail = count >= (caps.lesson?.failAfterRepeats ?? 4);
        let message = decision ? decision[2] === 'lesson-only' ? `repeated ${count} times after the lesson-only decision on ${decision[1]}; decide again: enforce it or record lesson-only anew` : `repeated ${count} times after the decision on ${decision[1]} (${decision[2]} ${decision[3]}); decide again` : fail ? failSentence({count, id}) : enforceSentence({count, last: repeats.map(e => e.slice(0, 10)).sort().at(-1), id});
        if (!validDecision) message += '; the recorded decision is invalid: enforced must name a valid date and hard-rule card, check, repo hook file or lesson-only reason of at least 10 characters';
        if (fail) add('FAIL', 'lesson.enforce', f.file, null, message, count);
        else add('WARN', 'lesson.enforce', f.file, null, message, count);
      }
    }
    if (repeats.length && !String(lessonField(f.data, 'trigger') ?? '').trim()) add('WARN', 'lesson.trigger', f.file, null, 'repeated lesson has no trigger; add metadata.trigger ("before ..." or "when ...")');
    if (/^lesson-.*\.md$/.test(f.file)) {
      const takeaway = lessonField(f.data, 'takeaway');
      if (takeaway !== undefined && !['fix', 'method', 'know'].includes(takeaway)) add('WARN', 'lesson.takeaway', f.file, null, `takeaway ${JSON.stringify(takeaway)} must be fix, method or know`);
      const kindCase = lessonField(f.data, 'kind_case');
      if (kindCase !== undefined) {
        if (casebook.missing) add('WARN', 'kind.case', f.file, null, `LESSON-KINDS.md is missing; cannot validate kind case ${String(kindCase)}`);
        else if (!casebook.ids.has(kindCase)) add('WARN', 'kind.case', f.file, null, `unknown kind case ${String(kindCase)}; see LESSON-KINDS.md`);
        else if (casebook.superseded.has(kindCase)) add('WARN', 'kind.case-superseded', f.file, null, `kind case ${kindCase} is superseded by ${casebook.superseded.get(kindCase)}; relabel with classify --write`);
      }
      const kind = lessonField(f.data, 'kind');
      if (kind !== undefined && !KINDS.includes(kind)) add('FAIL', 'lesson.kind', f.file, null, `kind "${String(kind)}" is not mistake, practice or observation`);
      const body = f.body.replace(/^\s*\S[^\n]*(?:\n|$)/, ''), lines = body.split(/\r?\n/), prompts = [];
      for (let i = 0; i < lines.length; i++) if (/^\*\*(?:Why|How to apply):\*\*$/.test(lines[i].trim())) prompts.push(i);
      if (prompts.some((at, i) => !lines.slice(at + 1, prompts[i + 1] ?? lines.length).join('\n').trim())) add('FAIL', 'lesson.unfilled-body', f.file, null, 'fill the empty **Why:** / **How to apply:** section');
      if (generated && !routes(f.data).length) add('FAIL', 'route.missing', f.file, null, 'lesson has no route');
      if (fmGet(f.data, 'description') === 'TODO') add('FAIL', 'lesson.unfilled', f.file, null, 'fill the TODO description');
    }
    for (const route of routes(f.data)) if (!families.has(route)) add('FAIL', 'route.unknown', f.file, null, `unknown route ${route}; known families: ${[...families.keys()].join(', ')}`);
    const hookText = lessonField(f.data, 'hook');
    if (hookText !== undefined && (typeof hookText !== 'string' || hookText.length > 200)) add('FAIL', 'lesson.hook', f.file, null, 'hook must be a string of at most 200 characters');
  }
  if (generated) {
    try {
      const expected = generateMemoryIndex({memoryDir, config});
      for (const [file, text] of Object.entries(expected.pages)) if (read(path.join(memoryDir, file)).replace(/\r\n/g, '\n') !== text)
        add('FAIL', 'index.stale', file, null, 'regenerate with memory-index.mjs --write');
      for (const file of expected.removed) add('FAIL', 'index.stale', file, null, 'obsolete generated page; run memory-index.mjs --write');
      for (const family of expected.overflow) add('WARN', 'index.hot-budget', `INDEX-${family}.md`, null, 'topics and pins exceed hot budget');
    } catch (error) { add('FAIL', 'index.stale', 'MEMORY.md', null, error.message + '; run memory-index.mjs --write'); }
  }
  const lessons = files.filter(f => lessonIdentity(f.file));
  const missingKinds = lessons.filter(f => lessonField(f.data, 'kind') === undefined).length;
  if (missingKinds) add('WARN', 'lesson.kind-missing', 'MEMORY.md', null, `${missingKinds} lessons have no metadata.kind; classify them with memory-lesson.mjs classify FILE --write`, missingKinds);
  if (lessons.length) {
    const seen = new Set();
    for (const f of lessons) {
      const number = lessonIdentity(f.file);
      if (seen.has(number)) add('FAIL', 'lessons.duplicate', f.file, null, `duplicate lesson number ${number}`, lessons.filter(item => lessonIdentity(item.file) === number).length);
      seen.add(number);
    }
    for (const f of files.filter(f => ['router', 'index'].includes(f.special))) {
      if (f.special === 'router' || /^INDEX-craft-/.test(f.file)) {
        for (const m of f.text.matchAll(/#(\d+[a-z]*)\b/g)) {
          const id = m[1].replace(/^\d+/, n => n.padStart(3, '0'));
          if (!seen.has(id)) add('FAIL', 'lessons.cite', f.file, f.text.slice(0, m.index).split('\n').length, `#${m[1]} has no matching lesson file`);
        }
      }
    }
  }
  if (noGit) add('WARN', 'repo.git-skipped', '.', null, 'git health and committed-age checks skipped (--no-git)');
  else gitState(memoryDir, files, caps, today, add, hook, inRepoMemory(repo, memoryDir));
  if (scope === 'all' && repo) {
    const receiptFile = path.join(repo, 'scripts/memory/KIT.json');
    const manifestFile = path.join(repo, 'scripts/memory/MANIFEST.json');
    if (fs.existsSync(receiptFile)) {
      const warn = (file, error) => add('WARN', 'kit.manifest', file, null,
        error.code === 'ENOENT' ? 'missing: ' + file : String(error.message).replace(/[\r\n]+/g, ' '));
      try {
      const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')), manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      for (const [file, expected] of Object.entries(manifest.files)) {
        try {
        const absolute = path.resolve(repo, file), relative = path.relative(repo, absolute);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('manifest path escapes repository');
        const actual = createHash('sha256').update(fs.readFileSync(absolute, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
        if (actual !== expected) {
          add('WARN', 'kit.manifest', file, null, 'edited locally: ' + file);
          if (receipt.version === manifest.version && /^scripts\/memory\/.*\.mjs$/.test(file)) add('FAIL', 'kit.version', file, null, 'same version, different engine');
        }
        } catch (error) { warn(file, error); }
      }
      for (const name of ['memory-ladder', 'memory-review']) {
        const file = '.claude/skills/' + name + '/SKILL.md';
        try {
        const version = fmGet(parseFrontmatter(read(path.join(repo, file))).data, 'engine_version');
        if (version !== receipt.version) add('WARN', 'kit.manifest', file, 1, 'kit version ' + receipt.version + ', skills ' + (version ?? 'missing'));
        } catch (error) { warn(file, error); }
      }
      } catch (error) { warn('scripts/memory/MANIFEST.json', error); }
    }
    if (!hook) for (const name of ['memory-ladder', 'memory-review']) {
      const file = `.claude/skills/${name}/SKILL.md`, absolute = path.join(repo, file);
      if (!fs.existsSync(absolute)) continue;
      let version;
      try { const data = parseFrontmatter(read(absolute)).data; version = data.metadata?.engine_version ?? data.engine_version;
        if (Object.hasOwn(data, 'engine_version')) add('WARN', 'repo.skill-version', file, 1, 'legacy top-level engine_version; upgrade the skill to metadata.engine_version'); }
      catch (error) { add('WARN', 'repo.skill-version', file, null, error.message); continue; }
      if (version !== config.engine_version) add('WARN', 'repo.skill-version', file, 1,
        `engine_version ${version ?? 'missing'}; expected ${config.engine_version}`);
    }
    const secretFiles = [
      ...walkMd(path.join(repo, config.brain?.dir ?? 'brain')).map(file => `${config.brain?.dir ?? 'brain'}/${file}`),
      'AGENTS.md', 'CLAUDE.md',
      ...listMd(path.join(repo, 'docs')).filter(file => /^ROADMAP.*\.md$/i.test(file)).map(file => `docs/${file}`),
    ];
    for (const file of secretFiles) scanSecrets({ file, text: read(path.join(repo, file)) });
    for (const [key, id] of [['brainLog', 'repo.brain-log'], ['roadmap', 'repo.roadmap'], ['agents', 'repo.agents']]) {
      size(id, caps[key].path, utf8Bytes(read(path.join(repo, caps[key].path))), caps[key]);
    }
    if (caps.brainIndex && typedBrainCount(repo, config)) {
    try {
      const generated = generateIndex({ repo, config });
      const {pairs} = brainIndexPairs(repo, config, generated);
      for (const [file, text] of pairs) if (normalizeEol(read(path.join(repo, file))) !== normalizeEol(text))
        add('WARN', 'repo.brain-index', file, null, 'generated index stale; regenerate with brain-index.mjs --write (hand-written index preserved)');
    } catch (error) { add('WARN', 'repo.brain-index', caps.brainIndex.path, null, error.message); }
    }
    const roadmap = read(path.join(repo, caps.roadmap.path)), open = /^## Open work\b[^\r\n]*\r?\n/m.exec(roadmap);
    if (open) {
      const rest = roadmap.slice(open.index + open[0].length), end = /^#{1,3} /m.exec(rest);
      const dates = [...rest.slice(0, end?.index ?? rest.length).matchAll(/^\*\*(\d{4}-\d{2}-\d{2})[^\r\n]*(?:\r?\n|$)/gm)].map(m => m[1]).filter(validDate);
      if (order && dates.length > 1 && (order === 'newest-first' ? dates[0] < dates.at(-1) : dates[0] > dates.at(-1)))
        add('WARN', 'repo.roadmap-order', caps.roadmap.path, null, `Open work dates contradict ${order}: first ${dates[0]}, last ${dates.at(-1)}`);
    }
    if (fs.existsSync(path.join(repo, caps.roadmap.path))) try {
      if (read(path.join(repo, caps.roadmapOverview.path)) !== generateOverview({ repo, config }))
        add('WARN', 'repo.roadmap-overview', caps.roadmapOverview.path, null, 'stale or missing; regenerate with roadmap-overview.mjs --write');
    } catch (error) { add('WARN', 'repo.roadmap-overview', caps.roadmapOverview.path, null, error.message); }
    for (const rel of walkMd(path.join(repo, caps.shelf.path))) {
      const file = `${caps.shelf.path}/${rel}`, data = parseFrontmatter(read(path.join(repo, file))).data;
      for (const key of ['status', 'shelved', 'review']) {
        if (key === 'status' ? fmGet(data, key) !== 'shelved' : !validDate(fmGet(data, key))) add('FAIL', 'shelf.frontmatter', file, null, `missing or invalid ${key}`);
      }
      const shelved = fmGet(data, 'shelved'), review = fmGet(data, 'review');
      if (validDate(shelved) && validDate(review)) {
        if ((Date.parse(review) - Date.parse(shelved)) / 86400000 > caps.shelf.reviewDays)
          add('FAIL', 'shelf.frontmatter', file, null, `shelved ${shelved}, review ${review}: exceeds ${caps.shelf.reviewDays}-day limit`);
        if (today >= review) add('WARN', 'shelf.review-due', file, null, `review due ${review} (shelved ${shelved})`);
      }
    }
    const unresolved = (f, key, target, message) => {
      if (resolveWikilink(target, name => brainNames.has(pathSpelling(name)))) return;
      if (caps.brainShared.paths.some(prefix => pathSpelling(f.file).startsWith(pathSpelling(prefix.replace(/\/$/, '') + '/')))) externalEdges.push({ file: f.file, key, target });
      else add('WARN', 'brain.edge', f.file, null, message);
    };
    const ids = new Map();
    for (const f of brains) {
      parseCheck(f);
      const id = fmGet(f.data, 'id');
      if (!f.inbox && (!id || !fmGet(f.data, 'type'))) add('FAIL', 'brain.frontmatter', f.file, null, 'node requires id and type');
      const idKey = `${pathSpelling(f.file).startsWith(pathSpelling(`${config.brain?.dir ?? 'brain'}/_shared/`)) ? 'shared' : 'project'}:${id}`;
      if (id && ids.has(idKey)) add('FAIL', 'brain.duplicate-id', f.file, null, `id also used by ${ids.get(idKey)}`);
      else if (id) ids.set(idKey, f.file);
      for (const key of edgeFields) {
        for (const target of wikilinks(JSON.stringify(fmGet(f.data, key) ?? ''))) {
          unresolved(f, key, target, `unresolved ${key} edge ${target}`);
        }
      }
      for (const edge of Array.isArray(f.data.edges) ? f.data.edges : []) {
        if (typeof edge?.target !== 'string') continue;
        const targets = wikilinks(edge.target);
        for (const target of targets.length ? targets : [edge.target]) {
          unresolved(f, 'edges', target, `unresolved edges target ${target}`);
        }
      }
      if (caps.brainNode.lengthChecks) {
        const words = f.body.trim().split(/\s+/).filter(Boolean).length;
        const summary = String(fmGet(f.data, 'summary') ?? '').length;
        if (words > caps.brainNode.warnBodyWords) add('WARN', 'brain.length', f.file, null, `${words} body words`, words);
        if (summary > caps.brainNode.warnSummaryChars) add('WARN', 'brain.length', f.file, null, `${summary} summary chars`, summary);
      }
    }
  }
  const originals = [...findings];
  const byCheck = new Map();
  for (const f of originals) {
    if (!byCheck.has(f.check)) byCheck.set(f.check, []);
    byCheck.get(f.check).push({ finding: f, file: pathSpelling(f.file) });
  }
  const ceilings = new Map();
  for (const entry of config.allow) {
    if (!validAllow(entry)) {
      add('FAIL', 'config.allow', 'memory.config.json', null, 'allow entry requires check, file, reason and added; secret and config.* cannot be allowed');
      continue;
    }
    if (notEvaluated(entry, scope, hook, noGit, inRepoMemory(repo, memoryDir), quick)) continue;
    const pattern = glob(pathSpelling(entry.file));
    const matches = (byCheck.get(entry.check) || []).filter(item => pattern.test(item.file)).map(item => item.finding);
    if (!matches.length) add('WARN', 'config.allow-stale', entry.file, null, `allow entry for ${entry.check} matches no finding`);
    for (const finding of matches) {
      if (finding.check === 'fm.parse' && finding.severity === 'FAIL') continue;
      if (entry.ceiling !== undefined && !(finding.value <= entry.ceiling)) {
        ceilings.set(finding, Math.max(ceilings.get(finding) ?? -Infinity, entry.ceiling));
      } else { finding.allowed = true; finding.reason = redact(entry.reason); }
    }
  }
  for (const [finding, ceiling] of ceilings) if (!finding.allowed) finding.message = redact(`${finding.message} (grew past allowed ceiling ${ceiling})`);
  // Filenames and reasons can themselves contain credential-shaped text.
  for (const finding of findings) finding.file = redact(finding.file);
  for (const edge of externalEdges) edge.file = redact(edge.file);
  findings.sort((a, b) => (a.severity === 'FAIL' ? 0 : 1) - (b.severity === 'FAIL' ? 0 : 1) || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.check.localeCompare(b.check));
  const largest = files.reduce((max, f) => f.bytes > max.bytes ? { file: redact(f.file), bytes: f.bytes } : max, { file: null, bytes: 0 });
  return { version: config.engine_version, scope, hook, noGit, quick, inRepo: inRepoMemory(repo, memoryDir), findings, externalEdges, stats: { files: files.length,
    inboxNotes: brains.filter(f => f.inbox).length,
    bytes: files.reduce((n, f) => n + f.bytes, 0), largest, ms: Math.round(performance.now() - started) } };
}

export function counts(result) {
  return { FAIL: result.findings.filter(f => !f.allowed && f.severity === 'FAIL').length,
    WARN: result.findings.filter(f => !f.allowed && f.severity === 'WARN').length,
    allowed: result.findings.filter(f => f.allowed).length };
}
export const findingLine = f => redact(`${f.severity} ${f.check} ${f.file}${f.line ? `:${f.line}` : ''} ${f.message}`);
export function ratchetPins({ memoryDir, config, configFile = path.join(toolDir, 'memory.config.json') }) {
  const changes = [], next = {};
  for (const f of memoryFiles(memoryDir).filter(f => f.special === 'index' && !isGenerated(f.text))) {
    const old = config.pins[pinKey(config.pins, f.file)], limit = f.bytes + config.caps.index.pinSlackBytes;
    next[f.file] = old === undefined ? limit : Math.min(old, limit);
    if (old !== next[f.file]) changes.push(`${f.file}: ${old ?? 'missing'} -> ${next[f.file]}`);
  }
  for (const file of Object.keys(config.pins)) if (pinKey(next, file) === undefined) changes.push(`${file}: removed`);
  config.pins = next;
  writeText(configFile, `${JSON.stringify(config, null, 2)}\n`);
  return changes;
}
export function writeAllowlist({ result, config, reason, configFile = path.join(toolDir, 'memory.config.json'), now = new Date() }) {
  if (!reason?.trim()) throw new Error('allowlist reason must not be empty');
  const eligible = result.findings.filter(f => f.check !== 'secret' && !f.check.startsWith('config.') && !(f.check === 'fm.parse' && f.severity === 'FAIL'));
  const active = result.findings.filter(f => !f.check.startsWith('config.'));
  config.allow = config.allow.filter(entry => {
    if (!validAllow(entry)) return true;
    if (notEvaluated(entry, result.scope, result.hook, result.noGit, result.inRepo, result.quick)) return true;
    const pattern = glob(pathSpelling(entry.file));
    return active.some(f => f.check === entry.check && pattern.test(pathSpelling(f.file)));
  });
  const existing = config.allow.filter(validAllow).map(entry => ({ check: entry.check, pattern: glob(pathSpelling(entry.file)) }));
  const groups = new Map();
  for (const f of eligible) {
    const key = `${f.check}\0${f.file}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  let added = 0;
  for (const group of groups.values()) {
    if (existing.some(entry => entry.check === group[0].check && entry.pattern.test(pathSpelling(group[0].file))) || group.every(f => f.allowed)) continue;
    const f = group[0], values = group.map(item => item.value).filter(Number.isFinite);
    config.allow.push({ check: f.check, file: f.file, reason, added: new Date(now).toISOString().slice(0, 10),
      ...(values.length ? { ceiling: Math.max(...values) } : {}) });
    added++;
  }
  writeText(configFile, `${JSON.stringify(config, null, 2)}\n`);
  return added;
}
export function main(argv = process.argv.slice(2)) {
  const session = argv.includes('--session-start'), hook = argv.includes('--hook');
  try {
    const opts = args(argv);
    if (opts.help) { console.log('Usage: node scripts/memory/memory-check.mjs [--memory-dir PATH] [--repo PATH] [--scope all|memory] [--json] [--session-start] [--hook] [--ratchet-pins] [--write-allowlist REASON] [--config FILE]'); return 0; }
    const loc = locations(opts);
    requireMemory(loc.memoryDir);
    const configFile = opts.config ? path.resolve(opts.config) : path.join(toolDir, 'memory.config.json');
    const config = JSON.parse(read(configFile));
    if (opts['ratchet-pins'] && !session) {
      for (const change of ratchetPins({ ...loc, config, configFile })) console.log(change);
      return 0;
    }
    const options = {...loc, config, hook, quick: session, today: opts.today, noGit: Boolean(opts['no-git']), scope: session ? 'all' : opts.scope || 'all'};
    const result = hook && !session ? stagedCheck(options) : runCheck(options);
    if (opts['write-allowlist'] && !session) {
      console.log(`allowlist: ${writeAllowlist({ result, config, configFile, reason: opts['write-allowlist'] })} entries added`);
      return 0;
    }
    const c = counts(result), mode = inRepoMemory(loc.repo, loc.memoryDir) ? "; in-repo memory" : "";
    if (session) {
      if (c.FAIL) {
        result.findings.filter(f => !f.allowed && f.severity === 'FAIL').slice(0, 4).forEach(f => console.log(findingLine(f)));
        console.log(`memory gate: ${c.FAIL} FAIL${mode} - run: node scripts/memory/memory-check.mjs`);
      } else console.log(`memory gate: ok (${c.allowed} allowed, ${c.WARN} warn, engine ${result.version}${mode})`);
      const repeats = result.findings.filter(f => !f.allowed && f.check === 'lesson.enforce').sort((a, b) => (a.severity === 'FAIL' ? 0 : 1) - (b.severity === 'FAIL' ? 0 : 1) || b.value - a.value || a.file.localeCompare(b.file)).slice(0, 3);
      if (repeats.length) console.log('repeats: ' + repeats.map(f => `#${lessonIdentity(f.file) ?? f.file} (${f.value}, ${f.message.includes('after the') ? 'after decision' : 'no decision'}; ${f.severity})`).join(', '));
      return 0;
    }
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`memory: ${loc.memoryDir} (${loc.memorySource})`);
      result.findings.filter(f => !f.allowed).forEach(f => console.log(findingLine(f)));
      if (result.externalEdges.length) console.log(`${result.externalEdges.length} external edges in shared folders (owned by the shared core; see --json externalEdges)`);
      console.log(`memory-check ${result.version} [${result.scope}]: ${c.FAIL} FAIL, ${c.WARN} WARN, ${c.allowed} allowed, ${result.stats.files} files, ${result.stats.inboxNotes} inbox notes, ${Math.round(result.stats.bytes / 1024)} KB, ${result.stats.ms} ms${mode}`);
    }
    return c.FAIL ? 1 : 0;
  } catch (error) {
    const message = redact(String(error.message).replace(/[\r\n]+/g, ' '));
    if (hook && !session) {
      const blocked = error.code === 'SNAPSHOT_EXTRACTION';
      console.log(`memory gate: ${blocked ? 'commit blocked' : 'error'}: ${message}`); return blocked ? 1 : 0;
    }
    console.log(session ? (message === 'memory dir not found' ? 'memory gate: memory dir not found' : `memory gate: error ${message}`) : `memory-check: error ${message}`);
    return session ? 0 : 1;
  }
}
export function stagedCheck(options) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-stage-'));
  let snapshot = temp;
  try {
    try {
      const memoryDir = fs.realpathSync(options.memoryDir);
      const root = fs.realpathSync(childProcess.execFileSync('git', ['-C', memoryDir, 'rev-parse', '--show-toplevel'], {encoding: 'utf8', stdio: 'pipe', timeout: 30000}).trim());
      const relative = path.relative(root, memoryDir);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('memory directory outside git root');
      snapshot = path.join(temp, relative);
      const entries = childProcess.execFileSync('git', ['-C', memoryDir, 'ls-files', '--cached', '--full-name', '-z', '--', '.'], {stdio: 'pipe', timeout: 30000, maxBuffer: 32 * 1024 * 1024});
      childProcess.execFileSync('git', ['-C', root, 'checkout-index', '--force', '-z', '--stdin', '--prefix=' + temp.replace(/\\/g, '/') + '/'], {input: entries, stdio: 'pipe', timeout: 30000});
      fs.mkdirSync(snapshot, {recursive: true});
    } catch (error) { throw Object.assign(new Error('staged snapshot extraction failed: ' + error.message), {code: 'SNAPSHOT_EXTRACTION'}); }
    const result = runCheck({...options, memoryDir: snapshot, noGit: true});
    result.findings = result.findings.filter(f => f.check !== 'repo.git-skipped');
    if (!options.noGit) gitState(fs.realpathSync(options.memoryDir), memoryFiles(snapshot), options.config.caps, options.today ?? options.now ?? new Date(), (severity, check, file, line, message, value) => result.findings.push({severity, check, file, line, message, value}), true);
    return result;
  } finally { fs.rmSync(temp, {recursive: true, force: true}); }
}
if (isDirect(import.meta.url)) process.exitCode = main();
