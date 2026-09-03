// chain-strategize.mjs — Strategize prompt assembly and dispatch (kusabi #455).
//
// Extracted from chain-phases.mjs (kusabi #455).
// Owns building the strategist prompt, dispatching the one strategist job,
// and writing strategist fields onto the round record.
//
// Does not import chain-phases.mjs, kusabi-companion.mjs, chain-driver.mjs,
// chain-finish.mjs, chain-cmd.mjs, chain-run.mjs, chain-review.mjs, or
// chain-resume-resolve.mjs.

import {
  reviewDenyTools,
} from "./cli.mjs";
import {
  renderStrategistPrompt,
} from "./render.mjs";
import { dispatchWithFallback } from "./prompt-execution.mjs";

/**
 * Run the strategize sub-phase: build prompt, dispatch strategist job,
 * and update the roundRecord with strategist findings.
 *
 * Uses dispatchWithFallback so capacity fallback applies to the strategist
 * dispatch as well.
 */
export async function runStrategizePhase({ cwd, chainId, round, brief, previousRecord, roundRecord, modelChain, _dispatchWithFallback: _dispatch = dispatchWithFallback } = {}) {
  // Build the strategist prompt from the brief's acceptance criteria and
  // the last two rounds' findings.
  const strategistRounds = [];
  if (previousRecord) {
    strategistRounds.push({ round: previousRecord.round, findingsText: previousRecord.findingsText || "" });
  }
  strategistRounds.push({ round, findingsText: roundRecord.findingsText || "" });

  const strategistPromptText = renderStrategistPrompt({
    brief,
    rounds: strategistRounds,
  });

  const { job: strategistJob, resultText: strategistResultText } = await _dispatch({
    cwd,
    kind: "strategist",
    title: "chain: " + chainId + " round " + round + " strategist",
    promptText: strategistPromptText,
    agent: "kusabi-investigate",
    tools: reviewDenyTools(),
    timeoutS: 1800,
    watchdogS: 900,
    tiers: modelChain,
    // Tier 1, not the round's tier: the strategist runs once per chain and is
    // not part of the quality ladder.  (Before fallback existed this dispatch
    // passed no model at all and took opencode's default.)
    round: 1,
  });

  roundRecord.strategistJobId = strategistJob.id;
  roundRecord.strategistUsage = strategistJob.usage || null;
  roundRecord.strategistModelEntry = strategistJob.modelEntry || null;
  roundRecord.strategistModelVariant = strategistJob.modelVariant || null;
  roundRecord.strategistFallbacks = strategistJob.fallbacks || null;
  roundRecord.strategistRecommendation = (strategistResultText || "").trim() || "(no recommendation)";

  return {
    strategistJobStatus: strategistJob.status,
    strategistJobError: strategistJob.error || null,
    // Structured terminal-failure classification (kusabi #215): null for
    // generic failures; { kind: "quota-exhaustion", ... } when the dispatch
    // classified the terminal payload (see implementJobFailure).
    strategistJobFailure: strategistJob.failure || null,
  };
}
