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
- **Automatic permission replies** — permission asks from opencode are automatically answered with `"once"` over SSE. Unprivileged write tools (bash, edit, write, patch) are proactively blocked at the session level via `--deny` / `--read-only`; MCP tools are silently allowed by opencode. This avoids the headless "ask hangs forever" problem.
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

kusabi ships 6 agent definitions (`plugins/kusabi/opencode-agents/`) that are automatically installed by `setup`:

| Agent | Phase role | Permission profile |
|---|---|---|
| `kusabi-draft` | Draft — research + issue creation | read-only + shiori + issue_write |
| `kusabi-investigate` | investigate — deep dive, root cause | read-only + shiori + issue_write |
| `kusabi-implement` | implement — code + verify | code write + verify; publish / issue_write / sandbox lifecycle **deny** |
| `kusabi-review` | review — adversarial review | verify/lint/type_check **allow**, sandbox_exec/sandbox_write **deny** |
| `kusabi-respond` | respond — address review findings | code write; issue_write **deny** |
| `kusabi-salvage` | salvage — recover stalled / dead jobs | read-only + structured report |

Run `/kusabi:setup` or `kusabi-companion.mjs install-agents` to copy them to `OPENCODE_AGENT_DIR` (default `~/.config/opencode/agent/`). Legacy `oc-*` names are automatically cleaned up.

## Commands

| Command | What it does |
| --- | --- |
| `/kusabi:task <text>` | Delegate a task. Flags: `--model provider/model`, `--agent name`, `--phase <name>`, `--read-only`, `--resume-last`, `--session <id>`, `--wait`, `--background`, `--deny <tools>`, `--timeout <s>`, `--watchdog <s>` |
| `/kusabi:review` | Adversarial, read-only review of the working tree; `--base <ref>` for branch review; `--prior <text>` for anti-ratchet carry-over; extra text = review focus |
| `/kusabi:chain` | **Auto chain** — run implement → review → rework until acceptance or escalate. Requires `--container <cid> --model <m>`. Optional: `--max-rounds <N>` (default 3), `--session` |
| `/kusabi:status [job-id]` | Compact job list, or progress detail for one job |
| `/kusabi:result [job-id]` | Stored final output of a finished job |
| `/kusabi:cancel [job-id]` | Abort a running job |
| `/kusabi:salvage <job-id>` | Recover a dead/stalled job: reads its prompt + events, launches a salvage agent to produce a structured report |
| `/kusabi:setup` | Check CLI, start/reuse the server, install phase agents |

The `kusabi:opencode-worker` subagent forwards delegation requests to `task` so the main Claude thread never carries the work.

Every result includes the opencode session ID; continue the same session in the opencode TUI with `opencode -s <session-id>`.

## Notes

- Jobs, event logs, and results are stored per directory under `~/.kusabi/`.
- `opencode serve` keeps running between jobs; stop it with `node plugins/kusabi/scripts/kusabi-companion.mjs serve-stop` if needed.
- The opencode HTTP API is mid-migration (v1 → v2); the companion targets the v1 surface present in opencode ≥ 1.17.
