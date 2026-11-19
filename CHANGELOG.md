# Changelog

## 3.3.10

**A handover now says whether it is safe to compact by one definition, and proves it from the files it wrote: memory is updated, learning is added, and the roadmap holds the current state. A full handover needs a new input, `roadmap`; without it the verdict is NOT SAFE. A lesson can be saved at once as a draft and finished later. 3.3.10 adds two gate checks, `lesson.draft` and `lesson.draft-text`, which cannot fire before a project's first draft lesson, and widens none.**

- Upgrade from 3.3.9 with `node scripts/upgrade.mjs --target <PROJECT> --check`, then, from the project's main checkout, `node scripts/upgrade.mjs --target <PROJECT> --live-memory`. Run the installed gate afterwards.
- A project's own skill or script that builds a handover input must now pass `roadmap`, and one that looks for the words "NOT SAFE" to detect a failed handover must use the exit status instead; both changes are described below. `git grep -n "handover.mjs"` in the project finds such files. Update them after the update.

Safe to compact

- Safe to compact has one definition, the same in a handover's last line, in the handover skill and in the Reports line of the standard block: memory is updated, learning is added (lessons written, saved as a draft to finish later, or stated as none), and the roadmap holds the current state (the run updated it, or names the line that already holds it). A commit or a push is not one of the three. The standard block changes one line, the Reports line, to say so. A project rule in `## Project rules` that contradicts it stays and is the project's to reconcile.
- A full handover needs a new input, `roadmap: "updated (<words>)"`, with words copied from the roadmap line the run added. When nothing needed adding, the input says `roadmap: "nothing new (<words>)"`, with words copied from the line that already holds the state. The words must be on one line of the roadmap when the handover ends, and a quote under 20 characters must be the whole line. A handover input without `roadmap` is NOT SAFE, and so is saying nothing about the roadmap.
- A handover writes no new kind of file. The note gains one field, `Roadmap`, that records the statement.
- The report can end with two lines: `NOT FINISHED - ...` and the verdict. A commit the gate stopped, a failed push, a failed close check and a stale brain log no longer turn the verdict to NOT SAFE. They still give a non-zero exit status and must be fixed before the session ends, with the command the next-step line names, not with a second handover. A full handover no longer fails on an uncommitted roadmap or log when memory is outside the project. The `close:` line of the session overlay template now says the same: a missing step refuses the save, a failed one ends NOT FINISHED.
- A handover that is refused before it writes anything now ends `SAVE REFUSED - ...` instead of `NOT SAFE TO COMPACT - ...`. The exit status is non-zero as before. A project script that looks for the words "NOT SAFE" to detect a failed handover must use the exit status.
- A handover now proves from disk what it was asked to save: the note, the state block, what the lesson batch wrote or the draft it saved, and the roadmap line it quoted. Anything missing or different at the end gives NOT SAFE, whatever happened to the commit. A lesson that a retry names in `none (already written: <files>)` is checked for being on disk and for its form, not for its words (see Known limits).
- A lesson file that is empty, unfilled, or a draft without its text gives NOT SAFE on every full handover, and on every quick handover given lessons, until someone acts on the file, unless the project's gate allows that finding or another session has claimed the file. Each of these is already a gate FAIL (or a new check on a draft), so no handover that is SAFE today becomes NOT SAFE by it.
- A quick handover says SAFE only when it was given both the lessons and the roadmap statement; otherwise it says `STATE SAVED (quick)` and names what it did not check. Given a statement that does not hold, it now says NOT SAFE and exits non-zero.
- Roadmap rotation is unchanged.

Lessons

- A lesson can be saved now and finished later: `lessons: "later (<what happened and the rule you would write>)"` in a handover input, or at any moment `node scripts/memory/memory-lesson.mjs draft "<text>"`. The text is at least 40 characters and 6 words. Either writes a draft lesson file at once, with a `draft:` line under its metadata and the text under `**Draft:**`. Saving the same text again makes no second file while a lesson file still holds that text under `**Draft:**`; once that paragraph is deleted, the same text makes a new draft.
- Every session start lists the drafts first, a SAFE handover counts them in its last line while any remain (`draft lessons to finish: <n>`), and the gate gives one WARN (`lesson.draft`) per draft. A draft is finished by editing its file: fill Why and How to apply, correct the title, description, kind and route, and delete the `draft:` line. The gate warns until then.
- The lesson tool now replaces an existing lesson file by an atomic rename, and gives a new lesson its name only when its content is complete, so a failed write never leaves part of a lesson. A failed lesson batch now prints how to run it again. The batch and the retry after a failed handover otherwise work as in 3.3.9 (`none (already written: <files>)`). A recurrence can be recorded twice after a failed batch (see Known limits).

Session start

- When the start does not use a hand-written `current-state.md` block that has content, it now says so in one line: `state block not used: it has no **Branch:** line; add "**Branch:** <branch>" to current-state.md (a handover writes it)`, or `state block not used: it is for <branch>`, or, when the block is for this branch, has no valid time stamp and a hand-over note exists, `state block not used: it has no time stamp, so the hand-over note of <HH:MM> leads; start the block with "**YYYY-MM-DD HH:MM:SS | @<sha> | full. <state>**" (a handover writes it)`. The starter `current-state.md` template names both lines; it is copied on a fresh install only, and an update does not rewrite an existing file.
- `new-session.mjs dispatch` now answers the exact messages `/new-session`, `/handover` and `/handover quick`, which the standard block tells an agent to run it for. Any other message that starts with `/new-session` or `/handover` gets the usage line `dispatch: use /new-session, /handover or /handover quick`. The prompt hook is unchanged: it still ignores every slash message, because Claude Code runs the skill itself.
- `current-state.md` stamps gain seconds at the next handover: `**YYYY-MM-DD HH:MM:SS | @<sha> | full. <state>**`. A stamp without seconds is still read, and nothing rewrites an old stamp. A project skill that writes the stamp itself keeps working with minute stamps; whether it moves to seconds is each project's own follow-up. A stamp with seconds leads when its time is equal to or later than the newest note's time, and a stamp without seconds leads when its minute is equal to or later than the note's minute.

The update

- When an old instruction line that the update cannot classify begins with whole sentences of a line the kit shipped, the preview prints one note under its UNCLEAR line: `note: <id> begins with <n> sentence(s) of a kit line (<versions>); "keep" copies the whole unit, kit sentences included; edit ## Project rules after the update`. The line is still kept or dropped whole, as decided.
- The preview (`--check` and `--dry-run`) prints the undo snapshot's size before its summary: `UNDO SNAPSHOT <n> files, <size> MB to <folder> (<free> GB free)`, worked out from a listing alone, with nothing copied. When the size is more than the free space the line ends `- NOT ENOUGH SPACE` and the preview exits non-zero. When the update refused before it worked out a plan, the summary reads `planned writes: not computed (<reason>)` instead of zeros, and the snapshot line says `not computed` too.

Documentation

- The README, the glossary, the engine reference and docs/HOW-IT-WORKS.md describe the handover, draft lesson and session start changes above. In docs/LIMITS.md the sentence about where its KB figures came from now reads "Example figures given in KB are invented examples."

Gate checks

- New checks: `lesson.draft` (WARN, one per draft lesson) and `lesson.draft-text` (FAIL: a draft whose date is not a date, or whose `**Draft:**` text is missing or under 40 characters). Neither can fire before a project's first draft lesson. No check for an empty lesson file is added: an empty lesson file already fails the existing checks. A lesson file with a `draft:` line is not reported by `lesson.unfilled-body`, because its empty prompts are the point of a draft.
- Widened checks: none. A memory with no draft lesson gets the same findings as under 3.3.9: the gate's source differs from 3.3.9's only in the code for a lesson file that has a `draft:` line.

Maintainers

- The kit's own export refuses a repository name made only of dots (the names `.` and `..`), which is a path step and not a repository. Its wording check now also reads code, not only titles and prose: a review-round label written as one word is refused in a string, a regular expression or a comment, and so is a path with a segment that starts with one. Both run only in the kit's own export; installed projects are unaffected.
- The kit's own export runs up to 6 public test files at once (was 4) on a machine with 7 or more processors; the fixed time limit of its test gate is unchanged.

Known limits

- The finish lines a handover prints and the push hint the checkpoint prints when a push fails name `git -C <folder> push`. That command runs in your own shell, not under the kit's clean git environment: run it where no git redirect variable (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_NAMESPACE`, injected configuration) is set, and never inside a git hook. The checkpoint's hint (3.3.9 and earlier) is also unquoted. A later release is meant to give both one quoted, clean-environment push entry point.
- The kit's own export can run its public test gate close to the gate's fixed time limit when the machine is busy. The limit is not raised: a run that reaches it fails, and the export is run again when the machine is quieter. Installed projects are unaffected.
- `lessons: none (...)` is taken on the agent's word, and so is the choice of words in a roadmap statement. The handover proves that the quoted words are on a line of the roadmap. It cannot prove that the line is complete or says the right thing, and a filler line that is quoted passes. Words that are also on an older line are found there.
- The verdict is a statement about the disk at the moment the run ends, for what the run was given. A file changed from outside the handover after that moment can undo saved knowledge without a NOT SAFE being printed. A file changed from outside between two attempts is seen only if the damage shows in its form (empty, unfilled, a draft without its text): a lesson cut short but well formed, or a recurrence entry reverted, and then named in `already written`, is believed.
- After a failed rollback, or a retry of a batch whose recurrence was already written, the same recurrence entry can stand twice in a lesson. No knowledge is lost, but it counts twice toward the repeat thresholds until one line is deleted by hand.
- A new lesson is published with a hard link. On a file system that refuses hard links the lesson tool stops with that reason and writes nothing.
- A draft's text is checked for length only, and finishing a draft is checked by form (both prompts filled, no `draft:` line), not by what the lesson says. A draft gets the kind `observation` and the first family of the routing table until whoever finishes it corrects them. `lesson.draft` is one WARN per draft, so a project that keeps the gate at zero warnings sees it until the draft is finished.
- A quoted roadmap line that the run's own rotation moves to the history file gives NOT SAFE: quote a line of a newer block, or save again.
- A hand-written state block still does not lead without a Branch line, or against a note when it has no stamp; the start now says so. Only the three exact slash forms are answered by `dispatch`. A stamp without seconds (an old one, a hand-written one, or one from a project's own skill) ties by minute, so a note written later in the same minute loses to it.
- An old instruction line that a project edited is still one whole unit. Keeping it repeats its kit sentences in `## Project rules` until someone edits that section by hand; the preview's note says so. The snapshot size in the preview is a sum taken at preview time, and the snapshot the real run takes can differ if files change in between.

## 3.3.9

**A project can list its own check commands in `caps.checkpoint.checks`, and every memory save then runs them after the save and its push: a failing check makes a finished save end with status 1 and keeps every saved change. 3.3.9 adds no gate check and widens one: `config.caps` now fails a malformed `caps.checkpoint.checks`.**

- Upgrade from 3.3.8 with `node scripts/upgrade.mjs --target <PROJECT> --check`, then, from the project's main checkout, `node scripts/upgrade.mjs --target <PROJECT> --live-memory`. Run the installed gate afterwards.

Changed behaviour

- A project may list its own check commands in `caps.checkpoint.checks` in `scripts/memory/memory.config.json`: at most 20 entries, each `{"name": ..., "argv": [...]}`. Every save (`memory-checkpoint.mjs`, and therefore the save of a handover) runs them one at a time in the project root after the save and its push, with git's redirect variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and the like) removed from their environment. Each check prints `checks: <name> ok` or `checks: <name> FAIL (<reason>)`, and the save ends with `checks: <passed> of <total> passed`. The README and the GLOSSARY entry `caps.checkpoint.checks` give the rules: names, `node` as the first word, no shell, the 300 s and 16 MiB limits.
- A failing check makes a finished save end with status 1 and `project checks failed: <names>`, and keeps every saved change and commit; a push failure keeps status 2. The checks are skipped, with one `checks: skipped (...)` line, when the save did not finish or a release of a lock it took could not be confirmed. In an in-repository handover a failing check stops the project push that follows the save.
- A malformed list refuses the save before it writes anything. Nothing changes for a project without the key, or with an empty list: its save prints and returns what it did in 3.3.8.

Documentation

- Test titles, comments and the lesson-conversion guide say what they guard in plain words; 13 test files are renamed for what they test.

Gate checks

- New checks: none.
- Widened checks: `config.caps` now FAILs a malformed `caps.checkpoint.checks` (not a list, more than 20 entries, or an entry that is not exactly a `name` and an `argv`), with the list's own message. A 3.3.8 project whose configuration already holds such a value, which 3.3.8 ignored, has its update rolled back as a new FAIL: correct or remove the value, then update. A valid list and an empty list are kept, with the same values in the same order, and an absent key stays absent. As in every update, `memory.config.json` is written again in two-space JSON, so the layout of the file can change. [docs/UPGRADE.md](docs/UPGRADE.md), "Checks a release widens", lists it.

Maintainers

- The kit's own export refuses review-round, fix-round, stage and lane labels, notes on how a test was first run, and test files named for a review or fix round, in the files it ships. It runs only in the kit's own export; installed projects are unaffected.

## 3.3.8

**An update that performs the scope inventory on a git project now refuses an empty or relative home folder on every platform, naming the variable: `upgrade: cannot establish the git input HOME (...); nothing written`. The shipped text no longer carries private process wording. 3.3.8 adds no gate check and widens none of the gate's checks.**

- Upgrade from 3.3.7 with `node scripts/upgrade.mjs --target <PROJECT> --check`, then, from the project's main checkout, `node scripts/upgrade.mjs --target <PROJECT> --live-memory`. Run the installed gate afterwards.

Changed behaviour

- The home folder is checked whenever the scope inventory runs. A real update of a git project that performs the scope inventory refuses an empty or relative `HOME` (or `USERPROFILE`, the fallback when `HOME` is unset) on every platform, also when git would not read the home folder: before 3.3.8 a set `XDG_CONFIG_HOME`, `core.excludesFile` or `GIT_CONFIG_GLOBAL` could let such a value through. A fresh install, a `--check` preview and a project that is not a git repository do not run that inventory and are unchanged. The update refuses before any change to the project or its memory folder: set the variable to a full path and run it again.
- The standard block's session-phrases line and reports line no longer end with a dated owner note. An update from 3.3.4, 3.3.5, 3.3.6 or 3.3.7 recognises the block those releases wrote as unedited and replaces it with the new lines, with no `standard block differs from kit` warning and no `edit-inside-block` entry in the report. A block with an edit inside it is still warned about; text added or changed inside it is also reported as an `edit-inside-block` entry, and a deleted line is warned about without an entry.

Documentation

- The figures in [WHY](WHY.md), [docs/LIMITS.md](docs/LIMITS.md) and the lesson-conversion guide are invented examples, not measurements, and say so: the README and WHY read "invented examples; not performance guarantees". Real sizes, counts and event dates are gone from the shipped documents, and the Claude Code memory link in LIMITS no longer carries a check date.
- Comments and test titles in the shipped engine, scripts and tests describe what the code or the test guards in plain words. No behaviour changed with them.

Gate checks

- New checks: none.
- Widened checks: none of the gate's checks. The update's own home-folder check widens, as described above; it is a refusal by the update, not a gate check, so the gate reports the same findings as before. [docs/UPGRADE.md](docs/UPGRADE.md), "Checks a release widens", lists it.

Maintainers

- The kit's own export refuses private process wording in the files it ships: internal decision ids, working labels, dated owner notes, real measurements and real event dates. It runs only in the kit's own export; installed projects are unaffected.
- The kit's own tests run on Linux: a workflow in the kit's development repository runs them for pushed `linux/**` work branches. The workflow is not part of the public export.

## 3.3.7

**A file the update cannot read is named once: `upgrade: cannot read <file> (not a regular file)`, not `upgrade: cannot read <file>: cannot read <file> (not a regular file)`. 3.3.7 adds no gate check and widens none.**

- Upgrade from 3.3.6 with `node scripts/upgrade.mjs --target <PROJECT> --check`, then, from the project's main checkout, `node scripts/upgrade.mjs --target <PROJECT> --live-memory`. Run the installed gate afterwards.

Changed behaviour

- A file that cannot be read is named once. A fifo, socket or device at `scripts/memory/memory.config.json` made the update print the file's name twice (`upgrade: cannot read <file>: cannot read <file> (not a regular file)`); it now prints `upgrade: cannot read <file> (not a regular file)`. A missing file or a folder in the same place is likewise named once, and a reason that follows the name (invalid JSON, `expected an object`) is unchanged.

Documentation

- The 3.3.6 entry carries a correction: 3.3.6 also widened an existing check, `hardrule.size`. [docs/UPGRADE.md](docs/UPGRADE.md), "Checks a release widens", says what widening means, lists it, and gives a check to run on a copy of the memory before updating: an update from 3.3.5 or older whose `[[wikilinked]]` hard-rule card is over 4096 bytes fails the new gate and restores itself.

Gate checks

- New checks: none.
- Widened checks: none.

Maintainers

- The kit's own `npm test` runs the public test files once, through the export's test gate, and the other test files directly. The public package's `npm test` is unchanged.

## 3.3.6

**An all-sessions checkpoint with in-repository memory and `--commit` excludes already-modified output groups from its commit. It still rewrites those outputs. Dry runs can identify modified project outputs before you proceed.**

- Upgrade from 3.3.5 with `node scripts/upgrade.mjs --target <PROJECT> --check`, then, from the project's main checkout, `node scripts/upgrade.mjs --target <PROJECT> --live-memory`. Run the installed gate afterwards.
- Update planning now checks the memory hook and planned destinations before reading them, refusing a fifo, socket or device found at that check. A file replaced with a special file between the check and the read can still make the read wait; see Known limits in UPGRADE.

Changed behaviour

- A link at a generated page (`INDEX-*.md`) that leads to a file the kit does not generate is refused (item 1). A link to a marked generated page is still updated.
- A same-version run exits 1 when a stale or obsolete generated page fails the replay's replacement checks, including an unmarked stub at that destination. A pending route migration without that refusal still exits 3 and prints the replay command.
- The preview and `restore --check` name the claims, downgrade and restore-output refusals, and exit 1 when one applies (item 12b).
- A restore refuses a fifo, socket or device at any destination, with one message (item 7).
- The gate reports WARNs instead of reading special files at its checked repository inputs. Those WARNs alone do not stop a checkpoint. A checkpoint refuses a special file when its own checked read or output write encounters it; in session mode, memory may already have been committed.
- Outside the gate's actual hook path, the kit's Git calls ignore `GIT_NAMESPACE`, `GIT_CONFIG` and the four pathspec-mode variables. The read-only commands also discard inherited repository redirects. Combining `--hook` with `--session-start` now uses session-start behavior, including the cleaned Git environment and ahead-of-upstream check.
- Scratch space must be outside both the project and memory folder, including after resolving links. The check uses Node's effective system temporary directory. Real checkpoints check before starting; updates check before creating required scratch space. An all-sessions checkpoint dry run that fails this check prints `would change: could not be planned (...)` but still exits 0. Set the temporary-directory environment variables to an outside folder before retrying.
- Outside instruction files are compared by digest, not copied (item 23).
- In all-sessions mode, `--commit` with memory inside the project asks Git about three output groups before writing: the brain log and its archives; the roadmap, its history and its enabled overview; and the brain index with index-all. A group Git reports as modified is excluded from the commit, but its outputs are still rewritten. If any status query fails, all three groups are excluded. When the commit step completes and excluded groups have written outputs, `commit: left out ...` names those outputs and the reason. Matching has the limits listed in UPGRADE.
- A dry run can name planned project outputs that Git reports as already modified. It omits the `already modified` line if any status query fails, so silence does not mean those files are clean (item 24).
- Restore skips memory lock paths even when their names include `./` or subfolders. Promotion rehearsals skip memory lock names, including tracked locks, except for the junction case documented in UPGRADE.
- `/new-session` reports both the operation lock and `.memory.lock.push`. Handover timeout reports name each existing lock and its age. Checkpoint change reports recognize lock names without regard to case; the obsolete `.memory.push.lock` name is treated as an ordinary file.
- Failed cleanup of update snapshots, install audit folders, promotion rehearsals and stale-lock files now names what remains without replacing the operation's result. A failed atomic log write preserves its original error and reports a temporary file it could not remove.
- Initial memory setup checks both author and committer identities before choosing its fallback identity.
- Checkpoint file reports now record outputs at the writer, fixing reports that included another writer's changes or missed newly appearing outputs. Dry-run planning accounts for configured non-Markdown system files.
- When checkpoint folder resolution fails without `--repo`, the command prints its header and the underlying error instead of `repoRoot is not defined`.
- In-repository checkpoint staging lists include a generated roadmap overview even when rotation is skipped. Explicit `--commit` treats included paths literally, including names containing glob characters.
- Update planning checks named configuration, instruction, decision and ledger files before reading special files. Instruction-folder listing order no longer causes false planning drift.
- Cards reached through wikilinks under `## Hard rules` are classified as hard rules rather than ordinary topics.

Known limits in 3.3.6 are listed in [docs/UPGRADE.md](docs/UPGRADE.md).

Correction: 3.3.6 also widens an existing check. `hardrule.size` (FAIL over 4096 bytes, WARN over 2048) now covers a card reached through a `[[wikilink]]` under the router's `## Hard rules`; before 3.3.6 only a card reached through a Markdown link was a hard rule. An update from 3.3.5 or older whose linked card is over 4096 bytes fails the new gate and restores itself (`new FAIL: hardrule.size <card>`). To fix it, move the card's detail into another file first, writing the new file before shortening the card, then run the update again. [docs/UPGRADE.md](docs/UPGRADE.md), "Checks a release widens", gives a check to run before updating.

## 3.3.5

**Every checkpoint run now prints a first line, `checkpoint: repo <checkout>; memory <folder> (<source>)`, and a run against memory outside the project repo ends with `repo files changed in <checkout>: <files> - commit them in that checkout` (or `none`), except in a dry run, which prints `would change: ...` instead.** Scripts that parse checkpoint output must allow both lines. With no `caps.checkpoint.mode`, or with `"all"`, a checkpoint commits what 3.3.4 committed: session mode is opt-in.

- Upgrade from 3.3.4 or 3.3.3 with `node scripts/upgrade.mjs --target <PROJECT> --check`, then, from the project's main checkout, `node scripts/upgrade.mjs --target <PROJECT> --live-memory`. Run the installed gate afterwards. The update sets `engine_version` to 3.3.5 in `scripts/memory/memory.config.json` and adds any missing default, keeping every value already set; from 3.3.4 or 3.3.3 that adds three: `caps.checkpoint` (`{"mode": "all"}`), `caps.index.hotReserveBytes` (1024) and `caps.router.targetBytes` (11264). What a checkpoint commits is unchanged unless `caps.checkpoint.mode` is `"session"`.
- This release includes the 3.3.4 fix that compares the files an update's instructions reach with the plan's prediction.

Checkpoint output

- `<source>` in the first line says where the memory folder came from: `--memory-dir`, `CLAUDE_MEMORY_DIR`, `memory.inRepoDir`, `KIT.local.json` or `default`. The closing line lists the project files the run changed and left uncommitted. The first line also appears for a refused run, and so does the closing line when the memory folder is known and the run is not a dry run.
- `--dry-run` that reaches its plan prints `would change: <files>` (or `nothing`): the memory and project files a real run would change. In the default mode the plan is made with the real writers on private copies, so nothing in memory or the project is written, locked or removed; a plan that cannot be made prints `would change: could not be planned (...)`. A dry run commits and pushes nothing.
- A checkpoint now refuses a bare option it does not know (`unknown option ...`) and any extra word, with exit 1; 3.3.4 ignored both. An option written `--name=value` was already refused. New options: `--session`, `--all`, `--files`, `--take`, `--files-only`, `--memory-only` and `--no-rotate`.

Session mode and claims (opt-in)

- With `caps.checkpoint.mode` set to `"session"`, or `--session` for one run, a checkpoint commits only the memory files this session has claimed, files named with `--files` or `--take`, and the generated pages those changes affect. It never commits another session's edits and does no rotation (log, roadmap or hand-overs). A session is one checkout on one branch; a detached HEAD is refused, and so is a memory repository with no commit yet.
- `--files`, `--take`, `--files-only` and `--memory-only` need session mode. `--files <file>...` claims and saves named files; `--take <file>...` saves files another live session claims and takes the claim over, with the file as it is in the shared folder. `--files-only` saves only the named files and leaves other claims for later; with nothing selected it only publishes. `--memory-only` saves memory and defers the brain index and roadmap overview; it also needs memory outside the project repo. `--all` runs the all-pending save of 3.3.4 for one run, and cannot be combined with `--session`. `--no-rotate` skips the log, roadmap and hand-over rotations for one run.
- `memory-session.mjs` has `claim <file>...`, `list`, `release <file>...` and `prune [--apply]`. Claims are kept per session in the memory folder's `.sessions/` folder, which ignores itself. `claim` refuses a file another live session holds. `list` shows this session's claims and every other live, stale, malformed or unreadable ledger. `prune --apply` moves stale ledgers to `.sessions/stale/`. A ledger that cannot be read makes claims and saves refuse until it is repaired.
- In session mode `memory-lesson.mjs`, `memory-chars.mjs`, `memory-chains.mjs`, `memory-migrate.mjs`, `memory-promote.mjs` and `/handover` claim the files they write. If another live session holds `current-state.md`, `/handover` writes only its own note and says so.
- `memory-init.mjs`, `memory-setup.mjs`, hand-over rotation and a live update refuse while another session's ledger holds unresolved claims. In the default mode a checkpoint skips rotation with `rotation waits: ...` while another session's claims are pending.
- `/handover` now writes a `**Branch:**` line into the current block of `current-state.md`. `/new-session` reads only the current branch's hand-over notes, and `current-state.md` leads only when its `**Branch:**` line names the current branch, so a `current-state.md` written by 3.3.4 or earlier supplies no lead until the next hand-over rewrites it. With no note for the branch it prints `no hand-over note for <branch>` and up to two notes from other branches, marked not picked. `handover.mjs` accepts `--no-rotate`.

Push and locks

- A checkpoint's push runs after the memory lock is released, under a separate push lock, `.memory.lock.push`. The existing `.memory.lock*` line in the memory folder's `.gitignore` covers it, so the update adds no ignore line. The push never forces: it then checks the real remote branch, and when the saved commit is not there the run reports the publication error and exits 2.
- `upgrade.mjs --live-memory` (a full update, a `--memory-only` replay or a `--restore`) is exclusive maintenance. It holds the push lock together with the memory lock and refuses after a short wait when the push lock is held, and it writes nothing while any live, malformed or unreadable session ledger holds unresolved claims. A rehearsal with `--memory-dir <copy>` is not checked for claims. Backup, restore and the protected-scope comparison leave out both lock files.
- The update, a restore and the standalone `memory-index.mjs` replace or remove a generated page only when its working copy and its staged copy carry the generated marker; a page without it is refused (the route migration still converts hand-written index pages). `memory-index.mjs` applies all its outputs as one step that is undone if a write fails. Git calls of the session tools and the update drop `GIT_DIR`, `GIT_WORK_TREE` and the other redirecting git variables.

New gate checks (all WARN only: they never block a commit or fail an update)

- `repo.roadmap-no-rotation`: the roadmap is over `caps.roadmap.warnBytes` and rotation, planned without writes, has nothing it may move. `docs/ROADMAPS.md` lists what to do instead; the optional `caps.roadmap.procedure` names your own procedure in the message.
- `repo.roadmap-rotation`: rotation refuses its input, for example `caps.roadmap.keepBlocks` below two, a block with an impossible date or a history path that is not a regular file.
- `config.roadmap-procedure`: `caps.roadmap.procedure` is present but not a non-empty string; it is ignored.
- `index.hot-reserve`: a generated hot page has fewer than `caps.index.hotReserveBytes` bytes free before the newest lessons fill it.
- `router.target`: the router is over `caps.router.targetBytes` (11264 bytes) and not yet over the 12288-byte warning line.
- The roadmap overview freshness check reads CRLF as LF, so line endings alone no longer make an overview stale.

### Known limits

- A generated index page (`INDEX-*.md`) that is a link to a hand-written file inside memory is read as a missing page, so an update or a restore can write generated text through the link over that file. The kit never makes such a link.
- A restore skips lock files only when `restore.json` lists them by plain name; a hand-edited entry with a folder or `./` in front is restored or deleted like any other file.
- `memory-check.mjs --hook --session-start` (both flags together) lets the session-start summary follow an inherited `GIT_DIR` or `GIT_WORK_TREE` and skip the ahead-of-upstream check. The kit's own setting passes `--session-start` alone.
- The checkpoint's `repo files changed` line can be wrong in two rare timing cases: an all-sessions run with no brain folder and the overview off can name a file another writer changed meanwhile, and a session-mode run can miss a file it created when the brain folder appears between its planning and writing steps.
- A dry run makes its scratch copy under the system temporary folder; if `TEMP` or `TMP` points inside the checkout or the memory folder, the copy is written there.
- The dry run's copy holds markdown files only, so a brain index that depends on another kind of file can be listed as `would change` when the real run changes nothing.
- When an atomic write fails and its temporary file cannot be removed either, the leftover `*.tmp` file is not named in the files line.
- When the folders cannot be resolved and no `--repo` is given, the checkpoint stops with `repoRoot is not defined` instead of its own message; pass `--repo`.
- Still open from 3.3.4: a fifo, socket or other special file at the memory hook path or at a planned destination can make update planning wait on a read before the refusal is reached. Nothing is written.
- An unchanged instruction file that two `.claude/rules` links reach can be reported as "changed while planning" when the folder's listing order changes between the plan and the lock. Nothing is written; run the update again.
- Git's own input files (its ignore and configuration files) are chosen from the disk before the writes, so a planned change to which of them git reads is not predicted. If the files git reads after the writes differ from the prediction, the update refuses, undoes its changes as for any unplanned change, and exits 1.
- The instruction walk can follow an absolute or `../` mention to a file outside the project. A file outside both the project and the memory folder is only read and copied into the temporary snapshot; the update never writes or restores it. A mention that resolves into the memory folder is protected and restored like any other memory file.

## 3.3.4

**An upgrade that writes live memory now needs `--live-memory`.** Scripts that call `upgrade.mjs` must add the flag (or pass `--memory-dir <copy>` to rehearse on a copy). Without it the update writes nothing and exits 1.

- Upgrade from 3.3.3 with `node scripts/upgrade.mjs --target <PROJECT> --check`, then, from the project's main checkout, `node scripts/upgrade.mjs --target <PROJECT> --live-memory`. Run the installed gate afterwards.

Safe updates

- `upgrade.mjs --check` and `--dry-run` print a `planned writes` block before the version line: every project file, the backup folder, every memory file and the memory hook the run would write or delete, with counts. A route migration is computed on a temporary copy that is deleted before the preview exits. Exit 1 means something is planned.
- A real update or `--restore` that would write live memory or its hook needs `--live-memory`. Every destination is resolved through links and junctions first; a destination that resolves into live memory (or outside the folder you rehearse in), a path that cannot be resolved and a file with other hard links are refused before any write.
- Only planned operations run, with the planned bytes; unchanged files are not rewritten. The plan is made again under the memory lock, and if any input changed meanwhile nothing is written and the update exits 1. `--restore` is planned again the same way and can be previewed with `--check`.
- The memory hook is never pointed at a linked worktree: `--live-memory` from a worktree is refused, `install-hooks.mjs` refuses `--repo <worktree>`, and an install into a worktree finishes without a hook and prints the command to run from the main checkout.
- Before the first write the update copies its protected scope (the git-visible project files, kit and host configuration, planned destinations and the whole memory folder), compares it with the plan afterwards and restores from the copy on any difference. States a rollback would overwrite are kept under `<backup>/unplanned/` with a manifest. A special file (fifo, socket or device) in that scope is refused before anything reads it, except at the memory hook path and at planned destinations (see Known limits). Git calls drop `GIT_DIR` and the other git environment variables, and the gate runs with `GIT_OPTIONAL_LOCKS=0`.
- An update whose instructions reach a kit document no longer rolls back when the kit's documents mention new `.md` names: the update compares the files its instructions reach after the writes with the files its plan predicted, not with the files before the writes.
- A same-version run with stale memory (a pending route migration, stale or obsolete generated pages) writes nothing, exits 3 and prints the replay command; `--memory-only --live-memory` runs only the memory steps, with a backup and the gate before and after. A same-version run with nothing pending still ends with `upgrade: same version and hashes; no-op`.

Standard block

- `AGENTS.md` carries one kit-owned block between `<!-- kit standard block (memory kit <version>): begin. ... -->` and `<!-- kit standard block: end -->`. Install and every update write the kit's text there. Rules for one project go under `## Project rules`, which the kit never edits. `CLAUDE.md` gets a block holding only the `@AGENTS.md` import when `AGENTS.md` exists.
- The first update of a file without the markers sorts its old memory section unit by unit. Kit wording, as any release shipped it, is replaced by the block; a unit with a keep decision moves word for word into Project rules; a drop decision removes it; any other unit is unclear and stops the update until decided. `node scripts/instructions-sort.mjs preview --target <PROJECT> --out <FOLDER>` writes `sort-report.json` and `decisions.json` outside the project; pass the edited file with `--instructions-decisions`. A byte proof runs before any write, and the first update writes `instructions-report.json` into its backup folder. A sorting ledger (`ledger/*.json` in the kit folder, or `--instructions-ledger <FILE>`) can settle the same line for later projects.
- Damaged markers, a file that is not UTF-8 text and a bad decisions or ledger file refuse before any write. `--check` reports a local edit inside the block (a changed, added, deleted, duplicated or reordered line); the real run replaces it and the original stays in the backup.

Session start and install

- When the overlay's `board:` value is a board link, `/new-session` prints one read-only block with exact rules for reading both board shapes, and a reply line for a shape or tool it does not recognise. A value that starts with http or https but is not a board link is refused with `overlay board: refused (not a board link)`. With no `board` key in `AGENTS.md` the helper reads a link from the main checkout's untracked `KIT.local.json`. The command form is unchanged.
- Install, in its preview too, prints linter scope hints for ESLint, Biome and Prettier when their configuration does not already exclude `scripts/memory`, and one Windows note about Git's line-ending warning. Install and update never write `.gitattributes`.

Maintainers

- The public export's test gate runs with bounded concurrency (at most 4) under a fixed time limit that no option can raise, and a failing run names the failing files.

Known limits

- A fifo, socket or other special file at the memory hook path or at a planned destination can make update planning wait on a read before the refusal is reached. Nothing is written. Tracked for 3.3.5.

## 3.3.3

- `memory-migrate.mjs promote` turns selected one-note-per-file topics into numbered lessons, ordered by map date, metadata date, body date, first commit, then modified date. Dry run is the default; the map supplies each kind and optional route, slug, trigger, case, pin and date.
- Promotion changes bodies only by reversible filename and link rewrites, including exact filenames in prose and code spans; bare slugs and unrelated frontmatter values stay intact. State, hard-rule, chain and protected files stay in place; optional `--stubs` retains old-name pointers.
- Both modes prove expected body hashes and inverse byte recovery, and report remaining references, per-probe recall, gate FAIL differences, date sources and bounded rehearsal cost. Failed writes restore inputs; the name map, `metadata.source` and a prior git tag provide recovery.

- `memory-census.mjs` classifies files, searches configured reference roots and projects hot pages. Output can live outside the repository; errors name the cause.
- `memory-label.mjs` carries blind build, validation, partial merge, dispute sheets, settlement, third labelling and emission. Bundle headers explain reading harm; emission previews the dates promotion will use.
- `memory-selfrecall.mjs` saves top-10 ranks and compares the same queries after conversion, following the name map and failing on any worse rank.
- Promotion scans repository reference roots and repeated `--scan` paths after rehearsal. Unprotected old-name hits fail the write proof.
- Hot-budget warnings show topic and pin bytes and explain why topics need numbered lessons. Findings carry a measured byte value for allow ceilings.
- Owned hooks embed their installing engine version and refuse older checkout engines before running the gate. Reinstallation refreshes the template; upgrades refresh existing owned hooks on a best-effort basis, preserving foreign hooks and memory files.
- Install includes LESSON-CONVERSION.md and its reusable prompt, with the procedure and proofs.

## 3.3.2

- Saving a first lesson no longer makes pull-request or deploy numbers fail the memory gate.
- Lesson citations must be numbered Markdown links such as `[#015](lesson-015-x.md)`, or numbers introduced by `lesson` or `lessons`, including a continuing list. Missing lessons still fail.
- A numbered lesson link must agree with the number in its lesson filename. Bare numbers such as pull-request numbers are no longer read as lessons; numbers in code and URLs are ignored.

## 3.3.1

Start replies and /handover reports now use grouped bullets. A new Reports line in AGENTS.md asks for short groups, file and board links, and a statement about whether it is safe to compact.

The Session phrases line no longer splits a wrapped bullet during installation or upgrade, and a line 3.3.0 put inside a wrapped bullet is moved below that bullet. Known limits: the exact kit Session phrases line followed by indented lines (a blank line may precede them) is treated as the old insertion bug and moved; a custom Session phrases line with indented lines is kept with a warning; a custom Reports bullet with indented lines is kept with a warning, and one without is replaced by the kit line.

In `scripts/memory/memory.config.json`, set `caps.roadmapOverview.enabled` to `false` to skip overview writing, staging and gate warnings. Existing files are kept and stdout preview remains available. The setting defaults to `true`, and upgrades preserve a project's `false`.

`upgrade.mjs --dry-run` now previews changes; in 3.3.0 it ran a real upgrade. `--restore` refuses both `--dry-run` and `--check` before changing files.

- Upgrade from 3.3.0 with `node scripts/upgrade.mjs --target <PROJECT> --check`, then
  `node scripts/upgrade.mjs --target <PROJECT>`; kit-owned files are replaced with a backup; edited skills are kept. Run the installed gate.

## 3.3.0

Start with `/new-session [goal]` or the sentence "We are starting a new session - read this and let me know when we can start". The start is read-only: it shows Git and memory health, the newest handover note and nearby sessions, then waits for your go. `/handover` captures lessons, updates CURRENT from a new handover note, runs the checkpoint and pushes memory. Its SAFE verdict requires the session's own note and created lessons to be committed byte-for-byte and pushed, with the gate green and required checks complete. With no remote, the local-only SAFE variant instead says `committed locally (no remote), gate green`; it never claims a push.

Notes live in memory's `handovers/` folder. The gate checks loose-note size and frontmatter and scans notes, archives and strays for secrets. Rotation keeps the newest 20 loose notes by sequence, moves older notes to monthly archives and verifies their bytes before removing the originals; archives have their own warning limit.

Install and upgrade add the UserPromptSubmit phrase hook, the session gate line and both `Bash(node scripts/memory/new-session.mjs:*)` and `PowerShell(node scripts/memory/new-session.mjs:*)` permissions. `--no-new-session-hook` persists `newSessionHook: false` in KIT.local.json and removes only the exact kit hook; set it to true and upgrade to restore it. Foreign skills are kept, recorded and replaced only by `--replace-skill <name>`, with a backup. Codex session-skill mirrors are created when `.agents` or `.codex` exists; upgrade keeps divergent mirrors with a WARN naming the copy command; install refuses unless `--replace-skill <name>` is given.

- Upgrade from 3.2.12 with `node scripts/upgrade.mjs --target <PROJECT> --check`, then `node scripts/upgrade.mjs --target <PROJECT>`; run the installed gate. Preview reports planned changes without writes.
- A wave-save refusal means a hook command contains `wave-save.mjs` in `.claude/settings.json` or `settings.local.json`; remove the hook or install a wave-save release that supports handover. The refusal names every matching event and command in either settings file: `install a wave-save release that supports handover; no override`. Only a row in the incoming kit's `engine/upgrades.json` with `"waveSave": {"supportsHandover": true}` lifts it; 3.3.0 carries no such marker. A file's presence is insufficient.
- An unknown-owned-file refusal names the unchanged file missing from the incoming manifest. Review and remove that obsolete file, then rerun the upgrade and installed gate. Files declared retired by a later release can be removed by its upgrade; this release retires none.

## 3.2.12

Path settings in memory.config.json must stay inside the project; installation refuses and the gate fails when they point outside it. Two spellings of the same folder, including macOS /tmp and /private/tmp and letter-case aliases, are recognised as one. A saved notes folder that was deleted is reported by its saved path and recreated there only when KIT.local.json is untracked and the saved path is absolute.

Absolute paths, including those inside the project, and paths through `.git` are refused for path settings; guard rule paths must also stay inside the project. Folders and links that resolve outside the project fail `config.path`. `--write-allowlist` refuses while any `config.*` FAIL exists. The pre-commit hook blocks a staged secret even when another check fails.

If memory-init has to roll back, it removes only what it created and reports entries left in place. First-run messages explain how to choose folders, check notes and add Git checks. The generated roadmap overview no longer describes a history file that does not exist.

- Upgrade from 3.2.11 with `node scripts/upgrade.mjs --target <PROJECT> --check`, then
  `node scripts/upgrade.mjs --target <PROJECT>`; kit-owned files are replaced with a backup; edited skills and host files are kept. Run the installed gate.

## 3.2.11

`memory-init` creates missing private memory for an installed engine with the installer's templates, generated indexes, baseline commit, gate, and hook, records a chosen `--memory-dir` using the installer's persistence rules, treats an empty existing notes folder as missing, and rolls back its own changes on failure.

In-repo pre-commit checks incorrectly reported tracked sibling Markdown targets as dead links. Checked relative links outside memory but inside the same repository now use the Git index, including staged additions; memory targets still use the staged snapshot. `upgrade.mjs` does not reinstall the hook, and the hook script is unchanged: updating the installed `memory-check.mjs` repairs existing hooks. A glossary sentence and a self-test comment that described the maintainer's own setup were reworded for any user. No other behaviour change.

- Upgrade from 3.2.10 with `node scripts/upgrade.mjs --target <PROJECT> --check`, then
  `node scripts/upgrade.mjs --target <PROJECT>`; kit-owned files are replaced with a backup; edited skills and host files are kept. Run the installed gate.

## 3.2.10

Plain notes in a brain with no typed nodes incorrectly raised brain.frontmatter FAIL and could prevent pre-commit hook installation. When no discovered brain file has both id and type, files with neither field now skip brain.frontmatter and brain.length. Partial nodes retain their checks; typed brains retain all existing node checks, and 99-inbox/ retains its frontmatter exemption. Parse findings, secret scanning, duplicate IDs, edges and reachability are unchanged. No other behaviour change.

- Upgrade from 3.2.9 with `node scripts/upgrade.mjs --target <PROJECT> --check`, then
  `node scripts/upgrade.mjs --target <PROJECT>`; kit-owned files are replaced with a backup; edited skills and host files are kept. Run the installed gate.
- If the install skipped the pre-commit hook, run `node scripts/memory/install-hooks.mjs --repo . --memory-dir <MEMORY_DIR>` once the gate shows 0 FAIL.

## 3.2.9

- Wording only; no behaviour change. Commands, flags, outputs (except version strings), caps and detections are unchanged.
- Make all shipped guides, skills, diagrams, historical notes and test fixtures generic.
- Correct install-summary guidance, sample output and installed-only links.
- Upgrade from 3.2.8 with `node scripts/upgrade.mjs --target <PROJECT> --check`, then
  `node scripts/upgrade.mjs --target <PROJECT>`; kit-owned files are replaced with a backup; edited skills and host files are kept. Run the installed gate.

## 3.2.8

- Add hand-set metadata.takeaway (fix, method, know) to new, batch and classify;
  recall displays and filters it, and invalid present values WARN. Models label
  kind; people set takeaway. The kind test is labeller agreement (at most 6/40, scaled).
  Score reports print `disagreements <= N/M` and `kind test: PASS` or `kind test: FAIL`,
  including with optional historical `--reference`; JSON adds `kindTest`. Empty or
  unequal row sets fail; reports still exit 0 and bad input exits 1.
  Classify summaries count takeaways set or changed; recall displays only valid values,
  and takeaway warnings quote invalid values with escaped control characters.
- Ship the generic lesson casebook K0/K1-K10, independent labelling brief, optional
  kind_case capture/classification, case warnings and optional historical `--reference` score reports.
- Refuse equals-form shared-parser flags, malformed caps groups and escaping enforcement
  paths; explain invalid decisions and use future tense for upgrade previews.

- Preserve repeated `--route` values in new and batch capture; reject repeated `--kind` and `--trigger`.

Upgrade from 3.2.7 (commands run from the new kit):
- Preview `node scripts/upgrade.mjs --target <PROJECT> --check`, then apply
  `node scripts/upgrade.mjs --target <PROJECT>`; verify LESSON-KINDS.md is installed,
  settings report `present`, host files are unchanged, and run the installed gate.
- Optional capture example for a reviewed case: run `memory-lesson.mjs new --kind practice --route <family>
  --case K4 "Verify before use"`; fill the lesson, then `classify <labels.json> --write`
  with kinds and cases maps. Verify carriers with `classify --case K4`.
- Run `memory-lesson.mjs classify --score <A.json> <B.json>`;
  retain the report and settle rows under LABELLING.md before relabelling.

No new FAIL-capable check ids in 3.2.8.
The existing config.caps id gains FAIL cases for malformed groups; an upgrade on
such a host config rolls back with a clear message.

## 3.2.7

- Batch capture with required kinds, repeat-of sections and similarity hints; `batch --json` changes `created`
  from `string[]` to `{file, similar}[]`.
- Dated repeats with four causes, WARN at two / FAIL at four without a valid decision, enforcement and classification.
- Router line limits, damaged-character detection and conservative repair, empty prompt sections, future UTC dates,
  guard-rule validation, split-chain repair and long-line diagnostics.
- Command guard and prompt clock hooks preserve foreign settings; starter rules warn. `--no-guard` persists locally.
- Routes migration preserves wrapped trigger alternatives; shipped sources avoid the secret-assignment shape.
- Targeted installed self-tests replace the nested full-suite timeout path; the hostile host-config mutation proves isolation.
- Upgrade pre-runs only explicitly listed new FAIL-capable checks, compares them by check plus file, and retains
  rollback for unlisted regressions. Legacy repeats and stale host capture instructions produce hints only.
- Documentation covers kinds, repeat decisions, guard replay and repair. Diagram re-rendering remains a follow-up.

Upgrade from 3.2.6 (step 1: run from the new kit folder; steps 2-4: run from the project root):

1. Run `node scripts/upgrade.mjs --target <PROJECT> --check`, review the settings plan, then
   `node scripts/upgrade.mjs --target <PROJECT>`. Read pre-existing new-check findings and hints; add `--kind`
   to hinted host capture lines. Switch to the project root and run `node scripts/memory/memory-check.mjs`.
2. On affected memories, preview `node scripts/memory/memory-chars.mjs repair`, allow deliberate examples,
   then run `node scripts/memory/memory-chars.mjs repair --write`. Run
   `node scripts/memory/memory-chains.mjs repair --write` and `node scripts/memory/memory-chains.mjs lines --write`;
   hand-fix report-only numbering, ordering and long list items, then gate.
3. Review a version-1 kinds map outside memory; run `node scripts/memory/memory-lesson.mjs classify <FILE>` then
   `node scripts/memory/memory-lesson.mjs classify <FILE> --write` and gate.
4. Run `node scripts/memory/memory-lesson.mjs repeat --from-legacy`, review, then add `--write`. Each converted lesson needs
   `metadata.trigger` ("before ..." or "when ..."); the gate's `lesson.trigger` WARN lists them. Decide escalations
   with `node scripts/memory/memory-lesson.mjs enforce <ID> "hard-rule <FILE>"` (or check, hook, or lesson-only with
   a reason), and gate. Commit the host rules file in the project repository before recording any
   `enforced "<date> hook <file>"` decision. A file missing in the checked-out repo counts as no decision and can
   FAIL the memory pre-commit at four repeats. Starter guard rules remain warn; verify PreToolUse additionalContext reaches the model.
   Replay real commands before switching any rule to deny in the host override. Repair and classify before the fleet report.

## 3.2.6

- Router migration: preserve table, pre-link and wrapped triggers; share OPEN/BEFORE/WHEN/TRIGGER vocabulary with the gate, conserve clauses in the router, retain overflowing trigger rows and report notes destinations. Accept any triggered row of a family.
- Brain checks: exclude the Codex .agents skill mirror across gate, index, recall, measure and fleet.
- Self-test fixtures: construct secrets from pieces; keep shipped sources scanner-clean without weakening detection.
- Brain inbox: exempt 99-inbox notes at every depth from required identity and parse FAILs; retain link checks and report note counts.
- Descriptions: warn with desc.slug when whole words repeat the filename or name; require useful context during conversion.
- Fleet trigger: exclude induced repo.git-skipped warnings; report counted IDs in warnProjectsByCheck.
- Docs: correct STARTER in-repo gating guidance and clarify conversion and inbox conventions.

Upgrade from 3.2.5 (run kit commands from the new kit folder):
- Run `node scripts/upgrade.mjs --target <PROJECT> --check`, review edits, then run `node scripts/upgrade.mjs --target <PROJECT>`; finish with `node <PROJECT>/scripts/memory/memory-check.mjs --repo <PROJECT> --memory-dir <MEMORY_DIR>`.
- Audit projects that ran routes --write on 3.2.5: run `git -C <MEMORY_GIT_ROOT> diff <PRE_MIGRATION_COMMIT> -- <MEMORY_RELATIVE_DIR>/MEMORY.md '<MEMORY_RELATIVE_DIR>/index-notes-*.md'` and `git -C <MEMORY_DIR> grep --no-index -n -E 'OPEN|BEFORE|WHEN|TRIGGER' -- 'index-notes-*.md'`. Compare removed router clauses with notes hits, restore missing triggers to MEMORY.md, then run `node <PROJECT>/scripts/memory/memory-index.mjs --memory-dir <MEMORY_DIR> --write` before the project gate. Use . for MEMORY_RELATIVE_DIR in a separate memory repo.
- Rewrite each desc.slug description to explain when the note helps or what it teaches, then run the project gate until desc.slug is zero. Review and save memory edits through the project's normal workflow before the final gate.

## 3.2.5

- In-repo memory: support tracked folders across clones, worktrees, gate, upgrade, SessionStart, recall and fleet. Install project hooks only after a zero-FAIL gate; preserve host hooks and print retry guidance. Refuse root memory with copy-first conversion guidance.
- Migration order and link rows: preserve hand blocks and custom labels in source order, split notes within the topic cap, report regenerated link-only rows, and enforce ORDER and line conservation with rollback.
- Skill frontmatter: put engine_version under metadata; refresh unchanged legacy skills and identical mirrors, and warn once for host-edited legacy skills without perpetually failing upgrade --check.
- Host .gitignore: report matching rules and add validated narrow root negations; refuse excluded parents and ignored private in-repo memory before writes. With --no-gitignore-fix, warn and leave host rules unchanged, including excluded parents.
- Line endings: preserve unchanged mixed endings and destination endings; use the majority ending for changed lines and the source hand index's dominant ending for new migration notes.
- Fleet status: isolate malformed configs, distinguish Git ownership and availability failures, and report in-repo current/behind status from the installed receipt.

Upgrade from 3.2.4 (run kit commands from the new kit folder):
- Run `node scripts/upgrade.mjs --target <PROJECT> --check`, review edits, then run `node scripts/upgrade.mjs --target <PROJECT>`; finish with `node <PROJECT>/scripts/memory/memory-check.mjs --repo <PROJECT>`.
- Upgrade unchanged skills automatically; for a host-edited skill, move its top-level `engine_version: "3.2.4"` line under `metadata:` with two-space indentation (set it to "3.2.5" and keep host edits), then run the project gate; the intentional local-edit WARN remains.
- Append `!/scripts/memory/` to the host .gitignore when `memory/` hides an existing kit; for a new install, let the installer add the narrow negation or pass `--no-gitignore-fix` to retain intentional ignores. Fix excluded parent rules or use the install opt-out; do not re-run install over an existing receipt. Run the project gate.
- Install a new host using existing memory copied from the 3.2.4 install into a dedicated repo folder with `node scripts/install.mjs --target <PROJECT> --memory-dir <PROJECT>/<folder>`; a zero-FAIL gate installs a staged-memory project hook or prints integration guidance for a host hook. Run `node <PROJECT>/scripts/memory/memory-checkpoint.mjs --repo <PROJECT>`: it prints staging guidance by default; `--commit` commits only memory, and neither mode pushes. Finish with the project gate.

## 3.2.4

- Fleet: report `.git` folders refused by Git as `unsafe owner (git ownership guard)` in both scans, retaining memory statistics without bypassing ownership checks.

- Install safety: snapshot only planned paths with bounded hashing; report read errors without masking install results. Preserve linked instructions, line endings, permissions and hooks; report new CLAUDE imports. Detect in-repo routers through local/rule/imported instructions and existing router files; honor resolved memory overrides.
- Keep hand-written and Dataview brain indexes; write alternate generated indexes. Skip absent or untyped brains. Preserve local config; update identical skill mirrors on install and upgrade, report divergent upgrade mirrors.
- Migration: accept labelled, table and backtick routing rows; preserve state prose, removed rows and wrapped continuations. Retain external-link hooks and hand text with conservation checks.
- Gate checks: share ladder reachability and configured brain paths; warn on unreachable indexes, fail missing routing triggers, and warn on a missing upgrade ledger while failing malformed ledgers.
- Fleet status and the upgrade ledger: add read-only project inventory, exclusions, orphan hints and deferred-upgrade trigger tables. Default to the kit gate with project config; opt into project code with --project-gates. Disable Git fsmonitor and retain its ownership guard; distinguish submodules and worktrees.
- Glossary and guide: ship the reference glossary, illustrated how-it-works guide and six light/dark diagrams; document project-specific backup branches and tags.
- Worktrees: resolve linked checkout memory through the main checkout, preserve overrides, and retain the current checkout for bare-repository layouts.
- Self-test rename: install memory.selftest.mjs outside host test globs; retire an unmodified memory.test.mjs. Run all self-tests in an isolated engine copy with fixture config; print lint/TypeScript hints. Keep test logs outside the kit.

Upgrade:
- Run `node scripts/upgrade.mjs --target <PROJECT> --check`, review edits, then run `node scripts/upgrade.mjs --target <PROJECT>` and the project's `node scripts/memory/memory-check.mjs`; upgrade adds missing `upgrades.json` and refreshes generated memory pages.
- Run `node --test scripts/memory/memory.selftest.mjs` from the project; upgrade removes the old `memory.test.mjs` only when its manifest hash matches, and keeps edited copies for review.
- Run `node scripts/memory/brain-index.mjs --write` and the gate after upgrading a typed brain; keep hand-written `index.md` and `index-all.md`, with generated content in `index-generated.md` and `index-all-generated.md` respectively.
- Point `--memory-dir` at the existing in-repo router when installing into a project with in-repo memory; use `--accept-separate-memory` only to deliberately gate a separate memory folder, then run the gate against that chosen folder.
- Run `node engine/memory-fleet.mjs --root <PROJECTS> --memory-home <MEMORY_HOME>` from the kit and review the new `scripts/memory/upgrades.json` ledger; use `--project-gates` only for trusted installed or vendored code, then run the project gate.
- Remove an explicit host-test reference to `scripts/memory/memory.test.mjs`, keep host test globs scoped to host tests, and add an optional `memory:test` command for `node --test scripts/memory/memory.selftest.mjs`; run the host tests and the gate.

## 3.2.3

- Resolve hand-row brain wikilinks after memory names; refuse unresolved names. Preserve links outside memory and handle lower-case index topics, dated index families, and numeric-only stems.
- Keep brain-linked and web-linked hooks as hooks; preserve and guard non-`.md` row text. Refuse notes over the topic cap before writing.
- Share gate and migration wikilink resolution: raw names before `#heading` or `^block` stripping, escaped `\|alias`, scalar names, and `.MD` files. Reject object, array, null, and empty name keys.
- Read each brain node once in the gate and use indexed wikilink lookups.
- Fix roadmap rotation moving the newest same-date block. Add `caps.roadmap.order` (default `newest-first`), `config.roadmap-order` FAIL and `repo.roadmap-order` WARN; retain history in file order and handle an unterminated last block.
- Validate roadmap order before checkpoint writes. Share the index-page rule with the installer.
- Known limits: a split page of a year-named family (`INDEX-notes-2026-2.md`) becomes its own family; out-of-folder links moved into a notes file are not dead-checked.

Upgrade:
- Run `memory-index.mjs --write` after updating, before the gate; mainly needed for routers linking dated index names, harmless otherwise.
- Set `caps.roadmap.order: "oldest-first"` before the next checkpoint if roadmap Open work is oldest-first.
- If a hand-written lower-case `index-*.md` page should remain an index, rename it to `INDEX-<family>.md` (use a temporary name for a case-only rename on Windows), link it from `MEMORY.md`, then run `memory-migrate.mjs routes --write` to turn it into generated routes; `memory-index.mjs --write` refuses to overwrite a hand page. If it stays hand-kept, run `memory-check.mjs --ratchet-pins` to pin it. Only the exact `INDEX-` prefix now marks an index; the extension remains case-insensitive. Previously lower-case pages other than `index-notes-*.md` were indexes; they now become topics, subject to topic checks and excluded from hand-index route migration and installer index pinning. To keep one as a topic, supply topic frontmatter and routing instead. Lower-case `index-notes-*.md` pages remain topics.

## 3.2.2

- Routers with the trigger before the link or in a table now supply a hot-page sentence, changing generated page bytes. Vendored users must run `memory-index.mjs --write` after updating, before the gate.

- Shorten generated hot-index sentences and row descriptions with an ellipsis at the warning cap (default 300); an immutable link prefix can still exceed the cap. Preserve Unicode code points and meaningful punctuation.
- Regenerate generated pages transactionally during upgrades; restore retains original bytes. After vendored updates run `memory-index.mjs --write` before the gate to avoid `index.stale`.
- Diagnose missing vendored hook gates, retain export errors through cleanup failures, and synchronize release documentation and pins.
- Resolve the pre-commit gate from the running engine when the installed gate is absent, and refuse hook installation when neither gate exists.

## 3.2.1

- Preserve router separators, merge continuation triggers at clause level, and capitalize sentences after lesson-count removal.
- Keep shipped-config assertions in kit tests so installed engine tests accept older project system-file lists.

## 3.2.0

- The brain index includes `memory-ladder.md` by default and links only to system files that exist.
- Install generates the brain index when a configured brain is present; dry run reports the step without writing.
- Install and upgrade support `--help` and `-h` to list accepted options without changing files.

- retain displaced lock records on stale-break contention and report their paths.
- Ignore unrelated enclosing repositories and scope nested-memory dirty checks to the memory subtree.
- Preserve prefixed index rows verbatim with hand-text proofs; exempt redirect indexes from pin checks.
- Reject invalid checkpoint dates before locks or writes, and refuse missing CLI date values.

- bound redirect membership to non-index targets, preserve all hand row hooks with a pre-write proof,
  diagnose broken rows by page and line, and spill router overflow before checking caps.
- Extract only the staged memory subtree, resolve symlink paths, check nested-repo file ages, and accept CRLF indexes.
- Persist planned upgrade creations before memory writes; clean and exclude all `.memory.lock*` artifacts.
- Add simulated `--today` dates to capture and checkpoint checks; failed or timed-out pushes exit 2 with the commit retained.
- Atomic lesson capture and generated hot indexes with paginated catalogs.
- Routed migration with payload, byte-preservation and recall proofs; transactional upgrades.
- Staged-snapshot pre-commit gate, scoped staleness and engine version integrity.
- One locked checkpoint with roadmap rotation and bounded brain navigation.
- preserve indexed redirect closures, curated hooks and overflow router prose during migration;
  refuse generated writes over hand-kept indexes and recognize continuation families.
- Normalize staged CRLF pages, support memory subfolders, and block hooks only on findings or snapshot extraction failures.
- Exclude checkpoint locks from staging, bound pushes, use in-memory configuration, recover stale corrupt locks,
  and restore only upgrade-created memory files under the memory lock.
- Add adversarial migration fixtures and mutation-sensitive allocation, conservation, route, hook and stale checks.
