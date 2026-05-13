# Address PR Comments Skill

Use this workflow to refresh unresolved GitLab MR comments, implement the requested changes when feasible, verify the changes, and annotate `comments.md` with a `Robot` resolution note for each addressed discussion.

## Goal

Given an open MR:

- fetch the current discussions from GitLab using `glab`
- filter to unresolved human discussions that still need action
- make the smallest reasonable code changes to address them
- run targeted verification
- append a `Robot` note to `comments.md` for each discussion you resolved in code

## Rules

- Use `glab api`, not the GitLab web UI.
- Always refresh the live MR discussions before acting; do not trust a stale `comments.md`.
- Only use human comments where `system == false` when deciding what needs action.
- Prefer the smallest correct code change.
- If multiple comments point at the same underlying issue, make one coherent fix.
- If a comment only asks for test structure, comments, naming, or assertion quality, keep the change narrow to that scope.
- If a comment cannot be reasonably resolved without product direction, leave it alone and do not add a `Robot` note for it.
- After making changes, add a `Robot` paragraph only for discussions you actually addressed.

## Refresh Current Discussions

Get the branch name:

```bash
git rev-parse --abbrev-ref HEAD
```

Find the MR for that branch:

```bash
glab api "projects/:fullpath/merge_requests?source_branch=<branch>&state=opened"
```

Fetch current discussions for the MR:

```bash
glab api "projects/:fullpath/merge_requests/<iid>/discussions?per_page=100" --output json > "/var/folders/dj/4jf59cws6gz3dq_x8gn525kc0000gq/T/opencode/mr-discussions.json"
```

Generate a fresh `comments.md` containing only unresolved threads with no human reply from `taylor.rogers1`:

```bash
jq -r '. as $all | "# Merge Request Comments\n\nMerge request: !<iid>\n\nOnly unresolved discussions with no reply from Taylor Rogers.\n\n" + ([ $all[] | . as $d | ($d.notes | map(select(.system == false))) as $human | select(($d.resolved // false) == false and ($human | length) > 0 and ($human | any(.author.username == "taylor.rogers1") | not)) ] | to_entries | map(.value as $d | ($d.notes | map(select(.system == false))) as $human | "## Discussion \(.key + 1)\n\n" + (if ($human[0].position // null) then (($human[0].position.new_path // $human[0].position.old_path) as $path | ($human[0].position.new_line // $human[0].position.old_line // $human[0].position.line_range.start.new_line // $human[0].position.line_range.start.old_line) as $line | if ($line == null) then "Code: [\($path)](\($path))\n\n" else "Code: [\($path)#L\($line)](\($path)#L\($line))\n\n" end) else "" end) + "Status: unresolved\n\n" + ([$human[] | "**\(.author.name)** (@\(.author.username)) - \(.created_at)\n\n" + (.body | gsub("\r"; ""))] | join("\n\n---\n\n"))) | join("\n\n"))' "/var/folders/dj/4jf59cws6gz3dq_x8gn525kc0000gq/T/opencode/mr-discussions.json" > comments.md
```

## How To Address Comments

For each discussion in `comments.md`:

1. Read the referenced file and surrounding code.
2. Decide whether the comment is actionable without further product clarification.
3. Make the smallest reasonable change.
4. If several comments touch the same area, batch them into one coherent edit.
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

Example for this repo when changing the HTTP client tests:

```bash
npm test -- httpClient.test
```

If tests fail:

- fix the test or implementation
- rerun the same narrow command
- do not add `Robot` notes for unresolved or reverted attempts

## `Robot` Note Format

For every discussion you resolved, append this exact structure immediately after that discussion in `comments.md`:

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

## Final Checklist

- Live MR discussions refreshed from `glab`
- `comments.md` regenerated from current unresolved/no-reply threads
- Requested code/test/comment changes applied where feasible
- Targeted verification command passed
- `Robot` note added for each addressed discussion
