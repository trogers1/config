/**
 * Package-manager cache paths that the dependency-mutator profile may waive
 * at the sandbox kernel layer. Direct access remains Pi Guard-gated.
 */
/** Go's macOS compiler cache is required by local `go build`, `go run`, and `go test`. */
const goBuildCacheSandboxWritePaths = [
  "~/Library/Caches/go-build",
  "~/Library/Caches/go-build/**",
] as const;

/** Go records module metadata even for an already-cached local build. */
const goModuleCacheSandboxWritePaths = [
  "~/go/pkg/mod",
  "~/go/pkg/mod/**",
  "~/go/pkg/sumdb",
  "~/go/pkg/sumdb/**",
] as const;

/** All writable Go toolchain state required by ordinary local builds. */
export const goToolchainCacheSandboxWritePaths = [
  ...goBuildCacheSandboxWritePaths,
  ...goModuleCacheSandboxWritePaths,
] as const;

/** Absolute-home cache roots granted to the sandboxed dependency process. */
export const dependencyCacheSandboxWritePaths = [
  ...goToolchainCacheSandboxWritePaths,
  "~/.npm",
  "~/.npm/**",
  "~/.cache/pnpm",
  "~/.cache/pnpm/**",
  "~/Library/pnpm/store",
  "~/Library/pnpm/store/**",
  "~/.cache/yarn",
  "~/.cache/yarn/**",
  "~/.bun/install/cache",
  "~/.bun/install/cache/**",
  "~/.cache/pip",
  "~/.cache/pip/**",
  "~/.m2/repository",
  "~/.m2/repository/**",
  "~/.gradle/caches",
  "~/.gradle/caches/**",
] as const;

export const dependencyCacheKernelWaiver = [
  "**/.npm",
  "**/.npm/**",
  "**/.cache/pnpm",
  "**/.cache/pnpm/**",
  "**/Library/pnpm/store",
  "**/Library/pnpm/store/**",
  "**/.cache/yarn",
  "**/.cache/yarn/**",
  "**/.bun/install/cache",
  "**/.bun/install/cache/**",
  "**/.cache/pip",
  "**/.cache/pip/**",
  "**/go/pkg/mod",
  "**/go/pkg/mod/**",
  "**/go/pkg/sumdb",
  "**/go/pkg/sumdb/**",
  "**/.m2/repository",
  "**/.m2/repository/**",
  "**/.gradle/caches",
  "**/.gradle/caches/**",
] as const;
