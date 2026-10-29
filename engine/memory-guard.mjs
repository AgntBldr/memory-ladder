import fs from 'node:fs';
import path from 'node:path';
import {args, isDirect, toolDir, loadConfig} from './lib.mjs';

const hint = 'If the matched text is only inside a commit message or heredoc, write it to a file and pass the file.';
const errorText = error => String(error.message ?? error).replace(/[\r\n]+/g, ' ');
const defaultRepo = () => process.env.CLAUDE_PROJECT_DIR || path.resolve(toolDir, path.basename(toolDir) === 'engine' ? '..' : '../..');
export function loadRules({repo = defaultRepo(), config = loadConfig()} = {}) {
  const errors = [], merged = new Map();
  const kit = config.caps?.guard?.kitRules;
  const files = [kit ? path.resolve(repo, kit) : path.join(toolDir, 'enforce-rules.kit.json'), path.resolve(repo, config.caps?.guard?.rules ?? 'scripts/memory/enforce-rules.json')];
  for (const file of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) { if (error.code === 'ENOENT' && file === files[1] && file !== files[0]) continue; errors.push({file, reason: `rules file ${file} is not valid JSON: ${errorText(error)}`, unparsable: error instanceof SyntaxError}); continue; }
    if (data?.version !== 1 || !Array.isArray(data.rules)) { errors.push({file, reason:'rules file requires version 1 and a rules array'}); continue; }
    const counts = new Map();
    for (const r of data.rules) counts.set(r?.id, (counts.get(r?.id) ?? 0) + 1);
    for (const r of data.rules) {
      if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(r.id)) { errors.push({file, reason:'rule id must match ^[a-z][a-z0-9-]*$'}); continue; }
      if (counts.get(r.id) > 1) { errors.push({file, id:r.id, reason:`rules must have unique ids: ${r.id}`}); merged.delete(r.id); continue; }
      merged.set(r.id, {...merged.get(r.id), ...r, file});
    }
  }
  const rules = [];
  for (const rule of merged.values()) {
    try {
      const fail = message => { throw new Error(`rule ${rule.id}: ${message}`); };
      if (!['deny','warn','off'].includes(rule.action)) fail('action must be deny, warn or off');
      const tools = rule.tools ?? ['Bash'];
      if (!Array.isArray(tools) || !tools.length || tools.some(t => !['Bash','PowerShell'].includes(t))) fail('tools must be Bash or PowerShell');
      if (typeof rule.message !== 'string' || !rule.message.trim() || rule.message.length > 200 || /[\r\n]/.test(rule.message)) fail('message must be 1-200 characters on one line');
      if (rule.lesson !== undefined && !(typeof rule.lesson === 'string' || Array.isArray(rule.lesson))) fail('lesson must be a string or array of lesson identities');
      if (rule.lesson !== undefined && [rule.lesson].flat().some(x => typeof x !== 'string' || !/^\d{3,}[a-z]*$/.test(x))) fail('lesson must be a string or array of lesson identities');
      const compile = (key, required) => {
        if (!required && rule[key] === undefined) return null;
        if (typeof rule[key] !== 'string') fail(`${key} must be a string`);
        let rx;
        try { rx = new RegExp(rule[key], rule.flags ?? ''); } catch (error) { fail(`${key} does not compile: ${errorText(error)}`); }
        if (rx.test('')) fail(`${key} matches the empty string`);
        rx.lastIndex = 0; return rx;
      };
      rules.push({...rule, tools, regex:compile('pattern',true), unlessRegex:compile('unless',false)});
    } catch (error) { errors.push({file:rule.file, id:rule.id, reason:errorText(error)}); }
  }
  return {rules, errors};
}
const matches = (regex, command) => { regex.lastIndex = 0; return regex.test(command); };
export function matchRules(rules, command, tool = 'Bash') {
  command = command.slice(0,4000);
  return rules.filter(r => r.action !== 'off' && r.tools.includes(tool) && matches(r.regex, command) && !(r.unlessRegex && matches(r.unlessRegex, command)));
}
const message = rule => `memory guard: rule ${rule.id}: ${rule.message}${rule.lesson === undefined ? '' : ' (lesson ' + [rule.lesson].flat().map(x => '#' + x).join(', ') + ')'}\n${hint}`;
const skipped = error => `memory guard: skipped ${error.id ?? error.file ?? 'input'}: ${error.reason ?? errorText(error)}; run the memory gate`;
const context = text => console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',additionalContext:text}}));
export function replay(rules, text, tool = 'Bash') {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  let jsonl = false;
  try { const first=JSON.parse(lines[0]); jsonl=Boolean(first && typeof first==='object' && Object.hasOwn(first,'command')); } catch {}
  const commands = lines.map((line, i) => {
    if (!jsonl) return line;
    const value = JSON.parse(line); if (typeof value.command !== 'string') throw new Error(`replay line ${i + 1}: command must be a string`); return value.command;
  });
  return rules.filter(r => r.tools.includes(tool)).map(rule => {
    const hits = commands.flatMap((command, i) => matchRules([rule], command, tool).length ? [{line:i + 1,command}] : []);
    return {id:rule.id, count:hits.length, total:commands.length, rate:commands.length ? hits.length / commands.length * 100 : 0, hits:hits.slice(0,20)};
  });
}
export function main(argv = process.argv.slice(2)) {
  let command;
  try {
    const opts = args(argv); command = opts._.shift();
    if (command === 'prompt') {
      const now = new Date(), pad = x => String(x).padStart(2,'0'), offset = -now.getTimezoneOffset();
      const local = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
      console.log(`clock: ${local} local (${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset)/60))}:${pad(Math.abs(offset)%60)}) | ${now.toISOString().slice(0,16).replace('T',' ')} UTC`); return 0;
    }
    let input;
    if (command === 'pretooluse') {
      input = JSON.parse(fs.readFileSync(0,'utf8').replace(/^\uFEFF/, ''));
      if (!['Bash','PowerShell'].includes(input?.tool_name) || typeof input?.tool_input?.command !== 'string') return 0;
    }
    const config = opts.config ? JSON.parse(fs.readFileSync(opts.config,'utf8')) : loadConfig();
    const {rules, errors} = loadRules({repo:opts.repo ?? defaultRepo(),config});
    if (command === 'pretooluse') {
      const hits = matchRules(rules,input.tool_input.command,input.tool_name), deny = hits.find(r => r.action === 'deny');
      // A broken rule is isolated; valid deny rules still apply.
      if (errors.length) context([...errors.map(skipped),...hits.filter(r=>r.action==='warn').map(message)].join('\n'));
      if (deny) { console.error(message(deny)); return 2; }
      if (hits.length && !errors.length) context(hits.map(message).join('\n'));
      return 0;
    }
    if (!['test','replay'].includes(command)) throw new Error('usage: memory-guard.mjs pretooluse|prompt|test FILE|replay FILE [--tool Bash|PowerShell] [--repo PATH]');
    const tool = opts.tool ?? 'Bash'; if (!['Bash','PowerShell'].includes(tool)) throw new Error('tool must be Bash or PowerShell');
    const text = fs.readFileSync(opts._[0],'utf8');
    if (command === 'test') { const hits=matchRules(rules,text,tool); console.log(hits.length ? hits.map(r=>`match: ${r.id} (${r.action})`).join('\n') : 'no rule matches'); }
    else for (const r of replay(rules,text,tool)) {
      console.log(`${r.id}: ${r.count}/${r.total} (${r.rate.toFixed(2)}%)`);
      for (const hit of r.hits) console.log(`  line ${hit.line}: ${hit.command.replace(/\r/g,'\\r').replace(/\n/g,'\\n').slice(0,200)}`);
    }
    for (const error of errors) console.log(skipped(error));
    return errors.some(e => e.unparsable) ? 1 : 0;
  } catch (error) { if (command !== 'prompt') context(skipped(error)); return 0; }
}
if (isDirect(import.meta.url)) process.exitCode = main();
