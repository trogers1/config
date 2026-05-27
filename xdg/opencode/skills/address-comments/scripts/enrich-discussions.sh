#!/usr/bin/env bash
# Attach award_emoji arrays to each human note in MR discussions JSON.
# GitLab's discussions endpoint omits reactions; fetch them per note.
set -euo pipefail

discussions_file="${1:?discussions json path required}"
mr_iid="${2:?merge request iid required}"

reactions_map="$(mktemp)"
trap 'rm -f "$reactions_map"' EXIT
echo '{}' >"$reactions_map"

while IFS= read -r note_id; do
  awards="$(
    glab api "projects/:fullpath/merge_requests/${mr_iid}/notes/${note_id}/award_emoji" 2>/dev/null || echo '[]'
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
