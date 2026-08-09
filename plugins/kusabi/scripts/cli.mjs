// CLI argument parsing, model resolution, and deny-tools helpers.
// Pure functions — no I/O, no imports from kusabi-companion.mjs.

export const WRITE_TOOL_NAMES = ["bash", "edit", "write", "patch", "task"];

export function implementDenyTools() {
  return Object.fromEntries(
    [...WRITE_TOOL_NAMES, "sunaba_copy_project", "sunaba_copy_file"].map((t) => [t, false]),
  );
}

export function reviewDenyTools() {
  return Object.fromEntries(
    [...WRITE_TOOL_NAMES, "sunaba_copy_project", "sunaba_copy_file", "sunaba_sandbox_issue_write", "sunaba_sandbox_pr_review_write"].map((t) => [t, false]),
  );
}

export function parseArgs(argv) {
  const flags = {};
  const rest = [];
  let literal = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (literal) {
      rest.push(arg);
    } else if (arg === "--") {
      literal = true;
    } else if (
      arg === "--auto" || arg === "--read-only" || arg === "--resume-last" ||
      arg === "--wait" || arg === "--background" || arg === "--keep-serve" || arg === "--help" || arg === "-h" ||
      arg === "--force" || arg === "--dry-run" || arg === "--json"
    ) {
      const key = arg.startsWith("--")
        ? arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        : arg.slice(1);
      flags[key] = true;
    } else if (arg === "--base" || arg === "--model" || arg === "--agent" || arg === "--session" || arg === "--timeout" || arg === "--deny" || arg === "--watchdog" || arg === "--phase" || arg === "--container" || arg === "--prior" || arg === "--max-rounds" || arg === "--brief-file" || arg === "--since" || arg === "--until" || arg === "--compare" || arg === "--transcript-dir" || arg === "--state-root" || arg === "--db" || arg === "--backend") {
      const flagName = arg.slice(2);
      const val = argv[++i];
      if (val === undefined || (typeof val === "string" && val.startsWith("--"))) {
        throw new Error(`${arg} requires a value`);
      }
      flags[flagName] = val;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      rest.push(arg);
    }
  }
  return { flags, text: rest.join(" ").trim() };
}

export function parseModel(value) {
  if (!value) return undefined;
  const idx = value.indexOf("/");
  if (idx < 0) throw new Error(`--model expects provider/model, got: ${value}`);
  const providerID = value.slice(0, idx);
  let modelID = value.slice(idx + 1);
  let variant;
  const vi = modelID.indexOf(":");
  if (vi >= 0) {
    variant = modelID.slice(vi + 1);
    modelID = modelID.slice(0, vi);
    if (!variant) throw new Error(`empty variant in model entry: ${value}`);
  }
  return { providerID, modelID, ...(variant ? { variant } : {}) };
}

/**
 * Built-in default chain — two tiers with :max reasoning variants.
 * Tier 1: flash-free (zen) → flash (go).  Tier 2: pro.
 * Matches DESIGN.md §4: "zen's deepseek-v4-flash-free → go's deepseek v4 Flash"
 * plus "Pro finishing".
 */
export const BUILTIN_DEFAULT_CHAIN = [
  ["opencode/deepseek-v4-flash-free:max", "opencode-go/deepseek-v4-flash:max"],
  ["opencode-go/deepseek-v4-pro:max"],
];

/**
 * Pure function: select ordered route candidates from the tiered chain.
 *
 * Converts each tier entry (string → single-route tier, array → multi-route
 * tier) to a uniform shape, clamps `round` (or explicit `tierIndex`) to the
 * tier count, and returns an ordered list of candidate route strings:
 * remaining routes of the current tier first, then later tiers, skipping
 * routes present in `failedRoutes`.
 * An `explicitModel` (e.g. `--model <entry>`) is prepended when provided
 * and not already failed.
 *
 * When `tierIndex` is provided it takes precedence over `round` — this is
 * used by the chain to decouple model tier from the round counter.
 *
 * @param {object}   opts
 * @param {(string|string[])[]} opts.tiers        — Tiered chain entries.
 * @param {number}             [opts.round]       — 1-based round number (used
 *                                                  when tierIndex is not given).
 * @param {number}             [opts.tierIndex]   — Explicit 0-based tier index.
 *                                                  Overrides round when set.
 * @param {string|null}        [opts.explicitModel] — --model flag value.
 * @param {Set<string>}        [opts.failedRoutes]  — Routes already known dead.
 * @returns {string[]} Ordered candidate route strings.
 */
export function selectRoutes({ tiers, round, tierIndex, explicitModel, failedRoutes }) {
  const failed = failedRoutes ?? new Set();
  // Normalise: string → [string]; array → its own copy.
  const normalized = tiers.map(function (t) {
    return typeof t === "string" ? [t] : [...t];
  });
  if (normalized.length === 0) return [];

  // Use explicit tierIndex when given, otherwise derive from round.
  const effectiveTierIndex = tierIndex !== undefined
    ? Math.min(tierIndex, normalized.length - 1)
    : Math.min(round - 1, normalized.length - 1);

  /** @type {string[]} */
  const candidates = [];

  // --model override prepended when present and not dead.
  if (explicitModel && !failed.has(explicitModel)) {
    candidates.push(explicitModel);
  }

  // Current tier first, then latent tiers.
  for (let i = effectiveTierIndex; i < normalized.length; i++) {
    for (const route of normalized[i]) {
      if (route !== explicitModel && !failed.has(route) && !candidates.includes(route)) {
        candidates.push(route);
      }
    }
  }

  return candidates;
}

/**
 * Validate tiered chain entries from config.
 *
 * Accepts both flat (all-string) and tiered (mixed string|array) chains.
 * Throws with a message that names the config path on invalid input.
 *
 * @param {(string|string[])[]} entries
 * @param {string}              configPath  — e.g. "models.chain" or "models.phases.implement"
 * @throws {Error} On empty chain, empty tier, non-string route, or wrong type.
 */
export function validateChainEntries(entries, configPath) {
  if (!Array.isArray(entries)) {
    throw new Error(`kusabi config: "${configPath}" must be an array`);
  }
  if (entries.length === 0) {
    throw new Error(`kusabi config: "${configPath}" must not be empty (omit to use defaults)`);
  }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const subPath = `${configPath}[${i}]`;
    if (typeof entry === "string") {
      if (entry === "") {
        throw new Error(`kusabi config: "${subPath}" must not be an empty string`);
      }
      continue;
    }
    if (Array.isArray(entry)) {
      if (entry.length === 0) {
        throw new Error(`kusabi config: "${subPath}" must not be an empty array`);
      }
      for (let j = 0; j < entry.length; j++) {
        if (typeof entry[j] !== "string") {
          throw new Error(`kusabi config: "${subPath}[${j}]" must be a string`);
        }
        if (entry[j] === "") {
          throw new Error(`kusabi config: "${subPath}[${j}]" must not be an empty string`);
        }
      }
      continue;
    }
    throw new Error(`kusabi config: "${subPath}" must be a string or array of strings`);
  }
}

/**
 * Resolve the first route string from a tiered chain.
 *
 * @param {(string|string[])[]} chain
 * @returns {string|null}
 */
export function firstRoute(chain) {
  if (!Array.isArray(chain) || chain.length === 0) return null;
  const entry = chain[0];
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry) && entry.length > 0) return entry[0];
  return null;
}

export function resolveModel({ flag, phase, config }) {
  // Determine the full ordered chain (may be tiered: string|string[])
  let chain;
  if (config?.models?.chain) {
    chain = [...config.models.chain];
  } else {
    chain = [...BUILTIN_DEFAULT_CHAIN];
  }

  // If we have an explicit --model flag, use it directly as the first model,
  // but still carry the chain for fallback.
  if (flag) {
    return { model: parseModel(flag), chain };
  }

  // Per-phase override
  if (phase && config?.models?.phases?.[phase]) {
    const phaseChain = config.models.phases[phase];
    const first = firstRoute(phaseChain);
    if (first) {
      return { model: parseModel(first), chain: phaseChain };
    }
  }

  // Global chain first entry
  const firstGlobal = firstRoute(chain);
  if (firstGlobal) {
    return { model: parseModel(firstGlobal), chain };
  }

  // No model resolved
  return { model: undefined, chain };
}
