import type { Rule } from "../policyHelpers";

/** Independently composable Go formatting/build/test commands and their mise wrappers. */
export const goTestRules: Rule[] = [
  { pattern: "gofmt", decision: "allow" },
  { pattern: "gofmt *", decision: "allow" },
  { pattern: "go build", decision: "allow" },
  { pattern: "go build *", decision: "allow" },
  { pattern: "go test", decision: "allow" },
  { pattern: "go test *", decision: "allow" },
  { pattern: "mise exec -- go build", decision: "allow" },
  { pattern: "mise exec -- go build *", decision: "allow" },
  { pattern: "mise exec -- go test", decision: "allow" },
  { pattern: "mise exec -- go test *", decision: "allow" },
  { pattern: "mise exec go build", decision: "allow" },
  { pattern: "mise exec go build *", decision: "allow" },
  { pattern: "mise exec go test", decision: "allow" },
  { pattern: "mise exec go test *", decision: "allow" },
  { pattern: "mise x -- go build", decision: "allow" },
  { pattern: "mise x -- go build *", decision: "allow" },
  { pattern: "mise x -- go test", decision: "allow" },
  { pattern: "mise x -- go test *", decision: "allow" },
  { pattern: "mise x go build", decision: "allow" },
  { pattern: "mise x go build *", decision: "allow" },
  { pattern: "mise x go test", decision: "allow" },
  { pattern: "mise x go test *", decision: "allow" },
  // Keep the existing broad Go posture; explicit build/test rules above also
  // declare the subcommands the path evaluator can recognize as syntax.
  { pattern: "go *", decision: "allow" },
];
