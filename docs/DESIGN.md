# kusabi Design Document

Last updated: 2026-07-26
Status: Design finalized + field-verified up to the phase chain, auto-chain (chain subcommand + sunaba-rpc) **implemented / reflected in main**. Decision 5 (accept-with-followup, §9.2) **implemented**. Decision 4 (strategist, §9.1) **implemented**. Fail-fast retry detection, tiered chain entries, and capacity fallback (issue #50) **implemented**. chain-stats (issue #124) **implemented**. Stages C/D are planned (see #36).

## 1. Purpose and positioning

A plugin for using opencode (anomalyco/opencode) as a delegatable worker from Claude Code.
Establishes a division of labor where Claude Code serves as the **orchestrator** (planning, inspection/acceptance by the orchestrator, publish decisions) while opencode + deepseek serves as the **worker** (investigation, implementation, review).

The motivation is cost structure: deepseek v4 Flash is cheap (zen's free-tier deepseek-v4-flash-free is also available) and empirically does better work than Haiku. This creates a structure where investigation and first-pass implementation run at essentially no cost, and only finishing work pays a small amount to Pro.

Derived from: openai/codex-plugin-cc (Apache-2.0). Prompt assets (adversarial-review.md / review-output.schema.json) are transplanted with NOTICE attribution.

## 2. Architecture

```
Claude Code (orchestrator)
  └─ /kusabi:task etc. commands → dedicated transfer subagent (agents/opencode-worker.md)
       └─ scripts/kusabi-companion.mjs (context firewall)
            └─ opencode serve (HTTP API, 127.0.0.1 + OPENCODE_SERVER_PASSWORD, on-demand start)
                 └─ deepseek worker
                      └─ MCP: sunaba / shiori (configured in opencode.json on the opencode side)
                           └─ sunaba container (merges into existing container via sandbox_attach)
```

### Adopted and rejected approaches

- **Adopted: HTTP server approach**. Direct `opencode run` was rejected — intermediate text pollutes stdout across all turns, tool logs flow to stderr, contaminating Claude's context.
- **Companion script as context firewall**: SSE `/event` subscription, automatic replies to permission.asked, events saved to state dir (`~/.kusabi/<hash(cwd)>/jobs/`), stdout receives only the formatted final result.
- **Dedicated transfer subagent**: Reducing the orchestrator's cognitive load is the top priority. Its job is only to execute the companion command and relay stdout verbatim.
- opencode API uses the v1 surface (`/session/...`, `/event`, `/permission/:id/reply`). Because v1→v2 migration is in progress, pin the SDK when using it.

### Execution environment prerequisites

- Development style without a local git repository. All work happens inside the sunaba container; the worker receives a `container_id` and merges in via `sandbox_attach`. opencode itself stays on the host side.
- Aligned with sunaba's design tenets (sunaba#478): **sessions are disposable, state is external** (agreement = issue/PR, artifact = container, audit trail = journal).

## 3. Phase chain (core of this design)

Long sessions cause context pollution, so work is split into phases, with **each phase = a new opencode session**. Cross-phase session reuse is prohibited (`--resume-last` / `--session` are for follow-ups within the same phase only).

### 3.1 Phase and tool matrix

| Phase | Role | shiori | Code write | issue_write |
|---|---|---|---|---|
| Draft | Duplicate check (horizontal) + issue creation | ○ | ✕ | ○ (artifact) |
| investigate | Deep issue dive, root cause identification | ○ | ✕ | ○ (brief appendix) |
| implement | Implementation + verify based on brief | ✕ | ○ | ✕ |
| review | Adversarial review of PR | ○ | ✕ | ✕ |
| respond | Address review findings | ✕ | ○ | ✕ |
| gofer | Evidence-gathering errands (#64) — run, observe, quote verbatim; no judgments, no issue writes | ✕ | ✕ | ✕ |

The gofer phase (`kusabi-gofer`, added in #64) is a cheap evidence-collector: it runs commands via `sunaba_sandbox_exec`, reads files/logs, and reports verbatim excerpts with provenance. Unlike investigate, gofer never posts to issues and never forms judgments — its contract is raw evidence returned in the final report. Write tools, host bash, and shiori are denied; `sunaba_sandbox_exec`, verify/lint/type tools, and sunaba read tools are explicitly allowed. The chain does not use gofer; it is for `task --phase gofer` invocations.

Design principles:

- **Use shiori vertically and horizontally**. Investigation of "vertical" issues pointing to a specific location can be done with in-container grep (measured: shiori#210 completed without shiori). shiori is effective for "horizontal" = cross-cutting pattern checks, duplicate issue confirmation, and cross-referencing issues → PRs → files. Therefore, prompts do not force a particular tool; instead, they present the option: "shiori is available for cross-cutting investigation."
- **shiori is intentionally withheld from implement / respond**. This is a structural enforcement to make the worker trust the brief and focus on implementation, while also reducing tool selection overhead and tool-choice context for smaller models.
- **More tools only confuse the model**. Give each phase the bare minimum it needs.

### 3.2 Brief (handover between phases)

**Uses `sunaba_issue_write` to the GitHub issue as the medium.** No copy-pasting.

- Consistent with sunaba#478's principle that "agreement lives in the issue/PR"
- shiori indexes it, so investigation results become permanently searchable knowledge
- Unlike in-container files, it spans multiple development environments (VM / home machine)

### 3.3 Phase = opencode agent definition

Phases are implemented as agent definitions in opencode.json. The deny list + default model + system prompt are bundled into the agent; the companion's `--phase <name>` is mapped to `--agent`.

Note (field-tested on 1.17.x → improved in 1.18.3): Both the session `tools` setting and the agent's permission settings are **converted to denial rules at execution time**. On 1.17.x, denied tools were still listed in the tool list sent to the model, but **with the 1.18.3 `resolveTools` fix, full `deny` physically excludes them** (confirmed via live A/B testing on 2026-07-17, issue #3). In other words, `--deny` serves simultaneously as an execution guard and context-size reduction.

The true phase-level load implementation path is:

1. Upstream fix (proposal to exclude denied tools from the request → tracked in issue #8)
2. Profile-specific MCP endpoints on the sunaba / shiori side (e.g. `/mcp/investigate` exposes only read + issue_write)

Whichever path is taken, agent definitions remain the receiving end unchanged.

### 3.4 Retry on failure

**Same brief + new session on the existing worktree (or model upgrade).**
Structurally prevents anchoring to a failed approach. Measured: Flash, stuck in a rut for 343s, produced a first-pass implementation. With a brief-attached new session, Pro polished it in 173s.

The anchoring break now happens through a fresh session on the existing worktree — the
chain never rolls the worktree back via `checkpoint_restore`. Artifacts from prior
rounds are always carried forward.

### 3.5 Auto-chain (chain subcommand) — implemented

Launched with `chain --container <cid> --model <m> [--max-rounds N] "<brief>"`. Implementation is `cmdChain` in `plugins/kusabi/scripts/kusabi-companion.mjs`.

#### 3.5.1 Round structure

Each round r (1..maxRounds, default 3) flows as follows:

1. **implement**: implement with the `kusabi-implement` agent. r=1 gets the full brief; r≥2 gets only the previous round's findings + the brief's acceptance criteria. The previous session's trial-and-error log is not carried over.
   - Every dispatch in the chain (implement, review, strategist) goes through `dispatchWithFallback`. When a dispatch ends as `provider-error`, the companion re-dispatches on the next unused route of the same tier — same round, same container, same brief. Routes that fail with a capacity reason are remembered for the rest of the process. Fallbacks do not consume rounds.
2. **Deterministic probes** (§3.5.2): non-LLM checks inside the container via sunaba-rpc.
3. **review**: adversarial review with the `kusabi-review` agent. Carries over previous round findings via `--prior`. The reviewer does not climb the round ladder: it stays on `--model` when given, otherwise on tier 0, for every round — the same route the pre-fallback implementation used. When those routes are dead it falls through to later tiers via the same `dispatchWithFallback` mechanism. Note that tier 0 is the *cheapest* tier, not the strongest; raising the reviewer's model is done with `--model`.
4. **Derive disposition** (§3.5.4): mechanically determine the disposition.

#### 3.5.2 Deterministic probes (P1–P4, non-LLM)

Direct container inspection via sunaba-rpc (§3.6). Does not involve the LLM:

| Probe | Content | Behavior on failure |
|---|---|---|
| **P1: HEAD clean** | Record baseSha via `git rev-parse HEAD` at chain start. After implement, if HEAD≠base, auto-execute `git reset --mixed <base>` | Auto-fix (empirical: even when the brief explicitly prohibited it, it happened 2 out of 3 times). Record in metadata |
| **P2: verify gate** | Run `verify_in_container` (no skip flags at all) | If gate_passed=false, skip review, turn results into findings, and rework (consumes a round) |
| **P3: deliverables** | Parse `## Deliverables` section from the brief; check that at least one declared path appears in the paths the *current round* actually changed (content-sensitive baseline comparison, not `git status --porcelain`). See "Worktree baseline" below. | Empty change set **and** a non-empty `## Deliverables` section (both conditions required by `shouldSkipReview` in `chain-phases.mjs`) → review job NOT dispatched, round verdict set to `discard` with `verdictSource: "probe"` (follows the existing discard→escalate path). When no `## Deliverables` section is declared, an empty change set still goes to review — with nothing declared there is no mechanical basis for calling an empty change set a failure, so the reviewer decides. Deliverables declared but no match → P3 fails but review still runs; `deriveDisposition` handles the rest. No `## Deliverables` section → probe trivially passes. **Heading present but zero entries parsed → P3 fails** (author is told to fix brief syntax rather than believing the check ran). |
| **P4: smoke** | Parse `## Smoke` section from the brief (accepted syntaxes: unordered/ordered bullets with backtick-quoted command + optional `exit <N>` annotation, or fenced code block with one command per line/exit 0). Each declared command is executed inside the container via `sandbox_exec`; the command's stdout/stderr is redirected to a file so that the exit-code marker (`; echo SMOKE_EXIT=$?`) is the only text returned by `sandbox_exec` and is never subject to pagination truncation. The captured output file is available for diagnostic excerpts on failure (timeout: 300s). | Any entry whose observed exit code does not match the declared expected exit (or times out / cannot be executed) → P4 fails. An exit code that cannot be observed (marker absent from `sandbox_exec` return text) is reported distinctly from a command mismatch — the probe still fails but the wording says "could not be observed" rather than "observed exit unknown". A timeout arrives as data (`status: "timeout"`, `exit_code: 124`) rather than as a raised error, and is detected as such: a timeout is an outcome of the command, so it must not be reported as the probe failing to observe. No `## Smoke` section → probe trivially passes. **Heading present but zero entries parsed → P4 fails** (author is told to fix brief syntax rather than believing the check ran). |

The same probes (P1–P4) also run for single `task --container <cid>` invocations, storing results on the job record and appending a probe summary to the task output.

##### Worktree baseline

A chain started on a dirty worktree (for example, on the second round of a
multi-round chain) must not pass the deliverables probe on the strength of
dirt that predates it.  To distinguish "this round changed something" from
"the tree was already dirty" the chain records a content-sensitive baseline
at chain start and measures each round against it.

**Recording.**  At chain start (`captureBaseSha`), `captureWorktreeState` in
`worktree-baseline.mjs` creates a temporary Git index (`GIT_INDEX_FILE`
pointing at a scratch file) and runs `git write-tree` to produce a tree hash
that covers the entire worktree — tracked files, modified tracked files, and
untracked files alike.  The real index is never touched.  The manifest
(`treeHash` + per-file content SHA map) is the baseline.  Retrieval is
**verified-complete or null**: the listing is fetched with `verbose: "full"`
and an explicit large page window on the `sandbox_exec` call, the shell
command prints a `COUNT=<n>` marker on the same pipeline data as the entries,
and the capture is accepted only when the parsed entry count equals `COUNT`
and the response carries no truncation sign (`truncated`/`has_more`).
`verbose: "full"` is required, not optional: sunaba's sandbox_exec applies
summary truncation (head-50/tail-50 at `max_lines=100`) *before* pagination,
so a large page window alone cannot recover the omitted middle of any listing
over ~100 lines.  Any truncation or mismatch yields `null` — a partial
manifest is never recorded as a baseline.

**Per-round comparison.**  At each round’s probe phase, `runDeliverablesProbe`
captures the worktree state again and calls `computeNewlyChanged` to produce
the set of paths whose content hash differs from the baseline.  Only those
paths are fed to `checkDeliverablesSinceBaseline`; paths that were already
dirty at chain start are invisible to the probe unless the round modified
them further.  The overall changed-nothing flag (`worktreeChanged`) is
recorded on the round record and surfaced in every chain output (escalation,
max-rounds, chain-show).

**Content-sensitive, not path-sensitive.**  A round that modifies an
already-dirty file is detected because the file’s content hash changes.  A
round that leaves every file alone (even though paths registered as dirty at
chain start) is correctly reported as having changed nothing.

**Old records.**  Chain directories recorded before this change have no
baseline.  Their round records lack the `worktreeChanged` field, which
`renderChainShow` and the outcome renderers display as `changed: unknown`
rather than incorrectly claiming nothing changed.

**No worktree mutation.**  The measurement uses a temporary index file and
`GIT_INDEX_FILE`; `git add -A` modifies only the scratch copy.  After the
probe, `git status --porcelain` reports exactly what it did before, and HEAD
has not moved.  `git add` does write blob objects and `write-tree` a tree
object into the object store; they are unreferenced and `git gc` collects
them.  The guarantee is that nothing the orchestrator would publish changes —
not that the command writes nothing at all.

**Unknown is not "unchanged".**  When no baseline exists (old chains) or a
per-round capture fails, the comparison yields `null`, and every consumer
falls back to the full `git status --porcelain` set — the behaviour that
predates baselines.  It must never collapse to `[]`: an empty array asserts
that the round changed nothing, and `shouldSkipReview` discards a round on
that, so a failed measurement would throw away work that was actually done.


#### 3.5.3 Review

Uses `plugins/kusabi/prompts/adversarial-review.md` + `plugins/kusabi/schemas/review-output.schema.json`. The JSON schema is **embedded in the prompt** rather than passed via opencode's `format: json_schema` (workaround for opencode 1.17.x bug, issue #8). The companion extracts JSON from the model's response (`extractJson`+`strip`) and formats it (`renderReview`).

**Unparseable-output retry**: when the review response contains neither parseable JSON nor a recoverable `VERDICT:` token, `runReviewPhase` re-dispatches the review job exactly once within the same round, with identical options (same prompt, tiers, agent, tools, timeouts) — but only when the first job actually completed (`job.status === "completed"`). A hard failure (stalled / timeout / serve-dead / provider-error) returns empty or garbage output; it never triggers a retry and escalates after a single attempt, exactly as before the retry existed — re-dispatching would double worst-case latency (2 × watchdog 900s / timeout 1800s) in exactly the degraded environments where it is known-futile. The retry does not consume a round, and the round record keeps both jobs traceable (`reviewFirstJobId` for the first attempt, `reviewFirstUsage` / `reviewFirstFallbacks` for the first attempt's spend and fallback trail, all other `review*` fields from the final attempt, `reviewUnparseableRetried: true`). Chain totals include the first attempt's usage, so retried rounds report their true cost; time-window stats (`chain-stats`) and the metrics DB round rows (`chain-ingest`) fold it in as well. A verdict recovered from a `VERDICT:` token never triggers the retry; two consecutive unparseable results escalate exactly as before.

Reviewer (kusabi-review) permissions:
- **allow**: `sunaba_verify_in_container`, `sunaba_lint_in_container`, `sunaba_type_check_in_container` — independently re-runs the implementer's "gate green" claim to verify it (PR#37/#40)
- **deny**: all mutation tools (sandbox_exec, write_file, edit_file, checkout, publish, etc.) — because if the reviewer starts fixing, independence is lost
- **deny**: `sunaba_sandbox_issue_write` and `sunaba_sandbox_pr_review_write` — outward writes are the orchestrator's exclusive exit; the reviewer's deliverable is the structured final report, not issue comments or PR reviews
- The chain review prompt is augmented with machine-collected base facts (`baseSha`, recent base history, actual change set from `git status --porcelain`) so the reviewer receives "what is this task's change set" as data rather than guessing. See `renderBaseFacts` in `kusabi-companion.mjs`.

Verdict: 4-value + optional `unverified`:

| verdict | Meaning |
|---|---|
| `approve` | All acceptance criteria verifiable and passing |
| `approve-partial` | Some criteria could not be verified. Listed in `unverified` |
| `needs-attention` | Fixable defects found |
| `discard` | Premise or policy is wrong. `discard_reason` required (`wrong_premise` / `needs_stronger_model`) |

#### 3.5.4 Derive disposition (deriveDisposition)

Pure function `deriveDisposition({verdict, probesGreen, round, maxRounds, repeatedAreas, findingSeverities, strategizeEligible})` in `plugins/kusabi/scripts/disposition.mjs`:

| verdict | probesGreen | Condition | disposition | Meaning |
|---|---|---|---|---|---|
| approve | true | — | **accept** | Conclude, hand to orchestrator |
| approve | false | repeatedAreas=false | rework | Probe failure |
| approve | false | repeatedAreas=true + strategizeAllowed | **strategize** | Stalled despite approve: structural re-diagnosis before next rework (§9.1) |
| approve | false | repeatedAreas=true otherwise | **escalate** | Stalled with no strategize available; reason also notes max-rounds exhaustion when it applies |
| approve-partial | — | — | **escalate** | Unverified items remain, orchestrator decides |
| needs-attention | true | all findings low/medium (no critical/high) | **accept-with-followup** | Economic cutoff: see Decision 5 (§9.2) |
| needs-attention | — | repeatedAreas=false | rework | Fix and re-review |
| needs-attention | — | repeatedAreas=true + strategizeAllowed | **strategize** | First stall: structural re-diagnosis before next rework (§9.1) |
| needs-attention | — | repeatedAreas=true otherwise | **escalate** | Same file area flagged 2 rounds in a row = stalled |
| discard | — | — | **escalate** | Reviewer deemed it discardable |
| — | — | round ≥ maxRounds and not accepted | **escalate** | Max rounds reached; reason appends the stagnation note when repeatedAreas is true |

`strategizeAllowed` = `strategizeEligible === true && round < maxRounds`. A strategist job produced on the final round has no next round left to consume its output, so the final round never strategizes even when eligible (#117).

Policy (#117, decided 2026-07-29): `repeatedAreas` does **not** preempt accept-with-followup — probes green + all findings low/medium ships with a follow-up issue even when the same file area was flagged two rounds running. strategize only has value for rounds that cannot ship as-is.

accept-with-followup misuse guards:
- Severity comes from the reviewer's separate session (not the implementer)
- probesGreen must be true (mechanical checks passed)
- The follow-up draft always surfaces to the orchestrator (never posted automatically)

#### 3.5.5 Restart method and recording — three-lever separation

Three independent progression mechanisms (budget, model tier, session lifecycle) are now **separate**. The round number (`1..maxRounds`) is only the budget counter. Model tier escalation and session decisions are governed by a pure function `deriveReworkStrategy` in `disposition.mjs`:

**Default ladder** (no countervailing evidence):

| rework | tier  | session  |
|--------|-------|----------|
| 1st    | same  | continue |
| 2nd    | +1    | new      |
| 3rd+   | +1    | new      |

Artifacts are always carried over — the chain never rolls the worktree back.
`checkpoint_restore` has been removed from the chain (issue #114). A new session
starts fresh on the existing worktree.

Evidence inputs to `deriveReworkStrategy`:
- `reworkCount` (0-indexed: 0 = first rework)
- `strategized` — whether a strategize has occurred

The function returns:
- `tierDelta` — how many tiers to advance (0 = same tier)
- `newSession` — whether to start a fresh session
- `reason` — human-readable explanation of the decision

**Review parsing** distinguishes parseable from unparseable output. When a review response is not valid JSON (e.g., the `VERDICT:` token appears inside the JSON fence rather than outside), the companion recovers by:
1. First stripping a trailing `VERDICT:` token (standard location after the fence)
2. If extractJson still fails, calling `recoverVerdictFromText` to find the token anywhere in the text, stripping it globally, and re-parsing
3. If even that fails, recording `reviewParseable: false` on the round record with verdict `"unparseable"` — a state distinct from `needs-attention`

The shared function `recoverVerdictFromText` in `render.mjs` powers both the display layer (`renderReview`) and the decision layer (`runReviewPhase`), avoiding duplication.

### 3.5.6 chain-stats (read-only aggregation)

Launched with `chain-stats [--since <ISO>] [--until <ISO>] [--compare <ISO>]`. Reads every `chain.json` from `<stateDir>/chains/chain-*/` and prints a human-readable terminal summary. Calls no LLM, starts no container, never modifies or deletes a record. Implementation is `plugins/kusabi/scripts/chain-stats.mjs` with pure-function statistics in `computeStats` and rendering in `renderChainStats` / `renderComparison`.

**Flags:**

| Flag | Description |
|---|---|
| (none) | Lifetime totals for all chains |
| `--since <ISO>` | Include only rounds with `startedAt >= ISO` |
| `--until <ISO>` | Include only rounds with `startedAt < ISO` |
| `--compare <ISO>` | Two-column side-by-side: before vs. at/after the cutoff |

**Summary includes:**

- Number of chains and rounds, distribution of rounds per chain
- Final dispositions (last round of each chain): `accept`, `accept-with-followup`, `rework`, `strategize`, `escalate`, `discard`
- Review verdict distribution across all rounds
- Deterministic probe pass/fail counts
- `repeatedAreas` computed via `hasRepeatedAreas` from `chain-phases.mjs` (re-imported, never reimplemented). Rounds without a previous round are excluded from the denominator. Rounds missing `findingFiles` or `findings` are counted in a separate "n/a" figure.
- Prior-finding-unresolved heuristic: textual match against patterns like `(prior finding, not addressed)` and `Prior finding #N unresolved:` in `findingsText` / finding titles. **Explicitly labelled as heuristic/approximate** — there is no structured field for it.
- Token and cost totals: per-chain from `chainTotals`, overall from per-round usage sums. Per-chain min/median/max shown for multi-chain workspaces.
- Chains with unreadable `chain.json` are skipped and the count is reported.

**Missing-field handling:** A record without the `findings` or `findingFiles` array (older records from before PR #119 / #125) is counted as "not available". The excluded count appears in the output so rates are never silently computed over a smaller denominator.

**Prior-unresolved label:** The figure is printed with the annotation "(heuristic: textual match in findings text — approximate)" to make clear it is not a structured measurement.

**Design invariants:**
- No LLM call, no container start, no record mutation
- Malformed `chain.json` is skipped, not fatal; count reported
- `hasRepeatedAreas` is imported and used rather than reimplemented
- All pure-function logic is testable without a state directory

**Round record fields** (B8):
- `tierBefore`, `tierAfter` — the tier index before and after the round
- `reworkCount` — how many reworks had been done prior to this round
- `reworkStrategyReason` — the reason string from `deriveReworkStrategy`
- `pendingReworkStrategy` — the full strategy object stored on the round record and consumed by the next iteration
- `reviewParseable` — whether the review output was parseable as JSON

**Chain-start output** (B7): the chain emits a line showing `tiers=N`, `maxRounds=M`, and whether the budget can reach the top tier.

On escalate, include remaining findings + history (each round's verdict/probes/disposition/tier/resume method) in the final output. publish is never called from the chain (not on the allow list).

The chain now defaults to 4 max rounds (was 3). With the default ladder, rework 1 stays on the cheapest tier, so a 4-round chain reaches the same top tier as the old 3-round chain while spending the same number of paid rounds.

### 3.5.7 Chain lifecycle and stop lever — implemented

A chain holds the container it was given (`--container <cid>`) for its entire run — from the first round's implement dispatch through the final verdict. There is no upstream enforcement inside sunaba (the container does not reject writes), so the orchestrator is the gatekeeper. The stop lever and status readout give the orchestrator the information needed to decide when it is safe to touch the container.

**Control record (`control.json`).** Each chain directory contains a `control.json` file with its own single-writer rules:
- The chain process writes: `pid`, `container`, `status` (`running` → `completed` / `cancelled` / `failed`), `round`, `startedAt`, `finishedAt`.
- A stop-requesting process (a separate `chain-cancel` CLI invocation) writes only: `stopRequestedAt`, `stopRequestedBy`.
- Exception: when the chain process is gone (its pid no longer exists), the stop-requesting process finalises the status to `cancelled` — otherwise no one ever will.

**Stop predicate.** The chain process consults exactly one predicate, `shouldStopNow`, which returns true when either `stopRequestedAt` is present in `control.json` or a SIGTERM/SIGINT was received. Both paths feed the same predicate rather than having scattered exit paths.

It is consulted at two points per round: at the round boundary, and after the deterministic probes but before the review dispatch. The second checkpoint exists because a stop requested during implement would otherwise still buy a review job and keep the chain working in the container while the orchestrator inspects it. It sits *after* the probes rather than before them so that P1 has restored the canonical worktree state (HEAD == base, changes unstaged) that the orchestrator publishes from.

**Recorded statuses:**

| Status | Meaning |
|---|---|
| `running` | The chain process is alive and has not finished. |
| `completed` | The chain reached a terminal disposition (accept, accept-with-followup, escalate, or max-rounds). The container is no longer held. This status records *that* the chain ended, not *how*: `chain-show` therefore prints the round-derived disposition ("accepted at round 2") for a completed chain rather than the bare word. |
| `cancelled` | The chain was stopped via `chain-cancel` or SIGTERM/SIGINT, or the process was already dead when the stop was requested (`stale` finalisation). |
| `failed` | The chain stopped due to a provider-exhaustion error across all routes. |

**Stale records.** A control record that says `running` but whose pid no longer exists is **stale**. It is reported as "stale" (not "running" and not silently as "finished"), and the container is not claimed as held. A stale record is finalised to `cancelled` when a `chain-cancel` is issued against it.

**status output.** `kusabi-companion status` (no arguments) reports, for each chain of this workspace that is still running, the chain id, the round it is on, and the container it holds. A record whose pid is gone is reported as stale with an explicit note.

**chain-show output.** `chain-show` reads `control.json` to determine the chain's status. The control record is authoritative for every lifecycle status except `completed`, which defers to the round-derived disposition (see the table above). When the control record is absent (old chains from before the stop lever), it falls back to the round's last disposition — and reports `incomplete` as before.

**serve-stop protection.** `serve-stop` checks for running jobs before killing the serve. When jobs are running, it declines and points at `chain-cancel` as the correct way to stop a chain, because the chain spawns a new serve on its next dispatch. An explicit `--force` flag overrides this protection.

### 3.5.8 metrics store (ingest) — implemented

`metrics-db.mjs`, `transcript-ingest.mjs`, `chain-ingest.mjs`. A durable SQLite digest of two perishable/durable data sources, feeding the token-efficiency work (#83) and brief/outcome correlation work (#81). **Ingest + store only** — there is no query or report surface here; that is a follow-up PR.

**Why a database and not another `chain-stats`-style live reader.** Claude Code transcripts (`~/.claude/projects/<slug>/*.jsonl`) are on a rolling delete: `cleanupPeriodDays` is unset, so they are pruned by file mtime. kusabi chain records (`~/.kusabi/<hash>/chains/chain-*/chain.json`) are durable. Ingest reduces the perishable source to a durable digest that stays correct after the raw transcripts are gone.

**Storage: `node:sqlite` (built-in), zero new dependencies.** Requires Node 22.5+; the repo's CI already runs Node 24 (`.github/workflows/pull-request-ci.yml`), matching the container. kusabi has no npm dependencies and this does not add one.

**Schema** (`metrics-db.mjs` owns all SQL): `source_file` (skip-unchanged bookkeeping only — see below), `session` and `turn` (from transcripts), `chain`, `round`, and `finding` (from chain records). Full column list is in the module.

**Design invariants:**
- **One `DatabaseSync` handle, opened once by the `metrics-ingest` command, passed down.** `transcript-ingest.mjs` and `chain-ingest.mjs` never open a database themselves — that is what makes them testable against `:memory:`.
- **Idempotency is a PRIMARY KEY property (`INSERT OR REPLACE`), not a `source_file` property.** The skip-unchanged cache is a speed optimisation only. Re-ingesting the same input twice — even bypassing the skip cache entirely — produces identical row counts; this is asserted directly in the test suite, not just observed as a side effect of skipping.
- **A missing field is stored as SQL `NULL`, never coerced to 0.** A downstream `AVG()` cannot distinguish "0" from "absent," and the follow-up query PR computes rates over these columns.
- **The whole ingest runs inside one transaction** (`BEGIN` / `COMMIT`, rolled back on any error) so a crash mid-run cannot leave a half-populated database.
- **`orch_model` and `orch_date` are stratification keys, not incidental metadata** — stored verbatim as first-class, indexed columns on `chain`, never null-collapsed. The recorded history so far shows orchestrator model perfectly confounded with calendar date (and both confounded with kusabi's own maturity at the time it ran) — see the worked example below. This store does not compute rates, correlations, or any other statistic across strata; it is a reference dataset for a human reader, or for a follow-up PR that must qualify any unstratified claim, not an inference engine.
- **`orchestrator.session` is stored as a PREFIX, never truncated or normalised further.** It is a prefix of the transcript's `sessionId` (most are 8 hex chars, some 12) — the join between `chain` and `session` is a future prefix-match query, not built in this PR, and must not be pre-destroyed here.
- **Timestamps are stored as ISO strings AND epoch milliseconds** (`ts`/`ts_ms` on `turn`, `started_at`/`started_ms` on `round`, `first_ts`/`first_ts_ms`/`last_ts`/`last_ts_ms` on `session`). `startedAt` is written as UTC (`...Z`) but a human range-query naturally reaches for local time; storing the epoch form lets the follow-up PR range-query in SQL without re-parsing or falling into the string-vs-instant trap `chain-stats.mjs` already had to learn from.
- **Three distinct failure/skip counters, never folded into one.** A first pass conflated "a whole file could not be read", "a line was malformed JSON", and "a record was structurally unusable but not corrupt" under one `parseFailures` — a real-corpus review (234 transcripts, 44 chains) caught this because it made "0 bytes lost to corruption" and "a whole 50,000-record file silently missing" look identical in the summary. `ingestTranscriptDirectory` / `ingestChainDirectory` now report `ioFailures` (a whole file unreadable — counted in files, since one increment means one file's entire contents are absent), `parseFailures` (malformed JSON within a file that WAS read), and, for transcripts, `noRequestIdRecords` (assistant records skipped for lacking a usable `requestId` — not corruption, see below).

**Transcript ingest hazards (`transcript-ingest.mjs`):**
- **`usage` is duplicated verbatim across content blocks.** A single API turn emits several `type:"assistant"` JSONL records — one per content block (`thinking`, `text`, `tool_use`, one per additional `tool_use`) — and every one carries an identical copy of `message.usage`. Summing usage across all assistant records overcounts input/output/cache tokens by roughly 2–3.5x while looking entirely plausible. The fix: group by the top-level `requestId`; only the first record seen for a given `requestId` contributes `message.usage`, every record (first and later) contributes its own content-block byte counts (`text_bytes`/`thinking_bytes`/`tool_use_bytes`), since those are not duplicated.
- **`<synthetic>` model records** (`message.model === "<synthetic>"`) are placeholders (cancellations, errors) with no real usage. Excluded from usage totals (`NULL`, not 0) but still produce a `turn` row with `is_synthetic = 1` so they can be counted separately. In the real corpus, records with no usable `requestId` are overwhelmingly `<synthetic>` records that were never assigned one — `noRequestIdRecords` and `<synthetic>` records therefore OVERLAP; they are not two disjoint populations, and the summary says so rather than letting a reader add them.
- Malformed JSON lines are counted in `parseFailures`. An assistant record with no usable `requestId` is NOT a parse failure (the JSON was fine) — it is counted in `noRequestIdRecords`, since it cannot be deduplicated safely and is left out of `turns`.
- **"One file == one session" is false** — Claude Code copies earlier records forward into a new file on resume/fork, so one sessionId legitimately spans multiple `*.jsonl` files (234 files / 192 distinct sessions in the corpus measured, 15 sessions spanning more than one file). Two consequences a per-file design gets wrong:
  - **Turn dedup by `requestId` must happen across the WHOLE run, not per file** — the same requestId can recur in more than one file for a resumed/forked session. `ingestTranscriptDirectory` tracks seen requestIds globally so the reported `turns` count equals the actual `turn` table row count for the run, rather than summing each file's own (correct, but only locally deduped) count.
  - **Session metadata is AGGREGATED across every file sharing a sessionId** — `first_ts`/`last_ts` as the true min/max, not whichever file happens to be upserted last. The aggregate also merges with whatever is already stored for that sessionId, so the true range keeps widening correctly across incremental runs even when the skip-unchanged cache means not every file for a session is re-read every time.

**Chain ingest hazards (`chain-ingest.mjs`):**
- **Generational gaps in the `records` array are the norm, not the exception.** Depending on when a chain ran: the oldest generation has neither `findings` nor `findingFiles` (only free-text `findingsText`); a middle generation (post-#119) has `findingFiles` only (file paths, no severity/title); the newest (post-#123) has full `findings` objects. `finding` rows are populated from `findings` when present, else from `findingFiles` (file path only, `severity`/`title` left `NULL`), else not at all. Each `finding` row carries a `source` column (`'findings'` | `'finding_files'`) so a row synthesised from the file-paths-only generation can never be mistaken for a real structured finding — both leave `severity`/`title` `NULL`, and `source` is the only column that tells them apart. `openMetricsDb` migrates an existing on-disk database created before this column existed (`ALTER TABLE finding ADD COLUMN source` if missing) rather than requiring a fresh database file. The ingest summary reports how many chains contributed a non-empty `findings` or `findingFiles` array (`chainsWithStructuredFindings` of `chainsIngested`) as a raw count — deliberately not rendered as a percentage here — so a follow-up PR cannot silently compute a rate over a fraction of the data while looking like it covers all of it. This flag is set from rows ACTUALLY PRODUCED, not from the raw array's presence — a `findings` array containing only non-object entries must not report "structured findings" when zero rows resulted.
- **Brief metrics reuse `brief-parsing.mjs`** (`hasSectionHeading`, `parseDeliverables`, `parseSmoke`) rather than re-deriving section parsing. `brief_text` is stored in full so derived columns can be recomputed if the derivation improves later. `## Deliverables` is recorded (`brief_has_deliverables`, `brief_deliverable_count`) but is not a useful discriminator in the corpus measured so far (it was present in every brief); `## Smoke` does vary and is recorded the same way.
- **The confounder worked example** (why `orch_model`/`orch_date` are mandatory, indexed, un-collapsed columns): a naive read of "longer brief → fewer rounds" reversed sign inside individual orchestrator-model strata, and orchestrator model turned out to appear on non-overlapping calendar dates in the recorded history — i.e. "model" and "era of the codebase" were the same variable. Nothing in this module computes across that confound; it only stores the keys cleanly enough that a later analysis (or a human) can refuse to be fooled by it.
- A `chain.json` that fails `JSON.parse`, or parses to something with no usable `chainId`, is counted in `parseFailures`. A `chain.json` that could not be stat'd or read at all is counted in `ioFailures` instead (a whole chain's data missing, not malformed data). A chain directory with no `chain.json` at all (died before ever persisting one) is skipped silently — not a failure, just nothing to ingest, matching `chain-stats.mjs`'s existing `noRecord` treatment.

**`metrics-ingest` CLI** (`kusabi-companion.mjs`): flags `--transcript-dir <path>` (default `~/.claude/projects`), `--state-root <path>` (default the kusabi state root, `~/.kusabi`), `--db <path>` (default `<state-root>/metrics.db`), `--dry-run`. A dry run opens `:memory:` instead of the real path — the real database file is never even opened, let alone written — and prints the same summary (files scanned / skipped-unchanged, I/O failures, sessions, turns, chains, rounds, findings, parse failures) that a real run would.

### 3.5.9 metrics store (query/report) — implemented

`metrics-report.mjs`, wired as the `metrics-report` subcommand in `kusabi-companion.mjs`. The read surface phase 1 (§3.5.8) deliberately left unbuilt (closes #83, #81): where transcript token spend goes and whether cache reads dominate it, and what the recorded chain history looks like when brief metrics are cross-tabulated against outcomes.

**Ownership amendment to §3.5.8.** §3.5.8 states "metrics-db.mjs owns all SQL" — that invariant existed so the ingest modules stay testable against `:memory:`; the load-bearing part is *who opens the handle*, not which module's SELECTs run where. That is preserved exactly: `metrics-db.mjs` remains the only module that constructs a `DatabaseSync` (it gains `openMetricsDbReadOnly(dbPath)` alongside the existing writable `openMetricsDb`). `metrics-report.mjs`'s SELECT statements run against an already-open handle passed in by the caller, which is what makes its own tests runnable against `:memory:` too. Recorded here explicitly so a future reader does not mistake this for the invariant having been broken by accident.

**Pure reader — hard constraint.** `metrics-report` never ingests (`ingestTranscriptDirectory` / `ingestChainDirectory` are not imported), and never opens the writable handle (`openMetricsDb`, which runs `PRAGMA journal_mode=WAL`, `CREATE TABLE`, and the `finding.source` `ALTER TABLE` migration — all writes). It opens with `new DatabaseSync(dbPath, { readOnly: true })` via `openMetricsDbReadOnly`. No `CREATE`/`ALTER`/`INSERT`/`UPDATE`/`DELETE` appears anywhere in `metrics-report.mjs` (tests build fixtures with the phase-1 writable `openMetricsDb` + `upsert*` helpers instead).

**`--compare` is rejected, not silently ignored.** `cli.mjs` parses `--compare` for `chain-stats`'s benefit; `metrics-report` does not support it and throws `--compare is not supported by metrics-report; run it twice with --since/--until instead` rather than accepting and ignoring it — silently accepting a flag that changes nothing would answer a different question than the one asked.

**Time bounds fail fast — deliberately differs from `chain-stats`.** An unparseable `--since`/`--until` throws (`--since: not a parseable timestamp: <value>`) instead of degrading to lexicographic string comparison the way `chain-stats.mjs` does for backward compatibility. A new surface can afford to fail loudly: a typo'd bound silently falling back to string comparison produces a wrong table that looks right, which is worse than a hard error. Every window comparison uses the stored epoch-ms columns (`turn.ts_ms`, `round.started_ms`) against `Date.parse(bound)`, comparing instants — `startedAt` is stored as UTC (`...Z`) but a human naturally reaches for local time (e.g. `+09:00`), and string ordering puts that same instant on the wrong side of a naive cutoff.

**Chain window key fallback ladder.** A chain's position in the window is `MIN(round.started_ms)` over its rounds; if that is unavailable, `Date.parse(orch_date + "T00:00:00Z")`; if that is also unusable, the chain is undated — excluded whenever a bound is active, and counted in a visible `excluded (no timestamp)` line rather than silently dropped. Proper per-chain time *attribution* (as opposed to windowing) would need a chain end timestamp, which the schema does not have (`round.started_ms` only — scoping to `[first round start, last round start]` would undercount the final round still in flight). Flagged here as a future schema question, not fixed in this PR.

**Cost is relative units, never dollars.** `input x1 + output x5 + cache_write x1.25 + cache_read x0.1` — Anthropic's published cross-model ratios (output is 5x input price; a 5-minute cache write is 1.25x input; a cache read is 0.1x input). This keeps the weighting model-agnostic with no per-model price table to rot, but the units are explicitly not currency and the report says so. Both `cache read: N% of tokens` and `N% of cost` are printed side by side — on the real corpus these are materially different numbers (~97% vs ~64%), and #64's "cache read dominates" finding needs to be checkable against either framing.

**Sidechain turns are included, synthetic turns are excluded — both broken out separately.** Sidechain turns (`is_sidechain=1`, Task subagent turns) are real billed spend: excluding them from totals would understate the bill, but folding them in without a visible breakout would misattribute subagent cost to the orchestrator's own turns, so they are counted in the sum AND reported as their own line for the reader to subtract if needed. Synthetic turns (`is_synthetic=1`) are placeholders with no real usage by construction and are excluded from every sum entirely, counted only in their own bucket. A `SUM()` over an all-NULL usage column (all turns synthetic, or all missing usage) renders `n/a`, never silently `0` — the two are not the same claim.

**The orchestrator/chain join is a PREFIX match, not equality — and is asymmetric on purpose.** `chain.orch_session` is a prefix of the transcript's `session.session_id` (8 hex chars in some records, 12-plus-a-dash in others). Exact equality finds 4 of 44 matches in the real corpus; prefix matching (`session_id.slice(0, orch_session.length) === orch_session` in JS — equivalent to SQL `substr(session_id, 1, length(orch_session)) = orch_session`, deliberately not `LIKE orch_session || '%'`, whose `%`/`_` would be treated as wildcards if a stored prefix ever contained them — guarded by `orch_session.length >= 8` so an empty/degenerate prefix cannot match every session) finds 44 of 44. Ambiguity is frozen behaviour, not an edge case swept under a default: 0 matches renders `orphan (session not ingested)`, 2+ matches renders `ambiguous (N sessions)` in place of every orchestrator number for that row — summing across candidates would invent cost, picking one would invent provenance. There are zero collisions in the corpus measured so far, but 8-character prefixes will collide eventually, and the report must not start lying quietly when they do.

**The join is non-additive — its most important property.** 44 chains map to only 13 distinct orchestrator sessions in the corpus (one orchestrator session launches several chains), so the same session's turn/cost numbers legitimately appear on multiple rows. The report annotates the session column with the count of chains sharing it (e.g. `abcdef12 (x4)`), prints an explicit warning that the orchestrator columns describe the WHOLE session and are NOT per-chain, and emits no orchestrator total or subtotal anywhere in that section — the reader must not sum a column that was never meant to be summed.

**Brief vs outcome (§7, issue #81) is raw counts only, always stratified by `orch_model`.** No rates, no percentages, no totals row across models, no correlation, no regression, no normalisation — orchestrator model is perfectly confounded with calendar date in the recorded history (and both with kusabi's own maturity at the time), so any number computed across strata is a wrong number that looks right (same confounder documented in §3.5.8). Final disposition uses the identical definition `chain-stats.mjs` already uses — the disposition of the round with `round = MAX(round)` for that chain — so the two surfaces cannot disagree about what "final" means; `chain-stats.mjs` itself is untouched (not merged, not refactored, not sharing helpers) since it answers a different question (live chain files, not the durable store). Chains with zero rounds are counted in a `chains with no rounds: N` line rather than silently dropped from the table. `## Deliverables` presence is reported for completeness even though it has no discriminating power in the corpus measured so far (present in every brief) — the report says so explicitly rather than implying it is a signal.

**Empty store / empty window are states, not errors.** A missing db file, a db with every table empty, and a window that matches no rows all exit 0. A missing file is never created to check it — `fs.existsSync` is checked before any open, since a read-only `DatabaseSync` open of a nonexistent path throws. The freshness header (whole-store `MAX()`s over `source_file.ingested_at`, `turn.ts`, `round.started_at`, `chain.orch_date`, plus `COUNT(*) FROM source_file`) is always computed before and independently of any window filter, and is always the first thing printed — a window that happens to exclude the newest data must not make the store look more or less fresh than it is. `--json` mirrors every case (`status`: `"ok"` | `"missing"` | `"empty"` | `"empty_window"`) as a valid document with empty arrays rather than an absent one, and never coerces a null sum to `0`.

### 3.6 sunaba-rpc (raw JSON-RPC client) — implemented

`plugins/kusabi/scripts/sunaba-rpc.mjs`. A **raw HTTP+SSE client** for the companion's non-LLM pipeline (deterministic probes, etc.) to call sunaba's MCP tools. **Not an MCP client.**

- **Endpoint**: env `KUSABI_SUNABA_URL`, default `http://127.0.0.1:8750/mcp`. 127.0.0.1 (fixed, avoids IPv6 name resolution issues with localhost)
- **Protocol**: Streamable HTTP. `initialize` POST → save `mcp-session-id` from response header → `notifications/initialized` → `tools/call`
- **Response format**: SSE (`data:` lines). The last line's JSON is the result. Auto-unwraps MCP's `content[0].text` wrapper (`unwrapResult`)
- **Tool allow list (hardcoded)** — only the following 4 tools. Calling anything outside the list throws a pre-call validation error:
  - `verify_in_container`
  - `sandbox_exec`
  - `checkpoint`
  - `checkpoint_list`

  `checkpoint_restore` was removed in issue #114 — the chain never rolls the
  worktree back, so the tool is structurally uncallable from here.

publish / issue_write / sandbox_initialize etc. are **structurally uncallable** (design invariant: network exit is orchestrator-exclusive).

`sandbox_exec`'s `commands` **must be passed as an array** (a string causes a validation error).

### 3.7 explain subcommand (retired 2026-07-27, #139) — the #136 incident and its guards

`kusabi-companion.mjs explain <question>` extracts a passage from the Claude
Code transcript and hands it, plus the question, to a cheap worker via
`runPrompt`. On 2026-07-27 one `/kusabi:explain` invocation self-replicated
into 202 explain jobs in 106 seconds and took the host down. Root cause was
three independent gaps stacking: the extracted passage included the
in-flight `/kusabi:explain` command's own text, the explain worker had no
tool deny at all, and nothing anywhere refused a worker re-invoking the
companion. Any one of the three would have stopped the incident on its own;
all three were fixed because each guards a different layer and all three are
cheap.

**Guard 1 — bounded passage extraction.** `extractAssistantText` selects the
last N text-carrying assistant records by scanning backwards, then used to
collect `records.slice(startIdx)` — open-ended to the end of the file. At
explain time the trailing record is always the in-flight `/kusabi:explain`
command expansion (a user-side record whose text contains a literal
``Run: ```bash node …/kusabi-companion.mjs explain "…"``` `` block), so that
block was quoted straight into the worker prompt. The slice is now bounded
at **both** ends: `records.slice(assistantIndices[0], assistantIndices[last] + 1)`.
Interleaved user text between selected assistant messages (the reason the
slice was ever more than the assistant records themselves, e.g. `--last N >
1`) still falls inside the bound. **Narrowing consequence**: `--tools`
(`includeTools`) no longer picks up `tool_result` blocks that trail the last
assistant text — only those that lie within the bounded slice. This is
intentional, not incidental: a trailing tool result at explain time is, like
the trailing user text, part of the in-flight command rather than the
answer being explained.

**Guard 2 — explain gets a deny-all tool surface.** `cmdExplain` passed
`tools: undefined` to `runPrompt` — no deny at all, unlike `cmdReview`
(`reviewDenyTools()`). The worker that self-replicated had bash. Fix:
`cli.mjs` exports `explainDenyTools()`, a strict superset of
`reviewDenyTools()` — every tool review denies, plus the read/navigation
surface (`read`, `grep`, `glob`, `list`, `webfetch`, `todowrite`,
`todoread`). explain's entire job is "read the extracted passage, answer the
question" — it has no legitimate tool use, not even read-only ones.
`cmdExplain` now passes `tools: explainDenyTools()`.
**Route taken: explicit deny list, not a wildcard.** A wildcard entry like
`"*": false` was considered (it would future-proof against new tools this
list doesn't yet name), but nothing in this repo — no vendored opencode
types, no doc, no tested CLI behaviour — confirms the `tools` session
parameter honours wildcard keys (§7 above documents only the per-name
`{name: false}` deny contract, confirmed via live A/B testing on 1.18.3).
Shipping an unverified wildcard as the *only* guard would read as safe while
possibly doing nothing. The explicit list stands alone until wildcard
support is verified.

**Guard 3 — refuse dispatch from inside a worker context.** Even with
guards 1 and 2, nothing stopped a worker that regained tool access some
other way (a quoted command, a deny-list gap, a future tool) from
re-invoking the companion and starting the same chain reaction. `ensureServer`
(`serve-lifecycle.mjs`) now stamps `KUSABI_WORKER_CONTEXT: "1"` into the
spawned serve's env (built by the `buildServeEnv` seam, alongside
`OPENCODE_SERVER_PASSWORD`); every tool process a worker session runs —
bash included — is a descendant of that serve and inherits the marker. The
companion's CLI entry (`main()` in `kusabi-companion.mjs`) checks the marker
before dispatch: if set and the subcommand is **job-creating** — reaches
`runPrompt`/`dispatchWithFallback`, or starts a chain, which dispatches
rounds through the same path — it exits non-zero instead of running. The
job-creating set, enumerated from the dispatch table rather than guessed:
`task`, `review`, `salvage`, `chain`. Everything else (`status`,
`result`, `cancel`, `serve-stop`, `chain-cancel`, `chain-show`,
`chain-stats`, `metrics-ingest`, `metrics-report`, `install-agents`,
`setup`, `help`) stays allowed — the guard is against *spawning* a job, not
against reading or stopping one. The refusal message states both the reason
and the alternative (a denial without an alternative pushes a confused
worker toward a worse path):
> refusing to dispatch from inside a kusabi worker context
> (KUSABI_WORKER_CONTEXT is set). Workers must not spawn jobs — put your
> findings in your final answer and let the orchestrator decide.

The orchestrator's own (host) invocations are unaffected — nothing sets the
marker outside a serve's own descendants, so the marker travels only
serve → worker tool processes, never back to the host shell.

**Retirement (#139).** The explain subcommand itself is gone: its motive is
better served by the built-in `/btw` (zero lasting context cost), it had
zero successful real uses (its first real invocation was this incident), and
its transcript-parsing surface tracked an undocumented external format.
Guards 1 and 2 above (bounded passage extraction, deny-all tool surface)
were explain-specific and left with the code. Guard 3 (worker-context
dispatch refusal) survives unchanged because it protects every job-creating
subcommand, not just explain. The durable lesson is not about explain in
particular: anything quoted into a worker prompt will eventually be
executed if the worker has tools.

## 4. Model operations

- **Default is Flash**: zen's deepseek-v4-flash-free (daily free tier) → go's deepseek v4 Flash.
- **Quality upgrades are not automated**: The inspection/acceptance by the orchestrator collects findings into a brief and explicitly re-delegates to Pro. The loop "Flash 80% (free) → inspection/acceptance by the orchestrator → Pro finishing (small cost)" has been empirically validated.
- **Auto-fallback only on quota errors**: When a dispatch fails with a capacity or quota reason, the companion re-dispatches on the next unused route of the same tier automatically, without consuming a round. The fallback event is recorded on the job record and rendered in the job output. Routes that failed with a capacity reason are remembered (process-scoped) for subsequent dispatches.
- **Always display the provider/model actually used** (issue #7). Silent fallback from zen free tier to paid go would silently break the cost structure, so visibility is mandatory. The rendered output always names the route actually used (`route: provider/model:variant`) and lists any fallbacks that occurred.

### 4.1 Tiered chain entries

Entries in `models.chain` and `models.phases.<phase>` may be **either a string or a non-empty array of strings**. A string is a tier with one route; an array is one tier whose entries are alternate routes of equivalent quality, in preference order.

Tier selection is decoupled from the round counter. `selectRoutes` in `cli.mjs` accepts an optional `tierIndex` parameter; when provided, it is used directly (clamped to the tier count). When absent, the old `min(round - 1, tierCount - 1)` fallback applies for backward compatibility. The chain passes `tierIndex` derived from `deriveReworkStrategy`'s cumulative tier delta, so the model tier is independent of the round budget counter.

The built-in default chain is two tiers (matching DESIGN.md §4's "free → flash → pro" capacity path), with the reasoning variant pinned to `max` on every route:

```
[["opencode/deepseek-v4-flash-free:max", "opencode-go/deepseek-v4-flash:max"],
 ["opencode-go/deepseek-v4-pro:max"]]
```

Existing flat all-string configs keep working (each string is a single-route tier).

### 4.2 Provider/model:variant syntax

Every route string follows the format `provider/model` with an optional `:variant` suffix (e.g. `opencode-go/deepseek-v4-flash:max`). The variant is parsed by `parseModel` and passed to opencode's `prompt_async` API as the `variant` field. On flash-free, `:max` enables reasoning (measured: 0 vs 1075 reasoning tokens on the same prompt without it, because `reasoning_options` includes a `toggle` that defaults to OFF). The variant actually used is recorded on every job record (`modelVariant` field) and appears in rendered output alongside the route.

### 4.3 Fail-fast retry detection

The SSE watcher inside `runPrompt` detects `session.status` events with `type: "retry"`. The decision to stop is made by the pure function `shouldFailFast({ reason, attempt, steps })`:

- **Capacity/quota reasons** (`free_tier_limit` today): dispatch ends on the **first** occurrence. The provider has stated retrying cannot succeed, so no threshold is applied.
- **Other retry reasons**: dispatch ends when `attempt >= 3` **while** `steps === 0` (no work completed). If at least one step was recorded, retries do NOT end the dispatch — real work is in progress, and the existing watchdog/timeout keep their current role.

When fail-fast triggers, the session is aborted immediately and the job's status is set to `provider-error` — a new status distinct from `completed`, `stalled`, `timeout`, and `error`. The job record carries structured retry information (`job.retry`) so callers never need to parse prose or open `events.ndjson` for triage. `stalled` keeps its meaning ("silence watchdog fired") unchanged.

## 5. Inspection/acceptance by the orchestrator (orchestrator's responsibility)

- **Two-stage verify**: The worker's verify tends to be scoped to a subset or directory (empirical: a "full suite" report was actually 21 single-file runs). The orchestrator always executes the true full `verify_in_container` before publish.
- **publish is orchestrator-exclusive**: The network exit (publish) is never given to the worker. Credentials are resolved by sunaba on the host side; no tokens exist inside the container.
- Worker guardrails (issue #5): verify scope must be at directory level / reproduction must use mocked unit tests / do not build live environments or search credentials (empirical: Flash progressed to `env | grep -i token`. Sunaba's no-token design prevented actual damage).
  - **Codified**: `prompts/task-guardrails.md` is auto-prepended by the companion to every task prompt (scope adherence / honest verify reporting / mock reproduction / VCS exit prohibited / three-part report format). The orchestrator only needs to write task-specific content (scope, premise, acceptance criteria). When the phase chain (§3) is implemented, this is absorbed into the agent definition side.
- **Review requires context premise** (2026-07-17 A/B measurement): The same diff, without a focus context, produced a finding built on a false premise that benevolently fabricated the old code's intent. When given the issue's premise as context, the review became a verifiable upstream-source review. When delegating a review, always include the premise (issue, intent, known empirical facts) in the focus.

### 5.1 Frozen oracle and integrity check

Transplant the two-layer structure from dev-workflow-orchestrator (prototype): **"acceptance test = frozen, read-only oracle / development test = mutable scaffold"**. Does not carry over FSM etc.

- The brief's `## Acceptance Criteria` is a frozen contract. Files listed under `## Frozen Tests` are off-limits to implement/respond workers
- Add one step to the inspection/acceptance by the orchestrator procedure: before publish, mechanically verify via diff that there are no changes to the frozen test paths (if there are, revert without asking why). Then confirm satisfaction of the acceptance criteria
- Source: dev-workflow-orchestrator design philosophy. The two-layer test structure (frozen oracle + mutable scaffold) reduces reliance on the honesty of the worker's verify

## 6. Failure and recovery

Since workers hold no intrinsic state, even if opencode dies silently, recovery from sunaba-side traces is possible:

- How far they got = `checkpoint_list` + `diff_in_container`
- What they were doing = journal (sandbox_attach's session_label is replaced, recording the worker's operations)
- What they were thinking = brief on the issue

The recovery path is **the same path as quality-failure retries** (diff inspection → accept or restore → re-delegate). Therefore, the companion's watchdog (issue #6) can kill unceremoniously — the only loss is the session context which would be discarded across phases anyway.

Timeout layering: sunaba exec < opencode `experimental.mcp_timeout` (raised to 600000; full verify's MCP call measured at 110s, only 10s shy of the default 120s cliff) < companion watchdog.

## 7. opencode constraints identified through testing (1.17.x → 1.18.3)

| Constraint | Impact | Mitigation |
|---|---|---|
| `format: json_schema` corrupts session | provider 400 + all subsequent GET /message also 400 | Embed schema in prompt. Upstream tracking → issue #8 |
| MCP tools do not trigger permission asks (silent allow) | Companion's permission firewall is ineffective against MCP | `tools: {name: false}` (= `--deny`) blocks at execution time |
| Denied tools are physically excluded from the model's tool list (1.18.3+) | Reduces context, also eliminates wasted call attempts | Full deny, implemented via agent definitions (see §3.3) |
| Default `mcp_timeout` 120s | Full verify times out as tests increase | Raised to 600000 |

### Reviewer permissions (finalized in PR#37/#40)

| Tool | Permission | Rationale |
|---|---|---|
| `verify_in_container` / `lint_in_container` / `type_check_in_container` | **allow** | Necessary to independently re-run the implementer's "gate green" claim |
| `sandbox_exec` / `sandbox_exec_background` / `run_container_and_exec` | **deny** | Arbitrary shell execution breaks read-only |
| All mutation tools (write_file/edit_file/checkpoint_restore/publish etc.) | **deny** | If the reviewer starts fixing, independence is lost |

Container management tools (`sandbox_initialize` / `sandbox_stop`, etc.) are also denied. This configuration is hardcoded in `plugins/kusabi/opencode-agents/kusabi-review.md`.

## 8. Verification record (2026-07-16, VM / opencode 1.17.20)

1. **Serve mode E2E**: flash-free worker attach → full verify (1443 tests) → correct report, completed in 121s.
2. **Real issue delegation (shiori#210)**: Flash identified root cause (rg omits `FILE:` prefix with a single file argument) → fix + regression test → checkpoint → verify → structured report in 343s. Inspection/acceptance by the orchestrator produced 3 findings (over-scoped verify report / hacky fix / user-input error with rel_path).
3. **Pro finishing re-delegation**: Findings consolidated into a brief and re-delegated to Pro in 173s. Correctly implemented `rg -H`, path normalization, and repo-wide verify (422/422). Published as shiori PR #274.

## 9. Auto-chain expansion plan (implemented stages)

The following content is derived from the design agreed in the "design confirmation before starting" comment (2026-07-19) on issue #36. Decisions 4 and 5 are implemented in current main; Stages C/D remain future work.

### 9.1 Decision 4: strategist stage (stall countermeasure) — **implemented**

Implemented in `plugins/kusabi/scripts/kusabi-companion.mjs`:

- `deriveDisposition` accepts an optional `strategizeEligible` boolean, combined internally with `round < maxRounds` into `strategizeAllowed` (a strategist job on the final round has no next round to consume its output — #117). When `repeatedAreas` holds on a non-shippable round and `strategizeAllowed` is true — `needs-attention`, or `approve` with probes red — returns `{ disposition: "strategize", ... }` (needs-attention reason: "same file area flagged twice; structural re-diagnosis before next rework"). On the second stagnation (strategized=true), escalates as before.
- `renderStrategistPrompt` is an exported pure function that builds the prompt for the strategist: acceptance criteria + findings from the last two rounds + one-structural-change instruction.
- On `strategize` disposition, the chain dispatches ONE extra job (kind: "strategist") with agent `kusabi-investigate` and `tools: reviewDenyTools()`. Records `strategistJobId`, `strategistUsage`, and `strategistRecommendation` on the round record.
- Sets chain-level `strategized: true` persisted in `chain.json`. The next rework round includes the recommendation under `## Strategist recommendation (structural change for this rework)` and starts a FRESH session on the existing worktree (anchoring break per §3.4 — the conversation is discarded, the work is not).
- The strategist does not consume its own round number; normal round accounting applies to the rework. The max-rounds hard limit still applies unchanged.
- `chain-show` renders the strategist round data: model/usage line and the recommendation verbatim.

### 9.2 Decision 5: accept-with-followup (economic cutoff) — **implemented**

Implemented in `plugins/kusabi/scripts/kusabi-companion.mjs`:

- `deriveDisposition` accepts an optional `findingSeverities` array. When `probesGreen=true`, `verdict="needs-attention"`, and every element of `findingSeverities` is `"low"` or `"medium"`, returns `{ disposition: "accept-with-followup", reason: "probes green; remaining findings all minor" }`.
- `renderFollowupDraft` is an exported pure function that builds a markdown draft from chainId, briefTitle, and findings.
- On `accept-with-followup`, the chain stores the draft on `chain.json` (and the round record), ends successfully, and includes the draft under the heading `## Follow-up issue draft (not posted — orchestrator judgement required)`.
- `chain-show` displays the draft when present, verbatim, with no truncation of findings.
- The companion never posts the draft (no `issue_write` call site added).

Conditions:
- All probes green
- Verdict is needs-attention AND all findings are low/medium (no critical/high)

Anti-abuse guards:
1. Severity comes from the reviewer's separate session (not the implementer). The implementer cannot self-declare
2. Application requires **all probes green as a precondition** (severity classification is irrelevant as long as mechanical checks are not passed)
3. Carried-over findings **always reach the orchestrator's eyes** (draft is included in the chain output and `chain-show`, never posted automatically)

Reference: issue #36 comment "Decision 5: accept-with-followup (economic cutoff rule)"

### 9.3 Stage B/C overview

| Stage | Content | Prerequisite |
|---|---|---|
| **B** | Brief-declaration probes: `kind: refactor` / `baseline_collected: N` format. Migration byte identity (P5) | Stage A stable operation |
| **B** | Decision 5 (accept-with-followup) — **done**. Decision 4 (strategist stage) — **done** | Stage A |
| **C** | Patch-target audit (future, unnumbered): mechanically classify patch/monkeypatch.setattr targets via AST. Use only for mock-target determination; exclude system-under-test tests | Stage B |
| **D** | Connect discard path to #33 (best-of-N) | Stage C, awaiting real-world experience |

The deliverables probe (P3) and the smoke probe (P4) are now implemented; see §3.5.2. P5 (migration byte identity) remains as future work.

Reference: issue #36 comment "Design confirmation before starting → Decision 3: stage split (1 PR = 1 stage)"

### 9.4 Remaining tasks (current state)

Managed via issues:
- #7-2 (remaining model visualization items)
- #8 (upstream tracking: report and fix opencode format:json_schema bug)
- #33 (best-of-n tournament)
- #35 (threat model: qualifies as a design invariant for deterministic probes)
- #36 (this issue) implementation items from Stage B onward
