// luna-budget-preflight.test.mjs — acceptance tests for atomic batch budget
// preflight (the verified defect: one valid coordinator stream with six
// read_probe actions and maxProbes=5 executed five probes and terminated on
// the sixth, leaving attempts=0/chains=0 — budget was checked per request
// during execution, so an oversized batch had partial side effects).
//
// Frozen contract under test (the atomic-preflight decisions):
//
//   1. A valid parsed action batch is preflighted against ALL remaining
//      deterministic budgets BEFORE any action executes — read_probe against
//      remaining probes; run_chain + rework_chain jointly against both
//      remaining attempts and chains; consult_sol against remaining consults;
//      finish / escalate_to_host consume none; maxRework stays Sol-gate-owned.
//   2. An oversized batch terminates `budget-exhausted`, records a PRECISE
//      reason naming the exhausted dimension against the REMAINING budget,
//      and executes ZERO actions (zero tool calls, zero chain calls, zero Sol
//      dispatches, zero host interventions).  It is NOT a coordinator error
//      and gets NO retry (exactly one coordinator dispatch).
//   3. Whole-batch atomicity wins even when a terminal action (`finish` /
//      `escalate_to_host`) precedes or follows the over-budget actions.
//   4. Exact-fit batches execute normally; the preflight must never refuse a
//      batch that fits the REMAINING budget (persisted usage included).
//
// These tests exercise the driver through its public `runLunaMission` seam
// (injected coordinator/chain/tool/Sol/notify fakes) — the same surface the
// frozen luna-driver.test.mjs pins — so a missing preflight fails the
// assertions behaviorally (side effects happened / no precise reason), never
// as an import error.  The preflight does not exist yet on this main: every
// budget-exhausted test below is red for the defect it pins.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { stateDirFor, readJson, writeJson } from "./state-paths.mjs";

let driverModule = null;
async function lunaDriver() {
  if (driverModule === null) {
    try {
      driverModule = await import("./luna-driver.mjs");
    } catch (err) {
      if (err?.code === "ERR_MODULE_NOT_FOUND" && String(err?.message ?? "").includes("luna-driver")) {
        throw new Error(
          "luna-driver.mjs does not exist — the mission driver is not implemented yet (baseline-red).",
        );
      }
      throw err;
    }
  }
  return driverModule;
}

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

const j = (obj) => JSON.stringify(obj);
const line = (action, hash, body = {}) => j({ action, envelope_sha256: hash, ...body });
const stream = (...lines) => lines.join("\n");

/** A stateful fake coordinator: each dispatch pops the next canned stream. */
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

const probeStream = (n, pathPrefix = "p") => (input) =>
  stream(...Array.from({ length: n }, (_, i) => line("read_probe", input.envelope.envelope_sha256, { tool: "read_file_range", path: `${pathPrefix}${i}` })));

const chainStream = (n, action = "run_chain") => (input) =>
  stream(...Array.from({ length: n }, () => line(action, input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF })));

const consultStream = (n, reason = "audit") => (input) =>
  stream(...Array.from({ length: n }, () => line("consult_sol", input.envelope.envelope_sha256, { reason })));

/** Fake runChainLifecycle: records every invocation. */
function makeChainFake() {
  const calls = [];
  return {
    calls,
    run: async (cwd, input, opts) => {
      calls.push({ cwd, input, opts });
      const id = input?.flags?.["chain-id"];
      return id ? `Chain ${id} completed` : `chain-fake${calls.length}`;
    },
  };
}

function makeToolFake() {
  const calls = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { status: "ok", output: "canned\n" };
    },
  };
}

/** Fake Sol seat: a schema-valid `clear` verdict bound to the current gate envelope. */
function makeSolFake() {
  const calls = [];
  return {
    calls,
    dispatch: async (input) => {
      calls.push(input);
      return JSON.stringify({
        type: "verdict",
        schema_version: 1,
        gate_id: input.envelope.gate_id,
        envelope_sha256: input.envelope.envelope_sha256,
        verdict: "clear",
        summary: "sol:clear",
      });
    },
  };
}

// ---------------------------------------------------------------------------
// briefs
// ---------------------------------------------------------------------------

const MISSION_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-budget-preflight-test | 2026-09-23",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-budget-preflight.mjs` — the atomic preflight.",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-budget-preflight.test.mjs`",
].join("\n");

const VALID_RUN_CHAIN_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-inner | 2026-09-23",
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

const DEFAULT_BUDGET = { maxChains: 3, maxAttempts: 2, maxProbes: 5, maxConsults: 3, maxRework: 1 };

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

describe("atomic batch budget preflight (frozen decisions 1-5)", () => {
  let root;
  let cwd;
  let stateDir;
  let previousStateDir;
  let missionFile;

  beforeEach(() => {
    root = makeTemp("kusabi-luna-preflight-");
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

  /** Run the driver with the given canned coordinator streams; returns the fakes + result. */
  async function runMission(streams, overrides = {}) {
    const driver = await lunaDriver();
    const coord = makeCoordinator(streams);
    const chain = makeChainFake();
    const tools = makeToolFake();
    const sol = makeSolFake();
    const notifications = [];
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
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: chain.run,
        callTool: tools.callTool,
        solDispatch: sol.dispatch,
        notifyMissionTerminal: async (info) => { notifications.push(info); },
        guardedServeStop: async () => {},
        ...(overrides.inject ?? {}),
      },
    };
    const result = await driver.runLunaMission(input);
    return { driver, coord, chain, tools, sol, notifications, result, input };
  }

  /** The single mission the last run created/resumed, plus its records. */
  function readMission(missionId) {
    const missionsDir = path.join(stateDir, "missions");
    const ids = fs.existsSync(missionsDir)
      ? fs.readdirSync(missionsDir).filter((n) => n.startsWith("mission-"))
      : [];
    if (missionId === undefined) {
      assert.equal(ids.length, 1, `exactly one mission dir expected in ${missionsDir}, got ${ids.join(",")}`);
      missionId = ids[0];
    } else {
      assert.ok(ids.includes(missionId), `mission dir ${missionId} expected in ${missionsDir}, got ${ids.join(",")}`);
    }
    const missionDir = path.join(missionsDir, missionId);
    return {
      missionId,
      missionDir,
      control: readJson(path.join(missionDir, "control.json")),
      record: readJson(path.join(missionDir, "mission.json")),
    };
  }

  /**
   * Seed a resumable mission directory exactly like luna-resume leaves one
   * behind: a persisted mission dir + control record, no terminal disposition,
   * with the given persisted usage counts and effective budget on the record.
   */
  function seedMission({ probes = 0, attempts = 0, chains = 0, consults = 0, budget = DEFAULT_BUDGET } = {}) {
    const missionId = "mission-preflightseed";
    const missionsDir = path.join(stateDir, "missions");
    fs.mkdirSync(missionsDir, { recursive: true });
    const missionDir = path.join(missionsDir, missionId);
    fs.mkdirSync(missionDir, { recursive: true });
    writeJson(path.join(missionDir, "control.json"), {
      missionId,
      container: "test-cid",
      pid: 99999999,
      status: "running",
    });
    writeJson(path.join(missionDir, "mission.json"), {
      missionId,
      container: "test-cid",
      missionFile,
      pid: 99999999,
      status: "running",
      coordinator: DEFAULT_SEATS.coordinator,
      auditor: DEFAULT_SEATS.auditor,
      startedAt: "2026-09-23T00:00:00.000Z",
      attempts: Array.from({ length: attempts }, (_, i) => ({
        index: i + 1,
        kind: "run_chain",
        chainId: `chain-seed${i}`,
        brief: VALID_RUN_CHAIN_BRIEF,
        status: "completed",
        output: "seed",
        at: "2026-09-23T00:00:00.000Z",
      })),
      chains: Array.from({ length: chains }, (_, i) => `chain-seed${i}`),
      probes: Array.from({ length: probes }, (_, i) => ({
        action: "read_probe",
        tool: "read_file_range",
        path: `seed-${i}`,
        output: "seed",
        outputBytes: 4,
        truncated: false,
        omittedBytes: 0,
        truncation: null,
        at: "2026-09-23T00:00:00.000Z",
      })),
      consults: Array.from({ length: consults }, (_, i) => ({
        action: "consult_sol",
        reason: `seed-${i}`,
        at: "2026-09-23T00:00:00.000Z",
      })),
      coordinatorErrors: 0,
      briefCorrections: 0,
      hostInterventions: 0,
      recommendation: null,
      disposition: null,
      budget: { ...DEFAULT_BUDGET, ...budget },
    });
    return missionId;
  }

  /**
   * The precise-reason contract of decision 2: the budget-exhausted
   * termination must record a reason that names the exhausted dimension and
   * conveys the refusal against the REMAINING budget (the batch, not the Nth
   * per-request check, is what exceeded it).
   */
  function assertBudgetExhaustedReason(record, dimensionRe, where) {
    const reason = record.terminationReason;
    assert.ok(
      typeof reason === "string" && reason.length > 0,
      `${where}: a precise budget-exhausted reason must be recorded, got ${JSON.stringify(reason)}`,
    );
    assert.match(reason, dimensionRe, `${where}: the reason must name the exhausted dimension`);
    assert.match(
      reason,
      /remain|exceed|requested|refused|over budget/i,
      `${where}: the reason must convey the refusal against the remaining budget, got: ${reason}`,
    );
  }

  // -------------------------------------------------------------------------
  // required red test 1: six probes with maxProbes=5
  // -------------------------------------------------------------------------

  it("six read_probe actions with maxProbes=5 execute ZERO tool calls and terminate budget-exhausted with an atomic-refusal reason", async () => {
    const { tools, chain, sol, coord } = await runMission(
      [probeStream(6)],
      { budget: { ...DEFAULT_BUDGET, maxProbes: 5 } },
    );
    const { control, record, missionDir } = readMission();

    // Whole-batch atomicity: the oversized batch is refused before ANY action.
    assert.equal(tools.calls.length, 0, "an oversized probe batch must execute zero tool calls");
    assert.equal(chain.calls.length, 0, "an oversized probe batch must not start any chain");
    assert.equal(sol.calls.length, 0, "an oversized probe batch must not dispatch the Sol seat");
    assert.equal(record.probes.length, 0, "no probe may be recorded for a refused batch");
    assert.equal(record.attempts.length, 0, "no attempt may be recorded for a refused batch");
    assert.equal(record.chains.length, 0, "no chain may be recorded for a refused batch");

    // Terminal budget-exhausted, not a coordinator error, no retry.
    assert.equal(record.disposition, "budget-exhausted");
    assert.equal(control.status, "completed");
    assert.equal(record.coordinatorErrors, 0, "an oversized batch is not a coordinator error");
    assert.equal(coord.calls.length, 1, "an oversized batch gets no retry (exactly one coordinator dispatch)");

    // Precise atomic-refusal reason naming the probe bound against remaining.
    assertBudgetExhaustedReason(record, /probe/i, "six-probe batch");
    const recFile = path.join(missionDir, "recommendation.md");
    assert.ok(fs.existsSync(recFile), "the terminal recommendation artifact must exist");
    assert.match(fs.readFileSync(recFile, "utf8"), /budget-exhausted/);
    assert.match(fs.readFileSync(recFile, "utf8"), /probe/i, "the recommendation artifact must carry the reason");
  });

  // -------------------------------------------------------------------------
  // required red test 2: mixed over-budget probe/chain batch
  // -------------------------------------------------------------------------

  it("a mixed batch over budget on probes executes zero tool AND zero chain calls", async () => {
    const { tools, chain, sol } = await runMission(
      [(input) => stream(
        ...Array.from({ length: 4 }, (_, i) => line("read_probe", input.envelope.envelope_sha256, { tool: "read_file_range", path: `mix${i}` })),
        line("run_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF }),
      )],
      { budget: { ...DEFAULT_BUDGET, maxProbes: 3, maxAttempts: 5, maxChains: 5 } },
    );
    const { record } = readMission();
    assert.equal(tools.calls.length, 0, "the probe half of the refused batch must not execute");
    assert.equal(chain.calls.length, 0, "the chain half of the refused batch must not execute");
    assert.equal(sol.calls.length, 0, "no gate may fire for a refused batch");
    assert.equal(record.disposition, "budget-exhausted");
    assert.equal(record.probes.length, 0);
    assert.equal(record.attempts.length, 0);
    assertBudgetExhaustedReason(record, /probe/i, "mixed probe/chain batch");
  });

  // -------------------------------------------------------------------------
  // required red test 3: four consults with maxConsults=3
  // -------------------------------------------------------------------------

  it("four consult_sol actions with maxConsults=3 execute zero Sol dispatches", async () => {
    const { sol, tools, chain, coord } = await runMission(
      [consultStream(4)],
      { budget: { ...DEFAULT_BUDGET, maxConsults: 3 } },
    );
    const { record } = readMission();
    assert.equal(sol.calls.length, 0, "an oversized consult batch must not dispatch the Sol seat");
    assert.equal(tools.calls.length, 0);
    assert.equal(chain.calls.length, 0);
    assert.equal(record.consults.length, 0, "no consult may be recorded for a refused batch");
    assert.equal(record.disposition, "budget-exhausted");
    assert.equal(record.coordinatorErrors, 0, "an oversized consult batch is not a coordinator error");
    assert.equal(coord.calls.length, 1, "an oversized consult batch gets no retry");
    assertBudgetExhaustedReason(record, /consult/i, "four-consult batch");
  });

  // -------------------------------------------------------------------------
  // required red test 4: two chain actions with maxChains=1 (both dimensions)
  // -------------------------------------------------------------------------

  it("two run_chain actions with maxChains=1 execute zero chain calls (chains as the limiting dimension)", async () => {
    const { chain, tools, sol } = await runMission(
      [chainStream(2, "run_chain")],
      { budget: { ...DEFAULT_BUDGET, maxChains: 1, maxAttempts: 5 } },
    );
    const { record } = readMission();
    assert.equal(chain.calls.length, 0, "an oversized chain batch must not invoke runChainLifecycle");
    assert.equal(tools.calls.length, 0);
    assert.equal(sol.calls.length, 0, "no gate may fire for a refused chain batch");
    assert.equal(record.attempts.length, 0, "no attempt may be recorded for a refused chain batch");
    assert.equal(record.chains.length, 0, "no chain may be recorded for a refused chain batch");
    assert.equal(record.disposition, "budget-exhausted");
    assertBudgetExhaustedReason(record, /chain/i, "two-chain batch (chains limiting)");
  });

  it("two chain actions with maxAttempts=1 execute zero chain calls (attempts as the limiting dimension)", async () => {
    const { chain } = await runMission(
      [chainStream(2, "run_chain")],
      { budget: { ...DEFAULT_BUDGET, maxAttempts: 1, maxChains: 5 } },
    );
    const { record } = readMission();
    assert.equal(chain.calls.length, 0, "an oversized attempt batch must not invoke runChainLifecycle");
    assert.equal(record.attempts.length, 0);
    assert.equal(record.disposition, "budget-exhausted");
    assertBudgetExhaustedReason(record, /attempt/i, "two-chain batch (attempts limiting)");
  });

  it("run_chain + rework_chain are counted JOINTLY against remaining attempts (a rework-only breach refuses the whole batch)", async () => {
    const { chain } = await runMission(
      [(input) => stream(
        line("run_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF }),
        line("rework_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF }),
        line("rework_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF }),
      )],
      { budget: { ...DEFAULT_BUDGET, maxAttempts: 2, maxChains: 5 } },
    );
    const { record } = readMission();
    assert.equal(chain.calls.length, 0, "a joint over-budget attempt batch must not invoke runChainLifecycle");
    assert.equal(record.disposition, "budget-exhausted");
    assertBudgetExhaustedReason(record, /attempt/i, "run_chain + two rework_chain batch");
  });

  it("run_chain + rework_chain are counted JOINTLY against remaining chains", async () => {
    const { chain } = await runMission(
      [(input) => stream(
        line("run_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF }),
        line("rework_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF }),
        line("rework_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF }),
      )],
      { budget: { ...DEFAULT_BUDGET, maxChains: 2, maxAttempts: 5 } },
    );
    const { record } = readMission();
    assert.equal(chain.calls.length, 0, "a joint over-budget chain batch must not invoke runChainLifecycle");
    assert.equal(record.disposition, "budget-exhausted");
    assertBudgetExhaustedReason(record, /chain/i, "run_chain + two rework_chain batch (chains limiting)");
  });

  // -------------------------------------------------------------------------
  // required red test 6: terminal action first and terminal action last
  // -------------------------------------------------------------------------

  it("an over-budget batch with the terminal action FIRST executes nothing (escalate_to_host does not fire)", async () => {
    const { tools, chain, sol, coord } = await runMission(
      [(input) => stream(
        line("escalate_to_host", input.envelope.envelope_sha256, { reason: "handoff before the oversized probes" }),
        ...Array.from({ length: 6 }, (_, i) => line("read_probe", input.envelope.envelope_sha256, { tool: "read_file_range", path: `t${i}` })),
      )],
      { budget: { ...DEFAULT_BUDGET, maxProbes: 5 } },
    );
    const { record } = readMission();
    assert.equal(record.disposition, "budget-exhausted", "whole-batch atomicity beats the leading terminal action");
    assert.equal(record.hostInterventions, 0, "the leading escalate_to_host must not fire for a refused batch");
    assert.equal(tools.calls.length, 0, "no probe may execute");
    assert.equal(chain.calls.length, 0);
    assert.equal(sol.calls.length, 0);
    assert.equal(coord.calls.length, 1, "no retry after the atomic refusal");
    assertBudgetExhaustedReason(record, /probe/i, "terminal-first batch");
  });

  it("an over-budget batch with the terminal action LAST executes nothing (finish does not fire)", async () => {
    const { tools, sol, chain } = await runMission(
      [(input) => stream(
        ...Array.from({ length: 6 }, (_, i) => line("read_probe", input.envelope.envelope_sha256, { tool: "read_file_range", path: `t${i}` })),
        line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-accept" }),
      )],
      { budget: { ...DEFAULT_BUDGET, maxProbes: 5 } },
    );
    const { record } = readMission();
    assert.equal(record.disposition, "budget-exhausted", "whole-batch atomicity beats the trailing terminal action");
    assert.equal(record.recommendation, null, "the trailing finish must not fire for a refused batch");
    assert.equal(tools.calls.length, 0, "no probe may execute");
    assert.equal(sol.calls.length, 0, "no pre-accept gate may fire for a refused batch");
    assert.equal(chain.calls.length, 0);
    assert.equal(record.probes.length, 0);
    assertBudgetExhaustedReason(record, /probe/i, "terminal-last batch");
  });

  it("an over-budget batch with finish FIRST executes nothing (finish does not fire)", async () => {
    const { sol, tools } = await runMission(
      [(input) => stream(
        line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-accept" }),
        ...Array.from({ length: 6 }, (_, i) => line("read_probe", input.envelope.envelope_sha256, { tool: "read_file_range", path: `t${i}` })),
      )],
      { budget: { ...DEFAULT_BUDGET, maxProbes: 5 } },
    );
    const { record } = readMission();
    assert.equal(record.disposition, "budget-exhausted", "whole-batch atomicity beats the leading finish");
    assert.equal(record.recommendation, null);
    assert.equal(sol.calls.length, 0, "no pre-accept gate may fire for a refused batch");
    assert.equal(tools.calls.length, 0);
    assertBudgetExhaustedReason(record, /probe/i, "finish-first batch");
  });

  // -------------------------------------------------------------------------
  // exact fit (required red test 5 / decision 5)
  // -------------------------------------------------------------------------

  it("an exact-fit mixed batch executes fully and a valid terminal action completes", async () => {
    const { tools, chain, sol } = await runMission(
      [(input) => stream(
        line("read_probe", input.envelope.envelope_sha256, { tool: "read_file_range", path: "a" }),
        line("read_probe", input.envelope.envelope_sha256, { tool: "read_file_range", path: "b" }),
        line("run_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF }),
        line("consult_sol", input.envelope.envelope_sha256, { reason: "checkpoint" }),
        line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-accept" }),
      )],
      { budget: { ...DEFAULT_BUDGET, maxProbes: 2, maxAttempts: 2, maxChains: 2, maxConsults: 2 } },
    );
    const { record } = readMission();
    assert.equal(tools.calls.length, 2, "both exact-fit probes must execute");
    assert.equal(chain.calls.length, 1, "the exact-fit run_chain must execute");
    assert.equal(sol.calls.length, 2, "the consult gate and the mandatory pre-accept gate fire");
    assert.equal(record.probes.length, 2);
    assert.equal(record.attempts.length, 1);
    assert.equal(record.consults.length, 1);
    assert.equal(record.disposition, "recommend-accept");
    assert.equal(record.recommendation, "recommend-accept");
  });

  it("a batch that fits the REMAINING probes (not just the defaults) executes normally", async () => {
    // 4 probes already persisted; maxProbes=5 leaves exactly 1 remaining — a
    // 1-probe batch must fit and run, proving the preflight counts remaining.
    const missionId = seedMission({ probes: 4, budget: { ...DEFAULT_BUDGET, maxProbes: 5 } });
    const { tools } = await runMission(
      [(input) => stream(
        line("read_probe", input.envelope.envelope_sha256, { tool: "read_file_range", path: "a" }),
        line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-escalate" }),
      )],
      { missionId, budget: { ...DEFAULT_BUDGET, maxProbes: 5 } },
    );
    const { record } = readMission();
    assert.equal(tools.calls.length, 1, "the exact-fit remaining probe must execute");
    assert.equal(record.probes.length, 5, "persisted 4 + executed 1");
    assert.equal(record.disposition, "recommend-escalate");
  });

  // -------------------------------------------------------------------------
  // pre-existing persisted usage (decision 4: remaining, not defaults)
  // -------------------------------------------------------------------------

  it("a batch that exceeds the REMAINING probes after persisted usage is refused with zero execution", async () => {
    const missionId = seedMission({ probes: 5, budget: { ...DEFAULT_BUDGET, maxProbes: 5 } });
    const { tools, chain, sol } = await runMission(
      [(input) => stream(
        line("read_probe", input.envelope.envelope_sha256, { tool: "read_file_range", path: "a" }),
        line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-accept" }),
      )],
      { missionId, budget: { ...DEFAULT_BUDGET, maxProbes: 5 } },
    );
    const { record } = readMission();
    assert.equal(tools.calls.length, 0, "a batch over the REMAINING probe budget must execute zero tool calls");
    assert.equal(chain.calls.length, 0);
    assert.equal(sol.calls.length, 0);
    assert.equal(record.probes.length, 5, "no NEW probe may be recorded");
    assert.equal(record.disposition, "budget-exhausted");
    assertBudgetExhaustedReason(record, /probe/i, "persisted-usage probe refusal");
  });

  it("a batch that exceeds the REMAINING attempts after persisted usage is refused with zero execution", async () => {
    const missionId = seedMission({ attempts: 2, chains: 2, budget: { ...DEFAULT_BUDGET, maxAttempts: 2, maxChains: 5 } });
    const { chain } = await runMission(
      [(input) => stream(
        line("run_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF }),
        line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-escalate" }),
      )],
      { missionId, budget: { ...DEFAULT_BUDGET, maxAttempts: 2, maxChains: 5 } },
    );
    const { record } = readMission();
    assert.equal(chain.calls.length, 0, "a batch over the REMAINING attempt budget must not invoke runChainLifecycle");
    assert.equal(record.attempts.length, 2, "no NEW attempt may be recorded");
    assert.equal(record.disposition, "budget-exhausted");
    assertBudgetExhaustedReason(record, /attempt/i, "persisted-usage attempt refusal");
  });

  // -------------------------------------------------------------------------
  // fixed breach ordering (decision 4: deterministic, preflight is pure)
  // -------------------------------------------------------------------------

  it("a batch breaching BOTH probes and chains reports exactly one fixed dimension, deterministically across runs", async () => {
    // Batch shape: run_chain consumes the single remaining chain, probe
    // consumes the single remaining probe, then the second probe breaches
    // probes and the second run_chain breaches chains.  Whatever the fixed
    // evaluation order is, the SAME input must report the SAME dimension on
    // every run, and that dimension must be one that the batch actually
    // breaches.
    const bothDims = (input) => stream(
      line("run_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF }),
      line("read_probe", input.envelope.envelope_sha256, { tool: "read_file_range", path: "x" }),
      line("read_probe", input.envelope.envelope_sha256, { tool: "read_file_range", path: "y" }),
      line("run_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF }),
    );
    const budget = { ...DEFAULT_BUDGET, maxProbes: 1, maxChains: 1, maxAttempts: 5 };

    const run1 = await runMission([bothDims], { budget, missionId: "mission-ordera" });
    const mission1 = readMission("mission-ordera");
    assert.equal(mission1.record.disposition, "budget-exhausted");
    assert.equal(run1.chain.calls.length, 0, "the preflight must refuse before any chain runs");
    assert.equal(run1.tools.calls.length, 0, "the preflight must refuse before any tool runs");
    const reason1 = mission1.record.terminationReason;
    assert.ok(typeof reason1 === "string" && reason1.length > 0, "a precise reason must be recorded");
    const dim1 = /attempt/i.test(reason1) ? "attempt" : /chain/i.test(reason1) ? "chain" : /probe/i.test(reason1) ? "probe" : null;
    assert.ok(dim1 !== null, `the reason must name one breached dimension, got: ${reason1}`);
    assert.ok(["probe", "chain"].includes(dim1), `the reported dimension must be actually breached, got ${dim1}`);

    const run2 = await runMission([bothDims], { budget, missionId: "mission-orderb" });
    const mission2 = readMission("mission-orderb");
    assert.equal(mission2.record.disposition, "budget-exhausted");
    assert.equal(run2.chain.calls.length, 0);
    assert.equal(run2.tools.calls.length, 0);
    const reason2 = mission2.record.terminationReason;
    const dim2 = /attempt/i.test(reason2) ? "attempt" : /chain/i.test(reason2) ? "chain" : /probe/i.test(reason2) ? "probe" : null;
    assert.equal(dim2, dim1, "the reported breach dimension must be FIXED (identical across identical inputs)");
  });

  // -------------------------------------------------------------------------
  // per-dispatch preflight: exact-fit earlier batches still execute (defense-in-depth)
  // -------------------------------------------------------------------------

  it("each dispatch is preflighted separately: exact-fit earlier batches execute, the later over-budget batch refuses with zero execution", async () => {
    // One consult per dispatch: dispatch 1 and 2 each fit (maxConsults=2),
    // dispatch 3 has zero remaining consults — its batch of one must be
    // refused atomically with a precise reason, and no consult may execute.
    const { sol, coord } = await runMission(
      [consultStream(1, "a"), consultStream(1, "b"), consultStream(1, "c")],
      { budget: { ...DEFAULT_BUDGET, maxConsults: 2 } },
    );
    const { record } = readMission();
    assert.equal(coord.calls.length, 3, "the coordinator is dispatched exactly maxConsults + 1 times");
    assert.equal(record.consults.length, 2, "the two exact-fit earlier batches executed");
    assert.equal(sol.calls.length, 2, "one additive gate per accepted consult");
    assert.equal(record.disposition, "budget-exhausted");
    assertBudgetExhaustedReason(record, /consult/i, "later-dispatch consult refusal");
  });
});