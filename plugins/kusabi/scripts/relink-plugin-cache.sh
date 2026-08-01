#!/usr/bin/env bash
# Keep the Claude Code plugin cache a symlink to the kusabi working copy.
#
# Why: the plugin cache is a snapshot COPY taken at install time; it does not
# follow the repository even when the marketplace source is a local directory
# (merging kusabi#80 did not surface the delegate skill until the cache was
# relinked). Reinstalling via /plugin turns the symlink back into a real copy,
# frozen at that moment.
#
# Idempotent: exits 0 silently when the correct symlink is already in place.
# Safe to call from a SessionStart hook.

set -euo pipefail

# Resolve the working copy from this script's own real location
# (<repo>/plugins/kusabi/scripts/...), so no machine-specific path is needed.
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
PLUGIN_SRC="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
CACHE_DIR="${KUSABI_PLUGIN_CACHE:-$HOME/.claude/plugins/cache/kusabi/kusabi}"

# Running from a frozen snapshot inside the cache: relinking the cache to
# itself would be meaningless. Point KUSABI_REPO at the working copy instead.
case "$PLUGIN_SRC" in
  "$CACHE_DIR"/*)
    if [ -n "${KUSABI_REPO:-}" ] && [ -d "$KUSABI_REPO/plugins/kusabi" ]; then
      PLUGIN_SRC="$KUSABI_REPO/plugins/kusabi"
    else
      echo "relink-plugin-cache: running from the cache snapshot and KUSABI_REPO is not set; cannot locate the working copy" >&2
      exit 1
    fi
    ;;
esac

MANIFEST="$PLUGIN_SRC/.claude-plugin/plugin.json"
[ -f "$MANIFEST" ] || { echo "relink-plugin-cache: no plugin manifest at $MANIFEST" >&2; exit 1; }

VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MANIFEST" | head -1)
[ -n "$VERSION" ] || { echo "relink-plugin-cache: could not read version from $MANIFEST" >&2; exit 1; }

LINK="$CACHE_DIR/$VERSION"

# Already the correct symlink.
if [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$PLUGIN_SRC" ]; then
  exit 0
fi

mkdir -p "$CACHE_DIR"

# A real directory here is the snapshot /plugin made. Move it aside rather
# than delete it: the diff is occasionally wanted, and keeping it is cheaper
# than regretting it.
if [ -e "$LINK" ] && [ ! -L "$LINK" ]; then
  mv "$LINK" "$LINK.snapshot-bak-$(date +%Y%m%d%H%M%S)"
  echo "kusabi plugin: moved the snapshot aside and relinked to the working copy ($LINK)"
elif [ -L "$LINK" ]; then
  rm "$LINK"
  echo "kusabi plugin: redirected the symlink to the working copy ($LINK)"
else
  echo "kusabi plugin: no cache entry existed; linked it to the working copy ($LINK)"
fi

ln -s "$PLUGIN_SRC" "$LINK"
