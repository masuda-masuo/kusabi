// coordinator-parse.test.mjs — frozen acceptance tests for the kusabi #529
// coordinator-output parser contract (kusabi #524 §8, slice 4).
//
// The parser is the ONLY information path from the Luna seat into the
// deterministic mission driver.  The contract, frozen by these tests:
//
//   - a CLOSED action allow-list (the six verbs of #524 §8);
//   - unknown actions are rejected deterministically and are COUNTABLE from
//     the returned machine-readable result;
//   - malformed records fail deterministically;
//   - records bound to a stale or mismatched envelope hash fail
//     deterministically (a request about stale evidence must never execute);
//   - incomplete streams fail deterministically;
//   - identical output parses to an identical result in any process.
//
// Line classification (frozen by the tests below):
//   - blank lines                                 -> ignored, counted only
//   - non-JSON lines not starting with "{"        -> ignored prose (counted)
//   - a line starting with "{" that fails JSON.parse
//                                                  -> truncated record: INCOMPLETE
//   - valid JSON that is not a plain object       -> malformed
//   - a plain object missing/non-string `action`, or a missing/malformed
//     `envelope_sha256`                           -> malformed
//   - a valid 64-hex `envelope_sha256` that is not the current envelope hash
//                                                  -> rejected (envelope-mismatch)
//   - an `action` outside the allow-list          -> rejected (unknown-action),
//                                                    counted individually
//   - no accepted requests at all                 -> INCOMPLETE
//
// `valid` is false when any record was rejected or malformed or the stream
// is incomplete; `rejectedCount`/`rejectedActions`/`malformedCount` carry
// the machine-readable counts; `errors` carries `{line, reason, detail}`.
//
// The production module (coordinator-parse.mjs) is a #529 deliverable and
// does not exist at the time this file is written — the import below is the
// RED point: the file fails because the parser is absent, with the missing
// behavior named.  Once the module lands, the same import binds and every
// assertion below becomes the frozen oracle.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

let coordinatorParse;
try {
  coordinatorParse = await import("./coordinator-parse.mjs");
} catch (err) {
  throw new Error(
    "coordinator-parse.mjs is absent — the kusabi #529 coordinator-output parser " +
      "(closed action allow-list, deterministic rejection of unknown actions / malformed records / " +
      "stale envelope hashes / incomplete streams, countable machine-readable errors) is not implemented yet.",
    { cause: err },
  );
}
const { COORDINATOR_ACTIONS, parseCoordinatorOutput } = coordinatorParse;

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The current envelope hash the driver would bind a parse to. */
const CURRENT_ENVELOPE = sha256("envelope-for-gate-1-v1");

/** A well-formed request record bound to the current envelope. */
function request(overrides = {}) {
  return {
    action: "read_probe",
    envelope_sha256: CURRENT_ENVELOPE,
    ...overrides,
  };
}

describe("COORDINATOR_ACTIONS — the closed action allow-list", () => {
  it("is exactly the six frozen actions of #524 §8, in design order", () => {
    assert.deepEqual(COORDINATOR_ACTIONS, [
      "read_probe",
      "run_chain",
      "rework_chain",
      "consult_sol",
      "escalate_to_host",
      "finish",
    ]);
  });

  it("contains no verb that publishes, merges, writes an issue, or starts a container", () => {
    for (const action of COORDINATOR_ACTIONS) {
      assert.ok(
        !/publish|merge|issue|write|container|spawn|dispatch|resume/.test(action),
        `allow-list verb "${action}" implies a capability the seats must not have`,
      );
    }
  });
});

describe("schemas/coordinator-output.schema.json — the allow-list is the schema's enum", () => {
  it("exists and its action enum IS the closed allow-list (single source of truth)", () => {
    const schema = JSON.parse(
      readFileSync(path.join(SCRIPT_DIR, "..", "schemas", "coordinator-output.schema.json"), "utf8"),
    );
    assert.ok(schema && typeof schema === "object");
    assert.deepEqual(schema.properties.action.enum, COORDINATOR_ACTIONS);
  });

  it("binds every record to a 64-hex envelope hash under a real regex evaluation", () => {
    const schema = JSON.parse(
      readFileSync(path.join(SCRIPT_DIR, "..", "schemas", "coordinator-output.schema.json"), "utf8"),
    );
    // The schema pattern is the actual regex ^[0-9a-f]{64}$ (kusabi #529
    // finding 3): evaluated by any JSON Schema validator it accepts every
    // lowercase 64-hex hash — representative valid hashes must match, and
    // uppercase, wrong-length, and non-hex strings must not.
    const re = new RegExp(schema.properties.envelope_sha256.pattern);
    assert.equal(re.source, "^[0-9a-f]{64}$", "the schema pattern must be the real regex, not a fixed hash literal");
    assert.ok(re.test("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"));
    assert.ok(re.test("a".repeat(64)), "an arbitrary lowercase 64-hex hash must match");
    assert.ok(re.test("9".repeat(64)), "an arbitrary all-digit 64-hex hash must match");
    assert.equal(re.test("A".repeat(64)), false, "uppercase hex must not match");
    assert.equal(re.test("g".repeat(64)), false, "non-hex characters must not match");
    assert.equal(re.test("a".repeat(63)), false, "a 63-char hash must not match");
    assert.equal(re.test("a".repeat(65)), false, "a 65-char hash must not match");
  });
});

describe("parseCoordinatorOutput — well-formed streams", () => {
  it("parses every record in order and reports zero rejections", () => {
    const first = request({ action: "read_probe" });
    const second = request({ action: "consult_sol" });
    const result = parseCoordinatorOutput(
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
      { envelopeSha256: CURRENT_ENVELOPE },
    );
    assert.equal(result.valid, true);
    assert.deepEqual(result.requests, [first, second]);
    assert.equal(result.rejectedCount, 0);
    assert.deepEqual(result.rejectedActions, []);
    assert.equal(result.malformedCount, 0);
    assert.equal(result.incomplete, false);
    assert.deepEqual(result.errors, []);
  });

  it("passes per-action body fields through unvalidated (the driver bounds them)", () => {
    const record = request({
      action: "run_chain",
      brief: "Luna's brief text",
      probe_limit: 3,
    });
    const result = parseCoordinatorOutput(JSON.stringify(record), {
      envelopeSha256: CURRENT_ENVELOPE,
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.requests, [record]);
  });

  it("ignores prose and blank lines between records without counting them as malformed", () => {
    const record = request();
    const result = parseCoordinatorOutput(
      `thought: this is prose, not a record\n\n${JSON.stringify(record)}\n`,
      { envelopeSha256: CURRENT_ENVELOPE },
    );
    assert.equal(result.valid, true);
    assert.deepEqual(result.requests, [record]);
    assert.equal(result.malformedCount, 0);
  });
});

describe("parseCoordinatorOutput — unknown actions are rejected deterministically and countable", () => {
  it("rejects a single unknown action, names it, and counts it", () => {
    const bad = request({ action: "delete_repo" });
    const good = request({ action: "finish" });
    const result = parseCoordinatorOutput(
      `${JSON.stringify(bad)}\n${JSON.stringify(good)}\n`,
      { envelopeSha256: CURRENT_ENVELOPE },
    );
    assert.equal(result.valid, false);
    assert.equal(result.rejectedCount, 1);
    assert.deepEqual(result.rejectedActions, ["delete_repo"]);
    assert.deepEqual(result.requests, [good]);
    assert.equal(result.errors[0].reason, "unknown-action");
  });

  it("counts every unknown action individually, preserving order", () => {
    const stream = ["rm -rf /", "publish_now", "self_override"]
      .map((action) => JSON.stringify(request({ action })))
      .join("\n");
    const result = parseCoordinatorOutput(stream, { envelopeSha256: CURRENT_ENVELOPE });
    assert.equal(result.valid, false);
    assert.equal(result.rejectedCount, 3);
    assert.deepEqual(result.rejectedActions, ["rm -rf /", "publish_now", "self_override"]);
  });

  it("rejection is deterministic — identical output yields an identical result", () => {
    const stream = `${JSON.stringify(request({ action: "nope" }))}\n${JSON.stringify(request())}\n`;
    const a = parseCoordinatorOutput(stream, { envelopeSha256: CURRENT_ENVELOPE });
    const b = parseCoordinatorOutput(stream, { envelopeSha256: CURRENT_ENVELOPE });
    assert.deepEqual(a, b);
  });
});

describe("parseCoordinatorOutput — malformed records fail deterministically", () => {
  it("a JSON value that is not an object is malformed", () => {
    const result = parseCoordinatorOutput("[1, 2, 3]\n", { envelopeSha256: CURRENT_ENVELOPE });
    assert.equal(result.valid, false);
    assert.equal(result.malformedCount, 1);
    assert.equal(result.errors[0].reason, "not-an-object");
  });

  it("a record without an action is malformed", () => {
    const result = parseCoordinatorOutput(`${JSON.stringify({ envelope_sha256: CURRENT_ENVELOPE })}\n`, {
      envelopeSha256: CURRENT_ENVELOPE,
    });
    assert.equal(result.valid, false);
    assert.equal(result.malformedCount, 1);
    assert.equal(result.errors[0].reason, "missing-action");
  });

  it("a non-string action is malformed", () => {
    const result = parseCoordinatorOutput(`${JSON.stringify(request({ action: 42 }))}\n`, {
      envelopeSha256: CURRENT_ENVELOPE,
    });
    assert.equal(result.valid, false);
    assert.equal(result.malformedCount, 1);
  });

  it("a record without an envelope hash is malformed", () => {
    const result = parseCoordinatorOutput(`${JSON.stringify({ action: "finish" })}\n`, {
      envelopeSha256: CURRENT_ENVELOPE,
    });
    assert.equal(result.valid, false);
    assert.equal(result.malformedCount, 1);
    assert.equal(result.errors[0].reason, "invalid-envelope-hash");
  });

  it("an envelope hash that is not 64 lowercase hex is malformed", () => {
    const result = parseCoordinatorOutput(`${JSON.stringify(request({ envelope_sha256: "ZZZ" }))}\n`, {
      envelopeSha256: CURRENT_ENVELOPE,
    });
    assert.equal(result.valid, false);
    assert.equal(result.malformedCount, 1);
  });

  it("errors carry the 1-based record line so the correction can be returned once", () => {
    const good = request();
    const bad = request({ action: 42 });
    const result = parseCoordinatorOutput(
      `${JSON.stringify(good)}\n${JSON.stringify(bad)}\n`,
      { envelopeSha256: CURRENT_ENVELOPE },
    );
    assert.equal(result.malformedCount, 1);
    assert.equal(result.errors[0].line, 2);
  });
});

describe("parseCoordinatorOutput — stale or mismatched envelope hashes fail deterministically", () => {
  it("rejects a record bound to a different envelope hash as envelope-mismatch", () => {
    const other = sha256("envelope-for-a-different-gate");
    const result = parseCoordinatorOutput(`${JSON.stringify(request({ envelope_sha256: other }))}\n`, {
      envelopeSha256: CURRENT_ENVELOPE,
    });
    assert.equal(result.valid, false);
    assert.equal(result.rejectedCount, 1);
    assert.equal(result.errors[0].reason, "envelope-mismatch");
  });

  it("rejects a record bound to a STALE hash (previously valid, no longer current)", () => {
    const stale = sha256("envelope-for-gate-1-v0");
    const result = parseCoordinatorOutput(`${JSON.stringify(request({ envelope_sha256: stale }))}\n`, {
      envelopeSha256: CURRENT_ENVELOPE,
    });
    assert.equal(result.valid, false);
    assert.equal(result.rejectedCount, 1);
    assert.equal(result.errors[0].reason, "envelope-mismatch");
  });

  it("one stale record fails the whole stream — never partially executed", () => {
    const good = request();
    const stale = request({ envelope_sha256: sha256("old-envelope") });
    const result = parseCoordinatorOutput(
      `${JSON.stringify(good)}\n${JSON.stringify(stale)}\n`,
      { envelopeSha256: CURRENT_ENVELOPE },
    );
    assert.equal(result.valid, false);
    assert.equal(result.rejectedCount, 1);
  });
});

describe("parseCoordinatorOutput — incomplete streams fail deterministically", () => {
  it("an output with no request records at all is incomplete", () => {
    const result = parseCoordinatorOutput("just some prose\nand more prose\n", {
      envelopeSha256: CURRENT_ENVELOPE,
    });
    assert.equal(result.incomplete, true);
    assert.equal(result.valid, false);
  });

  it("an empty output is incomplete", () => {
    const result = parseCoordinatorOutput("", { envelopeSha256: CURRENT_ENVELOPE });
    assert.equal(result.incomplete, true);
    assert.equal(result.valid, false);
  });

  it("a stream cut off mid-record (an unterminated JSON line) is incomplete", () => {
    const good = request();
    const result = parseCoordinatorOutput(
      `${JSON.stringify(good)}\n{"action":"finish","envelope_sha256":"${CURRENT_ENVELOPE}"`,
      { envelopeSha256: CURRENT_ENVELOPE },
    );
    assert.equal(result.incomplete, true);
    assert.equal(result.valid, false);
  });

  it("a complete stream is never incomplete", () => {
    const result = parseCoordinatorOutput(`${JSON.stringify(request())}\n${JSON.stringify(request({ action: "finish" }))}\n`, {
      envelopeSha256: CURRENT_ENVELOPE,
    });
    assert.equal(result.incomplete, false);
    assert.equal(result.valid, true);
  });
});