#!/usr/bin/env bash
# Claude Code WorktreeRemove hook: removes a worktree that worktree-create.sh
# made, with `dev kill`, which also closes its tmux session and deletes its
# branch. It never forces: a dirty worktree is refused and stays on disk, and an
# unmerged branch is kept. It succeeds whenever the worktree is gone, reporting
# a kept branch on stderr; a non-zero exit means the worktree is still there.
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEV="$HOOK_DIR/../../../tmux_and_worktrees/bin/dev"
# shellcheck source=hook-input.sh
. "$HOOK_DIR/hook-input.sh"
hook_add_homebrew_to_path

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
status=0
"$DEV" kill --yes -- "$worktree_path" </dev/null >&2 || status=$?
if [ "$status" -eq 0 ]; then
    exit 0
fi

# dev kill also exits non-zero after removing the worktree when git refuses to
# delete an unmerged branch; it has already named the kept branch on stderr.
if [ ! -e "$worktree_path" ]; then
    echo "WorktreeRemove: removed $worktree_path; its branch was kept" >&2
    exit 0
fi
exit "$status"
