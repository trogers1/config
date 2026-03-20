#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="$REPO_DIR/home"
XDG_DIR="$REPO_DIR/xdg"

symlinked=0
failed=0

warn_red() {
  printf '\033[31m%s\033[0m\n' "$1" >&2
}

resolve_path() {
  python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

safe_link() {
  local source_path="$1"
  local target_path="$2"
  local label="$3"
  local source_real
  local target_real

  if [ -e "$target_path" ] && [ ! -L "$target_path" ]; then
    warn_red "Failed to symlink $label $source_path -> $target_path: destination already exists and is not a symlink"
    return 1
  fi

  ln -sfn "$source_path" "$target_path"

  if [ ! -L "$target_path" ]; then
    warn_red "Failed to symlink $label $source_path -> $target_path: destination is not a symlink after linking"
    return 1
  fi

  source_real="$(resolve_path "$source_path")"
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

if [ "$symlinked" -eq 0 ]; then
  echo "No config files found to symlink."
fi

if [ "$failed" -ne 0 ]; then
  warn_red "One or more config symlinks failed."
  exit 1
fi
