# Refactor the profile rule wizard around policy effects

## Goal

Make profile changes truthful, obvious, and fast:

- An ASK caused by `readPaths` saves a read rule.
- An ASK caused by `writePaths` saves a write rule.
- `protectedPathRules` remain a separate, cross-cutting safeguard layer.
- The user sees **which profile, rule collection, context, pattern, and effective
  decision will change before anything is written**.
- The common ASK flow is one choice followed by one prefilled save screen.
- CREATE and ASK use the same rule-row model, rendering, validation, and batch
  persistence rather than similar but independent components.

A saved allow must resolve the operation which opened the ASK. A protected-path
allow must never be presented as permission to read or write.

## Current-state findings

The refactor starts from several important implementation facts:

1. Direct path tools are evaluated against the correct ordinary collection and
   context, but their ASK callback currently constructs a `kind: "protected"`
   draft. The resulting allow often leaves the original ASK unresolved; a deny
   is broader than requested because it blocks both reads and writes through the
   protected layer.
2. Bash path policy is deliberately conservative today. Almost every concrete
   Bash filesystem reference uses `writePaths` with context `bash`; `cd` is the
   notable exception and uses `readPaths` with context `ls`. The current shell
   classifier does **not** reliably classify arbitrary Bash operands as reads
   versus writes.
3. `rememberRule()` re-runs Bash path analysis and retains at most one path
   trace. This can drift from the evaluation that opened the prompt and cannot
   represent several unresolved path references.
4. CREATE and ASK duplicate most of the Bash editor. The protected-path form is
   partially shared, but CREATE wraps it in a mandatory add/continue loop.
5. ASK writes rules one at a time. A multi-rule update can therefore create a
   child profile or save a Bash rule before a later path editor is cancelled.
6. `appendProfileRule()` already routes `read` and `write` to the correct arrays,
   but replacement is pattern-only and can destroy a same-pattern rule for a
   different context.
7. CREATE can atomically write Bash and protected rules, but cannot yet accept
   read and write rule collections.
8. The current non-Bash permission modal and README describe ordinary path ASKs
   as protected-path requests. `profileUpdateTargets` and the harness target
   picker are obsolete; production already derives the intended target.

## Product decisions

### Keep the three policy layers explicit

Use these user-facing meanings consistently:

| Layer | Configuration | Meaning |
| --- | --- | --- |
| Read permission | `readPaths` | Governs concrete read operations in contexts such as `read`, `grep`, `find`, and `ls`. |
| Write permission | `writePaths` | Governs concrete mutation-capable operations in contexts such as `edit`, `write`, and conservative Bash filesystem access. |
| Protected safeguard | `protectedPathRules` | Runs before ordinary policy. A deny blocks both reads and writes. An allow is only an exception to another protected deny; it grants no ordinary permission. |

Protected safeguards are authored only from an explicitly labelled safeguards
section in CREATE/profile management. They are never offered as the resolution
to an ordinary ASK.

### Preserve current Bash path semantics in this refactor

Do not silently introduce a read/write shell classifier as part of a UI change.
The editor must display the ordinary kind and context that enforcement actually
used:

- ordinary Bash references: **write path**, context `bash`;
- `cd`: **read path**, context `ls`;
- direct tools: read/write kind plus the concrete tool context.

A future shell-classification project may make narrower distinctions, but it
needs its own policy design, migration, and tests. Replace references to a
“Bash read operand” in this plan with assertions against the evaluation's real
kind/context.

### Derive the editor from the evaluation; never ask for a target

The gate that produces an ASK must also produce an ordered list of authorable
rule changes. The UI must not re-analyze the command and must not ask the user
whether this is a Bash, read, write, or protected rule.

```ts
type OrdinaryPathRuleKind = "read" | "write";
type ProfilePathRuleKind = OrdinaryPathRuleKind | "protected";
type RuleKind = "bash" | ProfilePathRuleKind;

type AskRuleCandidate =
  | {
      kind: "bash";
      requestedValue: string;
      initialPattern: string;
      currentDecision: "ask";
      matchedRule?: RuleSource;
    }
  | {
      kind: OrdinaryPathRuleKind;
      context: PathContext;
      requestedValue: string;       // immutable concrete path shown to user
      initialPattern: string;       // editable, display-relative when possible
      currentDecision: "ask";
      matchedRule?: RuleSource;
      source: { tool: string; role?: string };
    };

type AskResolution = {
  candidates: readonly AskRuleCandidate[];
  requestSummary: string;
};
```

Only concrete, attributable ASKs become candidates. Parse uncertainty, dynamic
paths, opaque expressions, or unknown CWD cases that cannot be represented by
an accurate rule remain allow-once/deny prompts; the UI must not invent a glob
for them.

### One prompt for one Bash request

`evaluateBashGate()` already computes path and command decisions. After all
non-overridable denies and validation errors are handled, collect all remaining
ordinary path and Bash ASKs and present one permission prompt for the request.
Do not prompt once for a path and then again for the command.

For multiple authorable path references:

- retain encounter order;
- deduplicate only identical `(kind, context, requested path)` candidates;
- include every unresolved candidate needed to make the request prompt-free;
- preserve separate candidates when the same pattern is used in distinct
  contexts.

This gives these scopes without a target picker:

| Outstanding authorable decisions | Save screen |
| --- | --- |
| Bash only | Bash rows |
| read path only | Read-path row(s) |
| write path only | Write-path row(s) |
| Bash + path | One screen containing both sections |
| several paths/commands | One ordered, atomic change set |

## ASK UX

### Permission choice

Use contextual choices:

1. `No (default)` — reject this request; optional transient steering remains
   available.
2. `Allow once` — approve this request without changing the profile.
3. `Save rule(s) to profile…` — open the prefilled change screen.

The third choice's description should name the actual effect, for example:

- `Save a read-path rule for this read request.`
- `Save a write-path rule for config.json.`
- `Save 1 Bash rule and 2 write-path rules.`

For non-authorable uncertainty, omit/disable the save choice and explain why.
Rename the non-Bash modal from “Protected path permission request” to the actual
operation, such as “Read path permission request” or “Write path permission
request.”

### The change screen is also the review screen

Do not add a second generic confirmation modal after editing. The editor itself
must render a live semantic diff, and Enter must be labelled
`save and re-check request`.
This keeps the exact-path happy path to:

1. choose `Save rule(s) to profile…`;
2. press Enter.

All request-derived ASK rows start as `allow`, because the user already chose
the save flow for an ASK they want to resolve quickly. Tab cycles
`allow`/`deny`/`skip`; deny exposes inline persistent steering. A skipped row is
shown as `unchanged; remains ASK` and is omitted from persistence. This lets a
user intentionally keep asking for one command while resolving other candidates
from the same request.

Enter is disabled when every row is skipped, because writing no changes and
immediately re-prompting would create a loop. After at least one change is
saved, reload the profile and re-evaluate the pending request. If skipped ASKs
remain, reopen the prompt with only the still-unresolved candidates.

Example rendering:

```text
Resolve ASK · 2 profile changes
Target  work-custom (existing custom profile)
Request bash: printf ok > config.json

✏️ WRITE PATH · context: bash · source: Bash redirection target
Requested path   /repo/config.json
Matched rule     **  → ASK  (builtin:default)
Rule pattern     > config.json
Effective change ASK → ✅ ALLOW
Writes to        profiles.work-custom.writePaths
Effect           Allows Bash access to this path; does not allow read-tool access.

⚙️ BASH COMMAND
Requested value  printf ok > config.json
Rule pattern     > printf ok > config.json
Effective change ASK → ✅ ALLOW
Writes to        profiles.work-custom.tools.bash

Enter save 2 rules and re-check request · Tab allow/deny/skip · Esc back
```

A deny row shows its persisted guidance and effect directly:

```text
✏️ WRITE PATH · context: write · source: write tool
Requested path   /repo/generated/schema.ts
Matched rule     generated/** → ASK
Rule pattern     > generated/**
Effective change ASK → ⛔ DENY
Guidance         > Regenerate this file with npm run generate-schema.
Writes to        profiles.work.writePaths
Effect           Denies write-tool access in this context; reads are unaffected.

Enter save and re-check request · Tab allow/deny/skip · Esc back
```

After save and re-evaluation, the request is rejected by the newly persisted
deny and returns that guidance.

The requested concrete path/value is immutable and visually distinct from the
editable pattern. If the pattern differs from the exact prefill, show an
immediate warning such as:

```text
⚠ Broader/custom pattern: this rule may affect paths beyond this request.
```

Do not claim that a simple lexical glob check proves the complete affected set.
Use these four labels consistently and map each one to its real destination:

| UI label | Configuration destination |
| --- | --- |
| `⚙️ BASH COMMAND` | `tools.bash` |
| `📖 READ PATH` | `readPaths` |
| `✏️ WRITE PATH` | `writePaths` |
| `🛡️ PROTECTED SAFEGUARD` | `protectedPathRules` (the current “protected paths” feature) |

`PROTECTED SAFEGUARD` appears only in CREATE/profile management; it is not a
resolution target for an ordinary ASK.

The important visual signals are:

- one of the four layer labels above;
- operation context/source;
- immutable requested value;
- editable saved pattern;
- `ASK → ALLOW/DENY` in status colors;
- exact destination collection;
- one-sentence effect and, where useful, a non-effect;
- whether the target profile already exists or will be created.

Reset restores exact initial patterns and default `allow` decisions for
request-derived rows and removes unsaved additional rows. Esc is **Back**, not
destructive cancellation: it returns to the permission choice while retaining
the draft for this pending tool call. Choosing `No` or an explicit discard then
abandons the draft without writing. Validation or persistence failure keeps the
editor and complete draft open with an inline error/notification.

### Updating a shipped/composed profile

Only user-owned profiles are mutable. When the active profile is not mutable,
the same screen must show:

```text
Target  default-custom (new custom profile)
Extends builtin:default
```

Generate a valid, collision-free suggested name before opening the screen. Make
it editable inline, but do not require a separate naming dialog when the user
accepts the suggestion. The child profile and all selected rules are created in
one validated atomic mutation only after Enter. Activate it only after the
write and reload succeed.

If the active profile is user-owned, mutate it directly and label it
`existing custom profile`.

### Re-evaluate after save

Do not infer approval from the editor selections. After atomically saving the
non-skipped changes, reload the saved profile and pass the same pending request
through the pure gate evaluation again. Re-evaluate; do not execute the tool a
second time.

- Effective allow: continue the current request.
- Effective deny: reject with the winning persisted rule's guidance.
- Effective ASK: prompt again with only the still-unresolved candidates.
- A normal `No` may collect transient steering, but that text is not persisted.
- Back, discard, or validation failure changes no config and does not activate a
  profile.

A decisive protected, ordinary-path, or Bash deny suppresses the ASK UI. Gates
must complete deny/validation evaluation before collecting ASK candidates, both
before editing and during post-save re-evaluation.

## Shared CREATE UX

### Use one production-owned rule editor

Replace the separate creation Bash editor, inline ASK Bash editor, and
single-rule protected form with one configurable editor/model. Keep types,
labels, decision cycles, validation, and effect copy in a production module
(for example `modules/profileRuleEditor.ts`) so the harness does not duplicate
UI strings.

```ts
type EditableRuleRow = {
  id: string;
  kind: RuleKind;
  pattern: string;
  decision: "allow" | "deny" | "skip"; // skip is ASK-draft-only
  guidance?: string;
  contexts?: readonly PathContext[];
  request?: AskRuleCandidate; // present only on evaluation-derived ASK rows
  origin: "request" | "additional" | "create";
};

type RuleEditorOptions = {
  mode: "ask" | "create";
  rows: readonly EditableRuleRow[];
  allowAddRemove: boolean;
  defaultKind?: RuleKind;
  defaultDecision: "allow" | "deny";
  target: ProfileMutationTarget;
};
```

Mode differences are explicit rather than implemented in separate components:

| Behavior | ASK | CREATE |
| --- | --- | --- |
| Initial rows | Evaluation-derived, prefilled | Empty until user adds one |
| Initial decision | allow for request rows; deny for additional rows | deny (safe manual-authoring default) |
| Add/remove rows | Request rows retain provenance; clearly labelled additional rows may be added/removed | Yes |
| Context | Fixed on request rows; additional rows default from the selected row and may choose a valid context | Selected from valid contexts or omitted for all contexts |
| Reset | Restore request-derived rows and remove additional rows | Clear unsaved rows in the section |
| Enter | Atomically save non-skipped rows, reload, and re-evaluate the pending request | Return section draft to profile overview |
| Protected kind | Never generated for ordinary ASK | Available only as safeguards section |

Deny guidance is available for Bash, read, and write deny rows where supported
by schema. Protected safeguards should not imply request steering.

ASK may add related rules discovered while reviewing the request—for example, a
broad parent allow plus a child deny. Additional rows default to the selected
row's kind/context and to deny, but are labelled `Additional profile rule (not
required by this ASK)`. They may change kind/context within the valid domain and
are saved in the same atomic batch. Evaluation-derived rows always retain their
immutable request provenance even if their saved pattern is edited.

### Make CREATE an overview with optional sections

The current linear flow forces users through many dialogs and effectively
requires a protected rule. Replace it with a profile draft overview after
composition/basic metadata are collected (metadata may be one custom form):

```text
Create profile: team-work
Extends (later wins ties)  builtin:default, shippedRuleset:node
Transform                  none
Sandbox Bash               on · network denied

Rules
  ⚙️ Bash rules             0   Edit
  📖 Read-path rules        0   Edit
  ✏️ Write-path rules       0   Edit
  🛡️ Protected safeguards  0   Edit

Enter create and activate · ↑/↓ edit section · Esc review discard
```

This makes every rule section genuinely optional and lets the shortest CREATE
flow avoid opening four empty editors. Entering a section opens the shared
multi-row editor; returning updates the overview count and compact preview.
The protected section must include this persistent explanation:

> Protected denies block both reads and writes. Protected allows only create
> exceptions to broader protected denies; they do not grant read or write
> permission.

Composition ordering must be labelled as precedence, because later entries win
same-specificity ties. Transform `none` should require no separate picker; edit
it only when desired. The overview is the final review, so a second confirmation
is unnecessary.

CREATE writes metadata, composition, transform, sandbox, and all four rule
collections in one validated atomic mutation, then reloads and activates once.
Navigation and cancellation have distinct behavior:

- Esc inside a section is **Back** to the overview and retains that section's
  draft.
- Clearing a section is an explicit action, not an Esc side effect.
- Esc from the overview asks whether to discard the complete profile draft;
  only explicit discard exits.
- Metadata validation and persistence failures keep the full draft open and
  display the error; they do not write or activate anything.

## Persistence design

### Batch mutation boundary

Introduce a production-owned batch API used by both flows rather than calling
`appendProfileRule()` repeatedly:

```ts
type ProfileRuleChange = {
  kind: RuleKind;
  pattern: string;
  decision: "allow" | "deny";
  guidance?: string;
  contexts?: readonly PathContext[];
};

type ProfileMutationTarget =
  | { mode: "update"; profile: string }
  | {
      mode: "create-child";
      profile: string;
      extends: readonly [string];
      description: string;
      emoji: string;
    };

applyProfileRuleChanges({
  fallback,
  configPath,
  target,
  changes,
}): void;
```

The API must:

1. read and parse the source once;
2. build one candidate document containing the child profile when needed;
3. apply every rule change to that same candidate document;
4. preserve JSONC comments/formatting without running Prettier across unrelated
   user-authored configuration;
5. validate the complete candidate through `loadProfileConfig()`;
6. rename one temporary file atomically;
7. leave the original byte-for-byte unchanged on any failure;
8. load the successfully saved profile and only then re-evaluate the pending
   request.

Extend `createCustomProfile()` (or share its lower-level mutation builder) with
optional typed `bashRules`, `readPathRules`, `writePathRules`, and
`protectedPaths`. Omit empty containers.

### Context-aware replacement

A rule update is scoped by collection, exact pattern, and operation context.
Do not remove all same-pattern rules from an ordinary collection.

For an ASK candidate with context `c`:

- replace an exact same-pattern rule scoped exactly to `c`;
- if an existing scoped rule includes `c` plus other contexts, preserve its
  decision for the remaining contexts and replace only `c`;
- preserve an unscoped same-pattern rule as the fallback for other contexts and
  append the new `contexts: [c]` override;
- never affect the other ordinary collection or protected safeguards.

Bash and protected rules have no ordinary path context and retain exact-pattern
replacement within their own collection. Normalize/deduplicate context arrays
before comparing identities.

## Evaluation changes

1. Extend direct-tool ASK results with the exact ordinary kind, tool context,
   concrete absolute path, display pattern, and matched-rule source already used
   by enforcement.
2. Extend Bash path tracing to return an ordered collection of all unresolved,
   concrete authorable references, not only `first`/`blocking`.
3. Include `kind` and `context` on each Bash path trace at evaluation time.
4. Have `evaluateBashGate()` expose all unresolved command and path candidates.
5. Keep deny precedence unchanged: protected deny, validation failures, and
   ordinary deny still prevent an allow-oriented save flow from overriding the
   denied layer.
6. Remove the UI callback's call to `analyzeBashPathReferences()`.
7. Remove `RememberedRule` in favor of the structured resolution/change-set
   types.

## Labels and obsolete behavior

Delete:

- the ASK “protected path glob” target and heading;
- `profileUpdateTargets` if no other production consumer exists;
- the harness's obsolete target-picker helper and stale queued selections;
- README language claiming users manually choose Bash/protected/both targets;
- tests that treat a protected allow as resolution of an ordinary ASK.

Use labels such as:

```text
📖 Read-path rule for ASK request
✏️ Write-path rule for ASK request
🛡️ Protected-path safeguard for profile
⚙️ Bash rule for ASK request
```

Success notifications must name the effect and target, for example:

```text
Saved 1 write-path allow to work-custom; continuing request.
Created default-custom with 2 rules and activated it.
Saved write-path deny to work-custom; request rejected.
```

## Behavioral tests

Drive real commands/tool requests and real custom components through the
interactive harness. Do not inject completed rule objects or assert private
component state.

### ASK behavior

1. Direct `read` ASK → choose save → Enter with exact prefill → one scoped
   `readPaths` allow is persisted → post-save re-evaluation continues the
   current request and exact retry is prompt-free; write remains governed by
   `writePaths`.
2. Direct `write` ASK → toggle deny and enter inline persistent steering → one
   scoped `writePaths` deny is persisted → post-save re-evaluation rejects the
   current request and exact retry with that steering; read remains governed by
   `readPaths`.
3. Direct contexts are retained (`read`, `grep`, `find`, `ls`, `edit`, `write`)
   and do not accidentally grant sibling contexts.
4. Bash command ASK + ordinary Bash path ASK → one permission prompt and one
   combined screen → both changes commit atomically and re-evaluation has no
   ASK.
5. A `cd` path ASK is displayed/persisted as `readPaths` context `ls`; ordinary
   Bash operands remain displayed/persisted as `writePaths` context `bash`.
6. Several Bash ASKs are shown in encounter order. Resolve two and skip one →
   only two rules are saved → re-evaluation prompts again with only the skipped
   ASK. An all-skipped draft cannot be saved.
7. Identical candidates are deduplicated without merging distinct contexts.
8. Dynamic/opaque/non-authorable path uncertainty does not offer a misleading
   save-rule choice.
9. Editing `generated/a.ts` to `generated/**` and saving allow makes a later
   `generated/b.ts` request prompt-free while a path outside that glob remains
   governed by prior policy. A focused renderer assertion also verifies the
   immutable requested path, edited saved pattern, destination, and
   broader/custom warning without depending on ANSI/layout.
10. Add an additional child deny beside a request-derived parent allow → both
    save atomically → the child path is denied and a sibling under the parent is
    allowed. The additional row is visibly identified as not required by the
    ASK.
11. Active shipped profile → suggested custom child is shown in the diff →
    Enter creates child plus every change atomically and activates once.
12. Existing custom profile → changes are applied directly without a naming
    dialog.
13. Esc from the editor returns to the permission choice with values retained;
    explicit discard, invalid profile name, collision, or final cancellation
    leaves config bytes and active profile unchanged. Validation/persistence
    failure keeps the draft open.
14. A mixed allow/deny/skip batch persists non-skipped changes atomically, then
    re-evaluation determines allow, deny, or another ASK. A winning deny returns
    only persisted deny steering; normal `No` steering remains transient.
15. A decisive protected, ordinary-path, or Bash deny suppresses the ASK prompt,
    even when another candidate would evaluate to ASK.

### Replacement and layer behavior

16. Existing exact `(kind, pattern, context)` ASK → save allow/deny through the
    wizard → the new effective decision wins and no equal-specificity conflict
    remains.
17. Two draft rows targeting the same `(kind, pattern, context)` are rejected or
    explicitly consolidated before writing; their outcome never depends on
    accidental row order.
18. Same-pattern rows in distinct contexts remain valid and are not treated as
    clashes.
19. Updating one context of a same-pattern multi-context rule preserves every
    other context's effective decision.
20. A scoped update over an unscoped ASK rule resolves only the requested
    context and preserves the fallback for sibling contexts.
21. Protected allow can neutralize a broader protected deny but cannot grant an
    ordinary read/write that ordinary policy denies or asks.
22. Protected deny remains cross-cutting and cannot be authored accidentally
    from an ordinary ASK.
23. Profile switching removes all rules of the prior profile from observable
    enforcement.

### CREATE behavior

24. The shortest CREATE journey can leave all four rule sections empty; no
    protected safeguard is required.
25. A creation journey adds Bash, read, write, and protected allow/deny rules
    through the shared editor; the overview shows their counts/destinations and
    activation enforces each in its own layer/context.
26. Esc from a CREATE section returns to the overview with its values retained;
    validation failure retains the complete draft; explicit clear removes only
    that section; explicit overview discard writes and activates nothing.
27. CREATE saves all fields in one mutation while retaining comments and
    rejecting an invalid source/candidate without replacement.
28. ASK and CREATE render the same production-owned row labels, decision icons,
    guidance behavior, context validation, and destination summaries.

Avoid brittle assertions on custom-component array indexes. Wait for a modal by
its production-owned identity/title, drive keys, and assert rendered semantic
content plus persisted/enforced behavior. Include at least one true `tui`-mode
test for the custom permission picker branch.

## Implementation sequence

1. Add production-owned rule/editor/change-set types, labels, and pure semantic
   preview helpers.
2. Add batch profile mutation and typed CREATE collections, with focused JSONC,
   atomicity, and context-replacement tests.
3. Add operation kind/context and ordered unresolved candidates to direct/Bash
   evaluation results; preserve current Bash semantics.
4. Collapse Bash path/command ASKs into one request-level resolution and remove
   UI re-analysis.
5. Implement the shared rule editor and ASK live-diff screen; default ASK rows
   to allow and save once.
6. Defer child-profile creation until the same atomic save and show the target
   in the preview.
7. Rework CREATE around the optional-section overview using the shared editor
   and one atomic create.
8. Remove protected ASK terminology/dead target-picker infrastructure and
   update README/help text.
9. Migrate interactive behavioral tests, including no-write cancellation and
   exact-retry assertions.
10. Run `npm test` and all static/generated-artifact checks. Resolve policy
    regressions from intended semantics; do not update assertions merely to
    preserve the misleading protected-update behavior.

## Acceptance criteria

The refactor is complete when a user can look at any save screen and answer,
without knowing the schema:

1. Which request caused this change?
2. Which profile will be changed or created?
3. Is this a read permission, write permission, Bash rule, or protected
   safeguard?
4. Which operation context does it affect?
5. What exact pattern will be stored and where?
6. What changes from ASK to allow/deny, and what remains unaffected?
7. Will cancellation leave the profile untouched?

For the normal exact-path ASK, the path from prompt to durable rule is two user
actions and one atomic write: choose **Save rule(s) to profile…**, then press
**Enter save and re-check request**. The saved profile is reloaded and the
pending request—not the tool execution—is evaluated again to determine whether
to continue, deny, or prompt for a deliberately skipped ASK.
