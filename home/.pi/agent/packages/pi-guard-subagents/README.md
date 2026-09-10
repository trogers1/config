# pi-guard-subagents

Permission-aware, auditable subagent delegation for [Pi](https://pi.dev). This
package bundles the `subagent` extension and integrates with `pi-guard`, so
worker processes run under an explicit permission posture instead of merely
inheriting the main session's defaults.

## Install

> **Security:** a subagent receives your Pi extensions and credentials. Review
> agent prompts, use trusted packages only, and treat project-local agents as
> repository-controlled code.

Install pi-guard first to enforce worker profiles and declared write scopes,
then install this companion package:

```bash
pi install npm:@trogers1/pi-guard
pi install npm:@trogers1/pi-guard-subagents
```

Use `pi install -l` instead to put either package in the current project's Pi
settings. Pin releases for reproducible setups, for example
`pi install npm:@trogers1/pi-guard@0.1.0` and
`pi install npm:@trogers1/pi-guard-subagents@0.1.0`. Restart Pi after installation.

pi-guard is mandatory for delegation. Every child is launched with an explicit
pi-guard extension and a snapshotted profile/loadout; launches fail closed if
the guard runtime cannot be resolved.

## Release (maintainers)

This package is published independently. From a clean checkout, verify the
package, inspect the tarball, bump its version, and publish it only after the
matching pi-guard release is available:

```bash
cd home/.pi/agent/packages/pi-guard-subagents
npm ci
npm test
npm pack --dry-run
npm version <new-version>
npm publish
```

An npm account authorized for `pi-guard-subagents` is required. Validate a
release without changing settings via
`pi -e npm:@trogers1/pi-guard-subagents@<version>`; use `-e` for pi-guard too when
checking their integration.

The interactive lifecycle is a selective current-Pi port of local
`amosblomqvist/pi-interactive-subagents` commit
`c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7` (tmux/activity/status/session
patterns), adapted to retain pi-guard's explicit loadouts and permission model.
The package remains the sole active subagent extension; it does not load a
second interactive-subagents package.

Forked from pi's `examples/extensions/subagent` with additions:

- **Child-pane shortcut fallback.** The tool-details toggle responds to `Alt+T` and the macOS-safe `Ctrl+Shift+T`.
- **Interactive tmux lifecycle.** Child processes run in their own tmux pane,
  with a persistent registry/loadout and no headless fallback. Pi must be
  started inside tmux (`tmux new -A -s pi 'pi'`).
- **Persistent worker sessions.** Every worker runs under `--session-id <uuid>
--name subagent:<agent>:<label>`. The result tells you the id; inspect it live
  afterwards with `pi --session <id>` from the same project directory, or
  `/resume` from within pi.
- **Warm retries.** Pass a worker's `sessionId` back in a later call and it
  resumes _with its full context_ — correction rounds don't re-pay the ramp-up
  (re-reading files, re-deriving approach).
- **Handoff files.** Set `runDir` and each worker gets a markdown audit file
  (task, files changed, session id, timing, cost, final output) written by the
  extension, not the worker. Use `.pi/orchestration/<run-name>/` — that location
  is auto-gitignored.
- **Declared write scopes.** Per-task `writes` path prefixes let you plan
  non-conflicting parallel work. `pi-guard` blocks out-of-scope
  `write`/`edit` calls and Bash path references; results and handoffs retain an
  additional audit check for observed out-of-scope changes.
- **Nested-delegation guard.** Worker processes run with `PI_SUBAGENT_DEPTH=1`;
  the tool refuses to delegate from inside a worker, so costs can't fan out
  recursively.
- **Guarded interactive lifecycle.** Children run in dedicated tmux panes,
  report activity and terminal state through atomic sidecars, can park on one
  `ask_question`, and auto-close after normal completion. Parent watchers remain
  active for the lifetime of the launching parent; restart/reload recovery is not supported.
- **Premature-exit detection.** A worker that exits 0 but whose last message
  ended mid-turn (`toolUse`) or truncated (`length`) is reported as failed,
  not completed, so the orchestrator resumes the session instead of trusting
  silence. Worker stderr is captured into the handoff file.
- **Orchestrate skill.** A companion skill at
  `~/.pi/agent/skills/orchestrate/SKILL.md` drives the full plan.md →
  progress.md → dispatch → review → integrate loop.

## Layout

```
pi-guard-subagents/
├── package.json          # pi manifest (extensions + prompts)
├── extensions/
│   ├── index.ts          # the `subagent` tool
│   ├── agents.ts         # agent discovery (builtin < user < project)
│   └── handoff.ts        # handoff files, scope checks, files-changed extraction
├── agents/               # builtin agents (override by name in ~/.pi/agent/agents/)
│   ├── scout.md          # fast read-only recon          → openai/gpt-5-nano
│   ├── worker.md         # general implementation       → openai/gpt-5.4-mini
│   ├── planner.md        # implementation plans         → default model
│   └── reviewer.md       # code review                  → default model
└── prompts/              # workflow presets (slash commands)
    ├── implement.md
    ├── scout-and-plan.md
    └── implement-and-review.md
```

## Agents

| Agent      | Purpose                                | Model                 | Profile             | Tools                                  |
| ---------- | -------------------------------------- | --------------------- | ------------------- | -------------------------------------- |
| `scout`    | Fast recon, returns compressed context | `openai/gpt-5-nano`   | `builtin:read-only` | read, grep, find, ls, bash             |
| `worker`   | General-purpose implementation         | `openai/gpt-5.4-mini` | `builtin:worker`    | (all defaults)                         |
| `planner`  | Implementation plans                   | _(pi default)_        | `builtin:read-only` | read, grep, find, ls                   |
| `reviewer` | Code review                            | _(pi default)_        | `builtin:read-only` | read, grep, find, ls, bash (read-only) |

Agents with no `model:` frontmatter inherit your pi default model. To change a
model or prompt, either edit the files here or drop a same-named file into
`~/.pi/agent/agents/` (user agents override builtins). Project-local agents live
in `.pi/agents/` and require `agentScope: "project"` or `"all"` plus a
confirmation prompt.

## Tool reference

One of three modes per call:

| Mode     | Parameters                    | Behavior                             |
| -------- | ----------------------------- | ------------------------------------ |
| Single   | `agent`, `task`               | One worker                           |
| Parallel | `tasks: [{agent, task, ...}]` | Up to 8 tasks, 4 concurrent          |
| Chain    | `chain: [{agent, task, ...}]` | Sequential, `{previous}` placeholder |

Optional per call: `runDir`, `agentScope`, `confirmProjectAgents`.
Optional per task/step (and single): `cwd`, `writes: string[]`, `sessionId`, `label`.

Every result ends with metadata lines the orchestrator uses:

```
session: `1f4e…` — inspect/resume: `pi --session 1f4e…` (from the worker's cwd)
handoff: .pi/orchestration/add-caching/handoff-01-worker-redis-cache.md
files changed (write/edit): src/cache.ts, src/store.ts
⚠ OUT-OF-SCOPE EDITS (...): README.md        ← only when writes was declared
```

## Orchestration skill

For big multi-part goals, load the `orchestrate` skill (`/skill:orchestrate` or
just prompt for it). It drives this loop:

1. Create `.pi/orchestration/<run-name>/`.
2. Write `plan.md` (source of truth) and `progress.md` (task ledger with `writes`
   scopes and dependencies).
3. Dispatch independent tasks in parallel, dependent tasks sequentially.
4. Review each result, then update `progress.md`.
5. Use warm `sessionId` resumes for correction rounds (max 2 per task).
6. Stop when `progress.md` is fully checked off and final verification passes.

You can also drive the same loop manually without the skill; the skill just
encodes the discipline.

## Permission awareness

Workers are spawned as `pi` subprocesses, so they load `pi-guard` and run
under its policy. The packages integrate through two environment variables:

1. **Parent permissions profile.** The extension exports the parent session's
   active profile as `PI_SUBAGENT_PROFILE`, so workers keep the parent's policy
   when a persisted worker session is resumed. An agent's `profile:` frontmatter
   is only the fallback when `pi-guard` is not loaded in the parent.
   - With `pi-guard`, every worker inherits the parent's active profile.
   - Without it, `scout`, `planner`, and `reviewer` fall back to
     `builtin:read-only`; `worker` falls back to `builtin:worker`.

2. **Per-task write-scope enforcement.** When a task declares `writes`, the
   extension exports the entries as comma-separated
   `PI_SUBAGENT_PERMISSIBLE_GLOBS`. `pi-guard` denies `edit`/`write`
   calls, Bash path references, and Bash output redirections outside those scopes. Plain path entries include their
   descendants; glob entries are matched as written. If `writes` is omitted,
   the selected profile's normal write policy applies.

The extension records only paths directly observed in `write`/`edit` tool
calls. Git status and diff snapshots are deliberately not used for attribution:
concurrent panes make repository state ambiguous, and scope enforcement belongs
at the pi-guard tool boundary. Handoffs label these entries as tool-observed.

Write scopes are defense in depth, not a complete process sandbox: commands can
have implicit filesystem effects that contain no path token for the Bash gate
to inspect. Continue reviewing worker diffs. The planned OS sandbox in
`pi-guard` will provide kernel-level containment for subprocess trees.

## Workflow examples

### 1. Quick recon (cheapest win)

Keep the big model's context small by delegating exploration:

```
Use the scout to find everywhere session retry logic lives, and report the key files and functions
```

You get a compressed report; the main context never absorbs the files the scout
read.

### 2. One-off delegation

For a self-contained implementation chunk:

```
Delegate to the worker: add an in-memory LRU cache to src/store.ts following the
pattern in src/cache-utils.ts. Verify with `npm test -- store`.
```

Do it directly instead when the task is trivial — delegation overhead (brief +
ramp-up + your review) exceeds the savings on small work.

### 3. Implement → two independent review gates

The preset `/implement-and-review` runs this, but the manual form shows the
mechanics. A review iteration is one reviewer verdict. A `REQUEST_CHANGES`
verdict resumes the worker to fix the feedback, then resumes that reviewer to
inspect the fix. Each gate has at most five iterations:

1. `subagent { agent: "worker", task: "…" }` → result includes worker session `1f4e…`
2. Start reviewer gate 1:
   `subagent { agent: "reviewer", task: "Review the uncommitted changes for …" }` → reviewer session `9a2b…`
3. For each requested change before gate 1's fifth verdict, resume the worker
   with the feedback verbatim, then resume reviewer `9a2b…` with the worker's
   fix summary. If gate 1 requests changes for the fifth time, stop and report
   `ABORT` with its remaining feedback.
4. Only after gate 1 approves, start reviewer gate 2 with a **new** `reviewer`
   session. Give it the task and worker summary, but not gate 1's review text,
   so it independently inspects the current diff with fresh context.
5. Follow the same worker-resume/reviewer-resume loop for gate 2. If it reaches
   a fifth `REQUEST_CHANGES` verdict, report `ABORT`; otherwise both gates must
   approve before reporting success.

Warm worker and same-gate reviewer resumes retain context, so correction rounds
cost a fraction of fresh sessions. Gate 2 intentionally pays for a fresh
reviewer perspective. Approval always comes from both post-fix reviewer
verdicts, never only from the worker's verification.

### 4. Parallel tasks with write scopes

For independent chunks, one call, up to 4 running concurrently:

```
Run these as parallel subagent tasks with disjoint writes scopes:
- worker: add tests for src/auth/*       writes: ["src/auth", "tests/auth"]
- worker: add tests for src/billing/*    writes: ["src/billing", "tests/billing"]
- scout: map the deploy pipeline         (no writes — read-only)
```

Overlapping `writes` across parallel tasks is how you get merge mush — declare
them and watch for `⚠ OUT-OF-SCOPE EDITS` in results. Once the permission-aware
integration is in place, those edits will be blocked at the tool layer instead
of just flagged.

### 5. Audited run with handoff files

Add `runDir` and every worker leaves a markdown audit trail:

```
subagent {
  tasks: [ ... ],
  runDir: ".pi/orchestration/add-caching"
}
```

`.pi/orchestration/` gets a `*` `.gitignore` automatically. Each `handoff-*.md`
records the task, files changed, session id, duration, cost, and final output —
enough to reconstruct who did what and to resume any worker afterwards.

### 6. Full orchestration loop

Load the `orchestrate` skill and ask it to coordinate, or prompt manually:

```
Goal: split the monolithic settings module into per-domain modules.

1. Write .pi/orchestration/settings-split/plan.md with the goal and approach,
   and progress.md with a task checklist. Each task gets a declared writes scope.
2. Run independent tasks as parallel subagent workers with
   runDir .pi/orchestration/settings-split.
3. As each finishes, review its result (read the diff for risky ones), update
   progress.md, and spawn correction rounds via sessionId resume where needed.
4. Stop when progress.md is fully checked off. Max 2 correction rounds per
   task — after that, report back to me instead of retrying.
```

The plan/progress files are _for you and crash recovery_; the orchestrator gets
results directly from tool results, so don't have it re-read handoff files
unless the session was interrupted.

### 7. Presets

```
/scout-and-plan add Redis caching to the session store     # scout → planner (no changes)
/implement add Redis caching to the session store          # scout → planner → worker
/implement-and-review add input validation to API routes   # worker → two independent review gates (max 5 iterations each)
```

## Cost guidance

- **Delegate chunky, well-specified work.** A worker pays ramp-up (system prompt
  - orienting reads) every fresh session; below a few minutes of equivalent
    main-model work, delegation loses money.
- **Prefer warm resumes over fresh workers** for correction rounds — that's the
  biggest single lever.
- **Review cheaply.** Scan the worker's structured summary + `git diff --stat`;
  only read full diffs for risky tasks, or delegate review to the `reviewer`
  agent.
- **Watch the totals.** Every result shows per-worker turns/tokens/cost and
  parallel/chain modes show aggregate cost. If a worker's cost rivals what the
  main model would have spent, the task was too small or the brief too vague.

## Security notes

- Workers are spawned with `--no-extensions` and an explicit allowlist
  containing only pi-guard, the child runtime, and permitted backing
  extensions. Agent frontmatter cannot broaden that loadout.
- Project-local agents (`.pi/agents/`) are repo-controlled prompts; they're only
  loaded with `agentScope: "project"`/`"all"` and prompt for confirmation by
  default.
- Nested delegation is hard-disabled via `PI_SUBAGENT_DEPTH`, so a compromised
  or confused worker can't fan out more workers.

## Runtime requirements

- `tmux` is required; there is no headless fallback. Start Pi inside tmux,
  for example `tmux new -A -s pi 'pi'`.
- Resumes use the original persisted loadout and cannot widen profile, tool,
  extension, or write-scope permissions.
- Handoffs describe runtime-observed events and do not use Git status or diff
  snapshots for attribution.
