---
name: kusabi-result-handling
description: Internal discipline for handling kusabi worker (companion) output
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
- Even when a decision to fix is made, the default path is re-delegation to a worker (respond/implement phase). Direct fixing by the orchestrator is the exception, and the reason must be stated

## Prohibition of substituting for failure

- If the worker's job failed or was incomplete, do not substitute it with implementation on the orchestrator's side. Report it as a failure and stop
- The same applies to salvage results: the job is to report the analysis result, not to have the orchestrator implement the continuation
- If the companion returns a setup/authentication error, guide the user to run `kusabi-companion setup`. Do not improvise another authentication path

## Verification against reports (interface with the reviewer specification)

- A worker's completion report is a claim, not evidence. Before accepting it, verify against the diff and actual behavior (detailed specification is in adversarial-review.md / kusabi-review.md. Here, just remember: **verify first, then trust**)

## Escalation recovery

Before discarding work or re-dispatching after an escalation, perform a terminal-event check:

1. **Read the chain state.** Run `chain-show` on the escalated chain. Note the exact disposition reason it reports — this is the authoritative cause of the escalation. Inspect the underlying implement/review job status and result, including recovered or no-final results. Check for `reviewSeatFailures` entries — they indicate review seats that died and may have left useful progress behind.

2. **Inspect retained work.** Check the worktree diff (`git diff` or `git status --porcelain` against the chain base) and any checkpoint or progress artifacts. An escalated chain may retain valuable implementation progress even when review failed — this is expected and the work should not be discarded without evidence it is unsalvageable.

3. **For temporary container access failures** (transient network issues, provider errors), preserve the container and inspect `sandbox_list_containers` to assess its current state. Wait/retry the access operation once as appropriate. Use a non-destructive same-container restart only when the environment permits. For stopped or removed containers, inspect durable chain/job/checkpoint artifacts before declaring work lost.

4. **Never use `chain-resume` for an unreachable container.** Resume applies only after a terminal chain when the recorded container remains reachable.

5. **This is a terminal-event check, not a polling loop.** Inspect the state once and decide — do not repeatedly probe companion status or spin on container health. The check exists to prevent discarding useful progress, not to extend chain lifetime.
