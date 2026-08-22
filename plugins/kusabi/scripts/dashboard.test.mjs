// dashboard.test.mjs — synthetic state root + in-process HTTP + one CLI spawn.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  chainDetail,
  collectEnded,
  collectRunning,
  costSummary,
  listWorkspaces,
  startDashboard,
} from "./dashboard.mjs";
import { renderChainShow, resolveChainStatus } from "./render.mjs";
import { readJson } from "./state-paths.mjs";

const COMPANION = path.join(import.meta.dirname, "kusabi-companion.mjs");
const WS_A = "aaaa11111111";
const WS_B = "bbbb22222222";
const DEAD_PID = 999999999;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeChain(root, slug, chainId, {
  control,
  chain,
  rounds = [],
} = {}) {
  const chainDir = path.join(root, slug, "chains", chainId);
  fs.mkdirSync(chainDir, { recursive: true });
  if (control) writeJson(path.join(chainDir, "control.json"), control);
  if (chain) writeJson(path.join(chainDir, "chain.json"), chain);
  for (const round of rounds) {
    writeJson(path.join(chainDir, `round-${round.round}.json`), round);
  }
  return chainDir;
}

function baseControl(chainId, extra = {}) {
  return {
    chainId,
    container: "c0",
    pid: extra.pid ?? 1,
    status: extra.status ?? "completed",
    round: extra.round ?? 1,
    startedAt: extra.startedAt ?? "2026-08-22T09:00:00.000Z",
    finishedAt: extra.finishedAt,
    ...extra,
  };
}

function baseChain(chainId, extra = {}) {
  return {
    chainId,
    container: "c0",
    model: extra.model ?? "opencode/test",
    maxRounds: extra.maxRounds ?? 4,
    brief: extra.brief ?? "Brief title\n\nbody",
    orchestrator: { model: "opus", session: "s", date: "2026-08-22" },
    records: extra.records ?? [],
    chainTotals: extra.chainTotals ?? { input: 10, output: 20, cost: 0.01 },
    ...extra,
  };
}

function acceptRound(n, extra = {}) {
  return {
    round: n,
    verdict: "approve",
    probesGreen: true,
    implementJobId: extra.implementJobId,
    reviewJobId: extra.reviewJobId,
    implementRefusal: extra.implementRefusal ?? null,
    backend: "opencode",
    worktreeChanged: extra.worktreeChanged ?? true,
    reviewParseable: extra.reviewParseable ?? true,
    verdictSource: "review",
    findings: [],
    disposition: extra.disposition ?? { disposition: "accept", reason: "approved" },
    ...extra,
  };
}

function buildState(root) {
  writeJson(path.join(root, WS_A, "server.json"), {
    port: 4096,
    password: "x",
    pid: DEAD_PID,
    cwd: "/tmp/ws-a",
    startedAt: "2026-08-22T08:00:00.000Z",
  });

  writeChain(root, WS_A, "chain-run-live", {
    control: baseControl("chain-run-live", {
      status: "running",
      pid: process.pid,
      round: 1,
      finishedAt: undefined,
    }),
    chain: baseChain("chain-run-live", { records: [], maxRounds: 4, model: "opencode/live" }),
  });

  writeChain(root, WS_A, "chain-run-dead", {
    control: baseControl("chain-run-dead", {
      status: "running",
      pid: DEAD_PID,
      round: 2,
      finishedAt: undefined,
    }),
    chain: baseChain("chain-run-dead", { records: [], maxRounds: 4 }),
  });

  const acceptRound1 = acceptRound(1, {
    implementJobId: "job-accept-impl",
    disposition: { disposition: "accept", reason: "approved" },
    worktreeChanged: true,
  });
  writeChain(root, WS_A, "chain-accept", {
    control: baseControl("chain-accept", {
      status: "completed",
      finishedAt: "2026-08-22T16:00:00.000Z",
      round: 1,
    }),
    chain: baseChain("chain-accept", {
      records: [acceptRound1],
      brief: "Accept this change\n\nmore",
    }),
    rounds: [acceptRound1],
  });
  writeJson(path.join(root, WS_A, "jobs", "job-accept-impl", "job.json"), {
    id: "job-accept-impl",
    kind: "implement",
    status: "completed",
    cwd: "/tmp/ws-a",
    startedAt: "2026-08-22T15:50:00.000Z",
    finishedAt: "2026-08-22T15:59:00.000Z",
    usage: { input: 1, output: 2 },
    error: null,
  });

  const dqRound = acceptRound(1, {
    implementRefusal: {
      qualifies: false,
      disqualification: "only 1 named anchor",
      why: null,
    },
    worktreeChanged: true,
    disposition: { disposition: "escalate", reason: "refusal did not qualify" },
    verdict: "needs-attention",
  });
  writeChain(root, WS_A, "chain-refusal-dq", {
    control: baseControl("chain-refusal-dq", {
      status: "completed",
      finishedAt: "2026-08-22T14:00:00.000Z",
    }),
    chain: baseChain("chain-refusal-dq", { records: [dqRound] }),
    rounds: [dqRound],
  });

  const quotaRound = acceptRound(1, {
    implementJobId: "job-quota",
    worktreeChanged: true,
    disposition: { disposition: "escalate", reason: "provider exhausted" },
    verdict: "needs-attention",
  });
  writeChain(root, WS_A, "chain-quota", {
    control: baseControl("chain-quota", {
      status: "failed",
      finishedAt: "2026-08-22T13:00:00.000Z",
    }),
    chain: baseChain("chain-quota", { records: [quotaRound] }),
    rounds: [quotaRound],
  });
  writeJson(path.join(root, WS_A, "jobs", "job-quota", "job.json"), {
    id: "job-quota",
    kind: "implement",
    status: "provider-error",
    error: "agy dispatch failed: Individual quota reached. Resets in 2h2m9s.",
    startedAt: "2026-08-22T12:50:00.000Z",
    finishedAt: "2026-08-22T12:51:00.000Z",
  });

  const unp1 = acceptRound(1, {
    worktreeChanged: true,
    disposition: { disposition: "rework", reason: "findings" },
    verdict: "needs-attention",
  });
  const unp2 = acceptRound(2, {
    worktreeChanged: true,
    verdict: "unparseable",
    reviewParseable: false,
    disposition: { disposition: "escalate", reason: "review unreadable" },
  });
  writeChain(root, WS_A, "chain-unparseable", {
    control: baseControl("chain-unparseable", {
      status: "completed",
      finishedAt: "2026-08-22T12:00:00.000Z",
      round: 2,
    }),
    chain: baseChain("chain-unparseable", { records: [unp1, unp2] }),
    rounds: [unp1, unp2],
  });

  writeChain(root, WS_A, "chain-cancelled", {
    control: baseControl("chain-cancelled", {
      status: "cancelled",
      finishedAt: "2026-08-22T11:00:00.000Z",
      round: 1,
    }),
    chain: baseChain("chain-cancelled", { records: [] }),
  });

  writeJson(path.join(root, WS_B, "jobs", "job-wsb", "job.json"), {
    id: "job-wsb",
    kind: "task",
    status: "completed",
    cwd: "/tmp/ws-b",
    startedAt: "2026-08-22T08:00:00.000Z",
    finishedAt: "2026-08-22T08:01:00.000Z",
  });

  const refusalRound = acceptRound(1, {
    implementRefusal: {
      qualifies: true,
      why: "two named items cannot both hold",
      disqualification: null,
    },
    worktreeChanged: true,
    disposition: { disposition: "escalate", reason: "worker refused" },
    verdict: "needs-attention",
  });
  writeChain(root, WS_B, "chain-refusal", {
    control: baseControl("chain-refusal", {
      status: "completed",
      finishedAt: "2026-08-22T15:00:00.000Z",
    }),
    chain: baseChain("chain-refusal", { records: [refusalRound] }),
    rounds: [refusalRound],
  });

  const emptyRound = acceptRound(1, {
    worktreeChanged: false,
    implementRefusal: null,
    reviewParseable: true,
    verdict: "approve",
    disposition: { disposition: "escalate", reason: "empty worktree" },
  });
  writeChain(root, WS_B, "chain-empty", {
    control: baseControl("chain-empty", {
      status: "completed",
      finishedAt: "2026-08-22T10:00:00.000Z",
    }),
    chain: baseChain("chain-empty", { records: [emptyRound] }),
    rounds: [emptyRound],
  });
}

describe("dashboard collectors", () => {
  let tmp;
  let savedStateDir;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-dashboard-"));
    savedStateDir = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = tmp;
    buildState(tmp);
  });

  afterEach(() => {
    if (savedStateDir === undefined) delete process.env.KUSABI_STATE_DIR;
    else process.env.KUSABI_STATE_DIR = savedStateDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("listWorkspaces returns both workspaces with cwd from server.json or job.json", () => {
    const result = listWorkspaces(tmp);
    assert.ok(result.meta);
    assert.equal(typeof result.meta.source, "string");
    assert.equal(typeof result.meta.denominator, "string");
    assert.ok(result.meta.generatedAt);
    const bySlug = Object.fromEntries(result.workspaces.map((w) => [w.slug, w]));
    assert.equal(result.workspaces.length, 2);
    assert.equal(bySlug[WS_A].cwd, "/tmp/ws-a");
    assert.equal(bySlug[WS_B].cwd, "/tmp/ws-b");
    assert.ok(bySlug[WS_A].chainCount >= 1);
    assert.ok(bySlug[WS_A].serve.present);
    assert.equal(bySlug[WS_A].serve.alive, false);
    assert.equal(bySlug[WS_B].serve, null);
  });

  it("collectRunning returns exactly the two running chains; stalled only for the dead pid", () => {
    const result = collectRunning(tmp, { now: Date.now() });
    assert.ok(result.meta.source.includes("effectiveStatus running|stopping|stale"));
    const ids = result.chains.map((c) => c.chainId).sort();
    assert.deepEqual(ids, ["chain-run-dead", "chain-run-live"]);
    const live = result.chains.find((c) => c.chainId === "chain-run-live");
    const dead = result.chains.find((c) => c.chainId === "chain-run-dead");
    assert.equal(live.pidAlive, true);
    assert.equal(live.stalled, false);
    assert.equal(live.status, "running");
    assert.equal(dead.pidAlive, false);
    assert.equal(dead.stalled, true);
    assert.equal(dead.status, "stale");
  });

  it("collectEnded assigns failureClass by precedence, newest first, and respects limit", () => {
    const result = collectEnded(tmp, { limit: 50 });
    assert.ok(result.meta);
    const ids = result.chains.map((c) => c.chainId);
    assert.deepEqual(ids, [
      "chain-accept",
      "chain-refusal",
      "chain-refusal-dq",
      "chain-quota",
      "chain-unparseable",
      "chain-cancelled",
      "chain-empty",
    ]);
    const byId = Object.fromEntries(result.chains.map((c) => [c.chainId, c]));
    assert.equal(byId["chain-quota"].failureClass, "provider-error");
    assert.match(byId["chain-quota"].failureDetail, /Individual quota reached/);
    assert.equal(byId["chain-refusal"].failureClass, "refusal");
    assert.match(byId["chain-refusal"].failureDetail, /two named items/);
    assert.equal(byId["chain-refusal-dq"].failureClass, "refusal-disqualified");
    assert.match(byId["chain-refusal-dq"].failureDetail, /only 1 named anchor/);
    assert.equal(byId["chain-unparseable"].failureClass, "review-unparseable");
    assert.equal(byId["chain-empty"].failureClass, "empty-round");
    assert.equal(byId["chain-cancelled"].failureClass, "cancelled");
    assert.equal(byId["chain-accept"].failureClass, "none");

    const limited = collectEnded(tmp, { limit: 2 });
    assert.equal(limited.chains.length, 2);
    assert.deepEqual(limited.chains.map((c) => c.chainId), ["chain-accept", "chain-refusal"]);
  });

  it("chainDetail digest matches renderChainShow and includes referenced jobs; missing chain returns {error}", () => {
    const detail = chainDetail(tmp, WS_A, "chain-accept");
    assert.ok(!detail.error);
    const chainDir = path.join(tmp, WS_A, "chains", "chain-accept");
    const chainJson = readJson(path.join(chainDir, "chain.json"));
    const control = readJson(path.join(chainDir, "control.json"));
    const round = readJson(path.join(chainDir, "round-1.json"));
    const expected = renderChainShow(chainJson, [round], [], control);
    assert.equal(detail.digest, expected);
    assert.equal(detail.status, resolveChainStatus(control, [round]));
    assert.equal(detail.chain.briefTitle, "Accept this change");
    assert.equal(detail.chain.brief, undefined);
    assert.ok(detail.jobs["job-accept-impl"]);
    assert.equal(detail.jobs["job-accept-impl"].status, "completed");

    const missing = chainDetail(tmp, WS_A, "chain-nope");
    assert.ok(missing.error);
    assert.equal(missing.chain, undefined);
  });

  it("costSummary with a missing db path returns status missing and does not create the file", () => {
    const dbPath = path.join(tmp, "no-such", "metrics.db");
    const result = costSummary({ dbPath });
    assert.equal(result.status, "missing");
    assert.equal(fs.existsSync(dbPath), false);
  });
});

describe("dashboard costSummary against an ingested db", () => {
  it("returns freshness and byBackend after metrics-ingest", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-dashboard-ingest-"));
    try {
      const stateRoot = path.join(tmp, "state");
      const transcriptDir = path.join(tmp, "transcripts");
      const cursorUsageDir = path.join(tmp, "cursor-usage");
      const dbPath = path.join(tmp, "metrics.db");
      fs.mkdirSync(transcriptDir, { recursive: true });
      fs.mkdirSync(cursorUsageDir, { recursive: true });
      const jobDir = path.join(stateRoot, "ws-hash-1", "jobs", "job-complete01");
      fs.mkdirSync(jobDir, { recursive: true });
      writeJson(path.join(jobDir, "job.json"), {
        id: "job-complete01",
        kind: "task",
        status: "completed",
        startedAt: "2026-08-01T10:00:00.000Z",
        finishedAt: "2026-08-01T10:26:15.000Z",
      });
      writeJson(path.join(jobDir, "usage.json"), {
        available: true,
        input: 10,
        output: 20,
        cost: 0,
      });
      const ingest = spawnSync(process.execPath, [
        COMPANION, "metrics-ingest",
        "--state-root", stateRoot,
        "--transcript-dir", transcriptDir,
        "--cursor-usage-dir", cursorUsageDir,
        "--db", dbPath,
      ], { encoding: "utf8", timeout: 30_000 });
      assert.equal(ingest.status, 0, ingest.stdout + ingest.stderr);
      const result = costSummary({ dbPath });
      assert.notEqual(result.status, "missing");
      assert.ok(result.freshness);
      assert.ok(result.byBackend);
      assert.ok(Array.isArray(result.byBackend.chains) || Array.isArray(result.byBackend.jobs) || result.byBackend);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("dashboard HTTP server", () => {
  let tmp;
  let server;
  let port;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-dashboard-http-"));
    buildState(tmp);
    const started = await startDashboard({
      stateRoot: tmp,
      dbPath: path.join(tmp, "metrics.db"),
      port: 0,
    });
    server = started.server;
    port = started.port;
  });

  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function get(pathname) {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* plain */ }
    return { status: res.status, headers: res.headers, body };
  }

  it("GET routes return 200 with expected keys and meta; POST is 405; unknown is 404", async () => {
    const ws = await get("/api/workspaces.json");
    assert.equal(ws.status, 200);
    assert.ok(ws.body.meta);
    assert.ok(Array.isArray(ws.body.workspaces));
    assert.match(ws.headers.get("content-type"), /application\/json/);
    assert.equal(ws.headers.get("cache-control"), "no-store");

    const running = await get("/api/running.json");
    assert.equal(running.status, 200);
    assert.ok(running.body.meta);
    assert.ok(Array.isArray(running.body.chains));

    const ended = await get("/api/ended.json?limit=3");
    assert.equal(ended.status, 200);
    assert.ok(ended.body.meta);
    assert.equal(ended.body.chains.length, 3);

    const detail = await get(`/api/chain/${WS_A}/chain-accept.json`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.meta);
    assert.ok(detail.body.digest);
    assert.ok(detail.body.status);

    const missing = await get(`/api/chain/${WS_A}/chain-nope.json`);
    assert.equal(missing.status, 404);
    assert.ok(missing.body.error);

    const cost = await get("/api/cost.json");
    assert.equal(cost.status, 200);
    assert.equal(cost.body.status, "missing");
    assert.ok(cost.body.meta);

    const stats = await get(`/api/stats/${WS_A}.json`);
    assert.equal(stats.status, 200);
    assert.ok(stats.body.meta);

    const index = await get("/");
    assert.equal(index.status, 200);
    assert.match(String(index.body), /\/api\/workspaces\.json/);

    const post = await fetch(`http://127.0.0.1:${port}/api/running.json`, { method: "POST" });
    assert.equal(post.status, 405);

    const nope = await get("/nope");
    assert.equal(nope.status, 404);
    assert.ok(nope.body.error);
  });
});

describe("dashboard CLI", () => {
  it("--help lists dashboard and --port", () => {
    const result = spawnSync(process.execPath, [COMPANION, "--help"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^ {2}dashboard /m);
    assert.match(result.stdout, /--port <N>/);
  });

  it("spawn dashboard --port 0 prints listening on and dies on SIGTERM", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-dashboard-spawn-"));
    const child = spawn(process.execPath, [
      COMPANION, "dashboard", "--port", "0", "--state-root", tmp,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no listening line: ${stdout}\n${stderr}`)), 8000);
        const onData = () => {
          if (stdout.includes("listening on")) {
            clearTimeout(t);
            child.stdout.off("data", onData);
            resolve();
          }
        };
        child.stdout.on("data", onData);
        child.on("error", (err) => {
          clearTimeout(t);
          reject(err);
        });
        child.on("exit", (code) => {
          if (!stdout.includes("listening on")) {
            clearTimeout(t);
            reject(new Error(`exited ${code} before listening: ${stdout}\n${stderr}`));
          }
        });
        onData();
      });
      assert.match(stdout, /dashboard: listening on http:\/\/127\.0\.0\.1:\d+/);
      assert.match(stdout, /state root/);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        if (child.exitCode != null || child.signalCode != null) {
          resolve();
          return;
        }
        child.on("close", resolve);
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
      });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
