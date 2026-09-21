// luna-wait.test.mjs — acceptance tests for the #530 luna-wait machinery.
//
// Frozen acceptance contract (kusabi #530 criterion 9):
//   - `luna-wait` waits for a NAMED mission (no --next, no recency selection —
//     the detach launcher hands the exact mission id back);
//   - it is read-only: waiting never writes, modifies or removes mission state;
//   - it is SIGTERM-safe: a pure poll loop with no child processes — killing
//     the wait leaves no state change and no orphan;
//   - it exits non-zero (throws MissionWaitError) for a missing mission, a
//     malformed mission id, a mission whose records are malformed, or a
//     progress timeout;
//   - a terminal mission (control status terminal, or a terminal disposition in
//     the mission record even while the control still says running — the
//     pre-finalise window) resolves with a digest.
//
// The wait never touches the real Codex CLI or a real companion child.  The
// only subprocess in this file is the SIGTERM test's own node child, which
// runs the wait on a fabricated mission directory.  luna-wait.mjs does not
// exist on pristine main — the guarded dynamic import below turns that into
// the clear baseline-red message.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { stateDirFor, writeJson } from "./state-paths.mjs";

let waitModule = null;
async function lunaWait() {
  if (waitModule === null) {
    try {
      waitModule = await import("./luna-wait.mjs");
    } catch (err) {
      if (err?.code === "ERR_MODULE_NOT_FOUND" && String(err?.message ?? "").includes("luna-wait")) {
        throw new Error(
          "luna-wait.mjs does not exist — the #530 luna-wait machinery is not implemented yet " +
          "(baseline-red). The wait must exist before these acceptance tests can run."
        );
      }
      throw err;
    }
  }
  return waitModule;
}

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Content + mtime of every file under a mission dir, for read-only checks. */
function readSnapshot(missionDir) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, e);
      if (fs.statSync(p).isDirectory()) walk(p);
      else {
        out[p] = {
          content: fs.readFileSync(p, "utf8"),
          mtimeMs: fs.statSync(p).mtimeMs,
        };
      }
    }
  };
  walk(missionDir);
  return out;
}

describe("luna-wait (kusabi #530 criterion 9)", () => {
  let root;
  let cwd;
  let missionsDir;
  let previousStateDir;

  beforeEach(() => {
    root = makeTemp("kusabi-luna-wait-");
    cwd = path.join(root, "work");
    fs.mkdirSync(cwd, { recursive: true });
    previousStateDir = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = path.join(root, "state");
    missionsDir = path.join(stateDirFor(cwd), "missions");
    fs.mkdirSync(missionsDir, { recursive: true });
  });

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.KUSABI_STATE_DIR;
    else process.env.KUSABI_STATE_DIR = previousStateDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Fabricate a mission dir: control.json + mission.json. */
  function writeMission(id, { control = {}, record = {} } = {}) {
    const missionDir = path.join(missionsDir, id);
    fs.mkdirSync(missionDir, { recursive: true });
    writeJson(path.join(missionDir, "control.json"), {
      missionId: id,
      pid: 1234,
      status: "running",
      ...control,
    });
    writeJson(path.join(missionDir, "mission.json"), {
      missionId: id,
      status: "running",
      disposition: null,
      recommendation: null,
      attempts: [],
      chains: [],
      coordinatorErrors: 0,
      coordinator: { provider: "codex", model: "gpt-5.6-luna", substituted: false },
      auditor: { provider: "codex", model: "gpt-5.6-sol", substituted: false },
      ...record,
    });
    return missionDir;
  }

  /** A clock the wait's injected `now`/`sleep` can drive deterministically. */
  function makeClock({ pollIntervalMs = 1000 } = {}) {
    let t = 1_000_000;
    let sleeps = 0;
    return {
      now: () => t,
      sleep: async () => {
        sleeps += 1;
        t += pollIntervalMs;
      },
      sleeps: () => sleeps,
    };
  }

  it("surface: exports the wait machinery (baseline-red on pristine main)", async () => {
    const w = await lunaWait();
    assert.equal(typeof w.waitForMission, "function");
    assert.equal(typeof w.readMissionSnapshot, "function");
    assert.equal(typeof w.MissionWaitError, "function");
  });

  it("TERMINAL_MISSION_DISPOSITIONS names the #530 terminal dispositions", async () => {
    const w = await lunaWait();
    const list = [...w.TERMINAL_MISSION_DISPOSITIONS];
    for (const d of ["recommend-accept", "recommend-escalate", "coordinator-failed", "budget-exhausted"]) {
      assert.ok(list.includes(d), `terminal set must include ${d}`);
    }
  });

  it("waits for a named mission and resolves with a digest when the control record is terminal", async () => {
    const w = await lunaWait();
    const missionDir = writeMission("mission-wait1", {
      control: { status: "completed" },
      record: { disposition: "recommend-accept", recommendation: "recommend-accept" },
    });
    const clock = makeClock();
    const outcome = await w.waitForMission({
      missionsDir,
      missionId: "mission-wait1",
      pollIntervalMs: 1000,
      appearTimeoutMs: 30_000,
      progressTimeoutMs: 60_000,
      sleep: clock.sleep,
      now: clock.now,
    });
    assert.equal(outcome.missionId, "mission-wait1");
    assert.ok(outcome.digest.includes("mission-wait1"), `digest names the mission: ${outcome.digest}`);
    assert.ok(outcome.digest.includes("recommend-accept"), `digest reports the disposition: ${outcome.digest}`);
    assert.equal(clock.sleeps(), 0, "an already-terminal mission resolves without polling");
    // read-only even on the terminal path.
    assert.ok(fs.existsSync(path.join(missionDir, "mission.json")));
  });

  it("a terminal disposition in the mission record is terminal even while the control still says running (pre-finalise window)", async () => {
    const w = await lunaWait();
    writeMission("mission-wait2", {
      control: { status: "running" },
      record: { status: "running", disposition: "recommend-escalate", recommendation: "recommend-escalate" },
    });
    const clock = makeClock();
    const outcome = await w.waitForMission({
      missionsDir,
      missionId: "mission-wait2",
      pollIntervalMs: 1000,
      appearTimeoutMs: 30_000,
      progressTimeoutMs: 60_000,
      sleep: clock.sleep,
      now: clock.now,
    });
    assert.ok(outcome.digest.includes("recommend-escalate"), outcome.digest);
  });

  it("exits non-zero for a missing mission: the named mission never appears within the appear window", async () => {
    const w = await lunaWait();
    const clock = makeClock({ pollIntervalMs: 1000 });
    await assert.rejects(
      w.waitForMission({
        missionsDir,
        missionId: "mission-nope",
        pollIntervalMs: 1000,
        appearTimeoutMs: 3000,
        progressTimeoutMs: 60_000,
        sleep: clock.sleep,
        now: clock.now,
      }),
      (err) => {
        assert.ok(err instanceof w.MissionWaitError, "missing mission is a wait failure, not a digest");
        assert.ok(String(err.message).includes("mission-nope"), err.message);
        assert.ok(String(err.message).includes("appear"), err.message);
        return true;
      },
    );
  });

  it("exits non-zero for a malformed mission id — refused before any polling", async () => {
    const w = await lunaWait();
    const clock = makeClock();
    for (const bad of ["chain-x", "mission-a/b", "mission-..", "mission-x y"]) {
      await assert.rejects(
        w.waitForMission({
          missionsDir,
          missionId: bad,
          pollIntervalMs: 1000,
          appearTimeoutMs: 30_000,
          progressTimeoutMs: 60_000,
          sleep: clock.sleep,
          now: clock.now,
        }),
        (err) => {
          assert.ok(err instanceof w.MissionWaitError, `malformed id ${JSON.stringify(bad)} is a usage failure`);
          return true;
        },
        `malformed id must be refused: ${JSON.stringify(bad)}`,
      );
    }
    assert.equal(clock.sleeps(), 0, "a malformed id is refused with no sleep at all");
  });

  it("exits non-zero when no mission id is given at all", async () => {
    const w = await lunaWait();
    const clock = makeClock();
    await assert.rejects(
      w.waitForMission({
        missionsDir,
        missionId: null,
        pollIntervalMs: 1000,
        appearTimeoutMs: 30_000,
        progressTimeoutMs: 60_000,
        sleep: clock.sleep,
        now: clock.now,
      }),
      (err) => err instanceof w.MissionWaitError,
    );
  });

  it("exits non-zero for a malformed mission record — never treated as terminal, fails on the progress timeout", async () => {
    const w = await lunaWait();
    const missionDir = path.join(missionsDir, "mission-garbage");
    fs.mkdirSync(missionDir, { recursive: true });
    fs.writeFileSync(path.join(missionDir, "mission.json"), "{ not json", "utf8");
    writeJson(path.join(missionDir, "control.json"), { missionId: "mission-garbage", pid: 1, status: "running" });

    // The malformed record is not terminal; a wait bounded by the progress
    // timeout fails non-zero (stalled) instead of resolving.
    const clock = makeClock({ pollIntervalMs: 1000 });
    await assert.rejects(
      w.waitForMission({
        missionsDir,
        missionId: "mission-garbage",
        pollIntervalMs: 1000,
        appearTimeoutMs: 30_000,
        progressTimeoutMs: 3000,
        sleep: clock.sleep,
        now: clock.now,
      }),
      (err) => {
        assert.ok(err instanceof w.MissionWaitError);
        assert.equal(err.code, "stalled");
        return true;
      },
    );
  });

  it("exits non-zero on a progress timeout when the mission stops moving while alive", async () => {
    const w = await lunaWait();
    writeMission("mission-stuck", { control: { status: "running" }, record: { status: "running" } });
    const clock = makeClock({ pollIntervalMs: 1000 });
    await assert.rejects(
      w.waitForMission({
        missionsDir,
        missionId: "mission-stuck",
        pollIntervalMs: 1000,
        appearTimeoutMs: 30_000,
        progressTimeoutMs: 3000,
        sleep: clock.sleep,
        now: clock.now,
      }),
      (err) => {
        assert.ok(err instanceof w.MissionWaitError);
        assert.equal(err.code, "stalled");
        assert.ok(String(err.message).includes("mission-stuck"), err.message);
        return true;
      },
    );
  });

  it("waiting is read-only: no file under the mission dir changes while the wait runs", async () => {
    const w = await lunaWait();
    const missionDir = writeMission("mission-ro", {
      control: { status: "completed" },
      record: { disposition: "recommend-accept" },
    });
    const before = readSnapshot(missionDir);
    const clock = makeClock();
    await w.waitForMission({
      missionsDir,
      missionId: "mission-ro",
      pollIntervalMs: 1000,
      appearTimeoutMs: 30_000,
      progressTimeoutMs: 60_000,
      sleep: clock.sleep,
      now: clock.now,
    });
    assert.deepEqual(readSnapshot(missionDir), before, "waiting must never write mission state");
  });

  it("luna-wait is SIGTERM-safe: killing the wait leaves the mission state untouched", async () => {
    const missionDir = writeMission("mission-sigterm", { control: { status: "running" }, record: { status: "running" } });
    const before = readSnapshot(missionDir);

    const waitModuleUrl = pathToFileURL(path.join(import.meta.dirname, "luna-wait.mjs")).href;
    const code = [
      `const mod = await import(${JSON.stringify(waitModuleUrl)});`,
      `const args = JSON.parse(process.env.MISSION_WAIT_ARGS);`,
      `await mod.waitForMission(args);`,
    ].join("");
    const env = {
      ...process.env,
      KUSABI_STATE_DIR: path.join(root, "state"),
      MISSION_WAIT_ARGS: JSON.stringify({
        missionsDir,
        missionId: "mission-sigterm",
        pollIntervalMs: 50,
        appearTimeoutMs: 600_000,
        progressTimeoutMs: 600_000,
      }),
    };
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Attach the close listener immediately: a child that dies before the
    // sleep below (baseline: the missing module fails fast) must still be
    // observed, or the close event is missed and the promise would hang.
    const exitPromise = new Promise((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal }));
    });

    // Let the wait start polling, then terminate it.
    await new Promise((resolve) => setTimeout(resolve, 700));
    child.kill("SIGTERM");
    // Backstop: never let this test hang if the child ignores SIGTERM.
    const guard = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, 3000);
    let exit;
    try {
      exit = await exitPromise;
    } finally {
      clearTimeout(guard);
    }

    // The wait is a pure poll loop: SIGTERM kills it by signal (never a
    // graceful 0 — there is no work to finish), and the mission state is
    // byte-identical afterwards.
    assert.equal(exit.signal, "SIGTERM", `child must die by SIGTERM, got code=${exit.code} signal=${exit.signal}`);
    assert.deepEqual(readSnapshot(missionDir), before, "a SIGTERMed wait must not touch mission state");
  });
});