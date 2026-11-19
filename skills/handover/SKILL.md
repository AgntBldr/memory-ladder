---
name: handover
description: /handover, /handover quick; whole message handover, hand over, do a handover, lets do a handover, end session, end of session, session end, quick handover. Run only when asked; never offered unprompted.
metadata:
  engine_version: "3.3.10"
---
Full by default: /handover, phrases without "quick".
Put Note: text in state within its cap.
Do close: steps first; ok/failed in closed.
Safe to compact means all three hold: memory is updated; learning is added; the roadmap holds the current state (you updated it, or you name the line that already holds it). A commit or a push is not one of the three.
Full: lessons="none (<reason >=10 chars>)" or "later (<what happened and the rule you would write, not a title; >=40 chars, 6 words>)" (saves a draft lesson to finish by editing it) or recall twice: `node scripts/memory/memory-recall.mjs "<question>"`; batch <=3 lessons outside memory: ## Title, kind, route, description, blank, filled **Why:** and **How to apply:**.
Full: roadmap="updated (<words copied from a roadmap line you added>)" or "nothing new (<words copied from the line that already holds this state>)". Quick: lessons, roadmap optional; omit --lessons.
Write temp JSON outside the project: strings state 240, question/lessons 320, waits/risks/constraints 240 B, roadmap 160 B; next: 1-3 unnumbered strings (480); closed: {step: ok|failed} for overlay close: steps only (320). <=1952 B full/1184 quick.
`node scripts/memory/handover.mjs run --in <file>`; --quick, --lessons <batch>, --over <last token> (start line or last handover report).
Reply: printed report verbatim + <=1 line; never type SAFE yourself.
NOT FINISHED = commit, push, close or log undone: with SAFE, run its finish lines or the finish by hand line, not /handover. SAVE REFUSED, STATE SAVED: no verdict.
NOT SAFE: fix verdict cause; re-run (none: /handover); never re-pass --lessons once written.
Omit constraints for default.
Calls: full 2 (5 with lessons), quick 2.
