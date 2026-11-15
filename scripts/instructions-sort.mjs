// Sorts an old memory section without writing the project, and keeps sorting decisions in a ledger file.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {kitRoot} from './manifest.mjs';
import {resolveMemory} from '../engine/memory-setup.mjs';
import {inRepoMemory, isDirect, cleanGitEnv} from '../engine/lib.mjs';
import {standardBlockPlan, readDecisions} from './install-safety.mjs';
import {encodeEntry, parseLedger, ledgerKey, reportEntry} from './instructions-block.mjs';

export const USAGE = `Usage: node scripts/instructions-sort.mjs <command> [options]

  preview --target <PROJECT> [--out <FOLDER>] [--decisions <FILE>] [--memory-dir <MEMORY>] [--ledger <FILE>]
      Print how each line of the old memory section would be sorted. With --out, write
      sort-report.json and decisions.json into FOLDER, which must be outside the project.
  ledger-add --from <REPORT> --project <NAME> --ledger <FILE>
      Append a real run's instructions-report.json to a sorting ledger; refused on branch main.
  ledger-show --ledger <FILE> [--id <ID>]
      Print the ledger's entries, decoded.
`;
const commands = {
  preview: ['target', 'out', 'decisions', 'memory-dir', 'ledger'],
  'ledger-add': ['from', 'project', 'ledger'],
  'ledger-show': ['ledger', 'id'],
};
export function parse(argv) {
  const command = argv[0], allowed = commands[command];
  if (!allowed) throw Error('usage');
  const opts = {command};
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i].startsWith('--') ? argv[i].slice(2) : null;
    if (!key || !allowed.includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--') || Object.hasOwn(opts, key)) throw Error('usage');
    opts[key] = argv[++i];
  }
  return opts;
}
// Resolves symlinks and junctions of the deepest existing parent.
function canonical(file) {
  let parent = path.resolve(file);
  const tail = [];
  while (!fs.existsSync(parent)) { tail.unshift(path.basename(parent)); const next = path.dirname(parent); if (next === parent) break; parent = next; }
  return path.join(fs.realpathSync.native(parent), ...tail);
}
const within = (root, file) => { const rel = path.relative(root, file); return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)); };

export function preview(opts, root = kitRoot) {
  if (!opts.target) throw Error('usage');
  const target = path.resolve(opts.target);
  if (opts.out && within(canonical(target).toLowerCase(), canonical(opts.out).toLowerCase())) { console.error('preview: --out must be outside the project'); return 1; }
  let inRepo = false;
  try { inRepo = inRepoMemory(target, resolveMemory(target, opts['memory-dir']).dir); } catch {}
  const result = standardBlockPlan(target, root, {check: true, inRepo, 'instructions-decisions': opts.decisions, 'instructions-ledger': opts.ledger});
  if (result.refusal && result.refusalKind !== 'unclear') { console.error('preview: ' + result.refusal); return 1; }
  const main = result.plans[0];
  if (!main) return 0;
  const units = main.plan.units, count = outcome => units.filter(unit => unit.outcome === outcome).length;
  console.log(`preview: ${units.length} units: ${count('replace')} replace, ${count('keep')} keep, ${count('drop')} drop, ${count('unclear')} unclear`);
  if (!opts.out) return 0;
  const project = (opts.decisions && readDecisions(path.resolve(opts.decisions)).project) || path.basename(target);
  const date = new Date().toISOString().slice(0, 10), out = path.resolve(opts.out);
  const report = {version: 1, kit: fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim(), project, date, file: main.name,
    entries: units.map(unit => reportEntry(unit, {project, file: main.name, date}))};
  const decisions = {version: 1, project, decisions: Object.fromEntries(units.filter(unit => unit.outcome === 'unclear').map(unit => [unit.id, {
    text: unit.raw.replace(/\r\n/g, '\n'),
    ...(unit.suggestion ? {suggestion: `${unit.suggestion.outcome} by ${unit.suggestion.project}, ${unit.suggestion.date}: ${unit.suggestion.reason}`} : {}),
    ...(unit.conflict ? {suggestion: 'ledger conflict: ' + unit.matched.map(entry => `${entry.outcome} by ${entry.project}, ${entry.date}: ${entry.reason}`).join('; ')} : {}),
    outcome: '', scope: 'project', reason: '', decidedBy: ''}]))};
  fs.mkdirSync(out, {recursive: true});
  fs.writeFileSync(path.join(out, 'sort-report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'decisions.json'), JSON.stringify(decisions, null, 2) + '\n');
  console.log(`preview: wrote ${path.join(out, 'sort-report.json')} and ${path.join(out, 'decisions.json')}`);
  return 0;
}

function readLedgerFile(file) {
  try { return {raw: JSON.parse(fs.readFileSync(file, 'utf8')).entries, entries: parseLedger(JSON.parse(fs.readFileSync(file, 'utf8')))}; }
  catch { throw Error(`${file} is not a sorting ledger`); }
}
function branchOf(file) {
  let dir = path.dirname(path.resolve(file));
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  // The branch of the folder the ledger is in, never of a repository an inherited GIT_DIR names (E2.8 (e) sweep).
  const git = args => spawnSync('git', ['-C', dir, ...args], {encoding: 'utf8', windowsHide: true, timeout: 10000, env: cleanGitEnv()});
  if (git(['rev-parse', '--is-inside-work-tree']).stdout?.trim() !== 'true') return null;
  return git(['branch', '--show-current']).stdout?.trim() || null;
}
export function ledgerAdd(opts) {
  if (!opts.ledger) throw Error('ledger-add: --ledger is required');
  if (!opts.from || !opts.project) throw Error('usage');
  const file = path.resolve(opts.ledger);
  if (branchOf(file) === 'main') throw Error('ledger-add: refusing on branch main; run it in a kit worktree branch');
  let report;
  try { report = JSON.parse(fs.readFileSync(path.resolve(opts.from), 'utf8')); if (!Array.isArray(report.entries)) throw Error(); }
  catch { throw Error(`ledger-add: ${opts.from} is not an instructions report`); }
  const current = fs.existsSync(file) ? readLedgerFile(file) : {raw: [], entries: []}, keys = new Set(current.entries.map(ledgerKey)), added = [];
  let present = 0;
  for (const item of report.entries) {
    if (!['replace', 'keep', 'drop'].includes(item.outcome)) throw Error(`ledger-add: ${opts.from} has an entry with outcome ${item.outcome}; add a real run's instructions-report.json`);
    if (item.project && item.project !== opts.project) throw Error(`ledger-add: report project ${item.project} differs from --project ${opts.project}`);
    const entry = {id: item.id, text: Buffer.from(String(item.text64), 'base64').toString('utf8'), outcome: item.outcome, scope: item.scope, reason: item.reason,
      decidedBy: item.decidedBy, source: item.source, matched: item.matched ?? [], project: opts.project, date: item.date};
    const key = ledgerKey(entry);
    if (keys.has(key)) { present++; continue; }
    keys.add(key); added.push(encodeEntry(entry));
  }
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const pending = file + '.tmp';
  fs.writeFileSync(pending, JSON.stringify({version: 1, entries: [...current.raw, ...added]}, null, 2) + '\n');
  fs.renameSync(pending, file);
  console.log(`ledger: ${added.length} added, ${present} already present`);
  return 0;
}
export function ledgerShow(opts) {
  if (!opts.ledger) throw Error('ledger-show: --ledger is required');
  const {entries} = readLedgerFile(path.resolve(opts.ledger));
  console.log(JSON.stringify(entries.filter(entry => !opts.id || entry.id === opts.id), null, 2));
  return 0;
}

if (isDirect(import.meta.url)) {
  let opts;
  try { opts = parse(process.argv.slice(2)); }
  catch { console.error(USAGE); process.exitCode = 2; }
  if (opts) try {
    process.exitCode = opts.command === 'preview' ? preview(opts) : opts.command === 'ledger-add' ? ledgerAdd(opts) : ledgerShow(opts);
  } catch (error) {
    if (error.message === 'usage') { console.error(USAGE); process.exitCode = 2; }
    else { console.error(/^(ledger-add|ledger-show|preview):/.test(error.message) ? error.message : opts.command + ': ' + error.message); process.exitCode = 1; }
  }
}
