# Do not ASK when the request is already denied

## Problem

A guarded Bash tool call can contain one or more policy `ASK` decisions while another known condition makes the complete tool call impossible to execute. In that case pi-guard must return the denial immediately instead of prompting the user to approve or persist rules that cannot make the request runnable.

The decision is request-wide, not segment-local:

> If any deterministic gate for the current Bash request is `DENY`, do not present any `ASK` from that request.

This applies regardless of whether the deny appears before or after an ask in shell encounter order.

## Current behavior and remaining gap

`gateBash()` in `extensions/guard.ts` already evaluates all parsed command segments before prompting and gives deterministic denies precedence in this order:

1. protected-path deny;
2. shell-reader validation failure;
3. ordinary path deny, including a later path after an earlier path ask;
4. explicit command deny from any parsed segment;
5. parse uncertainty and remaining command/path asks.

That code should remain the single Bash policy evaluator. In particular, do not reintroduce sequential prompting while iterating parsed commands.

The remaining gap is in the `tool_call` Bash branch. Sandbox viability is checked only after `gateBash()` returns. A command-policy ask can therefore be shown even when pi-guard already knows that the request will immediately be blocked because:

- the active sandbox is unavailable and its `onUnavailable` behavior is fail-closed; or
- sandboxing is active but pi-guard no longer owns the effective Bash tool.

These are request-level terminal denies and cannot be fixed by approving or saving a command/path rule.

## Implementation

In `home/.pi/agent/packages/pi-guard/extensions/guard.ts`, preflight the active sandbox before calling `gateBash()` in the Bash `tool_call` branch.

After profile refresh, subagent-scope enforcement, and protected-search command rewriting:

1. Call `resolveActiveSandbox(effectiveCwd)` once.
2. If the resolution is active but pi-guard does not own the Bash tool, return the existing ownership denial immediately.
3. If the resolution is unavailable with fail-closed behavior, return the existing `Bash sandbox unavailable` denial immediately.
4. If the resolution is unavailable with `onUnavailable: "warn"`, retain the current warning notification and permit normal policy evaluation/fallback.
5. Only then call `gateBash()` and allow it to present an ASK.
6. Reuse the preflight result; remove the duplicate post-`gateBash()` sandbox resolution and checks.

A stale/profile-updated ASK already restarts the outer operation loop, so the next attempt will refresh policy and recompute sandbox resolution. Do not cache the resolution across attempts.

Do not change direct read/write/custom-tool behavior: those requests have one policy decision and no equivalent post-ASK sandbox deny.

## Tests

### Parsed command precedence

In `integrationTests/guard.test.ts`, strengthen the compound-command coverage with an interactive case where an earlier parsed segment is `ASK` and a later segment is `DENY` (for example, an ask-matched Git command followed by `git checkout main`). Assert:

- the result is blocked by the explicit command rule;
- the denial identifies the denied segment/rule; and
- `ctx.ui.custom` is never called.

This locks in the request-wide invariant already implemented by `gateBash()`.

### Sandbox preflight precedence

In `integrationTests/sandbox.lifecycle.test.ts`, configure the Bash command itself to resolve to `ASK`, then cover the terminal sandbox states:

- unavailable backend with fail-closed behavior;
- active sandbox after a competing extension replaces the Bash tool.

Use an interactive harness and assert that each request is blocked with the existing sandbox/ownership reason and that the permission UI is never opened. Keep the existing `onUnavailable: "warn"` fallback behavior covered; warning mode is not a deny and may continue to a policy ASK.

## Acceptance criteria

- Any deterministic deny known for the complete Bash request wins over every command/path ask in that request.
- Shell segment order does not affect deny precedence.
- Fail-closed sandbox unavailability and Bash-tool ownership loss block before permission UI is shown.
- Warning fallback remains non-terminal and preserves normal command-policy behavior.
- Sandbox resolution occurs once per evaluation attempt and is recomputed after an operation restart.
- Existing denial text, steering, protected-path precedence, and durable ASK re-evaluation semantics remain unchanged.

## Verification

From `home/.pi/agent/packages/pi-guard` run:

```sh
npx vitest run integrationTests/guard.test.ts integrationTests/sandbox.lifecycle.test.ts
npm run check:all
npm test
```
