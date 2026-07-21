#!/usr/bin/env node
// kusabi-companion: bridge between Claude Code slash commands and an
// on-demand `opencode serve` instance.
//
// Context firewall: every opencode event is persisted under the state dir;
// stdout only ever carries the rendered final result, so the calling Claude
// session never sees intermediate narration, tool logs, or raw events.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const SERVER_READY_TIMEOUT_MS = 20_000;
const DEFAULT_TASK_TIMEOUT_S = 3600;
const DEFAULT_REVIEW_TIMEOUT_S = 1800;
const DEFAULT_WATCHDOG_S = 900; // must be > opencode mcp_timeout (600s) so inner timeout trips first
const REVIEW_DIFF_LIMIT = 200_000;
const WRITE_TOOL_NAMES = ["bash", "edit", "write", "patch", "task"];

const PHASE_AGENTS = {
  draft: "kusabi-draft",
  investigate: "kusabi-investigate",
  implement: "kusabi-implement",
  review: "kusabi-review",
  respond: "kusabi-respond",
  salvage: "kusabi-salvage",
};

// ---------------------------------------------------------------------------
// state dir / server lifecycle
// ---------------------------------------------------------------------------

export function stateRoot() {
  const envDir = process.env.KUSABI_STATE_DIR || process.env.OPENCODE_COMPANION_STATE_DIR;
  if (envDir) return envDir;
  const newDir = path.join(os.homedir(), ".kusabi");
  const oldDir = path.join(os.homedir(), ".opencode-plugin-cc");
  // One-time migration: rename old state dir to new name if only the old exists.
  if (!fs.existsSync(newDir) && fs.existsSync(oldDir)) {
    try { fs.renameSync(oldDir, newDir); } catch { /* best-effort */ }
  }
  return newDir;
}

function stateDirFor(cwd) {
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  const dir = path.join(stateRoot(), hash);
  fs.mkdirSync(path.join(dir, "jobs"), { recursive: true });
  return dir;
}

/**
 * Scan all hash directories under the state root and reap idle serves whose
 * last activity is older than *ttlMs*.  A serve is never touched when any of
 * its jobs still has `status === "running"`.
 *
 * Best-effort: per-directory errors are caught and the function never throws.
 */
function reapIdleServes(root, ttlMs) {
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

function opencodeBin() {
  return process.env.OPENCODE_BIN || "opencode";
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function authHeader(server) {
  const user = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  return { authorization: `Basic ${Buffer.from(`${user}:${server.password}`).toString("base64")}` };
}

async function serverHealthy(server) {
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

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function ensureServer(cwd) {
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

async function api(server, method, apiPath, body) {
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

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

function newJobId() {
  return `job-${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
}

function jobDir(stateDir, jobId) {
  return path.join(stateDir, "jobs", jobId);
}

function saveJob(stateDir, job) {
  writeJson(path.join(jobDir(stateDir, job.id), "job.json"), job);
}

function loadJob(stateDir, jobId) {
  return readJson(path.join(jobDir(stateDir, jobId), "job.json"));
}

function listJobs(stateDir) {
  const root = path.join(stateDir, "jobs");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((id) => loadJob(stateDir, id))
    .filter(Boolean)
    .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
}

function latestJob(stateDir, predicate = () => true) {
  return listJobs(stateDir).find(predicate) ?? null;
}

function appendEvent(stateDir, jobId, event) {
  fs.appendFileSync(path.join(jobDir(stateDir, jobId), "events.ndjson"), `${JSON.stringify(event)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// SSE + permission policy
// ---------------------------------------------------------------------------

async function openSse(server, signal) {
  const res = await fetch(`http://127.0.0.1:${server.port}/event`, {
    headers: { ...authHeader(server), accept: "text/event-stream" },
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`SSE connect failed: HTTP ${res.status}`);
  return sseEvents(res);
}

async function* sseEvents(res) {
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trimEnd();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      try {
        yield JSON.parse(line.slice(5).trim());
      } catch {
        // partial or non-JSON frame; ignore
      }
    }
  }
}

function eventSession(event) {
  const p = event?.properties ?? {};
  return (
    p.sessionID ??
    p.info?.sessionID ??
    p.part?.sessionID ??
    p.permission?.sessionID ??
    p.request?.sessionID ??
    null
  );
}

function permissionInfo(event) {
  const p = event?.properties ?? {};
  const perm = p.permission ?? p.request ?? p;
  return {
    id: perm.id ?? perm.requestID ?? p.id ?? null,
    label: String(perm.type ?? perm.action ?? perm.permission ?? perm.title ?? "unknown").toLowerCase(),
  };
}

export function decidePermission() {
  return "once";
}

/**
 * Accumulate token usage from an array of SSE events.
 *
 * @param {Array<object>} events  Raw event objects (as yielded by the SSE stream).
 * @returns {{ available: boolean, input?: number, output?: number, reasoning?: number,
 *             cacheRead?: number, cacheWrite?: number, cost?: number, model?: string }}
 *
 * Per-message usage (`message.updated`) is summed for per-job accuracy even when
 * a session is reused across jobs.  Falls back to session-level deltas when no
 * per-message data exists.
 */
export function accumulateUsage(events) {
  const messages = new Map(); // msg id → info (latest update per message)
  let firstSession = null;
  let lastSession = null;

  for (const event of events) {
    if (!event || !event.type) continue;
    const props = event.properties || {};

    if (event.type === "message.updated") {
      const info = props.info;
      if (info && info.id && info.tokens) {
        messages.set(info.id, info);
      }
    } else if (event.type === "session.updated") {
      const info = props.info;
      if (info && info.tokens) {
        if (!firstSession) firstSession = info;
        lastSession = info;
      }
    }
  }

  // No usage data observed at all.
  if (messages.size === 0 && !firstSession) {
    return { available: false };
  }

  // Prefer per-message aggregation (accurate per-job when session is reused).
  if (messages.size > 0) {
    let input = 0;
    let output = 0;
    let reasoning = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let cost = 0;
    let model = null;

    for (const info of messages.values()) {
      const t = info.tokens || {};
      input += t.input || 0;
      output += t.output || 0;
      reasoning += t.reasoning || 0;
      if (t.cache) {
        cacheRead += t.cache.read || 0;
        cacheWrite += t.cache.write || 0;
      }
      cost += info.cost || 0;
      if (!model && info.modelID && info.providerID) {
        model = `${info.providerID}/${info.modelID}`;
      }
    }

    return {
      available: true,
      input,
      output,
      reasoning,
      cacheRead,
      cacheWrite,
      cost,
      model,
    };
  }

  // Fallback: session-level delta (less accurate when session was reused).
  if (firstSession && lastSession && firstSession !== lastSession) {
    const firstT = firstSession.tokens || {};
    const lastT = lastSession.tokens || {};
    const input = (lastT.input || 0) - (firstT.input || 0);
    const output = (lastT.output || 0) - (firstT.output || 0);
    const reasoning = (lastT.reasoning || 0) - (firstT.reasoning || 0);
    let cacheRead = 0;
    let cacheWrite = 0;
    if (lastT.cache && firstT.cache) {
      cacheRead = (lastT.cache.read || 0) - (firstT.cache.read || 0);
      cacheWrite = (lastT.cache.write || 0) - (firstT.cache.write || 0);
    }
    const cost = (lastSession.cost || 0) - (firstSession.cost || 0);
    let model = null;
    if (lastSession.model) {
      model = `${lastSession.model.providerID}/${lastSession.model.id}`;
    }

    return {
      available: true,
      input,
      output,
      reasoning,
      cacheRead,
      cacheWrite,
      cost,
      model,
    };
  }

  // Single session.updated with no messages — cannot compute delta.
  return { available: false };
}

// ---------------------------------------------------------------------------
// prompt execution
// ---------------------------------------------------------------------------

async function fetchFinalMessage(server, sessionID) {
  const messages = (await api(server, "GET", `/session/${sessionID}/message`)) ?? [];
  const assistant = [...messages].reverse().find((m) => (m.info?.role ?? m.role) === "assistant");
  if (!assistant) return "";
  const parts = assistant.parts ?? [];
  return parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join("\n")
    .trim();
}

async function runPrompt({ cwd, kind, title, promptText, agent, model, session, tools, format, timeoutS, watchdogS, phase }) {
  const server = await ensureServer(cwd);
  const { stateDir } = server;

  let sessionID = session;
  if (!sessionID) {
    const created = await api(server, "POST", "/session", { title });
    sessionID = created?.id ?? created?.info?.id;
    if (!sessionID) throw new Error("failed to create opencode session");
  }

  const job = {
    id: newJobId(),
    kind,
    title,
    status: "running",
    sessionID,
    cwd,
    phase: phase ?? null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    stats: { events: 0, steps: 0, lastTool: null, permissionsAllowed: 0, permissionsRejected: 0, lastActivity: null, models: [] },
    error: null,
  };
  saveJob(stateDir, job);
  fs.writeFileSync(path.join(jobDir(stateDir, job.id), "prompt.md"), promptText, "utf8");

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), timeoutS * 1000);
  const replied = new Set();
  let sawIdle = false;
  let sessionError = null;
  let watchdogFired = false;
  let watchdogKilled = false;
  let watchdogInterval = null;

  if (watchdogS > 0) {
    watchdogInterval = setInterval(() => {
      if (watchdogFired) return;
      const lastActivity = job.stats.lastActivity ?? job.startedAt;
      const silenceMs = Date.now() - Date.parse(lastActivity);
      if (silenceMs > watchdogS * 1000) {
        watchdogFired = true;
        clearInterval(watchdogInterval);
        const silenceSec = Math.round(silenceMs / 1000);
        appendEvent(stateDir, job.id, { type: "companion.watchdog.fired", silenceS: silenceSec });
        (async () => {
          let abortOk = false;
          try {
            const r = await fetch(`http://127.0.0.1:${server.port}/session/${sessionID}/abort`, {
              method: "POST",
              headers: authHeader(server),
              signal: AbortSignal.timeout(2000),
            });
            abortOk = r.ok;
          } catch { /* abort attempt timed out or failed */ }
          let healthOk = false;
          try {
            const r = await fetch(`http://127.0.0.1:${server.port}/session`, {
              headers: authHeader(server),
              signal: AbortSignal.timeout(2000),
            });
            healthOk = r.ok;
          } catch { /* health check timed out or failed */ }
          if (!abortOk || !healthOk) {
            try { process.kill(server.pid, "SIGKILL"); } catch { /* best-effort */ }
            watchdogKilled = true;
            try { fs.unlinkSync(path.join(stateDir, "server.json")); } catch { /* best-effort */ }
            appendEvent(stateDir, job.id, { type: "companion.watchdog.kill" });
          }
          abort.abort();
        })();
      }
    }, 10000);
  }

  // Collect usage-related events for accumulateUsage.
  const usageEvents = [];

  // Connect SSE before sending the prompt so a fast-finishing session's
  // `session.idle` cannot slip past between POST and subscription.
  let markConnected;
  const sseConnected = new Promise((resolve) => {
    markConnected = resolve;
  });

  const watcher = (async () => {
    let backoff = 250;
    while (!abort.signal.aborted && !sawIdle && !sessionError) {
      try {
        const stream = await openSse(server, abort.signal);
        markConnected();
        backoff = 250;
        for await (const event of stream) {
          // Strict session match: events without a recognizable sessionID are
          // dropped so a stray server-level idle/error can't end this job.
          if (eventSession(event) !== sessionID) continue;
          job.stats.events += 1;
          job.stats.lastActivity = new Date().toISOString();
          const type = String(event?.type ?? "");
          appendEvent(stateDir, job.id, event);

          // Harvest usage-relevant events for post-job accumulation.
          if (type === "message.updated" || type === "session.updated") {
            usageEvents.push(event);
          }

          if (type.startsWith("permission.") && type.endsWith("asked")) {
            const { id, label } = permissionInfo(event);
            if (id && !replied.has(id)) {
              replied.add(id);
              const reply = decidePermission();
              try {
                await api(server, "POST", `/permission/${id}/reply`, { reply });
                appendEvent(stateDir, job.id, { type: "companion.permission.reply", permission: label, reply });
                if (reply === "reject") job.stats.permissionsRejected += 1;
                else job.stats.permissionsAllowed += 1;
              } catch (err) {
                // Un-mark so a re-broadcast of the same ask can be retried.
                replied.delete(id);
                appendEvent(stateDir, job.id, {
                  type: "companion.permission.reply-failed",
                  permission: label,
                  reply,
                  error: String(err),
                });
              }
            }
          } else if (type === "message.part.updated") {
            const part = event?.properties?.part;
            if (part?.type === "tool" && part?.tool) {
              job.stats.lastTool = part.tool;
            } else if (part?.type === "step-start") {
              job.stats.steps += 1;
            }
          } else if (type === "message.updated") {
            const info = event?.properties?.info;
            if (info?.role === "assistant" && info?.providerID && info?.modelID) {
              const m = `${info.providerID}/${info.modelID}`;
              if (!job.stats.models.includes(m)) job.stats.models.push(m);
            }
          } else if (type === "session.idle") {
            sawIdle = true;
          } else if (type === "session.error") {
            sessionError = JSON.stringify(event?.properties?.error ?? event?.properties ?? {}).slice(0, 500);
          }
          saveJob(stateDir, job);
          if (sawIdle || sessionError) break;
        }
      } catch (err) {
        if (abort.signal.aborted) break;
        appendEvent(stateDir, job.id, { type: "companion.sse.reconnect", error: String(err), backoff });
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 10_000);
      }
    }
  })();

  try {
    await Promise.race([sseConnected, new Promise((r) => setTimeout(r, 5000))]);
    await api(server, "POST", `/session/${sessionID}/prompt_async`, {
      parts: [{ type: "text", text: promptText }],
      ...(agent ? { agent } : {}),
      ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
      ...(model?.variant ? { variant: model.variant } : {}),
      ...(tools ? { tools } : {}),
      ...(format ? { format } : {}),
    });
    await watcher;
  } finally {
    clearTimeout(timeout);
    clearInterval(watchdogInterval);
    abort.abort();
  }

  if (watchdogFired) {
    job.status = "stalled";
    job.error = `watchdog: no events for ${watchdogS}s` + (watchdogKilled ? " (process killed)" : "");
  } else if (abort.signal.aborted && !sawIdle && !sessionError) {
    job.status = "timeout";
    job.error = `timed out after ${timeoutS}s`;
    await api(server, "POST", `/session/${sessionID}/abort`).catch(() => {});
  } else if (sessionError) {
    job.status = "error";
    job.error = sessionError;
  } else {
    job.status = "completed";
  }
  job.finishedAt = new Date().toISOString();

  // ---- accumulate and persist usage ----
  const usage = {
    ...accumulateUsage(usageEvents),
    phase: job.phase || null,
    durationSeconds: durationS(job),
  };
  job.usage = usage;
  writeJson(path.join(jobDir(stateDir, job.id), "usage.json"), usage);

  let resultText = "";
  if (job.status === "completed") {
    resultText = await fetchFinalMessage(server, sessionID).catch(() => "");
    fs.writeFileSync(path.join(jobDir(stateDir, job.id), "result.md"), resultText, "utf8");
  }
  saveJob(stateDir, job);
  return { job, resultText, stateDir };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function durationS(job) {
  if (!job.startedAt) return "?";
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  return Math.round((end - Date.parse(job.startedAt)) / 1000);
}

function renderHeader(job) {
  const usageLine = (() => {
    const u = job.usage;
    if (!u || !u.available) return [];
    const parts = [`${u.input} in / ${u.output} out`];
    if (u.reasoning) parts.push(`${u.reasoning} reasoning`);
    return [`tokens: ${parts.join(", ")}`];
  })();
  return [
    `opencode ${job.kind} ${job.id} — ${job.status} (${durationS(job)}s)`,
    `session: ${job.sessionID} (continue in opencode: \`opencode -s ${job.sessionID}\`)`,
    ...(job.phase ? [`phase: ${job.phase}`] : []),
    ...(job.stats?.models?.length ? [`model: ${job.stats.models.join(" → ")}`] : []),
    ...usageLine,
    "",
  ].join("\n");
}

/**
 * Render a single job line for the status listing (one-liner).
 * Includes an "orch=<model>" suffix when the job has orchestrator data.
 *
 * @param {object} job - A job record from listJobs / loadJob.
 * @returns {string} A single-line formatted job summary.
 */
export function renderJobLine(job) {
  const orch = job.orchestrator?.model ? ` orch=${job.orchestrator.model}` : "";
  return `${job.id}  ${job.kind.padEnd(6)}  ${job.status.padEnd(9)}  ${durationS(job)}s${orch}  ${job.title ?? ""}`;
}

export function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function renderReview(parsed, rawText) {
  if (!parsed) {
    const lines = rawText.split("\n").filter((l) => l.trim() !== "");
    const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : "";
    const tokenMatch = lastLine.match(/^VERDICT:\s*(approve-partial|approve|needs-attention|discard)\s*$/i);
    if (tokenMatch) {
      const verdict = tokenMatch[1].toLowerCase();
      return `**Verdict: ${verdict}** (recovered from terminal token; JSON malformed)\n\n${rawText}`;
    }
    return `(review output was not valid JSON; raw output below)\n\n${rawText}`;
  }
  const lines = [`**Verdict: ${parsed.verdict}**`, "", parsed.summary, ""];
  const findings = parsed.findings ?? [];
  if (findings.length === 0) {
    lines.push("No material findings.");
  }
  findings.forEach((f, i) => {
    lines.push(
      `### ${i + 1}. [${f.severity}] ${f.title}`,
      `- ${f.file}:${f.line_start}-${f.line_end} (confidence ${f.confidence})`,
      "",
      f.body,
      "",
      `**Recommendation:** ${f.recommendation}`,
      "",
    );
  });
  const next = parsed.next_steps ?? [];
  if (next.length) {
    lines.push("**Next steps:**");
    next.forEach((s) => lines.push(`- ${s}`));
  }
  const unverified = parsed.unverified ?? [];
  if (unverified.length) {
    lines.push("", "**Unverified:**");
    unverified.forEach((s) => lines.push(`- ${s}`));
  }
  return lines.join("\n");
}

/**
 * Render a compact plain-text digest of a chain for the orchestrator.
 * Pure function: takes chain data and round records, returns formatted string.
 * Never throws on absent fields — missing optional fields are simply omitted.
 *
 * @param {object|null} chain - Parsed chain.json object (may have partial fields)
 * @param {Array<object>} rounds - Parsed round-N.json objects (sorted by round number)
 * @returns {string} Formatted digest
 */
export function renderChainShow(chain, rounds, unreadable = []) {
  const lines = [];
  // Tolerate null/undefined rounds — treat as empty
  const safeRounds = rounds ?? [];

  // Header
  lines.push(`chain: ${chain?.chainId || "(unknown)"}`);
  // Corrupt round records must be surfaced, never silently omitted —
  // a digest that hides evidence defeats its purpose.
  if (unreadable.length > 0) {
    lines.push(`!! unreadable round records (excluded below): ${unreadable.join(", ")}`);
  }

  // Status/outcome
  const lastRound = safeRounds.length > 0 ? safeRounds[safeRounds.length - 1] : null;
  if (lastRound?.disposition?.disposition === "accept") {
    lines.push(`status: accepted at round ${lastRound.round}`);
  } else if (lastRound?.disposition?.disposition === "escalate") {
    lines.push(`status: escalated at round ${lastRound.round} (${lastRound.disposition.reason || "unknown"})`);
  } else {
    lines.push("status: incomplete");
  }

  // Orchestrator model when present
  if (chain?.orchestrator?.model) {
    lines.push(`orchestrator: ${chain.orchestrator.model}`);
  }

  // Brief first line only (the full brief can be read from chain.json)
  if (chain?.brief) {
    const briefLine = chain.brief.split("\n")[0].trim();
    lines.push(`brief: ${briefLine.slice(0, 80)}${briefLine.length > 80 ? "..." : ""}`);
  }

  // Container if recorded
  if (chain?.container) {
    lines.push(`container: ${chain.container}`);
  }

  lines.push("");

  // Per round
  for (const round of safeRounds) {
    lines.push(`Round ${round.round}`);

    // Model entry(+variant)
    if (round.modelEntry) {
      lines.push(`  model: ${round.modelEntry}`);
    }

    // Verdict
    if (round.verdict) {
      lines.push(`  verdict: ${round.verdict}`);
    }

    // Disposition + reason
    if (round.disposition) {
      const disp = round.disposition.disposition || "unknown";
      const reason = round.disposition.reason ? ` (${round.disposition.reason})` : "";
      lines.push(`  disposition: ${disp}${reason}`);
    }

    // Resume method
    if (round.resumeMethod) {
      const resumeType = round.resumeMethod.type || "unknown";
      const resumeDetail = round.resumeMethod.detail ? `: ${round.resumeMethod.detail}` : "";
      lines.push(`  resume: ${resumeType}${resumeDetail}`);
    }

    // Probe results
    const probes = round.probeResults || [];
    if (probes.length > 0) {
      for (const probe of probes) {
        const status = probe.passed ? "PASS" : "FAIL";
        let detailSuffix = "";
        if (probe.detail) {
          let parsed = null;
          try { parsed = JSON.parse(probe.detail); } catch { /* plain text */ }
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            // JSON detail: extract structured fields
            const parts = [];
            if (parsed.gate_passed !== undefined) {
              parts.push(`gate_passed=${parsed.gate_passed}`);
            }
            if (parsed.diff_summary && typeof parsed.diff_summary === "object") {
              const ds = parsed.diff_summary;
              const countParts = [];
              if (ds.changed_files !== undefined) countParts.push(`changed=${ds.changed_files}`);
              if (ds.untracked !== undefined) countParts.push(`untracked=${ds.untracked}`);
              if (countParts.length > 0) parts.push(countParts.join(", "));
            }
            if (parts.length > 0) {
              detailSuffix = ` (${parts.join(", ")})`;
            }
          } else {
            // Plain text: show as-is, truncated for long strings
            const text = String(probe.detail);
            const truncated = text.length > 150 ? text.slice(0, 150) + "..." : text;
            detailSuffix = ` (${truncated})`;
          }
        }
        lines.push(`    ${probe.probe || "probe"} — ${status}${detailSuffix}`);
      }
    }

    // findingsText verbatim, untruncated
    if (round.findingsText) {
      lines.push(`  findings:`);
      const findingLines = round.findingsText.split("\n");
      for (const fl of findingLines) {
        // Indent each finding line with two spaces
        lines.push(`  ${fl}`);
      }
    }

    // Implement usage
    if (round.implementUsage?.available) {
      const u = round.implementUsage;
      const parts = [`implement: ${u.input || 0} in / ${u.output || 0} out`];
      if (u.reasoning) parts.push(`${u.reasoning} reasoning`);
      if (u.cost !== undefined) parts.push(`cost=$${u.cost}`);
      lines.push(`  ${parts.join(", ")}`);
    }

    // Review usage
    if (round.reviewUsage?.available) {
      const u = round.reviewUsage;
      const parts = [`review: ${u.input || 0} in / ${u.output || 0} out`];
      if (u.reasoning) parts.push(`${u.reasoning} reasoning`);
      if (u.cost !== undefined) parts.push(`cost=$${u.cost}`);
      lines.push(`  ${parts.join(", ")}`);
    }

    lines.push("");
  }

  // Chain-wide totals
  if (chain?.chainTotals) {
    const t = chain.chainTotals;
    const parts = [`totals: ${t.input || 0} in / ${t.output || 0} out`];
    if (t.reasoning) parts.push(`${t.reasoning} reasoning`);
    if (t.cacheRead !== undefined || t.cacheWrite !== undefined) {
      parts.push(`cacheRead=${t.cacheRead || 0} cacheWrite=${t.cacheWrite || 0}`);
    }
    if (t.cost !== undefined) parts.push(`cost=$${t.cost}`);
    lines.push(parts.join(", "));
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// git context for review
// ---------------------------------------------------------------------------

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    return `(git ${args.join(" ")} failed: ${String(err.message).slice(0, 200)})\n`;
  }
}

function buildReviewInput(cwd, base) {
  let label;
  let diff;
  if (base) {
    label = `branch diff against ${base}`;
    diff = git(cwd, ["diff", `${base}...HEAD`]);
  } else {
    label = "uncommitted working tree changes";
    diff = git(cwd, ["diff", "HEAD"]) + git(cwd, ["diff", "--cached"]);
  }
  const status = git(cwd, ["status", "--short", "--untracked-files=all"]);
  let truncated = "";
  if (diff.length > REVIEW_DIFF_LIMIT) {
    diff = diff.slice(0, REVIEW_DIFF_LIMIT);
    truncated = "\n(diff truncated; use the read tools to inspect files directly)";
  }
  const input = `## git status\n${status}\n## diff (${label})\n${diff}${truncated}`;
  return { label, input };
}

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const flags = {};
  const rest = [];
  let literal = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (literal) {
      rest.push(arg);
    } else if (arg === "--") {
      literal = true;
    } else if (
      arg === "--auto" || arg === "--read-only" || arg === "--resume-last" ||
      arg === "--wait" || arg === "--background" || arg === "--keep-serve" || arg === "--help" || arg === "-h" ||
      arg === "--tools"
    ) {
      const key = arg.startsWith("--")
        ? arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        : arg.slice(1);
      flags[key] = true;
    } else if (arg === "--base" || arg === "--model" || arg === "--agent" || arg === "--session" || arg === "--timeout" || arg === "--deny" || arg === "--watchdog" || arg === "--phase" || arg === "--container" || arg === "--prior" || arg === "--max-rounds" || arg === "--brief-file" || arg === "--last" || arg === "--quote") {
      const flagName = arg.slice(2);
      const val = argv[++i];
      if (val === undefined || (typeof val === "string" && val.startsWith("--"))) {
        throw new Error(`${arg} requires a value`);
      }
      flags[flagName] = val;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      rest.push(arg);
    }
  }
  return { flags, text: rest.join(" ").trim() };
}

export function parseModel(value) {
  if (!value) return undefined;
  const idx = value.indexOf("/");
  if (idx < 0) throw new Error(`--model expects provider/model, got: ${value}`);
  const providerID = value.slice(0, idx);
  let modelID = value.slice(idx + 1);
  let variant;
  const vi = modelID.indexOf(":");
  if (vi >= 0) {
    variant = modelID.slice(vi + 1);
    modelID = modelID.slice(0, vi);
    if (!variant) throw new Error(`empty variant in model entry: ${value}`);
  }
  return { providerID, modelID, ...(variant ? { variant } : {}) };
}

// ---------------------------------------------------------------------------
// config loading & model resolution
// ---------------------------------------------------------------------------

const BUILTIN_DEFAULT_CHAIN = [
  "opencode/deepseek-v4-flash-free",
  "opencode-go/deepseek-v4-flash",
  "opencode-go/deepseek-v4-pro",
];

/**
 * Load the kusabi config file from the state root.
 * @param {string} stateRootDir - The state root directory (e.g. ~/.kusabi)
 * @returns {object|null} Config object or null if the file does not exist.
 * @throws {Error} If the file exists but is unparseable or has wrong shape.
 */
export function loadConfig(stateRootDir) {
  const configPath = path.join(stateRootDir, "config.json");
  if (!fs.existsSync(configPath)) return null;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new Error(`kusabi config file ${configPath} is not valid JSON: ${err.message}`);
  }

  // Validate shape: must be an object with an optional "models" key
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`kusabi config file ${configPath} must contain a JSON object`);
  }

  const models = parsed.models;
  if (models !== undefined) {
    if (typeof models !== "object" || Array.isArray(models) || models === null) {
      throw new Error(`kusabi config file ${configPath}: "models" must be a JSON object`);
    }
    if (models.chain !== undefined) {
      if (!Array.isArray(models.chain) || !models.chain.every((m) => typeof m === "string")) {
        throw new Error(`kusabi config file ${configPath}: "models.chain" must be an array of strings`);
      }
      if (models.chain.length === 0) {
        throw new Error(`kusabi config file ${configPath}: "models.chain" must not be empty (omit it to use the built-in default chain)`);
      }
    }
    if (models.phases !== undefined) {
      if (typeof models.phases !== "object" || Array.isArray(models.phases) || models.phases === null) {
        throw new Error(`kusabi config file ${configPath}: "models.phases" must be a JSON object`);
      }
      for (const [phaseName, chain] of Object.entries(models.phases)) {
        if (!Array.isArray(chain) || !chain.every((m) => typeof m === "string")) {
          throw new Error(`kusabi config file ${configPath}: "models.phases.${phaseName}" must be an array of strings`);
        }
        if (chain.length === 0) {
          throw new Error(`kusabi config file ${configPath}: "models.phases.${phaseName}" must not be empty (omit it to fall back to the global chain)`);
        }
      }
    }
  }

  return parsed;
}

/**
 * Resolve the model for a dispatch based on precedence:
 *   1. explicit --model flag
 *   2. per-phase chain first entry
 *   3. global chain first entry
 *   4. built-in default chain first entry
 *
 * Returns the full ordered chain (array of "provider/model" strings).
 *
 * @param {object} opts
 * @param {string|undefined} opts.flag  - Raw --model flag value (e.g. "anthropic/claude-4")
 * @param {string|undefined} opts.phase - Phase name (e.g. "implement")
 * @param {object|null}      opts.config - Parsed config object or null
 * @returns {{ model: { providerID: string, modelID: string } | undefined, chain: string[] }}
 */
export function resolveModel({ flag, phase, config }) {
  // Determine the full ordered chain
  let chain;
  if (config?.models?.chain) {
    chain = [...config.models.chain];
  } else {
    chain = [...BUILTIN_DEFAULT_CHAIN];
  }

  // If we have an explicit --model flag, use it directly
  if (flag) {
    return { model: parseModel(flag), chain };
  }

  // Per-phase override
  if (phase && config?.models?.phases?.[phase]) {
    const phaseChain = config.models.phases[phase];
    const first = phaseChain[0];
    if (first) {
      return { model: parseModel(first), chain: phaseChain };
    }
  }

  // Global chain first entry
  const firstGlobal = chain[0];
  if (firstGlobal) {
    return { model: parseModel(firstGlobal), chain };
  }

  // No model resolved
  return { model: undefined, chain };
}

/**
 * Read the brief text from a file or return the inline text.
 * Throws a clear error when `--brief-file` and inline text are both provided,
 * or when the file cannot be read.
 *
 * @param {object} flags  - Parsed flags from parseArgs (may contain "brief-file")
 * @param {string} text   - Inline text (may be empty)
 * @returns {string} The resolved brief text.
 */
export function readBriefFile(flags, text) {
  if (flags["brief-file"]) {
    if (text) throw new Error("--brief-file and inline text are mutually exclusive");
    try {
      return fs.readFileSync(flags["brief-file"], "utf8").trim();
    } catch (err) {
      throw new Error(`--brief-file: cannot read ${flags["brief-file"]}: ${err.message}`);
    }
  }
  return text;
}

/**
 * Parse an optional orchestrator signature line from a brief text.
 * Scans the first 5 lines for a line starting with "Orchestrator:"
 * and extracts model, session, and date fields.
 *
 * @param {string} briefText  - The full brief text.
 * @returns {{ model: string|null, session: string|null, date: string|null } | null}
 *   Parsed fields (null for missing parts) or null when no signature exists.
 *   Never throws on malformed input.
 */
export function parseOrchestratorSignature(briefText) {
  if (!briefText || typeof briefText !== "string") return null;
  const lines = briefText.split("\n");
  const maxLines = Math.min(lines.length, 5);
  for (let i = 0; i < maxLines; i++) {
    const line = lines[i];
    if (typeof line !== "string") continue;
    const trimmed = line.trim();
    if (trimmed.startsWith("Orchestrator:")) {
      const remainder = trimmed.slice("Orchestrator:".length).trim();
      // Split on |, trim each part
      const parts = remainder.split("|").map((s) => s.trim());
      const model = parts[0] || null;
      let session = parts[1] || null;
      // Strip optional "session " prefix
      if (session && session.startsWith("session ")) {
        session = session.slice("session ".length).trim();
        if (session === "") session = null;
      }
      const date = parts[2] || null;
      return { model, session, date };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// parseDeliverables — pure function parsing ## Deliverables section from a
// brief text.  Exported for testing.
// ---------------------------------------------------------------------------

/**
 * Parse an optional `## Deliverables` section from a brief text.
 *
 * Section = lines after a `## Deliverables` heading up to the next `## `
 * heading or EOF.  From each bullet line (`- ` or `* `), extract the file
 * path: the first backtick-quoted token if present, else the first
 * whitespace-delimited token.  Strip surrounding backticks and trailing
 * punctuation.  Ignore bullet lines that yield nothing.
 *
 * @param {string|null|undefined} briefText  The full brief text.
 * @returns {string[]}  Repo-relative path strings; [] when section absent or empty.
 *                      Never throws.
 */
export function parseDeliverables(briefText) {
  if (!briefText || typeof briefText !== "string") return [];
  const lines = briefText.split("\n");
  let inSection = false;
  const deliverables = [];
  for (let li = 0; li < lines.length; li++) {
    const trimmed = lines[li].trim();
    if (trimmed.startsWith("## ")) {
      const heading = trimmed.slice(3).trim();
      if (heading === "Deliverables") {
        inSection = true;
        continue;
      }
      if (inSection) break; // next heading ends the section
      continue;
    }
    if (!inSection) continue;

    // Bullet line?
    const bulletMatch = trimmed.match(/^[-*]\s+(.*)/);
    if (!bulletMatch) continue;
    const content = bulletMatch[1].trim();
    if (!content) continue;

    // First backtick-quoted token, else first whitespace-delimited token
    let path = null;
    const backtickMatch = content.match(/`([^`]+)`/);
    if (backtickMatch) {
      path = backtickMatch[1];
    } else {
      const tokens = content.split(/\s+/);
      path = tokens[0];
    }
    if (!path) continue;

    // Strip trailing punctuation
    path = path.replace(/[,;.:!?]+$/, "").trim();
    if (path) deliverables.push(path);
  }
  return deliverables;
}

/**
 * Parse paths from `git status --porcelain` output.
 * For rename entries both old and new paths are returned.
 *
 * @param {string} output  Raw stdout from `git status --porcelain`.
 * @returns {string[]}  Array of changed path strings.
 */
export function parseChangedPaths(output) {
  if (!output || typeof output !== "string") return [];
  const paths = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Skip the first 3 characters (XY status chars + space), rest is the path.
    const rest = line.length > 3 ? line.substring(3).trim() : "";
    if (!rest) continue;
    // Handle rename: "oldpath -> newpath"
    const arrowIdx = rest.indexOf(" -> ");
    if (arrowIdx >= 0) {
      const oldPath = rest.substring(0, arrowIdx).trim().replace(/\/+$/, "");
      const newPath = rest.substring(arrowIdx + 4).trim().replace(/\/+$/, "");
      if (oldPath) paths.push(oldPath);
      if (newPath) paths.push(newPath);
    } else {
      // Untracked directories appear as "dir/"; strip the trailing slash so
      // prefix matching against declared deliverables works.
      const cleaned = rest.replace(/\/+$/, "");
      if (cleaned) paths.push(cleaned);
    }
  }
  return paths;
}

/**
 * Pure function: determine the P3 (deliverables) probe outcome from declared
 * deliverables and the actual changed paths.
 *
 * @param {string[]} deliverables  Declared deliverable paths (parseDeliverables output).
 * @param {string[]} changedPaths  Actual changed paths from git status --porcelain.
 * @returns {{ probe: string, passed: boolean, detail: string }}
 */
export function checkDeliverablesProbe(deliverables, changedPaths) {
  const probe = "P3: deliverables";
  // Defensive: ensure array inputs
  const delArr = Array.isArray(deliverables) ? deliverables : [];
  const chArr = Array.isArray(changedPaths) ? changedPaths : [];
  // No deliverables declared → trivially pass
  if (delArr.length === 0) {
    return { probe, passed: true, detail: "no Deliverables declared; check skipped" };
  }
  // Change set empty
  if (chArr.length === 0) {
    return {
      probe,
      passed: false,
      detail: "work set is empty; declared deliverables: " + delArr.join(", "),
    };
  }
  // Check if at least one declared path is touched
  const touched = delArr.some(function (d) {
    return chArr.some(function (cp) {
      // Equal path, or changed path is inside a declared directory
      return cp === d || cp.startsWith(d + "/") || d.startsWith(cp + "/");
    });
  });
  if (touched) {
    return { probe, passed: true, detail: "touches declared deliverables" };
  }
  const delStr = delArr.join(", ");
  const chStr = chArr.join(", ");
  return {
    probe,
    passed: false,
    detail: "no declared deliverable touched; deliverables: [" + delStr + "]; changed: [" + chStr + "]",
  };
}

// ---------------------------------------------------------------------------
// deriveDisposition — pure function mapping review + probe results to
// chain disposition.  Exported for testing.
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {"approve"|"approve-partial"|"needs-attention"|"discard"} opts.verdict
 * @param {boolean} opts.probesGreen  — all deterministic probes passed
 * @param {number}  opts.round        — 1-based current round number
 * @param {number}  opts.maxRounds
 * @param {boolean} opts.repeatedAreas — same file area flagged 2+ rounds
 * @returns {{ disposition: "accept"|"rework"|"escalate", reason?: string }}
 */
export function deriveDisposition({ verdict, probesGreen, round, maxRounds, repeatedAreas }) {
  // Hard limit: max rounds reached without acceptance → escalate
  if (round >= maxRounds && verdict !== "approve") {
    return { disposition: "escalate", reason: `max rounds (${maxRounds}) reached without acceptance` };
  }

  if (verdict === "approve" && probesGreen) {
    return { disposition: "accept" };
  }

  // All other cases have a reason
  let disposition;
  let reason;

  switch (verdict) {
    case "approve":
      disposition = "rework";
      reason = "deterministic probes failed";
      break;

    case "approve-partial":
      disposition = "escalate";
      reason = "approve-partial: unverified items remain";
      break;

    case "needs-attention": {
      if (repeatedAreas) {
        disposition = "escalate";
        reason = "same file area flagged for two consecutive rounds";
      } else {
        disposition = "rework";
        reason = "needs-attention";
      }
      break;
    }

    case "discard":
      disposition = "escalate";
      reason = "reviewer discarded the work";
      break;

    default:
      disposition = "escalate";
      reason = `unexpected verdict: ${verdict}`;
      break;
  }

  return { disposition, reason };
}

// ---------------------------------------------------------------------------
// shouldReapServer — pure function: decide whether an idle serve should be
// killed based on job statuses and last-activity timestamps.  Exported for
// testing.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// explain helpers — pure functions, exported for testing
// ---------------------------------------------------------------------------

/**
 * Convert an absolute path to the Claude Code directory slug format.
 * Replaces `/` and `.` with `-`.
 * @param {string} cwd - Absolute working directory path
 * @returns {string} Slug, e.g. "/home/u/dev/x" -> "-home-u-dev-x"
 */
export function cwdSlug(cwd) {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Find the newest `*.jsonl` file under `<baseDir>/<cwdSlug>/`.
 * @param {{ baseDir: string, cwdSlug: string }} opts
 * @returns {string|null} Absolute path to the newest JSONL file, or null if none found.
 */
export function findTranscriptFile({ baseDir, cwdSlug: slug }) {
  const dir = path.join(baseDir, slug);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter(function (f) { return f.endsWith(".jsonl"); })
    .map(function (f) {
      const fullPath = path.join(dir, f);
      try {
        return { name: f, mtime: fs.statSync(fullPath).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort(function (a, b) {
      const mtimeDiff = b.mtime - a.mtime;
      if (mtimeDiff !== 0) return mtimeDiff;
      // Tiebreak: lexicographic by name for deterministic selection
      return a.name.localeCompare(b.name);
    });
  return files.length > 0 ? path.join(dir, files[0].name) : null;
}

/**
 * Parse JSONL records from a transcript file.
 * @param {string} filePath
 * @returns {Array<object>}
 */
function parseTranscript(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  return content
    .split("\n")
    .filter(function (line) { return line.trim() !== ""; })
    .map(function (line) { return JSON.parse(line); });
}

/**
 * Extract text passages from the last N assistant (and optionally user)
 * messages in transcript records, excluding tool_use / tool_result / thinking
 * blocks by default.
 *
 * @param {Array<object>} records  - Parsed JSONL records from a transcript.
 * @param {object}        [opts]
 * @param {number}        [opts.lastN=1]         - How many assistant messages to include.
 * @param {boolean}       [opts.includeTools=false] - Also include tool_result blocks.
 * @returns {string} Concatenated text, trimmed.
 */
export function extractAssistantText(records, { lastN = 1, includeTools = false } = {}) {
  // Walk backwards to find indices of the last N assistant records that
  // actually carry a text block.  In real transcripts each content block is
  // its own record, so the trailing assistant records of an in-progress turn
  // are tool_use-only and must be skipped, not treated as "no text found".
  const assistantIndices = [];
  for (let i = records.length - 1; i >= 0 && assistantIndices.length < lastN; i--) {
    if (records[i].type !== "assistant") continue;
    const content = records[i].message?.content;
    if (!Array.isArray(content)) continue;
    if (content.some(function (b) { return b.type === "text" && b.text; })) {
      assistantIndices.unshift(i);
    }
  }

  if (assistantIndices.length === 0) return "";

  // Collect records from the first selected assistant message onward so that
  // interleaved user messages are also included.
  const startIdx = assistantIndices[0];
  const relevantRecords = records.slice(startIdx);

  const parts = [];
  for (let ri = 0; ri < relevantRecords.length; ri++) {
    const record = relevantRecords[ri];
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (let bi = 0; bi < content.length; bi++) {
      const block = content[bi];
      if (block.type === "text" && block.text) {
        parts.push(block.text);
      } else if (includeTools && block.type === "tool_result") {
        // Real transcripts carry the payload in block.content as a string or
        // an array of {type:"text", text} items; block.text is a fallback.
        const payload = block.content;
        if (typeof payload === "string") {
          parts.push(payload);
        } else if (Array.isArray(payload)) {
          for (const item of payload) {
            if (item && item.type === "text" && item.text) parts.push(item.text);
          }
        } else if (block.text != null) {
          parts.push(block.text);
        }
      }
    }
  }

  return parts.join("\n").trim();
}

/**
 * Resolve the passage to explain: either an explicit `--quote`, or the
 * last assistant text block extracted from the Claude Code session
 * transcript under `<baseDir>/<cwdSlug>/`.
 *
 * Throws a clear error when the transcript is missing, unreadable, empty,
 * or contains no assistant text.  The CLI entry point translates these to
 * non-zero exit.
 *
 * @param {object} opts
 * @param {string}        opts.baseDir - Base directory (e.g. ~/.claude/projects)
 * @param {string}        opts.cwd     - Current working directory
 * @param {string|undefined} opts.quote  - Explicit passage (--quote flag)
 * @param {number}        opts.last    - Positive integer (--last N, default 1)
 * @param {boolean}       opts.tools   - Include tool results (--tools flag)
 * @returns {{ passage: string, source: "quote" | "transcript" }}
 */
export function resolveExplainPassage({ baseDir, cwd, quote, last = 1, tools = false }) {
  // Validate --last: must be a positive integer
  if (!Number.isFinite(last) || last < 1 || !Number.isInteger(last)) {
    throw new Error(`--last must be a positive integer, got: ${String(last)}`);
  }

  if (quote !== undefined) {
    if (quote.trim() === "") {
      throw new Error("--quote must not be empty");
    }
    return { passage: quote, source: "quote" };
  }

  const slug = cwdSlug(cwd);
  const transcriptFile = findTranscriptFile({ baseDir, cwdSlug: slug });

  if (!transcriptFile) {
    throw new Error(
      `No Claude Code transcript found for this directory. ` +
      `Expected a *.jsonl file under ${path.join(baseDir, slug)}. ` +
      `Claude Code may not have created a session transcript yet.`
    );
  }

  let records;
  try {
    records = parseTranscript(transcriptFile);
  } catch (err) {
    throw new Error(`Failed to read transcript ${transcriptFile}: ${err.message}`);
  }

  if (records.length === 0) {
    throw new Error(`Transcript ${transcriptFile} is empty.`);
  }

  const passage = extractAssistantText(records, { lastN: last, includeTools: tools });

  if (!passage) {
    throw new Error(
      `No assistant text found in transcript ${transcriptFile}. ` +
      `The session may not contain any assistant responses yet.`
    );
  }

  return { passage, source: "transcript" };
}

// ---------------------------------------------------------------------------
// subcommands
// ---------------------------------------------------------------------------

async function cmdSetup(cwd) {
  let version;
  try {
    version = execFileSync(opencodeBin(), ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return `opencode CLI not found. Install it first: https://opencode.ai (or set OPENCODE_BIN).`;
  }
  const server = await ensureServer(cwd);
  return [
    `opencode ${version} — OK`,
    `server: http://127.0.0.1:${server.port} (pid ${server.pid}, password-protected)`,
    `state dir: ${server.stateDir}`,
    cmdInstallAgents(),
  ].join("\n");
}

async function cmdTask(cwd, { flags, text }) {
  // ---- brief-file resolution ----
  text = readBriefFile(flags, text);
  if (!text) throw new Error("task requires a task description (inline or via --brief-file)");
  const orchestrator = parseOrchestratorSignature(text);
  let agent = flags.agent;
  let phase = null;
  if (flags.phase) {
    phase = flags.phase;
    if (!PHASE_AGENTS[phase]) {
      throw new Error(`unknown phase: ${phase}. Use draft|investigate|implement|review|respond`);
    }
    if (flags.agent) {
      throw new Error("--phase and --agent are mutually exclusive");
    }
    agent = PHASE_AGENTS[phase];
  }
  const stateDir = stateDirFor(cwd);
  const config = loadConfig(stateRoot());
  const resolved = resolveModel({ flag: flags.model, phase, config });
  const model = resolved.model;
  const modelChain = resolved.chain;

  let session = flags.session;
  if (!session && flags.resumeLast) {
    const prev = latestJob(stateDir, (j) => j.kind === "task" && (!phase || j.phase === phase));
    session = prev?.sessionID;
    if (!session) {
      throw new Error(phase
        ? `--resume-last: no previous ${phase} session found for this directory`
        : "--resume-last: no previous task session found for this directory");
    }
  }
  if (session && phase) {
    const owner = latestJob(stateDir, (j) => j.sessionID === session);
    if (owner && owner.phase && owner.phase !== phase) {
      throw new Error(`cross-phase session reuse is forbidden: session belongs to phase '${owner.phase}', requested '${phase}'`);
    }
  }
  let tools = flags.readOnly ? Object.fromEntries(WRITE_TOOL_NAMES.map((t) => [t, false])) : undefined;
  if (flags.deny) {
    tools = { ...(tools ?? {}) };
    for (const name of flags.deny.split(",").filter(Boolean)) tools[name] = false;
  }
  // ---- record baseSha before dispatching the job if --container (for probe comparison) ----
  let taskBaseSha = null;
  if (flags.container) {
    try {
      const { callTool } = await import("./sunaba-rpc.mjs");
      const gitRev = await callTool("sandbox_exec", {
        container_id: flags.container,
        commands: ["git rev-parse HEAD"],
      });
      taskBaseSha = (gitRev?.output ?? "").trim() || null;
    } catch { /* probe will handle missing baseSha */ }
  }

  const guardrails = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "task-guardrails.md"), "utf8").trim();
  const { job, resultText } = await runPrompt({
    cwd,
    kind: "task",
    title: text.slice(0, 80),
    promptText: `${guardrails}\n\n<task>\n${text}\n</task>`,
    agent,
    phase,
    model,
    session,
    tools,
    timeoutS: Number(flags.timeout ?? DEFAULT_TASK_TIMEOUT_S),
    watchdogS: Number(flags.watchdog ?? DEFAULT_WATCHDOG_S),
  });

  // Store the resolved model chain and orchestrator on the job record
  job.modelChain = modelChain;
  job.orchestrator = orchestrator;

  // ---- deterministic probes (when --container given) ----
  if (flags.container) {
    try {
      const { callTool } = await import("./sunaba-rpc.mjs");
      const container = flags.container;
      const probeResults = [];

      // P1: HEAD clean
      let p1Passed = false;
      let p1Detail = "";
      if (taskBaseSha) {
        const gitRev = await callTool("sandbox_exec", {
          container_id: container,
          commands: ["git rev-parse HEAD"],
        });
        const headSha = (gitRev?.output ?? "").trim();
        if (headSha !== taskBaseSha) {
          p1Detail = "HEAD " + headSha + " != base " + taskBaseSha + "; auto reset";
          try {
            await callTool("sandbox_exec", {
              container_id: container,
              commands: ["git reset --mixed " + taskBaseSha],
            });
            p1Passed = true;
            p1Detail += " - reset OK";
          } catch (resetErr) {
            p1Detail += " - reset FAILED: " + String(resetErr);
          }
        } else {
          p1Passed = true;
          p1Detail = "HEAD matches base " + taskBaseSha;
        }
      } else {
        p1Detail = "baseSha not recorded at task start; cannot check HEAD";
      }
      probeResults.push({ probe: "P1: HEAD clean", passed: p1Passed, detail: p1Detail });

      // P2: verify gate (no skip flags)
      const verifyResult = await callTool("verify_in_container", {
        container_id: container,
        path: ".",
      });
      const verifyPassed = verifyResult?.gate_passed === true;
      probeResults.push({ probe: "P2: verify gate", passed: verifyPassed, detail: JSON.stringify(verifyResult) });

      // P3: deliverables
      const deliverables = parseDeliverables(text);
      const statusResult = await callTool("sandbox_exec", {
        container_id: container,
        commands: ["git status --porcelain"],
      });
      const taskChangedPaths = parseChangedPaths(statusResult?.output ?? "");
      const p3Result = checkDeliverablesProbe(deliverables, taskChangedPaths);
      probeResults.push(p3Result);

      job.probeResults = probeResults;
      job.probesGreen = probeResults.every(function (p) { return p.passed; });
    } catch (probeErr) {
      job.probeResults = [{ probe: "task probes", passed: false, detail: String(probeErr) }];
      job.probesGreen = false;
    }
  }
  saveJob(stateDir, job);

  let taskOutput;
  if (job.status !== "completed") {
    taskOutput = `${renderHeader(job)}${job.error ?? ""}\nCheck /kusabi:status ${job.id} for details.`;
  } else {
    taskOutput = `${renderHeader(job)}${resultText || "(empty result)"}`;
  }

  // Append probe summary when --container
  if (job.probeResults && job.probeResults.length > 0) {
    taskOutput += "\n\nProbes:";
    for (const p of job.probeResults) {
      let detail = p.detail || "";
      if (detail.length > 300) detail = detail.slice(0, 300) + "...";
      taskOutput += "\n  " + p.probe + " — " + (p.passed ? "PASS" : "FAIL");
      if (detail) taskOutput += " (" + detail + ")";
    }
  }

  return taskOutput;
}

async function cmdExplain(cwd, { flags, text }) {
  if (!text) {
    throw new Error("explain requires a question. Usage: explain <question>");
  }

  // Resolve the passage: explicit --quote or transcript extraction.
  const baseDir = path.join(os.homedir(), ".claude", "projects");
  const last = flags.last === undefined ? 1 : Number(flags.last);
  const { passage } = resolveExplainPassage({
    baseDir,
    cwd,
    quote: flags.quote,
    last,
    tools: !!flags.tools,
  });

  // Build the worker prompt: the extracted passage + the user's question.
  const promptText = [
    "## Context from Claude Code transcript",
    "",
    passage,
    "",
    "## Question",
    "",
    text,
  ].join("\n");

  // Launch a cheap worker via the existing runPrompt path.
  const config = loadConfig(stateRoot());
  // No phase — use the first entry from the global chain (= cheap model).
  const resolved = resolveModel({ flag: flags.model, phase: undefined, config });
  const model = resolved.model;

  const { job, resultText } = await runPrompt({
    cwd,
    kind: "explain",
    title: "explain: " + text.slice(0, 80),
    promptText,
    agent: undefined,
    model,
    session: undefined,
    tools: undefined,
    timeoutS: Number(flags.timeout ?? 120),
    watchdogS: 0,
  });

  if (job.status !== "completed") {
    throw new Error("explain failed: " + (job.error || job.status));
  }

  return resultText || "(empty explanation)";
}

async function cmdReview(cwd, { flags, text }) {
  const promptTemplate = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "adversarial-review.md"), "utf8");
  const schema = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8"));
  const { label, input } = buildReviewInput(cwd, flags.base);
  const promptText = promptTemplate
    .replaceAll("{{TARGET_LABEL}}", label)
    .replaceAll("{{USER_FOCUS}}", text || "(none — general adversarial review)")
    .replaceAll("{{OUTPUT_SCHEMA}}", JSON.stringify(schema))
    .replaceAll("{{REVIEW_INPUT}}", input)
    .replaceAll("{{PRIOR_FINDINGS}}", flags.prior || "(none — first review round)");
  const { job, resultText } = await runPrompt({
    cwd,
    kind: "review",
    title: `review: ${label}`,
    promptText,
    model: parseModel(flags.model),
    agent: flags.agent,
    tools: Object.fromEntries(WRITE_TOOL_NAMES.map((t) => [t, false])),
    // NOTE: opencode's `format: json_schema` is not used — some providers 400
    // on it, and sessions created with it break GET /session/:id/message in
    // opencode 1.17.x. The schema is embedded in the prompt instead.
    timeoutS: Number(flags.timeout ?? DEFAULT_REVIEW_TIMEOUT_S),
    watchdogS: Number(flags.watchdog ?? DEFAULT_WATCHDOG_S),
  });
  if (job.status !== "completed") {
    return `${renderHeader(job)}${job.error ?? ""}\nCheck /kusabi:status ${job.id} for details.`;
  }
  // Strip trailing VERDICT token line before JSON parsing so the token
  // does not make extractJson fail on well-formed JSON.
  const stripped = resultText.replace(/\s*VERDICT:\s*(approve-partial|approve|needs-attention|discard)\s*$/i, "");
  const rendered = renderReview(extractJson(stripped), resultText);
  fs.writeFileSync(path.join(jobDir(stateDirFor(cwd), job.id), "result.md"), rendered, "utf8");
  return `${renderHeader(job)}${rendered}`;
}

function cmdStatus(cwd, { text }) {
  const stateDir = stateDirFor(cwd);
  const jobId = text.split(/\s+/).filter(Boolean)[0];
  if (jobId) {
    const job = loadJob(stateDir, jobId);
    if (!job) return `no such job: ${jobId}`;
    const s = job.stats ?? {};
    return [
      renderHeader(job).trimEnd(),
      `events: ${s.events ?? 0}, steps: ${s.steps ?? 0}, last tool: ${s.lastTool ?? "-"}`,
      `permissions: ${s.permissionsAllowed ?? 0} allowed, ${s.permissionsRejected ?? 0} rejected`,
      `last activity: ${s.lastActivity ?? "-"}`,
      ...(job.error ? [`error: ${job.error}`] : []),
    ].join("\n");
  }
  const jobs = listJobs(stateDir).slice(0, 10);
  if (jobs.length === 0) return "no opencode jobs for this directory yet.";
  return jobs
    .map((j) => renderJobLine(j))
    .join("\n");
}

function cmdResult(cwd, { text }) {
  const stateDir = stateDirFor(cwd);
  const jobId = text.split(/\s+/).filter(Boolean)[0];
  const job = jobId ? loadJob(stateDir, jobId) : latestJob(stateDir, (j) => j.status === "completed");
  if (!job) return jobId ? `no such job: ${jobId}` : "no completed jobs for this directory yet.";
  const resultFile = path.join(jobDir(stateDir, job.id), "result.md");
  const body = fs.existsSync(resultFile) ? fs.readFileSync(resultFile, "utf8") : "(no stored result)";
  return `${renderHeader(job)}${body}`;
}

async function cmdCancel(cwd, { text }) {
  const stateDir = stateDirFor(cwd);
  const jobId = text.split(/\s+/).filter(Boolean)[0];
  const job = jobId ? loadJob(stateDir, jobId) : latestJob(stateDir, (j) => j.status === "running");
  if (!job) return jobId ? `no such job: ${jobId}` : "no running jobs to cancel.";
  if (job.status !== "running") return `${job.id} is not running (status: ${job.status}).`;
  const server = readJson(path.join(stateDir, "server.json"));
  if (await serverHealthy(server)) {
    await api(server, "POST", `/session/${job.sessionID}/abort`).catch(() => {});
  }
  job.status = "cancelled";
  job.finishedAt = new Date().toISOString();
  saveJob(stateDir, job);
  return `cancelled ${job.id} (session ${job.sessionID}).`;
}

function cmdServeStop(cwd) {
  const stateDir = stateDirFor(cwd);
  const serverFile = path.join(stateDir, "server.json");
  const server = readJson(serverFile);
  if (!server?.pid) return "no server recorded for this directory.";
  try {
    process.kill(server.pid);
    try { fs.unlinkSync(serverFile); } catch { /* best-effort */ }
    return `stopped opencode server (pid ${server.pid}).`;
  } catch {
    try { fs.unlinkSync(serverFile); } catch { /* best-effort */ }
    return `server pid ${server.pid} was not running.`;
  }
}

function cmdInstallAgents() {
  const src = path.join(PLUGIN_ROOT, "opencode-agents");
  const dest = process.env.OPENCODE_AGENT_DIR || path.join(os.homedir(), ".config", "opencode", "agent");
  fs.mkdirSync(dest, { recursive: true });
  // Remove stale legacy agent definitions from install target
  const stale = ["oc-draft.md", "oc-investigate.md", "oc-implement.md", "oc-review.md", "oc-respond.md", "oc-salvage.md"];
  let removed = 0;
  for (const f of stale) {
    const target = path.join(dest, f);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      removed += 1;
    }
  }
  // Install current agent definitions under new kusabi-* names
  const files = fs.existsSync(src) ? fs.readdirSync(src).filter((f) => f.endsWith(".md")) : [];
  for (const f of files) fs.copyFileSync(path.join(src, f), path.join(dest, f));
  return `installed ${files.length} phase agents to ${dest} (removed ${removed} stale legacy names)`;
}

async function cmdSalvage(cwd, { flags, text }) {
  const deadJobId = text.split(/\s+/).filter(Boolean)[0];
  if (!deadJobId) throw new Error("salvage requires a dead job ID");
  const stateDir = stateDirFor(cwd);
  const deadJob = loadJob(stateDir, deadJobId);
  if (!deadJob) throw new Error(`no such job: ${deadJobId}`);

  // read dead job artifacts
  const deadDir = jobDir(stateDir, deadJobId);
  const originalBrief = fs.readFileSync(path.join(deadDir, "prompt.md"), "utf8");
  const eventsRaw = fs.readFileSync(path.join(deadDir, "events.ndjson"), "utf8")
    .split("\n").filter(Boolean).slice(-50)
    .map((l) => JSON.parse(l));

  // build salvage prompt
  const promptText = [
    `## Dead job info`,
    `- job ID: ${deadJob.id}`,
    `- kind: ${deadJob.kind}`,
    `- phase: ${deadJob.phase ?? "(none)"}`,
    `- status: ${deadJob.status}`,
    `- error: ${deadJob.error ?? "(none)"}`,
    `- models used: ${(deadJob.stats?.models ?? []).join(", ") || "(none)"}`,
    `- container ID: ${flags.container ?? "(not provided)"}`,
    `- Original brief:`,
    originalBrief,
    `## Recent events (${eventsRaw.length} items)`,
    eventsRaw.map((e) => JSON.stringify(e)).join("\n"),
  ].join("\n\n");

  const { job, resultText } = await runPrompt({
    cwd,
    kind: "salvage",
    title: `salvage: ${deadJobId}`,
    promptText,
    agent: "kusabi-salvage",
    phase: "salvage",
    model: parseModel(flags.model),
    tools: Object.fromEntries(
      ["bash", "edit", "write", "patch", "task", "skill"].map((t) => [t, false])
    ),
    timeoutS: Number(flags.timeout ?? 600),
    watchdogS: 0,
  });

  // record salvagedFrom
  job.salvagedFrom = deadJobId;
  saveJob(stateDir, job);

  if (job.status !== "completed") {
    return `${renderHeader(job)}${job.error ?? ""}`;
  }
  return `${renderHeader(job)}${resultText || "(empty report)"}`;
}

// ---------------------------------------------------------------------------
// chain
// ---------------------------------------------------------------------------

async function cmdChain(cwd, { flags, text }) {
  // ---- brief-file resolution ----
  text = readBriefFile(flags, text);
  if (!text) throw new Error("chain requires a brief description (inline or via --brief-file)");
  const orchestrator = parseOrchestratorSignature(text);
  try {
    const stateDir = stateDirFor(cwd);
    const config = loadConfig(stateRoot());
  const resolved = resolveModel({ flag: flags.model, phase: "implement", config });
  const model = resolved.model;
  const modelChain = resolved.chain;

  const chainId = `chain-${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  const chainDir = path.join(stateDir, "chains", chainId);
  fs.mkdirSync(chainDir, { recursive: true });

  const container = flags.container;
  if (!container) throw new Error("chain requires --container <cid>");
  const maxRounds = Number(flags["max-rounds"] ?? 3);
  const brief = text;

  // ---- chain initialisation: record base + checkpoint ----
  let baseSha = null;
  try {
    const { callTool } = await import("./sunaba-rpc.mjs");
    const gitRev = await callTool("sandbox_exec", {
      container_id: container,
      commands: ["git rev-parse HEAD"],
    });
    baseSha = (gitRev?.output ?? "").trim() || null;
  } catch (initErr) {
    // Record initialisation failure; probes will catch it per-round
    baseSha = null;
  }

  const records = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    const isFirstRound = round === 1;
    const hasPreviousRound = round > 1 && records.length > 0;
    const previousRecord = hasPreviousRound ? records[records.length - 1] : null;

    // Round 2: same session continue (rework 1st attempt)
    // Round 3+: checkpoint_restore(chain-base) -> new session
    const useNewSession = round >= 3;
    let resumeMethod;
    if (useNewSession) {
      // Actually attempt checkpoint_restore; record outcome honestly
      let restoreOk = false;
      let restoreDetail = null;
      if (baseSha) {
        try {
          const { callTool } = await import("./sunaba-rpc.mjs");
          await callTool("checkpoint_restore", {
            container_id: container,
            sha: baseSha,
          });
          restoreOk = true;
        } catch (restoreErr) {
          restoreDetail = String(restoreErr);
        }
      } else {
        restoreDetail = "baseSha was never recorded at chain start";
      }
      resumeMethod = {
        type: restoreOk ? "checkpoint_restore" : "checkpoint_restore_failed",
        base: baseSha,
        detail: restoreDetail,
      };
    } else {
      resumeMethod = { type: "continue_session" };
    }
    // ---- resolve round-specific model ----
    // Round 1: use --model if provided, else chain entry 0 (already in `model`).
    // Round 2+: use chain entry (round-1), clamped to last entry.
    let roundModel;
    if (isFirstRound && flags.model) {
      roundModel = model;  // --model overrides round 1
    } else {
      const chainIdx = Math.min(round - 1, modelChain.length - 1);
      const entry = modelChain[chainIdx];
      roundModel = parseModel(entry);
    }
    const roundModelEntry = (roundModel && roundModel.variant)
      ? roundModel.providerID + "/" + roundModel.modelID + ":" + roundModel.variant
      : (roundModel ? roundModel.providerID + "/" + roundModel.modelID : null);

    const roundRecord = { round, resumeMethod, startedAt: new Date().toISOString(), verdict: null, probesGreen: false, modelEntry: roundModelEntry, modelVariant: roundModel?.variant || null };

    let implementText;
    if (isFirstRound) {
      implementText = brief;
    } else if (previousRecord) {
      implementText = "## Prior findings\n" + (previousRecord.findingsText || "(none)") + "\n\n## Acceptance criteria\n" + brief;
    } else {
      implementText = brief;
    }

    // ---- implement phase ----
    let session = flags.session;
    if (!session && !isFirstRound && previousRecord?.sessionID) {
      if (!useNewSession) {
        session = previousRecord.sessionID;
      }
    }

    const implementJob = await runPrompt({
      cwd,
      kind: "task",
      title: "chain: " + chainId + " round " + round + " implement",
      promptText: implementText,
      agent: "kusabi-implement",
      phase: "implement",
      model: roundModel,
      session: useNewSession ? undefined : session,
      timeoutS: 3600,
      watchdogS: 900,
    });
    roundRecord.implementJobId = implementJob.job.id;
    roundRecord.sessionID = implementJob.job.sessionID;
    roundRecord.implementUsage = implementJob.job.usage || null;

    // ---- deterministic probes (via sunaba-rpc) ----
    let probesGreen = false;
    const probeResults = [];
    let chainChangedPaths = [];
    let chainStatusObserved = false;
    const chainDeliverables = parseDeliverables(brief);

    try {
      const { callTool } = await import("./sunaba-rpc.mjs");

      // P1: HEAD clean - compare with baseSha recorded at chain start
      let p1Passed = false;
      let p1Detail = "";
      if (baseSha) {
        const gitRev = await callTool("sandbox_exec", {
          container_id: container,
          commands: ["git rev-parse HEAD"],
        });
        const headSha = (gitRev?.output ?? "").trim();
        if (headSha !== baseSha) {
          p1Detail = "HEAD " + headSha + " != base " + baseSha + "; auto reset";
          try {
            await callTool("sandbox_exec", {
              container_id: container,
              commands: ["git reset --mixed " + baseSha],
            });
            p1Passed = true;
            p1Detail += " - reset OK";
          } catch (resetErr) {
            p1Detail += " - reset FAILED: " + String(resetErr);
          }
        } else {
          p1Passed = true;
          p1Detail = "HEAD matches base " + baseSha;
        }
      } else {
        p1Detail = "baseSha not recorded at chain start; cannot check HEAD";
      }
      probeResults.push({ probe: "P1: HEAD clean", passed: p1Passed, detail: p1Detail });

      // P2: verify gate (no skip flags)
      const verifyResult = await callTool("verify_in_container", {
        container_id: container,
        path: ".",
      });
      const verifyPassed = verifyResult?.gate_passed === true;
      probeResults.push({ probe: "P2: verify gate", passed: verifyPassed, detail: JSON.stringify(verifyResult) });

      // P3: deliverables probe
      const statusResult = await callTool("sandbox_exec", {
        container_id: container,
        commands: ["git status --porcelain"],
      });
      chainChangedPaths = parseChangedPaths(statusResult?.output ?? "");
      chainStatusObserved = true;
      const p3Result = checkDeliverablesProbe(chainDeliverables, chainChangedPaths);
      probeResults.push(p3Result);

      probesGreen = probeResults.every(function(p) { return p.passed; });
    } catch (probeErr) {
      probeResults.push({ probe: "sunaba-rpc", passed: false, detail: String(probeErr) });
      probesGreen = false;
    }

    roundRecord.probesGreen = probesGreen;
    roundRecord.probeResults = probeResults;

    // ---- P3 empty-change: skip review, set probe-sourced discard verdict ----
    let chainSkipReview = false;
    if (chainStatusObserved && chainChangedPaths.length === 0 && chainDeliverables.length > 0) {
      roundRecord.verdict = "discard";
      roundRecord.verdictSource = "probe";
      chainSkipReview = true;
    }

    // ---- review phase (skipped when change set empty) ----
    let chainVerdict = roundRecord.verdict; // may already be set by probe skip above
    let chainFindingsText = null;
    let chainParsedReview = null;
    let chainRepeatedAreas = false;

    if (!chainSkipReview) {
      const promptTemplate = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "adversarial-review.md"), "utf8");
      const schemaJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8"));
      const reviewInput = [
        "## Review target",
        "",
        "The artifact under review lives inside container `" + container + "`.",
        "You may use the following Sunaba read/verify tools to inspect it:",
        "- `read_file_range` - read file contents from the container",
        "- `search_in_container` - grep/search within the container",
        "- `verify_in_container` / `lint_in_container` / `type_check_in_container` - re-run the project's gates in the container",
        "",
        "Do NOT rely on host cwd git state; the actual changes are in the container.",
      ].join("\n");
      const priorFindings = previousRecord?.findingsText || "(none -- first review round)";

      const reviewPromptText = promptTemplate
        .replaceAll("{{TARGET_LABEL}}", "container " + container + " changes")
        .replaceAll("{{USER_FOCUS}}", brief)
        .replaceAll("{{OUTPUT_SCHEMA}}", JSON.stringify(schemaJson))
        .replaceAll("{{REVIEW_INPUT}}", reviewInput)
        .replaceAll("{{PRIOR_FINDINGS}}", priorFindings);

      const reviewJob = await runPrompt({
        cwd,
        kind: "review",
        title: "chain: " + chainId + " round " + round + " review",
        promptText: reviewPromptText,
        model,
        agent: "kusabi-review",
        tools: Object.fromEntries(WRITE_TOOL_NAMES.map(function(t) { return [t, false]; })),
        timeoutS: 1800,
        watchdogS: 900,
      });
      roundRecord.reviewJobId = reviewJob.job.id;
      roundRecord.reviewUsage = reviewJob.job.usage || null;

      // ---- parse review result ----
      const reviewResultText = reviewJob.resultText || "";
      const stripped = reviewResultText.replace(/\s*VERDICT:\s*(approve-partial|approve|needs-attention|discard)\s*$/i, "");
      chainParsedReview = extractJson(stripped);
      chainVerdict = (chainParsedReview && chainParsedReview.verdict) || "needs-attention";
      roundRecord.verdict = chainVerdict;
      chainFindingsText = (chainParsedReview && chainParsedReview.findings)
        ? chainParsedReview.findings.map(function(f) { return "[" + f.severity + "] " + f.title + " (" + f.file + ":" + f.line_start + ")"; }).join("\n")
        : "(no structured findings)";
      roundRecord.findingsText = chainFindingsText;

      // ---- determine repeated areas ----
      if (previousRecord?.findingsText && chainParsedReview?.findings) {
        var prevFiles = new Set(
          (previousRecord.findingsText.match(/\([^:]+/g) || []).map(function(s) { return s.slice(1); }),
        );
        for (var fi = 0; fi < chainParsedReview.findings.length; fi++) {
          if (prevFiles.has(chainParsedReview.findings[fi].file)) {
            chainRepeatedAreas = true;
            break;
          }
        }
      }
    }

    // ---- derive disposition ----
    const disposition = deriveDisposition({
      verdict: chainVerdict || "needs-attention",
      probesGreen: probesGreen,
      round: round,
      maxRounds: maxRounds,
      repeatedAreas: chainRepeatedAreas,
    });
    roundRecord.disposition = disposition;

    // ---- persist record ----
    records.push(roundRecord);
    writeJson(path.join(chainDir, "round-" + round + ".json"), roundRecord);

    // Compute chain-wide usage totals from all round records.
    const chainTotals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const rec of records) {
      for (const usage of [rec.implementUsage, rec.reviewUsage]) {
        if (usage && usage.available) {
          chainTotals.input += usage.input || 0;
          chainTotals.output += usage.output || 0;
          chainTotals.reasoning += usage.reasoning || 0;
          chainTotals.cacheRead += usage.cacheRead || 0;
          chainTotals.cacheWrite += usage.cacheWrite || 0;
          chainTotals.cost += usage.cost || 0;
        }
      }
    }

    // When review was skipped, ensure findingsText is set
    if (chainSkipReview && !roundRecord.findingsText) {
      roundRecord.findingsText = "(no review — change set was empty)";
    }

    writeJson(path.join(chainDir, "chain.json"), {
      chainId: chainId,
      container: container,
      model: model,
      modelChain: modelChain,
      maxRounds: maxRounds,
      brief: brief,
      orchestrator: orchestrator,
      records: records,
      baseSha: baseSha,
      chainTotals: chainTotals,
    });

    if (disposition.disposition === "accept") {
      const acceptReviewText = chainParsedReview
        ? renderReview(chainParsedReview, chainFindingsText || "")
        : "(no review text available)";
      return "Chain " + chainId + " accepted at round " + round + ".\n\n" + acceptReviewText;
    }

    if (disposition.disposition === "escalate") {
      var reason = disposition.reason || "unknown";
      var orchLine = orchestrator?.model ? "orchestrator=" + orchestrator.model : "";
      var lines = [
        "Chain " + chainId + " escalated at round " + round + ": " + reason,
        orchLine,
        "",
        "Remaining findings:",
        roundRecord.findingsText,
        "",
      ];
      for (var ri = 0; ri < records.length; ri++) {
        var r = records[ri];
        var detail = r.resumeMethod.detail ? ": " + r.resumeMethod.detail : "";
        lines.push("Round " + (ri + 1) + ": model=" + (r.modelEntry || "?") + ", verdict=" + r.verdict + ", probesGreen=" + r.probesGreen + ", resume=" + r.resumeMethod.type + detail);
      }
      lines.push("", "Hand over to orchestrator for final judgement.");
      return lines.join("\n");
    }
  }

  var lastRecord = records.length > 0 ? records[records.length - 1] : {};
  var finalFindings = lastRecord.findingsText || "(none)";
  var orchLine = orchestrator?.model ? "orchestrator=" + orchestrator.model : "";
  var lines = [
    "Chain " + chainId + " reached max rounds (" + maxRounds + ") without acceptance.",
    orchLine,
    "",
    "Remaining findings:",
    finalFindings,
    "",
  ];
  for (var ri2 = 0; ri2 < records.length; ri2++) {
    var r2 = records[ri2];
    var detail2 = r2.resumeMethod.detail ? ": " + r2.resumeMethod.detail : "";
    lines.push("Round " + (ri2 + 1) + ": model=" + (r2.modelEntry || "?") + ", verdict=" + r2.verdict + ", probesGreen=" + r2.probesGreen + ", resume=" + r2.resumeMethod.type + detail2);
  }
  lines.push("", "Hand over to orchestrator for final judgement.");
  return lines.join("\n");
  } finally {
    // Stop the serve for this cwd unless --keep-serve or another job is running
    if (!flags.keepServe) {
      try {
        const jobs = listJobs(stateDirFor(cwd));
        const hasRunning = jobs.some(function (j) { return j.status === "running"; });
        if (!hasRunning) {
          cmdServeStop(cwd);
        }
      } catch { /* best-effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// chain-show
// ---------------------------------------------------------------------------

/**
 * Find the newest chain directory (by mtime) under a chains directory.
 * Exported for testing.
 *
 * @param {string} chainsDir - Absolute path to the chains directory.
 * @returns {string|null} The name of the newest chain dir, or null if none found.
 */
export function newestChainDir(chainsDir) {
  if (!fs.existsSync(chainsDir)) return null;
  const entries = fs.readdirSync(chainsDir)
    .map((name) => {
      try {
        const fullPath = path.join(chainsDir, name);
        const stat = fs.statSync(fullPath);
        return { name, mtime: stat.mtimeMs, isDir: stat.isDirectory() };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((e) => e.isDir && e.name.startsWith("chain-"))
    .sort((a, b) => {
      const mtimeDiff = b.mtime - a.mtime;
      if (mtimeDiff !== 0) return mtimeDiff;
      // Tiebreaker: lexicographic by name for deterministic selection
      return a.name.localeCompare(b.name);
    });
  return entries.length > 0 ? entries[0].name : null;
}

function cmdChainShow(cwd, { text }) {
  const stateDir = stateDirFor(cwd);
  const chainsDir = path.join(stateDir, "chains");

  if (!fs.existsSync(chainsDir)) {
    throw new Error("no chains directory found for this workspace");
  }

  let chainId = text.trim() || null;
  if (!chainId) {
    chainId = newestChainDir(chainsDir);
    if (!chainId) {
      throw new Error("no chains found for this workspace");
    }
  }

  const chainDir = path.join(chainsDir, chainId);
  if (!fs.existsSync(chainDir)) {
    throw new Error(`chain not found: ${chainId}`);
  }

  const chainJson = readJson(path.join(chainDir, "chain.json"));
  if (!chainJson) {
    throw new Error(`chain.json not found or invalid for ${chainId}`);
  }

  // Read all round-*.json files sorted by round number (numeric sort)
  const roundFiles = fs.readdirSync(chainDir)
    .filter((f) => f.startsWith("round-") && f.endsWith(".json"))
    .sort((a, b) => {
      const na = Number(a.match(/round-(\d+)\.json$/)?.[1]) ?? 0;
      const nb = Number(b.match(/round-(\d+)\.json$/)?.[1]) ?? 0;
      return na - nb;
    });

  const rounds = [];
  const unreadable = [];
  for (const f of roundFiles) {
    const data = readJson(path.join(chainDir, f));
    if (data) rounds.push(data);
    else unreadable.push(f);
  }

  return renderChainShow(chainJson, rounds, unreadable);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function usage() {
  return [
    "Usage: kusabi-companion <subcommand> [flags] [text]",
    "",
    "Subcommands:",
    "  setup      Start or verify the opencode server for this directory",
    "  task       Run an opencode task",
    "  review     Run an adversarial review of working-tree changes",
    "  chain      Run implement→review→rework chain until acceptance or escalate",
    "  chain-show Print a compact plain-text digest of a chain (read-only, no LLM)",
    "  status     List recent jobs or show one by ID",
    "  result     Show completed job result (latest, or by ID)",
    "  cancel     Cancel a running job",
    "  serve-stop Stop the background opencode server and remove its state file",
    "  install-agents  Copy phase agent definitions to OPENCODE_AGENT_DIR",
    "  salvage    Salvage a dead job (inspect progress and produce structured report)",
    "  explain    Answer a question about the last assistant passage using a cheap worker model",
    "  help       Show this help message",
    "",
    "Flags:",
    "  --read-only, --resume-last, --wait, --background",
    "  --base <ref>, --model <provider/model>, --agent <id>, --phase <name>",
    "  --session <id>, --timeout <s>, --watchdog <s>, --deny <tools>",
    "  --brief-file <path> (task / chain: read the brief from a file; exclusive with inline text)",
    "  --container <cid> (chain/task: container to run deterministic probes in)",
    "  --keep-serve (chain: keep the serve alive after chain finishes)",
    "  --prior <text> (review: prior findings for anti-ratchet)",
    "  --max-rounds <N> (chain: max rounds, default 3)",
    "  --last <N> (explain: include last N assistant/user exchanges, default 1)",
    "  --tools (explain: also include tool results in context)",
    "  --quote <text> (explain: use explicit passage instead of transcript extraction)",
    "  -h, --help",
    "",
    "Unknown flags cause an error. Use -- to treat subsequent tokens as literal text.",
    "",
    "Serve lifecycle:",
    "  - chain stops its serve on completion unless --keep-serve is passed.",
    "  - serve-stop kills the serve and removes its server.json.",
    "  - Idle serves without running jobs are reaped on next invocation after",
    "    KUSABI_SERVE_TTL_MS (default 30 min).",
  ].join("\n");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  const cwd = process.cwd();

  // Startup reaper: reap idle serves whose last activity is older than TTL.
  // Best-effort; a failure here must never crash the invoking command.
  try {
    const raw = process.env.KUSABI_SERVE_TTL_MS;
    const ttlMs = parseFloat(raw);
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 30 * 60 * 1000;
    reapIdleServes(stateRoot(), ttl);
  } catch { /* best-effort */ }

  // Claude Code passes "$ARGUMENTS" as a single string; re-split it.
  const flat = argv.length === 1 && argv[0]?.includes(" ") ? argv[0].split(/\s+/).filter(Boolean) : argv;

  // --help / -h before any literal "--", or the help subcommand -> usage, exit 0
  const sepIdx = flat.indexOf("--");
  const preLiteral = flat.slice(0, sepIdx >= 0 ? sepIdx : flat.length);
  if (
    subcommand === "help" || subcommand === "--help" || subcommand === "-h" ||
    preLiteral.includes("--help") || preLiteral.includes("-h")
  ) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const parsed = parseArgs(flat);
  switch (subcommand) {
    case "setup":
      return cmdSetup(cwd);
    case "task":
      return cmdTask(cwd, parsed);
    case "review":
      return cmdReview(cwd, parsed);
    case "status":
      return cmdStatus(cwd, parsed);
    case "result":
      return cmdResult(cwd, parsed);
    case "cancel":
      return cmdCancel(cwd, parsed);
    case "serve-stop":
      return cmdServeStop(cwd);
    case "install-agents":
      return cmdInstallAgents();
    case "salvage":
      return cmdSalvage(cwd, parsed);
    case "chain":
      return cmdChain(cwd, parsed);
    case "chain-show":
    case "chainShow":
      return cmdChainShow(cwd, parsed);
    case "explain":
      return cmdExplain(cwd, parsed);
    default:
      throw new Error(`unknown subcommand: ${subcommand ?? "(none)"}. Use setup|task|review|chain|chain-show|status|result|cancel|serve-stop|install-agents|salvage|explain`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((output) => {
      if (output) process.stdout.write(`${output}\n`);
      process.exit(0);
    })
    .catch((err) => {
      process.stdout.write(`kusabi-companion error: ${err.message}\n`);
      process.exit(1);
    });
}
