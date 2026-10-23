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
   Existing pins, allow entries, caps and paths win. Probes, hooks, settings and
   the instruction block are untouched. KIT.json keeps its installation date and
   receives the new version; the custom memory directory stays in KIT.local.json.
6. The new gate runs after replacement. Only NEW FAIL findings trigger rollback;
   unchanged pre-existing FAILs are reported and allowed to remain. A finding is
   identified by check, file, line, message and value, so worsened findings are new.
   Copy errors and invalid gate results also roll back. Recovery restores old bytes
   and removes newly introduced files, then exits 1. If rollback itself fails
   (for example EPERM), the error includes the backup path and restore command.
7. After releasing any file lock, recover with
   `node scripts/upgrade.mjs --target <PROJECT> --restore <dir>`, where `<dir>` is
   the printed backup directory. This reads `restore.json`, restores existing files
   and removes files that were absent; no new receipt or working gate is required.
8. Same-version upgrades are no-ops except `--force-skills`, which refreshes skills
   and their manifest entries with the same backup and gate checks. Downgrades refuse.

Tests in `tests/upgrade.test.mjs` and `tests/fixes.test.mjs` cover semantic versions,
pre-existing/new FAILs, unique backups, removed files, restore, interrupted copying,
EPERM recovery, config preservation and skipped/forced skills. Fault injection is
an importable test callback; the CLI has no fault-injection switch.
