// In-tree review-eval task: off-by-one.
// A single planted bug: a loop bound that is wrong by one.

export function firstN(items, n) {
  const out = [];
  // BUG: should be `i < n`; `<= n` pushes one item too many (and a stray
  // `undefined` when n === items.length).
  for (let i = 0; i <= n; i++) {
    out.push(items[i]);
  }
  return out;
}
