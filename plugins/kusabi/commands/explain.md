---
description: Explain the last Claude Code assistant passage using a cheap worker model
argument-hint: '<question>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Explain the last assistant passage from the Claude Code transcript.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kusabi-companion.mjs" explain "$ARGUMENTS"
```

Return the command stdout verbatim, exactly as-is. Do not add commentary, do not restate the passage, do not fetch results, do not cancel or start anything.
