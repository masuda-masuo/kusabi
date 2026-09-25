// luna-seam-brief-refusal.test.mjs — acceptance tests for dispatch-time brief
// refusal from the chain seam and coordinator-failed explanations (kusabi #579).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  BRIEF_REFUSED_CODE,
  briefRefusalError,
  isSmokeBaselineBriefFault,
  baselineRefusalError,
  renderSmokeBaselineReport,
  renderSmokeWrongAnnotationReport,
  renderSmokeDirtReport,
} from "./chain-brief-guards.mjs";
import { runChainLifecycle } from "./chain-cmd.mjs";
import {
  DEFAULT_BUDGET,
  DEFAULT_COORDINATOR_SEAT,
  DEFAULT_AUDITOR_SEAT,
  runLunaMission,
} from "./luna-driver.mjs";
import { createFakeCallTool } from "./fixtures.mjs";
import { resolveOrchestratorRecord } from "./kusabi-companion.mjs";

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

const VALID_BRIEF = [
  "Orchestrator: test-model | session s-1 | 2026-09-26",
  "",
  "## Deliverables",
  "",
  "- `src/index.js`",
  "",
  "## Smoke",
  "",
  "- `node -v`",
].join("\n");

const LOSSY_SMOKE_BRIEF = [
  "Orchestrator: test-model | session s-1 | 2026-09-26",
  "",
  "## Deliverables",
  "",
  "- `src/index.js`",
  "",
  "## Smoke",
  "",
  "- a bullet with no backticks",
].join("\n");

describe("A1: guards and chain-cmd seam brief refusal contract (#579)", () => {
  it("exports BRIEF_REFUSED_CODE and briefRefusalError helper", () => {
    assert.equal(BRIEF_REFUSED_CODE, "KUSABI_BRIEF_REFUSED");
    const err = briefRefusalError("invalid brief text");
    assert.ok(err instanceof Error);
    assert.equal(err.message, "invalid brief text");
    assert.equal(err.code, BRIEF_REFUSED_CODE);
  });

  it("isSmokeBaselineBriefFault classifies reports correctly", () => {
    const unmeasuredReport = renderSmokeBaselineReport({
      entries: [{ command: "node -v", expectedExit: 0 }],
      observed: [{ command: "node -v", observed: "unobservable" }],
    });

    const measuredRedReport = renderSmokeBaselineReport({
      entries: [{ command: "node -v", expectedExit: 0 }],
      observed: [{ command: "node -v", observed: 1 }],
    });

    const wrongAnnotationReport = renderSmokeWrongAnnotationReport({
      entries: [{ command: "node -v", expectedExit: 0, baselineRed: true }],
      observed: [{ command: "node -v", observed: 0 }],
    });

    const dirtReport = renderSmokeDirtReport({
      before: { ok: true, lines: [] },
      after: { ok: true, lines: ["?? dirty-file.txt"] },
    });

    const unverifiableReport = renderSmokeDirtReport({
      before: { ok: false, reason: "git status could not be run" },
      after: { ok: true, lines: [] },
    });

    // Null or empty
    assert.equal(isSmokeBaselineBriefFault(null), false);
    assert.equal(isSmokeBaselineBriefFault(""), false);

    // unverifiable-only → false
    assert.equal(isSmokeBaselineBriefFault(unverifiableReport), false);

    // unmeasured-only → false
    assert.equal(isSmokeBaselineBriefFault(unmeasuredReport), false);

    // unmeasured + unverifiable → false
    assert.equal(isSmokeBaselineBriefFault(`${unmeasuredReport}\n\n${unverifiableReport}`), false);

    // measured-red → true
    assert.equal(isSmokeBaselineBriefFault(measuredRedReport), true);

    // Green annotation is brief fault
    assert.equal(isSmokeBaselineBriefFault(wrongAnnotationReport), true);

    // Dirt report is author/brief fault
    assert.equal(isSmokeBaselineBriefFault(dirtReport), true);

    // unverifiable + dirt → true
    assert.equal(isSmokeBaselineBriefFault(`${unverifiableReport}\n\n${dirtReport}`), true);

    // Unmeasured accompanied by green annotation or dirt IS brief fault
    assert.equal(isSmokeBaselineBriefFault(`${unmeasuredReport}\n\n${wrongAnnotationReport}`), true);
    assert.equal(isSmokeBaselineBriefFault(`${unmeasuredReport}\n\n${dirtReport}`), true);
  });

  it("baselineRefusalError stamps BRIEF_REFUSED_CODE only when brief is at fault", () => {
    const unmeasuredReport = renderSmokeBaselineReport({
      entries: [{ command: "node -v", expectedExit: 0 }],
      observed: [{ command: "node -v", observed: "unobservable" }],
    });
    const measuredRedReport = renderSmokeBaselineReport({
      entries: [{ command: "node -v", expectedExit: 0 }],
      observed: [{ command: "node -v", observed: 1 }],
    });

    const infraErr = baselineRefusalError(unmeasuredReport);
    assert.ok(infraErr instanceof Error);
    assert.equal(infraErr.message, unmeasuredReport);
    assert.equal(infraErr.code, undefined);

    const briefErr = baselineRefusalError(measuredRedReport);
    assert.ok(briefErr instanceof Error);
    assert.equal(briefErr.message, measuredRedReport);
    assert.equal(briefErr.code, BRIEF_REFUSED_CODE);
  });

  it("runChainLifecycle throws BRIEF_REFUSED_CODE for lossy smoke brief", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-lossy-"));
    const prevStateEnv = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = path.join(tmp, "state");
    try {
      await assert.rejects(
        () =>
          runChainLifecycle(tmp, {
            flags: { container: "cid-1" },
            text: LOSSY_SMOKE_BRIEF,
            orchestrator: resolveOrchestratorRecord(LOSSY_SMOKE_BRIEF),
          }),
        (err) => {
          assert.equal(err.code, BRIEF_REFUSED_CODE);
          assert.match(err.message, /`## Smoke` heading present but no smoke entry parsed/);
          return true;
        },
      );
    } finally {
      if (prevStateEnv === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = prevStateEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("runChainLifecycle throws BRIEF_REFUSED_CODE for measured-red smoke baseline", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-red-"));
    const prevStateEnv = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = path.join(tmp, "state");
    try {
      await assert.rejects(
        () =>
          runChainLifecycle(
            tmp,
            {
              flags: { container: "cid-1" },
              text: VALID_BRIEF,
              orchestrator: resolveOrchestratorRecord(VALID_BRIEF),
            },
            {
              inject: {
                callTool: createFakeCallTool({ exitCode: 1 }),
              },
            },
          ),
        (err) => {
          assert.equal(err.code, BRIEF_REFUSED_CODE);
          assert.match(err.message, /declared ## Smoke is already red on the checkout/);
          return true;
        },
      );
    } finally {
      if (prevStateEnv === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = prevStateEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("runChainLifecycle throws plain Error without BRIEF_REFUSED_CODE for unmeasured baseline", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-unmeasured-"));
    const prevStateEnv = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = path.join(tmp, "state");
    try {
      await assert.rejects(
        () =>
          runChainLifecycle(
            tmp,
            {
              flags: { container: "cid-1" },
              text: VALID_BRIEF,
              orchestrator: resolveOrchestratorRecord(VALID_BRIEF),
            },
            {
              inject: {
                callTool: createFakeCallTool({ omitMarker: true }),
              },
            },
          ),
        (err) => {
          assert.equal(err.code, undefined);
          assert.match(err.message, /declared ## Smoke could not be measured on the checkout/);
          return true;
        },
      );
    } finally {
      if (prevStateEnv === undefined) delete process.env.KUSABI_STATE_DIR;
      else process.env.KUSABI_STATE_DIR = prevStateEnv;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("A3 & B1: Luna driver handles seam brief refusals and coordinator failures (#579)", () => {
  let root;
  let cwd;
  let stateDir;
  let previousStateDir;
  let missionFile;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-luna-seam-test-"));
    cwd = path.join(root, "work");
    fs.mkdirSync(cwd, { recursive: true });
    missionFile = path.join(root, "mission.md");
    fs.writeFileSync(missionFile, "mission brief", "utf8");
    previousStateDir = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = path.join(root, "state");
    stateDir = process.env.KUSABI_STATE_DIR;
  });

  afterEach(() => {
    if (previousStateDir === undefined) delete process.env.KUSABI_STATE_DIR;
    else process.env.KUSABI_STATE_DIR = previousStateDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function readMissionRecord() {
    const scan = (d) => {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          if (e.name.startsWith("mission-") && fs.existsSync(path.join(d, e.name, "mission.json"))) {
            return path.join(d, e.name);
          }
          const found = scan(path.join(d, e.name));
          if (found) return found;
        }
      }
      return null;
    };
    const foundDir = scan(stateDir);
    if (!foundDir) throw new Error("no mission directory found");
    return {
      missionDir: foundDir,
      missionId: path.basename(foundDir),
      record: JSON.parse(fs.readFileSync(path.join(foundDir, "mission.json"), "utf8")),
    };
  }

  it("A3: two different seam brief refusals followed by valid finish: coordinatorErrors=0, briefCorrections=2", async () => {
    const coord = makeCoordinator([
      (input) => stream(line("run_chain", input.envelope.envelope_sha256, { brief: VALID_BRIEF })),
      (input) => stream(line("run_chain", input.envelope.envelope_sha256, { brief: VALID_BRIEF })),
      (input) => stream(line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-escalate" })),
    ]);

    let seamCalls = 0;
    await runLunaMission({
      cwd,
      missionFile,
      brief: "test brief",
      container: "test-cid",
      coordinator: DEFAULT_COORDINATOR_SEAT,
      auditor: DEFAULT_AUDITOR_SEAT,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: async () => {
          seamCalls++;
          if (seamCalls === 1) throw briefRefusalError("seam smoke refusal A");
          if (seamCalls === 2) throw briefRefusalError("seam smoke refusal B");
          return "ok";
        },
        callTool: async () => ({ status: "ok", output: "" }),
        solDispatch: async () => JSON.stringify({ type: "verdict", verdict: "clear" }),
        notifyMissionTerminal: async () => {},
        guardedServeStop: async () => {},
      },
    });

    const { record } = readMissionRecord();
    assert.equal(coord.calls.length, 3);
    assert.equal(record.coordinatorErrors, 0, "seam brief refusals do not count as coordinator errors");
    assert.equal(record.briefCorrections, 2, "both seam brief refusals recorded as brief corrections");
    assert.equal(record.disposition, "recommend-escalate", "finished normally without coordinator-failed");
    assert.equal(record.briefCorrectionsDetails.length, 2);
    assert.equal(
      record.briefCorrectionsDetails[0].detail,
      "run_chain refused by the chain seam: seam smoke refusal A",
    );
    assert.equal(
      record.briefCorrectionsDetails[1].detail,
      "run_chain refused by the chain seam: seam smoke refusal B",
    );
  });

  it("A3 no-progress: two seam brief refusals with the same message end brief-correction-exhausted", async () => {
    const notifications = [];
    const coord = makeCoordinator([
      (input) => stream(line("run_chain", input.envelope.envelope_sha256, { brief: VALID_BRIEF })),
      (input) => stream(line("run_chain", input.envelope.envelope_sha256, { brief: VALID_BRIEF })),
    ]);

    await runLunaMission({
      cwd,
      missionFile,
      brief: "test brief",
      container: "test-cid",
      coordinator: DEFAULT_COORDINATOR_SEAT,
      auditor: DEFAULT_AUDITOR_SEAT,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: async () => {
          throw briefRefusalError("identical seam smoke refusal");
        },
        callTool: async () => ({ status: "ok", output: "" }),
        solDispatch: async () => JSON.stringify({ type: "verdict", verdict: "clear" }),
        notifyMissionTerminal: async (info) => { notifications.push(info); },
        guardedServeStop: async () => {},
      },
    });

    const { missionDir, record } = readMissionRecord();
    assert.equal(coord.calls.length, 2);
    assert.equal(record.coordinatorErrors, 0);
    assert.equal(record.briefCorrections, 2);
    assert.equal(record.disposition, "brief-correction-exhausted");
    assert.equal(record.terminationReason, "no progress: the same brief correction was repeated");

    const recPath = path.join(missionDir, "recommendation.md");
    const recText = fs.readFileSync(recPath, "utf8");
    assert.match(recText, /disposition: brief-correction-exhausted/);
    assert.match(recText, /reason: no progress: the same brief correction was repeated/);
    assert.match(recText, /## Last brief correction/);
    assert.match(recText, /identical seam smoke refusal/);

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].disposition, "brief-correction-exhausted");
    assert.equal(notifications[0].reason, "no progress: the same brief correction was repeated");
  });

  it("A3 infra & B1: two plain Errors from seam end coordinator-failed with reason and last error in recommendation.md", async () => {
    const notifications = [];
    const coord = makeCoordinator([
      (input) => stream(line("run_chain", input.envelope.envelope_sha256, { brief: VALID_BRIEF })),
      (input) => stream(line("run_chain", input.envelope.envelope_sha256, { brief: VALID_BRIEF })),
    ]);

    let seamCalls = 0;
    await runLunaMission({
      cwd,
      missionFile,
      brief: "test brief",
      container: "test-cid",
      coordinator: DEFAULT_COORDINATOR_SEAT,
      auditor: DEFAULT_AUDITOR_SEAT,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: async () => {
          seamCalls++;
          throw new Error(`infrastructure connection failure #${seamCalls}`);
        },
        callTool: async () => ({ status: "ok", output: "" }),
        solDispatch: async () => JSON.stringify({ type: "verdict", verdict: "clear" }),
        notifyMissionTerminal: async (info) => { notifications.push(info); },
        guardedServeStop: async () => {},
      },
    });

    const { missionDir, record } = readMissionRecord();
    assert.equal(coord.calls.length, 2);
    assert.equal(record.coordinatorErrors, 2);
    assert.equal(record.briefCorrections, 0);
    assert.equal(record.disposition, "coordinator-failed");
    assert.equal(record.terminationReason, "coordinator error budget exhausted (2/2)");

    const recPath = path.join(missionDir, "recommendation.md");
    const recText = fs.readFileSync(recPath, "utf8");
    assert.match(recText, /disposition: coordinator-failed/);
    assert.match(recText, /reason: coordinator error budget exhausted \(2\/2\)/);
    assert.match(recText, /## Last coordinator error/);
    assert.match(recText, /infrastructure connection failure #2/);

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].disposition, "coordinator-failed");
    assert.equal(notifications[0].reason, "coordinator error budget exhausted (2/2)");
  });

  it("B1: thrown coordinator dispatch carries reason and last coordinator error", async () => {
    const notifications = [];
    await runLunaMission({
      cwd,
      missionFile,
      brief: "test brief",
      container: "test-cid",
      coordinator: DEFAULT_COORDINATOR_SEAT,
      auditor: DEFAULT_AUDITOR_SEAT,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: async () => {
          throw new Error("subprocess exit status 137\nOOM killed by host");
        },
        runChainLifecycle: async () => {},
        callTool: async () => ({ status: "ok", output: "" }),
        solDispatch: async () => JSON.stringify({ type: "verdict", verdict: "clear" }),
        notifyMissionTerminal: async (info) => { notifications.push(info); },
        guardedServeStop: async () => {},
      },
    });

    const { missionDir, record } = readMissionRecord();
    assert.equal(record.disposition, "coordinator-failed");
    assert.equal(
      record.terminationReason,
      "coordinator error: coordinator dispatch failed: subprocess exit status 137",
    );

    const recPath = path.join(missionDir, "recommendation.md");
    const recText = fs.readFileSync(recPath, "utf8");
    assert.match(recText, /disposition: coordinator-failed/);
    assert.match(
      recText,
      /reason: coordinator error: coordinator dispatch failed: subprocess exit status 137/,
    );
    assert.match(recText, /## Last coordinator error/);
    assert.match(recText, /coordinator dispatch failed: subprocess exit status 137\nOOM killed by host/);

    assert.equal(notifications.length, 1);
    assert.equal(
      notifications[0].reason,
      "coordinator error: coordinator dispatch failed: subprocess exit status 137",
    );
  });

  it("A3 budget: three seam brief refusals with different messages end brief-correction-exhausted", async () => {
    const coord = makeCoordinator([
      (input) => stream(line("run_chain", input.envelope.envelope_sha256, { brief: VALID_BRIEF })),
      (input) => stream(line("run_chain", input.envelope.envelope_sha256, { brief: VALID_BRIEF })),
      (input) => stream(line("run_chain", input.envelope.envelope_sha256, { brief: VALID_BRIEF })),
    ]);

    let seamCalls = 0;
    await runLunaMission({
      cwd,
      missionFile,
      brief: "test brief",
      container: "test-cid",
      coordinator: DEFAULT_COORDINATOR_SEAT,
      auditor: DEFAULT_AUDITOR_SEAT,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: async () => {
          seamCalls++;
          throw briefRefusalError(`distinct refusal #${seamCalls}`);
        },
        callTool: async () => ({ status: "ok", output: "" }),
        solDispatch: async () => JSON.stringify({ type: "verdict", verdict: "clear" }),
        notifyMissionTerminal: async () => {},
        guardedServeStop: async () => {},
      },
    });

    const { missionDir, record } = readMissionRecord();
    assert.equal(coord.calls.length, 3);
    assert.equal(record.coordinatorErrors, 0);
    assert.equal(record.briefCorrections, 3);
    assert.equal(record.disposition, "brief-correction-exhausted");
    assert.equal(record.terminationReason, "brief correction budget exhausted (3/3)");

    const recPath = path.join(missionDir, "recommendation.md");
    const recText = fs.readFileSync(recPath, "utf8");
    assert.match(recText, /disposition: brief-correction-exhausted/);
    assert.match(recText, /reason: brief correction budget exhausted \(3\/3\)/);
    assert.match(recText, /## Last brief correction/);
    assert.match(recText, /distinct refusal #3/);
  });
});
