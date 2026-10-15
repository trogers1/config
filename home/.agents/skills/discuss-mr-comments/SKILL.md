---
name: discuss-mr-comments
description: >-
  Walk through comments.md one unapproved MR thread at a time with Taylor:
  propose the exact draft comment first, then present code evidence and
  assumptions for scrutiny, workshop the response, and record local approval.
disable-model-invocation: true
---

# Discuss MR Comments

Use this interactive, local-only step between `export-mr-comments`,
`address-comments`, or `flow-review` and `post-mr-replies`. Discuss **one thread
at a time** with Taylor, not a batch review or an autonomous fix pass.

Only edit the selected local comments file (default: `comments.md`). Do not
change implementation, tests, or other artifacts; commit; post to GitLab; or
resolve remote threads. Code fixes and posting are separate workflows.

## Open or resume the queue

1. Read the entire comments file, including reviewer text, Robot notes, Reply
   blocks, and `## New threads`. Read the `post-mr-replies` skill for the exact
   block syntax and approval rules; reuse those formats, not a new status system.
2. If the file is missing, ask for the MR URL if needed, then use the
   `export-mr-comments` read-only refresh script to create it. If it exists,
   **never refresh or re-render it**: that would discard local discussion and
   approvals. Check its `Merge request:` link against any supplied URL; stop and
   ask on a mismatch or missing identity rather than replacing the file.
3. Work in file order. An existing discussion needs attention when it has no
   `Reply — APPROVED`, `Reply — APPROVED, RESOLVE`, or `Reply — POSTED` block.
   A `Thread — DRAFT` block under `## New threads` is also a queue item;
   approved or posted Thread blocks are skipped. These include findings drafted
   by `flow-review`: discuss their validity and outbound wording the same way.
4. Do not use GitLab's resolved status, a Robot resolution note, or a `:robot:`
   reaction as an approval signal or a filter. A locally unapproved thread still
   needs discussion even if a previous agent considers the issue resolved.
5. Briefly report the queue size and select the first unapproved item, unless
   Taylor names another. On resume, trust the file's current state, not remembered
   session progress. If structure or status headers are malformed or ambiguous,
   stop and ask rather than guessing or silently skipping them.

If current GitLab context is needed, fetch through the `address-comments`
read-only scripts into a separate scratch file and compare it with the local
thread. Never fetch over the working comments file, run raw GitLab CLI commands,
use the write-capable posting script, or silently replace reviewer text. Surface
new remote comments or changed context before seeking approval.

## The per-thread loop

### 1. Present the draft first, then its proof

Read the full thread and the actual referenced code, including the surrounding
function, relevant callers, configuration/schema definitions, and tests needed
to assess the claim. Existing Robot notes and `flow.md` are leads, not evidence
on their own. Trace the behavior rather than judging from the diff fragment.

After a short thread identifier/link and queue progress, present the briefing
in this order. Do not lead with a long analysis before showing the draft.

1. **Draft comment** — show the exact proposed outbound text first, clearly
   labeled DRAFT. For an existing discussion, this is the proposed reply; for a
   new thread, it is the proposed review comment. Save it in the item's existing
   DRAFT block, or create a Reply draft if needed, following the rules below.
   A tentative draft is a starting point for scrutiny, not a verdict.
2. **Comment being addressed** — quote the relevant reviewer wording and
   briefly explain the claim or request. For a new thread, briefly identify the
   behavior the finding concerns instead of repeating the whole draft.
3. **Proof / evidence** — provide short, real code snippets with file paths and
   line ranges, then trace how they support the draft's specific claims. Include
   the caller, schema/config, or test when that relationship determines validity.
   Separate observed facts from inference, current code from proposed changes,
   and tests actually run from tests merely read. Never invent snippets or
   present pseudocode as actual code. Existing Robot notes are not proof.
4. **Assumptions and holes to poke** — state the strongest counterargument,
   relevant guards or alternate paths, missing context, and what would falsify
   or weaken the draft. Distinguish correctness defects from preferences and
   tradeoffs. Flag outdated anchors or branch/MR differences rather than assuming
   local code is what the reviewer saw. If evidence is insufficient, say so and
   make the draft appropriately tentative instead of dressing uncertainty as proof.

Then invite Taylor to question the proof and poke holes in the draft with
**one focused question**, such as "What would you like to challenge or clarify
in this draft and its evidence?", and wait. Use the question interaction tool
when available. Do not ask for approval yet, present the next thread, or dump
proposed responses for the whole queue.

### 2. Discuss validity and workshop a response

Stay on this thread across as many turns as needed. Let Taylor interrogate the
proof, ask questions, and challenge assumptions before seeking approval.
Investigate by reading more code and checking evidence. Do not defend the draft
merely because you wrote it, or assume either the reviewer or Taylor is right.
Explain disagreements and revise or withdraw unsupported claims. When revising,
show the updated exact draft first, then the new or changed supporting evidence.

Record the agreed reasoning and outstanding questions in a local Robot note
below the discussion's reviewer end marker. Follow `address-comments`' Robot
note format: `RESOLVED` only when the question is answered without code changes
or the issue is demonstrably already addressed; `UNRESOLVED` when fixes,
verification, or decisions are still outstanding. Approval of wording is not
resolution of the underlying issue. For a new-thread draft, keep local reasoning
in chat rather than inside its outbound body.

Workshop the exact outbound text with Taylor. This skill invocation authorizes
local drafting, so create or revise the discussion's `**Reply — DRAFT**` block;
for a new finding, revise its existing `**Thread — DRAFT** <anchor>` block.
Keep one current draft per item instead of accumulating alternative reply
blocks. Preserve any existing posted reply as history; do not rewrite it.

Write for the reviewer/MR author in GitLab Markdown, without local Robot framing
or local-only links. Ground the reply in the agreed evidence. Never say a fix
was made or tests passed unless that has actually happened. When code changes
are still needed, say so honestly; do not implement them in this workflow.

### 3. Obtain explicit approval and save it

Show the **exact final text** in chat and ask whether Taylor approves that text
for this specific thread. Discussion, agreement that the issue is valid, a
request to revise wording, or "next" is not approval of a reply. If the final
text has not been shown, show it before asking for approval.

Only after explicit approval of that text:

- Change `**Reply — DRAFT**` to `**Reply — APPROVED**`, or
  `**Thread — DRAFT** <anchor>` to `**Thread — APPROVED** <anchor>`.
- Use `**Reply — APPROVED, RESOLVE**` only when Taylor explicitly asks for the
  eventual remote resolution too. Never infer this from reply approval.
- Preserve the approved body exactly. If Taylor later requests a substantive
  revision, return it to DRAFT and obtain approval of the revised text.
- Confirm the save and the remaining count, then present the next unapproved
  item's draft first and proof second, and pause for discussion. Do not require
  a separate "next" after approval.

If Taylor defers or skips an item, leave it unapproved and move on only at his
request. Track deferrals for this session so the loop does not immediately
revisit them; they remain eligible on a later resume. Stop when asked. Do not
force an approval just to finish the queue.

## File editing and handoff

- Use targeted file edits, not an ad-hoc script or a whole-file rewrite.
- Preserve the MR link, discussion headings, `Thread:` links, reviewer markers,
  all text between reviewer markers, unrelated notes, anchors, and other items'
  drafts/approvals. Reply blocks belong below `<!-- reviewer-comments:end -->`.
- Re-read the current item before saving; if its text or approval state changed
  during discussion, reconcile it with Taylor rather than overwriting it.
- Approval is per item. Never approve related threads in bulk merely because
  their issues overlap; cross-reference them while still discussing each.
- Do not invent an approved "no reply" block or empty reply to remove an item
  from the queue. If Taylor wants no response, leave it unapproved and report
  that decision as a deferral; the posting workflow needs real outbound text.
- At completion or pause, summarize approved items, deferred/unapproved items,
  and outstanding fixes. State explicitly that nothing was posted and no code
  was changed. `comments.md` remains an uncommitted local working file.

Use `post-mr-replies` later to validate, preview, and publish approved blocks.
Local approval here is **not** permission to post: that skill must show a fresh
preview and obtain separate explicit approval in chat before any remote write.
