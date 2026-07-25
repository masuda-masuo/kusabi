// prompt-execution.mjs — SSE event stream, permission handling, and runPrompt
import path from "node:path";
import fs from "node:fs";
import process from "node:process";
import { ensureServer, api, authHeader } from "./serve-lifecycle.mjs";
import { newJobId, saveJob, jobDir, appendEvent } from "./job-store.mjs";
import { writeJson } from "./state-paths.mjs";
import { durationS } from "./render.mjs";

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

async function openSse(server, signal) {
  const res = await fetch(`http://127.0.0.1:${server.port}/event`, {
    headers: { ...authHeader(server), accept: "text/event-stream" },
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`SSE connect failed: HTTP ${res.status}`);
  return sseEvents(res);
}

export function eventSession(event) {
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

export function permissionInfo(event) {
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

export async function runPrompt({ cwd, kind, title, promptText, agent, model, session, tools, format, timeoutS, watchdogS, phase }) {
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
