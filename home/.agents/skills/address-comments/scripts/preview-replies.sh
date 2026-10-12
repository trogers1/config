#!/usr/bin/env bash
# Read-only preview of the replies post-replies.sh would post. Accepts no
# flags at all, so --post (or --resolve) cannot reach post-replies.sh however
# the command line is quoted; guard policies can allow this script freely.
#
# Usage: preview-replies.sh <mr-url> [comments-file]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for arg in "$@"; do
  if [[ "$arg" == -* ]]; then
    echo "preview-replies.sh takes no flags (got: $arg); it only previews." >&2
    exit 1
  fi
done
if [[ "$#" -lt 1 || "$#" -gt 2 ]]; then
  echo "Usage: preview-replies.sh <mr-url> [comments-file]" >&2
  exit 1
fi

exec "$SCRIPT_DIR/post-replies.sh" "$@"
