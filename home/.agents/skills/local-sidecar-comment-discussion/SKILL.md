---
name: local-sidecar-comment-discussion
description: >-
  Continue discussion threads with the user within *.comments files.
disable-model-invocation: true
---

# Local Comment Discussions

The user leaves review threads in sidecar files: `post.md.comments` holds the
threads for `post.md`. Read and write them **only through the `sidecar` CLI**.
Never edit a `.comments` file directly: its format is strict, it carries
source-tracking metadata, and the CLI locks the file so your writes do not
collide with the user's Neovim session.

`sidecar --help` and `sidecar <command> --help` document every command. Put
`--output json` before the command words when you need to read the result.

## 1. Find the threads waiting on you

Find every `*.comments` file in the project (they can be deeply nested), then
list each one:

```sh
sidecar --output json thread list --file path/to/post.md.comments
```

Each thread has an `id`, a `location`, and ordered `messages`, each with an
`author.kind` of `human`, `agent` or `external`. Reply to every thread whose
**last** message is not from an `agent`. Skip threads whose last message is
from an `agent`; they are waiting on the user.

To see what a thread is about, read the source file (the `.comments` path
without its suffix) at the thread's location:

| `location.kind` | Meaning |
| --- | --- |
| `line` | Line `line` |
| `range` | `start_line:start_column` up to, but not including, `end_line:end_column`, in UTF-8 bytes |
| `file` | The whole file |
| `unresolved` | Its text was deleted or could not be found; rely on the conversation |
| `lost` | Deliberately detached from the source |

If the CLI rejects a file (exit 3, `validation` or `repair` error), do not
repair it by hand. Tell the user which file it is and why it was rejected.

## 2. Reply

Pass the body on stdin with a quoted heredoc so Markdown and backticks survive.
Set `LAST_KIND` to the `author.kind` of the thread's last message as you just
listed it:

```sh
sidecar --output json message add \
  --file path/to/post.md.comments \
  --thread "$THREAD_ID" \
  --author-kind agent \
  --if-last-author-kind "$LAST_KIND" \
  --body-file - <<'EOF'
<your response>
EOF
```

`--if-last-author-kind` makes the CLI refuse the reply (exit 6) if someone
else has added a message since you listed the thread. Re-list the file and
reconsider that thread instead of retrying blindly.

Exit 4 means another writer (usually the user's editor) held the file's lock.
Run `thread list` again and reply against what is there now.

## 3. Requested changes

If a thread asks you to change something (rather than just asking a
question), make the change, then say what you changed in your reply:

````md
<your response>

Files changed:

- <path-1>
- <path-2>

Snippet/pseudocode:

```ts
<focused snippet or pseudocode showing the relevant change>
```
````

If you changed a file that has its own `.comments` sidecar, run
`sidecar sync --file <that file>.comments` afterwards so its threads follow
your edits. Sync re-matches each thread by its text; threads it cannot find
become `unresolved` rather than being guessed.

DO NOT MAKE CHANGES OUTSIDE OF THE COMMENTS FILES UNLESS SPECIFICALLY
REQUESTED TO DO SO or the comment indicates that the thread is resolved and
changes ought to be made.

## Rules

- Only add messages. Never run `thread move`, `thread delete`,
  `message update` or `message delete` unless the user asks. The user
  resolves a thread by deleting it.
- Never pass `--include-tracking` or copy tracking excerpts into replies. They
  contain retained source text that is not part of the conversation.
- `comments.md` at a project root is not a sidecar, and the CLI does not read
  it. If the user points you at one, reply inside it, following the file's
  existing style.
