// plugins/kusabi/scripts/luna-probe-post-chain.test.mjs — pins criteria 1–5 for kusabi #593:
// read_probe only after an inner chain has finished.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runLunaMission, preflightBatchBudget } from "./luna-driver.mjs";
import { loadCoordinatorSchema, renderCoordinatorContract } from "./luna-prompt.mjs";
import { stubInvestigationSeams } from "./fixtures.mjs";
import { stateDirFor, readJson } from "./state-paths.mjs";

const stream = (...lines) => lines.join("\n") + "\n";
const line = (action, envelope_sha256, extra = {}) =>
  JSON.stringify({ action, envelope_sha256, ...extra });

const VALID_CHAIN_BRIEF = [
  "Orchestrator: gpt-5.6-luna | session test | 2026-09-27",
  "",
  "## Deliverables",
  "",
  "- `deliverable.txt`",
].join("\n");

const MISSION_BRIEF = [
  "Orchestrator: claude-opus-5-5 | session test | 2026-09-27",
  "",
  "## Deliverables",
  "",
  "- `deliverable.txt`",
  "",
  "## Smoke",
  "",
  "- `node --test`",
].join("\n");

const DEFAULT_SEATS = {
  coordinator: { provider: "codex", model: "gpt-5.6-luna" },
  auditor: { provider: "codex", model: "gpt-5.6-sol" },
};

const DEFAULT_BUDGET = {
  maxChains: 3,
  maxAttempts: 2,
  maxProbes: 5,
  maxConsults: 3,
  maxRework: 1,
};

function makeCoordinator(streams) {
  const calls = [];
  return {
    calls,
    dispatch: async (input) => {
      const idx = calls.length;
      calls.push(input);
      const entry = streams[Math.min(idx, streams.length - 1)];
      return typeof entry === "function" ? entry(input) : entry;
    },
  };
}

function makeChainFake() {
  const calls = [];
  return {
    calls,
    run: async (cwd, input, opts) => {
      calls.push({ cwd, input, opts });
      return `Chain ${input?.flags?.["chain-id"] ?? calls.length} completed`;
    },
  };
}

function makeToolFake() {
  const calls = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { status: "ok", output: "fake-tool-output\n" };
    },
  };
}

function makeSolFake() {
  const calls = [];
  return {
    calls,
    dispatch: async (input) => {
      calls.push(input);
      return JSON.stringify({
        type: "verdict",
        schema_version: 2, invariants: [{ id: "INV1", held: true }, { id: "INV2", held: true }, { id: "INV3", held: true }, { id: "INV4", held: true }, { id: "INV5", held: true }], criteria: [],
        gate_id: input.gate.gateId,
        envelope_sha256: input.envelope.envelope_sha256,
        verdict: "clear",
        summary: "clear",
      });
    },
  };
}

describe("luna read_probe post-chain gate (kusabi #593)", () => {
  let cwd;
  let stateDir;
  let missionFile;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-probe-gate-"));
    process.env.KUSABI_HOME = cwd;
    stateDir = stateDirFor(cwd);
    missionFile = path.join(cwd, "MISSION.md");
    fs.writeFileSync(missionFile, MISSION_BRIEF, "utf8");
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    delete process.env.KUSABI_HOME;
  });

  async function runMission(streams, overrides = {}) {
    const coord = makeCoordinator(streams);
    const chain = makeChainFake();
    const tools = makeToolFake();
    const sol = makeSolFake();
    const input = {
      cwd,
      missionFile,
      brief: MISSION_BRIEF,
      container: "test-cid",
      ...DEFAULT_SEATS,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      ...overrides,
      inject: {
        ...stubInvestigationSeams(),
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: chain.run,
        callTool: tools.callTool,
        solDispatch: sol.dispatch,
        ...(overrides.inject ?? {}),
      },
    };
    const result = await runLunaMission(input);
    const match = result.match(/mission (mission-[a-z0-9]+):/);
    const missionId = match ? match[1] : null;
    const missionDir = missionId ? path.join(stateDir, "missions", missionId) : null;
    const record = missionDir ? readJson(path.join(missionDir, "mission.json")) : null;
    return { coord, chain, tools, sol, result, record, missionDir, missionId };
  }

  // -------------------------------------------------------------------------
  // Criterion 1
  // -------------------------------------------------------------------------
  it("criterion 1: a mission whose first stream is only read_probes gets every probe refused with refusal text naming fact sheet and run_chain", async () => {
    const { tools, record } = await runMission([
      (input) => stream(
        line("read_probe", input.envelope.envelope_sha256, { tool: "read_file_range", path: "file1.txt" }),
        line("read_probe", input.envelope.envelope_sha256, { tool: "read_file_range", path: "file2.txt" }),
        line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-escalate" }),
      ),
    ]);

    // callTool is never called
    assert.equal(tools.calls.length, 0, "callTool must never be called for pre-chain probes");
    // record.probes stays empty
    assert.equal(record.probes.length, 0, "record.probes must remain empty");
    // coordinatorErrorsDetails carries the refusal text
    assert.ok(record.coordinatorErrors >= 2, "probes are counted against coordinator error cap");
    const details = (record.coordinatorErrorsDetails ?? []).map((d) => d.detail);
    assert.equal(details.length, 2, "both probes must be recorded as coordinator errors");
    for (const detail of details) {
      assert.ok(
        detail.startsWith("read_probe refused: no inner chain has finished in this mission"),
        `detail must start with prefix: got "${detail}"`,
      );
      assert.ok(
        detail.includes("use the fact sheet in the evidence envelope, or run_chain"),
        `detail must name the alternatives: got "${detail}"`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // Criterion 2
  // -------------------------------------------------------------------------
  it("criterion 2: batch [read_probe, run_chain, read_probe] on fresh mission refuses first probe, runs chain, executes second probe", async () => {
    const { tools, chain, record } = await runMission([
      (input) => stream(
        line("read_probe", input.envelope.envelope_sha256, { tool: "read_file_range", path: "pre-chain.txt" }),
        line("run_chain", input.envelope.envelope_sha256, { brief: VALID_CHAIN_BRIEF }),
        line("read_probe", input.envelope.envelope_sha256, { tool: "read_file_range", path: "post-chain.txt" }),
        line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-escalate" }),
      ),
    ]);

    // Chain ran
    assert.equal(chain.calls.length, 1, "run_chain must run");
    // Only the second probe reached callTool
    assert.equal(tools.calls.length, 1, "exactly one probe must reach callTool (the post-chain one)");
    assert.equal(tools.calls[0].args.file_path, "post-chain.txt");

    // Only the second probe recorded in record.probes
    assert.equal(record.probes.length, 1, "exactly one probe recorded in record.probes");
    assert.equal(record.probes[0].path, "post-chain.txt");

    // First probe was refused and recorded as coordinator error
    assert.equal(record.coordinatorErrors, 1);
    assert.ok(
      record.coordinatorErrorsDetails[0].detail.startsWith(
        "read_probe refused: no inner chain has finished in this mission",
      ),
    );
  });

  // -------------------------------------------------------------------------
  // Criterion 3
  // -------------------------------------------------------------------------
  it("criterion 3: after one finished chain, a later stream's read_probe executes within maxProbes exactly as today", async () => {
    const { tools, chain, record } = await runMission([
      // stream 1: chain attempt finishes
      (input) => stream(
        line("run_chain", input.envelope.envelope_sha256, { brief: VALID_CHAIN_BRIEF }),
      ),
      // stream 2: probe follows the finished chain
      (input) => stream(
        line("read_probe", input.envelope.envelope_sha256, { tool: "read_file_range", path: "target.txt" }),
        line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-accept" }),
      ),
    ]);

    assert.equal(chain.calls.length, 1, "inner chain executed");
    assert.equal(tools.calls.length, 1, "probe executed through callTool");
    assert.equal(tools.calls[0].args.file_path, "target.txt");
    assert.equal(record.probes.length, 1, "probe recorded");
    assert.equal(record.coordinatorErrors, 0, "no coordinator errors");
    assert.equal(record.disposition, "recommend-accept");
  });

  // -------------------------------------------------------------------------
  // Criterion 4
  // -------------------------------------------------------------------------
  it("criterion 4: preflight excludes pre-chain probes so 6 pre-chain probes are refused by gate not budget-exhausted; 6 post-chain probes are refused by preflight", async () => {
    // Part A: direct preflightBatchBudget check
    const batch6Probes = Array.from({ length: 6 }, (_, i) => ({
      action: "read_probe",
      tool: "read_file_range",
      path: `p${i}.txt`,
    }));

    // Fresh mission (zero finished chains): demand is 0, passes preflight
    const freshRecord = { probes: [], attempts: [], chains: [], consults: [] };
    const preflightFresh = preflightBatchBudget(batch6Probes, freshRecord, { maxProbes: 5 });
    assert.equal(preflightFresh.ok, true, "preflight must exclude pre-chain probes when zero finished chains exist");

    // Finished mission (at least one finished chain): demand is 6, refused by preflight
    const postChainRecord = { probes: [], attempts: [], chains: ["chain-1"], consults: [] };
    const preflightPostChain = preflightBatchBudget(batch6Probes, postChainRecord, { maxProbes: 5 });
    assert.equal(preflightPostChain.ok, false, "preflight must count probes when a finished chain exists");
    assert.equal(preflightPostChain.dimension, "probe");

    // Part B: end-to-end driver check
    // Fresh mission with 6 pre-chain read_probes and maxProbes: 5
    // Must NOT terminate budget-exhausted. Probes are refused by the gate instead.
    const { tools, record } = await runMission(
      [
        (input) => stream(
          ...Array.from({ length: 6 }, (_, i) =>
            line("read_probe", input.envelope.envelope_sha256, { tool: "read_file_range", path: `p${i}.txt` }),
          ),
        ),
      ],
      { budget: { ...DEFAULT_BUDGET, maxProbes: 5 } },
    );
    assert.notEqual(record.disposition, "budget-exhausted", "must NOT be refused as budget-exhausted");
    assert.equal(tools.calls.length, 0, "callTool never called");
    assert.equal(record.probes.length, 0, "no probes recorded");
    assert.ok(record.coordinatorErrors >= 1, "probes refused by gate count as coordinator errors");

    // End-to-end after a finished chain: 6 read_probes ARE refused as budget-exhausted by preflight
    const { record: recordPost } = await runMission(
      [
        // dispatch 0: run chain
        (input) => stream(
          line("run_chain", input.envelope.envelope_sha256, { brief: VALID_CHAIN_BRIEF }),
        ),
        // dispatch 1: 6 probes after finished chain
        (input) => stream(
          ...Array.from({ length: 6 }, (_, i) =>
            line("read_probe", input.envelope.envelope_sha256, { tool: "read_file_range", path: `p${i}.txt` }),
          ),
        ),
      ],
      { budget: { ...DEFAULT_BUDGET, maxProbes: 5 } },
    );
    assert.equal(recordPost.disposition, "budget-exhausted", "post-chain 6 probes must be refused by preflight as budget-exhausted");
    assert.match(recordPost.terminationReason, /probe/i);
  });

  // -------------------------------------------------------------------------
  // Criterion 5
  // -------------------------------------------------------------------------
  it("criterion 5: rendered coordinator contract contains purpose text from schema, and fails if renderer and schema diverge", () => {
    const schema = loadCoordinatorSchema();
    const rendered = renderCoordinatorContract(schema);
    const purpose = schema.actions.properties.read_probe.description;
    assert.ok(
      typeof purpose === "string" && purpose.length > 0,
      "schema must contain read_probe description",
    );
    assert.ok(
      rendered.includes(purpose),
      "rendered contract must state the read_probe purpose verbatim from the schema",
    );
    assert.match(
      rendered,
      /verify a specific claim from a finished chain against the container/i,
      "purpose text must state verification of finished chain claim",
    );
    assert.match(
      rendered,
      /not allowed before any inner chain has finished/i,
      "purpose text must state not allowed before inner chain finished",
    );
    assert.match(
      rendered,
      /use the fact sheet or run_chain/i,
      "purpose text must name fact sheet and run_chain alternatives",
    );

    // Schema/renderer divergence check: modifying the schema description must reflect in the rendered contract
    const customSchema = JSON.parse(JSON.stringify(schema));
    const testPurpose = "Custom read_probe purpose: verify only after finished chain (schema divergence test).";
    customSchema.actions.properties.read_probe.description = testPurpose;
    const customRendered = renderCoordinatorContract(customSchema);
    assert.ok(
      customRendered.includes(testPurpose),
      "rendered contract must derive purpose from schema (divergence detected if hand-written)",
    );
    assert.ok(
      !customRendered.includes(purpose),
      "custom rendered contract must not include the old purpose",
    );
  });
});
