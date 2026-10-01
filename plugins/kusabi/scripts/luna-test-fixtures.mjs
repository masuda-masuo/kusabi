// Shared byte-identical fixtures for the Luna and mission test suites.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let driverModule = null;

/**
 * A verdict record bound to the envelope the driver handed the Sol seat —
 * the same deterministic fake pattern as the #531 Luna tests: the fake
 * mirrors the real seat, it can only judge the envelope it was given, so
 * gate_id and envelope_sha256 come from input.envelope.
 */
const verdictLine = (input, verdict, extra = {}) =>
  j({
    type: "verdict",
    schema_version: 2, invariants: [{ id: "INV1", held: true }, { id: "INV2", held: true }, { id: "INV3", held: true }, { id: "INV4", held: true }, { id: "INV5", held: true }], criteria: [],
    gate_id: input.envelope.gate_id,
    envelope_sha256: input.envelope.envelope_sha256,
    verdict,
    summary: `sol:${verdict}`,
    ...extra,
  });

export const j = (obj) => JSON.stringify(obj);

export const line = (action, hash, body = {}) => j({ action, envelope_sha256: hash, ...body });

export const stream = (...lines) => lines.join("\n");

/** Stateful fake coordinator: each dispatch pops the next canned stream. */
export function makeCoordinator(streams) {
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

export const runChainStream = (brief) => (input) =>
  stream(line("run_chain", input.envelope.envelope_sha256, { brief }));

export const readProbeStream = (tool, probePath) => (input) =>
  stream(line("read_probe", input.envelope.envelope_sha256, { tool, path: probePath }));

export const finishStream = (recommendation) => (input) =>
  stream(line("finish", input.envelope.envelope_sha256, { recommendation }));

export const malformedJsonStream = (input) =>
  stream(`{"action":"run_chain","envelope_sha256":"${input.envelope.envelope_sha256}"`);

export function makeChainFake() {
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

export function makeSolFake() {
  const calls = [];
  return {
    calls,
    dispatch: async (input) => {
      calls.push(input);
      return JSON.stringify({
        type: "verdict",
        schema_version: 2, invariants: [{ id: "INV1", held: true }, { id: "INV2", held: true }, { id: "INV3", held: true }, { id: "INV4", held: true }, { id: "INV5", held: true }], criteria: [],
        gate_id: input.envelope.gate_id,
        envelope_sha256: input.envelope.envelope_sha256,
        verdict: "clear",
        summary: "sol:clear",
      });
    },
  };
}

export function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeToolFake() {
  const calls = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { status: "ok", output: "canned\n" };
    },
  };
}

export function makeNotify() {
  const calls = [];
  return {
    calls,
    dispatch: async (info) => { calls.push(info); },
  };
}

export const consultStream = (reason) => (input) =>
  stream(line("consult_sol", input.envelope.envelope_sha256, { reason }));

export const escalateStream = (reason) => (input) =>
  stream(line("escalate_to_host", input.envelope.envelope_sha256, { reason }));

/**
 * Fake runChainLifecycle: records every invocation.  The driver must call the
 * seam with the chain id it wants (flags["chain-id"]) so the mission can
 * record inner-chain references deterministically — the seam itself validates
 * the shape (chain-[a-z0-9]+) exactly like the real runChainLifecycle does.
 *
 * An optional shared order log lets a test prove request ordering across the
 * fakes (a probe before a chain, for example).
 */
export function makeOrderedChainFake(sharedOrder = null) {
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

export function toolResponse(name) {
  if (name === "sandbox_exec") return { status: "ok", output: "deadbeef1234\n" };
  if (name === "verify_in_container") {
    return { status: "ok", gate_passed: true, lint: [], types: [], tests: { full: { passed: 1, failed: 0, skipped: 0 } } };
  }
  if (name === "diff_in_container") return { status: "ok", output: "diff --git a/x b/x\n" };
  return { status: "ok", output: "canned\n" };
}

export async function lunaDriver() {
  if (driverModule === null) {
    driverModule = await import("./luna-driver.mjs");
  }
  return driverModule;
}

export const reworkChainStream = (brief) => (input) =>
  stream(line("rework_chain", input.envelope.envelope_sha256, { brief }));

export function makeCompletedChainFake() {
  const calls = [];
  return {
    calls,
    run: async (cwd, input, opts) => {
      calls.push({ cwd, input, opts });
      return `Chain ${input?.flags?.["chain-id"] ?? calls.length} completed`;
    },
  };
}

export const clearSol = (input) => verdictLine(input, "clear");
