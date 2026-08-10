// result-recovery.mjs — recover a completed job's result when the model never
// emitted a final message (kusabi #198).
//
// The defect this exists for: a job finishes `completed`, spends tens of
// thousands of tokens, and writes a 0-byte result.md that surfaces as
// "(empty result)".  The session went idle with the model still mid-analysis,
// so no final assistant message was ever produced and there was nothing for
// the dispatcher to fetch — while the model's whole output sat on disk the
// entire time.  Measured on job-msn8ktw24af4: events.ndjson 1,820,562 B
// holding 32,870 characters of substantive review, result.md 0 B.  Observed
// three times on 2026-08-10; each time the reviewer looked silent, none was.
//
// Two properties everything below is built around.
//
// DETERMINISTIC.  Recovery reads local files and nothing else: no LLM, no
// network call, no re-dispatch.  The same recorded input yields the same text
// byte for byte, every time.  This is the line between recovery and `salvage`
// (kusabi-companion.mjs), which hands the last 50 events to a model for a
// post-mortem — useful, but not reproducible and not a result.
//
// THE SOURCE IS SELECTED BY BACKEND.  Both backends keep a complete record;
// only its location differs, so location is the only thing that varies:
//
//   opencode — the job's own `events.ndjson`.  The companion subscribes to the
//     server's SSE stream and appends every event it accepts, so the output is
//     in the job directory already.  (Measured: on 18 of 18 sampled opencode
//     jobs the existing result.md text is fully contained in what the event
//     stream yields.)
//
//   claude — Claude Code's own transcript,
//     ~/.claude/projects/<mangled-cwd>/<session-id>.jsonl.  This backend runs
//     `claude -p` as a child process and never sees a stream to record, so the
//     job's events.ndjson holds only two bookkeeping events (208 B on all 7
//     sampled jobs) while the transcript holds everything.
//
// A recovery that handled one and not the other would be half a fix, so the
// two live behind one `RECOVERY_SOURCES` map keyed by backend, returning one
// shape.  Both dispatchers call `resolveCompletedResult` and branch on nothing.
//
// Nothing here throws.  A missing, empty, truncated or unrecognisably shaped
// source is a normal outcome — the user pruned a transcript, the job ran on
// another machine, the process died mid-write — and it degrades to "recovered
// nothing", never to a failed dispatch.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// =========================================================================
// marking — a recovered result is not a final message
// =========================================================================

/**
 * Machine-readable marker on the first line of every recovered result.md.
 *
 * A recovered result is a different artifact from a final assistant message:
 * the stream it came from ended mid-flight, so the text can break off
 * mid-sentence.  Whoever reads the file — an operator, `kusabi result`, a
 * later phase quoting it — must be able to see that from the file itself,
 * without cross-checking job.json.
 */
export const RECOVERED_RESULT_MARKER = "<!-- kusabi:recovered-result -->";

/**
 * Prefix `text` with the recovery banner.
 *
 * The banner deliberately contains no braces and no fenced code block: the
 * verdict extraction in `extractJson` (render.mjs) reads a fenced block, or
 * else the span from the first brace to the last, and a banner carrying
 * either would corrupt the parse of a recovered review that does contain a
 * verdict.
 *
 * @param {string} text       — the reconstructed model output.
 * @param {string} sourceDesc — human phrase naming where it came from.
 * @returns {string}
 */
export function markRecovered(text, sourceDesc) {
  return [
    RECOVERED_RESULT_MARKER,
    "**Recovered result — this job never produced a final message.**",
    `Reconstructed without a model, from ${sourceDesc}.`,
    "It is the model's own output in the order it was produced, and it may break off mid-sentence.",
    "",
    "---",
    "",
    "",
  ].join("\n") + text;
}

/**
 * Read a file, or null when it cannot be read for any reason.
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function readFileOrNull(filePath) {
  if (typeof filePath !== "string" || !filePath) return null;
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    // Missing, unreadable, a directory: all the same answer here.
    return null;
  }
}

// =========================================================================
// source: opencode — the job's recorded event stream
// =========================================================================

/**
 * Fold one streamed text update into what has already been collected for the
 * same part.
 *
 * The stream carries a part's text more than once: it arrives on
 * `message.part.delta` and again on a later `message.part.updated`.  The two
 * carry different semantics, and `kind` says which — taken from the event
 * shape by `textPartUpdate`, not guessed from the strings:
 *
 *   - `"delta"` (flat `partID`/`delta`) is an incremental chunk.  Always
 *     append it.  A chunk is never a restatement of the buffer, so no
 *     prefix test may be applied to it.
 *   - `"snapshot"` (`part.text`) is the part's whole text so far.  Take the
 *     longer of buffer and incoming when one is a prefix of the other;
 *     otherwise append.
 *
 * Deciding this by prefix testing instead is what the first implementation
 * did, and it silently corrupted real output.  Measured on the 1.8 MB stream
 * of job `job-msn8ktw24af4`: 6,676 incremental chunks, **zero** grown
 * snapshots, and 2 legitimate chunks discarded because they happened to be a
 * prefix of the accumulated text — the words `"Let"` and `"N"`, which simply
 * vanished mid-sentence.  The rule was protecting against a case that did not
 * occur, at the cost of one that did.
 *
 * @param {string} buffer
 * @param {string} incoming
 * @returns {string}
 */
function mergeStreamedText(buffer, incoming, kind) {
  if (!incoming) return buffer;
  if (!buffer) return incoming;
  if (kind === "delta") return buffer + incoming;
  if (incoming.startsWith(buffer)) return incoming;
  if (buffer.startsWith(incoming)) return buffer;
  return buffer + incoming;
}

/**
 * Pull a text-part update out of one recorded event, or null when the event
 * carries none.
 *
 * Two shapes are accepted, because the recorded events are whatever the
 * server sent and the delta shape is not ours to fix:
 *
 *   properties.part = { id, messageID, type: "text", text }   (snapshot)
 *   properties = { partID, messageID, field: "text", delta }  (flat delta)
 *
 * Non-text parts (tool, step-start, reasoning) are not results and are
 * dropped here.
 *
 * @param {object} event
 * @returns {{ key: string, messageID: string|null, text: string }|null}
 */
function textPartUpdate(event) {
  const props = event?.properties;
  if (!props || typeof props !== "object") return null;

  const part = props.part;
  if (part && typeof part === "object") {
    if (part.type !== undefined && part.type !== "text") return null;
    if (typeof part.text !== "string") return null;
    const messageID = typeof part.messageID === "string" ? part.messageID
      : (typeof props.messageID === "string" ? props.messageID : null);
    const key = typeof part.id === "string" && part.id
      ? part.id
      : `${messageID ?? "unkeyed"}#text`;
    return { key, messageID, text: part.text, kind: "snapshot" };
  }

  if (props.field !== undefined && props.field !== "text") return null;
  const text = typeof props.delta === "string" ? props.delta
    : (typeof props.text === "string" ? props.text : null);
  if (text === null) return null;
  const partID = typeof props.partID === "string" ? props.partID : null;
  const messageID = typeof props.messageID === "string" ? props.messageID : null;
  if (!partID) return null;
  // `delta` is an incremental chunk; `text` on this flat shape is a whole-part
  // restatement, so it keeps snapshot semantics.
  const kind = typeof props.delta === "string" ? "delta" : "snapshot";
  return { key: partID, messageID, text, kind };
}

/**
 * Reconstruct an opencode job's output from its own `events.ndjson`.
 *
 * Walks the recorded events in order, keeps the text parts of ASSISTANT
 * messages only, and concatenates them.  Two traps, both found by doing this
 * by hand on a real 1.8 MB stream:
 *
 *   1. The same text appears more than once (delta, then updated).  Handled
 *      per part id by `mergeStreamedText`, so it lands exactly once.
 *   2. The prompt is in the stream too.  A recovery that collected every
 *      `text` value it could find produced output beginning with the whole
 *      brief — an echo of the input, not the model's answer.  The role of
 *      each message is therefore resolved from the `message.updated` events
 *      (`properties.info.id` → `properties.info.role`) and only assistant
 *      parts are kept; the user message carrying the prompt is dropped, and
 *      so is any part whose role cannot be established.  A part of unknown
 *      role is counted in `notes.skippedUnknownRole` so an empty recovery can
 *      be explained rather than guessed at.
 *
 * Distinct parts are joined with a newline and the whole trimmed — the same
 * shape `fetchFinalMessage` builds from a real final message.
 *
 * @param {string} eventsPath — path to the job's `events.ndjson`.
 * @returns {{ text: string, notes: object }}
 */
export function recoverFromOpencodeEvents(eventsPath) {
  const notes = {
    events: 0,
    malformed: 0,
    parts: 0,
    skippedNonAssistant: 0,
    skippedUnknownRole: 0,
  };

  const raw = readFileOrNull(eventsPath);
  if (raw === null) return { text: "", notes: { ...notes, reason: "events-file-unreadable" } };

  const roleByMessage = new Map();
  const updates = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // A truncated last line (the job died mid-write) or any other damage
      // costs that one line, never the recovery.
      notes.malformed += 1;
      continue;
    }
    if (!event || typeof event !== "object") {
      notes.malformed += 1;
      continue;
    }
    notes.events += 1;

    const type = String(event.type ?? "");
    if (type === "message.updated") {
      const info = event.properties?.info;
      if (info && typeof info === "object" && typeof info.id === "string" && typeof info.role === "string") {
        roleByMessage.set(info.id, info.role);
      }
      continue;
    }
    if (type !== "message.part.updated" && type !== "message.part.delta") continue;

    const update = textPartUpdate(event);
    if (update) updates.push(update);
  }

  // Second pass over the collected updates, not the file: a message's role
  // may be recorded after its first part arrives, so the map has to be
  // complete before any part is judged by it.
  const order = [];
  const buffers = new Map();
  for (const update of updates) {
    const role = update.messageID ? roleByMessage.get(update.messageID) : undefined;
    if (role === undefined) {
      notes.skippedUnknownRole += 1;
      continue;
    }
    if (role !== "assistant") {
      notes.skippedNonAssistant += 1;
      continue;
    }
    if (!buffers.has(update.key)) {
      buffers.set(update.key, "");
      order.push(update.key);
    }
    buffers.set(update.key, mergeStreamedText(buffers.get(update.key), update.text, update.kind));
  }

  const pieces = order.map((key) => buffers.get(key)).filter((piece) => piece);
  notes.parts = pieces.length;
  return { text: pieces.join("\n").trim(), notes };
}

// =========================================================================
// source: claude — Claude Code's own transcript
// =========================================================================

/** Session ids are used to build a path; anything path-shaped is refused. */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

/**
 * Root under which Claude Code keeps its per-project transcript directories.
 * The env override exists so tests can point the lookup at a fixture tree
 * (same seam as `KUSABI_CLAUDE_MCP_SOURCE` / `CLAUDE_BIN`).
 *
 * @returns {string}
 */
export function claudeProjectsRoot() {
  return process.env.KUSABI_CLAUDE_PROJECTS_DIR || path.join(os.homedir(), ".claude", "projects");
}

/**
 * Find the transcript file for `sessionId` by SEARCHING the project
 * directories for `<session-id>.jsonl`.
 *
 * Deliberately not by recomputing the mangled directory name from the job's
 * cwd: that mangling rule is Claude Code's, not ours, and reproducing it
 * means silently breaking the day it changes.  A search on the session id is
 * exact and self-correcting.  Directories are visited in sorted order so a
 * session id present under two projects resolves the same way every run.
 *
 * @param {string} sessionId
 * @param {string} [root] — projects root; defaults to `claudeProjectsRoot()`.
 * @returns {string|null} absolute path, or null when there is no transcript.
 */
export function findClaudeTranscript(sessionId, root = claudeProjectsRoot()) {
  if (typeof sessionId !== "string" || !SAFE_SESSION_ID.test(sessionId)) return null;

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // No projects root at all (never ran claude here, or it lives elsewhere).
    return null;
  }

  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const dir of dirs) {
    const candidate = path.join(root, dir, `${sessionId}.jsonl`);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this project directory; keep looking.
    }
  }
  return null;
}

/**
 * Reconstruct a claude job's output from Claude Code's transcript.
 *
 * The transcript is read-only and out of our control, so this tolerates
 * unknown record types and missing fields rather than asserting on shape.
 * An absent transcript is a normal outcome (pruned, or the job ran on another
 * machine), reported as `notes.reason`, not as an error.
 *
 * What is kept: the `text` content blocks of main-chain `type:"assistant"`
 * records, in file order.  What is dropped, and why:
 *
 *   - `type:"user"` records — these carry the prompt and the tool results.
 *     Skipping them is what keeps the input out of the recovered output.
 *   - sidechain records (`isSidechain`) — a subagent's transcript, not this
 *     job's answer.
 *   - `thinking` blocks — reasoning, not output.  Counted, not concatenated.
 *
 * A record whose `uuid` was already seen is skipped: Claude Code copies
 * earlier records forward when a session is resumed or forked, and a
 * duplicated record would duplicate its text.
 *
 * @param {string} sessionId — session id recorded on the job.
 * @param {string} [root]    — projects root; defaults to `claudeProjectsRoot()`.
 * @returns {{ text: string, notes: object }}
 */
export function recoverFromClaudeTranscript(sessionId, root = claudeProjectsRoot()) {
  const notes = {
    transcript: null,
    records: 0,
    malformed: 0,
    assistantRecords: 0,
    textBlocks: 0,
    thinkingBlocks: 0,
    sidechainRecords: 0,
  };

  if (typeof sessionId !== "string" || !sessionId) {
    return { text: "", notes: { ...notes, reason: "no-session-id" } };
  }

  const file = findClaudeTranscript(sessionId, root);
  if (!file) return { text: "", notes: { ...notes, reason: "transcript-not-found" } };
  notes.transcript = file;

  const raw = readFileOrNull(file);
  if (raw === null) return { text: "", notes: { ...notes, reason: "transcript-unreadable" } };

  const seenRecords = new Set();
  const pieces = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      notes.malformed += 1;
      continue;
    }
    if (!rec || typeof rec !== "object") {
      notes.malformed += 1;
      continue;
    }
    notes.records += 1;

    if (rec.type !== "assistant") continue;
    if (rec.isSidechain === true) {
      notes.sidechainRecords += 1;
      continue;
    }
    if (typeof rec.uuid === "string" && rec.uuid) {
      if (seenRecords.has(rec.uuid)) continue;
      seenRecords.add(rec.uuid);
    }
    notes.assistantRecords += 1;

    const message = (rec.message && typeof rec.message === "object") ? rec.message : {};
    const content = message.content;
    if (typeof content === "string") {
      if (content) {
        pieces.push(content);
        notes.textBlocks += 1;
      }
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "thinking") {
        notes.thinkingBlocks += 1;
        continue;
      }
      if (block.type === "text" && typeof block.text === "string" && block.text) {
        pieces.push(block.text);
        notes.textBlocks += 1;
      }
    }
  }

  return { text: pieces.join("\n").trim(), notes };
}

// =========================================================================
// the one interface — source selected by backend
// =========================================================================

/**
 * Recovery sources, keyed by the backend that produced the job.
 *
 * `recover` takes the job's recorded coordinates (`eventsPath` for opencode,
 * `sessionId` for claude — both are simply carried for every backend) and
 * returns `{ text, notes }`.  `describe` is the phrase the banner uses.
 */
export const RECOVERY_SOURCES = {
  opencode: {
    name: "opencode-events",
    describe: "this job's own recorded event stream (events.ndjson)",
    recover: (coords) => recoverFromOpencodeEvents(coords.eventsPath),
  },
  claude: {
    name: "claude-transcript",
    describe: "Claude Code's transcript for this session, found by session id under ~/.claude/projects",
    recover: (coords) => recoverFromClaudeTranscript(coords.sessionId, coords.claudeProjectsRoot ?? claudeProjectsRoot()),
  },
};

/**
 * Run one source without letting it end the dispatch.
 *
 * The sources already tolerate every damaged input they were built for; this
 * is the backstop for the shape nobody anticipated.  A dispatch that produced
 * real work must not fail because the recovery of an absent result threw.
 *
 * @param {object} source
 * @param {object} coords
 * @returns {{ text: string, notes: object }}
 */
function runSource(source, coords) {
  try {
    const outcome = source.recover(coords) ?? {};
    return {
      text: typeof outcome.text === "string" ? outcome.text : "",
      notes: outcome.notes ?? {},
    };
  } catch (err) {
    return { text: "", notes: { reason: "recovery-threw", error: String(err?.message ?? err) } };
  }
}

/**
 * Decide a completed job's result text, and what its record should say about
 * where that text came from.
 *
 * Precedence: a final assistant message always wins.  When there is one, no
 * source is read and the result is byte-identical to what it has always been.
 * Recovery runs only when that text is absent — and the record keeps apart
 * the two ways it can be absent, which `fetchFinalMessage(...).catch(() => "")`
 * used to collapse into one empty string:
 *
 *   `fetchFailed: true`  — we could not ask (transport error, unparseable
 *     answer).  The final message may well exist; this is a bug on our side.
 *   `fetchFailed: false` — we asked, and the session genuinely never produced
 *     a final message.  Not our bug, and the only case `salvage` was ever
 *     really about.
 *
 * `record.source` names the outcome: `final-message`, `recovered`, `none`
 * (asked, nothing there, nothing recovered) or `unavailable` (could not ask,
 * and nothing recovered — an empty result we cannot vouch for).
 *
 * @param {object} opts
 * @param {string} opts.backend — "opencode" | "claude".
 * @param {{ok: true, text: string}|{ok: false, error: string}} opts.fetched
 *        — outcome of asking for the final message.
 * @param {object} [opts.coords]  — `{ eventsPath, sessionId, claudeProjectsRoot }`.
 * @param {object} [opts.sources] — source map; injection seam for tests.
 * @returns {{ text: string, record: object }}
 */
export function resolveCompletedResult({ backend, fetched, coords = {}, sources = RECOVERY_SOURCES }) {
  const fetchFailed = fetched?.ok !== true;
  const fetchError = fetchFailed ? String(fetched?.error ?? "unknown error") : null;
  const finalText = (!fetchFailed && typeof fetched.text === "string") ? fetched.text : "";

  if (finalText) {
    return {
      text: finalText,
      record: {
        source: "final-message",
        recovered: false,
        fetchFailed: false,
        fetchError: null,
        recovery: null,
      },
    };
  }

  const source = sources?.[backend] ?? null;
  const outcome = source
    ? runSource(source, coords)
    : { text: "", notes: { reason: "no-recovery-source-for-backend" } };

  const recovery = {
    source: source ? source.name : null,
    backend: backend ?? null,
    chars: outcome.text.length,
    ...outcome.notes,
  };

  if (outcome.text) {
    return {
      text: markRecovered(outcome.text, source.describe),
      record: { source: "recovered", recovered: true, fetchFailed, fetchError, recovery },
    };
  }

  return {
    text: "",
    record: {
      source: fetchFailed ? "unavailable" : "none",
      recovered: false,
      fetchFailed,
      fetchError,
      recovery,
    },
  };
}
