// dashboard-html.test.mjs — pure renderers over collector-shaped fixtures.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { esc, renderChainHtml, renderIndexHtml } from "./dashboard-html.mjs";

const META = (source, denominator) => ({
  source,
  denominator,
  generatedAt: "2026-08-22T12:00:00.000Z",
});

function indexFixture() {
  return {
    now: Date.parse("2026-08-22T09:22:00.000Z"),
    query: { limit: 30 },
    running: {
      meta: META("running source", "running denominator"),
      chains: [{
        workspace: "aaaa11111111",
        cwd: "/tmp/ws-a",
        chainId: "chain-<script>alert(1)</script>",
        round: 2,
        maxRounds: 4,
        backend: "opencode",
        model: "opencode/test",
        startedAt: "2026-08-22T09:00:00.000Z",
        lastProgressAt: "2026-08-22T09:10:00.000Z",
        idleSeconds: 720,
        pidAlive: false,
        stalled: true,
        status: "stale",
      }],
    },
    ended: {
      meta: META("ended source", "ended denominator"),
      chains: [
        {
          workspace: "aaaa11111111",
          cwd: "/tmp/ws-a",
          chainId: "chain-quota",
          finishedAt: "2026-08-22T13:00:00.000Z",
          rounds: 1,
          disposition: "escalate",
          failureClass: "provider-error",
          failureDetail: "Individual quota reached. Resets in 2h.",
          tokens: { input: 10, output: 20, cost: 0.01 },
        },
        {
          workspace: "bbbb22222222",
          cwd: "/tmp/ws-b",
          chainId: "chain-empty",
          finishedAt: "2026-08-22T10:00:00.000Z",
          rounds: 1,
          disposition: "discard",
          failureClass: "empty-round",
          failureDetail: null,
          tokens: { input: 1, output: 2, cost: 0 },
        },
        {
          workspace: "aaaa11111111",
          cwd: "/tmp/ws-a",
          chainId: "chain-accept",
          finishedAt: "2026-08-22T16:00:00.000Z",
          rounds: 1,
          disposition: "accept",
          failureClass: "none",
          failureDetail: null,
          tokens: { input: 3, output: 4, cost: 0.02 },
        },
      ],
    },
    cost: {
      status: "missing",
      meta: META("cost source", "cost denominator"),
    },
    workspaces: {
      meta: META("ws source", "ws denominator"),
      workspaces: [
        {
          slug: "aaaa11111111",
          cwd: "/tmp/ws-a",
          chainCount: 3,
          jobCount: 2,
          serve: { present: true, pid: 1, alive: false, startedAt: "2026-08-22T08:00:00.000Z" },
        },
      ],
    },
  };
}

function chainFixture() {
  return {
    meta: META("chain source", "one chain identified by workspace slug and chain id"),
    status: "completed",
    chain: { chainId: "chain-x", briefTitle: "A brief" },
    control: { status: "completed" },
    rounds: [
      {
        round: 1,
        verdict: "approve",
        disposition: { disposition: "accept", reason: "approved" },
        probeResults: [
          { probe: "P1: HEAD clean", passed: true, detail: "clean" },
          { probe: "P2: verify gate", passed: true, detail: "green" },
          { probe: "P3: deliverables", passed: true, detail: "ok" },
          { probe: "P4: smoke", passed: false, detail: "smoke failed" },
          { probe: "P5: frozen", passed: true, detail: "ok" },
          { probe: "P6: collected", passed: true, detail: "2532" },
        ],
        worktreeChanged: true,
        implementRefusal: null,
        implementUsage: { input: 10, output: 20, cost: 0.01 },
      },
      {
        round: 2,
        verdict: "needs-attention",
        disposition: { disposition: "rework", reason: "findings" },
        probeResults: [
          { probe: "P1: HEAD clean", passed: true, detail: "still clean" },
          { probe: "P2: verify gate", passed: true, detail: "green" },
          { probe: "P3: deliverables", passed: true, detail: "ok" },
          { probe: "P4: smoke", passed: true, detail: "ok" },
          { probe: "P5: frozen", passed: true, detail: "ok" },
          { probe: "P6: collected", passed: true, detail: "2532" },
        ],
        worktreeChanged: true,
        implementRefusal: null,
        implementUsage: { input: 11, output: 21, cost: 0.02 },
      },
    ],
    jobs: {
      "job-1": { status: "completed", error: null },
      "job-2": { status: "failed", error: "<script>steal()</script> boom" },
    },
    digest: "SYNTHETIC DIGEST LINE",
  };
}

describe("esc", () => {
  it("neutralises <, &, and quotes", () => {
    assert.equal(
      esc(`<a b="c" d='e'>&</a>`),
      "&lt;a b=&quot;c&quot; d=&#39;e&#39;&gt;&amp;&lt;/a&gt;",
    );
    assert.equal(esc(null), "");
    assert.equal(esc(undefined), "");
  });
});

describe("renderIndexHtml", () => {
  it("renders four sections, stalled and provider-error badges, missing metrics, and escapes script text", () => {
    const html = renderIndexHtml(indexFixture());
    assert.match(html, /<h2>Running<\/h2>\s*<small>running source — running denominator<\/small>/);
    assert.match(html, /<h2>Ended \(last 30\)<\/h2>\s*<small>ended source — ended denominator<\/small>/);
    assert.match(html, /<h2>Cost<\/h2>\s*<small>cost source — cost denominator<\/small>/);
    assert.match(html, /<h2>Workspaces<\/h2>\s*<small>ws source — ws denominator<\/small>/);

    assert.match(html, /class="badge stalled">stalled/);
    const providerBadges = html.match(/class="badge fc-provider-error"/g) || [];
    assert.equal(providerBadges.length, 1);
    assert.match(html, /Individual quota reached/);
    assert.match(html, /metrics\.db missing/);
    assert.match(html, /metrics-ingest/);

    assert.equal(html.includes("<script>alert(1)</script>"), false);
    assert.match(html, /chain-&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });
});

describe("renderChainHtml", () => {
  it("shows one row per round with P1–P6 cells and the digest in pre", () => {
    const html = renderChainHtml(chainFixture());
    assert.match(html, /<td>1<\/td>/);
    assert.match(html, /<td>2<\/td>/);
    assert.match(html, /<th>P1<\/th>/);
    assert.match(html, /<th>P6<\/th>/);
    assert.match(html, /title="smoke failed">no<\/td>/);
    assert.match(html, /<pre>SYNTHETIC DIGEST LINE<\/pre>/);
    const p1ok = html.match(/title="clean">ok<\/td>/g) || [];
    assert.ok(p1ok.length >= 1);
    assert.equal(html.includes("<script>steal()</script>"), false);
    assert.match(html, /&lt;script&gt;steal\(\)&lt;\/script&gt;/);
  });

  it("renders a not-found page when the chain is missing", () => {
    const html = renderChainHtml({ error: "chain not found: aaaa/chain-nope" });
    assert.match(html, /Chain not found/);
    assert.match(html, /chain not found: aaaa\/chain-nope/);
  });
});
