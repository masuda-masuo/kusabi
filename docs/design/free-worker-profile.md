# Agenda2001: Opt-in OpenCode Free Worker Profile

This document specifies the design, operation, and verification of the opt-in OpenCode free worker profile (`Agenda2001`) in Kusabi.

## 1. Purpose and Overview

The free worker profile enables opt-in evaluation and execution of free model tiers (`opencode/deepseek-v4.1-flash-free`, with GLM supported as an explicit manual alternative) using OpenCode V1 runtime.
It is completely isolated from production default routing and does not automatically alter repository defaults or configuration files (`~/.kusabi/config.json`). Default templates and execution paths remain safe and unchanged.

## 2. Activation and Model Resolution Precedence

### 2.1 Opt-In Activation
The profile is strictly opt-in via environment variable:
```bash
export KUSABI_OPENCODE_FREE_WORKER=1
```
Absent, empty, `0`, or `false` preserves previous behavior byte-for-byte.

### 2.2 Candidate Chain Defaults & Shared Quota
When opt-in is active and no operator selection is provided, the default candidate chain is:
1. `opencode/deepseek-v4.1-flash-free` (default candidate)

GLM (`opencode/glm-5.3-flash-free`) is intentionally **not** included as an automatic fallback candidate. DeepSeek and GLM share the same OpenCode free tier quota; when DeepSeek free quota is exhausted (failing with `free_tier_limit`), GLM is simultaneously exhausted, so automatic in-backend fallback to GLM provides no quota recovery. Instead, GLM remains a supported, recognized free model that operators can explicitly select (via `--model` or configuration) as a manual or model-specific alternative without triggering paid/non-free route warnings.

Cross-provider fallback (such as falling back from OpenCode DeepSeek to Antigravity/AGY upon quota exhaustion) belongs to operator configuration (such as `config.models.chain` or `--model`) and is not hardcoded into backend-specific defaults blindly. The cross-backend production route DS→AGY remains an operator configuration choice.

Paid routes (such as `opencode-go/*`) are excluded from this candidate chain.

### 2.3 Precedence Rules
Configured routes and explicit flags always outrank profile defaults. Operator precedence is preserved unchanged; the profile never overrides operator configuration. When opt-in is enabled and the selected OpenCode route lies outside recognized free models (`opencode/deepseek-v4.1-flash-free` or `opencode/glm-5.3-flash-free`), whether from config, a phase override, or an explicit flag, a warning is emitted once at the dispatch boundary. Explicit selection of GLM (`opencode/glm-5.3-flash-free`) is recognized as a free model and emits no warning. AGY/Claude/Codex routes never warn.
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

When reusing a healthy recorded server:
- Opt-in mode (`KUSABI_OPENCODE_FREE_WORKER=1`) requires an explicitly free/pure record. A default record AND an unidentified (legacy / mock) record both fail, because neither proves the serve is isolated.
- Opt-out mode rejects an opt-in free/pure server. A default record and a legacy unidentified record are accepted (the compatibility policy for pre-metadata installs).
- Incompatible servers are rejected with actionable restart instructions (`kusabi serve-stop`) rather than terminating active jobs unexpectedly. The refusal never signals the process: it throws and leaves the server running.

### 4.4 Installed-Agent Mode Isolation Guard
`install-agents` writes a durable mode marker (`.kusabi-install-profile.json`, `profile: "free"|"default"`) into the install destination. Before a serve can reuse or start, `ensureServer` checks the profile of the agents in the OpenCode discovery directory (`kusabiOpencodeConfigHome()/opencode/agent`):
- A mode mismatch fails with a reinstall instruction BEFORE any worker execution.
  - opt-in active + installed `default` or `unknown` agents → refused;
  - opt-out active + installed `free` agents → refused;
  - any mode + installed `unknown` (malformed/broadened/conflicting) agents → refused.
- The installed `kusabi-*.md` files are ALWAYS classified structurally, using the same permission-block extraction and allowlist validation as the transform. The durable marker records the intended mode but does not replace the content check: it must agree with the classification of the files on disk. A marker that disagrees with the content is reported `unknown` rather than trusted, so a durable marker can never conceal tampered, replaced or broadened content.
- Structural classification: any file carrying an opt-in addition (`read: allow`, `bash: deny`, `StructuredOutput: allow`, or legacy `read: ask`) under a valid wildcard-deny block marks the tree `free`; a valid wildcard-deny-only tree is `default`; a directory with no recognizable kusabi agents is `absent`; any malformed, broadened or unsupported permission block, an unreadable file, or a marker/content disagreement marks the tree `unknown`. A known free-installed tree is therefore never silently trusted as default, and a column-0 YAML comment or blank line can never truncate the permission block and make a broadened tree look default.
- `unknown` (foreign, malformed, broadened or conflicting content) is refused in BOTH modes: neither opt-in nor opt-out will dispatch against a tree whose permission content cannot be trusted. The refusal names the reinstall command.
- An `absent` tree is a no-op for the guard in BOTH modes: there is no installed permission policy that could contradict the active mode, so `assertInstalledAgentProfile` returns `"absent"` rather than refusing. This is the compatibility path for opt-out hosts that never installed kusabi agents. It is not a supported run target, though: opt-in dispatch needs the free-installed agents, so `install-agents` under `KUSABI_OPENCODE_FREE_WORKER=1` is mandatory before dispatching, and an absent tree fails at dispatch when no phase agent is found.
- `OPENCODE_AGENT_DIR` is a PLACEMENT override honoured by `install-agents` only; OpenCode does not read it. The guard checks the actual discovery root, never the placement override.
- The mode is not leaked through a shared active serve: the record's `profile`/`pure` fields are the durable process-level marker, and a mismatch is refused rather than inherited.

## 5. Phase Agent Installation & Host-Read Acceptance

### 5.1 Repository Templates Immutability
Phase agent templates under `plugins/kusabi/opencode-agents/*.md` remain default-safe and immutable. They enforce `*: deny` with no host tools enabled.

### 5.2 Agent Installation Preflight
Before any filesystem mutation, `install-agents` reads and (in opt-in mode) transforms every repository template. A transform failure (missing YAML frontmatter, no `permission:` block, or a permission block whose first entry is not `"*": deny`) aborts the install with a descriptive error and nothing written — no partially transformed agent directory. A durable `.kusabi-install-profile.json` marker records the installed mode.

The transform is fail-closed and it uses ONE strict parse + canonical semantic validation path shared with the installed-content classifier (`free-worker-yaml.mjs`, which both `classifyInstalledAgentContent` and `transformAgentForOptIn` consume). Agent frontmatter is parsed as strict YAML 1.2 by the maintained `yaml` package (vendored; see §9) rather than by a hand-written line/regex reader:

- The frontmatter must contain exactly one YAML document and its root must be a single mapping. `permission:` must be an ordered mapping; the first rule must be `"*": deny`.
- Duplicate mapping keys are refused everywhere in the document, including quoted spellings of the same key (`permission` vs `"permission"`) and duplicates inside the `permission:` map or a nested `skill:` map. A duplicated key is never resolved with last-wins semantics.
- YAML aliases, `<<` merge keys, non-core/custom tags (`TAG_RESOLVE_FAILED`), non-1.2 directives, tabs-as-indentation and any other parse error/warning are refused. Alias expansion is never performed; no custom tags or constructors are registered (no prototype pollution or lossy key coercion).
- A parse failure is NEVER downgraded to "no permission block": the transform fails with an actionable, source-position-annotated error and the classifier reports `unknown`, never `default`.
- Only the parsed frontmatter is inspected (never the agent body). Ordinary YAML comments (at any indentation), quoted keys/scalars and existing nested `skill:`/MCP mappings parse normally.
- Because the source text is preserved, the transform inserts the constrained rules by the parsed source range of the `*: deny` pair, so quotes, comments and vetted rules survive verbatim and the transform stays idempotent.

The profile adopts an explicit permission-key allowlist. `"*": deny` must be the FIRST rule and appear exactly once; the only permitted constrained rules are the exact scalars `read: allow`, `bash: deny`, and (for the review agent) `StructuredOutput: allow`; vetted, anchored `sunaba_<tool>` / `kaiba_<tool>` / `shiori_<tool>` entries (value `allow`) and the `shiori*` family glob are preserved; and the nested `skill:` map (`"kusabi-*": allow` children) is preserved verbatim. Every other key is refused with an actionable error — an unknown host builtin (`write`, `edit`, `patch`, `terminal`, ...), any general glob that could shadow a host tool (`read*`, `write*`, `**`, `sunaba_*`), a duplicate constrained key or extra wildcard, an object mapping for a scalar key, or an unsupported nested skill child. A conflicting constrained value (`read: deny`, `bash: allow`, `StructuredOutput: deny`) is refused rather than silently normalised, and quoting or an inline comment on the value does not bypass the check. Exact supported rules are accepted idempotently, so re-running the transform is a no-op. If the supported syntax cannot be safely parsed, the transform fails with an actionable error rather than guessing.

`install-agents` computes all agent contents via this preflight BEFORE any filesystem mutation, so a transform failure aborts the install with a descriptive error and nothing written — no agent files, no durable marker, no destination directory.

### 5.2.1 Agent Installation Command
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
2. `read: allow` is inserted immediately after `*: deny`.
   decidePermission() approves every `ask`, so `ask` is an unconditional allow in kusabi; `allow` states the intent (#783).
3. `bash: deny` is inserted immediately after `read: allow`.
4. **Synthetic Tool Permission (`StructuredOutput: allow`)**:
   - In OpenCode v1.19.3+, requesting structured output (`format: { type: "json_schema", ... }`) causes OpenCode (`packages/opencode/src/session/prompt.ts`) to inject the synthetic tool `tools.StructuredOutput`.
   - Tool visibility evaluation (`session/llm/request.ts` `resolveTools`) computes `Permission.disabled(tools, agent.permission)`. Under a wildcard `*: deny`, any tool not explicitly permitted is disabled.
   - For the opt-in installed review agent (`kusabi-review.md`) only, `StructuredOutput: allow` is explicitly added after `*: deny` so the synthetic tool is visible to the model.
   - Non-review agents (`kusabi-implement`, `kusabi-gofer`, etc.) do not invoke structured output contracts and remain without `StructuredOutput: allow`.
5. All existing permissions for `sunaba_*`, `shiori_*`, and `kaiba_*` are preserved verbatim.
6. Forbidden host tools (`write`, `edit`, `patch`, `terminal`, `command`, `browser`) remain strictly denied; wildcard is never escalated.

### 5.4 Host Read Acceptance
Host read access is granted explicitly as allow (decidePermission() approves every `ask`, so `ask` is an unconditional allow in kusabi; `allow` states the intent, #783). All host modifications (write, edit, patch, bash) remain strictly denied.

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
The structured flow is gated on BOTH `KUSABI_OPENCODE_FREE_WORKER=1` AND an actual review intent (phase `review`, kind `review`, or the `kusabi-review`/`review` agent name). A `json_schema` format on a non-review run never classifies it as review.
- For an opt-in structured review run, result extraction prefers `info.structured` from the last assistant message and serializes it to JSON for the review parser path (`parseReviewResult`).
- Default reviews and non-review runs keep the pre-existing behavior: `info.structured` is ignored and text fallback from message parts is preserved.
- Schema compliance is validated via `validateReview`: invalid structured data produces schema errors and unparseable verdicts; errors are never masked with synthetic approvals.
- The final-message GET success path is validated through the SAME canonical validator. An invalid structured or plain final review fails explicitly (empty result, explicit failure/schema details on `job.result.recovery`) and is NEVER hidden by falling back to a stale SSE/reasoning reconstruction. A valid final GET keeps precedence over the SSE stream.
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
  1. *Session Matching*: Strict session isolation requires the exact target session id, taken from `properties.sessionID` (or `properties.info.sessionID`). A sessionless event or a mismatched-session event is dropped and can never supply an approval (`mismatched session excluded`).
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

3. **Reinstall Phase Agents (mandatory)**:
   ```bash
   node plugins/kusabi/scripts/kusabi-companion.mjs install-agents
   # or kusabi install-agents
   ```
   Running `install-agents` without opt-in restores default-safe agent definitions from repository templates and rewrites the mode marker to `default`. This step is mandatory: the installed-agent guard refuses to run when the durable mode marker (or, absent a marker, the structural classification of the installed agents) disagrees with the active mode. The same applies in reverse: enabling opt-in after a default install requires `install-agents` under opt-in before any serve will start.

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

## 9. Strict YAML Parser Distribution & Rollback

### 9.1 Parser provenance and packaging
Agent frontmatter is parsed with the maintained `yaml` package (eemeli/yaml), pinned to **2.9.1** and vendored as a single self-contained ESM bundle at `plugins/kusabi/vendor/yaml-esm.mjs`. The root `package.json` declares no runtime dependencies and the profile never installs or resolves packages at runtime, so the parser ships inside the plugin distribution:

- The bundle is generated from the official published browser ESM build (`yaml-2.9.1.tgz`, `browser/dist/index.js`) with a documented, reproducible `esbuild` command; exact tarball integrity, license and the bundle SHA-256 are recorded in `plugins/kusabi/vendor/PROVENANCE.md`.
- The vendored artifact is generated third-party output, kept outside the linted `scripts/` directory and clearly separated from the authored policy modules. Only the published upstream sources are bundled — no upstream test suites are copied.
- `free-worker-yaml.mjs` imports the bundle with a relative path, so the profile boots from a clean runtime copy with no ambient `node_modules` (a regression test copies the modules plus `vendor/` to a fresh directory and exercises the transform there).
- Rollback of the parser replacement is a code revert of `free-worker-yaml.mjs`, `free-worker-profile.mjs` and the `vendor/` directory together; the default non-opt-in path was never changed and `KUSABI_OPENCODE_FREE_WORKER` unset/`0` remains byte-for-byte identical.
