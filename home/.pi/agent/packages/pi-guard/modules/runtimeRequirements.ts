/** Audited runtime-only filesystem requirements. */
export type RuntimeRequirementDefinition = {
  readonly sandboxWritePaths: readonly string[];
  /** Direct Pi access remains denied even when a selected child needs these roots. */
  readonly protectedPathPatterns: readonly string[];
};

/** Vite creates this exact workspace directory while Vitest executes. */
export const vitestViteTemporaryWritePaths = [
  "node_modules/.vite-temp",
] as const;

/**
 * The ordered definitions are the single vocabulary and audit record. A Map
 * preserves the key union without an Object.keys assertion.
 */
const runtimeRequirementDefinitions = [
  [
    "go-toolchain-cache",
    {
      sandboxWritePaths: [
        "~/Library/Caches/go-build",
        "~/Library/Caches/go-build/**",
        "~/go/pkg/mod",
        "~/go/pkg/mod/**",
        "~/go/pkg/sumdb",
        "~/go/pkg/sumdb/**",
      ],
      protectedPathPatterns: [
        "**/Library/Caches/go-build",
        "**/Library/Caches/go-build/**",
        "**/go/pkg/mod",
        "**/go/pkg/mod/**",
        "**/go/pkg/sumdb",
        "**/go/pkg/sumdb/**",
      ],
    },
  ],
  [
    "vitest-vite-temp",
    {
      sandboxWritePaths: vitestViteTemporaryWritePaths,
      protectedPathPatterns: [],
    },
  ],
] as const satisfies readonly (readonly [
  string,
  RuntimeRequirementDefinition,
])[];

export type RuntimeRequirementName =
  (typeof runtimeRequirementDefinitions)[number][0];
export const runtimeRequirementNames = runtimeRequirementDefinitions.map(
  ([name]) => name,
);
const runtimeRequirementRegistry = new Map<
  RuntimeRequirementName,
  RuntimeRequirementDefinition
>(runtimeRequirementDefinitions);

export function isRuntimeRequirementName({
  value,
}: {
  readonly value: unknown;
}): boolean {
  return (
    typeof value === "string" &&
    runtimeRequirementNames.some((name) => name === value)
  );
}

export function runtimeRequirementDefinition({
  name,
}: {
  readonly name: RuntimeRequirementName;
}): RuntimeRequirementDefinition {
  const definition = runtimeRequirementRegistry.get(name);
  if (!definition) {
    throw new Error(`Unknown runtime requirement '${name}'`);
  }
  return definition;
}

/** Resolve only audited paths. Requirements are mandatory resolved state. */
export function resolveRuntimeRequirementWritePaths({
  requirements,
}: {
  readonly requirements: readonly RuntimeRequirementName[];
}): string[] {
  return requirements.flatMap(
    (name) => runtimeRequirementDefinition({ name }).sandboxWritePaths,
  );
}
