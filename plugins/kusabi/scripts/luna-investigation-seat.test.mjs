// luna-investigation-seat.test.mjs — kusabi #609 acceptance tests
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultInvestigationDispatch } from "./luna-driver.mjs";
import { dispatchTaskJob } from "./task-cmd.mjs";
import { dispatchWithFallback, resetFailedRoutes } from "./prompt-execution.mjs";

const BRIEF = [
  "Orchestrator: gpt-5.6-sol | session luna-investigation-seat-test | 2026-09-27",
  "",
  "## Deliverables",
  "",
  "- `plugins/kusabi/scripts/luna-driver.mjs` — guard investigation dispatch.",
  "",
  "## Smoke",
  "",
  "- `node --test plugins/kusabi/scripts/luna-investigation-seat.test.mjs`",
].join("\n");

const CONFIG = {
  models: {
    phases: {
      plan: ["agy/cheap", "codex/gpt-5.6-luna"],
    },
  },
};

function job(status, overrides = {}) {
  return {
    id: overrides.id ?? `job-${status}`,
    kind: "task",
    status,
    modelEntry: null,
    modelVariant: null,
    error: null,
    failure: null,
    retry: null,
    fallbacks: null,
    usage: null,
    stats: { steps: 0 },
    ...overrides,
  };
}

function makeWalker(calls, outcome) {
  return (options) => dispatchWithFallback({
    ...options,
    _backendDispatch: (backend) => async (backendOptions) => {
      calls.push({ backend, options: backendOptions });
      return outcome(backend, backendOptions);
    },
  });
}

function terminalFailure(backend) {
  return {
    job: job("provider-error", {
      id: `${backend}-capacity`,
      error: "capacity exhausted",
      retry: { terminal: true, reason: "capacity", attempt: 1, message: "capacity exhausted" },
    }),
    resultText: "",
    stateDir: null,
  };
}

async function poisonConfiguredRoutes() {
  const calls = [];
  const dispatch = makeWalker(calls, (backend) => terminalFailure(backend));
  await dispatch({
    tiers: CONFIG.models.phases.plan,
    round: 1,
    kind: "task",
    promptText: BRIEF,
  });
  return calls;
}

describe("luna investigation seat exclusion (#609)", () => {
  let root;
  let cwd;
  let previousStateDir;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "kusabi-luna-seat-"));
    cwd = path.join(root, "work");
    fs.mkdirSync(cwd, { recursive: true });
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "config.json"), JSON.stringify(CONFIG), "utf8");
    previousStateDir = process.env.KUSABI_STATE_DIR;
    process.env.KUSABI_STATE_DIR = stateDir;
    resetFailedRoutes();
  });

  afterEach(() => {
    resetFailedRoutes();
    if (previousStateDir === undefined) delete process.env.KUSABI_STATE_DIR;
    else process.env.KUSABI_STATE_DIR = previousStateDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps investigation diagnostics after every route has already failed", async () => {
    const priorCalls = await poisonConfiguredRoutes();
    assert.deepEqual(priorCalls.map(({ backend }) => backend), ["agy", "codex"]);

    const investigationCalls = [];
    const dispatch = makeWalker(investigationCalls, (backend) => terminalFailure(backend));

    await assert.rejects(
      defaultInvestigationDispatch({
        cwd,
        brief: BRIEF,
        container: "test-container",
        _dispatch: dispatch,
      }),
      (error) => {
        assert.match(error.message, /^investigation has no non-codex seat available/);
        assert.ok(error.message.includes("agy/cheap"));
        assert.ok(error.message.includes("codex/gpt-5.6-luna"));
        return true;
      },
    );
    assert.deepEqual(investigationCalls, []);
  });

  it("keeps the ordinary generic error after every route has already failed", async () => {
    const priorCalls = await poisonConfiguredRoutes();
    assert.deepEqual(priorCalls.map(({ backend }) => backend), ["agy", "codex"]);

    const ordinaryCalls = [];
    const ordinary = makeWalker(ordinaryCalls, () => ({
      job: job("completed", { id: "unexpected-dispatch" }),
      resultText: "unexpected",
      stateDir: null,
    }));
    const result = await ordinary({
      tiers: CONFIG.models.phases.plan,
      round: 1,
      kind: "task",
      promptText: BRIEF,
    });

    assert.equal(result.job.error, "No available routes: all routes have failed or the chain is empty.");
    assert.deepEqual(ordinaryCalls, []);
  });

  it("does not dispatch the codex tail when every non-codex seat is exhausted", async () => {
    const calls = [];
    const dispatch = makeWalker(calls, () => ({
      job: job("provider-error", {
        id: "agy-capacity",
        error: "capacity exhausted",
        retry: { terminal: true, reason: "capacity", attempt: 1, message: "capacity exhausted" },
      }),
      resultText: "",
      stateDir: null,
    }));

    await assert.rejects(
      defaultInvestigationDispatch({
        cwd,
        brief: BRIEF,
        container: "test-container",
        _dispatch: dispatch,
      }),
      (error) => {
        assert.match(error.message, /investigation has no non-codex seat available/);
        assert.ok(error.message.includes("agy/cheap"));
        assert.ok(error.message.includes("codex/gpt-5.6-luna"));
        return true;
      },
    );
    assert.deepEqual(calls.map(({ backend }) => backend), ["agy"]);
  });

  it("records the successful non-codex job and requested/actual model", async () => {
    const calls = [];
    const dispatch = makeWalker(calls, (backend) => ({
      job: job("completed", { id: `job-${backend}` }),
      resultText: "## Fact sheet\n- relevant location",
      stateDir: null,
    }));

    const result = await defaultInvestigationDispatch({
      cwd,
      brief: BRIEF,
      container: "test-container",
      _dispatch: dispatch,
    });

    assert.deepEqual(calls.map(({ backend }) => backend), ["agy"]);
    assert.equal(result.jobId, "job-agy");
    assert.equal(result.requestedModel, "agy/cheap");
    assert.equal(result.actualModel, "agy/cheap");
    assert.equal(result.body, "## Fact sheet\n- relevant location");
  });

  it("keeps codex fallback available to an ordinary plan task", async () => {
    const calls = [];
    const dispatch = makeWalker(calls, (backend) => backend === "agy"
      ? {
          job: job("provider-error", {
            id: "agy-capacity",
            error: "capacity exhausted",
            retry: { terminal: true, reason: "capacity", attempt: 1, message: "capacity exhausted" },
          }),
          resultText: "",
          stateDir: null,
        }
      : {
          job: job("completed", { id: "codex-tail" }),
          resultText: "ordinary task result",
          stateDir: null,
        });

    const result = await dispatchTaskJob(
      cwd,
      { flags: { phase: "plan", container: "test-container" }, text: BRIEF, _dispatch: dispatch },
      {},
    );

    assert.deepEqual(calls.map(({ backend }) => backend), ["agy", "codex"]);
    assert.equal(result.job.id, "codex-tail");
    assert.equal(result.job.modelEntry, "codex/gpt-5.6-luna");
  });
});
