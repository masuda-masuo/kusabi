// audit-envelope.mjs — kusabi #529: the immutable evidence envelope.
//
// This envelope is the ONLY evidence path into the Sol seat (and the seat's
// framing for Luna): deterministic, sha-bound, immutable, with explicit
// truncation metadata, secret scrubbing, a bounded size, and exact seat
// provenance (kusabi #524 §11, slice 4).  The contract is frozen by
// audit-envelope.test.mjs:
//
//   - deterministic materialization of the six materialized item roles
//     (issue, Luna brief, Luna framing, raw diff, probes, worker report);
//     prior verdicts are envelope-level evidence recorded separately, not an
//     item role — every materialized item records role, source, sha256,
//     bytes, and path;
//   - any evidence-byte mutation changes the envelope hash;
//   - truncation is never silent: `truncated`, exact `omitted_bytes`, and the
//     strategy are recorded (head+tail boundary AND untruncated boundary);
//   - environment data is never enumerated or copied into the envelope, and
//     token-shaped credentials in supplied evidence are scrubbed BEFORE any
//     truncation — a head+tail splice of raw text could cut a credential in
//     half so no whole-token shape remains to match, so the full untruncated
//     content is scrubbed first and the truncation then operates on
//     credential-free text (the scrubbed bytes are what the seat reads and
//     what the item sha256 binds);
//   - a bounded envelope-size contract that is deterministic and RECORDS
//     omissions instead of silently dropping content, applied over the
//     COMPLETE seat-visible serialized envelope: item content is reduced
//     deterministically until the canonical serialization fits the envelope
//     budget, and metadata that cannot fit even with zero item content fails
//     closed with the stable code `envelope-metadata-over-budget` (no
//     provenance is ever silently dropped);
//   - seat substitution is fail-closed (an explicit flag is required);
//   - exact-seat failure is fail-closed except the narrow sampled-only Sol
//     gate case, and the two are distinguished.
//
// Byte accounting is UTF-8, never JS code-unit guesses: every length and
// every omitted-byte count is measured with Buffer.byteLength over the exact
// materialized text.

import { createHash } from "node:crypto";

/** Envelope schema version — frozen at 1 for the accepted design. */
export const ENVELOPE_VERSION = 1;

/**
 * The six materialized item roles of #524 §11.  Prior verdicts are
 * envelope-level evidence (`prior_verdicts`), never an item role.  Any item
 * role outside this frozen set is refused.
 */
export const ENVELOPE_ROLES = [
  "issue",
  "luna_brief",
  "luna_reasoning",
  "diff",
  "probe_raw",
  "worker_report",
];

/** A valid envelope hash is 64 lowercase hex characters. */
const ENVELOPE_SHA256_RE = /^[0-9a-f]{64}$/;

/** The default envelope payload cap when the caller supplies none (#524 §12). */
export const DEFAULT_ENVELOPE_MAX_BYTES = 262144;

/** Every materialized item must live under the read-only evidence tree. */
const EVIDENCE_TREE_PREFIX = "evidence/";

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** An Error that also carries a machine-readable `code`. */
function codedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Deterministic canonical JSON for the envelope hash: stable key order in
 * any process, and the envelope hash is computed over the envelope WITHOUT
 * `envelope_sha256` itself, so the binding field can never be its own input.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The RETURNED envelope carries `envelope_sha256`, so the complete
 * seat-visible serialization is exactly 84 UTF-8 bytes longer than the
 * hash-less envelope (`"envelope_sha256":` \u2014 18 bytes \u2014 plus a 64-hex
 * quoted value).  The final hash is always 64 lowercase hex, so a
 * deterministic 64-hex placeholder measures the returned envelope during the
 * budget pass with byte-identical length to the real hash (kusabi #529 final
 * finding: the literal cap must count the hash field it delivers \u2014 the
 * hash-less envelope alone under-budgets the delivered bytes).
 */
const ENVELOPE_SHA256_PLACEHOLDER = "f".repeat(64);

function completeEnvelopeBytes(envelopeWithoutHash) {
  return Buffer.byteLength(
    canonicalJson({ ...envelopeWithoutHash, envelope_sha256: ENVELOPE_SHA256_PLACEHOLDER }),
  );
}

// ---------------------------------------------------------------------------
// secret scrubbing (spec 4) — token-shaped credentials only, never a broad
// sweep that would over-scrub ordinary evidence.  The scrubbed text is what
// the seat reads and what the item sha256 binds.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  // GitHub PAT / OAuth-style tokens: ghp_/gho_/ghu_/ghs_/ghr_ + 36 alnum.
  // No \b boundaries: the token shape (prefix + exact length) is the secret
  // whether or not it is flanked by word characters, and a \b edge lets
  // word-flanked values such as "xghp_<36 alnum>y" survive scrubbing.
  { re: /gh[pousr]_[A-Za-z0-9]{36}/g },
  // OpenAI-style keys: sk- + 48 alnum.
  { re: /sk-[A-Za-z0-9]{48}/g },
  // Bearer authorization values: 40 hex chars after "Bearer ".
  { re: /Bearer [0-9a-f]{40}/g },
  // PEM private-key blocks (the whole block is one secret).
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

const REDACTED = "[REDACTED]";

/**
 * Replace token-shaped credentials in supplied evidence.  Every replaced
 * span becomes a fixed placeholder that itself matches no token shape, so
 * scrubbing is deterministic and idempotent.  Ordinary evidence passes
 * through verbatim.
 *
 * @param {string} text
 * @returns {string}
 */
export function scrubSecrets(text) {
  let out = String(text ?? "");
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

// ---------------------------------------------------------------------------
// truncation (spec 3) — UTF-8 byte accounting, never silent
// ---------------------------------------------------------------------------

/**
 * Truncate evidence text to a byte bound with a head+tail splice.
 *
 * The kept text is the first half of the byte budget plus the last half —
 * the head and the tail of the evidence — with the middle dropped, WITHOUT
 * splitting a multi-byte UTF-8 code point.  All lengths are UTF-8 bytes
 * (Buffer.byteLength), not JS code units.
 *
 * Exact boundary semantics (frozen):
 *   - total <= maxBytes  -> not truncated, omitted_bytes 0, truncation null
 *   - total  > maxBytes  -> truncated: true, text is a head+tail splice,
 *     omitted_bytes = total - keptBytes (exact), truncation "head+tail"
 *
 * @param {string} text
 * @param {object} opts
 * @param {number} [opts.maxBytes] — the byte bound.  Absent/non-positive is
 *        treated as unbounded (Infinity).
 * @returns {{ truncated: boolean, text: string, omitted_bytes: number,
 *             truncation: "head+tail"|null }}
 */
export function truncateEvidenceText(text, { maxBytes } = {}) {
  const buf = Buffer.from(text, "utf8");
  const total = buf.length;
  // maxBytes 0 is a real bound (truncate everything); absent or non-finite is
  // unbounded.  The envelope budget can drive an item to zero and that
  // omission must be recorded, never silently skipped.
  const bound = Number.isFinite(maxBytes) && maxBytes >= 0 ? Math.floor(maxBytes) : Infinity;
  if (total <= bound) {
    return { truncated: false, text, omitted_bytes: 0, truncation: null };
  }
  // head+tail: split the byte budget in half; the tail starts at the LAST
  // `tailBytes` bytes.  A UTF-8 continuation byte is 0b10xxxxxx, so walking
  // to a non-continuation byte lands on a code-point boundary.
  const headBytes = Math.floor(bound / 2);
  const tailBytes = bound - headBytes;
  let headEnd = headBytes;
  while (headEnd > 0 && (buf[headEnd] & 0xc0) === 0x80) headEnd -= 1;
  let tailStart = total - tailBytes;
  while (tailStart < total && (buf[tailStart] & 0xc0) === 0x80) tailStart += 1;
  if (headEnd > tailStart) {
    // Degenerate tiny budget: never let the two halves overlap.
    headEnd = tailStart;
  }
  const kept = buf.subarray(0, headEnd).toString("utf8") + buf.subarray(tailStart).toString("utf8");
  const keptBytes = Buffer.byteLength(kept, "utf8");
  return { truncated: true, text: kept, omitted_bytes: total - keptBytes, truncation: "head+tail" };
}

// ---------------------------------------------------------------------------
// envelope build (specs 2, 4, 5, 6, 8)
// ---------------------------------------------------------------------------

/**
 * Gate classification from the trigger list, mirroring audit-policy.mjs:
 * `sampled` = T12 fired (sampling), `mandatory` = any trigger OTHER than
 * T12 fired.  A gate can be both (sampled AND mandatory); mandatory wins
 * whenever a seat is unavailable.
 *
 * @param {Array<{id: string}>} triggers
 * @returns {{ sampled: boolean, mandatory: boolean }}
 */
export function classifyGate(triggers) {
  const list = Array.isArray(triggers) ? triggers : [];
  const sampled = list.some((t) => t && t.id === "T12");
  const mandatory = list.some((t) => t && t.id !== "T12");
  return { sampled, mandatory };
}

/**
 * Resolve what happens when a Sol seat is unavailable for a gate.
 *
 * Fail-closed except the SINGLE deliberate fail-open: an explicitly
 * sampled-only gate (sampled && !mandatory) records `audit-sample-skipped`
 * — sampling is observability, not a safety gate.  Mandatory always wins:
 * a sampled gate that is ALSO mandatory still fails closed.  A required
 * gate that is neither mandatory nor sampled is an invariant violation and
 * must fail closed, never be skipped.
 *
 * @param {object} opts
 * @param {boolean} opts.required — a gate was required at all.
 * @param {boolean} opts.mandatory — any non-T12 trigger fired.
 * @param {boolean} opts.sampled — T12 (sampling) fired.
 * @param {boolean} opts.seatAvailable — the exact seat responded.
 * @returns {{ failClosed: boolean, disposition: "proceed"|"sol-blocked"|"audit-sample-skipped" }}
 */
export function resolveSolGateSeatFailure({ required, mandatory, sampled, seatAvailable }) {
  if (!required) return { failClosed: false, disposition: "proceed" };
  if (seatAvailable) return { failClosed: false, disposition: "proceed" };
  if (mandatory) return { failClosed: true, disposition: "sol-blocked" };
  if (sampled) return { failClosed: false, disposition: "audit-sample-skipped" };
  return { failClosed: true, disposition: "sol-blocked" };
}

/**
 * Materialize a read-only evidence envelope through the injected writer
 * contract.
 *
 * Validation (fail-closed, never silent):
 *   - a substituted seat without `allowSubstitute: true` is refused
 *     (`substitution-not-authorized`);
 *   - an item role outside the frozen ENVELOPE_ROLES is refused
 *     (`unknown-role`);
 *   - a materialization path outside the read-only `evidence/` tree, or a
 *     path that could escape it, is refused (`invalid-path`);
 *   - a prior verdict with a malformed envelope hash or no verdict value is
 *     refused (`invalid-prior-verdict`).
 *
 * Truncation is never silent: every per-item bound and the envelope payload
 * cap produce a deterministic head+tail truncation with the exact omitted
 * byte count recorded on the item AND in `omissions`.  Secrets are scrubbed
 * before the seat-visible bytes are written and hashed.  The environment is
 * never read.  The envelope hash binds the whole envelope except
 * `envelope_sha256` itself, so any evidence-byte mutation changes it.
 *
 * @param {object} input
 * @param {string} input.gateId
 * @param {string} input.missionId
 * @param {string} input.chainId
 * @param {number} input.policyVersion
 * @param {object} input.seat — {provider, model, reasoning_effort, substituted, ...}
 * @param {Array<{id: string, detail?: string}>} input.triggers
 * @param {string} input.container
 * @param {string} input.baseSha
 * @param {object} input.changeScope
 * @param {Array<{role: string, source: string, content: string, path: string,
 *                 maxBytes?: number}>} input.items
 * @param {Array<{gate_id: string, verdict: string, envelope_sha256: string}>}
 *        [input.priorVerdicts]
 * @param {number} [input.envelopeMaxBytes] — the COMPLETE envelope budget in
 *        UTF-8 bytes, used literally as the cap on the canonical serialization
 *        of the whole RETURNED seat-visible envelope INCLUDING the
 *        `envelope_sha256` field the build delivers.  DEFAULT_ENVELOPE_MAX_BYTES
 *        applies only when the caller omits the value; a cap below the default
 *        is a real cap, and if the envelope's own metadata cannot fit it the
 *        build fails closed with `envelope-metadata-over-budget`.
 * @param {boolean} [input.allowSubstitute]
 * @param {(path: string, content: string) => void} [input.writeFile] — the
 *        injected writer for the read-only evidence tree.  When absent the
 *        envelope is still fully materialized in memory (pure mode).
 * @returns {object} the immutable envelope, including `envelope_sha256`.
 */
export function buildAuditEnvelope(input) {
  const seat = input.seat ?? null;
  if (seat && seat.substituted === true && input.allowSubstitute !== true) {
    throw codedError(
      "substitution-not-authorized",
      `seat model "${seat.model}" is a substitution for the exact seat and allowSubstitute is not set — ` +
      "exact-seat substitution is fail-closed and always recorded",
    );
  }

  const roleSet = new Set(ENVELOPE_ROLES);
  const itemsIn = Array.isArray(input.items) ? input.items : [];
  for (const item of itemsIn) {
    if (!item || typeof item !== "object") {
      throw codedError("unknown-role", "every evidence item must be an object with a role");
    }
    if (!roleSet.has(item.role)) {
      throw codedError(
        "unknown-role",
        `unknown evidence role "${item.role}" — the frozen materialization set is ${ENVELOPE_ROLES.join(", ")}`,
      );
    }
    if (typeof item.path !== "string" || !item.path.startsWith(EVIDENCE_TREE_PREFIX)) {
      throw codedError(
        "invalid-path",
        `evidence path "${item.path}" must live under the read-only evidence tree (${EVIDENCE_TREE_PREFIX}...)`,
      );
    }
    if (item.path.split("/").includes("..") || item.path.includes("\\")) {
      throw codedError(
        "invalid-path",
        `evidence path "${item.path}" must not escape the evidence tree (no ".." segments, no backslashes)`,
      );
    }
  }

  const priorVerdicts = Array.isArray(input.priorVerdicts) ? input.priorVerdicts : [];
  for (const verdict of priorVerdicts) {
    const ok =
      verdict &&
      typeof verdict === "object" &&
      typeof verdict.envelope_sha256 === "string" &&
      ENVELOPE_SHA256_RE.test(verdict.envelope_sha256) &&
      typeof verdict.verdict === "string" &&
      verdict.verdict !== "";
    if (!ok) {
      throw codedError(
        "invalid-prior-verdict",
        "every prior verdict must carry a verdict value and a 64-hex envelope_sha256",
      );
    }
  }

  const envelopeMaxBytes =
    Number.isFinite(input.envelopeMaxBytes) && input.envelopeMaxBytes > 0
      ? input.envelopeMaxBytes
      : DEFAULT_ENVELOPE_MAX_BYTES;

  // Deterministic budget: each item is truncated to its own bound, then the
  // envelope payload cap is enforced in item order.  Every byte that is not
  // kept is named in `omissions` — content is never silently dropped.
  //
  // The item pass is PURE (no file writes): the evidence tree is written
  // only after the final budget is settled, so a fail-closed envelope never
  // materializes a partial tree and the whole-envelope reduction passes
  // below never write anything.
  function materializeItems(itemBudget) {
    const items = [];
    const omissions = [];
    const written = [];
    let remaining = itemBudget;
    for (const item of itemsIn) {
      const itemBound =
        Number.isFinite(item.maxBytes) && item.maxBytes >= 0 ? item.maxBytes : Infinity;
      const bound = Math.min(itemBound, remaining);
      // Scrub the FULL untruncated content FIRST, then truncate (kusabi #529
      // finding 1): a head+tail splice of raw text can cut a credential in
      // half so that no whole-token shape remains to match — the fragment
      // would reach materialized evidence and the item sha256.  Scrubbing the
      // untruncated content removes the whole credential (the placeholder
      // itself matches no token shape), and the truncation then operates on
      // credential-free text.  The scrubbed bytes are what the seat reads and
      // what the item sha256 binds.
      const scrubbed = scrubSecrets(item.content);
      const truncated = truncateEvidenceText(scrubbed, { maxBytes: bound });
      const writtenText = truncated.text;
      const bytes = Buffer.byteLength(writtenText, "utf8");
      const record = {
        role: item.role,
        source: item.source,
        sha256: sha256(writtenText),
        bytes,
        path: item.path,
      };
      if (truncated.truncated) {
        record.truncated = true;
        record.omitted_bytes = truncated.omitted_bytes;
        record.truncation = truncated.truncation;
        omissions.push({
          role: item.role,
          path: item.path,
          omitted_bytes: truncated.omitted_bytes,
          truncation: truncated.truncation,
        });
      }
      items.push(record);
      written.push([item.path, writtenText]);
      remaining = Math.max(0, remaining - bytes);
    }
    return { items, omissions, written };
  }

  function assembleEnvelope(items, omissions) {
    const { sampled, mandatory } = classifyGate(input.triggers);
    return {
      envelope_version: ENVELOPE_VERSION,
      gate_id: input.gateId,
      mission_id: input.missionId,
      chain_id: input.chainId,
      policy_version: input.policyVersion,
      seat,
      triggers: Array.isArray(input.triggers) ? input.triggers : [],
      sampled,
      mandatory,
      container: input.container,
      base_sha: input.baseSha,
      change_scope: input.changeScope,
      items,
      prior_verdicts: priorVerdicts,
      omissions,
    };
  }

  let materialized = materializeItems(envelopeMaxBytes);
  let envelope = assembleEnvelope(materialized.items, materialized.omissions);
  // The budget measures the COMPLETE RETURNED envelope: the hash-less
  // serialization plus the 64-hex `envelope_sha256` field the build delivers
  // (kusabi #529 final finding \u2014 a hash-less-only check silently under-budgeted
  // the returned bytes by 84).
  let envelopeBytes = completeEnvelopeBytes(envelope);

  // ---- whole-envelope bound (kusabi #529 finding 2, literal-cap fix) ----
  // `envelopeMaxBytes` is the COMPLETE seat-visible envelope budget: the
  // caller-visible cap applies LITERALLY to the canonical serialization of
  // the whole RETURNED envelope, INCLUDING the `envelope_sha256` field, and
  // DEFAULT_ENVELOPE_MAX_BYTES applies only when the caller omits the value.
  // A cap below the default is a real (small) cap, not an item-content
  // override \u2014 the complete canonical envelope must never exceed what the
  // caller asked for, and an unsatisfiable cap fails closed.  During the
  // budget pass the final hash value is unknown, but it is always 64
  // lowercase hex, so the deterministic 64-hex placeholder in
  // completeEnvelopeBytes measures byte-identical length to the real hash.
  // Enforcement is deterministic and fail-closed:
  //   - when the non-item/header material alone (the serialization with
  //     every item reduced to zero content) exceeds the budget, the build
  //     fails closed with the stable code `envelope-metadata-over-budget` \u2014
  //     no item reduction can satisfy the cap and provenance is NEVER
  //     silently dropped;
  //   - otherwise item content is reduced deterministically (head+tail with
  //     exact omitted_bytes recorded on the item and in `omissions`) until
  //     the complete canonical seat-visible serialization fits the budget.
  const envelopeBudget = envelopeMaxBytes;
  if (envelopeBytes > envelopeBudget) {
    const minimum = materializeItems(0);
    const minimumEnvelope = assembleEnvelope(minimum.items, minimum.omissions);
    const minimumBytes = completeEnvelopeBytes(minimumEnvelope);
    if (minimumBytes > envelopeBudget) {
      throw codedError(
        "envelope-metadata-over-budget",
        `envelope-metadata-over-budget: the envelope's non-item/header material alone serializes to ` +
        `${minimumBytes} bytes, exceeding the envelope budget of ${envelopeBudget} bytes \u2014 no item ` +
        "reduction can satisfy the cap, so the build fails closed and no provenance is dropped",
      );
    }
    // Binary search the largest item budget whose COMPLETE serialization
    // (including the hash field) fits the envelope budget.  Deterministic
    // (fixed 32-iteration search over the measured canonical serialization);
    // lo is always a fitting budget (materializeItems(0) fits, just verified)
    // and hi a non-fitting one (the original pass), so the final envelope is
    // guaranteed to fit.
    let lo = 0;
    let hi = envelopeMaxBytes;
    for (let i = 0; i < 32; i++) {
      const mid = Math.floor((lo + hi) / 2);
      if (mid === lo) break;
      const attempt = materializeItems(mid);
      const attemptEnvelope = assembleEnvelope(attempt.items, attempt.omissions);
      if (completeEnvelopeBytes(attemptEnvelope) <= envelopeBudget) lo = mid;
      else hi = mid;
    }
    materialized = materializeItems(lo);
    envelope = assembleEnvelope(materialized.items, materialized.omissions);
    envelopeBytes = completeEnvelopeBytes(envelope);
  }

  // Materialize the read-only evidence tree only for the FINAL settled
  // envelope, in item order.
  if (typeof input.writeFile === "function") {
    for (const [path, text] of materialized.written) input.writeFile(path, text);
  }

  // The hash binds the whole envelope EXCEPT the hash field itself.  The real
  // hash is 64 lowercase hex \u2014 byte-identical in serialized length to the
  // budget placeholder \u2014 so the measured budget is exactly the returned
  // envelope's size.
  return { ...envelope, envelope_sha256: sha256(canonicalJson(envelope)) };
}