// "Safe to compact" has one definition: three conditions, the third in two forms. The engine's constants, the handover skill, the
// README, the glossary entry and the standard Reports line each name those three and no other, and word the third one both ways,
// so they cannot drift apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {kitRoot, read} from './helpers.mjs';
import {SAFE_CONDITIONS, ROADMAP_FORMS, SAFE_MEANING} from '../engine/handover.mjs';
import {inRepoVariant} from '../scripts/instructions-block.mjs';

const flat = text => text.replace(/\s+/g, ' ');
const file = name => read(path.join(kitRoot, name));
const glossaryEntry = term => file('docs/GLOSSARY.md').split(/\n\n+/).find(paragraph => paragraph.startsWith(`**${term}**`)) ?? '';
const reportsLine = text => text.split('\n').find(line => line.startsWith('- Reports:')) ?? '';
// The README holds many subjects; the definition lives in the section that describes the handover.
const readmeSection = text => { const at = text.indexOf('\n## Starting and handing over a session\n'); return at < 0 ? '' : text.slice(at + 1).split(/\n## /)[0]; };
const template = file('templates/AGENTS-memory-gate.md');
const sites = {
  'the engine constants': SAFE_MEANING,
  'the handover skill': flat(file('skills/handover/SKILL.md')),
  'the README': flat(readmeSection(file('README.md'))),
  'the glossary entry': flat(glossaryEntry('safe to compact')),
  'the standard Reports line': flat(reportsLine(template)),
  'the standard Reports line, memory inside the project': flat(reportsLine(inRepoVariant(template))),
};

test('the three conditions and the two forms of the third are the engine constants', () => {
  assert.deepEqual(SAFE_CONDITIONS, ['memory is updated', 'learning is added', 'the roadmap holds the current state']);
  assert.deepEqual(ROADMAP_FORMS, ['you updated it', 'you name the line that already holds it']);
});

for (const [site, text] of Object.entries(sites)) test(`${site} names the three conditions and both forms of the third`, () => {
  assert.notEqual(text, '', 'the site was found');
  for (const phrase of [...SAFE_CONDITIONS, ...ROADMAP_FORMS]) assert.ok(text.includes(phrase), `missing: ${phrase}`);
  assert.match(text, /all three/i);
  // The order is the definition's order: memory, learning, roadmap.
  const at = SAFE_CONDITIONS.map(phrase => text.indexOf(phrase));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
});

for (const [site, text] of Object.entries(sites)) test(`${site} makes no other condition: a commit or a push is not one`, () => {
  assert.doesNotMatch(text, /committed and pushed/i);
  assert.doesNotMatch(text, /(?:only when|only if|requires?|needs?) [^.]*\b(?:committed|pushed|gate has no FAIL)\b/i);
  assert.doesNotMatch(text, /\ball (?:four|two)\b/i);
});

// Each site says outright that a commit is not one of the conditions; the skill puts it in its own words.
const NOT_A_CONDITION = /A commit or a \/handover is not required for it\./;
for (const [site, text] of Object.entries(sites)) if (site !== 'the engine constants') test(`${site} says a commit is not one of the conditions`, () => {
  assert.match(text, site === 'the handover skill' ? /A commit or a push is not one of the three\./ : NOT_A_CONDITION);
});

test('the Reports line and the engine meaning both keep saying that nothing stated about the roadmap is not enough', () => {
  assert.match(sites['the standard Reports line'], /Saying nothing about the roadmap is not enough/);
  assert.match(sites['the standard Reports line, memory inside the project'], /Saying nothing about the roadmap is not enough/);
});
