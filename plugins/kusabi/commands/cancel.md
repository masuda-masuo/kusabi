---
description: Cancel an active opencode job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(kusabi-companion:*)
---

Cancel an opencode job through the companion runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
kusabi-companion cancel "$ARGUMENTS"
```

If the shim is not installed (command not found), `node "${CLAUDE_PLUGIN_ROOT}/scripts/kusabi-companion.mjs" cancel ...` is equivalent.

Return the command stdout verbatim, exactly as-is.
