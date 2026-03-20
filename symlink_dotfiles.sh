#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="$REPO_DIR/home"
XDG_DIR="$REPO_DIR/xdg"

symlinked=0

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

    ln -snf "$source_path" "$target_path"
    printf 'Symlinked %s %s -> %s\n' "$label" "$source_path" "$target_path"
    symlinked=1
  done
  shopt -u dotglob nullglob
}

link_entries "$HOME_DIR" "$HOME" "home"
link_entries "$XDG_DIR" "$HOME/.config" "xdg"

if [ "$symlinked" -eq 0 ]; then
  echo "No config files found to symlink."
fi
