#!/usr/bin/env bash
# Help must work even when the dev state path cannot be opened or created.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV="$REPO_DIR/tmux_and_worktrees/bin/dev"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
printf 'not a directory\n' >"$TMP_DIR/state-is-a-file"
export XDG_STATE_HOME="$TMP_DIR/state-is-a-file"
for command_name in new open tree close kill merge switch; do
    for flag in --help -h; do
        output="$("$DEV" "$command_name" "$flag")"
        case "$output" in
            *'Usage: dev '*) ;;
            *) printf 'FAIL: dev %s %s did not print public usage\n' "$command_name" "$flag" >&2; exit 1 ;;
        esac
    done
done
[ "$(<"$TMP_DIR/state-is-a-file")" = 'not a directory' ]
printf 'dev read-only help tests passed\n'
