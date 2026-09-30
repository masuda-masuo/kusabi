/**
 * Reject a session that must not be resumed on the given backend, naming BOTH
 * backends.
 *
 * Two id shapes, two gates (kusabi #316 replaced the v1 blanket refusal):
 *
 *   - `ses_*` — an opencode session id.  Shape alone decides it, which is
 *     the same guard `claudeDispatch` has had since kusabi #184; kusabi #199
 *     makes it SYMMETRIC so an opencode id cannot reach other CLI backends
 *     either.  This check always fires on shape, whatever provenance says.
 *   - anything else — CLI session ids (bare UUIDs or backend-specific ids)
 *     cannot always be distinguished by shape alone.  The one thing that
 *     can is the job store, and the store lives in the CALLER's hand
 *     (kusabi-companion.mjs's `assertSessionBackendCompatible` / the chain
 *     seams), not this module's.  So the module requires POSITIVE EVIDENCE
 *     rather than inferring: the caller passes `provenance: <backend>` only
 *     when it has established from the store that a job of this backend
 *     recorded this id.  Anything else — no signal (a caller that skipped the
 *     companion-level check), or a signal naming another backend — is
 *     refused HERE, so an id whose provenance is unknown to this module can
 *     never silently become a resume argument.  This is the backstop: it
 *     fails closed on exactly the callers that forgot to check.
 *
 * @param {string|null|undefined} session
 * @param {object} [opts]
 * @param {string} opts.backend — the backend attempting to resume the session.
 * @param {string|null|undefined} [opts.provenance] — the backend the caller
 *        PROVED created this session (from the job store), or nothing when
 *        no such proof exists.  Only `backend` lets an id through.
 * @param {string} [opts.detail] — backend-specific explanation for why
 *        provenance is required.
 * @param {string} [opts.tail] — backend-specific tail for the error message.
 * @throws {Error} When a session was given without matching backend provenance.
 */
export function assertSessionResumable(session, { backend, provenance, detail, tail } = {}) {
  if (typeof session !== "string" || session === "") return;
  if (session.startsWith("ses_")) {
    throw new Error(
      `opencode session ${session} cannot be resumed on the ${backend} backend — ` +
      `ses_* session ids belong to opencode; run the command without --backend ${backend} ` +
      "(or drop --session / --resume-last)"
    );
  }
  if (provenance === backend) return;
  const attribution = provenance
    ? `the job store attributes it to the ${provenance} backend`
    : "no kusabi job record reports it, so its backend cannot be established";
  const detailPrefix = detail ? `${detail} ` : "";
  const resolvedTail = tail ?? `a session id that a ${backend} job on this directory recorded`;
  throw new Error(
    `session ${session} cannot be resumed on the ${backend} backend — ${attribution}. ` +
    `${detailPrefix}Drop --session / --resume-last, or pass ${resolvedTail}`
  );
}
