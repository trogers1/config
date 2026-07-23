# pi-permissions-subagents

Permission-aware subagent delegation for pi. This package bundles the `subagent`
extension and integrates with `pi-permissions`, so worker processes run under an
explicit, auditable permission posture instead of just inheriting the main
session's defaults.

Forked from pi's `examples/extensions/subagent` with additions:

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
  non-conflicting parallel work. `pi-permissions` blocks out-of-scope
  `write`/`edit` calls and Bash path references; results and handoffs retain an
  additional audit check for observed out-of-scope changes.
- **Nested-delegation guard.** Worker processes run with `PI_SUBAGENT_DEPTH=1`;
  the tool refuses to delegate from inside a worker, so costs can't fan out
  recursively.
- **Orchestrate skill.** A companion skill at
  `~/.pi/agent/skills/orchestrate/SKILL.md` drives the full plan.md →
  progress.md → dispatch → review → integrate loop.

## Layout

```
pi-permissions-subagents/
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

| Agent      | Purpose                                | Model                 | Profile     | Tools                                  |
| ---------- | -------------------------------------- | --------------------- | ----------- | -------------------------------------- |
| `scout`    | Fast recon, returns compressed context | `openai/gpt-5-nano`   | `read-only` | read, grep, find, ls, bash             |
| `worker`   | General-purpose implementation         | `openai/gpt-5.4-mini` | `worker`    | (all defaults)                         |
| `planner`  | Implementation plans                   | _(pi default)_        | `read-only` | read, grep, find, ls                   |
| `reviewer` | Code review                            | _(pi default)_        | `read-only` | read, grep, find, ls, bash (read-only) |

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

Workers are spawned as `pi` subprocesses, so they load `pi-permissions` and run
under its policy. The packages integrate through two environment variables:

1. **Per-agent `profile:` frontmatter.** The extension exports the declared
   profile as `PI_SUBAGENT_PROFILE`; `pi-permissions` selects it at session
   start, including when a persisted worker session is resumed.
   - `scout`, `planner`, `reviewer` → `read-only`.
   - `worker` → `worker`, a default-like non-interactive profile where common
     build/test commands are allowed and confirmation-gated actions become
     deny-with-guidance.

2. **Per-task write-scope enforcement.** When a task declares `writes`, the
   extension exports the entries as comma-separated
   `PI_SUBAGENT_WRITE_GLOBS`. `pi-permissions` denies `edit`/`write` calls and
   Bash path references outside those scopes. Plain path entries include their
   descendants; glob entries are matched as written. If `writes` is omitted,
   the selected profile's normal write policy applies.

The extension also audits observed changes. Single and chain workers use both
tool-call extraction and pre/post `git status --short` snapshots, so Bash-based
changes appear in the handoff. Parallel workers sharing a cwd cannot reliably
attribute a git snapshot, but still report `write`/`edit` calls and run under
the hard permission scope.

Write scopes are defense in depth, not a complete process sandbox: commands can
have implicit filesystem effects that contain no path token for the Bash gate
to inspect. Continue reviewing worker diffs. The planned OS sandbox in
`pi-permissions` will provide kernel-level containment for subprocess trees.

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

### 3. Implement → review → warm-resume fix

The preset `/implement-and-review` runs this, but the manual form shows the
mechanics:

1. `subagent { agent: "worker", task: "…" }` → result includes `session: 1f4e…`
2. `subagent { agent: "reviewer", task: "Review the uncommitted changes for …" }`
3. If changes requested:
   `subagent { agent: "worker", sessionId: "1f4e…", task: "Apply this review feedback verbatim: …" }`

Step 3 resumes the _same_ worker session — it already knows the files and its
own rationale, so the fix round costs a fraction of a fresh worker and produces
better fixes.

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
/implement-and-review add input validation to API routes   # worker → reviewer → worker (warm resume)
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

- Workers are spawned as `pi` subprocesses that **inherit your full extension
  set** and auth. Agent frontmatter changes model/tools/system prompt and may
  select a named `pi-permissions` profile; it cannot define arbitrary policy.
- Project-local agents (`.pi/agents/`) are repo-controlled prompts; they're only
  loaded with `agentScope: "project"`/`"all"` and prompt for confirmation by
  default.
- Nested delegation is hard-disabled via `PI_SUBAGENT_DEPTH`, so a compromised
  or confused worker can't fan out more workers.

## Limitations

- For single and chain workers, bash-based file changes are detected via a
  pre/post `git status --short` snapshot. For parallel workers sharing a cwd,
  git snapshots are disabled because concurrent workers' changes interleave and
  can't be reliably attributed to individual workers; parallel workers still
  report `write`/`edit` changes and are subject to `writes` scope enforcement.
- `--session <id>` resume works from the worker's project directory (sessions
  are per-cwd).
- Parallel output returned to the model is capped at 50 KB per task; full output
  lives in the handoff file and worker session.
- Live watching of a worker mid-flight is via the streaming TUI view only; you
  can't attach to a running worker's session, but Ctrl+C propagates to kill the
  worker subprocess.
