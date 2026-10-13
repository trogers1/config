#!/usr/bin/env bash
# Claude Code WorktreeCreate hook: creates the worktree with `dev tree` so
# Claude's worktrees follow dev's layout (<repo-parent>/<repo>-worktrees/<name>
# on branch <name>), run the project's worktree init script, and get a detached
# dev tmux session. Claude reads the last stdout line as the worktree path, so
# all other output goes to stderr; a non-zero exit fails the creation.
set -euo pipefail

# ~/.claude/hooks links to this directory, so resolve the physical path to
# find dev in the same checkout.
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEV="$HOOK_DIR/../../../tmux_and_worktrees/bin/dev"
# shellcheck source=hook-input.sh
. "$HOOK_DIR/hook-input.sh"
hook_add_homebrew_to_path

if [ ! -x "$DEV" ]; then
    echo "WorktreeCreate: dev is not executable at $DEV" >&2
    exit 1
fi

input="$(cat)"
name="$(hook_input_field "$input" name)"
cwd="$(hook_input_field "$input" cwd)"

cd "$cwd"
# The Claude session that asked for this worktree is already running, so the
# tmux agent window only gets `claude --continue` typed in. Pressing Enter there
# later resumes that conversation in the TUI, instead of a second conversation
# starting now in the same worktree. A project whose devConfig.jsonc has no
# agent window or no claude agent still gets its worktree, with a warning.
exec "$DEV" tree --no-attach --agent claude --stage-agent -- "$name"
