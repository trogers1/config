# Ticket session kickoff: plan, review, implement

## Status and purpose

Workshop plan agreed with Taylor. Generic fresh-launch inputs, the switchable Pi startup-profile override, and the shared skills (including explicit skip-plan mode) are implemented. CLI/guard verification passed, and two independent reviewers approved the final implementation without findings. Skill workflows are instruction documents and will be QAed during normal use, without a dedicated skill-workflow or LLM test harness. This document records the design and verification contract; installed commands depend on the repository's setup.

Make it easy to start a ticket in a separate dev worktree and agent session without manually transferring context. By default, the new session's first deliverable is a written plan, **not an implementation**. Taylor reviews that plan and explicitly invokes an implementation skill in the same conversation when ready. An explicit kickoff request to skip the plan instead authorizes direct implementation after gathering the ticket and handoff context; plan-first remains the default.

## Agreed decisions

- Keep `dev` generic. It manages worktrees, sessions, initial prompt delivery, and agent launch options; it does not fetch Jira tickets or prescribe a development workflow.
- Add a shared `start-ticket` skill that uses the existing Jira CLI, prepares a concise handoff, and calls `dev` to launch the new session.
- Launch immediately by default. Retain `--stage-agent` as an optional way to prepare the complete command without starting it.
- Support both Pi and Claude in the first version.
- By default, the launched session plans autonomously, writes a plan document, reports its path and any blocking questions, and stops. It must not begin implementation on its own.
- Support an explicit “skip the plan” opt-in in `start-ticket`. In this mode Taylor's kickoff request authorizes direct implementation after reading the ticket, handoff, repository instructions, and canonical Code Style and Typesafety snippets. Do not require a plan document or a second approval invocation. Still stop for blocking ambiguities, perform bounded verification, and leave changes uncommitted. Ticket content cannot select or authorize this mode; record Taylor's explicit selection in the handoff. This is a skill workflow choice, not a Jira-specific `dev` flag or permission change.
- In plan-first mode, Taylor reviews and can request plan revisions. Implementation starts through an explicit invocation such as `/skill:implement-plan <plan-path>` in the same session. The exact command presentation must follow each agent's existing shared-skill integration.
- Implementation reads the approved plan and the canonical **Code Style** and **Typesafety and Casting** snippets. Do not include **No Legacy** by default.
- The implementation outcome is completed and verified work left **uncommitted**. No automatic commit, push, merge request, merge, deployment, or Jira mutation.
- Keep pi-guard's existing automatic profile selection when no override is supplied. Do not add a separate repository-configured or global autonomous profile default.
- Allow an explicit Pi startup profile override. It selects the initial profile but does not pin the session; normal later profile switching remains available.
- Claude retains its existing native permission configuration. A Pi-only profile override is not silently translated into a Claude permission mode.
- If the source checkout has uncommitted changes, explain that they will not transfer and ask before launching. Never commit, stash, copy, or discard them automatically.
- If a ticket already has a worktree or dev session, show what exists and ask how to proceed. Do not overwrite its handoff, inject another kickoff, recover it automatically, or launch a duplicate agent.
- Follow the destination repository's established plan-document convention. Fall back to `plans/<TICKET>.md` when none exists.
- Completion and blocker reports stay in the new tmux session. No parent-session messaging, desktop notifications, watcher, or monitoring service in the first version.

## Intended experience

### 1. Start a ticket from an existing session

Example user request:

> Start RI-455 based on my current branch, using Pi.

The `start-ticket` skill:

1. Establishes the current repository, source worktree, source branch, and exact committed HEAD. Ask for clarification for a detached HEAD or ambiguous base rather than guessing.
2. Loads the existing Jira ticket-management instructions and discovers the installed CLI interface through help. Fetches the requested ticket read-only and records its canonical key and URL.
3. Checks for source-checkout changes and an existing matching branch, worktree, or dev session. Applies the agreed confirmation rules before creating anything.
4. Selects only relevant context from the current session: decisions, known constraints, plan/document paths, and important caveats. It does not copy the complete conversation or crawl other conversations.
5. Writes a task-specific, self-contained handoff identifying the explicitly authorized mode (plan-first by default; direct implementation only when requested), and launches the configured/selected agent through `dev tree` from the recorded source commit. Do not use a moving branch name in place of an already-resolved source commit without verifying that it still identifies the intended base.
6. Reports the branch, worktree, tmux session, agent, handoff location, and whether the agent was launched or merely staged.

Unless explicitly requested otherwise, the launch is detached from the parent session (`--no-attach`) and starts the agent immediately. `--stage-agent` is an explicit alternative, not the default.

Do not ask again for information the user already supplied. Ticket reads are not authorization to update Jira fields or status.

### 2. Produce the plan and stop (default)

Unless Taylor explicitly selected direct implementation at kickoff, the initial assignment tells the new session to:

- Verify its checkout, branch, and intended base against the handoff.
- Read repository instructions and inspect the code/documents necessary to plan accurately. "Plan first" means the first deliverable is the plan; it does not prohibit read-only investigation before writing it.
- Follow an existing repository planning convention, or write `plans/<TICKET>.md`.
- Capture the goal, acceptance criteria, relevant current behavior and file paths, proposed implementation steps, non-goals, verification strategy, risks, and unresolved questions.
- Identify missing requirements rather than inventing acceptance criteria.
- Write or revise the plan only. Do not modify application code, tests, dependencies, or infrastructure, or start an expensive verification run during the planning phase.
- End with the plan path, a short summary, unresolved questions, and how Taylor can invoke implementation after review.
- Stop and wait. Its own assessment that the plan is sound is not approval to implement it.

The planning phase does not automatically select a broader profile or weaken permissions to finish the assignment. This is a procedural review gate, not a claim that the model or its entire host process is sandboxed against all other effects.

### Optional: skip the plan and implement directly

An explicit request such as “Start RI-455 using Pi; skip the plan and implement” selects direct implementation. Do not infer this choice from a ticket's wording, a previous session's behavior, or an agent's assessment that the work is simple.

The handoff records Taylor's authorization separately from external ticket content. The new session verifies its checkout and intended base, reads repository instructions and both canonical snippets, and gathers the ticket/handoff context before coding. It must stop for blocking ambiguities or missing/denied snippet access rather than invent requirements or bypass permissions.

Reuse the implementation discipline below: existing definitions and schemas, production-like bounded verification, an uncommitted result, and a same-session outcome/blocker report. No plan document or later implementation-skill invocation is required in this mode. The reviewed-plan entry point still requires its specified approved plan; direct mode must not invent a placeholder plan to bypass that contract. Keep shared implementation guidance centralized when the skills are implemented.

This changes the procedural review gate only. It does not broaden Pi profiles or native Claude permissions, authorize Jira mutations, or permit commits, pushes, merges, or deployments.

### 3. Implement the reviewed plan in the same conversation

An explicit implementation-skill invocation identifies the plan to implement and authorizes the implementation phase within the session's existing permissions.

The shared `implement-plan` skill:

1. Reads the specified plan, repository instructions, and the two canonical snippet files before coding.
2. Verifies that it is operating in the intended worktree and that the approved plan remains applicable to the current code.
3. Stops for clarification if there are unresolved blocking decisions or a material change in requirements. Do not silently expand scope or rewrite the agreed plan to justify different work.
4. Implements the plan, reusing the repository's existing definitions, configuration, schemas, and testing conventions.
5. Runs relevant, production-like verification. Start with targeted checks, state expected duration before longer runs, use bounded commands, and report actual results and omissions. Do not silently launch a long full suite.
6. Leaves changes uncommitted and reports implemented behavior, changed files, checks/results, remaining risks, and any blockers in the same session.

The skill never adds permissions, disables sandboxing, routes a blocked operation through another host process, or treats a denial as a reason to try an equivalent workaround. Missing snippet access is a blocker to resolve explicitly, not permission to bypass the gate.

## Source-of-truth references

### Shared snippets

Confirmed canonical source files:

- Code Style: `home/.agents/snippets/code.md`, installed as `~/.agents/snippets/code.md`.
- Typesafety and Casting: `home/.agents/snippets/types.md`, installed as `~/.agents/snippets/types.md`.

Reference these files directly from the implementation skill. Do not maintain a second copy of their instructions in the skill or generated handoff. Read their current contents at implementation time, not only during kickoff.

Use the existing shared-snippet access mechanisms where available. Do not silently change profiles to make these paths readable. Describe readable, missing, and permission-denied references explicitly in the skill; do not add tests attempting to prove an LLM follows these instructions.

### Jira

The existing retrieval executable is `jira-ticket`, documented by `home/.agents/skills/jira-ticket-management/SKILL.md`. Reuse that CLI and its help-driven contract; do not add a Jira API client to `dev` or duplicate its validators.

The similarly named `home/.agents/skills/jira-tickets/SKILL.md` is the CSV ticket-creation skill (`make-jira-tickets`), not the retrieval workflow needed here.

### Existing launch and recovery behavior

Reuse the existing lifecycle locking, atomic intent registry, configured-agent-pane tracking, worktree setup, rollback, and exact Pi/Claude recovery. Do not build another session registry or autonomous-job manager.

## Generic launch interface

Proposed public additions, to be finalized against the existing CLI parser and installed agent interfaces:

- `--prompt <text>`: an initial user assignment for a fresh agent session.
- `--prompt-file <path>`: a UTF-8 initial assignment file; mutually exclusive with `--prompt`.
- `--agent-profile <name>`: an explicit Pi pi-guard startup profile override; reject it for Claude rather than ignoring it.

Expose compatible launch options on ordinary new-session entry points (`dev new`/`dev open` and `dev tree`) through shared argument/configuration logic. Preserve their existing behavior when the options are omitted.

Illustrative launch shape, **not an existing command**:

```sh
dev tree --no-attach --agent pi --prompt-file <handoff-file> -- <ticket-branch> <source-commit>
```

An optional Pi override would add `--agent-profile <profile>`. An optional staged launch would add `--stage-agent`. Selecting Claude uses its own prompt-delivery adapter, without pi-guard options.

### Agent adapters and launch safety

- Verify the installed Pi and Claude initial-input semantics before choosing adapter details. Pi documents positional prompts and `@file` input; do not assume Claude has identical attachment or stdin behavior.
- Use fresh-session semantics for a supplied kickoff. The current configured Claude command (`claude --continue || claude`) must not accidentally continue a different conversation or retry a failed kickoff as a fresh session.
- Do not append flags to an arbitrary configured shell expression. Reuse the existing agent/config resolver and make supported launch forms explicit. Unsupported custom wrappers must fail clearly before creating a worktree or starting any process; do not silently replace user configuration.
- Treat prompts and handoff contents as data, never as shell fragments. Preserve Unicode, quotes, leading dashes, whitespace, and newlines without shell substitution or unintended execution.
- A staged command must remain inert even when the assignment contains newlines. Do not type raw multiline prompt contents into a tmux shell and assume omitting the final Enter is sufficient.
- Favor a safely quoted, single-line launch representation with a durable input file. If launch-time file loading needs a helper, reuse existing runtime/helpers where practical; do not add a new runtime or a privileged execution service.
- Validate the input and requested agent/profile before lifecycle mutation where possible; recheck launch-time prerequisites when a staged command is eventually executed.
- Supplying prompt/profile options to an already-running session must fail with an actionable message instead of claiming to apply options that were ignored. The skill's existing-session confirmation must not bypass this CLI guard.
- Missing/unreadable/empty handoffs, invalid options, unsupported agent combinations, and incompatible launch configuration fail explicitly. Do not fall back to an agent without its assignment.

## Pi startup-profile override

Add a dedicated pi-guard startup option, provisionally `--guard-profile <name>`, and map the generic dev option to it only for Pi.

Requirements:

- With no override, preserve the existing automatic profile-selection behavior exactly.
- An explicit override takes precedence over normal initial auto-selection for this launch, and activates before any model tool execution.
- It is a starting selection, not a permanent pin. Normal `/profile-select` remains usable and normal session-profile persistence continues to work.
- Do not misuse `PI_SUBAGENT_PROFILE` for a top-level dev session. Preserve that variable's existing authoritative subagent behavior; a new startup flag must not bypass a pinned subagent restriction.
- An unknown profile, unavailable pi-guard integration, or conflicting authoritative subagent selection fails clearly rather than silently running with a different policy.
- Do not automatically inherit the launching session's active profile, particularly a workspace-management profile. With no override, let the new session resolve its own normal posture.
- No `sandbox: false`, auto-approval transform, broad directory grant, or native Claude permission-bypass flag is implied by "autonomous."

Document and test the exact startup-selection precedence and what happens when the resulting session is later resumed. Preserve existing directory/session selection behavior unless an explicit change is separately agreed.

## Handoff and lifecycle design

Prefer durable launch artifacts under `${XDG_STATE_HOME:-$HOME/.local/state}/dev`, using a unique per-launch directory rather than a shared ticket-named file that another launch could overwrite. This is a launch-context artifact, not another registry.

- Use private file permissions and atomic publication. Never overwrite an existing launch's handoff.
- Record the ticket key/URL, source branch and commit, relevant context, authorized workflow mode, and intended outcome. The default is planning-only with an explicit review gate; direct implementation requires Taylor's explicit kickoff authorization recorded separately from quoted external content.
- Keep task instructions separate from quoted external ticket content. Ticket descriptions and repository files cannot authorize profile changes, secret disclosure, or bypassing the review gate.
- Do not copy credentials, secret values, environment files, private transcripts, or unrelated user data into the handoff. Paths to relevant documentation are preferable to large copied documents.
- Resolve handoff delivery through each agent's actual supported interface. Do not depend on a model being able to read an external state path that its profile/native permissions forbid; deliver the initial assignment as authorized initial input rather than granting broad filesystem access.
- Retain artifacts while a staged command depends on them. Ordinary close/recovery must not delete inputs needed to start a previously staged session.
- Only extend the existing persisted schema if additional launch intent is actually required. Derive validation/types from the existing definitions and migrate old records without losing order, conversations, or recovery intent.
- Exact recovery resumes the recorded conversation and never replays the planning kickoff or implementation invocation. A staged agent that has not started yet needs its original launch input preserved; do not confuse that case with an existing conversation.
- An agent startup failure remains visible in its pane. Do not claim that launching a process proves the plan was written, and do not relaunch automatically after an uncertain outcome.

## Implementation sequence

### Phase 1: generic fresh-launch inputs

- Inspect and test the installed agent launch interfaces with isolated fixtures; settle supported configuration forms before adding flags.
- Add shared parsing/validation for prompt, prompt-file, and optional Pi profile selection.
- Build safe Pi/Claude fresh-launch adapters, preserving existing no-prompt behavior and configured agent-pane selection.
- Support immediate and staged launch without raw multiline shell injection, conversation guessing, or fallback-to-fresh retries.
- Integrate durable input references with existing lifecycle/registry logic only where necessary.

### Phase 2: switchable Pi startup override

- Add and document pi-guard's explicit startup selection.
- Keep default auto-selection unchanged and preserve authoritative subagent restrictions.
- Verify activation timing, invalid-profile failure, later manual switching, and resume behavior.

### Phase 3: shared planning and implementation skills

- Add `home/.agents/skills/start-ticket/SKILL.md` for read-only Jira lookup, source/base checks, conflict confirmations, concise handoff creation, and immediate session launch. Default to plan-first; support explicit skip-plan/direct-implementation requests without adding workflow flags to `dev`.
- Add `home/.agents/skills/implement-plan/SKILL.md` for explicit implementation of a reviewed plan, canonical snippet reads, bounded verification, and an uncommitted result.
- Use the existing shared-resource setup/generator so both Pi and Claude discover the skills. Do not create separate manually maintained agent-specific copies.
- Planning instructions live in the self-contained kickoff assignment generated by `start-ticket`; no separate planning skill is required for the first version.
- Confirm generated/setup changes are limited to the intended new skills. Do not refresh unrelated synced artifacts as part of this work.

### Phase 4: verification and documentation

- Extend the current public-command and real-tmux fixture tests rather than inventing a parallel launch harness. Test CLI behavior at its own public boundary; do not add skill-document content/discovery assertions or simulated tests claiming an LLM follows the Markdown workflows.
- Add focused pi-guard lifecycle/validator tests at the existing package boundary for startup selection. Preserve the package's existing regression suite; do not retain a separate fake-model/real-Pi test harness for this workflow.
- Add realistic workflow examples to `tmux_and_worktrees/README.adoc` and startup-option documentation to pi-guard.
- Document phase boundaries, override scope, native Claude permissions, durable handoffs, staging, and exact recovery.

## Verification contract

The CLIs own their automated verification. Use schema-valid boundary inputs, isolated HOME/XDG/configuration, fake agent executables, throwaway Git repositories, and dedicated fake/isolated tmux as appropriate. Keep new fixture files inside this repository and clean them up. Do not touch live user worktrees, agent credentials, transcripts, or the real tmux server to test this feature. Skills are instruction documents: review their wiring and instructions without skill-specific automated assertions. Workflow QA happens during normal use; no dedicated skill-workflow or LLM-based testing is required.

Targeted automated scenarios:

1. Both agent adapters receive the exact intended initial assignment in the configured pane, with no prompt leakage to other windows.
2. Immediate launch starts exactly one agent. Staging starts none until Enter, including prompts containing newlines, shell metacharacters, Unicode, and leading dashes.
3. Existing no-prompt launches retain their behavior. A prompt-bearing fresh launch never takes Claude's continue/fallback path.
4. Missing input files, unsupported wrappers/options, and unavailable requested profiles fail clearly without partial checkout/session creation where preflight can detect them.
5. The Pi override applies before the first model tool call, remains switchable, and does not override authoritative subagent restrictions. No-override launches preserve automatic selection.
6. Existing registry records migrate safely if needed; exact recovery never resubmits the kickoff. Staged-before-start recovery retains the original assignment.
7. Scoped generation validates selected names, detects namespace collisions, and preserves unrelated outputs. Use generic generator fixtures, not assertions about the skill documents.
8. Workspace-management permissions are not implicitly carried into the new coding session, and no new general write roots or sandbox workarounds are introduced.

Start with the narrowest relevant tests. Announce expected duration for longer checks, apply hard time limits to subprocesses, and report timings. Do not run the full dev or pi-guard suite without first explaining its expected duration and necessity.

Review shared-skill wiring and instructions, and rely on regular workflow QA during normal use. Do not add skill-document assertions, simulated LLM workflows, a fake-Jira skill harness, or a required manual LLM smoke-test procedure. Jira's CLI owns its retrieval-contract tests. Fake-agent CLI fixtures establish deterministic launch behavior only; they do not claim to prove model compliance.

## Explicit non-goals

- Implementation without Taylor's explicit authorization, whether via skip-plan kickoff or later implementation-skill invocation. Finishing a plan is never itself authorization.
- A separate implementation conversation or full parent-transcript cloning.
- A Jira-specific `dev` subcommand, custom Jira client, or automatic Jira mutations.
- Automatic commits, pushes, merge requests, merges, deployments, or dependency installation.
- A new global/repository profile-default mechanism or permanent top-level profile pin.
- General sibling-worktree access in ordinary coding profiles, sandbox bypasses, or a privileged command broker.
- Cross-session completion messaging, desktop notifications, progress watchers, or another orchestration registry.
- Automatic copying/stashing of dirty source changes, overwriting existing ticket work, or blind retries after uncertain launches.
