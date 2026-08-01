import type { ProfilePolicy } from "../policyHelpers";
import { defaultGitRules } from "./git";
import { defaultGuardRules } from "./guards";
import { defaultPackageManagerRules } from "./packageManagers";
import {
  defaultReadPaths,
  defaultWritePaths,
  readOnlyPathRules,
  readOnlyWritePathRules,
  testFilePatterns,
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
  | "ruleset:guards"
  | "ruleset:paths";

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
  "ruleset:packageManagers": {
    tools: {
      bash: defaultPackageManagerRules,
    },
  },
  "ruleset:guards": {
    tools: {
      bash: defaultGuardRules,
    },
  },
  "ruleset:paths": {
    readPaths: defaultReadPaths(),
    writePaths: defaultWritePaths(),
  },
};

export function ruleSetNames(): RuleSetName[] {
  return Object.keys(ruleSetRegistry) as RuleSetName[];
}

export {
  defaultGuardRules,
  readOnlyPathRules,
  readOnlyShellRules,
  readOnlyWritePathRules,
  testFilePatterns,
};
