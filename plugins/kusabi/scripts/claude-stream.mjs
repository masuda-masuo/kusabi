// claude-stream.mjs — NDJSON stream line parse and stats accumulator for Claude Code CLI (kusabi #426).

/**
 * Returns null for anything that is not a JSON object on that line —
 * blank lines, and non-JSON prose (the real CLI has been observed printing
 * a "no stdin data" warning line ahead of the stream).  The caller counts
 * nulls for debugging but never treats one as fatal.
 *
 * @param {string} line
 * @returns {object|null}
 */
export function parseClaudeStreamLine(line) {
  const trimmed = typeof line === "string" ? line.trim() : "";
  if (!trimmed) return null;
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  return obj;
}

/**
 * A fresh accumulator for folding a claude NDJSON stream into job stats.
 *
 * @returns {{ events: number, steps: number, lastTool: string|null,
 *             lastActivity: string|null, models: string[],
 *             sessionIdFromInit: string|null, resultEvent: object|null,
 *             rateLimit: {info: object, observedAt: string}|null }}
 */
export function initClaudeStreamAccumulator() {
  return {
    events: 0,
    steps: 0,
    lastTool: null,
    lastActivity: null,
    models: [],
    sessionIdFromInit: null,
    resultEvent: null,
    rateLimit: null,
  };
}

/**
 * Fold one parsed stream event into the accumulator (mutates and returns
 * it).  Every recognized event type contributes:
 *
 *   - `system` / `init`      — the session id, kept in case the stream ends
 *                               with no terminal `result` event.
 *   - `rate_limit_event`     — the live quota feed (kusabi #215 Job B item
 *                               4): the most recent `rate_limit_info`,
 *                               stamped with when it was observed.
 *   - `assistant`            — `message.model` (deduped into `models`) and
 *                               each `tool_use` content block (`steps` +
 *                               `lastTool`).
 *   - `result`               — kept as `resultEvent`; a later one replaces
 *                               an earlier one, so a stream carrying more
 *                               than one keeps the LAST (the terminal one).
 *
 * `events` and `lastActivity` update for every recognized call regardless
 * of type: `events` is "parsed event lines", not "assistant events".
 *
 * @param {object} acc — an accumulator from `initClaudeStreamAccumulator`.
 * @param {object} evt — one parsed stream event.
 * @param {string} [now] — ISO timestamp; overridable for tests.
 * @returns {object} The same accumulator, mutated.
 */
export function applyClaudeStreamEvent(acc, evt, now = new Date().toISOString()) {
  acc.events += 1;
  acc.lastActivity = now;

  const type = evt?.type;
  if (type === "system" && evt.subtype === "init") {
    if (typeof evt.session_id === "string" && evt.session_id) {
      acc.sessionIdFromInit = evt.session_id;
    }
  } else if (type === "rate_limit_event") {
    if (evt.rate_limit_info && typeof evt.rate_limit_info === "object") {
      acc.rateLimit = { info: evt.rate_limit_info, observedAt: now };
    }
  } else if (type === "assistant") {
    const message = evt.message;
    if (message && typeof message === "object") {
      if (typeof message.model === "string" && message.model && !acc.models.includes(message.model)) {
        acc.models.push(message.model);
      }
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (block && typeof block === "object" && block.type === "tool_use") {
          acc.steps += 1;
          if (typeof block.name === "string" && block.name) acc.lastTool = block.name;
        }
      }
    }
  } else if (type === "result") {
    acc.resultEvent = evt;
  }
  return acc;
}
