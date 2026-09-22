// luna-prompt.test.mjs — acceptance tests for the runtime-rendered prompt
// contract that fixes the second live Luna integration failure
// (mission-mucv2fzt47784ba9: the coordinator emitted probe:{paths:[...]} and
// was refused with tool "undefined" because the real prompt only instructed
// action + envelope_sha256).
//
// Frozen acceptance contract (prompt-contract criteria 1, 2, 8, 9):
//
//   - criterion 1: the ACTUAL coordinator prompt — what realCoordinatorDispatch
//     sends through the codex backend — must state, for every valid action,
//     the exact required/optional body fields: read_probe's top-level `tool`
//     and `path` (plus `pattern` for search) with the exact probe tool enum
//     (read_file_range, search_in_container, list_files) and per-tool
//     arguments, the inner-chain brief requirement (`## Deliverables`), the
//     `reason` fields, the finish recommendation vocabulary (recommend-accept,
//     recommend-escalate), the one-record-per-line JSONL framing, and the
//     envelope hash binding;
//   - criterion 2: the ACTUAL Sol prompt must state the required common
//     fields (summary) and the block-only fields (block_reason,
//     acknowledgement_required);
//   - criterion 8: a resumed mission dispatches through the SAME corrected
//     prompt path — the resumed dispatch's prompt carries the same rendered
//     contract;
//   - criterion 9: the coordinator and Sol seats keep the frozen multi-record
//     JSONL framing — no --output-schema is wired for them
//     (jsonSchemaEnforced false on the job records).
//
// These tests read the prompt the REAL dispatch seam persisted (prompt.md on
// the codex job record) with a fake `codex` binary behind CODEX_BIN — the
// same pattern the #530/#531 failure-propagation tests use — so they pin the
// actual production prompt, never a hand-written copy.  Nothing calls the
// real Codex CLI or starts a real companion child.  luna-prompt.mjs does not
// exist on pristine main; these tests deliberately do not import it — the
// contract is pinned through the observable dispatch, so the baseline
// failure is behavioral (the prompt lacks the contract), never an import
// error.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { stateDirFor, readJson, writeJson } from "./state-paths.mjs";

// ---------------------------------------------------------------------------
// briefs
// ---------------------------------------------------------------------------

// The mission brief must stay clean of the contract markers the tests look
// for (no "pattern", "reason", "file_path", 64-hex strings, ...) so a false
// positive can never come from the embedded brief.
const MISSION_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-prompt-test | 2026-09-23",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-prompt.mjs` — the single prompt renderer.",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-prompt.test.mjs`",
].join("\n");

const DEFAULT_SEATS = {
  coordinator: { provider: "codex", model: "gpt-5.6-luna" },
  auditor: { provider: "codex", model: "gpt-5.6-sol" },
};

const DEFAULT_BUDGET = { maxChains: 3, maxAttempts: 2, maxProbes: 5, maxConsults: 3, maxRework: 1 };

// ---------------------------------------------------------------------------
// the contract markers every real dispatch prompt must carry
// ---------------------------------------------------------------------------

/**
 * Every marker the rendered COORDINATOR guidance must state (criterion 1).
 * The tool names, argument names and the finish vocabulary are unique enough
 * that none of them can leak from the system prompt or the embedded envelope
 * on pristine main — their absence is exactly the observed defect.
 */
const COORDINATOR_CONTRACT_MARKERS = [
  "read_probe",
  "read_file_range",
  "search_in_container",
  "list_files",
  "file_path", // read_file_range's argument name
  "pattern", // search_in_container's argument name
  "path",
  "tool",
  "reason",
  "recommend-accept",
  "recommend-escalate",
];

/** The markers every rendered SOL guidance must state (criterion 2). */
const SOL_CONTRACT_MARKERS = [
  "summary",
  "block_reason",
  "acknowledgement_required",
  "verdict",
  "clear",
  "rework",
  "block",
  "gate_id",
  "envelope_sha256",
];

function assertCoordinatorContract(prompt, where) {
  for (const marker of COORDINATOR_CONTRACT_MARKERS) {
    assert.ok(
      prompt.includes(marker),
      `${where}: the coordinator prompt must state the contract marker "${marker}"`,
    );
  }
  // the inner-chain brief requirement: a run_chain/rework_chain brief must
  // carry a non-empty `## Deliverables` section.  The bare word also appears
  // in the embedded brief, so the requirement itself (requires / must carry /
  // valid ... Deliverables) is what is pinned.
  assert.match(
    prompt,
    /(?:requires?|must (?:have|carry|include)|valid).{0,80}Deliverables/i,
    `${where}: the coordinator prompt must state the inner-chain brief requirement (## Deliverables)`,
  );
  assert.match(prompt, /per line/i, `${where}: the coordinator prompt must state one-record-per-line JSONL framing`);
}

function assertSolContract(prompt, where) {
  for (const marker of SOL_CONTRACT_MARKERS) {
    assert.ok(
      prompt.includes(marker),
      `${where}: the Sol prompt must state the contract marker "${marker}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// fake codex binary (real dispatch seam, no real CLI)
// ---------------------------------------------------------------------------
//
// The fake reads the prompt from stdin (the real CLI contract: prompt on the
// trailing `-`).  Mode "coordinator-escalate" extracts the current envelope
// hash from the prompt and answers with a parse-valid escalate_to_host
// request so the mission terminates after exactly one dispatch; every other
// mode completes the job with a non-empty terminal message (a valid job whose
// content the driver/gate may then reject as a stream problem — the
// failure-propagation contract of #530/#531).

const FAKE_CODEX_TEMPLATE = `#!/usr/bin/env node
import fs from "node:fs";
const mode = process.env.FAKE_CODEX_MODE ?? "invalid";
const emit = (obj) => fs.writeSync(1, JSON.stringify(obj) + "\\n");
const stdinText = fs.readFileSync(0, "utf8");
const firstHash = (stdinText.match(/[0-9a-f]{64}/) || [])[0] || "f".repeat(64);
if (mode === "coordinator-escalate") {
  emit({ type: "thread.started", thread_id: "__THREAD__" });
  emit({
    type: "item.completed",
    item: {
      type: "agent_message",
      text: JSON.stringify({ action: "escalate_to_host", envelope_sha256: firstHash, reason: "prompt regression host handoff" }),
    },
  });
  emit({ type: "turn.completed", usage: {} });
  process.exit(0);
}
emit({ type: "thread.started", thread_id: "__THREAD__" });
emit({ type: "item.completed", item: { type: "agent_message", text: "not a valid coordinator stream" } });
emit({ type: "turn.completed", usage: {} });
process.exit(0);
`;

/**
 * Point CODEX_BIN at the fake codex and isolate HOME/CODEX_HOME/state per
 * test.  Restore() reverts every touched env var and removes the temp root.
 */
function fakeCodexContext(mode) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-luna-prompt-codex-"));
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

// ---------------------------------------------------------------------------
// fakes for the non-coordinator seams
// ---------------------------------------------------------------------------

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
// harness
// ---------------------------------------------------------------------------

describe("the real dispatch prompts carry the rendered contract (prompt-contract criteria 1, 2, 8, 9)", () => {
  let ctx;
  let cwd;
  let stateDir;
  let missionFile;

  beforeEach(() => {
    ctx = fakeCodexContext("invalid");
    cwd = ctx.cwd;
    stateDir = ctx.stateDir;
    missionFile = path.join(ctx.tmp, "mission.md");
    fs.writeFileSync(missionFile, MISSION_BRIEF, "utf8");
  });

  afterEach(() => {
    ctx.restore();
  });

  /** The single mission the last run created/resumed, plus its record. */
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
      record: readJson(path.join(missionDir, "mission.json")),
    };
  }

  /** Every codex job record under the state root. */
  function codexJobRecords() {
    const jobsDir = path.join(stateDir, "jobs");
    if (!fs.existsSync(jobsDir)) return [];
    return fs
      .readdirSync(jobsDir)
      .filter((n) => n.startsWith("job-"))
      .map((id) => ({ id, job: readJson(path.join(jobsDir, id, "job.json")) }));
  }

  /** The persisted full prompt of a job (system prompt + promptText). */
  function jobPrompt(jobId) {
    return fs.readFileSync(path.join(stateDir, "jobs", jobId, "prompt.md"), "utf8");
  }

  /**
   * Run a mission through the REAL coordinator dispatch seam (no
   * inject.coordinatorDispatch) with every other seam faked, and return the
   * terminal record plus the jobs the dispatches created.
   */
  async function runRealCoordinatorMission({ missionId } = {}) {
    const { runLunaMission } = await import("./luna-driver.mjs");
    const chain = makeChainFake();
    const tools = makeToolFake();
    const sol = makeSolFake();
    const notifications = [];
    const result = await runLunaMission({
      cwd,
      missionFile,
      brief: MISSION_BRIEF,
      container: "test-cid",
      ...DEFAULT_SEATS,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      ...(missionId ? { missionId } : {}),
      inject: {
        runChainLifecycle: chain.run,
        callTool: tools.callTool,
        solDispatch: sol.dispatch,
        notifyMissionTerminal: async (info) => { notifications.push(info); },
        guardedServeStop: async () => {},
      },
    });
    return {
      result,
      chain,
      tools,
      sol,
      notifications,
      mission: readMission(),
      jobs: codexJobRecords(),
    };
  }

  it("criterion 1: the real coordinator dispatch prompt renders the full request contract", async () => {
    ctx.setMode("coordinator-escalate");
    const { mission, jobs, result } = await runRealCoordinatorMission();
    assert.match(result, /disposition=host-handoff/, "the valid escalate_to_host stream must complete the mission");
    assert.equal(mission.record.disposition, "host-handoff");
    assert.equal(jobs.length, 1, "exactly one coordinator dispatch job");
    const job = jobs[0];
    assert.equal(job.job.status, "completed");
    const prompt = jobPrompt(job.id);
    assertCoordinatorContract(prompt, "the real coordinator dispatch");
    // the prompt must bind records to the CURRENT envelope hash
    const envelope = readJson(path.join(mission.missionDir, "evidence", "envelope-1.json"));
    assert.ok(
      prompt.includes(envelope.envelope_sha256),
      "the coordinator prompt must bind requests to the current envelope hash",
    );
  });

  it("criterion 2: the real Sol dispatch prompt renders the verdict contract", async () => {
    const { realSolDispatch } = await import("./luna-sol-gate.mjs");
    const text = await realSolDispatch({
      cwd,
      missionId: "mission-solprompt",
      envelope: { envelope_sha256: "e".repeat(64) },
      gate: { gateId: "gate-1", phase: "pre-dispatch" },
      auditor: DEFAULT_SEATS.auditor,
    });
    assert.equal(typeof text, "string", "a completed fake job must resolve to its stream text");
    const jobs = codexJobRecords();
    assert.equal(jobs.length, 1, "exactly one Sol dispatch job");
    const job = jobs[0];
    assert.equal(job.job.status, "completed");
    const prompt = jobPrompt(job.id);
    assertSolContract(prompt, "the real Sol dispatch");
    assert.ok(
      prompt.includes("e".repeat(64)),
      "the Sol prompt must bind verdicts to the current envelope hash",
    );
  });

  it("criterion 9: no --output-schema is wired for the coordinator or Sol seats", async () => {
    // Real dispatches: the coordinator job and the Sol job both record the
    // frozen multi-record JSONL framing — never an enforced output schema.
    ctx.setMode("coordinator-escalate");
    await runRealCoordinatorMission();
    const { realSolDispatch } = await import("./luna-sol-gate.mjs");
    await realSolDispatch({
      cwd,
      missionId: "mission-solprompt",
      envelope: { envelope_sha256: "e".repeat(64) },
      gate: { gateId: "gate-1", phase: "pre-dispatch" },
      auditor: DEFAULT_SEATS.auditor,
    });
    const jobs = codexJobRecords();
    assert.equal(jobs.length, 2, "one coordinator job + one Sol job");
    for (const { id, job } of jobs) {
      assert.equal(
        job.jsonSchemaEnforced,
        false,
        `job ${id} (phase ${job.phase}) must not enforce an output schema`,
      );
      assert.equal(job.streamFraming, "json", `job ${id} keeps the frozen --json framing`);
    }
    // Adapter surface: the schema bridge only exists for the review agent and
    // a null schema never produces the --output-schema argv flag.
    const { codexJsonSchemaFor, buildCodexArgs } = await import("./codex-dispatch.mjs");
    assert.equal(codexJsonSchemaFor("kusabi-coordinate"), null);
    assert.equal(codexJsonSchemaFor(null), null);
    for (const args of [
      buildCodexArgs({ model: "gpt-5.6-luna", cwd: "/tmp/x", sessionId: null, jsonSchema: null }),
      buildCodexArgs({ model: "gpt-5.6-sol", cwd: "/tmp/x", sessionId: "thread-1", jsonSchema: null }),
    ]) {
      assert.ok(!args.includes("--output-schema"), "a null schema must never add --output-schema");
    }
  });

  it("criterion 8: a resumed mission dispatches through the same corrected prompt path", async () => {
    // Seed a resumable mission exactly like luna-resume leaves one behind: a
    // persisted mission dir + control record, no terminal disposition.  The
    // driver resumes and the resumed dispatches go through the real
    // coordinator seam, so their persisted prompts must carry the contract.
    const missionId = "mission-promptresume";
    const missionDir = path.join(stateDir, "missions", missionId);
    fs.mkdirSync(missionDir, { recursive: true });
    writeJson(path.join(missionDir, "control.json"), { pid: 99999999, status: "running" });
    writeJson(path.join(missionDir, "mission.json"), {
      missionId,
      container: "test-cid",
      status: "running",
      coordinator: DEFAULT_SEATS.coordinator,
      auditor: DEFAULT_SEATS.auditor,
      startedAt: "2026-09-23T00:00:00.000Z",
      attempts: [],
      chains: [],
      probes: [],
      consults: [],
    });

    const { mission, jobs, result } = await runRealCoordinatorMission({ missionId });
    // Two invalid streams burn the error budget (maxAttempts 2) and the
    // mission fails closed — the resumed dispatches are the artifact under
    // test.
    assert.match(result, /disposition=coordinator-failed/);
    assert.equal(mission.record.disposition, "coordinator-failed");
    assert.equal(jobs.length, 2, "the resumed run dispatches twice");
    for (const { id } of jobs) {
      assertCoordinatorContract(jobPrompt(id), "the resumed dispatch prompt");
    }
  });
});