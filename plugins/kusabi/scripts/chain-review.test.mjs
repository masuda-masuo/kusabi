import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  shouldSkipReview,
  parseReviewResult,
  buildReviewRepairPrompt,
  renderProbeReport,
  renderReviewPriorFindings,
  runReviewPhase,
} from "./chain-review.mjs";
import {
  computeChainTotals,
  resolveReworkScope,
  inScopeFindingFiles,
} from "./chain-phases.mjs";
import {
  collectContainerReviewInput,
} from "./chain-collect.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

// =========================================================================
// shouldSkipReview  —  pure, extracted from cmdChain (chain-phases.mjs -> chain-review.mjs)
// =========================================================================

describe("shouldSkipReview", () => {
  it("returns true when status observed, no changes, and deliverables declared", () => {
    const result = shouldSkipReview({
      chainStatusObserved: true,
      chainChangedPaths: [],
      chainDeliverables: ["src/foo.js"],
    });
    assert.equal(result, true);
  });

  it("returns false when changes are present", () => {
    const result = shouldSkipReview({
      chainStatusObserved: true,
      chainChangedPaths: ["src/foo.js"],
      chainDeliverables: ["src/foo.js"],
    });
    assert.equal(result, false);
  });

  it("returns false when status was never observed", () => {
    const result = shouldSkipReview({
      chainStatusObserved: false,
      chainChangedPaths: [],
      chainDeliverables: ["src/foo.js"],
    });
    assert.equal(result, false);
  });

  it("returns false when no deliverables declared", () => {
    const result = shouldSkipReview({
      chainStatusObserved: true,
      chainChangedPaths: [],
      chainDeliverables: [],
    });
    assert.equal(result, false);
  });

  it("returns false when empty paths but no deliverables (both arrays empty)", () => {
    const result = shouldSkipReview({
      chainStatusObserved: true,
      chainChangedPaths: [],
      chainDeliverables: [],
    });
    assert.equal(result, false);
  });

  // The cases above omit chainNewlyChanged, so they only exercise the
  // fallback.  In production runProbePhase always passes it — these cover
  // that path.

  it("skips review when the round changed nothing since the baseline, even though the tree is dirty", () => {
    // This is the case the baseline exists for: the tree carries a previous
    // chain's work, so chainChangedPaths is non-empty, but this round added
    // nothing of its own.
    const result = shouldSkipReview({
      chainStatusObserved: true,
      chainChangedPaths: ["src/foo.js", "src/bar.js"],
      chainNewlyChanged: [],
      chainDeliverables: ["src/foo.js"],
    });
    assert.equal(result, true);
  });

  it("does not skip review when the round changed a file, even if it was already dirty", () => {
    const result = shouldSkipReview({
      chainStatusObserved: true,
      chainChangedPaths: ["src/foo.js"],
      chainNewlyChanged: ["src/foo.js"],
      chainDeliverables: ["src/foo.js"],
    });
    assert.equal(result, false);
  });

  it("an unmeasurable round (null) is not treated as an empty one", () => {
    // null means the comparison could not be made.  Falling through to
    // chainChangedPaths keeps a real change set visible; collapsing null to []
    // here would discard a round because the measurement broke.
    const result = shouldSkipReview({
      chainStatusObserved: true,
      chainChangedPaths: ["src/foo.js"],
      chainNewlyChanged: null,
      chainDeliverables: ["src/foo.js"],
    });
    assert.equal(result, false);
  });

  it("an unmeasurable round on a genuinely empty tree still skips", () => {
    const result = shouldSkipReview({
      chainStatusObserved: true,
      chainChangedPaths: [],
      chainNewlyChanged: null,
      chainDeliverables: ["src/foo.js"],
    });
    assert.equal(result, true);
  });
});

// =========================================================================
// parseReviewResult — pure function for decision-path review parsing (AC3, AC4)
// =========================================================================

describe("parseReviewResult", () => {
  // AC3: VERDICT token inside JSON fence with findings recovery
  it("recovers verdict AND findings when VERDICT token appears inside JSON fence", () => {
    // Real-world incident: model emitted VERDICT: needs-attention inside the
    // JSON fence block, and the old strip regex (anchored to $) missed it.
    const payload = [
      "```json",
      "{",
      '  "schema_version": 1,',
      '  "verdict": "needs-attention",',
      '  "summary": "All five prior findings are genuinely fixed. The gate passes (451/451, zero lint/type issues). However, one function is dead code.",',
      '  "findings": [',
      '    { "severity": "low", "title": "Dead code in helper", "body": "Helper is unused.", "file": "src/utils.js", "line_start": 42, "line_end": 45, "confidence": 0.9, "recommendation": "Remove helper." }',
      "  ],",
      '  "next_steps": []',
      "}",
      "```",
      "",
      "VERDICT: needs-attention",
    ].join("\n");

    const result = parseReviewResult(payload);

    assert.equal(result.reviewParseable, true);
    assert.equal(result.chainVerdict, "needs-attention");
    // AC3: findings must be recovered, not replaced with "(no structured findings)"
    assert.ok(result.chainFindingsText.includes("Dead code in helper"));
    assert.ok(result.chainFindingsText.includes("src/utils.js:42"));
    assert.ok(!result.chainFindingsText.includes("(no structured findings)"));
  });

  it("recovers findings when VERDICT token appears after secondary fence", () => {
    // Another variant: token is between fences
    const payload = [
      "Here is my review:",
      "",
      "```json",
      "{",
      '  "schema_version": 1,',
      '  "verdict": "needs-attention",',
      '  "summary": "Looks ok",',
      '  "findings": [',
      '    { "severity": "medium", "title": "Magic number", "body": "Hardcoded const.", "file": "src/calc.js", "line_start": 7, "line_end": 7, "confidence": 0.8, "recommendation": "Use named const." }',
      "  ],",
      '  "next_steps": []',
      "}",
      "```",
      "```",
      "VERDICT: needs-attention",
      "```",
    ].join("\n");

    const result = parseReviewResult(payload);

    assert.equal(result.reviewParseable, true);
    assert.equal(result.chainVerdict, "needs-attention");
    assert.ok(result.chainFindingsText.includes("Magic number"));
    assert.ok(result.chainFindingsText.includes("src/calc.js:7"));
  });

  it("recovers approve verdict with empty findings", () => {
    const payload = "```json\n{\n  \"schema_version\": 1,\n  \"verdict\": \"approve\",\n  \"summary\": \"LGTM\",\n  \"findings\": [],\n  \"next_steps\": []\n}\n```";
    const result = parseReviewResult(payload);

    assert.equal(result.reviewParseable, true);
    assert.equal(result.chainVerdict, "approve");
    assert.equal(result.chainFindingsText, "(no structured findings)");
  });

  // AC4: unparseable review produces distinguishable state
  it("unparseable review: verdict recovered from token but findings unavailable", () => {
    const payload = [
      "Here is some text that is definitely not JSON.",
      "It doesn't have any structure at all.",
      "VERDICT: needs-attention",
    ].join("\n");

    const result = parseReviewResult(payload);

    // AC4: reviewParseable is false, verdict is recovered from token
    assert.equal(result.reviewParseable, false);
    assert.equal(result.chainVerdict, "needs-attention");
    // AC4: findingsText is distinct from "(no structured findings)" — it
    // explicitly states the review was unparseable
    assert.equal(result.chainFindingsText, "(review output could not be parsed)");
    assert.ok(result.chainFindingsText !== "(no structured findings)");
    assert.equal(result.chainParsedReview, null);
  });

  it("unparseable review without any token gives 'unparseable' verdict", () => {
    const payload = "gibberish without any verdict token at all";

    const result = parseReviewResult(payload);

    assert.equal(result.reviewParseable, false);
    assert.equal(result.chainVerdict, "unparseable");
    assert.equal(result.chainFindingsText, "(review output could not be parsed)");
    assert.equal(result.chainParsedReview, null);
  });

  it("unparseable review is distinguishable from genuine needs-attention", () => {
    // A genuine needs-attention review is parseable but has that verdict
    const genuinePayload = "```json\n{\n  \"schema_version\": 1,\n  \"verdict\": \"needs-attention\",\n  \"summary\": \"Issues found\",\n  \"findings\": [\n    { \"severity\": \"high\", \"title\": \"Bug\", \"body\": \"b\", \"file\": \"src/main.js\", \"line_start\": 1, \"line_end\": 2, \"confidence\": 0.9, \"recommendation\": \"r\" }\n  ],\n  \"next_steps\": []\n}\n```\nVERDICT: needs-attention";
    const genuine = parseReviewResult(genuinePayload);

    assert.equal(genuine.reviewParseable, true);
    assert.equal(genuine.chainVerdict, "needs-attention");
    assert.ok(genuine.chainFindingsText.includes("Bug"));

    // An unparseable review that happened to have VERDICT: needs-attention token
    const unparseablePayload = "Not JSON at all.\nVERDICT: needs-attention";
    const unparseable = parseReviewResult(unparseablePayload);

    assert.equal(unparseable.reviewParseable, false);
    assert.equal(unparseable.chainVerdict, "needs-attention");
    assert.equal(unparseable.chainFindingsText, "(review output could not be parsed)");

    // The two produce different reviewParseable and different findingsText
    // despite having the same verdict string.
  });

  // kusabi #392: strict validation rejects non-array findings instead of absorbing
  it("rejects a string findings field as unparseable with schemaErrors (kusabi #392)", () => {
    const payload = "```json\n{\n  \"schema_version\": 1,\n  \"verdict\": \"needs-attention\",\n  \"summary\": \"s\",\n  \"findings\": \"not an array\",\n  \"next_steps\": []\n}\n```";
    const result = parseReviewResult(payload);

    assert.equal(result.reviewParseable, false);
    assert.equal(result.chainVerdict, "unparseable");
    assert.equal(result.chainFindingsText, "(review output could not be parsed)");
    assert.equal(result.chainParsedReview, null);
    assert.ok(result.schemaErrors.some((e) => e.path === "/findings"));
  });

  it("rejects an object findings field as unparseable with schemaErrors (kusabi #392)", () => {
    const payload = "```json\n{\n  \"schema_version\": 1,\n  \"verdict\": \"approve\",\n  \"summary\": \"s\",\n  \"findings\": { \"file\": \"x.js\" },\n  \"next_steps\": []\n}\n```";
    const result = parseReviewResult(payload);

    assert.equal(result.reviewParseable, false);
    assert.equal(result.chainVerdict, "unparseable");
    assert.equal(result.chainFindingsText, "(review output could not be parsed)");
    assert.equal(result.chainParsedReview, null);
    assert.ok(result.schemaErrors.some((e) => e.path === "/findings"));
  });

  // ---- kusabi #60 step 1: `kind` tagging ----
  // The `kind` tag flows through to the stored findings untouched; the
  // one-line findingsText is grouped (design first, mechanical after) with a
  // missing/invalid kind defaulting to design at the consumption point.

  it("carries kind through to the parsed findings and groups the findingsText", () => {
    const payload = "```json\n{\n  \"schema_version\": 1,\n  \"verdict\": \"needs-attention\",\n  \"summary\": \"s\",\n  \"findings\": [\n    { \"severity\": \"high\", \"title\": \"Design call\", \"body\": \"b\", \"file\": \"src/a.js\", \"line_start\": 1, \"line_end\": 2, \"confidence\": 0.8, \"recommendation\": \"r\", \"kind\": \"design\" },\n    { \"severity\": \"low\", \"title\": \"Rename var\", \"body\": \"b\", \"file\": \"src/b.js\", \"line_start\": 2, \"line_end\": 3, \"confidence\": 0.9, \"recommendation\": \"r\", \"kind\": \"mechanical\" }\n  ],\n  \"next_steps\": []\n}\n```";
    const result = parseReviewResult(payload);

    assert.equal(result.reviewParseable, true);
    // Raw kind tags survive on the parsed findings (stored untouched).
    assert.equal(result.chainParsedReview.findings[0].kind, "design");
    assert.equal(result.chainParsedReview.findings[1].kind, "mechanical");
    // Grouped one-line text: design section first, mechanical after.
    const text = result.chainFindingsText;
    const designIdx = text.indexOf("Design findings (require deliberate individual treatment)");
    const mechIdx = text.indexOf("Mechanical findings (checklist)");
    assert.ok(designIdx >= 0, text);
    assert.ok(mechIdx >= 0, text);
    assert.ok(designIdx < mechIdx, "design section must precede mechanical");
    assert.ok(text.indexOf("Design call") < text.indexOf("Rename var"));
    assert.ok(text.includes("[high] Design call (src/a.js:1)"));
    assert.ok(text.includes("[low] Rename var (src/b.js:2)"));
  });

  it("treats a missing kind as design (safe side) in the grouped findingsText", () => {
    const payload = "```json\n{\n  \"schema_version\": 1,\n  \"verdict\": \"needs-attention\",\n  \"summary\": \"s\",\n  \"findings\": [\n    { \"severity\": \"medium\", \"title\": \"No kind tag\", \"body\": \"b\", \"file\": \"src/c.js\", \"line_start\": 3, \"line_end\": 4, \"confidence\": 0.7, \"recommendation\": \"r\" }\n  ],\n  \"next_steps\": []\n}\n```";
    const result = parseReviewResult(payload);

    assert.equal(result.reviewParseable, true);
    // Missing kind -> design section, single section (no mechanical heading).
    const text = result.chainFindingsText;
    assert.ok(text.includes("Design findings (require deliberate individual treatment)"), text);
    assert.ok(!text.includes("Mechanical findings (checklist)"), text);
    assert.ok(text.includes("[medium] No kind tag (src/c.js:3)"));
  });

  it("rejects an invalid kind as unparseable with schemaErrors (kusabi #392)", () => {
    const payload = "```json\n{\n  \"schema_version\": 1,\n  \"verdict\": \"needs-attention\",\n  \"summary\": \"s\",\n  \"findings\": [\n    { \"severity\": \"low\", \"title\": \"Weird kind\", \"body\": \"b\", \"file\": \"src/d.js\", \"line_start\": 4, \"line_end\": 5, \"confidence\": 0.8, \"recommendation\": \"r\", \"kind\": \"cosmetic\" }\n  ],\n  \"next_steps\": []\n}\n```";
    const result = parseReviewResult(payload);

    assert.equal(result.reviewParseable, false);
    assert.equal(result.chainVerdict, "unparseable");
    assert.ok(result.schemaErrors.some((e) => e.path === "/findings/0/kind"));
  });

  it("keeps kind through the VERDICT-token recovery (extractJson) path", () => {
    // Real-world shape from the extractJson recovery path (#170): the token
    // sits inside the JSON fence and must be stripped before parsing.
    const payload = [
      "```json",
      "{",
      '  "schema_version": 1,',
      '  "verdict": "needs-attention",',
      '  "summary": "s",',
      '  "findings": [',
      '    { "severity": "high", "title": "Recovered", "body": "b", "file": "src/e.js", "line_start": 5, "line_end": 6, "confidence": 0.9, "recommendation": "r", "kind": "mechanical" }',
      '  ],',
      '  "next_steps": []',
      "}",
      "```",
      "",
      "VERDICT: needs-attention",
    ].join("\n");
    const result = parseReviewResult(payload);

    assert.equal(result.reviewParseable, true);
    assert.equal(result.chainVerdict, "needs-attention");
    assert.equal(result.chainParsedReview.findings[0].kind, "mechanical");
    assert.ok(result.chainFindingsText.includes("Mechanical findings (checklist)"));
    assert.ok(result.chainFindingsText.includes("[high] Recovered (src/e.js:5)"));
  });

  it("legacy object with schema_version: 2 or omitted is unparseable (AC1, kusabi #392)", () => {
    const withoutVersion = JSON.stringify({
      verdict: "needs-attention",
      summary: "One defect",
      findings: [
        { severity: "high", title: "Bug", body: "b", file: "src/a.js", line_start: 1, line_end: 2, confidence: 0.9, recommendation: "r" },
      ],
      next_steps: [],
    });
    const resWithout = parseReviewResult(withoutVersion);
    assert.equal(resWithout.reviewParseable, false);
    assert.equal(resWithout.chainVerdict, "unparseable");
    assert.equal(resWithout.chainParsedReview, null);
    assert.ok(resWithout.schemaErrors.some((e) => e.path === "/schema_version"));

    const withVersion2 = JSON.stringify({
      schema_version: 2,
      verdict: "needs-attention",
      summary: "One defect",
      findings: [
        { severity: "high", title: "Bug", body: "b", file: "src/a.js", line_start: 1, line_end: 2, confidence: 0.9, recommendation: "r" },
      ],
      next_steps: [],
    });
    const resV2 = parseReviewResult(withVersion2);
    assert.equal(resV2.reviewParseable, false);
    assert.equal(resV2.chainVerdict, "unparseable");
    assert.equal(resV2.chainParsedReview, null);
    assert.ok(resV2.schemaErrors.some((e) => e.path === "/schema_version"));
  });
});

// =========================================================================
// parseReviewResult — JSONL input (kusabi #202)
//
// JSONL is a WIRE format: the records assemble into the same in-memory shape
// the single-object path produces.  The single-object path itself is
// unchanged, which the byte-identical findingsText assertion below pins down.
// =========================================================================

describe("parseReviewResult — JSONL review stream (kusabi #202)", () => {
  // One review, expressed both ways.  Shared so the equivalence assertion
  // cannot drift into comparing two different reviews.
  const DESIGN_FINDING = {
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
  const MECHANICAL_FINDING = {
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
  const SUMMARY = "One real defect and one nit; do not ship as is.";
  const REVIEW_OBJECT = {
    schema_version: 1,
    verdict: "needs-attention",
    summary: SUMMARY,
    findings: [DESIGN_FINDING, MECHANICAL_FINDING],
    next_steps: ["add a truncation test"],
    unverified: ["could not exercise the timeout path"],
  };

  // The historical wire shape: fenced pretty-printed object + VERDICT token.
  const LEGACY_PAYLOAD = [
    "```json",
    JSON.stringify(REVIEW_OBJECT, null, 2),
    "```",
    "",
    "VERDICT: needs-attention",
  ].join("\n");

  // The same review as JSONL, emitted piece by piece.
  const JSONL_PAYLOAD = [
    JSON.stringify({ type: "finding", ...DESIGN_FINDING }),
    JSON.stringify({ type: "finding", ...MECHANICAL_FINDING }),
    JSON.stringify({ type: "unverified", text: "could not exercise the timeout path" }),
    JSON.stringify({ type: "next_step", text: "add a truncation test" }),
    JSON.stringify({ type: "verdict", schema_version: 1, verdict: "needs-attention", summary: SUMMARY }),
  ].join("\n");

  // The exact findingsText the single-object path produces today, spelled out
  // so a change to either path shows up as a diff on this literal.
  const EXPECTED_FINDINGS_TEXT = [
    "## Design findings (require deliberate individual treatment)",
    "",
    "[high] Retry spends the budget that just failed (plugins/kusabi/scripts/chain-phases.mjs:12)",
    "",
    "## Mechanical findings (checklist)",
    "",
    "[low] Stale comment names the removed helper (plugins/kusabi/scripts/render.mjs:3)",
  ].join("\n");

  it("assembles a JSONL stream into the shape the single-object path produces", () => {
    const jsonl = parseReviewResult(JSONL_PAYLOAD);
    const legacy = parseReviewResult(LEGACY_PAYLOAD);

    assert.deepEqual(jsonl.chainParsedReview, legacy.chainParsedReview);
    assert.equal(jsonl.chainFindingsText, legacy.chainFindingsText);
    assert.equal(jsonl.chainVerdict, legacy.chainVerdict);
    assert.equal(jsonl.reviewParseable, legacy.reviewParseable);
    // Spelled out, not just "equal to the other path":
    assert.deepEqual(jsonl.chainParsedReview, REVIEW_OBJECT);
    assert.equal(jsonl.chainVerdict, "needs-attention");
    assert.equal(jsonl.reviewParseable, true);
    assert.equal(jsonl.reviewPartial, false);
    assert.equal(jsonl.reviewFindingCount, 2);
  });

  it("keeps a single JSON object byte-identical (findingsText) to today", () => {
    const legacy = parseReviewResult(LEGACY_PAYLOAD);

    assert.equal(legacy.chainFindingsText, EXPECTED_FINDINGS_TEXT);
    assert.equal(legacy.chainVerdict, "needs-attention");
    assert.equal(legacy.reviewParseable, true);
    assert.equal(legacy.reviewPartial, false);
    // The JSONL path must reach exactly the same bytes.
    assert.equal(parseReviewResult(JSONL_PAYLOAD).chainFindingsText, EXPECTED_FINDINGS_TEXT);
  });

  it("keeps findings in emission order, not schema or severity order", () => {
    const reversed = [
      JSON.stringify({ type: "finding", ...MECHANICAL_FINDING }),
      JSON.stringify({ type: "finding", ...DESIGN_FINDING }),
      JSON.stringify({ type: "verdict", schema_version: 1, verdict: "needs-attention", summary: SUMMARY }),
    ].join("\n");

    const result = parseReviewResult(reversed);

    assert.deepEqual(
      result.chainParsedReview.findings.map(function (f) { return f.title; }),
      [MECHANICAL_FINDING.title, DESIGN_FINDING.title],
    );
  });

  it("ignores prose interleaved between records", () => {
    const narrated = [
      "Checklist point 1 — retry semantics. Reading chain-phases.mjs now.",
      JSON.stringify({ type: "finding", ...DESIGN_FINDING }),
      "Point 2 — comments. One is stale:",
      JSON.stringify({ type: "finding", ...MECHANICAL_FINDING }),
      JSON.stringify({ type: "unverified", text: "could not exercise the timeout path" }),
      "Nothing else I can defend from the diff.",
      JSON.stringify({ type: "next_step", text: "add a truncation test" }),
      JSON.stringify({ type: "verdict", schema_version: 1, verdict: "needs-attention", summary: SUMMARY }),
    ].join("\n");

    const result = parseReviewResult(narrated);

    assert.deepEqual(result.chainParsedReview, REVIEW_OBJECT);
    assert.equal(result.chainFindingsText, EXPECTED_FINDINGS_TEXT);
  });

  it("a stream truncated after the findings is a partial review carrying them", () => {
    const truncated = [
      JSON.stringify({ type: "finding", ...DESIGN_FINDING }),
      JSON.stringify({ type: "finding", ...MECHANICAL_FINDING }),
      "Point 3 — I still need to check the empty-strea",
    ].join("\n");

    const result = parseReviewResult(truncated);

    assert.equal(result.chainVerdict, "partial");
    assert.equal(result.reviewPartial, true);
    assert.equal(result.reviewFindingCount, 2);
    // Partial is NOT unparseable: we read the output fine, so the review is
    // parseable and the docs/design/phase-chain.md §3.5 retry (gated on
    // "unparseable") cannot fire.
    assert.equal(result.reviewParseable, true);
    assert.notEqual(result.chainVerdict, "unparseable");
    // The findings it did carry are rendered like any other findings.
    assert.equal(result.chainFindingsText, EXPECTED_FINDINGS_TEXT);
    assert.deepEqual(result.chainParsedReview.findings, [DESIGN_FINDING, MECHANICAL_FINDING]);
    assert.equal(result.chainParsedReview.verdict, "partial");
    assert.match(result.chainParsedReview.summary, /partial review/);
    assert.match(result.chainParsedReview.summary, /2 findings/);
  });

  it("a stream with a verdict line yields that verdict and is not partial", () => {
    for (const verdict of ["approve", "approve-partial", "needs-attention", "discard"]) {
      const stream = [
        JSON.stringify({ type: "finding", ...MECHANICAL_FINDING }),
        JSON.stringify({
          type: "verdict",
          schema_version: 1,
          verdict,
          summary: "s",
          ...(verdict === "discard" ? { discard_reason: "wrong_premise" } : {}),
        }),
      ].join("\n");

      const result = parseReviewResult(stream);

      assert.equal(result.chainVerdict, verdict);
      assert.equal(result.reviewPartial, false);
      assert.equal(result.reviewParseable, true);
    }
  });

  it("a malformed line among valid ones costs only that line", () => {
    const stream = [
      JSON.stringify({ type: "finding", ...DESIGN_FINDING }),
      '{"type":"finding","severity":"high",,,"title":"broken record"}',
      JSON.stringify({ type: "finding", ...MECHANICAL_FINDING }),
      JSON.stringify({ type: "unverified", text: "could not exercise the timeout path" }),
      JSON.stringify({ type: "next_step", text: "add a truncation test" }),
      JSON.stringify({ type: "verdict", schema_version: 1, verdict: "needs-attention", summary: SUMMARY }),
    ].join("\n");

    const result = parseReviewResult(stream);

    // Identical to the clean stream: the broken line took nothing with it.
    assert.deepEqual(result.chainParsedReview, REVIEW_OBJECT);
    assert.equal(result.chainFindingsText, EXPECTED_FINDINGS_TEXT);
    assert.equal(result.reviewFindingCount, 2);
  });

  it("an empty or whitespace-only stream is the existing unparseable state, not a crash", () => {
    for (const payload of ["", "   ", "\n\n \n"]) {
      const result = parseReviewResult(payload);

      assert.equal(result.chainVerdict, "unparseable");
      assert.equal(result.reviewParseable, false);
      assert.equal(result.reviewPartial, false);
      assert.equal(result.chainParsedReview, null);
      assert.equal(result.chainFindingsText, "(review output could not be parsed)");
    }
  });

  it("a JSONL stream with no findings and a verdict is an ordinary review", () => {
    const stream = JSON.stringify({ type: "verdict", schema_version: 1, verdict: "approve", summary: "Nothing to block on." });

    const result = parseReviewResult(stream);

    assert.equal(result.chainVerdict, "approve");
    assert.equal(result.reviewPartial, false);
    assert.equal(result.salvagedVerdict, false);
    assert.equal(result.partialDiagnosis, null);
    assert.equal(result.chainFindingsText, "(no structured findings)");
    assert.deepEqual(result.chainParsedReview, {
      schema_version: 1, verdict: "approve", summary: "Nothing to block on.", findings: [], next_steps: [],
    });
  });

  it("salvages the verdict from an unterminated JSONL verdict line (kusabi #312)", () => {
    const stream = [
      JSON.stringify({ type: "finding", ...MECHANICAL_FINDING }),
      '{"type":"verdict","verdict":"approve","summary":"LGTM',
    ].join("\n");

    const result = parseReviewResult(stream);

    assert.equal(result.chainVerdict, "approve");
    assert.equal(result.reviewPartial, false);
    assert.equal(result.reviewParseable, true);
    assert.equal(result.salvagedVerdict, true);
    assert.equal(result.partialDiagnosis, null);
    assert.equal(result.chainParsedReview.salvagedVerdict, true);
  });

  it("returns partialDiagnosis and salvagedVerdict: false when a JSONL stream is partial (kusabi #312)", () => {
    const stream = [
      JSON.stringify({ type: "finding", ...DESIGN_FINDING }),
      "Point 3 — I still need to check the empty-strea",
    ].join("\n");

    const result = parseReviewResult(stream);

    assert.equal(result.chainVerdict, "partial");
    assert.equal(result.reviewPartial, true);
    assert.equal(result.salvagedVerdict, false);
    assert.equal(
      result.partialDiagnosis,
      "format: records present but no verdict record arrived",
    );
  });

  it("rejects JSONL stream with schema_version: 2 or omitted on verdict record (AC1, kusabi #392)", () => {
    const streamWithout = [
      JSON.stringify({ type: "finding", ...DESIGN_FINDING }),
      JSON.stringify({ type: "verdict", verdict: "approve", summary: "LGTM" }),
    ].join("\n");
    const resWithout = parseReviewResult(streamWithout);
    assert.equal(resWithout.reviewParseable, false);
    assert.equal(resWithout.chainVerdict, "unparseable");
    assert.equal(resWithout.chainParsedReview, null);
    assert.ok(resWithout.schemaErrors.some((e) => e.path === "/schema_version"));

    const streamV2 = [
      JSON.stringify({ type: "finding", ...DESIGN_FINDING }),
      JSON.stringify({ type: "verdict", schema_version: 2, verdict: "approve", summary: "LGTM" }),
    ].join("\n");
    const resV2 = parseReviewResult(streamV2);
    assert.equal(resV2.reviewParseable, false);
    assert.equal(resV2.chainVerdict, "unparseable");
    assert.equal(resV2.chainParsedReview, null);
    assert.ok(resV2.schemaErrors.some((e) => e.path === "/schema_version"));
  });

  it("rejects JSONL stream with extra unknown keys on finding or verdict (AC2, kusabi #392)", () => {
    const streamExtraFinding = [
      JSON.stringify({ type: "finding", ...DESIGN_FINDING, unknown_field: "bad" }),
      JSON.stringify({ type: "verdict", schema_version: 1, verdict: "approve", summary: "LGTM" }),
    ].join("\n");
    const resFinding = parseReviewResult(streamExtraFinding);
    assert.equal(resFinding.reviewParseable, false);
    assert.equal(resFinding.chainVerdict, "unparseable");
    assert.ok(resFinding.schemaErrors.some((e) => e.path === "/findings/0/unknown_field"));

    const streamExtraVerdict = [
      JSON.stringify({ type: "finding", ...DESIGN_FINDING }),
      JSON.stringify({ type: "verdict", schema_version: 1, verdict: "approve", summary: "LGTM", extra_verdict_key: 123 }),
    ].join("\n");
    const resVerdict = parseReviewResult(streamExtraVerdict);
    assert.equal(resVerdict.reviewParseable, false);
    assert.equal(resVerdict.chainVerdict, "unparseable");
    assert.ok(resVerdict.schemaErrors.some((e) => e.path === "/extra_verdict_key"));
  });
});

// ---------------------------------------------------------------------------
// runReviewPhase — stubbed dispatch route recording
// ---------------------------------------------------------------------------

describe("runReviewPhase — stubbed dispatch route recording", () => {
  it("records reviewModelEntry and reviewModelVariant on the roundRecord", async () => {
    function stubbedDispatch() {
      return {
        job: {
          id: "review-job-1",
          status: "completed",
          modelEntry: "test-org/test-review-model:variant",
          modelVariant: "variant",
          fallbacks: null,
          usage: null,
          error: null,
        },
        resultText: JSON.stringify({ verdict: "approve", findings: [] }),
      };
    }

    const roundRecord = { round: 1 };

    const result = await runReviewPhase({
      container: "test",
      brief: "test brief",
      modelChain: ["test-org/test-flash", "test-org/test-pro"],
      chainId: "test-chain",
      cwd: process.cwd(),
      previousRecord: null,
      baseSha: "abc123",
      chainStatusOutput: "",
      chainBaseLog: "",
      chainUntracked: "",
      roundRecord,
      chainChangedPaths: [],
      chainStatusObserved: false,
      chainDeliverables: [],
      flagsModel: null,
      _dispatchWithFallback: stubbedDispatch,
    });

    assert.equal(roundRecord.reviewModelEntry, "test-org/test-review-model:variant");
    assert.equal(roundRecord.reviewModelVariant, "variant");
    assert.equal(roundRecord.reviewFallbacks, null);
    assert.equal(result.reviewJobStatus, "completed");
  });

  it("records reviewFallbacks when dispatch had fallbacks", async () => {
    function stubbedDispatch() {
      return {
        job: {
          id: "review-job-2",
          status: "completed",
          modelEntry: "test-org/test-review-model",
          modelVariant: null,
          fallbacks: [
            { from: "test-org/old-route", to: "test-org/test-review-model", reason: "capacity", attempt: 1, message: "busy" },
          ],
          usage: null,
          error: null,
        },
        resultText: JSON.stringify({ verdict: "approve", findings: [] }),
      };
    }

    const roundRecord = { round: 1 };

    await runReviewPhase({
      container: "test",
      brief: "test brief",
      modelChain: ["test-org/test-flash", "test-org/test-pro"],
      chainId: "test-chain",
      cwd: process.cwd(),
      previousRecord: null,
      baseSha: "abc123",
      chainStatusOutput: "",
      chainBaseLog: "",
      chainUntracked: "",
      roundRecord,
      chainChangedPaths: ["some/file"],
      chainStatusObserved: true,
      chainDeliverables: ["test/file"],
      flagsModel: null,
      _dispatchWithFallback: stubbedDispatch,
    });

    assert.ok(Array.isArray(roundRecord.reviewFallbacks));
    assert.equal(roundRecord.reviewFallbacks.length, 1);
    assert.equal(roundRecord.reviewFallbacks[0].from, "test-org/old-route");
  });
});

// ---------------------------------------------------------------------------
// Fallback trails: the three states must stay distinguishable on disk
// ---------------------------------------------------------------------------

describe("runReviewPhase fallback trail fidelity", () => {
  function dispatchReturning(fallbacks) {
    return function stubbedDispatch() {
      return {
        job: {
          id: "job-1",
          status: "completed",
          modelEntry: "test-org/test-review-model",
          modelVariant: null,
          fallbacks,
          usage: null,
          error: null,
        },
        resultText: JSON.stringify({ verdict: "approve", findings: [] }),
      };
    };
  }

  async function runWith(fallbacks) {
    const roundRecord = { round: 1 };
    await runReviewPhase({
      container: "test",
      brief: "test brief",
      modelChain: ["test-org/test-flash", "test-org/test-pro"],
      chainId: "test-chain",
      cwd: process.cwd(),
      previousRecord: null,
      baseSha: "abc123",
      chainStatusOutput: "",
      chainBaseLog: "",
      chainUntracked: "",
      roundRecord,
      chainChangedPaths: [],
      chainStatusObserved: false,
      chainDeliverables: [],
      flagsModel: null,
      _dispatchWithFallback: dispatchReturning(fallbacks),
    });
    return roundRecord;
  }

  it("preserves an empty fallback array instead of collapsing it to null", async () => {
    const roundRecord = await runWith([]);
    assert.ok(
      Array.isArray(roundRecord.reviewFallbacks),
      "empty array must survive as an array, not become null",
    );
    assert.equal(roundRecord.reviewFallbacks.length, 0);
  });

  it("still maps an absent fallback trail to null", async () => {
    const roundRecord = await runWith(undefined);
    assert.equal(roundRecord.reviewFallbacks, null);
  });
});

// ---------------------------------------------------------------------------
// runReviewPhase — single result conduit (kusabi #100)
// ---------------------------------------------------------------------------

describe("runReviewPhase — single result conduit (kusabi #100)", () => {
  function stubbedDispatch() {
    return {
      job: {
        id: "job-1",
        status: "completed",
        modelEntry: "test-org/test-review-model:variant",
        modelVariant: "variant",
        fallbacks: null,
        usage: { available: true, input: 3, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001 },
        error: null,
      },
      resultText: JSON.stringify({
        schema_version: 1,
        verdict: "needs-attention",
        summary: "s",
        findings: [
          { severity: "high", title: "Design call", body: "b", file: "src/a.js", line_start: 1, line_end: 2, confidence: 0.8, recommendation: "r", kind: "design" },
          { severity: "low", title: "Rename", body: "b", file: "src/b.js", line_start: 2, line_end: 3, confidence: 0.9, recommendation: "r", kind: "mechanical" },
        ],
        next_steps: [],
      }),
    };
  }

  async function runPhase(roundRecord, extra = {}) {
    return runReviewPhase({
      container: "test",
      brief: "test brief",
      modelChain: ["test-org/test-flash", "test-org/test-pro"],
      chainId: "test-chain",
      cwd: process.cwd(),
      previousRecord: null,
      baseSha: "abc123",
      chainStatusOutput: "",
      chainBaseLog: "",
      chainUntracked: "",
      roundRecord,
      chainChangedPaths: [],
      chainStatusObserved: false,
      chainDeliverables: [],
      flagsModel: null,
      _dispatchWithFallback: stubbedDispatch,
      ...extra,
    });
  }

  it("persists every record field onto roundRecord after a simulated review phase", async () => {
    const roundRecord = { round: 1 };
    await runPhase(roundRecord);

    // --- record fields (the persisted contract) ---
    assert.equal(roundRecord.verdict, "needs-attention");
    assert.equal(roundRecord.reviewParseable, true);
    assert.equal(roundRecord.reviewJobId, "job-1");
    assert.equal(roundRecord.reviewModelEntry, "test-org/test-review-model:variant");
    assert.equal(roundRecord.reviewModelVariant, "variant");
    assert.equal(roundRecord.reviewFallbacks, null);
    assert.equal(roundRecord.reviewUsage.available, true);
    // Raw findings (with kind tags) land on the record untouched.
    assert.equal(roundRecord.findings.length, 2);
    assert.equal(roundRecord.findings[0].kind, "design");
    assert.equal(roundRecord.findings[1].kind, "mechanical");
    assert.deepEqual(roundRecord.findingFiles, ["src/a.js", "src/b.js"]);
    // Grouped findingsText (design section first).
    assert.ok(roundRecord.findingsText.includes("Design findings (require deliberate individual treatment)"));
    assert.ok(roundRecord.findingsText.includes("Mechanical findings (checklist)"));
  });

  it("returns exactly the non-record keys (single conduit)", async () => {
    const roundRecord = { round: 1 };
    const result = await runPhase(roundRecord);
    assert.deepEqual(
      Object.keys(result).sort(),
      ["chainParsedReview", "chainRepeatedAreas", "reviewJobError", "reviewJobStatus", "skipReview"],
    );
    assert.equal(result.chainParsedReview.findings[0].kind, "design");
    assert.equal(result.chainRepeatedAreas, false);
    assert.equal(result.skipReview, false);
    assert.equal(result.reviewJobStatus, "completed");
  });

  it("record-derived values reach the disposition inputs from roundRecord, not the return", async () => {
    const roundRecord = { round: 1 };
    const result = await runPhase(roundRecord);
    // The disposition phase reads verdict / findingsText from the record
    // (caller does `const chainVerdict = roundRecord.verdict`), and the
    // return must not shadow them with a second conduit.
    assert.equal(Object.hasOwn(result, "chainVerdict"), false);
    assert.equal(Object.hasOwn(result, "chainFindingsText"), false);
    assert.equal(Object.hasOwn(result, "reviewParseable"), false);
    assert.equal(roundRecord.verdict, "needs-attention");
    assert.ok(roundRecord.findingsText.includes("[high] Design call (src/a.js:1)"));
  });
});

// ---------------------------------------------------------------------------
// runReviewPhase — one retry on unparseable review output (issue #145)
// ---------------------------------------------------------------------------

describe("runReviewPhase — unparseable-output retry (issue #145)", () => {
  function makeDispatch(results) {
    const calls = [];
    function stubbedDispatch(options) {
      calls.push(options);
      return results.shift();
    }
    return { stubbedDispatch, calls };
  }

  function fakeJob(id, resultText, extra = {}) {
    return {
      job: {
        id,
        status: "completed",
        modelEntry: "test-org/test-review-model",
        modelVariant: null,
        fallbacks: null,
        usage: null,
        error: null,
        ...extra,
      },
      resultText,
    };
  }

  const GARBAGE = "definitely not JSON and no VERDICT token here at all";
  const GARBAGE_WITH_TOKEN = "not JSON either\nVERDICT: needs-attention";
  const VALID = JSON.stringify({
    schema_version: 1,
    verdict: "needs-attention",
    summary: "One real finding.",
    findings: [
      { severity: "medium", title: "Off-by-one", body: "b", file: "src/calc.js", line_start: 7, line_end: 7, confidence: 0.8, recommendation: "r" },
    ],
    next_steps: [],
  });

  async function runWith(results, extra = {}) {
    const { stubbedDispatch, calls } = makeDispatch(results);
    const roundRecord = { round: 1 };
    const result = await runReviewPhase({
      container: "test",
      brief: "test brief",
      modelChain: ["test-org/test-flash", "test-org/test-pro"],
      chainId: "test-chain",
      cwd: process.cwd(),
      previousRecord: null,
      baseSha: "abc123",
      chainStatusOutput: "",
      chainBaseLog: "",
      chainUntracked: "",
      roundRecord,
      chainChangedPaths: [],
      chainStatusObserved: false,
      chainDeliverables: [],
      flagsModel: null,
      _dispatchWithFallback: stubbedDispatch,
      ...extra,
    });
    return { result, roundRecord, calls };
  }

  it("parseable first result: exactly 1 dispatch call, no retry flag", async () => {
    const { roundRecord, calls } = await runWith([
      fakeJob("job-ok", VALID),
    ]);

    assert.equal(calls.length, 1);
    assert.equal(roundRecord.reviewUnparseableRetried, undefined);
    assert.equal(roundRecord.reviewFirstJobId, undefined);
    assert.equal(roundRecord.reviewFirstUsage, undefined);
    assert.equal(roundRecord.reviewFirstFallbacks, undefined);
    assert.equal(roundRecord.reviewJobId, "job-ok");
    assert.equal(roundRecord.verdict, "needs-attention");
    assert.ok(roundRecord.findingsText.includes("Off-by-one"));
    assert.equal(roundRecord.reviewParseable, true);
  });

  it("garbage then valid: 2 dispatch calls, final-attempt fields win, retry recorded", async () => {
    const { roundRecord, calls } = await runWith([
      fakeJob("job-broken-1", GARBAGE, { usage: { available: true, input: 5, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001 }, fallbacks: ["test-org/test-flash"] }),
      fakeJob("job-fixed-2", VALID, { usage: { available: true, input: 9, output: 4 }, modelEntry: "test-org/test-fixed-model" }),
    ]);

    assert.equal(calls.length, 2);
    assert.equal(roundRecord.reviewUnparseableRetried, true);
    assert.equal(roundRecord.reviewFirstJobId, "job-broken-1");
    // The first attempt's spend and fallback trail are kept on retried rounds
    // so chain totals reflect the true cost.
    assert.deepEqual(roundRecord.reviewFirstUsage, { available: true, input: 5, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001 });
    assert.deepEqual(roundRecord.reviewFirstFallbacks, ["test-org/test-flash"]);
    // All review* fields reflect the FINAL attempt.
    assert.equal(roundRecord.reviewJobId, "job-fixed-2");
    assert.equal(roundRecord.reviewModelEntry, "test-org/test-fixed-model");
    assert.deepEqual(roundRecord.reviewUsage, { available: true, input: 9, output: 4 });
    // Chain totals count BOTH attempts.
    const totals = computeChainTotals([roundRecord]);
    assert.equal(totals.input, 14);   // 5 + 9
    assert.equal(totals.output, 6);   // 2 + 4
    assert.equal(totals.cost, 0.001); // first attempt only (final attempt has no cost)
    assert.equal(roundRecord.verdict, "needs-attention");
    assert.ok(roundRecord.findingsText.includes("Off-by-one"));
    assert.equal(roundRecord.reviewParseable, true);
    // Both dispatches carried identical options.
    assert.deepEqual(calls[0], calls[1]);
    assert.ok(calls[0].promptText.includes("test brief"));
    assert.equal(calls[0].agent, "kusabi-review");
    assert.equal(calls[0].round, 1);
  });

  it("both dispatches garbage: 2 dispatch calls, verdict stays unparseable", async () => {
    const { roundRecord, calls } = await runWith([
      fakeJob("job-g1", GARBAGE),
      fakeJob("job-g2", GARBAGE),
    ]);

    assert.equal(calls.length, 2);
    assert.equal(roundRecord.reviewUnparseableRetried, true);
    assert.equal(roundRecord.reviewFirstJobId, "job-g1");
    assert.equal(roundRecord.reviewJobId, "job-g2");
    assert.equal(roundRecord.verdict, "unparseable");
    assert.equal(roundRecord.reviewParseable, false);
    assert.equal(roundRecord.findingsText, "(review output could not be parsed)");
    // First-attempt fields are recorded (null usage here) when a retry happens.
    assert.equal(roundRecord.reviewFirstUsage, null);
    assert.equal(roundRecord.reviewFirstFallbacks, null);
  });

  // A first job that FAILED outright (serve-dead / stalled / timeout / error)
  // returns empty or garbage resultText — re-dispatching would double
  // worst-case latency in exactly the degraded environments where it is
  // known-futile.  The retry is gated on job.status === "completed": these
  // never get a second dispatch and escalate after a single attempt.
  const HARD_FAILURES = ["serve-dead", "provider-error", "stalled", "timeout", "error"];
  for (const status of HARD_FAILURES) {
    it("first job " + status + " with empty resultText: exactly 1 dispatch call, no retry, unparseable escalates", async () => {
      const { roundRecord, calls } = await runWith([
        fakeJob("job-" + status, "", { status, usage: { available: true, input: 7, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.001 }, fallbacks: ["test-org/test-flash"] }),
      ]);

      assert.equal(calls.length, 1);
      assert.equal(roundRecord.reviewUnparseableRetried, undefined);
      assert.equal(roundRecord.reviewFirstJobId, undefined);
      assert.equal(roundRecord.reviewFirstUsage, undefined);
      assert.equal(roundRecord.reviewFirstFallbacks, undefined);
      assert.equal(roundRecord.reviewJobId, "job-" + status);
      assert.equal(roundRecord.verdict, "unparseable");
      assert.equal(roundRecord.reviewParseable, false);
      assert.equal(roundRecord.findingsText, "(review output could not be parsed)");
    });
  }

  it("unparseable JSON with recoverable VERDICT token: exactly 1 dispatch call, no retry", async () => {
    const { roundRecord, calls } = await runWith([
      fakeJob("job-token", GARBAGE_WITH_TOKEN),
    ]);

    assert.equal(calls.length, 1);
    assert.equal(roundRecord.reviewUnparseableRetried, undefined);
    assert.equal(roundRecord.reviewFirstJobId, undefined);
    assert.equal(roundRecord.reviewFirstUsage, undefined);
    assert.equal(roundRecord.reviewFirstFallbacks, undefined);
    assert.equal(roundRecord.reviewJobId, "job-token");
    assert.equal(roundRecord.verdict, "needs-attention");
    assert.equal(roundRecord.reviewParseable, false);
    assert.equal(roundRecord.verdictSource, "recovered-from-token");
    assert.equal(roundRecord.findingsText, "(review output could not be parsed)");
  });

  it("probe-driven skipReview: 0 dispatch calls, unchanged", async () => {
    const { result, roundRecord, calls } = await runWith([], {
      chainChangedPaths: [],
      chainNewlyChanged: [],
      chainStatusObserved: true,
      chainDeliverables: ["src/foo.js"],
    });

    assert.equal(calls.length, 0);
    assert.equal(result.skipReview, true);
    assert.equal(roundRecord.verdict, "discard");
    assert.equal(roundRecord.verdictSource, "probe");
    assert.equal(roundRecord.reviewUnparseableRetried, undefined);
    assert.equal(roundRecord.reviewFirstUsage, undefined);
    assert.equal(roundRecord.reviewFirstFallbacks, undefined);
  });

  // ---- the discarded round says whether the work is still there (kusabi #299) ----
  // "This round added nothing since the baseline" and "the container is empty"
  // are different facts, and the incident happened because the record only
  // carried the first one.  Both are now recorded, from the change set P3
  // already captured.

  it("probe-driven skipReview on a dirty tree: records worktreeDirtyVsBase true", async () => {
    // The incident shape: rounds 1–2 changed these files, this round added
    // nothing of its own, so newlyChanged is empty while the tree is dirty.
    const { result, roundRecord } = await runWith([], {
      chainChangedPaths: ["src/foo.js", "src/bar.js"],
      chainNewlyChanged: [],
      chainStatusObserved: true,
      chainDeliverables: ["src/foo.js"],
    });

    assert.equal(result.skipReview, true);
    assert.equal(roundRecord.verdict, "discard");
    assert.equal(roundRecord.verdictSource, "probe");
    assert.equal(roundRecord.worktreeDirtyVsBase, true);
  });

  it("probe-driven skipReview on a clean tree: records worktreeDirtyVsBase false", async () => {
    const { roundRecord } = await runWith([], {
      chainChangedPaths: [],
      chainNewlyChanged: [],
      chainStatusObserved: true,
      chainDeliverables: ["src/foo.js"],
    });

    assert.equal(roundRecord.worktreeDirtyVsBase, false);
  });

  it("a round that WAS reviewed carries no worktreeDirtyVsBase — the field is the probe-discard's own", async () => {
    const { result, roundRecord } = await runWith([fakeJob("job-ok", VALID)]);
    assert.equal(result.skipReview, false);
    assert.equal(roundRecord.worktreeDirtyVsBase, undefined);
  });
});

// =========================================================================
// runReviewPhase — partial JSONL review (kusabi #202)
//
// A JSONL stream with findings but no verdict line is a partial review.  It
// must NOT trigger the unparseable retry (#145): the output was read fine,
// the model ran out of room, and re-dispatching spends the budget that just
// proved insufficient.  The round record has to show that it was partial and
// how many findings it carried.
// =========================================================================

describe("runReviewPhase — partial JSONL review (kusabi #202)", () => {
  function makeDispatch(results) {
    const calls = [];
    function stubbedDispatch(options) {
      calls.push(options);
      return results.shift();
    }
    return { stubbedDispatch, calls };
  }

  function fakeJob(id, resultText, extra = {}) {
    return {
      job: {
        id, status: "completed", modelEntry: "test-org/test-review-model",
        modelVariant: null, fallbacks: null, usage: null, error: null, ...extra,
      },
      resultText,
    };
  }

  const FINDING_1 = {
    type: "finding", severity: "high", kind: "design", title: "Unbounded retry",
    body: "b", file: "src/a.mjs", line_start: 12, line_end: 18,
    confidence: 0.8, recommendation: "r",
  };
  const FINDING_2 = {
    type: "finding", severity: "low", kind: "mechanical", title: "Stale comment",
    body: "b", file: "src/b.mjs", line_start: 3, line_end: 3,
    confidence: 0.9, recommendation: "r",
  };

  // Two findings emitted, then the stream stops mid-thought.
  const TRUNCATED = [
    "Checklist point 1 — retry semantics:",
    JSON.stringify(FINDING_1),
    "Point 2 — comments:",
    JSON.stringify(FINDING_2),
    "Point 3 — I still need to check the empty-st",
  ].join("\n");

  const COMPLETE = [
    JSON.stringify(FINDING_1),
    JSON.stringify({ type: "verdict", schema_version: 1, verdict: "needs-attention", summary: "One defect." }),
  ].join("\n");

  async function runWith(results, extra = {}) {
    const { stubbedDispatch, calls } = makeDispatch(results);
    const roundRecord = { round: 1 };
    const result = await runReviewPhase({
      container: "test", brief: "test brief",
      modelChain: ["test-org/test-flash", "test-org/test-pro"],
      chainId: "test-chain", cwd: process.cwd(), previousRecord: null,
      baseSha: "abc123", chainStatusOutput: "", chainBaseLog: "",
      chainUntracked: "", roundRecord, chainChangedPaths: [],
      chainStatusObserved: false, chainDeliverables: [], flagsModel: null,
      _dispatchWithFallback: stubbedDispatch, ...extra,
    });
    return { result, roundRecord, calls };
  }

  it("records partial with its finding count and does NOT retry", async () => {
    const { result, roundRecord, calls } = await runWith([
      fakeJob("job-truncated", TRUNCATED),
    ]);

    // The retry (#145) is for output we could not read.  Not this.
    assert.equal(calls.length, 1);
    assert.equal(roundRecord.reviewUnparseableRetried, undefined);
    assert.equal(roundRecord.reviewFirstJobId, undefined);

    assert.equal(roundRecord.verdict, "partial");
    assert.equal(roundRecord.reviewParseable, true);
    assert.equal(roundRecord.reviewPartial, true);
    assert.equal(roundRecord.reviewFindingCount, 2);
    // Not a token recovery — the stream was genuinely parsed.
    assert.equal(roundRecord.verdictSource, undefined);

    // The findings survive and are recorded/rendered like any others.
    assert.equal(roundRecord.findings.length, 2);
    assert.deepEqual(
      roundRecord.findings.map(function (f) { return f.title; }),
      ["Unbounded retry", "Stale comment"],
    );
    assert.deepEqual(roundRecord.findingFiles, ["src/a.mjs", "src/b.mjs"]);
    assert.ok(roundRecord.findingsText.includes("[high] Unbounded retry (src/a.mjs:12)"));
    assert.ok(roundRecord.findingsText.includes("[low] Stale comment (src/b.mjs:3)"));
    assert.equal(result.chainParsedReview.verdict, "partial");
    assert.equal(result.skipReview, false);
  });

  // What the chain then DOES with verdict "partial" (escalate, never accept)
  // is deriveDisposition's decision and is asserted in disposition.test.mjs.

  it("a complete JSONL stream records its verdict and is not marked partial", async () => {
    const { roundRecord, calls } = await runWith([
      fakeJob("job-complete", COMPLETE),
    ]);

    assert.equal(calls.length, 1);
    assert.equal(roundRecord.verdict, "needs-attention");
    assert.equal(roundRecord.reviewParseable, true);
    assert.equal(roundRecord.reviewPartial, undefined);
    assert.equal(roundRecord.reviewFindingCount, undefined);
    assert.equal(roundRecord.findings.length, 1);
  });

  it("a garbage first attempt that retries into a partial stream stays partial", async () => {
    const { roundRecord, calls } = await runWith([
      fakeJob("job-garbage", "definitely not JSON and no VERDICT token here"),
      fakeJob("job-truncated", TRUNCATED),
    ]);

    // The first attempt was unreadable, so the retry fires as before; the
    // second attempt is readable but incomplete, so the round is partial.
    assert.equal(calls.length, 2);
    assert.equal(roundRecord.reviewUnparseableRetried, true);
    assert.equal(roundRecord.reviewFirstJobId, "job-garbage");
    assert.equal(roundRecord.reviewJobId, "job-truncated");
    assert.equal(roundRecord.verdict, "partial");
    assert.equal(roundRecord.reviewPartial, true);
    assert.equal(roundRecord.reviewFindingCount, 2);
  });

  it("populates reviewPartialDiagnosis on roundRecord for partial stream with diagnosis (kusabi #312)", async () => {
    const { roundRecord } = await runWith([
      fakeJob("job-truncated", TRUNCATED),
    ]);

    assert.equal(roundRecord.verdict, "partial");
    assert.equal(roundRecord.reviewPartial, true);
    assert.equal(
      roundRecord.reviewPartialDiagnosis,
      "format: records present but no verdict record arrived",
    );
    assert.equal(roundRecord.salvagedVerdict, undefined);
  });

  it("populates salvagedVerdict on roundRecord for salvaged verdict stream (kusabi #312)", async () => {
    const SALVAGED_STREAM = [
      JSON.stringify(FINDING_1),
      '{"type":"verdict","verdict":"approve","summary":"Ship. ' + "x".repeat(100),
    ].join("\n");

    const { roundRecord } = await runWith([
      fakeJob("job-salvaged", SALVAGED_STREAM),
    ]);

    assert.equal(roundRecord.verdict, "approve");
    assert.equal(roundRecord.salvagedVerdict, true);
    assert.equal(roundRecord.reviewPartial, undefined);
    assert.equal(roundRecord.reviewPartialDiagnosis, undefined);
  });
});

// ---------------------------------------------------------------------------
// chain review prompt — byte-identity guard (kusabi #204, re-recorded for #208)
// ---------------------------------------------------------------------------
// The container review input moved out of runReviewPhase into
// renderContainerReviewInput so `task --phase review --container` can send the
// same block.  The chain is the REFERENCE path: whatever else changes, what it
// sends must not drift unnoticed.  GOLDEN_CHAIN_REVIEW_INPUT below is a
// recording of the whole block, not a description of it.
//
// It was re-recorded for kusabi #208, which removed the inlined diff body: the
// `Diff content:` fenced block is gone and the instruction naming the base and
// the tool stands in its place.  Everything else is unchanged from the #204
// recording, so the two can be read against each other as a diff.

const GOLDEN_CHAIN_REVIEW_INPUT = [
  "## Review target",
  "",
  "The artifact under review lives inside container `cafe1234beef`.",
  "You may use the following Sunaba read/verify tools to inspect it:",
  "- `read_file_range` - read file contents from the container",
  "- `search_in_container` - grep/search within the container",
  "- `diff_in_container` - fetch the diff itself; it is NOT inlined below",
  "- `verify_in_container` / `lint_in_container` / `type_check_in_container` - re-run the project's gates in the container",
  "",
  "Do NOT rely on host cwd git state; the actual changes are in the container.",
  "",
  "### Base change-set context (machine-recorded)",
  "",
  "- Base commit: `0123456789abcdef`",
  "",
  "Recent base history (top 5):",
  "```",
  "abc1234 first",
  "def5678 second",
  "",
  "```",
  "",
  "Actual change set (`git status --porcelain`):",
  "```",
  " M src/foo.js",
  "?? src/new.js",
  "",
  "```",
  "",
  "**The diff itself is NOT included in this input.** The change set above names WHICH files changed, not WHAT changed inside them -- do not review the file list as if it were the change.",
  "",
  "Fetching the diff is YOUR job: call `diff_in_container` with `base` set to `0123456789abcdef` (that covers committed AND uncommitted work since that commit), and page through it with `offset` / `limit` until `has_more` is false.",
  "",
  "New (untracked) files:",
  "- `src/new.js`",
  "",
  "Use `read_file_range` to inspect these new files.",
  "",
  "Review ONLY this change set. Code that is already part of the base (see the log above) is NOT scope creep and must not be flagged as such.",
].join("\n");

describe("chain review prompt byte-identity", () => {
  async function capturePrompt() {
    let captured = null;
    function stubbedDispatch(opts) {
      captured = opts.promptText;
      return {
        job: { id: "review-golden", status: "completed", modelEntry: "m", modelVariant: null, fallbacks: null, usage: null, error: null },
        resultText: JSON.stringify({ schema_version: 1, verdict: "approve", summary: "ok", findings: [], next_steps: [] }),
      };
    }
    await runReviewPhase({
      container: "cafe1234beef",
      brief: "GOLDEN BRIEF TEXT",
      modelChain: ["test-org/test-flash"],
      chainId: "chain-golden",
      cwd: process.cwd(),
      previousRecord: null,
      baseSha: "0123456789abcdef",
      chainStatusOutput: " M src/foo.js\n?? src/new.js\n",
      chainBaseLog: "abc1234 first\ndef5678 second\n",
      chainUntracked: "src/new.js\n",
      roundRecord: { round: 2 },
      chainChangedPaths: ["src/foo.js"],
      chainStatusObserved: true,
      chainDeliverables: ["src/foo.js"],
      flagsModel: null,
      _dispatchWithFallback: stubbedDispatch,
    });
    return captured;
  }

  it("sends the exact recorded review-input block", async () => {
    const prompt = await capturePrompt();
    assert.ok(prompt.includes(GOLDEN_CHAIN_REVIEW_INPUT), "chain review input drifted from the captured golden");
  });

  it("sends no diff body, and names the base and the tool instead", async () => {
    // Stated separately from the golden so the reason the recording changed is
    // pinned by its own assertion rather than by a wall of text.
    const prompt = await capturePrompt();
    const input = prompt.slice(prompt.indexOf("## Review target"));
    assert.ok(!input.includes("diff --git"), "the diff body must not be inlined");
    assert.ok(!input.includes("```diff"));
    assert.ok(input.includes("Fetching the diff is YOUR job"));
    assert.ok(input.includes("`base` set to `0123456789abcdef`"));
  });

  it("renders the same block as the task route for the same container facts", async () => {
    // Both container routes must render from the one implementation; the
    // proof is that the same facts produce the same bytes on both.
    const prompt = await capturePrompt();
    const taskInput = await collectContainerReviewInput({
      container: "cafe1234beef",
      callTool: async (tool, params) => {
        const cmd = params.commands?.[0] ?? "";
        if (cmd === "git rev-parse HEAD") return { output: "0123456789abcdef\n" };
        if (cmd === "git status --porcelain") return { output: " M src/foo.js\n?? src/new.js\n" };
        if (cmd === "git log --oneline -5") return { output: "abc1234 first\ndef5678 second\n" };
        if (cmd === "git ls-files --others --exclude-standard") return { output: "src/new.js\n" };
        return { output: "" };
      },
      changeScope: false,
    });
    assert.equal(taskInput, GOLDEN_CHAIN_REVIEW_INPUT);
    assert.ok(prompt.includes(taskInput));
  });

  it("sends a prompt that is byte-identical end to end for fixed inputs", async () => {
    const prompt = await capturePrompt();
    const template = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "adversarial-review.md"), "utf8");
    const schemaJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8"));
    const expected = template
      .replaceAll("{{TARGET_LABEL}}", "container cafe1234beef changes")
      .replaceAll("{{USER_FOCUS}}", "GOLDEN BRIEF TEXT")
      .replaceAll("{{OUTPUT_SCHEMA}}", JSON.stringify(schemaJson))
      .replaceAll("{{REVIEW_INPUT}}", GOLDEN_CHAIN_REVIEW_INPUT)
      .replaceAll("{{PRIOR_FINDINGS}}", "(none -- first review round)")
      // kusabi #236: the golden round records no probes, so the slot renders
      // the explicit absence marker — the same bytes the chain produces for
      // a round without recorded probe results.
      .replaceAll("{{PROBE_REPORT}}", "(no probe results recorded)");
    assert.equal(prompt, expected);
  });
});

// ---------------------------------------------------------------------------
// runReviewPhase — {{PROBE_REPORT}} slot (kusabi #236)
//
// The round's deterministic probe results (P1–P4) render into the review
// prompt so the reviewer does not re-litigate what the probes already
// measured.  Fixture-pinned both ways: a round with recorded probes carries
// all four probe lines, a round without carries the explicit absence marker.
// ---------------------------------------------------------------------------

describe("runReviewPhase — {{PROBE_REPORT}} slot (kusabi #236)", () => {
  // The same four-probe fixture the seat-replacement tests use (kusabi #248).
  const GREEN_PROBES = [
    { probe: "P1: HEAD clean", passed: true, detail: "HEAD matches base abc123" },
    { probe: "P2: verify gate", passed: true, detail: JSON.stringify({ gate_passed: true }) },
    { probe: "P3: deliverables", passed: true, detail: "touches declared deliverables" },
    { probe: "P4: smoke", passed: true, detail: "all smoke entries exited 0" },
  ];

  async function capturePrompt(roundRecord) {
    let captured = null;
    function stubbedDispatch(opts) {
      captured = opts.promptText;
      return {
        job: { id: "job-probes", status: "completed", modelEntry: "m", modelVariant: null, fallbacks: null, usage: null, error: null },
        resultText: JSON.stringify({ schema_version: 1, verdict: "approve", summary: "ok", findings: [], next_steps: [] }),
      };
    }
    await runReviewPhase({
      container: "cafe1234beef",
      brief: "GOLDEN BRIEF TEXT",
      modelChain: ["test-org/test-flash"],
      chainId: "chain-probes",
      cwd: process.cwd(),
      previousRecord: null,
      baseSha: "0123456789abcdef",
      chainStatusOutput: " M src/foo.js\n",
      chainBaseLog: "abc1234 first\n",
      chainUntracked: "",
      roundRecord,
      chainChangedPaths: ["src/foo.js"],
      chainStatusObserved: true,
      chainDeliverables: ["src/foo.js"],
      flagsModel: null,
      _dispatchWithFallback: stubbedDispatch,
    });
    return captured;
  }

  it("carries all four probe lines when the round recorded probe results", async () => {
    const prompt = await capturePrompt({ round: 1, probeResults: GREEN_PROBES });
    const probeBlock = prompt.slice(prompt.indexOf("<probe_results>"), prompt.indexOf("</probe_results>"));
    for (const line of [
      "- P1: HEAD clean — passed — HEAD matches base abc123",
      "- P2: verify gate — passed — {\"gate_passed\":true}",
      "- P3: deliverables — passed — touches declared deliverables",
      "- P4: smoke — passed — all smoke entries exited 0",
    ]) {
      assert.ok(probeBlock.includes(line), "missing probe line: " + line);
    }
  });

  it("carries the explicit absence marker when no probes were recorded", async () => {
    const prompt = await capturePrompt({ round: 2 });
    assert.ok(prompt.includes("(no probe results recorded)"));
  });

  it("carries the explicit absence marker for an empty probe array", async () => {
    const prompt = await capturePrompt({ round: 3, probeResults: [] });
    assert.ok(prompt.includes("(no probe results recorded)"));
  });

  it("renders a red probe as failed context rather than hiding it", async () => {
    const prompt = await capturePrompt({
      round: 4,
      probeResults: [
        { probe: "P1: HEAD clean", passed: true, detail: "HEAD matches base abc123" },
        { probe: "P2: verify gate", passed: false, detail: "lint: 2 violations" },
        { probe: "P3: deliverables", passed: true, detail: "touches declared deliverables" },
        { probe: "P4: smoke", passed: true, detail: "all smoke entries exited 0" },
      ],
    });
    const probeBlock = prompt.slice(prompt.indexOf("<probe_results>"), prompt.indexOf("</probe_results>"));
    assert.ok(probeBlock.includes("- P2: verify gate — failed — lint: 2 violations"));
  });

  it("renderProbeReport renders the explicit absence marker for a missing or empty set", () => {
    assert.equal(renderProbeReport(undefined), "(no probe results recorded)");
    assert.equal(renderProbeReport(null), "(no probe results recorded)");
    assert.equal(renderProbeReport([]), "(no probe results recorded)");
  });

  it("template carries the probe interpretation text and the authoritative-source mandate", () => {
    const template = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "adversarial-review.md"), "utf8");
    assert.ok(template.includes("{{PROBE_REPORT}}"));
    assert.ok(template.includes("Do not spend findings re-litigating what the probes already"));
    assert.ok(template.includes("missing probe is context for your verdict"));
    assert.ok(template.includes("<authoritative_sources>"));
    assert.ok(template.includes("name the source in the finding body"));
    // The discard/verdict contract (#235's metrics reading) must be unchanged.
    assert.ok(template.includes("Use `discard` when the change premise itself is wrong"));
  });
});

// ---------------------------------------------------------------------------
// runReviewPhase — scope-aware prior findings (kusabi #334)
// ---------------------------------------------------------------------------

describe("runReviewPhase — scope-aware prior findings (kusabi #334)", () => {
  const designFinding = {
    severity: "high", title: "API shape decision", file: "src/a.js", line_start: 1,
    kind: "design", body: "needs a decision", recommendation: "decide",
  };
  const mechFinding = {
    severity: "medium", title: "Rename variable", file: "src/b.js", line_start: 10,
    kind: "mechanical", body: "bad name", recommendation: "rename it",
  };

  async function capturePromptWith(previousRecord, reworkScope, reviewFindings = []) {
    let captured = null;
    const fullFindings = reviewFindings.map((f) => ({
      severity: "medium",
      title: "finding",
      body: "body",
      line_start: 1,
      line_end: 1,
      confidence: 0.8,
      recommendation: "rec",
      ...f,
    }));
    function stubbedDispatch(opts) {
      captured = opts.promptText;
      return {
        job: { id: "job-scope", status: "completed", modelEntry: "m", modelVariant: null, fallbacks: null, usage: null, error: null },
        resultText: JSON.stringify({ schema_version: 1, verdict: "approve", summary: "ok", findings: fullFindings, next_steps: [] }),
      };
    }
    const roundRecord = { round: 2 };
    const result = await runReviewPhase({
      container: "cafe1234beef",
      brief: "BRIEF",
      modelChain: ["test-org/test-flash"],
      chainId: "chain-scope",
      cwd: process.cwd(),
      previousRecord,
      reworkScope,
      baseSha: "0123456789abcdef",
      chainStatusOutput: " M src/foo.js\n",
      chainBaseLog: "abc1234 first\n",
      chainUntracked: "",
      roundRecord,
      chainChangedPaths: ["src/foo.js"],
      chainNewlyChanged: ["src/foo.js"],
      chainStatusObserved: true,
      chainDeliverables: ["src/foo.js"],
      flagsModel: null,
      _dispatchWithFallback: stubbedDispatch,
    });
    return { prompt: captured, result };
  }

  it("full-scope rework round keeps the prior-findings prompt text byte-identical", async () => {
    // A full-scope rework is a probe-failure rework or an old record: no
    // structured findings, so resolveReworkScope returns full.
    const prev = {
      findingsText: "[high] API shape decision (src/a.js:1)\n[medium] Rename variable (src/b.js:10)",
      findings: [],
      findingFiles: ["src/a.js", "src/b.js"],
    };
    const scope = resolveReworkScope(prev);
    assert.equal(scope.scope, "full");
    const withScope = await capturePromptWith(prev, scope);
    const without = await capturePromptWith(prev, undefined);
    assert.equal(withScope.prompt, without.prompt);
    // The slot renders the previous round's findingsText verbatim, exactly
    // as the pre-scoping code did — no scope partition on a full round.
    assert.ok(withScope.prompt.includes("Prior findings from an earlier review round: " + prev.findingsText));
    assert.ok(!withScope.prompt.includes("This round was scoped to"));
  });

  it("mechanical-scoped round names the in-scope findings and marks the rest held", async () => {
    const prev = {
      findingsText: "[high] API shape decision (src/a.js:1)\n[medium] Rename variable (src/b.js:10)",
      findings: [designFinding, mechFinding],
      findingFiles: ["src/a.js", "src/b.js"],
    };
    const scope = resolveReworkScope(prev);
    assert.equal(scope.scope, "mechanical");
    const { prompt } = await capturePromptWith(prev, scope);
    const slot = prompt.slice(prompt.indexOf("This round was scoped"));
    // The scope is stated, and the in-scope finding gets the FULL per-finding
    // rendering (heading with severity/location, body, recommendation) —
    // same treatment the implement prompt gives its scoped subset.
    assert.ok(slot.includes("This round was scoped to mechanical findings"));
    assert.ok(slot.includes("### [medium] Rename variable (src/b.js:10)"));
    assert.ok(slot.includes("bad name"));
    assert.ok(slot.includes("**Recommendation:** rename it"));
    // The held finding is NAMED as held, still open, and not a failure of
    // the round — and the reviewer is told to re-report it, not drop it.
    assert.ok(slot.includes("DELIBERATELY HELD OUT"));
    assert.ok(slot.includes("[high] API shape decision (src/a.js:1)"));
    assert.ok(slot.includes("still open"));
    assert.ok(slot.includes("never as work this round failed to do"));
    assert.ok(slot.includes("Re-report each one"));
    // The held finding's body stays out of the prompt (one-line rows only).
    assert.ok(!slot.includes("needs a decision"));
  });

  it("design-scoped round names the single design finding and holds the rest", async () => {
    // All-design set: the round is design-scoped to the FIRST design finding
    // in array order; the remaining design findings are held.
    const secondDesign = { ...designFinding, title: "Second design", file: "src/c.js", body: "second body" };
    const prev = {
      findings: [designFinding, secondDesign],
      findingFiles: ["src/a.js", "src/c.js"],
    };
    const scope = resolveReworkScope(prev);
    assert.equal(scope.scope, "design");
    const { prompt } = await capturePromptWith(prev, scope);
    const slot = prompt.slice(prompt.indexOf("This round was scoped"));
    assert.ok(slot.includes("This round was scoped to design findings"));
    assert.ok(slot.includes("### [high] API shape decision (src/a.js:1)"));
    // The held finding is named as held; its body is not rendered.
    assert.ok(slot.includes("[high] Second design (src/c.js:1)"));
    assert.ok(!slot.includes("second body"));
  });

  it("repeatedAreas ignores held files and fires on in-scope files", async () => {
    const prev = {
      findings: [designFinding, mechFinding],
      findingFiles: ["src/a.js", "src/b.js"],
    };
    const scope = resolveReworkScope(prev);
    assert.equal(scope.scope, "mechanical");
    // The current round repeats ONLY the held design file: not a stall.
    const heldOnly = await capturePromptWith(prev, scope, [
      { file: "src/a.js", severity: "high", title: "still there", line_start: 1 },
    ]);
    assert.equal(heldOnly.result.chainRepeatedAreas, false);
    // The current round repeats the IN-SCOPE mechanical file: a stall.
    const inScope = await capturePromptWith(prev, scope, [
      { file: "src/b.js", severity: "medium", title: "still there", line_start: 10 },
    ]);
    assert.equal(inScope.result.chainRepeatedAreas, true);
  });

  it("full-scope rounds keep today's repeatedAreas behaviour (any prior file counts)", async () => {
    // A probe-failure rework resolves to full scope; every prior file was in
    // scope, so a repeat of ANY of them still fires the detector.
    const prev = {
      findings: [],
      findingsText: "[high] API shape decision (src/a.js:1)",
      findingFiles: ["src/a.js"],
    };
    const scope = resolveReworkScope(prev);
    assert.equal(scope.scope, "full");
    const result = await capturePromptWith(prev, scope, [
      { file: "src/a.js", severity: "high", title: "still there", line_start: 1 },
    ]);
    assert.equal(result.result.chainRepeatedAreas, true);
  });

  it("old record without scope information reviews with today's behaviour and throws nothing", async () => {
    // No structured findings, no findingFiles, no reworkScope — a record
    // written before scoped reworks existed.
    const prev = { findingsText: "[high] legacy issue (src/legacy.js:1)" };
    const { prompt, result } = await capturePromptWith(prev, undefined, [
      { file: "src/legacy.js", severity: "high", title: "still there", line_start: 1 },
    ]);
    assert.ok(prompt.includes("Prior findings from an earlier review round: [high] legacy issue (src/legacy.js:1)"));
    assert.equal(result.chainRepeatedAreas, false);
  });

  // Seam-level, deliberately: the driver's review-resume path passes an
  // explicitly re-derived resolveReworkScope(resumePreviousRecord), so what
  // this pins is the OTHER guarantee — that omitting the carried value
  // reaches the identical prompt.  The driver line itself is not exercised
  // here (kusabi #334 review, [low]).
  it("the seam's fallback derives the same scope-aware prompt as a carried resolution", async () => {
    const prev = {
      findings: [designFinding, mechFinding],
      findingFiles: ["src/a.js", "src/b.js"],
    };
    // Fresh path: the driver carries its scopeResolution into the seam.
    const fresh = await capturePromptWith(prev, resolveReworkScope(prev));
    // Review-resume path: no fresh-round block, so the seam re-invokes the
    // SAME decision point on the SAME previous record.  The two prompts must
    // be byte-identical — and must actually be the scoped partition, so the
    // equivalence is not trivially "both full".
    const resumed = await capturePromptWith(prev, undefined);
    assert.equal(resumed.prompt, fresh.prompt);
    assert.ok(fresh.prompt.includes("This round was scoped to mechanical findings"));
    assert.ok(fresh.prompt.includes("DELIBERATELY HELD OUT"));
  });

  it("renderReviewPriorFindings: full scope renders today's slot text verbatim", () => {
    const prev = { findingsText: "TEXT", findings: [designFinding, mechFinding] };
    assert.equal(renderReviewPriorFindings(prev, undefined), "TEXT");
    assert.equal(renderReviewPriorFindings(prev, { scope: "full", findings: [] }), "TEXT");
    assert.equal(renderReviewPriorFindings(prev, null), "TEXT");
    assert.equal(renderReviewPriorFindings(null, undefined), "(none -- first review round)");
    assert.equal(renderReviewPriorFindings(undefined, undefined), "(none -- first review round)");
  });

  it("renderReviewPriorFindings: a scoped round with nothing held says so", () => {
    // All-mechanical set: the round is mechanical-scoped and every finding
    // is in scope — the held list must render an explicit "nothing held"
    // marker, never a throw.
    const prev = { findings: [mechFinding], findingFiles: ["src/b.js"] };
    const scope = resolveReworkScope(prev);
    assert.equal(scope.scope, "mechanical");
    const slot = renderReviewPriorFindings(prev, scope);
    assert.ok(slot.includes("This round was scoped to mechanical findings"));
    assert.ok(slot.includes("No prior findings were held out of this round's scope"));
  });

  it("inScopeFindingFiles narrows to the in-scope files only", () => {
    const prev = {
      findings: [designFinding, mechFinding],
      findingFiles: ["src/a.js", "src/b.js"],
    };
    const scope = resolveReworkScope(prev);
    assert.equal(scope.scope, "mechanical");
    assert.deepEqual(inScopeFindingFiles(prev, scope), ["src/b.js"]);
    // Full scope passes the stored findingFiles through unchanged (today's
    // exact input to hasRepeatedAreas).
    assert.deepEqual(inScopeFindingFiles(prev, undefined), ["src/a.js", "src/b.js"]);
    // Old record without findingFiles: full scope degrades to undefined.
    assert.equal(inScopeFindingFiles({ findingsText: "x" }, undefined), undefined);
  });
});

// =========================================================================
// schema-invalid review repair loop (kusabi #395)
// =========================================================================

describe("buildReviewRepairPrompt (kusabi #395)", () => {
  it("formats schema validation errors as JSON without original output when hasSession is true", () => {
    const schemaErrors = [
      { path: "/schema_version", expected: "const: 1", actual: "undefined" },
      { path: "/summary", expected: "type: string", actual: "undefined" },
    ];
    const prompt = buildReviewRepairPrompt({ schemaErrors, originalOutput: "raw output", hasSession: true });
    assert.ok(prompt.includes("Schema validation errors:"));
    assert.ok(prompt.includes('"/schema_version"'));
    assert.ok(prompt.includes('"const: 1"'));
    assert.ok(prompt.includes("Please emit ONE corrected JSON object"));
    assert.ok(!prompt.includes("raw output"), "must not include original output when hasSession is true");
  });

  it("includes truncated original output when hasSession is false", () => {
    const schemaErrors = [
      { path: "/findings", expected: "type: array", actual: "null" },
    ];
    const prompt = buildReviewRepairPrompt({
      schemaErrors,
      originalOutput: "previous malformed json",
      hasSession: false,
    });
    assert.ok(prompt.includes("Schema validation errors:"));
    assert.ok(prompt.includes("Previous review output:"));
    assert.ok(prompt.includes("previous malformed json"));
  });

  it("truncates original output exceeding 4000 characters when hasSession is false", () => {
    const longOutput = "a".repeat(5000);
    const prompt = buildReviewRepairPrompt({
      schemaErrors: [],
      originalOutput: longOutput,
      hasSession: false,
    });
    assert.ok(prompt.includes("...(truncated)"));
    assert.ok(!prompt.includes("a".repeat(5000)));
  });

  it("formats prompt with real linefeeds around markdown fences instead of escaped backslash-n", () => {
    const schemaErrors = [
      { path: "/schema_version", expected: "const: 1", actual: "undefined" },
    ];
    const prompt = buildReviewRepairPrompt({ schemaErrors, originalOutput: "raw output", hasSession: true });
    assert.ok(prompt.includes("\n```json\n"), "must include real newlines around ```json fence");
    assert.ok(!prompt.includes("\\n```json"), "must not include literal \\n before ```json fence");
    assert.ok(!prompt.includes("\\n"), "must not contain literal backslash-n sequences");

    const promptNoSession = buildReviewRepairPrompt({
      schemaErrors,
      originalOutput: "raw output",
      hasSession: false,
    });
    assert.ok(promptNoSession.includes("\n```\n"), "must include real newlines around markdown fence");
    assert.ok(!promptNoSession.includes("\\n```"), "must not include literal \\n before ``` fence");
    assert.ok(!promptNoSession.includes("\\n"), "must not contain literal backslash-n sequences");
  });
});

describe("runReviewPhase — schema-invalid repair loop (kusabi #395)", () => {
  function makeDispatch(results) {
    const calls = [];
    function stubbedDispatch(options) {
      calls.push(options);
      return results.shift();
    }
    return { stubbedDispatch, calls };
  }

  function fakeJob(id, resultText, extra = {}) {
    return {
      job: {
        id,
        status: "completed",
        sessionID: "session-" + id,
        modelEntry: "test-org/test-review-model",
        modelVariant: null,
        fallbacks: null,
        usage: null,
        error: null,
        ...extra,
      },
      resultText,
    };
  }

  const SCHEMA_INVALID_MISSING_VERSION = JSON.stringify({
    verdict: "needs-attention",
    summary: "One defect found.",
    findings: [
      { severity: "medium", title: "Off-by-one", body: "b", file: "src/calc.js", line_start: 7, line_end: 7, confidence: 0.8, recommendation: "r" },
    ],
    next_steps: [],
  });

  const SCHEMA_INVALID_EXTRA_KEY = JSON.stringify({
    schema_version: 1,
    unrecognized_key: "forbidden",
    verdict: "needs-attention",
    summary: "Has extra field.",
    findings: [],
    next_steps: [],
  });

  const VALID_REVIEW = JSON.stringify({
    schema_version: 1,
    verdict: "needs-attention",
    summary: "One real finding.",
    findings: [
      { severity: "medium", title: "Off-by-one", body: "b", file: "src/calc.js", line_start: 7, line_end: 7, confidence: 0.8, recommendation: "r" },
    ],
    next_steps: [],
  });

  const GARBAGE = "definitely not JSON and no VERDICT token here at all";

  async function runWith(results, extra = {}, customStateDir = null) {
    const { stubbedDispatch, calls } = makeDispatch(results);
    const roundRecord = { round: 1 };
    const tempDir = customStateDir || fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-repair-test-"));
    const result = await runReviewPhase({
      container: "test",
      brief: "test brief",
      modelChain: ["test-org/test-flash", "test-org/test-pro"],
      chainId: "test-chain",
      cwd: tempDir,
      previousRecord: null,
      baseSha: "abc123",
      chainStatusOutput: "",
      chainBaseLog: "",
      chainUntracked: "",
      roundRecord,
      chainChangedPaths: [],
      chainStatusObserved: false,
      chainDeliverables: [],
      flagsModel: null,
      _dispatchWithFallback: stubbedDispatch,
      ...extra,
    });
    return { result, roundRecord, calls, tempDir };
  }

  it("schema-invalid first result with sessionID: repairs in same session, parses corrected output", async () => {
    const { roundRecord, calls, tempDir } = await runWith([
      fakeJob("job-inv-1", SCHEMA_INVALID_MISSING_VERSION, {
        sessionID: "sess-123",
        usage: { available: true, input: 10, output: 5, cost: 0.01 },
        fallbacks: ["fallback-1"],
      }),
      fakeJob("job-rep-2", VALID_REVIEW, {
        sessionID: "sess-123",
        usage: { available: true, input: 15, output: 8, cost: 0.02 },
        modelEntry: "test-org/test-fixed-model",
      }),
    ]);

    assert.equal(calls.length, 2);
    // First call: initial review prompt, no session
    assert.equal(calls[0].session, undefined);
    assert.ok(calls[0].promptText.includes("test brief"));

    // Second call: repair prompt with same session
    assert.equal(calls[1].session, "sess-123");
    assert.ok(calls[1].promptText.includes("Schema validation errors:"));
    assert.ok(calls[1].promptText.includes("/schema_version"));
    assert.ok(!calls[1].promptText.includes("test brief"), "repair prompt should be short without full brief");

    // roundRecord fields
    assert.equal(roundRecord.reviewSchemaRepaired, true);
    assert.equal(roundRecord.reviewFirstJobId, "job-inv-1");
    assert.deepEqual(roundRecord.reviewFirstUsage, { available: true, input: 10, output: 5, cost: 0.01 });
    assert.deepEqual(roundRecord.reviewFirstFallbacks, ["fallback-1"]);
    assert.equal(roundRecord.reviewJobId, "job-rep-2");
    assert.equal(roundRecord.verdict, "needs-attention");
    assert.equal(roundRecord.reviewParseable, true);
    assert.ok(roundRecord.findingsText.includes("Off-by-one"));

    // Totals include both attempts
    const totals = computeChainTotals([roundRecord]);
    assert.equal(totals.input, 25);
    assert.equal(totals.output, 13);
    assert.equal(totals.cost, 0.03);

    // Events written
    const eventsFile = path.join(tempDir, ".kusabi", "jobs", "job-inv-1", "events.ndjson");
    if (fs.existsSync(eventsFile)) {
      const lines = fs.readFileSync(eventsFile, "utf8").trim().split("\n").map(JSON.parse);
      assert.ok(lines.some((e) => e.type === "companion.review.schema_invalid"));
      assert.ok(lines.some((e) => e.type === "companion.review.schema_repair" && e.attempt === 1));
    }
  });

  it("schema-invalid first result without sessionID: dispatches fresh repair with truncated output", async () => {
    const { roundRecord, calls } = await runWith([
      fakeJob("job-nosess-1", SCHEMA_INVALID_EXTRA_KEY, { sessionID: null }),
      fakeJob("job-rep-2", VALID_REVIEW),
    ]);

    assert.equal(calls.length, 2);
    assert.equal(calls[1].session, undefined);
    assert.ok(calls[1].promptText.includes("Schema validation errors:"));
    assert.ok(calls[1].promptText.includes("Previous review output:"));
    assert.ok(calls[1].promptText.includes("unrecognized_key"));

    assert.equal(roundRecord.reviewSchemaRepaired, true);
    assert.equal(roundRecord.reviewJobId, "job-rep-2");
    assert.equal(roundRecord.verdict, "needs-attention");
    assert.equal(roundRecord.reviewParseable, true);
  });

  it("schema-invalid then still schema-invalid: exactly 2 dispatches, verdict unparseable, no double retry", async () => {
    const { roundRecord, calls } = await runWith([
      fakeJob("job-inv-1", SCHEMA_INVALID_MISSING_VERSION),
      fakeJob("job-inv-2", SCHEMA_INVALID_EXTRA_KEY),
    ]);

    assert.equal(calls.length, 2);
    assert.equal(roundRecord.reviewSchemaRepaired, true);
    assert.equal(roundRecord.reviewFirstJobId, "job-inv-1");
    assert.equal(roundRecord.reviewJobId, "job-inv-2");
    assert.equal(roundRecord.verdict, "unparseable");
    assert.equal(roundRecord.reviewParseable, false);
    assert.equal(roundRecord.findingsText, "(review output could not be parsed)");
  });

  it("schema-invalid then unparseable garbage: exactly 2 dispatches, verdict unparseable", async () => {
    const { roundRecord, calls } = await runWith([
      fakeJob("job-inv-1", SCHEMA_INVALID_MISSING_VERSION),
      fakeJob("job-garbage-2", GARBAGE),
    ]);

    assert.equal(calls.length, 2);
    assert.equal(roundRecord.reviewSchemaRepaired, true);
    assert.equal(roundRecord.reviewJobId, "job-garbage-2");
    assert.equal(roundRecord.verdict, "unparseable");
    assert.equal(roundRecord.reviewParseable, false);
  });

  it("garbage with empty schemaErrors still gets identical-prompt retry (issue #145)", async () => {
    const { roundRecord, calls } = await runWith([
      fakeJob("job-g1", GARBAGE),
      fakeJob("job-ok", VALID_REVIEW),
    ]);

    assert.equal(calls.length, 2);
    assert.equal(roundRecord.reviewUnparseableRetried, true);
    assert.equal(roundRecord.reviewSchemaRepaired, undefined);
    assert.deepEqual(calls[0].promptText, calls[1].promptText);
    assert.equal(roundRecord.verdict, "needs-attention");
    assert.equal(roundRecord.reviewParseable, true);
  });

  it("hard failure with schema-invalid text: exactly 1 dispatch call, no repair", async () => {
    const { roundRecord, calls } = await runWith([
      fakeJob("job-timeout", SCHEMA_INVALID_MISSING_VERSION, { status: "timeout" }),
    ]);

    assert.equal(calls.length, 1);
    assert.equal(roundRecord.reviewSchemaRepaired, undefined);
    assert.equal(roundRecord.verdict, "unparseable");
  });
});

// =========================================================================
// Source guards for kusabi #435
// =========================================================================

describe("chain-review source guards (kusabi #435)", () => {
  it("chain-phases.mjs does not export moved review functions", () => {
    const chainPhasesSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-phases.mjs"), "utf8");
    assert.ok(!chainPhasesSrc.includes("export async function runReviewPhase("));
    assert.ok(!chainPhasesSrc.includes("export function parseReviewResult("));
    assert.ok(!chainPhasesSrc.includes("export function buildReviewRepairPrompt("));
    assert.ok(!chainPhasesSrc.includes("export function shouldSkipReview("));
    assert.ok(!chainPhasesSrc.includes("export function renderProbeReport("));
    assert.ok(!chainPhasesSrc.includes("export function renderReviewPriorFindings("));
  });

  it("chain-phases.mjs does not import chain-review.mjs", () => {
    const chainPhasesSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "chain-phases.mjs"), "utf8");
    assert.ok(!chainPhasesSrc.includes('from "./chain-review.mjs"'));
    assert.ok(!chainPhasesSrc.includes("from './chain-review.mjs'"));
  });
});
