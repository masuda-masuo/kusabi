---
description: Show running and recent opencode jobs for this directory
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(kusabi-companion:*)
---

Show opencode job status through the companion runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
kusabi-companion status "$ARGUMENTS"
```

If the shim is not installed (command not found), `node "${CLAUDE_PLUGIN_ROOT}/scripts/kusabi-companion.mjs" status ...` is equivalent.

Return the command stdout verbatim, exactly as-is. Do not add commentary, do not fetch results, do not cancel or start anything.
