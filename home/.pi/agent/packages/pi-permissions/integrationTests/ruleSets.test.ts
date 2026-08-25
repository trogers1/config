import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decideBash } from "../extensions/permissions";
import {
  builtinCompositionChains,
  policyConfig as genericPolicyConfig,
} from "../modules/policy";
import {
  defaultGuardRules,
  ruleSetNames,
  ruleSetRegistry,
} from "../modules/ruleSets.lib/index";
import type { ProfilePolicy } from "../modules/policyHelpers";
import { loadProfileConfig } from "../modules/profileConfig";
import { createExtensionHarness } from "./support/extensionHarness";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
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
            description:
              "Shell guard ruleset profile denying dangerous Bash commands.",
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

  it("ruleset:read-only-shell and ruleset:read-only-path resolve through JSONC", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          comparison: {
            description: "Read-only shell and path ruleset comparison profile.",
            extends: ["ruleset:read-only-path", "ruleset:read-only-shell"],
          },
        },
      }),
    );

    const resolved = config.profiles.comparison;
    const shell = ruleSetRegistry["ruleset:read-only-shell"];
    const pathPosture = ruleSetRegistry["ruleset:read-only-path"];

    expect(resolved.tools.bash).toEqual(shell.tools?.bash ?? []);
    expect(resolved.readPaths).toEqual(pathPosture.readPaths ?? []);
    expect(resolved.writePaths).toEqual(pathPosture.writePaths ?? []);
    expect(resolved.protectedPathRules).toEqual(
      pathPosture.protectedPathRules ?? [],
    );
  });

  it("builtin:read-only reuses the shipped read-only rule-set arrays", () => {
    const builtin = genericPolicyConfig.profiles["builtin:read-only"];
    const shell = ruleSetRegistry["ruleset:read-only-shell"];
    const pathPosture = ruleSetRegistry["ruleset:read-only-path"];

    expect(builtin.tools.bash).toBe(shell.tools?.bash);
    expect(builtin.readPaths).toBe(pathPosture.readPaths);
    expect(builtin.writePaths).toBe(pathPosture.writePaths);
    expect(builtin.protectedPathRules).toBe(pathPosture.protectedPathRules);
    expect(builtinCompositionChains["builtin:read-only"]).toEqual([
      "ruleset:read-only-path",
      "ruleset:read-only-shell",
      "builtin:read-only",
    ]);
  });

  it("ruleset:path-guards protects sensitive paths when composed through user config", async () => {
    vi.stubEnv(
      "PI_PERMISSIONS_PROFILE_CONFIG",
      writeConfig({
        defaultProfile: "guarded-paths",
        profiles: {
          "guarded-paths": {
            description:
              "Sensitive-path protection ruleset profile for read access.",
            extends: ["ruleset:path-guards"],
            tools: { bash: [{ pattern: "*", decision: "allow" }] },
          },
        },
      }),
    );
    const harness = createExtensionHarness();
    await harness.start();

    const result = await harness.callTool({
      toolName: "read",
      input: { path: ".env" },
    });

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("protected from disclosure and mutation");
    expect(harness.ui.confirm).not.toHaveBeenCalled();
  });

  it("custom rule sets resolve as partial policies through customruleset: references", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        rulesets: {
          "infra-mutation-deny": {
            tools: {
              bash: [{ pattern: "terraform apply*", decision: "deny" }],
            },
          },
        },
        profiles: {
          guarded: {
            description:
              "Custom rule-set profile denying infrastructure mutations.",
            extends: ["builtin:default", "customruleset:infra-mutation-deny"],
          },
        },
      }),
    );

    expect(decideBash("terraform apply", config.profiles.guarded)).toBe("deny");
    expect(config.profiles["infra-mutation-deny"]).toBeUndefined();
  });

  it("user profiles may not use reserved rule-set prefixes", () => {
    for (const name of ["ruleset:evil", "customruleset:evil"]) {
      expect(() =>
        loadProfileConfig(
          genericPolicyConfig,
          writeConfig({
            profiles: {
              [name]: {
                description:
                  "Invalid reserved-name profile for namespace validation.",
                extends: ["builtin:default"],
              },
            },
          }),
        ),
      ).toThrow(/reserved profile name/);
    }
  });

  it("custom rule sets reject profile fields and unknown references fail loudly", () => {
    expect(() =>
      loadProfileConfig(
        genericPolicyConfig,
        writeConfig({
          rulesets: {
            invalid: { description: "Rule sets are not profiles." },
          },
          profiles: {
            guarded: {
              description:
                "Profile with an invalid custom rule-set definition.",
              extends: ["builtin:default"],
            },
          },
        }),
      ),
    ).toThrow(/schema validation failed/);

    expect(() =>
      loadProfileConfig(
        genericPolicyConfig,
        writeConfig({
          profiles: {
            guarded: {
              description: "Profile with a missing custom rule set.",
              extends: ["builtin:default", "customruleset:missing"],
            },
          },
        }),
      ),
    ).toThrow(/unknown custom rule set/);
  });

  it("unknown rule set names fail loudly", () => {
    expect(() =>
      loadProfileConfig(
        genericPolicyConfig,
        writeConfig({
          profiles: {
            custom: {
              description: "Invalid profile for unknown rule-set validation.",
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
              description:
                "Invalid profile for prototype inherited-profile validation.",
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
            description:
              "Profile combining the default policy with shell guard rules.",
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
            description:
              "Dependency mutation allow ruleset profile for package work.",
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
            description:
              "Dependency mutation guard ruleset profile denying package changes.",
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
            description:
              "Git commit ruleset profile allowing commits and asking for pushes.",
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
              description:
                "Rule-set registry comparison profile for JSONC resolution.",
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
