import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFakeCallTool, FAKE_HEAD_SHA } from "./fixtures.mjs";
import {
  publishWarningForBrief,
  smokeBaselineReport,
  smokeViolationReport,
  renderSmokeBaselineReport,
  renderSmokeWrongAnnotationReport,
  renderSmokeDirtReport,
} from "./chain-brief-guards.mjs";
import { runSmokeProbe } from "./chain-phases.mjs";
import { parseSmoke } from "./brief-parsing.mjs";


/** Valid change-scope JSON for driver mocks (kusabi #379). Production must not fabricate this. */
function fakeChangeScopeResult(params) {
  const cmd = params?.commands?.[0] ?? params?.argv?.join(" ") ?? "";
  if (typeof cmd === "string" && cmd.includes("change-scope.mjs")) {
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
  return null;
}


// publishWarningForBrief — chain-start publish guard (kusabi #153)
// ---------------------------------------------------------------------------
// publish is orchestrator-exclusive; a brief that demands it cannot be
// executed by the worker.  The chain prints this warning verbatim at start.
// The exact text is fixed here so the runtime output cannot drift.

describe("publishWarningForBrief", () => {
  it("returns the warning for a brief that demands publish", () => {
    const warning = publishWarningForBrief("## PUBLISH (mandatory)\n\nDo the work.");
    assert.ok(warning, "warning must be non-null");
    assert.match(warning, /publish を要求している/);
    assert.match(warning, /ワーカーは publish できない/);
    assert.match(warning, /オーケストレーター専権/);
  });

  it("returns the warning for inline 'PUBLISH must ...' style demands", () => {
    const warning = publishWarningForBrief("Fix the bug. PUBLISH must happen after the gate.");
    assert.ok(warning);
    assert.match(warning, /オーケストレーター専権/);
  });

  it("returns null when the brief does not demand publish", () => {
    assert.equal(publishWarningForBrief("Implement the feature and verify."), null);
    assert.equal(publishWarningForBrief("publish is orchestrator-exclusive; workers cannot call it."), null);
    assert.equal(publishWarningForBrief(""), null);
  });

  it("is exactly one line (no embedded newlines)", () => {
    const warning = publishWarningForBrief("## PUBLISH (mandatory)");
    assert.equal(warning.split("\n").length, 1);
  });
});

// smokeViolationReport — the chain-start refusal for a `## Smoke` section the
// machine reads differently from what it says (kusabi #250).  Unit suite here
// beside the other smoke refusals; the zero-entries message also carries the
// #302 remedy (an empty section must omit its heading).
describe("smokeViolationReport (kusabi #250)", () => {
  it("offers omitting the heading as a remedy for a zero-entry ## Smoke section", () => {
    const report = smokeViolationReport("## Smoke\n\nRun the usual checks.\n");
    assert.ok(report, "a ## Smoke heading with no entry must be refused");
    assert.match(report, /no smoke entry parsed/);
    // Both remedies are named: fix the entries, or omit the heading.
    assert.match(report, /bullet with a backtick-quoted command/);
    assert.match(report, /delete the heading entirely/);
    assert.match(report, /an empty section must omit its heading/);
    assert.match(report, /kusabi #302/);
  });
});

// =========================================================================
// smoke baseline probe — dispatch is refused when the declared smoke is
// already red (kusabi #292)
// ---------------------------------------------------------------------------
// P4 runs AFTER a round, against the worker's changes.  A `## Smoke` line
// that could not pass BEFORE anything was touched — pre-existing debt in the
// target files, or a command that cannot pass in the probe shell — therefore
// surfaces a full round later and reads exactly like a failed round.  The
// baseline runs the same commands through the same executor on the checkout
// as handed over, and refuses the dispatch instead.
// =========================================================================

describe("smokeBaselineReport (kusabi #292)", () => {
  const SMOKE_BRIEF = "# Task\n\n## Smoke\n\n- `npm test`\n";

  it("executes nothing and returns null when the brief declares no smoke", async () => {
    // The guard only ever guards DECLARED smoke: a brief without the section
    // must reach the worker having spent no container call at all.
    const calls = [];
    const spyCallTool = async (toolName, params) => {
      calls.push([toolName, params]);
      return { output: "" };
    };
    const noSmoke = "Implement X.\n\n## Deliverables\n- src/foo.js\n";
    assert.equal(await smokeBaselineReport({ brief: noSmoke, callTool: spyCallTool, container: "cid" }), null);
    assert.equal(await smokeBaselineReport({ brief: "", callTool: spyCallTool, container: "cid" }), null);
    assert.equal(await smokeBaselineReport({ brief: null, callTool: spyCallTool, container: "cid" }), null);
    assert.deepEqual(calls, [], "no smoke declared must mean no baseline execution");
  });

  it("returns null when the declared smoke is green on the pristine checkout", async () => {
    const report = await smokeBaselineReport({
      brief: SMOKE_BRIEF,
      callTool: createFakeCallTool({ exitCode: 0 }),
      container: "fake-cid",
    });
    assert.equal(report, null);
  });

  it("refuses with the failing command, both exit codes, and the pre-dates statement", async () => {
    const report = await smokeBaselineReport({
      brief: SMOKE_BRIEF,
      callTool: createFakeCallTool({ exitCode: 1, capturedOutput: "1 test failed" }),
      container: "fake-cid",
    });
    assert.ok(report, "a red baseline must produce a refusal");
    assert.match(report, /`npm test`/);
    assert.match(report, /expected exit 0/);
    assert.match(report, /observed exit 1/);
    // The whole point of the refusal: the author must read it as "the brief or
    // the baseline is at fault", never as a worker's failed round.
    assert.match(report, /before any worker change/);
    // The captured output rides along, as it does in the post-round detail —
    // otherwise the author has to re-measure by hand to see why it is red.
    assert.match(report, /1 test failed/);
  });

  it("compares against the declared `exit <N>` expectation", async () => {
    const brief = "## Smoke\n\n- `bash -c 'exit 2'` (exit 2)\n";
    assert.equal(
      await smokeBaselineReport({ brief, callTool: createFakeCallTool({ exitCode: 2 }), container: "cid" }),
      null,
    );
    const report = await smokeBaselineReport({
      brief,
      callTool: createFakeCallTool({ exitCode: 0 }),
      container: "cid",
    });
    assert.ok(report, "exit 0 against a declared exit 2 is still a red baseline");
    assert.match(report, /expected exit 2, observed exit 0/);
  });

  it("does not report an unobservable exit code as a mismatch", async () => {
    const report = await smokeBaselineReport({
      brief: SMOKE_BRIEF,
      callTool: createFakeCallTool({ omitMarker: true }),
      container: "cid",
    });
    assert.ok(report);
    assert.match(report, /exit code could not be observed/);
    assert.ok(!report.includes("observed exit"), report);
  });

  it("reports a timed-out command as timed out, not as an exit code", async () => {
    const report = await smokeBaselineReport({
      brief: SMOKE_BRIEF,
      callTool: createFakeCallTool({ timeoutAsData: true }),
      container: "cid",
    });
    assert.ok(report);
    assert.match(report, /timed out with no exit code/);
    assert.ok(!report.includes("observed exit"), report);
  });

  it("names every failing entry when the brief declares several", async () => {
    const brief = "## Smoke\n\n- `npm test`\n- `npm run lint`\n";
    const report = await smokeBaselineReport({
      brief,
      callTool: createFakeCallTool({ exitCode: 1 }),
      container: "cid",
    });
    assert.ok(report);
    assert.match(report, /`npm test`/);
    assert.match(report, /`npm run lint`/);
  });

  it("agrees with the post-round probe: same executor, same verdict", async () => {
    // The baseline must never be a second opinion about the same command —
    // a baseline green that P4 would call red (or the reverse) would make the
    // refusal untrustworthy in exactly the case it exists for.
    for (const exitCode of [0, 1, 2]) {
      const entries = [{ command: "npm test", expectedExit: 0 }];
      const probe = await runSmokeProbe({
        entries,
        callTool: createFakeCallTool({ exitCode }),
        container: "cid",
        headingPresent: true,
      });
      const report = await smokeBaselineReport({
        brief: SMOKE_BRIEF,
        callTool: createFakeCallTool({ exitCode }),
        container: "cid",
      });
      assert.equal(report === null, probe.passed, `exit ${exitCode}: baseline and P4 disagree`);
    }
  });

  // A fake whose `git status --porcelain` answers are scripted per call; the
  // smoke entry itself is served by createFakeCallTool's routing.  `statuses`
  // holds one porcelain output per git-status call; a "!THROW!" entry makes
  // that call throw, modelling an RPC failure mid-measurement.
  function fakeCallToolWithGitStatus({ exitCode = 0, statuses = [] } = {}) {
    let statusCalls = 0;
    return async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      if (params.commands[0] === "git status --porcelain") {
        const scripted = statuses[statusCalls] ?? "";
        statusCalls++;
        if (scripted === "!THROW!") throw new Error("rpc exploded");
        return { output: scripted };
      }
      return createFakeCallTool({ exitCode })(toolName, params);
    };
  }

  it("refuses a passing smoke that wrote to the worktree, naming what it added", async () => {
    // The baseline runs in the very container the worker is then handed: a
    // green exit code with write side effects is still a refusal, because the
    // dirt would land in the round's diff and review as the worker's work.
    const report = await smokeBaselineReport({
      brief: SMOKE_BRIEF,
      callTool: fakeCallToolWithGitStatus({
        exitCode: 0,
        statuses: ["", "?? coverage/\n M src/generated.js\n"],
      }),
      container: "cid",
    });
    assert.ok(report, "a smoke that dirtied the tree must be refused even though it passed");
    assert.match(report, /modified the worktree/);
    assert.match(report, /\?\? coverage\//);
    assert.match(report, /M src\/generated\.js/);
    assert.match(report, /no job and no round state exist/);
  });

  it("does not refuse a passing smoke that left the worktree unchanged", async () => {
    const report = await smokeBaselineReport({
      brief: SMOKE_BRIEF,
      callTool: fakeCallToolWithGitStatus({ exitCode: 0, statuses: ["", ""] }),
      container: "cid",
    });
    assert.equal(report, null);
  });

  it("refuses when a red smoke also dirtied the tree, naming both", async () => {
    const report = await smokeBaselineReport({
      brief: SMOKE_BRIEF,
      callTool: fakeCallToolWithGitStatus({ exitCode: 1, statuses: ["", "?? build/\n"] }),
      container: "cid",
    });
    assert.ok(report, "a red AND dirtying smoke is refused, with both facts reported");
    assert.match(report, /`npm test`: expected exit 0, observed exit 1/);
    assert.match(report, /modified the worktree/);
    assert.match(report, /\?\? build\//);
  });

  it("refuses when the worktree state cannot be verified after the run", async () => {
    // Fail-closed, like the probe's own "unobservable": a guard whose whole
    // point is that the smoke left no dirt must not silently pass when the
    // measurement that would prove it is unavailable.
    const report = await smokeBaselineReport({
      brief: SMOKE_BRIEF,
      callTool: fakeCallToolWithGitStatus({ exitCode: 0, statuses: ["", "!THROW!"] }),
      container: "cid",
    });
    assert.ok(report, "an unverifiable after-state is a refusal, not a pass");
    assert.match(report, /could not be verified/);
  });

  it("ignores pre-existing dirt the smoke did not add", async () => {
    // The comparison is the delta: whatever the prepared container already
    // carried is not this smoke's doing, and not this refusal's business.
    const report = await smokeBaselineReport({
      brief: SMOKE_BRIEF,
      callTool: fakeCallToolWithGitStatus({ exitCode: 0, statuses: [" M pre.js\n", " M pre.js\n"] }),
      container: "cid",
    });
    assert.equal(report, null);
  });
});

describe("smokeBaselineReport baseline-red (kusabi #315)", () => {
  // A fake that scripts each smoke entry's outcome by command fragment, plus
  // the guard's git status/HEAD reads like the other container-state fakes.
  // `map` maps a command substring to a scripted outcome: a number (exit
  // code), "timeout" (the command times out as data), or "unobservable" (the
  // marker is never emitted).  `statuses` scripts one `git status
  // --porcelain` output per call.
  function fakeCallToolBySmoke({ map, statuses = [] } = {}) {
    let statusCalls = 0;
    return async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const scope = fakeChangeScopeResult(params);
      if (scope) return scope;
      const cmd = params.commands[0];
      if (cmd === "git status --porcelain") {
        const scripted = statuses[statusCalls] ?? "";
        statusCalls++;
        return { output: scripted };
      }
      if (cmd === "git rev-parse HEAD") {
        return { output: FAKE_HEAD_SHA + "\n" };
      }
      if (cmd.includes("SMOKE_EXIT=")) {
        for (const [frag, outcome] of Object.entries(map)) {
          if (!cmd.includes(frag)) continue;
          if (outcome === "timeout") return { status: "timeout", output: "", exit_code: 124 };
          if (outcome === "unobservable") return { output: "some unrelated output\n" };
          return { output: "SMOKE_EXIT=" + outcome + "\n" };
        }
      }
      return { output: "" };
    };
  }

  const ANNOTATED_BRIEF = "# Task\n\n## Smoke\n\n- `node --check ui/app.js` baseline-red\n";

  it("dispatches when a baseline-red entry is red at base", async () => {
    // The case #292 was built to refuse is precisely the task here: the
    // smoke targets a deliverable the brief asks the worker to create, so
    // red-at-base is the definition of the job, not a defect.
    const report = await smokeBaselineReport({
      brief: ANNOTATED_BRIEF,
      callTool: fakeCallToolBySmoke({ map: { "ui/app.js": 1 } }),
      container: "cid",
    });
    assert.equal(report, null);
  });

  it("dispatches when baseline-red entries are red at base against declared exits", async () => {
    // Composition, both orders: `exit <N>` says what the entry must return
    // AFTER the round; `baseline-red` says what it is expected to do BEFORE
    // it.  Each annotated entry must be red against ITS OWN expectation.
    const brief = "## Smoke\n\n- `test -f out/report.txt` baseline-red exit 0\n- `node --check ui/app.js` exit 2 baseline-red\n";
    const report = await smokeBaselineReport({
      brief,
      callTool: fakeCallToolBySmoke({ map: { "out/report.txt": 1, "ui/app.js": 1 } }),
      container: "cid",
    });
    assert.equal(report, null);
  });

  it("refuses a baseline-red entry that is green at base, naming it with its own message", async () => {
    // The point of an explicit annotation rather than a silent exemption: an
    // entry declared to target something that does not exist yet, which
    // already passes, is a stale brief or an already-present deliverable —
    // the one place the baseline run can catch it cheaply.
    const report = await smokeBaselineReport({
      brief: ANNOTATED_BRIEF,
      callTool: fakeCallToolBySmoke({ map: { "ui/app.js": 0 } }),
      container: "cid",
    });
    assert.ok(report, "a green annotated entry must be refused");
    assert.match(report, /`node --check ui\/app\.js`/);
    assert.match(report, /declared baseline-red but already passes/);
    // Its own message: the already-red refusal's remedy (fix the command or
    // the baseline it measures) is the opposite of the right one here, so
    // that wording must not be reused.
    assert.doesNotMatch(report, /already red on the checkout/);
    assert.doesNotMatch(report, /Fix the brief's smoke command/);
    assert.match(report, /Drop the annotation, or fix the brief/);
    assert.match(report, /no job and no round state exist/);
  });

  it("refuses a baseline-red entry whose declared exit it already meets", async () => {
    // Composition, wrong direction: `exit 2` declared and exit 2 observed at
    // base means the annotated claim is already false.
    const brief = "## Smoke\n\n- `node --check ui/app.js` exit 2 baseline-red\n";
    const report = await smokeBaselineReport({
      brief,
      callTool: fakeCallToolBySmoke({ map: { "ui/app.js": 2 } }),
      container: "cid",
    });
    assert.ok(report);
    assert.match(report, /declared baseline-red but already passes with exit 2/);
  });

  it("names a genuine already-red entry and a wrongly-annotated entry together", async () => {
    // A brief mixing both failure kinds reports both, each under its own
    // header — never one hiding the other.
    const brief = "## Smoke\n\n- `npm test`\n- `node --check ui/app.js` baseline-red\n";
    const report = await smokeBaselineReport({
      brief,
      callTool: fakeCallToolBySmoke({ map: { "npm test": 1, "ui/app.js": 0 } }),
      container: "cid",
    });
    assert.ok(report);
    assert.match(report, /already red on the checkout as handed to the worker/);
    assert.match(report, /`npm test`: expected exit 0, observed exit 1/);
    assert.match(report, /declared baseline-red but already passes/);
    assert.match(report, /`node --check ui\/app\.js`/);
  });

  it("still refuses an annotated entry that times out at base (fail closed)", async () => {
    // The annotation licenses a measured mismatch, nothing else: a hang is
    // not a clean failure with an exit code, and it would hang P4 after the
    // round too — so it is refused like an unannotated timeout.
    const report = await smokeBaselineReport({
      brief: ANNOTATED_BRIEF,
      callTool: fakeCallToolBySmoke({ map: { "ui/app.js": "timeout" } }),
      container: "cid",
    });
    assert.ok(report, "a timeout must not be licensed by the annotation");
    assert.match(report, /timed out with no exit code/);
    assert.match(report, /declared baseline-red: the annotation covers a measured exit-code mismatch/);
  });

  it("still refuses an annotated entry that cannot be measured (fail closed)", async () => {
    const report = await smokeBaselineReport({
      brief: ANNOTATED_BRIEF,
      callTool: fakeCallToolBySmoke({ map: { "ui/app.js": "unobservable" } }),
      container: "cid",
    });
    assert.ok(report, "an unmeasurable annotated entry must be refused, not passed");
    assert.match(report, /could not be measured/);
    assert.match(report, /exit code could not be observed/);
    assert.match(report, /declared baseline-red: the annotation covers a measured exit-code mismatch/);
  });

  it("the annotation licenses neither dirt nor a moved HEAD", async () => {
    // Red at base as declared, but the run dirtied the tree: the dirt guard
    // still refuses — the annotation covers the exit code, nothing else.
    const report = await smokeBaselineReport({
      brief: ANNOTATED_BRIEF,
      callTool: fakeCallToolBySmoke({ map: { "ui/app.js": 1 }, statuses: ["", "?? coverage/\n"] }),
      container: "cid",
    });
    assert.ok(report, "dirt is refused even when the smoke was red at base as declared");
    assert.doesNotMatch(report, /declared baseline-red but already passes/);
    assert.match(report, /modified the worktree/);
    assert.match(report, /\?\? coverage\//);
  });

  it("the post-round probe treats an annotated entry exactly like any other", async () => {
    // The annotation licenses red AT BASE only; after the round, P4's rules
    // are unchanged: a red annotated entry still fails the probe, a green
    // one still passes it.
    const entries = parseSmoke(ANNOTATED_BRIEF);
    assert.equal(entries[0].baselineRed, true, "the fixture must actually be annotated");
    const redAfter = await runSmokeProbe({
      entries,
      callTool: createFakeCallTool({ exitCode: 1 }),
      container: "cid",
      headingPresent: true,
    });
    assert.equal(redAfter.passed, false, "red after the round is still a probe failure");
    const greenAfter = await runSmokeProbe({
      entries,
      callTool: createFakeCallTool({ exitCode: 0 }),
      container: "cid",
      headingPresent: true,
    });
    assert.equal(greenAfter.passed, true, "green after the round is still a probe pass");
  });
});

describe("renderSmokeWrongAnnotationReport (kusabi #315)", () => {
  it("returns null when every annotated entry was red at base", () => {
    assert.equal(renderSmokeWrongAnnotationReport({
      entries: [{ command: "ui/app.js", expectedExit: 0, baselineRed: true }],
      observed: [{ command: "ui/app.js", observed: 1 }],
    }), null);
  });

  it("returns null for an annotated entry that was never measured", () => {
    // Unmeasured observations belong to the ordinary renderer's refusal;
    // calling the annotation stale needs a measured green.
    assert.equal(renderSmokeWrongAnnotationReport({
      entries: [{ command: "ui/app.js", expectedExit: 0, baselineRed: true }],
      observed: [{ command: "ui/app.js", observed: "unobservable" }],
    }), null);
  });

  it("names a green annotated entry under its own header", () => {
    const report = renderSmokeWrongAnnotationReport({
      entries: [
        { command: "ui/app.js", expectedExit: 0, baselineRed: true },
        { command: "npm test", expectedExit: 0 },
      ],
      observed: [
        { command: "ui/app.js", observed: 0 },
        { command: "npm test", observed: 1 },
      ],
    });
    assert.ok(report);
    assert.match(report, /`ui\/app\.js`: declared baseline-red but already passes with exit 0/);
    assert.doesNotMatch(report, /npm test/, "unannotated entries are the other renderer's business");
    assert.doesNotMatch(report, /already red on the checkout/, "its own message, never the already-red one");
    assert.match(report, /Drop the annotation, or fix the brief/);
  });

  it("names every green annotated entry, and only those", () => {
    const report = renderSmokeWrongAnnotationReport({
      entries: [
        { command: "a", expectedExit: 0, baselineRed: true },
        { command: "b", expectedExit: 0, baselineRed: true },
      ],
      observed: [
        { command: "a", observed: 0 },
        { command: "b", observed: 1 },
      ],
    });
    assert.match(report, /`a`: declared baseline-red but already passes/);
    assert.doesNotMatch(report, /`b`/, "a red-at-base annotated entry is not named");
  });
});

describe("renderSmokeBaselineReport baseline-red awareness (kusabi #315)", () => {
  it("keeps a measured red-at-base mismatch of an annotated entry out of the refusal", () => {
    assert.equal(renderSmokeBaselineReport({
      entries: [
        { command: "ui/app.js", expectedExit: 0, baselineRed: true },
        { command: "npm test", expectedExit: 0 },
      ],
      observed: [
        { command: "ui/app.js", observed: 1 },
        { command: "npm test", observed: 0 },
      ],
    }), null);
  });

  it("refuses an annotated entry whose observation is not a number, with the suffix", () => {
    const report = renderSmokeBaselineReport({
      entries: [{ command: "ui/app.js", expectedExit: 0, baselineRed: true }],
      observed: [{ command: "ui/app.js", observed: "timeout" }],
    });
    assert.ok(report);
    assert.match(report, /`ui\/app\.js`: expected exit 0, timed out with no exit code/);
    assert.match(report, /declared baseline-red: the annotation covers a measured exit-code mismatch/);
  });
});

describe("renderSmokeDirtReport (kusabi #292)", () => {
  const ok = (lines) => ({ ok: true, lines });

  it("returns null when both captures are clean", () => {
    assert.equal(renderSmokeDirtReport({ before: ok([]), after: ok([]) }), null);
  });

  it("names every line the smoke added and only those", () => {
    const report = renderSmokeDirtReport({
      before: ok([" M pre-existing.js"]),
      after: ok([" M pre-existing.js", "?? coverage/", " M src/generated.js"]),
    });
    assert.ok(report);
    assert.match(report, /\?\? coverage\//);
    assert.match(report, /M src\/generated\.js/);
    assert.doesNotMatch(report, /pre-existing/);
  });

  it("reports a failed capture as unverifiable, with the reason", () => {
    const report = renderSmokeDirtReport({
      before: { ok: false, reason: "git status could not be run: boom" },
      after: ok([]),
    });
    assert.ok(report);
    assert.match(report, /could not be verified/);
    assert.match(report, /boom/);
  });

  it("treats missing captures defensively as failures", () => {
    const report = renderSmokeDirtReport({ before: undefined, after: null });
    assert.ok(report);
    assert.match(report, /could not be verified/);
    assert.match(report, /pre-run git status capture failed/);
    assert.match(report, /post-run git status capture failed/);
  });
});

// =========================================================================
// the baseline's HEAD guard (kusabi #292 follow-up)
// ---------------------------------------------------------------------------
// `git status --porcelain` cannot see a HEAD move: a smoke that commits, or
// checks out another SHA, leaves a listing identical to the one taken before
// it ran, so the dirt guard passes it.  captureBaseSha runs AFTER the
// baseline, so that moved HEAD then becomes the chain's recorded base and
// every later comparison silently measures the wrong tree.  HEAD is therefore
// captured beside the listing, in the same before/after pair, and a move is
// refused in the same shape as dirt.
// =========================================================================

describe("renderSmokeDirtReport HEAD guard (kusabi #292 follow-up)", () => {
  const at = (head, lines = []) => ({ ok: true, lines, head });

  it("returns null when HEAD is where it was, with a clean listing", () => {
    assert.equal(renderSmokeDirtReport({ before: at("abc123"), after: at("abc123") }), null);
  });

  it("refuses when HEAD moved, naming both SHAs and not claiming dirt", () => {
    const report = renderSmokeDirtReport({ before: at("abc123"), after: at("def456") });
    assert.ok(report, "a moved HEAD must be refused even with an identical listing");
    assert.match(report, /moved HEAD/);
    assert.match(report, /abc123/);
    assert.match(report, /def456/);
    assert.match(report, /no job and no round state exist/);
    // The listing WAS clean; saying otherwise would send the author hunting
    // for files the smoke never wrote.
    assert.doesNotMatch(report, /modified the worktree/);
  });

  it("names the base-SHA consequence, not just the move", () => {
    // The refusal has to explain why a moved HEAD is worse than it looks: the
    // chain's base is captured after the baseline, so nothing downstream ever
    // reports this as wrong.
    const report = renderSmokeDirtReport({ before: at("abc123"), after: at("def456") });
    assert.match(report, /base SHA is captured after the baseline/);
  });

  it("reports a moved HEAD and added dirt as two separate refusals", () => {
    const report = renderSmokeDirtReport({
      before: at("abc123", [" M pre.js"]),
      after: at("def456", [" M pre.js", "?? coverage/"]),
    });
    assert.ok(report);
    assert.match(report, /moved HEAD/);
    assert.match(report, /modified the worktree/);
    assert.match(report, /\?\? coverage\//);
    assert.doesNotMatch(report, /pre\.js/);
  });

  it("reports an unreadable HEAD as unverifiable, with the reason", () => {
    const report = renderSmokeDirtReport({
      before: at("abc123"),
      after: { ok: false, reason: "git rev-parse HEAD could not be run: boom" },
    });
    assert.ok(report, "an unreadable HEAD is a refusal, not a pass");
    assert.match(report, /could not be verified/);
    assert.match(report, /git rev-parse HEAD could not be run: boom/);
  });
});

describe("smokeBaselineReport HEAD guard (kusabi #292 follow-up)", () => {
  const SMOKE_BRIEF = "# Task\n\n## Smoke\n\n- `npm test`\n";

  // Scripts both halves of the guard's capture pair.  `statuses` holds one
  // `git status --porcelain` output per call, `heads` one `git rev-parse HEAD`
  // output per call; a "!THROW!" entry makes that call throw, modelling an RPC
  // failure mid-measurement.  Unscripted calls fall through to
  // createFakeCallTool, which reports FAKE_HEAD_SHA every time -- a container
  // whose HEAD did not move.
  function fakeCallToolWithContainerState({ exitCode = 0, statuses = [], heads = [] } = {}) {
    let statusCalls = 0;
    let headCalls = 0;
    return async (toolName, params) => {
      if (toolName !== "sandbox_exec") return { output: "" };
      const scope = fakeChangeScopeResult(params);
      if (scope) return scope;
      const cmd = params.commands[0];
      if (cmd === "git status --porcelain") {
        const scripted = statuses[statusCalls] ?? "";
        statusCalls++;
        if (scripted === "!THROW!") throw new Error("status rpc exploded");
        return { output: scripted };
      }
      if (cmd === "git rev-parse HEAD" && headCalls < heads.length) {
        const scripted = heads[headCalls];
        headCalls++;
        if (scripted === "!THROW!") throw new Error("rev-parse rpc exploded");
        return { output: scripted };
      }
      return createFakeCallTool({ exitCode })(toolName, params);
    };
  }

  it("refuses a green smoke that moved HEAD while leaving the listing clean", async () => {
    const report = await smokeBaselineReport({
      brief: SMOKE_BRIEF,
      callTool: fakeCallToolWithContainerState({
        exitCode: 0,
        statuses: ["", ""],
        heads: ["aaa111\n", "bbb222\n"],
      }),
      container: "cid",
    });
    assert.ok(report, "a smoke that committed must be refused even though nothing is dirty");
    assert.match(report, /moved HEAD/);
    assert.match(report, /aaa111/);
    assert.match(report, /bbb222/);
    assert.match(report, /no job and no round state exist/);
    assert.doesNotMatch(report, /modified the worktree/);
  });

  it("does not refuse a green smoke that left both the listing and HEAD alone", async () => {
    const report = await smokeBaselineReport({
      brief: SMOKE_BRIEF,
      callTool: fakeCallToolWithContainerState({
        exitCode: 0,
        statuses: [" M pre.js\n", " M pre.js\n"],
        heads: [`${FAKE_HEAD_SHA}\n`, `${FAKE_HEAD_SHA}\n`],
      }),
      container: "cid",
    });
    assert.equal(report, null);
  });

  it("refuses when the pre-run HEAD read fails", async () => {
    const report = await smokeBaselineReport({
      brief: SMOKE_BRIEF,
      callTool: fakeCallToolWithContainerState({ exitCode: 0, heads: ["!THROW!"] }),
      container: "cid",
    });
    assert.ok(report, "an unread HEAD is a refusal, not a pass");
    assert.match(report, /could not be verified/);
    assert.match(report, /rev-parse rpc exploded/);
  });

  it("refuses when the post-run HEAD read fails", async () => {
    const report = await smokeBaselineReport({
      brief: SMOKE_BRIEF,
      callTool: fakeCallToolWithContainerState({ exitCode: 0, heads: ["aaa111\n", "!THROW!"] }),
      container: "cid",
    });
    assert.ok(report);
    assert.match(report, /could not be verified/);
    assert.match(report, /rev-parse rpc exploded/);
  });

  it("refuses when the HEAD read comes back empty", async () => {
    // A working `git rev-parse HEAD` always prints a SHA, so an empty answer
    // is a failed measurement -- not a HEAD that happens to equal the other
    // empty answer, which is how a "" == "" comparison would read it.
    const report = await smokeBaselineReport({
      brief: SMOKE_BRIEF,
      callTool: fakeCallToolWithContainerState({ exitCode: 0, heads: ["", ""] }),
      container: "cid",
    });
    assert.ok(report, "an empty HEAD read must not be compared as if it were a SHA");
    assert.match(report, /could not be verified/);
    assert.match(report, /no SHA/);
  });
});

describe("smoke baseline refusal wording: red vs unmeasurable (kusabi #292 follow-up)", () => {
  const SMOKE_BRIEF = "# Task\n\n## Smoke\n\n- `npm test`\n";
  const FIX_THE_BRIEF = /Fix the brief's smoke command/;

  it("keeps the fix-the-brief wording for a command that ran and exited wrong", () => {
    const report = renderSmokeBaselineReport({
      entries: [{ command: "npm test", expectedExit: 0 }],
      observed: [{ command: "npm test", observed: 1 }],
    });
    assert.match(report, /is already red on the checkout as handed to the worker/);
    assert.match(report, FIX_THE_BRIEF);
  });

  it("keeps the fix-the-brief wording for a command that ran and timed out", () => {
    // A timeout is a fact about the command: it WAS executed, it simply never
    // finished.  That is the brief's smoke line (or the checkout) to fix.
    const report = renderSmokeBaselineReport({
      entries: [{ command: "npm test", expectedExit: 0 }],
      observed: [{ command: "npm test", observed: "timeout" }],
    });
    assert.match(report, FIX_THE_BRIEF);
  });

  it("does not blame the brief when the call itself threw", () => {
    // Nothing was learned about the command, so telling the author to go and
    // rewrite a smoke line that may be perfectly correct is a wrong
    // accusation -- and sends them to the wrong place while the container is
    // the thing that is broken.
    const report = renderSmokeBaselineReport({
      entries: [{ command: "npm test", expectedExit: 0 }],
      observed: [{ command: "npm test", observed: "Error: rpc exploded" }],
    });
    assert.ok(report);
    assert.doesNotMatch(report, FIX_THE_BRIEF);
    assert.match(report, /could not be measured/);
    assert.match(report, /container or infrastructure failure/);
    assert.match(report, /Check the container/);
    // The failure itself is still named, per entry, exactly as before.
    assert.match(report, /`npm test`: expected exit 0, could not be run: Error: rpc exploded/);
  });

  it("does not blame the brief when the exit code never came back", () => {
    const report = renderSmokeBaselineReport({
      entries: [{ command: "npm test", expectedExit: 0 }],
      observed: [{ command: "npm test", observed: "unobservable" }],
    });
    assert.doesNotMatch(report, FIX_THE_BRIEF);
    assert.match(report, /could not be measured/);
  });

  it("does not blame the brief when the entry was never executed", () => {
    const report = renderSmokeBaselineReport({
      entries: [{ command: "npm test", expectedExit: 0 }],
      observed: [],
    });
    assert.doesNotMatch(report, FIX_THE_BRIEF);
    assert.match(report, /not executed/);
  });

  it("keeps the fix-the-brief wording when one entry ran red and another could not be measured", () => {
    // A genuinely red command IS present, so the author's fix list starts
    // there; the unmeasured entry is still named on its own line.
    const report = renderSmokeBaselineReport({
      entries: [
        { command: "npm test", expectedExit: 0 },
        { command: "npm run lint", expectedExit: 0 },
      ],
      observed: [
        { command: "npm test", observed: 1 },
        { command: "npm run lint", observed: "Error: rpc exploded" },
      ],
    });
    assert.match(report, FIX_THE_BRIEF);
    assert.match(report, /`npm test`: expected exit 0, observed exit 1/);
    assert.match(report, /`npm run lint`: expected exit 0, could not be run: Error: rpc exploded/);
  });

  it("carries the split wording through the baseline run itself", async () => {
    const red = await smokeBaselineReport({
      brief: SMOKE_BRIEF,
      callTool: createFakeCallTool({ exitCode: 1 }),
      container: "cid",
    });
    assert.match(red, FIX_THE_BRIEF);

    const unmeasured = await smokeBaselineReport({
      brief: SMOKE_BRIEF,
      callTool: createFakeCallTool({ omitMarker: true }),
      container: "cid",
    });
    assert.ok(unmeasured, "an unmeasurable baseline is still a refusal");
    assert.doesNotMatch(unmeasured, FIX_THE_BRIEF);
    assert.match(unmeasured, /could not be measured/);
    assert.match(unmeasured, /exit code could not be observed/);
  });
});

describe("renderSmokeBaselineReport (kusabi #292)", () => {
  it("returns null when every entry met its expectation", () => {
    assert.equal(renderSmokeBaselineReport({
      entries: [{ command: "npm test", expectedExit: 0 }],
      observed: [{ command: "npm test", observed: 0 }],
    }), null);
    assert.equal(renderSmokeBaselineReport({ entries: [], observed: [] }), null);
  });

  it("reports an entry with no observation as not executed", () => {
    const report = renderSmokeBaselineReport({
      entries: [{ command: "npm test", expectedExit: 0 }],
      observed: [],
    });
    assert.match(report, /`npm test`: expected exit 0, not executed/);
  });

  it("keeps a passing entry out of the refusal", () => {
    const report = renderSmokeBaselineReport({
      entries: [
        { command: "npm test", expectedExit: 0 },
        { command: "npm run lint", expectedExit: 0 },
      ],
      observed: [
        { command: "npm test", observed: 0 },
        { command: "npm run lint", observed: 2 },
      ],
    });
    assert.doesNotMatch(report, /npm test/);
    assert.match(report, /`npm run lint`: expected exit 0, observed exit 2/);
  });
});
