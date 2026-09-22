// luna-sol-gate.test.mjs — acceptance tests for the kusabi #531 Sol safety gates.
//
// Frozen acceptance contract (kusabi #531 criteria 1, 2, 3, 7, 8, 9, 10 — the
// driver-side gate slice):
//
//   - the deterministic driver evaluates audit policy at exactly three
//     lifecycle points — PRE-DISPATCH (immediately before executing a
//     run_chain / rework_chain request), POST-CHAIN (after each inner-chain
//     terminal result), and PRE-ACCEPT (immediately before finalising a
//     `finish recommend-accept` terminal recommendation, the T11 gate).  A
//     Sol seat is bought at a point ONLY when evaluateAuditGate requires it
//     (mandatory trigger), sampling selects it (T12), or Luna requested an
//     additive consult_sol — no lifecycle point unconditionally buys a seat;
//   - at a MANDATORY gate, missing / unavailable / empty / malformed /
//     ambiguous / evidence-mismatched Sol results FAIL CLOSED to the
//     terminal mission disposition `sol-blocked`; only sample-only
//     unavailability records `audit-sample-skipped` and may proceed;
//   - `clear` proceeds; `rework` permits only bounded `rework_chain`
//     followed by a fresh gate; `block` terminates `sol-blocked` and Luna
//     never gets another dispatch to clear it;
//   - verdict authority is bound to gate id + exact envelope SHA-256; when
//     evidence changes, the old verdict is ARCHIVED with reason
//     `evidence-changed`, excluded from the next envelope's
//     `prior_verdicts`, and never deleted or silently reused;
//   - the terminal mandatory gate applies to approval-shaped
//     `recommend-accept` (T11), not to blocking a host escalation
//     (`escalate_to_host` / `recommend-escalate` are not gated);
//   - `sol-blocked` is a TERMINAL mission disposition for show/wait
//     surfaces;
//   - a terminal mission emits EXACTLY ONE terminal notification and the
//     host handoff (`recommendation.md`).
//
// Public surface frozen here (beyond the existing #530 runLunaMission):
//
//   input.sampling = { rate, salt }        — folded into every
//     evaluateAuditGate call (missionId = the mission id); absent = no
//     sampling (T12 never fires).
//   input.budget.maxRework                  — the bound on consecutive Sol
//     `rework` verdicts (default 1); exceeding it fails closed sol-blocked.
//   input.inject.solDispatch                — async
//     ({ cwd, missionId, missionDir, envelope, gate, record, auditor }) =>
//     string; the envelope carries `gate_id`, `envelope_sha256`, `items`
//     and `prior_verdicts`.  Returns the Sol seat's raw JSONL output
//     (parseAuditVerdictJsonl vocabulary: finding records + exactly one
//     verdict record).
//   input.inject.notifyMissionTerminal     — called exactly once per
//     terminal mission with { missionId, disposition, ... }.
//
// Gate records: record.auditGates[] = { gateId (gate-N, sequential per
// mission), phase ("pre-dispatch" | "post-chain" | "pre-accept" |
// "consult"), verdict ("clear"|"rework"|"block"), disposition
// ("verdict-recorded" | "sol-blocked" | "audit-sample-skipped"), reason
// (the fail-closed cause: "unavailable" | "empty" | "missing" | "malformed"
// | "ambiguous" | "evidence-mismatch"), envelopeSha256, required, mandatory,
// sampled, triggers, archived?, archiveReason? }.
//
// Test state: every test uses a temp KUSABI_STATE_DIR, a temp cwd, fake
// coordinator/chain/tool/Sol/notify seams.  Nothing calls the real Codex
// CLI, Docker, GitHub, kaiba, or a background watcher.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { stateDirFor, readJson } from "./state-paths.mjs";
import { TERMINAL_MISSION_DISPOSITIONS } from "./mission-store.mjs";

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
const consultStream = (reason) => (input) =>
  stream(line("consult_sol", input.envelope.envelope_sha256, { reason }));
const escalateStream = (reason) => (input) =>
  stream(line("escalate_to_host", input.envelope.envelope_sha256, { reason }));

/** Fake runChainLifecycle: records every invocation; optional shared order log. */
function makeChainFake(sharedOrder = null) {
  const calls = [];
  const order = [];
  return {
    calls,
    order,
    run: async (cwd, input, opts) => {
      calls.push({ cwd, input, opts });
      const tag = `chain:${calls.length}`;
      order.push(tag);
      if (sharedOrder) sharedOrder.push(tag);
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

function makeToolFake(sharedOrder = null) {
  const calls = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (sharedOrder) sharedOrder.push(`tool:${name}`);
      return toolResponse(name);
    },
  };
}

/**
 * A verdict record bound to the envelope the driver handed the Sol seat —
 * the fake must mirror the real seat: it can only judge the envelope it was
 * given, so gate_id and envelope_sha256 come from input.envelope.
 */
const verdictLine = (input, verdict, extra = {}) =>
  j({
    type: "verdict",
    schema_version: 1,
    gate_id: input.envelope.gate_id,
    envelope_sha256: input.envelope.envelope_sha256,
    verdict,
    ...(verdict === "block" ? { block_reason: "wrong_premise", acknowledgement_required: true } : {}),
    summary: `sol:${verdict}`,
    ...extra,
  });
const findingLine = (severity = "high") =>
  j({ type: "finding", severity, title: "Premise unverified", body: "The issue premise is not supported." });

const clearSol = (input) => verdictLine(input, "clear");
const reworkSol = (input) => verdictLine(input, "rework");
const blockSol = (input) => verdictLine(input, "block");
const throwSol = () => { throw new Error("Sol seat unavailable (quota)"); };
const emptySol = () => "";
const missingSol = () => findingLine("high");
const malformedSol = (input) => verdictLine(input, "looks-good");
const ambiguousSol = (input) => stream(verdictLine(input, "clear"), verdictLine(input, "block"));
const mismatchSol = (input) => verdictLine(input, "clear", { envelope_sha256: "f".repeat(64) });

/**
 * Fake Sol seat.  `handler(input)` returns the raw output text (or throws).
 * Records every dispatch input, so tests can assert the envelope each gate
 * was judged against (gate_id, envelope_sha256, prior_verdicts).
 */
function makeSol(handler, sharedOrder = null) {
  const calls = [];
  return {
    calls,
    dispatch: async (input) => {
      calls.push(input);
      if (sharedOrder) sharedOrder.push(`sol:${input.envelope.gate_id}`);
      return handler(input);
    },
  };
}

/** Fake terminal notification: the driver must call it EXACTLY once per terminal mission. */
function makeNotify() {
  const calls = [];
  return {
    calls,
    dispatch: async (info) => { calls.push(info); },
  };
}

// ---------------------------------------------------------------------------
// briefs
// ---------------------------------------------------------------------------

const MISSION_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-sol-gate-test | 2026-09-21",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-sol-gate.test.mjs` — the #531 Sol gate freeze.",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-sol-gate.test.mjs`",
].join("\n");

const VALID_RUN_CHAIN_BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-sol-gate-inner | 2026-09-21",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-reconcile.test.mjs` — the #531 reconcile freeze.",
  "",
  "## Workplace",
  "",
  "- Container: `test-cid`",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-reconcile.test.mjs`",
].join("\n");

const DEFAULT_SEATS = {
  coordinator: { provider: "codex", model: "gpt-5.6-luna" },
  auditor: { provider: "codex", model: "gpt-5.6-sol" },
};

// #531 adds the rework bound to the #530 budget: consecutive Sol `rework`
// verdicts beyond maxRework fail closed (default 1).
const DEFAULT_BUDGET = { maxChains: 3, maxAttempts: 2, maxProbes: 5, maxConsults: 3, maxRework: 1 };

const SAMPLED = { rate: 1, salt: "v1" };
const UNSAMPLED = { rate: 0, salt: "v1" };

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

describe("luna Sol gates (kusabi #531 criteria 1, 2, 3, 7, 8, 9, 10)", () => {
  let root;
  let cwd;
  let stateDir;
  let previousStateDir;
  let missionFile;

  beforeEach(() => {
    root = makeTemp("kusabi-luna-sol-gate-");
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

  /**
   * Run the driver with canned coordinator streams.  `solDispatch` overrides
   * the default clear-verdict fake; `sampling` sets input.sampling; `budget`
   * merges over the #531 defaults.
   */
  async function runMission(streams, { solDispatch = clearSol, sampling = null, budget, ...rest } = {}) {
    const driver = await lunaDriver();
    const order = [];
    const coord = makeCoordinator(streams);
    const chain = makeChainFake(order);
    const tools = makeToolFake(order);
    const sol = makeSol(solDispatch, order);
    const notify = makeNotify();
    const input = {
      cwd,
      missionFile,
      brief: MISSION_BRIEF,
      container: "test-cid",
      ...DEFAULT_SEATS,
      allowSubstitute: false,
      budget: { ...DEFAULT_BUDGET, ...(budget ?? {}) },
      ...(sampling ? { sampling } : {}),
      ...rest,
      inject: {
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: chain.run,
        callTool: tools.callTool,
        solDispatch: sol.dispatch,
        notifyMissionTerminal: notify.dispatch,
        guardedServeStop: async () => {},
      },
    };
    const result = await driver.runLunaMission(input);
    return { driver, coord, chain, tools, sol, notify, result, input, order };
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

  function gates(record) {
    assert.ok(Array.isArray(record.auditGates), "the #531 driver must record record.auditGates");
    return record.auditGates;
  }

  it("surface: exports runLunaMission", async () => {
    const driver = await lunaDriver();
    assert.equal(typeof driver.runLunaMission, "function");
  });

  it("sol-blocked is a TERMINAL mission disposition (criterion 8)", () => {
    assert.ok(
      TERMINAL_MISSION_DISPOSITIONS.has("sol-blocked"),
      "sol-blocked must be terminal for show/wait surfaces",
    );
  });

  it("policy is evaluated at the three lifecycle points and a sampled gate buys a seat at each (criterion 1)", async () => {
    // rate=1 sampling makes T12 fire at every point; every gate is reached
    // and cleared, so the mission ends recommend-accept with exactly three
    // Sol dispatches in the documented phase order.
    const { chain, sol, coord, notify, order } = await runMission(
      [
        runChainStream(VALID_RUN_CHAIN_BRIEF),
        finishStream("recommend-accept"),
      ],
      { sampling: SAMPLED },
    );
    const { record } = readMission();

    assert.equal(chain.calls.length, 1, "the chain request must have executed");
    assert.equal(sol.calls.length, 3, "one seat per lifecycle point: pre-dispatch, post-chain, pre-accept");
    assert.equal(coord.calls.length, 2);
    const gateIds = sol.calls.map((c) => c.envelope.gate_id);
    assert.deepEqual(gateIds, ["gate-1", "gate-2", "gate-3"], "gate ids are sequential per mission");

    // Ordering: the pre-dispatch gate precedes the chain, the post-chain
    // gate follows it, the pre-accept gate is last.  The fakes append every
    // observable event to ONE shared chronological array AT CALL TIME, so the
    // four real-time boundaries are provable from a single timeline (the
    // driver's actual phase order: pre-dispatch Sol, chain, post-chain Sol,
    // pre-accept Sol) rather than from per-seat logs concatenated after the
    // fact.
    const log = order;
    const sol1 = log.indexOf("sol:gate-1");
    const sol2 = log.indexOf("sol:gate-2");
    const sol3 = log.indexOf("sol:gate-3");
    const chain1 = log.indexOf("chain:1");
    assert.ok(sol1 >= 0 && sol2 >= 0 && sol3 >= 0 && chain1 >= 0, `order log: ${log.join(" -> ")}`);
    assert.ok(sol1 < chain1, `pre-dispatch gate must precede the chain (${log.join(" -> ")})`);
    assert.ok(chain1 < sol2, `post-chain gate must follow the chain (${log.join(" -> ")})`);
    assert.ok(sol2 < sol3, `pre-accept gate must come last (${log.join(" -> ")})`);

    const g = gates(record);
    assert.deepEqual(
      g.map((x) => x.phase),
      ["pre-dispatch", "post-chain", "pre-accept"],
      "the frozen phase vocabulary names the three points",
    );
    assert.deepEqual(
      g.map((x) => x.verdict),
      ["clear", "clear", "clear"],
    );
    assert.deepEqual(
      g.map((x) => x.disposition),
      ["verdict-recorded", "verdict-recorded", "verdict-recorded"],
    );
    for (const gate of g) {
      assert.match(gate.gateId, /^gate-[0-9]+$/);
      assert.match(gate.envelopeSha256, /^[0-9a-f]{64}$/);
      assert.equal(gate.sampled, true);
      assert.ok(Array.isArray(gate.triggers) && gate.triggers.some((t) => t.id === "T12"));
    }
    assert.equal(record.disposition, "recommend-accept");
    assert.equal(notify.calls.length, 1, "exactly one terminal notification");
    assert.equal(notify.calls[0].disposition, "recommend-accept");
    assert.equal(notify.calls[0].missionId, readMission().missionId);
  });

  it("no lifecycle point unconditionally buys a seat: no triggers, no sampling, no recommend-accept (criterion 1)", async () => {
    // A run_chain + recommend-escalate mission with sampling disabled and no
    // mandatory trigger must dispatch the Sol seat ZERO times.
    const { chain, sol } = await runMission(
      [
        runChainStream(VALID_RUN_CHAIN_BRIEF),
        finishStream("recommend-escalate"),
      ],
      { sampling: UNSAMPLED },
    );
    const { record } = readMission();
    assert.equal(chain.calls.length, 1);
    assert.equal(sol.calls.length, 0, "no Sol seat may be bought without a trigger, sample, or consult");
    assert.equal(record.disposition, "recommend-escalate");
  });

  it("the terminal mandatory gate applies to recommend-accept (T11) and a clear lets it proceed (criterion 9)", async () => {
    const { sol } = await runMission([finishStream("recommend-accept")], { sampling: UNSAMPLED });
    const { record } = readMission();
    assert.equal(sol.calls.length, 1, "T11 is mandatory: exactly the pre-accept gate fires");
    const g = gates(record);
    assert.equal(g.length, 1);
    assert.equal(g[0].phase, "pre-accept");
    assert.equal(g[0].mandatory, true);
    assert.equal(g[0].verdict, "clear");
    assert.equal(record.disposition, "recommend-accept");
    // The recommendation is a host-facing recommendation, never acceptance.
    assert.doesNotMatch(JSON.stringify(record), /"accepted":true/);
    assert.doesNotMatch(JSON.stringify(record), /"published":true/);
  });

  it("mandatory gate fail-closed table: missing/unavailable/empty/malformed/ambiguous/evidence-mismatch -> sol-blocked (criterion 2)", async () => {
    // One mission per failure kind: the pre-accept T11 gate is mandatory,
    // the Sol seat produces the named failure, and the mission must fail
    // closed to sol-blocked with zero further execution.
    const cases = [
      { name: "unavailable", dispatch: throwSol, reason: "unavailable" },
      { name: "empty", dispatch: emptySol, reason: "empty" },
      { name: "missing", dispatch: missingSol, reason: "missing" },
      { name: "malformed", dispatch: malformedSol, reason: "malformed" },
      { name: "ambiguous", dispatch: ambiguousSol, reason: "ambiguous" },
      { name: "evidence-mismatch", dispatch: mismatchSol, reason: "evidence-mismatch" },
    ];
    for (const c of cases) {
      const { coord, chain, sol, notify } = await runMission(
        [finishStream("recommend-accept")],
        { sampling: UNSAMPLED, solDispatch: c.dispatch },
      );
      const { control, record } = readMission();
      assert.equal(record.disposition, "sol-blocked", `${c.name} must fail closed to sol-blocked`);
      assert.equal(control.status, "completed", `${c.name}: the mission finalises terminal`);
      assert.equal(chain.calls.length, 0, `${c.name}: nothing may execute after the failed gate`);
      assert.equal(coord.calls.length, 1, `${c.name}: no further coordinator dispatch after the failed gate`);
      assert.equal(sol.calls.length, 1);
      const g = gates(record);
      assert.equal(g.length, 1, `${c.name}: the failed gate is recorded`);
      assert.equal(g[0].phase, "pre-accept");
      assert.equal(g[0].mandatory, true);
      assert.equal(g[0].disposition, "sol-blocked");
      assert.equal(g[0].reason, c.reason, `${c.name}: the fail-closed cause is recorded exactly`);
      assert.equal(notify.calls.length, 1, `${c.name}: terminal -> one notification`);
      assert.equal(notify.calls[0].disposition, "sol-blocked");
      fs.rmSync(path.join(stateDir, "missions"), { recursive: true, force: true });
    }
  });

  it("sample-only unavailability records audit-sample-skipped and may proceed (criterion 2)", async () => {
    // rate=1: every gate point is reached but ONLY via T12 (sampled-only).
    // The seat is unavailable at both gates; the mission records the skips
    // and proceeds to recommend-escalate — never sol-blocked.
    const { chain, sol } = await runMission(
      [
        runChainStream(VALID_RUN_CHAIN_BRIEF),
        finishStream("recommend-escalate"),
      ],
      { sampling: SAMPLED, solDispatch: throwSol },
    );
    const { record } = readMission();
    assert.equal(chain.calls.length, 1, "a sampled-only skip must not block the chain");
    assert.equal(sol.calls.length, 2, "the seat was attempted at both sampled gates");
    const g = gates(record);
    assert.equal(g.length, 2);
    for (const gate of g) {
      assert.equal(gate.mandatory, false, "sampled-only gates are the sole deliberate fail-open");
      assert.equal(gate.sampled, true);
      assert.equal(gate.required, true);
      assert.equal(gate.disposition, "audit-sample-skipped");
      assert.equal(gate.reason, "unavailable");
    }
    assert.equal(record.disposition, "recommend-escalate", "the mission proceeds past sample-only skips");
  });

  it("rework permits bounded rework_chain followed by a fresh gate (criterion 3)", async () => {
    // Gate-2 (post-chain) returns rework; Luna then issues a bounded
    // rework_chain; the post-rework gate-4 is a FRESH gate that returns
    // clear; the pre-accept T11 gate clears last.
    const verdicts = [clearSol, reworkSol, clearSol, clearSol, clearSol];
    let solCall = 0;
    const { chain, sol } = await runMission(
      [
        runChainStream(VALID_RUN_CHAIN_BRIEF),
        reworkChainStream(VALID_RUN_CHAIN_BRIEF),
        finishStream("recommend-accept"),
      ],
      { sampling: SAMPLED, budget: { ...DEFAULT_BUDGET, maxRework: 1 }, solDispatch: (input) => {
        const idx = Math.min(solCall, verdicts.length - 1);
        solCall += 1;
        return verdicts[idx](input);
      } },
    );
    const { record } = readMission();
    assert.equal(chain.calls.length, 2, "run_chain + one bounded rework_chain");
    assert.equal(sol.calls.length, 5);
    const g = gates(record);
    assert.deepEqual(g.map((x) => x.phase), [
      "pre-dispatch", "post-chain", "pre-dispatch", "post-chain", "pre-accept",
    ]);
    assert.deepEqual(g.map((x) => x.verdict), ["clear", "rework", "clear", "clear", "clear"]);
    assert.equal(record.disposition, "recommend-accept");
  });

  it("rework is bounded: consecutive rework verdicts beyond maxRework fail closed sol-blocked (criterion 3)", async () => {
    // gate-2 reworks, gate-4 reworks again — the bound (maxRework=1) is
    // exhausted, the gate is still not cleared, and the mission fails
    // closed.  Luna never gets a third dispatch.
    const verdicts = [clearSol, reworkSol, clearSol, reworkSol];
    let solCall = 0;
    const { chain, sol, coord } = await runMission(
      [
        runChainStream(VALID_RUN_CHAIN_BRIEF),
        reworkChainStream(VALID_RUN_CHAIN_BRIEF),
      ],
      { sampling: SAMPLED, budget: { ...DEFAULT_BUDGET, maxRework: 1 }, solDispatch: (input) => {
        const idx = Math.min(solCall, verdicts.length - 1);
        solCall += 1;
        return verdicts[idx](input);
      } },
    );
    const { record } = readMission();
    assert.equal(chain.calls.length, 2);
    assert.equal(coord.calls.length, 2, "no third coordinator dispatch after the bound is exhausted");
    assert.equal(sol.calls.length, 4);
    const g = gates(record);
    assert.equal(g.length, 4);
    assert.equal(g[3].verdict, "rework");
    assert.equal(record.disposition, "sol-blocked", "an uncleared mandatory gate fails closed");
  });

  it("block cannot be cleared by Luna: the mission terminates sol-blocked with no further dispatch (criterion 3)", async () => {
    const { chain, sol, coord } = await runMission(
      [
        runChainStream(VALID_RUN_CHAIN_BRIEF),
        finishStream("recommend-accept"),
      ],
      { sampling: SAMPLED, solDispatch: (input) =>
        input.envelope.gate_id === "gate-2" ? blockSol(input) : clearSol(input) },
    );
    const { record } = readMission();
    assert.equal(chain.calls.length, 1);
    assert.equal(coord.calls.length, 1, "after a Sol block, Luna never gets another dispatch to clear it");
    assert.equal(sol.calls.length, 2);
    const g = gates(record);
    assert.equal(g[1].phase, "post-chain");
    assert.equal(g[1].verdict, "block");
    assert.equal(record.disposition, "sol-blocked");
  });

  it("verdict authority is bound to gate id + envelope SHA-256; evidence change archives the old verdict (criterion 7)", async () => {
    // Attempt 2 (rework_chain) changes the evidence envelope, so gate-1's
    // verdict can no longer be an active prior: it is archived with reason
    // evidence-changed, excluded from the next gate's prior_verdicts, and
    // never deleted.
    const { sol } = await runMission(
      [
        runChainStream(VALID_RUN_CHAIN_BRIEF),
        reworkChainStream(VALID_RUN_CHAIN_BRIEF),
        finishStream("recommend-escalate"),
      ],
      { sampling: SAMPLED },
    );
    const { record } = readMission();
    const g = gates(record);
    assert.ok(g.length >= 2, "two gates must have been evaluated");

    const gate1 = g[0];
    assert.equal(gate1.verdict, "clear");
    assert.equal(gate1.disposition, "verdict-recorded");

    // The gate-2 envelope must not carry gate-1's verdict as a prior (the
    // evidence it judged changed) — never silently reused.
    const gate2Input = sol.calls[1].envelope;
    assert.ok(Array.isArray(gate2Input.prior_verdicts), "the gate envelope carries prior_verdicts");
    assert.ok(
      !gate2Input.prior_verdicts.some((v) => v.gate_id === gate1.gateId),
      `the archived gate-1 verdict must be excluded from prior_verdicts: ${JSON.stringify(gate2Input.prior_verdicts)}`,
    );
    // gate-1's envelope differs from gate-2's (the rework changed evidence).
    assert.notEqual(gate1.envelopeSha256, gate2Input.envelope_sha256);

    // The old verdict is ARCHIVED with the evidence-changed reason, never deleted.
    assert.equal(gate1.archived, true, "the superseded verdict must be marked archived");
    assert.equal(gate1.archiveReason, "evidence-changed");
    assert.equal(gate1.verdict, "clear", "the archived verdict record itself is never deleted");
  });

  it("escalate_to_host writes a recommendation and is not gated — the terminal gate never blocks a host escalation (criterion 9)", async () => {
    const { sol, chain } = await runMission(
      [escalateStream("premise ambiguous, host judgement required")],
      { sampling: SAMPLED },
    );
    const { record, missionDir } = readMission();
    assert.equal(sol.calls.length, 0, "a host escalation is not approval-shaped — no Sol seat");
    assert.equal(chain.calls.length, 0);
    assert.equal(record.disposition, "host-handoff");
    const recFile = path.join(missionDir, "recommendation.md");
    assert.ok(fs.existsSync(recFile), "the host handoff must be written");
    assert.match(fs.readFileSync(recFile, "utf8"), /premise ambiguous, host judgement required/);
  });

  it("consult_sol opens an additive gate but cannot downgrade the mandatory pre-accept gate (criterion 1, negative)", async () => {
    // Luna requests a consult; Sol clears the consult.  The mandatory T11
    // pre-accept gate must STILL fire afterwards, and its failure must still
    // fail closed — a consult clear is additive, never a substitute.
    const { sol } = await runMission(
      [
        runChainStream(VALID_RUN_CHAIN_BRIEF),
        consultStream("additional audit requested by coordinator"),
        finishStream("recommend-accept"),
      ],
      {
        sampling: UNSAMPLED,
        solDispatch: (input) =>
          input.envelope.gate_id === "gate-1" ? clearSol(input) : throwSol(),
      },
    );
    const { record } = readMission();
    const g = gates(record);
    assert.equal(g.length, 2, "the consult gate AND the mandatory pre-accept gate both fire");
    assert.equal(g[0].phase, "consult");
    assert.equal(g[0].verdict, "clear");
    assert.equal(g[1].phase, "pre-accept");
    assert.equal(g[1].disposition, "sol-blocked");
    assert.equal(record.disposition, "sol-blocked",
      "a consult clear must not satisfy the mandatory pre-accept gate (Luna cannot downgrade required gates)");
    assert.equal(sol.calls.length, 2);
  });
});

// ---------------------------------------------------------------------------
// kusabi #532 criterion 4 — live gate durability.  Every recorded gate must
// store the normalized policyInput it was evaluated with, the actual
// decision/verdict, its consultation origin ("luna-requested" |
// "policy-mandated" | "sampled") and a deterministic shadow disposition
// computed with solVerdict: null.  The shadow is a counterfactual ONLY: it
// never changes the live mission disposition or the live policy.
// ---------------------------------------------------------------------------

describe("live gate durability (kusabi #532 criterion 4)", () => {
  let root;
  let cwd;
  let stateDir;
  let previousStateDir;
  let missionFile;

  beforeEach(() => {
    root = makeTemp("kusabi-532-gate-durability-");
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

  async function runMission(streams, { solDispatch = clearSol, sampling = null } = {}) {
    const driver = await lunaDriver();
    const coord = makeCoordinator(streams);
    const chain = makeChainFake();
    const tools = makeToolFake();
    const sol = makeSol(solDispatch);
    const notify = makeNotify();
    const input = {
      cwd,
      missionFile,
      brief: MISSION_BRIEF,
      container: "test-cid",
      ...DEFAULT_SEATS,
      allowSubstitute: false,
      budget: { ...DEFAULT_BUDGET },
      ...(sampling ? { sampling } : {}),
      inject: {
        coordinatorDispatch: coord.dispatch,
        runChainLifecycle: chain.run,
        callTool: tools.callTool,
        solDispatch: sol.dispatch,
        notifyMissionTerminal: notify.dispatch,
        guardedServeStop: async () => {},
      },
    };
    const result = await driver.runLunaMission(input);
    return { driver, coord, chain, sol, notify, result };
  }

  function readMission() {
    const missionsDir = path.join(stateDir, "missions");
    const ids = fs.readdirSync(missionsDir).filter((n) => n.startsWith("mission-"));
    assert.equal(ids.length, 1);
    const missionDir = path.join(missionsDir, ids[0]);
    return {
      missionId: ids[0],
      record: readJson(path.join(missionDir, "mission.json")),
    };
  }

  it("every recorded gate stores the normalized policyInput that reproduces its recorded decision", async () => {
    await runMission(
      [runChainStream(VALID_RUN_CHAIN_BRIEF), finishStream("recommend-accept")],
      { sampling: SAMPLED },
    );
    const { record, missionId } = readMission();
    const g = record.auditGates;
    assert.equal(g.length, 3);

    const { evaluateAuditGate } = await import("./audit-policy.mjs");
    for (const gate of g) {
      assert.ok(gate.policyInput && typeof gate.policyInput === "object",
        `gate ${gate.gateId} must record its normalized policyInput`);
      assert.equal(gate.policyInput.gateId, gate.gateId);
      // The recorded input REPLAYS to the recorded decision — the single
      // decision source stays evaluateAuditGate.
      const replayed = evaluateAuditGate(gate.policyInput);
      assert.equal(replayed.required, gate.required, `${gate.gateId}: policyInput must reproduce required`);
      assert.equal(replayed.mandatory, gate.mandatory, `${gate.gateId}: policyInput must reproduce mandatory`);
      assert.equal(replayed.sampled, gate.sampled, `${gate.gateId}: policyInput must reproduce sampled`);
      assert.deepEqual(
        replayed.triggers.map((t) => t.id),
        gate.triggers.map((t) => t.id),
        `${gate.gateId}: policyInput must reproduce the trigger set`,
      );
    }
    // The pre-accept gate's input carries the T11 signal.
    assert.equal(g[2].policyInput.lunaRecommendsAccept, true);
    // Sampling is recorded with the durable subject id (the mission id).
    for (const gate of g) {
      assert.equal(gate.policyInput.sampling.missionId, missionId);
      assert.equal(gate.policyInput.sampling.rate, 1);
      assert.equal(gate.policyInput.sampling.salt, "v1");
    }
  });

  it("records the consultation origin: luna-requested for consult, policy-mandated when mandatory, sampled when T12-only", async () => {
    // Sampled mission ending recommend-accept: gate-1/-2 fire ONLY via T12
    // (sampled), gate-3 is the mandatory T11 gate (policy-mandated).
    await runMission(
      [runChainStream(VALID_RUN_CHAIN_BRIEF), finishStream("recommend-accept")],
      { sampling: SAMPLED },
    );
    const { record: sampledRecord } = readMission();
    const phases = sampledRecord.auditGates.map((x) => [x.phase, x.origin]);
    assert.deepEqual(phases, [
      ["pre-dispatch", "sampled"],
      ["post-chain", "sampled"],
      ["pre-accept", "policy-mandated"],
    ]);
    fs.rmSync(path.join(stateDir, "missions"), { recursive: true, force: true });

    // Consult mission: the additive gate is Luna-requested.
    await runMission(
      [consultStream("additional audit requested by coordinator"), finishStream("recommend-escalate")],
      { sampling: UNSAMPLED },
    );
    const { record: consultRecord } = readMission();
    assert.equal(consultRecord.auditGates.length, 1);
    const consultGate = consultRecord.auditGates[0];
    assert.equal(consultGate.phase, "consult");
    assert.equal(consultGate.origin, "luna-requested");
    // A consult gate is NOT a policy decision (kusabi #532 adjudication): it
    // fires on the synthetic "consult" reason, so no replayable policyInput
    // is fabricated — the recorded field is explicitly null, while the real
    // origin/verdict/shadow outcome are all preserved.
    assert.equal(consultGate.policyInput, null,
      "a Luna-requested consult gate must not fabricate a policy decision");
    assert.equal(consultGate.verdict, "clear");
    // With solVerdict: null the seat is unavailable; a required gate that is
    // neither mandatory nor sampled still fails closed (the invariant-shaped
    // rule) — the shadow is sol-blocked, never audit-sample-skipped.
    assert.equal(consultGate.shadowDisposition, "sol-blocked");
  });

  it("records a deterministic shadow disposition computed with solVerdict: null", async () => {
    const { resolveSolGateSeatFailure } = await import("./audit-envelope.mjs");
    await runMission(
      [runChainStream(VALID_RUN_CHAIN_BRIEF), finishStream("recommend-accept")],
      { sampling: SAMPLED },
    );
    const { record } = readMission();
    for (const gate of record.auditGates) {
      const expected = resolveSolGateSeatFailure({
        required: true,
        mandatory: gate.mandatory,
        sampled: gate.sampled,
        seatAvailable: false,
      }).disposition;
      assert.equal(gate.shadowDisposition, expected,
        `${gate.gateId} (mandatory=${gate.mandatory}, sampled=${gate.sampled}) must shadow to ${expected}`);
    }
    // The mandatory pre-accept gate shadows sol-blocked; the sampled-only
    // gates shadow audit-sample-skipped.
    assert.equal(record.auditGates[0].shadowDisposition, "audit-sample-skipped");
    assert.equal(record.auditGates[2].shadowDisposition, "sol-blocked");
  });

  it("the shadow is a counterfactual only: it never changes the live mission disposition (frozen boundary)", async () => {
    await runMission(
      [runChainStream(VALID_RUN_CHAIN_BRIEF), finishStream("recommend-accept")],
      { sampling: SAMPLED },
    );
    const { record } = readMission();
    // The recorded gate verdicts are clear, the shadow of the mandatory
    // gate is sol-blocked — yet the LIVE mission disposition must remain
    // recommend-accept.  The shadow never feeds the driver's outcome.
    assert.deepEqual(record.auditGates.map((x) => x.verdict), ["clear", "clear", "clear"]);
    assert.equal(record.auditGates[2].shadowDisposition, "sol-blocked");
    assert.equal(record.disposition, "recommend-accept",
      "the recorded shadow must not leak into the live mission disposition");
    assert.doesNotMatch(JSON.stringify(record), /"disposition":"sol-blocked"/,
      "no live field may claim the counterfactual block");
  });
});
// ---------------------------------------------------------------------------
// realSolDispatch failure propagation (criterion 5 / criterion 7)
// ---------------------------------------------------------------------------
//
// The production Sol seam is realSolDispatch.  The tests below point CODEX_BIN
// at a fake `codex` that RESOLVES its job either failed (nonzero exit) or
// completed with a non-empty but syntactically invalid verdict payload, and
// pin the fail-closed distinction:
//   - a resolved FAILED codex job must THROW from realSolDispatch with the job
//     id/status/error, and a mandatory gate over the real seam must classify
//     it as a dispatch/audit-seat failure (reason "unavailable") - never as an
//     empty verdict stream (reason "empty");
//   - a genuine COMPLETED job whose non-empty terminal message is not a
//     verdict stream resolves as a stream and the gate classifies it as a
//     PARSER failure ("missing"), never as a dispatch failure.  (A process
//     with NO terminal assistant message is job.status "error" by fail-closed
//     contract; that blank-stream case is NOT a completed job and is never
//     tested here as one.)

const REAL_SOL_FAKE_CODEX_TEMPLATE = `#!/usr/bin/env node
import fs from "node:fs";
const mode = process.env.FAKE_CODEX_MODE ?? "exit-3";
const emit = (obj) => fs.writeSync(1, JSON.stringify(obj) + "\\n");
if (mode === "exit-3") {
  fs.writeSync(2, "codex: crashed\\n");
  process.exit(3);
} else if (mode === "invalid") {
  emit({ type: "thread.started", thread_id: "__THREAD__" });
  emit({ type: "item.completed", item: { type: "agent_message", text: "not a verdict record" } });
  emit({ type: "turn.completed", usage: {} });
  process.exit(0);
}
process.exit(0);
`;

function realSolFakeCodexContext(mode) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-sol-fake-codex-"));
  const binPath = path.join(tmp, "fake-codex.mjs");
  fs.writeFileSync(binPath, REAL_SOL_FAKE_CODEX_TEMPLATE, "utf8");
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

describe("realSolDispatch failure propagation (criterion 5/7)", () => {
  let ctx;

  beforeEach(() => {
    ctx = realSolFakeCodexContext("exit-3");
  });

  afterEach(() => {
    ctx.restore();
  });

  function codexJobRecords() {
    const jobsDir = path.join(ctx.stateDir, "jobs");
    if (!fs.existsSync(jobsDir)) return [];
    return fs
      .readdirSync(jobsDir)
      .filter((n) => n.startsWith("job-"))
      .map((id) => ({ id, job: readJson(path.join(jobsDir, id, "job.json")) }));
  }

  function solDispatchArgs(overrides = {}) {
    return {
      cwd: ctx.cwd,
      missionId: "mission-aaaaaaaa",
      envelope: { envelope_sha256: "e".repeat(64) },
      gate: { gateId: "gate-1", phase: "pre-dispatch" },
      auditor: { provider: "codex", model: "gpt-5.6-sol" },
      ...overrides,
    };
  }

  it("a resolved failed codex job THROWS from realSolDispatch with the job id/status/error, never a silent empty stream", async () => {
    ctx.setMode("exit-3");
    const { realSolDispatch } = await import("./luna-sol-gate.mjs");
    await assert.rejects(
      () => realSolDispatch(solDispatchArgs()),
      (err) => {
        const msg = String(err?.message ?? "");
        const jobRecords = codexJobRecords();
        assert.ok(jobRecords.length >= 1, "the real dispatch must have created a codex job record");
        const job = jobRecords[jobRecords.length - 1].job;
        assert.notEqual(job.status, "completed", "the fake codex job must be a resolved FAILED job");
        assert.ok(msg.includes(job.id), `the thrown dispatch error must name the codex job id (${job.id}): ${msg}`);
        assert.ok(msg.includes(job.status), `the thrown dispatch error must name the job status (${job.status}): ${msg}`);
        assert.ok(msg.includes(job.error), "the thrown dispatch error must carry the underlying job error");
        return true;
      },
    );
  });

  it("a mandatory gate over the real Sol seam classifies a failed codex job as a dispatch failure (unavailable), never as an empty verdict stream", async () => {
    ctx.setMode("exit-3");
    const { evaluateMissionGate, realSolDispatch } = await import("./luna-sol-gate.mjs");
    const missionDir = path.join(ctx.stateDir, "missions", "mission-aaaaaaaa");
    fs.mkdirSync(missionDir, { recursive: true });
    const result = await evaluateMissionGate({
      cwd: ctx.cwd,
      missionId: "mission-aaaaaaaa",
      missionDir,
      brief: "Sol dispatch-failure classification",
      container: "test-cid",
      auditor: { provider: "codex", model: "gpt-5.6-sol" },
      allowSubstitute: false,
      sampling: null,
      phase: "pre-accept",
      reason: null,
      record: {},
      solDispatch: realSolDispatch,
      stopRequested: () => false,
      maxRework: 1,
    });
    assert.equal(result.fired, true, "the pre-accept T11 gate must fire");
    assert.equal(result.outcome, "sol-blocked");
    assert.ok(result.gate, "a fired gate must carry its record");
    assert.equal(
      result.gate.reason,
      "unavailable",
      "a failed codex job is a dispatch/audit-seat failure, never parsed as an empty verdict stream",
    );
    assert.notEqual(result.gate.reason, "empty");
  });

  it("a genuine completed job with non-empty invalid verdict content resolves as a stream and stays a parser failure, never a dispatch failure (criterion 7)", async () => {
    ctx.setMode("invalid");
    const { evaluateMissionGate, realSolDispatch } = await import("./luna-sol-gate.mjs");
    const text = await realSolDispatch(solDispatchArgs());
    assert.equal(typeof text, "string", "a completed job must resolve to its stream text, never throw");
    assert.equal(text.trim(), "not a verdict record", "the non-empty invalid terminal message is the stream text");
    const jobRecords = codexJobRecords();
    assert.ok(jobRecords.length >= 1, "the real dispatch must have created a codex job record");
    assert.equal(
      jobRecords[jobRecords.length - 1].job.status,
      "completed",
      "a non-empty terminal message genuinely completes the job",
    );
    // The gate classifies the invalid CONTENT as a parser failure ("missing"),
    // never as a dispatch failure ("unavailable").
    const missionDir = path.join(ctx.stateDir, "missions", "mission-aaaaaaaa");
    fs.mkdirSync(missionDir, { recursive: true });
    const result = await evaluateMissionGate({
      cwd: ctx.cwd,
      missionId: "mission-aaaaaaaa",
      missionDir,
      brief: "Sol invalid-verdict-content classification",
      container: "test-cid",
      auditor: { provider: "codex", model: "gpt-5.6-sol" },
      allowSubstitute: false,
      sampling: null,
      phase: "pre-accept",
      reason: null,
      record: {},
      solDispatch: realSolDispatch,
      stopRequested: () => false,
      maxRework: 1,
    });
    assert.equal(result.fired, true, "the pre-accept T11 gate must fire");
    assert.equal(result.outcome, "sol-blocked");
    assert.equal(result.gate.reason, "missing", "invalid verdict content is a stream/parser failure, never a dispatch failure");
    assert.notEqual(result.gate.reason, "unavailable");
  });
});