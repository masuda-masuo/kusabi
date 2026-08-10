// review-jsonl.mjs — the JSONL review wire format (kusabi #202).
//
// The reviewer emits one JSON object per line, each written when that piece
// of the review is decided:
//
//   {"type":"finding","severity":"high","title":"…","body":"…","file":"src/a.mjs",
//    "line_start":12,"line_end":18,"confidence":0.8,"recommendation":"…"}
//   {"type":"unverified","text":"could not exercise the timeout path"}
//   {"type":"next_step","text":"…"}
//   {"type":"verdict","verdict":"needs-attention","summary":"…"}
//
// Two properties make this worth having over one large object at the end:
// a truncated stream still carries every finding it managed to emit, and a
// line that is not valid JSON is IGNORED — which is what lets the reviewer
// narrate its way through a checklist between records instead of throwing
// that reasoning away.
//
// This module is a WIRE FORMAT parser and nothing else.  It assembles the
// records into the same in-memory review object the single-blob path
// produces (`{ verdict, summary, findings, next_steps, unverified? }`, field
// names exactly as `schemas/review-output.schema.json` defines them) so that
// JSONL never becomes a second domain model.  It has no imports on purpose.

/**
 * Line types that make a line a RECORD rather than prose.  The `type`
 * discriminator is what keeps the two input formats apart: a legacy
 * single-object review has no `type` field (the schema forbids it —
 * `additionalProperties: false`), so a one-line legacy blob is never
 * mistaken for a JSONL record and falls through to `extractJson`.
 */
const RECORD_TYPES = new Set(["finding", "unverified", "next_step", "verdict"]);

/** The schema's verdict enum.  Unchanged by JSONL — this is a wire format. */
const REVIEW_VERDICTS = ["approve", "approve-partial", "needs-attention", "discard"];

/**
 * Parse a JSONL review stream.
 *
 * @param {string} text — the reviewer's raw output.
 * @returns {null|{
 *   review: object,          // assembled single-object shape (see module note)
 *   verdict: string|null,    // the verdict record's verdict; null when absent
 *   partial: boolean,        // true when no verdict record arrived
 *   findingCount: number,
 *   recordCount: number,     // records recognised (all types)
 *   ignoredLines: number,    // non-record lines skipped (prose, fences, junk)
 * }}
 *   `null` means "this is not JSONL" — no line was a recognisable record.
 *   The caller must then fall back to the single-object `extractJson` path.
 *   An empty or whitespace-only stream is also `null`: unreadable output is
 *   the existing unparseable state, not a partial review.
 */
export function parseReviewJsonl(text) {
  if (typeof text !== "string" || text.trim() === "") return null;

  const findings = [];
  const nextSteps = [];
  const unverified = [];
  let verdictRecord = null;
  let recordCount = 0;
  let ignoredLines = 0;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const record = parseRecordLine(line);
    if (record === null) {
      // Prose, a code fence, a half-written line the stream was cut on — one
      // bad line costs only that line.
      ignoredLines++;
      continue;
    }
    recordCount++;
    switch (record.type) {
      case "finding":
        // Field names pass through verbatim; only the wire-level `type`
        // discriminator is dropped, so a finding matches the schema shape.
        findings.push(withoutType(record));
        break;
      case "next_step": {
        const t = recordText(record);
        if (t !== null) nextSteps.push(t);
        break;
      }
      case "unverified": {
        const t = recordText(record);
        if (t !== null) unverified.push(t);
        break;
      }
      case "verdict":
        // Only a schema-valid verdict closes the stream.  A verdict record
        // carrying something else is a record we understood but cannot act
        // on — the review stays partial rather than inventing a decision.
        if (REVIEW_VERDICTS.includes(record.verdict)) verdictRecord = record;
        break;
    }
  }

  if (recordCount === 0) return null; // not JSONL

  const partial = verdictRecord === null;
  const review = {
    // "partial" is a state of its own, not an alias of any schema verdict:
    // findings but no verdict line means the review is INCOMPLETE.
    verdict: partial ? "partial" : verdictRecord.verdict,
    summary: assembleSummary(verdictRecord, findings.length),
    findings,
    next_steps: nextSteps,
  };
  // `unverified` is optional in the schema; emit it only when the stream
  // carried some, so the assembled object matches what the single-object
  // path produces for the same review.
  if (unverified.length > 0) review.unverified = unverified;
  if (verdictRecord && typeof verdictRecord.discard_reason === "string") {
    review.discard_reason = verdictRecord.discard_reason;
  }

  return {
    review,
    verdict: partial ? null : verdictRecord.verdict,
    partial,
    findingCount: findings.length,
    recordCount,
    ignoredLines,
  };
}

/**
 * Parse one line into a record, or null when the line is not a record.
 *
 * A record is: valid JSON, a plain object, carrying a known `type`.
 */
function parseRecordLine(line) {
  // A record is a JSON object, so anything not starting with `{` is prose —
  // rejected without paying for a JSON.parse attempt.
  if (!line.startsWith("{")) return null;
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    // Not JSON — narration, or the line the stream was truncated on.
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (!RECORD_TYPES.has(value.type)) return null;
  return value;
}

/** Copy a record without its wire-level `type` key, preserving key order. */
function withoutType(record) {
  const out = {};
  for (const key of Object.keys(record)) {
    if (key !== "type") out[key] = record[key];
  }
  return out;
}

/** The `text` payload of a next_step / unverified record, or null. */
function recordText(record) {
  return typeof record.text === "string" && record.text !== "" ? record.text : null;
}

/**
 * The review summary.  `renderReview` prints this field directly, so it is
 * always a string: a partial stream says so and how much it carried, which
 * is the operator-visible half of the partial state.
 */
function assembleSummary(verdictRecord, findingCount) {
  if (verdictRecord && typeof verdictRecord.summary === "string" && verdictRecord.summary !== "") {
    return verdictRecord.summary;
  }
  if (verdictRecord) return "(no summary in the verdict record)";
  const plural = findingCount === 1 ? "finding" : "findings";
  return "(partial review: the stream ended before the verdict line; "
    + findingCount + " " + plural + " recorded)";
}
