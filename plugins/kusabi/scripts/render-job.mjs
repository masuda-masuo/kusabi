// Job headers and status lines.

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
  const backendLabel = isClaude ? "claude" : (isAgy ? "agy" : "opencode");

  let sessionLine;
  if (isAgy) {
    sessionLine = `session: ${job.sessionID} (continue in agy: \`agy --conversation ${job.sessionID}\`)`;
  } else if (isClaude) {
    sessionLine = `session: ${job.sessionID} (continue in claude: \`claude -p --resume ${job.sessionID}\`)`;
  } else {
    sessionLine = `session: ${job.sessionID} (continue in opencode: \`opencode -s ${job.sessionID}\`)`;
  }

  return [
    `${backendLabel} ${job.kind} ${job.id} — ${job.status} (${durationS(job)}s)`,
    sessionLine,
    ...(job.phase ? [`phase: ${job.phase}`] : []),
    ...(routeLine.length ? routeLine : []),
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

