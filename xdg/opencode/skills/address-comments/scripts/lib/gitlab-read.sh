#!/usr/bin/env bash
# Shared read-only GitLab API helpers for MR comment skills.
# Sourced by other scripts in this directory — not executed directly.
set -euo pipefail

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "gitlab-read.sh is a library; source it from another script." >&2
  exit 1
fi

gitlab_read_validate_iid() {
  local iid="$1"
  if [[ ! "$iid" =~ ^[0-9]+$ ]]; then
    echo "Invalid merge request IID (expected digits): $iid" >&2
    exit 1
  fi
}

gitlab_read_validate_mr_url() {
  local url="$1"
  if [[ ! "$url" =~ ^https?://.+/-/merge_requests/[0-9]+([/?#].*)?$ ]]; then
    echo "Invalid merge request URL: $url" >&2
    exit 1
  fi
}

gitlab_read_project_id_from_url() {
  local url="$1"
  local project_path
  gitlab_read_validate_mr_url "$url"
  project_path="$(sed -E 's#^https?://[^/]+/(.+)/-/merge_requests/[0-9]+([/?#].*)?$#\1#' <<<"$url")"
  jq -rn --arg path "$project_path" '$path | @uri'
}

gitlab_read_mr_iid_from_url() {
  local url="$1"
  gitlab_read_validate_mr_url "$url"
  sed -E 's#^https?://.+/-/merge_requests/([0-9]+)([/?#].*)?$#\1#' <<<"$url"
}

gitlab_read_normalize_mr_url() {
  local url="$1"
  gitlab_read_validate_mr_url "$url"
  sed -E 's#([?#]).*$##' <<<"$url"
}

gitlab_read_validate_note_id() {
  local note_id="$1"
  if [[ ! "$note_id" =~ ^[0-9]+$ ]]; then
    echo "Invalid note id (expected digits): $note_id" >&2
    exit 1
  fi
}

gitlab_read_project_endpoint() {
  local suffix="$1"
  local project_id="${GITLAB_READ_PROJECT_ID:?GITLAB_READ_PROJECT_ID required; pass an MR URL through the refresh script}"
  printf 'projects/%s/%s\n' "$project_id" "$suffix"
}

# Only these read-only endpoint shapes are permitted (GET via glab).
gitlab_read_validate_endpoint() {
  local endpoint="$1"
  local allowed=0

  case "$endpoint" in
    projects/*/merge_requests/[0-9]*/discussions\?per_page=[0-9]*)
      allowed=1
      ;;
    projects/*/merge_requests/[0-9]*/discussions\?per_page=[0-9]*\&page=[0-9]*)
      allowed=1
      ;;
    projects/*/merge_requests/[0-9]*/notes/[0-9]*/award_emoji)
      allowed=1
      ;;
  esac

  if [[ "$allowed" -ne 1 ]]; then
    echo "GitLab endpoint not on read-only allowlist: $endpoint" >&2
    exit 1
  fi
}

# Perform a validated GET request. Never POST/PUT/DELETE.
gitlab_read_get() {
  local endpoint="$1"
  gitlab_read_validate_endpoint "$endpoint"
  glab api --method GET "$endpoint"
}
