---
name: flow-review
description: >-
  Review the current branch with a through, thoughtful, comprehensive code review.
---


I like comprehensive, behavioral testing that is as production-like as possible. I also like implementation to be as simple, extremely typesafe, config-derived and obvious as possible. Any hard-coding, redefining, or type casting are red-flags. So:

- Typecasting outside of a typebox validation function (or similar) IS A RED FLAG
- Hard coded values that exist elsewhere ARE RED FLAGS
- Functions returning `undefined` or using `continue` instead of throwing errors IS A RED FLAG

WITH THAT IN MIND, please review the testing and implementation of the current branch to meet the provided AC. Assume you are reviewing it compared to the remote `staging` branch unless otherwise specified.

## Jira information

When given a Jira ticket key or URL, read the ticket with the read-only `jira-ticket` CLI, and treat its AC section as the acceptance criteria for the review:

```sh
jira-ticket get <KEY>
```

The description comes back as Atlassian Document Format JSON. Pipe it through `jq -r '.. | objects | select(.type=="text") | .text'` to get readable text. Never use `jira-ticket update` or `create`. If the CLI fails, run `jira-ticket doctor` and tell the user, rather than falling back to the MR description silently. Fetching the ticket counts as inspecting the change, so it may come before `flow.md`. In `flow.md`, map each AC item to its status (met, not met, or partial) and to the code or test that covers it.

## GitLab merge requests

When given a GitLab MR URL, use the `address-comments` skill scripts (installed at `~/.agents/skills/address-comments/scripts`) for all GitLab access. Do not run `glab` or other GitLab CLI commands directly, and never post anything: posting belongs to the `post-mr-replies` skill after Taylor approves it. Without an MR URL, skip this section.

### Read existing review comments first

Before reviewing, export every human discussion on the MR to a scratch file and read it, so the review builds on what reviewers already said instead of repeating it. This counts as inspecting the change, so it may come before `flow.md`:

```sh
bash ~/.agents/skills/address-comments/scripts/refresh-all-comments-md.sh <mr-url> <scratch-dir>/mr-comments.md
```

Never point a refresh at the repository's `comments.md`: a refresh rewrites the whole file and drops Taylor's Robot notes, Reply blocks, and Thread blocks. When a finding is already raised in an existing discussion, say so in the review and link the thread rather than reporting it as new.

### Draft findings as new threads

Use `discuss-mr-comments` after the review to discuss draft findings one at a
time with Taylor, inspect supporting snippets, refine wording, and record his
explicit local approval before the separate posting workflow.

After the review, draft each finding Taylor might want on the MR as a `Thread — DRAFT` block in the repository's `comments.md`, so `post-mr-replies` can post the ones he approves:

- If `comments.md` does not exist, create it with `refresh-all-comments-md.sh <mr-url> comments.md`. If it exists, check that its `Merge request:` line is this MR and edit it in place; stop and ask if it is for another MR.
- Put every draft under the file's single `## New threads` heading (add it at the end if missing). Use `**Thread — DRAFT** positional <path> L<start>-L<end>` for findings on specific lines, with new-side line numbers of added or unchanged lines in the MR's diff (`L12-L12` for one line), and `**Thread — DRAFT** general` for broader findings. Separate blocks with a bare `---` line.
- Write each body for the MR author: standalone, in GitLab Markdown, with no Robot framing and no local-only links.
- Take line numbers from the MR's diff, and confirm the local branch matches the MR's latest pushed commit; otherwise use `general` drafts that name the file and line in the body. Anchors are checked against the live diff only when an approved block is previewed.
- Only draft; never mark a block `APPROVED`. Run `bash ~/.agents/skills/address-comments/scripts/preview-replies.sh <mr-url> comments.md` to confirm the file still parses, and list the drafts you added in the final response.

## Required first step: map the branch flow

Before evaluating the implementation, looking for findings, or writing the review, first create or replace `flow.md` at the repository root. The only review work that should precede it is identifying the comparison branch and inspecting the diff and source needed to understand and write the artifact. Build it from the complete branch diff against the selected comparison branch (normally remote `staging`), not just the latest commit.

Treat `flow.md` as the working map for the subsequent review: use it to trace behavior, identify affected boundaries, and guide test and implementation analysis. Update it if the review reveals that the initial flow map was incomplete or inaccurate. This artifact is required even when the review has no findings.

Write `flow.md` for a developer who is unfamiliar with the change. It must include:

1. **Overview** — the purpose of the branch and the user-visible or system-visible behavior it changes.
2. **End-to-end code flow** — trace each important execution path from its entry point through validation, business logic, persistence or external calls, and returned result or side effects. Include alternate and failure paths when meaningful.
3. **Data and state flow** — VERY IMPORTANT. We care A LOT about the datamodel and the interfaces--just as much as the flow of the code. Describe important inputs, outputs, type transformations, state transitions, configuration, schemas, migrations, and external boundaries.
4. **Test flow** — map tests to the behaviors and paths they exercise, including important gaps discovered during review.
5. **Changed-file map** — group relevant changed files by responsibility. For each file, explain what changed, why it participates in the feature, and give concise pseudocode for its new or modified behavior. Call out deleted and renamed files. Generated files may be summarized as a group.

Use concrete symbol and file names, links such as ``[`path/to/file.ts`](path/to/file.ts)``, and readable pseudocode rather than copying implementation. Add Mermaid diagrams when they make a non-trivial interaction or state transition easier to understand. Keep the document branch-specific and omit unrelated pre-existing architecture.

Use mermaid diagrams liberally to help illustrate code-flow (both of the entire change set and for complicated subsystems within it). A combination of pseudo-code and diagrams (with links to actual implementation) is very helpful when reviewing and understanding.

`flow.md` is the canonical, agent-editable review map. After its final update, generate `flow.html` from it for local human review. Do not edit `flow.html` manually.

Before completing the review, verify that every relevant file in the branch diff is represented in `flow.md` either individually or in an explicitly named group.

## Human-readable review map

`flow.md` is the canonical, agent-editable review map. After its final update, generate its human-readable companion with the bundled portable renderer (run the script relative to this skill directory):

```sh
node scripts/render_markdown_html.mjs flow.md flow.html
```

Do not edit `flow.html` manually; regenerate it from `flow.md` after material changes. Keep `flow.html` beside `flow.md` so repository-relative source links continue to work. The renderer fetches pinned Marked from jsDelivr at generation time, so generation requires network access. The generated page embeds rendered HTML for the document and table of contents, which remain readable offline or with JavaScript disabled. Only Mermaid diagrams load a module from jsDelivr when opened; network or diagram errors leave diagram source visible without reverting the document to Markdown. Mention both `flow.md` and `flow.html` in the final response.
