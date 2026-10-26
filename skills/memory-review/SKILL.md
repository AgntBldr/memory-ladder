---
name: memory-review
description: Audit this project's v3 memory with the Node gate and repair only reported FAIL or WARN findings. Use for memory review, checkpoint checks, or fixing stale, oversized, or broken memory.
engine_version: "3.2.2"
---

# Review v3 memory

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
and push authorized memory changes at the checkpoint. Respect task fences.
Keep superseded lessons in the catalog; name them in the new lesson's `supersedes` list. Merge files that hold the same fact;
retarget their links and keep history in git.

Treat `scripts/memory-health.ps1` in this skill's directory
(`.claude/skills/memory-review/scripts/memory-health.ps1`) as retired in this
project and kept for history only. Do not delete or run it as the gate.
