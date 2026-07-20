import { describe, expect, it } from "vitest";
import {
  extractCommandSubstitutions,
  extractShellCommands,
  matchesCommandPattern,
  normalizeCommandForDecision,
  splitShellCommands,
} from "./parse";
import {
  decideBashOutputRedirections,
  decideBashPathReferences,
  displayPath,
  evaluatePathByPattern,
  isOutside,
  matchesGlobPattern,
  resolveRequestedPath,
  type PathPolicyDecision,
  type PolicyDecision,
} from "./pathPolicy";
import type { ProfilePolicy } from "../policyHelpers";

describe("shell parser", () => {
  it("does not split quoted command separators", () => {
    expect(
      splitShellCommands('printf "a;b && c || d | e" && git status --short'),
    ).toEqual(['printf "a;b && c || d | e"', "git status --short"]);
  });

  it("finds executable commands in substitutions", () => {
    const command =
      "printf '$(git checkout inert)' && echo \"$(git checkout active)\"";

    expect(extractShellCommands(command)).toContain("git checkout active");
    expect(extractCommandSubstitutions(command)).toEqual([
      "git checkout active",
    ]);
  });

  it("normalizes command wrappers before matching command rules", () => {
    expect(normalizeCommandForDecision("command git status --short")).toBe(
      "git status --short",
    );
    expect(matchesCommandPattern("git status *", "git status --short")).toBe(
      true,
    );
  });
});

describe("shell path policy", () => {
  const policy = {
    tools: {},
    bashPathReferences: [
      { pattern: "*", decision: "allow" },
      { pattern: "**/.env*", decision: "deny" },
    ],
    protectedPathPatterns: ["**/.env*"],
    bashOutputRedirections: [
      { pattern: "**", decision: "deny" },
      { pattern: "/tmp/**", decision: "allow" },
    ],
  } satisfies ProfilePolicy;

  it("matches root, nested, and outside glob paths", () => {
    expect(matchesGlobPattern("**/.env", ".env")).toBe(true);
    expect(matchesGlobPattern("**/.env", "app/.env")).toBe(true);
    expect(matchesGlobPattern("**/.git/**", ".git/config")).toBe(true);
    expect(matchesGlobPattern("../**", "../other/file.txt")).toBe(true);
  });

  it("evaluates resolved paths and shell path references", () => {
    const root = "/workspace/project";
    const protectedPath = resolveRequestedPath(".env", root);
    const decision: PathPolicyDecision = evaluatePathByPattern(
      protectedPath,
      root,
      policy.bashPathReferences,
      "allow",
    );
    const policyDecision: PolicyDecision = decision;

    expect(policyDecision.decision).toBe("deny");
    expect(isOutside("/workspace/other", root)).toBe(true);
    expect(displayPath("/workspace/other", root)).toBe("/workspace/other");
    expect(
      decideBashPathReferences(["cat .env"], root, root, policy),
    ).toMatchObject({ decision: "deny", path: `${root}/.env` });
  });

  it("evaluates output redirection targets", () => {
    const root = "/workspace/project";

    expect(
      decideBashOutputRedirections(
        ["git log > /tmp/history"],
        root,
        root,
        policy,
      ),
    ).toBeUndefined();
    expect(
      decideBashOutputRedirections(["git log > history"], root, root, policy),
    ).toMatchObject({ decision: "deny", path: `${root}/history` });
  });
});
