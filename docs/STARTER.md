# Starter: a new project on the memory ladder

[How it works](HOW-IT-WORKS.md): illustrated guide to the memory ladder.

Terms: see [GLOSSARY.md](GLOSSARY.md).

For someone starting a project with an agent (Claude Code, Codex or Cursor) and no memory system yet.
Two parts: the first setup, done once in about ten minutes, and the routine every session afterwards.
Replace `<PROJECT>` with the project folder, `<KIT>` with where the kit was cloned or copied,
`<KIT_REMOTE>` with the kit repository's clone URL, `<tag>` with a release tag, and `<PRIVATE_REMOTE>`
with a private Git remote you control.

## Part 1: first setup (once)

Needs: Node 22 or newer, Git with a name and email set (Git for Windows on Windows: the hook runs in Git Bash),
the project folder as a Git repository (`git init` first if it is not), and a private Git remote for the memory.

1. **Get the kit next to the project**, not inside it:
   `git clone --branch <tag> <KIT_REMOTE> <KIT>` (or copy the kit folder). Use `v3.2.11` with this
   guide, or read the guide shipped with your chosen release. The kit is the original; everything installed is a copy, so never
   edit the installed engine by hand.
2. **Preview**: `node <KIT>/scripts/install.mjs --target <PROJECT> --dry-run` prints every file it would write
   and changes nothing.
3. **Install**: `node <KIT>/scripts/install.mjs --target <PROJECT>`. It writes `scripts/memory/` (engine, config,
   probes, `KIT.json` receipt, `MANIFEST.json`), the two skills under `.claude/skills/`, SessionStart, PreToolUse and UserPromptSubmit hooks in
   `.claude/settings.json` (other settings kept), the memory-gate block in `AGENTS.md` (or `CLAUDE.md` when that
   is the only instructions file), and a starter private memory (router, one sessions index, one state file)
   with a baseline commit. When the project already has a `brain/` folder, it also writes the brain index.
   The gate summary must report `0 FAIL`; the one expected WARN on a fresh install is `repo.remote`.

   **Where everything lives after this step** (a project with no instructions file before):
   - `AGENTS.md`: the `## Memory gate` section with the gate rules; `CLAUDE.md` holds `@AGENTS.md` so every
     agent reads one source. If the project already had both files, add `@AGENTS.md` to `CLAUDE.md` yourself.
     The full routine, including the lesson file format, is in `.claude/skills/memory-ladder/SKILL.md`.
   - `scripts/memory/memory-check.mjs`: the gate; `scripts/memory/memory-recall.mjs`: recall. Run both from
     the project root.
   - `.claude/settings.json`: SessionStart runs the gate with `--session-start`; PreToolUse runs the command guard and UserPromptSubmit prints the clock.
   - `.claude/skills/memory-ladder/` and `.claude/skills/memory-review/`: the two procedures.
   - The private memory: `~/.claude/projects/<project-path-slug>/memory/` (every non-alphanumeric character
     of the absolute project path becomes `-`), holding `MEMORY.md` (the router), `INDEX-craft-sessions.md`
     and `current-state.md`. The install output prints the exact folder on its `memory:` line.
4. **Back the memory up**: the private memory lives outside the project (the install output names the folder).
   `git -C <MEMORY> remote add origin <PRIVATE_REMOTE>` then `git -C <MEMORY> push -u origin HEAD`.
   Alternatively, use ONE private backup repo for many projects, with one backup branch per project.
   Before the first push, run these commands inside `<MEMORY>` (replace `<project>` with a unique project name):

   ```sh
   git branch -m <project>
   git remote add origin <PRIVATE_REMOTE>
   git push -u origin <project>
   ```

   Publish tags only with project-qualified names: `git tag <project>/<tag>` then
   `git push origin refs/tags/<project>/<tag>`. Never push plain tags or use `--tags` to this shared remote.
   The checkpoint's plain `git push` then lands on that project's upstream branch.
   On another computer, restore it with `git clone --branch <project> <PRIVATE_REMOTE> <MEMORY>`.

   Rerun `node <PROJECT>/scripts/memory/memory-check.mjs` and expect `0 FAIL, 0 WARN`.
5. **Commit the project side by name**: `scripts/memory/`, `.claude/skills/memory-ladder/`,
   `.claude/skills/memory-review/`, `.claude/settings.json`, and `AGENTS.md` or `CLAUDE.md`
   (the installer's ignore rules live in `scripts/memory/.gitignore`). Never `git add -A`.
6. **First session prompt**, pasted into the agent in `<PROJECT>`:

   > Read AGENTS.md and follow its `## Memory gate` section, and read `.claude/skills/memory-ladder/SKILL.md`.
   > Run `node scripts/memory/memory-check.mjs` and report the gate summary. Open `MEMORY.md` in the memory folder
   > the gate names, then `current-state.md`. Write the first state block: what this project is, what is being
   > built first, what waits on me. Add one hard-rule file only if I have given you a rule that must fire before
   > you know the task. Commit the memory repo and push it. Tell me which commands you will run at session start
   > and at a checkpoint.

   Start or restart the agent after the install so it loads the hook and skills. The agent should answer with
   the gate line and the commands below. If it answers with anything else, it did not read the files; paste
   the prompt again.

If the engine is already installed and the private memory folder is absent, run `node scripts/memory/memory-init.mjs` from the project root. It creates the memory, baseline commit and hook; `--dry-run` previews writes and `--memory-dir <MEMORY>` selects a folder. An existing folder is left unchanged.

## Part 2: every session afterwards

**Start.** In Claude Code the hook runs the gate and prints one line, `memory gate: ok` with counts, or the
FAIL findings and the command to run. Codex and Cursor do not run the hook; run the gate by hand. Before opening
any index, ask:
`node scripts/memory/memory-recall.mjs "<what I am about to do>"` and open only the files it returns. Then
open the router's hard-rule lines that match the task. On a fresh memory, recall returns only the files whose
words match (often just the state file) or nothing at all; that is normal until lessons exist. Open the
router then.

**During.** Capture one rule with `memory-lesson.mjs new --kind <mistake|practice|observation> --route <family> "<title>"`, fill it,
regenerate indexes, and gate. For several rules use a filled batch outside memory with `memory-lesson.mjs batch FILE`.
Record recurrence with `memory-lesson.mjs repeat <id> "<cause>: <note>"`, then decide with `enforce`; do not append prose. Facts about the
project go in the project's own records (a `brain/` vault or docs), with memory holding only the pointer.

**End (checkpoint).** Overwrite the state block, then run `node scripts/memory/memory-checkpoint.mjs`.
It generates memory indexes, rotates existing history, refreshes project navigation, checks the gate,
commits memory and pushes. Fix every FAIL; a refused push is reported. Use `--no-push` or `--dry-run`
when appropriate. Commit the project by name.

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
  proofs; work on a separate conversion copy.

## What good looks like after a month

The gate is green at every session start; the router is under its warning cap and holds only hard rules,
active work and routing lines; every lesson is one file with one index line; the state file has one block;
the memory repo has one commit per checkpoint on its private remote; the measurement command
(`node scripts/memory/memory-measure.mjs --probe scripts/memory/recall-probes.json --write <name>`) shows
recall still finds what the probes ask for.

Capture a lesson with `node scripts/memory/memory-lesson.mjs new --kind <mistake|practice|observation> --route <family> "<title>"`.
Fill the TODO description and body; indexes and catalogs are generated from routes.

## Installing into an existing project safely

Install preflights existing instructions, imports, memory routers, generated destinations and skill mirrors before writing. An in-repo MEMORY.md router (including .claude/memory/MEMORY.md or root MEMORY.md alongside INDEX pages) causes refusal when --memory-dir does not name its folder. The error names the router and the separate folder that would have been gated. --accept-separate-memory explicitly overrides with a warning; dedicated in-repo memory folders are supported and gated as described below. Plain "memory is in-repo" declarations also require an explicit decision.

A hand-written brain/00-system/index.md, including Dataview blocks, stays byte-identical. Generated output uses index-generated.md alongside index-all.md. Only files carrying the existing "Static index, regenerated by scripts/memory/brain-index.mjs --write." marker may be replaced. A hand-written fallback/full-list destination causes refusal rather than replacement. A brain with no node having both id and type gets no brain-index generation and no brain.frontmatter or brain.length findings on plain notes with neither field. The first node with both fields, including one in 99-inbox/, makes every discovered subfolder note subject to node checks; 99-inbox/ retains its brain.frontmatter exemption. Files with only one field outside 99-inbox/ still fail brain.frontmatter. Parse findings, secret scanning, duplicate IDs, edges and link reachability still run.

Existing KIT.local.json retains its bytes when no preference changes; --no-guard merges guard: false while keeping memoryDir. A conflicting memoryDir refuses before writes. Existing AGENTS.md / CLAUDE.md retain their line endings when instructions are appended. Settings retain permissions and all other keys and hooks; the kit appends its missing SessionStart, PreToolUse and UserPromptSubmit hooks. JSON formatting can change. Byte-identical .agents/skills mirrors and other skills folders referenced by instructions are updated together with .claude/skills; divergent mirrors refuse before writes. Existing conflicting kit destinations require the explicit --backup option, which preserves their original bytes.

Install ends with every created or modified host file, its relative path and bytes before -> after, including backups. No git diff is needed to review this report. It also prints:

```sh
node --test scripts/memory/memory.selftest.mjs
```

Optionally add "memory:test": "node --test scripts/memory/memory.selftest.mjs" to the host's package.json scripts. The kit's own suite continues to run engine/memory.test.mjs; the installer maps that source to the safe installed name. Upgrade removes the old installed memory.test.mjs only when its hash matches the prior installed manifest, retaining edited copies with a message.

Default discovery checked against the official documentation:

- [Vitest](https://vitest.dev/config/include): **/*.{test,spec}.?(c|m)[jt]s?(x); selftest is neither test nor spec.
- [Jest](https://jestjs.io/docs/configuration#testmatch-arraystring): __tests__ folders or test/spec suffixes; scripts/memory/memory.selftest.mjs matches neither.
- [Mocha](https://mochajs.org/running/test-globs/): ./test/*.{js,cjs,mjs}; scripts/memory is outside test.
- [Node](https://nodejs.org/api/test.html#running-tests-from-the-command-line): test directories, test-prefixed names and test suffixes; memory.selftest.mjs under scripts/memory matches none. Explicit node --test with its path runs it.

Custom broad runner globs may still need an exclude. [ESLint](https://eslint.org/docs/latest/use/configure/configuration-files)'s default flat-config JS discovery includes .mjs, so eslint . can report host-rule violations in the engine. For flat configs add a global ignores entry for scripts/memory/**; for legacy configs use ignorePatterns (or .eslintignore). TypeScript with allowJs/checkJs can include .mjs; add scripts/memory/** to tsconfig.json exclude if needed (explicit imports can still include excluded files). Install detects eslint.config.*, .eslintrc*, and explicit allowJs/checkJs flags in tsconfig.json and prints these hints without editing host tool configuration. Inherited tsconfig settings require manual review.

Linked Git worktrees share the main checkout's default memory slug and scripts/memory/KIT.local.json. Detection compares git-common-dir with git-dir, then resolves the main checkout from git worktree list. Explicit --memory-dir and CLAUDE_MEMORY_DIR retain precedence. Gate, recall and SessionStart all use this shared resolver.

Route migration treats index links in state prose as prose. Routing entries start with an index link (optionally list/table markup) or an explicit OPEN/BEFORE/WHEN directive; existing backtick entries use the same rule. Removed continuation rows are retained verbatim in index-notes pages, and migration asserts their exact text survives. route.trigger fails for a family without an OPEN/BEFORE/WHEN/TRIGGER directive; index.trigger fails when a generated hot page lacks one in its first eight lines.

## Memory inside the repo

Use a dedicated folder such as `memory/` or `.claude/memory/`:

`node scripts/install.mjs --target <PROJECT> --memory-dir <PROJECT>/memory`

Install records `memory.inRepoDir` in the tracked `scripts/memory/memory.config.json`.
Commit that configuration with the project using its normal branch rules. Every clone and
worktree resolves the relative folder against its own checkout. Resolution order is
`--memory-dir`, `CLAUDE_MEMORY_DIR`, `memory.inRepoDir`, `KIT.local.json`, then the slug default.
Install creates no nested Git repo and makes no baseline commit in this mode.

The project pre-commit hook gates staged memory only (`--hook --scope memory`). Checked relative Markdown links to files outside memory but inside the same repository are resolved against the index, including staged additions; untracked targets remain dead links. If a hook
already exists or `core.hooksPath` is configured, install leaves it alone and prints the exact
line to add from the repo root. The gate retains content checks and committed-age checks;
it skips memory-repo remote, ahead and dirty checks and says `in-repo memory` in its summary.

Checkpoint regenerates, rotates and gates, then prints `git add -- <paths>` and a suggested
commit message. It does not commit by default. Explicit `--commit` commits only the listed
paths on the current branch, preserving unrelated staged changes. It never pushes in this
mode. Follow the host's branch policy, including when another agent shares the branch.
Upgrade, SessionStart and recall use the same resolver; fleet reports `in-repo` status.

A root `MEMORY.md` layout must first undergo the separate, copy-first conversion in
[Move root memory into a dedicated folder](CONVERT.md#move-root-memory-into-a-dedicated-folder).

### Capture, repeats, repair and labels

Choose the kind using the installed `scripts/memory/LESSON-KINDS.md` casebook. Capture with
`node scripts/memory/memory-lesson.mjs new --kind <mistake|practice|observation> --route <family> "<title>"`;
optionally add `--case Kn` for an installed case id. List lessons carrying that case with
`node scripts/memory/memory-lesson.mjs classify --case Kn`.
A person may add `--takeaway fix|method|know` to capture; models never set it. These mean an error
and its remedy, a best method or next-time action, and how something works, respectively.
Recall displays these labels and filters with `--kind` and `--takeaway`.

Follow the [labelling guide](LABELLING.md) for two independent labellers, then run
`node scripts/memory/memory-lesson.mjs classify --score A.json B.json`. The kind test allows
at most 6 of 40 disagreements, scaled down with `floor(rows * 6 / 40)`, and prints
`kind test: PASS` or `kind test: FAIL`; empty or unequal row sets fail. Reports exit 0 even
for FAIL, so read the verdict. Person-set takeaways are not a kind reference.
After review, preview `node scripts/memory/memory-lesson.mjs classify settled.json`, then add
`--write`; the file holds settled `kinds`, optional `cases`, and person-set `takeaways` maps.
See the [casebook](LESSON-KINDS.md) for decisions and case ids.

Capture several filled lessons with `node scripts/memory/memory-lesson.mjs batch <scratch>/lessons.md`;
keep the batch outside memory and include a `kind` for every lesson, with optional `case` and person-set `takeaway`.
Record recurrence with `node scripts/memory/memory-lesson.mjs repeat <id> "slip: <note>"`,
then decide with `node scripts/memory/memory-lesson.mjs enforce <id> "<hook|check|hard-rule|lesson-only> <where>"`.
For `chars.*`, preview `node scripts/memory/memory-chars.mjs repair`, allow deliberate examples, then add `--write`;
fix report-only residues by hand. `router.lines` warns above 150 and fails above 200: move detail down a layer.
The skills explain kinds, four repeat causes, classification, guard replay and chain repair.
