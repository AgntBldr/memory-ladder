# Lesson kinds

Mistake: something went wrong; say what not to do and what to do instead.
Practice: something worked and should be done again: a flow, loop, check or hook.
Observation: how a tool or service really behaves, neither good nor bad; verify
before relying on it.

## Takeaway (set by hand)

Models label `kind`; people set optional `metadata.takeaway`:
- `fix`: an error and how to fix or avoid it.
- `method`: the best way to do something; what to do next time.
- `know`: how something works or happens; keep it in mind.
Models never set `takeaway` by default.

## K0: decision order

First yes wins; use T1-T4.
0. Empty or pointer-only? K1.
1. Explicit kind or Practice/Observation description? Keep unless a case
   overrides it (K10).
2. Did our act or omission let a wrong thing past us? Mistake (K5-K7).
3. Did our check clear it, get accepted, then get overturned? Mistake (K5).
4. Does the title describe a tool's surprise under normal use?
   Observation (K2). Our command hazard is K3.
5. Does the title name a deliberate step, proved in the body, without harm or an
   acted-on verdict? Practice (K4); for a recipe see K8.
6. Otherwise mistake. For doubt, see K8; label every row.

T1: Harm includes a false report, a wrong thing pushed, merged, deployed or
published, data loss, money/quota spent, work redone, a task rerun, or the person deciding
or acting again. Diagnosis alone is not rework. Harm outranks title shape.
T2: Finding pre-existing defects is not harm.
T3: Accepted means a next step used the verdict: a trim list, rewrite, merge, handoff or
done record. Planned review with no reliance is not accepted. If unstated, presume
accepted; K4 applies only to a true near-miss, never an acted-on verdict.
T4: Pipes, redirects, cross-shell quoting, inline strings, flag syntax, blind sequencing
and masked exceptions are our command shape (K3). Normal-use surprises are K2. If both
appear, the title selects; the other half is a related rule. Step titles go to step 5.

## Cases

### K1
Question: Empty or only a pointer?
Classification: Not a lesson; label provisionally and check links before removal.
Example: A bare link.
Status: current

### K2
Question: A tool surprised normal use?
Classification: Observation; a closing do/never is a related rule.
Example: A save leaves a stale view.
Status: current

### K3
Question: Our command was a known trap?
Classification: Mistake (T4).
Example: A pipeline hides a failed check.
Status: current

### K4
Question: Caught before harm or reliance?
Classification: Practice when the title names the step; the catch proves it. A rule-shaped
near-miss title files as mistake. Harm or reliance wins.
Example: "Probe the save" catches an error.
Status: current

### K5
Question: Accepted verdict overturned?
Classification: Mistake; a practice may have its own record.
Example: A clean scan justified a wrong handoff.
Status: current

### K6
Question: Imperative title, but harm?
Classification: Mistake; T1 outranks title shape.
Example: "Verify target": a wrong deployment.
Status: current

### K7
Question: Someone had to act again?
Classification: Mistake; repeated human effort is harm. Keep the rule separately.
Example: A missed constraint needs reapproval.
Status: current

### K8
Question: Worked once, no comparison?
Classification: Recipe; pick the nearest kind and cite K8 or state doubt in confidence. Flag for a how-to topic in 3.3.
Example: One setup, no comparison.
Status: current

### K9
Question: Several behaviours?
Classification: Observation; keep old rows, capture new behaviours separately.
Example: Three cache behaviours.
Status: current

### K10
Question: Case contradicts written kind?
Classification: Case wins; classify --write records kind_case.
Example: A near-miss step cites K4.
Status: current

Keep old cases; use `### Kn` headings. Add dated cases with `supersedes: K4, K5`
on its own line. List lessons: classify --case K4; relabel together.
