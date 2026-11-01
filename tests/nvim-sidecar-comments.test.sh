#!/usr/bin/env bash
# Behavior tests for the sidecar-comments Neovim plugin
# (xdg/nvim/lua/custom/sidecar_comments.lua). Each tests/nvim/*.spec.lua runs in
# its own headless Neovim with the real config module, against the installed
# `sidecar` CLI and scratch files in a fresh temporary directory.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

command -v nvim >/dev/null || fail 'nvim is required'
command -v sidecar >/dev/null || fail 'the sidecar CLI is required (brew install trogers1/tap/sidecar)'

# Create and resolve the scratch directory in checked steps. In a single
# `$(cd "$(mktemp -d)" && pwd -P)` a failed mktemp leaves `cd ""`, which
# succeeds in the current directory, and the cleanup trap then deletes it.
# Explicit `|| fail` checks hold even where bash ignores `set -e`. The explicit
# template makes macOS mktemp honor TMPDIR as Linux does.
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nvim-sidecar-comments.XXXXXX")" || fail 'could not create a scratch directory'
{ [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; } || fail "mktemp returned '$TMP_DIR', not a directory"
TMP_DIR="$(cd "$TMP_DIR" && pwd -P)" || fail 'could not resolve the scratch directory'
trap 'rm -rf "$TMP_DIR"' EXIT

status=0
for spec in "$REPO_DIR"/tests/nvim/*.spec.lua; do
  name="$(basename "$spec" .spec.lua)"
  work="$TMP_DIR/$name"
  mkdir -p "$work/files" "$work/state"
  printf '== %s\n' "$name"
  # A spec that throws before finishing exits non-zero instead of leaving
  # Neovim waiting. Logs and state stay inside the scratch directory.
  if ! XDG_STATE_HOME="$work/state" NVIM_LOG_FILE="$work/nvim.log" \
    TEST_DIR="$work/files" NVIM_CONFIG="$REPO_DIR/xdg/nvim" \
    nvim --headless --clean -n \
      -c "lua local ok, err = xpcall(dofile, debug.traceback, [[$spec]]); if not ok then io.stderr:write(err .. '\n'); vim.cmd 'cq!' end" \
      </dev/null; then
    printf 'FAIL: %s\n' "$name" >&2
    status=1
  fi
done

exit "$status"
