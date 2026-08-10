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
