// one-line.test.mjs — focused unit tests for oneLine helper.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { oneLine } from "./one-line.mjs";

describe("oneLine whitespace collapse helper", () => {
  describe("non-string inputs return empty string", () => {
    it("handles null and undefined", () => {
      assert.equal(oneLine(null), "");
      assert.equal(oneLine(undefined), "");
    });

    it("handles numbers and booleans", () => {
      assert.equal(oneLine(0), "");
      assert.equal(oneLine(42), "");
      assert.equal(oneLine(NaN), "");
      assert.equal(oneLine(true), "");
      assert.equal(oneLine(false), "");
    });

    it("handles objects, arrays, and symbols", () => {
      assert.equal(oneLine({}), "");
      assert.equal(oneLine([]), "");
      assert.equal(oneLine(Symbol("test")), "");
      assert.equal(oneLine(() => {}), "");
    });
  });

  describe("CRLF / CR / LF line terminators", () => {
    it("replaces CRLF with a single space", () => {
      assert.equal(oneLine("hello\r\nworld"), "hello world");
    });

    it("replaces CR with a single space", () => {
      assert.equal(oneLine("hello\rworld"), "hello world");
    });

    it("replaces LF with a single space", () => {
      assert.equal(oneLine("hello\nworld"), "hello world");
    });

    it("collapses mixed line endings and consecutive breaks", () => {
      assert.equal(oneLine("a\r\nb\rc\nd"), "a b c d");
      assert.equal(oneLine("line 1\r\n\r\nline 2\n\n\rline 3"), "line 1 line 2 line 3");
    });
  });

  describe("tabs and runs of spaces", () => {
    it("replaces tabs with spaces", () => {
      assert.equal(oneLine("hello\tworld"), "hello world");
      assert.equal(oneLine("a\t\tb"), "a b");
    });

    it("collapses multiple consecutive spaces into a single space", () => {
      assert.equal(oneLine("hello    world"), "hello world");
    });

    it("collapses mixed tabs, spaces, and newlines into a single space", () => {
      assert.equal(oneLine("foo \t \r\n \t bar"), "foo bar");
    });
  });

  describe("leading and trailing whitespace", () => {
    it("trims leading whitespace", () => {
      assert.equal(oneLine("   hello"), "hello");
      assert.equal(oneLine("\r\n\t  hello"), "hello");
    });

    it("trims trailing whitespace", () => {
      assert.equal(oneLine("hello   "), "hello");
      assert.equal(oneLine("hello \t\r\n"), "hello");
    });

    it("trims both leading and trailing whitespace", () => {
      assert.equal(oneLine("   \t hello world \r\n  "), "hello world");
    });

    it("returns empty string for whitespace-only input", () => {
      assert.equal(oneLine(""), "");
      assert.equal(oneLine("   "), "");
      assert.equal(oneLine("\r\n\t  \r  \n"), "");
    });
  });

  describe("already-clean strings", () => {
    it("preserves single-word string unchanged", () => {
      assert.equal(oneLine("word"), "word");
    });

    it("preserves already-clean single-space separated strings unchanged", () => {
      assert.equal(oneLine("already clean single line"), "already clean single line");
    });
  });
});
