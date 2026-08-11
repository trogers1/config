import type { Rule } from "./policyHelpers";

/**
 * Parse PI_SUBAGENT_PERMISSIBLE_GLOBS into the same rule shape used by the
 * existing permissions gate. Keeping this logic in one module lets the gate
 * and any future sandbox narrowing share the exact same normalization.
 */
export function parseSubagentPermissibleRules(
  value: string | undefined,
): Rule[] | undefined {
  if (value === undefined) return undefined;

  const scopes = value
    .split(",")
    .map((scope) =>
      scope.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""),
    )
    .filter(Boolean);
  const guidance =
    "This subagent may only access paths in its declared permissible scope.";
  const rules: Rule[] = [{ pattern: "**", decision: "deny", guidance }];

  for (const scope of scopes) {
    if (scope === ".") {
      rules.push({ pattern: "**", decision: "allow" });
      rules.push({ pattern: "..", decision: "deny", guidance });
      rules.push({ pattern: "../**", decision: "deny", guidance });
    } else if (/[*?[]/.test(scope)) {
      rules.push({ pattern: scope, decision: "allow" });
    } else {
      rules.push({ pattern: scope, decision: "allow" });
      rules.push({ pattern: `${scope}/**`, decision: "allow" });
    }
  }

  return rules;
}
