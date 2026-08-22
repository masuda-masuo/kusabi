// dashboard.mjs — read-only collectors over the kusabi state root + metrics.db,
// and a local JSON HTTP server. Nothing here writes state or calls an LLM.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { collectChainRecords, computeStats } from "./chain-stats.mjs";
import { effectiveStatus, isPidAlive } from "./chain-control.mjs";
import { DEFAULT_PROGRESS_TIMEOUT_MS, listChainIds } from "./chain-wait.mjs";
import { openMetricsDbReadOnly } from "./metrics-db.mjs";
import { computeReport } from "./metrics-report.mjs";
import { renderChainShow, resolveChainStatus } from "./render.mjs";
import { readJson } from "./state-paths.mjs";

const RUNNING_EFFECTIVE = new Set(["running", "stopping", "stale"]);
const TERMINAL_CONTROL = new Set(["completed", "failed", "cancelled"]);
const PROVIDER_JOB_STATUSES = new Set(["provider-error", "serve-dead", "stalled", "timeout"]);
const PROVIDER_ERROR_SNIPPETS = ["quota", "free_tier_limit", "routes exhausted"];

function nowIso() {
  return new Date().toISOString();
}

function makeMeta(source, denominator) {
  return { source, denominator, generatedAt: nowIso() };
}

function listWorkspaceSlugs(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function countChildDirs(dir, prefix) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && (!prefix || e.name.startsWith(prefix)))
      .length;
  } catch {
    return 0;
  }
}

function resolveWorkspaceCwd(wsDir) {
  const server = readJson(path.join(wsDir, "server.json"));
  if (typeof server?.cwd === "string" && server.cwd) return server.cwd;
  const jobsDir = path.join(wsDir, "jobs");
  try {
    for (const name of fs.readdirSync(jobsDir)) {
      const job = readJson(path.join(jobsDir, name, "job.json"));
      if (typeof job?.cwd === "string" && job.cwd) return job.cwd;
    }
  } catch { /* no jobs dir or unreadable */ }
  return null;
}

function collectServe(wsDir) {
  const serverPath = path.join(wsDir, "server.json");
  if (!fs.existsSync(serverPath)) return null;
  const server = readJson(serverPath);
  if (!server) {
    return { present: true, pid: null, alive: null, startedAt: null };
  }
  const pid = Number.isInteger(server.pid) ? server.pid : null;
  return {
    present: true,
    pid,
    alive: pid == null ? null : isPidAlive(pid),
    startedAt: server.startedAt ?? null,
  };
}

function readRoundFiles(chainDir) {
  const rounds = [];
  const unreadable = [];
  let names = [];
  try {
    names = fs.readdirSync(chainDir)
      .filter((f) => f.startsWith("round-") && f.endsWith(".json"))
      .sort((a, b) => {
        const na = Number(a.match(/round-(\d+)\.json$/)?.[1]) ?? 0;
        const nb = Number(b.match(/round-(\d+)\.json$/)?.[1]) ?? 0;
        return na - nb;
      });
  } catch {
    return { rounds, unreadable };
  }
  for (const f of names) {
    const data = readJson(path.join(chainDir, f));
    if (data) rounds.push(data);
    else unreadable.push(f);
  }
  return { rounds, unreadable };
}

function fileMtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function lastProgressMs(chainDir) {
  let newest = fileMtimeMs(path.join(chainDir, "control.json"));
  const chainMs = fileMtimeMs(path.join(chainDir, "chain.json"));
  if (chainMs > newest) newest = chainMs;
  try {
    for (const f of fs.readdirSync(chainDir)) {
      if (!f.startsWith("round-") || !f.endsWith(".json")) continue;
      const ms = fileMtimeMs(path.join(chainDir, f));
      if (ms > newest) newest = ms;
    }
  } catch { /* missing chain dir */ }
  return newest;
}

function briefTitle(brief) {
  if (typeof brief !== "string" || !brief) return null;
  const line = brief.split(/\r?\n/, 1)[0].trim();
  return line || null;
}

function jobPath(wsDir, jobId) {
  return path.join(wsDir, "jobs", jobId, "job.json");
}

function readJobLazy(wsDir, jobId, warnings) {
  if (!jobId) return null;
  const file = jobPath(wsDir, jobId);
  if (!fs.existsSync(file)) {
    warnings.push(`missing job file ${file}`);
    return null;
  }
  const job = readJson(file);
  if (!job) {
    warnings.push(`unreadable job file ${file}`);
    return null;
  }
  return job;
}

function jobLooksProviderError(job) {
  if (!job) return false;
  if (PROVIDER_JOB_STATUSES.has(job.status)) return true;
  const err = typeof job.error === "string" ? job.error : "";
  return PROVIDER_ERROR_SNIPPETS.some((s) => err.includes(s));
}

function classifyFailure(control, rounds, wsDir, warnings) {
  for (const round of rounds) {
    for (const id of [round.implementJobId, round.reviewJobId]) {
      if (!id) continue;
      const job = readJobLazy(wsDir, id, warnings);
      if (jobLooksProviderError(job)) {
        const err = typeof job.error === "string" ? job.error : "";
        return {
          failureClass: "provider-error",
          failureDetail: (err || String(job.status || "")).slice(0, 200),
        };
      }
    }
  }

  const last = rounds.length > 0 ? rounds[rounds.length - 1] : null;
  const refusal = last?.implementRefusal ?? null;
  if (refusal && refusal.qualifies === true) {
    return {
      failureClass: "refusal",
      failureDetail: typeof refusal.why === "string" ? refusal.why : null,
    };
  }
  if (refusal && refusal.qualifies !== true) {
    return {
      failureClass: "refusal-disqualified",
      failureDetail: typeof refusal.disqualification === "string" ? refusal.disqualification : null,
    };
  }
  if (last && (last.verdict === "unparseable" || last.reviewParseable === false)) {
    return { failureClass: "review-unparseable", failureDetail: last.verdict ?? null };
  }
  if (last && last.worktreeChanged === false) {
    return { failureClass: "empty-round", failureDetail: null };
  }
  if (control?.status === "cancelled") {
    return { failureClass: "cancelled", failureDetail: null };
  }
  return { failureClass: "none", failureDetail: null };
}

function lastDisposition(rounds) {
  for (let i = rounds.length - 1; i >= 0; i -= 1) {
    const d = rounds[i]?.disposition;
    if (d && typeof d === "object") {
      return { disposition: d.disposition ?? null, reason: d.reason ?? null };
    }
    if (typeof d === "string") return { disposition: d, reason: null };
  }
  return { disposition: null, reason: null };
}

/**
 * @param {string} root
 * @returns {{ meta: object, workspaces: Array<object> }}
 */
export function listWorkspaces(root) {
  const workspaces = [];
  for (const slug of listWorkspaceSlugs(root)) {
    const wsDir = path.join(root, slug);
    workspaces.push({
      slug,
      cwd: resolveWorkspaceCwd(wsDir),
      chainCount: countChildDirs(path.join(wsDir, "chains"), "chain-"),
      jobCount: countChildDirs(path.join(wsDir, "jobs")),
      serve: collectServe(wsDir),
    });
  }
  return {
    meta: makeMeta(
      "workspace directories under the state root (each <root>/<slug>/ with chains/, jobs/, optional server.json)",
      "workspace directories immediately under the state root",
    ),
    workspaces,
  };
}

/**
 * @param {string} root
 * @param {{ now?: Date|number }} [opts]
 */
export function collectRunning(root, { now } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : (typeof now === "number" ? now : Date.now());
  const chains = [];
  for (const slug of listWorkspaceSlugs(root)) {
    const wsDir = path.join(root, slug);
    const cwd = resolveWorkspaceCwd(wsDir);
    const chainsDir = path.join(wsDir, "chains");
    for (const chainId of listChainIds(chainsDir)) {
      const chainDir = path.join(chainsDir, chainId);
      const control = readJson(path.join(chainDir, "control.json"));
      const { status } = effectiveStatus(control);
      if (!RUNNING_EFFECTIVE.has(status)) continue;
      const chainJson = readJson(path.join(chainDir, "chain.json"));
      const { rounds } = readRoundFiles(chainDir);
      const last = rounds.length > 0 ? rounds[rounds.length - 1] : null;
      const pid = Number.isInteger(control?.pid) ? control.pid : null;
      const pidAlive = pid == null ? false : isPidAlive(pid);
      const progressMs = lastProgressMs(chainDir);
      const idleSeconds = progressMs > 0 ? Math.max(0, Math.floor((nowMs - progressMs) / 1000)) : null;
      const stalled = (idleSeconds != null && idleSeconds * 1000 >= DEFAULT_PROGRESS_TIMEOUT_MS) || !pidAlive;
      chains.push({
        workspace: slug,
        cwd,
        chainId: control?.chainId || chainJson?.chainId || chainId,
        container: control?.container ?? chainJson?.container ?? null,
        round: control?.round ?? null,
        maxRounds: chainJson?.maxRounds ?? null,
        backend: last?.backend ?? chainJson?.backend ?? null,
        model: chainJson?.model ?? last?.model ?? null,
        startedAt: control?.startedAt ?? null,
        lastProgressAt: progressMs > 0 ? new Date(progressMs).toISOString() : null,
        idleSeconds,
        pidAlive,
        stalled,
        status,
      });
    }
  }
  return {
    meta: makeMeta(
      "chains under <root>/*/chains with effectiveStatus running|stopping|stale",
      "chains whose control.json effectiveStatus is running, stopping, or stale",
    ),
    chains,
  };
}

/**
 * @param {string} root
 * @param {{ limit?: number }} [opts]
 */
export function collectEnded(root, { limit = 50 } = {}) {
  const warnings = [];
  const chains = [];
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 50;
  for (const slug of listWorkspaceSlugs(root)) {
    const wsDir = path.join(root, slug);
    const cwd = resolveWorkspaceCwd(wsDir);
    const chainsDir = path.join(wsDir, "chains");
    for (const chainId of listChainIds(chainsDir)) {
      const chainDir = path.join(chainsDir, chainId);
      const control = readJson(path.join(chainDir, "control.json"));
      if (!TERMINAL_CONTROL.has(control?.status)) continue;
      const chainJson = readJson(path.join(chainDir, "chain.json"));
      const { rounds } = readRoundFiles(chainDir);
      const { failureClass, failureDetail } = classifyFailure(control, rounds, wsDir, warnings);
      const disp = lastDisposition(rounds);
      const last = rounds.length > 0 ? rounds[rounds.length - 1] : null;
      const totals = chainJson?.chainTotals || {};
      chains.push({
        workspace: slug,
        cwd,
        chainId: control?.chainId || chainJson?.chainId || chainId,
        finishedAt: control?.finishedAt ?? null,
        rounds: rounds.length,
        disposition: disp.disposition,
        dispositionReason: disp.reason,
        probesGreenLastRound: last?.probesGreen ?? null,
        failureClass,
        failureDetail,
        tokens: {
          input: totals.input ?? null,
          output: totals.output ?? null,
          cost: totals.cost ?? null,
        },
      });
    }
  }
  chains.sort((a, b) => {
    const ta = a.finishedAt ? Date.parse(a.finishedAt) : 0;
    const tb = b.finishedAt ? Date.parse(b.finishedAt) : 0;
    if (tb !== ta) return tb - ta;
    return a.chainId < b.chainId ? -1 : a.chainId > b.chainId ? 1 : 0;
  });
  return {
    meta: makeMeta(
      "chains under <root>/*/chains whose control.json status is completed, failed, or cancelled",
      "terminal chains ordered by finishedAt descending, then truncated to limit",
    ),
    chains: chains.slice(0, cap),
    warnings,
  };
}

/**
 * @param {string} root
 * @param {string} slug
 * @param {string} chainId
 */
export function chainDetail(root, slug, chainId) {
  const chainDir = path.join(root, slug, "chains", chainId);
  if (!fs.existsSync(chainDir)) {
    return { error: `chain not found: ${slug}/${chainId}` };
  }
  let isDir = false;
  try { isDir = fs.statSync(chainDir).isDirectory(); } catch { isDir = false; }
  if (!isDir) {
    return { error: `chain not found: ${slug}/${chainId}` };
  }

  const control = readJson(path.join(chainDir, "control.json"));
  const chainJson = readJson(path.join(chainDir, "chain.json"));
  const { rounds, unreadable } = readRoundFiles(chainDir);
  const chainForShow = chainJson || (control
    ? { chainId, container: control.container, brief: null, orchestrator: null }
    : { chainId });
  const digest = renderChainShow(chainForShow, rounds, unreadable, control);
  const status = resolveChainStatus(control, rounds);

  const { brief, ...chainRest } = chainForShow;
  const chain = { ...chainRest, briefTitle: briefTitle(brief) };

  const warnings = [];
  const jobs = {};
  const wsDir = path.join(root, slug);
  for (const round of rounds) {
    for (const id of [round.implementJobId, round.reviewJobId]) {
      if (!id || jobs[id]) continue;
      const job = readJobLazy(wsDir, id, warnings);
      if (!job) continue;
      jobs[id] = {
        status: job.status ?? null,
        error: job.error ?? null,
        usage: job.usage ?? null,
        startedAt: job.startedAt ?? null,
        finishedAt: job.finishedAt ?? null,
      };
    }
  }

  return {
    meta: makeMeta(
      `control.json, chain.json, round-N.json and referenced jobs/<id>/job.json under <root>/${slug}/chains/${chainId}`,
      "one chain identified by workspace slug and chain id",
    ),
    chain,
    control,
    rounds,
    jobs,
    digest,
    status,
    warnings,
  };
}

/**
 * @param {{ dbPath: string, since?: string, until?: string }}
 */
export function costSummary({ dbPath, since, until } = {}) {
  const meta = makeMeta(
    "metrics.db opened read-only (never created by this collector)",
    "in-window turns, chains and jobs in the metrics store",
  );
  if (!dbPath || !fs.existsSync(dbPath)) {
    return { status: "missing", dbPath: dbPath ?? null, meta };
  }
  const db = openMetricsDbReadOnly(dbPath);
  try {
    const report = computeReport(db, { since, until, dbPath });
    return {
      status: report.status,
      freshness: report.freshness,
      sessionCostByModel: report.sessionCostByModel,
      byBackend: report.byBackend,
      dispositionSeverity: report.dispositionSeverity,
      meta,
    };
  } finally {
    db.close();
  }
}

/**
 * @param {string} root
 * @param {string} slug
 * @param {{ since?: string, until?: string }} [opts]
 */
export function workspaceStats(root, slug, { since, until } = {}) {
  const collected = collectChainRecords(path.join(root, slug));
  const stats = computeStats(collected.chains, { since, until });
  return {
    ...stats,
    meta: makeMeta(
      `chain.json records under <root>/${slug}/chains`,
      "chain records collected for this workspace, optionally windowed by since/until",
    ),
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res, status, body, contentType) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const INDEX_TEXT = [
  "kusabi dashboard — read-only JSON API",
  "",
  "GET /api/workspaces.json",
  "GET /api/running.json",
  "GET /api/ended.json?limit=N",
  "GET /api/chain/<slug>/<chainId>.json",
  "GET /api/cost.json?since=ISO&until=ISO",
  "GET /api/stats/<slug>.json?since=&until=",
].join("\n");

function handleRequest(req, res, { root, dbPath }) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  let url;
  try {
    url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  } catch {
    sendJson(res, 400, { error: "bad request url" });
    return;
  }
  const p = url.pathname;
  try {
    if (p === "/") {
      sendText(res, 200, `${INDEX_TEXT}\n`, "text/plain; charset=utf-8");
      return;
    }
    if (p === "/api/workspaces.json") {
      sendJson(res, 200, listWorkspaces(root));
      return;
    }
    if (p === "/api/running.json") {
      sendJson(res, 200, collectRunning(root));
      return;
    }
    if (p === "/api/ended.json") {
      const raw = url.searchParams.get("limit");
      const limit = raw == null || raw === "" ? 50 : Number(raw);
      sendJson(res, 200, collectEnded(root, { limit: Number.isInteger(limit) ? limit : 50 }));
      return;
    }
    if (p === "/api/cost.json") {
      sendJson(res, 200, costSummary({
        dbPath,
        since: url.searchParams.get("since") || undefined,
        until: url.searchParams.get("until") || undefined,
      }));
      return;
    }
    const chainMatch = p.match(/^\/api\/chain\/([^/]+)\/([^/]+)\.json$/);
    if (chainMatch) {
      const body = chainDetail(root, decodeURIComponent(chainMatch[1]), decodeURIComponent(chainMatch[2]));
      sendJson(res, body.error && !body.chain ? 404 : 200, body);
      return;
    }
    const statsMatch = p.match(/^\/api\/stats\/([^/]+)\.json$/);
    if (statsMatch) {
      sendJson(res, 200, workspaceStats(root, decodeURIComponent(statsMatch[1]), {
        since: url.searchParams.get("since") || undefined,
        until: url.searchParams.get("until") || undefined,
      }));
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 500, { error: err?.message || String(err) });
  }
}

/**
 * Bind a read-only JSON server. `port: 0` is allowed (ephemeral).
 * Resolves with `{ server, port }` after listen. SIGINT/SIGTERM close it.
 *
 * @param {{ stateRoot: string, dbPath: string, port: number, host?: string }}
 * @returns {Promise<{ server: import("node:http").Server, port: number }>}
 */
export function startDashboard({ stateRoot: root, dbPath, port, host = "127.0.0.1" }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        handleRequest(req, res, { root, dbPath });
      } catch (err) {
        try { sendJson(res, 500, { error: err?.message || String(err) }); } catch { /* already closed */ }
      }
    });
    const stop = () => {
      server.close();
    };
    server.on("error", reject);
    server.on("close", () => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    });
    server.listen(port, host, () => {
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      const addr = server.address();
      const bound = addr && typeof addr === "object" ? addr.port : port;
      resolve({ server, port: bound });
    });
  });
}
