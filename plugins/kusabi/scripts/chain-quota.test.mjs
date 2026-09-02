import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyDispatchQuotaExhaustion,
  quotaExhaustionReason,
} from "./chain-quota.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

// =========================================================================
// Source guards for kusabi #453
// =========================================================================

describe("chain-quota source guards (kusabi #453)", () => {
  it("chain-phases.mjs does not export moved quota functions", () => {
    const chainPhasesSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-phases.mjs"), "utf8");
    assert.ok(!chainPhasesSrc.includes("export function classifyDispatchQuotaExhaustion("));
    assert.ok(!chainPhasesSrc.includes("export function quotaExhaustionReason("));
    assert.ok(!chainPhasesSrc.includes("export function quotaReplacementRefusal("));
    assert.ok(!chainPhasesSrc.includes("export function recordQuotaExhaustion("));
    assert.ok(!chainPhasesSrc.includes("export function explicitRouteDiffersFromRecord("));
  });

  it("chain-phases.mjs does not import chain-quota.mjs", () => {
    const chainPhasesSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-phases.mjs"), "utf8");
    assert.ok(!chainPhasesSrc.includes('from "./chain-quota.mjs"'));
    assert.ok(!chainPhasesSrc.includes("from './chain-quota.mjs'"));
  });

  it("chain-quota.mjs does not import chain-phases.mjs", () => {
    const chainQuotaSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-quota.mjs"), "utf8");
    assert.ok(!chainQuotaSrc.includes('from "./chain-phases.mjs"'));
    assert.ok(!chainQuotaSrc.includes("from './chain-phases.mjs'"));
  });
});

// =========================================================================
// classifyDispatchQuotaExhaustion (kusabi #373)
// =========================================================================

describe("classifyDispatchQuotaExhaustion", () => {
  it("classifies the observed agy individual-quota phrase and extracts the reset", () => {
    const text = 'agy dispatch failed: agy returned no payload {"status":"ERROR","response":"","error":"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h1m21s."}';
    const failure = classifyDispatchQuotaExhaustion(text);
    assert.equal(failure.kind, "quota-exhaustion");
    assert.equal(failure.backend, "agy");
    assert.equal(failure.quota, "individual");
    assert.equal(failure.backendBlocked, true);
    assert.equal(failure.reset, "1h1m21s");
    assert.match(quotaExhaustionReason(failure), /quota exhausted \(agy individual pool\)/);
    assert.match(quotaExhaustionReason(failure), /resets in 1h1m21s/);
    assert.doesNotMatch(quotaExhaustionReason(failure), /unparseable/);
  });

  it("classifies the observed opencode free-tier phrase", () => {
    const failure = classifyDispatchQuotaExhaustion("Free usage exceeded, subscribe to Go");
    assert.equal(failure.kind, "quota-exhaustion");
    assert.equal(failure.backend, "opencode");
    assert.equal(failure.quota, "free-tier");
    assert.equal(failure.reset, null);
    assert.match(quotaExhaustionReason(failure), /opencode free-tier pool/);
  });

  it("does not classify unrelated dispatch failures, including a claude session-limit string", () => {
    assert.equal(classifyDispatchQuotaExhaustion(null), null);
    assert.equal(classifyDispatchQuotaExhaustion(""), null);
    assert.equal(classifyDispatchQuotaExhaustion("claude dispatch failed: session limit"), null);
    assert.equal(classifyDispatchQuotaExhaustion("All routes exhausted"), null);
    assert.equal(classifyDispatchQuotaExhaustion("quota reached"), null);
  });
});
