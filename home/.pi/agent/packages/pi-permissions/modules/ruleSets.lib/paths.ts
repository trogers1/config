import type {
  ProfilePolicy,
  ReadPathRule,
  WritePathRule,
} from "../policyHelpers";

const piSkillReadRules: ReadonlyArray<Omit<ReadPathRule, "contexts">> = [
  {
    pattern: "/**/.pi/agent/skills/**",
    decision: "allow",
  },
];

const piReferencePathRules: ReadonlyArray<Omit<ReadPathRule, "contexts">> = [
  {
    pattern: "/**/node_modules/@earendil-works/pi-coding-agent/README.md",
    decision: "allow",
  },
  {
    pattern: "/**/node_modules/@earendil-works/pi-coding-agent/docs/**",
    decision: "allow",
  },
  // Pi packages are trusted implementation dependencies. This portable
  // pattern covers both the installed ~/.pi package directory and its source
  // under a configuration checkout without encoding a user's home path.
  {
    pattern: "/**/.pi/agent/packages/**/node_modules/**",
    decision: "allow",
  },
];

export const testFilePatterns = [
  "**/test",
  "**/test/**",
  "**/tests",
  "**/tests/**",
  "**/__tests__",
  "**/__tests__/**",
  "**/integrationTests",
  "**/integrationTests/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.*",
  "**/*.cy.*",
] as const;

/**
 * Test-file write denies (`ruleset:test-write-protection`), shared by
 * `builtin:tests-hidden` and `builtin:implementation-only`: tests stay
 * readable as the specification; only writes are denied.
 */
export const testWriteProtectionRules: WritePathRule[] = testFilePatterns.map(
  (pattern) => ({
    pattern,
    decision: "deny",
    guidance:
      "You are implementing only. Do not alter tests; adjust the system under test instead.",
  }),
);

/**
 * Write gating for docs-only profiles (`ruleset:docs-write`), used by
 * `builtin:scribe-only`: Markdown documentation, docs/, and /tmp scratch.
 */
export const docsWritePathRules: WritePathRule[] = [
  {
    pattern: "**",
    decision: "deny",
    contexts: ["edit", "write"],
    guidance:
      "The scribe-only profile may only write Markdown documentation and /tmp scratch files.",
  },
  {
    pattern: "**",
    decision: "deny",
    contexts: ["bash"],
    guidance:
      "Bash path operands are gated as writes under the scribe-only profile. Only Markdown documentation paths and /tmp may be targeted.",
    alternatives: [
      "Use the read tool for concrete files",
      "Use the grep tool for content searches",
      "Use the find or ls tools for directory discovery",
    ],
  },
  { pattern: "*.md", decision: "allow" },
  { pattern: "**/*.md", decision: "allow" },
  { pattern: "docs/**", decision: "allow" },
  { pattern: "/tmp", decision: "allow" },
  { pattern: "/tmp/**", decision: "allow" },
  { pattern: "/private/tmp", decision: "allow" },
  { pattern: "/private/tmp/**", decision: "allow" },
];

export const readOnlyPathRules: ProfilePolicy["readPaths"] = [
  { pattern: "*", decision: "allow" },
  {
    pattern: "..",
    decision: "deny",
    guidance:
      "The read-only profile can only read inside the startup directory and /tmp.",
  },
  {
    pattern: "../**",
    decision: "deny",
    guidance:
      "The read-only profile can only read inside the startup directory and /tmp.",
  },
  { pattern: "/tmp", decision: "allow" },
  { pattern: "/tmp/**", decision: "allow" },
  { pattern: "/private/tmp", decision: "allow" },
  { pattern: "/private/tmp/**", decision: "allow" },
  ...piSkillReadRules.map((rule) => ({
    ...rule,
    contexts: ["read" as const],
  })),
  ...piReferencePathRules.map((rule) => ({
    ...rule,
    contexts: ["read" as const],
  })),
];

export const readOnlyWritePathRules: ProfilePolicy["writePaths"] = [
  {
    pattern: "**",
    decision: "deny",
    guidance:
      "The read-only profile only permits writing /tmp, handoff.md, and progress.md.",
  },
  { pattern: "/tmp", decision: "allow" },
  { pattern: "/tmp/**", decision: "allow" },
  { pattern: "/private/tmp", decision: "allow" },
  { pattern: "/private/tmp/**", decision: "allow" },
  { pattern: "handoff.md", decision: "allow" },
  { pattern: "progress.md", decision: "allow" },
  ...piReferencePathRules.map((rule) => ({
    ...rule,
    contexts: ["bash" as const],
  })),
];

export function defaultReadPaths(
  extra: ReadPathRule[] = [],
): ProfilePolicy["readPaths"] {
  return [
    { pattern: "*", decision: "allow" },
    { pattern: "..", decision: "ask", contexts: ["read"] },
    { pattern: "../**", decision: "ask", contexts: ["read", "grep", "ls"] },
    { pattern: "/tmp/**", decision: "allow" },
    ...piSkillReadRules.map((rule) => ({
      ...rule,
      contexts: ["read" as const],
    })),
    ...piReferencePathRules.map((rule) => ({
      ...rule,
      contexts: ["read" as const],
    })),
    ...extra,
  ];
}

export function defaultWritePaths(
  extra: WritePathRule[] = [],
): ProfilePolicy["writePaths"] {
  return [
    { pattern: "*", decision: "allow" },
    { pattern: "..", decision: "ask", contexts: ["bash"] },
    { pattern: "../**", decision: "ask" },
    { pattern: "/tmp/**", decision: "allow" },
    ...piReferencePathRules.map((rule) => ({
      ...rule,
      contexts: ["bash" as const],
    })),
    ...extra,
  ];
}
