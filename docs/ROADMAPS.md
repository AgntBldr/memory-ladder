# Roadmap procedures

A roadmap that grows past `caps.roadmap.warnBytes` (61,440 bytes by default) needs its old entries moved out. The gate
tells you two things: `repo.roadmap` says the file is too big, and `repo.roadmap-no-rotation` says the kit's own rotation
has nothing it may move, so the shrinking has to be done another way. Pick the procedure below that fits the roadmap,
write it down in the project's instructions file, and name it in `caps.roadmap.procedure`.

Nothing here deletes anything: every procedure moves text word for word to a history file and proves it can be put back.

## Open work with dated blocks

Use this when the roadmap has a `## Open work` section whose entries are dated blocks: a line that starts with
`**YYYY-MM-DD` and runs to the next such line.

- The kit does the work. A checkpoint in the default `all` mode (unless it is given `--no-rotate`) runs
  `memory-rotate.mjs roadmap`; a session-mode checkpoint never rotates, so run the command yourself. It keeps
  `caps.roadmap.keepBlocks` blocks (six by default, never fewer than two), keeps moving the oldest blocks past that
  while the file is still over `caps.roadmap.warnBytes`, and never moves the last two.
- Moved blocks go unchanged to the history file `caps.roadmapHistory.path`, under a heading
  `## Open work — dated blocks moved <date>`, in the order they had in the roadmap.
- `caps.roadmap.order` says which end holds the oldest block: `newest-first` (the default) or `oldest-first`.
- To see what would move: `node scripts/memory/memory-rotate.mjs roadmap`. Add `--write` to move it. The command
  checks that every moved block is in the history file and that the bytes removed equal the bytes added.
- While the planner would move something, `repo.roadmap-no-rotation` stays quiet. `repo.roadmap` still warns until
  the file is under the limit.

## An anchored block mover

Use this when the roadmap is organised by hand, with no dated `## Open work` blocks for the kit to rotate. The project
documents its own mover: a script, named in its instructions file, that

- takes one block by its anchor heading and moves it word for word to a new file under a history folder (for example
  `docs/roadmap-history/`),
- proves that the roadmap and the new file together rebuild the original exactly,
- leaves a one-line link where the block was, and
- adds a recall probe so the moved text can still be found.

The instructions file says when to run it, for example when the roadmap nears 60 KB or reaches 80 KB. This is the
project's documented procedure, never a restructure: do not reshape the roadmap to make the kit's rotation apply.
Set `caps.roadmap.procedure` to one line naming the script and where its rules are written.

## Anything else

If neither fits, there is no procedure yet. `repo.roadmap-no-rotation` keeps warning and says so. Write the procedure
down first (what moves, where it goes, how the move is proved and how it is undone), then name it in
`caps.roadmap.procedure`.

## What the warning does and does not do

- `repo.roadmap-no-rotation` is a WARN. It never blocks a commit and it is never a new reason for an upgrade to roll back.
- It appears only when the roadmap is over `caps.roadmap.warnBytes` and the rotation planner, run without writing
  anything and with the configured order and limits, finds no bytes it may remove.
- A roadmap the planner could still shrink does not warn: a rotation will move it.
- `caps.roadmap.procedure` is optional text. It changes the guidance in the message and nothing else; the check is the
  same with or without it.
- Bad input has its own report: an unknown `caps.roadmap.order` is `config.roadmap-order`, and any other reason the planner
  refuses (`caps.roadmap.keepBlocks` below two, a dated block with an impossible date, a history path that is not a
  readable regular file) is `repo.roadmap-rotation`.
