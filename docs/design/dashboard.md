# kusabi Design — Dashboard

How to *read* `kusabi-companion dashboard` and what each signal asks the
orchestrator to do. Code (`plugins/kusabi/scripts/dashboard.mjs`,
`dashboard-html.mjs`) is the source of truth for *what is shown*. This
document is the source of truth for *what it means and what to do next*.

It sits next to `docs/design/phase-chain.md`. Disposition vocabulary is
not restated here — see phase-chain.md §3.5.

## 1. Purpose and non-goals

The page answers four questions: what is running (and whether it is
moving), what ended and *why* (`failureClass` + disposition), what it
cost (as of the last `metrics-ingest`), and the drill-down for one
chain. It is not an audit log, not a grade of workers, and not a
control panel: there are no cancel/resume buttons (#352). Actions are
CLI (`chain-show`, `chain-cancel`, `chain-resume`, `serve-stop`,
re-dispatch with `chain`).

## 2. Starting it and where the data come from

```
kusabi-companion dashboard [--port N] [--state-root P] [--db P]
```

Default port **8752** (`usage()`). Binds `127.0.0.1`. `--state-root`
defaults to `~/.kusabi`; `--db` defaults to `<state-root>/metrics.db`.
The HTML auto-refreshes every 30 seconds. GET only.

State layout (one directory per workspace slug = `sha256(cwd)[:12]`):

```
~/.kusabi/
  metrics.db                 # filled by metrics-ingest, not by the dashboard
  <slug>/
    server.json              # serve pid; liveness is isPidAlive, not HTTP
    chains/chain-*/          # control.json, chain.json, round-N.json
    jobs/<jobId>/            # job.json, events.ndjson, result.md
```

Cost is `computeReport` over `metrics.db` opened read-only. `status:
"missing"` when the file does not exist. Freshness is
`freshness.lastIngestRun`. Reload after `kusabi-companion metrics-ingest`.
Running / Ended / Workspaces do not read the db.

## 3. Section by section

Every collector returns `meta{source, denominator, generatedAt}`. The
HTML prints `meta.source — meta.denominator` under each heading
(`heading()` in `dashboard-html.mjs`). Strings below are copied from
`makeMeta(...)` in `dashboard.mjs`.

### 3.1 Running

- **source:** `chains under <root>/*/chains with effectiveStatus running|stopping|stale`
- **denominator:** `chains whose control.json effectiveStatus is running, stopping, or stale`

Membership: `effectiveStatus(control)` ∈ `{running, stopping, stale}`.

| Column / badge | Computed from | Means |
|---|---|---|
| workspace | basename of `cwd` (title = slug) | Repo name; `—` if cwd is null |
| chain | `chainId` | Link to `/chain/<slug>/<id>` |
| round | `control.round` / `chainJson.maxRounds` | Current round over budget |
| backend + model | last round's `backend`; `chainJson.model` else last `model` | Seat in use |
| started | `control.startedAt` | When the chain process recorded start |
| last progress | newest mtime of `control.json`, `chain.json`, `round-N.json` | Relative time of last state write |
| **stalled** | `idleSeconds * 1000 >= DEFAULT_PROGRESS_TIMEOUT_MS` (2 h, `chain-wait.mjs`) **or** `!pidAlive` | Heuristic: no write, or pid gone. Pid-dead rows are *also* stalled |
| **pid-dead** | `isPidAlive(control.pid)` is false | Chain process is gone |
| serve alive/dead/absent | `server.json` pid via `isPidAlive` | Serve liveness is a pid probe, not HTTP |

### 3.2 Ended

- **source:** `chains under <root>/*/chains whose control.json status is completed, failed, or cancelled`
- **denominator:** `terminal chains ordered by finishedAt descending, then truncated to limit`

Index default `limit=30`. Amber row background = `failureClass === "provider-error"`.

| Column | Computed from | Means |
|---|---|---|
| finished | `control.finishedAt` | Terminal write time |
| workspace | cwd basename | Same as Running |
| chain | `chainId` | Drill-down |
| disposition | last round with a disposition object/string | phase-chain.md §3.5; not a grade |
| rounds | count of readable `round-N.json` | How many rounds were recorded |
| class | `classifyFailure` (see §3.2.1) | Why it stopped, with precedence |
| in / out / cost | `chain.json.chainTotals` | Copied totals; 0/null when unused |

Badge colours: **provider-error** amber; **refusal** / **refusal-disqualified**
blue (`startsWith("refusal")`); **empty-round**, **review-unparseable**,
**cancelled** grey.

#### 3.2.1 `classifyFailure` precedence

Function `classifyFailure` in `dashboard.mjs`. First match wins:

1. **provider-error** — *any* round's implement or review `job.json` has
   `status` in `PROVIDER_JOB_STATUSES` (`provider-error` / `serve-dead` /
   `stalled` / `timeout`) or `error` containing `quota`, `free_tier_limit`,
   or `routes exhausted`.
2. **refusal** — last round `implementRefusal.qualifies === true`.
3. **refusal-disqualified** — last round has `implementRefusal` but
   `qualifies !== true`.
4. **empty-round** — last round `worktreeChanged === false`.
5. **review-unparseable** — last round has `reviewJobId` and
   (`verdict === "unparseable"` or `reviewParseable === false`).
6. **cancelled** — `control.status === "cancelled"`.
7. **none**.

`failureDetail` for provider-error is `job.error` (else status), sliced
to 200 characters; the badge shows an 80-character excerpt.

### 3.3 Cost

- **source:** `metrics.db opened read-only (never created by this collector)`
- **denominator:** `in-window turns, chains and jobs in the metrics store`

| Signal | Computed from | Means |
|---|---|---|
| `metrics.db missing — run metrics-ingest` | `cost.status === "missing"` | File absent; other sections still work |
| `metrics.db last ingest <ts>` | `freshness.lastIngestRun` | Store age; dashboard never ingests |
| 7d / 30d / all | `?since=` on `/` | Window for `computeReport` only |
| sessionCostByModel | `computeReport.sessionCostByModel` | Turns / tokens / cost by model |
| byBackend.chains | `byBackend.chains` | Chain count, cost, rounds/chain |
| byBackend.jobs | `byBackend.jobs` | Job count and cost by backend |

### 3.4 Workspaces

- **source:** `workspace directories under the state root (each <root>/<slug>/ with chains/, jobs/, optional server.json)`
- **denominator:** `workspace directories immediately under the state root`

| Column | Computed from | Means |
|---|---|---|
| slug | directory name | `sha256(cwd)[:12]`; links to `/api/stats/<slug>.json` |
| cwd | `server.json.cwd`, else first `jobs/*/job.json` cwd | `null` if no job ever recorded cwd |
| chains | count of `chains/chain-*` | Chains in that workspace |
| jobs | count of `jobs/*` | Delegated jobs (includes chain jobs) |
| serve | `collectServe` pid probe | `alive` / `dead` / `present` / `absent` |

The stats JSON (not the HTML heading) uses source
`chain.json records under <root>/${slug}/chains` and denominator
`chain records collected for this workspace, optionally windowed by since/until`.

### 3.5 Chain page (`/chain/<slug>/<chainId>`)

- **source:** `control.json, chain.json, round-N.json and referenced jobs/<id>/job.json under <root>/${slug}/chains/${chainId}`
  (HTML prints the interpolated slug and id.)
- **denominator:** `one chain identified by workspace slug and chain id`

| Column / block | Computed from | Means |
|---|---|---|
| status | `resolveChainStatus(control, rounds)` | Running vs terminal label |
| verdict | `round.verdict` | Review seat output; see §3.5 of phase-chain.md |
| disposition | `round.disposition` | Same table as Ended |
| P1–P6 | `round.probeResults` (`ok` / `no` / `–`) | Deterministic probes; green = passed |
| changed | `round.worktreeChanged` | Whether implement wrote files |
| refusal | `round.implementRefusal` (`why` / `disqualification`) | Qualifying vs disqualified |
| tokens | `round.implementUsage` | That round's implement usage |
| Referenced jobs | `jobs/<id>/job.json` status + error | Provider death lives here |
| Digest | `renderChainShow` | Same text as `chain-show` |

## 4. Decision table

| You see | It means | Do |
|---|---|---|
| Running row with **stalled** (pid alive) | No state change for ≥ 2 h; worker may be looping or the provider hung | `chain-show <id>`; check `jobs/<implementJobId>/events.ndjson` tail; if nothing moves, `chain-cancel <id>` and re-dispatch |
| Running row with **pid-dead**, status `stale` | The chain process died without writing a terminal control record | `chain-resume <id>` (resumes from the last phase boundary) or re-dispatch; the container is still alive — check `sandbox_list_containers` before discarding |
| Ended, class **provider-error** (amber) | A backend refused or died (quota, free-tier limit, serve dead, watchdog, timeout). **Not a worker failure; nothing about the brief or the code is known yet** | Read the detail excerpt: quota → wait for the reset time it states or switch backend (`--backend` / `--model`); serve-dead → `serve-stop --force` then re-dispatch; stalled/timeout → same as stalled above. Re-use the same container and brief |
| Ended, class **refusal** (blue) | The worker stopped on a *qualifying* refusal: it names two anchors in the brief/repo that contradict each other | The brief is wrong, not the worker. Read `implementRefusal.why` on the chain page, fix the brief, re-dispatch on the same container (worktree is clean) |
| Ended, class **refusal-disqualified** | A refusal block was written but failed the anchor/format gate | Read `disqualification`; under `--container` a file anchor can be a false negative (kusabi#351) — judge the refusal yourself before re-dispatching |
| Ended, class **empty-round** (grey) | The worker changed nothing and no review ran (read-only round, typical of free-tier models on large files) | Re-cut the brief: name exact line ranges, split src from tests, or move to a stronger seat. Look at the job's `result.md` — a sound design written there is free brief material |
| Ended, class **review-unparseable** (grey), probes green | Implementation exists and passed the deterministic probes; only the review seat died | Do not rework. Either buy a replacement review (`chain-resume`) or inspect the diff yourself when it is small (≤ ~250 lines) |
| Ended, class **none**, disposition `escalate` | A substantive escalate: findings survived, repeated area, or round budget | `chain-show`; adjudicate findings (phase-chain.md §3.5) — send back, new job, follow-up, or fix the brief |
| Ended, class **none**, disposition `accept` / `accept-with-followup` | Normal completion; `accept-with-followup` carries a drafted follow-up in `chain.json.followupIssueDraft` | Inspect, publish, post the review record; decide whether to file the follow-up |
| Cost: "metrics.db missing" or an old `lastIngestRun` | The store has not been refreshed | `kusabi-companion metrics-ingest` then reload; the other sections do not depend on it |
| Workspace with `cwd: null` | No job has ever recorded its cwd in that workspace (chains only) | Harmless; the slug is `sha256(cwd)[:12]` |

## 5. What the numbers do not say

- **stalled** is a heuristic: idle ≥ 2 h *or* pid gone. A healthy but
  silent review seat can trip it; a looping worker that still writes
  round files will not.
- `classifyFailure` scans **every** round's implement/review `job.json`
  for provider-error first, then uses **only the last round** for
  refusal / empty-round / review-unparseable, and `control.status` for
  cancelled. An earlier provider-error therefore *wins* (it is not
  hidden). An earlier empty-round or refusal *is* hidden if a later
  round completed without those marks.
- Index **in/out/cost** are `chain.json.chainTotals`, not recomputed.
  Free seats often store 0. The dashboard does not read
  `usage.available`.
- **review-unparseable** requires a `reviewJobId` on the last round.
  Before #354, empty rounds could be labelled review-unparseable;
  records ingested before 2026-08-22 may still look that way in
  `metrics.db`. Live classification uses the order in §3.2.1.
- Ended **probes green** is not a column on the index (JSON field
  `probesGreenLastRound`); read P1–P6 on the chain page.
- The page does not say whether a container still exists.

## 6. Adding a panel

Collectors return `meta` via `makeMeta(source, denominator)`. A new
number must ship with its `denominator` string (what the count is *of*)
and a test in `plugins/kusabi/scripts/dashboard.test.mjs`. HTML must
print `meta.source` / `meta.denominator` under the new heading so this
document can quote them verbatim. Do not add action buttons; the page
stays read-only.
