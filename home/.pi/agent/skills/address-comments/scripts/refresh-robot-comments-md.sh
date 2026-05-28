#!/usr/bin/env bash
# Full read-only pipeline: MR URL -> enrich -> comments.md (robot threads).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/gitlab-read.sh
source "$SCRIPT_DIR/lib/gitlab-read.sh"

mr_url="${1:?merge request URL required}"
out_file="${2:-comments.md}"

gitlab_read_validate_mr_url "$mr_url"
mr_iid="$(gitlab_read_mr_iid_from_url "$mr_url")"
GITLAB_READ_PROJECT_ID="$(gitlab_read_project_id_from_url "$mr_url")"
export GITLAB_READ_PROJECT_ID
mr_url="$(gitlab_read_normalize_mr_url "$mr_url")"

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

discussions_json="$work_dir/discussions.json"
enriched_json="$work_dir/enriched.json"

"$SCRIPT_DIR/fetch-mr-discussions.sh" "$mr_iid" "$discussions_json"
"$SCRIPT_DIR/enrich-discussions.sh" "$discussions_json" "$mr_iid" >"$enriched_json"
"$SCRIPT_DIR/render-comments-md.sh" robot "$enriched_json" "$mr_url" "$out_file"
