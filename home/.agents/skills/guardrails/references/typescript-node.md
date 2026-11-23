# TypeScript / Node Guardrails

Apply the concepts in [the main skill](../SKILL.md) using the repo's existing package manager and task runner. Commands below use npm as an example, not a requirement.

## 1. Static correctness and formatting

Expose independently runnable, read-only `check:*` scripts:

- **`check:types`:** `tsc --noEmit`. Enable appropriate compiler checks: `strict`, `noUnusedLocals`, `noUnusedParameters`, `isolatedModules`, and `forceConsistentCasingInFileNames`.
- **`check:lint`:** `eslint .` with typescript-eslint recommended rules and justified architecture rules (§5).
- **`check:prettier`:** `prettier --check .`, using shared project configuration. Mutating repair: `fix:prettier` → `prettier --write .`. Keep wrapper check/fix names unambiguous rather than calling a mutating script `format`.
- **`check:deps`:** dependency-cruiser with `.dependency-cruiser.{js,cjs}`. Consider no-circular, no-orphans, no-deprecated, not-to-unresolvable, not-to-dev-dep, and peer/optional dependency awareness. Configure against the actual repo layout.
- **`check:knip`:** knip with explicit `entry` and `project` coverage. Avoid broad suppressions such as `ignoreExportsUsedInFile`; first fix the export surface or tighten coverage, then document specific false positives.

Example package scripts (fragment):

```jsonc
"check:all:quick": "npm run check:types && npm run check:lint && npm run check:prettier && npm run check:deps && npm run check:knip",
"check:all": "npm run check:all:quick",
"pretest": "npm run check:all",
"test": "vitest run"
```

Only include checks applicable to the project. This wiring makes `npm test` run the gate first; invoking the test runner directly does not.

## 2. Generated-artifact freshness

- Aggregate generators in `generate:all` (e.g. `generate:openapi`).
- For untracked outputs needed at runtime/build/test, invoke generation before those consumers through `prestart`, `pretest`, and build wiring as appropriate.
- For checked-in outputs, expose a read-only `check:generated` that generates temporarily and compares all owned files. Compose it into `check:all`; do not regenerate the developer's checkout during a read-only check.
- Mark generated files clearly (e.g. `*.generated.ts`), never hand-edit them, and choose lint/format exclusions deliberately.

A full gate can run required generation/freshness before `check:all:quick`. The quick path alone is not evidence of freshness.

## 3. Environment and runtime preflight

- **Node version:** use `engines.node` for supported minimum/range. Pin and assert `.nvmrc` only when exact parity prevents a real failure (apps/CLIs, Docker/CI/runtime skew, release-specific behavior). For small libraries or Pi extensions hosted by Pi's supported runtime, prefer a lower bound matching the host requirement rather than an exact `check:node` by default.
- **Services:** invoke bounded real connectivity checks in the integration-test preflight; do not make unrelated formatting depend on a database.
- **Secrets/config:** materialize `.env` explicitly from the declared source/secrets store and validate required settings before dependent work. A template alone is not validation.
- **Patches:** if the repo uses patch-package, run it in `postinstall` so a fresh dependency install cannot omit patches. Keep patch files tracked and fail if application fails.
- **Tool provisioning:** use the repo's lockfile and deterministic CI install command; do not fetch new linter versions from a check script.

## 4. Gate composition and parallelization

If several independent checks make sequential execution slow, use the existing task runner or a small `run-parallel-checks.ts` that spawns each command, buffers output, prints in submission order, and fails if any child fails:

```jsonc
"check:all:quick": "tsx scripts/run-parallel-checks.ts check:types check:lint check:deps check:knip check:input-schemas check:prettier"
```

Generate before consumers, not concurrently with them. Do not add an orchestrator merely because a repo has several cheap checks.

## 5. Architecture boundaries

- **dependency-cruiser:** encode allowed module/layer edges, cycles, production-to-dev dependency restrictions, and production-to-test import bans. For example, a data layer may depend on the domain layer but not the HTTP adapter. Choose cycle severity deliberately rather than assuming every cycle has equal impact.
- **ESLint:** use custom rules or `no-restricted-imports` for import-shape constraints: no internal imports through a library's own public index, no deep imports into private directories, or narrowly scoped migration rules such as handlers reaching the HTTP layer only through the data layer.
- Document the reason in rule `comment` / `message` fields. Use errors for genuine violations, warnings for advisory signals; avoid suppressions that hide whole categories.

## 6. Schema and contract drift

An internal TypeBox input schema and an external MCP/OpenAPI schema are a typical pair. Prefer shared generation; otherwise validate the intended subset/compatibility relationship in a task such as `check:input-schemas` inside the aggregate gate. Test actual wire representations. TypeScript assignability alone does not prove runtime schema compatibility.

## Local enforcement and CI

- **Pre-commit:** a fast formatting check, or lint-staged with Prettier `--write` configured to preserve partial staging.
- **Pre-push:** `npm run check:all`.
- **Hook bootstrap:** reuse the existing manager; for Husky, `prepare` installs hooks after dependency installation. Do not add a second manager for the same Git path without a concrete reason.
- **Non-interactive PATH:** a shared `scripts/with-node.sh` (or equivalent) ensures the selected Node is available when an IDE did not load shell profiles.
- **jj:** verify its push integration explicitly; installing Husky or Lefthook alone does not prove `jj git push` invokes the gate.
- **CI:** install the declared runtime and locked dependencies, then invoke `npm run check:all` rather than copying each check into YAML. Add test/build/service jobs as required, documenting any CI-only coverage.

## Audit files

Read `package.json` (especially `pre*`/`post*`/`prepare` and `check:*`), lockfiles, `tsconfig`, ESLint/Prettier/dependency-cruiser/knip configuration, generators, env templates/validation, hooks, bootstrap, and CI. Confirm configured entries actually cover the repo rather than accepting default configuration as proof of enforcement.
