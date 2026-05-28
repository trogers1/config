---
name: export-mr-comments
description: >-
  Export all human GitLab MR review comments to comments.md with MR, thread, and
  per-comment links plus local code paths. Use when reviewing an MR, triaging
  feedback, or building a full comment snapshot (not only Robot-tagged threads).
---

# Export MR Comments

Export human MR review comments from a supplied GitLab MR URL into `comments.md` with local code links and GitLab anchors.

GitLab data is fetched only through **read-only scripts** shared with the `address-comments` skill. Do not run `glab api` or other GitLab CLI commands directly.

## Rules

- You must provide the MR URL as the 1st argument to `refresh-all-comments-md.sh`.
- The supplied MR URL is used to identify both the GitLab project and MR IID; no branch or local git lookup is needed.
- If you pass an output file, treat it as the complete path where `comments.md` should be written.
- Use the skill scripts below — not the GitLab web UI and not raw `glab` commands.
- Only include human comments where `system == false`.
- Include your own human replies in each thread.
- For diff comments, use relative local Markdown links; put line numbers in the label only (`[path#L10](path)`).
- Validate linked file paths exist before writing `comments.md`.

## Refresh `comments.md` (preferred)

OpenCode:

```bash
bash ~/.config/opencode/skills/address-comments/scripts/refresh-all-comments-md.sh \
  https://gitlab.economicmodeling.com/group/project/-/merge_requests/125
```

Pi:

```bash
bash ~/.pi/agent/skills/address-comments/scripts/refresh-all-comments-md.sh \
  https://gitlab.economicmodeling.com/group/project/-/merge_requests/125
```

Arguments: `<mr-url> [output-file]`. The output argument is the full destination path/name to write.

```bash
bash ~/.pi/agent/skills/address-comments/scripts/refresh-all-comments-md.sh \
  https://gitlab.economicmodeling.com/group/project/-/merge_requests/125 \
  /absolute/path/to/comments.md
```

## Output

- Writes `comments.md` in the current directory by default, or to the supplied output path.
- Includes resolved and unresolved human discussions.
- Preserves discussion order and comment bodies from the API.

## Related skill

Use `address-comments` and `refresh-robot-comments-md.sh` to work unresolved `:robot:` threads and add Robot resolution notes.
