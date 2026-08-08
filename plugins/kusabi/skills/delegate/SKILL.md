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
| Orchestrator (Claude Code) | brief authoring, container preparation, inspection (diff + full gate + real behaviour), publish, merge decision |
| kusabi worker | implementation, investigation, first-pass review |
| Human | direction, final acceptance |

## Dispatching

**This file deliberately does not restate the CLI surface** — subcommands, flags, phase
names, probes and dispositions change faster than any skill can track. Read the
authoritative source instead, once per session before the first dispatch:

- `node <plugin>/scripts/kusabi-companion.mjs --help` — subcommands, flags, phase list
- `docs/DESIGN.md` §3.5 — chain rounds, deterministic probes, the disposition table

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
- **Write the brief in English** even when the surrounding discussion is not. Small worker
  models follow English instructions more reliably and spend fewer tokens doing it.

## Inspection

Worker reports are claims, not evidence. They have been false before.

- **Start with `chain-show`**, not raw `rounds/*.json` or `events.ndjson`. Re-reading raw
  chain state into the orchestrator's context is the single largest avoidable cost here.
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
  before ordering a rework, and fix genuine minor findings yourself instead of paying for
  another round.
- **Machine dispositions decide rounds, not outward actions.** `accept-with-followup`
  drafts a follow-up; filing it is yours. `strategize` buys one diagnosis job, not a
  reprieve from deciding. Never conclude on a followup while a critical or high finding is
  open, and treat a wrong premise as a brief to rewrite, not a finding to defer.
- **Close the loop on the review record.** A chain that reaches a terminal disposition
  prints the path of its generated `review-record.md` (see DESIGN.md). After inspection,
  fill its two fill-at-inspection sections — per-finding adjudication with reasons, and
  any reusable precedent — and post it to the archive repository. Posting is
  orchestrator-exclusive, by the same exit principle as publish; an unposted record is
  write-only state the next brief cannot learn from.

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
