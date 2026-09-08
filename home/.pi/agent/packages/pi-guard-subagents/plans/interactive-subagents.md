# Guarded Interactive Subagents Plan

## Status

**Implemented (live-parent scope).** Restart/reload recovery is explicitly out of scope; this plan covers the guarded interactive lifecycle while the parent process remains alive.

## Goal

Retain `pi-guard-subagents` as the single, permission-aware delegation package while replacing its blocking JSON-worker lifecycle with a tmux-based interactive subagent lifecycle.

Every child agent will:

- run in its own tmux pane;
- return control to the parent immediately after launch;
- show live activity/status in the parent UI;
- be able to ask the parent one `ask_question` and wait for a reply;
- auto-close after an autonomous task completes;
- run through `pi-guard` under a resolved, non-escalating profile;
- enforce declared `writes` scopes at the guard layer; and
- produce a durable, auditable handoff on completion.

There will be **no headless fallback**. `tmux` is a hard runtime requirement.

## Non-goals

- Installing `pi-interactive-subagents` as a second active extension.
- Keeping a parallel headless execution backend.
- Supporting nested delegation. Only the root/orchestrator session may spawn children.
- Using before/after Git status or diffing as an audit or scope-enforcement mechanism.
- Making network or paid-model calls in tests.

## Existing assets to preserve

From the current package:

- public `subagent` API: single, `tasks` (parallel), and `chain` modes;
- agent discovery precedence and project-agent confirmation;
- agent frontmatter and profile fallback conventions;
- parent-profile inheritance via `PI_GUARD_ACTIVE_PROFILE` / `PI_SUBAGENT_PROFILE`;
- hard write-scope narrowing via `PI_SUBAGENT_PERMISSIBLE_GLOBS`;
- persistent worker sessions and warm resumes;
- handoff artifacts, usage information, tool-observed changed paths, and pi-guard denial reporting;
- bounded parallelism and automatic chain semantics;
- existing orchestration prompts and skill conventions.

From `pi-interactive-subagents`:

- tmux pane creation, message delivery, close/rebalance behavior, and shell-readiness handling;
- asynchronous child lifecycle/watchers;
- child activity protocol and parent status widget;
- persistent name registry for the live parent process;
- `subagent_message` to steer a running child or resume a completed one;
- child completion signaling and result steering;
- question parking and reply flow;
- sandbox/loadout snapshot and faithful resume concept;
- status state machine and child tools widget.

## Architecture

### Package ownership

Keep the implementation in:

```text
home/.pi/agent/packages/pi-guard-subagents/
```

Do not load the external interactive-subagents package alongside it: both extensions expose `subagent`, and its unmodified default-deny child launcher would not include pi-guard.

Port the needed functionality into a current-Pi-compatible local implementation. Keep an upstream source commit/reference and attribution so future selective merges from interactive-subagents remain practical.

Suggested layout:

```text
extensions/
  index.ts                         # Public tools, orchestration state, lifecycle entry point
  agents.ts                        # Existing discovery and agent policy
  handoff.ts                       # Existing audit artifact writer, revised to remove Git diffing
  interactive/
    launcher.ts                    # Guarded tmux child launch + safe resume
    tmux.ts                        # Multiplexer boundary
    activity.ts                    # Child activity recorder/protocol
    status.ts                      # Parent status model/widget formatting
    registry.ts                    # Persistent child names and orchestration-run state
    child-runtime.ts               # Child-only UI, auto-exit, ask_question, completion signals
    recovery.ts                    # Live-parent completion/question watching (not restart recovery)
    types.ts                       # Versioned persisted loadout/run schemas
agents/
prompts/
tests/
```

The exact file boundaries may differ, but the tmux/process boundary, child runtime, live-parent persistence, and guard/loadout construction must remain independently testable.

### Current Pi compatibility

The source interactive package uses the older `@mariozechner/*` namespace and targets Pi 0.65. Port it to the installed `@earendil-works/*` APIs and the package's supported Pi version before adopting behavior. Treat the external code as a source implementation, not a drop-in runtime dependency.

### Upstream reference map

Porting checkout: [amosblomqvist/pi-interactive-subagents](file:///Users/taylor.rogers/Code/open_source/pi-interactive-subagents). All adoption references in this plan point to that local checkout.

Porting reference recorded at implementation start: `amosblomqvist/pi-interactive-subagents` commit `c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7`. Record the same reference in the package README so future selective merges remain traceable. The references below identify source behavior to **adapt and port**, not code to copy wholesale: every adapted part must use current Pi APIs and satisfy the guarded architecture in this plan.

| Planned area                                                      | Upstream implementation reference                                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| tmux pane creation, input, polling, cleanup, and layout           | [`pi-extension/subagents/tmux.ts`](file:///Users/taylor.rogers/Code/open_source/pi-interactive-subagents/pi-extension/subagents/tmux.ts)                           |
| async spawn/watch/message orchestration and tool surface          | [`pi-extension/subagents/index.ts`](file:///Users/taylor.rogers/Code/open_source/pi-interactive-subagents/pi-extension/subagents/index.ts)                         |
| session sidecars, persistent names, and session-result extraction | [`pi-extension/subagents/session.ts`](file:///Users/taylor.rogers/Code/open_source/pi-interactive-subagents/pi-extension/subagents/session.ts)                     |
| child UI, auto-exit, completion signals, and `ask_question`       | [`pi-extension/subagents/subagent-done.ts`](file:///Users/taylor.rogers/Code/open_source/pi-interactive-subagents/pi-extension/subagents/subagent-done.ts)         |
| child activity-file protocol                                      | [`pi-extension/subagents/activity.ts`](file:///Users/taylor.rogers/Code/open_source/pi-interactive-subagents/pi-extension/subagents/activity.ts)                   |
| parent status state machine and widget configuration              | [`pi-extension/subagents/status.ts`](file:///Users/taylor.rogers/Code/open_source/pi-interactive-subagents/pi-extension/subagents/status.ts)                       |
| end-to-end lifecycle behavior                                     | [`test/integration/subagent-lifecycle.test.ts`](file:///Users/taylor.rogers/Code/open_source/pi-interactive-subagents/test/integration/subagent-lifecycle.test.ts) |
| tmux pane behavior                                                | [`test/integration/tmux-surface.test.ts`](file:///Users/taylor.rogers/Code/open_source/pi-interactive-subagents/test/integration/tmux-surface.test.ts)             |

Pi-guard-specific policy, profile propagation, hard scopes, handoffs, chain scheduling, and the required production-like test harness are owned by this package and have no upstream equivalent to adopt unchanged.

## Public behavior

### `subagent`

Preserve the current tool schema and modes:

- **single**: one `{ agent, task, cwd?, writes?, sessionId?, label? }`;
- **parallel**: `tasks: [...]`, each child in its own pane;
- **chain**: `chain: [...]`, started one step at a time.

All modes launch interactively and return promptly with durable run metadata rather than waiting for child completion.

For chains:

1. launch the first step;
2. persist chain state before the child can complete;
3. on successful completion, substitute `{previous}` with that child’s final summary and launch the next step;
4. on failure, stop the chain and steer the failure/result to the parent;
5. after the last step, steer the final chain result to the parent.

The scheduler is scoped to the live parent process; restart/reload recovery is intentionally unsupported.

### tmux requirement

A spawn outside tmux, or without a usable `tmux` binary, fails clearly and instructs the user to start Pi in tmux, for example:

```bash
tmux new -A -s pi 'pi'
```

There is no JSON/headless fallback.

### `subagent_message`

Provide a parent-facing message tool addressed by persistent child name:

- a running child receives the message in its pane at its next turn boundary;
- a completed child is resumed using its persisted guarded loadout;
- replies to a pending child `ask_question` use this same mechanism;
- name lookup and resume remain available while the parent process remains alive.

### Child `ask_question`

Expose `ask_question` only in child sessions.

It accepts one freeform question, writes a durable question signal, and parks the child in `waiting`. The child must not auto-exit or continue based on an assumed answer. The parent receives a clearly rendered/steered notification and answers through `subagent_message`.

Do not rename this tool to `ask_orchestrator`.

### Auto-exit

All built-in autonomous child agents are configured to auto-exit after their task completes normally. A child remains alive while:

- an `ask_question` is unanswered; or
- it has not completed/has been interrupted.

Nested delegation remains disabled, so child-child dependency waiting is not supported.

## Security and permission model

### pi-guard is mandatory in every child

The interactive launcher must use a default-deny extension/tool loadout. That loadout must explicitly include the pi-guard extension; `--no-extensions` alone is not sufficient.

Conceptually, a guarded child starts as:

```text
pi --session <child-session>
   --no-extensions
   --tools <explicit child allowlist>
   -e <pi-guard/extensions/guard.ts>
   -e <child-runtime.ts>
   -e <only backing extensions for explicitly permitted child tools>
```

The actual invocation must preserve the current Pi CLI/API compatibility rules and avoid depending on global extension discovery.

### Profile selection

Resolve a child profile as follows:

1. inherit the parent’s active `PI_GUARD_ACTIVE_PROFILE`, when present;
2. otherwise use the child agent definition’s `profile:` as a fallback;
3. otherwise retain pi-guard’s normal fail-closed/default profile behavior.

This preserves the non-escalation invariant: a restrictive parent cannot create a looser child merely by choosing a different agent name.

Export the resolved profile to the child through `PI_SUBAGENT_PROFILE`.

### Write scopes

A declared `writes` list is a hard narrowing constraint, not merely a planning annotation.

- Export it as `PI_SUBAGENT_PERMISSIBLE_GLOBS`.
- Require pi-guard to enforce it for `write`, `edit`, and guarded Bash path/redirection handling.
- A scope may narrow an already permitted profile; it must never widen a profile.
- Omitted `writes` leaves only the resolved pi-guard profile policy in effect.
- Child resume replays the exact original scope.

Do not use Git status snapshots or diffs to infer, validate, or attribute scope compliance.

### Tool and extension allowlisting

The child receives only:

- selected built-in tools;
- pi-guard;
- the child control runtime (`ask_question`, activity/completion support);
- explicitly registered backing extensions for permitted extension tools.

No child can obtain broader tools by omitting an agent name, resuming a session, or relying on globally discovered extensions.

### Nested delegation

Continue setting/recognizing `PI_SUBAGENT_DEPTH` and reject child calls to `subagent`. The parent can launch parallel panes; children cannot fan out additional workers.

## Persisted live-parent state

### Versioned child loadout

Write a versioned sidecar/loadout before launching each child. It must contain all values necessary to reconstruct the exact child security posture and execution environment:

```ts
interface GuardedInteractiveLoadout {
	version: 1;
	agent: string;
	profile: string | null;
	writes: string[] | null;
	toolAllowlist: string[];
	guardExtensionPath: string;
	childRuntimePath: string;
	backingExtensionPaths: string[];
	backingExtensionDigests: Array<{ path: string; sha256: string }>;
	model: string | null;
	thinking: string | null;
	systemPromptMode: "append" | "replace" | null;
	identity: string | null;
	cwd: string;
	agentDir: string | null;
	codingAgentDir: string | null;
	autoExit: boolean;
}
```

Validate the sidecar at the resume boundary. If it is absent, malformed, incompatible, or references unavailable required guard/runtime paths, refuse resume rather than launching an unrestricted child.

### Parent orchestration state

Persist parent run state in a versioned session-scoped registry/artifact. It must record at minimum:

- parent session identity;
- child display name, child session path/id, tmux pane id, start time, task, agent, and loadout path;
- live/pending/completed/failed/question-waiting state;
- question acknowledgment state;
- single/parallel/chain membership;
- remaining chain steps and prior result needed for `{previous}` substitution;
- handoff path/status once available.

Use atomic writes and validate reads. The registry is the durable source of truth; in-memory maps are only caches.

### Parent-process scope

Restart and reload recovery are intentionally out of scope. The registry, watchers, questions, messages, chains, and completion delivery are guaranteed only while the launching parent process remains alive. Parent shutdown stops live watchers and does not promise cross-process delivery or chain continuation.

## Completion, handoffs, and audit output

When a child completes or fails:

1. determine terminal state from the child runtime/session signal;
2. collect final assistant summary, usage, model, and tool-call records;
3. collect pi-guard-denied tool results as explicit permission-block records;
4. collect paths directly observed in `write`/`edit` tool calls;
5. write the established handoff artifact, updated to label changed paths as **tool-observed** rather than Git-inferred;
6. persist terminal state before steering the parent notification;
7. steer a concise result containing status, session reference, handoff path, observed paths, and permission blocks.

Do not run pre/post `git status`, `git diff`, or equivalent repository-diff attribution. Scope enforcement belongs to pi-guard; the handoff is an audit record of observable runtime events, not a claim of complete filesystem attribution.

## UI and status

Adopt a compact parent widget above the editor listing running children, elapsed time, name/agent, and state such as `starting`, `active`, `waiting`, or `stalled`.

Child activity files should report meaningful lifecycle events: session start, agent/turn/provider activity, tool activity, question waiting, completion, and shutdown. Keep writes atomic and rate-limited.

The child pane should expose its identity and active tool summary, with a shortcut to expand/collapse tool details.

Status transitions and completion/question notifications must use Pi’s current custom-message/steer APIs and be guarded for appropriate run mode. Pane management must avoid stealing focus and rebalance layouts after launch and close.

## Agent-definition changes

Extend the existing agent frontmatter only where required for interactive lifecycle behavior, for example:

- `auto-exit: true` for bundled autonomous agents;
- existing `profile`, `tools`, `model`, and prompt fields;
- optional current-compatible system-prompt/identity mode if needed.

Keep existing user/project override precedence and project-agent confirmation. Project-local definitions remain opt-in through `agentScope` / confirmation.

## Testing strategy

### Testing principle

Tests must follow the repository’s behavioral, production-like approach:

- exercise the package’s public extension/tool boundary rather than private helpers whenever a behavior is observable there;
- use the real Pi CLI and real extension loading path;
- use real tmux panes and real child process wiring;
- use realistic temporary session/config/artifact directories;
- derive expectations from declared agent/profile/scope configuration rather than duplicating implementation logic;
- avoid mock-heavy tests that only verify internal calls;
- retain focused lower-level tests only for genuinely complex, hard-to-drive logic such as state transitions, sidecar parsing/validation, and idempotency decisions.

### Mandatory test environment

`npm test` must require and run tmux-backed integration tests. A missing or unusable tmux environment is a test failure, not a skip and not a fallback to headless testing.

The mandatory lifecycle matrix must execute the generated production child command with the installed Pi CLI in real tmux panes. It must load the real pi-guard and child-runtime extensions, use a deterministic local provider/runtime with no network or paid-model calls, and exercise the registered public tools against those live child processes. The extension harness and lower-level sidecar tests may supplement this matrix, but must not replace it or claim production coverage.

The fixture provider/runtime should deterministically emulate the minimal sequences needed to cause a child to:

- make tool calls;
- ask a question;
- receive a reply;
- finish successfully;
- fail or be interrupted;
- resume with a follow-up;
- complete multiple chain steps.

### Required real-process integration coverage

1. **Interactive launch** — invoking the registered `subagent` tool creates a non-focused tmux pane, returns promptly, persists the registry/loadout, and displays live state.
2. **Tmux requirement** — invocation outside tmux fails with actionable setup guidance and never starts a headless worker.
3. **Guard is loaded** — a child launched with default-deny extensions still executes pi-guard.
4. **Profile non-escalation** — the parent active profile overrides an agent’s fallback profile; fallback applies only when the parent provides none.
5. **Scope enforcement** — a child with `writes` can modify an in-scope path and is blocked by pi-guard from `write`, `edit`, Bash path operands, and output redirection outside scope.
6. **Scope persistence** — a resumed child retains the original profile and scope even if agent definitions or parent settings later change.
7. **No scope widening** — a permissive `writes` declaration cannot override a restrictive profile.
8. **Tool/extension isolation** — a child cannot access an undeclared global extension/tool; permitted extension tools load only with their backing extension.
9. **Question flow** — child `ask_question` parks the pane; parent receives one visible notification; `subagent_message` delivers an answer; child continues and auto-closes after completion.
10. **Running-child messaging** — a message sent by persistent name reaches the running pane at a turn boundary.
11. **Safe completed-session resume** — a completed named child resumes from its saved session with its snapshotted restricted loadout, not global defaults.
12. **Completion/handoff** — completion steers a single parent result and writes a handoff containing final output, session, usage, tool-observed write/edit paths, and pi-guard blocks.
13. **No Git-diff dependency** — the completion path does not invoke Git status/diff and handoff wording does not claim complete filesystem attribution.
14. **Parallel behavior** — independent tasks create separate panes, use unique persistent names, retain separate scopes/loadouts, and report independently.
15. **Chain behavior** — a successful step launches the next only once, replaces `{previous}` correctly, and a failed step stops the chain.
16. **Live-parent cleanup/failure handling** — pane termination and child runtime failure produce a terminal outcome, live watchers do not duplicate delivery, and parent shutdown stops timers without silently unrestricted resume paths.
17. **Nested-delegation denial** — child sessions cannot invoke `subagent`.

### Focused lower-level tests

Keep targeted tests only for logic that benefits materially from isolation:

- versioned persisted-state and loadout schema validation/failure messages;
- atomic registry update and idempotent completion transition rules;
- status/activity state-machine classification;
- tmux command escaping and pane-id validation;
- exact mapping between tool allowlists and extension paths;
- handoff formatting for observed paths and permission blocks.

These tests supplement the mandatory installed-Pi/real-tmux integration suite; they do not replace real-process evidence.

## Implementation sequence

1. Record the pinned upstream commit SHA and establish deterministic local provider/runtime fixtures; make the public lifecycle matrix execute unchanged generated child commands with the installed Pi CLI in real tmux panes, including production extension loading and guard enforcement. Make this real-process suite part of `npm test`; retain the extension harness only for focused supplemental state-machine tests.
2. Add versioned schemas/types for guarded child loadouts and parent orchestration registry; add failure-first validation tests.
3. Port current-Pi-compatible tmux, activity, and status primitives behind isolated interfaces, adapting [`tmux.ts`](file:///Users/taylor.rogers/Code/open_source/pi-interactive-subagents/pi-extension/subagents/tmux.ts), [`activity.ts`](file:///Users/taylor.rogers/Code/open_source/pi-interactive-subagents/pi-extension/subagents/activity.ts), and [`status.ts`](file:///Users/taylor.rogers/Code/open_source/pi-interactive-subagents/pi-extension/subagents/status.ts).
4. Implement the child runtime—identity/tools widget, activity recorder, `ask_question`, auto-exit, and terminal signaling—adapting [`subagent-done.ts`](file:///Users/taylor.rogers/Code/open_source/pi-interactive-subagents/pi-extension/subagents/subagent-done.ts).
5. Implement guarded interactive launch by adapting the lifecycle concepts in [`index.ts`](file:///Users/taylor.rogers/Code/open_source/pi-interactive-subagents/pi-extension/subagents/index.ts) and [`session.ts`](file:///Users/taylor.rogers/Code/open_source/pi-interactive-subagents/pi-extension/subagents/session.ts): profile resolution, scope export, explicit pi-guard inclusion, strict tool/extension allowlisting, and initial registry persistence.
6. Implement parent child watching, completion extraction, handoff generation without Git diffing, and exactly-once parent steering.
7. Add `subagent_message` for live steering and safe completed-session resume from snapshotted loadout.
8. Implement parallel state and automatic chain scheduler/persistence.
9. Migrate bundled agent definitions to autonomous interactive auto-exit behavior; update README, prompts, and orchestration skill guidance.
10. Run the complete mandatory tmux integration suite and the package static checks after each coherent increment.

## Acceptance criteria

The migration is complete only when:

- `pi-guard-subagents` is the sole active subagent extension;
- every delegation mode launches tmux-based interactive children and no headless fallback exists;
- pi-guard, the resolved profile, and hard write scope are present for every launch and resume;
- child questions, messages, auto-close, handoffs, parallel tasks, and chains work through the public interface while the parent remains alive;
- restart/reload recovery and cross-process completion delivery are explicitly not supported;
- no Git diff/status-based audit logic remains;
- nested delegation remains denied; and
- `npm test` runs and passes the complete deterministic public lifecycle matrix using unchanged generated child commands, the installed Pi CLI, real tmux panes, production pi-guard/child-runtime loading, and only local inference infrastructure; supplemental mocks or sidecar tests do not substitute for this evidence.
