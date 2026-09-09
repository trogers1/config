#!/usr/bin/env bash
# Safe, macOS-only installer for the shared Pi + tmux/worktree workflow.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${HOME:?HOME must be set}"
BIN_DIR="$HOME_DIR/bin"
PI_DIR="$HOME_DIR/.pi/agent"
ZSHRC="$HOME_DIR/.zshrc"
TMUX_CONF="$HOME_DIR/.tmux.conf"
TMUX_WORKTREE_CONF="$HOME_DIR/.tmux.worktree.conf"
PLAYWRIGHT_BIN="${PLAYWRIGHT_BIN:-$REPO_DIR/home/.pi/agent/packages/pi-webfetch/node_modules/.bin/playwright}"
MODE="install"
DRY_RUN=0
NON_INTERACTIVE=0
BOOTSTRAP=0

# This list is intentionally explicit. Adding a file to home/ never expands the
# team install surface without a reviewed change to this script.
PI_LINKS=(
  "settings.json"
  "models.json"
  "skills"
  "usage"
)
# Personal profiles.jsonc is deliberately excluded. Team installs link only the
# shared guard prompts, leaving ~/.pi/agent/pi-guard/profiles.jsonc user-owned.
PI_GUARD_LINKS=(
  "prompts"
)
PI_PACKAGE_LINKS=(
  "pi-guard"
  "pi-webfetch"
  "pi-usage"
  "pi-guard-subagents"
  "pi-skill-toggle"
)
PI_EXTENSION_LINKS=(
  "ask-user-question.ts"
  "prompt-snippets"
)
COMMANDS=(dev dnew dopen dtree dclose dkill dmerge tmux-status-action)
APPROVED_CONFLICTS=()
LEGACY_GUARD_LINK=0
ZSH_BEGIN="# >>> dev-pi installer zsh >>>"
ZSH_END="# <<< dev-pi installer zsh <<<"
TMUX_BEGIN="# >>> dev-pi installer tmux >>>"
TMUX_END="# <<< dev-pi installer tmux <<<"

usage() {
  cat <<'EOF'
Usage: ./setup-dev-pi.sh [--dry-run] [--non-interactive] [--bootstrap-pi-deps]
       ./setup-dev-pi.sh --status
       ./setup-dev-pi.sh --uninstall [--dry-run]

Installs only the shared Pi configuration and non-writing `dev` tmux/worktree
workflow (including backward-compatible d* command wrappers). It does not install system tools. Conflicting user files are backed
up next to the target as <target>.bak after an interactive confirmation.
EOF
}

say() { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY_RUN" -eq 1 ]; then say "PLAN: $*"; else "$@"; fi; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --non-interactive) NON_INTERACTIVE=1 ;;
    --bootstrap-pi-deps) BOOTSTRAP=1 ;;
    --uninstall) MODE="uninstall" ;;
    --status) MODE="status" ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command '$1'. $2"
}
version_at_least() {
  # BSD sort lacks GNU sort's -V flag, so compare numeric dot components here.
  local actual="${1#v}" required="${2#v}" index a b
  local -a actual_parts required_parts
  actual="${actual%%-*}"
  required="${required%%-*}"
  IFS=. read -r -a actual_parts <<<"$actual"
  IFS=. read -r -a required_parts <<<"$required"
  for ((index = 0; index < ${#actual_parts[@]} || index < ${#required_parts[@]}; index++)); do
    a="${actual_parts[index]:-0}"
    b="${required_parts[index]:-0}"
    [[ "$a" =~ ^[0-9]+$ && "$b" =~ ^[0-9]+$ ]] || return 1
    if ((10#$a > 10#$b)); then return 0; fi
    if ((10#$a < 10#$b)); then return 1; fi
  done
  return 0
}
preflight() {
  [ "$(uname -s)" = "Darwin" ] || die "This installer supports macOS only."
  require_command bash "Install the current macOS Bash or run from a Bash-compatible shell."
  require_command git "Install Xcode Command Line Tools: xcode-select --install"
  require_command python3 "Install Python 3: https://www.python.org/downloads/macos/"
  require_command tmux "Install tmux: brew install tmux"
  require_command pi "Install Pi: https://pi.dev/"
  require_command node "Install Node.js 22.19 or newer: https://nodejs.org/"
  require_command npm "Install Node.js 22.19 or newer: https://nodejs.org/"
  if [ "$BOOTSTRAP" -eq 1 ]; then require_command npx "Install Node.js 22.19 or newer: https://nodejs.org/"; fi
  require_command nvim "Install Neovim: brew install neovim"
  require_command lazygit "Install lazygit: brew install lazygit"

  version_at_least "$(node --version)" "22.19.0" || die "Node $(node --version) is too old; Node 22.19.0 or newer is required."
  version_at_least "$(pi --version | head -n1)" "0.85.0" || die "Pi $(pi --version | head -n1) is too old; Pi 0.85.0 or newer is required."

  [ -w "$HOME_DIR" ] || die "HOME is not writable: $HOME_DIR"
  [ -d "$REPO_DIR/home/.pi/agent" ] || die "Missing bundled Pi configuration."
  [ -d "$REPO_DIR/tmux_and_worktrees/bin" ] || die "Missing bundled tmux/worktree commands."

  for package in "${PI_PACKAGE_LINKS[@]}"; do
    [ -f "$REPO_DIR/home/.pi/agent/packages/$package/package.json" ] || die "Missing Pi package: $package"
  done

  if [ "$BOOTSTRAP" -eq 0 ]; then
    local missing=0 package
    for package in "${PI_PACKAGE_LINKS[@]}"; do
      if ! (cd "$REPO_DIR/home/.pi/agent/packages/$package" && npm ls --omit=dev --depth=0 >/dev/null 2>&1); then
        warn "Pi package dependencies are missing or invalid: $package (run ./setup-dev-pi.sh --bootstrap-pi-deps)"
        missing=1
      fi
    done
    [ "$missing" -eq 0 ] || die "Pi dependency preflight failed; no files were changed."
    [ -x "$PLAYWRIGHT_BIN" ] || die "Pi webfetch Playwright is missing (run ./setup-dev-pi.sh --bootstrap-pi-deps)."
    if ! "$PLAYWRIGHT_BIN" install --list 2>/dev/null | grep -Eq '(^|[[:space:]])chromium([[:space:]-]|$)'; then
      die "Pi webfetch Chromium is missing (run ./setup-dev-pi.sh --bootstrap-pi-deps)."
    fi
  fi
}

conflict_is_approved() {
  local target="$1" approved
  for approved in "${APPROVED_CONFLICTS[@]:-}"; do [ "$approved" = "$target" ] && return 0; done
  return 1
}

confirm_conflict() {
  local target="$1"
  local backup="$target.bak"
  conflict_is_approved "$target" && return 0
  [ ! -e "$backup" ] && [ ! -L "$backup" ] || die "Refusing to overwrite existing backup: $backup"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "PLAN: conflict at $target; would move it to $backup after confirmation"
    return 0
  fi
  if [ "$NON_INTERACTIVE" -eq 1 ]; then
    die "Conflict at $target; --non-interactive never replaces unowned files."
  fi
  [ -r /dev/tty ] || die "Conflict at $target but no interactive terminal is available."
  local reply
  while true; do
    printf 'Existing unowned target %s will be moved to %s. Continue? [y/N] ' "$target" "$backup" >/dev/tty
    read -r reply </dev/tty
    case "$reply" in
      y|Y) APPROVED_CONFLICTS+=("$target"); return 0 ;;
      ''|n|N) die "Skipped conflicting target: $target" ;;
      *) printf 'Please enter y or n.\n' >/dev/tty ;;
    esac
  done
}

preflight_link_conflict() {
  local source="$1" target="$2"
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$source" ]; then return; fi
  if [ -e "$target" ] || [ -L "$target" ]; then confirm_conflict "$target"; fi
}

preflight_wrapper_conflict() {
  local command_name="$1" target expected
  target="$BIN_DIR/$command_name"
  expected="$(wrapper_content "$command_name")"
  if [ -f "$target" ] && [ "$(cat "$target")" = "$expected" ]; then return; fi
  if [ -e "$target" ] || [ -L "$target" ]; then confirm_conflict "$target"; fi
}

confirm_block_update() {
  local target="$1" label="$2" backup="$1.bak"
  conflict_is_approved "$target" && return 0
  [ ! -e "$backup" ] && [ ! -L "$backup" ] || die "Refusing to overwrite existing backup: $backup"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "PLAN: existing $label file $target would be preserved, backed up to $backup, and updated with a managed block after confirmation"
    APPROVED_CONFLICTS+=("$target")
    return 0
  fi
  if [ "$NON_INTERACTIVE" -eq 1 ]; then
    die "Existing $label file at $target requires confirmation; --non-interactive never modifies it."
  fi
  [ -r /dev/tty ] || die "Existing $label file at $target but no interactive terminal is available."
  local reply
  while true; do
    printf 'Update existing %s file %s by appending a managed block? The current file will remain in place and be copied to %s. [y/N] ' "$label" "$target" "$backup" >/dev/tty
    read -r reply </dev/tty
    case "$reply" in
      y|Y) APPROVED_CONFLICTS+=("$target"); return 0 ;;
      ''|n|N) die "Skipped existing $label file: $target" ;;
      *) printf 'Please enter y or n.\n' >/dev/tty ;;
    esac
  done
}

preflight_block_conflict() {
  local target="$1" begin="$2" label="$3"
  [ ! -L "$target" ] || die "Refusing to edit symlinked $label: $target"
  if [ -e "$target" ] && ! has_block "$begin" "$target"; then confirm_block_update "$target" "$label"; fi
}

legacy_guard_link_present() {
  [ -L "$PI_DIR/pi-guard" ] && [ "$(readlink "$PI_DIR/pi-guard")" = "$REPO_DIR/home/.pi/agent/pi-guard" ]
}

migrate_legacy_guard_link() {
  legacy_guard_link_present || return 0
  LEGACY_GUARD_LINK=1
  if [ "$DRY_RUN" -eq 1 ]; then
    say "PLAN: replace legacy owned $PI_DIR/pi-guard link with a directory so profiles.jsonc remains user-owned"
    return
  fi
  rm "$PI_DIR/pi-guard"
  mkdir -p "$PI_DIR/pi-guard"
  say "Migrated: legacy Pi guard link; profiles.jsonc is now user-owned"
}

preflight_conflicts() {
  local item
  for item in "${PI_LINKS[@]}"; do preflight_link_conflict "$REPO_DIR/home/.pi/agent/$item" "$PI_DIR/$item"; done
  if [ "$LEGACY_GUARD_LINK" -eq 0 ]; then
    for item in "${PI_GUARD_LINKS[@]}"; do preflight_link_conflict "$REPO_DIR/home/.pi/agent/pi-guard/$item" "$PI_DIR/pi-guard/$item"; done
  fi
  for item in "${PI_PACKAGE_LINKS[@]}"; do preflight_link_conflict "$REPO_DIR/home/.pi/agent/packages/$item" "$PI_DIR/packages/$item"; done
  for item in "${PI_EXTENSION_LINKS[@]}"; do preflight_link_conflict "$REPO_DIR/home/.pi/agent/extensions/$item" "$PI_DIR/extensions/$item"; done
  for item in "${COMMANDS[@]}"; do preflight_wrapper_conflict "$item"; done
  preflight_link_conflict "$REPO_DIR/tmux_and_worktrees/tmux-worktree.conf" "$TMUX_WORKTREE_CONF"
  preflight_block_conflict "$ZSHRC" "$ZSH_BEGIN" "zsh"
  preflight_block_conflict "$TMUX_CONF" "$TMUX_BEGIN" "tmux"
}

link_owned() {
  local source="$1" target="$2" label="$3"
  [ -e "$source" ] || [ -L "$source" ] || die "Missing source for $label: $source"
  if [ "$DRY_RUN" -eq 1 ] && [ "$LEGACY_GUARD_LINK" -eq 1 ] && [[ "$target" == "$PI_DIR/pi-guard/"* ]]; then
    say "PLAN: link $target -> $source after migrating the legacy Pi guard link"
    return
  fi
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$source" ]; then
    say "Unchanged: $label ($target)"
    return
  fi
  if [ -e "$target" ] || [ -L "$target" ]; then
    confirm_conflict "$target"
    run mv "$target" "$target.bak"
    say "Backed up: $target -> $target.bak"
  fi
  run mkdir -p "$(dirname "$target")"
  run ln -s "$source" "$target"
  say "Linked: $label ($target)"
}

wrapper_content() {
  local command_name="$1"
  cat <<EOF
#!/usr/bin/env bash
# Managed by setup-dev-pi.sh; do not edit.
set -euo pipefail
exec "$REPO_DIR/tmux_and_worktrees/bin/$command_name" "\$@"
EOF
}

install_wrapper() {
  local command_name="$1" target expected
  target="$BIN_DIR/$command_name"
  expected="$(wrapper_content "$command_name")"
  if [ -f "$target" ] && [ "$(cat "$target")" = "$expected" ]; then
    say "Unchanged: command wrapper ($target)"
    return
  fi
  if [ -e "$target" ] || [ -L "$target" ]; then
    confirm_conflict "$target"
    run mv "$target" "$target.bak"
    say "Backed up: $target -> $target.bak"
  fi
  run mkdir -p "$BIN_DIR"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "PLAN: create command wrapper $target"
  else
    wrapper_content "$command_name" >"$target"
    chmod +x "$target"
  fi
  say "Installed: command wrapper ($target)"
}

has_block() { grep -Fq "$1" "$2" 2>/dev/null; }
append_block() {
  local target="$1" begin="$2" end="$3" content="$4" label="$5"
  if [ -L "$target" ]; then die "Refusing to edit symlinked $label: $target"; fi
  if [ -e "$target" ] && has_block "$begin" "$target"; then
    has_block "$end" "$target" || die "Malformed managed block in $target"
    say "Unchanged: $label block ($target)"
    return
  fi
  if [ -e "$target" ]; then
    confirm_block_update "$target" "$label"
    run cp -p "$target" "$target.bak"
    say "Backed up: $target -> $target.bak"
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    say "PLAN: append managed $label block to $target"
  else
    mkdir -p "$(dirname "$target")"
    touch "$target"
    printf '\n%s\n%s\n%s\n' "$begin" "$content" "$end" >>"$target"
  fi
  say "Installed: $label block ($target)"
}

remove_block() {
  local target="$1" begin="$2" end="$3" label="$4" tmp
  [ -f "$target" ] || { say "Absent: $label block ($target)"; return; }
  has_block "$begin" "$target" || { say "Absent: $label block ($target)"; return; }
  has_block "$end" "$target" || { warn "Malformed managed block; preserving $target"; return; }
  tmp="$(mktemp)"
  awk -v begin="$begin" -v end="$end" '
    $0 == begin { skip=1; next }
    $0 == end && skip { skip=0; next }
    !skip { print }
  ' "$target" >"$tmp"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "PLAN: remove managed $label block from $target"
    rm -f "$tmp"
    return
  fi
  if [ -f "$target.bak" ] && cmp -s "$tmp" "$target.bak"; then
    mv "$target.bak" "$target"
    say "Restored: $target.bak -> $target"
  else
    mv "$tmp" "$target"
    say "Removed: managed $label block ($target)"
    [ ! -f "$target.bak" ] || warn "Preserved $target.bak because $target has changes beyond the managed block."
    return
  fi
  rm -f "$tmp"
}

uninstall_link() {
  local source="$1" target="$2" label="$3"
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$source" ]; then
    run rm "$target"
    say "Removed: $label ($target)"
    if [ -e "$target.bak" ] || [ -L "$target.bak" ]; then
      run mv "$target.bak" "$target"
      say "Restored: $target.bak -> $target"
    fi
  else
    say "Preserved: $label ($target is absent, changed, or unowned)"
  fi
}

uninstall_wrapper() {
  local command_name="$1" target expected
  target="$BIN_DIR/$command_name"
  expected="$(wrapper_content "$command_name")"
  if [ -f "$target" ] && [ "$(cat "$target")" = "$expected" ]; then
    run rm "$target"
    say "Removed: command wrapper ($target)"
    if [ -e "$target.bak" ] || [ -L "$target.bak" ]; then run mv "$target.bak" "$target"; say "Restored: $target.bak -> $target"; fi
  else
    say "Preserved: command wrapper ($target is absent, changed, or unowned)"
  fi
}

bootstrap_dependencies() {
  local package
  for package in "${PI_PACKAGE_LINKS[@]}"; do
    if [ "$DRY_RUN" -eq 1 ]; then
      say "PLAN: (cd $REPO_DIR/home/.pi/agent/packages/$package && npm ci)"
    else
      say "Bootstrapping Pi package dependencies: $package"
      (cd "$REPO_DIR/home/.pi/agent/packages/$package" && npm ci)
    fi
  done
  if [ "$DRY_RUN" -eq 1 ]; then
    say "PLAN: (cd $REPO_DIR/home/.pi/agent/packages/pi-webfetch && npx playwright install chromium)"
  else
    say "Installing Playwright Chromium for pi-webfetch"
    (cd "$REPO_DIR/home/.pi/agent/packages/pi-webfetch" && npx playwright install chromium)
  fi
}

status_item() {
  local source="$1" target="$2" label="$3"
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$source" ]; then say "owned link: $label -> $target"
  elif [ -e "$target" ] || [ -L "$target" ]; then say "foreign/drifted: $label -> $target"
  else say "absent: $label -> $target"; fi
}

status_wrapper() {
  local command_name="$1" target expected
  target="$BIN_DIR/$command_name"
  expected="$(wrapper_content "$command_name")"
  if [ -f "$target" ] && [ "$(cat "$target")" = "$expected" ]; then
    say "owned wrapper: $target"
  elif [ -e "$target" ] || [ -L "$target" ]; then
    say "foreign/drifted wrapper: $target"
  else
    say "absent wrapper: $target"
  fi
}

status_block() {
  local target="$1" begin="$2" label="$3"
  if [ -L "$target" ]; then
    say "foreign/drifted $label block: $target is a symlink"
  elif has_block "$begin" "$target"; then
    say "owned $label block: $target"
  elif [ -e "$target" ]; then
    say "absent $label block: $target"
  else
    say "absent $label block: $target"
  fi
}

if [ "$MODE" = "install" ]; then
  preflight
  legacy_guard_link_present && LEGACY_GUARD_LINK=1 || true
  preflight_conflicts
  migrate_legacy_guard_link
  if [ "$BOOTSTRAP" -eq 1 ]; then bootstrap_dependencies; fi
  for item in "${PI_LINKS[@]}"; do link_owned "$REPO_DIR/home/.pi/agent/$item" "$PI_DIR/$item" "Pi $item"; done
  for item in "${PI_GUARD_LINKS[@]}"; do link_owned "$REPO_DIR/home/.pi/agent/pi-guard/$item" "$PI_DIR/pi-guard/$item" "Pi guard $item"; done
  for item in "${PI_PACKAGE_LINKS[@]}"; do link_owned "$REPO_DIR/home/.pi/agent/packages/$item" "$PI_DIR/packages/$item" "Pi package $item"; done
  for item in "${PI_EXTENSION_LINKS[@]}"; do link_owned "$REPO_DIR/home/.pi/agent/extensions/$item" "$PI_DIR/extensions/$item" "Pi extension $item"; done
  for item in "${COMMANDS[@]}"; do install_wrapper "$item"; done
  link_owned "$REPO_DIR/tmux_and_worktrees/tmux-worktree.conf" "$TMUX_WORKTREE_CONF" "tmux workflow config"
  append_block "$ZSHRC" "$ZSH_BEGIN" "$ZSH_END" $'export PATH="$HOME/bin:$PATH"\n\ndev() {\n  if [ "${1:-}" != "home" ]; then\n    command dev "$@"\n    return\n  fi\n\n  local env_line target\n  [ -n "${TMUX:-}" ] || { echo "dev home is only available in a tmux dev session"; return 1; }\n  env_line="$(tmux show-environment DTREE_WORKTREE_PATH 2>/dev/null || true)"\n  target="${env_line#DTREE_WORKTREE_PATH=}"\n  [ "$target" != "$env_line" ] && [ -n "$target" ] || { echo "dev home is only available in a tmux dev session"; return 1; }\n  cd "$target"\n}\n\n# Backward-compatible spelling for `dev home`.\ndhome() { dev home "$@"; }' "zsh"
  append_block "$TMUX_CONF" "$TMUX_BEGIN" "$TMUX_END" 'source-file ~/.tmux.worktree.conf' "tmux"
  say "Setup complete. Start a new shell, then reload tmux with: tmux source-file ~/.tmux.conf"
elif [ "$MODE" = "uninstall" ]; then
  for item in "${PI_LINKS[@]}"; do uninstall_link "$REPO_DIR/home/.pi/agent/$item" "$PI_DIR/$item" "Pi $item"; done
  for item in "${PI_GUARD_LINKS[@]}"; do uninstall_link "$REPO_DIR/home/.pi/agent/pi-guard/$item" "$PI_DIR/pi-guard/$item" "Pi guard $item"; done
  for item in "${PI_PACKAGE_LINKS[@]}"; do uninstall_link "$REPO_DIR/home/.pi/agent/packages/$item" "$PI_DIR/packages/$item" "Pi package $item"; done
  for item in "${PI_EXTENSION_LINKS[@]}"; do uninstall_link "$REPO_DIR/home/.pi/agent/extensions/$item" "$PI_DIR/extensions/$item" "Pi extension $item"; done
  for item in "${COMMANDS[@]}"; do uninstall_wrapper "$item"; done
  uninstall_link "$REPO_DIR/tmux_and_worktrees/tmux-worktree.conf" "$TMUX_WORKTREE_CONF" "tmux workflow config"
  remove_block "$ZSHRC" "$ZSH_BEGIN" "$ZSH_END" "zsh"
  remove_block "$TMUX_CONF" "$TMUX_BEGIN" "$TMUX_END" "tmux"
elif [ "$MODE" = "status" ]; then
  for item in "${PI_LINKS[@]}"; do status_item "$REPO_DIR/home/.pi/agent/$item" "$PI_DIR/$item" "Pi $item"; done
  for item in "${PI_GUARD_LINKS[@]}"; do status_item "$REPO_DIR/home/.pi/agent/pi-guard/$item" "$PI_DIR/pi-guard/$item" "Pi guard $item"; done
  for item in "${PI_PACKAGE_LINKS[@]}"; do status_item "$REPO_DIR/home/.pi/agent/packages/$item" "$PI_DIR/packages/$item" "Pi package $item"; done
  for item in "${PI_EXTENSION_LINKS[@]}"; do status_item "$REPO_DIR/home/.pi/agent/extensions/$item" "$PI_DIR/extensions/$item" "Pi extension $item"; done
  for item in "${COMMANDS[@]}"; do status_wrapper "$item"; done
  status_item "$REPO_DIR/tmux_and_worktrees/tmux-worktree.conf" "$TMUX_WORKTREE_CONF" "tmux workflow config"
  status_block "$ZSHRC" "$ZSH_BEGIN" "zsh"
  status_block "$TMUX_CONF" "$TMUX_BEGIN" "tmux"
fi
