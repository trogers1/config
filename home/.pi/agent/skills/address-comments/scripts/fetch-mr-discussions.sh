#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/gitlab-read.sh
source "$SCRIPT_DIR/lib/gitlab-read.sh"

mr_iid="${1:?merge request IID required}"
out_file="${2:-}"

gitlab_read_validate_iid "$mr_iid"

pages=()
page=1
per_page=100

while true; do
  if [[ "$page" -eq 1 ]]; then
    endpoint="$(gitlab_read_project_endpoint "merge_requests/${mr_iid}/discussions?per_page=${per_page}")"
  else
    endpoint="$(gitlab_read_project_endpoint "merge_requests/${mr_iid}/discussions?per_page=${per_page}&page=${page}")"
  fi

  chunk="$(gitlab_read_get "$endpoint")"
  count="$(jq 'length' <<<"$chunk")"

  if [[ "$count" -eq 0 ]]; then
    break
  fi

  pages+=("$chunk")

  if [[ "$count" -lt "$per_page" ]] || [[ "$page" -ge 10 ]]; then
    break
  fi

  page=$((page + 1))
done

if [[ "${#pages[@]}" -eq 0 ]]; then
  merged='[]'
else
  merged="$(jq -s 'add' <<< "$(printf '%s\n' "${pages[@]}")")"
fi

if [[ -n "$out_file" ]]; then
  printf '%s\n' "$merged" >"$out_file"
else
  printf '%s\n' "$merged"
fi
