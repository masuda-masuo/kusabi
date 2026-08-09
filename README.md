# kusabi (formerly opencode-plugin-cc)

Use [opencode](https://opencode.ai) from inside Claude Code — delegate tasks or run adversarial code reviews — without flooding Claude's context with opencode's intermediate output.

Modeled on [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (see [NOTICE](./NOTICE)), but built on opencode's HTTP server instead of a stdio broker.

## How it works

```
Claude Code ——/kusabi:* slash command——> kusabi-companion.mjs ——HTTP——> opencode serve (127.0.0.1, on-demand)
                                                │
                                                ├─ SSE /event: progress tracking + automatic permission replies
                                                ├─ state dir: full event log, job records, stored results
                                                └─ stdout: rendered final result ONLY
```

The companion script is a context firewall: opencode's narration, tool logs, and raw events are persisted under `~/.kusabi/<dir-hash>/` and never reach Claude. Claude only sees the rendered final result (or a compact status summary).

Key mechanics:

- **On-demand server** — `opencode serve` is started per project directory when first needed, bound to `127.0.0.1` with a random port and a generated `OPENCODE_SERVER_PASSWORD`. Healthy servers are reused; nothing needs to run 24/7.
- **Automatic permission replies** — permission asks from opencode are automatically answered with `"once"` over SSE. Write tools are denied according to the phase: implement sessions deny host write tools (bash, edit, write, patch) plus `sunaba_copy_project`/`sunaba_copy_file` at both the agent-definition level and the chain session level; review sessions deny the same set via a `tools` deny map; plain `task` only denies write tools when `--read-only`/`--deny` is passed. This avoids the headless "ask hangs forever" problem.
- **Structured review output** — reviews use a JSON schema that is **embedded in the prompt** (not passed as opencode's `format: json_schema`, which triggers a provider bug in opencode 1.17.x). The companion then parses the structured JSON from the model's response and renders it to readable markdown.

## Requirements

- [opencode CLI](https://opencode.ai) installed and authenticated (`opencode auth login`)
- Node.js 18.18 or later

## Install

```bash
/plugin marketplace add masuda-masuo/kusabi
/plugin install kusabi@kusabi
```

Then run `/kusabi:setup` to verify the CLI and server come up.

## Phase agents

kusabi ships 7 agent definitions (`plugins/kusabi/opencode-agents/`) that are automatically installed by `setup`:

| Agent | Phase role | Permission profile |
|---|---|---|
| `kusabi-draft` | Draft — research + issue creation | read-only + shiori + issue_write |
| `kusabi-investigate` | investigate — deep dive, root cause | read-only + shiori + issue_write |
| `kusabi-implement` | implement — code + verify | writes happen only via sunaba container tools (sunaba_edit_file/write_file); host bash/edit/write/patch and sunaba_copy_project/sunaba_copy_file **deny** |
| `kusabi-review` | review — adversarial review | verify/lint/type_check **allow**, sandbox_exec/sandbox_write/issue_write/pr_review_write **deny** (deliverable is structured report, not issue comments) |
| `kusabi-respond` | respond — address review findings | code write; issue_write **deny** |
| `kusabi-salvage` | salvage — recover stalled / dead jobs | read-only + structured report |
| `kusabi-gofer` | gofer — evidence-gathering errands | sandbox_exec + read/verify tools **allow**; host write/shiori/sunaba mutation **deny** |

Run `/kusabi:setup` or `kusabi-companion.mjs install-agents` to copy them to `OPENCODE_AGENT_DIR`. Legacy `oc-*` names are automatically cleaned up. The same command also copies kusabi's opencode skills (`plugins/kusabi/opencode-skills/`) to `OPENCODE_SKILL_DIR`, copy-and-overwrite only — the destination is never pruned. Both defaults follow opencode's own config dir (`$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`), which is where opencode actually scans. Note that `OPENCODE_SKILL_DIR` / `OPENCODE_AGENT_DIR` are placement overrides that opencode itself does not read (see `docs/DESIGN.md` §3.8).

## Commands

Slash commands (`plugins/kusabi/commands/`):

| Command | What it does |
| --- | --- |
| `/kusabi:task [--brief-file <path>]` | Delegate a task. Provide the brief inline or via `--brief-file <path>` (mutually exclusive). Flags: `--model provider/model`, `--agent name`, `--phase <name>`, `--read-only`, `--resume-last`, `--session <id>`, `--wait`, `--background`, `--deny <tools>`, `--timeout <s>`, `--watchdog <s>` |
| `/kusabi:review` | Adversarial, read-only review of the working tree; `--base <ref>` for branch review; `--prior <text>` for anti-ratchet carry-over; extra text = review focus. Host worktree only — `--container` is rejected; use `task --phase review` for container reviews |
| `/kusabi:status [job-id]` | Compact job list, or progress detail for one job |
| `/kusabi:result [job-id]` | Stored final output of a finished job |
| `/kusabi:cancel [job-id]` | Abort a running job |
| `/kusabi:setup` | Check CLI, start/reuse the server, install phase agents |

Everything else is a companion subcommand, invoked directly as
`node plugins/kusabi/scripts/kusabi-companion.mjs <subcommand>`:

| Subcommand | What it does |
| --- | --- |
| `chain [--brief-file <path>]` | **Auto chain** — run implement → review → rework until acceptance or escalate. Requires `--container <cid>`. Optional: `--model <provider/model>`, `--brief-file <path>`, `--max-rounds <N>` (default 4), `--session`, `--keep-serve`. When `--model` is omitted the model is resolved from the config file or built-in default chain. |
| `chain-resume <chainId>` | Resume a cancelled chain from its last recorded phase boundary (reads `chain.json` / `control.json`; same chain lifecycle as `chain`; only flag: `--keep-serve`) |
| `chain-show` | Compact plain-text digest of a chain (read-only, no LLM) |
| `chain-stats` | Aggregate every chain record and print a summary (read-only, no LLM) |
| `chain-cancel <chainId>` | Request a running chain to stop (file-based, works across processes) |
| `metrics-ingest` | Ingest transcripts + chain records + delegated-job records into a durable SQLite store (read-only source, no LLM) |
| `metrics-report` | Query/report over the SQLite metrics store (read-only, no LLM, never ingests) |
| `serve-stop` | Stop the background opencode server and remove its state file; declines with running jobs unless `--force` |
| `install-agents` | Copy phase agent definitions to `OPENCODE_AGENT_DIR` and opencode skills to `OPENCODE_SKILL_DIR` |
| `salvage <job-id>` | Recover a dead/stalled job: reads its prompt + events, launches a salvage agent to produce a structured report |

The `kusabi:opencode-worker` subagent forwards delegation requests to `task` so the main Claude thread never carries the work.

## Skills

| Skill | What it is for |
| --- | --- |
| `delegate` | The orchestrator-side discipline: what belongs in a brief, how to inspect what comes back, what never leaves the orchestrator. Load it before starting an implementation task. |
| `kusabi-result-handling` | Internal rule for relaying worker output faithfully (not user-invocable). |
| `metrics` | Refresh the kusabi metrics store and report from it (ingest, then report); use for "show me the metrics" / "how is token efficiency" / an explicit `/metrics` request, passing window arguments through. |
| `update` | Reflect a merged kusabi change into the running local installation (pull, stop serve, redistribute agents, relink the plugin cache); load after merging any kusabi PR. |

The `delegate` skill intentionally points at `--help` and `docs/DESIGN.md` for the CLI
surface and the chain semantics instead of restating them, so that improving kusabi does
not silently make the skill wrong.

Every result includes the opencode session ID; continue the same session in the opencode TUI with `opencode -s <session-id>`.

## Model configuration

By default, kusabi resolves the model to use through the built-in **tiered**
chain (`BUILTIN_DEFAULT_CHAIN` in `plugins/kusabi/scripts/cli.mjs`): two
tiers, with the `:max` reasoning variant pinned on every route:

    tier 0: opencode/deepseek-v4-flash-free:max  ↔  opencode-go/deepseek-v4-flash:max
    tier 1: opencode-go/deepseek-v4-pro:max

Tier 0's two routes are interchangeable — the same quality, tried in order
when one is unavailable. That is capacity fallback, not a quality step: with
the default ladder, rounds 1 and 2 both run on tier 0 and the second tier is
first reached at round 3 (see "Chain round escalation"). The first route of
the current tier is used unless overridden.

You can customise this with a config file at `<state root>/config.json`
(typically `~/.kusabi/config.json`, or the directory pointed to by
`KUSABI_STATE_DIR` or `OPENCODE_COMPANION_STATE_DIR`).

```json
{
  "models": {
    "chain": [
      ["opencode/deepseek-v4-flash-free:max", "opencode-go/deepseek-v4-flash:max"],
      ["opencode-go/deepseek-v4-pro:max"]
    ],
    "phases": { "implement": ["opencode-go/deepseek-v4-flash"] }
  }
}
```

Flat all-string chains are still accepted (each string is a single-route
tier) — but the built-in default is the tiered shape above.

### Variant syntax

Chain entries (and `--model` / `task --model`) accept an optional `:variant` suffix:

    provider/model[:variant]

For example, `opencode-go/deepseek-v4-flash:max` requests the model with
reasoning effort set to `max`. The variant is passed as the top-level
`variant` field in the `POST /session/{id}/prompt_async` request body.

**Caveat:** opencode silently ignores a variant the model does not define — no
error is returned. To detect this, inspect the `modelVariant` field stored on
each chain round record or the `variant` field in `job.modelChain` entries via
`/kusabi:status <job-id>` or `/kusabi:result <job-id>`.

A trailing colon (`p/a:`) or missing `/` are fatal parse errors.

### Backends

`chain` and `task` accept `--backend opencode|claude` (default `opencode`).
The backend is resolved once at command start and recorded as `backend` on
every job record and chain round record; records written before the backend
split (or without the field) are treated as `opencode` by readers.

- **opencode** (default) — dispatch through `opencode serve`, with the
  tiered chain, capacity fallback, and `provider/model[:variant]` model
  syntax described above.
- **claude** — dispatch through the official Claude Code CLI in headless
  mode (`claude -p --output-format json`). v1 limits: one model per phase
  (the `--model` value, or the chain's first route — the tier ladder and
  capacity fallback do not apply), and `:variant` suffixes are rejected with
  an explicit error (a `--model` value such as `opus:max` fails before any
  job is dispatched). Session resume IS supported: `--session <id>` /
  `--resume-last`, chain rework rounds, and `chain-resume` continue the
  previous session via `claude -p --resume <session-id>` (an opencode-shaped
  `ses_*` id is rejected with a loud cross-backend error; `--resume-last`
  only selects jobs of the same backend). Model syntax is a bare alias
  (`opus`, `sonnet`, `haiku`) or a full model id (e.g.
  `claude-sonnet-4-5`). The binary is resolved through `CLAUDE_BIN`
  (default `claude`).

The claude backend mirrors the opencode agents' permission tables with two
hardcoded `--allowedTools` allowlists (implement, review; see
`plugins/kusabi/scripts/claude-dispatch.mjs`) and passes the agent body from
`plugins/kusabi/opencode-agents/<agent>.md` (YAML frontmatter stripped) via
`--append-system-prompt`. The sunaba MCP server entry is extracted from the
host `~/.claude.json` (`mcpServers.sunaba`) into a generated
`--mcp-config` file containing only that entry — override the source file
with `KUSABI_CLAUDE_MCP_SOURCE`; a missing entry is a clear error. See
`docs/DESIGN.md` §3.5.11 for the v1 limits and failure semantics.

### Resolution precedence (highest to lowest)

1. **Explicit `--model` flag** — wins for the phases it applies to: a single `task` dispatch, a chain's round-1 implement, and every chain review. A chain's rework rounds follow the tier ladder instead (see "Chain round escalation" below).
2. **Per-phase chain** — `models.phases.<phase>` first entry (e.g. a config with `"implement": ["m1"]` resolves to `m1` for implement-phase tasks).
3. **Global chain** — `models.chain` first entry, or the built-in default chain when no config file exists.
4. **Built-in default** — the first route of `BUILTIN_DEFAULT_CHAIN`, `opencode/deepseek-v4-flash-free:max`, when no config file and no flag is set.

Missing config file = silently uses the built-in defaults. A malformed config file (unparseable JSON or wrong shape) produces a fatal error naming the file path — kusabi does not silently fall back in that case.

The full resolved chain is stored on every job record (`job.modelChain`) for use by future fallback logic (issue #50).

### Chain round escalation

The round number is only the budget counter — it does **not** index into the
model chain. Model tier and session lifecycle are separate levers, decided by
`deriveReworkStrategy` (`docs/DESIGN.md` §3.5.5).

`models.chain` is a list of **tiers**. Each tier holds interchangeable routes of
the same quality, tried in order when one is unavailable — that is capacity
fallback, and it does not consume a round.

Default ladder, absent countervailing evidence:

| Rework | Tier | Session |
|---|---|---|
| 1st | same | continue |
| 2nd | +1 | new |
| 3rd+ | +1 | new |

So with a two-tier chain, rounds 1 and 2 both run on tier 0 and the second tier
is first reached at **round 3**.

**`--model` does not raise the chain.** It applies to round 1's implement phase
only — reworks return to the ladder — and to the review phase of *every* round,
which then stays on that model instead of tier 0. Passing a top-tier model is
therefore a decision to pay for every review in the chain, not a way to start
the implementer higher for the whole run.

If a chain entry carries a `:variant` suffix (e.g. `:max`), the `variant`
field is included in the `prompt_async` request for that round and stored
on the round record (`modelEntry` and `modelVariant` fields). The variant
is visible in `status` and `result` output for each round.

## Notes

- **Publish is outside the chain.** Writing "PUBLISH (mandatory)" into a brief
  does not execute anything: the worker's toolset has no publish (the network
  exit is orchestrator-exclusive by design). The orchestrator performs publish
  after acceptance, from the worker's reported change set. A chain whose brief
  demands publish prints a one-line warning to that effect at chain start —
  it is a reminder to the orchestrator, not an action the worker can take.
- Jobs, event logs, and results are stored per directory under `~/.kusabi/`.
- `opencode serve` is started on demand and healthy servers are reused; a chain stops its serve on completion unless `--keep-serve` is passed. Idle serves with no running jobs are reaped on the next companion invocation after `KUSABI_SERVE_TTL_MS` (default 30 min). `serve-stop` (`node plugins/kusabi/scripts/kusabi-companion.mjs serve-stop`) kills the serve and removes its state file; while jobs are running it declines and points at `chain-cancel` unless `--force` is passed — stopping the serve does not stop a chain, which spawns a new serve on its next dispatch.
- A chain holds the container it was given for its whole run. `status` names the chains that are running and the containers they hold; `chain-cancel <chainId>` is the way to stop one.
- The opencode HTTP API is mid-migration (v1 → v2); the companion targets the v1 surface present in opencode ≥ 1.17.
