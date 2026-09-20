import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { newestChainDir, cmdChainDetach } from "./chain-ops.mjs";
import { createChainDir } from "./chain-phases.mjs";
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

  it("spawns exactly once and returns the launch banner for a green ## Smoke", async () => {
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
      assert.match(banner, /kusabi-companion chain-wait chain-[a-z0-9]+/);
      assert.equal(detachLogs(fx.stateDir).length, 1, "one log file is created for the launched chain");
    } finally {
      fx.cleanup();
    }
  });

  it("names the SAME chain id in the wait line and the child argv, passed exactly once (kusabi #514)", async () => {
    const fx = detachFixture();
    try {
      const callTool = createFakeCallTool({ exitCode: 0 });
      const banner = await cmdChainDetach(
        fx.cwd,
        { flags: { container: "cid-1" }, text: DETACH_BRIEF },
        fx.opts(callTool),
      );
      assert.equal(fx.spawnCalls.length, 1);
      const args = fx.spawnCalls[0].args;
      assert.equal(
        args.filter((a) => a === "--chain-id").length,
        1,
        "the child argv must carry --chain-id exactly once",
      );
      const childChainId = args[args.indexOf("--chain-id") + 1];
      assert.match(childChainId, /^chain-[a-z0-9]+$/, "the child argv carries a freshly minted id");
      // One test, both facts: the id the wait line names IS the id the child
      // was told to use, so a future change cannot drift them apart.
      assert.match(
        banner,
        new RegExp(`kusabi-companion chain-wait ${childChainId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
        "the banner's wait line names the id the child argv carries",
      );
    } finally {
      fx.cleanup();
    }
  });

  it("emits a wait line with neither --next nor --since, forwarding the tracking flags (kusabi #514)", async () => {
    const fx = detachFixture();
    try {
      const callTool = createFakeCallTool({ exitCode: 0 });
      const banner = await cmdChainDetach(
        fx.cwd,
        {
          flags: {
            container: "cid-1",
            "appear-timeout": "30",
            "poll-interval": "5",
            "progress-timeout": "900",
            since: "2026-09-19T00:00:00.000Z",
          },
          text: DETACH_BRIEF,
        },
        fx.opts(callTool),
      );
      const waitLine = banner.split("\n").find((l) => l.trim().startsWith("kusabi-companion chain-wait"));
      assert.ok(waitLine, "the banner carries a wait line");
      assert.doesNotMatch(waitLine, /--next/);
      assert.doesNotMatch(waitLine, /--since/);
      assert.match(waitLine, /--appear-timeout 30/);
      assert.match(waitLine, /--poll-interval 5/);
      assert.match(waitLine, /--progress-timeout 900/);
    } finally {
      fx.cleanup();
    }
  });

  it("refuses a malformed --chain-id before any filesystem write (kusabi #514)", async () => {
    for (const bad of ["../escape", "chain-a/b", "nope", ""]) {
      const fx = detachFixture();
      try {
        const callTool = createFakeCallTool({ exitCode: 0 });
        await assert.rejects(
          () =>
            cmdChainDetach(
              fx.cwd,
              { flags: { container: "cid-1", "chain-id": bad }, text: DETACH_BRIEF },
              fx.opts(callTool),
            ),
          /invalid chain id/,
        );
        assert.equal(fx.spawnCalls.length, 0, `no spawn for --chain-id ${JSON.stringify(bad)}`);
        assert.equal(
          detachLogs(fx.stateDir).length,
          0,
          `no log file may be created for --chain-id ${JSON.stringify(bad)}`,
        );
        // Nothing under chains/ and no traversal: had ../escape ever reached
        // path.join it would have landed in stateDir/escape — the parent of
        // chains/ — so that directory must be untouched.
        assert.equal(
          fs.existsSync(path.join(fx.stateDir, "chains")),
          false,
          `no chains directory may be created for --chain-id ${JSON.stringify(bad)}`,
        );
        assert.equal(
          fs.existsSync(path.join(fx.stateDir, "escape")),
          false,
          `the parent directory must be untouched for --chain-id ${JSON.stringify(bad)}`,
        );
      } finally {
        fx.cleanup();
      }
    }
  });

  it("refuses a supplied --chain-id whose directory already exists, before spawn, log or banner (kusabi #514 finding 1)", async () => {
    const fx = detachFixture();
    try {
      // The dangerous shape: the pre-existing chain is TERMINAL, so a wait
      // line whose subject exists would resolve at once — a false completion
      // for a launch that was refused.
      const chainDir = path.join(fx.stateDir, "chains", "chain-pre");
      fs.mkdirSync(chainDir, { recursive: true });
      fs.writeFileSync(
        path.join(chainDir, "control.json"),
        JSON.stringify({ chainId: "chain-pre", container: "cid-0", pid: 1, status: "completed", round: 1 }),
      );

      // The refusal must be the SAME message createChainDir throws — assert
      // equality between the two real messages, not two hand-written strings.
      let createDirMessage = null;
      try {
        createChainDir(fx.stateDir, "chain-pre");
      } catch (err) {
        createDirMessage = err.message;
      }
      assert.ok(createDirMessage, "createChainDir must refuse the same id");

      const callTool = createFakeCallTool({ exitCode: 0 });
      await assert.rejects(
        () =>
          cmdChainDetach(
            fx.cwd,
            { flags: { container: "cid-1", "chain-id": "chain-pre" }, text: DETACH_BRIEF },
            fx.opts(callTool),
          ),
        (err) => err.message === createDirMessage,
      );
      assert.equal(fx.spawnCalls.length, 0, "the injected spawn must never be called");
      assert.equal(detachLogs(fx.stateDir).length, 0, "no log file may be created for a refused launch");
      // No banner: cmdChainDetach only returns the banner on success, and the
      // rejection above is the failure path — nothing was announced.
    } finally {
      fx.cleanup();
    }
  });

  it("refuses a MINTED id whose directory already exists, via the injected mint (kusabi #514 finding 1)", async () => {
    const fx = detachFixture();
    try {
      const chainDir = path.join(fx.stateDir, "chains", "chain-mint-collide");
      fs.mkdirSync(chainDir, { recursive: true });
      fs.writeFileSync(
        path.join(chainDir, "control.json"),
        JSON.stringify({ chainId: "chain-mint-collide", container: "cid-0", pid: 1, status: "running", round: 1 }),
      );

      const callTool = createFakeCallTool({ exitCode: 0 });
      // Inject the collision: the mint the launcher would perform returns
      // exactly the id whose directory already exists.
      await assert.rejects(
        () =>
          cmdChainDetach(
            fx.cwd,
            { flags: { container: "cid-1" }, text: DETACH_BRIEF },
            { ...fx.opts(callTool), mintChainId: () => "chain-mint-collide" },
          ),
        /chain id already exists: chain-mint-collide/,
      );
      assert.equal(fx.spawnCalls.length, 0, "the injected spawn must never be called");
      assert.equal(detachLogs(fx.stateDir).length, 0, "no log file may be created for a refused launch");
    } finally {
      fx.cleanup();
    }
  });
});
