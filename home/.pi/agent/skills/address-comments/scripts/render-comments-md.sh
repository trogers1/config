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

render_robot() {
  jq -r --arg mr_url "$mr_url" '
    . as $all
    | ($all[0].notes[0].noteable_iid | tostring) as $mr_iid
    | "# Merge Request Comments\n\n"
      + "Merge request: [!" + $mr_iid + "](" + $mr_url + ")\n\n"
      + "Only unresolved discussions with :robot: reaction\n\n"
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
                + (
                    [
                      $human[]
                      | "**" + .author.name + "** (@" + .author.username + ") - " + .created_at
                        + " — [comment](" + $mr_url + "#note_" + (.id | tostring) + ")\n\n"
                        + (.body | gsub("\r"; ""))
                    ]
                    | join("\n\n---\n\n")
                  )
            )
          | join("\n\n")
        )
  ' "$discussions_file"
}

render_all() {
  jq -r --arg mr_url "$mr_url" '
    . as $all
    | ($all[0].notes[0].noteable_iid | tostring) as $mr_iid
    | "# Merge Request Comments\n\n"
      + "Merge request: [!" + $mr_iid + "](" + $mr_url + ")\n\n"
      + "All human discussions (resolved and unresolved)\n\n"
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
                + (
                    [
                      $human[]
                      | "**" + .author.name + "** (@" + .author.username + ") - " + .created_at
                        + " — [comment](" + $mr_url + "#note_" + (.id | tostring) + ")\n\n"
                        + (.body | gsub("\r"; ""))
                    ]
                    | join("\n\n---\n\n")
                  )
            )
          | join("\n\n")
        )
  ' "$discussions_file"
}

if [[ "$mode" == "robot" ]]; then
  render_robot >"$out_file"
else
  render_all >"$out_file"
fi

echo "Wrote $out_file"
