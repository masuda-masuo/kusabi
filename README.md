# opencode-plugin-cc

Use [opencode](https://opencode.ai) from inside Claude Code — delegate tasks or run adversarial code reviews — without flooding Claude's context with opencode's intermediate output.

Modeled on [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (see [NOTICE](./NOTICE)), but built on opencode's HTTP server instead of a stdio broker.

## How it works

```
Claude Code ──/opencode:* slash command──> opencode-companion.mjs ──HTTP──> opencode serve (127.0.0.1, on-demand)
                                                │
                                                ├─ SSE /event: progress tracking + automatic permission replies
                                                ├─ state dir: full event log, job records, stored results
                                                └─ stdout: rendered final result ONLY
```

The companion script is a context firewall: opencode's narration, tool logs, and raw events are persisted under `~/.opencode-plugin-cc/<dir-hash>/` and never reach Claude. Claude only sees the rendered final result (or a compact status summary).

Key mechanics:

- **On-demand server** — `opencode serve` is started per project directory when first needed, bound to `127.0.0.1` with a random port and a generated `OPENCODE_SERVER_PASSWORD`. Healthy servers are reused; nothing needs to run 24/7.
- **Automatic permission replies** — permission asks from opencode are answered by policy over SSE (reviews: read-only tools allowed, everything else rejected; tasks: allowed except external-directory access; `--auto` approves everything). This avoids the headless "ask hangs forever" problem.
- **Structured review output** — reviews use opencode's `json_schema` output format with a strict findings schema, then render to readable markdown.

## Requirements

- [opencode CLI](https://opencode.ai) installed and authenticated (`opencode auth login`)
- Node.js 18.18 or later

## Install

```bash
/plugin marketplace add masuda-masuo/opencode-plugin-cc
/plugin install opencode@opencode-plugin-cc
```

Then run `/opencode:setup` to verify the CLI and server come up.

## Commands

| Command | What it does |
| --- | --- |
| `/opencode:task <text>` | Delegate a task. Flags: `--model provider/model`, `--agent name`, `--phase <name>`, `--read-only`, `--auto`, `--resume-last`, `--session <id>`, `--wait`, `--background` |
| `/opencode:review` | Adversarial, read-only review of the working tree; `--base <ref>` for branch review; extra text = review focus |
| `/opencode:status [job-id]` | Compact job list, or progress detail for one job |
| `/opencode:result [job-id]` | Stored final output of a finished job |
| `/opencode:cancel [job-id]` | Abort a running job |
| `/opencode:setup` | Check CLI, start/reuse the server |

The `opencode:opencode-worker` subagent forwards delegation requests to `task` so the main Claude thread never carries the work.

Every result includes the opencode session ID; continue the same session in the opencode TUI with `opencode -s <session-id>`.

## Notes

- Jobs, event logs, and results are stored per directory under `~/.opencode-plugin-cc/`.
- `opencode serve` keeps running between jobs; stop it with `node scripts/opencode-companion.mjs serve-stop` if needed.
- The opencode HTTP API is mid-migration (v1 → v2); the companion targets the v1 surface present in opencode ≥ 1.17.
