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
