// Job headers and status lines.

// POSIX single-quote shell quoting for a path rendered inside a command an
// operator runs AS PRINTED.  Single quotes are closed, escaped and reopened
// (`'` -> `'\''`), so spaces and special characters in a path can never
// produce a command that silently targets a different directory (kusabi #527
// finding 1).
function shellQuoteSingle(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function durationS(job) {
  if (!job.startedAt) return "?";
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  return Math.round((end - Date.parse(job.startedAt)) / 1000);
}

export function renderHeader(job) {
  const usageLine = (() => {
    const u = job.usage;
    if (!u || !u.available) return [];
    const parts = [`${u.input} in / ${u.output} out`];
    if (u.reasoning) parts.push(`${u.reasoning} reasoning`);
    return [`tokens: ${parts.join(", ")}`];
  })();

  // Model route + variant line (always shown when available).
  const routeLine = [];
  if (job.modelEntry) {
    routeLine.push(`route: ${job.modelEntry}`);
  } else if (job.stats?.models?.length) {
    routeLine.push(`model: ${job.stats.models.join(" → ")}`);
  }

  // Provider-error: show error details first.
  const errorLines = [];
  if (job.status === "provider-error") {
    errorLines.push(`provider-error: ${job.error || "unknown provider error"}`);
    if (job.retry) {
      const r = job.retry;
      errorLines.push(`  reason: ${r.reason || "unknown"}, attempt: ${r.attempt}, terminal: ${r.terminal || false}`);
      if (r.message) errorLines.push(`  provider message: ${r.message}`);
    }
  }

  // Fallbacks: show every fallback step.
  const fallbackLines = [];
  if (job.fallbacks && job.fallbacks.length > 0) {
    for (const fb of job.fallbacks) {
      let fbLine = `  fallback: ${fb.from} → ${fb.to || "(none)"} (${fb.reason || "retry"} at attempt ${fb.attempt})`;
      if (fb.message) fbLine += `: ${fb.message}`;
      fallbackLines.push(fbLine);
    }
  }

  // Backend-aware header/session lines (kusabi #184 Job B, third backend
  // kusabi #199, agy resume #316): a missing `backend` field predates the
  // backend split and means opencode, so the opencode output stays
  // byte-identical.  A claude job shows the claude continuation shape
  // (`claude -p --resume <id>`); the session id is the one recorded on the
  // job (a UUID for claude and agy, ses_* for opencode).
  //
  // The agy line shows the CLI's own continuation shape (`agy --conversation
  // <id>`): the recorded conversation_id is exactly what the CLI resumes
  // with, so the header advertises a command the backend honours (v1
  // printed "resume is not supported" — #316 removed that limit).
  const isClaude = job.backend === "claude";
  const isAgy = job.backend === "agy";
  const isCodex = job.backend === "codex";
  const backendLabel = isClaude ? "claude" : (isAgy ? "agy" : (isCodex ? "codex" : "opencode"));

  let sessionLine;
  if (isAgy) {
    sessionLine = `session: ${job.sessionID} (continue in agy: \`agy --conversation ${job.sessionID}\`)`;
  } else if (isClaude) {
    sessionLine = `session: ${job.sessionID} (continue in claude: \`claude -p --resume ${job.sessionID}\`)`;
  } else if (isCodex) {
    // The codex continuation is `codex exec resume <thread_id>` run under the
    // job-owned CODEX_HOME (the thread rollout/session state lives there).  The
    // rendered command is EXECUTABLE AS PRINTED: it sets HOME and CODEX_HOME to
    // the exact job-owned home the dispatch used (kusabi #527 finding 1).  A
    // record without the persisted home (pre-#527 or synthetic) prints the
    // explicit instruction instead of a command that would quietly resume the
    // wrong thread state.
    const codexHome = job.codexHome;
    if (typeof codexHome === "string" && codexHome !== "") {
      const quoted = shellQuoteSingle(codexHome);
      sessionLine =
        `session: ${job.sessionID} (continue in codex: ` +
        `\`HOME=${quoted} CODEX_HOME=${quoted} codex exec resume ${job.sessionID}\`)`;
    } else {
      sessionLine =
        `session: ${job.sessionID} (continue in codex: ` +
        `\`codex exec resume ${job.sessionID}\` after setting CODEX_HOME to the job-owned codex home)`;
    }
  } else {
    sessionLine = `session: ${job.sessionID} (continue in opencode: \`opencode -s ${job.sessionID}\`)`;
  }

  // Codex provenance rendering (kusabi #527, criterion 9): actual model when
  // measured, and the fixed reasoning effort.  Only ever shows fields the job
  // recorded; credential content is never rendered.
  const codexProvenanceLines = [];
  if (isCodex) {
    const prov = job.codexProvenance;
    if (prov && typeof prov === "object") {
      if (prov.state === "mismatch") {
        codexProvenanceLines.push(
          `provenance MISMATCH: requested ${prov.kind} ${prov.requested}, rollout shows ${prov.actual}`
        );
      } else if (prov.state === "unverifiable") {
        codexProvenanceLines.push(`provenance: unverifiable (${prov.reason ?? "unknown"})`);
      } else if (prov.state === "verified") {
        if (prov.model) codexProvenanceLines.push(`actual model: ${prov.model} (verified from rollout)`);
      }
    }
    if (job.reasoningEffort) codexProvenanceLines.push(`reasoning effort: ${job.reasoningEffort}`);
  }

  return [
    `${backendLabel} ${job.kind} ${job.id} — ${job.status} (${durationS(job)}s)`,
    sessionLine,
    ...(job.phase ? [`phase: ${job.phase}`] : []),
    ...(routeLine.length ? routeLine : []),
    ...codexProvenanceLines,
    ...usageLine,
    ...errorLines,
    ...fallbackLines,
    "",
  ].join("\n");
}

export function renderJobLine(job) {
  const orch = job.orchestrator?.model ? ` orch=${job.orchestrator.model}` : "";
  return `${job.id}  ${job.kind.padEnd(6)}  ${job.status.padEnd(9)}  ${durationS(job)}s${orch}  ${job.title ?? ""}`;
}

