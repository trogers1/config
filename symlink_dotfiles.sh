#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

shopt -s nullglob

symlinked=0

for source_path in "$REPO_DIR"/.*; do
  name="$(basename "$source_path")"

  case "$name" in
    .|..|.git|.gitignore)
      continue
      ;;
  esac

  target_path="$HOME/$name"
  ln -snf "$source_path" "$target_path"
  printf 'Symlinked %s -> %s\n' "$source_path" "$target_path"
  symlinked=1
done

if [ "$symlinked" -eq 0 ]; then
  echo "No dotfiles found to symlink."
fi
