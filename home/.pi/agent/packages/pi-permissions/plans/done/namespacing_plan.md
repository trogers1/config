# Built-in Profile Namespacing and Collision Resolution Plan

## Goal

Give shipped profiles an explicit, reserved namespace so user profiles can extend them but can never override, shadow, or accidentally suppress their validation.

This package has one user, so this change does **not** provide compatibility aliases or migration behavior. Old unnamespaced built-in references should fail loudly until updated.

## Decisions

### Canonical built-in names

Use the `builtin:` namespace for every shipped profile:

- `builtin:default`
- `builtin:worker`
- `builtin:read-only`
- `builtin:performance-review`

Any other shipped profile added later must also use the `builtin:` prefix.

### Reserved namespace

- `builtin:` is reserved exclusively for profiles compiled into the package.
- A user configuration file must not define a profile whose name starts with `builtin:`.
- Such a definition is an invalid existing configuration, not an override.
- The loader must throw a `ProfileConfigLoadError` that identifies the reserved profile name and configuration path.
- The extension must remain registered, report the error, and block every tool call through the existing fail-loud/fail-closed path.

### References and selection

Built-ins are referenced by their canonical names everywhere:

```jsonc
{
  "defaultProfile": "client-work",
  "profiles": {
    "client-work": {
      "extends": "builtin:default",
    },
  },
}
```

The following inputs must use canonical names when selecting a built-in:

- `defaultProfile`
- `extends`
- `PI_SUBAGENT_PROFILE`
- persisted profile entries
- `/profile` command arguments and completions
- directory-selection status and profile metadata
- tests and checked-in user configuration

Do not retain unnamespaced aliases such as `default`, `worker`, or `read-only`.

### Custom profile names

- Custom profiles may use any valid non-empty name that does not start with `builtin:`.
- A custom profile may extend a built-in or another custom profile.
- Custom profiles may reuse former unnamespaced names such as `default`, but this is discouraged because it is visually confusing. Prefer descriptive names.
- Name resolution is exact; there is no fallback from `default` to `builtin:default`.

### Collision behavior

There is no merge or precedence rule between user and built-in definitions because they occupy separate namespaces.

- Defining `builtin:default` in the user file is a hard validation error.
- Extending `builtin:default` resolves only the shipped profile.
- Extending `default` resolves only a custom profile named `default`; if none exists, it is an unknown-profile error.
- Duplicate user profile names remain impossible at the parsed object level.

## Required invariants

- User configuration can never replace or mutate a shipped profile.
- Every user definition is validated and resolved; no definition is skipped because a fallback map already contains the same key.
- Unknown inheritance and cycles fail loudly, including cycles involving names that resemble former built-in names.
- An existing invalid configuration never falls back to an operational shipped policy.
- A missing configuration file still loads `builtin:default` and the other shipped profiles normally.
- Extension instances retain their own immutable resolved configuration; loading another extension instance cannot change the first instance's profile registry.
- All user-facing profile names, status text, completions, and errors use canonical names.

---

## Phase 0: Replace collision tests with the namespaced contract

The current red tests assume that a custom profile may override a shipped profile. Replace that expectation before changing production code.

### Add or update failing tests first

1. Runtime loader validation:
   - user definition named `builtin:default` is rejected;
   - user definition named `builtin:worker` is rejected;
   - any unknown future name with the `builtin:` prefix is rejected, proving the prefix rather than a fixed list is reserved;
   - error includes the profile name and config path.
2. Generated JSON Schema validation:
   - reject profile property names beginning with `builtin:`;
   - accept ordinary custom names;
   - validate the checked-in generated schema artifact, not only the TypeBox runtime schema.
3. Full extension harness:
   - an attempted `builtin:default` override produces error notification/status;
   - all tools are blocked interactively and non-interactively;
   - the override is never silently replaced by the shipped profile.
4. Resolution semantics:
   - `extends: "builtin:default"` resolves the shipped profile;
   - `extends: "default"` fails when no custom `default` exists;
   - `extends: "default"` resolves a custom `default` when one is explicitly configured.
5. Remove or rewrite the fixture test that expects a `performance-review` user definition to override the shipped profile. Use a uniquely named custom profile extending `builtin:performance-review` instead.

### Passing criteria

- Reserved-prefix definitions fail in runtime, generated-schema, and extension-level tests.
- Exact built-in and custom resolution behavior is executable and unambiguous.

---

## Phase 1: Namespace the shipped policy registry

### Implementation

1. Rename shipped keys in `modules/policy.ts` to canonical `builtin:*` names.
2. Set the shipped `defaultProfile` to `builtin:default`.
3. Update built-in inheritance to reference canonical names.
4. Introduce a shared constant and predicate rather than scattering string checks:

```ts
export const builtinProfilePrefix = "builtin:";

export function isBuiltinProfileName(name: string): boolean {
  return name.startsWith(builtinProfilePrefix);
}
```

5. Keep the built-in registry immutable after construction. Do not expose mutable profile objects to tests or extension instances.
6. Update package-owned profile references, test fixtures, and checked-in user configuration.

### Tests

- Shipped config contains only `builtin:*` keys.
- Shipped default is `builtin:default`.
- Built-in profile selection, directory matching, status, and command completion use canonical names.
- Former aliases are absent and rejected when used as built-in selectors.

### Passing criteria

- No shipped profile is addressable through an unnamespaced alias.
- Existing built-in behavior is unchanged apart from displayed/configured names.

---

## Phase 2: Separate built-in and user resolution

### Implementation

Do not seed a mutable user-resolution map with fallback profiles. Keep three explicit layers:

```text
builtins: immutable shipped profile registry
userDefinitions: validated definitions from the config file
resolvedUsers: resolved custom profile registry
```

Resolution algorithm:

1. Reject every `userDefinitions` key beginning with `builtin:` before inheritance resolution.
2. When resolving an `extends` reference:
   - if it begins with `builtin:`, resolve only from `builtins`;
   - otherwise resolve only from `userDefinitions`/`resolvedUsers`.
3. Track custom-profile resolution with `resolving` and `resolvedUsers` to detect cycles.
4. After all user definitions resolve successfully, construct the final immutable registry:

```ts
profiles = {
  ...builtins,
  ...resolvedUsers,
};
```

The reserved namespace guarantees that this merge cannot collide.

5. Validate `defaultProfile` against the final registry.
6. Return fallback only when the configured file does not exist. Any existing-file error must continue through `ProfileConfigLoadError`.

### Tests

- Unknown built-in reference, such as `builtin:missing`, fails.
- Unknown custom reference fails.
- Custom-to-custom cycles fail.
- Built-in profiles cannot participate in or hide a custom cycle.
- Every user definition is resolved even when its name resembles a former built-in name.
- Custom profiles inherit built-in path, Bash, and custom-tool rules correctly.

### Passing criteria

- The current fallback-map short-circuit is removed.
- No invalid user definition can disappear behind a shipped profile.

---

## Phase 3: Make extension configuration instance-local

Namespacing removes key collisions but does not fix the separate module-global configuration issue.

### Add failing integration test first

Register two extension instances with different custom profile files. Start and call the first instance after registering the second. Each instance must continue using the profile registry loaded during its own registration.

### Implementation

- Move `policyConfig`, `profileNames`, `isProfileName`, `activePolicy`, and directory-selection helpers into the extension factory closure or into an immutable per-instance policy service.
- Do not mutate the exported shipped config.
- Ensure commands, status, tool handlers, and session restoration all close over the same instance-local registry.

### Passing criteria

- Later extension registration cannot alter earlier handlers.
- Parallel tests do not need to mutate or restore shared production policy objects.

---

## Phase 4: Update schemas and public types

### Schema

Encode the reserved prefix in both runtime and generated schemas. The profile-name property schema should reject names beginning with `builtin:` while still requiring non-empty custom names.

Conceptually:

```json
{
  "propertyNames": {
    "pattern": "^(?!builtin:).+$"
  }
}
```

The exact TypeBox representation may use `patternProperties` if needed, but runtime and generated validation must agree.

### Types and constants

- Export the built-in prefix/name constants if consumers need canonical selectors.
- Prefer a literal union for known built-ins where useful:

```ts
type BuiltinProfileName =
  | "builtin:default"
  | "builtin:worker"
  | "builtin:read-only"
  | "builtin:performance-review";
```

- Keep custom profile names as strings; runtime validation enforces the reserved namespace.

### Passing criteria

- Runtime schema and checked-in JSON Schema reject reserved user definitions.
- Public type/API fixtures compile from `taylor-pi-permissions/config` or the documented profiles entry point.

---

## Phase 5: Update configuration, environment producers, and persistence

Inventory and update every producer or consumer of profile names, including files outside this package when applicable:

- `~/.pi/agent/permissions/profiles.jsonc`
- subagent launcher/environment code that sets `PI_SUBAGENT_PROFILE`
- skill or prompt configuration that selects `worker` or `read-only`
- persisted session fixtures
- integration-test fixtures
- README examples

Because migration is explicitly out of scope:

- an old persisted `default` entry is ignored or reported as unknown according to the existing restoration contract;
- an old `PI_SUBAGENT_PROFILE=worker` fails closed with canonical available names;
- an old config using `extends: "default"` fails unless it explicitly defines a custom profile named `default`.

### Passing criteria

- Package-owned configuration uses only canonical built-in names.
- No compatibility alias silently changes the requested profile.
- Unknown old selectors produce actionable errors listing canonical names.

---

## Phase 6: Documentation

Update README sections for:

- the `builtin:` namespace;
- extending built-ins;
- the reserved-prefix rule;
- the fact that built-ins cannot be overridden;
- exact name resolution for custom profiles;
- examples for `defaultProfile` and `PI_SUBAGENT_PROFILE`;
- fail-loud/fail-closed behavior for reserved-name definitions;
- lack of legacy aliases or migration.

Suggested example:

```jsonc
{
  "$schema": "https://example.com/pi-permissions/profiles.schema.json",
  "defaultProfile": "client-work",
  "profiles": {
    "client-work": {
      "extends": "builtin:default",
      "directories": ["~/Code/client"],
    },
  },
}
```

---

## Verification ladder

Use the narrowest relevant test first, then broaden:

```sh
npm test -- --run integrationTests/profileConfig.test.ts
npm test -- --run integrationTests/profiles.test.ts
npm test -- --run integrationTests/permissions.test.ts
npm test -- --run integrationTests/policy.test.ts
npm run check:all
npm test
```

The final implementation is complete only when:

- reserved-name tests pass;
- all profile-selection and inheritance tests use canonical names;
- the per-instance isolation test passes;
- generated schema is fresh;
- typecheck, lint, dependency checks, Knip, Prettier, and the full test suite pass.

## Suggested commit structure

1. `test(pi-permissions): define reserved builtin profile namespace`
2. `feat(pi-permissions): namespace shipped profiles`
3. `fix(pi-permissions): separate builtin and custom profile resolution`
4. `fix(pi-permissions): isolate profile registries per extension instance`
5. `feat(pi-permissions): reserve builtin names in profile schema`
6. `chore(pi-permissions): update profile selectors and fixtures`
7. `docs(pi-permissions): document builtin profile namespace`
