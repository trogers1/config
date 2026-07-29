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
  {
    pattern: "/**/home/.pi/agent/packages/**/node_modules/**",
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
    {
      pattern: "../**/.pi/agent/skills/address-comments/scripts/*.sh",
      decision: "allow",
      contexts: ["bash"],
    },
    {
      pattern: "../**/.pi/agent/skills/address-comments/*",
      decision: "allow",
      contexts: ["bash"],
    },
    ...piReferencePathRules.map((rule) => ({
      ...rule,
      contexts: ["bash" as const],
    })),
    ...extra,
  ];
}
