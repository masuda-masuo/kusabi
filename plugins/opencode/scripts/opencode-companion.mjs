#!/usr/bin/env node
// opencode-companion: bridge between Claude Code slash commands and an
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
  draft: "oc-draft",
  investigate: "oc-investigate",
  implement: "oc-implement",
  review: "oc-review",
  respond: "oc-respond",
  salvage: "oc-salvage",
};

// ---------------------------------------------------------------------------
// state dir / server lifecycle
// ---------------------------------------------------------------------------

function stateRoot() {
  return process.env.OPENCODE_COMPANION_STATE_DIR || path.join(os.homedir(), ".opencode-plugin-cc");
}

function stateDirFor(cwd) {
  const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  const dir = path.join(stateRoot(), hash);
  fs.mkdirSync(path.join(dir, "jobs"), { recursive: true });
  return dir;
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

function decidePermission() {
  return "once";
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
      ...(model ? { model } : {}),
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
  return [
    `opencode ${job.kind} ${job.id} — ${job.status} (${durationS(job)}s)`,
    `session: ${job.sessionID} (continue in opencode: \`opencode -s ${job.sessionID}\`)`,
    ...(job.phase ? [`phase: ${job.phase}`] : []),
    ...(job.stats?.models?.length ? [`model: ${job.stats.models.join(" → ")}`] : []),
    "",
  ].join("\n");
}

function extractJson(text) {
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

function renderReview(parsed, rawText) {
  if (!parsed) {
    const lines = rawText.split("\n").filter((l) => l.trim() !== "");
    const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : "";
    const tokenMatch = lastLine.match(/^VERDICT:\s*(approve|needs-attention)\s*$/i);
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

function parseArgs(argv) {
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
      arg === "--wait" || arg === "--background" || arg === "--help" || arg === "-h"
    ) {
      const key = arg.startsWith("--")
        ? arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        : arg.slice(1);
      flags[key] = true;
    } else if (arg === "--base" || arg === "--model" || arg === "--agent" || arg === "--session" || arg === "--timeout" || arg === "--deny" || arg === "--watchdog" || arg === "--phase" || arg === "--container" || arg === "--prior") {
      flags[arg.slice(2)] = argv[++i];
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      rest.push(arg);
    }
  }
  return { flags, text: rest.join(" ").trim() };
}

function parseModel(value) {
  if (!value) return undefined;
  const idx = value.indexOf("/");
  if (idx < 0) throw new Error(`--model expects provider/model, got: ${value}`);
  return { providerID: value.slice(0, idx), modelID: value.slice(idx + 1) };
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
  if (!text) throw new Error("task requires a task description");
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
  const guardrails = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "task-guardrails.md"), "utf8").trim();
  const { job, resultText } = await runPrompt({
    cwd,
    kind: "task",
    title: text.slice(0, 80),
    promptText: `${guardrails}\n\n<task>\n${text}\n</task>`,
    agent,
    phase,
    model: parseModel(flags.model),
    session,
    tools,
    timeoutS: Number(flags.timeout ?? DEFAULT_TASK_TIMEOUT_S),
    watchdogS: Number(flags.watchdog ?? DEFAULT_WATCHDOG_S),
  });
  if (job.status !== "completed") {
    return `${renderHeader(job)}${job.error ?? ""}\nCheck /opencode:status ${job.id} for details.`;
  }
  return `${renderHeader(job)}${resultText || "(empty result)"}`;
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
    return `${renderHeader(job)}${job.error ?? ""}\nCheck /opencode:status ${job.id} for details.`;
  }
  // Strip trailing VERDICT token line before JSON parsing so the token
  // does not make extractJson fail on well-formed JSON.
  const stripped = resultText.replace(/\s*VERDICT:\s*(approve|needs-attention)\s*$/i, "");
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
    .map((j) => `${j.id}  ${j.kind.padEnd(6)}  ${j.status.padEnd(9)}  ${durationS(j)}s  ${j.title ?? ""}`)
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
  const server = readJson(path.join(stateDir, "server.json"));
  if (!server?.pid) return "no server recorded for this directory.";
  try {
    process.kill(server.pid);
    return `stopped opencode server (pid ${server.pid}).`;
  } catch {
    return `server pid ${server.pid} was not running.`;
  }
}

function cmdInstallAgents() {
  const src = path.join(PLUGIN_ROOT, "opencode-agents");
  const dest = process.env.OPENCODE_AGENT_DIR || path.join(os.homedir(), ".config", "opencode", "agent");
  fs.mkdirSync(dest, { recursive: true });
  const files = fs.existsSync(src) ? fs.readdirSync(src).filter((f) => f.endsWith(".md")) : [];
  for (const f of files) fs.copyFileSync(path.join(src, f), path.join(dest, f));
  return `installed ${files.length} phase agents to ${dest}`;
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
    agent: "oc-salvage",
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
// main
// ---------------------------------------------------------------------------

function usage() {
  return [
    "Usage: opencode-companion <subcommand> [flags] [text]",
    "",
    "Subcommands:",
    "  setup      Start or verify the opencode server for this directory",
    "  task       Run an opencode task",
    "  review     Run an adversarial review of working-tree changes",
    "  status     List recent jobs or show one by ID",
    "  result     Show completed job result (latest, or by ID)",
    "  cancel     Cancel a running job",
    "  serve-stop Stop the background opencode server",
    "  install-agents  Copy phase agent definitions to OPENCODE_AGENT_DIR",
    "  salvage    Salvage a dead job (inspect progress and produce structured report)",
    "  help       Show this help message",
    "",
    "Flags (task / review / salvage):",
    "  --read-only, --resume-last, --wait, --background",
    "  --base <ref>, --model <provider/model>, --agent <id>, --phase <name>",
    "  --session <id>, --timeout <s>, --watchdog <s>, --deny <tools>",
    "  --container <cid> (salvage: container to attach to)",
    "  --prior <text> (review: prior findings for anti-ratchet)",
    "  -h, --help",
    "",
    "Unknown flags cause an error. Use -- to treat subsequent tokens as literal text.",
  ].join("\n");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  const cwd = process.cwd();

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
    default:
      throw new Error(`unknown subcommand: ${subcommand ?? "(none)"}. Use setup|task|review|status|result|cancel|serve-stop|install-agents|salvage`);
  }
}

main()
  .then((output) => {
    if (output) process.stdout.write(`${output}\n`);
    process.exit(0);
  })
  .catch((err) => {
    process.stdout.write(`opencode-companion error: ${err.message}\n`);
    process.exit(1);
  });
