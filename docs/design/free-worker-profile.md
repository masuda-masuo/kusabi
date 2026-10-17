# Agenda2001: Opt-in OpenCode Free Worker Profile

This document specifies the design, operation, and verification of the opt-in OpenCode free worker profile (`Agenda2001`) in Kusabi.

## 1. Purpose and Overview

The free worker profile enables opt-in evaluation and execution of free model tiers (`opencode/deepseek-v4.1-flash-free` with GLM reserve) using OpenCode V1 runtime.
It is completely isolated from production default routing and does not automatically alter repository defaults or configuration files (`~/.kusabi/config.json`). Default templates and execution paths remain safe and unchanged.

## 2. Activation and Model Resolution Precedence

### 2.1 Opt-In Activation
The profile is strictly opt-in via environment variable:
```bash
export KUSABI_OPENCODE_FREE_WORKER=1
```
Absent, empty, `0`, or `false` preserves previous behavior byte-for-byte.

### 2.2 Candidate Chain Defaults
When opt-in is active and no operator selection is provided, the candidate chain fallback is:
1. `opencode/deepseek-v4.1-flash-free` (primary candidate)
2. `opencode/glm-5.3-flash-free` (reserve)

Paid routes (such as `opencode-go/*`) are excluded from this candidate chain.

### 2.3 Precedence Rules
Configured routes and explicit flags always outrank profile defaults:
1. **Explicit CLI flag (`--model <provider/model>`)**: Outranks all configuration and defaults.
2. **Phase override (`config.models.phases.<phase>`)**: Outranks global chain and profile defaults.
3. **Configured chain (`config.models.chain`)**: Outranks profile defaults.
4. **Profile fallback**: Only used when no explicit flag or configuration exists.

OpenCode settings are never applied to Claude, Antigravity (AGY), or Codex dispatches.

## 3. Isolated State and XDG Directory Layout

To ensure complete isolation from operator default environments, configure dedicated state and config directories:

```bash
export KUSABI_STATE_DIR="/tmp/kusabi-free-worker/state"
export KUSABI_OPENCODE_CONFIG_HOME="/tmp/kusabi-free-worker/config"
```

- `KUSABI_STATE_DIR`: Isolates job stores (`jobs/`), events (`events.ndjson`), and server records (`server.json`).
- `KUSABI_OPENCODE_CONFIG_HOME`: Sets `XDG_CONFIG_HOME` for spawned OpenCode serve processes, ensuring agent definitions and server discovery remain isolated.

## 4. OpenCode Runtime & Version Enforcement

### 4.1 Version Requirements
- **Supported**: Stable OpenCode V1 >= `1.19.3`.
- **Unsupported (Rejected)**:
  - OpenCode V2: Actively detected and rejected with an actionable downgrade error prior to starting worker processes.
  - OpenCode V1 < `1.19.3`: Rejected with actionable upgrade instructions.
  - Unparseable, missing, or failing version executions: Rejected before worker start.

Version verification is executed via bounded execution (`--version`) with a strict timeout before any serve process is spawned. The version guard applies only to OpenCode backends.

### 4.2 Pure Serve Spawn
When opt-in is active, `ensureServer` spawns `opencode serve` with the `--pure` flag:
```bash
opencode serve --port <port> --pure
```

### 4.3 Server Profile Separation & Reuse Guard
When a serve process is started, metadata is stamped into `server.json`:
- `profile`: `"free"` (opt-in) or `"default"` (opt-out).
- `pure`: `true` (opt-in) or `false` (opt-out).

When reusing an existing server:
- Opt-in mode (`KUSABI_OPENCODE_FREE_WORKER=1`) rejects existing default servers.
- Opt-out mode rejects existing opt-in servers (`--pure`).
- Incompatible servers are rejected with actionable restart instructions (`kusabi serve-stop`) rather than terminating active jobs unexpectedly.
- **Server Record Isolation Caveat**: Legacy or mock server records lacking mode metadata are accepted to preserve test fixture compatibility. However, unknown records cannot prove isolation against legacy server state. Operators must run against a fresh isolated state directory (`KUSABI_STATE_DIR`) and config home (`KUSABI_OPENCODE_CONFIG_HOME`) to ensure strict process and configuration isolation.

## 5. Phase Agent Installation & Host-Read Acceptance

### 5.1 Repository Templates Immutability
Phase agent templates under `plugins/kusabi/opencode-agents/*.md` remain default-safe and immutable. They enforce `*: deny` with no host tools enabled.

### 5.2 Agent Installation Command
The authoritative CLI subcommand is `install-agents` (the plan proposal `host install-agents` was incorrect):
```bash
# In opt-in environment:
KUSABI_OPENCODE_FREE_WORKER=1 node plugins/kusabi/scripts/kusabi-companion.mjs install-agents
```
Or via CLI wrapper:
```bash
KUSABI_OPENCODE_FREE_WORKER=1 kusabi install-agents
```

### 5.3 Transformed Permission Allowlist
When installed with `KUSABI_OPENCODE_FREE_WORKER=1`:
1. `"*": deny` is preserved as the first permission rule.
2. `read: ask` is inserted immediately after `*: deny`.
3. `bash: deny` is inserted immediately after `read: ask`.
4. **Synthetic Tool Permission (`StructuredOutput: allow`)**:
   - In OpenCode v1.19.3+, requesting structured output (`format: { type: "json_schema", ... }`) causes OpenCode (`packages/opencode/src/session/prompt.ts`) to inject the synthetic tool `tools.StructuredOutput`.
   - Tool visibility evaluation (`session/llm/request.ts` `resolveTools`) computes `Permission.disabled(tools, agent.permission)`. Under a wildcard `*: deny`, any tool not explicitly permitted is disabled.
   - For the opt-in installed review agent (`kusabi-review.md`) only, `StructuredOutput: allow` is explicitly added after `*: deny` so the synthetic tool is visible to the model.
   - Non-review agents (`kusabi-implement`, `kusabi-gofer`, etc.) do not invoke structured output contracts and remain without `StructuredOutput: allow`.
5. All existing permissions for `sunaba_*`, `shiori_*`, and `kaiba_*` are preserved verbatim.
6. Forbidden host tools (`write`, `edit`, `patch`, `terminal`, `command`, `browser`) remain strictly denied; wildcard is never escalated.

### 5.4 Host Read Acceptance
Host read access is accepted through the ask auto-approval mechanism in this profile. All host modifications (write, edit, patch, bash) remain strictly denied.

## 6. Structured Review Output Specification

### 6.1 Review Schema Format vs Default JSONL
- **Default Mode (JSONL streaming)**: Standard review workers stream adversarial reviews line-by-line as JSONL records (one `finding` record per finding, then `unverified`/`next_step` records, with a `verdict` record emitted last). Workers are instructed to stream records immediately rather than buffering a single large object.
- **Opt-in Free Worker Profile (Single Final Structured Schema)**: OpenCode review requests attach a JSON Schema format definition to `prompt_async`:
```json
{
  "format": {
    "type": "json_schema",
    "schema": <review-output.schema.json>
  }
}
```
- Schema source: authoritatively loaded from `plugins/kusabi/schemas/review-output.schema.json`.
- Scope: Only review phases (`kind: "review"` or `phase: "review"`) receive the format schema. Implementation and gofer requests do not receive format schemas.
- **Review Prompt Adaptation**: For the opt-in profile, `transformAgentForOptIn` rewrites `kusabi-review.md` to remove the conflicting JSONL streaming mandates (including prohibitions on emitting a single final object) and description. It instructs the worker to invoke `StructuredOutput` once at the end using the canonical review schema, aggregating all `findings`, `unverified` items, and `next_steps` consistently into the final structured response. All substantive review and verification restrictions (read-only container rules, corroborating claims with sunaba tools, gate verification, test honesty auditing) are strictly preserved.

### 6.2 Structured Output Extraction, Validation & Empirical Evidence
- Result extraction prefers `info.structured` from the last assistant message and serializes it to JSON for the review parser path (`parseReviewResult`).
- If `info.structured` is absent, text fallback from message parts is preserved.
- Schema compliance is validated via `validateReview`: invalid structured data produces schema errors and unparseable verdicts; errors are never masked with synthetic approvals.
- Technical note: Measured capability corresponds to runtime `StructuredOutput` / JSON Schema via OpenCode API; no native strict grammar decoding claims are made.
- **Empirical Evidence & Runtime Caveat**:
  - *Evidence*: Actual companion review execution (`job-mvc9q49v2031`) previously timed out because effective permissions lacked a `StructuredOutput` exception under `*: deny`, causing looping MCP tool calls. Orchestrator verified root cause and conducted a direct HTTP control with the installed `kusabi-review` agent, full schema, free DS low, and `tools: { StructuredOutput: true }`. The response returned in 3.02s with valid structured output (`verdict: approve`, `schema_version: 1`, cost: 0), proving that granting `StructuredOutput: allow` resolves the runtime blockage.
  - *Caveat*: Testing the repair requires re-copying candidate code, reinstalling isolated agents, restarting isolated serve, and running companion review once in an isolated environment (orchestrator-owned verification).

### 6.3 V1 Final-Message GET 400 Transport Limitation & Authoritative Structured SSE Recovery

During candidate companion review execution (`job-mvcax98n47c4`), the job completed in 6s (cost 0) with `StructuredOutput` completed, `metadata.valid: true`, and the correct full review object emitted. However, subsequent `GET /session/{sessionID}/message` returned `400 BadRequest: Expected OutputFormatJsonSchema`.

- **Observed V1 Transport Failure**:
  In OpenCode V1 runtime, requesting structured output format (`format: { type: "json_schema", ... }`) causes `GET /session/{id}/message` to consistently fail with HTTP 400 upon completion. Direct POST tests confirm that adding explicit retries (e.g. `retryCount: 2`) does not resolve the 400 failure. Schema weakening or omission is prohibited by review contract invariants.
- **Authoritative Same-Job SSE Event Stream**:
  While the final message GET endpoint fails, the OpenCode V1 SSE stream authoritatively records the structured review in `message.updated` with `info.structured = { schema_version: 1, verdict, summary, findings, next_steps }` before `session.idle`. The same-job recorded `events.ndjson` is the authoritative source of truth.
- **Reliable Structured SSE Recovery & Invariants**:
  When final assistant GET fails (or produces no final assistant message) during a review run, Kusabi recovers the structured review directly from the recorded SSE events:
  1. *Session Matching*: Strict session isolation ensures events from other sessions or jobs are never crossed (`mismatched session excluded`).
  2. *Assistant Order*: Evaluates the latest relevant assistant by message ID and chronological update order.
  3. *Error & State Invariants*: Preserves the latest assistant state. An earlier structured assistant superseded by a newer errored assistant cannot approve.
  4. *Canonical Schema Validation*: Validates the recovered payload against `review-output.schema.json` via canonical `validateReview`. Arbitrary tool inputs or reasoning text are never accepted as structured review output.
  5. *Parser Serialization*: Valid structured SSE reviews serialize to standard JSON (`resultText`), seamlessly consumed by `parseReviewResult`.
  6. *Provenance Tracking*: Records `source: "recovered"`, `recovered: true`, and preserves the GET error (`fetchFailed: true`, `fetchError`) in `job.result` metadata and emits `companion.result.recovered`, documenting it as authoritative event recovery rather than successful GET.
  7. *Fail-Safe Reject*: If invalid, missing, or the latest assistant errored, recovery fails safe: `recovered: false` without claiming successful schema output, producing an empty result text that prevents silent approvals. Default non-review recovery behavior is completely preserved.
  8. *No Claims of Native Strict Decoding*: Operates as companion event recovery over recorded SSE events; no native strict grammar decoding claims are made.

## 7. Rollback & Default Handling

To safely revert to default operation:

1. **Unset Opt-In Variable**:
   ```bash
   unset KUSABI_OPENCODE_FREE_WORKER
   # or export KUSABI_OPENCODE_FREE_WORKER=0
   ```

2. **Stop Running Free Server**:
   ```bash
   node plugins/kusabi/scripts/kusabi-companion.mjs serve-stop
   # or kusabi serve-stop
   ```

3. **Reinstall Default Phase Agents**:
   ```bash
   node plugins/kusabi/scripts/kusabi-companion.mjs install-agents
   # or kusabi install-agents
   ```
   Running `install-agents` without opt-in restores default-safe agent definitions from repository templates, removing `read: ask`.

4. **Clean Isolated State (Optional)**:
   ```bash
   rm -rf /tmp/kusabi-free-worker
   ```

## 8. Source-Based Companion E2E & Canary Audit Extraction

### 8.1 Execution Commands
All commands use real CLI entry points from source:

```bash
# 1. Setup isolated environment
export KUSABI_OPENCODE_FREE_WORKER=1
export KUSABI_STATE_DIR="/tmp/kusabi-free-worker/state"
export KUSABI_OPENCODE_CONFIG_HOME="/tmp/kusabi-free-worker/config"

# 2. Install opt-in agents into isolated config
node plugins/kusabi/scripts/kusabi-companion.mjs install-agents

# 3. Launch phase chain in container
node plugins/kusabi/scripts/kusabi-companion.mjs chain \
  --brief-file path/to/brief.md \
  --container <container_id>

# 4. Check job status and inspect results
node plugins/kusabi/scripts/kusabi-companion.mjs status <job_id>
node plugins/kusabi/scripts/kusabi-companion.mjs result <job_id>
```

### 8.2 Safe Canary Audit Extraction
Canary audit extraction operates as E2E evidence extraction from existing runtime logs, not a new audit product:
- SSE events are streamed and persisted to `$KUSABI_STATE_DIR/<cwd-hash>/jobs/<job_id>/events.ndjson`.
- **Read Path Audit Extraction**: `companion.permission` events indicate permission status (`permission: unknown`), but do not provide the accessed file path. To audit the actual file paths read during execution, extract tool call arguments (`state.input.filePath`) from the session export (`GET /session/{id}/export`) or inspect `message.part.updated` tool call parts in session events.
- Final structured results are stored at `$KUSABI_STATE_DIR/<hash>/jobs/<job_id>/result.md` and recorded in `job.json`.
