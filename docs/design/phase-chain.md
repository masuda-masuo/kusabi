# kusabi Design — §3 Phase chain

Split out of `docs/DESIGN.md` (kusabi #200); the section numbers below are unchanged. The rest of the design — §1–§2 and §4–§9 — stays in `docs/DESIGN.md`.

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

Each round r (1..maxRounds, default 4) flows as follows:

1. **implement**: implement with the `kusabi-implement` agent. r=1 gets the full brief; r≥2 gets only the previous round's findings + the brief's acceptance criteria. The previous session's trial-and-error log is not carried over. The companion injects the `--container` ID into every implement prompt (mirroring the review-side injection), so briefs no longer need to carry it.
   - Every dispatch in the chain (implement, review, strategist) goes through `dispatchWithFallback`. When a dispatch ends as `provider-error`, the companion re-dispatches on the next unused route of the same tier — same round, same container, same brief. Routes that fail with a capacity reason are remembered for the rest of the process. Fallbacks do not consume rounds.
2. **Deterministic probes** (§3.5.2): non-LLM checks inside the container via sunaba-rpc.
3. **review**: adversarial review with the `kusabi-review` agent. Carries over previous round findings via `--prior`. The reviewer does not climb the round ladder: it stays on `--model` when given, otherwise on tier 0, for every round — the same route the pre-fallback implementation used. When those routes are dead it falls through to later tiers via the same `dispatchWithFallback` mechanism. Note that tier 0 is the *cheapest* tier, not the strongest; raising the reviewer's model is done with `--model`.
4. **Derive disposition** (§3.5.4): mechanically determine the disposition.

#### 3.5.2 Deterministic probes (P1–P4, non-LLM)

Direct container inspection via sunaba-rpc (§3.6). Does not involve the LLM:

| Probe | Content | Behavior on failure |
|---|---|---|
| **P1: HEAD clean** | Record baseSha via `git rev-parse HEAD` at chain start. After implement, if HEAD≠base, auto-execute `git reset --mixed <base>` | Auto-fix (empirical: even when the brief explicitly prohibited it, it happened 2 out of 3 times). Record in metadata |
| **P2: verify gate** | Run `verify_in_container` (no skip flags at all). At chain start, before the round-1 implement dispatch, the same verify runs once on the pristine base and records the baseline lint/type violation counts (and the raw verify JSON) on `chain.json` (`captureVerifyBaseline`). P2 compares the round's counts against that baseline so pre-existing lint/type debt (which the base itself carries) is not confused with debt the worker added. | `gate_passed=true` → PASS (unchanged fast path). Failed with **test failures** (`tests.full` present — tests actually ran) → FAIL, unchanged; the baseline never tolerates a test verdict. Failed on the **lint/type precondition** (tests never ran, `tests.status="skipped"`): current count ≤ baseline for each failed gate → re-run verify with the tolerated gates skipped (`skip_lint_gate` / `skip_type_gate`) so tests execute, and PASS iff that run's tests are green — the probe detail states the tolerance (e.g. `lint 190 (baseline 190, tolerated); tests ok`), and a failed re-run distinguishes "tests not ok" (tests ran, `tests.full` present) from "still blocked before tests" (an untolerated precondition — e.g. `patch_targets` — or an error envelope; the detail names the re-run's `gate_fail_reasons`); any count above baseline → FAIL naming the increment (e.g. `lint 193 > baseline 190`). No baseline, or no reliable count (arrays and `gate_fail_reasons` both absent) → strict FAIL with the limitation recorded. Counts come from the verify result's `lint`/`types` arrays (authoritative — complete, one element per violation), with the gate's `gate_fail_reasons` summary as fallback. chain-resume reuses the recorded baseline and never re-captures on a modified worktree. |
| **P3: deliverables** | Parse `## Deliverables` section from the brief; check that at least one declared path appears in the paths the *current round* actually changed (content-sensitive baseline comparison, not `git status --porcelain`). See "Worktree baseline" below. | Empty change set **and** a non-empty `## Deliverables` section (both conditions required by `shouldSkipReview` in `chain-phases.mjs`) → review job NOT dispatched, round verdict set to `discard` with `verdictSource: "probe"` (follows the existing discard→escalate path). When no `## Deliverables` section is declared, an empty change set still goes to review — with nothing declared there is no mechanical basis for calling an empty change set a failure, so the reviewer decides. Deliverables declared but no match → P3 fails but review still runs; `deriveDisposition` handles the rest. No `## Deliverables` section → probe trivially passes. **Heading present but zero entries parsed → P3 fails** (author is told to fix brief syntax rather than believing the check ran). |
| **P4: smoke** | Parse `## Smoke` section from the brief (accepted syntaxes: unordered/ordered bullets with backtick-quoted command + optional `exit <N>` annotation, or fenced code block with one command per line/exit 0). Each declared command is executed inside the container via `sandbox_exec`; the command's stdout/stderr is redirected to a file so that the exit-code marker (`; echo SMOKE_EXIT=$?`) is the only text returned by `sandbox_exec` and is never subject to pagination truncation. The captured output file is available for diagnostic excerpts on failure (timeout: 300s). | Any entry whose observed exit code does not match the declared expected exit (or times out / cannot be executed) → P4 fails. An exit code that cannot be observed (marker absent from `sandbox_exec` return text) is reported distinctly from a command mismatch — the probe still fails but the wording says "could not be observed" rather than "observed exit unknown". A timeout arrives as data (`status: "timeout"`, `exit_code: 124`) rather than as a raised error, and is detected as such: a timeout is an outcome of the command, so it must not be reported as the probe failing to observe. No `## Smoke` section → probe trivially passes. **Heading present but zero entries parsed → P4 fails** (author is told to fix brief syntax rather than believing the check ran). |

Heading matching in `## ` sections is a **word-boundary prefix match** (kusabi #167): a heading is recognised when its text equals the section name, or starts with it and the character immediately after is not alphanumeric or underscore. Annotations after the section name are therefore allowed — `## Deliverables (files that must change)` and `## Smoke (run in container)` are recognised exactly like the bare headings — while matching stays case-sensitive and look-alikes such as `## Deliverables2` or `## Smoketest` are not. The rule applies to `## Deliverables` and `## Smoke` alike via the shared walker in `brief-parsing.mjs`, and the "heading present but zero entries parsed → probe fails" behaviour above holds for annotated headings unchanged.

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

Uses `plugins/kusabi/prompts/adversarial-review.md` + `plugins/kusabi/schemas/review-output.schema.json`. The JSON schema is **embedded in the prompt** rather than passed via opencode's `format: json_schema` (workaround for opencode 1.17.x bug, issue #8; `docs/DESIGN.md` §7 records the failure mode — the provider 400s and every subsequent `GET /message` on that session 400s too, so the session is unusable afterwards).

**Output format: JSONL, one record per line (kusabi #202).** The reviewer emits one JSON object per line, each written the moment that piece of the review is decided:

```jsonl
{"type":"finding","severity":"high","kind":"design","title":"...","body":"...","file":"src/a.mjs","line_start":12,"line_end":18,"confidence":0.8,"recommendation":"..."}
{"type":"unverified","text":"could not exercise the timeout path"}
{"type":"next_step","text":"..."}
{"type":"verdict","verdict":"needs-attention","summary":"..."}
```

A `finding` record carries exactly the finding fields `review-output.schema.json` defines, spelled the same way, plus the `type` discriminator — JSONL changes how the pieces arrive, not what a finding contains (the schema is untouched). The `verdict` record comes LAST, because the verdict genuinely depends on the findings. **A line that is not valid JSON is IGNORED**, and that is required rather than tolerated: it is what lets the reviewer narrate its way through a checklist instead of that reasoning being discarded. Measured motivation: job `job-msn8ktw24af4` streamed 25,868 characters of substantive review — working through an eight-point checklist and reaching conclusions on six points — and stopped before emitting the final object; every finding was lost, because the only artifact the system recognised was the object that never came. JSONL needs no provider support (which `docs/DESIGN.md` §7 says is unavailable): one self-delimiting object per line is a prompt convention that degrades on its own.

**Both input formats are read, JSONL first.** `parseReviewJsonl` (`review-jsonl.mjs`) runs before `extractJson` and returns null for anything that is not JSONL — prose, an empty stream, and a single JSON object, which carries no `type` discriminator (the schema's `additionalProperties: false` forbids one, so a one-line legacy blob can never be mistaken for a record). The single-object path — `extractJson` with its three extraction stages (#170/PR#171) plus `VERDICT:`-token recovery — is UNCHANGED and stays: every historical record and every reviewer not yet emitting JSONL behaves exactly as it did. Deleting it is a separate decision, to be made after JSONL has run in anger. JSONL is a **wire format only**: the records are assembled into the same in-memory shape `parseReviewResult` already returned (`{ chainParsedReview, chainVerdict, chainFindingsText, reviewParseable }`, findings in emission order), so `renderReview`, the disposition logic, the round records and `chain-ingest` consume it unchanged — the wire format never becomes a second domain model. The standalone `review` subcommand reads both formats too, since it shares the reviewer prompt with the chain.

**`partial` — findings, but no `verdict` line (kusabi #202).** A JSONL stream that carried findings and ended before the verdict record is a `partial` review: `chainVerdict` is `"partial"`, a state of its own and not an alias of any schema verdict. It is **not** an approval and it does not silently buy a rework round — it **escalates to the orchestrator** (`deriveDisposition` names it explicitly: `partial review: stream ended before the verdict line`), with the findings recorded in `roundRecord.findings` and rendered like any other findings. The review is incomplete, and only a human can judge whether partial coverage suffices. It must **not** trigger the unparseable-output retry below: that retry exists for output we could not read, whereas here the output read fine and the model ran out of room — re-dispatching would spend the budget that just proved insufficient. Mechanically, `reviewParseable` stays `true`, which is what keeps it out of the retry (gated on verdict `"unparseable"`). The round record makes the partiality visible: `reviewPartial: true` and `reviewFindingCount: <N>` alongside `verdict: "partial"`, written only for partial rounds so complete rounds' records are unchanged. An empty or whitespace-only stream is NOT partial — there is nothing to carry, so it stays the existing `unparseable` state (and keeps its retry).

**Unparseable-output retry**: when the review response contains neither parseable JSON nor a recoverable `VERDICT:` token, `runReviewPhase` re-dispatches the review job exactly once within the same round, with identical options (same prompt, tiers, agent, tools, timeouts) — but only when the first job actually completed (`job.status === "completed"`). A hard failure (stalled / timeout / serve-dead / provider-error) returns empty or garbage output; it never triggers a retry and escalates after a single attempt, exactly as before the retry existed — re-dispatching would double worst-case latency (2 × watchdog 900s / timeout 1800s) in exactly the degraded environments where it is known-futile. The retry does not consume a round, and the round record keeps both jobs traceable (`reviewFirstJobId` for the first attempt, `reviewFirstUsage` / `reviewFirstFallbacks` for the first attempt's spend and fallback trail, all other `review*` fields from the final attempt, `reviewUnparseableRetried: true`). Chain totals include the first attempt's usage, so retried rounds report their true cost; time-window stats (`chain-stats`) and the metrics DB round rows (`chain-ingest`) fold it in as well. A verdict recovered from a `VERDICT:` token never triggers the retry; two consecutive unparseable results escalate exactly as before. Nor does a `partial` JSONL stream (kusabi #202, above): that output was READ, so it is not an unparseable result at all — it escalates with its findings on the first attempt. The retry's scope is unchanged by JSONL: output we could not read, from a job that completed.

Reviewer (kusabi-review) permissions:
- **allow**: `sunaba_verify_in_container`, `sunaba_lint_in_container`, `sunaba_type_check_in_container` — independently re-runs the implementer's "gate green" claim to verify it (PR#37/#40)
- **deny**: all mutation tools (sandbox_exec, write_file, edit_file, checkout, publish, etc.) — because if the reviewer starts fixing, independence is lost
- **deny**: `sunaba_sandbox_issue_write` and `sunaba_sandbox_pr_review_write` — outward writes are the orchestrator's exclusive exit; the reviewer's deliverable is the structured final report, not issue comments or PR reviews
- The chain review prompt is augmented with machine-collected base facts (`baseSha`, recent base history, actual change set from `git status --porcelain`) so the reviewer receives "what is this task's change set" as data rather than guessing. See `renderBaseFacts` in `render.mjs`.
- **The container review input names the base; it does not carry the diff** (kusabi #208). The two container routes — the chain's review phase and `task --phase review --container <cid>` — render one shared block, `renderContainerReviewInput` in `render.mjs` (review target + base facts + an explicit instruction to fetch the diff with `diff_in_container` against `baseSha`). The diff body used to be inlined here (#204), captured by a single default-paged `sandbox_exec`: across 91 live review prompts not one carried more than 50 diff lines, while 91% of review jobs called `diff_in_container` themselves anyway — the inlined copy was a truncated duplicate of a paginated tool the reviewer was already using. What the reviewer genuinely cannot determine is the reference point, so that is what the block states, along with whose job the fetch is. On the task route `--base <ref>` selects that reference point (resolved to a sha and named in the fetch instruction) and is rejected loudly anywhere else on `task` rather than silently dropped. Every capture that remains (base log, change-set file list, untracked list) is labelled when it was cut, using what `sandbox_exec` reports about its own paging (`truncated` / `has_more`, with `total_lines`) rather than a line count. The standalone `review` subcommand (host worktree, via `buildReviewInput`) is a different input shape and still inlines its diff.

Verdict: 4-value + optional `unverified`:

| verdict | Meaning |
|---|---|
| `approve` | All acceptance criteria verifiable and passing |
| `approve-partial` | Some criteria could not be verified. Listed in `unverified` |
| `needs-attention` | Fixable defects found |
| `discard` | Premise or policy is wrong. `discard_reason` required (`wrong_premise` / `needs_stronger_model`) |

Those four are the schema's enum — what the reviewer may decide. Two further
values reach `deriveDisposition` from the parser and are NOT reviewer
decisions: `partial` (JSONL stream with findings but no verdict line, kusabi
#202) and `unparseable` (no JSON and no recoverable token). Both escalate;
neither is an alias of a schema verdict, and neither changes what `approve` /
`approve-partial` / `needs-attention` / `discard` mean.

Each finding may carry an optional `kind` tag (`mechanical` | `design`,
kusabi #60 step 1): `mechanical` means the fix is prescribed by the finding
itself (rename, registration, message fix, dead code removal); `design` means
fixing it requires a decision the finding does not itself make.  The tag is
optional in the schema — old records and lenient recovery parses stay valid —
and a missing/invalid `kind` is treated as `design` at the consumption point.
The rework brief groups findings by kind: design findings FIRST, explicitly
flagged as requiring deliberate individual treatment, mechanical findings
after, as a checklist.  The reviewer prompt instructs: when unsure, use
`design`.  Rework rounds are then SCHEDULED by kind (§3.5.5a): mechanical
findings are cleaned up first in free rounds that do not consume the round
budget, and design findings are taken one per budget round.

#### 3.5.4 Derive disposition (deriveDisposition)

Pure function `deriveDisposition({verdict, probesGreen, round, maxRounds, repeatedAreas, findingSeverities, strategizeEligible})` in `plugins/kusabi/scripts/disposition.mjs`:

| verdict | probesGreen | Condition | disposition | Meaning |
|---|---|---|---|---|---|
| approve | true | — | **accept** | Conclude, hand to orchestrator |
| approve | false | repeatedAreas=false | rework | Probe failure |
| approve | false | repeatedAreas=true + strategizeAllowed | **strategize** | Stalled despite approve: structural re-diagnosis before next rework (`docs/DESIGN.md` §9.1) |
| approve | false | repeatedAreas=true otherwise | **escalate** | Stalled with no strategize available; reason also notes max-rounds exhaustion when it applies |
| approve-partial | — | — | **escalate** | Unverified items remain, orchestrator decides |
| needs-attention | true | all findings low/medium (no critical/high) | **accept-with-followup** | Economic cutoff: see Decision 5 (`docs/DESIGN.md` §9.2) |
| needs-attention | — | repeatedAreas=false | rework | Fix and re-review |
| needs-attention | — | repeatedAreas=true + strategizeAllowed | **strategize** | First stall: structural re-diagnosis before next rework (`docs/DESIGN.md` §9.1) |
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

**Anchoring-override rows** (kusabi #62), FIRST rework only — session
continuity is the wrong lever when the finished round's evidence shows the
worker is anchored to a false claim.  The tier stays (no new escalation is
introduced by the override); only the session lever moves:

| rework | trigger condition                              | tier  | session  |
|--------|------------------------------------------------|-------|----------|
| 1st    | reviewer verdict `approve` while `probesGreen` was false (machine-refuted success claim) | same | **new** |
| 1st    | `repeatedAreas` (same file area flagged across rounds) — defensive guard, presently unreachable: `deriveDisposition` yields `rework` only when `repeatedAreas` is false, so this row becomes live only if the disposition table changes | same | **new** |

Artifacts are always carried over — the chain never rolls the worktree back.
`checkpoint_restore` has been removed from the chain (issue #114). A new session
starts fresh on the existing worktree.

Evidence inputs to `deriveReworkStrategy`:
- `reworkCount` (0-indexed: 0 = first rework)
- `strategized` — whether a strategize has occurred
- `verdict` / `probesGreen` — the finished round's review verdict and
  deterministic-probe result (feeding the anchoring override; the override
  fires when `verdict === "approve"` and `probesGreen === false`, and the
  recorded `reworkStrategyReason` names the trigger)
- `repeatedAreas` — same file area flagged across rounds (also forces a new
  session on the 1st rework; the lever must not depend on the scheduling
  accident that repetition normally implies a later rework)

The function returns:
- `tierDelta` — how many tiers to advance (0 = same tier)
- `newSession` — whether to start a fresh session
- `reason` — human-readable explanation of the decision

**Review parsing** tries the JSONL wire format first, then the single-object path, and distinguishes parseable from unparseable output:
0. `parseReviewJsonl` (§3.5.3, kusabi #202): if any line is a JSON object carrying a known `type`, the output is JSONL — the records are assembled into the review shape, non-JSON lines ignored, and a stream with no `verdict` record recorded as `verdict: "partial"` with `reviewParseable: true`, `reviewPartial: true` and `reviewFindingCount: <N>`. Anything else (prose, a single JSON object, an empty stream) returns null and falls through to the steps below, which are unchanged.
1. First stripping a trailing `VERDICT:` token (standard location after the fence)
2. If extractJson still fails, calling `recoverVerdictFromText` to find the token anywhere in the text, stripping it globally, and re-parsing
3. If even that fails, recording `reviewParseable: false` on the round record with verdict `"unparseable"` — a state distinct from `needs-attention`

The shared function `recoverVerdictFromText` in `render.mjs` powers both the display layer (`renderReview`) and the decision layer (`runReviewPhase`), avoiding duplication.

#### 3.5.5a Rework scheduling by finding kind (kusabi #60 step 2) — implemented

Step 1 grouped findings by `kind` in the rework brief; step 2 schedules the rework rounds themselves so a design finding does not drown among mechanical ones and mechanical cleanup rounds do not eat the design budget.

**Single decision point.** Pure function `resolveReworkScope(previousRecord)` in `chain-phases.mjs` maps the previous round's findings to the next round's scope, returning `{ scope, findings }`:

| previous round's findings | scope | findings subset |
|---|---|---|
| none (probe-failure rework, old records) | `full` | `[]` — whole prior findingsText, unchanged behavior |
| both kinds present (missing/invalid `kind` = design) | `mechanical` | the mechanical findings only |
| all design, length > 1 | `design` | `[first]` — one design finding per round, array order |
| all design, length == 1 | `design` | the single finding |
| all mechanical | `mechanical` | all findings |

**State address.** `roundRecord.reworkScope` records the scope the round was RUN with (`"full"` when not a scoped rework; old records without the field count as full). Nothing else is stored — budget is never persisted, it is DERIVED by counting records whose `reworkScope !== "mechanical"`, so chain-resume's records replay needs no new state.

**Budget invariant.** `maxRounds` buys design/full rounds only; mechanical rounds are free. The loop continues while budget-used < `maxRounds`, except for the hard cap: total rounds ≤ 2 × `maxRounds` terminates unconditionally through the existing max-rounds escalate path (a chain never runs unbounded; every mechanical round is bought by the design/full round that preceded it). `deriveDisposition` receives the budget-adjusted round ordinal (`round` = the current round's position within the budget; mechanical rounds do not advance it) with `maxRounds` unchanged, so its `round >= maxRounds` terminal fires on budget, not raw round count. `deriveDisposition` itself is unchanged. The budget check sits after the review-resume branch so an interrupted round that already spent its last budget slot is still allowed to finish its review.

**Resume gate mirrors the budget.** `resolveChainResume` refuses implement-resume only when the derived budget is spent (non-mechanical records ≥ `maxRounds`) or the hard cap would be exceeded (`nextRound > 2 × maxRounds`) — never on the raw round count alone, so a mechanical-tail chain whose round number legitimately exceeds `maxRounds` stays resumable. Records without a `reworkScope` field predate the scheduling change; for such chains the round number IS the budget (every round was full), so the legacy guard (`nextRound > maxRounds`) applies unchanged.

**Max-rounds terminal records actual rounds.** When the loop ends on the budget/hard-cap terminal (rather than a `deriveDisposition` escalation), `finalizeChainControl` and the review record carry the ACTUAL number of completed rounds (`records.length`) — never the nominal `maxRounds` — so `control.round` and "Final disposition: max-rounds at round N of M" agree with the persisted `round-N.json` files even when mechanical rounds pushed the raw count past `maxRounds`.

**Scoped implement brief.** When the scope is not `"full"`, `buildImplementText` renders the scoped subset with the existing grouped one-line renderer (`renderGroupedFindingsText`, the same renderer used for `findingsText`), prefixed by one sentence naming the scope — "This round resolves ONLY the following mechanical checklist / ONLY the following design finding; other known findings are deliberately out of scope this round." The full-scope path is byte-identical to the pre-scheduling text (pinned by a test).

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

**Serve lifecycle.** The serve for a state dir is owned by `serve-lifecycle.mjs` (`ensureServer`): a recorded serve whose `server.json` answers a health probe is reused; otherwise one is started on demand, serialised per state dir by an atomic `serve.lock` so concurrent callers end up with exactly one live serve. Nothing runs 24/7. The chain stops its serve itself: `runChainDriver`'s finally block runs `serve-stop` for the cwd when the chain finishes, unless `--keep-serve` was passed or another job is still running (`liveRunningJobs` — the same fossil rule as `serve-stop`). Idle reaping happens on every companion invocation: a startup sweep (`main()`) calls `reapIdleServes(root, ttl)` — a serve with no fresh `running` job whose last activity (max of `server.json` mtime and its jobs' mtimes) is older than `KUSABI_SERVE_TTL_MS` (30 min by default) is killed — and `reapOrphanedServes`, which kills live serve processes carrying the `KUSABI_WORKER_CONTEXT`/`KUSABI_SERVE_STATE_DIR` markers that no `server.json` names. Both are best-effort: per-directory errors are caught and never crash the invoking command.

**Review record (`review-record.md`)** (kusabi #52). When a chain reaches a terminal disposition — accepted (incl. accept-with-followup), or terminated by escalate / max-rounds — the shared finalisation point inside `runChainDriver` (the same code path for `chain` and `chain-resume`) renders the chain's outcome through `renderReviewRecord` (`plugins/kusabi/scripts/render.mjs`, a pure renderer that never throws on partial records) and writes it to the chain's state directory as `chains/<chainId>/review-record.md`; the chain's terminal output prints the record's path. Cancelled and failed (provider-exhausted) chains get no record — nothing was decided. The record is regenerated (overwritten) whenever a resumed chain later completes. The two "fill at inspection" sections — the findings adjudication table (採否/理由 columns) and the 判例として precedent slot — are deliberately generated blank (`_fill_`) for the orchestrator to complete by hand. Posting the record to the archive repository (kairanban) is orchestrator-exclusive by the same exit principle as publish: the companion only writes the local file and prints its path, and never posts anywhere.

#### 3.5.7a `cancel` — stopping a standalone job (kusabi #209)

`cancel` acts on ONE job record (the standalone `task` path has no chain and no `control.json`; the chain-level lever is `chain-cancel`, above). Its contract is that its output and its exit code describe what was **observed**, never what was attempted — the #209 incident was a claude-backend job that printed `cancelled job-…` while the process kept writing files into the container for another 17 minutes, and an operator told the job stopped goes on to reuse the container.

**What the job record carries.** A claude-backend job record gains `process: { pid, startTime, recordedAt }`, written by `claudeDispatch` the instant the child exists (`runClaudeProcess`'s `onStart`) and before it can do any work. `pid` alone is not a kill target: pids are recycled, and a record can outlive its process by days (measured: a pid recorded 8 days earlier had been reused as an unrelated process's thread id, and signalling it took down a live server for 22 minutes). `startTime` is field 22 of `/proc/<pid>/stat` — assigned once at fork, never changed by `exec`, never inherited, and reported per-thread for a TID — so re-reading it immediately before signalling proves the live pid is still the recorded process. Recording is best-effort in one direction only: a failed write degrades the stop lever, never the dispatch.

**What `cancel` guarantees, per backend:**

| Backend | Lever | Guarantee |
|---|---|---|
| `claude` | `SIGKILL` to the recorded process **group** (`kill(-pid)`) — the child is spawned detached, so it leads its own group and its children (sunaba MCP server, tool commands) die with it | Signalled only after the identity token re-verifies; the group is then polled until empty (bounded, `KUSABI_CANCEL_KILL_WAIT_MS`, 5 s default), because `kill()` returning means the signal was delivered, not that anything died. No `/session/<id>/abort` is ever issued — the record's `sessionID` is `null` by construction until the CLI returns one |
| `opencode` | `POST /session/<id>/abort` on the serve | The request's failure is surfaced, not swallowed. An unhealthy serve means nothing is executing the session, so the record is finalised with that said out loud |

**Outcomes.** Stopped-and-gone, and already-gone (including a pid whose identity no longer matches — that process is not this job's, so this job's process is gone; and the `#175`/`#176` fossil record) both finalise the record to `cancelled` and exit 0. Everything else — a group that survived the kill, a pid that cannot be verified, a record naming no process, a failed abort — leaves the record `running`, names the pid, never prints the word `cancelled`, and **exits nonzero**. That exit code is why a subcommand may now return `{ text, exitCode }` instead of a string (`commandOutcome`): printing a failure while exiting 0 is the same false confirmation in a different channel.

### 3.5.8 metrics store (ingest) — implemented

`metrics-db.mjs`, `transcript-ingest.mjs`, `chain-ingest.mjs`. A durable SQLite digest of two perishable/durable data sources, feeding the token-efficiency work (#83) and brief/outcome correlation work (#81). **Ingest + store only** — the write side lives here; the query/report surface it was built to feed is delivered and documented in §3.5.9.

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
- **`backend` is stored verbatim, never defaulted or normalised.** Job records and chain round records carry `backend: "opencode" | "claude"` (kusabi #184); the `job`, `round`, and `chain` tables each store it as a plain `backend TEXT` column, exactly as recorded — a record without the field stores SQL `NULL`, never a default. The chain row reads its backend from the LAST record of the `records` array (the chain record itself has no top-level field; `chain-resume` reads the same place) — a rule kusabi #195 generalises to the union of every known phase backend (next bullet). The store preserves facts; readers apply contracts: the report treats `NULL` as `"opencode"` (records predating the split), never as unknown. `openMetricsDb` migrates pre-split database files (`ALTER TABLE ... ADD COLUMN backend TEXT` when missing) for all three tables; old rows keep `NULL` — no backfill, since NULL *is* the correct reading.
- **Backend is a PER-PHASE fact, and the schema says so** (kusabi #195, after #192 made implement and review backends independent). The `round` table carries `review_backend TEXT` alongside `backend`: `backend` is the backend the round's *implement* job actually used (round 1 the implement backend, a rework round the rework backend — each round's own field is already truthful), `review_backend` the backend its *review* job used, both verbatim from the round record's `backend` / `reviewBackend`. A record written before `reviewBackend` existed stores `NULL`, never a copy of `backend` — "unknown" and "the same as implement" are different facts. `openMetricsDb` migrates it in with the same `ensureColumn` pattern; old rows keep `NULL`. The chain row's backend is the UNION of every known phase backend across the records — `NULL` when nothing is known, the one known value when they all agree, `"mixed"` when they don't — and the report reads it verbatim. `"mixed"` covers both shapes that defeat a single chain-level value: one round whose implement and review ran on different backends (the #192 per-phase shape), and a chain that switched backends between rounds; filing either under whichever backend ran last puts that chain's whole spend and outcome on the wrong side of the by-backend split. The chain-resume last-record convention and the union rule agree for every chain that never changed backend; where they part company, ingest labels (§3.5.9). Chains with no backend facts at all are unaffected: `NULL`, read as `"opencode"`. One honest caveat: stores INGESTED BEFORE #195 keep the old last-record value — where a chain had mixed or switched, that label is stale, and the read-only report surface cannot recover it (the union was only computable where the records were in hand); the fix is re-ingesting the chain directory (the ingest path is writable and idempotent, though skip-if-unchanged is keyed on chain.json size+mtime, so an unchanged file is only re-read once touched or its `source_file` rows cleared).

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

**Brief vs outcome (`docs/DESIGN.md` §7, issue #81) is raw counts only, always stratified by `orch_model`.** No rates, no percentages, no totals row across models, no correlation, no regression, no normalisation — orchestrator model is perfectly confounded with calendar date in the recorded history (and both with kusabi's own maturity at the time), so any number computed across strata is a wrong number that looks right (same confounder documented in §3.5.8). Final disposition uses the identical definition `chain-stats.mjs` already uses — the disposition of the round with `round = MAX(round)` for that chain — so the two surfaces cannot disagree about what "final" means; `chain-stats.mjs` itself is untouched (not merged, not refactored, not sharing helpers) since it answers a different question (live chain files, not the durable store). Chains with zero rounds are counted in a `chains with no rounds: N` line rather than silently dropped from the table. `## Deliverables` presence is reported for completeness even though it has no discriminating power in the corpus measured so far (present in every brief) — the report says so explicitly rather than implying it is a signal.

**Empty store / empty window are states, not errors.** A missing db file, a db with every table empty, and a window that matches no rows all exit 0. A missing file is never created to check it — `fs.existsSync` is checked before any open, since a read-only `DatabaseSync` open of a nonexistent path throws. The freshness header (whole-store `MAX()`s over `source_file.ingested_at`, `turn.ts`, `round.started_at`, `chain.orch_date`, `job.started_at`, plus `COUNT(*) FROM source_file`) is always computed before and independently of any window filter, and is always the first thing printed — a window that happens to exclude the newest data must not make the store look more or less fresh than it is. `--json` mirrors every case (`status`: `"ok"` | `"missing"` | `"empty"` | `"empty_window"`) as a valid document with empty arrays rather than an absent one, and never coerces a null sum to `0`.

**Delegated jobs (#154).** A `task`/`review` single-shot delegation writes `<stateRoot>/<slug>/jobs/job-<id>/{job.json,usage.json}` and creates no chain record — until #154, `metrics-ingest` read only transcripts and chains, so every delegated job was invisible to the store (measured on 2026-08-01: 9 jobs producing 8 of 12 shipped PRs, none in the report). The store now has a `job` table (`metrics-db.mjs`, `upsertJob`) fed by `ingestJobDirectory` in `chain-ingest.mjs` (same walker shape as `ingestChainDirectory`, one directory over), wired into `metrics-ingest` inside the same transaction and reported with its own counter block (`jobs scanned / skipped (unchanged) / ingested`, I/O and parse failures, `jobs without usage.json`) so "no jobs on disk" is a visible zero, not a silent absence. The report gains a **`Delegated jobs` section** — deliberately separate from `Orchestrator vs worker, per chain`, which is per-chain by construction (rounds, dispositions, the prefix join); grafting chain-less records onto it would distort both halves. Job rows never appear in, or dilute, any chain section, and chain statistics are byte-identical with and without jobs in the store (asserted in `metrics-report.test.mjs`).

- **A job is two files written at different times**, and the skip-if-unchanged source key is the PAIR: `job.json`'s size+mtime plus `usage.json`'s size+mtime when it exists, or its recorded absence (no `source_file` row) when it does not. `job.json` exists from job start; `usage.json` appears only at the end. Keying on `job.json` alone would mean a job ingested while running is never re-read once its usage lands; keying on `usage.json` alone would mean a job that died before writing usage is never ingested at all. With the pair, a running job ingests immediately, the later appearance of `usage.json` forces a re-read, and a fully-ingested unchanged job is skipped like any unchanged chain file (asserted by an ingest→usage-lands→re-ingest test in `chain-ingest.test.mjs`).
- **Absent usage is not measured-zero usage.** `job.usage_available` is three-valued: SQL `NULL` = no `usage.json` on disk (the job died/was cancelled before usage was persisted — the job-side analogue of the "chains that died without writing chain.json" counter, and exactly the jobs worth seeing), `0` = `usage.json` exists but says `available: false`, `1` = measured. `usage.json`'s numeric fields are not guaranteed present even when available; each is guarded field-by-field.
- **`cost: 0` is a real measurement** — every free-tier job costs 0 — and is stored as 0 and rendered `0.00`, never collapsed into `NULL`/`n/a`. Job cost is the provider-reported figure, NOT the relative units used in the transcript sections, and the report says so inline.
- **Outcome is not a status string.** The observed status vocabulary is `completed` / `provider-error` / `error` / `cancelled`, stored and counted verbatim with no enum, so an unknown future status survives to the report. A `completed` job can still be a failure (a quota death has been observed as `completed` with 79 output tokens), so the section reports the measured quantities per job — steps, output, reasoning, cost, duration — alongside the status, and warns the reader in as many words.
- **Windowing** uses the job's start instant (`started_ms`, falling back to `finished_ms`), honouring `--since`/`--until` exactly like the other sections; undated jobs are excluded under a bound and counted in the `excluded (no timestamp)` line.
- **A pre-#154 store file has no `job` table**, and this surface opens read-only and can never migrate it — the report checks `sqlite_master` and renders zero jobs instead of crashing; the next `metrics-ingest` (writable open) creates the table via the ordinary `CREATE TABLE IF NOT EXISTS` path.
- **Not built, on purpose:** no cross-machine aggregation (jobs also exist on a second machine; `--state-root` already points the ingest elsewhere, and merging stores is a separate decision), no machine identifier column, no change to what `task` writes (`job.json`/`usage.json` are read as-is), and `--compare` remains unsupported on this surface.

**By-backend split (kusabi #184, per-phase attribution #195).** The report carries a `byBackend` section splitting the in-window rows by dispatch backend: chains (count, final-disposition counts, rounds per chain, cost) and jobs (count, cost). Both key on the stored `backend` column read verbatim — `row.backend ?? "opencode"`, the same grouping idiom as the by-model sections — with `"mixed"` arriving as a stored value from ingest (§3.5.8): the report never re-derives mixedness, because the union was only computable where the records were in hand. The NULL-means-opencode contract is the same one `--resume-last` / `chain-resume` use (a row whose `backend` is NULL predates the split and is a pre-split opencode record, so counting it as opencode is faithful, not a guess). The TEXT surface prints the section only when more than one backend is present in the window — a single-backend history renders byte-identically to before the split; the JSON surface always carries it. No `--backend` filter flag: slicing by backend is the grouped display itself, and a filter is a separate decision.

#### 3.5.10 chain-resume — implemented

`chain-resume <chainId>` continues a stopped chain from its persisted state. The resumption context comes entirely from the saved records — `chain.json` (brief, round records, ladder, `verifyBaseline`) and `control.json` (container) — so the only accepted flag is `--keep-serve`; any other flag is rejected rather than ignored. The CLI wrapper (`cmdChainResume` in `kusabi-companion.mjs`) validates that the recorded container still exists and is reachable (the chain's work lives in it), and refuses to start while any job of the chain is still recorded as running — a dead driver may have left a phase job dispatched but unfinished, and resuming over it would duplicate the phase. It then re-arms the control record (status `running` again, stop-request fields cleared) and hands the position to `runChainDriver` — the same driver `chain` uses.

**Resume position.** The decision is the pure `resolveChainResume` in `chain-phases.mjs`, from the LAST round record alone:

- Last record has implement done but no review/disposition (an interrupted round persisted at stop time) → resume at that round's **review** phase, continuing the persisted partial record.
- Last record is complete with disposition `rework`/`strategize` → resume at the **next round's implement** phase — a rework carries the escalated tier/reworkCount, a strategize carries the fresh-session lever from the record's `pendingReworkStrategy`.
- Terminal dispositions (`accept` / `accept-with-followup` / `escalate`) → the chain already finished; resume is refused. A still-running chain (live pid) is refused too: stop it with `chain-cancel` first.

Cross-round state (`reworkCount`, `currentTierIndex`, `strategized`, `session`, `baseSha`) is derived from the record fields, so the resumed run continues the tier ladder exactly where the original left off. `baseSha` keeps the ORIGINAL chain base — the resumed round's diff is measured against it (P1 auto-resets HEAD to it); the worktree baseline, by contrast, is re-captured at resume time (the pre-cancel baseline is not persisted).

**Shared lifecycle.** `chain-resume` goes through `runChainDriver` — the same round loop, stop predicate, serve stopping (unless `--keep-serve`), and terminal finalisation (including the review record, §3.5.7) as `chain`. The verify baseline is the one recorded at chain start, reused and never re-captured on the now-modified worktree (§3.5.2).

#### 3.5.11 claude backend — implemented (kusabi #184)

`chain` and `task` accept `--backend opencode|claude` (default `opencode`); an unknown value is a clear error with a nonzero exit. The backend is resolved ONCE at command start and recorded as `backend` on every job record and chain round record (round-N.json and the `records` array in chain.json); records without the field are treated as `"opencode"` by readers. `chain-resume` takes the backend from the last chain record — it is not a flag.

**Dispatch.** `plugins/kusabi/scripts/claude-dispatch.mjs` exports `claudeDispatch` with the same call/return contract as `dispatchWithFallback` (`{ job, resultText, stateDir }`); kusabi-companion.mjs substitutes it for the opencode dispatch when `--backend claude` (the single decision point — the chain phases stay backend-blind). It spawns the official Claude Code CLI headlessly: `claude -p --strict-mcp-config --setting-sources "" --output-format json --model <m> --allowedTools <csv> --disallowedTools <csv> --mcp-config <path> [--append-system-prompt <agent-body>] [--resume <session-id>]` (binary via `CLAUDE_BIN`, default `claude`; arg construction and result parsing are pure functions so a contract fix stays cheap). `--resume <session-id>` is appended when the dispatch receives a `session` option — a resumed session gets the SAME isolation flags (strict MCP config, allow/deny lists) as a fresh one, because resume is a transport detail, not a permission change. The **prompt is written to the child's stdin**, never argv (field-verified: `echo <prompt> | claude -p` works) — it cannot leak into `ps` output or argv-logged transcripts and is not capped by the argv limit. The one JSON object on stdout (`{ type: "result", is_error, result, session_id, usage: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }, total_cost_usd, duration_ms, num_turns }`) is mapped onto the job record: `session_id` → `sessionID`, `input_tokens` → usage `input`, `output_tokens` → `output`, `cache_creation_input_tokens` → `cacheWrite`, `cache_read_input_tokens` → `cacheRead`, `total_cost_usd` → `cost`. `prompt.md` / `result.md` / `usage.json` artifacts match the opencode path.

**v1 limits (deliberate).**

- **One model per phase.** `--model` when given, else the chain's first route; the tier ladder is not walked and there is no capacity fallback and no retry. Model syntax is a bare alias (`opus`/`sonnet`/`haiku`) or a full model id; a `:variant` suffix is rejected with an explicit error naming the limitation (never silently ignored) — for `--model` this fails at command start with a nonzero exit, before any job is dispatched.
- **Session resume.** The `session` option is honored — `--resume <session-id>` is appended to argv, so chain rework rounds, chain-resume, and `--session` / `--resume-last` continue the previous session instead of starting blank (the claude session id is a UUID the CLI returns in its JSON result; transcripts live under `~/.claude/projects/<cwd-slug>/`, and every kusabi dispatch runs with the same host cwd, so `claude -p --resume` finds them). Three session sources feed the dispatch: `task --session <id>` (explicit), `task --resume-last` (the previous same-backend task job's `sessionID` — see below), and the chain phases (a rework round passes the previous round's `sessionID`; `chain-resume` passes the last record's `sessionID`). The session id recorded on the job record ALWAYS comes from the CLI's JSON result (the single capture source) — never pre-filled from the option, so a resumed dispatch records the same id the CLI returns. The single decision point for "may this session be resumed here" is `claudeDispatch`: an opencode-shaped id (`ses_*`) throws a loud cross-backend error naming both backends before anything is spawned (opencode sessions cannot be resumed on the claude backend — transcripts live under different roots). `--resume-last` filtering is SELECTION, not validation: it picks the previous job of the SAME backend as the current dispatch (records without the `backend` field predate the backend split and count as `"opencode"`), so a claude dispatch never silently resumes an opencode session and vice versa; when no same-backend job exists the error names the backend.
- **No watchdog.** `watchdogS` is a no-op: the child is bounded only by `timeoutS`, which kills it (SIGKILL) and reports the same `timeout` status/text the opencode path uses. There is no SSE stream to measure silence against, so stall detection is not ported in v1.
- **Two permission allowlists.** implement and review, hardcoded in `claude-dispatch.mjs` mirroring the permission tables of `opencode-agents/kusabi-implement.md` and `kusabi-review.md` (the strategist dispatch — agent `kusabi-investigate` — runs the review-shaped toolset `reviewDenyTools`, so it maps to the review allowlist). Passed via `--allowedTools`; `--dangerously-skip-permissions` is never passed. The opencode `tools` deny map is applied to the allowlist so an explicit deny is never silently ignored. Agents with no v1 allowlist are a clear error.
- **Deny belt-and-braces (`--disallowedTools`).** Independently of the allowlist, a hardcoded deny list removes the tools a worker must never run even if an allowlist bug or settings leak would grant them: `mcp__sunaba__publish`, `mcp__sunaba__sandbox_pr_review_write`, `mcp__sunaba__secret_scan_override`, `mcp__sunaba__sandbox_stop`, `mcp__sunaba__sandbox_initialize`, `mcp__sunaba__copy_file`, `mcp__sunaba__copy_project`, `mcp__sunaba__run_container_and_exec`, and the CLI's own `Bash`/`Edit`/`Write`/`NotebookEdit` (a worker acts exclusively through the sunaba MCP tools). The single exception is `mcp__sunaba__sandbox_issue_write` for agent `kusabi-investigate` — its deliverable is appending the brief to the issue; for every other agent (including the strategist, whose review-shaped deny map still strips it from the allowlist) it stays denied.
- **Settings independence (`--strict-mcp-config` + `--setting-sources ""`).** The session applies ONLY the generated `--mcp-config` — no ambient settings (permissions.json, CLAUDE.md, project/user settings, other installed MCP servers) reach the worker. Field-verified: with these flags an MCP tool call without a matching `--allowedTools` entry is blocked, and the same call succeeds once the tool is allowlisted — the allowlist is the sole permission source, deny-by-default.
- **MCP.** `--mcp-config` points at a generated file containing ONLY the `sunaba` entry extracted from the host `~/.claude.json` (`mcpServers.sunaba`; source overridable via `KUSABI_CLAUDE_MCP_SOURCE`). A missing entry is a clear error naming the source path.
- **System prompt.** the opencode `agent:` name maps to `opencode-agents/<agent>.md`; the YAML frontmatter is stripped and the body passed via `--append-system-prompt`.

**Failure semantics.** Every failure mode — spawn error, nonzero exit, unparseable/garbage stdout, `is_error: true`, timeout — produces a failed job record (status `error` or `timeout`) whose `error` field carries the underlying text; the chain's existing escalate path handles it (no retry, no fallback). Config-level problems (missing MCP entry, unsupported agent, `:variant` model, missing agent file) throw, so they surface as clear errors with a nonzero exit instead of stuck `running` records.

#### 3.5.12 per-phase backend mixing — implemented (kusabi #192)

Cross-family review catches [high] findings the same-family review misses, in both directions (measured 2026-08-09): the chain must be able to run implement on one backend and review on another. This section is axis 1 of kusabi #192: **per-phase backend selection via config**. Per-round tiering (strong round 1 → cheap rework) is a separate follow-up; nothing here changes `applyTierEscalation` / `recordReworkEscalation` semantics or the default models.

**Entry-prefix syntax.** Config chain entries (`models.chain` and `models.phases.<phase>`) may carry an explicit backend prefix: an entry of the form `claude/<model>` selects the claude backend with model `<model>` — a bare alias (`opus`/`sonnet`/`haiku`) or a full claude model id (e.g. `claude-sonnet-4-5`); a `:variant` suffix stays rejected exactly as today. Any entry WITHOUT the prefix is an opencode `provider/model[:variant]` route, byte-identical to before. `claude` is not an opencode provider name, so the prefix is unambiguous. The built-in default chain remains opencode.

**Per-phase resolution.** The backend resolves per phase, not per command. `chain` resolves the implement route-chain and the review route-chain independently, each from `models.phases.<phase>` with fallback to `models.chain`, then the built-in default — the same precedence as `resolveModel` / `resolveClaudeModel`. The strategist dispatch follows the implement phase's resolution (implement dispatch + implement chain). `task --phase <p>` resolves from its own phase, as it already did — the prefix support falls out of the shared resolution path (`resolveDispatchBackend`, the single decision point: it picks the dispatch function per phase and the model syntax). On the claude backend the prefix is stripped before the model/chain reaches the dispatch; on the opencode backend entries pass through byte-identical.

**Single-backend-per-phase invariant.** One phase's chain array is single-backend: an array mixing `claude/` and opencode entries fails loudly at command start — before `createChainDir`, before any job is dispatched (same principle as kusabi #184 finding 1). The check runs on every chain a dispatch reads; it is skipped only when the chain is never consulted (explicit `--backend claude` plus `--model` pins every phase — kusabi #186's carve-out). Per-route mixed ladders within one phase array are out of scope by design.

**Flag precedence — the identifier decides (kusabi #210).** A `--model` that NAMES a backend decides the backend for the phases it pins, in the identifier syntax the config already defines. The resolution order in `resolveDispatchBackendForPhase` (the single decision point: one value picks the dispatch function, the model spelling, AND the backend the model is validated against) is:

0. a `--model` that names a backend — `claude/<model>` or `<provider>/<model>[:variant]`;
1. otherwise `--backend opencode|claude`, which forces EVERY phase onto that backend and wins over the config;
2. otherwise the phase's chain entries (`models.phases.<phase>` → `models.chain` → the built-in default), via `resolveChainBackend`.

The three `--model` forms:

| `--model` value | backend | model |
|---|---|---|
| `claude/opus`, `claude/claude-sonnet-4-5` | **claude** | `opus` / `claude-sonnet-4-5` (prefix stripped) |
| `opencode-go/deepseek-v4-pro:max` | **opencode** | provider `opencode-go`, model `deepseek-v4-pro`, variant `max` |
| `opus` (no `/` at all) | **the phase's configured backend**, unchanged | `opus` |

The bare form is load-bearing: it names no backend, so it moves nothing — `--model opus` against a claude-pinned phase behaves exactly as it did before step 0 existed, and against an opencode phase it is still rejected by `parseModel`. Only a form that NAMES a backend may move one. The grammar is deliberately asymmetric (`splitRouteBackend` reads a leading `claude/` as a BACKEND, `parseModel` reads the first segment of any other identifier as an opencode providerID) — `claude` is not an opencode provider name, so it is unambiguous.

`--backend` keeps its all-phases meaning and is not deprecated; it is merely redundant for the common case. `--backend X` with a `--model` naming backend X is consistent and proceeds; `--backend X` with a `--model` naming backend Y is a contradiction and throws at command start, naming BOTH and saying which to drop — one input never silently wins over the other. The `--backend opencode` vs claude-native-chain conflict (§3.5.12 above) still fires when there is no backend-naming `--model` to settle the question, and must NOT fire when there is one: the operator has stated their routing intent unambiguously, and re-deciding it from a config key would be the incident kusabi #210 was filed for. Under `--backend claude` a phase whose config entries are opencode-shaped still fails loudly at command start unless `--model` is given (the chain is then never read — kusabi #186's carve-out; the same carve-out applies when the identifier decided the backend). Validation follows the same decision: a `:variant` on a claude-named `--model` is rejected because the IDENTIFIER said claude, and the error says so instead of naming a config key three levels away. Config file semantics are unchanged — no new keys, no new CLI flags, and the CLI now simply accepts the strings the config format already defines. A backend-naming `--model` also reaches the dispatch in that backend's own spelling (`claude/opus` → `opus`), and when the phase's configured ladder belongs to the OTHER backend its entries are dropped rather than walked as foreign routes — the pinned route is the ladder.

**Session lineage never crosses backends.** Each phase's session lineage stays within its own backend. A rework implement round may only continue a session created by the implement backend; otherwise it starts fresh. The seam that carries `session` across rounds — `runChainDriver`'s cross-round variable and `runImplementPhase`'s `previousRecord.sessionID` fallback — both check the session's record `backend` (missing field = "opencode") against the implement backend and drop foreign sessions. The existing `ses_*` guard in `claudeDispatch` and the backend filter in `resolveResumeLastSession` stay intact.

**Records stay truthful.** Round records keep `backend` = the implement job's backend (as today) and gain `reviewBackend` = the review job's backend (always set; readers treat a missing field as the record's implement backend). Job records already carry their own backend — unchanged. `chain.json` additionally persists `reviewModel` / `reviewModelChain` (the review phase's resolved model and route chain) so `chain-resume` re-dispatches review on the same backend/model it originally ran on; `chain-resume` reads the review backend from the last record's `reviewBackend` (falling back to its `backend` on pre-#192 records) and the implement backend from its `backend` as before. The metrics ingest (kusabi #195) stores `reviewBackend` verbatim per round in `round.review_backend` — NULL on records written before the field existed, never a copy of `backend`, since "unknown" and "the same as implement" are different facts — and labels the chain `"mixed"` whenever its known phase backends disagree (§3.5.8); the report reads the label verbatim (§3.5.9).

**Review dispatch never crosses backends.** `runChainDriver`'s review-dispatch fallback is backend-aware (`resolveReviewDispatch`): an explicit review seam wins; otherwise the implement dispatch is reused ONLY for a same-backend review (the pre-#192 single-dispatch contract), and a differing review backend gets the canonical dispatch of ITS backend — never the other backend's dispatch. `chain-resume` additionally passes an ALWAYS-explicit review seam (`resolveResumeDispatches`): an opencode review resumes on the plain opencode dispatch, a claude review on the clamped claude dispatch pinned to the recorded `reviewModel`. (Bug fixed: chain-resume of a mixed chain used to pass an undefined review seam, the driver fell back to the claude implement dispatch, and the review job silently ran on the claude CLI with the implement's model while the record claimed `reviewBackend=opencode`.)

#### 3.5.13 per-round rework tiering — implemented (kusabi #192 axis 2)

Measured motivation (2026-08-09): a strong model's round-1 skeleton was one-shot green where a cheap model took three rounds, while cheap rework on a good skeleton was small. Axis 2 of kusabi #192 therefore tiers the implement phase **per round**: one strong round-1 model, cheap rework rounds after it. One new config key, no new CLI flags.

**The key.** `models.phases.rework` — when present, implement rounds AFTER round 1 (rework rounds) resolve their dispatch / model / chain from it with the exact same machinery as any other phase: `claude/` entry prefixes, the single-backend-per-phase invariant, `:variant` rejection on the claude backend, and the explicit `--backend` flag forcing it like every other phase (a conflict with a claude-native rework chain throws at startup, same rule as §3.5.12). Round 1 keeps the `implement` resolution. **Fallback precedence for the key itself**: `models.phases.rework` → the implement resolution — NOT `models.chain` directly. Key absence must mean “byte-identical to today”: rework rounds continue on the implement chain and its ladder.

**Ladder semantics with the key present.** Rework rounds run the existing tier ladder OVER the rework chain: the first rework starts at the rework chain's tier 0, and `recordReworkEscalation` climbs within that chain exactly as it always climbed within the implement chain. `applyTierEscalation` / `recordReworkEscalation` decision logic is unchanged — only which chain the tier index addresses changes. `currentTierIndex` addresses the implement chain during round 1 and the rework chain from round 2 on; chain-resume restores it from `tierAfter` / `tierBefore`, which were recorded against the same chain the resumed round re-dispatches on.

**Records stay truthful per round.** Each round record's `backend` / model fields reflect the backend and route that round's implement job ACTUALLY used: round 1 = implement resolution, rework rounds = rework resolution. `reviewBackend` is unchanged.

**Session lineage extends per round (axis-1 invariant 5).** The lineage guard in `runImplementPhase` compares `previousRecord.backend` against the CURRENT round's backend; rework rounds pass the rework phase's backend, so the switch falls out: same-backend rework continues the session, cross-backend rework starts fresh (findings still reach it via the rework brief).

**Resume / persistence symmetry** (learned from the axis-1 findings — the persistence and exhaustion paths must not diverge). `chain.json` gains `reworkModel` / `reworkModelChain` / `reworkBackend`, persisted by `persistChainState` AND `handleProviderExhaustion` symmetrically. chain-resume resolves them with the key-absence-is-legacy rule (mirror of `resolveResumeReviewContext`): absent keys fall back to the implement values; persisted null stays null (no rework key at chain start). Rework rounds re-dispatch on the rework backend/model, with the rework seam always explicit — a claude rework backend resumes clamped to the recorded rework model, an opencode rework backend on the plain opencode dispatch (never the other backend's implement dispatch).

**Strategist unchanged.** The strategist keeps following the implement resolution.

**Chain-start banner.** The banner (`tiers=N, maxRounds=M …`) must not lie when a rework chain is configured: it prints both counts (`tiers=N, reworkTiers=P`) and computes the “can reach top tier” claim against the chain the ladder actually climbs (the rework chain's count when configured, the implement chain's otherwise). Tier counts are backend-aware: a claude-native chain counts as ONE tier (min(1, length)) in the banner and in the escalation records — `claudeDispatch` pins every phase to the command-start model, so its ladder never climbs and `tierAfter` can never exceed 0 on a claude ladder.

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
parameter honours wildcard keys (`docs/DESIGN.md` §7 documents only the
per-name `{name: false}` deny contract, confirmed via live A/B testing on
1.18.3).
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

### 3.8 Skills (opencode Agent Skills)

**What they are for.** Agent Skills (`SKILL.md` + YAML frontmatter, loaded on
demand through opencode's built-in `skill` tool) carry occasional, long-form
worker knowledge — deep procedure that is only relevant to a narrow class of
task. Keeping that text in the agent definition would load it into every
session of that phase; a skill keeps it one `skill` call away without paying
context for it in the common case. kusabi ships them under
`plugins/kusabi/opencode-skills/<name>/SKILL.md`.

**Distribution path.** `install-agents` copies agents and skills in one pass:
agents to `OPENCODE_AGENT_DIR` and every directory under `opencode-skills/` —
whole directory, keeping its own name — to `OPENCODE_SKILL_DIR`, creating the
destination when missing. Both defaults are derived from opencode's own config
dir (`$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`) rather than a
hardcoded `~/.config`, so the default destination stays a discovery path on
hosts that relocated their config. Known gap: if opencode also honours
`OPENCODE_CONFIG_DIR` for relocation, `install-agents` does not follow that
one — set `OPENCODE_SKILL_DIR` explicitly on such a host. A skill is only *reachable*, never implicitly
loaded; discovery is opencode's job. Whether a phase can actually pull it is
decided by the agent's permission map: every kusabi agent opens with
`"*": deny` (last matching rule wins), so a skill is unreachable until the
`skill` tool is granted explicitly. Currently only the implement phase
grants it, and only for `kusabi-*` names.

**Two invariants.**
1. **Skills grant nothing.** A skill is a document; it carries no
   `permission:` key and cannot grant or deny tools. The agent allowlist is
   the only thing that decides what tools exist.
2. **The destination is never pruned, and a collision never fails the
   install.** `install-agents` copies and overwrites skills only — it never
   deletes anything under `OPENCODE_SKILL_DIR`, because that directory is
   shared with skills the user installed themselves and there is no
   kusabi-owned name registry that would make deletion safe. (Contrast the
   agent path, which deletes a fixed, explicit list of legacy `oc-*` names.)
   A name collision with a non-directory (a user file squatting on a skill's
   directory name) skips that skill with a warning and leaves the file
   untouched; a destination root that is not a directory fails with a clear
   error *before* any mutation.

**Runtime verification status (opencode 1.18.15, source-verified against the
release commit `d7b115f`).** The mechanism is confirmed from opencode's own
source, not just from docs:

- **Discovery.** `~/.config/opencode/skills/<name>/SKILL.md` is a real scan
  path: the config layer returns `Global.Path.config` (`$XDG_CONFIG_HOME` /
  `~/.config` + `opencode`, relocatable via `OPENCODE_CONFIG_DIR`) as a
  config directory, and the skill loader scans `{skill,skills}/**/SKILL.md`
  under each (`packages/opencode/src/config/paths.ts`,
  `packages/opencode/src/skill/index.ts`). The same scan covers the project's
  `.opencode/skills` and the Claude/Agent-compatible `~/.claude/skills` /
  `~/.agents/skills`, plus config-file `skills.paths` / `skills.urls`.
- **`OPENCODE_SKILL_DIR` is a placement override, not a discovery path.**
  opencode 1.18.15 does not read that env var anywhere (zero occurrences in
  the release source), and the same holds for the pre-existing
  `OPENCODE_AGENT_DIR`: both knobs only tell `install-agents` where to copy.
  Setting `OPENCODE_SKILL_DIR` lands the skill outside opencode's scan, so it
  must never be reported as discovered; the runtime-verified discovery path
  is the default `~/.config/opencode/skills` (or the relocated config dir via
  `XDG_CONFIG_HOME` / `OPENCODE_CONFIG_DIR`).
- **Permission.** `permission.skill` accepts an action or a
  pattern→action object; object entries become per-pattern rules in map
  order, and `evaluate` picks the **last matching rule** (`findLast`), so
  `"*": deny` first + `skill: {"kusabi-*": allow}` allows exactly
  `kusabi-*` skill names and denies everything else
  (`packages/opencode/src/permission/index.ts`). The implement agent is the
  only kusabi agent with a `skill` rule; for agents without one the skill
  tool is hidden entirely (`visibleTools`). Permitted skills are listed for
  the agent (`Skill.available` filters to non-deny), and the tool call
  itself is re-gated through the same rules (`ctx.ask("skill", <name>)`).
- **Still unverified: the skill being actually pulled in a real job.** The
  chain above is mechanism; "a worker really loaded it" is behavior and
  needs a live session on the host (issue #179 acceptance criterion 4).
  Pending that probe, criterion 2 of the experiment brief is met as config
  + mechanism, not as observed runtime behavior. Host probe procedure:
  1. `node plugins/kusabi/scripts/kusabi-companion.mjs install-agents`
     (no env overrides — default destination).
  2. Confirm the skill is listed in the implement session's system prompt
     (it is rendered by the `skill` tool as "Available Skills") or invoke
     `skill` with name `kusabi-rust-cross-target-checks` in a session whose
     task touches `#[cfg]`-gated Rust.
  3. Confirm a non-`kusabi-*` skill name is refused for the implement agent.
  4. Record the outcome on issue #179 before closing the experiment.

