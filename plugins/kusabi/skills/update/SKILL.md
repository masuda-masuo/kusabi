---
name: update
description: Reflect a merged kusabi change into the running local installation (pull, stop serve, redistribute agents, relink the plugin cache). Load after merging any kusabi PR.
---

# Updating a live kusabi installation

**Merging changes nothing by itself.** Every running surface reads the local working
copy, and three places do not follow it on their own: the agent definitions distributed
to the opencode config directory (a copy), the Claude Code plugin cache (a snapshot
copy taken at install time), and an already-running serve process (holds the old
definitions in memory). Each keeps working quietly with stale content — that silence is
the dangerous part.

## Procedure (order matters)

1. **Pull the working copy** (`git pull --ff-only`). Everything starts here.
2. **Stop the running serve first** (`serve-stop`) — a live serve keeps the old agent
   definitions in memory.
3. **Redistribute agent definitions** (`install-agents`) — the installed files are
   copies.
4. **Relink the plugin cache**: run `<skill base>/../../scripts/relink-plugin-cache.sh`
   (shipped next to the companion). Idempotent — run it every time.

What is actually required depends on what changed:

| Changed | Required | Verify by |
|---|---|---|
| `scripts/*.mjs` | 1 only | `--help` shows the change |
| `opencode-agents/*.md` | 1 → 2 → 3 | grep the changed wording in the distributed copies |
| `skills/` `commands/` | 1 → 4 → **new session** | the skill list of a fresh session |
| `docs/` `README` | 1 only | — |

If unsure, do all of it — every step is idempotent and costs seconds.

## Traps

- **Reinstalling via `/plugin` replaces the symlink with a fresh snapshot copy**, which
  freezes at that moment. Re-run the relink script after any reinstall — or wire it
  into a SessionStart hook so it self-heals.
- **Plugin-delivered skill changes only become visible in a new session.**
- **Skipping steps 2–3 after an agent-definition change means workers run the old
  rules.** The symptom looks like "the constraint I wrote in the brief is not working"
  — do not blame the brief or the model before checking the distributed copies.

## Verify with your eyes

Confirm by file content, not by command success — `install-agents` reports that it
distributed, not that what it distributed is new. Grep the changed wording in the
distributed agent files; check that the cache entry is a symlink pointing at the
working copy.

Machine-specific overlays (extra repositories to pull, Node bootstrap, SessionStart
hooks) belong to each machine's own skill or notes, not here.
