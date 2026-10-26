---
name: memory-ladder
description: Use the v3 memory ladder for capture, recall, the gate, converting old memory, and installation in this project.
engine_version: "3.2.2"
---

# Memory ladder v3

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
- Put project facts in `brain/` under its protocol. Keep only the agent-side rule
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
`node scripts/memory/memory-lesson.mjs new --route <family> "<title>"`.
Fill the TODO description and the why/how body before the gate. Routes may name
several families. Optional pin, hook (at most 200 characters), and supersedes
fields live in metadata. Generated indexes need no manual count or split.
Keep distinct lessons out of journals.

Do not duplicate repo records. Capture durable knowledge when learned.
Keep an unresolved `[[wikilink]]` only as a marker for a lesson worth writing later;
inspect its warning. Link related memories with `[[name]]`.
Delete a memory that proves wrong; a wrong memory is worse than none.
Treat a memory naming a file, flag or number as a point-in-time observation;
verify it before asserting it.

At every checkpoint, update memory, write a lesson with the why, refresh the
roadmap's Open work and the decision board, copy specs/evidence still in a temp folder into `docs/`,
run the gate, and commit and push the memory repo. Say that you did it.
At checkpoints run:

```sh
node scripts/memory/memory-checkpoint.mjs
```

Shelf programs in `docs/shelf/<name>.md` with `shelved`/`review`; the gate warns on the review date.

Preserve the current task's fences; report blocked writeback to its integration owner.

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
token presence alone cannot prove unchanged prose. Keep evidence outside `.memwork/`.

## Install for this project

Locate memory using `--memory-dir`, then `CLAUDE_MEMORY_DIR`, then an existing
`KIT.local.json` directory; otherwise use
`~/.claude/projects/<absolute-repo-path-slug>/memory`. Replace every non-alphanumeric
character in the absolute repo path with `-`. Substitute `MEMORY_PATH` below.

Create the directory, router and linked files; take a baseline commit:

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
`git -C MEMORY_PATH push -u origin HEAD`. Push at every checkpoint.
