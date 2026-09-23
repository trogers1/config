import type { Rule } from "../policyHelpers";

/** Independently composable TypeScript/Node package-script test commands. */
export const typeScriptNodeTestRules: Rule[] = [
  { pattern: "npm run *", decision: "allow" },
  { pattern: "npm test", decision: "allow" },
  { pattern: "npm test *", decision: "allow" },
  { pattern: "pnpm run *", decision: "allow" },
  { pattern: "pnpm test", decision: "allow" },
  { pattern: "pnpm test *", decision: "allow" },
  { pattern: "yarn run *", decision: "allow" },
  { pattern: "yarn test", decision: "allow" },
  { pattern: "yarn test *", decision: "allow" },
];
