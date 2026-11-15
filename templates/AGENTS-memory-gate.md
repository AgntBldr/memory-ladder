## Memory gate

- If the private memory folder is absent, run `node scripts/memory/memory-init.mjs` from the project root.

- At session start and every checkpoint run `node scripts/memory/memory-check.mjs`; fix or report every FAIL.
- Claude Code uses SessionStart; other agents run the gate manually. Memory pre-commit runs `--hook --scope memory`.
- Before opening indexes run `node scripts/memory/memory-recall.mjs "<question>"`; honor the router's activity triggers.
- State is overwritten, facts are moved, history is git: one current block, one lesson per file, project facts in `brain/` with memory pointers.
- Never raise a pin or allowlist ceiling to pass; move detail down a layer. Write the destination before shortening a pointer.
- Capture with `node scripts/memory/memory-lesson.mjs new --kind <mistake|practice|observation> --route <family> "<title>"`; fill the TODO description and body.
- At checkpoints run `node scripts/memory/memory-checkpoint.mjs`: generate indexes, rotate history, refresh overviews, gate, commit and push. Use `--no-push` or `--dry-run` when needed.
- Session phrases: when a message is only "We are starting a new session - read this and let me know when we can start" or "handover" (or /new-session, /handover), run `node scripts/memory/new-session.mjs dispatch --message "<the message>"` and follow its output; never inside a subagent or `codex exec` brief. Run /handover only when the operator asks for it (operator, 2026-11-10); do not offer it unprompted.
- Reports: never a wall of text. Group facts under short bold headings, one fact per bullet, a blank line between groups. Link every file you name (a path relative to the project root) and every board or page by its full URL. End finished work by saying whether it is safe to compact; say yes only when memory and the work are committed and pushed and the memory gate has no FAIL. /handover is not required for it (operator, 2026-11-10).

For several lessons use `node scripts/memory/memory-lesson.mjs batch <scratch>/lessons.md`; record recurrence with `node scripts/memory/memory-lesson.mjs repeat <id> "<cause>: <note>"`.
Claude Code runs the command guard and the clock line from .claude/settings.json; other agents are guarded by the hard-rule cards, the git hooks and the gate.
