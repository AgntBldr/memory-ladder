# Upgrade an installed kit

Run commands from the new kit folder. Replace `<PROJECT>` with the installed project.

1. Inspect without writing: `node scripts/upgrade.mjs --target <PROJECT> --check`.
   Exit 1 means VERSION is newer, a write is planned, or a manifest file was edited
   or removed; names are printed. The preview lists every planned write (see
   "Planned writes, live memory and worktrees" below). Semantic versions include
   prereleases: `3.1.0-beta` < `3.1.0`, numeric prerelease identifiers sort
   numerically, and invalid versions are refused.
2. From the project's main checkout, run
   `node scripts/upgrade.mjs --target <PROJECT> --live-memory` after reviewing edits.
   To rehearse first, copy the memory folder and run
   `node scripts/upgrade.mjs --target <PROJECT> --memory-dir <copy>` instead.
   The updater runs the installed gate BEFORE replacement and records its FAIL set.
   Pre-existing FAILs are reported; they do not block the upgrade. An unreadable
   gate result stops the operation before replacement.
3. Every replaced or removed file is backed up byte-for-byte under
   `<PROJECT>/scripts/memory/.kit-backup-<UTC>/`, preserving relative project paths.
   Backups are unique and never overwritten. `restore.json` records which files
   existed, which were absent, and the prior FAIL set. `scripts/memory/.gitignore`
   ignores `.kit-backup-*/` and `KIT.local.json`; retain backups until acceptance.
4. Engine files and reference docs are replaced. Files the new kit no longer ships
   are removed and included in the restore map. Edited skills are WARNed and skipped;
   their previous vendor hashes stay in the manifest so drift remains visible.
   `node scripts/upgrade.mjs --target <PROJECT> --force-skills` replaces them.
5. Config merges missing defaults recursively; only `engine_version` is overwritten.
   Existing pins, allow entries, caps and paths win. Probes and the `## Project rules` section are kept; the kit's
   standard block is replaced (see "Standard block and Project rules" below). Missing guard hooks are merged into settings,
   preserving foreign hooks; --check lists the planned change. KIT.json keeps its installation date and
   receives the new version; the custom memory directory stays in KIT.local.json.
6. The new gate runs after replacement. Only NEW FAIL findings trigger rollback;
   unchanged pre-existing FAILs are reported and allowed to remain. A finding is
   identified by check, file, line, message and value, so worsened findings are new.
   For the explicit new FAIL-capable NEW_CHECKS list only, an incoming-engine pre-run with merged config
   also records check plus file; changed count messages do not turn these into upgrade regressions.
   A failed/non-JSON incoming pre-run contributes nothing. A lock-free legacy-repeat hint suggests dry-run
   conversion; upgrade never converts it. Host capture lines without --kind are reported, not rewritten.
   Copy errors and invalid gate results also roll back. Recovery restores old bytes
   and removes newly introduced files, then exits 1. If rollback itself fails
   (for example EPERM), the error includes the backup path and restore command.
   The gate after an update can show WARN keys the old gate did not: the release's warn-only checks report conditions the
   project already had (CHANGELOG, "New gate checks"). They never fail an update. Confirm a key is new with
   `git log -S'<key>'` in the kit before treating it as a regression. A release can also widen a check that
   already fails, which can fail an update; see "Checks a release widens" below.
7. After releasing any file lock, recover with
   `node scripts/upgrade.mjs --target <PROJECT> --restore <dir> --live-memory`, where
   `<dir>` is the printed backup directory (for a rehearsal backup, use
   `--memory-dir <copy>` instead of `--live-memory`). Add `--check` first to list what
   the restore would write. This reads `restore.json`, restores existing files, removes
   files that were absent and puts back the memory hook when the backup recorded it;
   no new receipt or working gate is required.
8. Equal versions are no-ops only when engine hashes also match. Engine drift triggers
   replacement. `--force-skills` refreshes edited skills. Downgrades refuse.
9. For 3.2.0 and later, hand-written indexes migrate to routes under the same lock
   and backup as the engine copy. Any copy, migration, proof or new gate failure
   restores both engine and memory. The backup includes memory files and the restore map.

## Checks a release widens

A release can add a check (a new check id) or widen an existing one: the same id now covers files it did not, or fails at
a size it did not. "No new check" does not mean "no new failure". Unchanged installed-gate FAILs remain permitted. For IDs
in `NEW_CHECKS`, the incoming pre-run additionally records failures by check and file. `hardrule.size` is not in that list.
Unchanged means the same check, file, line, message and value as the installed gate reported before the update. A file a
widened check newly fails is therefore a new FAIL finding: the update stops, restores the project and memory, exits 1 and
prints `upgrade: restored <backup>: new FAIL: <check> <file>: <message>`.

| Release | Check | What widened | Fails when |
| --- | --- | --- | --- |
| 3.3.6 | `hardrule.size` | A card reached through a `[[wikilink]]` under the router's `## Hard rules` is now a hard rule; before 3.3.6 only a card reached through a Markdown link was | The card is over 4096 bytes (WARN over 2048) |

Before updating from 3.3.5 or older, preview the gate the update will run. Copy the memory folder, then run these from the
new kit folder. `<merged>` is a new file outside the project and the copy; the first command writes the configuration the
update writes (the project's own values, plus the defaults it lacks), built with the update's own merge:

```sh
node --input-type=module -e "import fs from 'node:fs'; import {mergeDefaults} from './scripts/upgrade.mjs'; const defaults = JSON.parse(fs.readFileSync('engine/memory.config.json', 'utf8')); const merged = mergeDefaults(JSON.parse(fs.readFileSync(process.argv[1], 'utf8')), defaults); merged.engine_version = defaults.engine_version; fs.writeFileSync(process.argv[2], JSON.stringify(merged, null, 2) + '\n');" <PROJECT>/scripts/memory/memory.config.json <merged>
node engine/memory-check.mjs --memory-dir <copy> --repo <PROJECT> --config <merged> --json
node <PROJECT>/scripts/memory/memory-check.mjs --memory-dir <copy> --repo <PROJECT> --json
```

The second command runs the incoming gate with that configuration; the third runs the installed gate as the update's first
gate run does. In each output, take the findings whose `severity` is `FAIL` and whose `allowed` is false, and compare them
by check, file, line, message and value, as the update does. An incoming-only unallowed FAIL is a candidate new failure. The updater additionally permits incoming pre-run failures in `NEW_CHECKS` by check and file, and post-update findings can differ for the reasons below. For `hardrule.size`, move the card's detail into another file, writing the new file before shortening the card, then
run the update. Without `--config` the incoming gate reads the kit's defaults, not the project's configuration, and can
fail a file the update accepts (for example a card over 4096 bytes when the project's `caps.hardRule.failBytes` is higher).

This is a preview, not a guarantee. It runs the incoming gate on the project as it is today and on a copy of the memory.
The update runs the gate after it has replaced the kit files, written the merged configuration and changed memory (route
migrations, regenerated pages), so a finding that depends on any of those can differ. The incoming gate also prints
findings about the installed kit files (for example `repo.skill-version` WARNs) until the update replaces them. A `FAIL`
in the preview is a reason to fix the cause first; a clean preview does not promise a clean update, and an update that
finds a new `FAIL` still restores itself.

## Planned writes, live memory and worktrees

- `--check` and `--dry-run` print, before the final `kit <old> -> <new>` line, a
  `planned writes` block: `WRITE` and `DELETE` for project files, `BACKUP` for the
  backup folder, `MEMORY <folder> (<source>; live|copy)`, `MEMORY WRITE` and
  `MEMORY DELETE` for memory files, one `HOOK` line (the gate and memory paths the
  hook names now and after the update, `unchanged`, or `not refreshed` with the
  reason) and a count line. A route migration is computed on a temporary copy of
  the memory files, which is deleted before the preview exits.
- Live memory is the folder the update uses when `--memory-dir` is not given
  (`CLAUDE_MEMORY_DIR`, `memory.inRepoDir`, `KIT.local.json`, then the default
  folder), plus its hook. A real update or restore that would write live memory or
  its hook needs `--live-memory`; without it the update writes nothing and exits 1.
- A `--memory-dir` folder that is not live is a rehearsal: the update may write
  inside it and inside the project, nowhere else. Every destination is resolved
  through links and junctions first; a destination that resolves into live memory
  or outside the rehearsal folder is refused before any write, and so is a path
  that cannot be resolved and a file with other hard links (a write to one name
  changes them all).
- Only planned operations run: files whose bytes do not change are not written,
  and memory gets exactly the bytes the preview computed. If the memory steps
  cannot be computed (for example the temporary copy cannot be made), the update
  writes nothing and exits 1 with `upgrade: cannot plan the memory steps (...)`.
- The update never points the memory hook at a linked worktree: from a worktree it
  prints `HOOK not refreshed`, `--live-memory` is refused, and `install-hooks.mjs`
  refuses `--repo <worktree>`. Run the live update from the main checkout.
- The plan is made twice: once before the memory lock and again under it. If any
  input changed in between, nothing is written and the update exits 1. A real
  `--restore` is planned again under the lock the same way.
- The backup records the memory hook. Before the first write, the update also
  copies its protected scope to a temporary snapshot: the project files git
  shows (tracked, and untracked but not ignored; submodules and nested
  repositories left out), the kit and host configuration it reads (`KIT.json`,
  `KIT.local.json`, `memory.config.json`, the rules files, `AGENTS.md`,
  `CLAUDE.md` and the files they import, by the path they are imported under,
  missing ones too, `.claude/settings*.json`, and the git ignore and
  configuration files, even ignored or missing ones, with their include
  targets and the system and global candidates), the file behind every planned
  write and the hook (through links, even into `.git`), and the whole memory
  folder (its `.git` and older backups included; only its `.memory.lock*` files
  and this run's backup are left out). Ignored folders such as `node_modules` are neither copied nor compared. A
  project outside any git work tree uses its whole tree, minus nested
  repositories. If git cannot list the project completely (an error, or any
  warning) before the memory lock, the update writes nothing and exits 1 with
  `upgrade: cannot list the project files (...); nothing written`; a listing
  that fails under the lock is handled like a later failure (below). A git
  input whose location cannot be established exactly (a relative
  `GIT_CONFIG_GLOBAL` or `core.excludesFile`, an empty or relative
  `XDG_CONFIG_HOME`, `HOME` or `USERPROFILE`,
  an include path git expands itself such as `%(prefix)/...`, an unexpected
  `git var` answer, or a target below the work tree root, where git names the
  repository's configuration files relative to that root) is refused the same
  way, with `upgrade: cannot establish the git input <what> (...); nothing
  written`. A special file in the scope (a fifo, socket or device) is refused
  with `upgrade: cannot protect the special file <path> (...); nothing
  written`, before anything reads it. Every git call the installer and the
  update make, the gate they run, and the kit's commands outside the gate's
  hook path leave out `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
  `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CEILING_DIRECTORIES`,
  `GIT_DISCOVERY_ACROSS_FILESYSTEM`, `GIT_NAMESPACE`, `GIT_CONFIG`,
  `GIT_CONFIG_COUNT`, `GIT_CONFIG_PARAMETERS`, and `GIT_CONFIG_KEY_<n>` /
  `GIT_CONFIG_VALUE_<n>` where `<n>` is one or more decimal digits, and the
  pathspec-mode variables `GIT_LITERAL_PATHSPECS`,
  `GIT_GLOB_PATHSPECS`, `GIT_NOGLOB_PATHSPECS` and `GIT_ICASE_PATHSPECS`.
  Variable names are matched without regard to case. If git cannot say whether the target is a linked worktree, the
  update refuses; a target that becomes one while planning is drift.
- The hook is refreshed last. If anything in that scope differs from the plan, or
  the hook refresh or a later listing fails, the update first keeps every state it
  is about to replace under `<backup>/unplanned/` (with a manifest), then undoes
  every change from the snapshot and exits 1. Keeping is refused if the backup
  no longer resolves to where it was made or a folder on the way is a link. A
  file outside the project and memory (a global git configuration, an imported
  instruction file) is only compared, never written. If keeping or undoing fails, the snapshot is kept and
  its path printed with the restore command. The gate runs with
  `GIT_OPTIONAL_LOCKS=0`, so it does not rewrite the memory repository's index.
- Same version: when project files are at this kit version but memory is not
  (a pending route migration, or stale or obsolete generated pages), the update
  writes nothing, exits 3 and prints the replay command,
  `--memory-only --live-memory` (or `--memory-dir <copy>` to rehearse).
  `--memory-only` runs only the memory steps, with a backup and the gate before
  and after, and refuses when project files are behind the kit. A same-version
  run that only adds the lock line or refreshes the hook also keeps a backup;
  only a run that changes nothing has none.
- Known limits in 3.3.6. Each one is rare in a normal install. Where a
  workaround exists, it is given:
  - A hand-made link at a generated page (`INDEX-*.md`) that leads to a file
    the kit does not generate is refused. The update writes nothing and names
    the file. A link to a marked generated page is still updated. Workaround:
    replace the link by a copy of its target's bytes, then run the update again.
  - A file that is a regular file at the kind check and becomes a fifo, socket
    or device before the update reads it can still make the read wait. Keep
    special files out of the project and the memory folder.
  - A `.claude/rules` folder that becomes unreadable after planning is read as
    empty. Workaround: do not change the folder's permissions while an update
    runs.
  - A rollback removes a git-ignored project file that an outside writer made
    reachable during the run. Its bytes are kept under `<backup>/unplanned/`.
    Workaround: do not write to the project while an update runs.
  - A linked worktree of a bare repository is treated as the main checkout.
    The memory hook goes to the bare repository's own hook path, which every
    worktree of that repository shares.
  - A memory folder reached through a link (a junction) whose target is inside
    the project, with a lock file tracked in git: the promote rehearsal still
    copies that lock. Workaround: stop tracking existing lock files with
    `git rm --cached -- <lock-file>` and keep `.memory.lock*` in the memory
    folder's `.gitignore`, or use the real path of the memory folder.
  - A memory folder that contains configured outputs (for example memory at
    `brain`): an all-sessions checkpoint with `--commit` includes the whole
    memory folder in its commit, subject to the output, lock and session-ledger
    exclusions, so your own uncommitted change there (a renamed archive, an
    edited note) is committed with it. Output groups that Git reports as
    already modified are excluded from the commit; if any status query fails,
    all three groups are excluded. Their outputs can still be rewritten. Only
    after the commit step completes, and only if excluded groups have written
    outputs, does `commit: left out ...` name those written outputs and the
    reason. Workaround: commit or stash such changes before a `--commit`
    checkpoint, or keep the memory folder apart from the outputs.
  - The `--commit` check of uncommitted outputs does not match a name that
    differs from the tracked file only in non-ASCII case or Unicode
    normalisation, because git's case folding is ASCII only. Files marked
    assume-unchanged or skip-worktree read as unmodified. Workaround: keep the
    configured spelling identical to the tracked one, and do not set those
    flags on outputs.
  - Git's own input files (its ignore and configuration files) are chosen
    from the disk before the writes, so a planned change to which of them
    git reads is not predicted. If the files git reads after the writes
    differ from the prediction, the update refuses, undoes its changes as
    for any unplanned change, and exits 1.
  - The instruction walk can follow an absolute or `../` mention to a file
    outside the project. A file outside both the project and the memory
    folder is read and compared by digest; the update never copies, writes or
    restores it. A mention that resolves into the memory folder is protected
    and restored like any other memory file. Workaround: keep paths outside the
    project out of instruction files if the update should not read them.

Tests in `tests/upgrade.test.mjs` and `tests/fixes.test.mjs` cover semantic versions,
pre-existing/new FAILs, unique backups, removed files, restore, interrupted copying,
EPERM recovery, config preservation and skipped/forced skills. Fault injection is
an importable test callback; the CLI has no fault-injection switch.

After every vendored kit update, run `memory-index.mjs --write` before the gate. Older generated pages report `index.stale` until regenerated. The upgrade script regenerates generated pages under its lock and includes them in backup/restore.

## Standard block and Project rules

The kit owns one marked block in `AGENTS.md` (or in `CLAUDE.md` when that is the only instructions file):
every line from `<!-- kit standard block (memory kit <version>): begin. ... -->` to
`<!-- kit standard block: end -->`. Install and every update write the kit's text there, so every project gets
the same working instructions. When `AGENTS.md` exists, `CLAUDE.md` gets a block that holds only the
`@AGENTS.md` import; no other `CLAUDE.md` byte changes. Put rules for one project under `## Project rules`; the
kit never edits or removes that section.

The first update of a file without the markers sorts its old memory section (the `## Memory gate` section, else
the body of the first heading that names the memory ladder) unit by unit. A unit is a `- ` bullet with its
indented lines, or any other non-blank line:

- kit wording, as any release shipped it or as the current template has it, is replaced by the block;
- a unit with a keep decision moves word for word into `## Project rules`; a drop decision removes it;
- every other unit is unclear, and the update writes nothing until each one is decided.

1. Preview: `node scripts/upgrade.mjs --target <PROJECT> --check` prints `REPLACE`, `KEEP`, `DROP` and
   `UNCLEAR` lines with each unit's id and its first 60 characters.
2. For unclear units run `node scripts/instructions-sort.mjs preview --target <PROJECT> --out <FOLDER>` with a
   folder outside the project. It writes `sort-report.json` and `decisions.json` there and nothing else.
3. In `decisions.json` set each `outcome` to `keep` or `drop`, write a `reason` and `decidedBy`, and keep
   `scope` as `project` unless the decision is right for every project (`general`).
   Before you choose `drop`, search your project's own checks (a docs guard, a CI step, a test) for each unit's wording;
   the preview shows 60 characters, and `decisions.json` has the full `text`. A unit that a check needs must be `keep`.
4. Run the update again with `--instructions-decisions <FOLDER>/decisions.json`. Before any write a proof
   checks that only the old section and the end of an existing Project rules section change, that every
   non-blank old line is replaced, kept or dropped exactly once, and that the block holds the template.
5. A first update writes `instructions-report.json` into its backup folder, one entry per unit with its outcome,
   scope, reason, who decided and the `general` ledger entries it matched (no entries when the file had no old
   section). The printed `ledger-add` command adds it to a sorting ledger from a kit
   branch. Updates read `ledger/*.json` in the kit folder, or `--instructions-ledger <FILE>`: a `general`
   entry decides by itself, and a `project` entry from another project is shown only as a suggestion.

Damaged markers (a begin without an end, an end without a begin, two of either, or the end first) refuse with
the file's name. A local edit inside the block (a changed, added, deleted, duplicated or reordered line, against
the text the release named in the begin marker wrote) is reported by `--check` with the number of lines that
differ, and replaced by the real run; the original file stays in the backup. Kit wording outside the block is
reported and kept. An instructions file that is not UTF-8 text refuses before any write, with the offset of its
first invalid byte.

## 3.2.4


- Run `node scripts/upgrade.mjs --target <PROJECT> --check`, review edits, then run `node scripts/upgrade.mjs --target <PROJECT>` and the project's `node scripts/memory/memory-check.mjs`; upgrade adds missing `upgrades.json` and refreshes generated memory pages.
- Run `node --test scripts/memory/memory.selftest.mjs` from the project; upgrade removes the old `memory.test.mjs` only when its manifest hash matches, and keeps edited copies for review.
- Run `node scripts/memory/brain-index.mjs --write` and the gate after upgrading a typed brain; keep hand-written `index.md` and `index-all.md`, with generated content in `index-generated.md` and `index-all-generated.md` respectively.
- Point `--memory-dir` at the existing in-repo router when installing into a project with in-repo memory; use `--accept-separate-memory` only to deliberately gate a separate memory folder, then run the gate against that chosen folder.
- Run `node engine/memory-fleet.mjs --root <PROJECTS> --memory-home <MEMORY_HOME>` from the kit and review the new `scripts/memory/upgrades.json` ledger; use `--project-gates` only for trusted installed or vendored code, then run the project gate.
- Remove an explicit host-test reference to `scripts/memory/memory.test.mjs`, keep host test globs scoped to host tests, and add an optional `memory:test` command for `node --test scripts/memory/memory.selftest.mjs`; run the host tests and the gate.

## 3.2.7

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
   a reason), and gate. Starter guard rules remain warn; verify PreToolUse additionalContext reaches the model.
   Replay real commands before switching any rule to deny in the host override. Repair and classify before the fleet report.

## 3.2.8

Upgrade from 3.2.7:

1. From the new kit, preview `node scripts/upgrade.mjs --target <PROJECT> --check`,
   then apply `node scripts/upgrade.mjs --target <PROJECT>`.
2. Verify LESSON-KINDS.md and LABELLING.md are installed in scripts/memory/,
   then run the installed gate.
3. Follow LABELLING.md: label every row independently and score the pair with
   `classify --score A.json B.json` (at most 6 of 40 disagreements, scaled).
   Person-set labels are hand-set takeaways. Settle disagreements before reviewed relabelling.

In 3.2.8, `--check` previews missing hooks as
`settings: guard hooks would be added (PreToolUse Bash|PowerShell, UserPromptSubmit)`.
Apply reports `settings: guard hooks added (PreToolUse Bash|PowerShell, UserPromptSubmit)`.
An unchanged hook setup reports `settings: present`. LESSON-KINDS.md and LABELLING.md
are kit-owned files installed in scripts/memory/. No lesson is relabelled by upgrade.
