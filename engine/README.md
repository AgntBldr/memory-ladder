# Memory engine v3

## Section list

1. [Commands, ladder and caps](#commands-ladder-and-caps)
2. [Exact block conservation](#exact-block-conservation)
3. [Conversion procedure](CONVERT.md) and [upgrade recovery](UPGRADE.md)
4. [Rotate the brain log](#rotate-the-brain-log)
5. [Shelf and review dates](#shelf-and-review-dates)
6. [External shared-core edges](#external-shared-core-edges)
7. [Generate the roadmap overview](#generate-the-roadmap-overview)
8. [Generate the brain indexes](#generate-the-brain-indexes)
9. [Kit ownership](#kit-ownership)

## Commands, ladder and caps

Stage 2: `memory-migrate.mjs convert --memory-dir D [--source FILE]
[--classes FILE] [--tag NAME] [--write]` splits original lesson blocks without changing their
body bytes (including CRLF). The default is a JSON dry run. A classes JSON object
maps every assigned id, including unnumbered/duplicate ids, to one craft activity.
Write mode refuses unparsed candidates and existing targets, writes lesson files
and index lines first, then replaces the source with a recovery stub. A stub run
is a no-op. Missing dates are reported; they are never inferred from later lessons.

`lessons.cite` fails on unresolved `#N`/`#Nb` references in craft indexes or the
router once lesson files exist. `brain.pointer` fails on invalid/missing `brain:`
targets; `brain.pointer-missing` warns for project/reference memories whose name
exactly matches a brain id after removing its type prefix and trailing date.

Gate and measure accept `--no-git` for fenced migration copies. This invokes no
git commands and emits `repo.git-skipped`: git health and committed-age coverage
are explicitly unavailable. Related allow entries are not assessed for staleness.

Conversion procedures and review gates live in [CONVERT](CONVERT.md).

Dependency-free Node 22 tools for gating, searching and measuring private Claude
memory and the repository's typed markdown brain. No package installation is
needed. All scripts are importable ESM modules; importing them has no CLI effects.

Every CLI accepts `--memory-dir PATH` and `--repo PATH`. The repo defaults to this
toolset's repository. Memory precedence is `--memory-dir`, `CLAUDE_MEMORY_DIR`, installed
`scripts/memory/KIT.local.json` `memoryDir` (only when that directory exists), then the matching
`~/.claude/projects/<absolute-repo-path-slug>/memory` directory (case-insensitive
fallback; home from `USERPROFILE` then `HOME`). Explicit paths are recommended for fixtures and migrations.

| Tool | Purpose and example |
| --- | --- |
| `memory-check.mjs` | Size, links, descriptions, secrets, lesson identities, git health and brain integrity. `node scripts/memory/memory-check.mjs --scope memory` |
| `memory-recall.mjs` | Weighted BM25 search. `node scripts/memory/memory-recall.mjs "model routing" --k 5` |
| `memory-measure.mjs` | Session bytes, hard-rule trigger bytes, ladder/search recall cost, gate counts and correction proxy. `node scripts/memory/memory-measure.mjs --probe path/to/probes.json --json` |
| `memory-conserve.mjs` | Prove token presence or exact block conservation. `node scripts/memory/memory-conserve.mjs snapshot --out baseline.json`; then `node scripts/memory/memory-conserve.mjs verify --baseline baseline.json`. See block mode below. |
| `memory-migrate.mjs` | Split numbered lessons; dry run by default. `node scripts/memory/memory-migrate.mjs convert --repo PATH --memory-dir COPY --source lessons.md`. `--source` is one Markdown filename inside memory; `--write` applies the migration. |
| `install-hooks.mjs` | Install the memory repo's pre-commit gate; `--uninstall` removes only this tool's hook. Foreign hooks are preserved. |
| `lib.mjs` | Paths, restricted frontmatter parsing, links, file discovery and common CLI helpers. |

Gate output supports `--json`. `--session-start` emits at most five lines and
always exits zero; normal gate runs exit one on a non-allowed FAIL. Memory scope
does not gate brain files, but reads node names/ids to resolve memory wikilinks.
Normal runs are read-only, including git status/history inspection. No tool
commits, pushes, installs dependencies or invokes a model.

Keep snapshots, tags and review evidence in durable project storage before deleting a migration work copy.

`memory.config.json` controls caps, pins and allow entries. `--ratchet-pins` sets
each hand-written index pin to the smaller of its old pin and current bytes plus slack; it
never raises an existing pin and removes obsolete pins. `--config FILE` lets the
gate operate on a fixture config instead. `--write-allowlist "reason"` appends
current findings, deduplicated by check and file. Both options write the config.

Allow entries require `check`, `file`, a nonempty `reason`, and `added` (UTC
`YYYY-MM-DD`), and may carry `ceiling`. The file pattern supports `*`. Matching
findings remain in JSON with `allowed: true`, but do not count as failures or
warnings. The allowlist is a RATCHET: `--write-allowlist` records the measured
value as `ceiling`, and a finding that grows past its ceiling is reported again
(`grew past allowed ceiling N`); the writer never raises a ceiling and never adds a
per-file entry under an existing wildcard entry. Never raise a ceiling or a pin to
make the gate pass: move the detail down a layer. An entry without `ceiling` is for
files that grow by design until they are rotated (the roadmap and the brain log).
`secret`, `config.*` and parse-error (`fm.parse` FAIL) findings cannot be allowed.
Missing fields or a bad ceiling fail `config.allow`; an entry for a check the run
evaluated that matches nothing warns `config.allow-stale` (memory scope skips the
repo layer, and `--hook` skips the remote/ahead/uncommitted checks).
Every finding message is passed through redaction: a secret is shown as
`[REDACTED:<pattern>]`, never as text.

`--hook` is what the memory repo's pre-commit runs (`--hook --scope memory`): it
checks a staged snapshot extracted with git checkout-index. Snapshot errors block
the commit. SessionStart alone remains nonblocking. A stub
is a file with `moved_to:` (a filename or a list); each target must be an existing
file inside the memory directory, or a `brain/...` path inside the repo.

`repo.skill-version` warns in `--scope all` and `--session-start` when an existing
`.claude/skills/memory-ladder/SKILL.md` or `.claude/skills/memory-review/SKILL.md`
has a missing or mismatched frontmatter `engine_version`. Compare against
`memory.config.json` (currently `3.2.0`). Absent files produce no finding.
`--hook` and memory-only scope skip this check and its allowlist-staleness check.
Update the instructions and version together; do not merely stamp stale prose.

Recall accepts `--memory-only`, `--brain-only`, `--json`, and `--probe [FILE]`.
The default probe file is `scripts/memory/recall-probes.json`, supplied separately;
this toolset does not create it. Probes match any expected path substring in the
top three results and exit one below `minPass`. Measure uses the same probe file;
`--write LABEL` creates JSON and Markdown evidence in
`<measure.evidenceDir>/YYYY-MM-DD-LABEL.*` (default `docs/evidence/memory`). Without it, no evidence is written.
`sessionStart` counts the router, `AGENTS.md`, `CLAUDE.md`, and the last
`measure.startLogTailEntries` (10) complete brain-log entries. An entry starts at
a line beginning `## [` and ends before the next entry; omit the log preamble.
With fewer entries, count all entries; with none, count zero log-tail bytes.
`sessionStartLegacy` retains the old metric using `measure.startLogTailLines`
(40), including the old terminal-newline handling, for comparison with earlier
measurements. Both values appear in JSON and the readable metrics table.
Both tail settings must be positive integers; invalid values stop measurement
with an error naming the setting.
Conservation accepts `--accepted FILE` with migration decisions recorded
as `{ "accepted": [{ "token": "...", "reason": "..." }] }`; every reason is required.
Token conservation checks memory, all brain Markdown (including system files),
ROADMAP files, and `docs/shelf/**/*.md`; an absent shelf is fine. It proves token
presence, not semantic equivalence. Forgetting is a proxy,
not a measured recurrence rate; undated corrections have no month bucket.

## Exact block conservation

```sh
node scripts/memory/memory-conserve.mjs blocks-snapshot --out blocks.json --source docs/ROADMAP.md --source brain/00-system/log.md
node scripts/memory/memory-conserve.mjs blocks-verify --baseline blocks.json --dest docs/ROADMAP.md --dest docs/ROADMAP-HISTORY.md --dest brain/00-system/log.md --dest brain/00-system/log-history.md --json
```

Name every source and destination explicitly; repeat `--source` or `--dest`.
Paths may be absolute or relative to `--repo` (default: this repository).
Duplicate spellings of one path are read once. Block mode does not access the
private memory directory. Missing input files fail instead of becoming empty
sources. A source with zero blocks also fails snapshot creation; empty
destinations remain valid so verification can report missing blocks. Keep the
snapshot outside the moved sources.

Split at lines beginning `## ` outside backtick or tilde fences. Preserve any
text before the first heading as a `kind: preamble` block. Strip a leading UTF-8 BOM
before splitting and normalize CRLF to LF. Drop each block's trailing blank lines
and newlines, then add exactly one `\n` before hashing and counting bytes.
Preserve all other whitespace, including spaces on nonblank content lines.
This lets a last block without a final newline move into the middle of a file.
Each record has repository-relative `source`, zero-based `index`, `heading`
(first line, truncated to 200 characters), UTF-8 `bytes`, and `sha256`. A
`headingSha256` retains full-line identity for long headings; `kind` distinguishes
preamble from section. Empty files have no blocks.

Verify exact hash multiplicity across all destinations: 2 baseline copies need
2 destination copies. Report `missing` for absent copies, `altered` when a
replacement has the same complete heading and a hash not accounted for by any
baseline block, `duplicated` for
extra hash copies, and `out-of-order` for a source's blocks reordered within a
single destination. Splitting a source across destinations imposes no order
between destination files. Extra unrelated blocks are not failures.
For identical blocks shared by sources, the disambiguation search is bounded
at 10,000 candidate attempts and 512 levels. If the bound is hit, retain the
out-of-order finding for review rather than claiming order was proven.

Use `--accepted FILE` with
`{ "accepted": [{ "source": "docs/ROADMAP.md", "heading": "## Old work", "reason": "Reviewed retirement; retained in git." }] }`.
Match the snapshot's source and heading exactly. Add a zero-based `index` when
that pair matches multiple baseline blocks; omitting it is an ambiguity error.
An optional index must be a nonnegative integer. Require a nonempty reason for
every entry. A matching finding becomes `accepted`, retains its underlying
findings, and no longer fails. Other conserved blocks remain `ok`. Entries
matching no baseline block are printed as `unused accepted entry`; they do not
fail verification and are included in JSON as `unusedAccepted`.

Text output prints counts by class, then each non-ok block's class, source,
index and heading, with destination locations for altered blocks. Limit details
to 50 block lines, then print `… N more (use --json)`. `--json`
prints every baseline block, status, expected/actual multiplicity, destination
matches, underlying findings, and accepted reasons. Exit 1 for any non-accepted
finding or invalid input; exit 0 when every baseline block is ok or accepted.
Missing or unreadable baseline and accepted files report `cannot read <file>`.
Use tokens and blocks together: neither proves semantic equivalence of rewrites.

Run `node --test scripts/memory/memory.test.mjs` for isolated OS-temp fixtures.
Node 22.22.2 does not discover tests from `node --test scripts/memory/`; that
directory argument fails with `MODULE_NOT_FOUND`. Tests create no real git repos,
run no git commands, and never inspect real memory or the brain. Run
`node --check scripts/memory/<file>.mjs` for syntax checks.

Background parts are linked from their parent topics. The orphan check follows memory links from router/index/archive roots and detects missing background targets; unrooted cycles do not establish reachability.

## Rotate the brain log

`node scripts/memory/memory-rotate.mjs log [--keep N] [--write] [--json]`
keeps the last 20 entries by file position by default (`caps.brainLog.keepEntries`).
Dry runs report destination entry counts and bytes. Write mode preserves the
preamble and appends older entries unchanged to `log-YYYY-MM.md`, using each
entry's own date even when dates are out of order. Backtick and tilde fenced
headings do not start entries. Invalid dates refuse all writes and name the line.
A repeat run reports `nothing to rotate`. The importable API is `rotateLog`.
`--keep` requires a non-negative integer. Interrupted appends resume without
duplicating a completed entry prefix; destinations receive a newline before
appended entries when needed. The live log is replaced through a temp-file rename.

## Shelf and review dates

Every `docs/shelf/**/*.md` requires `status: shelved`, `shelved: YYYY-MM-DD`,
and `review: YYYY-MM-DD`. Missing or invalid fields fail `shelf.frontmatter`.
The gate fails `shelf.frontmatter` when review is more than `caps.shelf.reviewDays`
(default 90) days after shelved; choose and record the actual review date when shelving.
`shelf.review-due` warns on or after that UTC date. The gate accepts
`--today YYYY-MM-DD` for tests and dry runs; `runCheck` accepts the `today` option.
An absent shelf has no shelf findings. Shelf content is checked in repo scope.

## External shared-core edges

Unresolved edges under `caps.brainShared.paths` (default `brain/_shared/`) are
collected in JSON `externalEdges` as `{file, key, target}` instead of warnings.
Normal text output reports their count; session-start output omits it. Other
checks still apply to shared nodes. Unresolved local edges still warn `brain.edge`.

## Generate the roadmap overview

`node scripts/memory/roadmap-overview.mjs [--write|--check]` prints the generated
overview by default, writes `docs/ROADMAP-OVERVIEW.md` with `--write`, or exits 1
when missing or stale with `--check`. `generateOverview` reads the roadmap release
labels and continuations, Open work lists, Active headings, sorted shelf metadata,
and history headings. It uses content only, never file dates or current timestamps.
History is read from `caps.roadmapHistory.path`.
The gate warns `repo.roadmap-overview` when an existing overview is stale and never writes it. An absent configured file produces no finding.

## Generate the brain indexes

`node scripts/memory/brain-index.mjs [--write|--check]` prints the compact index
by default; write/check mode covers both `index.md` and `index-all.md` in
`brain/00-system/`. `generateIndex` uses the gate's node discovery, id sorting,
and frontmatter updated dates for recency. Only `YYYY-MM-DD` node dates contribute
to recency. The pillar is selected by type; System links come from
`caps.brainIndex.systemFiles` (the seven default files). Existing compact-index
frontmatter is preserved except its updated date. The compact output may not exceed 12,288 bytes;
overflow refuses output instead of truncating it. `--config FILE` supports fixtures.
The gate keeps its no-wikilinks warning and also warns on stale generated indexes.

## Extra token-conservation files

Repeat `--file PATH` for repo-relative files in token `snapshot` and `verify` modes.
For example, `snapshot --out tokens.json --file AGENTS.md`. Baselines record
`extraFiles`; verify reuses those paths and adds any supplied `--file` paths.
The APIs accept `extraFiles`. Missing tokens still fail; this does not change
block mode or prove semantic equivalence.

## Kit ownership

Run every engine CLI in this distribution with explicit `--repo PROJECT --memory-dir MEMORY`.
Installed copies infer their project from the engine location. Projects without a brain, roadmap or shelf receive no findings for absent configured paths.
When KIT.json exists, `kit.manifest` warns for each locally edited or missing owned file and for skills whose `engine_version` differs from the installed kit version. A missing or malformed manifest warns as well. Config, probes and the receipt are project-owned and excluded from hashes.
The migrator defaults to `lessons.md`; a supplied Markdown source name remains the stub name. A longer outer fence contains shorter fences without starting lessons inside it.

Normal text gate runs print `memory: <dir> (<source>)`; JSON output remains JSON,
and SessionStart stays compact. Custom paths live only in ignored `KIT.local.json`.
Manifest hashes normalize CRLF to LF. Missing, unreadable or malformed manifest
content yields WARNs. Generated brain/roadmap checks run whenever their source exists.

## Generated memory indexes (3.2.0)

Capture: `node scripts/memory/memory-lesson.mjs new --route <family>[,<family>] [--pin] [--today YYYY-MM-DD] "<title>"`.
`--today` sets the lesson date and dated heading; omitted, it uses the current UTC date.
The installed template is `scripts/memory/templates/lesson.md`. Fill TODO before the gate.
Lesson identities have at least three digits and optional lowercase letters; capture allocates the next numeric part.
Metadata route, pin, hook (at most 200 characters), and supersedes override top-level fallback values.

Rows and hot-page sentences use `caps.index.warnLineChars` (default 300), shortening descriptions with …. Immutable link prefixes can exceed the cap.

`memory-index.mjs --write` generates hot pages and catalogs; `--check` rejects drift.
`caps.index.hotBytes` defaults to 8192. Topics and pins always remain, with index.hot-budget WARN
for overflow. Catalogs paginate at 24576 bytes. Superseded lessons remain in the catalog.
Generated pages skip hand-written pin rules; index.stale requires regeneration.
lessons.duplicate, route.missing, route.unknown and lesson.unfilled are FAIL checks.
Staleness applies to state and caps.stale.types (project and reference by default).
kit.version fails same-version engine drift; kit.manifest still warns on local edits.

`memory-rotate.mjs roadmap --write` preserves dated Open work blocks in roadmapHistory.path,
keeping six by default (caps.roadmap.keepBlocks), or at least two under size pressure.
The printed proof compares moved payload bytes and verifies every block in history.

`node scripts/memory/memory-checkpoint.mjs` runs indexes, log rotation, roadmap rotation, brain index,
roadmap overview, gate, memory commit, and push in order. Missing optional project files are skipped.
A failed or timed-out push is reported and exits 2; the commit remains. --no-push skips it; --dry-run writes nothing.
`--today YYYY-MM-DD` sets the checkpoint date, including the gate's stale checks and rotation checks.
One .memory.lock covers all in-process steps. Writers wait up to 30 seconds; stale locks break
only after ten minutes with a dead pid on this host. Foreign-host locks require manual inspection.
