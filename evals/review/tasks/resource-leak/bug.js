// In-tree review-eval task: resource-leak.
// A single planted bug: an opened resource not closed on the success path.

export function readConfig(path) {
  // BUG: `openFile` opens a handle that is never closed on the success path.
  const file = openFile(path);
  const data = file.read();
  return data;
}
