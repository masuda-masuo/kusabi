---
name: delegate
description: Delegate implementation to a kusabi worker and keep only briefing, inspection and publishing for yourself. Load this at the start of any implementation task, before writing code yourself.
---

# Delegating implementation to kusabi

**Do not start writing the code yourself.** The orchestrator's context is the scarce
resource; a worker's is not. Spawning same-family subagents for implementation spends
the expensive budget twice (measured: one such subagent burned 320k tokens on a task a
worker did for free). Your work is briefing, inspection, publishing, merge decisions.

Moving to a fresh session makes you reflexively start implementing. That reflex is the
signal to stop and delegate.

## Division of labor

| Who | Role |
|---|---|
| Orchestrator | brief authoring, container preparation, inspection (diff + full gate + real behaviour), publish, merge decision |
| kusabi worker | implementation, investigation, first-pass review |
| Human | direction, final acceptance |

## Dispatching

**This file deliberately does not restate the CLI surface** — subcommands, flags, phase
names, probes and dispositions change faster than any skill can track. Read the
authoritative source instead, once per session before the first dispatch:

- `kusabi-companion --help` — subcommands, flags, phase list. If the PATH shim is
  missing, `node <plugin>/scripts/kusabi-companion.mjs --help` is equivalent.
- `docs/design/phase-chain.md` §3.5 — chain rounds, deterministic probes, the disposition table

What does *not* change with the CLI:

- **Pass the brief as a file**, not inline — inline quoting is an accident generator.
- **Container preparation is the orchestrator's job.** Implement-phase workers are denied
  `sandbox_initialize` / `publish` / issue writes by design, so hand them a container id
  in the brief. (The chain companion injects the ID into implement and review prompts
  automatically; briefs may still repeat it — harmless.)
- **Re-run `install-agents` after merging any PR that touches an agent definition.**
  The installed copies are stale until you do; the worker will run the old rules.
- **The `investigate` phase writes its brief to the target issue by design** — that holds
  even under `--read-only`, because read-only constrains the repo, not the network exit.
  Decide that the issue should receive a public comment *before* dispatching.

## Model selection

The model resolves from config or the built-in chain; an explicit `--model` is the
exception, not the routine. Escalate to the stronger model when:

- the change is large or structural,
- the cheap worker previously passed the gate by weakening it (skips, loosened
  assertions, narrowed scope),
- the chain stalled on the same area twice.

Quota exhaustion is only one of the triggers. Reading it as the *only* trigger is how you
end up re-running a doomed cheap round three times.

## Writing the brief

- **Consult past review records for the target area first.** Chains archive their
  review record (verdicts, findings, how each finding was adjudicated and why) to the
  archive repository; search there before drafting so a recurring finding type is
  answered by precedent instead of re-adjudicated from scratch. Where the archive
  lives and how to search it is per-environment wiring, not this file.
- **Sign it.** A line among the first 5 — `Orchestrator: <model-id> | session <id> | <date>`
  — is parsed by the companion and recorded on the job/chain record. Without it, discard
  and rework rates cannot be attributed back to who wrote the brief.
- **A skeleton that has held up**: `Deliverables / Smoke / Purpose / Workplace /
  Read first (in the container) / Spec (numbered subsections, concrete file names) /
  Acceptance criteria / Frozen tests / Non-goals / Constraints`. The order matters less
  than the fact that the two machine-read sections come first.
- **`## Deliverables` is machine-read, not decoration.** The deliverables probe parses it
  and an empty change set becomes a discard. List the files that must change, and state
  that producing notes or summary files is not the task — cheap workers otherwise treat
  "fetch and save the issue" as completed work (real incident: a round returned a
  markdown copy of the issue body and claimed done). Accepted item syntaxes: unordered
  bullets (`-`, `*`, `+`), ordered items (`1.`, `1)`), indented bullets, and lines inside
  a fenced code block; the first backtick-quoted token (or first whitespace-delimited
  token) is taken as the path. The heading may carry a trailing annotation — e.g.
  `## Deliverables (files that must change; notes are NOT deliverables)` — and is
  still recognised (word-boundary prefix match, case-sensitive).
- **Declare `## Smoke` when runtime behaviour is the point.** The smoke probe runs those
  commands in the container and compares exit codes. A gate that only lints proves the
  code parses, not that it runs. Accepted item syntaxes: unordered bullets, ordered
  items, indented bullets, or a fenced code block (one command per line, exit 0);
  bullet entries require a backtick-quoted command with an optional `exit <N>`
  annotation. The heading may carry a trailing annotation — e.g. `## Smoke (run in
  container)` — and is still recognised.
- **Keep the smoke cheap, deterministic and one command per line — never comprehensive.**
  Across nine chains sharing one author, one day and one template, briefs carrying
  `## Smoke` averaged 1.25 rounds against 2.40 without it; the winning smoke was a single
  `node --check <file>` while the losing brief spent 900 characters on prose criteria.
  Acceptance criteria are read and judged by the reviewer — smoke is the only section the
  worker can run to close its own loop. (n=9, and a task that admits a one-line smoke may
  simply be an easier task: direction, not causation.)
- **Never put a bare `lint` / `type` command in `## Smoke` without measuring the baseline
  first.** Two delegations failed both their smoke and their verify probe on pre-existing
  lint debt in the target files; both workers were innocent, and the cost was paid twice —
  once sending good work back, once re-measuring the baseline at inspection. Name the
  target files and measure first (`git show HEAD:<f> | ruff check --stdin-filename <f> -`).
  If you have not measured, do not write it — tests and imports usually suffice.
- **A single failing smoke line is your line until you reproduce it by hand.** The probe
  shell has no `\xNN` escape — that is a bash extension, and POSIX `printf` takes octal
  only — so `printf '\xef\xbb\xbf' > f` writes those characters literally and fails a
  correct implementation. This is the inverse error to a worker's false green, and it is
  more expensive: it rejects work that was right.
- **Inline the whole spec. Never open with "read issue #N first."** The brief is the
  contract; a pointer is not.
- **Freeze outcomes, not architecture.** Acceptance criteria must describe observable
  results. Writing module layout, function names or signatures into them means rejecting
  correct work at inspection because it arrived by another route.
- **Group criteria rather than dropping them**, and move what does not fit into an
  explicit `## Non-goals` — silently omitted and deliberately excluded must stay
  distinguishable.
- **Split mechanical work from design judgment into separate jobs.** One consequential
  decision buried in a hundred mechanical edits gets skimmed by worker and reviewer alike.
- **Write quantitative criteria as invariants, not best-case statements.** "Under 2,000
  characters when every repository is healthy" broke exactly when every repository was
  unhealthy, returning the original 53,836 characters — the guarantee vanished in the
  situation that motivated the tool. Write "never exceeds N".
- **A `## Non-goals` entry needs an escape hatch**: "do not do X" plus "if you truly
  need to, say so explicitly". A real deviation then came back documented in source
  comments and could be adjudicated; a bare prohibition is either silently worked
  around or produces a distorted implementation.
- **A "stop and report" condition is not a stop.** A brief that said "if you hit the
  aggregate byte cap, stop and report rather than raising it yourself" was ignored at
  exactly that condition, and the chain still ended in `accept` with the full suite red.
  Write the condition anyway — it makes the deviation adjudicable — but treat it as
  instrumentation, not a halt: at inspection, check whether the condition was hit rather
  than assuming the worker stopped there.
- **When the task wires new code into existing code, add a `## Suggested design`
  block** — explicitly a starting point, not frozen criteria. At minimum: which layer
  owns the loop/retry, where the state lives, and which single function makes the
  decision. Without it, an entire round of findings was about where the wiring
  belonged. This does not contradict "Freeze outcomes, not architecture", which governs
  acceptance criteria.
- **Name the source to read, not the answer.** A brief that named the authoritative
  file let a reviewer refute the orchestrator's own mistaken claim from the real
  source; had the brief stated the answer, the worker would have copied it and the
  reviewer would have confirmed the copy.
- **Before declaring an existing behaviour wrong or legacy in a spec that also
  freezes "all existing tests pass unchanged", grep the existing tests for that
  behaviour.** The two criteria can silently demand opposite outputs for the same
  input, and no implementation can satisfy both. One grep at authoring time catches
  it; skipping it cost a full round on a worker's (correct) refusal — the redundancy
  is also the safety net, so when the contradiction fires, fix the brief, not the
  frozen test.
- **Paste facts you have already verified** rather than making the worker re-derive
  them — but the thing you name instead of state is the claim you have *not* verified.
  Both halves belong in one item. A worker made to re-derive confirmed facts once spent its
  whole context reading and finished with no edits at all.
- **Write the brief in English** even when the surrounding discussion is not. Small worker
  models follow English instructions more reliably and spend fewer tokens doing it.

## Inspection

Worker reports are claims, not evidence. They have been false before.

- **Start with `chain-show`**, not raw `rounds/*.json` or `events.ndjson`. Re-reading raw
  chain state into the orchestrator's context is the single largest avoidable cost here.
- **An escalate ending with that round's probes/smoke all green is a dead review seat
  only when the seat itself failed to finish — the round record shows findings but no
  verdict line, or the output is unreadable.** The deterministic checks passed on the
  work that exists, so the implementation is intact; buy a replacement review and do not
  send the worker that wrote the code a rework for that escalate reason. When the
  escalate instead came from a review that completed — the same file area flagged for
  two consecutive rounds, the work discarded, unverified items still open, or the round
  limit reached — its findings stand: use the four routes below, or the stall lever
  (stronger model / strategize) for a repeated area, rather than a replacement review.
  If the probes were not all green this bullet does not apply, and the four routes below
  decide the round as usual.
- **The dispute over a green gate is scope, not repetition.** Re-running the same command
  in the same container proves nothing you did not already know. Ask what the worker's
  verify did *not* cover — a "full suite" has turned out to be twenty-odd single-file runs
  — and run the true full gate yourself.
- **Whatever a check replaced is unverified.** Mocks, stubs, fake containers and skipped
  toolchains all move a boundary; enumerate what was substituted and confirm those
  boundaries some other way. This matters most for changes to the verification machinery
  itself: run the changed gate end to end, including its failure cases.
- **Look for sabotage of the criteria**, not just for bugs: deleted or weakened tests,
  loosened assertions, new skip markers, broadened exception handling.
- **Do not make verification an acceptance criterion for the worker.** Delegating the
  check gets you a report about the check. Verification is the orchestrator's.
- **Reviewer findings skew toward environment-premise errors** ("this exists in base, so
  it is scope creep"). Refute the cheap ones with probe output, `git log` or a direct call
  before ordering a rework.
- **Triage comes first.** Reject the findings that deserve rejection before treating the
  rest as work you own (one orchestrator rejected 5% of findings while another rejected
  17% — a pattern as costly as a wrong fix).
- **When a finding survives triage, choose the cheapest correct route:**
  1. **Send it back** (first choice) — the same worker still holds the context, so this
     is the cheapest correct route.
  2. **Delegate a new job** — when sending back is impossible (session gone, scope
     changed). An adjudicated finding list with `file:line` is already almost a brief.
  3. **File a follow-up and ship** — when the remaining defect's real-world harm amounts
     to "does not match the wording of an acceptance criterion".
  4. **Write it yourself — the exception** — only when the diff is smaller than the
     brief would be (a typo, a one-word rename). Never for decision logic, parsers or
     branch conditions, no matter how small. The one clean case is a finding caused by
     an error in the brief: the brief's owner fixes the brief.
- **Collected count is part of green.** Tests in a module that fails to import do not
  fail — they stop existing. Compare the collected count against a known baseline (a
  real incident hid 273 of 607 tests, displaying as "333 passed / 1 failed").
- **"Pre-existing failure" claims are verified on a pristine base**, in a fresh
  container (one such claim concealed a 27-test regression caused by a patch-path
  namespace shift).
- **Branches excluded by cfg / feature gates / another platform must be built for that
  target.** Code behind a disabled cfg is neither type-checked nor linked, so "it
  compiled on Linux" says nothing about the Windows arm — a worker once reported having
  "syntax-compiled" a Windows-only implementation on Linux, where the cfg gate had excluded
  it from type-checking and linking entirely.
- **Never restore a mutation with `git checkout`.** Worker output is uncommitted
  worktree state, so checkout deletes the implementation along with the mutation;
  record a checksum before mutating and restore from a snapshot. Doing it once destroyed a
  worker's entire uncommitted implementation in the middle of a mutation check.
- **A `NOT CAUGHT` mutation is your mutation's problem until proven otherwise.** When
  the default value equals the boundary being moved, the mutation is equivalent and no
  test can observe it — adding a test is not possible and not the answer. Two mutations once
  reported NOT CAUGHT and both were equivalent (default `0` against `minimum=0`); re-testing
  the same guarantee on a setting whose default was not the boundary showed it intact.
- **Machine dispositions decide rounds, not outward actions.** `accept-with-followup`
  drafts a follow-up; filing it is yours. `strategize` buys one diagnosis job, not a
  reprieve from deciding. Never conclude on a followup while a critical or high finding is
  open, and treat a wrong premise as a brief to rewrite, not a finding to defer.
- **Close the loop on the review record.** A chain that reaches a terminal disposition
  prints the path of its generated `review-record.md` (see
  `docs/design/phase-chain.md`). After inspection, fill its two fill-at-inspection
  sections — per-finding adjudication with reasons, and any reusable precedent — and
  post it to the archive repository. Posting is orchestrator-exclusive, by the same
  exit principle as publish; an unposted record is write-only state the next brief
  cannot learn from.
- **Move your work queue in the same turn that a chain terminates or a merge is
  confirmed.** A session's end cannot be relied on to do it — the sessions that need
  closing hygiene most (freezes, context exhaustion, kills) never get it, and a queue
  frozen at "chain running" makes the next session rebuild state from issue/PR lists.
  The terminal digest and the merge confirmation each arrive as a turn; the one-line
  queue update belongs in that turn, not at the end.

## Publish

Publish is the orchestrator's exclusive network exit and is never granted to a worker;
credentials stay host-side and never enter the container. Declare an explicit file
manifest taken from the worker's reported change set — anything undeclared must not be
staged, and a bulk "add everything" is how a worker's scratch files reach the remote.

**Writing "PUBLISH" into a brief does not make it happen.** The worker's toolset has no
publish, so a chain brief that demands it is executed as far as the worker can take it and
then stops — publish happens here, after acceptance, never inside the chain. The chain
prints a one-line warning when the brief looks publish-demanding; treat that warning as a
to-do for yourself, not as a worker failure.
