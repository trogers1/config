# Rust Guardrails

Apply the concepts in [the main skill](../SKILL.md) using Cargo and the repo's existing scripts, justfile, Makefile, or xtask. Do not add npm to a Rust-only project. Task names below describe roles, not mandatory naming.

## 1. Static correctness and formatting

| Role | Rust implementation | Limits / choices |
| --- | --- | --- |
| Type/compiler checks | `cargo check --workspace --all-targets` | Compiler-enforced types and ownership need no TS-style strict mode. Select supported features/platforms deliberately. |
| Lint | `cargo clippy --workspace --all-targets -- -D warnings` | Clippy also type-checks. Do not duplicate `cargo check` in the full gate unless it covers a distinct configuration. |
| Formatting check | `cargo fmt --all -- --check` | Mutating repair: `cargo fmt --all`. Prefer defaults; configure `rustfmt.toml` only for deliberate choices supported by the selected toolchain. |
| Dependency policy | Cargo's resolver plus project-specific metadata checks; `cargo deny check` where license/advisory/source/banned-dependency policies apply | Cargo rejects crate dependency cycles and keeps dev-dependencies out of normal builds. cargo-deny is not a general architecture checker. |
| Unused surface | Compiler `dead_code` / `unused_imports`; `cargo machete` for unused manifest dependencies where needed | No direct knip equivalent proving public APIs are unused downstream. Review conditional dependencies and document specific false positives. |

Configure justified Rust/Clippy policies in `[workspace.lints.rust]` / `[workspace.lints.clippy]`; member crates opt in with `[lints] workspace = true`. `-D warnings` promotes all emitted warnings, so keep enabled rules deliberate. Avoid enabling every pedantic/restriction lint or suppressing whole categories. Native lint levels are `allow`, `warn`, `deny`, and `forbid`; explain exceptions near their configuration/attributes.

Use the supported feature/target matrix: `--all-features` may select mutually exclusive features, and `--all-targets` means target kinds, not every platform triple. `cargo test --all-targets` omits doctests; keep doctest coverage explicit if selecting test targets.

A minimal aggregate gate for a workspace with a committed `Cargo.lock`:

```sh
#!/usr/bin/env sh
# scripts/check.sh — hooks and CI invoke this; plain cargo test does not.
set -eu
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

Adapt this to the existing runner instead of maintaining a parallel shell implementation. Use `--locked` where the lockfile is committed; omit it otherwise. Checks may populate build caches but must not rewrite source/manifests. Provision extra tools such as cargo-deny/cargo-machete at pinned versions through bootstrap/CI, not by downloading them inside check tasks.

## 2. Generated-artifact freshness

- **Build-local generation:** use `build.rs` for appropriate compile-time generation (e.g. prost/tonic bindings or bindgen), writing into `OUT_DIR`. Declare accurate `cargo::rerun-if-changed` / `cargo::rerun-if-env-changed` inputs, using syntax supported by the project's minimum Rust version. Do not write generated source into the checkout from `build.rs`.
- **Checked-in generation:** expose a task such as an existing `cargo xtask generate`. Check freshness by generating into a temporary directory and comparing all owned outputs, including added/deleted files, or regenerate in a disposable checkout and inspect both diffs and untracked outputs.
- **Prerequisites/format:** provision external generators such as protoc/libclang explicitly. Make output deterministic and agree on formatter integration rather than blanket-excluding generated Rust to hide drift.

Wire generation/freshness before consumers in the aggregate gate. A quick task that skips it is not the full gate.

## 3. Environment and runtime preflight

- **Active toolchain:** declare `rust-toolchain.toml` with the chosen channel and `components = ["rustfmt", "clippy"]`. Pin an exact release when reproducible formatter/linter behavior matters. Derive the version from the project; never copy a particular release from this skill.
- **Minimum version:** `package.rust-version` declares MSRV, not the active toolchain. A library promising an MSRV needs a separate compatibility job on that version.
- **Native prerequisites:** provision required targets, C compiler, pkg-config, protoc, libclang, or native libraries according to real dependencies. Toolchain selection alone does not provide them.
- **Services/config:** run bounded connectivity checks before dependent integration tests; validate settings at startup/test setup. Cargo does not automatically load `.env`. Do not put runtime-service preflight in `build.rs` or embed runtime secrets via compile-time constants.
- **Patches:** use `[patch.crates-io]` (or the relevant source) with a tracked path dependency or deliberately pinned Git revision, plus a lockfile where tracked. Verify the resolved dependency selects the patch: it still participates in version resolution. Never edit Cargo's registry cache as a patch strategy.

Keep machine-local `.cargo` / `.rustup` installations outside version control; project `.cargo/config.toml` is a separate, legitimate project configuration file.

## 4. Gate composition and parallelization

Cargo has no npm-style general `pretest`/`prepare` lifecycle. Explicitly compose the check/test gate and make hooks/CI call it. Do not claim `cargo test` invokes rustfmt or Clippy. Keep a fast developer command or quick task where useful.

Cargo already parallelizes compilation. Concurrent check/Clippy/test invocations sharing a target directory may serialize on locks or duplicate work. Prefer a sequential compiler/test gate unless measurement justifies otherwise; rustfmt and independent manifest-policy checks may run concurrently through the existing runner, with labeled/buffered output and failure propagation. Generation must finish before consumers.

## 5. Architecture boundaries

- **Crate/layer graph:** use workspace crates for independently enforceable layers. Cargo rejects crate dependency cycles; an allowlist check over `cargo metadata --format-version 1` can reject forbidden direct edges such as domain → HTTP adapter. Inspect dependency kinds and target conditions deliberately. Cargo does not know your intended architecture; Rust module cycles are not equivalent to crate dependency cycles.
- **Visibility:** prefer private modules and `pub(crate)` / `pub(super)` / `pub(in ...)` over custom checks when they express the rule.
- **Import/API rules:** Clippy's configurable `disallowed_types`, `disallowed_methods`, and `disallowed_macros` can ban specific APIs, but are not a general module-layer checker. For incremental migration rules that visibility cannot express, add a narrowly scoped syntax-aware check/custom lint only when justified. Avoid grep-based semantic claims.
- **Test isolation:** put test-only crates in `[dev-dependencies]` and test-only modules behind `#[cfg(test)]`. Merely calling a helper a test helper does not prevent production compilation.

Document boundary rationale in lint configuration, validation errors, or adjacent docs. Treat cargo-deny supply-chain policy separately from layer-graph policy.

## 6. Schema and contract drift

Serde structs/enums plus external JSON Schema/OpenAPI/protobuf definitions form contract pairs. Prefer common-source derivation/generation (e.g. schemars/utoipa where suitable), but verify derived schemas reflect actual serialization configuration.

Otherwise add compatibility validation against the real boundary, including field renames, optional vs. nullable values, enum tagging, and unknown-field handling. A few valid fixtures do not prove inclusion; use a suitable compatibility check or state the narrower guarantee. Compile-time Rust types alone do not validate incoming serialized data. Compose dedicated contract tasks/tests into the gate.

## Local enforcement and CI

- **Pre-commit:** `cargo fmt --all -- --check`. Do not auto-format and re-stage an entire workspace over partially staged changes; offer `cargo fmt --all` as a separate repair.
- **Pre-push:** invoke the shared aggregate task (e.g. `./scripts/check.sh`).
- **Hook bootstrap:** reuse the existing manager or explicitly install checked-in hooks (e.g. documented `core.hooksPath`). Cargo has no `prepare`; no hook is installed just by running `cargo build`.
- **Non-interactive PATH:** shared hook bootstrap can prepend `${CARGO_HOME:-$HOME/.cargo}/bin`; fail with actionable rustup/component instructions if tools remain unavailable. Do not rely on interactive profiles or install tools during commits.
- **jj:** verify its actual push integration separately from Git hooks. Neither Husky nor Lefthook alone proves enforcement on `jj git push`.
- **CI:** provision the declared toolchain/components, pinned extra check tools, and needed native libraries, then call the same aggregate task as local pre-push. Do not duplicate its command list in YAML. Add supported feature/platform/MSRV jobs where promised; document coverage unavailable in the local baseline. Respect tracked lockfiles with `--locked`; a cache hit must not skip provisioning/checks.

## Audit files

Read workspace/member `Cargo.toml`, `Cargo.lock` policy, `rust-toolchain.toml`, `.cargo/config.toml`, rustfmt/Clippy configuration, `build.rs`, generator tasks, native prerequisites, env validation, hook bootstrap, the task runner, and CI. Confirm member lint inheritance and supported feature/target coverage rather than treating workspace-wide configuration as automatically active everywhere.
