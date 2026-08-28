import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseReviewJsonl } from "./review-jsonl.mjs";

// parseReviewJsonl — the JSONL review wire format (kusabi #202)
//
// Every assertion here is on parsed CONTENT: the assembled review object, the
// order of the findings, which lines were counted and which were ignored.
// ---------------------------------------------------------------------------

const FINDING_A = {
  type: "finding",
  severity: "high",
  kind: "design",
  title: "Retry spends the budget that just failed",
  body: "The retry re-dispatches with identical options.",
  file: "plugins/kusabi/scripts/chain-phases.mjs",
  line_start: 12,
  line_end: 18,
  confidence: 0.8,
  recommendation: "Gate the retry on the failure being transient.",
};

const FINDING_B = {
  type: "finding",
  severity: "low",
  kind: "mechanical",
  title: "Stale comment names the removed helper",
  body: "The comment refers to stripVerdict, deleted in #170.",
  file: "plugins/kusabi/scripts/render.mjs",
  line_start: 3,
  line_end: 3,
  confidence: 0.9,
  recommendation: "Delete the comment.",
};

/** The finding as it must appear in the assembled review: `type` dropped. */
function assembled(finding) {
  const out = { ...finding };
  delete out.type;
  return out;
}

function line(obj) {
  return JSON.stringify(obj);
}

describe("parseReviewJsonl — assembled shape", () => {
  it("assembles findings in emission order with the exact single-object shape", () => {
    const stream = [
      line(FINDING_A),
      line(FINDING_B),
      line({ type: "unverified", text: "could not exercise the timeout path" }),
      line({ type: "next_step", text: "add a truncation test" }),
      line({ type: "verdict", verdict: "needs-attention", summary: "One real defect; do not ship." }),
    ].join("\n");

    const result = parseReviewJsonl(stream);

    assert.deepEqual(result.review, {
      verdict: "needs-attention",
      summary: "One real defect; do not ship.",
      findings: [assembled(FINDING_A), assembled(FINDING_B)],
      next_steps: ["add a truncation test"],
      unverified: ["could not exercise the timeout path"],
    });
    // Emission order, not severity order: A (high) was emitted first here,
    // and the reverse stream must come back reversed.
    assert.deepEqual(
      parseReviewJsonl([line(FINDING_B), line(FINDING_A)].join("\n")).review.findings,
      [assembled(FINDING_B), assembled(FINDING_A)],
    );
    assert.equal(result.verdict, "needs-attention");
    assert.equal(result.partial, false);
    assert.equal(result.findingCount, 2);
    assert.equal(result.recordCount, 5);
    assert.equal(result.ignoredLines, 0);
  });

  it("drops only the wire-level `type` key from a finding", () => {
    const result = parseReviewJsonl(line(FINDING_A));
    const finding = result.review.findings[0];

    assert.equal("type" in finding, false);
    // Every schema field survives verbatim, names unchanged.
    assert.deepEqual(Object.keys(finding), [
      "severity", "kind", "title", "body", "file", "line_start", "line_end",
      "confidence", "recommendation",
    ]);
    assert.equal(finding.line_start, 12);
    assert.equal(finding.confidence, 0.8);
  });

  it("omits `unverified` entirely when the stream carried none", () => {
    const stream = [
      line(FINDING_A),
      line({ type: "verdict", verdict: "needs-attention", summary: "s" }),
    ].join("\n");

    const result = parseReviewJsonl(stream);

    assert.equal("unverified" in result.review, false);
    assert.deepEqual(result.review.next_steps, []);
  });

  it("carries discard_reason from the verdict record", () => {
    const stream = line({
      type: "verdict", verdict: "discard", summary: "The brief misreads the code.",
      discard_reason: "wrong_premise",
    });

    const result = parseReviewJsonl(stream);

    assert.equal(result.review.verdict, "discard");
    assert.equal(result.review.discard_reason, "wrong_premise");
    assert.equal(result.partial, false);
  });

  it("substitutes a placeholder when the verdict record has no summary", () => {
    const result = parseReviewJsonl(line({ type: "verdict", verdict: "approve" }));

    // renderReview prints `summary` verbatim, so it is never undefined.
    assert.equal(result.review.summary, "(no summary in the verdict record)");
    assert.equal(result.review.verdict, "approve");
    assert.equal(result.partial, false);
  });

  it("takes the last verdict record when more than one arrives", () => {
    const stream = [
      line({ type: "verdict", verdict: "approve", summary: "first" }),
      line({ type: "verdict", verdict: "needs-attention", summary: "second, after re-reading" }),
    ].join("\n");

    const result = parseReviewJsonl(stream);

    assert.equal(result.review.verdict, "needs-attention");
    assert.equal(result.review.summary, "second, after re-reading");
  });

  it("carries schema_version from the verdict record (kusabi #392)", () => {
    const stream = line({
      type: "verdict",
      schema_version: 1,
      verdict: "approve",
      summary: "looks good",
    });

    const result = parseReviewJsonl(stream);

    assert.equal(result.review.schema_version, 1);
    assert.equal(result.review.verdict, "approve");
  });

  it("preserves unknown extra keys on verdict and finding records (kusabi #392)", () => {
    const stream = [
      line({ type: "finding", ...FINDING_A, unknown_finding_key: "present" }),
      line({ type: "verdict", schema_version: 1, verdict: "approve", summary: "ok", unknown_verdict_key: "also_present" }),
    ].join("\n");

    const result = parseReviewJsonl(stream);

    assert.equal(result.review.findings[0].unknown_finding_key, "present");
    assert.equal(result.review.unknown_verdict_key, "also_present");
  });
});

describe("parseReviewJsonl — prose between records", () => {
  it("ignores narration between records without affecting the result", () => {
    const narrated = [
      "Working through the checklist.",
      "",
      "1. Retry semantics — the retry re-dispatches on identical options, so:",
      line(FINDING_A),
      "2. Comments — one is stale:",
      line(FINDING_B),
      "That is everything I could support from the diff.",
      line({ type: "verdict", verdict: "needs-attention", summary: "One real defect; do not ship." }),
      "Done.",
    ].join("\n");
    const bare = [
      line(FINDING_A),
      line(FINDING_B),
      line({ type: "verdict", verdict: "needs-attention", summary: "One real defect; do not ship." }),
    ].join("\n");

    const withProse = parseReviewJsonl(narrated);

    assert.deepEqual(withProse.review, parseReviewJsonl(bare).review);
    assert.equal(withProse.recordCount, 3);
    // 5 prose lines (blank lines are not counted as ignored).
    assert.equal(withProse.ignoredLines, 5);
  });

  it("ignores markdown fences wrapped around the records", () => {
    const stream = [
      "```jsonl",
      line(FINDING_A),
      line({ type: "verdict", verdict: "approve", summary: "Nothing to block on." }),
      "```",
    ].join("\n");

    const result = parseReviewJsonl(stream);

    assert.equal(result.review.verdict, "approve");
    assert.deepEqual(result.review.findings, [assembled(FINDING_A)]);
    assert.equal(result.ignoredLines, 2);
  });

  it("ignores prose that merely mentions JSON-looking text", () => {
    const stream = [
      'I considered emitting {"type":"finding"} for the naming, but it is stylistic.',
      line(FINDING_B),
    ].join("\n");

    const result = parseReviewJsonl(stream);

    // The prose line starts with "I", not "{" — it is not a record.
    assert.equal(result.findingCount, 1);
    assert.deepEqual(result.review.findings, [assembled(FINDING_B)]);
  });
});

describe("parseReviewJsonl — truncation is partial", () => {
  it("a stream cut after N findings keeps those N and reports partial", () => {
    const stream = [
      line(FINDING_A),
      line(FINDING_B),
      "3. Next I want to check the empty-stream path",
    ].join("\n");

    const result = parseReviewJsonl(stream);

    assert.equal(result.partial, true);
    assert.equal(result.verdict, null);
    assert.equal(result.review.verdict, "partial");
    assert.equal(result.findingCount, 2);
    assert.deepEqual(result.review.findings, [assembled(FINDING_A), assembled(FINDING_B)]);
    // The summary states the partiality and the count, because renderReview
    // prints this field to the operator verbatim.
    assert.equal(
      result.review.summary,
      "(partial review: the stream ended before the verdict line; 2 findings recorded)",
    );
  });

  it("a stream cut mid-record loses only the half-written line", () => {
    const stream = [
      line(FINDING_A),
      '{"type":"finding","severity":"medium","title":"Cut off here',
    ].join("\n");

    const result = parseReviewJsonl(stream);

    assert.equal(result.findingCount, 1);
    assert.deepEqual(result.review.findings, [assembled(FINDING_A)]);
    assert.equal(result.ignoredLines, 1);
    assert.equal(result.partial, true);
  });

  it("singular wording when exactly one finding was recorded", () => {
    const result = parseReviewJsonl(line(FINDING_A));
    assert.equal(
      result.review.summary,
      "(partial review: the stream ended before the verdict line; 1 finding recorded)",
    );
  });

  it("a verdict record with a value outside the enum leaves the review partial", () => {
    const stream = [
      line(FINDING_A),
      line({ type: "verdict", verdict: "looks-fine-to-me", summary: "shipping" }),
    ].join("\n");

    const result = parseReviewJsonl(stream);

    assert.equal(result.partial, true);
    assert.equal(result.review.verdict, "partial");
    // The line WAS a record we understood — it is not counted as ignored.
    assert.equal(result.recordCount, 2);
    assert.equal(result.findingCount, 1);
  });
});

describe("parseReviewJsonl — malformed and non-JSONL input", () => {
  it("a malformed line among valid ones costs only that line", () => {
    const stream = [
      line(FINDING_A),
      '{"type":"finding","severity":"high",,,"title":"broken"}',
      line(FINDING_B),
      line({ type: "verdict", verdict: "needs-attention", summary: "Two defects." }),
    ].join("\n");

    const result = parseReviewJsonl(stream);

    assert.equal(result.recordCount, 3);
    assert.equal(result.ignoredLines, 1);
    assert.deepEqual(result.review.findings, [assembled(FINDING_A), assembled(FINDING_B)]);
    assert.equal(result.review.verdict, "needs-attention");
  });

  it("returns null for a legacy single JSON object (not JSONL)", () => {
    const legacy = JSON.stringify({
      verdict: "needs-attention",
      summary: "One real defect.",
      findings: [assembled(FINDING_A)],
      next_steps: [],
    });

    // One line, valid JSON, an object — but no `type` discriminator, so it is
    // the single-blob format and must fall through to extractJson.
    assert.equal(parseReviewJsonl(legacy), null);
  });

  it("returns null for a pretty-printed single JSON object", () => {
    const legacy = JSON.stringify({ verdict: "approve", summary: "LGTM", findings: [] }, null, 2);
    assert.equal(parseReviewJsonl(legacy), null);
  });

  it("returns null for a fenced single JSON object with a VERDICT token", () => {
    const legacy = [
      "```json",
      JSON.stringify({ verdict: "approve", summary: "LGTM", findings: [] }, null, 2),
      "```",
      "VERDICT: approve",
    ].join("\n");
    assert.equal(parseReviewJsonl(legacy), null);
  });

  it("returns null for prose with no records at all", () => {
    assert.equal(parseReviewJsonl("I read the diff and it looks fine to me."), null);
  });

  it("ignores JSON lines that are not objects, or carry an unknown type", () => {
    const stream = [
      "[1, 2, 3]",
      '"just a string"',
      "42",
      "null",
      line({ type: "thinking", text: "not a record type" }),
      line({ severity: "high", title: "no type key" }),
    ].join("\n");

    assert.equal(parseReviewJsonl(stream), null);
  });

  it("empty and whitespace-only streams return null instead of throwing", () => {
    assert.equal(parseReviewJsonl(""), null);
    assert.equal(parseReviewJsonl("   "), null);
    assert.equal(parseReviewJsonl("\n\n  \n\t\n"), null);
    assert.equal(parseReviewJsonl(null), null);
    assert.equal(parseReviewJsonl(undefined), null);
  });

  it("drops next_step / unverified records with no usable text", () => {
    const stream = [
      line({ type: "next_step", text: "" }),
      line({ type: "unverified", text: 42 }),
      line({ type: "next_step", text: "a real one" }),
      line({ type: "verdict", verdict: "approve", summary: "ok" }),
    ].join("\n");

    const result = parseReviewJsonl(stream);

    assert.deepEqual(result.review.next_steps, ["a real one"]);
    assert.equal("unverified" in result.review, false);
    // All four lines were records; two simply had nothing to contribute.
    assert.equal(result.recordCount, 4);
  });

  it("tolerates CRLF line endings and indented records", () => {
    const stream = "  " + line(FINDING_A) + "\r\n\t"
      + line({ type: "verdict", verdict: "approve", summary: "ok" }) + "\r\n";

    const result = parseReviewJsonl(stream);

    assert.equal(result.review.verdict, "approve");
    assert.deepEqual(result.review.findings, [assembled(FINDING_A)]);
  });
});


describe("parseReviewJsonl — a legacy blob wearing a `type` key (kusabi #205)", () => {
  const CRITICAL = {
    severity: "critical",
    title: "REAL DEFECT",
    body: "a defect that must not disappear",
    file: "src/a.mjs",
    line_start: 1,
    line_end: 2,
    confidence: 0.9,
    recommendation: "fix it",
  };

  it("is not a record, so its findings are never dropped", () => {
    // Regression: detection accepted any object carrying a known `type`, so a
    // reviewer emitting the legacy whole-review object while copying the
    // `type` discriminator out of the prompt's own examples parsed as ONE
    // verdict record — verdict `approve`, findings [], partial false — and
    // the critical finding sitting beside it was never read.  With green
    // probes that is an accept, and the raw text is not persisted, so the
    // finding vanished without a trace.
    const legacy = JSON.stringify({
      type: "verdict",
      verdict: "approve",
      summary: "looks fine",
      findings: [CRITICAL],
      next_steps: [],
    });

    assert.equal(parseReviewJsonl(legacy), null);
  });

  it("abandons JSONL for the whole stream, not just the blob's line", () => {
    // The first attempt at this fix skipped the blob as prose.  Any other
    // record then kept the stream in JSONL mode, so the blob's findings were
    // dropped just as silently as before — the bug moved rather than closed.
    const stream = [
      JSON.stringify({ type: "next_step", text: "Fix tests" }),
      JSON.stringify({ type: "verdict", verdict: "approve", summary: "s", findings: [CRITICAL] }),
    ].join("\n");

    assert.equal(parseReviewJsonl(stream), null, "a blob anywhere means the output was not JSONL");
  });

  it("treats a NON-EMPTY legacy array as the signal, on any of the three keys", () => {
    for (const key of ["findings", "next_steps", "unverified"]) {
      const blob = JSON.stringify({
        type: "verdict", verdict: "approve", summary: "s", [key]: ["payload"],
      });
      assert.equal(parseReviewJsonl(blob), null, `non-empty ${key} marks a legacy blob`);
    }
  });

  it("keeps a record that merely pads an empty legacy array", () => {
    // A model that writes `"findings": []` on a finding record is saying
    // "none here", not emitting a whole review.  Rejecting it threw the
    // record away and produced a findings-free approve — the very outcome
    // this check exists to prevent.
    const stream = [
      JSON.stringify({ type: "finding", ...CRITICAL, findings: [] }),
      JSON.stringify({ type: "verdict", verdict: "approve", summary: "LGTM" }),
    ].join("\n");

    const parsed = parseReviewJsonl(stream);
    assert.ok(parsed, "padded record must not abandon JSONL");
    assert.equal(parsed.review.findings.length, 1);
    assert.equal(parsed.review.findings[0].title, "REAL DEFECT");
  });

  it("never yields an approval that reports no findings, whatever the shape", () => {
    // The invariant, stated once: a misdetection may land on unparseable or
    // partial — both escalate — but must never become `approve` with the
    // findings gone.
    const shapes = [
      JSON.stringify({ type: "verdict", verdict: "approve", summary: "s", findings: [CRITICAL] }),
      [
        JSON.stringify({ type: "next_step", text: "x" }),
        JSON.stringify({ type: "verdict", verdict: "approve", summary: "s", findings: [CRITICAL] }),
      ].join("\n"),
      [
        JSON.stringify({ type: "finding", ...CRITICAL, findings: [] }),
        JSON.stringify({ type: "verdict", verdict: "approve", summary: "s" }),
      ].join("\n"),
    ];

    for (const shape of shapes) {
      const parsed = parseReviewJsonl(shape);
      const approvedWithNothing =
        parsed !== null && parsed.review.verdict === "approve" && parsed.review.findings.length === 0;
      assert.equal(approvedWithNothing, false, `silent approval for: ${shape.slice(0, 60)}`);
    }
  });

  it("still accepts a real verdict record, which carries none of those keys", () => {
    const stream = [
      JSON.stringify({ type: "finding", ...CRITICAL }),
      JSON.stringify({ type: "verdict", verdict: "needs-attention", summary: "one critical" }),
    ].join("\n");

    const parsed = parseReviewJsonl(stream);
    assert.ok(parsed);
    assert.equal(parsed.review.verdict, "needs-attention");
    assert.equal(parsed.review.findings.length, 1);
    assert.equal(parsed.review.findings[0].title, "REAL DEFECT");
    assert.equal(parsed.partial, false);
  });
});
describe("parseReviewJsonl — salvaging an unterminated verdict line (kusabi #312)", () => {
  const VERDICTS = ["approve", "approve-partial", "needs-attention", "discard"];
  const SALVAGE_MARKER = " [salvaged from an unterminated verdict line]";

  /** A verdict record cut short: valid adjudication whose JSON never closed. */
  function brokenVerdictLine(verdict, summary) {
    return `{"type":"verdict","verdict":"${verdict}","summary":"${summary}`;
  }

  it("salvages the verdict from a stream whose final line never closed", () => {
    for (const verdict of VERDICTS) {
      const summary = "Ship. " + "x".repeat(1600);
      const result = parseReviewJsonl([
        line(FINDING_A),
        brokenVerdictLine(verdict, summary),
      ].join("\n"));

      assert.equal(result.partial, false, `${verdict}: not partial`);
      assert.equal(result.verdict, verdict);
      assert.equal(result.review.verdict, verdict);
      assert.equal(result.review.salvagedVerdict, true);
      assert.equal(result.review.summary, summary + SALVAGE_MARKER);
      assert.equal(result.partialDiagnosis, null);
      assert.deepEqual(result.review.findings, [assembled(FINDING_A)]);
    }
  });

  it("summary prose cannot fabricate a verdict — extraction stops at the summary key", () => {
    // A broken verdict-shaped line with NO verdict key of its own, whose
    // summary prose quotes a raw verdict phrase.  A line-wide match would
    // read the quotation as the decision; the scoped extraction must not.
    const result = parseReviewJsonl([
      line(FINDING_A),
      '{"type":"verdict","summary":"the worker claimed "verdict":"approve" in its notes',
    ].join("\n"));

    assert.equal(result.partial, true);
    assert.equal("salvagedVerdict" in result.review, false);
    assert.equal(
      result.partialDiagnosis,
      "format: final line is verdict-shaped but unparseable",
    );
  });

  it("a real verdict record anywhere in the stream beats a salvaged one", () => {
    const result = parseReviewJsonl([
      brokenVerdictLine("approve", "salvage me"),
      line(FINDING_A),
      line({ type: "verdict", verdict: "needs-attention", summary: "The real verdict." }),
    ].join("\n"));

    assert.equal(result.review.verdict, "needs-attention");
    assert.equal(result.review.summary, "The real verdict.");
    assert.equal("salvagedVerdict" in result.review, false);
    assert.equal(result.partial, false);
    assert.equal(result.partialDiagnosis, null);
    assert.equal(result.ignoredLines, 1);
  });

  it("a verdict-shaped line naming no enum verdict is not salvaged", () => {
    const result = parseReviewJsonl([
      line(FINDING_A),
      brokenVerdictLine("ship-it", "looks good"),
    ].join("\n"));

    assert.equal(result.partial, true);
    assert.equal(result.verdict, null);
    assert.equal(result.review.verdict, "partial");
    assert.equal("salvagedVerdict" in result.review, false);
    assert.equal(
      result.partialDiagnosis,
      "format: final line is verdict-shaped but unparseable",
    );
  });

  it("a non-enum verdict record after a salvage voids it — the stream stays partial", () => {
    // Regression: the salvage used to be monotonic, so an earlier broken
    // "approve" draft closed the stream as an accept even though a REAL
    // verdict record later said something else.  The record is parseable
    // and real: it must block the salvage, leaving the review partial.
    const result = parseReviewJsonl([
      line(FINDING_A),
      brokenVerdictLine("approve", "draft"),
      line({ type: "verdict", verdict: "ship-it", summary: "shipping" }),
    ].join("\n"));

    assert.equal(result.partial, true);
    assert.equal(result.verdict, null);
    assert.equal(result.review.verdict, "partial");
    assert.equal("salvagedVerdict" in result.review, false);
    assert.equal(result.recordCount, 2); // finding + the ship-it record
    assert.equal(result.ignoredLines, 1); // the broken draft
    assert.equal(
      result.partialDiagnosis,
      "format: records present but no verdict record arrived",
    );
  });

  it("a non-enum verdict record voids an earlier salvage even when it comes first", () => {
    // "A real, parseable verdict record anywhere in the stream ALWAYS wins
    // over a salvaged one" — order does not matter.
    const result = parseReviewJsonl([
      line({ type: "verdict", verdict: "ship-it", summary: "shipping" }),
      line(FINDING_A),
      brokenVerdictLine("approve", "last draft"),
    ].join("\n"));

    assert.equal(result.partial, true);
    assert.equal(result.review.verdict, "partial");
    assert.equal("salvagedVerdict" in result.review, false);
  });

  it("a later broken line whose verdict is not in the enum voids an earlier salvage", () => {
    // "If several lines are verdict-shaped-but-broken, the LAST one wins" —
    // and the last one failed extraction, so no salvage stands.
    const result = parseReviewJsonl([
      line(FINDING_A),
      brokenVerdictLine("approve", "first draft"),
      brokenVerdictLine("ship-it", "final attempt"),
    ].join("\n"));

    assert.equal(result.partial, true);
    assert.equal(result.verdict, null);
    assert.equal(result.review.verdict, "partial");
    assert.equal("salvagedVerdict" in result.review, false);
    assert.equal(
      result.partialDiagnosis,
      "format: final line is verdict-shaped but unparseable",
    );
  });

  it("diagnoses a records-present stream that never emitted a verdict", () => {
    const result = parseReviewJsonl([line(FINDING_A), line(FINDING_B)].join("\n"));

    assert.equal(result.partial, true);
    assert.equal(
      result.partialDiagnosis,
      "format: records present but no verdict record arrived",
    );
  });

  it("when several broken verdict lines exist, the last salvageable one wins", () => {
    const result = parseReviewJsonl([
      line(FINDING_A),
      brokenVerdictLine("approve", "first attempt"),
      brokenVerdictLine("discard", "second thought"),
    ].join("\n"));

    assert.equal(result.review.verdict, "discard");
    assert.equal(result.partial, false);
    assert.equal(result.review.summary, "second thought" + SALVAGE_MARKER);
  });

  it("a salvaged discard carries no discard_reason", () => {
    const result = parseReviewJsonl([
      line(FINDING_A),
      brokenVerdictLine("discard", "the brief misreads the code"),
    ].join("\n"));

    assert.equal(result.review.verdict, "discard");
    assert.equal("discard_reason" in result.review, false);
  });
});
