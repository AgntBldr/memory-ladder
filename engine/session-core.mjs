import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {parseHandover, loadConfig} from './lib.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 12);
const safeRead = file => { try { return fs.readFileSync(file); } catch { return null; } };
const section = (text, heading) => {
  const lines = text.split(/\r\n|[\r\n]/), start = lines.findIndex(line => line.trimEnd() === heading);
  if (start < 0) return '';
  const end = lines.findIndex((line, i) => i > start && /^#{1,2}(?:\s|$)/.test(line));
  return lines.slice(start, end < 0 ? undefined : end).join('\n') + (end < 0 ? '' : '\n');
};
export function stateToken(memoryDir) {
  try { const bytes = safeRead(path.join(memoryDir, 'current-state.md')); return bytes === null ? null : digest(bytes); }
  catch { return null; }
}
export function parseBlock(text) {
  const fields = {};
  for (const match of String(text ?? '').matchAll(/^\*\*([^*\r\n]+):\*\*[ \t]*(.*)$/gm)) {
    if (!Object.hasOwn(Object.prototype, match[1])) fields[match[1]] = match[2].trim();
  }
  // The stamp time is written with seconds (HH:MM:SS) and read with or without them, so stamps written by earlier
  // releases, by hand or by a project's own skill still parse; `time` keeps what was written.
  const match = /^\*\*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?) \| @([a-f0-9]{7}) \| (full|quick)\. (.*?)\*\*[ \t]*\r?$/m.exec(String(text ?? ''));
  const valid = match && !Number.isNaN(Date.parse(match[1].replace(' ', 'T'))) && new Date(match[1].replace(' ', 'T')).getDate() === Number(match[1].slice(8, 10));
  return {stamp: valid ? {time: match[1], sha: match[2], mode: match[3]} : null, state: valid ? match[4] : '', fields};
}
export function readCurrent(memoryDir) {
  const empty = {file: null, token: null, block: '', bytes: 0, headings: [], stamp: null, fields: {}};
  try {
    const file = path.join(memoryDir, 'current-state.md'), raw = safeRead(file);
    if (raw === null) return {...empty, file};
    const base = {...empty, file, token: digest(raw), bytes: raw.length};
    if (raw.includes(0)) return base;
    const text = raw.toString('utf8'), headings = text.split(/\r?\n/).filter(line => /^#{1,6}[ \t].*\b(RESUME|CURRENT)\b/i.test(line));
    const block = section(text, '## CURRENT') || (headings.length === 1 ? section(text, headings[0].trimEnd()) : '');
    return {...base, block, headings, ...(({stamp, fields}) => ({stamp, fields}))(parseBlock(block))};
  } catch { return empty; }
}
export function readOverlay(repoDir) {
  try {
    const raw = safeRead(path.join(repoDir, 'AGENTS.md'));
    if (!raw || raw.includes(0)) return {};
    const text = section(raw.toString('utf8'), '## Session overlay');
    const result = {};
    for (const m of text.matchAll(/^([\w-]+):[ \t]*([^\r\n]*)/gm)) {
      const key = m[1].toLowerCase();
      if (key !== 'precedence') Object.defineProperty(result, key, {value: m[2].replace(/^[ \t]+|[ \t]+$/g, ''), enumerable: true, configurable: true, writable: true});
    }
    return result;
  } catch { return {}; }
}
export function capText(text, maxBytes) {
  text = String(text ?? '');
  const max = Math.max(0, Math.floor(Number(maxBytes) || 0)), bytes = Buffer.from(text);
  if (bytes.length <= max) return text;
  const marker = '[cut]'.slice(0, max), limit = max - Buffer.byteLength(marker);
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8') + marker;
}
export function capOutput(text, opts) {
  const {max = 4000, label = 'session'} = opts ?? {};
  text = String(text ?? '');
  if (Buffer.byteLength(text) <= max) return text;
  let tail;
  try {
    const dir = path.join(os.tmpdir(), 'memory-session');
    fs.mkdirSync(dir, {recursive: true});
    const file = path.join(dir, `${String(label).replace(/[^a-z0-9_-]/gi, '_')}-${Date.now()}.log`);
    fs.writeFileSync(file, text);
    tail = `[cut; full output: ${file}]`;
  } catch { tail = '[cut; full output unavailable]'; }
  if (Buffer.byteLength(tail) >= max) return capText(tail, max);
  return capText(text, max - Buffer.byteLength(tail)).replace(/\[cut\]$/, '') + tail;
}
export function matchPhrase(message) {
  const none = {kind: null, quick: false, text: ''};
  if (message && typeof message === 'object') {
    if ('agent_id' in message || 'agent_type' in message) return none;
    message = message.prompt;
  }
  if (typeof message !== 'string') return none;
  const trimmed = message.trim();
  if (!trimmed || trimmed.startsWith('/') || /^["'`\u2018\u2019\u201c\u201d]|["'`\u2018\u2019\u201c\u201d]$/.test(trimmed)) return none;
  const lines = trimmed.split(/\r?\n/);
  if (lines.length > 2 || /^["'`\u2018\u2019\u201c\u201d]|["'`\u2018\u2019\u201c\u201d]$/.test(lines[0].trim())) return none;
  const phrase = lines[0].toLowerCase().replace(/(?<=[a-z])['\u2018\u2019](?=[a-z])/g, '').replace(/[-\u2010-\u2015\s]+/g, ' ').replace(/[.!?:;,]+$/, '').trim();
  const start = /^(?:we are|were) starting a new session read this and let me know when we can start$/.test(phrase);
  const handover = ['handover', 'hand over', 'do a handover', 'lets do a handover', 'end session', 'end of session', 'session end', 'quick handover'].includes(phrase);
  if (!start && !handover) return none;
  const extra = lines.length === 2 ? /^(goal|note):[ \t]*(.*)$/i.exec(lines[1]) : null;
  if (lines.length === 2 && (!extra || extra[1].toLowerCase() !== (start ? 'goal' : 'note'))) return none;
  return {kind: start ? 'start' : 'handover', quick: phrase === 'quick handover', text: [...(extra?.[2] ?? '')].slice(0, 200).join('')};
}
// The slash forms are for `dispatch` only. The prompt hook keeps rejecting every slash message through matchPhrase,
// because Claude Code runs the skill itself and a nudge would run it twice. A message that starts with /new-session or
// /handover but is not one of the three exact forms gets the usage line (`usage: true`); any other message gets nothing.
export function matchSlash(message) {
  const none = {kind: null, quick: false, text: '', usage: false, skill: null};
  if (typeof message !== 'string') return none;
  const trimmed = message.trim(), lower = trimmed.toLowerCase();
  const skill = lower.startsWith('/new-session') ? 'new-session' : lower.startsWith('/handover') ? 'handover' : null;
  if (!skill) return none;
  const usage = {...none, usage: true, skill};
  const lines = trimmed.split(/\r?\n/);
  if (lines.length > 2) return usage;
  const command = lines[0].trim().toLowerCase().replace(/[ \t]+/g, ' ');
  const start = command === '/new-session', full = command === '/handover', quick = command === '/handover quick';
  if (!start && !full && !quick) return usage;
  const extra = lines.length === 2 ? /^(goal|note):[ \t]*(.*)$/i.exec(lines[1]) : null;
  if (lines.length === 2 && (!extra || extra[1].toLowerCase() !== (start ? 'goal' : 'note'))) return usage;
  return {kind: start ? 'start' : 'handover', quick, text: [...(extra?.[2] ?? '')].slice(0, 200).join(''), usage: false, skill};
}
export function listNotes(memoryDir, opts) {
  try {
    // Kit 3.3.5 E9: branch (or excludeBranch) filters BEFORE truncation and the time window.
    const {sinceHours = 24, max = 3, branch: onlyBranch, excludeBranch} = opts ?? {};
    const dir = path.join(memoryDir, 'handovers');
    const names = fs.readdirSync(dir).filter(name => /^\d{6}-\d{4}-\d{2}-\d{2}-\d{4}\.md$/.test(name)).sort().reverse();
    let cap = 6144;
    try { const value = loadConfig().caps?.handovers?.failBytes; if (Number.isInteger(value) && value > 0) cap = value; } catch {}
    const notes = [], now = Date.now(), cutoff = now - sinceHours * 3600000;
    for (const name of names) {
      if (notes.length >= max) break;
      try {
        const file = path.join(dir, name), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > cap) continue;
        const raw = fs.readFileSync(file);
        if (raw.includes(0) || raw.length > cap) continue;
        const {data, body, valid} = parseHandover(raw.toString('utf8'));
        const {time, branch, sha, mode} = data;
        if (!valid) continue;
        if ((onlyBranch !== undefined && data.branch !== onlyBranch) || (excludeBranch !== undefined && data.branch === excludeBranch)) continue;
        if (notes.length && (Date.parse(time) < cutoff || Date.parse(time) > now)) continue;
        notes.push({file, seq: name.slice(0, 6), time, branch, sha, mode, question: parseBlock(body).fields['Open question'] ?? '', body: capText(body, 2048), bytes: raw.length});
      } catch {}
    }
    return notes;
  } catch { return []; }
}
