import type { Rule } from "../policyHelpers";

/** Independently composable Rust build/test/check commands. */
export const rustTestRules: Rule[] = [
  { pattern: "cargo build", decision: "allow" },
  { pattern: "cargo build *", decision: "allow" },
  { pattern: "cargo test", decision: "allow" },
  { pattern: "cargo test *", decision: "allow" },
  { pattern: "cargo check", decision: "allow" },
  { pattern: "cargo check *", decision: "allow" },
  { pattern: "cargo clippy", decision: "allow" },
  { pattern: "cargo clippy *", decision: "allow" },
];
