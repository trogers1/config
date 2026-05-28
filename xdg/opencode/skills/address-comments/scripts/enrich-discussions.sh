#!/usr/bin/env bash
# Attach award_emoji arrays to each human note (read-only GET per note).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/gitlab-read.sh
source "$SCRIPT_DIR/lib/gitlab-read.sh"

discussions_file="${1:?discussions json path required}"
mr_iid="${2:?merge request iid required}"

gitlab_read_validate_iid "$mr_iid"

reactions_map="$(mktemp)"
trap 'rm -f "$reactions_map"' EXIT
echo '{}' >"$reactions_map"

while IFS= read -r note_id; do
  gitlab_read_validate_note_id "$note_id"
  awards="$(
    gitlab_read_get "$(gitlab_read_project_endpoint "merge_requests/${mr_iid}/notes/${note_id}/award_emoji")" 2>/dev/null || echo '[]'
  )"
  jq --arg id "$note_id" --argjson awards "$awards" '. + {($id): $awards}' "$reactions_map" >"${reactions_map}.next"
  mv "${reactions_map}.next" "$reactions_map"
done < <(jq -r '[.[] | .notes[] | select(.system == false) | .id] | unique | .[]' "$discussions_file")

jq --slurpfile reactions "$reactions_map" '
  map(
    .notes |= map(
      . + {award_emoji: ($reactions[0][(.id | tostring)] // [])}
    )
  )
' "$discussions_file"
