#!/usr/bin/env bash
# Post approved `**Reply — APPROVED**` blocks from comments.md to their GitLab
# MR discussions. Dry-run preview by default; writes only with --post. Agents
# preview through preview-replies.sh, which can never pass --post.
#
# Usage: post-replies.sh <mr-url> [comments-file] [--post] [--resolve]
#
#   --post     actually create the reply notes (otherwise preview only)
#   --resolve  also resolve threads whose block is `**Reply — APPROVED, RESOLVE**`
#
# Idempotent: a reply is skipped when the live thread already has a note by the
# current glab user with the same body (whitespace-trimmed). After posting (and
# resolving, when requested), the block header is rewritten to
# `**Reply — POSTED** [note_<id>](<mr-url>#note_<id>) <timestamp>`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/gitlab-read.sh
source "$SCRIPT_DIR/lib/gitlab-read.sh"
# shellcheck source=lib/gitlab-write.sh
source "$SCRIPT_DIR/lib/gitlab-write.sh"

# Field separator for the manifest and plan files. Unlike tab, a non-whitespace
# IFS character never collapses empty fields in `read`.
US=$'\x1f'

post=0
resolve=0
positional=()
for arg in "$@"; do
  case "$arg" in
    --post) post=1 ;;
    --resolve) resolve=1 ;;
    -*)
      echo "Unknown flag: $arg" >&2
      exit 1
      ;;
    *) positional+=("$arg") ;;
  esac
done

if [[ "${#positional[@]}" -gt 2 ]]; then
  echo "Too many arguments: ${positional[*]}" >&2
  exit 1
fi
mr_url="${positional[0]:?merge request URL required}"
comments_file="${positional[1]:-comments.md}"

if [[ ! -f "$comments_file" ]]; then
  echo "comments file not found: $comments_file" >&2
  exit 1
fi

gitlab_read_validate_mr_url "$mr_url"
mr_iid="$(gitlab_read_mr_iid_from_url "$mr_url")"
GITLAB_READ_PROJECT_ID="$(gitlab_read_project_id_from_url "$mr_url")"
export GITLAB_READ_PROJECT_ID
mr_url="$(gitlab_read_normalize_mr_url "$mr_url")"

work_dir="$(mktemp -d /tmp/post-replies.XXXXXX)"
trap 'rm -rf "$work_dir"' EXIT

# Extract APPROVED blocks. render-comments-md.sh wraps each discussion's
# reviewer notes in `<!-- reviewer-comments:begin/end -->` and refuses notes
# containing those markers, so everything between them is reviewer text and is
# never parsed as structure. A discussion is a `## ` heading whose first
# non-blank line is its `Thread:` link; Reply blocks count only after that
# discussion's end marker. A block's body runs from the line after its header
# to the next bare `---` outside a code fence, the next `## ` heading, or EOF.
# Manifest fields: seq, discussion heading, thread note id, header line number,
# header text, resolve.
manifest="$work_dir/manifest"
awk -v work_dir="$work_dir" -v us="$US" '
  function fail(msg) { print FILENAME ":" NR ": " msg > "/dev/stderr"; failed = 1; exit 2 }
  function close_block() {
    if (!in_block) return
    in_block = 0
    if (body_lines == 0) fail("empty Reply body for " heading)
    close(body_file)
  }
  function fence_of(line) {
    if (match(line, /^ *(```+|~~~+)/)) { s = substr(line, RSTART, RLENGTH); sub(/^ +/, "", s); return s }
    return ""
  }
  BEGIN {
    seq = 0; in_block = 0; fence = ""; heading = ""; note_id = ""; mr_line = ""
    begin_marker = "<!-- reviewer-comments:begin -->"
    end_marker = "<!-- reviewer-comments:end -->"
    # preamble: before the first heading; head: awaiting the Thread: line;
    # pre: between Thread: and the begin marker; comments: reviewer text;
    # local: after the end marker; orphan: a heading with no Thread: line.
    phase = "preamble"
  }
  {
    line = $0
    if (index(line, us)) fail("unexpected control character (0x1f)")
    if (phase == "comments") {
      if (line == end_marker) phase = "local"
      else if (line == begin_marker) fail("nested " begin_marker " in " heading)
      next
    }
    if (phase == "head") {
      if (line ~ /^[[:space:]]*$/) next
      if (line ~ /^Thread: \[![0-9]+\]\([^)]*#note_[0-9]+\)$/) {
        match(line, /#note_[0-9]+\)$/)
        note_id = substr(line, RSTART + 6, RLENGTH - 7)
        phase = "pre"
        next
      }
      phase = "orphan"
    }
    f = fence_of(line)
    if (fence != "") {
      # Closing fence: same character, at least as long, nothing else after it.
      if (f != "" && substr(f, 1, 1) == substr(fence, 1, 1) && length(f) >= length(fence) && line ~ /^ *(```+|~~~+) *$/) fence = ""
    } else if (f != "") {
      fence = f
    } else {
      if (line ~ /^## /) {
        close_block()
        heading = substr(line, 4); note_id = ""; approved_here = 0; phase = "head"
        next
      }
      if (phase == "preamble" && mr_line == "" && line ~ /^Merge request: \[![0-9]+\]\([^)]+\)$/) {
        mr_line = line
        sub(/^Merge request: \[![0-9]+\]\(/, "", mr_line); sub(/\)$/, "", mr_line)
        next
      }
      if (line == begin_marker) {
        if (phase != "pre") fail(begin_marker " outside a discussion header in " heading)
        phase = "comments"
        next
      }
      if (line == end_marker) fail(end_marker " without a matching begin marker in " heading)
      if (line ~ /^---[[:space:]]*$/ && in_block) { close_block(); next }
      if (line ~ /^\*\*Reply/) {
        close_block()
        if (phase == "pre") fail("Reply block before the reviewer comments of " heading " (comments.md predates the reviewer-comments markers; re-render it)")
        if (line ~ /^\*\*Reply — (DRAFT|POSTED)\*\*/) next
        if (line ~ /^\*\*Reply — APPROVED(, RESOLVE)?\*\*[[:space:]]*$/) {
          if (note_id == "") fail("APPROVED Reply outside a discussion with a Thread: link")
          if (approved_here) fail("more than one APPROVED Reply in " heading)
          approved_here = 1
          seq++
          in_block = 1; body_lines = 0; pending_blank = 0
          body_file = work_dir "/body." seq
          printf "" > body_file
          printf "%d%s%s%s%s%s%d%s%s%s%d\n", seq, us, heading, us, note_id, us, NR, us, line, us, (line ~ /RESOLVE/) > (work_dir "/manifest")
          next
        }
        fail("unrecognized Reply header (expected DRAFT, APPROVED, APPROVED, RESOLVE, or POSTED): " line)
      }
    }
    if (in_block) {
      # Drop leading blank lines; buffer interior ones so trailing blanks are trimmed.
      if (line ~ /^[[:space:]]*$/) { if (body_lines > 0) pending_blank++; next }
      while (pending_blank > 0) { print "" > body_file; pending_blank--; body_lines++ }
      print line > body_file
      body_lines++
    }
  }
  END {
    if (failed) exit 2
    close_block()
    if (fence != "") { print FILENAME ": unterminated code fence" > "/dev/stderr"; exit 2 }
    if (phase == "comments") { print FILENAME ": unterminated reviewer comments in " heading > "/dev/stderr"; exit 2 }
    if (mr_line == "") { print FILENAME ": no `Merge request: [!<iid>](<url>)` line before the first discussion" > "/dev/stderr"; exit 2 }
    print mr_line > (work_dir "/file_mr_url")
  }
' "$comments_file"

# Refuse to post a comments.md rendered for a different MR.
file_mr_url="$(cat "$work_dir/file_mr_url")"
if [[ "$file_mr_url" != "$mr_url" ]]; then
  echo "$comments_file was rendered for $file_mr_url, not $mr_url" >&2
  exit 1
fi

if [[ ! -s "$manifest" ]]; then
  echo "No **Reply — APPROVED** blocks in $comments_file; nothing to post."
  exit 0
fi

discussions_json="$work_dir/discussions.json"
"$SCRIPT_DIR/fetch-mr-discussions.sh" "$mr_iid" "$discussions_json"
# Only the current user's own notes count as an earlier post of a reply.
me="$(gitlab_read_get user | jq -er '.username')"

# Plan every block against live GitLab before writing anything.
plan="$work_dir/plan"
: >"$plan"
seen_discussions=" "
while IFS="$US" read -r -u 3 seq heading note_id header_line header_text wants_resolve; do
  gitlab_read_validate_note_id "$note_id"
  jq -er --argjson nid "$note_id" --arg me "$me" --arg us "$US" --rawfile body "$work_dir/body.$seq" '
    def norm: gsub("\r"; "") | sub("^\\s+"; "") | sub("\\s+$"; "");
    first(.[] | select(any(.notes[]; .id == $nid))) as $d
    | [
        $d.id,
        (if ($d.notes[0].resolvable // false) then "resolvable" else "not-resolvable" end),
        (if ([$d.notes[] | select(.resolvable // false)] | all(.resolved // false)) then "resolved" else "unresolved" end),
        ([$d.notes[] | select(.system == false and .author.username == $me and (.body | norm) == ($body | norm)) | .id][0] // "" | tostring)
      ]
    | join($us)
  ' "$discussions_json" >"$work_dir/row" || {
    echo "Thread note_$note_id ($heading) not found on $mr_url" >&2
    exit 1
  }
  IFS="$US" read -r discussion_id resolvable state existing_note <"$work_dir/row"
  gitlab_write_validate_discussion_id "$discussion_id"
  if [[ "$seen_discussions" == *" $discussion_id "* ]]; then
    echo "More than one APPROVED Reply targets discussion $discussion_id (latest: $heading, note_$note_id)" >&2
    exit 1
  fi
  seen_discussions+="$discussion_id "
  printf '%s\n' "$seq$US$heading$US$note_id$US$header_line$US$header_text$US$wants_resolve$US$discussion_id$US$resolvable$US$state$US$existing_note" >>"$plan"
done 3<"$manifest"

# Decide whether a block's thread should be resolved; prints the reason when not.
resolve_action() {
  local wants_resolve="$1" resolvable="$2" state="$3"
  if [[ "$wants_resolve" -ne 1 ]]; then
    echo "no"
  elif [[ "$resolvable" != "resolvable" ]]; then
    echo "skip (thread is not resolvable)"
  elif [[ "$state" == "resolved" ]]; then
    echo "skip (already resolved)"
  elif [[ "$resolve" -ne 1 ]]; then
    echo "skip (RESOLVE tagged but --resolve not passed)"
  else
    echo "yes"
  fi
}

total="$(wc -l <"$plan" | tr -d ' ')"
echo "Merge request: $mr_url"
echo "Comments file: $comments_file"
echo "Mode: $(if [[ "$post" -eq 1 ]]; then echo POST; else echo "DRY RUN"; fi)"
echo
while IFS="$US" read -r -u 3 seq heading note_id _ _ wants_resolve discussion_id resolvable state existing_note; do
  echo "[$seq/$total] $heading — $mr_url#note_$note_id"
  echo "  discussion: $discussion_id ($state)"
  if [[ -n "$existing_note" ]]; then
    echo "  reply: skip (already posted as note_$existing_note)"
  else
    echo "  reply: post"
  fi
  echo "  resolve: $(resolve_action "$wants_resolve" "$resolvable" "$state")"
  if [[ -z "$existing_note" ]]; then
    echo "  ----- body (posted verbatim) -----"
    cat "$work_dir/body.$seq"
    echo "  ---------------------------------"
  fi
  echo
done 3<"$plan"

if [[ "$post" -ne 1 ]]; then
  echo "Dry run only. Rerun post-replies.sh with --post to apply$(if [[ "$resolve" -ne 1 ]]; then echo " (add --resolve to resolve RESOLVE-tagged threads)"; fi)."
  exit 0
fi

# Replace one header line of comments.md in place, re-reading the file so edits
# made since planning are kept. Fails if that line no longer holds the header
# read at planning time (the file was edited underneath us).
rewrite_header() {
  local line_no="$1"
  local expected="$2"
  local text="$3"
  local tmp
  tmp="$(mktemp "$comments_file.XXXXXX")"
  if ! awk -v n="$line_no" -v expected="$expected" -v text="$text" '
    NR == n { found = 1; if ($0 != expected) exit 3; print text; next }
    { print }
    END { if (!found) exit 3 }
  ' "$comments_file" >"$tmp"; then
    rm -f "$tmp"
    echo "$comments_file:$line_no no longer reads '$expected'; the file changed during posting. Not rewriting it — set this header by hand to: $text" >&2
    exit 1
  fi
  chmod 644 "$tmp"
  mv "$tmp" "$comments_file"
}

while IFS="$US" read -r -u 3 seq heading note_id header_line header_text wants_resolve discussion_id resolvable state existing_note; do
  if [[ -n "$existing_note" ]]; then
    posted_note="$existing_note"
    echo "[$seq/$total] already posted as note_$posted_note"
  else
    posted_note="$(gitlab_write_reply "$mr_iid" "$discussion_id" "$work_dir/body.$seq" | jq -r '.id')"
    gitlab_read_validate_note_id "$posted_note"
    echo "[$seq/$total] posted $mr_url#note_$posted_note"
  fi
  header="**Reply — POSTED** [note_$posted_note]($mr_url#note_$posted_note) $(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Resolve before marking POSTED: if resolving fails the header keeps its
  # RESOLVE tag, and a rerun skips the duplicate post and retries the resolve.
  if [[ "$(resolve_action "$wants_resolve" "$resolvable" "$state")" == "yes" ]]; then
    gitlab_write_resolve "$mr_iid" "$discussion_id" >/dev/null
    header+=" (thread resolved)"
    echo "[$seq/$total] resolved discussion $discussion_id"
  fi
  rewrite_header "$header_line" "$header_text" "$header"
done 3<"$plan"

echo "Updated $comments_file"
