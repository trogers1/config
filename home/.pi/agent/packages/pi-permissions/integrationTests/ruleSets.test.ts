/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decideBash } from "../extensions/permissions";
import { policyConfig as genericPolicyConfig } from "../modules/policy";
import * as policyHelpers from "../modules/policyHelpers";
import type { ProfilePolicy } from "../modules/policyHelpers";
import { loadProfileConfig } from "../modules/profileConfig";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function writeConfig(contents: unknown): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permissions-"));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "profiles.jsonc");
  fs.writeFileSync(configPath, JSON.stringify(contents));
  return configPath;
}

const minimalPaths: Pick<ProfilePolicy, "readPaths" | "writePaths"> = {
  readPaths: [{ pattern: "*", decision: "allow" }],
  writePaths: [{ pattern: "*", decision: "allow" }],
};

describe("rule-set namespace", () => {
  it.fails(
    "ruleset:guards resolves to the shipped guards partial policy",
    () => {
      const config = loadProfileConfig(
        genericPolicyConfig,
        writeConfig({
          profiles: {
            guarded: {
              extends: ["ruleset:guards"],
              ...minimalPaths,
            },
          },
        }),
      );

      expect(
        config.profiles.guarded.tools.bash?.some(
          (rule) => rule.pattern === "find * -delete*",
        ),
      ).toBe(true);
    },
  );

  it.fails("user profiles may not use the reserved ruleset: prefix", () => {
    expect(() =>
      loadProfileConfig(
        genericPolicyConfig,
        writeConfig({
          profiles: {
            "ruleset:evil": {
              extends: ["builtin:default"],
            },
          },
        }),
      ),
    ).toThrow(/reserved profile name/);
  });

  it.fails("unknown rule set names fail loudly", () => {
    expect(() =>
      loadProfileConfig(
        genericPolicyConfig,
        writeConfig({
          profiles: {
            custom: {
              extends: ["ruleset:missing"],
              ...minimalPaths,
            },
          },
        }),
      ),
    ).toThrow(/unknown rule set/);
  });

  it.fails("extends can mix builtin profiles and rule sets", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          mixed: {
            extends: ["builtin:default", "ruleset:guards"],
            ...minimalPaths,
          },
        },
      }),
    );

    expect(decideBash("find . -delete", config.profiles.mixed)).toBe("deny");
  });

  it.fails(
    "the TypeScript rule-set registry is the same registry JSONC resolves against",
    () => {
      // @ts-expect-error future exported registry
      const names: string[] = policyHelpers.ruleSetNames?.() ?? [];
      expect(names).toContain("ruleset:guards");
    },
  );
});
