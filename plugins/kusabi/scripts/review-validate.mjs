// review-validate.mjs — strict review JSON validation against review-output.schema.json (kusabi #392)
//
// Interprets schemas/review-output.schema.json dynamically.
// Fail-loud: if a schema uses a keyword the validator does not implement,
// validation throws naming the keyword.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.resolve(SCRIPT_DIR, "../schemas/review-output.schema.json");

let cachedSchema = null;

export function loadReviewSchema() {
  if (!cachedSchema) {
    cachedSchema = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8"));
  }
  return cachedSchema;
}

const IMPLEMENTED_KEYWORDS = new Set([
  "$schema",
  "type",
  "enum",
  "const",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minLength",
  "minimum",
  "maximum",
  "if",
  "then",
  "else",
  "description",
]);

/**
 * Validate a data value against a JSON Schema fragment.
 *
 * @param {object} schema — JSON Schema object
 * @param {any} data — value under test
 * @param {string} currentPath — JSON-pointer prefix (e.g. "/findings/0")
 * @param {object} options
 * @param {Array<{ path: string, expected: string, actual: any }>} errors
 */
export function validateSchema(schema, data, currentPath = "", options = {}, errors = []) {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return errors;
  }

  // Fail-loud on unimplemented keywords
  for (const key of Object.keys(schema)) {
    if (!IMPLEMENTED_KEYWORDS.has(key)) {
      throw new Error(`Unsupported JSON Schema keyword: ${key}`);
    }
  }

  const path = currentPath || "";

  // 1. type
  if (schema.type !== undefined) {
    const expectedType = schema.type;
    let typeMatches = false;
    let actualType = typeof data;

    if (data === null) {
      actualType = "null";
      typeMatches = expectedType === "null";
    } else if (Array.isArray(data)) {
      actualType = "array";
      typeMatches = expectedType === "array";
    } else if (typeof data === "number") {
      if (Number.isNaN(data)) {
        actualType = "NaN";
        typeMatches = false;
      } else if (expectedType === "integer") {
        actualType = Number.isInteger(data) ? "integer" : "number";
        typeMatches = Number.isInteger(data);
      } else {
        actualType = "number";
        typeMatches = expectedType === "number";
      }
    } else {
      typeMatches = actualType === expectedType;
    }

    if (!typeMatches) {
      errors.push({
        path: path || "/",
        expected: `type: ${expectedType}`,
        actual: actualType,
      });
      return errors; // Do not check deeper if type mismatched
    }
  }

  // 2. const
  if (schema.const !== undefined) {
    if (data !== schema.const) {
      errors.push({
        path: path || "/",
        expected: `const: ${JSON.stringify(schema.const)}`,
        actual: data,
      });
    }
  }

  // 3. enum
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(data)) {
      errors.push({
        path: path || "/",
        expected: `one of [${schema.enum.join(", ")}]`,
        actual: data,
      });
    }
  }

  // 4. minLength
  if (typeof schema.minLength === "number") {
    if (typeof data === "string" && data.length < schema.minLength) {
      errors.push({
        path: path || "/",
        expected: `string with length >= ${schema.minLength}`,
        actual: data,
      });
    }
  }

  // 5. minimum
  if (typeof schema.minimum === "number") {
    if (typeof data === "number" && data < schema.minimum) {
      errors.push({
        path: path || "/",
        expected: `>= ${schema.minimum}`,
        actual: data,
      });
    }
  }

  // 6. maximum
  if (typeof schema.maximum === "number") {
    if (typeof data === "number" && data > schema.maximum) {
      errors.push({
        path: path || "/",
        expected: `<= ${schema.maximum}`,
        actual: data,
      });
    }
  }

  // 7. required
  if (Array.isArray(schema.required) && typeof data === "object" && data !== null && !Array.isArray(data)) {
    for (const reqKey of schema.required) {
      if (options.skipSchemaVersion && reqKey === "schema_version") {
        continue;
      }
      if (!(reqKey in data) || data[reqKey] === undefined) {
        errors.push({
          path: `${path}/${reqKey}`,
          expected: "required property to be present",
          actual: undefined,
        });
      }
    }
  }

  // 8. properties
  if (schema.properties && typeof data === "object" && data !== null && !Array.isArray(data)) {
    for (const [propKey, propSchema] of Object.entries(schema.properties)) {
      if (options.skipSchemaVersion && propKey === "schema_version" && data[propKey] === undefined) {
        continue;
      }
      if (propKey in data && data[propKey] !== undefined) {
        validateSchema(propSchema, data[propKey], `${path}/${propKey}`, options, errors);
      }
    }
  }

  // 9. additionalProperties
  if (schema.additionalProperties === false && typeof data === "object" && data !== null && !Array.isArray(data)) {
    const allowed = new Set(Object.keys(schema.properties || {}));
    for (const key of Object.keys(data)) {
      if (options.salvaged && key === "salvagedVerdict") {
        continue;
      }
      if (!allowed.has(key)) {
        errors.push({
          path: `${path}/${key}`,
          expected: "no additional properties",
          actual: data[key],
        });
      }
    }
  }

  // 10. items
  if (schema.items && Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      validateSchema(schema.items, data[i], `${path}/${i}`, options, errors);
    }
  }

  // 11. if / then / else
  if (schema.if && typeof schema.if === "object") {
    const ifErrors = [];
    validateSchema(schema.if, data, path, options, ifErrors);
    if (ifErrors.length === 0) {
      if (schema.then && typeof schema.then === "object") {
        validateSchema(schema.then, data, path, options, errors);
      }
    } else {
      if (schema.else && typeof schema.else === "object") {
        validateSchema(schema.else, data, path, options, errors);
      }
    }
  }

  return errors;
}

/**
 * Validate an assembled review object against review-output.schema.json.
 *
 * @param {any} obj — review object
 * @param {object} [options]
 * @param {object} [options.schema] — custom schema override
 * @param {boolean} [options.salvaged] — true if review verdict was salvaged (#312)
 * @param {boolean} [options.skipSchemaVersion] — true to skip schema_version check
 * @returns {{ valid: boolean, errors: Array<{ path: string, expected: string, actual: any }> }}
 */
export function validateReview(obj, options = {}) {
  const schema = options.schema || loadReviewSchema();
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return {
      valid: false,
      errors: [
        {
          path: "/",
          expected: "type: object",
          actual: obj === null ? "null" : Array.isArray(obj) ? "array" : typeof obj,
        },
      ],
    };
  }

  const isSalvaged = options.salvaged === true || obj.salvagedVerdict === true;
  const cleanObj = { ...obj };
  if (isSalvaged) {
    delete cleanObj.salvagedVerdict;
  }

  const validateOpts = {
    ...options,
    skipSchemaVersion: isSalvaged || options.skipSchemaVersion === true,
    salvaged: isSalvaged,
  };

  const errors = [];
  validateSchema(schema, cleanObj, "", validateOpts, errors);

  return {
    valid: errors.length === 0,
    errors,
  };
}
