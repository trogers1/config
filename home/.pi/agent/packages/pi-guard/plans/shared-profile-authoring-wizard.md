# Shared Profile-Authoring Wizard — final confirmation specification

> **Status: IMPLEMENTED**
>
> This is the accepted implementation specification for the shared profile-authoring
> wizard, Prompt filesystem contract, and startup-profile-name behavior.

## Scope and outcome

Replace divergent standard-profile CREATE and EDIT flows with one overview-first,
raw-declaration authoring experience. Inline ASK remains a narrow, contextual rule
save flow; it reuses the shared General component only when it must create a child
profile.

The persisted `profiles` representation remains a keyed object. This is a hard cut:
there are no compatibility adapters, aliases, migrations, or fallback handling for
obsolete authoring APIs or configuration behavior.

## Authoring entry, drafts, and cancellation

### CREATE

CREATE opens the same overview used by EDIT. Its raw draft is initialized as follows:

- **Name:** prefilled with the existing exact `suggestedChildProfileName` algorithm,
  using the active profile as the profile stem and immutable `startupCwd` as the
  directory input. This retains its ASCII slug replacement, fallback stems,
  case-sensitive loaded-user-profile collision set, and `-2`, `-3`, … suffix loop.
- **Description:** blank and required.
- **Emoji:** `💅`.
- **Color:** omitted (inherit).
- **Composition:** `extends: [activeProfile]`.
- **Transforms:** omitted.
- **Rules:** raw CREATE defaults; do not materialize inherited/resolved collections.
- **Sandbox:** omitted (inherit).
- **Startup directory:** retain the existing `startupCwd` directory-glob prefill.

Cancelling CREATE from the overview **always** asks whether to discard, including a
pristine draft. Declining returns to the unchanged retained draft.

### EDIT

EDIT opens the same overview with the exact raw declaration injected into the draft;
it must not copy resolved/inherited values into local fields. General permits a full
rename. Clean overview cancellation exits without confirmation; dirty cancellation
asks whether to discard and, if declined, retains the draft.

### Shared keyboard behavior

- `Esc` in a section means **Back** and preserves the draft.
- `Ctrl+C` is a root abort that wins over local component bindings. It performs no
  write, external prompt-file action, activation, notification, or follow-up discard
  confirmation.
- List editors use `Ctrl+Up` / `Ctrl+Down` to reorder selected entries.
- A failed submit keeps the draft, maps typed validation issues to sections, and
  automatically opens the first invalid section in overview order.

## Overview and sections

The overview has an action separator followed by this exact section order:

1. **General**
2. **Prompt**
3. **Composition**
4. **Transforms**
5. **Bash**
6. **Read**
7. **Write**
8. **Protected**
9. **Sandbox**
10. **Directory**

It shows local/raw summaries and, only as non-serializable context, useful resolved
inheritance information. It must never display an inherited value as a local value
that will be saved.

### General

General is one shared component used by CREATE, EDIT, and ASK child creation:

- Name and description are required in both CREATE and EDIT.
- Emoji is optional; clearing it omits the local declaration.
- Color is optional. Its choices are **inherit/omit** plus the schema-derived palette.
  Do not maintain a UI-owned color union. The legacy forced `magenta` default is
  removed.
- EDIT supports full key rename, subject to normal name/reference validation and the
  authoritative-environment restriction below.

### Prompt

Prompt has three raw modes:

- **Inherit:** omit `promptFile`.
- **Disable:** write `promptFile: null`, suppressing an inherited prompt.
- **File:** write a nonblank local path.

For **user configuration**—profiles and custom rulesets alike—File mode has a hard
path cut: it accepts only an absolute path or `~/…`. Relative and blank paths are
rejected. Built-in/shipped declarations may retain package-relative paths as an
internal package-only capability; the user authoring UI never offers it.

At validation time, an existing file must resolve to a readable regular-file target.
Symlinks are permitted only when their target is a readable regular file. Decode it
as strict UTF-8 and reject content over 256 KiB. These checks apply before commit and
must be repeated at runtime, because a target can change after save. Runtime failures
fail closed with a clear active-profile and resolved-path error; no prompt content is
silently skipped or partially used.

A missing File-mode target is permitted only when its parent directory already exists.
The final commit creates the requested zero-byte file with mode `0666` (subject to
umask), without a separate confirmation. This is an external side effect: create it
only at final commit time, then make the one atomic config write. If the config commit
fails, best-effort delete the newly created empty file. Document the unavoidable crash
boundary between the file creation and config replacement; do not claim cross-file
atomicity. Existing files are never replaced by this behavior.

Prompt changes do **not** require security confirmation. Omission, `null`, and string
remain distinct raw values; composition retains normal scalar semantics (absence
inherits, later parent wins, local value wins).

### Composition

Composition edits ordered `extends` entries. The picker offers all resolver-valid
references: built-ins, shipped rulesets, custom rulesets, and user profiles. It never
offers the structurally string-valid but resolver-invalid `transform:*` prefix.

Entries are ordered, duplicates are allowed, and zero entries are allowed when the
candidate is otherwise valid as a standalone profile. Later composition entries win
only equal-specificity ties; do not describe this as a universal override. Reject
unknown/reserved-invalid references, self-reference, cycles, and rename-invalidated
references through full candidate resolution.

### Transforms

Transforms are schema-derived options in declared order. Duplicates are allowed and
preserved. Preserve fidelity between omitted transforms and explicit `[]`, and retain
the existing `extends` dependency: a transform declaration is valid only when its
candidate has the required composition. Transforms run after inherited composition
and before local ordinary rules; they do not modify protected rules.

### Rules, sandbox, and directory

Bash, Read, Write, and Protected edit only their corresponding local raw rule
collections and preserve collection ordering and schema-specific empty/omitted
semantics. Protected rules retain their first-stage safeguard semantics.

Sandbox retains raw inherit/disable/custom declaration distinctions and uses resolved
parent policy only as context. Directory retains raw startup-directory declarations
and the existing immutable-`startupCwd` prefill behavior; it is not a live directory
switch.

Arbitrary custom tool declarations are the sole profile-local preserved-but-uneditable
area. Preserve them exactly, including siblings while editing `tools.bash`; reserved
path-tool names remain invalid. `promptFile` is explicitly editable, while prompt and
other global configuration outside the profile declaration remain outside this wizard.

## Validation, security, commit, and activation

### Candidate and security baseline

Build one complete raw candidate document from a source snapshot and revision. Validate
schema, references, cycles, rule/directory constraints, and section-addressable errors
before any config write. Security comparison is exactly:

- **before:** the current active profile’s effective policy;
- **after:** the exact candidate profile’s effective policy resolved from the full
  candidate document.

Keep the existing conservative sandbox and directory-expansion confirmations against
that baseline. Prompt-only changes never confirm. Rejection leaves source bytes and
active selection unchanged.

### Atomicity, fidelity, and conflicts

A successful CREATE or EDIT makes one atomic config-document replacement. It must:

- preserve JSONC comments, formatting, keyed-profile declaration order, unrelated
  fields, raw omission/empty distinctions, custom tools, ordered arrays, and duplicate
  Composition/Transform entries;
- use optimistic source revision/hash checking and leave the retained draft available
  on conflict;
- validate the complete renamed graph before replacement;
- make no partial profile, rename, child, or rule update visible on an error.

Portable rename is not true compare-and-swap; document the race after the final
best-effort revision check. Prompt missing-file creation has the explicit external-side-
effect/crash boundary described above.

A rename preserves the profile declaration position and rewrites only exact custom
profile references in `extends` plus `defaultProfile` when equal to the old key. Do
not rewrite comments, arbitrary strings, custom-tool data, built-in/ruleset namespaces,
or merely similar text. A name named by authoritative `PI_SUBAGENT_PROFILE` cannot be
renamed in process; it fails closed and requires launcher/environment update and restart.

### Activation and precedence

After a successful save, reload and explicitly activate the saved profile in both
CREATE and EDIT (the new key after a rename). `PI_SUBAGENT_PROFILE` is the sole
authoritative exception and must not be displaced. A directory declaration does not
override this explicit post-save selection.

Startup/resume precedence otherwise remains unchanged: authoritative subagent selection,
then directory matching against immutable startup CWD, then persisted selection, then
configured default. The post-save rule is deliberately distinct from startup/resume
selection.

## Inline ASK child creation

ASK remains limited to concrete request-derived rule changes. It must not expose
Composition, Transforms, Prompt, Sandbox, or Directory management.

When ASK needs a child profile, it uses the shared General component and:

- generates the collision-free child name with the existing suggested-child algorithm;
- pre-fills its parent/composition context, generated description, and `💅` emoji;
- leaves color inherited/omitted;
- does not embed the generated name in any text input or description;
- applies `Esc` Back to retained rule rows and local `Ctrl+C` cancellation back to the
  permission picker; and
- commits the child plus ASK rules atomically in one config mutation.

## Implementation boundaries and type rules

Schema modules are the source of truth. Derive static types from schemas and use
schema-driven parsing/validation. Build the shared section registry with generic
registry builders and `satisfies` so section IDs, draft slices, editors, summaries, and
validation routing cannot drift. All APIs use object arguments.

Do not add unsafe casts/assertions, `Type.Unsafe`, duplicated string unions, UI shadow
schemas, or new unsafe typing. Keep raw-draft/domain/mutation logic independent of TUI;
TUI must not become a policy or schema authority.

Delete the old divergent wizard loops, forced-magenta path, duplicate section/API
registries, and obsolete public mutation APIs after replacement coverage proves them
unused. There are no backwards adapters. User relative/blank prompt paths are rejected,
and legacy magenta behavior is removed.

## Required verification

### Current stabilization status

The General, inline-ASK, root-abort, shared-wizard, Prompt, ordered-selection, atomic
commit, typed-validation, and hard-cut mutation work is integrated. The commands below
remain the required final freshness and regression checks after future changes.

### Exact required tests

Add or update behavior-first harness/integration and focused domain/component coverage
for all of the following:

1. CREATE overview entry/defaults: suggested active-profile + immutable-startup-CWD
   name and collision suffixing, blank required description, `💅`, inherited color,
   parent composition, raw defaults, startup directory prefill, and always-confirm
   overview cancellation.
2. EDIT exact raw injection, full General rename, clean cancellation without prompt,
   dirty discard confirmation, no inherited materialization, and reload/activation.
3. Every overview section in the exact order; issue badges and first-invalid-section
   routing; Escape Back; root `Ctrl+C`; and Ctrl+Up/Down list reorder.
4. General palette/inherit behavior and removal of forced magenta.
5. Composition resolver choices (built-in, shipped ruleset, custom ruleset, user
   profile), transform-prefix exclusion, zero/duplicate/order semantics, and
   self/cycle/rename validation.
6. Schema-derived transforms, duplicate/order behavior, omitted versus explicit-empty
   fidelity, and `extends` dependency.
7. Prompt inherit/null/file semantics; rejection of user relative/blank paths;
   absolute and `~/` paths; regular readable target/symlink target; strict UTF-8 and
   256 KiB boundary; missing-parent rejection; final zero-byte creation mode; config
   failure rollback attempt; runtime revalidation/fail-closed error; and no prompt
   confirmation.
8. Custom-tool sibling preservation and all raw rule/sandbox/directory distinctions.
9. One-write atomic candidate mutation, JSONC comments/format/order preservation,
   optimistic conflicts, byte-identical failure paths, and exact rename/default/
   reference rewriting.
10. Security baseline/confirmation behavior and post-save activation matrix:
    explicit saved profile wins over directory after CREATE and EDIT, while
    `PI_SUBAGENT_PROFILE` remains authoritative; startup/resume precedence remains
    independently covered.
11. Inline ASK existing-profile updates and child creation: General prefills,
    inherited color, local Ctrl+C cancellation to the permission picker, no
    management-surface leakage, and atomic child-plus-rules save.
12. Registry/type-oriented tests proving exhaustive synchronized section dispatch and
    no private-state-driven component tests.

Run during implementation:

```sh
npm run check:all
npm test
npm run check:profile-schema
```

Run focused profile-authoring/configuration/integration tests while iterating. Regenerate
the checked-in profile schema only from its generator when schema sources change, then
run the schema freshness check. Retain dependency-cruiser boundaries.

## Completion checklist

- [x] One shared CREATE/EDIT overview and the exact ten-section order.
- [x] CREATE/EDIT/ASK defaults, General fields, name generation, cancellation, and
      keyboard rules above.
- [x] Prompt’s three modes, user-path hard cut, file validation/runtime failure model,
      and documented external side-effect boundary.
- [x] Raw fidelity, custom-tool preservation, resolver-valid composition, transforms,
      atomic mutation, rename rules, and type rules.
- [x] Effective-policy security baseline and explicit post-save activation precedence.
- [x] Behavior, component, mutation, security, and lifecycle regression coverage.
