# About the limits

The memory gate, `memory-check.mjs`, holds every layer of the ladder to a size or a structure limit. This page explains
what each limit protects, how the gate enforces it, where old information goes, and where each number came from. The
defaults themselves are in the table in [How memory works](HOW-IT-WORKS.md#2-the-picture), and every check and config
key is in the [engine reference](../engine/README.md).

Config values are bytes. Sizes on this page are KiB (1,024 bytes). Figures quoted from past measurements are KB as they
were recorded.

## The limits control what gets loaded, not what gets stored

An agent pays for memory in two ways. What loads at session start costs context in every session. What a trigger
opens costs context every time the trigger fires. A file that nothing opens costs nothing. So the limits sit on the
files that load or open often, and a memory of a thousand files passes the gate when each layer stays inside its job.

Every layer gets a limit because a limit on one layer only moves the growth to the next one. In real memories the router
stayed under its budget while the indexes below it grew to 240 KB. [WHY](../WHY.md) gives the idea behind the layers.

## One limit comes from Claude Code itself

Claude Code's documentation says: "The first 200 lines of `MEMORY.md`, or the first 25KB, whichever comes first, are
loaded at the start of every conversation. Content beyond that threshold is not loaded at session start." Topic files
are not loaded at startup. Claude reads them when it needs them. Source:
[How Claude remembers your project](https://code.claude.com/docs/en/memory), checked 2026-10-27.

The first router budget was set against that cutoff (see [Router](#router-memorymd)). The FAIL at 16 KiB keeps
`MEMORY.md` well inside it. The `router.lines` check WARNs above 150 lines and FAILs above 200, even when bytes remain below the cap.

The same page advises keeping each `CLAUDE.md` "under 200 lines", because "Longer files consume more context and reduce
adherence", and imported files count toward that cost. The kit's `AGENTS.md` warning serves the same purpose with a
byte limit instead of a line count.

Every other number on this page is the kit's own choice.

## How the gate enforces a limit

The gate reports two kinds of finding:

- **FAIL** means something breaks or is lost if you commit now. Examples: the router is over its budget, a link
  points nowhere, a generated index is out of date, a lesson still says TODO, a kit script was edited without a version
  change, or a secret is in a file. The gate exits 1.
- **WARN** means drift that needs a decision but breaks nothing today. Examples: a long description, an old project
  note, an unpushed commit, or a shelf review that is due. The gate prints it and exits 0.

Most limits warn at roughly 40% to 75% of their failure value. The warning arrives while there is still room to fix
the problem without a deadline.

The gate runs in four places:

1. The memory repo's pre-commit hook runs `memory-check.mjs --hook --scope memory` on the staged files. A FAIL stops the
   commit. This run checks the memory folder only. The project-side checks (roadmap, brain log, `AGENTS.md`, shelf and
   brain nodes) run at session start, at checkpoint, and when you run the gate by hand.
2. Claude Code's SessionStart hook runs `memory-check.mjs --session-start`. It prints at most five gate lines plus one repeat-summary line and always
   exits 0. It reports and never blocks.
3. `memory-checkpoint.mjs` runs the gate before it commits and pushes.
4. Agents without hooks run `node scripts/memory/memory-check.mjs` by hand, as `AGENTS.md` tells them to. The hooks
   make the check automatic in Claude Code. The `AGENTS.md` routine is the guard that works in every agent.

### Exceptions are written down and can only shrink

An allow entry in `memory.config.json` accepts one finding on purpose. It needs a check, a file, a reason, and the date
it was added. It can carry a `ceiling`, the value measured when the entry was written. An allowed finding still shows in
`--json` output but does not count. If the finding grows past its ceiling, the gate reports it again. A secret, a broken
config, and an unparseable file can never be allowed.

A hand-written index has a pin: its size plus 1,024 bytes. `--ratchet-pins` lowers a pin when the file shrinks and never
raises one. Generated indexes use a byte budget for the page that loads instead of a pin.

Never raise a limit, a pin, or a ceiling to make the gate pass. Move the detail down a layer instead: history goes to a
background file, a project fact goes to the brain, and an old state block goes to git. A limit that moves up whenever
it is reached does not limit anything.

## Where old information goes, and when

Old information leaves the files that load. It is not thrown away. Each kind has its own destination and its own
moment, and only some of the moves are automatic. "The archive" means `ARCHIVE.md`, and only shipped work goes there.

| What | When it moves | Where it goes | What moves it | Loaded by default |
|---|---|---|---|---|
| Session transcripts | Never moved by the kit | Claude Code deletes them after its `cleanupPeriodDays` retention period | Claude Code | No |
| Something learned in a session | When it is learned | A new lesson file (`memory-lesson.mjs new`) | The agent | No; recall finds it |
| The handoff in the state file | At every checkpoint | Overwritten in place. Earlier versions stay in git history | The agent writes it. `memory-checkpoint.mjs` commits it (memory inside the project repo: with `--commit`) | Read at resume |
| An active-work line in the router, once the work ships | At the next checkpoint | One pointer line in `ARCHIVE.md`, with its tag or commit | The agent. No script does this | No |
| Older lessons | When newer lessons fill the 8 KiB hot page | Only the catalog pages list them. The lesson file stays | `memory-index.mjs`, run by the checkpoint | No |
| A lesson that repeats | When it recurs | One dated entry in metadata.repeats; after two decide enforcement | The agent, memory-lesson.mjs repeat/enforce | No |
| A lesson replaced by a newer one | When the new lesson names it in `supersedes` | Off the hot page, still in the catalog | The agent, then `memory-index.mjs` | No |
| A lesson proven wrong | When it is proven wrong | Deleted. Git history keeps it | The agent | No |
| History and explanation in a hard-rule card | When the card is written, or when it nears 2 KiB | The card's background file | The agent | No. The card links to it |
| Dated "Open work" blocks in the roadmap | At checkpoint, beyond six blocks (two when over the warning size) | `docs/ROADMAP-HISTORY.md`, unchanged | `memory-rotate.mjs`, run by the checkpoint | No |
| Brain log entries | At checkpoint, beyond the last 20 | `brain/00-system/log-YYYY-MM.md`, by each entry's own date | `memory-rotate.mjs`, run by the checkpoint | No |
| A paused program | When it is paused | `docs/shelf/<name>.md`, with a review date no more than 90 days away | The agent | No. The gate fails a review date more than 90 days out and warns when the review is due |
| A fact about the project | When it is learned | A brain node. Memory keeps a pointer | The agent | When work routes to it |

A session itself is never archived. What survives it is what the agent wrote down: lessons at the moment of learning,
and the handoff and any moves at the checkpoint. A transcript is a raw record that Claude Code manages. To keep
transcripts longer, raise [`cleanupPeriodDays`](https://code.claude.com/docs/en/settings-reference#cleanupperioddays) in
Claude Code's settings.

## Each limit and where its number came from

The limits are design choices informed by observed memory growth. They are not performance guarantees.

### Router: `MEMORY.md`

- **Limit.** WARN above 12 KiB. FAIL above 16 KiB, or on any line longer than 600 characters. The line-count FAIL above 200 comes from Claude Code loading only the first 200 lines of MEMORY.md; WARN above 150 is the kit's margin.
- **Why.** The router loads into every session, and Claude Code does not load whatever is past its cutoff.
- **Where the number came from.** The 12 and 16 KiB budgets leave room below the observed loading ceiling. The exact calculation behind these choices and the 600-character line limit is not recorded. For example, keep a trigger and pointer in the router and move a long explanation into the linked file.

### Hard-rule cards

- **Limit.** WARN above 2 KiB. FAIL above 4 KiB.
- **Why.** A hard rule opens every time its trigger fires, for example on every delegation or every deploy, and the
  agent has to read all of it at that moment.
- **Where the number came from.** In real memories, the hard-rule files totaled 84 KB, and the rule that fired on
  every delegation was 32.7 KB, about 8,000 tokens each time. The kit estimates 4 bytes per token, so 2 KiB is about
  500 tokens, roughly one screen. The 2 and 4 KiB values are a design choice, not a measured
  threshold. After the rules were split, the bytes opened by triggers fell from 85.9 KB to 14.9 KB.
- **The condition that comes with it.** A card keeps every value needed to obey it: the command, the path, the
  account, and the quota. Only history and explanation move to its background file. A card that fits the limit
  because its command was moved out has failed, even though the gate passes.

### State file

- **Limit.** WARN above 4 KiB. FAIL above 8 KiB, or with more than one `CURRENT` or `RESUME` heading.
- **Why.** The state file is read at every resume and handoff, and only the current block is useful.
- **Where the number came from.** In another memory, the state file had reached 209 KB with 40 "resume here" blocks, 86%
  of them superseded. The kit uses one current block, overwritten at each checkpoint. Git keeps the
  earlier blocks. The sizes fit one block of handoff text.

### Descriptions

- **Limit.** WARN above 200 characters. FAIL above 400 characters, or when the description is a changelog (it contains
  "Newest:"). WARN when it only repeats the filename (`desc.slug`).
- **Why.** Recall weights the name most, then the description and the first heading equally, then the first 400
  characters of the body. A generated index line prints the description, or the lesson's `hook` when one is set.
- **Where the number came from.** In another memory, 231 of 454 descriptions exceeded 300 characters as descriptions grew into running changelogs. 200 characters is about one
  sentence. A description that repeats the filename gives recall no new words to match.

### Topic and lesson files

- **Limit.** WARN above 8 KiB. FAIL above 20 KiB.
- **Why.** A recall result opens one file. It should hold one idea.
- **Where the number came from.** In another memory, 24 files over 20 KB were running journals: one was 130 KB, and a
  99 KB file held nine resume headings. 20 KB had been a warning. The kit made it a failure and
  added the 8 KiB warning, so a growing file gets split into linked files instead of appended to.

### Generated indexes

- **Limit.** The page that loads (the hot page) holds topics, pinned lessons, and then the newest lessons until it
  reaches 8 KiB. The gate warns only when topics and pins alone are over 8 KiB. Catalog pages split at 24 KiB, and a
  catalog or hand-written index page over 24 KiB fails. Index lines WARN above 300 characters and FAIL above 450.
- **Why.** An index opens after the router routes to it, so the page that loads has a budget. The full catalog is paged
  and opened only for a wider search.
- **Where the number came from.** In real memories, condensing indexes reduced them from 240 KB to 105 KB and set limits
  just above the result, with the largest index at 20 KB and the longest line at 370 characters, so that regrowth
  would fail. The indexes still grew back about 2.2 KB a day inside the room those limits left. Per-file pins at the
  file's own size plus a small margin replaced that room. Since kit 3.2 the indexes are generated and the page that
  loads fills to a fixed budget.
- **Pins.** A pin is the file's size plus 1,024 bytes, with a warning under 400 bytes of room. Pins at the exact size
  failed on every new lesson, so the room became 1 KiB.

### Archive

- **Limit.** FAIL on any line longer than 300 characters.
- **Why.** `ARCHIVE.md` is not loaded by default. It is a list of pointers to shipped work, and the line limit keeps it
  from turning into a second journal.

### Brain log and brain index

- **Limit.** The log warns above 50 KiB, fails above 100 KiB, and keeps its last 20 entries after rotation. The
  compact brain index has a 12 KiB maximum.
- **Why.** If a project's `AGENTS.md` sends agents to the end of the log, the log costs context at session start. The
  kit's measurement counts the last 10 entries as session-start cost. The index is read whenever work routes into the
  brain.
- **Where the number came from.** In another memory, a log reached 1.66 MB. Rotation copies older entries
  unchanged into monthly files. The 12 KiB index maximum matches the router's warning size. No separate measurement
  is recorded for it.

### Roadmap

- **Limit.** WARN above 60 KiB. FAIL above 80 KiB. Rotation keeps six dated "Open work" blocks by default, and as few as
  two when the roadmap is over its warning size.
- **Why.** The roadmap is read and refreshed at every checkpoint.
- **Where the number came from.** The live roadmap stays within 80 KiB, with history in a separate file and a generated overview. In real memories, rotation took the live roadmap from 434.7 KB to 32.8 KB.

### `AGENTS.md`

- **Limit.** WARN above 16 KiB. There is no FAIL.
- **Why.** It loads at agent startup. Claude Code advises keeping each instruction file under 200 lines. The kit
  measures bytes instead.
- **Where the number came from.** 16 KiB matches the router's failure size. No separate measurement is recorded. It is a
  warning only, because `AGENTS.md` is the project's own instruction file and the gate does not block on it.

### Smaller limits

- **Unpushed memory commits.** WARN at 1, FAIL at 10. An unpushed commit exists on one computer only. The values are design choices for detecting push drift.
- **Stale notes.** WARN when a state file, or a note of type `project` or `reference`, was last committed more than 45
  days ago. A note marked `stable: true` is skipped. Facts about a project go out of date and lessons do not. Older
  gates flagged stable files too, which produced 8 false warnings in another memory. No calculation behind the
  number 45 is recorded.
- **Shelf review.** A paused program in `docs/shelf/` needs a review date no more than 90 days after it was shelved.
- **Brain nodes.** Off by default. When on, the gate warns on a body over 350 words or a summary over 200 characters,
  design choices for compact brain nodes.

## What the limits are not

- A limit is not a target. A router at 15 KiB passes with a WARN, and it still costs more in every session than one at
  6 KiB.
- The limits do not cap the total size of a memory. Stored files cost nothing until something opens them.
- A WARN is not a failure. "ok" from the session-start hook means no FAIL that is not allowed. It does not mean zero
  warnings.

## Character checks and repeat limits

`chars.replacement`, `chars.mojibake` and `chars.lost-dash` WARN on memory prose, skipping code. The last check is
heuristic; deliberate examples need dated allow entries. `memory-chars.mjs repair` previews clean Windows-1252
round-trip repairs; allow deliberate examples before `--write`. U+FFFD and lost dashes remain report-only.

Commit the host rules file in the project repository before recording any `enforced "<date> hook <file>"`
decision. If the file is missing in the checked-out repo, that decision counts as no decision and can FAIL the
memory pre-commit at four repeats.

Without a valid decision, `lesson.enforce` WARNs at two repeats and FAILs at four. An invalid present `enforced`
(including a renamed/deleted hook file) counts as no decision and also WARNs `lesson.enforced`. After a valid decision,
one strictly later UTC-date repeat WARNs and four FAIL; same-day repeats do not reopen it. Record another decision
with `memory-lesson.mjs enforce`; a reasoned lesson-only decision counts. `caps.lesson.lessonOnlyReturns` defaults
true; false keeps valid lesson-only decisions quiet permanently. Never allow escalation instead of deciding.

`date.future` compares date, modified date part, repeat dates and enforcement date with the UTC date of now:
one day ahead WARNs, later FAILs. Hand-written `date:` uses UTC. The guard clock prints local time first and UTC second.

`topic.line` WARNs above 2,000 characters outside fences and verbatim payload blocks. The line repair packs only at
sentence ends; list items, indented lines and paragraphs without a sentence end remain report-only. Five to twelve
lines is writing guidance, never a check. `lesson.unfilled-body` FAILs empty exact Why/How to apply prompt sections;
free-form bodies with no such prompts remain valid. Session-start skips chars, chain and topic-line scans; run the full gate.

## 3.2.8 casebook limits

Kind cases are optional WARN-only evidence, not semantic classification by the gate.
No casebook is required for old lessons without kind_case. Scoring reports agreement,
not truth. Label every row independently and score the pair with
`classify --score A.json B.json`: at most 6 of 40 disagreements, scaled down.
Empty or unequal row sets fail the kind test. Person-set labels are hand-set takeaways.
Optional historical `--reference` scoring retains its separate thresholds and baseline.
Malformed config.caps groups produce one FAIL naming the group and use kit defaults;
fix the config rather than raising caps. Case supersession never rewrites lessons.
