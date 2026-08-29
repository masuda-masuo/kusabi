# Review-quality evaluation suite

Adversarial review quality is judged by feel. This suite ships a **code grader**
over schema-valid review JSON and a small set of in-tree planted-bug tasks, so
review quality can be measured deterministically instead of by vibe.

## pass^k vs pass@k

**pass^k** (the headline metric) is "all k trials hit": every independent review
run against the same task must land a finding on the planted bug. One miss and
the whole headline fails — it is the strict, conservative measure. In the grader
this is `passK(trials)`, which returns `true` only when every trial's `hit` is
`true`.

**pass@k** is "at least one of k trials hit": a single successful catch is
enough to count the task as caught. It is the lenient, best-case measure, useful
for detecting whether a model *can* ever catch the bug. In the grader this is
`passAtK(trials)`, which returns `true` when any trial's `hit` is `true`.

A `trial` is a boolean (the `hit` field from `gradeReview`), or a
`gradeReview` result carrying `hit`.

## CI does not run live reviews

`npm test` (i.e. `node --test`) and CI grade **canned JSON only**. No LLM is
invoked, no review is dispatched, and no `--live` flag exists in v1. The grader
consumes an already-parsed findings array; it does not call a model or spawn a
review. Any future live loop would feed canned-or-real review outputs through
the same `gradeReview` / `passK` / `passAtK` functions and is intentionally out
of scope for this change.

## Task directory layout

Each task lives under `evals/review/tasks/<id>/` and contains exactly two files:

- `bug.js` — the buggy source with exactly one planted bug.
- `gold.json` — the grading target:

  ```json
  { "file": "bug.js", "line_start": 6, "line_end": 6, "kind": "null-deref" }
  ```

  - `file` is repo-relative (`bug.js`).
  - `line_start` / `line_end` is the inclusive line range covering the planted
    bug. Reversed ranges are normalized to `[min, max]` by the grader.
  - `kind` is **documentation** of the planted bug class; it is not required to
    match a reviewer's `finding.kind`. Scoring is location-only (file + line
    overlap).

Fixture files are named `bug.js` / `gold.json` (never `*.test.js` /
`*.test.mjs`) so `node --test` does not collect them.

## Using the grader

```js
import { isFindingHit, gradeReview, passK, passAtK } from
  "plugins/kusabi/scripts/review-eval.mjs";

gradeReview(findings, gold); // { hit, noise, total }
passK([true, true, true]);   // true  — every trial hit
passAtK([true, false]);      // true  — any trial hit
```

`isFindingHit(finding, gold)` is the only place that decides hit vs miss for a
single finding.

## Recommended live-trial count (future runner)

N = **5** is a recommended live-trial count for a future runner that replays a
task N times and reports pass^5 / pass@5. This change does **not** execute any
trials; N=5 is guidance for that future tooling, not something this suite runs.
