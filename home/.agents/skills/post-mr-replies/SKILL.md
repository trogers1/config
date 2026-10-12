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

`scripts/post-replies.sh` lives next to the read-only scripts, but it is the only one that writes. All writes go through `scripts/lib/gitlab-write.sh`, which allowlists exactly two endpoints: add a note to a discussion and resolve a discussion. Preview with `scripts/preview-replies.sh`, a wrapper that rejects every flag and so can never write. Do not run `glab api` or other GitLab CLI commands directly.

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
- `render-comments-md.sh` wraps each discussion's reviewer notes in `<!-- reviewer-comments:begin -->` / `<!-- reviewer-comments:end -->`, and refuses to render a note containing those markers. Everything between them is reviewer text: a `**Reply — …**` or `Thread:` line there is never treated as structure. Reply blocks must sit below the discussion's end marker. A `comments.md` rendered before the markers existed is rejected; re-render it, which drops existing Reply blocks.
- A discussion is a `## ` heading whose first non-blank line is its `Thread:` link. Later `Thread:` lines are ignored.
- At most one `APPROVED` block per discussion, and at most one per GitLab thread across the file.
- The body is everything after the header up to the next bare `---` line outside a code fence, the next `## ` heading, or end of file. Leading/trailing blank lines are trimmed; the rest is posted verbatim. Code fences inside the body may contain `---`.
- Write the reply for the reviewer, not for Taylor: no `Robot` framing, no local-only file links (use GitLab-relative paths or plain text).

## Workflow

1. **Do not refresh `comments.md` first.** The refresh scripts rewrite the whole file and would drop the `Reply` blocks.
2. Run the preview (read-only; fetches live discussions to plan) and show Taylor the **full** output in chat:

   ```bash
   bash ~/.agents/skills/address-comments/scripts/preview-replies.sh \
     https://gitlab.economicmodeling.com/group/project/-/merge_requests/125 \
     comments.md
   ```

3. Ask Taylor for explicit approval to post exactly what the preview shows (and whether to `--resolve`). Do not treat earlier approval of a draft, or approval in a previous session, as approval to post.
4. Only after a clear yes in chat, run `post-replies.sh` with the same arguments plus `--post` (and `--resolve` if Taylor asked for it). If `comments.md` changed since the preview, show a new preview first.

   ```bash
   bash ~/.agents/skills/address-comments/scripts/post-replies.sh \
     https://gitlab.economicmodeling.com/group/project/-/merge_requests/125 \
     comments.md --post
   ```
5. Report the posted note links from the script output. The script rewrites each posted block's header to `POSTED`.

Arguments: `preview-replies.sh <mr-url> [comments-file]` and `post-replies.sh <mr-url> [comments-file] [--post] [--resolve]` (default comments file: `comments.md`). Without `--post`, `post-replies.sh` prints the same preview.

## Safety behavior

- Without `--post` the script performs only GET requests and leaves `comments.md` untouched.
- It refuses a `comments.md` whose `Merge request:` link (before the first discussion) is missing or for a different MR.
- It validates every `APPROVED` block against live GitLab before writing anything; an unknown thread aborts the whole run.
- Idempotent: a reply is skipped when the live thread already has a note **by the current glab user** with the same body (whitespace-trimmed), so a rerun or a refreshed file does not double-post. Matching notes by other people don't count. If a reply was edited on GitLab after posting, the match fails, so check the preview before posting.
- A header becomes `POSTED` only after its post and any requested resolve succeed. If resolving fails, the header keeps its `RESOLVE` tag; rerun with `--post --resolve` to skip the duplicate post and retry the resolve.
- To resolve a thread whose reply is already posted, change its header back to `**Reply — APPROVED, RESOLVE**` and rerun with `--post --resolve`; the post is skipped as a duplicate and the thread is resolved.
- Before rewriting a header, the script checks that its line still holds the header it planned from. If `comments.md` was edited during the run, it stops with an error rather than overwriting the wrong line. Fix that header by hand (the error gives the text).
- Resolve is skipped (and reported in the preview) when the block isn't tagged `RESOLVE`, `--resolve` wasn't passed, the thread is already resolved, or it isn't resolvable.
- In Pi, the `gitlab-skills` guard rule set allows `~/.agents/skills/address-comments/scripts/preview-replies.sh` and asks before **every** `post-replies.sh` run. Guard patterns match raw command text, so quoting (`--po''st`) could hide a flag from a `*--post*` rule; the split keeps writes behind the prompt regardless.
