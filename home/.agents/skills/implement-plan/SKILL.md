---
name: implement-plan
description: Implement an explicitly approved plan in the current conversation, with current repository instructions, canonical code/types snippets, bounded verification, and uncommitted changes. Invoke with the reviewed plan path.
disable-model-invocation: true
---

# Implement the reviewed plan

Explicit invocation with a reviewed plan path authorizes implementation within this
session's existing permissions. Pi: `/skill:implement-plan <plan-path>`.
Claude: `/implement-plan <plan-path>`. Merely discovering this skill, finishing a
plan, or reading a ticket is not approval. If no path or explicit approval was
provided, ask for it and stop before coding. Do not infer approval from the plan's
contents. Resolve relative paths from the current repository, not this skill.

1. Read the specified approved plan completely. A missing, unreadable, or
   permission-denied plan is a blocker; report its path and stop.
2. Establish the current repository, worktree, branch, committed HEAD, and dirty
   state read-only. Check these against the plan and any kickoff handoff. Preserve
   unrelated existing changes; do not overwrite, stash, discard, or commit them.
   If the intended checkout/base is unclear or mismatched, stop for clarification.
3. Read and follow [the shared implementation discipline](references/implementation.md)
   completely **now**, including its runtime repository-instruction and canonical
   snippet reads, before any coding. A missing/denied reference blocks work too.
4. Check that the plan remains applicable to the current code. Stop for unresolved
   blocking decisions, material requirement changes, conflicts with repository
   instructions, or unsafe overlap with existing changes. Ask rather than invent
   requirements, expand scope, or rewrite the approved plan to justify other work.
5. Implement the approved scope using that discipline. Report the result or blocker
   in this same conversation and leave all work uncommitted.

Direct implementation selected explicitly at ticket kickoff is a separate entry
point: `start-ticket` embeds the same discipline in its assignment. It needs no
plan document and must not fabricate a placeholder plan to invoke this skill.
