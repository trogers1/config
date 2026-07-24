# Pi Permissions Refactor Remediation Plan

## Goal

Finish the staged Unbash and policy-interface refactors with a test-first loop:

1. Add a failing behavioral test for one identified case.
2. Run the narrowest relevant test and confirm that it fails for the intended reason.
3. Make the smallest implementation change that fixes that behavior.
4. Run the narrow test again, then the related test file, then the full package checks.
5. Commit only when the slice is green.

This plan deliberately does **not** provide legacy profile migration. This package has one user. An existing but invalid profile file should instead fail loudly and fail closed; a missing file may still use the shipped configuration.

Staged review/editor artifacts and the unrelated sandbox-plan changes are outside this remediation plan.

## Required invariants

- An exception to protected-path handling removes only the generated protection; it never overrides the profile's ordinary path decision.
- A configured or inherited custom tool cannot become unrestricted through an empty override.
- Restrictive `writePaths` and `PI_SUBAGENT_PERMISSIBLE_GLOBS` cannot be bypassed with basename-only, dynamic, Git-colon, redirection, nested, or CWD-dependent Bash operands.
- Parser uncertainty prompts interactively and blocks non-interactively.
- Static exemptions such as ripgrep patterns and Git repository objects require positive semantic proof. Unknown operands are not assumed harmless.
- A malformed profile file remains visibly broken until corrected. The extension remains registered and blocks tool calls rather than disappearing and leaving tools ungated.
- Every final commit passes typecheck, lint, generated-schema freshness, and tests.

---

## Phase 0: Make the test environment deterministic

The current suite cannot be used as a red/green signal because it has two pre-existing failures from forcing a missing profile file while still expecting machine-local `address-comments` configuration.

### Tests/fixtures first

1. Add a checked-in JSONC test fixture containing the profiles needed by extension integration tests, including `address-comments` and `performance-review` overrides.
2. Change the relevant tests to set `PI_PERMISSIONS_PROFILE_CONFIG` explicitly to either:
   - the checked-in fixture when testing custom profiles; or
   - a guaranteed-missing path when testing shipped fallback behavior.
3. Avoid mutating the exported global `policyConfig` where possible. Prefer loading a fresh fixture/config for each harness. If the harness cannot inject a policy yet, add that injection seam before adding more behavior tests.

### Passing criteria

- The equal-directory-selection test no longer dereferences an undefined profile.
- The production-override test switches to profiles from the explicit fixture.
- `npm run check:types` and `npm run check:lint` pass.
- Direct Vitest execution reports all existing tests passing.

---

## Phase 1: Fix protected-path exception composition

### Add failing tests first

Add behavioral tests in `integrationTests/policy.test.ts` that call `withProtectedPathPatterns()` and then `evaluatePathByPattern()` rather than asserting only the generated array shape.

Cover each path context:

1. `read`, `grep`, `find`, and `ls`:
   - ordinary `* -> allow`;
   - later `private/** -> deny` or `ask`;
   - protected `**/.env*`;
   - exception `**/.env.template`;
   - `private/.env.template` must retain the ordinary deny/ask.
2. `edit`, `write`, and `bash` with the equivalent `writePaths` rules.
3. External paths:
   - ordinary `../** -> ask`;
   - `../other/.env.template` must remain `ask`, not become `allow`.
4. Positive control:
   - `public/.env.template` should receive the ordinary `* -> allow` decision.
5. Non-exception protected files must still deny with protected-path guidance.

Confirm these tests fail against the current final-exception-rule implementation.

### Implementation

Stop representing protected-path handling as unconditional final rules appended to the ordinary policy.

Preferred model:

```text
evaluatePath(policy, path, context):
  ordinary = evaluate ordered readPaths/writePaths
  if path is protected and is not a concrete exception:
    return generated protected deny
  return ordinary
```

Keep the protected decision and ordinary ordered decision as separate layers. Apply this shared evaluator to dedicated path tools and Bash. Do not derive an exception verdict from a `"*"` fallback.

If rule materialization is still needed for future sandbox translation, expose it as a separate translation representation; do not make the runtime gate depend on an inexact flattened rule list.

### Passing criteria

- Every new context matrix test passes.
- Existing protected grep/ripgrep and profile tests pass.
- Protected guidance/alternatives still appear on an actual protected denial.

---

## Phase 2: Make custom-tool inheritance fail safe

### Add failing tests first

1. In `integrationTests/profileConfig.test.ts`, define an inherited custom tool:

```jsonc
"deployment-base": {
  "extends": "default",
  "tools": {
    "deploy": [
      { "decision": "deny", "match": { "environment": "production" } }
    ]
  }
},
"deployment-child": {
  "extends": "deployment-base",
  "tools": { "deploy": [] }
}
```

Assert that the child still has a configured `deploy` policy and defaults to `ask`; it must not become absent/unrestricted.

2. Add an extension-harness test proving a call to `deploy` under that child profile prompts interactively and blocks without a UI.
3. Retain a test for the intended Bash empty-override behavior. Decide explicitly whether empty Bash rules mean “remove inherited command rules and therefore default to ask” or should also remain represented as an empty configured array.

### Implementation

- Do not delete custom-tool keys for empty overrides.
- Preserve `toolName: []`; `decideCustomTool(input, [])` already returns `ask`.
- If removal is genuinely needed later, introduce an explicit configuration operation with documented safe semantics rather than overloading an empty array.

### Passing criteria

- Empty inherited custom tools ask rather than allow.
- Existing append-order and last-match tests still pass.

---

## Phase 3: Close basename and dynamic Bash operand gaps

This is the central semantic-classification change. An AST can identify words, but command adapters must establish which words are definitely non-path values.

### Add failing tests first

Add end-to-end tests through `gateBash` and the extension harness, not only `classifyShell()` assertions.

#### Basename-only operands

Under a restrictive Bash `writePaths` policy and under `PI_SUBAGENT_PERMISSIBLE_GLOBS=modules/**`, verify that these do not bypass the path gate:

- `rg needle package.json`
- `cat credentials.txt`
- `git diff package.json other.json`
- `git blame private.txt`
- an output/input basename redirection such as `node < input.json` and `git log > history.txt`

Include positive controls for in-scope basenames when the startup directory itself is in scope and for explicit in-scope subpaths.

#### Dynamic operands

Verify that these prompt, and block without a UI:

- `cat "$TARGET"`
- `cat "${ROOT}/credentials"`
- `git diff --no-index "$LEFT" "$RIGHT"`
- `node < "$INPUT"`
- `git log > "$OUTPUT"`
- dynamic `cd "$TARGET"` followed by a relative operand

#### Proven non-path values

Prevent the conservative fallback from making common known values unusable. Add positive tests for:

- ripgrep search patterns and `--glob` values;
- Git revisions such as `HEAD`, `HEAD~3`, and a clearly parsed `REV:path` object;
- option values known not to be paths;
- shell literals used as ordinary command values where the adapter proves they are not filesystem operands.

### Implementation

1. Replace the current generic `argument -> ignore unless looksLikePath()` behavior with an explicit classification such as:

```ts
type ShellTokenKind =
  | "filesystem-reference"
  | "redirection-target"
  | "proven-non-path"
  | "repository-object"
  | "pattern"
  | "ambiguous"
  | "dynamic";
```

2. Treat static `ambiguous` operands as possible paths, including basenames. Evaluate them against `writePaths`/subagent scope.
3. Treat unresolved dynamic operands as `ask`; non-interactive execution blocks.
4. Allow command adapters to upgrade an operand to `proven-non-path`, `pattern`, or `repository-object` only when its semantics are established.
5. Start with adapters for the shipped allowed command surface most affected by false positives: ripgrep/readers and Git. Unknown command semantics remain conservative.
6. Document the rule: command policy decides whether an executable form is permitted; operand classification decides whether its possible filesystem targets are permitted. This remains a static gate rather than a kernel-complete boundary.

### Passing criteria

- Basename and dynamic tests fail before implementation and pass afterward.
- Existing default-profile commands remain usable where `writePaths` permits the startup directory.
- Read-only behavior is explicitly tested: ambiguous filesystem operands are denied, while proven Git revision objects remain usable.

---

## Phase 4: Tighten Git repository-object classification

### Add failing tests first

Add classifier tests and gate-level tests for:

1. `git diff --no-index ./allowed ../blocked:name` — both operands are filesystem paths; the colon path must not be exempt.
2. `git log -- path:name` — everything after `--` is a pathspec.
3. `git blame -- path:name` — path, not object.
4. Explicit path-shaped colon values:
   - `./path:name`
   - `../path:name`
   - `/tmp/path:name`
   - `~/path:name`
5. Genuine positive objects:
   - `git show HEAD~3:src/example.ts`
   - other supported revision-object forms already relied upon.
6. Ambiguous colon basenames must fail conservatively unless the adapter can prove repository-object semantics.

### Implementation

- Parse the Git global options and subcommand before applying exemptions.
- Track `--`; classify subsequent applicable operands as paths/pathspecs.
- Handle `diff --no-index` as a filesystem comparison mode.
- Never classify explicitly path-shaped strings as repository objects.
- Limit `REV:path` recognition to command positions/modes where Git treats it as an object expression.
- Prefer false-positive confirmation over an unverified exemption.

### Passing criteria

- All Git path bypass tests are denied/asked under restrictive policy.
- Genuine `REV:path` operations continue to pass.

---

## Phase 5: Preserve or conservatively reject uncertain CWD control flow

### Add failing tests first

Use policies with different decisions for the startup directory and a child/external directory so checking against the wrong CWD is observable.

Cover:

1. Subshell-local CWD:
   - `(cd allowed; inspect ./file); inspect ./startup-file`
   - the second path must be evaluated from the startup CWD.
2. Conditional CWD:
   - `cd first || cd second; inspect ./file`
   - do not assume both `cd` commands executed sequentially.
3. `&&` CWD chains and command failure uncertainty.
4. Command/process substitutions containing `cd`; they must not mutate the outer simulated CWD.
5. Group commands where CWD does persist in the current shell, if supported by Unbash's AST.
6. Dynamic `cd` followed by relative references.

For unsupported/uncertain forms, assert `ask` interactively and block non-interactively.

### Implementation

Do not flatten all `Command` nodes into one global CWD sequence for path analysis.

Two acceptable implementation levels:

- **Preferred:** walk the structured Unbash AST with a CWD state per shell execution scope, cloning state for subshells/substitutions and joining branch states conservatively.
- **Smaller first version:** model only a simple unconditional top-level sequence. If a relative operand follows conditional, nested, grouped, or dynamic CWD state that cannot be proven, return `ask` rather than guessing.

Keep command-pattern extraction separate from stateful path analysis; it may still collect nested commands positionally without using that flattened list for CWD resolution.

### Passing criteria

- No test evaluates a path against a CWD that cannot occur at runtime.
- Unsupported control flow fails conservatively.
- Simple `cd child; command ./file` behavior remains supported.

---

## Phase 6: Make invalid profile configuration loud and fail closed

No legacy migration is required. This phase distinguishes a missing optional file from an existing invalid file.

### Add failing tests first

In `integrationTests/profileConfig.test.ts` and the extension harness, cover:

1. Missing config path:
   - shipped policy loads normally;
   - no error status or notification.
2. Invalid JSONC in an existing file.
3. Schema-invalid profile, including a legacy field such as `bashPathReferences`.
4. Unknown inherited profile and cyclic inheritance.
5. Invalid default profile.
6. For each invalid existing file:
   - extension registration/session startup remains operational;
   - a prominent UI error notification is emitted when UI exists;
   - status indicates invalid permissions configuration;
   - every tool call is blocked with the file path and actionable validation error;
   - non-interactive sessions also block;
   - the invalid file is not silently replaced with an operational fallback policy.

### Implementation

1. Change `loadProfileConfig()` so an existing invalid file throws a typed/config-specific error. Continue returning fallback only when the configured path does not exist.
2. In the extension entry point, catch that error **without aborting extension registration**:
   - retain a known internal fallback object only so commands/status code can initialize safely;
   - store an immutable profile-configuration error reason;
   - register all gate handlers;
   - block all `tool_call` events while the error exists.
3. On `session_start`, set an error status and call `ctx.ui.notify(..., "error")` when available.
4. Do not let profile restoration clear the profile-config error. Track configuration errors independently, for example:

```ts
const profileConfigErrorReason: string | undefined;
let subagentProfileErrorReason: string | undefined;
const configurationErrorReason = () =>
  profileConfigErrorReason ?? subagentProfileErrorReason;
```

5. Include the exact config path and schema/parser message in the user-visible result.

This is “fail loud” and “fail closed” without the more dangerous behavior of throwing before the permission hooks are registered.

### Passing criteria

- Invalid existing configuration can never result in unrestricted tool calls.
- The user sees the cause immediately.
- Missing configuration still uses shipped defaults.

---

## Phase 7: Align custom-tool schema and public types

### Add failing tests first

1. Reject an empty custom-tool matcher property path:

```jsonc
{ "decision": "deny", "match": { "": "value" } }
```

Test both runtime TypeBox validation and the generated JSON Schema artifact. 2. Add a compile-time API fixture importing all intended public types, including `CustomToolRule` and `ToolPolicy`, from the documented package entry point.

### Implementation

- Encode non-empty matcher property names in generated schema using `propertyNames: { minLength: 1 }` or a non-empty `patternProperties` expression.
- Re-export the complete supported policy type surface from the documented `./config` entry point. If direct extension imports are supported, keep those exports consistent; otherwise remove/document partial duplicate exports.
- Minimize `Type.Unsafe` and casts where practical. If heterogeneous `tools` requires an unsafe schema bridge, isolate it and retain runtime validation at every external configuration boundary.

### Passing criteria

- Runtime and generated schema agree.
- Public type imports compile without reaching into internal module paths.

---

## Phase 8: Regression and documentation pass

### Behavioral characterization tests

Before changing documentation, make the intended posture executable:

- Default profile project output redirection is allowed through `writePaths` if that is intentional.
- Read-only Bash operands use restrictive `writePaths`, while dedicated read tools use `readPaths`.
- Input and output redirections share the Bash path policy.
- Subagent permissible scopes narrow but never widen the profile.
- Parser errors and semantic uncertainty ask interactively and block non-interactively.
- Custom tools default to `ask` only when configured; completely unconfigured tools remain outside this extension's policy unless the product decision changes.

### Documentation

Update README sections to state precisely:

- what Unbash proves syntactically;
- that command adapters provide limited executable semantics;
- that ambiguous/dynamic operands fail conservatively;
- that this is not a kernel-complete filesystem boundary;
- how `readPaths` and `writePaths` contexts interact;
- that an existing invalid profile file blocks permissions until fixed;
- the supported public type import path.

No legacy migration table is needed.

---

## Verification ladder for every phase

Use the narrowest command first, then broaden:

```sh
# One test file while iterating
./node_modules/.bin/vitest run path/to/file.test.ts

# Runtime tests without the pretest wrapper
./node_modules/.bin/vitest run

# Static/generated checks
npm run check:types
npm run check:lint
npm run check:deps
npm run check:knip
npm run check:profile-schema
npm run check:prettier

# Final package command, including pretest
npm test
```

A phase is complete only when its new test was observed failing before the fix and all package checks pass afterward.

---

## Suggested smaller commit structure

Keep each final commit green. Add the test first during development, but commit the test and its implementation together unless intentionally preserving red commits is desired.

1. **`test(pi-permissions): isolate profile configuration fixtures`**
   - Deterministic harness configuration.
   - Repair current type/lint/Vitest failures.
   - No product behavior change.

2. **`fix(pi-permissions): preserve ordinary policy under protected exceptions`**
   - Behavioral context matrix tests.
   - Separate protected-path evaluation from ordinary ordered path rules.

3. **`fix(pi-permissions): keep empty custom tool overrides fail-safe`**
   - Inheritance/harness tests.
   - Preserve configured empty custom-tool policy as default-ask.

4. **`feat(pi-permissions): parse shell syntax with unbash`**
   - Direct production dependency.
   - AST-backed command splitting, word extraction, redirection discovery, and parse-error reporting.
   - No broad semantic exemptions yet.

5. **`feat(pi-permissions): classify ambiguous Bash operands conservatively`**
   - Basename/dynamic tests.
   - Token-kind redesign and fail-closed ambiguous behavior.
   - Initial reader/ripgrep adapters.

6. **`fix(pi-permissions): distinguish Git objects from path operands`**
   - `--no-index`, `--`, colon-path, and positive `REV:path` tests.
   - Focused Git adapter changes.

7. **`fix(pi-permissions): preserve shell CWD execution scopes`**
   - Conditional/subshell/substitution tests.
   - Structured CWD analysis or conservative uncertainty handling.

8. **`refactor(pi-permissions): consolidate contextual read and write path policy`**
   - `readPaths`/`writePaths`, contexts, TypeBox-derived types, profile definitions, generated schema.
   - Keep custom tools out of this commit if possible.

9. **`feat(pi-permissions): add custom tool input policy`**
   - Match semantics, public types, schema constraint, inheritance tests.

10. **`fix(pi-permissions): fail closed on invalid profile configuration`**
    - Typed load error, persistent gate error, status/notification, tests.
    - No legacy compatibility layer.

11. **`feat(pi-permissions): rename subagent scope to permissible globs`**
    - Environment-variable rename, scope tests, README.
    - Since there is one user, no compatibility alias is required.

12. **`docs(pi-permissions): document conservative shell and policy semantics`**
    - Final behavior only; no unrelated sandbox-plan edits.

If rewriting the staged history is inconvenient, use the same boundaries for follow-up commits. The most important separation is:

- syntax parsing (`unbash`),
- semantic Bash operand classification,
- path-policy interface/schema,
- custom-tool policy,
- configuration failure behavior.
