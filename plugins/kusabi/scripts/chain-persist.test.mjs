import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeChainTotals,
  persistChainState,
  writeReviewRecord,
} from "./chain-persist.mjs";
import { readJson } from "./state-paths.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// =========================================================================
// Source guards (kusabi #451)
// =========================================================================

describe("chain-persist source guards (kusabi #451)", () => {
  it("chain-phases.mjs does not export moved persist functions", () => {
    const chainPhasesSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-phases.mjs"), "utf8");
    assert.ok(!chainPhasesSrc.includes("export function computeChainTotals("));
    assert.ok(!chainPhasesSrc.includes("export function persistChainState("));
    assert.ok(!chainPhasesSrc.includes("export function writeReviewRecord("));
  });

  it("chain-phases.mjs does not import chain-persist.mjs", () => {
    const chainPhasesSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-phases.mjs"), "utf8");
    assert.ok(!chainPhasesSrc.includes('from "./chain-persist.mjs"'));
    assert.ok(!chainPhasesSrc.includes("from './chain-persist.mjs'"));
  });

  it("chain-persist.mjs does not import chain-phases.mjs", () => {
    const chainPersistSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-persist.mjs"), "utf8");
    assert.ok(!chainPersistSrc.includes('from "./chain-phases.mjs"'));
    assert.ok(!chainPersistSrc.includes("from './chain-phases.mjs'"));
  });
});

// =========================================================================
// computeChainTotals — chain-wide usage totals from all round records
// =========================================================================

describe("computeChainTotals", () => {
  it("returns zero totals for empty records", () => {
    const result = computeChainTotals([]);
    assert.deepEqual(result, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  });

  it("sums implement usage across a single record", () => {
    const rec = {
      implementUsage: { available: true, input: 100, output: 200, reasoning: 30, cacheRead: 50, cacheWrite: 10, cost: 0.001 },
    };
    const result = computeChainTotals([rec]);
    assert.equal(result.input, 100);
    assert.equal(result.output, 200);
    assert.equal(result.reasoning, 30);
    assert.equal(result.cacheRead, 50);
    assert.equal(result.cacheWrite, 10);
    assert.equal(result.cost, 0.001);
  });

  it("sums implement + review usage across multiple records", () => {
    const records = [
      {
        implementUsage: { available: true, input: 50, output: 60, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
        reviewUsage: { available: true, input: 30, output: 40, reasoning: 10, cacheRead: 20, cacheWrite: 0, cost: 0.002 },
      },
      {
        implementUsage: { available: true, input: 70, output: 80, reasoning: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
        // review was skipped (no reviewUsage field)
      },
    ];
    const result = computeChainTotals(records);
    assert.equal(result.input, 150);   // 50+30+70
    assert.equal(result.output, 180);  // 60+40+80
    assert.equal(result.reasoning, 15); // 0+10+5
    assert.equal(result.cacheRead, 20); // 0+20+0
    assert.equal(result.cacheWrite, 0);
    assert.equal(result.cost, 0.004);  // 0.001+0.002+0.001
  });

  it("skips usage entries where available is false", () => {
    const records = [{
      implementUsage: { available: false, input: 999, output: 999 },
      reviewUsage: { available: true, input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
    }];
    const result = computeChainTotals(records);
    assert.equal(result.input, 10);
    assert.equal(result.output, 20);
  });

  it("includes reviewFirstUsage from retried rounds", () => {
    const records = [{
      implementUsage: { available: true, input: 50, output: 60, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
      reviewUsage: { available: true, input: 30, output: 40, reasoning: 10, cacheRead: 20, cacheWrite: 0, cost: 0.002 },
      reviewFirstUsage: { available: true, input: 5, output: 6, reasoning: 1, cacheRead: 2, cacheWrite: 0, cost: 0.0005 },
    }];
    const result = computeChainTotals(records);
    assert.equal(result.input, 85);    // 50+30+5
    assert.equal(result.output, 106);  // 60+40+6
    assert.equal(result.reasoning, 11); // 0+10+1
    assert.equal(result.cacheRead, 22); // 0+20+2
    assert.equal(result.cacheWrite, 0);
    assert.equal(result.cost, 0.0035); // 0.001+0.002+0.0005
  });

  it("handles missing usage fields as zeros", () => {
    const records = [
      { implementUsage: { available: true, input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001 } },
      {}, // no usage fields at all
    ];
    const result = computeChainTotals([records[0]]);
    assert.equal(result.input, 10);
    assert.equal(result.output, 20);
  });
});

// =========================================================================
// persistChainState — interrupted-round persistence (kusabi #153①)
// =========================================================================

describe("persistChainState interrupted round", () => {
  function makeChainDir() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-persist-"));
    return path.join(tmp, "chain-test");
  }

  const chainCtx = {
    chainId: "chain-test",
    container: "cid-1",
    model: "fake/model",
    modelChain: [["fake/model"]],
    maxRounds: 4,
    brief: "Implement X.",
    orchestrator: null,
    baseSha: "abc123",
    strategized: false,
    chainFollowupDraft: null,
  };

  it("marks the record interrupted and writes it into chain.json records (stop-after-probes path)", () => {
    const chainDir = makeChainDir();
    fs.mkdirSync(chainDir, { recursive: true });
    const roundRecord = {
      round: 3, implementJobId: "job-3", verdict: null,
      probesGreen: true, tierBefore: 0, reworkCount: 2,
    };
    const records = [];
    persistChainState({
      chainDir, round: 3, roundRecord, records,
      chainTotals: computeChainTotals([roundRecord]),
      ...chainCtx,
      interrupted: true,
    });

    assert.equal(roundRecord.interrupted, true);
    assert.equal(roundRecord.interruptedAfter, "probes");

    const written = readJson(path.join(chainDir, "round-3.json"));
    assert.equal(written.interrupted, true);
    assert.equal(written.interruptedAfter, "probes");

    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.records.length, 1);
    assert.equal(chainJson.records[0].round, 3);
    assert.equal(chainJson.records[0].implementJobId, "job-3");
    assert.equal(chainJson.records[0].interrupted, true);
  });

  it("does not mark the record when interrupted is not requested", () => {
    const chainDir = makeChainDir();
    fs.mkdirSync(chainDir, { recursive: true });
    const roundRecord = { round: 1, implementJobId: "job-1" };
    persistChainState({
      chainDir, round: 1, roundRecord, records: [roundRecord],
      chainTotals: computeChainTotals([roundRecord]),
      ...chainCtx,
    });
    assert.equal(roundRecord.interrupted, undefined);
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.records.length, 1);
  });

  it("does not duplicate a record that is already in records (review-resume path)", () => {
    const chainDir = makeChainDir();
    fs.mkdirSync(chainDir, { recursive: true });
    const roundRecord = { round: 3, implementJobId: "job-3" };
    const records = [roundRecord]; // already pushed at stop time
    persistChainState({
      chainDir, round: 3, roundRecord, records,
      chainTotals: computeChainTotals(records),
      ...chainCtx,
    });
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.records.length, 1);
  });

  it("persists the chain-start verify baseline into chain.json (kusabi #173)", () => {
    const chainDir = makeChainDir();
    fs.mkdirSync(chainDir, { recursive: true });
    const roundRecord = { round: 1, implementJobId: "job-1" };
    const verifyBaseline = {
      captured: true,
      gate_passed: false,
      lint: 190,
      types: 0,
      raw: { gate_passed: false, lint: [{ rule: "x" }], types: [] },
    };
    persistChainState({
      chainDir, round: 1, roundRecord, records: [roundRecord],
      chainTotals: computeChainTotals([roundRecord]),
      ...chainCtx,
      verifyBaseline,
    });
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.deepEqual(chainJson.verifyBaseline, verifyBaseline);
  });

  it("defaults chain.json verifyBaseline to null when not recorded", () => {
    const chainDir = makeChainDir();
    fs.mkdirSync(chainDir, { recursive: true });
    const roundRecord = { round: 1, implementJobId: "job-1" };
    persistChainState({
      chainDir, round: 1, roundRecord, records: [roundRecord],
      chainTotals: computeChainTotals([roundRecord]),
      ...chainCtx,
    });
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.verifyBaseline, null);
  });

  it("persists the review-phase model and chain for chain-resume (kusabi #192)", () => {
    const chainDir = makeChainDir();
    fs.mkdirSync(chainDir, { recursive: true });
    const roundRecord = { round: 1, implementJobId: "job-1" };
    persistChainState({
      chainDir, round: 1, roundRecord, records: [roundRecord],
      chainTotals: computeChainTotals([roundRecord]),
      ...chainCtx,
      reviewModel: "opus",
      reviewModelChain: [["opus"]],
    });
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.reviewModel, "opus");
    assert.deepEqual(chainJson.reviewModelChain, [["opus"]]);
  });

  it("defaults chain.json review fields to null when not given (pre-#192 chains)", () => {
    const chainDir = makeChainDir();
    fs.mkdirSync(chainDir, { recursive: true });
    const roundRecord = { round: 1, implementJobId: "job-1" };
    persistChainState({
      chainDir, round: 1, roundRecord, records: [roundRecord],
      chainTotals: computeChainTotals([roundRecord]),
      ...chainCtx,
    });
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.reviewModel, null);
    assert.equal(chainJson.reviewModelChain, null);
  });

  it("persists the rework-phase model, chain and backend for chain-resume (kusabi #192 axis 2)", () => {
    const chainDir = makeChainDir();
    fs.mkdirSync(chainDir, { recursive: true });
    const roundRecord = { round: 1, implementJobId: "job-1" };
    persistChainState({
      chainDir, round: 1, roundRecord, records: [roundRecord],
      chainTotals: computeChainTotals([roundRecord]),
      ...chainCtx,
      reworkModel: "deepseek-v4-flash",
      reworkModelChain: [["opencode-go/deepseek-v4-flash"]],
      reworkBackend: "opencode",
    });
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.reworkModel, "deepseek-v4-flash");
    assert.deepEqual(chainJson.reworkModelChain, [["opencode-go/deepseek-v4-flash"]]);
    assert.equal(chainJson.reworkBackend, "opencode");
  });

  it("defaults chain.json rework fields to null when not given (no models.phases.rework key)", () => {
    const chainDir = makeChainDir();
    fs.mkdirSync(chainDir, { recursive: true });
    const roundRecord = { round: 1, implementJobId: "job-1" };
    persistChainState({
      chainDir, round: 1, roundRecord, records: [roundRecord],
      chainTotals: computeChainTotals([roundRecord]),
      ...chainCtx,
    });
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    assert.equal(chainJson.reworkModel, null);
    assert.equal(chainJson.reworkModelChain, null);
    assert.equal(chainJson.reworkBackend, null);
  });
});

// =========================================================================
// writeReviewRecord — postable review record at a terminal disposition
// (kusabi #52)
// =========================================================================

describe("writeReviewRecord", () => {
  function makeChainDir() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-review-record-"));
    const chainDir = path.join(tmp, "chains", "chain-1");
    fs.mkdirSync(chainDir, { recursive: true });
    return chainDir;
  }

  const records = [
    {
      round: 1,
      modelEntry: "flash/quick",
      verdict: "approve",
      disposition: { disposition: "accept" },
      worktreeChanged: true,
      probeResults: [{ probe: "P1: HEAD clean", passed: true, detail: "HEAD matches base abc123" }],
      findings: [{ severity: "high", title: "Null pointer", file: "src/x.js", line_start: 42 }],
    },
  ];

  it("writes review-record.md with the rendered markdown and returns its path", () => {
    const chainDir = makeChainDir();
    const recordPath = writeReviewRecord({
      chainDir,
      chainId: "chain-1",
      container: "cid-1",
      label: "repo",
      modelChain: [["flash/quick"]],
      maxRounds: 4,
      brief: "Implement X.",
      orchestrator: null,
      records,
      disposition: { disposition: "accepted", round: 1 },
      round: 1,
      finishedAt: "2026-08-08T00:00:00.000Z",
    });

    assert.equal(recordPath, path.join(chainDir, "review-record.md"));
    assert.ok(fs.existsSync(recordPath));

    const text = fs.readFileSync(recordPath, "utf8");
    assert.match(text, /# \[review-record\] repo chain-1 — Implement X\./);
    assert.match(text, /Final disposition: accepted at round 1 of 4/);
    assert.match(text, /Round 1 — model: flash\/quick, verdict: approve \(parsed\), disposition: accept, changed: yes/);
    assert.match(text, /- \[high\] Null pointer \(src\/x\.js:42\)/);
    assert.match(text, /\| 1 \| high \| Null pointer \(src\/x\.js:42\) \| _fill_ \| _fill_ \|/);
    assert.match(text, /## 判例として \(fill at inspection\)/);
    // Usage comes from the chain's existing chainTotals (zero here — nothing
    // recomputed from records).
    assert.match(text, /input=0 output=0 reasoning=0 cacheRead=0 cacheWrite=0 cost=\$0/);
  });

  it("uses the given chainTotals verbatim instead of recomputing from rounds", () => {
    const chainDir = makeChainDir();
    writeReviewRecord({
      chainDir,
      chainId: "chain-1",
      container: "cid-1",
      records,
      disposition: { disposition: "escalated", round: 1 },
      round: 1,
      chainTotals: { input: 7, output: 5, reasoning: 1, cacheRead: 20, cacheWrite: 2, cost: 0.11 },
      finishedAt: "2026-08-08T00:00:00.000Z",
    });
    const text = fs.readFileSync(path.join(chainDir, "review-record.md"), "utf8");
    assert.match(text, /input=7 output=5 reasoning=1 cacheRead=20 cacheWrite=2 cost=\$0\.11/);
    // The escalate reason flows into the record when given.
    assert.match(text, /Final disposition: escalated at round 1 of \?/);
  });

  it("regeneration overwrites the previous record", () => {
    const chainDir = makeChainDir();
    writeReviewRecord({
      chainDir,
      chainId: "chain-1",
      container: "cid-1",
      records,
      disposition: { disposition: "accepted", round: 1 },
      round: 1,
      finishedAt: "2026-08-08T00:00:00.000Z",
    });
    writeReviewRecord({
      chainDir,
      chainId: "chain-1",
      container: "cid-1",
      records,
      disposition: { disposition: "accepted", round: 2 },
      round: 2,
      brief: "Second brief.",
      finishedAt: "2026-08-08T01:00:00.000Z",
    });
    const text = fs.readFileSync(path.join(chainDir, "review-record.md"), "utf8");
    assert.match(text, /Final disposition: accepted at round 2 of \?/);
    assert.match(text, /Second brief\./);
    assert.doesNotMatch(text, /Final disposition: accepted at round 1/);
  });
});
