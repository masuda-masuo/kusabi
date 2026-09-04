// backend-process-runner.test.mjs — focused tests for the shared subprocess
// lifecycle module (kusabi #462).
//
// Tests the three exports: isUsableTimeoutS, killProcessGroup, and
// runBackendProcess.  The runBackendProcess tests exercise the lifecycle
// with a fake CLI script, verifying line framing, timeout, silence watchdog,
// process-group kill, stdin handling, and the parseLine callback.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

import {
  isUsableTimeoutS,
  killProcessGroup,
  runBackendProcess,
} from "./backend-process-runner.mjs";

// =========================================================================
// isUsableTimeoutS — pure predicate
// =========================================================================

describe("isUsableTimeoutS", () => {
  it("returns true for positive finite numbers", () => {
    for (const value of [1, 20, 600, 1800, 3600, 0.5]) {
      assert.equal(isUsableTimeoutS(value), true, `value=${value} must be usable`);
    }
  });

  it("returns false for every non-positive-finite shape", () => {
    for (const value of [
      undefined, null, "", "3600", "1", NaN, 0, -5, -1.5,
      Infinity, -Infinity, true, false, {}, [], () => {},
    ]) {
      assert.equal(isUsableTimeoutS(value), false, `value=${String(value)} must not be usable`);
    }
  });
});

// =========================================================================
// runBackendProcess — lifecycle tests
// =========================================================================

// A fake CLI that emits NDJSON lines and exits, for testing the lifecycle
// without requiring any real backend binary.  Uses CommonJS (.cjs) to avoid
// shebang + ESM module resolution issues when spawned as a direct executable.
const FAKE_CLI_SOURCE = `#!/usr/bin/env node
const fs = require("fs");

const mode = process.env.FAKE_MODE || "ok";
const NL = String.fromCharCode(10);

function emit(obj) {
  fs.writeSync(1, JSON.stringify(obj) + NL);
}

// Read stdin if present (for cursor-like backends)
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const stdin = Buffer.concat(chunks).toString("utf8");
  if (stdin) {
    fs.writeFileSync(process.env.FAKE_STDIN_LOG || "/dev/null", stdin);
  }

  if (mode === "slow-emit") {
    // Emit nothing for 2 seconds, then an event — tests the silence watchdog
    // does NOT fire when activity arrives in time.
    setTimeout(() => {
      emit({ event: "result", result: { status: "ok" } });
      process.exit(0);
    }, 1500);
  } else if (mode === "no-emit") {
    // Emit nothing at all — tests the silence watchdog fires.
    // The process is killed by the watchdog, so we never reach exit.
    // Keep the process alive with a long timer.
    setTimeout(() => {}, 30_000);
  } else if (mode === "stdin-passthrough") {
    emit({ event: "stdin-content", text: stdin });
    process.exit(0);
  } else if (mode === "partial-line") {
    fs.writeSync(1, JSON.stringify({ event: "result", result: { status: "ok" } }));
    process.exit(0);
  } else {
    // Default: emit a few events and exit.
    emit({ event: "init", model: "test" });
    emit({ event: "step_update", step: 1 });
    emit({ event: "result", result: { status: "ok" } });
    process.exit(0);
  }
});
// If stdin is already closed (e.g. stdio "ignore"), the end event fires immediately.
`;

function fakeContext() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-runner-test-"));
  const binPath = path.join(tmp, "fake-cli.cjs");
  const stdinLog = path.join(tmp, "stdin.txt");
  fs.writeFileSync(binPath, FAKE_CLI_SOURCE, "utf8");
  fs.chmodSync(binPath, 0o755);
  fs.writeFileSync(stdinLog, "", "utf8");

  const saved = {
    FAKE_MODE: process.env.FAKE_MODE,
    FAKE_STDIN_LOG: process.env.FAKE_STDIN_LOG,
  };
  process.env.FAKE_STDIN_LOG = stdinLog;

  return {
    tmp,
    binPath,
    stdinLog,
    setMode(mode) { process.env.FAKE_MODE = mode; },
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

// A minimal parseLine that treats any JSON object as a parsed event.
function parseLineAnyJson(line) {
  const trimmed = typeof line === "string" ? line.trim() : "";
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

// A parseLine that returns null for everything (no events reset the clock).
function parseLineNothing() {
  return null;
}

describe("runBackendProcess", () => {
  let ctx;

  beforeEach(() => { ctx = fakeContext(); });
  afterEach(() => { ctx.restore(); });

  it("spawns the binary, frames stdout lines, and resolves with exit code", async () => {
    const result = await runBackendProcess({
      bin: ctx.binPath,
      args: [],
      cwd: ctx.tmp,
      parseLine: parseLineAnyJson,
    });
    assert.equal(result.spawnError, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.stalled, false);
    assert.equal(result.code, 0);
    // The fake CLI emits 3 NDJSON lines — onLine should have received each.
    assert.ok(result.stdout.includes("init"));
    assert.ok(result.stdout.includes("result"));
  });

  it("calls onLine with each complete stdout line", async () => {
    const lines = [];
    await runBackendProcess({
      bin: ctx.binPath,
      args: [],
      cwd: ctx.tmp,
      onLine: (line) => lines.push(line),
      parseLine: parseLineAnyJson,
    });
    // The fake CLI emits 3 lines (init, step_update, result).
    assert.equal(lines.length, 3);
    assert.ok(lines[0].includes("init"));
    assert.ok(lines[2].includes("result"));
  });

  it("calls onStart with the child's pid", async () => {
    let capturedPid = null;
    await runBackendProcess({
      bin: ctx.binPath,
      args: [],
      cwd: ctx.tmp,
      onStart: ({ pid }) => { capturedPid = pid; },
      parseLine: parseLineAnyJson,
    });
    assert.ok(typeof capturedPid === "number");
    assert.ok(capturedPid > 0);
  });

  it("writes promptText to stdin when provided (cursor pattern)", async () => {
    await runBackendProcess({
      bin: ctx.binPath,
      args: [],
      cwd: ctx.tmp,
      promptText: "HELLO-STDIN-TOKEN",
      parseLine: parseLineAnyJson,
    });
    const stdin = fs.readFileSync(ctx.stdinLog, "utf8");
    assert.match(stdin, /HELLO-STDIN-TOKEN/);
  });

  it("resolves a positive timeoutS by arming the timer (times out when slow)", async () => {
    ctx.setMode("no-emit");
    const start = Date.now();
    const result = await runBackendProcess({
      bin: ctx.binPath,
      args: [],
      cwd: ctx.tmp,
      timeoutS: 1,
      parseLine: parseLineNothing,
    });
    const elapsed = Date.now() - start;
    assert.equal(result.timedOut, true);
    assert.equal(result.stalled, false);
    // Should have completed in roughly 1 second, not the 30s the fake CLI sleeps.
    assert.ok(elapsed < 5000, `timed out too slowly: ${elapsed}ms`);
  });

  it("does NOT arm the timer when timeoutS is null", async () => {
    const result = await runBackendProcess({
      bin: ctx.binPath,
      args: [],
      cwd: ctx.tmp,
      timeoutS: null,
      parseLine: parseLineAnyJson,
    });
    // With null timeoutS and the default "ok" mode, the process exits normally.
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0);
  });

  it("arms the silence watchdog when watchdogS is positive (stalls when no events)", async () => {
    ctx.setMode("no-emit");
    const start = Date.now();
    const watchdogEvents = [];
    const result = await runBackendProcess({
      bin: ctx.binPath,
      args: [],
      cwd: ctx.tmp,
      watchdogS: 1,
      parseLine: parseLineNothing,
      onWatchdog: (event) => watchdogEvents.push(event),
    });
    const elapsed = Date.now() - start;
    assert.equal(result.stalled, true);
    assert.equal(result.timedOut, false);
    assert.ok(watchdogEvents.length >= 1);
    assert.equal(watchdogEvents[0].kind, "fired");
    assert.equal(watchdogEvents[watchdogEvents.length - 1].kind, "kill");
    // Should stall in ~1 second, not the 30s the fake CLI sleeps.
    assert.ok(elapsed < 5000, `stalled too slowly: ${elapsed}ms`);
  });

  it("resetting the silence clock via parseLine prevents stall when events arrive", async () => {
    ctx.setMode("slow-emit");
    const result = await runBackendProcess({
      bin: ctx.binPath,
      args: [],
      cwd: ctx.tmp,
      watchdogS: 3,
      parseLine: parseLineAnyJson,
    });
    // The fake CLI emits nothing for 1.5s, then an event.
    // With a 3s watchdog and parseLineAnyJson, the event resets the clock
    // before the watchdog fires.
    assert.equal(result.stalled, false);
    assert.equal(result.timedOut, false);
  });

  it("onLine errors do not crash the process runner (stats-fold safety)", async () => {
    const result = await runBackendProcess({
      bin: ctx.binPath,
      args: [],
      cwd: ctx.tmp,
      onLine: () => { throw new Error("stats-fold bug"); },
      parseLine: parseLineAnyJson,
    });
    assert.equal(result.spawnError, null);
    assert.equal(result.code, 0);
  });

  it("onWatchdog errors do not crash the process runner (audit-trail safety)", async () => {
    ctx.setMode("no-emit");
    const result = await runBackendProcess({
      bin: ctx.binPath,
      args: [],
      cwd: ctx.tmp,
      watchdogS: 1,
      parseLine: parseLineNothing,
      onWatchdog: () => { throw new Error("audit-trail bug"); },
    });
    assert.equal(result.stalled, true);
  });

  it("resolves with spawnError when the binary does not exist", async () => {
    const result = await runBackendProcess({
      bin: "/nonexistent/binary",
      args: [],
      cwd: ctx.tmp,
      parseLine: parseLineAnyJson,
    });
    assert.ok(result.spawnError !== null);
  });

  it("delivers the remaining lineBuffer on close (partial last line)", async () => {
    ctx.setMode("partial-line");
    const lines = [];
    const result = await runBackendProcess({
      bin: ctx.binPath,
      args: [],
      cwd: ctx.tmp,
      onLine: (line) => lines.push(line),
      parseLine: parseLineAnyJson,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.endsWith("\n"), false);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      event: "result",
      result: { status: "ok" },
    });
  });
});

// =========================================================================
// killProcessGroup — basic smoke test
// =========================================================================

describe("killProcessGroup", () => {
  it("does not throw when child has no pid", () => {
    killProcessGroup({ pid: null });
    killProcessGroup({ pid: undefined });
  });
});
