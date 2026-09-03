import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runStrategizePhase,
} from "./chain-strategize.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

// =========================================================================
// Source guards for kusabi #455
// =========================================================================

describe("chain-strategize source guards (kusabi #455)", () => {
  it("chain-phases.mjs does not export runStrategizePhase", () => {
    const chainPhasesSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-phases.mjs"), "utf8");
    assert.ok(!chainPhasesSrc.includes("export async function runStrategizePhase("));
    assert.ok(!chainPhasesSrc.includes("export { runStrategizePhase"));
  });

  it("chain-phases.mjs does not import chain-strategize.mjs", () => {
    const chainPhasesSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-phases.mjs"), "utf8");
    assert.ok(!chainPhasesSrc.includes('from "./chain-strategize.mjs"'));
    assert.ok(!chainPhasesSrc.includes("from './chain-strategize.mjs'"));
  });

  it("chain-strategize.mjs does not import chain-phases.mjs", () => {
    const chainStrategizeSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-strategize.mjs"), "utf8");
    assert.ok(!chainStrategizeSrc.includes('from "./chain-phases.mjs"'));
    assert.ok(!chainStrategizeSrc.includes("from './chain-phases.mjs'"));
  });
});

// =========================================================================
// phase functions carry the failure classification (kusabi #215)
// =========================================================================

describe("phase functions carry the failure classification (kusabi #215)", () => {
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

  it("runStrategizePhase returns strategistJobFailure from the failed job's record", async () => {
    const result = await runStrategizePhase({
      cwd: "/tmp", chainId: "chain-test", round: 1, brief: "brief",
      previousRecord: null, roundRecord: { round: 1 }, modelChain: [["opus"]],
      _dispatchWithFallback: failingDispatch("provider-error", QUOTA_FAILURE),
    });
    assert.equal(result.strategistJobStatus, "provider-error");
    assert.deepEqual(result.strategistJobFailure, QUOTA_FAILURE);
  });
});

// =========================================================================
// runStrategizePhase — stubbed dispatch route recording
// =========================================================================

describe("runStrategizePhase — stubbed dispatch route recording", () => {
  it("records strategistModelEntry and strategistModelVariant on the roundRecord", async () => {
    function stubbedDispatch() {
      return {
        job: {
          id: "strat-job-1",
          status: "completed",
          modelEntry: "test-org/test-strategist-model:max",
          modelVariant: "max",
          fallbacks: null,
          usage: null,
          error: null,
        },
        resultText: "Switch to a Map data structure",
      };
    }

    const roundRecord = { round: 1 };

    await runStrategizePhase({
      cwd: process.cwd(),
      chainId: "test-chain",
      round: 1,
      brief: "test brief",
      previousRecord: null,
      roundRecord,
      modelChain: ["test-org/test-flash", "test-org/test-pro"],
      _dispatchWithFallback: stubbedDispatch,
    });

    assert.equal(roundRecord.strategistModelEntry, "test-org/test-strategist-model:max");
    assert.equal(roundRecord.strategistModelVariant, "max");
    assert.equal(roundRecord.strategistFallbacks, null);
  });
});
