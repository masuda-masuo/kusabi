import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUDIT_VERDICT_SCHEMA_VERSION,
  AUDIT_VERDICTS,
  AUDIT_OVERRIDE_RESOLUTIONS,
  OVERRIDABLE_VERDICTS,
  ENVELOPE_SHA256_RE,
  SUMMARY_MAX_LENGTH,
  BLOCK_REASON_MAX_LENGTH,
  AuditVerdictError,
  validateAuditVerdict,
  bindAuditVerdict,
  recordAuditVerdict,
  parseAuditVerdictJsonl,
  createAuditOverride,
} from "./audit-verdict.mjs";

const SHA = "a".repeat(64);

const VALID_CLEAR = {
  type: "verdict",
  schema_version: 1,
  gate_id: "gate-3",
  envelope_sha256: SHA,
  verdict: "clear",
  summary: "The change matches the envelope.",
};

const VALID_REWORK = {
  ...VALID_CLEAR,
  verdict: "rework",
  summary: "Needs another pass on the probe output.",
};

const VALID_BLOCK = {
  ...VALID_CLEAR,
  verdict: "block",
  summary: "The premise is unverified.",
  block_reason: "wrong_premise",
  acknowledgement_required: true,
};

// ---------------------------------------------------------------------------
// schema validation
// ---------------------------------------------------------------------------

describe("validateAuditVerdict — valid records", () => {
  it("accepts a valid clear record", () => {
    const result = validateAuditVerdict(VALID_CLEAR);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it("accepts a valid rework record (no block fields needed)", () => {
    const result = validateAuditVerdict(VALID_REWORK);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it("accepts a valid block record with its conditional block fields", () => {
    const result = validateAuditVerdict(VALID_BLOCK);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it("the schema uses only keywords the generic validator implements (no throw)", () => {
    assert.doesNotThrow(() => validateAuditVerdict(VALID_BLOCK));
  });
});

describe("validateAuditVerdict — rejections", () => {
  it("rejects unknown fields (additionalProperties: false)", () => {
    const record = { ...VALID_CLEAR, luna_note: "please pass" };
    const result = validateAuditVerdict(record);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === "/luna_note"));
  });

  it("rejects an invalid verdict enum", () => {
    for (const verdict of ["looks-good", "approve", "", 1, null]) {
      const result = validateAuditVerdict({ ...VALID_CLEAR, verdict });
      assert.equal(result.valid, false, JSON.stringify(verdict));
      assert.ok(result.errors.some((e) => e.path === "/verdict"));
    }
  });

  it("rejects an invalid schema_version", () => {
    for (const version of [2, 0, -1, "1", 1.5, null, true]) {
      const result = validateAuditVerdict({ ...VALID_CLEAR, schema_version: version });
      assert.equal(result.valid, false, JSON.stringify(version));
      assert.ok(result.errors.some((e) => e.path === "/schema_version"));
    }
  });

  it("rejects a missing required field", () => {
    for (const field of ["type", "schema_version", "gate_id", "envelope_sha256", "verdict", "summary"]) {
      const record = { ...VALID_CLEAR };
      delete record[field];
      const result = validateAuditVerdict(record);
      assert.equal(result.valid, false, `missing ${field} must fail`);
      assert.ok(result.errors.some((e) => e.path === `/${field}`));
    }
  });

  it("rejects a verdict record whose type is not 'verdict'", () => {
    const result = validateAuditVerdict({ ...VALID_CLEAR, type: "finding" });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === "/type"));
  });

  it("rejects a block record missing its conditional block fields", () => {
    const noReason = { ...VALID_BLOCK };
    delete noReason.block_reason;
    const result = validateAuditVerdict(noReason);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === "/block_reason"));

    const noAck = { ...VALID_BLOCK };
    delete noAck.acknowledgement_required;
    const result2 = validateAuditVerdict(noAck);
    assert.equal(result2.valid, false);
    assert.ok(result2.errors.some((e) => e.path === "/acknowledgement_required"));
  });

  it("rejects an empty block_reason (minLength)", () => {
    const result = validateAuditVerdict({ ...VALID_BLOCK, block_reason: "" });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === "/block_reason"));
  });

  it("rejects malformed envelope hashes", () => {
    for (const hash of [
      "abc",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),           // uppercase hex is not the contract
      "g".repeat(64),           // not hex
      `${"a".repeat(63)} `,     // trailing space
      123,
      null,
    ]) {
      const result = validateAuditVerdict({ ...VALID_CLEAR, envelope_sha256: hash });
      assert.equal(result.valid, false, JSON.stringify(hash));
      assert.ok(result.errors.some((e) => e.path === "/envelope_sha256"));
    }
  });

  it("accepts exactly the 64-lowercase-hex hash shape", () => {
    for (const hash of ["a".repeat(64), "0123456789abcdef".repeat(4)]) {
      assert.equal(ENVELOPE_SHA256_RE.test(hash), true);
      assert.equal(validateAuditVerdict({ ...VALID_CLEAR, envelope_sha256: hash }).valid, true);
    }
  });

  it("rejects an over-bounded summary", () => {
    const record = { ...VALID_CLEAR, summary: "x".repeat(SUMMARY_MAX_LENGTH + 1) };
    const result = validateAuditVerdict(record);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === "/summary"));
    assert.equal(validateAuditVerdict({ ...VALID_CLEAR, summary: "x".repeat(SUMMARY_MAX_LENGTH) }).valid, true);
  });

  it("rejects an over-bounded block_reason", () => {
    const record = { ...VALID_BLOCK, block_reason: "x".repeat(BLOCK_REASON_MAX_LENGTH + 1) };
    const result = validateAuditVerdict(record);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.path === "/block_reason"));
  });

  it("rejects a non-object record", () => {
    for (const record of [null, "verdict", 42, [], undefined]) {
      const result = validateAuditVerdict(record);
      assert.equal(result.valid, false, JSON.stringify(record));
    }
  });

  it("exposes the versioned constants", () => {
    assert.equal(AUDIT_VERDICT_SCHEMA_VERSION, 1);
    assert.deepEqual(AUDIT_VERDICTS, ["clear", "rework", "block"]);
  });
});

// ---------------------------------------------------------------------------
// gate/envelope binding — stale or mismatched verdicts are rejected
// ---------------------------------------------------------------------------

describe("bindAuditVerdict — SHA/gate binding", () => {
  it("binds a verdict whose gate and envelope match", () => {
    const bound = bindAuditVerdict(VALID_BLOCK, { gateId: "gate-3", envelopeSha256: SHA });
    assert.equal(bound, VALID_BLOCK); // same record, unmodified
  });

  it("rejects a verdict claiming a different gate", () => {
    assert.throws(
      () => bindAuditVerdict(VALID_CLEAR, { gateId: "gate-4", envelopeSha256: SHA }),
      (err) => err instanceof AuditVerdictError && err.code === "gate-mismatch" &&
        /gate_id/.test(err.message),
    );
  });

  it("rejects a verdict bound to a stale/different envelope hash", () => {
    assert.throws(
      () => bindAuditVerdict(VALID_CLEAR, { gateId: "gate-3", envelopeSha256: "b".repeat(64) }),
      (err) => err instanceof AuditVerdictError && err.code === "envelope-mismatch" &&
        /stale or forged/.test(err.message),
    );
  });

  it("rejects a schema-invalid record before binding", () => {
    const broken = { ...VALID_CLEAR, verdict: "approve" };
    assert.throws(
      () => bindAuditVerdict(broken, { gateId: "gate-3", envelopeSha256: SHA }),
      (err) => err instanceof AuditVerdictError && err.code === "invalid-verdict",
    );
  });
});

describe("recordAuditVerdict — the single writer seam", () => {
  it("validates and binds, then hands the EXACT record to the injected writer", async () => {
    const written = [];
    const result = await recordAuditVerdict(VALID_CLEAR, {
      gateId: "gate-3",
      envelopeSha256: SHA,
      persist: async (record) => { written.push(record); },
    });
    assert.equal(result, VALID_CLEAR);
    assert.equal(written.length, 1);
    assert.equal(written[0], VALID_CLEAR); // persisted record IS the original
  });

  it("returns the bound record without any writer when none is injected", async () => {
    const result = await recordAuditVerdict(VALID_BLOCK, { gateId: "gate-3", envelopeSha256: SHA });
    assert.equal(result, VALID_BLOCK);
  });

  it("never persists a mismatched verdict — the writer is not called", async () => {
    let called = false;
    await assert.rejects(
      recordAuditVerdict(VALID_CLEAR, {
        gateId: "gate-9",
        envelopeSha256: SHA,
        persist: async () => { called = true; },
      }),
      (err) => err instanceof AuditVerdictError && err.code === "gate-mismatch",
    );
    assert.equal(called, false);
  });
});

// ---------------------------------------------------------------------------
// JSONL parser
// ---------------------------------------------------------------------------

describe("parseAuditVerdictJsonl", () => {
  const FINDING_LINE = JSON.stringify({
    type: "finding", severity: "high", title: "Premise unverified",
    body: "The issue premise is not supported.", file: "plugins/kusabi/scripts/luna-driver.mjs",
  });

  it("parses findings and the single closing verdict record (type stripped)", () => {
    const stream = [
      FINDING_LINE,
      JSON.stringify(VALID_BLOCK),
    ].join("\n");
    const parsed = parseAuditVerdictJsonl(stream);
    assert.equal(parsed.findings.length, 1);
    assert.equal(parsed.findings[0].type, undefined);
    assert.equal(parsed.findings[0].severity, "high");
    assert.equal(parsed.findings[0].title, "Premise unverified");
    assert.deepEqual(parsed.verdict, VALID_BLOCK);
    assert.equal(parsed.ignoredLines, 0);
    assert.equal(parsed.verdictCount, 1);
    assert.equal(parsed.ambiguous, false);
  });

  // ---- ambiguity: multiple verdict records fail closed (kusabi #528 repair) ----
  // A stream with more than one verdict record — even identical duplicates —
  // is ambiguous.  Preferring the last could silently drop a Sol veto (a
  // block followed by a clear would read as "cleared").  The parse must fail
  // closed: no verdict, ambiguity reported, so no consumer can treat the
  // gate as cleared.

  it("block → clear: ambiguous, verdict null — the block veto is not silently dropped", () => {
    const stream = [
      JSON.stringify(VALID_BLOCK),
      JSON.stringify({ ...VALID_CLEAR, summary: "second verdict" }),
    ].join("\n");
    const parsed = parseAuditVerdictJsonl(stream);
    assert.equal(parsed.verdict, null);
    assert.equal(parsed.ambiguous, true);
    assert.equal(parsed.verdictCount, 2);
  });

  it("clear → block: ambiguous, verdict null — the later block is not silently preferred", () => {
    const stream = [
      JSON.stringify(VALID_CLEAR),
      JSON.stringify(VALID_BLOCK),
    ].join("\n");
    const parsed = parseAuditVerdictJsonl(stream);
    assert.equal(parsed.verdict, null);
    assert.equal(parsed.ambiguous, true);
    assert.equal(parsed.verdictCount, 2);
  });

  it("duplicate identical verdict records are ambiguous too — no veto dropped, no verdict invented", () => {
    const stream = [
      JSON.stringify(VALID_BLOCK),
      JSON.stringify(VALID_BLOCK),
    ].join("\n");
    const parsed = parseAuditVerdictJsonl(stream);
    assert.equal(parsed.verdict, null);
    assert.equal(parsed.ambiguous, true);
    assert.equal(parsed.verdictCount, 2);
  });

  it("a stream with three verdict records is ambiguous as well", () => {
    const stream = [
      JSON.stringify(VALID_BLOCK),
      JSON.stringify(VALID_CLEAR),
      JSON.stringify(VALID_BLOCK),
    ].join("\n");
    const parsed = parseAuditVerdictJsonl(stream);
    assert.equal(parsed.verdict, null);
    assert.equal(parsed.ambiguous, true);
    assert.equal(parsed.verdictCount, 3);
  });

  it("a single verdict record is still parsed (preserved behavior)", () => {
    const parsed = parseAuditVerdictJsonl(JSON.stringify(VALID_CLEAR));
    assert.deepEqual(parsed.verdict, VALID_CLEAR);
    assert.equal(parsed.verdictCount, 1);
    assert.equal(parsed.ambiguous, false);
  });

  it("ignores prose, fences, and junk lines but counts them", () => {
    const stream = [
      "I reviewed the evidence envelope.",
      "```json",
      FINDING_LINE,
      "```",
      "not json at all",
      JSON.stringify(VALID_CLEAR),
    ].join("\n");
    const parsed = parseAuditVerdictJsonl(stream);
    assert.equal(parsed.findings.length, 1);
    assert.equal(parsed.verdict.summary, VALID_CLEAR.summary);
    assert.equal(parsed.ignoredLines, 4);
    assert.equal(parsed.verdictCount, 1);
    assert.equal(parsed.ambiguous, false);
  });

  it("returns verdict null when the stream never produced one", () => {
    const parsed = parseAuditVerdictJsonl(FINDING_LINE);
    assert.equal(parsed.verdict, null);
    assert.equal(parsed.findings.length, 1);
    assert.equal(parsed.verdictCount, 0);
    assert.equal(parsed.ambiguous, false);
  });

  it("handles an empty stream", () => {
    assert.deepEqual(parseAuditVerdictJsonl(""), {
      verdict: null, findings: [], ignoredLines: 0, verdictCount: 0, ambiguous: false,
    });
    assert.deepEqual(parseAuditVerdictJsonl("   \n  \n"), {
      verdict: null, findings: [], ignoredLines: 0, verdictCount: 0, ambiguous: false,
    });
  });

  it("rejects a non-string input", () => {
    assert.throws(() => parseAuditVerdictJsonl(null), AuditVerdictError);
    assert.throws(() => parseAuditVerdictJsonl(42), AuditVerdictError);
  });

  it("records parse through unvalidated — validation is the caller's next step", () => {
    const stream = JSON.stringify({ ...VALID_CLEAR, verdict: "looks-good" });
    const parsed = parseAuditVerdictJsonl(stream);
    assert.equal(parsed.verdict.verdict, "looks-good");
    assert.equal(validateAuditVerdict(parsed.verdict).valid, false);
  });
});

// ---------------------------------------------------------------------------
// human override — additive, immutable, human-only, machine-readable
// ---------------------------------------------------------------------------

describe("createAuditOverride", () => {
  const HUMAN = {
    resolution: "clear",
    by: "masuda",
    reason: "Premise confirmed against the issue thread",
    timestamp: 1726790400000,
  };

  it("creates an additive record that embeds the original verdict byte-for-byte", () => {
    const override = createAuditOverride({ original: VALID_BLOCK, ...HUMAN });
    assert.equal(override.kind, "audit-override");
    assert.equal(override.schema_version, AUDIT_VERDICT_SCHEMA_VERSION);
    assert.equal(override.gate_id, VALID_BLOCK.gate_id);
    assert.equal(override.envelope_sha256, VALID_BLOCK.envelope_sha256);
    assert.equal(override.by, HUMAN.by);
    assert.equal(override.reason, HUMAN.reason);
    assert.equal(override.timestamp, HUMAN.timestamp);
    // The original verdict survives byte-for-byte inside the override.
    assert.equal(JSON.stringify(override.original), JSON.stringify(VALID_BLOCK));
  });

  it("carries the machine-readable resolution verbatim for every valid value", () => {
    for (const resolution of AUDIT_OVERRIDE_RESOLUTIONS) {
      const override = createAuditOverride({ original: VALID_BLOCK, ...HUMAN, resolution });
      assert.equal(override.resolution, resolution, resolution);
      assert.equal(JSON.stringify(override.original), JSON.stringify(VALID_BLOCK));
    }
    assert.deepEqual(AUDIT_OVERRIDE_RESOLUTIONS, ["clear", "rework", "block"]);
  });

  it("allows overriding a `rework` original (it fails closed on a mandatory gate) with an explicit resolution", () => {
    const override = createAuditOverride({ original: VALID_REWORK, ...HUMAN, resolution: "clear" });
    assert.equal(override.gate_id, VALID_REWORK.gate_id);
    assert.equal(override.resolution, "clear");
    assert.equal(JSON.stringify(override.original), JSON.stringify(VALID_REWORK));
  });

  it("rejects a missing resolution — a consumer must never infer it from prose", () => {
    assert.throws(
      () => createAuditOverride({ original: VALID_BLOCK, by: "h", reason: "x", timestamp: 1 }),
      (err) => err instanceof AuditVerdictError && err.code === "invalid-resolution",
    );
  });

  it("rejects malformed, type-confused, and whitespace-padded resolutions", () => {
    for (const resolution of ["approve", "maybe", "CLEAR", " clear ", "", 3, null, true, {}]) {
      assert.throws(
        () => createAuditOverride({ original: VALID_BLOCK, ...HUMAN, resolution }),
        (err) => err instanceof AuditVerdictError && err.code === "invalid-resolution",
        JSON.stringify(resolution),
      );
    }
  });

  it("rejects overriding a `clear` original deterministically — there is no veto to override", () => {
    assert.throws(
      () => createAuditOverride({ original: VALID_CLEAR, ...HUMAN }),
      (err) => err instanceof AuditVerdictError && err.code === "nothing-to-override" &&
        /never blocks progression/.test(err.message),
    );
    assert.deepEqual([...OVERRIDABLE_VERDICTS], ["block", "rework"]);
  });

  it("the embedded original is immutable (frozen)", () => {
    const override = createAuditOverride({ original: VALID_BLOCK, ...HUMAN });
    assert.equal(Object.isFrozen(override.original), true);
    assert.throws(() => { override.original.verdict = "clear"; }, TypeError);
    // And unchanged after the failed write.
    assert.equal(JSON.stringify(override.original), JSON.stringify(VALID_BLOCK));
  });

  it("the override itself never rewrites or erases the original record", () => {
    const override = createAuditOverride({ original: VALID_BLOCK, ...HUMAN });
    assert.deepEqual(Object.keys(override).sort(), [
      "by", "envelope_sha256", "gate_id", "kind", "original", "reason",
      "resolution", "schema_version", "timestamp",
    ]);
    assert.equal(JSON.stringify(override.original), JSON.stringify(VALID_BLOCK));
  });

  it("accepts an ISO-string timestamp as injected time", () => {
    const override = createAuditOverride({ original: VALID_BLOCK, ...HUMAN, timestamp: "2026-09-21T00:00:00Z" });
    assert.equal(override.timestamp, "2026-09-21T00:00:00Z");
  });

  it("rejects an invalid or unvalidated original verdict", () => {
    assert.throws(
      () => createAuditOverride({ original: { verdict: "block" }, ...HUMAN }),
      (err) => err instanceof AuditVerdictError && err.code === "invalid-verdict",
    );
    assert.throws(
      () => createAuditOverride({ original: "block", ...HUMAN }),
      (err) => err instanceof AuditVerdictError && err.code === "invalid-verdict",
    );
  });

  it("rejects an override of an override — the record is single-level immutable", () => {
    const first = createAuditOverride({ original: VALID_BLOCK, ...HUMAN });
    assert.throws(
      () => createAuditOverride({ original: first, ...HUMAN }),
      (err) => err instanceof AuditVerdictError && err.code === "override-of-override",
    );
  });

  it("a model/Luna cannot write one: every human attribution field is required", () => {
    // There is no field for a model's output to become the override; with any
    // attribution missing the call fails as not-a-human-override.
    const cases = [
      { original: VALID_BLOCK, resolution: "clear", reason: "x", timestamp: 1 },                     // no by
      { original: VALID_BLOCK, resolution: "clear", by: "  ", reason: "x", timestamp: 1 },           // blank by
      { original: VALID_BLOCK, resolution: "clear", by: "h", timestamp: 1 },                         // no reason
      { original: VALID_BLOCK, resolution: "clear", by: "h", reason: "", timestamp: 1 },             // blank reason
      { original: VALID_BLOCK, resolution: "clear", by: "h", reason: "x" },                          // no timestamp
      { original: VALID_BLOCK, resolution: "clear", by: "h", reason: "x", timestamp: true },         // bad timestamp
      { original: VALID_BLOCK, resolution: "clear", by: "h", reason: "x", timestamp: {} },           // bad timestamp
      { original: VALID_BLOCK, resolution: "clear", by: "h", reason: "x", timestamp: "" },           // blank timestamp
    ];
    for (const args of cases) {
      assert.throws(
        () => createAuditOverride(args),
        (err) => err instanceof AuditVerdictError && err.code === "not-a-human-override",
        JSON.stringify(args),
      );
    }
  });

  it("a model-authored verdict can only ever be the ORIGINAL being overridden, never the override", () => {
    // The verdict record Sol produced is accepted as `original` — that is the
    // point of the override.  But its fields are never copied onto the
    // override's attribution: resolution/by/reason/timestamp come only from
    // the human.
    const override = createAuditOverride({
      original: { ...VALID_BLOCK, summary: "Sol wrote this" },
      resolution: "clear",
      by: "masuda", reason: "human verified", timestamp: 1,
    });
    assert.equal(override.reason, "human verified");
    assert.equal(override.resolution, "clear");
    assert.equal(override.summary, undefined); // no model field leaked upward
    assert.equal(override.original.summary, "Sol wrote this");
  });
});