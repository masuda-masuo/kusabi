// coordinator-parse.mjs — kusabi #529: the coordinator-output parser.
//
// This parser is the ONLY information path from the Luna seat into the
// deterministic mission driver (kusabi #524 §8, slice 4).  The contract,
// frozen by coordinator-parse.test.mjs:
//
//   - a CLOSED action allow-list (the six verbs of #524 §8) — the enum of
//     schemas/coordinator-output.schema.json IS the single source of truth,
//     and COORDINATOR_ACTIONS is derived from that file so the two can never
//     drift apart;
//   - unknown actions are rejected deterministically and are COUNTABLE from
//     the returned machine-readable result (`rejectedCount`,
//     `rejectedActions`);
//   - malformed records fail deterministically (`malformedCount`, `errors`);
//   - records bound to a stale or mismatched envelope hash fail
//     deterministically (a request about stale evidence must never execute);
//   - incomplete streams fail deterministically;
//   - identical output parses to an identical result in any process.
//
// Line classification (frozen by the test file):
//   - blank lines                                 -> ignored, counted only
//   - non-JSON lines not starting with "{"        -> ignored prose (counted)
//   - a line starting with "{" that fails JSON.parse
//                                                  -> truncated record: INCOMPLETE
//   - valid JSON that is not a plain object       -> malformed
//   - a plain object missing/non-string `action`, or a missing/malformed
//     `envelope_sha256`                           -> malformed
//   - a valid 64-hex `envelope_sha256` that is not the current envelope hash
//                                                  -> rejected (envelope-mismatch)
//   - an `action` outside the allow-list          -> rejected (unknown-action),
//                                                    counted individually
//   - no accepted requests at all                 -> INCOMPLETE
//
// `valid` is false when any record was rejected or malformed or the stream
// is incomplete; a stream containing ANY invalid request is never partially
// executable even though the valid requests are returned for diagnostics —
// the future mission driver consumes only `valid: true` results.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.resolve(SCRIPT_DIR, "../schemas/coordinator-output.schema.json");

/** A valid record must be bound to a 64-char lowercase hex envelope hash. */
const ENVELOPE_HASH_RE = /^[0-9a-f]{64}$/;

let cachedActions = null;

/**
 * The closed action allow-list, derived ONCE from the schema file — the
 * schema's `action.enum` is the single source of truth (frozen by the test:
 * `schema.properties.action.enum` deep-equals COORDINATOR_ACTIONS).
 *
 * @returns {string[]}
 */
function coordinatorActions() {
  if (cachedActions === null) {
    const schema = JSON.parse(readFileSync(SCHEMA_FILE, "utf8"));
    cachedActions = [...schema.properties.action.enum];
  }
  return cachedActions;
}

/** The closed action allow-list of #524 §8, in design order. */
export const COORDINATOR_ACTIONS = coordinatorActions();

/** Cap a diagnostic detail so an enormous malformed line cannot bloat errors. */
function shortDetail(text) {
  const s = String(text);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/**
 * Parse line-oriented coordinator seat output deterministically.
 *
 * The result carries machine-readable counts and diagnostics but NO
 * execution authority: the caller (the future mission driver) must check
 * `valid` before executing anything, and a `valid: false` result is never
 * partially executable.
 *
 * @param {string} text — the seat's raw output.
 * @param {object} opts
 * @param {string} opts.envelopeSha256 — the current envelope hash the parse
 *        is bound to; any record carrying a different (stale) valid hash is
 *        rejected as envelope-mismatch.
 * @returns {{ valid: boolean, requests: object[], rejectedCount: number,
 *             rejectedActions: string[], malformedCount: number,
 *             incomplete: boolean, ignoredLines: number,
 *             errors: Array<{line: number, reason: string, detail: string}> }}
 */
export function parseCoordinatorOutput(text, { envelopeSha256 }) {
  const actions = COORDINATOR_ACTIONS;
  const requests = [];
  const errors = [];
  const rejectedActions = [];
  let rejectedCount = 0;
  let malformedCount = 0;
  let incomplete = false;
  let ignoredLines = 0;

  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const line = lines[i].trim();
    if (line === "") {
      ignoredLines += 1; // blank — ignored, counted only
      continue;
    }
    const objectStart = line.startsWith("{");
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (objectStart) {
        // A record cut off mid-line: the stream cannot be complete.
        incomplete = true;
        errors.push({ line: lineNumber, reason: "truncated-record", detail: shortDetail(line) });
      } else {
        ignoredLines += 1; // prose — ignored, counted only
      }
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      malformedCount += 1;
      errors.push({ line: lineNumber, reason: "not-an-object", detail: shortDetail(line) });
      continue;
    }
    const action = parsed.action;
    if (typeof action !== "string") {
      malformedCount += 1;
      errors.push({
        line: lineNumber,
        reason: action === undefined ? "missing-action" : "invalid-action",
        detail: action === undefined
          ? "record carries no action"
          : `action is ${typeof action}, not a string`,
      });
      continue;
    }
    const hash = parsed.envelope_sha256;
    if (typeof hash !== "string" || !ENVELOPE_HASH_RE.test(hash)) {
      malformedCount += 1;
      errors.push({
        line: lineNumber,
        reason: "invalid-envelope-hash",
        detail: `envelope_sha256 must be 64 lowercase hex characters, got ${typeof hash === "string" ? JSON.stringify(hash) : String(hash)}`,
      });
      continue;
    }
    if (hash !== envelopeSha256) {
      rejectedCount += 1;
      errors.push({
        line: lineNumber,
        reason: "envelope-mismatch",
        detail: `record is bound to envelope ${hash}; the current envelope is ${envelopeSha256}`,
      });
      continue;
    }
    if (!actions.includes(action)) {
      rejectedCount += 1;
      rejectedActions.push(action);
      errors.push({ line: lineNumber, reason: "unknown-action", detail: action });
      continue;
    }
    requests.push(parsed);
  }

  if (requests.length === 0) incomplete = true;
  const valid = !incomplete && rejectedCount === 0 && malformedCount === 0;
  return {
    valid,
    requests,
    rejectedCount,
    rejectedActions,
    malformedCount,
    incomplete,
    ignoredLines,
    errors,
  };
}