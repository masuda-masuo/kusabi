// luna-review-followup.test.mjs — focused regressions for the five terminal
// review findings on chain chain-mub3b6fxc819 (kusabi #530, pre-publish).
//
// Findings under test:
//   1. the driver passes keepServe: true to inner chains but never performed
//      the promised one-time outer serve cleanup — a mission that invoked
//      inner chain work must stop the shared serve exactly once (guarded,
//      best-effort), and a mission with no inner chain must not invent
//      cleanup work;
//   2. a thrown coordinatorDispatch left mission/control permanently running —
//      it must be recorded as a coordinator error and terminate
//      `coordinator-failed` with both records and the recommendation
//      finalised (no two-hour false stall);
//   3. luna-detach validated the seat/substitution flags then dropped them —
//      explicitly supplied --coordinator-model / --auditor-model /
//      --allow-substitute must reach the detached child's argv (defaults are
//      not redundantly forwarded);
//   4. createMission overwrote requested/actual provenance with model —
//      distinct requested/actual values from the resolved seat must survive;
//   5. wrong-command validation checked the kebab key `allow-substitute`
//      while parseArgs stores `allowSubstitute` — unrelated commands must
//      fail loudly on --allow-substitute.
//
// Test state: temp KUSABI_STATE_DIR and temp cwd; fake coordinator / chain /
// tool seams; no real Codex CLI, no real serve, no real companion child
// except the wrong-command CLI checks (which fail in main() before any
// mission or serve exists).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { stateDirFor, readJson, writeJson } from "./state-paths.mjs";

const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

let driverModule = null;
async function lunaDriver() {
  if (driverModule === null) driverModule = await import("./luna-driver.mjs");
  return driverModule;
}
let storeModule = null;
async function missionStore() {
  if (storeModule === null) storeModule = await import("./mission-store.mjs");
  return storeModule;
}
let cmdModule = null;
async function lunaCmd() {
  if (cmdModule === null) cmdModule = await import("./luna-cmd.mjs");
  return cmdModule;
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

/** Stateful fake coordinator: each dispatch pops the next canned stream. */
function makeCoordinator(streams) {
  const calls = [];
  return {
    calls,
    dispatch: async (input) => {
      const idx = calls.length;
      calls.push(input);
      const entry = streams[Math.min(idx, streams.length - 1)];
      if (typeof entry === "function") return entry(input);
      return entry;
    },
  };
}

const runChainStream = (brief) => (input) =>
  stream(line("run_chain", input.envelope.envelope_sha256, { brief }));

const readProbeStream = (tool, probePath) => (input) =>
  stream(line("read_probe", input.envelope.envelope_sha256, { tool, path: probePath }));

const consultStream = (reason) => (input) =>
  stream(line("consult_sol", input.envelope.envelope_sha256, { reason }));

const finishStream = (recommendation) => (input) =>
  stream(line("finish", input.envelope.envelope_sha256, { recommendation }));

const throwingStream = (err) => () => {
  throw err;
};

/** Fake runChainLifecycle: records every invocation, returns a chain line. */
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

/** Fake callTool: records invocations; the response is injectable per test. */
function makeToolFake(respond = () => ({ status: "ok", output: "canned\n" })) {
  const calls = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return respond(name, args);
    },
  };
}

/**
 * A verdict record bound to the envelope the driver handed the Sol seat —
 * the same deterministic fake pattern as the #531 Luna tests: the fake
 * mirrors the real seat, it can only judge the envelope it was given, so
 * gate_id and envelope_sha256 come from input.envelope.
 */
const verdictLine = (input, verdict, extra = {}) =>
  j({
    type: "verdict",
    schema_version: 1,
    gate_id: input.envelope.gate_id,
    envelope_sha256: input.envelope.envelope_sha256,
    verdict,
    summary: `sol:${verdict}`,
    ...extra,
  });

const clearSol = (input) => verdictLine(input, "clear");

/** Fake Sol seat: records every dispatch; default handler returns a clear verdict. */
function makeSol(handler = clearSol) {
  const calls = [];
  return {
    calls,
    dispatch: async (input) => {
      calls.push(input);
      return handler(input);
    },
  };
}

const MISSION_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-review-followup | 2026-09-21",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-driver.mjs` — the #530 driver with the review fixes.",
].join("\n");

const VALID_RUN_CHAIN_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-inner | 2026-09-21",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-wait.mjs` — the #530 wait surface.",
].join("\n");

const DEFAULT_SEATS = {
  coordinator: { provider: "codex", model: "gpt-5.6-luna" },
  auditor: { provider: "codex", model: "gpt-5.6-sol" },
};
const DEFAULT_BUDGET = { maxChains: 3, maxAttempts: 2, maxProbes: 5, maxConsults: 3 };

describe("luna review followups (chain-mub3b6fxc819)", () => {
  let root;
  let cwd;
  let stateDir;
  let previousStateDir;
  let missionFile;

  beforeEach(() => {
    root = makeTemp("kusabi-luna-followup-");
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

  /** Run the driver with canned streams and a recording serve-cleanup seam. */
  async function runMission(streams, overrides = {}) {
    const driver = await lunaDriver();
    const coord = makeCoordinator(streams);
    const chain = makeChainFake();
    const tools = makeToolFake();
    // #531: every gate evaluation dispatches the Sol seat — the fake returns
    // a schema-valid clear verdict bound to the exact envelope it was given,
    // so a recommend-accept finish clears its mandatory T11 gate and an
    // accepted consult_sol clears its additive gate (no real Codex seat is
    // ever reached from these tests).
    const sol = makeSol();
    const cleanupCalls = [];
    const guardedServeStop = async (cwdArg, stateDirArg) => {
      cleanupCalls.push({ cwd: cwdArg, stateDir: stateDirArg });
    };
    const result = await driver.runLunaMission({
      cwd,
      missionFile,
      brief: MISSION_BRIEF,
      container: "test-cid",
      ...DEFAULT_SEATS,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      ...(overrides.input ?? {}),
      inject: {
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: chain.run,
        callTool: tools.callTool,
        solDispatch: sol.dispatch,
        guardedServeStop,
        ...(overrides.inject ?? {}),
      },
    });
    return { driver, coord, chain, tools, sol, cleanupCalls, result };
  }

  function readMission() {
    const missionsDir = path.join(stateDir, "missions");
    const ids = fs.readdirSync(missionsDir).filter((n) => n.startsWith("mission-"));
    assert.equal(ids.length, 1, `exactly one mission expected, got ${ids.join(",")}`);
    const missionDir = path.join(missionsDir, ids[0]);
    return {
      missionId: ids[0],
      missionDir,
      control: readJson(path.join(missionDir, "control.json")),
      record: readJson(path.join(missionDir, "mission.json")),
    };
  }

  // -------------------------------------------------------------------------
  // finding 1 — one-time guarded outer serve cleanup
  // -------------------------------------------------------------------------

  it("a mission that invoked inner chains stops the shared serve exactly once", async () => {
    const { cleanupCalls, chain } = await runMission([
      runChainStream(VALID_RUN_CHAIN_BRIEF),
      (input) => stream(line("rework_chain", input.envelope.envelope_sha256, { brief: VALID_RUN_CHAIN_BRIEF })),
      finishStream("recommend-accept"),
    ]);
    assert.equal(chain.calls.length, 2, "two inner chains ran");
    // Two inner chain invocations still yield exactly ONE outer cleanup.
    assert.equal(cleanupCalls.length, 1, "the shared serve must be stopped exactly once");
    assert.equal(cleanupCalls[0].cwd, cwd);
    assert.equal(cleanupCalls[0].stateDir, stateDir);
    const { record } = readMission();
    assert.equal(record.disposition, "recommend-accept");
    // Under #531 the recommend-accept finish opened the mandatory T11 gate;
    // the injected clear verdict (bound to the gate envelope) let it proceed
    // and is recorded, not skipped.
    assert.ok(Array.isArray(record.auditGates), "the #531 driver must record auditGates");
    assert.equal(record.auditGates.length, 1);
    assert.equal(record.auditGates[0].phase, "pre-accept");
    assert.equal(record.auditGates[0].mandatory, true);
    assert.equal(record.auditGates[0].verdict, "clear");
  });

  it("a mission with no inner chain performs no serve cleanup", async () => {
    const { cleanupCalls, chain } = await runMission([finishStream("recommend-accept")]);
    assert.equal(chain.calls.length, 0);
    assert.equal(cleanupCalls.length, 0, "a mission with no inner chain invents no cleanup work");
  });

  it("cleanup still runs once on the coordinator-failure path after inner chain work", async () => {
    const { cleanupCalls, coord } = await runMission([
      runChainStream(VALID_RUN_CHAIN_BRIEF),
      throwingStream(new Error("backend gone")),
    ]);
    assert.equal(coord.calls.length, 2);
    const { record } = readMission();
    assert.equal(record.disposition, "coordinator-failed");
    assert.equal(cleanupCalls.length, 1, "a coordinator failure after inner work must still clean up once");
  });

  // -------------------------------------------------------------------------
  // finding 2 — a thrown coordinator dispatch terminates the mission
  // -------------------------------------------------------------------------

  it("a thrown coordinator dispatch leaves both records terminal coordinator-failed with a recorded error", async () => {
    const driver = await lunaDriver();
    const coord = makeCoordinator([
      runChainStream(VALID_RUN_CHAIN_BRIEF),
      throwingStream(new Error("codex backend unreachable")),
    ]);
    const chain = makeChainFake();
    const cleanupCalls = [];
    const guardedServeStop = async () => { cleanupCalls.push(1); };
    const summary = await driver.runLunaMission({
      cwd,
      missionFile,
      brief: MISSION_BRIEF,
      container: "test-cid",
      ...DEFAULT_SEATS,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: chain.run,
        callTool: makeToolFake().callTool,
        guardedServeStop,
      },
    });
    // Resolves normally (no throw, no two-hour false stall) with the terminal
    // outcome in the summary.
    assert.match(summary, /disposition=coordinator-failed/);

    const { missionDir, control, record } = readMission();
    assert.equal(record.status, "completed");
    assert.equal(record.disposition, "coordinator-failed");
    assert.equal(control.status, "completed", "control must not stay running");
    assert.ok(record.coordinatorErrors >= 1, "the dispatch failure must be counted");
    assert.ok(
      (record.coordinatorErrorsDetails ?? []).some((d) => /coordinator dispatch failed/.test(d.detail)),
      "the recorded error names the dispatch failure",
    );
    // Recommendation/handoff artifact finalised consistently.
    const recFile = path.join(missionDir, "recommendation.md");
    assert.ok(fs.existsSync(recFile), "recommendation artifact must exist on the failure path");
    assert.match(fs.readFileSync(recFile, "utf8"), /coordinator-failed/);
    // The chain that ran before the failure is referenced and cleaned up once.
    assert.equal(chain.calls.length, 1);
    assert.equal(cleanupCalls.length, 1);
  });

  // -------------------------------------------------------------------------
  // finding 3 — luna-detach forwards explicitly supplied seat flags
  // -------------------------------------------------------------------------

  it("cmdLunaDetach forwards every explicitly supplied seat/substitution flag to the child argv", async () => {
    const mod = await lunaCmd();
    const spawnCalls = [];
    const fakeSpawn = (cmd, args, options) => {
      spawnCalls.push({ cmd, args, options });
      return { pid: 4242, unref: () => {} };
    };
    await mod.cmdLunaDetach(
      cwd,
      {
        flags: {
          container: "test-cid",
          "mission-file": missionFile,
          "coordinator-model": "codex/gpt-5.6-luna-mini",
          "auditor-model": "codex/gpt-5.6-sol",
          allowSubstitute: true,
        },
        text: "",
      },
      { spawn: fakeSpawn, mintMissionId: () => "mission-fwd1", stateRoot: path.join(root, "state") },
    );
    assert.equal(spawnCalls.length, 1);
    const argv = spawnCalls[0].args;
    assert.ok(argv.includes("--coordinator-model") && argv.includes("codex/gpt-5.6-luna-mini"), argv.join(" "));
    assert.ok(argv.includes("--auditor-model") && argv.includes("codex/gpt-5.6-sol"), argv.join(" "));
    assert.ok(argv.includes("--allow-substitute"), argv.join(" "));
  });

  it("cmdLunaDetach does not redundantly forward the default seats when none were supplied", async () => {
    const mod = await lunaCmd();
    const spawnCalls = [];
    const fakeSpawn = (cmd, args, options) => {
      spawnCalls.push({ cmd, args, options });
      return { pid: 4242, unref: () => {} };
    };
    await mod.cmdLunaDetach(
      cwd,
      { flags: { container: "test-cid", "mission-file": missionFile }, text: "" },
      { spawn: fakeSpawn, mintMissionId: () => "mission-fwd2", stateRoot: path.join(root, "state") },
    );
    assert.equal(spawnCalls.length, 1);
    const argv = spawnCalls[0].args;
    assert.ok(!argv.includes("--coordinator-model"), "default coordinator must not be redundantly forwarded");
    assert.ok(!argv.includes("--auditor-model"), "default auditor must not be redundantly forwarded");
    assert.ok(!argv.includes("--allow-substitute"), "no substitution flag when none was supplied");
  });

  // -------------------------------------------------------------------------
  // finding 4 — createMission preserves distinct requested/actual provenance
  // -------------------------------------------------------------------------

  it("createMission preserves distinct requested/actual values from the resolved seat", async () => {
    const store = await missionStore();
    const { missionDir } = store.createMission(stateDir, {
      missionId: "mission-prov1",
      container: "test-cid",
      coordinator: {
        provider: "codex",
        model: "gpt-5.6-luna-mini",
        requested: "gpt-5.6-luna",
        actual: "gpt-5.6-luna-mini",
        substituted: true,
      },
      auditor: {
        provider: "codex",
        model: "gpt-5.6-sol",
        requested: "gpt-5.6-sol",
        actual: "gpt-5.6-sol",
        substituted: false,
      },
    });
    const record = store.readMissionRecord(missionDir);
    assert.equal(record.coordinator.requested, "gpt-5.6-luna", "requested seat must survive");
    assert.equal(record.coordinator.actual, "gpt-5.6-luna-mini", "actual seat must survive");
    assert.equal(record.coordinator.substituted, true);
    assert.equal(record.auditor.requested, "gpt-5.6-sol");
    assert.equal(record.auditor.actual, "gpt-5.6-sol");
  });

  it("createMission defaults requested/actual to the model when the seat omits them", async () => {
    const store = await missionStore();
    const { missionDir } = store.createMission(stateDir, {
      missionId: "mission-prov2",
      container: "test-cid",
      coordinator: { provider: "codex", model: "gpt-5.6-luna" },
      auditor: { provider: "codex", model: "gpt-5.6-sol" },
    });
    const record = store.readMissionRecord(missionDir);
    assert.equal(record.coordinator.requested, "gpt-5.6-luna");
    assert.equal(record.coordinator.actual, "gpt-5.6-luna");
    assert.equal(record.auditor.requested, "gpt-5.6-sol");
    assert.equal(record.auditor.actual, "gpt-5.6-sol");
  });

  // -------------------------------------------------------------------------
  // finding 5 — --allow-substitute on unrelated commands fails loudly
  // -------------------------------------------------------------------------

  function runCli(args) {
    return spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, KUSABI_STATE_DIR: path.join(root, "state") },
      timeout: 20_000,
    });
  }

  it("task --allow-substitute fails loudly (wrong-command flag hygiene)", () => {
    const result = runCli(["task", "--allow-substitute", "implement the thing"]);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /--allow-substitute/);
    assert.match(result.stdout, /only supported by/);
  });

  it("chain --allow-substitute fails loudly (wrong-command flag hygiene)", () => {
    const result = runCli(["chain", "--allow-substitute", "--container", "test-cid", "q"]);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /--allow-substitute/);
    assert.match(result.stdout, /only supported by/);
  });

  // -------------------------------------------------------------------------
  // independent review finding 1 (medium) — consult_sol bounded
  // -------------------------------------------------------------------------

  it("a consult-only coordinator reaches budget-exhausted after maxConsults with bounded dispatches", async () => {
    const { coord, chain, tools, sol, cleanupCalls } = await runMission(
      [consultStream("a"), consultStream("b"), consultStream("c"), consultStream("d")],
      { input: { budget: { ...DEFAULT_BUDGET, maxConsults: 2 } } },
    );
    // Two consultations accepted; the NEXT consult request exceeds the bound,
    // so the coordinator was dispatched exactly maxConsults + 1 times.
    assert.equal(coord.calls.length, 3, "dispatches must be bounded (maxConsults + 1)");
    assert.equal(chain.calls.length, 0, "no inner chain ran");
    assert.equal(tools.calls.length, 0, "no tool executed by the consult-only mission");
    const { missionDir, control, record } = readMission();
    assert.equal(record.status, "completed");
    assert.equal(control.status, "completed");
    assert.equal(record.disposition, "budget-exhausted");
    assert.equal(record.consults.length, 2, "exactly maxConsults consultations accepted");
    // Under #531 every accepted consult_sol opens an ADDITIVE recorded gate,
    // each cleared by the injected verdict (a consult clear is additive —
    // it can never be a substitute for a separately mandatory gate).
    assert.ok(Array.isArray(record.auditGates), "the #531 driver must record auditGates");
    assert.equal(record.auditGates.length, 2, "one additive recorded gate per accepted consult_sol");
    assert.deepEqual(
      record.auditGates.map((g) => g.phase),
      ["consult", "consult"],
    );
    assert.deepEqual(record.auditGates.map((g) => g.verdict), ["clear", "clear"]);
    for (const gate of record.auditGates) {
      assert.equal(gate.mandatory, false, "a consult gate is additive, never mandatory");
      assert.equal(gate.sampled, false, "a requested consult is not a sample");
    }
    assert.equal(sol.calls.length, 2, "each accepted consult dispatched the Sol seat exactly once");
    assert.equal(cleanupCalls.length, 0, "no inner chain — no serve cleanup");
    // The clear error/recommendation is persisted for the host.
    const recText = fs.readFileSync(path.join(missionDir, "recommendation.md"), "utf8");
    assert.match(recText, /budget-exhausted/);
    assert.match(recText, /consult_sol budget exhausted/);
  });

  it("consults within the bound do not terminate the mission", async () => {
    const { coord, sol } = await runMission([
      consultStream("one"),
      consultStream("two"),
      finishStream("recommend-accept"),
    ]);
    const { record } = readMission();
    assert.equal(coord.calls.length, 3);
    assert.equal(record.consults.length, 2);
    assert.equal(record.disposition, "recommend-accept", "a legitimate consult pattern still finishes");
    // #531: the two accepted consults each opened an additive gate AND the
    // recommend-accept finish still opened the mandatory T11 gate afterwards
    // — a consult clear is additive, never a substitute.
    assert.ok(Array.isArray(record.auditGates), "the #531 driver must record auditGates");
    assert.equal(record.auditGates.length, 3, "two consult gates + the mandatory pre-accept gate");
    assert.equal(sol.calls.length, 3, "one Sol seat dispatch per gate");
    assert.deepEqual(record.auditGates.map((g) => g.phase), ["consult", "consult", "pre-accept"]);
    assert.equal(record.auditGates[2].mandatory, true, "the finish opens the mandatory T11 gate");
    assert.equal(record.auditGates[2].verdict, "clear");
  });

  it("the effective consult bound, count and termination reason are persisted", async () => {
    await runMission([consultStream("a"), consultStream("b"), consultStream("c")], {
      input: { budget: { ...DEFAULT_BUDGET, maxConsults: 2 } },
    });
    const { record } = readMission();
    assert.equal(record.budget.maxConsults, 2, "the effective bound is persisted");
    assert.equal(record.budget.maxChains, DEFAULT_BUDGET.maxChains);
    assert.equal(record.budget.maxAttempts, DEFAULT_BUDGET.maxAttempts);
    assert.equal(record.budget.maxProbes, DEFAULT_BUDGET.maxProbes);
    assert.equal(record.consults.length, 2, "the count is persisted (consults array)");
    // The two accepted consults are also recorded as additive gates.
    assert.ok(Array.isArray(record.auditGates) && record.auditGates.length === 2,
      "each persisted accepted consult has a recorded gate");
    assert.match(record.terminationReason, /consult_sol budget exhausted/);
  });

  // -------------------------------------------------------------------------
  // independent review finding 2 (low) — probe output persisted with a bound
  // -------------------------------------------------------------------------

  it("a large probe output is capped with exact truncation metadata before persistence", async () => {
    const driver = await lunaDriver();
    const { PROBE_OUTPUT_MAX_BYTES } = driver;
    const big = "x".repeat(20_000);
    await runMission(
      [readProbeStream("read_file_range", "big"), finishStream("recommend-accept")],
      { inject: { callTool: makeToolFake(() => ({ status: "ok", output: big })).callTool } },
    );
    const { record } = readMission();
    assert.equal(record.probes.length, 1);
    const probe = record.probes[0];
    assert.equal(probe.truncated, true, "a payload over the bound must be truncated");
    assert.ok(probe.omittedBytes > 0, "the exact omitted byte count is recorded");
    assert.equal(probe.truncation, "head+tail");
    assert.ok(
      Buffer.byteLength(String(probe.output), "utf8") <= PROBE_OUTPUT_MAX_BYTES,
      `persisted payload must never exceed the documented ${PROBE_OUTPUT_MAX_BYTES}-byte bound`,
    );
    assert.equal(record.disposition, "recommend-accept");
  });

  it("a small probe output is persisted unchanged with zero omission", async () => {
    const small = { status: "ok", output: "canned\n" };
    await runMission(
      [readProbeStream("read_file_range", "small"), finishStream("recommend-accept")],
      { inject: { callTool: makeToolFake(() => small).callTool } },
    );
    const { record } = readMission();
    assert.equal(record.probes.length, 1);
    const probe = record.probes[0];
    assert.equal(probe.truncated, false, "a small result is not truncated");
    assert.equal(probe.omittedBytes, 0);
    assert.deepEqual(probe.output, small, "small results remain unchanged");
  });

  // -------------------------------------------------------------------------
  // independent review finding 3 (low) — luna-wait --next/--since rejected
  // -------------------------------------------------------------------------

  it("luna-wait --next fails loudly (named wait only)", () => {
    const result = runCli(["luna-wait", "--next", "mission-x"]);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /--next/);
    assert.match(result.stdout, /named mission/);
  });

  it("luna-wait --since fails loudly (named wait only)", () => {
    const result = runCli(["luna-wait", "--since", "2026-01-01T00:00:00Z", "mission-x"]);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /--since/);
    assert.match(result.stdout, /named mission/);
  });

  it("ordinary named luna-wait remains valid and read-only", () => {
    const missionDir = path.join(stateDir, "missions", "mission-ro");
    fs.mkdirSync(missionDir, { recursive: true });
    writeJson(path.join(missionDir, "control.json"), {
      missionId: "mission-ro",
      pid: 1,
      status: "completed",
    });
    writeJson(path.join(missionDir, "mission.json"), {
      missionId: "mission-ro",
      status: "completed",
      disposition: "recommend-accept",
      recommendation: "recommend-accept",
      attempts: [],
      chains: [],
      coordinatorErrors: 0,
      consults: [],
      coordinator: { provider: "codex", model: "gpt-5.6-luna", substituted: false },
      auditor: { provider: "codex", model: "gpt-5.6-sol", substituted: false },
    });
    const snapshot = () => {
      const out = {};
      for (const f of fs.readdirSync(missionDir).sort()) {
        const p = path.join(missionDir, f);
        out[f] = [fs.readFileSync(p, "utf8"), fs.statSync(p).mtimeMs];
      }
      return out;
    };
    const before = snapshot();
    const result = runCli(["luna-wait", "mission-ro"]);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /mission-ro/);
    assert.match(result.stdout, /recommend-accept/);
    assert.deepEqual(snapshot(), before, "luna-wait is read-only");
  });
});