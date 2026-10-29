# Convert existing memory with evidence

Install the kit first. `<MEMORY>` is the original git memory repo; `<COPY>` is its authorized work copy.
`<ADOPTED>` is the authorized final memory directory; `<name>` is your chosen recovery tag.
`<PROJECT>` is the project root; `<EVIDENCE>` is outside moved sources; `<SOURCE>` is a memory filename.
`<WHOLE>` and `<DEST>` are whole-file source/destination paths; `<PROBES>` names your probe JSON.
Pins are initialized when missing, never raised; never increase a ceiling.

Commands use the installed engine from the project root. Do not operate on another project's memory.

1. **SCRIPTED — take the backstop before changing content.**
   `git -C <MEMORY> tag <name>` records the recovery point used by the
   migrator's recovery command. Check that the tag does not already name a different
   baseline; do not overwrite it. Copy with `git clone --no-hardlinks <MEMORY> <COPY>`
   into an authorized git-excluded folder. This keeps `.git` and the tag for recovery. Run
   `node scripts/memory/memory-conserve.mjs snapshot --repo <PROJECT> --memory-dir <COPY> --out <EVIDENCE>/tokens.json`.
   For each `## `-structured file moved whole, run
   `node scripts/memory/memory-conserve.mjs blocks-snapshot --repo <PROJECT> --memory-dir <COPY> --source <WHOLE> --out <EVIDENCE>/blocks.json`;
   repeat `--source` for multiple whole files. Proof: `git -C <COPY> rev-parse <name>`
   resolves, and both snapshots contain the named sources. Do not use block proofs
   as a substitute for token proofs on lessons split into new files.
2. **AGENT-DRIVEN — one layer per run.** Choose state, lessons, hard rules or fact
   pointers; record the chosen layer and its scope in the migration spec. Command:
   `node scripts/memory/memory-check.mjs --repo <PROJECT> --memory-dir <COPY> --json`.
   Proof: save the baseline findings and a reviewed file inventory for that layer.
   A gate diagnoses files; it does not choose the migration boundaries.
3. **AGENT-DRIVEN — write the move spec before the cut.** Name every destination
   and legal cut point: a heading or dated block, never mid-paragraph. Keep every
   path, command, id, quota and account a rule needs inside the rule. Move history
   verbatim to the fewest `<parent>-background[-N].md` files, aiming at 8 KB each;
   a single indivisible block can stand alone up to the 20 KB topic fail cap.
   Command: `git -C <COPY> diff --stat`. Proof: a second reader checks the move map
   against the originals before edits and the resulting file count afterwards.
   Brain nodes receive current canonical facts, not dumps of dated memory history.
4. **SCRIPTED — split lessons and generate their indexes.** Run
   `node scripts/memory/memory-migrate.mjs convert --repo <PROJECT> --memory-dir <COPY> --source <SOURCE> --tag <name>`;
   review the JSON report, then repeat with `--write`. Optional `--classes <JSON>`
   maps every assigned id to verification, shipping, orchestration, specs or sessions.
   The parser accepts bold `**N`/`**#N` and `##`–`######` headings with optional `#`,
   any number of digits and optional lowercase suffix. Ordinary numbered lists are
   not lessons. Unnumbered preamble/date blocks get extra `000a…` files, reported
   explicitly; duplicates get free suffixes. Fences protect embedded headings.
   Bodies are copied byte-for-byte, including CRLF. The original source filename
   becomes a `moved_to` stub pointing to craft indexes. The same run migrates routes
   and generates hot pages and catalogs. Proof: counts, ids,
   exception files, index lines, resolving stub and concatenated body bytes match
   the original. A second migration of a stub is a no-op.
5. **AGENT-DRIVEN — replace state.** Keep one `current-state.md` block with
   `state: true` and `## CURRENT`. After the tag, delete older resume blocks; first
   move any unique durable facts to their proper home. Keep old-name stubs and
   recovery instructions. Command:
   `node scripts/memory/memory-check.mjs --repo <PROJECT> --memory-dir <COPY> --json`.
   Proof: no `state.headings` finding and one current block; pending items appear in
   live Open-work lists, never only in a dated report that will rotate away.
6. **AGENT-DRIVEN — retain hard rules that fire.** Keep each hard-rule file at
   most 2 KB, with every operational value; move explanation and history verbatim
   into linked backgrounds. If this cannot fit, stop and report the rule instead
   of silently weakening it. Command: the same explicit gate as step 5.
   Proof: each rule's byte count and an original-imperative-to-new-location table;
   the rule itself, not only a background, contains the values needed to act.
   ARCHIVE lists one parent topic per line, never every background part.
7. **AGENT-DRIVEN — facts have one home.** Keep the agent-side rule in memory and
   add a resolving `brain: brain/.../node.md` pointer. Move only a current fact
   absent from its canonical node, concisely; retain dated history in backgrounds.
   Command: the same explicit gate as step 5. Proof: the canonical fact exists once,
   pointers resolve, and no `brain.pointer` or same-subject pointer warning remains.
   Do not create a brain for a project that has not authorized one.
8. **SCRIPTED — run all applicable mechanical proofs.**
   `node scripts/memory/memory-conserve.mjs verify --repo <PROJECT> --memory-dir <COPY> --baseline <EVIDENCE>/tokens.json`
   must report `missing: 0 tokens` (the importable verifier returns `count: 0`). For whole-file moves only, run
   `node scripts/memory/memory-conserve.mjs blocks-verify --repo <PROJECT> --memory-dir <COPY> --baseline <EVIDENCE>/blocks.json --dest <DEST> --json`
   with every destination; require zero missing, altered, duplicated and out-of-order
   blocks, or explicitly accepted entries with reasons. Token exceptions use
   `{"accepted":[{"token":"...","reason":"..."}]}`; block exceptions use source,
   heading and reason, plus index for repeated headings. Never accept a lost lesson
   token. Then run the explicit gate (0 FAIL) and
   `node scripts/memory/memory-recall.mjs --repo <PROJECT> --memory-dir <COPY> --probe <PROBES>`.
   `--no-git` is for fenced copies only; report skipped git coverage.
9. **AGENT-DRIVEN, DIFFERENT MODEL — prove instructions still fire.** Command:
   `git -C <COPY> show <name>:<SOURCE>` for each original. The reviewer
   lists every imperative and checks the rewrite, its trigger and all values.
   Proof: a bounded review record with no unresolved weakened rule. Token presence
   does not prove semantic equivalence. Keep specs and evidence in durable storage
   before deleting the work copy. Human semantic review is not automated by tests.
10. **SCRIPTED, AFTER REVIEW — adopt, measure and checkpoint.** Copy the reviewed
    files to the authorized memory directory using the reviewed file map; rerun
    `node scripts/memory/memory-check.mjs --repo <PROJECT> --memory-dir <ADOPTED>` and
    `node scripts/memory/memory-measure.mjs --repo <PROJECT> --memory-dir <ADOPTED> --write after-convert`.
    Run the project's own test command before any push of moved tracked files;
    name-keyed guards can change behavior even on verbatim moves. Then
    `git -C <ADOPTED> add .`, `git -C <ADOPTED> commit -m "Convert memory ladder"`,
    and `git -C <ADOPTED> push`. Proof: green gate and project tests, measurement
    evidence, commit and upstream status. Respect the current task's git fences.

`tests/convert.test.mjs` exercises the scripted split on 40 numbered lessons plus
one preamble, a three-block state, two 15 KB hard rules and two near-copy facts.
It proves 41 files, 41 index lines, exact body bytes, token `count: 0`, no lesson,
stub, link or pin findings, and **exactly three expected FAILs** after the scripted
steps: `state.headings` once and `hardrule.size` twice. Those deliberately remain
for manual steps 5 and 6; the fixture does not claim automated semantic repair.
Separate whole-file block tests prove detection and reasoned acceptance.

For existing hand-kept indexes run `node scripts/memory/memory-migrate.mjs routes --memory-dir <COPY> --dry-run`,
then `--write`. The report proves payload equality per family and nondecreasing recall probes, preserves
CRLF bodies and prose in routed notes, merges split router triggers, and retains redirect stubs.
Orphan lessons, note-name collisions and merged router lines over 600 characters stop before writes.

Conversions must end with 0 `desc.slug` findings. Write descriptions that add useful
context beyond the filename or name; do not shorten them to filename restatements.
Keep quick notes under the brain's `99-inbox/` folder (including subfolders) untyped
until graduation; do not invent ids or types to clear `brain.frontmatter`.

## Move root memory into a dedicated folder

This is a separate conversion session before installation. The repo root is never a memory
directory: it also contains source, instructions and project Git metadata.

1. Inventory the root router, INDEX pages, their topic targets and any existing memory/
   files. Record source bytes and ordered hand lines; keep a recovery copy outside the
   destination. Select `memory/` or `.claude/memory/`; reject filename collisions instead
   of overwriting. Do not copy the project .git folder.
2. Copy first. Copy the router and its reachable memory files into the dedicated folder,
   keeping originals intact. Preserve subdirectories where needed. If memory/ already
   holds topics, reuse those files only after proving their bytes match the inventory.
3. Build an explicit old-path to new-path mapping. Rewrite relative Markdown destinations
   from each source file's new location, including links back to brain/ and project docs.
   Rewrite qualified wikilinks and inbound project links that name moved files; leave
   external URLs and fragments intact. Record each intended link-only replacement.
4. Prove conservation: compare every copied body with its source after only the recorded
   link replacements; verify every kept line in source order, every local link target and
   the complete source-to-destination inventory. Run recall probes before and after and
   require no regression. Run the gate with explicit `--repo` and `--memory-dir` against
   the destination, and inspect router, headings, wrapped items and nested lists. A failed
   proof leaves originals in place; fix the copy and repeat. Keep the proof report.
5. Update AGENTS.md, CLAUDE.md, imported instructions, hooks and scripts to point to the new
   router. Install using the dedicated folder and verify SessionStart and recall resolve
   it without an override. Only after conservation and link checks pass, remove the old
   memory copies, check inbound links again, and review the project diff. Commit through
   the host's branch policy; this procedure does not authorize a commit or push.

Route migration separately checks ORDER before and after writing and rolls back if the
kept hand lines have changed relative order. Its report's router.before is literal source
text; router.after is the replacement, including line endings.

## Character and chain checks after conversion

Run the full gate before adoption. `chars.*` can indicate a copy through a code page: preview
`node scripts/memory/memory-chars.mjs repair`, allow deliberate examples, then run with `--write` and hand-fix
report-only residues. A part's `parent:` wins, including a stub parent; otherwise the first matching name decides:
`<base>-background-N`, `<base>-background`, `<base>-part-NN`, `<base>-N`, with an existing base. Lessons, state files,
hard-rule cards and generated pages are not parts. Every part starts `Part N of [parent](parent.md).`, with integer N;
the parent links parts in order. Run `memory-chains.mjs scan`, then `repair --write`; hand-review numbering and order.
For future conversions, wrap prose only at sentence ends (`memory-chains.mjs lines --write`); preserve fenced blocks,
tables, verbatim payload blocks, procedures, exact recipes and incident cause chains whole. List/indented lines are
report-only. Do not split an application-critical unit to satisfy a preferred line count; move oversized units into
linked docs or brain nodes instead.
