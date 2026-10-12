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

  # A glob would let `merge_requests/[0-9]*` match every MR sub-resource.
  if [[ "$endpoint" =~ ^projects/[^/]+/merge_requests/[0-9]+$ ]]; then
    allowed=1
  fi

  case "$endpoint" in
    projects/*/merge_requests/[0-9]*/discussions\?per_page=[0-9]*)
      allowed=1
      ;;
    projects/*/merge_requests/[0-9]*/discussions\?per_page=[0-9]*\&page=[0-9]*)
      allowed=1
      ;;
    projects/*/merge_requests/[0-9]*/diffs\?per_page=[0-9]*)
      allowed=1
      ;;
    projects/*/merge_requests/[0-9]*/diffs\?per_page=[0-9]*\&page=[0-9]*)
      allowed=1
      ;;
    projects/*/merge_requests/[0-9]*/notes/[0-9]*/award_emoji)
      allowed=1
      ;;
    user)
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

# GET every page (up to 10 of 100) of a project list endpoint and print one
# merged JSON array. suffix is relative to the project, e.g.
# merge_requests/12/discussions.
gitlab_read_get_all() {
  local suffix="$1"
  local per_page=100
  local page=1
  local pages=()
  local endpoint chunk count

  while true; do
    if [[ "$page" -eq 1 ]]; then
      endpoint="$(gitlab_read_project_endpoint "${suffix}?per_page=${per_page}")"
    else
      endpoint="$(gitlab_read_project_endpoint "${suffix}?per_page=${per_page}&page=${page}")"
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
    echo '[]'
  else
    jq -s 'add' <<<"$(printf '%s\n' "${pages[@]}")"
  fi
}
