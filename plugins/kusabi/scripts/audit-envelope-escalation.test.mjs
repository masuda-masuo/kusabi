// audit-envelope-escalation.test.mjs — regression oracle for the terminal-chain
// findings on the kusabi #529 evidence envelope (chain-muatvum681a3), after the
// independent F1/F2 fix.  Baseline-red: this file does not exist before this
// task.
//
// Finding 1 (high, accepted): scrub BEFORE truncate.
// The previous implementation truncated raw item content and scrubbed AFTER:
// a head+tail splice of raw text can cut a credential in half so that no
// whole-token shape remains to match, and the surviving fragment (e.g.
// `ghp_` + a short alnum run, or a BEGIN without END on a PEM block) reaches
// materialized evidence and the item sha256 input.  These tests place every
// recognized secret shape exactly on the splice boundary and assert that
// neither the full credential nor any raw fragment reaches the materialized
// evidence or the hash input.
//
// Finding 2 (medium, accepted): bound the FULL seat-visible envelope.
// `envelopeMaxBytes` used to budget only materialized item bytes; a large
// `change_scope` / `prior_verdicts` payload can push the serialized envelope
// over the cap with no recourse.  These tests pin the whole-envelope bound:
// metadata that cannot fit even with zero item content fails closed with the
// stable code `envelope-metadata-over-budget` (provenance is never silently
// dropped, and nothing is materialized), and a satisfiable envelope is
// reduced deterministically with exact omission records until the COMPLETE
// canonical seat-visible serialization fits the envelope budget.
//
// Finding 3 (final, accepted): the literal cap must count `envelope_sha256`.
// The cap used to be checked against the hash-less envelope and the returned
// object then ADDED the 64-hex `envelope_sha256` field (+84 serialized bytes),
// so a hash-less envelope of 262141-262144 bytes passed the 262144-byte cap
// while the DELIVERED envelope was 262226-262229 bytes.  The materializer now
// budgets the complete RETURNED serialization (a deterministic 64-hex
// placeholder stands in for the hash, byte-identical in length to the real
// 64-hex hash), and the boundary tests below reproduce the exact window:
// every size in it either reduces item content to fit or fails closed, and
// every successful return satisfies
// `Buffer.byteLength(canonicalJson(returnedEnvelope)) <= envelopeMaxBytes`.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  buildAuditEnvelope,
  canonicalJson,
  DEFAULT_ENVELOPE_MAX_BYTES,
  ENVELOPE_ROLES,
  ENVELOPE_VERSION,
  scrubSecrets,
  truncateEvidenceText,
} from "./audit-envelope.mjs";

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

function baseEnvelopeInput(overrides = {}) {
  return {
    gateId: "gate-3",
    missionId: "mission-529-escalation",
    chainId: "chain-529-escalation",
    policyVersion: 1,
    seat: { provider: "codex", model: "gpt-5.6-sol", reasoning_effort: "high", substituted: false },
    triggers: [{ id: "T9", detail: "review finding severity=high" }],
    container: "cid-escalation",
    baseSha: "731f547",
    changeScope: { added: [], deleted: [], modified: [] },
    items: [],
    priorVerdicts: [],
    envelopeMaxBytes: DEFAULT_ENVELOPE_MAX_BYTES,
    allowSubstitute: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Finding 1 — scrub-before-truncate: credential fragments at the splice
// ---------------------------------------------------------------------------

const GITHUB_PAT = `ghp_${"a".repeat(36)}`;
const OPENAI_KEY = `sk-${"b".repeat(48)}`;
const BEARER = `Bearer ${"c".repeat(40)}`;
const PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt\n-----END PRIVATE KEY-----";

// The head+tail splice keeps the first bound/2 bytes and the last bound/2
// bytes.  The credential is placed so the head reaches INTO its start
// (leaving `ghp_` + a short alnum run, or a BEGIN without END on the PEM
// block) and a NON-ALNUM separator sits at the tail start — so the fragment's
// alnum run cannot be extended past the token-shape length by the
// concatenated tail.  That is exactly the condition under which truncating
// raw content FIRST left fragments that no whole-token regex matched.
function boundaryContent(secret) {
  return "H".repeat(130) + secret + "T".repeat(299) + "-" + "T".repeat(149);
}

describe("scrub-before-truncate: no raw credential fragments at the splice boundary (finding 1)", () => {
  const shapes = [
    {
      name: "GitHub PAT",
      secret: GITHUB_PAT,
      marker: "ghp_",
      fragment: /ghp_[A-Za-z0-9]+/,
    },
    {
      name: "OpenAI key",
      secret: OPENAI_KEY,
      marker: "sk-",
      fragment: /sk-[A-Za-z0-9]+/,
    },
    {
      name: "Bearer authorization value",
      secret: BEARER,
      marker: "Bearer ",
      fragment: /Bearer [0-9a-f]+/,
    },
    {
      name: "PEM private-key block",
      secret: PRIVATE_KEY,
      marker: "BEGIN PRIVATE",
      fragment: /BEGIN PRIVATE|END PRIVATE/,
    },
  ];

  for (const { name, secret, marker, fragment } of shapes) {
    it(`cuts through ${name} at the splice: neither the full credential nor a raw fragment reaches evidence`, () => {
      const content = boundaryContent(secret);
      const items = [
        { role: "worker_report", source: "jobs/job-2/output", content, path: "evidence/worker.md", maxBytes: 300 },
      ];
      const writer = captureWriter();
      const envelope = buildAuditEnvelope(
        baseEnvelopeInput({ items, writeFile: writer.writeFile }),
      );

      const written = writer.files.get("evidence/worker.md");
      assert.ok(written, "the scrubbed+truncated evidence is what the seat reads");
      // The full credential is gone.
      assert.ok(!written.includes(secret), `${name}: the raw credential reached materialized evidence`);
      // No raw FRAGMENT survives either — the whole credential was removed
      // before truncation, so the splice can only cut clean text.
      assert.ok(!written.includes(marker), `${name}: a raw fragment reached materialized evidence`);
      assert.ok(!fragment.test(written), `${name}: a token-shaped remnant survives`);
      // The envelope record itself carries no raw bytes.
      assert.ok(
        !JSON.stringify(envelope).includes(secret) && !JSON.stringify(envelope).includes(marker),
        `${name}: a credential fragment leaked into the envelope record`,
      );
      // The item sha256 binds the SCRUBBED materialized bytes — the raw
      // credential-bearing content is never the hash input.
      const item = envelope.items[0];
      assert.equal(item.sha256, sha256(written), `${name}: the hash must bind the materialized bytes`);
      assert.notEqual(item.sha256, sha256(content), `${name}: the hash must NOT bind raw credential bytes`);
    });
  }

  it("combines every secret shape in one oversized item at the splice: no fragment in evidence or hash input", () => {
    const content = [
      boundaryContent(GITHUB_PAT),
      boundaryContent(OPENAI_KEY),
      boundaryContent(BEARER),
      boundaryContent(PRIVATE_KEY),
      "Rest of the issue body.",
    ].join("\n");
    const items = [
      { role: "issue", source: "file:.kusabi/issue-529.md", content, path: "evidence/issue.md", maxBytes: 900 },
    ];
    const writer = captureWriter();
    const envelope = buildAuditEnvelope(
      baseEnvelopeInput({ items, writeFile: writer.writeFile }),
    );
    const written = writer.files.get("evidence/issue.md");
    for (const marker of ["ghp_", "sk-", "Bearer ", "BEGIN PRIVATE"]) {
      assert.ok(!written.includes(marker), `a raw ${marker} fragment reached the combined evidence`);
      assert.ok(!JSON.stringify(envelope).includes(marker), `a raw ${marker} fragment reached the envelope record`);
    }
    assert.ok(!/ghp_[A-Za-z0-9]+/.test(written));
    assert.ok(!/sk-[A-Za-z0-9]+/.test(written));
    assert.ok(!/Bearer [0-9a-f]+/.test(written));
    const item = envelope.items[0];
    assert.equal(item.sha256, sha256(written));
    assert.notEqual(item.sha256, sha256(content));
  });
});

// ---------------------------------------------------------------------------
// Finding 2 — the complete seat-visible envelope is bounded
// ---------------------------------------------------------------------------

describe("whole-envelope bound: the complete canonical seat-visible serialization (finding 2)", () => {
  it("the final canonical seat-visible serialization is byte-counted and fits the production envelope budget", () => {
    const envelope = buildAuditEnvelope(baseEnvelopeInput());
    const bytes = Buffer.byteLength(canonicalJson(envelope));
    assert.ok(Number.isInteger(bytes) && bytes > 0, "the complete serialization must be measurable");
    assert.ok(
      bytes <= DEFAULT_ENVELOPE_MAX_BYTES,
      `the complete seat-visible envelope is ${bytes} bytes — it must fit the ${DEFAULT_ENVELOPE_MAX_BYTES}-byte envelope budget`,
    );
  });

  it("a change_scope so large that metadata alone exceeds the budget fails closed with the stable code", () => {
    const bigScope = {
      formatVersion: 1,
      resolved: { "large": "x".repeat(300000) },
      paths: {},
    };
    const writer = captureWriter();
    assert.throws(
      () =>
        buildAuditEnvelope(
          baseEnvelopeInput({
            changeScope: bigScope,
            items: [
              { role: "diff", source: "s", content: "small diff", path: "evidence/diff.patch" },
            ],
            writeFile: writer.writeFile,
          }),
        ),
      (err) => {
        assert.ok(err && typeof err === "object", "the failure must be a coded Error");
        assert.equal(err.code, "envelope-metadata-over-budget");
        assert.match(err.message, /envelope-metadata-over-budget/);
        assert.match(err.message, /no item reduction can satisfy the cap/);
        return true;
      },
    );
    // Fail closed BEFORE any materialization: no partial evidence tree.
    assert.equal(writer.files.size, 0, "a fail-closed envelope must never materialize evidence");
  });

  it("a prior_verdicts list so large that metadata alone exceeds the budget fails closed with the stable code", () => {
    const verdicts = Array.from({ length: 2600 }, (_, i) => ({
      gate_id: `gate-${i}`,
      verdict: "rework",
      envelope_sha256: sha256(`verdict-${i}`),
    }));
    const writer = captureWriter();
    assert.throws(
      () =>
        buildAuditEnvelope(
          baseEnvelopeInput({
            priorVerdicts: verdicts,
            items: [{ role: "issue", source: "s", content: "issue body", path: "evidence/issue.md" }],
            writeFile: writer.writeFile,
          }),
        ),
      (err) => err !== null && typeof err === "object" && err.code === "envelope-metadata-over-budget",
    );
    assert.equal(writer.files.size, 0, "a fail-closed envelope must never materialize evidence");
  });

  it("when item reductions can satisfy the budget, the complete serialization fits and omissions stay exact", () => {
    const input = baseEnvelopeInput({
      changeScope: { formatVersion: 1, resolved: { "big": "y".repeat(40000) }, paths: {} },
      items: ENVELOPE_ROLES.map((role, i) => ({
        role,
        source: `source-${i}`,
        content: "z".repeat(60000),
        path: `evidence/${role}.md`,
      })),
    });
    const totalOriginal = input.items.reduce((n, i) => n + Buffer.byteLength(i.content, "utf8"), 0);

    const a = buildAuditEnvelope(input);
    const b = buildAuditEnvelope(input);

    // The COMPLETE canonical seat-visible serialization fits the envelope
    // budget — not just the materialized item bytes.
    const bytes = Buffer.byteLength(canonicalJson(a));
    assert.ok(
      bytes <= input.envelopeMaxBytes,
      `complete seat-visible envelope is ${bytes} bytes, exceeding the ${input.envelopeMaxBytes}-byte budget`,
    );
    assert.ok(a.omissions.length >= 1, "the reduction must be recorded as omissions, never silent");
    // Every original byte is kept or named as omitted (exact accounting).
    const kept = a.items.reduce((n, i) => n + i.bytes, 0);
    const omitted = a.omissions.reduce((n, o) => n + o.omitted_bytes, 0);
    assert.equal(kept + omitted, totalOriginal);
    for (const omission of a.omissions) {
      assert.ok(omission.role && omission.path);
      assert.ok(Number.isInteger(omission.omitted_bytes) && omission.omitted_bytes > 0);
      assert.equal(omission.truncation, "head+tail");
    }
    // Deterministic: identical inputs -> identical envelope, omissions, hash.
    assert.deepEqual(a, b);
    assert.equal(a.envelope_sha256, b.envelope_sha256);
  });

  it("a satisfiable envelope keeps every provenance field intact (nothing is silently dropped)", () => {
    const input = baseEnvelopeInput({
      changeScope: { formatVersion: 1, resolved: { "big": "y".repeat(40000) }, paths: {} },
      items: ENVELOPE_ROLES.map((role, i) => ({
        role,
        source: `source-${i}`,
        content: "z".repeat(60000),
        path: `evidence/${role}.md`,
      })),
    });
    const envelope = buildAuditEnvelope(input);
    // change_scope, prior_verdicts, triggers, and seat metadata survive
    // VERBATIM — the reduction touches item content only.
    assert.deepEqual(envelope.change_scope, input.changeScope);
    assert.deepEqual(envelope.prior_verdicts, input.priorVerdicts);
    assert.deepEqual(envelope.triggers, input.triggers);
    assert.deepEqual(envelope.seat, input.seat);
    assert.equal(envelope.container, input.container);
    assert.equal(envelope.base_sha, input.baseSha);
    assert.ok(Buffer.byteLength(canonicalJson(envelope)) <= DEFAULT_ENVELOPE_MAX_BYTES);
  });
});
// ---------------------------------------------------------------------------
// Finding 2 literal-cap fix — sub-default caps around the exact metadata
// boundary (kusabi #529 final finding).  `envelopeMaxBytes` is the COMPLETE
// seat-visible envelope budget, used literally: a cap below the default is a
// real cap, never floored up to DEFAULT_ENVELOPE_MAX_BYTES.  The exact
// boundary is byte-counted from the canonical serialization: the envelope
// carrying zero item content.  One byte below it the build must fail closed
// (`envelope-metadata-over-budget`, nothing materialized); one byte above it
// item content is reduced deterministically until the complete serialization
// fits the literal cap.
// ---------------------------------------------------------------------------

describe("sub-default caps around the exact metadata boundary (literal-cap contract)", () => {
  // The absolute floor of any envelope: the canonical serialization carrying
  // NO items at all — metadata/provenance only.
  function metadataOnlyBytes(input) {
    const envelope = buildAuditEnvelope({
      ...input,
      items: [],
      envelopeMaxBytes: DEFAULT_ENVELOPE_MAX_BYTES,
    });
    return Buffer.byteLength(canonicalJson(envelope));
  }

  // The fail-closed threshold the materializer actually enforces: the
  // canonical serialization with every PRESENT item reduced to zero content
  // (item records keep their truncated fields and one omission record each),
  // PLUS the `envelope_sha256` field the returned envelope carries — the
  // materializer measures the COMPLETE returned serialization, standing in a
  // deterministic 64-hex placeholder for the hash (byte-identical length to
  // the real 64-hex hash, kusabi #529 final finding).  Reproduced from the
  // exported materializer pieces so the boundary is measured — never a magic
  // constant — and verified against the error message, which carries the
  // materializer's own minimum-byte count.
  function zeroContentBoundaryBytes(input) {
    const items = [];
    const omissions = [];
    for (const item of input.items) {
      const truncated = truncateEvidenceText(scrubSecrets(item.content), { maxBytes: 0 });
      items.push({
        role: item.role,
        source: item.source,
        sha256: sha256(truncated.text),
        bytes: 0,
        path: item.path,
        truncated: true,
        omitted_bytes: truncated.omitted_bytes,
        truncation: truncated.truncation,
      });
      omissions.push({
        role: item.role,
        path: item.path,
        omitted_bytes: truncated.omitted_bytes,
        truncation: truncated.truncation,
      });
    }
    const triggers = input.triggers ?? [];
    const envelope = {
      envelope_version: ENVELOPE_VERSION,
      gate_id: input.gateId,
      mission_id: input.missionId,
      chain_id: input.chainId,
      policy_version: input.policyVersion,
      seat: input.seat ?? null,
      triggers,
      sampled: triggers.some((t) => t && t.id === "T12"),
      mandatory: triggers.some((t) => t && t.id !== "T12"),
      container: input.container,
      base_sha: input.baseSha,
      change_scope: input.changeScope,
      items,
      prior_verdicts: input.priorVerdicts ?? [],
      omissions,
    };
    // The materializer's minimum is measured over the COMPLETE returned
    // serialization: the zero-content envelope plus its 64-hex
    // `envelope_sha256` field (deterministic placeholder, byte-identical
    // length to the real hash).
    return Buffer.byteLength(canonicalJson({ ...envelope, envelope_sha256: "f".repeat(64) }));
  }

  function oversizedItems() {
    return ENVELOPE_ROLES.map((role, i) => ({
      role,
      source: `source-${i}`,
      content: "z".repeat(60000),
      path: `evidence/${role}.md`,
    }));
  }

  it("the metadata boundary is sub-default and byte-counted from the canonical serialization", () => {
    const input = baseEnvelopeInput({ items: oversizedItems() });
    const metadataBytes = metadataOnlyBytes(input);
    const boundary = zeroContentBoundaryBytes(input);
    assert.ok(Number.isInteger(metadataBytes) && metadataBytes > 0);
    assert.ok(Number.isInteger(boundary) && boundary > metadataBytes, "zero-content item records and omissions sit above the pure metadata floor");
    assert.ok(boundary < DEFAULT_ENVELOPE_MAX_BYTES, "the boundary must be sub-default for this contract to bite");
  });

  it("a sub-default cap one byte below the metadata boundary is unsatisfiable and fails closed", () => {
    const input = baseEnvelopeInput({ items: oversizedItems() });
    const boundary = zeroContentBoundaryBytes(input);
    const writer = captureWriter();
    assert.throws(
      () => buildAuditEnvelope({ ...input, envelopeMaxBytes: boundary - 1, writeFile: writer.writeFile }),
      (err) => {
        assert.ok(err && typeof err === "object", "the failure must be a coded Error");
        assert.equal(err.code, "envelope-metadata-over-budget");
        assert.match(err.message, /envelope-metadata-over-budget/);
        assert.match(err.message, /no item reduction can satisfy the cap/);
        // The error's own minimum-byte count equals the measured boundary.
        assert.match(err.message, new RegExp(`serializes to ${boundary} bytes`));
        assert.match(err.message, new RegExp(`envelope budget of ${boundary - 1} bytes`));
        return true;
      },
    );
    // Fail closed BEFORE any materialization: no partial evidence tree.
    assert.equal(writer.files.size, 0, "a fail-closed envelope must never materialize evidence");
  });

  it("a sub-default cap above the metadata boundary reduces item content deterministically until the complete serialization fits", () => {
    const input = baseEnvelopeInput({ items: oversizedItems() });
    const totalOriginal = input.items.reduce((n, i) => n + Buffer.byteLength(i.content, "utf8"), 0);
    const boundary = zeroContentBoundaryBytes(input);
    const cap = boundary + 4096;
    assert.ok(cap < DEFAULT_ENVELOPE_MAX_BYTES, "test precondition: the satisfiable cap is still sub-default");

    const a = buildAuditEnvelope({ ...input, envelopeMaxBytes: cap });
    const b = buildAuditEnvelope({ ...input, envelopeMaxBytes: cap });

    // The COMPLETE canonical seat-visible serialization fits the literal cap.
    const bytes = Buffer.byteLength(canonicalJson(a));
    assert.ok(bytes <= cap, `complete seat-visible envelope is ${bytes} bytes, exceeding the ${cap}-byte literal cap`);
    assert.ok(a.omissions.length >= 1, "the reduction must be recorded as omissions, never silent");
    // Nothing was silently dropped: every original byte is kept or named as omitted.
    const kept = a.items.reduce((n, i) => n + i.bytes, 0);
    const omitted = a.omissions.reduce((n, o) => n + o.omitted_bytes, 0);
    assert.equal(kept + omitted, totalOriginal);
    for (const omission of a.omissions) {
      assert.ok(omission.role && omission.path);
      assert.ok(Number.isInteger(omission.omitted_bytes) && omission.omitted_bytes > 0);
      assert.equal(omission.truncation, "head+tail");
    }
    // Provenance survives verbatim — the reduction touches item content only.
    assert.deepEqual(a.change_scope, input.changeScope);
    assert.deepEqual(a.prior_verdicts, input.priorVerdicts);
    assert.deepEqual(a.triggers, input.triggers);
    assert.deepEqual(a.seat, input.seat);
    assert.equal(a.container, input.container);
    assert.equal(a.base_sha, input.baseSha);
    // Deterministic: identical inputs -> identical envelope, omissions, hash.
    assert.deepEqual(a, b);
    assert.equal(a.envelope_sha256, b.envelope_sha256);
  });

  // -------------------------------------------------------------------------
  // Finding 3 — the literal cap counts the envelope_sha256 it delivers
  // -------------------------------------------------------------------------

  it("the reproduced default-cap boundary never returns an over-cap envelope (the cap counts envelope_sha256)", () => {
    const cap = DEFAULT_ENVELOPE_MAX_BYTES;
    // Reproduced defect window (pre-fix): a change_scope payload of these
    // sizes makes the hash-less envelope serialize to 262141-262144 bytes —
    // within the literal 262144-byte cap — while the RETURNED envelope (plus
    // envelope_sha256) was 262226-262229 bytes.  Reproduce the exact window
    // and assert every terminal is legal: a returned envelope must satisfy
    // Buffer.byteLength(canonicalJson(returnedEnvelope)) <= envelopeMaxBytes,
    // and an unsatisfiable window must fail closed — never an over-cap return.
    for (const scopeSize of [261551, 261552, 261553, 261554]) {
      const changeScope = { formatVersion: 1, resolved: { big: "y".repeat(scopeSize) }, paths: {} };
      const input = baseEnvelopeInput({
        changeScope,
        items: [{ role: "worker_report", source: "s", content: "zz", path: "evidence/worker.md" }],
        envelopeMaxBytes: cap,
      });
      try {
        const envelope = buildAuditEnvelope(input);
        const bytes = Buffer.byteLength(canonicalJson(envelope));
        assert.ok(
          bytes <= cap,
          `returned envelope is ${bytes} bytes at the literal ${cap}-byte cap — the cap must count the hash field it delivers`,
        );
        // The hash definition is unchanged: envelope_sha256 still binds the
        // canonical hash-less envelope.
        const hashless = { ...envelope };
        delete hashless.envelope_sha256;
        assert.equal(envelope.envelope_sha256, sha256(canonicalJson(hashless)));
      } catch (err) {
        // Fail closed is the other legal terminal: this window's metadata
        // cannot free the 84 hash-field bytes, so no item reduction can
        // satisfy the cap.  It must NEVER return an over-cap envelope.
        assert.ok(err && typeof err === "object", "the failure must be a coded Error");
        assert.equal(err.code, "envelope-metadata-over-budget");
      }
    }
  });

  it("omitting envelopeMaxBytes uses DEFAULT_ENVELOPE_MAX_BYTES and the final returned envelope including its hash fits it", () => {
    // Fitting default-capped build: oversized items plus a large change_scope,
    // with the caller cap OMITTED.  DEFAULT_ENVELOPE_MAX_BYTES applies
    // literally to the returned envelope (hash included).
    const input = baseEnvelopeInput({
      changeScope: { formatVersion: 1, resolved: { big: "y".repeat(40000) }, paths: {} },
      items: ENVELOPE_ROLES.map((role, i) => ({
        role,
        source: `source-${i}`,
        content: "z".repeat(60000),
        path: `evidence/${role}.md`,
      })),
    });
    delete input.envelopeMaxBytes;
    const envelope = buildAuditEnvelope(input);
    const bytes = Buffer.byteLength(canonicalJson(envelope));
    assert.ok(
      bytes <= DEFAULT_ENVELOPE_MAX_BYTES,
      `omitted-cap envelope is ${bytes} bytes, exceeding the ${DEFAULT_ENVELOPE_MAX_BYTES}-byte default budget`,
    );
    // The budget placeholder serializes byte-identically to the real hash.
    const hashless = { ...envelope };
    delete hashless.envelope_sha256;
    assert.equal(
      Buffer.byteLength(canonicalJson({ ...hashless, envelope_sha256: "f".repeat(64) })),
      bytes,
      "the 64-hex budget placeholder must serialize to the same length as the real hash",
    );
    assert.equal(envelope.envelope_sha256, sha256(canonicalJson(hashless)));
    // Omitting the cap is byte-identical to an explicit default.
    const explicit = buildAuditEnvelope({ ...input, envelopeMaxBytes: DEFAULT_ENVELOPE_MAX_BYTES });
    assert.deepEqual(envelope, explicit);
    // The same default-omission contract holds at the reproduced defect
    // window: the default is used literally, so the terminal is legal (fits
    // or fails closed) — never an over-cap return.
    const windowInput = baseEnvelopeInput({
      changeScope: { formatVersion: 1, resolved: { big: "y".repeat(261553) }, paths: {} },
      items: [{ role: "worker_report", source: "s", content: "zz", path: "evidence/worker.md" }],
    });
    delete windowInput.envelopeMaxBytes;
    let omitted;
    try {
      omitted = buildAuditEnvelope(windowInput);
    } catch (err) {
      omitted = err && typeof err === "object" ? err.code : String(err);
    }
    let explicitDefault;
    try {
      explicitDefault = buildAuditEnvelope({
        ...windowInput,
        envelopeMaxBytes: DEFAULT_ENVELOPE_MAX_BYTES,
      });
    } catch (err) {
      explicitDefault = err && typeof err === "object" ? err.code : String(err);
    }
    assert.deepEqual(omitted, explicitDefault, "the omitted cap must behave exactly like the explicit default");
    if (omitted && typeof omitted === "object") {
      assert.ok(
        Buffer.byteLength(canonicalJson(omitted)) <= DEFAULT_ENVELOPE_MAX_BYTES,
        "the default-omitted window envelope must fit the default cap",
      );
    }
  });
});
