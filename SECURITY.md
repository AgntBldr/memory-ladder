# Security

## Automatic execution

The SessionStart hook command `node "${CLAUDE_PROJECT_DIR:-.}/scripts/memory/memory-check.mjs" --session-start` runs the project's own installed copy at every Claude Code session start.
The memory repository's pre-commit hook runs `node "<PROJECT>/scripts/memory/memory-check.mjs" --hook --scope memory --memory-dir "<MEMORY>"` from the project at every memory commit (the placeholders are absolute, shell-quoted paths).
Nothing else runs automatically; the engine makes no network calls.
The gate uses `scripts/memory/MANIFEST.json` to report edited kit files.

The memory hook preserves a foreign pre-commit hook and honors a configured hooks directory. If Node is missing, the installed memory hook reports that it skipped the gate.
The installed instruction block and skills tell the agent to run the gate, recall, and, at checkpoints, generators that write files; these run when the agent runs them, not automatically.

## Installation writes

Installation writes the engine (including memory.test.mjs and README.md), the CONVERT.md and UPGRADE.md guides, two skills, hash manifest and KIT.json receipt. Engine files and guides go under scripts/memory/; skills go under .claude/skills/. It merges the SessionStart hook into .claude/settings.json, adds the memory-gate block to AGENTS.md (or CLAUDE.md when that is the only instructions file), and creates CLAUDE.md when absent.
Config and recall probes are created when absent; an existing config gains missing pins without raising existing ones. When no memory router exists, it creates missing starter memory files; existing memory files are preserved.
When the memory folder has no commit, install runs git init if needed and commits everything already in that folder with git add . followed by git commit. Point --memory-dir only at a folder meant to be the memory repository.
It installs the memory pre-commit hook, records custom memory paths in scripts/memory/KIT.local.json, and adds local ignore rules in scripts/memory/.gitignore.
When brain/00-system/ exists in the project and projectConfig.caps?.brainIndex is truthy, install runs brain-index.mjs --write, which rewrites the project's brain index file. It also rewrites the all-files index at caps.brainIndex.allPath.
Reinstallation refuses. Conflicting owned files require --backup, which moves their original bytes into a timestamped backup before installation.

## Upgrade writes

An upgrade creates a timestamped backup and replaces kit-owned files, manifest and receipt. It rewrites scripts/memory/memory.config.json with merged defaults and the new engine_version. Project probes, hooks and instruction blocks are kept. Edited skills are kept unless --force-skills is requested. New FAIL findings trigger rollback; pre-existing FAIL findings are reported. A failed rollback reports the recoverable backup and restore command.
Upgrade runs the target project's own installed scripts/memory/memory-check.mjs before changes to record existing FAIL findings and again after changes to detect new ones.
It uses that project's KIT.json and MANIFEST.json to decide what to replace or remove, backing files up first; old-manifest paths outside scripts/memory/ and .claude/skills/ are refused.
Read or compare the project's scripts/memory/ with the kit's engine/ before upgrading a project you did not write: upgrading runs that project's code, as running its tests would.

## Paths and projects you did not write

--target and the memory folder are resolved with path.resolve; symlinks are not resolved. Memory folder precedence is --memory-dir, then CLAUDE_MEMORY_DIR, then an existing folder recorded in KIT.local.json, then the default project-path slug under the user's Claude projects folder.
Only the measurement evidence folder is contained in the project by realpath. The installer does not apply that containment to the target or memory folder. A cloned project can commit its own scripts/memory/KIT.local.json: read it before installing into a project you did not write.

## Reporting

Use GitHub private vulnerability reporting when this repository enables it. Otherwise open an issue titled security: with no secrets in it.
