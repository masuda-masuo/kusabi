import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  DISPOSITIONS,
  DISPOSITION_ORDER,
  extractRoundDisposition,
  normalizeDisposition,
  createDispositionCounts,
  findFinalRound,
  finalDisposition,
  createEscalateSplit,
  classifyEscalate,
  recordEscalate,
  parseTimeBound,
  parseLenientTimeBound,
  instantInWindow,
  chainWindowKeyMs,
  chainInWindow,
  turnInWindow,
  jobWindowKeyMs,
  jobInWindow,
  roundPassesTimeFilter,
  SEVERITY_ORDER,
  KNOWN_SEVERITIES,
  extractRoundFindingsText,
  hasPriorUnresolvedFinding,
  computeDispositionSeverity,
  computeReviewPathology,
  emptyReviewPathology,
} from "./chain-metrics-core.mjs";

import { computeStats, renderChainStats } from "./chain-stats.mjs";
import { computeReport } from "./metrics-report.mjs";
import { renderReportText, renderReportJson } from "./metrics-render.mjs";
import {
  openMetricsDb,
  upsertSession,
  upsertTurn,
  upsertChain,
  upsertRound,
  upsertFinding,
} from "./metrics-db.mjs";

describe("chain-metrics-core", () => {
  describe("dispositions and vocabulary", () => {
    it("exposes expected DISPOSITIONS set and DISPOSITION_ORDER array", () => {
      assert.ok(DISPOSITIONS instanceof Set);
      assert.equal(DISPOSITIONS.size, 6);
      assert.ok(DISPOSITIONS.has("accept"));
      assert.ok(DISPOSITIONS.has("accept-with-followup"));
      assert.ok(DISPOSITIONS.has("rework"));
      assert.ok(DISPOSITIONS.has("strategize"));
      assert.ok(DISPOSITIONS.has("escalate"));
      assert.ok(DISPOSITIONS.has("discard"));

      assert.deepEqual(DISPOSITION_ORDER, [
        "accept",
        "accept-with-followup",
        "escalate",
        "rework",
        "strategize",
        "discard",
      ]);
    });

    it("normalizes known, unknown, and empty dispositions", () => {
      assert.equal(normalizeDisposition("accept"), "accept");
      assert.equal(normalizeDisposition("escalate"), "escalate");
      assert.equal(normalizeDisposition("custom-disp"), "other");
      assert.equal(normalizeDisposition("unrecognized"), "other");
      assert.equal(normalizeDisposition(null), null);
      assert.equal(normalizeDisposition(undefined), null);
      assert.equal(normalizeDisposition(""), null);
    });

    it("creates standard disposition counts", () => {
      const counts = createDispositionCounts();
      assert.deepEqual(counts, {
        accept: 0,
        "accept-with-followup": 0,
        rework: 0,
        strategize: 0,
        escalate: 0,
        discard: 0,
        other: 0,
      });
    });

    it("extracts disposition from raw JSON records and SQL rows", () => {
      // Raw JSON round record: { disposition: { disposition: "accept" } }
      assert.equal(extractRoundDisposition({ disposition: { disposition: "accept" } }), "accept");
      // Normalized SQL round row: { disposition: "rework" }
      assert.equal(extractRoundDisposition({ disposition: "rework" }), "rework");
      // Direct string property
      assert.equal(extractRoundDisposition({ disposition: "escalate" }), "escalate");
      // Missing or malformed
      assert.equal(extractRoundDisposition({}), null);
      assert.equal(extractRoundDisposition({ disposition: null }), null);
      assert.equal(extractRoundDisposition({ disposition: {} }), null);
      assert.equal(extractRoundDisposition(null), null);
      assert.equal(extractRoundDisposition(undefined), null);
    });
  });

  describe("findFinalRound and finalDisposition", () => {
    it("selects last array entry for unnumbered rounds", () => {
      const unnumbered = [
        { disposition: { disposition: "accept" } },
        { disposition: { disposition: "rework" } },
        { disposition: { disposition: "discard" } },
      ];
      const finalRound = findFinalRound(unnumbered);
      assert.equal(finalRound, unnumbered[2]);
      assert.equal(finalDisposition(unnumbered), "discard");
    });

    it("selects max round entry for numbered rounds, preserving established behavior even if out of order", () => {
      const numberedInOrder = [
        { round: 1, disposition: "rework" },
        { round: 2, disposition: "accept" },
      ];
      assert.equal(findFinalRound(numberedInOrder), numberedInOrder[1]);
      assert.equal(finalDisposition(numberedInOrder), "accept");

      const numberedOutOfOrder = [
        { round: 3, disposition: "accept-with-followup" },
        { round: 1, disposition: "rework" },
        { round: 2, disposition: "escalate" },
      ];
      assert.equal(findFinalRound(numberedOutOfOrder), numberedOutOfOrder[0]);
      assert.equal(finalDisposition(numberedOutOfOrder), "accept-with-followup");
    });

    it("supports round 0 and handles empty or non-array inputs", () => {
      const roundZero = [{ round: 0, disposition: "strategize" }];
      assert.equal(findFinalRound(roundZero), roundZero[0]);
      assert.equal(finalDisposition(roundZero), "strategize");

      assert.equal(findFinalRound([]), null);
      assert.equal(findFinalRound(null), null);
      assert.equal(findFinalRound(undefined), null);
      assert.equal(finalDisposition([]), null);
      assert.equal(finalDisposition(null), null);
    });

    it("supports (chainId, roundsByChain Map or Object) calling convention", () => {
      const roundsMap = new Map([
        ["c-1", [{ round: 1, disposition: "rework" }, { round: 2, disposition: "accept" }]],
        ["c-2", [{ disposition: { disposition: "escalate" } }]],
      ]);
      assert.equal(finalDisposition("c-1", roundsMap), "accept");
      assert.equal(finalDisposition("c-2", roundsMap), "escalate");
      assert.equal(finalDisposition("c-nonexistent", roundsMap), null);

      const roundsObj = {
        "c-3": [{ round: 1, disposition: "custom-status" }],
      };
      assert.equal(finalDisposition("c-3", roundsObj), "other");
    });
  });

  describe("escalate split", () => {
    it("creates escalate split objects with or without escalated total counter", () => {
      assert.deepEqual(createEscalateSplit(), { substantive: 0, noWork: 0, unknown: 0 });
      assert.deepEqual(createEscalateSplit({ includeEscalated: true }), {
        escalated: 0,
        substantive: 0,
        noWork: 0,
        unknown: 0,
      });
    });

    it("classifies escalate across raw JSON records and SQL row shapes", () => {
      // Raw JSON: worktreeChanged boolean
      assert.equal(classifyEscalate([{ worktreeChanged: true }]), "substantive");
      assert.equal(classifyEscalate([{ worktreeChanged: false }]), "no-work");
      assert.equal(classifyEscalate([{ worktreeChanged: null }]), "unknown");

      // Stop reasons on JSON
      assert.equal(classifyEscalate([{ stopReason: "completed", worktreeChanged: true }]), "substantive");
      assert.equal(classifyEscalate([{ stopReason: "completed", worktreeChanged: false }]), "no-work");
      assert.equal(classifyEscalate([{ stopReason: "provider-error", worktreeChanged: true }]), "no-work");

      // SQL rows: worktree_changed integer.  The SQL path does not consult
      // stop_reason today, so a non-completed SQL round still classifies by
      // worktree_changed alone — unlike the raw JSON path above.  That
      // divergence between the two report surfaces is pinned here as-is and
      // tracked in kusabi #647; this refactor must not change report output.
      assert.equal(classifyEscalate([{ worktree_changed: 1 }]), "substantive");
      assert.equal(classifyEscalate([{ worktree_changed: 0 }]), "no-work");
      assert.equal(classifyEscalate([{ stop_reason: "completed", worktree_changed: 1 }]), "substantive");
      assert.equal(classifyEscalate([{ stop_reason: "infra-death", worktree_changed: 1 }]), "substantive");
    });

    it("records escalate correctly into split objects", () => {
      const splitWithTotal = createEscalateSplit({ includeEscalated: true });
      const label1 = recordEscalate(splitWithTotal, [{ worktreeChanged: true }]);
      assert.equal(label1, "substantive");
      assert.deepEqual(splitWithTotal, { escalated: 1, substantive: 1, noWork: 0, unknown: 0 });

      const splitWithoutTotal = createEscalateSplit();
      const label2 = recordEscalate(splitWithoutTotal, [{ worktreeChanged: false }]);
      assert.equal(label2, "no-work");
      assert.deepEqual(splitWithoutTotal, { substantive: 0, noWork: 1, unknown: 0 });
    });
  });

  describe("time-window scoping helpers", () => {
    it("parses time bounds strictly with parseTimeBound", () => {
      assert.equal(parseTimeBound(undefined, "--since"), undefined);
      assert.equal(parseTimeBound(null, "--since"), undefined);
      assert.equal(parseTimeBound("", "--since"), undefined);
      assert.equal(parseTimeBound("2026-07-26T00:00:00.000Z", "--since"), Date.parse("2026-07-26T00:00:00.000Z"));
      assert.throws(() => parseTimeBound("not-a-date", "--since"), /--since: not a parseable timestamp: not-a-date/);
    });

    it("parses time bounds leniently with parseLenientTimeBound", () => {
      assert.equal(parseLenientTimeBound(undefined), null);
      assert.equal(parseLenientTimeBound(null), null);
      assert.equal(parseLenientTimeBound(""), null);
      assert.equal(parseLenientTimeBound("2026-07-26T00:00:00.000Z"), Date.parse("2026-07-26T00:00:00.000Z"));
      assert.equal(parseLenientTimeBound("not-a-date"), null);
    });

    it("checks instant in window with [sinceMs, untilMs) bounds", () => {
      const since = 1000;
      const until = 2000;
      assert.equal(instantInWindow(1500, since, until, true), true);
      assert.equal(instantInWindow(1000, since, until, true), true); // inclusive since
      assert.equal(instantInWindow(2000, since, until, true), false); // exclusive until
      assert.equal(instantInWindow(500, since, until, true), false);
      assert.equal(instantInWindow(2500, since, until, true), false);
      assert.equal(instantInWindow(null, since, until, true), false);
      assert.equal(instantInWindow(null, undefined, undefined, false), true); // no bounds
    });

    it("computes chainWindowKeyMs across SQL rows and raw JSON records", () => {
      // SQL round rows with started_ms
      const sqlChain = { chain_id: "c-sql" };
      const sqlRounds = new Map([
        ["c-sql", [{ started_ms: 5000 }, { started_ms: 3000 }]],
      ]);
      assert.equal(chainWindowKeyMs(sqlChain, sqlRounds), 3000);

      // Raw JSON rounds with startedAt
      const jsonChain = {
        chainId: "c-json",
        rounds: [
          { startedAt: "2026-07-26T05:00:00.000Z" },
          { startedAt: "2026-07-26T02:00:00.000Z" },
        ],
      };
      assert.equal(chainWindowKeyMs(jsonChain), Date.parse("2026-07-26T02:00:00.000Z"));

      // Fallback to orch_date / orchDate
      const undatedRoundsChain = { chain_id: "c-undated", orch_date: "2026-07-26" };
      assert.equal(chainWindowKeyMs(undatedRoundsChain), Date.parse("2026-07-26T00:00:00Z"));

      // Null fallback
      assert.equal(chainWindowKeyMs({ chain_id: "c-empty" }), null);
    });

    it("computes jobWindowKeyMs and evaluates jobInWindow and turnInWindow", () => {
      assert.equal(jobWindowKeyMs({ started_ms: 100 }), 100);
      assert.equal(jobWindowKeyMs({ started_ms: null, finished_ms: 200 }), 200);
      assert.equal(jobWindowKeyMs({ started_ms: null, finished_ms: null, created_ms: 300 }), 300);
      assert.equal(jobWindowKeyMs({}), null);

      assert.equal(jobInWindow({ started_ms: 150 }, 100, 200, true), true);
      assert.equal(jobInWindow({ started_ms: 50 }, 100, 200, true), false);
      assert.equal(turnInWindow({ ts_ms: 150 }, 100, 200, true), true);
      assert.equal(turnInWindow({ ts_ms: 250 }, 100, 200, true), false);
      assert.equal(chainInWindow(150, 100, 200, true), true);
      assert.equal(chainInWindow(null, 100, 200, true), false);
    });

    it("evaluates roundPassesTimeFilter with instant comparison and string fallback", () => {
      const sinceMs = Date.parse("2026-07-26T02:00:00.000Z");
      const untilMs = Date.parse("2026-07-26T05:00:00.000Z");

      // Valid timestamp comparison
      assert.equal(roundPassesTimeFilter("2026-07-26T03:00:00.000Z", "2026-07-26T02:00:00.000Z", "2026-07-26T05:00:00.000Z", sinceMs, untilMs), true);
      assert.equal(roundPassesTimeFilter("2026-07-26T01:00:00.000Z", "2026-07-26T02:00:00.000Z", "2026-07-26T05:00:00.000Z", sinceMs, untilMs), false);

      // String comparison fallback when unparseable
      assert.equal(roundPassesTimeFilter("2026-07-26", "2026-07-20", "2026-07-30", null, null), true);
      assert.equal(roundPassesTimeFilter("2026-07-10", "2026-07-20", "2026-07-30", null, null), false);
    });
  });

  describe("round/finding severity and pathology definitions", () => {
    it("exposes known severities in display order", () => {
      assert.deepEqual(SEVERITY_ORDER, ["low", "medium", "high", "critical"]);
      assert.equal(KNOWN_SEVERITIES.size, 4);
    });

    it("extracts findings text and detects prior unresolved finding patterns", () => {
      assert.equal(extractRoundFindingsText({ findingsText: "prior finding not addressed" }), "prior finding not addressed");
      assert.equal(
        extractRoundFindingsText({ findings: [{ title: "first issue" }, { title: "second issue" }] }),
        "first issue second issue",
      );
      assert.equal(extractRoundFindingsText({}), "");

      assert.equal(hasPriorUnresolvedFinding("prior finding not addressed"), true);
      assert.equal(hasPriorUnresolvedFinding("prior finding #2 unresolved"), true);
      assert.equal(hasPriorUnresolvedFinding("clean review"), false);
      assert.equal(hasPriorUnresolvedFinding(""), false);
    });

    it("computes disposition x severity table across SQL rows and raw JSON records", () => {
      // SQL round rows + findingsByRound Map
      const sqlRounds = [
        { chain_id: "c-1", round: 1, disposition: "accept" },
        { chain_id: "c-2", round: 1, disposition: "rework" },
      ];
      const findingsByRound = new Map([
        ["c-1\u00001", [{ severity: "low" }]],
        ["c-2\u00001", [{ severity: "high" }, { severity: "critical" }]],
      ]);
      const sqlTable = computeDispositionSeverity(sqlRounds, findingsByRound);
      assert.equal(sqlTable.length, 2);
      assert.equal(sqlTable[0].disposition, "accept");
      assert.equal(sqlTable[0].findings, 1);
      assert.equal(sqlTable[0].severities.low, 1);
      assert.equal(sqlTable[0].severities.medium, 0);
      assert.equal(sqlTable[1].disposition, "rework");
      assert.equal(sqlTable[1].findings, 2);
      assert.equal(sqlTable[1].severities.high, 1);
      assert.equal(sqlTable[1].severities.critical, 1);

      // Raw JSON rounds with embedded findings array
      const rawRounds = [
        { disposition: { disposition: "accept" }, findings: [{ severity: "medium" }] },
      ];
      const rawTable = computeDispositionSeverity(rawRounds);
      assert.equal(rawTable.length, 1);
      assert.equal(rawTable[0].disposition, "accept");
      assert.equal(rawTable[0].findings, 1);
      assert.equal(rawTable[0].severities.medium, 1);
    });

    it("computes review pathology rate preserving pct in percentage units", () => {
      const inWindowRounds = [
        { verdict: "approve", verdict_source: "recovered-from-token" },
        { verdict: "unparseable", verdict_source: null },
        { verdict: "discard", verdict_source: "probe" }, // probe excluded from both
        { verdict: "partial", verdict_source: "custom-source" }, // unknown source excluded
      ];
      const path = computeReviewPathology(inWindowRounds, true);
      assert.equal(path.denominator, 2); // approve + unparseable
      assert.equal(path.pathologyCount, 1); // unparseable
      assert.equal(path.pct, 50); // (1 / 2) * 100 = 50%
      assert.equal(path.probeIssued, 1);
      assert.equal(path.otherIssued, 1);
      assert.deepEqual(path.otherValues, ["custom-source"]);
      assert.equal(path.verdictSourceAvailable, true);

      // Empty denominator returns pct: null
      const empty = computeReviewPathology([], false);
      assert.equal(empty.denominator, 0);
      assert.equal(empty.pct, null);

      // emptyReviewPathology helper
      const emptyShape = emptyReviewPathology();
      assert.equal(emptyShape.pathologyCount, 0);
      assert.equal(emptyShape.denominator, 0);
      assert.equal(emptyShape.pct, null);
    });
  });

  describe("reproducible before/after comparison with golden snapshot", () => {
    it("reproduces exact byte-for-byte output on both report surfaces and validates snapshot", () => {
      const snapshotPath = path.join(
        path.dirname(new URL(import.meta.url).pathname),
        "chain-metrics-golden-snapshot.json",
      );
      assert.ok(fs.existsSync(snapshotPath), "golden snapshot file must exist");
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));

      // 1. Build the comprehensive test database fixture covering every disposition
      // and all escalate split categories (substantive, no-work, unknown).
      const db = openMetricsDb(":memory:");

      upsertSession(db, {
        sessionId: "sess-comprehensive-01",
        firstTs: "2026-07-26T00:00:00.000Z",
        firstTsMs: 1785024000000,
        lastTs: "2026-07-26T06:00:00.000Z",
        lastTsMs: 1785045600000,
      });

      upsertTurn(db, {
        requestId: "req-01",
        sessionId: "sess-comprehensive-01",
        ts: "2026-07-26T06:00:00.000Z",
        tsMs: 1785045600000,
        model: "claude-sonnet-5",
        input: 1000,
        output: 500,
        cacheRead: 200,
        cacheWrite: 100,
      });

      const chainConfigs = [
        { id: "c-accept", disp: "accept", verd: "approve", sev: "low" },
        { id: "c-followup", disp: "accept-with-followup", verd: "approve", sev: "medium" },
        { id: "c-rework", disp: "rework", verd: "needs-attention", sev: "high" },
        { id: "c-strategize", disp: "strategize", verd: "needs-attention" },
        { id: "c-discard", disp: "discard", verd: "discard", sev: "critical" },
        { id: "c-other", disp: "unrecognized-disp", verd: "unknown-verdict", find: true },
        { id: "c-esc-subst", disp: "escalate", verd: "needs-attention", wt: 1 },
        { id: "c-esc-nowork", disp: "escalate", verd: "needs-attention", wt: 0 },
        { id: "c-esc-unknown", disp: "escalate", verd: "needs-attention", wt: null },
      ];

      let hour = 1;
      for (const c of chainConfigs) {
        upsertChain(db, {
          chainId: c.id,
          orchModel: "claude-sonnet-5",
          orchDate: "2026-07-26",
          briefChars: 200,
          briefHasDeliverables: 1,
          briefHasSmoke: 1,
        });

        const padHour = String(hour).padStart(2, "0");
        const startedAt = `2026-07-26T${padHour}:00:00.000Z`;
        const startedMs = Date.parse(startedAt);

        upsertRound(db, {
          chainId: c.id,
          round: 1,
          startedAt,
          startedMs,
          disposition: c.disp,
          verdict: c.verd,
          probesGreen: 1,
          worktreeChanged: c.wt !== undefined ? c.wt : null,
          stopReason: null,
        });

        if (c.sev !== undefined || c.find) {
          upsertFinding(db, {
            chainId: c.id,
            round: 1,
            idx: 0,
            severity: c.sev ?? null,
          });
        }
        hour++;
      }

      // Add one chain with no rounds
      upsertChain(db, {
        chainId: "c-no-rounds",
        orchModel: "claude-sonnet-5",
        orchDate: "2026-07-26",
        briefChars: 150,
        briefHasDeliverables: 0,
        briefHasSmoke: 1,
      });

      // 2. Validate SQL report surface byte-for-byte against golden snapshot
      const report = computeReport(db, { dbPath: ":memory:" });
      const reportText = renderReportText(report);
      const reportJson = renderReportJson(report);

      assert.equal(reportText, snapshot.reportText, "reportText must match golden snapshot byte-for-byte");
      assert.equal(reportJson, snapshot.reportJson, "reportJson must match golden snapshot byte-for-byte");

      // Validate structured breakdown sections
      const parsedReport = JSON.parse(reportJson);
      assert.deepEqual(
        parsedReport.briefOutcome[0].escalateSplit,
        snapshot.reportBriefOutcomeEscalateSplit,
        "briefOutcome escalateSplit must match snapshot",
      );
      assert.deepEqual(
        parsedReport.briefOutcome[0].table,
        snapshot.reportBriefOutcomeTable,
        "briefOutcome table must match snapshot",
      );
      assert.deepEqual(
        parsedReport.dispositionSeverity,
        snapshot.dispositionSeverity,
        "dispositionSeverity must match snapshot",
      );

      // 3. Build corresponding raw JSON chains for filesystem adapter (chain-stats)
      hour = 1;
      const rawChains = chainConfigs.map((c) => {
        const padHour = String(hour).padStart(2, "0");
        const startedAt = `2026-07-26T${padHour}:00:00.000Z`;
        hour++;
        const roundObj = {
          round: 1,
          startedAt,
          disposition: { disposition: c.disp },
          verdict: c.verd,
          worktreeChanged: c.wt === 1 ? true : (c.wt === 0 ? false : null),
          findings: (c.sev !== undefined || c.find) ? [{ severity: c.sev ?? null }] : [],
          findingFiles: [],
        };
        return {
          chainId: c.id,
          meta: {
            chainTotals: { input: 100, output: 50, cost: 0.05 },
          },
          rounds: [roundObj],
        };
      });

      // 4. Validate filesystem report surface byte-for-byte against golden snapshot
      const stats = computeStats(rawChains);
      const chainStatsText = renderChainStats(stats);

      assert.equal(
        chainStatsText,
        snapshot.chainStatsText,
        "chainStatsText must match golden snapshot byte-for-byte",
      );
      assert.deepEqual(
        stats.dispositionCounts,
        snapshot.dispositionCounts,
        "dispositionCounts must match snapshot",
      );
      assert.deepEqual(
        stats.escalateSplit,
        snapshot.chainStatsEscalateSplit,
        "chainStats escalateSplit must match snapshot",
      );
    });
  });
});
