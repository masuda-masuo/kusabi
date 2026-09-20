import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { sessionProvenanceRefusal, renderChainBanner, cmdChain, runChainLifecycle } from "./chain-cmd.mjs";
import { resolveOrchestratorRecord } from "./kusabi-companion.mjs";
import { createChainDir } from "./chain-phases.mjs";
import { effectiveTierCount } from "./chain-driver.mjs";

// sessionProvenanceRefusal — the agy --session chain-start gate (kusabi #321)
// ---------------------------------------------------------------------------
// The refusal decision is pure and exported so every case is testable
// without running a chain: an agy implement phase plus a session whose
// provenance is not provably agy refuses, everything else passes.  The gate
// is on the PROPERTY, never on the --session flag: an id the caller
// resolved FROM the job store arrives with its owner record and is provable
// by construction, so there is no flag-shaped branch for it to take — and
// the refusal text never mentions it (asserted below).

describe("sessionProvenanceRefusal (kusabi #321)", () => {
  const AGY = "agy";
  const OPENCODE = "opencode";
  const CLAUDE = "claude";
  const UUID = "123e4567-e89b-12d3-a456-426614174000";

  it("passes a chain with no --session", () => {
    assert.equal(sessionProvenanceRefusal({ session: null, provenance: null, implementBackend: AGY }), null);
    assert.equal(sessionProvenanceRefusal({ session: undefined, provenance: null, implementBackend: AGY }), null);
    assert.equal(sessionProvenanceRefusal({ session: "", provenance: null, implementBackend: AGY }), null);
  });

  it("passes a session the store proves agy-owned on an agy chain", () => {
    assert.equal(sessionProvenanceRefusal({ session: UUID, provenance: AGY, implementBackend: AGY }), null);
  });

  it("refuses a session with no owner record on an agy chain, naming the id", () => {
    const refusal = sessionProvenanceRefusal({ session: UUID, provenance: null, implementBackend: AGY });
    assert.ok(refusal, "an unprovable id on an agy chain must refuse");
    assert.match(refusal, new RegExp(UUID));
    assert.match(refusal, /dispatch refused/);
    assert.match(refusal, /owner record/);
    assert.match(refusal, /provenance cannot be established/);
  });

  it("refuses a session owned by another backend on an agy chain, naming both backends", () => {
    for (const owner of [OPENCODE, CLAUDE]) {
      const refusal = sessionProvenanceRefusal({ session: UUID, provenance: owner, implementBackend: AGY });
      assert.ok(refusal, `an ${owner}-owned id on an agy chain must refuse`);
      assert.match(refusal, new RegExp(UUID));
      assert.match(refusal, new RegExp(owner));
      assert.match(refusal, new RegExp(AGY));
      assert.match(refusal, /belongs to the /);
    }
  });

  it("passes every session shape when the implement phase does not resolve to agy", () => {
    assert.equal(sessionProvenanceRefusal({ session: UUID, provenance: null, implementBackend: OPENCODE }), null);
    assert.equal(sessionProvenanceRefusal({ session: UUID, provenance: CLAUDE, implementBackend: OPENCODE }), null);
    assert.equal(sessionProvenanceRefusal({ session: UUID, provenance: AGY, implementBackend: OPENCODE }), null);
    assert.equal(sessionProvenanceRefusal({ session: UUID, provenance: null, implementBackend: CLAUDE }), null);
    assert.equal(sessionProvenanceRefusal({ session: UUID, provenance: AGY, implementBackend: CLAUDE }), null);
  });

  it("never mentions --resume-last: the gate is property-shaped, with no flag-shaped branch", () => {
    const noOwner = sessionProvenanceRefusal({ session: UUID, provenance: null, implementBackend: AGY });
    const foreign = sessionProvenanceRefusal({ session: UUID, provenance: OPENCODE, implementBackend: AGY });
    assert.doesNotMatch(noOwner, /resume-last/i);
    assert.doesNotMatch(foreign, /resume-last/i);
  });
});


// banner must not claim tiers it cannot walk (reworkTiers=2 on a claude
// rework chain of 2 was a false "can reach top tier" claim at maxRounds >= 3).
// =========================================================================

describe("chain-start banner (kusabi #192 follow-up)", () => {
  const OPENCODE_IMPLEMENT_1 = [["opencode-go/deepseek-v4-pro"]];
  const OPENCODE_REWORK_2 = [["opencode-go/deepseek-v4-flash"], ["opencode-go/deepseek-v4-pro"]];
  const CLAUDE_IMPLEMENT_1 = [["claude/opus"]];
  const CLAUDE_REWORK_2 = [["claude/opus"], ["claude/sonnet-4-5"]];

  it("opencode rework chain of 2: unchanged semantics — can reach top with maxRounds >= 3", () => {
    const tierCount = effectiveTierCount(OPENCODE_IMPLEMENT_1, "opencode");
    const reworkTierCount = effectiveTierCount(OPENCODE_REWORK_2, "opencode");
    assert.equal(tierCount, 1);
    assert.equal(reworkTierCount, 2, "opencode chains keep their full length");
    // roundsToTopTier = 1 + 2 = 3: the top tier needs three rounds.
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount, reworkKeyConfigured: true, maxRounds: 3 }),
      "Chain c1: tiers=1, reworkTiers=2, maxRounds=3 (can reach top tier)\n");
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount, reworkKeyConfigured: true, maxRounds: 2 }),
      "Chain c1: tiers=1, reworkTiers=2, maxRounds=2 (maxRounds insufficient to reach top tier)\n");
  });

  it("claude-native rework chain of 2: effective tier count is 1 — the claim never exceeds ladderTierCount 1", () => {
    const tierCount = effectiveTierCount(CLAUDE_IMPLEMENT_1, "claude");
    const reworkTierCount = effectiveTierCount(CLAUDE_REWORK_2, "claude");
    assert.equal(tierCount, 1);
    assert.equal(reworkTierCount, 1, "a claude chain counts as one tier");
    // roundsToTopTier = 1 + 1 = 2: maxRounds 2 already reaches the (only)
    // top tier.  The pre-fix code computed roundsToTopTier = 3 from the raw
    // length 2 and falsely claimed the top was unreachable at maxRounds 2.
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount, reworkKeyConfigured: true, maxRounds: 2 }),
      "Chain c1: tiers=1, reworkTiers=1, maxRounds=2 (can reach top tier)\n");
    // At maxRounds 3 the pre-fix banner printed reworkTiers=2 and claimed
    // can-reach-top from a 2-tier ladder the claude backend never walks.
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount, reworkKeyConfigured: true, maxRounds: 3 }),
      "Chain c1: tiers=1, reworkTiers=1, maxRounds=3 (can reach top tier)\n");
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount, reworkKeyConfigured: true, maxRounds: 1 }),
      "Chain c1: tiers=1, reworkTiers=1, maxRounds=1 (maxRounds insufficient to reach top tier)\n");
  });

  it("no rework key: today's banner byte-identical (opencode implement chain of 2)", () => {
    const tierCount = effectiveTierCount(OPENCODE_REWORK_2, "opencode");
    assert.equal(tierCount, 2);
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount: 0, reworkKeyConfigured: false, maxRounds: 3 }),
      "Chain c1: tiers=2, maxRounds=3 (can reach top tier)\n");
  });

  it("no rework key, claude implement chain of 2: the implement surface clamps to one tier too", () => {
    const tierCount = effectiveTierCount(CLAUDE_REWORK_2, "claude");
    assert.equal(tierCount, 1);
    // Pre-fix: tiers=2 with roundsToTopTier=3 — a false claim at maxRounds 2.
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount: 0, reworkKeyConfigured: false, maxRounds: 2 }),
      "Chain c1: tiers=1, maxRounds=2 (can reach top tier)\n");
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount, reworkTierCount: 0, reworkKeyConfigured: false, maxRounds: 3 }),
      "Chain c1: tiers=1, maxRounds=3 (can reach top tier)\n");
  });

  it("no implement chain: no banner line (the caller skips the write)", () => {
    assert.equal(
      renderChainBanner({ chainId: "c1", tierCount: 0, reworkTierCount: 0, reworkKeyConfigured: false, maxRounds: 4 }),
      null);
  });
});


describe("smoke baseline wiring (kusabi #292)", () => {
  const chainCmdSource = fs.readFileSync(path.join(import.meta.dirname, "chain-cmd.mjs"), "utf8");
  const taskCmdSource = fs.readFileSync(path.join(import.meta.dirname, "task-cmd.mjs"), "utf8");

  // The body of the top-level function starting at `anchor`, i.e. up to the
  // next top-level export.
  function functionSource(source, anchor) {
    const start = source.indexOf(anchor);
    assert.ok(start >= 0, `anchor not found: ${anchor}`);
    const end = source.indexOf("\nexport ", start + anchor.length);
    return source.slice(start, end === -1 ? undefined : end);
  }

  // Since kusabi #526 the sequence lives in the reusable runChainLifecycle
  // seam, not in cmdChain (cmdChain is the CLI adapter that delegates).  The
  // ordering property being pinned -- the baseline runs before any chain
  // state is created -- is the same property, asserted against the function
  // that actually owns the sequence.
  it("runChainLifecycle runs the baseline before any chain state is created", () => {
    const body = functionSource(chainCmdSource, "export async function runChainLifecycle(");
    const baselineAt = body.indexOf("smokeBaselineReport(");
    const createAt = body.indexOf("createChainDir(");
    assert.ok(baselineAt > 0, "runChainLifecycle must run the baseline");
    assert.ok(createAt > 0, "runChainLifecycle must still create the chain dir");
    assert.ok(baselineAt < createAt, "the baseline must run before any chain state exists");
  });

  it("cmdChainResume performs no baseline execution", () => {
    // By resume time the worktree carries the previous rounds' changes, so a
    // baseline run there would measure the worker's work and call it the
    // brief's fault.  #250's parse-time check is the only smoke guard on this
    // path.
    const body = functionSource(chainCmdSource, "export async function cmdChainResume(");
    assert.ok(!body.includes("smokeBaselineReport("), "resume must not re-run the baseline");
    assert.ok(body.includes("smokeViolationReport("), "resume keeps the #250 parse check");
    // One call site in the whole driver, and it is cmdChain's.
    assert.equal(chainCmdSource.split("await smokeBaselineReport(").length - 1, 1);
  });

  it("cmdTask runs the baseline before the dispatch", () => {
    const body = taskCmdSource.slice(
      taskCmdSource.indexOf("async function cmdTask("),
      taskCmdSource.indexOf("async function cmdReview("),
    );
    const baselineAt = body.indexOf("smokeBaselineReport(");
    const dispatchAt = body.indexOf("await dispatch({");
    assert.ok(baselineAt > 0, "cmdTask must run the baseline");
    assert.ok(dispatchAt > 0, "cmdTask must still dispatch");
    assert.ok(baselineAt < dispatchAt, "the baseline must run before the job is dispatched");
  });
});



describe("session-provenance wiring (kusabi #321)", () => {
  const chainCmdSource = fs.readFileSync(path.join(import.meta.dirname, "chain-cmd.mjs"), "utf8");

  // The body of the top-level function starting at `anchor`, i.e. up to the
  // next top-level export (same shape as the smoke-baseline wiring block).
  function functionSource(source, anchor) {
    const start = source.indexOf(anchor);
    assert.ok(start >= 0, `anchor not found: ${anchor}`);
    const end = source.indexOf("\nexport ", start + anchor.length);
    return source.slice(start, end === -1 ? undefined : end);
  }

  it("runChainLifecycle refuses before any baseline measurement or chain state exists", () => {
    // Since kusabi #526 the sequence lives in runChainLifecycle, not in
    // cmdChain (cmdChain delegates); the refusal ordering being pinned is
    // the same property, asserted against the function that owns it.
    const body = functionSource(chainCmdSource, "export async function runChainLifecycle(");
    const gateAt = body.indexOf("sessionProvenanceRefusal({");
    assert.ok(gateAt > 0, "runChainLifecycle must call the session-provenance gate");
    assert.ok(gateAt < body.indexOf("smokeBaselineReport("), "the gate precedes the smoke baseline run");
    assert.ok(gateAt < body.indexOf("captureVerifyBaseline("), "the gate precedes the verify baseline");
    assert.ok(gateAt < body.indexOf("createChainDir("), "the gate precedes any chain state");
    // The refusal is thrown, not threaded: the sessionProvenance plumbing
    // into runChainDriver stays exactly as it was.
    assert.ok(gateAt < body.indexOf("runChainDriver({"), "the gate precedes the driver call");
    assert.ok(body.includes("sessionProvenance,"), "sessionProvenance must still reach the driver");
  });

  it("the gate lives in runChainLifecycle, not in the resume path (chain-resume resolves its own session)", () => {
    // kusabi #526 moved the fresh-chain sequence into the runChainLifecycle
    // seam; the property pinned -- the gate exists in chain-cmd for fresh
    // chains only, never in the resume path -- is unchanged.
    const body = functionSource(chainCmdSource, "export async function cmdChainResume(");
    assert.ok(!body.includes("sessionProvenanceRefusal("), "resume must not run the fresh-chain gate");
    assert.ok(chainCmdSource.includes("sessionProvenanceRefusal("), "the gate exists in chain-cmd");
  });
});
// ---------------------------------------------------------------------------
// cmdChain --chain-id (kusabi #514)
// ---------------------------------------------------------------------------
// The chain id becomes a path segment under chains/, so a malformed value is
// refused at the dispatch-refusal stage (before any filesystem write) and a
// supplied id is honoured by createChainDir instead of minting a fresh one.
// These tests use a brief WITHOUT a ## Smoke section: the baseline guard then
// returns null without a single container call (chain-brief-guards.mjs), so
// the refusal paths are reachable with no RPC seam at all.

const CHAIN_BRIEF_NO_SMOKE =
  "# Task\n\nOrchestrator: test-model | session s-1 | 2026-08-23\n\n" +
  "## Deliverables\n\n- `plugins/kusabi/scripts/x.mjs`\n";

describe("cmdChain --chain-id (kusabi #514)", () => {
  const chainCmdSource = fs.readFileSync(path.join(import.meta.dirname, "chain-cmd.mjs"), "utf8");

  function functionSource(source, anchor) {
    const start = source.indexOf(anchor);
    assert.ok(start >= 0, `anchor not found: ${anchor}`);
    const end = source.indexOf("\nexport ", start + anchor.length);
    return source.slice(start, end === -1 ? undefined : end);
  }

  function chainFixture() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-test-chaincmd-"));
    const cwd = path.join(tmp, "ws");
    fs.mkdirSync(cwd, { recursive: true });
    const prevStateEnv = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = path.join(tmp, "state");
    const stateRootDir = path.join(tmp, "state");
    const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    const stateDir = path.join(stateRootDir, hash);
    return {
      tmp,
      cwd,
      stateDir,
      cleanup() {
        if (prevStateEnv === undefined) delete process.env.KUSABI_STATE_DIR;
        else process.env.KUSABI_STATE_DIR = prevStateEnv;
        fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  }

  it("createChainDir honours a supplied id: exactly chains/<id> and no other chain directory", () => {
    const fx = chainFixture();
    try {
      const { chainId, chainDir } = createChainDir(fx.stateDir, "chain-fixed");
      assert.equal(chainId, "chain-fixed");
      assert.equal(chainDir, path.join(fx.stateDir, "chains", "chain-fixed"));
      assert.equal(fs.existsSync(chainDir), true);
      assert.deepEqual(
        fs.readdirSync(path.join(fx.stateDir, "chains")),
        ["chain-fixed"],
        "no other chain directory may exist",
      );
      // The minted path produces a fresh id of the same shape.
      const minted = createChainDir(fx.stateDir);
      assert.match(minted.chainId, /^chain-[a-z0-9]+$/);
      assert.equal(fs.readdirSync(path.join(fx.stateDir, "chains")).length, 2);
    } finally {
      fx.cleanup();
    }
  });

  it("runChainLifecycle threads --chain-id into createChainDir, validated before any filesystem write", () => {
    // kusabi #526 moved the sequence into runChainLifecycle; the property
    // pinned -- the flag is read and validated before any write and reaches
    // createChainDir -- is unchanged, asserted against the owning function.
    const body = functionSource(chainCmdSource, "export async function runChainLifecycle(");
    const flagAt = body.indexOf('flags["chain-id"]');
    const assertAt = body.indexOf("assertChainIdShape(");
    const createAt = body.indexOf("createChainDir(");
    const stateDirAt = body.indexOf("stateDirFor(");
    assert.ok(flagAt > 0, "runChainLifecycle must read the --chain-id flag");
    assert.ok(assertAt > 0, "runChainLifecycle must validate the id shape");
    assert.ok(createAt > 0, "runChainLifecycle must still create the chain dir");
    assert.ok(flagAt < stateDirAt, "the flag is read before any filesystem write");
    assert.ok(assertAt < stateDirAt, "the shape check precedes any filesystem write");
    assert.ok(assertAt < createAt, "the shape check precedes the dir creation");
    assert.ok(
      body.includes("createChainDir(stateDir, chainIdFlag ?? null)"),
      "the supplied id must reach createChainDir",
    );
  });

  it("cmdChain refuses a --chain-id whose directory already exists, with no job and no round state", async () => {
    const fx = chainFixture();
    try {
      const chainsDir = path.join(fx.stateDir, "chains");
      const chainPre = path.join(chainsDir, "chain-pre");
      fs.mkdirSync(chainPre, { recursive: true });
      const control = {
        chainId: "chain-pre", container: "cid-0", pid: 1, status: "running", round: 1,
        startedAt: "2026-08-16T00:00:00.000Z",
      };
      const controlPath = path.join(chainPre, "control.json");
      fs.writeFileSync(controlPath, JSON.stringify(control, null, 2));

      await assert.rejects(
        () =>
          cmdChain(fx.cwd, {
            flags: { container: "cid-1", "chain-id": "chain-pre" },
            text: CHAIN_BRIEF_NO_SMOKE,
          }),
        /chain id already exists: chain-pre/,
      );

      // The existing chain is untouched: no re-use, no rewrite.
      assert.deepEqual(JSON.parse(fs.readFileSync(controlPath, "utf8")), control);
      // No job and no round state were created by the refused invocation.
      assert.deepEqual(
        fs.readdirSync(path.join(fx.stateDir, "jobs")),
        [],
        "no job record may be created by a refused invocation",
      );
      assert.equal(
        fs.existsSync(path.join(chainPre, "chain.json")),
        false,
        "no round state may be created",
      );
      assert.deepEqual(
        fs.readdirSync(chainsDir),
        ["chain-pre"],
        "no other chain directory may be created",
      );
    } finally {
      fx.cleanup();
    }
  });

  it("cmdChain refuses a malformed --chain-id before any filesystem write, parent untouched", async () => {
    for (const bad of ["../escape", "chain-a/b", "nope", ""]) {
      const fx = chainFixture();
      try {
        await assert.rejects(
          () =>
            cmdChain(fx.cwd, {
              flags: { container: "cid-1", "chain-id": bad },
              text: CHAIN_BRIEF_NO_SMOKE,
            }),
          /invalid chain id/,
        );
        // The refusal fires before stateDirFor: nothing at all was written,
        // so the parent of chains/ is untouched — ../escape cannot land
        // anywhere, it never even becomes a string passed to path.join.
        assert.equal(
          fs.existsSync(fx.stateDir),
          false,
          `no state directory may be created for --chain-id ${JSON.stringify(bad)}`,
        );
      } finally {
        fx.cleanup();
      }
    }
  });
});
// ---------------------------------------------------------------------------
// runChainLifecycle (kusabi #526) — the reusable fresh-chain seam
// ---------------------------------------------------------------------------
// cmdChain is now only the CLI adapter: it resolves the brief file and the
// orchestrator record and delegates to runChainLifecycle, which owns the
// whole fresh-chain sequence (publish/brief checks, refusals, backend
// resolution, baselines, chain creation, the driver dispatch and the
// terminal cleanup).  The future mission driver calls the seam directly, so
// the tests here pin (a) that cmdChain really delegates and keeps no second
// copy of the sequence, and (b) that the two entry points are the same path:
// identical returned output and identical durable artifacts on a full chain
// run and on pre-dispatch refusals.

describe("runChainLifecycle seam (kusabi #526)", () => {
  const chainCmdSource = fs.readFileSync(path.join(import.meta.dirname, "chain-cmd.mjs"), "utf8");

  // The body of the top-level function starting at `anchor`, i.e. up to the
  // next top-level export (same shape as the wiring blocks above).
  function functionSource(source, anchor) {
    const start = source.indexOf(anchor);
    assert.ok(start >= 0, `anchor not found: ${anchor}`);
    const end = source.indexOf("\nexport ", start + anchor.length);
    return source.slice(start, end === -1 ? undefined : end);
  }

  it("cmdChain delegates the whole sequence to runChainLifecycle and retains no second copy", () => {
    const cmdBody = functionSource(chainCmdSource, "export async function cmdChain(");
    const lifecycleBody = functionSource(chainCmdSource, "export async function runChainLifecycle(");
    assert.ok(
      cmdBody.includes("runChainLifecycle(cwd, { flags, text, orchestrator }, opts)"),
      "cmdChain must delegate to the lifecycle seam",
    );
    // Every step of the extracted sequence lives in the seam, not in cmdChain.
    for (const marker of [
      "smokeBaselineReport(",
      "createChainDir(",
      "sessionProvenanceRefusal({",
      "captureVerifyBaseline(",
      "runChainDriver({",
    ]) {
      assert.ok(lifecycleBody.includes(marker), `runChainLifecycle must own the extracted sequence (${marker})`);
      assert.ok(
        !cmdBody.includes(marker),
        `cmdChain must not retain a second copy of the extracted sequence (${marker})`,
      );
    }
  });

  // ---- equivalence harness ----
  // Both paths are driven with the SAME injected fakes (test-only injection:
  // the container RPC and the backend dispatch seams; production callers get
  // the real implementations).  Each run gets its own tmp workspace and its
  // own state root so the pinned --chain-id does not collide.
  const BRIEF = "# Task\n\nOrchestrator: test-model | session s-1 | 2026-08-23\n\n## Deliverables\n\n- `src/foo.js`\n";
  const APPROVE = JSON.stringify({
    schema_version: 1, verdict: "approve", findings: [], summary: "ok", next_steps: [],
  });
  const FLAGS = { container: "cid-1", "chain-id": "chain-fixed", "keepServe": true };

  // Normalization for the equivalence assertions (documented):
  //   - ISO timestamps (startedAt / finishedAt / round startedAt ...) vary by
  //     milliseconds between two runs → replaced by "<ts>".
  //   - `pid` values (control.json records process.pid) are identical within
  //     one test process, but are normalized to "<pid>" anyway so the
  //     assertion does not depend on that.
  //   - the returned text embeds the absolute review-record path, which
  //     contains each run's own tmp root AND the state-dir hash derived from
  //     that root's cwd → both are replaced by placeholders (the
  //     chainDir-relative remainder is compared verbatim).
  const ISO_RE = /20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z?/g;

  function normalizeJson(value) {
    if (Array.isArray(value)) return value.map(normalizeJson);
    if (value && typeof value === "object") {
      const out = {};
      for (const key of Object.keys(value).sort()) {
        out[key] = key === "pid" ? "<pid>" : normalizeJson(value[key]);
      }
      return out;
    }
    if (typeof value === "string") return value.replace(ISO_RE, "<ts>");
    return value;
  }

  function fixture() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-lc526-"));
    const cwd = path.join(tmp, "ws");
    fs.mkdirSync(cwd, { recursive: true });
    const prevStateEnv = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = path.join(tmp, "state");
    const hash = crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    const stateDir = path.join(tmp, "state", hash);
    return {
      tmp,
      cwd,
      stateDir,
      chainDir: path.join(stateDir, "chains", "chain-fixed"),
      setStateEnv() {
        process.env.KUSABI_STATE_DIR = path.join(tmp, "state");
      },
      cleanup() {
        if (prevStateEnv === undefined) delete process.env.KUSABI_STATE_DIR;
        else process.env.KUSABI_STATE_DIR = prevStateEnv;
        fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  }

  // Swallow stdout during a run so the banner / publish warning can be
  // compared as a captured value instead of leaking into the test output.
  function captureStdout() {
    const chunks = [];
    const orig = process.stdout.write;
    process.stdout.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    return {
      text() { return chunks.join(""); },
      restore() { process.stdout.write = orig; },
    };
  }

  // The fake container: answers every call a green round-1 chain makes --
  // captureBaseSha / P1 (git rev-parse HEAD), the worktree capture, the
  // verify gate (chain-start baseline + P2), P3's git reads, and the
  // change-scope helper used during review context collection.
  function makeFakeCallTool() {
    return async (toolName, params) => {
      if (toolName === "verify_in_container") return { gate_passed: true };
      if (toolName !== "sandbox_exec") return { output: "" };
      const cmd = params?.commands?.[0] ?? params?.argv?.join(" ") ?? "";
      if (cmd.includes("change-scope.mjs")) {
        return {
          output: JSON.stringify({
            formatVersion: 1,
            repositoryRoot: "/workspace",
            input: { base: "abc123", head: "HEAD" },
            resolved: { baseSha: "abc123", headSha: "abc123", mergeBaseSha: "abc123" },
            paths: { committed: [], staged: [], unstaged: [], untracked: [] },
          }),
        };
      }
      if (cmd.startsWith("cd /workspace &&") && cmd.includes("TMPIDX=")) {
        return { output: "ERROR_NO_INDEX\n" };
      }
      if (cmd === "git rev-parse HEAD") return { output: "abc123\n" };
      if (cmd === "git status --porcelain") return { output: " M src/foo.js\n" };
      if (cmd === "git log --oneline -5") return { output: "abc123 latest change\n" };
      if (cmd === "git diff") return { output: "diff --git a/src/foo.js b/src/foo.js\n" };
      if (cmd === "git ls-files --others --exclude-standard") return { output: "untracked.txt\n" };
      return { output: "" };
    };
  }

  // The fake dispatch: one seam handling every kind the driver can ask for,
  // with deterministic ids / sessions / usage so the persisted records match.
  function makeFakeDispatch() {
    return async (opts) => {
      if (opts.kind === "review") {
        return {
          job: {
            id: "job-rev-1", status: "completed", modelEntry: "opencode/fake-review", modelVariant: null,
            fallbacks: null, sessionID: "ses_rev_1",
            usage: { available: true, input: 2, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: APPROVE,
        };
      }
      if (opts.kind === "task") {
        return {
          job: {
            id: "job-imp-1", status: "completed", modelEntry: "opencode/fake-model", modelVariant: null,
            fallbacks: null, sessionID: "ses_imp_1",
            usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: "implemented",
        };
      }
      if (opts.kind === "strategist") {
        return {
          job: {
            id: "job-strat-1", status: "completed", modelEntry: "opencode/fake-strat", modelVariant: null,
            fallbacks: null, sessionID: "ses_strat_1",
            usage: { available: true, input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
            error: null,
          },
          resultText: "restructure the module",
        };
      }
      throw new Error("unexpected dispatch kind: " + opts.kind);
    };
  }

  function injectable() {
    return {
      inject: {
        callTool: makeFakeCallTool(),
        dispatchWithFallback: makeFakeDispatch(),
        reviewDispatchWithFallback: makeFakeDispatch(),
        reworkDispatchWithFallback: makeFakeDispatch(),
      },
    };
  }

  // Read the durable artifacts of a finished chain -- chain.json,
  // control.json, round-N.json and review-record.md under the chain dir, plus
  // every job.json under the state dir -- normalized for the comparison.
  function readArtifacts(fx) {
    const out = {};
    function walk(dir, prefix) {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const rel = path.join(prefix, name);
        if (fs.statSync(full).isDirectory()) {
          walk(full, rel);
        } else if (name.endsWith(".json")) {
          out[rel] = normalizeJson(JSON.parse(fs.readFileSync(full, "utf8")));
        } else if (name === "review-record.md") {
          out[rel] = fs.readFileSync(full, "utf8").replace(ISO_RE, "<ts>");
        }
      }
    }
    walk(fx.chainDir, "chain");
    const jobsDir = path.join(fx.stateDir, "jobs");
    if (fs.existsSync(jobsDir)) walk(jobsDir, "jobs");
    return out;
  }

  function normalizeReturned(text, fx) {
    return text.replace(fx.stateDir, "<stateDir>").replace(fx.tmp, "<tmp>");
  }

  it("cmdChain and direct runChainLifecycle invocation are the same path on a full success run", async () => {
    const fx1 = fixture();
    const fx2 = fixture();
    try {
      fx1.setStateEnv();
      const cap1 = captureStdout();
      const text1 = await cmdChain(fx1.cwd, { flags: FLAGS, text: BRIEF }, injectable());
      const stdout1 = cap1.text();
      cap1.restore();

      fx2.setStateEnv();
      const cap2 = captureStdout();
      const text2 = await runChainLifecycle(
        fx2.cwd,
        { flags: FLAGS, text: BRIEF, orchestrator: resolveOrchestratorRecord(BRIEF) },
        injectable(),
      );
      const stdout2 = cap2.text();
      cap2.restore();

      // Both runs must have succeeded and reached the same terminal outcome.
      assert.match(text1, /accepted at round 1/);
      assert.match(text2, /accepted at round 1/);
      // Returned output is equivalent up to the inherently variable review-
      // record path prefix (each run's own tmp root); the rest is verbatim.
      assert.equal(normalizeReturned(text1, fx1), normalizeReturned(text2, fx2));
      // stdout (the chain-start banner; the publish warning is absent for a
      // clean brief) is byte-identical.
      assert.equal(stdout1, stdout2);
      // Durable artifacts are key/value identical after timestamp and pid
      // normalization.
      assert.deepEqual(readArtifacts(fx1), readArtifacts(fx2));
    } finally {
      fx1.cleanup();
      fx2.cleanup();
    }
  });

  it("cmdChain and direct runChainLifecycle invocation refuse identically before dispatch", async () => {
    // Lossy-smoke brief: a `## Smoke` heading the parser reads nothing out
    // of → the #250 refusal fires before any filesystem write.
    const lossyBrief = "# Task\n\nOrchestrator: test-model | session s-1 | 2026-08-23\n\n## Deliverables\n\n- `src/foo.js`\n\n## Smoke\n\n- a bullet with no backtick-quoted command\n";
    const fx1 = fixture();
    const fx2 = fixture();
    try {
      fx1.setStateEnv();
      let err1 = null;
      try {
        await cmdChain(fx1.cwd, { flags: { container: "cid-1" }, text: lossyBrief });
      } catch (e) { err1 = e; }

      fx2.setStateEnv();
      let err2 = null;
      try {
        await runChainLifecycle(
          fx2.cwd,
          { flags: { container: "cid-1" }, text: lossyBrief, orchestrator: resolveOrchestratorRecord(lossyBrief) },
        );
      } catch (e) { err2 = e; }

      assert.ok(err1 && err2, "both paths must refuse the lossy-smoke brief");
      assert.equal(err1.message, err2.message);
      assert.match(err1.message, /brief rejected before dispatch/);
      // The refusal fires before stateDirFor: no state root at all.
      assert.equal(fs.existsSync(fx1.stateDir), false, "cmdChain left no state behind");
      assert.equal(fs.existsSync(fx2.stateDir), false, "runChainLifecycle left no state behind");
    } finally {
      fx1.cleanup();
      fx2.cleanup();
    }

    // Missing-container refusal: fires after backend resolution, before the
    // lint and before createChainDir -- the state root may exist (stateDirFor
    // creates the jobs dir) but no chain state and no job may.
    const fx3 = fixture();
    const fx4 = fixture();
    try {
      fx3.setStateEnv();
      let err3 = null;
      try {
        await cmdChain(fx3.cwd, { flags: {}, text: BRIEF });
      } catch (e) { err3 = e; }

      fx4.setStateEnv();
      let err4 = null;
      try {
        await runChainLifecycle(
          fx4.cwd,
          { flags: {}, text: BRIEF, orchestrator: resolveOrchestratorRecord(BRIEF) },
        );
      } catch (e) { err4 = e; }

      assert.ok(err3 && err4, "both paths must refuse a missing container");
      assert.equal(err3.message, err4.message);
      assert.equal(err3.message, "chain requires --container <cid>");
      // No chain state in either root; both have only the empty jobs dir that
      // stateDirFor itself creates.
      assert.equal(fs.existsSync(path.join(fx3.stateDir, "chains")), false);
      assert.equal(fs.existsSync(path.join(fx4.stateDir, "chains")), false);
      assert.deepEqual(fs.readdirSync(path.join(fx3.stateDir, "jobs")), []);
      assert.deepEqual(fs.readdirSync(path.join(fx4.stateDir, "jobs")), []);
    } finally {
      fx3.cleanup();
      fx4.cleanup();
    }
  });
});
