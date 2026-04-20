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

# nvm: load fast, do not auto-switch on shell start
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" # --no-use
[ -s "$NVM_DIR/bash_completion" ] && . "$NVM_DIR/bash_completion"
# Auto-switch only when changing directories
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
# intentionally no initial `load-nvmrc` call

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

# go
# export PATH="/usr/local/go/bin:$PATH"

# >>> dev worktree dhome >>>
dhome() {
    local env_line=""
    local target=""

    if [ -z "${TMUX:-}" ]; then
        echo "dhome is only available in a tmux dev session"
        return 1
    fi

    env_line="$(tmux show-environment DTREE_WORKTREE_PATH 2>/dev/null || true)"
    case "$env_line" in
        DTREE_WORKTREE_PATH=*)
            target="${env_line#DTREE_WORKTREE_PATH=}"
            ;;
    esac

    if [ -z "$target" ]; then
        echo "dhome is only available in a tmux dev session"
        return 1
    fi

    cd "$target"
}
# <<< dev worktree dhome <<<
