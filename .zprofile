# Make sure path only contains unique entries (dedupe):
# - PATH is the string form (/a:/b:/a), path is zsh’s array form (/a /b /a).
# - -U means “unique”: keep only the first occurrence of each entry, remove duplicates.
# - Because path and PATH are tied in zsh, applying it to both ensures dedupe whether you edit as array or string.
typeset -U path PATH

# Setting PATH for Python 3.10
# The original version is saved in .zprofile.pysave
PATH="/Library/Frameworks/Python.framework/Versions/3.10/bin:${PATH}"
export PATH

# Created by `pipx` on 2023-06-13 14:14:30
export PATH="$PATH:/Users/taylor.rogers/.local/bin"

# >>> local bin path >>>
export PATH="$HOME/bin:$PATH"
# <<< local bin path <<<
# >>> dev worktree aliases >>>
alias dnew='dev-local'
alias dtree='dev-wt-new'
alias dmerge='dev-wt-merge'
# <<< dev worktree aliases <<<

# Adding homebrew to the PATH 
[ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"

# nvm: load fast, do not auto-switch on shell start
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" --no-use
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
[ -s "/Users/taylor.rogers/.bun/_bun" ] && source "/Users/taylor.rogers/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# opencode
export PATH=/Users/taylor.rogers/.opencode/bin:$PATH
export PATH="$HOME/.local/bin:$PATH"

# go
# export PATH="/usr/local/go/bin:$PATH"
