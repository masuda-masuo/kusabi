// Public rendering API. Keep existing imports stable while implementations
// live in modules grouped by the output they produce.

export {
  durationS,
  renderHeader,
  renderJobLine,
} from "./render-job.mjs";

export {
  extractJson,
  recoverVerdictFromText,
  renderReview,
} from "./render-review.mjs";

export {
  renderBaseFacts,
  renderContainerReviewInput,
  groupFindingsByKind,
  renderGroupedFindingsText,
  renderPriorFindings,
  renderEscalationDecisions,
  renderStrategistPrompt,
  renderFollowupDraft,
} from "./render-prompt.mjs";

export {
  roundDiscardReason,
  roundChangedColumn,
  resolveChainStatus,
  renderChainShow,
} from "./render-chain.mjs";

export {
  renderReviewRecord,
} from "./render-record.mjs";
