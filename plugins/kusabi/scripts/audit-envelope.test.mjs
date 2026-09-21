// audit-envelope.test.mjs — frozen acceptance tests for the kusabi #529
// evidence-envelope contract (kusabi #524 §11, slice 4).
//
// The envelope is the ONLY evidence path into the Sol seat: deterministic,
// sha-bound, immutable, with explicit truncation metadata, secret scrubbing,
// a bounded size, and exact seat provenance.  The contract frozen here:
//
//   - deterministic materialization of the six materialized item roles
//     (issue, Luna brief, Luna framing, raw diff, probes, worker report);
//     prior verdicts are envelope-level evidence recorded separately, not an
//     item role — every materialized item records role, source, sha256,
//     bytes, and path;
//   - any evidence-byte mutation changes the envelope hash;
//   - truncation is never silent: `truncated`, exact `omitted_bytes`, and the
//     strategy are recorded (head+tail boundary AND untruncated boundary);
//   - environment data is never enumerated or copied into the envelope, and
//     token-shaped credentials in supplied evidence are scrubbed;
//   - a bounded envelope-size contract that is deterministic and RECORDS
//     omissions instead of silently dropping content;
//   - seat substitution is fail-closed (an explicit flag is required);
//   - exact-seat failure is fail-closed except the narrow sampled-only Sol
//     gate case, and the two are distinguished.
//
// The production module (audit-envelope.mjs) is a #529 deliverable and does
// not exist yet — the import below is the RED point: the file fails because
// the materializer is absent, with the missing behavior named.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

let auditEnvelope;
try {
  auditEnvelope = await import("./audit-envelope.mjs");
} catch (err) {
  throw new Error(
    "audit-envelope.mjs is absent — the kusabi #529 evidence-envelope materializer " +
      "(deterministic sha-bound items, explicit truncation metadata, secret scrubbing, " +
      "bounded size with recorded omissions, fail-closed seat substitution) is not implemented yet.",
    { cause: err },
  );
}
const { ENVELOPE_VERSION, ENVELOPE_ROLES, buildAuditEnvelope, truncateEvidenceText, resolveSolGateSeatFailure } =
  auditEnvelope;

const ENVELOPE_SHA256_RE = /^[0-9a-f]{64}$/;

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Capture every evidence file the envelope materializes. */
function captureWriter() {
  const files = new Map();
  return {
    files,
    writeFile: (p, content) => {
      files.set(p, content);
    },
  };
}

function baseSeat(overrides = {}) {
  return {
    provider: "codex",
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    substituted: false,
    ...overrides,
  };
}

function baseItems() {
  return [
    { role: "issue", source: "file:.kusabi/issue-529.md", content: "The issue body text.", path: "evidence/issue.md" },
    { role: "luna_brief", source: "missions/mission-529-test/attempt-1/brief.md", content: "Luna's brief body.", path: "evidence/brief.md" },
    { role: "luna_reasoning", source: "jobs/job-1/output", content: "Luna's framing of the problem.", path: "evidence/luna.md" },
    { role: "diff", source: "container:diff_in_container --base 731f547", content: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n", path: "evidence/diff.patch" },
    { role: "probe_raw", source: "round-3.json:probeResults", content: "{\"probes\":[],\"verify\":\"pass\"}", path: "evidence/probes.json" },
    { role: "worker_report", source: "jobs/job-2/output", content: "Worker report body.", path: "evidence/worker.md" },
  ];
}

function baseEnvelopeInput(overrides = {}) {
  return {
    gateId: "gate-3",
    missionId: "mission-529-test",
    chainId: "chain-529-test",
    policyVersion: 1,
    seat: baseSeat(),
    triggers: [{ id: "T6", detail: "tests deleted or weakened" }],
    container: "eb44083765aa",
    baseSha: "731f547",
    changeScope: { added: [], deleted: [], modified: [] },
    items: baseItems(),
    priorVerdicts: [{ gate_id: "gate-2", verdict: "rework", envelope_sha256: sha256("gate-2-envelope") }],
    envelopeMaxBytes: 262144,
    allowSubstitute: false,
    ...overrides,
  };
}

/** True when `kept` is a head+tail reconstruction of `original` losing `omitted` bytes. */
function isHeadTail(kept, original, omitted) {
  if (kept.length + omitted !== original.length) return false;
  for (let h = 0; h <= kept.length; h++) {
    const t = kept.length - h;
    const head = original.slice(0, h);
    const tail = t === 0 ? "" : original.slice(original.length - t);
    if (kept === head + tail) return true;
  }
  return false;
}

describe("ENVELOPE_ROLES — the frozen materialization contract", () => {
  it("materializes exactly the six item roles of #524 §11 — prior verdicts are envelope-level, not an item role", () => {
    assert.deepEqual(ENVELOPE_ROLES, [
      "issue",
      "luna_brief",
      "luna_reasoning",
      "diff",
      "probe_raw",
      "worker_report",
    ]);
  });

  it("the envelope version is 1", () => {
    assert.equal(ENVELOPE_VERSION, 1);
  });
});

describe("buildAuditEnvelope — deterministic materialization (spec 2)", () => {
  it("materializes every item with role, source, sha256, bytes, and path", () => {
    const writer = captureWriter();
    const envelope = buildAuditEnvelope(baseEnvelopeInput({ writeFile: writer.writeFile }));
    assert.equal(envelope.items.length, ENVELOPE_ROLES.length);
    for (const item of envelope.items) {
      assert.equal(typeof item.role, "string", item.role);
      assert.equal(typeof item.source, "string", item.role);
      assert.match(item.sha256, ENVELOPE_SHA256_RE, item.role);
      assert.ok(Number.isInteger(item.bytes) && item.bytes > 0, item.role);
      assert.ok(item.path.startsWith("evidence/"), `${item.role} path ${item.path} must live under the evidence tree`);
      // The sha256 binds the exact materialized bytes (scrubbed + truncated).
      const written = writer.files.get(item.path);
      assert.equal(item.sha256, sha256(written), item.role);
      assert.equal(item.bytes, Buffer.byteLength(written, "utf8"), item.role);
    }
  });

  it("records prior verdicts on the envelope", () => {
    const envelope = buildAuditEnvelope(baseEnvelopeInput());
    assert.deepEqual(envelope.prior_verdicts, [
      { gate_id: "gate-2", verdict: "rework", envelope_sha256: sha256("gate-2-envelope") },
    ]);
  });

  it("identical inputs produce byte-identical envelopes and identical hashes", () => {
    const a = buildAuditEnvelope(baseEnvelopeInput());
    const b = buildAuditEnvelope(baseEnvelopeInput());
    assert.deepEqual(a, b);
    assert.equal(a.envelope_sha256, b.envelope_sha256);
  });

  it("mutating a single evidence byte changes the envelope hash", () => {
    const itemsA = baseItems();
    const itemsB = baseItems().map((item, i) =>
      i === 5 ? { ...item, content: "Worker report body!" } : item, // one byte: '.' -> '!'
    );
    const a = buildAuditEnvelope(baseEnvelopeInput({ items: itemsA }));
    const b = buildAuditEnvelope(baseEnvelopeInput({ items: itemsB }));
    assert.notEqual(a.envelope_sha256, b.envelope_sha256);
    // Only the mutated item's sha changes; the others stay identical.
    assert.notEqual(a.items[5].sha256, b.items[5].sha256);
    assert.equal(a.items[0].sha256, b.items[0].sha256);
  });

  it("a clean item's sha256 is the sha of its content and bytes match exactly", () => {
    const envelope = buildAuditEnvelope(baseEnvelopeInput());
    const item = envelope.items.find((i) => i.role === "diff");
    const raw = baseItems().find((i) => i.role === "diff").content;
    assert.equal(item.sha256, sha256(raw));
    assert.equal(item.bytes, Buffer.byteLength(raw, "utf8"));
  });

  it("the envelope hash is a 64-hex string and carries the envelope identity fields", () => {
    const envelope = buildAuditEnvelope(baseEnvelopeInput());
    assert.match(envelope.envelope_sha256, ENVELOPE_SHA256_RE);
    assert.equal(envelope.envelope_version, ENVELOPE_VERSION);
    assert.equal(envelope.gate_id, "gate-3");
    assert.equal(envelope.mission_id, "mission-529-test");
    assert.equal(envelope.chain_id, "chain-529-test");
  });

  it("records the gate classification (sampled / mandatory) from the triggers", () => {
    const sampledOnly = buildAuditEnvelope(
      baseEnvelopeInput({ triggers: [{ id: "T12", detail: "sampled" }] }),
    );
    assert.equal(sampledOnly.sampled, true);
    assert.equal(sampledOnly.mandatory, false);

    const substantive = buildAuditEnvelope(baseEnvelopeInput());
    assert.equal(substantive.sampled, false);
    assert.equal(substantive.mandatory, true);

    const mixed = buildAuditEnvelope(
      baseEnvelopeInput({
        triggers: [
          { id: "T9", detail: "high finding" },
          { id: "T12", detail: "sampled" },
        ],
      }),
    );
    assert.equal(mixed.sampled, true);
    assert.equal(mixed.mandatory, true);
  });
});

describe("buildAuditEnvelope — truncation is never silent (spec 3)", () => {
  it("an item exactly at its per-item bound is NOT truncated (untruncated boundary)", () => {
    const content = "0123456789";
    const items = [{ role: "worker_report", source: "s", content, path: "evidence/worker.md", maxBytes: 10 }];
    const envelope = buildAuditEnvelope(baseEnvelopeInput({ items }));
    const item = envelope.items[0];
    assert.ok(!("truncated" in item), "untruncated items carry no truncation metadata");
    assert.equal(item.bytes, 10);
    assert.equal(item.sha256, sha256(content));
  });

  it("an item one byte over its per-item bound is truncated with exact omitted_bytes and head+tail", () => {
    const content = "0123456789";
    const items = [{ role: "worker_report", source: "s", content, path: "evidence/worker.md", maxBytes: 9 }];
    const envelope = buildAuditEnvelope(baseEnvelopeInput({ items }));
    const item = envelope.items[0];
    assert.equal(item.truncated, true);
    assert.equal(item.omitted_bytes, 1);
    assert.equal(item.truncation, "head+tail");
    assert.equal(item.bytes, 9);
    assert.equal(item.bytes + item.omitted_bytes, Buffer.byteLength(content, "utf8"));
    // The truncation is recorded as an omission, never silent.
    assert.deepEqual(envelope.omissions, [
      { role: "worker_report", path: "evidence/worker.md", omitted_bytes: 1, truncation: "head+tail" },
    ]);
  });

  it("truncateEvidenceText — exact boundary: at maxBytes nothing is truncated", () => {
    const original = "0123456789";
    const result = truncateEvidenceText(original, { maxBytes: 10 });
    assert.equal(result.truncated, false);
    assert.equal(result.text, original);
    assert.equal(result.omitted_bytes, 0);
    assert.equal(result.truncation, null);
  });

  it("truncateEvidenceText — one byte over: exact omitted_bytes and a head+tail splice", () => {
    const original = "0123456789";
    const result = truncateEvidenceText(original, { maxBytes: 9 });
    assert.equal(result.truncated, true);
    assert.equal(result.omitted_bytes, 1);
    assert.equal(result.truncation, "head+tail");
    assert.equal(result.text.length, 9);
    assert.ok(isHeadTail(result.text, original, 1), `kept "${result.text}" is not a head+tail splice`);
  });

  it("truncateEvidenceText — head+tail keeps the first and last bytes and drops the middle", () => {
    const original = "HEAD-BYTES....MIDDLE-IS-DROPPED....TAIL-BYTES";
    const result = truncateEvidenceText(original, { maxBytes: 18 });
    assert.equal(result.truncated, true);
    assert.equal(result.omitted_bytes, original.length - 18);
    assert.equal(result.text[0], original[0]);
    assert.equal(result.text[result.text.length - 1], original[original.length - 1]);
    assert.ok(isHeadTail(result.text, original, original.length - 18));
  });

  it("an oversized item inside the envelope records its truncation on the item and in omissions", () => {
    const content = "x".repeat(50000);
    const items = [{ role: "worker_report", source: "jobs/job-2/output", content, path: "evidence/worker.md", maxBytes: 50000 }];
    const untruncated = buildAuditEnvelope(baseEnvelopeInput({ items }));
    assert.equal(untruncated.items[0].bytes, 50000);
    assert.equal(untruncated.items[0].truncated, undefined);

    const bound = [{ role: "worker_report", source: "jobs/job-2/output", content, path: "evidence/worker.md", maxBytes: 25000 }];
    const truncated = buildAuditEnvelope(baseEnvelopeInput({ items: bound }));
    const item = truncated.items[0];
    assert.equal(item.truncated, true);
    assert.equal(item.omitted_bytes, 25000);
    assert.equal(item.truncation, "head+tail");
    assert.equal(item.bytes, 25000);
    assert.ok(truncated.omissions.length >= 1);
  });
});

describe("buildAuditEnvelope — bounded envelope size records omissions (spec 5)", () => {
  it("under the envelope cap: nothing is truncated and omissions is empty", () => {
    const envelope = buildAuditEnvelope(baseEnvelopeInput());
    assert.deepEqual(envelope.omissions, []);
    for (const item of envelope.items) {
      assert.ok(!("truncated" in item));
    }
  });

  it("a cap the complete envelope cannot fit fails closed with envelope-metadata-over-budget and writes nothing", () => {
    // `envelopeMaxBytes` is the COMPLETE seat-visible envelope budget, used
    // literally: this envelope's metadata/provenance alone serializes to more
    // than 100 bytes even with every item reduced to zero content, so NO item
    // reduction can satisfy the cap and the build must fail closed before
    // materializing anything (kusabi #529 final finding).
    const input = baseEnvelopeInput({ envelopeMaxBytes: 100 });
    const totalOriginal = input.items.reduce((n, i) => n + Buffer.byteLength(i.content, "utf8"), 0);
    assert.ok(totalOriginal > 100, "test precondition: the cap must bite");

    const writer = captureWriter();
    assert.throws(
      () => buildAuditEnvelope({ ...input, writeFile: writer.writeFile }),
      (err) => {
        assert.ok(err && typeof err === "object", "the failure must be a coded Error");
        assert.equal(err.code, "envelope-metadata-over-budget");
        assert.match(err.message, /envelope-metadata-over-budget/);
        assert.match(err.message, /no item reduction can satisfy the cap/);
        return true;
      },
    );
    // Fail closed BEFORE any materialization: a 100-byte cap cannot hold the
    // envelope's own metadata, so no partial evidence tree ever exists.
    assert.equal(writer.files.size, 0, "a fail-closed envelope must never materialize evidence");
  });
});

describe("buildAuditEnvelope — secret hygiene (spec 4)", () => {
  const GITHUB_PAT = `ghp_${"a".repeat(36)}`;
  const OPENAI_KEY = `sk-${"b".repeat(48)}`;
  const BEARER = `Bearer ${"c".repeat(40)}`;
  const PRIVATE_KEY =
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt\n-----END PRIVATE KEY-----";

  it("never enumerates or copies environment data into the envelope", () => {
    const MARKER = "KUSABI_529_TEST_MARKER";
    const VALUE = "KUSABI-529-SECRET-MARKER-VALUE";
    const saved = process.env[MARKER];
    process.env[MARKER] = VALUE;
    try {
      const writer = captureWriter();
      const envelope = buildAuditEnvelope(baseEnvelopeInput({ writeFile: writer.writeFile }));
      const serialized = JSON.stringify(envelope);
      assert.ok(!serialized.includes(MARKER), "an env var NAME leaked into the envelope");
      assert.ok(!serialized.includes(VALUE), "an env var VALUE leaked into the envelope");
      for (const content of writer.files.values()) {
        assert.ok(!content.includes(MARKER));
        assert.ok(!content.includes(VALUE));
      }
    } finally {
      if (saved === undefined) delete process.env[MARKER];
      else process.env[MARKER] = saved;
    }
  });

  it("the envelope is byte-identical whether or not environment variables are set", () => {
    const MARKER = "KUSABI_529_TEST_MARKER";
    const saved = process.env[MARKER];
    process.env[MARKER] = "KUSABI-529-SECRET-MARKER-VALUE";
    let withEnv;
    try {
      withEnv = buildAuditEnvelope(baseEnvelopeInput());
    } finally {
      if (saved === undefined) delete process.env[MARKER];
      else process.env[MARKER] = saved;
    }
    const withoutEnv = buildAuditEnvelope(baseEnvelopeInput());
    assert.deepEqual(withEnv, withoutEnv);
  });

  it("scrubs token-shaped credentials from supplied evidence (GitHub, OpenAI, bearer, private key)", () => {
    const content =
      `The token is ${GITHUB_PAT} and the key is ${OPENAI_KEY}. ` +
      `Authorization: ${BEARER}. Plus a key file:\n${PRIVATE_KEY}\nRest of the issue body.`;
    const items = [{ role: "issue", source: "file:.kusabi/issue-529.md", content, path: "evidence/issue.md" }];
    const writer = captureWriter();
    const envelope = buildAuditEnvelope(baseEnvelopeInput({ items, writeFile: writer.writeFile }));

    const written = writer.files.get("evidence/issue.md");
    assert.ok(written, "the scrubbed evidence is what the seat reads");
    for (const secret of [GITHUB_PAT, OPENAI_KEY, BEARER, PRIVATE_KEY]) {
      assert.ok(!written.includes(secret), `raw credential shape survived scrubbing: ${secret.slice(0, 20)}...`);
      assert.ok(!JSON.stringify(envelope).includes(secret), "a credential leaked into the envelope record");
    }
    // No token-shaped remnant survives.
    assert.ok(!/ghp_[A-Za-z0-9]{36}/.test(written));
    assert.ok(!/sk-[A-Za-z0-9]{48}/.test(written));
    assert.ok(!/Bearer [0-9a-f]{40}/.test(written));
    assert.ok(!/-----BEGIN PRIVATE KEY-----/.test(written));
    // The recorded sha256 binds the SCRUBBED bytes, not the raw ones.
    const item = envelope.items[0];
    assert.notEqual(item.sha256, sha256(content));
    assert.equal(item.sha256, sha256(written));
  });

  it("scrubbing is deterministic", () => {
    const content = `token ${GITHUB_PAT} in evidence`;
    const items = [{ role: "issue", source: "s", content, path: "evidence/issue.md" }];
    const writerA = captureWriter();
    const writerB = captureWriter();
    const a = buildAuditEnvelope(baseEnvelopeInput({ items, writeFile: writerA.writeFile }));
    const b = buildAuditEnvelope(baseEnvelopeInput({ items, writeFile: writerB.writeFile }));
    assert.equal(a.items[0].sha256, b.items[0].sha256);
    assert.equal(writerA.files.get("evidence/issue.md"), writerB.files.get("evidence/issue.md"));
  });

  it("non-secret evidence text passes through verbatim (no over-scrubbing)", () => {
    const content = "Plain issue body with no credentials inside.";
    const items = [{ role: "issue", source: "s", content, path: "evidence/issue.md" }];
    const writer = captureWriter();
    const envelope = buildAuditEnvelope(baseEnvelopeInput({ items, writeFile: writer.writeFile }));
    assert.equal(writer.files.get("evidence/issue.md"), content);
    assert.equal(envelope.items[0].sha256, sha256(content));
  });
});

describe("buildAuditEnvelope — seat substitution is fail-closed (specs 6 and 8)", () => {
  it("a substituted seat without explicit authorization is refused (fail closed)", () => {
    assert.throws(
      () =>
        buildAuditEnvelope(
          baseEnvelopeInput({ seat: baseSeat({ model: "gpt-5.6-luna-mini", substituted: true }) }),
        ),
      (err) => err !== null && typeof err === "object" && err.code === "substitution-not-authorized",
    );
  });

  it("a substituted seat with explicit authorization builds and records substituted: true", () => {
    const envelope = buildAuditEnvelope(
      baseEnvelopeInput({
        seat: baseSeat({ model: "gpt-5.6-luna-mini", substituted: true }),
        allowSubstitute: true,
      }),
    );
    assert.equal(envelope.seat.substituted, true);
    assert.equal(envelope.seat.model, "gpt-5.6-luna-mini");
  });

  it("an exact seat builds with substituted: false and needs no flag", () => {
    const envelope = buildAuditEnvelope(baseEnvelopeInput());
    assert.equal(envelope.seat.substituted, false);
  });

  it("the seat block records exact provider/model/reasoning-effort provenance", () => {
    const envelope = buildAuditEnvelope(baseEnvelopeInput());
    assert.deepEqual(envelope.seat, baseSeat());
  });
});

describe("buildAuditEnvelope — prior verdicts are validated, never silently accepted", () => {
  it("a prior verdict with a malformed envelope hash is refused (fail closed)", () => {
    assert.throws(
      () =>
        buildAuditEnvelope(
          baseEnvelopeInput({ priorVerdicts: [{ gate_id: "gate-2", verdict: "rework", envelope_sha256: "ZZZ" }] }),
        ),
      (err) => err !== null && typeof err === "object" && err.code === "invalid-prior-verdict",
    );
  });

  it("a prior verdict missing its verdict value is refused", () => {
    assert.throws(
      () =>
        buildAuditEnvelope(
          baseEnvelopeInput({ priorVerdicts: [{ gate_id: "gate-2", envelope_sha256: sha256("x") }] }),
        ),
      (err) => err !== null && typeof err === "object" && err.code === "invalid-prior-verdict",
    );
  });

  it("an item with a role outside the frozen set is refused", () => {
    assert.throws(
      () =>
        buildAuditEnvelope(
          baseEnvelopeInput({ items: [{ role: "secret_file", source: "s", content: "x", path: "evidence/x.md" }] }),
        ),
      (err) => err !== null && typeof err === "object" && err.code === "unknown-role",
    );
  });
});

describe("resolveSolGateSeatFailure — exact-seat failure is fail-closed (spec 8)", () => {
  it("a mandatory Sol gate with the seat unavailable fails closed as sol-blocked", () => {
    const result = resolveSolGateSeatFailure({
      required: true,
      mandatory: true,
      sampled: false,
      seatAvailable: false,
    });
    assert.equal(result.failClosed, true);
    assert.equal(result.disposition, "sol-blocked");
  });

  it("the ONLY fail-open is an explicitly sampled-only Sol gate (audit-sample-skipped)", () => {
    const result = resolveSolGateSeatFailure({
      required: true,
      mandatory: false,
      sampled: true,
      seatAvailable: false,
    });
    assert.equal(result.failClosed, false);
    assert.equal(result.disposition, "audit-sample-skipped");
  });

  it("a sampled gate that is ALSO mandatory still fails closed — mandatory wins", () => {
    const result = resolveSolGateSeatFailure({
      required: true,
      mandatory: true,
      sampled: true,
      seatAvailable: false,
    });
    assert.equal(result.failClosed, true);
    assert.equal(result.disposition, "sol-blocked");
  });

  it("an available seat always proceeds, even on a mandatory gate", () => {
    const result = resolveSolGateSeatFailure({
      required: true,
      mandatory: true,
      sampled: false,
      seatAvailable: true,
    });
    assert.equal(result.failClosed, false);
    assert.equal(result.disposition, "proceed");
  });

  it("a non-required gate proceeds regardless of seat availability", () => {
    const result = resolveSolGateSeatFailure({
      required: false,
      mandatory: false,
      sampled: false,
      seatAvailable: false,
    });
    assert.equal(result.failClosed, false);
    assert.equal(result.disposition, "proceed");
  });

  it("the exception is narrow: a required gate that is neither mandatory nor sampled does NOT fail open", () => {
    // required && !mandatory && !sampled is an invariant violation for the
    // policy engine — such a gate must fail closed, never be skipped.
    const result = resolveSolGateSeatFailure({
      required: true,
      mandatory: false,
      sampled: false,
      seatAvailable: false,
    });
    assert.equal(result.failClosed, true);
    assert.notEqual(result.disposition, "audit-sample-skipped");
  });
});