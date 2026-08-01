---
name: metrics
description: Refresh the kusabi metrics store and report from it (ingest, then report). Use for "show me the metrics", "how is token efficiency", or an explicit /metrics request; pass any window arguments through.
---

# /metrics — ingest, then report

The "look now" command for the kusabi metrics store (`~/.kusabi/metrics.db`). It
refreshes the store before reporting, so the numbers are current at the moment you ask —
even on a machine that has no daily ingest timer, or whose timer has not fired yet.

**The specification is deliberately not restated here**: the report's design is owned by
`docs/DESIGN.md` §3.5.9 and the flag surface by `kusabi-companion.mjs --help`. Read
those, not this file, for what the report contains and which arguments exist.

## Procedure

Resolve the companion relative to this skill's base directory:
`<skill base>/../../scripts/kusabi-companion.mjs`.

1. Run `metrics-ingest` first. It is idempotent and skips unchanged source files, so it
   costs seconds.
2. Run `metrics-report`, passing the user's window/format arguments through verbatim.

## Reading discipline

- **Check the freshness header first.** Right after step 1 it must be current; if it is
  stale, the ingest failed — investigate before quoting any number. On a machine with a
  daily ingest timer, check that unit's status.
- **Brief metrics vs outcome is raw counts stratified by orch_model.** Do not construct
  rates, averages, or causal claims across strata — brief-author model, date, and kusabi
  maturity are completely confounded.
- **The orch column of Orchestrator vs worker is non-additive** (per the (xN)
  annotation, one session appears on several rows). Never sum it. With a window set, the
  banner notes the figures are partial sums within the window.
- `chain-stats` is a different tool (it reads raw chain files). Different question,
  different tool.
- **Stores are per-machine.** Each machine ingests its own transcripts and job records;
  there is no cross-machine aggregation, so a report describes this machine only.
