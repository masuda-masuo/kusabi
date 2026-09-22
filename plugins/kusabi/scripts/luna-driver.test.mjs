// luna-driver.test.mjs — acceptance tests for the #530 deterministic mission driver.
//
// Frozen acceptance contract (kusabi #530 criteria 4-8):
//   - the deterministic driver, not Luna, owns authority: it dispatches the
//     Luna coordinator, parses the output with parseCoordinatorOutput (the
//     frozen #529 parser), validates the closed action enum, executes bounded
//     requests sequentially, and NEVER treats invalid/mixed output as
//     partially executable;
//   - `run_chain` invokes the injected/real runChainLifecycle seam, preserving
//     its preflight/baseline/control behavior (the driver must go through the
//     seam, and must pass keepServe: true so the mission owns serve lifecycle);
//   - chain creation is capped by an explicit mission budget — no recursion,
//     no unbounded attempt creation; exceeding a budget terminates the mission
//     `budget-exhausted`;
//   - `rework_chain` is another bounded mission attempt carrying prior
//     evidence (never luna-resume / crash reconciliation, which are #531);
//   - `read_probe` is driver-mediated and bounded;
//   - `consult_sol` is recorded as a requested handoff/next action only (no Sol
//     gate execution in this slice — that is #531);
//   - the mission never accepts, publishes, merges, creates issues or creates
//     containers; its terminal result is a host-facing recommendation;
//     `finish` supplies a recommendation validated against a small closed
//     vocabulary; `escalate_to_host` terminates as a handoff;
//   - seat substitution fails before mission creation unless explicitly
//     authorized, and authorized substitution is visible in the records;
//   - the happy path: a valid `run_chain` then `finish` sequence calls
//     runChainLifecycle exactly once and ends in a host recommendation.
//
// Test state: every test uses a temp KUSABI_STATE_DIR, a temp cwd, a fake
// coordinator dispatch, a fake runChainLifecycle and a fake callTool.  Nothing
// calls the real Codex CLI, starts a real companion child, or touches a real
// state root.  luna-driver.mjs does not exist on pristine main — the guarded
// dynamic import below turns that into the clear baseline-red message.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { stateDirFor, readJson, writeJson } from "./state-paths.mjs";
import { parseCoordinatorOutput } from "./coordinator-parse.mjs";

let driverModule = null;
async function lunaDriver() {
  if (driverModule === null) {
    try {
      driverModule = await import("./luna-driver.mjs");
    } catch (err) {
      if (err?.code === "ERR_MODULE_NOT_FOUND" && String(err?.message ?? "").includes("luna-driver")) {
        throw new Error(
          "luna-driver.mjs does not exist — the #530 mission driver is not implemented yet " +
          "(baseline-red). The driver must exist before these acceptance tests can run."
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

/**
 * A stateful fake coordinator: each dispatch pops the next canned stream.
 * A stream entry may be a function of the driver's dispatch input — the
 * contract the driver must satisfy is that the input carries the CURRENT
 * envelope (`input.envelope.envelope_sha256`), so a stream can bind its
 * records to the hash the parser demands.
 */
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

/** The run_chain request bound to the current envelope, carrying Luna's brief. */
const runChainStream = (brief) => (input) =>
  stream(line("run_chain", input.envelope.envelope_sha256, { brief }));

const readProbeStream = (tool, probePath) => (input) =>
  stream(line("read_probe", input.envelope.envelope_sha256, { tool, path: probePath }));

const finishStream = (recommendation) => (input) =>
  stream(line("finish", input.envelope.envelope_sha256, { recommendation }));

const consultStream = (reason) => (input) =>
  stream(line("consult_sol", input.envelope.envelope_sha256, { reason }));

const escalateStream = (reason) => (input) =>
  stream(line("escalate_to_host", input.envelope.envelope_sha256, { reason }));

const unknownActionStream = (action) => (input) =>
  stream(line(action, input.envelope.envelope_sha256));

const STALE_HASH = "f".repeat(64);
const staleHashStream = () => stream(line("run_chain", STALE_HASH, { brief: VALID_RUN_CHAIN_BRIEF }));

const malformedJsonStream = (input) =>
  stream(`{"action":"run_chain","envelope_sha256":"${input.envelope.envelope_sha256}"`);

const mixedStream = (input) =>
  stream(
    line("run_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF }),
    line("merge", input.envelope.envelope_sha256),
  );

/**
 * Fake runChainLifecycle: records every invocation.  The driver must call the
 * seam with the chain id it wants (flags["chain-id"]) so the mission can
 * record inner-chain references deterministically — the seam itself validates
 * the shape (chain-[a-z0-9]+) exactly like the real runChainLifecycle does.
 *
 * An optional shared order log lets a test prove request ordering across the
 * fakes (a probe before a chain, for example).
 */
function makeChainFake(sharedOrder = null) {
  const calls = [];
  const order = [];
  return {
    calls,
    order,
    run: async (cwd, input, opts) => {
      calls.push({ cwd, input, opts });
      const tag = `chain:${calls.length}`;
      order.push(tag);
      if (sharedOrder) sharedOrder.push(tag);
      const id = input?.flags?.["chain-id"];
      return id ? `Chain ${id} completed` : `chain-fake${calls.length}`;
    },
  };
}

function toolResponse(name) {
  if (name === "sandbox_exec") return { status: "ok", output: "deadbeef1234\n" };
  if (name === "verify_in_container") {
    return { status: "ok", gate_passed: true, lint: [], types: [], tests: { full: { passed: 1, failed: 0, skipped: 0 } } };
  }
  if (name === "diff_in_container") return { status: "ok", output: "diff --git a/x b/x\n" };
  return { status: "ok", output: "canned\n" };
}

function makeToolFake(sharedOrder = null) {
  const calls = [];
  const order = [];
  return {
    calls,
    order,
    callTool: async (name, args) => {
      calls.push({ name, args });
      const tag = `tool:${name}`;
      order.push(tag);
      if (sharedOrder) sharedOrder.push(tag);
      return toolResponse(name);
    },
  };
}

/**
 * Fake Sol seat (kusabi #531): returns a schema-valid `clear` verdict bound
 * to the CURRENT gate envelope (gate_id + envelope_sha256 come from
 * input.envelope).  The #531 driver must run a Sol gate whenever policy
 * requires one — the pre-accept T11 gate fires for `finish recommend-accept`
 * — so the shared harness injects this default so no existing #530 test can
 * accidentally reach a real Sol seat.
 */
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
  "Orchestrator: gpt-5.6-sol | session luna-driver-test | 2026-09-21",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-cmd.mjs` — the #530 luna CLI surface.",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-cmd.test.mjs`",
].join("\n");

const VALID_RUN_CHAIN_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-inner | 2026-09-21",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-wait.mjs` — the #530 wait surface.",
  "",
  "## Workplace",
  "",
  "- Container: `test-cid`",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-wait.test.mjs`",
].join("\n");

// A brief the deterministic pre-flight must refuse (no ## Deliverables).
const INVALID_RUN_CHAIN_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-inner | 2026-09-21",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-wait.test.mjs`",
].join("\n");

const DEFAULT_SEATS = {
  coordinator: { provider: "codex", model: "gpt-5.6-luna" },
  auditor: { provider: "codex", model: "gpt-5.6-sol" },
};

const DEFAULT_BUDGET = { maxChains: 3, maxAttempts: 2, maxProbes: 5 };

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

describe("luna mission driver (kusabi #530 criteria 4-8)", () => {
  let root;
  let cwd;
  let stateDir;
  let previousStateDir;
  let missionFile;

  beforeEach(() => {
    root = makeTemp("kusabi-luna-driver-");
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
        ...(overrides.inject ?? {}),
      },
    };
    const result = await driver.runLunaMission(input);
    return { driver, coord, chain, tools, sol, result, input };
  }

  function readMission() {
    const missionsDir = path.join(stateDir, "missions");
    const ids = fs.existsSync(missionsDir)
      ? fs.readdirSync(missionsDir).filter((n) => n.startsWith("mission-"))
      : [];
    assert.equal(ids.length, 1, `exactly one mission dir expected in ${missionsDir}, got ${ids.join(",")}`);
    const missionDir = path.join(missionsDir, ids[0]);
    return {
      missionId: ids[0],
      missionDir,
      control: readJson(path.join(missionDir, "control.json")),
      record: readJson(path.join(missionDir, "mission.json")),
    };
  }

  it("surface: exports runLunaMission (baseline-red on pristine main)", async () => {
    const driver = await lunaDriver();
    assert.equal(typeof driver.runLunaMission, "function");
  });

  it("happy path: valid run_chain then finish calls runChainLifecycle exactly once and ends in a host recommendation, never acceptance", async () => {
    const { coord, chain } = await runMission([
      runChainStream(VALID_RUN_CHAIN_BRIEF),
      finishStream("recommend-accept"),
    ]);
    const { control, record, missionDir } = readMission();

    // The seam was used exactly once, with the brief and container of the request.
    assert.equal(chain.calls.length, 1, "runChainLifecycle must be called exactly once");
    assert.equal(chain.calls[0].input.text, VALID_RUN_CHAIN_BRIEF);
    assert.equal(chain.calls[0].input.flags.container, "test-cid");
    assert.equal(chain.calls[0].input.flags.keepServe, true, "the mission owns serve lifecycle (keepServe)");
    const chainId = chain.calls[0].input.flags["chain-id"];
    assert.match(chainId, /^chain-[a-z0-9]+$/, "the driver must hand a shape-valid chain id to the seam");

    // Two coordinator dispatches: intake/evidence -> run_chain, then the
    // inspection/evidence refresh -> finish recommendation.
    assert.equal(coord.calls.length, 2);

    // Terminal host-facing recommendation, recorded exactly, never acceptance.
    assert.equal(control.status, "completed");
    assert.equal(record.disposition, "recommend-accept");
    assert.equal(record.recommendation, "recommend-accept");
    assert.ok(Array.isArray(record.chains) && record.chains.includes(chainId), "inner-chain reference recorded");
    assert.ok(Array.isArray(record.attempts) && record.attempts.length === 1, "one attempt recorded");
    // No acceptance/publication marker anywhere in the mission state.
    assert.doesNotMatch(JSON.stringify(record), /"accepted":true/);
    assert.doesNotMatch(JSON.stringify(record), /"published":true/);
    assert.equal(record.disposition, "recommend-accept", "disposition is the host recommendation, not accept");

    // Exact default seat provenance.
    assert.equal(record.coordinator.provider, "codex");
    assert.equal(record.coordinator.model, "gpt-5.6-luna");
    assert.equal(record.coordinator.substituted, false);
    assert.equal(record.auditor.model, "gpt-5.6-sol");

    // The host-facing recommendation artifact names the recommendation.
    const recFile = path.join(missionDir, "recommendation.md");
    assert.ok(fs.existsSync(recFile), "a host-facing recommendation artifact must exist");
    assert.match(fs.readFileSync(recFile, "utf8"), /recommend-accept/);
  });

  it("finish with a recommendation outside the closed vocabulary fails closed", async () => {
    // `accept` (the chain verb) is not a host recommendation — refused on every call.
    const { chain } = await runMission([
      finishStream("accept"),
      finishStream("accept"),
    ]);
    const { control, record } = readMission();
    assert.equal(chain.calls.length, 0, "no chain may run for a mission that never gets a valid finish");
    assert.ok(record.coordinatorErrors >= 1, "the invalid finish must be counted as a coordinator error");
    assert.equal(record.disposition, "coordinator-failed");
    assert.equal(control.status, "completed");
  });

  it("finish with recommend-escalate ends terminal with that recommendation", async () => {
    const { chain } = await runMission([
      finishStream("recommend-escalate"),
    ]);
    const { record } = readMission();
    assert.equal(chain.calls.length, 0);
    assert.equal(record.disposition, "recommend-escalate");
    assert.equal(record.recommendation, "recommend-escalate");
  });

  it("envelope mismatch fails closed with zero execution", async () => {
    const { chain, coord } = await runMission([staleHashStream, staleHashStream]);
    const { record } = readMission();
    assert.equal(chain.calls.length, 0, "a stale-envelope request must never execute");
    assert.ok(record.coordinatorErrors >= 1);
    assert.equal(record.disposition, "coordinator-failed");
    // The coordinator output was bound to a hash the frozen parser rejects.
    assert.ok(coord.calls.length >= 1);
    const parsed = parseCoordinatorOutput(staleHashStream(coord.calls[0]), {
      envelopeSha256: coord.calls[0].envelope.envelope_sha256,
    });
    assert.equal(parsed.valid, false);
  });

  it("malformed JSON output fails closed with zero execution", async () => {
    const { chain } = await runMission([malformedJsonStream, malformedJsonStream]);
    const { record } = readMission();
    assert.equal(chain.calls.length, 0);
    assert.ok(record.coordinatorErrors >= 1);
    assert.equal(record.disposition, "coordinator-failed");
  });

  it("an unknown action (publish) is rejected with zero execution — the mission never publishes", async () => {
    const { chain } = await runMission([unknownActionStream("publish"), unknownActionStream("publish")]);
    const { record } = readMission();
    assert.equal(chain.calls.length, 0);
    assert.ok(record.coordinatorErrors >= 1, "the rejected action must be counted");
    assert.equal(record.disposition, "coordinator-failed");
    assert.doesNotMatch(JSON.stringify(record), /publish/i);
  });

  it("a coordinator request to create a mission (action luna) is rejected — recursion is structurally prevented", async () => {
    const { chain } = await runMission([unknownActionStream("luna"), unknownActionStream("luna")]);
    const { record } = readMission();
    assert.equal(chain.calls.length, 0, "no verb may create another mission");
    assert.equal(record.disposition, "coordinator-failed");
  });

  it("mixed valid+invalid output is never partially executable", async () => {
    const { chain, coord } = await runMission([mixedStream, mixedStream]);
    const { record } = readMission();
    assert.equal(chain.calls.length, 0, "the valid run_chain inside a mixed stream must NOT execute");
    assert.ok(record.coordinatorErrors >= 1);
    assert.equal(record.disposition, "coordinator-failed");
    const parsed = parseCoordinatorOutput(mixedStream(coord.calls[0]), {
      envelopeSha256: coord.calls[0].envelope.envelope_sha256,
    });
    assert.equal(parsed.valid, false, "the frozen parser flags the mixed stream invalid");
  });

  it("read_probe is driver-mediated: executed through the callTool seam", async () => {
    const { chain, tools } = await runMission([
      readProbeStream("read_file_range", "evidence/probes.json"),
      finishStream("recommend-accept"),
    ]);
    const probeCalls = tools.calls.filter((c) => c.name === "read_file_range");
    assert.equal(probeCalls.length, 1, "the requested probe must run exactly once");
    assert.equal(chain.calls.length, 0, "a probe-only iteration must not start a chain");
  });

  it("read_probe is bounded: a request beyond maxProbes terminates budget-exhausted with zero further probes", async () => {
    const { tools, chain } = await runMission(
      [readProbeStream("read_file_range", "p1"), readProbeStream("read_file_range", "p2"), readProbeStream("read_file_range", "p3")],
      { budget: { ...DEFAULT_BUDGET, maxProbes: 2 } },
    );
    const probeCalls = tools.calls.filter((c) => c.name === "read_file_range");
    assert.equal(probeCalls.length, 2, "no more than maxProbes probes may execute");
    assert.equal(chain.calls.length, 0);
    const { record } = readMission();
    assert.equal(record.disposition, "budget-exhausted");
  });

  it("requests execute sequentially, in stream order", async () => {
    const driver = await lunaDriver();
    const sharedOrder = [];
    const coord = makeCoordinator([
      (input) => stream(
        line("read_probe", input.envelope.envelope_sha256, { tool: "read_file_range", path: "a" }),
        line("run_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF }),
      ),
      finishStream("recommend-accept"),
    ]);
    const chain = makeChainFake(sharedOrder);
    const tools = makeToolFake(sharedOrder);
    await driver.runLunaMission({
      cwd,
      missionFile,
      brief: MISSION_BRIEF,
      container: "test-cid",
      ...DEFAULT_SEATS,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      inject: { coordinatorDispatch: coord.dispatch, runChainLifecycle: chain.run, callTool: tools.callTool },
    });
    assert.equal(chain.calls.length, 1, "the run_chain after the probe must have executed");
    // The probe side effect precedes the chain call in the shared execution
    // order — requests run sequentially, in stream order.
    const probeIdx = sharedOrder.indexOf("tool:read_file_range");
    const chainIdx = sharedOrder.indexOf("chain:1");
    assert.ok(probeIdx >= 0, "the probe must have executed");
    assert.ok(chainIdx >= 0, "the chain call must have executed");
    assert.ok(probeIdx < chainIdx, `probe must run before the chain (order: ${sharedOrder.join(" -> ")})`);
  });

  it("chain creation is capped by the explicit mission budget — exhaustion terminates budget-exhausted", async () => {
    const { chain } = await runMission(
      [
        runChainStream(VALID_RUN_CHAIN_BRIEF),
        runChainStream(VALID_RUN_CHAIN_BRIEF),
        runChainStream(VALID_RUN_CHAIN_BRIEF),
        runChainStream(VALID_RUN_CHAIN_BRIEF),
      ],
      { budget: { ...DEFAULT_BUDGET, maxChains: 2 } },
    );
    assert.equal(chain.calls.length, 2, "no more than maxChains chains may be created");
    const { record } = readMission();
    assert.equal(record.disposition, "budget-exhausted");
    assert.equal(record.chains.length, 2, "exactly the two created chains are referenced");
  });

  it("rework_chain is another bounded mission attempt carrying prior evidence — both chains referenced", async () => {
    const { chain } = await runMission([
      runChainStream(VALID_RUN_CHAIN_BRIEF),
      (input) => stream(line("rework_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF })),
      finishStream("recommend-accept"),
    ]);
    assert.equal(chain.calls.length, 2, "run_chain + rework_chain = two bounded attempts");
    const { record } = readMission();
    assert.ok(Array.isArray(record.attempts) && record.attempts.length === 2, "two attempts recorded");
    const chainIds = chain.calls.map((c) => c.input.flags["chain-id"]);
    assert.ok(Array.isArray(record.chains));
    for (const id of chainIds) {
      assert.ok(record.chains.includes(id), `mission record must reference the executed chain ${id}`);
    }
    assert.equal(record.disposition, "recommend-accept");
  });

  it("a brief draft that fails deterministic validation executes nothing and is counted as a coordinator error", async () => {
    const { chain } = await runMission([
      runChainStream(INVALID_RUN_CHAIN_BRIEF),
      finishStream("recommend-accept"),
    ]);
    assert.equal(chain.calls.length, 0, "an invalid brief must never reach the seam");
    const { record } = readMission();
    assert.ok(record.coordinatorErrors >= 1, "the refused brief must be counted");
    assert.equal(record.disposition, "recommend-accept", "the mission may still end via a later valid finish");
  });

  it("consult_sol is recorded AND opens an additive Sol gate — the pre-accept T11 gate still fires (kusabi #531 supersedes the #530 'no gates' slice)", async () => {
    const { chain, sol } = await runMission([
      runChainStream(VALID_RUN_CHAIN_BRIEF),
      consultStream("additional audit requested by coordinator"),
      finishStream("recommend-accept"),
    ]);
    assert.equal(chain.calls.length, 1);
    const { record } = readMission();
    assert.ok(Array.isArray(record.consults) && record.consults.length === 1, "the consult request must be recorded");
    assert.equal(record.consults[0].action, "consult_sol");
    assert.equal(record.disposition, "recommend-accept");
    // #531 supersedes the #530 "no Sol gate in this slice" contract: an
    // accepted consult_sol is an additive Sol gate, and the mandatory T11
    // pre-accept gate for `finish recommend-accept` fires independently —
    // the consult cannot downgrade it.
    assert.equal(sol.calls.length, 2, "one gate for the consult, one mandatory pre-accept gate");
    assert.ok(Array.isArray(record.auditGates) && record.auditGates.length === 2,
      "the #531 driver must record both gates (no audit gates were recorded in the #530 slice)");
    assert.equal(record.auditGates[0].phase, "consult", "the additive consult gate is recorded first");
    assert.equal(record.auditGates[1].phase, "pre-accept", "the mandatory pre-accept gate is NOT downgraded by the consult");
    assert.equal(record.auditGates[0].verdict, "clear");
    assert.equal(record.auditGates[1].verdict, "clear");
  });

  it("escalate_to_host terminates as a handoff, recording the request for the host", async () => {
    const { chain } = await runMission([escalateStream("premise ambiguous, host judgement required")]);
    assert.equal(chain.calls.length, 0);
    const { control, record, missionDir } = readMission();
    assert.equal(control.status, "completed", "escalate_to_host is terminal");
    assert.ok(record.disposition, "a terminal disposition must be recorded");
    const recFile = path.join(missionDir, "recommendation.md");
    assert.ok(fs.existsSync(recFile), "the handoff must be written for the host");
    assert.match(fs.readFileSync(recFile, "utf8"), /premise ambiguous, host judgement required/);
  });

  it("unauthorized seat substitution fails before mission creation", async () => {
    const driver = await lunaDriver();
    const coord = makeCoordinator([finishStream("recommend-accept")]);
    const chain = makeChainFake();
    const tools = makeToolFake();
    await assert.rejects(
      driver.runLunaMission({
        cwd,
        missionFile,
        brief: MISSION_BRIEF,
        container: "test-cid",
        coordinator: { provider: "codex", model: "gpt-5.6-luna-mini" },
        auditor: { provider: "codex", model: "gpt-5.6-sol" },
        allowSubstitute: false,
        budget: DEFAULT_BUDGET,
        inject: { coordinatorDispatch: coord.dispatch, runChainLifecycle: chain.run, callTool: tools.callTool },
      }),
      /substitut/i,
    );
    assert.ok(!fs.existsSync(path.join(stateDir, "missions")), "no mission may be created for an unauthorized substitution");
    assert.equal(chain.calls.length, 0);
  });

  it("authorized substitution runs and records the exact substituted seat", async () => {
    const { chain } = await runMission([finishStream("recommend-accept")], {
      coordinator: { provider: "codex", model: "gpt-5.6-luna-mini" },
      allowSubstitute: true,
    });
    const { record } = readMission();
    assert.equal(record.coordinator.model, "gpt-5.6-luna-mini", "the actual model used is recorded exactly");
    assert.equal(record.coordinator.substituted, true, "the substitution is loudly recorded");
    assert.equal(record.coordinator.provider, "codex");
    assert.equal(chain.calls.length, 0);
  });

  it("a non-codex coordinator seat is refused even when substitution is authorized", async () => {
    const driver = await lunaDriver();
    const coord = makeCoordinator([finishStream("recommend-accept")]);
    await assert.rejects(
      driver.runLunaMission({
        cwd,
        missionFile,
        brief: MISSION_BRIEF,
        container: "test-cid",
        coordinator: { provider: "opencode", model: "deepseek-v4-flash" },
        auditor: { provider: "codex", model: "gpt-5.6-sol" },
        allowSubstitute: true,
        budget: DEFAULT_BUDGET,
        inject: { coordinatorDispatch: coord.dispatch, runChainLifecycle: makeChainFake().run, callTool: makeToolFake().callTool },
      }),
      /codex|backend|seat/i,
    );
    assert.ok(!fs.existsSync(path.join(stateDir, "missions")), "the luna mode never leaves the codex seats");
  });

  it("an invalid mission id is refused before any filesystem write", async () => {
    const driver = await lunaDriver();
    await assert.rejects(
      driver.runLunaMission({
        cwd,
        missionFile,
        brief: MISSION_BRIEF,
        container: "test-cid",
        missionId: "mission-a/b",
        ...DEFAULT_SEATS,
        allowSubstitute: false,
        budget: DEFAULT_BUDGET,
        inject: { coordinatorDispatch: makeCoordinator([]).dispatch, runChainLifecycle: makeChainFake().run, callTool: makeToolFake().callTool },
      }),
      /mission-a\/b/,
    );
    assert.ok(!fs.existsSync(path.join(stateDir, "missions")), "no mission state may exist for a refused id");
  });

  it("the driver only ever starts chains through the injected runChainLifecycle seam", async () => {
    const { chain } = await runMission([
      runChainStream(VALID_RUN_CHAIN_BRIEF),
      runChainStream(VALID_RUN_CHAIN_BRIEF),
      finishStream("recommend-accept"),
    ]);
    assert.equal(chain.calls.length, 2);
    // Every chain the mission ran went through the seam; the mission itself
    // created no chains directory entries outside it.
    const chainsDir = path.join(stateDir, "chains");
    const created = fs.existsSync(chainsDir) ? fs.readdirSync(chainsDir) : [];
    assert.equal(created.length, 0, "the mission must not create chain state itself — the seam owns chains");
  });
});

// ---------------------------------------------------------------------------
// kusabi #532 criterion 2 (driver side) — the mission record carries the
// additive observability fields the #532 ingest preserves: exact seat
// reasoning effort, brief corrections, host interventions, and terminal
// wall-clock latency.  Absent fields stay absent (NULL at ingest), never
// guessed.  Token/cost preservation itself is pinned in mission-ingest.
// ---------------------------------------------------------------------------

describe("mission record observability fields (kusabi #532 criterion 2)", () => {
  let root;
  let cwd;
  let stateDir;
  let previousStateDir;
  let missionFile;

  beforeEach(() => {
    root = makeTemp("kusabi-532-driver-obs-");
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

  async function runMission(streams, overrides = {}) {
    const driver = await lunaDriver();
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
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: chain.run,
        callTool: tools.callTool,
        solDispatch: sol.dispatch,
        ...(overrides.inject ?? {}),
      },
    };
    const result = await driver.runLunaMission(input);
    return { driver, coord, chain, tools, sol, result, input };
  }

  function readMission() {
    const missionsDir = path.join(stateDir, "missions");
    const ids = fs.readdirSync(missionsDir).filter((n) => n.startsWith("mission-"));
    assert.equal(ids.length, 1);
    const missionDir = path.join(missionsDir, ids[0]);
    return {
      missionId: ids[0],
      control: readJson(path.join(missionDir, "control.json")),
      record: readJson(path.join(missionDir, "mission.json")),
    };
  }

  it("records exact seat provenance including reasoning effort for both seats", async () => {
    await runMission([finishStream("recommend-escalate")]);
    const { record } = readMission();
    assert.equal(record.coordinator.provider, "codex");
    assert.equal(record.coordinator.model, "gpt-5.6-luna");
    assert.equal(record.coordinator.requested, "gpt-5.6-luna");
    assert.equal(record.coordinator.actual, "gpt-5.6-luna");
    assert.equal(record.coordinator.substituted, false);
    assert.equal(record.coordinator.reasoningEffort, "high", "the coordinator seat must record its reasoning effort");
    assert.equal(record.auditor.reasoningEffort, "high", "the auditor seat must record its reasoning effort");
  });

  it("counts a deterministic brief correction alongside the coordinator error (a rejected brief is both)", async () => {
    const badBrief = "no deliverables section at all";
    await runMission([runChainStream(badBrief), finishStream("recommend-escalate")]);
    const { record } = readMission();
    assert.ok(record.coordinatorErrors >= 1, "the rejected brief is a coordinator error");
    assert.ok(record.briefCorrections >= 1, "the deterministic pre-flight refusal must be counted as a brief correction");
    assert.equal(record.briefCorrections, record.coordinatorErrors,
      "for a pure brief-correction mission the counters agree — nothing is double-counted elsewhere");
  });

  it("records host interventions for escalate_to_host (explicit, never inferred)", async () => {
    const escalate = (input) =>
      j({ action: "escalate_to_host", envelope_sha256: input.envelope.envelope_sha256, reason: "host judgement required" });
    await runMission([escalate]);
    const { record } = readMission();
    assert.equal(record.disposition, "host-handoff");
    assert.ok(record.hostInterventions >= 1, "an escalate_to_host must be recorded as a host intervention");
  });

  it("records terminal wall-clock latency: finishedAt and latencySeconds on the terminal record", async () => {
    await runMission([finishStream("recommend-accept")]);
    const { record } = readMission();
    assert.equal(record.disposition, "recommend-accept");
    assert.equal(typeof record.finishedAt, "string", "a terminal mission must record finishedAt");
    assert.ok(!Number.isNaN(Date.parse(record.finishedAt)), "finishedAt must be a parseable timestamp");
    assert.equal(typeof record.latencySeconds, "number");
    assert.ok(record.latencySeconds >= 0);
    const expected = (Date.parse(record.finishedAt) - Date.parse(record.startedAt)) / 1000;
    assert.ok(
      Math.abs(record.latencySeconds - expected) <= 5,
      `latencySeconds ${record.latencySeconds} must match the recorded wall clock (${expected}s)`,
    );
  });
});
// ---------------------------------------------------------------------------
// kusabi #532 adjudication finding 5 (driver side) — a post-chain Luna gate
// tied to an inner chain round must PERSIST the actual audit verdict, the
// blocked state and the no-Sol shadow disposition onto the durable
// round-N.json (and the chain.json `records` mirror the metrics ingest
// reads) through the safe read/update/write boundary.  Only when the target
// round is positively identified; absent/unreadable legacy records stay
// untouched; the mission gate record stays authoritative.
// ---------------------------------------------------------------------------

describe("post-chain audit columns persist onto the durable inner chain round (kusabi #532 finding 5)", () => {
  let root;
  let cwd;
  let stateDir;
  let previousStateDir;
  let missionFile;

  beforeEach(() => {
    root = makeTemp("kusabi-532-find5-");
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

  /**
   * Fake runChainLifecycle that writes REAL durable chain state (chain.json
   * + round-N.json) under the state dir, like the production seam does, so
   * the driver's round persistence has a target to hit.  With
   * `writeState: false` it behaves like the plain recording fake (no chain
   * files at all \u2014 the missing-target-round case).
   */
  function makeChainFakePersisting(writeState = true) {
    const calls = [];
    return {
      calls,
      run: async (cwdArg, input, opts) => {
        calls.push({ cwd: cwdArg, input, opts });
        const id = input?.flags?.["chain-id"];
        if (writeState === false) return id ? `Chain ${id} completed` : "chain-fake";
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

  /**
   * Fake Sol seat that answers by gate PHASE: behavior[phase] is a verdict
   * string (default "clear") or a function returning/raising the raw result.
   * The driver must run a gate at every frozen lifecycle point under
   * sampling rate=1, so phase-keyed verdicts isolate the post-chain gate.
   */
  function makeSolFakeByPhase(behavior) {
    const calls = [];
    return {
      calls,
      dispatch: async (input) => {
        calls.push(input);
        const b = behavior[input.gate.phase] ?? "clear";
        if (typeof b === "function") return b(input);
        const record = {
          type: "verdict",
          schema_version: 1,
          gate_id: input.envelope.gate_id,
          envelope_sha256: input.envelope.envelope_sha256,
          verdict: b,
          summary: `sol:${b}`,
        };
        // The frozen schema demands block_reason + acknowledgement_required
        // on a block verdict \u2014 without them the gate would fail closed
        // before the verdict is even bound.
        if (b === "block") {
          record.block_reason = "deterministic test block";
          record.acknowledgement_required = true;
        }
        return JSON.stringify(record);
      },
    };
  }

  async function runMission(streams, overrides = {}) {
    const driver = await lunaDriver();
    const coord = makeCoordinator(streams);
    const chain = overrides.chainFake ?? makeChainFakePersisting();
    const sol = overrides.solFake ?? makeSolFakeByPhase({});
    const input = {
      cwd,
      missionFile,
      brief: MISSION_BRIEF,
      container: "test-cid",
      ...DEFAULT_SEATS,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      sampling: { rate: 1, salt: "v1" },
      ...overrides.input,
      inject: {
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: chain.run,
        callTool: makeToolFake().callTool,
        solDispatch: sol.dispatch,
        ...(overrides.inject ?? {}),
      },
    };
    const result = await driver.runLunaMission(input);
    return { driver, coord, chain, sol, result, input };
  }

  function readMission() {
    const missionsDir = path.join(stateDir, "missions");
    const ids = fs.readdirSync(missionsDir).filter((n) => n.startsWith("mission-"));
    assert.equal(ids.length, 1);
    const missionDir = path.join(missionsDir, ids[0]);
    return { missionId: ids[0], missionDir, record: readJson(path.join(missionDir, "mission.json")) };
  }

  function readInnerChain(chain) {
    const id = chain.calls[0].input.flags["chain-id"];
    const chainDir = path.join(stateDir, "chains", id);
    return {
      id,
      chainDir,
      roundRecord: readJson(path.join(chainDir, "round-1.json")),
      chainJson: readJson(path.join(chainDir, "chain.json")),
    };
  }

  it("a clear post-chain gate persists auditVerdict/auditBlocked/auditShadowDisposition onto the durable round (finding 5)", async () => {
    const chain = makeChainFakePersisting();
    await runMission([runChainStream(VALID_RUN_CHAIN_BRIEF), finishStream("recommend-accept")], {
      chainFake: chain,
      solFake: makeSolFakeByPhase({ "post-chain": "clear" }),
    });
    const { record } = readMission();
    assert.equal(record.disposition, "recommend-accept");

    const { roundRecord, chainJson } = readInnerChain(chain);
    assert.equal(roundRecord.auditVerdict, "clear", "the actual audit verdict is persisted");
    assert.equal(roundRecord.auditBlocked, false, "a cleared gate measured not-blocked");
    assert.equal(roundRecord.auditShadowDisposition, "audit-sample-skipped",
      "the no-Sol shadow disposition (sampled-only gate) is persisted");
    // The chain.json records mirror (the array the metrics ingest reads)
    // carries the exact same columns.
    assert.equal(chainJson.records[0].auditVerdict, "clear");
    assert.equal(chainJson.records[0].auditBlocked, false);
    assert.equal(chainJson.records[0].auditShadowDisposition, "audit-sample-skipped");
    // The mission gate record stays authoritative and untouched by the mirror.
    const postGate = record.auditGates.find((g) => g.phase === "post-chain");
    assert.ok(postGate, "the post-chain gate is recorded on the mission record");
    assert.equal(postGate.verdict, "clear");
    assert.equal(postGate.shadowDisposition, "audit-sample-skipped");
  });

  it("a rework post-chain gate persists auditVerdict rework without blocking the round (finding 5)", async () => {
    const chain = makeChainFakePersisting();
    await runMission([runChainStream(VALID_RUN_CHAIN_BRIEF), finishStream("recommend-accept")], {
      chainFake: chain,
      solFake: makeSolFakeByPhase({ "post-chain": "rework" }),
    });
    const { record } = readMission();
    assert.equal(record.disposition, "recommend-accept", "a bounded rework continues to a later valid finish");
    const { roundRecord } = readInnerChain(chain);
    assert.equal(roundRecord.auditVerdict, "rework", "the rework verdict is persisted");
    assert.equal(roundRecord.auditBlocked, false, "rework is a demand, not a block");
    assert.equal(roundRecord.auditShadowDisposition, "audit-sample-skipped");
  });

  it("a block post-chain gate persists auditVerdict block and the blocked state, and terminates sol-blocked (finding 5)", async () => {
    const chain = makeChainFakePersisting();
    await runMission([runChainStream(VALID_RUN_CHAIN_BRIEF)], {
      chainFake: chain,
      solFake: makeSolFakeByPhase({ "post-chain": "block" }),
    });
    const { record } = readMission();
    assert.equal(record.disposition, "sol-blocked");
    const { roundRecord, chainJson } = readInnerChain(chain);
    assert.equal(roundRecord.auditVerdict, "block", "the block verdict is persisted");
    assert.equal(roundRecord.auditBlocked, true, "the blocked state is persisted as measured-blocked");
    assert.equal(roundRecord.auditShadowDisposition, "audit-sample-skipped");
    assert.equal(chainJson.records[0].auditBlocked, true);
  });

  it("a fail-open sampled-only post-chain gate (Sol unavailable) persists the shadow trace without blocking (finding 5)", async () => {
    const chain = makeChainFakePersisting();
    await runMission([runChainStream(VALID_RUN_CHAIN_BRIEF), finishStream("recommend-accept")], {
      chainFake: chain,
      solFake: makeSolFakeByPhase({
        "post-chain": () => { throw new Error("seat unavailable"); },
      }),
    });
    const { record } = readMission();
    assert.equal(record.disposition, "recommend-accept", "a sampled-only unavailability is the single fail-open");
    const { roundRecord } = readInnerChain(chain);
    assert.equal(roundRecord.auditVerdict, null, "no authoritative verdict was recorded");
    assert.equal(roundRecord.auditBlocked, false, "the fail-open is not a block");
    assert.equal(roundRecord.auditShadowDisposition, "audit-sample-skipped",
      "the no-Sol shadow disposition is the fail-open trace");
  });

  it("a missing target round leaves the durable records untouched \u2014 no chain state written by the seam (finding 5)", async () => {
    const chain = makeChainFakePersisting(false); // the seam writes NO chain files
    await runMission([runChainStream(VALID_RUN_CHAIN_BRIEF), finishStream("recommend-accept")], {
      chainFake: chain,
    });
    const { record } = readMission();
    assert.equal(record.disposition, "recommend-accept", "the mission completes normally");
    const chainsDir = path.join(stateDir, "chains");
    const created = fs.existsSync(chainsDir) ? fs.readdirSync(chainsDir) : [];
    assert.equal(created.length, 0, "no chain state exists \u2014 nothing to mutate");
  });

  it("a missing target round leaves the durable records untouched \u2014 chain.json without the round file (finding 5)", async () => {
    const chain = makeChainFakePersisting();
    const originalRun = chain.run.bind(chain);
    chain.run = async (cwdArg, input, opts) => {
      const result = await originalRun(cwdArg, input, opts);
      // Remove the round-N.json the fake wrote: the terminal record exists on
      // chain.json but the round file is absent \u2014 the persistence must leave
      // everything untouched rather than guess.
      const id = input?.flags?.["chain-id"];
      fs.rmSync(path.join(stateDir, "chains", id, "round-1.json"), { force: true });
      return result;
    };
    await runMission([runChainStream(VALID_RUN_CHAIN_BRIEF), finishStream("recommend-accept")], {
      chainFake: chain,
    });
    const { record } = readMission();
    assert.equal(record.disposition, "recommend-accept");
    const { roundRecord, chainJson } = readInnerChain(chain);
    assert.equal(roundRecord, null, "the absent round file stays absent");
    assert.equal(chainJson.records[0].auditVerdict, undefined,
      "chain.json's records are not mutated when the round file cannot be read");
    assert.equal(chainJson.records[0].auditBlocked, undefined);
    assert.equal(chainJson.records[0].auditShadowDisposition, undefined);
  });
});
// ---------------------------------------------------------------------------
// coordinator dispatch failure propagation through the REAL codex seam
// (criterion 4 / criterion 7)
// ---------------------------------------------------------------------------
//
// The production coordinator seam is realCoordinatorDispatch (the default
// when inject.coordinatorDispatch is absent).  The tests below point CODEX_BIN
// at a fake `codex` that RESOLVES its job either failed (nonzero exit) or
// completed with a non-empty but syntactically invalid coordinator payload,
// and assert what the mission record does with each:
//   - a resolved FAILED codex job must surface as a coordinator dispatch
//     failure naming job id/status/error, and must NEVER be routed through
//     parseCoordinatorOutput ("coordinator stream invalid" / "0 rejected, 0
//     malformed" is the misleading empty-stream label from the incident);
//   - a genuine COMPLETED job whose non-empty terminal message is NOT a
//     valid coordinator stream stays a stream-parse problem (invalid
//     stream), not a dispatch failure.  (A process with NO terminal
//     assistant message is job.status "error" by fail-closed contract; that
//     blank-stream case is NOT a completed job and is never tested here as
//     one.)

const FAKE_CODEX_TEMPLATE = `#!/usr/bin/env node
import fs from "node:fs";
const mode = process.env.FAKE_CODEX_MODE ?? "exit-3";
const emit = (obj) => fs.writeSync(1, JSON.stringify(obj) + "\\n");
if (mode === "exit-3") {
  fs.writeSync(2, "codex: crashed\\n");
  process.exit(3);
} else if (mode === "invalid") {
  emit({ type: "thread.started", thread_id: "__THREAD__" });
  emit({ type: "item.completed", item: { type: "agent_message", text: "this is not a valid coordinator stream" } });
  emit({ type: "turn.completed", usage: {} });
  process.exit(0);
}
process.exit(0);
`;

function fakeCodexContext(mode) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-luna-fake-codex-"));
  const binPath = path.join(tmp, "fake-codex.mjs");
  fs.writeFileSync(binPath, FAKE_CODEX_TEMPLATE, "utf8");
  fs.chmodSync(binPath, 0o755);
  const saved = {
    CODEX_BIN: process.env.CODEX_BIN,
    KUSABI_STATE_DIR: process.env.KUSABI_STATE_DIR,
    FAKE_CODEX_MODE: process.env.FAKE_CODEX_MODE,
    HOME: process.env.HOME,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  process.env.CODEX_BIN = binPath;
  process.env.FAKE_CODEX_MODE = mode;
  process.env.KUSABI_STATE_DIR = path.join(tmp, "state");
  process.env.HOME = path.join(tmp, "home");
  process.env.CODEX_HOME = path.join(tmp, "operator-codex-home");
  fs.mkdirSync(process.env.HOME, { recursive: true });
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  const cwd = path.join(tmp, "work");
  fs.mkdirSync(cwd, { recursive: true });
  return {
    tmp,
    cwd,
    stateDir: stateDirFor(cwd),
    setMode(next) { process.env.FAKE_CODEX_MODE = next; },
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe("coordinator dispatch failure propagation through the real codex seam (criterion 4/7)", () => {
  let ctx;
  let cwd;
  let stateDir;
  let missionFile;

  beforeEach(() => {
    ctx = fakeCodexContext("exit-3");
    cwd = ctx.cwd;
    stateDir = ctx.stateDir;
    missionFile = path.join(ctx.tmp, "mission.md");
    fs.writeFileSync(missionFile, MISSION_BRIEF, "utf8");
  });

  afterEach(() => {
    ctx.restore();
  });

  // Run the mission with the REAL coordinator dispatch (no
  // inject.coordinatorDispatch); every other seam is faked.
  async function runRealCoordinatorMission() {
    const driver = await lunaDriver();
    const chain = makeChainFake();
    const tools = makeToolFake();
    const sol = makeSolFake();
    const notifications = [];
    const result = await driver.runLunaMission({
      cwd,
      missionFile,
      brief: MISSION_BRIEF,
      container: "test-cid",
      ...DEFAULT_SEATS,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      inject: {
        runChainLifecycle: chain.run,
        callTool: tools.callTool,
        solDispatch: sol.dispatch,
        notifyMissionTerminal: async (info) => { notifications.push(info); },
        guardedServeStop: async () => {},
      },
    });
    return { driver, chain, tools, sol, notifications, result };
  }

  function readMissionRecord() {
    const missionsDir = path.join(stateDir, "missions");
    const ids = fs.existsSync(missionsDir)
      ? fs.readdirSync(missionsDir).filter((n) => n.startsWith("mission-"))
      : [];
    assert.equal(ids.length, 1, `exactly one mission dir expected in ${missionsDir}, got ${ids.join(",")}`);
    const missionDir = path.join(missionsDir, ids[0]);
    return {
      missionId: ids[0],
      missionDir,
      control: readJson(path.join(missionDir, "control.json")),
      record: readJson(path.join(missionDir, "mission.json")),
    };
  }

  function codexJobRecords() {
    const jobsDir = path.join(stateDir, "jobs");
    if (!fs.existsSync(jobsDir)) return [];
    return fs
      .readdirSync(jobsDir)
      .filter((n) => n.startsWith("job-"))
      .map((id) => ({ id, job: readJson(path.join(jobsDir, id, "job.json")) }));
  }

  it("a resolved failed codex job is recorded as a coordinator dispatch failure naming job id/status/error, never as an invalid stream", async () => {
    const { notifications } = await runRealCoordinatorMission();
    const { record } = readMissionRecord();
    assert.equal(record.disposition, "coordinator-failed");

    const jobRecords = codexJobRecords();
    assert.ok(jobRecords.length >= 1, "the real dispatch must have created a codex job record");
    const job = jobRecords[jobRecords.length - 1].job;
    assert.notEqual(job.status, "completed", "the fake codex job must be a resolved FAILED job");
    assert.ok(job.error && job.error.includes("codex exited with code 3"), "job.error must carry the exit failure");

    const details = (record.coordinatorErrorsDetails ?? []).map((d) => d.detail).join("\n");
    assert.match(details, /coordinator dispatch failed/, "the driver catch must name a dispatch failure");
    assert.ok(details.includes(job.id), `the persisted error must name the codex job id (${job.id}): ${details}`);
    assert.ok(details.includes(job.status), `the persisted error must name the job status (${job.status}): ${details}`);
    assert.ok(details.includes(job.error), "the persisted error must carry the underlying job error");
    assert.doesNotMatch(details, /coordinator stream invalid/, "a dispatch failure must never be routed through parseCoordinatorOutput");
    assert.doesNotMatch(details, /0 rejected, 0 malformed/, "the misleading empty-stream message must not be emitted");
    assert.equal(notifications.length, 1, "exactly one terminal notification");
  });

  it("a genuine completed job with non-empty invalid coordinator content stays a stream-parse problem, never a dispatch failure (criterion 7)", async () => {
    ctx.setMode("invalid");
    await runRealCoordinatorMission();
    const { record } = readMissionRecord();
    const jobRecords = codexJobRecords();
    assert.ok(jobRecords.length >= 1, "the real dispatch must have created a codex job record");
    const job = jobRecords[jobRecords.length - 1].job;
    assert.equal(job.status, "completed", "a non-empty terminal message genuinely completes the job");
    assert.equal(job.error, null, "a completed job carries no dispatch error");
    const details = (record.coordinatorErrorsDetails ?? []).map((d) => d.detail).join("\n");
    assert.doesNotMatch(details, /coordinator dispatch failed/, "a completed job must never be labeled a dispatch failure");
    assert.match(details, /coordinator stream invalid/, "syntactically invalid coordinator content is a stream-parse failure, not a dispatch failure");
  });
});