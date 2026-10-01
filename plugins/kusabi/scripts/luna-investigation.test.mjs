// luna-investigation.test.mjs — acceptance tests for pre-mission investigation (kusabi #591)
//
// Criteria:
// 1. With stub seams, a mission's first coordinator dispatch receives an envelope
//    whose items include the fact sheet, and the fact sheet file contains the
//    stub baseline and the stub investigation body verbatim.
// 2. The investigation seam is called exactly once per mission, before the first
//    coordinator dispatch — including across a cancel + resume, and not at all on
//    resume when record.investigation.status === "completed".
// 3. An investigation seam that throws, or returns an empty/whitespace body, or a
//    baseline seam that throws, ends the mission host-handoff with reason prefix
//    investigation failed:; the coordinator seam is never called; recommendation.md
//    contains the reason; exactly one terminal notification fires.
// 4. mission.json carries the investigation object with the fields in Spec 5;
//    luna-show (render-mission) prints the investigation line for completed and failed cases.
// 5. DEFAULT_BUDGET.maxInvestigations === 1; the remaining-budget text and preflight
//    for probes/chains/attempts/consults are unchanged.
// 6. The default investigationDispatch routes through the plan phase's configured chain:
//    a unit test (with the dispatch internals stubbed) shows phase plan, the mission
//    container, and no codex model.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  runLunaMission,
  DEFAULT_BUDGET,
  defaultInvestigationDispatch,
} from "./luna-driver.mjs";
import { stateDirFor, readJson } from "./state-paths.mjs";
import { renderMissionDigest } from "./render-mission.mjs";
import { renderRemainingBudget } from "./luna-prompt.mjs";
import { missionEvidenceItems } from "./luna-sol-gate.mjs";
import {
  j,
  line,
  stream,
  makeCoordinator,
  makeTemp,
} from "./luna-test-fixtures.mjs";

const MISSION_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-investigation-test | 2026-09-27",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-driver.mjs` — pre-mission investigation step.",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-investigation.test.mjs`",
].join("\n");

const DEFAULT_SEATS = {
  coordinator: { provider: "codex", model: "gpt-6-luna" },
  auditor: { provider: "codex", model: "gpt-6.1-sol" },
};

describe("luna investigation (kusabi #591)", () => {
  let root;
  let cwd;
  let stateDir;
  let previousStateDir;
  let missionFile;

  beforeEach(() => {
    root = makeTemp("kusabi-luna-inv-");
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

  it("criterion 1: first coordinator envelope includes fact sheet; fact sheet file contains baseline and body verbatim", async () => {
    const stubBaseline = {
      collected: 4342,
      gates: { gate_passed: true, lint: 0, types: 0 },
    };
    const stubBody = "## Relevant Locations\n- plugins/kusabi/scripts/luna-driver.mjs:125\n\n## Risks\n- None identified";

    const coord = makeCoordinator([
      (input) => stream(line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-escalate" })),
    ]);

    const notifications = [];
    const input = {
      cwd,
      missionFile,
      brief: MISSION_BRIEF,
      container: "test-cid-591",
      ...DEFAULT_SEATS,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: coord.dispatch,
        solDispatch: async () => j({ type: "verdict", verdict: "clear" }),
        notifyMissionTerminal: async (n) => { notifications.push(n); },
        investigationDispatch: async () => ({
          jobId: "job-inv-c1",
          requestedModel: "opencode/flash",
          actualModel: "opencode/flash",
          body: stubBody,
        }),
        baseline: async () => stubBaseline,
      },
    };

    await runLunaMission(input);

    assert.equal(coord.calls.length, 1, "coordinator dispatch must be called once");
    const firstEnvelope = coord.calls[0].envelope;
    assert.ok(firstEnvelope, "first dispatch must receive an envelope");

    const factSheetItem = firstEnvelope.items.find(
      (i) => i.path === "evidence/fact-sheet.md" || i.source === "fact-sheet",
    );
    assert.ok(factSheetItem, "envelope items must include the fact sheet item");
    assert.equal(factSheetItem.role, "worker_report");
    assert.equal(factSheetItem.path, "evidence/fact-sheet.md");

    // Read fact sheet file from disk
    const missions = fs.readdirSync(path.join(stateDir, "missions"));
    assert.equal(missions.length, 1);
    const missionDir = path.join(stateDir, "missions", missions[0]);
    const factSheetPath = path.join(missionDir, "evidence", "fact-sheet.md");
    assert.ok(fs.existsSync(factSheetPath), "fact sheet file must exist in evidence directory");

    const factSheetText = fs.readFileSync(factSheetPath, "utf8");
    assert.ok(factSheetText.includes("Collected tests: 4342"), "fact sheet must contain stub baseline");
    assert.ok(factSheetText.includes("Verify gate: passed"), "fact sheet must contain gate state");
    assert.ok(factSheetText.includes(stubBody), "fact sheet must contain stub body verbatim");
  });

  it("criterion 2: investigation seam is called exactly once before first coordinator dispatch; not repeated on resume", async () => {
    let investigationCalls = 0;
    let baselineCalls = 0;
    const callOrder = [];

    const coord = makeCoordinator([
      (input) => {
        callOrder.push("coordinator");
        return stream(line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-escalate" }));
      },
    ]);

    const stubSeams = {
      investigationDispatch: async () => {
        investigationCalls++;
        callOrder.push("investigation");
        return {
          jobId: "job-inv-c2",
          requestedModel: "opencode/flash",
          actualModel: "opencode/flash",
          body: "## Findings\n- Good",
        };
      },
      baseline: async () => {
        baselineCalls++;
        callOrder.push("baseline");
        return { collected: 100, gates: { gate_passed: true } };
      },
    };

    const missionId = "mission-invc2";
    const input = {
      cwd,
      missionFile,
      missionId,
      brief: MISSION_BRIEF,
      container: "test-cid-591",
      ...DEFAULT_SEATS,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: coord.dispatch,
        solDispatch: async () => j({ type: "verdict", verdict: "clear" }),
        notifyMissionTerminal: async () => {},
        ...stubSeams,
      },
    };

    await runLunaMission(input);

    assert.equal(investigationCalls, 1, "investigation seam must be called once");
    assert.equal(baselineCalls, 1, "baseline seam must be called once");
    assert.deepEqual(callOrder, ["baseline", "investigation", "coordinator"], "investigation must run before first coordinator dispatch");

    // Resume the completed mission: investigation must not run again
    await runLunaMission(input);
    assert.equal(investigationCalls, 1, "investigation seam must not be called again on resume when completed");
    assert.equal(baselineCalls, 1, "baseline seam must not be called again on resume when completed");
  });

  it("criterion 3a: investigationDispatch throwing ends mission host-handoff before coordinator dispatch", async () => {
    let coordinatorCalled = false;
    const notifications = [];
    const missionId = "mission-invfailthrow";

    const input = {
      cwd,
      missionFile,
      missionId,
      brief: MISSION_BRIEF,
      container: "test-cid-591",
      ...DEFAULT_SEATS,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: async () => { coordinatorCalled = true; return ""; },
        notifyMissionTerminal: async (n) => { notifications.push(n); },
        investigationDispatch: async () => { throw new Error("opencode worker timed out"); },
        baseline: async () => ({ collected: 10, gates: { gate_passed: true } }),
      },
    };

    const result = await runLunaMission(input);
    assert.equal(coordinatorCalled, false, "coordinator must never be called when investigation fails");
    assert.match(result, /disposition=host-handoff/);
    assert.equal(notifications.length, 1, "exactly one terminal notification must fire");
    assert.match(notifications[0].reason, /^investigation failed: opencode worker timed out/);

    const missionDir = path.join(stateDir, "missions", missionId);
    const recText = fs.readFileSync(path.join(missionDir, "recommendation.md"), "utf8");
    assert.match(recText, /^disposition: host-handoff/m);
    assert.match(recText, /^reason: investigation failed: opencode worker timed out/m);

    const record = readJson(path.join(missionDir, "mission.json"));
    assert.equal(record.disposition, "host-handoff");
    assert.equal(record.hostInterventions, 1);
    assert.match(record.hostInterventionDetails[0].detail, /^investigation failed:/);
  });

  it("criterion 3b: investigationDispatch returning empty or whitespace body ends mission host-handoff", async () => {
    let coordinatorCalled = false;
    const notifications = [];
    const missionId = "mission-invfailempty";

    const input = {
      cwd,
      missionFile,
      missionId,
      brief: MISSION_BRIEF,
      container: "test-cid-591",
      ...DEFAULT_SEATS,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: async () => { coordinatorCalled = true; return ""; },
        notifyMissionTerminal: async (n) => { notifications.push(n); },
        investigationDispatch: async () => ({
          jobId: "job-empty",
          requestedModel: "m",
          actualModel: "m",
          body: "   \n\t  ",
        }),
        baseline: async () => ({ collected: 10, gates: { gate_passed: true } }),
      },
    };

    const result = await runLunaMission(input);
    assert.equal(coordinatorCalled, false, "coordinator must never be called");
    assert.match(result, /disposition=host-handoff/);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].reason, /^investigation failed:/);

    const missionDir = path.join(stateDir, "missions", missionId);
    const recText = fs.readFileSync(path.join(missionDir, "recommendation.md"), "utf8");
    assert.match(recText, /reason: investigation failed:/);
  });

  it("criterion 3c: baseline seam throwing ends mission host-handoff before coordinator dispatch", async () => {
    let coordinatorCalled = false;
    let investigationCalled = false;
    const notifications = [];
    const missionId = "mission-invfailbaseline";

    const input = {
      cwd,
      missionFile,
      missionId,
      brief: MISSION_BRIEF,
      container: "test-cid-591",
      ...DEFAULT_SEATS,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: async () => { coordinatorCalled = true; return ""; },
        notifyMissionTerminal: async (n) => { notifications.push(n); },
        investigationDispatch: async () => { investigationCalled = true; return { body: "ok" }; },
        baseline: async () => { throw new Error("container unreachable"); },
      },
    };

    const result = await runLunaMission(input);
    assert.equal(coordinatorCalled, false, "coordinator must never be called");
    assert.equal(investigationCalled, false, "investigation job must not be dispatched when baseline throws");
    assert.match(result, /disposition=host-handoff/);
    assert.equal(notifications.length, 1);
    assert.match(notifications[0].reason, /^investigation failed: container unreachable/);

    const missionDir = path.join(stateDir, "missions", missionId);
    const recText = fs.readFileSync(path.join(missionDir, "recommendation.md"), "utf8");
    assert.match(recText, /reason: investigation failed: container unreachable/);
  });

  it("criterion 4: mission.json carries investigation object; luna-show prints investigation line", async () => {
    // 4a: Completed case
    const missionId = "mission-invc4complete";
    const coord = makeCoordinator([
      (input) => stream(line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-escalate" })),
    ]);

    await runLunaMission({
      cwd,
      missionFile,
      missionId,
      brief: MISSION_BRIEF,
      container: "test-cid-591",
      ...DEFAULT_SEATS,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: coord.dispatch,
        solDispatch: async () => j({ type: "verdict", verdict: "clear" }),
        notifyMissionTerminal: async () => {},
        investigationDispatch: async () => ({
          jobId: "job-inv-42",
          requestedModel: "deepseek/flash",
          actualModel: "deepseek/flash",
          body: "## Report body",
        }),
        baseline: async () => ({
          collected: 4342,
          gates: { gate_passed: true, lint: 0, types: 0 },
        }),
      },
    });

    const missionDir = path.join(stateDir, "missions", missionId);
    const record = readJson(path.join(missionDir, "mission.json"));
    assert.ok(record.investigation, "mission.json must carry investigation object");
    assert.equal(record.investigation.status, "completed");
    assert.equal(record.investigation.jobId, "job-inv-42");
    assert.equal(record.investigation.phase, "plan");
    assert.equal(record.investigation.requestedModel, "deepseek/flash");
    assert.equal(record.investigation.actualModel, "deepseek/flash");
    assert.equal(typeof record.investigation.startedAt, "string");
    assert.equal(typeof record.investigation.finishedAt, "string");
    assert.equal(record.investigation.factSheetPath, "evidence/fact-sheet.md");
    assert.deepEqual(record.investigation.baseline.collected, 4342);

    const showCompleted = renderMissionDigest({ missionId, status: "completed", record });
    assert.match(showCompleted, /investigation:/);
    assert.match(showCompleted, /status: completed/);
    assert.match(showCompleted, /deepseek\/flash/);
    assert.match(showCompleted, /job-inv-42/);
    assert.match(showCompleted, /4342/);

    // 4b: Failed case
    const failedMissionId = "mission-invc4failed";
    await runLunaMission({
      cwd,
      missionFile,
      missionId: failedMissionId,
      brief: MISSION_BRIEF,
      container: "test-cid-591",
      ...DEFAULT_SEATS,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: async () => "",
        notifyMissionTerminal: async () => {},
        investigationDispatch: async () => { throw new Error("network partition"); },
        baseline: async () => ({ collected: 4342, gates: { gate_passed: true } }),
      },
    });

    const failedRecord = readJson(path.join(stateDir, "missions", failedMissionId, "mission.json"));
    assert.ok(failedRecord.investigation);
    assert.equal(failedRecord.investigation.status, "failed");
    assert.equal(failedRecord.investigation.phase, "plan");
    assert.match(failedRecord.investigation.error, /network partition/);

    const showFailed = renderMissionDigest({ missionId: failedMissionId, status: "completed", record: failedRecord });
    assert.match(showFailed, /investigation:/);
    assert.match(showFailed, /status: failed/);
    assert.match(showFailed, /network partition/);
  });

  it("criterion 5: DEFAULT_BUDGET.maxInvestigations === 1; remaining-budget text is unchanged", () => {
    assert.equal(DEFAULT_BUDGET.maxInvestigations, 1);
    assert.equal(DEFAULT_BUDGET.maxChains, 3);
    assert.equal(DEFAULT_BUDGET.maxAttempts, 2);
    assert.equal(DEFAULT_BUDGET.maxProbes, 5);
    assert.equal(DEFAULT_BUDGET.maxConsults, 3);
    assert.equal(DEFAULT_BUDGET.maxRework, 1);
    assert.equal(DEFAULT_BUDGET.maxBriefCorrections, 3);

    // Remaining budget text only displays probes, attempts, chains, consults
    const text = renderRemainingBudget({
      budget: DEFAULT_BUDGET,
      probes: [],
      attempts: [],
      chains: [],
      consults: [],
    });
    assert.match(text, /remaining probes: 5/);
    assert.match(text, /remaining attempts: 2/);
    assert.match(text, /remaining chains: 3/);
    assert.match(text, /remaining consults: 3/);
    assert.doesNotMatch(text, /investigations/);
  });

  it("criterion 6: default investigationDispatch routes through plan phase configured chain without codex", async () => {
    let capturedArgs = null;
    const stubDispatch = async (args) => {
      capturedArgs = args;
      return {
        job: {
          id: "job-unit-plan-1",
          status: "completed",
          modelEntry: "deepseek/deepseek-v4-flash",
          modelChain: ["deepseek/deepseek-v4-flash"],
        },
        resultText: "## Unit Fact Sheet\n- Candidate deliverables: `foo.mjs`",
      };
    };

    const res = await defaultInvestigationDispatch({
      cwd,
      missionId: "mission-invc6",
      missionDir: path.join(stateDir, "missions", "mission-invc6"),
      brief: MISSION_BRIEF,
      container: "test-cid-plan-c6",
      _dispatch: stubDispatch,
    });

    assert.ok(capturedArgs, "dispatch must have been called");
    assert.equal(capturedArgs.phase, "plan", "phase must be plan");
    assert.equal(capturedArgs.agent, "kusabi-plan", "agent must be kusabi-plan");
    assert.match(capturedArgs.promptText, /test-cid-plan-c6/, "prompt must contain mission container");
    assert.doesNotMatch(res.actualModel, /gpt-5\.6-luna/, "must not be codex luna");
    assert.doesNotMatch(res.actualModel, /gpt-5\.6-sol/, "must not be codex sol");
    assert.equal(res.jobId, "job-unit-plan-1");
    assert.equal(res.actualModel, "deepseek/deepseek-v4-flash");
    assert.ok(res.body.includes("## Unit Fact Sheet"));
  });
  it("Finding A: guardedServeStop called once when only investigation ran (success then early finish)", async () => {
    let cleanupCalls = 0;
    const stubBaseline = { collected: 4342, gates: { gate_passed: true, lint: 0, types: 0 } };
    const stubBody = "## Relevant Locations\n- file.mjs:1";
    const coord = makeCoordinator([
      (input) => stream(line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-escalate" })),
    ]);
    const input = {
      cwd,
      missionFile,
      brief: MISSION_BRIEF,
      container: "test-cid-cleanup-1",
      ...DEFAULT_SEATS,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: coord.dispatch,
        solDispatch: async () => j({ type: "verdict", verdict: "clear" }),
        investigationDispatch: async () => ({
          jobId: "job-inv-cl1",
          requestedModel: "opencode/flash",
          actualModel: "opencode/flash",
          body: stubBody,
        }),
        baseline: async () => stubBaseline,
        guardedServeStop: async () => { cleanupCalls++; },
      },
    };
    await runLunaMission(input);
    assert.equal(cleanupCalls, 1, "cleanup must be called once when only investigation ran");
  });

  it("Finding A: guardedServeStop called once when only investigation ran (investigation failure)", async () => {
    let cleanupCalls = 0;
    const stubBaseline = { collected: 4342, gates: { gate_passed: true, lint: 0, types: 0 } };
    const coord = makeCoordinator([
      (input) => stream(line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-escalate" })),
    ]);
    const input = {
      cwd,
      missionFile,
      brief: MISSION_BRIEF,
      container: "test-cid-cleanup-2",
      ...DEFAULT_SEATS,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: coord.dispatch,
        solDispatch: async () => j({ type: "verdict", verdict: "clear" }),
        investigationDispatch: async () => {
          throw new Error("investigation worker failed");
        },
        baseline: async () => stubBaseline,
        guardedServeStop: async () => { cleanupCalls++; },
      },
    };
    await runLunaMission(input);
    assert.equal(cleanupCalls, 1, "cleanup must be called once on investigation failure");
  });

  it("Finding A: guardedServeStop still called once when both investigation and inner chain ran", async () => {
    let cleanupCalls = 0;
    const stubBaseline = { collected: 4342, gates: { gate_passed: true, lint: 0, types: 0 } };
    const stubBody = "## Relevant Locations\n- file.mjs:1";
    let firstTurn = true;
    const coord = makeCoordinator([
      (input) => {
        if (firstTurn) {
          firstTurn = false;
          return stream(line("run_chain", input.envelope.envelope_sha256, { brief: MISSION_BRIEF }));
        }
        return stream(line("finish", input.envelope.envelope_sha256, { recommendation: "recommend-escalate" }));
      },
    ]);
    const chainCalls = [];
    const input = {
      cwd,
      missionFile,
      brief: MISSION_BRIEF,
      container: "test-cid-cleanup-3",
      ...DEFAULT_SEATS,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: coord.dispatch,
        solDispatch: async () => j({ type: "verdict", verdict: "clear" }),
        investigationDispatch: async () => ({
          jobId: "job-inv-cl3",
          requestedModel: "opencode/flash",
          actualModel: "opencode/flash",
          body: stubBody,
        }),
        baseline: async () => stubBaseline,
        runChainLifecycle: async (chainCwd, chainInput) => {
          chainCalls.push({ chainCwd, chainInput });
          return "chain result";
        },
        guardedServeStop: async () => { cleanupCalls++; },
      },
    };
    await runLunaMission(input);
    assert.equal(chainCalls.length, 1, "inner chain must have run");
    assert.equal(cleanupCalls, 1, "cleanup must be called exactly once when both ran");
  });

  it("Finding C: missionEvidenceItems throws naming the path when fact-sheet file is missing", () => {
    const record = {
      investigation: {
        status: "completed",
        factSheetPath: "evidence/fact-sheet.md",
      },
    };
    const missingDir = path.join(root, "missing-mission");
    assert.throws(
      () => missionEvidenceItems({ brief: MISSION_BRIEF, record, missionDir: missingDir }),
      (err) => {
        assert.match(err.message, /evidence\/fact-sheet\.md/);
        return true;
      },
    );

    // Also throws when missionDir is missing / null
    assert.throws(
      () => missionEvidenceItems({ brief: MISSION_BRIEF, record, missionDir: null }),
      (err) => {
        assert.match(err.message, /evidence\/fact-sheet\.md/);
        return true;
      },
    );
  });
});

