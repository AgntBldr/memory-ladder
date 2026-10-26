## Memory gate

- At session start and every checkpoint run `node scripts/memory/memory-check.mjs`; fix or report every FAIL.
- Claude Code uses SessionStart; other agents run the gate manually. Memory pre-commit runs `--hook --scope memory`.
- Before opening indexes run `node scripts/memory/memory-recall.mjs "<question>"`; honor the router's activity triggers.
- State is overwritten, facts are moved, history is git: one current block, one lesson per file, project facts in `brain/` with memory pointers.
- Never raise a pin or allowlist ceiling to pass; move detail down a layer. Write the destination before shortening a pointer.
- Capture with `node scripts/memory/memory-lesson.mjs new --route <family> "<title>"`; fill the TODO description and body.
- At checkpoints run `node scripts/memory/memory-checkpoint.mjs`: generate indexes, rotate history, refresh overviews, gate, commit and push. Use `--no-push` or `--dry-run` when needed.
