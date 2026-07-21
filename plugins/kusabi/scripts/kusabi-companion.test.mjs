import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  accumulateUsage,
  decidePermission,
  extractJson,
  renderReview,
  renderChainShow,
  renderJobLine,
  newestChainDir,
  parseArgs,
  parseModel,
  parseOrchestratorSignature,
  stateRoot,
  deriveDisposition,
  loadConfig,
  resolveModel,
  readBriefFile,
  shouldReapServer,
  cwdSlug,
  findTranscriptFile,
  extractAssistantText,
  resolveExplainPassage,
  parseDeliverables,
  parseChangedPaths,
  checkDeliverablesProbe,
  implementDenyTools,
} from "./kusabi-companion.mjs";

// ---------------------------------------------------------------------------
// decidePermission — always returns "once"
// ---------------------------------------------------------------------------

describe("decidePermission", () => {
  it("returns 'once' with no arguments", () => {
    assert.equal(decidePermission(), "once");
  });

  it("returns 'once' with arbitrary arguments", () => {
    assert.equal(decidePermission("anything"), "once");
    assert.equal(decidePermission(42, { foo: 1 }), "once");
  });
});

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// renderReview
// ---------------------------------------------------------------------------

const sampleParsed = {
  verdict: "approve",
  summary: "The code looks good.",
  findings: [
    {
      severity: "low",
      title: "Minor style issue",
      file: "src/foo.js",
      line_start: 10,
      line_end: 12,
      confidence: 0.9,
      body: "Consider adding a blank line.",
      recommendation: "Add a blank line after the import block.",
    },
  ],
  next_steps: ["Run the linter before merging."],
};

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

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses a value flag: --prior", () => {
    const result = parseArgs(["--prior", "previous findings"]);
    assert.equal(result.flags.prior, "previous findings");
  });

  it("parses a value flag: --model", () => {
    const result = parseArgs(["--model", "anthropic/claude-4"]);
    assert.equal(result.flags.model, "anthropic/claude-4");
  });

  it("parses a boolean flag: --wait", () => {
    const result = parseArgs(["--wait"]);
    assert.equal(result.flags.wait, true);
  });

  it("parses -- as literal separator and puts rest in text", () => {
    const result = parseArgs(["--prior", "x", "--", "extra", "args"]);
    assert.equal(result.flags.prior, "x");
    assert.equal(result.text, "extra args");
  });

  it("throws on unknown flag", () => {
    assert.throws(
      () => parseArgs(["--nope"]),
      /unknown flag: --nope/,
    );
  });

  it("returns empty flags and text for empty argv", () => {
    const result = parseArgs([]);
    assert.deepEqual(result.flags, {});
    assert.equal(result.text, "");
  });

  it("treats -h as a boolean flag", () => {
    const result = parseArgs(["-h"]);
    assert.equal(result.flags.h, true);
  });

  it("parses --tools as a boolean flag", () => {
    const result = parseArgs(["--tools"]);
    assert.equal(result.flags.tools, true);
  });

  it("parses --last as a value flag", () => {
    const result = parseArgs(["--last", "3"]);
    assert.equal(result.flags.last, "3");
  });

  it("parses --quote as a value flag", () => {
    const result = parseArgs(["--quote", "some passage text"]);
    assert.equal(result.flags.quote, "some passage text");
  });

  it("combines --last, --tools, --quote with rest text", () => {
    const result = parseArgs(["--last", "2", "--tools", "--quote", "the passage", "--", "the question"]);
    assert.equal(result.flags.last, "2");
    assert.equal(result.flags.tools, true);
    assert.equal(result.flags.quote, "the passage");
    assert.equal(result.text, "the question");
  });

  it("throws when --last is missing its value", () => {
    assert.throws(() => parseArgs(["--last"]), /--last requires a value/);
  });

  it("throws when --quote is missing its value", () => {
    assert.throws(() => parseArgs(["--quote"]), /--quote requires a value/);
  });
});


// ---------------------------------------------------------------------------
// stateRoot — state directory resolution with migration
// ---------------------------------------------------------------------------

describe("stateRoot", () => {
  it("uses KUSABI_STATE_DIR env var when set", () => {
    const saved = process.env.KUSABI_STATE_DIR;
    try {
      process.env.KUSABI_STATE_DIR = "/tmp/kusabi-test-custom";
      assert.equal(stateRoot(), "/tmp/kusabi-test-custom");
    } finally {
      if (saved === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = saved;
    }
  });

  it("falls back to OPENCODE_COMPANION_STATE_DIR when KUSABI_STATE_DIR is not set", () => {
    const savedKusabi = process.env.KUSABI_STATE_DIR;
    const savedOld = process.env.OPENCODE_COMPANION_STATE_DIR;
    try {
      delete process.env.KUSABI_STATE_DIR;
      process.env.OPENCODE_COMPANION_STATE_DIR = "/tmp/kusabi-test-legacy";
      assert.equal(stateRoot(), "/tmp/kusabi-test-legacy");
    } finally {
      if (savedKusabi === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = savedKusabi;
      if (savedOld === undefined) delete process.env.OPENCODE_COMPANION_STATE_DIR;
      else process.env.OPENCODE_COMPANION_STATE_DIR = savedOld;
    }
  });

  it("returns {home}/.kusabi with default os.homedir() when no env var is set", () => {
    const savedKusabi = process.env.KUSABI_STATE_DIR;
    const savedOld = process.env.OPENCODE_COMPANION_STATE_DIR;
    try {
      delete process.env.KUSABI_STATE_DIR;
      delete process.env.OPENCODE_COMPANION_STATE_DIR;
      const result = stateRoot();
      assert.equal(result, path.join(os.homedir(), ".kusabi"));
    } finally {
      if (savedKusabi === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = savedKusabi;
      if (savedOld === undefined) delete process.env.OPENCODE_COMPANION_STATE_DIR;
      else process.env.OPENCODE_COMPANION_STATE_DIR = savedOld;
    }
  });

  it("returns {home}/.kusabi with injected home directory", () => {
    const savedKusabi = process.env.KUSABI_STATE_DIR;
    const savedOld = process.env.OPENCODE_COMPANION_STATE_DIR;
    try {
      delete process.env.KUSABI_STATE_DIR;
      delete process.env.OPENCODE_COMPANION_STATE_DIR;
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-"));
      try {
        const result = stateRoot(home);
        assert.equal(result, path.join(home, ".kusabi"));
      } finally {
        fs.rmSync(home, { recursive: true });
      }
    } finally {
      if (savedKusabi === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = savedKusabi;
      if (savedOld === undefined) delete process.env.OPENCODE_COMPANION_STATE_DIR;
      else process.env.OPENCODE_COMPANION_STATE_DIR = savedOld;
    }
  });

  it("migrates old .opencode-plugin-cc to .kusabi when only old dir exists", () => {
    const savedKusabi = process.env.KUSABI_STATE_DIR;
    const savedOld = process.env.OPENCODE_COMPANION_STATE_DIR;
    try {
      delete process.env.KUSABI_STATE_DIR;
      delete process.env.OPENCODE_COMPANION_STATE_DIR;

      const home = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-"));
      const oldDir = path.join(home, ".opencode-plugin-cc");
      const newDir = path.join(home, ".kusabi");

      // Create old dir with a marker file
      fs.mkdirSync(oldDir, { recursive: true });
      const marker = path.join(oldDir, "migration-marker");
      fs.writeFileSync(marker, "pre-migration data", "utf8");

      try {
        const result = stateRoot(home);
        assert.equal(result, newDir);
        // Old dir should be gone (renamed to new)
        assert.ok(!fs.existsSync(oldDir), "old dir should not exist after migration");
        // New dir should contain the marker
        assert.ok(fs.existsSync(path.join(newDir, "migration-marker")), "migration marker should exist in new dir");
      } finally {
        fs.rmSync(home, { recursive: true });
      }
    } finally {
      if (savedKusabi === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = savedKusabi;
      if (savedOld === undefined) delete process.env.OPENCODE_COMPANION_STATE_DIR;
      else process.env.OPENCODE_COMPANION_STATE_DIR = savedOld;
    }
  });

  it("skips migration when env var is set even if old dir exists", () => {
    const savedKusabi = process.env.KUSABI_STATE_DIR;
    const savedOld = process.env.OPENCODE_COMPANION_STATE_DIR;
    try {
      delete process.env.KUSABI_STATE_DIR;
      delete process.env.OPENCODE_COMPANION_STATE_DIR;

      const home = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-"));
      const oldDir = path.join(home, ".opencode-plugin-cc");

      // Create old dir
      fs.mkdirSync(oldDir, { recursive: true });

      try {
        // Set env override
        process.env.KUSABI_STATE_DIR = "/tmp/kusabi-env-override-test";
        const result = stateRoot(home);
        assert.equal(result, "/tmp/kusabi-env-override-test");
        // Old dir should still exist (not migrated because env is set)
        assert.ok(fs.existsSync(oldDir), "old dir should still exist when env is set");
      } finally {
        fs.rmSync(home, { recursive: true });
      }
    } finally {
      if (savedKusabi === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = savedKusabi;
      if (savedOld === undefined) delete process.env.OPENCODE_COMPANION_STATE_DIR;
      else process.env.OPENCODE_COMPANION_STATE_DIR = savedOld;
    }
  });
});

// ---------------------------------------------------------------------------
// deriveDisposition — all branches
// ---------------------------------------------------------------------------

describe("deriveDisposition", () => {
  it("accept: approve + probesGreen", () => {
    const result = deriveDisposition({ verdict: "approve", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "accept" });
  });

  it("rework: approve + probes not green", () => {
    const result = deriveDisposition({ verdict: "approve", probesGreen: false, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "rework", reason: "deterministic probes failed" });
  });

  it("escalate: approve-partial (unverified items remain)", () => {
    const result = deriveDisposition({ verdict: "approve-partial", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "escalate", reason: "approve-partial: unverified items remain" });
  });

  it("rework: needs-attention without repeated areas", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "rework", reason: "needs-attention" });
  });

  it("escalate: needs-attention with repeated areas (same file 2 rounds)", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: true, round: 2, maxRounds: 3, repeatedAreas: true });
    assert.deepEqual(result, { disposition: "escalate", reason: "same file area flagged for two consecutive rounds" });
  });

  it("escalate: discard", () => {
    const result = deriveDisposition({ verdict: "discard", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "escalate", reason: "reviewer discarded the work" });
  });

  it("escalate: max rounds reached without accept", () => {
    const result = deriveDisposition({ verdict: "needs-attention", probesGreen: false, round: 3, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "escalate", reason: "max rounds (3) reached without acceptance" });
  });

  it("accept on last round when approve + green", () => {
    const result = deriveDisposition({ verdict: "approve", probesGreen: true, round: 3, maxRounds: 3, repeatedAreas: false });
    assert.deepEqual(result, { disposition: "accept" });
  });

  it("escalate: unknown verdict", () => {
    const result = deriveDisposition({ verdict: "unknown", probesGreen: true, round: 1, maxRounds: 3, repeatedAreas: false });
    assert.equal(result.disposition, "escalate");
    assert.match(result.reason, /unexpected verdict/);
  });
});

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
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
});

// ---------------------------------------------------------------------------
// newestChainDir — chain directory selection by mtime
// ---------------------------------------------------------------------------

describe("newestChainDir", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-chaindir-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the newest chain dir by mtime", () => {
    const oldDir = path.join(tmpDir, "chain-old");
    const newDir = path.join(tmpDir, "chain-new");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });
    const oldTime = new Date("2020-01-01").getTime();
    fs.utimesSync(oldDir, oldTime / 1000, oldTime / 1000);
    const result = newestChainDir(tmpDir);
    assert.equal(result, "chain-new");
  });

  it("returns null when chainsDir does not exist", () => {
    const result = newestChainDir(path.join(tmpDir, "nonexistent"));
    assert.equal(result, null);
  });

  it("returns null when no chain-* directories exist", () => {
    fs.mkdirSync(path.join(tmpDir, "some-other-dir"), { recursive: true });
    const result = newestChainDir(tmpDir);
    assert.equal(result, null);
  });

  it("returns null for empty directory", () => {
    const result = newestChainDir(tmpDir);
    assert.equal(result, null);
  });

  it("only matches chain-* directories", () => {
    fs.mkdirSync(path.join(tmpDir, "not_a_chain_dir"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "chain-real"), { recursive: true });
    const result = newestChainDir(tmpDir);
    assert.equal(result, "chain-real");
  });

  it("picks newest among multiple chain dirs", () => {
    const c1 = path.join(tmpDir, "chain-001");
    const c2 = path.join(tmpDir, "chain-002");
    const c3 = path.join(tmpDir, "chain-003");
    fs.mkdirSync(c1, { recursive: true });
    fs.mkdirSync(c2, { recursive: true });
    fs.mkdirSync(c3, { recursive: true });
    const t1 = new Date("2020-06-01").getTime();
    const t2 = new Date("2020-06-02").getTime();
    const t3 = new Date("2020-06-03").getTime();
    fs.utimesSync(c1, t1 / 1000, t1 / 1000);
    fs.utimesSync(c2, t2 / 1000, t2 / 1000);
    fs.utimesSync(c3, t3 / 1000, t3 / 1000);
    const result = newestChainDir(tmpDir);
    assert.equal(result, "chain-003");
  });

  it("uses lexicographic tiebreaker when mtimes are identical", () => {
    const cA = path.join(tmpDir, "chain-aaa");
    const cB = path.join(tmpDir, "chain-bbb");
    fs.mkdirSync(cA, { recursive: true });
    fs.mkdirSync(cB, { recursive: true });
    const sameTime = new Date("2020-01-01").getTime();
    fs.utimesSync(cA, sameTime / 1000, sameTime / 1000);
    fs.utimesSync(cB, sameTime / 1000, sameTime / 1000);
    const result = newestChainDir(tmpDir);
    // Both have same mtime, "chain-aaa" sorts before "chain-bbb" lexicographically
    assert.equal(result, "chain-aaa");
  });
});

// ---------------------------------------------------------------------------
// parseArgs — --max-rounds flag
// ---------------------------------------------------------------------------

describe("parseArgs max-rounds", () => {
  it("parses --max-rounds flag", () => {
    const result = parseArgs(["--max-rounds", "5"]);
    // Value flags use arg.slice(2) directly, so key is "max-rounds" (hyphenated)
    assert.equal(result.flags["max-rounds"], "5");
  });

  it("defaults to undefined when not provided", () => {
    const result = parseArgs([]);
    assert.equal(result.flags["max-rounds"], undefined);
  });

  it("parses --max-rounds in chain context", () => {
    const result = parseArgs(["--container", "abc123", "--model", "anthropic/claude-4", "--max-rounds", "5", "implement the thing"]);
    assert.equal(result.flags.container, "abc123");
    assert.equal(result.flags.model, "anthropic/claude-4");
    assert.equal(result.flags["max-rounds"], "5");
    assert.equal(result.text, "implement the thing");
  });
});

// ---------------------------------------------------------------------------
// sunaba-rpc — module exports and allowlist enforcement
// ---------------------------------------------------------------------------

describe("sunaba-rpc allowlist", () => {
  it("throws when tool is not in allowed list", async () => {
    const { callTool } = await import("./sunaba-rpc.mjs");
    await assert.rejects(
      () => callTool("publish", {}),
      /not in the allowed list/,
    );
  });

  it("throws for sandbox_exec string commands (must be array)", async () => {
    const { callTool } = await import("./sunaba-rpc.mjs");
    await assert.rejects(
      () => callTool("sandbox_exec", { commands: "git status" }),
      /commands.*must be an array/,
    );
  });

  it("sandbox_exec with array commands passes validation", async () => {
    const { callTool } = await import("./sunaba-rpc.mjs");
    // Should not throw from validation (will fail on fetch, not on allowlist)
    try {
      await callTool("sandbox_exec", { commands: ["git status"] });
    } catch (err) {
      assert.ok(!err.message.includes("must be an array"), "validation should pass for arrays");
      assert.ok(!err.message.includes("not in the allowed list"), "should be allowed");
    }
  });

  it("allows all 5 tools in the allowlist", async () => {
    const { callTool } = await import("./sunaba-rpc.mjs");
    for (const tool of ["verify_in_container", "sandbox_exec", "checkpoint", "checkpoint_list", "checkpoint_restore"]) {
      try {
        await callTool(tool, {});
      } catch (err) {
        assert.ok(!err.message.includes("not in the allowed list"), `${tool} should be allowed`);
      }
    }
  });

  it("exports all convenience wrappers", async () => {
    const mod = await import("./sunaba-rpc.mjs");
    assert.ok(typeof mod.verifyInContainer === "function");
    assert.ok(typeof mod.sandboxExec === "function");
    assert.ok(typeof mod.checkpoint === "function");
    assert.ok(typeof mod.checkpointList === "function");
    assert.ok(typeof mod.checkpointRestore === "function");
  });
});


// ---------------------------------------------------------------------------
// sunaba-rpc — SSE parsing and MCP content unwrap
// ---------------------------------------------------------------------------

describe("sunaba-rpc SSE and unwrap", () => {
  it("parseSseResponse extracts last data line with result", async () => {
    const { parseSseResponse } = await import("./sunaba-rpc.mjs");
    const body = [
      'data: {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"sunaba","version":"1.0.0"}}}',
      'data: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\\"key\\":\\"value\\"}"}]}}',
    ].join("\n");
    const result = parseSseResponse(body);
    assert.deepEqual(result, { content: [{ type: "text", text: '{"key":"value"}' }] });
  });

  it("parseSseResponse throws on empty body", async () => {
    const { parseSseResponse } = await import("./sunaba-rpc.mjs");
    assert.throws(() => parseSseResponse(""), /no data lines/);
  });

  it("parseSseResponse throws on error response", async () => {
    const { parseSseResponse } = await import("./sunaba-rpc.mjs");
    const body = 'data: {"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"internal error"}}';
    assert.throws(() => parseSseResponse(body), /internal error/);
  });

  it("unwrapResult extracts and parses text from content[0]", async () => {
    const { unwrapResult } = await import("./sunaba-rpc.mjs");
    const result = unwrapResult({
      content: [{ type: "text", text: '{"gate_passed":true,"summary":"all green"}' }],
    });
    assert.deepEqual(result, { gate_passed: true, summary: "all green" });
  });

  it("unwrapResult parses sandbox_exec output field", async () => {
    const { unwrapResult } = await import("./sunaba-rpc.mjs");
    // sandbox_exec returns text JSON with "output" field (not "stdout")
    const result = unwrapResult({
      content: [{ type: "text", text: '{"output":"abc123\\n","exit_code":0}' }],
    });
    assert.equal(result.output, "abc123\n");
    assert.equal(result.exit_code, 0);
  });

  it("unwrapResult returns raw result when content is empty", async () => {
    const { unwrapResult } = await import("./sunaba-rpc.mjs");
    const result = unwrapResult({ someField: "direct" });
    assert.deepEqual(result, { someField: "direct" });
  });

  it("unwrapResult returns raw string when text is not JSON", async () => {
    const { unwrapResult } = await import("./sunaba-rpc.mjs");
    const result = unwrapResult({
      content: [{ type: "text", text: "plain string output" }],
    });
    assert.equal(result, "plain string output");
  });
});

// ---------------------------------------------------------------------------
// accumulateUsage
// ---------------------------------------------------------------------------

describe("accumulateUsage", () => {
  it("aggregates per-message tokens from message.updated events", () => {
    const events = [
      {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_1",
            role: "assistant",
            modelID: "deepseek-v4-flash",
            providerID: "opencode-go",
            cost: 0.0015,
            tokens: { total: 500, input: 200, output: 300, reasoning: 50, cache: { read: 1000, write: 0 } },
          },
        },
      },
      {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_2",
            role: "assistant",
            modelID: "deepseek-v4-flash",
            providerID: "opencode-go",
            cost: 0.0005,
            tokens: { total: 150, input: 50, output: 100, reasoning: 10, cache: { read: 500, write: 0 } },
          },
        },
      },
    ];
    const result = accumulateUsage(events);
    assert.equal(result.available, true);
    assert.equal(result.input, 250);
    assert.equal(result.output, 400);
    assert.equal(result.reasoning, 60);
    assert.equal(result.cacheRead, 1500);
    assert.equal(result.cacheWrite, 0);
    assert.equal(result.cost, 0.002);
    assert.equal(result.model, "opencode-go/deepseek-v4-flash");
  });

  it("uses the last update per message id (overwrites earlier partial data)", () => {
    const events = [
      {
        type: "message.updated",
        properties: {
          info: { id: "msg_1", role: "assistant", modelID: "m1", providerID: "p1", cost: 0.001, tokens: { input: 10, output: 20 } },
        },
      },
      {
        type: "message.updated",
        properties: {
          info: { id: "msg_1", role: "assistant", modelID: "m1", providerID: "p1", cost: 0.003, tokens: { input: 100, output: 200 } },
        },
      },
    ];
    const result = accumulateUsage(events);
    assert.equal(result.input, 100);
    assert.equal(result.output, 200);
    assert.equal(result.cost, 0.003);
  });

  it("returns available=false when no usage-related events exist", () => {
    const events = [
      { type: "session.idle", properties: {} },
      { type: "permission.asked", properties: { permission: { type: "bash" } } },
    ];
    const result = accumulateUsage(events);
    assert.equal(result.available, false);
  });

  it("returns available=false for empty event array", () => {
    const result = accumulateUsage([]);
    assert.equal(result.available, false);
  });

  it("ignores events with null/undefined properties", () => {
    const events = [
      { type: "message.updated", properties: {} },
      null,
      undefined,
      { type: "session.updated", properties: {} },
    ];
    const result = accumulateUsage(events);
    assert.equal(result.available, false);
  });

  it("session reuse: only counts messages observed during this job, not session cumulative", () => {
    // Simulate a reused session: the first session.updated shows cumulative tokens
    // from a previous job, but only message.updated for the new job's message is counted.
    const events = [
      {
        type: "session.updated",
        properties: {
          sessionID: "ses_reused",
          info: {
            id: "ses_reused",
            tokens: { input: 5000, output: 2000, reasoning: 1000, cache: { read: 100000, write: 0 } },
            cost: 0.02,
          },
        },
      },
      {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_new",
            role: "assistant",
            modelID: "deepseek-v4-flash",
            providerID: "opencode-go",
            cost: 0.001,
            tokens: { input: 300, output: 150, reasoning: 20, cache: { read: 5000, write: 0 } },
          },
        },
      },
    ];
    const result = accumulateUsage(events);
    // Should reflect only the new message, not the cumulative session totals.
    assert.equal(result.available, true);
    assert.equal(result.input, 300);
    assert.equal(result.output, 150);
    assert.equal(result.cost, 0.001);
  });

  it("falls back to session delta when no message.updated events but session deltas exist", () => {
    const events = [
      {
        type: "session.updated",
        properties: {
          sessionID: "ses_x",
          info: { id: "ses_x", tokens: { input: 100, output: 50 }, cost: 0.001, model: { providerID: "p1", id: "m1" } },
        },
      },
      {
        type: "session.updated",
        properties: {
          sessionID: "ses_x",
          info: { id: "ses_x", tokens: { input: 500, output: 200 }, cost: 0.005, model: { providerID: "p1", id: "m1" } },
        },
      },
    ];
    const result = accumulateUsage(events);
    assert.equal(result.available, true);
    assert.equal(result.input, 400);
    assert.equal(result.output, 150);
    assert.equal(result.cost, 0.004);
    assert.equal(result.model, "p1/m1");
  });

  it("returns available=false when only one session.updated with no messages", () => {
    const events = [
      {
        type: "session.updated",
        properties: {
          sessionID: "ses_x",
          info: { id: "ses_x", tokens: { input: 1000, output: 500 } },
        },
      },
    ];
    const result = accumulateUsage(events);
    assert.equal(result.available, false);
  });

  it("handles session.updated without tokens field gracefully", () => {
    const events = [
      { type: "session.updated", properties: { sessionID: "ses_x", info: { id: "ses_x" } } },
    ];
    const result = accumulateUsage(events);
    assert.equal(result.available, false);
  });

  it("handles message.updated without tokens field gracefully", () => {
    const events = [
      { type: "message.updated", properties: { info: { id: "msg_1", role: "assistant" } } },
    ];
    const result = accumulateUsage(events);
    assert.equal(result.available, false);
  });

  it("uses session delta when messages exist but have zero tokens", () => {
    const events = [
      {
        type: "message.updated",
        properties: {
          info: { id: "msg_1", role: "assistant", modelID: "m1", providerID: "p1", cost: 0, tokens: { input: 0, output: 0 } },
        },
      },
      {
        type: "session.updated",
        properties: {
          sessionID: "ses_x",
          info: { id: "ses_x", tokens: { input: 100, output: 50 }, cost: 0.001, model: { providerID: "p1", id: "m1" } },
        },
      },
      {
        type: "session.updated",
        properties: {
          sessionID: "ses_x",
          info: { id: "ses_x", tokens: { input: 300, output: 120 }, cost: 0.003, model: { providerID: "p1", id: "m1" } },
        },
      },
    ];
    const result = accumulateUsage(events);
    // Messages exist (with zero tokens), so per-message is used (zero tokens).
    assert.equal(result.available, true);
    assert.equal(result.input, 0);
    assert.equal(result.output, 0);
  });
});

// ---------------------------------------------------------------------------
// parseArgs — --brief-file flag
// ---------------------------------------------------------------------------

describe("parseArgs brief-file", () => {
  it("parses --brief-file as a value flag", () => {
    const result = parseArgs(["--brief-file", "/tmp/test-brief.md"]);
    assert.equal(result.flags["brief-file"], "/tmp/test-brief.md");
  });

  it("does not set --brief-file when not provided", () => {
    const result = parseArgs(["some inline text"]);
    assert.equal(result.flags["brief-file"], undefined);
  });

  it("combines --brief-file with other flags", () => {
    const result = parseArgs(["--model", "p/m", "--brief-file", "/tmp/b.md", "--", "text"]);
    assert.equal(result.flags.model, "p/m");
    assert.equal(result.flags["brief-file"], "/tmp/b.md");
    // text after -- is literal; brief-file flag was consumed before --
    assert.equal(result.text, "text");
  });
});

// ---------------------------------------------------------------------------
// loadConfig — config file loading
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  /** @type {string} */
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-loadConfig-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no config file exists", () => {
    const result = loadConfig(tmpDir);
    assert.equal(result, null);
  });

  it("returns parsed config when valid JSON with models.chain exists", () => {
    const config = {
      models: {
        chain: ["opencode-go/deepseek-v4-flash", "opencode-go/deepseek-v4-pro"],
      },
    };
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify(config), "utf8");
    const result = loadConfig(tmpDir);
    assert.deepEqual(result, config);
  });

  it("returns parsed config when valid JSON with models.phases exists", () => {
    const config = {
      models: {
        phases: { implement: ["opencode-go/deepseek-v4-flash"] },
      },
    };
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify(config), "utf8");
    const result = loadConfig(tmpDir);
    assert.deepEqual(result, config);
  });

  it("returns parsed config when models key is absent", () => {
    const config = { unrelated: true };
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify(config), "utf8");
    const result = loadConfig(tmpDir);
    assert.deepEqual(result, config);
  });

  it("throws on malformed JSON (unparseable)", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), "not json at all", "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes(path.join(tmpDir, "config.json")), "error must mention file path");
        assert.ok(err.message.includes("not valid JSON"), "error must mention invalid JSON");
        return true;
      },
    );
  });

  it("throws on null JSON value", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), "null", "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes("must contain a JSON object"));
        return true;
      },
    );
  });

  it("throws on array JSON value", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), "[]", "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes("must contain a JSON object"));
        return true;
      },
    );
  });

  it("throws when models is not an object", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ models: "string" }), "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models" must be a JSON object'));
        return true;
      },
    );
  });

  it("throws when models.chain is not an array of strings", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ models: { chain: "not-array" } }), "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models.chain" must be an array'));
        return true;
      },
    );
  });

  it("throws when models.chain is an empty array (must not silently drop built-in defaults)", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ models: { chain: [] } }), "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models.chain" must not be empty'));
        return true;
      },
    );
  });

  it("throws when a models.phases entry is an empty array", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ models: { phases: { implement: [] } } }),
      "utf8",
    );
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models.phases.implement" must not be empty'));
        return true;
      },
    );
  });

  it("throws when models.phases.phase is not an array of strings", () => {
    fs.writeFileSync(
      path.join(tmpDir, "config.json"),
      JSON.stringify({ models: { phases: { implement: "not-array" } } }),
      "utf8",
    );
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models.phases.implement" must be an array'));
        return true;
      },
    );
  });

  it("throws when models.phases is not an object", () => {
    fs.writeFileSync(path.join(tmpDir, "config.json"), JSON.stringify({ models: { phases: "string" } }), "utf8");
    assert.throws(
      () => loadConfig(tmpDir),
      (err) => {
        assert.ok(err.message.includes('"models.phases" must be a JSON object'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// resolveModel — model resolution precedence
// ---------------------------------------------------------------------------

describe("resolveModel", () => {
  it("returns built-in default chain when no flag and no config", () => {
    const result = resolveModel({ flag: undefined, phase: undefined, config: null });
    assert.ok(result.model, "should resolve a model");
    assert.equal(result.model.providerID, "opencode");
    assert.equal(result.model.modelID, "deepseek-v4-flash-free");
    assert.ok(Array.isArray(result.chain));
    assert.equal(result.chain.length, 3);
    assert.equal(result.chain[0], "opencode/deepseek-v4-flash-free");
  });

  it("uses explicit --model flag over everything", () => {
    const config = {
      models: {
        chain: ["opencode-go/deepseek-v4-flash", "opencode-go/deepseek-v4-pro"],
        phases: { implement: ["anthropic/claude-4"] },
      },
    };
    const result = resolveModel({ flag: "some-provider/some-model", phase: "implement", config });
    assert.equal(result.model.providerID, "some-provider");
    assert.equal(result.model.modelID, "some-model");
  });

  it("uses per-phase chain first entry when phase matches", () => {
    const config = {
      models: {
        chain: ["opencode-go/deepseek-v4-flash", "opencode-go/deepseek-v4-pro"],
        phases: { implement: ["anthropic/claude-4"] },
      },
    };
    const result = resolveModel({ flag: undefined, phase: "implement", config });
    assert.equal(result.model.providerID, "anthropic");
    assert.equal(result.model.modelID, "claude-4");
  });

  it("uses global chain first entry when no phase match", () => {
    const config = {
      models: {
        chain: ["opencode-go/deepseek-v4-flash", "opencode-go/deepseek-v4-pro"],
        phases: { implement: ["anthropic/claude-4"] },
      },
    };
    const result = resolveModel({ flag: undefined, phase: "review", config });
    assert.equal(result.model.providerID, "opencode-go");
    assert.equal(result.model.modelID, "deepseek-v4-flash");
  });

  it("uses global chain first entry when no phases config at all", () => {
    const config = {
      models: {
        chain: ["opencode-go/deepseek-v4-flash", "opencode-go/deepseek-v4-pro"],
      },
    };
    const result = resolveModel({ flag: undefined, phase: "implement", config });
    assert.equal(result.model.providerID, "opencode-go");
    assert.equal(result.model.modelID, "deepseek-v4-flash");
  });

  it("returns full chain from config when present", () => {
    const config = {
      models: {
        chain: ["opencode-go/m1", "opencode-go/m2"],
        phases: { implement: ["opencode-go/m3"] },
      },
    };
    const result = resolveModel({ flag: undefined, phase: "implement", config });
    assert.deepEqual(result.chain, ["opencode-go/m3"]);
  });

  it("returns global chain when no per-phase override", () => {
    const config = {
      models: {
        chain: ["opencode-go/m1", "opencode-go/m2"],
      },
    };
    const result = resolveModel({ flag: undefined, phase: "implement", config });
    assert.deepEqual(result.chain, ["opencode-go/m1", "opencode-go/m2"]);
  });

  it("returns built-in default chain when config has no models.chain", () => {
    const config = { models: { phases: { implement: ["p/m"] } } };
    const result = resolveModel({ flag: undefined, phase: "review", config });
    // No per-phase match for review, no global chain -> built-in
    assert.equal(result.model.providerID, "opencode");
    assert.equal(result.model.modelID, "deepseek-v4-flash-free");
    assert.equal(result.chain.length, 3);
  });

  it("explicit flag + no config still returns built-in chain", () => {
    const result = resolveModel({ flag: "explicit/p", phase: undefined, config: null });
    assert.equal(result.model.providerID, "explicit");
    assert.equal(result.model.modelID, "p");
    // chain should still be the built-in default when no config
    assert.equal(result.chain.length, 3);
    assert.equal(result.chain[0], "opencode/deepseek-v4-flash-free");
  });
});

// ---------------------------------------------------------------------------
// parseModel — variant suffix parsing
// ---------------------------------------------------------------------------

describe("parseModel", () => {
  it("parses provider/model without variant", () => {
    const result = parseModel("opencode-go/deepseek-v4-flash");
    assert.deepEqual(result, { providerID: "opencode-go", modelID: "deepseek-v4-flash" });
  });

  it("parses provider/model:variant suffix", () => {
    const result = parseModel("opencode-go/deepseek-v4-flash:max");
    assert.deepEqual(result, { providerID: "opencode-go", modelID: "deepseek-v4-flash", variant: "max" });
  });

  it("parses :high variant suffix", () => {
    const result = parseModel("p/a:high");
    assert.deepEqual(result, { providerID: "p", modelID: "a", variant: "high" });
  });

  it("throws on trailing colon (empty variant)", () => {
    assert.throws(
      () => parseModel("p/a:"),
      (err) => {
        assert.ok(err.message.includes("empty variant in model entry: p/a:"));
        return true;
      },
    );
  });

  it("throws on missing slash (no provider/model separator)", () => {
    assert.throws(
      () => parseModel("just-a-model"),
      (err) => {
        assert.ok(err.message.includes("--model expects provider/model"));
        return true;
      },
    );
  });

  it("returns undefined for empty value", () => {
    assert.equal(parseModel(""), undefined);
    assert.equal(parseModel(undefined), undefined);
    assert.equal(parseModel(null), undefined);
  });

  it("resolves through resolveModel with variant suffix", () => {
    const result = resolveModel({ flag: "p/a:max", phase: undefined, config: null });
    assert.equal(result.model.providerID, "p");
    assert.equal(result.model.modelID, "a");
    assert.equal(result.model.variant, "max");
  });
});

// ---------------------------------------------------------------------------
// Model variant — API request body boundary
// ---------------------------------------------------------------------------

describe("model variant API body boundary", () => {
  it("prompt_async body includes variant when model has variant", () => {
    const model = parseModel("p/a:max");
    const body = {
      parts: [{ type: "text", text: "test" }],
      ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
      ...(model?.variant ? { variant: model.variant } : {}),
    };
    assert.equal(body.variant, "max");
    assert.equal(body.model.providerID, "p");
    assert.equal(body.model.modelID, "a");
  });

  it("prompt_async body omits variant when model has no variant", () => {
    const model = parseModel("p/a");
    const body = {
      parts: [{ type: "text", text: "test" }],
      ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
      ...(model?.variant ? { variant: model.variant } : {}),
    };
    assert.equal(body.variant, undefined);
    assert.equal(body.model.providerID, "p");
    assert.equal(body.model.modelID, "a");
  });
});

// ---------------------------------------------------------------------------
// Chain round-to-entry mapping — model variant escalation
// ---------------------------------------------------------------------------

describe("chain round model resolution", () => {
  const chain = ["p/a", "p/a:max", "p/b"];

  function resolveRoundModel(round, modelFlag) {
    if (round === 1 && modelFlag) return parseModel(modelFlag);
    const idx = Math.min(round - 1, chain.length - 1);
    return parseModel(chain[idx]);
  }

  it("round 1 uses chain[0] when no --model", () => {
    const result = resolveRoundModel(1, null);
    assert.deepEqual(result, { providerID: "p", modelID: "a" });
  });

  it("round 2 uses chain[1] (:max variant)", () => {
    const result = resolveRoundModel(2, null);
    assert.deepEqual(result, { providerID: "p", modelID: "a", variant: "max" });
  });

  it("round 3 uses chain[2]", () => {
    const result = resolveRoundModel(3, null);
    assert.deepEqual(result, { providerID: "p", modelID: "b" });
  });

  it("rounds beyond chain length clamp to last entry", () => {
    const result = resolveRoundModel(4, null);
    assert.deepEqual(result, { providerID: "p", modelID: "b" });
    const result5 = resolveRoundModel(5, null);
    assert.deepEqual(result5, { providerID: "p", modelID: "b" });
  });

  it("--model overrides round 1 only", () => {
    const result = resolveRoundModel(1, "p/c:high");
    assert.deepEqual(result, { providerID: "p", modelID: "c", variant: "high" });
  });

  it("round 2+ ignores --model and follows chain", () => {
    // Even with --model, round 2 follows the chain
    const result = resolveRoundModel(2, "p/c:high");
    assert.deepEqual(result, { providerID: "p", modelID: "a", variant: "max" });
  });

  it("single-entry chain clamps all rounds to that entry", () => {
    const single = ["p/x"];
    function resolveForRound(n) {
      const idx = Math.min(n - 1, single.length - 1);
      return parseModel(single[idx]);
    }
    assert.deepEqual(resolveForRound(1), { providerID: "p", modelID: "x" });
    assert.deepEqual(resolveForRound(2), { providerID: "p", modelID: "x" });
    assert.deepEqual(resolveForRound(5), { providerID: "p", modelID: "x" });
  });

  it("variant stored in round record is visible", () => {
    // Simulate what cmdChain stores on roundRecord
    const round = 2;
    const idx = Math.min(round - 1, chain.length - 1);
    const entry = chain[idx];
    const roundModel = parseModel(entry);
    const roundModelEntry = (roundModel && roundModel.variant)
      ? roundModel.providerID + "/" + roundModel.modelID + ":" + roundModel.variant
      : (roundModel ? roundModel.providerID + "/" + roundModel.modelID : null);
    const roundRecord = {
      round,
      modelEntry: roundModelEntry,
      modelVariant: roundModel?.variant || null,
    };
    assert.equal(roundRecord.modelEntry, "p/a:max");
    assert.equal(roundRecord.modelVariant, "max");
  });

  it("round without variant has null variant in record", () => {
    const round = 1;
    const idx = Math.min(round - 1, chain.length - 1);
    const entry = chain[idx];
    const roundModel = parseModel(entry);
    const roundRecord = {
      round,
      modelEntry: roundModel ? roundModel.providerID + "/" + roundModel.modelID : null,
      modelVariant: roundModel?.variant || null,
    };
    assert.equal(roundRecord.modelEntry, "p/a");
    assert.equal(roundRecord.modelVariant, null);
  });
});

// ---------------------------------------------------------------------------
// readBriefFile — brief-file runtime error paths
// ---------------------------------------------------------------------------

describe("readBriefFile", () => {
  it("returns inline text when no --brief-file flag", () => {
    const result = readBriefFile({}, "hello world");
    assert.equal(result, "hello world");
  });

  it("throws when --brief-file and inline text are both provided", () => {
    assert.throws(
      () => readBriefFile({ "brief-file": "/tmp/x.md" }, "inline text"),
      /--brief-file and inline text are mutually exclusive/,
    );
  });

  it("throws when --brief-file points to a missing file", () => {
    assert.throws(
      () => readBriefFile({ "brief-file": "/nonexistent/path/brief.md" }, ""),
      (err) => {
        assert.ok(err.message.includes("--brief-file: cannot read"));
        assert.ok(err.message.includes("/nonexistent/path/brief.md"));
        return true;
      },
    );
  });

  it("returns file content when --brief-file points to a valid file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-brief-"));
    try {
      const filePath = path.join(tmpDir, "brief.md");
      fs.writeFileSync(filePath, "file content here", "utf8");
      const result = readBriefFile({ "brief-file": filePath }, "");
      assert.equal(result, "file content here");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// parseArgs -- flag-without-value errors
// ---------------------------------------------------------------------------

describe("parseArgs flag value required", () => {
  it("throws when --brief-file has no value", () => {
    assert.throws(
      () => parseArgs(["--brief-file"]),
      /--brief-file requires a value/,
    );
  });

  it("throws when --brief-file is followed by another flag", () => {
    assert.throws(
      () => parseArgs(["--brief-file", "--model", "p/m"]),
      /--brief-file requires a value/,
    );
  });

  it("throws when --model has no value (same pattern)", () => {
    assert.throws(
      () => parseArgs(["--model"]),
      /--model requires a value/,
    );
  });
});

// ---------------------------------------------------------------------------
// shouldReapServer — pure function: reap decision logic
// ---------------------------------------------------------------------------

describe("shouldReapServer", () => {
  const TTL = 30 * 60 * 1000; // 30 minutes

  it("reap: no running jobs, last activity older than TTL", () => {
    const now = Date.now();
    const serverMtime = now - TTL - 1000; // 1s past TTL
    const jobRecords = [
      { status: "completed", mtime: now - TTL - 2000 },
      { status: "error", mtime: now - TTL - 5000 },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, true);
    assert.match(result.reason, /idle.*exceeds TTL/);
  });

  it("keep: running job exists — never reap regardless of age", () => {
    const now = Date.now();
    const serverMtime = now - TTL * 10; // way past TTL
    const jobRecords = [
      { status: "completed", mtime: now - TTL * 10 },
      { status: "running", mtime: now - 1000 }, // still running
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
    assert.equal(result.reason, "a running job exists");
  });

  it("keep: no running jobs but last activity is still within TTL", () => {
    const now = Date.now();
    const serverMtime = now - TTL + 1000; // 1s before TTL expiry
    const jobRecords = [
      { status: "completed", mtime: now - 1000 },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
    assert.match(result.reason, /not yet stale/);
  });

  it("keep: job mtime is more recent than server mtime and within TTL", () => {
    const now = Date.now();
    const serverMtime = now - TTL - 5000; // past TTL
    const jobRecords = [
      { status: "completed", mtime: now - 1000 }, // recent job → last activity is recent
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
    assert.match(result.reason, /not yet stale/);
  });

  it("reap: empty job records, server mtime alone is past TTL", () => {
    const now = Date.now();
    const serverMtime = now - TTL - 1;
    const jobRecords = [];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, true);
    assert.match(result.reason, /idle.*exceeds TTL/);
  });

  it("keep: empty job records, server mtime alone is within TTL", () => {
    const now = Date.now();
    const serverMtime = now;
    const jobRecords = [];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
    assert.match(result.reason, /not yet stale/);
  });

  it("reap: serverMtime is 0 (missing) but job mtime is past TTL", () => {
    const now = Date.now();
    const serverMtime = 0;
    const jobRecords = [
      { status: "completed", mtime: now - TTL - 1000 },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, true);
  });

  it("keep: serverMtime is 0 but job mtime is within TTL", () => {
    const now = Date.now();
    const serverMtime = 0;
    const jobRecords = [
      { status: "completed", mtime: now },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
  });

  it("reap: all mtimes are 0 (missing timestamps) — epoch-based, very old", () => {
    const now = Date.now();
    const serverMtime = 0;
    const jobRecords = [
      { status: "completed", mtime: 0 },
      { status: "error", mtime: 0 },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    // lastActivity is 0 (epoch), idle is now-epoch = very large → reap
    assert.equal(result.reap, true);
  });

  it("keep: multiple running jobs, even very old, never reap", () => {
    const now = Date.now();
    const serverMtime = 0;
    const jobRecords = [
      { status: "running", mtime: 0 },
      { status: "running", mtime: 0 },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
  });

  it("keep: mixed running and completed jobs — running exists so never reap", () => {
    const now = Date.now();
    const serverMtime = now - TTL * 2;
    const jobRecords = [
      { status: "completed", mtime: now - TTL * 2 },
      { status: "running", mtime: now },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, false);
    assert.equal(result.reason, "a running job exists");
  });

  it("reap: job with status 'stalled' is not 'running', so idle serve is reaped", () => {
    const now = Date.now();
    const serverMtime = now - TTL - 5000;
    const jobRecords = [
      { status: "stalled", mtime: now - TTL - 4000 },
      { status: "timeout", mtime: now - TTL - 3000 },
    ];
    const result = shouldReapServer({ serverMtime, jobRecords, now, ttlMs: TTL });
    assert.equal(result.reap, true);
  });
});


// ---------------------------------------------------------------------------
// cwdSlug — path-to-slug conversion
// ---------------------------------------------------------------------------

describe("cwdSlug", () => {
  it("replaces / and . with -", () => {
    assert.equal(cwdSlug("/home/u/dev/x"), "-home-u-dev-x");
  });

  it("handles a path with dots", () => {
    assert.equal(cwdSlug("/home/u/dev/my.project"), "-home-u-dev-my-project");
  });

  it("handles root path", () => {
    assert.equal(cwdSlug("/"), "-");
  });

  it("handles empty string", () => {
    assert.equal(cwdSlug(""), "");
  });

  it("handles path with trailing slash", () => {
    assert.equal(cwdSlug("/home/user/"), "-home-user-");
  });
});

// ---------------------------------------------------------------------------
// findTranscriptFile — newest *.jsonl in the slug dir
// ---------------------------------------------------------------------------

describe("findTranscriptFile", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-transcript-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the slug dir does not exist", () => {
    const result = findTranscriptFile({ baseDir: tmpDir, cwdSlug: "nonexistent-slug" });
    assert.equal(result, null);
  });

  it("returns null when the slug dir has no .jsonl files", () => {
    const slugDir = path.join(tmpDir, "-home-test");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, "foo.txt"), "not a transcript", "utf8");
    const result = findTranscriptFile({ baseDir: tmpDir, cwdSlug: "-home-test" });
    assert.equal(result, null);
  });

  it("returns the only .jsonl file", () => {
    const slugDir = path.join(tmpDir, "-home-test");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, "transcript.jsonl"), "{}", "utf8");
    const result = findTranscriptFile({ baseDir: tmpDir, cwdSlug: "-home-test" });
    assert.ok(result.endsWith("transcript.jsonl"));
  });

  it("returns the newest .jsonl when multiple exist", () => {
    const slugDir = path.join(tmpDir, "-home-test");
    fs.mkdirSync(slugDir, { recursive: true });
    // Write an older file first
    fs.writeFileSync(path.join(slugDir, "old.jsonl"), "{}", "utf8");
    const oldMtime = Date.now() - 60000;
    fs.utimesSync(path.join(slugDir, "old.jsonl"), new Date(oldMtime / 1000), new Date(oldMtime / 1000));
    // Write a newer file
    fs.writeFileSync(path.join(slugDir, "new.jsonl"), "{}", "utf8");
    const result = findTranscriptFile({ baseDir: tmpDir, cwdSlug: "-home-test" });
    assert.ok(result.endsWith("new.jsonl"), `expected new.jsonl, got ${result}`);
  });

  it("skips subdirectories and non-jsonl files", () => {
    const slugDir = path.join(tmpDir, "-home-test");
    fs.mkdirSync(path.join(slugDir, "subdir"), { recursive: true });
    fs.writeFileSync(path.join(slugDir, "transcript.jsonl"), "{}", "utf8");
    fs.writeFileSync(path.join(slugDir, "notes.txt"), "hello", "utf8");
    const result = findTranscriptFile({ baseDir: tmpDir, cwdSlug: "-home-test" });
    assert.equal(result, path.join(slugDir, "transcript.jsonl"));
  });

  it("uses filename tiebreak when multiple .jsonl files have the same mtime", () => {
    const slugDir = path.join(tmpDir, "-home-tiebreak");
    fs.mkdirSync(slugDir, { recursive: true });
    const sameTime = new Date(Date.now() - 10000);
    const a = path.join(slugDir, "z-first.jsonl");
    const b = path.join(slugDir, "a-second.jsonl");
    fs.writeFileSync(a, "{}", "utf8");
    fs.writeFileSync(b, "{}", "utf8");
    fs.utimesSync(a, sameTime, sameTime);
    fs.utimesSync(b, sameTime, sameTime);
    const result = findTranscriptFile({ baseDir: tmpDir, cwdSlug: "-home-tiebreak" });
    // "a-second.jsonl" sorts before "z-first.jsonl" lexicographically
    assert.ok(result.endsWith("a-second.jsonl"), `expected a-second.jsonl, got ${result}`);
  });
});

// ---------------------------------------------------------------------------
// extractAssistantText — text-block extraction from transcript records
// ---------------------------------------------------------------------------

const makeRecord = (type, blocks) => ({
  type,
  message: { content: blocks },
});

const textBlock = (text) => ({ type: "text", text });
const toolUseBlock = (name, input) => ({ type: "tool_use", name, input });
const toolResultBlock = (text) => ({ type: "tool_result", text });
const thinkingBlock = (text) => ({ type: "thinking", text });

describe("extractAssistantText", () => {
  it("returns empty string for empty records", () => {
    assert.equal(extractAssistantText([]), "");
  });

  it("returns empty string when no assistant records exist", () => {
    const records = [
      makeRecord("user", [textBlock("hello")]),
      makeRecord("user", [textBlock("world")]),
    ];
    assert.equal(extractAssistantText(records), "");
  });

  it("extracts last assistant text block (default lastN=1)", () => {
    const records = [
      makeRecord("user", [textBlock("question 1")]),
      makeRecord("assistant", [textBlock("answer 1")]),
      makeRecord("user", [textBlock("question 2")]),
      makeRecord("assistant", [textBlock("answer 2"), toolUseBlock("bash", {})]),
    ];
    const result = extractAssistantText(records);
    // Should only include the last assistant's text block, skipping tool_use
    assert.equal(result, "answer 2");
  });

  it("excludes tool_use, tool_result, and thinking blocks by default", () => {
    const records = [
      makeRecord("assistant", [
        textBlock("only text"),
        toolUseBlock("bash", { cmd: "ls" }),
        toolResultBlock("file1\nfile2"),
        thinkingBlock("I should list files"),
      ]),
    ];
    const result = extractAssistantText(records);
    assert.equal(result, "only text");
  });

  it("includes tool_result blocks when includeTools is true", () => {
    const records = [
      makeRecord("assistant", [
        textBlock("running ls"),
        toolUseBlock("bash", { cmd: "ls" }),
        toolResultBlock("file1\nfile2"),
        thinkingBlock("done"),
      ]),
    ];
    const result = extractAssistantText(records, { includeTools: true });
    assert.ok(result.includes("running ls"));
    assert.ok(result.includes("file1\nfile2"));
    // tool_use and thinking still excluded
    assert.ok(!result.includes("bash"));
    assert.ok(!result.includes("done"));
  });

  it("skips trailing tool_use-only assistant records (in-progress turn)", () => {
    const records = [
      makeRecord("assistant", [textBlock("the actual last message")]),
      makeRecord("user", [{ type: "tool_result", content: "output" }]),
      makeRecord("assistant", [toolUseBlock("bash", { cmd: "ls" })]),
      makeRecord("assistant", [toolUseBlock("read", { file: "x" })]),
    ];
    assert.equal(extractAssistantText(records), "the actual last message");
  });

  it("reads tool_result payloads in the real transcript shape (content array / string)", () => {
    const records = [
      makeRecord("assistant", [textBlock("checking output")]),
      makeRecord("user", [
        { type: "tool_result", content: [{ type: "text", text: "array shaped" }] },
        { type: "tool_result", content: "string shaped" },
      ]),
    ];
    assert.equal(extractAssistantText(records), "checking output");
    const widened = extractAssistantText(records, { includeTools: true });
    assert.ok(widened.includes("array shaped"));
    assert.ok(widened.includes("string shaped"));
  });

  it("includes multiple assistant messages with --last N", () => {
    const records = [
      makeRecord("user", [textBlock("q1")]),
      makeRecord("assistant", [textBlock("a1")]),
      makeRecord("user", [textBlock("q2")]),
      makeRecord("assistant", [textBlock("a2")]),
    ];
    const result = extractAssistantText(records, { lastN: 2 });
    // Should include both a1 and a2 (and interleaved user messages)
    assert.ok(result.includes("a1"));
    assert.ok(result.includes("a2"));
    // Should also include user messages between them
    assert.ok(result.includes("q2"));
  });

  it("--last N with includeTools widens context to include tool results across N messages", () => {
    const records = [
      makeRecord("assistant", [textBlock("first answer")]),
      makeRecord("user", [textBlock("follow-up")]),
      makeRecord("assistant", [
        textBlock("second answer"),
        toolUseBlock("bash", {}),
        toolResultBlock("output data"),
      ]),
    ];
    const result = extractAssistantText(records, { lastN: 2, includeTools: true });
    assert.ok(result.includes("first answer"));
    assert.ok(result.includes("follow-up"));
    assert.ok(result.includes("second answer"));
    assert.ok(result.includes("output data"));
  });

  it("handles records without message.content gracefully", () => {
    const records = [
      { type: "assistant" },
      { type: "assistant", message: {} },
      { type: "assistant", message: { content: [textBlock("valid")] } },
    ];
    const result = extractAssistantText(records);
    assert.equal(result, "valid");
  });

  it("extracts inline assistant text from typescript fixture records", () => {
    // Simulate a realistic mini transcript
    const records = [
      { type: "user", message: { content: [{ type: "text", text: "hello" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "hi there" }] } },
      { type: "user", message: { content: [{ type: "text", text: "explain this code" }] } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "The code does X." },
            { type: "tool_use", name: "bash", input: {} },
            { type: "tool_result", text: "output" },
          ],
        },
      },
    ];
    // Default: last assistant only, no tools
    const defaultResult = extractAssistantText(records);
    assert.equal(defaultResult, "The code does X.");
    // With includeTools
    const toolsResult = extractAssistantText(records, { includeTools: true });
    assert.ok(toolsResult.includes("The code does X."));
    assert.ok(toolsResult.includes("output"));
    // With --last 2
    const last2 = extractAssistantText(records, { lastN: 2 });
    assert.ok(last2.includes("hi there"));
    assert.ok(last2.includes("explain this code"));
    assert.ok(last2.includes("The code does X."));
  });
});


// ---------------------------------------------------------------------------
// resolveExplainPassage — passage resolution (quote bypass, transcript error)
// ---------------------------------------------------------------------------

describe("resolveExplainPassage", () => {
  let tmpBase;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-explain-"));
  });

  afterEach(() => {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  function writeTranscript(slug, records) {
    const slugDir = path.join(tmpBase, slug);
    fs.mkdirSync(slugDir, { recursive: true });
    const file = path.join(slugDir, "session.jsonl");
    fs.writeFileSync(file, records.map(function (r) { return JSON.stringify(r); }).join("\n"), "utf8");
    return file;
  }

  it("returns the explicit quote and skips transcript resolution", () => {
    const result = resolveExplainPassage({
      baseDir: tmpBase,
      cwd: "/home/user/project",
      quote: "This is an explicit passage.",
      last: 1,
    });
    assert.equal(result.passage, "This is an explicit passage.");
    assert.equal(result.source, "quote");
    // quote works even when there is no transcript dir at all
  });

  it("rejects an empty --quote instead of sending an empty prompt", () => {
    for (const empty of ["", "   "]) {
      assert.throws(
        () => resolveExplainPassage({
          baseDir: tmpBase,
          cwd: "/home/user/project",
          quote: empty,
          last: 1,
        }),
        /--quote must not be empty/,
      );
    }
  });

  it("throws when the slug dir does not exist", () => {
    assert.throws(
      () => resolveExplainPassage({
        baseDir: tmpBase,
        cwd: "/home/nonexistent",
        last: 1,
      }),
      /No Claude Code transcript found/,
    );
  });

  it("throws when the transcript file is malformed JSONL", () => {
    const slugDir = path.join(tmpBase, "-home-bad");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, "bad.jsonl"), "not valid json", "utf8");
    assert.throws(
      () => resolveExplainPassage({
        baseDir: tmpBase,
        cwd: "/home/bad",
        last: 1,
      }),
      /Failed to read transcript/,
    );
  });

  it("throws when the transcript is empty", () => {
    const slugDir = path.join(tmpBase, "-home-empty");
    fs.mkdirSync(slugDir, { recursive: true });
    fs.writeFileSync(path.join(slugDir, "empty.jsonl"), "", "utf8");
    assert.throws(
      () => resolveExplainPassage({
        baseDir: tmpBase,
        cwd: "/home/empty",
        last: 1,
      }),
      /is empty/,
    );
  });

  it("throws when the transcript has no assistant records", () => {
    const records = [
      { type: "user", message: { content: [{ type: "text", text: "hello" }] } },
    ];
    writeTranscript("-home-no-assistant", records);
    assert.throws(
      () => resolveExplainPassage({
        baseDir: tmpBase,
        cwd: "/home/no-assistant",
        last: 1,
      }),
      /No assistant text found/,
    );
  });

  it("extracts the last assistant text passage from a valid transcript", () => {
    const records = [
      { type: "user", message: { content: [{ type: "text", text: "help" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "I can explain this." }] } },
    ];
    writeTranscript("-home-valid", records);
    const result = resolveExplainPassage({
      baseDir: tmpBase,
      cwd: "/home/valid",
      last: 1,
    });
    assert.equal(result.passage, "I can explain this.");
    assert.equal(result.source, "transcript");
  });

  it("passes lastN and includeTools through to extractAssistantText", () => {
    const records = [
      { type: "assistant", message: { content: [
        { type: "text", text: "answer one" },
        { type: "tool_result", text: "tool output" },
      ] } },
    ];
    writeTranscript("-home-tools-test", records);
    const result = resolveExplainPassage({
      baseDir: tmpBase,
      cwd: "/home/tools-test",
      last: 1,
      tools: true,
    });
    assert.equal(result.source, "transcript");
    assert.ok(result.passage.includes("answer one"));
    assert.ok(result.passage.includes("tool output"));
  });

  it("throws on --last 0 (positive integer required)", () => {
    assert.throws(
      () => resolveExplainPassage({ baseDir: tmpBase, cwd: "/tmp/x", last: 0 }),
      /--last must be a positive integer/,
    );
  });

  it("throws on --last -1 (positive integer required)", () => {
    assert.throws(
      () => resolveExplainPassage({ baseDir: tmpBase, cwd: "/tmp/x", last: -1 }),
      /--last must be a positive integer/,
    );
  });

  it("throws on --last NaN (positive integer required)", () => {
    assert.throws(
      () => resolveExplainPassage({ baseDir: tmpBase, cwd: "/tmp/x", last: NaN }),
      /--last must be a positive integer/,
    );
  });

  it("throws on --last 3.5 (non-integer)", () => {
    assert.throws(
      () => resolveExplainPassage({ baseDir: tmpBase, cwd: "/tmp/x", last: 3.5 }),
      /--last must be a positive integer/,
    );
  });

  it("throws on --last Infinity", () => {
    assert.throws(
      () => resolveExplainPassage({ baseDir: tmpBase, cwd: "/tmp/x", last: Infinity }),
      /--last must be a positive integer/,
    );
  });
});

// ---------------------------------------------------------------------------
// parseOrchestratorSignature
// ---------------------------------------------------------------------------

describe("parseOrchestratorSignature", () => {
  it("parses a full signature from the first line", () => {
    const brief = "Orchestrator: claude-fable-5 | session dfbdc7dc | 2026-07-22\n\nDo the thing.";
    const result = parseOrchestratorSignature(brief);
    assert.deepEqual(result, {
      model: "claude-fable-5",
      session: "dfbdc7dc",
      date: "2026-07-22",
    });
  });

  it("parses signature from second line", () => {
    const brief = "# Brief\nOrchestrator: gpt-4 | session abc123 | 2026-01-01\n\nDo stuff";
    const result = parseOrchestratorSignature(brief);
    assert.deepEqual(result, {
      model: "gpt-4",
      session: "abc123",
      date: "2026-01-01",
    });
  });

  it("parses signature from fifth line (last scanned)", () => {
    const brief = "line 1\nline 2\nline 3\nline 4\nOrchestrator: deepseek-v4 | session xyz | 2026-12-31";
    const result = parseOrchestratorSignature(brief);
    assert.deepEqual(result, {
      model: "deepseek-v4",
      session: "xyz",
      date: "2026-12-31",
    });
  });

  it("returns null when signature is beyond first 5 lines", () => {
    const brief = "a\nb\nc\nd\ne\nOrchestrator: claude | session s1 | 2026-01-01";
    const result = parseOrchestratorSignature(brief);
    assert.equal(result, null);
  });

  it("returns null when no signature line exists", () => {
    const brief = "Just a regular brief with no orchestrator line.\nDo the work.";
    const result = parseOrchestratorSignature(brief);
    assert.equal(result, null);
  });

  it("returns null for empty string", () => {
    assert.equal(parseOrchestratorSignature(""), null);
  });

  it("returns null for null/undefined input", () => {
    assert.equal(parseOrchestratorSignature(null), null);
    assert.equal(parseOrchestratorSignature(undefined), null);
  });

  it("handles missing parts gracefully (only model present)", () => {
    const brief = "Orchestrator: claude-fable-5";
    const result = parseOrchestratorSignature(brief);
    assert.deepEqual(result, {
      model: "claude-fable-5",
      session: null,
      date: null,
    });
  });

  it("handles missing session and date", () => {
    const brief = "Orchestrator: claude-fable-5 |  | 2026-07-22";
    const result = parseOrchestratorSignature(brief);
    assert.deepEqual(result, {
      model: "claude-fable-5",
      session: null,
      date: "2026-07-22",
    });
  });

  it("handles malformed separators (no pipes)", () => {
    const brief = "Orchestrator: just a string without pipes";
    const result = parseOrchestratorSignature(brief);
    assert.deepEqual(result, {
      model: "just a string without pipes",
      session: null,
      date: null,
    });
  });

  it("strips 'session ' prefix from the session field", () => {
    const brief = "Orchestrator: claude-4 | session abc-def | 2026-03-15";
    const result = parseOrchestratorSignature(brief);
    assert.deepEqual(result, {
      model: "claude-4",
      session: "abc-def",
      date: "2026-03-15",
    });
  });

  it("never throws on malformed input", () => {
    assert.doesNotThrow(() => parseOrchestratorSignature(null));
    assert.doesNotThrow(() => parseOrchestratorSignature(undefined));
    assert.doesNotThrow(() => parseOrchestratorSignature(42));
    assert.doesNotThrow(() => parseOrchestratorSignature({}));
    assert.doesNotThrow(() => parseOrchestratorSignature(""));
    assert.doesNotThrow(() => parseOrchestratorSignature("Orchestrator:"));
  });
});

// ---------------------------------------------------------------------------
// orchestrator recording (acceptance criteria 1 & 2)
// ---------------------------------------------------------------------------

describe("orchestrator recording", () => {
  it("produces orchestrator data when brief has a signature (criterion 1)", () => {
    const brief = "Orchestrator: claude-fable-5 | session dfbdc7dc | 2026-07-22\n\nImplement the feature.";
    const text = readBriefFile({}, brief);
    const orchestrator = parseOrchestratorSignature(text);
    // Simulate what cmdTask does: store orchestrator on the job record
    const job = {
      id: "job-123",
      kind: "task",
      title: text.slice(0, 80),
      status: "completed",
      orchestrator: orchestrator,
    };
    assert.deepEqual(job.orchestrator, {
      model: "claude-fable-5",
      session: "dfbdc7dc",
      date: "2026-07-22",
    });
  });

  it("produces null orchestrator when brief has no signature (criterion 2)", () => {
    const brief = "Just a normal brief with no orchestrator line.\n\nDo the work.";
    const text = readBriefFile({}, brief);
    const orchestrator = parseOrchestratorSignature(text);
    // Simulate what cmdTask does: orchestrator is null, job has no field or null
    const job = {
      id: "job-456",
      kind: "task",
      title: text.slice(0, 80),
      status: "completed",
      orchestrator: orchestrator,
    };
    assert.equal(job.orchestrator, null);
  });

  it("readBriefFile with --brief-file flag is not needed for inline briefs", () => {
    const brief = "Orchestrator: gpt-4 | session abc123 | 2026-01-01\n\nTask description";
    const text = readBriefFile({}, brief);
    const orchestrator = parseOrchestratorSignature(text);
    assert.deepEqual(orchestrator, {
      model: "gpt-4",
      session: "abc123",
      date: "2026-01-01",
    });
  });
});

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// parseDeliverables — ## Deliverables section parsing
// ---------------------------------------------------------------------------

describe("parseDeliverables", () => {
  it("returns [] for text without ## Deliverables section", () => {
    assert.deepEqual(parseDeliverables("some brief text\n## Other section\ncontent"), []);
  });

  it("returns [] for empty string", () => {
    assert.deepEqual(parseDeliverables(""), []);
  });

  it("returns [] for null/undefined", () => {
    assert.deepEqual(parseDeliverables(null), []);
    assert.deepEqual(parseDeliverables(undefined), []);
  });

  it("parses backtick-quoted paths from bullet list", () => {
    const text = "## Deliverables\n- `plugins/kusabi/scripts/foo.mjs`\n- `docs/DESIGN.md`\n";
    assert.deepEqual(parseDeliverables(text), ["plugins/kusabi/scripts/foo.mjs", "docs/DESIGN.md"]);
  });

  it("stops at next ## heading", () => {
    const text = "## Deliverables\n- `file1.js`\n## Other section\n- `file2.js`\n";
    assert.deepEqual(parseDeliverables(text), ["file1.js"]);
  });

  it("parses bullet without backtick using first token", () => {
    const text = "## Deliverables\n- plugins/kusabi/scripts/foo.mjs\n";
    assert.deepEqual(parseDeliverables(text), ["plugins/kusabi/scripts/foo.mjs"]);
  });

  it("strips trailing punctuation from path", () => {
    const text = "## Deliverables\n- `plugins/kusabi/scripts/foo.mjs` — implement the thing\n";
    assert.deepEqual(parseDeliverables(text), ["plugins/kusabi/scripts/foo.mjs"]);
  });

  it("strips variable trailing punctuation characters", () => {
    const text = "## Deliverables\n- `file.js`; also note:\n- `other.py`: the main one\n";
    assert.deepEqual(parseDeliverables(text), ["file.js", "other.py"]);
  });

  it("ignores empty bullet lines but takes first token from non-empty ones", () => {
    const text = "## Deliverables\n- \n- just text without a backtick path\n";
    // First bullet is empty (skipped). Second has first token "just".
    assert.deepEqual(parseDeliverables(text), ["just"]);
  });

  it("handles * bullets", () => {
    const text = "## Deliverables\n* `file1.js`\n* `file2.js`\n";
    assert.deepEqual(parseDeliverables(text), ["file1.js", "file2.js"]);
  });

  it("handles Deliverables section not at the start of the brief", () => {
    const text = "## Brief\nImplement the thing.\n\n## Deliverables\n- `output.txt`\n";
    assert.deepEqual(parseDeliverables(text), ["output.txt"]);
  });

  it("never throws on any input", () => {
    assert.doesNotThrow(() => parseDeliverables(null));
    assert.doesNotThrow(() => parseDeliverables(undefined));
    assert.doesNotThrow(() => parseDeliverables(42));
    assert.doesNotThrow(() => parseDeliverables({}));
    assert.doesNotThrow(() => parseDeliverables([]));
  });
});

// ---------------------------------------------------------------------------
// parseChangedPaths — git status --porcelain path extraction
// ---------------------------------------------------------------------------

describe("parseChangedPaths", () => {
  it("parses modified paths", () => {
    const output = "M  plugins/kusabi/scripts/foo.mjs\n M docs/DESIGN.md\n";
    const result = parseChangedPaths(output);
    assert.deepEqual(result, ["plugins/kusabi/scripts/foo.mjs", "docs/DESIGN.md"]);
  });

  it("parses untracked files", () => {
    const output = "?? plugins/kusabi/scripts/new-file.mjs\n";
    const result = parseChangedPaths(output);
    assert.deepEqual(result, ["plugins/kusabi/scripts/new-file.mjs"]);
  });

  it("parses rename entries (returns both old and new paths)", () => {
    const output = "R  old.js -> new.js\n";
    const result = parseChangedPaths(output);
    assert.deepEqual(result, ["old.js", "new.js"]);
  });

  it("returns [] for empty output", () => {
    assert.deepEqual(parseChangedPaths(""), []);
  });

  it("returns [] for null/undefined", () => {
    assert.deepEqual(parseChangedPaths(null), []);
    assert.deepEqual(parseChangedPaths(undefined), []);
  });

  it("handles mixed status entries", () => {
    const output = [
      "M  src/index.js",
      "?? src/new.py",
      "R  old.txt -> renamed.txt",
      "MM src/shared.js",
    ].join("\n");
    const result = parseChangedPaths(output);
    assert.deepEqual(result, ["src/index.js", "src/new.py", "old.txt", "renamed.txt", "src/shared.js"]);
  });

  it("strips trailing slash from untracked directory entries", () => {
    assert.deepEqual(parseChangedPaths("?? newdir/\n"), ["newdir"]);
  });

  it("ignores comment lines (starting with #)", () => {
    const output = [
      "# branch.oid abc123",
      "M  src/main.js",
      "# branch.head main",
    ].join("\n");
    const result = parseChangedPaths(output);
    assert.deepEqual(result, ["src/main.js"]);
  });
});

// ---------------------------------------------------------------------------
// checkDeliverablesProbe — P3 probe decision logic
// ---------------------------------------------------------------------------

describe("checkDeliverablesProbe", () => {
  it("passes when no deliverables declared (trivial pass)", () => {
    const result = checkDeliverablesProbe([], ["file.js"]);
    assert.equal(result.passed, true);
    assert.match(result.detail, /no Deliverables declared/);
  });

  it("fails when change set is empty but deliverables are declared", () => {
    const result = checkDeliverablesProbe(["file.js"], []);
    assert.equal(result.passed, false);
    assert.match(result.detail, /work set is empty/);
  });

  it("passes when a declared path exactly matches a changed path", () => {
    const result = checkDeliverablesProbe(
      ["plugins/kusabi/scripts/foo.mjs"],
      ["plugins/kusabi/scripts/foo.mjs", "docs/DESIGN.md"],
    );
    assert.equal(result.passed, true);
    assert.match(result.detail, /touches declared deliverables/);
  });

  it("passes when a declared directory matches changed paths inside it", () => {
    const result = checkDeliverablesProbe(
      ["plugins/kusabi/scripts"],
      ["plugins/kusabi/scripts/kusabi-companion.mjs"],
    );
    assert.equal(result.passed, true);
  });

  it("fails when no declared path is in the change set", () => {
    const result = checkDeliverablesProbe(
      ["plugins/kusabi/scripts/foo.mjs"],
      ["docs/DESIGN.md"],
    );
    assert.equal(result.passed, false);
    assert.match(result.detail, /no declared deliverable touched/);
  });

  it("fails with detail containing both deliverables and changed paths", () => {
    const result = checkDeliverablesProbe(
      ["a.js", "b.js"],
      ["c.js"],
    );
    assert.equal(result.passed, false);
    assert.ok(result.detail.includes("a.js"));
    assert.ok(result.detail.includes("b.js"));
    assert.ok(result.detail.includes("c.js"));
  });

  it("passes when changed path is inside a declared directory (reverse)", () => {
    const result = checkDeliverablesProbe(
      ["plugins/kusabi/scripts/foo.mjs"],
      ["plugins/kusabi"],
    );
    assert.equal(result.passed, true);
  });

  it("probe name is 'P3: deliverables'", () => {
    const result = checkDeliverablesProbe([], []);
    assert.equal(result.probe, "P3: deliverables");
  });

  it("never throws on any input", () => {
    assert.doesNotThrow(() => checkDeliverablesProbe(null, null));
    assert.doesNotThrow(() => checkDeliverablesProbe(undefined, undefined));
    assert.doesNotThrow(() => checkDeliverablesProbe([], null));
    assert.doesNotThrow(() => checkDeliverablesProbe("not-array", "not-array"));
  });
});

// ---------------------------------------------------------------------------
// implementDenyTools — deny map for implement-phase sessions
// ---------------------------------------------------------------------------

describe("implementDenyTools", () => {
  it("returns a plain object", () => {
    const result = implementDenyTools();
    assert.equal(typeof result, "object");
    assert.notEqual(result, null);
    assert.equal(Array.isArray(result), false);
  });

  it("denies bash, edit, write, patch, task", () => {
    const result = implementDenyTools();
    assert.equal(result.bash, false);
    assert.equal(result.edit, false);
    assert.equal(result.write, false);
    assert.equal(result.patch, false);
    assert.equal(result.task, false);
  });

  it("denies sunaba_copy_project and sunaba_copy_file", () => {
    const result = implementDenyTools();
    assert.equal(result.sunaba_copy_project, false);
    assert.equal(result.sunaba_copy_file, false);
  });

  it("contains exactly 7 keys", () => {
    const result = implementDenyTools();
    const keys = Object.keys(result);
    assert.equal(keys.length, 7);
    assert.ok(keys.includes("bash"));
    assert.ok(keys.includes("edit"));
    assert.ok(keys.includes("write"));
    assert.ok(keys.includes("patch"));
    assert.ok(keys.includes("task"));
    assert.ok(keys.includes("sunaba_copy_project"));
    assert.ok(keys.includes("sunaba_copy_file"));
  });

  it("all values are false", () => {
    const result = implementDenyTools();
    const allFalse = Object.values(result).every((v) => v === false);
    assert.equal(allFalse, true);
  });

  it("returns a fresh object on each call", () => {
    const a = implementDenyTools();
    const b = implementDenyTools();
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
  });
});
