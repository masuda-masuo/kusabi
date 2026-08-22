import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  parseModel,
  resolveModel,
  implementDenyTools,
  reviewDenyTools,
} from "./cli.mjs";

// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("parses a value flag: --prior", () => {
    const result = parseArgs(["--prior", "previous findings"]);
    assert.equal(result.flags.prior, "previous findings");
  });

  it("parses a value flag: --model", () => {
    const result = parseArgs(["--model", "anthropic/claude-4"]);
    assert.equal(result.flags.model, "anthropic/claude-4");
  });

  it("parses a boolean flag: --wait", () => {
    const result = parseArgs(["--wait"]);
    assert.equal(result.flags.wait, true);
  });

  it("parses -- as literal separator and puts rest in text", () => {
    const result = parseArgs(["--prior", "x", "--", "extra", "args"]);
    assert.equal(result.flags.prior, "x");
    assert.equal(result.text, "extra args");
  });

  it("throws on unknown flag", () => {
    assert.throws(
      () => parseArgs(["--nope"]),
      /unknown flag: --nope/,
    );
  });

  it("returns empty flags and text for empty argv", () => {
    const result = parseArgs([]);
    assert.deepEqual(result.flags, {});
    assert.equal(result.text, "");
  });

  it("parses --cursor-usage-dir as a value flag", () => {
    const result = parseArgs(["--cursor-usage-dir", "/tmp/cu"]);
    assert.equal(result.flags["cursor-usage-dir"], "/tmp/cu");
  });

  it("treats -h as a boolean flag", () => {
    const result = parseArgs(["-h"]);
    assert.equal(result.flags.h, true);
  });

});

// parseArgs — --max-rounds flag
// ---------------------------------------------------------------------------

describe("parseArgs max-rounds", () => {
  it("parses --max-rounds flag", () => {
    const result = parseArgs(["--max-rounds", "5"]);
    // Value flags use arg.slice(2) directly, so key is "max-rounds" (hyphenated)
    assert.equal(result.flags["max-rounds"], "5");
  });

  it("defaults to undefined when not provided", () => {
    const result = parseArgs([]);
    assert.equal(result.flags["max-rounds"], undefined);
  });

  it("parses --max-rounds in chain context", () => {
    const result = parseArgs(["--container", "abc123", "--model", "anthropic/claude-4", "--max-rounds", "5", "implement the thing"]);
    assert.equal(result.flags.container, "abc123");
    assert.equal(result.flags.model, "anthropic/claude-4");
    assert.equal(result.flags["max-rounds"], "5");
    assert.equal(result.text, "implement the thing");
  });
});

// parseArgs — --brief-file flag
// ---------------------------------------------------------------------------

describe("parseArgs brief-file", () => {
  it("parses --brief-file as a value flag", () => {
    const result = parseArgs(["--brief-file", "/tmp/test-brief.md"]);
    assert.equal(result.flags["brief-file"], "/tmp/test-brief.md");
  });

  it("does not set --brief-file when not provided", () => {
    const result = parseArgs(["some inline text"]);
    assert.equal(result.flags["brief-file"], undefined);
  });

  it("combines --brief-file with other flags", () => {
    const result = parseArgs(["--model", "p/m", "--brief-file", "/tmp/b.md", "--", "text"]);
    assert.equal(result.flags.model, "p/m");
    assert.equal(result.flags["brief-file"], "/tmp/b.md");
    // text after -- is literal; brief-file flag was consumed before --
    assert.equal(result.text, "text");
  });
});

// parseArgs -- flag-without-value errors
// ---------------------------------------------------------------------------

describe("parseArgs flag value required", () => {
  it("throws when --brief-file has no value", () => {
    assert.throws(
      () => parseArgs(["--brief-file"]),
      /--brief-file requires a value/,
    );
  });

  it("throws when --brief-file is followed by another flag", () => {
    assert.throws(
      () => parseArgs(["--brief-file", "--model", "p/m"]),
      /--brief-file requires a value/,
    );
  });

  it("throws when --model has no value (same pattern)", () => {
    assert.throws(
      () => parseArgs(["--model"]),
      /--model requires a value/,
    );
  });
});

// ---------------------------------------------------------------------------
// resolveModel — model resolution precedence
// ---------------------------------------------------------------------------

describe("resolveModel", () => {
  it("returns built-in default chain when no flag and no config", () => {
    const result = resolveModel({ flag: undefined, phase: undefined, config: null });
    assert.ok(result.model, "should resolve a model");
    assert.equal(result.model.providerID, "opencode");
    assert.equal(result.model.modelID, "deepseek-v4-flash-free");
    assert.equal(result.model.variant, "max");
    assert.ok(Array.isArray(result.chain));
    assert.equal(result.chain.length, 2);
    assert.ok(Array.isArray(result.chain[0]));
    assert.equal(result.chain[0][0], "opencode/deepseek-v4-flash-free:max");
    assert.equal(result.chain[0][1], "opencode-go/deepseek-v4-flash:max");
  });

  it("uses explicit --model flag over everything", () => {
    const config = {
      models: {
        chain: ["opencode-go/deepseek-v4-flash", "opencode-go/deepseek-v4-pro"],
        phases: { implement: ["anthropic/claude-4"] },
      },
    };
    const result = resolveModel({ flag: "some-provider/some-model", phase: "implement", config });
    assert.equal(result.model.providerID, "some-provider");
    assert.equal(result.model.modelID, "some-model");
  });

  it("uses per-phase chain first entry when phase matches", () => {
    const config = {
      models: {
        chain: ["opencode-go/deepseek-v4-flash", "opencode-go/deepseek-v4-pro"],
        phases: { implement: ["anthropic/claude-4"] },
      },
    };
    const result = resolveModel({ flag: undefined, phase: "implement", config });
    assert.equal(result.model.providerID, "anthropic");
    assert.equal(result.model.modelID, "claude-4");
  });

  it("uses global chain first entry when no phase match", () => {
    const config = {
      models: {
        chain: ["opencode-go/deepseek-v4-flash", "opencode-go/deepseek-v4-pro"],
        phases: { implement: ["anthropic/claude-4"] },
      },
    };
    const result = resolveModel({ flag: undefined, phase: "review", config });
    assert.equal(result.model.providerID, "opencode-go");
    assert.equal(result.model.modelID, "deepseek-v4-flash");
  });

  it("uses global chain first entry when no phases config at all", () => {
    const config = {
      models: {
        chain: ["opencode-go/deepseek-v4-flash", "opencode-go/deepseek-v4-pro"],
      },
    };
    const result = resolveModel({ flag: undefined, phase: "implement", config });
    assert.equal(result.model.providerID, "opencode-go");
    assert.equal(result.model.modelID, "deepseek-v4-flash");
  });

  it("returns full chain from config when present", () => {
    const config = {
      models: {
        chain: ["opencode-go/m1", "opencode-go/m2"],
        phases: { implement: ["opencode-go/m3"] },
      },
    };
    const result = resolveModel({ flag: undefined, phase: "implement", config });
    assert.deepEqual(result.chain, ["opencode-go/m3"]);
  });

  it("returns global chain when no per-phase override", () => {
    const config = {
      models: {
        chain: ["opencode-go/m1", "opencode-go/m2"],
      },
    };
    const result = resolveModel({ flag: undefined, phase: "implement", config });
    assert.deepEqual(result.chain, ["opencode-go/m1", "opencode-go/m2"]);
  });

  it("returns built-in default chain when config has no models.chain", () => {
    const config = { models: { phases: { implement: ["p/m"] } } };
    const result = resolveModel({ flag: undefined, phase: "review", config });
    // No per-phase match for review, no global chain -> built-in
    assert.equal(result.model.providerID, "opencode");
    assert.equal(result.model.modelID, "deepseek-v4-flash-free");
    assert.equal(result.chain.length, 2);
  });

  it("explicit flag + no config still returns built-in chain", () => {
    const result = resolveModel({ flag: "explicit/p", phase: undefined, config: null });
    assert.equal(result.model.providerID, "explicit");
    assert.equal(result.model.modelID, "p");
    // chain should still be the built-in default when no config
    assert.equal(result.chain.length, 2);
    assert.ok(Array.isArray(result.chain[0]));
  });
});

// parseModel — variant suffix parsing
// ---------------------------------------------------------------------------

describe("parseModel", () => {
  it("parses provider/model without variant", () => {
    const result = parseModel("opencode-go/deepseek-v4-flash");
    assert.deepEqual(result, { providerID: "opencode-go", modelID: "deepseek-v4-flash" });
  });

  it("parses provider/model:variant suffix", () => {
    const result = parseModel("opencode-go/deepseek-v4-flash:max");
    assert.deepEqual(result, { providerID: "opencode-go", modelID: "deepseek-v4-flash", variant: "max" });
  });

  it("parses :high variant suffix", () => {
    const result = parseModel("p/a:high");
    assert.deepEqual(result, { providerID: "p", modelID: "a", variant: "high" });
  });

  it("throws on trailing colon (empty variant)", () => {
    assert.throws(
      () => parseModel("p/a:"),
      (err) => {
        assert.ok(err.message.includes("empty variant in model entry: p/a:"));
        return true;
      },
    );
  });

  it("throws on missing slash (no provider/model separator)", () => {
    assert.throws(
      () => parseModel("just-a-model"),
      (err) => {
        assert.ok(err.message.includes("--model expects provider/model"));
        return true;
      },
    );
  });

  it("returns undefined for empty value", () => {
    assert.equal(parseModel(""), undefined);
    assert.equal(parseModel(undefined), undefined);
    assert.equal(parseModel(null), undefined);
  });

  it("resolves through resolveModel with variant suffix", () => {
    const result = resolveModel({ flag: "p/a:max", phase: undefined, config: null });
    assert.equal(result.model.providerID, "p");
    assert.equal(result.model.modelID, "a");
    assert.equal(result.model.variant, "max");
  });
});

// Model variant — API request body boundary
// ---------------------------------------------------------------------------

describe("model variant API body boundary", () => {
  it("prompt_async body includes variant when model has variant", () => {
    const model = parseModel("p/a:max");
    const body = {
      parts: [{ type: "text", text: "test" }],
      ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
      ...(model?.variant ? { variant: model.variant } : {}),
    };
    assert.equal(body.variant, "max");
    assert.equal(body.model.providerID, "p");
    assert.equal(body.model.modelID, "a");
  });

  it("prompt_async body omits variant when model has no variant", () => {
    const model = parseModel("p/a");
    const body = {
      parts: [{ type: "text", text: "test" }],
      ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
      ...(model?.variant ? { variant: model.variant } : {}),
    };
    assert.equal(body.variant, undefined);
    assert.equal(body.model.providerID, "p");
    assert.equal(body.model.modelID, "a");
  });
});

// implementDenyTools — deny map for implement-phase sessions
// ---------------------------------------------------------------------------

describe("implementDenyTools", () => {
  it("returns a plain object", () => {
    const result = implementDenyTools();
    assert.equal(typeof result, "object");
    assert.notEqual(result, null);
    assert.equal(Array.isArray(result), false);
  });

  it("denies bash, edit, write, patch, task", () => {
    const result = implementDenyTools();
    assert.equal(result.bash, false);
    assert.equal(result.edit, false);
    assert.equal(result.write, false);
    assert.equal(result.patch, false);
    assert.equal(result.task, false);
  });

  it("denies sunaba_copy_project and sunaba_copy_file", () => {
    const result = implementDenyTools();
    assert.equal(result.sunaba_copy_project, false);
    assert.equal(result.sunaba_copy_file, false);
  });

  it("contains exactly 7 keys", () => {
    const result = implementDenyTools();
    const keys = Object.keys(result);
    assert.equal(keys.length, 7);
    assert.ok(keys.includes("bash"));
    assert.ok(keys.includes("edit"));
    assert.ok(keys.includes("write"));
    assert.ok(keys.includes("patch"));
    assert.ok(keys.includes("task"));
    assert.ok(keys.includes("sunaba_copy_project"));
    assert.ok(keys.includes("sunaba_copy_file"));
  });

  it("all values are false", () => {
    const result = implementDenyTools();
    const allFalse = Object.values(result).every((v) => v === false);
    assert.equal(allFalse, true);
  });

  it("returns a fresh object on each call", () => {
    const a = implementDenyTools();
    const b = implementDenyTools();
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
  });
});

// reviewDenyTools — deny map for review-phase sessions
// ---------------------------------------------------------------------------

describe("reviewDenyTools", () => {
  it("returns a plain object", () => {
    const result = reviewDenyTools();
    assert.equal(typeof result, "object");
    assert.notEqual(result, null);
    assert.equal(Array.isArray(result), false);
  });

  it("denies bash, edit, write, patch, task", () => {
    const result = reviewDenyTools();
    assert.equal(result.bash, false);
    assert.equal(result.edit, false);
    assert.equal(result.write, false);
    assert.equal(result.patch, false);
    assert.equal(result.task, false);
  });

  it("denies sunaba_copy_project and sunaba_copy_file", () => {
    const result = reviewDenyTools();
    assert.equal(result.sunaba_copy_project, false);
    assert.equal(result.sunaba_copy_file, false);
  });

  it("denies sunaba_sandbox_issue_write and sunaba_sandbox_pr_review_write", () => {
    const result = reviewDenyTools();
    assert.equal(result.sunaba_sandbox_issue_write, false);
    assert.equal(result.sunaba_sandbox_pr_review_write, false);
  });

  it("contains exactly 9 keys", () => {
    const result = reviewDenyTools();
    const keys = Object.keys(result);
    assert.equal(keys.length, 9);
    assert.ok(keys.includes("bash"));
    assert.ok(keys.includes("edit"));
    assert.ok(keys.includes("write"));
    assert.ok(keys.includes("patch"));
    assert.ok(keys.includes("task"));
    assert.ok(keys.includes("sunaba_copy_project"));
    assert.ok(keys.includes("sunaba_copy_file"));
    assert.ok(keys.includes("sunaba_sandbox_issue_write"));
    assert.ok(keys.includes("sunaba_sandbox_pr_review_write"));
  });

  it("all values are false", () => {
    const result = reviewDenyTools();
    const allFalse = Object.values(result).every((v) => v === false);
    assert.equal(allFalse, true);
  });

  it("returns a fresh object on each call", () => {
    const a = reviewDenyTools();
    const b = reviewDenyTools();
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
  });
});

// selectRoutes — tiered chain route selection with clamp and failed-route memo
// =========================================================================

import { selectRoutes, validateChainEntries, firstRoute, splitRouteBackend, resolveChainBackend, stripClaudePrefixChain } from "./cli.mjs";

describe("selectRoutes", () => {
  const tiers = [
    ["p/flash-free:max", "p/flash:max"],  // tier 0: capacity alternates
    ["p/pro:max"],                         // tier 1: quality step
  ];

  it("round 1 returns tier-0 routes in order", () => {
    const result = selectRoutes({ tiers, round: 1 });
    assert.deepEqual(result, ["p/flash-free:max", "p/flash:max", "p/pro:max"]);
  });

  it("round 2 returns tier-1 routes (clamped to last tier)", () => {
    const result = selectRoutes({ tiers, round: 2 });
    assert.deepEqual(result, ["p/pro:max"]);
  });

  it("round 5 clamps to last tier", () => {
    const result = selectRoutes({ tiers, round: 5 });
    assert.deepEqual(result, ["p/pro:max"]);
  });

  it("explicitModel pins selection to exactly that model when not failed", () => {
    const result = selectRoutes({ tiers, round: 1, explicitModel: "p/custom" });
    assert.deepEqual(result, ["p/custom"]);
  });

  it("explicitModel returns empty array when in failedRoutes", () => {
    const failed = new Set(["p/custom"]);
    const result = selectRoutes({ tiers, round: 1, explicitModel: "p/custom", failedRoutes: failed });
    assert.deepEqual(result, []);
  });

  it("failedRoutes skips dead routes", () => {
    const failed = new Set(["p/flash-free:max"]);
    const result = selectRoutes({ tiers, round: 1, failedRoutes: failed });
    assert.deepEqual(result, ["p/flash:max", "p/pro:max"]);
  });

  it("all routes failed returns empty list", () => {
    const failed = new Set(["p/flash-free:max", "p/flash:max", "p/pro:max"]);
    const result = selectRoutes({ tiers, round: 1, failedRoutes: failed });
    assert.deepEqual(result, []);
  });

  it("all tier-0 routes failed → falls through to tier 1", () => {
    const failed = new Set(["p/flash-free:max", "p/flash:max"]);
    const result = selectRoutes({ tiers, round: 1, failedRoutes: failed });
    assert.deepEqual(result, ["p/pro:max"]);
  });

  it("round 2 with all tier-1 routes failed returns empty", () => {
    const failed = new Set(["p/pro:max"]);
    const result = selectRoutes({ tiers, round: 2, failedRoutes: failed });
    assert.deepEqual(result, []);
  });

  it("flat string tiers work (backward compat)", () => {
    const flatTiers = ["p/a", "p/b", "p/c"];
    assert.deepEqual(selectRoutes({ tiers: flatTiers, round: 1 }), ["p/a", "p/b", "p/c"]);
    assert.deepEqual(selectRoutes({ tiers: flatTiers, round: 2 }), ["p/b", "p/c"]);
    assert.deepEqual(selectRoutes({ tiers: flatTiers, round: 3 }), ["p/c"]);
    assert.deepEqual(selectRoutes({ tiers: flatTiers, round: 5 }), ["p/c"]);
  });

  it("explicitModel pins selection even when present in tier 0", () => {
    // explicitModel already appears in tier 0
    const result = selectRoutes({ tiers, round: 1, explicitModel: "p/flash-free:max" });
    assert.deepEqual(result, ["p/flash-free:max"]);
  });

  it("empty tiers returns empty array", () => {
    const result = selectRoutes({ tiers: [], round: 1 });
    assert.deepEqual(result, []);
  });

  it("failedRoutes defaults to empty Set when not provided", () => {
    const result = selectRoutes({ tiers, round: 1 });
    assert.deepEqual(result, ["p/flash-free:max", "p/flash:max", "p/pro:max"]);
  });
});

// validateChainEntries — config validation for tiered chains
// =========================================================================

describe("validateChainEntries", () => {
  it("accepts a flat array of strings", () => {
    assert.doesNotThrow(() => validateChainEntries(["p/a", "p/b"], "models.chain"));
  });

  it("accepts a tiered array of string-or-array", () => {
    assert.doesNotThrow(() => validateChainEntries([["p/a", "p/b"], ["p/c"]], "models.chain"));
  });

  it("accepts mixed string and array entries", () => {
    assert.doesNotThrow(() => validateChainEntries(["p/a", ["p/b", "p/c"]], "models.chain"));
  });

  it("rejects an empty chain array with path in message", () => {
    assert.throws(
      () => validateChainEntries([], "models.chain"),
      /"models.chain" must not be empty/,
    );
  });

  it("rejects an empty tier sub-array with path in message", () => {
    assert.throws(
      () => validateChainEntries([[]], "models.chain"),
      /"models.chain\[0\]" must not be an empty array/,
    );
  });

  it("rejects a non-string route with path in message", () => {
    assert.throws(
      () => validateChainEntries([[42]], "models.phases.implement"),
      /"models.phases.implement\[0\]\[0\]" must be a string/,
    );
  });

  it("rejects a non-array, non-string entry with path in message", () => {
    assert.throws(
      () => validateChainEntries([{ invalid: true }], "models.chain"),
      /"models.chain\[0\]" must be a string or array of strings/,
    );
  });

  it("rejects non-array input with path in message", () => {
    assert.throws(
      () => validateChainEntries("not-an-array", "models.chain"),
      /"models.chain" must be an array/,
    );
  });

  it("rejects an empty string route with path in message", () => {
    assert.throws(
      () => validateChainEntries([""], "models.chain"),
      /"models.chain\[0\]" must not be an empty string/,
    );
  });

  it("rejects an empty string inside a tier array", () => {
    assert.throws(
      () => validateChainEntries([["p/a", ""]], "models.chain"),
      /"models.chain\[0\]\[1\]" must not be an empty string/,
    );
  });
});

// firstRoute — resolve the first usable route from a tiered chain
// =========================================================================

describe("firstRoute", () => {
  it("returns the string from a flat chain", () => {
    assert.equal(firstRoute(["p/a", "p/b"]), "p/a");
  });

  it("returns the first route from the first tier", () => {
    assert.equal(firstRoute([["p/a", "p/b"], ["p/c"]]), "p/a");
  });

  it("returns the string when first entry is a string", () => {
    assert.equal(firstRoute(["p/first", ["p/a", "p/b"]]), "p/first");
  });

  it("returns null for empty chain", () => {
    assert.equal(firstRoute([]), null);
  });

  it("returns null for non-array input", () => {
    assert.equal(firstRoute(null), null);
    assert.equal(firstRoute(undefined), null);
  });

  it("returns null when first tier is empty", () => {
    // This would be caught by validateChainEntries but firstRoute handles it gracefully.
    assert.equal(firstRoute([[]]), null);
  });
});

// splitRouteBackend / resolveChainBackend / stripClaudePrefixChain \u2014 per-entry
// backend prefix (kusabi #192)
// =========================================================================

describe("splitRouteBackend", () => {
  it("claude/opus selects the claude backend with model opus", () => {
    assert.deepEqual(splitRouteBackend("claude/opus"), { route: "opus", backend: "claude" });
  });

  it("claude/<full-model-id> selects the claude backend with the full id", () => {
    assert.deepEqual(splitRouteBackend("claude/claude-sonnet-4-5"), { route: "claude-sonnet-4-5", backend: "claude" });
  });

  it("an unprefixed entry is an opencode route, byte-identical", () => {
    assert.deepEqual(splitRouteBackend("opencode/deepseek-v4-flash-free:max"), {
      route: "opencode/deepseek-v4-flash-free:max",
      backend: "opencode",
    });
    assert.deepEqual(splitRouteBackend("p/a:max"), { route: "p/a:max", backend: "opencode" });
  });

  it("a claude/ entry with an empty model is a config error", () => {
    assert.throws(() => splitRouteBackend("claude/"), /empty model/);
  });
});

describe("resolveChainBackend", () => {
  it("an all-claude array is claude", () => {
    assert.equal(resolveChainBackend(["claude/opus", "claude/sonnet"]), "claude");
    assert.equal(resolveChainBackend([["claude/opus"], ["claude/sonnet"]]), "claude");
  });

  it("an all-opencode array is opencode", () => {
    assert.equal(resolveChainBackend(["opencode/x:max", "opencode-go/y:max"]), "opencode");
  });

  it("a flat array mixing backends throws with a clear message", () => {
    assert.throws(
      () => resolveChainBackend(["claude/opus", "opencode/x:max"]),
      /mixes backends/,
    );
    assert.throws(
      () => resolveChainBackend(["opencode/x:max", "claude/opus"]),
      /single-backend/,
    );
  });

  it("a tiered array mixing backends throws (even across tiers)", () => {
    assert.throws(
      () => resolveChainBackend([["claude/opus"], ["opencode/x:max"]]),
      /mixes backends/,
    );
  });

  it("an empty array is opencode (unreachable after validation, graceful anyway)", () => {
    assert.equal(resolveChainBackend([]), "opencode");
  });
});

describe("stripClaudePrefixChain", () => {
  it("strips claude/ prefixes from a flat chain, preserving order", () => {
    assert.deepEqual(stripClaudePrefixChain(["claude/opus", "claude/sonnet"]), ["opus", "sonnet"]);
  });

  it("strips claude/ prefixes from a tiered chain, preserving tier shape", () => {
    assert.deepEqual(
      stripClaudePrefixChain([["claude/opus", "claude/sonnet"], ["claude/opus"]]),
      [["opus", "sonnet"], ["opus"]],
    );
  });

  it("leaves unprefixed entries byte-identical", () => {
    assert.deepEqual(stripClaudePrefixChain(["opencode/x:max", "claude/opus"]), ["opencode/x:max", "opus"]);
  });
});

// =========================================================================
// resolveModelBackend — a --model identifier carries its backend (kusabi #210)
// =========================================================================

import { resolveModelBackend, chainNamesBackend } from "./cli.mjs";

describe("resolveModelBackend", () => {
  it("a claude/ identifier names the claude backend and strips the prefix", () => {
    assert.deepEqual(resolveModelBackend("claude/opus"), { backend: "claude", model: "opus" });
    assert.deepEqual(
      resolveModelBackend("claude/claude-sonnet-4-5"),
      { backend: "claude", model: "claude-sonnet-4-5" },
    );
  });

  it("a provider/model identifier names the opencode backend and keeps the route verbatim", () => {
    assert.deepEqual(
      resolveModelBackend("opencode-go/deepseek-v4-pro:max"),
      { backend: "opencode", model: "opencode-go/deepseek-v4-pro:max" },
    );
  });

  it("a bare alias (no /) names NO backend — the phase keeps its configured one", () => {
    assert.deepEqual(resolveModelBackend("opus"), { backend: null, model: "opus" });
    assert.deepEqual(resolveModelBackend("claude-sonnet-4-5"), { backend: null, model: "claude-sonnet-4-5" });
  });

  it("no --model is null (not a backend decision)", () => {
    assert.equal(resolveModelBackend(undefined), null);
    assert.equal(resolveModelBackend(null), null);
    assert.equal(resolveModelBackend(""), null);
  });

  it("the :variant suffix is carried through untouched — validation belongs to the backend", () => {
    assert.deepEqual(resolveModelBackend("claude/opus:max"), { backend: "claude", model: "opus:max" });
  });

  it("a prefix with an empty model is an error", () => {
    assert.throws(() => resolveModelBackend("claude/"), /empty model/);
  });
});

describe("chainNamesBackend", () => {
  it("finds a claude/ entry in a flat or tiered chain", () => {
    assert.equal(chainNamesBackend(["claude/opus"], "claude"), true);
    assert.equal(chainNamesBackend([["opencode/x:max"], ["claude/opus"]], "claude"), true);
  });

  it("is false when no entry names the backend", () => {
    assert.equal(chainNamesBackend(["opencode/x:max"], "claude"), false);
    assert.equal(chainNamesBackend([], "claude"), false);
  });

  it("is a probe, not the invariant check: a mixed chain does not throw", () => {
    assert.equal(chainNamesBackend(["claude/opus", "opencode/x:max"], "claude"), true);
    assert.equal(chainNamesBackend(["claude/opus", "opencode/x:max"], "opencode"), true);
  });
});
