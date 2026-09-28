import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCodexArgs } from "./codex-dispatch.mjs";
import {
  codexJsonSchemaFor,
  stripCodexOptionalNulls,
  stripCodexOptionalNullsFromText,
  toCodexStrictSchema,
} from "./codex-schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(HERE, "../schemas/review-output.schema.json");
const canonical = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8"));

function walkSchema(value, visit) {
  if (Array.isArray(value)) {
    for (const item of value) walkSchema(item, visit);
    return;
  }
  if (value === null || typeof value !== "object") return;
  visit(value);
  for (const child of Object.values(value)) walkSchema(child, visit);
}

describe("Codex strict review schema", () => {
  it("projects the canonical schema without mutation and makes every property required", () => {
    const before = structuredClone(canonical);
    const strict = toCodexStrictSchema(canonical);

    assert.deepEqual(canonical, before);
    walkSchema(strict, (fragment) => {
      assert.equal(Object.hasOwn(fragment, "if"), false);
      assert.equal(Object.hasOwn(fragment, "then"), false);
      assert.equal(Object.hasOwn(fragment, "else"), false);
      assert.equal(Object.hasOwn(fragment, "$schema"), false);
      if (fragment.properties) {
        assert.deepEqual(fragment.required, Object.keys(fragment.properties));
      }
    });

    assert.deepEqual(strict.properties.schema_version, canonical.properties.schema_version);
    assert.deepEqual(strict.properties.verdict, canonical.properties.verdict);
    assert.deepEqual(strict.properties.summary, canonical.properties.summary);
    assert.deepEqual(strict.properties.findings.type, canonical.properties.findings.type);
    assert.deepEqual(strict.properties.next_steps, canonical.properties.next_steps);
    assert.deepEqual(strict.properties.unverified.type, ["array", "null"]);
    assert.deepEqual(strict.properties.discard_reason.type, ["string", "null"]);
    assert.equal(strict.properties.discard_reason.enum.at(-1), null);

    const finding = strict.properties.findings.items;
    assert.deepEqual(finding.properties.severity, canonical.properties.findings.items.properties.severity);
    assert.deepEqual(finding.properties.title, canonical.properties.findings.items.properties.title);
    assert.deepEqual(finding.properties.kind.type, ["string", "null"]);
    assert.equal(finding.properties.kind.enum.at(-1), null);
    assert.deepEqual(finding.properties.file, canonical.properties.findings.items.properties.file);
  });

  it("serializes the strict projection for review only", () => {
    assert.equal(codexJsonSchemaFor("kusabi-review"), JSON.stringify(toCodexStrictSchema(canonical)));
    assert.equal(codexJsonSchemaFor("kusabi-implement"), null);
  });
});

describe("Codex review null cleanup", () => {
  it("removes only canonical-optional nulls recursively", () => {
    const measured = {
      schema_version: 1,
      verdict: "approve",
      summary: "nothing to review",
      findings: [{
        severity: "low",
        kind: null,
        title: "title",
        body: "body",
        file: "file.js",
        line_start: 1,
        line_end: 1,
        confidence: 1,
        recommendation: "none",
      }],
      next_steps: [],
      unverified: null,
      discard_reason: null,
    };
    const original = structuredClone(measured);
    const clean = stripCodexOptionalNulls(measured, canonical);

    assert.deepEqual(clean, {
      schema_version: 1,
      verdict: "approve",
      summary: "nothing to review",
      findings: [{
        severity: "low",
        title: "title",
        body: "body",
        file: "file.js",
        line_start: 1,
        line_end: 1,
        confidence: 1,
        recommendation: "none",
      }],
      next_steps: [],
    });
    assert.deepEqual(measured, original);

    const requiredNull = stripCodexOptionalNulls(
      { schema_version: 1, verdict: "approve", summary: null, findings: [], next_steps: [] },
      canonical,
    );
    assert.equal(requiredNull.summary, null);
  });

  it("cleans JSON text while leaving malformed text for downstream parsing", () => {
    const text = JSON.stringify({
      schema_version: 1,
      verdict: "approve",
      summary: "nothing to review",
      findings: [],
      next_steps: [],
      unverified: null,
      discard_reason: null,
    });
    assert.equal(
      stripCodexOptionalNullsFromText(text),
      '{"schema_version":1,"verdict":"approve","summary":"nothing to review","findings":[],"next_steps":[]}',
    );
    assert.equal(stripCodexOptionalNullsFromText("not json"), "not json");
  });
});

describe("Codex schema argv contract", () => {
  it("passes a schema path and omits the option for non-review dispatches", () => {
    const schemaPath = "/state/jobs/job/codex-output-schema.json";
    const args = buildCodexArgs({
      model: "gpt-5.6-sol",
      cwd: "/repo",
      sessionId: null,
      jsonSchema: schemaPath,
    });
    const index = args.indexOf("--output-schema");
    assert.ok(index >= 0);
    assert.equal(args[index + 1], schemaPath);

    const noSchema = buildCodexArgs({
      model: "gpt-5.6-sol",
      cwd: "/repo",
      sessionId: null,
      jsonSchema: null,
    });
    assert.equal(noSchema.includes("--output-schema"), false);
  });
});
