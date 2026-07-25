// serve-lifecycle.mjs — opencode server start/stop/health/reap
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import process from "node:process";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { stateDirFor, readJson, writeJson } from "./state-paths.mjs";

const SERVER_READY_TIMEOUT_MS = 20_000;

export function opencodeBin() {
  return process.env.OPENCODE_BIN || "opencode";
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export function authHeader(server) {
  const user = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  return { authorization: `Basic ${Buffer.from(`${user}:${server.password}`).toString("base64")}` };
}

export async function serverHealthy(server) {
  if (!server?.port || !server?.password) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/session`, {
      headers: authHeader(server),
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureServer(cwd) {
  const stateDir = stateDirFor(cwd);
  const serverFile = path.join(stateDir, "server.json");
  const existing = readJson(serverFile);
  if (await serverHealthy(existing)) return { ...existing, stateDir };

  const port = await freePort();
  const password = crypto.randomBytes(16).toString("hex");
  const logFile = path.join(stateDir, "server.log");
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(opencodeBin(), ["serve", "--port", String(port)], {
    cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
  });
  child.unref();
  fs.closeSync(logFd);

  const server = { port, password, pid: child.pid, cwd, startedAt: new Date().toISOString() };
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await serverHealthy(server)) {
      writeJson(serverFile, server);
      return { ...server, stateDir };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`opencode serve did not become ready within ${SERVER_READY_TIMEOUT_MS}ms (log: ${logFile})`);
}

export async function api(server, method, apiPath, body) {
  const res = await fetch(`http://127.0.0.1:${server.port}${apiPath}`, {
    method,
    headers: { ...authHeader(server), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${apiPath} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Scan all hash directories under the state root and reap idle serves whose
 * last activity is older than *ttlMs*.  A serve is never touched when any of
 * its jobs still has `status === "running"`.
 *
 * Best-effort: per-directory errors are caught and the function never throws.
 */
export function reapIdleServes(root, ttlMs) {
  if (!fs.existsSync(root)) return;
  let entries;
  try { entries = fs.readdirSync(root); } catch { return; }
  for (const entry of entries) {
    try {
      const hashDir = path.join(root, entry);
      if (!fs.statSync(hashDir).isDirectory()) continue;
      const serverFile = path.join(hashDir, "server.json");
      if (!fs.existsSync(serverFile)) continue;

      const server = readJson(serverFile);
      if (!server?.pid) continue;

      // Pid alive?
      try { process.kill(server.pid, 0); } catch { continue; }

      // Collect job statuses + mtimes.
      const jobRecords = [];
      const jobsDir = path.join(hashDir, "jobs");
      if (fs.existsSync(jobsDir)) {
        const jobIds = fs.readdirSync(jobsDir);
        for (const jobId of jobIds) {
          const jobFile = path.join(jobsDir, jobId, "job.json");
          if (!fs.existsSync(jobFile)) continue;
          const job = readJson(jobFile);
          if (!job) continue;
          try {
            jobRecords.push({ status: job.status, mtime: fs.statSync(jobFile).mtimeMs });
          } catch { /* skip unreadable job */ }
        }
      }

      const serverMtime = fs.statSync(serverFile).mtimeMs;
      const now = Date.now();
      const decision = shouldReapServer({ serverMtime, jobRecords, now, ttlMs });

      if (decision.reap) {
        try { process.kill(server.pid); } catch { /* already gone */ }
        try { fs.unlinkSync(serverFile); } catch { /* best-effort */ }
      }
    } catch { /* best-effort per hash dir */ }
  }
}

/**
 * @param {object} opts
 * @param {number} opts.serverMtime  — mtimeMs of server.json
 * @param {Array<{status: string, mtime: number}>} opts.jobRecords
 * @param {number} opts.now          — Date.now() at decision time
 * @param {number} opts.ttlMs        — idle TTL in milliseconds
 * @returns {{ reap: boolean, reason: string }}
 */
export function shouldReapServer({ serverMtime, jobRecords, now, ttlMs }) {
  const hasRunning = jobRecords.some(function (j) { return j.status === "running"; });
  if (hasRunning) return { reap: false, reason: "a running job exists" };

  let maxJobMtime = 0;
  for (let i = 0; i < jobRecords.length; i++) {
    maxJobMtime = Math.max(maxJobMtime, jobRecords[i].mtime || 0);
  }
  const lastActivity = Math.max(serverMtime || 0, maxJobMtime);
  const idleMs = now - lastActivity;

  if (idleMs > ttlMs) {
    return { reap: true, reason: "idle " + idleMs + "ms exceeds TTL " + ttlMs + "ms" };
  }
  return { reap: false, reason: "not yet stale (idle " + idleMs + "ms, TTL " + ttlMs + "ms)" };
}
