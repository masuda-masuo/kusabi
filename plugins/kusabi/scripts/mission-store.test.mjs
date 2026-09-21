// mission-store.test.mjs — acceptance tests for the #530 mission store.
//
// Frozen acceptance contract (kusabi #530, criterion 3):
//   - mission state lives under the kusabi state root in `missions/<mission-id>/`;
//   - mission ids are validated path segments (a value containing `/`, `..` or a
//     NUL must never reach path.join — same boundary as assertChainIdShape);
//   - a control record and a mission record are persisted, carrying attempts,
//     inner-chain references, coordinator errors, exact seat provenance,
//     recommendation and terminal disposition;
//   - writes are atomic (the observable contract of the shared atomic replace:
//     a saved record is immediately readable as complete JSON and leaves no
//     temp-file residue behind);
//   - terminal state is sticky: once a mission record carries a terminal
//     disposition it can never be overwritten with a different one.
//
// The store module (mission-store.mjs) does not exist on pristine main — that
// IS the baseline-red signal this file proves.  Every test loads it through
// the guarded dynamic import below, so the failure mode is the clear "the #530
// mission store is not implemented yet" message, never a raw ERR_MODULE_NOT_FOUND
// trace or a syntax error in this file.
//
// Test state: every test uses a temp KUSABI_STATE_DIR and a temp cwd; nothing
// touches a real state root, a real Codex CLI, or a real companion child.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { stateDirFor, readJson } from "./state-paths.mjs";

let storeModule = null;
async function missionStore() {
  if (storeModule === null) {
    try {
      storeModule = await import("./mission-store.mjs");
    } catch (err) {
      if (err?.code === "ERR_MODULE_NOT_FOUND" && String(err?.message ?? "").includes("mission-store")) {
        throw new Error(
          "mission-store.mjs does not exist — the #530 mission store is not implemented yet " +
          "(baseline-red). The store must exist before these acceptance tests can run."
        );
      }
      throw err;
    }
  }
  return storeModule;
}

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("mission store (kusabi #530 criterion 3)", () => {
  let root;
  let cwd;
  let stateDir;
  let previousStateDir;

  beforeEach(() => {
    root = makeTemp("kusabi-mission-store-");
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

  it("surface: exports the documented store API (baseline-red on pristine main)", async () => {
    const store = await missionStore();
    for (const name of [
      "mintMissionId",
      "assertMissionIdShape",
      "createMission",
      "readMissionControl",
      "readMissionRecord",
      "saveMissionRecord",
      "TERMINAL_MISSION_DISPOSITIONS",
    ]) {
      assert.ok(store[name] !== undefined, `mission-store must export ${name}`);
    }
  });

  it("mintMissionId mints ids in the mission-[a-z0-9]+ shape", async () => {
    const store = await missionStore();
    const a = store.mintMissionId();
    const b = store.mintMissionId();
    assert.match(a, /^mission-[a-z0-9]+$/);
    assert.match(b, /^mission-[a-z0-9]+$/);
    assert.notEqual(a, b, "two minted ids must differ");
  });

  it("assertMissionIdShape rejects every value that is not a safe path segment", async () => {
    const store = await missionStore();
    store.assertMissionIdShape("mission-abc123"); // valid — no throw
    for (const bad of [
      "chain-abc",          // wrong prefix
      "mission-",           // empty tail
      "mission-A",          // uppercase
      "mission-a/b",        // path separator
      "mission-..",         // parent escape
      "../mission-x",       // escape
      "mission-a b",        // whitespace
      "mission-a\u0000b",   // NUL
      "mission-a_b",        // underscore
      "mission-ä",          // non-ASCII
      "",
      null,
      undefined,
      42,
    ]) {
      assert.throws(
        () => store.assertMissionIdShape(bad),
        (err) => {
          assert.ok(err instanceof Error);
          // the rejection names the offending id, like assertChainIdShape does
          assert.ok(String(err.message).includes(String(bad)), `message must name ${JSON.stringify(bad)}: ${err.message}`);
          return true;
        },
        `assertMissionIdShape must reject ${JSON.stringify(bad)}`,
      );
    }
  });

  it("createMission lays the state out under missions/<id>/ with a control and a mission record", async () => {
    const store = await missionStore();
    const { missionId, missionDir } = store.createMission(stateDir, {
      missionId: "mission-create1",
      container: "test-cid",
      missionFile: "/tmp/mission.md",
      pid: 4242,
      coordinator: { provider: "codex", model: "gpt-5.6-luna", substituted: false },
      auditor: { provider: "codex", model: "gpt-5.6-sol", substituted: false },
    });

    assert.equal(missionId, "mission-create1");
    assert.equal(missionDir, path.join(stateDir, "missions", "mission-create1"));
    assert.ok(fs.existsSync(path.join(missionDir, "control.json")), "control record must exist");
    assert.ok(fs.existsSync(path.join(missionDir, "mission.json")), "mission record must exist");

    const control = store.readMissionControl(missionDir);
    assert.equal(control.missionId, "mission-create1");
    assert.equal(control.pid, 4242);
    assert.equal(control.status, "running");

    const record = store.readMissionRecord(missionDir);
    assert.equal(record.missionId, "mission-create1");
    assert.equal(record.container, "test-cid");
    assert.equal(record.coordinator.model, "gpt-5.6-luna");
    assert.equal(record.auditor.model, "gpt-5.6-sol");
  });

  it("createMission refuses an invalid id BEFORE any filesystem write", async () => {
    const store = await missionStore();
    assert.throws(
      () => store.createMission(stateDir, { missionId: "mission-a/b", container: "c" }),
      /mission-a\/b/,
    );
    assert.ok(
      !fs.existsSync(path.join(stateDir, "missions", "mission-a")),
      "no mission directory may exist for a refused id",
    );
    assert.ok(
      !fs.existsSync(path.join(stateDir, "missions")),
      "no missions directory at all for a refused id",
    );
  });

  it("createMission refuses an id whose directory already exists (two missions never share a dir)", async () => {
    const store = await missionStore();
    store.createMission(stateDir, { missionId: "mission-twice", container: "c" });
    assert.throws(
      () => store.createMission(stateDir, { missionId: "mission-twice", container: "c" }),
      /mission-twice/,
    );
  });

  it("a saved mission record is complete, immediately readable JSON, with no temp residue (atomic write contract)", async () => {
    const store = await missionStore();
    const { missionDir } = store.createMission(stateDir, {
      missionId: "mission-atomic",
      container: "test-cid",
      pid: 7,
      coordinator: { provider: "codex", model: "gpt-5.6-luna", substituted: false },
      auditor: { provider: "codex", model: "gpt-5.6-sol", substituted: false },
    });
    const base = store.readMissionRecord(missionDir);

    const full = {
      ...base,
      status: "running",
      attempts: [{ index: 1, chainId: "chain-abc1", status: "completed" }],
      chains: ["chain-abc1"],
      coordinatorErrors: 2,
      coordinator: { provider: "codex", model: "gpt-5.6-luna", requested: "gpt-5.6-luna", actual: "gpt-5.6-luna", substituted: false },
      auditor: { provider: "codex", model: "gpt-5.6-sol", substituted: false },
      recommendation: null,
      disposition: null,
    };
    store.saveMissionRecord(missionDir, full);

    // Immediately readable, byte-complete, deep-equal to what was saved.
    assert.deepEqual(readJson(path.join(missionDir, "mission.json")), full);
    // No atomic-replace temp file may remain behind.
    const entries = fs.readdirSync(missionDir);
    assert.ok(!entries.some((e) => e.includes(".tmp")), `no temp residue in ${missionDir}: ${entries.join(",")}`);
  });

  it("terminal disposition is sticky: a terminal mission record can never be overwritten with a different one", async () => {
    const store = await missionStore();
    const { missionDir } = store.createMission(stateDir, {
      missionId: "mission-sticky",
      container: "test-cid",
      pid: 9,
      coordinator: { provider: "codex", model: "gpt-5.6-luna", substituted: false },
      auditor: { provider: "codex", model: "gpt-5.6-sol", substituted: false },
    });

    const base = store.readMissionRecord(missionDir);
    store.saveMissionRecord(missionDir, { ...base, status: "completed", disposition: "recommend-accept", recommendation: "recommend-accept" });

    // A later save that would change the terminal disposition is refused.
    assert.throws(
      () => store.saveMissionRecord(missionDir, { ...base, status: "running", disposition: "recommend-escalate" }),
      /recommend-accept|terminal|sticky/i,
    );
    const after = store.readMissionRecord(missionDir);
    assert.equal(after.disposition, "recommend-accept", "the terminal disposition must survive the refused update");
    assert.equal(after.status, "completed");

    // Re-saving the SAME terminal disposition (idempotent) stays allowed.
    store.saveMissionRecord(missionDir, { ...after, recommendation: "recommend-accept" });
    assert.equal(store.readMissionRecord(missionDir).disposition, "recommend-accept");
  });

  it("TERMINAL_MISSION_DISPOSITIONS names the host-facing terminal results of #530 criterion 7", async () => {
    const store = await missionStore();
    const set = store.TERMINAL_MISSION_DISPOSITIONS;
    assert.ok(Array.isArray(set) || set instanceof Set, "must be an array or Set");
    const list = [...set];
    for (const d of ["recommend-accept", "recommend-escalate", "coordinator-failed", "budget-exhausted"]) {
      assert.ok(list.includes(d), `terminal set must include ${d}`);
    }
  });

  it("mission records live under the kusabi state root only (nothing outside stateDir/missions)", async () => {
    const store = await missionStore();
    store.createMission(stateDir, { missionId: "mission-alone", container: "c" });
    const stateDirEntries = fs.readdirSync(stateDir);
    assert.ok(stateDirEntries.includes("missions"), "mission state lives under missions/");
    assert.deepEqual(
      stateDirEntries.filter((e) => /^mission-/.test(e)),
      [],
      "no mission state may exist outside missions/",
    );
    // sanity: the hash used by stateDirFor derives from the cwd (existing state-paths contract)
    const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    assert.equal(path.basename(stateDir), hash);
  });
});