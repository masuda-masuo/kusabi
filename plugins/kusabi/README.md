# Kusabi

## install-agents

`kusabi install-agents` writes phase agents and the install profile marker into the active mode's configuration directory:

- Default mode: `$KUSABI_STATE_DIR/opencode-mode/default/agent`
- Free mode: `$KUSABI_STATE_DIR/opencode-mode/free/agent`

The serve sets `OPENCODE_CONFIG_DIR` to the matching mode directory. `XDG_CONFIG_HOME` remains shared, so OpenCode configuration and skills continue to use the shared config home. `OPENCODE_AGENT_DIR` can override the agent install destination.

### Migrate existing shared agents

After upgrading, remove old kusabi agent files from the shared agent directory once both mode directories have been rebuilt. Do not migrate while work is active.

The shared agent directory is the one the guard checks: `$KUSABI_OPENCODE_CONFIG_HOME/opencode/agent` when that variable is set, otherwise `${KUSABI_STATE_DIR:-$HOME/.kusabi}/opencode-config/opencode/agent`. Set `SHARED_CONFIG` to the config home that contains that `opencode/` directory (the same value without the trailing `/opencode/agent`).

1. Confirm that no serve, job or chain is running.
2. Back up the shared agent directory: `cp -a "$SHARED_CONFIG/opencode/agent" "$SHARED_CONFIG/opencode/agent.bak"`.
3. Rebuild both mode directories with the current code:

   ```sh
   kusabi install-agents
   KUSABI_OPENCODE_FREE_WORKER=1 kusabi install-agents
   ```

4. Remove only kusabi agent files and the install profile marker from the shared directory:

   ```sh
   rm -f "$SHARED_CONFIG/opencode/agent"/kusabi-*.md "$SHARED_CONFIG/opencode/agent/.kusabi-install-profile.json"
   ```

5. Confirm each mode sees its own agents. Both commands read the shared config home for everything except agents:

   ```sh
   XDG_CONFIG_HOME="$SHARED_CONFIG" OPENCODE_CONFIG_DIR="$KUSABI_STATE_DIR/opencode-mode/default" opencode agent list
   XDG_CONFIG_HOME="$SHARED_CONFIG" KUSABI_OPENCODE_FREE_WORKER=1 OPENCODE_CONFIG_DIR="$KUSABI_STATE_DIR/opencode-mode/free" opencode agent list
   ```

   If `KUSABI_STATE_DIR` is unset, use `$HOME/.kusabi` in its place, as in the paths above.

The serve refuses to start while kusabi agent files remain in the shared agent directory. User-named agents there do not block startup.
