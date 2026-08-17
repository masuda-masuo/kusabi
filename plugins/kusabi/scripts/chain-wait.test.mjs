import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { writeJson } from "./state-paths.mjs";
import {
  waitForChain,
  readChainSnapshot,
  listChainIds,
  chainDirCreatedAt,
  looksLikeChainProcess,
  probeChainProcess,
  formatWaitDigest,
  describeSnapshot,
  ChainWaitError,
  TERMINAL_CHAIN_STATUSES,
  TERMINAL_DISPOSITIONS,
} from "./chain-wait.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");
const CHAIN_WAIT_SCRIPT = path.join(import.meta.dirname, "chain-wait.mjs");

function makeChainsDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-chain-wait-"));
  const chainsDir = path.join(tmp, "chains");
  fs.mkdirSync(chainsDir, { recursive: true });
  return { tmp, chainsDir };
}

function makeChainDir(chainsDir, chainId) {
  const dir = path.join(chainsDir, chainId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Deterministic creation stamps for the same-stamp tests (kusabi #309): real
// directory birthtimes carry sub-millisecond float precision, so two dirs
// "born in the same millisecond" cannot be manufactured reliably from the
// filesystem — an attempt that re-created dirs until the stamps matched was
// flaky by construction.  The waits under test inject this reader instead,
// through the same DI seam as `sleep` / `now`.
function stampedCreatedAt(stamps) {
  return (chainsDir, chainId) =>
    (Object.hasOwn(stamps, chainId) ? stamps[chainId] : chainDirCreatedAt(chainsDir, chainId));
}

function writeControl(chainDir, control) {
  writeJson(path.join(chainDir, "control.json"), control);
}

function writeChainJson(chainDir, chainJson) {
  writeJson(path.join(chainDir, "chain.json"), chainJson);
}

/** A control record for a chain the driver thinks is still running. */
function runningControl(chainId, { pid = 4242, round = 1 } = {}) {
  return { chainId, container: "cid-1", pid, status: "running", round, startedAt: "2026-08-16T00:00:00.000Z" };
}

/** A clock that advances a fixed amount on every read — lets a test drive
 * the timeouts without sleeping for them. */
function steppingClock(stepMs, start = 1_000_000) {
  let t = start;
  return () => {
    const value = t;
    t += stepMs;
    return value;
  };
}

// The seams every test fakes: nothing here may touch a real process or a
// real timer.
const NEVER_SLEEP = async () => { throw new Error("sleep must not be called"); };
const ALIVE = () => "alive";
const GONE = () => "gone";

// ---------------------------------------------------------------------------
// looksLikeChainProcess
// ---------------------------------------------------------------------------

describe("looksLikeChainProcess", () => {
  it("matches a `chain` process", () => {
    assert.equal(
      looksLikeChainProcess(["node", "/plugins/kusabi/scripts/kusabi-companion.mjs", "chain", "--container", "cid"]),
      true,
    );
  });

  it("matches a `chain-resume` process too (the pgrep pattern that did not)", () => {
    assert.equal(
      looksLikeChainProcess(["node", "/plugins/kusabi/scripts/kusabi-companion.mjs", "chain-resume", "chain-abc"]),
      true,
    );
  });

  it("refuses a recycled pid now owned by an unrelated process", () => {
    assert.equal(looksLikeChainProcess(["/usr/bin/python3", "-m", "http.server"]), false);
  });

  it("refuses a companion process that is not a chain", () => {
    assert.equal(looksLikeChainProcess(["node", "/scripts/kusabi-companion.mjs", "status"]), false);
  });

  it("refuses an empty command line (exited / zombie)", () => {
    assert.equal(looksLikeChainProcess([]), false);
    assert.equal(looksLikeChainProcess(undefined), false);
  });
});

// ---------------------------------------------------------------------------
// readChainSnapshot
// ---------------------------------------------------------------------------

describe("readChainSnapshot", () => {
  let tmp;
  let chainsDir;

  beforeEach(() => {
    ({ tmp, chainsDir } = makeChainsDir());
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reports a missing chain as absent, never as terminal", () => {
    const snapshot = readChainSnapshot(chainsDir, "chain-nope");
    assert.equal(snapshot.exists, false);
    assert.equal(snapshot.terminal, false);
    assert.equal(snapshot.status, "unknown");
  });

  it("reads a running chain: not terminal, pid carried through", () => {
    const dir = makeChainDir(chainsDir, "chain-run");
    writeControl(dir, runningControl("chain-run"));
    const snapshot = readChainSnapshot(chainsDir, "chain-run");
    assert.equal(snapshot.terminal, false);
    assert.equal(snapshot.status, "running");
    assert.equal(snapshot.pid, 4242);
  });

  it("reads a finished chain: terminal, with disposition and round count", () => {
    const dir = makeChainDir(chainsDir, "chain-done");
    writeControl(dir, { ...runningControl("chain-done"), status: "completed", round: 2 });
    writeChainJson(dir, {
      chainId: "chain-done",
      records: [{ round: 1, disposition: { disposition: "rework" } }, { round: 2, disposition: { disposition: "accept" } }],
    });
    const snapshot = readChainSnapshot(chainsDir, "chain-done");
    assert.equal(snapshot.terminal, true);
    assert.equal(snapshot.status, "completed");
    assert.equal(snapshot.disposition, "accept");
    assert.equal(snapshot.rounds, 2);
  });

  it("treats a cancelled and a failed chain as terminal (the wait judges no disposition)", () => {
    for (const status of ["cancelled", "failed"]) {
      const dir = makeChainDir(chainsDir, `chain-${status}`);
      writeControl(dir, { ...runningControl(`chain-${status}`), status });
      assert.equal(readChainSnapshot(chainsDir, `chain-${status}`).terminal, true, status);
    }
  });

  it("is terminal on a terminal disposition written before control.json is finalised", () => {
    // persistChainState writes chain.json, THEN finalizeChainControl runs.
    const dir = makeChainDir(chainsDir, "chain-window");
    writeControl(dir, runningControl("chain-window"));
    writeChainJson(dir, { chainId: "chain-window", records: [{ round: 1, disposition: { disposition: "escalate" } }] });
    assert.equal(readChainSnapshot(chainsDir, "chain-window").terminal, true);
  });

  it("is not terminal on a resumed chain still carrying the previous round's disposition (#286)", () => {
    // chain-resume rearms control.json (status back to `running`, resumedAt
    // stamped) while chain.json still holds the round that escalated.
    const dir = makeChainDir(chainsDir, "chain-resumed");
    writeControl(dir, { ...runningControl("chain-resumed"), resumedAt: "2026-08-16T01:00:00.000Z" });
    writeChainJson(dir, { chainId: "chain-resumed", records: [{ round: 1, disposition: { disposition: "escalate" } }] });
    assert.equal(readChainSnapshot(chainsDir, "chain-resumed").terminal, false);
  });

  it("is terminal on a resumed chain once its status is terminal again", () => {
    const dir = makeChainDir(chainsDir, "chain-resumed-done");
    writeControl(dir, {
      ...runningControl("chain-resumed-done"), status: "completed", resumedAt: "2026-08-16T01:00:00.000Z",
    });
    writeChainJson(dir, {
      chainId: "chain-resumed-done",
      records: [{ round: 1, disposition: { disposition: "escalate" } }],
    });
    assert.equal(readChainSnapshot(chainsDir, "chain-resumed-done").terminal, true);
  });

  it("is terminal on a terminal status whatever the disposition and resumedAt say", () => {
    for (const disposition of ["rework", "escalate", null]) {
      const chainId = `chain-status-wins-${disposition ?? "none"}`;
      const dir = makeChainDir(chainsDir, chainId);
      writeControl(dir, { ...runningControl(chainId), status: "failed", resumedAt: "2026-08-16T01:00:00.000Z" });
      if (disposition) writeChainJson(dir, { chainId, records: [{ round: 1, disposition: { disposition } }] });
      assert.equal(readChainSnapshot(chainsDir, chainId).terminal, true, String(disposition));
    }
  });

  it("is terminal on a terminal disposition with no control record at all (crash recovery)", () => {
    const dir = makeChainDir(chainsDir, "chain-crashed");
    writeChainJson(dir, { chainId: "chain-crashed", records: [{ round: 1, disposition: { disposition: "accept" } }] });
    const snapshot = readChainSnapshot(chainsDir, "chain-crashed");
    assert.equal(snapshot.status, "unknown");
    assert.equal(snapshot.terminal, true);
  });

  it("is not terminal on a rework disposition (another round is coming)", () => {
    const dir = makeChainDir(chainsDir, "chain-rework");
    writeControl(dir, runningControl("chain-rework"));
    writeChainJson(dir, { chainId: "chain-rework", records: [{ round: 1, disposition: { disposition: "rework" } }] });
    assert.equal(readChainSnapshot(chainsDir, "chain-rework").terminal, false);
  });

  it("changes its fingerprint when a round lands", () => {
    const dir = makeChainDir(chainsDir, "chain-move");
    writeControl(dir, runningControl("chain-move"));
    writeChainJson(dir, { chainId: "chain-move", records: [{ round: 1 }] });
    const before = readChainSnapshot(chainsDir, "chain-move").fingerprint;
    writeChainJson(dir, { chainId: "chain-move", records: [{ round: 1 }, { round: 2 }] });
    assert.notEqual(readChainSnapshot(chainsDir, "chain-move").fingerprint, before);
  });

  it("names the state root it read in the snapshot", () => {
    makeChainDir(chainsDir, "chain-x");
    assert.equal(readChainSnapshot(chainsDir, "chain-x").chainDir, path.join(chainsDir, "chain-x"));
  });
});

describe("listChainIds", () => {
  it("returns nothing for a missing chains directory", () => {
    assert.deepEqual(listChainIds("/definitely/not/here/chains"), []);
  });
});

// ---------------------------------------------------------------------------
// waitForChain — terminal states
// ---------------------------------------------------------------------------

describe("waitForChain on a terminal chain", () => {
  let tmp;
  let chainsDir;

  beforeEach(() => {
    ({ tmp, chainsDir } = makeChainsDir());
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns immediately, without sleeping, and digests the outcome", async () => {
    const dir = makeChainDir(chainsDir, "chain-fin");
    writeControl(dir, { ...runningControl("chain-fin"), status: "completed", round: 1 });
    writeChainJson(dir, { chainId: "chain-fin", records: [{ round: 1, disposition: { disposition: "accept" } }] });

    const result = await waitForChain({
      chainsDir, chainId: "chain-fin", sleep: NEVER_SLEEP, probeProcess: ALIVE,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.disposition, "accept");
    assert.match(result.digest, /^chain chain-fin: status=completed disposition=accept rounds=1 waited=\d+s$/);
  });

  it("returns 0-equivalent for an escalated chain too — the disposition is the caller's to judge", async () => {
    const dir = makeChainDir(chainsDir, "chain-esc");
    writeControl(dir, { ...runningControl("chain-esc"), status: "completed", round: 3 });
    writeChainJson(dir, {
      chainId: "chain-esc",
      records: [{ round: 3, disposition: { disposition: "escalate", reason: "max rounds" } }],
    });

    const result = await waitForChain({
      chainsDir, chainId: "chain-esc", sleep: NEVER_SLEEP, probeProcess: ALIVE,
    });
    assert.match(result.digest, /status=completed disposition=escalate rounds=1/);
  });
});

// ---------------------------------------------------------------------------
// waitForChain — a running chain that finishes
// ---------------------------------------------------------------------------

describe("waitForChain on a running chain", () => {
  let tmp;
  let chainsDir;

  beforeEach(() => {
    ({ tmp, chainsDir } = makeChainsDir());
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns once the state transitions to terminal", async () => {
    const dir = makeChainDir(chainsDir, "chain-live");
    writeControl(dir, runningControl("chain-live"));
    writeChainJson(dir, { chainId: "chain-live", records: [{ round: 1, disposition: { disposition: "rework" } }] });

    let sleeps = 0;
    const sleep = async () => {
      sleeps += 1;
      if (sleeps === 1) {
        // round 2 lands, chain still running
        writeChainJson(dir, {
          chainId: "chain-live",
          records: [{ round: 1, disposition: { disposition: "rework" } }, { round: 2 }],
        });
      }
      if (sleeps === 3) {
        writeChainJson(dir, {
          chainId: "chain-live",
          records: [
            { round: 1, disposition: { disposition: "rework" } },
            { round: 2, disposition: { disposition: "accept" } },
          ],
        });
        writeControl(dir, { ...runningControl("chain-live", { round: 2 }), status: "completed" });
      }
    };

    const result = await waitForChain({
      chainsDir, chainId: "chain-live", sleep, probeProcess: ALIVE, pollIntervalMs: 1,
    });

    assert.equal(sleeps, 3);
    assert.equal(result.status, "completed");
    assert.match(result.digest, /status=completed disposition=accept rounds=2/);
  });

  it("keeps waiting on a resumed chain until the resumed round decides it (#286)", async () => {
    // Live symptom: `status=running disposition=escalate rounds=1 waited=0s`,
    // exit 0, the instant the wait started.
    const dir = makeChainDir(chainsDir, "chain-resumed-wait");
    writeControl(dir, { ...runningControl("chain-resumed-wait"), resumedAt: "2026-08-16T01:00:00.000Z" });
    writeChainJson(dir, {
      chainId: "chain-resumed-wait",
      records: [{ round: 1, disposition: { disposition: "escalate" } }],
    });

    let sleeps = 0;
    const sleep = async () => {
      sleeps += 1;
      if (sleeps === 2) {
        writeChainJson(dir, {
          chainId: "chain-resumed-wait",
          records: [
            { round: 1, disposition: { disposition: "escalate" } },
            { round: 2, disposition: { disposition: "accept" } },
          ],
        });
        writeControl(dir, {
          ...runningControl("chain-resumed-wait", { round: 2 }),
          status: "completed",
          resumedAt: "2026-08-16T01:00:00.000Z",
        });
      }
    };

    const result = await waitForChain({
      chainsDir, chainId: "chain-resumed-wait", sleep, probeProcess: ALIVE, pollIntervalMs: 1,
    });

    assert.equal(sleeps, 2);
    assert.equal(result.status, "completed");
    assert.match(result.digest, /status=completed disposition=accept rounds=2/);
  });

  it("keeps waiting while liveness is unverifiable rather than calling it dead", async () => {
    // No /proc, hidepid, no `ps`: a live chain must not be reported stalled.
    const dir = makeChainDir(chainsDir, "chain-blind");
    writeControl(dir, runningControl("chain-blind"));

    let sleeps = 0;
    const sleep = async () => {
      sleeps += 1;
      if (sleeps === 2) writeControl(dir, { ...runningControl("chain-blind"), status: "completed" });
    };

    const result = await waitForChain({
      chainsDir, chainId: "chain-blind", sleep, probeProcess: () => "unverifiable", pollIntervalMs: 1,
    });
    assert.equal(result.status, "completed");
    assert.equal(sleeps, 2);
  });
});

// ---------------------------------------------------------------------------
// waitForChain — unknown chain id
// ---------------------------------------------------------------------------

describe("waitForChain on an unknown chain id", () => {
  let tmp;
  let chainsDir;

  beforeEach(() => {
    ({ tmp, chainsDir } = makeChainsDir());
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("fails immediately, naming the id and the state root it searched", async () => {
    await assert.rejects(
      () => waitForChain({ chainsDir, chainId: "chain-ghost", sleep: NEVER_SLEEP, probeProcess: ALIVE }),
      (err) => {
        assert.ok(err instanceof ChainWaitError);
        assert.equal(err.code, "unknown-chain");
        assert.match(err.message, /chain-ghost/);
        assert.ok(err.message.includes(chainsDir), err.message);
        return true;
      },
    );
  });

  it("refuses a wait with no chain id and no --next", async () => {
    await assert.rejects(
      () => waitForChain({ chainsDir, sleep: NEVER_SLEEP, probeProcess: ALIVE }),
      (err) => err.code === "usage",
    );
  });
});

// ---------------------------------------------------------------------------
// waitForChain — appear mode (--next)
// ---------------------------------------------------------------------------

describe("waitForChain --next", () => {
  let tmp;
  let chainsDir;

  beforeEach(() => {
    ({ tmp, chainsDir } = makeChainsDir());
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("fails within its bound when no chain materialises, in words no digest could be mistaken for", async () => {
    // The instant-death dispatch (a chain-resume with no chain id): nothing is
    // ever created, and a process watcher would read that as "finished".
    await assert.rejects(
      () => waitForChain({
        chainsDir, next: true, appearTimeoutMs: 30_000, pollIntervalMs: 1,
        sleep: async () => {}, probeProcess: ALIVE, now: steppingClock(10_000),
      }),
      (err) => {
        assert.equal(err.code, "no-chain-appeared");
        assert.match(err.message, /no chain appeared within 30s/);
        assert.ok(err.message.includes(chainsDir), err.message);
        // Distinguishable from a terminal result at a glance and by grep.
        assert.doesNotMatch(err.message, /status=/);
        return true;
      },
    );
  });

  it("ignores chains that already existed and waits on the one that appears", async () => {
    makeChainDir(chainsDir, "chain-old");
    writeControl(path.join(chainsDir, "chain-old"), { ...runningControl("chain-old"), status: "completed" });

    let sleeps = 0;
    const sleep = async () => {
      sleeps += 1;
      if (sleeps === 1) {
        const dir = makeChainDir(chainsDir, "chain-new");
        writeControl(dir, runningControl("chain-new"));
      }
      if (sleeps === 2) {
        writeControl(path.join(chainsDir, "chain-new"), { ...runningControl("chain-new"), status: "completed" });
      }
    };

    const result = await waitForChain({
      chainsDir, next: true, sleep, probeProcess: ALIVE, pollIntervalMs: 1, appearTimeoutMs: 60_000,
    });

    assert.equal(result.chainId, "chain-new");
    assert.match(result.digest, /^chain chain-new: status=completed/);
  });

  it("waits on the chain the dispatch created just before the wait started", async () => {
    // The recommended recipe is dispatch, THEN wait, so the chain directory
    // routinely exists before the wait's first poll.  A baseline of "the ids
    // present at start" made that healthy chain permanently invisible and the
    // wait reported the live dispatch as one that died before starting.
    const dir = makeChainDir(chainsDir, "chain-dispatched");
    writeControl(dir, runningControl("chain-dispatched"));

    let sleeps = 0;
    const sleep = async () => {
      sleeps += 1;
      writeChainJson(dir, {
        chainId: "chain-dispatched",
        records: [{ round: 1, disposition: { disposition: "accept" } }],
      });
      writeControl(dir, { ...runningControl("chain-dispatched"), status: "completed" });
    };

    const result = await waitForChain({
      chainsDir, next: true, sleep, probeProcess: ALIVE, pollIntervalMs: 1,
      appearTimeoutMs: 60_000, now: steppingClock(5_000),
    });

    assert.equal(result.chainId, "chain-dispatched");
    assert.match(result.digest, /^chain chain-dispatched: status=completed disposition=accept rounds=1/);
    assert.equal(sleeps, 1);
  });

  it("passes over the finished chains already there and waits on the unfinished one", async () => {
    const finished = makeChainDir(chainsDir, "chain-earlier");
    writeControl(finished, { ...runningControl("chain-earlier"), status: "completed" });
    const going = makeChainDir(chainsDir, "chain-going");
    writeControl(going, runningControl("chain-going"));

    const sleep = async () => {
      writeControl(going, { ...runningControl("chain-going"), status: "failed" });
    };

    const result = await waitForChain({
      chainsDir, next: true, sleep, probeProcess: ALIVE, pollIntervalMs: 1,
      appearTimeoutMs: 60_000, now: steppingClock(5_000),
    });
    assert.equal(result.chainId, "chain-going");
  });

  it("never resolves on a chain that had already reached a terminal state", async () => {
    // Otherwise a wait would "complete" instantly on last week's chain and
    // report its disposition as this dispatch's.
    const dir = makeChainDir(chainsDir, "chain-lastweek");
    writeControl(dir, { ...runningControl("chain-lastweek"), status: "completed", round: 1 });
    writeChainJson(dir, {
      chainId: "chain-lastweek",
      records: [{ round: 1, disposition: { disposition: "accept" } }],
    });

    await assert.rejects(
      () => waitForChain({
        chainsDir, next: true, appearTimeoutMs: 30_000, pollIntervalMs: 1,
        sleep: async () => {}, probeProcess: ALIVE, now: steppingClock(10_000),
      }),
      (err) => {
        assert.equal(err.code, "no-chain-appeared");
        assert.doesNotMatch(err.message, /chain-lastweek/);
        return true;
      },
    );
  });

  it("says what it looked for, and names the precise tools for a busy workspace", async () => {
    await assert.rejects(
      () => waitForChain({
        chainsDir, next: true, appearTimeoutMs: 10_000, pollIntervalMs: 1,
        sleep: async () => {}, probeProcess: ALIVE, now: steppingClock(4_000),
      }),
      (err) => {
        assert.match(err.message, /new since this wait started, or already present and not yet terminal/);
        assert.match(err.message, /--since/);
        assert.match(err.message, /name the chain id/);
        return true;
      },
    );
  });

  it("with an explicit --since stamp, an already-created chain still counts", async () => {
    const dir = makeChainDir(chainsDir, "chain-stamped");
    writeControl(dir, { ...runningControl("chain-stamped"), status: "completed" });

    const result = await waitForChain({
      chainsDir, next: true, since: Date.now() - 60_000,
      sleep: NEVER_SLEEP, probeProcess: ALIVE, pollIntervalMs: 1,
    });
    assert.equal(result.chainId, "chain-stamped");
  });

  it("with a --since stamp in the future, that same chain does not count", async () => {
    const dir = makeChainDir(chainsDir, "chain-stamped");
    writeControl(dir, { ...runningControl("chain-stamped"), status: "completed" });

    await assert.rejects(
      () => waitForChain({
        chainsDir, next: true, since: Date.now() + 600_000, appearTimeoutMs: 5_000, pollIntervalMs: 1,
        sleep: async () => {}, probeProcess: ALIVE, now: steppingClock(2_500),
      }),
      (err) => err.code === "no-chain-appeared",
    );
  });
});

// ---------------------------------------------------------------------------
// waitForChain --next — dead-dispatch debris (kusabi #298)
// ---------------------------------------------------------------------------

describe("waitForChain --next debris exclusion (kusabi #298)", () => {
  let tmp;
  let chainsDir;

  beforeEach(() => {
    ({ tmp, chainsDir } = makeChainsDir());
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // A clock far ahead of real time: every directory the test creates at real
  // "now" is OLDER than the appear window, which is what a debris dir left by
  // a dispatch killed before it wrote anything looks like to a later wait.
  const FUTURE_CLOCK = () => steppingClock(5_000, Date.now() + 1_000_000_000);

  it("skips a recordless dir older than the appear window and waits on the chain that appears after the first scan", async () => {
    // The incident shape (2026-08-16): a WSL shutdown killed a dispatch
    // mid-flight, leaving an empty chain dir; a later bare `--next` locked
    // onto it and stalled while the real chain ran.
    makeChainDir(chainsDir, "chain-debris");

    const ignored = [];
    let sleeps = 0;
    const sleep = async () => {
      sleeps += 1;
      if (sleeps === 1) {
        const dir = makeChainDir(chainsDir, "chain-real");
        writeControl(dir, runningControl("chain-real"));
      }
      if (sleeps === 2) {
        writeControl(path.join(chainsDir, "chain-real"), { ...runningControl("chain-real"), status: "completed" });
      }
    };

    const result = await waitForChain({
      chainsDir, next: true, sleep, probeProcess: ALIVE, pollIntervalMs: 1,
      appearTimeoutMs: 60_000, now: FUTURE_CLOCK(), reportIgnored: (id) => ignored.push(id),
    });

    assert.equal(result.chainId, "chain-real");
    assert.match(result.digest, /^chain chain-real: status=completed/);
    // One stderr line per skipped dir — not one per poll.
    assert.deepEqual(ignored, ["chain-debris"]);
  });

  it("keeps a recordless dir created within the appear window eligible", async () => {
    // A just-dispatched chain has a directory before it has a control record:
    // that is the normal startup shape and must never be skipped.
    const dir = makeChainDir(chainsDir, "chain-starting");

    const ignored = [];
    let sleeps = 0;
    const sleep = async () => {
      sleeps += 1;
      if (sleeps === 1) writeControl(dir, runningControl("chain-starting"));
      if (sleeps === 2) writeControl(dir, { ...runningControl("chain-starting"), status: "completed" });
    };

    const result = await waitForChain({
      chainsDir, next: true, sleep, probeProcess: ALIVE, pollIntervalMs: 1,
      appearTimeoutMs: 60_000, now: steppingClock(5_000), reportIgnored: (id) => ignored.push(id),
    });

    assert.equal(result.chainId, "chain-starting");
    assert.deepEqual(ignored, []);
  });

  it("switches to a newer chain that appears while the selected chain is still recordless", async () => {
    // The wait locked onto the empty dir of a dispatch that never wrote a
    // record; the real chain's dir appears afterwards.  The wait must resolve
    // by the newer chain's terminal state, not stall on the empty one.
    makeChainDir(chainsDir, "chain-empty");

    let sleeps = 0;
    const sleep = async () => {
      sleeps += 1;
      if (sleeps === 1) {
        // A real pause so the filesystem reports a strictly later birthtime
        // for the newer dir (dirs created in the same millisecond tie).
        await new Promise((resolve) => setTimeout(resolve, 10));
        const dir = makeChainDir(chainsDir, "chain-later");
        writeControl(dir, runningControl("chain-later"));
      }
      if (sleeps === 2) {
        writeControl(path.join(chainsDir, "chain-later"), { ...runningControl("chain-later"), status: "completed" });
      }
    };

    const result = await waitForChain({
      chainsDir, next: true, sleep, probeProcess: ALIVE, pollIntervalMs: 1,
      appearTimeoutMs: 60_000, now: steppingClock(5_000),
    });

    assert.equal(result.chainId, "chain-later");
    assert.match(result.digest, /^chain chain-later: status=completed/);
  });

  it("still stalls on a recordless dir when no newer chain ever appears", async () => {
    // The bound must survive the rescue: a recordless dir that is the newest
    // eligible chain cannot be traded away, so the wait still fails bounded.
    makeChainDir(chainsDir, "chain-only-empty");

    await assert.rejects(
      () => waitForChain({
        chainsDir, next: true, sleep: async () => {}, probeProcess: ALIVE,
        pollIntervalMs: 1, appearTimeoutMs: 10_000, now: steppingClock(4_000),
      }),
      (err) => {
        assert.equal(err.code, "stalled");
        assert.match(err.message, /no control record/);
        return true;
      },
    );
  });

  it("names the skipped debris dir on stderr by default", async () => {
    makeChainDir(chainsDir, "chain-junk");

    const lines = [];
    const orig = console.error;
    console.error = (...args) => { lines.push(args.join(" ")); };
    try {
      await assert.rejects(
        () => waitForChain({
          chainsDir, next: true, sleep: async () => {}, probeProcess: ALIVE,
          pollIntervalMs: 1, appearTimeoutMs: 10_000, now: FUTURE_CLOCK(),
        }),
        (err) => err.code === "no-chain-appeared",
      );
    } finally {
      console.error = orig;
    }

    assert.deepEqual(lines, ["ignoring chain-junk: no control record, older than appear window"]);
  });

  it("still selects an old recordless dir with an explicit --since stamp", async () => {
    // The precise tool is unchanged: with --since the caller has said which
    // chain this wait is for, so the debris exclusion does not apply.
    const dir = makeChainDir(chainsDir, "chain-stamped-empty");

    const ignored = [];
    let sleeps = 0;
    const sleep = async () => {
      sleeps += 1;
      if (sleeps === 1) writeControl(dir, runningControl("chain-stamped-empty"));
      if (sleeps === 2) {
        writeControl(dir, { ...runningControl("chain-stamped-empty"), status: "completed" });
      }
    };

    const result = await waitForChain({
      chainsDir, next: true, since: Date.now() - 60_000, sleep, probeProcess: ALIVE,
      pollIntervalMs: 1, appearTimeoutMs: 60_000, now: FUTURE_CLOCK(),
      reportIgnored: (id) => ignored.push(id),
    });

    assert.equal(result.chainId, "chain-stamped-empty");
    assert.deepEqual(ignored, []);
  });
});

// ---------------------------------------------------------------------------
// waitForChain --next — same-stamp re-selection (kusabi #309)
// ---------------------------------------------------------------------------

describe("waitForChain --next same-stamp re-selection (kusabi #309)", () => {
  let tmp;
  let chainsDir;

  beforeEach(() => {
    ({ tmp, chainsDir } = makeChainsDir());
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("switches to a chain born in the SAME millisecond as the locked empty dir and resolves on it", async () => {
    // #298's rescue compared creation stamps with a strict `>`, so a real
    // chain whose directory landed in the same millisecond as the dead
    // dispatch's empty dir was unreachable and the wait stalled on the empty
    // dir.  The `>=` tie-break must make that same-stamp chain reachable.
    makeChainDir(chainsDir, "chain-same-locked");
    // Stamps sit AT the fake clock's start (steppingClock begins at
    // 1_000_000): a preexisting recordless dir must be inside the appear
    // window, or the debris exclusion removes it before the switch under
    // test ever runs and the test passes vacuously.
    const createdAt = stampedCreatedAt({ "chain-same-locked": 1_000_000, "chain-same-real": 1_000_000 });

    let sleeps = 0;
    const sleep = async () => {
      sleeps += 1;
      if (sleeps === 1) {
        const dir = makeChainDir(chainsDir, "chain-same-real");
        writeControl(dir, runningControl("chain-same-real"));
      }
      if (sleeps === 2) {
        writeControl(path.join(chainsDir, "chain-same-real"), { ...runningControl("chain-same-real"), status: "completed" });
      }
    };

    const result = await waitForChain({
      chainsDir, next: true, sleep, probeProcess: ALIVE, pollIntervalMs: 1,
      appearTimeoutMs: 60_000, now: steppingClock(5_000), createdAt,
    });

    assert.equal(result.chainId, "chain-same-real");
    assert.match(result.digest, /^chain chain-same-real: status=completed/);
    assert.equal(sleeps, 2);
  });

  it("does not bounce between two recordless same-stamp dirs — it stalls naming one of them", async () => {
    // With a naive `>=` the wait would switch to the same-stamp sibling and
    // back on every poll, forever — each switch is a `continue` that skips
    // the sleep, so it never even reaches the appear timeout.  The abandoned
    // set bounds the wait to one hold per directory: it switches once, then
    // stalls on the dir it holds, naming exactly one of the two.
    makeChainDir(chainsDir, "chain-same-a");
    const createdAt = stampedCreatedAt({ "chain-same-a": 1_000_000, "chain-same-b": 1_000_000 });

    let sleeps = 0;
    const sleep = async () => {
      sleeps += 1;
      if (sleeps === 1) {
        makeChainDir(chainsDir, "chain-same-b");
      }
    };

    await assert.rejects(
      () => waitForChain({
        chainsDir, next: true, sleep, probeProcess: ALIVE, pollIntervalMs: 1,
        appearTimeoutMs: 10_000, now: steppingClock(4_000), createdAt,
      }),
      (err) => {
        assert.equal(err.code, "stalled");
        assert.match(err.message, /no control record/);
        // The stall names ONE of the two — and never both.
        assert.match(err.message, /chain chain-same-[ab] stalled/);
        return true;
      },
    );
    // Bounded polls, not an endless switch loop: an oscillating wait never
    // sleeps at all, so this is what the timeout guard below would otherwise
    // have to catch.
    assert.ok(sleeps <= 3, `expected a bounded wait, saw ${sleeps} sleeps`);
  }, { timeout: 15_000 });

  it("never revisits a dir it switched away from, even after that dir gains a control record", async () => {
    // The wait traded the recordless dir away; that dir then writes a control
    // record.  The wait must not be pulled back — without the abandoned set
    // the same-stamp sibling stays eligible, the wait would bounce back and
    // end up on the wrong chain.  It stays on the dir it switched to instead,
    // and stalls there.
    const locked = makeChainDir(chainsDir, "chain-abandoned-a");
    const createdAt = stampedCreatedAt({ "chain-abandoned-a": 1_000_000, "chain-abandoned-b": 1_000_000 });

    let sleeps = 0;
    const sleep = async () => {
      sleeps += 1;
      if (sleeps === 1) {
        makeChainDir(chainsDir, "chain-abandoned-b");
      }
      if (sleeps === 2) {
        // The abandoned dir is no longer recordless — it must STILL not be
        // re-selected.
        writeControl(locked, runningControl("chain-abandoned-a"));
      }
    };

    await assert.rejects(
      () => waitForChain({
        chainsDir, next: true, sleep, probeProcess: ALIVE, pollIntervalMs: 1,
        appearTimeoutMs: 40_000, now: steppingClock(4_000), createdAt,
      }),
      (err) => {
        assert.equal(err.code, "stalled");
        assert.match(err.message, /no control record/);
        // The stall names the dir the wait switched TO — never the abandoned
        // one it must not return to.
        assert.match(err.message, /chain chain-abandoned-b stalled/);
        assert.doesNotMatch(err.message, /chain-abandoned-a/);
        return true;
      },
    );
  }, { timeout: 15_000 });
});

// ---------------------------------------------------------------------------
// waitForChain — stall detection
// ---------------------------------------------------------------------------

describe("waitForChain stall detection", () => {
  let tmp;
  let chainsDir;

  beforeEach(() => {
    ({ tmp, chainsDir } = makeChainsDir());
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("gives up when the recorded process is gone and the state cannot advance", async () => {
    // chain.json is written at round boundaries only: a chain that died
    // mid-round leaves this state behind forever.
    const dir = makeChainDir(chainsDir, "chain-dead");
    writeControl(dir, runningControl("chain-dead", { pid: 4242, round: 1 }));
    writeChainJson(dir, { chainId: "chain-dead", records: [{ round: 1, disposition: { disposition: "rework" } }] });

    await assert.rejects(
      () => waitForChain({
        chainsDir, chainId: "chain-dead", sleep: async () => {}, probeProcess: GONE,
        pollIntervalMs: 1, now: steppingClock(1_000),
      }),
      (err) => {
        assert.equal(err.code, "stalled");
        assert.match(err.message, /chain-dead stalled/);
        assert.match(err.message, /status=running disposition=rework rounds=1/);
        assert.match(err.message, /unchanged for \d+s/);
        assert.match(err.message, /recorded process 4242 is gone/);
        return true;
      },
    );
  });

  it("never stalls a chain that finished in the instant its process exited", async () => {
    const dir = makeChainDir(chainsDir, "chain-race");
    writeControl(dir, runningControl("chain-race"));

    const sleep = async () => {
      writeControl(dir, { ...runningControl("chain-race"), status: "completed" });
    };

    const result = await waitForChain({
      chainsDir, chainId: "chain-race", sleep, probeProcess: GONE, pollIntervalMs: 1,
    });
    assert.equal(result.status, "completed");
  });

  it("gives up on a live-but-stuck chain once the progress timeout passes", async () => {
    const dir = makeChainDir(chainsDir, "chain-stuck");
    writeControl(dir, runningControl("chain-stuck"));

    await assert.rejects(
      () => waitForChain({
        chainsDir, chainId: "chain-stuck", sleep: async () => {}, probeProcess: ALIVE,
        pollIntervalMs: 1, progressTimeoutMs: 60_000, now: steppingClock(20_000),
      }),
      (err) => {
        assert.equal(err.code, "stalled");
        assert.match(err.message, /no progress for 60s/);
        assert.match(err.message, /status=running/);
        return true;
      },
    );
  });

  it("never lets an unverifiable liveness answer confirm a stall", async () => {
    // hidepid, no /proc, no `ps`: the prober cannot see the process at all.
    // The wait may still time out, but only ever as "no progress" — "the
    // recorded process is gone" is a claim this host is in no position to make.
    const dir = makeChainDir(chainsDir, "chain-hidden");
    writeControl(dir, runningControl("chain-hidden", { pid: 4242 }));

    let probes = 0;
    await assert.rejects(
      () => waitForChain({
        chainsDir, chainId: "chain-hidden", sleep: async () => {},
        probeProcess: () => { probes += 1; return "unverifiable"; },
        pollIntervalMs: 1, progressTimeoutMs: 60_000, now: steppingClock(20_000),
      }),
      (err) => {
        assert.equal(err.code, "stalled");
        assert.match(err.message, /no progress for 60s/);
        assert.doesNotMatch(err.message, /is gone/);
        return true;
      },
    );
    assert.ok(probes > 0, "the prober must have been consulted at all");
  });

  it("bounds a chain directory that never got a control record", async () => {
    // `chain` creates the directory before it validates --container, so an
    // instant death can leave one with nothing in it and no pid to probe.
    makeChainDir(chainsDir, "chain-empty");

    await assert.rejects(
      () => waitForChain({
        chainsDir, chainId: "chain-empty", sleep: async () => {}, probeProcess: ALIVE,
        pollIntervalMs: 1, appearTimeoutMs: 10_000, now: steppingClock(4_000),
      }),
      (err) => {
        assert.equal(err.code, "stalled");
        assert.match(err.message, /no control record/);
        assert.ok(err.message.includes(path.join(chainsDir, "chain-empty")), err.message);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Liveness is decided by command line, never by a bare signal probe
// ---------------------------------------------------------------------------

describe("chain-wait liveness implementation", () => {
  // Comments are stripped: the module DISCUSSES kill(pid, 0) at length, and
  // what is pinned here is that it never calls it.
  const code = fs.readFileSync(CHAIN_WAIT_SCRIPT, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");

  it("never signals a pid to decide liveness", () => {
    assert.equal([...code.matchAll(/process\.kill\s*\(/g)].length, 0);
    assert.doesNotMatch(code, /kill\(\s*pid\s*,\s*0\s*\)/);
    assert.doesNotMatch(code, /isPidAlive/);
  });

  it("reads the command line instead", () => {
    assert.match(code, /\/proc\/\$\{pid\}\/cmdline/);
    assert.match(code, /"ps", \["-o", "args=", "-p"/);
  });

  // The real prober, against real pids — the faked seam above never runs it.
  it("says `unverifiable` when there is no pid to read", () => {
    assert.equal(probeChainProcess(null), "unverifiable");
    assert.equal(probeChainProcess(0), "unverifiable");
  });

  it("says `gone` for a pid that cannot exist", () => {
    assert.equal(probeChainProcess(2 ** 30), "gone");
  });

  // The two reads, injected: no machine can be made to show the pair a hidepid
  // mount produces (the /proc read denied AND `ps` exiting non-zero for a live
  // process), and a host with no `ps` at all would hide the bug rather than
  // reproduce it.
  const throwing = (code) => () => { throw Object.assign(new Error(code), { code }); };
  /** `ps` for a pid it cannot see: no output, exit 1 — the same answer it gives
   * for a pid that truly does not exist. */
  const psSeesNothing = () => { throw Object.assign(new Error("ps"), { status: 1 }); };

  it("says `unverifiable` when process info is denied, and does not ask `ps` to break the tie", () => {
    // A hidepid=1 mount denies the read for a live chain owned by another
    // user and blinds `ps` in the same breath — so `ps` saying "not in my
    // table" here is not evidence of death, and taking it as such confirms a
    // stall against a chain that is working fine.
    for (const code of ["EACCES", "EPERM"]) {
      let psCalls = 0;
      const answer = probeChainProcess(4242, {
        readArgv: throwing(code),
        readPs: () => { psCalls += 1; return psSeesNothing(); },
      });
      assert.equal(answer, "unverifiable", code);
      assert.equal(psCalls, 0, `${code} must not be handed to ps`);
    }
  });

  it("says `unverifiable` for any other unreadable process entry", () => {
    assert.equal(
      probeChainProcess(4242, { readArgv: throwing("EIO"), readPs: psSeesNothing }),
      "unverifiable",
    );
    assert.equal(
      probeChainProcess(4242, {
        readArgv: () => { throw new Error("no errno at all"); },
        readPs: psSeesNothing,
      }),
      "unverifiable",
    );
  });

  it("still says `gone` when the process info simply has no such pid", () => {
    // The fast path the wait depends on must survive the fix.
    assert.equal(
      probeChainProcess(2 ** 30, { readArgv: throwing("ENOENT"), readPs: psSeesNothing }),
      "gone",
    );
  });

  it("says `gone` for a live pid whose command line is not a chain (the recycled-pid case)", () => {
    // This very process is alive, so kill(pid, 0) would say "alive" — the
    // command line is what tells the two apart.
    assert.equal(probeChainProcess(process.pid), "gone");
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("digest and stall rendering", () => {
  it("renders one line naming chain, status, disposition and rounds", () => {
    const line = formatWaitDigest(
      { chainId: "chain-a", status: "completed", disposition: "accept", rounds: 2 },
      { waitedMs: 61_000 },
    );
    assert.equal(line, "chain chain-a: status=completed disposition=accept rounds=2 waited=61s");
    assert.equal(line.includes("\n"), false);
  });

  it("says `none` rather than undefined for a chain with no disposition yet", () => {
    assert.match(describeSnapshot({ status: "running", disposition: null, rounds: 0 }), /disposition=none/);
  });

  it("keeps the terminal vocabularies the driver actually writes", () => {
    for (const status of ["completed", "cancelled", "failed"]) {
      assert.ok(TERMINAL_CHAIN_STATUSES.has(status), status);
    }
    assert.equal(TERMINAL_CHAIN_STATUSES.has("running"), false);
    for (const disposition of ["accept", "accept-with-followup", "escalate", "max-rounds"]) {
      assert.ok(TERMINAL_DISPOSITIONS.has(disposition), disposition);
    }
    for (const disposition of ["rework", "strategize"]) {
      assert.equal(TERMINAL_DISPOSITIONS.has(disposition), false, disposition);
    }
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe("chain-wait CLI", () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-chain-wait-cli-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function workspaceChainsDir(stateRootDir, cwd) {
    const hash = crypto.createHash("sha256").update(fs.realpathSync(cwd)).digest("hex").slice(0, 12);
    return path.join(stateRootDir, hash, "chains");
  }

  function run(args, { cwd = tmp } = {}) {
    const env = { ...process.env };
    delete env.KUSABI_WORKER_CONTEXT;
    env.KUSABI_STATE_DIR = path.join(tmp, "state");
    return spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
      encoding: "utf8", cwd, env, timeout: 30_000,
    });
  }

  it("exits 0 with a digest for an already-terminal chain", () => {
    const chainsDir = workspaceChainsDir(path.join(tmp, "state"), tmp);
    const dir = path.join(chainsDir, "chain-cli");
    fs.mkdirSync(dir, { recursive: true });
    writeControl(dir, { ...runningControl("chain-cli"), status: "completed", round: 1 });
    writeChainJson(dir, { chainId: "chain-cli", records: [{ round: 1, disposition: { disposition: "accept" } }] });

    const result = run(["chain-wait", "chain-cli"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /chain chain-cli: status=completed disposition=accept rounds=1/);
  });

  it("exits non-zero on an unknown chain id, naming it and the state root", () => {
    const result = run(["chain-wait", "chain-nope"]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /unknown chain: chain-nope/);
    assert.match(result.stdout, /chains/);
  });

  it("exits non-zero when --next sees nothing appear", () => {
    const result = run(["chain-wait", "--next", "--appear-timeout", "1", "--poll-interval", "1"]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /no chain appeared within 1s/);
  });

  it("--next skips a recordless debris dir and waits on the chain that appears after the first scan (kusabi #298)", async () => {
    const chainsDir = workspaceChainsDir(path.join(tmp, "state"), tmp);
    fs.mkdirSync(path.join(chainsDir, "chain-debris"), { recursive: true });
    // The debris dir must already be OLDER than the appear window when the
    // wait's first scan runs.  birthtime cannot be backdated, so give it a
    // head start before the wait starts.
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    const env = { ...process.env };
    delete env.KUSABI_WORKER_CONTEXT;
    env.KUSABI_STATE_DIR = path.join(tmp, "state");
    const child = spawn(process.execPath, [
      COMPANION_SCRIPT, "chain-wait", "--next",
      "--appear-timeout", "4", "--poll-interval", "1",
    ], { cwd: tmp, env, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    // The dispatch's chain dir appears AFTER the wait's first scan (which
    // found only the debris) and completes within the appear window.
    await new Promise((resolve) => setTimeout(resolve, 2_600));
    const realDir = path.join(chainsDir, "chain-real");
    fs.mkdirSync(realDir, { recursive: true });
    writeControl(realDir, runningControl("chain-real"));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    writeControl(realDir, { ...runningControl("chain-real"), status: "completed" });

    const status = await new Promise((resolve) => {
      child.on("close", (code) => resolve(code));
    });
    assert.equal(status, 0, `${stdout}${stderr}`);
    assert.match(stdout, /chain chain-real: status=completed/);
    assert.match(stderr, /ignoring chain-debris: no control record, older than appear window/);
  });

  it("refuses --next together with a chain id", () => {
    const result = run(["chain-wait", "--next", "chain-cli"]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /takes no chain id/);
  });

  it("refuses a chain-wait bound on another subcommand instead of ignoring it", () => {
    const result = run(["chain-show", "--poll-interval", "5"]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /--poll-interval is only supported by chain-wait/);
  });

  it("rejects a malformed duration rather than silently using the default", () => {
    const result = run(["chain-wait", "--appear-timeout", "soon", "--next"]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /--appear-timeout expects a positive number of seconds/);
  });

  it("documents the subcommand and its flags in --help", () => {
    const result = run(["--help"]);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /^ {2}chain-wait /m);
    assert.match(result.stdout, /--next \(chain-wait/);
    assert.match(result.stdout, /--poll-interval <s> \(chain-wait/);
    assert.match(result.stdout, /--appear-timeout <s> \(chain-wait/);
    assert.match(result.stdout, /--progress-timeout <s> \(chain-wait/);
  });

  it("names chain-wait in the unknown-subcommand list", () => {
    const result = run(["definitely-not-a-subcommand"]);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /chain-show\|chain-wait\|chain-stats/);
  });
});
