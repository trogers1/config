#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="$REPO_DIR/home"
XDG_DIR="$REPO_DIR/xdg"

case "${1:-}" in
  "")
    mode="link"
    ;;
  --undo)
    mode="undo"
    ;;
  *)
    printf 'Usage: %s [--undo]\n' "${BASH_SOURCE[0]}" >&2
    exit 2
    ;;
esac

symlinked=0
failed=0

if [ "$mode" = "undo" ]; then
  printf '\nRemoving managed config symlinks and restoring backups...\n'
else
  printf '\nSetting up your config symlinks...\n'
fi

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

undo_link() {
  local source_path="$1"
  local target_path="$2"
  local label="$3"
  local backup_path="${target_path}.bak"
  local source_real
  local target_real

  source_real="$(resolve_path "$source_path")"

  if [ -L "$target_path" ]; then
    target_real="$(resolve_path "$target_path")"
    if [ "$source_real" != "$target_real" ]; then
      warn_red "Refusing to remove unmanaged $label symlink at $target_path"
      failed=1
      return 1
    fi
    rm "$target_path"
    printf 'Removed %s symlink %s\n' "$label" "$target_path"
  elif [ -e "$target_path" ]; then
    warn_red "Refusing to replace existing non-symlink $label at $target_path"
    failed=1
    return 1
  fi

  if [ -e "$backup_path" ] || [ -L "$backup_path" ]; then
    if [ -e "$target_path" ] || [ -L "$target_path" ]; then
      warn_red "Cannot restore $label backup: target already exists at $target_path"
      failed=1
      return 1
    fi
    mv "$backup_path" "$target_path"
    printf 'Restored %s backup %s -> %s\n' "$label" "$backup_path" "$target_path"
  fi
}

safe_link() {
  local source_path="$1"
  local target_path="$2"
  local label="$3"
  local backup_path
  local source_real
  local target_real

  if [ "$mode" = "undo" ]; then
    undo_link "$source_path" "$target_path" "$label"
    return
  fi

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

  if [ "$mode" = "link" ]; then
    mkdir -p "$target_dir"
  fi

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

# Directory entries are expanded dynamically, so new dotfiles, XDG config
# directories, and packages are automatically included in setup and undo.
managed_entry_directories=(
  "$HOME_DIR|$HOME|home"
  "$XDG_DIR|$HOME/.config|xdg"
  "$HOME_DIR/.pi/agent/packages|$HOME/.pi/agent/packages|pi package"
  "$HOME_DIR/.pi/agent/extensions|$HOME/.pi/agent/extensions|pi extension"
)

manage_declared_entry_directories() {
  local entry
  local source_dir
  local target_dir
  local label

  for entry in "${managed_entry_directories[@]}"; do
    IFS='|' read -r source_dir target_dir label <<< "$entry"
    link_entries "$source_dir" "$target_dir" "$label"
  done
}

# One-to-one managed links. Each entry is source-relative path, target-relative
# path, and a display label, separated by |. Add a location here rather than
# duplicating setup/undo control flow.
managed_links=(
  ".cursor/cli-config.json|.cursor/cli-config.json|cursor cli"
  ".pi/agent/settings.json|.pi/agent/settings.json|pi settings"
  ".pi/agent/models.json|.pi/agent/models.json|pi models"
  ".pi/agent/skills|.pi/agent/skills|pi skills"
  ".pi/agent/usage|.pi/agent/usage|pi usage config"
  ".pi/agent/pi-guard|.pi/agent/pi-guard|pi guard config"
)

manage_declared_links() {
  local entry
  local source_relative
  local target_relative
  local label
  local source_path
  local target_path

  for entry in "${managed_links[@]}"; do
    IFS='|' read -r source_relative target_relative label <<< "$entry"
    source_path="$HOME_DIR/$source_relative"
    target_path="$HOME/$target_relative"
    [ -e "$source_path" ] || continue

    if [ "$mode" = "link" ]; then
      mkdir -p "$(dirname "$target_path")"
    fi
    if ! safe_link "$source_path" "$target_path" "$label"; then
      failed=1
    fi
  done
}

manage_declared_entry_directories
manage_declared_links

if [ "$symlinked" -eq 0 ] && [ "$mode" = "link" ]; then
  echo "No config files found to symlink."
fi

if [ "$failed" -ne 0 ]; then
  warn_red "One or more config symlinks failed."
  exit 1
fi
