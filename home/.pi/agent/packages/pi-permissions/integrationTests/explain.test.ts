import { describe, expect, it } from "vitest";
import {
  explainPermission,
  formatExplanation,
} from "../extensions/permissions";
import { createExtensionHarness } from "./support/extensionHarness";
import { policyConfig } from "../modules/policy";
import type { RawProfileConfig } from "../modules/profileConfig";
import type {
  CustomToolRule,
  ProfilePolicy,
  ReadPathRule,
  Rule,
  WritePathRule,
} from "../modules/policyHelpers";

const startupCwd = "/workspace/project";

function bashProfile(rules: Rule[]): ProfilePolicy {
  return {
    tools: { bash: rules },
    readPaths: [{ pattern: "*", decision: "allow" }],
    writePaths: [{ pattern: "*", decision: "allow" }],
  };
}

function pathProfile(
  readPaths: ReadPathRule[],
  writePaths: WritePathRule[],
): ProfilePolicy {
  return {
    tools: {},
    readPaths,
    writePaths,
  };
}

describe("permissions explain", () => {
  it("registers the /permissions command (not a space-containing name)", () => {
    const harness = createExtensionHarness({ hasUI: false });
    expect(harness.commands.has("permissions")).toBe(true);
    expect(harness.commands.has("permissions explain")).toBe(false);
  });

  it("ranks bash rules by specificity and reports the winner", () => {
    const policy = bashProfile([
      { pattern: "git branch *", decision: "deny" },
      { pattern: "git branch --list", decision: "allow" },
      { pattern: "*", decision: "ask" },
    ]);

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "bash",
      "git branch --list",
      startupCwd,
    );

    expect(explanation.profile).toBe("builtin:default");
    expect(explanation.decision).toBe("allow");
    expect(explanation.winner?.pattern).toBe("git branch --list");
    expect(explanation.winner?.tiebreak).toBe("literal-segments");
    expect(explanation.matches.map((m) => m.pattern)).toEqual([
      "git branch --list",
      "git branch *",
      "*",
    ]);
  });

  it("reports composition-order tiebreak for same-pattern rules", () => {
    const policy = bashProfile([
      { pattern: "git commit *", decision: "deny" },
      { pattern: "git commit *", decision: "allow" },
    ]);

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "bash",
      "git commit -m test",
      startupCwd,
    );

    expect(explanation.decision).toBe("allow");
    expect(explanation.winner?.pattern).toBe("git commit *");
    expect(explanation.winner?.tiebreak).toBe("composition-order");
    expect(explanation.winner?.index).toBe(1);
  });

  it("reports literal-character tiebreak when segment counts tie", () => {
    const policy = bashProfile([
      { pattern: "git status *", decision: "allow" },
      { pattern: "git * --short", decision: "deny" },
    ]);

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "bash",
      "git status --short",
      startupCwd,
    );

    expect(explanation.decision).toBe("deny");
    expect(explanation.winner?.pattern).toBe("git * --short");
    expect(explanation.winner?.tiebreak).toBe("literal-characters");
  });

  it("falls back to ask when no bash rules match", () => {
    const policy = bashProfile([]);

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "bash",
      "unknown-command",
      startupCwd,
    );

    expect(explanation.decision).toBe("ask");
    expect(explanation.winner).toBeUndefined();
    expect(explanation.matches).toHaveLength(0);
    expect(explanation.fallback).toBe("ask");
  });

  it("reports the most restrictive decision for compound bash commands", () => {
    const policy = bashProfile([
      { pattern: "git status", decision: "allow" },
      { pattern: "rm -rf *", decision: "deny" },
    ]);

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "bash",
      "git status; rm -rf x",
      startupCwd,
    );

    expect(explanation.decision).toBe("deny");
    expect(explanation.notes).toEqual(
      expect.arrayContaining([expect.stringContaining("Compound command")]),
    );
  });

  it("extracts &&-compound commands for ranking", () => {
    const policy = bashProfile([
      { pattern: "git status", decision: "allow" },
      { pattern: "rm -rf *", decision: "deny" },
    ]);

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "bash",
      "git status && rm -rf x",
      startupCwd,
    );

    expect(explanation.decision).toBe("deny");
  });

  it("uses the enforcement deny-first scan across Bash path operands", () => {
    const policy: ProfilePolicy = {
      tools: { bash: [{ pattern: "cp *", decision: "allow" }] },
      readPaths: [{ pattern: "*", decision: "allow" }],
      writePaths: [
        { pattern: "ask/**", decision: "ask", contexts: ["bash"] },
        { pattern: "denied/**", decision: "deny", contexts: ["bash"] },
        { pattern: "**", decision: "allow", contexts: ["bash"] },
      ],
    };

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "bash",
      "cp source ask/file; cp source denied/file",
      startupCwd,
    );

    expect(explanation.decision).toBe("deny");
    expect(explanation.notes).toEqual(
      expect.arrayContaining([expect.stringContaining("denied/**")]),
    );
  });

  it("reports the parse-error approval gate before evaluating Bash policy", () => {
    const explanation = explainPermission(
      bashProfile([{ pattern: "git status *", decision: "allow" }]),
      "builtin:default",
      "bash",
      "git status 'unterminated",
      startupCwd,
    );

    expect(explanation.decision).toBe("ask");
    expect(explanation.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("require approval before policy evaluation"),
      ]),
    );
  });

  it("reports a definite protected deny ahead of a parse-error approval gate", () => {
    const policy: ProfilePolicy = {
      ...bashProfile([{ pattern: "cat *", decision: "allow" }]),
      protectedPathRules: [{ pattern: "**/.env*", decision: "deny" }],
    };

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "bash",
      "cat .env 'unterminated",
      startupCwd,
    );

    expect(explanation.decision).toBe("deny");
    expect(explanation.protectedOverride?.pattern).toBe("**/.env*");
    expect(explanation.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("protected-path deny short-circuits approval"),
      ]),
    );
  });

  it("reports a bash protected-path override for non-reader commands", () => {
    const policy: ProfilePolicy = {
      ...bashProfile([{ pattern: "git add *", decision: "allow" }]),
      protectedPathRules: [{ pattern: "**/.env*", decision: "deny" }],
    };

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "bash",
      "git add .env",
      startupCwd,
    );

    expect(explanation.decision).toBe("deny");
    expect(explanation.protectedOverride).toBeDefined();
    expect(explanation.protectedOverride?.pattern).toBe("**/.env*");
  });

  it("attributes Bash denial to the protected layer before command rules", () => {
    const policy: ProfilePolicy = {
      ...bashProfile([{ pattern: "rm -rf *", decision: "deny" }]),
      protectedPathRules: [{ pattern: "**/.env*", decision: "deny" }],
    };

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "bash",
      "rm -rf .env",
      startupCwd,
    );

    expect(explanation.decision).toBe("deny");
    expect(explanation.winner).toBeUndefined();
    expect(explanation.protectedOverride?.pattern).toBe("**/.env*");
  });

  it("surfaces ordinary writePaths bash-operand denies", () => {
    const policy: ProfilePolicy = {
      ...bashProfile([{ pattern: "cp * *", decision: "allow" }]),
      writePaths: [{ pattern: "src/**", decision: "deny", contexts: ["bash"] }],
    };

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "bash",
      "cp a.txt src/b.txt",
      startupCwd,
    );

    expect(explanation.decision).toBe("deny");
    expect(explanation.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Bash path-reference rule"),
      ]),
    );
  });

  it("explains bash path operands for non-reader commands via AST traversal", () => {
    const policy: ProfilePolicy = {
      ...bashProfile([{ pattern: "cp * *", decision: "allow" }]),
      writePaths: [
        { pattern: ".env.template", decision: "allow", contexts: ["bash"] },
        { pattern: "**", decision: "allow", contexts: ["bash"] },
      ],
      protectedPathRules: [
        { pattern: "**/.env*", decision: "deny" },
        { pattern: ".env.template", decision: "allow" },
      ],
    };

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "bash",
      "cp .env.template output",
      startupCwd,
    );

    expect(explanation.decision).toBe("allow");
    expect(explanation.pathWinner?.pattern).toBe(".env.template");
    expect(formatExplanation(explanation)).toContain(
      "Path-layer winner: [allow] .env.template",
    );
    expect(formatExplanation(explanation)).toContain("Protected matches:");
  });

  it("tracks cd state across compound bash commands", () => {
    const policy: ProfilePolicy = {
      ...bashProfile([{ pattern: "cp * *", decision: "allow" }]),
      writePaths: [
        { pattern: "docs/**", decision: "deny", contexts: ["bash"] },
      ],
    };

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "bash",
      "cd docs && cp a b",
      startupCwd,
    );

    expect(explanation.decision).toBe("deny");
    expect(explanation.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Bash path-reference rule"),
      ]),
    );
  });

  it("explains read path rules with context filtering", () => {
    const policy = pathProfile(
      [
        { pattern: "docs/**", decision: "allow", contexts: ["read"] },
        { pattern: "**", decision: "deny" },
      ],
      [{ pattern: "*", decision: "allow" }],
    );

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "read",
      "docs/readme.md",
      startupCwd,
    );

    expect(explanation.decision).toBe("allow");
    expect(explanation.winner?.pattern).toBe("docs/**");
    expect(explanation.matches.map((m) => m.pattern)).toEqual([
      "docs/**",
      "**",
    ]);
  });

  it("context filtering excludes rules that do not include the active context", () => {
    const policy = pathProfile(
      [
        { pattern: "docs/**", decision: "allow", contexts: ["read"] },
        { pattern: "**", decision: "deny", contexts: ["grep"] },
      ],
      [{ pattern: "*", decision: "allow" }],
    );

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "grep",
      "docs/readme.md",
      startupCwd,
    );

    expect(explanation.matches.map((m) => m.pattern)).toEqual(["**"]);
  });

  it("path tool fallback is allow when no rule matches", () => {
    const policy = pathProfile(
      [{ pattern: "src/**", decision: "deny", contexts: ["read"] }],
      [{ pattern: "*", decision: "allow" }],
    );

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "read",
      "docs/readme.md",
      startupCwd,
    );

    expect(explanation.decision).toBe("allow");
    expect(explanation.fallback).toBe("allow");
  });

  it("reports protected-path override for reads", () => {
    const policy: ProfilePolicy = {
      ...pathProfile(
        [{ pattern: "**", decision: "allow" }],
        [{ pattern: "*", decision: "allow" }],
      ),
      protectedPathRules: [{ pattern: "**/.env*", decision: "deny" }],
    };

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "read",
      ".env",
      startupCwd,
    );

    expect(explanation.decision).toBe("deny");
    expect(explanation.protectedOverride).toBeDefined();
    expect(explanation.protectedOverride?.decision).toBe("deny");
    expect(explanation.protectedOverride?.pattern).toBe("**/.env*");
  });

  it("shows a more-specific protected allow and the protected rule ranking", () => {
    const policy: ProfilePolicy = {
      ...pathProfile(
        [{ pattern: "**", decision: "allow" }],
        [{ pattern: "*", decision: "allow" }],
      ),
      protectedPathRules: [
        { pattern: "**/.env*", decision: "deny" },
        { pattern: ".env.template", decision: "allow" },
      ],
    };

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "read",
      ".env.template",
      startupCwd,
    );

    expect(explanation.decision).toBe("allow");
    expect(explanation.protectedOverride).toMatchObject({
      decision: "allow",
      pattern: ".env.template",
    });
    expect(explanation.protectedMatches?.map((match) => match.pattern)).toEqual(
      [".env.template", "**/.env*"],
    );
    expect(formatExplanation(explanation)).toContain(
      "Protected-layer winner: allow (.env.template)",
    );
  });

  it("matches path rules relative to startupCwd, not the current cwd", () => {
    const policy = pathProfile(
      [{ pattern: "src/**", decision: "allow", contexts: ["read"] }],
      [{ pattern: "*", decision: "deny" }],
    );

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "read",
      "/workspace/project/src/example.ts",
      "/workspace/project/subdir",
      startupCwd,
    );

    expect(explanation.decision).toBe("allow");
    expect(explanation.winner?.pattern).toBe("src/**");
  });

  it("explains custom tool rules by match specificity", () => {
    const policy: ProfilePolicy = {
      tools: {
        deploy: [
          { decision: "ask" },
          { decision: "deny", match: { action: "deploy" } },
          {
            decision: "allow",
            match: { action: "deploy", environment: "prod" },
          },
        ] as CustomToolRule[],
      },
      readPaths: [{ pattern: "*", decision: "allow" }],
      writePaths: [{ pattern: "*", decision: "allow" }],
    };

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "deploy",
      JSON.stringify({ action: "deploy", environment: "prod" }),
      startupCwd,
    );

    expect(explanation.decision).toBe("allow");
    expect(explanation.winner?.pattern).toBe(
      JSON.stringify({ action: "deploy", environment: "prod" }),
    );
    expect(explanation.matches).toHaveLength(3);
  });

  it("reports ask when custom tool rules exist but none match", () => {
    const policy: ProfilePolicy = {
      tools: {
        deploy: [
          { decision: "deny", match: { action: "deploy" } },
        ] as CustomToolRule[],
      },
      readPaths: [{ pattern: "*", decision: "allow" }],
      writePaths: [{ pattern: "*", decision: "allow" }],
    };

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "deploy",
      JSON.stringify({ action: "inspect" }),
      startupCwd,
    );

    expect(explanation.decision).toBe("ask");
    expect(explanation.matches).toHaveLength(0);
  });

  it("reports allow with a note when no custom tool policy is configured", () => {
    const policy: ProfilePolicy = {
      tools: {},
      readPaths: [{ pattern: "*", decision: "allow" }],
      writePaths: [{ pattern: "*", decision: "allow" }],
    };

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "unconfigured-tool",
      "any input",
      startupCwd,
    );

    expect(explanation.decision).toBe("allow");
    expect(explanation.notes).toEqual(
      expect.arrayContaining([expect.stringContaining("No policy configured")]),
    );
  });

  it("formats the explanation with required fields", () => {
    const policy = bashProfile([{ pattern: "git status", decision: "allow" }]);

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "bash",
      "git status",
      startupCwd,
    );
    const formatted = formatExplanation(explanation);

    expect(formatted).toContain("Profile: builtin:default");
    expect(formatted).toContain("Tool: bash");
    expect(formatted).toContain("Input: git status");
    expect(formatted).toContain("Decision: allow");
    expect(formatted).toContain("Winner:");
    expect(formatted).toContain("Matches:");
  });

  it("shows composition chain for built-in profiles", () => {
    const explanation = explainPermission(
      policyConfig.profiles["builtin:default"],
      "builtin:default",
      "bash",
      "git status",
      startupCwd,
    );

    expect(explanation.compositionChain).toEqual([
      "ruleset:shell",
      "ruleset:git",
      "ruleset:packageManagers",
      "ruleset:deps-mutations-guard",
      "ruleset:shell-guards",
      "ruleset:path-guards",
      "builtin:default",
    ]);
  });

  it("shows composition chain for custom profiles from raw config", () => {
    const rawConfig = {
      profiles: {
        "my-profile": {
          extends: ["builtin:default"],
          transforms: ["transform:deny-asks"],
        },
      },
    };

    const explanation = explainPermission(
      policyConfig.profiles["builtin:default"],
      "my-profile",
      "bash",
      "git status",
      startupCwd,
      startupCwd,
      rawConfig as RawProfileConfig,
    );

    expect(explanation.compositionChain).toEqual([
      "ruleset:shell",
      "ruleset:git",
      "ruleset:packageManagers",
      "ruleset:deps-mutations-guard",
      "ruleset:shell-guards",
      "ruleset:path-guards",
      "builtin:default",
      "transform:deny-asks",
      "custom profile: my-profile",
    ]);
  });

  it("resolves absolute path patterns correctly", () => {
    const policy = pathProfile(
      [{ pattern: "/tmp/**", decision: "allow", contexts: ["read"] }],
      [{ pattern: "*", decision: "allow" }],
    );

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "read",
      "/tmp/file.txt",
      startupCwd,
    );

    expect(explanation.decision).toBe("allow");
    expect(explanation.winner?.pattern).toBe("/tmp/**");
  });

  it("normalizes bash commands before ranking", () => {
    const policy = bashProfile([
      { pattern: "git status", decision: "allow" },
      { pattern: "*", decision: "ask" },
    ]);

    const explanation = explainPermission(
      policy,
      "builtin:default",
      "bash",
      "  git   status  ",
      startupCwd,
    );

    expect(explanation.decision).toBe("allow");
    expect(explanation.winner?.pattern).toBe("git status");
  });
});
