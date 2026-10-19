#!/usr/bin/env bash
# fzf owns this reload process group (and cancels it on toggle/exit).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$SCRIPT_DIR/lib/tmux_worktree.sh"
source "$SCRIPT_DIR/lib/dev_inventory.sh"
root="$DEV_PICKER_DIR"
stage="$(mktemp -d "$root/reload.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
if tmux_worktree_inventory picker >"$stage/raw" 2>"$stage/error" &&
    python3 "$SCRIPT_DIR/lib/dev_picker_format.py" "$stage/raw" a >"$stage/display" 2>>"$stage/error"; then
    mv "$stage/raw" "$root/all.raw"
    mv "$stage/display" "$root/all"
    rm -f "$root/error"
    cat "$root/all"
else
    # Always complete the reload so load clears Loading, including failures.
    # Details are printed by the public CLI on exit; the UI gives a safe action.
    mv "$stage/error" "$root/error"
    rm -f "$root/all.raw" "$root/all"
    printf 'ID\tUnable to load available sessions/worktrees\n'
fi
