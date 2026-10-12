#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/gitlab-read.sh
source "$SCRIPT_DIR/lib/gitlab-read.sh"

mr_iid="${1:?merge request IID required}"
out_file="${2:-}"

gitlab_read_validate_iid "$mr_iid"

merged="$(gitlab_read_get_all "merge_requests/${mr_iid}/discussions")"

if [[ -n "$out_file" ]]; then
  printf '%s\n' "$merged" >"$out_file"
else
  printf '%s\n' "$merged"
fi
