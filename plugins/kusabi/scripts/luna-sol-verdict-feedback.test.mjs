// luna-sol-verdict-feedback.test.mjs — tests for Sol rework verdict feedback
// reaching the Luna coordinator (kusabi #586 criteria 1-6).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { stateDirFor, readJson, writeJson } from "./state-paths.mjs";
import { runLunaMission } from "./luna-driver.mjs";
import { stubInvestigationSeams } from "./fixtures.mjs";
import {
  renderPendingSolRework,
  driverLedgerText,
  missionLedgerText,
  SOL_REWORK_INSTRUCTION,
} from "./luna-sol-gate.mjs";

const MISSION_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-rework-test | 2026-09-27",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-driver.mjs` — the #530 mission driver.",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-sol-verdict-feedback.test.mjs`",
].join("\n");

const VALID_CHAIN_BRIEF = [
  "Orchestrator: gpt-5.6-luna | session inner | 2026-09-27",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-wait.mjs` — the #530 wait surface.",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-wait.test.mjs`",
].join("\n");

const DEFAULT_SEATS = {
  coordinator: { provider: "codex", model: "gpt-5.6-luna" },
  auditor: { provider: "codex", model: "gpt-5.6-sol" },
};

const DEFAULT_BUDGET = {
  maxChains: 3,
  maxAttempts: 3,
  maxProbes: 5,
  maxConsults: 3,
  maxRework: 2,
};

function j(obj) {
  return JSON.stringify(obj);
}

function line(action, hash, body = {}) {
  return j({ action, envelope_sha256: hash, ...body });
}

function stream(...lines) {
  return lines.join("\n");
}

function makeCoordinator(streams) {
  const calls = [];
  return {
    calls,
    dispatch: async (input) => {
      const idx = calls.length;
      const ledgerText = fs.readFileSync(path.join(input.missionDir, "evidence", "mission-ledger.txt"), "utf8");
      calls.push({
        ...input,
        ledger: JSON.parse(ledgerText),
        ledgerText,
      });
      const entry = streams[Math.min(idx, streams.length - 1)];
      return typeof entry === "function" ? entry(input) : entry;
    },
  };
}

describe("luna driver Sol rework verdict feedback (kusabi #586 criteria 1-6)", () => {
  let root;
  let cwd;
  let stateDir;
  let missionFile;
  let previousStateDir;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-rework-feedback-"));
    cwd = path.join(root, "work");
    fs.mkdirSync(cwd, { recursive: true });
    missionFile = path.join(root, "mission.md");
    fs.writeFileSync(missionFile, MISSION_BRIEF, "utf8");
    previousStateDir = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = path.join(root, "state");
    stateDir = stateDirFor(cwd);
  });

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.KUSABI_STATE_DIR;
    else process.env.KUSABI_STATE_DIR = previousStateDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function makeChainFake() {
    const calls = [];
    return {
      calls,
      run: async (cwdArg, input) => {
        calls.push({ cwd: cwdArg, input });
        const id = input?.flags?.["chain-id"];
        const chainDir = path.join(stateDir, "chains", id);
        fs.mkdirSync(chainDir, { recursive: true });
        const round = calls.length;
        const record = {
          round,
          verdict: "approve",
          disposition: { disposition: "accept" },
          worktreeChanged: true,
          findings: [],
        };
        writeJson(path.join(chainDir, `round-${round}.json`), record);
        writeJson(path.join(chainDir, "chain.json"), { chainId: id, records: [record] });
        return `Chain ${id} completed`;
      },
    };
  }

  function readMission() {
    const missionsDir = path.join(stateDir, "missions");
    const ids = fs.readdirSync(missionsDir).filter((n) => n.startsWith("mission-"));
    assert.equal(ids.length, 1);
    const missionDir = path.join(missionsDir, ids[0]);
    return { missionId: ids[0], missionDir, record: readJson(path.join(missionDir, "mission.json")) };
  }

  function ledgerOf(call) {
    return call.ledger;
  }

  it("criteria 1-4 & 6: pre-accept rework is visible in subsequent envelope ledger, disappears after rework_chain, and clear never appears", async () => {
    let preAcceptCount = 0;
    const solCalls = [];
    const solDispatch = async (input) => {
      solCalls.push(input);
      let verdict = "clear";
      let summary = "sol:clear";
      if (input.gate.phase === "pre-accept") {
        preAcceptCount += 1;
        if (preAcceptCount === 1) {
          verdict = "rework";
          summary = "pre-accept rework: missing tests for edge cases";
        }
      }
      return JSON.stringify({
        type: "verdict",
        schema_version: 2, invariants: [{ id: "INV1", held: true }, { id: "INV2", held: true }, { id: "INV3", held: true }, { id: "INV4", held: true }, { id: "INV5", held: true }], criteria: [],
        gate_id: input.envelope.gate_id,
        envelope_sha256: input.envelope.envelope_sha256,
        verdict,
        summary,
      });
    };

    const coord = makeCoordinator([
      // dispatch 0: initial chain attempt
      (input) => stream(line("run_chain", input.envelope.envelope_sha256, { brief: VALID_CHAIN_BRIEF })),
      // dispatch 1: finish recommend-accept -> gated, returns rework
      (input) => stream(line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-accept" })),
      // dispatch 2: coordinator sees rework feedback and requests rework_chain
      (input) => stream(line("rework_chain", input.envelope.envelope_sha256, { brief: VALID_CHAIN_BRIEF })),
      // dispatch 3: rework completed, retry finish recommend-accept -> gated, returns clear
      (input) => stream(line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-accept" })),
    ]);

    const chain = makeChainFake();
    const result = await runLunaMission({
      cwd,
      missionFile,
      brief: MISSION_BRIEF,
      container: "test-cid",
      ...DEFAULT_SEATS,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      sampling: { rate: 1, salt: "v1" },
      inject: {
        ...stubInvestigationSeams(),
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: chain.run,
        callTool: async () => ({ status: "ok", output: "test-probe" }),
        solDispatch,
      },
    });

    assert.match(result, /disposition=recommend-accept/);
    assert.equal(readMission().record.disposition, "recommend-accept");
    assert.equal(coord.calls.length, 4, "expected 4 coordinator dispatches");

    // Dispatch 0: clean mission, no solRework
    const ledger0 = ledgerOf(coord.calls[0]);
    assert.equal(ledger0.solRework, undefined, "dispatch 0 must have no solRework");

    // Dispatch 1: after attempt 1, before pre-accept gate, no solRework yet
    const ledger1 = ledgerOf(coord.calls[1]);
    assert.equal(ledger1.solRework, undefined, "dispatch 1 must have no solRework");

    // Dispatch 2: immediately after pre-accept rework verdict!
    // Criterion 1 & 6(i): envelope ledger contains the summary, gateId, phase
    const ledger2 = ledgerOf(coord.calls[2]);
    assert.ok(ledger2.solRework, "dispatch 2 envelope ledger must contain solRework");
    assert.match(
      ledger2.solRework,
      /pre-accept rework: missing tests for edge cases/,
      "ledger must contain the rework summary",
    );
    assert.match(ledger2.solRework, /pre-accept/, "ledger must contain the gate phase");
    assert.match(ledger2.solRework, /gate-/, "ledger must contain the gate id");
    // Criterion 1(b) & 6(iv): instruction in rendered rework text
    assert.match(ledger2.solRework, /rework_chain/, "ledger must mention rework_chain instruction");
    assert.match(ledger2.solRework, /finish recommend-accept/, "ledger must mention finish recommend-accept instruction");

    // Dispatch 3: after rework_chain executed!
    // Criterion 2 & 6(ii): after rework_chain attempt it is gone
    const ledger3 = ledgerOf(coord.calls[3]);
    assert.equal(ledger3.solRework, undefined, "dispatch 3 must not contain solRework after rework_chain executed");

    // Criterion 3 & 6(iii): clear gate never appears
    for (let i = 0; i < coord.calls.length; i++) {
      const l = ledgerOf(coord.calls[i]);
      if (l.solRework !== undefined) {
        assert.doesNotMatch(l.solRework, /sol:clear/, `dispatch ${i} must never contain clear verdicts in solRework`);
      }
    }
  });

  it("criterion 1: pending rework remains visible across multiple dispatches without new attempts (e.g. read_probe)", async () => {
    let preAcceptCount = 0;
    const solDispatch = async (input) => {
      let verdict = "clear";
      let summary = "sol:clear";
      if (input.gate.phase === "pre-accept") {
        preAcceptCount += 1;
        if (preAcceptCount === 1) {
          verdict = "rework";
          summary = "pre-accept rework: check edge cases";
        }
      }
      return JSON.stringify({
        type: "verdict",
        schema_version: 2, invariants: [{ id: "INV1", held: true }, { id: "INV2", held: true }, { id: "INV3", held: true }, { id: "INV4", held: true }, { id: "INV5", held: true }], criteria: [],
        gate_id: input.envelope.gate_id,
        envelope_sha256: input.envelope.envelope_sha256,
        verdict,
        summary,
      });
    };

    const coord = makeCoordinator([
      // dispatch 0: attempt 1
      (input) => stream(line("run_chain", input.envelope.envelope_sha256, { brief: VALID_CHAIN_BRIEF })),
      // dispatch 1: finish recommend-accept -> returns rework
      (input) => stream(line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-accept" })),
      // dispatch 2: coordinator runs a probe instead of a chain attempt
      (input) => stream(line("read_probe", input.envelope.envelope_sha256, { tool: "list_files", path: "src" })),
      // dispatch 3: coordinator is dispatched again -> still sees pending rework!
      (input) => stream(line("escalate_to_host", input.envelope.envelope_sha256, { reason: "handoff" })),
    ]);

    const chain = makeChainFake();
    const result = await runLunaMission({
      cwd,
      missionFile,
      brief: MISSION_BRIEF,
      container: "test-cid",
      ...DEFAULT_SEATS,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      sampling: { rate: 1, salt: "v1" },
      inject: {
        ...stubInvestigationSeams(),
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: chain.run,
        callTool: async () => ({ status: "ok", output: "files-list" }),
        solDispatch,
      },
    });

    assert.match(result, /disposition=host-handoff/);
    assert.equal(readMission().record.disposition, "host-handoff");
    assert.equal(coord.calls.length, 4);

    // Dispatch 2 and 3 both see pending rework because no attempt executed in between
    const ledger2 = ledgerOf(coord.calls[2]);
    assert.ok(ledger2.solRework, "dispatch 2 must see pending rework");
    assert.match(ledger2.solRework, /pre-accept rework: check edge cases/);

    const ledger3 = ledgerOf(coord.calls[3]);
    assert.ok(ledger3.solRework, "dispatch 3 must still see pending rework after probe");
    assert.match(ledger3.solRework, /pre-accept rework: check edge cases/);
  });
});

describe("renderPendingSolRework unit tests (criteria 1-5)", () => {
  it("criterion 1(b) & 6(iv): renders instruction and gate details for pending rework", () => {
    const record = {
      attempts: [{ index: 1 }],
      auditGates: [
        {
          gateId: "gate-1",
          phase: "pre-accept",
          verdict: "rework",
          attemptsAtGate: 1,
          verdictRecord: { summary: "missing tests" },
        },
      ],
    };
    const rendered = renderPendingSolRework(record);
    assert.ok(rendered.includes(SOL_REWORK_INSTRUCTION));
    assert.match(rendered, /rework_chain/);
    assert.match(rendered, /finish recommend-accept/);
    assert.match(rendered, /re-gated/);
    assert.match(rendered, /gate-1/);
    assert.match(rendered, /pre-accept/);
    assert.match(rendered, /missing tests/);
  });

  it("criterion 2: stops being pending after attempt count advances", () => {
    const record = {
      attempts: [{ index: 1 }, { index: 2 }],
      auditGates: [
        {
          gateId: "gate-1",
          phase: "pre-accept",
          verdict: "rework",
          attemptsAtGate: 1,
          verdictRecord: { summary: "missing tests" },
        },
      ],
    };
    assert.equal(renderPendingSolRework(record), "");
  });

  it("criterion 2: legacy gates missing attemptsAtGate are treated as pending", () => {
    const record = {
      attempts: [{ index: 1 }, { index: 2 }],
      auditGates: [
        {
          gateId: "legacy-gate-1",
          phase: "post-chain",
          verdict: "rework",
          // attemptsAtGate undefined
          verdictRecord: { summary: "legacy rework" },
        },
      ],
    };
    const rendered = renderPendingSolRework(record);
    assert.match(rendered, /legacy-gate-1/);
    assert.match(rendered, /legacy rework/);
  });

  it("criterion 3: clear and block verdicts are never rendered", () => {
    const record = {
      attempts: [],
      auditGates: [
        { gateId: "gate-1", phase: "pre-dispatch", verdict: "clear", attemptsAtGate: 0, verdictRecord: { summary: "ok" } },
        { gateId: "gate-2", phase: "pre-dispatch", verdict: "block", attemptsAtGate: 0, verdictRecord: { summary: "bad" } },
      ],
    };
    assert.equal(renderPendingSolRework(record), "");
  });

  it("criterion 4: bounded to at most 3 most recent pending gates in record order", () => {
    const record = {
      attempts: [],
      auditGates: [
        { gateId: "gate-1", phase: "pre-dispatch", verdict: "rework", attemptsAtGate: 0, verdictRecord: { summary: "g1" } },
        { gateId: "gate-2", phase: "pre-dispatch", verdict: "rework", attemptsAtGate: 0, verdictRecord: { summary: "g2" } },
        { gateId: "gate-3", phase: "pre-dispatch", verdict: "rework", attemptsAtGate: 0, verdictRecord: { summary: "g3" } },
        { gateId: "gate-4", phase: "pre-dispatch", verdict: "rework", attemptsAtGate: 0, verdictRecord: { summary: "g4" } },
      ],
    };
    const rendered = renderPendingSolRework(record);
    assert.doesNotMatch(rendered, /gate-1/);
    assert.match(rendered, /gate-2/);
    assert.match(rendered, /gate-3/);
    assert.match(rendered, /gate-4/);
    // Order is gate-2 then gate-3 then gate-4
    assert.ok(rendered.indexOf("gate-2") < rendered.indexOf("gate-3"));
    assert.ok(rendered.indexOf("gate-3") < rendered.indexOf("gate-4"));
  });

  it("criterion 4: summary is C0-sanitised and bounded to 1200 UTF-8 bytes", () => {
    const longSummary = "a".repeat(2000);
    const dirtySummary = "hello\x00\x07\x1bworld\nline2\rline3";
    const record = {
      attempts: [],
      auditGates: [
        { gateId: "gate-1", phase: "pre-accept", verdict: "rework", attemptsAtGate: 0, verdictRecord: { summary: longSummary } },
        { gateId: "gate-2", phase: "pre-accept", verdict: "rework", attemptsAtGate: 0, verdictRecord: { summary: dirtySummary } },
      ],
    };
    const rendered = renderPendingSolRework(record);
    assert.doesNotMatch(rendered, /[\x00-\x09\x0b-\x1f]/, "C0 controls except newline must be stripped");
    assert.ok(rendered.includes("helloworld\nline2line3"), "newlines preserved, other C0 stripped");
    // Summary line 1 must not exceed 1200 bytes
    const gate1Line = rendered.split("\n").find((l) => l.includes("gate-1"));
    assert.ok(gate1Line, "gate-1 line must exist");
    assert.ok(Buffer.byteLength(gate1Line, "utf8") <= 1300, "gate-1 line must be bounded");
  });

  it("criterion 5: clean mission produces empty text and byte-identical ledgers", () => {
    const cleanRecord = {
      attempts: [],
      chains: [],
      probes: [],
      consults: [],
      coordinatorErrors: 0,
      auditGates: [],
    };
    assert.equal(renderPendingSolRework(cleanRecord), "");
    assert.equal(renderPendingSolRework({}), "");
    assert.equal(renderPendingSolRework(null), "");

    const driverLedger = JSON.parse(driverLedgerText(cleanRecord));
    assert.equal(driverLedger.solRework, undefined, "clean driver ledger must not contain solRework");

    const recordWithRework = {
      ...cleanRecord,
      auditGates: [
        { gateId: "gate-1", phase: "pre-accept", verdict: "rework", attemptsAtGate: 0, verdictRecord: { summary: "rework needed" } },
      ],
    };
    const solLedger = JSON.parse(missionLedgerText(recordWithRework));
    assert.equal(solLedger.solRework, undefined, "Sol missionLedgerText must never contain solRework");
  });
});
