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

Run `/kusabi:setup` or `kusabi-companion.mjs install-agents` to copy them to `OPENCODE_AGENT_DIR` (default `~/.config/opencode/agent/`). Legacy `oc-*` names are automatically cleaned up.

## Commands

| Command | What it does |
| --- | --- |
| `/kusabi:task [--brief-file <path>]` | Delegate a task. Provide the brief inline or via `--brief-file <path>` (mutually exclusive). Flags: `--model provider/model`, `--agent name`, `--phase <name>`, `--read-only`, `--resume-last`, `--session <id>`, `--wait`, `--background`, `--deny <tools>`, `--timeout <s>`, `--watchdog <s>` |
| `/kusabi:review` | Adversarial, read-only review of the working tree; `--base <ref>` for branch review; `--prior <text>` for anti-ratchet carry-over; extra text = review focus |
| `/kusabi:chain [--brief-file <path>]` | **Auto chain** — run implement → review → rework until acceptance or escalate. Requires `--container <cid>`. Optional: `--model <provider/model>`, `--brief-file <path>`, `--max-rounds <N>` (default 3), `--session`. When `--model` is omitted the model is resolved from the config file or built-in default chain. |
| `/kusabi:status [job-id]` | Compact job list, or progress detail for one job |
| `/kusabi:result [job-id]` | Stored final output of a finished job |
| `/kusabi:cancel [job-id]` | Abort a running job |
| `/kusabi:salvage <job-id>` | Recover a dead/stalled job: reads its prompt + events, launches a salvage agent to produce a structured report |
| `/kusabi:setup` | Check CLI, start/reuse the server, install phase agents |

The `kusabi:opencode-worker` subagent forwards delegation requests to `task` so the main Claude thread never carries the work.

## Skills

| Skill | What it is for |
| --- | --- |
| `delegate` | The orchestrator-side discipline: what belongs in a brief, how to inspect what comes back, what never leaves the orchestrator. Load it before starting an implementation task. |
| `kusabi-result-handling` | Internal rule for relaying worker output faithfully (not user-invocable). |

The `delegate` skill intentionally points at `--help` and `docs/DESIGN.md` for the CLI
surface and the chain semantics instead of restating them, so that improving kusabi does
not silently make the skill wrong.

Every result includes the opencode session ID; continue the same session in the opencode TUI with `opencode -s <session-id>`.

## Model configuration

By default, kusabi resolves the model to use through an ordered chain:
`opencode/deepseek-v4-flash-free` → `opencode-go/deepseek-v4-flash` → `opencode-go/deepseek-v4-pro`.
The first entry in the chain is used unless overridden.

You can customise this with a config file at `<state root>/config.json`
(typically `~/.kusabi/config.json`, or the directory pointed to by
`KUSABI_STATE_DIR` or `OPENCODE_COMPANION_STATE_DIR`).

```json
{
  "models": {
    "chain": ["opencode/deepseek-v4-flash-free", "opencode-go/deepseek-v4-flash:max", "opencode-go/deepseek-v4-pro"],
    "phases": { "implement": ["opencode-go/deepseek-v4-flash"] }
  }
}
```

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

### Resolution precedence (highest to lowest)

1. **Explicit `--model` flag** — always wins when provided.
2. **Per-phase chain** — `models.phases.<phase>` first entry (e.g. a config with `"implement": ["m1"]` resolves to `m1` for implement-phase tasks).
3. **Global chain** — `models.chain` first entry, or the built-in default chain when no config file exists.
4. **Built-in default** — `opencode/deepseek-v4-flash-free` when no config file and no flag is set.

Missing config file = silently uses the built-in defaults. A malformed config file (unparseable JSON or wrong shape) produces a fatal error naming the file path — kusabi does not silently fall back in that case.

The full resolved chain is stored on every job record (`job.modelChain`) for use by future fallback logic (issue #50).

### Chain round escalation

When the `chain` subcommand reworks after a needs-attention review, each
subsequent implement round escalates by moving down the model chain:

| Round | Entry selected |
|---|---|
| 1 | `--model` flag (if provided), otherwise chain[0] |
| 2 | chain[1] (or last entry if chain has only 1 element) |
| 3 | chain[2] (or last entry if shorter) |
| N | chain[N-1], clamped to the last entry |

Rounds beyond the end of the chain keep using the last entry.

The review phase always uses the same model as round 1 (the model resolved
from `--model` or the first chain entry); escalation applies only to the
implementer role.

If a chain entry carries a `:variant` suffix (e.g. `:max`), the `variant`
field is included in the `prompt_async` request for that round and stored
on the round record (`modelEntry` and `modelVariant` fields). The variant
is visible in `status` and `result` output for each round.

## Notes

- Jobs, event logs, and results are stored per directory under `~/.kusabi/`.
- `opencode serve` keeps running between jobs; stop it with `node plugins/kusabi/scripts/kusabi-companion.mjs serve-stop` if needed.
- The opencode HTTP API is mid-migration (v1 → v2); the companion targets the v1 surface present in opencode ≥ 1.17.
