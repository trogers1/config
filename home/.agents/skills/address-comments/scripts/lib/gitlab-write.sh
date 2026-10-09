#!/usr/bin/env bash
# Shared write-capable GitLab API helpers for posting MR replies.
# Sourced by post-replies.sh only — not executed directly. Kept separate from
# gitlab-read.sh so guard policies can allow the read scripts freely and always
# prompt before anything that writes.
set -euo pipefail

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "gitlab-write.sh is a library; source it from another script." >&2
  exit 1
fi

gitlab_write_validate_discussion_id() {
  local discussion_id="$1"
  if [[ ! "$discussion_id" =~ ^[0-9a-f]+$ ]]; then
    echo "Invalid discussion id (expected hex): $discussion_id" >&2
    exit 1
  fi
}

# Only these write endpoint shapes are permitted, each tied to one method.
gitlab_write_validate_endpoint() {
  local method="$1"
  local endpoint="$2"
  local allowed=0

  case "$method $endpoint" in
    "POST projects/"*/merge_requests/[0-9]*/discussions/[0-9a-f]*/notes)
      allowed=1
      ;;
    "PUT projects/"*/merge_requests/[0-9]*/discussions/[0-9a-f]*\?resolved=true)
      allowed=1
      ;;
  esac

  if [[ "$allowed" -ne 1 ]]; then
    echo "GitLab endpoint not on write allowlist: $method $endpoint" >&2
    exit 1
  fi
}

# Append a reply note to an existing discussion. Prints the created note JSON.
gitlab_write_reply() {
  local mr_iid="$1"
  local discussion_id="$2"
  local body_file="$3"
  local endpoint payload

  gitlab_read_validate_iid "$mr_iid"
  gitlab_write_validate_discussion_id "$discussion_id"
  endpoint="$(gitlab_read_project_endpoint "merge_requests/${mr_iid}/discussions/${discussion_id}/notes")"
  gitlab_write_validate_endpoint POST "$endpoint"

  payload="$(jq -Rs '{body: .}' <"$body_file")"
  glab api --method POST "$endpoint" \
    --header "Content-Type: application/json" \
    --input - <<<"$payload"
}

# Mark a discussion resolved. Prints the updated discussion JSON.
gitlab_write_resolve() {
  local mr_iid="$1"
  local discussion_id="$2"
  local endpoint

  gitlab_read_validate_iid "$mr_iid"
  gitlab_write_validate_discussion_id "$discussion_id"
  endpoint="$(gitlab_read_project_endpoint "merge_requests/${mr_iid}/discussions/${discussion_id}?resolved=true")"
  gitlab_write_validate_endpoint PUT "$endpoint"

  glab api --method PUT "$endpoint"
}
