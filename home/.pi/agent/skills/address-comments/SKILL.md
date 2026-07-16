---
name: address-comments
description: >-
  Refresh unresolved GitLab MR threads marked with :robot:, implement requested
  changes or investigate questions, verify, and annotate comments.md with Robot
  resolution notes for a supplied MR URL.
---

# Address MR Comments

Use this workflow to refresh unresolved GitLab MR comments for a supplied MR URL, take Taylor's requested first pass on Robot-marked discussions, and annotate `comments.md` with a `Robot` note for **every** discussion explaining whether it was resolved or remains unresolved.

GitLab data is fetched only through **read-only scripts** in this skill (`scripts/`). Do not run `glab api` or other GitLab CLI commands directly.

## Role and Goal

You are Taylor's assistant robot. Taylor marks PR/MR discussions with the `:robot:` emoji when he wants you to take a first, best-effort pass on his behalf: implement fixes he has agreed to, answer questions he wants answered, or gather enough context to propose a clear response. Work as Taylor's helper, not as an independent reviewer; focus only on Robot-marked human discussions.

Given an MR URL:

- Refresh unresolved human discussions that have a `:robot:` (`robot`) reaction on at least one note.
- Write those discussions into `comments.md` with links to the MR and each thread.
- For every discussion, decide whether it is actionable, answerable, or blocked.
- Group discussions that share a theme or reference each other into one cohesive resolution group when appropriate.
- Make the smallest reasonable code/test/doc change for actionable discussions or resolution groups.
- Run targeted verification for changed code.
- Keep each resolution group coherent in the working tree; do not commit changes.
- When the final changes warrant a new or materially revised commit message, write one suggested message for all resolved changes to `committ_msg.md`.
- Append a `Robot` note to every discussion in `comments.md`, marking it `RESOLVED` or `UNRESOLVED` and explaining why.

## Rules

- You must provide the MR URL as the 1st argument to `refresh-robot-comments-md.sh`.
- The supplied MR URL is used to identify both the GitLab project and MR IID; no branch or local git lookup is needed.
- If you pass an output file, treat it as the complete path where `comments.md` should be written.
- Use the skill scripts below — not the GitLab web UI and not raw `glab` commands.
- Always refresh live MR discussions before acting; do not trust a stale `comments.md`.
- Only use human comments where `system == false` when deciding what needs action.
- Prefer the smallest correct code change.
- If multiple comments point at the same underlying issue, share a theme, or reference each other by comment links, treat them as one resolution group.
- For each resolution group, make one coherent fix covering all discussions in that group.
- Add one full canonical `Robot` note for the group, then add short `Robot` notes on the other grouped discussions that point back to the canonical note/discussion.
- Do not commit while addressing discussions. Complete all feasible resolution groups in the working tree so Taylor can review the full diff and manually amend or create the single commit.
- If a comment only asks for test structure, comments, naming, or assertion quality, keep the change narrow to that scope.
- If a discussion is answerable without a code change, add a `RESOLVED` Robot note with the answer and do not commit anything for that discussion.
- If a discussion cannot be reasonably resolved without product direction, missing context, failing verification, or unsafe assumptions, add an `UNRESOLVED` Robot note explaining exactly what is needed next.
- Add a `Robot` note for every discussion in `comments.md`, even when no code change was made. For grouped discussions, the note may be a short cross-reference to the group's canonical Robot note.
- Use the normal file edit tool to add `Robot` paragraphs to `comments.md`; do not generate or run custom Python/Node/shell scripts just to modify `comments.md`.
- Never commit `comments.md`; it is a local working note for the agent/user, not part of code changes.
- For diff comments, use relative local Markdown links; put line numbers in the link label only (`[path#L10](path)`).
- Validate linked file paths exist before writing `comments.md`.

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

First scan all discussions in `comments.md` and form resolution groups:

- Group discussions that explicitly link to each other, discuss the same code path, ask for the same underlying change, or share a clear theme.
- Keep unrelated discussions separate, even if they are nearby in the file.
- Pick one primary discussion in each group as the canonical place for the full Robot note.

For each discussion or resolution group:

1. Read the referenced files and surrounding code.
2. Decide whether the discussion/group is actionable, answerable without code, or blocked.
3. If actionable, make the smallest reasonable change that resolves the whole group.
4. Prefer behavior assertions over implementation-detail assertions in tests when practical.
5. Run targeted verification for changed code.
6. If verification passes, continue to the next resolution group without committing.
7. Append Robot notes:
   - On the primary discussion, add the full `Robot — RESOLVED` or `Robot — UNRESOLVED` note.
   - On other discussions in the group, add a short `Robot — RESOLVED` or `Robot — UNRESOLVED` note that references the primary discussion's Robot note.
   - For ungrouped discussions, add the full Robot note directly to that discussion.

Typical examples:

- Derive config values instead of hard-coding them when the relationship is obvious.
- Replace log-only tests with timing/behavior assertions when feasible.
- Group niche tests into a dedicated `describe(...)` block.
- Remove noisy `console.*` output when structured logging already exists.
- Add a concise explanatory comment for confusing but necessary logic.
- Add a tiny helper like `sleep(ms)` if it removes repeated async boilerplate.

## Proposed Commit Message

Do not commit changes. Taylor will review the complete working-tree diff and manually amend the existing commit or create a new one.

Inspect the current commit message before drafting a replacement. Do not create or modify `committ_msg.md` merely because review fixes were made: when the existing message still accurately describes the resulting commit, leave it alone.

Write `committ_msg.md` only when there is no commit to amend, or when the accumulated changes make the existing message inaccurate, incomplete, or materially less useful. The draft must cover all resolved changes, use a concise subject (about 50 characters), and include relevant discussion links copied from `Thread:` / `comment` links in `comments.md`.

```text
extract fakeCache helper

Addresses:
- https://gitlab.economicmodeling.com/group/project/-/merge_requests/125#note_988438
- https://gitlab.economicmodeling.com/group/project/-/merge_requests/125#note_989896
```

`comments.md` and `committ_msg.md` are local working notes and must not be included in the eventual commit.

## Verification

Run the narrowest relevant verification for the changed area, for example:

```bash
npm run typecheck && npm test -- httpClient.test
```

If tests fail:

- Fix the test or implementation and rerun the same narrow command, if feasible.
- If verification still fails or the fix must be reverted, mark the discussion `UNRESOLVED` in the Robot note and explain the failure.
- Do not treat failing or reverted changes as resolved.

## `Robot` Note Format

For every discussion, append one of these structures immediately after that discussion in `comments.md` using the edit tool. Avoid ad-hoc scripts for this file update. For grouped discussions, use one full canonical note and short cross-reference notes for the rest of the group.

Resolved with code change:

````md
---
**Robot — RESOLVED**

I've made the requested change by <specific summary>. Verification: `<command>` passed.

Files changed:

- <path-1>
- <path-2>

Snippet/pseudocode:

```ts
<focused snippet or pseudocode showing the relevant change>
```
````

Resolved without code change / answered:

```md
---
**Robot — RESOLVED**

No code change was needed. <Answer the question or explain why the existing behavior is correct. Include file/path references when useful.>
```

Unresolved:

```md
---
**Robot — UNRESOLVED**

I couldn't safely resolve this yet because <specific reason>. Needed next: <product decision, missing context, failing verification details, or recommended follow-up>.
```

Grouped discussion cross-reference:

```md
---
**Robot — RESOLVED**

Handled as part of the same resolution group as <Discussion N / thread link>. See that Robot note for the full explanation, verification, and files changed.
```

Use `Robot — UNRESOLVED` for the cross-reference instead when the group remains unresolved.

## `Robot` Note Guidance

- Be specific about what changed or what you investigated.
- For grouped discussions, put the detailed explanation, verification, and files changed in the canonical note only; keep the other grouped notes short and refer back to it.
- Mention any tradeoff or limitation briefly.
- Use pseudocode when the real code is too long, otherwise give actual code snippets.
- Keep snippets focused on the idea that resolved the comment.
- Do not claim a discussion is resolved if verification failed, changes were reverted, or product direction is still needed.
- If the discussion only needs advice or an answer, provide a concise recommended response and mark it `RESOLVED`.

## Final Checklist

- `comments.md` refreshed via `refresh-robot-comments-md.sh <mr-url> [output-file]`.
- Every Robot-marked discussion has a `Robot — RESOLVED` or `Robot — UNRESOLVED` note, either full or a grouped cross-reference.
- Requested code/test/comment changes applied where feasible.
- Targeted verification passed for all resolved changes.
- `committ_msg.md` was written only when a new or materially revised commit message is warranted; if written, it covers all resolved changes and relevant discussion links.
- `comments.md` and `committ_msg.md` remain uncommitted.

## Related skill

Use `export-mr-comments` and `refresh-all-comments-md.sh` for a full export of all human threads (resolved and unresolved).
