// luna-cmd.test.mjs — acceptance tests for the #530 luna CLI surfaces.
//
// Frozen acceptance contract (kusabi #530 criteria 1, 2, 9, 10):
//   - `luna` / `luna-detach` take `--container <cid>` and `--mission-file <path>`;
//   - coordinator/auditor seats are selectable only through the exact mission
//     flags established by #524 (`--coordinator-model`, `--auditor-model`),
//     defaulting to the exact seats `codex/gpt-5.6-luna` and `codex/gpt-5.6-sol`;
//     any substitution fails BEFORE mission creation unless explicitly
//     authorized (`--allow-substitute`), and authorized substitution is visible
//     in records and rendered output;
//   - `luna` and `luna-detach` are job-creating commands covered by
//     KUSABI_WORKER_CONTEXT (a worker cannot recursively create a mission);
//     unknown flags and flags on the wrong command fail loudly;
//   - `luna-detach` starts exactly ONE child mission process and emits a named
//     `luna-wait <mission-id>` command; a refused dispatch never spawns;
//   - `luna-show` renders exact seat provenance, attempts/inner chains, current
//     state and recommendation, and is read-only;
//   - existing task/chain parsing remains unchanged (the mission flags are
//     rejected on non-luna subcommands; truly unknown flags still fail).
//
// All CLI-level tests spawn the real companion as a subprocess (the guard and
// the wrong-command checks live in main(), not in an exported function) — but
// never with a real mission or chain behind them: the refused dispatches exit
// before any child mission exists.  The handler-level tests use injected
// fakes.  luna-cmd.mjs does not exist on pristine main — the guarded dynamic
// import below turns that into the clear baseline-red message.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { stateDirFor, writeJson } from "./state-paths.mjs";
import { parseArgs } from "./cli.mjs";

const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

let cmdModule = null;
async function lunaCmd() {
  if (cmdModule === null) {
    try {
      cmdModule = await import("./luna-cmd.mjs");
    } catch (err) {
      if (err?.code === "ERR_MODULE_NOT_FOUND" && String(err?.message ?? "").includes("luna-cmd")) {
        throw new Error(
          "luna-cmd.mjs does not exist — the #530 luna CLI surfaces are not implemented yet " +
          "(baseline-red). The command handlers must exist before these acceptance tests can run."
        );
      }
      throw err;
    }
  }
  return cmdModule;
}

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const MISSION_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-cmd-test | 2026-09-21",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-cmd.mjs` — the #530 luna CLI surface.",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-cmd.test.mjs`",
].join("\n");

describe("luna CLI surfaces (kusabi #530 criteria 1, 2, 9, 10)", () => {
  let root;
  let cwd;
  let missionFile;
  let previousStateDir;
  let stateDir;

  beforeEach(() => {
    root = makeTemp("kusabi-luna-cmd-");
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

  /** Spawn the real companion CLI with a clean env; never a worker marker unless asked. */
  function runCli(args, { workerContext = false } = {}) {
    const env = { ...process.env, KUSABI_STATE_DIR: path.join(root, "state") };
    if (workerContext) env.KUSABI_WORKER_CONTEXT = "1";
    else delete env.KUSABI_WORKER_CONTEXT;
    return spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
      cwd,
      encoding: "utf8",
      env,
      timeout: 20_000,
    });
  }

  function missionsDirExists() {
    return fs.existsSync(path.join(stateDir, "missions"));
  }

  // -------------------------------------------------------------------------
  // cmdLuna (handler level, injected driver)
  // -------------------------------------------------------------------------

  it("surface: exports the luna command handlers (baseline-red on pristine main)", async () => {
    const mod = await lunaCmd();
    for (const name of ["cmdLuna", "cmdLunaDetach", "cmdLunaShow"]) {
      assert.equal(typeof mod[name], "function", `luna-cmd must export ${name}`);
    }
  });

  it("cmdLuna requires --container and --mission-file, refusing before the driver runs", async () => {
    const mod = await lunaCmd();
    const driver = { calls: 0, run: async () => "mission output" };

    await assert.rejects(
      mod.cmdLuna(cwd, { flags: { "mission-file": missionFile }, text: "" }, { inject: { runLunaMission: driver.run } }),
      /--container/,
    );
    await assert.rejects(
      mod.cmdLuna(cwd, { flags: { container: "test-cid" }, text: "" }, { inject: { runLunaMission: driver.run } }),
      /--mission-file/,
    );
    assert.equal(driver.calls, 0, "no mission may run when a required flag is missing");
    assert.ok(!missionsDirExists(), "no mission may be created for a refused invocation");
  });

  it("cmdLuna refuses a mission file that cannot be read", async () => {
    const mod = await lunaCmd();
    const driver = { calls: 0, run: async () => "mission output" };
    await assert.rejects(
      mod.cmdLuna(cwd, { flags: { container: "test-cid", "mission-file": path.join(root, "missing.md") }, text: "" }, { inject: { runLunaMission: driver.run } }),
      /mission file|not found|missing/i,
    );
    assert.equal(driver.calls, 0);
  });

  it("cmdLuna refuses an unauthorized seat substitution before mission creation", async () => {
    const mod = await lunaCmd();
    const driver = { calls: 0, run: async () => "mission output" };
    await assert.rejects(
      mod.cmdLuna(
        cwd,
        {
          flags: {
            container: "test-cid",
            "mission-file": missionFile,
            "coordinator-model": "codex/gpt-5.6-luna-mini",
          },
          text: "",
        },
        { inject: { runLunaMission: driver.run } },
      ),
      /substitut|allow-substitute/i,
    );
    assert.equal(driver.calls, 0, "no mission may run for an unauthorized substitution");
    assert.ok(!missionsDirExists(), "no mission may be created for an unauthorized substitution");
  });

  it("cmdLuna refuses a non-codex coordinator seat even with --allow-substitute", async () => {
    const mod = await lunaCmd();
    const driver = { calls: 0, run: async () => "mission output" };
    await assert.rejects(
      mod.cmdLuna(
        cwd,
        {
          flags: {
            container: "test-cid",
            "mission-file": missionFile,
            "coordinator-model": "opencode/deepseek-v4-flash",
            allowSubstitute: true,
          },
          text: "",
        },
        { inject: { runLunaMission: driver.run } },
      ),
      /codex/i,
    );
    assert.equal(driver.calls, 0);
    assert.ok(!missionsDirExists());
  });

  it("cmdLuna passes the default exact seats to the driver and returns its output", async () => {
    const mod = await lunaCmd();
    let received = null;
    const driver = {
      run: async (input) => {
        received = input;
        return "mission done: recommend-accept";
      },
    };
    const out = await mod.cmdLuna(
      cwd,
      { flags: { container: "test-cid", "mission-file": missionFile }, text: "" },
      { inject: { runLunaMission: driver.run } },
    );
    assert.equal(out, "mission done: recommend-accept");
    assert.equal(received.container, "test-cid");
    assert.equal(received.brief, MISSION_BRIEF, "cmdLuna resolves the mission file text for the driver");
    assert.deepEqual(received.coordinator, { provider: "codex", model: "gpt-5.6-luna", substituted: false });
    assert.deepEqual(received.auditor, { provider: "codex", model: "gpt-5.6-sol", substituted: false });
    assert.equal(received.allowSubstitute, false);
  });

  it("cmdLuna passes an authorized substitution through with the exact model", async () => {
    const mod = await lunaCmd();
    let received = null;
    const driver = {
      run: async (input) => {
        received = input;
        return "mission done";
      },
    };
    await mod.cmdLuna(
      cwd,
      {
        flags: {
          container: "test-cid",
          "mission-file": missionFile,
          "coordinator-model": "codex/gpt-5.6-luna-mini",
          allowSubstitute: true,
        },
        text: "",
      },
      { inject: { runLunaMission: driver.run } },
    );
    assert.deepEqual(received.coordinator, { provider: "codex", model: "gpt-5.6-luna-mini", substituted: true });
    assert.equal(received.allowSubstitute, true);
  });

  // -------------------------------------------------------------------------
  // cmdLunaDetach (handler level, injected spawn)
  // -------------------------------------------------------------------------

  it("cmdLunaDetach spawns exactly one child mission process and emits the exact luna-wait line", async () => {
    const mod = await lunaCmd();
    const spawnCalls = [];
    let unrefCalled = false;
    const fakeSpawn = (cmd, args, options) => {
      spawnCalls.push({ cmd, args, options });
      return { pid: 4242, unref: () => { unrefCalled = true; } };
    };

    const banner = await mod.cmdLunaDetach(
      cwd,
      { flags: { container: "test-cid", "mission-file": missionFile }, text: "" },
      { spawn: fakeSpawn, mintMissionId: () => "mission-detach1", stateRoot: path.join(root, "state") },
    );

    assert.equal(spawnCalls.length, 1, "exactly one child mission process");
    const call = spawnCalls[0];
    assert.equal(call.cmd, process.execPath);
    assert.equal(call.options.detached, true);
    const argv = call.args;
    assert.ok(argv.includes(COMPANION_SCRIPT), `argv must name the companion: ${argv.join(" ")}`);
    assert.ok(argv.includes("luna"), `argv must run the luna command: ${argv.join(" ")}`);
    assert.ok(argv.includes("--container") && argv.includes("test-cid"), argv.join(" "));
    assert.ok(argv.includes("--mission-file") && argv.includes(missionFile), argv.join(" "));
    assert.ok(argv.includes("--mission-id") && argv.includes("mission-detach1"), "the parent mints the id and hands it to the child");
    assert.equal(unrefCalled, true, "the child must be unrefed so the launcher returns");

    // The wait line names the exact mission id.
    assert.match(banner, /mission-detach1/);
    assert.match(banner, /kusabi-companion luna-wait mission-detach1/);
    assert.match(banner, /To wait for completion, run:/);
  });

  it("cmdLunaDetach refuses a missing --container or --mission-file BEFORE spawning anything", async () => {
    const mod = await lunaCmd();
    const fakeSpawn = () => { throw new Error("spawn must never be called"); };
    await assert.rejects(
      mod.cmdLunaDetach(cwd, { flags: { "mission-file": missionFile }, text: "" }, { spawn: fakeSpawn }),
      /--container/,
    );
    await assert.rejects(
      mod.cmdLunaDetach(cwd, { flags: { container: "test-cid" }, text: "" }, { spawn: fakeSpawn }),
      /--mission-file/,
    );
  });

  it("cmdLunaDetach refuses an unauthorized seat substitution BEFORE spawning anything", async () => {
    const mod = await lunaCmd();
    const fakeSpawn = () => { throw new Error("spawn must never be called"); };
    await assert.rejects(
      mod.cmdLunaDetach(
        cwd,
        {
          flags: {
            container: "test-cid",
            "mission-file": missionFile,
            "coordinator-model": "codex/gpt-5.6-luna-mini",
          },
          text: "",
        },
        { spawn: fakeSpawn },
      ),
      /substitut|allow-substitute/i,
    );
    assert.ok(!missionsDirExists(), "a refused detach creates no mission state");
  });

  // -------------------------------------------------------------------------
  // cmdLunaShow (handler level)
  // -------------------------------------------------------------------------

  function writeShownMission(id) {
    const missionDir = path.join(stateDir, "missions", id);
    fs.mkdirSync(missionDir, { recursive: true });
    writeJson(path.join(missionDir, "control.json"), {
      missionId: id,
      pid: 11,
      status: "completed",
    });
    writeJson(path.join(missionDir, "mission.json"), {
      missionId: id,
      container: "test-cid",
      status: "completed",
      disposition: "recommend-accept",
      recommendation: "recommend-accept",
      coordinator: { provider: "codex", model: "gpt-5.6-luna", requested: "gpt-5.6-luna", actual: "gpt-5.6-luna", substituted: false },
      auditor: { provider: "codex", model: "gpt-5.6-sol", substituted: false },
      attempts: [{ index: 1, chainId: "chain-show1", status: "completed" }],
      chains: ["chain-show1"],
      coordinatorErrors: 0,
    });
    return missionDir;
  }

  it("cmdLunaShow renders exact seat provenance, attempts/inner chains, state and recommendation", async () => {
    const mod = await lunaCmd();
    writeShownMission("mission-show1");
    const text = await mod.cmdLunaShow(cwd, { flags: {}, text: "mission-show1" });
    assert.match(text, /mission-show1/, "the render names the mission");
    assert.match(text, /gpt-5.6-luna/, "exact coordinator seat model");
    assert.match(text, /gpt-5.6-sol/, "exact auditor seat model");
    assert.match(text, /chain-show1/, "inner-chain reference rendered");
    assert.match(text, /recommend-accept/, "the recommendation is rendered");
    assert.match(text, /completed|recommend-accept/, "the current state is rendered");
  });

  it("cmdLunaShow is read-only and refuses a mission that does not exist", async () => {
    const mod = await lunaCmd();
    const missionDir = writeShownMission("mission-show2");
    const filesBefore = () =>
      fs.readdirSync(missionDir, { recursive: true })
        .map((f) => path.join(missionDir, f))
        .filter((p) => fs.statSync(p).isFile())
        .map((p) => [p, fs.readFileSync(p, "utf8")]);

    const before = filesBefore();
    await mod.cmdLunaShow(cwd, { flags: {}, text: "mission-show2" });
    assert.deepEqual(filesBefore(), before, "luna-show must be read-only");

    await assert.rejects(
      mod.cmdLunaShow(cwd, { flags: {}, text: "mission-missing" }),
      /mission not found|no such mission/i,
    );
  });

  // -------------------------------------------------------------------------
  // CLI level: worker-context guard, unknown flags, wrong-command flags
  // -------------------------------------------------------------------------

  it("worker-context guard: luna is refused under KUSABI_WORKER_CONTEXT (recursion is impossible)", () => {
    const result = runCli(["luna", "--container", "test-cid", "--mission-file", missionFile], { workerContext: true });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /worker context/i);
    assert.match(result.stdout, /Workers must not spawn jobs/i);
  });

  it("worker-context guard: luna-detach is refused under KUSABI_WORKER_CONTEXT", () => {
    const result = runCli(["luna-detach", "--container", "test-cid", "--mission-file", missionFile], { workerContext: true });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /worker context/i);
  });

  it("worker-context guard: luna-wait stays allowed (read-only — the guard blocks spawning, not reading)", () => {
    const result = runCli(["luna-wait", "mission-x", "--poll-interval", "1"], { workerContext: true });
    // The guard must NOT fire for a read-only wait: the failure here is the
    // (still absent or missing) mission, never the worker-context refusal.
    assert.doesNotMatch(result.stdout, /worker context/i);
  });

  it("unknown flags on luna fail loudly", () => {
    const result = runCli(["luna", "--bogus", "x"]);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /unknown flag: --bogus/);
  });

  it("mission flags on the wrong command fail loudly: --mission-file on chain", () => {
    const result = runCli(["chain", "--mission-file", missionFile, "q"]);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /--mission-file/);
    assert.match(result.stdout, /only supported by/);
  });

  it("mission creation flags on the read-only luna-wait fail loudly: --container on luna-wait", () => {
    const result = runCli(["luna-wait", "mission-x", "--container", "test-cid"]);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /--container/);
    assert.match(result.stdout, /only supported by/);
  });

  it("luna-wait without a mission id exits non-zero with a usage error", () => {
    const result = runCli(["luna-wait"]);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stdout, /mission id/i);
  });

  it("existing task/chain parsing is unchanged: parseArgs still rejects truly unknown flags", () => {
    assert.throws(() => parseArgs(["--bogus"]), /unknown flag: --bogus/);
    // --container stays a valid value flag exactly as before (task/chain surface).
    assert.deepEqual(parseArgs(["--container", "cid"]), { flags: { container: "cid" }, text: "" });
  });
});

// ---------------------------------------------------------------------------
// kusabi #532 criteria 3 and 10 — the mission show surface stays additive:
// a pre-#532 mission record renders byte-identically to the legacy digest,
// and a #532 record gains the provenance banner + recorded gate
// consultation origins without losing any legacy line.
// ---------------------------------------------------------------------------

describe("mission show observability digest (kusabi #532 criteria 3 and 10)", () => {
  let root;
  let cwd;
  let previousStateDir;
  let stateDir;

  beforeEach(() => {
    root = makeTemp("kusabi-532-luna-show-");
    cwd = path.join(root, "work");
    fs.mkdirSync(cwd, { recursive: true });
    previousStateDir = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = path.join(root, "state");
    stateDir = stateDirFor(cwd);
  });

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.KUSABI_STATE_DIR;
    else process.env.KUSABI_STATE_DIR = previousStateDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeMission(id, record) {
    const missionDir = path.join(stateDir, "missions", id);
    fs.mkdirSync(missionDir, { recursive: true });
    writeJson(path.join(missionDir, "control.json"), { missionId: id, pid: 1, status: "completed" });
    writeJson(path.join(missionDir, "mission.json"), record);
    return missionDir;
  }

  const legacyRecord = (id) => ({
    missionId: id,
    container: "test-cid",
    status: "completed",
    disposition: "recommend-accept",
    recommendation: "recommend-accept",
    coordinator: { provider: "codex", model: "gpt-5.6-luna", requested: "gpt-5.6-luna", actual: "gpt-5.6-luna", substituted: false },
    auditor: { provider: "codex", model: "gpt-5.6-sol", substituted: false },
    attempts: [{ index: 1, chainId: "chain-show1", status: "completed" }],
    chains: ["chain-show1"],
    coordinatorErrors: 0,
  });

  it("a pre-#532 record renders byte-identically to the legacy digest (existing luna-show unchanged)", async () => {
    const mod = await lunaCmd();
    writeMission("mission-legacyshow", legacyRecord("mission-legacyshow"));
    const snapshot = (await import("./luna-wait.mjs")).readMissionSnapshot(
      path.join(stateDir, "missions"),
      "mission-legacyshow",
    );
    const legacyDigest = mod.renderMissionShow(snapshot);
    const text = await mod.cmdLunaShow(cwd, { flags: {}, text: "mission-legacyshow" });
    assert.equal(text, legacyDigest, "a legacy mission must render exactly as before #532");
  });

  it("a #532 record renders the provenance banner and the recorded gate consultation origins, additively", async () => {
    const mod = await lunaCmd();
    const record = legacyRecord("mission-obsshow");
    record.coordinator.reasoningEffort = "high";
    record.auditor.reasoningEffort = "high";
    record.auditGates = [
      { gateId: "gate-1", phase: "pre-dispatch", origin: "sampled", verdict: "clear", disposition: "verdict-recorded", shadowDisposition: "audit-sample-skipped" },
      { gateId: "gate-2", phase: "pre-accept", origin: "policy-mandated", verdict: "clear", disposition: "verdict-recorded", shadowDisposition: "sol-blocked" },
    ];
    writeMission("mission-obsshow", record);

    const text = await mod.cmdLunaShow(cwd, { flags: {}, text: "mission-obsshow" });
    // Legacy lines survive.
    assert.match(text, /Coordinator seat: codex\/gpt-5\.6-luna \(substituted: false\)/);
    assert.match(text, /chain-show1/);
    // The #532 provenance banner is appended: reasoning effort per seat and
    // the recorded consultation origins of every gate.
    assert.match(text, /reasoning effort: high/);
    assert.match(text, /gate-1/);
    assert.match(text, /gate-2/);
    assert.match(text, /sampled/);
    assert.match(text, /policy-mandated/);
  });

  it("luna-show stays read-only for #532 records: rendering never writes mission state", async () => {
    const mod = await lunaCmd();
    const missionDir = writeMission("mission-readonlyshow", legacyRecord("mission-readonlyshow"));
    const filesBefore = () =>
      fs.readdirSync(missionDir, { recursive: true })
        .map((f) => path.join(missionDir, f))
        .filter((p) => fs.statSync(p).isFile())
        .sort();
    const before = filesBefore();
    await mod.cmdLunaShow(cwd, { flags: {}, text: "mission-readonlyshow" });
    const after = filesBefore();
    assert.deepEqual(after, before, "a read-only digest must not create, delete or rewrite mission state");
  });
});