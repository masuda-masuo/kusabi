// codex-stream.mjs — Codex NDJSON stream parsing and usage mapping (pure).
//
// Split out of codex-dispatch.mjs (pure move, no behaviour change): parsing
// lines of the NDJSON event stream, extracting thread IDs and assistant text,
// folding events into a stream accumulator, and mapping terminal usage.

// =========================================================================
// stream parsing — pure
// =========================================================================

/**
 * Parse one line of the codex NDJSON stream.  Returns null for blank lines
 * and non-JSON prose (the same tolerance every backend applies).
 *
 * @param {string} line
 * @returns {object|null}
 */
export function parseCodexStreamLine(line) {
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
 * Pull the thread id off a `thread.started` event (measured: top-level
 * `thread_id`).  This is the thread/session id the job records as sessionID
 * and the resume invocation passes back.
 *
 * @param {object} evt
 * @returns {string|null}
 */
export function codexThreadIdFromEvent(evt) {
  return typeof evt?.thread_id === "string" && evt.thread_id ? evt.thread_id : null;
}

/**
 * Extract assistant text from an `item.completed` event.
 *
 * Two measured shapes:
 *   - CURRENT flat shape (live codex-cli 0.154.0, incident
 *     mission-mucn5qb2a76e2095): `item.type === "agent_message"` with the
 *     terminal text on `item.text`.
 *   - LEGACY nested shape (the previously measured contract):
 *     `item.agent_message.text`.
 *
 * Non-agent items (tool_call, custom_tool_call, ...) and malformed shapes
 * contribute no text and never throw.
 *
 * @param {object} evt
 * @returns {string}
 */
export function codexAssistantTextFromEvent(evt) {
  const item = evt?.item;
  if (!item || typeof item !== "object") return "";
  if (item.type === "agent_message" && typeof item.text === "string") {
    return item.text;
  }
  const legacy = item.agent_message?.text;
  return typeof legacy === "string" ? legacy : "";
}

/**
 * A fresh accumulator for folding a codex NDJSON stream into job stats.
 *
 * @returns {{ events: number, steps: number, lastTool: string|null,
 *             lastActivity: string|null, models: string[],
 *             threadId: string|null, assistantText: string,
 *             usageEvent: object|null }}
 */
export function initCodexStreamAccumulator() {
  return {
    events: 0,
    steps: 0,
    lastTool: null,
    lastActivity: null,
    models: [],
    threadId: null,
    assistantText: "",
    usageEvent: null,
  };
}

/**
 * Fold one parsed stream event into the accumulator (mutates and returns
 * it).  Every parsed object bumps `events` and `lastActivity`; the measured
 * kinds contribute:
 *
 *   - `thread.started` — the thread id (top-level `thread_id`).
 *   - `item.completed` — assistant text from `item.agent_message.text`
 *     (terminal text for both the text and `--output-schema` framings);
 *     counts as a step only for tool items (any item.type other than
 *     agent_message and reasoning); sets lastTool ("shell" for
 *     command_execution, item.tool for mcp_tool_call, else item.type).
 *   - `turn.completed` — the `usage` event kept as `usageEvent`; a later one
 *     replaces an earlier one.
 *
 * Unknown kinds and malformed shapes must not throw.
 *
 * @param {object} acc
 * @param {object} evt
 * @param {string} [now]
 * @returns {object}
 */
export function applyCodexStreamEvent(acc, evt, now = new Date().toISOString()) {
  if (!acc || typeof acc !== "object") return acc;
  if (!evt || typeof evt !== "object") return acc;
  acc.events += 1;
  acc.lastActivity = now;
  try {
    const type = evt.type;
    if (type === "thread.started") {
      const id = codexThreadIdFromEvent(evt);
      if (id) acc.threadId = id;
    } else if (type === "item.completed") {
      const item = evt.item;
      const itemType = typeof item?.type === "string" ? item.type : null;
      if (itemType !== null && itemType !== "agent_message" && itemType !== "reasoning") {
        acc.steps += 1;
        if (itemType === "command_execution") {
          acc.lastTool = "shell";
        } else if (itemType === "mcp_tool_call") {
          acc.lastTool = typeof item.tool === "string" && item.tool ? item.tool : itemType;
        } else {
          acc.lastTool = itemType;
        }
      }
      // The LAST agent message is the answer; earlier ones are commentary.
      // A turn can complete several agent_message items (phase commentary
      // before tool calls, then final_answer); concatenating them glued
      // three JSONL batches together with no separator and the coordinator
      // parser refused the whole stream as truncated (mission-mudmmnaub60f0b20,
      // job-mudmn0ba8267: 481 + 555 + 555 = the 1591 assistantChars recorded).
      const text = codexAssistantTextFromEvent(evt);
      if (text) acc.assistantText = text;
    } else if (type === "turn.completed") {
      acc.usageEvent = evt;
    }
  } catch {
    // A malformed event must never take down the dispatch.
  }
  return acc;
}

/**
 * Map the terminal `turn.completed.usage` object onto the job-record usage
 * shape the other backends already store.  MEASURED snake-case token fields
 * (codex-cli 0.154.0, same vocabulary codex-usage-ingest.mjs reads):
 * input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens.
 * `total_tokens` / `reasoning_tokens` / `cost_usd` are mapped when present;
 * no total is derived from the component counters.
 *
 * @param {object|null} result
 * @returns {object}
 */
export function mapCodexUsage(result) {
  const u = result?.usage ?? {};
  return {
    available: true,
    input: typeof u.input_tokens === "number" ? u.input_tokens : null,
    output: typeof u.output_tokens === "number" ? u.output_tokens : null,
    reasoning: typeof u.reasoning_tokens === "number" ? u.reasoning_tokens : null,
    cacheRead: typeof u.cached_input_tokens === "number" ? u.cached_input_tokens : null,
    cacheWrite: typeof u.cache_write_input_tokens === "number" ? u.cache_write_input_tokens : null,
    total: typeof u.total_tokens === "number" ? u.total_tokens : null,
    cost: typeof u.cost_usd === "number" ? u.cost_usd : null,
    model: result?.model ?? null,
  };
}

/**
 * A short, faithful description of what arrived — quoted into failure
 * messages so the error names the received payload.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function describeCodexResult(value) {
  if (value === null || value === undefined) return "(nothing)";
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

