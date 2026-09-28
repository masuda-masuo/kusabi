// tool-permissions.mjs — cross-backend tool permission tables for kusabi job dispatch.
//
// Split out of claude-dispatch.mjs (pure move, no behaviour change): the
// hardcoded agent allowlists, the opencode→claude deny translation, the
// sunaba profile mapping, and the belt-and-braces DISALLOWED_TOOLS list that
// must never run in a worker session.  Shared by the claude, codex, agy and
// cursor backends, so the dependency graph stops routing every backend
// through the claude adapter.  Pure: no imports, no I/O.

// =========================================================================
// permissions — hardcoded allowlists + disallowed tools (v1)
// =========================================================================

// Tool naming: Claude Code addresses MCP tools as `mcp__<server>__<tool>`
// (e.g. `mcp__sunaba__sandbox_attach`), verified against the real CLI
// (kusabi #184 followup).  The opencode naming (`sunaba_sandbox_attach`,
// `shiori_search`) matches NOTHING in a claude session, so every name and
// pattern in these lists — and in every flag built below — uses claude
// naming (I6).

// Allowlists mirroring the opencode agent permission tables at authoring
// time, in claude naming:
//   - implement: plugins/kusabi/opencode-agents/kusabi-implement.md
//     (every `allow` entry except the skill grant, which maps to claude's
//     `Skill` tool for the `kusabi-*` skills; the table grants no shiori).
//   - review:    plugins/kusabi/opencode-agents/kusabi-review.md
//     (the `shiori*` glob is granted IN FULL as `mcp__shiori__*` — the
//     round-2 3-tool expansion was a narrowing and is replaced by the glob,
//     which is valid in claude permission rules, I4).
//   - kaiba (all three agents, kusabi #279): the shared conclusion store,
//     granted READ-ONLY — `recall` only, never `remember`.  Write
//     permission follows the inspection hierarchy: every agent dispatched
//     here has its output inspected, so it reads the store, and the
//     inspecting side (the orchestrator) is the only writer.  A worker that
//     discovers a durable fact reports it and the orchestrator decides
//     whether to file it.  Granted directly, this mirrors no opencode
//     table; the server only enters the generated config when the host
//     config carries `mcpServers.kaiba`, so the entry is inert on a machine
//     that has not configured it.
// Passed to `claude -p` via --allowedTools.  NEVER
// --dangerously-skip-permissions.
const IMPLEMENT_ALLOWED_TOOLS = [
  "mcp__sunaba__read_file_range",
  "mcp__sunaba__search_in_container",
  "mcp__sunaba__list_files",
  "mcp__sunaba__diff_in_container",
  "mcp__sunaba__issue_view",
  "mcp__sunaba__write_file",
  "mcp__sunaba__edit_file",
  "mcp__sunaba__transform_file",
  "mcp__sunaba__undo_file_edit",
  "mcp__sunaba__checkpoint",
  "mcp__sunaba__checkpoint_restore",
  "mcp__sunaba__checkpoint_list",
  "mcp__sunaba__package_install",
  "mcp__sunaba__sandbox_exec",
  "mcp__sunaba__sandbox_exec_background",
  "mcp__sunaba__sandbox_exec_check",
  "mcp__sunaba__run_python",
  "mcp__sunaba__verify_in_container",
  "mcp__sunaba__lint_in_container",
  "mcp__sunaba__type_check_in_container",
  // kaiba (kusabi #279, #391): the shared conclusion store: recall +
  // progress; remember never.  The implementer reads conclusions, records
  // in-flight progress notes, and reports durable facts in its final
  // report for the orchestrator to file.  agenda only LISTS the shared
  // queue (editing it is the orchestrator's).  The tool definitions ride in
  // every turn's context regardless — --allowedTools is a runtime guard,
  // not a context filter — and that cost is accepted deliberately.
  "mcp__kaiba__recall",
  "mcp__kaiba__agenda",
  "mcp__kaiba__progress",
  "Skill", // mirrors `skill: kusabi-*: allow` in kusabi-implement.md
];

const REVIEW_ALLOWED_TOOLS = [
  "mcp__sunaba__read_file_range",
  "mcp__sunaba__search_in_container",
  "mcp__sunaba__list_files",
  "mcp__sunaba__diff_in_container",
  "mcp__sunaba__issue_view",
  "mcp__shiori__*", // the FULL `shiori*` glob of kusabi-review.md (I4)
  "mcp__sunaba__verify_in_container",
  "mcp__sunaba__lint_in_container",
  "mcp__sunaba__type_check_in_container",
  "mcp__sunaba__sandbox_exec",
  // kaiba (kusabi #279, #391): the shared conclusion store: recall +
  // progress; remember never.  The reviewer is an inspected phase too:
  // it reads conclusions, records in-flight progress notes, and durable
  // facts go in the review output for the orchestrator to file.  agenda
  // only LISTS the shared queue.
  "mcp__kaiba__recall",
  "mcp__kaiba__agenda",
  "mcp__kaiba__progress",
];

// kusabi-investigate.md grants issue write: the standalone investigate
// deliverable is appending the brief to the target issue.  The chain
// strategist dispatches with the same agent but passes reviewDenyTools(),
// which denies sunaba_sandbox_issue_write — normalized to the claude name
// and removed from this list by applyToolDenies, so the strategist keeps
// the review-shaped toolset while a standalone `task --phase investigate`
// can write the issue (kusabi #184 finding 3).
const INVESTIGATE_ALLOWED_TOOLS = [
  ...REVIEW_ALLOWED_TOOLS,
  "mcp__sunaba__sandbox_issue_write",
];

// kusabi-plan.md is read-only planning and shiori-✕ (see the §3.1 row in
// docs/design/phase-chain.md, the body paragraph, kusabi-plan.md, and the
// code comment below).  It shares the review-shaped read/verify toolset but
// must NOT carry the `mcp__shiori__*` grant that REVIEW_ALLOWED_TOOLS has
// (kusabi #409).  Derive it from the review list by filtering the shiori
// entry out, so future review-list edits stay inherited (kusabi mtdnies34569
// round-1 finding).
const PLAN_ALLOWED_TOOLS = REVIEW_ALLOWED_TOOLS.filter(
  t => !t.startsWith("mcp__shiori__")
);

// kusabi-test-author.md writes test files but does NOT grant run_python;
// agent-permissions.test.mjs enforces run_python as exclusive to
// implement/respond/gofer.  Derive the test-author list from the implement
// list by filtering run_python out, so future implement-list edits stay
// inherited (kusabi mtdnies34569 round-1 finding).
const TEST_AUTHOR_ALLOWED_TOOLS = IMPLEMENT_ALLOWED_TOOLS.filter(
  t => t !== "mcp__sunaba__run_python"
);

export const ALLOWED_TOOLS = {
  implement: IMPLEMENT_ALLOWED_TOOLS.join(","),
  review: REVIEW_ALLOWED_TOOLS.join(","),
  investigate: INVESTIGATE_ALLOWED_TOOLS.join(","),
  plan: PLAN_ALLOWED_TOOLS.join(","),
  testAuthor: TEST_AUTHOR_ALLOWED_TOOLS.join(","),
};

/**
 * Resolve the allowed-tools CSV for an agent name.
 *
 * v1 hardcodes three allowlists (implement, review, investigate), each
 * mirroring the corresponding opencode agent permission table.  `kusabi-review`
 * and `kusabi-investigate` are distinct lists: the strategist phase
 * dispatches with the investigate agent but a review-shaped DENY map
 * (reviewDenyTools — issue writes denied), so its effective toolset is the
 * review one; a standalone `task --phase investigate` passes no deny map and
 * keeps the issue-write grant.  A bare `task` (no agent) gets the implement
 * list — the worker toolset, matching the opencode default agent's full tool
 * access.
 *
 * @param {string|null|undefined} agent
 * @returns {string} CSV of allowed tool names.
 * @throws {Error} For agents with no v1 allowlist.
 */
export function allowedToolsForAgent(agent) {
  if (agent === "kusabi-implement" || agent === undefined || agent === null) {
    return ALLOWED_TOOLS.implement;
  }
  if (agent === "kusabi-review") {
    return ALLOWED_TOOLS.review;
  }
  if (agent === "kusabi-investigate") {
    return ALLOWED_TOOLS.investigate;
  }
  if (agent === "kusabi-test-author") {
    // test-author writes test files (same deliverable shape as implement), so
    // it gets the implement family's edit/read/verify toolset.  It must never
    // run code, so `mcp__sunaba__run_python` is filtered out of the implement
    // list (kusabi #408, mtdnies34569 round-1 finding).  It must never post to
    // issues or publish, so the filtered implement allowlist is the exact right
    // set (kusabi #408).
    return ALLOWED_TOOLS.testAuthor;
  }
  if (agent === "kusabi-plan") {
    // plan is read-only planning: the review-shaped toolset (no edits, no issue
    // write) is the right set.  But plan is shiori-✕ everywhere else, so the
    // `mcp__shiori__*` grant is filtered out of the review list (kusabi #409,
    // mtdnies34569 round-1 finding).
    return ALLOWED_TOOLS.plan;
  }
  throw new Error(
    `claude backend: no permission allowlist for agent "${agent}" ` +
    "(v1 hardcodes the implement, review, investigate, test-author, and plan allowlists only)"
  );
}

/**
 * Resolve the sunaba MCP `?profile=` for an agent name.
 *
 * sunaba serves a filtered `tools/list` when the MCP URL carries a known
 * `profile` parameter (sunaba #782).  On the claude backend that filtering
 * is the only thing that keeps unused tool definitions OUT of the session
 * context: `--allowedTools` is a runtime guard, it does not remove tool
 * definitions the way opencode's permission deny does (kusabi #274).  A
 * null profile means the unfiltered list — always correct, merely larger,
 * so it is the safe default for anything not mapped here.
 *
 * `kusabi-investigate` gets NO profile deliberately: its allowlist spans
 * the review-shaped read tools PLUS `sandbox_issue_write`, which no single
 * sunaba profile covers — the full list is the correct cover (kusabi #274
 * acceptance 4).
 *
 * @param {string|null|undefined} agent
 * @returns {string|null} Profile name, or null for the unfiltered list.
 */
export function sunabaProfileForAgent(agent) {
  if (agent === "kusabi-implement" || agent === undefined || agent === null) {
    return "implement"; // the bare-task default is the worker toolset
  }
  if (agent === "kusabi-review") {
    return "review";
  }
  return null;
}

// The claude/sunaba equivalents of the opencode tool names in
// WRITE_TOOL_NAMES (cli.mjs).  The user-facing deny map built by cmdTask
// (--read-only, --deny) speaks the opencode vocabulary; on the claude
// backend the tools that actually exist are the `mcp__sunaba__*` ones, so
// the deny must be translated before applyToolDenies can remove them from
// the allowlist — otherwise --read-only / --deny bash silently no-op while
// the write tools stay granted (kusabi #184 finding 2).
//
// Phase-level deny maps (implementDenyTools / reviewDenyTools) are NOT
// translated: their opencode-vocabulary names (bash, write, ...) are
// intentional no-ops there (the allowlist is the permission mechanism — the
// agent tables already deny the opencode builtin tools via `"*": deny`),
// and their real tool names (sunaba_copy_project, sunaba_copy_file,
// sunaba_sandbox_issue_write, ...) are normalized to mcp__sunaba__* and
// removed by exact match inside applyToolDenies.
export const OPCODE_DENY_TO_CLAUDE = {
  bash: ["mcp__sunaba__sandbox_exec"],
  write: ["mcp__sunaba__write_file"],
  edit: ["mcp__sunaba__edit_file"],
  patch: ["mcp__sunaba__transform_file"],
  task: [], // no claude/sunaba equivalent — nothing to remove
};

/**
 * Translate a user-facing deny map from the opencode vocabulary into the
 * claude/sunaba tool names that exist in the allowlists.  Names that are
 * not in the opencode vocabulary (e.g. `mcp__sunaba__write_file` passed
 * straight to --deny) are kept verbatim.
 *
 * @param {object|null|undefined} tools
 * @returns {object|null|undefined} The translated deny map.
 */
export function translateDenyTools(tools) {
  if (!tools || typeof tools !== "object") return tools;
  const out = {};
  for (const [name, value] of Object.entries(tools)) {
    const mapped = OPCODE_DENY_TO_CLAUDE[name];
    if (mapped === undefined) {
      out[name] = value;
    } else {
      for (const target of mapped) out[target] = value;
    }
  }
  return out;
}

/**
 * Normalize a deny-map tool name to the claude naming used in the
 * allowlists: a bare `sunaba_*` name (the phase-level deny maps' real tool
 * names, e.g. `sunaba_sandbox_issue_write`) becomes `mcp__sunaba__*`.
 * Names already in claude naming pass through unchanged.
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeDenyName(name) {
  return name.startsWith("sunaba_") ? `mcp__sunaba__${name.slice("sunaba_".length)}` : name;
}

/**
 * Apply a deny map ({ name: false, ... }) to an allowlist CSV: entries the
 * caller explicitly denies are removed so a deny is never silently ignored
 * on the claude backend.  Removal is by exact match AFTER normalizing bare
 * sunaba_* names to mcp__sunaba__* (phase-level deny maps' real tool names
 * come through verbatim and must still match the claude allowlist);
 * opencode-vocabulary names from user flags are translated by
 * translateDenyTools at the cmdTask level before this runs.
 *
 * @param {string} csv
 * @param {object|null|undefined} tools
 * @returns {string}
 */
export function applyToolDenies(csv, tools) {
  if (!tools || typeof tools !== "object") return csv;
  const denied = Object.entries(tools)
    .filter(([, v]) => v === false)
    .map(([k]) => normalizeDenyName(k));
  if (denied.length === 0) return csv;
  const kept = csv.split(",").filter((name) => !denied.includes(name));
  return kept.join(",");
}

// Belt-and-braces deny list (I1/I3): tools that must never run in a worker
// session even if an allowlist bug or a settings leak would grant them.
// `Bash`/`Edit`/`Write`/`NotebookEdit` are the CLI's own built-in tools — a
// kusabi worker acts exclusively through the sunaba MCP tools, so they are
// denied outright.  `mcp__sunaba__sandbox_issue_write` is the ONE exception:
// a standalone `task --phase investigate` (agent kusabi-investigate)
// delivers by appending the brief to the issue.  The chain strategist also
// dispatches with the investigate agent, but its review-shaped deny map
// still strips issue write from the allowlist — the exception cannot grant
// it there.
export const DISALLOWED_TOOLS = [
  "mcp__sunaba__publish",
  "mcp__sunaba__sandbox_issue_write",
  "mcp__sunaba__sandbox_pr_review_write",
  "mcp__sunaba__secret_scan_override",
  "mcp__sunaba__sandbox_stop",
  "mcp__sunaba__sandbox_initialize",
  "mcp__sunaba__copy_file",
  "mcp__sunaba__copy_project",
  "mcp__sunaba__run_container_and_exec",
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
];

/**
 * Resolve the `--disallowedTools` CSV for an agent.  The issue-write tool is
 * exempted for kusabi-investigate only (its deliverable is the issue write);
 * every other agent denies it.
 *
 * @param {string|null|undefined} agent
 * @returns {string}
 */
export function disallowedToolsForAgent(agent) {
  return DISALLOWED_TOOLS.filter(
    (t) => !(t === "mcp__sunaba__sandbox_issue_write" && agent === "kusabi-investigate"),
  ).join(",");
}
