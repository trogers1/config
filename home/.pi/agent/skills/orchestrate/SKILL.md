---
name: orchestrate
description: >-
  Orchestrates a large goal across cheap subagent workers while the main
  session plans, dispatches, reviews, and integrates. Use when a goal
  decomposes into multiple well-specified tasks (multi-module features, broad
  refactors, test backfills) that cheaper models can implement in isolated
  sessions. Not for small or tightly-coupled work — delegation overhead
  exceeds the savings there.
---

# Orchestrate

Use this skill when Taylor asks you to tackle a goal that is too big for one context, explicitly asks to orchestrate/parallelize/delegate, or when you judge a goal decomposes into several self-contained chunks. It runs a plan → dispatch → review → integrate loop where you (the orchestrator, on the big model) coordinate and workers (via the `subagent` tool, on cheaper models) implement.

## When NOT to use this skill

Delegation has real overhead: every worker pays ramp-up (system prompt + orienting reads), and you pay tokens for each brief and each review. Do **not** orchestrate when:

- The whole job is a few files or one focused change — just do it.
- Tasks are tightly coupled (each depends on the previous one's outcome) — do it sequentially yourself or use `/implement`.
- You can't write a self-contained brief for a task yet — scout first, or do the work.

If only part of the goal is chunky, orchestrate that part and do the rest yourself.

## The loop

### 1. Establish the run directory and plan

Pick a run name and create `.pi/orchestration/<run-name>/` (auto-gitignored). Write `plan.md` — the source of truth for the goal:

```markdown
# Plan: <goal in one sentence>

## Approach
Key decisions and constraints (architecture, conventions to follow, what NOT to change).

## Verification
How the whole will be validated at the end (test command, typecheck, build).

## Tasks
See progress.md.
```

If you don't yet know the codebase areas involved, dispatch a `scout` subagent first and base the plan on its report. Keep plan.md stable; if the goal changes materially, update it and note the change in progress.md.

### 2. Write progress.md

The task ledger. One entry per task:

```markdown
# Progress: <run name>

- [ ] T1 — <short title> | agent: worker | writes: ["src/auth", "tests/auth"] | status: pending
- [ ] T2 — <short title> | agent: worker | writes: ["src/billing"] | status: pending
      depends: T1
```

Rules for the task list:
- Each task must be **self-contained and well-specified** — a worker with zero conversation context must be able to execute it.
- Each task declares a **`writes` scope** (path prefixes it may modify). Tasks with overlapping scopes must run sequentially, never in parallel.
- Mark dependencies explicitly. Independent tasks with disjoint scopes are parallel candidates.

Keep progress.md terse — statuses, session ids, one-line outcomes. Do not paste worker output into it; the handoff files hold the detail.

### 3. Dispatch workers

- **Independent tasks**: a single `subagent` call with `tasks: [...]`, each with `writes`, a short `label`, and `runDir: ".pi/orchestration/<run-name>"`.
- **Dependent tasks**: separate single-mode calls as dependencies clear.
- Every brief must stand alone: goal context in 1–2 sentences, exact files/behaviors, conventions, how to verify, and the write scope. Link to plan.md sections by path rather than repeating long text — workers can read files.

Mark tasks `in-progress` in progress.md as they dispatch.

### 4. Review results

Workers report back in their tool result (summary, files changed, session id, cost). The verification ladder, cheapest first:

1. **Summary + metadata** — did it claim completion? Any `⚠ OUT-OF-SCOPE EDITS`? (Violations usually mean a misunderstood brief — inspect before accepting.)
2. **`git diff --stat`** — sane shape and size?
3. **Run the verification** — the task's test/typecheck command, if the worker couldn't or you distrust the claim.
4. **Full diff read** — only for risky or core-path changes.
5. **`reviewer` subagent** — for high-stakes tasks, delegate the review itself.

Do NOT re-read handoff files as a matter of course — the tool result already contains what you need. Handoffs are for Taylor and for crash recovery.

### 5. Handle unsatisfactory work

- **Correction round**: call `subagent` again with the same `sessionId` and a task containing specific, actionable feedback. The worker resumes with full context — cheap and higher-quality than a fresh worker.
- **Max 2 correction rounds per task.** After that, stop and ask Taylor rather than burning more money.
- **Scope violations or confused workers**: inspect the diff, revert if needed (`git checkout -- <paths>`), re-brief more precisely.

Update progress.md after every task completes or blocks: status, session id, one-line outcome.

### 6. Finish

When every task is `done`:

1. Run the whole-run verification from plan.md (full test suite, typecheck).
2. Give Taylor the final report: what changed per task, verification status, total worker cost (sum the `$` figures from results), and the run directory path with handoffs and resumable session ids.
3. Stop. Do not keep polishing without being asked.

## Operational rules

- **Budget vigilance**: if a worker's cost approaches what you'd have spent doing it yourself, the task was too small or the brief too vague — fold remaining small tasks into your own work.
- **Permissions**: each agent starts with a `pi-permissions` profile (`read-only` for `scout`/`planner`/`reviewer`, `worker` for `worker`), and declared `writes` scopes are exported as `PI_SUBAGENT_WRITE_GLOBS` for hard enforcement. Because workers are non-interactive, confirmation-gated (`ask`) commands are **blocked**. If a worker hits a permission wall, either run the command yourself in the main session or broaden the agent/task permissions, then resume the worker via `sessionId`.
- **Parallel bash-edit tracking**: single and chain workers get bash edits via a git-status snapshot; parallel workers sharing a cwd do not (their changes interleave). For parallel work, rely on declared `writes` scopes and the `write`/`edit` tool tracker.
- **Crash recovery**: if the session is interrupted, progress.md + handoff files + session ids are enough to resume: read progress.md, resume any `in-progress` worker via its session id, and continue the loop.
- **Parallelism cap**: stay within the tool's limits (8 tasks, 4 concurrent). More parallel workers than that is queue depth, not speed.
