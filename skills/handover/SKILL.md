---
name: handover
description: /handover, /handover quick; whole message handover, hand over, do a handover, lets do a handover, end session, end of session, session end, quick handover. Run only when asked; never offered unprompted.
metadata:
  engine_version: "3.3.7"
---
Full by default: /handover, phrases without "quick".
Put Note: text in state within its cap.
Do close: steps first; ok/failed in closed.
Full: lessons="none (<reason >=10 chars>)" or recall twice: `node scripts/memory/memory-recall.mjs "<question>"`; batch <=3 lessons outside memory: ## Title, kind, route, description, blank, filled **Why:** and **How to apply:**.
Quick: omit lessons/--lessons.
Write temp JSON outside the project: strings state 240, question/lessons 320, waits/risks/constraints 240 B; next: 1-3 unnumbered strings (480); closed: {step: ok|failed} for overlay close: steps only (320). <=1792 B full/1024 quick.
`node scripts/memory/handover.mjs run --in <file>`; --quick, --lessons <batch>, --over <last token> (start line or last handover report).
Reply: printed report verbatim + <=1 line; never type SAFE yourself.
NOT SAFE: fix verdict cause; re-run (none: /handover); never re-pass --lessons once written.
Omit constraints for default.
Calls: full 2 (5 with lessons), quick 2.
