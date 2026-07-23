import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { policyConfig as genericPolicyConfig } from "../modules/policy";
import { loadProfileConfig } from "../modules/profileConfig";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function writeConfig(contents: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permissions-"));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "profiles.jsonc");
  fs.writeFileSync(configPath, contents);
  return configPath;
}

describe("profile configuration", () => {
  it("uses the shipped profiles when the user configuration is absent", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      path.join(os.tmpdir(), "missing-pi-permissions-profiles.jsonc"),
    );

    expect(config).toBe(genericPolicyConfig);
  });

  it("parses JSONC and extends a shipped profile", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig(`{
        // Editor JSON Schema directives, comments, and trailing commas are supported.
        "$schema": "https://example.test/profiles.schema.json",
        "profiles": {
          "client-work": {
            "extends": "default",
            "directories": ["/workspace/client",],
            "tools": {
              "bash": [{ "pattern": "client-cli *", "decision": "allow" }],
            },
          },
        },
      }`),
    );

    const clientWork = config.profiles["client-work"];
    expect(clientWork.directories).toEqual(["/workspace/client"]);
    expect(clientWork.tools.bash).toEqual(
      expect.arrayContaining([{ pattern: "client-cli *", decision: "allow" }]),
    );
    expect(clientWork.tools.bash.length).toBeGreaterThan(
      genericPolicyConfig.profiles.default.tools.bash.length,
    );
  });

  it("accepts a fully custom profile without extends", () => {
    const standaloneProfile = {
      ...genericPolicyConfig.profiles.default,
      emoji: "🧪",
    };
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig(
        JSON.stringify({
          profiles: { standalone: standaloneProfile },
        }),
      ),
    );

    expect(config.profiles.standalone).toMatchObject({ emoji: "🧪" });
  });

  it("falls back to shipped profiles for invalid inheritance or invalid JSONC", () => {
    const cyclicConfig = loadProfileConfig(
      genericPolicyConfig,
      writeConfig(`{
        "profiles": {
          "first": { "extends": "second" },
          "second": { "extends": "first" }
        }
      }`),
    );
    const invalidJson = loadProfileConfig(
      genericPolicyConfig,
      writeConfig('{ "profiles": '),
    );

    expect(cyclicConfig).toBe(genericPolicyConfig);
    expect(invalidJson).toBe(genericPolicyConfig);
  });
});
