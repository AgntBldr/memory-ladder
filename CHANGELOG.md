# Changelog

## 3.2.2

- Routers with the trigger before the link or in a table now supply a hot-page sentence, changing generated page bytes. Vendored users must run `memory-index.mjs --write` after updating, before the gate.

- Shorten generated hot-index sentences and row descriptions with an ellipsis at the warning cap (default 300); an immutable link prefix can still exceed the cap. Preserve Unicode code points and meaningful punctuation.
- Regenerate generated pages transactionally during upgrades; restore retains original bytes. After vendored updates run `memory-index.mjs --write` before the gate to avoid `index.stale`.
- Diagnose missing vendored hook gates, retain export errors through cleanup failures, and synchronize release documentation and pins.
- Resolve the pre-commit gate from the running engine when the installed gate is absent, and refuse hook installation when neither gate exists.

## 3.2.1

- Preserve router separators, merge continuation triggers at clause level, and capitalize sentences after lesson-count removal.
- Keep shipped-config assertions in kit tests so installed engine tests accept older project system-file lists.
- Count passed and skipped public tests and reject failed, cancelled, todo, or incomplete TAP summaries.

## 3.2.0

- Round 3: retain displaced lock records on stale-break contention and report their paths.
- Ignore unrelated enclosing repositories and scope nested-memory dirty checks to the memory subtree.
- Preserve prefixed index rows verbatim with hand-text proofs; exempt redirect indexes from pin checks.
- Reject invalid checkpoint dates before locks or writes, and refuse missing CLI date values.

- Round 2: bound redirect membership to non-index targets, preserve all hand row hooks with a pre-write proof,
  diagnose broken rows by page and line, and spill router overflow before checking caps.
- Extract only the staged memory subtree, resolve symlink paths, check nested-repo file ages, and accept CRLF indexes.
- Persist planned upgrade creations before memory writes; clean and exclude all `.memory.lock*` artifacts.
- Add simulated `--today` dates to capture and checkpoint checks; failed or timed-out pushes exit 2 with the commit retained.
- Atomic lesson capture and generated hot indexes with paginated catalogs.
- Routed migration with payload, byte-preservation and recall proofs; transactional upgrades.
- Staged-snapshot pre-commit gate, scoped staleness and engine version integrity.
- One locked checkpoint with roadmap rotation and bounded brain navigation.
- Round 1: preserve indexed redirect closures, curated hooks and overflow router prose during migration;
  refuse generated writes over hand-kept indexes and recognize continuation families.
- Normalize staged CRLF pages, support memory subfolders, and block hooks only on findings or snapshot extraction failures.
- Exclude checkpoint locks from staging, bound pushes, use in-memory configuration, recover stale corrupt locks,
  and restore only upgrade-created memory files under the memory lock.
- Add adversarial migration fixtures and mutation-sensitive allocation, conservation, route, hook and stale checks.
