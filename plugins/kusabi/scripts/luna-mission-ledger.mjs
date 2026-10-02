// Durable mission ledger and artifact persistence.
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./state-paths.mjs";
import { saveMissionRecord } from "./mission-store.mjs";
import { sanitizeBriefCorrectionDetail } from "./luna-prompt.mjs";

export function recordError(ctx, detail) {
  const { missionDir } = ctx;
  ctx.record = {
    ...ctx.record,
    coordinatorErrors: (ctx.record.coordinatorErrors ?? 0) + 1,
    coordinatorErrorsDetails: [
      ...(Array.isArray(ctx.record.coordinatorErrorsDetails) ? ctx.record.coordinatorErrorsDetails : []),
      { at: new Date().toISOString(), detail },
    ],
  };
  saveMissionRecord(missionDir, ctx.record);
}

// A deterministic pre-flight refusal of a Luna-authored brief is BOTH a
// coordinator error and a brief correction (kusabi #532 criterion 2): the
// counters agree by construction — one refusal, one of each — so a
// pure-brief-correction mission never double-counts elsewhere.  The
// correction is ALSO persisted as a structured `briefCorrectionsDetails`
// entry carrying the timestamp, the ORIGINAL coordinator action and the
// deterministic validator detail (sanitized + bounded by the shared
// luna-prompt transform, so the persisted record and the rendered feedback
// can never disagree), which the bounded renderer exposes to the next
// coordinator turn (kusabi #553 follow-up).
export function recordBriefCorrection(ctx, action, detail) {
  const { missionDir } = ctx;
  const sanitized = sanitizeBriefCorrectionDetail(detail);
  const at = new Date().toISOString();
  ctx.record = {
    ...ctx.record,
    briefCorrections: (ctx.record.briefCorrections ?? 0) + 1,
    briefCorrectionsDetails: [
      ...(Array.isArray(ctx.record.briefCorrectionsDetails) ? ctx.record.briefCorrectionsDetails : []),
      { at, action, detail: sanitized },
    ],
  };
  saveMissionRecord(missionDir, ctx.record);
}

// Only interventions the system can OBSERVE are recorded (kusabi #532
// criterion 2): escalate_to_host, overrides, and explicit manifest entries.
// Manual container work is never inferred.
export function recordHostIntervention(ctx, detail) {
  const { missionDir } = ctx;
  ctx.record = {
    ...ctx.record,
    hostInterventions: (ctx.record.hostInterventions ?? 0) + 1,
    hostInterventionDetails: [
      ...(Array.isArray(ctx.record.hostInterventionDetails) ? ctx.record.hostInterventionDetails : []),
      { at: new Date().toISOString(), detail },
    ],
  };
  saveMissionRecord(missionDir, ctx.record);
}

export function recordProbe(ctx, req, output) {
  const { missionDir } = ctx;
  const capped = ctx.capProbeOutput(output);
  ctx.record = {
    ...ctx.record,
    probes: [
      ...(Array.isArray(ctx.record.probes) ? ctx.record.probes : []),
      {
        action: "read_probe",
        tool: req.tool,
        path: req.path,
        output: capped.output,
        outputBytes: capped.outputBytes,
        truncated: capped.truncated,
        omittedBytes: capped.omittedBytes,
        truncation: capped.truncation,
        at: new Date().toISOString(),
      },
    ],
  };
  saveMissionRecord(missionDir, ctx.record);
}

export function recordAttempt(ctx, { index, kind, chainId, brief: attemptBrief, output, postChain }) {
  const { missionDir } = ctx;
  const attemptRecord = {
    index,
    kind,
    chainId,
    brief: attemptBrief,
    status: "completed",
    output,
    ...(postChain ? { postChain } : {}),
    at: new Date().toISOString(),
  };
  ctx.record = {
    ...ctx.record,
    attempts: [
      ...(Array.isArray(ctx.record.attempts) ? ctx.record.attempts : []),
      attemptRecord,
    ],
    chains: [...(Array.isArray(ctx.record.chains) ? ctx.record.chains : []), chainId],
  };
  saveMissionRecord(missionDir, ctx.record);
  const attemptFile = path.join(missionDir, "attempts", `attempt-${index}.json`);
  fs.mkdirSync(path.dirname(attemptFile), { recursive: true });
  writeJson(attemptFile, ctx.record.attempts[ctx.record.attempts.length - 1]);
}

export function recordConsult(ctx, req) {
  const { missionDir } = ctx;
  ctx.record = {
    ...ctx.record,
    consults: [
      ...(Array.isArray(ctx.record.consults) ? ctx.record.consults : []),
      { action: "consult_sol", reason: req.reason ?? "", at: new Date().toISOString() },
    ],
  };
  saveMissionRecord(missionDir, ctx.record);
}

// Persist a freshly evaluated gate set (archival + the new gate record)
// BEFORE any further observable dispatch, so resume continues from a
// durable boundary.
export function recordGates(ctx, gates) {
  const { missionDir } = ctx;
  ctx.record = { ...ctx.record, auditGates: gates };
  saveMissionRecord(missionDir, ctx.record);
}

/**
 * Mirror a fired post-chain gate's audit columns onto the durable inner
 * chain round the gate judged (kusabi #532 adjudication finding 5).  The
 * round record lives in TWO durable mirrors \u2014 `round-<N>.json` and the
 * terminal entry of `chain.json`'s `records` array (the array the metrics
 * ingest reads) \u2014 and both are updated through the existing safe
 * read/update/write boundary (readJson / atomic writeJson).  The mission
 * gate record stays authoritative; this is a best-effort mirror that never
 * changes the gate decision.
 *
 * Only when the target round is POSITIVELY identified: the chain's
 * terminal record must be an object with a numeric `round`, and both
 * `chain.json` and the `round-<N>.json` file must exist and parse.
 * Absent or unreadable legacy records are left untouched.
 */
export function persistRoundAuditColumns(ctx, { chainId, gate, outcome }) {
  const { stateDir } = ctx;
  if (!gate || typeof gate !== "object") return;
  const chainDir = path.join(stateDir, "chains", chainId);
  const chainJson = readJson(path.join(chainDir, "chain.json"));
  if (!chainJson || typeof chainJson !== "object") return;
  const records = Array.isArray(chainJson.records) ? chainJson.records : [];
  const terminal = records[records.length - 1];
  if (!terminal || typeof terminal !== "object" || typeof terminal.round !== "number") return;
  const roundRecord = readJson(path.join(chainDir, `round-${terminal.round}.json`));
  if (!roundRecord || typeof roundRecord !== "object") return;

  const auditColumns = {
    auditVerdict: typeof gate.verdict === "string" ? gate.verdict : null,
    auditBlocked: outcome === "sol-blocked" || outcome === "block",
    auditShadowDisposition:
      typeof gate.shadowDisposition === "string" ? gate.shadowDisposition : null,
  };
  writeJson(path.join(chainDir, `round-${terminal.round}.json`), {
    ...roundRecord,
    ...auditColumns,
  });
  writeJson(path.join(chainDir, "chain.json"), {
    ...chainJson,
    records: records.map((r, i) =>
      i === records.length - 1 ? { ...r, ...auditColumns } : r,
    ),
  });
}

export function replaceRecord(ctx, patch) {
  ctx.record = { ...ctx.record, ...patch };
  saveMissionRecord(ctx.missionDir, ctx.record);
}

export function persistInvestigationArtifact(ctx, relativePath, content) {
  const fullPath = path.join(ctx.missionDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
}

export function persistCoordinatorEnvelope(ctx, envelope) {
  writeJson(path.join(ctx.missionDir, "evidence", `envelope-${ctx.dispatchIndex}.json`), envelope);
}

export function persistCoordinatorOutput(ctx, rawOutput) {
  fs.mkdirSync(path.join(ctx.missionDir, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(ctx.missionDir, "evidence", `coordinator-output-${ctx.dispatchIndex}.txt`), String(rawOutput ?? ""), "utf8");
}
