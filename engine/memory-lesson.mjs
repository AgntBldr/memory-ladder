import fs from 'node:fs';
import path from 'node:path';
import {args, locations, isDirect, toolDir, readRequired, listMd} from './lib.mjs';
import {withMemoryLock} from './memory-lock.mjs';
import {routerFamilies, lessonIdentity} from './memory-index.mjs';
import {validDate} from './memory-rotate.mjs';

export function newLesson({memoryDir, title, route, pin = false, lock, today = new Date().toISOString().slice(0, 10)}) {
  if (!validDate(today)) throw new Error('invalid --today date; expected YYYY-MM-DD');
  return withMemoryLock(memoryDir, () => {
    const families = routerFamilies(readRequired(path.join(memoryDir, 'MEMORY.md')));
    const selected = [...new Set(String(route ?? '').split(',').map(x => x.trim()).filter(Boolean))];
    if (!selected.length || selected.some(x => !families.has(x))) throw new Error(`route.unknown: ${route ?? '(missing)'}; known families: ${[...families.keys()].join(', ')}`);
    if (typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title)) throw new Error('title must be a nonempty single line');
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).replace(/-$/, '') || 'lesson';
    const highest = listMd(memoryDir).reduce((max, file) => {
      const id = lessonIdentity(file), n = id ? BigInt(/^\d+/.exec(id)[0]) : 0n;
      return n > max ? n : max;
    }, 0n);
    const number = String(highest + 1n).padStart(3, '0'), name = `lesson-${number}-${slug}`;
    const templateFile = path.join(toolDir, 'templates/lesson.md');
    const template = readRequired(fs.existsSync(templateFile) ? templateFile : path.join(toolDir, '../templates/lesson.md'));
    const values = {name, number, title, date: today, route: JSON.stringify(selected), pin: String(Boolean(pin))};
    const text = template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]);
    const file = path.join(memoryDir, name + '.md');
    fs.writeFileSync(file, text, {flag: 'wx'});
    return file;
  }, {lock});
}
export function main(argv = process.argv.slice(2)) {
  try {
    const opts = args(argv);
    if (opts._.shift() !== 'new') throw new Error('expected new --route FAMILY "TITLE"');
    console.log(newLesson({...locations(opts), title: opts._.join(' '), route: opts.route, pin: opts.pin, today: opts.today}));
    return 0;
  } catch (error) { console.error('memory-lesson: ' + error.message); return 1; }
}
if (isDirect(import.meta.url)) process.exitCode = main();
