import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { countUnfilledReviewRecords } from "./review-record-scan.mjs";
import {
  extractJson,
  renderReview,
  renderChainShow,
  renderJobLine,
  renderHeader,
  renderBaseFacts,
  renderContainerReviewInput,
  renderFollowupDraft,
  renderStrategistPrompt,
  renderReviewRecord,
  renderEscalationDecisions,
  recoverVerdictFromText,
  roundDiscardReason,
  roundChangedColumn,
} from "./render.mjs";
import { sampleParsed } from "./fixtures.mjs";

// extractJson
// ---------------------------------------------------------------------------

describe("extractJson", () => {
  it("parses a plain JSON string", () => {
    const result = extractJson('{"a":1,"b":"two"}');
    assert.deepEqual(result, { a: 1, b: "two" });
  });

  it("parses JSON inside a fenced code block", () => {
    const input = "```json\n{\"verdict\":\"approve\"}\n```";
    const result = extractJson(input);
    assert.deepEqual(result, { verdict: "approve" });
  });

  it("parses JSON inside a fenced code block without language tag", () => {
    const input = "```\n{\"x\":42}\n```";
    const result = extractJson(input);
    assert.deepEqual(result, { x: 42 });
  });

  it("returns null for invalid input", () => {
    assert.equal(extractJson("not json"), null);
  });

  it("returns null for malformed JSON in fence", () => {
    const input = "```json\n{invalid}\n```";
    assert.equal(extractJson(input), null);
  });

  it("recovers bare JSON after prose with a trailing VERDICT line (no fence)", () => {
    // kusabi #170 round-1 shape: prose, then one line of bare JSON, then a
    // trailing VERDICT: line.  Whole-text parse fails on the prose and there
    // is no fence, so recovery must find the JSON substring.
    const obj = { verdict: "needs-attention", summary: "probe fix looks wrong" };
    const input = "prose sentence.\n\n" + JSON.stringify(obj) + "\nVERDICT: needs-attention";
    const result = extractJson(input);
    assert.deepEqual(result, obj);
  });

  it("recovers JSON from an unclosed ```json fence with a trailing VERDICT line", () => {
    // kusabi #170 round-2 shape: prose, then a ```json fence that is never
    // closed, containing the JSON, then a trailing VERDICT: line.  The lazy
    // closed-fence regex requires a closing ``` so it never matches here.
    const obj = { verdict: "needs-attention", summary: "probe fix looks wrong" };
    const input = "prose.\n```json\n" + JSON.stringify(obj) + "\nVERDICT: needs-attention";
    const result = extractJson(input);
    assert.deepEqual(result, obj);
  });

  it("recovers a review-shaped object with nested braces and escaped quotes", () => {
    // kusabi #170 criterion 3: nested braces { } and escaped quotes inside
    // string values must not break recovery in either shape.
    const obj = {
      verdict: "needs-attention",
      summary: "probe output reviewed",
      findings: [
        { severity: "low", title: "cosmetic", body: "contains braces { } and \"quotes\"" },
      ],
    };
    const round1 = "prose sentence.\n\n" + JSON.stringify(obj) + "\nVERDICT: needs-attention";
    const round2 = "prose.\n```json\n" + JSON.stringify(obj) + "\nVERDICT: needs-attention";
    assert.deepEqual(extractJson(round1), obj);
    assert.deepEqual(extractJson(round2), obj);
  });

  it("parses a closed fence with prose around it", () => {
    const input = "Some prose before.\n```json\n{\"verdict\":\"approve\"}\n```\nSome prose after.";
    const result = extractJson(input);
    assert.deepEqual(result, { verdict: "approve" });
  });

  it("returns null for prose with a stray brace but no parseable JSON", () => {
    assert.equal(extractJson("prose with a {stray brace and nothing else"), null);
    assert.equal(extractJson("{a} still no json here"), null);
  });

  it("does not recover a parseable non-review object quoted in prose", () => {
    // A probe result quoted in prose is parseable JSON but not a review.
    // Recovering it would override a correctly recovered VERDICT token and
    // suppress the #147 unparseable retry — it must be rejected.
    const input = 'The probe output {"status":"ok","n":3} and the fix is fine.\nVERDICT: approve';
    assert.equal(extractJson(input), null);
  });

  it("does not recover a non-review object from token-less garbage output", () => {
    // With no VERDICT token either, the result must stay null so the
    // deliberate #147 unparseable retry still fires.
    assert.equal(extractJson('garbage output with {"status":"ok"} embedded'), null);
  });

  it("does not recover a non-review object inside an unclosed fence", () => {
    const input = 'prose.\n```json\n{"status":"ok","n":3}\nVERDICT: approve';
    assert.equal(extractJson(input), null);
  });

  it("still parses a non-review object via the whole-text and closed-fence paths", () => {
    // The review-shape guard applies only to the recovery paths — paths 1
    // and 2 keep their existing behaviour.
    assert.deepEqual(extractJson('{"status":"ok"}'), { status: "ok" });
    assert.deepEqual(extractJson('```json\n{"status":"ok"}\n```'), { status: "ok" });
  });
});

// recoverVerdictFromText — verdict recovery (A1/A3)
// ---------------------------------------------------------------------------

describe("recoverVerdictFromText", () => {
  it("recovers token on last line (standard location)", () => {
    const result = recoverVerdictFromText("Some text\nVERDICT: approve");
    assert.deepEqual(result, { verdict: "approve" });
  });

  it("recovers token when it is on the last line outside JSON fence", () => {
    // A1: VERDICT token appears after the JSON fence (normal position)
    const text = '```json\n{\n  "verdict": "needs-attention",\n  "summary": "There is a bug",\n  "findings": [\n    { "severity": "high", "title": "Null pointer", "file": "src/main.js", "line_start": 42 }\n  ]\n}\n```\nVERDICT: needs-attention';
    const result = recoverVerdictFromText(text);
    assert.deepEqual(result, { verdict: "needs-attention" });
  });

  it("recovers token when there is no trailing token but token is inside the fence as a standalone line", () => {
    // When the model puts the VERDICT token as a standalone construct inside
    // the JSON fence block (the real-world incident scenario).
    const text = '```json\n{\n  "verdict": "needs-attention",\n  "summary": "All five prior findings are genuinely fixed.",\n  "findings": []\n}\n```\n```\nVERDICT: needs-attention\n```';
    const result = recoverVerdictFromText(text);
    assert.deepEqual(result, { verdict: "needs-attention" });
  });

  it("returns null when no token present", () => {
    const result = recoverVerdictFromText("Some random text without a verdict");
    assert.equal(result, null);
  });

  it("recovers approve-partial", () => {
    const result = recoverVerdictFromText("Some text\nVERDICT: approve-partial");
    assert.deepEqual(result, { verdict: "approve-partial" });
  });

  it("recovers discard", () => {
    const result = recoverVerdictFromText("Some text\nVERDICT: discard");
    assert.deepEqual(result, { verdict: "discard" });
  });

  it("recovers needs-attention", () => {
    const result = recoverVerdictFromText("Some text\nVERDICT: needs-attention");
    assert.deepEqual(result, { verdict: "needs-attention" });
  });
});

// renderReview
// ---------------------------------------------------------------------------

describe("renderReview", () => {
  it("(a) renders a structured review from a parsed object", () => {
    const result = renderReview(sampleParsed, "");
    assert.match(result, /\*\*Verdict: approve\*\*/);
    assert.match(result, /The code looks good\./);
    assert.match(result, /Minor style issue/);
    assert.match(result, /Recommendation:/);
    assert.match(result, /Next steps:/);
  });

  it("(a) handles empty findings", () => {
    const parsed = { verdict: "approve", summary: "OK", findings: [] };
    const result = renderReview(parsed, "");
    assert.match(result, /No material findings\./);
  });

  it("(b) recovers from terminal token when parsed is null and rawText ends with VERDICT: needs-attention", () => {
    const rawText = "Some output text\nVERDICT: needs-attention";
    const result = renderReview(null, rawText);
    assert.match(result, /recovered from terminal token/);
    assert.match(result, /needs-attention/);
    assert.match(result, /Some output text/);
  });

  it("(b) recovers from terminal token when parsed is null and rawText ends with VERDICT: approve", () => {
    const rawText = "Some output text\nVERDICT: approve";
    const result = renderReview(null, rawText);
    assert.match(result, /recovered from terminal token/);
    assert.match(result, /approve/);
  });

  it("(b2) recovers from terminal token when parsed is null and rawText ends with VERDICT: approve-partial", () => {
    const rawText = "Some output text\nVERDICT: approve-partial";
    const result = renderReview(null, rawText);
    assert.match(result, /recovered from terminal token/);
    assert.match(result, /approve-partial/);
  });

  it("(c) renders unverified field when present in parsed object", () => {
    const parsed = {
      verdict: "approve-partial",
      summary: "Mostly OK but some checks could not run.",
      findings: [],
      next_steps: ["Ask orchestrator to verify remaining items."],
      unverified: ["Integration tests require Docker", "Load test environment not available"],
    };
    const result = renderReview(parsed, "");
    assert.match(result, /\*\*Verdict: approve-partial\*\*/);
    assert.match(result, /\*\*Unverified:\*\*/);
    assert.match(result, /Integration tests require Docker/);
    assert.match(result, /Load test environment not available/);
    assert.match(result, /\*\*Next steps:\*\*/);
  });

  it("(c2) skips unverified section when unverified is empty", () => {
    const parsed = {
      verdict: "approve",
      summary: "All clear.",
      findings: [],
      unverified: [],
    };
    const result = renderReview(parsed, "");
    assert.match(result, /\*\*Verdict: approve\*\*/);
    assert.doesNotMatch(result, /\*\*Unverified:\*\*/);
  });

  it("(d) falls back for null parsed with no terminal token", () => {
    const rawText = "Some random output without a verdict token";
    const result = renderReview(null, rawText);
    assert.match(result, /review output was not valid JSON/);
    assert.match(result, /Some random output/);
  });
});

// renderFollowupDraft — Decision 5 follow-up issue draft
// ---------------------------------------------------------------------------

describe("renderFollowupDraft", () => {
  it("renders a follow-up draft with chain id, brief title, and findings", () => {
    const findings = [
      { severity: "low", title: "Minor style issue", file: "src/foo.js", line_start: 10 },
      { severity: "medium", title: "Unused variable", file: "src/bar.js", line_start: 42 },
    ];
    const result = renderFollowupDraft({
      chainId: "chain-abc123",
      briefTitle: "Implement feature X",
      findings: findings,
    });
    assert.match(result, /Follow-up issue draft/);
    assert.match(result, /not posted.*orchestrator judgement required/);
    assert.match(result, /Chain: chain-abc123/);
    assert.match(result, /Brief: Implement feature X/);
    assert.match(result, /\[low\] Minor style issue \(src\/foo\.js:10\)/);
    assert.match(result, /\[medium\] Unused variable \(src\/bar\.js:42\)/);
    assert.match(result, /economic cutoff/);
    assert.match(result, /orchestrator should review/);
  });

  it("graceful with missing fields (never throws)", () => {
    const result = renderFollowupDraft({});
    assert.match(result, /Follow-up issue draft/);
    assert.match(result, /Chain: \(unknown\)/);
    assert.match(result, /\(none\)/);
  });

  it("graceful with no arguments (never throws)", () => {
    const result = renderFollowupDraft();
    assert.match(result, /Follow-up issue draft/);
    assert.match(result, /Chain: \(unknown\)/);
  });

  it("renders findings verbatim with severity, title, file, line_start", () => {
    const findings = [
      { severity: "low", title: "Typo in comment", file: "src/utils.js", line_start: 15 },
    ];
    const result = renderFollowupDraft({ findings: findings });
    assert.ok(result.includes("[low] Typo in comment (src/utils.js:15)"));
  });

  it("handles missing severity, title, file, line_start gracefully", () => {
    const findings = [
      { severity: undefined, title: undefined, file: undefined, line_start: undefined },
    ];
    const result = renderFollowupDraft({ findings: findings });
    assert.ok(result.includes("[unknown] (untitled) (unknown:?)"));
  });

  it("shows (none) for empty findings array", () => {
    const result = renderFollowupDraft({ findings: [] });
    assert.ok(result.includes("(none)"));
  });
});

// renderReview — discard verdict terminal token recovery
// ---------------------------------------------------------------------------

describe("renderReview discard token", () => {
  it("recovers from terminal token when parsed is null and rawText ends with VERDICT: discard", () => {
    const rawText = "The premise is wrong.\nVERDICT: discard";
    const result = renderReview(null, rawText);
    assert.match(result, /recovered from terminal token/);
    assert.match(result, /discard/);
  });

  // A1: VERDICT token inside the JSON fence
  it("recovers verdict when token is inside the JSON fence (real-world incident)", () => {
    // The model placed VERDICT inside the JSON fence, then the fence closed.
    // Without trailing token, the old strip regex (anchored to $) missed it.
    const rawText = '```json\n{\n  "verdict": "needs-attention",\n  "summary": "All five prior findings are genuinely fixed. However, one function is dead code."\n}\n```\nVERDICT: needs-attention';
    const result = renderReview(null, rawText);
    assert.match(result, /recovered from terminal token/);
    assert.match(result, /needs-attention/);
  });

  // A1: token inside fence, no trailing token (the worst case)
  it("recovers verdict when token is only inside the JSON fence", () => {
    const rawText = 'Here is my review:\n\n```json\n{\n  "verdict": "needs-attention",\n  "findings": [\n    { "severity": "high", "title": "Bug", "file": "src/main.js", "line_start": 10, "line_end": 15 }\n  ]\n}\n```\nVERDICT: needs-attention';
    const result = renderReview(null, rawText);
    assert.match(result, /recovered from terminal token/);
    assert.match(result, /needs-attention/);
  });
});

// renderReview — malformed-review guards (kusabi #153)
// ---------------------------------------------------------------------------
// A model responding to a broken review input (e.g. git failure text in the
// prompt) can emit `findings` as a string or object instead of an array.
// renderReview must normalise and annotate — never throw an internal
// "findings.forEach is not a function" TypeError.

describe("renderReview malformed fields", () => {
  it("normalises a string findings field instead of crashing", () => {
    const parsed = { verdict: "needs-attention", summary: "s", findings: "not an array" };
    const result = renderReview(parsed, "");
    assert.match(result, /malformed review: "findings" was not an array/);
    assert.match(result, /No material findings\./);
    assert.doesNotMatch(result, /forEach/);
  });

  it("normalises an object findings field instead of crashing", () => {
    const parsed = { verdict: "approve", summary: "s", findings: { file: "x.js" } };
    const result = renderReview(parsed, "");
    assert.match(result, /malformed review: "findings" was not an array \(object\)/);
  });

  it("treats a string next_steps as absent instead of crashing", () => {
    const parsed = { verdict: "approve", summary: "s", findings: [], next_steps: "just text" };
    const result = renderReview(parsed, "");
    assert.doesNotMatch(result, /Next steps:/);
    assert.doesNotMatch(result, /forEach/);
  });

  it("treats a string unverified as absent instead of crashing", () => {
    const parsed = { verdict: "approve", summary: "s", findings: [], unverified: "just text" };
    const result = renderReview(parsed, "");
    assert.doesNotMatch(result, /Unverified:/);
    assert.doesNotMatch(result, /forEach/);
  });

  it("does not annotate malformed-review when findings is a proper array", () => {
    const parsed = { verdict: "approve", summary: "s", findings: [] };
    const result = renderReview(parsed, "");
    assert.doesNotMatch(result, /malformed review/);
    assert.match(result, /No material findings\./);
  });
});

// renderChainShow — chain-show pure rendering helper
// ---------------------------------------------------------------------------

describe("renderChainShow", () => {
  const sampleChain = {
    chainId: "chain-abc123",
    container: "test-container-one",
    orchestrator: { model: "anthropic/claude-4", session: "ses_xyz", date: "2026-07-22" },
    brief: "Implement feature X\n\nThis is a longer brief about feature X.",
    chainTotals: { input: 730, output: 750, reasoning: 50, cacheRead: 1500, cacheWrite: 0, cost: 0.005 },
  };

  const sampleRounds = [
    {
      round: 1,
      modelEntry: "opencode-go/deepseek-v4-flash",
      verdict: "needs-attention",
      disposition: { disposition: "rework", reason: "needs-attention" },
      resumeMethod: { type: "continue_session" },
      probeResults: [
        { probe: "P1: HEAD clean", passed: true, detail: "HEAD matches base test-container-one" },
        { probe: "P2: verify gate", passed: false, detail: JSON.stringify({ gate_passed: false }) },
      ],
      findingsText: "[low] Minor style issue (src/foo.js:10)\n[high] Missing error handling (src/bar.js:42)",
      implementUsage: { available: true, input: 250, output: 300, reasoning: 50, cost: 0.002 },
      reviewUsage: { available: true, input: 100, output: 200, cost: 0.001 },
    },
    {
      round: 2,
      modelEntry: "opencode-go/deepseek-v4-pro",
      verdict: "approve",
      disposition: { disposition: "accept" },
      resumeMethod: { type: "continue_session" },
      probeResults: [
        { probe: "P1: HEAD clean", passed: true, detail: "HEAD matches base test-container-one" },
        { probe: "P2: verify gate", passed: true, detail: JSON.stringify({ gate_passed: true, diff_summary: { changed_files: 3, untracked: 1 } }) },
      ],
      findingsText: "[low] Minor style issue (src/foo.js:10)",
      implementUsage: { available: true, input: 300, output: 150, cost: 0.0015 },
      reviewUsage: { available: true, input: 80, output: 100, cost: 0.0005 },
    },
  ];

  it("surfaces unreadable round records instead of silently omitting them", () => {
    const result = renderChainShow(sampleChain, sampleRounds, ["round-3.json"]);
    assert.match(result, /!! unreadable round records \(excluded below\): round-3\.json/);
    // absent by default
    const clean = renderChainShow(sampleChain, sampleRounds);
    assert.ok(!clean.includes("unreadable round records"));
  });

  it("renders header with chain id, status, orchestrator, brief, container", () => {
    const result = renderChainShow(sampleChain, sampleRounds);
    assert.match(result, /chain: chain-abc123/);
    assert.match(result, /status: accepted at round 2/);
    assert.match(result, /orchestrator: anthropic\/claude-4/);
    assert.match(result, /brief: Implement feature X/);
    assert.match(result, /container: test-container-one/);
  });

  it("renders per-round fields: model, verdict, disposition, resume, probes, usage", () => {
    const result = renderChainShow(sampleChain, sampleRounds);
    // Round 1
    assert.match(result, /Round 1/);
    assert.match(result, /model: opencode-go\/deepseek-v4-flash/);
    assert.match(result, /verdict: needs-attention/);
    assert.match(result, /disposition: rework \(needs-attention\)/);
    assert.match(result, /resume: continue_session/);
    assert.match(result, /P1: HEAD clean — PASS/);
    assert.match(result, /P2: verify gate — FAIL/);
    assert.match(result, /implement: 250 in \/ 300 out.*cost=\$0\.002/);
    assert.match(result, /review: 100 in \/ 200 out.*cost=\$0\.001/);
    // Round 2
    assert.match(result, /Round 2/);
    assert.match(result, /model: opencode-go\/deepseek-v4-pro/);
    assert.match(result, /verdict: approve/);
    assert.match(result, /disposition: accept/);
    assert.match(result, /P2: verify gate — PASS.*gate_passed=true.*changed=3.*untracked=1/);
  });

  it("marks interrupted and resumed rounds (kusabi #153\u2460)", () => {
    const chain = { chainId: "chain-int", brief: "Interrupted chain" };
    const rounds = [
      {
        round: 2,
        modelEntry: "opencode-go/deepseek-v4-flash",
        verdict: "approve",
        disposition: { disposition: "accept" },
        resumeMethod: { type: "continue_session" },
        interrupted: true,
        interruptedAfter: "probes",
        resumed: true,
      },
      {
        round: 3,
        modelEntry: "opencode-go/deepseek-v4-flash",
        interrupted: true,
        interruptedAfter: "probes",
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.match(result, /Round 2/);
    assert.match(result, /interrupted: yes \(after probes\)/);
    assert.match(result, /resumed: yes/);
    // A partial round without verdict/disposition still shows its trace
    assert.match(result, /Round 3/);
    assert.match(result, /interrupted: yes \(after probes\)/);
  });

  it("renders totals line", () => {
    const result = renderChainShow(sampleChain, sampleRounds);
    assert.match(result, /totals: 730 in \/ 750 out.*reasoning.*cacheRead=1500.*cost=\$0\.005/);
  });

  it("tolerates missing optional fields (no orchestrator, no usage, no probe detail)", () => {
    const minimalChain = { chainId: "chain-min", brief: "Minimal chain" };
    const minimalRounds = [
      {
        round: 1,
        verdict: "approve",
        disposition: { disposition: "accept" },
        resumeMethod: { type: "continue_session" },
        findingsText: "All good.",
      },
    ];
    const result = renderChainShow(minimalChain, minimalRounds);
    // Should not throw, should render basic info
    assert.match(result, /chain: chain-min/);
    assert.match(result, /status: accepted at round 1/);
    assert.match(result, /Round 1/);
    assert.ok(result.includes("findings:\n  All good."));
    // No orchestrator line, no container line, no usage lines
    assert.doesNotMatch(result, /orchestrator:/);
    assert.doesNotMatch(result, /container:/);
    assert.doesNotMatch(result, /implement:/);
    assert.doesNotMatch(result, /review:/);
  });

  it("renders salvaged verdict with (salvaged) marker (kusabi #312)", () => {
    const chain = { chainId: "chain-salvaged" };
    const rounds = [
      {
        round: 1,
        verdict: "approve",
        salvagedVerdict: true,
        disposition: { disposition: "accept" },
        resumeMethod: { type: "continue_session" },
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.match(result, /verdict: approve \(salvaged\)/);
  });

  it("renders non-salvaged verdict without (salvaged) marker", () => {
    const chain = { chainId: "chain-clean" };
    const rounds = [
      {
        round: 1,
        verdict: "approve",
        disposition: { disposition: "accept" },
        resumeMethod: { type: "continue_session" },
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.match(result, /verdict: approve/);
    assert.doesNotMatch(result, /verdict: approve \(salvaged\)/);
  });

  it("renders without probe results when probes are absent", () => {
    const chain = { chainId: "chain-noprobe" };
    const rounds = [
      {
        round: 1,
        verdict: "needs-attention",
        disposition: { disposition: "rework", reason: "needs-attention" },
        resumeMethod: { type: "continue_session" },
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.match(result, /chain: chain-noprobe/);
    assert.match(result, /Round 1/);
    // No probes: no PASS/FAIL probe result lines should appear
    assert.doesNotMatch(result, /— PASS/);
    assert.doesNotMatch(result, /— FAIL/);
  });

  it("renders escalated status correctly", () => {
    const chain = { chainId: "chain-escalated" };
    const rounds = [
      {
        round: 1,
        verdict: "discard",
        disposition: { disposition: "escalate", reason: "reviewer discarded the work" },
        resumeMethod: { type: "continue_session" },
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.match(result, /status: escalated at round 1 \(reviewer discarded the work\)/);
    // A reviewer's discard renders unchanged: the probe-discard line below is
    // keyed on verdictSource "probe", which this round does not carry.
    assert.doesNotMatch(result, /empty round discarded/);
  });

  // ---- probe-discarded empty rounds say where the work is (kusabi #299) ----
  // The digest must not read "reviewer discarded the work" over a worktree
  // that still holds every earlier round's changes.

  it("probe-discarded round on a dirty tree says the prior work is still there", () => {
    const chain = { chainId: "chain-empty-round" };
    const rounds = [
      {
        round: 3,
        verdict: "discard",
        verdictSource: "probe",
        worktreeDirtyVsBase: true,
        disposition: { disposition: "escalate", reason: "reviewer discarded the work" },
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.match(result, /empty round discarded \(no reviewer ran\)/);
    assert.match(result, /still DIRTY vs the chain base/);
    assert.match(result, /work is intact/);
  });

  it("probe-discarded round on a clean tree says nothing is left", () => {
    const rounds = [
      { round: 1, verdict: "discard", verdictSource: "probe", worktreeDirtyVsBase: false },
    ];
    const result = renderChainShow({ chainId: "chain-clean" }, rounds);
    assert.match(result, /empty round discarded \(no reviewer ran\)/);
    assert.match(result, /CLEAN vs the chain base/);
    assert.doesNotMatch(result, /DIRTY vs the chain base/);
  });

  it("probe-discarded round from a record predating the field states the gap", () => {
    const rounds = [
      { round: 1, verdict: "discard", verdictSource: "probe" },
    ];
    const result = renderChainShow({ chainId: "chain-legacy" }, rounds);
    assert.match(result, /dirty-vs-base not recorded/);
  });

  // ---- the status headline and the disposition line must not read
  // "reviewer discarded the work" for a round no reviewer ever saw ----
  // The recorded disposition reason on a probe-discarded round is
  // deriveDisposition's generic discard text, so both surfaces are re-keyed
  // on verdictSource "probe"; these pin that the incident's misleading phrase
  // is gone from the two most prominent renderings of the round.

  it("status headline of a probe-discarded round says the round was empty and the worktree is still dirty", () => {
    const chain = { chainId: "chain-empty-round" };
    const rounds = [
      {
        round: 3,
        verdict: "discard",
        verdictSource: "probe",
        worktreeDirtyVsBase: true,
        disposition: { disposition: "escalate", reason: "reviewer discarded the work" },
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.match(result, /status: escalated at round 3 \(empty round discarded by probe; worktree still DIRTY vs the chain base\)/);
    assert.doesNotMatch(result, /status:.*reviewer discarded the work/);
  });

  it("disposition line of a probe-discarded round carries the probe-discard wording, not the reviewer's", () => {
    const rounds = [
      {
        round: 3,
        verdict: "discard",
        verdictSource: "probe",
        worktreeDirtyVsBase: true,
        disposition: { disposition: "escalate", reason: "reviewer discarded the work" },
      },
    ];
    const result = renderChainShow({ chainId: "chain-empty-round" }, rounds);
    assert.match(result, /disposition: escalate \(empty round discarded by probe; worktree still DIRTY vs the chain base\)/);
    assert.doesNotMatch(result, /disposition: escalate \(reviewer discarded the work\)/);
  });

  it("probe-discarded round on a clean tree: headline and disposition say the worktree is CLEAN", () => {
    const rounds = [
      {
        round: 1,
        verdict: "discard",
        verdictSource: "probe",
        worktreeDirtyVsBase: false,
        disposition: { disposition: "escalate", reason: "reviewer discarded the work" },
      },
    ];
    const result = renderChainShow({ chainId: "chain-clean" }, rounds);
    assert.match(result, /status: escalated at round 1 \(empty round discarded by probe; worktree CLEAN vs the chain base\)/);
    assert.match(result, /disposition: escalate \(empty round discarded by probe; worktree CLEAN vs the chain base\)/);
  });

  it("probe-discarded round from a record predating the field: headline and disposition state the gap", () => {
    const rounds = [
      {
        round: 1,
        verdict: "discard",
        verdictSource: "probe",
        disposition: { disposition: "escalate", reason: "reviewer discarded the work" },
      },
    ];
    const result = renderChainShow({ chainId: "chain-legacy" }, rounds);
    assert.match(result, /status: escalated at round 1 \(empty round discarded by probe; dirty-vs-base not recorded\)/);
    assert.match(result, /disposition: escalate \(empty round discarded by probe; dirty-vs-base not recorded\)/);
  });

  it("a reviewer-verdict discard keeps 'reviewer discarded the work' on the headline and the disposition line", () => {
    const rounds = [
      {
        round: 1,
        verdict: "discard",
        disposition: { disposition: "escalate", reason: "reviewer discarded the work" },
      },
    ];
    const result = renderChainShow({ chainId: "chain-reviewer-discard" }, rounds);
    assert.match(result, /status: escalated at round 1 \(reviewer discarded the work\)/);
    assert.match(result, /disposition: escalate \(reviewer discarded the work\)/);
  });

  // The digest's changed: line is one of the surfaces the shared describer
  // roundChangedColumn feeds (kusabi #299): a probe-discarded round's
  // worktreeChanged is false by construction, so the line states the recorded
  // dirty-vs-base fact instead of a bare NO that reads as "nothing there".
  it("the changed line of a probe-discarded round states the dirty-vs-base fact, not a bare NO", () => {
    const rounds = [
      { round: 1, verdict: "discard", verdictSource: "probe", worktreeDirtyVsBase: true, worktreeChanged: false },
    ];
    const result = renderChainShow({ chainId: "chain-empty-round" }, rounds);
    assert.match(result, /changed: NO \(worktree DIRTY vs chain base\)/);
  });

  it("the changed line of a probe-discarded clean round states CLEAN", () => {
    const rounds = [
      { round: 1, verdict: "discard", verdictSource: "probe", worktreeDirtyVsBase: false, worktreeChanged: false },
    ];
    const result = renderChainShow({ chainId: "chain-clean" }, rounds);
    assert.match(result, /changed: NO \(worktree CLEAN vs chain base\)/);
  });

  it("the changed line of a reviewer-verdict discard stays a bare NO", () => {
    const rounds = [
      { round: 1, verdict: "discard", worktreeChanged: false },
    ];
    const result = renderChainShow({ chainId: "chain-reviewer-discard" }, rounds);
    assert.match(result, /changed: NO$/m);
    assert.doesNotMatch(result, /changed: NO \(/);
  });

  // ---- shared round describers (kusabi #299) ----
  // roundDiscardReason and roundChangedColumn are the single home of the
  // probe-discard re-keying; every renderer — chain-show, the terminal
  // outcomes, the postable review record — calls them instead of keeping its
  // own copy of the condition.

  it("roundDiscardReason: probe-discard rounds get the probe wording, all others the recorded reason", () => {
    assert.equal(
      roundDiscardReason({ verdict: "discard", verdictSource: "probe", worktreeDirtyVsBase: true }, "reviewer discarded the work"),
      "empty round discarded by probe; worktree still DIRTY vs the chain base",
    );
    assert.equal(
      roundDiscardReason({ verdict: "discard", verdictSource: "probe", worktreeDirtyVsBase: false }, "reviewer discarded the work"),
      "empty round discarded by probe; worktree CLEAN vs the chain base",
    );
    assert.equal(
      roundDiscardReason({ verdict: "discard", verdictSource: "probe" }, "reviewer discarded the work"),
      "empty round discarded by probe; dirty-vs-base not recorded",
    );
    // Reviewer-verdict discard and any non-discard verdict: fallback verbatim.
    assert.equal(roundDiscardReason({ verdict: "discard" }, "reviewer discarded the work"), "reviewer discarded the work");
    assert.equal(roundDiscardReason({ verdict: "approve" }, "some reason"), "some reason");
    assert.equal(roundDiscardReason(null, "some reason"), "some reason");
  });

  it("roundChangedColumn: unknown / yes / NO for ordinary rounds", () => {
    assert.equal(roundChangedColumn({}), "unknown");
    assert.equal(roundChangedColumn({ worktreeChanged: null }), "unknown");
    assert.equal(roundChangedColumn({ worktreeChanged: true }), "yes");
    assert.equal(roundChangedColumn({ worktreeChanged: false }), "NO");
    assert.equal(roundChangedColumn({ verdict: "discard", worktreeChanged: false }), "NO");
  });

  it("roundChangedColumn: probe-discarded rounds state dirty-vs-base instead of a bare NO", () => {
    assert.equal(
      roundChangedColumn({ verdict: "discard", verdictSource: "probe", worktreeDirtyVsBase: true, worktreeChanged: false }),
      "NO (worktree DIRTY vs chain base)",
    );
    assert.equal(
      roundChangedColumn({ verdict: "discard", verdictSource: "probe", worktreeDirtyVsBase: false, worktreeChanged: false }),
      "NO (worktree CLEAN vs chain base)",
    );
    assert.equal(
      roundChangedColumn({ verdict: "discard", verdictSource: "probe", worktreeChanged: false }),
      "NO (dirty-vs-base not recorded)",
    );
  });

  it("renders incomplete status when chain has no rounds", () => {
    const result = renderChainShow({ chainId: "chain-empty" }, []);
    assert.match(result, /chain: chain-empty/);
    assert.match(result, /status: incomplete/);
  });

  it("probe detail with diff_summary shows counts", () => {
    const chain = { chainId: "chain-diff" };
    const rounds = [
      {
        round: 1,
        verdict: "approve",
        disposition: { disposition: "accept" },
        resumeMethod: { type: "continue_session" },
        probeResults: [
          { probe: "P2: verify gate", passed: true, detail: JSON.stringify({
            gate_passed: true,
            diff_summary: { changed_files: 5, untracked: 2 },
          })},
        ],
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.match(result, /P2: verify gate — PASS.*changed=5.*untracked=2/);
  });

  it("probe detail as JSON without diff_summary shows gate_passed only", () => {
    const chain = { chainId: "chain-gateonly" };
    const rounds = [
      {
        round: 1,
        verdict: "approve",
        disposition: { disposition: "accept" },
        resumeMethod: { type: "continue_session" },
        probeResults: [
          { probe: "P2: verify gate", passed: false, detail: JSON.stringify({ gate_passed: false }) },
        ],
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.match(result, /P2: verify gate — FAIL.*gate_passed=false/);
    // No count parts when diff_summary absent
    assert.doesNotMatch(result, /changed=/);
    assert.doesNotMatch(result, /untracked=/);
  });

  it("renders model with variant suffix when present", () => {
    const chain = { chainId: "chain-variant" };
    const rounds = [
      {
        round: 1,
        modelEntry: "opencode-go/deepseek-v4-flash:max",
        verdict: "approve",
        disposition: { disposition: "accept" },
        resumeMethod: { type: "continue_session" },
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.match(result, /model: opencode-go\/deepseek-v4-flash:max/);
  });

  it("does not throw when rounds is null", () => {
    const chain = { chainId: "chain-nullrounds" };
    const result = renderChainShow(chain, null);
    assert.match(result, /chain: chain-nullrounds/);
    assert.match(result, /status: incomplete/);
  });

  it("does not throw when rounds is undefined", () => {
    const chain = { chainId: "chain-undefinedrounds" };
    const result = renderChainShow(chain, undefined);
    assert.match(result, /chain: chain-undefinedrounds/);
    assert.match(result, /status: incomplete/);
  });

  it("renders follow-up issue draft when present on chain", () => {
    const chain = {
      chainId: "chain-followup",
      followupIssueDraft: "## Follow-up issue draft (not posted — orchestrator judgement required)\n\n### Completed scope\n\n- Chain: chain-followup\n- Brief: fix thing\n\n### Remaining findings\n\n- [low] Minor style (src/foo.js:10)\n\nThese findings were deferred by the accept-with-followup economic cutoff.",
    };
    const rounds = [
      {
        round: 1,
        verdict: "needs-attention",
        disposition: { disposition: "accept-with-followup", reason: "probes green; remaining findings all minor" },
        resumeMethod: { type: "continue_session" },
        findingsText: "[low] Minor style (src/foo.js:10)",
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.match(result, /status: accepted-with-followup/);
    assert.match(result, /Follow-up issue draft:/);
    assert.ok(result.includes("[low] Minor style (src/foo.js:10)"));
    assert.ok(result.includes("Follow-up issue draft (not posted"));
    assert.ok(result.includes("orchestrator judgement required"));
  });

  it("renders accept-with-followup status when disposition is accept-with-followup", () => {
    const chain = { chainId: "chain-awf" };
    const rounds = [
      {
        round: 1,
        verdict: "needs-attention",
        disposition: { disposition: "accept-with-followup", reason: "probes green; remaining findings all minor" },
        resumeMethod: { type: "continue_session" },
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.match(result, /status: accepted-with-followup at round 1/);
  });

  it("renders strategist usage and recommendation verbatim", () => {
    const chain = { chainId: "chain-strategist" };
    const rounds = [
      {
        round: 1,
        verdict: "needs-attention",
        disposition: { disposition: "strategize", reason: "same file area flagged twice; structural re-diagnosis before next rework" },
        resumeMethod: { type: "continue_session" },
        strategistUsage: { available: true, input: 150, output: 80, cost: 0.001, model: "opencode-go/deepseek-v4-flash" },
        strategistRecommendation: "Switch from grep-based approach to AST-based matching to avoid false positives.",
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.match(result, /strategist: 150 in \/ 80 out.*cost=\$0\.001.*model=opencode-go\/deepseek-v4-flash/);
    assert.ok(result.includes("strategist recommendation:"));
    assert.ok(result.includes("Switch from grep-based approach to AST-based matching to avoid false positives."));
  });

  it("skips strategist section when no strategist data on round", () => {
    const chain = { chainId: "chain-no-strategist" };
    const rounds = [
      {
        round: 1,
        verdict: "approve",
        disposition: { disposition: "accept" },
        resumeMethod: { type: "continue_session" },
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.doesNotMatch(result, /strategist:/);
    assert.doesNotMatch(result, /strategist recommendation:/);
  });

  it("surfaces unadjudicated review record count in renderChainShow when unfilledCount > 0", () => {
    const chain = { chainId: "chain-unadjudicated" };
    const rounds = [{ round: 1, verdict: "approve", disposition: { disposition: "accept" } }];
    const result = renderChainShow(chain, rounds, [], null, { unfilledCount: 3 });
    assert.match(result, /unadjudicated review records: 3/);
  });

  it("omits unadjudicated review record line in renderChainShow when unfilledCount is 0", () => {
    const chain = { chainId: "chain-clean" };
    const rounds = [{ round: 1, verdict: "approve", disposition: { disposition: "accept" } }];
    const result = renderChainShow(chain, rounds, [], null, { unfilledCount: 0 });
    assert.doesNotMatch(result, /unadjudicated review records/);
  });

  it("omits unadjudicated review record line and is pure without opts (no I/O)", () => {
    const chain = { chainId: "chain-no-opts" };
    const rounds = [{ round: 1, verdict: "approve", disposition: { disposition: "accept" } }];
    const withNoOpts = renderChainShow(chain, rounds);
    const withEmptyOpts = renderChainShow(chain, rounds, [], null, {});
    assert.equal(withNoOpts, withEmptyOpts);
    assert.doesNotMatch(withNoOpts, /unadjudicated review records/);
  });

  // AC4: an unparseable review must be distinguishable from a genuine
  // needs-attention in the chain-show rendering, not only on the round record.
  it("marks an unparseable review distinctly in the rendered verdict line", () => {
    const chain = { chainId: "chain-unparseable" };
    const rounds = [
      {
        round: 1,
        verdict: "needs-attention",
        reviewParseable: false,
        disposition: { disposition: "rework", reason: "review output could not be parsed" },
        resumeMethod: { type: "continue_session" },
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.match(result, /verdict: needs-attention \(unparseable\)/);
  });

  it("does not mark a parseable needs-attention review as unparseable", () => {
    const chain = { chainId: "chain-parseable" };
    const rounds = [
      {
        round: 1,
        verdict: "needs-attention",
        reviewParseable: true,
        disposition: { disposition: "rework" },
        resumeMethod: { type: "continue_session" },
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.doesNotMatch(result, /\(unparseable\)/);
  });

  // kusabi #153: a clamped escalation must display the clamp reason instead
  // of an out-of-range "0 → 1" that the orchestrator misreads as a
  // stronger-model re-run.
  it("renders a single-tier clamped escalation with the clamp note", () => {
    const chain = { chainId: "chain-clamped" };
    const rounds = [
      {
        round: 1,
        verdict: "needs-attention",
        disposition: { disposition: "rework" },
        resumeMethod: { type: "continue_session" },
        tierBefore: 0,
        tierAfter: 0,
        tierClamped: true,
        tierClampReason: "single-tier chain",
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.ok(result.includes("tier: 0 (escalation clamped: single-tier chain)"));
  });

  it("renders a top-tier clamp note on a multi-tier chain", () => {
    const chain = { chainId: "chain-clamped2" };
    const rounds = [
      {
        round: 1,
        verdict: "needs-attention",
        disposition: { disposition: "rework" },
        resumeMethod: { type: "continue_session" },
        tierBefore: 1,
        tierAfter: 1,
        tierClamped: true,
        tierClampReason: "escalation beyond top tier (modelChain has 2 tiers)",
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.ok(result.includes("tier: 1 (escalation clamped: escalation beyond top tier (modelChain has 2 tiers))"));
  });

  it("renders a normal tier line without any clamp note", () => {
    const chain = { chainId: "chain-noclamp" };
    const rounds = [
      {
        round: 1,
        verdict: "needs-attention",
        disposition: { disposition: "rework" },
        resumeMethod: { type: "continue_session" },
        tierBefore: 0,
        tierAfter: 0,
        tierClamped: false,
        tierClampReason: null,
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.ok(result.includes("tier: 0"));
    assert.doesNotMatch(result, /escalation clamped/);
  });

  it("still renders tierBefore → tierAfter arrow when escalation is within range", () => {
    const chain = { chainId: "chain-inrange" };
    const rounds = [
      {
        round: 1,
        verdict: "needs-attention",
        disposition: { disposition: "rework" },
        resumeMethod: { type: "continue_session" },
        tierBefore: 0,
        tierAfter: 1,
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.ok(result.includes("tier: 0 → 1"));
    assert.doesNotMatch(result, /escalation clamped/);
  });

  // kusabi #333: a deliberately narrowed rework round must say so in the
  // digest — the round record stores only the scope NAME, and only a
  // narrowed scope is worth printing ("full" and absent both stay silent).
  it("states a mechanical rework scope next to the strategy line", () => {
    const chain = { chainId: "chain-scope-mechanical" };
    const rounds = [
      {
        round: 2,
        verdict: "approve",
        disposition: { disposition: "accept" },
        resumeMethod: { type: "continue_session" },
        reworkStrategyReason: "Fix only the mechanical findings",
        reworkScope: "mechanical",
        reworkCount: 1,
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.match(result, /rework strategy: Fix only the mechanical findings/);
    assert.match(result, /rework scope: mechanical/);
  });

  it("states a design rework scope next to the strategy line", () => {
    const chain = { chainId: "chain-scope-design" };
    const rounds = [
      {
        round: 3,
        verdict: "approve",
        disposition: { disposition: "accept" },
        resumeMethod: { type: "continue_session" },
        reworkStrategyReason: "Design-level findings only",
        reworkScope: "design",
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.match(result, /rework strategy: Design-level findings only/);
    assert.match(result, /rework scope: design/);
  });

  it("prints no scope line when the recorded scope is full", () => {
    const chain = { chainId: "chain-scope-full" };
    const rounds = [
      {
        round: 1,
        verdict: "approve",
        disposition: { disposition: "accept" },
        resumeMethod: { type: "continue_session" },
        reworkScope: "full",
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.doesNotMatch(result, /rework scope/);
  });

  it("prints no scope line and does not throw when the record predates the scope field", () => {
    const chain = { chainId: "chain-scope-legacy" };
    const rounds = [
      {
        round: 1,
        verdict: "approve",
        disposition: { disposition: "accept" },
        resumeMethod: { type: "continue_session" },
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.doesNotMatch(result, /rework scope/);
    assert.match(result, /Round 1/);
  });

  it("keeps scope adjacent to strategy without disturbing the neighbouring lines", () => {
    const chain = { chainId: "chain-scope-order" };
    const rounds = [
      {
        round: 2,
        verdict: "needs-attention",
        disposition: { disposition: "rework" },
        resumeMethod: { type: "continue_session" },
        tierBefore: 0,
        tierAfter: 1,
        reworkStrategyReason: "Fix only the mechanical findings",
        reworkScope: "mechanical",
        reworkCount: 2,
        probeResults: [{ probe: "P1: HEAD clean", passed: true, detail: "HEAD matches base" }],
      },
    ];
    const result = renderChainShow(chain, rounds);
    const expectedOrder = [
      "tier: 0 → 1",
      "rework strategy: Fix only the mechanical findings",
      "rework scope: mechanical",
      "rework count: 2",
      "resume: continue_session",
      "P1: HEAD clean — PASS",
    ];
    let prev = -1;
    for (const line of expectedOrder) {
      const idx = result.indexOf(line);
      assert.ok(idx > prev, `expected line in order, got ${line} at ${idx}`);
      prev = idx;
    }
  });
});

// kusabi #336: an escalated terminal chain shows the structured-finding
// decision block (the same renderer renderEscalateOutcome uses), while the
// per-round one-line findingsText stays as it is.
describe("renderChainShow escalated decision block", () => {
  it("renders the structured decision block for an escalated terminal round", () => {
    const chain = { chainId: "chain-esc-decisions" };
    const rounds = [
      {
        round: 1,
        verdict: "needs-attention",
        disposition: { disposition: "escalate", reason: "oracle violation" },
        resumeMethod: { type: "continue_session" },
        findingsText: "[critical] data loss (src/y.js:9)\n[medium] minor (src/x.js:5)",
        findings: [
          { severity: "medium", title: "minor", file: "src/x.js", line_start: 5, body: "MINOR-BODY", recommendation: "MINOR-REC" },
          { severity: "critical", title: "data loss", file: "src/y.js", line_start: 9, body: "CRIT-BODY-336", recommendation: "CRIT-REC-336" },
        ],
      },
    ];
    const result = renderChainShow(chain, rounds);
    // The per-round one-line list is still shown.
    assert.match(result, /findings:/);
    assert.ok(result.includes("[critical] data loss (src/y.js:9)"));
    // The structured decision block is appended, framed as answers.
    assert.ok(result.includes("Escalation decisions (structured findings):"));
    assert.ok(result.includes("Decisions for the orchestrator (answer each; a one-line answer per item is enough"));
    // Severity ordering: critical before medium.
    assert.ok(result.indexOf("CRIT-BODY-336") < result.indexOf("MINOR-BODY"));
    // Recommendation survives.
    assert.ok(result.includes("CRIT-REC-336"));
    // The truncation note wording (host-side, retrievable) is exercised.
    assert.doesNotMatch(result, /not retrievable/);
  });

  it("does not render the decision block for an escalated round without structured findings", () => {
    const chain = { chainId: "chain-esc-legacy" };
    const rounds = [
      {
        round: 1,
        verdict: "discard",
        disposition: { disposition: "escalate", reason: "reviewer discarded the work" },
        resumeMethod: { type: "continue_session" },
        findingsText: "[high] something (src/a.js:1)",
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.doesNotMatch(result, /Escalation decisions/);
    assert.doesNotMatch(result, /Decisions for the orchestrator/);
    assert.ok(result.includes("[high] something (src/a.js:1)"));
  });

  it("states plainly when an escalated terminal round has no findings and no findingsText", () => {
    const chain = { chainId: "chain-esc-none" };
    const rounds = [
      {
        round: 1,
        verdict: "discard",
        disposition: { disposition: "escalate", reason: "reviewer discarded the work" },
        resumeMethod: { type: "continue_session" },
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.ok(result.includes("Escalation decisions (structured findings):"));
    assert.ok(result.includes("(no findings recorded for this round)"));
    assert.doesNotMatch(result, /Decisions for the orchestrator/);
  });
});

// renderJobLine — stats display (acceptance criterion 4)
// ---------------------------------------------------------------------------

describe("renderJobLine", () => {
  const baseJob = {
    id: "job-abc",
    kind: "task",
    title: "Implement the feature",
    status: "completed",
    startedAt: "2026-07-22T10:00:00.000Z",
    finishedAt: "2026-07-22T10:00:05.000Z",
  };

  it("includes orch=<model> when job has orchestrator with model (criterion 4)", () => {
    const job = {
      ...baseJob,
      orchestrator: { model: "claude-fable-5", session: "dfbdc7dc", date: "2026-07-22" },
    };
    const line = renderJobLine(job);
    assert.match(line, /orch=claude-fable-5/);
  });

  it("does not include orchestrator when job has no orchestrator field", () => {
    const line = renderJobLine(baseJob);
    assert.doesNotMatch(line, /orch=/);
  });

  it("does not include orchestrator when orchestrator is null", () => {
    const job = { ...baseJob, orchestrator: null };
    const line = renderJobLine(job);
    assert.doesNotMatch(line, /orch=/);
  });

  it("does not include orchestrator when orchestrator.model is null", () => {
    const job = { ...baseJob, orchestrator: { model: null, session: null, date: null } };
    const line = renderJobLine(job);
    assert.doesNotMatch(line, /orch=/);
  });

  it("renders the full line format correctly with orchestrator", () => {
    const job = {
      ...baseJob,
      orchestrator: { model: "deepseek-v4", session: "xyz", date: "2026-12-31" },
    };
    const line = renderJobLine(job);
    assert.match(line, /^job-abc\s+task\s+completed\s+5s\s+orch=deepseek-v4\s+Implement the feature$/);
  });
});

// renderBaseFacts — base change-set context block for chain review prompts
// ---------------------------------------------------------------------------

describe("renderBaseFacts", () => {
  it("renders all four elements when all inputs are provided", () => {
    const result = renderBaseFacts({
      baseSha: "basesha-dummy-0001",
      baseLog: "abc123 first commit\ndef456 second commit",
      statusOutput: " M src/foo.js\n?? newfile.js",
    });
    assert.match(result, /### Base change-set context/);
    assert.match(result, /Base commit: `basesha-dummy-0001`/);
    assert.match(result, /Recent base history/);
    assert.match(result, /abc123 first commit/);
    assert.match(result, /def456 second commit/);
    assert.match(result, /Actual change set/);
    assert.match(result, /src\/foo\.js/);
    assert.match(result, /newfile\.js/);
    assert.match(result, /Review ONLY this change set/);
    assert.match(result, /NOT scope creep/);
  });

  it("includes the verbatim boundary instruction sentence", () => {
    const result = renderBaseFacts({
      baseSha: "abc",
      baseLog: "abc log",
      statusOutput: "",
    });
    assert.ok(result.includes("Review ONLY this change set. Code that is already part of the base (see the log above) is NOT scope creep and must not be flagged as such."));
  });

  it("handles missing baseSha gracefully", () => {
    const result = renderBaseFacts({
      baseLog: "abc log",
      statusOutput: " M f.txt",
    });
    assert.match(result, /Base commit: \(unavailable\)/);
    assert.match(result, /abc log/);
    assert.match(result, /f\.txt/);
  });

  it("handles missing baseLog gracefully", () => {
    const result = renderBaseFacts({
      baseSha: "abc",
      statusOutput: " M f.txt",
    });
    assert.match(result, /Base commit: `abc`/);
    assert.match(result, /\(unavailable\)/);
    assert.match(result, /f\.txt/);
  });

  it("handles missing statusOutput gracefully", () => {
    const result = renderBaseFacts({
      baseSha: "abc",
      baseLog: "abc log",
    });
    assert.match(result, /Base commit: `abc`/);
    assert.match(result, /abc log/);
    assert.match(result, /empty change set/);
  });

  it("handles empty input object gracefully", () => {
    const result = renderBaseFacts({});
    assert.match(result, /Base commit: \(unavailable\)/);
    assert.match(result, /\(unavailable\)/);
    assert.match(result, /empty change set/);
    assert.match(result, /Review ONLY this change set/);
  });

  it("handles no argument gracefully", () => {
    const result = renderBaseFacts();
    assert.match(result, /Base commit: \(unavailable\)/);
    assert.match(result, /empty change set/);
    assert.match(result, /Review ONLY this change set/);
  });
});

// renderStrategistPrompt — Decision 4 strategist prompt builder
// ---------------------------------------------------------------------------

describe("renderStrategistPrompt", () => {
  const sampleBrief = "Implement feature X\n\nAcceptance criteria:\n- Works on all platforms\n- Performance within limits";

  it("includes acceptance criteria verbatim", () => {
    const result = renderStrategistPrompt({
      brief: sampleBrief,
      rounds: [
        { round: 1, findingsText: "[low] Style issue (src/a.js:10)" },
        { round: 2, findingsText: "[low] Same style issue (src/a.js:10)" },
      ],
    });
    assert.ok(result.includes("Implement feature X"));
    assert.ok(result.includes("Works on all platforms"));
  });

  it("includes both rounds' findings verbatim", () => {
    const result = renderStrategistPrompt({
      brief: sampleBrief,
      rounds: [
        { round: 1, findingsText: "[low] Style issue (src/a.js:10)" },
        { round: 2, findingsText: "[low] Same style issue (src/a.js:10)" },
      ],
    });
    assert.ok(result.includes("Findings from round 1"));
    assert.ok(result.includes("Findings from round 2"));
    assert.ok(result.includes("[low] Style issue (src/a.js:10)"));
    assert.ok(result.includes("[low] Same style issue (src/a.js:10)"));
  });

  it("contains the one-structural-change instruction", () => {
    const result = renderStrategistPrompt({
      brief: sampleBrief,
      rounds: [
        { round: 1, findingsText: "finding" },
        { round: 2, findingsText: "finding" },
      ],
    });
    assert.ok(result.includes("Recommend exactly ONE structural change"));
    assert.ok(result.includes("keep WHAT (the acceptance criteria) fixed, change HOW"));
    assert.ok(result.includes("you cannot post to issues in this mode"));
  });

  it("handles missing brief gracefully", () => {
    const result = renderStrategistPrompt({
      rounds: [{ round: 1, findingsText: "finding" }],
    });
    assert.ok(result.includes("Acceptance criteria"));
    assert.ok(result.includes("(not provided)"));
  });

  it("handles missing rounds gracefully (never throws)", () => {
    const result = renderStrategistPrompt({ brief: "test" });
    assert.ok(result.includes("Acceptance criteria"));
    assert.ok(result.includes("test"));
  });

  it("handles no arguments gracefully (never throws)", () => {
    const result = renderStrategistPrompt();
    assert.ok(result.includes("Acceptance criteria"));
  });
});


// renderHeader — provider-error and fallback rendering
// =========================================================================

describe("renderHeader provider-error", () => {
  it("shows route and variant when modelEntry is set", () => {
    const job = {
      id: "job-1",
      kind: "task",
      status: "completed",
      sessionID: "ses_1",
      startedAt: "2026-07-22T10:00:00.000Z",
      finishedAt: "2026-07-22T10:01:00.000Z",
      modelEntry: "opencode-go/deepseek-v4-flash:max",
    };
    const result = renderHeader(job);
    assert.match(result, /route: opencode-go\/deepseek-v4-flash:max/);
  });

  it("shows provider-error details with retry info", () => {
    const job = {
      id: "job-pe",
      kind: "task",
      status: "provider-error",
      sessionID: "ses_pe",
      startedAt: "2026-07-22T10:00:00.000Z",
      finishedAt: "2026-07-22T10:00:05.000Z",
      error: "provider error: free_tier_limit (attempt 1) [terminal]: Free usage exceeded",
      retry: { reason: "free_tier_limit", attempt: 1, terminal: true, message: "Free usage exceeded", count: 1 },
    };
    const result = renderHeader(job);
    assert.match(result, /provider-error:/);
    assert.match(result, /reason: free_tier_limit/);
    assert.match(result, /attempt: 1/);
    assert.match(result, /terminal: true/);
    assert.match(result, /provider message: Free usage exceeded/);
  });

  it("shows provider-error without terminal when not terminal", () => {
    const job = {
      id: "job-pe2",
      kind: "task",
      status: "provider-error",
      sessionID: "ses_pe2",
      startedAt: "2026-07-22T10:00:00.000Z",
      finishedAt: "2026-07-22T10:00:05.000Z",
      error: "provider error: rate_limit (attempt 3): Too many requests",
      retry: { reason: "rate_limit", attempt: 3, terminal: false, message: "Too many requests", count: 3 },
    };
    const result = renderHeader(job);
    assert.match(result, /provider-error:/);
    assert.match(result, /reason: rate_limit/);
    assert.match(result, /attempt: 3/);
    assert.doesNotMatch(result, /terminal: true/);
  });

  it("shows fallbacks when job has fallback trail", () => {
    const job = {
      id: "job-fb",
      kind: "task",
      status: "completed",
      sessionID: "ses_fb",
      startedAt: "2026-07-22T10:00:00.000Z",
      finishedAt: "2026-07-22T10:01:00.000Z",
      modelEntry: "opencode-go/deepseek-v4-flash:max",
      fallbacks: [
        { from: "opencode/deepseek-v4-flash-free:max", to: "opencode-go/deepseek-v4-flash:max", reason: "free_tier_limit", attempt: 1, message: "Free usage exceeded" },
      ],
    };
    const result = renderHeader(job);
    assert.match(result, /fallback:/);
    assert.match(result, /opencode\/deepseek-v4-flash-free:max → opencode-go\/deepseek-v4-flash:max/);
    assert.match(result, /free_tier_limit/);
  });

  it("shows multiple fallbacks in order", () => {
    const job = {
      id: "job-mfb",
      kind: "task",
      status: "completed",
      sessionID: "ses_mfb",
      startedAt: "2026-07-22T10:00:00.000Z",
      finishedAt: "2026-07-22T10:02:00.000Z",
      modelEntry: "opencode-go/deepseek-v4-pro:max",
      fallbacks: [
        { from: "opencode/deepseek-v4-flash-free:max", to: "opencode-go/deepseek-v4-flash:max", reason: "free_tier_limit", attempt: 1, message: "Free usage exceeded" },
        { from: "opencode-go/deepseek-v4-flash:max", to: "opencode-go/deepseek-v4-pro:max", reason: "rate_limit", attempt: 3, message: "Too many requests" },
      ],
    };
    const result = renderHeader(job);
    // First fallback
    assert.ok(result.includes("opencode/deepseek-v4-flash-free:max → opencode-go/deepseek-v4-flash:max"));
    // Second fallback
    assert.ok(result.includes("opencode-go/deepseek-v4-flash:max → opencode-go/deepseek-v4-pro:max"));
  });

  it("falls back to model line from stats when modelEntry is absent", () => {
    const job = {
      id: "job-nome",
      kind: "task",
      status: "completed",
      sessionID: "ses_nome",
      startedAt: "2026-07-22T10:00:00.000Z",
      finishedAt: "2026-07-22T10:00:05.000Z",
      stats: { models: ["opencode/deepseek-v4-flash-free"] },
    };
    const result = renderHeader(job);
    assert.match(result, /model: opencode\/deepseek-v4-flash-free/);
  });
});

// renderChainShow — fallback display on round records
// =========================================================================

describe("renderChainShow fallbacks", () => {
  it("renders fallback lines on a round record", () => {
    const chain = { chainId: "chain-fb" };
    const rounds = [
      {
        round: 1,
        modelEntry: "opencode-go/deepseek-v4-flash:max",
        verdict: "approve",
        disposition: { disposition: "accept" },
        resumeMethod: { type: "continue_session" },
        fallbacks: [
          { from: "opencode/deepseek-v4-flash-free:max", to: "opencode-go/deepseek-v4-flash:max", reason: "free_tier_limit", attempt: 1, message: "Free usage exceeded" },
        ],
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.match(result, /fallbacks:/);
    assert.match(result, /opencode\/deepseek-v4-flash-free:max → opencode-go\/deepseek-v4-flash:max/);
    assert.match(result, /free_tier_limit at attempt 1/);
    assert.match(result, /Free usage exceeded/);
  });

  it("does not show fallbacks when none occurred", () => {
    const chain = { chainId: "chain-no-fb" };
    const rounds = [
      {
        round: 1,
        modelEntry: "p/a",
        verdict: "approve",
        disposition: { disposition: "accept" },
        resumeMethod: { type: "continue_session" },
      },
    ];
    const result = renderChainShow(chain, rounds);
    assert.doesNotMatch(result, /fallbacks:/);
  });
});

// renderBaseFacts diff instruction — the diff body is NOT inlined (kusabi #208)
// ---------------------------------------------------------------------------
// The block used to inline a `git diff` capture.  That capture was a single
// default-paged sandbox_exec call, so what the reviewer received was page one
// of the diff presented as the whole change.  These tests replace the ones
// that pinned the inlined body: what must hold now is that there is no body at
// all, and that the input names the ref to diff against and says whose job the
// fetch is.

describe("renderBaseFacts diff instruction", () => {
  it("carries no diff body at all", () => {
    const result = renderBaseFacts({
      baseSha: "abc",
      baseLog: "log",
      statusOutput: " M src/foo.js",
      untrackedFiles: "src/new.js",
    });
    assert.doesNotMatch(result, /diff --git/);
    assert.doesNotMatch(result, /```diff/);
    assert.doesNotMatch(result, /Diff content/);
  });

  it("names the base sha and the tool, and says the fetch is the reviewer's job", () => {
    const result = renderBaseFacts({ baseSha: "0123456789abcdef", statusOutput: " M src/foo.js" });
    assert.ok(result.includes("Fetching the diff is YOUR job"));
    assert.ok(result.includes("`diff_in_container`"));
    assert.ok(result.includes("`base` set to `0123456789abcdef`"));
  });

  it("says in as many words that the file list is not the change", () => {
    const result = renderBaseFacts({ baseSha: "abc", statusOutput: " M src/foo.js" });
    assert.ok(result.includes("**The diff itself is NOT included in this input.**"));
    assert.ok(result.includes("names WHICH files changed, not WHAT changed inside them"));
  });

  it("falls back to the worktree diff when the base commit could not be read", () => {
    const result = renderBaseFacts({ statusOutput: " M src/foo.js" });
    assert.ok(result.includes("Fetching the diff is YOUR job"));
    assert.ok(result.includes("`worktree: true`"));
    assert.doesNotMatch(result, /`base` set to/);
  });

  it("tells the reviewer to page until has_more is false", () => {
    // The defect this replaces was a first page taken for the whole thing; an
    // instruction that stopped at "call diff_in_container" would invite it
    // back one level down.
    const result = renderBaseFacts({ baseSha: "abc" });
    assert.ok(result.includes("`has_more` is false"));
  });
});

// renderBaseFacts truncation labels — what was cut says so (kusabi #208)
// ---------------------------------------------------------------------------
// Truncation is taken from what sandbox_exec reports about its own paging, not
// inferred from a line count: page one of a 137-line change set and a genuine
// 50-line one are indistinguishable by length.

describe("renderBaseFacts truncation labels", () => {
  const LONG_STATUS = Array.from({ length: 50 }, (_, i) => " M src/f" + i + ".js").join("\n") + "\n";

  it("labels a change-set list the server paged, counting the block it rendered", () => {
    // The numerator is the number of lines in the block above the label, not
    // a count carried in the truncation facts: the server's own `shown`
    // equals `total_lines` even on a cut response, so a carried numerator
    // rendered "showing 137 of 137" under a truncation label.
    const result = renderBaseFacts({
      baseSha: "abc",
      statusOutput: LONG_STATUS,
      truncation: { status: { truncated: true, total: 137 } },
    });
    assert.ok(result.includes("**Change set truncated (showing 50 of 137 lines).**"));
    assert.ok(result.includes("`diff_in_container` reports the complete file list"));
  });

  it("labels a paged change-set list even when the denominator is missing", () => {
    const result = renderBaseFacts({
      baseSha: "abc",
      statusOutput: LONG_STATUS,
      truncation: { status: { truncated: true, total: null } },
    });
    assert.ok(result.includes("**Change set truncated.**"));
  });

  it("drops the counts rather than printing a numerator that is not below the denominator", () => {
    // "showing 50 of 50" under a truncation label is the contradiction this
    // label exists to remove.  A bare "truncated" is honest; matching counts
    // are not, whatever produced them.
    const result = renderBaseFacts({
      baseSha: "abc",
      statusOutput: LONG_STATUS,
      truncation: { status: { truncated: true, total: 50 } },
    });
    assert.ok(result.includes("**Change set truncated.**"));
    assert.doesNotMatch(result, /showing \d+ of \d+ lines/);
  });

  it("labels a paged untracked list", () => {
    const result = renderBaseFacts({
      untrackedFiles: "src/a.js\nsrc/b.js\n",
      truncation: { untracked: { truncated: true, total: 92 } },
    });
    assert.ok(result.includes("**Untracked list truncated (showing 2 of 92 lines).**"));
    assert.ok(result.includes("More untracked files exist than are listed above."));
  });

  it("labels a paged base history", () => {
    const result = renderBaseFacts({
      baseLog: "abc1234 first",
      truncation: { baseLog: { truncated: true, total: 60 } },
    });
    assert.ok(result.includes("**Base history truncated (showing 1 of 60 lines).**"));
  });

  it("never renders a numerator equal to its denominator on any capture", () => {
    // Every capture at once, each cut, each with the live server's numbers
    // (the response reports shown === total_lines).  Whatever is labelled,
    // no label may claim the block holds the whole output.
    const result = renderBaseFacts({
      baseSha: "abc",
      baseLog: "abc1234 first\ndef5678 second\n",
      statusOutput: LONG_STATUS,
      untrackedFiles: "src/a.js\nsrc/b.js\n",
      truncation: {
        baseLog: { truncated: true, total: 60 },
        status: { truncated: true, total: 137 },
        untracked: { truncated: true, total: 92 },
      },
    });
    const counts = [...result.matchAll(/showing (\d+) of (\d+) lines/g)];
    assert.equal(counts.length, 3, "each cut capture must be labelled with counts");
    for (const [text, shown, total] of counts) {
      assert.ok(Number(shown) < Number(total), `numerator must be below the denominator, got ${text}`);
    }
    assert.deepEqual(counts.map((c) => c[1]), ["2", "50", "2"]);
  });

  it("labels nothing when the server says every capture was complete", () => {
    // A full page that was NOT cut must not be labelled: an exactly-50-line
    // change set is a real change set.
    const result = renderBaseFacts({
      baseSha: "abc",
      baseLog: "abc1234 first",
      statusOutput: LONG_STATUS,
      untrackedFiles: "src/new.js\n",
      truncation: {
        baseLog: { truncated: false, total: 1 },
        status: { truncated: false, total: 50 },
        untracked: { truncated: false, total: 1 },
      },
    });
    assert.doesNotMatch(result, /truncated/);
  });

  it("labels nothing when no truncation facts are supplied at all", () => {
    const result = renderBaseFacts({ baseSha: "abc", statusOutput: " M src/foo.js", untrackedFiles: "src/new.js" });
    assert.doesNotMatch(result, /truncated/);
  });

  it("still applies the character budget, in its existing vocabulary", () => {
    // DIFF_BUDGET is 30000; the budget and its phrasing outlive the diff body
    // they were introduced for.
    const huge = "?? src/generated/f.js\n".repeat(2000);
    const result = renderBaseFacts({ statusOutput: huge });
    assert.ok(result.includes("Actual change set (`git status --porcelain`) (truncated to 30000 characters):"));
    assert.ok(result.includes("**Change set truncated.**"));
  });

  it("applies the character budget to the untracked list too", () => {
    const huge = Array.from({ length: 3000 }, (_, i) => "src/generated/f" + i + ".js").join("\n") + "\n";
    const result = renderBaseFacts({ untrackedFiles: huge });
    assert.ok(result.includes("New (untracked) files (truncated to 30000 characters):"));
    assert.ok(result.includes("**Untracked list truncated.**"));
  });
});

// renderBaseFacts untracked files — new file representation
// ---------------------------------------------------------------------------

describe("renderBaseFacts untracked files", () => {
  it("renders untracked files list when untrackedFiles is supplied", () => {
    const result = renderBaseFacts({
      untrackedFiles: "newfile.js\nanother/new.ts",
    });
    assert.match(result, /New \(untracked\) files:/);
    assert.match(result, /`newfile\.js`/);
    assert.match(result, /`another\/new\.ts`/);
    assert.match(result, /read_file_range/);
  });

  it("omits untracked section when untrackedFiles is absent", () => {
    const result = renderBaseFacts({});
    assert.doesNotMatch(result, /New \(untracked\) files:/);
  });

  it("omits untracked section when untrackedFiles is empty string", () => {
    const result = renderBaseFacts({
      untrackedFiles: "",
    });
    assert.doesNotMatch(result, /New \(untracked\) files:/);
  });

  it("omits untracked section when untrackedFiles is only whitespace", () => {
    const result = renderBaseFacts({
      untrackedFiles: "   \n  \n",
    });
    assert.doesNotMatch(result, /New \(untracked\) files:/);
  });

  it("works together with the rest of the base facts", () => {
    const result = renderBaseFacts({
      baseSha: "abc",
      baseLog: "log",
      statusOutput: " M src/foo.js\n?? newfile.ts",
      untrackedFiles: "newfile.ts",
    });
    assert.match(result, /Base commit: `abc`/);
    assert.match(result, /Actual change set/);
    assert.match(result, /Fetching the diff is YOUR job/);
    assert.match(result, /New \(untracked\) files:/);
    assert.match(result, /`newfile\.ts`/);
    assert.match(result, /read_file_range/);
  });
});

// renderChainShow — control record parameter (chain lifecycle stop lever)
// ---------------------------------------------------------------------------

describe("renderChainShow with control record", () => {
  const minimalChain = { chainId: "chain-ctrltest", brief: "test" };
  const emptyRounds = [];

  it("status is 'running' when control says running and pid is alive", () => {
    const control = { chainId: "chain-ctrltest", status: "running", pid: process.pid, round: 2 };
    const result = renderChainShow(minimalChain, emptyRounds, [], control);
    assert.match(result, /status: running/);
  });

  it("status is 'completed' when control says completed", () => {
    const control = { chainId: "chain-ctrltest", status: "completed", pid: 0, round: 3, finishedAt: new Date().toISOString() };
    const result = renderChainShow(minimalChain, emptyRounds, [], control);
    assert.match(result, /status: completed/);
  });

  it("a completed control record still reports the disposition and round", () => {
    // "completed" says the process ended, not how it ended.  The reader needs
    // the disposition, which is what chain-show printed before control records
    // existed; losing it to a bare "completed" would be a regression.
    const control = { chainId: "chain-ctrltest", status: "completed", pid: 0, round: 2, finishedAt: new Date().toISOString() };
    const rounds = [{ round: 2, disposition: { disposition: "accept" } }];
    const result = renderChainShow(minimalChain, rounds, [], control);
    assert.match(result, /status: accepted at round 2/);
  });

  it("renders a chain stopped before its first round persisted chain.json", () => {
    // chain.json is written at the end of a round, so a chain cancelled during
    // round 1 has none. cmdChainShow synthesises a minimal chain object from the
    // control record; rendering must survive the missing brief/orchestrator.
    const control = { chainId: "chain-early", status: "cancelled", pid: 0, round: 0 };
    const synthesised = { chainId: "chain-early", container: "cid-under-test", brief: null, orchestrator: null };
    const result = renderChainShow(synthesised, [], [], control);
    assert.match(result, /chain: chain-early/);
    assert.match(result, /status: cancelled/);
    assert.match(result, /container: cid-under-test/);
  });

  it("a cancelled control record wins over the round disposition", () => {
    // The lifecycle status is authoritative for every status except
    // "completed": a chain stopped mid-flight must not read as accepted.
    const control = { chainId: "chain-ctrltest", status: "cancelled", pid: 0, round: 2 };
    const rounds = [{ round: 2, disposition: { disposition: "accept" } }];
    const result = renderChainShow(minimalChain, rounds, [], control);
    assert.match(result, /status: cancelled/);
  });

  it("status is 'failed' when control says failed", () => {
    const control = { chainId: "chain-ctrltest", status: "failed", pid: 0, round: 1 };
    const result = renderChainShow(minimalChain, emptyRounds, [], control);
    assert.match(result, /status: failed/);
  });

  it("status is 'cancelled' when control says cancelled", () => {
    const control = { chainId: "chain-ctrltest", status: "cancelled", pid: 0, round: 2, finishedAt: new Date().toISOString() };
    const result = renderChainShow(minimalChain, emptyRounds, [], control);
    assert.match(result, /status: cancelled/);
  });

  it("status is 'stale' when control says running but pid is dead (0)", () => {
    // pid 0 is always dead — effectiveStatus returns "stale"
    const control = { chainId: "chain-ctrltest", status: "running", pid: 0, round: 1 };
    const result = renderChainShow(minimalChain, emptyRounds, [], control);
    assert.match(result, /status: stale/);
  });

  it("status is 'incomplete' when no control record and no rounds", () => {
    const result = renderChainShow(minimalChain, emptyRounds, [], null);
    assert.match(result, /status: incomplete/);
  });

  it("status falls back to round-derived disposition when no control record", () => {
    const rounds = [
      { round: 1, verdict: "approve", disposition: { disposition: "accept" }, resumeMethod: { type: "continue_session" } },
    ];
    const result = renderChainShow(minimalChain, rounds, [], null);
    assert.match(result, /status: accepted at round 1/);
  });
});

// renderReviewRecord — postable review record (kusabi #52)
// ---------------------------------------------------------------------------

describe("renderReviewRecord", () => {
  it("renders a minimal record without throwing and contains the chain id", () => {
    const text = renderReviewRecord({ chainId: "chain-x" });
    assert.equal(typeof text, "string");
    assert.match(text, /chain-x/);
    assert.match(text, /# \[review-record\]/);
    // Both fill-at-inspection sections are always present.
    assert.match(text, /## Findings adjudication \(fill at inspection\)/);
    assert.match(text, /## 判例として \(fill at inspection\)/);
  });

  it("does not throw on null / undefined / empty records", () => {
    for (const record of [null, undefined, {}]) {
      const text = renderReviewRecord(record);
      assert.equal(typeof text, "string");
      assert.match(text, /\(unknown\)/);
    }
  });

  it("skips null / non-object elements inside a round's findings array", () => {
    const text = renderReviewRecord({
      chainId: "chain-x",
      records: [{
        round: 1,
        findings: [null, "stray string", { severity: "low", title: "Real one", file: "src/a.js" }],
      }],
    });
    assert.equal(typeof text, "string");
    assert.match(text, /- \[low\] Real one \(src\/a\.js\)/);
    assert.match(text, /\| 1 \| low \| Real one \(src\/a\.js\) \| _fill_ \| _fill_ \|/);
    // Only the one real finding survives — no row for the malformed elements.
    assert.doesNotMatch(text, /\| 2 \|/);
  });

  it("renders a representative two-round chain record end to end", () => {
    const record = {
      chainId: "chain-abc",
      label: "kusabi",
      brief: "Implement X.\nOrchestrator: claude-fable-5 | session abc123 | 2026-08-08\n## Deliverables\n- src/x.js",
      orchestrator: { model: "claude-fable-5" },
      container: "cid-123",
      modelChain: [["flash/quick"], ["pro/deep"]],
      maxRounds: 4,
      finishedAt: "2026-08-08T12:00:00.000Z",
      records: [
        {
          round: 1,
          modelEntry: "flash/quick",
          verdict: "approve",
          disposition: { disposition: "accept" },
          worktreeChanged: true,
          probeResults: [
            { probe: "P1: HEAD clean", passed: true, detail: "HEAD matches base abc123" },
            { probe: "P2: verify gate", passed: true, detail: JSON.stringify({ gate_passed: true, diff_summary: { changed_files: 1, untracked: 0 } }) },
            { probe: "P3: deliverables", passed: true, detail: "touches declared deliverables" },
            { probe: "P4: smoke", passed: true, detail: "no Smoke declared; check skipped" },
          ],
          findings: [{ severity: "high", title: "Null pointer", file: "src/x.js", line_start: 42 }],
          findingsText: "[high] Null pointer (src/x.js:42)",
        },
        {
          round: 2,
          modelEntry: "flash/quick",
          verdict: "approve-partial",
          verdictSource: "recovered-from-token",
          disposition: { disposition: "escalate", reason: "unverified items remain" },
          worktreeChanged: false,
          probeResults: [],
          findings: [],
          findingsText: "(no structured findings)",
        },
      ],
      chainTotals: { input: 10, output: 8, reasoning: 2, cacheRead: 100, cacheWrite: 5, cost: 0.42 },
      disposition: { disposition: "escalated", round: 2, reason: "unverified items remain" },
    };
    const text = renderReviewRecord(record);

    // Header: label, chain id, truncated brief first line.
    assert.match(text, /# \[review-record\] kusabi chain-abc — Implement X\./);
    assert.match(text, /Orchestrator: claude-fable-5 \| session abc123 \| 2026-08-08 \| finished: 2026-08-08T12:00:00\.000Z/);
    assert.match(text, /Model chain: flash\/quick → pro\/deep \| container: cid-123/);
    assert.match(text, /Final disposition: escalated at round 2 of 4/);

    // Per-round verdict/disposition lines.
    assert.match(text, /Round 1 — model: flash\/quick, verdict: approve \(parsed\), disposition: accept, changed: yes/);
    assert.match(text, /Round 2 — model: flash\/quick, verdict: approve-partial \(recovered-from-token\), disposition: escalate, changed: no/);

    // Probe one-liners.
    assert.match(text, /P1: HEAD clean — PASS \(HEAD matches base abc123\)/);
    assert.match(text, /P2: verify gate — PASS \(gate_passed=true, changed=1, untracked=0\)/);
    assert.match(text, /P3: deliverables — PASS \(touches declared deliverables\)/);
    assert.match(text, /P4: smoke — PASS \(no Smoke declared; check skipped\)/);

    // Per-round findings bullets.
    assert.match(text, /- \[high\] Null pointer \(src\/x\.js:42\)/);

    // Findings adjudication table: one row per finding, 採否/理由 unfilled.
    assert.match(text, /## Findings adjudication \(fill at inspection\)/);
    assert.match(text, /\| # \| severity \| finding \| 採否 \| 理由 \|/);
    assert.match(text, /\| 1 \| high \| Null pointer \(src\/x\.js:42\) \| _fill_ \| _fill_ \|/);

    // Precedent section.
    assert.match(text, /## 判例として \(fill at inspection\)/);
    assert.match(text, /_fill: reusable precedent, if any_/);

    // Usage totals from chainTotals.
    assert.match(text, /input=10 output=8 reasoning=2 cacheRead=100 cacheWrite=5 cost=\$0\.42/);
  });

  it("zero-findings chains get both fill-at-inspection sections with an explicit no-findings statement", () => {
    const text = renderReviewRecord({
      chainId: "chain-zero",
      brief: "Do the thing.",
      container: "cid-0",
      maxRounds: 1,
      records: [
        {
          round: 1,
          modelEntry: "flash/quick",
          verdict: "approve",
          disposition: { disposition: "accept" },
          worktreeChanged: false,
          probeResults: [],
          findings: [],
          findingsText: "(no structured findings)",
        },
      ],
      chainTotals: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      disposition: { disposition: "accepted", round: 1 },
    });
    assert.match(text, /## Findings adjudication \(fill at inspection\)/);
    assert.match(text, /_No findings were produced by this chain — nothing to adjudicate\._/);
    // No table rows when there are no findings.
    assert.doesNotMatch(text, /\| 1 \|/);
    assert.match(text, /## 判例として \(fill at inspection\)/);
    assert.match(text, /_fill: reusable precedent, if any_/);
    assert.match(text, /input=1 output=1 reasoning=0 cacheRead=0 cacheWrite=0 cost=\$0/);
  });

  it("falls back to findingsText bullets when structured findings are absent", () => {
    const text = renderReviewRecord({
      chainId: "chain-old",
      records: [
        {
          round: 1,
          modelEntry: "flash/quick",
          verdict: "needs-attention",
          disposition: { disposition: "escalate" },
          worktreeChanged: null,
          findingsText: "[medium] Slow path (src/a.js:3)\n[low] Style nit (src/b.js:9)",
        },
      ],
      chainTotals: {},
      disposition: { disposition: "escalated", round: 1 },
    });
    assert.match(text, /- \[medium\] Slow path \(src\/a\.js:3\)/);
    assert.match(text, /\| 1 \| medium \| Slow path \(src\/a\.js:3\) \| _fill_ \| _fill_ \|/);
    assert.match(text, /\| 2 \| low \| Style nit \(src\/b\.js:9\) \| _fill_ \| _fill_ \|/);
    // changed: unknown when worktreeChanged is null
    assert.match(text, /changed: unknown/);
  });

  it("renders rounds without probe or findings data gracefully", () => {
    const text = renderReviewRecord({
      chainId: "chain-bare",
      records: [{ round: 3 }],
      disposition: { disposition: "accepted", round: 3 },
    });
    assert.match(text, /Round 3 — model: \?, verdict: \? \(parsed\), disposition: \?, changed: unknown/);
    assert.match(text, /_No findings were produced by this chain — nothing to adjudicate\._/);
  });

  it("marks record as provisional in header when provisional flag is set", () => {
    const text = renderReviewRecord({
      chainId: "chain-prov",
      provisional: true,
      records: [{ round: 1, probeResults: [{ probe: "P1: HEAD clean", passed: true }] }],
      disposition: { disposition: "failed", round: 1 },
    });
    assert.match(text, /Note: PROVISIONAL RECORD — chain did not reach a disposition and may be superseded by chain-resume\./);
    assert.match(text, /Final disposition: failed at round 1 of \?/);
  });

  it("renders zero-findings dead review record with the alternative marker and a fill placeholder row counted by countUnfilledReviewRecords", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-scan-"));
    try {
      const recordData = {
        chainId: "chain-dead",
        records: [
          {
            round: 1,
            verdict: "unparseable",
            reviewParseable: false,
            verdictSource: "recovered-from-token",
            probeResults: [{ probe: "P1: HEAD clean", passed: true }],
            findings: [],
          },
        ],
        disposition: { disposition: "failed", round: 1 },
      };
      const text = renderReviewRecord(recordData);
      assert.match(text, /_No review verdict was delivered for this chain — implementation remains unadjudicated\._/);
      assert.match(text, /\| 1 \| unknown \| _No review verdict delivered — unadjudicated implementation_ \| _fill_ \| _fill_ \|/);

      const chainDir = path.join(tmpDir, "ws", "chains", "chain-dead");
      fs.mkdirSync(chainDir, { recursive: true });
      fs.writeFileSync(path.join(chainDir, "review-record.md"), text, "utf8");

      assert.equal(countUnfilledReviewRecords(tmpDir), 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("renders post-probe cancelled record (missing verdict) with alternative marker and fill placeholder row counted by countUnfilledReviewRecords", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-postprobe-"));
    try {
      const recordData = {
        chainId: "chain-postprobe-cancelled",
        provisional: true,
        records: [
          {
            round: 1,
            interrupted: true,
            interruptedAfter: "probes",
            probeResults: [{ probe: "P1: HEAD clean", passed: true }],
            findings: [],
          },
        ],
        disposition: { disposition: "cancelled", round: 1 },
      };
      const text = renderReviewRecord(recordData);
      assert.match(text, /_No review verdict was delivered for this chain — implementation remains unadjudicated\._/);
      assert.match(text, /\| 1 \| unknown \| _No review verdict delivered — unadjudicated implementation_ \| _fill_ \| _fill_ \|/);

      const chainDir = path.join(tmpDir, "ws", "chains", "chain-postprobe-cancelled");
      fs.mkdirSync(chainDir, { recursive: true });
      fs.writeFileSync(path.join(chainDir, "review-record.md"), text, "utf8");

      assert.equal(countUnfilledReviewRecords(tmpDir), 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// renderContainerReviewInput — the one container review input (kusabi #204)
// ---------------------------------------------------------------------------
// The chain review and `task --phase review --container` both render their
// review input here.  The chain-side byte-identity contract is pinned in
// chain-phases.test.mjs against a golden captured before the extraction; these
// tests cover what the block must CONTAIN, which is what the reviewer needs.

describe("renderContainerReviewInput", () => {
  const FACTS = {
    container: "cafe1234beef",
    baseSha: "0123456789abcdef",
    baseLog: "abc1234 first\ndef5678 second\n",
    statusOutput: " M src/foo.js\n",
    untrackedFiles: "src/new.js\n",
  };

  it("names the container and the read-side tools", () => {
    const out = renderContainerReviewInput(FACTS);
    assert.ok(out.startsWith("## Review target"));
    assert.ok(out.includes("container `cafe1234beef`"));
    assert.ok(out.includes("`read_file_range`"));
    assert.ok(out.includes("`search_in_container`"));
    assert.ok(out.includes("`diff_in_container`"));
    assert.ok(out.includes("`verify_in_container`"));
    assert.ok(out.includes("Do NOT rely on host cwd git state"));
  });

  it("carries the base facts and the fetch instruction, and no diff body", () => {
    const out = renderContainerReviewInput(FACTS);
    // The point of the block after #208: the reviewer is given the reference
    // point it cannot derive, and told to fetch the diff against it.
    assert.ok(out.includes("- Base commit: `0123456789abcdef`"));
    assert.ok(out.includes("abc1234 first"));
    assert.ok(out.includes(" M src/foo.js"));
    assert.ok(out.includes("- `src/new.js`"));
    assert.ok(out.includes("Fetching the diff is YOUR job"));
    assert.ok(out.includes("`base` set to `0123456789abcdef`"));
    assert.doesNotMatch(out, /diff --git/);
    assert.ok(!out.includes("```diff"));
  });

  it("embeds renderBaseFacts verbatim, separated by a blank line", () => {
    const out = renderContainerReviewInput(FACTS);
    const facts = renderBaseFacts(FACTS);
    assert.ok(out.endsWith("\n\n" + facts));
  });

  it("passes the truncation facts through to the base facts", () => {
    const out = renderContainerReviewInput({
      ...FACTS,
      truncation: { status: { truncated: true, total: 137 } },
    });
    // FACTS.statusOutput is one line, so that is the numerator.
    assert.ok(out.includes("**Change set truncated (showing 1 of 137 lines).**"));
  });

  it("stays well-formed when nothing could be read from the container", () => {
    const out = renderContainerReviewInput({ container: "c1" });
    assert.ok(out.startsWith("## Review target"));
    assert.ok(out.includes("container `c1`"));
    // Degraded, not malformed: every section is present and says what is
    // missing, and no fence is left open.
    assert.ok(out.includes("- Base commit: (unavailable)"));
    assert.ok(out.includes("(empty change set)"));
    // No base to name, so the instruction names the fallback instead of
    // silently dropping the only sentence that says the fetch is the
    // reviewer's job.
    assert.ok(out.includes("Fetching the diff is YOUR job"));
    assert.ok(out.includes("`worktree: true`"));
    assert.ok(!out.includes("```diff"));
    assert.equal((out.match(/```/g) || []).length % 2, 0);
    assert.ok(out.endsWith("must not be flagged as such."));
  });

  it("does not throw when called with no arguments", () => {
    const out = renderContainerReviewInput();
    assert.ok(out.includes("## Review target"));
    assert.ok(out.includes("- Base commit: (unavailable)"));
    assert.ok(out.includes("Fetching the diff is YOUR job"));
  });
});

// renderEscalationDecisions  —  kusabi #336 pure decision renderer
// ===========================================================================

describe("renderEscalationDecisions", () => {
  it("returns a plain line for missing findings", () => {
    assert.equal(renderEscalationDecisions(undefined), "(no structured findings to decide)");
  });

  it("returns a plain line for an empty findings array", () => {
    assert.equal(renderEscalationDecisions([]), "(no structured findings to decide)");
  });

  it("returns a plain line when no entry is a structured finding", () => {
    assert.equal(
      renderEscalationDecisions([null, "not-an-object", 42]),
      "(no structured findings to decide)",
    );
  });

  it("opens with an explicit 'one answer per item' instruction", () => {
    const out = renderEscalationDecisions([
      { severity: "medium", title: "t", file: "f.js", line_start: 1 },
    ]);
    assert.ok(out.startsWith(
      "Decisions for the orchestrator (answer each; a one-line answer per item",
    ));
  });

  it("renders each finding's body and recommendation in full", () => {
    const out = renderEscalationDecisions([
      {
        severity: "medium",
        kind: "design",
        title: "consider two approaches",
        file: "src/app.js",
        line_start: 10,
        body: "The current approach BODY does not scale.",
        recommendation: "Recommendation text with TWO alternatives: A or B.",
      },
    ]);
    assert.ok(out.includes("### [medium] [design] consider two approaches (src/app.js:10)"));
    assert.ok(out.includes("The current approach BODY does not scale."));
    assert.ok(out.includes("**Recommendation:** Recommendation text with TWO alternatives: A or B."));
  });

  it("survives the recommendation text into the output", () => {
    const out = renderEscalationDecisions([
      {
        severity: "high",
        title: "t",
        file: "f.js",
        line_start: 2,
        body: "b",
        recommendation: "UNIQUE-RECOMMENDATION-TEXT-336",
      },
    ]);
    assert.ok(out.includes("UNIQUE-RECOMMENDATION-TEXT-336"));
  });

  it("omits the kind bracket when kind is missing", () => {
    const out = renderEscalationDecisions([
      { severity: "low", title: "no kind here", file: "g.js", line_start: 3 },
    ]);
    assert.ok(out.includes("### [low] no kind here (g.js:3)"));
    assert.doesNotMatch(out, /\[low\] \[/);
  });

  it("renders a finding with no body/recommendation without throwing", () => {
    const out = renderEscalationDecisions([
      { severity: "low", title: "bare", file: "g.js", line_start: 3 },
    ]);
    assert.ok(out.includes("### [low] bare (g.js:3)"));
  });

  it("orders findings by severity critical -> high -> medium -> low -> unknown", () => {
    const out = renderEscalationDecisions([
      { severity: "low", title: "LOW", file: "f.js", line_start: 1 },
      { severity: "critical", title: "CRIT", file: "f.js", line_start: 1 },
      { severity: "medium", title: "MED", file: "f.js", line_start: 1 },
      { severity: "high", title: "HIGH", file: "f.js", line_start: 1 },
      { severity: "unknown", title: "UNK", file: "f.js", line_start: 1 },
    ]);
    const iCrit = out.indexOf("CRIT");
    const iHigh = out.indexOf("HIGH");
    const iMed = out.indexOf("MED");
    const iLow = out.indexOf("LOW");
    const iUnk = out.indexOf("UNK");
    assert.ok(iCrit < iHigh && iHigh < iMed && iMed < iLow && iLow < iUnk);
  });

  it("keeps input order within a severity (stable sort)", () => {
    const out = renderEscalationDecisions([
      { severity: "medium", title: "MED-FIRST", file: "f.js", line_start: 1 },
      { severity: "medium", title: "MED-SECOND", file: "f.js", line_start: 1 },
    ]);
    assert.ok(out.indexOf("MED-FIRST") < out.indexOf("MED-SECOND"));
  });

  it("treats a missing severity as 'unknown' at the end", () => {
    const out = renderEscalationDecisions([
      { severity: "critical", title: "CRIT", file: "f.js", line_start: 1 },
      { title: "NOSEV", file: "f.js", line_start: 1 },
    ]);
    assert.ok(out.indexOf("CRIT") < out.indexOf("NOSEV"));
  });

  it("truncates at the budget and points to the host-side round record", () => {
    const mk = (sev, tag) => ({
      severity: sev,
      title: tag,
      file: "f.js",
      line_start: 1,
      body: tag + "-BODY-" + "x".repeat(2500),
      recommendation: tag + "-REC-" + "y".repeat(500),
    });
    const out = renderEscalationDecisions(
      [mk("critical", "CRIT"), mk("high", "HIGH"), mk("medium", "MED"), mk("low", "LOW")],
      { roundNumber: 4 },
    );
    assert.ok(out.length <= 6000 + 400); // budget + truncation note slack
    assert.ok(out.includes("remaining findings are in"));
    assert.ok(out.includes("round-4.json"));
    assert.ok(out.includes("open that record to decide the rest"));
    // The lowest-severity finding was truncated away.
    assert.doesNotMatch(out, /LOW-BODY/);
    // Higher-severity material survives.
    assert.ok(out.includes("CRIT-REC"));
  });

  it("truncation note omits the round file when no round number is given", () => {
    const mk = (sev, tag) => ({
      severity: sev,
      title: tag,
      file: "f.js",
      line_start: 1,
      body: tag + "-BODY-" + "x".repeat(3500),
    });
    const out = renderEscalationDecisions([mk("critical", "CRIT"), mk("low", "LOW")]);
    assert.ok(out.includes("the chain's round record on the host"));
    assert.doesNotMatch(out, /round-.*\.json/);
  });

  it("drops whole entries at the budget and reports N of M in the note", () => {
    const mk = (sev, tag) => ({
      severity: sev,
      title: tag,
      file: "f.js",
      line_start: 1,
      body: tag + "-BODY-" + "x".repeat(2500),
      recommendation: tag + "-REC-" + "y".repeat(500),
    });
    const out = renderEscalationDecisions(
      [mk("critical", "CRIT"), mk("high", "HIGH"), mk("medium", "MED"), mk("low", "LOW")],
      { roundNumber: 4 },
    );
    // The least severe finding is dropped whole — never partially.
    assert.doesNotMatch(out, /LOW-BODY/);
    assert.doesNotMatch(out, /LOW-REC/);
    // The note states how many of how many are shown.
    assert.ok(out.includes("1 of 4 findings shown"));
    assert.ok(out.includes("round-4.json"));
  });

  it("emits no truncation note when every finding fits within the budget", () => {
    const out = renderEscalationDecisions([
      { severity: "critical", title: "CRIT", file: "f.js", line_start: 1, body: "short body", recommendation: "short rec" },
      { severity: "low", title: "LOW", file: "f.js", line_start: 2, body: "another short body" },
    ]);
    assert.doesNotMatch(out, /findings shown/);
    assert.doesNotMatch(out, /truncated/);
    assert.ok(out.includes("CRIT"));
    assert.ok(out.includes("LOW"));
  });

  it("truncates a single oversized finding at a line boundary (never mid-line)", () => {
    const bigBody = [
      "LINE-ONE-UNIQUE-336",
      "LINE-TWO-UNIQUE-336",
      "x".repeat(7000),
      "LINE-FOUR-UNIQUE-336",
    ].join("\n");
    const out = renderEscalationDecisions([
      {
        severity: "critical",
        title: "BIG",
        file: "f.js",
        line_start: 1,
        body: bigBody,
        recommendation: "REC-UNIQUE-336",
      },
    ], { roundNumber: 7 });
    // The entry was truncated (not dropped): note reports 1 of 1 shown.
    assert.ok(out.includes("1 of 1 findings shown"));
    assert.ok(out.includes("round-7.json"));
    // Early lines are kept whole; later lines are dropped whole; the body's
    // long middle line and the recommendation are past the cut.
    assert.ok(out.includes("LINE-ONE-UNIQUE-336"));
    assert.ok(out.includes("LINE-TWO-UNIQUE-336"));
    assert.doesNotMatch(out, /LINE-FOUR-UNIQUE-336/);
    assert.doesNotMatch(out, /REC-UNIQUE-336/);
    // No dangling ### header is ever left as the final content line.
    const lastContent = [...out.split("\n")].reverse().find((l) => l.length > 0);
    assert.ok(lastContent && !lastContent.startsWith("### "));
  });
});
