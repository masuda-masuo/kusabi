---
description: Delegate a task to opencode through the local opencode server
argument-hint: '[--wait|--background] [--model provider/model] [--agent name] [--read-only] [--deny tool1,tool2] [--auto] [--resume-last|--session <id>] <task description>'
disable-model-invocation: true
allowed-tools: Read, Bash(node:*), Bash(git:*), AskUserQuestion
---

Delegate a task to opencode through the companion runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- Your only job is to run the companion command and return its stdout verbatim to the user.
- Do not investigate the task yourself, do not read the repository, do not summarize or fix anything.

Execution mode rules:
- If the raw arguments include `--wait`, run in the foreground.
- If the raw arguments include `--background`, run in a Claude background task.
- Otherwise: prefer foreground for a small, clearly bounded task; prefer background for anything open-ended, multi-step, or likely to run long. If genuinely unclear, use `AskUserQuestion` exactly once with `Wait for results` and `Run in background`, putting the recommended option first with `(Recommended)` suffixed.

Argument handling:
- Preserve the user's arguments exactly. Do not strip flags or rewrite the task text.
- The companion automatically prepends worker guardrails (`prompts/task-guardrails.md`: scope adherence, verification honesty, no credential hunting, no VCS exit, fixed report format) to every task prompt. The task text does not need to restate them — it should carry only task-specific content: precise scope, relevant premise/context, and acceptance criteria.
- `--auto` auto-approves opencode permission requests (dangerous); pass it through only when the user asked for it.
- `--deny name1,name2` disables the named opencode tools for this task via the session tools config. MCP tools do not go through opencode's permission asks, so this is the only effective way to block them (e.g. `--deny sunaba_publish` to keep the network exit with the orchestrator).

Foreground flow:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is. No commentary before or after.

Background flow:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" task "$ARGUMENTS"`,
  description: "opencode task",
  run_in_background: true
})
```
- Do not poll or wait for completion in this turn.
- After launching, tell the user: "opencode task started in the background. Check `/opencode:status` for progress."
