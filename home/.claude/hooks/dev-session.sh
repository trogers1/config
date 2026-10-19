#!/usr/bin/env bash
# SessionStart metadata only: never open the transcript or inspect messages.
set -euo pipefail
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
. "$HOOK_DIR/hook-input.sh"
hook_add_homebrew_to_path
exec "$HOOK_DIR/../../../tmux_and_worktrees/bin/dev" _record-agent claude
