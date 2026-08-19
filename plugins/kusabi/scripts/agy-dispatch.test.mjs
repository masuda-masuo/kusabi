// agy-dispatch.test.mjs — tests for the Antigravity CLI dispatch backend
// (kusabi #199).
//
// Spawn-based tests follow the claude-dispatch.test.mjs / serve-lifecycle
// pattern: the binary is resolved through AGY_BIN, so tests point it at a
// fake `agy` script written into a temp dir, with KUSABI_STATE_DIR pointing
// at a temp fixture.  THE REAL `agy` BINARY IS NEVER REQUIRED — it is a WSL
// host install that exists in neither CI nor the dev container, so a test
// that needed it would be a test that never runs.
//
// Every fake payload below is the SHAPE the real CLI was field-verified to
// print (single JSON object on stdout, the five usage counters, the
// `status` field that is not authoritative).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

import {
  AGY_DEFAULT_CHAIN,
  agyBin,
  validateAgyModel,
  validateAgyChain,
  resolveAgyModel,
  agyJsonSchemaFor,
  buildAgyPrompt,
  buildAgyArgs,
  AGY_PRINT_TIMEOUT_MARGIN_S,
  formatGoDuration,
  AGY_MAX_ARG_STRLEN,
  AGY_MAX_ARG_BYTES,
  checkAgyArgvSize,
  parseAgyResult,
  agyPayload,
  describeAgyResult,
  mapAgyUsage,
  assertNoAgySession,
  agyDispatch,
} from "./agy-dispatch.mjs";
import {
  BACKENDS,
  resolveBackend,
  resolveDispatchBackend,
  backendDispatch,
  backendPinsModel,
  assertSessionBackendCompatible,
} from "./kusabi-companion.mjs";
// The chain-side seams moved out of the companion with the driver
// (kusabi #264 PR 2/2); no compatibility re-export was left behind.
import {
  resolveReviewDispatch,
  resolveResumeDispatches,
  effectiveTierCount,
} from "./chain-driver.mjs";
import { claudeDispatch, readAgentSystemPrompt } from "./claude-dispatch.mjs";
import { dispatchWithFallback } from "./prompt-execution.mjs";
import { runImplementPhase } from "./chain-phases.mjs";
import { backendSupportsResume, splitRouteBackend, stripBackendPrefixChain } from "./cli.mjs";
import { stateDirFor, readJson } from "./state-paths.mjs";
import { loadJob, jobDir, listJobs } from "./job-store.mjs";
import { parseChainRecord, ingestChainDirectory } from "./chain-ingest.mjs";
import { openMetricsDb } from "./metrics-db.mjs";
import { computeReport } from "./metrics-report.mjs";
import { renderHeader } from "./render.mjs";

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..");

// =========================================================================
// model syntax — pure
// =========================================================================

describe("agyBin", () => {
  const saved = process.env.AGY_BIN;
  afterEach(() => {
    if (saved === undefined) delete process.env.AGY_BIN;
    else process.env.AGY_BIN = saved;
  });

  it("defaults to `agy`", () => {
    delete process.env.AGY_BIN;
    assert.equal(agyBin(), "agy");
  });

  it("honors AGY_BIN", () => {
    process.env.AGY_BIN = "/tmp/fake-agy";
    assert.equal(agyBin(), "/tmp/fake-agy");
  });
});

describe("validateAgyModel", () => {
  it("accepts any non-empty plain id — the agy CLI is the validator of record", () => {
    // The model list drifts; kusabi validates SHAPE only, so an id added
    // upstream works the day it ships.
    for (const id of [
      "gemini-3.6-flash-high", "gemini-3.5-flash-low", "gemini-3.1-pro-high",
      "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium",
      "a-model-that-does-not-exist-yet",
    ]) {
      assert.equal(validateAgyModel(id), id);
    }
  });

  it("treats absent/empty as null rather than an error", () => {
    assert.equal(validateAgyModel(undefined), null);
    assert.equal(validateAgyModel(null), null);
    assert.equal(validateAgyModel(""), null);
  });

  it("rejects a :variant suffix, naming the offending model", () => {
    assert.throws(
      () => validateAgyModel("gemini-3.6-flash-high:max"),
      /:variant suffix in model "gemini-3.6-flash-high:max"/,
    );
  });
});

describe("validateAgyChain", () => {
  it("accepts flat and tiered chains of plain ids", () => {
    const flat = ["gemini-3.6-flash-high", "gemini-3.1-pro-high"];
    assert.deepEqual(validateAgyChain(flat), flat);
    const tiered = [["gemini-3.6-flash-high"], ["gemini-3.1-pro-high"]];
    assert.deepEqual(validateAgyChain(tiered), tiered);
  });

  it("rejects the whole chain when ANY route carries a :variant, naming that entry", () => {
    assert.throws(
      () => validateAgyChain([["gemini-3.6-flash-high"], ["opencode/x:max"]]),
      /chain entry "opencode\/x:max" is not an agy model/,
    );
  });
});

describe("resolveAgyModel", () => {
  it("falls back to the agy-native default chain when no config", () => {
    const r = resolveAgyModel({ config: null });
    assert.deepEqual(r.chain, AGY_DEFAULT_CHAIN);
    assert.equal(r.model, AGY_DEFAULT_CHAIN[0][0]);
  });

  it("the default chain is ONE tier — this backend walks no ladder", () => {
    assert.equal(AGY_DEFAULT_CHAIN.length, 1);
  });

  it("prefers the explicit flag, then the phase chain, then the global chain", () => {
    const config = {
      models: {
        chain: ["gemini-3.5-flash-low"],
        phases: { review: ["gemini-3.1-pro-high"] },
      },
    };
    assert.equal(resolveAgyModel({ flag: "claude-sonnet-4-6", phase: "review", config }).model, "claude-sonnet-4-6");
    assert.equal(resolveAgyModel({ phase: "review", config }).model, "gemini-3.1-pro-high");
    assert.equal(resolveAgyModel({ phase: "implement", config }).model, "gemini-3.5-flash-low");
  });
});

// =========================================================================
// entry-prefix syntax (criterion 4)
// =========================================================================

describe("agy/ chain-entry prefix", () => {
  it("agy/<model> names the agy backend and yields the bare model", () => {
    assert.deepEqual(
      splitRouteBackend("agy/gemini-3.6-flash-high"),
      { route: "gemini-3.6-flash-high", backend: "agy" },
    );
  });

  it("a bare `agy/` (empty model) is a config error", () => {
    assert.throws(() => splitRouteBackend("agy/"), /empty model/);
  });

  it("stripBackendPrefixChain strips agy/ while leaving opencode entries alone", () => {
    assert.deepEqual(
      stripBackendPrefixChain([["agy/gemini-3.6-flash-high"], ["agy/gemini-3.1-pro-high"]]),
      [["gemini-3.6-flash-high"], ["gemini-3.1-pro-high"]],
    );
    assert.deepEqual(stripBackendPrefixChain(["opencode/x:max"]), ["opencode/x:max"]);
  });
});

// =========================================================================
// argv + prompt construction (criterion 9)
// =========================================================================

// Parse the h/m/s form formatGoDuration emits back into whole seconds, so
// the ordering tests can compare the inner bound against the outer one
// numerically instead of string-compare-guessing.
function secondsOfGoDuration(text) {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(\d+)s$/.exec(text);
  assert.ok(m, `not a whole-second Go duration: ${text}`);
  return (Number(m[1] ?? 0) * 3600) + (Number(m[2] ?? 0) * 60) + Number(m[3]);
}

describe("buildAgyArgs", () => {
  it("builds the base invocation with NO --print-timeout when no timeout is resolved", () => {
    // Without a positive timeoutS there is no outer bound to keep
    // authoritative, so no inner bound is invented either — agy's own
    // default (5m0s) is then its business, not kusabi's.  This mirrors
    // runAgyProcess, which arms no timer for such a dispatch.
    assert.deepEqual(
      buildAgyArgs({ model: "gemini-3.6-flash-high", promptText: "Do the thing.", jsonSchema: null }),
      ["-p", "Do the thing.", "--output-format", "json", "--model", "gemini-3.6-flash-high"],
    );
    for (const timeoutS of [undefined, null, 0, -5]) {
      assert.equal(
        buildAgyArgs({ model: "m", promptText: "p", jsonSchema: null, timeoutS })
          .includes("--print-timeout"),
        false,
        `timeoutS=${timeoutS} must not invent an inner bound`,
      );
    }
  });

  it("emits --print-timeout carrying the resolved timeout plus headroom, as a Go duration (kusabi #326)", () => {
    // 3600s is the implement default, 1800s the review default: the inner
    // bound is ALWAYS timeoutS + AGY_PRINT_TIMEOUT_MARGIN_S, formatted the
    // way agy's own help prints durations (default 5m0s).
    assert.deepEqual(
      buildAgyArgs({ model: "m", promptText: "p", jsonSchema: null, timeoutS: 3600 }),
      ["-p", "p", "--output-format", "json", "--model", "m", "--print-timeout", "1h5m0s"],
    );
    assert.deepEqual(
      buildAgyArgs({ model: "m", promptText: "p", jsonSchema: null, timeoutS: 1800 }),
      ["-p", "p", "--output-format", "json", "--model", "m", "--print-timeout", "35m0s"],
    );
  });

  it("the inner bound is STRICTLY larger than the outer for every timeoutS kusabi resolves", () => {
    // 3600 (implement) / 1800 (review) / 600 (salvage) are the resolved
    // defaults; the operator --timeout override is an arbitrary positive
    // number.  For each, the value passed to agy must leave kusabi's own
    // timer expiring first, with at least the full margin of headroom.
    for (const timeoutS of [600, 1800, 3600, 9000, 1, 30, 12345]) {
      const args = buildAgyArgs({ model: "m", promptText: "p", jsonSchema: null, timeoutS });
      const idx = args.indexOf("--print-timeout");
      assert.ok(idx > 0, `missing --print-timeout for timeoutS=${timeoutS}: ${args.join(" ")}`);
      const innerS = secondsOfGoDuration(args[idx + 1]);
      assert.ok(
        innerS - timeoutS >= AGY_PRINT_TIMEOUT_MARGIN_S,
        `headroom for timeoutS=${timeoutS} is ${innerS - timeoutS}s, ` +
        `expected >= ${AGY_PRINT_TIMEOUT_MARGIN_S}s`,
      );
    }
  });

  it("appends --json-schema only when a schema is given", () => {
    const args = buildAgyArgs({ model: "m", promptText: "p", jsonSchema: '{"type":"object"}' });
    assert.deepEqual(
      args,
      ["-p", "p", "--output-format", "json", "--model", "m", "--json-schema", '{"type":"object"}'],
    );
  });

  it("appends --conversation <id> only when a conversation id is given (resume, kusabi #316)", () => {
    const args = buildAgyArgs({
      model: "m", promptText: "p", jsonSchema: null, timeoutS: 1800,
      conversationId: "6f5f0f1e-0000-4a1b-9c2d-1122334455aa",
    });
    assert.deepEqual(
      args,
      ["-p", "p", "--output-format", "json", "--model", "m",
       "--print-timeout", "35m0s", "--conversation", "6f5f0f1e-0000-4a1b-9c2d-1122334455aa"],
    );
    // Absent / empty / null ids leave a fresh-dispatch argv byte-identical.
    for (const conversationId of [undefined, null, ""]) {
      assert.deepEqual(
        buildAgyArgs({ model: "m", promptText: "p", jsonSchema: null, conversationId }),
        ["-p", "p", "--output-format", "json", "--model", "m"],
      );
    }
  });

  it("never passes --dangerously-skip-permissions, and invents no flag", () => {
    const KNOWN = new Set([
      "-p", "--output-format", "json", "--model", "--print-timeout", "--json-schema", "--conversation",
    ]);
    for (const jsonSchema of [null, '{"type":"object"}']) {
      const args = buildAgyArgs({
        model: "m", promptText: "p", jsonSchema, timeoutS: 600,
        conversationId: jsonSchema ? undefined : "conv-1",
      });
      assert.equal(args.includes("--dangerously-skip-permissions"), false);
      for (const arg of args) {
        if (arg.startsWith("-")) {
          assert.ok(KNOWN.has(arg), `unexpected flag on argv: ${arg}`);
        }
      }
    }
  });
});

describe("formatGoDuration", () => {
  it("renders whole seconds the way Go's time.Duration.String() would — the dialect agy prints", () => {
    assert.equal(formatGoDuration(3900), "1h5m0s");
    assert.equal(formatGoDuration(2100), "35m0s");
    assert.equal(formatGoDuration(900), "15m0s");
    assert.equal(formatGoDuration(3600), "1h0m0s");
    // agy's own default, verbatim — the value's dialect is the tool's own.
    assert.equal(formatGoDuration(300), "5m0s");
    assert.equal(formatGoDuration(61), "1m1s");
    assert.equal(formatGoDuration(10), "10s");
  });
});

describe("agyJsonSchemaFor", () => {
  it("returns the EXISTING review-verdict contract for the review agent", () => {
    const text = agyJsonSchemaFor("kusabi-review");
    assert.equal(typeof text, "string");
    const parsed = JSON.parse(text);
    const onDisk = JSON.parse(fs.readFileSync(
      path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8"));
    // Same contract, not a second copy of it.
    assert.deepEqual(parsed, onDisk);
    assert.deepEqual(parsed.required, ["verdict", "summary", "findings", "next_steps"]);
  });

  it("returns null for every other agent — free-text phases are not schema-forced", () => {
    assert.equal(agyJsonSchemaFor("kusabi-implement"), null);
    assert.equal(agyJsonSchemaFor(null), null);
    assert.equal(agyJsonSchemaFor(undefined), null);
  });
});

describe("buildAgyPrompt", () => {
  it("passes the prompt through byte-identically without an agent body", () => {
    assert.equal(buildAgyPrompt({ systemPrompt: null, promptText: "Do it." }), "Do it.");
  });

  it("prepends the agent role body — agy has no --append-system-prompt", () => {
    const out = buildAgyPrompt({ systemPrompt: "You are a reviewer.", promptText: "Do it." });
    assert.equal(out, "<role>\nYou are a reviewer.\n</role>\n\nDo it.");
  });
});

// =========================================================================
// output parsing + the payload-over-status rule (criterion 2)
// =========================================================================

// The REAL captured shape (hand run, 2026-08-11).
function realAgyResult(overrides = {}) {
  return {
    conversation_id: "6f5f0f1e-0000-4a1b-9c2d-1122334455aa",
    status: "SUCCESS",
    response: "the verdict text",
    duration_seconds: 152.4,
    num_turns: 2,
    usage: {
      input_tokens: 222352,
      output_tokens: 40668,
      thinking_tokens: 32196,
      cache_read_tokens: 2441833,
      total_tokens: 263020,
    },
    ...overrides,
  };
}

describe("parseAgyResult", () => {
  it("parses the single JSON object the CLI prints, tolerating surrounding whitespace", () => {
    const parsed = parseAgyResult(`\n  ${JSON.stringify(realAgyResult())}  \n`);
    assert.equal(parsed.conversation_id, "6f5f0f1e-0000-4a1b-9c2d-1122334455aa");
  });

  it("rejects non-JSON, empty, and non-object output", () => {
    assert.throws(() => parseAgyResult("this is not json"), /agy output is not JSON/);
    assert.throws(() => parseAgyResult("   "), /agy produced no output/);
    assert.throws(() => parseAgyResult("[1,2]"), /agy output is not a JSON object/);
  });
});

describe("agyPayload — payload over status", () => {
  it("status ERROR with a non-empty response is a COMPLETED payload", () => {
    // The real observed shape: one failed MCP tool call mid-run makes the
    // CLI report ERROR while the full answer was delivered.
    const outcome = agyPayload(realAgyResult({ status: "ERROR" }));
    assert.deepEqual(outcome, { ok: true, text: "the verdict text", payloadSource: "response" });
  });

  it("status SUCCESS with an EMPTY response is NOT a payload", () => {
    const outcome = agyPayload(realAgyResult({ status: "SUCCESS", response: "" }));
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /no payload/);
  });

  it("status SUCCESS with a whitespace-only response is NOT a payload", () => {
    const outcome = agyPayload(realAgyResult({ status: "SUCCESS", response: "   \n " }));
    assert.equal(outcome.ok, false);
  });

  it("status SUCCESS with an ABSENT response is NOT a payload", () => {
    const noResponse = realAgyResult();
    delete noResponse.response;
    assert.equal(agyPayload(noResponse).ok, false);
  });

  it("the no-payload error QUOTES what was received", () => {
    const outcome = agyPayload(realAgyResult({ status: "SUCCESS", response: "" }));
    assert.match(outcome.error, /"status":"SUCCESS"/);
    assert.match(outcome.error, /"conversation_id":"6f5f0f1e-0000-4a1b-9c2d-1122334455aa"/);
  });

  it("structured_output carries the payload when the response is empty (schema runs)", () => {
    const outcome = agyPayload(realAgyResult({
      status: "ERROR",
      response: "",
      structured_output: { verdict: "approve", summary: "ok", findings: [], next_steps: [] },
    }));
    assert.equal(outcome.ok, true);
    assert.equal(outcome.payloadSource, "structured_output");
    assert.deepEqual(JSON.parse(outcome.text).verdict, "approve");
  });

  it("response wins over structured_output — the existing extraction path reads it", () => {
    const outcome = agyPayload(realAgyResult({
      response: '{"verdict":"approve"}',
      structured_output: { verdict: "discard" },
    }));
    assert.equal(outcome.payloadSource, "response");
    assert.equal(outcome.text, '{"verdict":"approve"}');
  });
});

describe("describeAgyResult", () => {
  it("bounds a huge object so a bad payload cannot flood the record", () => {
    const huge = { response: "", junk: "x".repeat(5000) };
    const text = describeAgyResult(huge);
    assert.ok(text.length <= 501, `expected a bounded description, got ${text.length} chars`);
    assert.match(text, /…$/);
  });
});

describe("mapAgyUsage", () => {
  it("preserves ALL FIVE reported counters — thinking_tokens is never dropped", () => {
    const usage = mapAgyUsage(realAgyResult());
    assert.equal(usage.available, true);
    assert.equal(usage.input, 222352);
    assert.equal(usage.output, 40668);
    assert.equal(usage.reasoning, 32196); // thinking_tokens
    assert.equal(usage.cacheRead, 2441833);
    assert.equal(usage.total, 263020);
    // agy reports neither of these; 0 means "nothing to add to a running total".
    assert.equal(usage.cacheWrite, 0);
    assert.equal(usage.cost, 0);
  });

  it("defaults every counter to 0 when the CLI reports no usage at all", () => {
    const usage = mapAgyUsage({});
    for (const key of ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total", "cost"]) {
      assert.equal(usage[key], 0, key);
    }
  });
});

// =========================================================================
// cross-backend session guard (criterion 7)
// =========================================================================

describe("assertNoAgySession", () => {
  it("accepts no session at all", () => {
    assert.doesNotThrow(() => assertNoAgySession(undefined));
    assert.doesNotThrow(() => assertNoAgySession(null));
    assert.doesNotThrow(() => assertNoAgySession(""));
  });

  it("rejects an opencode ses_* id, naming BOTH backends", () => {
    assert.throws(() => assertNoAgySession("ses_abc123"), (err) => {
      assert.match(err.message, /opencode session ses_abc123/);
      assert.match(err.message, /on the agy backend/);
      return true;
    });
    // Shape alone decides the ses_* case — provenance never rescues it.
    assert.throws(() => assertNoAgySession("ses_abc123", { provenance: "agy" }));
  });

  it("accepts a bare UUID when the caller establishes agy provenance (kusabi #316)", () => {
    assert.doesNotThrow(() => assertNoAgySession(
      "6f5f0f1e-0000-4a1b-9c2d-1122334455aa",
      { provenance: "agy" },
    ));
  });

  it("rejects a bare UUID without provenance — the backstop fails closed", () => {
    // An agy conversation_id and a claude session id are both bare UUIDs;
    // the caller must PROVE which one this is.  A caller that skips the
    // companion-level provenance check gets a refusal here, never a silent
    // `--conversation`.
    assert.throws(
      () => assertNoAgySession("6f5f0f1e-0000-4a1b-9c2d-1122334455aa"),
      (err) => {
        assert.match(err.message, /cannot be resumed on the agy backend/);
        assert.match(err.message, /no kusabi job record reports it/);
        assert.match(err.message, /both bare UUIDs/);
        return true;
      },
    );
    assert.throws(() => assertNoAgySession("u1", { provenance: null }));
    assert.throws(() => assertNoAgySession("u1", { provenance: undefined }));
  });

  it("rejects a bare UUID whose provenance names ANOTHER backend, naming both", () => {
    // The store proved the id belongs to claude (or opencode): resuming it
    // on agy would hand the agy CLI a session id it does not know.
    assert.throws(
      () => assertNoAgySession("6f5f0f1e-0000-4a1b-9c2d-1122334455aa", { provenance: "claude" }),
      (err) => {
        assert.match(err.message, /attributes it to the claude backend/);
        assert.match(err.message, /on the agy backend/);
        return true;
      },
    );
    assert.throws(
      () => assertNoAgySession("u1", { provenance: "opencode" }),
      /attributes it to the opencode backend/,
    );
  });
});

describe("assertSessionBackendCompatible — the guard is SYMMETRIC", () => {
  it("ses_* → agy is rejected, naming both", () => {
    assert.throws(
      () => assertSessionBackendCompatible({ session: "ses_x", backend: "agy", owner: null }),
      (err) => {
        assert.match(err.message, /opencode session ses_x/);
        assert.match(err.message, /on the agy backend/);
        return true;
      },
    );
  });

  it("ses_* → claude is rejected with the wording claudeDispatch already uses", () => {
    assert.throws(
      () => assertSessionBackendCompatible({ session: "ses_x", backend: "claude", owner: null }),
      /opencode session ses_x cannot be resumed on the claude backend/,
    );
  });

  it("ses_* → opencode is fine (it is that backend's own id)", () => {
    assert.doesNotThrow(
      () => assertSessionBackendCompatible({ session: "ses_x", backend: "opencode", owner: null }),
    );
  });

  it("an agy UUID → claude is rejected by PROVENANCE, naming both", () => {
    // Shape cannot tell an agy conversation id from a claude session id —
    // both are bare UUIDs.  The record that reported it can.
    assert.throws(
      () => assertSessionBackendCompatible({
        session: "6f5f0f1e-0000-4a1b-9c2d-1122334455aa",
        backend: "claude",
        owner: { backend: "agy" },
      }),
      (err) => {
        assert.match(err.message, /belongs to the agy backend/);
        assert.match(err.message, /on the claude backend/);
        return true;
      },
    );
  });

  it("a claude UUID → agy is rejected by PROVENANCE, naming both", () => {
    assert.throws(
      () => assertSessionBackendCompatible({
        session: "claude-uuid-1",
        backend: "agy",
        owner: { backend: "claude" },
      }),
      (err) => {
        assert.match(err.message, /belongs to the claude backend/);
        assert.match(err.message, /on the agy backend/);
        return true;
      },
    );
  });

  it("a record with no backend field is opencode (pre-split reader contract)", () => {
    assert.throws(
      () => assertSessionBackendCompatible({ session: "u1", backend: "agy", owner: { id: "job-1" } }),
      /belongs to the opencode backend/,
    );
  });

  it("a same-backend session, and an unknown session, both pass", () => {
    assert.doesNotThrow(() => assertSessionBackendCompatible({
      session: "u1", backend: "agy", owner: { backend: "agy" },
    }));
    assert.doesNotThrow(() => assertSessionBackendCompatible({
      session: "u1", backend: "agy", owner: null,
    }));
  });
});

describe("backendSupportsResume", () => {
  it("all three backends resume (agy since kusabi #316)", () => {
    assert.equal(backendSupportsResume("opencode"), true);
    assert.equal(backendSupportsResume("claude"), true);
    assert.equal(backendSupportsResume("agy"), true);
  });

  it("a missing backend field is opencode, and an unknown backend defaults to resuming", () => {
    assert.equal(backendSupportsResume(undefined), true);
    assert.equal(backendSupportsResume("some-future-backend"), true);
  });
});

// =========================================================================
// backend registry seams (criteria 3 and 5)
// =========================================================================

describe("backend registry", () => {
  it("agy is a known --backend value", () => {
    assert.deepEqual(BACKENDS, ["opencode", "claude", "agy"]);
    assert.equal(resolveBackend({ backend: "agy" }), "agy");
  });

  it("the unknown-backend error still names the accepted set", () => {
    assert.throws(() => resolveBackend({ backend: "bogus" }), /unknown backend: bogus/);
    assert.throws(() => resolveBackend({ backend: "bogus" }), /Use --backend opencode\|claude\|agy/);
  });

  it("backendDispatch maps each backend to its own dispatch", () => {
    assert.equal(backendDispatch("agy"), agyDispatch);
    assert.equal(backendDispatch("claude"), claudeDispatch);
    assert.equal(backendDispatch("opencode"), dispatchWithFallback);
    assert.equal(backendDispatch(undefined), dispatchWithFallback);
  });

  it("agy pins one model per phase, like claude and unlike opencode", () => {
    assert.equal(backendPinsModel("agy"), true);
    assert.equal(backendPinsModel("claude"), true);
    assert.equal(backendPinsModel("opencode"), false);
  });

  it("an agy chain's effective tier count is at most 1 — it walks no ladder", () => {
    const chain = [["gemini-3.6-flash-high"], ["gemini-3.1-pro-high"], ["claude-sonnet-4-6"]];
    assert.equal(effectiveTierCount(chain, "agy"), 1);
    assert.equal(effectiveTierCount(chain, "opencode"), 3);
    assert.equal(effectiveTierCount([], "agy"), 0);
  });

  it("a differing review backend gets ITS OWN canonical dispatch, never the implement one", () => {
    const implementSeam = () => {};
    assert.equal(
      resolveReviewDispatch({ injectedDispatch: implementSeam, backend: "claude", reviewBackend: "agy" }),
      agyDispatch,
    );
    assert.equal(
      resolveReviewDispatch({ injectedDispatch: implementSeam, backend: "agy", reviewBackend: "opencode" }),
      dispatchWithFallback,
    );
    // Same backend keeps the pre-#192 single-dispatch contract.
    assert.equal(
      resolveReviewDispatch({ injectedDispatch: implementSeam, backend: "agy", reviewBackend: "agy" }),
      implementSeam,
    );
  });

  it("chain-resume wraps an agy phase in a clamped dispatch", () => {
    const seams = resolveResumeDispatches({
      resumeBackend: "agy",
      resumeReviewBackend: "opencode",
      model: "gemini-3.6-flash-high",
      reviewModel: null,
    });
    assert.equal(typeof seams.dispatchWithFallback, "function");
    assert.notEqual(seams.dispatchWithFallback, agyDispatch); // wrapped, not raw
    assert.equal(seams.reviewDispatchWithFallback, dispatchWithFallback);
  });
});

describe("resolveDispatchBackend — agy routing (criteria 3, 4, 5)", () => {
  const OPENCODE_PINNED = { models: { phases: { implement: ["opencode-go/deepseek-v4-pro:max"] } } };

  it("--backend agy forces EVERY phase onto agy", () => {
    for (const phase of ["implement", "rework", "review"]) {
      const r = resolveDispatchBackend({ flags: { backend: "agy" }, phase, config: null });
      assert.equal(r.backend, "agy", phase);
      assert.equal(r.dispatch, agyDispatch, phase);
      assert.equal(r.model, AGY_DEFAULT_CHAIN[0][0], phase);
    }
  });

  it("an agy/<model> chain entry routes just its phases there", () => {
    const config = {
      models: {
        phases: {
          implement: ["claude/opus"],
          review: ["agy/gemini-3.6-flash-high"],
        },
      },
    };
    const impl = resolveDispatchBackend({ flags: {}, phase: "implement", config });
    const review = resolveDispatchBackend({ flags: {}, phase: "review", config });
    assert.equal(impl.backend, "claude");
    assert.equal(impl.model, "opus");
    assert.equal(review.backend, "agy");
    assert.equal(review.dispatch, agyDispatch);
    assert.equal(review.model, "gemini-3.6-flash-high");
    // The prefix is stripped before the chain reaches the dispatch.
    assert.deepEqual(review.chain, ["gemini-3.6-flash-high"]);
  });

  it("--model agy/<model> pins its phases to agy without any --backend", () => {
    const r = resolveDispatchBackend({
      flags: { model: "agy/claude-sonnet-4-6" },
      phase: "implement",
      config: OPENCODE_PINNED,
    });
    assert.equal(r.backend, "agy");
    assert.equal(r.model, "claude-sonnet-4-6");
    assert.equal(r.explicitModel, "claude-sonnet-4-6");
  });

  it("--backend agy with a --model naming another backend throws, naming BOTH", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: { backend: "agy", model: "claude/opus" },
        phase: "implement",
        config: null,
      }),
      (err) => {
        assert.match(err.message, /--backend agy/);
        assert.match(err.message, /--model claude\/opus/);
        assert.match(err.message, /names the claude backend/);
        return true;
      },
    );
  });

  it("--backend claude with a --model naming agy throws, naming BOTH", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: { backend: "claude", model: "agy/gemini-3.6-flash-high" },
        phase: "implement",
        config: null,
      }),
      (err) => {
        assert.match(err.message, /--backend claude/);
        assert.match(err.message, /--model agy\/gemini-3.6-flash-high/);
        assert.match(err.message, /names the agy backend/);
        return true;
      },
    );
  });

  it("--backend opencode conflicts with an agy-native chain, naming the flag, phase and key", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: { backend: "opencode" },
        phase: "review",
        config: { models: { phases: { review: ["agy/gemini-3.6-flash-high"] } } },
      }),
      (err) => {
        assert.match(err.message, /--backend opencode conflicts with the agy-native chain/);
        assert.match(err.message, /review phase/);
        assert.match(err.message, /models\.phases\.review/);
        return true;
      },
    );
  });

  it("--backend agy and a --model naming agy are consistent and proceed", () => {
    const r = resolveDispatchBackend({
      flags: { backend: "agy", model: "agy/gemini-3.1-pro-high" },
      phase: "implement",
      config: OPENCODE_PINNED,
    });
    assert.equal(r.backend, "agy");
    assert.equal(r.model, "gemini-3.1-pro-high");
  });

  it("agy/<model>:variant is rejected at validation, naming the offending entry", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: {},
        phase: "review",
        config: { models: { phases: { review: ["agy/gemini-3.6-flash-high:max"] } } },
      }),
      (err) => {
        assert.match(err.message, /gemini-3.6-flash-high:max/);
        assert.match(err.message, /:variant/);
        return true;
      },
    );
  });

  it("a :variant on an agy-named --model is rejected BY THE IDENTIFIER, not by a config key", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: { model: "agy/gemini-3.6-flash-high:max" },
        phase: "implement",
        config: { models: { phases: { implement: ["agy/gemini-3.6-flash-high"] } } },
      }),
      (err) => {
        assert.match(err.message, /--model "agy\/gemini-3.6-flash-high:max" names the agy backend/);
        assert.match(err.message, /:variant suffix in model "gemini-3.6-flash-high:max"/);
        assert.doesNotMatch(err.message, /models\.phases\.implement/);
        return true;
      },
    );
  });

  it("a bare `agy/` entry (empty model) is rejected", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: {},
        phase: "review",
        config: { models: { phases: { review: ["agy/"] } } },
      }),
      /empty model/,
    );
  });

  it("the single-backend-per-phase rule applies to agy entries too", () => {
    assert.throws(
      () => resolveDispatchBackend({
        flags: {},
        phase: "review",
        config: { models: { phases: { review: ["agy/gemini-3.6-flash-high", "claude/opus"] } } },
      }),
      (err) => {
        assert.match(err.message, /mixes backends/);
        assert.match(err.message, /single-backend/);
        assert.match(err.message, /models\.phases\.review/);
        return true;
      },
    );
    assert.throws(
      () => resolveDispatchBackend({
        flags: {},
        phase: "review",
        config: { models: { phases: { review: ["agy/gemini-3.6-flash-high", "opencode/x:max"] } } },
      }),
      /mixes backends/,
    );
  });
});

// =========================================================================
// integration — fake `agy` binary (AGY_BIN)
// =========================================================================

const FAKE_AGY_SOURCE = `#!/usr/bin/env node
import fs from "node:fs";

const NL = String.fromCharCode(10);
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AGY_ARGS_LOG, JSON.stringify(argv) + NL);
fs.appendFileSync(process.env.FAKE_AGY_PIDS, String(process.pid) + NL);

const mode = process.env.FAKE_AGY_MODE || "ok";

// The REAL captured usage block (hand run, 2026-08-11).
const usage = {
  input_tokens: 222352,
  output_tokens: 40668,
  thinking_tokens: 32196,
  cache_read_tokens: 2441833,
  total_tokens: 263020,
};
const base = {
  conversation_id: "6f5f0f1e-0000-4a1b-9c2d-1122334455aa",
  status: "SUCCESS",
  response: "implemented the thing per the brief",
  duration_seconds: 152.4,
  num_turns: 2,
  usage,
};

if (mode === "exit") {
  process.stderr.write("agy: model not available" + NL);
  process.exit(3);
}
if (mode === "garbage") {
  process.stdout.write("this is not json at all" + NL);
  process.exit(0);
}
if (mode === "error-status-with-payload") {
  // A failed tool call anywhere in the transcript makes the CLI report
  // ERROR even though the answer was delivered in full.
  process.stdout.write(JSON.stringify({ ...base, status: "ERROR" }));
  process.exit(0);
}
if (mode === "success-empty-payload") {
  process.stdout.write(JSON.stringify({ ...base, status: "SUCCESS", response: "" }));
  process.exit(0);
}
if (mode === "structured-only") {
  const schemaIdx = argv.indexOf("--json-schema");
  process.stdout.write(JSON.stringify({
    ...base,
    status: "ERROR",
    response: "",
    structured_output: { verdict: "approve", summary: "looks fine", findings: [], next_steps: [] },
    json_schema: schemaIdx >= 0 ? JSON.parse(argv[schemaIdx + 1]) : null,
  }));
  process.exit(0);
}
if (mode === "review-json") {
  process.stdout.write(JSON.stringify({
    ...base,
    response: JSON.stringify({ verdict: "approve", summary: "ok", findings: [], next_steps: [] }),
  }));
  process.exit(0);
}
if (mode === "slow") {
  setInterval(() => {}, 1000); // never writes, never exits — the timeout must kill us
} else {
  process.stdout.write(JSON.stringify(base));
  process.exit(0);
}
`;

function fakeAgyContext(mode = "ok") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-agy-test-"));
  const binPath = path.join(tmp, "fake-agy.mjs");
  const argsLog = path.join(tmp, "args.ndjson");
  const pidsLog = path.join(tmp, "spawned.pids");
  fs.writeFileSync(binPath, FAKE_AGY_SOURCE, "utf8");
  fs.chmodSync(binPath, 0o755);
  fs.writeFileSync(argsLog, "", "utf8");
  fs.writeFileSync(pidsLog, "", "utf8");

  const stateRoot = path.join(tmp, "state");
  const cwd = path.join(tmp, "cwd");
  fs.mkdirSync(cwd, { recursive: true });

  const saved = {
    AGY_BIN: process.env.AGY_BIN,
    KUSABI_STATE_DIR: process.env.KUSABI_STATE_DIR,
    FAKE_AGY_MODE: process.env.FAKE_AGY_MODE,
    FAKE_AGY_ARGS_LOG: process.env.FAKE_AGY_ARGS_LOG,
    FAKE_AGY_PIDS: process.env.FAKE_AGY_PIDS,
  };
  process.env.AGY_BIN = binPath;
  process.env.KUSABI_STATE_DIR = stateRoot;
  process.env.FAKE_AGY_MODE = mode;
  process.env.FAKE_AGY_ARGS_LOG = argsLog;
  process.env.FAKE_AGY_PIDS = pidsLog;

  const stateDir = stateDirFor(cwd);
  return {
    tmp,
    cwd,
    stateDir,
    argsLog,
    pidsLog,
    setMode(next) { process.env.FAKE_AGY_MODE = next; },
    dispatchOptions(overrides = {}) {
      return {
        cwd,
        kind: "task",
        title: "agy dispatch test",
        promptText: "Do the thing.",
        agent: null,
        phase: null,
        tools: null,
        timeoutS: 20,
        watchdogS: 900,
        tiers: [["gemini-3.6-flash-high"]],
        round: 1,
        explicitModel: null,
        ...overrides,
      };
    },
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function loggedArgs(argsLog) {
  const text = fs.readFileSync(argsLog, "utf8").trim();
  return text ? text.split("\n").map((l) => JSON.parse(l)) : [];
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

describe("agyDispatch (fake agy binary)", () => {
  let ctx;

  beforeEach(() => { ctx = fakeAgyContext(); });
  afterEach(() => { ctx.restore(); });

  it("returns a completed job carrying backend, model, mapped usage and the conversation id (criterion 1)", async () => {
    const { job, resultText, stateDir } = await agyDispatch(ctx.dispatchOptions());

    assert.equal(job.status, "completed");
    assert.equal(job.backend, "agy");
    assert.equal(job.modelEntry, "gemini-3.6-flash-high");
    assert.equal(job.modelVariant, null);
    // sessionID IS the CLI's conversation_id.
    assert.equal(job.sessionID, "6f5f0f1e-0000-4a1b-9c2d-1122334455aa");
    assert.equal(resultText, "implemented the thing per the brief");
    assert.equal(stateDir, ctx.stateDir);

    // All five reported counters survive; thinking_tokens is not dropped.
    assert.equal(job.usage.available, true);
    assert.equal(job.usage.input, 222352);
    assert.equal(job.usage.output, 40668);
    assert.equal(job.usage.reasoning, 32196);
    assert.equal(job.usage.cacheRead, 2441833);
    assert.equal(job.usage.total, 263020);
    assert.equal(typeof job.usage.durationSeconds, "number");

    // Persisted with the same record shape the other backends use.
    const persisted = loadJob(stateDir, job.id);
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.backend, "agy");
    assert.equal(persisted.sessionID, "6f5f0f1e-0000-4a1b-9c2d-1122334455aa");

    const jdir = jobDir(stateDir, job.id);
    assert.equal(fs.readFileSync(path.join(jdir, "prompt.md"), "utf8"), "Do the thing.");
    assert.equal(fs.readFileSync(path.join(jdir, "result.md"), "utf8"), "implemented the thing per the brief");
    const usageFile = readJson(path.join(jdir, "usage.json"));
    assert.equal(usageFile.reasoning, 32196);
    assert.equal(usageFile.total, 263020);

    const events = fs.readFileSync(path.join(jdir, "events.ndjson"), "utf8")
      .trim().split("\n").map(JSON.parse);
    assert.equal(events[0].type, "companion.agy.dispatch");
    assert.equal(events[0].backend, "agy");
    assert.equal(events.at(-1).type, "companion.agy.finished");
    assert.equal(events.at(-1).status, "completed");
  });

  it("asserts the FULL argv of a representative dispatch (criterion 9)", async () => {
    await agyDispatch(ctx.dispatchOptions());
    const calls = loggedArgs(ctx.argsLog);
    assert.equal(calls.length, 1);
    // dispatchOptions resolves timeoutS: 20, so the inner bound is
    // 20 + AGY_PRINT_TIMEOUT_MARGIN_S = 320s, as a Go duration (kusabi #326).
    assert.deepEqual(calls[0], [
      "-p", "Do the thing.",
      "--output-format", "json",
      "--model", "gemini-3.6-flash-high",
      "--print-timeout", "5m20s",
    ]);
  });

  it("a review dispatch adds --json-schema built from the existing verdict contract", async () => {
    ctx.setMode("review-json");
    await agyDispatch(ctx.dispatchOptions({ agent: "kusabi-review", phase: "review" }));
    const args = loggedArgs(ctx.argsLog)[0];
    const schemaIdx = args.indexOf("--json-schema");
    assert.ok(schemaIdx > 0, `expected --json-schema on argv, got: ${args.join(" ")}`);
    const schema = JSON.parse(args[schemaIdx + 1]);
    assert.deepEqual(
      schema,
      JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8")),
    );
    // The role body is carried in the prompt, since agy has no
    // --append-system-prompt.
    assert.match(args[1], /^<role>\n/);
  });

  it("the review verdict flows through the EXISTING extraction path unchanged", async () => {
    ctx.setMode("review-json");
    const { resultText } = await agyDispatch(ctx.dispatchOptions({ agent: "kusabi-review", phase: "review" }));
    // Clean JSON in `response`: extractJson parses it trivially, so there is
    // no second parsing path to maintain.
    const { extractJson } = await import("./render.mjs");
    assert.equal(extractJson(resultText).verdict, "approve");
  });

  it("status ERROR with a payload is a COMPLETED job; status is advisory metadata (criterion 2)", async () => {
    ctx.setMode("error-status-with-payload");
    const { job, resultText } = await agyDispatch(ctx.dispatchOptions());
    assert.equal(job.status, "completed");
    assert.equal(job.agyStatus, "ERROR");
    assert.equal(job.error, null);
    assert.equal(resultText, "implemented the thing per the brief");
    assert.equal(loadJob(ctx.stateDir, job.id).agyStatus, "ERROR");
  });

  it("status SUCCESS with no payload is a FAILED job whose error quotes what arrived (criterion 2)", async () => {
    ctx.setMode("success-empty-payload");
    const { job, resultText } = await agyDispatch(ctx.dispatchOptions());
    assert.equal(job.status, "error");
    assert.equal(job.agyStatus, "SUCCESS");
    assert.match(job.error, /no payload/);
    assert.match(job.error, /"status":"SUCCESS"/);
    assert.equal(resultText, "");
    // The conversation id is still recorded — it is how the run is found.
    assert.equal(job.sessionID, "6f5f0f1e-0000-4a1b-9c2d-1122334455aa");
    // Never a stuck "running" record.
    assert.equal(loadJob(ctx.stateDir, job.id).status, "error");
  });

  it("a schema run that fills structured_output but prints nothing still completes", async () => {
    ctx.setMode("structured-only");
    const { job, resultText } = await agyDispatch(ctx.dispatchOptions({ agent: "kusabi-review", phase: "review" }));
    assert.equal(job.status, "completed");
    assert.equal(job.agyStatus, "ERROR");
    assert.equal(job.payloadSource, "structured_output");
    assert.equal(job.jsonSchemaEnforced, true);
    assert.equal(JSON.parse(resultText).verdict, "approve");
  });

  it("unparseable stdout is a failed job carrying the raw text", async () => {
    ctx.setMode("garbage");
    const { job } = await agyDispatch(ctx.dispatchOptions());
    assert.equal(job.status, "error");
    assert.match(job.error, /not JSON/);
    assert.match(job.error, /this is not json at all/);
  });

  it("a nonzero exit with no payload fails, naming the exit code and stderr", async () => {
    ctx.setMode("exit");
    const { job } = await agyDispatch(ctx.dispatchOptions());
    assert.equal(job.status, "error");
    assert.match(job.error, /agy exited with code 3/);
    assert.match(job.error, /model not available/);
  });

  it("a spawn failure is a failed job, not a throw", async () => {
    process.env.AGY_BIN = path.join(ctx.tmp, "does-not-exist");
    const { job } = await agyDispatch(ctx.dispatchOptions());
    assert.equal(job.status, "error");
    assert.match(job.error, /could not start/);
  });

  it("a timeout kills the process group and records status timeout", async () => {
    ctx.setMode("slow");
    const { job } = await agyDispatch(ctx.dispatchOptions({ timeoutS: 1 }));
    assert.equal(job.status, "timeout");
    assert.match(job.error, /timed out after 1s/);
    const pids = fs.readFileSync(ctx.pidsLog, "utf8").trim().split("\n").filter(Boolean).map(Number);
    for (const pid of pids) {
      assert.equal(isAlive(pid), false, `pid ${pid} survived the timeout kill`);
    }
  });

  it("records the child's pid while it runs, so `cancel` has a lever", async () => {
    const { job } = await agyDispatch(ctx.dispatchOptions());
    assert.equal(typeof job.process.pid, "number");
    assert.equal(typeof job.process.recordedAt, "string");
  });

  it("marks stats as NOT instrumented — this backend has no event stream", async () => {
    const { job } = await agyDispatch(ctx.dispatchOptions());
    assert.equal(job.stats.instrumented, false);
    // The counters are present (not absent) so existing readers keep working.
    for (const key of ["events", "steps", "permissionsAllowed", "permissionsRejected"]) {
      assert.equal(job.stats[key], 0, key);
    }
  });

  it("records an unenforceable deny map rather than dropping it", async () => {
    const { job } = await agyDispatch(ctx.dispatchOptions({
      tools: { bash: false, write: false, read: true },
    }));
    assert.deepEqual(job.toolDeniesUnenforced, ["bash", "write"]);
    // And no allow/deny flag was invented to pretend otherwise.
    assert.deepEqual(loggedArgs(ctx.argsLog)[0].filter((a) => a.startsWith("--")),
      ["--output-format", "--model", "--print-timeout"]);
  });

  it("rejects a session before spawning anything and before any job record exists", async () => {
    // ses_* is refused on SHAPE alone; a bare UUID is refused when the
    // caller has not established its provenance (the backstop fails closed).
    await assert.rejects(() => agyDispatch(ctx.dispatchOptions({ session: "ses_opencode_1" })));
    await assert.rejects(() => agyDispatch(ctx.dispatchOptions({
      session: "6f5f0f1e-0000-4a1b-9c2d-1122334455aa",
    })));
    await assert.rejects(() => agyDispatch(ctx.dispatchOptions({
      session: "6f5f0f1e-0000-4a1b-9c2d-1122334455aa",
      sessionProvenance: "claude",
    })));
    assert.deepEqual(loggedArgs(ctx.argsLog), []);
    assert.deepEqual(listJobs(ctx.stateDir), []);
  });

  it("a resuming dispatch passes the recorded id as --conversation (kusabi #316 criterion 1)", async () => {
    const { job } = await agyDispatch(ctx.dispatchOptions({
      session: "6f5f0f1e-0000-4a1b-9c2d-1122334455aa",
      sessionProvenance: "agy",
    }));
    assert.equal(job.status, "completed");
    const args = loggedArgs(ctx.argsLog)[0];
    const convIdx = args.indexOf("--conversation");
    assert.ok(convIdx > 0, `expected --conversation on argv, got: ${args.join(" ")}`);
    assert.equal(args[convIdx + 1], "6f5f0f1e-0000-4a1b-9c2d-1122334455aa");
    // The rest of the invocation is unchanged: the resume flag is added,
    // nothing else moves or is invented.
    assert.equal(args[0], "-p");
    assert.equal(args.includes("--dangerously-skip-permissions"), false);
    // sessionID still IS the CLI's conversation_id for the continued run.
    assert.equal(job.sessionID, "6f5f0f1e-0000-4a1b-9c2d-1122334455aa");
  });

  it("a fresh dispatch never carries --conversation", async () => {
    await agyDispatch(ctx.dispatchOptions());
    assert.equal(loggedArgs(ctx.argsLog)[0].includes("--conversation"), false);
  });

  it("throws when no model can be resolved, before any job record exists", async () => {
    await assert.rejects(
      () => agyDispatch(ctx.dispatchOptions({ tiers: [], explicitModel: null })),
      /no model resolved/,
    );
    assert.deepEqual(listJobs(ctx.stateDir), []);
  });

  it("explicitModel wins over the chain's first route", async () => {
    const { job } = await agyDispatch(ctx.dispatchOptions({
      tiers: [["gemini-3.6-flash-high"], ["gemini-3.1-pro-high"]],
      explicitModel: "claude-sonnet-4-6",
    }));
    assert.equal(job.modelEntry, "claude-sonnet-4-6");
    // Index-based, not `.at(-1)`: --print-timeout now follows --model.
    const args = loggedArgs(ctx.argsLog)[0];
    const modelIdx = args.indexOf("--model");
    assert.equal(args[modelIdx + 1], "claude-sonnet-4-6");
  });
});

// =========================================================================
// chain seam — a chain never manufactures a session for agy
// =========================================================================

describe("runImplementPhase with the agy backend", () => {
  it("carries a rework round's session lineage — agy resumes it (kusabi #316)", async () => {
    let seen;
    const fake = async (opts) => {
      seen = opts;
      return { job: { id: "job-1", status: "completed", sessionID: "agy-conv-2" }, resultText: "" };
    };
    const out = await runImplementPhase({
      cwd: "/tmp", chainId: "chain-1", round: 2, isFirstRound: false,
      implementText: "rework it", modelChain: [["gemini-3.6-flash-high"]], tierIndex: 0,
      useNewSession: false, session: undefined,
      previousRecord: { sessionID: "agy-conv-1", backend: "agy" },
      resumeMethod: { type: "continue_session" }, flagsModel: null,
      backend: "agy",
      _dispatchWithFallback: fake,
    });
    // The dispatch sees the previous record's conversation id AND its
    // provenance — the lineage part 2 carries the agy record, so the
    // dispatch continues that conversation instead of starting fresh.
    assert.equal(seen.session, "agy-conv-1");
    assert.equal(seen.sessionProvenance, "agy");
    assert.equal(out.session, "agy-conv-1");
    assert.equal(out.sessionProvenance, "agy");
    // The NEW conversation id is still recorded on the round record.
    assert.equal(out.roundRecord.sessionID, "agy-conv-2");
  });

  it("carries an explicitly injected session with the caller's provenance", async () => {
    let seen;
    const fake = async (opts) => {
      seen = opts;
      return { job: { id: "job-1", status: "completed", sessionID: "agy-conv-9" }, resultText: "" };
    };
    await runImplementPhase({
      cwd: "/tmp", chainId: "chain-1", round: 3, isFirstRound: false,
      implementText: "rework it", modelChain: [["gemini-3.6-flash-high"]], tierIndex: 0,
      useNewSession: false, session: "agy-conv-1",
      previousRecord: null,
      resumeMethod: { type: "continue_session" }, flagsModel: null,
      sessionProvenance: "agy",
      backend: "agy",
      _dispatchWithFallback: fake,
    });
    assert.equal(seen.session, "agy-conv-1");
    assert.equal(seen.sessionProvenance, "agy");
    // Without provenance the phase forwards the id UNPROVEN — the dispatch
    // (not this seam) is where the gate refuses it, so the fake sees the id
    // with a null provenance, never a fabricated one.
    await runImplementPhase({
      cwd: "/tmp", chainId: "chain-1", round: 3, isFirstRound: false,
      implementText: "rework it", modelChain: [["gemini-3.6-flash-high"]], tierIndex: 0,
      useNewSession: false, session: "agy-conv-1",
      previousRecord: null,
      resumeMethod: { type: "continue_session" }, flagsModel: null,
      backend: "agy",
      _dispatchWithFallback: fake,
    });
    assert.equal(seen.session, "agy-conv-1");
    assert.equal(seen.sessionProvenance, null);
  });

  it("starts fresh when the previous record belongs to another backend", async () => {
    let seen;
    const fake = async (opts) => {
      seen = opts;
      return { job: { id: "job-1", status: "completed", sessionID: "agy-conv-2" }, resultText: "" };
    };
    await runImplementPhase({
      cwd: "/tmp", chainId: "chain-1", round: 2, isFirstRound: false,
      implementText: "rework it", modelChain: [["gemini-3.6-flash-high"]], tierIndex: 0,
      useNewSession: false, session: undefined,
      previousRecord: { sessionID: "claude-1", backend: "claude" },
      resumeMethod: { type: "continue_session" }, flagsModel: null,
      backend: "agy",
      _dispatchWithFallback: fake,
    });
    // #192 invariant 5: a session never crosses backends — a claude id is
    // not passed to the agy CLI, and provenance never fabricates it.
    assert.equal(seen.session, undefined);
    assert.equal(seen.sessionProvenance, null);
  });

  it("useNewSession forces a fresh dispatch even with a resumable lineage", async () => {
    let seen;
    const fake = async (opts) => {
      seen = opts;
      return { job: { id: "job-1", status: "completed", sessionID: "agy-conv-3" }, resultText: "" };
    };
    const out = await runImplementPhase({
      cwd: "/tmp", chainId: "chain-1", round: 2, isFirstRound: false,
      implementText: "rework it", modelChain: [["gemini-3.6-flash-high"]], tierIndex: 0,
      useNewSession: true, session: "agy-conv-1",
      previousRecord: { sessionID: "agy-conv-1", backend: "agy" },
      resumeMethod: { type: "continue_session" }, flagsModel: null,
      backend: "agy",
      _dispatchWithFallback: fake,
    });
    assert.equal(seen.session, undefined);
    assert.equal(seen.sessionProvenance, undefined);
    // kusabi #323: this file is outside the issue's deliverables list, but
    // this assertion encoded the old seam contract (runImplementPhase
    // reporting the candidate it was told to resume) and the spec's §3
    // explicitly licenses updating such tests; it is updated here to the new
    // contract rather than left red.  The seam reports the session the
    // dispatch CREATED — never the candidate it was told to abandon — and
    // the record agrees.
    assert.equal(out.session, "agy-conv-3");
    assert.equal(out.sessionProvenance, "agy");
    assert.equal(out.roundRecord.sessionID, "agy-conv-3");
  });

  it("is byte-identical for a claude chain — lineage is carried exactly as before", async () => {
    let seen;
    const fake = async (opts) => {
      seen = opts;
      return { job: { id: "job-1", status: "completed", sessionID: "claude-2" }, resultText: "" };
    };
    await runImplementPhase({
      cwd: "/tmp", chainId: "chain-1", round: 2, isFirstRound: false,
      implementText: "rework it", modelChain: [["opus"]], tierIndex: 0,
      useNewSession: false, session: undefined,
      previousRecord: { sessionID: "claude-1", backend: "claude" },
      resumeMethod: { type: "continue_session" }, flagsModel: null,
      backend: "claude",
      _dispatchWithFallback: fake,
    });
    assert.equal(seen.session, "claude-1");
    assert.equal(seen.sessionProvenance, "claude");
  });
});

// =========================================================================
// rendering
// =========================================================================

describe("renderHeader for an agy job", () => {
  const job = {
    id: "job-agy1", kind: "task", status: "completed", backend: "agy",
    sessionID: "6f5f0f1e-0000-4a1b-9c2d-1122334455aa",
    startedAt: "2026-08-11T00:00:00.000Z", finishedAt: "2026-08-11T00:02:32.000Z",
    phase: "review", modelEntry: "gemini-3.6-flash-high",
  };

  it("labels the backend and names the conversation id", () => {
    const text = renderHeader(job);
    assert.match(text, /^agy task job-agy1 — completed/);
    assert.match(text, /session: 6f5f0f1e-0000-4a1b-9c2d-1122334455aa/);
  });

  it("advertises the agy resume incantation (kusabi #316)", () => {
    const text = renderHeader(job);
    assert.match(
      text,
      /continue in agy: `agy --conversation 6f5f0f1e-0000-4a1b-9c2d-1122334455aa`/,
    );
    assert.doesNotMatch(text, /resume is not supported/);
    assert.doesNotMatch(text, /opencode -s /);
    assert.doesNotMatch(text, /claude -p --resume/);
  });

  it("an opencode job's header is byte-identical to before", () => {
    const oc = { ...job, backend: undefined, sessionID: "ses_abc" };
    assert.match(renderHeader(oc), /^opencode task job-agy1 — completed/);
    assert.match(renderHeader(oc), /continue in opencode: `opencode -s ses_abc`/);
  });
});

// =========================================================================
// metrics attribution (criterion 6)
// =========================================================================

const AGY_BRIEF = [
  "Orchestrator: claude-opus-5 | session cc-agy | 2026-08-11",
  "",
  "Route review to agy.",
  "",
  "## Deliverables",
  "- `plugins/kusabi/scripts/agy-dispatch.mjs`",
  "",
].join("\n");

function chainWithAgyReviewFixture() {
  return {
    chainId: "chain-agy0000001",
    container: "agycontainer1",
    model: { providerID: "anthropic", modelID: "claude-opus-5" },
    modelChain: [["claude/opus"]],
    reviewModel: "gemini-3.6-flash-high",
    reviewModelChain: [["gemini-3.6-flash-high"]],
    maxRounds: 4,
    brief: AGY_BRIEF,
    orchestrator: { model: "claude-opus-5", session: "cc-agy", date: "2026-08-11" },
    baseSha: "aa11bb22cc",
    strategized: false,
    chainTotals: { input: 100, output: 50, reasoning: 30, cacheRead: 200, cacheWrite: 0, cost: 0 },
    records: [
      {
        round: 1,
        startedAt: "2026-08-11T10:00:00.000Z",
        modelEntry: "opus",
        tierBefore: 0,
        tierAfter: 0,
        verdict: "approve",
        probesGreen: true,
        worktreeChanged: true,
        disposition: { disposition: "accept" },
        reworkCount: 0,
        findingsText: "(none)",
        findingFiles: [],
        findings: [],
        backend: "claude",
        reviewBackend: "agy",
        implementUsage: { available: true, input: 60, output: 20, cacheRead: 100, cacheWrite: 0, cost: 0 },
        reviewUsage: { available: true, input: 40, output: 30, reasoning: 30, cacheRead: 100, cacheWrite: 0, cost: 0 },
      },
    ],
  };
}

function chainAllAgyFixture() {
  const chain = chainWithAgyReviewFixture();
  chain.chainId = "chain-agy0000002";
  chain.records[0].backend = "agy";
  chain.records[0].reviewBackend = "agy";
  return chain;
}

function chainNoBackendFixture() {
  const chain = chainWithAgyReviewFixture();
  chain.chainId = "chain-legacy00001";
  delete chain.records[0].backend;
  delete chain.records[0].reviewBackend;
  return chain;
}

describe("metrics attribution for agy round data (criterion 6)", () => {
  it("parses agy backends verbatim per round — never folded into another backend", () => {
    const parsed = parseChainRecord(chainWithAgyReviewFixture(), { workspaceSlug: "ws1" });
    assert.equal(parsed.roundRows[0].backend, "claude");
    assert.equal(parsed.roundRows[0].reviewBackend, "agy");
    // Two known phase backends that disagree -> the chain is "mixed", so its
    // whole spend is never filed under whichever ran last.
    assert.equal(parsed.chainRow.backend, "mixed");
  });

  it("an all-agy chain stores 'agy' at the chain level", () => {
    const parsed = parseChainRecord(chainAllAgyFixture(), { workspaceSlug: "ws1" });
    assert.equal(parsed.chainRow.backend, "agy");
    assert.equal(parsed.roundRows[0].backend, "agy");
    assert.equal(parsed.roundRows[0].reviewBackend, "agy");
  });

  it("ingest of a record with NO agy data is byte-identical: NULL, never a default", () => {
    const parsed = parseChainRecord(chainNoBackendFixture(), { workspaceSlug: "ws1" });
    assert.equal(parsed.chainRow.backend, null);
    assert.equal(parsed.roundRows[0].backend, null);
    assert.equal(parsed.roundRows[0].reviewBackend, null);
  });

  it("the agy backend is visible in the by-backend split, and legacy fixtures do not crash", () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-agy-metrics-"));
    try {
      for (const chain of [chainAllAgyFixture(), chainNoBackendFixture()]) {
        const dir = path.join(stateRoot, "ws1", "chains", chain.chainId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "chain.json"), JSON.stringify(chain), "utf8");
      }

      const db = openMetricsDb(":memory:");
      const result = ingestChainDirectory(db, stateRoot);
      assert.equal(result.chainsIngested, 2);

      const byChain = Object.fromEntries(
        db.prepare("SELECT chain_id, backend FROM chain").all().map((r) => [r.chain_id, r.backend]),
      );
      assert.equal(byChain["chain-agy0000002"], "agy");
      assert.equal(byChain["chain-legacy00001"], null);

      const roundBackends = db.prepare("SELECT chain_id, backend, review_backend FROM round").all();
      const agyRound = roundBackends.find((r) => r.chain_id === "chain-agy0000002");
      assert.equal(agyRound.backend, "agy");
      assert.equal(agyRound.review_backend, "agy");

      // The report's grouping is the stored value read verbatim, with the
      // NULL-means-opencode reader contract applied — so agy appears as its
      // own bucket rather than folded into either other backend.
      const report = computeReport(db, { days: 100000 });
      const backends = report.byBackend.chains.map((c) => c.backend).sort();
      assert.ok(backends.includes("agy"), `expected an agy bucket, got ${JSON.stringify(backends)}`);
      assert.ok(backends.includes("opencode"), "the legacy chain must read as opencode");
      const agyBucket = report.byBackend.chains.find((c) => c.backend === "agy");
      assert.equal(agyBucket.chainCount, 1);
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});

// =========================================================================
// CLI wiring (subprocess) — the resolution reaches the spawned process
// =========================================================================

describe("CLI agy wiring (subprocess)", () => {
  const COMPANION_SCRIPT = path.join(import.meta.dirname, "kusabi-companion.mjs");

  function setup(tmp) {
    const binPath = path.join(tmp, "fake-agy.mjs");
    fs.writeFileSync(binPath, FAKE_AGY_SOURCE, "utf8");
    fs.chmodSync(binPath, 0o755);
    const argsLog = path.join(tmp, "args.ndjson");
    const pidsLog = path.join(tmp, "pids");
    for (const f of [argsLog, pidsLog]) fs.writeFileSync(f, "", "utf8");

    const env = { ...process.env };
    delete env.KUSABI_WORKER_CONTEXT;
    env.AGY_BIN = binPath;
    env.KUSABI_STATE_DIR = path.join(tmp, "state");
    env.FAKE_AGY_MODE = "ok";
    env.FAKE_AGY_ARGS_LOG = argsLog;
    env.FAKE_AGY_PIDS = pidsLog;
    return { env, argsLog };
  }

  function run(args, cwd, env) {
    return spawnSync(process.execPath, [COMPANION_SCRIPT, ...args], {
      encoding: "utf8", cwd, env, timeout: 30_000,
    });
  }

  it("task --backend agy spawns the agy CLI with the default agy model", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-agy-cli-"));
    try {
      const { env, argsLog } = setup(tmp);
      const result = run(["task", "--backend", "agy", "do the thing"], tmp, env);
      assert.equal(result.status, 0, `expected success, got: ${result.stdout} ${result.stderr}`);
      const args = loggedArgs(argsLog)[0];
      const modelIdx = args.indexOf("--model");
      assert.ok(modelIdx > 0, `expected --model on argv, got: ${args.join(" ")}`);
      assert.equal(args[modelIdx + 1], AGY_DEFAULT_CHAIN[0][0]);
      assert.equal(args.includes("--dangerously-skip-permissions"), false);
      // The rendered result names the agy backend.
      assert.match(result.stdout, /^agy task /m);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("task --model agy/<model> (no --backend) routes to agy in the agy spelling", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-agy-cli2-"));
    try {
      const { env, argsLog } = setup(tmp);
      const result = run(["task", "--model", "agy/claude-sonnet-4-6", "do the thing"], tmp, env);
      assert.equal(result.status, 0, `expected success, got: ${result.stdout} ${result.stderr}`);
      const args = loggedArgs(argsLog)[0];
      const modelIdx = args.indexOf("--model");
      assert.equal(args[modelIdx + 1], "claude-sonnet-4-6");
      assert.notEqual(args[modelIdx + 1], "agy/claude-sonnet-4-6");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--backend agy --session <agy uuid> resumes the recorded conversation (kusabi #316)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-agy-cli3-"));
    try {
      const { env, argsLog } = setup(tmp);
      // First: a real agy job, so the store has an agy-owned conversation id.
      const first = run(["task", "--backend", "agy", "do the thing"], tmp, env);
      assert.equal(first.status, 0, first.stdout);
      fs.writeFileSync(argsLog, "", "utf8");

      const result = run(
        ["task", "--backend", "agy", "--session", "6f5f0f1e-0000-4a1b-9c2d-1122334455aa", "again"],
        tmp, env,
      );
      assert.equal(result.status, 0, `expected success, got: ${result.stdout} ${result.stderr}`);
      const args = loggedArgs(argsLog)[0];
      const convIdx = args.indexOf("--conversation");
      assert.ok(convIdx > 0, `expected --conversation on argv, got: ${args.join(" ")}`);
      assert.equal(args[convIdx + 1], "6f5f0f1e-0000-4a1b-9c2d-1122334455aa");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--backend agy --session <unknown uuid> is refused — provenance must be proven", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-agy-cli3b-"));
    try {
      const { env, argsLog } = setup(tmp);
      const result = run(
        ["task", "--backend", "agy", "--session", "11111111-2222-4333-8444-555566667777", "again"],
        tmp, env,
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /cannot be resumed on the agy backend/);
      assert.deepEqual(loggedArgs(argsLog), []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--backend agy --session <claude-owned uuid> is refused, naming both backends", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-agy-cli3c-"));
    try {
      const { env, argsLog } = setup(tmp);
      // Seed an agy job, then re-attribute its conversation id to claude in
      // the store — the provenance the companion derives must come from the
      // OWNER RECORD, not from the id's shape (both are bare UUIDs).
      const first = run(["task", "--backend", "agy", "do the thing"], tmp, env);
      assert.equal(first.status, 0, first.stdout);
      const stateDir = path.join(tmp, "state");
      // The job store sits under a per-cwd subdir of the state root; walk
      // for the record that owns the conversation id.
      const jobJsonPath = (function findJob(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = findJob(p);
            if (found) return found;
          } else if (entry.name === "job.json") {
            const record = JSON.parse(fs.readFileSync(p, "utf8"));
            if (record.sessionID === "6f5f0f1e-0000-4a1b-9c2d-1122334455aa") return p;
          }
        }
        return null;
      })(stateDir);
      assert.ok(jobJsonPath, "expected the agy job record to carry the conversation id");
      const record = JSON.parse(fs.readFileSync(jobJsonPath, "utf8"));
      record.backend = "claude";
      fs.writeFileSync(jobJsonPath, JSON.stringify(record), "utf8");
      fs.writeFileSync(argsLog, "", "utf8");

      const result = run(
        ["task", "--backend", "agy", "--session", "6f5f0f1e-0000-4a1b-9c2d-1122334455aa", "again"],
        tmp, env,
      );
      assert.notEqual(result.status, 0);
      // Refused at the companion's own store-based gate (which runs before
      // the dispatch), naming BOTH backends; nothing reaches the agy CLI.
      assert.match(result.stdout, /belongs to the claude backend/);
      assert.match(result.stdout, /cannot be resumed on the agy backend/);
      assert.deepEqual(loggedArgs(argsLog), []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("an agy conversation id cannot be resumed on the claude backend — the error names both", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-agy-cli4-"));
    try {
      const { env, argsLog } = setup(tmp);
      const first = run(["task", "--backend", "agy", "do the thing"], tmp, env);
      assert.equal(first.status, 0, first.stdout);

      const result = run(
        ["task", "--backend", "claude", "--session", "6f5f0f1e-0000-4a1b-9c2d-1122334455aa", "again"],
        tmp, env,
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /belongs to the agy backend/);
      assert.match(result.stdout, /on the claude backend/);
      // Nothing was dispatched: the agy args log is unchanged (one entry,
      // from the first run) and no claude CLI was reachable anyway.
      assert.equal(loggedArgs(argsLog).length, 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--backend agy --resume-last resumes the last agy conversation (kusabi #316)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-agy-cli5-"));
    try {
      const { env, argsLog } = setup(tmp);
      // First: a real agy job, so `--resume-last` has a conversation to pick.
      const first = run(["task", "--backend", "agy", "do the thing"], tmp, env);
      assert.equal(first.status, 0, first.stdout);
      fs.writeFileSync(argsLog, "", "utf8");

      const result = run(["task", "--backend", "agy", "--resume-last", "again"], tmp, env);
      assert.equal(result.status, 0, `expected success, got: ${result.stdout} ${result.stderr}`);
      const args = loggedArgs(argsLog)[0];
      const convIdx = args.indexOf("--conversation");
      assert.ok(convIdx > 0, `expected --conversation on argv, got: ${args.join(" ")}`);
      assert.equal(args[convIdx + 1], "6f5f0f1e-0000-4a1b-9c2d-1122334455aa");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--backend agy --read-only is refused rather than silently no-opped", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-agy-cli6-"));
    try {
      const { env, argsLog } = setup(tmp);
      const result = run(["task", "--backend", "agy", "--read-only", "look at it"], tmp, env);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /--read-only is not supported on the agy backend/);
      assert.deepEqual(loggedArgs(argsLog), []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("`agy` is listed in the --backend usage line", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-agy-cli7-"));
    try {
      const { env } = setup(tmp);
      const result = run(["--help"], tmp, env);
      assert.match(result.stdout, /--backend opencode\|claude\|agy/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// =========================================================================
// argv size guard — the E2BIG residual left open by kusabi #221
// =========================================================================
//
// agy has no stdin prompt transport, so a brief past MAX_ARG_STRLEN used to
// die as a raw E2BIG with nothing naming the cause.  These tests pin the
// refusal: which element, how big, what the limit is, and what to do next.

describe("checkAgyArgvSize — the per-argument byte rule", () => {
  it("derives its limit from MAX_ARG_STRLEN with a margin, and stays under it", () => {
    // PAGE_SIZE (4096) * 32, measured on this project's hosts.
    assert.equal(AGY_MAX_ARG_STRLEN, 131072);
    assert.equal(AGY_MAX_ARG_BYTES, 131072 - 1024);
    // The margin must be real: the kernel counts the NUL terminator, so a
    // guard set AT MAX_ARG_STRLEN would still hand one size to the kernel.
    assert.ok(AGY_MAX_ARG_BYTES < AGY_MAX_ARG_STRLEN);
  });

  it("passes an ordinary dispatch argv untouched", () => {
    const args = buildAgyArgs({
      model: "gemini-3.6-flash-high",
      promptText: "Do the thing.",
      jsonSchema: null,
    });
    const result = checkAgyArgvSize(args);
    assert.equal(result.ok, true);
    assert.deepEqual(result.oversized, []);
    assert.equal(result.limit, AGY_MAX_ARG_BYTES);
  });

  it("is a PER-ELEMENT rule, not a total — two legal big args still pass", () => {
    // 260096 bytes of argv in total, and correct to allow: the cap this
    // guards is per string.  (ARG_MAX, the total bound, is 2097152.)
    const big = "x".repeat(AGY_MAX_ARG_BYTES);
    assert.equal(checkAgyArgvSize(["-p", big, "--json-schema", big]).ok, true);
  });

  it("passes at exactly the limit and refuses at limit+1", () => {
    assert.equal(checkAgyArgvSize(["-p", "x".repeat(AGY_MAX_ARG_BYTES)]).ok, true);
    const over = checkAgyArgvSize(["-p", "x".repeat(AGY_MAX_ARG_BYTES + 1)]);
    assert.equal(over.ok, false);
    assert.equal(over.oversized[0].bytes, AGY_MAX_ARG_BYTES + 1);
  });

  it("names the prompt element, its size, the limit and the way out", () => {
    const result = checkAgyArgvSize(["-p", "x".repeat(200)], 100);
    assert.equal(result.ok, false);
    assert.deepEqual(result.oversized, [
      { index: 1, element: "prompt", flag: "-p", bytes: 200 },
    ]);
    assert.match(result.message, /the prompt \(-p\) is 200 bytes/);
    assert.match(result.message, /100-byte per-argument limit/);
    assert.match(result.message, /MAX_ARG_STRLEN is 131072/);
    assert.match(result.message, /shrink the brief/);
    assert.match(result.message, /--model claude/);
    assert.match(result.message, /opencode model/);
  });

  it("names the SCHEMA when the schema is oversized and the prompt is small (criterion 2)", () => {
    // Exactly the composition agyDispatch performs — buildAgyArgs, then the
    // guard over its output — with the sizes reversed from the usual case.
    // A small prompt does not make an oversized schema safe: they are
    // SEPARATE argv strings, each measured against the same cap.  (The real
    // review schema is ~2KB, so an end-to-end oversized-schema dispatch
    // would require editing a repo artifact; this exercises the same code
    // path the dispatch runs.)
    const args = buildAgyArgs({
      model: "gemini-3.6-flash-high",
      promptText: "tiny",
      jsonSchema: JSON.stringify({ type: "object", title: "y".repeat(500) }),
    });
    const result = checkAgyArgvSize(args, 100);
    assert.equal(result.ok, false);
    assert.equal(result.oversized.length, 1);
    assert.equal(result.oversized[0].element, "schema");
    assert.equal(result.oversized[0].flag, "--json-schema");
    assert.match(result.message, /the schema \(--json-schema\) is \d+ bytes/);
    // Only the schema is NAMED as oversized (the standing advice text
    // mentions the prompt, which is why this checks the named form).
    assert.doesNotMatch(result.message, /the prompt \(-p\) is/);
  });

  it("reports EVERY oversized element, not just the first", () => {
    const args = buildAgyArgs({
      model: "gemini-3.6-flash-high",
      promptText: "x".repeat(200),
      jsonSchema: "y".repeat(300),
    });
    const result = checkAgyArgvSize(args, 100);
    assert.deepEqual(result.oversized.map((o) => o.element), ["prompt", "schema"]);
    assert.match(
      result.message,
      /the prompt \(-p\) is 200 bytes, and the schema \(--json-schema\) is 300 bytes/,
    );
  });

  it("measures BYTES, not string length (criterion 4)", () => {
    const jp = "実装".repeat(30); // 60 characters, 180 UTF-8 bytes
    assert.equal(jp.length, 60);
    assert.ok(jp.length < 100, "the .length reading must be UNDER the limit");
    const result = checkAgyArgvSize(["-p", jp], 100);
    assert.equal(result.ok, false);
    assert.equal(result.oversized[0].bytes, 180);
  });

  it("falls back to a positional name for an element with no known flag", () => {
    const result = checkAgyArgvSize(["x".repeat(200)], 100);
    assert.equal(result.oversized[0].element, "argv[0]");
    assert.equal(result.oversized[0].flag, null);
  });
});

describe("agyDispatch — an oversized argv is refused before the spawn", () => {
  let ctx;

  beforeEach(() => { ctx = fakeAgyContext(); });
  afterEach(() => { ctx.restore(); });

  it("refuses, never spawns, and finalises the record with why (criterion 1)", async () => {
    const oversized = "x".repeat(AGY_MAX_ARG_BYTES + 1);
    const { job, resultText, stateDir } = await agyDispatch(
      ctx.dispatchOptions({ promptText: oversized }),
    );

    // NOTHING was started: the fake binary logged no argv and no pid.
    assert.deepEqual(loggedArgs(ctx.argsLog), []);
    assert.equal(fs.readFileSync(ctx.pidsLog, "utf8"), "");
    assert.equal(job.process, null);

    // A caller error, not a provider outage — the same brief would fail
    // identically on the next agy dispatch, so a retry walk must not be
    // invited by a provider-error classification.
    assert.equal(job.status, "error");
    assert.equal(job.failure, null);
    assert.notEqual(job.status, "provider-error");
    assert.ok(job.finishedAt, "a refused dispatch is finished, not left running");

    assert.match(job.error, /the prompt \(-p\) is 130049 bytes/);
    assert.match(job.error, /130048-byte per-argument limit/);
    assert.match(job.error, /MAX_ARG_STRLEN is 131072/);
    assert.match(job.error, /shrink the brief/);
    assert.match(job.error, /--model claude/);
    assert.match(job.error, /opencode model/);
    assert.equal(resultText, "");

    // Persisted the same way every other failure on this backend is.
    assert.equal(loadJob(stateDir, job.id).status, "error");

    const jdir = jobDir(stateDir, job.id);
    // prompt.md is written even though nothing ran: the operator of a
    // refused dispatch is the one who most needs to see what was too big.
    assert.equal(fs.readFileSync(path.join(jdir, "prompt.md"), "utf8"), oversized);
    assert.ok(!fs.existsSync(path.join(jdir, "result.md")));

    const events = fs.readFileSync(path.join(jdir, "events.ndjson"), "utf8")
      .trim().split("\n").map(JSON.parse);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "companion.agy.argv-too-large");
    assert.equal(events[0].backend, "agy");
    assert.equal(events[0].model, "gemini-3.6-flash-high");
    assert.equal(events[0].limit, AGY_MAX_ARG_BYTES);
    // The MEASURED sizes, so the refusal can be checked rather than trusted.
    assert.deepEqual(events[0].oversized, [
      { index: 1, element: "prompt", flag: "-p", bytes: AGY_MAX_ARG_BYTES + 1 },
    ]);
    // No dispatch event: nothing was dispatched.
    assert.deepEqual(events.filter((e) => e.type === "companion.agy.dispatch"), []);
    assert.deepEqual(events.filter((e) => e.type === "companion.agy.finished"), []);
  });

  it("a prompt exactly AT the limit dispatches exactly as today (criterion 3)", async () => {
    // Also a live check that the margin is not over-tight: this 130048-byte
    // argument really does survive a real spawn on a real kernel.
    const atLimit = "x".repeat(AGY_MAX_ARG_BYTES);
    const { job, resultText, stateDir } = await agyDispatch(
      ctx.dispatchOptions({ promptText: atLimit }),
    );

    assert.equal(job.status, "completed");
    assert.equal(resultText, "implemented the thing per the brief");
    const calls = loggedArgs(ctx.argsLog);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      "-p", atLimit,
      "--output-format", "json",
      "--model", "gemini-3.6-flash-high",
      "--print-timeout", "5m20s",
    ]);

    const events = fs.readFileSync(path.join(jobDir(stateDir, job.id), "events.ndjson"), "utf8")
      .trim().split("\n").map(JSON.parse);
    assert.equal(events[0].type, "companion.agy.dispatch");
    assert.equal(events.at(-1).type, "companion.agy.finished");
    assert.deepEqual(events.filter((e) => e.type === "companion.agy.argv-too-large"), []);
  });

  it("refuses a brief that is under the limit by .length but over it in bytes (criterion 4)", async () => {
    const jp = "実装してください。".repeat(6000); // 54000 chars, 162000 bytes
    assert.ok(jp.length < AGY_MAX_ARG_BYTES, "the .length reading must be UNDER the limit");

    const { job } = await agyDispatch(ctx.dispatchOptions({ promptText: jp }));

    assert.deepEqual(loggedArgs(ctx.argsLog), []);
    assert.equal(job.status, "error");
    assert.match(job.error, /the prompt \(-p\) is 162000 bytes/);
  });

  it("counts the ROLE BLOCK too — the composed prompt is what rides argv", async () => {
    // buildAgyPrompt prepends the agent's role body; the guard runs on the
    // composed prompt, not the caller's, so a brief that only goes over
    // AFTER composition is still refused.
    const roleBody = readAgentSystemPrompt("kusabi-review");
    assert.ok(roleBody && roleBody.length > 0, "the review role body must be non-empty");
    const justUnder = "x".repeat(AGY_MAX_ARG_BYTES - 100);
    const composed = buildAgyPrompt({ systemPrompt: roleBody, promptText: justUnder });
    assert.ok(Buffer.byteLength(composed, "utf8") > AGY_MAX_ARG_BYTES);

    const { job } = await agyDispatch(
      ctx.dispatchOptions({ promptText: justUnder, agent: "kusabi-review", phase: "review" }),
    );
    assert.deepEqual(loggedArgs(ctx.argsLog), []);
    assert.equal(job.status, "error");
    assert.match(job.error, /the prompt \(-p\) is \d+ bytes/);
  });
});

describe("the argv size guard is agy-only (criterion 5)", () => {
  it("no other dispatch path imports it or re-implements the rule", () => {
    // claude passes its prompt over stdin and opencode goes over HTTP, so
    // neither can hit MAX_ARG_STRLEN — and neither may grow a size check
    // that would refuse work those transports handle fine.
    for (const file of [
      "claude-dispatch.mjs",
      "prompt-execution.mjs",
      "chain-phases.mjs",
      "kusabi-companion.mjs",
    ]) {
      const source = fs.readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      assert.doesNotMatch(
        source, /checkAgyArgvSize|AGY_MAX_ARG|MAX_ARG_STRLEN|E2BIG/,
        `${file} must not carry the agy argv size check`,
      );
    }
  });
});
