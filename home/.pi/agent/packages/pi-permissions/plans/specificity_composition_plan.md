# Specificity-Based Composition Plan: Rule Sets, Multi-Extends, and Unified Path Rules

## Goal

Replace positional (last-match-wins) rule resolution with **specificity-first
resolution** so that profiles and rule sets compose order-insensitively, then
decompose the shipped profiles into reusable **rule sets** that users can also
reference directly from `profiles.jsonc`, and unify every decision surface
(bash rules, path rules, protected paths) behind one rule shape and one
resolution function.

This package has one user, so this change does **not** provide compatibility
aliases or migration behavior. Old shapes fail loudly until updated.

The plan is test-driven: **Phase 1 lands the full behavioral specification as
failing tests** (marked `test.fails`, so the suite stays green), and each
subsequent phase un-marks its slice.

## Background: why positionality is being demoted

Rule order was inherited from opencode's permissions and is expressive, but it
makes composition fragile: to predict a decision you must mentally replay the
entire flattened rule list, and `extends` becomes order-sensitive in ways that
are invisible at the composition site.

Inspection of the shipped rules shows they are already **specificity-shaped**:
more-specific rules were intuitively written later (`git branch --list` allow
after `git branch *` deny; `npm exec *` deny after `npm *` ask;
`find * -delete *` guard after `find *` allow). Positionality has been doing
two jobs at once:

1. encoding specificity manually (specific-later), and
2. enabling true overrides (same pattern, different decision, later wins).

This plan splits those jobs: **specificity resolves across patterns;
composition order resolves only same-specificity ties.**

## Resolution semantics (the specification)

Every decision surface uses the same rule shape:

```ts
type Rule = {
  pattern: string;
  decision: "allow" | "ask" | "deny"; // protected layer: allow | deny only
  guidance?: string; // explanation attached to a deny
};
```

**Resolution algorithm** for a given input (command segment or path, per
context):

1. Collect all matching rules from the flattened, composed rule list.
2. Pick the rule with the highest **specificity**:
   - more literal (non-wildcard) segments wins;
   - tie → more literal (non-wildcard) characters wins;
   - tie → later in composition order wins (this is where layering lives).
3. The winning rule's decision applies.

Consequences:

- `*` has specificity zero and becomes a **true fallback**: it only decides
  when nothing else matches.
- The three-valued decision system nests into regions: broad `ask`, more
  specific `deny` for the dangerous subset, even more specific `allow` for the
  blessed subset.
- Same pattern + different decision across layers = a tie resolved by
  composition order, surfaced by the **conflict lint** (warning for ordinary
rules; **error for protected-path rules**).

**Exact tokenization** (whitespace tokens for command patterns, `/` segments
for path patterns; `*`, `**`, `?` contribute zero literals) is pinned by the
Phase 1 specificity tests and implemented in Phase 2.

**Three evaluation stages**, in order:

1. **Protected layer** (`protectedPathRules`) — cross-context (read, edit,
   write, bash path operands), deny short-circuits, never asks.
2. **Path rules** (`readPaths` / `writePaths`, with contexts).
3. **Command rules** (`tools.bash` and custom tools).

### Worked examples (already true of the shipped rules)

| Contest | Winner | Why |
|---|---|---|
| `git branch --list` allow vs `git branch *` deny | allow | 3 literals > 2 |
| `npm exec *` deny vs `npm *` ask | deny | more specific |
| `find * -delete *` deny vs `find *` allow | deny | more specific |
| `echo "---"` allow vs `echo *` deny | allow | fully literal |
| `docs/**` allow vs `**` deny (paths) | allow | more specific |
| committer `git commit *` allow vs base `git commit *` deny | allow | tie → committer composed later |
| `git * --output *` deny vs `git checkout *` allow | deterministic | metric tie → order; guards composed last by convention |

## Decisions

### Resolution and composition

- **Specificity-first, order-as-tiebreak** at every decision surface.
- **`extends: string[]`** — fold left-to-right through
  `extendProfile`; the profile's own rules apply last. Documented as
  *concatenation, not intersection*: `["builtin:read-only", "builtin:default"]`
  re-opens bash.
- **`transforms: string[]`** on profile definitions: names of shipped
  transforms applied once, after the full extends fold, in listed order.
  Transforms are functions over a resolved policy, so the registry is
  shipped-only (reserved `transform:` namespace). V1 ships:
  - `transform:deny-asks` — every `ask` becomes `deny` (non-interactive
    agents; what `builtin:worker` uses);
  - `transform:allow-asks` — every `ask` becomes `allow` (auto-approve;
    pair-with-containment — see Deferred decisions);
  - `transform:ask-all` — every `allow` becomes `ask` (paranoid supervision;
    denies unchanged).
  `builtin:worker` = default + `transform:deny-asks` + its own color/emoji
  (the transform no longer hardcodes styling).
- **Custom profiles may extend each other** (already supported today):
  resolution follows the extends graph, not JSONC object order; unknown
  parents and cycles fail loudly.
- **Conflict lint at load time**: same pattern + different decision across
  layers → warning (ordinary rules) / error (protected layer).

### Rule sets

- Shipped profiles are decomposed into **rule sets** under
  `modules/ruleSets.lib/`: `shell.ts`, `git.ts`, `packageManagers.ts`,
  `guards.ts`, `paths.ts`.
- A rule set is a **partial policy**: `tools` / `readPaths` / `writePaths` /
  `protectedPathRules` additions only — no scalars (color, emoji, promptFile)
  and no transforms (transforms apply to fully-folded profiles).
- Rule sets are exposed to JSONC through a reserved **`ruleset:` namespace**,
  usable in `extends` interchangeably with profiles:
  `"extends": ["builtin:read-only", "ruleset:test-run", "ruleset:guards"]`.
- Reserved namespaces are **flat kind-prefixes, one per addressable kind**:
  `builtin:` (full profiles), `ruleset:` (partial policies), `transform:`
  (policy functions). The namespacing machinery validates a prefix *list*,
  not a single prefix. User definitions with a reserved prefix are hard
  errors; unknown names fail loudly (see Interactions).
- Builtins in TS are composed from the **same registry** JSONC resolves
  against — one source of truth.
- There is **no user-defined rule set mechanism**: a custom profile containing
  only rules (and extended by other profiles) already serves that purpose.

### Protected paths

- `protectedPathPatterns` + `protectedPathExceptions` unify into
  **`protectedPathRules: Rule[]`** with decisions restricted to `allow | deny`.
  Exceptions dissolve into ordinary specific allows (`.env.template` beats
  `**/.env*` by specificity). Denies gain guidance text.
- Under `extends`, protected rules **concatenate like every other rule
  array** — nothing is ever dropped implicitly. The override matrix:
  - *Weaken* a deny: author a **more-specific allow** (literal `.env` beats
    `**/.env*` by specificity). No conflict, no lint event.
  - *Exact-pattern conflict* (allow over an inherited deny, or deny over an
    inherited allow): **load error**. To redefine a protected pattern
    wholesale, write a from-scratch profile that owns its list.
  Every weakening is either a precise authored rule or an explicit
  from-scratch redefinition.

### Shipped profile catalog

All shipped profiles — generic and workflow-shaped alike — live in
`modules/profiles.lib/`, composed from `modules/ruleSets.lib/`; `policy.ts`
becomes a thin composition root assembling the registry. There is no
workflow/generic distinction in the mechanism, only in the catalog.

**Naming convention:** clarity over personality — a reader should know what a
profile does from its name. Personality is welcome only when it costs no
accuracy (`docs` → `scribe-only` is fine; `gardener` is not, because it
hides danger). Dangerous or guardrail-loosening profiles must be legible as
such (`deps-mutator` can run preinstall scripts; the name says so).

| Profile | Composition | Color/emoji | Purpose |
|---|---|---|---|
| `builtin:default` | base composition: shell + git + package-manager rule sets + guards | blue 🛠️ | general-purpose main session |
| `builtin:worker` | default + `transform:deny-asks` | magenta ⚙️ | non-interactive subagents |
| `builtin:read-only` | inspection rule sets + guards; writes limited to tmp/handoff/progress | green 🔎 | read-only investigation |
| `builtin:tests-only` | default + writes gated to test files | green 🔬 | may only write tests |
| `builtin:tests-hidden` | default + test files protected (read **and** write) — renamed from `tests-disallowed` | orange 🕶️ | red-phase TDD: tests are hidden, not just unwritable |
| `builtin:committer` | default + git-write rules (add/commit/reset/restore/checkout/rebase/cherry-pick/worktree) + `/dev/null` write | red ⚠️ | promoted from the user's custom `committer` |
| `builtin:reviewer` | read-only + test/build run rules (`npm run/test`, `pnpm run/test`, `yarn run/test`, `cargo build/test/check/clippy`, `go *`) | cyan 🧐 | read code, run tests; writes stay tmp+handoff+progress |
| `builtin:scribe-only` | default + writePaths gated to `*.md`/`**/*.md`/`docs/**`//tmp | white 📜 | docs-only editing |
| `builtin:deps-mutator` | default + package-manager mutation allows (install/add/update/remove families) | yellow 📦 | dependency work; publish/login/token stay denied |
| `builtin:no-shell` | default + bash `*` deny with structured-tools guidance | green 🛡️ | edit/write/read tools only |
| `builtin:implementation-only` | default + test-file write denies (tests stay readable as the spec) | orange 🏗️ | pairs with `tests-only` for red/green orchestration; unlike `tests-hidden`, tests are not hidden |
| `builtin:git-full` | committer + push/branch/tag/switch allows | red 🔥 | full local + remote git workflows |

No promptFiles for new profiles initially.

## Required invariants

- One rule shape, one resolution function, three evaluation stages.
- `*` decides only when nothing else matches (true fallback).
- The protected layer never silently weakens under composition: shrinking it
  always requires a more-specific authored allow (visible in the explainer)
  or a from-scratch profile; exact-pattern conflicts are load errors.
- Every same-pattern/different-decision conflict is resolved deterministically
  and surfaced by the lint (warning for ordinary rules; error for
  protected-path rules).
- Unknown `extends` targets — profile or rule set — fail loudly, including
  reserved-prefix abuse (`builtin:`, `ruleset:`).
- The decision-table suite is the migration witness: it may only change where
  this plan pre-declares a delta.
- An existing invalid configuration never falls back to an operational policy
  (standing fail-loud/fail-closed contract).

## Interactions with existing plans

### `namespacing_plan.md` (prerequisite — land first)

Namespacing reserves `builtin:` and renames every shipped profile; this plan's
`ruleset:` and `transform:` namespaces reuse that machinery (reserved-prefix
validation generalized to a prefix list, builtin/user resolution layers). All new tests in this plan are written
against canonical `builtin:` names from the start to avoid a double migration.
Namespacing's own Phase 0 red tests land inside this plan's Phase 1.

### `sandbox_plan.md` (consumer — align, don't implement)

The sandbox translator consumes the **resolved effective rule list**; under
specificity that order is computed rather than authored. The translator's
planned "effective write derivation" already computes an effective list, so
the change is compatible, but its precedence-equivalence tests must run
against specificity-resolved output when the sandbox workstream lands.

The sandbox plan already assumes protected paths accumulate monotonically
("ADDITIVE", "∪", "remain mandatory", "never reorder or remove denies") —
consistent with this plan's concatenation semantics, under which protections
are never dropped implicitly and overrides require authored rules. Protected
rules remain the input to `denyReadPatterns` translation.

## Intentional behavior deltas (pre-declared)

The decision table pins current behavior everywhere except these entries,
each tagged with the phase that flips it:

| # | Delta | Phase |
|---|---|---|
| D1 | `builtin:default` gains `head`/`tail` allows and the unified git read set (`git config --get/--list`, `git reflog`, `merge-tree`, `diff-tree`, …) | 3 |
| D2 | `builtin:default` loses the six `address-comments` script allows and the `/**/home/.pi/agent/packages/**` path rule (machine-specific) → `personal` profile in `profiles.jsonc` | 3 |
| D3 | Dead `grep *` / `git grep *` early allows removed (already overridden by later denies; no decision change) | 3 |
| D4 | `builtin:read-only` gains explicit mutation-deny rules (same decisions, better guidance than the catch-all) | 3 |
| D5 | `builtin:worker` loses the script allows inherited from default (see Phase 3 task: verify no skill dispatches worker-profile subagents that run the fetch scripts; if one does, add a custom profile with `transform:deny-asks` in `profiles.jsonc`) | 3 |
| D6 | `protectedPathExceptions` field removed; exceptions become allow rules | 5 |
| D7 | The policy test that clears protections with empty arrays is rewritten against a more-specific authored allow / a from-scratch profile | 5 |

## Phase 0: Land `namespacing_plan.md`

Execute the namespacing plan as written (its own phases 0–6). All subsequent
work here assumes canonical `builtin:` names and the separated builtin/user
resolution layers.

**Passing criteria:** namespacing plan's verification ladder is green.

## Phase 1: Red suite — the behavioral specification (tests only)

Land the complete specification as tests. `test.fails` keeps `npm test` green
while documenting future behavior; removing a `.fails` marker is each later
phase's exit gate.

### Deliverables

1. **`integrationTests/decisionTable.test.ts` + corpus fixture** — `(command,
   profile) → expected decision` across the shipped profiles, run through the
   extension harness. **Not** `.fails`: it passes on day one and must stay
   green, changing only at pre-declared deltas (D1–D7).
2. **`integrationTests/specificity.test.ts`** (`.fails`):
   - specific beats broad regardless of declaration order (all Worked-examples
     rows);
   - `*` is a true fallback;
   - same-pattern ties resolve by composition order;
   - metric ties resolve deterministically;
   - identical semantics for `readPaths`/`writePaths`;
   - protected layer short-circuits every stage regardless of rules.
3. **`integrationTests/composition.test.ts`** (`.fails`): multi-extends fold
   order, fold-is-concatenation documentation case, transforms (`deny-asks`,
   `allow-asks`, `ask-all`), conflict-lint warnings.
4. **`integrationTests/protectedRules.test.ts`** (`.fails`): rule-shape
   schema, concatenation under extends, more-specific authored overrides,
   exact-pattern conflicts as load errors, exceptions-as-allows.
5. **`integrationTests/ruleSets.test.ts`** (`.fails`): `ruleset:` resolution,
   reserved-prefix rejection, unknown-name errors, mixed profile+ruleset
   extends, registry identity between TS and JSONC views.
6. **`integrationTests/profileCatalog.test.ts`** (`.fails`): behavioral spec
   per profile (committer allows `git commit`, reviewer denies edit but allows
   `npm test`, scribe-only denies `src/x.ts` write but allows `README.md`,
   deps-mutator allows `npm install` but denies `npm publish`, no-shell
   denies `git status` but allows edit, implementation-only denies test
   writes but reads tests, git-full allows `git push`).
7. Namespacing's Phase 0 red tests (canonical names throughout).

### Passing criteria

- `npm test` green: decision table passing, everything else passing via
  `.fails`.
- This plan carries the manifest below mapping each `.fails` block to its
  un-marking phase.

### `.fails` manifest

| Test block | Un-marks in |
|---|---|
| `specificity.test.ts` | Phase 2 |
| (decision table — never `.fails`) | edits only at D1–D7 |
| `composition.test.ts` | Phase 4 |
| `protectedRules.test.ts` | Phase 5 |
| `ruleSets.test.ts` | Phase 6 |
| `profileCatalog.test.ts` | Phase 7 |
| explain-command tests | Phase 8 |

## Phase 2: Specificity evaluator

Flip semantics on the **current** rule lists, before any decomposition. If the
decision table stays green untouched, the specificity-shaped claim is proven
with zero behavior change.

### Implementation

1. Recon first: locate every rule-resolution site (bash command rules, path
   rules per context, custom tools — candidates under `modules/shell/` and the
   tool handlers) and the matcher/tokenizer used for patterns.
2. Implement the specificity metric (literal segments → literal characters →
   composition index) next to the matcher.
3. Replace "last match wins" with "max specificity wins, order tiebreak" at
   each site.
4. Load-time conflict lint (warnings only at this phase; the protected layer
   still uses the old fields).

> Note: turn this into a `.lib` if it has enough complexity on it's own to become a lib

### Passing criteria

- `specificity.test.ts` un-marked and passing.
- Decision table green **unmodified**.
- No profile content changes in this phase.

## Phase 3: Rule-set decomposition (TS-internal)

### Implementation

1. Extract `modules/ruleSets.lib/{shell,git,packageManagers,guards,paths}.ts`.
   Guards lose their "must be appended last" invariant (specificity handles
   it); keep a "compose guards last by convention" note for metric ties.
2. Extract profile definitions into `modules/profiles.lib/` and rebuild
   `builtin:default`, `builtin:read-only`, `builtin:worker`,
   `builtin:tests-hidden` (renamed from `tests-disallowed`; promptFile
   `prompts/tests-disallowed.md` → `prompts/tests-hidden.md`),
   `builtin:tests-only` from rule sets; delete the duplicated git/shell
   blocks in `read-only`. `policy.ts` becomes a thin composition root
   (dependency-cruiser: no deep imports into `*.lib/`).
3. Move machine-specific rules to `profiles.jsonc` (D2):
   - `"gitlab-skills"` profile: the six `address-comments` script allows +
     `/**/home/.pi/agent/packages/**` path rules;
   - `"personal"`: initially `"extends": "builtin:default"` plus the
     gitlab-skills content inline (multi-extends dogfood arrives in Phase 4);
   - `"defaultProfile": "personal"`.
4. **Task:** grep the address-comments/export-mr-comments skills for
   worker-profile subagent usage of the fetch scripts; resolve D5 accordingly.
5. Apply D1, D3, D4 while recomposing.

### Passing criteria

- Decision-table edits only for D1–D5; any other required edit is a bug.
- Full `check:all` green (dependency-cruiser: `modules/ruleSets.lib/` must be
  acyclic; knip entries unchanged).

## Phase 4: Multi-extends and transforms

### Implementation

1. Schema: `extends: string[]` (minItems 1), `transforms: string[]`;
   regenerate `schemas/profiles.schema.json`.
2. Loader: fold left-to-right through `extendProfile`; resolve `transforms`
   against the shipped transform registry and apply them once, after the
   fold, in listed order. Unknown transform names fail loudly. Improve the
   unknown-parent error to name the missing parent.
3. Transform registry in `policyHelpers.ts` (or its own module): `deny-asks`
   is the current `denyInteractiveDecisions` moved and decoupled from worker
   styling; `allow-asks` is new. `builtin:worker` sets its own color/emoji.
4. Dogfood in `profiles.jsonc`: `"personal": { "extends":
   ["builtin:default", "gitlab-skills"] }`.
5. Intermediate state (acceptable): multi-extends folds protected paths with
   today's replace semantics until Phase 5 reshapes the field.

### Passing criteria

- `composition.test.ts` un-marked and passing.
- Decision table green (no profile content changes).

## Phase 5: Protected-path rules unification

### Implementation

1. Reshape `protectedPathPatterns`/`protectedPathExceptions` →
   `protectedPathRules: Rule[]` (allow|deny only) across the schema, helpers
   (`withProtectedPathPatterns` → `withProtectedPathRules`), the protected
   evaluation stage, and `testFilePatterns`.
2. Defaults become deny rules with guidance; former exceptions become allow
   rules (D6).
3. `extendProfile`: protected rules concatenate like every other rule array
   — no special union semantics; overrides are authored rules resolved by
   specificity and composition order.
4. Protected-layer exact-pattern conflicts become load errors; ordinary-rule
   conflicts stay warnings.
5. Rewrite the protection-clearing policy test against a more-specific
   authored allow / a from-scratch profile (D7); `builtin:tests-hidden`
   becomes default + `protectedPathRules: [...testFileRules]` (concatenation
   replaces the manual spread).
6. Regenerate the JSON schema.

### Passing criteria

- `protectedRules.test.ts` un-marked and passing.
- Decision table green except D6/D7 entries.

## Phase 6: Rule-set exposure (`ruleset:`)

### Implementation

1. Rule-set registry alongside the builtin profile registry; reserved
   `ruleset:` prefix with the namespacing machinery (user definitions with
   the prefix are hard errors; unknown names fail loudly).
2. Loader: `extends` entries beginning with `ruleset:` resolve from the
   rule-set registry; mixed profile/ruleset folds work.
3. Schema: encode the reserved prefix; regenerate.
4. Docs: composing from rule sets vs extending profiles; "always include
   `ruleset:guards`" guidance for from-scratch profiles.

### Passing criteria

- `ruleSets.test.ts` un-marked and passing.
- TS builtins and JSONC resolve against the same registry.

## Phase 7: Profile catalog

### Implementation

1. Add the new profiles from the Decisions table.
2. Promote the user's custom `committer` into `builtin:committer`; remove it
   from `profiles.jsonc`; leave `performance-review` custom (extends
   `builtin:default` + glab/gh/jq allows).
3. `/profile` completions and status reflect the new builtins.

### Passing criteria

- `profileCatalog.test.ts` un-marked and passing.

## Phase 8: Explainability and documentation

### Implementation

1. `/permissions explain <tool> <input>` (exact surface TBD): ranked matched
   rules, the winner, which tiebreak fired, active profile and composition
   chain, protected-layer overrides.
2. README rewrite: the three-sentence metric, rule sets, multi-extends,
   protected-layer rules, profile catalog.
3. Record the deferred decisions (below) in the README or a follow-up plan.

### Passing criteria

- Explain tests un-marked and passing; docs accurate against the shipped
  behavior.

## Deferred decisions

- Promoting write-guards into the engine-level always-win class alongside the
  protected layer. Today guards are ordinary rules in `ruleset:guards`: a
  from-scratch profile can omit them, and specificity is a heuristic, so a
  sufficiently specific allow could outrank them. Promotion means the guard
  set is evaluated like the protected layer — always applied, deny
  short-circuits, not omittable via composition. The trigger is third-party
  shipped profiles/rule sets, where "the author is the trust boundary" stops
  holding.
- Whether `transform:allow-asks` should be gated on an active sandbox. The
  sandbox plan rejected `autoAllowIfSandboxed` for converting the backstop
  into the primary mechanism; shipping this transform reopens that door —
  document it as pair-with-containment, or restrict it at that workstream.
- promptFiles for profiles.
- Sandbox translator alignment against specificity-resolved rules (belongs to
  the sandbox workstream; see Interactions).
- `autoAllowIfSandboxed` (already rejected by `sandbox_plan.md`).

## Verification ladder

Use the narrowest relevant test first, then broaden:

```sh
npm test -- --run integrationTests/decisionTable.test.ts
npm test -- --run integrationTests/specificity.test.ts   # per phase
npm run check:all
npm test
```

Each phase completes only when its `.fails` blocks are un-marked and passing,
the decision table is green (untouched or edited only at that phase's declared
deltas), the generated schema is fresh, and typecheck, lint, dependency
checks, Knip, Prettier, and the full suite pass.

## Suggested commit structure

1. `test(pi-permissions): specify specificity-based composition (failing tests)`
2. `feat(pi-permissions): resolve rules by specificity with order tiebreak`
3. `refactor(pi-permissions): decompose shipped profiles into ruleSets.lib and profiles.lib`
4. `feat(pi-permissions): multi-extends and policy transforms`
5. `feat(pi-permissions): unify protected paths as composable rules`
6. `feat(pi-permissions): expose rule sets via the ruleset: namespace`
7. `feat(pi-permissions): add committer/reviewer/scribe-only/deps-mutator/no-shell/implementation-only/git-full profiles`
8. `feat(pi-permissions): permissions explain command and docs`
