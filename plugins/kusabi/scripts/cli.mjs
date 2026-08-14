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
    } else if (arg === "--base" || arg === "--model" || arg === "--agent" || arg === "--session" || arg === "--timeout" || arg === "--deny" || arg === "--watchdog" || arg === "--phase" || arg === "--container" || arg === "--prior" || arg === "--max-rounds" || arg === "--brief-file" || arg === "--since" || arg === "--until" || arg === "--compare" || arg === "--transcript-dir" || arg === "--cursor-usage-dir" || arg === "--state-root" || arg === "--db" || arg === "--backend") {
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

// ---------------------------------------------------------------------------
// per-entry backend prefix (kusabi #192; third backend kusabi #199)
// ---------------------------------------------------------------------------
// Config chain entries may carry an explicit backend prefix: an entry of the
// form `claude/<model>` selects the claude backend with model `<model>` (a
// bare alias like `opus` or a full model id), and `agy/<model>` selects the
// agy (Antigravity CLI) backend the same way; any entry WITHOUT a prefix is
// an opencode `provider/model[:variant]` route, byte-identical to before the
// prefix existed.  Neither `claude` nor `agy` is an opencode provider name,
// so the prefixes are unambiguous.  The `:variant` suffix stays rejected on
// both prefixed backends (see claude-dispatch.mjs validateClaudeModel /
// agy-dispatch.mjs validateAgyModel).

export const CLAUDE_ENTRY_PREFIX = "claude/";
export const AGY_ENTRY_PREFIX = "agy/";

/**
 * The backend-naming prefixes, as a TABLE: a further backend is one row
 * here, never a new branch in the resolution — which is exactly how the agy
 * backend (kusabi #199) was added.  opencode has no row on purpose — it is
 * the unprefixed default (an entry with no row's prefix is an opencode
 * `provider/model[:variant]` route), which is what keeps every pre-prefix
 * config byte-identical.
 *
 * @type {ReadonlyArray<{ prefix: string, backend: "claude"|"agy" }>}
 */
export const BACKEND_ENTRY_PREFIXES = [
  { prefix: CLAUDE_ENTRY_PREFIX, backend: "claude" },
  { prefix: AGY_ENTRY_PREFIX, backend: "agy" },
];

/**
 * Which backends can continue a previous session, as a TABLE.
 *
 * opencode and claude both resume (`opencode -s <ses_*>` /
 * `claude -p --resume <uuid>`).  The agy backend is fresh-dispatch only in
 * v1 (kusabi #199): the Antigravity CLI records a `conversation_id` that
 * kusabi stores as the job's `sessionID`, but nothing consumes it yet.
 *
 * The seams that carry a session across rounds consult this rather than
 * naming a backend, so a backend that cannot resume never has a session
 * manufactured for it — and an operator who ASKS for one (`--session` /
 * `--resume-last`) is told no, loudly, instead of having the request
 * silently dropped.
 *
 * @type {Readonly<Record<string, boolean>>}
 */
export const BACKEND_RESUME_SUPPORT = {
  opencode: true,
  claude: true,
  agy: false,
};

/**
 * True when `backend` can continue a previous session.  An unknown backend
 * is treated as resuming (the pre-#199 default), so this can never silently
 * disable resume for a backend added later without a table row.
 *
 * @param {string|null|undefined} backend
 * @returns {boolean}
 */
export function backendSupportsResume(backend) {
  const known = BACKEND_RESUME_SUPPORT[backend ?? "opencode"];
  return known === undefined ? true : known;
}

/**
 * Split one route entry into its backend and its backend-specific model
 * spelling.  `claude/opus` → `{ route: "opus", backend: "claude" }`;
 * `agy/gemini-3.6-flash-high` → `{ route: "gemini-3.6-flash-high",
 * backend: "agy" }`; `opencode/x:max` (and any other unprefixed entry) →
 * itself with backend "opencode".  A bare prefix (`claude/`, `agy/` — an
 * empty model) is a config error.
 *
 * @param {string} route
 * @returns {{ route: string, backend: "opencode"|"claude"|"agy" }}
 * @throws {Error} On a prefixed entry with an empty model.
 */
export function splitRouteBackend(route) {
  if (typeof route === "string") {
    for (const { prefix, backend } of BACKEND_ENTRY_PREFIXES) {
      if (!route.startsWith(prefix)) continue;
      const model = route.slice(prefix.length);
      if (!model) {
        throw new Error(
          `kusabi config: chain entry "${prefix}" has an empty model — use ${prefix}<model> (bare alias or full model id)`
        );
      }
      return { route: model, backend };
    }
  }
  return { route, backend: "opencode" };
}

/**
 * Resolve a `--model` flag value into the backend it NAMES and the model
 * spelling that backend takes (kusabi #210).
 *
 * This is step 0 of the per-phase resolution: the identifier decides the
 * backend, and the model is then validated against the backend that SAME
 * identifier chose — never against a backend decided by a config key three
 * levels away.  Three forms:
 *
 *   `claude/opus`              → { backend: "claude",   model: "opus" }
 *   `opencode-go/ds-pro:max`   → { backend: "opencode", model: "opencode-go/ds-pro:max" }
 *   `opus`                     → { backend: null,       model: "opus" }
 *
 * The third form names NO backend: a bare `--model <alias>` keeps the
 * phase's configured backend, exactly as before this existed.  Only a form
 * that NAMES a backend may move it.
 *
 * The grammar is the config's own (`splitRouteBackend`), including its
 * deliberate asymmetry: a leading `claude/` or `agy/` is a BACKEND, while
 * the first segment of any other slashed identifier is an opencode
 * providerID.  That is why the no-slash case is answered before the split —
 * a bare alias must not read as an opencode route.
 *
 * @param {string|null|undefined} value — the `--model` flag value.
 * @returns {{ backend: "claude"|"agy"|"opencode"|null, model: string }|null}
 *          null when no `--model` was given.
 * @throws {Error} On a prefix with an empty model (`--model claude/`).
 */
export function resolveModelBackend(value) {
  if (value === undefined || value === null || value === "") return null;
  const raw = String(value);
  if (!raw.includes("/")) return { backend: null, model: raw };
  const { route, backend } = splitRouteBackend(raw);
  return { backend, model: route };
}

/**
 * True when ANY route of a (tiered) chain names `backend` through its
 * prefix.  A probe, not the invariant check: unlike `resolveChainBackend`
 * it never throws on a mixed array.
 *
 * @param {(string|string[])[]} chain
 * @param {"opencode"|"claude"} backend
 * @returns {boolean}
 */
export function chainNamesBackend(chain, backend) {
  for (const tier of Array.isArray(chain) ? chain : []) {
    for (const route of Array.isArray(tier) ? tier : [tier]) {
      if (splitRouteBackend(route).backend === backend) return true;
    }
  }
  return false;
}

/**
 * Determine the single backend of a (tiered) chain array from its entries.
 *
 * kusabi #192 invariant: one phase's chain array is single-backend.  An
 * array mixing entries of two backends (`claude/` with opencode, `agy/`
 * with `claude/`, …) is a config error and throws — the per-phase backend
 * would be ambiguous.  The check runs at command start
 * (resolveDispatchBackend), before createChainDir and before any job is
 * dispatched.  Per-route mixed ladders within one phase are out of scope by
 * design.
 *
 * The message names the TWO backends actually found rather than a hardcoded
 * pair, so a third backend (kusabi #199) reports itself instead of being
 * described as something it is not.
 *
 * @param {(string|string[])[]} chain
 * @returns {"opencode"|"claude"|"agy"} The chain's single backend
 *          ("opencode" for an empty/unknown chain, which callers never reach
 *          post-validation).
 * @throws {Error} When the array mixes two backends' entries.
 */
export function resolveChainBackend(chain) {
  let backend = null;
  for (const tier of Array.isArray(chain) ? chain : []) {
    const routes = Array.isArray(tier) ? tier : [tier];
    for (const route of routes) {
      const b = splitRouteBackend(route).backend;
      if (backend === null) {
        backend = b;
      } else if (backend !== b) {
        throw new Error(
          `kusabi config: chain mixes backends — one chain array contains both ${backend} and ${b} entries ` +
          `(${JSON.stringify(chain)}); each phase's chain must be single-backend (per-phase mixing is ` +
          `across phases, never within one array)`
        );
      }
    }
  }
  return backend ?? "opencode";
}

/**
 * Strip the backend prefix (`claude/`, `agy/`) from every route of a
 * (tiered) chain, preserving the tier shape.  Used once the backend is
 * decided: the downstream dispatch expects that backend's own model
 * spelling, never the prefix.  Unprefixed (opencode) entries pass through
 * byte-identical.
 *
 * @param {(string|string[])[]} chain
 * @returns {(string|string[])[]}
 */
export function stripBackendPrefixChain(chain) {
  return chain.map((tier) => {
    if (Array.isArray(tier)) return tier.map((r) => splitRouteBackend(r).route);
    return splitRouteBackend(tier).route;
  });
}

/**
 * Pre-#199 name for `stripBackendPrefixChain`, kept as an alias because it
 * never was claude-specific (it strips whatever prefix `splitRouteBackend`
 * recognises) and existing callers/tests import it under this name.
 */
export const stripClaudePrefixChain = stripBackendPrefixChain;

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
