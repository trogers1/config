import type { Rule } from "../policyHelpers";

/** Toolchain mutations only; Cargo install/add/remove use the shared dependency rules. */
export const rustDependencyManagementRules: Rule[] = [
  // Both commands otherwise permit implicit rustup self-updates.
  "rustup update --no-self-update",
  "rustup toolchain install --no-self-update",
  "rustup toolchain uninstall",
  "rustup component add",
  "rustup component remove",
  "rustup target add",
  "rustup target remove",
].flatMap((command): Rule[] => [
  { pattern: command, decision: "allow" },
  { pattern: `${command} *`, decision: "allow" },
]);

/** Independently composable Rust formatting/build/test/check commands. */
export const rustTestRules: Rule[] = [
  { pattern: "cargo fmt", decision: "allow" },
  { pattern: "cargo fmt *", decision: "allow" },
  { pattern: "cargo build", decision: "allow" },
  { pattern: "cargo build *", decision: "allow" },
  { pattern: "cargo test", decision: "allow" },
  { pattern: "cargo test *", decision: "allow" },
  { pattern: "cargo check", decision: "allow" },
  { pattern: "cargo check *", decision: "allow" },
  { pattern: "cargo clippy", decision: "allow" },
  { pattern: "cargo clippy *", decision: "allow" },
];
