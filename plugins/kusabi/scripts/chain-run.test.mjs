import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildImplementText,
  runImplementPhase,
  runProbePhase,
} from "./chain-run.mjs";
import {
  resolveReworkScope,
} from "./chain-phases.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// =========================================================================
// Source guards (kusabi #447)
// =========================================================================

describe("chain-run source guards (kusabi #447)", () => {
  it("chain-phases.mjs does not export moved implement and probe functions", () => {
    const chainPhasesSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-phases.mjs"), "utf8");
    assert.ok(!chainPhasesSrc.includes("export function withContainerWorkspace("));
    assert.ok(!chainPhasesSrc.includes("export function buildImplementText("));
    assert.ok(!chainPhasesSrc.includes("export async function runImplementPhase("));
    assert.ok(!chainPhasesSrc.includes("export async function runProbePhase("));
  });

  it("chain-phases.mjs does not import chain-run.mjs", () => {
    const chainPhasesSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-phases.mjs"), "utf8");
    assert.ok(!chainPhasesSrc.includes('from "./chain-run.mjs"'));
    assert.ok(!chainPhasesSrc.includes("from './chain-run.mjs'"));
  });
});

// buildImplementText  —  pure, extracted from cmdChain (chain-phases.mjs)
// =========================================================================

describe("buildImplementText", () => {
  const brief = "# Fix the bug\n\nMake foo return bar.";

  it("round 1 returns the brief as-is", () => {
    const result = buildImplementText({ round: 1, brief, previousRecord: null });
    assert.equal(result, brief);
  });

  it("round 1 without container is the brief verbatim (no header)", () => {
    const result = buildImplementText({ round: 1, brief, previousRecord: null });
    assert.equal(result, brief);
    assert.ok(!result.includes("The workspace lives inside container"));
  });

  it("round 1 with container starts with the exact-ID header, then the brief verbatim", () => {
    const result = buildImplementText({ round: 1, brief, previousRecord: null, container: "abc123def456" });
    assert.ok(result.startsWith(
      "The workspace lives inside container `abc123def456`. Pass this exact ID as `container_id` to every sunaba tool call. Do not guess container names or call sandbox_attach.\n\n"
    ));
    assert.ok(result.endsWith(brief));
  });

  it("round 2+ with container keeps the header first, then the prior-findings structure intact", () => {
    const prev = { findingsText: "file: src/foo.js:42 — missing null check" };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev, container: "abc123def456" });
    assert.ok(result.startsWith(
      "The workspace lives inside container `abc123def456`. Pass this exact ID as `container_id` to every sunaba tool call. Do not guess container names or call sandbox_attach.\n\n"
    ));
    assert.ok(result.includes("## Prior findings"));
    assert.ok(result.includes("file: src/foo.js:42"));
    assert.ok(result.includes("## Acceptance criteria"));
    assert.ok(result.includes(brief));
    // The header must appear only once, before any other content.
    assert.equal(result.indexOf("The workspace lives inside container"), 0);
  });

  it("round 2+ includes prior findings and acceptance criteria", () => {
    const prev = { findingsText: "file: src/foo.js:42 — missing null check" };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev });
    assert.ok(result.includes("## Prior findings"));
    assert.ok(result.includes("file: src/foo.js:42"));
    assert.ok(result.includes("## Acceptance criteria"));
    assert.ok(result.includes(brief));
  });

  it("round 2+ shows (none) when no prior findings", () => {
    const prev = {};
    const result = buildImplementText({ round: 3, brief, previousRecord: prev });
    assert.ok(result.includes("(none)"));
    assert.ok(result.includes("## Acceptance criteria"));
  });

  it("round 2+ includes strategist recommendation when present", () => {
    const prev = {
      findingsText: "findings...",
      strategistRecommendation: "Use a Map instead of indexing a list",
    };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev });
    assert.ok(result.includes("Strategist recommendation"));
    assert.ok(result.includes("Use a Map instead of indexing a list"));
  });

  it("round 2+ with no previousRecord returns brief", () => {
    const result = buildImplementText({ round: 2, brief, previousRecord: null });
    assert.equal(result, brief);
  });

  it("round 2+ without strategistRecommendation omits the section", () => {
    const prev = { findingsText: "some findings" };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev });
    assert.ok(!result.includes("Strategist recommendation"));
  });

  it("includes body and recommendation of a prior finding when structured findings exist", () => {
    const prev = {
      findings: [
        {
          severity: "high",
          title: "Missing null check",
          file: "src/foo.js",
          line_start: 42,
          line_end: 45,
          confidence: 0.9,
          body: "The function bar() does not validate its input.",
          recommendation: "Add a null guard at the top of bar().",
        },
      ],
    };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev });
    assert.ok(result.includes("Missing null check"));
    assert.ok(result.includes("src/foo.js:42"));
    assert.ok(result.includes("The function bar() does not validate its input."));
    assert.ok(result.includes("Add a null guard at the top of bar()."));
  });

  it("includes the instruction that findings must be resolved or reported", () => {
    const prev = {
      findingsText: "some findings",
      findings: [
        { severity: "low", title: "Naming", file: "a.js", line_start: 1, line_end: 1, confidence: 0.5, body: "x", recommendation: "rename" },
      ],
    };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev });
    assert.ok(result.includes("## Instruction"));
    assert.ok(result.includes("Resolve each prior finding"));
    assert.ok(result.includes("cannot be fully resolved"));
    assert.ok(result.includes("explain why"));
  });

  it("marks truncation when the prior findings block exceeds the budget", () => {
    // Build a finding with a long body to exceed the 8000-char PRIOR_FINDINGS_BUDGET
    const longBody = "A".repeat(8100);
    const prev = {
      findings: [
        {
          severity: "medium",
          title: "Long finding",
          file: "big.js",
          line_start: 1,
          line_end: 10,
          confidence: 0.8,
          body: longBody,
          recommendation: "short fix",
        },
      ],
    };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev });
    assert.ok(result.includes("Prior findings truncated to"));
    assert.ok(result.includes("8000"));
  });

  it("does not mark truncation when the prior findings block is under the budget", () => {
    const prev = {
      findings: [
        {
          severity: "low",
          title: "Tiny issue",
          file: "small.js",
          line_start: 1,
          line_end: 2,
          confidence: 0.9,
          body: "Short body.",
          recommendation: "Fix it.",
        },
      ],
    };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev });
    assert.ok(!result.includes("Prior findings truncated to"));
    assert.ok(!result.includes("truncated"));
  });

  it("produces a usable prompt without throwing when previous record has no structured findings", () => {
    const prev = { findingsText: "[high] Old issue (old.js:5)" };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev });
    assert.ok(result.includes("## Prior findings"));
    assert.ok(result.includes("[high] Old issue (old.js:5)"));
    assert.ok(result.includes("## Acceptance criteria"));
  });

  it("produces a usable prompt without throwing when previous record is empty", () => {
    const prev = {};
    const result = buildImplementText({ round: 2, brief, previousRecord: prev });
    assert.ok(result.includes("## Prior findings"));
    assert.ok(result.includes("(none)"));
    assert.ok(result.includes("## Acceptance criteria"));
  });
});

// buildImplementText — scoped rework brief (kusabi #60 step 2)
// =========================================================================
// A scoped round renders ONLY its subset with the FULL per-finding renderer
// (bodies + recommendations, same budget bound as the full path — followup),
// prefixed by one sentence naming the scope.  The full-scope path must stay
// byte-identical to the pre-scheduling output.

describe("buildImplementText scoped rework brief", () => {
  const brief = "# Fix the bug\n\nMake foo return bar.";
  const mechFinding = {
    severity: "medium", title: "Rename variable", file: "src/b.js", line_start: 10,
    kind: "mechanical", body: "bad name", recommendation: "rename it",
  };
  const designFinding = {
    severity: "high", title: "API shape decision", file: "src/a.js", line_start: 1,
    kind: "design", body: "needs a decision", recommendation: "decide",
  };

  it("mechanical scope renders the mechanical subset with the scope sentence", () => {
    const prev = { findings: [designFinding, mechFinding] };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev, reworkScope: resolveReworkScope(prev) });
    assert.ok(result.includes("This round resolves ONLY the following mechanical checklist; other known findings are deliberately out of scope this round."));
    assert.ok(result.includes("## Mechanical findings (checklist)"));
    assert.ok(result.includes("Rename variable"));
    assert.ok(!result.includes("API shape decision"));
    // Followup: the scoped block is the FULL per-finding rendering — heading
    // with severity/location, body and recommendation, exactly like the
    // full-scope path — not a one-line summary.
    assert.ok(result.includes("### [medium] Rename variable (src/b.js:10)"));
    assert.ok(result.includes("bad name"));
    assert.ok(result.includes("**Recommendation:** rename it"));
    // The held-back design finding must not leak, including its body.
    assert.ok(!result.includes("needs a decision"));
    // Prompt structure stays intact around the scoped block.
    assert.ok(result.includes("## Instruction"));
    assert.ok(result.includes("Resolve each prior finding"));
    assert.ok(result.includes("## Acceptance criteria"));
    assert.ok(result.includes(brief));
  });

  it("design scope renders the single design finding with the scope sentence", () => {
    const second = { ...designFinding, title: "Second design", body: "second body" };
    const prev = { findings: [designFinding, second] };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev, reworkScope: resolveReworkScope(prev) });
    assert.ok(result.includes("This round resolves ONLY the following design finding; other known findings are deliberately out of scope this round."));
    assert.ok(result.includes("## Design findings (require deliberate individual treatment)"));
    assert.ok(result.includes("API shape decision"));
    assert.ok(!result.includes("Second design"));
    // Followup: full per-finding rendering of the scoped subset (heading,
    // body, recommendation); the held-back second finding's body stays out.
    assert.ok(result.includes("### [high] API shape decision (src/a.js:1)"));
    assert.ok(result.includes("needs a decision"));
    assert.ok(result.includes("**Recommendation:** decide"));
    assert.ok(!result.includes("second body"));
  });

  it("scoped brief keeps the container header first and the scope block after it", () => {
    const prev = { findings: [mechFinding] };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev, container: "abc123def456", reworkScope: resolveReworkScope(prev) });
    assert.equal(result.indexOf("The workspace lives inside container"), 0);
    assert.ok(result.includes("ONLY the following mechanical checklist"));
  });

  it("full scope is byte-identical with and without reworkScope", () => {
    const prev = { findings: [designFinding, mechFinding] };
    const plain = buildImplementText({ round: 2, brief, previousRecord: prev, container: "abc123def456" });
    const withScope = buildImplementText({ round: 2, brief, previousRecord: prev, container: "abc123def456", reworkScope: { scope: "full", findings: [] } });
    assert.equal(withScope, plain);
  });

  it("full scope is byte-identical even when reworkScope carries a findings subset", () => {
    // The full path ignores the subset — only the scope label decides.
    const prev = { findings: [mechFinding] };
    const plain = buildImplementText({ round: 2, brief, previousRecord: prev });
    const withScope = buildImplementText({ round: 2, brief, previousRecord: prev, reworkScope: { scope: "full", findings: [mechFinding] } });
    assert.equal(withScope, plain);
  });

  it("reworkScope absent falls back to the pre-scheduling full text", () => {
    const prev = { findings: [designFinding, mechFinding] };
    const result = buildImplementText({ round: 2, brief, previousRecord: prev });
    // No scope sentence, both findings present via renderPriorFindings.
    assert.ok(!result.includes("ONLY the following"));
    assert.ok(result.includes("API shape decision"));
    assert.ok(result.includes("Rename variable"));
  });
});

describe("phase functions carry the failure classification — runImplementPhase (kusabi #215)", () => {
  const QUOTA_FAILURE = {
    kind: "quota-exhaustion",
    quota: "session",
    backendBlocked: true,
    reset: "1:20am (Asia/Tokyo)",
  };

  function failingDispatch(status, failure) {
    return async () => ({
      job: {
        id: "job-fail", status, modelEntry: "opus", modelVariant: null,
        fallbacks: null, sessionID: null,
        usage: null, error: "claude dispatch failed: session limit",
        failure: failure ?? null,
      },
      resultText: "",
    });
  }

  it("runImplementPhase returns implementJobFailure from the failed job's record", async () => {
    const result = await runImplementPhase({
      cwd: "/tmp", chainId: "chain-test", round: 1, isFirstRound: true,
      implementText: "brief", modelChain: [["opus"]], tierIndex: 0,
      useNewSession: false, session: undefined, resumeMethod: { type: "fresh_session" },
      flagsModel: null, backend: "claude",
      _dispatchWithFallback: failingDispatch("provider-error", QUOTA_FAILURE),
    });
    assert.deepEqual(result.implementJobFailure, QUOTA_FAILURE);
    assert.equal(result.implementJobStatus, "provider-error");
  });

  it("runImplementPhase returns null implementJobFailure for a generic failure", async () => {
    const result = await runImplementPhase({
      cwd: "/tmp", chainId: "chain-test", round: 1, isFirstRound: true,
      implementText: "brief", modelChain: [["opus"]], tierIndex: 0,
      useNewSession: false, session: undefined, resumeMethod: { type: "fresh_session" },
      flagsModel: null, backend: "claude",
      _dispatchWithFallback: failingDispatch("error", null),
    });
    assert.equal(result.implementJobFailure, null);
    assert.equal(result.implementJobStatus, "error");
  });

  it("runImplementPhase classifies an agy quota error as implementJobFailure", async () => {
    const agyError = "agy dispatch failed: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h1m21s.";
    const result = await runImplementPhase({
      cwd: "/tmp", chainId: "chain-test", round: 1, isFirstRound: true,
      implementText: "brief", modelChain: [["gemini-3.6-flash-high"]], tierIndex: 0,
      useNewSession: false, session: undefined, resumeMethod: { type: "fresh_session" },
      flagsModel: null, backend: "agy",
      _dispatchWithFallback: async () => ({
        job: {
          id: "job-fail", status: "error", modelEntry: "gemini-3.6-flash-high",
          modelVariant: null, fallbacks: null, sessionID: null,
          usage: null, error: agyError, failure: null,
        },
        resultText: "",
      }),
    });
    assert.equal(result.implementJobStatus, "error");
    assert.equal(result.implementJobFailure.kind, "quota-exhaustion");
    assert.equal(result.implementJobFailure.backend, "agy");
    assert.equal(result.roundRecord.implementJobError, agyError);
  });
});

// ---------------------------------------------------------------------------

describe("runProbePhase return value", () => {
  // runProbePhase takes callTool as a parameter, so the capture is driven with
  // a stub that answers the two git commands with known output.
  function captureCallTool({ untracked = "", status = "", statusEnvelope = null, throwOn = null } = {}) {
    const commands = [];
    return {
      commands,
      callTool: async (toolName, params) => {
        if (toolName !== "sandbox_exec") return { output: "" };
        const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
        commands.push(cmd);
        if (throwOn && cmd.startsWith(throwOn)) throw new Error("container is gone");
        if (cmd.includes("change-scope.mjs")) {
          return {
            output: JSON.stringify({
              formatVersion: 1,
              repositoryRoot: "/workspace",
              input: { base: "abc1234", head: "HEAD" },
              resolved: { baseSha: "abc1234", headSha: "abc1234", mergeBaseSha: "abc1234" },
              paths: { committed: [], staged: [], unstaged: [], untracked: [] },
            }),
          };
        }
        if (cmd === "git status --porcelain") return statusEnvelope ?? { output: status };
        if (cmd.startsWith("git ls-files --others")) return { output: untracked };
        return { output: "" };
      },
    };
  }

  it("returns the untracked file list and never captures a diff", async () => {
    const { commands, callTool } = captureCallTool({ untracked: "src/brand-new.js\n" });

    const result = await runProbePhase({
      baseSha: "abc1234",
      container: "fake-cid",
      brief: "## Deliverables\n\n- `src/a.js`\n",
      callTool,
    });

    assert.equal(result.chainUntracked.trim(), "src/brand-new.js");
    assert.ok(
      commands.some((c) => c.startsWith("git ls-files --others")),
      "capture must list untracked files",
    );
    // The diff capture is gone, not widened (kusabi #208): it was one
    // default-paged sandbox_exec call, so it could only ever return page one,
    // and the reviewer fetches the diff itself with `diff_in_container`.
    assert.ok(
      !commands.some((c) => c.startsWith("git diff")),
      `no git diff may be captured, got: ${JSON.stringify(commands)}`,
    );
    assert.equal(result.chainDiff, undefined);
  });

  it("leaves the untracked field empty when the capture call throws", async () => {
    const { callTool } = captureCallTool({ throwOn: "git ls-files --others" });

    const result = await runProbePhase({
      baseSha: "abc1234",
      container: "fake-cid",
      brief: "",
      callTool,
    });

    // Degrades rather than throwing: renderBaseFacts then says "(unavailable)".
    assert.equal(result.chainUntracked, "");
  });

  it("carries what sandbox_exec said about each capture's own paging", async () => {
    // The status list is the one that can genuinely exceed a page, and the
    // rendered input must be able to say so.  The flags come from the server,
    // never from counting lines.
    //
    // The envelope mimics the live server: on a CUT response `shown` equals
    // `total_lines` (it is not the number of lines returned) and `next_offset`
    // is the count of lines returned.  A stub that set `shown` to 50 here
    // could not reproduce the defect that `shown` is unusable.
    const { callTool } = captureCallTool({
      statusEnvelope: {
        output: Array.from({ length: 50 }, (_, i) => " M src/f" + i + ".js").join("\n") + "\n",
        shown: 137,
        total_lines: 137,
        truncated: true,
        has_more: true,
        next_offset: 50,
      },
      untracked: "src/brand-new.js\n",
    });

    const result = await runProbePhase({
      baseSha: "abc1234",
      container: "fake-cid",
      brief: "## Deliverables\n\n- `src/f0.js`\n",
      callTool,
    });

    // No shown-count is carried: the numerator is derived from the rendered
    // block, and `shown` from the response is never read.
    assert.deepEqual(result.chainTruncation.status, { truncated: true, total: 137 });
    assert.equal(result.chainTruncation.untracked.truncated, false);
    assert.equal(result.chainTruncation.baseLog.truncated, false);
  });

  it("forwards the verify baseline into P2 so tolerated lint debt passes the round", async () => {
    // The base has 190 pre-existing lint violations; the round's worktree has
    // the same 190 (no added debt) and green tests after the tolerated re-run.
    // With the baseline forwarded, P2 must PASS and the round must be green;
    // without it, P2 would fail on the lint precondition.
    const verifyCalls = [];
    const callTool = async (toolName, params) => {
      if (toolName === "verify_in_container") {
        verifyCalls.push(params);
        if (verifyCalls.length === 1) {
          return {
            gate_passed: false,
            lint: [{ rule: "no-unused-vars", file: "/workspace/src/a.py", line: 1, message: "x", severity: "error" }],
            types: [],
            tests: { status: "skipped", message: "precondition gate failed; tests not run" },
            gate_fail_reasons: ["lint (eslint): 1 violation(s)"],
          };
        }
        return { gate_passed: true, lint: [], types: [], tests: { full: { status: "ok", passed: 1, total: 1 } } };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return {
          output: JSON.stringify({
            formatVersion: 1,
            repositoryRoot: "/workspace",
            input: { base: "abc1234", head: "HEAD" },
            resolved: { baseSha: "abc1234", headSha: "abc1234", mergeBaseSha: "abc1234" },
            paths: { committed: [], staged: [], unstaged: ["src/a.js"], untracked: [] },
          }),
        };
      }
      if (cmd === "git status --porcelain") return { output: " M src/a.js\n" };
      if (cmd === "git diff") return { output: "" };
      if (cmd.startsWith("git ls-files --others")) return { output: "" };
      return { output: "" };
    };

    const baseline = { captured: true, gate_passed: false, lint: 1, types: 0, raw: {} };
    const result = await runProbePhase({
      baseSha: "abc1234",
      container: "fake-cid",
      brief: "## Deliverables\n\n- `src/a.js`\n",
      callTool,
      verifyBaseline: baseline,
    });

    assert.equal(result.probesGreen, true);
    const p2 = result.probeResults.find((p) => p.probe === "P2: verify gate");
    assert.equal(p2.passed, true);
    assert.match(p2.detail, /lint 1 \(baseline 1, tolerated\)/);
    assert.equal(verifyCalls.length, 2, "P2 + tolerated re-run");
    assert.equal(verifyCalls[1].skip_lint_gate, true);
  });

  it("keeps P2 strict when no verify baseline is provided", async () => {
    // Without a baseline, a lint-precondition failure stays a hard FAIL and no
    // re-run is attempted (byte-identical to the pre-#173 probe).
    const verifyCalls = [];
    const callTool = async (toolName, params) => {
      if (toolName === "verify_in_container") {
        verifyCalls.push(params);
        return {
          gate_passed: false,
          lint: [{ rule: "no-unused-vars", file: "/workspace/src/a.py", line: 1, message: "x", severity: "error" }],
          types: [],
          tests: { status: "skipped", message: "precondition gate failed; tests not run" },
          gate_fail_reasons: ["lint (eslint): 1 violation(s)"],
        };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return {
          output: JSON.stringify({
            formatVersion: 1,
            repositoryRoot: "/workspace",
            input: { base: "abc1234", head: "HEAD" },
            resolved: { baseSha: "abc1234", headSha: "abc1234", mergeBaseSha: "abc1234" },
            paths: { committed: [], staged: [], unstaged: ["src/a.js"], untracked: [] },
          }),
        };
      }
      if (cmd === "git diff") return { output: "" };
      if (cmd.startsWith("git ls-files --others")) return { output: "" };
      return { output: "" };
    };

    const result = await runProbePhase({
      baseSha: "abc1234",
      container: "fake-cid",
      brief: "## Deliverables\n\n- `src/a.js`\n",
      callTool,
    });

    assert.equal(result.probesGreen, false);
    assert.equal(verifyCalls.length, 1, "no tolerated re-run without a baseline");
  });
});

// =========================================================================
// runImplementPhase — session lineage guard (kusabi #192 invariant 5)
// -------------------------------------------------------------------------
// A rework implement round may only continue a session created by the
// implement backend; a session attributable to a record of the OTHER backend
// is dropped and the round starts fresh.  Records without a `backend` field
// predate the backend split and count as "opencode".
// =========================================================================

describe("runImplementPhase session lineage guard (kusabi #192)", () => {
  function makeStubDispatch() {
    const calls = [];
    const dispatch = async (opts) => {
      calls.push(opts);
      return {
        job: {
          id: "job-imp", status: "completed", modelEntry: "opus",
          modelVariant: null, fallbacks: null, sessionID: "claude-uuid-new",
          usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
          error: null,
        },
        resultText: "implemented",
      };
    };
    return { dispatch, calls };
  }

  const base = {
    cwd: "/tmp", chainId: "chain-test", round: 2, isFirstRound: false,
    implementText: "brief", modelChain: [["opus"]], tierIndex: 0,
    useNewSession: false, session: undefined, resumeMethod: { type: "continue_session", detail: "" },
    flagsModel: null, backend: "claude",
  };

  it("continues the previous session when the previous record ran on the implement backend", async () => {
    const { dispatch, calls } = makeStubDispatch();
    await runImplementPhase({
      ...base,
      previousRecord: { sessionID: "claude-uuid-1", backend: "claude" },
      _dispatchWithFallback: dispatch,
    });
    assert.equal(calls[0].session, "claude-uuid-1");
  });

  it("drops a previous session created by the other backend (starts fresh)", async () => {
    const { dispatch, calls } = makeStubDispatch();
    await runImplementPhase({
      ...base,
      previousRecord: { sessionID: "ses_opencode_1", backend: "opencode" },
      _dispatchWithFallback: dispatch,
    });
    assert.ok(calls[0].session == null, "foreign opencode session must not be continued on claude");
  });

  it("a record without a backend field counts as opencode (both directions)", async () => {
    // opencode implement may continue the legacy (backend-less) session.
    const opencode = makeStubDispatch();
    await runImplementPhase({
      ...base, backend: "opencode",
      previousRecord: { sessionID: "ses_legacy_1" },
      _dispatchWithFallback: opencode.dispatch,
    });
    assert.equal(opencode.calls[0].session, "ses_legacy_1");

    // claude implement may NOT continue the legacy (opencode-attributed) session.
    const claude = makeStubDispatch();
    await runImplementPhase({
      ...base, backend: "claude",
      previousRecord: { sessionID: "ses_legacy_1" },
      _dispatchWithFallback: claude.dispatch,
    });
    assert.ok(claude.calls[0].session == null, "legacy opencode-attributed session must not run on claude");
  });

  it("useNewSession still starts fresh regardless of backend attribution", async () => {
    const { dispatch, calls } = makeStubDispatch();
    await runImplementPhase({
      ...base,
      useNewSession: true,
      previousRecord: { sessionID: "claude-uuid-1", backend: "claude" },
      _dispatchWithFallback: dispatch,
    });
    assert.equal(calls[0].session, undefined);
  });
});

// =========================================================================
// runImplementPhase — the round-to-round session hand-off (kusabi #320/#323)
// -------------------------------------------------------------------------
// The session runImplementPhase returns is the next round's carry, and the
// invariant is that it is a conversation round N's dispatch used or created.
// The phase reports the session its dispatch ACTUALLY used or created — the
// candidate it resumed for a resuming round, or the id the dispatch CREATED
// for a fresh round (`useNewSession`, or a dropped cross-backend candidate)
// — never the candidate it was told to walk away from.  The two coincide
// for a resuming round and differ exactly when the dispatch ran fresh;
// reporting the abandoned candidate in the fresh case was the kusabi #320
// defect, and the driver's clearing of the carry after useNewSession rounds
// (kusabi #320, chain-driver.mjs) was the compensation this change removes
// (kusabi #323): the seam now reports the truth, so there is nothing to
// clear.  These tests drive the phase directly, exactly as the driver calls
// it — round N's returned session/provenance ARE the next round's carry.
// =========================================================================

describe("runImplementPhase round-to-round session hand-off (kusabi #320/#323)", () => {
  // A realistic stub: a dispatch that RESUMES echoes the session it was
  // given (job.sessionID === opts.session), a dispatch that starts fresh
  // creates a new id (`idPrefix` + round).  Every backend stamps the job
  // with the session it actually used or created.
  function makeStubDispatch({ idPrefix = "claude-uuid-", jobOverrides = {} } = {}) {
    const calls = [];
    const dispatch = async (opts) => {
      calls.push(opts);
      return {
        job: {
          id: "job-imp-" + (opts.round ?? 1), status: "completed", modelEntry: "opus",
          modelVariant: null, fallbacks: null,
          sessionID: opts.session ?? (idPrefix + (opts.round ?? 1)),
          usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
          error: null,
          ...jobOverrides,
        },
        resultText: "implemented",
      };
    };
    return { dispatch, calls };
  }

  const base = {
    cwd: "/tmp", chainId: "chain-test", round: 2, isFirstRound: false,
    implementText: "brief", modelChain: [["opus"]], tierIndex: 0,
    useNewSession: false, session: undefined, sessionProvenance: null,
    previousRecord: null, resumeMethod: { type: "continue_session", detail: "" },
    flagsModel: null, backend: "claude",
  };

  it("after a useNewSession round the phase reports the session the fresh round CREATED — never the abandoned one — and that carry IS the next round's session", async () => {
    // Round N: the strategist set newSession.  The dispatch runs fresh and
    // creates "claude-uuid-2".  The phase reports THAT session (kusabi #323
    // seam) — not the candidate ("claude-uuid-1") it was told to walk away
    // from — so the driver no longer needs to clear the carry.
    const first = makeStubDispatch();
    const roundN = await runImplementPhase({
      ...base,
      useNewSession: true,
      session: "claude-uuid-1",
      sessionProvenance: "claude",
      previousRecord: { sessionID: "claude-uuid-1", backend: "claude" },
      _dispatchWithFallback: first.dispatch,
    });
    assert.equal(first.calls[0].session, undefined, "round N dispatches fresh as asked");
    assert.equal(roundN.session, "claude-uuid-2", "the report is the session the dispatch CREATED");
    assert.equal(roundN.sessionProvenance, "claude", "the created session is owned by the backend that created it");
    assert.equal(roundN.roundRecord.sessionID, "claude-uuid-2", "the record agrees with the report");

    // Round N+1, exactly as the driver feeds it today (no clearing — the
    // carry is round N's reported session): previousRecord = round N's record.
    const second = makeStubDispatch();
    await runImplementPhase({
      ...base,
      round: 3,
      useNewSession: false,
      session: roundN.session,
      sessionProvenance: roundN.sessionProvenance,
      previousRecord: { ...roundN.roundRecord, backend: "claude" },
      _dispatchWithFallback: second.dispatch,
    });
    assert.equal(second.calls[0].session, "claude-uuid-2",
      "round N+1 continues the conversation round N CREATED — the carry, not a re-derivation");
    assert.notEqual(second.calls[0].session, "claude-uuid-1",
      "the abandoned conversation is never resumed");
    assert.equal(second.calls[0].sessionProvenance, "claude");
  });

  it("the seam reports the session the dispatch created for a fresh round — never the candidate it was told to abandon (kusabi #323)", async () => {
    // The minimal form of the kusabi #323 contract: when the dispatch runs
    // fresh, the returned session is the id the dispatch CREATED, not the
    // candidate it was told to walk away from.  This assertion is the one
    // that fails when the seam's new reporting behaviour is removed (the
    // old seam reported `resolvedSession` — the candidate — instead).
    const { dispatch, calls } = makeStubDispatch();
    const result = await runImplementPhase({
      ...base,
      useNewSession: true,
      session: "claude-uuid-1",
      sessionProvenance: "claude",
      previousRecord: { sessionID: "claude-uuid-1", backend: "claude" },
      _dispatchWithFallback: dispatch,
    });
    assert.equal(calls[0].session, undefined, "the dispatch runs fresh");
    assert.equal(result.session, "claude-uuid-2", "the report is the session the dispatch CREATED");
    assert.notEqual(result.session, "claude-uuid-1", "never the abandoned candidate");
    assert.equal(result.sessionProvenance, "claude", "the created session's owner is the backend that created it");
  });

  it("a normally resuming round is unaffected: same session in, same session out, same dispatch arguments", async () => {
    const { dispatch, calls } = makeStubDispatch();
    const result = await runImplementPhase({
      ...base,
      useNewSession: false,
      session: "claude-uuid-1",
      sessionProvenance: "claude",
      previousRecord: { sessionID: "claude-uuid-1", backend: "claude" },
      _dispatchWithFallback: dispatch,
    });
    assert.equal(calls[0].session, "claude-uuid-1", "dispatch arguments unchanged");
    assert.equal(calls[0].sessionProvenance, "claude");
    assert.equal(result.session, "claude-uuid-1", "same session in, same session out");
    assert.equal(result.sessionProvenance, "claude");
    // For a resuming round the reported session IS the session it used —
    // nothing to clear (kusabi #323 removed the driver's clearing), nothing
    // to re-derive.
    assert.equal(result.roundRecord.sessionID, "claude-uuid-1");
  });

  it("a dropped cross-backend candidate never reaches a dispatch, and the phase reports the session THIS backend created", async () => {
    // The driver drops a foreign session before the phase (session: null);
    // the phase resolves nothing (the record fallback refuses the foreign
    // backend) and dispatches fresh — creating "claude-uuid-2".  The phase
    // reports THAT — never the foreign id, and never a null.
    const first = makeStubDispatch();
    const roundN = await runImplementPhase({
      ...base,
      useNewSession: false,
      session: null,
      sessionProvenance: null,
      previousRecord: { sessionID: "ses_opencode_1", backend: "opencode" },
      _dispatchWithFallback: first.dispatch,
    });
    assert.ok(first.calls[0].session == null, "the foreign session never reaches the dispatch");
    assert.equal(roundN.session, "claude-uuid-2", "the report is the session this round's dispatch CREATED");
    assert.equal(roundN.sessionProvenance, "claude");
    assert.equal(roundN.roundRecord.sessionID, "claude-uuid-2", "the record agrees with the report");

    // Round N+1 on the same backend: the carry (and the record fallback —
    // they agree) is the session THIS round created — never the foreign one.
    const second = makeStubDispatch();
    await runImplementPhase({
      ...base, round: 3,
      useNewSession: false,
      session: roundN.session,
      sessionProvenance: roundN.sessionProvenance,
      previousRecord: { ...roundN.roundRecord, backend: "claude" },
      _dispatchWithFallback: second.dispatch,
    });
    assert.equal(second.calls[0].session, "claude-uuid-2");
    assert.equal(second.calls[0].sessionProvenance, "claude");
  });

  it("a fresh dispatch whose job died before any session id was observed resumes nothing", async () => {
    // The claude/agy failure shape: sessionID null by construction until the
    // CLI reports one.  Round N dispatches fresh (useNewSession) and the job
    // dies before any id was observed: there is no session to report, the
    // record carries no sessionID, and round N+1 starts fresh — a dead fresh
    // round resumes nothing, by construction.
    const first = makeStubDispatch({
      jobOverrides: { status: "provider-error", sessionID: null },
    });
    const roundN = await runImplementPhase({
      ...base,
      useNewSession: true,
      session: "claude-uuid-1",
      sessionProvenance: "claude",
      previousRecord: { sessionID: "claude-uuid-1", backend: "claude" },
      _dispatchWithFallback: first.dispatch,
    });
    assert.equal(first.calls[0].session, undefined, "round N dispatched fresh as asked");
    assert.equal(roundN.session, null, "no session was created, so none is reported");
    assert.equal(roundN.sessionProvenance, null);
    assert.equal(roundN.roundRecord.sessionID, null, "no session id was ever observed");

    // Round N+1 with the null carry: the record has no sessionID to fall
    // back to, so the dispatch runs fresh — the abandoned candidate never
    // surfaces.
    const second = makeStubDispatch();
    await runImplementPhase({
      ...base, round: 3,
      useNewSession: false,
      session: roundN.session,
      sessionProvenance: roundN.sessionProvenance,
      previousRecord: { ...roundN.roundRecord, backend: "claude" },
      _dispatchWithFallback: second.dispatch,
    });
    assert.equal(second.calls[0].session, null, "round N+1 starts fresh");
  });

  it("agy: the reported pair keeps the fail-closed gate satisfiable across a fresh round's hand-off", async () => {
    // Resume: same pair in and out, so the next agy dispatch sees a proven
    // session (assertNoAgySession).
    const resume = makeStubDispatch({ idPrefix: "agy-conv-" });
    const resumed = await runImplementPhase({
      ...base, backend: "agy",
      useNewSession: false,
      session: "agy-conv-1",
      sessionProvenance: "agy",
      previousRecord: { sessionID: "agy-conv-1", backend: "agy" },
      _dispatchWithFallback: resume.dispatch,
    });
    assert.equal(resume.calls[0].session, "agy-conv-1");
    assert.equal(resume.calls[0].sessionProvenance, "agy", "the proof assertNoAgySession demands");
    assert.equal(resumed.session, "agy-conv-1");
    assert.equal(resumed.sessionProvenance, "agy");

    // Fresh round (useNewSession): the dispatch creates "agy-conv-2", and the
    // phase reports it with agy provenance — the carry the next round hands
    // to the agy dispatch is proven without any re-derivation.
    const fresh = makeStubDispatch({ idPrefix: "agy-conv-" });
    const roundN = await runImplementPhase({
      ...base, backend: "agy",
      useNewSession: true,
      session: "agy-conv-1",
      sessionProvenance: "agy",
      previousRecord: { sessionID: "agy-conv-1", backend: "agy" },
      _dispatchWithFallback: fresh.dispatch,
    });
    assert.equal(fresh.calls[0].session, undefined);
    assert.equal(roundN.session, "agy-conv-2", "the report is the conversation the fresh dispatch created");
    assert.equal(roundN.sessionProvenance, "agy");
    assert.equal(roundN.roundRecord.sessionID, "agy-conv-2");

    const next = makeStubDispatch({ idPrefix: "agy-conv-" });
    await runImplementPhase({
      ...base, backend: "agy", round: 3,
      useNewSession: false,
      session: roundN.session,
      sessionProvenance: roundN.sessionProvenance,
      previousRecord: { ...roundN.roundRecord, backend: "agy" },
      _dispatchWithFallback: next.dispatch,
    });
    assert.equal(next.calls[0].session, "agy-conv-2");
    assert.equal(next.calls[0].sessionProvenance, "agy",
      "provenance carried from the fresh round (and re-derivable from the record) — assertNoAgySession would pass");
  });
});

// =========================================================================
// runImplementPhase carry prefers the OBSERVED session id on BOTH branches
// (kusabi #324).  Measured 2026-08-21: a real agy record (chain-msxhipgq1cef
// round 2, continue_session) was told to resume `a784b853-…` but the job
// stamped `2a177486-…`, so the candidate and the observed id CAN diverge.
// The phase must hand round N+1 the id round N's dispatch actually used or
// created -- never the told candidate when an observed id exists -- and keep
// the candidate only as the dead-round fallback for a resuming round whose
// job died id-less.  These re-use the same stub contract as the block above.
// =========================================================================

describe("runImplementPhase carry prefers the observed session id (kusabi #324)", () => {
  // Same realistic stub as the #320/#323 block: a resuming dispatch echoes
  // the session it was given (job.sessionID === opts.session) unless a
  // jobOverrides.sessionID forces the job to record a DIFFERENT id -- the
  // divergence agy exhibits in the wild.
  function makeStubDispatch({ idPrefix = "claude-uuid-", jobOverrides = {} } = {}) {
    const calls = [];
    const dispatch = async (opts) => {
      calls.push(opts);
      return {
        job: {
          id: "job-imp-" + (opts.round ?? 1), status: "completed", modelEntry: "opus",
          modelVariant: null, fallbacks: null,
          sessionID: opts.session ?? (idPrefix + (opts.round ?? 1)),
          usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
          error: null,
          ...jobOverrides,
        },
        resultText: "implemented",
      };
    };
    return { dispatch, calls };
  }

  const base = {
    cwd: "/tmp", chainId: "chain-test", round: 2, isFirstRound: false,
    implementText: "brief", modelChain: [["opus"]], tierIndex: 0,
    useNewSession: false, session: undefined, sessionProvenance: null,
    previousRecord: null, resumeMethod: { type: "continue_session", detail: "" },
    flagsModel: null, backend: "agy",
  };

  it("a resuming round whose job observed a DIFFERENT id reports the observed id, not the candidate (kusabi #324)", async () => {
    // Round N was told to resume `agy-candidate-a784b853`, but agy mints a
    // new conversation id on resume and the job stamps `agy-observed-2a177486`.
    // The dispatch GOT the candidate; the job RECORDED the observed id.  The
    // carry handed to round N+1 must be the observed id, byte for byte.
    const { dispatch, calls } = makeStubDispatch({
      jobOverrides: { sessionID: "agy-observed-2a177486" },
    });
    const roundN = await runImplementPhase({
      ...base,
      useNewSession: false,
      session: "agy-candidate-a784b853",
      sessionProvenance: "agy",
      previousRecord: { sessionID: "agy-candidate-a784b853", backend: "agy" },
      _dispatchWithFallback: dispatch,
    });
    assert.equal(calls[0].session, "agy-candidate-a784b853",
      "round N's dispatch resumed the candidate it was told to");
    assert.equal(calls[0].sessionProvenance, "agy");
    assert.equal(roundN.session, "agy-observed-2a177486",
      "the carry is the OBSERVED id, not the candidate (kusabi #324)");
    assert.notEqual(roundN.session, "agy-candidate-a784b853",
      "the candidate is never the carry when an observed id exists");
    assert.equal(roundN.sessionProvenance, "agy",
      "the observed id's owner is the backend this round dispatched on");
    assert.equal(roundN.roundRecord.sessionID, "agy-observed-2a177486",
      "the record agrees with the report");
  });

  it("a resuming round whose job died id-less falls back to the candidate carry with its resolved provenance (kusabi #324)", async () => {
    // Round N was told to resume `agy-candidate-a784b853` but the job died
    // before any id was observed (`job.sessionID` null).  The carry is the
    // candidate -- the next round still has a conversation worth trying --
    // and its provenance is the resolved one.  The record's sessionID is
    // null: this is the one remaining divergence between record and carry.
    const { dispatch, calls } = makeStubDispatch({
      jobOverrides: { status: "provider-error", sessionID: null },
    });
    const roundN = await runImplementPhase({
      ...base,
      useNewSession: false,
      session: "agy-candidate-a784b853",
      sessionProvenance: "agy",
      previousRecord: { sessionID: "agy-candidate-a784b853", backend: "agy" },
      _dispatchWithFallback: dispatch,
    });
    assert.equal(calls[0].session, "agy-candidate-a784b853",
      "round N's dispatch resumed the candidate it was told to");
    assert.equal(roundN.session, "agy-candidate-a784b853",
      "the dead job's carry is the candidate fallback");
    assert.equal(roundN.sessionProvenance, "agy",
      "the fallback's owner is the resolved provenance");
    assert.equal(roundN.roundRecord.sessionID, null,
      "the record's sessionID is null -- the only divergence from the report");
  });

  it("a fresh round still reports the created id (kusabi #320/#323 semantics intact under #324)", async () => {
    // Regression guard: the #324 change must NOT alter the fresh-round
    // contract.  Round N runs fresh and creates `agy-conv-2`; the phase
    // reports THAT, never the abandoned candidate, and round N+1 continues it.
    const first = makeStubDispatch({ idPrefix: "agy-conv-" });
    const roundN = await runImplementPhase({
      ...base,
      useNewSession: true,
      session: "agy-conv-1",
      sessionProvenance: "agy",
      previousRecord: { sessionID: "agy-conv-1", backend: "agy" },
      _dispatchWithFallback: first.dispatch,
    });
    assert.equal(first.calls[0].session, undefined, "round N dispatches fresh as asked");
    assert.equal(roundN.session, "agy-conv-2", "the report is the session the dispatch CREATED");
    assert.equal(roundN.sessionProvenance, "agy");
    assert.equal(roundN.roundRecord.sessionID, "agy-conv-2");

    const second = makeStubDispatch({ idPrefix: "agy-conv-" });
    await runImplementPhase({
      ...base, round: 3,
      useNewSession: false,
      session: roundN.session,
      sessionProvenance: roundN.sessionProvenance,
      previousRecord: { ...roundN.roundRecord, backend: "agy" },
      _dispatchWithFallback: second.dispatch,
    });
    assert.equal(second.calls[0].session, "agy-conv-2",
      "round N+1 continues the conversation round N CREATED");
  });
});

// P5 / P6 — the deterministic oracle probes (kusabi #197)
// ---------------------------------------------------------------------------

describe("runProbePhase — P5/P6 wiring (kusabi #197)", () => {
  // No worktree baseline is passed, so P3's newlyChangedPaths is null and the
  // fallback rule applies: P5 sees the full `git status --porcelain` set.
  function oracleCallTool({ status = "", verifyResults } = {}) {
    const results = verifyResults ?? [
      { gate_passed: true, lint: [], types: [], tests: { full: { status: "ok", passed: 10, total: 10 } } },
    ];
    const verifyCalls = [];
    const fn = async (toolName, params) => {
      if (toolName === "verify_in_container") {
        verifyCalls.push(params);
        return results[Math.min(verifyCalls.length - 1, results.length - 1)];
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return {
          output: JSON.stringify({
            formatVersion: 1,
            repositoryRoot: "/workspace",
            input: { base: "abc1234", head: "HEAD" },
            resolved: { baseSha: "abc1234", headSha: "abc1234", mergeBaseSha: "abc1234" },
            paths: { committed: [], staged: [], unstaged: [], untracked: [] },
          }),
        };
      }
      if (cmd === "git status --porcelain") return { output: status };
      return { output: "" };
    };
    fn.verifyCalls = verifyCalls;
    return fn;
  }

  const GREEN_BASELINE = { captured: true, gate_passed: true, lint: 0, types: 0, collected: 10, raw: {} };

  it("appends P5 and P6 after P4, in order", async () => {
    const callTool = oracleCallTool({ status: " M src/a.js\n" });
    const result = await runProbePhase({
      baseSha: "abc1234", container: "cid",
      brief: "## Deliverables\n\n- `src/a.js`\n",
      callTool, verifyBaseline: GREEN_BASELINE,
    });
    assert.deepEqual(
      result.probeResults.map((p) => p.probe),
      ["P1: HEAD clean", "P2: verify gate", "P3: deliverables", "P4: smoke", "P5: frozen", "P6: collected"],
    );
  });

  it("a brief with no `## Frozen Tests` section keeps the round green and the marker false", async () => {
    const callTool = oracleCallTool({ status: " M src/a.js\n" });
    const result = await runProbePhase({
      baseSha: "abc1234", container: "cid",
      brief: "## Deliverables\n\n- `src/a.js`\n",
      callTool, verifyBaseline: GREEN_BASELINE,
    });
    const p5 = result.probeResults.find((p) => p.probe === "P5: frozen");
    assert.equal(p5.passed, true);
    assert.equal(p5.detail, "no Frozen Tests declared; check skipped");
    assert.equal(result.probesGreen, true);
    assert.equal(result.oracleViolation, false);
  });

  it("a change set touching a frozen path fails P5 and raises the oracle marker naming it", async () => {
    const callTool = oracleCallTool({ status: " M src/a.js\n M tests/frozen.test.mjs\n" });
    const result = await runProbePhase({
      baseSha: "abc1234", container: "cid",
      brief: [
        "## Deliverables",
        "",
        "- `src/a.js`",
        "",
        "## Frozen Tests (do not touch)",
        "",
        "- `tests/frozen.test.mjs`",
        "",
      ].join("\n"),
      callTool, verifyBaseline: GREEN_BASELINE,
    });
    const p5 = result.probeResults.find((p) => p.probe === "P5: frozen");
    assert.equal(p5.passed, false);
    assert.match(p5.detail, /tests\/frozen\.test\.mjs/);
    assert.equal(result.probesGreen, false);
    assert.match(result.oracleViolation, /P5: frozen/);
    assert.match(result.oracleViolation, /tests\/frozen\.test\.mjs/);
  });

  it("a round that runs fewer tests than the baseline fails P6 and raises the marker", async () => {
    const callTool = oracleCallTool({
      status: " M src/a.js\n",
      verifyResults: [
        { gate_passed: true, lint: [], types: [], tests: { full: { status: "ok", passed: 334, total: 334 } } },
      ],
    });
    const result = await runProbePhase({
      baseSha: "abc1234", container: "cid",
      brief: "## Deliverables\n\n- `src/a.js`\n",
      callTool,
      verifyBaseline: { captured: true, gate_passed: true, lint: 0, types: 0, collected: 607, raw: {} },
    });
    const p6 = result.probeResults.find((p) => p.probe === "P6: collected");
    assert.equal(p6.passed, false);
    assert.equal(p6.detail, "collected 334 < baseline 607");
    assert.equal(result.probesGreen, false);
    assert.match(result.oracleViolation, /P6: collected: collected 334 < baseline 607/);
  });

  it("issues no second verify_in_container call for P6", async () => {
    // P2 already ran verify this round; P6 reuses that run's result.  The call
    // log is the assertion — a re-run would double the round's most expensive
    // container call.
    const callTool = oracleCallTool({ status: " M src/a.js\n" });
    await runProbePhase({
      baseSha: "abc1234", container: "cid",
      brief: "## Deliverables\n\n- `src/a.js`\n",
      callTool, verifyBaseline: GREEN_BASELINE,
    });
    assert.equal(callTool.verifyCalls.length, 1, "exactly one verify per round: P2's");
  });

  it("P6 passes and states the limitation when the baseline carries no count", async () => {
    const callTool = oracleCallTool({ status: " M src/a.js\n" });
    const result = await runProbePhase({
      baseSha: "abc1234", container: "cid",
      brief: "## Deliverables\n\n- `src/a.js`\n",
      callTool,
      // An old chain.json, recorded before the collected count existed.
      verifyBaseline: { captured: true, gate_passed: true, lint: 0, types: 0, raw: {} },
    });
    const p6 = result.probeResults.find((p) => p.probe === "P6: collected");
    assert.equal(p6.passed, true);
    assert.match(p6.detail, /collected count unavailable \(baseline unavailable, round 10\)/);
    assert.equal(result.probesGreen, true);
    assert.equal(result.oracleViolation, false);
  });

  it("a `## Frozen Tests` heading with zero parsable entries fails P5 without raising the marker", async () => {
    const callTool = oracleCallTool({ status: " M src/a.js\n" });
    const result = await runProbePhase({
      baseSha: "abc1234", container: "cid",
      brief: "## Deliverables\n\n- `src/a.js`\n\n## Frozen Tests\n\nnothing parseable here\n",
      callTool, verifyBaseline: GREEN_BASELINE,
    });
    const p5 = result.probeResults.find((p) => p.probe === "P5: frozen");
    assert.equal(p5.passed, false);
    assert.match(p5.detail, /heading present but no entries parsed/);
    assert.equal(result.probesGreen, false);
    assert.equal(result.oracleViolation, false, "a brief-syntax defect is not a violation of the oracle");
  });
});

// ---------------------------------------------------------------------------
// change-scope wiring into probe phase (kusabi #379)
// ---------------------------------------------------------------------------

describe("change-scope wiring into probe phase (kusabi #379)", () => {
  const FIXTURE_CHANGE_SCOPE = {
    formatVersion: 1,
    repositoryRoot: "/workspace",
    input: { base: "base-sha-123", head: "HEAD" },
    resolved: {
      baseSha: "base-sha-123",
      headSha: "head-sha-456",
      mergeBaseSha: "base-sha-123",
    },
    paths: {
      committed: ["src/committed.js"],
      staged: ["src/staged.js"],
      unstaged: ["src/unstaged.js"],
      untracked: ["src/untracked.js"],
    },
  };

  it("runProbePhase issues change-scope before git reset --mixed and resets when HEAD != base", async () => {
    const executed = [];
    const callTool = async (toolName, params) => {
      if (toolName === "verify_in_container") {
        return { gate_passed: true, lint: [], types: [], tests: { full: { status: "ok", passed: 10, total: 10 } } };
      }
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      executed.push({ cmd, argv: params.argv, commands: params.commands });
      if (cmd.includes("change-scope.mjs")) {
        return { output: JSON.stringify(FIXTURE_CHANGE_SCOPE) };
      }
      if (cmd === "git rev-parse HEAD") {
        return { output: "head-sha-456\n" }; // HEAD != baseSha ("base-sha-123")
      }
      if (cmd.startsWith("git reset --mixed")) {
        return { output: "Unstaged changes after reset:\n" };
      }
      if (cmd === "git status --porcelain") {
        return { output: " M src/unstaged.js\n" };
      }
      return { output: "" };
    };

    const result = await runProbePhase({
      baseSha: "base-sha-123",
      container: "cid-probe-order",
      brief: "## Deliverables\n\n- `src/unstaged.js`\n",
      callTool,
      verifyBaseline: { captured: true, gate_passed: true, lint: 0, types: 0, collected: 10, raw: {} },
    });

    // 1. Assert change-scope was executed with argv and BEFORE git reset --mixed
    const changeScopeIdx = executed.findIndex((e) => e.cmd.includes("change-scope.mjs"));
    const resetIdx = executed.findIndex((e) => e.cmd.startsWith("git reset --mixed"));
    assert.ok(changeScopeIdx >= 0, "change-scope must be invoked");
    assert.ok(executed[changeScopeIdx].argv, "change-scope must be invoked with argv");
    assert.equal(executed[changeScopeIdx].commands, undefined, "change-scope must not pass commands when argv is provided");
    assert.deepEqual(executed[changeScopeIdx].argv, ["node", "/tmp/kusabi-change-scope.mjs", "--base", "base-sha-123", "--head", "HEAD"]);
    assert.ok(resetIdx >= 0, "git reset --mixed must be invoked when HEAD != base");
    assert.ok(changeScopeIdx < resetIdx, "change-scope must run before git reset --mixed");

    // 2. Assert changeScope is returned on probeResult
    assert.deepEqual(result.changeScope, FIXTURE_CHANGE_SCOPE);

    // 3. Assert P1 still ran and passed with auto-reset detail
    const p1 = result.probeResults.find((p) => p.probe === "P1: HEAD clean");
    assert.ok(p1 && p1.passed);
    assert.match(p1.detail, /auto reset - reset OK/);
  });

  it("change-scope non-zero exit fails closed in runProbePhase (probes fail, no review range)", async () => {
    const callTool = async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return { exit_code: 1, stderr: "change-scope: base ref not found\n", output: "change-scope: base ref not found\n" };
      }
      return { output: "" };
    };

    const result = await runProbePhase({
      baseSha: "bad-base",
      container: "cid-fail-closed",
      brief: "## Deliverables\n\n- `src/foo.js`\n",
      callTool,
    });

    // Fails closed: probesGreen is false, failed probe recorded
    assert.equal(result.probesGreen, false);
    assert.equal(result.changeScope, null);
    const rpcProbe = result.probeResults.find((p) => p.passed === false);
    assert.ok(rpcProbe, "must record failed probe");
    assert.match(rpcProbe.detail, /change-scope failed with exit code 1/);
  });

  it("change-scope empty stdout fails closed in runProbePhase (probes fail, no review range)", async () => {
    const callTool = async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return { output: "" };
      }
      return { output: "" };
    };

    const result = await runProbePhase({
      baseSha: "empty-base",
      container: "cid-fail-empty",
      brief: "## Deliverables\n\n- `src/foo.js`\n",
      callTool,
    });

    assert.equal(result.probesGreen, false);
    assert.equal(result.changeScope, null);
    const rpcProbe = result.probeResults.find((p) => p.passed === false);
    assert.ok(rpcProbe, "must record failed probe");
    assert.match(rpcProbe.detail, /change-scope produced empty output/);
  });

  it("change-scope inject failure in runProbePhase fails closed without fallback exec", async () => {
    const executed = [];
    const callTool = async (toolName, params) => {
      if (toolName === "copy_file") {
        throw new Error("copy_file failed: connection refused");
      }
      const cmd = params.commands?.[0] ?? params.argv?.join(" ") ?? "";
      executed.push({ toolName, cmd, params });
      return { output: "" };
    };

    const result = await runProbePhase({
      baseSha: "base-sha-123",
      container: "cid-fail-inject-probe",
      brief: "## Deliverables\n\n- `src/foo.js`\n",
      callTool,
    });

    assert.equal(result.probesGreen, false);
    assert.equal(result.changeScope, null);
    const rpcProbe = result.probeResults.find((p) => p.passed === false);
    assert.ok(rpcProbe, "must record failed probe");
    assert.match(rpcProbe.detail, /change-scope inject failed in container cid-fail-inject-probe/);
    assert.ok(
      !executed.some((e) => e.cmd.includes("plugins/kusabi/scripts/change-scope.mjs")),
      "must not exec old relative path as a fallback",
    );
  });
});
