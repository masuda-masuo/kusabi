// tool-stats.mjs — fold per-tool usage from a job event stream.
//
// Tool activity arrives as `message.part.updated` events whose
// `properties.part.type === "tool"`.  ONE tool call emits MULTIPLE such
// events as its state advances (pending → running → completed), so counts
// fold per `properties.part.id` with last state winning.  Counting raw
// events triple-counts.
//
// Success / failure is decided only by the part's terminal `state.status`:
// `completed` is success; any other last state (including a part that never
// reached a terminal state by the end of the stream) is failure.  Error
// text is never inspected.
//
// Ingest and report consume this module's output; they do not re-implement
// the fold.

/**
 * Stable tool surface for zero-fill.  Seeded with the sunaba MCP names the
 * worker agents actually hold, plus the opencode built-ins referenced in
 * this repo's fixtures (`WRITE_TOOL_NAMES` and `skill`).  Easy to extend:
 * append a name, do not reorder unless you intend to change report order.
 */
export const KNOWN_TOOLS = Object.freeze([
  "sunaba_sandbox_attach",
  "sunaba_read_file_range",
  "sunaba_search_in_container",
  "sunaba_list_files",
  "sunaba_diff_in_container",
  "sunaba_issue_view",
  "sunaba_write_file",
  "sunaba_edit_file",
  "sunaba_transform_file",
  "sunaba_undo_file_edit",
  "sunaba_checkpoint",
  "sunaba_checkpoint_restore",
  "sunaba_checkpoint_list",
  "sunaba_package_install",
  "sunaba_sandbox_exec",
  "sunaba_sandbox_exec_background",
  "sunaba_sandbox_exec_check",
  "sunaba_run_python",
  "sunaba_verify_in_container",
  "sunaba_lint_in_container",
  "sunaba_type_check_in_container",
  "sunaba_sandbox_issue_write",
  "bash",
  "edit",
  "write",
  "patch",
  "task",
  "skill",
]);

function emptyCounts() {
  return { count: 0, success: 0, failure: 0 };
}

function copyCounts(s) {
  return {
    count: s?.count ?? 0,
    success: s?.success ?? 0,
    failure: s?.failure ?? 0,
  };
}

function asEvent(line) {
  if (line == null) return null;
  if (typeof line === "object") return line;
  if (typeof line !== "string") return null;
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Fold tool-part events per `part.id` (last state wins) and return
 * `{ [tool]: { count, success, failure } }`.
 *
 * `lines` is iterator-friendly: an iterable of NDJSON strings or already-
 * parsed event objects, or a single NDJSON string (split on newlines).
 * Malformed lines are skipped, never thrown.
 *
 * @param {Iterable<string|object>|string|null|undefined} lines
 * @returns {Record<string, { count: number, success: number, failure: number }>}
 */
export function extractToolStats(lines) {
  if (lines == null) return {};
  const iterable = typeof lines === "string" ? lines.split(/\r?\n/) : lines;

  // id → last { tool, status }.  Last event for an id overwrites.
  const parts = new Map();
  for (const line of iterable) {
    const ev = asEvent(line);
    if (!ev || ev.type !== "message.part.updated") continue;
    const part = ev.properties && ev.properties.part;
    if (!part || part.type !== "tool") continue;
    const id = part.id;
    if (typeof id !== "string" || !id) continue;
    const prev = parts.get(id) || {};
    const tool = typeof part.tool === "string" && part.tool ? part.tool : prev.tool;
    const status = (part.state && typeof part.state.status === "string")
      ? part.state.status
      : prev.status;
    parts.set(id, { tool, status });
  }

  const stats = {};
  for (const { tool, status } of parts.values()) {
    if (typeof tool !== "string" || !tool) continue;
    if (!stats[tool]) stats[tool] = emptyCounts();
    stats[tool].count += 1;
    if (status === "completed") stats[tool].success += 1;
    else stats[tool].failure += 1;
  }
  return stats;
}

/**
 * Zero-fill over `KNOWN_TOOLS` while preserving tools observed outside the
 * known set under their observed name.  Unknown tools are reported, never
 * dropped.  Known tools always present as `{0,0,0}` when unused.
 *
 * @param {Record<string, { count?: number, success?: number, failure?: number }>|null|undefined} stats
 * @returns {Record<string, { count: number, success: number, failure: number }>}
 */
export function normalizeToolStats(stats) {
  const src = stats && typeof stats === "object" ? stats : {};
  const out = {};
  for (const tool of KNOWN_TOOLS) {
    out[tool] = src[tool] ? copyCounts(src[tool]) : emptyCounts();
  }
  for (const [tool, s] of Object.entries(src)) {
    if (Object.prototype.hasOwnProperty.call(out, tool)) continue;
    out[tool] = copyCounts(s);
  }
  return out;
}

/**
 * Known tools in declared order, then unknown-but-observed tools sorted by
 * name.  Used by the report so the schema does not wobble between windows.
 *
 * @param {Record<string, { count?: number, success?: number, failure?: number }>|null|undefined} stats
 * @returns {Array<{ tool: string, count: number, success: number, failure: number }>}
 */
export function listToolStats(stats) {
  const normalized = normalizeToolStats(stats);
  const known = new Set(KNOWN_TOOLS);
  const rows = [];
  for (const tool of KNOWN_TOOLS) {
    rows.push({ tool, ...normalized[tool] });
  }
  const extra = Object.keys(normalized).filter((t) => !known.has(t)).sort();
  for (const tool of extra) {
    rows.push({ tool, ...normalized[tool] });
  }
  return rows;
}
