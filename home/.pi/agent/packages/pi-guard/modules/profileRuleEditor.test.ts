import { describe, expect, it } from "vitest";
import type { RuleKind } from "./profileConfig";
import {
  isBroaderPattern,
  ruleDestination,
  ruleEffect,
  type EditableRuleRow,
} from "./profileRuleEditor";

describe("profile rule editor semantics", () => {
  it("maps every layer to its real collection and non-effect", () => {
    const expectedDestinations = {
      bash: "tools.bash",
      read: "readPaths",
      write: "writePaths",
      protected: "protectedPathRules",
    } satisfies Record<RuleKind, string>;
    expect(ruleDestination("bash")).toBe(expectedDestinations.bash);
    expect(ruleDestination("read")).toBe(expectedDestinations.read);
    expect(ruleDestination("write")).toBe(expectedDestinations.write);
    expect(ruleDestination("protected")).toBe(expectedDestinations.protected);
    expect(ruleEffect("write", "allow")).toContain(
      "read-tool access is unaffected",
    );
    expect(ruleEffect("protected", "allow")).toContain(
      "grants no read or write permission",
    );
  });

  it("flags any request-derived pattern changed from its exact prefill", () => {
    const row: EditableRuleRow = {
      id: "request-1",
      kind: "write",
      pattern: "generated/**",
      decision: "allow",
      contexts: ["write"],
      origin: "request",
      request: {
        kind: "write",
        context: "write",
        requestedValue: "/repo/generated/a.ts",
        initialPattern: "generated/a.ts",
        currentDecision: "ask",
        source: { tool: "write" },
      },
    };
    expect(isBroaderPattern(row)).toBe(true);
    expect(isBroaderPattern({ ...row, pattern: "generated/a.ts" })).toBe(false);
  });
});
