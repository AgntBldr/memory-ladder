# Memory ladder kit — install in a minute, first checkpoint in about twenty

Node 22 or newer and Git are required; there are no package dependencies.
The engine is 3.1.0.
The kit repository is the original; installed engines and skills are copies.

Acquire the kit with `git clone --branch <tag> <KIT_REPOSITORY_URL> memory-ladder-kit`,
or copy the kit folder. Replace `<tag>` with a release tag and
`<KIT_REPOSITORY_URL>` with this repository's clone URL.

From the kit folder, with `<PROJECT>` replaced by your project root:

```sh
node scripts/install.mjs --help
node scripts/install.mjs --target <PROJECT> --dry-run
node scripts/install.mjs --target <PROJECT>
```

Use `--memory-dir <MEMORY>` for an existing private memory directory. Otherwise
selection is `CLAUDE_MEMORY_DIR`, an existing directory recorded in `KIT.local.json`,
then `<home>/.claude/projects/<absolute-project-path-slug>/memory`. Home is
`USERPROFILE`, then `HOME`; replace every non-alphanumeric path character with `-`.
The git-ignored local record remembers custom paths for later unflagged gates and hooks.
`KIT.json` contains no machine path; missing local directories fall through to the default.

The final line resembles `memory-check 3.1.0 [all]: 0 FAIL, 1 WARN, 0 allowed, ...`.
**Green for a fresh install means 0 FAIL.** The expected first-run WARN is
`repo.remote`: the newly initialized memory repository has no remote. Clear it with
`git -C <MEMORY> remote add origin <PRIVATE_REMOTE>` and
`git -C <MEMORY> push -u origin HEAD`. Existing memory may have other findings;
read those files and repair the reported cause before adoption.

Install writes the engine, two skills, a hash manifest and receipt, merges a
SessionStart hook without removing other settings, appends the AGENTS memory gate
once (in `CLAUDE.md` when that is the only instructions file) and creates `CLAUDE.md`
only if absent. Malformed or non-object settings stop before writes; an existing hook
leaves settings bytes unchanged, including a UTF-8 BOM.
Project config and probes are created only when absent. The starter router, session
index and current-state file are created when no router exists; existing memory
files are preserved. Missing pins are initialized without raising existing pins.
A memory repository with no HEAD gets one baseline commit, including a previously
initialized repository whose first commit failed. Repositories with history get none. If Git has no identity, the baseline alone uses the reported kit identity.
A foreign pre-commit is preserved and reported. Repeat installation refuses with `already installed (kit X); run scripts/upgrade.mjs`
and writes nothing. Fresh installs refuse differing kit-owned destinations before
writing; `--backup` moves their original bytes into a timestamped
`scripts/memory/.kit-backup-<UTC>/` directory before proceeding. Dry run prints
planned writes without performing them.

The first checkpoint needs project-specific probes, the single CURRENT block,
and a private remote for the memory repo. From the project root, run:

```sh
node scripts/memory/memory-check.mjs
node scripts/memory/memory-recall.mjs "current task"
node scripts/memory/memory-recall.mjs --probe
node scripts/memory/memory-measure.mjs --write first
```

Write the current task and next action into the single `## CURRENT` block.
Replace example probes with questions and expected file paths from your project.
The example probe is intentionally small; it is not a claim about your recall quality.
For an existing brain log/index or roadmap, run the applicable checkpoint generators
described in the [engine reference](engine/README.md), then the gate. Review the
memory diff, commit authorized changes and push to the private remote.

Undo: retain the memory repository and its history. Remove only the kit hook with
`node scripts/memory/install-hooks.mjs --uninstall --memory-dir <MEMORY> --repo <PROJECT>`.
Remove the exact kit SessionStart command from settings, the installed Memory gate
block if it was newly added, and only installed kit-owned files listed in
`scripts/memory/MANIFEST.json`. Preserve pre-existing instructions, config and probes.
Review against your pre-install diff before removing anything. There is no destructive
uninstaller. Upgrade recovery is described in [UPGRADE](docs/UPGRADE.md).

[STARTER](docs/STARTER.md) is the sheet for a new project: the first setup once, then every session.
[WHY](WHY.md) explains the ladder. [CONVERT](docs/CONVERT.md) handles existing memory.

Proofs: `npm test` runs isolated engine, install, conversion, upgrade and kit tests.
Install and conversion tests isolate both home variables and all temporary data.
`tests/install.test.mjs` proves install claims and elapsed time below five minutes;
`tests/kit.test.mjs` proves manifest, encoding, first checkpoint and hook removal;
`tests/convert.test.mjs` proves conversion mechanics; `tests/upgrade.test.mjs` proves
preservation and rollback. Human decisions and semantic review remain human work.

Figures in WHY are measured on one private project in October 2026; not shipped as evidence.

## What runs automatically after install

Install itself runs git init if needed, git add . and git commit in a memory folder with no commit, the gate, install-hooks.mjs, and brain-index.mjs --write when brain/00-system/ exists and projectConfig.caps?.brainIndex is truthy.
The SessionStart hook command `node "${CLAUDE_PROJECT_DIR:-.}/scripts/memory/memory-check.mjs" --session-start` runs the project's own installed copy at every Claude Code session start.
The memory repository's pre-commit hook runs `node "<PROJECT>/scripts/memory/memory-check.mjs" --hook --scope memory --memory-dir "<MEMORY>"` from the project at every memory commit (the placeholders are absolute, shell-quoted paths).
Nothing else runs automatically; the engine makes no network calls.
The gate uses `scripts/memory/MANIFEST.json` to report edited kit files.
Details are in [SECURITY.md](SECURITY.md).

## Unreleased (after v3.1.0-beta)

- The brain index includes `memory-ladder.md` by default and links only to system files that exist.
- Install generates the brain index when a configured brain is present; dry run reports the step without writing.
- Install and upgrade support `--help` and `-h` to list accepted options without changing files.
