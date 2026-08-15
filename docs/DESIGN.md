# kusabi Design Document

Last updated: 2026-08-10
Status: Design finalized + field-verified up to the phase chain, auto-chain (chain subcommand + sunaba-rpc) **implemented / reflected in main**. The phase chain (§3) now lives in `docs/design/phase-chain.md`; the §3.x numbers named below are unchanged. Decision 5 (accept-with-followup, §9.2) **implemented**. Decision 4 (strategist, §9.1) **implemented**. Fail-fast retry detection, tiered chain entries, and capacity fallback (issue #50) **implemented**. chain-stats (issue #124) **implemented**. The metrics store — ingest (§3.5.8) and query/report (§3.5.9) — **implemented**. chain-resume (§3.5.10) **implemented**. The review record (§3.5.7) and the P2 verify-gate baseline (§3.5.2) **implemented**. The claude dispatch backend (§3.5.11) **implemented** (fresh dispatch, session resume, and the metrics-DB backend columns with the report by-backend split). Per-phase backend mixing via `claude/` entry prefixes (kusabi #192, §3.5.12) **implemented** (implement and review resolve their backends independently from `models.phases.<phase>`; one phase's chain must be single-backend; round records gain `reviewBackend`). Per-round rework tiering (kusabi #192 axis 2, §3.5.13) **implemented** (`models.phases.rework` sends implement rounds after round 1 onto their own chain/backend — a strong round-1 model with cheap rework; the tier ladder climbs over the rework chain; chain.json persists `reworkModel` / `reworkModelChain` / `reworkBackend` for chain-resume). Rework scheduling by finding kind (kusabi #60 step 2, §3.5.5a) **implemented** (mechanical findings cleaned up first in free rounds; design findings one per budget round; budget derived from records, never persisted). JSONL review output (kusabi #202, §3.5.3) **implemented** (the reviewer emits one record per line as each piece is decided; the single-object path is still read; a stream without a verdict line is a `partial` review that escalates). Stages C/D remain future work (§9.3).

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

Moved to `docs/design/phase-chain.md` (kusabi #200). The section numbers there are
unchanged, so a reference to §3.x still names the same section.

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
  - **Codified**: `prompts/task-guardrails.md` is auto-prepended by the companion to every task prompt (scope adherence / honest verify reporting / mock reproduction / VCS exit prohibited / three-part report format). The orchestrator only needs to write task-specific content (scope, premise, acceptance criteria). When the phase chain (`docs/design/phase-chain.md` §3) is implemented, this is absorbed into the agent definition side.
- **Review requires context premise** (2026-07-17 A/B measurement): The same diff, without a focus context, produced a finding built on a false premise that benevolently fabricated the old code's intent. When given the issue's premise as context, the review became a verifiable upstream-source review. When delegating a review, always include the premise (issue, intent, known empirical facts) in the focus.

### 5.1 Frozen oracle and integrity check

Transplant the two-layer structure from dev-workflow-orchestrator (prototype): **"acceptance test = frozen, read-only oracle / development test = mutable scaffold"**. Does not carry over FSM etc.

- The brief's `## Acceptance Criteria` is a frozen contract. Files listed under `## Frozen Tests` are off-limits to implement/respond workers
- **Enforced mechanically, not by inspection** (kusabi #197, **implemented**): the chain's deterministic probes carry it. **P5 (frozen)** intersects the round's change set with the brief's `## Frozen Tests` paths; **P6 (collected)** compares the number of tests the round's verify actually ran against the chain-start baseline — "verify green" means "the tests that ran passed", not "the tests still exist" (the motivating incident: a dependency drift made 273 of 607 tests uncollectable while verify stayed green). See `docs/design/phase-chain.md` §3.5.2. Detection no longer depends on the orchestrator remembering to diff the frozen paths before publish
- A P5/P6 failure ends the round as **escalate**, never an automatic rework: a frozen-path edit or a count decrease can be legitimate (test consolidation, moves, deliberate deletion), so the *judgement* stays the human's — only the *detection* is mechanical. The orchestrator's job is to adjudicate the named violation, not to find it
- Source: dev-workflow-orchestrator design philosophy. The two-layer test structure (frozen oracle + mutable scaffold) reduces reliance on the honesty of the worker's verify

## 6. Failure and recovery

Since workers hold no intrinsic state, even if opencode dies silently, recovery from sunaba-side traces is possible:

- How far they got = `checkpoint_list` + `diff_in_container`
- What they were doing = journal (sandbox_attach's session_label is replaced, recording the worker's operations)
- What they were thinking = brief on the issue

The recovery path is **the same path as quality-failure retries** (diff inspection → accept or restore → re-delegate). Therefore, the companion's watchdog (issue #6) can kill unceremoniously — the only loss is the session context which would be discarded across phases anyway.

Timeout layering: sunaba exec < opencode `experimental.mcp_timeout` (raised to 600000; full verify's MCP call measured at 110s, only 10s shy of the default 120s cliff) < companion watchdog.

### 6.1 A completed job that never produced a final message

A worker can go silent without dying. The session goes idle while the model is still mid-analysis: no final assistant message is ever emitted, so the dispatch has nothing to fetch and writes a 0-byte `result.md`. From outside, the job is `completed`, the token spend is real (tens of thousands), and the result reads `(empty result)` — the reviewer looks silent, and is not. Empirical (`job-msn8ktw24af4`, 2026-08-10): `events.ndjson` 1,820,562 B holding 32,870 characters of substantive review, `result.md` 0 B. Observed three times the same day.

The output is never actually lost. **Both backends keep a complete record; only its location differs:**

| Backend | Where the full record is | Why there |
|---|---|---|
| `opencode` | the job's own `events.ndjson` | The companion subscribes to the serve's SSE stream and appends every event it accepts (empirical: on 18 of 18 sampled jobs, the existing `result.md` text is fully contained in what the stream yields) |
| `claude` | Claude Code's own transcript, `~/.claude/projects/<mangled-cwd>/<session-id>.jsonl` | `claude -p` is a child process — there is no stream of ours to record (empirical: `events.ndjson` holds 2 bookkeeping events, 208 B, on all 7 sampled jobs, while one cancelled job's transcript held 111 lines / 25,477 characters of assistant text) |

Recovery is therefore a per-backend **source behind one interface** (`result-recovery.mjs`), not an opencode path with a claude special case bolted on: a recovery that handles one backend and not the other is half a fix. What holds regardless of source:

- **Deterministic, local-only.** Recovery reads files already on disk and nothing else: no LLM, no network call, no re-dispatch. The same recorded input yields the same text byte for byte. This is the line against `salvage`, which hands the last 50 events to a model for a post-mortem — useful, but not reproducible and not a result.
- **The model's output, not its input.** The prompt is in both sources (a `user` message in the stream, `type:"user"` records in the transcript). A recovery that collects every piece of text it can find hands the brief back to the operator as if the model had written it. Provenance decides what is kept: for opencode, only parts of messages whose recorded role is `assistant`; for claude, only main-chain `assistant` records.
- **Each piece once.** The opencode stream carries a part's text more than once — on `message.part.delta` and again on the later `message.part.updated`. Naive concatenation doubles the answer.
- **Marked, and possibly truncated.** A recovered `result.md` opens with `<!-- kusabi:recovered-result -->` and a banner saying where it came from, because it may break off mid-sentence — the real one does. Neither an operator nor the `result` subcommand may mistake it for a final message. The banner deliberately contains no braces and no fence, so verdict extraction (`extractJson`) reads a recovered review exactly as it reads any other.
- **The transcript is not ours.** It is located by searching `~/.claude/projects/*/` for `<session-id>.jsonl`, never by recomputing the mangled directory name from the cwd: that mangling is Claude Code's rule, so reproducing it breaks silently the day it changes, while a search on the session id is exact and self-correcting. Unknown record types and missing fields are tolerated rather than asserted on, and an absent transcript (pruned, or the job ran on another machine) is a normal outcome, not an error.

**"No final message" and "failed to fetch" are different failures**, and the job record keeps them apart (`result.fetchFailed`, `result.fetchError`). `fetchFinalMessage(...).catch(() => "")` collapsed both into one empty string; only the second is a bug on our side — the answer may well exist and we did not get it — while the first says the model genuinely stopped talking. `result.source` names the outcome: `final-message`, `recovered`, `none` (asked, nothing there), `unavailable` (could not ask, and nothing recovered).

Recovery changes nothing upstream of itself: a job that does have a final message is written exactly as before, and `session.idle` without one is still classified `completed`.

## 7. opencode constraints identified through testing (1.17.x → 1.18.3)

| Constraint | Impact | Mitigation |
|---|---|---|
| `format: json_schema` corrupts session | provider 400 + all subsequent GET /message also 400 | Embed schema in prompt. Upstream tracking → issue #8 |
| MCP tools do not trigger permission asks (silent allow) | Companion's permission firewall is ineffective against MCP | `tools: {name: false}` (= `--deny`) blocks at execution time |
| Denied tools are physically excluded from the model's tool list (1.18.3+) | Reduces context, also eliminates wasted call attempts | Full deny, implemented via agent definitions (see `docs/design/phase-chain.md` §3.3) |
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

Implemented across `plugins/kusabi/scripts/`: `deriveDisposition` in `disposition.mjs`, `renderStrategistPrompt` in `render.mjs`, the strategist dispatch (`runStrategizePhase`) in `chain-phases.mjs`, orchestrated by `runChainDriver` in `kusabi-companion.mjs`.

- `deriveDisposition` accepts an optional `strategizeEligible` boolean, combined internally with `round < maxRounds` into `strategizeAllowed` (a strategist job on the final round has no next round to consume its output — #117). When `repeatedAreas` holds on a non-shippable round and `strategizeAllowed` is true — `needs-attention`, or `approve` with probes red — returns `{ disposition: "strategize", ... }` (needs-attention reason: "same file area flagged twice; structural re-diagnosis before next rework"). On the second stagnation (strategized=true), escalates as before.
- `renderStrategistPrompt` is an exported pure function that builds the prompt for the strategist: acceptance criteria + findings from the last two rounds + one-structural-change instruction.
- On `strategize` disposition, the chain dispatches ONE extra job (kind: "strategist") with agent `kusabi-investigate` and `tools: reviewDenyTools()`. Records `strategistJobId`, `strategistUsage`, and `strategistRecommendation` on the round record.
- Sets chain-level `strategized: true` persisted in `chain.json`. The next rework round includes the recommendation under `## Strategist recommendation (structural change for this rework)` and starts a FRESH session on the existing worktree (anchoring break per `docs/design/phase-chain.md` §3.4 — the conversation is discarded, the work is not).
- The strategist does not consume its own round number; normal round accounting applies to the rework. The max-rounds hard limit still applies unchanged.
- `chain-show` renders the strategist round data: model/usage line and the recommendation verbatim.

### 9.2 Decision 5: accept-with-followup (economic cutoff) — **implemented**

Implemented across `plugins/kusabi/scripts/`: `deriveDisposition` in `disposition.mjs`, `renderFollowupDraft` in `render.mjs`, the draft storage and terminal handling in `runChainDriver` (`kusabi-companion.mjs`), rendered by `chain-show` via `renderChainShow` (`render.mjs`).

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
| **B** | Brief-declaration probes: `kind: refactor` format. Migration byte identity (unnumbered — P1–P6 are taken by the implemented probes) | Stage A stable operation |
| **B** | Decision 5 (accept-with-followup) — **done**. Decision 4 (strategist stage) — **done** | Stage A |
| **C** | Patch-target audit (future, unnumbered): mechanically classify patch/monkeypatch.setattr targets via AST. Use only for mock-target determination; exclude system-under-test tests | Stage B |
| **D** | Connect discard path to #33 (best-of-N) | Stage C, awaiting real-world experience |

The deliverables probe (P3), the smoke probe (P4), the frozen-tests probe (P5) and the collected-count probe (P6) are now implemented; see `docs/design/phase-chain.md` §3.5.2. The `baseline_collected: N` book-keeping format this stage once envisaged is superseded: the count is captured automatically at chain start (`buildVerifyBaseline`, `collected`) and compared by P6, so no brief declares it. Migration byte identity remains as future work.

Reference: issue #36 comment "Design confirmation before starting → Decision 3: stage split (1 PR = 1 stage)"

### 9.4 Remaining tasks (current state)

Managed via issues:
- #8 (upstream tracking: report and fix opencode format:json_schema bug)
- #33 (best-of-n tournament)
- #60 (split chain rework rounds by the nature of findings, not their count — the follow-up to the `kind` tag described in `docs/design/phase-chain.md` §3.5.3)
