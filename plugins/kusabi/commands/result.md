---
description: Show the stored final output of a finished opencode job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(kusabi-companion:*)
---

Show a stored opencode job result through the companion runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
kusabi-companion result "$ARGUMENTS"
```

If the shim is not installed (command not found), `node "${CLAUDE_PLUGIN_ROOT}/scripts/kusabi-companion.mjs" result ...` is equivalent.

Return the command stdout verbatim, exactly as-is. Do not act on the result, fix issues it mentions, or add commentary.
