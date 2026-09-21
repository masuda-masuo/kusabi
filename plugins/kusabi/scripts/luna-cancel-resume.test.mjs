// luna-cancel-resume.test.mjs — acceptance tests for the kusabi #531
// luna-cancel / luna-resume surfaces.
//
// Frozen acceptance contract (kusabi #531 criteria 3, 4, 5, 8):
//
//   - `luna-cancel <mission-id>` records the stop request on the mission
//     control (stopRequestedAt + stopRequestedBy "luna") and propagates it
//     to a LIVE inner chain through the existing chain stop lever
//     (requestChainStop semantics); a STALE inner chain is finalised by the
//     same existing stale-pid branch (status cancelled + finishedAt);
//   - after the stop request exists, NO coordinator, auditor (Sol), or
//     inner-chain seat may be dispatched — cancellation before any seat,
//     and cancellation DURING an inner chain, both leave the seat counts
//     frozen at their pre-stop values;
//   - a cancelled mission is TERMINAL (disposition `cancelled` in
//     TERMINAL_MISSION_DISPOSITIONS, terminal for wait/show surfaces) and
//     emits exactly one terminal notification;
//   - `luna-resume <mission-id>` resumes from every persisted phase
//     boundary without duplicate seat dispatch, duplicate chain creation,
//     duplicate terminal notification, or a second watcher/wait process;
//   - luna-resume REFUSES while a recorded Luna/Sol job is genuinely still
//     running (a live mission control pid, or a mission seat job whose
//     process is alive);
//   - a Sol `block` is never cleared by Luna: only a recorded human
//     override (actor, reason, timestamp, original verdict embedded) lets a
//     sol-blocked mission proceed via luna-resume.
//
// Public surface frozen here (added by #531 to luna-cmd.mjs):
//
//   cmdLunaCancel(cwd, { flags, text }, opts)  — text is the mission id.
//   cmdLunaResume(cwd, { flags, text }, opts)  — text is the mission id;
//     flags["audit-override"] <gateId>, flags["audit-override-reason"],
//     flags["audit-override-by"].  opts.inject.runLunaMission is the driver
//     seam (default: the real driver); the REST of opts.inject is forwarded
//     into the driver's input.inject; opts.spawn must never be called
//     (resume never spawns a child — no second watcher/wait process).
//
// The driver's resume contract (criterion 5): given an EXISTING mission
// directory + missionId, runLunaMission continues from the persisted record
// instead of refusing "mission id already exists" — the next coordinator
// dispatch continues the evidence numbering, already-recorded
// attempts/chains/consults/probes/gates are never re-executed, and the
// terminal notification fires exactly once.
//
// Test state: temp KUSABI_STATE_DIR, temp cwd, fabricated mission/chain/job
// directories, fake coordinator/chain/tool/Sol/notify seams, real pids for
// liveness (process.pid = alive, 99999999 = dead).  Nothing calls the real
// Codex CLI, Docker, GitHub, kaiba (beyond a temp KAIBA_DB sqlite), or a
// background watcher.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { stateDirFor, readJson, writeJson } from "./state-paths.mjs";
import { TERMINAL_MISSION_DISPOSITIONS } from "./mission-store.mjs";
import { readMissionSnapshot } from "./luna-wait.mjs";

let cmdModule = null;
async function lunaCancelResume() {
  if (cmdModule === null) {
    const mod = await import("./luna-cmd.mjs");
    for (const name of ["cmdLunaCancel", "cmdLunaResume"]) {
      if (typeof mod[name] !== "function") {
        throw new Error(
          `luna-cmd.mjs does not export ${name} \u2014 the #531 ` +
          `${name === "cmdLunaCancel" ? "luna-cancel" : "luna-resume"} surface is not implemented yet ` +
          "(baseline-red). The command handler must exist before these acceptance tests can run."
        );
      }
    }
    cmdModule = mod;
  }
  return cmdModule;
}

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const DEAD_PID = 99999999; // a pid that cannot exist on this host (see chain-control.test.mjs)

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

const j = (obj) => JSON.stringify(obj);
const line = (action, hash, body = {}) => j({ action, envelope_sha256: hash, ...body });
const stream = (...lines) => lines.join("\n");

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

const finishStream = (recommendation) => (input) =>
  stream(line("finish", input.envelope.envelope_sha256, { recommendation }));

function makeChainFake(run = null) {
  const calls = [];
  return {
    calls,
    run: async (cwd, input, opts) => {
      calls.push({ cwd, input, opts });
      if (run) return run(cwd, input, opts);
      const id = input?.flags?.["chain-id"];
      return id ? `Chain ${id} completed` : "chain-fake";
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

const verdictLine = (input, verdict) =>
  j({
    type: "verdict",
    schema_version: 1,
    gate_id: input.envelope.gate_id,
    envelope_sha256: input.envelope.envelope_sha256,
    verdict,
    ...(verdict === "block" ? { block_reason: "wrong_premise", acknowledgement_required: true } : {}),
    summary: `sol:${verdict}`,
  });

function makeSol() {
  const calls = [];
  return {
    calls,
    dispatch: async (input) => {
      calls.push(input);
      return verdictLine(input, "clear");
    },
  };
}

function makeNotify() {
  const calls = [];
  return {
    calls,
    dispatch: async (info) => { calls.push(info); },
  };
}

/** A spawn seam that must never be called — resume never spawns a child. */
function noSpawn() {
  throw new Error("resume must never spawn a watcher or waiter process");
}

// ---------------------------------------------------------------------------
// briefs and record shapes
// ---------------------------------------------------------------------------

const MISSION_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-cancel-resume-test | 2026-09-21",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-cancel-resume.test.mjs` — the #531 cancel/resume freeze.",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-cancel-resume.test.mjs`",
].join("\n");

const VALID_RUN_CHAIN_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-cancel-inner | 2026-09-21",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-cancel-resume.test.mjs` — the #531 cancel freeze.",
  "",
  "## Workplace",
  "",
  "- Container: `test-cid`",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-cancel-resume.test.mjs`",
].join("\n");

const DEFAULT_BUDGET = { maxChains: 3, maxAttempts: 2, maxProbes: 5, maxConsults: 3, maxRework: 1 };

const SEATS = {
  coordinator: { provider: "codex", model: "gpt-5.6-luna", substituted: false },
  auditor: { provider: "codex", model: "gpt-5.6-sol", substituted: false },
};

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

describe("luna-cancel / luna-resume (kusabi #531 criteria 3, 4, 5, 8)", () => {
  let root;
  let cwd;
  let stateDir;
  let previousStateDir;
  let missionFile;

  beforeEach(() => {
    root = makeTemp("kusabi-luna-cancel-resume-");
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

  /** Fabricate a mission directory (control.json + mission.json). */
  function writeMission(id, { control = {}, record = {} } = {}) {
    const missionDir = path.join(stateDir, "missions", id);
    fs.mkdirSync(missionDir, { recursive: true });
    writeJson(path.join(missionDir, "control.json"), {
      missionId: id,
      container: "test-cid",
      pid: DEAD_PID,
      status: "running",
      startedAt: "2026-09-21T00:00:00.000Z",
      ...control,
    });
    writeJson(path.join(missionDir, "mission.json"), {
      missionId: id,
      container: "test-cid",
      missionFile,
      pid: DEAD_PID,
      status: "running",
      ...SEATS,
      attempts: [],
      chains: [],
      coordinatorErrors: 0,
      consults: [],
      probes: [],
      recommendation: null,
      disposition: null,
      startedAt: "2026-09-21T00:00:00.000Z",
      ...record,
    });
    return missionDir;
  }

  /** Fabricate an inner chain directory with a control record. */
  function writeChain(chainId, control) {
    const chainDir = path.join(stateDir, "chains", chainId);
    fs.mkdirSync(chainDir, { recursive: true });
    writeJson(path.join(chainDir, "control.json"), {
      chainId,
      container: "test-cid",
      pid: DEAD_PID,
      status: "running",
      round: 0,
      startedAt: "2026-09-21T00:00:00.000Z",
      ...control,
    });
    writeJson(path.join(chainDir, "chain.json"), {
      chainId,
      container: "test-cid",
      records: [],
    });
    return chainDir;
  }

  /** Fabricate a job-store record for a mission seat. */
  function writeJob(jobId, job) {
    const jobDir = path.join(stateDir, "jobs", jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    writeJson(path.join(jobDir, "job.json"), {
      id: jobId,
      status: "running",
      ...job,
    });
  }

  /** Read the single mission directory under stateDir. */
  function readOnlyMission() {
    const missionsDir = path.join(stateDir, "missions");
    const ids = fs.readdirSync(missionsDir).filter((n) => n.startsWith("mission-"));
    assert.equal(ids.length, 1);
    const missionDir = path.join(missionsDir, ids[0]);
    return {
      missionId: ids[0],
      missionDir,
      control: readJson(path.join(missionDir, "control.json")),
      record: readJson(path.join(missionDir, "mission.json")),
    };
  }

  /**
   * Wire the real driver against an EXISTING mission directory (the #531
   * resume path) with fakes, wrapping it in a call counter.
   */
  function resumeWithRealDriver(missionId, { coordinatorStreams, chainRun = null }) {
    const coord = makeCoordinator(coordinatorStreams);
    const chain = makeChainFake(chainRun);
    const tools = makeToolFake();
    const sol = makeSol();
    const notify = makeNotify();
    const realDriverInput = {
      coordinatorDispatch: coord.dispatch,
      runChainLifecycle: chain.run,
      callTool: tools.callTool,
      solDispatch: sol.dispatch,
      notifyMissionTerminal: notify.dispatch,
      guardedServeStop: async () => {},
    };
    let driverCalls = 0;
    const seam = async (input) => {
      driverCalls += 1;
      const driver = await import("./luna-driver.mjs");
      return driver.runLunaMission({ ...input, inject: { ...realDriverInput, ...(input.inject ?? {}) } });
    };
    return { coord, chain, tools, sol, notify, seam, get driverCalls() { return driverCalls; } };
  }

  it("surface: luna-cmd exports cmdLunaCancel and cmdLunaResume (baseline-red on current main)", async () => {
    const mod = await lunaCancelResume();
    assert.equal(typeof mod.cmdLunaCancel, "function");
    assert.equal(typeof mod.cmdLunaResume, "function");
  });

  it("cancelled is a TERMINAL mission disposition (criterion 8)", () => {
    assert.ok(TERMINAL_MISSION_DISPOSITIONS.has("cancelled"));
  });

  it("cancelled is terminal for wait/show surfaces even while the control still says running", () => {
    writeMission("mission-cancelled-terminal", {
      control: { status: "running", pid: DEAD_PID },
      record: { status: "running", disposition: "cancelled" },
    });
    const snapshot = readMissionSnapshot(path.join(stateDir, "missions"), "mission-cancelled-terminal");
    assert.equal(snapshot.terminal, true, "a cancelled disposition must be terminal for wait/show");
    assert.equal(snapshot.disposition, "cancelled");
  });

  it("cmdLunaCancel records the stop request on the mission control (criterion 4)", async () => {
    const mod = await lunaCancelResume();
    const missionDir = writeMission("mission-cancel1", { control: { pid: process.pid } });
    const out = await mod.cmdLunaCancel(cwd, { flags: {}, text: "mission-cancel1" }, {});
    assert.match(out, /mission-cancel1/, `cancel output names the mission: ${out}`);
    const control = readJson(path.join(missionDir, "control.json"));
    assert.ok(control.stopRequestedAt, "the stop request must be recorded with a timestamp");
    assert.equal(control.stopRequestedBy, "luna", "the stop request must be attributed to luna");
    assert.equal(control.status, "running", "a live mission keeps running until its driver sees the stop");
  });

  it("cmdLunaCancel refuses a malformed or missing mission id before writing anything", async () => {
    const mod = await lunaCancelResume();
    await assert.rejects(mod.cmdLunaCancel(cwd, { flags: {}, text: "chain-x" }, {}), /mission/i);
    await assert.rejects(mod.cmdLunaCancel(cwd, { flags: {}, text: "mission-a/b" }, {}), /mission/i);
    await assert.rejects(
      mod.cmdLunaCancel(cwd, { flags: {}, text: "mission-nope" }, {}),
      /not found|no mission|mission/i,
    );
  });

  it("cmdLunaCancel propagates the stop request to a LIVE inner chain (criterion 4)", async () => {
    const mod = await lunaCancelResume();
    writeMission("mission-cancel-live-chain", { control: { pid: process.pid } });
    const chainDir = writeChain("chain-cancel-live", { pid: process.pid });
    // The mission record names the inner chain it is running.
    writeJson(path.join(stateDir, "missions", "mission-cancel-live-chain", "mission.json"), {
      ...readJson(path.join(stateDir, "missions", "mission-cancel-live-chain", "mission.json")),
      chains: ["chain-cancel-live"],
      status: "running",
    });

    await mod.cmdLunaCancel(cwd, { flags: {}, text: "mission-cancel-live-chain" }, {});

    const inner = readJson(path.join(chainDir, "control.json"));
    assert.ok(inner.stopRequestedAt, "the live inner chain must receive the stop request");
    assert.equal(inner.stopRequestedBy, "luna");
    assert.equal(inner.status, "running", "a live inner chain is asked to stop, not silently killed");
  });

  it("cmdLunaCancel lets a STALE inner chain finalise through the existing chain stop behavior (criterion 4)", async () => {
    const mod = await lunaCancelResume();
    writeMission("mission-cancel-stale-chain", { control: { pid: process.pid } });
    const chainDir = writeChain("chain-cancel-stale", { pid: DEAD_PID });
    writeJson(path.join(stateDir, "missions", "mission-cancel-stale-chain", "mission.json"), {
      ...readJson(path.join(stateDir, "missions", "mission-cancel-stale-chain", "mission.json")),
      chains: ["chain-cancel-stale"],
      status: "running",
    });

    await mod.cmdLunaCancel(cwd, { flags: {}, text: "mission-cancel-stale-chain" }, {});

    const inner = readJson(path.join(chainDir, "control.json"));
    assert.equal(inner.status, "cancelled", "the stale chain is finalised through the existing stale-pid branch");
    assert.ok(inner.finishedAt, "the stale chain gets a finishedAt");
    assert.equal(inner.stopRequestedBy, "luna");
  });

  it("after the stop request, no coordinator, auditor, or inner-chain seat is dispatched (criterion 4)", async () => {
    // The coordinator writes the stop request DURING its first dispatch.  The
    // driver must refuse to execute the run_chain it received (no pre-dispatch
    // gate, no chain) and terminate cancelled without a second dispatch.
    const driver = await import("./luna-driver.mjs");
    const stopDuringFirstDispatch = (input) => {
      const controlPath = path.join(input.missionDir, "control.json");
      const control = readJson(controlPath);
      writeJson(controlPath, { ...control, stopRequestedAt: new Date().toISOString(), stopRequestedBy: "luna" });
      return stream(line("run_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF }));
    };
    const coord = makeCoordinator([stopDuringFirstDispatch, finishStream("recommend-accept")]);
    const chain = makeChainFake();
    const tools = makeToolFake();
    const sol = makeSol();
    const notify = makeNotify();

    await driver.runLunaMission({
      cwd,
      missionFile,
      brief: MISSION_BRIEF,
      container: "test-cid",
      coordinator: SEATS.coordinator,
      auditor: SEATS.auditor,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: chain.run,
        callTool: tools.callTool,
        solDispatch: sol.dispatch,
        notifyMissionTerminal: notify.dispatch,
        guardedServeStop: async () => {},
      },
    });

    const { control, record } = readOnlyMission();
    assert.equal(coord.calls.length, 1, "no coordinator dispatch after the stop request");
    assert.equal(chain.calls.length, 0, "no inner-chain seat after the stop request");
    assert.equal(sol.calls.length, 0, "no auditor (Sol) seat after the stop request");
    assert.equal(record.disposition, "cancelled");
    assert.equal(control.status, "cancelled");
    assert.equal(notify.calls.length, 1, "a cancelled mission is terminal and notifies exactly once");
    assert.equal(notify.calls[0].disposition, "cancelled");
  });

  it("cancellation during an inner chain stops the driver before any post-chain seat (criterion 4)", async () => {
    const driver = await import("./luna-driver.mjs");
    const chainWritesStop = async (chainCwd) => {
      const stDir = stateDirFor(chainCwd);
      const missionsDir = path.join(stDir, "missions");
      const ids = fs.readdirSync(missionsDir).filter((n) => n.startsWith("mission-"));
      assert.equal(ids.length, 1);
      const controlPath = path.join(missionsDir, ids[0], "control.json");
      const control = readJson(controlPath);
      writeJson(controlPath, { ...control, stopRequestedAt: new Date().toISOString(), stopRequestedBy: "luna" });
      return "chain interrupted by a stop request";
    };
    const coord = makeCoordinator([
      (input) => stream(line("run_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF })),
      finishStream("recommend-accept"),
    ]);
    const chain = makeChainFake(chainWritesStop);
    const tools = makeToolFake();
    const sol = makeSol();
    const notify = makeNotify();

    await driver.runLunaMission({
      cwd,
      missionFile,
      brief: MISSION_BRIEF,
      container: "test-cid",
      coordinator: SEATS.coordinator,
      auditor: SEATS.auditor,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      sampling: { rate: 1, salt: "v1" },
      inject: {
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: chain.run,
        callTool: tools.callTool,
        solDispatch: sol.dispatch,
        notifyMissionTerminal: notify.dispatch,
        guardedServeStop: async () => {},
      },
    });

    const { control, record } = readOnlyMission();
    assert.equal(chain.calls.length, 1, "the in-flight chain ran to its return");
    assert.equal(coord.calls.length, 1, "no coordinator dispatch after the chain returned");
    // The pre-dispatch gate fired before the chain; the post-chain gate must
    // NOT fire after the stop arrived mid-chain.
    assert.equal(sol.calls.length, 1, "only the pre-chain seat dispatch happened before the stop");
    assert.equal(sol.calls[0].envelope.gate_id, "gate-1");
    assert.equal(record.disposition, "cancelled");
    assert.equal(control.status, "cancelled");
    assert.equal(notify.calls.length, 1);
    assert.equal(notify.calls[0].disposition, "cancelled");
  });

  it("luna-resume refuses while the recorded mission process is genuinely still running (criterion 5)", async () => {
    const mod = await lunaCancelResume();
    writeMission("mission-live", { control: { pid: process.pid }, record: { pid: process.pid } });
    let driverCalls = 0;
    await assert.rejects(
      mod.cmdLunaResume(cwd, { flags: {}, text: "mission-live" }, {
        inject: { runLunaMission: async () => { driverCalls += 1; } },
        spawn: noSpawn,
      }),
      /still running|running/i,
    );
    assert.equal(driverCalls, 0, "a live mission must never be resumed");
  });

  it("luna-resume refuses while a recorded Luna/Sol job is genuinely still running (criterion 5)", async () => {
    const mod = await lunaCancelResume();
    writeMission("mission-job-live", { control: { pid: DEAD_PID } });
    // The mission process is gone, but its coordinator job is genuinely
    // running (live pid) — resume must refuse.
    writeJob("job-luna-live", {
      title: "luna mission mission-job-live: coordinator dispatch",
      process: { pid: process.pid, startTime: 123, recordedAt: "2026-09-21T00:00:00.000Z" },
    });
    let driverCalls = 0;
    await assert.rejects(
      mod.cmdLunaResume(cwd, { flags: {}, text: "mission-job-live" }, {
        inject: { runLunaMission: async () => { driverCalls += 1; } },
        spawn: noSpawn,
      }),
      /still running|running/i,
    );
    assert.equal(driverCalls, 0);
  });

  it("luna-resume refuses an already-terminal mission without an override (criterion 5)", async () => {
    const mod = await lunaCancelResume();
    writeMission("mission-done", {
      control: { status: "completed", pid: DEAD_PID },
      record: { status: "completed", disposition: "recommend-accept", recommendation: "recommend-accept" },
    });
    let driverCalls = 0;
    await assert.rejects(
      mod.cmdLunaResume(cwd, { flags: {}, text: "mission-done" }, {
        inject: { runLunaMission: async () => { driverCalls += 1; } },
        spawn: noSpawn,
      }),
      /terminal|completed|already/i,
    );
    assert.equal(driverCalls, 0, "a completed mission must not be re-run");
  });

  it("luna-resume refuses a sol-blocked mission unless a matching override is supplied (criterion 3)", async () => {
    const mod = await lunaCancelResume();
    writeMission("mission-blocked", {
      control: { status: "completed", pid: DEAD_PID },
      record: {
        status: "completed",
        disposition: "sol-blocked",
        auditGates: [{
          gateId: "gate-1", phase: "post-chain", verdict: "block",
          disposition: "verdict-recorded", envelopeSha256: "a".repeat(64),
        }],
      },
    });
    let driverCalls = 0;
    await assert.rejects(
      mod.cmdLunaResume(cwd, { flags: {}, text: "mission-blocked" }, {
        inject: { runLunaMission: async () => { driverCalls += 1; } },
        spawn: noSpawn,
      }),
      /override|blocked/i,
    );
    assert.equal(driverCalls, 0, "a Sol block cannot be cleared by resume without a human override");
  });

  it("a recorded human override (actor, reason, timestamp, original verdict) lets a blocked mission proceed (criterion 3)", async () => {
    const mod = await lunaCancelResume();
    const blockRecord = {
      type: "verdict", schema_version: 1, gate_id: "gate-1",
      envelope_sha256: "a".repeat(64), verdict: "block",
      block_reason: "wrong_premise", acknowledgement_required: true,
      summary: "The premise is unverified.",
    };
    writeMission("mission-override", {
      control: { status: "completed", pid: DEAD_PID },
      record: {
        status: "completed",
        disposition: "sol-blocked",
        auditGates: [{
          gateId: "gate-1", phase: "post-chain", verdict: "block",
          disposition: "verdict-recorded", envelopeSha256: "a".repeat(64),
          verdictRecord: blockRecord,
        }],
      },
    });

    let driverCalls = 0;
    let driverInput = null;
    await mod.cmdLunaResume(cwd, {
      flags: {
        "audit-override": "gate-1",
        "audit-override-reason": "Premise confirmed against the issue thread",
        "audit-override-by": "masuda",
      },
      text: "mission-override",
    }, {
      inject: {
        runLunaMission: async (input) => { driverCalls += 1; driverInput = input; return "resumed"; },
      },
      spawn: noSpawn,
    });

    assert.equal(driverCalls, 1, "the override lets the resume proceed to the driver exactly once");
    assert.equal(driverInput.missionId, "mission-override", "the resume hands the driver the same mission");
    const { record } = readOnlyMission();
    assert.ok(Array.isArray(record.overrides) && record.overrides.length === 1, "the override must be recorded");
    const override = record.overrides[0];
    assert.equal(override.kind, "audit-override");
    assert.equal(override.gate_id, "gate-1");
    assert.equal(override.envelope_sha256, "a".repeat(64));
    assert.equal(override.resolution, "clear", "the human's machine-readable resolution is recorded");
    assert.equal(override.by, "masuda", "the actor is recorded");
    assert.equal(override.reason, "Premise confirmed against the issue thread");
    assert.ok(
      (typeof override.timestamp === "number" && Number.isFinite(override.timestamp)) ||
      (typeof override.timestamp === "string" && override.timestamp !== ""),
      "the override must carry a timestamp",
    );
    assert.deepEqual(override.original, blockRecord, "the original verdict is embedded byte-for-byte");
  });

  it("an override request without reason or actor is refused and nothing is recorded (criterion 3)", async () => {
    const mod = await lunaCancelResume();
    const blockRecord = {
      type: "verdict", schema_version: 1, gate_id: "gate-1",
      envelope_sha256: "a".repeat(64), verdict: "block",
      block_reason: "wrong_premise", acknowledgement_required: true,
      summary: "The premise is unverified.",
    };
    writeMission("mission-override-bad", {
      control: { status: "completed", pid: DEAD_PID },
      record: {
        status: "completed",
        disposition: "sol-blocked",
        auditGates: [{
          gateId: "gate-1", phase: "post-chain", verdict: "block",
          disposition: "verdict-recorded", envelopeSha256: "a".repeat(64),
          verdictRecord: blockRecord,
        }],
      },
    });
    let driverCalls = 0;
    // No reason.
    await assert.rejects(
      mod.cmdLunaResume(cwd, {
        flags: { "audit-override": "gate-1", "audit-override-by": "masuda" },
        text: "mission-override-bad",
      }, { inject: { runLunaMission: async () => { driverCalls += 1; } }, spawn: noSpawn }),
      /reason/i,
    );
    // No actor.
    await assert.rejects(
      mod.cmdLunaResume(cwd, {
        flags: { "audit-override": "gate-1", "audit-override-reason": "x" },
        text: "mission-override-bad",
      }, { inject: { runLunaMission: async () => { driverCalls += 1; } }, spawn: noSpawn }),
      /actor|by/i,
    );
    assert.equal(driverCalls, 0, "a malformed override must never reach the driver");
    const { record } = readOnlyMission();
    assert.ok(!Array.isArray(record.overrides) || record.overrides.length === 0, "no override may be recorded");
  });

  it("resume from every persisted phase boundary: no duplicate seat dispatch, chain creation, or notification (criterion 5)", async () => {
    const mod = await lunaCancelResume();
    const now = "2026-09-21T00:00:00.000Z";

    const boundaryRows = [
      {
        name: "after mission creation",
        record: { attempts: [], chains: [], consults: [], probes: [] },
        assert: ({ m, chain, coord }) => {
          assert.equal(chain.calls.length, 0);
          assert.equal(coord.calls.length, 1, "resume continues with the next coordinator dispatch");
          assert.equal(m.record.attempts.length, 0);
          assert.equal(m.record.chains.length, 0);
        },
      },
      {
        name: "after attempt 1",
        record: {
          attempts: [{
            index: 1, kind: "run_chain", chainId: "chain-boundary-b",
            brief: VALID_RUN_CHAIN_BRIEF, status: "completed", output: "Chain chain-boundary-b completed", at: now,
          }],
          chains: ["chain-boundary-b"],
          consults: [],
          probes: [],
        },
        setup: () => {
          writeChain("chain-boundary-b", { status: "completed", pid: DEAD_PID });
          const missionDir = path.join(stateDir, "missions", "mission-boundaryb");
          fs.mkdirSync(path.join(missionDir, "evidence"), { recursive: true });
          fs.writeFileSync(path.join(missionDir, "evidence", "envelope-1.json"), '{"pre":"existing"}', "utf8");
        },
        assert: ({ m, chain }) => {
          assert.equal(chain.calls.length, 0, "the recorded attempt must never be re-executed");
          assert.equal(m.record.attempts.length, 1, "no duplicate attempt record");
          assert.equal(m.record.chains.length, 1, "no duplicate chain reference");
          const envelope1 = fs.readFileSync(path.join(m.missionDir, "evidence", "envelope-1.json"), "utf8");
          assert.equal(envelope1, '{"pre":"existing"}', "the pre-crash envelope must not be overwritten");
          assert.ok(
            fs.existsSync(path.join(m.missionDir, "evidence", "envelope-2.json")),
            "the resumed dispatch continues the evidence numbering",
          );
        },
      },
      {
        name: "after a consult",
        record: {
          attempts: [], chains: [], probes: [],
          consults: [{ action: "consult_sol", reason: "extra audit", at: now }],
        },
        assert: ({ m }) => {
          assert.equal(m.record.consults.length, 1, "a recorded consult must never be re-executed");
        },
      },
      {
        name: "after a gate verdict",
        record: {
          attempts: [], chains: [], consults: [], probes: [],
          auditGates: [{
            gateId: "gate-1", phase: "post-chain", verdict: "clear",
            disposition: "verdict-recorded", envelopeSha256: "b".repeat(64),
          }],
        },
        assert: ({ m, sol }) => {
          assert.equal(sol.calls.length, 1, "only the NEW pre-accept gate is evaluated");
          assert.equal(sol.calls[0].envelope.gate_id, "gate-2", "gate numbering continues — gate-1 is never re-run");
          assert.equal(m.record.auditGates.length, 2);
        },
      },
      {
        name: "after a probe",
        record: {
          attempts: [], chains: [], consults: [],
          probes: [{ action: "read_probe", tool: "read_file_range", path: "x", output: "y", at: now }],
        },
        assert: ({ m, tools }) => {
          assert.equal(m.record.probes.length, 1, "a recorded probe must never be re-executed");
          assert.equal(tools.calls.length, 0, "no probe tool call may repeat on resume");
        },
      },
    ];

    for (const row of boundaryRows) {
      const id = row.name === "after attempt 1" ? "mission-boundaryb" : `mission-${row.name.replace(/[^a-z0-9]+/g, "").slice(0, 10)}`;
      writeMission(id, {
        control: { pid: DEAD_PID },
        record: { ...row.record, status: "running" },
      });
      if (row.setup) row.setup();

      const h = resumeWithRealDriver(id, {
        coordinatorStreams: [finishStream("recommend-accept")],
        sampling: null,
      });
      const out = await mod.cmdLunaResume(cwd, { flags: {}, text: id }, {
        inject: {
          runLunaMission: h.seam,
          coordinatorDispatch: h.coord.dispatch,
          runChainLifecycle: h.chain.run,
          callTool: h.tools.callTool,
          solDispatch: h.sol.dispatch,
          notifyMissionTerminal: h.notify.dispatch,
          guardedServeStop: async () => {},
        },
        spawn: noSpawn,
      });

      const m = readOnlyMission();
      assert.equal(m.record.disposition, "recommend-accept", `${row.name}: resume completes the mission`);
      assert.equal(h.driverCalls, 1, `${row.name}: the driver runs exactly once`);
      assert.equal(h.notify.calls.length, 1, `${row.name}: exactly one terminal notification across the lifecycle`);
      row.assert({ m, chain: h.chain, coord: h.coord, tools: h.tools, sol: h.sol, notify: h.notify });
      assert.match(out, /mission-/, `${row.name}: resume returns a terminal summary`);

      fs.rmSync(path.join(stateDir, "missions"), { recursive: true, force: true });
      fs.rmSync(path.join(stateDir, "chains"), { recursive: true, force: true });
    }
  });

  it("resume of a stop-requested mission reconciles the inner chain, cleans the shared serve once, and buys no model seat", async () => {
    const mod = await lunaCancelResume();
    // cancel was recorded, then the mission process crashed (dead pid) before
    // it could settle anything: resume now finds the recorded stop request
    // plus a recorded inner chain and a shared serve the mission owned
    // (keepServe: true).
    const chainId = "chain-cancel-resume-stale";
    writeMission("mission-cancel-resume", {
      control: { pid: DEAD_PID, stopRequestedAt: "2026-09-21T01:00:00.000Z", stopRequestedBy: "luna" },
      record: { chains: [chainId], pid: DEAD_PID },
    });
    const chainDir = writeChain(chainId, { pid: DEAD_PID });

    // A temp kaiba db so the mission notification can be counted exactly.
    const dbPath = path.join(root, "kaiba-cancel-resume.db");
    const db = new DatabaseSync(dbPath, { open: true, write: true });
    db.exec(`
      CREATE TABLE IF NOT EXISTS actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        position REAL NOT NULL,
        author TEXT NOT NULL DEFAULT 'kusabi',
        created_at TEXT NOT NULL,
        done_at TEXT
      );
    `);
    db.close();
    const previousDb = process.env.KAIBA_DB;
    process.env.KAIBA_DB = dbPath;
    try {
      const cleanupCalls = [];
      const guardedServeStop = async (cw, sd) => { cleanupCalls.push({ cwd: cw, stateDir: sd }); };
      let driverCalls = 0;
      let coordCalls = 0;
      let solCalls = 0;
      const out = await mod.cmdLunaResume(cwd, { flags: {}, text: "mission-cancel-resume" }, {
        inject: {
          runLunaMission: async () => { driverCalls += 1; return "must never run"; },
          coordinatorDispatch: async () => { coordCalls += 1; return ""; },
          solDispatch: async () => { solCalls += 1; return ""; },
          guardedServeStop,
        },
        spawn: noSpawn,
      });

      assert.match(out, /disposition=cancelled/, `resume settles the cancelled mission: ${out}`);
      // The recorded inner chain is settled through the deterministic
      // reconciliation path (the existing chain stop lever, stale-pid branch:
      // status cancelled + finishedAt).
      const inner = readJson(path.join(chainDir, "control.json"));
      assert.equal(inner.status, "cancelled", "the stale inner chain is settled cancelled");
      assert.ok(inner.finishedAt, "the settled chain carries a finishedAt");
      assert.equal(inner.stopRequestedBy, "luna");
      // Mission-owned guarded serve cleanup runs EXACTLY once, on the
      // mission's own cwd/stateDir.
      assert.equal(cleanupCalls.length, 1, "the mission-owned serve cleanup runs exactly once");
      assert.equal(cleanupCalls[0].cwd, cwd);
      assert.equal(cleanupCalls[0].stateDir, stateDir);
      // Terminal cancellation with exactly one mission notification (no
      // duplicate inbox record, no duplicate kaiba row for the mission).
      const { control, record } = readOnlyMission();
      assert.equal(record.disposition, "cancelled");
      assert.equal(control.status, "cancelled");
      const inboxDir = path.join(stateDir, "inbox");
      const missionInbox = fs.readdirSync(inboxDir).filter((f) => f.startsWith("mission-cancel-resume."));
      assert.equal(missionInbox.length, 1, "exactly one mission inbox notification, no duplicate");
      const rows = (() => {
        const rd = new DatabaseSync(dbPath, { open: true, readOnly: true });
        try {
          return rd.prepare("SELECT * FROM actions WHERE done_at IS NULL").all();
        } finally {
          rd.close();
        }
      })();
      const missionRows = rows.filter((r) => String(r.content).includes("mission-cancel-resume"));
      assert.equal(missionRows.length, 1, "exactly one kaiba row for the cancelled mission, no duplicate");
      // No model seat is bought: the driver never runs, and no coordinator or
      // auditor dispatch is ever attempted.
      assert.equal(driverCalls, 0, "a stop-requested mission must never reach the driver");
      assert.equal(coordCalls, 0, "no coordinator seat dispatch");
      assert.equal(solCalls, 0, "no auditor (Sol) seat dispatch");
    } finally {
      if (previousDb === undefined) delete process.env.KAIBA_DB;
      else process.env.KAIBA_DB = previousDb;
    }
  });

  it("a terminal mission emits one inbox/kaiba notification and the host handoff (criterion 8)", async () => {
    const driver = await import("./luna-driver.mjs");
    // A temp kaiba db with the actions table, exactly like chain-notify tests.
    const dbPath = path.join(root, "kaiba.db");
    const db = new DatabaseSync(dbPath, { open: true, write: true });
    db.exec(`
      CREATE TABLE IF NOT EXISTS actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        position REAL NOT NULL,
        author TEXT NOT NULL DEFAULT 'kusabi',
        created_at TEXT NOT NULL,
        done_at TEXT
      );
    `);
    db.close();
    const previousDb = process.env.KAIBA_DB;
    process.env.KAIBA_DB = dbPath;
    try {
      const coord = makeCoordinator([finishStream("recommend-accept")]);
      const chain = makeChainFake();
      const tools = makeToolFake();
      const sol = makeSol();
      // NOTE: notifyMissionTerminal is deliberately NOT injected — the real
      // #531 default must emit the inbox file + kaiba row.
      await driver.runLunaMission({
        cwd,
        missionFile,
        brief: MISSION_BRIEF,
        container: "test-cid",
        coordinator: SEATS.coordinator,
        auditor: SEATS.auditor,
        allowSubstitute: false,
        budget: DEFAULT_BUDGET,
        inject: {
          coordinatorDispatch: coord.dispatch,
          runChainLifecycle: chain.run,
          callTool: tools.callTool,
          solDispatch: sol.dispatch,
          guardedServeStop: async () => {},
        },
      });

      const { record, missionDir } = readOnlyMission();
      assert.equal(record.disposition, "recommend-accept");
      // Host handoff.
      const recFile = path.join(missionDir, "recommendation.md");
      assert.ok(fs.existsSync(recFile), "the host handoff must be written");
      // Exactly one inbox notification.
      const inboxDir = path.join(stateDir, "inbox");
      assert.ok(fs.existsSync(inboxDir), "a terminal mission must write an inbox notification");
      const inboxFiles = fs.readdirSync(inboxDir).filter((f) => f.endsWith(".md"));
      assert.equal(inboxFiles.length, 1, "exactly one inbox notification per terminal mission");
      assert.match(inboxFiles[0], new RegExp(record.missionId), "the inbox names the mission");
      // Exactly one kaiba agenda row.
      const rows = (() => {
        const rd = new DatabaseSync(dbPath, { open: true, readOnly: true });
        try {
          return rd.prepare("SELECT * FROM actions WHERE done_at IS NULL").all();
        } finally {
          rd.close();
        }
      })();
      assert.equal(rows.length, 1, "exactly one kaiba agenda row per terminal mission");
    } finally {
      if (previousDb === undefined) delete process.env.KAIBA_DB;
      else process.env.KAIBA_DB = previousDb;
    }
  });
});