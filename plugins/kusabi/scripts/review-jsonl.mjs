// review-jsonl.mjs — the JSONL review wire format (kusabi #202, #392).
//
// The reviewer emits one JSON object per line, each written when that piece
// of the review is decided:
//
//   {"type":"finding","severity":"high","title":"…","body":"…","file":"src/a.mjs",
//    "line_start":12,"line_end":18,"confidence":0.8,"recommendation":"…"}
//   {"type":"unverified","text":"could not exercise the timeout path"}
//   {"type":"next_step","text":"…"}
//   {"type":"verdict","schema_version":1,"verdict":"needs-attention","summary":"…"}
//
// Two properties make this worth having over one large object at the end:
// a truncated stream still carries every finding it managed to emit, and a
// line that is not valid JSON is IGNORED — which is what lets the reviewer
// narrate its way through a checklist between records instead of throwing
// that reasoning away.  One exception, kusabi #312: a line that is a verdict
// record cut short — the adjudication is complete but its JSON never closed —
// is SALVAGED rather than ignored, so a finished decision is not lost to a
// truncated stream.
//
// This module is a WIRE FORMAT parser and nothing else.  It assembles the
// records into the same in-memory review object the single-blob path
// produces (`{ schema_version, verdict, summary, findings, next_steps, unverified? }`,
// field names exactly as `schemas/review-output.schema.json` defines them) so that
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
 * A VERDICT-SHAPED line is one that starts like a verdict record but failed
 * to parse — typically the stream was cut inside the verdict's own line
 * (kusabi #312).  Such a line is salvageable: the verdict value is still
 * readable, so the decision should not be thrown away with the truncation.
 */
const VERDICT_SHAPE_RE = /^\{"type"\s*:\s*"verdict"/;

/**
 * The verdict value inside a broken verdict-shaped line.  Built from
 * `REVIEW_VERDICTS` so the salvageable set IS the schema's enum — the array
 * is the single source of truth, not a second copy of the alternation.
 */
const VERDICT_VALUE_RE = new RegExp(
  `"verdict"\\s*:\\s*"(${REVIEW_VERDICTS.join("|")})"`,
);

/** Best-effort capture of the `"summary"` string value, cut at line end. */
const SUMMARY_VALUE_RE = /"summary"\s*:\s*"((?:[^"\\]|\\.)*)/;

/** Decode the escapes a summary may carry — best effort, the line never parsed. */
const SUMMARY_ESCAPES = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * Appended to a salvaged summary so a recovered verdict is never mistaken
 * for one the reviewer actually completed.
 */
const SALVAGE_MARKER = " [salvaged from an unterminated verdict line]";

/**
 * Parse a JSONL review stream.
 *
 * @param {string} text — the reviewer's raw output.
 * @returns {null|{
 *   review: object,          // assembled single-object shape (see module note);\n *                            // `salvagedVerdict: true` marks a verdict\n *                            // recovered from an unterminated verdict line\n *   verdict: string|null,    // the closing verdict (record or salvaged)\n *   partial: boolean,        // true when no verdict arrived, salvaged or not\n *   partialDiagnosis: string|null, // why the stream is partial, when it is\n *   findingCount: number,\n *   recordCount: number,     // records recognised (all types)\n *   ignoredLines: number,    // non-record lines skipped (prose, fences, junk)\n * }}
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
  let salvaged = null;
  let unsalvageableVerdictLine = false;
  let salvageBlocked = false;
  let recordCount = 0;
  let ignoredLines = 0;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const record = parseRecordLine(line);
    if (record === LEGACY_BLOB) {
      // The output was never JSONL.  Abandon it whole rather than dropping
      // this line, so the legacy parser gets the blob with its findings.
      return null;
    }
    if (record === null) {
      // Prose, a code fence, a half-written line the stream was cut on — one
      // bad line costs only that line.  Except when the line is a VERDICT
      // record cut short (kusabi #312): a complete adjudication whose JSON
      // never closed is salvaged, not thrown away.
      if (VERDICT_SHAPE_RE.test(line)) {
        // Scope the verdict extraction to the part of the line BEFORE the
        // "summary" key: the summary value is reviewer PROSE, and a broken
        // line's prose may contain a raw `"verdict":"approve"` that a
        // line-wide match would read as the decision.  The record contract
        // puts `verdict` before `summary`; a verdict key that only appears
        // inside the summary area is quotation, not adjudication.
        const summaryKeyAt = line.search(/"summary"\s*:/);
        const verdictArea = summaryKeyAt === -1 ? line : line.slice(0, summaryKeyAt);
        const verdictMatch = verdictArea.match(VERDICT_VALUE_RE);
        if (verdictMatch) {
          salvaged = {
            verdict: verdictMatch[1],
            summary: salvageSummary(line) + SALVAGE_MARKER,
          };
        } else {
          // Verdict-shaped but names no enum verdict — not a decision we may
          // act on.  Ignored like any other broken line; the stream stays
          // partial and the diagnosis says why.  The failed extraction also
          // voids any EARLIER salvage: "the last one wins" includes the
          // no-salvage outcome.
          salvaged = null;
          unsalvageableVerdictLine = true;
        }
      }
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
        // Such a record is still REAL evidence wherever it appears: it voids
        // any salvage, standing or later, so a draft never closes a stream
        // whose own verdict area says something else.
        if (REVIEW_VERDICTS.includes(record.verdict)) {
          verdictRecord = record;
        } else {
          salvageBlocked = true;
        }
        break;
    }
  }

  if (recordCount === 0) return null; // not JSONL

  // The verdict that closes the stream: a real verdict record always beats a
  // salvaged one.  A non-enum verdict record voids the salvage — standing or
  // future — so the stream stays partial rather than closing on a draft.
  const verdictSource = verdictRecord ?? (salvageBlocked ? null : salvaged);
  const partial = verdictSource === null;
  const review = {
    // "partial" is a state of its own, not an alias of any schema verdict:
    // findings but no verdict line means the review is INCOMPLETE.
    verdict: partial ? "partial" : verdictSource.verdict,
    summary: assembleSummary(verdictSource, findings.length),
    findings,
    next_steps: nextSteps,
  };
  // `unverified` is optional in the schema; emit it only when the stream
  // carried some, so the assembled object matches what the single-object
  // path produces for the same review.
  if (unverified.length > 0) review.unverified = unverified;
  if (verdictRecord && verdictRecord.schema_version !== undefined) {
    review.schema_version = verdictRecord.schema_version;
  }
  if (verdictRecord && typeof verdictRecord.discard_reason === "string") {
    review.discard_reason = verdictRecord.discard_reason;
  }
  // Carry any extra keys from the verdict record onto the assembled review
  // so downstream schema validation can refuse unknown fields (kusabi #392).
  if (verdictRecord) {
    for (const key of Object.keys(verdictRecord)) {
      if (key !== "type" && !(key in review)) {
        review[key] = verdictRecord[key];
      }
    }
  }
  // A salvaged verdict is marked, never silent: the operator must be able to
  // tell a recovered decision from one the reviewer actually completed.
  if (salvaged && verdictSource === salvaged) review.salvagedVerdict = true;

  // Why the stream is partial, when it is — two distinguishable failures: a
  // verdict-shaped line that could not be salvaged, or a stream that never
  // produced a verdict at all.
  let partialDiagnosis = null;
  if (partial) {
    partialDiagnosis = unsalvageableVerdictLine
      ? "format: final line is verdict-shaped but unparseable"
      : "format: records present but no verdict record arrived";
  }

  return {
    review,
    verdict: partial ? null : verdictSource.verdict,
    partial,
    partialDiagnosis,
    findingCount: findings.length,
    recordCount,
    ignoredLines,
  };
}

/**
 * Array-valued keys that only ever belong to the legacy whole-review object.
 * A `type`-carrying line holding a NON-EMPTY one of these is a legacy blob.
 *
 * Emptiness matters.  A model that pads a genuine record with `"findings": []`
 * — copying a key it saw in the prompt to say "none here" — is still emitting
 * a record, and treating that as a blob throws the record away.
 */
const LEGACY_BLOB_ARRAY_KEYS = ["findings", "next_steps", "unverified"];

/**
 * Returned by `parseRecordLine` for a line that is a legacy whole-review
 * object rather than a record.  It is distinct from `null` (prose) because
 * the two demand opposite handling: prose costs its own line, a legacy blob
 * means the whole output was never JSONL and must go to the legacy parser
 * intact.
 */
const LEGACY_BLOB = Symbol("legacy-blob");

/**
 * Parse one line into a record, or null when the line is not a record.
 *
 * Three outcomes, not two: the record, `null` for prose, and `LEGACY_BLOB`
 * for a line that is the legacy whole-review object wearing a `type` key.
 *
 * This is not defensive padding (kusabi #205).  Detection used to accept any
 * object with a known `type`, so a reviewer emitting the legacy single object
 * while copying the `type` discriminator out of the prompt's examples —
 *
 *   {"type":"verdict","verdict":"approve","findings":[<real findings>],...}
 *
 * — parsed as one verdict record whose neighbouring `findings` array was
 * never read: verdict `approve`, findings `[]`.  With green probes that is an
 * accept, so a review carrying a critical finding became a findings-free
 * approval, silently, with the raw text persisted nowhere.
 *
 * The blob must not merely be skipped, either.  Skipping it drops it as prose
 * while any other record keeps the stream in JSONL mode — the same silent
 * loss by a different route.  `LEGACY_BLOB` makes the caller abandon JSONL
 * for the whole output so the legacy parser sees the blob intact.
 *
 * Note: An unknown extra key on a record is preserved on the record object,
 * and refused by post-parse schema validation (kusabi #392).
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
  // A legacy whole-review object wearing a `type` key is not a record.  Only
  // a NON-EMPTY array counts: `"findings": []` is a model padding a genuine
  // record, and discarding that record is exactly the loss being prevented.
  const carriesPayload = LEGACY_BLOB_ARRAY_KEYS.some(
    (key) => Array.isArray(value[key]) && value[key].length > 0,
  );
  if (carriesPayload) return LEGACY_BLOB;
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
 * The readable prefix of the `"summary"` value of a line JSON.parse
 * rejected — truncated at the line end, escapes decoded best-effort.
 * Empty string when the line carries no `"summary"` key.
 */
function salvageSummary(line) {
  const match = line.match(SUMMARY_VALUE_RE);
  if (match === null) return "";
  return match[1].replace(/\\(["\\/bfnrt])/g, (escape) => SUMMARY_ESCAPES[escape[1]]);
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
