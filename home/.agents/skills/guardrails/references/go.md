# Go Guardrails

Apply the concepts in [the main skill](../SKILL.md) using the Go toolchain and the repo's existing scripts, Makefile, Taskfile, or other runner. Do not introduce npm or a new runner solely to host checks. The standard toolchain covers many basics, but not every design guarantee.

## 1. Static correctness and formatting

| Role | Go implementation | Limits / choices |
| --- | --- | --- |
| Compiler/type checks | `go build -mod=readonly ./...` for production packages; `go test -mod=readonly ./...` also compiles tests | Go enforces types, unused imports, and unused local variables. There is no standalone standard `go check`; a test gate may already supply the required compilation. |
| Lint | `go vet -mod=readonly ./...`; add Staticcheck where broader analysis is needed | `go test` runs a selected subset of vet checks, not necessarily everything an explicit `go vet` runs. golangci-lint can compose additional linters when justified; do not enable every available rule or duplicate the same analyzers needlessly. |
| Formatting check | `gofmt -l` on owned Go source paths; fail if its output is nonempty | `gofmt -l` / `-d` can succeed even when files need formatting. Check their output as well as process failure. Repair with `gofmt -w` on the same paths. `go fmt ./...` mutates files and is not a check. |
| Dependency consistency/policy | `go mod tidy -diff` where supported; `go mod verify`; `govulncheck ./...` where vulnerability checks apply | Tidy diff checks go.mod/go.sum freshness without rewriting them. Verify detects changes to downloaded module-cache content, not vulnerabilities or allowed-layer violations. License/source/banned-dependency policies need additional tooling. |
| Unused surface | Compiler checks plus Staticcheck's unused-code analysis where applicable | The compiler does not reject every unused declaration. No standard check proves exported APIs are unused by downstream consumers. `go mod tidy -diff` covers module requirements, not the entire unused API surface. |

Prefer gofmt defaults. goimports adds import management and gofumpt adds stricter style; choose them deliberately rather than layering multiple conflicting formatter policies. Pin nonstandard tools and verify compatibility with the project's Go version.

A minimal read-only aggregate gate for a **single-module repo**, assuming the recursively scanned directory contains only owned Go files:

```sh
#!/usr/bin/env sh
# scripts/check.sh — hooks and CI invoke this; plain go test is not this gate.
set -eu
unformatted="$(gofmt -l .)"
if [ -n "$unformatted" ]; then
  printf 'Run gofmt on these files:\n%s\n' "$unformatted" >&2
  exit 1
fi
go mod tidy -diff
go vet -mod=readonly ./...
go test -mod=readonly ./...
```

Adapt formatting scope explicitly if the repo includes vendored, external, or specially managed generated files. gofmt's recursive directory scan is not the same selection as Go package discovery or build tags. Propagate formatter errors, not just nonempty output. Use the selected toolchain's documented flags; if tidy lacks `-diff`, check freshness in a disposable checkout instead of mutating the developer's tree.

**Module scope matters:** `./...` is not a universal multi-module workspace selector and does not cross nested module boundaries. For multi-module repos, derive the intended module set from `go.work` or existing workspace configuration, and run the applicable checks per module. Deliberately choose workspace mode vs. `GOWORK=off`; validate independently released modules without workspace replacements hiding missing requirements. Account for workspaces when choosing module flags, especially vendoring mode.

Select supported `GOOS`/`GOARCH`, build tags, cgo configurations, and test suites deliberately. `./...` only covers packages selected by the active build configuration. Add `go test -race ./...` where concurrency risk and platform/cgo support justify it; it detects races only on exercised paths. For live-service tests that must execute on every gate run, use `-count=1` rather than accepting cached successes.

## 2. Generated-artifact freshness

- **Native generation entry point:** `//go:generate` directives and `go generate ./...` describe and run generators. Go generate is **never automatically invoked by go build or go test**; wire it explicitly before consumers or use a checked-in-output freshness task.
- **Freshness:** run deterministic generation in a temporary directory/disposable checkout and compare every owned output, including additions and deletions. Checking only `git diff` misses newly generated untracked files. Do not regenerate the developer's tree in a read-only check.
- **Ownership/format:** use the standard `// Code generated ... DO NOT EDIT.` marker where appropriate. It documents ownership but does not automatically establish freshness or exclude files from all tools. Make generated Go meet the chosen formatting policy.
- **Prerequisites:** provision generators and external compilers (e.g. protoc) at deliberate versions in bootstrap/CI. For supported Go versions, tracked tool dependencies can supply generators through `go tool`; do not assume a directive pins a binary found on PATH.

Go has no general build-script equivalent that automatically tracks arbitrary generator inputs. Explicit task ordering and freshness checks supply that guarantee.

## 3. Environment and runtime preflight

- **Language/toolchain:** `go.mod`'s `go` directive declares the required minimum Go version/language semantics under modern toolchains. A `toolchain` directive suggests a toolchain; it is not an exact reproducibility lock. Declare workspace requirements in `go.work` deliberately. For exact CI/local parity, provision the chosen release explicitly and understand `GOTOOLCHAIN` automatic selection/download behavior. Do not silently depend on network toolchain downloads during a hook.
- **Dependencies:** track go.mod and go.sum. go.sum authenticates module content; it is **not** a conventional exact dependency lockfile. Module versions are selected from the module graph. Use read-only module mode where appropriate, and keep upgrades/tidy repairs separate from check tasks. Vendored repos need a deliberate vendor-consistency strategy and build mode rather than blindly applying `-mod=readonly` everywhere.
- **Extra tools:** on Go 1.24+, `tool` directives can track tool dependencies for `go tool`; provision them before offline checks. On older versions, use the existing tools module/bootstrap convention and pinned `go install module/path@version` commands during setup. Do not use `@latest` or install linters during commits. Tool dependencies can affect module resolution, so inspect their impact.
- **Native prerequisites:** declare any C compiler, system libraries, or cross-compilation prerequisites required by cgo and platform-specific code.
- **Services/config:** perform bounded real connectivity checks before dependent integration tests. Validate required configuration explicitly at startup/test setup; the standard toolchain does not load `.env`. Keep secrets out of generated code and embedded assets.
- **Patches:** use a tracked `replace` directive pointing to a deliberately versioned fork or checked-in local module, and verify the resolved graph (e.g. `go list -m -json all`). Never patch the module cache. Dependency modules' replace directives do not propagate to consumers; independently consumed libraries must not assume their local replacement changes downstream resolution.

## 4. Gate composition and parallelization

Go has no npm-style pretest/prepare lifecycle. Use the existing task runner to compose formatting, manifest/freshness checks, analysis, and tests; make hooks/CI call it. Plain `go test` does not imply formatting, generation, Staticcheck, or architecture checks ran.

The Go toolchain already parallelizes package builds/tests and caches results. Measure before launching overlapping build/vet/test processes. Parallelize genuinely independent checks with clear output and failure propagation; do not race module edits or generation against consumers. Keep a quick subset distinct from the full gate, and deliberately disable test caching for checks whose external state must be revalidated.

## 5. Architecture boundaries

- **Native guarantees:** package import cycles are rejected. Unexported identifiers are package-private; an `internal/` package can only be imported from within the tree rooted at the parent of `internal`. These are real boundaries, but do not express an arbitrary layer graph within that allowed tree.
- **Project layer rules:** inspect actual package imports with `go list -deps -json ./...`, adding test/build-configuration coverage as needed, or use a suitable analyzer. golangci-lint's depguard can enforce configured import restrictions where appropriate. Neither cycle rejection nor `internal/` automatically forbids domain → HTTP adapter edges.
- **Test isolation:** `_test.go` files are excluded from normal builds. External `package name_test` tests exercise exported APIs; internal-package tests can access unexported symbols. Go modules have no separate production/dev requirement sections: test/tool dependencies can share go.mod, so do not claim module metadata itself enforces dev-only dependency isolation. Check production package imports for that policy.
- **Custom rules:** when native boundaries and existing analyzers cannot express an important rule, prefer a narrow syntax/type-aware check (e.g. using go/analysis) over grep. Derive imports/configurations from package metadata rather than duplicating a hand-maintained graph.

## 6. Schema and contract drift

Go structs and JSON tags are not a complete wire schema or runtime validator. `encoding/json` normally ignores unknown object fields, and zero values, missing fields, nulls, pointers, `omitempty`, and custom marshalers/unmarshalers affect compatibility.

Prefer generating models/bindings from the actual OpenAPI/protobuf/schema source when practical, with deterministic pinned generators and freshness checks. Otherwise validate the intended compatibility relationship against actual serialization/decoding behavior. `Decoder.DisallowUnknownFields` can enforce one specific JSON policy; it does not validate required fields or prove schema equivalence. A few fixtures do not prove inclusion. Compose contract tests/checks into the gate and document what they establish.

## Local enforcement and CI

- **Pre-commit:** run a read-only formatter check that fails on both formatter errors and nonempty mismatch output. Do not format/re-stage the whole tree over partially staged work.
- **Pre-push:** invoke the same aggregate task as CI (e.g. `./scripts/check.sh`), with any additional architecture/security checks selected for the project.
- **Hook bootstrap:** reuse the existing manager or explicitly install checked-in hooks. Go builds do not install hooks automatically. Make the declared Go/tool binaries available in non-interactive IDE environments; fail with repair instructions rather than downloading tools during commits.
- **jj:** verify its push integration separately from Git hooks; manager installation alone does not establish enforcement.
- **CI:** provision the declared Go release, extra tools, native prerequisites, and dependencies, then invoke the shared gate. Add platform/build-tag/minimum-version/race jobs as justified; local baseline green does not claim coverage of CI-only configurations. Do not use a cache hit to skip installation or checks, or treat a cached integration test as fresh service verification.

## Audit files

Read go.mod/go.sum, go.work/workspace policy, vendor configuration if present, tool directives/bootstrap, generation directives and schemas, build tags/cgo requirements, analyzer configuration, env validation, the aggregate task, hooks, and CI. Confirm all intended modules/packages/build configurations are covered, tools are pinned/provisioned, and native guarantees are distinguished from missing custom enforcement.
