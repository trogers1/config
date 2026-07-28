---
description: Worker implements, then passes two independent five-iteration review gates
---

Execute this workflow with SEPARATE subagent tool calls (not a chain). It has two sequential, independent reviewer gates. A review iteration is one reviewer verdict; on `REQUEST_CHANGES`, the worker fixes the feedback before the next iteration. Each gate allows at most FIVE iterations.

1. Call subagent with agent "worker" to implement: $@
   Note the worker's `session: <id>` line and summary from the result.
2. **Reviewer gate 1:** Call subagent with agent "reviewer" to review the worker's recent uncommitted changes for the work described as "$@", including the worker's summary. Note this reviewer's `session: <id>` and verdict.
3. If gate 1 returns `REQUEST_CHANGES` before its fifth iteration:
   a. Resume the original worker session. Include the reviewer feedback verbatim, have it apply the fixes, and capture its new summary.
   b. Resume the gate-1 reviewer session. Ask it to re-review the updated uncommitted changes, including the worker's fix summary, and return `APPROVE` or `REQUEST_CHANGES`.
   c. Repeat 3a–3b until it returns `APPROVE` or has issued five verdicts.
4. If gate 1 still returns `REQUEST_CHANGES` on its fifth verdict, stop immediately. Do not start gate 2 or apply another fix. Report `ABORT`: gate 1 did not approve within five iterations, along with its remaining feedback.
5. **Reviewer gate 2 (fresh eyes):** Only after gate 1 approves, call subagent with agent "reviewer" in a NEW session — do not pass or resume gate 1's sessionId. Give it the task description, current worker summary, and the fact that gate 1 approved, but not gate 1's reasoning or verdict text. It must independently review the current uncommitted changes. Note this second reviewer's `session: <id>` and verdict.
6. If gate 2 returns `REQUEST_CHANGES` before its fifth iteration, resume the original worker with its feedback verbatim, capture the fix summary, then resume the gate-2 reviewer to re-review. Repeat until gate 2 returns `APPROVE` or has issued five verdicts.
7. If gate 2 still returns `REQUEST_CHANGES` on its fifth verdict, stop without another fix. Report `ABORT`: gate 2 did not approve within five iterations, along with its remaining feedback. Only report overall `APPROVE` when both gates approve.

Every requested fix must receive a re-review from the reviewer that requested it; never infer approval from worker verification. Report both gate verdicts and the final outcome. Include cost context: worker and same-gate reviewer resumes avoid fresh ramp-up; gate 2 intentionally pays for a fresh reviewer context. Report numeric cost when the tool provides it.
