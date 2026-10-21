export PATH="$HOME/bin:$PATH"

# Shared setup must work without the personal .zshenv/.zshrc. Keep Pi ahead
# of per-Node npm globals after version-manager directory/prompt hooks too.
# This directory contains only the Pi launcher; Node selection stays untouched.
if (( ! $+functions[prefer-managed-pi] )); then
  prefer-managed-pi() {
    local managed_pi_bin="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin"
    if [[ -x "$managed_pi_bin/pi" ]]; then
      typeset -gU path PATH
      path=("$managed_pi_bin" "${path[@]}")
    fi
  }
fi
autoload -Uz add-zsh-hook
add-zsh-hook chpwd prefer-managed-pi
add-zsh-hook precmd prefer-managed-pi
prefer-managed-pi

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
