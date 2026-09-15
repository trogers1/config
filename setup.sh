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
OPERATION="install"
DRY_RUN=0
NON_INTERACTIVE=0
BOOTSTRAP=0

# This list is intentionally explicit. Adding a file to home/ never expands the
# shared install surface without a reviewed change to this script.
PI_LINKS=(
  "settings.json"
  "models.json"
  "skills"
  "usage"
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
COMMANDS=(dev tmux-status-action)
APPROVED_CONFLICTS=()
ZSH_BEGIN="# >>> setup shared zsh >>>"
ZSH_END="# <<< setup shared zsh <<<"
TMUX_BEGIN="# >>> setup shared tmux >>>"
TMUX_END="# <<< setup shared tmux <<<"
ZSH_TEMPLATE="$REPO_DIR/scripts/setup/templates/shared.zsh"
TMUX_TEMPLATE="$REPO_DIR/scripts/setup/templates/shared.tmux"
ZSH_CONTENT="$(<"$ZSH_TEMPLATE")"
TMUX_CONTENT="$(<"$TMUX_TEMPLATE")"
PERSONAL_ZSH_SOURCE="$REPO_DIR/home/.zshrc"
PERSONAL_TMUX_SOURCE="$REPO_DIR/home/.tmux.conf"

usage() {
  cat <<'EOF'
Usage: ./setup.sh [--dry-run] [--non-interactive] [--bootstrap-pi-deps]
       ./setup.sh --status
       ./setup.sh --verify
       ./setup.sh --uninstall [--dry-run]

Installs only the shared Pi configuration and non-writing `dev` tmux/worktree
workflow. It does not install system tools. Conflicting user files are backed
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
    --uninstall|--status|--verify)
      [ "$OPERATION" = "install" ] || { usage >&2; exit 2; }
      OPERATION="${1#--}"
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done
[ "$OPERATION" != "verify" ] || [ "$DRY_RUN" -eq 0 ] || { usage >&2; exit 2; }
[ "$OPERATION" = "install" ] || [ "$NON_INTERACTIVE" -eq 0 ] || { usage >&2; exit 2; }
[ "$OPERATION" = "install" ] || [ "$BOOTSTRAP" -eq 0 ] || { usage >&2; exit 2; }

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

  command -v nvim >/dev/null 2>&1 || warn "Optional tool 'nvim' is not installed. Install it if wanted with: brew install neovim"
  command -v lazygit >/dev/null 2>&1 || warn "Optional tool 'lazygit' is not installed. Install it if wanted with: brew install lazygit"

  version_at_least "$(node --version)" "22.19.0" || die "Node $(node --version) is too old; Node 22.19.0 or newer is required."
  version_at_least "$(pi --version | head -n1)" "0.85.0" || die "Pi $(pi --version | head -n1) is too old; Pi 0.85.0 or newer is required."

  [ -w "$HOME_DIR" ] || die "HOME is not writable: $HOME_DIR"
  [ -d "$REPO_DIR/home/.pi/agent" ] || die "Missing bundled Pi configuration."
  [ -d "$REPO_DIR/tmux_and_worktrees/bin" ] || die "Missing bundled tmux/worktree commands."
  [ -f "$ZSH_TEMPLATE" ] || die "Missing shared zsh template: $ZSH_TEMPLATE"
  [ -f "$TMUX_TEMPLATE" ] || die "Missing shared tmux template: $TMUX_TEMPLATE"

  local item source
  for item in "${PI_LINKS[@]}"; do
    source="$REPO_DIR/home/.pi/agent/$item"; [ -e "$source" ] || die "Missing Pi source: $source"
  done
  for item in "${PI_PACKAGE_LINKS[@]}"; do
    source="$REPO_DIR/home/.pi/agent/packages/$item"; [ -e "$source" ] || die "Missing Pi package source: $source"
    [ -f "$source/package.json" ] || die "Missing Pi package manifest: $item"
  done
  for item in "${PI_EXTENSION_LINKS[@]}"; do
    source="$REPO_DIR/home/.pi/agent/extensions/$item"; [ -e "$source" ] || die "Missing Pi extension source: $source"
  done
  for item in "${COMMANDS[@]}"; do
    source="$REPO_DIR/tmux_and_worktrees/bin/$item"; [ -f "$source" ] && [ -x "$source" ] || die "Missing executable command source: $source"
  done
  [ -f "$REPO_DIR/tmux_and_worktrees/tmux-worktree.conf" ] || die "Missing tmux workflow source."
  for source in "$HOME_DIR/.pi" "$PI_DIR" "$PI_DIR/packages" "$PI_DIR/extensions" "$BIN_DIR"; do
    [ ! -L "$source" ] || die "Refusing to manage targets beneath symlinked directory: $source"
  done

  if [ "$BOOTSTRAP" -eq 0 ]; then
    local missing=0 package
    for package in "${PI_PACKAGE_LINKS[@]}"; do
      if ! (cd "$REPO_DIR/home/.pi/agent/packages/$package" && npm ls --omit=dev --depth=0 >/dev/null 2>&1); then
        warn "Pi package dependencies are missing or invalid: $package (run ./setup.sh --bootstrap-pi-deps)"
        missing=1
      fi
    done
    [ "$missing" -eq 0 ] || die "Pi dependency preflight failed; no files were changed."
    [ -x "$PLAYWRIGHT_BIN" ] || die "Pi webfetch Playwright is missing (run ./setup.sh --bootstrap-pi-deps)."
    # `install --list` prints browser cache paths (for example
    # `.../chromium-1234`), not a bare browser name. Match the path suffix so
    # a successful bootstrap is not incorrectly reported as missing.
    if ! "$PLAYWRIGHT_BIN" install --list 2>/dev/null | grep -Eq 'chromium([[:space:]-]|$)'; then
      die "Pi webfetch Chromium is missing (run ./setup.sh --bootstrap-pi-deps)."
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
  local command_name="$1" target
  target="$BIN_DIR/$command_name"
  if wrapper_is_owned "$command_name" "$target"; then return; fi
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

owned_link() {
  [ -L "$2" ] && [ "$(readlink "$2")" = "$1" ]
}

personal_shell_link() {
  owned_link "$PERSONAL_ZSH_SOURCE" "$ZSHRC"
}

personal_tmux_link() {
  owned_link "$PERSONAL_TMUX_SOURCE" "$TMUX_CONF"
}

reject_linked_target_ancestors() {
  local ancestor
  for ancestor in "$HOME_DIR/.pi" "$PI_DIR" "$PI_DIR/packages" "$PI_DIR/extensions" "$BIN_DIR"; do
    [ ! -L "$ancestor" ] || die "Refusing to manage targets beneath symlinked directory: $ancestor"
  done
}

block_matches() {
  local target="$1" begin="$2" end="$3" expected="$4" actual
  [ -f "$target" ] || return 1
  [ "$(grep -Fxc "$begin" "$target")" -eq 1 ] || return 1
  [ "$(grep -Fxc "$end" "$target")" -eq 1 ] || return 1
  [ "$(grep -Fn "$begin" "$target" | cut -d: -f1)" -lt "$(grep -Fn "$end" "$target" | cut -d: -f1)" ] || return 1
  actual="$(mktemp)"
  awk -v begin="$begin" -v end="$end" '
    $0 == begin { inside=1; next }
    $0 == end && inside { exit }
    inside { print }
  ' "$target" >"$actual"
  if cmp -s "$actual" <(printf '%s\n' "$expected"); then rm -f "$actual"; return 0; fi
  rm -f "$actual"
  return 1
}

legacy_shared_wrapper_content() {
  cat <<EOF
#!/usr/bin/env bash
# Managed by setup-dev-pi.sh; do not edit.
set -euo pipefail
exec "$REPO_DIR/tmux_and_worktrees/bin/$1" "\$@"
EOF
}

legacy_personal_wrapper_content() {
  cat <<EOF
#!/bin/bash
set -euo pipefail

# Wrapper script so the real command runs from the repo path,
# which keeps shared helper sourcing simple and symlink-free.
exec "$REPO_DIR/tmux_and_worktrees/bin/$1" "\$@"
EOF
}

legacy_wrapper_owned() {
  local command_name="$1" target="$BIN_DIR/$1"
  [ -f "$target" ] && [ ! -L "$target" ] || return 1
  cmp -s "$target" <(legacy_shared_wrapper_content "$command_name") || cmp -s "$target" <(legacy_personal_wrapper_content "$command_name")
}

legacy_state_present() {
  owned_link "$REPO_DIR/home/.pi/agent/pi-guard" "$PI_DIR/pi-guard" && return 0
  local command_name
  if ! personal_shell_link && [ -f "$ZSHRC" ] && grep -Eq '# >>> (dev-pi installer|dev worktree (aliases|dhome|shell integration|config))' "$ZSHRC"; then return 0; fi
  if ! personal_tmux_link && [ -f "$TMUX_CONF" ] && grep -Eq '# >>> (dev-pi installer|dev worktree (aliases|dhome|shell integration|config))' "$TMUX_CONF"; then return 0; fi
  for command_name in dnew dopen dtree dclose dkill dmerge; do
    legacy_wrapper_owned "$command_name" && return 0
  done
  return 1
}

preflight_block_conflict() {
  local target="$1" begin="$2" end="$3" content="$4" label="$5" personal_source="$6"
  if owned_link "$personal_source" "$target"; then return; fi
  [ ! -L "$target" ] || die "Refusing to edit symlinked $label: $target"
  if has_block "$begin" "$target" && ! has_block "$end" "$target"; then die "Malformed managed block in $target"; fi
  if ! has_block "$begin" "$target" && has_block "$end" "$target"; then die "Malformed managed block in $target"; fi
  if [ -e "$target" ] && ! block_matches "$target" "$begin" "$end" "$content"; then
    confirm_block_update "$target" "$label"
  fi
}

preflight_conflicts() {
  local item
  for item in "${PI_LINKS[@]}"; do preflight_link_conflict "$REPO_DIR/home/.pi/agent/$item" "$PI_DIR/$item"; done
  for item in "${PI_PACKAGE_LINKS[@]}"; do preflight_link_conflict "$REPO_DIR/home/.pi/agent/packages/$item" "$PI_DIR/packages/$item"; done
  for item in "${PI_EXTENSION_LINKS[@]}"; do preflight_link_conflict "$REPO_DIR/home/.pi/agent/extensions/$item" "$PI_DIR/extensions/$item"; done
  for item in "${COMMANDS[@]}"; do preflight_wrapper_conflict "$item"; done
  preflight_link_conflict "$REPO_DIR/tmux_and_worktrees/tmux-worktree.conf" "$TMUX_WORKTREE_CONF"
  preflight_block_conflict "$ZSHRC" "$ZSH_BEGIN" "$ZSH_END" "$ZSH_CONTENT" "zsh" "$PERSONAL_ZSH_SOURCE"
  preflight_block_conflict "$TMUX_CONF" "$TMUX_BEGIN" "$TMUX_END" "$TMUX_CONTENT" "tmux" "$PERSONAL_TMUX_SOURCE"
}

link_owned() {
  local source="$1" target="$2" label="$3"
  [ -e "$source" ] || [ -L "$source" ] || die "Missing source for $label: $source"
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
# Managed by setup.sh; do not edit.
set -euo pipefail
exec "$REPO_DIR/tmux_and_worktrees/bin/$command_name" "\$@"
EOF
}

wrapper_is_owned() {
  local command_name="$1" target="$2"
  [ -f "$target" ] && [ ! -L "$target" ] && [ -x "$target" ] && cmp -s "$target" <(wrapper_content "$command_name")
}

install_wrapper() {
  local command_name="$1" target
  target="$BIN_DIR/$command_name"
  if wrapper_is_owned "$command_name" "$target"; then
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
  local target="$1" begin="$2" end="$3" content="$4" label="$5" personal_source="$6" tmp
  if owned_link "$personal_source" "$target"; then
    say "Unchanged: personal $label configuration provides shared integration ($target)"
    return
  fi
  [ ! -L "$target" ] || die "Refusing to edit symlinked $label: $target"
  if block_matches "$target" "$begin" "$end" "$content"; then
    say "Unchanged: $label block ($target)"
    return
  fi
  if [ -e "$target" ]; then
    confirm_block_update "$target" "$label"
    run cp -p "$target" "$target.bak"
    say "Backed up: $target -> $target.bak"
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    say "PLAN: install exact managed $label block in $target"
  else
    mkdir -p "$(dirname "$target")"
    touch "$target"
    if has_block "$begin" "$target"; then
      has_block "$end" "$target" || die "Malformed managed block in $target"
      tmp="$(mktemp)"
      awk -v begin="$begin" -v end="$end" '
        $0 == begin { skip=1; next }
        $0 == end && skip { skip=0; next }
        !skip { print }
      ' "$target" >"$tmp"
      mv "$tmp" "$target"
    fi
    printf '\n%s\n%s\n%s\n' "$begin" "$content" "$end" >>"$target"
  fi
  say "Installed: $label block ($target)"
}

remove_block() {
  local target="$1" begin="$2" end="$3" content="$4" label="$5" personal_source="$6" tmp
  if owned_link "$personal_source" "$target"; then say "Preserved: personal $label configuration ($target)"; return; fi
  [ ! -L "$target" ] || { say "Preserved: symlinked $label configuration ($target)"; return; }
  [ -f "$target" ] || { say "Absent: $label block ($target)"; return; }
  has_block "$begin" "$target" || { say "Absent: $label block ($target)"; return; }
  block_matches "$target" "$begin" "$end" "$content" || { warn "Drifted or malformed managed block; preserving $target"; return; }
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
  mv "$tmp" "$target"
  say "Removed: managed $label block ($target)"
  if [ -e "$target.bak" ] || [ -L "$target.bak" ]; then say "Preserved backup for manual restoration: $target.bak"; fi
}

uninstall_link() {
  local source="$1" target="$2" label="$3"
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$source" ]; then
    run rm "$target"
    say "Removed: $label ($target)"
    if [ -e "$target.bak" ] || [ -L "$target.bak" ]; then
      say "Preserved backup for manual restoration: $target.bak"
    fi
  else
    say "Preserved: $label ($target is absent, changed, or unowned)"
  fi
}

uninstall_wrapper() {
  local command_name="$1" target
  target="$BIN_DIR/$command_name"
  if wrapper_is_owned "$command_name" "$target"; then
    run rm "$target"
    say "Removed: command wrapper ($target)"
    if [ -e "$target.bak" ] || [ -L "$target.bak" ]; then say "Preserved backup for manual restoration: $target.bak"; fi
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
    say "PLAN: $PLAYWRIGHT_BIN install chromium"
  else
    say "Installing Playwright Chromium for pi-webfetch"
    "$PLAYWRIGHT_BIN" install chromium
  fi
}

status_item() {
  local source="$1" target="$2" label="$3"
  if [ -e "$source" ] && [ -L "$target" ] && [ "$(readlink "$target")" = "$source" ]; then say "owned link: $label -> $target"
  elif [ -e "$target" ] || [ -L "$target" ]; then say "foreign/drifted: $label -> $target"
  else say "absent: $label -> $target"; fi
}

status_wrapper() {
  local command_name="$1" target
  target="$BIN_DIR/$command_name"
  if wrapper_is_owned "$command_name" "$target"; then
    say "owned wrapper: $target"
  elif [ -e "$target" ] || [ -L "$target" ]; then
    say "foreign/drifted wrapper: $target"
  else
    say "absent wrapper: $target"
  fi
}

status_block() {
  local target="$1" begin="$2" end="$3" content="$4" label="$5" personal_source="$6"
  if owned_link "$personal_source" "$target"; then
    say "personal link: shared $label integration is provided by $target"
  elif [ -L "$target" ]; then
    say "foreign/drifted $label block: $target is a symlink"
  elif block_matches "$target" "$begin" "$end" "$content"; then
    say "owned $label block: $target"
  elif has_block "$begin" "$target"; then
    say "foreign/drifted $label block: $target"
  else
    say "absent $label block: $target"
  fi
}

verify_block() {
  local target="$1" begin="$2" end="$3" content="$4" label="$5" personal_source="$6"
  if owned_link "$personal_source" "$target"; then
    [ -e "$personal_source" ] || die "Personal $label source is missing"
    if [ "$label" = "zsh" ]; then
      grep -Fq '$HOME/bin' "$personal_source" && grep -Fq 'dev() {' "$personal_source" || die "Personal zsh configuration lacks shared integration"
    else
      grep -Fqx 'set -g extended-keys on' "$personal_source" || die "Personal tmux configuration lacks extended keys"
      grep -Fqx 'set -g extended-keys-format csi-u' "$personal_source" || die "Personal tmux configuration lacks CSI-u keys"
      grep -Fqx 'source-file ~/.tmux.worktree.conf' "$personal_source" || die "Personal tmux configuration lacks the worktree include"
    fi
    return
  fi
  block_matches "$target" "$begin" "$end" "$content" || die "$label integration is missing or drifted"
}

install_all() {
  local item
  preflight
  legacy_state_present && die "Legacy installer state detected; no files were changed. Run ./scripts/setup/migrate-legacy.sh, then rerun ./setup.sh."
  preflight_conflicts
  if [ "$BOOTSTRAP" -eq 1 ]; then bootstrap_dependencies; fi

  for item in "${PI_LINKS[@]}"; do
    link_owned "$REPO_DIR/home/.pi/agent/$item" "$PI_DIR/$item" "Pi $item"
  done
  for item in "${PI_PACKAGE_LINKS[@]}"; do
    link_owned "$REPO_DIR/home/.pi/agent/packages/$item" "$PI_DIR/packages/$item" "Pi package $item"
  done
  for item in "${PI_EXTENSION_LINKS[@]}"; do
    link_owned "$REPO_DIR/home/.pi/agent/extensions/$item" "$PI_DIR/extensions/$item" "Pi extension $item"
  done
  for item in "${COMMANDS[@]}"; do install_wrapper "$item"; done

  link_owned "$REPO_DIR/tmux_and_worktrees/tmux-worktree.conf" "$TMUX_WORKTREE_CONF" "tmux workflow config"
  append_block "$ZSHRC" "$ZSH_BEGIN" "$ZSH_END" "$ZSH_CONTENT" "zsh" "$PERSONAL_ZSH_SOURCE"
  append_block "$TMUX_CONF" "$TMUX_BEGIN" "$TMUX_END" "$TMUX_CONTENT" "tmux" "$PERSONAL_TMUX_SOURCE"
  say "Setup complete. Start a new shell, then reload tmux with: tmux source-file ~/.tmux.conf"
}

uninstall_all() {
  local item
  reject_linked_target_ancestors
  for item in "${PI_LINKS[@]}"; do
    uninstall_link "$REPO_DIR/home/.pi/agent/$item" "$PI_DIR/$item" "Pi $item"
  done
  for item in "${PI_PACKAGE_LINKS[@]}"; do
    uninstall_link "$REPO_DIR/home/.pi/agent/packages/$item" "$PI_DIR/packages/$item" "Pi package $item"
  done
  for item in "${PI_EXTENSION_LINKS[@]}"; do
    uninstall_link "$REPO_DIR/home/.pi/agent/extensions/$item" "$PI_DIR/extensions/$item" "Pi extension $item"
  done
  for item in "${COMMANDS[@]}"; do uninstall_wrapper "$item"; done
  uninstall_link "$REPO_DIR/tmux_and_worktrees/tmux-worktree.conf" "$TMUX_WORKTREE_CONF" "tmux workflow config"
  remove_block "$ZSHRC" "$ZSH_BEGIN" "$ZSH_END" "$ZSH_CONTENT" "zsh" "$PERSONAL_ZSH_SOURCE"
  remove_block "$TMUX_CONF" "$TMUX_BEGIN" "$TMUX_END" "$TMUX_CONTENT" "tmux" "$PERSONAL_TMUX_SOURCE"
}

show_status() {
  local item
  reject_linked_target_ancestors
  for item in "${PI_LINKS[@]}"; do status_item "$REPO_DIR/home/.pi/agent/$item" "$PI_DIR/$item" "Pi $item"; done
  for item in "${PI_PACKAGE_LINKS[@]}"; do status_item "$REPO_DIR/home/.pi/agent/packages/$item" "$PI_DIR/packages/$item" "Pi package $item"; done
  for item in "${PI_EXTENSION_LINKS[@]}"; do status_item "$REPO_DIR/home/.pi/agent/extensions/$item" "$PI_DIR/extensions/$item" "Pi extension $item"; done
  for item in "${COMMANDS[@]}"; do status_wrapper "$item"; done
  status_item "$REPO_DIR/tmux_and_worktrees/tmux-worktree.conf" "$TMUX_WORKTREE_CONF" "tmux workflow config"
  status_block "$ZSHRC" "$ZSH_BEGIN" "$ZSH_END" "$ZSH_CONTENT" "zsh" "$PERSONAL_ZSH_SOURCE"
  status_block "$TMUX_CONF" "$TMUX_BEGIN" "$TMUX_END" "$TMUX_CONTENT" "tmux" "$PERSONAL_TMUX_SOURCE"
}

verify_all() {
  local item source
  reject_linked_target_ancestors
  for item in "${PI_LINKS[@]}"; do
    source="$REPO_DIR/home/.pi/agent/$item"
    [ -e "$source" ] && owned_link "$source" "$PI_DIR/$item" || die "Pi $item link is missing or drifted"
  done
  for item in "${PI_PACKAGE_LINKS[@]}"; do
    source="$REPO_DIR/home/.pi/agent/packages/$item"
    [ -e "$source" ] && owned_link "$source" "$PI_DIR/packages/$item" || die "Pi package $item link is missing or drifted"
  done
  for item in "${PI_EXTENSION_LINKS[@]}"; do
    source="$REPO_DIR/home/.pi/agent/extensions/$item"
    [ -e "$source" ] && owned_link "$source" "$PI_DIR/extensions/$item" || die "Pi extension $item link is missing or drifted"
  done
  for item in "${COMMANDS[@]}"; do wrapper_is_owned "$item" "$BIN_DIR/$item" || die "$item wrapper is missing or drifted"; done
  [ -f "$REPO_DIR/tmux_and_worktrees/tmux-worktree.conf" ] && owned_link "$REPO_DIR/tmux_and_worktrees/tmux-worktree.conf" "$TMUX_WORKTREE_CONF" || die "tmux workflow link is missing or drifted"
  verify_block "$ZSHRC" "$ZSH_BEGIN" "$ZSH_END" "$ZSH_CONTENT" "zsh" "$PERSONAL_ZSH_SOURCE"
  verify_block "$TMUX_CONF" "$TMUX_BEGIN" "$TMUX_END" "$TMUX_CONTENT" "tmux" "$PERSONAL_TMUX_SOURCE"
  say "Verification passed."
}

case "$OPERATION" in
  install) install_all ;;
  uninstall) uninstall_all ;;
  status) show_status ;;
  verify) verify_all ;;
esac
