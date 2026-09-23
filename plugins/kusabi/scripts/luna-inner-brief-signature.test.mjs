// luna-inner-brief-signature.test.mjs — acceptance tests for the
// deterministic inner-brief signature and pre-seam brief validation of the
// luna mission driver (decisions 1-6).
//
// Frozen acceptance contract:
//
//   - decision 1: before every run_chain / rework_chain the deterministic
//     driver strips any `Orchestrator:` line in the first five lines of the
//     inner brief and prepends exactly one canonical line as line 1;
//   - decision 2: the canonical values are model = coordinator.actual
//     (substitution-aware), session = missionId, date = the dispatch's UTC
//     YYYY-MM-DD; a RESUME stamps the persisted actual coordinator and the
//     same mission id, with the RESUMED dispatch date (an injectable clock
//     `inject.now: () => Date` proves the date is the current dispatch's, not
//     a persisted one);
//   - decision 3: the parsed canonical signature is passed into the
//     runChainLifecycle seam (`orchestrator`), so chain attribution is
//     non-null and matches the stamped brief;
//   - decision 5: before chain dispatch, the driver reuses the same
//     downstream brief lint/smoke validators (briefLintReport /
//     smokeViolationReport) to fail closed as a BRIEF CORRECTION with no
//     chain state and no seam call, naming the defect precisely;
//   - decision 6: stamping is deterministic metadata enrichment only — it
//     never repairs missing Deliverables, invalid Smoke, or invalid Frozen
//     Tests (a brief that already carries a signature still refuses when its
//     semantic sections are defective).
//
// The driver's seams are fakes (coordinator dispatch, runChainLifecycle,
// callTool, Sol dispatch); nothing calls a real CLI or touches a real state
// root.  The injectable clock is passed as `inject.now` and MUST be honoured
// by the driver (absent on base: the date assertions fail because no
// canonical line is stamped at all).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { stateDirFor, readJson, writeJson } from "./state-paths.mjs";

let driverModule = null;
async function lunaDriver() {
  if (driverModule === null) {
    driverModule = await import("./luna-driver.mjs");
  }
  return driverModule;
}

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const j = (obj) => JSON.stringify(obj);
const line = (action, hash, body = {}) => j({ action, envelope_sha256: hash, ...body });
const stream = (...lines) => lines.join("\n");

/** A stateful fake coordinator: each dispatch pops the next canned stream. */
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

const runChainStream = (brief) => (input) =>
  stream(line("run_chain", input.envelope.envelope_sha256, { brief }));

const reworkChainStream = (brief) => (input) =>
  stream(line("rework_chain", input.envelope.envelope_sha256, { brief }));

const finishStream = (recommendation) => (input) =>
  stream(line("finish", input.envelope.envelope_sha256, { recommendation }));

/** Fake runChainLifecycle: records every invocation. */
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

function toolResponse(name) {
  if (name === "sandbox_exec") return { status: "ok", output: "deadbeef1234\n" };
  if (name === "verify_in_container") {
    return { status: "ok", gate_passed: true, lint: [], types: [], tests: { full: { passed: 1, failed: 0, skipped: 0 } } };
  }
  if (name === "diff_in_container") return { status: "ok", output: "diff --git a/x b/x\n" };
  return { status: "ok", output: "canned\n" };
}

function makeToolFake() {
  const calls = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return toolResponse(name);
    },
  };
}

/** Fake Sol seat: schema-valid `clear` verdict bound to the current gate envelope. */
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
// briefs
// ---------------------------------------------------------------------------

const MISSION_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-inner-brief-test | 2026-09-21",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-inner-brief-signature.test.mjs` — the signature freeze.",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-inner-brief-signature.test.mjs`",
].join("\n");

// A valid inner-chain brief with NO signature: after canonical stamping it
// must reach the seam with the canonical line 1; on base (no stamping) the
// seam receives it verbatim, so the canonical-line assertions fail.
const UNSIGNED_RUN_CHAIN_BRIEF = [
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-wait.mjs` — the #530 wait surface.",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-wait.test.mjs`",
].join("\n");

// Signed but MISSING Deliverables: stamping must not repair the defect.
const MISSING_DELIVERABLES_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-inner | 2026-09-21",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-wait.test.mjs`",
].join("\n");

// `## Deliverables` heading present but parses to zero entries.
const EMPTY_DELIVERABLES_BRIEF = [
  "## Deliverables",
  "",
  "(nothing to change here)",
  "",
  "## Smoke",
  "",
  "- `node --test`",
].join("\n");

// `## Smoke` heading present but parses to zero entries.
const EMPTY_SMOKE_BRIEF = [
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/a.mjs`",
  "",
  "## Smoke",
  "",
  "(no smoke declared)",
].join("\n");

// A smoke command truncated at a nested backtick (kusabi #250 lossy smoke).
const LOSSY_SMOKE_BRIEF = [
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/a.mjs`",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-wait.test.mjs` — check `that`",
].join("\n");

// A Frozen Tests bullet carrying leftover prose the frozen oracle cannot see.
const FROZEN_QUALIFIER_BRIEF = [
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/a.mjs`",
  "",
  "## Frozen Tests",
  "",
  "- `plugins/kusabi/scripts/b.test.mjs` (do not weaken existing tests)",
].join("\n");

const DEFAULT_SEATS = {
  coordinator: { provider: "codex", model: "gpt-5.6-luna" },
  auditor: { provider: "codex", model: "gpt-5.6-sol" },
};

const DEFAULT_BUDGET = { maxChains: 3, maxAttempts: 2, maxProbes: 5, maxConsults: 3, maxRework: 1 };

// A fixed injectable dispatch instant.  2026-09-23T00:30:00Z is chosen so a
// LOCAL-time implementation would read 2026-09-22 west of UTC — the canonical
// date must be the UTC YYYY-MM-DD of the dispatch instant.
const DISPATCH_UTC = "2026-09-23";
const DISPATCH_NOW = () => new Date("2026-09-23T00:30:00Z");

const DEAD_PID = 99999999; // a pid that cannot exist on this host

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

describe("luna driver deterministic inner-brief signature (decisions 1-3, 5-6)", () => {
  let root;
  let cwd;
  let stateDir;
  let previousStateDir;
  let missionFile;

  beforeEach(() => {
    root = makeTemp("kusabi-luna-inner-brief-");
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

  async function runMission(streams, overrides = {}) {
    const driver = await lunaDriver();
    const coord = makeCoordinator(streams);
    const chain = makeChainFake();
    const tools = makeToolFake();
    const sol = makeSolFake();
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
        solDispatch: sol.dispatch,
        now: DISPATCH_NOW,
        ...(overrides.inject ?? {}),
      },
    };
    const result = await driver.runLunaMission(input);
    return { driver, coord, chain, tools, sol, result, input };
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

  /** Fabricate a non-terminal mission directory (the #531 resume pattern). */
  function fabricateMission(id, { coordinator, auditor = DEFAULT_SEATS.auditor } = {}) {
    const missionDir = path.join(stateDir, "missions", id);
    fs.mkdirSync(missionDir, { recursive: true });
    writeJson(path.join(missionDir, "control.json"), {
      missionId: id,
      container: "test-cid",
      pid: DEAD_PID,
      status: "running",
      startedAt: "2026-09-21T00:00:00.000Z",
    });
    writeJson(path.join(missionDir, "mission.json"), {
      missionId: id,
      container: "test-cid",
      missionFile,
      pid: DEAD_PID,
      status: "running",
      coordinator,
      auditor,
      attempts: [],
      chains: [],
      coordinatorErrors: 0,
      consults: [],
      probes: [],
      recommendation: null,
      disposition: null,
    });
    return missionDir;
  }

  // -------------------------------------------------------------------------
  // run_chain / rework_chain: canonical line 1 + matching parsed attribution
  // -------------------------------------------------------------------------

  it("run_chain WITHOUT a signature: the seam receives the canonical line 1 and matching parsed orchestrator attribution", async () => {
    const { chain } = await runMission([
      runChainStream(UNSIGNED_RUN_CHAIN_BRIEF),
      finishStream("recommend-accept"),
    ]);
    const { record } = readMission();

    assert.equal(chain.calls.length, 1, "the run_chain must reach the seam");
    const input = chain.calls[0].input;
    const lines = input.text.split("\n");

    // Exactly one canonical first-line signature, model = coordinator.actual
    // (default seat), session = mission id, date = the injected dispatch UTC day.
    assert.equal(
      lines.slice(0, 5).filter((l) => l.trim().startsWith("Orchestrator:")).length,
      1,
      "exactly one canonical first-line signature expected",
    );
    assert.equal(
      lines[0],
      `Orchestrator: gpt-5.6-luna | session ${record.missionId} | ${DISPATCH_UTC}`,
      "the seam must receive the canonical signature as line 1",
    );
    assert.equal(
      lines.slice(1).join("\n"),
      UNSIGNED_RUN_CHAIN_BRIEF,
      "remaining content must be byte-stable apart from the leading insertion",
    );

    // Decision 3: chain attribution is non-null and matches the stamped brief.
    assert.ok(input.orchestrator, "the seam must receive a non-null parsed orchestrator attribution");
    assert.deepEqual(
      input.orchestrator,
      { model: "gpt-5.6-luna", session: record.missionId, date: DISPATCH_UTC },
      "the parsed attribution must match the canonical line 1 exactly",
    );
  });

  it("rework_chain WITHOUT a signature: the seam receives the canonical line 1 and matching parsed orchestrator attribution", async () => {
    const { chain } = await runMission([
      reworkChainStream(UNSIGNED_RUN_CHAIN_BRIEF),
      finishStream("recommend-accept"),
    ]);
    const { record } = readMission();

    assert.equal(chain.calls.length, 1, "the rework_chain must reach the seam");
    const input = chain.calls[0].input;
    const lines = input.text.split("\n");

    assert.equal(
      lines[0],
      `Orchestrator: gpt-5.6-luna | session ${record.missionId} | ${DISPATCH_UTC}`,
      "the seam must receive the canonical signature as line 1 for rework_chain",
    );
    assert.equal(
      lines.slice(1).join("\n"),
      UNSIGNED_RUN_CHAIN_BRIEF,
      "remaining content must be byte-stable apart from the leading insertion",
    );
    assert.ok(input.orchestrator, "the seam must receive a non-null parsed orchestrator attribution");
    assert.deepEqual(
      input.orchestrator,
      { model: "gpt-5.6-luna", session: record.missionId, date: DISPATCH_UTC },
      "the parsed attribution must match the canonical line 1 exactly",
    );
  });

  // -------------------------------------------------------------------------
  // substitution: model = coordinator.actual
  // -------------------------------------------------------------------------

  it("model substitution stamps coordinator.actual, not the requested/default model", async () => {
    const { chain } = await runMission(
      [runChainStream(UNSIGNED_RUN_CHAIN_BRIEF), finishStream("recommend-accept")],
      {
        coordinator: { provider: "codex", model: "gpt-5.6-flash" },
        allowSubstitute: true,
      },
    );
    const { record } = readMission();

    // The resolved actual seat is persisted: gpt-5.6-flash, not the default
    // gpt-5.6-luna the request nominally asked for.
    assert.equal(record.coordinator.model, "gpt-5.6-flash");
    assert.equal(record.coordinator.actual, "gpt-5.6-flash");
    assert.equal(record.coordinator.substituted, true);

    assert.equal(chain.calls.length, 1);
    const input = chain.calls[0].input;
    const lines = input.text.split("\n");
    assert.equal(
      lines[0],
      `Orchestrator: gpt-5.6-flash | session ${record.missionId} | ${DISPATCH_UTC}`,
      "the canonical model must be the ACTUAL (substituted) seat, never the default or the requested spelling",
    );
    assert.ok(input.orchestrator, "the seam must receive a non-null parsed orchestrator attribution");
    assert.equal(input.orchestrator.model, "gpt-5.6-flash", "attribution must carry the actual model");
    assert.equal(input.orchestrator.session, record.missionId);
    assert.equal(input.orchestrator.date, DISPATCH_UTC);
  });

  // -------------------------------------------------------------------------
  // resume: persisted actual seat + same mission id + resumed dispatch date
  // -------------------------------------------------------------------------

  it("resume stamps the PERSISTED actual seat and the same mission id, with the RESUMED dispatch date (injectable clock)", async () => {
    const driver = await lunaDriver();
    const persistedCoordinator = {
      provider: "codex",
      model: "gpt-5.6-flash",
      requested: "gpt-5.6-luna",
      actual: "gpt-5.6-flash",
      substituted: true,
      reasoningEffort: "high",
    };
    fabricateMission("mission-resumestamp", { coordinator: persistedCoordinator });

    const coord = makeCoordinator([
      runChainStream(UNSIGNED_RUN_CHAIN_BRIEF),
      finishStream("recommend-accept"),
    ]);
    const chain = makeChainFake();
    const tools = makeToolFake();
    const sol = makeSolFake();
    // The resumed run is handed the DEFAULT coordinator input (no
    // substitution authorized) — the stamp must still use the PERSISTED
    // actual seat from the mission record, and the same mission id, with the
    // dispatch date of THIS (resumed) dispatch.
    const result = await driver.runLunaMission({
      cwd,
      missionFile,
      brief: MISSION_BRIEF,
      container: "test-cid",
      missionId: "mission-resumestamp",
      ...DEFAULT_SEATS,
      allowSubstitute: false,
      budget: DEFAULT_BUDGET,
      inject: {
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: chain.run,
        callTool: tools.callTool,
        solDispatch: sol.dispatch,
        now: DISPATCH_NOW,
      },
    });

    assert.match(result, /disposition=recommend-accept/, "the resumed mission must run to a terminal recommendation");
    assert.equal(chain.calls.length, 1, "the resumed run_chain must reach the seam");
    const input = chain.calls[0].input;
    const lines = input.text.split("\n");
    assert.equal(
      lines[0],
      `Orchestrator: gpt-5.6-flash | session mission-resumestamp | ${DISPATCH_UTC}`,
      "resume must stamp the persisted actual model + same mission id + the resumed dispatch date",
    );
    assert.ok(input.orchestrator, "the seam must receive a non-null parsed orchestrator attribution");
    assert.equal(input.orchestrator.model, "gpt-5.6-flash", "the persisted actual seat, not the re-resolved default");
    assert.equal(input.orchestrator.session, "mission-resumestamp", "the same mission id");
    assert.equal(input.orchestrator.date, DISPATCH_UTC, "the RESUMED dispatch date comes from the injectable clock");
  });

  // -------------------------------------------------------------------------
  // decision 5+6: pre-seam brief corrections, precise, no chain state
  // -------------------------------------------------------------------------

  const REFUSAL_CASES = [
    {
      name: "missing ## Deliverables (signed brief — stamping must not repair it)",
      brief: MISSING_DELIVERABLES_BRIEF,
      detail: /Deliverables/i,
    },
    {
      name: "empty ## Deliverables heading",
      brief: EMPTY_DELIVERABLES_BRIEF,
      detail: /Deliverables/i,
    },
    {
      name: "empty ## Smoke heading",
      brief: EMPTY_SMOKE_BRIEF,
      detail: /Smoke/i,
    },
    {
      name: "lossy ## Smoke command (nested backtick)",
      brief: LOSSY_SMOKE_BRIEF,
      detail: /Smoke/i,
    },
    {
      name: "## Frozen Tests bullet with leftover prose outside the path",
      brief: FROZEN_QUALIFIER_BRIEF,
      detail: /Frozen Tests/i,
    },
  ];

  for (const { name, brief, detail } of REFUSAL_CASES) {
    it(`refuses ${name} BEFORE the seam as a precise brief correction, with no chain state created`, async () => {
      const { chain } = await runMission([
        runChainStream(brief),
        finishStream("recommend-accept"),
      ]);
      const { record } = readMission();

      // Decision 5: the refusal is a brief correction, not a terminal failure —
      // the mission may still end via a later valid finish.
      assert.equal(chain.calls.length, 0, `the defective brief must never reach the seam: ${name}`);
      assert.ok(
        !fs.existsSync(path.join(stateDir, "chains")),
        "no chain state may exist: the refusal happens before any chain state or seam call",
      );
      assert.equal(record.briefCorrections, 1, `exactly one brief correction must be recorded: ${name}`);
      assert.equal(record.coordinatorErrors, 1, "a brief correction is counted alongside the coordinator error");

      // The recorded detail must name the precise defect (never a generic
      // "fails deterministic validation").
      const details = Array.isArray(record.coordinatorErrorsDetails) ? record.coordinatorErrorsDetails : [];
      const last = details[details.length - 1];
      assert.ok(
        last && detail.test(last.detail),
        `the brief correction must be precise (${detail}): got ${last?.detail}`,
      );
      assert.equal(record.disposition, "recommend-accept", "the mission continues after the correction");
    });
  }
});