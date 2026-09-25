// luna-brief-corrections-seam.test.mjs — acceptance tests for the bounded
// inner-brief correction feedback SEAMS: persistence, the real coordinator
// prompt, both mission ledgers (driver + Sol), the envelope hash binding,
// resume, and the refusal semantics.  The pure renderer itself is pinned by
// luna-brief-corrections.test.mjs; this file pins that the recorded
// corrections actually flow into the prompt/evidence the seats see.
//
// Frozen contract under test (criteria 1, 3, 4, 5, 6):
//
//   - criterion 1: `recordBriefCorrection` persists structured
//     `briefCorrectionsDetails` entries (timestamp, original action,
//     deterministic validator detail) and the existing `briefCorrections` /
//     `coordinatorErrors` counters and caps stay unchanged;
//   - criterion 3: the SAME rendered corrections text appears conditionally
//     (only when non-empty) in the next coordinator prompt and in BOTH the
//     driver and Sol mission ledgers; a clean mission's envelope/prompt is
//     byte-identical to today (no extra field, no extra text);
//   - criterion 4: arbitrary `coordinatorErrorsDetails`, probe output, tool
//     output, and exception messages are never rendered — only
//     driver-generated validator output;
//   - criterion 5: resume carries the persisted corrections automatically and
//     never duplicates stale entries beyond the bounded renderer window;
//   - criterion 6: a correction remains a refusal with zero chain-state/seam
//     side effects, a subsequent valid request may proceed, and normal caps
//     remain.
//
// Seam vocabulary used below (observable through the driver/gate envelopes,
// never implementation internals):
//   - the driver persists one envelope per coordinator dispatch as
//     `evidence/envelope-N.json`; its `mission-ledger` item is the driver
//     mission ledger, and the envelope hash changes exactly when the ledger
//     bytes change;
//   - the Sol gate persists `evidence/gate-envelope-<gateId>.json` with the
//     same `mission-ledger` item (the Sol mission ledger);
//   - the REAL coordinator prompt (what the seat actually receives) is the
//     `prompt.md` the production codex seam persists on each job record;
//   - the validator detail markers used here ("fails deterministic
//     validation", "is absent or parses to zero entries") appear ONLY in the
//     driver-generated validator output — never in the schema-derived
//     contract text, the system prompt, or the mission brief — so a clean
//     prompt/ledger can never false-positive on them.
//
// Test state: temp KUSABI_STATE_DIR, temp cwd, fake coordinator/chain/tool/
// Sol seams, and (for the real-prompt block) a fake `codex` binary behind
// CODEX_BIN.  Nothing calls the real Codex CLI or touches a real state root.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { stateDirFor, readJson, writeJson } from "./state-paths.mjs";

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// briefs
// ---------------------------------------------------------------------------

// The mission brief must stay clean of the correction markers AND of the
// word "correction" itself (the seam tests assert a clean prompt carries no
// correction text at all), so a false positive can never come from the
// embedded brief.
const MISSION_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-seam-test | 2026-09-23",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-budget-preflight.mjs` \u2014 the atomic preflight.",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-budget-prompt.test.mjs`",
].join("\n");

// A valid inner brief: signature + non-empty Deliverables + valid Smoke.
const VALID_RUN_CHAIN_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-inner | 2026-09-23",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-wait.mjs` \u2014 the #530 wait surface.",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-wait.test.mjs`",
].join("\n");

// ---- the three actionable validator cases (criterion "actionable and
// sanitized") ------------------------------------------------ ----

// 1. missing `## Deliverables` entirely (kusabi #289 lint).
const MISSING_DELIVERABLES_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-inner | 2026-09-23",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-wait.test.mjs`",
].join("\n");

// 2. `## Frozen Tests` heading present but zero entries (kusabi #302 lint).
const EMPTY_FROZEN_TESTS_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-inner | 2026-09-23",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-wait.mjs` \u2014 the #530 wait surface.",
  "",
  "## Frozen Tests",
  "",
  "(none frozen by name \u2014 kept open)",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-wait.test.mjs`",
].join("\n");

// 3. `## Smoke` heading present but zero entries (kusabi #302 lint + the
//    #250 smoke violation report).
const INVALID_SMOKE_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-inner | 2026-09-23",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-wait.mjs` \u2014 the #530 wait surface.",
  "",
  "## Smoke",
  "",
  "The smoke check runs in the container and must stay green.",
].join("\n");

const DEFAULT_SEATS = {
  coordinator: { provider: "codex", model: "gpt-5.6-luna" },
  auditor: { provider: "codex", model: "gpt-5.6-sol" },
};

const DEFAULT_BUDGET = { maxChains: 3, maxAttempts: 2, maxProbes: 5, maxConsults: 3, maxRework: 1 };

// The byte-exact clean driver mission ledger (the pre-change shape): the
// driver's `missionLedgerText` on a record with zero usage against
// DEFAULT_BUDGET.  A clean mission must stay byte-identical to this.
const CLEAN_DRIVER_LEDGER_JSON =
  '{"attempts":0,"chains":[],"probes":0,"consults":0,"coordinatorErrors":0,' +
  '"remaining":{"probes":5,"attempts":2,"chains":3,"consults":3}}';

// The byte-exact clean SOL mission ledger (the pre-change shape).
const CLEAN_SOL_LEDGER_JSON = '{"attempts":0,"chains":[],"probes":0,"consults":0,"coordinatorErrors":0}';

// ---------------------------------------------------------------------------
// fakes (injected-coordinator harness)
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
      return typeof entry === "function" ? entry(input) : entry;
    },
  };
}

const runChainStream = (brief) => (input) =>
  stream(line("run_chain", input.envelope.envelope_sha256, { brief }));

const readProbeStream = (tool, probePath) => (input) =>
  stream(line("read_probe", input.envelope.envelope_sha256, { tool, path: probePath }));

const finishStream = (recommendation) => (input) =>
  stream(line("finish", input.envelope.envelope_sha256, { recommendation }));

const malformedJsonStream = (input) =>
  stream(`{"action":"run_chain","envelope_sha256":"${input.envelope.envelope_sha256}"`);

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

function makeToolFake(output = "canned\n") {
  const calls = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { status: "ok", output };
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
// harness A: injected-coordinator mission
// ---------------------------------------------------------------------------

describe("the driver records and surfaces bounded brief corrections (criteria 1, 3, 4, 5, 6)", () => {
  let root;
  let cwd;
  let stateDir;
  let previousStateDir;
  let missionFile;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-luna-corrections-"));
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

  function missionIds() {
    const missionsDir = path.join(stateDir, "missions");
    return fs.existsSync(missionsDir)
      ? fs.readdirSync(missionsDir).filter((n) => n.startsWith("mission-"))
      : [];
  }

  /** Read a mission record by id. */
  function readMission(missionId) {
    const missionDir = path.join(stateDir, "missions", missionId);
    return {
      missionId,
      missionDir,
      control: readJson(path.join(missionDir, "control.json")),
      record: readJson(path.join(missionDir, "mission.json")),
    };
  }

  /** Run the driver with the given canned coordinator streams. */
  async function runMission(streams, overrides = {}) {
    const driver = await import("./luna-driver.mjs");
    const coord = makeCoordinator(streams);
    const chain = makeChainFake();
    const tools = makeToolFake();
    const sol = makeSolFake();
    const notifications = [];
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
        notifyMissionTerminal: async (info) => { notifications.push(info); },
        guardedServeStop: async () => {},
        ...(overrides.inject ?? {}),
      },
    };
    const before = missionIds();
    const result = await driver.runLunaMission(input);
    const after = missionIds();
    let missionId = overrides.missionId;
    if (missionId === undefined) {
      const fresh = after.filter((id) => !before.includes(id));
      assert.equal(fresh.length, 1, `exactly one new mission expected, got ${fresh.join(",")}`);
      missionId = fresh[0];
    } else {
      assert.ok(after.includes(missionId), `the requested mission id must exist after the run: ${missionId}`);
    }
    return {
      driver,
      coord,
      chain,
      tools,
      sol,
      notifications,
      result,
      input,
      mission: readMission(missionId),
    };
  }

  /** The mission-ledger evidence item of a persisted envelope. */
  function ledgerItemOf(envelope) {
    assert.ok(Array.isArray(envelope.items), "the envelope must carry items");
    const item = envelope.items.find((i) => i.source === "mission-ledger");
    assert.ok(item, "the envelope must carry the mission-ledger item");
    return item;
  }

  /** The corrections value embedded in a ledger JSON (any field name). */
  function correctionsValueOf(ledgerText, where) {
    const parsed = JSON.parse(ledgerText);
    const values = Object.values(parsed).filter(
      (v) => typeof v === "string" && v.includes("fails deterministic validation"),
    );
    assert.equal(
      values.length,
      1,
      `${where}: exactly one corrections text expected in the ledger, got ${values.length}`,
    );
    return values[0];
  }

  /** The validator-detail string inside a persisted entry (any field name). */
  function detailOf(entry, where) {
    const values = Object.values(entry).filter(
      (v) => typeof v === "string" && v.includes("fails deterministic validation"),
    );
    assert.equal(values.length, 1, `${where}: the persisted entry must carry exactly one validator detail`);
    return values[0];
  }

  it("criterion 1: a refused inner brief persists a structured briefCorrectionsDetails entry (timestamp, original action, validator detail) with the counters unchanged", async () => {
    const { chain, mission } = await runMission([
      runChainStream(MISSING_DELIVERABLES_BRIEF),
      finishStream("recommend-escalate"),
    ]);
    const { record } = mission;
    assert.ok(
      Array.isArray(record.briefCorrectionsDetails),
      "the refused brief must persist a briefCorrectionsDetails array (missing on pristine main — baseline-red)",
    );
    assert.equal(chain.calls.length, 0, "a refused brief must never reach the seam");
    assert.equal(record.briefCorrectionsDetails.length, 1, "exactly one correction entry persisted");
    const entry = record.briefCorrectionsDetails[0];
    // timestamp
    const ts = Object.values(entry).find((v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
    assert.ok(ts, "the persisted entry must carry a parseable timestamp");
    // original action
    assert.ok(
      Object.values(entry).includes("run_chain"),
      "the persisted entry must carry the original coordinator action (run_chain)",
    );
    // deterministic validator detail
    const detail = detailOf(entry, "the persisted correction");
    assert.ok(
      detail.includes("is absent or parses to zero entries"),
      "the persisted detail must be the driver-generated validator output, not a generic message",
    );
    // brief corrections have their own budget (#577): a correction does not
    // increment the coordinator error counter.
    assert.equal(record.briefCorrections, 1, "the briefCorrections counter must still count the refusal");
    assert.equal(record.coordinatorErrors, 0, "the coordinatorErrors counter is unchanged by a brief correction");
    assert.equal(record.disposition, "recommend-escalate", "the mission may still end via a later valid request");
  });

  it("criterion 3: the correction appears in the NEXT envelope ledger and binds the next envelope hash; a clean mission ledger is byte-identical to today", async () => {
    const { coord, mission } = await runMission([
      runChainStream(MISSING_DELIVERABLES_BRIEF),
      finishStream("recommend-escalate"),
    ]);
    const { missionDir } = mission;
    const envelope1 = readJson(path.join(missionDir, "evidence", "envelope-1.json"));
    const envelope2 = readJson(path.join(missionDir, "evidence", "envelope-2.json"));

    // Clean mission unchanged: the pre-correction envelope's ledger item is
    // byte-identical to the pre-change canonical ledger (same sha256).
    assert.equal(
      ledgerItemOf(envelope1).sha256,
      sha256(CLEAN_DRIVER_LEDGER_JSON),
      "a clean mission ledger must be byte-identical to the pre-change canonical ledger (no extra field)",
    );
    // The correction changes the driver ledger bytes -> the item hash and the
    // whole envelope hash must change.
    assert.notEqual(
      ledgerItemOf(envelope2).sha256,
      ledgerItemOf(envelope1).sha256,
      "the ledger item hash must change once the correction exists",
    );
    assert.notEqual(
      envelope2.envelope_sha256,
      envelope1.envelope_sha256,
      "the next envelope hash must bind the correction-bearing ledger",
    );
    // The on-disk ledger (last write = envelope-2's build; recommend-escalate
    // fires no gate) carries the rendered correction.
    const ledger = fs.readFileSync(path.join(missionDir, "evidence", "mission-ledger.txt"), "utf8");
    assert.ok(
      ledger.includes("is absent or parses to zero entries"),
      "the driver mission ledger must carry the rendered correction detail",
    );
    const rendered = correctionsValueOf(ledger, "the driver ledger");
    assert.ok(rendered.includes("run_chain refused: the inner chain brief fails deterministic validation"));
    // Envelope hash binding: the next coordinator dispatch was bound to the
    // exact persisted correction-bearing envelope.
    assert.equal(
      coord.calls[1].envelope.envelope_sha256,
      envelope2.envelope_sha256,
      "the next coordinator dispatch must be bound to the correction-bearing envelope",
    );
    assert.equal(coord.calls.length, 2, "exactly two dispatches (refusal, then finish)");
  });

  it("criterion 4: only the driver-generated validator detail is rendered — coordinator error text, probe output, and tool output never reach the ledger", async () => {
    // One correction, one probe (distinctive tool output), one malformed
    // stream (a coordinator error), then a terminal request.  maxAttempts 3
    // keeps the error cap (3) above the two recorded errors so the mission
    // ends normally after the fourth dispatch.
    const budget = { ...DEFAULT_BUDGET, maxAttempts: 3 };
    const toolSecret = "TOOL-OUTPUT-SECRET";
    const { mission } = await runMission(
      [
        runChainStream(MISSING_DELIVERABLES_BRIEF),
        readProbeStream("read_file_range", "p1"),
        malformedJsonStream,
        finishStream("recommend-escalate"),
      ],
      { budget, inject: { callTool: makeToolFake(toolSecret + "\n").callTool } },
    );
    const { missionDir, record } = mission;

    // The arbitrary texts ARE persisted (so their absence from the ledger is
    // a rendering boundary, not a recording gap).
    assert.ok(
      JSON.stringify(record.probes[0].output).includes(toolSecret),
      "the probe output must be recorded on the mission record",
    );
    const errorDetails = (Array.isArray(record.coordinatorErrorsDetails) ? record.coordinatorErrorsDetails : [])
      .map((e) => (typeof e?.detail === "string" ? e.detail : JSON.stringify(e)));
    assert.ok(
      errorDetails.some((d) => d.includes("coordinator stream invalid")),
      "the coordinator error text must be recorded on the mission record",
    );

    const envelope4 = readJson(path.join(missionDir, "evidence", "envelope-4.json"));
    const ledgerItem = ledgerItemOf(envelope4);
    assert.notEqual(
      ledgerItem.sha256,
      sha256(CLEAN_DRIVER_LEDGER_JSON),
      "the correction-bearing ledger must differ from the clean ledger",
    );
    const ledgerText = fs.readFileSync(path.join(missionDir, ledgerItem.path), "utf8");
    assert.ok(
      ledgerText.includes("is absent or parses to zero entries"),
      "the correction detail must be rendered into the ledger",
    );
    for (const forbidden of [toolSecret, "coordinator stream invalid", "malformed"]) {
      assert.ok(
        !ledgerText.includes(forbidden),
        `arbitrary ${forbidden} must never be rendered into the mission ledger`,
      );
    }
    assert.equal(record.disposition, "recommend-escalate");
  });

  it("criterion 6: a correction is a refusal with zero chain-state/seam side effects; a subsequent valid request proceeds; normal caps remain", async () => {
    const { chain, mission } = await runMission([
      runChainStream(MISSING_DELIVERABLES_BRIEF),
      runChainStream(VALID_RUN_CHAIN_BRIEF),
      finishStream("recommend-accept"),
    ]);
    const { record } = mission;
    assert.equal(chain.calls.length, 1, "only the VALID brief may reach the seam");
    const chainId = chain.calls[0].input.flags["chain-id"];
    assert.ok(Array.isArray(record.chains) && record.chains.length === 1 && record.chains[0] === chainId);
    assert.ok(Array.isArray(record.attempts) && record.attempts.length === 1, "one attempt, the valid one");
    assert.equal(record.coordinatorErrors, 0, "the correction does not increment coordinatorErrors");
    assert.equal(record.briefCorrections, 1, "the correction counts as the single brief correction");
    assert.ok(
      Array.isArray(record.briefCorrectionsDetails) && record.briefCorrectionsDetails.length === 1,
      "exactly one correction persisted",
    );
    assert.equal(record.disposition, "recommend-accept", "a subsequent valid request proceeds normally");
  });

  it("criterion 6: a coordinator that keeps proposing the same invalid brief terminates via no-progress (#577)", async () => {
    const { coord, chain, mission } = await runMission([
      runChainStream(MISSING_DELIVERABLES_BRIEF),
      runChainStream(MISSING_DELIVERABLES_BRIEF),
    ]);
    const { record } = mission;
    assert.equal(coord.calls.length, 2, "two refused dispatches");
    assert.equal(chain.calls.length, 0, "no seam call for a pure-correction mission");
    assert.equal(record.coordinatorErrors, 0, "corrections do not count as coordinator errors");
    assert.equal(record.briefCorrections, 2);
    assert.equal(record.disposition, "brief-correction-exhausted", "two consecutive identical brief corrections trigger no-progress");
  });

  it("empty Frozen Tests, missing Deliverables, and invalid Smoke briefs are actionable and sanitized", async () => {
    const cases = [
      {
        name: "missing Deliverables",
        brief: MISSING_DELIVERABLES_BRIEF,
        marker: "is absent or parses to zero entries",
        remedy: "Add the section",
      },
      {
        name: "empty Frozen Tests",
        brief: EMPTY_FROZEN_TESTS_BRIEF,
        marker: "## Frozen Tests` is present but parses to zero entries",
        remedy: "delete the heading entirely",
      },
      {
        name: "invalid Smoke",
        brief: INVALID_SMOKE_BRIEF,
        marker: "## Smoke",
        remedy: "delete the heading entirely",
      },
    ];
    for (const c of cases) {
      const { mission } = await runMission([runChainStream(c.brief), finishStream("recommend-escalate")]);
      const { missionDir, record } = mission;
      assert.ok(
        Array.isArray(record.briefCorrectionsDetails) && record.briefCorrectionsDetails.length === 1,
        `${c.name}: the refused brief must persist exactly one correction`,
      );
      const detail = detailOf(record.briefCorrectionsDetails[0], `${c.name} detail`);
      assert.ok(
        detail.includes(c.marker),
        `${c.name}: the persisted detail must name the offending part (${c.marker})`,
      );
      assert.ok(
        detail.includes(c.remedy),
        `${c.name}: the persisted detail must be actionable — it must state the remedy ("${c.remedy}")`,
      );
      // sanitized: no C0 controls other than the line breaks the validator
      // itself emits, and well under the 1200-byte per-correction bound.
      assert.ok(
        !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(detail),
        `${c.name}: the persisted detail must carry no C0 control characters`,
      );
      assert.ok(
        Buffer.byteLength(detail, "utf8") <= 1200,
        `${c.name}: the persisted detail must fit the 1200-byte per-correction bound`,
      );
      // the rendered ledger (envelope-2, last write) carries it too
      const ledger = fs.readFileSync(path.join(missionDir, "evidence", "mission-ledger.txt"), "utf8");
      assert.ok(
        ledger.includes(c.marker),
        `${c.name}: the rendered ledger must carry the actionable detail`,
      );
    }
  });

  it("criterion 5: resume carries the persisted corrections through the bounded renderer window and appends nothing", async () => {
    // Seed a resumable mission exactly like a crashed run leaves one: a
    // persisted record carrying SIX recorded corrections (six distinct
    // details, so the last-three-unique window must drop the first three)
    // and no terminal disposition.
    const missionId = "mission-correctionresume";
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
    const seededDetails = ["CORR-A", "CORR-B", "CORR-C", "CORR-D", "CORR-E", "CORR-F"].map((d) => ({
      at: "2026-09-23T00:00:00.000Z",
      action: "run_chain",
      detail: `run_chain refused: the inner chain brief fails deterministic validation\n${d}`,
    }));
    writeJson(path.join(missionDir, "mission.json"), {
      missionId,
      container: "test-cid",
      missionFile,
      pid: 99999999,
      status: "running",
      coordinator: DEFAULT_SEATS.coordinator,
      auditor: DEFAULT_SEATS.auditor,
      startedAt: "2026-09-23T00:00:00.000Z",
      attempts: [],
      chains: [],
      probes: [],
      consults: [],
      coordinatorErrors: 6,
      briefCorrections: 6,
      briefCorrectionsDetails: seededDetails,
      hostInterventions: 0,
      recommendation: null,
      disposition: null,
    });

    const resumeBudget = { ...DEFAULT_BUDGET, maxAttempts: 8 };
    const { mission } = await runMission([finishStream("recommend-escalate")], {
      missionId,
      budget: resumeBudget,
    });
    const { record } = mission;
    assert.equal(record.disposition, "recommend-escalate", "the resumed mission completes normally");
    assert.ok(
      Array.isArray(record.briefCorrectionsDetails) && record.briefCorrectionsDetails.length === 6,
      "resume must never duplicate or drop the persisted corrections on the record",
    );
    assert.equal(record.coordinatorErrors, 6, "resume must not re-record the persisted errors");
    assert.equal(record.briefCorrections, 6, "resume must not re-record the persisted corrections");

    const envelope1 = readJson(path.join(missionDir, "evidence", "envelope-1.json"));
    const ledgerItem = ledgerItemOf(envelope1);
    const ledger = fs.readFileSync(path.join(missionDir, ledgerItem.path), "utf8");
    for (const kept of ["CORR-D", "CORR-E", "CORR-F"]) {
      assert.ok(ledger.includes(kept), `the resumed ledger must carry the persisted correction ${kept}`);
    }
    for (const dropped of ["CORR-A", "CORR-B", "CORR-C"]) {
      assert.ok(
        !ledger.includes(dropped),
        `the bounded renderer window must drop the stale persisted correction ${dropped} on resume`,
      );
    }
  });

  it("criterion 3: driver and Sol mission ledgers carry the SAME rendered correction text, and the Sol gate envelope binds it", async () => {
    // Mission 1: [invalid brief, finish recommend-accept] fires the mandatory
    // pre-accept Sol gate after the correction is recorded.
    const run1 = await runMission([
      runChainStream(MISSING_DELIVERABLES_BRIEF),
      finishStream("recommend-accept"),
    ]);
    const m1 = run1.mission;
    assert.equal(run1.sol.calls.length, 1, "the pre-accept gate must fire after the correction");
    assert.equal(m1.record.auditGates.length, 1);
    const gateEnvelope = readJson(path.join(m1.missionDir, "evidence", "gate-envelope-gate-1.json"));
    const solLedger = fs.readFileSync(path.join(m1.missionDir, ledgerItemOf(gateEnvelope).path), "utf8");
    const vSol = correctionsValueOf(solLedger, "the Sol gate ledger");
    assert.ok(
      vSol.includes("is absent or parses to zero entries"),
      "the Sol mission ledger must carry the rendered correction detail",
    );
    assert.equal(
      run1.sol.calls[0].envelope.envelope_sha256,
      gateEnvelope.envelope_sha256,
      "the Sol seat must be bound to the persisted correction-bearing gate envelope",
    );

    // Mission 2: [invalid brief, recommend-escalate] fires no gate, so the
    // on-disk driver ledger is envelope-2's build — its corrections value is
    // readable from the evidence tree.
    const run2 = await runMission([
      runChainStream(MISSING_DELIVERABLES_BRIEF),
      finishStream("recommend-escalate"),
    ]);
    const m2 = run2.mission;
    const driverEnvelope2 = readJson(path.join(m2.missionDir, "evidence", "envelope-2.json"));
    const driverLedger = fs.readFileSync(path.join(m2.missionDir, ledgerItemOf(driverEnvelope2).path), "utf8");
    const vDriver = correctionsValueOf(driverLedger, "the driver ledger");
    assert.equal(
      vDriver,
      vSol,
      "the SAME rendered corrections text must appear in the driver and Sol mission ledgers (parity)",
    );

    // Sol clean ledger unchanged: missionEvidenceItems on a clean record must
    // produce the byte-exact pre-change ledger, and the correction-bearing
    // record must change those bytes.
    const { missionEvidenceItems } = await import("./luna-sol-gate.mjs");
    const cleanSolItem = missionEvidenceItems({ brief: MISSION_BRIEF, record: {} }).find(
      (i) => i.source === "mission-ledger",
    );
    assert.equal(cleanSolItem.content, CLEAN_SOL_LEDGER_JSON, "a clean Sol ledger must be byte-identical to today");
    const solItem = missionEvidenceItems({ brief: MISSION_BRIEF, record: m1.record }).find(
      (i) => i.source === "mission-ledger",
    );
    assert.notEqual(solItem.content, CLEAN_SOL_LEDGER_JSON, "the correction must change the Sol ledger bytes");
    assert.ok(
      solItem.content.includes("fails deterministic validation"),
      "the Sol ledger item must carry the rendered correction",
    );
  });
});

// ---------------------------------------------------------------------------
// harness B: REAL coordinator prompt seam (fake codex binary)
// ---------------------------------------------------------------------------

// The fake answers the FIRST dispatch with a run_chain carrying an invalid
// inner brief (missing `## Deliverables`), and every later dispatch with a
// valid escalate_to_host — so the real driver records one correction and the
// NEXT real prompt is the artifact under test.  A counter file (per test)
// keys the two behaviors; the fake never touches the real CLI.
const CORRECTION_FAKE_CODEX_TEMPLATE = `#!/usr/bin/env node
import fs from "node:fs";
const emit = (obj) => fs.writeSync(1, JSON.stringify(obj) + "\\n");
const stdinText = fs.readFileSync(0, "utf8");
const firstHash = (stdinText.match(/[0-9a-f]{64}/) || [])[0] || "f".repeat(64);
const counterFile = process.env.FAKE_CODEX_COUNTER_FILE;
let n = 1;
try { n = Number(fs.readFileSync(counterFile, "utf8")) + 1; } catch (err) {}
fs.writeFileSync(counterFile, String(n), "utf8");
const briefLines = [
  "Orchestrator: gpt-5.6-luna | session inner | 2026-09-23",
  "",
  "## Smoke",
  "",
  "- node --test plugins/kusabi/scripts/luna-wait.test.mjs",
].join("\\n");
const invalidRunChain = JSON.stringify({ action: "run_chain", envelope_sha256: firstHash, brief: briefLines });
const escalate = JSON.stringify({ action: "escalate_to_host", envelope_sha256: firstHash, reason: "correction feedback handoff" });
const text = n === 1 ? invalidRunChain : escalate;
emit({ type: "thread.started", thread_id: "__THREAD__" });
emit({ type: "item.completed", item: { type: "agent_message", text } });
emit({ type: "turn.completed", usage: {} });
process.exit(0);
`;

function fakeCodexContext() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-luna-corrections-codex-"));
  const binPath = path.join(tmp, "fake-codex.mjs");
  fs.writeFileSync(binPath, CORRECTION_FAKE_CODEX_TEMPLATE, "utf8");
  fs.chmodSync(binPath, 0o755);
  const counterFile = path.join(tmp, "codex-counter");
  const saved = {
    CODEX_BIN: process.env.CODEX_BIN,
    KUSABI_STATE_DIR: process.env.KUSABI_STATE_DIR,
    FAKE_CODEX_COUNTER_FILE: process.env.FAKE_CODEX_COUNTER_FILE,
    HOME: process.env.HOME,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  process.env.CODEX_BIN = binPath;
  process.env.FAKE_CODEX_COUNTER_FILE = counterFile;
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
    counterFile,
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

describe("the REAL coordinator prompt/evidence seam carries the persisted correction (criteria 3, 5)", () => {
  let ctx;
  let cwd;
  let stateDir;
  let missionFile;

  beforeEach(() => {
    ctx = fakeCodexContext();
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
    return { missionId: ids[0], missionDir, record: readJson(path.join(missionDir, "mission.json")) };
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

  /** The persisted full prompt of a job (what the seat actually received). */
  function jobPrompt(jobId) {
    return fs.readFileSync(path.join(stateDir, "jobs", jobId, "prompt.md"), "utf8");
  }

  /** Run a mission through the REAL coordinator dispatch seam (no injected coordinator). */
  async function runRealCoordinatorMission({ missionId } = {}) {
    const { runLunaMission } = await import("./luna-driver.mjs");
    const chain = { calls: [], run: async (cw, input) => { chain.calls.push({ cw, input }); return "chain"; } };
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
        callTool: async () => ({ status: "ok", output: "canned\n" }),
        solDispatch: async (input) =>
          JSON.stringify({
            type: "verdict",
            schema_version: 1,
            gate_id: input.envelope.gate_id,
            envelope_sha256: input.envelope.envelope_sha256,
            verdict: "clear",
            summary: "sol:clear",
          }),
        notifyMissionTerminal: async (info) => { notifications.push(info); },
        guardedServeStop: async () => {},
      },
    });
    return { result, chain, notifications, mission: readMission(), jobs: codexJobRecords() };
  }

  it("after an invalid inner brief, the persisted correction appears in the NEXT real coordinator prompt and ledger, and only there", async () => {
    const { mission, jobs, result } = await runRealCoordinatorMission();
    assert.match(result, /disposition=host-handoff/, "the later valid escalate stream must complete the mission");
    assert.equal(mission.record.disposition, "host-handoff");

    // The refused brief persisted a structured correction.
    assert.ok(
      Array.isArray(mission.record.briefCorrectionsDetails),
      "the real refused brief must persist briefCorrectionsDetails (missing on pristine main — baseline-red)",
    );
    assert.equal(mission.record.briefCorrectionsDetails.length, 1, "exactly one correction persisted");
    const detail = Object.values(mission.record.briefCorrectionsDetails[0]).find(
      (v) => typeof v === "string" && v.includes("fails deterministic validation"),
    );
    assert.ok(detail, "the persisted entry must carry the deterministic validator detail");
    assert.ok(detail.includes("is absent or parses to zero entries"), "the detail must be the actionable validator output");
    assert.equal(mission.record.coordinatorErrors, 0, "the correction does not increment coordinatorErrors");
    assert.equal(mission.record.briefCorrections, 1);

    // Two real dispatches: the refusal, then the terminal handoff.
    assert.equal(jobs.length, 2, "exactly two coordinator dispatch jobs");
    const envelope1 = readJson(path.join(mission.missionDir, "evidence", "envelope-1.json"));
    const envelope2 = readJson(path.join(mission.missionDir, "evidence", "envelope-2.json"));
    const prompt1 = jobs.find(({ job }) => jobPrompt(job.id).includes(envelope1.envelope_sha256));
    const prompt2 = jobs.find(({ job }) => jobPrompt(job.id).includes(envelope2.envelope_sha256));
    assert.ok(prompt1 && prompt2, "one job prompt per envelope hash");

    const prompt1Text = jobPrompt(prompt1.id);
    const prompt2Text = jobPrompt(prompt2.id);
    assert.ok(
      prompt2Text.includes("fails deterministic validation"),
      "the NEXT real coordinator prompt must carry the persisted correction detail",
    );
    assert.ok(
      prompt2Text.includes("is absent or parses to zero entries"),
      "the NEXT real coordinator prompt must carry the actionable validator detail",
    );
    assert.ok(
      !prompt1Text.includes("fails deterministic validation"),
      "the pre-correction prompt must not carry the correction detail",
    );

    // The evidence ledger (last write = envelope-2) carries the same detail.
    const ledger = fs.readFileSync(path.join(mission.missionDir, "evidence", "mission-ledger.txt"), "utf8");
    assert.ok(ledger.includes("is absent or parses to zero entries"), "the evidence ledger must carry the correction");
  });

  it("a clean mission adds no correction field or text to the real prompt or the envelope ledger", async () => {
    // The counter-based fake answers the FIRST dispatch with an invalid
    // run_chain — so for a clean-mission run, bypass the first dispatch by
    // pre-seeding the counter at 1 (the next invocation reads n=2 -> escalate).
    fs.writeFileSync(ctx.counterFile, "1", "utf8");
    const { mission, jobs } = await runRealCoordinatorMission();
    assert.equal(mission.record.disposition, "host-handoff");
    assert.equal(jobs.length, 1, "exactly one coordinator dispatch job");
    const prompt = jobPrompt(jobs[0].id);
    assert.ok(
      !/correction/i.test(prompt),
      "a clean mission prompt must carry no correction text at all",
    );
    assert.ok(!prompt.includes("fails deterministic validation"), "a clean prompt must not carry the validator detail");
    assert.ok(
      !prompt.includes("is absent or parses to zero entries"),
      "a clean prompt must not carry the validator detail",
    );
    const ledger = fs.readFileSync(path.join(mission.missionDir, "evidence", "mission-ledger.txt"), "utf8");
    assert.equal(
      ledger,
      CLEAN_DRIVER_LEDGER_JSON,
      "a clean mission envelope ledger must stay byte-identical to the pre-change canonical ledger",
    );
  });
});