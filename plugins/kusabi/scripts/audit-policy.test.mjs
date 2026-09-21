import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  AUDIT_POLICY_VERSION,
  AUDIT_GATE_TRIGGERS,
  evaluateAuditGate,
  sampleDecision,
  validateAuditGateInput,
  PUBLIC_API_PATH_PREFIXES,
  DESIGN_DOC_PREFIX,
  ESCALATION_FAMILY_DISPOSITIONS,
} from "./audit-policy.mjs";

function baseInput(overrides = {}) {
  return { gateId: "gate-1", ...overrides };
}

/** The decision an independent re-implementation of sampleDecision yields. */
function expectedSample(missionId, rate, salt) {
  const text = `${missionId}\u0000${salt}`;
  const bucket = parseInt(createHash("sha256").update(text).digest("hex").slice(0, 8), 16);
  return bucket / 0x100000000 < rate;
}

// ---------------------------------------------------------------------------
// trigger coverage — one test per trigger (T1..T13)
// ---------------------------------------------------------------------------

describe("evaluateAuditGate — T1..T13 individually", () => {
  it("T1: causal hypothesis in the issue", () => {
    const result = evaluateAuditGate(baseInput({ issue: { causalHypothesis: true } }));
    assert.equal(result.required, true);
    assert.deepEqual(result.triggers.map((t) => t.id), ["T1"]);
  });

  it("T2: no-fix closure", () => {
    const result = evaluateAuditGate(baseInput({ noFixClosure: true }));
    assert.equal(result.required, true);
    assert.deepEqual(result.triggers.map((t) => t.id), ["T2"]);
    assert.match(result.triggers[0].detail, /no-fix closure/);
  });

  it("T3: new public API/schema path added", () => {
    const result = evaluateAuditGate(baseInput({
      changeScope: { added: ["plugins/kusabi/schemas/audit-verdict.schema.json"], deleted: [], modified: [] },
    }));
    assert.ok(result.triggers.some((t) => t.id === "T3"), "T3 must fire");
    assert.match(result.triggers.find((t) => t.id === "T3").detail, /audit-verdict\.schema\.json/);
  });

  it("T3 does not fire for a non-public added path (T4 still does)", () => {
    const result = evaluateAuditGate(baseInput({
      changeScope: { added: ["src/lib/foo.mjs"], deleted: [], modified: [] },
    }));
    assert.equal(result.triggers.some((t) => t.id === "T3"), false);
    assert.equal(result.triggers.some((t) => t.id === "T4"), true);
  });

  it("T4: new files", () => {
    const result = evaluateAuditGate(baseInput({
      changeScope: { added: ["src/a.mjs", "src/b.mjs"], deleted: [], modified: [] },
    }));
    assert.ok(result.triggers.some((t) => t.id === "T4"));
    assert.match(result.triggers.find((t) => t.id === "T4").detail, /2 new file\(s\)/);
    assert.match(result.triggers.find((t) => t.id === "T4").detail, /src\/a\.mjs/);
  });

  it("T5: design-document change (modified)", () => {
    const result = evaluateAuditGate(baseInput({
      changeScope: { added: [], deleted: [], modified: ["docs/design/phase-chain.md"] },
    }));
    assert.ok(result.triggers.some((t) => t.id === "T5"));
    assert.match(result.triggers.find((t) => t.id === "T5").detail, /docs\/design\/phase-chain\.md/);
  });

  it("T5 fires for deleted design docs too", () => {
    const result = evaluateAuditGate(baseInput({
      changeScope: { added: [], deleted: ["docs/design/deprecated.md"], modified: [] },
    }));
    assert.ok(result.triggers.some((t) => t.id === "T5"));
  });

  it("T6: deleted, weakened, and skipped tests", () => {
    const result = evaluateAuditGate(baseInput({
      testChanges: { deleted: ["plugins/kusabi/scripts/a.test.mjs"], weakened: [], skipped: [] },
    }));
    assert.ok(result.triggers.some((t) => t.id === "T6"));
    assert.match(result.triggers.find((t) => t.id === "T6").detail, /deleted: plugins\/kusabi\/scripts\/a\.test\.mjs/);
  });

  it("T6 fires for weakened and skipped tests as well", () => {
    const result = evaluateAuditGate(baseInput({
      testChanges: { deleted: [], weakened: ["b.test.mjs"], skipped: ["c.test.mjs"] },
    }));
    assert.ok(result.triggers.some((t) => t.id === "T6"));
    const detail = result.triggers.find((t) => t.id === "T6").detail;
    assert.match(detail, /weakened: b\.test\.mjs/);
    assert.match(detail, /skipped: c\.test\.mjs/);
  });

  it("T7: verify skip flags", () => {
    const byFlag = evaluateAuditGate(baseInput({ verifySkipFlags: ["--skip-lint-gate", "--skip-type-gate"] }));
    assert.ok(byFlag.triggers.some((t) => t.id === "T7"));
    assert.match(byFlag.triggers.find((t) => t.id === "T7").detail, /--skip-lint-gate/);

    const byBoolean = evaluateAuditGate(baseInput({ verifySkipped: true }));
    assert.ok(byBoolean.triggers.some((t) => t.id === "T7"));
  });

  it("T8: repeated retry", () => {
    const result = evaluateAuditGate(baseInput({ reworkCount: 1 }));
    assert.ok(result.triggers.some((t) => t.id === "T8"));
    assert.match(result.triggers.find((t) => t.id === "T8").detail, /rework round 1/);
  });

  it("T8 does not fire on the first attempt", () => {
    const result = evaluateAuditGate(baseInput({ reworkCount: 0 }));
    assert.equal(result.triggers.some((t) => t.id === "T8"), false);
  });

  it("T9: high or critical finding", () => {
    const high = evaluateAuditGate(baseInput({ findings: [{ severity: "high" }] }));
    assert.ok(high.triggers.some((t) => t.id === "T9"));
    assert.match(high.triggers.find((t) => t.id === "T9").detail, /1 high/);

    const critical = evaluateAuditGate(baseInput({ findings: [{ severity: "critical" }] }));
    assert.ok(critical.triggers.some((t) => t.id === "T9"));
    assert.match(critical.triggers.find((t) => t.id === "T9").detail, /1 critical/);
  });

  it("T9 does not fire for low/medium findings", () => {
    const result = evaluateAuditGate(baseInput({
      findings: [{ severity: "low" }, { severity: "medium" }],
    }));
    assert.equal(result.triggers.some((t) => t.id === "T9"), false);
  });

  it("T10: terminal disposition in the escalation family", () => {
    for (const disposition of [...ESCALATION_FAMILY_DISPOSITIONS]) {
      const result = evaluateAuditGate(baseInput({ terminalDisposition: disposition }));
      assert.ok(result.triggers.some((t) => t.id === "T10"), disposition);
      assert.ok(result.triggers.find((t) => t.id === "T10").detail.includes(disposition), disposition);
    }
  });

  it("T10 does not fire for a non-escalation terminal disposition", () => {
    for (const disposition of ["accept", "accept-with-followup", "sol-blocked", "rework", "strategize"]) {
      const result = evaluateAuditGate(baseInput({ terminalDisposition: disposition }));
      assert.equal(result.triggers.some((t) => t.id === "T10"), false, disposition);
    }
  });

  it("T11: Luna recommends accept", () => {
    const result = evaluateAuditGate(baseInput({ lunaRecommendsAccept: true }));
    assert.ok(result.triggers.some((t) => t.id === "T11"));
  });

  it("T12: reproducible sampling at rate 1 always fires and reports sampled", () => {
    const result = evaluateAuditGate(baseInput({
      sampling: { missionId: "mission-abc123", rate: 1, salt: "v1" },
    }));
    assert.ok(result.triggers.some((t) => t.id === "T12"));
    assert.equal(result.sampled, true);
    assert.match(result.triggers.find((t) => t.id === "T12").detail, /mission-abc123/);
    assert.match(result.triggers.find((t) => t.id === "T12").detail, /rate=1/);
  });

  it("T12 does not fire at rate 0", () => {
    const result = evaluateAuditGate(baseInput({
      sampling: { missionId: "mission-abc123", rate: 0, salt: "v1" },
    }));
    assert.equal(result.triggers.some((t) => t.id === "T12"), false);
    assert.equal(result.sampled, false);
  });

  it("T13: pre-publish gate (advisory in v1 but represented)", () => {
    const result = evaluateAuditGate(baseInput({ publish: true }));
    assert.ok(result.triggers.some((t) => t.id === "T13"));
    assert.match(result.triggers.find((t) => t.id === "T13").detail, /host-only\/advisory in v1/);
  });
});

// ---------------------------------------------------------------------------
// no-trigger behavior, multi-trigger ordering, mandatory vs sampled-only
// ---------------------------------------------------------------------------

describe("evaluateAuditGate — aggregation", () => {
  it("no-trigger input: required=false, empty triggers, sampled=false, mandatory=false", () => {
    const result = evaluateAuditGate(baseInput());
    assert.deepEqual(result, {
      required: false,
      gateId: "gate-1",
      triggers: [],
      sampled: false,
      mandatory: false,
      policyVersion: AUDIT_POLICY_VERSION,
    });
  });

  it("multiple matching triggers are all retained in deterministic T1..T13 order", () => {
    const result = evaluateAuditGate(baseInput({
      issue: { causalHypothesis: true },
      noFixClosure: true,
      changeScope: { added: ["docs/design/new.md", "src/x.mjs"], deleted: [], modified: [] },
      testChanges: { deleted: ["t.test.mjs"], weakened: [], skipped: [] },
      verifySkipped: true,
      reworkCount: 2,
      findings: [{ severity: "critical" }],
      terminalDisposition: "escalate",
      lunaRecommendsAccept: true,
      sampling: { missionId: "mission-x", rate: 1, salt: "v1" },
      publish: true,
    }));
    const ids = result.triggers.map((t) => t.id);
    assert.deepEqual(ids, AUDIT_GATE_TRIGGERS); // all thirteen, in order
    assert.equal(result.required, true);
    assert.equal(result.sampled, true);
    assert.equal(result.mandatory, true);
  });

  it("an added docs/design path fires T3, T4 and T5 together (deterministic order)", () => {
    const result = evaluateAuditGate(baseInput({
      changeScope: { added: ["docs/design/phase-chain.md"], deleted: [], modified: [] },
    }));
    assert.deepEqual(result.triggers.map((t) => t.id), ["T3", "T4", "T5"]);
  });

  it("sampled-only gate: T12 alone is NOT mandatory (the sole deliberate fail-open)", () => {
    const result = evaluateAuditGate(baseInput({
      sampling: { missionId: "mission-only-sample", rate: 1, salt: "v1" },
    }));
    assert.equal(result.required, true);
    assert.equal(result.sampled, true);
    assert.equal(result.mandatory, false);
    assert.deepEqual(result.triggers.map((t) => t.id), ["T12"]);
  });

  it("a sampled gate with a substantive trigger IS mandatory", () => {
    const result = evaluateAuditGate(baseInput({
      findings: [{ severity: "high" }],
      sampling: { missionId: "mission-mixed", rate: 1, salt: "v1" },
    }));
    assert.equal(result.mandatory, true);
    assert.deepEqual(result.triggers.map((t) => t.id), ["T9", "T12"]);
  });

  it("gate identity is echoed and policy version is stable", () => {
    for (const gateId of ["gate-1", "gate-13"]) {
      const result = evaluateAuditGate(baseInput({ gateId, publish: true }));
      assert.equal(result.gateId, gateId);
      assert.equal(result.policyVersion, AUDIT_POLICY_VERSION);
      assert.equal(result.policyVersion, 1);
    }
  });

  it("prefixes are exported for replay documentation", () => {
    assert.deepEqual(PUBLIC_API_PATH_PREFIXES, ["plugins/kusabi/schemas/", "docs/design/"]);
    assert.equal(DESIGN_DOC_PREFIX, "docs/design/");
  });
});

// ---------------------------------------------------------------------------
// malformed input — fail deterministically rather than guess
// ---------------------------------------------------------------------------

describe("evaluateAuditGate — invalid or underspecified input", () => {
  it("rejects a missing or empty gateId", () => {
    assert.throws(() => evaluateAuditGate({}), /gateId is required/);
    assert.throws(() => evaluateAuditGate(baseInput({ gateId: "" })), /gateId is required/);
    assert.throws(() => evaluateAuditGate(baseInput({ gateId: "  " })), /gateId is required/);
  });

  it("rejects a non-object input", () => {
    assert.throws(() => evaluateAuditGate(null), /input must be an object/);
    assert.throws(() => evaluateAuditGate(undefined), /input must be an object/);
    assert.throws(() => evaluateAuditGate("gate-1"), /input must be an object/);
    assert.throws(() => evaluateAuditGate([]), /input must be an object/);
  });

  it("rejects unknown top-level keys", () => {
    assert.throws(() => evaluateAuditGate(baseInput({ gatteId: "gate-1" })), /unknown input key: gatteId/);
  });

  it("rejects malformed changeScope", () => {
    assert.throws(() => evaluateAuditGate(baseInput({ changeScope: "nope" })), /changeScope must be an object/);
    assert.throws(
      () => evaluateAuditGate(baseInput({ changeScope: { added: [], renamed: [] } })),
      /unknown changeScope key: renamed/,
    );
    assert.throws(
      () => evaluateAuditGate(baseInput({ changeScope: { added: "src/a.mjs" } })),
      /changeScope\.added must be an array/,
    );
    assert.throws(
      () => evaluateAuditGate(baseInput({ changeScope: { added: [""] } })),
      /changeScope\.added entries must be non-empty strings/,
    );
  });

  it("rejects malformed testChanges and verify flags", () => {
    assert.throws(() => evaluateAuditGate(baseInput({ testChanges: { xfail: [] } })), /unknown testChanges key: xfail/);
    assert.throws(() => evaluateAuditGate(baseInput({ verifySkipped: "yes" })), /verifySkipped must be a boolean/);
    assert.throws(() => evaluateAuditGate(baseInput({ verifySkipFlags: "--skip-lint-gate" })), /verifySkipFlags must be an array/);
  });

  it("rejects a malformed reworkCount", () => {
    assert.throws(() => evaluateAuditGate(baseInput({ reworkCount: -1 })), /non-negative integer/);
    assert.throws(() => evaluateAuditGate(baseInput({ reworkCount: 1.5 })), /non-negative integer/);
    assert.throws(() => evaluateAuditGate(baseInput({ reworkCount: "2" })), /non-negative integer/);
  });

  it("rejects malformed findings", () => {
    assert.throws(() => evaluateAuditGate(baseInput({ findings: "high" })), /findings must be an array/);
    assert.throws(() => evaluateAuditGate(baseInput({ findings: [{ title: "no severity" }] })), /severity must be one of/);
    assert.throws(() => evaluateAuditGate(baseInput({ findings: [{ severity: "blocking" }] })), /severity must be one of/);
  });

  it("rejects an unknown terminalDisposition (typo safety)", () => {
    assert.throws(() => evaluateAuditGate(baseInput({ terminalDisposition: "escalte" })), /unknown terminalDisposition: escalte/);
    assert.throws(() => evaluateAuditGate(baseInput({ terminalDisposition: 3 })), /non-empty string or null/);
  });

  it("rejects a malformed issue block", () => {
    assert.throws(() => evaluateAuditGate(baseInput({ issue: { causalHypothesis: "yes" } })), /must be a boolean/);
    assert.throws(() => evaluateAuditGate(baseInput({ issue: { other: true } })), /unknown issue key: other/);
  });

  it("rejects a malformed sampling block", () => {
    assert.throws(
      () => evaluateAuditGate(baseInput({ sampling: { missionId: "", rate: 0.2, salt: "v1" } })),
      /missionId must be a non-empty string/,
    );
    assert.throws(
      () => evaluateAuditGate(baseInput({ sampling: { missionId: "m", rate: 2, salt: "v1" } })),
      /rate must be a finite number in \[0, 1\]/,
    );
    assert.throws(
      () => evaluateAuditGate(baseInput({ sampling: { missionId: "m", rate: 0.2, salt: "" } })),
      /salt must be a non-empty string/,
    );
    assert.throws(
      () => evaluateAuditGate(baseInput({ sampling: { missionId: "m", rate: 0.2, salt: "v1", extra: 1 } })),
      /unknown sampling key: extra/,
    );
  });

  it("validateAuditGateInput normalizes defaults and is strict", () => {
    const v = validateAuditGateInput(baseInput());
    assert.deepEqual(v.changeScope, { added: [], deleted: [], modified: [] });
    assert.deepEqual(v.testChanges, { deleted: [], weakened: [], skipped: [] });
    assert.equal(v.verifySkipped, false);
    assert.equal(v.reworkCount, 0);
    assert.equal(v.terminalDisposition, null);
    assert.equal(v.issue.causalHypothesis, false);
    assert.equal(v.sampling, null);
    assert.equal(v.publish, false);
    assert.equal(v.gateId, "gate-1");
  });
});

// ---------------------------------------------------------------------------
// sampleDecision — reproducibility, boundaries, malformed rates/identifiers
// ---------------------------------------------------------------------------

describe("sampleDecision — determinism and boundaries", () => {
  const CASES = [
    ["mission-mu9abc", 0.5, "v1"],
    ["mission-mu9abc", 0.2, "v1"],
    ["mission-mu9def", 0.8, "salt-2026"],
    ["mission-mu9ghi", 0.05, "salt-2026"],
  ];

  it("is reproducible across calls and processes (same input, same output)", () => {
    for (const [id, rate, salt] of CASES) {
      assert.equal(sampleDecision(id, rate, salt), sampleDecision(id, rate, salt), `${id}@${rate}`);
      // An independent re-implementation over the raw SHA-256 agrees.
      assert.equal(sampleDecision(id, rate, salt), expectedSample(id, rate, salt), `${id}@${rate}`);
    }
  });

  it("rate 0 never samples", () => {
    for (const id of ["a", "b", "c", "mission-longer-id-0001"]) {
      assert.equal(sampleDecision(id, 0, "v1"), false, id);
    }
  });

  it("rate 1 always samples", () => {
    for (const id of ["a", "b", "c", "mission-longer-id-0001"]) {
      assert.equal(sampleDecision(id, 1, "v1"), true, id);
    }
  });

  it("sampling is monotonic in the rate for a fixed id", () => {
    for (const [id, , salt] of CASES) {
      let last = false;
      for (const rate of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
        const decision = sampleDecision(id, rate, salt);
        // A higher rate can only add samples — never remove one.
        assert.equal(decision || !last, true, `${id} not monotonic at ${rate}`);
        last = decision;
      }
    }
  });

  it("depends only on id, rate and salt — never on time or platform state", () => {
    // The decision is a pure function of the three arguments: identical calls
    // in the same process agree, and the fraction used is the SHA-256 of the
    // id+salt scaled by a fixed denominator (no Math.random, no Date).
    assert.equal(sampleDecision("mission-x", 0.2, "v1"), expectedSample("mission-x", 0.2, "v1"));
    assert.equal(sampleDecision("mission-x", 0.6, "v1"), expectedSample("mission-x", 0.6, "v1"));
    assert.equal(sampleDecision("mission-x", 0.2, "salt-2"), expectedSample("mission-x", 0.2, "salt-2"));
  });

  it("rejects malformed rates and identifiers", () => {
    assert.throws(() => sampleDecision("", 0.2, "v1"), /missionId must be a non-empty string/);
    assert.throws(() => sampleDecision(null, 0.2, "v1"), /missionId must be a non-empty string/);
    assert.throws(() => sampleDecision(42, 0.2, "v1"), /missionId must be a non-empty string/);
    for (const bad of [NaN, Infinity, -0.01, 1.01, "0.2", null, undefined]) {
      assert.throws(() => sampleDecision("mission-x", bad, "v1"), /rate must be a finite number in \[0, 1\]/);
    }
    assert.throws(() => sampleDecision("mission-x", 0.2, ""), /salt must be a non-empty string/);
    assert.throws(() => sampleDecision("mission-x", 0.2, null), /salt must be a non-empty string/);
  });
});