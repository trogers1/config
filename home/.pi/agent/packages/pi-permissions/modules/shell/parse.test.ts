import { describe, expect, it } from "vitest";
import {
  extractCommandSubstitutions,
  extractShellCommands,
  matchesCommandPattern,
  normalizeCommandForDecision,
  splitShellCommands,
} from "./parse";
import {
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

  it("treats ? as a single non-whitespace character in command patterns", () => {
    expect(matchesCommandPattern("echo ?", "echo x")).toBe(true);
    expect(matchesCommandPattern("echo ?", "echo  ")).toBe(false);
    expect(matchesCommandPattern("echo ?", "echo x y")).toBe(false);
  });
});

describe("shell path policy", () => {
  const policy = {
    tools: {},
    readPaths: [
      { pattern: "*", decision: "allow" },
      { pattern: "**/.env*", decision: "deny" },
    ],
    protectedPathPatterns: ["**/.env*"],
    writePaths: [
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
      policy.readPaths,
      "allow",
      "read",
    );
    const policyDecision: PolicyDecision = decision;

    expect(policyDecision.decision).toBe("deny");
    expect(isOutside("/workspace/other", root)).toBe(true);
    expect(displayPath("/workspace/other", root)).toBe("/workspace/other");
    expect(
      decideBashPathReferences(["cat .env"], root, root, policy),
    ).toMatchObject({ decision: "deny", path: `${root}/.env` });
    expect(
      evaluatePathByPattern(
        `${root}/docs/file.md`,
        root,
        policy.readPaths,
        "allow",
        "read",
      ).decision,
    ).toBe("allow");
    expect(
      decideBashPathReferences(["cat docs/file.md"], root, root, policy),
    ).toMatchObject({ decision: "deny", path: `${root}/docs/file.md` });
  });

  it("applies path rules only to their selected tool contexts", () => {
    const root = "/workspace/project";
    const target = `${root}/generated/result.txt`;
    const rules = [
      { pattern: "**", decision: "allow" },
      {
        pattern: "generated/**",
        decision: "deny",
        contexts: ["grep"],
      },
    ] satisfies ProfilePolicy["readPaths"];

    expect(
      evaluatePathByPattern(target, root, rules, "allow", "read").decision,
    ).toBe("allow");
    expect(
      evaluatePathByPattern(target, root, rules, "allow", "grep").decision,
    ).toBe("deny");
  });

  it("uses AST command semantics for Git paths and repository objects", () => {
    const root = "/workspace/project";

    expect(
      decideBashPathReferences(
        ["git -C /tmp/repository show HEAD~3:src/example.ts"],
        root,
        root,
        policy,
      ),
    ).toBeUndefined();
    expect(
      decideBashPathReferences(
        ["git -C ../repository show HEAD~3:src/example.ts"],
        root,
        root,
        policy,
      ),
    ).toMatchObject({
      decision: "deny",
      path: "/workspace/repository",
    });
  });

  it("evaluates input and output redirection targets", () => {
    const root = "/workspace/project";

    expect(
      decideBashPathReferences(["git log > /tmp/history"], root, root, policy),
    ).toBeUndefined();
    expect(
      decideBashPathReferences(["git log > history"], root, root, policy),
    ).toMatchObject({ decision: "deny", path: `${root}/history` });
    expect(
      decideBashPathReferences(["node < ./input.json"], root, root, policy),
    ).toMatchObject({ decision: "deny", path: `${root}/input.json` });
    expect(
      decideBashPathReferences(['node > "$OUTPUT"'], root, root, policy),
    ).toMatchObject({
      decision: "ask",
      path: "$OUTPUT",
    });
  });
});
