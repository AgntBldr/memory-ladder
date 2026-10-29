# Batch capture

Save this file outside memory. Each level-two heading starts a lesson; use
level-three headings inside bodies. Run memory-lesson.mjs batch FILE --dry-run
to validate, then omit --dry-run to capture the lessons together.
Optional keys include `case: K4` (installed casebook id), `supersedes: ["existing-lesson.md"]` (existing memory
file names) and `date: YYYY-MM-DD` (defaults to today).

Optional `takeaway: fix` (`fix` | `method` | `know`) records a person's hand-set
view. Models label `kind`; never infer a takeaway by default.

## Validate before writing
kind: mistake
trigger: before writing a batch
route: craft-sessions
description: "Validate all inputs before changing files in a multi-file operation."
pin: false
hook: "Validate the whole batch before writing."
type: feedback

**Why:**
A late validation failure can leave a partially written batch.

**How to apply:**
Collect validation errors first, then write under one lock with rollback.

## Verify the resulting state
kind: practice
route: craft-sessions
description: "Check the resulting files and indexes after a capture operation."

Run the memory gate after capture and inspect any findings before proceeding.

## The same rule recurred
repeat-of: 1
cause: slip
description: Validation was skipped again.
