# Prompt: strengthen this project's memory with numbered lessons

Paste the block below into a new session in the target project. Replace the four values in angle brackets first.
The session follows `docs/LESSON-CONVERSION.md` (installed as `scripts/memory/LESSON-CONVERSION.md`).

```text
Goal: this project's memory keeps its know-how in topic files, so the gate's index.hot-budget warnings never clear and
recall cannot rank lessons. Convert it to numbered lessons with the memory-ladder kit's procedure, with proofs, losing
nothing. Read scripts/memory/LESSON-CONVERSION.md first and follow it step by step; it is the method, this prompt only
sets the values and the stop points.

Values:
- Project repo: <REPO PATH>
- Memory directory: <MEMORY DIR, or "default">
- Reference memory with labelled lessons, for calibration and precedent: <REFERENCE MEMORY DIR>
- Model roles: <e.g. "orchestrator plans and reviews; a builder agent builds and labels; a different model is the third
  labeller and reviews built diffs"; or "follow AGENTS.md">

Rules:
- Never write into the reference project or any other project. Read it only.
- Work on a git branch or worktree for repo changes and on a clone of memory for every bulk change; live memory changes
  only in the replay step, after review.
- Keep labelling bundles, labeller outputs and keys out of git: they hold private memory text.
- Short loops: run a few bundles or the targeted tests first, then widen. Run the full test suite once, after the
  last fix, and never while a builder is editing the same tree.
- Never raise a cap, pin or allow ceiling, never compress a rule's text, never delete a memory.

Stop and report to me (with numbers, file links, and a recommendation) at these points, and wait for my answer:
1. After step 1 (census): the class table, the per-family projection, and the step 2 rulings to decide.
2. After step 3 (labelling): calibration scores, the dispute count by field, the settlement outcome, the rows I must
   settle, and the projected hot bytes per family.
3. After step 5 (review), before step 6 touches live memory: every proof result from step 4 and the reviewer's list.
At the end: the gate's before and after counts by WARN class, lessons created, recall results, and what you would
change in the kit (do not change the kit from this project; write the proposals into a dated report).
```

The kit ships the tools the procedure names: `memory-census.mjs`, `memory-label.mjs` and
`memory-selfrecall.mjs` and `memory-migrate.mjs promote`. A project on an older engine upgrades first (step 0).
