export PATH="$HOME/bin:$PATH"

dev() {
  if [ "${1:-}" != "home" ]; then
    command dev "$@"
    return
  fi

  local env_line target
  [ -n "${TMUX:-}" ] || { echo "dev home is only available in a tmux dev session"; return 1; }
  env_line="$(tmux show-environment DTREE_WORKTREE_PATH 2>/dev/null || true)"
  target="${env_line#DTREE_WORKTREE_PATH=}"
  [ "$target" != "$env_line" ] && [ -n "$target" ] || { echo "dev home is only available in a tmux dev session"; return 1; }
  cd "$target"
}
