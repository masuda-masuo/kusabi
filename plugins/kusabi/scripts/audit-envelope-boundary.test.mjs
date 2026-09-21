// audit-envelope-boundary.test.mjs — regression oracle for the kusabi #529
// word-flanked secret scrubbing finding (independent review F2,
// job-muavz7j8ef8c).  Baseline-red on the accepted #529 worktree: the frozen
// audit-envelope.test.mjs pins the scrubbing contract with space-flanked
// tokens, and this file pins the BOUNDARY case the review found.
//
// `\b` word edges around the token shapes let values flanked by word
// characters — `xxxxxxxxxxghp_<36 alnum>yyyyyyyyyy` — survive scrubbing and
// reach materialized evidence plus the item sha256.  Recognized token shapes
// (known prefix + required length) must be removed even when adjacent to word
// characters, without broadening into arbitrary-string scrubbing.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { scrubSecrets, buildAuditEnvelope } from "./audit-envelope.mjs";

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
    missionId: "mission-529-boundary",
    chainId: "chain-529-boundary",
    policyVersion: 1,
    seat: { provider: "codex", model: "gpt-5.6-sol", reasoning_effort: "high", substituted: false },
    triggers: [{ id: "T6", detail: "tests deleted or weakened" }],
    container: "cid-boundary",
    baseSha: "731f547",
    changeScope: { added: [], deleted: [], modified: [] },
    items: [],
    priorVerdicts: [],
    envelopeMaxBytes: 262144,
    allowSubstitute: false,
    ...overrides,
  };
}

// Word characters on BOTH sides of each recognized token shape — the case the
// \b-boundary scrubber let through (the review's exact GitHub example).
const WORD_FLANKED_GITHUB = `xxxxxxxxxxghp_${"a".repeat(36)}yyyyyyyyyy`;
const WORD_FLANKED_OPENAI = `wwwwwwwwwwsk-${"b".repeat(48)}zzzzzzzzzz`;
const WORD_FLANKED_BEARER = `vvvvvvvvvvBearer ${"c".repeat(40)}wwwwwwwwww`;
const WORD_FLANKED_PRIVATE_KEY =
  "qqqqqqqqqq-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt\n-----END PRIVATE KEY-----rrrrrrrrrr";

describe("scrubSecrets — word-flanked token shapes (kusabi #529 F2 boundary)", () => {
  it("scrubs a GitHub PAT flanked by word characters on both sides", () => {
    const out = scrubSecrets(WORD_FLANKED_GITHUB);
    assert.ok(!out.includes("ghp_"), `ghp_ shape survived scrubbing: ${JSON.stringify(out)}`);
    assert.ok(!/ghp_[A-Za-z0-9]{36}/.test(out), "a full ghp_ token shape remains");
    assert.ok(out.includes("[REDACTED]"), "the scrubbed span must become the placeholder");
  });

  it("scrubs an OpenAI key flanked by word characters on both sides", () => {
    const out = scrubSecrets(WORD_FLANKED_OPENAI);
    assert.ok(!out.includes("sk-"), `sk- shape survived scrubbing: ${JSON.stringify(out)}`);
    assert.ok(!/sk-[A-Za-z0-9]{48}/.test(out), "a full sk- token shape remains");
    assert.ok(out.includes("[REDACTED]"), "the scrubbed span must become the placeholder");
  });

  it("scrubs a Bearer authorization value flanked by word characters on both sides", () => {
    const out = scrubSecrets(WORD_FLANKED_BEARER);
    assert.ok(!out.includes("Bearer "), `Bearer shape survived scrubbing: ${JSON.stringify(out)}`);
    assert.ok(!/Bearer [0-9a-f]{40}/.test(out), "a full Bearer value shape remains");
    assert.ok(out.includes("[REDACTED]"), "the scrubbed span must become the placeholder");
  });

  it("scrubs a PEM private-key block flanked by word characters", () => {
    const out = scrubSecrets(WORD_FLANKED_PRIVATE_KEY);
    assert.ok(!out.includes("BEGIN PRIVATE KEY"), "the private key block survived flanked by word characters");
    assert.ok(!out.includes("END PRIVATE KEY"), "the private key terminator survived");
    assert.ok(out.includes("[REDACTED]"), "the scrubbed block must become the placeholder");
  });
});

describe("buildAuditEnvelope — word-flanked credentials never reach evidence (kusabi #529 F2 boundary)", () => {
  it("materialized output carries only [REDACTED] placeholders, no raw word-flanked shape", () => {
    const content = [
      WORD_FLANKED_GITHUB,
      WORD_FLANKED_OPENAI,
      WORD_FLANKED_BEARER,
      WORD_FLANKED_PRIVATE_KEY,
      "Rest of the issue body.",
    ].join("\n");
    const items = [{ role: "issue", source: "file:.kusabi/issue-529.md", content, path: "evidence/issue.md" }];
    const writer = captureWriter();
    const envelope = buildAuditEnvelope(baseEnvelopeInput({ items, writeFile: writer.writeFile }));

    const written = writer.files.get("evidence/issue.md");
    assert.ok(written, "the scrubbed evidence is what the seat reads");
    for (const raw of [WORD_FLANKED_GITHUB, WORD_FLANKED_OPENAI, WORD_FLANKED_BEARER, WORD_FLANKED_PRIVATE_KEY]) {
      assert.ok(!written.includes(raw), `raw word-flanked shape reached materialized evidence: ${raw.slice(0, 16)}...`);
      assert.ok(!JSON.stringify(envelope).includes(raw), "a word-flanked credential leaked into the envelope record");
    }
    // No token-shaped remnant survives, flanked or not.
    assert.ok(!/ghp_[A-Za-z0-9]{36}/.test(written));
    assert.ok(!/sk-[A-Za-z0-9]{48}/.test(written));
    assert.ok(!/Bearer [0-9a-f]{40}/.test(written));
    assert.ok(!written.includes("BEGIN PRIVATE KEY"));
  });

  it("the item sha256 binds the SCRUBBED bytes, not the raw word-flanked ones", () => {
    const content = [WORD_FLANKED_GITHUB, WORD_FLANKED_OPENAI, WORD_FLANKED_BEARER].join("\n");
    const items = [{ role: "issue", source: "s", content, path: "evidence/issue.md" }];
    const writer = captureWriter();
    const envelope = buildAuditEnvelope(baseEnvelopeInput({ items, writeFile: writer.writeFile }));
    const written = writer.files.get("evidence/issue.md");
    const item = envelope.items[0];
    assert.equal(item.sha256, sha256(written), "the item hash must bind the materialized (scrubbed) bytes");
    assert.notEqual(item.sha256, sha256(content), "the item hash must NOT bind the raw credential-bearing bytes");
  });

  it("ordinary evidence text is not over-scrubbed by the boundary-safe patterns", () => {
    const content = "Plain issue body with no credentials inside; the bearer of this note owes 0xabcdef0123456789.";
    assert.equal(scrubSecrets(content), content, "ordinary prose must pass through verbatim");
  });
});