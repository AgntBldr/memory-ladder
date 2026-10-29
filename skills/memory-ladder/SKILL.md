---
name: memory-ladder
description: Use the v3 memory ladder for capture, recall, the gate, converting old memory, and installation in this project.
metadata:
  engine_version: "3.2.11"
---

# Memory ladder v3

Terms: see GLOSSARY.md at `scripts/memory/GLOSSARY.md` from the project root.
The engine and guide links below resolve after installation into `.claude/skills/`.
In the kit tree, read `engine/README.md` and the guides under `docs/`.

Locate the plan, ladder and caps through the [engine section list](../../../scripts/memory/README.md#section-list);
use [upgrade and recovery](../../../scripts/memory/UPGRADE.md) when changing the installed engine.

Use the [engine](../../../scripts/memory/README.md); follow `AGENTS.md`,
[the ladder and caps](../../../scripts/memory/README.md) and authorized paths.

## Route to the right layer

- Keep hard-rule triggers, active work and craft/domain routing in `MEMORY.md`.
  The router gains a line only for a new hard rule or an active-work item;
  route everything else through an index and file. Keep hard-rule triggers visible.
- Put activity pointers in `INDEX-craft-<activity>.md` and domain pointers in
  `INDEX-<domain>.md`. Write router and index lines as triggers:
  `OPEN BEFORE <activity>` / `OPEN when work touches <domain>`.
- Give each lesson or fact one kebab-case file with frontmatter `name`, static
  `description` (at most 200 characters), and `metadata.type` (`user`, `feedback`,
  `project`, or `reference`). Explain what happened, why, and how to apply it.
  Use absolute dates and exact identifiers.
- Keep a state file with `state: true` and exactly one current block. Overwrite
  that block at each checkpoint; use git to recover earlier state.
- Move shipped router pointers into `ARCHIVE.md`, a ledger of pointers and tags,
  never a body-text dump. ARCHIVE is never loaded by default.
- Put project facts in the project knowledge folder (`brain/` by default), under its own rules. Keep only the agent-side rule
  and a resolving `brain: brain/.../node.md` pointer in private memory.

**State is overwritten. Facts are moved. History is git.**
Read caps and pins from `scripts/memory/memory.config.json`. Never raise a pin or
an allowlist ceiling to pass the gate. Move detail down a layer. Write and prove
the destination before shortening its pointer. Never grow old-name recovery stubs.

Keep each hard-rule file at or below 2 KB. Retain every value needed to obey it:
paths, commands, ids, quotas, and accounts. Move only explanation and history
into linked backgrounds.

## Capture at the moment of learning

Run recall before writing. Update the same idea; do not duplicate it. Capture with
`node scripts/memory/memory-lesson.mjs new --kind <mistake|practice|observation> --route <family> "<title>"`.
Fill the TODO description and the why/how body before the gate. Routes may name
several families as `--route a --route b` or `--route a,b`. Optional pin, hook (at most 200 characters), and supersedes
fields live in metadata. Generated indexes need no manual count or split.
Keep distinct lessons out of journals.

Do not duplicate repo records. Capture durable knowledge when learned.
Keep an unresolved `[[wikilink]]` only as a marker for a lesson worth writing later;
inspect its warning. Link related memories with `[[name]]`.
Delete a memory that proves wrong; a wrong memory is worse than none.
Treat a memory naming a file, flag or number as a point-in-time observation;
verify it before asserting it.

At every checkpoint, update memory, write a lesson with the why, refresh the
roadmap's Open work and the work plan, copy specs/evidence still in a temp folder into `docs/`,
run the gate, and use the checkpoint command. For a separate memory repo, commit and push
as authorized. In in-repo memory, checkpoint never pushes and commits only with explicit
`--commit` on the current branch; follow host branch rules and report the staging paths.
At checkpoints run:

```sh
node scripts/memory/memory-checkpoint.mjs
```

Shelf programs in `docs/shelf/<name>.md` with `shelved`/`review`; the gate warns on the review date.

Preserve the current task's fences; report blocked writeback to the person coordinating the task.

## Recall before opening indexes

Run from the repo:

```sh
node scripts/memory/memory-recall.mjs "<question>"
```

Read relevant results; then OPEN the index named by the router's "OPEN BEFORE …"
line for this activity before acting. Honor domain and hard-rule triggers;
never bulk-load topic files.

## Gate

At session start and checkpoints, run:

```sh
node scripts/memory/memory-check.mjs
```

Use `--json` for finding details. Use `--session-start` for the compact hook
report; it always exits zero, so use the normal gate to enforce FAIL findings.
Memory pre-commit runs:

```sh
node scripts/memory/memory-check.mjs --hook --scope memory
```

Use `--memory-dir PATH` and `--repo PATH`. Reserve `--no-git`
for fenced copies; report skipped checks. Match both skills' `engine_version`
to config; `repo.skill-version` warns on missing or stale versions.

## Convert old memory with proof

Follow [conversion steps and proofs](../../../scripts/memory/CONVERT.md).
Use a git-excluded copy. Tag and snapshot the original FIRST; name EVERY destination and legal cut point.
Preserve bodies verbatim and resolving old-name stubs.
Extract by content, never by line number.

Run both conservation modes before and after moving:

```sh
node scripts/memory/memory-conserve.mjs snapshot --memory-dir COPY --out tokens.json
node scripts/memory/memory-conserve.mjs blocks-snapshot --out blocks.json --source SOURCE
node scripts/memory/memory-conserve.mjs verify --memory-dir COPY --baseline tokens.json
node scripts/memory/memory-conserve.mjs blocks-verify --baseline blocks.json --dest DESTINATION --json
```

Repeat `--source`/`--dest`; keep baselines outside moved sources. Give accepted
exceptions reasons, source/heading and an index for repeated headings. Inspect
missing, altered, duplicated and out-of-order blocks; test recall and run the gate BEFORE adoption.

Have a different model list every original imperative and check the rewrite,
including operational values. Adopt only after review and both proofs pass;
token presence alone cannot prove unchanged prose. Keep evidence outside the temporary conversion copy.

## Install for this project

Locate memory using `--memory-dir`, then `CLAUDE_MEMORY_DIR`, then tracked `memory.inRepoDir` in
`scripts/memory/memory.config.json` (relative to this checkout), then an existing
`KIT.local.json` directory; otherwise use
`~/.claude/projects/<absolute-repo-path-slug>/memory`. Replace every non-alphanumeric
character in the absolute repo path with `-`. Substitute `MEMORY_PATH` below.

For in-repo memory, install into a dedicated folder with `--memory-dir`; do not initialize
a nested repo, create a separate remote, or make a baseline commit. A root MEMORY.md layout
needs the separate conversion in CONVERT.md first. The following baseline and remote
steps apply only to a separate memory repo.

Create the directory, router and linked files; take an authorized baseline commit:

```md
# Memory
## Hard rules
- [Rule](rule.md) — OPEN BEFORE <activity>.
## Craft
- [Activity](INDEX-craft-activity.md) — OPEN BEFORE <activity>.
## Domains
- [Domain](INDEX-domain.md) — OPEN when work touches <domain>.
## Active work
- [Current](current-state.md) — OPEN BEFORE resuming work.
```

Use resolving triggers, topic descriptions and state frontmatter `state: true`
with one `## CURRENT` block. Generate the activity indexes.
Run from the project repository:

```sh
git -C MEMORY_PATH init
node scripts/memory/memory-index.mjs --memory-dir MEMORY_PATH --write
node scripts/memory/memory-check.mjs --memory-dir MEMORY_PATH
git -C MEMORY_PATH add .
git -C MEMORY_PATH commit -m "Baseline memory"
node scripts/memory/install-hooks.mjs --memory-dir MEMORY_PATH --repo PROJECT_PATH
```

Merge this real hook into `.claude/settings.json`, preserving other settings:

```json
{"hooks":{"SessionStart":[{"hooks":[{"type":"command","shell":"bash","command":"node \"${CLAUDE_PROJECT_DIR:-.}/scripts/memory/memory-check.mjs\" --session-start","timeout":10}]}]}}
```

Add the AGENTS.md "Memory gate" block with these rules:
- Run `node scripts/memory/memory-check.mjs` at session start and every checkpoint;
  fix or report FAIL. Claude Code uses SessionStart; other agents run it manually.
  The memory pre-commit runs `--hook --scope memory`.
- Run `node scripts/memory/memory-recall.mjs "<question>"` before opening indexes;
  then honor the router's required activity index before acting.
- Overwrite state; move facts; keep history in git. Keep one current state block,
  one lesson per file, and project facts in `brain/` with pointers from memory.
  Never raise pins or allowlist ceilings to pass; move detail down a layer.

Optional private remote: `git -C MEMORY_PATH remote add origin URL`, then
`git -C MEMORY_PATH push -u origin HEAD`. Push at authorized checkpoints only for a separate memory repo.

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
