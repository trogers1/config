---
name: review-policy
description: >-
  Governs code-review delegation, independent parallel reviewers, finding
  reconciliation, and review completion. Use before requesting reviewer
  subagents, including focused fixes, reviews during implementation, and
  comprehensive branch reviews. Does not require HTML review artifacts or
  a multi-worker implementation workflow.
---

# Review policy

This is the shared review policy for routine implementation reviews,
`orchestrate`, and `flow-review`. It governs the parent coordinating the review;
each reviewer remains responsible for independently inspecting the change.

## Two independent parallel reviewers

By default, delegate each review to **two independent, read-only reviewer
agents running in parallel** over the same frozen change set, acceptance
criteria, and comparison baseline. Give both the same repository instructions
and review constraints. Complementary emphasis is useful, but neither reviewer
should be excluded from inspecting the full review scope.

Identify the reviewed version with a commit or captured working-tree diff. If
that version changes during review, disclose the change and have both reviewers
inspect the affected final changes before closing the review. Repeated reports,
resumes, or approvals from one reviewer do not constitute two independent reviews.
If two reviewers are unavailable, report that limitation and ask before
substituting a single review.

Reviewers do not edit the implementation or shared review artifacts. The parent
owns integration and artifacts such as `flow.json` and `flow.html`, when requested.
An ordinary review does not require those artifacts or an orchestration ledger.

## Reconcile findings before correcting them

Collect both independent reports before sharing findings for reconciliation.
Have each reviewer assess findings raised only by the other, using concrete code
paths and evidence. Implement a review-requested change **only when both reviewers
explicitly agree on the finding and the proposed correction**, and the change is
within the user's authorized scope. Silence, omission, or matching severity labels
are not agreement.

Keep corrections targeted; agreement on a defect does not authorize unrelated
refactoring or additional features. Review consensus alone does not authorize
implementation during a review-only request or bypass human approval gates.

If reviewers disagree or cannot agree on a correction, present the finding,
evidence, and disagreement to Taylor; do not implement it unilaterally. Report
agreed findings and unresolved disagreements separately.

## Verify and close against the final version

Verify authorized, agreed corrections with the relevant bounded checks. Have both
reviewers inspect the corrections against the final version before marking their
findings resolved. Confirm reports refer to current code rather than a cached or
superseded diff; a stale approval does not cover subsequent changes.

The final report should distinguish review findings, unresolved disagreements,
and verification results. State who ran the checks and which checks were not run;
inspection-only reviewer approval is not independent test execution. Do not
represent one reviewer's repeated completion notifications as additional review
coverage.
