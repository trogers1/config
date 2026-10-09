---
name: post-mr-replies
description: >-
  Preview and, only after Taylor's explicit approval in chat, post the
  `Reply — APPROVED` blocks from comments.md as replies to their GitLab MR
  threads, optionally resolving threads tagged RESOLVE.
disable-model-invocation: true
---

# Post MR Replies

This is the final, **write-capable** step of the MR review loop (`export-mr-comments` / `address-comments` → local discussion in `comments.md` → this skill). It posts the replies Taylor approved in `comments.md` to their GitLab threads.

The script lives next to the read-only scripts, but it is the only one that writes. All writes go through `scripts/lib/gitlab-write.sh`, which allowlists exactly two endpoints: add a note to a discussion and resolve a discussion. Do not run `glab api` or other GitLab CLI commands directly.

## Reply blocks in `comments.md`

Normal back-and-forth stays in `Robot — RESOLVED|UNRESOLVED` notes and is **never posted**. When Taylor asks for an actual reply to a thread, draft one as a `Reply` block in that discussion:

```md
---
**Reply — DRAFT**

<exact text to post to the GitLab thread, in GitLab Markdown>

---
```

States (the header line must match exactly; anything else starting with `**Reply` is an error):

| Header                              | Meaning                                                       |
| ----------------------------------- | ------------------------------------------------------------- |
| `**Reply — DRAFT**`                 | Agent draft. Never posted.                                    |
| `**Reply — APPROVED**`              | Taylor approved this text. Posted on `--post`.                |
| `**Reply — APPROVED, RESOLVE**`     | Posted, then the thread is resolved when `--resolve` is also passed. |
| `**Reply — POSTED** [note_<id>](<mr-url>#note_<id>) <ts>` | Written by the script after posting; links to the posted note. Skipped on rerun. |

Rules:

- Only Taylor moves a block from `DRAFT` to `APPROVED` — either by editing the file or by explicitly telling you in chat to approve a specific reply. Never approve on your own judgement.
- At most one `APPROVED` block per discussion, placed after that discussion's `Thread:` line.
- The body is everything after the header up to the next bare `---` line outside a code fence, the next `## ` heading, or end of file. Leading/trailing blank lines are trimmed; the rest is posted verbatim. Code fences inside the body may contain `---`.
- Write the reply for the reviewer, not for Taylor: no `Robot` framing, no local-only file links (use GitLab-relative paths or plain text).

## Workflow

1. **Do not refresh `comments.md` first.** The refresh scripts rewrite the whole file and would drop the `Reply` blocks.
2. Run the dry run (read-only; fetches live discussions to plan) and show Taylor the **full** output in chat:

   ```bash
   bash ~/.agents/skills/address-comments/scripts/post-replies.sh \
     https://gitlab.economicmodeling.com/group/project/-/merge_requests/125 \
     comments.md
   ```

3. Ask Taylor for explicit approval to post exactly what the preview shows (and whether to `--resolve`). Do not treat earlier approval of a draft, or approval in a previous session, as approval to post.
4. Only after a clear yes in chat, rerun the same command with `--post` (plus `--resolve` if Taylor asked for it). If `comments.md` changed since the preview, show a new preview first.
5. Report the posted note links from the script output. The script rewrites each posted block's header to `POSTED`.

Arguments: `<mr-url> [comments-file] [--post] [--resolve]` (default comments file: `comments.md`).

## Safety behavior

- Without `--post` the script performs only GET requests and leaves `comments.md` untouched.
- It refuses a `comments.md` whose `Merge request:` link is for a different MR.
- It validates every `APPROVED` block against live GitLab before writing anything; an unknown thread aborts the whole run.
- Idempotent: a reply is skipped when the live thread already has a note with the same body (whitespace-trimmed), so a rerun or a refreshed file does not double-post. If a reply was edited on GitLab after posting, the match fails — check the preview before posting.
- To resolve a thread whose reply is already posted, change its header back to `**Reply — APPROVED, RESOLVE**` and rerun with `--post --resolve`; the post is skipped as a duplicate and the thread is resolved.
- Resolve is skipped (and reported in the preview) when the block isn't tagged `RESOLVE`, `--resolve` wasn't passed, the thread is already resolved, or it isn't resolvable.
- In Pi, the `gitlab-skills` guard rule set allows the dry run and asks before any `--post` invocation.
