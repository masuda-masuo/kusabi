// brief-signature-stamp.test.mjs — acceptance tests for the pure inner-brief
// signature stamper (deterministic inner-brief metadata, decision 1-2).
//
// Frozen acceptance contract (task: "deterministic Luna inner-brief metadata
// and contract", decisions 1-3, 6):
//
//   - the deterministic driver, not Luna, owns the inner brief signature:
//     before every run_chain / rework_chain, ANY `Orchestrator:` line
//     occurring in the first five lines is stripped and exactly one canonical
//     line is prepended as line 1;
//   - the canonical line is `Orchestrator: <model> | session <session> |
//     <date>` with the canonical values supplied by the caller (model =
//     coordinator.actual, session = missionId, date = the dispatch's UTC
//     YYYY-MM-DD) — the stamper itself computes nothing;
//   - the remaining content is byte-stable: apart from the removed first-five
//     signature line(s) and the leading insertion, every other line keeps its
//     exact bytes and relative order — in particular the original line 6 is
//     untouched as content, even when a signature sat at line 5;
//   - the stamped brief carries EXACTLY ONE canonical first-line signature;
//   - stamping is deterministic metadata enrichment ONLY: it never repairs
//     missing Deliverables, invalid Smoke, invalid Frozen Tests or any other
//     semantic defect (the driver tests pin that separately).
//
// The pinned API: `stampInnerBriefSignature(briefText, { model, session,
// date })` exported from brief-parsing.mjs (the pure brief-text module that
// already owns parseOrchestratorSignature, so the strip rule and the parse
// rule cannot drift apart).  It returns the stamped brief text as a string.
//
// Baseline: the export does not exist yet, so the first assertion of each
// test fails with "must exist on brief-parsing.mjs" — a behavioral red (the
// feature is missing), never an import error (the namespace import below).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

let briefParsing = null;
async function briefParsingModule() {
  if (briefParsing === null) {
    briefParsing = await import("./brief-parsing.mjs");
  }
  return briefParsing;
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const CANONICAL = { model: "gpt-5.6-luna", session: "mission-inner-123", date: "2026-09-23" };
const canonicalLine = (o = CANONICAL) => `Orchestrator: ${o.model} | session ${o.session} | ${o.date}`;

/** A Luna-authored (non-canonical) signature line. */
const straySignature = (model = "gpt-5.6-sol", session = "luna-inner", date = "2026-09-21") =>
  `Orchestrator: ${model} | session ${session} | ${date}`;

/** Assert the stamped text has exactly one Orchestrator: line among its first five lines. */
function assertSingleCanonicalFirstLine(stamped, label) {
  const lines = stamped.split("\n");
  const signatureLines = lines.slice(0, 5).filter((l) => l.trim().startsWith("Orchestrator:"));
  assert.equal(signatureLines.length, 1, `${label}: exactly one canonical first-line signature expected`);
  assert.equal(signatureLines[0], lines[0], `${label}: the single signature must be line 1`);
}

// ---------------------------------------------------------------------------
// pure stamper
// ---------------------------------------------------------------------------

describe("stampInnerBriefSignature (pure inner-brief signature stamper)", () => {
  it("stamps an ABSENT signature: exactly one canonical line 1, remaining content byte-stable", async () => {
    const { stampInnerBriefSignature } = await briefParsingModule();
    assert.equal(
      typeof stampInnerBriefSignature,
      "function",
      "stampInnerBriefSignature must exist on brief-parsing.mjs (feature missing on base)",
    );

    const input = [
      "## Deliverables",
      "",
      "- `plugins/kusabi/scripts/luna-wait.mjs` — the #530 wait surface.",
      "",
      "## Smoke",
      "",
      "- `node --test plugins/kusabi/scripts/luna-wait.test.mjs`",
    ].join("\n");

    const stamped = stampInnerBriefSignature(input, CANONICAL);
    const lines = stamped.split("\n");
    assert.equal(lines[0], canonicalLine(), "the canonical signature must be line 1");
    assert.equal(
      lines.slice(1).join("\n"),
      input,
      "remaining content must be byte-stable apart from the leading insertion",
    );
    assertSingleCanonicalFirstLine(stamped, "absent-signature input");
  });

  it("strips an existing signature at line 1 and prepends the canonical line", async () => {
    const { stampInnerBriefSignature } = await briefParsingModule();
    assert.equal(
      typeof stampInnerBriefSignature,
      "function",
      "stampInnerBriefSignature must exist on brief-parsing.mjs (feature missing on base)",
    );

    const input = [
      straySignature("gpt-5.6-sol", "luna-inner", "2026-09-21"), // line 1 — stripped
      "",
      "## Deliverables",
      "",
      "- `plugins/kusabi/scripts/a.mjs`",
    ].join("\n");

    const stamped = stampInnerBriefSignature(input, CANONICAL);
    assert.equal(stamped, [canonicalLine(), ...input.split("\n").slice(1)].join("\n"),
      "the canonical line replaces the line-1 signature; everything below is byte-stable");
    assertSingleCanonicalFirstLine(stamped, "line-1 signature input");
  });

  it("strips a signature at line 5; the original line 6 is untouched as content", async () => {
    const { stampInnerBriefSignature } = await briefParsingModule();
    assert.equal(
      typeof stampInnerBriefSignature,
      "function",
      "stampInnerBriefSignature must exist on brief-parsing.mjs (feature missing on base)",
    );

    const contentLine = "line six must survive byte-for-byte";
    const input = [
      "## Deliverables",
      "",
      "- `plugins/kusabi/scripts/a.mjs`",
      "",
      straySignature("gpt-5.6-sol", "stray", "2026-09-21"), // line 5 — stripped (inside first five)
      contentLine,                                          // line 6 — content, untouched
    ].join("\n");

    const stamped = stampInnerBriefSignature(input, CANONICAL);
    const lines = stamped.split("\n");
    assert.equal(lines[0], canonicalLine(), "the canonical signature must be line 1");
    assert.equal(lines[5], contentLine, "the original line 6 must be untouched as content");
    assert.equal(
      stamped,
      [canonicalLine(), ...input.split("\n").filter((_, i) => i !== 4)].join("\n"),
      "byte-stable: canonical line + all original lines except the stripped line-5 signature",
    );
    assertSingleCanonicalFirstLine(stamped, "line-5 signature input");
  });

  it("strips signatures at lines 1 AND 5; exactly one canonical line; line 6 untouched", async () => {
    const { stampInnerBriefSignature } = await briefParsingModule();
    assert.equal(
      typeof stampInnerBriefSignature,
      "function",
      "stampInnerBriefSignature must exist on brief-parsing.mjs (feature missing on base)",
    );

    const contentLine = "content line six";
    const input = [
      straySignature("gpt-5.6-sol", "first", "2026-09-21"), // line 1 — stripped
      "",
      "## Deliverables",
      "",
      straySignature("gpt-5.6-opencode", "second", "2026-09-21"), // line 5 — stripped
      contentLine,                                                // line 6 — content, untouched
      "",
      "## Smoke",
      "",
      "- `node --test`",
    ].join("\n");

    const stamped = stampInnerBriefSignature(input, CANONICAL);
    const lines = stamped.split("\n");
    assert.equal(lines[0], canonicalLine(), "the canonical signature must be line 1");
    assert.equal(lines[4], contentLine, "the original line 6 must be untouched as content");
    const kept = input.split("\n").filter((_, i) => i !== 0 && i !== 4);
    assert.equal(
      stamped,
      [canonicalLine(), ...kept].join("\n"),
      "byte-stable: canonical line + all original lines except the two stripped signatures",
    );
    assertSingleCanonicalFirstLine(stamped, "lines 1+5 signature input");
  });

  it("a signature at line 6 (outside the first five) is CONTENT, not stripped", async () => {
    const { stampInnerBriefSignature } = await briefParsingModule();
    assert.equal(
      typeof stampInnerBriefSignature,
      "function",
      "stampInnerBriefSignature must exist on brief-parsing.mjs (feature missing on base)",
    );

    const input = [
      "## Deliverables",
      "",
      "- `plugins/kusabi/scripts/a.mjs`",
      "",
      "## Smoke",
      straySignature("gpt-5.6-sol", "content", "2026-09-21"), // line 6 — OUTSIDE the first five
    ].join("\n");

    const stamped = stampInnerBriefSignature(input, CANONICAL);
    const lines = stamped.split("\n");
    assert.equal(lines[0], canonicalLine(), "the canonical signature must be line 1");
    assert.equal(
      lines[6],
      straySignature("gpt-5.6-sol", "content", "2026-09-21"),
      "a line-6 Orchestrator line is content and must be preserved verbatim",
    );
    assert.equal(
      stamped,
      [canonicalLine(), ...input.split("\n")].join("\n"),
      "byte-stable: canonical line + every original line (nothing in the first five was stripped)",
    );
    assertSingleCanonicalFirstLine(stamped, "line-6 signature input");
  });

  it("the stamped canonical line parses back to the canonical orchestrator record", async () => {
    const { stampInnerBriefSignature, parseOrchestratorSignature } = await briefParsingModule();
    assert.equal(
      typeof stampInnerBriefSignature,
      "function",
      "stampInnerBriefSignature must exist on brief-parsing.mjs (feature missing on base)",
    );

    const input = "## Deliverables\n\n- `plugins/kusabi/scripts/a.mjs`\n";
    const stamped = stampInnerBriefSignature(input, CANONICAL);
    assert.deepEqual(
      parseOrchestratorSignature(stamped),
      { model: CANONICAL.model, session: CANONICAL.session, date: CANONICAL.date },
      "parseOrchestratorSignature on the stamped brief must recover exactly the canonical values",
    );
    assert.equal(
      stamped.slice(stamped.indexOf("\n") + 1),
      input,
      "the content after line 1 must be byte-identical to the input",
    );
  });
});