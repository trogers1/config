---
name: address-comments
description: >-
  Refresh unresolved GitLab MR threads marked with :robot:, implement requested
  changes, verify, and annotate comments.md with Robot resolution notes. Use when
  addressing merge request review feedback, GitLab MR comments, or Robot-tagged
  review threads on the current branch.
---

# Address MR Comments

Use this workflow to refresh unresolved GitLab MR comments, implement the requested changes when feasible, verify the changes, and annotate `comments.md` with a `Robot` resolution note for each addressed discussion.

## Goal

Given an open MR:

- Fetch the current discussions from GitLab using `glab`
- Filter to unresolved human discussions that have a `:robot:` (`robot`) reaction on at least one note in the thread
- Collect discussions that reference one another into a single section to resolve coherently, and write them into `comments.md` with links to the MR and each thread
- Make the smallest reasonable code changes to address each discussion section
- Run targeted verification
- Append a `Robot` note to `comments.md` for each discussion you resolved in code

## Rules

- Use `glab api`, not the GitLab web UI.
- Always refresh live MR discussions before acting; do not trust a stale `comments.md`.
- Only use human comments where `system == false` when deciding what needs action.
- Prefer the smallest correct code change.
- If multiple comments point at the same underlying issue, make one coherent fix.
- If a comment only asks for test structure, comments, naming, or assertion quality, keep the change narrow to that scope.
- If a comment cannot be reasonably resolved without product direction, leave it alone and do not add a `Robot` note for it.
- After making changes, add a `Robot` paragraph only for discussions you actually addressed.
- For diff comments, use relative local Markdown links, not GitLab blob URLs.
- Put line numbers in the link **label** only; keep the Markdown **href** as the file path (for example `[src/a.ts#L10](src/a.ts)`).
- Validate that linked file paths exist in the repo before writing `comments.md`.
- Prefer `glab api "projects/:fullpath/merge_requests/<iid>/discussions?per_page=100"` over `glab mr view --comments`.

## Example

Reference MR (run from `~/Code/mcp` on branch `RI-208-add-cache`):

- https://gitlab.economicmodeling.com/ltc/ask-lightcast-ai/mcp/-/merge_requests/125

That MR currently has dozens of unresolved `:robot:` threads after enrichment.

## Refresh Current Discussions

Run from the project repo root so `projects/:fullpath` resolves and code links are valid.

Get the branch name:

```bash
git rev-parse --abbrev-ref HEAD
```

Find the MR for that branch (replace `<branch>`):

```bash
glab api "projects/:fullpath/merge_requests?source_branch=<branch>&state=opened"
```

From that JSON, copy the MR `iid` and `web_url`. Then fetch discussions (replace `<iid>`):

```bash
discussions_json="$(mktemp)"
enriched_json="$(mktemp)"
trap 'rm -f "$discussions_json" "$enriched_json"' EXIT

glab api "projects/:fullpath/merge_requests/<iid>/discussions?per_page=100" --output json >"$discussions_json"
```

Enrich discussions with per-note emoji reactions (required for `:robot:` filtering):

```bash
bash ~/.pi/agent/skills/address-comments/scripts/enrich-discussions.sh "$discussions_json" "<iid>" >"$enriched_json"
```

Set `MR_URL` from the MR lookup `web_url`, then generate `comments.md` (replace `<discussion-json-file>` with `"$enriched_json"`):

```bash
MR_URL='<web_url from MR lookup>'
export MR_URL

jq -r --arg mr_url "$MR_URL" '
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
              and (
                $d.notes
                | any(
                    (.award_emoji // [])
                    | any(.name == "robot")
                  )
              )
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
' "$enriched_json" >comments.md
```

If the MR has more than 100 discussions, fetch additional pages (`&page=2`, etc.), merge the JSON arrays, enrich once, then run `jq`.

## How To Address Comments

For each discussion in `comments.md`:

1. Read the referenced file and surrounding code.
2. Decide whether the comment is actionable without further product clarification.
3. Make the smallest reasonable change.
4. If several discussions or comments touch the same area (or reference one another), batch them into one coherent edit.
5. Prefer behavior assertions over implementation-detail assertions in tests when practical.
6. If a comment is about organization only, reorganize narrowly rather than rewriting broader logic.

Typical examples:

- Derive config values instead of hard-coding them when the relationship is obvious.
- Replace log-only tests with timing/behavior assertions when feasible.
- Group niche tests into a dedicated `describe(...)` block.
- Remove noisy `console.*` output when structured logging already exists.
- Add a concise explanatory comment for confusing but necessary logic.
- Add a tiny helper like `sleep(ms)` if it removes repeated async boilerplate.

## Verification

Run the narrowest relevant verification command for the changed area.

Example when changing HTTP client tests:

```bash
npm run typecheck && npm test -- httpClient.test
```

If tests fail:

- fix the test or implementation
- rerun the same narrow command
- do not add `Robot` notes for unresolved or reverted attempts

## `Robot` Note Format

For every discussion you address, append this exact structure immediately after that discussion in `comments.md`:

```md
---
**Robot**

I've made the requested change by <x, y, z methods>. Note, this required <a, b tradeoffs>.

Here's a basic code snippet/pseudocode representing the changes I made for this comment:

```ts
<pseudo-code or code snippet with comments describing the change>
```

```

## `Robot` Note Guidance

- Be specific about what changed.
- Mention any tradeoff or limitation briefly.
- Use pseudocode when the real code is too long.
- Keep the snippet focused on the idea that resolved the comment.
- Do not claim a discussion is resolved if you did not actually implement a change for it.
- If the discussion requires no changes or only needs advise or help, provide a concise recommended response.

## Final Checklist

- Live MR discussions refreshed from `glab`
- Discussions enriched with `award_emoji` and filtered to unresolved `:robot:` threads
- `comments.md` regenerated with MR and per-comment links
- Requested code/test/comment changes applied where feasible
- Targeted verification command passed
- `Robot` note added for each addressed discussion

## Related skill

Use `export-mr-comments` for a full export of all human threads (resolved and unresolved) without the `:robot:` filter.
