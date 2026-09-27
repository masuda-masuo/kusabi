// min-max-or-null.mjs — Null-preserving min/max helpers for timestamp and metric aggregation.

/**
 * Returns the smaller of two numbers, treating null and undefined as absent.
 * If both values are nullish (null or undefined), returns null.
 * If one value is nullish, returns the other value.
 * If both values are present, returns Math.min(a, b).
 *
 * @param {number|null|undefined} a
 * @param {number|null|undefined} b
 * @returns {number|null}
 */
export function minOrNull(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.min(a, b);
}

/**
 * Returns the larger of two numbers, treating null and undefined as absent.
 * If both values are nullish (null or undefined), returns null.
 * If one value is nullish, returns the other value.
 * If both values are present, returns Math.max(a, b).
 *
 * @param {number|null|undefined} a
 * @param {number|null|undefined} b
 * @returns {number|null}
 */
export function maxOrNull(a, b) {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.max(a, b);
}
