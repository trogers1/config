import type { ProfilePolicy } from "../policyHelpers";
import { defaultGitRules, gitCommitRules, gitRefsRules } from "./git";
import { defaultGuardRules } from "./guards";
import { defaultProtectedPathRules } from "../protectedPaths";
import {
  dependencyMutationAllowRules,
  dependencyMutationGuardRules,
  packageManagerRules,
  testRunRules,
} from "./packageManagers";
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

export type RuleSetPolicy = Partial<
  Pick<
    ProfilePolicy,
    "tools" | "readPaths" | "writePaths" | "protectedPathRules"
  >
>;

export type RuleSetName =
  | "ruleset:shell"
  | "ruleset:git"
  | "ruleset:packageManagers"
  | "ruleset:deps-mutations-guard"
  | "ruleset:deps-mutations-allow"
  | "ruleset:shell-guards"
  | "ruleset:path-guards"
  | "ruleset:read-only-shell"
  | "ruleset:read-only-path"
  | "ruleset:git-commit"
  | "ruleset:git-refs"
  | "ruleset:test-run"
  | "ruleset:docs-write"
  | "ruleset:test-write-protection";

export const ruleSetRegistry: Record<RuleSetName, RuleSetPolicy> = {
  "ruleset:shell": {
    tools: {
      bash: defaultShellRules,
    },
  },
  "ruleset:git": {
    tools: {
      bash: defaultGitRules,
    },
  },
  // Base package-manager posture only: pair with ruleset:deps-mutations-guard
  // (standard, as builtin:default does) or ruleset:deps-mutations-allow
  // (dependency work, as builtin:deps-mutator does).
  "ruleset:packageManagers": {
    tools: {
      bash: packageManagerRules,
    },
  },
  "ruleset:deps-mutations-guard": {
    tools: {
      bash: dependencyMutationGuardRules,
    },
  },
  "ruleset:deps-mutations-allow": {
    tools: {
      bash: dependencyMutationAllowRules,
    },
  },
  "ruleset:shell-guards": {
    tools: {
      bash: defaultGuardRules,
    },
  },
  "ruleset:path-guards": {
    readPaths: defaultReadPaths(),
    writePaths: defaultWritePaths(),
    protectedPathRules: defaultProtectedPathRules,
  },
  "ruleset:read-only-shell": {
    tools: {
      bash: readOnlyShellRules,
    },
  },
  "ruleset:read-only-path": {
    readPaths: readOnlyPathRules,
    writePaths: readOnlyWritePathRules,
    protectedPathRules: defaultProtectedPathRules,
  },
  "ruleset:git-commit": {
    tools: {
      bash: gitCommitRules,
    },
    writePaths: [{ pattern: "/dev/null", decision: "allow" }],
  },
  "ruleset:git-refs": {
    tools: {
      bash: gitRefsRules,
    },
  },
  "ruleset:test-run": {
    tools: {
      bash: testRunRules,
    },
  },
  "ruleset:docs-write": {
    writePaths: docsWritePathRules,
  },
  "ruleset:test-write-protection": {
    writePaths: testWriteProtectionRules,
  },
};

export function ruleSetNames(): RuleSetName[] {
  return Object.keys(ruleSetRegistry) as RuleSetName[];
}

export { defaultGuardRules, testFilePatterns };
