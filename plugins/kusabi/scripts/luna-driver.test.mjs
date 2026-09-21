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
import { stateDirFor, readJson } from "./state-paths.mjs";
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
        ...(overrides.inject ?? {}),
      },
    };
    const result = await driver.runLunaMission(input);
    return { driver, coord, chain, tools, result, input };
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

  it("consult_sol is recorded as a requested next action — never executed as a gate in this slice", async () => {
    const { chain } = await runMission([
      runChainStream(VALID_RUN_CHAIN_BRIEF),
      consultStream("additional audit requested by coordinator"),
      finishStream("recommend-accept"),
    ]);
    assert.equal(chain.calls.length, 1);
    const { record } = readMission();
    assert.ok(Array.isArray(record.consults) && record.consults.length === 1, "the consult request must be recorded");
    assert.equal(record.consults[0].action, "consult_sol");
    assert.equal(record.disposition, "recommend-accept");
    // No Sol gate execution in this slice: the only side effects are the chain
    // and the records — the mission never dispatched an audit gate.
    const gates = record.auditGates;
    assert.ok(
      gates === undefined || (Array.isArray(gates) && gates.length === 0),
      "no audit gate records in the #530 slice",
    );
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