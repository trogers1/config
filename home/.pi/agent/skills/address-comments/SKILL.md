---
name: address-comments
description: >-
  Refresh unresolved GitLab MR threads marked with :robot:, implement requested
  changes, verify, and annotate comments.md with Robot resolution notes. Use when
  addressing merge request review feedback, GitLab MR comments, or Robot-tagged
  review threads for a supplied MR URL.
---

# Address MR Comments

Use this workflow to refresh unresolved GitLab MR comments for a supplied MR URL, implement feasible changes, verify them, and annotate `comments.md` with a `Robot` resolution note for each addressed discussion.

GitLab data is fetched only through **read-only scripts** in this skill (`scripts/`). Do not run `glab api` or other GitLab CLI commands directly.

## Role and Goal

You are Taylor's assistant robot. Taylor marks PR/MR discussions with the `:robot:` emoji when he wants you to take a first, best-effort pass on his behalf: implement fixes he has agreed to, answer questions he wants answered, or gather enough context to propose a clear response. Work as Taylor's helper, not as an independent reviewer; focus only on the Robot-marked human discussions.

Given an MR URL:

- Refresh unresolved human discussions that have a `:robot:` (`robot`) reaction on at least one note
- Collect discussions that reference one another into a single section to resolve coherently, and write them into `comments.md` with links to the MR and each thread
- Make the smallest reasonable code changes to address each discussion section
- Run targeted verification
- Commit each complete, atomic fix separately with discussion links in the commit body
- Append a `Robot` note to `comments.md` for each discussion you resolved in code

## Rules

- You must provide the MR URL as the 1st argument to `refresh-robot-comments-md.sh`.
- The supplied MR URL is used to identify both the GitLab project and MR IID; no branch or local git lookup is needed.
- If you pass an output file, treat it as the complete path where `comments.md` should be written.
- Use the skill scripts below — not the GitLab web UI and not raw `glab` commands.
- Always refresh live MR discussions before acting; do not trust a stale `comments.md`.
- Only use human comments where `system == false` when deciding what needs action.
- Prefer the smallest correct code change.
- If multiple comments point at the same underlying issue, make one coherent fix and one commit covering those discussions.
- After each complete, atomic fix for a discussion section (or batched related sections), commit immediately — do not batch unrelated sections into one commit.
- If a comment only asks for test structure, comments, naming, or assertion quality, keep the change narrow to that scope.
- If a comment cannot be reasonably resolved without product direction, leave it alone and do not add a `Robot` note for it.
- After making changes, add a `Robot` paragraph only for discussions you actually addressed.
- Use the normal file edit tool to add `Robot` paragraphs to `comments.md`; do not generate or run custom Python/Node/shell scripts just to modify `comments.md`.
- Never commit `comments.md`; it is a local working note for the agent/user, not part of code changes.
- Put line numbers in the link **label** only; keep the Markdown **href** as the file path (for example `[src/a.ts#L10](src/a.ts)`).
- Validate that linked file paths exist in the repo before writing `comments.md`.

## Refresh `comments.md` (preferred)

OpenCode:

```bash
bash ~/.config/opencode/skills/address-comments/scripts/refresh-robot-comments-md.sh \
  https://gitlab.economicmodeling.com/group/project/-/merge_requests/125
```

Pi:

```bash
bash ~/.pi/agent/skills/address-comments/scripts/refresh-robot-comments-md.sh \
  https://gitlab.economicmodeling.com/group/project/-/merge_requests/125
```

Arguments: `<mr-url> [output-file]` (default output: `comments.md`). The output argument is the full destination path/name to write.

```bash
# Write to an explicit path/name
bash ~/.pi/agent/skills/address-comments/scripts/refresh-robot-comments-md.sh \
  https://gitlab.economicmodeling.com/group/project/-/merge_requests/125 \
  /absolute/path/to/comments.md
```

## Step-by-step scripts (debugging)

```bash
SCRIPTS=~/.pi/agent/skills/address-comments/scripts
MR_URL=https://gitlab.economicmodeling.com/group/project/-/merge_requests/125
MR_IID=125

# Discussions for the supplied MR
bash "$SCRIPTS/fetch-mr-discussions.sh" "$MR_IID" /tmp/discussions.json

# Enrich with award_emoji (required for :robot: filter)
bash "$SCRIPTS/enrich-discussions.sh" /tmp/discussions.json "$MR_IID" > /tmp/enriched.json

# Render robot-filtered comments.md
bash "$SCRIPTS/render-comments-md.sh" robot /tmp/enriched.json "$MR_URL" comments.md
```

## How To Address Comments

For each discussion in `comments.md`:

1. Read the referenced file and surrounding code.
2. Decide whether the comment is actionable without further product clarification.
3. Make the smallest reasonable change.
4. Batch related discussions into one coherent edit when they touch the same area.
5. Prefer behavior assertions over implementation-detail assertions in tests when practical.
6. Run targeted verification for that change.
7. Commit the change before moving to the next discussion section.
6. If a comment is about organization only, reorganize narrowly rather than rewriting broader logic.

Typical examples:

- Derive config values instead of hard-coding them when the relationship is obvious.
- Replace log-only tests with timing/behavior assertions when feasible.
- Group niche tests into a dedicated `describe(...)` block.
- Remove noisy `console.*` output when structured logging already exists.
- Add a concise explanatory comment for confusing but necessary logic.
- Add a tiny helper like `sleep(ms)` if it removes repeated async boilerplate.

## Commits

One commit per complete, atomic discussion section (or per batched group of related sections). Commit only code/test/doc changes that resolve the review feedback; exclude `comments.md`. Keep the subject very short (about 50 characters). Put discussion links in the commit **body**, copied from the `Thread:` / `comment` links in `comments.md`.

```text
extract fakeCache helper

Adresses:
- https://gitlab.economicmodeling.com/group/project/-/merge_requests/125#note_988438
- https://gitlab.economicmodeling.com/group/project/-/merge_requests/125#note_989896
```

Do not commit until verification for that section passes. Do not commit sections you did not change or left unresolved. Do not include `comments.md` in any commit.

## Verification

Run the narrowest relevant verification for the changed area, for example:
```bash
npm run typecheck && npm test -- httpClient.test
```

If tests fail:

- fix the test or implementation
- rerun the same narrow command
- do not add `Robot` notes for unresolved or reverted attempts

## `Robot` Note Format

For every discussion you address, append this exact structure immediately after that discussion in `comments.md` using the edit tool. Avoid ad-hoc scripts for this file update.

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

- `comments.md` refreshed via `refresh-robot-comments-md.sh <mr-url> [output-file]`
- Requested code/test/comment changes applied where feasible
- Targeted verification passed per section
- One atomic commit per section (or related batch), with discussion links in the commit body, excluding `comments.md`
- `Robot` note added for each addressed discussion

## Related skill

Use `export-mr-comments` for a full export of all human threads (resolved and unresolved) without the `:robot:` filter.
