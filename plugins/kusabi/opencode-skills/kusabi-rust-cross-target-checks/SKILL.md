---
name: kusabi-rust-cross-target-checks
description: Use when a Rust change touches code behind #[cfg(...)] gates (target_os, windows, unix, or feature flags) and you are about to state that it compiles. A green cargo check on this host says nothing about branches whose cfg predicate is false here.
---

# Verifying cfg-gated Rust code

`cargo check` and `cargo build` compile only the branches whose `cfg` predicates hold
for the current host and feature set. Code behind a predicate that is false is discarded
before type checking — it is never parsed as code. A green build on Linux therefore
proves nothing about a `#[cfg(windows)]` branch, and "I syntax-checked it" is false for
that branch.

## What to do

1. List the predicates your change touches:
   `rg '#\[cfg' <changed files>` — note each `target_os`, `windows`, `unix`,
   `feature = "..."`.
2. For target gates, add the target and check against it:
   - `rustup target add x86_64-pc-windows-msvc`
   - `cargo check --target x86_64-pc-windows-msvc`
3. For feature gates, enable them explicitly:
   - `cargo check --features <name>`
   - `cargo check --all-features`
4. Report the exact command and its output for each branch you checked.

## What not to do

- Do not claim a gated branch compiles because the crate builds on this host.
- Do not delete, widen, or weaken a `cfg` predicate to make something build.
- If a branch cannot be built here (no network for `rustup target add`, missing
  toolchain), report it as **unverified with the reason**. An honest "unverified" is an
  acceptable outcome; a false claim is not.
