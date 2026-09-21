# pi-guard profile refresh across parent and subagents

## Problem

Each Pi process appears to hold an in-memory copy of its active pi-guard profile. If a user updates the saved profile while answering a pi-guard ASK inside one subagent, the parent and sibling subagents can continue using stale policy and ask the same question again.

The desired outcome is for a saved profile update made in any participating process to become visible to the parent and all subagents, avoiding duplicate ASKs.

## Recommended design

Use a shared, revision-aware profile store with lazy freshness checks. Do **not** use Pi's full `ctx.reload()` as the primary mechanism, and do **not** make subagent exit the correctness boundary.

### Required behavior

1. Profile updates are written atomically.
2. The persisted profile state exposes a change indicator, such as a generation/revision. File metadata may be used only if it is sufficiently reliable for the supported filesystems and write behavior.
3. Every process calls an internal operation such as `refreshProfileIfChanged()` before each policy evaluation and before showing an ASK.
4. If the persisted revision changed, pi-guard reloads and fully re-resolves the active profile.
5. After an ASK returns, pi-guard refreshes and evaluates policy again before committing the prompt's answer, because another process may have updated policy while the prompt was open.
6. A subagent-exit hook may eagerly invalidate or refresh the parent's profile cache, but this is only a latency optimization.
7. Existing child and sibling processes should discover changes through the same shared freshness mechanism. Explicit parent-to-child refresh messages should not be required for correctness.

Conceptual ASK flow:

```ts
await profileStore.refreshIfChanged();

if (policyNowAllows(operation)) {
  return allow();
}

const answer = await askUser(operation);

await profileStore.refreshIfChanged();
return evaluateAgain(operation, answer);
```

The actual implementation must follow the project's types and APIs rather than copying this positional/pseudocode shape.

## Why not full Pi reload?

Pi's `ctx.reload()` reloads the entire extension runtime, skills, prompts, themes, and context files. It emits `session_shutdown` and `session_start`, and code following the reload remains in the old call frame. This is broader and riskier than refreshing pi-guard's internal profile state.

Prefer a focused internal profile-store refresh API.

## Why subagent-exit refresh is insufficient by itself

- Sibling subagents may use stale policy before the updating child exits.
- A profile may be updated by the parent or another process.
- A child may remain open for a long time, crash, or disconnect.
- An ASK may already be queued or visible before the exit event.
- Pi's extension event bus is in-process and does not inherently synchronize independent Pi processes.

Subagent exit is still a useful opportunity to eagerly invalidate the parent cache.

## Concurrent ASK considerations

At minimum, a pending ASK must re-check persisted profile state after the user responds and before applying its answer.

Ideally, identical concurrent ASKs should coordinate through shared persisted state so that answering one allows the others to resolve or dismiss automatically. Whether actively dismissing an already-visible prompt is required remains a product decision.

## Safety and failure behavior to decide

The implementation needs explicit behavior for:

- malformed or partially written profile data;
- deletion or replacement of the active profile;
- profile inheritance/composition changes;
- a refresh that fails while a last-known-good profile is in memory;
- policy narrowing while an operation or ASK is in flight;
- simultaneous profile writes from multiple processes;
- stale ASK answers racing with newer saved decisions.

Atomic writes should prevent readers from observing partial files. Conflict semantics for simultaneous writers must be deliberate rather than last-write-wins by accident.

## User-mandated implementation standards

### Process

- This should be implemented in the actual pi-guard source repository/worktree, not the unrelated `mcp` repository where this summary was created.
- The parent session should remain a high-level orchestrator.
- Mechanical work—file exploration, code reading, and implementation—must be delegated to subagents.
- Do not begin implementation until requirements have been clarified and the user explicitly confirms shared understanding.
- Verify critical facts in the target repository; do not assume its architecture.

### Type safety

- Be extremely opinionated about type safety.
- Derive types whenever possible.
- Where distinct declarations must remain synchronized, use `satisfies` liberally.
- Unsafe casts are unacceptable.
- If unverified external data must be converted to a typed value, validate it first through a centralized schema-based parser, ideally shaped like:

```ts
parseOrThrow<T extends StaticSchema>({
  unverifiedData,
  schema,
})
```

- Do not add backwards compatibility for legacy patterns. This is a hard cut to the new design. Document breaking changes.

### Code style

- Every function owned by the project, including one-argument functions, must use a single object argument with explicit named properties.
- Avoid repeated hard-coded values, including in tests. Export or centralize constants and derive expected values from production definitions where appropriate.
- Reuse and centralize existing logic instead of duplicating or reimplementing it.

## Questions to resolve in the target project before implementation

Ask these one at a time as needed, after repository exploration establishes what can be answered from code:

1. What exact persisted file or files represent a profile update, and is there already a canonical profile-store abstraction?
2. Does an ASK save only one selected profile, or can it modify composed/inherited configuration?
3. Should freshness be checked before every guarded tool call, only before ASK-producing decisions, or at another centralized enforcement boundary? The recommendation is every centralized policy evaluation.
4. Is atomic temp-file-plus-rename already used for profile writes?
5. Should revision identity be an explicit monotonic generation/content hash, or is metadata checking accepted?
6. What should happen if refreshed data is invalid: fail closed, retain last-known-good policy while blocking newly uncertain operations, or another explicit behavior?
7. Must an already-visible duplicate ASK be actively dismissed when another process saves an allowing decision, or is re-evaluation after the user answers sufficient?
8. How should simultaneous writes be resolved? Is optimistic concurrency with an expected revision required?
9. Does the subagent orchestrator expose a reliable child-exit event, and should it be used for eager parent invalidation after correctness is established through lazy refresh?
10. What performance budget applies to freshness checks on every policy evaluation?

## Suggested acceptance criteria

- A profile decision saved in a child is honored by the parent's next matching guarded operation without restarting or fully reloading Pi.
- The same decision is honored by an already-running sibling's next matching guarded operation.
- The behavior does not depend on the updating child exiting successfully.
- Parent refresh also occurs eagerly after a child exits if that optimization is adopted.
- A stale pending ASK cannot overwrite or incorrectly supersede a newer persisted decision.
- Readers never observe partial profile writes.
- Invalid refreshed configuration follows a documented fail-safe behavior.
- Concurrent writes have deterministic, tested conflict semantics.
- Tests exercise real cross-instance behavior using separate profile-store/enforcer instances and production entry points rather than only mutating implementation internals.
- No full `ctx.reload()` is used merely to refresh profile policy.
- TypeScript passes without unsafe casts or unvalidated conversion of persisted data.
