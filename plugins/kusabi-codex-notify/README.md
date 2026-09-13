# kusabi-codex-notify

Codex plugin that registers detached kusabi **chains** and **tasks** and queues exactly one terminal notification into the originating Codex thread without polling the model.

This repository (`masuda-masuo/kusabi`) is the **source of truth** for this plugin. It previously lived in kairanban; installs that still point at a kairanban checkout are migrated by `kusabi-companion install-cli`, which atomically replaces the old symlink with one into this repository (see below).

## Overview

When running detached kusabi chains or tasks, the orchestrating Codex thread would otherwise remain unaware of completion without manual polling or next user input. `kusabi-codex-notify` bridges this gap:

1. **Launches & Registers** via a model-free launch wrapper (`--launch` for `chain-detach`, `--launch-task` for `task-detach`) or explicit registration (`--chain <id>` / `--task <jobId>`).
2. **Runs** a detached background watcher (`scripts/watch-chain.mjs`) in an isolated process group.
3. **Waits** via a single blocking `kusabi-companion chain-wait <chainId>` — or `kusabi-companion task-wait <jobId>` — invocation.
4. **Parses** authoritative terminal state: for chains `status` / `disposition` / `container` (missing container = `unavailable`); for tasks the `task-wait` digest plus the durable job record (phase, backend/model, fallback trail).
5. **Distinguishes** the four task terminal classes in the notification: `completed`, `failed` (provider-error/error), `stalled` (timeout/stalled/serve-dead), and `cancelled`, and names the exact recovery commands (`kusabi-companion result <jobId>` / `status <jobId>`). A `task-wait` infrastructure failure is a separate watcher failure and never queues.
6. **Enforces at-most-once delivery** using an atomic, mutually exclusive two-phase claim (`claims/<kind>-<id>.claim`) with bounded retries on definitive failure. Chain and task registrations never collide: every record and claim persists an explicit `subject: { kind: "chain"|"task", id }`.
7. **Queues** exactly one terminal notification into the originating Codex thread via `codex queue --thread <threadId> --message <summary>`.
8. **Persists** durable outcome, diagnostic metadata (terminal-observed / attempt / delivery timestamps), and recovery state. A signal-interrupted `task-wait` / `chain-wait` persists a distinct **resumable** `wait_interrupted` record — never a terminal `*_wait_failed` — which a later mutating invocation auto-sweeps (see [Restart & Resume Trigger](#restart--resume-trigger-no-polling)).

## Installation & Manifest Specification

### Manifest Cleanliness

The manifest at `.codex-plugin/plugin.json` strictly adheres to the official Codex plugin specification and passes the plugin-creator validator without errors. Unsupported manifest fields (such as `$schema` or `hooks`) are intentionally omitted.

### Local Installation (from this checkout)

`kusabi-companion install-cli` symlinks this plugin into Codex's plugin directory using the same no-clobber / atomic-symlink discipline as the skills: a real user file or directory at the destination is reported as a `conflict` and never deleted; a stale symlink (including one left by the previous kairanban install) is atomically replaced so Codex follows this repository.

```bash
node plugins/kusabi/scripts/kusabi-companion.mjs install-cli
# => created: ~/.codex/plugins/kusabi-codex-notify -> <repo>/plugins/kusabi-codex-notify
```

Target directory: `<codexDir>/plugins` (`~/.codex/plugins`, or `KUSABI_CODEX_PLUGINS_DIR` to override; the source directory is always this checkout, derived from the companion script's own path).

Manual equivalent:

```bash
ln -s /path/to/kusabi/plugins/kusabi-codex-notify ~/.codex/plugins/kusabi-codex-notify
```

To remove:

```bash
rm ~/.codex/plugins/kusabi-codex-notify
```

## Primary Supported Workflow: Model-Free Launch Wrappers

### Hook Ingestion Limitation

Current Codex CLI releases do not natively ingest or execute tool-interceptor hooks from `hooks/hooks.json` or plugin manifests. Therefore, passive tool-use interception cannot be relied upon in Codex.

### Launch a chain (`--launch`)

```bash
node /path/to/kusabi/plugins/kusabi-codex-notify/scripts/register-watch.mjs \
  --launch -- \
  --container <container-id> \
  --model <model> \
  --brief-file <brief-path>
```

The `--launch` wrapper inserts `chain-detach` itself; do not manually invoke the companion launch subcommand.

`--launch` records an authoritative `--since` timestamp, waits up to 120000ms for an eligible new chain directory (matching `chain-wait --next --appear-timeout` default), then detaches `watch-chain.mjs`. Do not restore newest-chain fallback while `--since` is present.

### Launch a task (`--launch-task`)

```bash
node /path/to/kusabi/plugins/kusabi-codex-notify/scripts/register-watch.mjs \
  --launch-task -- \
  --container <container-id> \
  --phase implement \
  --model <model> \
  --brief-file <brief-path>
```

The `--launch-task` wrapper inserts `task-detach` itself, invokes it via argv (no shell), **captures the authoritative cwd/thread/container/phase/backend/model inputs** (they travel on the notification record), resolves the real job id from the exact `task-wait --next --since <ISO>` selector output `task-detach` prints (bounded poll for the job record to appear — never guessing, never matching `task-detach-*` log basenames), registers the detached task watcher, and **returns promptly** with the dispatch output. The watcher then owns the single blocking `kusabi-companion task-wait <jobId>` process.

### Register an existing chain or task

```bash
node /path/to/kusabi/plugins/kusabi-codex-notify/scripts/register-watch.mjs \
  --chain "$CHAIN_ID" --thread "$CODEX_THREAD_ID"

node /path/to/kusabi/plugins/kusabi-codex-notify/scripts/register-watch.mjs \
  --task "$JOB_ID" --thread "$CODEX_THREAD_ID"
```

### Watcher CLI

```bash
node /path/to/kusabi/plugins/kusabi-codex-notify/scripts/watch-chain.mjs \
  --chain "$CHAIN_ID" --thread "$CODEX_THREAD_ID"

node /path/to/kusabi/plugins/kusabi-codex-notify/scripts/watch-chain.mjs \
  --task "$JOB_ID" --thread "$CODEX_THREAD_ID"
```

`--remote <endpoint>` makes the watcher invoke `codex queue` with separate argv elements (`--remote`, `<endpoint>`, `--thread`, `<threadId>`, `--message`, `<summary>`); without it the default argv form is kept. Immediate live-TUI delivery requires all three (Codex app-server, origin TUI, wrapper registration) to share the same endpoint.

## Outcome status: `delivered`

The durable outcome/status name remains `delivered` for backward compatibility. It means **`codex queue` exited 0** (the command was accepted). It is **not** proof of immediate live TUI display, and this plugin does not claim a live-delivery acknowledgment that Codex does not expose.

## State, Claim Machine & Recovery Semantics

### State Directory Layout

Durable state is stored by default under `~/.kusabi/codex-notify` (or `$KUSABI_CODEX_NOTIFY_STATE_DIR`):

```text
~/.kusabi/codex-notify/
  records/
    chain-<chainId>.json    # durable record per chain (subject kind "chain")
    task-<jobId>.json       # durable record per task (subject kind "task")
  claims/
    chain-<chainId>.claim   # two-phase atomic claim per subject
    task-<jobId>.claim
    chain-<chainId>.lock/   # atomic directory lock ensuring mutual exclusion
    task-<jobId>.lock/
```

Record and claim keys are namespaced by the **explicit subject kind** — never inferred from the id's token shape — so a chain and a task can never collide, even for equal id strings. Records and claims written by the kairanban-era plugin (unprefixed `records/<chainId>.json` / `claims/<chainId>.claim`) are still read as legacy chain subjects, so an upgrade in place never re-delivers an already-delivered chain.

### Two-Phase Claim State Machine & Crash Window

Delivery rights are strictly coordinated through a state machine with atomic directory locks:

- **`preparing`**: Claim acquired by an active watcher. The process is reading control/inbox state and formatting the notification. If the process dies or crashes here, **no external process was spawned**. This state is safe to recover and will be resumed by restart recovery.
- **`queue_inflight`**: Transitioned immediately before spawning `codex queue`. Because process spawning and durable disk state cannot be made atomic without external transaction coordinators, marking in-flight before spawn provides a fail-closed boundary: if a crash or kill occurs while in-flight, the state is recorded as `ambiguous` and **is never automatically retried**, preventing a duplicate `codex queue` invocation. This is duplicate prevention, not an exactly-once guarantee — the external queue is non-idempotent, so the ambiguous record names the boundary and manual verification is the resolution path (see [Fail-Closed In-Flight Boundary](#fail-closed-in-flight-boundary)).
- **`delivered`**: Terminal delivery confirmed via exit code 0 from `codex queue`. Subsequent registrations return `already delivered` without calling `codex queue` again.
- **`failed_retryable`**: Definitive queue failure occurred before delivery (e.g. non-zero exit code). Concurrent retry reclamation is mutually exclusive via `acquireClaimLock`. Retryable up to `MAX_DELIVERY_ATTEMPTS = 3`.
- **`failed_terminal`**: Terminal failure reached after exhausting max delivery attempts or destination thread closed/unavailable.
- **`ambiguous`**: In-flight queue command was interrupted or terminated unconfirmed. Recorded distinctly and never automatically retried.

A task queue failure preserves the durable job record (the notifier is read-only over the kusabi job store — job.json / result.md / events.ndjson are never touched), so `kusabi-companion result <jobId>` stays available and the claim remains retryable under the same bounded protocol.

### Restart & Resume Trigger (no polling)

Terminal notification duties are durable: a watcher that is interrupted or
killed mid-lifecycle leaves a resumable record. Recovery has exactly two
triggers, **neither of which is a polling loop, timer, cron, or supervisor**:

- **Explicit resume**: `register-watch.mjs --resume-all` re-registers every
  pending record (`waiting` / `pending` / `wait_interrupted` / retryable
  `queue_failed`) whose watcher is dead or absent.
- **Automatic bounded sweep**: every *mutating* invocation
  (`--launch-task`, `--launch`, `--task`, `--chain`, and the hook entrypoint)
  first runs the same resume pass over persisted records. Read-only `--list`
  never sweeps. The sweep is lazy and bounded — only records whose watcher is
  dead/absent are resumed, live subjects are never touched, and no watcher
  ever triggers the sweep, so there is no recursion and nothing runs in the
  background between invocations.

  The automatic sweep always resumes non-blockingly (detached watchers), even
  when the primary command uses `--sync` — it must never hold up the primary
  invocation on a stale still-running subject. Explicit `--resume-all --sync`
  remains the synchronous debugging path. If part of the sweep fails, a
  concise warning with the failure and the partial resumed count is written
  to stderr (`register-watch: automatic sweep warning: ...`); the primary
  command continues, and the remaining duties are retried by the next
  mutating invocation or by `--resume-all`.

A blocking `task-wait` / `chain-wait` interrupted by a signal
(SIGTERM/SIGINT/SIGHUP, or the wait child itself being killed) is recorded as
`status: "wait_interrupted"` / `outcome: "wait interrupted (resumable)"` — a
resumable state, never a terminal `*_wait_failed`. A genuine non-signal wait
failure (non-zero exit, no signal) remains `chain_wait_failed` /
`task_wait_failed` and is never resumed. On the next mutating invocation the
sweep re-runs the wait; the terminal observation then flows through the
normal claim/queue path with one queue call per subject.

The launcher writes the record exactly once, before spawning the detached
watcher, and never touches it again: pid/startTime metadata belongs to the
watcher alone. There is therefore **no post-spawn launcher write at all**, so
a fast watcher's terminal record can never be regressed by stale initial
`waiting` state — the guarantee is structural rather than a read-then-write
patch. If the watcher dies before its first record write, the pre-spawn
pid-less `waiting` record stays durably resumable: resume treats a pid-less
record as dead and re-registers.

### Diagnostics & `--list`

Records persist timestamps that distinguish each lifecycle phase:

- `terminalObservedAt` — the blocking wait returned a terminal status
  (recorded **before** any claim acquisition or queue call).
- `attemptedAt` — `codex queue` was about to be spawned (recorded before the
  spawn, so a kill mid-queue leaves this on disk).
- `deliveredAt` — `codex queue` exited 0.
- status/`retryable` — `queue_failed` with `retryable: true`, or
  `wait_interrupted`, means delivery retry is pending; `ambiguous` means the
  in-flight boundary was hit and delivery is never auto-retried.

`--list` renders one line per record with these diagnostics:

```text
task job-x: status=delivered outcome=delivered terminalObserved=2026-09-13T12:00:01.000Z attempted=2026-09-13T12:00:02.000Z delivered=2026-09-13T12:00:03.000Z retryPending=false
task job-y: status=waiting outcome=pending retryPending=false running=true
task job-z: status=wait_interrupted outcome="wait interrupted (resumable)" retryPending=true running=false
task job-w: status=ambiguous outcome="ambiguous queue delivery" retryPending=false ambiguous=true
```

`retryPending` is **false while a healthy watcher is actively waiting** — a
live subject is not a pending duty. A waiting record whose watcher is dead or
absent (`running=false`, including a pid-less record left by a watcher that
died before startup) shows `retryPending=true` and is exactly what the next
mutating invocation will sweep.

### Diagnostic Classification

Errors from `codex queue` are strictly partitioned:
- **Closed / Unavailable Thread**: Matched only on thread/session-specific error diagnostics (e.g. `thread <id> is closed`, `thread not found`, `unknown session`).
- **Generic Queue Failure**: Generic system errors (e.g. `codex: command not found`, `file not found`, connection drop) remain bounded retryable queue failures and do not falsely terminate with a closed-thread outcome.

### Process Identity & Missing Procfs

Process verification distinguishes process existence from verified identity:

- **Verified Identity**: In full procfs environments, Linux `/proc/<pid>/stat` start time and `/proc/<pid>/cmdline` verify that the live process is genuinely the intended watcher. Unrelated processes inheriting a recycled PID are detected and do not suppress recovery.
- **Unknown-but-Live Processes**: If procfs is missing, restricted, or unreadable, `kill(pid, 0)` success indicates the owner process exists. Such processes are treated as **active** for duplicate suppression:
  - Competing callers will **never steal or remove its claim lock**.
  - A lock owned by a `kill(0)`-live process is **never stolen via age timeout alone**.
  - Its `preparing` claim will **never be reclaimed** by a competing watcher.
  - A duplicate `codex queue` invocation is strictly prevented.
- **Dead Processes**: `kill(pid, 0)` failure (or zombie status in procfs) confirms the owner has terminated. Genuinely dead `preparing` owners and stale locks remain safely recoverable.
- **Fail-Closed In-Flight Boundary**: If a claim is in `queue_inflight` and the owner process is dead or has unverified/unknown identity, the claim is permanently marked `ambiguous` and is **never automatically retried**. This preserves the existing duplicate prevention — no second `codex queue` invocation is ever made for a subject whose delivery outcome is unknown. It is **not** a claim of exactly-once delivery: `codex queue` is a non-idempotent external call, so a kill between the queue process spawn and its exit can in principle have delivered the message. The ambiguous record names the boundary explicitly (`ambiguous=true` in `--list`); manual verification (thread inspection / `codex queue`) is the resolution path.

### Child Lifecycle & Process Groups

Subprocesses (`chain-wait` / `task-wait` and `codex queue`) are launched with process group isolation (`detached: true` on POSIX). When the watcher receives `SIGTERM`, `SIGINT`, or `SIGHUP`:
- `process.kill(-pgid, "SIGTERM")` terminates the entire process group (child and grandchildren).
- Bounded escalation to `SIGKILL` occurs if processes do not terminate within 500ms.
- All signal listeners are removed to prevent memory leaks.

## Real-Session Smoke Instructions

Because sandbox containers lack a live Codex CLI daemon, full end-to-end delivery into an active thread should be verified in a host Codex session:

1. **Start a Codex session** with `CODEX_THREAD_ID` exported.
2. **Launch via wrapper** (chain or task):
   ```bash
   node /path/to/kusabi/plugins/kusabi-codex-notify/scripts/register-watch.mjs \
     --launch -- --container <container-id> --model <model> --brief-file <brief-path>
   # or: --launch-task -- --container <container-id> --phase implement --brief-file <brief-path>
   ```
3. **Verify detached execution**:
   The command returns immediately with normal `chain-detach` / `task-detach` output. The watcher waits in the background without consuming model turns.
4. **Verify terminal delivery**:
   Upon completion, exactly one notification appears in the thread:
   ```text
   [kusabi] Chain chain-xxxx completed.
   - Status: completed
   - Disposition: accept
   - Container: 1d90ea9e70b6
   - Next action: Inspect review record and publish changes or update agenda (kusabi-companion chain-show chain-xxxx).
   ```
   ```text
   [kusabi] Task job-xxxx completed.
   - Status: completed
   - Class: completed
   - Phase: implement
   - Backend/Model: opencode (opencode-go/deepseek-v4-flash:max)
   - Container: 1d90ea9e70b6
   - Recover: kusabi-companion result job-xxxx | kusabi-companion status job-xxxx
   ```
5. **Verify duplicate suppression**:
   Re-running registration for the same chain/task yields `already delivered` with zero extra messages.