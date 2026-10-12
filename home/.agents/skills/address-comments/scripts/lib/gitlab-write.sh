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
    "POST projects/"*/merge_requests/[0-9]*/discussions)
      allowed=1
      ;;
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

gitlab_write_validate_line() {
  local line="$1"
  if [[ ! "$line" =~ ^[1-9][0-9]*$ ]]; then
    echo "Invalid line number (expected a positive integer): $line" >&2
    exit 1
  fi
}

# Print the GitLab diff position for new-side lines start_line..end_line of
# path in the MR's latest diff. Every line in the range must be visible in the
# diff as an added or unchanged line; removed lines cannot be targeted.
gitlab_write_build_position() {
  local mr_iid="$1"
  local path="$2"
  local start_line="$3"
  local end_line="$4"
  local mr_endpoint mr diffs path_sha

  if [[ -z "$path" || "$path" == *$'\n'* ]]; then
    echo "Invalid path (expected a non-empty single-line file path): $path" >&2
    exit 1
  fi
  gitlab_write_validate_line "$start_line"
  gitlab_write_validate_line "$end_line"
  if [[ "$start_line" -gt "$end_line" ]]; then
    echo "Invalid line range: --start-line $start_line is after --end-line $end_line" >&2
    exit 1
  fi

  mr_endpoint="$(gitlab_read_project_endpoint "merge_requests/${mr_iid}")"
  mr="$(gitlab_read_get "$mr_endpoint")"
  diffs="$(gitlab_read_get_all "merge_requests/${mr_iid}/diffs")"
  # GitLab line codes are <sha1 of new_path>_<old line>_<new line>.
  path_sha="$(printf '%s' "$path" | shasum -a 1 | cut -d ' ' -f 1)"

  jq -n --argjson mr "$mr" --argjson diffs "$diffs" --arg path "$path" --arg path_sha "$path_sha" \
    --argjson start "$start_line" --argjson end "$end_line" '
    def fail($msg): error("\($msg)");
    def sha: type == "string" and test("^[0-9a-f]{40}$");
    # Walk the unified diff the way GitLab numbers it: an added line carries the
    # current old-side counter, an unchanged line carries both.
    def new_side_lines:
      rtrimstr("\n") | split("\n")
      | reduce .[] as $l ({old: null, new: null, lines: []};
          if ($l | startswith("@@ ")) then
            ($l | capture("^@@ -(?<o>[0-9]+)(,[0-9]+)? \\+(?<n>[0-9]+)(,[0-9]+)? @@")
              // fail("unparseable hunk header in \($path): \($l)")) as $h
            | .old = ($h.o | tonumber) | .new = ($h.n | tonumber)
          elif .old == null then fail("diff for \($path) does not start with a hunk header")
          elif ($l | startswith("+")) then .lines += [{type: "new", old: .old, new: .new}] | .new += 1
          elif ($l | startswith("-")) then .old += 1
          elif ($l | startswith(" ")) then .lines += [{type: null, old: .old, new: .new}] | .old += 1 | .new += 1
          elif ($l | startswith("\\")) then .
          else fail("unexpected diff line in \($path): \($l)")
          end)
      | .lines;
    def range_end($l):
      {line_code: "\($path_sha)_\($l.old)_\($l.new)", type: $l.type,
       old_line: (if $l.type == "new" then null else $l.old end), new_line: $l.new};

    ($mr.diff_refs // fail("merge request has no diff_refs")) as $refs
    | if ($refs.base_sha | sha) and ($refs.start_sha | sha) and ($refs.head_sha | sha) then .
      else fail("merge request diff_refs are not 40-hex SHAs") end
    | [$diffs[] | select(.new_path == $path)] as $files
    | if ($files | length) != 1 then fail("\($path) appears \($files | length) times in the MR diff (expected once)") else . end
    | $files[0] as $file
    | if $file.deleted_file then fail("\($path) is deleted in this MR; it has no new-side lines") else . end
    | if ($file.diff // "") == "" then fail("GitLab returned no diff for \($path) (too large or collapsed)") else . end
    | ($file.diff | new_side_lines) as $lines
    | [range($start; $end + 1) as $n
        | ([$lines[] | select(.new == $n)][0] // fail("line \($n) of \($path) is not an added or unchanged line in the MR diff"))
      ] as $range
    | {
        position_type: "text",
        base_sha: $refs.base_sha, start_sha: $refs.start_sha, head_sha: $refs.head_sha,
        old_path: $file.old_path, new_path: $file.new_path,
        new_line: $range[-1].new,
        old_line: (if $range[-1].type == "new" then null else $range[-1].old end),
        line_range: {start: range_end($range[0]), end: range_end($range[-1])}
      }
  '
}

# Start a new discussion on the MR. --type is required and decides the rest:
#   --type general <mr_iid> <body_file>
#   --type positional --path <file> --start-line <n> --end-line <n> <mr_iid> <body_file>
# Lines are new-side line numbers in the MR's latest diff; pass the same number
# twice for a single line. Prints the created discussion JSON.
gitlab_write_start_thread() {
  local thread_type="" path="" start_line="" end_line="" seen=""
  local args=()

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --type | --path | --start-line | --end-line)
        if [[ "$#" -lt 2 ]]; then
          echo "gitlab_write_start_thread: $1 needs a value" >&2
          exit 1
        fi
        if [[ "$seen " == *" $1 "* ]]; then
          echo "gitlab_write_start_thread: $1 given more than once" >&2
          exit 1
        fi
        seen+=" $1"
        case "$1" in
          --type) thread_type="$2" ;;
          --path) path="$2" ;;
          --start-line) start_line="$2" ;;
          --end-line) end_line="$2" ;;
        esac
        shift 2
        ;;
      -*)
        echo "gitlab_write_start_thread: unknown flag: $1" >&2
        exit 1
        ;;
      *)
        args+=("$1")
        shift
        ;;
    esac
  done

  case "$thread_type" in
    general)
      if [[ "$seen" =~ --path|--start-line|--end-line ]]; then
        echo "gitlab_write_start_thread: --type general takes no --path, --start-line, or --end-line" >&2
        exit 1
      fi
      ;;
    positional)
      local flag
      for flag in --path --start-line --end-line; do
        if [[ "$seen " != *" $flag "* ]]; then
          echo "gitlab_write_start_thread: --type positional requires $flag" >&2
          exit 1
        fi
      done
      ;;
    "")
      echo "gitlab_write_start_thread: --type general|positional is required" >&2
      exit 1
      ;;
    *)
      echo "gitlab_write_start_thread: invalid --type (expected general or positional): $thread_type" >&2
      exit 1
      ;;
  esac
  if [[ "${#args[@]}" -ne 2 ]]; then
    echo "gitlab_write_start_thread: expected <mr_iid> <body_file>, got ${#args[@]} arguments" >&2
    exit 1
  fi
  local mr_iid="${args[0]}"
  local body_file="${args[1]}"
  local endpoint position payload

  gitlab_read_validate_iid "$mr_iid"
  endpoint="$(gitlab_read_project_endpoint "merge_requests/${mr_iid}/discussions")"
  gitlab_write_validate_endpoint POST "$endpoint"

  case "$thread_type" in
    general)
      payload="$(jq -Rs '{body: .}' <"$body_file")"
      ;;
    positional)
      position="$(gitlab_write_build_position "$mr_iid" "$path" "$start_line" "$end_line")"
      payload="$(jq -n --rawfile body "$body_file" --argjson position "$position" '{body: $body, position: $position}')"
      ;;
  esac
  glab api --method POST "$endpoint" \
    --header "Content-Type: application/json" \
    --input - <<<"$payload"
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
