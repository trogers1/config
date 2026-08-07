import { extendProfile } from "../policyHelpers";
import { ruleSetRegistry, testFilePatterns } from "../ruleSets.lib/index";
import { baseCompositionChain, baseProfile } from "./base";

export const testsHiddenCompositionChain = [
  ...baseCompositionChain,
  "ruleset:test-write-protection",
  "builtin:tests-hidden",
] as const;

export const testsOnlyCompositionChain = [
  ...baseCompositionChain,
  "builtin:tests-only",
] as const;

export const implementationOnlyCompositionChain = [
  ...baseCompositionChain,
  "ruleset:test-write-protection",
  "builtin:implementation-only",
] as const;

/**
 * Test files are hidden entirely: reads, writes, and broad searches from the
 * repository root all deny. The agent implements against test results.
 */
export const testsHiddenProfile = extendProfile(baseProfile, {
  color: "orange",
  emoji: "🕶️",
  promptFile: "prompts/tests-hidden.md",
  // Protected rules also make grep/ripgrep exclude tests during broad
  // searches whose requested path is the repository root.
  protectedPathRules: testFilePatterns.map((pattern) => ({
    pattern,
    decision: "deny" as const,
    guidance:
      "You are implementing only. Do not inspect test files; adjust the system from production code and test results instead.",
  })),
  readPaths: testFilePatterns.map((pattern) => ({
    pattern,
    decision: "deny" as const,
    guidance:
      "You are implementing only. Do not inspect test files; adjust the system from production code and test results instead.",
  })),
  writePaths: [
    ...(ruleSetRegistry["ruleset:test-write-protection"].writePaths ?? []),
  ],
});

/** Inverse of tests-hidden: may only write test files and /tmp. */
export const testsOnlyProfile = extendProfile(baseProfile, {
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

/** Tests stay readable as the specification; only writes to them deny. */
export const implementationOnlyProfile = extendProfile(baseProfile, {
  ...ruleSetRegistry["ruleset:test-write-protection"],
  color: "orange",
  emoji: "🏗️",
});
