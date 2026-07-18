# kusabi Design Document

Last updated: 2026-07-19
Status: Design finalized + field-verified up to the phase chain, auto-chain (chain subcommand + sunaba-rpc) **implemented / reflected in main**. Stages B/C/D are planned (see #36).

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

Long sessions cause context pollution, so work is split into 5 phases, with **each phase = a new opencode session**. Cross-phase session reuse is prohibited (`--resume-last` / `--session` are for follow-ups within the same phase only).

### 3.1 Phase and tool matrix

| Phase | Role | shiori | Code write | issue_write |
|---|---|---|---|---|
| Draft | Duplicate check (horizontal) + issue creation | ○ | ✕ | ○ (artifact) |
| investigate | Deep issue dive, root cause identification | ○ | ✕ | ○ (brief appendix) |
| implement | Implementation + verify based on brief | ✕ | ○ | ✕ |
| review | Adversarial review of PR | ○ | ✕ | ○ |
| respond | Address review findings | ✕ | ○ | ✕ |

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

**checkpoint_restore + same brief + new session (or model upgrade).**
Structurally prevents anchoring to a failed approach. Measured: Flash, stuck in a rut for 343s, produced a first-pass implementation. With a brief-attached new session, Pro polished it in 173s.

### 3.5 Auto-chain (chain subcommand) — implemented

Launched with `chain --container <cid> --model <m> [--max-rounds N] "<brief>"`. Implementation is `cmdChain` in `plugins/kusabi/scripts/kusabi-companion.mjs`.

#### 3.5.1 Round structure

Each round r (1..maxRounds, default 3) flows as follows:

1. **implement**: implement with the `kusabi-implement` agent. r=1 gets the full brief; r≥2 gets only the previous round's findings + the brief's acceptance criteria. The previous session's trial-and-error log is not carried over.
2. **Deterministic probes** (§3.5.2): non-LLM checks inside the container via sunaba-rpc.
3. **review**: adversarial review with the `kusabi-review` agent. Carries over previous round findings via `--prior`.
4. **Derive disposition** (§3.5.4): mechanically determine the disposition.

#### 3.5.2 Deterministic probes (P1/P2, non-LLM)

Direct container inspection via sunaba-rpc (§3.6). Does not involve the LLM:

| Probe | Content | Behavior on failure |
|---|---|---|
| **P1: HEAD clean** | Record baseSha via `git rev-parse HEAD` at chain start. After implement, if HEAD≠base, auto-execute `git reset --mixed <base>` | Auto-fix (empirical: even when the brief explicitly prohibited it, it happened 2 out of 3 times). Record in metadata |
| **P2: verify gate** | Run `verify_in_container` (no skip flags at all) | If gate_passed=false, skip review, turn results into findings, and rework (consumes a round) |

Stage B will add P3 (test count unchanged), P4 (patch injection check), and P5 (migration byte identity) — see §9.3.

#### 3.5.3 Review

Uses `plugins/kusabi/prompts/adversarial-review.md` + `plugins/kusabi/schemas/review-output.schema.json`. The JSON schema is **embedded in the prompt** rather than passed via opencode's `format: json_schema` (workaround for opencode 1.17.x bug, issue #8). The companion extracts JSON from the model's response (`extractJson`+`strip`) and formats it (`renderReview`).

Reviewer (kusabi-review) permissions:
- **allow**: `sunaba_verify_in_container`, `sunaba_lint_in_container`, `sunaba_type_check_in_container` — independently re-runs the implementer's "gate green" claim to verify it (PR#37/#40)
- **deny**: all mutation tools (sandbox_exec, write_file, edit_file, checkout, publish, etc.) — because if the reviewer starts fixing, independence is lost

Verdict: 4-value + optional `unverified`:

| verdict | Meaning |
|---|---|
| `approve` | All acceptance criteria verifiable and passing |
| `approve-partial` | Some criteria could not be verified. Listed in `unverified` |
| `needs-attention` | Fixable defects found |
| `discard` | Premise or policy is wrong. `discard_reason` required (`wrong_premise` / `needs_stronger_model`) |

#### 3.5.4 Derive disposition (deriveDisposition)

Pure function `deriveDisposition({verdict, probesGreen, round, maxRounds, repeatedAreas})` in `plugins/kusabi/scripts/kusabi-companion.mjs`:

| verdict | probesGreen | Condition | disposition | Meaning |
|---|---|---|---|---|
| approve | true | — | **accept** | Conclude, hand to orchestrator |
| approve | false | — | rework | Probe failure |
| approve-partial | — | — | **escalate** | Unverified items remain, orchestrator decides |
| needs-attention | — | repeatedAreas=false | rework | Fix and re-review |
| needs-attention | — | repeatedAreas=true | **escalate** | Same file area flagged 2 rounds in a row = stalled |
| discard | — | — | **escalate** | Reviewer deemed it discardable |
| — | — | round ≥ maxRounds and not accepted | **escalate** | Max rounds reached |

A strategist stage (§9.1) may be inserted between rework → escalate (Stage B, not implemented).

#### 3.5.5 Restart method and recording

Rework restart methods:
- **1st time**: Continue the same implement session (feed only findings)
- **2nd time onward**: `checkpoint_restore(baseSha)` → **new session** (re-challenge with fresh context). If restore is not possible, record that fact in resumeMethod (do not record something that was not actually done)

Which method was used is recorded in each round's metadata. Persisted per-round as JSON (`round-N.json`) + aggregate JSON (`chain.json`) in state dir `chains/<chain-id>/`.

On escalate, include remaining findings + history (each round's verdict/probes/disposition/resume method) in the final output. publish is never called from the chain (not on the allow list).

### 3.6 sunaba-rpc (raw JSON-RPC client) — implemented

`plugins/kusabi/scripts/sunaba-rpc.mjs`. A **raw HTTP+SSE client** for the companion's non-LLM pipeline (deterministic probes, etc.) to call sunaba's MCP tools. **Not an MCP client.**

- **Endpoint**: env `KUSABI_SUNABA_URL`, default `http://127.0.0.1:8750/mcp`. 127.0.0.1 (fixed, avoids IPv6 name resolution issues with localhost)
- **Protocol**: Streamable HTTP. `initialize` POST → save `mcp-session-id` from response header → `notifications/initialized` → `tools/call`
- **Response format**: SSE (`data:` lines). The last line's JSON is the result. Auto-unwraps MCP's `content[0].text` wrapper (`unwrapResult`)
- **Tool allow list (hardcoded)** — only the following 5 tools. Calling anything outside the list throws a pre-call validation error:
  - `verify_in_container`
  - `sandbox_exec`
  - `checkpoint`
  - `checkpoint_list`
  - `checkpoint_restore`

publish / issue_write / sandbox_initialize etc. are **structurally uncallable** (design invariant: network exit is orchestrator-exclusive).

`sandbox_exec`'s `commands` **must be passed as an array** (a string causes a validation error).

## 4. Model operations

- **Default is Flash**: zen's deepseek-v4-flash-free (daily free tier) → go's deepseek v4 Flash.
- **Quality upgrades are not automated**: The inspection/acceptance by the orchestrator collects findings into a brief and explicitly re-delegates to Pro. The loop "Flash 80% (free) → inspection/acceptance by the orchestrator → Pro finishing (small cost)" has been empirically validated.
- **Auto-fallback only on quota errors**. When triggered, indicate it in the result.
- **Always display the provider/model actually used** (issue #7). Silent fallback from zen free tier to paid go would silently break the cost structure, so visibility is mandatory.

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

## 9. Auto-chain expansion plan (not implemented)

The following content is a **plan** agreed in the "design confirmation before starting" comment (2026-07-19) on issue #36. **NOT implemented in current main.**

### 9.1 Decision 4: strategist stage (stall countermeasure) — Stage B (planned)

Add `strategize` to `deriveDisposition`: when repeatedAreas is detected, allow one strategist stage before escalate (second stall → escalate). Reuses kusabi-investigate with a dedicated template for root-cause diagnosis (1–3 sentences) + outputs "WHAT (acceptance criteria) stays the same, change HOW structurally — one concrete suggestion". That suggestion is passed to the next rework round together with findings.

Reference: issue #36 comment "Decision 4: add strategist stage as an intermediate form of escalate in Stage B"

### 9.2 Decision 5: accept-with-followup (economic cutoff) — Stage B (planned)

Add `accept-with-followup` to `deriveDisposition`. Conditions:
- All probes green
- AND verdict is approve, or needs-attention but remaining findings are all minor (severity low/medium) AND none touch any acceptance criterion

→ Conclude by dropping remaining findings into a `followup_issue_draft` (title + body: completed scope and verification results / remaining work / known findings / reference to original issue).

Anti-abuse guards:
1. severity is the output of the reviewer (separate session from the implementer). The implementer cannot self-declare
2. Application requires **all probes green as a precondition** (severity classification is irrelevant as long as mechanical checks are not passed)
3. Carried-over findings **always reach the orchestrator's eyes** (content is seen during final inspection before publish)

Reference: issue #36 comment "Decision 5: accept-with-followup (economic cutoff rule)"

### 9.3 Stage B/C overview

| Stage | Content | Prerequisite |
|---|---|---|
| **B** | Brief-declaration probes: `kind: refactor` / `baseline_collected: N` format. Test count unchanged (P3), migration byte identity (P5) | Stage A stable operation |
| **B** | Implement Decision 4 (strategist stage) and Decision 5 (accept-with-followup) | Stage A |
| **C** | Patch injection check (P4): mechanically classify patch/monkeypatch.setattr targets via AST. Use only for mock-target determination; exclude system-under-test tests | Stage B |
| **D** | Connect discard path to #33 (best-of-N) | Stage C, awaiting real-world experience |

Reference: issue #36 comment "Design confirmation before starting → Decision 3: stage split (1 PR = 1 stage)"

### 9.4 Remaining tasks (current state)

Managed via issues:
- #7-2 (remaining model visualization items)
- #8 (upstream tracking: report and fix opencode format:json_schema bug)
- #33 (best-of-n tournament)
- #35 (threat model: qualifies as a design invariant for deterministic probes)
- #36 (this issue) implementation items from Stage B onward
