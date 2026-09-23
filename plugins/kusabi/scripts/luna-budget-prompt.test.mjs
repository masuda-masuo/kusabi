// luna-budget-prompt.test.mjs — acceptance tests for the remaining-budget
// visibility contract (decision 6): the REAL coordinator prompt/evidence must
// expose the CURRENT remaining values for probes, attempts, chains and
// consults so the gpt-5.6-luna seat can produce an affordable batch, and the
// values must reflect PERSISTED counts on later dispatches / resume — never
// just the defaults.
//
// Frozen contract under test:
//
//   6a. The real coordinator dispatch prompt (the prompt.md the production
//       codex seam persists on the job record) states the current REMAINING
//       budget values for probes, attempts, chains and consults — not merely
//       the caps and not merely the consumed counts.
//   6b. The values are derived from the persisted record (the single source
//       of budget truth: the effective budget on the record minus the
//       persisted counts), so a resumed mission with recorded usage shows
//       max − persisted, and a fresh mission shows max − 0.  There is no
//       second hand-maintained source of budget truth.
//   6c. The evidence envelope carries the same values (the envelope is the
//       only evidence path into the seat; the prompt embeds it verbatim).
//
// These tests read the prompt the REAL dispatch seam persisted (prompt.md on
// the codex job record) with a fake `codex` binary behind CODEX_BIN — the
// same pattern luna-prompt.test.mjs uses — so they pin the actual production
// prompt, never a hand-written copy.  Nothing calls the real Codex CLI.
//
// The mission brief and the kusabi-coordinate system prompt are deliberately
// clean of the "remaining" markers and of any number next to a dimension
// word, so on this main (where the remaining values are not rendered) every
// visibility assertion below fails for the missing feature, never a
// false-positive from unrelated text.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { stateDirFor, readJson, writeJson } from "./state-paths.mjs";

// ---------------------------------------------------------------------------
// briefs
// ---------------------------------------------------------------------------

// Clean of every marker the visibility tests look for ("remaining", the
// dimension words, the budget numbers) so a false positive can never come
// from the embedded brief.
const MISSION_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-budget-prompt-test | 2026-09-23",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-budget-preflight.mjs` — the atomic preflight.",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-budget-prompt.test.mjs`",
].join("\n");

const VALID_RUN_CHAIN_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-inner | 2026-09-23",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-wait.mjs` — the #530 wait surface.",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-wait.test.mjs`",
].join("\n");

const DEFAULT_SEATS = {
  coordinator: { provider: "codex", model: "gpt-5.6-luna" },
  auditor: { provider: "codex", model: "gpt-5.6-sol" },
};

const DEFAULT_BUDGET = { maxChains: 3, maxAttempts: 2, maxProbes: 5, maxConsults: 3, maxRework: 1 };

// ---------------------------------------------------------------------------
// fake codex binary (real dispatch seam, no real CLI)
// ---------------------------------------------------------------------------

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
      text: JSON.stringify({ action: "escalate_to_host", envelope_sha256: firstHash, reason: "prompt budget visibility handoff" }),
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

/** Point CODEX_BIN at the fake codex and isolate HOME/CODEX_HOME/state per test. */
function fakeCodexContext(mode) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-luna-budget-codex-"));
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

describe("the real coordinator prompt/evidence exposes the remaining budget values (decision 6)", () => {
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
  function readMission(missionId) {
    const missionsDir = path.join(stateDir, "missions");
    const ids = fs.existsSync(missionsDir)
      ? fs.readdirSync(missionsDir).filter((n) => n.startsWith("mission-"))
      : [];
    if (missionId === undefined) {
      assert.equal(ids.length, 1, `exactly one mission dir expected in ${missionsDir}, got ${ids.join(",")}`);
      missionId = ids[0];
    }
    const missionDir = path.join(missionsDir, missionId);
    return {
      missionId,
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
   * Seed a resumable mission with the given persisted usage counts and the
   * effective budget on the record (the single source of budget truth).
   */
  function seedMission({ probes = 0, attempts = 0, chains = 0, consults = 0, budget = DEFAULT_BUDGET } = {}) {
    const missionId = "mission-budgetseed";
    const missionsDir = path.join(stateDir, "missions");
    fs.mkdirSync(missionsDir, { recursive: true });
    const missionDir = path.join(missionsDir, missionId);
    fs.mkdirSync(missionDir, { recursive: true });
    writeJson(path.join(missionDir, "control.json"), {
      missionId,
      container: "test-cid",
      pid: 99999999,
      status: "running",
    });
    writeJson(path.join(missionDir, "mission.json"), {
      missionId,
      container: "test-cid",
      missionFile,
      pid: 99999999,
      status: "running",
      coordinator: DEFAULT_SEATS.coordinator,
      auditor: DEFAULT_SEATS.auditor,
      startedAt: "2026-09-23T00:00:00.000Z",
      attempts: Array.from({ length: attempts }, (_, i) => ({
        index: i + 1,
        kind: "run_chain",
        chainId: `chain-seed${i}`,
        brief: VALID_RUN_CHAIN_BRIEF,
        status: "completed",
        output: "seed",
        at: "2026-09-23T00:00:00.000Z",
      })),
      chains: Array.from({ length: chains }, (_, i) => `chain-seed${i}`),
      probes: Array.from({ length: probes }, (_, i) => ({
        action: "read_probe",
        tool: "read_file_range",
        path: `seed-${i}`,
        output: "seed",
        outputBytes: 4,
        truncated: false,
        omittedBytes: 0,
        truncation: null,
        at: "2026-09-23T00:00:00.000Z",
      })),
      consults: Array.from({ length: consults }, (_, i) => ({
        action: "consult_sol",
        reason: `seed-${i}`,
        at: "2026-09-23T00:00:00.000Z",
      })),
      coordinatorErrors: 0,
      briefCorrections: 0,
      hostInterventions: 0,
      recommendation: null,
      disposition: null,
      budget: { ...DEFAULT_BUDGET, ...budget },
    });
    return missionId;
  }

  /**
   * Run a mission through the REAL coordinator dispatch seam (no
   * inject.coordinatorDispatch) with every other seam faked, and return the
   * terminal record plus the jobs the dispatches created.
   */
  async function runRealCoordinatorMission({ missionId, budget = DEFAULT_BUDGET } = {}) {
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
      budget,
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
      mission: readMission(missionId),
      jobs: codexJobRecords(),
    };
  }

  /**
   * The visibility contract (6a/6b): the text must state a REMAINING value
   * for each of the four dimensions and the exact remaining number near the
   * dimension word.  Numbers are checked with "remain ... <dim> ... <n>"
   * proximity so a bare persisted count (e.g. "attempts":1) can never
   * satisfy a remaining-1 assertion.
   */
  function assertRemainingValues(text, where, { probes, attempts, chains, consults }) {
    for (const [dim, n] of [
      ["probe", probes],
      ["attempt", attempts],
      ["chain", chains],
      ["consult", consults],
    ]) {
      assert.match(
        text,
        new RegExp(`remain.{0,80}${dim}`, "i"),
        `${where}: the ${dim} remaining value must be exposed (marker "remaining ... ${dim}")`,
      );
      assert.match(
        text,
        new RegExp(`${dim}s?.{0,25}${n}\\b`, "i"),
        `${where}: the ${dim} remaining value must read ${n}`,
      );
    }
  }

  it("decision 6a: the real coordinator dispatch prompt exposes the four remaining budget values on a fresh mission", async () => {
    ctx.setMode("coordinator-escalate");
    const { mission, jobs, result } = await runRealCoordinatorMission();
    assert.match(result, /disposition=host-handoff/, "the valid escalate_to_host stream must complete the mission");
    assert.equal(mission.record.disposition, "host-handoff");
    assert.equal(jobs.length, 1, "exactly one coordinator dispatch job");
    const prompt = jobPrompt(jobs[0].id);
    // Fresh mission: zero persisted usage against the default caps.
    assertRemainingValues(prompt, "the real coordinator dispatch prompt (fresh mission)", {
      probes: DEFAULT_BUDGET.maxProbes - 0,
      attempts: DEFAULT_BUDGET.maxAttempts - 0,
      chains: DEFAULT_BUDGET.maxChains - 0,
      consults: DEFAULT_BUDGET.maxConsults - 0,
    });
  });

  it("decision 6b: the remaining values reflect PERSISTED usage on a resumed dispatch, not only defaults", async () => {
    // Seed 1 probe / 2 attempts / 2 chains / 1 consult with a budget that
    // leaves room: remaining must read max − persisted = 4 / 3 / 3 / 3.  A
    // renderer that only shows the defaults (5 / 5 / 5 / 4) or the bare
    // consumed counts (1 / 2 / 2 / 1) fails this assertion.
    const seedBudget = { maxChains: 5, maxAttempts: 5, maxProbes: 5, maxConsults: 4, maxRework: 1 };
    const missionId = seedMission({ probes: 1, attempts: 2, chains: 2, consults: 1, budget: seedBudget });
    ctx.setMode("coordinator-escalate");
    const { mission, jobs } = await runRealCoordinatorMission({ missionId, budget: seedBudget });
    assert.equal(mission.record.disposition, "host-handoff");
    assert.equal(jobs.length, 1, "the resumed run dispatches exactly once");
    const prompt = jobPrompt(jobs[0].id);
    assertRemainingValues(prompt, "the resumed dispatch prompt (persisted usage)", {
      probes: 5 - 1,
      attempts: 5 - 2,
      chains: 5 - 2,
      consults: 4 - 1,
    });
  });

  it("decision 6c: the evidence envelope carries the same remaining values (single source of budget truth)", async () => {
    // The envelope ledger is the only evidence path into the seat and the
    // prompt embeds the envelope verbatim — the remaining values must live
    // there, derived from the persisted record + effective budget, never from
    // a second hand-maintained source.
    const seedBudget = { maxChains: 5, maxAttempts: 5, maxProbes: 5, maxConsults: 4, maxRework: 1 };
    const missionId = seedMission({ probes: 1, attempts: 2, chains: 2, consults: 1, budget: seedBudget });
    ctx.setMode("coordinator-escalate");
    const { mission } = await runRealCoordinatorMission({ missionId, budget: seedBudget });
    const ledgerPath = path.join(mission.missionDir, "evidence", "mission-ledger.txt");
    assert.ok(fs.existsSync(ledgerPath), "the envelope ledger must be persisted as evidence");
    const ledger = fs.readFileSync(ledgerPath, "utf8");
    assertRemainingValues(ledger, "the evidence envelope ledger (persisted usage)", {
      probes: 5 - 1,
      attempts: 5 - 2,
      chains: 5 - 2,
      consults: 4 - 1,
    });
    // The envelope JSON itself carries the ledger item; the seat reads the
    // ledger's bytes from the evidence tree the item names (the envelope
    // items carry role/source/sha256/bytes/path, not inline content).  The
    // item must point at the ledger that exposes the remaining values.
    const envelope = readJson(path.join(mission.missionDir, "evidence", "envelope-1.json"));
    assert.ok(Array.isArray(envelope.items), "the envelope must carry items");
    const ledgerItem = envelope.items.find((item) => item.source === "mission-ledger");
    assert.ok(ledgerItem, "the envelope must carry the mission-ledger item");
    assert.equal(typeof ledgerItem.path, "string", "the ledger item must name its evidence-tree path");
    const ledgerViaItem = fs.readFileSync(path.join(mission.missionDir, ledgerItem.path), "utf8");
    assertRemainingValues(ledgerViaItem, "the envelope mission-ledger item bytes (persisted usage)", {
      probes: 5 - 1,
      attempts: 5 - 2,
      chains: 5 - 2,
      consults: 4 - 1,
    });
  });
});