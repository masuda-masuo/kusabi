// chain-wait.mjs — block until a chain reaches a terminal state.
//
// Chains are dispatched detached (`setsid nohup … &`) so the caller's Bash
// tool cannot reap the serve.  The price is that no completion signal exists,
// and every orchestrator session used to hand-roll a
// `while pgrep -f <pattern>; do sleep; done` watcher.  All three failure modes
// of that pattern fired in one session (2026-08-16):
//
//   1. the pgrep pattern matched `chain --brief-file` but not `chain-resume`,
//      so a resume's completion went unwatched;
//   2. a `chain-resume` invoked without its chain id died in under a second
//      with a usage error — indistinguishable from "already finished" to a
//      process-existence watcher, so the error sat unread in a log;
//   3. process liveness is not chain state: a process alive but stuck never
//      fires, and process death does not mean a disposition exists.
//
// So this module watches chain STATE (control.json + chain.json), and uses
// process liveness only as the tie-breaker for "state can no longer advance".
// It is a pure poll loop: no LLM, no serve, no resources to clean up, safe to
// SIGTERM at any moment — which is what makes the WAIT trackable by the
// caller's harness where the chain itself is not.
//
// The exit-code contract the callers script on lives in the two return paths:
// a terminal chain resolves (whatever its disposition — reporting it is the
// digest's job, judging it is the orchestrator's), and every way the WAIT
// itself failed throws a ChainWaitError.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readJson } from "./state-paths.mjs";
import { readChainControl } from "./chain-control.mjs";

/**
 * Control-record statuses that mean the chain process is done with this chain.
 * Written by finalizeChainControl() (chain-control.mjs) on every exit path.
 */
export const TERMINAL_CHAIN_STATUSES = new Set(["completed", "cancelled", "failed"]);

/**
 * Round dispositions after which the chain never runs another round.  The
 * driver writes chain.json (with the round's disposition) and finalises
 * control.json immediately after, so this only ever matters inside that
 * window — but reading it keeps a wait from sleeping through a decided chain.
 *
 * The one place it lies is after a chain-resume: rearmChainControl puts the
 * status back to "running" while the previous round's disposition sits in
 * chain.json until the resumed round reaches its own boundary.  See the
 * terminal decision in readChainSnapshot for how that case is told apart.
 */
export const TERMINAL_DISPOSITIONS = new Set([
  "accept", "accept-with-followup", "escalate", "max-rounds",
  // A qualifying refusal (kusabi #293): the worker named two contradicting
  // brief items and stopped without editing.  Terminal like any other decided
  // chain -- the wait reports it, and judging it stays the orchestrator's job.
  "refused-brief-defect",
]);

export const DEFAULT_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_APPEAR_TIMEOUT_MS = 120_000;
// Generous on purpose: this is the backstop for a chain whose process is
// still alive but making no progress.  The fast path for the common death
// (process gone mid-round) is the liveness probe, which does not wait for it.
export const DEFAULT_PROGRESS_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/**
 * Every way the wait itself failed.  `code` is the machine-readable half:
 * "unknown-chain", "no-chain-appeared", "stalled", "usage".
 */
export class ChainWaitError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ChainWaitError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// state reading
// ---------------------------------------------------------------------------

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** The round's disposition, which is `{disposition, reason}` on live records
 * and a bare string on some older ones. */
function dispositionOf(record) {
  const value = record?.disposition;
  if (typeof value === "string") return value;
  if (value && typeof value.disposition === "string") return value.disposition;
  return null;
}

/**
 * Read everything a wait decides on, in one shot.
 *
 * Same readers as chain-show (readChainControl + readJson over chain.json):
 * a chain that died before its first round boundary has no chain.json at all,
 * and the control record still carries id/status/round.
 *
 * @param {string} chainsDir - `<stateDir>/chains`.
 * @param {string} chainId
 * @returns {{
 *   chainId: string, chainDir: string, exists: boolean, control: object|null,
 *   status: string, disposition: string|null, rounds: number, pid: number|null,
 *   terminal: boolean, fingerprint: string,
 * }}
 */
export function readChainSnapshot(chainsDir, chainId) {
  const chainDir = path.join(chainsDir, chainId);
  const exists = fs.existsSync(chainDir);
  const control = exists ? readChainControl(chainDir) : null;
  const chainJson = exists ? readJson(path.join(chainDir, "chain.json")) : null;
  const records = Array.isArray(chainJson?.records) ? chainJson.records : [];

  let disposition = null;
  for (let i = records.length - 1; i >= 0 && disposition === null; i -= 1) {
    disposition = dispositionOf(records[i]);
  }

  const status = typeof control?.status === "string" ? control.status : "unknown";
  const rounds = records.length || (Number.isFinite(control?.round) ? control.round : 0);
  const pid = Number.isFinite(control?.pid) ? control.pid : null;

  // `running` + a terminal disposition has two causes, and only one of them
  // means "done":
  //
  //   - the pre-finalise window: persistChainState writes chain.json and
  //     finalizeChainControl writes control.json a moment later, so the
  //     disposition is on disk before the status catches up.  Terminal.
  //   - resume residue (#286): rearmChainControl put the status back to
  //     `running`, but the PREVIOUS round's disposition stays in chain.json
  //     until the resumed round reaches its own boundary.  Not terminal —
  //     reading it as one made chain-wait exit 0 the instant it started.
  //
  // `resumedAt` is what separates them: rearmChainControl writes it, a chain
  // in its first pre-finalise window has never had one.
  //
  // Residual, accepted deliberately: a resumed chain that dies inside its own
  // pre-finalise window still carries resumedAt with status `running`, so the
  // wait sleeps until its timeout and exits non-zero.  A false timeout fails
  // loud, a false terminal fails silent; telling those two apart would need a
  // new persisted field, which is not worth it here.
  const resumeResidue = Boolean(control?.resumedAt) && status === "running";
  const settledByDisposition = TERMINAL_DISPOSITIONS.has(disposition) && !resumeResidue;

  return {
    chainId,
    chainDir,
    exists,
    control,
    status,
    disposition,
    rounds,
    pid,
    terminal: exists && (TERMINAL_CHAIN_STATUSES.has(status) || settledByDisposition),
    // Any observable movement, including a rewrite that changed no field we
    // read: a chain still writing is a chain still working.
    fingerprint: JSON.stringify([
      exists, status, control?.round ?? null, control?.stopRequestedAt ?? null,
      control?.resumedAt ?? null, records.length, disposition,
      mtimeOf(path.join(chainDir, "control.json")),
      mtimeOf(path.join(chainDir, "chain.json")),
    ]),
  };
}

/** Chain ids under a chains directory (missing directory → none). */
export function listChainIds(chainsDir) {
  try {
    return fs.readdirSync(chainsDir)
      .filter((name) => name.startsWith("chain-"))
      .filter((name) => {
        try {
          return fs.statSync(path.join(chainsDir, name)).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/** Creation stamp of a chain directory; birthtime where the filesystem keeps
 * one, ctime otherwise.  0 when it cannot be read at all. */
export function chainDirCreatedAt(chainsDir, chainId) {
  try {
    const stat = fs.statSync(path.join(chainsDir, chainId));
    return Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// liveness
// ---------------------------------------------------------------------------

/**
 * Does this command line belong to a kusabi chain process?
 *
 * A recorded pid can be recycled — including into a thread id of an unrelated
 * process — so `kill(pid, 0)` answers "some process exists", never "the chain
 * still runs".  The command line is what distinguishes them, and it must
 * cover BOTH entry points: a chain started as `chain` and one restarted as
 * `chain-resume` (failure mode 1 above was exactly a pattern that matched one
 * and not the other).
 *
 * @param {string[]} argv - argv tokens of the candidate process.
 * @returns {boolean}
 */
export function looksLikeChainProcess(argv) {
  const tokens = (Array.isArray(argv) ? argv : []).filter(Boolean);
  if (!tokens.some((t) => t.includes("kusabi-companion"))) return false;
  return tokens.some((t) => t === "chain" || t === "chain-resume" || t === "chainResume");
}

function readProcArgv(pid) {
  return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
}

function readPsArgv(pid) {
  const out = execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
  return out.trim().split(/\s+/).filter(Boolean);
}

/**
 * What a failed /proc read actually proves.
 *
 * The whole distinction the wait turns on: "the kernel says there is no such
 * pid" (`gone`, which may confirm a stall) against "this host will not tell
 * us" (`unverifiable`, which may not).  A permission error is the second one.
 * Under a hidepid=1 mount a perfectly live chain reads as EACCES, and calling
 * that death reports a working chain as stalled — and `ps` cannot rescue it,
 * because the same mount blinds `ps` in exactly the same way while still
 * exiting non-zero, which looks identical to "no such pid".
 *
 * Returns null for "no answer here, ask `ps`" — the no-/proc-at-all case,
 * the only one where `ps` knows something this read did not.
 *
 * @param {NodeJS.ErrnoException} err - what the /proc read threw.
 * @param {number} pid
 * @returns {"gone"|"unverifiable"|null}
 */
function classifyProcReadFailure(err, pid) {
  // EACCES/EPERM (hidepid=1), EIO, anything unnamed: the entry is unreadable,
  // which is not the same as absent.
  if (err?.code !== "ENOENT") return "unverifiable";
  if (!fs.existsSync("/proc/self")) return null; // no /proc here; `ps` may know
  // /proc is mounted and answered ENOENT: no such process — unless the entry
  // itself is there and only its cmdline could not be reached.
  return fs.existsSync(`/proc/${pid}`) ? "unverifiable" : "gone";
}

/**
 * Is the chain process behind this pid still running?
 *
 * Judged by command line (/proc/<pid>/cmdline, falling back to
 * `ps -o args= -p <pid>`), never by a bare signal-0 probe.  Three answers,
 * because they have three different consequences:
 *
 *   "alive"        - a chain process is there; keep waiting.
 *   "gone"         - the pid provably has no matching process: it is dead, or
 *                    it now belongs to something that is not this chain.
 *                    Chain state can no longer advance.
 *   "unverifiable" - liveness cannot be read here (no pid recorded, hidepid or
 *                    another permission wall, an unreadable /proc entry, no
 *                    /proc and no `ps`).  Never treated as death: declaring a
 *                    live chain stalled is the worse error, and the progress
 *                    timeout still bounds the wait.
 *
 * @param {number|null} pid
 * @param {object} [seams] - the two reads, injected so a test can present the
 *   failures this host cannot be made to produce: a hidepid mount denies the
 *   /proc read AND makes `ps` exit non-zero, and no machine that has neither
 *   can show that pair.
 * @param {(pid: number) => string[]} [seams.readArgv] - the /proc read.
 * @param {(pid: number) => string[]} [seams.readPs] - the `ps` fallback.
 * @returns {"alive"|"gone"|"unverifiable"}
 */
export function probeChainProcess(pid, { readArgv = readProcArgv, readPs = readPsArgv } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return "unverifiable";

  let argv = null;
  try {
    argv = readArgv(pid);
  } catch (err) {
    const answer = classifyProcReadFailure(err, pid);
    if (answer !== null) return answer;
  }

  if (argv === null) {
    try {
      argv = readPs(pid);
    } catch (err) {
      // Only reached when the host has no /proc at all, so no hidepid mount is
      // in play: `ps` exiting non-zero is it saying the pid is not in its
      // table.  A spawn failure (no `ps` on PATH) leaves the question open.
      if (typeof err?.status === "number") return "gone";
      return "unverifiable";
    }
  }

  if (argv.length === 0) return "gone"; // exited/zombie: no command line left
  return looksLikeChainProcess(argv) ? "alive" : "gone";
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/** The one-line digest a completed wait prints. */
export function formatWaitDigest(snapshot, { waitedMs = 0 } = {}) {
  return `chain ${snapshot.chainId}: status=${snapshot.status} `
    + `disposition=${snapshot.disposition ?? "none"} rounds=${snapshot.rounds} `
    + `waited=${Math.round(waitedMs / 1000)}s`;
}

/** The state half of a stall message — deliberately the same key=value
 * spelling as the digest, so the two read alike in a log. */
export function describeSnapshot(snapshot) {
  return `status=${snapshot.status} disposition=${snapshot.disposition ?? "none"} rounds=${snapshot.rounds}`;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// the wait
// ---------------------------------------------------------------------------

/**
 * The `--next` selection rule, built once per wait.
 *
 * Selection with an explicit `since` stamp: any chain created at or after it,
 * terminal or not.  That is the precise tool, and it is unchanged.  Mid-wait
 * re-selection applies in both branches while the locked chain is still
 * recordless: a newer eligible chain that appears wins (kusabi #309), and
 * under `--since` the newcomer must still satisfy `createdAt >= since` for
 * the window semantics to hold.
 *
 * Selection by default: any chain that is new since the wait started, OR one
 * that was already there and has not reached a terminal state.  The second
 * half is what makes the recommended dispatch-then-wait ordering work.  The
 * dispatch creates the chain directory, and it races the wait's start: a pure
 * "was not in the set of ids present at start" baseline turns a healthy chain
 * that won that race into a chain that never appeared, and the wait reports a
 * live dispatch as dead.  Terminal chains stay excluded, so last week's
 * accepted chain can never resolve a wait instantly.  In sequential use the
 * just-dispatched chain is the only non-terminal one whichever side of the
 * start it landed on; concurrent chains in one cwd keep `--since` and an
 * explicit chain id as their precise tools.  Newest first.
 *
 * One default-branch exclusion (kusabi #298): a preexisting directory with no
 * control record whose creation stamp is older than the appear window is
 * debris — a dispatch killed before it ever wrote anything (a WSL shutdown
 * left exactly one behind).  Nothing will ever make it terminal, so it can
 * never be the chain the caller means; it is skipped, and the caller is told
 * on stderr, once per directory.  A recordless directory created WITHIN the
 * appear window is not debris: that is the normal startup shape of a
 * just-dispatched chain whose control record has not landed yet.
 *
 * @param {object} opts
 * @param {string} opts.chainsDir
 * @param {number|null} opts.since          - explicit selection stamp.
 * @param {number} opts.startedAt           - the wait's start stamp.
 * @param {number} opts.appearTimeoutMs     - the appear window.
 * @param {(chainId: string) => void} opts.reportIgnored - told once per
 *                                         skipped debris directory.
 * @returns {() => Array<{id: string, createdAt: number}>} a callable that
 *   returns the eligible chain directories, newest first.
 */
function makeNextCandidateSelector({ chainsDir, since, startedAt, appearTimeoutMs, reportIgnored, createdAt = chainDirCreatedAt }) {
  const preexisting = since == null ? new Set(listChainIds(chainsDir)) : null;
  const reported = new Set();
  const isCandidate = (id) => {
    if (preexisting === null) return createdAt(chainsDir, id) >= since;
    if (!preexisting.has(id)) return true;
    const snapshot = readChainSnapshot(chainsDir, id);
    if (snapshot.terminal) return false;
    if (snapshot.control === null && createdAt(chainsDir, id) < startedAt - appearTimeoutMs) {
      if (!reported.has(id)) {
        reported.add(id);
        reportIgnored(id);
      }
      return false;
    }
    return true;
  };
  return () => listChainIds(chainsDir)
    .filter(isCandidate)
    .map((id) => ({ id, createdAt: createdAt(chainsDir, id) }))
    .sort((a, b) => (b.createdAt - a.createdAt) || a.id.localeCompare(b.id));
}

function reportIgnoredDefault(chainId) {
  console.error(`ignoring ${chainId}: no control record, older than appear window`);
}

/**
 * Wait for a chain directory to appear.
 *
 * A dispatch can die before creating one (failure mode 2: `chain-resume` with
 * no chain id, `chain` with no --container).  Without a bound that death is
 * silent; with one it is a named non-zero exit.
 *
 * Selection is the rule above; the newest eligible chain id wins.
 */
async function waitForChainToAppear({
  candidates, chainsDir, since, pollIntervalMs, appearTimeoutMs, sleep, now, startedAt,
}) {
  for (;;) {
    const list = candidates();
    if (list.length > 0) return list[0].id;

    if (now() - startedAt >= appearTimeoutMs) {
      const scope = since == null
        ? "new since this wait started, or already present and not yet terminal"
        : `created at or after ${new Date(since).toISOString()}`;
      const precise = since == null
        ? " If several chains run in this workspace at once, name the chain id or pass "
          + "--since <ISO> to say which one this wait is for."
        : "";
      throw new ChainWaitError(
        `no chain appeared within ${Math.round(appearTimeoutMs / 1000)}s `
        + `(looked for a chain ${scope}; searched ${chainsDir}) — the dispatch produced no `
        + `chain directory to wait on, so it died before starting one.${precise}`,
        "no-chain-appeared",
      );
    }

    await sleep(pollIntervalMs);
  }
}

/**
 * Block until a chain reaches a terminal state.
 *
 * Resolves with `{ ...snapshot, digest }` when the chain is terminal, whatever
 * its disposition.  Throws ChainWaitError when the WAIT failed: unknown chain
 * id, nothing appeared in appear-mode, or the chain stalled.
 *
 * Everything the loop cannot decide from files is injected — `sleep`, `now`,
 * and the liveness prober are the seams the tests fake.
 *
 * @param {object} opts
 * @param {string} opts.chainsDir            - `<stateDir>/chains`.
 * @param {string|null} [opts.chainId]       - the chain to wait on.
 * @param {boolean} [opts.next]              - wait for a chain to APPEAR first.
 * @param {number|null} [opts.since]         - appear-mode start stamp (epoch ms).
 * @param {number} [opts.pollIntervalMs]
 * @param {number} [opts.appearTimeoutMs]    - also bounds "chain dir exists but
 *                                             never got a control record".
 * @param {number} [opts.progressTimeoutMs]
 * @param {(pid: number|null) => "alive"|"gone"|"unverifiable"} [opts.probeProcess]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.now]
 * @param {(chainId: string) => void} [opts.reportIgnored] - told once per chain
 *                                     dir skipped as debris (default: one
 *                                     stderr line).
 */
export async function waitForChain({
  chainsDir,
  chainId = null,
  next = false,
  since = null,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  appearTimeoutMs = DEFAULT_APPEAR_TIMEOUT_MS,
  progressTimeoutMs = DEFAULT_PROGRESS_TIMEOUT_MS,
  probeProcess = probeChainProcess,
  sleep = defaultSleep,
  now = Date.now,
  reportIgnored = reportIgnoredDefault,
  createdAt = chainDirCreatedAt,
} = {}) {
  const startedAt = now();

  let id = chainId;
  // The --next selection rule.  It is also consulted while the wait holds a
  // recordless chain, so a newer chain directory that appears mid-wait wins
  // over the empty dir (kusabi #298).
  let candidates = null;
  // Chain ids this wait has already traded away (kusabi #309).  A recordless
  // dir may be switched away from while it stays recordless; once abandoned
  // it can never be picked again, so two same-stamp empty dirs cannot make
  // the wait bounce between them forever.  The set only grows within one
  // wait — each directory is held at most once, so the loop terminates by
  // construction.
  const abandoned = new Set();
  if (next) {
    candidates = makeNextCandidateSelector({
      chainsDir, since, startedAt, appearTimeoutMs, reportIgnored, createdAt,
    });
    id = await waitForChainToAppear({
      candidates, chainsDir, since, pollIntervalMs, appearTimeoutMs, sleep, now, startedAt,
    });
  } else {
    if (!id) {
      throw new ChainWaitError("chain-wait needs a chain id (or --next to wait for one to appear)", "usage");
    }
    if (!fs.existsSync(path.join(chainsDir, id))) {
      throw new ChainWaitError(`unknown chain: ${id} (searched ${chainsDir})`, "unknown-chain");
    }
  }

  const done = (snapshot) => ({ ...snapshot, digest: formatWaitDigest(snapshot, { waitedMs: now() - startedAt }) });
  const stall = (snapshot, staleMs, reason) => new ChainWaitError(
    `chain ${snapshot.chainId} stalled: last observed ${describeSnapshot(snapshot)}, `
    + `unchanged for ${Math.round(staleMs / 1000)}s (${reason}). `
    + `Chain state is written at round boundaries only, so it can no longer advance — `
    + `inspect with: kusabi-companion chain-show ${snapshot.chainId}`,
    "stalled",
  );

  let fingerprint = null;
  let lastProgressAt = startedAt;

  for (;;) {
    const snapshot = readChainSnapshot(chainsDir, id);
    if (snapshot.terminal) return done(snapshot);

    if (snapshot.fingerprint !== fingerprint) {
      fingerprint = snapshot.fingerprint;
      lastProgressAt = now();
    }

    // The recorded process is gone: chain.json is written at round boundaries
    // only, so a chain that died mid-round can never update it and a wait that
    // only polls state would hang forever.  Re-read once after a poll interval
    // before calling it — the terminal write happens just before the process
    // exits, so an instant of "dead but not yet read as finished" is normal.
    //
    // Only a "gone" answer may get this far: "unverifiable" says the host
    // cannot see the process, not that the process is not there, and the
    // progress timeout below is what bounds a wait on a chain we cannot see.
    const liveness = snapshot.pid === null ? "unverifiable" : probeProcess(snapshot.pid);
    if (liveness === "gone") {
      await sleep(pollIntervalMs);
      const confirmed = readChainSnapshot(chainsDir, id);
      if (confirmed.terminal) return done(confirmed);
      if (confirmed.fingerprint !== snapshot.fingerprint) continue; // still moving
      throw stall(confirmed, now() - lastProgressAt, `recorded process ${snapshot.pid} is gone`);
    }

    // A chain directory with no control record: `chain` creates the directory
    // before it validates --container, so an instant death can leave one.
    // Nothing here records a pid, so liveness cannot answer — bound it.
    if (snapshot.control === null) {
      // While the selected chain is still recordless, a newer — or same-
      // stamped — eligible chain directory may have appeared since the
      // selection (kusabi #298, #309).  An empty dir can never lose a race it
      // was never running — the wait switches to the newer chain instead of
      // stalling on the debris.  The selector exists only in appear mode: a
      // NAMED chain is the caller's explicit choice and is never traded away.
      if (candidates !== null) {
        const lockedAt = createdAt(chainsDir, id);
        // A switch target must be at least as new as the locked dir — the
        // same-stamp case is a real chain born in the same millisecond as the
        // empty dir — and must be neither the locked dir itself nor one this
        // wait already traded away: an abandoned dir is never revisited.
        const target = candidates().find(
          (c) => c.createdAt >= lockedAt && c.id !== id && !abandoned.has(c.id),
        );
        if (target) {
          abandoned.add(id);
          id = target.id;
          continue;
        }
      }
      if (now() - startedAt >= appearTimeoutMs) {
        throw stall(
          snapshot,
          now() - startedAt,
          `no control record in ${snapshot.chainDir} after ${Math.round(appearTimeoutMs / 1000)}s`,
        );
      }
    }

    const staleMs = now() - lastProgressAt;
    if (staleMs >= progressTimeoutMs) {
      throw stall(snapshot, staleMs, `no progress for ${Math.round(progressTimeoutMs / 1000)}s`);
    }

    await sleep(pollIntervalMs);
  }
}
