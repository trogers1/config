---
name: flow-review
description: >-
  Review the current branch comprehensively and explain its changes through a
  conversational, theme-led HTML review with concrete examples and optional deep dives.
---


I like comprehensive, behavioral testing that is as production-like as possible. I also like implementation to be as simple, extremely typesafe, config-derived and obvious as possible. Any hard-coding, redefining, or type casting are red-flags. So:

- Typecasting outside of a typebox validation function (or similar) IS A RED FLAG
- Hard coded values that exist elsewhere ARE RED FLAGS
- Functions returning `undefined` or using `continue` instead of throwing errors IS A RED FLAG

WITH THAT IN MIND, please review the testing and implementation of the current branch to meet the provided AC. Assume you are reviewing it compared to the remote `staging` branch unless otherwise specified.

## Shared review policy

Before delegating review, read and follow `../review-policy/SKILL.md` for reviewer
independence, parallel dispatch, finding reconciliation, correction authorization,
and final acceptance. This skill adds the explanatory review and artifact workflow
below; it does not define a separate reviewer policy.

## Jira information

When given a Jira ticket key or URL, read the ticket with the read-only `jira-ticket` CLI, and treat its AC section as the acceptance criteria for the review:

```sh
jira-ticket get <KEY>
```

The description comes back as Atlassian Document Format JSON. Pipe it through `jq -r '.. | objects | select(.type=="text") | .text'` to get readable text. Never use `jira-ticket update` or `create`. If the CLI fails, run `jira-ticket doctor` and tell the user, rather than falling back to the MR description silently. Fetching the ticket counts as inspecting the change, so it may come before `flow.json`. In the review's deep-dive sections, map each AC item to its status (met, not met, or partial) and to the code or test that covers it.

## GitLab merge requests

When given a GitLab MR URL, use the `address-comments` skill scripts (installed at `~/.agents/skills/address-comments/scripts`) for all GitLab access. Do not run `glab` or other GitLab CLI commands directly, and never post anything: posting belongs to the `post-mr-replies` skill after Taylor approves it. Without an MR URL, skip this section.

### Read existing review comments first

Before reviewing, export every human discussion on the MR to a scratch file and read it, so the review builds on what reviewers already said instead of repeating it. This counts as inspecting the change, so it may come before `flow.json`:

```sh
bash ~/.agents/skills/address-comments/scripts/refresh-all-comments-md.sh <mr-url> <scratch-dir>/mr-comments.md
```

Never point a refresh at the repository's `comments.md`: a refresh rewrites the whole file and drops Taylor's Robot notes, Reply blocks, and Thread blocks. When a finding is already raised in an existing discussion, say so in the review and link the thread rather than reporting it as new.

### Draft findings as new threads

Use `discuss-mr-comments` after the review to discuss draft findings one at a
time with Taylor, inspect supporting snippets, refine wording, and record his
explicit local approval before the separate posting workflow.

After the review, draft each finding Taylor might want on the MR as a `Thread — DRAFT` block in the repository's `comments.md`, so `post-mr-replies` can post the ones he approves. Like the Reply drafts produced by `address-comments`, these are outbound drafts, not local Robot notes or approval. Read `post-mr-replies` for the canonical block syntax and approval rules:

- If `comments.md` does not exist, create it with `refresh-all-comments-md.sh <mr-url> comments.md`. If it exists, check that its `Merge request:` line is this MR and edit it in place; stop and ask if the identity is missing or for another MR. Preserve reviewer text, Robot notes, Reply blocks, unrelated drafts, approvals, and posted history. Revise an existing DRAFT for the same finding instead of duplicating it; do not overwrite approved or posted text.
- Put every draft under the file's single `## New threads` heading (add it at the end if missing). Use `**Thread — DRAFT** positional <path> L<start>-L<end>` for findings on specific lines, with new-side line numbers of added or unchanged lines in the MR's diff (`L12-L12` for one line), and `**Thread — DRAFT** general` for broader findings. Separate blocks with a bare `---` line.
- Write each body for the MR author: standalone, in GitLab Markdown, with no Robot framing and no local-only links.
- Take line numbers from the MR's diff, and confirm the local branch matches the MR's latest pushed commit; otherwise use `general` drafts that name the file and line in the body. Anchors are checked against the live diff only when an approved block is previewed.
- Only draft; never mark a block `APPROVED`. Run `bash ~/.agents/skills/address-comments/scripts/preview-replies.sh <mr-url> comments.md` to confirm the file still parses, and list the drafts you added in the final response.

## First understand the story, then review the details

Inspect the complete branch diff against the selected baseline (normally remote
`staging`), plus enough surrounding source to understand its consequences. Do not
limit the review to the latest commit. Before evaluating findings, create an
initial `flow.json` at the repository root as a working explanation. It is expected
to evolve: update it as the independent reviews establish facts, gaps, and findings.
Do not present unverified assumptions as conclusions or tests as passed before running them.

**Explain the change before mapping the system.** Write for a developer who knows
programming but is unfamiliar with this change. Comprehensive inspection does not
require a comprehensive walkthrough. Never make the explanation more elaborate
than the change. Many changed files may implement one simple idea.

### Use conversational, casual language throughout

Write like a helpful teammate talking through the change, not a formal technical
report. This applies to the whole review: titles, summaries, theme and example
explanations, findings, diagram labels, and deep dives—not just the opening.
Prefer everyday words, short sentences, and concrete descriptions of what happens.
Avoid jargon, dense noun phrases, and abstract architecture language when a plain
explanation would be just as accurate. Casual does not mean vague: name the actual
behavior, evidence, and consequences.

Use specialized terminology or more sophisticated language when a highly specific
technical detail needs it for accuracy. Explain unfamiliar terms in plain language
when first used, and keep the surrounding explanation conversational. Preserve
exact code symbols and established domain terms where precision matters; do not
replace them with misleading simplifications.

For example, prefer “The caller now checks the input before saving it” over
“Validation responsibility is relocated to the persistence boundary.” Before
finishing, reread the prose and simplify anything that sounds more complicated
than the behavior it describes.

### Start with a conversational narrative

The first screen should explain, without requiring clicks:

- What this change is really about and why it is needed.
- Where it fits in the existing system: who calls the affected code, who consumes
  its results, and which boundaries matter to understanding the change.
- What observably changes and what stays the same (only where verified).
- How the main edits connect into one coherent story.

Use specific, ordinary language. Prefer “Stop rounding production results; compare
floats tolerantly in tests” over “Numeric normalization pipeline refactoring.”
Separate confirmed behavior from inferred motivation. Explain unfamiliar domain
terms before introducing implementation symbols.

### Organize around change themes, not layers or files

Give each theme an informative title, a short explanation, and concrete evidence.
Do not force themes into validation/business-logic/persistence buckets. Explain
why related edits belong together, not just what each file does.

The `themes` array is the intended reading order. Arrange it as a coherent story:
context and purpose first, then the main behavior, its supporting mechanisms,
verification and any separate supporting work. These are editorial topics, not
execution steps. Do not mix an unrelated fix into a theme merely because it shares
files. Introduce each theme's relationship to what came before. The renderer numbers
the themes and provides previous/next navigation; diagram arrows are not a tour
through those numbered themes and need not cover every theme.

For each theme:

1. Explain the idea and its observable consequence in conversational language.
2. Give every example a required `explanation` describing what the code changes
   and why it belongs to this theme. This is visible beside the collapsed code;
   a title alone is not enough. Explain the affected input, transformation or
   consequence, without requiring the reader to expand the sample.
3. Show an actual before/after excerpt, or a focused addition or deletion, taken
   from the inspected baseline and branch. Include enough surrounding code to
   orient the reader: normally the enclosing function signature and 3–8 relevant
   context lines showing inputs, callers, validation or the returned result.
   Prefer a complete small function to an isolated expression. Roughly 15–35 lines
   is often useful; do not turn that into a quota or paste unrelated class bodies.
   Preserve unchanged lines on both sides of a diff so they appear as context,
   not green additions. Use `code` for current context when its baseline change
   has not been verified. Mark pseudocode omissions explicitly.
4. Include source paths and revision/line references so readers can verify it.
   Update line ranges when expanding an excerpt; never invent surrounding code.
5. For large implementations use explicitly labeled pseudocode, not a wall of code.
   Never present invented code as an actual excerpt. Illustrative inputs and outputs
   must also be labeled, and should demonstrate the behavioral difference.

For a simple float-comparison change, two themes may be enough: removing production
rounding and introducing significant-figure comparisons in tests. A representative
deleted rounding call, the significant part of the real comparison helper, and one
changed assertion may explain the entire change. Do not invent an architecture
walkthrough or diagram to make that review look more substantial.

### Progressive depth, not mandatory ceremony

Keep the overview, theme explanations and individual example explanations visible;
collapse only the code and deeper breakdowns. Every `sections` entry requires a
short `summary` visible outside its expandable full `explanation`. File coverage
and verification also have visible previews. Readers should understand the point
of every expandable section before deciding whether to open it. Simple changes should
produce short documents. Complex changes may need boundary, data-model, failure-path,
and state-transition explanations. Include those where relevant, not as empty
mandatory headings. Important risks and unresolved disagreements must not be buried
in collapsed architecture appendices; surface their significance in the narrative.

Review data models, schemas, inputs, outputs, configuration and transformations as
carefully as execution paths, even when their explanation fits in one sentence.
Explain meaningful test changes and gaps alongside the behavior they concern.
Put AC mapping, detailed test coverage, verification results and supplementary
execution traces in the deep dive when they would otherwise interrupt the story.
Distinguish agreed findings, unresolved reviewer disagreements, and checks not run.

### Optional diagrams: explain the delta

Include a compact visual orientation when it helps readers locate the change in
the surrounding flow. Prefer a small before/after pair for a removed or bypassed
step. Even simple changes can benefit from that visual; omit it only when it adds
no useful context. Keep diagrams subordinate to the conversational story, not a
replacement for it. Use the renderer's structured nodes and edges; do not embed
Mermaid, HTML, SVG or JavaScript in review data.

- Label each node ADDED, MODIFIED, REMOVED or UNCHANGED. Status must remain clear
  without color. Unchanged nodes provide only the context necessary for the story.
- Use removed nodes only in clearly described before/comparison diagrams, never
  imply deleted behavior still executes in the new path. Separate before/after
  diagrams are often clearer than an overloaded combined diagram.
- Set `status` on changed edges as well as nodes. Added paths are green, modified
  paths amber, removed paths red/dashed, and unchanged context muted. Edges with
  no status default to unchanged; do not infer edge status from endpoint status.
  The renderer includes status labels and a legend, not color alone.
- Connect changed nodes to example IDs so selecting a node opens its evidence in
  a dialog without losing the reader's place. Each linked box identifies the
  example's numbered theme. Explain that these are optional cross-references,
  not a sequence for reading the document; some themes may not appear in the graph.
  Large changes may link to explicitly labeled pseudocode rather than full code.
- Keep graphs small. Label edges and explain what the diagram is showing. Do not
  map the entire ecosystem merely because the branch touches part of it.

### Coverage is an appendix, not the narrative

Represent every relevant changed file in `coverage`, individually or in an
explicitly named group of paths. Explain its responsibility briefly; call out
renames and deletions. Generated files may share an entry. Compare the coverage
list with the full branch diff before finishing: the renderer validates shape and
references, but cannot establish whether coverage or claims match the repository.
Do not require per-file pseudocode or repeat theme explanations in this inventory.

## Canonical data and generated HTML

`flow.json` is the single agent-editable source of truth. `flow.html` is its
human-facing companion. There is no separately maintained `flow.md`. Do not edit
the HTML manually or generate a custom application for each review.

Read the authoritative schema and the illustrative example before writing data:

- `scripts/schema.ts` — authoritative TypeBox definitions; runtime types and validation
  derive from these. `scripts/flow.schema.json` is the generated agent-readable copy.
- `examples/float-comparisons.flow.json` — fictional, explicitly labeled example
  showing a proportional narrative; not evidence from a real MR.

Use the exact schema rather than copying an assumed shape from memory. Older review JSON may
need authored example explanations and deep-dive summaries before regeneration;
do not synthesize empty placeholders just to pass validation. Narrative
fields are plain text with preserved whitespace, not Markdown or HTML. Put code in
example fields. Set each example's `language` (for example `typescript`, `python`,
`json`, or `bash`) for highlight.js syntax coloring; omit it for plain text.
Highlighting happens during generation and works offline and without browser JS.
Unsupported language names fail explicitly. Mark pseudocode separately even when
using a language grammar for its coloring. Provide `before` and `after` snippets
for a unified code diff with red deletions, green additions, and stronger word-level
change emphasis. A lone `before` is a deletion; a lone `after` is an addition. Use
`code` for unchanged explanatory code. Do not manually add diff prefixes to snippets.
Source paths and revision/line references are displayed as evidence
labels, not browser links; the relevant snippets are embedded in the page. Stable
theme/example IDs connect navigation and diagrams. Use `sections` for optional deep
dives and AC mapping. Record findings as `agreed` or `disputed` and keep verification
status explicit (`passed`, `failed`, or `not-run`).

### Use the installed tool; do not bootstrap it during a review

This skill's private TypeScript package is a shared, preinstalled tool—not a
package in the reviewed repository or worktree. A normal review must not run
`npm ci`, `npm install`, or a build in the skill directory. Do not switch profiles
or request elevated permissions to bootstrap it. `npm ci` replaces the shared
`node_modules` directory and can disrupt other worktrees using the same tool.

Run the installed renderer directly by absolute skill path so input/output remain
in the reviewed repository. A different worktree does not need its own installation:

```sh
node ~/.agents/skills/flow-review/dist/scripts/render_flow_html.js flow.json flow.html
```

If the command reports a missing build, missing dependency, or another installation
problem, stop artifact generation and report the exact error to Taylor. Do not
attempt an automatic repair, retry as root/Administrator, or install dependencies
in the reviewed application. Installation and rebuilds belong to an explicitly
authorized config-maintenance task; see this package's `README.md` for that workflow.
Do not edit compiled JavaScript. Source changes require a maintenance rebuild.

Validate without generating HTML with:

```sh
node ~/.agents/skills/flow-review/dist/scripts/render_flow_html.js --validate flow.json
```

The renderer fails on malformed data and dangling references. Generation and the
resulting page work offline, without CDN dependencies. The page includes the prose
and code evidence, not just links that require local source browsing. Native
expandable sections and anchor links provide a readable no-JavaScript fallback;
JavaScript enhances evidence navigation. Keep both artifacts at the repository
root, regenerate after material changes, and mention both in the final response.
Old `flow.md` artifacts are not authoritative; do not silently reuse them as current
review evidence. Do not delete unrelated or user-authored files during migration.
