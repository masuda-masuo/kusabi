# Brief authoring reference

Authoritative reference for drafting kusabi briefs, probe semantics, and authoring invariants.

## Motivation (measured 2026-09-13, latest ingest 2026-09-12T15:00:54Z)

Brief completeness correlates with chain outcomes — the length gap is diagnostic correlation, not causation and not a minimum-length target. Confounders include model, task difficulty, and kusabi maturity.

- `gpt-5`: 17 chains; median brief 2,836 characters; min 1,421; max 5,369; average 1.00 rounds; 10/17 escalated (58.8%; 8 substantive, 2 no-work).
- `codex/gpt-5`: 3 chains; median brief 2,675 characters; average 1.00 rounds; 2/3 escalated — n=3 is too small to lean on.
- `claude-opus-5`: 30 chains; median brief 6,369 characters; average 1.50 rounds; 6/30 escalated (20.0%).
- `claude-opus-5[1m]`: 119 chains; median brief 7,077 characters; average 1.25 rounds; 32/119 escalated (26.9%).
- Across all models: 64/145 escalation rounds had all deterministic probes green; 43/530 review rounds matched review pathology (8.1%).

Favour decision-relevant information density and autonomous closure over length — never pad a brief to reach a size. These numbers are dated: re-measure rather than quote them forever.

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
- **Every Smoke line states the criterion or boundary it proves, the expected exit/result, and whether it was measured on pristine HEAD.** Reasons may be nearby prose (a prose line or a backtick-less bullet — parseSmoke skips both) or trailing prose, so long as parser syntax holds. Trailing prose on a command line must contain neither extra backticks nor a bare `exit N` token: the first backtick pair is the command (an extra backtick triggers the lossy-command refusal), and the first bare `exit <N>` after the closing backtick becomes the expected-exit annotation — expected exit belongs only in the `exit <N>` annotation.
- **When behaviour is the point, include at least one end-to-end behavioural/contract boundary probe** that exercises the changed behaviour (wrong input, edge case, exit-code contract). A broad suite alone is insufficient.

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

## Pre-dispatch completeness gate

Run before dispatch, reading the brief as the worker will. Headings and generic prose do not satisfy the gate: every applicable category must be concrete, and inapplicable categories are omitted or explained — never padded.

- **Exact in-container source paths.** Name the files the worker must read or change (e.g. `plugins/kusabi/scripts/chain-review.mjs`), not "the relevant code" or a directory.
- **Verified context with assumptions named.** Paste verified facts; label what is assumed or unverified so the worker neither re-derives established facts nor treats guesses as facts.
- **Observable acceptance criteria, including relevant failure/boundary behaviour.** Criteria state outputs, exit codes, error messages, and the boundary inputs that matter (wrong input, edge case, contract breach) — not just the happy path.
- **Explicit Non-goals and restated constraints.** Exclusions live in `## Non-goals` with an escape hatch ("do not X; if truly needed, say so explicitly"); constraints are restated in the brief, not implied.
- **Deterministic Smoke that exercises the changed behaviour.** Smoke runs what changed and each line states the criterion or boundary it proves. A broad suite alone (e.g. "all tests pass") does not prove the change.
