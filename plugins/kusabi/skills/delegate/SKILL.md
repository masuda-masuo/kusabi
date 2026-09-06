---
name: delegate
description: Delegate implementation to a kusabi worker and keep only briefing, inspection and publishing for yourself. Load this at the start of any implementation task, before writing code yourself.
---

# Delegating implementation to kusabi

**Do not write code yourself.** Orchestrator context is scarce; worker context is not. Spawning subagents spends the expensive budget twice. Your work: briefing, inspection, publishing, merge decisions.

Moving to a fresh session triggers the implementation reflex — that reflex is the signal to stop and delegate.

## Division of labor

| Who | Role |
|---|---|
| Orchestrator | brief authoring, container prep, inspection (diff + full gate + real behaviour), publish, merge decision |
| kusabi worker | implementation, investigation, first-pass review |
| Human | direction, final acceptance |

## Dispatching

**This file does not restate CLI surface** — subcommands, flags, phases, probes, dispositions change faster than skills track. Read authoritative source once per session before first dispatch: `kusabi-companion --help` (or `node <plugin>/scripts/kusabi-companion.mjs --help`) and `docs/design/phase-chain.md` §3.5.

What does not change:

- **Pass brief as file**, not inline — inline quoting = accident generator.
- **Use wait command from `chain-detach`** for launched chain; `chain-wait` with explicit id for existing/resumed. Nonzero exit = diagnose, not re-dispatch.
- **Container prep = orchestrator job.** Implement workers denied `sandbox_initialize`/`publish`/issue writes. Hand them container id in brief (companion injects automatically).
- **Re-run `install-agents` after merging PR touching agent definitions.** Installed copies stale until then; worker runs old rules.
- **`investigate` phase writes brief to target issue by design** — holds under `--read-only` (constrains repo, not network exit).

## Two operating loops (test-first and plan-first)

Two phases exist only as `task --phase` invocations — chain never dispatches them (kusabi #408 / #409). Both take draft brief, return derived artifact folded into next brief.

- **test-first**: dispatch test-author with draft brief → inspect tests → list paths under `## Frozen Tests` + `baseline-red` smoke → dispatch implement chain in same container.
- **plan-first**: dispatch plan with draft brief → inspect plan → paste adopted parts into `## Suggested design` → dispatch chain.

Neither loop changes worker contract: test-author writes only tests, plan writes nothing. Cheap pre-implementation gates. Record in review record whether pre-phase used/skipped.

## Model selection

Model resolves from config or built-in chain; explicit `--model` = exception. Escalate to stronger model when:

- change is large or structural
- cheap worker previously passed gate by weakening it (skips, loosened assertions, narrowed scope)
- chain stalled on same area twice

## Brief authoring

Detailed reference, probe mechanics, and incident background: see [references/briefing.md](references/briefing.md).

- **Sign it**: First 5 lines must include `Orchestrator: <model-id> | session <id> | <date>` for attribution (companion parses; discard/rework rates unattributable without it).
- **Skeleton**: `Deliverables / Smoke / Purpose / Workplace / Read first / Spec / Acceptance criteria / Frozen Tests / Non-goals / Constraints` (machine-read first).
- **`## Deliverables` is machine-read**: Empty change set = discard. List files that must change; notes/summaries are NOT deliverables. Accepted: bullets, numbered, indented, code block (first token = path).
- **`## Smoke` declares runtime behaviour**: Cheap, deterministic, 1 command/line (`exit 0`). Bullets with backtick command + optional `exit <N>`, or code block.
- **`baseline-red`**: Annotate only when targeting non-existing Deliverables file (licenses failure before round; refuses if already passing).
- **Never bare `lint`/`type` in `## Smoke` without measuring pristine baseline first**: Measure first: `git show HEAD:<f> | ruff check --stdin-filename <f> -`. If unmeasured, omit — tests/imports usually suffice.
- **Failing smoke line must be reproduced manually before blaming worker**: Probe shell has no `\xNN` escape (bash extension); POSIX shell `printf` does not support `\xNN` and uses octal (`printf '\xef\xbb\xbf' > f` writes literal chars and fails correct impl).
- **`## Frozen Tests`**: Omit heading if empty (never write `(none)`). Dispatch `test-author` first if criteria state new concrete I/O.
- **Contract discipline**: Inline whole spec; freeze outcomes, not architecture. Non-goals require escape hatch ("do not X; if truly needed, say so explicitly").
- **Wiring into existing code**: Add `## Suggested design` block (starting point). Dispatch `plan` pre-phase if unfamiliar.
- **Grep tests before freezing "all tests pass"**: Catch contradictory criteria before dispatch.
- **Write brief in English**: Small models follow English instructions more reliably.

## Inspection

Worker reports are claims, not evidence. They have been false before.

- **Start with `chain-show`**, not raw `rounds/*.json` or `events.ndjson`. Re-reading raw chain state into orchestrator context is largest avoidable cost.
- **Escalate with all probes/smoke green** = dead review seat only when seat failed to finish (findings but no verdict line, or unreadable output). Deterministic checks passed on existing work, so implementation intact; buy replacement review, do not send worker rework. When escalate came from completed review (repeated area across 2 rounds, discarded work, unverified items, round limit), findings stand: use four routes below, or stall lever (stronger model/strategize).
- **Dispute over green gate is scope, not repetition.** Re-running same command proves nothing. Ask what worker's verify did *not* cover (e.g. single-file vs full suite) and run true full gate yourself.
- **Whatever a check replaced is unverified.** Mocks, stubs, fake containers, skipped toolchains move boundaries; enumerate substitutions and confirm other way (run changed gates end-to-end including failures).
- **Look for sabotage of criteria**, not just bugs: deleted/weakened tests, loosened assertions, new skip markers, broadened exception handling.
- **Do not make verification an acceptance criterion for worker.** Delegating check gets report about check; verification belongs to orchestrator.
- **Reviewer findings skew toward environment-premise errors** ("this exists in base, so scope creep"). Refute cheap ones with probe output, `git log`, or direct call before ordering rework.
- **Triage first.** Reject findings that deserve rejection before treating rest as work you own.
- **When finding survives triage, choose cheapest correct route:** (1) **Send it back** (first choice): same worker holds context, cheapest route. (2) **Delegate new job**: when sending back impossible (session gone, scope changed); adjudicated findings with `file:line` ≈ brief. (3) **File follow-up and ship**: when defect's real harm is only "does not match wording of acceptance criterion". (4) **Write it yourself (the exception)**: only when diff smaller than brief (typo, one-word rename); never for decision logic, parsers, branch conditions. Clean case: brief error fixed by brief owner.
- **Collected count is part of green.** Tests in module that fails to import do not fail — they stop existing. Compare collected count against known baseline (real incident hid 273 of 607 tests, displaying "333 passed / 1 failed").
- **"Pre-existing failure" claims verified on pristine base**, in fresh container (avoids concealing regressions).
- **Branches excluded by cfg/platform must be built for that target.** Code behind disabled cfg is neither type-checked nor linked.
- **Never restore mutation with `git checkout`.** Worker output is uncommitted worktree state; checkout deletes implementation with mutation. Record checksum before mutating, restore from snapshot.
- **`NOT CAUGHT` mutation = your mutation's problem until proven otherwise.** When default value equals boundary moved, mutation is equivalent and unobservable — adding test is not the answer.
- **Machine dispositions decide rounds, not outward actions.** `accept-with-followup` drafts follow-up; filing it is yours. `strategize` buys one diagnosis job, not reprieve from deciding. Never conclude on followup while critical/high finding open; treat wrong premise as brief to rewrite, not finding to defer.
- **Close loop on review record.** Chain reaching terminal disposition prints `review-record.md` path (`docs/design/phase-chain.md`). Fill two fill-at-inspection sections (adjudication + precedent) and post to archive repo (orchestrator-exclusive, same exit principle as publish; unposted record = write-only state).
- **Terminal notification is automatic.** Every terminal chain writes inbox file at `{stateDir}/inbox/{chainId}.md` and best-effort appends kaiba agenda row (opt-out: `KUSABI_CHAIN_NOTIFY=0`). Durable completion signal without session-bound `chain-wait`.
- **Move work queue in same turn that chain terminates or merge confirmed.** Terminal digest and merge confirmation each arrive as a turn; one-line queue update belongs in that turn to prevent stale state.

## Publish

Publish is orchestrator's exclusive network exit; never granted to worker; credentials stay host-side, never enter container. Declare explicit file manifest from worker's reported change set — anything undeclared must not be staged; bulk "add everything" = how worker's scratch files reach remote.

**Writing "PUBLISH" in a brief does not publish.** Worker toolset has no publish exit; chain brief demanding it executes as far as worker can go and stops — publish happens here, after acceptance, never inside chain. Chain prints one-line warning when brief looks publish-demanding; treat warning as signal to inspect, not as delegation.
