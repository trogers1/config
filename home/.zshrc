# Make sure path only contains unique entries (dedupe):
# - PATH is the string form (/a:/b:/a), path is zsh’s array form (/a /b /a).
# - -U means “unique”: keep only the first occurrence of each entry, remove duplicates.
# - Because path and PATH are tied in zsh, applying it to both ensures dedupe whether you edit as array or string.
typeset -U path PATH

# Setting PATH for Python 3.10
# The original version is saved in .zprofile.pysave
if command -v python3.10 >/dev/null 2>&1; then
  python310_bin="$(python3.10 -c 'import sysconfig; print(sysconfig.get_path("scripts"))' 2>/dev/null)"
  if [ -n "$python310_bin" ] && [ -d "$python310_bin" ]; then
    export PATH="$python310_bin:$PATH"
  fi
fi

# >>> local bin path >>>
export PATH="$HOME/.local/bin:$HOME/bin:$PATH"
# <<< local bin path <<<

# Adding homebrew to the PATH
if [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [ -x /usr/local/bin/brew ]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

# nvm: load fast, start on an installed Node 24.x, then auto-switch by directory
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" --no-use
[ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"
# Ensure Node-based tools work in fresh shells/tmux panes.
nvm use --silent 24 >/dev/null 2>&1 || true
# Auto-switch by directory
autoload -U add-zsh-hook
load-nvmrc() {
  local nvmrc_path node_version nvmrc_node_version
  nvmrc_path="$(nvm_find_nvmrc)"
  if [ -n "$nvmrc_path" ]; then
    node_version="$(nvm version)"
    nvmrc_node_version="$(nvm version "$(cat "$nvmrc_path")")"
    if [ "$nvmrc_node_version" = "N/A" ]; then
      nvm install
    elif [ "$nvmrc_node_version" != "$node_version" ]; then
      nvm use
    fi
  fi
}
add-zsh-hook chpwd load-nvmrc
load-nvmrc

# pyenv lazy loader (only initializes when first used)
if command -v pyenv >/dev/null 2>&1; then
  pyenv() {
    unset -f pyenv
    eval "$(command pyenv init -)"
    pyenv "$@"
  }
fi

# bun completions
[ -s "$HOME/.bun/_bun" ] && source "$HOME/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# opencode
export PATH="$HOME/.opencode/bin:$PATH"

# rancher-desktop
export PATH="$HOME/.rd/bin:$PATH"
# Rancher Desktop uses a per-user Docker socket; Docker Desktop works via its default socket.
if [[ -z "${DOCKER_HOST:-}" && -S "$HOME/.rd/docker.sock" ]]; then
   # https://docs.rancherdesktop.io/how-to-guides/using-testcontainers/
  export DOCKER_HOST="unix://$HOME/.rd/docker.sock"
  export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
  export TESTCONTAINERS_HOST_OVERRIDE=$(rdctl info --field ip-address)
  export TESTCONTAINERS_RYUK_DISABLED=true
fi

# go
# export PATH="/usr/local/go/bin:$PATH"

# Worktree shell integration. The `dev` command handles workflow actions;
# `dev home` returns this shell to the worktree associated with its tmux session.
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
