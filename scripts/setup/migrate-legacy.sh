#!/usr/bin/env bash
# Explicit one-time migration from the retired setup implementations.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOME_DIR="${HOME:?HOME must be set}"
PI_DIR="$HOME_DIR/.pi/agent"
DRY_RUN=0
PROFILE_TMP=""
MIGRATION_COMPLETE=0
GUARD_CHANGED=0
CHANGED_FILES=()
CREATED_BACKUPS=()
REMOVED_WRAPPERS=()
WRAPPER_COPIES=()

case "$#:${1:-}" in
  0:) ;;
  1:--dry-run) DRY_RUN=1 ;;
  *) printf 'Usage: ./scripts/setup/migrate-legacy.sh [--dry-run]\n' >&2; exit 2 ;;
esac

cleanup() {
  local rc="$?" index file backup
  if [ "$rc" -ne 0 ] && [ "$MIGRATION_COMPLETE" -eq 0 ]; then
    for file in "${CHANGED_FILES[@]:-}"; do backup="$file.legacy.bak"; [ -f "$backup" ] && cp -p "$backup" "$file"; done
    for backup in "${CREATED_BACKUPS[@]:-}"; do rm -f "$backup"; done
    if [ "$GUARD_CHANGED" -eq 1 ]; then rm -rf "$PI_DIR/pi-guard"; ln -s "$REPO_DIR/home/.pi/agent/pi-guard" "$PI_DIR/pi-guard"; fi
    for ((index=0; index<${#REMOVED_WRAPPERS[@]}; index++)); do cp -p "${WRAPPER_COPIES[index]}" "${REMOVED_WRAPPERS[index]}"; done
  fi
  [ -z "$PROFILE_TMP" ] || rm -f "$PROFILE_TMP"
  for file in "${WRAPPER_COPIES[@]:-}"; do rm -f "$file"; done
  return "$rc"
}
trap cleanup EXIT
say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
exists() { [ -e "$1" ] || [ -L "$1" ]; }
owned_link() { [ -L "$2" ] && [ "$(readlink "$2")" = "$1" ]; }

has_legacy_markers() {
  [ -f "$1" ] && grep -Eq '^# (>>> (dev-pi installer (zsh|tmux)|dev worktree (aliases|dhome|shell integration|config)) >>>|<<< (dev-pi installer (zsh|tmux)|dev worktree (aliases|dhome|shell integration|config)) <<<)$' "$1"
}

has_malformed_legacy_marker_shape() {
  [ -f "$1" ] && grep -Eq '^# (>>> (dev-pi installer (zsh|tmux)|dev worktree (aliases|dhome|shell integration|config)) <<<|<<< (dev-pi installer (zsh|tmux)|dev worktree (aliases|dhome|shell integration|config)) >>>)$' "$1"
}

validate_legacy_markers() {
  local file="$1"
  [ -f "$file" ] || return 0
  awk '
    function is_open(line) {
      return line ~ /^# >>> (dev-pi installer (zsh|tmux)|dev worktree (aliases|dhome|shell integration|config)) >>>$/
    }
    is_open($0) {
      if (active) exit 2
      active=1
      expected=$0
      gsub(/>>>/, "<<<", expected)
      next
    }
    $0 ~ /^# <<< (dev-pi installer (zsh|tmux)|dev worktree (aliases|dhome|shell integration|config)) <<<$/{
      if (!active || $0 != expected) exit 2
      active=0
      expected=""
      next
    }
    END { if (active) exit 2 }
  ' "$file" || die "Malformed or mismatched legacy marker blocks in $file; no files were changed."
}

# Validate all migration inputs and backup destinations before the first write.
preflight() {
  local file backup
  case "$(uname -s)" in
    Darwin|MINGW*|MSYS*|CYGWIN*) ;;
    *) die "This migration supports macOS and Git Bash on Windows only." ;;
  esac
  if owned_link "$REPO_DIR/home/.pi/agent/pi-guard" "$PI_DIR/pi-guard"; then
    [ ! -e "$PI_DIR/pi-guard/profiles.jsonc" ] || [ -r "$PI_DIR/pi-guard/profiles.jsonc" ] || die "Cannot read legacy profiles.jsonc"
  fi
  for file in "$HOME_DIR/.pi" "$PI_DIR" "$HOME_DIR/bin"; do
    [ ! -L "$file" ] || die "Refusing to migrate targets beneath symlinked directory: $file"
  done
  for file in "$HOME_DIR/.zshrc" "$HOME_DIR/.tmux.conf"; do
    [ ! -L "$file" ] || {
      if [ "$DRY_RUN" -eq 1 ]; then
        say "PLAN: leave symlinked personal config unchanged: $file"
      else
        say "Leaving symlinked personal config unchanged: $file"
      fi
      continue
    }
    has_malformed_legacy_marker_shape "$file" && die "Malformed legacy marker shape in $file; no files were changed."
    validate_legacy_markers "$file"
    if has_legacy_markers "$file"; then
      backup="$file.legacy.bak"
      if exists "$backup"; then die "Refusing to overwrite migration backup: $backup"; fi
      [ -w "$file" ] && [ -w "$(dirname "$file")" ] || die "Cannot safely rewrite legacy file: $file"
    fi
  done
  return 0
}

remove_legacy_blocks() {
  local file="$1" backup="$1.legacy.bak" tmp
  [ ! -L "$file" ] || return 0
  has_legacy_markers "$file" || return 0
  if [ "$DRY_RUN" -eq 1 ]; then
    say "PLAN: back up $file to $backup and remove validated legacy blocks"
    return
  fi
  tmp="$(mktemp)"
  awk '
    /^# >>> (dev-pi installer (zsh|tmux)|dev worktree (aliases|dhome|shell integration|config)) >>>$/ { skip=1; next }
    /^# <<< (dev-pi installer (zsh|tmux)|dev worktree (aliases|dhome|shell integration|config)) <<<$/{ skip=0; next }
    !skip { print }
  ' "$file" >"$tmp"
  CREATED_BACKUPS+=("$backup")
  cp -p "$file" "$backup"
  mv "$tmp" "$file"
  CHANGED_FILES+=("$file")
  say "Removed known legacy marker blocks from $file (backup: $backup)"
}

legacy_shared_wrapper() {
  cat <<EOF
#!/usr/bin/env bash
# Managed by setup-dev-pi.sh; do not edit.
set -euo pipefail
exec "$REPO_DIR/tmux_and_worktrees/bin/$1" "\$@"
EOF
}

legacy_personal_wrapper() {
  cat <<EOF
#!/bin/bash
set -euo pipefail

# Wrapper script so the real command runs from the repo path,
# which keeps shared helper sourcing simple and symlink-free.
exec "$REPO_DIR/tmux_and_worktrees/bin/$1" "\$@"
EOF
}

legacy_wrapper_owned() {
  local command_name="$1" target="$HOME_DIR/bin/$1"
  [ -f "$target" ] && [ ! -L "$target" ] || return 1
  cmp -s "$target" <(legacy_shared_wrapper "$command_name") || cmp -s "$target" <(legacy_personal_wrapper "$command_name")
}

preflight

# Copy the profile before unlinking. Track existence separately so an empty file
# is preserved, and keep the temporary copy under a cleanup trap.
if owned_link "$REPO_DIR/home/.pi/agent/pi-guard" "$PI_DIR/pi-guard"; then
  profile_present=0
  if [ -f "$PI_DIR/pi-guard/profiles.jsonc" ]; then
    profile_present=1
    PROFILE_TMP="$(mktemp)"
    cp -p "$PI_DIR/pi-guard/profiles.jsonc" "$PROFILE_TMP"
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    say "PLAN: split legacy pi-guard link and preserve profiles.jsonc"
  else
    rm "$PI_DIR/pi-guard"
    GUARD_CHANGED=1
    mkdir -p "$PI_DIR/pi-guard"
    if [ "$profile_present" -eq 1 ]; then cp -p "$PROFILE_TMP" "$PI_DIR/pi-guard/profiles.jsonc"; fi
    say "Split legacy pi-guard link; profiles.jsonc was preserved for personal setup."
  fi
fi

remove_legacy_blocks "$HOME_DIR/.zshrc"
remove_legacy_blocks "$HOME_DIR/.tmux.conf"
for command_name in dnew dopen dtree dclose dkill dmerge; do
  if legacy_wrapper_owned "$command_name"; then
    if [ "$DRY_RUN" -eq 1 ]; then say "PLAN: remove installer-owned legacy wrapper $HOME_DIR/bin/$command_name"
    else
      wrapper_copy="$(mktemp)"
      cp -p "$HOME_DIR/bin/$command_name" "$wrapper_copy"
      REMOVED_WRAPPERS+=("$HOME_DIR/bin/$command_name")
      WRAPPER_COPIES+=("$wrapper_copy")
      rm "$HOME_DIR/bin/$command_name"
      say "Removed installer-owned legacy wrapper $HOME_DIR/bin/$command_name"
    fi
  fi
done

MIGRATION_COMPLETE=1
if [ "$DRY_RUN" -eq 1 ]; then
  say 'Dry-run complete. No files were changed. Run without --dry-run to apply this migration.'
else
  say 'Legacy migration complete. Run ./setup.sh for shared setup or ./setup-personal.sh for personal dotfiles.'
fi
