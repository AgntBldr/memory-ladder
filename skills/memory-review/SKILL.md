---
name: memory-review
description: Audit this project's v3 memory with the Node gate and repair only reported FAIL or WARN findings. Use for memory review, checkpoint checks, or fixing stale, oversized, or broken memory.
metadata:
  engine_version: "3.2.9"
---

# Review v3 memory

Terms: see GLOSSARY.md at `scripts/memory/GLOSSARY.md` from the project root.
The engine and guide links below resolve after installation into `.claude/skills/`.
In the kit tree, read `engine/README.md` and the guides under `docs/`.

Locate the plan, ladder and caps through the [engine section list](../../../scripts/memory/README.md#section-list);
use [upgrade and recovery](../../../scripts/memory/UPGRADE.md) when changing the installed engine.

Run from the project repository:

```sh
node scripts/memory/memory-check.mjs
node scripts/memory/memory-check.mjs --json
```

Use `--memory-dir PATH` and `--repo PATH` for explicit targets. Act only on
non-allowed FAIL/WARN findings. Open only the flagged files and destinations
needed to repair them. Do not bulk-read memory. Use the
[engine README](../../../scripts/memory/README.md) for check details and the
[memory ladder reference](../../../scripts/memory/README.md#section-list) for capture and conversion rules.

Repair the reported class:

- `router.lines`: move detail down a layer; never allow the router cutoff.
- `chars.mojibake`: run `node scripts/memory/memory-chars.mjs repair`, review, then add `--write`.
  Fix residues by hand. `chars.replacement` and `chars.lost-dash` require a hand repair; allow only a deliberate
  example with a dated reason saying so. Allow deliberate examples before repair.
- `lesson.enforce`: record a decision: hook, check, hard-rule card or a dated lesson-only reason.
- `lesson.trigger`: add `metadata.trigger` ("before ..." or "when ...").
- `config.caps`: fix the named key; the default applies meanwhile.
- `lesson.unfilled-body`: fill the empty exact Why or How to apply prompt section.
- `lesson.repeats`, `lesson.enforced`: repair the field through repeat/enforce; see the flow below.
- `lesson.kind`, `lesson.kind-missing`: choose a valid kind, then classify with a reviewed mapping.
- `date.future`: correct the date against UTC now; never change the clock to pass.
- `enforce.rules`: repair malformed rules or missing lesson references in the host override.
- `split.chain`, `topic.line`: scan and repair as described below; review report-only cases.

- `router.*`, `index.*`, `archive.*`, `topic.size`, `state.size`, and
  `hardrule.size`: move detail into atomic files or linked backgrounds. Preserve
  hooks and every operational value in hard rules. Keep hard-rule files at most
  2 KB. For hand-written indexes only, `index.pin` and `index.missing-pin`
  require moving detail or splitting by activity. Never raise a pin or allow ceiling;
  move detail down a layer.
- `state.headings`: keep one current block; recover old state from git. Move
  durable facts to their proper homes before replacing stale state.
- `desc.*`: move changelog/detail to its proper file and write a static
  description of at most 200 characters.
- `link.*`, `stub.target`, `brain.pointer*`: repair the destination or pointer;
  link orphan files from the appropriate index or parent. Preserve old-name
  stubs and keep project facts in `brain/` with memory pointers.
- `wikilink.dead` and `brain.edge`: correct the target or retain a deliberate
  marker for a lesson worth writing later. Do not invent a fact to clear a flag.
- `name.*`, `fm.parse`, `brain.frontmatter`, and `brain.duplicate-id`: repair
  identity/frontmatter, or consolidate duplicate facts in one home and retarget
  pointers. Keep recoverable history in git.
- `lessons.duplicate` and `lessons.cite`: reconcile full lesson identities and citations.
- `index.stale`: run `node scripts/memory/memory-index.mjs --write`.
  `index.hot-budget` warns when mandatory topics and pins exceed the hot budget.
- `route.missing`, `route.unknown`, `lesson.unfilled`: fill the lesson metadata and description.
- `repo.brain-log`, `repo.roadmap`, `repo.agents`, `repo.brain-index`, and
  `brain.length`: move durable detail down a layer, retain navigation, and rotate
  history only under an authorized migration with token and block proofs.
- `config.roadmap-order`: set `caps.roadmap.order` to `newest-first` or `oldest-first`.
- `repo.roadmap-order`: reconcile Open work date order with `caps.roadmap.order`.
- `stale`: read the description, then verify possibly changed facts against the
  current source. Do not assume age alone proves a memory wrong.
- `repo.not-git`, `repo.remote`, `repo.ahead`, and `repo.uncommitted`: inspect the
  memory repo and complete its authorized git checkpoint. For `repo.git-skipped`,
  report unavailable coverage and run without `--no-git` on the actual repo when
  authorized.
- `repo.skill-version`: compare these two skill files with the config and update
  stale instructions and their `engine_version` together.
- `config.*`: repair malformed allow entries, retire stale exceptions, and move
  detail down a layer when a finding grows. Never increase a ceiling to pass.
- `secret`: remove the credential from tracked content without echoing it;
  report the exposure for authorized credential remediation. Never allow it.

Rerun the gate after repairs and report remaining findings. Use absolute dates,
keep one fact per file, and update rather than duplicate the same idea. Commit
and push authorized memory changes at the checkpoint only for a separate memory repo.
For in-repo memory, follow host branch rules: checkpoint prints staging paths by default,
`--commit` commits only those paths on the current branch, and it never pushes. Respect task fences.
Keep superseded lessons in the catalog; name them in the new lesson's `supersedes` list. Merge files that hold the same fact;
retarget their links and keep history in git.

Run generators and rotation only for existing inputs; missing optional router, brain, log or roadmap inputs are a successful no-op.

## Capture, repeats and repair in 3.2.8

A lesson records one reusable rule: a `mistake` corrects a failure, a `practice` records a successful method,
and an `observation` records something to verify before reuse. Choose the kind explicitly. Keep a short
`metadata.trigger` such as "before retrying". Where a mistake is visible determines enforcement: a command
gets a hook, a file gets a check, and judgment gets a hard-rule card or a reasoned lesson-only decision.

```sh
node scripts/memory/memory-lesson.mjs new --kind mistake --route craft-sessions --trigger "before retrying" "Check before retrying"
node scripts/memory/memory-index.mjs --write
node scripts/memory/memory-check.mjs
node scripts/memory/memory-lesson.mjs batch <scratch>/lessons.md --dry-run
node scripts/memory/memory-lesson.mjs batch <scratch>/lessons.md
node scripts/memory/memory-lesson.mjs repeat 1 "slip: retried without checking"
node scripts/memory/memory-lesson.mjs enforce 1 "check <check-id-or-repo-file>"
node scripts/memory/memory-lesson.mjs enforce 1 "hook <repo-file>"
node scripts/memory/memory-lesson.mjs enforce 1 "hard-rule <memory-file>"
node scripts/memory/memory-lesson.mjs enforce 1 "lesson-only <reason of at least ten characters>"
node scripts/memory/memory-lesson.mjs repeat --from-legacy
node scripts/memory/memory-lesson.mjs repeat --from-legacy --write
node scripts/memory/memory-lesson.mjs classify <scratch>/kinds.json
node scripts/memory/memory-lesson.mjs classify <scratch>/kinds.json --write
```

For one lesson use `new`, fill the TODO description and body, regenerate, then gate. For several, use a Markdown
batch outside memory: each `## Title` has `kind: mistake|practice|observation`, `route: family`, a useful
`description:`, a blank line, and the complete body. Use `###` for body headings. A `repeat-of: 1` section instead
has only `cause:`, `description:` and optional `date:`, with no body; it records a repeat without allocating a number.
The four causes are `slip`, `not-recalled`, `rule-wrong` and `new-case`. Use a new lesson with `supersedes` when the
rule changes; never append a second rule. Classification reads `{"version":1,"kinds":{"lesson-001-example.md":"mistake"}}`.

Commit the host rules file in the project repository before recording any `enforced "<date> hook <file>"`
decision. If the file is missing in the checked-out repo, that decision counts as no decision and can FAIL the
memory pre-commit at four repeats.

Record repeats with the command, never extra prose. `lesson.enforce` WARNs at two and FAILs at four repeats without
a decision. A present but invalid `enforced` value (including a renamed or deleted hook file) counts as no decision
and also produces `lesson.enforced` WARN. Repair the decision. After a valid decision, one strictly later UTC-date
repeat WARNs and four FAIL; same-day repeats do not reopen it. `caps.lesson.lessonOnlyReturns: false` makes a valid
lesson-only decision permanent. Otherwise decide again. Add a trigger when `lesson.trigger` warns. Legacy conversion
is dry-run-first and idempotent on `--write`; it keeps the original paragraphs. Never use an allow entry for escalation.

The guard's starter rules ship as `warn`. Test a command saved in a file with
`node scripts/memory/memory-guard.mjs test <scratch>/command.txt`; replay real commands with
`node scripts/memory/memory-guard.mjs replay <scratch>/commands.jsonl`. Only after the rate is below 0.5 percent and
every sampled hit is a real hazard, switch that rule to `deny` in the host-owned `scripts/memory/enforce-rules.json`:
`{"version":1,"rules":[{"id":"piped-gate","action":"deny"}]}`. Kit defaults in `enforce-rules.kit.json` are refreshed on upgrade.
Claude Code receives guard warnings in PreToolUse `additionalContext`; verify that context reaches the model during
rollout. The prompt clock prints local time first, UTC second. Hand-written dates use UTC; `date.future` compares with
the UTC date of now, WARNs one day ahead and FAILs later.

For linked detail, run `node scripts/memory/memory-chains.mjs scan`, then
`node scripts/memory/memory-chains.mjs repair --write`. Parts start with `Part N of`, a Markdown link to the parent, and a period; parents link
parts in number order. Repair inserts missing back links; numbering, gaps and order need review by hand.
`node scripts/memory/memory-chains.mjs lines --write` recuts paragraphs only at sentence ends; hand-cut reported list
items and indented lines. Keep procedures, recipes, fenced blocks, tables, verbatim payloads and one incident's cause
chain whole. Keep everything needed to apply the rule in its file; move explanation whole to linked backgrounds.

When one event teaches several rules, write one lesson per rule and link one shared dated background file
(named `<date>-<slug>-background.md`, not a lesson, with `type: reference`, no route and no parent). Keep each
lesson sufficient to apply its rule. A five-to-twelve-line lesson is guidance, not a gate limit; a unit that cannot
fit the topic FAIL cap belongs whole in linked docs or a brain node. Amended and Confirmed paragraphs remain prose
during legacy conversion; review them rather than manufacturing repeat entries.

## Lesson casebook (3.2.8)

Read `scripts/memory/LESSON-KINDS.md` for K0, T1-T4 and K1-K10 before choosing a kind.
A true near-miss is practice when its title names the deliberate step; harm or an
acted-on verdict is mistake. Tool behaviour under normal use is observation;
our command shape is mistake. Label every row independently; record doubt in confidence.
Use optional `new --case Kn`, batch `case: Kn`, or the classify `cases` map to write
`metadata.kind_case`. `classify --case Kn` lists carriers. Missing/unknown cases
produce `kind.case` WARN only when present; superseded ones get `kind.case-superseded`.
Follow `scripts/memory/LABELLING.md` for two independent labellers: the kind test allows
at most 6 of 40 disagreements, scaled down; person-set labels are takeaways, not a
kind reference. Compare with `classify --score A.json B.json [--json]`.
Settle obvious rows by citing a case; uncertain rows with no similar case go to
a decision table for human review. No automatic bulk relabel or new memory types ship here.
Use separate option values: `--name value`; the shared parser refuses `--name=value`.
Hook/check file enforcement resolves symlinks and junctions and requires the real
file to remain inside the repo. An invalid recorded decision still escalates and
its `lesson.enforce` message ends with `; the recorded decision is invalid: <reason>`.

People set optional `metadata.takeaway`: `fix` (an error and its remedy), `method`
(the best way or next-time action), or `know` (how things work). Models label
`kind` and never set `takeaway` by default. Capture an explicit person-set value with
`new --takeaway fix`, batch `takeaway: fix`, or a classify `takeaways` map. Omitted
values stay untouched. Recall shows it and filters with `--takeaway fix|method|know`.
Invalid present values produce `lesson.takeaway` WARN, never FAIL.
