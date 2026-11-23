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

Use this skill when Taylor asks you to check that appropriate guardrails are in place, or to add the ones that are missing. Guardrails are automated, fail-loud checks that surface mistakes locally and in CI rather than in production.

A guardrail belongs at the **lowest level that can enforce it cheaply** and must run automatically: through lifecycle wiring, installed hooks, or required CI checks. A command that only runs when someone remembers is not a guardrail. Editor integration is convenience, not enforcement.

## Start With the Repo's Tooling

Identify the languages, workspace layout, existing task runner, bootstrap, hooks, and CI before choosing tools. Read the relevant references before implementing:

- [TypeScript / Node](references/typescript-node.md) — compiler, ESLint, Prettier, dependency-cruiser, knip, npm lifecycle and hooks.
- [Rust](references/rust.md) — Cargo, rustfmt, Clippy, crate boundaries, toolchains, task wiring and hooks.
- [Go](references/go.md) — gofmt, vet, modules/workspaces, generation, package boundaries, toolchains and explicit check gates.

These references are worked examples, not the list of supported languages or mandatory tool bundles. This skill applies to any language. For mixed-language repos, compose the applicable gates, including languages not covered by a reference. Do not add npm to a Rust-only repo or a new task runner when the existing one suffices.

### Translate guarantees, not tool names

For each concept below:

1. **State the design guarantee and applicability.** For example, “domain code cannot depend on transport adapters,” not “install dependency-cruiser.” Identify the failure this project could actually experience.
2. **Inspect existing/native enforcement.** Compiler rules, visibility, package layout, build dependencies, and standard tooling may already guarantee it. Verify their scope before adding another check.
3. **Choose the language-appropriate mechanism.** Prefer maintained, idiomatic tools compatible with the repo's versions and build system. Read project configuration and relevant tool documentation to verify behavior; do not guess command flags or assume a similarly named tool has equivalent guarantees.
4. **Wire and verify it.** Put the check at the earliest practical automatic boundary and exercise its real entry point. Where practical, introduce a controlled violation in a disposable fixture/worktree and confirm the gate rejects it, without disturbing user changes.
5. **Record limitations.** If no reliable equivalent exists, state what remains unenforced and why. Use a narrower honest check or a justified small custom validator when worthwhile; do not invent a tool, force a foreign ecosystem, or claim example-based testing proves a stronger property.

An interpreted language may have no compile-time type gate; a compiled language may already enforce private-module imports; a public library may not know which exported APIs consumers use. The desired design properties stay consistent, but enforcement and applicability differ. Mark genuine non-applicability separately from a missing applicable guardrail.

Names such as `check:types`, `check:all`, and `fix:lint` describe **roles**, not mandatory syntax. Preserve idiomatic task names. Checks must not rewrite sources/manifests; fixes may mutate them. Build caches are not source mutations. Keep checks independently runnable and compose them into one authoritative aggregate gate.

## Guardrail Categories

### 1. Static correctness and formatting

Establish the applicable baseline:

- **Compiler/type checks:** reject invalid code under deliberate strictness settings and supported build configurations.
- **Lint:** catch likely mistakes and enforce justified project conventions. Select rules deliberately rather than enabling every available restriction.
- **Formatting:** use the language's standard formatter with a read-only check and a separate repair command. Prefer defaults over extensive style customization.
- **Dependency policy:** enforce dependency resolution, dependency kinds, and any required source/license/advisory policies. Distinguish built-in package-manager guarantees from additional checks.
- **Unused surface:** detect unused code, exports, and dependencies where tooling supports it. Know the limits: a public API may be consumed outside the repo, and conditional code can produce false positives.

Wire the checks into the automatic gate. Avoid duplicate work when one tool already performs another check over the same configuration. Choose features/platforms/targets from the supported matrix; a broad-sounding flag is not proof of complete coverage.

### 2. Generated-artifact freshness

When sources generate bindings, schemas, types, or other artifacts, prevent consumers from using stale output:

- Prefer native build integration for build-local generated artifacts, with correct input tracking and outputs outside hand-maintained source directories.
- For checked-in outputs, provide deterministic generation plus a freshness check covering changed, added, and deleted owned files. Generate in a temporary directory or disposable checkout so the check does not rewrite a developer's tree.
- Compose generators before consumers. Aggregate multiple generators through the existing task runner.
- Make ownership explicit: never hand-edit generated output. Exclude it from lint/format only deliberately; otherwise make generation produce the expected formatted output.

If derived artifacts exist without automatic generation or freshness enforcement, add the missing gate. Do not add generation machinery to a repo with nothing generated.

### 3. Environment and runtime preflight

Check real prerequisites at the boundary that needs them:

- **Runtime/toolchain:** declare supported versions and provision required compiler/formatter/linter components. Pin an exact version when reproducibility or version skew is a real failure mode; distinguish a minimum supported version from the active development version.
- **Native and extra check tools:** declare installation requirements and pin separately installed check tools where reproducibility matters. Provision them in bootstrap/CI, not by silently downloading them during checks or commits.
- **External services:** before dependent integration tests, perform a bounded real round-trip (e.g. set/get/delete against a cache). Keep unrelated static checks independent of service availability.
- **Configuration/secrets:** derive required settings from the repo's source of truth (e.g. `.env.template` and validation schema). Materialize configuration explicitly, fail on missing required values, and never embed runtime secrets into generated code or build artifacts.
- **Dependency patches:** use reproducible, version-controlled patch mechanisms and verify the resolved dependency actually uses the patch. Never rely on edits to a machine-local package cache.

Add only checks that match the repo's actual failure modes. A service-free library does not need connectivity preflight. A shell PATH change alone does not install a missing toolchain.

### 4. Gate composition and parallelization

Keep one full gate for hooks and CI, with an optional quick subset for tight feedback loops. Generation must precede consumers; preflight must precede dependent tests. A quick gate that skips freshness is not equivalent to the full gate.

When several independent checks make the gate slow, measure and then use the existing runner to parallelize them. Buffer or label output deterministically and propagate every failure. Respect native build-system parallelism and cache locks; concurrent compiler invocations can duplicate work or serialize rather than speed anything up.

### 5. Architecture boundaries

Enforce design constraints at the strongest available layer:

- **Native boundaries first:** package/crate/module layout, visibility, and dependency kinds can make forbidden dependencies impossible.
- **Dependency graph rules:** enforce allowed layer edges, production vs. test dependencies, and cycle constraints not already guaranteed by the toolchain. Inspect real metadata rather than maintaining a parallel graph by hand.
- **Import/API rules:** use a linter or syntax-aware check for constraints the graph cannot express, such as banned APIs, deep imports, or scoped migration rules.

A general linter or dependency vulnerability scanner is not automatically an architecture checker. Distinguish module-level and package-level guarantees. Scope incremental rules narrowly and explain why they exist. Avoid text-search checks that confuse comments, aliases, or re-exports with semantic dependencies.

### 6. Schema and contract drift

When two representations describe the same boundary (internal model/schema vs. external JSON Schema, OpenAPI, protobuf, etc.), prefer deriving them from one source of truth. Otherwise enforce the intended compatibility relationship, such as the internal accepted shape being a valid subset of the external contract.

Check serialization behavior, not just in-memory types: field renames, absent vs. nullable fields, enum representation, and unknown-field handling matter. Wire the compatibility task into the aggregate gate. A few valid fixtures do not prove schema inclusion; use an appropriate compatibility check or state the narrower guarantee honestly.

## Automatic Enforcement

### Local lifecycle and hooks

- **Before tests/builds:** use native lifecycle wiring when available; otherwise provide an explicit aggregate task and make hooks/CI call it. Do not claim a native test command runs checks it does not invoke.
- **Pre-commit:** keep it fast and formatting-focused. Prefer read-only checks; staged-file auto-fixing is acceptable only when it preserves partially staged work. Never blindly format and re-stage an entire workspace.
- **Pre-push:** run the full gate, or explicitly document any weaker local subset.
- **Bootstrap:** install hooks through the existing mechanism and verify tools are discoverable from non-interactive IDE environments. Fail with actionable repair instructions rather than installing tools during a commit.
- **Multiple VCS workflows:** verify Git and jj push paths separately when both are used. Do not assume a Git hook manager intercepts `jj git push`; use supported integration or a documented checked push task, plus required CI.

### CI parity

CI must invoke the same aggregate gate as local checks instead of copying its command list into YAML. Add separate platform/feature/minimum-version jobs and integration checks where the supported matrix requires them.

The contract is: **local full-gate green should imply CI's equivalent baseline checks pass**. Document configurations or infrastructure that only CI covers; local green is not a claim to cover those. Provision toolchains and external tools reproducibly before running the gate; caches must never substitute for installation or skip checks.

## Audit Workflow

1. **Discover tooling and callers.** Read manifests, workspace definitions, task scripts, bootstrap, hooks, and CI. Load the applicable language references. Identify the full gate, quick subset, and automatic callers; flag checks that are only documented/manual.
2. **Check static coverage.** Compiler strictness, lint, formatting, dependency policy, unused-surface checks, and supported configurations. Distinguish missing guarantees from guarantees already supplied by the native toolchain.
3. **Check generation.** Find derived files, generator inputs/outputs, native build integration, and checked-in artifact freshness. Can a source/schema edit leave stale output while the gate passes?
4. **Check preflight.** Version constraints, component provisioning, native tools, lockfile/patch policy, required configuration, and real external dependencies. Are failures actionable and checks placed before the work that requires them?
5. **Check boundaries.** Does visibility/package layout enforce the intended design? Do graph/import rules encode actual project layers? Are test-only dependencies isolated and incremental rules narrowly scoped?
6. **Check contracts.** Find internal/external shape pairs. Are they derived from one source, or is compatibility enforced with a clearly stated guarantee?
7. **Check gate composition.** Are required checks aggregated, ordered correctly, and fail-loud? Is parallelism safe and useful? Are suppressions narrow and justified?
8. **Check local enforcement.** Do installed hooks invoke the intended tasks, preserve partial staging, and work outside interactive shells? Verify each supported VCS path.
9. **Check CI parity.** Does CI use the same baseline gate with reproducible provisioning? Are matrix-only guarantees documented? Are CI-only baseline checks missing locally?

Report each applicable guarantee as ✅ enforced / ⚠️ partially enforced / ❌ missing, naming the mechanism, automatic entry point, relevant file, and any limitation or proposed change. Mark genuinely inapplicable concepts as N/A with a reason; absence of a preferred tool is not itself a missing guarantee. Then add missing guardrails, smallest correct change first, and verify each through the repo's actual check entry point.

## Adding Guardrails

- Add one guardrail per atomic change and run the relevant check after each. Use the full gate before declaring completion.
- Compose existing commands rather than implementing parallel versions. Keep checks non-mutating and fixes explicit; do not rename native commands solely to match this skill's naming examples.
- Select severity deliberately and understand gate-wide warning promotion. Avoid broad suppressions; document narrowly justified false positives.
- Explain non-obvious rules in configuration, lint messages, or nearby documentation. A rule with no rationale gets deleted.
- Keep the gate tolerably fast without weakening its guarantees; split quick/full tasks or parallelize independent work only when useful.

## What This Skill Is Not

- Not a testing skill — test *design* belongs to `testing`; this skill governs the gate that runs tests and checks.
- Not a deploy/release pipeline builder — it covers the check stage CI consumes.
- Not “add every guardrail everywhere.” Applicability follows real failure modes, not repo size. A small crate with a hand-maintained external contract needs drift checks; a large repo without generated artifacts does not need generation machinery.
