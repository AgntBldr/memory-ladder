# Memory ladder kit

[How it works](docs/HOW-IT-WORKS.md): illustrated guide to the memory ladder.

Terms: see [GLOSSARY.md](docs/GLOSSARY.md).

Long-term memory for a coding agent (Claude Code, Codex or Cursor) that stays small enough to trust. The kit
installs three things into your project: a gate that checks the memory at every session start and every memory
commit, a recall command that finds the right note before the agent opens anything, and a routine that ends each
session with one short handover. It is plain Node with no package dependencies, and it makes no network calls.

[WHY](WHY.md) explains the idea behind the ladder. Figures in WHY are measured in real memories; not performance guarantees.

## How it fits together

- **The memory** is a folder of Markdown files outside your project, with its own Git repository. The install
  creates it; when the engine is already installed but the folder is absent, run `node scripts/memory/memory-init.mjs` from the project root. It holds `MEMORY.md` (the router: hard rules, active work and links to the indexes), index files that
  list lessons, one file per lesson, and `current-state.md` with a single `## CURRENT` block that says where the
  work stands.
- **The gate** is `scripts/memory/memory-check.mjs` in your project. It checks the memory's size and structure and
  reports each problem as a FAIL or a WARN.
- **Recall** is `scripts/memory/memory-recall.mjs`. Given a question, it returns the memory files to open.
- **The routine** is in `.claude/skills/memory-ladder/SKILL.md`: what to do at session start, while working and
  at a checkpoint (the end-of-session save).

## What you need

- Node 22 or newer, and Git with a name and email set (`git config --global user.name` and `user.email`).
  On Windows, use Git for Windows: the session-start hook runs in its Git Bash shell.
- A project folder that is a Git repository. If it is not one yet, run `git init` in it.
- A private Git remote for the memory, such as an empty private GitHub repository. The memory holds your notes, so
  it gets its own private backup, even when the project itself is public.

## Get started (first time, about ten minutes)

In these steps, `<PROJECT>` is the full path of your project folder. The engine version matches `VERSION`.

1. Get the kit next to your project, not inside it. From the folder that holds your project:

   ```sh
   git clone --branch <tag> https://github.com/AgntBldr/memory-ladder.git memory-ladder-kit
   cd memory-ladder-kit
   node scripts/install.mjs --help
   ```

   Replace `<tag>` with a release tag. The last command
   lists the install options and changes nothing.

2. Preview the install. It prints every file it would write and changes nothing:

   ```sh
   node scripts/install.mjs --target <PROJECT> --dry-run
   ```

3. Install:

   ```sh
   node scripts/install.mjs --target <PROJECT>
   ```

   Two lines of the output matter:
   - The `memory:` line names the folder that holds your private memory. The steps below call it `<MEMORY>`.
     By default it is `~/.claude/projects/<slug>/memory`, where `<slug>` is the absolute project path with every
     character that is not a letter or a digit replaced by `-`. On Windows, `~` is your `%USERPROFILE%` folder,
     and the slug is derived from the project path. The label in brackets after the path says
     how the folder was chosen; on a first install it can read `(--memory-dir)` even when you passed no flag.
   - The gate summary looks like `memory-check 3.2.12 [all]: 0 FAIL, 1 WARN, 0 allowed, ...`. **0 FAIL means the
     install worked.** The one WARN is `repo.remote`: the new memory repository has no remote yet. Step 4 adds it.

4. Back up the memory. Replace `<PRIVATE_REMOTE>` with the clone URL of your private remote:

   ```sh
   git -C <MEMORY> remote add origin <PRIVATE_REMOTE>
   git -C <MEMORY> push -u origin HEAD
   ```

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

   Then run the gate from the project folder: `node scripts/memory/memory-check.mjs`. The gate summary now reads
   `0 FAIL, 0 WARN`.

5. Commit the files the install added to your project. Run `git status` in the project folder to see them, then
   add them by name. For a project that had no `AGENTS.md` or `CLAUDE.md` before, the list is:

   ```sh
   git add scripts/memory .claude/skills/memory-ladder .claude/skills/memory-review .claude/settings.json AGENTS.md CLAUDE.md
   git commit -m "Add the memory ladder"
   ```

   Add files by name rather than with `git add -A`, so nothing unrelated slips into the commit. If your
   `.gitignore` ignores `.claude/`, `git add` refuses those paths; add them with `git add -f`.

6. Start the first session. Start your agent in the project folder, or restart it if it was already open, so it
   loads the new hook and skills. Paste this prompt:

   > Read AGENTS.md and follow its `## Memory gate` section, and read `.claude/skills/memory-ladder/SKILL.md`.
   > Run `node scripts/memory/memory-check.mjs` and report the gate summary. Open `MEMORY.md` in the memory folder
   > the gate names, then `current-state.md`. Write the first state block: what this project is, what is being
   > built first, what waits on me. Add one hard-rule file only if I have given you a rule that must fire before
   > you know the task. Commit the memory repo and push it. Tell me which commands you will run at session start
   > and at a checkpoint.

   The agent replies with the gate's summary and the commands: the gate and recall at session start, the gate
   and the memory commit at a checkpoint. If it replies with anything else, it has not read the files. Paste the
   prompt again.

Where the agent reads its rules:
- Claude Code reads `CLAUDE.md`. When the install creates `CLAUDE.md`, it contains `@AGENTS.md`, which pulls in
  `AGENTS.md`. If your project already had both files, add the line `@AGENTS.md` to `CLAUDE.md` yourself;
  otherwise Claude Code never sees the gate section.
- Codex and Cursor read `AGENTS.md` directly.
- The `## Memory gate` section in `AGENTS.md` holds the gate rules. The full routine, including the lesson file
  format, is in `.claude/skills/memory-ladder/SKILL.md`. Claude Code loads it as a skill; point Codex and Cursor at
  it.

## Every session after

**At the start.** In Claude Code the session-start hook runs the gate and prints one line: `memory gate: ok`
followed by counts, or the FAIL findings and the command to run. Codex and Cursor do not run the hook, so ask the
agent to run `node scripts/memory/memory-check.mjs` first. Before the agent opens any memory index, it asks recall
and opens only the files recall returns:

```sh
node scripts/memory/memory-recall.mjs "<what you are about to do>"
```

On a new memory, recall often returns only the state file or nothing at all. That is normal until lessons exist.
When recall returns nothing, the agent opens `MEMORY.md` instead. Either way, it reads the router's hard rules
that match the task before it starts.

**While you work.** Capture with `node scripts/memory/memory-lesson.mjs new --kind <mistake|practice|observation> --route <family> "<title>"`.
Choose the kind with the installed casebook `scripts/memory/LESSON-KINDS.md`; a person may add
`--takeaway fix|method|know` (models never set it). Recall filters with `--kind` and `--takeaway`;
see the [casebook](docs/LESSON-KINDS.md) and [labelling guide](docs/LABELLING.md) for detail.
Fill the TODO description and why/how body. Metadata routes determine generated index membership; optional
`pin`, `hook` (at most 200 characters), and `supersedes` control the hot page. No count or split is hand-edited.

**At the end, run a checkpoint.** Update the single current-state block, then run
`node scripts/memory/memory-checkpoint.mjs`. It generates hot pages and catalogs, rotates the brain log and
roadmap, refreshes the brain index and roadmap overview, runs the gate, commits the memory repo, and pushes.
A gate FAIL stops the commit; a failed or timed-out push exits 2 and keeps the commit. `--no-push` skips
push; `--dry-run` writes nothing. Capture and checkpoint accept `--today YYYY-MM-DD` for a simulated
lesson date or checkpoint gate/rotation date; the default is today. Commit the project's own changes separately, by name.

**Before you compact or switch agents.** The `## CURRENT` block is the handover. Make it current and push the
memory first. The next session starts from it.

**When the gate fails.** Each finding names the check and the file. Fix the cause, usually by moving detail out
of an oversized file into a new file one layer down. Never raise a pin or an allowlist ceiling to make the gate
pass.

**Check that recall works.** Once you have a few lessons, replace the example probes in
`scripts/memory/recall-probes.json` with questions from your project and the files that should answer them. Each
probe has an `id`, a question `q` and `expect`, the file names recall should return; `minPass` is the share of
probes that must pass.
The example probe is intentionally small; it is not a claim about your recall quality. Then run:

```sh
node scripts/memory/memory-recall.mjs --probe
node scripts/memory/memory-measure.mjs --write first
```

The measure command writes `docs/evidence/memory/<date>-first.json` and `.md` into your project; commit them.
Run `memory-measure.mjs --write <name>` again later and compare the two `.md` files.

**On another computer.** Clone the memory's private remote into the folder the gate expects
(`git clone <PRIVATE_REMOTE> <MEMORY>`), then run the gate. Until the memory is there, the session-start hook
prints `memory gate: memory dir not found; run node scripts/memory/memory-init.mjs` when the kit is installed. Run that command to create a new private memory, or clone an existing private memory before running the gate.

## Update to a new release

Update the kit folder (`git pull`, or `git fetch --tags` and check out the new tag), then from the kit folder:

```sh
node scripts/upgrade.mjs --target <PROJECT> --check
node scripts/upgrade.mjs --target <PROJECT>
```

`--check` exits 0 when the project is current. It exits 1 when an update is available, a kit-owned file was edited
locally, or the check failed; the lines it prints say which. The upgrade backs up to a timestamped folder,
replaces only kit-owned files, and keeps your config, probes, hooks and instruction blocks. If the upgrade causes a
new FAIL, it rolls back. Run the gate afterwards. [UPGRADE](docs/UPGRADE.md) has the details and the restore
command.

## If you already have memory files

A large `MEMORY.md`, journals or one big lessons file can be converted with [CONVERT](docs/CONVERT.md), a scripted
conversion with proofs. Do it in a session of its own.

## More guides

- [STARTER](docs/STARTER.md): this guide in more detail, including where each installed file lives.
- [WHY](WHY.md): the idea behind the ladder.
- [LIMITS](docs/LIMITS.md): what each gate limit protects, how WARN and FAIL work, where old information goes, and where each number came from.
- [CONVERT](docs/CONVERT.md): converting existing memory.
- [UPGRADE](docs/UPGRADE.md): upgrades and recovery.
- [Engine reference](engine/README.md): every command, check and config key.


## Reference

### Where the memory lives

Use `--memory-dir <MEMORY>` for an existing private memory directory. Otherwise
selection is `CLAUDE_MEMORY_DIR`, an existing directory recorded in `KIT.local.json`,
then `<home>/.claude/projects/<absolute-project-path-slug>/memory`. Home is
`USERPROFILE`, then `HOME`; replace every non-alphanumeric path character with `-`.
The git-ignored local record remembers custom paths for later unflagged gates and hooks.
`KIT.json` contains no machine path; missing local directories fall through to the default.

### What install writes

Install writes the engine, two skills, a hash manifest and receipt, merges a
SessionStart, PreToolUse (Bash|PowerShell), and UserPromptSubmit hooks without removing other settings, appends the AGENTS memory gate
once (in `CLAUDE.md` when that is the only instructions file) and creates `CLAUDE.md`
only if absent. Malformed or non-object settings stop before writes; when all kit hooks already exist,
settings bytes remain unchanged, including a UTF-8 BOM. The kit rules file is refreshed and the host rules file
is seeded only when absent. --no-guard persists guard: false in KIT.local.json, preserving memoryDir.
Project config and probes are created only when absent. The starter router, session
index and current-state file are created when no router exists; existing memory
files are preserved. New installs generate hot pages and catalogs; hand-written indexes retain their existing pin rules.
A memory repository with no HEAD gets one baseline commit, including a previously
initialized repository whose first commit failed. Repositories with history get none. If Git has no identity, the baseline alone uses the reported kit identity.
A foreign pre-commit is preserved and reported. Repeat real installation refuses with `already installed (kit X); run scripts/upgrade.mjs --check`
and writes nothing. On an installed project, `--dry-run` prints that guidance and exits 0. Fresh installs refuse differing kit-owned destinations before
writing; `--backup` moves their original bytes into a timestamped
`scripts/memory/.kit-backup-<UTC>/` directory before proceeding. Dry run prints
planned writes without performing them.

Existing memory may have findings beyond the `repo.remote` WARN; read those files and repair the reported
cause before adoption. For an existing brain log or index or a roadmap, run the applicable checkpoint generators
described in the [engine reference](engine/README.md), then the gate.

### Undo

Retain the memory repository and its history. Remove only the kit hook with
`node scripts/memory/install-hooks.mjs --uninstall --memory-dir <MEMORY> --repo <PROJECT>`.
Remove the exact kit SessionStart, PreToolUse guard and UserPromptSubmit clock commands from settings, the installed Memory gate
block if it was newly added, and only installed kit-owned files listed in
`scripts/memory/MANIFEST.json`. Preserve pre-existing instructions, config and probes.
Review against your pre-install diff before removing anything. There is no destructive
uninstaller. Upgrade recovery is described in [UPGRADE](docs/UPGRADE.md).

### Tests

Proofs: `npm test` runs isolated engine, install, conversion, upgrade and kit tests.
Install and conversion tests isolate both home variables and all temporary data.
`tests/install.test.mjs` proves install claims and elapsed time below five minutes;
`tests/kit.test.mjs` proves manifest, encoding, first checkpoint and hook removal;
`tests/convert.test.mjs` proves conversion mechanics; `tests/upgrade.test.mjs` proves
preservation and rollback. Human decisions and semantic review remain human work.

## What runs automatically after install

Install itself runs git init if needed, git add . and git commit in a memory folder with no commit, the gate, install-hooks.mjs, and brain-index.mjs --write when brain/00-system/ exists and projectConfig.caps?.brainIndex is truthy.
The SessionStart hook command `node "${CLAUDE_PROJECT_DIR:-.}/scripts/memory/memory-check.mjs" --session-start` runs the project's own installed copy at every Claude Code session start.
The memory repository's pre-commit hook runs `node "<PROJECT>/scripts/memory/memory-check.mjs" --hook --scope memory --memory-dir "<MEMORY>"` from the project at every memory commit (the placeholders are absolute, shell-quoted paths).
Claude Code also runs PreToolUse command guard and UserPromptSubmit clock hooks unless guard installation was skipped; the engine makes no network calls.
The guard commands are `node "${CLAUDE_PROJECT_DIR:-.}/scripts/memory/memory-guard.mjs" pretooluse` and `node "${CLAUDE_PROJECT_DIR:-.}/scripts/memory/memory-guard.mjs" prompt`.
Installation refreshes scripts/memory/enforce-rules.kit.json and seeds host-owned scripts/memory/enforce-rules.json only when absent; starter rules warn.
The gate uses `scripts/memory/MANIFEST.json` to report edited kit files.
Details are in [SECURITY.md](SECURITY.md).

## Fleet and upgrade decisions

```sh
node engine/memory-fleet.mjs --root <PROJECTS> --exclude <PATTERN> --json
node scripts/memory/memory-measure.mjs --write checkpoint
```

Fleet status is read-only. The deferred-upgrade ledger supplies project TRIGGERS and FLEET TRIGGERS; see [engine commands](engine/README.md#fleet-status).

Existing projects: see [safe installation](docs/STARTER.md#installing-into-an-existing-project-safely) for index preservation, in-repo memory refusal, skill mirrors, host tooling excludes, worktree memory and the file-change report.



## Memory inside the repo

Use a dedicated folder such as `memory/` or `.claude/memory/`:

`node scripts/install.mjs --target <PROJECT> --memory-dir <PROJECT>/memory`

Install records `memory.inRepoDir` in the tracked `scripts/memory/memory.config.json`.
Commit that configuration with the project using its normal branch rules. Every clone and
worktree resolves the relative folder against its own checkout. Resolution order is
`--memory-dir`, `CLAUDE_MEMORY_DIR`, `memory.inRepoDir`, `KIT.local.json`, then the slug default.
Install creates no nested Git repo and makes no baseline commit in this mode.

The project pre-commit hook gates staged memory only (`--hook --scope memory`). If a hook
already exists or `core.hooksPath` is configured, install leaves it alone and prints the exact
line to add from the repo root. The gate retains content checks and committed-age checks;
it skips memory-repo remote, ahead and dirty checks and says `in-repo memory` in its summary.

Checkpoint regenerates, rotates and gates, then prints `git add -- <paths>` and a suggested
commit message. It does not commit by default. Explicit `--commit` commits only the listed
paths on the current branch, preserving unrelated staged changes. It never pushes in this
mode. Follow the host's branch policy, including when another agent shares the branch.
Upgrade, SessionStart and recall use the same resolver; fleet reports `in-repo` status.

A root `MEMORY.md` layout must first undergo the separate, copy-first conversion in
[Move root memory into a dedicated folder](docs/CONVERT.md#move-root-memory-into-a-dedicated-folder).

### Capture, repeats, repair and labels

Choose the kind using the installed `scripts/memory/LESSON-KINDS.md` casebook. Capture with
`node scripts/memory/memory-lesson.mjs new --kind <mistake|practice|observation> --route <family> "<title>"`;
optionally add `--case Kn` for an installed case id. List lessons carrying that case with
`node scripts/memory/memory-lesson.mjs classify --case Kn`.
A person may add `--takeaway fix|method|know` to capture; models never set it. These mean an error
and its remedy, a best method or next-time action, and how something works, respectively.
Recall displays these labels and filters with `--kind` and `--takeaway`.

Follow the [labelling guide](docs/LABELLING.md) for two independent labellers, then run
`node scripts/memory/memory-lesson.mjs classify --score A.json B.json`. The kind test allows
at most 6 of 40 disagreements, scaled down with `floor(rows * 6 / 40)`, and prints
`kind test: PASS` or `kind test: FAIL`; empty or unequal row sets fail. Reports exit 0 even
for FAIL, so read the verdict. Person-set takeaways are not a kind reference.
After review, preview `node scripts/memory/memory-lesson.mjs classify settled.json`, then add
`--write`; the file holds settled `kinds`, optional `cases`, and person-set `takeaways` maps.
See the [casebook](docs/LESSON-KINDS.md) for decisions and case ids.

Capture several filled lessons with `node scripts/memory/memory-lesson.mjs batch <scratch>/lessons.md`;
keep the batch outside memory and include a `kind` for every lesson, with optional `case` and person-set `takeaway`.
Record recurrence with `node scripts/memory/memory-lesson.mjs repeat <id> "slip: <note>"`,
then decide with `node scripts/memory/memory-lesson.mjs enforce <id> "<hook|check|hard-rule|lesson-only> <where>"`.
For `chars.*`, preview `node scripts/memory/memory-chars.mjs repair`, allow deliberate examples, then add `--write`;
fix report-only residues by hand. `router.lines` warns above 150 and fails above 200: move detail down a layer.
The skills explain kinds, four repeat causes, classification, guard replay and chain repair.
