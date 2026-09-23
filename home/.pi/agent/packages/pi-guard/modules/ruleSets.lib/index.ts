import type { ProfilePolicy } from "../policyHelpers";
import type { RuntimeRequirementName } from "../runtimeRequirements";
import { defaultGitRules, gitCommitRules, gitRefsRules } from "./git";
import { defaultGuardRules } from "./guards";
import { defaultProtectedPathRules } from "../protectedPaths";
import {
  dependencyMutationAllowRules,
  dependencyMutationGuardRules,
  packageManagerRules,
} from "./packageManagers";
import { goTestRules } from "./go";
import { typeScriptNodeTestRules } from "./node";
import { rustTestRules } from "./rust";
import { vitestRules } from "./vitest";
import {
  defaultReadPaths,
  defaultWritePaths,
  docsWritePathRules,
  readOnlyPathRules,
  readOnlyWritePathRules,
  testFilePatterns,
  testWriteProtectionRules,
} from "./paths";
import { defaultShellRules, readOnlyShellRules } from "./shell";

type RuleSetPolicy = Partial<
  Pick<
    ProfilePolicy,
    "tools" | "readPaths" | "writePaths" | "protectedPathRules"
  >
>;
export type RuleSetDefinition = {
  readonly policy: RuleSetPolicy;
  readonly runtimeRequirements: readonly RuntimeRequirementName[];
};

/** Registry-derived names prevent a declaration from drifting from the catalog. */
export const ruleSetRegistry = {
  "ruleset:shell": {
    policy: { tools: { bash: defaultShellRules } },
    runtimeRequirements: [],
  },
  "ruleset:git": {
    policy: { tools: { bash: defaultGitRules } },
    runtimeRequirements: [],
  },
  "ruleset:packageManagers": {
    policy: { tools: { bash: packageManagerRules } },
    runtimeRequirements: [],
  },
  "ruleset:deps-mutations-guard": {
    policy: { tools: { bash: dependencyMutationGuardRules } },
    runtimeRequirements: [],
  },
  "ruleset:deps-mutations-allow": {
    policy: { tools: { bash: dependencyMutationAllowRules } },
    runtimeRequirements: [],
  },
  "ruleset:shell-guards": {
    policy: { tools: { bash: defaultGuardRules } },
    runtimeRequirements: [],
  },
  "ruleset:path-guards": {
    policy: {
      readPaths: defaultReadPaths(),
      writePaths: defaultWritePaths(),
      protectedPathRules: defaultProtectedPathRules,
    },
    runtimeRequirements: [],
  },
  "ruleset:read-only-shell": {
    policy: { tools: { bash: readOnlyShellRules } },
    runtimeRequirements: [],
  },
  "ruleset:read-only-path": {
    policy: {
      readPaths: readOnlyPathRules,
      writePaths: readOnlyWritePathRules,
      protectedPathRules: defaultProtectedPathRules,
    },
    runtimeRequirements: [],
  },
  "ruleset:git-commit": {
    policy: {
      tools: { bash: gitCommitRules },
      writePaths: [{ pattern: "/dev/null", decision: "allow" }],
    },
    runtimeRequirements: [],
  },
  "ruleset:git-refs": {
    policy: { tools: { bash: gitRefsRules } },
    runtimeRequirements: [],
  },
  "ruleset:go-runtime-commands": {
    policy: { tools: { bash: goTestRules } },
    runtimeRequirements: ["go-toolchain-cache"],
  },
  "ruleset:typescript-node-test": {
    policy: { tools: { bash: typeScriptNodeTestRules } },
    runtimeRequirements: [],
  },
  "ruleset:rust-test": {
    policy: { tools: { bash: rustTestRules } },
    runtimeRequirements: [],
  },
  "ruleset:vitest": {
    policy: { tools: { bash: vitestRules } },
    runtimeRequirements: ["vitest-vite-temp"],
  },
  "ruleset:docs-write": {
    policy: { writePaths: docsWritePathRules },
    runtimeRequirements: [],
  },
  "ruleset:test-write-protection": {
    policy: { writePaths: testWriteProtectionRules },
    runtimeRequirements: [],
  },
} as const satisfies Record<string, RuleSetDefinition>;

export type RuleSetName = keyof typeof ruleSetRegistry;
export function ruleSetNames(): RuleSetName[] {
  return Object.keys(ruleSetRegistry).filter((name): name is RuleSetName =>
    Object.hasOwn(ruleSetRegistry, name),
  );
}

export function ruleSetDefinition({
  name,
}: {
  readonly name: RuleSetName;
}): RuleSetDefinition {
  return ruleSetRegistry[name];
}

export { defaultGuardRules, testFilePatterns };
