#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "$REPO_DIR/setup_symlinks.sh"
bash "$REPO_DIR/tmux_and_worktrees/setup.sh"

if command -v tmux >/dev/null 2>&1 && tmux ls >/dev/null 2>&1; then
  tmux source-file "$HOME/.tmux.conf"
  echo "Reloaded tmux config."
else
  echo "No tmux server running; reload later with: tmux source-file ~/.tmux.conf"
fi

echo "Open a new shell or run: source ~/.zprofile"
