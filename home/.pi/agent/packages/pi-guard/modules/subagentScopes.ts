import type { Rule } from "./policyHelpers";

export type NonEmptyRuleArray = [Rule, ...Rule[]];

export const subagentScopeGuidance =
  "This subagent may only access paths in its declared permissible scope. END YOUR TURN AND ASK THE ORCHESTRATOR TO RESTART YOU WITH A NEW PERMISSIBLE SCOPE IF NECESSARY FOR YOUR TASK.";

/**
 * Parse PI_SUBAGENT_PERMISSIBLE_GLOBS into the same rule shape used by the
 * existing permissions gate. Keeping this logic in one module lets the gate
 * and any future sandbox narrowing share the exact same normalization.
 */
export function parseSubagentPermissibleRules({
  value,
}: {
  readonly value: string | undefined;
}): NonEmptyRuleArray | undefined {
  if (value === undefined) return undefined;

  const scopes = value
    .split(",")
    .map((scope) =>
      scope.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""),
    )
    .filter(Boolean);
  const rules: [Rule, ...Rule[]] = [
    { pattern: "**", decision: "deny", guidance: subagentScopeGuidance },
  ];

  for (const scope of scopes) {
    if (scope === ".") {
      rules.push({ pattern: "**", decision: "allow" });
      rules.push({
        pattern: "..",
        decision: "deny",
        guidance: subagentScopeGuidance,
      });
      rules.push({
        pattern: "../**",
        decision: "deny",
        guidance: subagentScopeGuidance,
      });
    } else if (/[*?[]/.test(scope)) {
      rules.push({ pattern: scope, decision: "allow" });
    } else {
      rules.push({ pattern: scope, decision: "allow" });
      rules.push({ pattern: `${scope}/**`, decision: "allow" });
    }
  }

  return rules;
}
