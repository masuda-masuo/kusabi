// claude-watchdogs.mjs — claude backend watchdog helpers (kusabi #215 item 3, #234).
//
// Split out of claude-dispatch.mjs (pure move, no behaviour change): the
// write-tool watchdog (time since the last file-mutating tool call on an
// implement phase) and the repeat-tool watchdog (a chain of consecutive
// identical tool calls).  Both are pure helpers; the timers that use them
// live in runClaudeProcess (claude-dispatch.mjs).  Pure: no imports.

// =========================================================================
// write-tool watchdog — pure helpers (kusabi #215 item 3)
// =========================================================================
//
// The silence watchdog above measures whether ANY parsed stream event
// arrives.  A worker that reads files forever holds it off indefinitely —
// which is exactly the recorded incident (kusabi #215): an implement-phase
// job that ran 256s, cost $2.39, and produced ZERO edits.  This watchdog
// measures the other quantity: how long a phase whose whole job is to
// produce edits has gone without calling a file-mutating tool.
//
// Three deliberate conservatisms, because a false positive here KILLS a
// live job (unlike the session guard, which merely refuses to start one):
//   - OFF unless the config asks for it (no config key → byte-identical to
//     the pre-#215-item-3 dispatch),
//   - it WARNS before it kills, and killing is opt-in on top of warning
//     (`killS` absent or 0 → warn-only forever), and
//   - a malformed config resolves to warn-only, NEVER to a killing
//     configuration.  This deliberately differs from the session guard's
//     "malformed → default ON" rule: refusing a dispatch is conservative,
//     killing a live job is destructive.

// The default warn bound (seconds) used when the feature is enabled without
// a readable `warnS`.  Five minutes: long enough that legitimate long reads
// (a big diff, a slow verify, a wide search sweep) do not trip it.
export const CLAUDE_WRITE_WATCHDOG_DEFAULT_WARN_S = 300;

// Phases whose deliverable IS a file edit.  Review / respond / gofer /
// plan legitimately never write, so the watchdog
// must never be armed for them.  Chain REWORK rounds are covered: they dispatch
// through runImplementPhase (chain-phases.mjs), which passes
// `phase: "implement"` for every round — `models.phases.rework` selects the
// MODEL for those rounds, it is not a dispatch phase name.  test-author's
// deliverable is a test file edit (same rationale as implement), so it is in
// the set; plan is read-only and stays out (kusabi #408 / #409).
const WRITE_WATCHDOG_PHASES = new Set(["implement", "test-author"]);

/**
 * Is this a phase the write watchdog may be armed for?
 *
 * @param {string|null|undefined} phase
 * @returns {boolean} false for every non-implement phase, and for no phase
 *          at all (a dispatch that names no phase is never gated on).
 */
export function writeWatchdogAppliesToPhase(phase) {
  return typeof phase === "string" && WRITE_WATCHDOG_PHASES.has(phase);
}

// What counts as "the worker actually changed a file".  The sunaba MCP
// mutators (addressed as `mcp__sunaba__<tool>`, but matched on the bare name
// so a differently-named server still matches) plus the CLI's own native
// editing tools — a worker running outside the sunaba sandbox edits through
// those.  Reads, searches, `sandbox_exec`, `verify_in_container` and
// `checkpoint` are deliberately absent: they are what a busy-but-producing-
// nothing worker does all day, and counting them would recreate the blind
// spot this watchdog exists to close.  `checkpoint_restore` IS here (it
// mutates the tree) while `checkpoint` is not (it only commits what is
// already there).
const CLAUDE_WRITE_TOOL_NAMES = new Set([
  "write_file",
  "edit_file",
  "transform_file",
  "undo_file_edit",
  "checkpoint_restore",
  // Claude Code's native editing tools.
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

/**
 * Does this `tool_use` name denote a file-mutating tool?
 *
 * The `mcp__<server>__` prefix is stripped before matching, so the same
 * table covers `mcp__sunaba__edit_file`, a differently-named MCP server,
 * and the native `Edit`.  Matching is case-sensitive: the native tools are
 * capitalized and the MCP ones are not, and the CLI reports both verbatim.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isClaudeWriteToolName(name) {
  if (typeof name !== "string" || !name) return false;
  const bare = /^mcp__(.+?)__(.+)$/.exec(name)?.[2] ?? name;
  return CLAUDE_WRITE_TOOL_NAMES.has(bare);
}

/**
 * Does this parsed stream event carry at least one write-tool call?
 *
 * Reads the same `assistant` → `message.content[] → tool_use` path
 * `applyClaudeStreamEvent` folds, so the two can never disagree about what
 * a tool call is.
 *
 * @param {object|null} evt — one parsed stream event.
 * @returns {boolean}
 */
export function eventHasClaudeWriteTool(evt) {
  if (!evt || typeof evt !== "object" || evt.type !== "assistant") return false;
  const message = evt.message;
  if (!message || typeof message !== "object") return false;
  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "tool_use" && isClaudeWriteToolName(block.name)) {
      return true;
    }
  }
  return false;
}

/**
 * A positive number of seconds from a config value.
 *
 * @param {unknown} raw
 * @returns {{ kind: "absent" } | { kind: "value", seconds: number } | { kind: "zero" } | { kind: "malformed" }}
 */
function watchdogSeconds(raw) {
  if (raw === undefined || raw === null) return { kind: "absent" };
  const parsed = typeof raw === "number"
    ? raw
    : (typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN);
  if (!Number.isFinite(parsed)) return { kind: "malformed" };
  if (parsed === 0) return { kind: "zero" };
  if (parsed < 0) return { kind: "malformed" };
  return { kind: "value", seconds: parsed };
}

/**
 * The write watchdog's settings for this dispatch.
 *
 * Config shape (`~/.kusabi/config.json`, the same file the session guard
 * reads):
 *
 *   { "claude": { "writeWatchdog": { "warnS": 300, "killS": 900 } } }
 *
 * Resolution table:
 *
 *   - no config file / not an object     → OFF, `no-config`
 *   - `claude.writeWatchdog` absent      → OFF, `absent`  (byte-identical
 *                                          to the pre-item-3 dispatch)
 *   - `false` / `0` / a negative number
 *     (quoted or not)                    → OFF, `disabled` (the session
 *                                          guard's `false / 0 / <0 → OFF`
 *                                          convention, same config file)
 *   - `true`                             → warn-only at the default warnS,
 *                                          `default`
 *   - `{ warnS }`                        → warn-only at warnS, `configured`
 *   - `{ warnS, killS }` with killS>warnS→ warn then kill, `configured`
 *   - `killS` absent / `0`               → warn-only (killing is opt-in ON
 *                                          TOP of warning)
 *   - `killS <= warnS`                   → warn-only, `kill-not-after-warn`.
 *                                          NORMALIZING it upward would kill
 *                                          a job on a bound the operator
 *                                          never wrote; the watchdog's whole
 *                                          contract is "warn BEFORE kill", so
 *                                          a kill that cannot come after the
 *                                          warning is dropped, not moved.
 *   - any malformed value (a string, a
 *     positive bare number, an array; or
 *     malformed warnS/killS fields)      → warn-only at the default (or at a
 *                                          readable warnS), `malformed-setting`.
 *                                          A malformed config NEVER yields a
 *                                          killing configuration.
 *
 * @param {object|null|undefined} config — output of loadClaudeGuardConfig().
 * @returns {{ enabled: boolean, warnS: number|null, killS: number|null, reason: string }}
 */
export function resolveClaudeWriteWatchdog(config) {
  const off = (reason) => ({ enabled: false, warnS: null, killS: null, reason });
  if (config === null || config === undefined || typeof config !== "object" || Array.isArray(config)) {
    return off("no-config");
  }
  const claude = config.claude === null || typeof config.claude !== "object" || Array.isArray(config.claude)
    ? undefined
    : config.claude;
  const raw = claude?.writeWatchdog;
  if (raw === undefined || raw === null) return off("absent");
  if (raw === false) return off("disabled");
  // `0` (and any non-positive number, quoted or not) is OFF, matching the
  // session guard's documented `false / 0 / <0 → OFF` convention — and its
  // string coercion — in this same config file: an operator who disables
  // one guard with 0 (or "0") must not silently arm the other.
  const sectionNum = typeof raw === "number"
    ? raw
    : (typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN);
  if (Number.isFinite(sectionNum) && sectionNum <= 0) return off("disabled");
  if (raw === true) {
    return { enabled: true, warnS: CLAUDE_WRITE_WATCHDOG_DEFAULT_WARN_S, killS: null, reason: "default" };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    // The operator asked for the feature in a shape this does not
    // understand: honor the ask at its most conservative setting rather
    // than silently ignoring it, but never with a kill.
    return { enabled: true, warnS: CLAUDE_WRITE_WATCHDOG_DEFAULT_WARN_S, killS: null, reason: "malformed-setting" };
  }

  const warn = watchdogSeconds(raw.warnS);
  const kill = watchdogSeconds(raw.killS);
  // `warnS: 0` is not "warn immediately" — it is a value nobody means, so it
  // reads as malformed rather than as an instant warning on every job.
  const warnMalformed = warn.kind === "malformed" || warn.kind === "zero";
  const warnS = warn.kind === "value" ? warn.seconds : CLAUDE_WRITE_WATCHDOG_DEFAULT_WARN_S;

  if (warnMalformed || kill.kind === "malformed") {
    return { enabled: true, warnS, killS: null, reason: "malformed-setting" };
  }
  if (kill.kind === "absent" || kill.kind === "zero") {
    return { enabled: true, warnS, killS: null, reason: warn.kind === "value" ? "configured" : "default" };
  }
  if (kill.seconds <= warnS) {
    return { enabled: true, warnS, killS: null, reason: "kill-not-after-warn" };
  }
  return { enabled: true, warnS, killS: kill.seconds, reason: "configured" };
}

/**
 * The job's `error` text when the write watchdog killed the run.  Distinct
 * from the silence watchdog's wording on purpose: the two failures have
 * different causes and different fixes, and a reader must never have to
 * guess which one fired.  The bound named is the CONFIGURED `killS` (the
 * measured idle seconds go into the events, exactly as the silence watchdog
 * splits them).
 *
 * @param {number} killS
 * @returns {string}
 */
export function renderClaudeWriteWatchdogError(killS) {
  return `write-watchdog: no write-tool call for ${killS}s on an implement phase (process killed)`;
}

// =========================================================================
// repeat-tool watchdog — pure helpers (kusabi #234)
// =========================================================================
//
// The silence watchdog measures whether ANY parsed stream event arrives,
// and the write watchdog measures how long a phase whose whole job is to
// produce edits has gone without a file-mutating tool call.  Both are
// TIME-based, so a worker that repeats the SAME tool call with the SAME
// arguments holds both clocks off forever: every call is a parsed event
// (silence clock reset) and, for a write tool, every call is a write (write
// clock reset).  The recorded neighbour failure (kusabi #215 item 3) was
// "chatty but never writing"; this one is "chatty, writing, and saying the
// same thing every time".
//
// This watchdog counts, not times: a CHAIN keyed on `(tool name,
// deep-key-sorted JSON.stringify(input))` folds at the same point the write
// watchdog already observes (assistant event → message.content[] → tool_use
// blocks), so it needs no new I/O.  At `threshold` consecutive identical
// calls it warns once (`companion.repeat-watchdog.warned`, also recorded on
// the job), and at `killThreshold` it kills the child's process group
// exactly as its two siblings do.
//
// Adopted from deepseek-harness's repeat-tool-reminder (shiori-indexed):
//   - argument normalization is deep key sort + JSON.stringify, so two
//     inputs differing only in property ORDER count as identical;
//   - calls of UNTRACKED bookkeeping tools are TRANSPARENT to the chain —
//     they neither increment nor reset it, so `edit_file X → TodoWrite →
//     edit_file X` still counts as two consecutive `edit_file X`.  The
//     untracked list exists ONLY to keep bookkeeping tools from laundering
//     a loop (or being laundered by one); a bookkeeping tool that is itself
//     the repeated call is detected like any other;
//   - DENIED calls count: kusabi is allowlist-based, so a model hammering a
//     tool kusabi refuses is exactly the loop to break;
//   - invalid threshold settings fail LOUDLY at load — never a silent
//     fallback, never a killing configuration the operator did not write;
//   - the identity comparison always uses the FULL normalized string; the
//     truncated preview that goes into events is a record, never a
//     comparison input.
// Not adopted: dsh's advisory injection (kusabi observes the NDJSON from
// outside `claude -p` and has no path to inject a nudge into the running
// child — warn and kill are the only levers) and fuzzy/approximate argument
// matching (a one-character variation escapes; that is accepted).
//
// The one deliberate difference from the two siblings: this watchdog is
// count-based, not time-based — there is no clock to poll, the chain folds
// synchronously at line delivery, and the kill lands the instant the
// `killThreshold`-th identical call arrives.

// How much of the normalized arguments the warned/fired events carry.  The
// full normalized string can be huge (a repeated edit of a big file); the
// preview is truncated to this many characters for the record.  Identity
// comparison NEVER uses the preview (kusabi #234 invariant 5) — the chain
// key always carries the complete string.
export const CLAUDE_REPEAT_ARGS_PREVIEW_MAX = 200;

// Bookkeeping tools that are TRANSPARENT to the chain: calling one neither
// increments nor resets the consecutive-identical count.  `TodoWrite` is
// Claude Code's native progress bookkeeping (the deepseek-harness precedent
// is `todo_write`; both spellings are matched after the `mcp__<server>__`
// prefix is stripped, so a differently-named MCP server still matches).
// This list exists ONLY to keep bookkeeping tools from laundering a loop —
// a tool on this list that is ITSELF the repeated call is detected like any
// other, because transparency means "ignored", not "exempt".
const CLAUDE_REPEAT_UNTRACKED_TOOL_NAMES = new Set(["TodoWrite", "todo_write"]);

/**
 * Is this `tool_use` name a bookkeeping tool the chain is transparent to?
 * Same prefix-stripping and case-sensitivity discipline as
 * isClaudeWriteToolName.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isClaudeRepeatUntrackedToolName(name) {
  if (typeof name !== "string" || !name) return false;
  const bare = /^mcp__(.+?)__(.+)$/.exec(name)?.[2] ?? name;
  return CLAUDE_REPEAT_UNTRACKED_TOOL_NAMES.has(bare);
}

/**
 * Deep key-sorted JSON: object keys are sorted recursively (arrays keep
 * their order — element order is part of the arguments), so two inputs
 * differing only in property order normalize identically.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function deepSortedJson(value) {
  if (Array.isArray(value)) return value.map(deepSortedJson);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = deepSortedJson(value[key]);
    return out;
  }
  return value;
}

/**
 * Normalize a tool call's `input` into the identity string the chain
 * compares.  Deep key sort + JSON.stringify (kusabi #234): property ORDER
 * is not part of the arguments, so `{a:1,b:2}` and `{b:2,a:1}` must count
 * as the same call.  An absent input normalizes to `{}` — the empty
 * arguments, not a distinct identity.
 *
 * @param {unknown} input — the `tool_use` block's `input` (present in real
 *        transcripts; transcript-ingest.mjs stringifies it the same way).
 * @returns {string} — the full normalized string; ALWAYS complete, never
 *          truncated.  Only the event preview (claudeRepeatArgsPreview) is
 *          ever cut, and the comparison never reads it.
 */
export function normalizeClaudeRepeatArgs(input) {
  if (input === undefined || input === null) return "{}";
  return JSON.stringify(deepSortedJson(input));
}

/**
 * The chain key for one tracked call: `(tool name, normalized input)`.
 * The NUL separator is unambiguous — tool names never contain one.
 *
 * @param {string} name — the bare tool name as the stream reported it.
 * @param {unknown} input — the `tool_use` block's `input`.
 * @returns {string}
 */
export function claudeRepeatChainKey(name, input) {
  return `${name}\u0000${normalizeClaudeRepeatArgs(input)}`;
}

/**
 * The truncated args preview that goes into the warned/fired events: the
 * first CLAUDE_REPEAT_ARGS_PREVIEW_MAX characters of the normalized string,
 * with a trailing ellipsis when it was cut.  A record, never a comparison
 * input (kusabi #234 invariant 5).
 *
 * @param {string} chainKey — output of claudeRepeatChainKey.
 * @returns {string}
 */
export function claudeRepeatArgsPreview(chainKey) {
  const normalized = chainKey.slice(chainKey.indexOf("\u0000") + 1);
  return normalized.length > CLAUDE_REPEAT_ARGS_PREVIEW_MAX
    ? `${normalized.slice(0, CLAUDE_REPEAT_ARGS_PREVIEW_MAX)}…`
    : normalized;
}

/**
 * Advance the consecutive-identical chain by one tracked call.  A call
 * whose key equals the current chain's key increments the count; any other
 * key starts a new chain at count 1.
 *
 * @param {{key: string, count: number}|null} chain — the current chain
 *        state, or null before the first tracked call.
 * @param {string} key — output of claudeRepeatChainKey for the call.
 * @returns {{key: string, count: number}}
 */
export function claudeRepeatChainAdvance(chain, key) {
  if (chain !== null && chain.key === key) return { key, count: chain.count + 1 };
  return { key, count: 1 };
}

/**
 * Fold one parsed stream event's tool_use blocks into the caller's chain,
 * in stream order.  Reads the SAME `assistant` → `message.content[]` →
 * `tool_use` path eventHasClaudeWriteTool and applyClaudeStreamEvent fold,
 * so the three can never disagree about what a tool call is.  Untracked
 * bookkeeping tools are skipped entirely (transparent — no callback).
 *
 * @param {object|null} evt — one parsed stream event.
 * @param {(toolName: string, chainKey: string) => void} onCall — called for
 *        every TRACKED tool_use block, in stream order, with the bare tool
 *        name and its chain key.
 */
export function foldClaudeRepeatCalls(evt, onCall) {
  if (!evt || typeof evt !== "object" || evt.type !== "assistant") return;
  const message = evt.message;
  if (!message || typeof message !== "object") return;
  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (!block || typeof block !== "object" || block.type !== "tool_use") continue;
    if (typeof block.name !== "string" || !block.name) continue;
    if (isClaudeRepeatUntrackedToolName(block.name)) continue;
    onCall(block.name, claudeRepeatChainKey(block.name, block.input));
  }
}

/**
 * The repeat watchdog's settings for this dispatch.
 *
 * Config shape (`~/.kusabi/config.json`, the same file the session guard
 * and the write watchdog read):
 *
 *   { "claude": { "repeatWatchdog": { "threshold": 5, "killThreshold": 12 } } }
 *
 * Resolution table:
 *
 *   - no config file / not an object     → OFF, `no-config`
 *   - `claude.repeatWatchdog` absent     → OFF, `absent` (byte-identical to
 *                                          the pre-#234 dispatch)
 *   - `{ threshold, killThreshold }` with
 *     integers, threshold >= 2 and
 *     killThreshold > threshold          → ON, `configured` (numeric strings
 *                                          read, like the write watchdog's
 *                                          quoted seconds)
 *   - ANY other present value (missing /
 *     non-integer / sub-2 / non-increasing
 *     thresholds; `true`, `false`, `0`,
 *     a bare string, an array)           → THROWS.  A config error must fail
 *                                          the dispatch LOUDLY before any
 *                                          job record exists — never a
 *                                          silent fallback to off, and never
 *                                          a killing configuration the
 *                                          operator did not write.  This
 *                                          deliberately differs from the
 *                                          write watchdog's fail-open
 *                                          resolution: that one is
 *                                          time-based and can afford a
 *                                          warn-only fallback, while a
 *                                          count watchdog has no warn-only
 *                                          shape — there is no safe reading
 *                                          of a malformed threshold.
 *
 * @param {object|null|undefined} config — output of loadClaudeGuardConfig().
 * @returns {{ enabled: boolean, threshold: number|null, killThreshold: number|null, reason: string }}
 * @throws {Error} for a present-but-invalid `claude.repeatWatchdog` value.
 */
export function resolveClaudeRepeatWatchdog(config) {
  const off = (reason) => ({ enabled: false, threshold: null, killThreshold: null, reason });
  if (config === null || config === undefined || typeof config !== "object" || Array.isArray(config)) {
    return off("no-config");
  }
  const claude = config.claude === null || typeof config.claude !== "object" || Array.isArray(config.claude)
    ? undefined
    : config.claude;
  const raw = claude?.repeatWatchdog;
  if (raw === undefined || raw === null) return off("absent");
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `claude.repeatWatchdog must be an object { threshold, killThreshold } — got ${describeConfigValue(raw)}`,
    );
  }
  const threshold = repeatWatchdogCount(raw.threshold, "threshold");
  const killThreshold = repeatWatchdogCount(raw.killThreshold, "killThreshold");
  if (killThreshold <= threshold) {
    throw new Error(
      `claude.repeatWatchdog.killThreshold (${killThreshold}) must be strictly greater than threshold (${threshold})`,
    );
  }
  return { enabled: true, threshold, killThreshold, reason: "configured" };
}

/** One threshold of the repeat watchdog: a finite integer >= 2. */
function repeatWatchdogCount(raw, key) {
  if (raw === undefined || raw === null) {
    throw new Error(`claude.repeatWatchdog.${key} is required — got ${describeConfigValue(raw)}`);
  }
  const parsed = typeof raw === "number"
    ? raw
    : (typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 2) {
    throw new Error(`claude.repeatWatchdog.${key} must be an integer >= 2 — got ${describeConfigValue(raw)}`);
  }
  return parsed;
}

/** A config value rendered for an error message. */
function describeConfigValue(raw) {
  if (typeof raw === "number" && Number.isNaN(raw)) return "NaN";
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

/**
 * The job's `error` text when the repeat watchdog killed the run.  Distinct
 * from BOTH siblings' wording on purpose: three failures with three
 * different causes and fixes must never be mistakable for one another.  The
 * measured count and the repeated tool are the diagnosis (the configured
 * thresholds ride in the events, exactly as the siblings split measured vs.
 * configured).
 *
 * @param {string} tool — the repeated tool's name as the stream reported it.
 * @param {number} count — the consecutive-identical count at the kill.
 * @returns {string}
 */
export function renderClaudeRepeatWatchdogError(tool, count) {
  return `repeat-watchdog: ${tool} called ${count} consecutive times with identical arguments on an implement phase (process killed)`;
}
