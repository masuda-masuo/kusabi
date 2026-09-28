// codex-schema.mjs — Codex strict output schema projection and null-stripping.
//
// Split out of codex-dispatch.mjs (pure move, no behaviour change): projecting
// canonical JSON schemas into the strict subset accepted by `--output-schema`
// (making optional properties nullable and required), and stripping the
// resulting nulls from review JSON outputs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");

// The agent whose output contract IS the review verdict.  When a dispatch
// carries it, `--output-schema` enforces the shape at the CLI (the measured
// `--output-schema` framing returns the terminal JSON text in the
// agent-message item, which the same extraction path reads).
export const REVIEW_AGENT = "kusabi-review";

/**
 * Project the canonical review schema into the strict subset accepted by
 * Codex's `--output-schema` response format.
 *
 * This is deliberately pure: callers own the canonical input and receive a
 * recursively cloned projection.  Codex requires every declared property to
 * be required, so properties that are optional in the canonical schema are
 * made nullable to preserve their original optionality.
 *
 * @param {unknown} schema
 * @returns {unknown}
 */
export function toCodexStrictSchema(schema) {
  if (Array.isArray(schema)) return schema.map((value) => toCodexStrictSchema(value));
  if (schema === null || typeof schema !== "object") return schema;

  const projected = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema" || key === "if" || key === "then" || key === "else") continue;
    projected[key] = toCodexStrictSchema(value);
  }

  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    const originalRequired = new Set(Array.isArray(schema.required) ? schema.required : []);
    projected.required = Object.keys(schema.properties);
    projected.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      const property = toCodexStrictSchema(value);
      if (!originalRequired.has(key) && property && typeof property === "object" && !Array.isArray(property)) {
        if (property.type !== undefined) {
          const types = Array.isArray(property.type) ? [...property.type] : [property.type];
          if (!types.includes("null")) types.push("null");
          property.type = types;
        }
        if (Array.isArray(property.enum) && !property.enum.includes(null)) {
          property.enum = [...property.enum, null];
        }
      }
      projected.properties[key] = property;
    }
  }

  return projected;
}

/**
 * Load and project the one canonical review schema.  The returned text is
 * used only as the contents of the per-job schema file.
 *
 * @param {string|null|undefined} agent
 * @returns {string|null}
 */
export function codexJsonSchemaFor(agent) {
  if (agent !== REVIEW_AGENT) return null;
  const raw = fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8");
  return JSON.stringify(toCodexStrictSchema(JSON.parse(raw)));
}

/**
 * Remove nulls that Codex emits for properties made nullable by the strict
 * projection.  Required canonical properties intentionally remain untouched.
 *
 * @param {unknown} value
 * @param {object} schema
 * @returns {unknown}
 */
export function stripCodexOptionalNulls(value, schema) {
  if (Array.isArray(value)) {
    return value.map((item) => stripCodexOptionalNulls(item, schema?.items));
  }
  if (value === null || typeof value !== "object" || !schema || typeof schema !== "object") {
    return value;
  }

  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
    ? schema.properties
    : {};
  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === null && Object.hasOwn(properties, key) && !required.has(key)) continue;
    clean[key] = stripCodexOptionalNulls(child, properties[key]);
  }
  return clean;
}

/**
 * Parse and clean a Codex review JSON result.  Malformed/non-JSON text is
 * returned unchanged for the existing downstream parser to report.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripCodexOptionalNullsFromText(text) {
  if (typeof text !== "string") return text;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  return JSON.stringify(stripCodexOptionalNulls(value, loadCanonicalReviewSchema()));
}

function loadCanonicalReviewSchema() {
  const raw = fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8");
  return JSON.parse(raw);
}

