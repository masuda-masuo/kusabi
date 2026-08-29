// In-tree review-eval task: null-deref.
// A single planted bug: property access on a value that can be null/undefined.

export function getUserName(user) {
  // BUG: `user` may be null/undefined, so `user.profile` throws.
  return user.profile.name;
}
