# Glossary

How the pieces fit: the router points to an index, and the index points to the file needed for the current work. Memory holds instructions and lessons for the agent; the brain holds project knowledge. The gate checks at session start and memory commits; a checkpoint saves the current handoff and refreshes records at the end of work.

Paths below are relative to the project unless marked as kit paths; memory filenames are relative to the memory folder. Engine commands live in the kit's `engine/` and are installed into `scripts/memory/`; run them with `node`, using `--repo <PROJECT> --memory-dir <MEMORY>` when working from the kit. This is one lookup page, not a file to load at every session start.

## The ladder (memory layers)

**active work** - The router's short list of work currently in progress, normally pointing to the current state rather than storing its history. Where: memory `MEMORY.md`, under `Active work`. See also: state file, archive.

**archive** - A ledger of retired router pointers and tags, not a dump of old bodies and not loaded by default; follow a pointer when older work matters. Where: memory `ARCHIVE.md`. See also: background file, active work.

**background file** - Explanation or history moved out of a topic or hard-rule card, with its original content preserved and a link from the parent. Where: memory `<parent>-background.md` and `<parent>-background-2.md`. See also: hard-rule card, legal cut point.

**brain pointer** - A memory frontmatter `brain:` path to the canonical project fact; keep the agent instruction in memory and open the referenced node for the fact. Where: memory topic frontmatter, `brain: brain/.../node.md`. See also: brain / vault, brain.pointer.

**catalog** - The complete generated list for a family, including older and superseded lessons, split into linked pages when necessary. Where: memory `INDEX-<family>-all.md` and `INDEX-<family>-all-2.md`. See also: hot page, split pages.

**craft family / activity index** - An index grouping lessons by what the agent is doing, such as verification or sessions; open the family required by the router before acting. Where: memory `INDEX-craft-<activity>.md`. See also: route, trigger line.

**CURRENT block** - The single replaceable handoff containing the current task, progress and next action; move durable facts out before overwriting it. Where: memory `current-state.md`, under `## CURRENT`. See also: state file, checkpoint.

**description** - A short, static frontmatter explanation of what a file contains, ideally at most 200 characters; it is used for routing and must not become a changelog. Where: memory file `description:`. See also: hook, desc.length.

**domain index** - An index grouping memory by subject area rather than activity; open it when work touches that subject. Where: memory `INDEX-<domain>.md`. See also: domain, craft family / activity index.

**generated index** - An index rebuilt from router families and file metadata, marked on its first line as generated; edit the source lessons and regenerate instead of editing its rows. Where: `memory-index.mjs --write`. See also: hot page, catalog, index.stale.

**hard rule** - An instruction that must be followed whenever its trigger applies, with the values needed to obey it kept visible in its card. Where: memory `MEMORY.md` hard-rule triggers and linked rule files. See also: hard-rule card, trigger line.

**hard-rule card** - A small file containing a hard rule and every necessary path, command, identifier or limit; aim for at most 2,048 bytes and move only explanation/history to backgrounds. Where: memory rule file using kit `templates/hard-rule.md`. See also: hardrule.size, background file.

**hook** - The optional lesson field supplying a concise index sentence instead of its description; it must be a string of at most 200 characters and is unrelated to executable session or Git hooks. Where: lesson `metadata.hook` (top-level `hook` is the fallback). See also: description, memory pre-commit hook.

**hot page** - A generated family's compact first page containing its topics, active pinned lessons and as many newest active lessons as fit the budget. Where: memory `INDEX-<family>.md`. See also: catalog, pin.

**index page** - A navigation file of short pointers that lets the reader choose a topic or lesson without loading every body. Where: memory `INDEX-*.md`. See also: generated index, routing table.

**layer** - A level of detail in the ladder: short routing instructions lead to indexes, then focused files and optional backgrounds; move detail downward when an upper level becomes too large. Where: memory `MEMORY.md` and its links. See also: router, background file.

**lesson** - One reusable learning recorded with what happened, why it matters and how to apply it; capture it when learned and fill the template's TODO before running the gate. Where: `memory-lesson.mjs new --kind <mistake|practice|observation> --route <family> "<title>"`, creating memory `lesson-<number>-<slug>.md`. See also: lesson number, route, supersedes.

**lesson number** - The identity in a lesson filename, at least three digits with an optional lowercase letter suffix; new capture allocates the next numeric part and citations use `#N` or `#Nb`. Where: memory `lesson-001-<slug>.md` and `metadata.lesson`. See also: lessons.duplicate, lessons.cite.

**memory folder** - The private Markdown directory holding the router, lessons and state, normally outside the project; find it from the gate's `memory:` output or pass `--memory-dir`. Where: `--memory-dir`, then `CLAUDE_MEMORY_DIR`, then tracked `memory.inRepoDir`, then existing `scripts/memory/KIT.local.json` `memoryDir`, then `~/.claude/projects/<absolute-repo-path-slug>/memory`. See also: memory repo, router.

**memory repo** - The Git repository tracking the memory folder so earlier states can be recovered and authorized checkpoints backed up to a private remote. Where: memory folder `.git`, or its tracked parent repository. See also: memory folder, memory pre-commit hook, checkpoint.

**memory-init** - `node scripts/memory/memory-init.mjs [--memory-dir <MEMORY>] [--dry-run]` creates missing private memory for an installed engine, using the installer's folder resolution, templates, generated indexes, baseline commit, gate and hook. Existing folders are left unchanged; the output prints private remote setup commands for memory outside the repository and none for memory inside it. Where: `memory-init.mjs`, with shared installer setup in `memory-setup.mjs`. See also: install, memory folder.

**old-name stub** - A small recovery file left at a moved file's old name, with `moved_to:` naming existing memory files or project `brain/...` files; follow it and do not grow it into a second copy. Where: original memory filename. See also: stub.target, conversion.

**pin** - In lesson metadata, `pin: true` keeps an active lesson on its generated hot page; in config, a numeric index pin is a byte ceiling for a hand-written index, a separate meaning. Where: lesson `metadata.pin` or `memory.config.json` `pins`. See also: pin ceiling, hot page, supersedes.

**route** - One or more family names assigning a lesson or topic to indexes already linked from the router; give several families as `--route a --route b` or `--route a,b`; `metadata.route` overrides top-level `route`. Where: memory file frontmatter, for example `route: [craft-sessions]`. See also: routing table, route.unknown.

**router** - The small starting file containing hard-rule triggers, craft/domain links and active work; add detail to linked files rather than expanding it. Where: memory `MEMORY.md`. See also: routing table, layer.

**routing table** - The router's mapping from activities or subjects to the indexes that must be opened; it can be written as a list rather than a literal Markdown table. Where: memory `MEMORY.md`, `Craft` and `Domains`. See also: route, trigger line.

**split pages** - Continuations that keep an index or history readable: `-2` is a numbered continuation, `-all` is a generated catalog, and dated pages organize material by date; numbered continuations share a family, but date suffixes are not automatically stripped. Where: memory `INDEX-<family>-2.md`, `INDEX-<family>-all.md`, or dated index pages. See also: catalog, rotation.

**state file** - A memory file marked `state: true` containing one current handoff, overwritten at checkpoints with older state recoverable in Git. Where: memory `current-state.md`, with `metadata.state: true` or top-level `state: true`. See also: CURRENT block, state.headings.

**supersedes** - A list of older lesson filenames replaced by a newer lesson; those older lessons remain in the catalog but leave that family's active hot-page selection. Where: lesson `metadata.supersedes` (top-level fallback supported). See also: lesson, catalog, pin.

**topic file** - A focused memory file for one subject or fact, with a name, description and type; open it through routing or recall rather than reading all topics. Where: memory `<kebab-case-name>.md`, using kit `templates/topic.md`. See also: description, brain pointer.

**trigger line** - A link plus a condition telling the reader when to open it, written as `OPEN BEFORE <activity>` or `OPEN when work touches <domain>`. Where: memory router and indexes. See also: hard rule, routing table.

**wikilink** - A double-bracket link such as `[[name]]`, optionally with `#heading` or `|label`, resolving a memory name or brain node; inspect unresolved-link warnings rather than inventing content. Where: memory and brain Markdown. See also: wikilink.dead, edge.

## The gate and its findings

Thresholds here are shipped defaults in `engine/memory.config.json`; installed projects can preserve different values in `scripts/memory/memory.config.json`. Byte and character checks fire above their thresholds unless an entry says otherwise; structural checks have no numeric threshold.

**allowed / allowlist** - A recorded exception that leaves a finding visible in JSON but removes it from failure/warning totals while its measured value remains within any ceiling; record `check`, `file`, `reason`, `added` and optional `ceiling`, and never raise ceilings to pass. Where: `memory.config.json` `allow`, or `memory-check.mjs --write-allowlist "reason"`. See also: config.allow, ratchet.

**archive.line** - FAIL when an archive line exceeds 300 characters; shorten it to a pointer and move detail to the linked file. Where: memory `ARCHIVE.md`; `caps.archive.failLineChars`. See also: archive.

**brain.duplicate-id** - FAIL when two brain nodes use the same id within the project namespace or within the shared namespace; assign a unique identity and repair links, with no numeric allowance. Where: brain node frontmatter. See also: id prefix, shared node.

**brain.edge** - WARN when a node's relation target cannot resolve, except configured shared-folder targets reported as external edges; repair the target or review the intentional unresolved reference, with no numeric threshold. Where: brain frontmatter relation fields or `edges` list. See also: edge, caps.brainShared.

**brain.frontmatter** - FAIL when a discovered brain file outside `99-inbox/` lacks `id` or `type`, except that a plain note with neither field is exempt when no discovered file (including inbox files) has both fields. A file with only one field outside `99-inbox/` still fails. Once any file has both fields, every discovered non-inbox subfolder file requires both. Add the correct fields, with no numeric threshold. Where: brain node frontmatter. See also: node type, frontmatter.

**brain.length** - Optional WARN above 350 body words or 200 summary characters; disabled by default. Skipped for plain notes with neither `id` nor `type` only when no discovered brain file (including inbox files) has both fields. Partial nodes and every discovered file in a typed brain retain the length checks, including inbox files. Fix by separating facts or shortening the summary. Where: brain nodes; `caps.brainNode`. See also: summary.

**brain.pointer** - FAIL when a memory `brain:` value is not a valid existing `brain/...` file inside the project; repair the pointer, with no numeric threshold. Where: memory frontmatter. See also: brain pointer.

**brain.pointer-missing** - WARN when a project/reference memory's name matches a brain id after removing its type prefix and trailing date but has no brain pointer; link the canonical fact, with no numeric threshold. Where: memory frontmatter. See also: brain pointer.

**cap** - A configured size, length, age or retention limit; `warnBytes` requests review and `failBytes` blocks a normal gate run when exceeded. Where: `memory.config.json` `caps`. See also: FAIL, WARN, pin ceiling.

**caps.agents** - Instruction-file settings: `caps.agents.path` defaults to `AGENTS.md` and `caps.agents.warnBytes` to 16,384 bytes; there is no shipped fail-byte limit. Where: `memory.config.json`. See also: repo.agents.

**caps.archive** - Archive line settings: `caps.archive.failLineChars` defaults to 300 characters. Where: `memory.config.json`. See also: archive.line.

**caps.brainIndex** - Brain navigation settings: `caps.brainIndex.path` is `brain/00-system/index.md`, `caps.brainIndex.allPath` is `brain/00-system/index-all.md`, and `caps.brainIndex.maxBytes` is 12,288 bytes for the compact page. `caps.brainIndex.systemFiles` supplies system links, defaulting to `AGENTS.md`, `schema.md`, `edge-cases.md`, `skills-index.md`, `log.md`, `index-all.md`, `agents-background.md` and `memory-ladder.md`. Where: `memory.config.json`. See also: brain index.

**caps.brainLog** - Log settings: `caps.brainLog.path` is `brain/00-system/log.md`, `caps.brainLog.warnBytes` is 51,200 and `caps.brainLog.failBytes` is 102,400; `caps.brainLog.keepEntries` keeps the last 20 entries by file position during rotation. Where: `memory.config.json`. See also: repo.brain-log, rotation.

**caps.brainNode** - Optional node-length checks: `caps.brainNode.lengthChecks` defaults to false, `caps.brainNode.warnBodyWords` to 350 words and `caps.brainNode.warnSummaryChars` to 200 characters. Where: `memory.config.json`. See also: brain.length.

**caps.brainShared** - Shared-edge settings: `caps.brainShared.paths` defaults to `["brain/_shared/"]`; unresolved targets from these folders are reported as external edges rather than ordinary edge warnings. Where: `memory.config.json`. See also: shared node, brain.edge.

**caps.description** - Description limits: `caps.description.warnChars` defaults to 200 characters and `caps.description.failChars` to 400. Where: `memory.config.json`. See also: desc.length.

**caps.hardRule** - Rule-card limits: `caps.hardRule.warnBytes` defaults to 2,048 bytes and `caps.hardRule.failBytes` to 4,096. Where: `memory.config.json`. See also: hardrule.size.

**caps.index** - Index budgets: `caps.index.pinSlackBytes` is 1,024 bytes for ratcheting, `caps.index.pinWarnRoomBytes` is 400 bytes of remaining room, `caps.index.warnLineChars` is 300 and `caps.index.failLineChars` is 450 characters per line. `caps.index.failBytesAbsolute` is 24,576 bytes per catalog/hand-written page and `caps.index.hotBytes` is 8,192 bytes for generated hot-page selection. Where: `memory.config.json`. See also: pin ceiling, hot page, index.size.

**caps.repoAhead** - Unpushed-commit thresholds: `caps.repoAhead.warn` is 1 and `caps.repoAhead.fail` is 10, both inclusive. Where: `memory.config.json`. See also: repo.ahead.

**caps.roadmap** - Roadmap settings: `caps.roadmap.path` is `docs/ROADMAP.md`, `caps.roadmap.order` is `newest-first` (also accepts `oldest-first`), `caps.roadmap.warnBytes` is 61,440 and `caps.roadmap.failBytes` is 81,920 bytes. `caps.roadmap.keepBlocks` normally retains six dated Open work blocks during rotation. Where: `memory.config.json`. See also: rotation, repo.roadmap.

**caps.roadmapHistory** - History location: `caps.roadmapHistory.path` defaults to `docs/ROADMAP-HISTORY.md`. Where: `memory.config.json`. See also: roadmap history.

**caps.roadmapOverview** - Overview location: `caps.roadmapOverview.path` defaults to `docs/ROADMAP-OVERVIEW.md`. Where: `memory.config.json`. See also: overview.

**caps.router** - Router limits: `caps.router.warnBytes` is 12,288 bytes, `caps.router.failBytes` is 16,384 bytes and `caps.router.failLineChars` is 600 characters per line; `caps.router.warnLines` is 150 and `caps.router.failLines` is 200. Where: `memory.config.json`. See also: router.size, router.line.

**caps.shelf** - Deferred-work settings: `caps.shelf.path` is `docs/shelf` and `caps.shelf.reviewDays` limits the interval from shelved to review date to 90 days. Where: `memory.config.json`. See also: shelf.frontmatter.

**caps.stale** - Type selection for age warnings: `caps.stale.types` defaults to `["project", "reference"]`, in addition to state files. Where: `memory.config.json`. See also: stale.

**caps.staleDays** - The committed-age warning threshold, default 45 days; this does not automatically delete or invalidate old facts. Where: `memory.config.json`. See also: stale.

**caps.state** - Handoff limits: `caps.state.warnBytes` is 4,096 bytes, `caps.state.failBytes` is 8,192 bytes and `caps.state.maxStateHeadings` is one CURRENT/RESUME heading. Where: `memory.config.json`. See also: state.size, state.headings.

**caps.topic** - Topic limits: `caps.topic.warnBytes` is 8,192 bytes and `caps.topic.failBytes` is 20,480 bytes. Where: `memory.config.json`. See also: topic.size.

**config.allow** - FAIL for an invalid allow entry, including absent reason/date/check/file, invalid ceiling, or an attempt to allow `secret` or `config.*`; repair or remove it, with no numeric threshold. Where: `memory.config.json` `allow`. See also: allowed / allowlist.

**config.allow-stale** - WARN when a valid exception matches no finding for a check actually evaluated in this run; remove obsolete exceptions after checking scope, with no numeric threshold. Where: `memory.config.json` `allow`. See also: allowed / allowlist.

**config.roadmap-order** - FAIL when the configured order is neither `newest-first` nor `oldest-first`; use the actual ordering, default `newest-first`. Where: `caps.roadmap.order`. See also: rotation, repo.roadmap-order.

**config.upgrades** - FAIL when the deferred-upgrade ledger is missing or malformed; repair its schema rather than allowing the finding. Where: `upgrades.json`, checked by `memory-check.mjs`. See also: deferred-upgrade ledger.

**desc.changelog** - FAIL when a description contains `Newest:`; replace it with a static summary and move history into its proper record, with no numeric threshold. Where: memory frontmatter. See also: description.

**desc.length** - WARN above 200 description characters, FAIL above 400; shorten the description and keep detail in the body. Where: memory frontmatter; `caps.description`. See also: description.

**desc.missing** - FAIL when a non-navigation memory file has no nonempty string description; write a useful static summary, with no numeric threshold. Where: memory frontmatter. See also: description.

**FAIL** - A finding that makes the normal gate exit 1 unless it is allowed; repair it or report it before proceeding, since the session-start report itself stays nonblocking. Where: `memory-check.mjs` output. See also: WARN, session-start report.

**fm.parse** - FAIL for unclosed frontmatter, or WARN for frontmatter lines the restricted parser does not understand; fix the syntax, with no numeric threshold, and never allow a parse FAIL. Where: memory and brain frontmatter. See also: frontmatter.

**gate** - The read-only checker for sizes, navigation, metadata, secrets and repository health; run it normally to enforce failures or with `--json` to inspect findings. Where: `memory-check.mjs`. See also: FAIL, memory pre-commit hook, session-start report.

**hardrule.size** - WARN above 2,048 bytes and FAIL above 4,096; retain every operational value in the card and move explanation/history to linked backgrounds. Where: hard-rule memory files; `caps.hardRule`. See also: hard-rule card.

**index.hot-budget** - WARN when mandatory topics and active pins alone exceed the generated hot budget of 8,192 bytes; review routes, pins and descriptions rather than dropping required information. Where: generated memory indexes; `caps.index.hotBytes`. See also: hot page, pin.

**index.line** - WARN above 300 characters and FAIL above 450 per index line; shorten the source hook/description or split hand-written navigation. Where: memory indexes; `caps.index.warnLineChars`, `caps.index.failLineChars`. See also: hook, generated index.

**index.missing-pin** - FAIL when a hand-written non-stub index lacks a config pin; review its size then initialize missing pins with the ratchet, with no fixed size threshold. Where: `memory.config.json` `pins`. See also: pin ceiling, ratchet.

**index.pin** - FAIL when a hand-written non-stub index exceeds its stored byte ceiling, or WARN when less than 400 bytes remain; move detail down or split the index, never raise the ceiling. Where: `memory.config.json` `pins` and `caps.index.pinWarnRoomBytes`. See also: pin ceiling.

**index.size** - FAIL above 24,576 bytes for hand-written indexes and generated catalog pages; split hand-written pages or regenerate catalogs after shortening oversized source rows. Where: memory indexes; `caps.index.failBytesAbsolute`. See also: split pages.

**index.stale** - FAIL when generated memory pages differ from expected output, obsolete pages remain, or generation fails; run `memory-index.mjs --write` and fix any source errors, with no numeric threshold. Where: generated memory indexes. See also: generated index.

**index.unreachable** - WARN when a routed or indexed lesson/topic cannot be reached from the router through indexes and catalogs; stubs, state, ARCHIVE and notes pages are exempt. Where: `memory-check.mjs` and the shared `ladderWalk` in `memory-index.mjs`. See also: catalog, router.

**kit.manifest** - WARN for missing, malformed or mismatched owned-file hashes or skill versions against the receipt; inspect local edits and use the reviewed upgrade, with no numeric threshold. Where: `scripts/memory/MANIFEST.json`, `KIT.json` and owned files. See also: fingerprint, upgrade.

**kit.version** - FAIL when an owned engine module's bytes differ while receipt and manifest claim the same version; restore the matching release through upgrade rather than merely changing a version label, with no numeric threshold. Where: installed `scripts/memory/*.mjs`. See also: kit.manifest, VERSION.

**lesson.hook** - FAIL for a non-string hook or one longer than 200 characters; supply a short string or remove it to use the description (the limit is in code, not config). Where: lesson frontmatter. See also: hook.

**lesson.unfilled** - FAIL when a lesson description is still exactly `TODO`; fill the template with the actual learning, with no numeric threshold. Where: memory `lesson-*.md`. See also: lesson.

**lessons.cite** - FAIL for a `#N`/`#Nb` citation without a corresponding full lesson identity once lessons exist; correct the citation or recover the missing lesson, with no numeric threshold. Where: memory router and craft indexes. See also: lesson number.

**lessons.duplicate** - FAIL for repeated full lesson numbers, including suffixes; reconcile identities and repair citations, with no numeric allowance for duplicates. Where: memory lesson filenames. See also: lesson number.

**link.dead** - FAIL for a missing Markdown target in router/index/archive navigation or a missing linked background reached from those roots; restore or correct the link, with no numeric threshold. Where: memory navigation and linked parents. For in-repo memory, checked relative Markdown links outside memory but inside the same repository use indexed files in hook mode, including staged additions; untracked files and directories do not satisfy them. Targets inside memory use the staged snapshot, and anchors retain full-mode handling. See also: background file.

**link.orphan** - WARN for a non-stub topic not reachable through navigation roots and their memory links; link it from the right index or parent, with no numeric threshold. Where: memory folder. See also: index page.

**memory pre-commit hook** - The Git hook that checks a staged memory snapshot with `--hook --scope memory`, blocking on unallowed FAILs or snapshot extraction errors; it preserves foreign hooks and skips remote/ahead/dirty reporting. Install creates it only after a zero-FAIL gate; otherwise it prints the exact retry command. Marked kit hooks can be recognized and removed; host hooks remain untouched. Where: `install-hooks.mjs` installs into the separate memory repository or project hook location for in-repo memory. See also: gate, memory repo.

**name.duplicate** - FAIL when memory files reuse the same frontmatter name; give each distinct idea a unique name or consolidate duplicates, with no numeric allowance. Where: memory frontmatter. See also: topic file.

**name.mismatch** - WARN when frontmatter name differs from the filename stem; align them and repair links, with no numeric threshold. Where: memory frontmatter and filename. See also: topic file.

**pin ceiling** - The maximum stored byte size of a hand-written index; ratcheting initializes it to current bytes plus 1,024 and can only lower an existing ceiling. Where: `memory.config.json` `pins`. See also: pin, ratchet, index.pin.

**ratchet** - A limit that may tighten but must not be loosened merely to pass; `--ratchet-pins` sets missing index pins, lowers existing ones to at most current bytes plus slack and removes obsolete pins. Where: `memory-check.mjs --ratchet-pins`. See also: pin ceiling, allowed / allowlist.

**repo.agents** - WARN when the configured instruction file exceeds 16,384 bytes, with no shipped FAIL byte limit; move detailed procedures into linked files. Where: `AGENTS.md`; `caps.agents`. See also: session-start cost.

**repo.ahead** - WARN at 1 or more unpushed commits and FAIL at 10 or more relative to the configured upstream; inspect and push when authorized (no upstream means no numeric comparison). Where: memory repository; `caps.repoAhead`. See also: checkpoint.

**repo.brain-index** - WARN when the brain index has no wikilinks, differs from generated output, or generation errors; run `brain-index.mjs --write`, respecting the 12,288-byte compact limit. Where: `caps.brainIndex.path` and `caps.brainIndex.allPath`. See also: brain index.

**repo.brain-log** - WARN above 51,200 bytes and FAIL above 102,400; rotate older entries while preserving them. Where: `brain/00-system/log.md`; `caps.brainLog`. See also: rotation, brain log.

**repo.git-skipped** - WARN that `--no-git` omitted Git health and committed-age coverage; report the gap and rerun on the real repository when authorized, with no numeric threshold. Where: `memory-check.mjs --no-git`. See also: stale, gate.

**repo.not-git** - WARN when the memory directory is neither its own Git root nor a tracked subtree of a repository; establish the intended memory repository, with no numeric threshold. Where: memory folder. See also: memory repo.

**repo.remote** - WARN when the memory repository has no remote; configure its intended private backup remote, with no numeric threshold. Where: memory repository Git configuration. See also: memory repo, checkpoint.

**repo.roadmap** - WARN above 61,440 bytes and FAIL above 81,920; rotate old dated Open work blocks and keep live pending items in current lists. Where: `docs/ROADMAP.md`; `caps.roadmap`. See also: rotation, Open work.

**repo.roadmap-order** - WARN when the first and last valid dated blocks in Open work contradict configured order, default `newest-first`; reconcile the file and setting (this is an endpoint check, not a full sort proof). Where: `docs/ROADMAP.md`; `caps.roadmap.order`. See also: config.roadmap-order.

**repo.roadmap-overview** - WARN when a roadmap exists but its overview is missing/stale or generation errors; run `roadmap-overview.mjs --write`, with no numeric threshold. Where: `caps.roadmapOverview.path`. See also: overview.

**repo.skill-version** - WARN when either existing installed skill has missing/mismatched `engine_version` against config; update instructions and version together, with no numeric threshold (absent skills and hook/memory-only runs are skipped). Where: `.claude/skills/memory-ladder/SKILL.md` and `.claude/skills/memory-review/SKILL.md`. See also: upgrade.

**repo.uncommitted** - WARN for any uncommitted memory changes; inspect and complete an authorized checkpoint, with no numeric threshold. Where: memory repository working tree. See also: checkpoint.

**route.missing** - FAIL when a lesson has no route while generated indexes are in use; assign a router family, with no numeric threshold. Where: lesson frontmatter. See also: route.

**route.unknown** - FAIL when a file's route names no family in the router; correct the route or add the intended family link, with no numeric threshold. Where: memory frontmatter and `MEMORY.md`. See also: routing table.

**router.line** - FAIL above 600 characters on a router line, with no default WARN line limit; retain the trigger and move detail to its linked file. Where: memory `MEMORY.md`; `caps.router.failLineChars`. See also: trigger line.

**router.missing** - FAIL when `MEMORY.md` is absent; restore the router and its links, with no numeric threshold. Where: memory folder. See also: router.

**router.size** - WARN above 12,288 bytes and FAIL above 16,384; route detail through indexes and files instead of expanding the starting context. Where: memory `MEMORY.md`; `caps.router`. See also: layer.

**secret** - FAIL when credential-shaped content matches a built-in secret pattern; remove it without echoing the value and arrange authorized credential remediation, with no numeric threshold and no allowlist exemption. Where: scanned memory, brain, instruction and roadmap files. See also: gate.

**session-start report** - The compact gate summary printed by `--session-start`, at most four FAIL details plus a summary; it always exits zero, so follow up with the normal gate. Where: `.claude/settings.json` `SessionStart` command. See also: gate, FAIL.

**shelf.frontmatter** - FAIL for missing/invalid `status: shelved`, `shelved` or `review` dates, or a review more than 90 days after shelving; record valid dates within the interval. Where: `docs/shelf/**/*.md`; `caps.shelf.reviewDays`. See also: shelved program.

**shelf.review-due** - WARN on or after the recorded UTC review date; review the program and record the next decision/date. Where: `docs/shelf/**/*.md`; `review:` (the permitted initial interval defaults to 90 days). See also: shelf, shelved program.

**stale** - WARN when the last committed change is more than 45 days old for state or configured types (`project`, `reference`), excluding special files and `stable: true`; verify the current facts rather than assuming age proves them wrong. Where: memory Git history; `caps.staleDays`, `caps.stale.types`. See also: state file.

**state.headings** - FAIL above one heading containing CURRENT or RESUME; move durable facts out and retain one current block, with older state in Git. Where: state files; `caps.state.maxStateHeadings`. See also: CURRENT block.

**state.size** - WARN above 4,096 bytes and FAIL above 8,192; shorten the current handoff and move facts/history to their proper homes. Where: state files; `caps.state`. See also: state file.

**stub.target** - FAIL when any `moved_to` target is missing, invalid or escapes the permitted memory/brain root; correct or restore the destination, with no numeric threshold. Where: old-name stub frontmatter. See also: old-name stub.

**topic.size** - WARN above 8,192 bytes and FAIL above 20,480; split at meaningful boundaries into focused files or linked backgrounds. Where: memory topics; `caps.topic`. See also: legal cut point.

**WARN** - A finding requiring inspection that does not by itself make the normal gate fail; report or repair it rather than treating it as proof of broken content. Where: `memory-check.mjs` output. See also: FAIL, allowed / allowlist.

**wikilink.dead** - WARN for an unresolved memory wikilink against memory and brain names; correct it or inspect an intentional future-lesson marker, with no numeric threshold. Where: memory Markdown. See also: wikilink.

## Recall and measurement

**BM25** - A word-based ranking method that scores query matches while accounting for word rarity and document length; the kit also weights fields so names and summaries help relevant files rank higher. Where: `memory-recall.mjs`. See also: recall, search recall.

**deferred-upgrade ledger** - Deliberately postponed ideas with a reason and project or fleet metric condition; `search-whole-files` uses `recall.totals.searchHitRate < 22/24`, `vector-search` uses `< 20/24` for two consecutive measurements, and `bm25s` and `lightrag-memory` remain NEVER. Where: `upgrades.json`, `memory-measure.mjs` TRIGGERS table. See also: fleet status, trigger state.

**forgetting proxy** - Counts of lesson bodies containing correction/repeated-mistake phrases and recorded repeats, with repeatsPerMonth and repeatsByCause breakdowns; it is a warning signal, not a measured recurrence rate. Where: `memory-measure.mjs`, `forgetting` output. See also: measurement, upgrade trigger.

**ladder hop** - The `ladderHop` value `direct`, `index` or `catalog` identifies the navigation hop that found a probe; `ladderBytes` includes the router, traversed index/catalog pages and target. Where: `memory-measure.mjs` JSON `recall.probes`. See also: catalog, recall.

**ladder recall** - Finding a probe's expected file directly from the router or through one router-linked index; measured bytes include the router, any index and the file. Where: `memory-measure.mjs`, `recall.probes[].ladderBytes`. See also: search recall, recall probe.

**measurement** - A read-only report of session bytes, hard-rule bytes, recall costs, gate counts and the forgetting proxy; `--write <label>` also saves dated JSON/Markdown evidence. Where: `memory-measure.mjs`; default evidence `docs/evidence/memory/`. See also: session-start cost, recall probe.

**recall** - Searching memory and brain for relevant files using weighted word matching (BM25), then reading useful hits and still honoring required router triggers. Where: `memory-recall.mjs "<question>" --k 5`, with `--memory-only` or `--brain-only` to narrow it. See also: search recall, Tier 1 recall.

**recall probe** - A repeatable search question with an id and expected path substrings, passing when any expected path appears in the top three results; the example file requires a pass fraction of 0.8. Where: `recall-probes.json`, run with `memory-recall.mjs --probe <file>`. See also: ladder recall, measurement.

**search recall** - Finding a probe target among the top three search results; its measured cost includes the printed result list and the matched file, with no cost recorded for a miss. Where: `memory-measure.mjs`, `searchHit`, `searchRank`, `searchBytes`. See also: ladder recall.

**session-start cost** - Bytes of router, `AGENTS.md`, `CLAUDE.md` and the last 10 complete brain-log entries, with estimated tokens at four bytes each; the legacy comparison uses the last 40 log lines. Where: `memory-measure.mjs`, `sessionStart` and `sessionStartLegacy`; `measure.startLogTailEntries`, `measure.startLogTailLines`, `measure.bytesPerToken`. See also: measurement, brain log.

**trigger state** - DORMANT means the condition is false, FIRED means it is proven, NEVER records a rejected idea, and UNKNOWN means evidence is missing; `consecutive` includes the current measurement and earlier saved outputs, newest first. Where: TRIGGERS and FLEET TRIGGERS tables; `memory-measure.mjs --write LABEL`. See also: deferred-upgrade ledger.

**upgrade trigger** - Evidence that the current memory arrangement needs improvement, such as growing startup cost, missed probes, repeated corrections or cap findings; review the evidence before choosing a structural change or engine release. Where: measurement evidence and gate output (no single automatic threshold or upgrade action). See also: measurement, upgrade.

## Moving and converting memory

**accepted exception** - An explicit, reasoned conservation decision allowing a named token or block finding; block entries identify source and heading, plus index when headings repeat, and are separate from gate allow entries. Where: JSON passed to `memory-conserve.mjs --accepted <file>`. See also: conservation, allowed / allowlist.

**block snapshot / verify** - Snapshot records each source's heading blocks and normalized hashes; verify checks that all required copies survive across the named destinations without altered content or changed order within one destination. Where: `memory-conserve.mjs blocks-snapshot --source <file> --out <baseline>` and `blocks-verify --baseline <baseline> --dest <file>`. See also: conservation, legal cut point.

**conservation** - Proof that a move retained required content: `snapshot`/`verify` compare token presence, while `blocks-snapshot`/`blocks-verify` compare normalized block hashes, copy counts and within-destination order; neither proves the meaning of rewritten prose. Where: `memory-conserve.mjs`, baseline JSON and explicit `--source`/`--dest` paths. See also: accepted exception, legal cut point.

**conservation findings** - `missing` means too few matching copies, `altered` means changed content under the same full heading, `duplicated` means extra matching copies, and `out-of-order` means a source's blocks changed order within a destination. `ok` means conserved, `accepted` retains a finding with a recorded exception, and `unused accepted entry` means an exception matched no baseline block. Where: `memory-conserve.mjs blocks-verify` text/JSON output. See also: accepted exception, conservation.

**conversion** - The reviewed process of turning old journals or large memory files into the ladder while preserving lessons, operational instructions and recoverable history. Where: kit `docs/CONVERT.md`, installed `scripts/memory/CONVERT.md`. See also: migration, copy-first, conservation.

**copy-first** - Working on an authorized Git-excluded copy after recording a rollback point, then adopting only reviewed files once proofs and recall pass. Where: conversion work copy and durable evidence outside that copy. See also: conversion, rollback tag.

**destination** - The explicitly named file receiving moved content; write and verify it before shortening the original to a pointer. Where: conversion move map and `memory-conserve.mjs blocks-verify --dest <file>`. See also: legal cut point, old-name stub.

**legal cut point** - A heading or dated block boundary where content can move intact, never a cut inside a paragraph or fenced example; block conservation splits at `## ` outside fences and preserves the preamble. Where: conversion move map and source Markdown. See also: conservation, destination.

**lesson lock** - The shared writer lock that prevents overlapping capture, index, migration, upgrade and checkpoint writes; writers wait up to 30 seconds, with stale/dead-owner recovery only after ten minutes on the same host. Where: memory `.memory.lock`, managed by `memory-lock.mjs` (an imported helper, not a standalone command). See also: lesson, checkpoint.

**migration** - A scripted change: `lessons` splits old numbered lesson bodies and leaves a recovery stub, `routes` converts hand-kept index memberships/prose to routed sources and generated pages, and `convert` runs both under one lock. Where: `memory-migrate.mjs routes|convert|lessons`, dry-run by default, `--write` to apply. See also: conversion, lesson lock, conservation.

**rollback tag** - A Git name marking the original committed memory before migration, used to recover original content; do not overwrite an existing recovery point. Where: memory repository, `git -C <MEMORY> tag <name>` under authorized conversion. See also: copy-first, old-name stub.

**token snapshot / verify** - Snapshot records significant tokens from memory, brain Markdown, roadmap and shelf files; verify checks their continued presence, including optional extra `--file` paths, without proving sentence meaning or exact body preservation. Where: `memory-conserve.mjs snapshot --out <baseline>` and `verify --baseline <baseline>`. See also: conservation, block snapshot / verify.

## Project records the kit manages

**checkpoint** - The end-of-work save: first update the handoff and live records, then the command runs `memory-index`, `rotate-log`, `rotate-roadmap`, `brain-index`, `roadmap-overview`, `gate`, memory `commit`, and `push` in that order under one lock, skipping absent optional sources. Unallowed FAILs stop before commit; `--dry-run` only reports steps, `--no-push` skips push, and a failed push exits 2 with the commit retained. In-repo memory instead prints staging paths by default; explicit `--commit` commits on the current branch and never pushes. Where: `memory-checkpoint.mjs`. See also: CURRENT block, rotation, gate.

**log** - An append-oriented record of completed actions and decisions, kept separate from the current handoff and future work. Where: configured brain log, normally `brain/00-system/log.md`. See also: brain log, Open work, CURRENT block.

**Open work** - The roadmap's live pending work, including pending decisions and actions; keep unfinished items here rather than only inside dated blocks that will rotate away. Where: `docs/ROADMAP.md`, `## Open work`. See also: roadmap, shelf.

**overview** - A generated short navigation page combining roadmap releases, Open work, active headings, shelf metadata and history headings; regenerate after changing those sources. Where: `docs/ROADMAP-OVERVIEW.md`, `roadmap-overview.mjs --write` (`--check` detects drift). See also: roadmap history, shelf.

**roadmap** - The project record of planned work, active work and dated progress, with live decisions kept visible. Where: `docs/ROADMAP.md`. See also: Open work, overview, rotation.

**roadmap history** - The destination for older dated Open work blocks retained verbatim during roadmap rotation; it remains discoverable from the overview. Where: `docs/ROADMAP-HISTORY.md`, configured by `caps.roadmapHistory.path`. See also: rotation, roadmap.

**rotation** - Moving older log entries or dated roadmap blocks into history without rewriting their payload; log rotation keeps 20 entries by file position, while roadmap rotation normally keeps six blocks and selects oldest dates according to `caps.roadmap.order` (default `newest-first`). Where: `memory-rotate.mjs log|roadmap`, preview by default or `--write`; roadmap may keep only two blocks under size pressure. See also: roadmap history, brain log, conservation.

**shelf** - The directory for deferred programs that should remain discoverable and receive a dated review instead of occupying active work. Where: `docs/shelf/`. See also: shelved program, overview.

**shelved program** - A deferred body of work recorded with `status: shelved`, a `shelved` date and a `review` date at most 90 days later; the gate warns on or after review day so a person can resume, retire or reschedule it. Where: `docs/shelf/<name>.md`. See also: shelf.frontmatter, shelf.review-due.

## The brain (project knowledge vault)

These are generic schema meanings; the kit checks links and selected fields but does not implement a complete schema validator or a Tier 2 storage service.

**00-system** - The vault directory for schema, operating instructions, navigation and logs rather than ordinary knowledge nodes. Where: `brain/00-system/`. See also: brain index, brain log.

**authored_by** - An edge saying the target person created the current source or material; use it for authorship rather than evidence provenance. Where: node frontmatter `authored_by: ["[[cnt-...]]"]`. See also: contact, derived_from.

**bookmark** - A saved item not yet ingested or extracted, with a URL and `bkm-` id; create a source node once it is processed. Where: a typed file in `brain/`, often initially `99-inbox/`. See also: source node, reference.

**brain / vault** - The project's collection of typed Markdown knowledge nodes and their links, distinct from private agent instructions in memory. Where: project `brain/`. See also: node, memory folder, Tier 1 recall.

**brain index** - Generated navigation with a compact page and full node catalog, based on node ids/types and updated dates; regenerate both rather than hand-editing generated rows. Where: `brain/00-system/index.md` and `index-all.md`, via `brain-index.mjs --write`; system links come from `caps.brainIndex.systemFiles`. See also: 00-system, node.

**brain log** - The live system history whose entries begin `## [`, with older entries moved unchanged to monthly `log-YYYY-MM.md` files using each entry's own date. Where: `brain/00-system/log.md` and monthly files beside it. See also: rotation, session-start cost.

**concept** - A neutral definition of what something means, with a `con-` id; use it for meaning rather than a checkable factual assertion. Where: typed knowledge file under `brain/03-knowledge/<domain>/`. See also: fact, node type.

**contact** - A person node with a `cnt-` id and relevant role, organization or contact context; link sources to it for authorship. Where: typed file in `brain/`. See also: authored_by, source node.

**contradicts** - An edge saying the current node conflicts with the target's claim or choice; use it for actual tension, preserving prior belief history. Where: node frontmatter `contradicts`. See also: decision, fact, related_to.

**custom** - A recurring structured shape outside the other node types, with a `cst-` id and `custom_type` naming it; promote it to a schema type when frequent. Where: typed file in `brain/`. See also: note, node type.

**decision** - A specific dated choice with rationale and alternatives, identified by `dec-`; create a new decision when reversing it and retain the old record. Where: typed file in `brain/`. See also: pillar, contradicts.

**depends_on** - An edge saying the current node needs the target to be true or complete first, beyond mere sequence. Where: node frontmatter `depends_on`. See also: preceded_by, part_of.

**derived_from** - An edge naming the material or earlier node from which the current content was produced or concluded; this records provenance rather than a prerequisite. Where: node frontmatter `derived_from`. See also: source node, supports, depends_on.

**domain** - A subject area grouping knowledge, mirrored by the node's `domain` field; use it to locate related facts without confusing it with a memory routing family. Where: `brain/03-knowledge/<domain>/`. See also: domain index, node.

**edge** - A named relationship from one node to another, normally a frontmatter field containing wikilink targets; store one direction and put optional reasons in a body `## Edges` section. Where: brain node frontmatter. See also: edge type, wikilink.

**edge type** - The relationship name: `supports`, `contradicts`, `depends_on`, `derived_from`, `related_to`, `part_of`, `preceded_by`, `followed_by`, `authored_by` or `tagged_with`; choose the most specific truthful relation. Where: the project knowledge folder's own schema and relationship rules. See also: edge, related_to.

**event** - An append-only record of something that happened at a specific time, with `evt-` id and required `occurred_at`; a dated metric alone is usually a fact. Where: typed file in `brain/`. See also: fact, task node.

**fact** - One checkable claim or value with `fct-` id; claim metadata can record confidence and verification, and invalidated facts remain as linked history. Where: typed knowledge file under `brain/03-knowledge/<domain>/`. See also: hypothesis, source node.

**followed_by** - An edge saying the target comes after the current node in a sequence, without asserting a logical dependency. Where: node frontmatter `followed_by`. See also: preceded_by, depends_on.

**frontmatter** - Metadata between opening and closing `---` lines at the top of a Markdown file; the kit supports a restricted YAML-like subset, so keep fields simple and inspect parse findings. Where: memory files and brain nodes. See also: fm.parse, description, summary.

**hypothesis** - A testable belief not yet confirmed, with `hyp-` id, confidence and a proposed test; when confirmed, create a derived fact or pattern rather than erasing belief history. Where: typed knowledge file in `brain/`. See also: question, fact.

**id prefix** - The short type marker at the start of a stable node id, such as `fct-` for a fact, allowing a reader to recognize a target's type without opening it. Where: node `id:`; each node-type entry here gives its prefix. See also: node type, edge.

**inbox** - Temporary intake for unprocessed captures awaiting classification, extraction or filing. Where: `brain/99-inbox/`. See also: note, bookmark.

**node** - One typed knowledge file with stable `id`, `type`, short summary and body; keep one coherent item per file and link related items. Where: project `brain/` outside system/navigation files. See also: node type, edge, summary.

**node type** - The category describing what a node is: pillar, project, decision, playbook, concept, question, hypothesis, pattern, fact, task, event, source, bookmark, reference, contact, note or custom. Where: node `type:` and the project knowledge folder's own schema. See also: id prefix, frontmatter.

**note** - A temporary freeform capture with `not-` id and raw status; refine it into a more precise type as soon as its meaning is clear. Where: typed file in `brain/`, often `99-inbox/`. See also: custom, inbox.

**part_of** - An edge saying the current node is a component of the target whole, such as a task within a project. Where: node frontmatter `part_of`. See also: project node, depends_on.

**pattern** - A regularity observed across multiple instances, with `pat-` id and supporting evidence; it describes what happens, while a playbook prescribes actions. Where: typed knowledge file in `brain/`. See also: fact, playbook.

**pillar** - A standing goal, principle or area maintained indefinitely, with `pil-` id; bounded efforts link to it rather than giving it an artificial completion date. Where: typed pillar file in `brain/`. See also: project node, part_of.

**playbook** - A reusable procedure stored as a typed node in a project's knowledge folder. The kit can include typed nodes in generated brain indexes. Where: configured brain folder. See also: node type, brain index ownership.

**preceded_by** - An edge saying the target comes before the current node in sequence; use `depends_on` only when that predecessor is actually required. Where: node frontmatter `preceded_by`. See also: followed_by, depends_on.

**project node** - A bounded effort with an outcome and end state, using `type: project` and `prj-` id; track scope/current state and link tasks to it. Where: typed project file in `brain/`. See also: pillar, task node.

**question** - An open unknown to resolve, with `qst-` id; when answered, create the answer node derived from it and mark the question resolved. Where: typed file in `brain/`. See also: hypothesis, derived_from.

**reference** - An authoritative standard cited without extracting it as ingested source material, with `ref-` id and citation/locator information; the memory type named `reference` is a separate agent-memory classification. Where: typed file in `brain/`. See also: source node, bookmark.

**related_to** - A neutral association between peers when no more specific relation fits; first consider whether evidence, dependency, provenance or containment describes the link better. Where: node frontmatter `related_to`. See also: edge type.

**shared node** - Knowledge owned by a shared core and reused across vaults, commonly marked `shared: true`; unresolved-edge exemptions are based on configured folder prefixes, not this flag alone. Where: `brain/_shared/` by default and `caps.brainShared.paths`. See also: core, brain.edge.

**source node** - Ingested material with `type: source`, `src-` id and required `source_ref` pointing to its Tier 2 document; record takeaways and link extracted facts back to it. Where: typed source file in `brain/`. See also: bookmark, reference, Tier 2 recall.

**summary** - A node's short routing sentence, read before opening the body; it is the brain counterpart of a memory description. Where: brain frontmatter `summary:`. See also: description, brain.length.

**supports** - An edge saying the current node provides evidence or an argument for the target's truth; it is not merely where the current content came from. Where: node frontmatter `supports`. See also: derived_from, contradicts.

**tagged_with** - An edge categorizing the current node under a topic node, rather than a loose association between peers. Where: node frontmatter `tagged_with`. See also: related_to, domain.

**task node** - A future action with a done criterion, using `type: task` and `tsk-` id, optionally assignee/due/effort; connect it to its project and prerequisites. Where: typed task file in `brain/`. See also: project node, event.

**Tier 1 recall** - Retrieval of the vault's concise typed nodes and links, including the brain Markdown searched by the kit's recall command. Where: `brain/` and `memory-recall.mjs --brain-only`. See also: node, Tier 2 recall.

**Tier 2 recall** - Retrieval from an external store of ingested source documents when concise nodes are insufficient; the kit retains source pointers but does not install or search that store. Where: source node `source_ref` and the vault's separately configured retrieval service. See also: source node, Tier 1 recall.

## The kit itself

**core** - The reusable shared foundation, such as schema, procedures and shared nodes, from which individual project setups are maintained; it is distinct from the project's own facts. Where: shared setup resources and project `brain/_shared/`. See also: engine, shared node.

**engine** - The shipped Node modules implementing gate, recall, measurement, migration and generators; `lib.mjs` supplies internal shared helpers and `memory.test.mjs` runs isolated engine tests. Where: kit `engine/`, installed `scripts/memory/`. See also: kit, vendored engine.


**fingerprint** - A SHA-256 content hash used to detect local changes, normalizing CRLF to LF so line-ending differences alone do not count as edits. Where: `MANIFEST.json` `files` values. See also: kit.manifest, upgrade.

**fleet status** - Read-only `memory-fleet.mjs --root DIR --memory-home DIR --exclude PATTERN --json` scans immediate project repositories and memory folders; root and exclude flags repeat, and exclusions are case-insensitive substrings with only a count reported. A malformed project config produces only a bad config (<error>) row and does not abort the scan. Where: `memory-fleet.mjs`; optional ignored `fleet.local.json` roots and exclude arrays next to the script. See also: fleet triggers, deferred-upgrade ledger.

**fleet triggers** - `tiny-profile` fires for at least two installed memories under 15 KB whose generated indexes exceed lesson bytes; `warn-autofix` fires for the same WARN on at least three projects; `ci-gate` fires for any committed project with FAIL findings. Where: FLEET TRIGGERS; `fleet.tinyIndexProjects`, `fleet.maxWarnProjects`, `fleet.committedFailProjects` in fleet JSON. See also: fleet status, trigger state.

**front doors** - The entry points for installing the kit or converting existing memory. Where: kit `docs/STARTER.md` and `docs/CONVERT.md`. See also: install, core.

**install** - The first-time setup that copies owned engine/docs/skills, creates missing config/probes and memory templates, adds session instructions/hooks and verifies the result; it can initialize and baseline-commit the selected memory folder. Where: kit `scripts/install.mjs --target <PROJECT>` (`--dry-run` previews writes). See also: KIT.json receipt, memory folder.

**kit** - The distributable collection of engine modules, templates, two agent skills, guides and installer/upgrader for maintaining a memory ladder. Where: kit root `README.md`. See also: engine, install.

**KIT.json receipt** - The installed record of kit version, source and installation date, used with the manifest during upgrades; custom local memory paths instead live in ignored `KIT.local.json`. Where: `scripts/memory/KIT.json`. See also: MANIFEST.json, upgrade.

**MANIFEST.json** - The list of kit-owned files and their fingerprints, generated from the kit's ownership rules; installed manifests use project-relative destination paths. Where: kit `MANIFEST.json`, generated with `node scripts/manifest.mjs`, and installed `scripts/memory/MANIFEST.json`. See also: fingerprint, KIT.json receipt.



**release** - A reviewed version of the kit with matching engine/skill versions and generated manifest, published with a release tag. Where: kit `VERSION`, `CHANGELOG.md` and release tag. See also: upgrade note, fingerprint.

**upgrade** - Refreshing an installed kit from a reviewed release, preserving project config/probes and backing up replacements, with rollback on new gate FAILs; `--check` reports version/drift without replacing files. Where: kit `scripts/upgrade.mjs --target <PROJECT> [--check]`, installed `scripts/memory/UPGRADE.md`. See also: KIT.json receipt, upgrade note.

**upgrade note** - Release guidance explaining what changed and any action required after updating, such as regenerating memory indexes before the gate. Where: kit `CHANGELOG.md` and `docs/UPGRADE.md`. See also: release, upgrade.

**vendored engine** - The project's own copied engine version, run locally rather than fetched on each invocation; update it through the kit so hashes, docs and skills stay aligned. Where: project `scripts/memory/`. See also: upgrade, kit.version.

**VERSION** - The kit's plain-text release version used by installation and manifest generation; change it only as part of an authorized release. Where: kit root `VERSION`. See also: release, KIT.json receipt.


## Additional configuration and fleet vocabulary

**--no-optional-locks** - Git flag preventing optional lock-taking during fleet's read-only repository queries. Where: every fleet Git invocation. See also: safe.directory, worktree of main repo.

**backtick router entry** - An existing immediate `INDEX-*.md` filename in backticks, accepted by the shared router resolver and rewritten as a Markdown link by route migration while retaining its label and wrapped trigger text. Where: memory `MEMORY.md`. See also: router, trigger line.

**backup branch** - A project-named branch in one private backup repository shared by several independent memories; set it before the first push and publish only `<project>/<tag>` tags. Where: memory Git repository, README backup step and STARTER. See also: checkpoint, memory repo.

**behind** - Fleet status for an installed kit older than the scanning kit; it contributes to fleet triggers. Where: fleet status table. See also: current, vendored.

**brain.dir** - Configured project-relative brain folder, default `brain`, used by brain readers, recall, migration, conservation, generators and the gate; record output paths remain separately configured by the caps path keys. Where: `memory.config.json`. See also: brain / vault, repo.brain-index.

**current** - Fleet status for an installed kit that is not older than the scanning kit; it contributes to fleet triggers. Where: fleet status table. See also: behind, vendored.

**memory slug** - Project path with every non-alphanumeric character replaced by a hyphen, used to match private memory folders to projects. Where: default memory home and fleet resolver. See also: orphan memory, orphan memory (maybe project).

**no memory** - Fleet status for a Git project with no matched private memory folder. Where: fleet status table. See also: no repo, memory slug.

**no repo** - Fleet status for a memory matched to a folder without its own Git repository; it does not contribute to fleet triggers. Where: `memory-fleet.mjs` status table. See also: orphan memory, not installed.

**not installed** - Fleet status for a Git project with memory but neither an installed receipt nor a marked vendored kit; its fallback gate counts remain visible but do not feed triggers. Where: fleet status table. See also: vendored, current.

**orphan memory** - Fleet status for a memory folder with no matching project among Git repositories through depth two or non-Git folders through depth one under the configured roots. Where: fleet status table. See also: memory slug, orphan memory (maybe project).

**orphan memory (maybe project)** - Fleet suggestion when an unmatched memory slug differs from a known project slug only by runs of hyphens; no files are moved or merged. Where: `memory-fleet.mjs` status table. See also: memory slug, orphan memory.

**safe.directory** - Git ownership guard; fleet retains the default guard and does not add trust overrides. Where: fleet Git command arguments. See also: --no-optional-locks, worktree of main repo.

**vendored** - Fleet status for a project using a marked kit folder containing `VERSION` and `engine/memory-check.mjs`; its version and the kit gate appear in the table by default and it contributes to fleet triggers with current and behind installations. Where: `memory-fleet.mjs` status table. See also: vendored engine, current, behind.

**vendored gate** - The gate source shown when --project-gates opts into the marked vendor folder's own `engine/memory-check.mjs`. Where: fleet Gate column. See also: vendored, vendored engine.

**worktree of main repo** - Fleet status for a linked Git worktree whose `.git` file points to a shared repository; memory status and triggers are skipped. Where: `memory-fleet.mjs` status table. See also: no repo, safe.directory.

## Safe install and shared sessions

**brain index ownership** - Only the brain-index generated marker authorizes replacement; hand-written indexes use index-generated.md and index-all.md destinations, and zero typed nodes skip generation. Where: brain-index.mjs and scripts/install.mjs. See also: repo.brain-index, generated index.

**host file report** - Every created or modified host file is listed with its path and byte counts, followed by the installed self-test command. Where: scripts/install.mjs output. See also: installed self-test, settings merge.

**in-repo memory refusal** - Instructions and imported files identifying an in-repo router stop a mismatched install before writes; --accept-separate-memory prints an explicit override warning. Where: scripts/install-safety.mjs. See also: router, host file report.

**index.trigger** - FAIL when a generated hot page has no trigger in its first eight lines; repair the router entry and regenerate. Where: memory-check.mjs. See also: route.trigger, hot page.

**installed self-test** - The kit installs engine/memory.test.mjs as memory.selftest.mjs to avoid default runner collection; upgrade deletes the former name only when its prior manifest hash matches. Where: scripts/memory/memory.selftest.mjs. See also: host file report, kit manifest.

**line-ending preservation** - Unchanged lines retain their original LF or CRLF endings even in mixed files; appended and changed lines use the majority ending. New migration notes use the dominant ending of their source hand index (LF on ties); existing files retain the per-line rule. Where: AGENTS.md and CLAUDE.md during install. See also: host file report, settings merge.

**local config preservation** - Existing KIT.local.json keeps its exact bytes; conflicting memory settings refuse before writes. Where: scripts/install.mjs. See also: in-repo memory refusal, worktree memory.

**route.trigger** - FAIL when a router family has no OPEN or equivalent trigger outside link labels, destinations and headings; state prose is not a routing entry and deleted migration rows must survive verbatim elsewhere. Where: memory-check.mjs and memory-migrate.mjs. See also: index.trigger, trigger line.

**settings merge** - Install adds its missing SessionStart, PreToolUse and UserPromptSubmit hooks and retains permissions, other hooks and all other JSON values. Where: .claude/settings.json. See also: host file report, line-ending preservation.

**skill mirror** - A referenced skills folder or .agents/skills copy that matches .claude/skills byte-for-byte is updated together; divergence refuses before either changes. Where: scripts/install-safety.mjs. See also: host file report, settings merge.

**tooling excludes** - Host ESLint and TypeScript may need scripts/memory/** excluded; install detects local ESLint configs and explicit allowJs/checkJs settings and prints guidance. Where: docs/STARTER.md and install output. See also: installed self-test, host file report.

**worktree memory** - Linked checkouts use the main checkout's memory slug and KIT.local.json unless a flag or environment override is supplied. Where: lib.mjs memoryLocation. See also: memory folder, installed self-test.


The isolated self-test launcher loads `memory-selftest-cases.mjs` beside the fixed
`selftest-config.mjs` defaults in a temporary engine copy. Host config and receipts
are not copied.

## In-repo memory and migration ordering

**--commit** - Explicit checkpoint opt-in to commit selected memory and generated paths on the current project branch; in-repo mode never pushes. Where: memory-checkpoint.mjs --commit. See also: in-repo memory.

**contiguous hand block** - A list item and its indented continuations, including nested lists, preserved together in source order during route migration. Where: memory-migrate.mjs routes. See also: ORDER.

**core.hooksPath** - Git configuration selecting a custom hook directory; in-repo install preserves it and prints the gate integration line. Where: project or inherited Git configuration. See also: memory pre-commit hook.

**git unavailable** - Fleet status when spawning Git fails because the executable is missing. Where: memory-fleet.mjs status column. See also: unreadable repo.

**in-repo** - Fleet mode for working memory in a dedicated folder of the project checkout; status includes current or behind by comparing KIT.json with the scanning kit. Where: memory-fleet.mjs status column. See also: in-repo memory.

**in-repo memory** - Working memory inside the project with no independent .git; the project owns commits and hooks, and checkpoint never pushes. Installation requires a Git host and refuses ignored private memory without writes. Fleet combines this mode with current or behind from KIT.json. Where: memory/ or .claude/memory/. See also: memory.inRepoDir.

**inrepo-memory** - Dedicated project folders used as working memory. Where: in-repo memory mode. See also: in-repo memory.

**memory.inRepoDir** - Tracked relative memory folder resolved against each checkout before KIT.local.json and slug defaults, after explicit CLI and environment overrides. Where: scripts/memory/memory.config.json. See also: in-repo memory.

**ORDER** - Migration assertion that each source page's kept hand lines occur in the output in the same relative order; checked before and after writes, with rollback on failure. Numbered index-notes pages are checked as one ordered stream. Where: memory-migrate.mjs routes. See also: contiguous hand block.

**router.after** - Exact rewritten router line recorded by route migration, including its line ending. Where: migration-routes-report.json router entries. See also: router.before.

**router.before** - Literal original router line before link normalization, including its line ending. Where: migration-routes-report.json router entries. See also: router.after.

**unreadable repo** - Fleet status for Git failures other than missing Git or dubious ownership, including the first stderr line. Where: memory-fleet.mjs status column. See also: git unavailable.


## Install compatibility and conservation

**--no-gitignore-fix** - Install reports every ignored tracked output and its matching ignore rule without adding root .gitignore negations. With the flag, excluded parents warn and installation continues without changing .gitignore, including in dry runs. Without the flag, the audit runs before writes, plans and validates narrow kit-folder exceptions, and refuses excluded parents. Ignored private in-repo memory is always refused. Local receipts, backups and locks are excluded from this audit. Where: scripts/install.mjs. See also: host file report, install.

**hand-line conservation** - Route migration keeps every nonblank hand body line verbatim in source order, including custom pure-link labels, in family notes split as index-notes-<family>-2.md and later pages within the topic byte cap. Exact generated labels and target filenames are regenerated rather than copied; their report includes both original and replacement text. The post-write proof rolls back on loss. Where: memory-migrate.mjs routes. See also: ORDER, routes.

**line-ending equivalence** - Text proofs compare CRLF as LF while writers preserve each existing destination's line-ending style. Conserve blocks, generated freshness, router and notes conservation, ORDER and appended host blocks use this rule; raw backups remain byte-exact. Where: engine/lib.mjs and text writers. See also: line-ending preservation, ORDER.

**metadata.engine_version** - Skill version inside the allowed metadata frontmatter map. Strict skill validators permit name, description, license, allowed-tools and metadata. The gate also reads the legacy top-level engine_version and warns to upgrade the skill; upgrade refreshes unchanged installed skills and identical mirrors. A kept host-edited legacy skill gets one WARN to move engine_version to metadata.engine_version; that difference alone does not fail --check. Where: both SKILL.md files; repo.skill-version. See also: repo.skill-version, skill mirror.

## 3.2.6 migration safety

**migration router trigger loss** - migration refusal naming the original MEMORY.md line when an OPEN BEFORE / OPEN when alternative or a table trigger cell is absent from the planned or written router. Destination links, lesson counts, case, whitespace and closing punctuation are normalized per clause; continuation prose is separated from triggers and joined alternatives are compared individually. Overflow trigger rows stay on the router; notes pages do not count. Lowercase wrapped continuations remain part of the trigger clause even after terminal punctuation. Where: `engine/memory-migrate.mjs`. See also: `router.moved`.
**router.moved** - per-row array in migration-routes-report.json naming notes pages that retain a removed router row; empty when the row remains in MEMORY.md. Existing `router.before` and `router.after` retain the original and planned row text. Where: `migration-routes-report.json`. See also: `migration router trigger loss`.

## 3.2.6 checks and fleet reports

**brain inbox notes** - Quick notes anywhere below the configured brain folder's `99-inbox/`. Exempt only from the `brain.frontmatter` id/type requirement; link resolution, edges and wikilink checks still include them. The gate summary and JSON `stats.inboxNotes` report their count. Where: engine/memory-check.mjs. See also: brain.frontmatter.

**desc.slug** - WARN when a description normalized to lowercase alphanumeric words is contained in the similarly normalized filename stem or equals the normalized name field. Descriptions adding words beyond the stem pass unless they equal the name. Conversions must finish with zero findings. Where: engine/memory-check.mjs and docs/CONVERT.md. See also: desc.length.

**fleet.warnProjectsByCheck** - Map of eligible project counts by WARN check ID used by fleet.maxWarnProjects, excluding repo.git-skipped because the fleet itself passes --no-git. Raw project gate warnings remain visible. Where: engine/memory-fleet.mjs JSON metrics. See also: warn-autofix.


## 3.2.7 capture, escalation and repair

**batch** - Capture filled lessons from one Markdown file outside memory with validation before writing, consecutive numbers under one lock, index regeneration and one memory gate run. An unallowed FAIL affecting a created or repeated lesson or generated page restores the previous files, except lesson.enforce findings, which keep the capture and produce exit 1. Where: engine/memory-lesson.mjs and templates/lesson-batch.md. See also: repeat.

**cause** - Repeat classification: slip, not-recalled, rule-wrong or new-case; legacy is written only by conversion. The complete dated entry is at most 200 characters. Where: memory-lesson.mjs repeat and batch. See also: repeat-of.

**classify** - Validate a version-1 JSON kinds map outside memory, report totals and unchanged lessons, then apply with --write under one lock with rollback and one index regeneration, followed by the gate. Where: engine/memory-lesson.mjs classify FILE. See also: metadata.kind.

**enforce** - Record a dated hard-rule, check, hook or reasoned lesson-only decision in metadata.enforced. A strictly later repeat reopens the decision unless lessonOnlyReturns is false for a lesson-only decision. Where: engine/memory-lesson.mjs. See also: repeat.

**failSentence** - Shared no-decision escalation at four repeats by default; enforceSentence recommends a decision at two. A hook, check, hard-rule or reasoned lesson-only decision qualifies. Where: engine/memory-index.mjs. See also: enforce.

**legacy repeat conversion** - Preview dated bold repeat paragraphs without locking or writing; add --write to append distinct dated legacy: entries idempotently without removing prose. Fenced code is skipped; automatic conversion is capped at 20 repeats per paragraph, with larger counts recorded by hand. Flow-map metadata and top-level target keys are refused; move them into block metadata first. Undated paragraphs remain for manual recording and same-day paragraphs inherit the nearest earlier repeat date. Where: engine/memory-lesson.mjs repeat --from-legacy. See also: repeat.

**metadata.kind** - Required at capture: mistake, practice or observation. Generated rows mark practice as (practice) and observation as (observed). Where: templates/lesson.md and engine/memory-index.mjs. See also: classify.

**metadata.trigger** - Optional single-line capture cue of at most 200 characters, such as before testing. Where: memory-lesson.mjs new --trigger and batch trigger. See also: metadata.kind.

**repeat** - Append one dated cause-prefixed single-line note to metadata.repeats, including identical notes recorded on the same day. Causes are slip, not-recalled, rule-wrong and new-case; legacy is reserved for conversion. Use the -- separator before option-like note text, retaining the cause prefix. Flow-map metadata and top-level target keys are refused; move them into block metadata first. Generated index rows display the repeat count and the command recommends enforcement at the configured threshold, default two. Where: engine/memory-lesson.mjs and engine/memory-index.mjs. See also: enforce.

**repeat-of** - Batch lesson identity or memory filename to repeat instead of creating. Its section permits only repeat-of, cause, description and date, with no body. Where: templates/lesson-batch.md. See also: repeat.

**secret-assignment shape** - Host scanner pattern for credential-like assignments with values of at least 16 characters, excluding placeholders; tracked kit sources must carry no matches while secret detection remains intact. Where: tracked-source hygiene test. See also: secret.

**similarLessons** - Up to three matching memory lessons at capture, excluding supersedes and repeat-of targets. Suggestions never block; new keeps path-only stdout and displays suggestions on stderr, while batch JSON includes a similar array for each created lesson. Where: engine/memory-lesson.mjs. See also: batch.

## 3.2.7 command guard, characters and chains

**caps.guard.kitRules** - Optional repo-relative kit rules path; by default the guard reads enforce-rules.kit.json beside its own module. Where: engine/memory-guard.mjs. See also: enforce-rules.kit.json, caps.guard.rules.

**caps.guard.rules** - Host rules path, default scripts/memory/enforce-rules.json; present host fields override kit fields by id. Where: engine/memory-guard.mjs. See also: enforce-rules.json, guard id.

**chars.lost-dash** - Report-only prose detection of a letter or number, space, U+003F QUESTION MARK, space and a letter; code is skipped. Where: engine/memory-chars.mjs. See also: chars.replacement, memory-chars.mjs.

**chars.mojibake** - Character scan covers UTF-8 lead bytes C2, C3 and E2 interpreted as Windows-1252; its extension table has 27 mapped entries. U+00E2 U+20AC followed by a non-continuation image is undecodable and report-only. Where: engine/memory-chars.mjs. See also: memory-chars.mjs repair, chars.replacement.

**chars.replacement** - Report-only detection of U+FFFD REPLACEMENT CHARACTER outside inline code and fences. Where: engine/memory-chars.mjs. See also: chars.lost-dash, memory-chars.mjs.

**enforce-rules.json** - Host-owned version-1 rules seed in templates; an install input, excluded from ownedFiles so upgrades never overwrite host decisions. Where: templates/enforce-rules.json. See also: caps.guard.rules, guard id.

**enforce-rules.kit.json** - Kit-owned starter rules in engine, installed at scripts/memory/enforce-rules.kit.json and refreshed on upgrade; all three starters use warn and carry no lesson numbers. Where: engine/enforce-rules.kit.json. See also: memory-guard.mjs replay, guard action.

**guard action** - Rule action is deny, warn or off; deny exits 2, warn emits PreToolUse additionalContext and off disables matching. Broken rules are skipped and reported with additionalContext; valid deny rules still block. Where: engine/memory-guard.mjs. See also: guard unless, memory-guard.mjs pretooluse.

**guard flags** - Optional regular-expression flags shared by pattern and unless; each expression must compile and must not match the empty string. Where: engine/memory-guard.mjs. See also: guard pattern, guard unless.

**guard id** - Unique per rules file, matching ^[a-z][a-z0-9-]*$; host entries merge present fields by this identity. Where: engine/memory-guard.mjs. See also: enforce-rules.json, guard version.

**guard lesson** - Optional lesson identity string or array, shown in matched-rule messages. Where: engine/memory-guard.mjs. See also: guard message, lesson number.

**guard message** - Required one-line rule explanation of 1-200 characters. Where: engine/memory-guard.mjs. See also: guard lesson, guard action.

**guard pattern** - Required regular expression selecting only the first 4,000 characters of command text; must compile and must not match the empty string. Where: engine/memory-guard.mjs. See also: guard unless, memory-guard.mjs pretooluse.

**guard tools** - Optional subset of Bash and PowerShell, default Bash; matching applies only to the declared tools. Where: engine/memory-guard.mjs. See also: memory-guard.mjs pretooluse, settings.guard.json.

**guard unless** - Optional regular expression suppressing a pattern hit within the first 4,000 command characters; empty-matching expressions are rejected. Where: engine/memory-guard.mjs. See also: guard pattern, piped-gate.

**guard version** - Rules document schema version 1 with a rules array. Where: engine/memory-guard.mjs. See also: guard id, enforce-rules.json.

**inline-script-path** - Bash starter warning for paths in quoted inline Node or Python scripts and unescaped backticks in double-quoted scripts; MSYS drive letters are case-sensitive. Where: engine/enforce-rules.kit.json. See also: memory-guard.mjs replay, guard action.

**memory-chains.mjs** - Chain and long-line scanner with scan, repair and lines commands; write mode locks, preserves bytes outside changes, regenerates indexes and restores snapshots on failure. Where: engine/memory-chains.mjs. See also: memory-chains.mjs scan, memory-chains.mjs repair.

**memory-chains.mjs lines** - Dry-run sentence packing, with --write to apply; greedily packs sentences up to caps.topic.warnLineChars (default 2000), keeping longer sentences whole and refusing cuts that introduce Markdown block markers. Indented lines, lists, headings, tables, quotes, code and verbatim payloads are report-only; whitespace conservation is required. Where: engine/memory-chains.mjs. See also: verbatim payload, caps.topic.warnLineChars.

**memory-chains.mjs repair** - Dry-run insertion of a missing Part N of backlink at body start; --write applies the insertion proof without changing frontmatter, BOM or existing line endings and skips and reports each caps.topic.failBytes overflow while continuing other parts. Where: engine/memory-chains.mjs. See also: parent, caps.topic.failBytes.

**memory-chains.mjs scan** - Reports parts and backlink, number, gap, parent-missing and parent-order problems; parent order defines chain order. Where: engine/memory-chains.mjs. See also: parent, split.chain.

**memory-chars.mjs** - Shared scanChars prose walker and character repair module; scans frontmatter values without changing keys or YAML structure, skips inline code, fences and indented code outside lists, and reports one finding per check with matching-line count. Where: engine/memory-chars.mjs. See also: chars.mojibake, chars.replacement.

**memory-chars.mjs repair** - Dry-run character repair; --write requires an exact UTF-8-to-Windows-1252 round-trip and unchanged intervening segments and byte totals. Allow entries, encoding discussion and lines containing both forms are report-only; invalid UTF-8 files are skipped and reported; snapshots restore on regeneration failure. Where: engine/memory-chars.mjs. See also: chars.mojibake, memory-lock.mjs.

**memory-guard.mjs** - Command guard with pretooluse, prompt, test FILE and replay FILE commands; runtime errors fail open with a problem-naming context message. Where: engine/memory-guard.mjs. See also: settings.guard.json, enforce-rules.json.

**memory-guard.mjs pretooluse** - Consumes hook JSON on stdin and checks Bash or PowerShell command text; ignores other tools and absent command strings. Rule paths resolve against --repo, then CLAUDE_PROJECT_DIR, then the root derived from the module location, never the hook cwd. Where: engine/memory-guard.mjs. See also: guard action, caps.guard.rules.

**memory-guard.mjs prompt** - Prints a local and UTC clock line for UserPromptSubmit. Where: engine/memory-guard.mjs. See also: settings.guard.json, memory-guard.mjs.

**memory-guard.mjs replay** - Reads one command per line or JSONL command fields; prints each rule count, percentage and first 20 hits, escaping CR/LF and limiting each printed command to 200 characters. Before opting into deny, replay host commands and require a rate below 0.5 percent with every sampled hit a real hazard. Where: engine/memory-guard.mjs. See also: piped-gate, guard action.

**memory-guard.mjs test** - Reads command text from a positional file and prints matching rule ids and actions; --tool selects Bash or PowerShell. Where: engine/memory-guard.mjs. See also: guard tools, guard pattern.

**parent** - Explicit frontmatter chain parent wins, including a moved_to stub parent. Otherwise the first matching name decides: background-N, background, part-NN, then N; the base must exist and no later pattern is tried. Lessons, state files, hard-rule cards and generated pages are excluded as parts; hard-rule cards and state files may be parents. Where: engine/memory-chains.mjs. See also: memory-chains.mjs scan, memory-chains.mjs repair.

**piped-gate** - Bash starter warning for a piped check gating git commit or push with && or ||; read-only segment heads, semicolon and newline separators are excluded, and pipefail or PIPESTATUS suppresses it. Where: engine/enforce-rules.kit.json. See also: memory-guard.mjs replay, guard action.

**piped-gate-ps** - PowerShell starter warning for piped checks followed by commit or push through semicolon, if ($?) or && forms, including & git and git.exe. Where: engine/enforce-rules.kit.json. See also: memory-guard.mjs replay, guard action.

**settings.guard.json** - Install-input hook template for PreToolUse Bash|PowerShell and UserPromptSubmit, each with a five-second timeout; not an owned installed template. Where: templates/settings.guard.json. See also: memory-guard.mjs pretooluse, memory-guard.mjs prompt.

**split.chain** - Chain scan result contains parts with file, parent and integer n, and problems with file, kind and detail. Numbering, gaps and parent order remain report-only. Where: engine/memory-chains.mjs. See also: memory-chains.mjs scan, memory-chains.mjs repair.

**verbatim payload** - BEGIN VERBATIM PAYLOAD through END VERBATIM PAYLOAD HTML comment blocks preserve long lines during repair. Verbatim blocks and list items remain unchanged; eligible prose paragraphs can be split at sentence boundaries. Where: engine/memory-chains.mjs. See also: memory-chains.mjs lines, caps.topic.warnLineChars.

## 3.2.7 gate, recall and measurement

**caps.guard** - Kit and host rule file configuration; both files are merged and validated when a repo is known. Where: memory.config.json. See also: caps.guard.kitRules, caps.guard.rules.

**caps.lesson** - Repeat escalation settings, applied with defaults for unmerged project configurations. Where: memory.config.json. See also: lesson.enforce.

**caps.lesson.enforceAfterRepeats** - No-decision warning threshold, default two repeats. Where: memory.config.json. See also: lesson.enforce.

**caps.lesson.failAfterRepeats** - Failure threshold, default four repeats without a decision or four strictly after one. Where: memory.config.json. See also: lesson.enforce.

**caps.lesson.lessonOnlyReturns** - Default true; false silences later-repeat escalation for lesson-only decisions. Where: memory.config.json. See also: lesson.enforced.

**caps.router.failLines** - Router failure threshold, default 200 lines, excluding a terminal newline. Where: memory.config.json. See also: router.lines.

**caps.router.warnLines** - Router warning threshold, default 150 lines. Where: memory.config.json. See also: router.lines.

**caps.topic.warnLineChars** - Long prose line warning threshold, default 2000 characters. Where: memory.config.json. See also: topic.line.

**config.caps** - Failure naming an invalid cap key and value; the gate uses the documented default. Repeat thresholds, topic line length and router line counts must be positive integers, lessonOnlyReturns a boolean, and guard paths non-empty strings. Where: engine/memory-check.mjs. See also: caps.lesson.

**date.future** - Date, modified date part, repeat and enforcement dates warn one UTC day ahead and fail later. Where: engine/memory-check.mjs. See also: lesson.repeats.

**enforce.rules** - Validate merged kit and host rules and lesson references; messages use repo-relative rules-file paths. Warn when a lesson names a rules hook but no merged rule names the lesson. Missing kit rules WARN only when .claude/settings.json has a memory-guard hook. Where: engine/memory-check.mjs. See also: caps.guard.

**forgetting.repeats** - Total recorded repeat entries in measurement; repeatsPerMonth groups valid entries by date month and repeatsByCause by cause. Malformed entries contribute only to the total. Where: engine/memory-measure.mjs. See also: forgetting proxy.

**lesson.enforce** - Warn at two repeats and fail at four without a decision; after a decision warn at one strictly later repeat and fail at four. A present but invalid decision counts as no decision: all repeats use the two/four thresholds, alongside lesson.enforced. Where: engine/memory-check.mjs. See also: lesson.enforced.

**lesson.enforced** - Warning for malformed or invalid dated decisions, hard-rule cards, checks, repo hook files or short lesson-only reasons. Invalid decisions also trigger lesson.enforce at the no-decision thresholds, including renamed or deleted targets. Where: engine/memory-check.mjs. See also: enforce.

**lesson.kind** - Failure when a present kind is not mistake, practice or observation. Recall weights kind once and trigger twice; --kind filters results. Where: engine/memory-check.mjs and engine/memory-recall.mjs. See also: metadata.kind.

**lesson.kind-missing** - One warning on MEMORY.md counting lessons without kind and directing classification. Where: engine/memory-check.mjs. See also: classify.

**lesson.repeats** - Failure for a non-list repeat field or entries without a valid date and cause, or above 200 characters. Measurement reports repeat totals, months and causes. Where: engine/memory-check.mjs and engine/memory-measure.mjs. See also: repeat.

**lesson.trigger** - Warning for a repeated lesson without a trigger cue. Where: engine/memory-check.mjs. See also: metadata.trigger.

**lesson.unfilled-body** - Failure for an exact Why or How to apply prompt line with an empty section after the lesson title; free-form bodies remain valid. Where: engine/memory-check.mjs. See also: lesson.unfilled.

**router.lines** - Warn above 150 lines and fail above 200 by default; an empty router has zero lines. Where: engine/memory-check.mjs. See also: caps.router.warnLines, caps.router.failLines.

**topic.line** - One warning per non-special, non-generated file counts long body lines outside fences and verbatim payloads; indented lines remain report-only. Session-start skips this, split.chain and chars checks. Where: engine/memory-check.mjs. See also: caps.topic.warnLineChars.

## 3.2.7 installation and upgrade

**--no-guard** - Install/upgrade preference persisted as guard: false in KIT.local.json, merged without discarding memoryDir. Later upgrades honor it. Where: scripts/install.mjs. See also: settings.guard.json.

**hook (two meanings)** - A lesson metadata.hook is a short index sentence; an enforcement hook is executable command checking, recorded as a dated enforced target. Where: engine/memory-lesson.mjs. See also: memory-guard.mjs.

**NEW_CHECKS** - Release-specific list of new FAIL-capable ids; incoming pre-existing findings compare by check and file, while unlisted failures retain rollback. Where: scripts/upgrade.mjs. See also: config.caps, router.lines.

## Lesson casebook and labelling (3.2.8)

- **LESSON-KINDS.md**: kit-owned `docs/LESSON-KINDS.md`, installed as
  `scripts/memory/LESSON-KINDS.md`; public generic cases, never private examples.
- **K0**: ordered classification questions. **T1**: harm; **T2**: incident scope;
  **T3**: accepted verdict; **T4**: tool behaviour versus our command shape.
- **K1**: empty/pointer exclusion; **K2**: tool observation; **K3**: command mistake;
  **K4**: step-shaped near-miss practice; **K5**: accepted verdict mistake;
  **K6**: harm outranks imperative title; **K7**: repeated human effort is harm;
  **K8**: one success is recipe; **K9**: separate new behaviours;
  **K10**: case overrides written kind.
- **metadata.kind_case**: optional case id, set by `memory-lesson.mjs new --case Kn`,
  batch **case:** or `memory-lesson.mjs classify FILE --write` with a **cases** map.
- **kind.case**: WARN for a present unknown id, or missing casebook when an id is present.
- **kind.case-superseded**: WARN for a case replaced by a dated case's **supersedes:**
  line. `memory-lesson.mjs classify --case Kn [--json]` lists carriers for relabelling.
- **LABELLING.md**: public independent-labeller instructions, installed in scripts/memory/.
- **classify --score A.json B.json [--reference reference.json] [--json]**: label every
  row independently and score the pair. Person-set labels are hand-set takeaways. Files
  contain **version: 1**, **kinds**, optional **cases** and **confidence** (0-1 per row).
  Counts use the union of both row sets. The kind test allows at most 6 of 40
  disagreements, scaled as floor(rows * 6 / 40); empty or unequal row sets FAIL.
  Optional historical **--reference** scoring supports **unscored** row names and
  separately requires 84% overall, 70% practice/observation and at most 15%
  disagreement, rounded up/up/down. Its **constant-mistake baseline** predicts
  mistake everywhere. Text uses `historical mark:`, `historical PASS` and `historical FAIL`;
  JSON adds `historical: true` to `mark`, `A` and `B`, retaining existing verdict keys.
  The kind-test line is the only bare PASS/FAIL. Reports exit 0; invalid input exits 1. No score authorizes writing.
- **--name=value**: refused by the shared args() parser; use **--name value**. Node and Git
  options use their own parsers. Repeated routes keep first occurrence order.
- **config.caps group**: a non-object group produces one FAIL and uses that group's defaults.
- **realpath containment**: enforce resolves hook/check files through symlinks/junctions;
  the resulting file must remain within the resolved repo.
- **recorded decision is invalid**: appended reason on lesson.enforce WARN/FAIL when a
  malformed or missing-target decision counts as no decision.
- **settings preview**: upgrade --check says hooks **would be added**; apply says **added**.

## Case check identifiers

**kind.case** - WARN for a present unknown kind_case or a missing casebook when a case is recorded. Where: engine/memory-check.mjs and scripts/memory/LESSON-KINDS.md. See also: metadata.kind_case, LABELLING.md.

**kind.case-superseded** - WARN until carriers of a superseded case are relabelled. Where: engine/memory-check.mjs and scripts/memory/LESSON-KINDS.md. See also: classify --case, supersedes.

## Takeaway fields and checks

**lesson.takeaway** - WARN for a present value other than fix, method or know; absence is valid. Where: engine/memory-check.mjs. See also: metadata.takeaway.

**metadata.takeaway** - Optional hand-set takeaway: fix (error and remedy), method (best way or next-time action), know (how things work). Models label kind; people set takeaway. Capture with new --takeaway, batch takeaway:, or classify takeaways; recall displays and filters it. Where: engine/memory-lesson.mjs and engine/memory-recall.mjs. See also: lesson.takeaway.
