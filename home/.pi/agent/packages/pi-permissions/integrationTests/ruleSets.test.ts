import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decideBash } from "../extensions/permissions";
import { policyConfig as genericPolicyConfig } from "../modules/policy";
import {
  defaultGuardRules,
  ruleSetNames,
  ruleSetRegistry,
} from "../modules/ruleSets.lib/index";
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
  it("exports the shipped rule-set bundle", () => {
    expect(defaultGuardRules.length).toBeGreaterThan(0);
  });

  it("ruleset:shell-guards resolves to the shipped guards partial policy", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          guarded: {
            extends: ["ruleset:shell-guards"],
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
  });

  it("user profiles may not use the reserved ruleset: prefix", () => {
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

  it("unknown rule set names fail loudly", () => {
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

  it("prototype properties do not resolve as rule sets", () => {
    expect(() =>
      loadProfileConfig(
        genericPolicyConfig,
        writeConfig({
          profiles: {
            custom: {
              extends: ["constructor"],
              ...minimalPaths,
            },
          },
        }),
      ),
    ).toThrow(/unknown inherited profile/);
  });

  it("extends can mix builtin profiles and rule sets", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          mixed: {
            extends: ["builtin:default", "ruleset:shell-guards"],
            ...minimalPaths,
          },
        },
      }),
    );

    expect(decideBash("find . -delete", config.profiles.mixed)).toBe("deny");
  });

  it("deps-mutations rule sets are decision twins generated from one table", () => {
    const deny =
      ruleSetRegistry["ruleset:deps-mutations-guard"].tools?.bash ?? [];
    const allow =
      ruleSetRegistry["ruleset:deps-mutations-allow"].tools?.bash ?? [];

    expect(deny.length).toBeGreaterThan(0);
    expect(allow.map((rule) => rule.pattern)).toEqual(
      deny.map((rule) => rule.pattern),
    );
    expect(deny.every((rule) => rule.decision === "deny")).toBe(true);
    expect(allow.every((rule) => rule.decision === "allow")).toBe(true);
  });

  it("deps-mutations-allow opens dependency work while publish stays denied", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          "deps-work": {
            extends: [
              "ruleset:packageManagers",
              "ruleset:deps-mutations-allow",
            ],
            ...minimalPaths,
          },
        },
      }),
    );

    expect(decideBash("npm install lodash", config.profiles["deps-work"])).toBe(
      "allow",
    );
    expect(decideBash("npm publish", config.profiles["deps-work"])).toBe(
      "deny",
    );
  });

  it("deps-mutations-guard restores the standard guarded posture", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          guarded: {
            extends: [
              "ruleset:packageManagers",
              "ruleset:deps-mutations-guard",
            ],
            ...minimalPaths,
          },
        },
      }),
    );

    expect(decideBash("npm install lodash", config.profiles.guarded)).toBe(
      "deny",
    );
  });

  it("git-write composes commit permissions onto any base", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          committer: {
            extends: ["ruleset:git-commit"],
            ...minimalPaths,
          },
        },
      }),
    );

    expect(decideBash("git commit -m test", config.profiles.committer)).toBe(
      "allow",
    );
    expect(decideBash("git push origin main", config.profiles.committer)).toBe(
      "ask",
    );
  });

  it("the TypeScript rule-set registry is the same registry JSONC resolves against", () => {
    expect(ruleSetNames()).toEqual(Object.keys(ruleSetRegistry));

    for (const name of ruleSetNames()) {
      const config = loadProfileConfig(
        genericPolicyConfig,
        writeConfig({
          profiles: {
            comparison: {
              extends: [name],
              ...minimalPaths,
            },
          },
        }),
      );
      const resolved = config.profiles.comparison;
      const registered = ruleSetRegistry[name];

      expect(resolved.tools.bash ?? []).toEqual(registered.tools?.bash ?? []);

      if (registered.readPaths) {
        expect(
          resolved.readPaths.slice(0, registered.readPaths.length),
        ).toEqual(registered.readPaths);
      }
      if (registered.writePaths) {
        expect(
          resolved.writePaths.slice(0, registered.writePaths.length),
        ).toEqual(registered.writePaths);
      }
    }
  });
});
