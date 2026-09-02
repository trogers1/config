import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendProfileRule,
  createCustomProfile,
  loadProfileConfig,
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
    appendProfileRule({
      fallback: policyConfig,
      configPath,
      profile: "local-work",
      kind: "bash",
      pattern: "echo profile-rule",
      decision: "allow",
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
