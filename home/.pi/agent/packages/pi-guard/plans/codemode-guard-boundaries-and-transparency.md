# Codemode: enforceable model boundaries and transparent nested execution

## Goal

Keep codemode useful for orchestration without turning its JavaScript script into
an opaque permission grant. Guard must authorize actual operations, show what
happened, and fail closed when a capability cannot be governed.

This is a plan, not a claim that the additional boundaries already exist.

## Current baseline (Pi 1.3)

- Codemode runs JavaScript without direct Node, filesystem, or arbitrary network
  access. Tool operations go through `ctx.executeTool()`.
- Nested tools pass through the same argument validation, `tool_call`, and
  `tool_result` handlers as direct calls. Guard's Bash policy, path policy, and
  sandbox therefore remain applicable.
- `integrationTests/codemodeSecurity.test.ts` exercises real `session.prompt()`
  sessions with Guard, codemode, and a deterministic provider. Both `on` and
  `only` modes block denied Bash/file edits and permit allowed Bash.
- Classifier/image calls through `models.classify()` and
  `models.generateImages()` are not ordinary tool calls. Existing Guard tool
  handlers do not authorize those outbound requests.
- Pi exposes nested execution events with `parentToolCallId`. Persisted tool
  results contain bounded `nestedCalls` metadata, not separate transcript entries
  for every nested call. Omitted arguments/calls are marked as incomplete.
- Pi aggregates nested usage into the outer result. `pi-usage` records this as
  `tools/codemode`, including partial work before failure, without double-counting
  nested events. Per-provider/model attribution is unavailable in that aggregate.
- Completed operations are not rolled back when a later operation fails or is
  denied. Approving a script must never imply transactional execution.

Keep the normal `on` presentation as the default: direct tools remain visible.
Supporting `only` must not change enforcement or silently expand capabilities.

## Principles and non-goals

1. Authorize at execution time, not by interpreting the script's apparent intent.
2. Reuse Guard's policy resolution, revision checking, UI queues, and sandbox.
   Do not introduce a second permission evaluator for codemode.
3. Treat `reachesTools`, tool annotations, and script inspection as discovery or
   presentation hints, never proof of safety or a complete list of future calls.
4. A denied operation cannot be authorized by catching its exception, changing
   output, wrapping it in another tool, or approving the outer codemode call.
5. Separate authorization from auditing/accounting. A visible cost afterward is
   not approval to send data or spend money beforehand.
6. Trusted extensions execute inside Pi's process. This work is not a sandbox for
   malicious extensions, a complete data-flow/taint tracker, or a filesystem
   transaction system. Host-generated temporary artifacts are distinct from
   permission-gated workspace writes.

## Phase 1 — establish the enforceable model-call boundary

### Capability and API assessment

Inspect the installed SDK exports and host implementation before selecting an
integration. Document which request paths can be blocked before dispatch.

Pi 1.3 exposes `createCodemodeExtension({ models: false })`; the default is true.
This is an extension-factory option, not a documented `settings.json` switch.
The current public extension event surface does not establish a veto hook for
classifier/image requests. Do not invent one or treat notification-only provider
stream events as an authorization boundary.

Use the public codemode factory to provide a tools-only baseline when model
calls cannot be governed. Integrate through Pi's supported extension replacement
and loading mechanisms, explicitly disabling/replacing the original built-in.
Verify ownership and absence of an unrestricted duplicate after startup/reload.
Do not fork the JavaScript worker, patch private SDK methods, or scan scripts for
`models` references as a security mechanism.

### Model-call policy integration

Prefer an upstream/public pre-dispatch hook covering classifier and image calls,
including calls made indirectly through the model registry. The boundary needs:

- operation kind, resolved provider/model, and the actual configured destination;
- session/outer-call identity and abort signal;
- access to the request for authorization, without automatically logging payloads;
- an awaited allow/deny decision that runs before outbound dispatch;
- reliable failure propagation and no dispatch after cancellation.

If that API is absent, specify the upstream change as a dependency. In restricted
profiles, retain tools-only codemode rather than silently permitting ungated model
calls. Any temporary unrestricted-model option must be explicit and visibly
identified as an unguarded capability, not presented as enforced policy.

Derive configuration and types from existing Guard schemas and host contracts.
Add validated profile capability declarations only after the boundary is proven.
Reuse profile inheritance and conflict handling; subagents must not obtain model
capabilities exceeding their approved parent loadout. Existing network/sandbox
settings alone do not restrict HTTP requests made by Pi's host process.

### Authorization behavior

- Scope an approval to the operation and resolved destination it describes. Do
  not reuse a tool approval as a model-provider approval.
- Show provider/model, operation, destination, and a bounded input-size summary.
  Do not claim that input size establishes whether sensitive data is present.
- Recheck profile/config revision after any UI wait, using the existing stale
  approval handling. A changed destination requires a fresh decision.
- Fail closed without an interactive approval channel when policy says ASK.
- Bound concurrency and cancellation through host facilities where possible.
  Exact cost ceilings require host support for pre-dispatch reservation and
  reconciliation; estimated price cannot be advertised as a hard dollar cap.

## Phase 2 — make nested execution visible

Use existing tool lifecycle events and rendering APIs. Preserve Pi's built-in
codemode renderer through renderer composition rather than rewriting it.

Present an expandable activity tree keyed by actual call IDs:

- outer codemode call and nested tool name;
- bounded/redacted command or path summary;
- Guard decision and matched rule/profile revision;
- waiting, running, denied, failed, aborted, or completed status;
- elapsed/recorded execution time where the host supplies it.

Keep policy evaluation in the existing tool gate. Feed its decision into the
presentation layer instead of recomputing decisions from later events. Never
label a call allowed merely because it started or the outer script succeeded.

Use persisted `nestedCalls` for resume/export where possible. Add minimal Guard
entries only for facts the host does not retain, with a validated versioned
schema, bounded retention, and no credentials or full sensitive payloads.
Explicitly show truncated/incomplete records; never render an incomplete history
as a complete audit. Session switches, reload, and shutdown must clear transient
state without mixing calls from different sessions.

Keep live visibility even when scripts suppress output or catch exceptions.
Show that earlier operations may have completed when the script subsequently
fails. Reuse `pi-usage` for accounting; do not count nested lifecycle events again
or fabricate per-model cost breakdowns from aggregates.

## Phase 3 — exercise interactive ASK and concurrency

Extend the real SDK security tests with a realistic fake UI boundary, then add a
TUI smoke test for dialog ownership and rendering. Validate fake inputs against
host schemas and assert user-visible behavior and filesystem/provider effects.

Cover:

- nested ASK allowed once, rejected, and cancelled; unrelated calls remain gated;
- concurrent nested ASK requests, serialized dialogs, and correct call attribution;
- session abort while waiting: no later execution after a dialog resolves;
- policy/profile change while waiting: stale approval is rejected/re-evaluated;
- denied nested calls caught by JavaScript: side effects remain absent and the
  activity record still shows denial;
- allowed mutation followed by denial/failure: earlier mutation remains, and the
  UI does not imply rollback;
- `on`/`only`, direct/nested, and another orchestrating tool all use the same gate;
- read/protected paths, shell sandbox containment, tool exposure, and subagent
  authority remain enforced; no loading path restores an unrestricted duplicate;
- non-interactive ASK fails closed; UI absence does not grant permission;
- model request denial/cancellation results in zero fake-provider invocations;
  parallel model calls cannot race around approval or any supported reservation;
- resume/export preserves decisions or clearly marks unavailable/incomplete data;
- aggregate usage and repeated imports remain idempotent after success/failure.

Keep model tests local with deterministic fake providers, no real API keys or
network calls. Do not weaken assertions or add broad timeout changes to hide
concurrency bugs.

## Delivery order

1. Prove and test tools-only capability isolation using the public factory.
2. Add/obtain the public model authorization boundary; implement validated profile
   policy and parent/subagent capability propagation.
3. Add nested decision presentation and bounded reconstruction.
4. Add real interactive ASK/concurrency coverage and operator documentation.
5. Roll out conservatively with `on` as the default. Broader capabilities remain
   explicit until their enforcement and failure modes are tested.

Each phase should be independently reviewable. Do not present the entire feature
as complete while the model authorization boundary is still an upstream dependency.

## Acceptance criteria and verification

- Every enabled capability is either governed at its real dispatch boundary or
  explicitly disabled in restricted profiles.
- No outer script approval bypasses nested Guard policy or sandbox boundaries.
- Users can distinguish decisions and outcomes without trusting the model's
  summary; missing audit data is visibly incomplete.
- Nested ASK cancellation, configuration races, and parallel calls fail safely.
- Documentation states data-egress, accounting, and non-transactional limits.
- `npm test` in pi-guard passes all static checks and real SDK regressions.
- `npm test` in pi-usage passes aggregate-usage/import regressions.
- Profile schema generation/freshness checks, reload, and guarded-subagent tests
  remain green when capability declarations or loadouts change.
