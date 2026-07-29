import {
  extendProfile,
  definePolicyConfig,
  type ProfilePolicy,
  type Rule,
} from "../policyHelpers";
import {
  defaultReadPaths,
  defaultWritePaths,
  readOnlyPathRules,
  readOnlyWritePathRules,
  testFilePatterns,
} from "../ruleSets.lib/index";
import { defaultShellRules, readOnlyShellRules } from "../ruleSets.lib/index";
import {
  defaultProtectedPathExceptions,
  defaultProtectedPathPatterns,
} from "../protectedPaths";

const baseProfile: ProfilePolicy = {
  color: "blue",
  emoji: "🛠️",
  // No promptFile means: keep Pi's normal system prompt unchanged.
  // Tool policies resolve by specificity first; composition order only breaks ties.
  // For bash, patterns match normalized command segments.
  // For path-based tools, patterns match paths relative to pi's startup directory.
  // Outside paths appear as ../..., so use ../** to gate external access.
  tools: { bash: defaultShellRules },
  readPaths: defaultReadPaths(),
  writePaths: defaultWritePaths(),
  protectedPathPatterns: defaultProtectedPathPatterns,
  protectedPathExceptions: defaultProtectedPathExceptions,
};

function denyInteractiveDecisions(policy: ProfilePolicy): ProfilePolicy {
  const denyAsk = <
    PolicyRule extends { decision: Rule["decision"]; guidance?: string },
  >(
    rule: PolicyRule,
  ): PolicyRule =>
    rule.decision === "ask"
      ? {
          ...rule,
          decision: "deny",
          guidance:
            rule.guidance ??
            "This non-interactive worker cannot request permission. Use an explicitly allowed command or path.",
        }
      : { ...rule };

  return {
    ...policy,
    color: "magenta",
    emoji: "⚙️",
    tools: Object.fromEntries(
      Object.entries(policy.tools).map(([tool, rules]) => [
        tool,
        rules?.map((rule) => denyAsk(rule)) ?? [],
      ]),
    ),
    readPaths: policy.readPaths.map(denyAsk),
    writePaths: policy.writePaths.map(denyAsk),
  };
}

const workerProfile = denyInteractiveDecisions(baseProfile);

const readOnlyProfile: ProfilePolicy = {
  color: "green",
  emoji: "🔎",
  tools: { bash: readOnlyShellRules },
  readPaths: readOnlyPathRules,
  writePaths: readOnlyWritePathRules,
  protectedPathPatterns: defaultProtectedPathPatterns,
  protectedPathExceptions: defaultProtectedPathExceptions,
};

const testsHiddenProfile = extendProfile(baseProfile, {
  color: "orange",
  emoji: "🕶️",
  promptFile: "prompts/tests-hidden.md",
  // Protected patterns also make grep/ripgrep exclude tests during broad
  // searches whose requested path is the repository root.
  protectedPathPatterns: [
    ...(baseProfile.protectedPathPatterns ?? []),
    ...testFilePatterns,
  ],
  readPaths: testFilePatterns.map((pattern) => ({
    pattern,
    decision: "deny" as const,
    guidance:
      "You are implementing only. Do not inspect test files; adjust the system from production code and test results instead.",
  })),
  writePaths: testFilePatterns.map((pattern) => ({
    pattern,
    decision: "deny" as const,
    guidance:
      "You are implementing only. Do not alter tests; adjust the system under test instead.",
  })),
});

const testsOnlyProfile = extendProfile(baseProfile, {
  color: "green",
  emoji: "🔬",
  promptFile: "prompts/tests-only.md",
  writePaths: [
    {
      pattern: "**",
      decision: "deny",
      contexts: ["edit", "write"],
      guidance:
        "This profile may only edit test files. Read the implementation, then make the requested change in tests.",
    },
    {
      pattern: "**",
      decision: "deny",
      contexts: ["bash"],
      guidance:
        "Bash path operands are gated as writes under the tests-only profile. Use the read, grep, find, and ls tools to inspect implementation files; Bash operands and redirections may only target test files and /tmp.",
      alternatives: [
        "Use the read tool for concrete files",
        "Use the grep tool for content searches",
        "Use the find or ls tools for directory discovery",
      ],
    },
    ...testFilePatterns.map((pattern) => ({
      pattern,
      decision: "allow" as const,
    })),
    { pattern: "/tmp", decision: "allow" },
    { pattern: "/tmp/**", decision: "allow" },
    { pattern: "/private/tmp", decision: "allow" },
    { pattern: "/private/tmp/**", decision: "allow" },
  ],
});

const configuredPolicy = definePolicyConfig({
  defaultProfile: "builtin:default",
  profiles: {
    "builtin:default": baseProfile,
    "builtin:worker": workerProfile,
    "builtin:read-only": readOnlyProfile,
    "builtin:tests-hidden": testsHiddenProfile,
    "builtin:tests-only": testsOnlyProfile,
  },
});

function deepFreeze<T extends object>(value: T): T {
  for (const key of Reflect.ownKeys(value) as (keyof T)[]) {
    const prop = value[key];
    if (prop && typeof prop === "object" && !Object.isFrozen(prop)) {
      deepFreeze(prop);
    }
  }
  return Object.freeze(value);
}

/** Portable profiles shipped by the package. Local profiles live in user config. */
export const policyConfig = deepFreeze(configuredPolicy);
