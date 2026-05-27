---
name: export-mr-comments
description: >-
  Export all human GitLab MR review comments to comments.md with MR, thread, and
  per-comment links plus local code paths. Use when reviewing an MR, triaging
  feedback, or building a full comment snapshot (not only Robot-tagged threads).
---

# Export MR Comments

Export human MR review comments from GitLab into `comments.md` with local code links and GitLab anchors.

## Rules

- Use `glab api`, not the GitLab web UI.
- Run from the project repo root so `projects/:fullpath` resolves.
- Only include human comments where `system == false`.
- Exclude GitLab system notes (`added commits`, `changed this line`, assignments, etc.).
- Include your own human replies in each thread.
- For diff comments, use relative local Markdown links, not GitLab blob URLs.
- Put line numbers in the link **label** only; keep the Markdown **href** as the file path (for example `[src/a.ts#L10](src/a.ts)`).
- Before writing `comments.md`, verify each code path exists in the repo; if the path is missing, link to the path text only and note that the file may have moved.

## Example

Reference MR (from `~/Code/mcp`, branch `RI-208-add-cache`):

- https://gitlab.economicmodeling.com/ltc/ask-lightcast-ai/mcp/-/merge_requests/125

## Commands

Get the branch name:

```bash
git rev-parse --abbrev-ref HEAD
```

Look up the open MR (replace `<branch>`):

```bash
glab api "projects/:fullpath/merge_requests?source_branch=<branch>&state=opened"
```

From that JSON, copy the MR `iid` and `web_url`. Fetch discussions (replace `<iid>`):

```bash
discussions_json="$(mktemp)"
trap 'rm -f "$discussions_json"' EXIT

glab api "projects/:fullpath/merge_requests/<iid>/discussions?per_page=100" --output json >"$discussions_json"
```

Generate `comments.md` (set `MR_URL` from MR lookup `web_url`):

```bash
MR_URL='<web_url from MR lookup>'
export MR_URL

jq -r --arg mr_url "$MR_URL" '
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
' "$discussions_json" >comments.md
```

## Output

- Write `comments.md` in the repo root.
- Preserve discussion order from the API.
- Preserve all human comments in each thread.
- Do not rewrite comment bodies except JSON decoding via `jq`.

## Notes

- Prefer `glab api "projects/:fullpath/merge_requests/<iid>/discussions?per_page=100"` over `glab mr view --comments`.
- If there are more than 100 discussions, fetch `&page=2`, `&page=3`, merge arrays, then run `jq`.
- To implement fixes on unresolved `:robot:` threads, use the `address-comments` skill instead.
