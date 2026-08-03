// chain-substance.mjs — classify whether a chain's worker produced changes
// (kusabi #165).
//
// Raw disposition counts conflate two very different escalated chains: one
// where the worker produced a change set that was then rejected, and one
// where the worker never produced anything at all (provider 403 before
// opt-in, free-route single-step deaths with steps=0 / output≈0, or a round
// whose implement produced tokens but zero changes).  This module is the
// single pure classifier both reporting surfaces (chain-stats.mjs and
// metrics-report.mjs) use, so the two can never disagree about the label.
//
// Primary signal: `worktreeChanged` on the round record.  A chain did
// substantive work iff ANY round records a change.  Implement usage (output
// tokens) and probe results may be shown alongside, but they are NOT the
// criterion — no token thresholds here.
//
// Missing data is a THIRD label, never folded into "no-work": a round whose
// field is absent was never measured, and "not measured" must not read as
// "changed nothing".

/**
 * Read a round record's "did the worker change the worktree" signal.
 *
 * Two surfaces feed this classifier and they name the field differently:
 * chain.json `records` entries (chain-stats.mjs) carry `worktreeChanged`,
 * metrics round rows (chain-ingest.mjs / the metrics store) carry
 * `worktree_changed`.  Both spellings are accepted.
 *
 * The value is three-valued:
 *   - true / 1    — the round changed the worktree (probes measured it)
 *   - false / 0   — the round measured NO change (baseline compare ran)
 *   - null        — absent or unmeasurable; NOT "no change".  Old records
 *                   lack the field entirely, and a round that died before
 *                   probes never had it set.
 *
 * @param {*} r  — one round record
 * @returns {boolean|null}
 */
export function roundWorktreeChanged(r) {
  if (r === null || r === undefined) return null;
  const v = r.worktreeChanged ?? r.worktree_changed;
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  return null;
}

/**
 * Classify an escalated chain by whether the worker ever produced a change
 * set.
 *
 *   - "substantive" — at least one round records `worktreeChanged === true`.
 *     The chain's later rejection (escalate/discard) does not undo that:
 *     the worker DID do substantive work that was not accepted.
 *   - "no-work"     — the worker produced nothing: every round measured no
 *     change, or there are no rounds at all (infra death before any record
 *     was written).
 *   - "unknown"     — rounds exist, none recorded a change, but at least
 *     one round's field is absent (never measured).  Missing data is never
 *     misclassified as no-work.
 *
 * Only called on ESCALATED chains by the reporting surfaces — the label has
 * no meaning for chains that were accepted.  The classifier itself is
 * disposition-agnostic (it never looks at `disposition`), so it cannot
 * change any disposition decision.
 *
 * @param {Array} rounds  — one chain's round records (chain.json `records`
 *                          entries or metrics round rows).
 * @returns {"substantive"|"no-work"|"unknown"}
 */
export function classifyEscalate(rounds) {
  const list = Array.isArray(rounds) ? rounds : [];
  if (list.length === 0) return "no-work";
  let anyUnknown = false;
  for (const r of list) {
    const c = roundWorktreeChanged(r);
    if (c === true) return "substantive";
    if (c === null) anyUnknown = true;
  }
  return anyUnknown ? "unknown" : "no-work";
}
