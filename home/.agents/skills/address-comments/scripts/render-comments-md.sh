#!/usr/bin/env bash
# Render discussions JSON to comments.md (robot filter or full export).
set -euo pipefail

mode="${1:?mode required: robot or all}"
discussions_file="${2:?discussions json path required}"
mr_url="${3:?merge request web_url required}"
out_file="${4:-comments.md}"

if [[ "$mode" != "robot" && "$mode" != "all" ]]; then
  echo "mode must be 'robot' or 'all', got: $mode" >&2
  exit 1
fi

if [[ ! -f "$discussions_file" ]]; then
  echo "discussions file not found: $discussions_file" >&2
  exit 1
fi

# Reviewer text sits between these markers so post-replies.sh can tell it apart
# from local Robot and Reply blocks; a note that contains a marker could forge
# that boundary, so refuse to render it. The usage notes sit in the preamble,
# which post-replies.sh skips, so no line there may start with `**Reply`,
# `## `, `---`, or a code fence.
jq_defs='
  def usage_notes:
    "How to use this file:\n\n"
    + "- Never edit between the `reviewer-comments` markers; that text comes from GitLab and is rewritten on refresh.\n"
    + "- To discuss a thread with the agent, add your notes below its end marker and ask the agent to respond. It answers in `**Robot — RESOLVED**` or `**Robot — UNRESOLVED**` notes, which are never posted.\n"
    + "- To reply on GitLab, ask the agent to draft a `**Reply — DRAFT**` block under the thread, or write one yourself.\n"
    + "- To approve a draft, change its header to `**Reply — APPROVED**`, or `**Reply — APPROVED, RESOLVE**` to also resolve the thread. One approved reply per thread.\n"
    + "- A reply body ends at the next bare `---` line, the next discussion heading, or the end of the file.\n"
    + "- To start a new thread, add a `## New threads` heading at the end and draft `**Thread — DRAFT** general` or `**Thread — DRAFT** positional <path> L<start>-L<end>` blocks under it. Approve them the same way.\n"
    + "- To post, ask the agent to run the `post-mr-replies` skill. It previews every approved reply and thread, posts them only after you say yes in chat, and marks each header POSTED.\n"
    + "- Refreshing rewrites this whole file and drops your notes, replies, and new threads, so post approved ones first.\n\n";
  def reviewer_text:
    if contains("<!-- reviewer-comments:") then
      error("a reviewer note contains the reserved <!-- reviewer-comments: marker; refusing to render it")
    else . end;
'

render_robot() {
  jq -r --arg mr_url "$mr_url" "$jq_defs"'
    . as $all
    | ($all[0].notes[0].noteable_iid | tostring) as $mr_iid
    | "# Merge Request Comments\n\n"
      + "Merge request: [!" + $mr_iid + "](" + $mr_url + ")\n\n"
      + "Only unresolved discussions with :robot: reaction\n\n"
      + usage_notes
      + (
          [
            $all[]
            | . as $d
            | ($d.notes | map(select(.system == false))) as $human
            | select(
                ($d.resolved // false) == false
                and ($human | length) > 0
                and ($d.notes | any((.award_emoji // []) | any(.name == "robot")))
              )
          ]
          | to_entries
          | map(
              .value as $d
              | ($d.notes | map(select(.system == false))) as $human
              | "## Discussion " + (.key + 1 | tostring) + "\n\n"
                + "Thread: [!" + $mr_iid + "](" + $mr_url + "#note_" + ($human[0].id | tostring) + ")\n\n"
                + (
                    if ($human[0].position // null) then
                      (
                        ($human[0].position.new_path // $human[0].position.old_path) as $path
                        | (
                            $human[0].position.new_line
                            // $human[0].position.old_line
                            // $human[0].position.line_range.start.new_line
                            // $human[0].position.line_range.start.old_line
                          ) as $line
                        | if ($line == null) then
                            "Code: [" + $path + "](" + $path + ")\n\n"
                          else
                            "Code: [" + $path + "#L" + ($line | tostring) + "](" + $path + ")\n\n"
                          end
                      )
                    else ""
                    end
                  )
                + "Status: unresolved\n\n"
                + "<!-- reviewer-comments:begin -->\n\n"
                + (
                    [
                      $human[]
                      | "**" + .author.name + "** (@" + .author.username + ") - " + .created_at
                        + " — [comment](" + $mr_url + "#note_" + (.id | tostring) + ")\n\n"
                        + (.body | gsub("\r"; ""))
                      | reviewer_text
                    ]
                    | join("\n\n---\n\n")
                  )
                + "\n\n<!-- reviewer-comments:end -->"
            )
          | join("\n\n")
        )
  ' "$discussions_file"
}

render_all() {
  jq -r --arg mr_url "$mr_url" "$jq_defs"'
    . as $all
    | ($all[0].notes[0].noteable_iid | tostring) as $mr_iid
    | "# Merge Request Comments\n\n"
      + "Merge request: [!" + $mr_iid + "](" + $mr_url + ")\n\n"
      + "All human discussions (resolved and unresolved)\n\n"
      + usage_notes
      + (
          [
            $all[]
            | . as $d
            | ($d.notes | map(select(.system == false))) as $human
            | select($human | length > 0)
          ]
          | to_entries
          | map(
              .value as $d
              | ($d.notes | map(select(.system == false))) as $human
              | "## Discussion " + (.key + 1 | tostring) + "\n\n"
                + "Thread: [!" + $mr_iid + "](" + $mr_url + "#note_" + ($human[0].id | tostring) + ")\n\n"
                + (
                    if ($human[0].position // null) then
                      (
                        ($human[0].position.new_path // $human[0].position.old_path) as $path
                        | (
                            $human[0].position.new_line
                            // $human[0].position.old_line
                            // $human[0].position.line_range.start.new_line
                            // $human[0].position.line_range.start.old_line
                          ) as $line
                        | if ($line == null) then
                            "Code: [" + $path + "](" + $path + ")\n\n"
                          else
                            "Code: [" + $path + "#L" + ($line | tostring) + "](" + $path + ")\n\n"
                          end
                      )
                    else ""
                    end
                  )
                + "Status: "
                + (if ($d.resolved // false) then "resolved" else "unresolved" end)
                + "\n\n"
                + "<!-- reviewer-comments:begin -->\n\n"
                + (
                    [
                      $human[]
                      | "**" + .author.name + "** (@" + .author.username + ") - " + .created_at
                        + " — [comment](" + $mr_url + "#note_" + (.id | tostring) + ")\n\n"
                        + (.body | gsub("\r"; ""))
                      | reviewer_text
                    ]
                    | join("\n\n---\n\n")
                  )
                + "\n\n<!-- reviewer-comments:end -->"
            )
          | join("\n\n")
        )
  ' "$discussions_file"
}

# Render to a temporary file so a failed render never truncates an existing
# comments.md (and the local Robot and Reply blocks in it).
tmp_file="$(mktemp "$out_file.XXXXXX")"
trap 'rm -f "$tmp_file"' EXIT
if [[ "$mode" == "robot" ]]; then
  render_robot >"$tmp_file"
else
  render_all >"$tmp_file"
fi
chmod 644 "$tmp_file"
mv "$tmp_file" "$out_file"

echo "Wrote $out_file"
