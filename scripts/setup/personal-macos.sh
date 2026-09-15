#!/usr/bin/env bash
# Explicit personal-dotfile installer. Shared Pi/worktree setup is separate.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPERATION="install"
DRY_RUN=0
NON_INTERACTIVE=0

# Keep target paths after sources are removed so uninstall remains deterministic.
PERSONAL_LINKS=(
  'home/.bash_profile|.bash_profile|bash profile'
  'home/.gitconfig|.gitconfig|Git configuration'
  'home/.zshrc|.zshrc|zsh configuration'
  'home/.tmux.conf|.tmux.conf|tmux configuration'
  'home/.cursor/cli-config.json|.cursor/cli-config.json|Cursor CLI configuration'
  'home/.pi/agent/pi-guard/profiles.jsonc|.pi/agent/pi-guard/profiles.jsonc|Pi guard profiles'
  'home/.pi/agent/pi-guard/prompts|.pi/agent/pi-guard/prompts|Pi guard prompts'
  'xdg/ghostty|.config/ghostty|Ghostty configuration'
  'xdg/nvim|.config/nvim|Neovim configuration'
  'xdg/opencode|.config/opencode|OpenCode configuration'
)

usage() {
  cat <<'EOF'
Usage: ./setup-personal.sh [--dry-run] [--non-interactive]
       ./setup-personal.sh --status
       ./setup-personal.sh --verify
       ./setup-personal.sh --uninstall [--dry-run]

Backs up and replaces only the explicitly declared personal dotfiles. It does
not install shared Pi resources, command wrappers, or the worktree workflow.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --non-interactive) NON_INTERACTIVE=1 ;;
    --status|--verify|--uninstall)
      [ "$OPERATION" = "install" ] || { usage >&2; exit 2; }
      OPERATION="${1#--}"
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done
[ "$OPERATION" != "verify" ] || [ "$DRY_RUN" -eq 0 ] || { usage >&2; exit 2; }
[ "$OPERATION" = "install" ] || [ "$NON_INTERACTIVE" -eq 0 ] || { usage >&2; exit 2; }

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
exists() { [ -e "$1" ] || [ -L "$1" ]; }
owned_link() { [ -L "$2" ] && [ "$(readlink "$2")" = "$1" ]; }

confirm_conflict() {
  local target="$1" backup="$1.bak" reply
  exists "$backup" && die "Refusing to overwrite existing backup: $backup"
  if [ "$DRY_RUN" -eq 1 ]; then
    say "PLAN: confirm replacement of $target and preserve it as $backup"
    return
  fi
  [ "$NON_INTERACTIVE" -eq 0 ] || die "Conflict at $target; --non-interactive never replaces personal files."
  [ -r /dev/tty ] || die "Conflict at $target but no interactive terminal is available."
  printf 'Replace personal target %s, moving it to %s? [y/N] ' "$target" "$backup" >/dev/tty
  read -r reply </dev/tty
  [[ "$reply" = y || "$reply" = Y ]] || die "Skipped conflicting target: $target"
}

validate_environment() {
  local ancestor
  [ "$(uname -s)" = "Darwin" ] || die "This installer supports macOS only."
  for ancestor in "$HOME/.config" "$HOME/.cursor" "$HOME/.pi" "$HOME/.pi/agent" "$HOME/.pi/agent/pi-guard"; do
    [ ! -L "$ancestor" ] || die "Refusing to manage targets beneath symlinked directory: $ancestor"
  done
}

# Validate every source, target, and backup before changing the first target.
preflight_install() {
  local entry source_relative target_relative label source target
  for entry in "${PERSONAL_LINKS[@]}"; do
    IFS='|' read -r source_relative target_relative label <<<"$entry"
    source="$REPO_DIR/$source_relative"
    target="$HOME/$target_relative"
    [ -e "$source" ] || die "Missing personal source: $source"
    if ! owned_link "$source" "$target" && exists "$target"; then
      confirm_conflict "$target"
    fi
  done
}

install_link() {
  local source="$1" target="$2" label="$3"
  if owned_link "$source" "$target"; then say "Unchanged: $label ($target)"; return; fi
  if exists "$target"; then
    if [ "$DRY_RUN" -eq 1 ]; then say "PLAN: move $target to $target.bak"; else mv "$target" "$target.bak"; fi
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    say "PLAN: link $target -> $source"
  else
    mkdir -p "$(dirname "$target")"
    ln -s "$source" "$target"
  fi
  say "Linked: $label ($target)"
}

uninstall_link() {
  local source="$1" target="$2" label="$3"
  if ! owned_link "$source" "$target"; then say "Preserved: $label ($target is absent, changed, or unowned)"; return; fi
  if [ "$DRY_RUN" -eq 1 ]; then say "PLAN: remove $target"; else rm "$target"; fi
  say "Removed: $label ($target)"
  if exists "$target.bak"; then say "Preserved backup for manual restoration: $target.bak"; fi
}

status_link() {
  local source="$1" target="$2" label="$3"
  if owned_link "$source" "$target"; then say "owned link: $label -> $target"
  elif exists "$target"; then say "foreign/drifted: $label -> $target"
  else say "absent: $label -> $target"; fi
}

verify_link() {
  [ -e "$1" ] && owned_link "$1" "$2" || { printf 'FAILED: %s is absent or drifted: %s\n' "$3" "$2" >&2; return 1; }
  say "verified: $3"
}

run_manifest() {
  local action="$1" entry source_relative target_relative label result=0
  for entry in "${PERSONAL_LINKS[@]}"; do
    IFS='|' read -r source_relative target_relative label <<<"$entry"
    "$action" "$REPO_DIR/$source_relative" "$HOME/$target_relative" "$label" || result=1
  done
  return "$result"
}

validate_environment
case "$OPERATION" in
  install) preflight_install; run_manifest install_link ;;
  uninstall) run_manifest uninstall_link ;;
  status) run_manifest status_link ;;
  verify) run_manifest verify_link || exit 1; say 'Verification passed.' ;;
esac
