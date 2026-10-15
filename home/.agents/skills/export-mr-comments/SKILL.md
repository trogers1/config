---
name: export-mr-comments
description: >-
  Export all human GitLab MR review comments to comments.md with MR, thread, and
  per-comment links plus local code paths. Use when reviewing an MR, triaging
  feedback, or building a full comment snapshot (not only Robot-tagged threads).
disable-model-invocation: true
---

# Export MR Comments

Export human MR review comments from a supplied GitLab MR URL into `comments.md` with local code links and GitLab anchors.

GitLab data is fetched only through **read-only scripts** shared with the `address-comments` skill. Do not run `glab api` or other GitLab CLI commands directly.

## Rules

- You must provide the MR URL as the 1st argument to `refresh-all-comments-md.sh`.
- The supplied MR URL is used to identify both the GitLab project and MR IID; no branch or local git lookup is needed.
- If you pass an output file, treat it as the complete path where `comments.md` should be written.
- Use the skill scripts below — not the GitLab web UI and not raw `glab` commands.
- Refresh rewrites the destination file. If the working `comments.md` already exists, export to a separate scratch file; never overwrite local Robot notes, Reply drafts/approvals, posted history, or new-thread blocks. Reconcile live context with the working file through the addressing or discussion workflow.
- Only include human comments where `system == false`.
- Include your own human replies in each thread.
- For diff comments, use relative local Markdown links; put line numbers in the label only (`[path#L10](path)`).
- Validate linked file paths exist before writing `comments.md`.

## Refresh `comments.md` (preferred)

The scripts are installed at `~/.agents/skills` for every agent (Pi, Claude, OpenCode):

```bash
bash ~/.agents/skills/address-comments/scripts/refresh-all-comments-md.sh \
  https://gitlab.economicmodeling.com/group/project/-/merge_requests/125
```

Arguments: `<mr-url> [output-file]`. The output argument is the full destination path/name to write.

```bash
bash ~/.agents/skills/address-comments/scripts/refresh-all-comments-md.sh \
  https://gitlab.economicmodeling.com/group/project/-/merge_requests/125 \
  /absolute/path/to/comments.md
```

## Output

- Writes `comments.md` in the current directory by default, or to the supplied output path.
- Includes resolved and unresolved human discussions.
- Preserves discussion order and comment bodies from the API.

## Related skills

Use `address-comments` to work unresolved `:robot:` threads and add both local Robot resolution notes and reviewer-facing `Reply — DRAFT` blocks by default.

Use `discuss-mr-comments` to inspect evidence, refine drafts, and record Taylor's explicit local approval one thread at a time.

Use `post-mr-replies` to preview approved Reply and Thread blocks and publish only after separate explicit posting approval.
