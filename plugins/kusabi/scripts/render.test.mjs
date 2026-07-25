import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractJson,
  renderReview,
  renderChainShow,
  renderJobLine,
  renderBaseFacts,
  renderFollowupDraft,
  renderStrategistPrompt,
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

  it("findingsText appears verbatim in the output", () => {
    const result = renderChainShow(sampleChain, sampleRounds);
    assert.ok(result.includes("[low] Minor style issue (src/foo.js:10)"));
    assert.ok(result.includes("[high] Missing error handling (src/bar.js:42)"));
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

