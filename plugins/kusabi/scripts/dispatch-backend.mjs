// dispatch-backend: the dispatch backend selection table (kusabi #184) moved
// out of kusabi-companion.mjs verbatim (pure move refactor): BACKENDS,
// resolveBackend, backendDispatch, backendPinsModel, phaseDispatchFor,
// assertSessionBackendCompatible, resolveDispatchBackend, the per-backend
// resolve*PhaseDispatch helpers and resolveResumeLastSession.  No behaviour
// change.

import {
  resolveModel,
  splitRouteBackend,
  resolveChainBackend,
  stripBackendPrefixChain,
  resolveModelBackend,
  chainNamesBackend,
  isMixedChain,
} from "./cli.mjs";
import { dispatchWithFallback } from "./prompt-execution.mjs";
import {
  claudeDispatch,
  resolveClaudeModel,
  validateClaudeModel,
  validateClaudeChain,
  clampModelDispatch,
  CLAUDE_BACKEND,
} from "./claude-dispatch.mjs";
import {
  agyDispatch,
  resolveAgyModel,
  validateAgyModel,
  validateAgyChain,
  AGY_BACKEND,
} from "./agy-dispatch.mjs";
import {
  codexDispatch,
  resolveCodexModel,
  validateCodexModel,
  validateCodexChain,
  CODEX_BACKEND,
} from "./codex-dispatch.mjs";
import { latestJob } from "./job-store.mjs";

// ---------------------------------------------------------------------------
// dispatch backend selection (kusabi #184)
// ---------------------------------------------------------------------------

export const BACKENDS = ["opencode", "claude", "agy", "codex"];

/**
 * Resolve the dispatch backend from the `--backend` flag.  Resolved ONCE at
 * command start (`task` / `chain`); every job and chain record written by
 * the command carries the result as its `backend` field.  Old records
 * without the field are treated as `"opencode"` by readers.
 *
 * @param {object} flags — parsed flags (may carry `backend`).
 * @returns {"opencode"|"claude"|"agy"|"codex"}
 * @throws {Error} For any unknown backend value.
 */
export function resolveBackend(flags) {
  const backend = flags.backend || "opencode";
  if (!BACKENDS.includes(backend)) {
    throw new Error(`unknown backend: ${backend}. Use --backend ${BACKENDS.join("|")}`);
  }
  return backend;
}

/**
 * The canonical dispatch function of a backend — the one a phase gets when
 * nothing more specific was injected.
 *
 * A TABLE, not a chain of `=== "claude"` comparisons: adding the agy backend
 * (kusabi #199) is one row, and every seam that needs "the dispatch of THIS
 * backend" reads the same row.  opencode is the fallback because a record
 * without a `backend` field predates the split and IS opencode (the reader
 * contract every other surface applies).
 *
 * @param {string|null|undefined} backend
 * @returns {Function}
 */
export function backendDispatch(backend) {
  if (backend === CLAUDE_BACKEND) return claudeDispatch;
  if (backend === AGY_BACKEND) return agyDispatch;
  if (backend === CODEX_BACKEND) return codexDispatch;
  return dispatchWithFallback;
}

/**
 * True when the backend pins ONE model per phase instead of walking the
 * capacity ladder — the v1 shape of the non-opencode backends.
 *
 * The chain commands read this rather than naming a backend: they wrap such
 * a dispatch in `clampModelDispatch` so later rounds reuse the command-start
 * model.
 *
 * @param {string|null|undefined} backend
 * @returns {boolean}
 */
export function backendPinsModel(backend) {
  return backend === CLAUDE_BACKEND || backend === AGY_BACKEND || backend === CODEX_BACKEND;
}

/**
 * The dispatch a phase runs on, clamped to its command-start model when the
 * backend pins one.  The two facts above, applied together — every chain
 * seam that used to spell out `backend === "claude" ? clampModelDispatch(…)`
 * calls this instead.
 *
 * @param {string} backend
 * @param {Function} dispatch — the backend's dispatch (canonical or injected).
 * @param {string|object|null} model
 * @returns {Function}
 */
export function phaseDispatchFor(backend, dispatch, model) {
  if (dispatch === dispatchWithFallback) return dispatch;
  return backendPinsModel(backend) ? clampModelDispatch(dispatch, model ?? null) : dispatch;
}

/**
 * Reject an explicitly named session that belongs to a DIFFERENT backend
 * than the one it would run on — the SYMMETRIC cross-backend guard
 * (kusabi #199).
 *
 * Session ids are backend-specific, and the failure mode is quiet: a CLI
 * handed a session id it does not know does not error, it starts a
 * fresh-looking run the operator believes continues their work.  Two
 * independent signals decide, in this order:
 *
 *   1. SHAPE — `ses_*` is unmistakably an opencode id, and needs no record
 *      to prove it.  This is the guard `claudeDispatch` has carried since
 *      kusabi #184; stating it here makes it symmetric across every
 *      non-opencode backend rather than claude's alone.
 *   2. PROVENANCE — a claude session id and an agy conversation id are BOTH
 *      bare UUIDs, so shape can never separate them.  The job store can: the
 *      record that reported this session names the backend that made it.
 *      This check is now LOAD-BEARING for the agy backend (kusabi #316):
 *      agyDispatch resumes a session only when the caller proves the store
 *      attributes it to agy, and the proof is this record.
 *
 * A session with no owning record and no telling shape is left alone here:
 * the operator may legitimately be resuming something kusabi never
 * dispatched.  (The agy DISPATCH draws a stricter line — see
 * assertNoAgySession in agy-dispatch.mjs, which fails closed on exactly
 * that unknown-provenance shape rather than pass it to `--conversation`.)
 *
 * @param {object} opts
 * @param {string} opts.session
 * @param {string} opts.backend — the backend this dispatch would run on.
 * @param {object|null|undefined} [opts.owner] — the job record that reported
 *        this session, if any.
 * @throws {Error} Naming BOTH backends.
 */
export function assertSessionBackendCompatible({ session, backend, owner }) {
  const shapeBackend = session.startsWith("ses_") ? "opencode" : null;
  if (shapeBackend && shapeBackend !== backend) {
    // Deliberately the SAME wording claudeDispatch's own ses_* guard uses
    // (kusabi #184), generalised over the target backend: this check runs
    // earlier than that one, so an operator who has seen the message once
    // must not meet a second, differently-phrased version of it.
    throw new Error(
      `opencode session ${session} cannot be resumed on the ${backend} backend — ` +
      `ses_* session ids belong to opencode; run the command without --backend ${backend} ` +
      `(or pass a ${backend} session id)`
    );
  }
  // Records without a `backend` field predate the split and are opencode.
  const ownerBackend = owner ? (owner.backend ?? "opencode") : null;
  if (!ownerBackend || ownerBackend === backend) return;
  throw new Error(
    `session ${session} belongs to the ${ownerBackend} backend and cannot be resumed on the ${backend} backend — ` +
    `session ids are backend-specific, and the ${backend} CLI would silently start a fresh run instead of ` +
    `continuing it. Run this on the ${ownerBackend} backend, or drop the session to start fresh.`
  );
}

/**
 * Resolve `{ dispatch, backend, model, explicitModel, chain }` for ONE phase
 * of a job-creating command.  The backend decides BOTH the dispatch function
 * (claudeDispatch / agyDispatch / dispatchWithFallback — the chain phases
 * stay backend-blind) and the model resolution syntax (claude models are
 * bare aliases / full ids, agy models are plain ids, opencode models are
 * provider/model).
 *
 * ---------------------------------------------------------------------
 * Resolution order (kusabi #210).  ONE decision picks the backend, and the
 * model is validated against THAT backend.  The defect class removed here
 * is a backend chosen by one input and a model validated against another:
 *
 *   0. a `--model` that NAMES a backend (`claude/opus`,
 *      `agy/gemini-3.6-flash-high`, `opencode-go/deepseek-v4-pro:max`)
 *      decides it — for the phases the flag pins, which is every phase it
 *      applies to and no wider;
 *   1. otherwise `--backend`, which forces EVERY phase onto that backend;
 *   2. otherwise the phase's chain entries (`models.phases.<phase>` →
 *      `models.chain` → the built-in default), via resolveChainBackend.
 *
 * A bare `--model <alias>` (no `/`) names no backend and therefore moves
 * nothing: the phase keeps its configured backend, exactly as before step 0
 * existed.  `--backend X` together with a `--model` naming backend Y is a
 * contradiction and throws, naming both — one is never silently dropped.
 *
 * Config file semantics are untouched: step 0 accepts the identifier syntax
 * the CONFIG already defines (splitRouteBackend), so the string that routes
 * a phase in `models.phases.<phase>` routes it on the CLI too.
 * ---------------------------------------------------------------------
 *
 * Invariant (kusabi #192): one phase's chain array is single-backend — an
 * array mixing two backends' entries fails LOUDLY here, at command start,
 * before createChainDir / before any job is dispatched.  The check is
 * skipped only when the chain is never consulted (the backend is already
 * decided AND `--model` pins every phase — kusabi #186's carve-out).
 *
 * @param {object} opts
 * @param {object} opts.flags
 * @param {string} [opts.phase]
 * @param {object|null} opts.config
 * @returns {{ dispatch: Function, backend: "opencode"|"claude"|"agy",
 *             model: object|string|undefined, explicitModel: string|null,
 *             chain: (string|string[])[] }}
 */
export function resolveDispatchBackend({ flags, phase, config }) {
  // Unknown-backend errors are about the flag, not the phase's config key:
  // resolve it before the per-phase resolution so it never gets key context
  // appended below.
  const backendFlag = resolveBackend(flags);
  try {
    return resolveDispatchBackendForPhase({ flags, phase, config, backendFlag });
  } catch (err) {
    // Per-phase resolution errors must name the config key that produced
    // them (kusabi #192 axis 2): a bad models.phases.rework array fails with
    // "… (models.phases.rework)" so the operator knows WHICH phase key to
    // fix — the same fail-loud principle as the mixed-backend / :variant
    // rejections.  Appended only when the phase actually has its own config
    // key (an error from models.chain must not be misattributed to a phase
    // that has no key), and only once.  Errors about the FLAGS carry
    // `flagError` and are never re-attributed to a config key: blaming
    // models.phases.<phase> for a value the operator typed on the command
    // line is the confusion kusabi #210 removes.
    const key = phase && config?.models?.phases?.[phase] ? `models.phases.${phase}` : null;
    if (key && err instanceof Error && !err.flagError && !err.message.includes(key)) {
      throw new Error(`${err.message} (${key})`);
    }
    throw err;
  }
}

/**
 * Build an error about the FLAGS rather than about a config key, tagged so
 * the wrapper above never appends "(models.phases.<phase>)" to it.
 *
 * @param {string} message
 * @returns {Error}
 */
function flagError(message) {
  const err = new Error(message);
  err.flagError = true;
  return err;
}

function resolveDispatchBackendForPhase({ flags, phase, config, backendFlag }) {
  // ---- step 0: the identifier ----
  // `--model` is resolved into { backend, model } BEFORE anything else is
  // consulted, with the config's own prefix grammar.
  const modelSpec = resolveModelBackend(flags.model);
  const namedBackend = modelSpec?.backend ?? null;
  const flagBackend = flags.backend ? backendFlag : null;
  if (flagBackend && namedBackend && namedBackend !== flagBackend) {
    throw flagError(
      `--backend ${flagBackend} conflicts with --model ${flags.model}, which names the ${namedBackend} backend — ` +
      `a --model that names a backend decides it for the phases it pins; drop --backend ${flagBackend}, ` +
      `or pass a --model that names ${flagBackend}`
    );
  }

  // Explicit --backend flag or backend-naming --model takes precedence.
  // The chain is consulted ONLY when neither decided (kusabi #186 carve-out).
  if (flagBackend === "claude" || namedBackend === "claude") {
    return resolveClaudePhaseDispatch({ flags, phase, config, modelSpec });
  }
  if (flagBackend === "agy" || namedBackend === "agy") {
    return resolveAgyPhaseDispatch({ flags, phase, config, modelSpec });
  }
  if (flagBackend === "codex" || namedBackend === "codex") {
    return resolveCodexPhaseDispatch({ flags, phase, config, modelSpec });
  }
  if (flagBackend === "opencode" || namedBackend === "opencode") {
    return resolveOpencodePhaseDispatch({ phase, config, modelSpec, namedBackend, flagBackend });
  }

  // Neither --backend nor a backend-naming --model was passed.
  // The backend derives from the configured chain (kusabi #470).
  const rawChain = (phase && config?.models?.phases?.[phase])
    ? config.models.phases[phase]
    : config?.models?.chain;

  if (rawChain && isMixedChain(rawChain)) {
    // Capacity ladders always walk through dispatchWithFallback. A bare
    // --model alias (no backend/) pins against the ladder's STARTING
    // backend (#210 / #470 finding 2) — never parseModel on "opus".
    if (modelSpec && modelSpec.backend === null) {
      const startBackend = resolveChainBackend(rawChain);
      if (startBackend === "claude") {
        return resolveClaudePhaseDispatch({ flags, phase, config, modelSpec });
      }
      if (startBackend === "agy") {
        return resolveAgyPhaseDispatch({ flags, phase, config, modelSpec });
      }
      if (startBackend === "codex") {
        return resolveCodexPhaseDispatch({ flags, phase, config, modelSpec });
      }
      throw flagError(
        `--model "${flags.model}" on a mixed capacity ladder that starts on opencode ` +
        `needs provider/model (or a backend-qualified id), not a bare alias`
      );
    }
    return resolveOpencodePhaseDispatch({ phase, config, modelSpec, namedBackend, flagBackend });
  }

  const backend = resolveChainBackend(resolveModel({ flag: undefined, phase, config }).chain);

  if (backend === "claude") return resolveClaudePhaseDispatch({ flags, phase, config, modelSpec });
  if (backend === "agy") return resolveAgyPhaseDispatch({ flags, phase, config, modelSpec });
  if (backend === "codex") return resolveCodexPhaseDispatch({ flags, phase, config, modelSpec });
  return resolveOpencodePhaseDispatch({ phase, config, modelSpec, namedBackend, flagBackend });
}

/**
 * The claude branch of the decision.  Reached identically whether the
 * identifier named claude, `--backend claude` forced it, or the phase's
 * chain entries are claude-native — the branch does not care which, which
 * is the point: one decision, one model syntax, one validation.
 */
function resolveClaudePhaseDispatch({ flags, phase, config, modelSpec }) {
  // The chain this phase reads: models.phases.<phase> → models.chain → the
  // claude-native default.  Entries written for the per-phase syntax may
  // carry the claude/ prefix; the backend is already decided, so the prefix
  // is redundant but must not leak into models — strip it before
  // validating / deriving.
  const resolved = resolveClaudeModel({ flag: undefined, phase, config });
  const chain = stripBackendPrefixChain(resolved.chain);

  if (!modelSpec) {
    if (flags.backend === "claude" && isMixedChain(resolved.chain)) {
      const chainKey = (phase && config?.models?.phases?.[phase])
        ? `models.phases.${phase}`
        : (config?.models?.chain ? "models.chain" : "the built-in default chain");
      throw new Error(
        `--backend claude conflicts with the chain of the ${phase ?? "task"} phase ` +
        `(${chainKey}: ${JSON.stringify(resolved.chain)}) — an explicit --backend forces every phase ` +
        `onto that backend; remove --backend claude or point ${chainKey} at claude entries`
      );
    }
    validateClaudeChain(chain);
    const model = resolved.model == null ? undefined : splitRouteBackend(String(resolved.model)).route;
    if (model != null) validateClaudeModel(model);
    return { dispatch: claudeDispatch, backend: "claude", model, explicitModel: null, chain };
  }

  // With an explicit --model, clampModelDispatch pins EVERY phase (chain
  // start and chain-resume alike) to that model, so the config chain is
  // never consulted for a model and must not block startup (kusabi #186).
  // A :variant suffix cannot be expressed on the claude backend — reject it
  // up front (clear error, nonzero exit) instead of silently ignoring it at
  // dispatch time, and attribute the rejection to the identifier's own
  // backend rather than to a config key three levels away (kusabi #210).
  const model = modelSpec.model;
  try {
    validateClaudeModel(model);
  } catch (err) {
    throw flagError(
      `--model "${flags.model}" ${modelSpec.backend ? "names" : "resolves on"} the claude backend: ${err.message}`
    );
  }
  return { dispatch: claudeDispatch, backend: "claude", model, explicitModel: model, chain };
}

/**
 * The agy branch of the decision (kusabi #199) — the exact mirror of the
 * claude branch, one backend over: reached identically whether the
 * identifier named agy, `--backend agy` forced it, or the phase's chain
 * entries carry the `agy/` prefix, and the branch does not care which.
 *
 * The only differences from the claude branch are which validator runs and
 * which dispatch comes out, because that is the only thing that actually
 * differs: the precedence, the prefix stripping, the single-backend check,
 * the #186 carve-out and the identifier-owns-its-rejection rule (#210) are
 * all the same rules, applied to a third backend rather than restated for
 * it.
 */
function resolveAgyPhaseDispatch({ flags, phase, config, modelSpec }) {
  const resolved = resolveAgyModel({ flag: undefined, phase, config });
  const chain = stripBackendPrefixChain(resolved.chain);

  if (!modelSpec) {
    if (flags.backend === "agy" && isMixedChain(resolved.chain)) {
      const chainKey = (phase && config?.models?.phases?.[phase])
        ? `models.phases.${phase}`
        : (config?.models?.chain ? "models.chain" : "the built-in default chain");
      throw new Error(
        `--backend agy conflicts with the chain of the ${phase ?? "task"} phase ` +
        `(${chainKey}: ${JSON.stringify(resolved.chain)}) — an explicit --backend forces every phase ` +
        `onto that backend; remove --backend agy or point ${chainKey} at agy entries`
      );
    }
    validateAgyChain(chain);
    const model = resolved.model == null ? undefined : splitRouteBackend(String(resolved.model)).route;
    if (model != null) validateAgyModel(model);
    return { dispatch: agyDispatch, backend: "agy", model, explicitModel: null, chain };
  }

  // With an explicit --model the config chain is never consulted for a model
  // and must not block startup (kusabi #186).  A :variant suffix cannot be
  // expressed on the agy backend — reject it up front, attributed to the
  // identifier's own backend rather than to a config key three levels away.
  const model = modelSpec.model;
  try {
    validateAgyModel(model);
  } catch (err) {
    throw flagError(
      `--model "${flags.model}" ${modelSpec.backend ? "names" : "resolves on"} the agy backend: ${err.message}`
    );
  }
  return { dispatch: agyDispatch, backend: "agy", model, explicitModel: model, chain };
}

/**
 * The codex branch of the decision (kusabi #527) — the same shape as the
 * agy branch, one backend over.  Reached whether the identifier named
 * codex, `--backend codex` forced it, or the phase's chain entries carry the
 * `codex/` prefix.
 *
 * The branch never invents a model: an explicit `--model` must be one exact
 * seat id (one of `CODEX_SUPPORTED_MODELS` in codex-dispatch.mjs), and a config chain is validated
 * with `validateCodexChain` so a mixed chain that routes through this branch
 * fails loudly at command start (codex does not walk capacity ladders — an
 * explicit pin is never substituted after a terminal failure).
 */
function resolveCodexPhaseDispatch({ flags, phase, config, modelSpec }) {
  const resolved = resolveCodexModel({ flag: undefined, phase, config });
  const chain = stripBackendPrefixChain(resolved.chain);

  if (!modelSpec) {
    if (flags.backend === "codex" && isMixedChain(resolved.chain)) {
      const chainKey = (phase && config?.models?.phases?.[phase])
        ? `models.phases.${phase}`
        : (config?.models?.chain ? "models.chain" : "the built-in default chain");
      throw new Error(
        `--backend codex conflicts with the chain of the ${phase ?? "task"} phase ` +
        `(${chainKey}: ${JSON.stringify(resolved.chain)}) \u2014 an explicit --backend forces every phase ` +
        `onto that backend; remove --backend codex or point ${chainKey} at codex entries`
      );
    }
    validateCodexChain(chain);
    const model = resolved.model == null ? undefined : splitRouteBackend(String(resolved.model)).route;
    if (model != null) validateCodexModel(model);
    return { dispatch: codexDispatch, backend: "codex", model, explicitModel: null, chain };
  }

  // With an explicit --model the config chain is never consulted for a model
  // and must not block startup (kusabi #186).  A :variant suffix or an
  // unsupported id is rejected up front, attributed to the identifier's own
  // backend.
  const model = modelSpec.model;
  try {
    validateCodexModel(model);
  } catch (err) {
    throw flagError(
      `--model "${flags.model}" ${modelSpec.backend ? "names" : "resolves on"} the codex backend: ${err.message}`
    );
  }
  return { dispatch: codexDispatch, backend: "codex", model, explicitModel: model, chain };
}

/**
 * The opencode branch of the decision: `--model` is provider/model syntax
 * (parseModel), chain entries pass through byte-identical.
 */
function resolveOpencodePhaseDispatch({ phase, config, modelSpec, namedBackend, flagBackend }) {
  // The phase's CONFIGURED chain, independent of --model: the single-backend
  // invariant (kusabi #192) runs on it on every opencode resolution, as it
  // always has, and the conflict below is stated over it.
  const configuredChain = resolveModel({ flag: undefined, phase, config }).chain;
  const configuredBackend = resolveChainBackend(configuredChain);
  // kusabi #192: an explicit `--backend opencode` forces EVERY phase onto
  // opencode, so a phase chain native to ANOTHER backend CONTRADICTS it —
  // throw at command start, naming the flag, the phase and the offending
  // config key; never silently switch backends, never dispatch claude/… or
  // agy/… routes as opencode.  Stated over `!== "opencode"` rather than over
  // one backend's name, so a third backend (kusabi #199) is covered by the
  // rule instead of slipping past it.  It fires only when there is no
  // backend-naming `--model` to settle the question: when the identifier
  // names a backend the operator has stated their intent unambiguously (and
  // a disagreeing --backend already threw above), so firing anyway would
  // reproduce the incident kusabi #210 was filed for.
  // Explicit --backend opencode forces EVERY phase onto opencode alone.
  // A mixed capacity ladder (kusabi #470) still contradicts that force even
  // when the first route is opencode — resolveChainBackend only reports the
  // starting backend, so isMixedChain is the check that catches free→agy.
  if (flagBackend === "opencode" && namedBackend === null
    && (configuredBackend !== "opencode" || isMixedChain(configuredChain))) {
    const chainKey = (phase && config?.models?.phases?.[phase])
      ? `models.phases.${phase}`
      : (config?.models?.chain ? "models.chain" : "the built-in default chain");
    const other = isMixedChain(configuredChain)
      ? "mixed-backend"
      : `${configuredBackend}-native`;
    throw new Error(
      `--backend opencode conflicts with the ${other} chain of the ${phase ?? "task"} phase ` +
      `(${chainKey}: ${JSON.stringify(configuredChain)}) — an explicit --backend forces every phase ` +
      `onto that backend; remove --backend opencode or point ${chainKey} at opencode entries`
    );
  }

  const resolved = resolveModel({ flag: modelSpec?.model, phase, config });
  let chain = resolved.chain;
  if (namedBackend === "opencode"
    && (chainNamesBackend(chain, "claude") || chainNamesBackend(chain, "agy") || chainNamesBackend(chain, "codex"))) {
    // Only reachable when the identifier chose opencode over a chain native
    // to another backend: those entries are that backend's model ids and
    // must never be walked as opencode routes by the fallback ladder.
    // `--model` pins this phase anyway, so its ladder is exactly the pinned
    // route.
    chain = [modelSpec.model];
  }
  return {
    dispatch: dispatchWithFallback,
    backend: namedBackend ?? configuredBackend,
    model: resolved.model,
    explicitModel: modelSpec ? modelSpec.model : null,
    chain,
  };
}

/**
 * Resolve the session for `--resume-last`: the sessionID of the most recent
 * task job of the SAME backend as the current dispatch.  Every backend
 * shares ONE job store, and a session id is backend-specific — a claude
 * UUID cannot be resumed on opencode, and an opencode `ses_*` id is
 * rejected by both other backends' cross-backend guards.  Without this
 * filter, `--resume-last` on a claude dispatch could silently pick an
 * opencode session (and vice versa).  Records without a `backend` field
 * predate the backend split and count as "opencode".  This is SELECTION
 * only — whether a given session may be resumed on the chosen backend is
 * decided inside the dispatch (claudeDispatch's ses_* guard,
 * agyDispatch's assertNoAgySession).  The selection doubles as the agy
 * dispatch's provenance proof: the selected record's backend IS the
 * dispatch backend, so the session id the caller passes down with
 * `sessionProvenance: "agy"` is exactly what assertNoAgySession requires.
 *
 * @param {string} stateDir
 * @param {object} opts
 * @param {string|null|undefined} [opts.phase]
 * @param {"opencode"|"claude"|"agy"} opts.backend
 * @returns {string|null} The session id, or null when no same-backend job.
 */
export function resolveResumeLastSession(stateDir, { phase, backend }) {
  const prev = latestJob(stateDir, (j) =>
    j.kind === "task"
    && (!phase || j.phase === phase)
    && (j.backend ?? "opencode") === backend
  );
  return prev?.sessionID ?? null;
}
