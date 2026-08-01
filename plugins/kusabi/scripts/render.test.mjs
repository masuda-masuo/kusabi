import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractJson,
  renderReview,
  renderChainShow,
  renderJobLine,
  renderHeader,
  renderBaseFacts,
  renderFollowupDraft,
  renderStrategistPrompt,
  recoverVerdictFromText,
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

// renderBaseFacts diff content — new block-level diff rendering
// ---------------------------------------------------------------------------

describe("renderBaseFacts diff content", () => {
  it("renders diff content when diffContent is supplied", () => {
    const result = renderBaseFacts({
      baseSha: "abc",
      baseLog: "log",
      statusOutput: " M src/foo.js",
      diffContent: "diff --git a/src/foo.js b/src/foo.js\nindex abc..def 100644\n--- a/src/foo.js\n+++ b/src/foo.js\n@@ -1 +1 @@\n-old\n+new",
    });
    assert.match(result, /Diff content:/);
    assert.match(result, /```diff/);
    assert.match(result, /diff --git a\/src\/foo.js/);
    assert.match(result, /\+new/);
    assert.doesNotMatch(result, /truncated/);
    assert.doesNotMatch(result, /\(unavailable\)/);
  });

  it("marks diff as unavailable when diffContent is absent", () => {
    const result = renderBaseFacts({
      baseSha: "abc",
      baseLog: "log",
      statusOutput: " M src/foo.js",
    });
    assert.match(result, /Diff content: \(unavailable\)/);
  });

  it("marks diff as unavailable when diffContent is empty string", () => {
    const result = renderBaseFacts({
      diffContent: "",
    });
    assert.match(result, /Diff content: \(unavailable\)/);
  });

  it("marks diff as unavailable when diffContent is only whitespace", () => {
    const result = renderBaseFacts({
      diffContent: "   ",
    });
    assert.match(result, /Diff content: \(unavailable\)/);
  });

  it("marks truncation when diff exceeds the budget", () => {
    // DIFF_BUDGET is 30000; create content larger than that
    const bigContent = "diff --git a/x b/x\n" + "x\n".repeat(30000);
    const result = renderBaseFacts({
      diffContent: bigContent,
    });
    assert.match(result, /Diff content \(truncated to 30000 characters\):/);
    assert.match(result, /Diff truncated/);
  });

  it("does not mark truncation when diff is under the budget", () => {
    const smallContent = "diff --git a/x b/x\n+small change";
    const result = renderBaseFacts({
      diffContent: smallContent,
    });
    assert.match(result, /Diff content:/);
    assert.doesNotMatch(result, /truncated/);
    assert.doesNotMatch(result, /Diff truncated/);
  });

  it("joins existing fields with diff content", () => {
    const result = renderBaseFacts({
      baseSha: "sha1",
      baseLog: "logline",
      statusOutput: " M src/bar.js",
      diffContent: "diff --git a/src/bar.js b/src/bar.js\n+new",
    });
    // Existing fields still present
    assert.match(result, /Base commit: `sha1`/);
    assert.match(result, /logline/);
    assert.match(result, /src\/bar\.js/);
    // Diff present
    assert.match(result, /Diff content:/);
    assert.match(result, /\+new/);
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

  it("works together with diffContent", () => {
    const result = renderBaseFacts({
      baseSha: "abc",
      baseLog: "log",
      statusOutput: " M src/foo.js\n?? newfile.ts",
      diffContent: "diff --git a/src/foo.js b/src/foo.js\n+change",
      untrackedFiles: "newfile.ts",
    });
    assert.match(result, /Diff content:/);
    assert.match(result, /\+change/);
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
