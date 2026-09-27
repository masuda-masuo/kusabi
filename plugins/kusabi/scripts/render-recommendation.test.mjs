import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderRecommendation, computeDiffStat, truncateText } from "./render-recommendation.mjs";

describe("render-recommendation (kusabi #592)", () => {
  it("surface: exports renderRecommendation and helpers", () => {
    assert.equal(typeof renderRecommendation, "function");
    assert.equal(typeof computeDiffStat, "function");
    assert.equal(typeof truncateText, "function");
  });

  it("criterion 1: recommend-accept fixture with 2 attempts, 1 clear v2 gate, 2 chains renders all six new sections with correct values", () => {
    const briefText = [
      "# Test mission",
      "",
      "## Acceptance criteria",
      "- AC1: First criterion passes",
      "- AC2: Second criterion verified by probe",
    ].join("\n");

    const gate = {
      gateId: "gate-1",
      phase: "pre-accept",
      origin: "policy-mandated",
      verdict: "clear",
      disposition: "verdict-recorded",
      shadowDisposition: "sol-blocked",
      verdictRecord: {
        verdict: "clear",
        summary: "All acceptance criteria verified against probe output and invariants hold.",
        invariants: [
          { id: "INV1", held: true },
          { id: "INV2", held: true },
        ],
        criteria: [
          { id: "AC1", status: "met", evidence: "evidence/worker-report-1.txt" },
          { id: "AC2", status: "met", evidence: "evidence/chain-probes-1.txt" },
        ],
      },
    };

    const gateEnvelopes = {
      "gate-1": {
        items: [
          { path: "evidence/worker-report-1.txt", role: "worker_report" },
          { path: "evidence/chain-probes-1.txt", role: "probe_raw" },
        ],
      },
    };

    const chain1 = {
      baseSha: "abc001",
      records: [
        {

          round: 1,
          modelEntry: "codex/gpt-5.6-luna",
          reviewModelEntry: "codex/gpt-5.6-sol",
          fallbacks: null,
          probeResults: [{ probe: "P1: HEAD clean", passed: true, detail: "ok" }],
          disposition: { disposition: "rework", reason: "needs more tests" },
        },
      ],
    };

    const chain2 = {
      baseSha: "abc002",
      records: [
        {
          round: 1,
          modelEntry: "codex/gpt-5.6-luna",
          reviewModelEntry: "codex/gpt-5.6-sol",
          fallbacks: ["retry-1"],
          probeResults: [
            { probe: "P1: HEAD clean", passed: true, detail: "ok" },
            { probe: "P2: tests pass", passed: true, detail: "ok" },
          ],
          disposition: { disposition: "accepted", reason: "approved" },
        },
      ],
    };

    const diff1 = [
      "diff --git a/file1.txt b/file1.txt",
      "--- a/file1.txt",
      "+++ b/file1.txt",
      "@@ -1,3 +1,4 @@",
      "-old",
      "+new line 1",
      "+new line 2",
    ].join("\n");

    const diff2 = [
      "diff --git a/file2.txt b/file2.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/file2.txt",
      "+first line",
    ].join("\n");

    const record = {
      missionId: "mission-test-1",
      attempts: [
        {
          index: 1,
          kind: "run_chain",
          chainId: "chain-1",
          status: "completed",
          postChain: {
            chainId: "chain-1",
            baseSha: "abc001",
            diff: diff1,
            diffTruncated: false,
          },
        },
        {
          index: 2,
          kind: "rework_chain",
          chainId: "chain-2",
          status: "completed",
          postChain: {
            chainId: "chain-2",
            baseSha: "abc002",
            diff: diff2,
            diffTruncated: false,
            untrackedIncluded: ["new-untracked.txt"],
          },
        },
      ],
      auditGates: [gate],
      chains: ["chain-1", "chain-2"],
    };

    const out = renderRecommendation({
      missionId: "mission-test-1",
      disposition: "recommend-accept",
      recommendation: "recommend-accept",
      reason: "all gates passed",
      gate,
      record,
      briefText,
      chains: {
        "chain-1": chain1,
        "chain-2": chain2,
      },
      gateEnvelopes,
    });

    // Six new sections in order
    const sectionHeaders = [
      "## Acceptance criteria",
      "## Sol",
      "## Chains",
      "## Diff stat",
      "## Residual risks / not verified",
      "## Evidence",
    ];
    let lastIdx = -1;
    for (const h of sectionHeaders) {
      const idx = out.indexOf(h);
      assert.ok(idx > -1, `section ${h} must be present`);
      assert.ok(idx > lastIdx, `section ${h} must follow previous section`);
      lastIdx = idx;
    }

    // Acceptance criteria values
    assert.match(out, /- AC1: met — evidence: evidence\/worker-report-1\.txt \(worker_report — claim, not measured\)/);
    assert.match(out, /- AC2: met — evidence: evidence\/chain-probes-1\.txt \(probe_raw\)/);

    // Sol values
    assert.match(out, /- gate-1 \(phase: pre-accept, origin: policy-mandated, verdict: clear\)/);
    assert.match(out, /summary: All acceptance criteria verified/);
    assert.match(out, /shadow disposition: sol-blocked — counterfactual: what this gate would have resolved to if the Sol seat had returned no verdict; never applied/);

    // Chains values
    assert.match(out, /- chain-1: implement: codex\/gpt-5\.6-luna, review: codex\/gpt-5\.6-sol, fallbacks: 0, rounds: 1, disposition: rework, probes: P1 ✓/);
    assert.match(out, /- chain-2: implement: codex\/gpt-5\.6-luna, review: codex\/gpt-5\.6-sol, fallbacks: 1, rounds: 1, disposition: accepted, probes: P1 ✓ P2 ✓/);

    // Diff stat values
    assert.match(out, /- attempt 1 \(chain-1\): 1 file changed, \+2\/-1 lines/);
    assert.match(out, /- attempt 2 \(chain-2\): 2 files changed, \+1\/-0 lines, 2 new files/);

    // Residual risks
    assert.match(out, /- live-server \/ real-client behaviour: not exercised by any seat — host check/);
    // AC1 used worker_report, so appears in residual risks
    assert.match(out, /- criteria resting on a worker claim only \(worker_report — claim, not measured\): AC1/);

    // Evidence
    assert.match(out, /Paths are relative to this file\./);
    assert.match(out, /- mission record: mission\.json/);
    assert.match(out, /- evidence directory: evidence\//);
    assert.match(out, /- chain chain-1: \.\.\/\.\.\/chains\/chain-1\//);
    assert.match(out, /- chain chain-2: \.\.\/\.\.\/chains\/chain-2\//);
  });

  it("criterion 2: every gate in record.auditGates appears with verdict, summary and shadowDisposition plus counterfactual for recommend-accept, sol-blocked and budget-exhausted", () => {
    const gateA = {
      gateId: "gate-10",
      phase: "post-chain",
      origin: "sampled",
      verdict: "clear",
      shadowDisposition: "sol-blocked",
      verdictRecord: { summary: "first round looks clean" },
    };
    const gateB = {
      gateId: "gate-11",
      phase: "pre-accept",
      origin: "policy-mandated",
      verdict: "block",
      shadowDisposition: "sol-blocked",
      verdictRecord: { summary: "safety violation found", block_reason: "unsafe code" },
    };

    const dispositions = ["recommend-accept", "sol-blocked", "budget-exhausted"];
    for (const disp of dispositions) {
      const out = renderRecommendation({
        missionId: "mission-gates-test",
        disposition: disp,
        reason: "testing dispositions",
        record: { auditGates: [gateA, gateB] },
        briefText: "",
        chains: {},
        gateEnvelopes: {},
      });

      // Both gates appear
      assert.match(out, /- gate-10 \(phase: post-chain, origin: sampled, verdict: clear\)/);
      assert.match(out, /summary: first round looks clean/);
      assert.match(out, /- gate-11 \(phase: pre-accept, origin: policy-mandated, verdict: block\)/);
      assert.match(out, /summary: safety violation found/);
      assert.match(out, /shadow disposition: sol-blocked — counterfactual: what this gate would have resolved to if the Sol seat had returned no verdict; never applied/);
    }
  });

  it("criterion 3: worker_report role renders with claim, not measured and appears under residual risks; unjudged criterion renders not checked", () => {
    const briefText = [
      "## Acceptance criteria",
      "- AC1: Claim verified by worker report",
      "- AC2: Unchecked criterion",
    ].join("\n");

    const gate = {
      gateId: "gate-1",
      verdict: "clear",
      verdictRecord: {
        criteria: [
          { id: "AC1", status: "met", evidence: "evidence/worker-report-1.txt" },
          // AC2 omitted -> not judged
        ],
      },
    };

    const gateEnvelopes = {
      "gate-1": {
        items: [{ path: "evidence/worker-report-1.txt", role: "worker_report" }],
      },
    };

    const out = renderRecommendation({
      missionId: "m-c3",
      disposition: "recommend-accept",
      record: { auditGates: [gate] },
      briefText,
      chains: {},
      gateEnvelopes,
    });

    // In Acceptance criteria:
    assert.match(out, /- AC1: met — evidence: evidence\/worker-report-1\.txt \(worker_report — claim, not measured\)/);
    assert.match(out, /- AC2: not checked — AC2: Unchecked criterion/);

    // In Residual risks:
    assert.match(out, /## Residual risks \/ not verified[\s\S]*- criteria not checked: AC2/);
    assert.match(out, /## Residual risks \/ not verified[\s\S]*- criteria resting on a worker claim only \(worker_report — claim, not measured\): AC1/);
  });

  it("criterion 4: no text originates from coordinator output or record.recommendation free text other than header fields", () => {
    const coordinatorLeak = "LEAKED_COORDINATOR_INTERNAL_SECRET_TOKEN_XYZ";
    const recFreeTextLeak = "LEAKED_RECOMMENDATION_EXTRA_FREE_TEXT_123";

    const out = renderRecommendation({
      missionId: "m-c4",
      disposition: "recommend-accept",
      recommendation: `recommend-accept ${recFreeTextLeak}`,
      record: {
        coordinatorOutput: coordinatorLeak,
        recommendation: recFreeTextLeak,
        auditGates: [],
      },
      briefText: "## Acceptance criteria\n- AC1: Clean brief",
      chains: {},
      gateEnvelopes: {},
    });

    // The coordinator output must NEVER appear anywhere in the output
    assert.equal(out.includes(coordinatorLeak), false);

    // The recommendation free text appears ONLY in the header line `recommendation: ...`
    const headerPrefix = out.split("## Acceptance criteria")[0];
    assert.ok(headerPrefix.includes(recFreeTextLeak));
    const newSections = out.slice(out.indexOf("## Acceptance criteria"));
    assert.equal(newSections.includes(recFreeTextLeak), false, "new sections must not contain recommendation free text");
  });

  it("criterion 5: 5,000-char summary, 30 findings and 20 criteria stay bounded (no line > 300 chars; lists capped with +K more); 1-2 chain / <=6 criteria renders <= 60 lines", () => {
    const longSummary = "A".repeat(5000);
    const findings = [];
    for (let i = 1; i <= 30; i++) {
      findings.push({ severity: "medium", title: `Finding ${i}`, body: `Body text for finding ${i}: ` + "B".repeat(400) });
    }

    const criteriaLines = ["## Acceptance criteria"];
    const verdictCriteria = [];
    for (let i = 1; i <= 20; i++) {
      criteriaLines.push(`- AC${i}: Acceptance criterion number ${i} with long description ` + "C".repeat(350));
      verdictCriteria.push({ id: `AC${i}`, status: "met", evidence: `evidence/ev-${i}.txt` });
    }

    const gate = {
      gateId: "gate-bound",
      phase: "pre-accept",
      origin: "policy-mandated",
      verdict: "clear",
      shadowDisposition: "sol-blocked",
      findings,
      verdictRecord: {
        summary: longSummary,
        invariants: [{ id: "INV1", held: true }],
        criteria: verdictCriteria,
      },
    };

    const out = renderRecommendation({
      missionId: "m-bound",
      disposition: "recommend-accept",
      record: { auditGates: [gate] },
      briefText: criteriaLines.join("\n"),
      chains: {},
      gateEnvelopes: {},
    });

    const lines = out.split("\n");
    for (let i = 0; i < lines.length; i++) {
      assert.ok(lines[i].length <= 300, `line ${i + 1} exceeds 300 chars (length=${lines[i].length}): ${lines[i].slice(0, 50)}...`);
    }

    // Findings capped with +K more
    assert.match(out, /\(\+22 more in mission\.json auditGates\)/);

    // Criteria capped with +K more
    assert.match(out, /\(\+12 more in brief\)/);

    // Standard 1-2 chain / <=6 criteria fixture renders <= 60 lines
    const stdBrief = [
      "## Acceptance criteria",
      "- AC1: one",
      "- AC2: two",
      "- AC3: three",
      "- AC4: four",
      "- AC5: five",
      "- AC6: six",
    ].join("\n");

    const stdGate = {
      gateId: "gate-std",
      phase: "pre-accept",
      origin: "policy-mandated",
      verdict: "clear",
      shadowDisposition: "sol-blocked",
      verdictRecord: {
        summary: "short summary",
        invariants: [{ id: "INV1", held: true }],
        criteria: [
          { id: "AC1", status: "met", evidence: "ev.txt" },
          { id: "AC2", status: "met", evidence: "ev.txt" },
          { id: "AC3", status: "met", evidence: "ev.txt" },
          { id: "AC4", status: "met", evidence: "ev.txt" },
          { id: "AC5", status: "met", evidence: "ev.txt" },
          { id: "AC6", status: "met", evidence: "ev.txt" },
        ],
      },
    };

    const stdChain = {
      records: [
        {
          round: 1,
          modelEntry: "model-1",
          reviewModelEntry: "model-rev",
          probeResults: [{ probe: "P1: HEAD", passed: true }],
          disposition: { disposition: "accepted" },
        },
      ],
    };

    const stdOut = renderRecommendation({
      missionId: "m-std",
      disposition: "recommend-accept",
      recommendation: "recommend-accept",
      reason: "done",
      record: {
        auditGates: [stdGate],
        attempts: [
          {
            index: 1,
            chainId: "c1",
            postChain: { diff: "diff --git a/a b/a\n+1\n", diffTruncated: false },
          },
        ],
      },
      briefText: stdBrief,
      chains: { c1: stdChain },
      gateEnvelopes: {},
    });

    const stdLines = stdOut.split("\n");
    assert.ok(stdLines.length <= 60, `standard fixture must be <= 60 lines, got ${stdLines.length}`);
  });

  it("criterion 6: missing inputs never throw and yield one-line not available statements", () => {
    // Completely empty input
    assert.doesNotThrow(() => renderRecommendation({}));

    const out = renderRecommendation({
      missionId: "m-missing",
      disposition: "cancelled",
      record: {
        attempts: [
          { index: 1, chainId: "c-unavail", postChain: { unavailable: "timeout reading diff" } },
          { index: 2, chainId: "c-diffunavail", postChain: { diffUnavailable: "diff tool failed" } },
          { index: 3, chainId: "c-nopost" },
        ],
        chains: ["c-unreadable"],
        auditGates: [
          // Legacy v1 verdict without invariants/criteria
          {

            gateId: "gate-legacy",
            phase: "consult",
            origin: "luna-requested",
            verdict: "clear",
            verdictRecord: { schema_version: 1, summary: "legacy ok" },
          },
        ],
      },
      briefText: null, // missing brief
      chains: { "c-unreadable": null }, // unreadable chain
      gateEnvelopes: null, // missing envelopes
    });

    // Acceptance criteria not available
    assert.match(out, /\(no acceptance criteria recorded\)/);

    // Unreadable chain
    assert.match(out, /- c-unreadable: chain\.json unreadable/);

    // Unavailable diffs
    assert.match(out, /- attempt 1 \(c-unavail\): post-chain evidence unavailable \(timeout reading diff\)/);
    assert.match(out, /- attempt 2 \(c-diffunavail\): diff unavailable \(diff tool failed\)/);
    assert.match(out, /- attempt 3 \(c-nopost\): post-chain evidence unavailable/);

    // Legacy gate renders without error
    assert.match(out, /- gate-legacy \(phase: consult, origin: luna-requested, verdict: clear\)/);
    assert.match(out, /summary: legacy ok/);

    // No audit gates test
    const outNoGates = renderRecommendation({
      missionId: "m-nogates",
      disposition: "cancelled",
      record: { auditGates: [] },
    });
    assert.match(outNoGates, /\(no audit gates recorded\)/);

    // No chains test
    const outNoChains = renderRecommendation({
      missionId: "m-nochains",
      disposition: "cancelled",
      record: { chains: [] },
    });
    assert.match(outNoChains, /\(no chains recorded\)/);

    // No diff test
    const outNoDiff = renderRecommendation({
      missionId: "m-nodiff",
      disposition: "cancelled",
      record: { attempts: [] },
    });
    assert.match(outNoDiff, /\(no diff recorded\)/);
  });

  it("criterion 7: existing header and disposition-specific sections are byte-identical as a prefix", () => {
    // 1. recommend-accept
    const recAcceptInput = {

      missionId: "m-prefix-1",
      disposition: "recommend-accept",
      recommendation: "recommend-accept",
      reason: "all good",
    };
    const expectedAcceptPrefix = [
      "# Mission recommendation",
      "",
      "mission: m-prefix-1",
      "disposition: recommend-accept",
      "recommendation: recommend-accept",
      "reason: all good",
      "",
    ].join("\n");

    const outAccept = renderRecommendation(recAcceptInput);
    assert.ok(outAccept.startsWith(expectedAcceptPrefix), "recommend-accept prefix must be byte-identical");

    // 2. sol-blocked with gate
    const gate = {
      gateId: "gate-sb",
      phase: "pre-accept",
      verdict: "block",
      verdictRecord: { summary: "block summary", block_reason: "unsafe code" },
    };
    const solBlockedInput = {
      missionId: "m-prefix-2",
      disposition: "sol-blocked",
      gate,
    };
    const expectedSolBlockedPrefix = [
      "# Mission recommendation",
      "",
      "mission: m-prefix-2",
      "disposition: sol-blocked",
      "gate: gate-sb (phase: pre-accept, verdict: block)",
      "summary: block summary",
      "block_reason: unsafe code",
      "",
      "## Next actions",
      "",
      "1. amend the mission brief (resolve what `block_reason`/`summary` names) and start a new mission",
      "2. kusabi-companion luna-resume m-prefix-2 --audit-override gate-sb --audit-override-reason <reason> --audit-override-by <actor>",
      "",
    ].join("\n");

    const outSolBlocked = renderRecommendation(solBlockedInput);
    assert.ok(outSolBlocked.startsWith(expectedSolBlockedPrefix), "sol-blocked prefix must be byte-identical");

    // 3. brief-correction-exhausted
    const briefCorrectionInput = {
      missionId: "m-prefix-3",
      disposition: "brief-correction-exhausted",
      reason: "budget exceeded",
      lastCorrectionDetail: "Missing deliverables section",
    };
    const expectedBriefCorrectionPrefix = [
      "# Mission recommendation",
      "",
      "mission: m-prefix-3",
      "disposition: brief-correction-exhausted",
      "reason: budget exceeded",
      "",
      "## Last brief correction",
      "",
      "Missing deliverables section",
      "",
    ].join("\n");

    const outBriefCorrection = renderRecommendation(briefCorrectionInput);
    assert.ok(outBriefCorrection.startsWith(expectedBriefCorrectionPrefix), "brief-correction prefix must be byte-identical");

    // 4. coordinator-failed
    const coordFailedInput = {
      missionId: "m-prefix-4",
      disposition: "coordinator-failed",
      reason: "infra error",
      lastCoordinatorErrorDetail: "Connection refused to seam",
    };
    const expectedCoordFailedPrefix = [
      "# Mission recommendation",
      "",
      "mission: m-prefix-4",
      "disposition: coordinator-failed",
      "reason: infra error",
      "",
      "## Last coordinator error",
      "",
      "Connection refused to seam",
      "",
    ].join("\n");

    const outCoordFailed = renderRecommendation(coordFailedInput);
    assert.ok(outCoordFailed.startsWith(expectedCoordFailedPrefix), "coordinator-failed prefix must be byte-identical");
  });

  it("diffTruncated flag renders (truncated: stat is partial) and appears in residual risks", () => {
    const diff = "diff --git a/a.txt b/a.txt\n+hello\n";
    const out = renderRecommendation({
      missionId: "m-trunc",
      disposition: "recommend-accept",
      record: {
        attempts: [
          {
            index: 1,
            chainId: "c-trunc",
            postChain: {
              chainId: "c-trunc",
              diff,
              diffTruncated: true,
            },
          },
        ],
      },
    });

    assert.match(out, /1 file changed, \+1\/-0 lines \(truncated: stat is partial\)/);
    assert.match(out, /## Residual risks \/ not verified[\s\S]*- attempt 1: diff was truncated \(stat is partial\)/);
  });

  it("finding 1: brief-correction-exhausted with 900-char multi-line detail renders verbatim; same for coordinator-failed", () => {
    const detail900 = [
      "Validator failure in section 1: " + "A".repeat(250),
      "Validator failure in section 2: " + "B".repeat(250),
      "Validator failure in section 3: " + "C".repeat(300),
      "End of validator error output.",
    ].join("\n");
    assert.ok(detail900.length >= 900);

    const outCorrection = renderRecommendation({
      missionId: "m-f1-corr",
      disposition: "brief-correction-exhausted",
      reason: "budget exceeded",
      lastCorrectionDetail: detail900,
    });
    assert.ok(
      outCorrection.includes(detail900),
      "brief-correction-exhausted must render 900-char multi-line detail verbatim without truncation"
    );

    const outCoord = renderRecommendation({
      missionId: "m-f1-coord",
      disposition: "coordinator-failed",
      reason: "coordinator crashed",
      lastCoordinatorErrorDetail: detail900,
    });
    assert.ok(
      outCoord.includes(detail900),
      "coordinator-failed must render 900-char multi-line detail verbatim without truncation"
    );
  });

  it("finding 2: 20 not-checked criteria + 20 worker_report criteria -> section has <= 14 lines and both id lists end with (+12 more)", () => {
    const criteriaLines = ["## Acceptance criteria"];
    const verdictCriteria = [];
    const envelopeItems = [];

    // AC1..AC20: not checked (not present in gate verdictRecord.criteria)
    for (let i = 1; i <= 20; i++) {
      criteriaLines.push(`- AC${i}: Not checked criterion ${i}`);
    }

    // AC21..AC40: worker_report role
    for (let i = 21; i <= 40; i++) {
      criteriaLines.push(`- AC${i}: Worker report criterion ${i}`);
      verdictCriteria.push({ id: `AC${i}`, status: "met", evidence: `evidence/wr-${i}.txt` });
      envelopeItems.push({ path: `evidence/wr-${i}.txt`, role: "worker_report" });
    }

    const gate = {
      gateId: "gate-f2",
      phase: "pre-accept",
      verdict: "clear",
      verdictRecord: {
        criteria: verdictCriteria,
      },
    };

    const out = renderRecommendation({
      missionId: "m-f2",
      disposition: "recommend-accept",
      briefText: criteriaLines.join("\n"),
      record: { auditGates: [gate] },
      gateEnvelopes: {
        "gate-f2": { items: envelopeItems },
      },
    });

    const residualHeading = "## Residual risks / not verified";
    const evidenceHeading = "## Evidence";
    const startIdx = out.indexOf(residualHeading);
    const endIdx = out.indexOf(evidenceHeading);
    assert.ok(startIdx > -1 && endIdx > startIdx);

    const sectionText = out.slice(startIdx, endIdx);
    const sectionLines = sectionText.trim().split("\n");
    assert.ok(
      sectionLines.length <= 14,
      `Residual risks section must have <= 14 lines, got ${sectionLines.length}:\n${sectionText}`
    );

    // Both id lists end with (+12 more)
    assert.match(
      out,
      /- criteria not checked: AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8 \(\+12 more\)/
    );
    assert.match(
      out,
      /- criteria resting on a worker claim only \(worker_report — claim, not measured\): AC21, AC22, AC23, AC24, AC25, AC26, AC27, AC28 \(\+12 more\)/
    );
  });

  it("finding 2 (overflow cap): > 12 risk items caps section and adds (+K more …) line", () => {
    const invariants = [];
    for (let i = 1; i <= 15; i++) {
      invariants.push({ id: `INV${i}`, held: false, finding: `Invariant ${i} failed` });
    }
    const gate = {
      gateId: "gate-overflow",
      phase: "pre-accept",
      verdict: "block",
      verdictRecord: { invariants },
    };

    const out = renderRecommendation({
      missionId: "m-overflow",
      disposition: "recommend-reject",
      record: { auditGates: [gate] },
    });

    assert.match(out, /\(\+3 more …\)/);
    assert.match(out, /- live-server \/ real-client behaviour: not exercised by any seat — host check/);
  });

  it("finding 3: evidence pointers render ../../chains/<id>/ and intro line states paths relative to this file", () => {
    const out = renderRecommendation({
      missionId: "m-f3",
      disposition: "recommend-accept",
      record: { chains: ["chain-alpha", "chain-beta"] },
    });

    assert.match(out, /## Evidence[\s\S]*Paths are relative to this file\./i);
    assert.match(out, /- chain chain-alpha: \.\.\/\.\.\/chains\/chain-alpha\//);
    assert.match(out, /- chain chain-beta: \.\.\/\.\.\/chains\/chain-beta\//);
  });
});


describe("render-recommendation (kusabi #605)", () => {
  it("renders failed chain status, structured implement failure, failed-before-probes note, and residual risk", () => {
    const diff = [
      "diff --git a/file.txt b/file.txt",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const out = renderRecommendation({
      missionId: "m-605-failed",
      disposition: "recommend-escalate",
      record: {
        chains: ["chain-failed"],
        attempts: [{
          index: 1,
          chainId: "chain-failed",
          postChain: { chainId: "chain-failed", diff },
        }],
      },
      chains: {
        "chain-failed": {
          records: [{
            modelEntry: "agy/gemini-3.8-flash-high",
            implementJobFailure: {
              kind: "quota-exhaustion",
              backend: "agy",
              quota: "individual",
              backendBlocked: true,
              reset: "17h34m29s",
            },
          }],
        },
      },
      chainControls: { "chain-failed": { status: "failed" } },
    });

    assert.match(out, /- chain-failed: implement: agy\/gemini-3\.8-flash-high[\s\S]*status: failed, implement failed: quota-exhaustion \(agy, individual, reset 17h34m29s\)/);
    assert.match(out, /- attempt 1 \(chain-failed\): 1 file changed, \+1\/-1 lines \(chain failed before probes; stat is the worktree at failure\)/);
    assert.match(out, /- chain chain-failed: failed \(implement failed: quota-exhaustion \(agy, individual, reset 17h34m29s\)\)/);
    for (const line of out.split("\n")) assert.ok(line.length <= 300);
  });

  it("renders bounded error fallback, completed status, and unknown status when control is absent", () => {
    const longError = "backend returned an unusably long error ".repeat(8);
    const out = renderRecommendation({
      missionId: "m-605-statuses",
      disposition: "recommend-accept",
      record: { chains: ["chain-error", "chain-complete", "chain-unknown"] },
      chains: {
        "chain-error": { records: [{ implementJobError: longError }] },
        "chain-complete": { records: [{ disposition: "accepted", probeResults: [] }] },
        "chain-unknown": { records: [{}] },
      },
      chainControls: {
        "chain-error": { status: "failed" },
        "chain-complete": { status: "completed" },
        "chain-unknown": null,
      },
    });

    assert.match(out, /chain-error:[\s\S]*status: failed, implement failed: backend returned an unusably long error/);
    assert.match(out, /chain-complete:[\s\S]*status: completed(?!, implement failed)/);
    assert.match(out, /chain-unknown:[\s\S]*status: unknown/);
    const errorLine = out.split("\n").find((line) => line.includes("chain-error: implement:"));
    assert.ok(errorLine);
    assert.ok(errorLine.length <= 300);
    assert.ok(errorLine.includes("…"));
  });

  it("collapses identical consecutive diffs and keeps different diff stats", () => {
    const diffA = "diff --git a/a.txt b/a.txt\n+same";
    const diffB = "diff --git a/b.txt b/b.txt\n+different";
    const out = renderRecommendation({
      missionId: "m-605-diffs",
      disposition: "recommend-accept",
      record: {
        chains: ["c1", "c2", "c3"],
        attempts: [
          { index: 1, chainId: "c1", postChain: { diff: diffA } },
          { index: 2, chainId: "c2", postChain: { diff: diffA } },
          { index: 3, chainId: "c3", postChain: { diff: diffB } },
        ],
      },
      chains: {
        c1: { records: [{}] },
        c2: { records: [{}] },
        c3: { records: [{}] },
      },
    });

    assert.match(out, /- attempt 1 \(c1\): 1 file changed, \+1\/-0 lines/);
    assert.match(out, /- attempt 2 \(c2\): no change since attempt 1/);
    assert.match(out, /- attempt 3 \(c3\): 1 file changed, \+1\/-0 lines/);
  });

  it("caps failed-chain residual risks with the existing section cap", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `failed-${i + 1}`);
    const out = renderRecommendation({
      missionId: "m-605-cap",
      disposition: "recommend-escalate",
      record: { chains: ids },
      chains: Object.fromEntries(ids.map((id) => [id, { records: [{ implementJobFailure: { kind: "quota-exhaustion" } }] }])),
      chainControls: Object.fromEntries(ids.map((id) => [id, { status: "failed" }])),
    });
    const section = out.split("## Residual risks / not verified")[1].split("## Evidence")[0];
    const failedRiskLines = section.split("\n").filter((line) => line.startsWith("- chain ") && line.includes(": failed ("));
    assert.equal(failedRiskLines.length, 12);
    assert.match(section, /\(\+8 more …\)/);
  });
});
