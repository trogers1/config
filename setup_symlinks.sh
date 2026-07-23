#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="$REPO_DIR/home"
XDG_DIR="$REPO_DIR/xdg"

symlinked=0
failed=0

printf '\nSetting up your config symlinks...\n'

warn_red() {
  printf '\033[31m%s\033[0m\n' "$1" >&2
}

resolve_path() {
  python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

prompt_backup_or_skip() {
  local target_path="$1"
  local backup_path="$2"
  local label="$3"
  local reply

  if ! { true < /dev/tty; } 2>/dev/null; then
    warn_red "Found pre-existing $label config at $target_path, but no interactive prompt is available. Skipping."
    return 1
  fi

  while true; do
    printf 'Found pre-existing %s config at %s. Shall I back it up to %s and still symlink this config (y/Y) or skip this one (n/N)? ' "$label" "$target_path" "$backup_path" > /dev/tty
    read -r reply < /dev/tty

    case "$reply" in
      y|Y)
        return 0
        ;;
      n|N)
        return 1
        ;;
      *)
        printf 'Please answer y or n.\n' > /dev/tty
        ;;
    esac
  done
}

safe_link() {
  local source_path="$1"
  local target_path="$2"
  local label="$3"
  local backup_path
  local source_real
  local target_real

  source_real="$(resolve_path "$source_path")"

  if [ -L "$target_path" ]; then
    target_real="$(resolve_path "$target_path")"

    if [ "$source_real" = "$target_real" ]; then
      printf 'Already symlinked %s %s -> %s\n' "$label" "$source_path" "$target_path"
      symlinked=1
      return 0
    fi
  fi

  if [ -e "$target_path" ] || [ -L "$target_path" ]; then
    backup_path="$target_path.bak"

    if [ -f "$source_path" ] && [ -f "$target_path" ] && cmp -s "$source_path" "$target_path"; then
      rm "$target_path"
      printf 'Replaced identical existing %s config at %s with symlink\n' "$label" "$target_path"
    else
      if ! prompt_backup_or_skip "$target_path" "$backup_path" "$label"; then
        printf 'Skipped %s %s -> %s\n' "$label" "$source_path" "$target_path"
        return 0
      fi

      if [ -e "$backup_path" ] || [ -L "$backup_path" ]; then
        warn_red "Failed to symlink $label $source_path -> $target_path: backup path already exists at $backup_path"
        return 1
      fi

      mv "$target_path" "$backup_path"
      printf 'Backed up existing %s to %s\n' "$target_path" "$backup_path"
    fi
  fi

  ln -sfn "$source_path" "$target_path"

  if [ ! -L "$target_path" ]; then
    warn_red "Failed to symlink $label $source_path -> $target_path: destination is not a symlink after linking"
    return 1
  fi

  target_real="$(resolve_path "$target_path")"

  if [ "$source_real" != "$target_real" ]; then
    warn_red "Failed to symlink $label $source_path -> $target_path: link resolves to $target_real"
    return 1
  fi

  printf 'Symlinked %s %s -> %s\n' "$label" "$source_path" "$target_path"
  symlinked=1
}

link_entries() {
  local source_dir="$1"
  local target_dir="$2"
  local label="$3"
  local source_path

  if [ ! -d "$source_dir" ]; then
    return
  fi

  mkdir -p "$target_dir"

  shopt -s dotglob nullglob
  for source_path in "$source_dir"/*; do
    local name
    local target_path

    name="$(basename "$source_path")"

    case "$name" in
      README|README.*)
        continue
        ;;
      .cursor)
        # Only cli-config.json is managed here; do not replace all of ~/.cursor.
        continue
        ;;
      .pi)
        # Only selected pi agent files are managed here; do not replace all of ~/.pi.
        continue
        ;;
    esac

    target_path="$target_dir/$name"

    if ! safe_link "$source_path" "$target_path" "$label"; then
      failed=1
    fi
  done
  shopt -u dotglob nullglob
}

link_entries "$HOME_DIR" "$HOME" "home"
link_entries "$XDG_DIR" "$HOME/.config" "xdg"

cursor_cli_config="$HOME_DIR/.cursor/cli-config.json"
if [ -f "$cursor_cli_config" ]; then
  mkdir -p "$HOME/.cursor"
  if ! safe_link "$cursor_cli_config" "$HOME/.cursor/cli-config.json" "cursor cli"; then
    failed=1
  fi
fi

pi_settings="$HOME_DIR/.pi/agent/settings.json"
if [ -f "$pi_settings" ]; then
  mkdir -p "$HOME/.pi/agent"
  if ! safe_link "$pi_settings" "$HOME/.pi/agent/settings.json" "pi settings"; then
    failed=1
  fi
fi

pi_models="$HOME_DIR/.pi/agent/models.json"
if [ -f "$pi_models" ]; then
  mkdir -p "$HOME/.pi/agent"
  if ! safe_link "$pi_models" "$HOME/.pi/agent/models.json" "pi models"; then
    failed=1
  fi
fi

pi_packages_dir="$HOME_DIR/.pi/agent/packages"
if [ -d "$pi_packages_dir" ]; then
  mkdir -p "$HOME/.pi/agent/packages"
  shopt -s dotglob nullglob
  for package_path in "$pi_packages_dir"/*; do
    package_name="$(basename "$package_path")"
    if ! safe_link "$package_path" "$HOME/.pi/agent/packages/$package_name" "pi package"; then
      failed=1
    fi
  done
  shopt -u dotglob nullglob
fi

pi_skills="$HOME_DIR/.pi/agent/skills"
if [ -d "$pi_skills" ]; then
  mkdir -p "$HOME/.pi/agent"
  if ! safe_link "$pi_skills" "$HOME/.pi/agent/skills" "pi skills"; then
    failed=1
  fi
fi

pi_usage="$HOME_DIR/.pi/agent/usage"
if [ -d "$pi_usage" ]; then
  mkdir -p "$HOME/.pi/agent"
  if ! safe_link "$pi_usage" "$HOME/.pi/agent/usage" "pi usage config"; then
    failed=1
  fi
fi

pi_permissions="$HOME_DIR/.pi/agent/permissions"
if [ -d "$pi_permissions" ]; then
  mkdir -p "$HOME/.pi/agent"
  if ! safe_link "$pi_permissions" "$HOME/.pi/agent/permissions" "pi permissions config"; then
    failed=1
  fi
fi

if [ "$symlinked" -eq 0 ]; then
  echo "No config files found to symlink."
fi

if [ "$failed" -ne 0 ]; then
  warn_red "One or more config symlinks failed."
  exit 1
fi
