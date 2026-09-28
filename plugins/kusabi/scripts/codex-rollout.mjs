// codex-rollout.mjs — Codex rollout provenance parsing and verification.
//
// Split out of codex-dispatch.mjs (pure move, no behaviour change): parsing
// JSONL rollout session logs, locating rollout files in the job-owned
// CODEX_HOME, and verifying the executed model and reasoning effort against
// the requested dispatch parameters.

import fs from "node:fs";
import path from "node:path";

// Reasoning effort is FIXED to high in v1 (measured fresh invocation).  It is
// not configurable and never translated from a :variant suffix.
export const CODEX_REASONING_EFFORT = "high";

// =========================================================================
// rollout provenance verification — pure over JSONL text
// =========================================================================

/**
 * Parse Codex rollout JSONL text into the provenance fields the adapter can
 * verify.  Tolerant: non-JSON lines are skipped, and a missing field stays
 * null (absent, not asserted).  The rollout vocabulary (codex-usage-ingest
 * reads the same records) is:
 *
 *   {"type":"session_meta","payload":{"id","cwd", model, model_reasoning_effort,
 *      approval_policy, sandbox_policy, network_policy, ...}}
 *   {"type":"turn_context","payload":{"turn_id","model", model_reasoning_effort, ...}}
 *
 * The actual model may live on session_meta or turn_context payloads; effort
 * and the policies are read from either record type when present.
 *
 * The per-record arrays (`sessionMetas`, `turns`) preserve FILE ORDER so a
 * RESUMED dispatch can bind to the evidence the resumed invocation itself
 * produced (its turn_context is the LAST one in the thread's rollout) instead
 * of a stale matching turn from the original session.  The flat aggregate
 * fields keep the fresh-dispatch semantics exactly as they have always been
 * (last session_meta wins, first named turn as the model fallback).
 *
 * @param {string} content — the full text of one or more rollout files.
 * @returns {{ found: boolean, model: string|null, reasoningEffort: string|null,
 *             approvalPolicy: string|null, sandboxPolicy: string|null,
 *             networkPolicy: string|null,
 *             sessionMetas: object[], turns: Array<{model: string|null,
 *               reasoningEffort: string|null}> }}
 */
export function parseRolloutProvenance(content) {
  const sessionMetas = [];
  const turns = [];
  const turnModels = [];
  let found = false;
  const lines = typeof content === "string" ? content.split("\n") : [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) continue;
    const payload = rec.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    if (rec.type === "session_meta") {
      found = true;
      const meta = {
        model: typeof payload.model === "string" && payload.model ? payload.model : null,
        reasoningEffort: typeof payload.model_reasoning_effort === "string" && payload.model_reasoning_effort
          ? payload.model_reasoning_effort
          : null,
        approvalPolicy: typeof payload.approval_policy === "string" && payload.approval_policy
          ? payload.approval_policy
          : null,
        sandboxPolicy: (typeof payload.sandbox_policy === "string" && payload.sandbox_policy)
          ? payload.sandbox_policy
          : (typeof payload.sandbox_mode === "string" && payload.sandbox_mode ? payload.sandbox_mode : null),
        networkPolicy: typeof payload.network_policy === "string" && payload.network_policy
          ? payload.network_policy
          : null,
      };
      sessionMetas.push(meta);
    } else if (rec.type === "turn_context") {
      found = true;
      const model = typeof payload.model === "string" && payload.model ? payload.model : null;
      const reasoningEffort = typeof payload.model_reasoning_effort === "string" && payload.model_reasoning_effort
        ? payload.model_reasoning_effort
        : null;
      if (model) turnModels.push(model);
      turns.push({ model, reasoningEffort });
    }
  }
  const lastMeta = sessionMetas[sessionMetas.length - 1] ?? null;
  return {
    found,
    model: lastMeta?.model || turnModels[0] || null,
    reasoningEffort: lastMeta?.reasoningEffort ?? null,
    approvalPolicy: lastMeta?.approvalPolicy ?? null,
    sandboxPolicy: lastMeta?.sandboxPolicy ?? null,
    networkPolicy: lastMeta?.networkPolicy ?? null,
    sessionMetas,
    turns,
  };
}

/**
 * Verify a parsed rollout against the requested model and the fixed
 * reasoning effort.
 *
 *   state: "verified"      — the bound evidence's model matches the requested
 *                            one (and its effort, when present, matches the
 *                            fixed "high").
 *   state: "unverifiable"  — no rollout, or the bound evidence carries no
 *                            model field to check: represented EXPLICITLY as
 *                            unverifiable, never silently treated as verified.
 *   state: "mismatch"      — a present field contradicts the request.  The
 *                            caller fails the job closed on this: no
 *                            successful result, no fallback/substitution.
 *
 * `resumed: true` changes WHICH evidence is bound (kusabi #527 review
 * follow-up): the rollout of a resumed thread holds the ORIGINAL session's
 * records first and the resumed invocation's records last, and only the
 * resumed invocation's own evidence may verify the run.  The resumed turn is
 * the LAST turn_context in the rollout; a matching turn_context from the
 * original session is never accepted in its place, so a model or effort
 * mismatch on the resumed turn fails closed.  A resumed dispatch whose
 * rollout carries no turn_context at all is unverifiable (the resumed
 * invocation produced no turn evidence to bind to).
 *
 * @param {object} opts
 * @param {object} opts.rollout — output of `parseRolloutProvenance`.
 * @param {string} opts.requestedModel — the exact model the invocation asked for.
 * @param {string} [opts.requestedEffort] — defaults to CODEX_REASONING_EFFORT.
 * @param {boolean} [opts.resumed] — bind to the resumed invocation's own
 *        (last) turn_context evidence instead of the fresh-path aggregate.
 * @returns {object}
 */
export function verifyRolloutProvenance({ rollout, requestedModel, requestedEffort = CODEX_REASONING_EFFORT, resumed = false }) {
  if (!rollout?.found) {
    return { state: "unverifiable", reason: "no-rollout-record" };
  }
  if (resumed) {
    // Bind to the evidence the RESUMED invocation itself produced.  The
    // thread's rollout holds the original session's records first and the
    // resumed run's records last, so the resumed turn is the LAST
    // turn_context.  A stale matching turn_context from the original session
    // must never verify a resumed run whose own turn mismatches.
    const turns = Array.isArray(rollout.turns) ? rollout.turns : [];
    const turn = turns[turns.length - 1] ?? null;
    if (!turn) {
      return { state: "unverifiable", reason: "no-resumed-turn-evidence" };
    }
    if (!turn.model) {
      return { state: "unverifiable", reason: "rollout-model-field-absent" };
    }
    if (turn.model !== requestedModel) {
      return {
        state: "mismatch",
        kind: "model",
        requested: requestedModel,
        actual: turn.model,
      };
    }
    if (turn.reasoningEffort && turn.reasoningEffort !== requestedEffort) {
      return {
        state: "mismatch",
        kind: "reasoning-effort",
        requested: requestedEffort,
        actual: turn.reasoningEffort,
      };
    }
    return {
      state: "verified",
      model: turn.model,
      reasoningEffort: turn.reasoningEffort ?? null,
      approvalPolicy: rollout.approvalPolicy ?? null,
      sandboxPolicy: rollout.sandboxPolicy ?? null,
      networkPolicy: rollout.networkPolicy ?? null,
    };
  }
  if (rollout.model && rollout.model !== requestedModel) {
    return {
      state: "mismatch",
      kind: "model",
      requested: requestedModel,
      actual: rollout.model,
    };
  }
  if (!rollout.model) {
    return { state: "unverifiable", reason: "rollout-model-field-absent" };
  }
  if (rollout.reasoningEffort && rollout.reasoningEffort !== requestedEffort) {
    return {
      state: "mismatch",
      kind: "reasoning-effort",
      requested: requestedEffort,
      actual: rollout.reasoningEffort,
    };
  }
  return {
    state: "verified",
    model: rollout.model,
    reasoningEffort: rollout.reasoningEffort ?? null,
    approvalPolicy: rollout.approvalPolicy ?? null,
    sandboxPolicy: rollout.sandboxPolicy ?? null,
    networkPolicy: rollout.networkPolicy ?? null,
  };
}

/**
 * Locate the rollout files under a job-owned Codex home.  The CLI persists
 * `$CODEX_HOME/sessions/<thread-id>/rollout-<timestamp>.jsonl`; a recursive
 * scan tolerates layout drift (the exact nesting is the CLI's, not ours).
 *
 * @param {string} codexHome
 * @returns {string[]} sorted absolute rollout file paths (possibly empty).
 */
export function findRolloutFiles(codexHome) {
  const root = path.join(codexHome, "sessions");
  const results = [];
  try {
    fs.readdirSync(root);
  } catch {
    return results;
  }
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let children;
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      const full = path.join(dir, child.name);
      if (child.isDirectory()) {
        stack.push(full);
      } else if (child.isFile() && child.name.startsWith("rollout-") && child.name.endsWith(".jsonl")) {
        results.push(full);
      }
    }
  }
  return results.sort();
}

/**
 * Read the rollout provenance for a finished run: parse every rollout file
 * under the job-owned home and verify it.  Never throws — a read failure is
 * represented as `unverifiable` with the reason named.
 *
 * @param {object} opts
 * @param {string} opts.codexHome — the job-owned home.
 * @param {string} opts.requestedModel — the exact model that was requested.
 * @param {boolean} [opts.resumed] — true for a resumed dispatch: bind to
 *        the resumed invocation's own (last) turn_context evidence.
 * @returns {object} the `verifyRolloutProvenance` result.
 */
export function readRolloutProvenance({ codexHome, requestedModel, resumed = false }) {
  try {
    const files = findRolloutFiles(codexHome);
    if (files.length === 0) {
      return verifyRolloutProvenance({ rollout: { found: false }, requestedModel, resumed });
    }
    const content = files.map((file) => fs.readFileSync(file, "utf8")).join("\n");
    return verifyRolloutProvenance({ rollout: parseRolloutProvenance(content), requestedModel, resumed });
  } catch (err) {
    return { state: "unverifiable", reason: `rollout-read-failed: ${err?.message ?? err}` };
  }
}

