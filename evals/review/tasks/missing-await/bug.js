// In-tree review-eval task: missing-await.
// A single planted bug: an async result used without `await`.

export async function fetchCount() {
  // BUG: `fetch` returns a Promise; without `await`, `res` is a Promise and
  // `res.json()` is called on a Promise, not the Response.
  const res = fetch("/api/count");
  return res.json();
}
