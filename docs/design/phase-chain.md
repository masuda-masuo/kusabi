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
| test-author | Write acceptance tests before implementation (#408) — frozen oracle producer | ✕ | ○ (tests only) | ✕ |
| plan | Read-only implementation plan (#409) — approach check, no writes | ✕ | ✕ | ✕ |

The gofer phase (`kusabi-gofer`, added in #64) is a cheap evidence-collector: it runs commands via `sunaba_sandbox_exec`, reads files/logs, and reports verbatim excerpts with provenance. Unlike investigate, gofer never posts to issues and never forms judgments — its contract is raw evidence returned in the final report. Write tools, host bash, and shiori are denied; `sunaba_sandbox_exec`, `sunaba_run_python` (post-collection compression only — the prompt forbids using it to pre-filter exploration, #216), verify/lint/type tools, and sunaba read tools are explicitly allowed. The chain does not use gofer; it is for `task --phase gofer` invocations.

The test-author phase (`kusabi-test-author`, added in #408) is the producer half of test/implementation separation: it writes frozen acceptance tests from the brief's criteria before the implementation exists, so the implementer is judged against an oracle it did not write. Its contract forbids reading implementation internals to resolve ambiguity, forbids editing implementation files, and grants no issue write or publish — the deliverable is test files only, and each must fail at base for a behavioral reason (RED evidence quoted verbatim). The chain does not use test-author; it is for `task --phase test-author` invocations.

The plan phase (`kusabi-plan`, added in #409) is a read-only approach check: it returns an implementation plan — files to touch, where the state lives, which function decides, alternatives rejected, and open risks — in its final report, which the orchestrator pastes into a brief's `## Suggested design`. Its contract forbids any code change, diff, or file write (no edit tools, no shiori, no issue write); it is a cheap pre-implementation guard against approach errors that would otherwise surface as round-1 review findings. The chain does not use plan; it is for `task --phase plan` invocations.

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

Launched in foreground with `chain --container <cid> --model <m> [--max-rounds N] "<brief>"` or in background with `chain-detach --container <cid> --model <m> [--max-rounds N] "<brief>"`. Implementation is `cmdChain` in `plugins/kusabi/scripts/chain-cmd.mjs` and `cmdChainDetach` in `plugins/kusabi/scripts/chain-ops.mjs`.

#### 3.5.1 Round structure

Each round r (1..maxRounds, default 4) flows as follows:

1. **implement**: implement with the `kusabi-implement` agent. r=1 gets the full brief; r≥2 gets only the previous round's findings + the brief's acceptance criteria. The previous session's trial-and-error log is not carried over. The companion injects the `--container` ID into every implement prompt (mirroring the review-side injection), so briefs no longer need to carry it.
   - Every dispatch in the chain (implement, review, strategist) goes through `dispatchWithFallback`. When a dispatch ends as `provider-error`, the companion re-dispatches on the next unused route of the same tier — same round, same container, same brief. Routes that fail with a capacity reason (`free_tier_limit`) or a catalog miss (`UnknownError` whose `data.message` contains `Model not found`, kusabi #431) are remembered for the rest of the process (`terminal: true`). HTTP 401/403/429/5xx stay non-terminal (#233) and still climb within the dispatch. Fallbacks do not consume rounds. `--model` remains a pin (#361): a pinned identifier is the only candidate.
2. **Deterministic probes** (§3.5.2): non-LLM checks inside the container via sunaba-rpc.
3. **review**: adversarial review with the `kusabi-review` agent. Carries over previous round findings via `--prior`. The reviewer does not climb the round ladder: it stays on `--model` when given, otherwise on tier 0, for every round — the same route the pre-fallback implementation used. When those routes are dead it falls through to later tiers via the same `dispatchWithFallback` mechanism. Note that tier 0 is the *cheapest* tier, not the strongest; raising the reviewer's model is done with `--model`.
4. **Derive disposition** (§3.5.4): mechanically determine the disposition.

#### 3.5.2 Deterministic probes (P1–P6, non-LLM)

P1–P6 helpers (`runHeadCleanProbe`, `runVerifyProbe`, `runDeliverablesProbe`, `runSmokeProbe`, `runFrozenProbe`, `runCollectedProbe`, and `summariseOracleViolations`) live in `plugins/kusabi/scripts/chain-probes.mjs`. `runProbePhase` lives in `chain-run.mjs` (kusabi #447) and calls them. Direct container inspection via sunaba-rpc (§3.6). Does not involve the LLM:

| Probe | Content | Behavior on failure |
|---|---|---|
| **P1: HEAD clean** | Record baseSha via `git rev-parse HEAD` at chain start. After implement, if HEAD≠base, auto-execute `git reset --mixed <base>` | Auto-fix (empirical: even when the brief explicitly prohibited it, it happened 2 out of 3 times). Record in metadata |
| **P2: verify gate** | Run `verify_in_container` (no skip flags at all). At chain start, before the round-1 implement dispatch, the same verify runs once on the pristine base and records the baseline lint/type violation counts (and the raw verify JSON) on `chain.json` (`captureVerifyBaseline`). P2 compares the round's counts against that baseline so pre-existing lint/type debt (which the base itself carries) is not confused with debt the worker added. | `gate_passed=true` → PASS (unchanged fast path). Failed with **test failures** (`tests.full` present — tests actually ran) → FAIL, unchanged; the baseline never tolerates a test verdict. Failed on the **lint/type precondition** (tests never ran, `tests.status="skipped"`): current count ≤ baseline for each failed gate → re-run verify with the tolerated gates skipped (`skip_lint_gate` / `skip_type_gate`) so tests execute, and PASS iff that run's tests are green — the probe detail states the tolerance (e.g. `lint 190 (baseline 190, tolerated); tests ok`), and a failed re-run distinguishes "tests not ok" (tests ran, `tests.full` present) from "still blocked before tests" (an untolerated precondition — e.g. `patch_targets` — or an error envelope; the detail names the re-run's `gate_fail_reasons`); any count above baseline → FAIL naming the increment (e.g. `lint 193 > baseline 190`). No baseline, or no reliable count (arrays and `gate_fail_reasons` both absent) → strict FAIL with the limitation recorded. Counts come from the verify result's `lint`/`types` arrays (authoritative — complete, one element per violation), with the gate's `gate_fail_reasons` summary as fallback. chain-resume reuses the recorded baseline and never re-captures on a modified worktree. |
| **P3: deliverables** | Parse `## Deliverables` section from the brief; check that at least one declared path appears in the paths the *current round* actually changed (content-sensitive baseline comparison, not `git status --porcelain`). See "Worktree baseline" below. | Empty change set **and** a non-empty `## Deliverables` section (both conditions required by `shouldSkipReview` in `chain-review.mjs`) → review job NOT dispatched, round verdict set to `discard` with `verdictSource: "probe"` (follows the existing discard→escalate path) — unless the round's report carries a qualifying refusal block, in which case the round is a refusal, not a discard (§3.5.4a). **The discarded round also records `worktreeDirtyVsBase`** (kusabi #299): whether the change set P3 already captured (`git status --porcelain`, measured against the chain base P1 parks HEAD at) is non-empty. "This round added nothing since the baseline" and "the container is empty" are different facts, and only the first was recorded before — the motivating incident (chain-msvthdq26fdc, 2026-08-16) escalated with `chain-show` reading "reviewer discarded the work" while the intact rounds-1–2 worktree it was sitting on eventually shipped. No second change-collection mechanism and no extra container call; distinct from `worktreeChanged`, which is measured against the RUN's baseline and is false on exactly this path. `chain-show` renders the field on probe-discarded rounds (a record predating the field renders "not recorded", never a guess), and every surface that would otherwise surface the round's recorded disposition reason is re-keyed the same way through two shared describers in `render.mjs` — `roundDiscardReason` (the reason phrase) and `roundChangedColumn` (the `changed=` flag) — so no renderer keeps its own copy of the rule: the status headline (e.g. `escalated at round N (empty round discarded by probe; worktree still DIRTY vs the chain base)`), the disposition line, the terminal escalate outcome's first line (what the orchestrator actually reads on handover), the `changed=` column of every round summary (escalate / max-rounds / refusal / provider-exhausted outcomes and the postable review record — a bare NO would read "nothing is in the worktree" when the record says the worktree is dirty), and the reason persisted on the finalised chain record (`finaliseChain`) all substitute the probe-discard wording for the generic "reviewer discarded the work". Reviewer-verdict discards (`verdictSource` ≠ `"probe"`) render unchanged at every surface. When no `## Deliverables` section is declared, an empty change set still goes to review — with nothing declared there is no mechanical basis for calling an empty change set a failure, so the reviewer decides. Deliverables declared but no match → P3 fails but review still runs; `deriveDisposition` handles the rest. No `## Deliverables` section → probe trivially passes. **Heading present but zero entries parsed → P3 fails** (author is told to fix brief syntax rather than believing the check ran), and that failure is brief-reachable: it terminates the chain instead of buying a rework (see below, kusabi #303). |
| **P4: smoke** | Parse `## Smoke` section from the brief (accepted syntaxes: unordered/ordered bullets with backtick-quoted command + optional `exit <N>` annotation and/or the `baseline-red` annotation — bullet form only: a fenced code block line is the whole command and takes neither — or fenced code block with one command per line/exit 0). Each declared command is executed inside the container via `sandbox_exec`; the command's stdout/stderr is redirected to a file so that the exit-code marker (`; echo SMOKE_EXIT=$?`) is the only text returned by `sandbox_exec` and is never subject to pagination truncation. The captured output file is available for diagnostic excerpts on failure (timeout: 300s). | Any entry whose observed exit code does not match the declared expected exit (or times out / cannot be executed) → P4 fails. An exit code that cannot be observed (marker absent from `sandbox_exec` return text) is reported distinctly from a command mismatch — the probe still fails but the wording says "could not be observed" rather than "observed exit unknown". A timeout arrives as data (`status: "timeout"`, `exit_code: 124`) rather than as a raised error, and is detected as such: a timeout is an outcome of the command, so it must not be reported as the probe failing to observe. No `## Smoke` section → probe trivially passes. **Heading present but zero entries parsed → P4 fails** (author is told to fix brief syntax rather than believing the check ran), and that failure is brief-reachable: it terminates the chain instead of buying a rework (see below, kusabi #303). **Dispatch-time baseline (kusabi #292, #315):** before the worker is handed the container, the declared smoke runs on the pristine checkout, and an entry that fails there refuses the dispatch outright — the post-round P4 would otherwise convict an innocent worker a full round later. An entry annotated `baseline-red` — the smoke targets a deliverable listed in `## Deliverables` that does not exist yet — inverts exactly one verdict: a MEASURED mismatch at base passes (that red is the task itself), while a measured MATCH refuses with its own message (the annotation's claim is stale: the deliverable already exists or the brief is; the annotation is deliberately wrongable in one direction so it cannot rot silently). An unmeasurable annotated run (timeout, unobservable, never executed) is refused fail-closed — the annotation licenses a measured mismatch and nothing else. The annotation changes nothing after the round: P4's verdict on an annotated entry is the ordinary one, and the annotation licenses no dirt and no HEAD move — the #292 follow-up guards apply to every entry. |
| **P5: frozen** (kusabi #197) | Parse `## Frozen Tests` from the brief (canonical spelling; same accepted item syntaxes and same path extraction as `## Deliverables` — both go through `parsePathSection` in `brief-parsing.mjs`). Intersect the declared paths with the paths the *current round* changed — the same newly-changed set P3 computed, with the same `newlyChangedPaths ?? changedPaths` fallback, so "unknown" is never read as "nothing changed". No second change-collection mechanism exists. Matching is prefix-based in both directions: a frozen entry naming a directory matches everything under it, and a changed path naming a directory (an untracked `dir/`) matches a frozen entry inside it — the detector over-reports rather than letting a frozen file hide inside a directory entry. | Empty intersection → PASS. Non-empty → **FAIL**, detail naming every intersecting path, and the probe carries `oracleViolation: true` → the round's disposition is **escalate**, never rework (see below). No `## Frozen Tests` section → probe trivially passes. **Heading present but zero entries parsed → P5 fails** (same author-facing rule as P3/P4: fix the brief syntax rather than believing the check ran). That case does NOT set `oracleViolation` — nothing was violated; the declaration is unreadable. It is a **brief-reachable** failure and routes to the terminal `refused-brief-defect`, never to a rework (see "Brief-reachable vs worktree-reachable probe failures" below, kusabi #303); a brief carrying it is refused at dispatch in the first place (kusabi #302). |
| **P6: collected** (kusabi #197) | Compare the number of tests the round's verify actually RAN against the chain-start baseline's count. "Verify green" means "the tests that ran passed", not "the tests still exist" — the motivating incident is a dependency drift that made 273 of 607 tests uncollectable (an import failure makes tests stop existing rather than fail) while verify stayed green. Both counts come from `countVerifyCollected`: the structured `tests.full.total` of the verify result, or `passed + failed` when `total` is absent; never a substring match on free text, and never a guess. The baseline's count is recorded by `buildVerifyBaseline` as `collected` beside the lint/type counts (§3.5.2 P2) and, like them, is reused by chain-resume and never re-captured on a modified worktree. **P6 issues no verify call of its own**: P2 already ran verify this round, and its result carries the count (`runVerifyProbe` stamps `collected` on every return path, taking it from the run whose tests actually executed — the tolerated re-run when there was one). | Round ≥ baseline → PASS (detail `collected N >= baseline M`). Round < baseline → **FAIL**, detail naming both numbers (`collected 334 < baseline 607`), `oracleViolation: true` → **escalate**. Either side without a count → PASS, with the limitation stated verbatim in the detail (`collected count unavailable (baseline …, round …); P6 could not compare, so this round's test count is UNCHECKED`). An unknown is not a decrease, but the gap in coverage is never silent. A brand-new repository is the other vacuous case: its chain-start baseline is 0 (or absent on the first commit), so `round >= baseline` holds for any count and a green P6 attests nothing about tests existing (measured 2026-08-15) — on a repository's first chain the orchestrator confirms the collected count by hand at inspection and records it, so later chains have a real baseline to compare against. |

**Failure routing for P5/P6 — escalate, never rework (kusabi #197).** A P5/P6 failure sets `passed: false` (so `probesGreen` goes false) *and* `oracleViolation: true`. `runProbePhase` summarises the markers (`summariseOracleViolations`) into one string naming every violation, records it on the round record, and hands it to `deriveDisposition`, which returns `escalate` on it — taking precedence over every rework/strategize/accept row, including `accept-with-followup` and including an `approve` verdict with otherwise-green probes. The worker is never sent to "fix" a frozen-test edit or a count decrease, because the correct resolution may be "this deletion is legitimate, the human approves it" — a judgement only a human can make. Review still runs for the round (the reviewer's findings give the human the "why") unless the round was already headed to discard by `shouldSkipReview`. The one row it does not preempt is `discard`, which escalates on the reviewer's own, more informative reason. Both end in `escalate`, so there is no state where a chain can neither accept nor escalate (kusabi #173: a deterministic check with no exit dead-ends chains). The escalate outcome line renders the disposition reason verbatim, so the offending path or count reaches the operator without opening the round record.

**Brief-reachable vs worktree-reachable probe failures (kusabi #303).** A probe failure is only worth a rework round if the worker can act on it. Every probe reads one of two subjects, and the split is what decides the routing:

- **Worktree-reachable** — verify red (P2), no declared deliverable touched (P3), a smoke command whose exit code does not match (P4), a frozen-path intersection (P5), a drop in the collected count (P6). The evidence is the container's worktree, which the worker owns. These keep **exactly** today's routing: the normal disposition table, `oracleViolation` → escalate for P5/P6 included. Nothing about them changes.
- **Brief-reachable** — the "heading present but no entries parsed" failures of P3/P4/P5. The evidence is the *brief file*, which the worker cannot edit. No rework is winnable by construction: the same section parses to the same nothing next round and every round after, whatever the worker writes. At its FIRST occurrence the round is terminal, in the same family as the worker's own refusal (§3.5.4a): disposition `refused-brief-defect`, `roundOutcome: "brief-syntax-defect"`, the offending section named on the record (`briefSyntaxDefect`, e.g. `P5: frozen: ## Frozen Tests heading present but no entries parsed`), and a reason that says the defect is the brief author's, not the worker's, and that the fix is to fix the brief and re-dispatch. No rework strategy is computed (`finishRound` does that only for disposition `rework`), so the rework counter and the round budget are untouched by construction. `deriveDisposition` checks it after the worker's refusal — that block names a contradiction only a human can resolve and is the more specific statement — and before the oracle, since an unreadable declaration is not a violated one. The marker is `briefSyntaxDefectSummary(brief)` in `brief-parsing.mjs`: a function of the brief alone, so a fresh round, a review-resume reading recorded probe truth, and the accept re-validation (§3.5.4, which re-measures the worktree but never the brief) all derive the same value. `chain-show` and `chain-wait` need no new state — `refused-brief-defect` is already terminal for both — and the outcome text is rendered by `renderBriefSyntaxDefectOutcome`, which names the section rather than the worker-supplied anchors the refusal renderer prints.

The motivating incident is chain-msvwhslx6e60 (2026-08-17): a `## Frozen Tests` heading whose body was the prose `(none frozen by name — …)`. P5 failed every round, correctly; the normal table read `probesGreen=false` as a rework and spent the entire 4-round budget on rounds no worker could win.

**Dispatch-time parity (kusabi #302).** The routing above is defense in depth, not the primary defence. The dispatch-time brief lint (`briefLintReport`) refuses a `## Deliverables`, `## Smoke` or `## Frozen Tests` heading that parses to zero entries *before* any worker is spawned or any round state exists, naming the section and the remedy ("add entries, or delete the heading entirely — an empty section must omit its heading"). Absence still refuses nothing: Smoke and Frozen Tests remain optional, and a brief that declares neither is untouched. The lint's membership test is `zeroEntrySections`, which calls the probes' own parsers from the same table (`PARSED_BRIEF_SECTIONS`), so "the lint accepted this brief" and "P3/P4/P5 can read its sections" are the same statement rather than two implementations that agree until one is edited — a brief the lint accepts cannot fail those probes on the zero-entries rule. A chain that reaches the routing row above therefore started before the lint existed, or bypassed it.

The same dispatch-time lint (the same `chain || phase` gate as the zero-entries rule) also refuses a `## Frozen Tests` entry whose remainder outside the path token is non-empty — `you may append; do not weaken`, `do not weaken`, a Japanese 但し書き — and names both remedies (kusabi #386). `parsePathSection` (behind `parseFrozenTests`) keeps only the first path token and drops everything outside it, so any words the author writes outside the path token never reach P5; P5 freezes by path and would flag a worker that obeys that prose (append-only) as an oracle violation — the worker cannot win because the probe's input is the brief (henshusha chain-mtaa2btyd78c, 2026-08-27). The detection is purely structural (not a keyword match, which would miss `do not weaken` without the word "append" and Japanese 但し書き), and P5 itself is unchanged: it still intersects paths, and the new check is lint only, not a change to the path parser's return value. The two remedies are stated in the refusal: if appending is allowed, do not freeze that path — put "do not weaken existing tests" in the Acceptance criteria and put new tests in a different file if they must be frozen; if the path must stay frozen, the entry is the path alone, with no 但し書き. A clean Frozen section — path-only bullets or a path-only code block — returns nothing from this rule; absence still refuses nothing (the #302 non-goal stands), and a heading annotation such as `## Frozen Tests (do not touch)` is unaffected because the rule walks items, not the heading line.

Heading matching in `## ` sections is a **word-boundary prefix match** (kusabi #167): a heading is recognised when its text equals the section name, or starts with it and the character immediately after is not alphanumeric or underscore. Annotations after the section name are therefore allowed — `## Deliverables (files that must change)` and `## Smoke (run in container)` are recognised exactly like the bare headings — while matching stays case-sensitive and look-alikes such as `## Deliverables2` or `## Smoketest` are not. The rule applies to `## Deliverables`, `## Smoke` and `## Frozen Tests` alike via the shared walker in `brief-parsing.mjs` — `## Frozen Tests (do not touch)` is recognised, `## Frozen Tests2` and `## Frozen tests` are not — and the "heading present but zero entries parsed → probe fails" behaviour above holds for annotated headings unchanged.

The same probes (P1–P6) also run for single `task --container <cid>` invocations, storing results on the job record and appending a probe summary to the task output. A standalone task has no chain-start verify baseline, so its P6 always reports the unavailable-count limitation rather than comparing.

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

Review parse/run (`parseReviewResult`, `runReviewPhase`, `shouldSkipReview`, `buildReviewRepairPrompt`, `renderProbeReport`, `renderReviewPriorFindings`) live in `plugins/kusabi/scripts/chain-review.mjs` (kusabi #435). `writeReviewRecord` / `collectChangeScope` stay in `chain-phases.mjs`. The production caller of `runReviewPhase` is `chain-finish.mjs`; `chain-phases.mjs` does not import `chain-review.mjs`. Terminal outcome rendering (`renderAcceptOutcome`, `renderAcceptWithFollowupOutcome`, `renderEscalateOutcome`, `renderRefusalOutcome`, `renderBriefSyntaxDefectOutcome`, `renderMaxRoundsOutcome`, `renderProviderExhaustedOutcome`, `handleProviderExhaustion`) lives in `plugins/kusabi/scripts/chain-outcomes.mjs` (kusabi #439). Production callers are `chain-finish.mjs` and `chain-driver.mjs`; `chain-phases.mjs` does not import `chain-outcomes.mjs`. Resume position and replacement-seat archive (`resolveChainResume`, `classifyReviewSeatReplacement`, `archiveFailedReviewSeat`) live in `plugins/kusabi/scripts/chain-resume-resolve.mjs` (kusabi #441). Production callers are `chain-cmd.mjs` and `chain-driver.mjs`; `chain-phases.mjs` does not import `chain-resume-resolve.mjs`. Implement and probe orchestration (`withContainerWorkspace`, `buildImplementText`, `runImplementPhase`, `runProbePhase`) live in `plugins/kusabi/scripts/chain-run.mjs` (kusabi #447). Production callers are `chain-driver.mjs` and `task-cmd.mjs`; `chain-phases.mjs` does not import `chain-run.mjs`.

Uses `plugins/kusabi/prompts/adversarial-review.md` + `plugins/kusabi/schemas/review-output.schema.json`. The JSON schema is **embedded in the prompt** rather than passed via opencode's `format: json_schema` (workaround for opencode 1.17.x bug, issue #8; `docs/DESIGN.md` §7 records the failure mode — the provider 400s and every subsequent `GET /message` on that session 400s too, so the session is unusable afterwards).

**Output format: JSONL, one record per line (kusabi #202).** The reviewer emits one JSON object per line, each written the moment that piece of the review is decided:

```jsonl
{"type":"finding","severity":"high","kind":"design","title":"...","body":"...","file":"src/a.mjs","line_start":12,"line_end":18,"confidence":0.8,"recommendation":"..."}
{"type":"unverified","text":"could not exercise the timeout path"}
{"type":"next_step","text":"..."}
{"type":"verdict","verdict":"needs-attention","summary":"..."}
```

A `finding` record carries exactly the finding fields `review-output.schema.json` defines, spelled the same way, plus the `type` discriminator — JSONL changes how the pieces arrive, not what a finding contains (the schema is untouched). The `verdict` record comes LAST, because the verdict genuinely depends on the findings. Two prompt-side rules exist because the verdict line is where the format breaks in practice (kusabi #312, three autopsied seats): the verdict `summary` is capped at 500 characters — analysis belongs in `finding` records, and an overlong summary string is how a complete adjudication fails to close its own JSON — and records must be plain output lines, never wrapped in tool-call syntax or any other envelope, which renders the whole review invisible to the harness. **A line that is not valid JSON is IGNORED**, and that is required rather than tolerated: it is what lets the reviewer narrate its way through a checklist instead of that reasoning being discarded. Measured motivation: job `job-msn8ktw24af4` streamed 25,868 characters of substantive review — working through an eight-point checklist and reaching conclusions on six points — and stopped before emitting the final object; every finding was lost, because the only artifact the system recognised was the object that never came. JSONL needs no provider support (which `docs/DESIGN.md` §7 says is unavailable): one self-delimiting object per line is a prompt convention that degrades on its own.

**Both input formats are read, JSONL first, with strict schema validation (kusabi #202, #392).** `parseReviewJsonl` (`review-jsonl.mjs`) runs before `extractJson` and returns null for anything that is not JSONL — prose, an empty stream, and a single JSON object, which carries no `type` discriminator (the schema's `additionalProperties: false` forbids one, so a one-line legacy blob can never be mistaken for a record). Both the JSONL-assembled object and the legacy single-object path (`extractJson` with its extraction stages plus `VERDICT:`-token recovery) are strictly validated against `schemas/review-output.schema.json` via `review-validate.mjs`. Payloads must carry `schema_version: 1` (required on the closing verdict record in JSONL and top-level in legacy objects) and strictly conform to the schema: unknown extra keys on records or the legacy object are refused (`reviewParseable: false`, verdict `unparseable`, and machine-readable errors logged to `events.ndjson` as `companion.review.schema_invalid`). JSONL is a **wire format only**: the records are assembled into the same in-memory shape `parseReviewResult` returns (`{ chainParsedReview, chainVerdict, chainFindingsText, reviewParseable, schemaErrors }`, findings in emission order), so `renderReview`, the disposition logic, the round records and `chain-ingest` consume it cleanly. The standalone `review` subcommand reads both formats too, since it shares the reviewer prompt with the chain.

**`partial` — findings, but no `verdict` line (kusabi #202).** A JSONL stream that carried findings and ended before the verdict record is a `partial` review: `chainVerdict` is `"partial"`, a state of its own and not an alias of any schema verdict. It is **not** an approval and it does not silently buy a rework round — it **escalates to the orchestrator** (`deriveDisposition` names it explicitly: `partial review: stream ended before the verdict line`), with the findings recorded in `roundRecord.findings` and rendered like any other findings. The review is incomplete, and only a human can judge whether partial coverage suffices. It must **not** trigger the unparseable-output retry below: that retry exists for output we could not read, whereas here the output read fine and the model ran out of room — re-dispatching would spend the budget that just proved insufficient. Mechanically, `reviewParseable` stays `true`, which is what keeps it out of the retry (gated on verdict `"unparseable"`). The round record makes the partiality visible: `reviewPartial: true` and `reviewFindingCount: <N>` alongside `verdict: "partial"`, written only for partial rounds so complete rounds' records are unchanged. An empty or whitespace-only stream is NOT partial — there is nothing to carry, so it stays the existing `unparseable` state (and keeps its retry). **One repair before a stream is declared partial (kusabi #312): an unterminated verdict line is SALVAGED.** A line that fails `JSON.parse` but opens like a verdict record (`{"type":"verdict"…`) is a complete adjudication whose JSON never closed — the measured incident was a generated `approve` with a 1,610-char summary string missing its closing quote, which the ignore rule converted into an escalate. The verdict value is extracted from the region before the `"summary"` key (summary is reviewer prose and must not be able to fabricate a decision), against the schema's verdict enum; on success the stream closes as non-partial with `review.salvagedVerdict: true` and a ` [salvaged from an unterminated verdict line]` marker on the best-effort summary. A real, parseable verdict record anywhere in the stream always beats a salvaged one, a non-enum verdict record voids any salvage, and the last broken line wins (including the no-salvage outcome). When the stream IS partial, the parser now says why — `partialDiagnosis`: `format: final line is verdict-shaped but unparseable` vs `format: records present but no verdict record arrived` — so a format failure is no longer reported as a stream death.

**Schema-invalid repair loop (kusabi #395)**: when a completed review job (`job.status === "completed"`) emits JSON that fails strict schema validation (`schemaErrors.length > 0`), `runReviewPhase` (and `cmdReview`) repairs once (max 1 retry) by injecting the machine-readable schema errors into the same worker session (`session: reviewJob.sessionID` when present) with a short repair prompt directing the worker to emit one corrected JSON object conforming to `review-output.schema.json`. If `sessionID` is missing, a fresh repair job is dispatched with the schema errors and a truncated copy of the original output. A `companion.review.schema_repair` event is recorded on the job log with the attempt number and errors. If the repair attempt still has `schemaErrors` or is unparseable, it falls through to existing unparseable / salvage without running a redundant identical full-prompt retry. Partial JSONL streams (kusabi #202) and salvaged verdict lines (kusabi #312) do not enter the repair loop.

**Unparseable-output retry (issue #145)**: when the review response contains neither parseable JSON nor a recoverable `VERDICT:` token and has empty `schemaErrors` (true garbage / no JSON emitted at all), `runReviewPhase` re-dispatches the review job exactly once within the same round, with identical options (same prompt, tiers, agent, tools, timeouts) — but only when the first job actually completed (`job.status === "completed"`). A hard failure (stalled / timeout / serve-dead / provider-error) returns empty or garbage output; it never triggers a retry and escalates after a single attempt, exactly as before the retry existed — re-dispatching would double worst-case latency (2 × watchdog 900s / timeout 1800s) in exactly the degraded environments where it is known-futile. The retry does not consume a round, and the round record keeps both jobs traceable (`reviewFirstJobId` for the first attempt, `reviewFirstUsage` / `reviewFirstFallbacks` for the first attempt's spend and fallback trail, all other `review*` fields from the final attempt, `reviewUnparseableRetried: true`). Chain totals include the first attempt's usage, so retried rounds report their true cost; time-window stats (`chain-stats`) and the metrics DB round rows (`chain-ingest`) fold it in as well. A verdict recovered from a `VERDICT:` token never triggers the retry; two consecutive unparseable results escalate exactly as before. Nor does a `partial` JSONL stream (kusabi #202, above): that output was READ, so it is not an unparseable result at all — it escalates with its findings on the first attempt. The retry's scope is unchanged by JSONL: output we could not read, from a job that completed.

Reviewer (kusabi-review) permissions:
- **allow**: `sunaba_verify_in_container`, `sunaba_lint_in_container`, `sunaba_type_check_in_container` — independently re-runs the implementer's "gate green" claim to verify it (PR#37/#40)
- **deny**: all mutation tools (sandbox_exec, write_file, edit_file, checkout, publish, etc.) — because if the reviewer starts fixing, independence is lost
- **deny**: `sunaba_sandbox_issue_write` and `sunaba_sandbox_pr_review_write` — outward writes are the orchestrator's exclusive exit; the reviewer's deliverable is the structured final report, not issue comments or PR reviews
- The chain review prompt is augmented with machine-collected base facts (`baseSha`, recent base history, and the change set — the machine-resolved change-scope JSON when available, else `git status --porcelain`; next bullet) so the reviewer receives "what is this task's change set" as data rather than guessing. See `renderBaseFacts` in `render.mjs`.
- **The review scope is machine-resolved by `change-scope.mjs` when available** (kusabi #379, #400). The chain's review phase injects `change-scope.mjs` from the companion checkout into the container at `/tmp/kusabi-change-scope.mjs` outside `/workspace` (`collectChangeScope`, chain-phases.mjs) and executes `node /tmp/kusabi-change-scope.mjs --base <baseSha> --head HEAD`, injecting the resulting `formatVersion: 1` JSON — `resolved.{baseSha,headSha,mergeBaseSha}` and `paths.{committed,staged,unstaged,untracked}` — into the base-facts block verbatim, replacing the `git status --porcelain` capture, with an explicit instruction that `paths.*` is the authoritative scope and that paths outside it (base history) must not be flagged as this round's change or as scope creep. The base commit named in the fetch instruction becomes `resolved.baseSha`. **Collection fails closed**: inject failure, non-zero exit, empty stdout, invalid JSON, or a contract violation aborts the probe/review input path with an error — there is no fallback scope, no container-specific special case, and no synthetic change set anywhere in production code (a fabricated fallback shipped by a worker round was removed at inspection, chain-mtabmkjqd6ea). When `change-scope` output is absent for a legitimate reason (no baseSha), the input falls back to the porcelain capture exactly as before #379.
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

Pure function `deriveDisposition({verdict, probesGreen, round, maxRounds, repeatedAreas, findingSeverities, strategizeEligible, oracleViolation, refusal, briefSyntaxDefect})` in `plugins/kusabi/scripts/disposition.mjs`:

| verdict | probesGreen | Condition | disposition | Meaning |
|---|---|---|---|---|---|
| — | — | `refusal` set (qualifying refusal, §3.5.4a) | **refused-brief-defect** | The round changed nothing and its report named two contradicting brief items. Checked FIRST, ahead of every row below including the oracle and the max-rounds terminal: they all assume a coherent brief. Terminal into the orchestrator's hands — never accept, never rework/escalate, no rework budget spent, and the round is attributed as a refusal rather than a worker discard (kusabi #293) |
| — | — | `briefSyntaxDefect` set (brief-reachable P3/P4/P5 failure, §3.5.2) | **refused-brief-defect** | A `## Deliverables` / `## Smoke` / `## Frozen Tests` heading that parses to zero entries. The probe's input is the brief, which the worker cannot edit, so no rework is winnable: terminal at the first occurrence, no rework budget spent, and the reason names the section and attributes the defect to the brief's author (kusabi #303). Checked after the refusal row above (that block is the more specific statement) and before the oracle: an unreadable declaration is not a violated one. #302 refuses such a brief at dispatch, so this row is defense in depth |
| any except discard | — | `oracleViolation` set (P5/P6, §3.5.2) | **escalate** | A frozen-test edit or a drop in the collected test count. Takes precedence over every row below, accept-with-followup included: the resolution may be "this deletion is legitimate, I approve it", which only a human can decide, so it is never an automatic rework. The reason names the violation (kusabi #197) |
| approve | true | — | **accept** | Conclude, hand to orchestrator |
| approve | false | repeatedAreas=false | rework | Probe failure |
| approve | false | repeatedAreas=true + strategizeAllowed | **strategize** | Stalled despite approve: structural re-diagnosis before next rework (`docs/DESIGN.md` §9.1) |
| approve | false | repeatedAreas=true otherwise | **escalate** | Stalled with no strategize available; reason also notes max-rounds exhaustion when it applies |
| approve-partial | — | — | **escalate** | Unverified items remain, orchestrator decides |
| needs-attention | — | any finding high/critical | **escalate** | Consequential finding is a decision for the orchestrator, not a rework the implementer decides (kusabi #336; severity-only, kind ignored for 20.3% absence + cross-round instability) |
| needs-attention | true | all findings low/medium (no critical/high), list non-empty | **accept-with-followup** | Economic cutoff: see Decision 5 (`docs/DESIGN.md` §9.2) |
| needs-attention | true | ZERO findings named (list empty, absent or not an array) + repeatedAreas=false | **escalate** | The reviewer said the work needs attention and then named nothing that needs it. Over green probes there is no work item in the findings (there are none) and none in the probes (they passed), so a rework would dispatch an implement with an EMPTY work list — which is the incident (chain-msvthdq26fdc, 2026-08-16): the rework changed nothing, P3 discarded the empty round, and the chain escalated reading "reviewer discarded the work" over an intact worktree. Same family as the `partial` row and `approve-partial`: the REVIEW is incomplete, so it is not an approval, must not silently buy a rework round, and only a human can judge whether "needs attention, nothing named" is a clean bill of health or a review that fell over. The reason names the empty finding list, so the digest says it without opening the round record. Two deliberate exclusions: probesGreen=false (a probe failure IS concrete work for the implement, so the rework row below is unchanged) and repeatedAreas (those rows name a concrete stall, which is the more informative thing to tell the operator) (kusabi #299) |
| needs-attention | — | repeatedAreas=false, with all named findings ≤ medium (or probes red) | rework | Fix and re-review |
| needs-attention | — | repeatedAreas=true + strategizeAllowed | **strategize** | First stall: structural re-diagnosis before next rework (`docs/DESIGN.md` §9.1) |
| needs-attention | — | repeatedAreas=true otherwise | **escalate** | Same file area flagged 2 rounds in a row = stalled |
| discard | — | — | **escalate** | Reviewer deemed it discardable. The one row an `oracleViolation` does not preempt — both end in escalate, so no state exists where a chain can neither accept nor escalate (kusabi #173) |
| — | — | round ≥ maxRounds and not accepted | **escalate** | Max rounds reached; reason appends the stagnation note when repeatedAreas is true |

`strategizeAllowed` = `strategizeEligible === true && round < maxRounds`. A strategist job produced on the final round has no next round left to consume its output, so the final round never strategizes even when eligible (#117).

Policy (#117, decided 2026-07-29): `repeatedAreas` does **not** preempt accept-with-followup — probes green + all findings low/medium ships with a follow-up issue even when the same file area was flagged two rounds running. strategize only has value for rounds that cannot ship as-is.

accept-with-followup misuse guards:
- Severity comes from the reviewer's separate session (not the implementer)
- probesGreen must be true (mechanical checks passed)
- The follow-up draft always surfaces to the orchestrator (never posted automatically)

#### 3.5.4a Qualifying refusal — implemented (kusabi #293)

A worker that reads the brief, finds it genuinely self-contradictory and stops with zero edits is doing the right thing, and until this existed the machinery punished it: the empty change set went to `shouldSkipReview` → verdict `discard` → escalate, and the only thing separating an honest refusal from a lazy empty round was report prose no machine reads. That is structural pressure toward "comply with the nearest satisfiable reading" — weakened tests, distorted implementations — which is the measured failure mode of cheap workers. The live case is job-msvkcrz664e7 (2026-08-16): the brief froze "all existing tests pass unchanged" while its spec demanded the opposite output for an input an existing test pinned; the worker named the contradiction and stopped, and survived only because it was a single-shot task outside a chain.

**The block.** The implement worker writes it in its final report; `kusabi-implement.md` teaches the literal shape. A fenced block with the info string `kusabi-refusal`, two `anchor:` lines and one `why:` line:

````
```kusabi-refusal
anchor: ## Frozen tests
anchor: plugins/kusabi/scripts/chain-phases.test.mjs
why: the frozen section requires every existing test to pass unchanged, while the spec requires the opposite output for the input that test pins.
```
````

An **anchor** is a brief section heading written with its markdown marker (`## …`, `§…`) or a repo path (optionally with a `:line` suffix and a trailing gloss). Free prose is deliberately not an anchor: a spurious refusal is the abuse case here, and an unfalsifiable claim is exactly what the named-item requirement keeps out. Parsing is `parseRefusalBlock` in `probe-decisions.mjs` — pure, report text in, descriptor out, with its own unit tests; tolerances are deliberate (case-insensitive fence, `~~~` fences, bullet-prefixed keys, a wrapped `why`, loose prose read as the `why` when the label is missing, and an unterminated block read to the end of the report so a truncated report still refuses). The parse happens once, in `runImplementPhase`, and only the small descriptor reaches the round record — never the report text, which can carry a whole diff.

**The parse is shape-only; the named items must EXIST.** A shape-qualifying block whose anchors are invented (`src/nonexistent.mjs`, `## No Such Section`) would still be a forged refusal — the shape gate keeps out prose, not invented items. So at classification time (`finishRound`, where both inputs are in scope), `verifyRefusalAnchors` (same module) checks every anchor against the brief text and the worktree: a brief-section anchor must match a heading the brief really has (`extractBriefHeadings`; exact text, or an abbreviation of a longer heading — `§3.5` matches `3.5 Dispositions`), and a repo-path anchor must be a file or directory the worktree really contains (`fs.existsSync` on `cwd`, `:line` suffix stripped, `..` and `.git` paths rejected). A non-existent item counts as **unnamed** — the block qualifies only if two verified named items remain — and the miss is recorded on the descriptor (`unnamedAnchors` with the reason, `disqualification` naming the missing anchors) so the orchestrator sees why the block fell short. Both the fresh path and the review-resume path run the same verification, so a resumed round derives the same verdict; the verified descriptor replaces the parse-time stamp on the record.

**The three distinctions** (`classifyRefusalOutcome`, same module), keyed on the same empty-change-set signal `shouldSkipReview` already decides the discard on, so this can only ever divide that population:

| change set | refusal block | outcome | routing |
|---|---|---|---|
| empty | qualifying (≥2 named anchors that EXIST in the brief/worktree + a why) | `refusal` | disposition `refused-brief-defect`, terminal; round record carries `roundOutcome: "refusal"`, `verdict: "refusal"` and the parsed block |
| empty | absent, or fewer than two named anchors, or no why | `discard` | unchanged: verdict `discard` with `verdictSource: "probe"` → escalate. A non-qualifying block is recorded as `refusalRejected` (what was missing) — routing is untouched |
| non-empty | any | `changed` | unchanged. A refusal accompanied by edits is not a refusal; the stray block lands on the round record as `strayRefusalBlock` so the orchestrator sees the inconsistency |

**Attribution.** The round record says `verdict: "refusal"`, not `discard`: seat metrics count verdicts, and leaving `discard` there would charge the worker for reading the brief correctly — the pressure this path exists to remove. No rework strategy is computed (`finishRound` does that only for disposition `rework`), so the rework counter and the round budget are untouched by construction. `chain-show` prints the disposition line, both named items and the why; `chain-wait` carries `refused-brief-defect` in `TERMINAL_DISPOSITIONS` like any other terminal state. Measuring spurious-refusal rates per seat is deliberately not done here — the abuse bound is the existence gate itself: a block qualifies only when both anchors are real, findable items (a heading the brief really has, a path the worktree really contains), so an invented contradiction cannot ride a shape-only parse, and a refusal always lands in front of the orchestrator rather than buying an early exit; per-seat scoring is a later issue.

**Interruption and resume.** The descriptor is stamped onto the round record at parse time (`runImplementPhase`), not only when `finishRound` classifies it: the driver's designed stop point after the probes (kusabi #153①) persists the partial round before the refusal is ever classified, and the review-resume path reads the recorded descriptor back (`roundRecord.implementRefusal`) instead of treating the round as if no refusal existed. A stop landing between implement and finishRound therefore resumes into the same refusal the original finish would have produced — the empty round is never re-classified as a worker discard. Records predating the stamp read as null and route exactly as before refusals existed.

This complements the authoring-side guards rather than replacing them: the delegate skill's freeze-time grep rule (#290) prevents one contradiction class before dispatch, and the brief lint (#289) and smoke baseline probe (#292, #315) catch mechanical and runtime defects — the baseline refuses an unannotated smoke entry that is red on the pristine checkout, and refuses a `baseline-red` entry that is GREEN there (the annotation licenses exactly one baseline outcome, a measured mismatch: the smoke targets a deliverable that does not exist yet; green means the brief is stale or the deliverable already exists), while an annotated entry red at base as declared dispatches. What is left is the residue those cannot catch — contradictions only discoverable mid-implementation. Implement seat only for now; the review seat has no equivalent.

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

**The session a round hands to the next round is the one its dispatch used or
created — never the one it was told to abandon (kusabi #320, fixed in #323).**
`runImplementPhase` reports the session its dispatch actually used or created:
the candidate it resumed for a resuming round (the candidate or the
previous-record fallback), or the id the dispatch **created** for a fresh
round (`newSession`, or a dropped cross-backend candidate).  The two coincide
for a resuming round (the backend used the candidate) and differ exactly when
the dispatch ran fresh.  Reporting the candidate there was the kusabi #320
defect: round N dispatched fresh as asked, and round N+1 would resume the
very conversation round N was told to walk away from.  #320 papered over it
by having the driver clear the carry after `newSession` rounds
(`chain-driver.mjs`), so round N+1 re-derived the conversation round N
**created** from round N's record (the `previousRecord.sessionID` fallback
inside `runImplementPhase`); #323 removed that compensation and fixed the
seam instead — the phase itself reports the created session, so the carry IS
the natural reading of "start fresh, then carry on from there" and there is
nothing left to clear.  The round record remains the single source of truth
for the hand-off.  The reported carry and the record's `sessionID` genuinely
coincide whenever the dispatch observed an id — the carry IS that
`job.sessionID` — and the one remaining divergence is the documented fallback:
a resuming round whose job died before any id was observed reports the
candidate while its record's `sessionID` is null (kusabi #324).  This is the
measured rule, not an axiom: 2026-08-21 a real agy record
(chain-msxhipgq1cef round 2, continue_session) diverged — the candidate
`a784b853-…` was passed, the job stamped `2a177486-…` — while opencode held
16/16 same-backend `continue_session` rounds and a claude n=1 probe held the
id, so the phase prefers the observed id on both branches (observed beats
told) and keeps the candidate only as the dead-round fallback.  A fresh dispatch whose job died
before any session id was observed carries no `sessionID` on its record and
no session in its report, so the next round starts fresh; that is the only
safe reading — falling back to the candidate would resurrect the abandoned
conversation through the failure path, and a session the job DID establish is
carried on the job itself (`runPrompt` stamps `job.sessionID` before
dispatch; claude and agy stamp it from the CLI's response or stream init), so
a missing id truly means no session id was ever observed.  The provenance
reported beside the session follows it: a resumed session keeps the
provenance it was resolved with (the previous record's backend, or the
caller's proof for a chain-resume `initialSession`), and a created session is
reported with the backend that created it — the most established proof there
is (the record agrees), so an agy round can always prove the conversation it
resumes (the dispatch fails closed otherwise, kusabi #316).

Evidence inputs to `deriveReworkStrategy`:
- `reworkCount` (0-indexed: 0 = first rework)
- `strategized` — whether a strategize has occurred
- `verdict` / `probesGreen` — the finished round's review verdict and
  deterministic-probe result (feeding the anchoring override; the override
  fires when `verdict === "approve"` and `probesGreen === false`, and the
  recorded `reworkStrategyReason` names the trigger)
- `repeatedAreas` — same file area flagged across rounds (also forces a new
  session on the 1st rework; the lever must not depend on the scheduling
  accident that repetition normally implies a later rework). **On a scoped
  rework round the previous round's files are narrowed to the findings that
  round was asked to resolve** (kusabi #334): a deliberately held finding
  names the same file every round by construction, so counting it would fire
  the stall detector on a chain progressing exactly as designed. `hasRepeatedAreas`
  itself is unchanged — the narrowing is applied to its INPUT, via
  `inScopeFindingFiles`, and is a no-op for a full-scope round.

The function returns:
- `tierDelta` — how many tiers to advance (0 = same tier)
- `newSession` — whether to start a fresh session
- `reason` — human-readable explanation of the decision

**Review parsing** tries the JSONL wire format first, then the single-object path, and distinguishes parseable from unparseable output:
0. `parseReviewJsonl` (§3.5.3, kusabi #202, #392): if any line is a JSON object carrying a known `type`, the output is JSONL — the records are assembled into the review shape, non-JSON lines ignored, and a stream with no `verdict` record recorded as `verdict: "partial"` with `reviewParseable: true`, `reviewPartial: true` and `reviewFindingCount: <N>`. Closed streams and single-object extractions are strictly validated against `review-output.schema.json` with `schema_version: 1` required and unknown fields rejected. Anything else (prose, a single JSON object, an empty stream) returns null and falls through to the single-object extraction steps below.
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
- `repeatedAreas` computed via `hasRepeatedAreas` from `chain-phases.mjs` (re-imported, never reimplemented), over the **same narrowed input the live chain decides on** (kusabi #334): a round recording a `reworkScope` has its predecessor's files reduced through `inScopeFindingFiles`, so the aggregate and the disposition cannot mean different things. The scoped subset is not persisted, so the scope is re-derived with `resolveReworkScope` — and **the derivation is trusted only when its name matches the `reworkScope` the round recorded**. A disagreement means the branch table changed after the round ran, so the derivation describes a round that never executed; such a round is counted "n/a" rather than measured, which is what keeps a future scheduling change from silently rewriting historical figures. Rounds without a previous round are excluded from the denominator. Rounds missing `findingFiles` or `findings` are counted in the same "n/a" figure.
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

On escalate, include remaining findings + history (each round's verdict/probes/disposition/tier/resume method) in the final output. publish is never called from the chain (not on the allow list). When the terminal round carries a structured `findings` array (kusabi #336), the escalate terminal output — both the `renderEscalateOutcome` handover and `chain-show` for the escalated chain — renders each finding's body and its recommendation as a decision for the orchestrator: severity-ordered (critical → high → medium → low → unknown, stable within a severity), budget-bounded by `ESCALATION_DECISIONS_BUDGET`, with an explicit instruction that a one-line answer per item is enough. Pre-#336 records without a structured `findings` array degrade to the one-line `findingsText` list; a round with no findings at all states that plainly.

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

**Review record (`review-record.md`)** (kusabi #52). When a chain reaches a terminal disposition — accepted (incl. accept-with-followup), or terminated by escalate / max-rounds — the shared finalisation point inside `runChainDriver` (the same code path for `chain` and `chain-resume`) renders the chain's outcome through `renderReviewRecord` (`plugins/kusabi/scripts/render.mjs`, a pure renderer that never throws on partial records) and writes it to the chain's state directory as `chains/<chainId>/review-record.md`; the chain's terminal output prints the record's path. Chains that end in a non-completed exit (cancelled or failed) also receive a provisional review record when their final round reached deterministic probes (`probeResults` present), marked provisional in the header to indicate the chain did not reach a disposition and may be superseded by `chain-resume`; chains cancelled or failed before any round's probes run get no record. The record is regenerated (overwritten) whenever a resumed chain later completes. The two "fill at inspection" sections — the findings adjudication table (採否/理由 columns) and the 判例として precedent slot — are deliberately generated blank (`_fill_`) for the orchestrator to complete by hand. Posting the record to the archive repository (kairanban) is orchestrator-exclusive by the same exit principle as publish: the companion only writes the local file and prints its path, and never posts anywhere. **The header's model line names what RAN** (the per-round models, unique, in round order), not the configured ladder (kusabi #372): a record written for a `--model`-pinned chain used to print the config entries the pin had replaced, so the header contradicted its own rounds — and it did so exactly when the pin mattered, i.e. on the days the configured chain was dead and the seat that actually worked was the thing worth recording. The configured ladder is still shown when it differs, explicitly labelled `(configured: …)`, so a reader cannot mistake it for the model that did the work; a record carrying neither source renders `(unknown)` rather than a confident-looking guess. This matters because these records are the corpus the delegate discipline consults before drafting a brief — a wrong header makes a future seat choice rest on evidence that never existed. (`chain-stats` and the chain ingest path were checked at the same time and already key off the per-round `modelEntry`, so they carry no such misattribution.)

#### 3.5.7a `cancel` — stopping a standalone job (kusabi #209)

`cancel` acts on ONE job record (the standalone `task` path has no chain and no `control.json`; the chain-level lever is `chain-cancel`, above). Its contract is that its output and its exit code describe what was **observed**, never what was attempted — the #209 incident was a claude-backend job that printed `cancelled job-…` while the process kept writing files into the container for another 17 minutes, and an operator told the job stopped goes on to reuse the container.

**What the job record carries.** A claude-backend job record gains `process: { pid, startTime, recordedAt }`, written by `claudeDispatch` the instant the child exists (`runClaudeProcess`'s `onStart`) and before it can do any work. `pid` alone is not a kill target: pids are recycled, and a record can outlive its process by days (measured: a pid recorded 8 days earlier had been reused as an unrelated process's thread id, and signalling it took down a live server for 22 minutes). `startTime` is field 22 of `/proc/<pid>/stat` — assigned once at fork, never changed by `exec`, never inherited, and reported per-thread for a TID — so re-reading it immediately before signalling proves the live pid is still the recorded process. Recording is best-effort in one direction only: a failed write degrades the stop lever, never the dispatch.

**What `cancel` guarantees, per backend:**

| Backend | Lever | Guarantee |
|---|---|---|
| `claude` | `SIGKILL` to the recorded process **group** (`kill(-pid)`) — the child is spawned detached, so it leads its own group and its children (sunaba MCP server, tool commands) die with it | Signalled only after the identity token re-verifies; the group is then polled until empty (bounded, `KUSABI_CANCEL_KILL_WAIT_MS`, 5 s default), because `kill()` returning means the signal was delivered, not that anything died. No `/session/<id>/abort` is ever issued — the record's `sessionID` is `null` by construction until the CLI returns one |
| `opencode` | `POST /session/<id>/abort` on the serve | The request's failure is surfaced, not swallowed. An unhealthy serve means nothing is executing the session, so the record is finalised with that said out loud |

**Outcomes.** Stopped-and-gone, and already-gone (including a pid whose identity no longer matches — that process is not this job's, so this job's process is gone; and the `#175`/`#176` fossil record) both finalise the record to `cancelled` and exit 0. Everything else — a group that survived the kill, a pid that cannot be verified, a record naming no process, a failed abort — leaves the record `running`, names the pid, never prints the word `cancelled`, and **exits nonzero**. That exit code is why a subcommand may now return `{ text, exitCode }` instead of a string (`commandOutcome`): printing a failure while exiting 0 is the same false confirmation in a different channel.

#### 3.5.7b `chain-wait` — completion detection (kusabi #285)

Chains are dispatched detached (`setsid nohup … &`) so the caller's shell cannot reap the serve. The price is that **no completion signal exists**, and orchestrator sessions used to hand-roll `while pgrep -f <pattern>; do sleep; done`. All three failure modes of that pattern fired in one session (2026-08-16):

1. the pgrep pattern matched `chain --brief-file` but not `chain-resume`, so a resume's completion went unwatched;
2. a `chain-resume` invoked without its chain id died in under a second with a usage error — **indistinguishable from "already finished"** to a process-existence watcher — and sat unread in a log;
3. **process liveness is not chain state**: a process alive but stuck never fires, and process death does not mean a disposition exists.

`chain-wait` therefore watches chain STATE (`control.json` + `chain.json`) and uses process liveness only as the tie-breaker for "state can no longer advance". It is a pure poll loop — **no LLM, no serve, nothing to clean up, safe to SIGTERM at any moment** — which is precisely what makes the WAIT trackable by a caller's harness where the chain itself is not. That asymmetry is the whole design: the untrackable thing runs detached, and a trackable, disposable process watches it.

**Exit-code contract.** Exit 0 means the chain reached a terminal state — *whatever* its disposition. Reporting the disposition is the digest's job and judging it is the orchestrator's, so a chain that escalated exits 0 here. A non-zero exit means the **wait itself** failed, never a disposition you dislike; `ChainWaitError.code` is the machine-readable half: `unknown-chain`, `no-chain-appeared`, `stalled`, `usage`. A dispatch that died before creating a chain directory therefore exits non-zero instead of looking finished — failure mode 2 above, closed.

**What counts as terminal.** Two independent signals, because they become true at different moments:

- `TERMINAL_CHAIN_STATUSES` = `completed` / `cancelled` / `failed`, written by `finalizeChainControl` on every exit path.
- `TERMINAL_DISPOSITIONS` = `accept`, `accept-with-followup`, `escalate`, `max-rounds`, `refused-brief-defect` (§3.5.4a). The driver writes `chain.json` and finalises `control.json` immediately after, so the disposition only decides inside that window — but reading it keeps a wait from sleeping through an already-decided chain.

The one place the disposition set lies is **after a `chain-resume`**: `rearmChainControl` puts the status back to `running` while the previous round's disposition still sits in `chain.json`. `readChainSnapshot` tells that case apart rather than treating the stale disposition as terminal.

**Bounds.** Poll interval 2s (`--poll-interval`). `--appear-timeout` 120s bounds both `--next` and a chain directory that never gets a control record. `--progress-timeout` defaults to **2 hours** and is deliberately generous: it is the backstop for a chain whose process is alive but making no progress, while the fast path for the common death (process gone mid-round) is the liveness probe, which does not wait for it.

**`--next`** waits for a chain to APPEAR instead of naming one — the mode a dispatch-then-watch script uses, since the chain id does not exist yet when the watcher starts. It selects the newest chain that is either new since the wait started or was already there and unfinished, so a chain created in the moment before the wait started still counts while one that finished earlier never does. A pre-existing empty directory with no control record, older than `--appear-timeout`, is debris from a dispatch that died before writing anything and is skipped with a stderr note; while the selected chain is still recordless a newer or same-stamped chain that appears wins, so the wait cannot stall on an empty directory (a directory once traded away is never revisited). `--since <ISO>` is the precise tool when several chains run in one workspace at once and newest-unfinished selection would be ambiguous.

**`chain-detach` — background launch and wait handoff.** Launches a chain in a detached background process and prints a runnable `chain-wait` command line (`kusabi-companion chain-wait --next --since <ISO> ...`), eliminating hand-rolled backgrounding and PID tracking. Pre-flight checks (brief-file resolution, publish warning, lossy-smoke refusal, session provenance, container requirement, and dispatch-time brief lint) run before child spawn so invalid dispatches exit non-zero immediately without spawning a background child or printing a wait command line. It accepts the same flags as `chain` (`--container <cid>`, `--model <identifier>`, `--backend opencode|claude|agy|cursor`, `--brief-file <path>`, `--max-rounds <N>`, `--session <id>`, `--timeout <s>`, `--watchdog <s>`, `--deny <tools>`, `--keep-serve`) and forwards tracking flags (`--appear-timeout <s>`, `--poll-interval <s>`, `--progress-timeout <s>`, `--since <ISO>`) into the generated `chain-wait` invocation. The operator (or orchestrator harness) waits on the **chain id** via `chain-wait`, not on a hand-rolled process watcher.

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

`metrics-report.mjs`, wired as the `metrics-report` subcommand in `plugins/kusabi/scripts/metrics-cmd.mjs` (kusabi #443). Companion `main()` keeps the switch case and does not re-export the cmd. The read surface phase 1 (§3.5.8) deliberately left unbuilt (closes #83, #81): where transcript token spend goes and whether cache reads dominate it, and what the recorded chain history looks like when brief metrics are cross-tabulated against outcomes.

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

`chain-resume <chainId>` continues a stopped chain from its persisted state. The resumption context comes entirely from the saved records — `chain.json` (brief, round records, ladder, `verifyBaseline`) and `control.json` (container) — so the only accepted flag is `--keep-serve`; any other flag is rejected rather than ignored. The CLI wrapper (`cmdChainResume` in `chain-cmd.mjs`) validates that the recorded container still exists and is reachable (the chain's work lives in it), and refuses to start while any job of the chain is still recorded as running — a dead driver may have left a phase job dispatched but unfinished, and resuming over it would duplicate the phase. It then re-arms the control record (status `running` again, stop-request fields cleared) and hands the position to `runChainDriver` — the same driver `chain` uses.

**Resume position.** The decision is the pure `resolveChainResume` in `chain-resume-resolve.mjs` (kusabi #441), from the LAST round record alone:

- Last record has implement done but no review/disposition (an interrupted round persisted at stop time) → resume at that round's **review** phase, continuing the persisted partial record.
- Last record is complete with disposition `rework`/`strategize` → resume at the **next round's implement** phase — a rework carries the escalated tier/reworkCount, a strategize carries the fresh-session lever from the record's `pendingReworkStrategy`.
- Terminal dispositions (`accept` / `accept-with-followup` / `escalate`) → the chain already finished; resume is refused. A still-running chain (live pid) is refused too: stop it with `chain-cancel` first. The ONE exception is the replacement review seat below.

**Invariant — an accept from a resumed review finalises only on probe truth measured AFTER the resume (kusabi #262).** Both review-resume entries (the interrupted round above and the replacement review seat below) carry the round record's probe results into the review, and those were measured BEFORE the stop or the escalate. The container worktree can have moved in the gap — operator hand-edits, another job, a partial restore after a re-creation — so an `approve` finalised on the record would let recorded truth override current reality, exactly the failure mode "an estimate must not override an authoritative check" names. So when `finishRound` derives an accept-family disposition (`accept` / `accept-with-followup`) from record-sourced probe truth, it re-runs the **full probe set P1–P6** on the current worktree first (the same machinery as a normal round, P2 still gated against the chain-start verify baseline of §3.5.2), replaces the record's probe fields with the fresh results, and re-derives the disposition from them. Fresh green → the accept stands. Fresh red → the accept never finalises; the disposition derived from red probes decides, exactly as in a normal round (an `approve` with red probes reworks). The P3 comparison uses no worktree baseline here, for the same reason the resumed review's context collection uses none: the resumed round's changes ARE the subject, and the baseline was captured at resume time — after them.

**Why the set is P1–P6 and not P1–P4 (kusabi #197 follow-up).** The recorded oracle marker covers only violations measured BEFORE the stop or the escalate, and the truths the oracle probes read are exactly the ones that move in the gap: P5's subject is the change set, P6's is the collected test count. A frozen-path edit landed in the gap is invisible to P1–P4 — HEAD never moved so P1 is green, the tests still pass so P2 is green — and nothing else compares the fresh count against the chain-start baseline, so an accept could finalise with `oracleViolation` still false. Detection must never depend on per-round attention (§3.5.2), so both are re-measured here. **P5** inherits P3's no-baseline mode above: with no worktree baseline there are no newly-changed paths to isolate, so it is evaluated against the full changed set — the round's own `newlyChangedPaths ?? changedPaths` fallback rule — and collects nothing of its own. **P6** reads the fresh P2's count against the same chain-start `verifyBaseline` the rounds used (reused, never re-captured on the modified worktree), with the identical null-tolerant semantics: either side missing → PASS with the limitation in the detail. The marker the re-derivation routes on is derived from the **fresh** results, never the recorded one — a violation measured on the current worktree escalates the resumed round exactly as it would a normal one (§3.5.4).

The re-run is **lazy** and fires at most **once** per resumed round: the record's `probesRevalidated` marker is the guard, so a re-derived rework cannot re-trigger it. The asymmetry with rework is deliberate, not an omission — a rework buys a next round whose own probes re-measure everything anyway, so re-running before a rework would pay for truth that round produces regardless. Only an accept **consumes** the recorded truth, so only an accept must re-measure it. Non-resumed rounds are untouched: their probe truth was measured in-round, on this worktree, minutes earlier.

**Records — what the re-validation leaves behind.** It is visible, never a silent swap: `probesRevalidated` on the round record keeps the pre-resume `probesGreen` / `probeResults` / `worktreeChanged` / `oracleViolation` and the accept-family disposition they had produced, while the live probe fields carry the fresh run — the same "preserve, don't overwrite" rule `archiveFailedReviewSeat` applies to a dead seat. A degraded worktree therefore leaves both truths on the record: recorded green AND fresh red.

**Replacement review seat (kusabi #248).** An `escalate` can mean two very different things: the review **judged** the work and found it wanting, or the review **seat** died mid-stream and never produced a judgement at all. The second leaves an intact implementation with only the seat consumed (real incident: chain-mssxxuu3cc16 — round 1 implement complete, probes all green, review seat died `partial`, chain terminated), and `chain-resume` may re-buy exactly that seat. The classification is `classifyReviewSeatReplacement` in `chain-resume-resolve.mjs` (kusabi #441), decided from the records alone — no LLM, no worktree read — and runs BEFORE the finished-status gate, because such a chain finished normally (control status `completed`).

Eligible iff **all four** hold for the final round record:

1. probes **all green** (`probesGreen === true` AND a `probeResults` array covering at least P1–P4, every entry passed — the four are a coverage floor so records written before P5/P6 existed stay resumable; a red P5/P6 still disqualifies the seat, because every recorded entry must be green),
2. the verdict is `partial` or `unparseable` — the two states the review parser produces for a seat that died. `needs-attention` is a **completed review judging the work** and is never eligible; nor is `approve-partial` or `discard`,
3. the escalate came from **that** seat failure: `disposition.reason` is the exact reason `deriveDisposition` emits for the record's verdict (`"partial review: stream ended before the verdict line"` / `"unexpected verdict: unparseable"`). A max-rounds escalate carries the max-rounds reason even when the verdict is a seat failure, so it is refused; discard- and repeated-areas-based escalates carry their own reasons and are refused too,
4. the records that decide 1–3 are present and unambiguous — including `round`, `implementJobId`, and agreement between `probesGreen` and the probe entries.

**Fail closed.** A missing or ambiguous field refuses and NAMES the field (the resume guard's history of fail-open edges, #192). The two negative outcomes are distinct: an escalate that was never a seat failure keeps today's refusal **verbatim**, while a seat-shaped escalate whose records cannot decide it appends the named field to that refusal. Every other escalate, and `accept` / `accept-with-followup`, are unchanged.

**Invariant — the resume dispatches review, never implement.** The position is the **SAME** round's `review` phase (`phase: "review"`, `round: <that round>`, `reviewSeatReplacement: true`), in a fresh review session per §3.3. There is no general escalate-resume: implement rework from an escalate stays refused. Once the replacement review completes with a real verdict the normal disposition machinery takes over — an accept accepts (only after the #262 re-validation above re-measures the probes: eligibility here is records-only by design, the finalisation side is not), a rework legitimately buys the next implement round, a second seat failure escalates again (and is itself resumable, one explicit operator action per seat). The prohibition is on the RESUME step alone.

**Budget.** Buying a replacement seat consumes **no** round-budget slot: the round already spent its slot when its implement ran. The seat-replacement return therefore sits before the budget-derived guard — the same reasoning that puts the budget check after the interrupted-round review-resume branch in the driver.

**Records.** The round is continued in place — one record, one round row, no double-counting in metrics ingest. Before the replacement review is dispatched, `archiveFailedReviewSeat` moves every review field of the dead seat (verdict, `verdictSource`, parseable/partial flags, job id, usage, model entry, fallbacks, findings, and the escalate `disposition` it produced) into a `reviewSeatFailures[]` entry and **clears** the live fields. Clearing is load-bearing, not tidiness: `reviewPartial` and `verdictSource` are written only conditionally by `runReviewPhase`, so a surviving value would keep describing the dead seat next to the replacement's verdict — a clean `approve` still flagged partial. The dead seat's spend stays counted (`computeChainTotals` and the ingest's review columns read the archived usages), because a seat that died still burned tokens. `chain-show` and the postable review record render each failed seat next to the replacement verdict, so a replaced round can never read as a single clean review.

Cross-round state (`reworkCount`, `currentTierIndex`, `strategized`, `session`, `baseSha`) is derived from the record fields, so the resumed run continues the tier ladder exactly where the original left off. `session` comes from the last record's `sessionID` — the session that round's
implement dispatch actually used or created — so the resumed run continues
the same conversation the interrupted run would have continued.  (The
in-memory carry `runImplementPhase` reports is that same `job.sessionID` the
record stores — the session the round's dispatch actually used or created —
so the carry and the record coincide whenever the job observed an id, and
diverge only on the documented fallback (a resuming round whose job died
id-less reports the candidate while its record's `sessionID` is null);
kusabi #323, §3.5.5, extended by #324.) `baseSha` keeps the ORIGINAL chain base — the resumed round's diff is measured against it (P1 auto-resets HEAD to it); the worktree baseline, by contrast, is re-captured at resume time (the pre-cancel baseline is not persisted).

**Shared lifecycle.** `chain-resume` goes through `runChainDriver` — the same round loop, stop predicate, serve stopping (unless `--keep-serve`), and terminal finalisation (including the review record, §3.5.7) as `chain`. The verify baseline is the one recorded at chain start, reused and never re-captured on the now-modified worktree (§3.5.2).

#### 3.5.11 claude backend — implemented (kusabi #184)

`chain` and `task` accept `--backend opencode|claude|agy|cursor` (default `opencode`); an unknown value is a clear error with a nonzero exit. The backend is resolved ONCE at command start and recorded as `backend` on every job record and chain round record (round-N.json and the `records` array in chain.json); records without the field are treated as `"opencode"` by readers. `chain-resume` takes the backend from the last chain record — it is not a flag.

**Dispatch.** `plugins/kusabi/scripts/claude-dispatch.mjs` exports `claudeDispatch` with the same call/return contract as `dispatchWithFallback` (`{ job, resultText, stateDir }`); kusabi-companion.mjs substitutes it for the opencode dispatch when `--backend claude` (the single decision point — the chain phases stay backend-blind). It spawns the official Claude Code CLI headlessly: `claude -p --strict-mcp-config --setting-sources "" --output-format stream-json --verbose --model <m> --allowedTools <csv> --disallowedTools <csv> --mcp-config <path> [--append-system-prompt <agent-body>] [--resume <session-id>]` (binary via `CLAUDE_BIN`, default `claude`; arg construction stays in this module; NDJSON line-parse and stats fold live in `claude-stream.mjs` so a contract fix stays cheap). `--verbose` is mandatory alongside `--output-format stream-json` — the real CLI refuses to start without it (`Error: When using --print, --output-format=stream-json requires --verbose`, field-verified 2026-08-11). `--resume <session-id>` is appended when the dispatch receives a `session` option — a resumed session gets the SAME isolation flags (strict MCP config, allow/deny lists) as a fresh one, because resume is a transport detail, not a permission change. The **prompt is written to the child's stdin**, never argv (field-verified: `echo <prompt> | claude -p` works) — it cannot leak into `ps` output or argv-logged transcripts and is not capped by the argv limit.

Stdout is NDJSON — one JSON event object per line — parsed incrementally as it arrives, not buffered whole (kusabi #215 Job B). A line that fails to parse as JSON is skipped and counted, never fatal: the real CLI has been observed printing a non-JSON warning line (`Warning: no stdin data received in 3s, proceeding without it.`) ahead of the stream. The terminal `result` event carries the SAME shape the old `--output-format json` single object always did (`{ type: "result", is_error, result, session_id, usage: { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }, total_cost_usd, duration_ms, num_turns, api_error_status, terminal_reason, … }`) — the old single-object format is itself one JSON line with `type: "result"`, so the line-wise parser that keeps the LAST `result` event handles both formats with no special case. It is mapped onto the job record exactly as before: `session_id` → `sessionID`, `input_tokens` → usage `input`, `output_tokens` → `output`, `cache_creation_input_tokens` → `cacheWrite`, `cache_read_input_tokens` → `cacheRead`, `total_cost_usd` → `cost`; quota classification (below) is unchanged. A stream that ends with NO terminal `result` event — killed by the watchdog or `timeoutS`, a nonzero exit, or a stream that genuinely never carries one — still produces a failed job record, never a stuck `running` one; the session id then comes from the stream's `system`/`init` event when the CLI got that far (the only other source of one). `prompt.md` / `result.md` / `usage.json` artifacts match the opencode path.

**v1 limits (deliberate).**

- **One model per phase.** `--model` when given, else the chain's first route; the tier ladder is not walked and there is no capacity fallback and no retry. Model syntax is a bare alias (`opus`/`sonnet`/`haiku`) or a full model id; a `:variant` suffix is rejected with an explicit error naming the limitation (never silently ignored) — for `--model` this fails at command start with a nonzero exit, before any job is dispatched.
- **Session resume.** The `session` option is honored — `--resume <session-id>` is appended to argv, so chain rework rounds, chain-resume, and `--session` / `--resume-last` continue the previous session instead of starting blank (the claude session id is a UUID the CLI returns in its JSON result; transcripts live under `~/.claude/projects/<cwd-slug>/`, and every kusabi dispatch runs with the same host cwd, so `claude -p --resume` finds them). Three session sources feed the dispatch: `task --session <id>` (explicit), `task --resume-last` (the previous same-backend task job's `sessionID` — see below), and the chain phases (a rework round passes the previous round's `sessionID`; `chain-resume` passes the last record's `sessionID`). The session id recorded on the job record comes from the CLI itself — the terminal result event, falling back to the stream's `system`/`init` event when the run died before a result — never pre-filled from the option, so a resumed dispatch records the same id the CLI returns. The single decision point for "may this session be resumed here" is `claudeDispatch`: an opencode-shaped id (`ses_*`) throws a loud cross-backend error naming both backends before anything is spawned (opencode sessions cannot be resumed on the claude backend — transcripts live under different roots). `--resume-last` filtering is SELECTION, not validation: it picks the previous job of the SAME backend as the current dispatch (records without the `backend` field predate the backend split and count as `"opencode"`), so a claude dispatch never silently resumes an opencode session and vice versa; when no same-backend job exists the error names the backend.
- **Watchdog — v1 no-op, live since kusabi #215 Job B.** v1 shipped with `watchdogS` as a documented no-op: the child was bounded only by `timeoutS`, because there was no event stream to measure silence against. Since the NDJSON stream (above), `watchdogS` is LIVE: no parsed stream event for `watchdogS` seconds kills the child's whole process group — the exact same kill `timeoutS` uses — and the job finishes `status: "stalled"` with the opencode watchdog's own error wording (`watchdog: no events for <N>s (process killed)`), so a chain treats a stalled claude worker exactly like a stalled opencode one. `timeoutS` is unchanged: an absolute wall-clock bound, independent of stream activity, still reporting the same `timeout` status/text. What it does NOT catch is a worker that is busy and producing nothing — reading files forever keeps events flowing and holds this watchdog off indefinitely; that is the write-tool watchdog's job (next bullet).
- **Write-tool watchdog — off by default, config-only (kusabi #215 item 3).** The recorded incident: an implement-phase claude job that ran 256s, cost $2.39 and made **zero edits** — chatty, busy, and never silent enough for the watchdog above. A second clock therefore measures the time since the last *file-mutating* tool call, and is armed only when `~/.kusabi/config.json` asks for it: `{ "claude": { "writeWatchdog": { "warnS": 300, "killS": 900 } } }`. **Defaults off**: no config file, or no `claude.writeWatchdog` key, and the dispatch and the job record are byte-identical to before (the record grows a `writeWatchdog` field only when the watchdog is actually armed); `writeWatchdog: false`, `0` or a negative number (quoted or not) disable it explicitly — the session guard's `false / 0 / <0 → OFF` convention, same config file. **Warn then kill**: at `warnS` with no write yet it warns EXACTLY once — a `companion.write-watchdog.warned` event (carrying the measured idle seconds) plus `job.writeWatchdog.warned/warnedAt/idleS` — and only at `killS` does it kill the child's whole process group, exactly as the silence watchdog does, writing `companion.write-watchdog.fired` + `companion.write-watchdog.kill` (naming parity with the silence pair from day one). Killing is opt-in ON TOP of warning: `killS` absent or `0` is warn-only forever, and a `killS` that is not strictly later than `warnS` is dropped to warn-only rather than normalized upward (killing on a bound the operator never wrote would break the warn-before-kill contract). A **malformed** value (unparseable string, a negative `warnS`/`killS` field, boolean field, bare positive number) resolves to warn-only at the default `warnS` of 300s and records the reason — it can never yield a killing configuration; this deliberately differs from the session guard's "malformed → default ON" rule, because refusing a dispatch is conservative while killing a live job is destructive. **Phase gating**: armed only for `phase === "implement"` — which every chain rework round dispatches under (`runImplementPhase` passes it for round 1 and every rework round; `models.phases.rework` selects a model, not a phase name) — so review / investigate / draft / respond / salvage / gofer, and any dispatch naming no phase, can never trip it. A **write** is a `tool_use` whose name, after the `mcp__<server>__` prefix is stripped, is one of `write_file`, `edit_file`, `transform_file`, `undo_file_edit`, `checkpoint_restore`, or a native `Write` / `Edit` / `MultiEdit` / `NotebookEdit`; reads, searches, `sandbox_exec`, `verify_in_container` and a plain `checkpoint` deliberately do not count — they are exactly what the incident job did all day. A kill finishes the job `status: "stalled"` (so a chain treats it like any other stall) with its own **distinct** error text — `write-watchdog: no write-tool call for <killS>s on an implement phase (process killed)` — never the silence watchdog's wording, because the two failures have different causes and different fixes. The whole machinery fails open: its config read, its timer body and its event appends are wrapped, and it can neither break the dispatch nor take down the silence watchdog's kill path.
- **Repeat-tool watchdog — off by default, config-only (kusabi #234).** The two clocks above are both TIME-based, so a worker that calls the SAME tool with the SAME arguments holds them both off forever: every call is a parsed event (silence clock reset) and, for a write tool, every call is a write (write clock reset). The write watchdog's recorded incident was "chatty but never writing"; this one's neighbour failure is "chatty, writing, and saying the same thing every time". This third watchdog therefore **counts instead of timing**: a chain keyed on `(tool name, deep-key-sorted JSON.stringify(input))` folds at the same point the write watchdog already observes (assistant event → `message.content[]` → `tool_use` blocks), so it needs no new I/O and has no clock to poll — the kill lands the instant the `killThreshold`-th identical call arrives. Armed only on an implement-phase dispatch and only when `~/.kusabi/config.json` carries a `claude.repeatWatchdog` key; at `threshold` it warns EXACTLY once (`companion.repeat-watchdog.warned`, carrying a truncated argument preview, also recorded on the job) and at `killThreshold` it kills the child's whole process group exactly as its two siblings do, finishing `status: "stalled"` with its own **distinct** error text — never the silence or write watchdog's wording, by the same rule that separates those two. Four invariants adopted from deepseek-harness's `repeat-tool-reminder` (shiori-indexed): arguments normalize by **deep key sort**, so two inputs differing only in property ORDER count as identical (arrays keep their order — element order is part of the arguments); **untracked bookkeeping tools are TRANSPARENT to the chain** — `TodoWrite` / `todo_write`, matched after the `mcp__<server>__` prefix is stripped, neither increment nor reset it, so `edit_file X → TodoWrite → edit_file X` is still two consecutive identical calls, while a bookkeeping tool that is ITSELF the repeated call is detected like any other (transparency means "ignored", not "exempt"); **denied calls count**, because kusabi is allowlist-based and a model hammering a tool kusabi refuses is exactly the loop worth breaking; and **identity comparison always uses the FULL normalized string** — the 200-character preview (`CLAUDE_REPEAT_ARGS_PREVIEW_MAX`) exists for the event record and is never a comparison input. An invalid threshold setting fails **loudly at load** — never a silent fallback, never a killing configuration the operator did not write. Deliberately not adopted: dsh's advisory injection (kusabi observes the NDJSON from OUTSIDE `claude -p` and has no path to nudge the running child, so warn and kill are the only levers) and fuzzy/approximate argument matching (a one-character variation escapes it; that is accepted).
- **Two permission allowlists.** implement and review, hardcoded in `claude-dispatch.mjs` mirroring the permission tables of `opencode-agents/kusabi-implement.md` and `kusabi-review.md` (the strategist dispatch — agent `kusabi-investigate` — runs the review-shaped toolset `reviewDenyTools`, so it maps to the review allowlist). Passed via `--allowedTools`; `--dangerously-skip-permissions` is never passed. The opencode `tools` deny map is applied to the allowlist so an explicit deny is never silently ignored. Agents with no v1 allowlist are a clear error.
- **Deny belt-and-braces (`--disallowedTools`).** Independently of the allowlist, a hardcoded deny list removes the tools a worker must never run even if an allowlist bug or settings leak would grant them: `mcp__sunaba__publish`, `mcp__sunaba__sandbox_pr_review_write`, `mcp__sunaba__secret_scan_override`, `mcp__sunaba__sandbox_stop`, `mcp__sunaba__sandbox_initialize`, `mcp__sunaba__copy_file`, `mcp__sunaba__copy_project`, `mcp__sunaba__run_container_and_exec`, and the CLI's own `Bash`/`Edit`/`Write`/`NotebookEdit` (a worker acts exclusively through the sunaba MCP tools). The single exception is `mcp__sunaba__sandbox_issue_write` for agent `kusabi-investigate` — its deliverable is appending the brief to the issue; for every other agent (including the strategist, whose review-shaped deny map still strips it from the allowlist) it stays denied.
- **Settings independence (`--strict-mcp-config` + `--setting-sources ""`).** The session applies ONLY the generated `--mcp-config` — no ambient settings (permissions.json, CLAUDE.md, project/user settings, other installed MCP servers) reach the worker. Field-verified: with these flags an MCP tool call without a matching `--allowedTools` entry is blocked, and the same call succeeds once the tool is allowlisted — the allowlist is the sole permission source, deny-by-default.
- **MCP.** `--mcp-config` points at a generated file containing ONLY the `sunaba` entry extracted from the host `~/.claude.json` (`mcpServers.sunaba`; source overridable via `KUSABI_CLAUDE_MCP_SOURCE`). Extract, profile rewrite, and the generated file live in `claude-mcp.mjs`. A missing entry is a clear error naming the source path.
- **System prompt.** the opencode `agent:` name maps to `opencode-agents/<agent>.md`; the YAML frontmatter is stripped and the body passed via `--append-system-prompt`.

**Failure semantics.** Every failure mode — spawn error, nonzero exit, unparseable/garbage stdout, `is_error: true`, timeout — produces a failed job record (status `error` or `timeout`) whose `error` field carries the underlying text; the chain's existing escalate path handles it (no retry, no fallback). Config-level problems (missing MCP entry, unsupported agent, `:variant` model, missing agent file) throw, so they surface as clear errors with a nonzero exit instead of stuck `running` records.

**Quota-exhaustion classification (kusabi #215).** The terminal payload of an `is_error: true` result is classified before it collapses into a generic error: `classifyClaudeTerminalFailure` reads `api_error_status` / `terminal_reason` / `result` and, when it finds HTTP 429 or an unambiguous quota phrase (`session limit`, `rate limit`, `spend/daily/monthly limit`, `limit reached/exceeded`, `too many requests` — every alternative a qualified multi-word phrase; bare words like `quota` or `resets` match unrelated failure prose and a false positive here hard-stops the chain), records a STRUCTURED classification on the job record — `job.failure = { kind: "quota-exhaustion", quota: "session" | "rate" | "unknown", backendBlocked, reset }` — never derived by grepping `error` prose. The classification says which quota it is (`session` when the text identifies the session limit), carries the reset time when the payload has one (`resetAt`/`reset` field, else the "resets <when>" phrase in the result text), and marks `backendBlocked` — true ONLY for the session limit, because a session-limit 429 blocks the whole claude backend for the account window, including the operator's own Claude Code session; per-model/per-request rate limits do not imply that. A classified quota failure gets status `provider-error` (so the chain's provider-exhaustion stop fires) and an operator-facing `error` that says which quota, the reset time, that the whole backend is blocked (session case), and to **switch the phase to the opencode backend (`--model <provider>/<model>` — the identifier carries its backend, kusabi #210) and NOT retry claude** — retrying, or walking other claude models, is actively wrong under a session-limit block. The chain's failed-round surface (`renderProviderExhaustedOutcome`) then shows that classification instead of the generic error text, and drops its generic "Retry when provider is available" footer for classified failures (that advice would contradict the classification). `subtype` is NEVER consulted — a terminal payload can carry `subtype: "success"` next to `is_error: true` (real 2026-08-11 payload); the failure signal is `is_error` alone. A generic `is_error: true` payload without quota markers is untouched: same `error` status, same `claude dispatch failed: <text>` error, `job.failure` stays `null`. Classification is conservative on purpose — a bare word like "exhausted" (e.g. "context window exhausted") does not classify.

**Stats — structural in v1, measured since kusabi #215 Job B.** v1 shipped with no event stream (`--output-format json`), so the claude job record's `stats` object was marked `instrumented: false` with null/empty counters (`events`, `steps`, `lastTool`, `permissionsAllowed`, `permissionsRejected`, `lastActivity` all `null`, `models: []`) — distinguishable from the opencode path's measured zeros by the marker alone, never by guessing from `backend`. Since the NDJSON stream (above), every new claude dispatch marks `stats.instrumented: true` and populates the counters FROM the parsed events: `events` (parsed event lines — an unparsed line, per the dispatch section above, is counted separately and never bumps this), `steps` (assistant `tool_use` content blocks), `lastTool` (the most recent `tool_use` block's name), `lastActivity` (ISO timestamp, refreshed on every parsed event), and `models` (deduped from assistant `message.model`). `permissionsAllowed` / `permissionsRejected` stay `0` — the stream carries no permission-decision events to measure. The on-disk job record is saved at a bounded cadence (not on every single event, but not only at exit either) so `/kusabi:status` shows the counters moving while the child is still running. `instrumented: false` now identifies ONLY legacy/pre-#215 records already on disk; `/kusabi:status` keeps its "stats: not instrumented" rendering for exactly those, never for a record this dispatch wrote. Counters stay present (not absent) either way, so existing readers keep working unchanged: `?? 0` / `?? "-"` rendering and the serve-lifecycle idle-reap fallback (`stats.lastActivity ?? startedAt`) — which an instrumented record no longer needs, since its `lastActivity` is real, but which still covers legacy records exactly as before.

**Live quota feed (kusabi #215 Job B).** The stream can carry `rate_limit_event` lines — `{ rate_limit_info: { status, resetsAt, rateLimitType, overageStatus, isUsingOverage }, … }`, `resetsAt` in epoch seconds — independent of whether the job ever fails. The most recent one is persisted machine-readably as `job.rateLimit = { info: <rate_limit_info>, observedAt }`, so an operator can read the account's live quota state off any job record, not just a failed one. (The pre-dispatch `/usage` guard this bullet once called future has since shipped in `claude-session-guard.mjs`: `claude.sessionGuardPercent` in `~/.kusabi/config.json` — default 90, `true` takes the default, `false`/`0`/negative disables — probes the session window with the free `claude -p --output-format json "/usage"` call and REFUSES the dispatch before the spawn when the window is already that spent, recording the observation on `job.sessionGuard` and the events trail. It is opt-in, and a malformed setting resolves to the guard ON at the default threshold — the opposite of the write watchdog's malformed rule, because refusing a dispatch is conservative while killing a live job is destructive. Operational detail and the `/usage` stability caveat live in the README.) When a terminal quota-classified failure's own payload names no reset (no `resetAt`/`reset` field, no "resets …" phrase in `result`), `classifyClaudeTerminalFailure`'s second argument — `{ rateLimit }` — fills the classification's `reset` from `rate_limit_info.resetsAt` (rendered as an ISO timestamp); payload text and structured fields still win whenever present, so this is a fallback, never an override.

#### 3.5.12 per-phase backend mixing — implemented (kusabi #192)

Cross-family review catches [high] findings the same-family review misses, in both directions (measured 2026-08-09): the chain must be able to run implement on one backend and review on another. This section is axis 1 of kusabi #192: **per-phase backend selection via config**. Per-round tiering (strong round 1 → cheap rework) is a separate follow-up; nothing here changes `applyTierEscalation` / `recordReworkEscalation` semantics or the default models.

**Entry-prefix syntax.** Config chain entries (`models.chain` and `models.phases.<phase>`) may carry an explicit backend prefix: an entry of the form `claude/<model>` selects the claude backend with model `<model>` — a bare alias (`opus`/`sonnet`/`haiku`) or a full claude model id (e.g. `claude-sonnet-4-5`); a `:variant` suffix stays rejected exactly as today. Any entry WITHOUT the prefix is an opencode `provider/model[:variant]` route, byte-identical to before. `claude` is not an opencode provider name, so the prefix is unambiguous. The built-in default chain remains opencode.

The prefixes live in ONE table (`BACKEND_ENTRY_PREFIXES` in `cli.mjs`), which is what made the third backend a row rather than a branch: `agy/<model>` (kusabi #199, §3.5.14) was added there, and `splitRouteBackend` / `resolveChainBackend` / `stripBackendPrefixChain` / `chainNamesBackend` picked it up unchanged. opencode deliberately has no row — it is the unprefixed default, which is what keeps every pre-prefix config byte-identical.

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

**Resume / persistence symmetry** (learned from the axis-1 findings — the persistence and exhaustion paths must not diverge). `chain.json` gains `reworkModel` / `reworkModelChain` / `reworkBackend`, persisted by `persistChainState` (`chain-phases.mjs`) AND `handleProviderExhaustion` (`chain-outcomes.mjs`, kusabi #439) symmetrically. chain-resume resolves them with the key-absence-is-legacy rule (mirror of `resolveResumeReviewContext`): absent keys fall back to the implement values; persisted null stays null (no rework key at chain start). Rework rounds re-dispatch on the rework backend/model, with the rework seam always explicit — a claude rework backend resumes clamped to the recorded rework model, an opencode rework backend on the plain opencode dispatch (never the other backend's implement dispatch).

**Strategist unchanged.** The strategist keeps following the implement resolution.

**Chain-start banner.** The banner (`tiers=N, maxRounds=M …`) must not lie when a rework chain is configured: it prints both counts (`tiers=N, reworkTiers=P`) and computes the “can reach top tier” claim against the chain the ladder actually climbs (the rework chain's count when configured, the implement chain's otherwise). Tier counts are backend-aware: a chain on a model-pinning backend (claude, agy) counts as ONE tier (min(1, length)) in the banner and in the escalation records — those dispatches pin every phase to the command-start model, so their ladder never climbs and `tierAfter` can never exceed 0 on such a ladder. The rule is stated over `backendPinsModel`, not over one backend's name.

#### 3.5.14 agy backend — implemented, resume via `--conversation` (kusabi #199 / #316)

`chain` and `task` accept `--backend opencode|claude|agy|cursor`, config chain entries accept an `agy/<model>` prefix, and `--model agy/<model>` pins a phase to it. **Why a third backend:** agy (the Antigravity CLI) draws on a separate quota pool — Gemini, metered apart from both existing pools — and adds a third model family, which is what cross-family review needs. Unlike a read-only-tool backend there is **no phase restriction**: any phase may route to agy.

**Dispatch.** `plugins/kusabi/scripts/agy-dispatch.mjs` exports `agyDispatch` with the same call/return contract as `dispatchWithFallback` / `claudeDispatch` (`{ job, resultText, stateDir }`), selected per phase by `resolveDispatchBackend` exactly like the other two. It spawns the Antigravity CLI headlessly with the field-verified invocation and **nothing else**:

```
agy -p <prompt> --output-format stream-json --model <id> --print-timeout <duration> [--json-schema <schema>] [--conversation <id>]
```

`--conversation <id>` is the resume path: the CLI continues the conversation
whose id is given (kusabi #316). It is appended by `buildAgyArgs` only when a
conversation id is supplied, so a fresh dispatch carries no resume flag at
all. `--print-timeout` is the INNER bound and is always present (kusabi
#326/#327): without it the CLI's own 5-minute default killed every dispatch
silently. `--output-format stream-json` replaced the single-object `json`
form in kusabi #332 (see the observability bullet below). The id recorded on the job is exactly what the CLI returns as
`conversation_id`, so `renderHeader` prints the continuation incantation
(`agy --conversation <id>`) next to it.

Binary via `AGY_BIN` (default `agy`; a WSL host install at `~/.local/bin/agy`). `--dangerously-skip-permissions` is **never** passed — it is not needed (the sunaba/shiori tools are auto-approved server-side) and the orchestrator-side classifier blocks it. Argv construction is a pure function (`buildAgyArgs`) covered by a test that asserts the complete argv, so an invented flag cannot slip in unnoticed. The prompt is on argv because that is the documented transport (the claude backend's stdin transport was separately field-verified; agy's has not been), which is an accepted v1 tradeoff: the prompt is visible in host `ps` output for the life of the child.

**MCP is the operator's, not ours.** agy reaches sandbox containers through the sunaba MCP server configured **globally** in `~/.gemini/antigravity-cli/mcp_config.json` — the same route Claude Code uses. This dispatch neither writes, validates, nor overrides that file (contrast the claude backend, which generates its own `--mcp-config`). If sunaba is not configured there, the worker simply has no container tools.

**Success is decided by PAYLOAD, not by `status`.** The CLI's terminal `result` event carries one JSON object: `{conversation_id, status, response, duration_seconds, num_turns, usage:{input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}}`, plus `structured_output` / `json_schema` on a schema run. (Before kusabi #332 that object WAS the entire output; the stream's `result.result` is the same object, so everything below is unchanged by the format switch — measured by running one prompt under both formats, 2026-08-20.) The outer `status` field is **not authoritative**: a run whose transcript contains any failed tool call reports `status: "ERROR"` even when the answer was delivered in full (observed 2026-08-11 — one MCP kwarg validation error mid-run, complete verdict returned). So `agyPayload` consults the payload alone: a non-empty `response` — or a present `structured_output` — is a **completed** job; a missing/empty payload is a **failed** job regardless of `status: "SUCCESS"`, with an error that quotes what was received rather than asserting what was not. `status` is recorded on the job as `agyStatus`, **advisory metadata** next to the status kusabi decided, so the disagreement is visible rather than inferred. Reading it the other way round would throw away completed, paid-for work on a mid-run tool typo. Exit code is treated the same way: a nonzero exit accompanying a complete payload is the same class of non-authoritative signal, and only a nonzero exit with **no** payload fails on the code.

**`--json-schema` is prevention for the review-verdict shape problem.** When the phase's output contract IS the review verdict (`agent: kusabi-review`), the dispatcher passes a schema derived from the **existing** contract — `schemas/review-output.schema.json`, the same file the review prompt embeds and `parseReviewResult` reads — so the CLI enforces the shape instead of the chain discovering prose where it expected JSON. One contract, two enforcement points. The resulting clean JSON arrives in `response` and flows through the **existing** extraction path (`extractJson` parses it trivially); there is deliberately no second parsing path, no schema registry, and no per-phase schema config key.

**Usage mapping keeps all five counters.** `input_tokens → input`, `output_tokens → output`, `thinking_tokens → reasoning`, `cache_read_tokens → cacheRead`, `total_tokens → total` (agy-only; no other backend reports one). `cacheWrite` and `cost` are `0`, not null: agy reports neither, and the shape's consumers sum these fields, so `0` correctly means "nothing to add". Dropping `thinking_tokens` would silently discard the bulk of a reasoning model's billable output — exactly the number a "which backend costs what" question turns on.

**Model ids are NOT enumerated in kusabi.** As of 2026-08-10 the CLI offers `gemini-3.6-flash-high|medium|low`, `gemini-3.5-flash-high|medium|low`, `gemini-3.1-pro-high|low`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium` — and this list WILL drift. **The agy CLI is the validator of record**; kusabi validates only the shape (non-empty, no `:variant` — rejected exactly as `claude/` rejects it, with an error naming the offending entry). A model added upstream therefore works the day it ships. The default chain (`AGY_DEFAULT_CHAIN`) is one tier, since this backend walks no ladder; its id is a starting point, not a contract.

**v1 limits.**
- **One model per phase** — `explicitModel` or the chain's first route; no tier ladder, no capacity fallback, no retry walk. Same shape as the claude backend's v1 (§3.5.11), so `clampModelDispatch` and `effectiveTierCount` apply to it through `backendPinsModel` rather than through a second `=== "agy"` branch.
- **Resume, gated on positive provenance.** `conversation_id` is recorded as the job's `sessionID`, and `--session <id>` / `--resume-last` on an agy dispatch continue the conversation via `--conversation` — **only** when the job store proves the id is an agy conversation (see the symmetric guard below). An id whose provenance cannot be established, or that the store attributes to another backend, is refused before anything spawns. `backendSupportsResume("agy")` is true, so the chain seams treat agy exactly like claude: `runImplementPhase` carries the lineage (a rework round continues the previous round's agy conversation) and chain-resume's `initialSession` is honoured, both with the provenance signal riding alongside. `useNewSession` still forces a fresh dispatch on agy as on every backend.
- **Observable since kusabi #332 (was: no event stream).** v1 dispatched with `--output-format json`, which prints one object at the very end — nothing to measure while the job ran, so `job.stats` was marked `instrumented: false` and `watchdogS` was documented as not applicable. Since #332 the dispatch uses `--output-format stream-json` and folds the NDJSON as it arrives, so `stats` is MEASURED (`instrumented: true`, real `events` / `steps` / `lastTool` / `lastActivity` / `models`, saved to disk at a bounded cadence so `/kusabi:status` moves while the child runs) and `watchdogS` is LIVE, killing the child's whole process group on silence exactly as the claude backend's silence watchdog does. `instrumented: false` now identifies only pre-#332 agy records. Three properties of the real stream decide the details, all measured 2026-08-20 against the live CLI: (1) the discriminator key is **`event`**, not claude's `type`, with values `init` / `step_update` / `result`, so the two folds share no code; (2) a tool step is re-emitted under the SAME `step_index` for each state transition (`ACTIVE`, then `DONE` or `ERROR`), so `steps` counts once per index rather than once per line — counting lines would treble every tool call; (3) the CLI emits **nothing at all, not even `init`, for the first ~11 seconds** of a healthy run, so the armed watchdog interval is floored at `AGY_WATCHDOG_FLOOR_S` (120s) no matter what the caller passes — a shorter interval would kill correct runs on every dispatch. `permissionsAllowed` / `permissionsRejected` stay `0`: the stream carries no permission-decision events. A stream that ends with no terminal `result` event still records the `conversation_id` seen on `init`, so the run stays resumable.
- **Bound ordering is unchanged (kusabi #326/#327).** `timeoutS` remains the OUTER wall-clock bound and its kill targets the child's whole process group; `--print-timeout` remains the INNER bound kusabi sets so the outer one always expires first. The silence watchdog is a third, independent bound and does not disturb that ordering.
- **No per-job tool permissions.** agy takes no allow/deny flags. An operator-typed `--read-only` / `--deny` is **rejected at command start** — a restriction that cannot be applied must never look applied — while a phase-level deny map from the chain (which nobody typed, and refusing which would break every chain routing a phase here) is recorded on the job as `toolDeniesUnenforced` so the record cannot be mistaken for one where the denies took effect.
- **No quota classification** beyond the payload rule. It waits for the first real agy quota failure in the wild; #215's claude classification is the template. Guessing at phrases never observed is the false positive that hard-stops a chain.

**The cross-backend session guard is SYMMETRIC.** Before #199 only claude guarded (`ses_*` → claude). Now `assertSessionBackendCompatible` (kusabi-companion.mjs) checks an explicitly named `--session` against the backend it would run on, using two independent signals in order: **shape** (`ses_*` is unmistakably opencode and needs no record — same wording claudeDispatch's own guard uses, so an operator never meets two phrasings of one rule), then **provenance** (a claude session id and an agy `conversation_id` are BOTH bare UUIDs, so shape can never separate them; the job record that reported the session names the backend that made it). Every rejection names both backends. A session with no telling shape and no owning record is left alone at command start — the operator may be resuming something kusabi never dispatched — but the agy dispatch fails closed on it: `assertNoAgySession` (agy-dispatch.mjs) is the backstop for callers that skip the command-start check, and an unproven bare UUID is refused there rather than silently handed to `--conversation`. Since #316 the seams that carry a session *implicitly* treat agy as resumable and thread the same provenance signal (`sessionProvenance`, derived from the owning job record where the store is in hand — cmdTask, cmdChain, cmdChainResume — and from the previous round record inside `runImplementPhase`), so a chain routed to agy continues its conversation across rework rounds instead of dropping it. The #192 invariant still holds: a session never crosses backends — a claude-owned id is refused on agy and an agy-owned id on claude, whether explicitly named or carried by a seam.

**Metrics need no new machinery.** `backend` / `reviewBackend` are stored **verbatim** as TEXT by ingest and grouped verbatim by the report (`row.backend ?? "opencode"`), so `"agy"` appears as its own bucket in the by-backend split the moment such a record exists — not folded into another backend, and with legacy fixtures (no backend fields at all) still storing `NULL`, never a default. A round whose implement ran on claude and whose review ran on agy makes the chain `"mixed"` by the existing §3.5.8 union rule, which is the honest label.

#### 3.5.15 `install-cli` and the Cursor-facing surface — implemented (kusabi #237 / #247 / #252)

kusabi is driven from more than one orchestrator harness. Claude Code reaches it through the plugin; the Cursor CLI has neither a plugin mechanism nor a session id in the environment, so two small pieces exist to close that gap. Both are **host-side wiring**, not chain machinery — no phase, no dispatch, no LLM.

**`install-cli` — the shim and the link set.** Writes a `kusabi-companion` shim to `$KUSABI_BIN_DIR` (default `~/.local/bin`) and symlinks the `delegate` / `kusabi-result-handling` skills into `$KUSABI_CURSOR_DIR/skills` (default `~/.cursor/skills`) when that directory exists. `--cursor-rule` additionally links the `alwaysApply` delegate rule into `<cursor dir>/rules`; it is **opt-in on purpose**, because an alwaysApply rule taxes every conversation on the machine, kusabi-related or not.

The re-run rule follows from what is a link and what is a copy: **each link's CONTENT follows the working copy, so a merged edit is live immediately — but a name newly ADDED to the link set has no link until `install-cli` runs again.** Membership is the only thing that does not self-heal, which is why the update procedure calls for a re-run when the shim changes or a name joins the set, and not otherwise. (The plugin cache is the opposite case — a snapshot copy that freezes at install time; see the `update` skill.)

**`cursor-statusline-sink` — recovering a session id.** Wired as `statusLine.command` in `~/.cursor/cli-config.json`. Cursor launches it on every conversation update, feeds a JSON payload on stdin, and displays the first stdout line. It exists because `CLAUDE_CODE_SESSION_ID` has no Cursor equivalent: the sink records what Cursor reports so the companion can recover the orchestrator session id afterwards. Three contract points must not be broken — **exit 0 always** (a dead statusline is worse than a short error string), **exactly one stdout line**, and completion well inside Cursor's 2s timeout, which is why the file is sync I/O only.

On-disk format (the companion's reader contract): one JSON object per line under `$KUSABI_CURSOR_USAGE_DIR` (default `$HOME/.kusabi/cursor-usage`), named `<session_id>.jsonl`, each record `{ts, session_id, model, cwd, context_window}`. A line is suppressed only when the WHOLE `context_window` object is identical to the previous line's. Sessions whose last line is older than 24h are ignored by the companion lookup — enough for an overnight resume of the same Cursor CLI session, without gluing last week's abandoned file onto a new job.

**Hazard: this is a sampler, not a ledger — and one line is NOT one turn (kusabi #252).** `current_usage` is a snapshot of the MOST RECENT TURN, and the sink re-appends it verbatim whenever any *other* `context_window` field (`used_percentage`, `total_input_tokens`, …) moves during streaming: the whole-object comparison passes, exactly as designed, while `current_usage` has not changed at all. Measured on one real 3h47m session: **235 lines, zero adjacent pairs with an identical whole `context_window`, but only 28 distinct consecutive `current_usage` values** — one snapshot repeated up to 27 times. Taking one turn per line overstated that session's cost by **~7.6×**. So `parseCursorUsageContent` collapses each run of consecutive-identical `current_usage` into ONE turn; the sink is behaving correctly and is not the place to fix this. Separately, because the statusline only records what Cursor last reported when it refreshed, API calls between refreshes are dropped — ingested totals are a lower bound, never a ledger.

`cursor-usage-ingest.mjs` keeps the same split as `transcript-ingest.mjs`: `parseCursorUsageContent` is pure (string in, turns out, unit-testable with inline fixtures), and `ingestCursorUsageDirectory` is the only piece that touches the filesystem or the database, delegating every row write to `metrics-db.mjs`'s helpers rather than opening a database itself.

#### 3.5.16 cursor backend — implemented, resume via `--resume` (kusabi #374)

`chain` and `task` accept `--backend cursor`, config chain entries accept a `cursor/<model>` prefix,
and `--model cursor/<model>` pins a phase to it. **Why a fourth backend:** the Cursor CLI draws on a
subscription pool separate from all three existing ones, and on 2026-08-23 the opencode free tier and
the agy quota ran out within an hour of each other while Cursor stayed available. It was already in
daily use as a HAND seat (implement and independent review); the adapter is what puts those jobs
inside a chain — probes, review seat, records, `chain-wait` — instead of beside it. Note the
difference from §3.5.15: that section is the Cursor-facing ORCHESTRATOR surface (shim, statusline);
this one is Cursor as a WORKER.

**Dispatch.** `plugins/kusabi/scripts/cursor-dispatch.mjs` exports `cursorDispatch` with the same
call/return contract as `dispatchWithFallback` / `claudeDispatch` / `agyDispatch`
(`{ job, resultText, stateDir }`), selected per phase by `resolveDispatchBackend`. Field-verified
invocation, and nothing else:

```
cursor-agent -p --approve-mcps --force --output-format stream-json [--model <id>] [--resume <sessionId>]
```

**The prompt is on stdin**, so this backend has no argv-size ceiling (contrast agy's 128KiB limit).
Binary via `CURSOR_BIN` (default `cursor-agent`).

**`--model` is passed only when a model was explicitly pinned.** Passing it writes the choice into
`~/.cursor/cli-config.json` and changes every later invocation on that machine, including interactive
ones — so the default chain entry is the literal `default`, meaning "whatever the CLI is configured
to use", recorded as the model so the job record stays honest. The adapter never writes under
`~/.cursor/`; a pinned run instead records `modelResidueHazard` on the job, so the residue is visible
after the fact rather than repaired behind the operator's back.

**Stream vocabulary (measured 2026-08-23).** NDJSON on stdout, discriminated by `type` — the claude
vocabulary, not agy's `event`: `thinking` (`subtype: delta|completed`), `assistant`
(`message.content[]`), `tool_call` (`subtype: started|completed`), `system`(`init`), `user`,
`connection`(`reconnecting|reconnected`), `retry`(`starting|resuming`), and the terminal
`{"type":"result","subtype":"success","is_error":false,"result":"<text>","session_id":"…",
"usage":{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}}`. Success is decided by
**payload presence** (a non-empty terminal `result`), the same rule agy needed; `is_error` is
recorded as advisory on `cursorIsError`.

**Step accounting is by `call_id`, and the tool name is not the wrapper key.** Both facts are
measured over a real 33-minute run, not assumed: every `tool_call` line carries a top-level
`call_id`, and the run held **162 distinct ids against 156 `started` lines** — counting `started`
under-counts, counting distinct `call_id` is exact (a `completed` whose `started` never arrived
still counts). Inside `tool_call` the wrapper key distribution was `mcpToolCall` 290 /
`getMcpToolsToolCall` 14 / `readToolCall` 14, so for the dominant case the real tool name is
`tool_call.mcpToolCall.args.name` (`sunaba-edit_file`); taking the wrapper key would label 91% of
calls `mcp` and destroy exactly the diagnostic value `lastTool` exists for. Other keys drop the
`ToolCall` suffix (`readToolCall` → `read`). Replaying the two real streams through the accumulator
yields `steps: 162 / lastTool: sunaba-edit_file` and `steps: 249 / lastTool: sunaba-diff_in_container`.

**Resume is real and carries context.** `backendSupportsResume("cursor")` is true because it was
measured, not inferred: a fresh call answered a token, a second call with `--resume <session_id>`
recalled it with `inputTokens` 143 instead of 10,543 — the transcript lives server-side and is not
re-sent. This is what agy cannot do (`--conversation` aside, its rework rounds rebuild the whole
prompt), so a cursor chain's rework rounds continue the same conversation.

**Denies are not enforceable from our side**, exactly as with agy: a job routed here records
`toolDeniesUnenforced` rather than pretending the constraint holds.

#### 3.5.17 a dead seat is not an unreadable verdict (kusabi #373)

`verdict: "unparseable"` means **a payload arrived and could not be read**. A seat that produced no
payload at all — the pool was empty, the process was killed, the adapter threw — is a different
state, and conflating the two costs real rounds: on 2026-08-23 a review seat died on
`Individual quota reached … Resets in 1h1m21s`, was recorded as `unparseable` with
`reviewJobFailure: null`, and `chain-resume` bought an identical replacement seat that died 33
seconds later into the same dead quota.

Three fields carry the distinction, and they are separate on purpose:

| field | meaning |
|---|---|
| `verdict` | unchanged — `unparseable` still means an unreadable payload |
| `reviewJobError` | the failure TEXT, written **only when the job carried one**, so a healthy round's record is byte-identical to before |
| `reviewJobFailure` | the STRUCTURED fact: the adapter's own `job.failure` when it set one (claude, since #215), otherwise classified from the error text |

**Classification matches observed phrases only** (`classifyDispatchQuotaExhaustion`): `Individual
quota reached` (agy) and `Free usage exceeded` (opencode), by substring so a variable
`Resets in <duration>` cannot defeat it, with the duration captured when present. A generic
`quota reached`, a claude `session limit`, or `All routes exhausted` deliberately do NOT classify —
the same rule agy's own quota handling states: **a false positive hard-stops a chain that could have
continued**, so an unobserved wording waits for its first real sighting rather than being guessed.

A third terminal state exists and is neither of the above: a **stalled** job
(`watchdog: no events for 900s (process killed)`, seen on the very chain that implemented this
section). Its text reaches `reviewJobError` through the same conduit, and it must not classify as an
exhausted pool — the pool is fine, the seat went quiet. What tells a stall from a hang is the job's
own instrumentation (`steps`, `lastTool`, `lastActivity`), which is why those fields being real
matters for every backend (§3.5.16).

**`chain-resume` refuses to re-buy a quota-dead seat.** The replacement-seat path exists for an
unreadable payload; when the recorded failure is quota exhaustion, an identical seat cannot work, so
the resume refuses and names the escape hatch. An explicitly different route
(`--backend`/`--model` naming another backend) still goes through — the refusal is about repeating a
known-dead route, not about locking the chain.

#### 3.5.18 stopReason — closed terminal-reason union (kusabi #380)

A dispatched worker job (or a chain round's implement job) ends in exactly one of a closed set of terminal reasons. `deriveStopReason` (`plugins/kusabi/scripts/stop-reason.mjs`) is the pure derivation function and single source of truth for the closed set:

- `completed`: Normal completion with changes made (`worktreeChanged: true`) or unmeasured substance (`worktreeChanged: null`).
- `empty-completion`: Completed session that executed steps (`stats.steps > 0`) but produced no worktree changes (`worktreeChanged: false`).
- `infra-death`: Completed session that executed 0 steps (`stats.steps === 0`) and produced no worktree changes (`worktreeChanged: false`).
- `quota-exhausted`: Dispatch failed with a non-null `capacityReason` (e.g. `free_tier_limit`).
- `provider-error`: Terminal provider error (`providerError.terminal === true` or status `provider-error`).
- `cancelled`: Explicitly cancelled session or status `cancelled`.

`unknown` is the failure sentinel for unmappable or unforeseen statuses (such as `serve-dead`, `timeout`, `stalled`, `error`). It is deliberately excluded from `STOP_REASONS`; consumers must treat `unknown` as a failure and never silently fold it into `completed`.

### 3.6 sunaba-rpc (raw JSON-RPC client) — implemented

`plugins/kusabi/scripts/sunaba-rpc.mjs`. A **raw HTTP+SSE client** for the companion's non-LLM pipeline (deterministic probes, etc.) to call sunaba's MCP tools. **Not an MCP client.**

- **Endpoint**: env `KUSABI_SUNABA_URL`, default `http://127.0.0.1:8750/mcp`. 127.0.0.1 (fixed, avoids IPv6 name resolution issues with localhost)
- **Protocol**: Streamable HTTP. `initialize` POST → save `mcp-session-id` from response header → `notifications/initialized` → `tools/call`
- **Response format**: SSE (`data:` lines). The last line's JSON is the result. Auto-unwraps MCP's `content[0].text` wrapper (`unwrapResult`)
- **Tool allow list (hardcoded)** — only the following tools. Calling anything outside the list throws a pre-call validation error:
  - `verify_in_container`
  - `sandbox_exec`
  - `checkpoint`
  - `checkpoint_list`
  - `copy_file`

  `copy_file` is the companion inject path for change-scope (#400/#401), not a
  worker grant.

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
rounds through the same path — it exits non-zero instead of running. The job-creating set, enumerated from the dispatch table rather than guessed:
`task`, `review`, `salvage`, `chain`, `chain-resume`, `chain-detach` (and alias
`chainDetach`). Everything else (`status`, `result`, `cancel`, `serve-stop`,
`chain-cancel`, `chain-show`, `chain-wait`, `chain-stats`, `metrics-ingest`,
`metrics-report`, `dashboard`, `install-agents`, `install-cli`, `baseline`,
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

