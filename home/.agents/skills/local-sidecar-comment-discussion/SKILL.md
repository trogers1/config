---
name: local-sidecar-comment-discussion
description: >-
  Continue discussion threads with the user within *.comments files.
disable-model-invocation: true
---

# Local Comment Discussions

Find and read any `*.comments` or `comments.md` files (sidecar comments files). They take the following form before any 'threads' have started:


```.comments
@<id1> <line>:<col>[-<line>:<col>] | <hash>== User comment
@<id2> <line>:<col>[-<line>:<col>] | <hash>== User comment

That has multiple

Lines.
@<id2> <line>:<col>[-<line>:<col>] | <hash>== User comment again
```

You must READ each comments file and respond to each comment that ends in a user comment (ignore any that has a Robot comment as the final comment in the 'thread'). Respond with this format for each 'thread':

```
---

🤖 <your response>

---
```

So the first example would look like:

```.comments
@<id1> <line>:<col>[-<line>:<col>] | <hash>== User comment
---

🤖 <your response>

---

@<id2> <line>:<col>[-<line>:<col>] | <hash>== User comment

That has multiple

Lines.
---

🤖 <your response>

---

@<id2> <line>:<col>[-<line>:<col>] | <hash>== User comment again
---

🤖 <your response>

---

```

## Requested Changes

If the user requests that you make changes (rather than just asking a question), indicate what changes you made like so:

````.comments
---

🤖 <your response>

Files changed:

- <path-1>
- <path-2>

Snippet/pseudocode:

```ts
<focused snippet or pseudocode showing the relevant change>
```
````

DO NOT MAKE CHANGES OUTSIDE OF THE COMMENTS FILES UNLESS SPECIFICALLY REQUESTED TO DO SO or the comment indicates that the thread is resolved and changes ought to be made.

NOTE:
- Sidecar comment files or comment.md files can be either in the root of the project, or deeply nested. `comments.md` is usually at the root of the project.
