// one-line.mjs — shared single-line whitespace collapse helper.

/**
 * Collapse internal whitespace runs and line breaks into single spaces,
 * and strip leading and trailing whitespace.
 *
 * Non-string inputs return an empty string.
 *
 * @param {*} value
 * @returns {string}
 */
export function oneLine(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\r?\n|\r/g, " ").replace(/\s+/g, " ").trim();
}
