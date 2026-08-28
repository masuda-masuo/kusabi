import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateReview, validateSchema } from "./review-validate.mjs";

const VALID_FINDING = {
  severity: "high",
  kind: "design",
  title: "Validation defect",
  body: "The validator does not check additionalProperties.",
  file: "plugins/kusabi/scripts/review-validate.mjs",
  line_start: 10,
  line_end: 20,
  confidence: 0.9,
  recommendation: "Enforce additionalProperties: false.",
};

const VALID_REVIEW = {
  schema_version: 1,
  verdict: "needs-attention",
  summary: "Found one design issue.",
  findings: [VALID_FINDING],
  next_steps: ["fix schema validation"],
  unverified: ["timeout handling"],
};

describe("validateReview — valid payloads", () => {
  it("validates a complete valid review object", () => {
    const result = validateReview(VALID_REVIEW);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it("validates an approve review with empty findings and no optional fields", () => {
    const review = {
      schema_version: 1,
      verdict: "approve",
      summary: "LGTM",
      findings: [],
      next_steps: [],
    };
    const result = validateReview(review);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it("validates a discard review with valid discard_reason", () => {
    for (const reason of ["wrong_premise", "needs_stronger_model"]) {
      const review = {
        schema_version: 1,
        verdict: "discard",
        summary: "Premise is incorrect.",
        discard_reason: reason,
        findings: [],
        next_steps: [],
      };
      const result = validateReview(review);
      assert.equal(result.valid, true, `reason ${reason} should be valid`);
      assert.deepEqual(result.errors, []);
    }
  });

  it("validates finding with optional kind omitted", () => {
    const findingWithoutKind = { ...VALID_FINDING };
    delete findingWithoutKind.kind;
    const review = {
      ...VALID_REVIEW,
      findings: [findingWithoutKind],
    };
    const result = validateReview(review);
    assert.equal(result.valid, true);
  });
});

describe("validateReview — schema_version", () => {
  it("rejects missing schema_version", () => {
    const review = { ...VALID_REVIEW };
    delete review.schema_version;
    const result = validateReview(review);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === "/schema_version"));
  });

  it("rejects schema_version != 1", () => {
    for (const version of [2, 0, -1, "1", 1.5, null, true]) {
      const review = { ...VALID_REVIEW, schema_version: version };
      const result = validateReview(review);
      assert.equal(result.valid, false, `version ${version} should fail`);
      assert.ok(result.errors.some((e) => e.path === "/schema_version"));
    }
  });
});

describe("validateReview — required fields and unknown fields", () => {
  it("rejects missing required top-level fields", () => {
    for (const field of ["verdict", "summary", "findings", "next_steps"]) {
      const review = { ...VALID_REVIEW };
      delete review[field];
      const result = validateReview(review);
      assert.equal(result.valid, false, `missing ${field} should fail`);
      assert.ok(result.errors.some((e) => e.path === `/${field}`));
    }
  });

  it("rejects unknown top-level fields (additionalProperties: false)", () => {
    const review = { ...VALID_REVIEW, unknown_field: "extra", another: 123 };
    const result = validateReview(review);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === "/unknown_field"));
    assert.ok(result.errors.some((e) => e.path === "/another"));
  });

  it("rejects invalid verdict enum", () => {
    const review = { ...VALID_REVIEW, verdict: "looks-good" };
    const result = validateReview(review);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === "/verdict"));
  });

  it("rejects discard verdict without discard_reason (if/then)", () => {
    const review = {
      schema_version: 1,
      verdict: "discard",
      summary: "Discarding change.",
      findings: [],
      next_steps: [],
    };
    const result = validateReview(review);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === "/discard_reason"));
  });

  it("rejects discard verdict with invalid discard_reason enum", () => {
    const review = {
      schema_version: 1,
      verdict: "discard",
      summary: "Discarding change.",
      discard_reason: "not_in_enum",
      findings: [],
      next_steps: [],
    };
    const result = validateReview(review);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === "/discard_reason"));
  });

  it("rejects empty summary string", () => {
    const review = { ...VALID_REVIEW, summary: "" };
    const result = validateReview(review);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === "/summary"));
  });
});

describe("validateReview — findings schema validation", () => {
  it("rejects non-array findings", () => {
    for (const findings of ["not an array", { a: 1 }, 123, null]) {
      const review = { ...VALID_REVIEW, findings };
      const result = validateReview(review);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.path === "/findings"));
    }
  });

  it("rejects missing required finding fields", () => {
    const required = [
      "severity", "title", "body", "file", "line_start", "line_end", "confidence", "recommendation",
    ];
    for (const field of required) {
      const badFinding = { ...VALID_FINDING };
      delete badFinding[field];
      const review = { ...VALID_REVIEW, findings: [badFinding] };
      const result = validateReview(review);
      assert.equal(result.valid, false, `missing finding.${field} should fail`);
      assert.ok(result.errors.some((e) => e.path === `/findings/0/${field}`));
    }
  });

  it("rejects unknown fields on a finding (additionalProperties: false)", () => {
    const badFinding = { ...VALID_FINDING, extra_key: "not allowed" };
    const review = { ...VALID_REVIEW, findings: [badFinding] };
    const result = validateReview(review);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === "/findings/0/extra_key"));
  });

  it("rejects invalid severity enum", () => {
    const badFinding = { ...VALID_FINDING, severity: "blocker" };
    const review = { ...VALID_REVIEW, findings: [badFinding] };
    const result = validateReview(review);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === "/findings/0/severity"));
  });

  it("rejects invalid kind enum", () => {
    const badFinding = { ...VALID_FINDING, kind: "cosmetic" };
    const review = { ...VALID_REVIEW, findings: [badFinding] };
    const result = validateReview(review);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === "/findings/0/kind"));
  });

  it("rejects invalid line_start / line_end (< 1 or non-integer)", () => {
    for (const badVal of [0, -1, 1.5, "1"]) {
      const badFinding = { ...VALID_FINDING, line_start: badVal };
      const review = { ...VALID_REVIEW, findings: [badFinding] };
      const result = validateReview(review);
      assert.equal(result.valid, false, `line_start ${badVal} should fail`);
      assert.ok(result.errors.some((e) => e.path === "/findings/0/line_start"));
    }
  });

  it("rejects invalid confidence (< 0, > 1, or non-number)", () => {
    for (const badVal of [-0.1, 1.1, "0.5", NaN]) {
      const badFinding = { ...VALID_FINDING, confidence: badVal };
      const review = { ...VALID_REVIEW, findings: [badFinding] };
      const result = validateReview(review);
      assert.equal(result.valid, false, `confidence ${badVal} should fail`);
      assert.ok(result.errors.some((e) => e.path === "/findings/0/confidence"));
    }
  });
});

describe("validateReview — next_steps and unverified validation", () => {
  it("rejects non-array next_steps", () => {
    const review = { ...VALID_REVIEW, next_steps: "step 1" };
    const result = validateReview(review);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === "/next_steps"));
  });

  it("rejects empty string in next_steps", () => {
    const review = { ...VALID_REVIEW, next_steps: [""] };
    const result = validateReview(review);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === "/next_steps/0"));
  });

  it("rejects non-string item in unverified", () => {
    const review = { ...VALID_REVIEW, unverified: [123] };
    const result = validateReview(review);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === "/unverified/0"));
  });
});

describe("validateReview — salvaged reviews (#312)", () => {
  it("salvaged review with salvagedVerdict: true skips schema_version check", () => {
    const salvaged = {
      verdict: "approve",
      summary: "LGTM [salvaged from an unterminated verdict line]",
      findings: [],
      next_steps: [],
      salvagedVerdict: true,
    };
    const result = validateReview(salvaged);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it("salvaged review still validates other fields strictly", () => {
    const badSalvaged = {
      verdict: "approve",
      summary: "LGTM [salvaged from an unterminated verdict line]",
      findings: [{ severity: "invalid" }],
      next_steps: [],
      salvagedVerdict: true,
    };
    const result = validateReview(badSalvaged);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === "/findings/0/severity"));
  });
});

describe("validateSchema — fail-loud on unsupported keyword", () => {
  it("throws naming the unsupported keyword", () => {
    const unsupportedSchema = {
      type: "string",
      pattern: "^[a-z]+$",
    };
    assert.throws(
      () => validateSchema(unsupportedSchema, "abc"),
      /Unsupported JSON Schema keyword: pattern/,
    );
  });
});
