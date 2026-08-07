---
name: code-review
description: >-
  Review the current branch with a through, thoughtful, comprehensive code review.
---


I like comprehensive, behavioral testing that is as production-like as possible. I also like implementation to be as simple, extremely typesafe, config-derived and obvious as possible. Any hard-coding, redefining, or type casting are red-flags. So:

- Typecasting outside of a typebox validation function (or similar) IS A RED FLAG
- Hard coded values that exist elsewhere ARE RED FLAGS
- Functions returning `undefined` or using `continue` instead of throwing errors IS A RED FLAG

WITH THAT IN MIND, please review the testing and implementation of the current branch to meet the provided AC. Assume you are reviewing it compared to the remote `staging` branch unless otherwise specified.

## Required first step: map the branch flow

Before evaluating the implementation, looking for findings, or writing the review, first create or replace `flow.md` at the repository root. The only review work that should precede it is identifying the comparison branch and inspecting the diff and source needed to understand and write the artifact. Build it from the complete branch diff against the selected comparison branch (normally remote `staging`), not just the latest commit.

Treat `flow.md` as the working map for the subsequent review: use it to trace behavior, identify affected boundaries, and guide test and implementation analysis. Update it if the review reveals that the initial flow map was incomplete or inaccurate. This artifact is required even when the review has no findings.

Write `flow.md` for a developer who is unfamiliar with the change. It must include:

1. **Overview** — the purpose of the branch and the user-visible or system-visible behavior it changes.
2. **Changed-file map** — group relevant changed files by responsibility. For each file, explain what changed, why it participates in the feature, and give concise pseudocode for its new or modified behavior. Call out deleted and renamed files. Generated files may be summarized as a group.
3. **End-to-end code flow** — trace each important execution path from its entry point through validation, business logic, persistence or external calls, and returned result or side effects. Include alternate and failure paths when meaningful.
4. **Data and state flow** — describe important inputs, outputs, type transformations, state transitions, configuration, schemas, migrations, and external boundaries.
5. **Test flow** — map tests to the behaviors and paths they exercise, including important gaps discovered during review.

Use concrete symbol and file names, links such as ``[`path/to/file.ts`](path/to/file.ts)``, and readable pseudocode rather than copying implementation. Add Mermaid diagrams when they make a non-trivial interaction or state transition easier to understand. Keep the document branch-specific and omit unrelated pre-existing architecture.

Use mermaid diagrams liberally to help illustrate code-flow (both of the entire change set and for complicated subsystems within it). A combination of pseudo-code and diagrams (with links to actual implementation) is very helpful when reviewing and understanding.

Before completing the review, verify that every relevant file in the branch diff is represented in `flow.md` either individually or in an explicitly named group, and mention in the final response that `flow.md` was written.
