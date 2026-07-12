---
name: guardrails
description: >-
  Audits a repo for the guardrails that keep code from drifting, breaking, or
  shipping unverified — static checks, generated-artifact freshness, env/runtime
  preflight, git hooks, and architecture-boundary rules — and adds the missing
  ones. Use when reviewing a repo's safety net, hardening a new repo, or wiring
  checks into lifecycle scripts and hooks.
---

# Guardrails

Use this skill when Taylor asks you to check that appropriate guardrails are in place, or to add the ones that are missing. "Guardrails" here means the automated, fail-loud machinery that runs *before* code is executed, committed, pushed, or shipped — so mistakes surface locally and in CI instead of in production.

Default rule: a guardrail belongs at the *lowest* level that can enforce it cheaply, and it must run automatically — wired into a lifecycle script (`pretest`, `prestart`, `prebuild`, `postinstall`, `prepare`) or a git hook (`pre-commit`, `pre-push`). A check that only runs when someone remembers is not a guardrail.

## Guardrail Categories

### 1. Static checks (`check:*` family)

The baseline. Every TS repo should have these as named `check:*` scripts so they can be composed and run independently:

- `check:types` — `tsc --noEmit`. Strict mode in `tsconfig.json` (`strict`, `noUnusedLocals`, `noUnusedParameters`, `isolatedModules`, `forceConsistentCasingInFileNames`).
- `check:lint` — `eslint .` with `typescript-eslint` recommended. Add repo-specific architecture rules as custom ESLint rules (see §5).
- `check:prettier` — `prettier --check .`. Shared `.prettierrc`.
- `check:deps` — `depcruise` against a `.dependency-cruiser.{js,cjs}` config. Enforces no-circular, no-orphans, no-deprecated, not-to-unresolvable, not-to-dev-dep (production code must not depend on devDependencies), and peer/optional dep awareness.
- `check:knip` — `knip` with an explicit `entry` + `project` so unused exports/dependencies fail loudly. Keeps the surface honest.

Wire them all into `pretest` so `npm test` cannot run against a broken tree:

```jsonc
"pretest": "npm run check:types && npm run check:lint && npm run check:prettier && npm run check:deps && npm run check:knip",
"test": "vitest run"
```

### 2. Generated-artifact freshness

If the repo derives code from a source of truth (OpenAPI → types, protobuf, schema → types), generation is a guardrail: the derived files must be regenerated from sources before any build/test, or they silently drift. Typical pattern:

- `generate:all` aggregates every generator (e.g. `generate:openapi`).
- `prestart`, `build`, and `pretest` all invoke `npm run generate:all` first.
- Generated files are gitignored and/or marked `*.generated.ts` so they're never hand-edited and can be excluded from lint/format.

If a repo has generated artifacts but no generation step in its lifecycle scripts, that's a missing guardrail — add it.

### 3. Environment & runtime preflight

Checks that the world the code is about to run in is actually ready. Especially important for apps with external dependencies. Examples of the shape these take:

- **Node version** — `.nvmrc` pins the version; a small script (e.g. `scripts/check-node-version.ts`) asserts the running Node — and, optionally, the Docker base image — matches it. Run in `pretest`. Catches "works on my machine" version skew across local/CI/Docker.
- **External-service connectivity** — for any dependency the code needs at runtime (cache, DB, queue), a preflight check does a real round-trip (e.g. set/get/delete against a cache) before tests run, with a timeout. Run in `pretest`. Catches "tests fail because the service is down" vs "tests fail because the code is wrong."
- **Secrets/env** — `.env.template` is the source of truth for required env vars; a script materializes `.env` from a secrets store (e.g. AWS Secrets Manager, Vault), failing loud if a required key is missing. Catches missing config before runtime, not during a request.
- **Patched dependencies** — if the repo patches deps, `postinstall` runs `patch-package` so patches are guaranteed present after every install.

Add the preflight checks that match the repo's real failure modes. Don't add a cache check to a package with no cache.

### 4. Parallelization

When the static check set grows past ~3 independent scripts, run them concurrently but keep output deterministic. A `run-parallel-checks.ts` could spawn each `npm run <check>` as a child process, buffer output, and print results in submission order. If checks grow too large, use it:

```jsonc
"check:all": "npm run generate:all && npm run check:all:quick",
"check:all:quick": "tsx scripts/run-parallel-checks.ts check:types check:lint check:deps check:knip check:input-schemas check:prettier"
```

`check:all:quick` is the fast path (no generation) for tight feedback loops; `check:all` is the full pre-push gate.

### 5. Architecture-boundary rules

Static checks catch syntax/type errors; boundary rules catch *design* drift. Express them in two layers:

- **dependency-cruiser** (`check:deps`) — module/layer boundaries. Examples: `no-circular` (error for apps, often `warn` for small libraries — choose deliberately), a rule that a given layer may only import from itself plus approved neighbors (e.g. a data layer that must not reach into the HTTP layer), `not-to-dev-dep` (production code must not depend on devDependencies), and `not-to-spec` (production code must not import test files).
- **ESLint custom rules** — import-shape rules dep-cruiser can't express. Examples: a rule that files inside a library's own directory must not import via that library's public index (it hides whether an export is really used externally), `no-restricted-imports` banning deep imports into internal directories, and a `no-restricted-imports` rule enforcing an incremental migration constraint like "handlers must not import from the HTTP layer directly; go through the data layer."

Boundary rules are the guardrails that let you refactor with confidence — they fail loud the moment a layering rule is violated, instead of letting the architecture rot silently. When adding a new architectural rule, prefer dep-cruiser for "X must not depend on Y" and ESLint for "don't import via path shape Z."

### 6. Schema/contract drift

When the repo has two representations of the same shape (e.g. an internal TypeBox input schema vs. an external MCP/OpenAPI tool schema), assert the internal one is a *valid subset* of the external one. A `validate-schemas.ts` could run as `check:input-schemas` inside `check:all:quick`. This is the same drift-protection philosophy as the `testing` skill's boundary schema, applied across an internal/external contract pair.

Add this whenever a hand-maintained schema must stay compatible with a generated or externally-owned one.

## Git Hooks

Guardrails only work if they run. Wire `check:all` (or at least the fast `check:all:quick`) into hooks:

- **`pre-commit`** — fast, local, formatting-focused. You can use `lint-staged` (prettier `--write` on staged files) so commits aren't blocked on full checks.
- **`pre-push`** — the full gate. `npm run check:all`.
- **Both VCS hooks** — if the repo is used with both `git` and `jj`, install *both* husky (`.husky/pre-push`) and lefthook (`lefthook.yml`, `pre-push` → `./scripts/with-node.sh npm run check:all`). You can do this if you want to support jj, because jj's push path doesn't trigger husky.
- **`prepare`** — `husky` so hooks install automatically after `npm install`.

`scripts/with-node.sh` (or equivalent) ensures Node is on PATH when the hook fires from an IDE that didn't load the shell profile.

## CI

The same `check:all` the hooks run locally must run in CI, plus the things only CI can do (integration tests against real services, Docker build, deploy gates). Generally, CI config files like `.gitlab-ci.yml` should mirror the local script set. The guardrail contract is: **local `check:all` passing should mean CI's check stage passes.** If CI runs checks the local hooks don't, either add them locally or accept that local green is a weaker signal.

## Audit Workflow

When asked to check guardrails on a repo:

1. **Read the lifecycle scripts.** `cat package.json` and list every `pre*`/`post*`/`prepare` script. These are where guardrails live. Note which `check:*` scripts exist and whether `pretest`/`prestart`/`build` actually invoke them.
2. **Check for generation.** Are there `*.generated.ts` / derived files? Is there a `generate:*` script, and is it in `prestart`/`build`/`pretest`?
3. **Check for preflight.** External deps (DB, cache, APIs)? Node version pinned (`.nvmrc`) and asserted? Env template present and complete?
4. **Read the dep-cruiser config.** Is it just the boilerplate, or does it encode real boundary rules for this repo's layers? Are severities `error` where they matter?
5. **Read the ESLint config.** Recommended only, or custom architecture rules? Any `no-restricted-imports` guarding layering?
6. **Check knip config.** Does `entry`/`project` actually cover the code, or is it default (which misses things)?
7. **Check hooks.** `.husky/`, `lefthook.yml`, `lint-staged`. Is `check:all` wired into `pre-push`? Is `prepare` set so hooks auto-install?
8. **Check CI.** Does it run the same `check:all`? Are there CI-only checks that should be local too?
9. **Check for contract pairs.** Internal schema + external schema that must stay compatible? Add a subset-validation check.

Report findings as: ✅ present / ⚠️ present but weak / ❌ missing, each with the specific file and what to change. Then add the missing ones, smallest correct change first, and verify each with the repo's actual check command.

## Adding Guardrails

- Add one guardrail per atomic change. Run the relevant `check:*` after each.
- Prefer composing existing `check:*` scripts over inlining commands — keep each check independently runnable.
- Set severity deliberately: `error` for rules that mean "this is wrong," `warn` for "look at this." Don't make everything an error or developers learn to ignore the noise.
- Document *why* a non-obvious rule exists, in its `comment` (dep-cruiser) or `message` (ESLint) or a short `docs/` note explaining the convention it enforces. A rule with no rationale gets deleted.
- When adding a boundary rule as part of an incremental migration (e.g. "only this module is migrated for now; broaden later"), scope it narrowly to the affected paths and leave a comment saying so.
- Keep `pretest` fast enough to tolerate. If it grows slow, parallelize with `run-parallel-checks.ts` and split a `check:all:quick` (no generation) from `check:all` (full).

## What This Skill Is Not

- Not a testing skill — test *design* is the `testing` skill. This skill is about the *gate* that runs the tests and the checks around them.
- Not a CI/CD pipeline builder — it covers the check stage that CI consumes, not deploy/release orchestration.
- Not "add every guardrail everywhere." The trigger for each guardrail is the *failure mode it prevents*, not the repo's size — each section above states its own applicability condition, and that condition is the decision driver. Repo scale mainly governs §2 (only if there are derived artifacts) and §3 (only if there are external dependencies). §1, §4, §5, and §6 apply to small libraries too the moment their condition is met: a small package with a hand-maintained schema still needs §6, and one with a 5-check `pretest` chain is a candidate for §4. The real over-guarding sin is adding a guardrail for a failure mode the repo doesn't have (a cache check with no cache, a generation step with no generated artifacts) — not adding a guardrail to a small repo that genuinely needs it.
