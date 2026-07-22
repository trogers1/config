---
description: Worker implements, reviewer reviews, worker applies feedback via warm session resume
---
Execute this workflow as THREE SEPARATE subagent tool calls (not a chain), so the fix round resumes the original worker's session with its context intact:

1. Call subagent with agent "worker" to implement: $@
   Note the `session: <id>` line in the result.
2. Call subagent with agent "reviewer" to review the worker's changes (task: review the recent uncommitted changes for the work described as "$@", including the worker's summary).
3. If the review verdict is REQUEST_CHANGES, call subagent with agent "worker" AND the sessionId from step 1, with a task containing the review feedback verbatim, so the same worker session applies the fixes with full context.
   If the verdict is APPROVE, stop.

Report the final outcome, including cost: the session resume in step 3 reuses the worker's warm context instead of paying a fresh ramp-up.
