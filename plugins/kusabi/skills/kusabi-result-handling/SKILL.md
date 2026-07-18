---
name: kusabi-result-handling
description: Internal discipline for handling kusabi worker (companion) output on the Claude Code side
user-invocable: false
---

## Faithful transfer of output

- The companion's stdout is the formatted final result. Preserve the verdict/summary/findings/next steps structure, and do not rewrite the wording in any way
- Use file paths and line numbers exactly as the worker reported them. Do not replace or supplement them
- If the worker distinguished between "facts" and "conjecture/uncertainty", preserve that boundary. Do not convey estimates as certainties
- Order findings by severity. If there are no findings, state "none" explicitly

## Model visualization (mandatory requirement of this plugin)

- Always leave the `model:` line from the companion header (the provider/model actually used) visible to the user. Do not omit or embed it in internal notes
- If a quota fallback was displayed, pass it through without omission (prevents silent breakdown of the cost structure)

## Post-processing of review results prohibited

- After presenting review findings, **stop there**. Which findings to fix is determined by the user (or the orchestrator's explicit judgment), not before. Automatic application is prohibited
- Even when a decision to fix is made, the default path is re-delegation to a worker (respond/implement phase). Direct fixing by Claude is the exception, and the reason must be stated

## Prohibition of substituting for failure

- If the worker's job failed or was incomplete, do not substitute it with implementation on the Claude side. Report it as a failure and stop
- The same applies to salvage results: the job is to report the analysis result, not to have Claude implement the continuation
- If the companion returns a setup/authentication error, guide the user to run `/kusabi:setup`. Do not improvise another authentication path

## Verification against reports (interface with the reviewer specification)

- A worker's completion report is a claim, not evidence. Before accepting it, verify against the diff and actual behavior (detailed specification is in adversarial-review.md / kusabi-review.md. Here, just remember: **verify first, then trust**)
