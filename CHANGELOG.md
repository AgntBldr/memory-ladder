# Changelog

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
