// min-max-or-null.test.mjs — Unit tests for minOrNull and maxOrNull helpers

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { minOrNull, maxOrNull } from "./min-max-or-null.mjs";

describe("minOrNull", () => {
  it("returns null when both arguments are null", () => {
    assert.equal(minOrNull(null, null), null);
  });

  it("returns null when both arguments are undefined", () => {
    assert.equal(minOrNull(undefined, undefined), null);
  });

  it("returns null when arguments are a mix of null and undefined", () => {
    assert.equal(minOrNull(null, undefined), null);
    assert.equal(minOrNull(undefined, null), null);
  });

  it("returns the present value when either side is absent (null or undefined)", () => {
    assert.equal(minOrNull(42, null), 42);
    assert.equal(minOrNull(null, 42), 42);
    assert.equal(minOrNull(42, undefined), 42);
    assert.equal(minOrNull(undefined, 42), 42);
  });

  it("handles zero as a present value correctly", () => {
    assert.equal(minOrNull(0, null), 0);
    assert.equal(minOrNull(null, 0), 0);
    assert.equal(minOrNull(0, undefined), 0);
    assert.equal(minOrNull(undefined, 0), 0);
    assert.equal(minOrNull(0, 0), 0);
    assert.equal(minOrNull(0, 10), 0);
    assert.equal(minOrNull(10, 0), 0);
  });

  it("returns the minimum when both values are present", () => {
    assert.equal(minOrNull(5, 10), 5);
    assert.equal(minOrNull(10, 5), 5);
    assert.equal(minOrNull(7, 7), 7);
  });

  it("handles negative numbers correctly", () => {
    assert.equal(minOrNull(-10, -5), -10);
    assert.equal(minOrNull(-5, -10), -10);
    assert.equal(minOrNull(-5, 0), -5);
    assert.equal(minOrNull(0, -5), -5);
    assert.equal(minOrNull(-5, null), -5);
    assert.equal(minOrNull(null, -5), -5);
    assert.equal(minOrNull(-5, undefined), -5);
    assert.equal(minOrNull(undefined, -5), -5);
  });
});

describe("maxOrNull", () => {
  it("returns null when both arguments are null", () => {
    assert.equal(maxOrNull(null, null), null);
  });

  it("returns null when both arguments are undefined", () => {
    assert.equal(maxOrNull(undefined, undefined), null);
  });

  it("returns null when arguments are a mix of null and undefined", () => {
    assert.equal(maxOrNull(null, undefined), null);
    assert.equal(maxOrNull(undefined, null), null);
  });

  it("returns the present value when either side is absent (null or undefined)", () => {
    assert.equal(maxOrNull(42, null), 42);
    assert.equal(maxOrNull(null, 42), 42);
    assert.equal(maxOrNull(42, undefined), 42);
    assert.equal(maxOrNull(undefined, 42), 42);
  });

  it("handles zero as a present value correctly", () => {
    assert.equal(maxOrNull(0, null), 0);
    assert.equal(maxOrNull(null, 0), 0);
    assert.equal(maxOrNull(0, undefined), 0);
    assert.equal(maxOrNull(undefined, 0), 0);
    assert.equal(maxOrNull(0, 0), 0);
    assert.equal(maxOrNull(0, 10), 10);
    assert.equal(maxOrNull(10, 0), 10);
  });

  it("returns the maximum when both values are present", () => {
    assert.equal(maxOrNull(5, 10), 10);
    assert.equal(maxOrNull(10, 5), 10);
    assert.equal(maxOrNull(7, 7), 7);
  });

  it("handles negative numbers correctly", () => {
    assert.equal(maxOrNull(-10, -5), -5);
    assert.equal(maxOrNull(-5, -10), -5);
    assert.equal(maxOrNull(-5, 0), 0);
    assert.equal(maxOrNull(0, -5), 0);
    assert.equal(maxOrNull(-5, null), -5);
    assert.equal(maxOrNull(null, -5), -5);
    assert.equal(maxOrNull(-5, undefined), -5);
    assert.equal(maxOrNull(undefined, -5), -5);
  });
});
