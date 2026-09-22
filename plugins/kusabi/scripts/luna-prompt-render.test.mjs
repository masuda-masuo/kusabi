// luna-prompt-render.test.mjs — dev tests for the pure prompt-contract
// renderer (luna-prompt.mjs).  The frozen acceptance tests pin the contract
// through the OBSERVABLE dispatch (luna-prompt.test.mjs, which deliberately
// does not import the renderer); these tests pin the renderer directly:
// determinism, schema-derived content, and the injected-schema purity seam.
//
// The renderer is pure: the same schema bytes must render the same text in
// every process, and an explicitly injected schema must render without any
// filesystem dependency.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadCoordinatorSchema,
  loadSolSchema,
  renderCoordinatorContract,
  renderSolContract,
} from "./luna-prompt.mjs";

describe("luna-prompt.mjs renders the contract deterministically from the schemas", () => {
  it("renders identical text for the same schema (pure + deterministic)", () => {
    assert.equal(renderCoordinatorContract(), renderCoordinatorContract());
    assert.equal(renderSolContract(), renderSolContract());
  });

  it("renders the same text from an injected schema without the canonical file", () => {
    const coordinator = loadCoordinatorSchema();
    const sol = loadSolSchema();
    assert.equal(renderCoordinatorContract(coordinator), renderCoordinatorContract());
    assert.equal(renderSolContract(sol), renderSolContract());
  });

  it("the coordinator text derives the closed enums and body fields from the schema", () => {
    const text = renderCoordinatorContract();
    const schema = loadCoordinatorSchema();
    for (const action of schema.properties.action.enum) {
      assert.ok(text.includes(action), `coordinator text must name the action ${action}`);
    }
    for (const tool of schema.properties.tool.enum) {
      assert.ok(text.includes(tool), `coordinator text must name the probe tool ${tool}`);
    }
    for (const recommendation of schema.properties.recommendation.enum) {
      assert.ok(
        text.includes(recommendation),
        `coordinator text must name the finish recommendation ${recommendation}`,
      );
    }
    for (const tool of Object.keys(schema.probe_tools.properties)) {
      for (const arg of schema.probe_tools.properties[tool].call_args) {
        assert.ok(text.includes(arg), `coordinator text must state the ${tool} call argument ${arg}`);
      }
    }
    // the inner-chain brief requirement and the one-record-per-line framing
    assert.match(text, /requires?.{0,80}Deliverables/i);
    assert.match(text, /per line/i);
  });

  it("the coordinator text states each probe_tools.<tool> required fields and call_args from the schema", () => {
    // Review finding 3: the schema's probe_tools.<tool>.required and
    // .call_args are canonical — the rendered prompt must state them per
    // tool exactly as the schema declares them (the driver enforces the same
    // entries, pinned by the luna-driver probe_tools drift tests).
    const text = renderCoordinatorContract();
    const schema = loadCoordinatorSchema();
    for (const [tool, entry] of Object.entries(schema.probe_tools.properties)) {
      const required = entry.required.map((f) => `\`${f}\``).join(", ");
      const callArgs = entry.call_args.map((a) => `\`${a}\``).join(", ");
      assert.ok(
        text.includes(`${tool} -> requires ${required}; calls with ${callArgs}`),
        `coordinator text must state ${tool}'s schema-declared required fields and call args`,
      );
    }
    // the whitespace-only-pattern fail-closed rule is stated for searches
    assert.match(text, /whitespace-only `pattern` is refused before any tool call/);
  });

  it("the Sol text derives the common and block-only fields from the schema", () => {
    const text = renderSolContract();
    const schema = loadSolSchema();
    for (const field of schema.required) {
      assert.ok(text.includes(field), `Sol text must state the common field ${field}`);
    }
    for (const field of schema.then.required) {
      assert.ok(text.includes(field), `Sol text must state the block-only field ${field}`);
    }
    for (const verdict of schema.properties.verdict.enum) {
      assert.ok(text.includes(verdict), `Sol text must name the verdict ${verdict}`);
    }
  });
});