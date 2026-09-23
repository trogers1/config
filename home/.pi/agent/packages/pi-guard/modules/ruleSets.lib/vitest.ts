import type { Rule } from "../policyHelpers";

/**
 * Project-script entry points for a profile that declares Vitest as its test
 * workflow. One-off binary execution remains governed by package-manager
 * policy; selecting this workflow must not override an intentional npx/exec
 * denial.
 */
export const vitestRules: Rule[] = [
  { pattern: "npm test", decision: "allow" },
  { pattern: "npm test *", decision: "allow" },
  { pattern: "npm run test", decision: "allow" },
  { pattern: "npm run test *", decision: "allow" },
  { pattern: "pnpm test", decision: "allow" },
  { pattern: "pnpm test *", decision: "allow" },
  { pattern: "pnpm run test", decision: "allow" },
  { pattern: "pnpm run test *", decision: "allow" },
  { pattern: "yarn test", decision: "allow" },
  { pattern: "yarn test *", decision: "allow" },
  { pattern: "yarn run test", decision: "allow" },
  { pattern: "yarn run test *", decision: "allow" },
];
