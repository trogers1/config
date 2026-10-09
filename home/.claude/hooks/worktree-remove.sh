#!/usr/bin/env bash
# Claude Code WorktreeRemove hook: removes a worktree that worktree-create.sh
# made, with `dev kill`, which also closes its tmux session and deletes its
# branch. It never forces: a dirty worktree is refused and stays on disk, and an
# unmerged branch is kept. A non-zero exit leaves the worktree in place.
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEV="$HOOK_DIR/../../../tmux_and_worktrees/bin/dev"
# shellcheck source=hook-input.sh
. "$HOOK_DIR/hook-input.sh"

if [ ! -x "$DEV" ]; then
    echo "WorktreeRemove: dev is not executable at $DEV" >&2
    exit 1
fi

input="$(cat)"
worktree_path="$(hook_input_field "$input" worktree_path)"

if [ ! -d "$worktree_path" ]; then
    echo "WorktreeRemove: $worktree_path does not exist" >&2
    exit 1
fi

# dev kill finds the repository from its working directory.
cd "$worktree_path"
exec "$DEV" kill --yes -- "$worktree_path" </dev/null >&2
