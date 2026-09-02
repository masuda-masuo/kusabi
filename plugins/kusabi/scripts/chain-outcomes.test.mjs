import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  renderAcceptOutcome,
  renderAcceptWithFollowupOutcome,
  renderEscalateOutcome,
  renderMaxRoundsOutcome,
  renderProviderExhaustedOutcome,
  handleProviderExhaustion,
} from "./chain-outcomes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

// =========================================================================
// renderAcceptOutcome  —  pure, extracted from cmdChain (chain-phases.mjs -> chain-outcomes.mjs)
// =========================================================================

describe("renderAcceptOutcome", () => {
  const chainId = "chain-test123";

  it("renders accepted message with chain ID and round", () => {
    const result = renderAcceptOutcome({ chainId, round: 1, chainParsedReview: null, chainFindingsText: "" });
    assert.ok(result.includes("Chain chain-test123 accepted at round 1"));
  });

  it("renders review text when parsed review is present", () => {
    const review = { verdict: "approve", summary: "Looks good" };
    const result = renderAcceptOutcome({ chainId, round: 2, chainParsedReview: review, chainFindingsText: "no issues" });
    assert.ok(result.includes("Chain chain-test123 accepted at round 2"));
    // renderReview contributes the verdict line
    assert.ok(result.includes("approve"));
  });

  it("renders fallback when no review is available", () => {
    const result = renderAcceptOutcome({ chainId, round: 1, chainParsedReview: null, chainFindingsText: "" });
    assert.ok(result.includes("(no review text available)"));
  });
});

// =========================================================================
// renderAcceptWithFollowupOutcome  —  pure
// =========================================================================

describe("renderAcceptWithFollowupOutcome", () => {
  const chainId = "chain-test456";
  const brief = "# Fix the bug\n\nDescription here.";

  it("renders accept-with-followup message", () => {
    const result = renderAcceptWithFollowupOutcome({
      chainId, round: 1, chainParsedReview: null, chainFindingsText: "minor issues",
      chainFollowupDraft: null, brief,
    });
    assert.ok(result.includes("Chain chain-test456 accepted-with-followup at round 1"));
    assert.ok(result.includes("(no review text available)"));
  });

  it("renders review text and followup draft when both present", () => {
    const review = { verdict: "needs-attention", findings: [{ file: "src/foo.js", title: "missing null check", severity: "low", line_start: 42 }] };
    const result = renderAcceptWithFollowupOutcome({
      chainId, round: 2, chainParsedReview: review, chainFindingsText: "findings",
      chainFollowupDraft: "# Followup issue draft\n\n## Findings\n- [low] missing null check (src/foo.js:42)",
      brief,
    });
    assert.ok(result.includes("accepted-with-followup at round 2"));
    assert.ok(result.includes("# Followup issue draft"));
  });

  it("generates followup draft from findings when chainFollowupDraft is null", () => {
    const review = {
      verdict: "needs-attention",
      findings: [{ file: "src/foo.js", title: "missing null check", severity: "low", line_start: 42 }],
    };
    const result = renderAcceptWithFollowupOutcome({
      chainId, round: 1, chainParsedReview: review, chainFindingsText: "findings",
      chainFollowupDraft: null, brief,
    });
    assert.ok(result.includes("missing null check"));
    assert.ok(result.includes("src/foo.js"));
  });
});

// =========================================================================
// renderEscalateOutcome  —  pure
// =========================================================================

describe("renderEscalateOutcome", () => {
  const chainId = "chain-esc789";

  it("renders escalate message with reason and orchestrator line", () => {
    const roundRecord = { findingsText: "critical issue in src/main.js" };
    const records = [
      {
        resumeMethod: { type: "fresh_session", base: "abc123" },
        modelEntry: "test/gpt-4",
        verdict: "needs-attention",
        probesGreen: true,
      },
    ];
    const disposition = { disposition: "escalate", reason: "max rounds (3) reached without acceptance" };
    const orchestrator = { model: "claude-opus" };

    const result = renderEscalateOutcome({ chainId, round: 3, disposition, orchestrator, roundRecord, records });
    assert.ok(result.includes("Chain chain-esc789 escalated at round 3"));
    assert.ok(result.includes("max rounds (3) reached without acceptance"));
    assert.ok(result.includes("orchestrator=claude-opus"));
    assert.ok(result.includes("Remaining findings:"));
    assert.ok(result.includes("critical issue in src/main.js"));
    assert.ok(result.includes("Hand over to orchestrator for final judgement."));
  });

  it("renders round summaries with resume details", () => {
    const roundRecord = { findingsText: "issue" };
    const records = [
      { resumeMethod: { type: "continue_session" }, modelEntry: "test/gpt-4", verdict: "needs-attention", probesGreen: false },
      { resumeMethod: { type: "fresh_session", detail: "new session" }, modelEntry: "test/gpt-4o", verdict: "needs-attention", probesGreen: true },
    ];
    const disposition = { disposition: "escalate", reason: "repeated areas" };
    const result = renderEscalateOutcome({ chainId, round: 2, disposition, orchestrator: null, roundRecord, records });
    assert.ok(result.includes("Round 1: model=test/gpt-4, verdict=needs-attention, probesGreen=false, changed=unknown, resume=continue_session"));
    assert.ok(result.includes("Round 2: model=test/gpt-4o, verdict=needs-attention, probesGreen=true, changed=unknown, resume=fresh_session: new session"));
  });

  it("renders 'unknown' when reason is missing", () => {
    const roundRecord = { findingsText: "issue" };
    const records = [{ resumeMethod: { type: "continue_session" }, modelEntry: "x", verdict: "discard", probesGreen: false }];
    const result = renderEscalateOutcome({ chainId, round: 1, disposition: { disposition: "escalate" }, orchestrator: null, roundRecord, records });
    assert.ok(result.includes("unknown"));
  });

  // ---- probe-discarded rounds: the terminal handover must not read
  // "reviewer discarded the work" over an intact worktree (kusabi #299) ----
  // chain-show's headline and disposition line were re-keyed first; these pin
  // the surfaces the ORCHESTRATOR actually reads on escalation: the outcome's
  // first line and its per-round changed flag (which a probe-discarded
  // round's worktreeChanged makes false BY CONSTRUCTION, so the column states
  // the recorded dirty-vs-base fact instead of a bare NO).

  it("probe-discarded round: first line states the probe-discard wording, never the reviewer's", () => {
    const roundRecord = {
      findingsText: "issue",
      verdict: "discard",
      verdictSource: "probe",
      worktreeDirtyVsBase: true,
    };
    const records = [
      { resumeMethod: { type: "continue_session" }, modelEntry: "test/gpt-4", verdict: "discard", verdictSource: "probe", worktreeDirtyVsBase: true, worktreeChanged: false, probesGreen: true },
    ];
    const disposition = { disposition: "escalate", reason: "reviewer discarded the work" };
    const result = renderEscalateOutcome({ chainId, round: 1, disposition, orchestrator: null, roundRecord, records });
    assert.ok(result.includes("Chain chain-esc789 escalated at round 1: empty round discarded by probe; worktree still DIRTY vs the chain base"));
    assert.doesNotMatch(result, /reviewer discarded the work/);
  });

  it("probe-discarded round: the changed flag states dirty-vs-base, not a bare NO", () => {
    const roundRecord = {
      findingsText: "issue",
      verdict: "discard",
      verdictSource: "probe",
      worktreeDirtyVsBase: true,
    };
    const records = [
      { resumeMethod: { type: "continue_session" }, modelEntry: "test/gpt-4", verdict: "discard", verdictSource: "probe", worktreeDirtyVsBase: true, worktreeChanged: false, probesGreen: true },
    ];
    const disposition = { disposition: "escalate", reason: "reviewer discarded the work" };
    const result = renderEscalateOutcome({ chainId, round: 1, disposition, orchestrator: null, roundRecord, records });
    assert.ok(result.includes("Round 1: model=test/gpt-4, verdict=discard, probesGreen=true, changed=NO (worktree DIRTY vs chain base), resume=continue_session"));
  });

  it("probe-discarded round on a clean tree: first line and changed flag say CLEAN", () => {
    const roundRecord = {
      findingsText: "issue",
      verdict: "discard",
      verdictSource: "probe",
      worktreeDirtyVsBase: false,
    };
    const records = [
      { resumeMethod: { type: "continue_session" }, modelEntry: "test/gpt-4", verdict: "discard", verdictSource: "probe", worktreeDirtyVsBase: false, worktreeChanged: false, probesGreen: true },
    ];
    const disposition = { disposition: "escalate", reason: "reviewer discarded the work" };
    const result = renderEscalateOutcome({ chainId, round: 1, disposition, orchestrator: null, roundRecord, records });
    assert.ok(result.includes("Chain chain-esc789 escalated at round 1: empty round discarded by probe; worktree CLEAN vs the chain base"));
    assert.ok(result.includes("changed=NO (worktree CLEAN vs chain base), resume=continue_session"));
  });

  it("a reviewer-verdict discard keeps the recorded reason and a bare changed=NO", () => {
    const roundRecord = {
      findingsText: "issue",
      verdict: "discard",
      worktreeChanged: false,
    };
    const records = [
      { resumeMethod: { type: "continue_session" }, modelEntry: "test/gpt-4", verdict: "discard", worktreeChanged: false, probesGreen: true },
    ];
    const disposition = { disposition: "escalate", reason: "reviewer discarded the work" };
    const result = renderEscalateOutcome({ chainId, round: 1, disposition, orchestrator: null, roundRecord, records });
    assert.ok(result.includes("Chain chain-esc789 escalated at round 1: reviewer discarded the work"));
    assert.ok(result.includes("changed=NO, resume=continue_session"));
  });

  // ---- kusabi #336: the escalate handover carries the decisions, not just a
  // one-line task list. When the terminal round record carries a structured
  // `findings` array, each finding's body and recommendation are rendered as a
  // severity-ordered decision block; old records without `findings` keep the
  // one-line findingsText list.

  it("renders structured findings as severity-ordered decisions with recommendations", () => {
    const roundRecord = {
      findings: [
        { severity: "low", title: "minor", file: "src/x.js", line_start: 5, body: "minor body", recommendation: "fix later" },
        { severity: "critical", title: "data loss", file: "src/y.js", line_start: 9, body: "DATA-LOSS-BODY", recommendation: "RECOVER-NOW-REC" },
        { severity: "high", title: "perf", file: "src/z.js", line_start: 2, body: "perf body", recommendation: "cache it" },
      ],
    };
    const records = [{ resumeMethod: { type: "continue_session" }, modelEntry: "test/gpt-4", verdict: "needs-attention", probesGreen: false }];
    const disposition = { disposition: "escalate", reason: "oracle violation" };
    const result = renderEscalateOutcome({ chainId, round: 2, disposition, orchestrator: null, roundRecord, records });
    assert.ok(result.includes("Chain chain-esc789 escalated at round 2: oracle violation"));
    // Decision block header, framed as answers, not re-investigation.
    assert.ok(result.includes("Decisions for the orchestrator (answer each; a one-line answer per item is enough"));
    // Severity ordering: critical before high before low.
    assert.ok(result.indexOf("DATA-LOSS-BODY") < result.indexOf("cache it"));
    assert.ok(result.indexOf("cache it") < result.indexOf("minor body"));
    // Recommendation survives in full.
    assert.ok(result.includes("RECOVER-NOW-REC"));
    // The bare one-line list header must NOT appear when structured findings exist.
    assert.doesNotMatch(result, /Remaining findings:/);
    assert.ok(result.includes("Hand over to orchestrator for final judgement."));
  });

  it("degrades to the one-line findingsText list for an old record without findings", () => {
    const roundRecord = { findingsText: "critical issue in src/main.js" };
    const records = [{ resumeMethod: { type: "continue_session" }, modelEntry: "test/gpt-4", verdict: "needs-attention", probesGreen: true }];
    const disposition = { disposition: "escalate", reason: "max rounds reached" };
    const result = renderEscalateOutcome({ chainId, round: 3, disposition, orchestrator: null, roundRecord, records });
    assert.ok(result.includes("Remaining findings:"));
    assert.ok(result.includes("critical issue in src/main.js"));
    assert.doesNotMatch(result, /Decisions for the orchestrator/);
  });

  it("states plainly when the round recorded no findings at all", () => {
    const roundRecord = { verdict: "discard", verdictSource: "probe", worktreeDirtyVsBase: true };
    const records = [{ resumeMethod: { type: "continue_session" }, modelEntry: "test/gpt-4", verdict: "discard", verdictSource: "probe", worktreeDirtyVsBase: true, worktreeChanged: false, probesGreen: true }];
    const disposition = { disposition: "escalate", reason: "reviewer discarded the work" };
    const result = renderEscalateOutcome({ chainId, round: 1, disposition, orchestrator: null, roundRecord, records });
    assert.ok(result.includes("empty round discarded by probe; worktree still DIRTY vs the chain base"));
    assert.ok(result.includes("(no findings recorded for this round)"));
    assert.doesNotMatch(result, /Remaining findings:/);
  });
});

// =========================================================================
// renderMaxRoundsOutcome  —  pure
// =========================================================================

describe("renderMaxRoundsOutcome", () => {
  const chainId = "chain-max123";

  it("renders max rounds message", () => {
    const records = [
      { resumeMethod: { type: "continue_session" }, modelEntry: "test/gpt-4", verdict: "needs-attention", probesGreen: false },
      { resumeMethod: { type: "fresh_session" }, modelEntry: "test/gpt-4o", verdict: "needs-attention", probesGreen: true, findingsText: "still has bugs" },
    ];
    const orchestrator = { model: "gpt-5" };

    const result = renderMaxRoundsOutcome({ chainId, maxRounds: 3, records, orchestrator });
    assert.ok(result.includes("Chain chain-max123 reached max rounds (3) without acceptance"));
    assert.ok(result.includes("orchestrator=gpt-5"));
    assert.ok(result.includes("Remaining findings:"));
    assert.ok(result.includes("still has bugs"));
    assert.ok(result.includes("Round 1: model=test/gpt-4, verdict=needs-attention, probesGreen=false, changed=unknown, resume=continue_session"));
    assert.ok(result.includes("Round 2: model=test/gpt-4o, verdict=needs-attention, probesGreen=true, changed=unknown, resume=fresh_session"));
    assert.ok(result.includes("Hand over to orchestrator for final judgement."));
  });

  it("renders (none) for findings when last record has none", () => {
    const records = [
      { resumeMethod: { type: "continue_session" }, modelEntry: "x", verdict: "discard", probesGreen: false },
    ];
    const result = renderMaxRoundsOutcome({ chainId, maxRounds: 1, records, orchestrator: null });
    assert.ok(result.includes("(none)"));
  });

  it("renders fallback for empty records", () => {
    const result = renderMaxRoundsOutcome({ chainId, maxRounds: 3, records: [], orchestrator: null });
    assert.ok(result.includes("(none)"));
    assert.ok(result.includes("reached max rounds (3)"));
  });

  // The max-rounds terminal's round summaries are another surface an
  // orchestrator reads on handover: a probe-discarded round's changed flag
  // states the recorded dirty-vs-base fact (kusabi #299), never a bare NO.
  it("a probe-discarded round's changed flag states dirty-vs-base", () => {
    const records = [
      { resumeMethod: { type: "continue_session" }, modelEntry: "test/gpt-4", verdict: "discard", verdictSource: "probe", worktreeDirtyVsBase: true, worktreeChanged: false, probesGreen: true },
    ];
    const result = renderMaxRoundsOutcome({ chainId, maxRounds: 1, records, orchestrator: null });
    assert.ok(result.includes("Round 1: model=test/gpt-4, verdict=discard, probesGreen=true, changed=NO (worktree DIRTY vs chain base), resume=continue_session"));
  });
});

// =========================================================================
// renderProviderExhaustedOutcome  —  pure
// =========================================================================

describe("renderProviderExhaustedOutcome", () => {
  const chainId = "chain-exhausted-1";

  it("identifies provider/capacity exhaustion distinct from escalate and max rounds", () => {
    const result = renderProviderExhaustedOutcome({
      chainId,
      round: 2,
      phase: "implement",
      jobError: "All routes exhausted:\n  route/a — rate_limit at attempt 3: overloaded\n  route/b — free_tier_limit at attempt 1: quota gone",
      records: [],
    });

    assert.ok(result.includes("stopped at round 2: implement provider exhausted"));
    assert.ok(result.includes("All routes exhausted:"));
    assert.ok(result.includes("route/a"));
    assert.ok(result.includes("route/b"));
    assert.ok(result.includes("free_tier_limit"));
    // Must NOT be confused with escalation or max rounds.
    assert.ok(!result.includes("escalate"));
    assert.ok(!result.includes("max rounds"));
    // Capacity message is present.
    assert.ok(result.includes("Capacity problem"));
    assert.ok(result.includes("not a quality failure"));
  });

  it("surfaces the job error text directly (no re-derivation)", () => {
    const jobError = "All routes exhausted:\n  only/route — rate_limit at attempt 3";
    const result = renderProviderExhaustedOutcome({
      chainId,
      round: 1,
      phase: "review",
      jobError,
      records: [],
    });

    assert.ok(result.includes(jobError));
    assert.ok(result.includes("review provider exhausted"));
  });

  it("includes prior round records so chain-show can display aborted round", () => {
    const records = [
      {
        round: 1,
        modelEntry: "provider/model-a",
        verdict: "needs-attention",
        probesGreen: true,
        resumeMethod: { type: "continue_session" },
        fallbacks: [{ from: "route/dead", to: "route/alive", reason: "free_tier_limit", attempt: 1, message: "quota" }],
      },
      {
        round: 2,
        modelEntry: "provider/model-b",
        verdict: null,
        probesGreen: false,
        resumeMethod: { type: "fresh_session", base: "abc123" },
        fallbacks: [{ from: "route/x", to: null, reason: "rate_limit", attempt: 3, message: "overloaded" }],
      },
    ];

    const result = renderProviderExhaustedOutcome({
      chainId,
      round: 3,
      phase: "implement",
      jobError: "All routes exhausted:\n  route/x — rate_limit at attempt 3: overloaded",
      records,
    });

    assert.ok(result.includes("Prior rounds:"));
    assert.ok(result.includes("Round 1: model=provider/model-a, verdict=needs-attention, probesGreen=true, changed=unknown, resume=continue_session"));
    assert.ok(result.includes("Round 2: model=provider/model-b, verdict=n/a, probesGreen=false, changed=unknown, resume=fresh_session"));
  });

  it("handles null jobError gracefully", () => {
    const result = renderProviderExhaustedOutcome({
      chainId,
      round: 1,
      phase: "implement",
      jobError: null,
      records: [],
    });

    assert.ok(result.includes("(no error detail)"));
  });

  it("handles strategize phase exhaustion", () => {
    const result = renderProviderExhaustedOutcome({
      chainId,
      round: 2,
      phase: "strategize",
      jobError: "All routes exhausted:\n  route/p — rate_limit at attempt 3",
      records: [],
    });

    assert.ok(result.includes("strategize provider exhausted"));
  });

  it("strategize provider-error: each round appears exactly once", () => {
    // The strategize provider-error handler used to push the round record a
    // second time, duplicating it in `records`.  The fix (removing that push)
    // lives in cmdChain, which this test does NOT reach: cmdChain is not
    // exported and driving it would require mocking every phase.  This test
    // only covers the downstream half -- that the renderer does not itself
    // duplicate rounds.  Re-introducing the duplicate push in cmdChain would
    // still pass here.  Making that path testable is tracked separately.
    const records = [
      {
        round: 1,
        modelEntry: "provider/model-a",
        verdict: "needs-attention",
        probesGreen: true,
        resumeMethod: { type: "continue_session" },
      },
      {
        round: 2,
        modelEntry: "provider/model-b",
        verdict: "needs-attention",
        probesGreen: true,
        resumeMethod: { type: "continue_session" },
      },
    ];

    const result = renderProviderExhaustedOutcome({
      chainId,
      round: 3,
      phase: "strategize",
      jobError: "All routes exhausted:\n  route/p — rate_limit at attempt 3",
      records,
    });

    // Each prior round must appear exactly once in the rendered output.
    // The current (aborted) round shows in the header as "stopped at round 3".
    assert.equal((result.match(/Round 1/g) || []).length, 1);
    assert.equal((result.match(/Round 2/g) || []).length, 1);
    // The current round appears only in the header, not as a "Round 3:" line.
    assert.ok(result.includes("stopped at round 3"));
  });

  it("quota-classified exhaustion shows the classification and NOT the generic retry advice (kusabi #215)", () => {
    const jobError = "claude dispatch failed: You've hit your session limit · resets 1:20am (Asia/Tokyo) — " +
      "session limit exhausted (resets 1:20am (Asia/Tokyo)): the whole claude backend is blocked, " +
      "including your own Claude Code session (same account window). Switch the phase to the opencode " +
      "backend (--model <provider>/<model>); do not retry claude.";
    const result = renderProviderExhaustedOutcome({
      chainId,
      round: 2,
      phase: "implement",
      jobError,
      records: [],
      jobFailure: {
        kind: "quota-exhaustion",
        quota: "session",
        backendBlocked: true,
        reset: "1:20am (Asia/Tokyo)",
      },
    });

    // The classified job error is the surface body.
    assert.ok(result.includes("implement provider exhausted"));
    assert.ok(result.includes("whole claude backend is blocked"));
    assert.ok(result.includes("do not retry claude"));
    // The generic capacity footer would CONTRADICT the classification
    // ("Retry when provider is available" is exactly wrong for a
    // session-limit block) — it must be gone.
    assert.ok(!result.includes("Retry when provider is available"));
    assert.ok(!result.includes("Capacity problem"));
    // The machine-readable classification is pointed at.
    assert.ok(result.includes("Quota exhaustion"));
  });

  it("unclassified exhaustion keeps the generic capacity footer byte-identical", () => {
    const result = renderProviderExhaustedOutcome({
      chainId,
      round: 2,
      phase: "implement",
      jobError: "All routes exhausted: route/a — rate_limit at attempt 3",
      records: [],
    });
    assert.ok(result.includes("Capacity problem — not a quality failure. Retry when provider is available."));
  });
});

// =========================================================================
// handleProviderExhaustion — pure, testable
// =========================================================================

describe("handleProviderExhaustion", () => {
  const chainId = "chain-test-provider-error-1";
  const baseState = {
    chainId,
    round: 3,
    container: "test-container",
    model: "test-model",
    modelChain: ["test-model"],
    maxRounds: 5,
    brief: "Test brief",
    orchestrator: "test-orchestrator",
    baseSha: "abc1234",
    strategized: false,
  };

  function makeRecords(rounds) {
    return rounds.map((r) => ({
      round: r,
      modelEntry: "provider/model-" + r,
      verdict: "needs-attention",
      probesGreen: true,
      resumeMethod: { type: "continue_session" },
    }));
  }

  // ---- implement ----

  it("implement provider-error: the round appears exactly once in records", () => {
    const records = makeRecords([1, 2]);
    const roundRecord = { round: 3, modelEntry: "provider/model-3", verdict: null };

    const result = handleProviderExhaustion({
      records,
      roundRecord,
      currentTierIndex: 0,
      phase: "implement",
      jobError: "All routes exhausted",
      chainFollowupDraft: null,
      ...baseState,
    });

    assert.equal(result.records.length, 3, "records should have 3 entries");
    const round3Entries = result.records.filter((r) => r.round === 3);
    assert.equal(round3Entries.length, 1, "round 3 must appear exactly once");
    assert.equal(round3Entries[0].tierAfter, 0, "tierAfter must be set");
    assert.ok(result.outcome.includes("implement provider exhausted"),
      "outcome names the implement phase");
  });

  // ---- review ----

  it("review provider-error: the round appears exactly once in records", () => {
    const records = makeRecords([1, 2]);
    const roundRecord = { round: 3, modelEntry: "provider/model-3", verdict: null };

    const result = handleProviderExhaustion({
      records,
      roundRecord,
      currentTierIndex: 1,
      phase: "review",
      jobError: "All routes exhausted",
      chainFollowupDraft: null,
      ...baseState,
    });

    assert.equal(result.records.length, 3, "records should have 3 entries");
    const round3Entries = result.records.filter((r) => r.round === 3);
    assert.equal(round3Entries.length, 1, "round 3 must appear exactly once");
    assert.equal(round3Entries[0].tierAfter, 1, "tierAfter must be set");
    assert.ok(result.outcome.includes("review provider exhausted"),
      "outcome names the review phase");
  });

  // ---- strategize (the bug PR #119 fixed) ----

  it("strategize provider-error: the round appears exactly once in records (no duplicate)", () => {
    // round 3 has already been pushed by phase 7 — simulate that state
    const records = makeRecords([1, 2]);
    const roundRecord = { round: 3, modelEntry: "provider/model-3", verdict: null };
    records.push(roundRecord);

    const result = handleProviderExhaustion({
      records,
      roundRecord,
      currentTierIndex: 0,
      phase: "strategize",
      jobError: "All routes exhausted",
      chainFollowupDraft: null,
      ...baseState,
    });

    // Must NOT push the round a second time
    assert.equal(result.records.length, 3, "records should still have 3 entries (no duplicate)");
    const round3Entries = result.records.filter((r) => r.round === 3);
    assert.equal(round3Entries.length, 1, "round 3 must appear exactly once");
    assert.equal(round3Entries[0].tierAfter, 0, "tierAfter must be set on the existing record");
    assert.ok(result.outcome.includes("strategize provider exhausted"),
      "outcome names the strategize phase");
  });

  // ---- persisted state ----

  it("persisted chainState for implement contains the round exactly once", () => {
    const records = makeRecords([1]);
    const roundRecord = { round: 2, modelEntry: "provider/model-2" };

    const result = handleProviderExhaustion({
      records, roundRecord,
      currentTierIndex: 0,
      phase: "implement",
      jobError: "error detail",
      chainFollowupDraft: null,
      ...baseState, round: 2,
    });

    const round2InState = result.chainState.records.filter((r) => r.round === 2);
    assert.equal(round2InState.length, 1, "chainState records must contain round 2 exactly once");
    assert.equal(round2InState[0].tierAfter, 0, "tierAfter must be reflected in chainState");
  });

  it("persisted chainState for review contains the round exactly once", () => {
    const records = makeRecords([1]);
    const roundRecord = { round: 2, modelEntry: "provider/model-2" };

    const result = handleProviderExhaustion({
      records, roundRecord,
      currentTierIndex: 1,
      phase: "review",
      jobError: "error detail",
      chainFollowupDraft: null,
      ...baseState, round: 2,
    });

    const round2InState = result.chainState.records.filter((r) => r.round === 2);
    assert.equal(round2InState.length, 1, "chainState records must contain round 2 exactly once");
  });

  it("persisted chainState for strategize contains the round exactly once", () => {
    const records = makeRecords([1]);
    const roundRecord = { round: 2, modelEntry: "provider/model-2" };
    records.push(roundRecord); // already recorded by phase 7

    const result = handleProviderExhaustion({
      records, roundRecord,
      currentTierIndex: 0,
      phase: "strategize",
      jobError: "error detail",
      chainFollowupDraft: null,
      ...baseState, round: 2,
    });

    // chainState records must contain round 2 exactly once
    const round2InState = result.chainState.records.filter((r) => r.round === 2);
    assert.equal(round2InState.length, 1, "chainState records must contain round 2 exactly once");
  });

  it("chainState carries reviewModel / reviewModelChain verbatim (mixed-chain resume context)", () => {
    // persistChainState persists both; handleProviderExhaustion must too, or
    // an implement provider-exhaustion on a mixed chain loses the review
    // dispatch context and a later chain-resume falls back
    // reviewModelChain ?? modelChain — re-dispatching the review with the
    // implement's claude chain.
    const records = makeRecords([1]);
    const roundRecord = { round: 2, modelEntry: "provider/model-2" };

    const result = handleProviderExhaustion({
      records, roundRecord,
      currentTierIndex: 0,
      phase: "implement",
      jobError: "error detail",
      chainFollowupDraft: null,
      reviewModel: "deepseek/x",
      reviewModelChain: [["deepseek/x"]],
      ...baseState, round: 2,
    });

    assert.equal(result.chainState.reviewModel, "deepseek/x", "reviewModel persisted verbatim");
    assert.deepEqual(result.chainState.reviewModelChain, [["deepseek/x"]], "reviewModelChain persisted verbatim");
  });

  it("chainState without review context defaults both fields to null (never missing)", () => {
    // Key presence (even null) is what chain-resume reads to distinguish a
    // NEW chain from a legacy one — a missing key would silently re-enable
    // the legacy fallback on a chain that legitimately has no review context.
    const records = makeRecords([1]);
    const roundRecord = { round: 2, modelEntry: "provider/model-2" };

    const result = handleProviderExhaustion({
      records, roundRecord,
      currentTierIndex: 0,
      phase: "review",
      jobError: "error detail",
      chainFollowupDraft: null,
      ...baseState, round: 2,
    });

    assert.equal("reviewModel" in result.chainState, true, "reviewModel key always present");
    assert.equal(result.chainState.reviewModel, null);
    assert.equal("reviewModelChain" in result.chainState, true, "reviewModelChain key always present");
    assert.equal(result.chainState.reviewModelChain, null);
  });

  it("chainState carries reworkModel / reworkModelChain / reworkBackend verbatim (rework-round resume context)", () => {
    // persistChainState persists all three; handleProviderExhaustion must
    // too, or a rework implement provider-exhaustion loses the rework
    // dispatch context and a later chain-resume re-dispatches the rework
    // round on the implement resolution (wrong backend / wrong chain).
    const records = makeRecords([1]);
    const roundRecord = { round: 2, modelEntry: "provider/model-2" };

    const result = handleProviderExhaustion({
      records, roundRecord,
      currentTierIndex: 0,
      phase: "implement",
      jobError: "error detail",
      chainFollowupDraft: null,
      reworkModel: "deepseek-v4-flash",
      reworkModelChain: [["opencode-go/deepseek-v4-flash"]],
      reworkBackend: "opencode",
      ...baseState, round: 2,
    });

    assert.equal(result.chainState.reworkModel, "deepseek-v4-flash", "reworkModel persisted verbatim");
    assert.deepEqual(result.chainState.reworkModelChain, [["opencode-go/deepseek-v4-flash"]],
      "reworkModelChain persisted verbatim");
    assert.equal(result.chainState.reworkBackend, "opencode", "reworkBackend persisted verbatim");
  });

  it("chainState without rework context defaults all three rework fields to null (never missing)", () => {
    // Key presence (even null) is what chain-resume reads to distinguish a
    // NEW chain from a legacy one — a missing key would silently re-enable
    // the legacy fallback on a chain that legitimately has no rework context.
    const records = makeRecords([1]);
    const roundRecord = { round: 2, modelEntry: "provider/model-2" };

    const result = handleProviderExhaustion({
      records, roundRecord,
      currentTierIndex: 0,
      phase: "review",
      jobError: "error detail",
      chainFollowupDraft: null,
      ...baseState, round: 2,
    });

    assert.equal("reworkModel" in result.chainState, true, "reworkModel key always present");
    assert.equal(result.chainState.reworkModel, null);
    assert.equal("reworkModelChain" in result.chainState, true, "reworkModelChain key always present");
    assert.equal(result.chainState.reworkModelChain, null);
    assert.equal("reworkBackend" in result.chainState, true, "reworkBackend key always present");
    assert.equal(result.chainState.reworkBackend, null);
  });

  // ---- the push decision is derived, not supplied ----

  it("never duplicates a round that is already in records, whatever the phase", () => {
    // The caller used to pass a roundAlreadyRecorded flag.  A call site that got
    // it wrong would silently duplicate the round (the PR #119 defect) and no
    // test of this function could have caught it, because the function would
    // have been doing exactly what it was told.  The decision is now derived
    // from records, so there is no flag left to get wrong.
    for (const phase of ["implement", "review", "strategize"]) {
      const records = makeRecords([1]);
      const roundRecord = { round: 2, modelEntry: "provider/model-2" };
      records.push(roundRecord);

      const result = handleProviderExhaustion({
        records, roundRecord,
        currentTierIndex: 0,
        phase,
        jobError: "error detail",
        chainFollowupDraft: null,
        ...baseState, round: 2,
      });

      const occurrences = result.chainState.records.filter((r) => r === roundRecord);
      assert.equal(occurrences.length, 1, `round duplicated for phase ${phase}`);
    }
  });

  it("pushes a round that is not yet in records, whatever the phase", () => {
    for (const phase of ["implement", "review", "strategize"]) {
      const records = makeRecords([1]);
      const roundRecord = { round: 2, modelEntry: "provider/model-2" };

      const result = handleProviderExhaustion({
        records, roundRecord,
        currentTierIndex: 0,
        phase,
        jobError: "error detail",
        chainFollowupDraft: null,
        ...baseState, round: 2,
      });

      const occurrences = result.chainState.records.filter((r) => r === roundRecord);
      assert.equal(occurrences.length, 1, `round missing or duplicated for phase ${phase}`);
    }
  });

  // ---- outcome names the phase ----

  it("rendered outcome names each failing phase", () => {
    const phases = [
      { phase: "implement",  alreadyRecorded: false },
      { phase: "review",     alreadyRecorded: false },
      { phase: "strategize", alreadyRecorded: true },
    ];

    for (const { phase, alreadyRecorded } of phases) {
      const records = makeRecords([1]);
      const roundRecord = { round: 2, modelEntry: "provider/model-2" };
      if (alreadyRecorded) records.push(roundRecord);

      const result = handleProviderExhaustion({
        records, roundRecord,
        currentTierIndex: 0,
        phase,
        jobError: "error detail",
        chainFollowupDraft: null,
        ...baseState, round: 2,
      });

      assert.ok(
        result.outcome.includes(phase + " provider exhausted"),
        "outcome must name the phase: " + phase,
      );
    }
  });

  // ---- structured failure classification (kusabi #215) ----

  it("threads a classified jobFailure into the outcome (classification shown, generic retry advice dropped)", () => {
    const records = makeRecords([1]);
    const roundRecord = { round: 2, modelEntry: "provider/model-2", verdict: null };

    const result = handleProviderExhaustion({
      records,
      roundRecord,
      currentTierIndex: 0,
      phase: "implement",
      jobError: "claude dispatch failed: You've hit your session limit · resets 1:20am (Asia/Tokyo) — " +
        "session limit exhausted: the whole claude backend is blocked; do not retry claude.",
      jobFailure: {
        kind: "quota-exhaustion",
        quota: "session",
        backendBlocked: true,
        reset: "1:20am (Asia/Tokyo)",
      },
      chainFollowupDraft: null,
      ...baseState,
    });

    assert.ok(result.outcome.includes("whole claude backend is blocked"));
    assert.ok(result.outcome.includes("do not retry claude"));
    assert.ok(!result.outcome.includes("Retry when provider is available"),
      "the generic capacity footer must not contradict the classification");
  });

  it("a null jobFailure keeps the generic outcome byte-identical", () => {
    const records = makeRecords([1]);
    const roundRecord = { round: 2, modelEntry: "provider/model-2", verdict: null };

    const result = handleProviderExhaustion({
      records,
      roundRecord,
      currentTierIndex: 0,
      phase: "implement",
      jobError: "All routes exhausted",
      jobFailure: null,
      chainFollowupDraft: null,
      ...baseState,
    });

    assert.ok(result.outcome.includes("All routes exhausted"));
    assert.ok(result.outcome.includes("Capacity problem — not a quality failure. Retry when provider is available."));
  });
});

// =========================================================================
// Source guards for kusabi #439
// =========================================================================

describe("chain-outcomes source guards (kusabi #439)", () => {
  it("chain-phases.mjs does not export moved outcome functions", () => {
    const chainPhasesSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-phases.mjs"), "utf8");
    assert.ok(!chainPhasesSrc.includes("export function renderAcceptOutcome("));
    assert.ok(!chainPhasesSrc.includes("export function renderAcceptWithFollowupOutcome("));
    assert.ok(!chainPhasesSrc.includes("export function renderEscalateOutcome("));
    assert.ok(!chainPhasesSrc.includes("export function renderRefusalOutcome("));
    assert.ok(!chainPhasesSrc.includes("export function renderBriefSyntaxDefectOutcome("));
    assert.ok(!chainPhasesSrc.includes("export function renderMaxRoundsOutcome("));
    assert.ok(!chainPhasesSrc.includes("export function renderProviderExhaustedOutcome("));
    assert.ok(!chainPhasesSrc.includes("export function handleProviderExhaustion("));
  });

  it("chain-phases.mjs does not import chain-outcomes.mjs", () => {
    const chainPhasesSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-phases.mjs"), "utf8");
    assert.ok(!chainPhasesSrc.includes('from "./chain-outcomes.mjs"'));
    assert.ok(!chainPhasesSrc.includes("from './chain-outcomes.mjs'"));
  });
});
