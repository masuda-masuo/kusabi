---
description: Run an adversarial opencode review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--model provider/model] [focus text]'
disable-model-invocation: true
allowed-tools: Read, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial, read-only opencode review through the companion runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only. The review runs with write tools disabled and a reject-by-default permission policy.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return the companion stdout verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, run in the foreground.
- If the raw arguments include `--background`, run in a Claude background task.
- Otherwise, estimate the review size first:
  - For working-tree review, check `git status --short --untracked-files=all` plus `git diff --shortstat` and `git diff --shortstat --cached`.
  - For base-branch review, check `git diff --shortstat <base>...HEAD`.
  - Only conclude there is nothing to review when the relevant diff and status are empty; when in doubt, run the review.
  - Recommend waiting only for clearly tiny reviews (roughly 1-2 files); recommend background in every other case.
- Then use `AskUserQuestion` exactly once with `Wait for results` and `Run in background`, putting the recommended option first with `(Recommended)` suffixed.

Argument handling:
- Preserve the user's arguments exactly; extra non-flag text is the review focus.
- Do not add extra review instructions or rewrite the user's intent.
- Review quality depends sharply on the focus text carrying the change's premise (linked issue, intent, known empirical facts). Measured 2026-07-17: the same diff reviewed without context produced a finding built on a false premise about the old code's intent; with the issue's premise in the focus text the reviewer instead verified the claim against upstream sources. This context must come from the caller — never invent it. If the arguments contain no focus text, you may append one line after the verbatim output: "Tip: reviews are more accurate when the focus text states the change's premise (issue link, intent, known facts)."

Foreground flow:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is. Do not paraphrase, summarize, or fix anything it reports.

Background flow:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/opencode-companion.mjs" review "$ARGUMENTS"`,
  description: "opencode review",
  run_in_background: true
})
```
- Do not poll or wait for completion in this turn.
- After launching, tell the user: "opencode review started in the background. Check `/opencode:status` for progress."
