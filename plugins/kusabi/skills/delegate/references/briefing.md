# Brief authoring reference

Authoritative reference for drafting kusabi briefs, probe semantics, and authoring invariants.

## Attribution and metadata

- **Sign the brief.** A line among the first 5 — `Orchestrator: <model-id> | session <id> | <date>` — is parsed by the companion and recorded on the job/chain record. Without it, discard and rework rates cannot be attributed back to who wrote the brief.
- **Write in English.** Small worker models follow English instructions more reliably and spend fewer tokens doing it.
- **Consult past review records first.** Chains archive review records (verdicts, findings, adjudications) to the archive repository. Search there before drafting so recurring patterns follow established precedent.

## Brief structure

A proven skeleton that minimizes ambiguity:
`Deliverables / Smoke / Purpose / Workplace / Read first (in container) / Spec (numbered subsections, concrete paths) / Acceptance criteria / Frozen Tests / Non-goals / Constraints`.

Place machine-read sections (`Deliverables`, `Smoke`, `Frozen Tests`) first.

- **Inline the whole spec.** Never open with "read issue #N first." The brief is the contract; a pointer is not.
- **Paste verified facts; name unverified claims.** Give the worker bounded scope, verified facts, source paths, and criteria. Do not make workers re-derive established facts. Parallel workers should own independent work. Parent inspects evidence.

## Machine-read sections

### Deliverables
- **`## Deliverables` is machine-read, not decoration.** The deliverables probe parses this section; an empty change set causes a discard.
- List the files that must change. Producing notes or summary files is not deliverables (cheap workers otherwise treat "fetch and save issue" as completed work).
- Accepted syntax: unordered bullets (`-`, `*`, `+`), ordered items (`1.`, `1)`), indented bullets, or fenced code blocks (first whitespace/backtick token is taken as path).
- Trailing annotation on heading is permitted (word-boundary prefix match, case-sensitive), e.g. `## Deliverables (files that must change; notes are NOT deliverables)`.

### Smoke
- **Declare `## Smoke` when runtime behaviour is the point.** The smoke probe runs commands in the container and compares exit codes. A gate that only lints proves code parses, not that it runs.
- Keep smoke cheap, deterministic, and one command per line (exit 0 by default) — never comprehensive. Briefs with `## Smoke` averaged 1.25 rounds vs 2.40 without; winning smoke was single `node --check <file>` while losing brief spent 900 characters on prose criteria.
- Accepted syntax: bullets with backtick-quoted command and optional `exit <N>` annotation, or fenced code blocks. Trailing annotation on heading allowed.
- **Annotate `baseline-red` exactly when smoke targets a Deliverables file not yet existing** (e.g. `node --check ui/app.js` on greenfield frontend task). Licenses one baseline outcome: expected to fail before round (measured exit misses expectation), refuses if already passes. `exit <N>` and `baseline-red` compose. The machine only half-checks the claim, so check annotated lines carefully before writing.
- **Never bare `lint` / `type` in `## Smoke` without measuring pristine baseline first.** Two delegations failed smoke+verify on pre-existing lint debt; workers innocent, cost paid twice. Name target files and measure first:
  `git show HEAD:<f> | ruff check --stdin-filename <f> -`
  If not measured, do not write it — tests and imports usually suffice.
- **A failing smoke line must be reproduced manually before blaming the worker.** The probe shell has no `\xNN` escape (bash extension); POSIX `printf` takes octal only (e.g. `printf '\xef\xbb\xbf' > f` writes literal chars and fails correct implementation). Rejects correct work.

### Frozen Tests
- **If nothing is frozen, omit the `## Frozen Tests` heading — never write `(none)` under it.** A machine-read heading followed by prose parses to zero entries, failing P5 with "heading present but no entries parsed" every round. Dispatch refuses such briefs outright.
- If acceptance criteria state new concrete I/O (bug repro, parser case, API contract) and no existing test covers it, dispatch `test-author` pre-phase first to manufacture tests + `baseline-red` smoke. Omit heading when criteria are structural or judgment-based.

## Specification and contract discipline

- **Freeze outcomes, not architecture.** Acceptance criteria must describe observable results. Writing module layouts, function names, or signatures into criteria rejects correct work arriving by another route.
- **Group criteria and provide escape hatches in `## Non-goals`.** Move exclusions to `## Non-goals` with an explicit escape hatch: "do not do X; if you truly need to, say so explicitly". Bare prohibitions are silently worked around or produce distorted implementations.
- **Split mechanical work from design judgment into separate jobs.** One consequential decision buried in mechanical edits gets skimmed.
- **Quantitative criteria as invariants.** State guarantees as invariants ("never exceeds N"), not best-case scenarios ("under N when healthy").
- **Docs made false by change.** If design docs assert something made false by the change, add `## Docs to update at inspection` naming section. Worker does not touch it; orchestrator updates before publish.
- **Stop-and-report is instrumentation, not a halt.** Treat as instrumentation rather than assuming the worker stopped; check whether condition was hit at inspection.
- **Wiring into existing code (`## Suggested design`).** Provide a non-frozen starting point: which layer owns loop/retry, where state lives, and single decision function. If orchestrator cannot write from knowledge already in hand, dispatch `plan` pre-phase first and fold adopted design into brief; skip if already known.
- **Name the source to read, not the answer.** Enables reviewer to refute mistaken claims against the authoritative source.
- **Grep tests before freezing "all existing tests pass".** Verify existing tests do not pin behavior contradictory to the spec. When contradictions exist, fix the brief, not the test.
- **Writing "PUBLISH" in a brief does not publish.** Worker toolset has no publish exit; the orchestrator publishes only after acceptance. Briefs demanding publication stop at worker capability limits.
