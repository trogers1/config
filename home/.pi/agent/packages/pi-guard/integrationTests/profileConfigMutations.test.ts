import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyProfileRuleChanges,
  createCustomProfile,
  loadProfileConfig,
  type ProfileRuleChange,
} from "../modules/profileConfig";
import { policyConfig } from "../modules/policy";

const files: string[] = [];

afterEach(() => {
  for (const file of files.splice(0)) fs.rmSync(file, { force: true });
});

function tempConfig(): string {
  const file = path.join(
    tmpdir(),
    `pi-guard-profile-${crypto.randomUUID()}.jsonc`,
  );
  files.push(file);
  return file;
}

function readRawProfiles(
  configPath: string,
): Record<string, Record<string, unknown>> {
  return (
    JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      profiles: Record<string, Record<string, unknown>>;
    }
  ).profiles;
}

describe("profile config mutations", () => {
  it("creates and extends a profile without discarding JSONC comments", () => {
    const configPath = tempConfig();
    fs.writeFileSync(configPath, '// retained\n{\n  "profiles": {}\n}\n');

    createCustomProfile({
      fallback: policyConfig,
      configPath,
      name: "local-work",
      description: "Local work",
      emoji: "🛡️",
      extends: ["builtin:default"],
      protectedPaths: [{ pattern: ".env", decision: "deny" }],
      sandboxed: true,
    });
    applyProfileRuleChanges({
      fallback: policyConfig,
      configPath,
      target: { mode: "update", profile: "local-work" },
      changes: [
        {
          kind: "bash",
          pattern: "echo profile-rule",
          decision: "allow",
        },
      ],
    });

    expect(fs.readFileSync(configPath, "utf8")).toContain("// retained");
    expect(
      loadProfileConfig(policyConfig, configPath).profiles["local-work"].tools
        .bash,
    ).toContainEqual(
      expect.objectContaining({
        pattern: "echo profile-rule",
        decision: "allow",
      }),
    );
  });

  it("preserves scoped overrides when replacing an unscoped rule", () => {
    const configPath = tempConfig();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        profiles: {
          "scope-work": {
            description: "Profile for scope identity regression coverage",
            extends: ["builtin:default"],
            readPaths: [
              { pattern: "same.txt", decision: "deny", contexts: ["grep"] },
              { pattern: "same.txt", decision: "ask" },
            ],
          },
        },
      }),
    );

    applyProfileRuleChanges({
      fallback: policyConfig,
      configPath,
      target: { mode: "update", profile: "scope-work" },
      changes: [{ kind: "read", pattern: "same.txt", decision: "allow" }],
    });

    expect(readRawProfiles(configPath)["scope-work"].readPaths).toEqual([
      { pattern: "same.txt", decision: "deny", contexts: ["grep"] },
      { pattern: "same.txt", decision: "allow" },
    ]);
  });

  it("preserves comments on unchanged rules in an affected array", () => {
    const configPath = tempConfig();
    fs.writeFileSync(
      configPath,
      `{
  "profiles": {
    "comment-work": {
      "description": "Comment preservation",
      "extends": ["builtin:default"],
      "readPaths": [
        // Keep this explanation with the existing rule.
        { "pattern": "keep.txt", "decision": "deny" }
      ]
    }
  }
}
`,
    );

    applyProfileRuleChanges({
      fallback: policyConfig,
      configPath,
      target: { mode: "update", profile: "comment-work" },
      changes: [{ kind: "read", pattern: "new.txt", decision: "allow" }],
    });

    const source = fs.readFileSync(configPath, "utf8");
    expect(source).toContain(
      "// Keep this explanation with the existing rule.",
    );
    expect(
      loadProfileConfig(policyConfig, configPath).profiles["comment-work"]
        .readPaths,
    ).toContainEqual({ pattern: "keep.txt", decision: "deny" });
  });

  it("keeps comments attached to unchanged rules when an earlier rule is replaced", () => {
    const configPath = tempConfig();
    fs.writeFileSync(
      configPath,
      `{
  "profiles": {
    "shift-comments": {
      "description": "Comment identity preservation",
      "extends": ["builtin:default"],
      "readPaths": [
        // This ASK is being replaced.
        { "pattern": "replace.txt", "decision": "ask", "contexts": ["read"] },
        // This explanation must stay with keep.txt.
        { "pattern": "keep.txt", "decision": "deny", "contexts": ["grep"] }
      ]
    }
  }
}
`,
    );

    applyProfileRuleChanges({
      fallback: policyConfig,
      configPath,
      target: { mode: "update", profile: "shift-comments" },
      changes: [
        {
          kind: "read",
          pattern: "replace.txt",
          decision: "allow",
          contexts: ["read"],
        },
      ],
    });

    const source = fs.readFileSync(configPath, "utf8");
    expect(source).toMatch(
      /\/\/ This explanation must stay with keep\.txt\.\s*\{ "pattern": "keep\.txt", "decision": "deny", "contexts": \["grep"\] \}/,
    );
    expect(
      loadProfileConfig(policyConfig, configPath).profiles["shift-comments"]
        .readPaths,
    ).toEqual(
      expect.arrayContaining([
        { pattern: "keep.txt", decision: "deny", contexts: ["grep"] },
        { pattern: "replace.txt", decision: "allow", contexts: ["read"] },
      ]),
    );
  });

  it("persists a mixed Bash, read, and write batch atomically", () => {
    const configPath = tempConfig();
    fs.writeFileSync(configPath, '{\n  "profiles": {}\n}\n');

    applyProfileRuleChanges({
      fallback: policyConfig,
      configPath,
      target: {
        mode: "create-child",
        profile: "batch-work",
        extends: ["builtin:default"],
        description: "Mixed batch",
        emoji: "💅",
      },
      changes: [
        { kind: "bash", pattern: "echo batch", decision: "allow" },
        { kind: "read", pattern: "input.txt", decision: "deny" },
        { kind: "write", pattern: "output.txt", decision: "deny" },
      ],
    });

    const profile = loadProfileConfig(policyConfig, configPath).profiles[
      "batch-work"
    ];
    expect(profile.tools.bash).toContainEqual({
      pattern: "echo batch",
      decision: "allow",
    });
    expect(profile.readPaths).toContainEqual({
      pattern: "input.txt",
      decision: "deny",
    });
    expect(profile.writePaths).toContainEqual({
      pattern: "output.txt",
      decision: "deny",
    });
  });

  it("does not write a child or partial changes when a later change is invalid", () => {
    const configPath = tempConfig();
    const before = '{\n  "profiles": {}\n}\n';
    fs.writeFileSync(configPath, before);

    expect(() =>
      applyProfileRuleChanges({
        fallback: policyConfig,
        configPath,
        target: {
          mode: "create-child",
          profile: "failed-batch",
          extends: ["builtin:default"],
          description: "Should not persist",
          emoji: "💅",
        },
        changes: [
          { kind: "bash", pattern: "echo partial", decision: "allow" },
          {
            kind: "read",
            pattern: "bad-scope",
            decision: "deny",
            contexts: [],
          },
        ],
      }),
    ).toThrow("contexts");

    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(
      loadProfileConfig(policyConfig, configPath).profiles,
    ).not.toHaveProperty("failed-batch");
  });

  it("preserves non-overlapping scoped contexts in a batch", () => {
    const configPath = tempConfig();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        profiles: {
          "context-work": {
            description: "Context batch",
            extends: ["builtin:default"],
            writePaths: [
              { pattern: "shared.txt", decision: "deny", contexts: ["write"] },
            ],
          },
        },
      }),
    );

    applyProfileRuleChanges({
      fallback: policyConfig,
      configPath,
      target: { mode: "update", profile: "context-work" },
      changes: [
        {
          kind: "write",
          pattern: "shared.txt",
          decision: "allow",
          contexts: ["edit"],
        },
      ],
    });

    expect(readRawProfiles(configPath)["context-work"].writePaths).toEqual([
      { pattern: "shared.txt", decision: "deny", contexts: ["write"] },
      { pattern: "shared.txt", decision: "allow", contexts: ["edit"] },
    ]);
  });

  it("splits a multi-context rule and preserves an unscoped fallback", () => {
    const configPath = tempConfig();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        profiles: {
          "split-work": {
            description: "Context split",
            extends: ["builtin:default"],
            writePaths: [
              {
                pattern: "shared.txt",
                decision: "deny",
                contexts: ["edit", "write"],
              },
              { pattern: "shared.txt", decision: "ask" },
            ],
          },
        },
      }),
    );

    applyProfileRuleChanges({
      fallback: policyConfig,
      configPath,
      target: { mode: "update", profile: "split-work" },
      changes: [
        {
          kind: "write",
          pattern: "shared.txt",
          decision: "allow",
          contexts: ["edit"],
        },
      ],
    });

    expect(readRawProfiles(configPath)["split-work"].writePaths).toEqual([
      { pattern: "shared.txt", decision: "deny", contexts: ["write"] },
      { pattern: "shared.txt", decision: "ask" },
      { pattern: "shared.txt", decision: "allow", contexts: ["edit"] },
    ]);
  });

  it("rejects contextual Bash/protected changes before any write", () => {
    const configPath = tempConfig();
    const before = '{\n  "profiles": {}\n}\n';
    fs.writeFileSync(configPath, before);
    const malformed = {
      kind: "bash",
      pattern: "echo ambiguous",
      decision: "allow",
      contexts: ["bash"],
    } as unknown as ProfileRuleChange;

    expect(() =>
      applyProfileRuleChanges({
        fallback: policyConfig,
        configPath,
        target: {
          mode: "create-child",
          profile: "ambiguous",
          extends: ["builtin:default"],
          description: "Must not write",
          emoji: "💅",
        },
        changes: [malformed],
      }),
    ).toThrow("contexts are not valid for bash");
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
  });

  it("applies a swap of two request-derived Bash identities without loss", () => {
    const configPath = tempConfig();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        profiles: {
          swap: {
            description: "Swap fixture",
            extends: ["builtin:default"],
            tools: {
              bash: [
                { pattern: "echo A", decision: "ask" },
                { pattern: "echo B", decision: "ask" },
              ],
            },
          },
        },
      }),
    );

    applyProfileRuleChanges({
      fallback: policyConfig,
      configPath,
      target: { mode: "update", profile: "swap" },
      changes: [
        {
          kind: "bash",
          pattern: "echo B",
          replacePattern: "echo A",
          decision: "allow",
        },
        {
          kind: "bash",
          pattern: "echo A",
          replacePattern: "echo B",
          decision: "deny",
        },
      ],
    });

    expect(readRawProfiles(configPath).swap.tools).toEqual({
      bash: [
        { pattern: "echo B", decision: "allow" },
        { pattern: "echo A", decision: "deny" },
      ],
    });
  });

  it("writes nonempty bash rules directly and omits empty tools", () => {
    const emptyConfigPath = tempConfig();
    fs.writeFileSync(emptyConfigPath, '{\n  "profiles": {}\n}\n');
    createCustomProfile({
      fallback: policyConfig,
      configPath: emptyConfigPath,
      name: "empty-rules",
      description: "No direct rules",
      extends: ["builtin:default"],
      bashRules: [],
    });
    expect(readRawProfiles(emptyConfigPath)["empty-rules"]).not.toHaveProperty(
      "tools",
    );

    const configPath = tempConfig();
    fs.writeFileSync(configPath, '{\n  "profiles": {}\n}\n');
    createCustomProfile({
      fallback: policyConfig,
      configPath,
      name: "direct-rules",
      description: "Direct rules",
      extends: ["builtin:default"],
      bashRules: [
        {
          pattern: "git status",
          decision: "allow",
          guidance: "Inspect the working tree without changing files.",
        },
      ],
    });

    expect(
      loadProfileConfig(policyConfig, configPath).profiles["direct-rules"].tools
        .bash,
    ).toContainEqual({
      pattern: "git status",
      decision: "allow",
      guidance: "Inspect the working tree without changing files.",
    });
    expect(readRawProfiles(configPath)["direct-rules"].tools).toEqual({
      bash: [
        {
          pattern: "git status",
          decision: "allow",
          guidance: "Inspect the working tree without changing files.",
        },
      ],
    });
  });

  it("does not overwrite an invalid source file", () => {
    const configPath = tempConfig();
    fs.writeFileSync(configPath, "{ invalid");

    expect(() =>
      createCustomProfile({
        fallback: policyConfig,
        configPath,
        name: "local-work",
        description: "Local work",
        extends: ["builtin:default"],
      }),
    ).toThrow("JSONC parse error");
    expect(fs.readFileSync(configPath, "utf8")).toBe("{ invalid");
  });
});
