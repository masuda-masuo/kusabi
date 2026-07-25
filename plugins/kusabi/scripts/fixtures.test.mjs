import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFakeCallTool } from "./fixtures.mjs";

// Fixtures cannot self-check inside fixtures.mjs: that file must not match the
// test runner's discovery patterns, so it cannot call the test API.  This file
// is its paired test file and exists for that reason alone.
// ---------------------------------------------------------------------------

describe("createFakeCallTool (test fixture self-check)", () => {
  // Guards the guard: if the fake stopped reproducing truncation, every
  // runSmokeProbe test would pass against the pre-fix implementation
  // and prove nothing.
  it("hides the marker when the command is not redirected (the pre-fix bug)", async () => {
    const fakeTool = createFakeCallTool({ exitCode: 0 });
    const legacy = await fakeTool("sandbox_exec", {
      container_id: "fake-cid",
      commands: ["npm test; echo SMOKE_EXIT=$?"],
    });

    assert.equal(legacy.truncated, true);
    assert.ok(!legacy.output.includes("SMOKE_EXIT="));
  });

  it("keeps the marker when the command is redirected (the fix)", async () => {
    const fakeTool = createFakeCallTool({ exitCode: 0 });
    const fixed = await fakeTool("sandbox_exec", {
      container_id: "fake-cid",
      commands: ["( npm test ) >/tmp/kusabi-smoke-1234567890-0.log 2>&1; echo SMOKE_EXIT=$?"],
    });

    assert.equal(fixed.truncated, false);
    assert.ok(fixed.output.includes("SMOKE_EXIT=0"));
  });
});
