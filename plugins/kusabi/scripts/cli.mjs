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
      arg === "--force" || arg === "--dry-run" || arg === "--json" || arg === "--cursor-rule" ||
      arg === "--next"
    ) {
      const key = arg.startsWith("--")
        ? arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        : arg.slice(1);
      flags[key] = true;
    } else if (arg === "--base" || arg === "--model" || arg === "--agent" || arg === "--session" || arg === "--timeout" || arg === "--deny" || arg === "--watchdog" || arg === "--phase" || arg === "--container" || arg === "--prior" || arg === "--max-rounds" || arg === "--brief-file" || arg === "--since" || arg === "--until" || arg === "--compare" || arg === "--transcript-dir" || arg === "--cursor-usage-dir" || arg === "--state-root" || arg === "--db" || arg === "--backend" || arg === "--poll-interval" || arg === "--appear-timeout" || arg === "--progress-timeout" || arg === "--port") {
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

  if (explicitModel) {
    return failed.has(explicitModel) ? [] : [explicitModel];
  }

  // Normalise: string -> [string]; array -> its own copy.
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

  // Current tier first, then latent tiers.
  for (let i = effectiveTierIndex; i < normalized.length; i++) {
    for (const route of normalized[i]) {
      if (!failed.has(route) && !candidates.includes(route)) {
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
export const CURSOR_ENTRY_PREFIX = "cursor/";

/**
 * The backend-naming prefixes, as a TABLE: a further backend is one row
 * here, never a new branch in the resolution — which is exactly how the agy
 * backend (kusabi #199) was added.  opencode has no row on purpose — it is
 * the unprefixed default (an entry with no row's prefix is an opencode
 * `provider/model[:variant]` route), which is what keeps every pre-prefix
 * config byte-identical.
 *
 * @type {ReadonlyArray<{ prefix: string, backend: "claude"|"agy"|"cursor" }>}
 */
export const BACKEND_ENTRY_PREFIXES = [
  { prefix: CLAUDE_ENTRY_PREFIX, backend: "claude" },
  { prefix: AGY_ENTRY_PREFIX, backend: "agy" },
  { prefix: CURSOR_ENTRY_PREFIX, backend: "cursor" },
];

/**
 * Which backends can continue a previous session, as a TABLE.
 *
 * opencode and claude both resume (`opencode -s <ses_*>` /
 * `claude -p --resume <uuid>`).  The agy backend resumes too (kusabi #316):
 * the Antigravity CLI takes `--conversation <id>` (the same
 * `conversation_id` kusabi stores as the job's `sessionID`), so the entry
 * flipped when the dispatch grew the flag — the CLI offered it from the
 * start (#199's survey simply did not list it).
 *
 * The seams that carry a session across rounds consult this rather than
 * naming a backend.  agy differs from the other two in ONE extra gate: a
 * bare-UUID id is ambiguous between agy and claude, so `agyDispatch`
 * resumes only what the job store proves an agy job recorded (the
 * provenance signal) — see assertNoAgySession in agy-dispatch.mjs.
 *
 * @type {Readonly<Record<string, boolean>>}
 */
export const BACKEND_RESUME_SUPPORT = {
  opencode: true,
  claude: true,
  agy: true,
  cursor: true, // MEASURED 2026-08-23: --resume <session_id> carries context
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
 * Validate a single route string against its backend syntax (kusabi #470).
 *
 * opencode routes: provider/model[:variant] (via parseModel)
 * agy / claude / cursor: plain model ids (no :variant suffix)
 * Empty prefix (e.g. "agy/") is rejected by splitRouteBackend.
 *
 * @param {string} route
 * @returns {{ route: string, backend: "opencode"|"claude"|"agy"|"cursor" }}
 * @throws {Error} On invalid model syntax, :variant suffix for non-opencode, or empty prefix.
 */
export function validateRoute(route) {
  const { route: model, backend } = splitRouteBackend(route);
  if (backend === "opencode") {
    parseModel(route);
  } else if (backend === "agy") {
    if (model.includes(":")) {
      throw new Error(
        `agy backend does not support the :variant suffix in model "${model}" — ` +
        "use a plain agy model id (e.g. gemini-3.6-flash-high); the agy CLI validates which ids exist"
      );
    }
  } else if (backend === "claude") {
    if (model.includes(":")) {
      throw new Error(
        `claude backend does not support the :variant suffix in model "${model}" — ` +
        "use a bare alias (opus, sonnet, haiku) or a full model id (e.g. claude-sonnet-4-5)"
      );
    }
  } else if (backend === "cursor") {
    if (model.includes(":")) {
      throw new Error(
        `cursor backend does not support the :variant suffix in model "${model}" — ` +
        "use a plain cursor model id or the literal default"
      );
    }
  }
  return { route: model, backend };
}

/**
 * True when a (tiered) chain array contains routes from more than one backend (kusabi #470).
 *
 * @param {(string|string[])[]} chain
 * @returns {boolean}
 */
export function isMixedChain(chain) {
  let first = null;
  for (const tier of Array.isArray(chain) ? chain : []) {
    const routes = Array.isArray(tier) ? tier : [tier];
    for (const route of routes) {
      const { backend } = splitRouteBackend(route);
      if (first === null) {
        first = backend;
      } else if (first !== backend) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Determine the starting backend of a (tiered) chain array from its entries.
 *
 * Under kusabi #470, one phase's chain array may mix backends to form a capacity
 * escalation ladder (e.g. opencode free routes falling through to agy).
 * resolveChainBackend stops throwing solely because an array mixes backends;
 * instead, it returns the backend of the first route in the chain (defaulting
 * to "opencode" when empty).
 * Every route is validated against its own backend syntax (validateRoute).
 *
 * @param {(string|string[])[]} chain
 * @returns {"opencode"|"claude"|"agy"|"cursor"} The chain's starting backend
 * @throws {Error} On per-route bad spelling or empty model prefix.
 */
export function resolveChainBackend(chain) {
  let firstBackend = null;
  for (const tier of Array.isArray(chain) ? chain : []) {
    const routes = Array.isArray(tier) ? tier : [tier];
    for (const route of routes) {
      const { backend } = validateRoute(route);
      if (firstBackend === null) {
        firstBackend = backend;
      }
    }
  }
  return firstBackend ?? "opencode";
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
