# kusabi Design — Backend dispatch

The backend adapters keep their call-site contracts in source. The rationale below is moved verbatim from those comments; shared phase policy is in [phase-chain.md](phase-chain.md).

## Claude

### Claude model selection

The claude backend's default chain when the config has no models.chain /
models.phases.<phase> entry.  Claude-native shape (bare aliases): the
tier ladder is not walked in v1, so the first route is the model every
phase uses.  The opencode BUILTIN_DEFAULT_CHAIN is deliberately NOT
reused — its entries are provider/model:variant strings that the claude
backend rejects, so `--backend claude` must work out of the box with a
claude-shaped default instead of failing on a model the user never typed.

### Claude quota and watchdogs

Pre-dispatch session-quota guard (kusabi #215): before any worker is
spawned, `claude -p --output-format json "/usage"` is asked how much of the
account's SESSION window is already spent — a free control-plane call (no
inference, no tokens, no quota; ~450ms measured).  At or above the
configured threshold the dispatch is REFUSED before the spawn and the job
is finalised with the same structured session-quota failure a mid-run
session limit produces, so the chain's provider-exhaustion stop needs no
new logic.  The guard fails OPEN in every other case, records what it saw
on the job record either way, and is off unless the config asks for it
(see resolveClaudeSessionGuard).

Every alternative is a qualified multi-word phrase on purpose: a bare word
("quota", "resets") matches unrelated failure prose — "disk quota exceeded",
"git reset failed" — and a false positive here does not merely mislabel, it
flips the job to provider-error and hard-stops the chain.  When in doubt,
leave the word out: an unclassified quota failure degrades to the generic
error path, which is survivable.

Write-tool watchdog (kusabi #215 item 3).  A SEPARATE interval from
the silence watchdog on purpose: the two measure different clocks, and
a fault in this one must not be able to take the silence kill down
with it.  Same 250ms resolution, same group kill, and the whole body
is wrapped — an exception thrown inside a timer callback is an
uncaught exception that would kill the parent process, and this
feature's contract is to fail open.

Final write-clock reading (kusabi #215 item 3).  A polled interval
can be beaten to the finish line: when this process is descheduled
the child's whole output can arrive buffered together with its exit,
and the close callback (poll phase) then clears the interval before
the timers phase ever gets to observe the idle time.  The warning is
an audit fact about the run, not a property of scheduler luck, so it
is evaluated once more here — same condition, same measurement, so
this can only emit a warning the interval would have emitted itself.
Deliberately AFTER the final line is delivered (a write on the last
line still resets the clock) and never on a run some other bound
already killed: those carry their own diagnosis.

Mirrors the opencode watchdog's own status and wording exactly (kusabi
#215 Job B item 3), so a chain treats a stalled claude worker like a
stalled opencode one.  The kill always ran (runClaudeProcess only sets
`stalled` after killProcessGroup), so the wording always names it —
there is no "declined kill" case here, unlike the opencode serve
watchdog: this process is ours alone, nothing to verify ownership of.

Runs AFTER the record exists (so a refusal is a finalised job record with
a prompt and an audit trail, not a silent nothing) and BEFORE any worker
is spawned — which is the whole point: at a spent session window the
spawn is what costs money and takes the operator's own session down with
it.  Wrapped end to end: the guard may cost a dispatch its worker, never
the dispatch itself.

### Claude preflight

Resolved in PRE-FLIGHT, unlike its two siblings: an invalid
`claude.repeatWatchdog` VALUE must fail the dispatch LOUDLY before any
job record exists, before anything is written or spawned — a config
error is a loud throw, not a stuck "running" record, and never a
silently-disarmed watchdog.  Only the config FILE read fails open (the
siblings' discipline: reading a settings file must never be the thing
that fails a dispatch); an unreadable file is not an invalid VALUE, and
every invalid value throws from resolveClaudeRepeatWatchdog below.

The job id is minted here, in pre-flight, so the generated MCP config
can be named after its job (kusabi #276) and stamp KAIBA_JOB on the
kaiba entry (kusabi #391): the file lives in the job's OWN directory,
so two dispatches in the same cwd whose spawn windows overlap each hand
their claude process a config file only they write — one dispatch's
profile can never overwrite another's.  The write is deliberately the
LAST pre-flight step, after every throw-capable check above has passed,
so a loud failure never leaves a stray config behind.

## Antigravity (agy)

### Agy model selection

Model ids are validated by the agy CLI and may drift independently of the default below.

WHY a third backend: agy draws on a separate quota pool (Gemini, metered
apart from both the opencode and the claude pool) and adds a third model
family, which is what cross-family review needs.  There is NO
read-only-phase restriction — any phase may route here.

The agy backend's default chain when the config has no models.chain /
models.phases.<phase> entry.  ONE tier on purpose: this backend walks no
ladder, so a multi-tier default would describe a climb that never happens.
The opencode BUILTIN_DEFAULT_CHAIN and CLAUDE_DEFAULT_CHAIN are both
deliberately NOT reused — their entries are other backends' model
spellings, so `--backend agy` must work out of the box with an agy-shaped
default instead of failing on a model the operator never typed.  The id
WILL drift (see the model-id note above); it is a starting point, not a
contract.

### Agy transport and payloads

  agy -p <prompt> --output-format stream-json --model <id> --print-timeout <duration>
        [--json-schema <schema>] [--conversation <id>]

and an NDJSON event stream on stdout, one object per line, discriminated
by the `event` key (NOT `type` — that is the claude vocabulary; agy uses
`event`).  Three event kinds were field-verified on 2026-08-20:

  {"event":"init","conversation_id":"<uuid>","init":{model,cwd,tools,
    permission_mode,json_schema}}                     — the conversation id
                                                        sits at the TOP level
  {"event":"step_update","step_update":{conversation_id,step_index,state,
    step_type,tool_name?,tool_info?,usage?,…}}        — repeated per step; a
                                                        tool step appears as
                                                        ACTIVE then DONE (or
                                                        ERROR), same index
  {"event":"result","result":{…}}                     — the terminal line; the
                                                        inner `result` object
                                                        is BYTE-SHAPE-IDENTICAL
                                                        to the whole object
                                                        `--output-format json`
                                                        used to print

The terminal `result.result` payload therefore keeps that shape:

  {"conversation_id":"<uuid>","status":"SUCCESS","response":"<text>",
   "duration_seconds":152.4,"num_turns":2,
   "structured_output":{…},"json_schema":{…},
   "usage":{"input_tokens":…,"output_tokens":…,"thinking_tokens":…,
            "cache_read_tokens":…,"total_tokens":…}}

`structured_output` / `json_schema` appear only when `--json-schema` was
passed.  No flag outside that list is ever constructed here — in
particular NEVER `--dangerously-skip-permissions`: it is not needed (the
sunaba/shiori tools are auto-approved server-side) and the
orchestrator-side classifier blocks it.

**The outer `status` field is NOT authoritative.**  A run whose transcript
contains any failed tool call reports `status: "ERROR"` even when
`response` and `structured_output` are complete and correct (observed: one
MCP kwarg validation error mid-run, full verdict delivered).  Success is
therefore decided by PAYLOAD PRESENCE — a non-empty `response`, or a
present `structured_output` — and `status` is recorded as advisory
metadata (`job.agyStatus`) only.  A missing/empty payload is a failed job
regardless of what `status` claims.  Reading it the other way round would
throw away completed, paid-for work on a mid-run tool typo.

The prompt is on argv because that is the documented transport (unlike the
claude backend, which was field-verified to accept stdin).  The tradeoff
is real and accepted for v1: the prompt is visible in `ps` output on the
host for the life of the child.  Briefs are not secrets; credentials never
appear in one.  A stdin transport would need field verification against
the real CLI before it could replace this.

`resolveCompletedResult` selects a recovery source by backend and has
none for agy (its transcripts are the CLI's own, in a location kusabi
does not read): an empty payload therefore records
`no-recovery-source-for-backend` instead of pretending to recover.
Unreachable in practice — an empty payload is a FAILED job under the
payload rule — but the shared path keeps the record shape identical
across backends.

### Agy review schema

This is PREVENTION for the review-verdict shape problem: when the phase's
contract IS the review verdict, the CLI enforces it, so the model cannot
hand back prose where the chain expects JSON.  The schema is not a new
artifact — it is `schemas/review-output.schema.json`, the EXISTING verdict
contract that the review prompt already embeds and `parseReviewResult`
already reads.  One contract, two enforcement points; there is no schema
registry and no per-phase schema config key (out of scope by design).

Re-serialised compactly so argv is stable and the file's formatting is not
part of the invocation.

### Agy timeouts

WHY 300s: both timers start at process launch — kusabi's the instant
spawn() returns, agy's once its print-mode wait begins, which if
anything LAGS the spawn.  The ordering therefore holds whenever the
inner value exceeds the outer one, and the only thing the margin must
absorb is the skew between the two start points: sub-second in the worst
case.  300s is agy's OWN default print timeout — the smallest headroom
this module ever grants is the tool's own idea of a full wait budget,
two orders of magnitude above any plausible skew.

The direction is deliberately REVERSED vs kusabi-companion.mjs's
`DEFAULT_WATCHDOG_S = 900`, where opencode's inner 600s `mcp_timeout` is
allowed to trip FIRST because the inner error is the more informative
one.  For agy the inner failure is the LESS informative one — a
well-formed JSON object with an empty `response`, which kusabi reads as
"returned no payload", with no mention of time.  So the inner bound is
set to lose the race, and the outer bound is the one that fires.

Whole seconds only by construction (timeoutS is a whole number and so is
the margin), so no fractional part ever needs rendering.  The compound
h/m/s form is used rather than a bare seconds count because it is the
exact form the tool itself prints; whether a bare number is also
accepted is not established, so the safe spelling is the tool's own.

`watchdogS` is resolved and floored ONCE here, and the SAME value feeds
runAgyProcess (the armed interval) and the stall error text, so the two
can never disagree about the interval.  agyWatchdogSeconds REFUSES every
shape that is not a positive finite number (null arms NO watchdog) and
raises any positive value below AGY_WATCHDOG_FLOOR_S up to the floor —
the real CLI emits nothing, not even `init`, for the first ~11 seconds
of a healthy run (measured 2026-08-20), so a shorter interval would
kill correct runs.  The floor is enforced in code, never left to
callers passing a sane value.

### Agy argument size

Linux caps EACH SINGLE argv/env string at MAX_ARG_STRLEN = PAGE_SIZE * 32.
With the 4096-byte pages this project runs on that is 131072 bytes
(measured, not assumed).  This is NOT ARG_MAX (2097152 on the same host):
ARG_MAX bounds the argv+env TOTAL, and a single oversized brief hits the
per-string cap first by an order of magnitude.

It matters HERE and nowhere else.  agy has no stdin prompt transport (field
verification, kusabi #199): the composed prompt rides `-p <promptText>` and
the schema rides `--json-schema <json>`, so both are single argv strings
subject to this cap.  The claude backend feeds its prompt over stdin and
opencode goes over HTTP — neither can reach this failure, and neither gets
a size check.

MAX_ARG_STRLEN less a 1024-byte margin, for two reasons worth stating:
  - The kernel measures the string WITH its NUL terminator (`copy_strings`
    compares `strnlen_user`'s count, which includes it), so 131072 content
    bytes is already E2BIG *at* the documented limit — the usable maximum
    is 131071, and a guard set exactly at 131072 would still let one size
    through to the kernel.
  - Refusing a kilobyte early buys a legible, actionable error instead of a
    raw errno surfacing as a generic dispatch failure.  Nothing about a
    brief's usefulness turns on its last kilobyte.

### Agy role permissions

  - Per-dispatch tool permissions cannot be expressed: agy takes no
    allow/deny flags.  A deny map that reaches this dispatch (the chain
    phases pass implementDenyTools / reviewDenyTools unconditionally) is
    recorded on the job record as `toolDeniesUnenforced` rather than
    silently dropped; an operator-typed `--read-only` / `--deny` is
    rejected at command start instead (kusabi-companion.mjs), because a
    restriction that cannot be applied must never look applied.  What CAN
    be expressed is a PER-ROLE permission table: agy's allow-list lives in
    `<HOME>/.gemini/antigravity-cli/settings.json`, and HOME is derived
    from nothing else, so `agy.homes` (see resolveAgyHome) hands each role
    its own HOME — and with it its own allow-list, MCP config, and rules.
    A role with no configured home runs under the ambient HOME exactly as
    before; a configured home whose settings.json is unusable refuses the
    dispatch (fail closed) instead of widening back to the operator's own
    machine-wide table.

agy's permission table is `<HOME>/.gemini/antigravity-cli/settings.json`,
derived from HOME and nothing else — so the per-role restriction that the
flag-less CLI cannot express IS expressible as a per-role HOME.  Resolve
it ONCE here from `agy.homes` (resolveAgyHome); when it resolves to a
home, verify that home's settings.json is usable BEFORE anything is
spawned, and fail closed (throw, never a failed job) if it is not: a
missing role table would silently fall back to the operator's own
machine-wide table, running with MORE access than configured.  When it
resolves to null the spawn is byte-identical to today's dispatch (no
HOME override at all).

Denial diagnosis (kusabi #545): an `mcp` class names ONLY the class —
which MCP tool was denied is not in the result, nor in cli.log.  The
name lives as plaintext inside a protobuf BLOB in agy's conversation
database, so when (and ONLY when) `mcp` is among the classes, read
that database and record the tool.  The other classes (read_file,
read_url, command, write_file, browser) are FULLY NAMED by
`display_name`, and the last tool step of such a run belongs to a
successful call — consulting the database for them would misattribute
the denial.  `agyDeniedTool` is the string `<server>/<tool>` when
identified, else null; it is present on every record from the initial
write below, exactly like `agyHome`.  The lookup is defensive: any
database failure yields null and the dispatch proceeds as today — this
is diagnostic enrichment, not a gate, and never changes the terminal
decision.

