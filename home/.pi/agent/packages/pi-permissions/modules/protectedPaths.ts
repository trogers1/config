import type { Rule } from "./policyHelpers";

/**
 * Ordered protected-path rules shared by every profile. Later exceptions are
 * intentional and must remain narrow.
 */
export const protectedPathRules: Rule[] = [
  { pattern: "**/.env*", decision: "deny" },
  { pattern: "**/.env*/**", decision: "deny" },
  // Templates are safe to inspect and are intentionally the sole .env* exception.
  { pattern: "**/.env.template", decision: "allow" },
  { pattern: "**/.git", decision: "deny" },
  { pattern: "**/.git/**", decision: "deny" },
];
