# Independent lesson labelling

Give each of two labellers the whole installed LESSON-KINDS.md and the same lesson
files. Give blind labellers copies with `kind:` and `kind_case:` removed; K0 step 1
does not apply in a blind run. Neither sees the other's labels, prior labels or a person's answers.
Read each title and body; apply K0 and T1-T4, citing K1-K10 when a case decides.
The kind test is the two labellers' agreement: at most 6 of 40 disagreements,
scaled down with floor(rows * 6 / 40). Require both to label every row.
Person-set labels are hand-set takeaways, not a kind reference.
Keep private examples, row lists and the hold-out key in the host's evidence.
Do not manufacture person-set labels. Label every row independently and score the pair.

Each labeller returns JSON outside memory:

```json
{"version":1,"kinds":{"lesson-001-example.md":"practice"},"cases":{"lesson-001-example.md":"K4"},"confidence":{"lesson-001-example.md":0.9}}
```

`cases` and `confidence` are optional maps keyed by the same filenames as `kinds`.
Label every row; doubt goes in `confidence`, a number from 0 to 1. For K8, pick
the nearest kind and cite K8 or state doubt; flag it for a how-to topic in 3.3.
Scoring accepts string citations such as K0-2; writing requires installed case ids.
For historical scoring, an optional historical `--reference` file, such as a hold-out key, may list
`unscored` rows; labellers still label every row. Use `"unscored":["lesson-001-example.md"]`
to skip those rows only in reference scores. Missing predictions count as wrong on scored reference rows.

```sh
node scripts/memory/memory-lesson.mjs classify --score A.json B.json
node scripts/memory/memory-lesson.mjs classify --score A.json B.json --json
```

Without a reference the report shows the union of A's and B's rows, disagreements,
rate and each file's class counts; a row only in A or only in B is a disagreement.
It prints `disagreements <= N/M` and `kind test: PASS` or `kind test: FAIL`. The kind
test fails for empty or unequal row sets or more than floor(rows * 6 / 40) disagreements.
JSON includes `kindTest: {allowed, disagreements, pass}`. This verdict also appears
with optional historical reference scoring via `--reference reference.json`;
it also prints `historical mark:` and each score with `historical PASS` or `historical FAIL`.
JSON keeps the existing mark and per-labeller verdict keys, adding `historical: true`
to `mark`, `A` and `B`. Historical thresholds are:
84% of reference rows (21/25), 70% of practice/observation rows (7/10), and no more
than 15% union-row disagreements (6/40). Required successes round up; allowed
disagreements round down. Incomplete A/B row sets, empty reference, no compared rows, or no scored
practice/observation rows cannot PASS. The
constant-mistake baseline appears beside the mark. A report exits 0 even for FAIL;
bad input exits 1. This historical reference report is not the kind acceptance test and does not
itself authorize a relabel.

Settle an obvious disagreement by citing a case. When uncertainty is too great
and no similar case exists, put the row, competing readings and missing evidence
in a decision table for human review. Do not use a third model as a silent tie-breaker.
6 of 40 (15%) passes the kind test; above 10%, each disagreement still needs a
case id before writing. Target at most 5%. The single-map write command
cannot verify that independent review happened. Save the score with the run.

After review, put settled kinds and their `cases` in one classify file. Include a
case for every disagreement or non-default classification, including mistakes under K3,
K5, K6 and K7. Preview `classify settled.json`, then `classify settled.json --write`.
An omitted case preserves the existing metadata.kind_case. No case is mandatory
for an ordinary capture. Capture one with `new --case K4` or a batch `case: K4`.

Cases are immutable. Propose a new dated case with `supersedes: Kn` when the rule
changes, ship it with the kit, list lessons using `classify --case Kn`, and relabel
in one reviewed change. `kind.case-superseded` WARNs until those lessons are updated.

People may include an optional `takeaways` map keyed by the same filenames as
`kinds`, with values `fix`, `method` or `know`. `classify --write` writes it to
`metadata.takeaway`; omission preserves existing values. Preview and write summaries
report `; takeaways N`, counting values they would set or change. Models never set `takeaway` by default. Keep takeaways out of blind labeller copies as well.
