# Starter: a new project on the memory ladder

For someone starting a project with an agent (Claude Code, Codex or Cursor) and no memory system yet.
Two parts: the first setup, done once in about ten minutes, and the routine every session afterwards.
Replace `<PROJECT>` with the project folder, `<KIT>` with where the kit was cloned or copied,
`<KIT_REMOTE>` with the kit repository's clone URL, `<tag>` with a release tag, and `<PRIVATE_REMOTE>`
with a private Git remote you control.

## Part 1: first setup (once)

Needs: Node 22 or newer, Git, and the project folder as a Git repository (`git init` first if it is not).

1. **Get the kit next to the project**, not inside it:
   `git clone --branch <tag> <KIT_REMOTE> <KIT>` (or copy the kit folder). If that tag predates this
   sheet, clone the default branch instead. The kit is the original; everything installed is a copy, so never
   edit the installed engine by hand.
2. **Preview**: `node <KIT>/scripts/install.mjs --target <PROJECT> --dry-run` prints every file it would write
   and changes nothing.
3. **Install**: `node <KIT>/scripts/install.mjs --target <PROJECT>`. It writes `scripts/memory/` (engine, config,
   probes, `KIT.json` receipt, `MANIFEST.json`), the two skills under `.claude/skills/`, a SessionStart hook in
   `.claude/settings.json` (other settings kept), the memory-gate block in `AGENTS.md` (or `CLAUDE.md` when that
   is the only instructions file), and a starter private memory (router, one sessions index, one state file)
   with a baseline commit. When the project already has a `brain/` folder, it also writes the brain index.
   The last line must read `0 FAIL`; the one expected WARN on a fresh install is `repo.remote`.

   **Where everything lives after this step** (a project with no instructions file before):
   - `AGENTS.md`: the `## Memory gate` section, the only rules the agent needs; `CLAUDE.md` holds `@AGENTS.md`
     so every agent reads one source. Point the agent here.
   - `scripts/memory/memory-check.mjs`: the gate; `scripts/memory/memory-recall.mjs`: recall. Run both from
     the project root.
   - `.claude/settings.json`: the SessionStart hook that runs the gate with `--session-start`.
   - `.claude/skills/memory-ladder/` and `.claude/skills/memory-review/`: the two procedures.
   - The private memory: `~/.claude/projects/<project-path-slug>/memory/` (every non-alphanumeric character
     of the absolute project path becomes `-`), holding `MEMORY.md` (the router), `INDEX-craft-sessions.md`
     and `current-state.md`. The install output prints the exact folder on its `memory:` line.
4. **Back the memory up**: the private memory lives outside the project (the install output names the folder).
   `git -C <MEMORY> remote add origin <PRIVATE_REMOTE>` then `git -C <MEMORY> push -u origin HEAD`.
   Rerun `node <PROJECT>/scripts/memory/memory-check.mjs` and expect `0 FAIL, 0 WARN`.
5. **Commit the project side by name**: `scripts/memory/`, `.claude/skills/memory-ladder/`,
   `.claude/skills/memory-review/`, `.claude/settings.json`, and `AGENTS.md` or `CLAUDE.md`
   (the installer's ignore rules live in `scripts/memory/.gitignore`). Never `git add -A`.
6. **First session prompt**, pasted into the agent in `<PROJECT>`:

   > Read AGENTS.md and follow its `## Memory gate` section. Run `node scripts/memory/memory-check.mjs` and report
   > the last line. Open the memory router the gate names, then its state file. Write the first state block:
   > what this project is, what is being built first, what waits on me. Add one hard-rule file only if I have
   > given you a rule that must fire before you know the task. Commit the memory repo and push it. Tell me
   > the three commands you will run at the start and end of every session.

   The agent should answer with the gate line, the recall command and the checkpoint commands below. If it
   answers with anything else, it did not read the gate section; paste the prompt again.

## Part 2: every session afterwards

**Start.** The hook runs the gate and prints the last ten lines of state. Before opening any index, ask:
`node scripts/memory/memory-recall.mjs "<what I am about to do>"` and open only the files it returns. Then
open the router's hard-rule lines that match the task. On a fresh memory, recall returns only the files whose
words match (often just the state file) or nothing at all; that is normal until lessons exist. Open the
router then.

**During.** The moment something is learned the hard way, write one lesson file (`lesson-NNN-<slug>.md`, next
number) with what happened, why, and how to apply it, and add one line to the matching index. Facts about the
project go in the project's own records (a `brain/` vault or docs), with memory holding only the pointer.

**End (checkpoint).** Overwrite the state block (never append a second one); run the generators the project
has (`node scripts/memory/memory-rotate.mjs log --write`, `node scripts/memory/brain-index.mjs --write`,
`node scripts/memory/roadmap-overview.mjs --write`; each is a no-op when its file does not exist); run
`node scripts/memory/memory-check.mjs` and fix or report every FAIL; commit the memory repo (its pre-commit
runs the gate) and push; commit the project by name. Never raise a pin or an allow ceiling to pass the gate;
move detail down a layer instead.

**Compacting or handing over.** The state block is the handover. Before a compaction or a switch of agent,
make it current and push the memory; the next session starts from it.

## When the kit publishes a new tag

Update the kit clone, then `node <KIT>/scripts/upgrade.mjs --target <PROJECT> --check` (exit 0 = current;
exit 1 = an update is available, a kit-owned file was edited locally, or the check failed: read the lines).
Apply with `node <KIT>/scripts/upgrade.mjs --target <PROJECT>`; it backs up to a timestamped folder, replaces
only kit-owned files, keeps config, probes, hooks and instruction blocks, and rolls back on new FAILs
(`--restore <BACKUP>` if needed). Finish with the explicit gate. Details: `docs/UPGRADE.md`.

## If the project already has memory

- Old memory files (a big MEMORY.md, journals, a lessons file): `docs/CONVERT.md`, a scripted conversion with
  proofs; do it in its own session.

## What good looks like after a month

The gate is green at every session start; the router is under its warning cap and holds only hard rules,
active work and routing lines; every lesson is one file with one index line; the state file has one block;
the memory repo has one commit per checkpoint on its private remote; the measurement command
(`node scripts/memory/memory-measure.mjs --probe scripts/memory/recall-probes.json --write <name>`) shows
recall still finds what the probes ask for.
