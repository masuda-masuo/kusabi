// render-recommendation.mjs — pure renderer for host-facing recommendation.md (kusabi #592)

import { oneLine } from "./one-line.mjs";
import { parseAcceptanceCriteria } from "./brief-parsing.mjs";

const MAX_TEXT_LEN = 200;
const MAX_LIST_ITEMS = 8;
const MAX_LINE_LEN = 300;
const MAX_SECTION_RISKS = 12;

/**
 * Single-line collapse and length bound with ellipsis marker.
 *
 * @param {string|null|undefined} value
 * @param {number} [max]
 * @returns {string}
 */
export function truncateText(value, max = MAX_TEXT_LEN) {
  const line = oneLine(value);
  if (line.length <= max) return line;
  return line.slice(0, max - 1) + "…";
}

/**
 * Hard limit of 300 characters per line to guarantee bounded output.
 *
 * @param {string} str
 * @returns {string}
 */
function clampLine(str) {
  if (typeof str !== "string") return "";
  if (str.length <= MAX_LINE_LEN) return str;
  return str.slice(0, MAX_LINE_LEN - 1) + "…";
}

/**
 * Format a structured or raw finding line for presentation.
 *
 * @param {object|string} f
 * @returns {string}
 */
function formatFinding(f) {
  if (typeof f === "string") return f;
  if (!f || typeof f !== "object") return String(f);
  const parts = [];
  if (f.severity) parts.push(`[${f.severity}]`);
  if (f.title) parts.push(f.title);
  if (f.body) parts.push(f.title ? `: ${f.body}` : f.body);
  else if (f.message) parts.push(f.title ? `: ${f.message}` : f.message);
  else if (f.finding) parts.push(f.title ? `: ${f.finding}` : f.finding);
  if (parts.length > 0) return parts.join(" ");
  return JSON.stringify(f);
}

/**
 * Pure diff stat counter from unified diff text and untracked file list.
 *
 * @param {string} diffText
 * @param {string[]} [untrackedIncluded]
 * @returns {{ filesCount: number, additions: number, deletions: number, newFilesCount: number, newFilesList: string[] }}
 */
export function computeDiffStat(diffText = "", untrackedIncluded = []) {
  if (typeof diffText !== "string") diffText = "";
  const diffLines = diffText.split("\n");
  const modifiedFiles = new Set();
  const newFiles = new Set();
  let additions = 0;
  let deletions = 0;
  let currentFile = null;

  for (const rawLine of diffLines) {
    const gitMatch = rawLine.match(/^diff --git a\/(.*?) b\/(.*)$/);
    if (gitMatch) {
      currentFile = gitMatch[2];
      modifiedFiles.add(currentFile);
      continue;
    }
    if (rawLine.startsWith("new file mode") || rawLine.startsWith("new file (untracked;")) {
      if (currentFile) newFiles.add(currentFile);
      continue;
    }
    if (rawLine.startsWith("--- /dev/null")) {
      if (currentFile) newFiles.add(currentFile);
      continue;
    }
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      additions++;
      continue;
    }
    if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      deletions++;
      continue;
    }
  }

  if (Array.isArray(untrackedIncluded)) {
    for (const f of untrackedIncluded) {
      if (typeof f === "string" && f) {
        modifiedFiles.add(f);
        newFiles.add(f);
      }
    }
  }

  return {
    filesCount: modifiedFiles.size,
    additions,
    deletions,
    newFilesCount: newFiles.size,
    newFilesList: [...newFiles],
  };
}

/**
 * Pure renderer for recommendation.md (the single host-facing mission summary).
 *
 * @param {object} input
 * @param {string} input.missionId
 * @param {string} input.disposition
 * @param {string} [input.recommendation]
 * @param {string} [input.reason]
 * @param {object} [input.gate]
 * @param {string} [input.lastCorrectionDetail]
 * @param {string} [input.lastCoordinatorErrorDetail]
 * @param {object} [input.record]
 * @param {string} [input.briefText]
 * @param {Object.<string, object|null>} [input.chains]
 * @param {Object.<string, object|null>} [input.gateEnvelopes]
 * @returns {string} the full file content
 */
export function renderRecommendation(input = {}) {
  const {
    missionId,
    disposition,
    recommendation,
    reason,
    gate,
    lastCorrectionDetail,
    lastCoordinatorErrorDetail,
    record,
    briefText,
    chains,
    gateEnvelopes,
  } = input;

  // Existing header lines (byte-identical prefix)
  const prefixLines = [
    "# Mission recommendation",
    "",
    `mission: ${missionId}`,
    `disposition: ${disposition}`,
    recommendation ? `recommendation: ${recommendation}` : null,
    reason ? `reason: ${oneLine(reason)}` : null,
  ].filter((line) => line !== null);

  if (disposition === "sol-blocked") {
    if (gate && typeof gate === "object") {
      const phase = typeof gate.phase === "string" ? gate.phase : "?";
      const verdict = typeof gate.verdict === "string" ? gate.verdict : "none";
      prefixLines.push(`gate: ${gate.gateId} (phase: ${phase}, verdict: ${verdict})`);
      if (gate.verdictRecord && typeof gate.verdictRecord === "object") {
        if (typeof gate.verdictRecord.summary === "string" && gate.verdictRecord.summary.trim() !== "") {
          prefixLines.push(`summary: ${oneLine(gate.verdictRecord.summary)}`);
        }
        if (typeof gate.verdictRecord.block_reason === "string" && gate.verdictRecord.block_reason.trim() !== "") {
          prefixLines.push(`block_reason: ${oneLine(gate.verdictRecord.block_reason)}`);
        }
      }
      prefixLines.push("");
      prefixLines.push("## Next actions");
      prefixLines.push("");
      prefixLines.push("1. amend the mission brief (resolve what `block_reason`/`summary` names) and start a new mission");
      prefixLines.push(`2. kusabi-companion luna-resume ${missionId} --audit-override ${gate.gateId} --audit-override-reason <reason> --audit-override-by <actor>`);
    } else {
      prefixLines.push("");
      prefixLines.push("## Next actions");
      prefixLines.push("");
      prefixLines.push("1. amend the mission brief (resolve what `block_reason`/`summary` names) and start a new mission");
    }
  } else if (disposition === "brief-correction-exhausted") {
    if (lastCorrectionDetail) {
      prefixLines.push("");
      prefixLines.push("## Last brief correction");
      prefixLines.push("");
      prefixLines.push(String(lastCorrectionDetail).trimEnd());
    }
  } else if (disposition === "coordinator-failed") {
    if (lastCoordinatorErrorDetail) {
      prefixLines.push("");
      prefixLines.push("## Last coordinator error");
      prefixLines.push("");
      prefixLines.push(String(lastCoordinatorErrorDetail).trimEnd());
    }
  }

  // =========================================================================
  // New sections (clamped to MAX_LINE_LEN = 300)
  // =========================================================================
  const newSectionLines = [];

  // =========================================================================
  // ## Acceptance criteria
  // =========================================================================
  newSectionLines.push("## Acceptance criteria");
  newSectionLines.push("");

  const criteria = parseAcceptanceCriteria(briefText);
  const gates = Array.isArray(record?.auditGates) ? record.auditGates : [];

  // Track status and evidence for each criterion (used also in Residual risks)
  const criteriaStatusMap = new Map();

  if (criteria.length === 0) {
    newSectionLines.push("(no acceptance criteria recorded)");
  } else {
    for (const c of criteria) {
      let judgingGate = null;
      let criterionJudgement = null;
      for (let i = gates.length - 1; i >= 0; i--) {
        const g = gates[i];
        if (g?.verdictRecord && Array.isArray(g.verdictRecord.criteria)) {
          const match = g.verdictRecord.criteria.find((entry) => entry && entry.id === c.id);
          if (match) {
            judgingGate = g;
            criterionJudgement = match;
            break;
          }
        }
      }

      let status = "not checked";
      let role = null;
      let evPath = null;
      if (criterionJudgement) {
        if (criterionJudgement.status === "met") {
          status = "met";
        } else if (criterionJudgement.status === "not_met") {
          status = "not met";
        } else {
          status = "not checked";
        }

        if (criterionJudgement.evidence) {
          evPath = criterionJudgement.evidence;
          const envelope = judgingGate?.gateId ? gateEnvelopes?.[judgingGate.gateId] : null;
          if (envelope && Array.isArray(envelope.items)) {
            const item = envelope.items.find((it) => it && it.path === evPath);
            if (item && typeof item.role === "string") {
              role = item.role;
            }
          }
          if (!role) role = "unknown";
        }
      }

      criteriaStatusMap.set(c.id, { status, role, evPath, text: c.text });
    }

    const shownCriteria = criteria.slice(0, MAX_LIST_ITEMS);
    for (const c of shownCriteria) {
      const info = criteriaStatusMap.get(c.id);
      let evidencePart = "";
      if (info.evPath) {
        const roleLabel = info.role === "worker_report" ? "worker_report — claim, not measured" : info.role;
        evidencePart = ` — evidence: ${info.evPath} (${roleLabel})`;
      }
      const textPart = c.text ? ` — ${truncateText(c.text, 120)}` : "";
      newSectionLines.push(`- ${c.id}: ${info.status}${evidencePart}${textPart}`);
    }

    if (criteria.length > MAX_LIST_ITEMS) {
      const remaining = criteria.length - MAX_LIST_ITEMS;
      newSectionLines.push(`  (+${remaining} more in brief)`);
    }
  }

  // =========================================================================
  // ## Sol
  // =========================================================================
  newSectionLines.push("");
  newSectionLines.push("## Sol");
  newSectionLines.push("");

  if (gates.length === 0) {
    newSectionLines.push("(no audit gates recorded)");
  } else {
    for (const g of gates) {
      if (!g || typeof g !== "object") continue;
      const gateId = g.gateId || "unknown";
      const phase = typeof g.phase === "string" ? g.phase : "?";
      const origin = typeof g.origin === "string" ? g.origin : "not recorded";
      const verdict = typeof g.verdict === "string" ? g.verdict : "none";
      const shadow = typeof g.shadowDisposition === "string" ? g.shadowDisposition : "not recorded";

      newSectionLines.push(`- ${gateId} (phase: ${phase}, origin: ${origin}, verdict: ${verdict})`);
      if (g.verdictRecord && typeof g.verdictRecord === "object" && typeof g.verdictRecord.summary === "string" && g.verdictRecord.summary.trim() !== "") {
        newSectionLines.push(`  summary: ${truncateText(g.verdictRecord.summary)}`);
      }
      newSectionLines.push(`  shadow disposition: ${shadow} — counterfactual: what this gate would have resolved to if the Sol seat had returned no verdict; never applied`);

      if (Array.isArray(g.verdictRecord?.invariants)) {
        const notHeld = g.verdictRecord.invariants.filter((inv) => inv && inv.held === false);
        if (notHeld.length > 0) {
          newSectionLines.push("  invariants not held:");
          const shownInv = notHeld.slice(0, MAX_LIST_ITEMS);
          for (const inv of shownInv) {
            const findingText = truncateText(inv.finding || "not held");
            newSectionLines.push(`    - ${inv.id}: ${findingText}`);
          }
          if (notHeld.length > MAX_LIST_ITEMS) {
            newSectionLines.push(`    (+${notHeld.length - MAX_LIST_ITEMS} more)`);
          }
        }
      }

      if (Array.isArray(g.findings) && g.findings.length > 0) {
        newSectionLines.push("  findings:");
        const shownFindings = g.findings.slice(0, MAX_LIST_ITEMS);
        for (const f of shownFindings) {
          newSectionLines.push(`    - ${truncateText(formatFinding(f))}`);
        }
        if (g.findings.length > MAX_LIST_ITEMS) {
          const remaining = g.findings.length - MAX_LIST_ITEMS;
          newSectionLines.push(`    (+${remaining} more in mission.json auditGates)`);
        }
      }
    }
  }

  // =========================================================================
  // ## Chains
  // =========================================================================
  newSectionLines.push("");
  newSectionLines.push("## Chains");
  newSectionLines.push("");

  const chainIdList = [];
  const seenCids = new Set();
  const addCid = (cid) => {
    if (typeof cid === "string" && cid && !seenCids.has(cid)) {
      seenCids.add(cid);
      chainIdList.push(cid);
    }
  };
  if (Array.isArray(record?.chains)) {
    for (const cid of record.chains) addCid(cid);
  }
  if (Array.isArray(record?.attempts)) {
    for (const att of record.attempts) {
      addCid(att?.chainId ?? att?.postChain?.chainId);
    }
  }
  if (chains && typeof chains === "object") {
    for (const cid of Object.keys(chains)) addCid(cid);
  }

  if (chainIdList.length === 0) {
    newSectionLines.push("(no chains recorded)");
  } else {
    for (const cid of chainIdList) {
      const chainJson = chains ? chains[cid] : null;
      if (!chainJson || typeof chainJson !== "object") {
        newSectionLines.push(`- ${cid}: chain.json unreadable`);
        continue;
      }

      const records = Array.isArray(chainJson.records) ? chainJson.records : [];
      const implSeats = [...new Set(records.map((r) => r?.modelEntry).filter(Boolean))].join(", ") || "none";
      const revSeats = [...new Set(records.map((r) => r?.reviewModelEntry).filter(Boolean))].join(", ") || "none";

      let fallbackCount = 0;
      for (const r of records) {
        if (Array.isArray(r?.fallbacks)) fallbackCount += r.fallbacks.length;
        else if (typeof r?.fallbacks === "number") fallbackCount += r.fallbacks;
        if (Array.isArray(r?.reviewFallbacks)) fallbackCount += r.reviewFallbacks.length;
        else if (typeof r?.reviewFallbacks === "number") fallbackCount += r.reviewFallbacks;
      }

      const rounds = records.length;
      const terminal = records[records.length - 1];
      let finalDisp = "unknown";
      if (terminal?.disposition) {
        finalDisp = typeof terminal.disposition === "object"
          ? (terminal.disposition.disposition || "unknown")
          : String(terminal.disposition);
      } else if (chainJson.disposition) {
        finalDisp = typeof chainJson.disposition === "object"
          ? (chainJson.disposition.disposition || "unknown")
          : String(chainJson.disposition);
      }

      let rawProbes = Array.isArray(terminal?.probeResults) && terminal.probeResults.length > 0
        ? terminal.probeResults
        : null;

      if (!rawProbes && Array.isArray(record?.attempts)) {
        const matchingAttempt = record.attempts.find(
          (a) => (a?.chainId === cid || a?.postChain?.chainId === cid) && Array.isArray(a?.postChain?.probeResults)
        );
        if (matchingAttempt?.postChain?.probeResults) {
          rawProbes = matchingAttempt.postChain.probeResults;
        }
      }

      let probesCompact = "(no probes)";
      if (Array.isArray(rawProbes) && rawProbes.length > 0) {
        const tokens = [];
        for (const p of rawProbes) {
          if (!p || typeof p !== "object") continue;
          const name = typeof p.probe === "string" ? p.probe : "";
          const m = name.match(/^(P\d+)/i);
          const tok = m ? m[1] : (name ? name.split(/[\s:]/)[0] : "probe");
          const mark = p.passed === true ? "✓" : "✗";
          tokens.push(`${tok} ${mark}`);
        }
        if (tokens.length > 0) probesCompact = tokens.join(" ");
      }

      newSectionLines.push(
        `- ${cid}: implement: ${implSeats}, review: ${revSeats}, fallbacks: ${fallbackCount}, rounds: ${rounds}, disposition: ${finalDisp}, probes: ${probesCompact}`
      );
    }
  }

  // =========================================================================
  // ## Diff stat
  // =========================================================================
  newSectionLines.push("");
  newSectionLines.push("## Diff stat");
  newSectionLines.push("");

  const attempts = Array.isArray(record?.attempts) ? record.attempts : [];
  if (attempts.length === 0) {
    newSectionLines.push("(no diff recorded)");
  } else {
    for (let i = 0; i < attempts.length; i++) {
      const att = attempts[i];
      const attemptIdx = att?.index ?? (i + 1);
      const cid = att?.chainId ?? att?.postChain?.chainId ?? "unknown";
      const postChain = att?.postChain;

      if (!postChain || typeof postChain !== "object") {
        newSectionLines.push(`- attempt ${attemptIdx} (${cid}): post-chain evidence unavailable`);
        continue;
      }
      if (postChain.unavailable) {
        newSectionLines.push(`- attempt ${attemptIdx} (${cid}): post-chain evidence unavailable (${postChain.unavailable})`);
        continue;
      }
      if (postChain.diffUnavailable) {
        newSectionLines.push(`- attempt ${attemptIdx} (${cid}): diff unavailable (${postChain.diffUnavailable})`);
        continue;
      }

      const stat = computeDiffStat(postChain.diff || "", postChain.untrackedIncluded);
      let newFilesPart = "";
      if (stat.newFilesCount > 0) {
        newFilesPart = `, ${stat.newFilesCount} new file${stat.newFilesCount === 1 ? "" : "s"}`;
      }
      let truncPart = "";
      if (postChain.diffTruncated === true) {
        truncPart = " (truncated: stat is partial)";
      }

      newSectionLines.push(
        `- attempt ${attemptIdx} (${cid}): ${stat.filesCount} file${stat.filesCount === 1 ? "" : "s"} changed, +${stat.additions}/-${stat.deletions} lines${newFilesPart}${truncPart}`
      );
    }
  }

  // =========================================================================
  // ## Residual risks / not verified
  // =========================================================================
  newSectionLines.push("");
  newSectionLines.push("## Residual risks / not verified");
  newSectionLines.push("");

  const risks = [];

  // 1. Criteria not checked (one line for all not-checked criteria, capped at 8 IDs)
  const notCheckedIds = [];
  for (const c of criteria) {
    const info = criteriaStatusMap.get(c.id);
    if (info && info.status === "not checked") {
      notCheckedIds.push(c.id);
    }
  }
  if (notCheckedIds.length > 0) {
    let idListStr = notCheckedIds.slice(0, MAX_LIST_ITEMS).join(", ");
    if (notCheckedIds.length > MAX_LIST_ITEMS) {
      idListStr += ` (+${notCheckedIds.length - MAX_LIST_ITEMS} more)`;
    }
    risks.push(`- criteria not checked: ${idListStr}`);
  }

  // 2. Criteria resting on worker claim only (one line for all worker_report criteria, capped at 8 IDs)
  const workerClaimIds = [];
  for (const c of criteria) {
    const info = criteriaStatusMap.get(c.id);
    if (info && info.role === "worker_report") {
      workerClaimIds.push(c.id);
    }
  }
  if (workerClaimIds.length > 0) {
    let idListStr = workerClaimIds.slice(0, MAX_LIST_ITEMS).join(", ");
    if (workerClaimIds.length > MAX_LIST_ITEMS) {
      idListStr += ` (+${workerClaimIds.length - MAX_LIST_ITEMS} more)`;
    }
    risks.push(
      `- criteria resting on a worker claim only (worker_report — claim, not measured): ${idListStr}`
    );
  }

  // 3. Invariants not held
  for (const g of gates) {
    if (Array.isArray(g?.verdictRecord?.invariants)) {
      for (const inv of g.verdictRecord.invariants) {
        if (inv && inv.held === false) {
          risks.push(`- gate ${g.gateId}: invariant ${inv.id} not held: ${truncateText(inv.finding || "not held", 100)}`);
        }
      }
    }
  }

  // 4. Gates whose verdict is missing
  for (const g of gates) {
    if (g && (g.verdict === null || g.verdict === undefined || g.verdict === "none")) {
      risks.push(`- gate ${g.gateId}: verdict missing (${g.reason || "no verdict recorded"})`);
    }
  }

  // 5. Truncated/unavailable diffs
  for (let i = 0; i < attempts.length; i++) {
    const att = attempts[i];
    const attemptIdx = att?.index ?? (i + 1);
    const postChain = att?.postChain;
    if (!postChain || typeof postChain !== "object") {
      risks.push(`- attempt ${attemptIdx}: post-chain evidence unavailable`);
    } else if (postChain.unavailable) {
      risks.push(`- attempt ${attemptIdx}: post-chain evidence unavailable (${postChain.unavailable})`);
    } else if (postChain.diffUnavailable) {
      risks.push(`- attempt ${attemptIdx}: diff unavailable (${postChain.diffUnavailable})`);
    } else if (postChain.diffTruncated === true) {
      risks.push(`- attempt ${attemptIdx}: diff was truncated (stat is partial)`);
    }
  }

  // 6. Chains unreadable
  for (const cid of chainIdList) {
    if (!chains || !chains[cid] || typeof chains[cid] !== "object") {
      risks.push(`- chain ${cid}: chain.json unreadable`);
    }
  }

  // Cap the whole section at 12 lines plus the fixed live-server line, with a (+K more …) line when exceeded
  if (risks.length > MAX_SECTION_RISKS) {
    const shownRisks = risks.slice(0, MAX_SECTION_RISKS);
    const remaining = risks.length - MAX_SECTION_RISKS;
    newSectionLines.push(...shownRisks);
    newSectionLines.push(`  (+${remaining} more …)`);
  } else {
    newSectionLines.push(...risks);
  }

  // 7. Fixed driver line
  newSectionLines.push("- live-server / real-client behaviour: not exercised by any seat — host check");

  // =========================================================================
  // ## Evidence
  // =========================================================================
  newSectionLines.push("");
  newSectionLines.push("## Evidence");
  newSectionLines.push("");
  newSectionLines.push("Paths are relative to this file.");
  newSectionLines.push("");

  newSectionLines.push("- mission record: mission.json");
  newSectionLines.push("- evidence directory: evidence/");
  if (chainIdList.length > 0) {
    for (const cid of chainIdList) {
      newSectionLines.push(`- chain ${cid}: ../../chains/${cid}/`);
    }
  } else {
    newSectionLines.push("- chains directory: ../../chains/");
  }

  const clampedNewSectionLines = newSectionLines.map((line) => clampLine(line));
  return [...prefixLines, "", ...clampedNewSectionLines].join("\n") + "\n";
}
