# Upgrade an installed kit

Run commands from the new kit folder. Replace `<PROJECT>` with the installed project.

1. Inspect without writing: `node scripts/upgrade.mjs --target <PROJECT> --check`.
   Exit 1 means VERSION is newer or a manifest file was edited or removed; names
   are printed. Semantic versions include prereleases: `3.1.0-beta` < `3.1.0`,
   numeric prerelease identifiers sort numerically, and invalid versions are refused.
2. Run `node scripts/upgrade.mjs --target <PROJECT>` after reviewing edits.
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
   Existing pins, allow entries, caps and paths win. Probes and instruction blocks are kept. Missing guard hooks are merged into settings,
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
7. After releasing any file lock, recover with
   `node scripts/upgrade.mjs --target <PROJECT> --restore <dir>`, where `<dir>` is
   the printed backup directory. This reads `restore.json`, restores existing files
   and removes files that were absent; no new receipt or working gate is required.
8. Equal versions are no-ops only when engine hashes also match. Engine drift triggers
   replacement. `--force-skills` refreshes edited skills. Downgrades refuse.
9. For 3.2.0 and later, hand-written indexes migrate to routes under the same lock
   and backup as the engine copy. Any copy, migration, proof or new gate failure
   restores both engine and memory. The backup includes memory files and the restore map.

Tests in `tests/upgrade.test.mjs` and `tests/fixes.test.mjs` cover semantic versions,
pre-existing/new FAILs, unique backups, removed files, restore, interrupted copying,
EPERM recovery, config preservation and skipped/forced skills. Fault injection is
an importable test callback; the CLI has no fault-injection switch.

After every vendored kit update, run `memory-index.mjs --write` before the gate. Older generated pages report `index.stale` until regenerated. The upgrade script regenerates generated pages under its lock and includes them in backup/restore.

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
