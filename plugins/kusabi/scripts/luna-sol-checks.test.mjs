import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAcceptanceCriteria } from "./brief-parsing.mjs";
import { loadSolInvariants } from "./luna-sol-gate.mjs";
import { validateAuditVerdict } from "./audit-verdict.mjs";

const INVARIANT_IDS = ["INV1", "INV2", "INV3", "INV4", "INV5"];
const ENVELOPE_PATHS = ["evidence/mission-brief.txt", "evidence/worker-report-0.txt"];

function validV2(overrides = {}) {
  return {
    type: "verdict",
    schema_version: 2,
    gate_id: "gate-1",
    envelope_sha256: "a".repeat(64),
    verdict: "clear",
    summary: "all checks passed",
    invariants: INVARIANT_IDS.map((id) => ({ id, held: true })),
    criteria: [],
    ...overrides,
  };
}

function options(criteria = []) {
  return {
    invariantIds: INVARIANT_IDS,
    criteria,
    envelopeItemPaths: ENVELOPE_PATHS,
    requireV2: true,
  };
}

describe("Sol invariant and acceptance-criteria checks", () => {
  it("derives invariant ids from the standing file", () => {
    const { text, ids } = loadSolInvariants();
    assert.match(text, /INV1/);
    assert.deepEqual(ids, INVARIANT_IDS);
  });

  it("extracts numbered acceptance criteria in order", () => {
    const brief = [
      "## Acceptance criteria",
      "",
      "1. First criterion",
      "2) Second criterion",
      "   - nested is not top level",
      "prose",
    ].join("\n");
    assert.deepEqual(parseAcceptanceCriteria(brief), [
      { id: "AC1", text: "First criterion" },
      { id: "AC2", text: "Second criterion" },
    ]);
  });

  it("extracts bullets under case-insensitive Acceptance", () => {
    const brief = ["## aCcEpTaNcE", "- one", "* two", "+ three"].join("\n");
    assert.deepEqual(parseAcceptanceCriteria(brief), [
      { id: "AC1", text: "one" },
      { id: "AC2", text: "two" },
      { id: "AC3", text: "three" },
    ]);
  });

  it("returns no criteria when the section is absent", () => {
    assert.deepEqual(parseAcceptanceCriteria("## Deliverables\n- a.txt"), []);
    assert.equal(validateAuditVerdict(validV2(), options([])).valid, true);
  });

  it("rejects missing, unknown, and duplicated per-item ids", () => {
    const missing = validV2({ invariants: INVARIANT_IDS.slice(0, -1).map((id) => ({ id, held: true })) });
    assert.equal(validateAuditVerdict(missing, options()).valid, false);

    const unknown = validV2({
      invariants: [
        ...INVARIANT_IDS.slice(0, 4).map((id) => ({ id, held: true })),
        { id: "INV9", held: true },
      ],
    });
    assert.equal(validateAuditVerdict(unknown, options()).valid, false);

    const duplicate = validV2({
      invariants: [
        ...INVARIANT_IDS.map((id) => ({ id, held: true })),
        { id: "INV1", held: true },
      ],
    });
    assert.equal(validateAuditVerdict(duplicate, options()).valid, false);
  });

  it("requires findings and valid evidence paths", () => {
    const noFinding = validV2({ invariants: [{ id: "INV1", held: false }, ...INVARIANT_IDS.slice(1).map((id) => ({ id, held: true }))] });
    assert.equal(validateAuditVerdict(noFinding, options()).valid, false);

    const criteria = [{ id: "AC1", text: "check it" }];
    const noEvidence = validV2({ criteria: [{ id: "AC1", status: "met" }] });
    assert.equal(validateAuditVerdict(noEvidence, options(criteria)).valid, false);

    const wrongEvidence = validV2({ criteria: [{ id: "AC1", status: "not_met", evidence: "evidence/missing.txt" }] });
    assert.equal(validateAuditVerdict(wrongEvidence, options(criteria)).valid, false);
  });

  it("rejects clear for a violated invariant or unmet criterion but accepts rework", () => {
    const criteria = [{ id: "AC1", text: "check it" }];
    const badItems = {
      invariants: [{ id: "INV1", held: false, finding: "duplicate source" }, ...INVARIANT_IDS.slice(1).map((id) => ({ id, held: true }))],
      criteria: [{ id: "AC1", status: "not_met", evidence: ENVELOPE_PATHS[0] }],
    };
    assert.equal(validateAuditVerdict(validV2(badItems), options(criteria)).valid, false);
    assert.equal(validateAuditVerdict(validV2({ ...badItems, verdict: "rework" }), options(criteria)).valid, true);
  });

  it("keeps recorded v1 verdicts readable", () => {
    const legacy = {
      type: "verdict",
      schema_version: 1,
      gate_id: "gate-1",
      envelope_sha256: "a".repeat(64),
      verdict: "clear",
      summary: "legacy",
    };
    assert.equal(validateAuditVerdict(legacy).valid, true);
  });
});
