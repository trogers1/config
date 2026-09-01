/**
 * Package-manager cache paths that the dependency-mutator profile may waive
 * at the sandbox kernel layer. Direct access remains Pi Guard-gated.
 */
/** Absolute-home cache roots granted to the sandboxed dependency process. */
export const dependencyCacheSandboxWritePaths = [
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
  "~/go/pkg/mod",
  "~/go/pkg/mod/**",
  "~/go/pkg/sumdb",
  "~/go/pkg/sumdb/**",
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
