// dashboard-html.mjs — pure HTML rendering over dashboard collector results.
// No I/O. Every dynamic string goes through esc().

export function esc(value) {
  if (value == null) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const CSS = `
:root { color-scheme: light; }
body { font: 14px/1.4 system-ui, sans-serif; margin: 1.25rem; color: #1a1a1a; }
h1 { font-size: 1.25rem; margin: 0 0 1rem; }
h2 { font-size: 1.05rem; margin: 1.4rem 0 0.2rem; }
h2 + small { display: block; color: #555; margin-bottom: 0.6rem; }
table { border-collapse: collapse; width: 100%; margin: 0.4rem 0 0.8rem; }
th, td { border: 1px solid #ddd; padding: 0.3rem 0.5rem; text-align: left; vertical-align: top; }
th { background: #f4f4f4; font-weight: 600; }
.muted { color: #666; }
.badge { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.85em; }
.stalled { background: #c62828; color: #fff; }
.pid-dead { background: #6d4c41; color: #fff; }
.fc-provider-error { background: #e6a817; color: #1a1a1a; }
.fc-refusal { background: #1565c0; color: #fff; }
.fc-muted { background: #9e9e9e; color: #fff; }
tr.row-provider { background: #fff4d6; }
.probe { text-align: center; width: 2.4rem; }
.probe.pass { background: #c8e6c9; }
.probe.fail { background: #ffcdd2; }
.probe.miss { color: #999; }
pre { background: #f6f6f6; padding: 0.75rem; overflow: auto; white-space: pre-wrap; }
footer { margin-top: 2rem; color: #555; font-size: 0.85rem; }
.windows a { margin-right: 0.6rem; }
.empty { color: #666; margin: 0.4rem 0 0.8rem; }
`;

function layout(title, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function heading(title, meta) {
  const source = meta && meta.source != null ? String(meta.source) : "";
  const denominator = meta && meta.denominator != null ? String(meta.denominator) : "";
  return `<h2>${esc(title)}</h2>\n<small>${esc(source)} — ${esc(denominator)}</small>`;
}

function cwdBasename(cwd) {
  if (typeof cwd !== "string" || !cwd) return "—";
  const parts = cwd.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}

function relativeTime(iso, nowMs) {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return esc(iso);
  const sec = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function fmtNum(n) {
  if (n == null || n === "") return "—";
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return esc(n);
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 10000) / 10000);
}

function excerpt(text, n = 80) {
  if (text == null || text === "") return "";
  const s = String(text);
  return s.length > n ? s.slice(0, n) : s;
}

function serveLabel(workspaces, slug) {
  const list = Array.isArray(workspaces) ? workspaces : [];
  const ws = list.find((w) => w && w.slug === slug);
  if (!ws || !ws.serve || !ws.serve.present) return "serve absent";
  if (ws.serve.alive === true) return "serve alive";
  if (ws.serve.alive === false) return "serve dead";
  return "serve present";
}

function failureBadge(cls, detail) {
  if (!cls || cls === "none") return `<span class="muted">none</span>`;
  const kind = String(cls).startsWith("refusal") ? "refusal" : cls;
  const css = kind === "provider-error" ? "fc-provider-error"
    : kind === "refusal" ? "fc-refusal"
    : "fc-muted";
  const extra = cls === "provider-error" && detail
    ? ` ${esc(excerpt(detail, 80))}`
    : "";
  return `<span class="badge ${css}">${esc(cls)}${extra}</span>`;
}

function windowLinks(query, nowMs) {
  const q = query && typeof query === "object" ? query : {};
  function href(since) {
    const params = new URLSearchParams();
    if (since) params.set("since", since);
    if (q.until) params.set("until", String(q.until));
    if (q.limit != null) params.set("limit", String(q.limit));
    const s = params.toString();
    return esc(s ? `/?${s}` : "/");
  }
  const d7 = new Date(nowMs);
  d7.setUTCDate(d7.getUTCDate() - 7);
  const d30 = new Date(nowMs);
  d30.setUTCDate(d30.getUTCDate() - 30);
  return `<p class="windows">window: <a href="${href(d7.toISOString())}">7d</a>`
    + `<a href="${href(d30.toISOString())}">30d</a>`
    + `<a href="${href("")}">all</a></p>`;
}

function renderRunning(running, workspaces, nowMs) {
  const chains = Array.isArray(running.chains) ? running.chains : [];
  const rows = chains.map((c) => {
    const stalled = c.stalled
      ? ` <span class="badge stalled">stalled</span>` : "";
    const pidDead = c.pidAlive === false
      ? ` <span class="badge pid-dead">pid-dead</span>` : "";
    const name = cwdBasename(c.cwd);
    const href = `/chain/${encodeURIComponent(c.workspace)}/${encodeURIComponent(c.chainId)}`;
    return `<tr>
<td title="${esc(c.workspace)}">${esc(name)}</td>
<td><a href="${esc(href)}">${esc(c.chainId)}</a></td>
<td>${esc(c.round)}/${esc(c.maxRounds)}</td>
<td>${esc(c.backend)} ${esc(c.model)}</td>
<td>${esc(c.startedAt)}</td>
<td>${relativeTime(c.lastProgressAt, nowMs)}</td>
<td>${stalled}${pidDead} ${esc(serveLabel(workspaces, c.workspace))}</td>
</tr>`;
  });
  const table = chains.length === 0
    ? `<p class="empty">no chains running</p>`
    : `<table><thead><tr><th>workspace</th><th>chain</th><th>round</th><th>backend + model</th><th>started</th><th>last progress</th><th>flags</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  return `${heading("Running", running.meta)}\n${table}`;
}

function renderEnded(ended, query) {
  const chains = Array.isArray(ended.chains) ? ended.chains : [];
  const limit = query && query.limit != null ? query.limit : chains.length;
  const rows = chains.map((c) => {
    const href = `/chain/${encodeURIComponent(c.workspace)}/${encodeURIComponent(c.chainId)}`;
    const rowClass = c.failureClass === "provider-error" ? ` class="row-provider"` : "";
    const tok = c.tokens || {};
    return `<tr${rowClass}>
<td>${esc(c.finishedAt)}</td>
<td>${esc(cwdBasename(c.cwd))}</td>
<td><a href="${esc(href)}">${esc(c.chainId)}</a></td>
<td>${esc(c.disposition)}</td>
<td>${esc(c.rounds)}</td>
<td>${failureBadge(c.failureClass, c.failureDetail)}</td>
<td>${fmtNum(tok.input)}</td>
<td>${fmtNum(tok.output)}</td>
<td>${fmtNum(tok.cost)}</td>
</tr>`;
  });
  const table = chains.length === 0
    ? `<p class="empty">no ended chains</p>`
    : `<table><thead><tr><th>finished</th><th>workspace</th><th>chain</th><th>disposition</th><th>rounds</th><th>class</th><th>in</th><th>out</th><th>cost</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  return `${heading(`Ended (last ${limit})`, ended.meta)}\n${table}`;
}

function kvTable(headers, rows) {
  if (!rows.length) return `<p class="empty">none</p>`;
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const body = rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderCost(cost, query, nowMs) {
  const meta = cost && cost.meta ? cost.meta : {};
  let freshnessLine;
  if (!cost || cost.status === "missing") {
    freshnessLine = `<p>metrics.db missing — run <code>metrics-ingest</code></p>`;
  } else {
    const ts = cost.freshness && cost.freshness.lastIngestRun
      ? cost.freshness.lastIngestRun : "unknown";
    freshnessLine = `<p>metrics.db last ingest ${esc(ts)}</p>`;
  }
  const models = Array.isArray(cost && cost.sessionCostByModel) ? cost.sessionCostByModel : [];
  const modelRows = models.map((r) => [
    esc(r.model), fmtNum(r.turnCount), fmtNum(r.input), fmtNum(r.output), fmtNum(r.costUnits),
  ]);
  const chainRows = Array.isArray(cost && cost.byBackend && cost.byBackend.chains)
    ? cost.byBackend.chains.map((r) => [
      esc(r.backend), fmtNum(r.chainCount), fmtNum(r.costUnits), fmtNum(r.roundsPerChain),
    ]) : [];
  const jobRows = Array.isArray(cost && cost.byBackend && cost.byBackend.jobs)
    ? cost.byBackend.jobs.map((r) => [
      esc(r.backend), fmtNum(r.jobCount), fmtNum(r.costUnits),
    ]) : [];
  return `${heading("Cost", meta)}
${freshnessLine}
${windowLinks(query, nowMs)}
<h3>sessionCostByModel</h3>
${kvTable(["model", "turns", "input", "output", "cost"], modelRows)}
<h3>byBackend.chains</h3>
${kvTable(["backend", "chains", "cost", "rounds/chain"], chainRows)}
<h3>byBackend.jobs</h3>
${kvTable(["backend", "jobs", "cost"], jobRows)}`;
}

function renderWorkspaces(payload) {
  const list = Array.isArray(payload.workspaces) ? payload.workspaces : [];
  const rows = list.map((w) => {
    const href = `/api/stats/${encodeURIComponent(w.slug)}.json`;
    let serve = "absent";
    if (w.serve && w.serve.present) {
      if (w.serve.alive === true) serve = "alive";
      else if (w.serve.alive === false) serve = "dead";
      else serve = "present";
    }
    return `<tr>
<td><a href="${esc(href)}">${esc(w.slug)}</a></td>
<td>${esc(w.cwd)}</td>
<td>${esc(w.chainCount)}</td>
<td>${esc(w.jobCount)}</td>
<td>${esc(serve)}</td>
</tr>`;
  });
  const table = list.length === 0
    ? `<p class="empty">no workspaces</p>`
    : `<table><thead><tr><th>slug</th><th>cwd</th><th>chains</th><th>jobs</th><th>serve</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  return `${heading("Workspaces", payload.meta)}\n${table}`;
}

const API_FOOTER = `GET /api
GET /api/workspaces.json
GET /api/running.json
GET /api/ended.json?limit=N
GET /api/chain/<slug>/<chainId>.json
GET /api/cost.json?since=ISO&until=ISO
GET /api/stats/<slug>.json?since=&until=`;

export function renderIndexHtml(data = {}) {
  const nowMs = typeof data.now === "number" ? data.now : Date.now();
  const running = data.running || { meta: {}, chains: [] };
  const ended = data.ended || { meta: {}, chains: [] };
  const cost = data.cost || { status: "missing", meta: {} };
  const workspaces = data.workspaces || { meta: {}, workspaces: [] };
  const query = data.query || {};
  const wsList = workspaces.workspaces;
  const body = `<h1>kusabi dashboard</h1>
${renderRunning(running, wsList, nowMs)}
${renderEnded(ended, query)}
${renderCost(cost, query, nowMs)}
${renderWorkspaces(workspaces)}
<footer><pre>${esc(API_FOOTER)}</pre></footer>`;
  return layout("kusabi dashboard", body);
}

function probeCell(results, n) {
  const list = Array.isArray(results) ? results : [];
  const re = new RegExp(`^P${n}\\b`);
  const hit = list.find((p) => re.test(String(p && p.probe != null ? p.probe : "")));
  if (!hit) return `<td class="probe miss">–</td>`;
  const cls = hit.passed ? "probe pass" : "probe fail";
  const label = hit.passed ? "ok" : "no";
  return `<td class="${cls}" title="${esc(hit.detail)}">${label}</td>`;
}

function refusalSummary(refusal) {
  if (!refusal || typeof refusal !== "object") return "—";
  const bits = [];
  if (refusal.qualifies === true) bits.push("qualifies");
  if (refusal.qualifies === false) bits.push("disqualified");
  if (refusal.why) bits.push(String(refusal.why));
  if (refusal.disqualification) bits.push(String(refusal.disqualification));
  return bits.length ? esc(bits.join("; ")) : "—";
}

function dispCell(round) {
  const d = round && round.disposition;
  if (!d) return "—";
  if (typeof d === "string") return esc(d);
  const label = d.disposition != null ? String(d.disposition) : "";
  const reason = d.reason != null ? String(d.reason) : "";
  return esc(reason ? `${label} (${reason})` : label);
}

export function renderChainHtml(detail) {
  if (!detail || detail.error) {
    const msg = detail && detail.error ? String(detail.error) : "chain not found";
    const body = `<h1>Chain not found</h1><p>${esc(msg)}</p><p><a href="/">← dashboard</a></p>`;
    return layout("Chain not found", body);
  }
  const chain = detail.chain || {};
  const chainId = chain.chainId || "";
  const rounds = Array.isArray(detail.rounds) ? detail.rounds : [];
  const roundRows = rounds.map((r) => {
    const usage = r.implementUsage || {};
    const probes = [1, 2, 3, 4, 5, 6].map((n) => probeCell(r.probeResults, n)).join("");
    const changed = r.worktreeChanged === true ? "yes" : r.worktreeChanged === false ? "no" : "—";
    return `<tr>
<td>${esc(r.round)}</td>
<td>${esc(r.verdict)}</td>
<td>${dispCell(r)}</td>
${probes}
<td>${esc(changed)}</td>
<td>${refusalSummary(r.implementRefusal)}</td>
<td>${fmtNum(usage.input)} / ${fmtNum(usage.output)} / ${fmtNum(usage.cost)}</td>
</tr>`;
  });
  const roundTable = rounds.length === 0
    ? `<p class="empty">no rounds</p>`
    : `<table><thead><tr><th>round</th><th>verdict</th><th>disposition</th><th>P1</th><th>P2</th><th>P3</th><th>P4</th><th>P5</th><th>P6</th><th>changed</th><th>refusal</th><th>tokens</th></tr></thead><tbody>${roundRows.join("")}</tbody></table>`;

  const jobs = detail.jobs && typeof detail.jobs === "object" ? Object.entries(detail.jobs) : [];
  const jobRows = jobs.map(([id, job]) => {
    const j = job || {};
    const err = j.error != null ? excerpt(j.error, 160) : "";
    return `<tr><td>${esc(id)}</td><td>${esc(j.status)}</td><td>${esc(err)}</td></tr>`;
  });
  const jobTable = jobs.length === 0
    ? `<p class="empty">no referenced jobs</p>`
    : `<table><thead><tr><th>id</th><th>status</th><th>error</th></tr></thead><tbody>${jobRows.join("")}</tbody></table>`;

  const digest = detail.digest != null ? String(detail.digest) : "";
  const slug = chain.workspace || "";
  const title = chainId ? `chain ${chainId}` : "chain";
  const body = `<p><a href="/">← dashboard</a></p>
<h1>${esc(title)}</h1>
<p>status: ${esc(detail.status)}${slug ? ` · workspace ${esc(slug)}` : ""}</p>
${heading("Rounds", detail.meta)}
${roundTable}
<h2>Referenced jobs</h2>
${jobTable}
<h2>Digest</h2>
<pre>${esc(digest)}</pre>`;
  return layout(title, body);
}
