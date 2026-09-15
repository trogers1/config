#!/usr/bin/env bash
# Explicit personal dotfile linker; it never invokes the shared installer.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$REPO_DIR/scripts/setup/personal-macos.sh" "$@"
