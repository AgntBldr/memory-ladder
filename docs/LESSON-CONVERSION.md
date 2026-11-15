# Convert topic-file memory into numbered lessons

Use this guide when a project's memory holds its know-how in topic files and the gate keeps reporting
`index.hot-budget`. It is the procedure three projects followed in 2026-10 and 2026-11, written so another project can
repeat it. Steps 0 to 3 have been run end to end with the tools named here; steps 4 to 6 use `promote`, which ships in
3.3.3.

## 1. Know the cause before you act

A generated hot index page (`INDEX-<family>.md`) lists every routed **topic** file, then pinned lessons, then the
newest **numbered lessons** that fit the 8,192-byte hot budget. Older lessons move to the catalog page on their own;
topics never do. A memory written mostly as topic files therefore overflows its hot pages, and nothing short of
numbering its lessons fixes that. Shortening descriptions, raising pins or allow entries, and compressing rule cards
all fail: compressed cards grew back over their limit in 7 of 12 cases in one project.

A file is a lesson only when its name is `lesson-NNN[suffix]-slug.md`. Frontmatter alone does not make one.

Rule going forward: **know-how is a numbered lesson** (`memory-lesson.mjs new`); topic files hold state, facts and
references.

Signs you need this guide:
- The gate shows `index.hot-budget` WARN on most hot pages.
- `memory-fleet.mjs` reports few or no lessons beside hundreds of topics.
- Projects measured on 2026-11-10: 410 lessons and about 102 topics, 0 of 8 pages over; 0 lessons and 560 topics,
  10 of 13 over; 123 lessons and 913 topics, 12 of 13 over.

## 2. Roles and cost

| Role | Who | Does |
|---|---|---|
| Orchestrator | the session's top model | writes specs, reviews every built diff, adjudicates, runs the final gates |
| Build lane | a repository agent with its own sandbox | builds tools test-first, runs only the tests it touched |
| Labellers A and B | two independent sessions of a cheap model (different reasoning effort helps) | label blind bundles |
| Third labeller C | a different model | labels disputed rows blind, mixed with known rows |
| Person | the memory's owner | rules on scope, recovery form and the rows nobody can settle |

A lane never runs the full suite and is never its own final gate. The orchestrator reviews the diff, not the report.
Keep each lane run under about 10 minutes and resume a killed run by its session id rather than starting over.

## 3. The procedure

### Step 0. Engine and canary
1. Upgrade the project to 3.3.3 or later (`node scripts/upgrade.mjs --target <PROJECT> --check`, then without
   `--check`). 3.3.2 stopped bare `#N` pull-request numbers from counting as lesson citations; under 3.3.0 the first
   lesson file turned 23 PR numbers into FAILs.
2. Canary: `git clone --no-hardlinks <memory> <copy>`, run `memory-lesson.mjs new --memory-dir <copy> ...`, fill the
   TODO description and the Why/How body, regenerate and gate the copy. Expect 0 FAIL.
3. Find which engine the memory pre-commit hook runs (`<memory>/.git/hooks/pre-commit` names a project checkout).
   The hook embeds its installing engine version and refuses a checkout whose KIT.json version is
   older, naming both versions and the checkout without changing memory files. Rerun `install-hooks.mjs` to refresh an existing owned hook; upgrades
   refresh existing owned hooks on a best-effort basis. Make sure that checkout carries this engine at the live step.
4. If the project's AGENTS.md or CLAUDE.md names a kit version, update it with the person's approval.

### Step 1. Census
Run `node scripts/memory/memory-census.mjs --memory-dir <copy> --repo . --out <evidence>/census`. It classifies every
memory file (system, index support, state, hard rule, roadmap, chain head or part, doc-referenced, orphan, candidate,
other by type), lists every repository file that names a memory file, and projects each family's hot bytes if its
candidates became lessons. Default reference roots are AGENTS.md, CLAUDE.md, `scripts/`, `.claude/`, `docs/` and
the configured knowledge folder; repeat `--refs <path>` to add others. The output directory may be anywhere. Read the projection before anything else: it tells you whether numbering lessons is enough.

Measured trap: a `type: feedback` filter is wrong. In two projects many `type: project` notes were plainly lessons
("a renamed env var is a silent provider outage"); judge lesson-ness on content.

### Step 2. Rulings from the person
Put these to the person, each with a recommendation, before labelling:
- Build or upgrade to the kit converter (recommended) or a local script.
- Recovery form: one name map plus `metadata.source` plus a git tag (recommended), or a stub at every old name
  (`promote --stubs`; choose it when references outside memory cannot be searched).
- Scope: everything that qualifies after a one-family pilot (recommended), or only enough to fit the budget.
- Unrouted notes, orphans and chain heads: label them too (recommended); a chain head is never renamed.
- Who settles rows the labellers cannot: precedent from another project's lessons, then a third model, then the person.
- Pins: none at first; the person picks at most 3 per family afterwards.

### Step 3. Blind labelling
`memory-label.mjs` builds and scores the run. All bundles and outputs hold private memory text: keep them out of git.

1. **Build.** `memory-label.mjs build --census <census.json> --memory <copy> --reference <another project's memory>
   --key-dir <outside the repo> --out <evidence>/run --seed <n>`. Rows get opaque ids; the filename, type, route,
   kind and every hint field are stripped, and memory filenames inside bodies are masked. Bodies are cut to the first
   4,000 and last 1,000 bytes over 5,000. At most 28 project rows per main bundle, plus two reference sentinels.
2. **Calibration.** Three bundles: 60 lessons from a reference project with known kinds (36 mistake, 13
   practice, 11 observation), 20 of its non-lesson topics as negatives, and about 10 of your rows. Score with
   `memory-label.mjs merge --key-dir <KEY> --out <RUN> --bundles r0-1,r0-2,r0-3`, then
   `memory-lesson.mjs classify --score <RUN>/A.holdout.kinds.json <RUN>/B.holdout.kinds.json --reference <RUN>/holdout.json`.
   The merge writes a reference containing only the selected bundles. Proceed only when both labellers pass the
   historical mark (84% overall, 70% practice and observation), A and B disagree on at most 15%, and each labeller marks
   at least 90% of reference lessons as lessons and 70% of negatives as non-lessons.
   - If both labellers miss the same rows, read three of them before changing anything. In one run two of three shared
     misses were errors in the reference itself and one was a labeller reading a corrected plan as harm.
   - The fix that worked was a short clarification appended to the prompt (cases unchanged): harm means someone relied
     on or acted on the wrong thing; a wrong plan caught before use is not harm; a near-miss whose title names the
     catching step is practice (K4); an overturned accepted verdict is mistake (K5); tool behaviour under normal use is
     observation (K2) unless our own command shape caused it (K3). Then rebuild with a new seed and rerun calibration once.
     Measured: 50/60 and 15/24 before, 52-56/60 and 20-22/24 after.
3. **Main run in small batches.** Run 3 bundles first and check them; then batches of 4 bundles (8 sessions). A run
   whose JSON fails `memory-label.mjs check` is resumed once with the validator's one-line message. Two hold-out
   lessons ride in every main bundle as drift sentinels.
4. **Merge and sheet.** A dispute is only: `lesson` differs; both say lesson and `kind` differs; both say non-lesson
   and `disposition` differs; a `needs_route` row's route differs; a `no_rename` row's extract is empty for one side.
   Confidence, reasons, case ids and trigger wording are reconciled, not disputed (trigger kept only when both gave
   one; the shorter wins). Measured: 52 disputes in 419 rows (12.4%); lesson yes/no disputes 4.1%; kind test 6.75%.
5. **Settle** in this order, recording `settled_by` per row: a K-case or the lesson test clearly applies; the nearest
   reference-project lesson is precedent (`memory-recall.mjs --memory-dir <reference>`); a third model labels the
   still-open rows blind, mixed with 10 agreed rows and 5 known lessons, majority of three; the rest go to the person in
   a short table. No tie-break is silent.
6. **Audit.** The orchestrator reads 30 random agreed rows plus agreed rows where both confidences are under 0.6. More
   than 3 wrong of 30: widen the sample before emitting.
7. **Emit** with `memory-label.mjs emit --key-dir <KEY> --out <RUN> --census <census.json> --memory <copy>`: `promote-map.json` (lessons that may be renamed), `extract-batch.md` (new short lessons that link a chain
   head or a doc-referenced file, which are never renamed), `dispositions.md` (non-lessons: stays topic, belongs in the
   project knowledge folder, or ARCHIVE) and `family-projection.md`. Measured: the agreed lessons alone brought all 13
   families of one project under 8,192 bytes, so moving facts out of memory was not needed for the budget. The projection
   also lists each map row's date and source, with totals for body, git, modified and other sources, using promotion's date logic.

After the full run, repeat `merge` without `--bundles`, then run:

```sh
node scripts/memory/memory-label.mjs sheet --key-dir <KEY> --out <RUN>
node scripts/memory/memory-label.mjs disputes --key-dir <KEY> --out <RUN> --per 25
node scripts/memory/memory-label.mjs settle --key-dir <KEY> --out <RUN> --decisions <DECISION.json>
node scripts/memory/memory-label.mjs third --key-dir <KEY> --out <RUN> --seed <N>
node scripts/memory/memory-label.mjs check --bundle <RUN>/third/c01.md --result <THIRD.json>
node scripts/memory/memory-label.mjs settle --key-dir <KEY> --out <RUN> --from-third --decisions <THIRD.json>
```

Repeat `--decisions` for multiple decision files. Later decisions replace pending, unclear or third-labeller
outcomes; operator decisions always win. The third bundle needs ten agreed project rows and five reference lessons;
`third-log.md` records every vote and scores the fifteen controls. Keep the key directory separate from labellers.
A build requires enough distinct labelled reference lessons for the calibration sample and two sentinels per main
bundle, plus twenty reference topics. It reports insufficient samples before writing anything.

### Step 4. Rehearse on a copy
1. Tag the memory repository, clone it, and run `memory-conserve.mjs snapshot` on the clone.
2. `memory-migrate.mjs promote --memory-dir <copy> --repo . --map promote-map.json --also <knowledge folder>` (dry run).
   Read `refused`, `dates` (how many rows rest on `git` or `modified` dates) and `rehearsal` (files copied).
3. Pilot one small family with `--write` on the copy, then all families.
4. Proofs, all on the copy:
   - promote's own: each body equals the original with exactly the planned filename and link rewrites, and reversing
     them restores the original bytes; zero remaining old-name references; no recall probe lost; no new gate FAIL.
   - `memory-conserve.mjs verify` reports 0 missing tokens.
   - Self-recall: for every memory file except router, ARCHIVE and indexes, query its description (plus its first body
     sentence over 30 characters, capped at 200) and record its top-10 rank before and after, a renamed file counting
     as itself. Before promotion run `memory-selfrecall.mjs snapshot --memory-dir <copy> --repo . --out <snapshot.json>`.
     Afterwards run `memory-selfrecall.mjs compare --before <snapshot.json> --memory-dir <copy> --repo .
     --map <promote-map-STAMP.json>`. It prints each regression and exits 1 if any rank is worse.
     Accept zero worse ranks. One project ran 735 such queries with none worse.
   - Inbound links: search the repository (AGENTS.md, CLAUDE.md, scripts, `.claude/`, specs, the knowledge folder) for
     every old filename and `[[old]]`. Promotion scans AGENTS.md, CLAUDE.md, `scripts/`, `.claude/` and `docs/`
     by default when `--repo` is given. Repeat `--scan <path>` for specs and other roots. These scans are read-only,
     use the rehearsed rewrites and report `external_references` with file and line. Unprotected hits refuse a write;
     `--protect <file>` lists old filenames that must stay in place, one per line. Accept zero unprotected hits
     outside `metadata.source` and the name map.
   - The gate on the copy shows no `index.hot-budget` WARN.
5. Lesson dates: promote reads the first date in the opening body lines before git or `modified`. Measured: in one
   memory no labelled note had `metadata.date`, and both `modified` and first-commit dates clustered on the day of an
   earlier bulk migration. Body dates covered about 75% of notes.

### Step 5. Review by a different model
A model that did not build the change reads the copy's diff, the name map and the proofs, and lists every original
imperative it finds weakened or lost. Adopt only when that list is empty.

### Step 6. Replay on live memory
Tag live memory, check live still equals the snapshot the copy started from, run the same command with the same map,
rerun every proof, compare live with the proved copy, run `memory-index.mjs --write`, the gate and
`memory-checkpoint.mjs`, then stage named files and commit.

### Step 7. Remaining warnings
Clear each remaining WARN class by its proven move, each on a copy with an exact-reconstruction proof: oversized topics
become verbatim background parts (`memory-chains.mjs`); oversized rule cards move background material out or split by
trigger, never by compressing text; a router over 12 KB moves stale active-work lines verbatim behind one pointer;
repeated lessons get triggers; character and chain findings use the kit's repair commands. Never raise a cap.

### Step 8. Keep it from coming back
Capture each new piece of know-how with `memory-lesson.mjs new --kind <kind> --route <family> --trigger "<when>"`.
Write a topic file only for state, facts and references.

## 4. Traps seen so far
- Filtering candidates by `type: feedback` (missed 180 lesson-shaped `project` notes in one memory, 23 in another).
- Lesson dates from `modified` or first commit after a bulk rewrite.
- Bare `#N` PR numbers in index hooks under an engine older than 3.3.2, and a pre-commit hook pointing at a checkout
  on an old branch.
- A dispute sheet that counts confidence or wording differences (396 "pending" instead of 52).
- A full test suite run while a lane is still editing the same tree; and a full suite run before review fixes land.
- Copying a whole repository with nested worktrees into a rehearsal (promote stages tracked files only).
- Committing labelling bundles, which contain the memory's private text.
- New index families or rule cards each cost a router line; check router headroom.

## 5. Reuse the procedure in another project
`docs/LESSON-CONVERSION-PROMPT.md` is a prompt to paste into a session in that project. It runs steps 0 to 3, stops for
the person's rulings and again before the live replay, and reports with numbers.
