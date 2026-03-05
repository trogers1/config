#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ln -snf "$REPO_DIR/.zprofile" "$HOME/.zprofile"

echo "Symlinked $REPO_DIR/.zprofile -> $HOME/.zprofile"
