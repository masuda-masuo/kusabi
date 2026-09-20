import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { newestChainDir, cmdChainDetach } from "./chain-ops.mjs";
import { smokeBaselineReport } from "./chain-brief-guards.mjs";
import { createFakeCallTool } from "./fixtures.mjs";
import { stateDirFor } from "./state-paths.mjs";

describe("newestChainDir", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-chaindir-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the newest chain dir by mtime", () => {
    const oldDir = path.join(tmpDir, "chain-old");
    const newDir = path.join(tmpDir, "chain-new");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });
    const oldTime = new Date("2020-01-01").getTime();
    fs.utimesSync(oldDir, oldTime / 1000, oldTime / 1000);
    const result = newestChainDir(tmpDir);
    assert.equal(result, "chain-new");
  });

  it("returns null when chainsDir does not exist", () => {
    const result = newestChainDir(path.join(tmpDir, "nonexistent"));
    assert.equal(result, null);
  });

  it("returns null when no chain-* directories exist", () => {
    fs.mkdirSync(path.join(tmpDir, "some-other-dir"), { recursive: true });
    const result = newestChainDir(tmpDir);
    assert.equal(result, null);
  });

  it("returns null for empty directory", () => {
    const result = newestChainDir(tmpDir);
    assert.equal(result, null);
  });

  it("only matches chain-* directories", () => {
    fs.mkdirSync(path.join(tmpDir, "not_a_chain_dir"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "chain-real"), { recursive: true });
    const result = newestChainDir(tmpDir);
    assert.equal(result, "chain-real");
  });

  it("picks newest among multiple chain dirs", () => {
    const c1 = path.join(tmpDir, "chain-001");
    const c2 = path.join(tmpDir, "chain-002");
    const c3 = path.join(tmpDir, "chain-003");
    fs.mkdirSync(c1, { recursive: true });
    fs.mkdirSync(c2, { recursive: true });
    fs.mkdirSync(c3, { recursive: true });
    const t1 = new Date("2020-06-01").getTime();
    const t2 = new Date("2020-06-02").getTime();
    const t3 = new Date("2020-06-03").getTime();
    fs.utimesSync(c1, t1 / 1000, t1 / 1000);
    fs.utimesSync(c2, t2 / 1000, t2 / 1000);
    fs.utimesSync(c3, t3 / 1000, t3 / 1000);
    const result = newestChainDir(tmpDir);
    assert.equal(result, "chain-003");
  });

  it("uses lexicographic tiebreaker when mtimes are identical", () => {
    const cA = path.join(tmpDir, "chain-aaa");
    const cB = path.join(tmpDir, "chain-bbb");
    fs.mkdirSync(cA, { recursive: true });
    fs.mkdirSync(cB, { recursive: true });
    const sameTime = new Date("2020-01-01").getTime();
    fs.utimesSync(cA, sameTime / 1000, sameTime / 1000);
    fs.utimesSync(cB, sameTime / 1000, sameTime / 1000);
    const result = newestChainDir(tmpDir);
    assert.equal(result, "chain-aaa");
  });
});

describe("chain-ops source guard", () => {
  it("kusabi-companion.mjs does not define the moved functions", () => {
    const companionSource = fs.readFileSync(
      path.join(import.meta.dirname, "kusabi-companion.mjs"),
      "utf8"
    );
    const movedPatterns = [
      "async function cmdChainCancel(",
      "export async function cmdBaseline(",
      "export function newestChainDir(",
      "function cmdChainShow(",
      "function cmdChainWait(",
      "export function extractChainAndWaitArgs(",
      "export async function cmdChainDetach(",
    ];
    for (const pat of movedPatterns) {
      assert.ok(
        !companionSource.includes(pat),
        `kusabi-companion.mjs must not contain '${pat}'`
      );
    }
  });
});
// cmdChainDetach — smoke baseline refusal before spawn (kusabi #513)
// ---------------------------------------------------------------------------
// chain-detach spawned the chain child detached, unref'd it and immediately
// printed a launch banner; refusals that only fire inside the child (the
// ## Smoke baseline above all) then left the operator waiting on a chain that
// never existed.  The parent now measures the declared ## Smoke against the
// container BEFORE the log fd is opened, using the same guard and the same
// refusal text the foreground path prints.  The fakes below drive the REAL
// smokeBaselineReport (via createFakeCallTool's exit codes), never a stub of
// it.

const DETACH_BRIEF =
  "# Task\n\nOrchestrator: test-model | session s-1 | 2026-08-23\n\n" +
  "## Deliverables\n\n- `plugins/kusabi/scripts/x.mjs`\n\n" +
  "## Smoke\n\n- `npm test`\n";

describe("cmdChainDetach smoke baseline refusal (kusabi #513)", () => {
  function detachFixture() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-chaindetach-"));
    const cwd = path.join(tmp, "ws");
    fs.mkdirSync(cwd, { recursive: true });
    const prevStateEnv = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = path.join(tmp, "state");
    const stateDir = stateDirFor(cwd);
    const spawnCalls = [];
    const fakeSpawn = (cmd, args, options) => {
      spawnCalls.push({ cmd, args, options });
      return { pid: 424242, unref() {} };
    };
    return {
      tmp,
      cwd,
      stateDir,
      spawnCalls,
      opts(callTool) {
        return {
          stateRoot: path.join(tmp, "state"),
          now: "2026-09-20T00:00:00.000Z",
          spawn: fakeSpawn,
          callTool,
        };
      },
      cleanup() {
        if (prevStateEnv === undefined) delete process.env.KUSABI_STATE_DIR;
        else process.env.KUSABI_STATE_DIR = prevStateEnv;
        fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  }

  function detachLogs(stateDir) {
    if (!fs.existsSync(stateDir)) return [];
    return fs.readdirSync(stateDir).filter((f) => f.startsWith("chain-detach-"));
  }

  it("throws the exact smokeBaselineReport refusal and never spawns for a red ## Smoke", async () => {
    const fx = detachFixture();
    try {
      const callTool = createFakeCallTool({ exitCode: 1 });
      const expected = await smokeBaselineReport({ brief: DETACH_BRIEF, callTool, container: "cid-1" });
      assert.ok(expected, "a red smoke must produce a refusal from the real guard");
      await assert.rejects(
        () =>
          cmdChainDetach(
            fx.cwd,
            { flags: { container: "cid-1" }, text: DETACH_BRIEF },
            fx.opts(callTool),
          ),
        (err) => {
          assert.equal(
            err.message,
            expected,
            "the refusal text must be exactly what smokeBaselineReport returned",
          );
          return true;
        },
      );
      assert.equal(fx.spawnCalls.length, 0, "the injected spawn must never be called for a refused dispatch");
    } finally {
      fx.cleanup();
    }
  });

  it("creates no chain-detach log for a refused dispatch", async () => {
    const fx = detachFixture();
    try {
      const callTool = createFakeCallTool({ exitCode: 1 });
      const before = detachLogs(fx.stateDir);
      await assert.rejects(
        () =>
          cmdChainDetach(
            fx.cwd,
            { flags: { container: "cid-1" }, text: DETACH_BRIEF },
            fx.opts(callTool),
          ),
      );
      assert.deepEqual(
        detachLogs(fx.stateDir),
        before,
        "the log fd must not be opened before the refusal fires",
      );
    } finally {
      fx.cleanup();
    }
  });

  it("spawns exactly once and returns the unchanged banner for a green ## Smoke", async () => {
    const fx = detachFixture();
    try {
      const callTool = createFakeCallTool({ exitCode: 0 });
      const banner = await cmdChainDetach(
        fx.cwd,
        { flags: { container: "cid-1" }, text: DETACH_BRIEF },
        fx.opts(callTool),
      );
      assert.equal(fx.spawnCalls.length, 1, "a green baseline must spawn exactly once");
      assert.match(banner, /^Detached chain launched \(pid 424242\)\.$/m);
      assert.match(banner, /Log: .*chain-detach-\d+\.log/);
      assert.match(
        banner,
        /kusabi-companion chain-wait --next --since 2026-09-20T00:00:00\.000Z/,
      );
      assert.equal(detachLogs(fx.stateDir).length, 1, "one log file is created for the launched chain");
    } finally {
      fx.cleanup();
    }
  });
});
