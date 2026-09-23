import { describe, expect, it } from "vitest";
import {
  parseSubagentPermissibleRules,
  subagentScopeGuidance,
} from "./subagentScopes";

describe("parseSubagentPermissibleRules", () => {
  it("parses the declared scope through its object argument", () => {
    expect(parseSubagentPermissibleRules({ value: "src, ./docs/" })).toEqual([
      {
        pattern: "**",
        decision: "deny",
        guidance: subagentScopeGuidance,
      },
      { pattern: "src", decision: "allow" },
      { pattern: "src/**", decision: "allow" },
      { pattern: "docs", decision: "allow" },
      { pattern: "docs/**", decision: "allow" },
    ]);
  });
});
