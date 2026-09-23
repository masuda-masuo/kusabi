// luna-inner-brief-contract.test.mjs — acceptance tests for the schema-owned
// `inner_brief` contract and its rendering into the coordinator prompt
// (decision 4).
//
// Frozen acceptance contract (decision 4):
//
//   - the EXISTING schemas/coordinator-output.schema.json (no new schema file)
//     owns an `inner_brief` contract section that describes the inner-chain
//     brief (run_chain / rework_chain `brief`) requirements;
//   - the contract covers exactly five frozen rules:
//       1. signature   — signature ownership: the deterministic driver owns
//                        the inner-brief signature; Luna must NOT invent one
//                        (the driver strips any `Orchestrator:` line in the
//                        first five lines and prepends the canonical line);
//       2. deliverables — a non-empty `## Deliverables` section is required;
//       3. smoke       — the `## Smoke` command constraints, including the
//                        `baseline-red` annotation semantics;
//       4. frozen_tests — `## Frozen Tests` path-only rules (the entry is the
//                        path alone; leftover prose is invisible to P5);
//       5. empty_headings — empty sections must OMIT their heading;
//   - the real coordinator prompt renderer (renderCoordinatorContract) derives
//     the FULL inner_brief contract from that schema section: every rule's
//     description is rendered into the prompt text, so schema and prompt can
//     never drift apart (one rule missing from the prompt = drift).
//
// The renderer is luna-prompt.mjs's renderCoordinatorContract — the SAME
// renderer the real coordinator dispatch splices into the actual Codex prompt
// (luna-driver.mjs realCoordinatorDispatch), so a renderer-level drift check
// pins what the seat actually reads.
//
// Baseline: the schema has no `inner_brief` section and the renderer renders
// no inner-brief contract, so every test below fails behaviorally (the
// feature is missing), never with an import or syntax error.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadCoordinatorSchema, renderCoordinatorContract } from "./luna-prompt.mjs";

/** The five frozen inner-brief rules, in contract order. */
const INNER_BRIEF_RULES = ["signature", "deliverables", "smoke", "frozen_tests", "empty_headings"];

/**
 * The minimal semantic content each rule's description must cover (decision
 * 4's five topics).  Tolerant patterns: any faithful wording matches.
 */
const RULE_SEMANTICS = {
  signature: [
    /Orchestrator/,
    /(must not|never|does not|do not)/,
    /\bdriver\b/,
  ],
  deliverables: [/Deliverables/],
  smoke: [/Smoke/, /baseline-red/],
  frozen_tests: [/Frozen Tests/, /\bpath\b/],
  empty_headings: [/empty/, /(omit|omission|without|drop|absent)/],
};

describe("the schema-owned inner_brief contract and its prompt rendering (decision 4)", () => {
  it("the coordinator schema owns an inner_brief contract section", () => {
    const schema = loadCoordinatorSchema();
    assert.ok(
      schema.inner_brief,
      "schemas/coordinator-output.schema.json must own an `inner_brief` contract section (schema-owned, never hand-written in the prompt)",
    );
  });

  it("the inner_brief contract carries the five frozen rules, each with a non-empty description", () => {
    const schema = loadCoordinatorSchema();
    assert.ok(schema.inner_brief, "the schema must own the inner_brief contract section (missing on base)");
    for (const key of INNER_BRIEF_RULES) {
      const rule = schema.inner_brief?.properties?.[key];
      assert.ok(rule, `inner_brief must own the "${key}" rule`);
      assert.ok(
        typeof rule.description === "string" && rule.description.trim() !== "",
        `the "${key}" rule must carry a non-empty description`,
      );
    }
  });

  it("each inner_brief rule's description covers its contract topic (signature ownership, Deliverables, Smoke/baseline-red, Frozen Tests path-only, empty-heading omission)", () => {
    const schema = loadCoordinatorSchema();
    assert.ok(schema.inner_brief, "the schema must own the inner_brief contract section (missing on base)");
    for (const key of INNER_BRIEF_RULES) {
      const description = schema.inner_brief?.properties?.[key]?.description ?? "";
      for (const pattern of RULE_SEMANTICS[key]) {
        assert.match(
          description,
          pattern,
          `the "${key}" rule description must cover its topic (${pattern}): "${description.slice(0, 120)}..."`,
        );
      }
    }
  });

  it("the rendered coordinator contract derives the FULL inner_brief contract from the schema — every rule, verbatim (schema/prompt drift)", () => {
    const schema = loadCoordinatorSchema();
    assert.ok(schema.inner_brief, "the schema must own the inner_brief contract section (missing on base)");
    const rendered = renderCoordinatorContract(schema);
    for (const key of INNER_BRIEF_RULES) {
      const description = schema.inner_brief?.properties?.[key]?.description;
      assert.ok(
        typeof description === "string" && description !== "",
        `the "${key}" rule must carry a description to render`,
      );
      assert.ok(
        rendered.includes(description),
        `the rendered coordinator contract must state the "${key}" rule verbatim from the schema ` +
          `(drift: the prompt would not follow a schema edit): "${description.slice(0, 120)}..."`,
      );
    }
  });
});