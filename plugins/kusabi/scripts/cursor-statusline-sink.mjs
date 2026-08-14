#!/usr/bin/env node
// cursor-statusline-sink: Cursor CLI statusline command that records sampled
// usage as NDJSON so the companion can recover an orchestrator session id
// when CLAUDE_CODE_SESSION_ID is absent (kusabi #237).
//
// Wired as `statusLine.command` in ~/.cursor/cli-config.json. Cursor launches
// this on every conversation update, feeds a JSON payload on stdin, and
// displays the first stdout line. The contract that must not be broken:
//
//   - exit 0 always (a dead statusline is worse than a short error string)
//   - exactly one stdout line
//   - finish well inside Cursor's 2s timeout — so this file is sync I/O only
//
// The on-disk format is the companion's reader contract: one JSON object
// per line under KUSABI_CURSOR_USAGE_DIR (default `$HOME/.kusabi/cursor-usage`)
// named `<session_id>.jsonl`, each record `{ts, session_id, model, cwd,
// context_window}`. Identical consecutive `context_window` values are not
// appended (the same payload is resent on every conversation tick).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Sessions whose last line is older than this are ignored by the companion
 *  lookup. 24h covers an overnight resume of the same Cursor CLI session
 *  without gluing last week's abandoned jsonl onto a new kusabi job. */
export const CURSOR_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function cursorUsageDir(env = process.env, home = os.homedir()) {
  const fromEnv = env && env.KUSABI_CURSOR_USAGE_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  return path.join(home, ".kusabi", "cursor-usage");
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export function lastNonEmptyLine(text) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].length > 0) return lines[i];
  }
  return null;
}

function modelLabel(payload) {
  const model = payload.model;
  if (model && typeof model === "object" && !Array.isArray(model)) {
    if (typeof model.display_name === "string" && model.display_name) return model.display_name;
    if (typeof model.id === "string" && model.id) return model.id;
  }
  return "Cursor";
}

export function formatStatus(payload) {
  const label = modelLabel(payload);
  const cw = payload.context_window;
  const usage = cw && typeof cw === "object" ? cw.current_usage : null;
  if (usage == null || typeof usage !== "object") {
    return `${label} | warming up`;
  }
  const parts = [label];
  if (typeof cw.used_percentage === "number" && Number.isFinite(cw.used_percentage)) {
    parts.push(`${cw.used_percentage}%`);
  }
  const inn = usage.input_tokens ?? 0;
  const out = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  parts.push(`last ${inn}in/${out}out (cache r${cacheRead} w${cacheWrite})`);
  return parts.join(" | ");
}

function isoNow(now) {
  if (now instanceof Date) return now.toISOString();
  if (typeof now === "number" && Number.isFinite(now)) return new Date(now).toISOString();
  if (typeof now === "string" && now.length > 0) return now;
  return new Date().toISOString();
}

/**
 * Append one usage record for `payload.session_id` unless the previous line
 * already carries an identical `context_window`. Returns whether a line was
 * written. Missing session_id is a no-op (still the caller's job to print a
 * status line).
 */
export function appendUsage(payload, {
  dir,
  env = process.env,
  home = os.homedir(),
  now,
} = {}) {
  const sessionId = payload && payload.session_id;
  if (typeof sessionId !== "string" || sessionId.length === 0) return false;

  const usageDir = dir ?? cursorUsageDir(env, home);
  fs.mkdirSync(usageDir, { recursive: true });

  const safeId = sessionId.replace(/[/\\]/g, "_");
  const file = path.join(usageDir, `${safeId}.jsonl`);
  const record = {
    ts: isoNow(now),
    session_id: sessionId,
    model: payload.model ?? null,
    cwd: payload.cwd ?? null,
    context_window: payload.context_window ?? null,
  };

  if (fs.existsSync(file)) {
    const prevLine = lastNonEmptyLine(fs.readFileSync(file, "utf8"));
    if (prevLine) {
      try {
        const prev = JSON.parse(prevLine);
        if (stableStringify(prev.context_window) === stableStringify(record.context_window)) {
          return false;
        }
      } catch {
        // Corrupt tail: treat as incomparable and append.
      }
    }
  }

  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  return true;
}

/**
 * Pick the session_id of the newest jsonl whose *last* line matches `cwd`
 * and whose `ts` is within `maxAgeMs` of `now`. Returns null when the dir
 * is missing, empty, or has no eligible session. Never creates the dir.
 *
 * cwd is an exact string match — a neighbouring project's session must not
 * be selected even if it is newer.
 */
export function resolveLatestCursorSession({
  dir,
  cwd,
  now = Date.now(),
  maxAgeMs = CURSOR_SESSION_MAX_AGE_MS,
} = {}) {
  if (typeof dir !== "string" || dir.length === 0) return null;
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const nowMs = now instanceof Date ? now.getTime()
    : typeof now === "string" ? Date.parse(now)
    : now;
  if (!Number.isFinite(nowMs)) return null;
  const cutoff = nowMs - maxAgeMs;
  let best = null;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const line = lastNonEmptyLine(text);
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec === null || typeof rec !== "object" || Array.isArray(rec)) continue;
    if (rec.cwd !== cwd) continue;
    if (typeof rec.session_id !== "string" || rec.session_id.length === 0) continue;
    const tsMs = Date.parse(rec.ts);
    if (!Number.isFinite(tsMs) || tsMs < cutoff) continue;
    if (
      best === null
      || tsMs > best.tsMs
      || (tsMs === best.tsMs && rec.session_id > best.session)
    ) {
      best = { session: rec.session_id, tsMs };
    }
  }
  return best ? best.session : null;
}

function failSoft(write) {
  write("statusline error\n");
}

/**
 * Statusline entry: parse stdin JSON, append usage, print one status line.
 * Never throws; never exits non-zero. `stdinText` / `write` / `dir` / `now`
 * / `env` are injectable so tests do not touch the real HOME or fd 0.
 */
export function runStatuslineSink({
  stdinText,
  env = process.env,
  home = os.homedir(),
  dir,
  now,
  write = (s) => process.stdout.write(s),
} = {}) {
  let raw;
  try {
    raw = stdinText !== undefined ? stdinText : fs.readFileSync(0, "utf8");
  } catch {
    failSoft(write);
    return { appended: false, status: "statusline error" };
  }
  if (typeof raw !== "string" || !raw.trim()) {
    failSoft(write);
    return { appended: false, status: "statusline error" };
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    failSoft(write);
    return { appended: false, status: "statusline error" };
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    failSoft(write);
    return { appended: false, status: "statusline error" };
  }

  let appended = false;
  try {
    appended = appendUsage(payload, { dir, env, home, now });
  } catch {
    // Status output still matters more than a failed sink write.
  }
  const status = formatStatus(payload);
  write(`${status}\n`);
  return { appended, status };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runStatuslineSink();
  } catch {
    process.stdout.write("statusline error\n");
  }
}
