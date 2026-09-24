// luna-brief-corrections.test.mjs — acceptance tests for the pure
// `renderBriefCorrections(record)` renderer (bounded inner-brief correction
// feedback, frozen behavior criteria 1-2 and 4).
//
// Frozen contract under test (the renderer half):
//
//   - criterion 1: corrections are persisted as structured
//     `briefCorrectionsDetails` entries carrying a timestamp, the original
//     coordinator action, and the deterministic validator detail.  The
//     renderer reads ONLY those entries — it is pure and deterministic
//     (no I/O, no clock, no randomness).
//   - criterion 2: `renderBriefCorrections(record)` exposes only the LAST
//     <=3 unique-by-detail corrections; every exposed correction is bounded
//     to <=1200 UTF-8 bytes (truncation never splits a UTF-8 code point);
//     C0 control characters are stripped while useful line breaks (`\n`) are
//     preserved; the output is the empty string when there are no
//     corrections.
//   - criterion 4: arbitrary `coordinatorErrorsDetails`, probe output, tool
//     output, and exception messages are NEVER rendered — correction detail
//     is driver-generated validator output only.
//
// Assumed readings (the criteria name the surface but not field names or
// rendering order; the readings below are the natural ones consistent with
// the existing `coordinatorErrorsDetails` shape and are what these tests
// pin):
//   - an entry is `{ at: <ISO timestamp>, action: <string>, detail: <string> }`
//     (the same `at`/`detail` names the existing coordinator-error details
//     already use, plus `action`);
//   - "unique-by-detail" keeps the LAST occurrence of each distinct detail
//     (older duplicates are the stale ones the bounded window must drop) and
//     the remaining window renders in record order;
//   - "last <=3" then keeps the three most recent unique details;
//   - the only preserved C0 control is `\n` (`\r`, `\t`, and every other
//     U+0000..U+001F control is stripped).
//
// The module does not exist on pristine main, so the guarded dynamic import
// below turns the missing export into a per-test behavior assertion (the
// feature is missing), never an import error.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

let renderBriefCorrections = null;
async function loadRenderer() {
  if (renderBriefCorrections !== null) return renderBriefCorrections;
  try {
    const mod = await import("./luna-prompt.mjs");
    if (typeof mod.renderBriefCorrections === "function") {
      renderBriefCorrections = mod.renderBriefCorrections;
    }
  } catch {
    // The module import itself must never fail these tests — only the
    // missing export turns the load into the baseline-red signal.
    renderBriefCorrections = null;
  }
  return renderBriefCorrections;
}

function assertRendererExists(render, where) {
  assert.ok(
    render,
    `${where}: renderBriefCorrections is not exported by luna-prompt.mjs yet — ` +
      "the bounded brief-correction feedback renderer is missing (baseline-red: the feature does not exist).",
  );
}

/** Count non-overlapping occurrences of a substring. */
const occurrences = (text, needle) => text.split(needle).length - 1;

const AT = "2026-09-23T00:00:00.000Z";
const entry = (detail, action = "run_chain") => ({ at: AT, action, detail });

describe("renderBriefCorrections(record) — the pure bounded brief-correction renderer (criteria 1-2, 4)", () => {
  it("renders empty text when there are no corrections (criterion 2)", async () => {
    const render = await loadRenderer();
    assertRendererExists(render, "empty record");
    assert.equal(render({}), "", "a record without corrections must render empty text");
    assert.equal(render({ briefCorrectionsDetails: [] }), "", "an empty details array must render empty text");
    assert.equal(
      render({ briefCorrectionsDetails: "not-an-array" }),
      "",
      "a malformed details field must render empty text, never throw",
    );
    assert.equal(
      render({ briefCorrectionsDetails: null }),
      "",
      "a null details field must render empty text, never throw",
    );
  });

  it("renders a single correction's validator detail, preserving its line breaks (criterion 2)", async () => {
    const render = await loadRenderer();
    assertRendererExists(render, "single multiline correction");
    const detail = [
      "run_chain refused: the inner chain brief fails deterministic validation",
      "brief rejected before dispatch: 1 problem found (kusabi #289). Nothing was started; fix the brief and re-run.",
      "  - `## Deliverables` is absent or parses to zero entries: the deliverables probe reads that section, and a round that changes none of the files it names is discarded. Add the section and list the files that must change, one per bullet, each path backtick-quoted.",
    ].join("\n");
    const out = render({ briefCorrectionsDetails: [entry(detail)] });
    assert.ok(
      out.includes("run_chain refused: the inner chain brief fails deterministic validation"),
      "the rendered correction must carry the validator detail",
    );
    assert.ok(
      out.includes("is absent or parses to zero entries"),
      "the rendered correction must carry the actionable validator detail",
    );
    assert.ok(
      out.includes("\n  - `## Deliverables`"),
      "the rendered correction must preserve the detail's useful line breaks",
    );
    assert.equal(
      occurrences(out, "run_chain refused: the inner chain brief fails deterministic validation"),
      1,
      "a single correction must render exactly once",
    );
  });

  it("dedupes repeated details to their most recent occurrence (criterion 2)", async () => {
    const render = await loadRenderer();
    assertRendererExists(render, "dedupe");
    const out = render({
      briefCorrectionsDetails: [entry("CORR-A"), entry("CORR-B"), entry("CORR-A")],
    });
    assert.equal(occurrences(out, "CORR-A"), 1, "the repeated detail must render exactly once");
    assert.equal(occurrences(out, "CORR-B"), 1, "the distinct detail must render exactly once");
    assert.ok(
      out.indexOf("CORR-B") < out.indexOf("CORR-A"),
      "the LAST occurrence of CORR-A wins — the window must read B then A, not A then B",
    );
  });

  it("exposes only the last three unique-by-detail corrections (criterion 2)", async () => {
    const render = await loadRenderer();
    assertRendererExists(render, "last-three window");
    const out = render({
      briefCorrectionsDetails: [entry("CORR-A"), entry("CORR-B"), entry("CORR-C"), entry("CORR-D")],
    });
    for (const kept of ["CORR-B", "CORR-C", "CORR-D"]) {
      assert.ok(out.includes(kept), `the last-three window must keep ${kept}`);
      assert.equal(occurrences(out, kept), 1, `${kept} must render exactly once`);
    }
    assert.ok(!out.includes("CORR-A"), "the oldest correction must fall outside the last-three window");
  });

  it("a stale duplicate inside the raw window does not occupy a window slot (criterion 2)", async () => {
    const render = await loadRenderer();
    assertRendererExists(render, "dedupe inside the window");
    const out = render({
      briefCorrectionsDetails: [entry("CORR-A"), entry("CORR-B"), entry("CORR-C"), entry("CORR-A"), entry("CORR-A")],
    });
    // Unique-by-detail keeps the last occurrence of each detail: B, C, then A
    // (A's last occurrence is the newest) — the window is [B, C, A], and the
    // repeated A's must not consume two slots.
    assert.equal(occurrences(out, "CORR-A"), 1, "the repeated detail must occupy exactly one window slot");
    assert.equal(occurrences(out, "CORR-B"), 1, "CORR-B must be kept");
    assert.equal(occurrences(out, "CORR-C"), 1, "CORR-C must be kept");
    assert.ok(
      out.indexOf("CORR-B") < out.indexOf("CORR-C") && out.indexOf("CORR-C") < out.indexOf("CORR-A"),
      "the window must render the last-occurrence order B, C, A",
    );
  });

  it("bounds every correction to 1200 UTF-8 bytes (criterion 2)", async () => {
    const render = await loadRenderer();
    assertRendererExists(render, "byte bound");
    const out = render({
      briefCorrectionsDetails: [entry("a".repeat(5000))],
    });
    assert.ok(
      Buffer.byteLength(out, "utf8") <= 1200,
      `a 5000-byte correction must be bounded to <=1200 UTF-8 bytes, got ${Buffer.byteLength(out, "utf8")}`,
    );
  });

  it("passes a correction that fits the bound with margin through untouched (criterion 2)", async () => {
    const render = await loadRenderer();
    assertRendererExists(render, "pass-through");
    // A 1000-byte detail fits the 1200-byte bound with room even for a small
    // per-correction format prefix; content within the bound must not be
    // degraded.
    const detail = "b".repeat(1000);
    const out = render({ briefCorrectionsDetails: [entry(detail)] });
    assert.ok(
      out.includes(detail),
      "a correction that fits the 1200-byte bound with margin must pass through un-degraded",
    );
  });

  it("never splits a UTF-8 code point when bounding (criterion 2)", async () => {
    const render = await loadRenderer();
    assertRendererExists(render, "UTF-8 boundary");
    const out = render({
      briefCorrectionsDetails: [entry("漢".repeat(800))], // 800 * 3 bytes = 2400 bytes
    });
    assert.ok(
      Buffer.byteLength(out, "utf8") <= 1200,
      `a multibyte correction must be bounded to <=1200 UTF-8 bytes, got ${Buffer.byteLength(out, "utf8")}`,
    );
    assert.ok(!out.includes("\uFFFD"), "the bound must never leave a broken (replacement-char) code point");
    assert.equal(
      Buffer.from(out, "utf8").toString("utf8"),
      out,
      "the bounded output must round-trip as valid UTF-8",
    );
  });

  it("strips C0 control characters while preserving useful line breaks (criterion 2)", async () => {
    const render = await loadRenderer();
    assertRendererExists(render, "C0 stripping");
    const detail = "line-1\nline-2\x00\x01\x1b\x08\x0c\x07line-3\r\nline-4\tend";
    const out = render({ briefCorrectionsDetails: [entry(detail)] });
    for (const stripped of ["\x00", "\x01", "\x1b", "\x08", "\x0c", "\x07", "\r", "\t"]) {
      assert.ok(!out.includes(stripped), `the C0 control ${JSON.stringify(stripped)} must be stripped`);
    }
    assert.ok(out.includes("line-1\nline-2"), "the first line break must be preserved");
    assert.ok(out.includes("line-3\nline-4"), "the \\r\\n line break must normalize to the preserved \\n");
    assert.ok(out.includes("line-4") && out.includes("end"), "the trailing content must survive the strip");
  });

  it("never renders coordinatorErrorsDetails, probe output, tool output, or exception messages (criterion 4)", async () => {
    const render = await loadRenderer();
    assertRendererExists(render, "criterion 4");
    const out = render({
      briefCorrectionsDetails: [entry("REAL-VALIDATOR-DETAIL")],
      coordinatorErrorsDetails: [
        { at: AT, detail: "coordinator stream invalid: SECRET-ERROR-TEXT" },
        { at: AT, detail: "coordinator dispatch failed: SECRET-EXCEPTION-TEXT" },
      ],
      probes: [{ action: "read_probe", output: "SECRET-PROBE-TEXT" }],
      attempts: [{ output: "SECRET-ATTEMPT-TEXT" }],
      chains: ["chain-secret"],
    });
    assert.ok(out.includes("REAL-VALIDATOR-DETAIL"), "the validator detail must be rendered");
    for (const forbidden of [
      "SECRET-ERROR-TEXT",
      "SECRET-EXCEPTION-TEXT",
      "SECRET-PROBE-TEXT",
      "SECRET-ATTEMPT-TEXT",
      "chain-secret",
    ]) {
      assert.ok(
        !out.includes(forbidden),
        `arbitrary ${forbidden} must never be rendered — correction detail is validator output only`,
      );
    }
  });

  it("skips malformed entries safely without throwing (criterion 2 robustness)", async () => {
    const render = await loadRenderer();
    assertRendererExists(render, "malformed entries");
    const out = render({
      briefCorrectionsDetails: [
        { at: AT, action: "run_chain" }, // no detail
        { at: AT, action: "run_chain", detail: "" }, // empty detail
        { at: AT, action: "run_chain", detail: 42 }, // non-string detail
        "garbage",
        null,
      ],
    });
    assert.equal(out, "", "entries without a usable string detail must contribute nothing");
  });
});