#!/usr/bin/env bash
# Format gate for the Neovim config and its tests, using the config's own
# xdg/nvim/.stylua.toml. Set FIX=1 to rewrite files instead of checking.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# Prefer an explicit STYLUA, then PATH, then the copy Mason installs for the
# config's own conform.nvim setup.
STYLUA="${STYLUA:-$(command -v stylua || printf '%s' "$HOME/.local/share/nvim/mason/bin/stylua")}"
[ -x "$STYLUA" ] || fail "stylua not found at '$STYLUA'; install it (brew install stylua, or :MasonInstall stylua) or set STYLUA"

targets=("$REPO_DIR/xdg/nvim" "$REPO_DIR/tests/nvim")
config=(--config-path "$REPO_DIR/xdg/nvim/.stylua.toml")

if [ "${FIX:-0}" = 1 ]; then
  "$STYLUA" "${config[@]}" "${targets[@]}"
  printf 'stylua: formatted files\n'
else
  "$STYLUA" "${config[@]}" --check "${targets[@]}"
  printf 'stylua: all files formatted\n'
fi
