// claude-session-guard.test.mjs — tests for pre-dispatch session-quota guard (kusabi #215, #426).

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import process from "node:process";

import {
  CLAUDE_SESSION_GUARD_DEFAULT_PERCENT,
  resolveClaudeSessionGuard,
  claudeUsageProbeArgs,
  usageProbeTimeoutMs,
  parseClaudeSessionUsage,
  claudeSessionGuardObservation,
  renderClaudeSessionGuardRefusal,
  probeClaudeSessionUsage,
} from "./claude-session-guard.mjs";
import { renderClaudeQuotaError } from "./claude-dispatch.mjs";

// Source guard: moved names must NOT be defined in claude-dispatch.mjs
// after the move to claude-session-guard.mjs (kusabi #426).
describe("claude-session-guard source guard", () => {
  it("claude-dispatch.mjs contains no export function probeClaudeSessionUsage(", () => {
    const dispatchSrc = fs.readFileSync(
      path.join(import.meta.dirname, "claude-dispatch.mjs"),
      "utf8",
    );
    assert.ok(
      !dispatchSrc.includes("export function probeClaudeSessionUsage("),
      "claude-dispatch.mjs must not export probeClaudeSessionUsage",
    );
  });
});

describe("resolveClaudeSessionGuard", () => {
  it("no config file at all leaves the guard off (documented boundary)", () => {
    for (const absent of [null, undefined]) {
      const g = resolveClaudeSessionGuard(absent);
      assert.equal(g.enabled, false);
      assert.equal(g.threshold, null);
      assert.equal(g.reason, "no-config");
    }
  });

  it("a config with no guard key takes the default threshold", () => {
    for (const config of [{}, { models: { chain: [["opus"]] } }, { claude: {} }]) {
      const g = resolveClaudeSessionGuard(config);
      assert.equal(g.enabled, true);
      assert.equal(g.threshold, CLAUDE_SESSION_GUARD_DEFAULT_PERCENT);
      assert.equal(g.threshold, 90);
      assert.equal(g.reason, "default");
    }
  });

  it("true takes the default; a positive number is the threshold", () => {
    assert.deepEqual(
      resolveClaudeSessionGuard({ claude: { sessionGuardPercent: true } }),
      { enabled: true, threshold: 90, reason: "default" },
    );
    assert.deepEqual(
      resolveClaudeSessionGuard({ claude: { sessionGuardPercent: 50 } }),
      { enabled: true, threshold: 50, reason: "configured" },
    );
    // A JSON config may carry the number as a string; it still reads.
    assert.deepEqual(
      resolveClaudeSessionGuard({ claude: { sessionGuardPercent: "75" } }),
      { enabled: true, threshold: 75, reason: "configured" },
    );
  });

  it("false / 0 / a negative number disable the guard", () => {
    for (const raw of [false, 0, -1, "0"]) {
      const g = resolveClaudeSessionGuard({ claude: { sessionGuardPercent: raw } });
      assert.equal(g.enabled, false, `expected ${JSON.stringify(raw)} to disable the guard`);
      assert.equal(g.reason, "disabled");
    }
  });

  it("an unreadable threshold falls back to the default, never to off", () => {
    // A typo in the threshold must not silently remove the guard: that would
    // be the one failure mode the guard exists to prevent.
    for (const raw of ["ninety", {}, [], "", NaN]) {
      const g = resolveClaudeSessionGuard({ claude: { sessionGuardPercent: raw } });
      assert.equal(g.enabled, true, `expected ${JSON.stringify(raw)} to keep the guard on`);
      assert.equal(g.threshold, 90);
      assert.equal(g.reason, "unreadable-setting");
    }
  });

  it("a non-object config (or a non-object claude section) never throws", () => {
    assert.equal(resolveClaudeSessionGuard("nope").enabled, false);
    assert.equal(resolveClaudeSessionGuard([1, 2]).enabled, false);
    assert.equal(resolveClaudeSessionGuard({ claude: "yes" }).enabled, true);
    assert.equal(resolveClaudeSessionGuard({ claude: null }).enabled, true);
  });
});

describe("claudeUsageProbeArgs", () => {
  it("is exactly the measured control-plane invocation, and nothing else", () => {
    assert.deepEqual(claudeUsageProbeArgs(), ["-p", "--output-format", "json", "/usage"]);
    // No model, no MCP config, no allow/deny lists: every extra flag is a
    // flag that can make a free probe fail.
    for (const flag of ["--model", "--mcp-config", "--allowedTools", "--disallowedTools", "--resume"]) {
      assert.ok(!claudeUsageProbeArgs().includes(flag), `probe must not pass ${flag}`);
    }
  });
});

describe("usageProbeTimeoutMs", () => {
  const saved = process.env.KUSABI_CLAUDE_USAGE_PROBE_TIMEOUT_MS;

  afterEach(() => {
    if (saved === undefined) delete process.env.KUSABI_CLAUDE_USAGE_PROBE_TIMEOUT_MS;
    else process.env.KUSABI_CLAUDE_USAGE_PROBE_TIMEOUT_MS = saved;
  });

  it("defaults to a few seconds and honors the env override", () => {
    delete process.env.KUSABI_CLAUDE_USAGE_PROBE_TIMEOUT_MS;
    assert.equal(usageProbeTimeoutMs(), 5000);
    process.env.KUSABI_CLAUDE_USAGE_PROBE_TIMEOUT_MS = "250";
    assert.equal(usageProbeTimeoutMs(), 250);
    for (const bad of ["", "soon", "0", "-5"]) {
      process.env.KUSABI_CLAUDE_USAGE_PROBE_TIMEOUT_MS = bad;
      assert.equal(usageProbeTimeoutMs(), 5000, `${JSON.stringify(bad)} must fall back to the default`);
    }
  });
});

describe("parseClaudeSessionUsage", () => {
  // The REAL answer shape (kusabi #215, measured 2026-08-11): three prose
  // lines inside the `--output-format json` envelope's `result` field.
  const REAL_PROSE = [
    "Current session: 41% used \u00b7 resets Aug 11, 1:59pm (Asia/Tokyo)",
    "Current week (all models): 37% used \u00b7 resets Aug 16, 1:59am (Asia/Tokyo)",
    "Current week (Fable): 42% used \u00b7 resets Aug 16, 1:59am (Asia/Tokyo)",
  ].join("\n");

  it("reads the session line out of the json envelope, with its own reset", () => {
    const envelope = JSON.stringify({
      type: "result", subtype: "success", is_error: false, result: REAL_PROSE,
      total_cost_usd: 0, num_turns: 0, duration_api_ms: 0,
    });
    assert.deepEqual(parseClaudeSessionUsage(envelope), {
      percent: 41,
      // The reset on the SESSION line — never the weekly one, which is days away.
      reset: "Aug 11, 1:59pm (Asia/Tokyo)",
    });
  });

  it("reads bare prose too (the answer shape has no contract)", () => {
    assert.deepEqual(parseClaudeSessionUsage(REAL_PROSE), {
      percent: 41,
      reset: "Aug 11, 1:59pm (Asia/Tokyo)",
    });
  });

  it("a weekly line is never mistaken for the session line", () => {
    const weeklyOnly = [
      "Current week (all models): 37% used \u00b7 resets Aug 16, 1:59am (Asia/Tokyo)",
      "Current week (Fable): 99% used \u00b7 resets Aug 16, 1:59am (Asia/Tokyo)",
    ].join("\n");
    assert.deepEqual(parseClaudeSessionUsage(weeklyOnly), { percent: null, reset: null });
  });

  it("accepts a decimal reading and a line with no reset", () => {
    assert.deepEqual(parseClaudeSessionUsage("Current session: 12.5% used"), { percent: 12.5, reset: null });
    assert.deepEqual(parseClaudeSessionUsage("Current session: 100% used"), { percent: 100, reset: null });
  });

  it("anything else reads as no reading at all — the caller then proceeds", () => {
    for (const text of [
      "", "   ", "this is not the usage output",
      "Usage: claude [options] [command]",
      JSON.stringify({ type: "result", is_error: false, result: "" }),
      JSON.stringify({ type: "result", is_error: true, result: "unknown command: /usage" }),
      null, undefined, 42,
    ]) {
      assert.deepEqual(parseClaudeSessionUsage(text), { percent: null, reset: null },
        `expected no reading from ${JSON.stringify(text)}`);
    }
  });
});

describe("claudeSessionGuardObservation", () => {
  const readable = (percent, reset = "Aug 11, 1:59pm (Asia/Tokyo)") =>
    ({ readable: true, percent, reset, reason: null, detail: null, elapsedMs: 450 });

  it("refuses at and above the threshold, proceeds below it", () => {
    const guard = { enabled: true, threshold: 90, reason: "default" };
    assert.equal(claudeSessionGuardObservation(guard, readable(95)).decision, "refused");
    assert.equal(claudeSessionGuardObservation(guard, readable(90)).decision, "refused");
    assert.equal(claudeSessionGuardObservation(guard, readable(89.9)).decision, "proceeded");
    assert.equal(claudeSessionGuardObservation(guard, readable(41)).decision, "proceeded");
  });

  it("honors a custom threshold", () => {
    const guard = { enabled: true, threshold: 50, reason: "configured" };
    assert.equal(claudeSessionGuardObservation(guard, readable(60)).decision, "refused");
    assert.equal(claudeSessionGuardObservation(guard, readable(41)).decision, "proceeded");
  });

  it("an unreadable probe NEVER refuses, and says why it could not read", () => {
    const guard = { enabled: true, threshold: 90, reason: "default" };
    const obs = claudeSessionGuardObservation(
      guard,
      { readable: false, percent: null, reset: null, reason: "timeout", detail: "no answer within 400ms", elapsedMs: 401 },
    );
    assert.equal(obs.decision, "proceeded");
    assert.equal(obs.readable, false);
    assert.equal(obs.percent, null);
    assert.equal(obs.reason, "timeout");
    assert.match(obs.detail, /no answer within 400ms/);
    assert.equal(obs.threshold, 90);
    assert.equal(obs.probeMs, 401);
  });

  it("records the reading, the reset and the threshold on a proceeded dispatch", () => {
    const obs = claudeSessionGuardObservation({ threshold: 90 }, readable(41), "2026-08-11T02:00:00.000Z");
    assert.deepEqual(obs, {
      threshold: 90,
      percent: 41,
      reset: "Aug 11, 1:59pm (Asia/Tokyo)",
      readable: true,
      reason: null,
      detail: null,
      decision: "proceeded",
      observedAt: "2026-08-11T02:00:00.000Z",
      probeMs: 450,
    });
  });
});

describe("renderClaudeSessionGuardRefusal", () => {
  it("says pre-dispatch guard, the reading, the threshold, and that nothing ran", () => {
    const text = renderClaudeSessionGuardRefusal({ percent: 95, threshold: 90 });
    assert.match(text, /pre-dispatch session-quota guard refused/);
    assert.match(text, /95%/);
    assert.match(text, /refuse at 90%/);
    assert.match(text, /No worker was started/);
    assert.match(text, /did not fail mid-flight/);
  });

  it("composes with the existing quota renderer into the session-limit advice", () => {
    const failure = { quota: "session", reset: "Aug 11, 1:59pm (Asia/Tokyo)" };
    const text = renderClaudeQuotaError(failure, renderClaudeSessionGuardRefusal({ percent: 95, threshold: 90 }));
    assert.match(text, /pre-dispatch session-quota guard refused/);
    assert.match(text, /session limit exhausted \(resets Aug 11, 1:59pm \(Asia\/Tokyo\)\)/);
    assert.match(text, /the whole claude backend is blocked/);
    assert.match(text, /Switch the phase to the opencode backend/);
    assert.match(text, /do not retry claude/);
  });
});

describe("probeClaudeSessionUsage — direct", () => {
  it("a binary that cannot be started is unreadable, never a throw", async () => {
    const probe = await probeClaudeSessionUsage({
      bin: path.join(os.tmpdir(), "kusabi-no-such-claude-binary-xyz"),
      timeoutMs: 2000,
    });
    assert.equal(probe.readable, false);
    assert.equal(probe.reason, "spawn-failed");
    assert.equal(probe.percent, null);
    assert.match(probe.detail, /could not start/);
  });
});
