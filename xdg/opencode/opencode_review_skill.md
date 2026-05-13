# OpenCode Review Export Skill

Use this workflow to export human MR review comments from GitLab into a local Markdown file with local code links.

## Rules

- Use `glab`, not the GitLab web UI.
- Only include human comments where `system == false`.
- Exclude GitLab system notes like `added commits`, `changed this line`, assignment events, and other activity logs.
- Include the user's own human comments if they replied in a discussion.
- For diff comments, link to local files with relative Markdown links like `src/file.ts#L123`, not GitLab URLs.
- If a diff note has a file path but no line number, link to the file path only.

## Exact Commands

Get the current branch name:

```bash
git rev-parse --abbrev-ref HEAD
```

Look up the open MR for that branch. Replace `<branch>` with the branch name from the previous command:

```bash
glab api "projects/:fullpath/merge_requests?source_branch=<branch>&state=opened"
```

From that JSON, copy the MR `iid`. Then fetch the discussions for that MR. Replace `<iid>` with the MR iid:

```bash
glab api "projects/:fullpath/merge_requests/<iid>/discussions?per_page=100"
```

If needed, save the discussion JSON to a temp file with shell redirection and then run this exact `jq` command against it. Replace `<discussion-json-file>` with the path to the saved JSON file:

```bash
jq -r '. as $all | ($all[0].notes[0].noteable_iid | tostring) as $mr_iid | "# Merge Request Comments\n\n" + "Merge request: !\($mr_iid)\n\n" + ([ $all[] | . as $d | ($d.notes | map(select(.system == false))) as $human | select(($human | length) > 0) ] | to_entries | map(.value as $d | ($d.notes | map(select(.system == false))) as $human | "## Discussion \(.key + 1)\n\n" + (if ($human[0].position // null) then (($human[0].position.new_path // $human[0].position.old_path) as $path | ($human[0].position.new_line // $human[0].position.old_line // $human[0].position.line_range.start.new_line // $human[0].position.line_range.start.old_line) as $line | if ($line == null) then "Code: [\($path)](\($path))\n\n" else "Code: [\($path)#L\($line)](\($path)#L\($line))\n\n" end) else "" end) + "Status: " + (if ($d.resolved // false) then "resolved" else "unresolved" end) + "\n\n" + ([$human[] | "**\(.author.name)** (@\(.author.username)) - \(.created_at)\n\n" + (.body | gsub("\r"; ""))] | join("\n\n---\n\n"))) | join("\n\n"))' <discussion-json-file>
```

## Output Expectations

- Write the final Markdown to `comments.md` in the repo root.
- Preserve discussion ordering from the API response.
- Preserve all human comments in each discussion, including author replies.
- Do not rewrite comment text except for normal JSON decoding handled by `jq`.

## Notes

- `glab mr view --comments --output json` may work in some environments, but `glab api "projects/:fullpath/merge_requests/<iid>/discussions?per_page=100"` is the more reliable command to use.
- If the MR has more than 100 discussions, fetch additional pages with `&page=2`, `&page=3`, and combine them before running the `jq` command.
