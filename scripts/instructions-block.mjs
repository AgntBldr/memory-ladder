// Pure text functions for the kit's standard block in AGENTS.md and CLAUDE.md:
// markers, the old memory section, units, classification, rendering and the proof.
import {createHash} from 'node:crypto';

export const END_MARKER = '<!-- kit standard block: end -->';
export const BEGIN_PATTERN = /^<!-- kit standard block \(memory kit [0-9][0-9A-Za-z.+-]*\): begin\./;
export const beginMarker = version => `<!-- kit standard block (memory kit ${version}): begin. The kit replaces everything up to the end marker on every update; put project rules under "## Project rules". -->`;
export const RULES_HEADING = '## Project rules';
export const RULES_LINE = 'Rules for this project only. The kit adds old lines here once, when it sorts them on a first update; it never edits or removes them.';
export const IMPORT_LINE = '@AGENTS.md';
// In-repo memory never pushes from checkpoint; install writes this variant of the gate block.
export const IN_REPO_FROM = 'gate, commit and push. Use `--no-push` or `--dry-run` when needed.';
export const IN_REPO_TO = 'gate, then print staging paths and a suggested commit message. In in-repo memory, checkpoint never pushes and commits only with explicit `--commit` on the current branch; follow host branch rules. Use `--dry-run` to preview.';
export const inRepoVariant = text => text.replace(IN_REPO_FROM, () => IN_REPO_TO);

const trimEnd = s => s.replace(/[ \t]+$/, '');
const blank = line => !/\S/.test(line.text);
const isEnd = text => trimEnd(text) === END_MARKER;
export const fileEol = text => text.includes('\r\n') ? '\r\n' : '\n';
export const normalizeUnit = raw => raw.replace(/\r\n/g, '\n').split('\n').map(trimEnd).join('\n');
export const unitId = raw => createHash('sha256').update(normalizeUnit(raw), 'utf8').digest('hex').slice(0, 12);
export const preview60 = raw => Array.from(normalizeUnit(raw).replace(/\n[ \t]*/g, ' ')).slice(0, 60).join('');
// A block body as the comparison sees it: non-blank lines, trailing spaces dropped, in order.
export const bodyLines = text => text.split(/\r?\n/).map(trimEnd).filter(Boolean);
const markerVersion = text => /\(memory kit ([0-9][0-9A-Za-z.+-]*)\)/.exec(text)[1];

// Indices of a that are part of one longest common subsequence of a and b.
function commonLines(a, b) {
  const rows = Array.from({length: a.length + 1}, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  const keep = new Set();
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { keep.add(i); i++; j++; } else if (rows[i + 1][j] >= rows[i][j + 1]) i++; else j++;
  }
  return keep;
}

// Lines with offsets: text excludes the line ending; end includes it.
export function splitLines(text) {
  const lines = [];
  for (let at = 0; at < text.length;) {
    const nl = text.indexOf('\n', at), stop = nl < 0 ? text.length : nl + 1;
    let content = text.slice(at, nl < 0 ? text.length : nl), eol = nl < 0 ? '' : '\n';
    if (nl >= 0 && content.endsWith('\r')) { content = content.slice(0, -1); eol = '\r\n'; }
    lines.push({start: at, end: stop, text: content, eol});
    at = stop;
  }
  return lines;
}

export function findMarkers(lines) {
  const begins = [], ends = [];
  lines.forEach((line, i) => { if (BEGIN_PATTERN.test(line.text)) begins.push(i); else if (isEnd(line.text)) ends.push(i); });
  if (!begins.length && !ends.length) return null;
  const damage = begins.length > 1 ? 'two begin markers' : ends.length > 1 ? 'two end markers' : !ends.length ? 'begin without end'
    : !begins.length ? 'end without begin' : ends[0] < begins[0] ? 'end before begin' : null;
  return {begin: begins[0], end: ends[0], damage};
}

// The section ends at the next # or ## heading, at a block marker, or at the end of the file.
export function findProjectRules(lines) {
  const heads = [];
  lines.forEach((line, i) => { if (/^## Project rules[ \t]*$/.test(line.text)) heads.push(i); });
  if (!heads.length) return null;
  if (heads.length > 1) return {damage: `${heads.length} "${RULES_HEADING}" headings`};
  const head = heads[0];
  let stop = head + 1;
  while (stop < lines.length && !/^#{1,2} /.test(lines[stop].text) && !BEGIN_PATTERN.test(lines[stop].text) && !isEnd(lines[stop].text)) stop++;
  let last = stop - 1;
  while (last > head && blank(lines[last])) last--;
  return {head, stop, last, start: lines[head].start, end: stop < lines.length ? lines[stop].start : lines.at(-1).end,
    insertAt: lines[last].end, missingEol: !lines[last].eol};
}

// Old memory section on a first update. Trailing (and, for type 2, leading) blank lines are layout and stay.
export function findOldSection(lines, rules) {
  const gate = lines.findIndex(line => /^## Memory gate(?:[ \t].*)?$/.test(line.text));
  if (gate >= 0) {
    let stop = gate + 1;
    while (stop < lines.length && !/^#{1,2} /.test(lines[stop].text)) stop++;
    let last = stop - 1;
    while (last > gate && blank(lines[last])) last--;
    return {type: 1, heading: gate, from: gate, to: last, start: lines[gate].start, end: lines[last].end};
  }
  const inRules = i => rules && !rules.damage && i > rules.head && i < rules.stop;
  const ladder = lines.findIndex((line, i) => /^#{1,3} .*Memory ladder/i.test(line.text) && !inRules(i));
  if (ladder >= 0) {
    let stop = ladder + 1;
    while (stop < lines.length && !/^#{1,6}(?:[ \t]|$)/.test(lines[stop].text)) stop++;
    let from = ladder + 1, to = stop - 1;
    while (from <= to && blank(lines[from])) from++;
    while (to >= from && blank(lines[to])) to--;
    if (from > to) return {type: 2, heading: ladder, from, to: from - 1, start: lines[ladder].end, end: lines[ladder].end, missingEol: !lines[ladder].eol};
    return {type: 2, heading: ladder, from, to, start: lines[from].start, end: lines[to].end};
  }
  return null;
}

// A top-level "- " bullet with its indented continuation lines, or any other non-blank line on its own.
export function splitUnits(text, lines, from, to) {
  const units = [];
  for (let i = from; i <= to; i++) {
    if (blank(lines[i])) continue;
    let last = i;
    if (lines[i].text.startsWith('- ')) {
      for (let j = i + 1; ;) {
        let k = j;
        while (k <= to && blank(lines[k])) k++;
        if (k <= to && /^[ \t]/.test(lines[k].text) && /\S/.test(lines[k].text)) { last = k; j = k + 1; } else break;
      }
    }
    const raw = text.slice(lines[i].start, lines[last].start + lines[last].text.length);
    units.push({first: i, last, raw, id: unitId(raw)});
    i = last;
  }
  return units;
}

// Line -> where the kit shipped it. Catalog entries win over the current template.
export function shippedIndex(catalog, currentBodies) {
  const map = new Map();
  for (const body of currentBodies) for (const line of body.split(/\r?\n/)) {
    const key = trimEnd(line);
    if (key) map.set(key, {label: 'current template', reason: 'current kit template', source: 'template', range: 'current template'});
  }
  for (const [line, tags] of Object.entries(catalog?.lines ?? {})) {
    const key = trimEnd(line);
    if (!key || !Array.isArray(tags) || !tags.length) continue;
    const first = tags[0], last = tags.at(-1);
    map.set(key, {label: `kit ${first}..${last}`, reason: `shipped kit wording (${first}..${last} version)`, source: 'catalog', range: `${first}..${last}`});
  }
  return map;
}

// Order: kit wording, then the decisions file, then general ledger entries; everything else is unclear.
// matched holds every general ledger entry the unit matched, whichever step decided it, so a decision that
// settles a ledger conflict keeps the conflicting entries in the report and the ledger.
export function classifyUnits(units, {shipped, decisions, ledger = []}) {
  for (const unit of units) {
    const norm = normalizeUnit(unit.raw), hit = !norm.includes('\n') && shipped.get(norm);
    if (hit) { Object.assign(unit, {outcome: 'replace', scope: 'general', reason: hit.reason, decidedBy: 'kit', source: hit.source, label: hit.label, matched: []}); continue; }
    const seen = ledger.filter(entry => entry.id === unit.id && ['keep', 'drop'].includes(entry.outcome) && normalizeUnit(String(entry.text)) === norm);
    const general = seen.filter(entry => entry.scope === 'general');
    const decision = decisions?.get(unit.id);
    if (decision?.outcome) {
      Object.assign(unit, {outcome: decision.outcome, scope: decision.scope, reason: decision.reason, decidedBy: decision.decidedBy, source: 'decision', label: 'decision', matched: general});
      continue;
    }
    if (general.length && general.every(entry => entry.outcome === general[0].outcome)) {
      const entry = general[0];
      Object.assign(unit, {outcome: entry.outcome, scope: 'general', reason: `general ledger entry ${entry.project}, ${entry.date}: ${entry.reason}`,
        decidedBy: entry.decidedBy, source: 'ledger', label: `general ledger ${entry.project}, ${entry.date}`, matched: general});
      continue;
    }
    const suggestion = general.length ? null : seen.at(-1) ?? null;
    Object.assign(unit, {outcome: 'unclear', scope: 'project', reason: '', decidedBy: '', source: 'unclear', matched: general,
      conflict: general.length > 0, suggestion});
  }
  return units;
}

export function unitLine(unit) {
  const text = preview60(unit.raw);
  if (unit.outcome === 'replace') return `REPLACE ${unit.id} (${unit.label}): ${text}`;
  if (unit.outcome === 'keep') return `KEEP ${unit.id} -> Project rules (${unit.label}): ${text}`;
  if (unit.outcome === 'drop') return `DROP ${unit.id} (${unit.label}): ${text}`;
  const s = unit.suggestion;
  const suffix = unit.conflict ? ' (ledger conflict)' : s ? ` (suggested ${s.outcome} by ${s.project}, ${s.date}: ${s.reason})` : '';
  return `UNCLEAR ${unit.id}${suffix}: ${text}`;
}

// The whole sentences of one line, each with its closing mark: a full stop, question mark or exclamation mark followed by a
// space ends one, except inside a code span. What follows the last such mark counts only when it ends in one too, a
// closing quote, bracket or code mark after it allowed: a heading or an unfinished fragment is not a sentence.
export function sentences(line) {
  const found = [];
  let from = 0, code = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '`') code = !code;
    else if (!code && '.?!'.includes(line[i]) && line[i + 1] === ' ') { found.push(line.slice(from, i + 1)); from = i + 2; }
  }
  if (from < line.length && /[.?!]["')\]`]*$/.test(line)) found.push(line.slice(from));
  return found;
}

// A note for an unclear line that begins with whole sentences of a line the kit shipped, or null. It only describes:
// it changes no classification, no id, no decision, no proof and no write. Only the first line of the unit is read.
// The note names the most sentences any shipped line shares with the start of the unit, and every version range
// whose line shares that many.
const byRange = (a, b) => (a === 'current template') - (b === 'current template') || a.localeCompare(b, 'en', {numeric: true});
export function unitNote(unit, shipped) {
  const first = normalizeUnit(unit.raw).split('\n')[0];
  let count = 0;
  const ranges = [];
  for (const [line, hit] of shipped) {
    const parts = sentences(line);
    let n = 0;
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join(' ');
      if (first === prefix || first.startsWith(prefix + ' ')) n = i; else break;
    }
    if (!n || n < count) continue;
    if (n > count) { count = n; ranges.length = 0; }
    const range = hit.range ?? hit.label;
    if (!ranges.includes(range)) ranges.push(range);
  }
  if (!count) return null;
  return `  note: ${unit.id} begins with ${count} sentence(s) of a kit line (${ranges.sort(byRange).join(', ')}); "keep" copies the whole unit, kit sentences included; edit ${RULES_HEADING} after the update`;
}

const withEol = (body, eol) => { const text = body.replace(/\r?\n/g, '\n'); return (text.endsWith('\n') ? text : text + '\n').replace(/\n/g, eol); };
export const blockText = (version, body, eol) => beginMarker(version) + eol + withEol(body, eol) + END_MARKER + eol;
const rulesSection = (keep, eol) => RULES_HEADING + eol + RULES_LINE + eol + (keep.length ? eol + keep.map(unit => unit.raw + eol).join('') : '');

// kind "full": the standard block and Project rules; kind "import": the CLAUDE.md block holding only the import.
// bodies(markerVersion) gives the line lists the kit of that version wrote in a full block (null when unknown).
export function planText({text, exists = true, version, body, kind = 'full', shipped, decisions, ledger, bodies = null, hooks = {}}) {
  const lines = splitLines(text), eol = fileEol(text), block = blockText(version, body, eol);
  const markers = findMarkers(lines);
  if (markers?.damage) return {damage: markers.damage};
  const rules = kind === 'full' ? findProjectRules(lines) : null;
  if (rules?.damage) return {damage: rules.damage};
  const result = {eol, kind, units: [], edits: [], editLines: 0, rules, repeats: []};
  let s1, e1, new1, p2 = null, ins2 = '', outside;
  if (markers) {
    result.firstUpdate = false;
    s1 = lines[markers.begin].start; e1 = lines[markers.end].end;
    new1 = lines[markers.end].eol ? block : block.slice(0, -eol.length);
    // Local edits: the whole old body against what the kit named in its begin marker wrote. Missing, extra,
    // duplicated and reordered lines all count; a changed line counts once (the larger of extra and missing).
    const from = markers.begin + 1, to = markers.end - 1, wrote = markerVersion(lines[markers.begin].text);
    const known = kind === 'full' ? bodies?.(wrote) ?? null : null;
    result.comparedTo = known ? wrote : version;
    const actual = [];
    for (let i = from; i <= to; i++) if (!blank(lines[i])) actual.push({i, key: trimEnd(lines[i].text)});
    let best = null;
    for (const expected of known ?? [bodyLines(body)]) {
      const keep = commonLines(actual.map(item => item.key), expected), extra = actual.length - keep.size, missing = expected.length - keep.size;
      if (!best || extra + missing < best.extra + best.missing) best = {keep, extra, missing};
    }
    const added = new Set(actual.filter((item, n) => !best.keep.has(n)).map(item => item.i));
    result.editLines = Math.max(best.extra, best.missing);
    result.edits = (to >= from ? splitUnits(text, lines, from, to) : []).filter(unit => [...added].some(i => i >= unit.first && i <= unit.last));
    outside = i => i < markers.begin || i > markers.end;
  } else if (kind === 'import') {
    result.firstUpdate = true;
    const at = lines.findIndex(line => line.text.trim() === IMPORT_LINE);
    if (at >= 0) { s1 = lines[at].start; e1 = lines[at].end; new1 = lines[at].eol ? block : block.slice(0, -eol.length); }
    else { s1 = e1 = text.length; new1 = (exists ? (text.endsWith('\n') ? eol : eol + eol) : '') + block; }
    outside = i => i !== at;
  } else {
    result.firstUpdate = true;
    const old = findOldSection(lines, rules);
    result.old = old;
    result.units = old ? splitUnits(text, lines, old.from, old.to) : [];
    classifyUnits(result.units, {shipped, decisions, ledger});
    hooks.afterSort?.(result.units);
    const keep = result.units.filter(unit => unit.outcome === 'keep');
    result.unclear = result.units.filter(unit => unit.outcome === 'unclear');
    new1 = block + (rules ? '' : eol + rulesSection(keep, eol));
    if (old) {
      s1 = old.start; e1 = old.end;
      if (old.missingEol) new1 = eol + new1;
      outside = i => i < old.from || i > old.to;
    } else { s1 = e1 = text.length; new1 = (exists ? (text.endsWith('\n') ? eol : eol + eol) : '') + new1; outside = () => true; }
    if (rules && keep.length) { p2 = rules.insertAt; ins2 = (rules.missingEol ? eol : '') + keep.map(unit => unit.raw + eol).join(''); }
  }
  for (const [i, line] of lines.entries()) if (outside(i) && !blank(line) && shipped.has(trimEnd(line.text)) && trimEnd(line.text) !== IMPORT_LINE) result.repeats.push(i + 1);
  if (p2 !== null && p2 > s1 && p2 < e1) return {...result, proofFailure: 'P4'};
  const before = p2 !== null && p2 <= s1;
  const newText = p2 === null ? text.slice(0, s1) + new1 + text.slice(e1)
    : before ? text.slice(0, p2) + ins2 + text.slice(p2, s1) + new1 + text.slice(e1)
    : text.slice(0, s1) + new1 + text.slice(e1, p2) + ins2 + text.slice(p2);
  Object.assign(result, {spans: {s1, e1, new1, p2, ins2, before}, newText: hooks.afterRender ? hooks.afterRender(newText) : newText});
  result.action = !markers ? 'add' : result.newText === text ? 'unchanged' : 'replace';
  return result;
}

// Statement 8: each check re-derives what it needs from the old text instead of trusting the plan.
export function proveText({text, plan, body, version}) {
  const {newText, spans: {s1, e1, new1, p2, ins2, before}} = plan, l1 = new1.length, l2 = ins2.length;
  const at1 = p2 !== null && before ? s1 + l2 : s1, at2 = p2 === null ? null : before ? p2 : p2 - (e1 - s1) + l1;
  if (newText.slice(at1, at1 + l1) !== new1 || (at2 !== null && newText.slice(at2, at2 + l2) !== ins2)) return 'P1';
  const ranges = [[at1, at1 + l1], ...(at2 === null ? [] : [[at2, at2 + l2]])].sort((a, b) => a[0] - b[0]);
  let stripped = '', at = 0;
  for (const [from, to] of ranges) { stripped += newText.slice(at, from); at = to; }
  if (stripped + newText.slice(at) !== text.slice(0, s1) + text.slice(e1)) return 'P1';
  if (plan.kind === 'full' && plan.firstUpdate && plan.old) {
    const lines = splitLines(text), counts = new Map();
    for (const unit of plan.units) {
      if (!['replace', 'keep', 'drop'].includes(unit.outcome)) return 'P2';
      for (let i = unit.first; i <= unit.last; i++) if (/\S/.test(lines[i]?.text ?? '')) counts.set(i, (counts.get(i) ?? 0) + 1);
    }
    for (let i = plan.old.from; i <= plan.old.to; i++) if (/\S/.test(lines[i].text) && counts.get(i) !== 1) return 'P2';
    if ([...counts.keys()].some(i => i < plan.old.from || i > plan.old.to)) return 'P2';
    const fresh = splitUnits(text, lines, plan.old.from, plan.old.to);
    if (fresh.length !== plan.units.length || fresh.some((unit, i) => unit.raw !== plan.units[i].raw)) return 'P2';
    const area = plan.rules ? ins2 : new1.slice(new1.indexOf(plan.eol + RULES_HEADING + plan.eol) + plan.eol.length);
    let from = 0;
    for (const unit of plan.units.filter(unit => unit.outcome === 'keep')) {
      const found = area.indexOf(unit.raw + plan.eol, from);
      if (found < 0 || (found > 0 && !area.slice(0, found).endsWith(plan.eol))) return 'P2';
      from = found + unit.raw.length;
    }
    const kept = new Map();
    for (const unit of plan.units.filter(unit => unit.outcome === 'keep')) kept.set(unit.raw, (kept.get(unit.raw) ?? 0) + 1);
    const areaLines = area.split(/\r?\n/);
    for (const [raw, count] of kept) {
      const parts = raw.split(/\r?\n/);
      let seen = 0;
      for (let i = 0; i + parts.length <= areaLines.length; i++) if (parts.every((part, j) => areaLines[i + j] === part)) seen++;
      if (seen !== count) return 'P2';
    }
  }
  const after = splitLines(newText), markers = findMarkers(after);
  if (!markers || markers.damage) return 'P3';
  const inner = newText.slice(after[markers.begin].end, after[markers.end].start).replace(/\r\n/g, '\n');
  if (inner !== withEol(body, '\n') || after[markers.begin].text !== beginMarker(version)) return 'P3';
  if (plan.rules) {
    const {start, insertAt, end} = plan.rules;
    if (!(e1 <= start || s1 >= end)) return 'P4';
    const shift = s1 < start ? l1 - (e1 - s1) : 0, mapped = start + shift, added = p2 !== null ? l2 : 0;
    if (newText.slice(mapped, mapped + (insertAt - start)) !== text.slice(start, insertAt)) return 'P4';
    const rest = mapped + (insertAt - start) + added;
    if (newText.slice(rest, rest + (end - insertAt)) !== text.slice(insertAt, end)) return 'P4';
  }
  return null;
}

export function encodeEntry(entry) { return Buffer.from(JSON.stringify(entry), 'utf8').toString('base64'); }
export function decodeEntry(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw Error('entry is not base64');
  const entry = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.id !== 'string' || typeof entry.text !== 'string'
    || !['replace', 'keep', 'drop'].includes(entry.outcome) || !['project', 'general'].includes(entry.scope)) throw Error('entry fields');
  return entry;
}
export function parseLedger(json) {
  if (!json || typeof json !== 'object' || json.version !== 1 || !Array.isArray(json.entries)) throw Error('ledger shape');
  return json.entries.map(decodeEntry);
}
export const ledgerKey = entry => JSON.stringify([entry.id, entry.project, entry.outcome, entry.scope, entry.reason]);
export const reportEntry = (unit, {project, file, date}) => ({id: unit.id, text64: Buffer.from(unit.raw, 'utf8').toString('base64'), outcome: unit.outcome,
  scope: unit.scope, reason: unit.reason, decidedBy: unit.decidedBy, source: unit.source, matched: unit.matched ?? [], project, file, date,
  ...(unit.suggestion ? {suggestion: unit.suggestion} : {})});
