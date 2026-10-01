import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decideBash } from "../extensions/guard";
import {
  builtinCompositionChains,
  policyConfig as genericPolicyConfig,
} from "../modules/policy";
import {
  defaultGuardRules,
  ruleSetDefinition,
  ruleSetNames,
  ruleSetRegistry,
} from "../modules/ruleSets.lib/index";
import {
  parsePolicyConfig,
  type ProfilePolicy,
} from "../modules/policyHelpers";
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-"));
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
    const config = loadProfileConfig({
      fallback: genericPolicyConfig,
      configPath: writeConfig({
        profiles: {
          guarded: {
            description:
              "Shell guard ruleset profile denying dangerous Bash commands.",
            extends: ["ruleset:shell-guards"],
            ...minimalPaths,
          },
        },
      }),
    });

    expect(
      config.profiles.guarded.policy.tools.bash?.some(
        (rule) => rule.pattern === "find * -delete*",
      ),
    ).toBe(true);
  });

  it("ruleset:shell allows basic workspace file operations", () => {
    const config = loadProfileConfig({
      fallback: genericPolicyConfig,
      configPath: writeConfig({
        profiles: {
          filesystem: {
            description:
              "Default shell ruleset permits basic workspace file operations.",
            extends: ["ruleset:shell"],
            ...minimalPaths,
          },
        },
      }),
    });

    const policy = config.profiles.filesystem.policy;
    for (const command of [
      "cp source.txt copy.txt",
      "mkdir generated",
      "mv draft.txt final.txt",
      "rm generated-file",
      "touch generated-file",
    ]) {
      expect(decideBash(command, policy), command).toBe("allow");
    }
  });

  it("ruleset:read-only-shell and ruleset:read-only-path resolve through JSONC", () => {
    const config = loadProfileConfig({
      fallback: genericPolicyConfig,
      configPath: writeConfig({
        profiles: {
          comparison: {
            description: "Read-only shell and path ruleset comparison profile.",
            extends: ["ruleset:read-only-path", "ruleset:read-only-shell"],
          },
        },
      }),
    });

    const resolved = config.profiles.comparison.policy;
    const shell = ruleSetRegistry["ruleset:read-only-shell"];
    const pathPosture = ruleSetRegistry["ruleset:read-only-path"];

    expect(resolved.tools.bash).toEqual(shell.policy.tools?.bash ?? []);
    expect(resolved.readPaths).toEqual(pathPosture.policy.readPaths ?? []);
    expect(resolved.writePaths).toEqual(pathPosture.policy.writePaths ?? []);
    expect(resolved.protectedPathRules).toEqual(
      pathPosture.policy.protectedPathRules ?? [],
    );
    for (const command of [
      "cp source.txt copy.txt",
      "mkdir generated",
      "mv draft.txt final.txt",
      "rm generated-file",
      "touch generated-file",
    ]) {
      expect(decideBash(command, resolved), command).toBe("deny");
    }
  });

  it("builtin:read-only reuses the shipped read-only rule-set arrays", () => {
    const builtin = genericPolicyConfig.profiles["builtin:read-only"].policy;
    const shell = ruleSetRegistry["ruleset:read-only-shell"];
    const pathPosture = ruleSetRegistry["ruleset:read-only-path"];

    expect(builtin.tools.bash).toBe(shell.policy.tools?.bash);
    expect(builtin.readPaths).toBe(pathPosture.policy.readPaths);
    expect(builtin.writePaths).toBe(pathPosture.policy.writePaths);
    expect(builtin.protectedPathRules).toBe(
      pathPosture.policy.protectedPathRules,
    );
    expect(builtinCompositionChains["builtin:read-only"]).toEqual([
      "ruleset:read-only-path",
      "ruleset:read-only-shell",
      "builtin:read-only",
    ]);
  });

  it("ruleset:path-guards protects sensitive paths when composed through user config", async () => {
    vi.stubEnv(
      "PI_GUARD_PROFILE_CONFIG",
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
    const config = loadProfileConfig({
      fallback: genericPolicyConfig,
      configPath: writeConfig({
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
    });

    expect(decideBash("terraform apply", config.profiles.guarded.policy)).toBe(
      "deny",
    );
    expect(config.profiles["infra-mutation-deny"]).toBeUndefined();
  });

  it("user profiles may not use reserved rule-set prefixes", () => {
    for (const name of ["ruleset:evil", "customruleset:evil"]) {
      expect(() =>
        loadProfileConfig({
          fallback: genericPolicyConfig,
          configPath: writeConfig({
            profiles: {
              [name]: {
                description:
                  "Invalid reserved-name profile for namespace validation.",
                extends: ["builtin:default"],
              },
            },
          }),
        }),
      ).toThrow(/reserved profile name/);
    }
  });

  it("records exact runtime requirements and provenance from composition", () => {
    const profile = genericPolicyConfig.profiles["builtin:default"];
    expect(profile.runtime.requirements).toEqual(["go-toolchain-cache"]);
    expect(profile.runtime.provenance).toEqual({
      "go-toolchain-cache": ["ruleset:go-runtime-commands"],
    });
  });

  it("keeps runtime metadata explicit and serializable", () => {
    const profile = genericPolicyConfig.profiles["builtin:default"];
    expect(profile.runtime).toEqual({
      implicitAskDecision: "ask",
      requirements: ["go-toolchain-cache"],
      provenance: {
        "go-toolchain-cache": ["ruleset:go-runtime-commands"],
      },
    });
    expect(JSON.parse(JSON.stringify(profile))).toHaveProperty("runtime");
  });

  it("carries audited runtime requirements through shipped rule-set composition", () => {
    const config = loadProfileConfig({
      fallback: genericPolicyConfig,
      configPath: writeConfig({
        profiles: {
          reviewer: {
            description:
              "Reviewer profile with explicit shipped runtime requirement sets.",
            extends: [
              "builtin:read-only",
              "ruleset:go-runtime-commands",
              "ruleset:vitest",
            ],
          },
        },
      }),
    });

    expect(config.profiles.reviewer.runtime.requirements).toEqual(
      expect.arrayContaining(["go-toolchain-cache", "vitest-vite-temp"]),
    );
  });

  it("preserves inherited requirements through transforms and unions duplicate provenance", () => {
    const config = loadProfileConfig({
      fallback: genericPolicyConfig,
      configPath: writeConfig({
        profiles: {
          first: {
            description: "First Vitest workflow parent.",
            extends: ["ruleset:vitest"],
            ...minimalPaths,
          },
          second: {
            description: "Second Vitest workflow parent.",
            extends: ["ruleset:vitest"],
            ...minimalPaths,
          },
          transformed: {
            description: "Transformed child retains workflow requirements.",
            extends: ["first", "second"],
            transforms: ["transform:deny-asks"],
          },
        },
      }),
    });

    expect(config.profiles.transformed.runtime.requirements).toEqual([
      "vitest-vite-temp",
    ]);
    expect(config.profiles.transformed.runtime.provenance).toEqual({
      "vitest-vite-temp": ["ruleset:vitest"],
    });
  });

  it("preserves hidden built-in workflow requirements through transforms", () => {
    const config = loadProfileConfig({
      fallback: genericPolicyConfig,
      configPath: writeConfig({
        profiles: {
          transformed: {
            description: "Transformed default workflow profile.",
            extends: ["builtin:default"],
            transforms: ["transform:allow-asks"],
          },
        },
      }),
    });

    expect(config.profiles.transformed.runtime.requirements).toEqual([
      "go-toolchain-cache",
    ]);
    expect(config.profiles.transformed.runtime.provenance).toEqual({
      "go-toolchain-cache": ["ruleset:go-runtime-commands"],
    });
  });

  it("rejects invalid programmatic runtime requirements", () => {
    const invalid = {
      defaultProfile: "invalid",
      profiles: {
        invalid: {
          ...genericPolicyConfig.profiles["builtin:read-only"],
          runtime: {
            ...genericPolicyConfig.profiles["builtin:read-only"].runtime,
            requirements: ["not-a-capability"],
            provenance: {},
          },
        },
      },
    };
    expect(() => parsePolicyConfig({ unverifiedConfig: invalid })).toThrow(
      "/profiles/invalid/runtime/requirements",
    );
  });

  it.each([
    {
      name: "missing runtime metadata",
      profile: {
        policy: genericPolicyConfig.profiles["builtin:read-only"].policy,
      },
    },
    {
      name: "missing selected-requirement provenance",
      profile: {
        policy: genericPolicyConfig.profiles["builtin:read-only"].policy,
        runtime: {
          requirements: ["vitest-vite-temp"],
          provenance: {},
        },
      },
    },
    {
      name: "provenance for an unselected requirement",
      profile: {
        policy: genericPolicyConfig.profiles["builtin:read-only"].policy,
        runtime: {
          requirements: [],
          provenance: { "vitest-vite-temp": ["ruleset:vitest"] },
        },
      },
    },
    {
      name: "an empty provenance selector",
      profile: {
        policy: genericPolicyConfig.profiles["builtin:read-only"].policy,
        runtime: {
          requirements: ["vitest-vite-temp"],
          provenance: { "vitest-vite-temp": [] },
        },
      },
    },
    {
      name: "an unknown resolved-profile property",
      profile: {
        ...genericPolicyConfig.profiles["builtin:read-only"],
        unexpected: true,
      },
    },
  ])("rejects $name", ({ profile }) => {
    expect(() =>
      parsePolicyConfig({
        unverifiedConfig: {
          defaultProfile: "invalid",
          profiles: { invalid: profile },
        },
      }),
    ).toThrow();
  });

  it("rejects runtime requirements from raw profiles and custom rule sets", () => {
    for (const document of [
      {
        profiles: {
          guarded: {
            description: "A profile must not select internal requirements.",
            extends: ["builtin:default"],
            runtimeRequirements: ["vitest-vite-temp"],
          },
        },
      },
      {
        rulesets: {
          invalid: { runtimeRequirements: ["vitest-vite-temp"] },
        },
        profiles: {
          guarded: {
            description:
              "A custom rule set must not select internal requirements.",
            extends: ["builtin:default"],
          },
        },
      },
    ]) {
      expect(() =>
        loadProfileConfig({
          fallback: genericPolicyConfig,
          configPath: writeConfig(document),
        }),
      ).toThrow(/schema validation failed/);
    }
  });

  it("custom rule sets reject profile fields and unknown references fail loudly", () => {
    expect(() =>
      loadProfileConfig({
        fallback: genericPolicyConfig,
        configPath: writeConfig({
          rulesets: {
            invalid: {
              description: "Rule sets are not profiles.",
              runtimeRequirements: ["vitest-vite-temp"],
            },
          },
          profiles: {
            guarded: {
              description:
                "Profile with an invalid custom rule-set definition.",
              extends: ["builtin:default"],
            },
          },
        }),
      }),
    ).toThrow(/schema validation failed/);

    expect(() =>
      loadProfileConfig({
        fallback: genericPolicyConfig,
        configPath: writeConfig({
          profiles: {
            guarded: {
              description: "Profile with a missing custom rule set.",
              extends: ["builtin:default", "customruleset:missing"],
            },
          },
        }),
      }),
    ).toThrow(/unknown custom rule set/);
  });

  it("unknown rule set names fail loudly", () => {
    expect(() =>
      loadProfileConfig({
        fallback: genericPolicyConfig,
        configPath: writeConfig({
          profiles: {
            custom: {
              description: "Invalid profile for unknown rule-set validation.",
              extends: ["ruleset:missing"],
              ...minimalPaths,
            },
          },
        }),
      }),
    ).toThrow(/unknown rule set/);
  });

  it("prototype properties do not resolve as rule sets", () => {
    expect(() =>
      loadProfileConfig({
        fallback: genericPolicyConfig,
        configPath: writeConfig({
          profiles: {
            custom: {
              description:
                "Invalid profile for prototype inherited-profile validation.",
              extends: ["constructor"],
              ...minimalPaths,
            },
          },
        }),
      }),
    ).toThrow(/unknown inherited profile/);
  });

  it("extends can mix builtin profiles and rule sets", () => {
    const config = loadProfileConfig({
      fallback: genericPolicyConfig,
      configPath: writeConfig({
        profiles: {
          mixed: {
            description:
              "Profile combining the default policy with shell guard rules.",
            extends: ["builtin:default", "ruleset:shell-guards"],
            ...minimalPaths,
          },
        },
      }),
    });

    expect(decideBash("find . -delete", config.profiles.mixed.policy)).toBe(
      "deny",
    );
  });

  it("deps-mutations rule sets are decision twins generated from one table", () => {
    const deny =
      ruleSetRegistry["ruleset:deps-mutations-guard"].policy.tools?.bash ?? [];
    const allow =
      ruleSetRegistry["ruleset:deps-mutations-allow"].policy.tools?.bash ?? [];

    expect(deny.length).toBeGreaterThan(0);
    expect(allow.map((rule) => rule.pattern)).toEqual(
      deny.map((rule) => rule.pattern),
    );
    expect(deny.every((rule) => rule.decision === "deny")).toBe(true);
    expect(allow.every((rule) => rule.decision === "allow")).toBe(true);
  });

  it("deps-mutations-allow opens dependency work while publish stays denied", () => {
    const config = loadProfileConfig({
      fallback: genericPolicyConfig,
      configPath: writeConfig({
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
    });

    expect(
      decideBash("npm install lodash", config.profiles["deps-work"].policy),
    ).toBe("allow");
    expect(decideBash("npm publish", config.profiles["deps-work"].policy)).toBe(
      "deny",
    );
  });

  it("deps-mutations-guard restores the standard guarded posture", () => {
    const config = loadProfileConfig({
      fallback: genericPolicyConfig,
      configPath: writeConfig({
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
    });

    expect(
      decideBash("npm install lodash", config.profiles.guarded.policy),
    ).toBe("deny");
  });

  it("git-write composes commit permissions onto any base", () => {
    const config = loadProfileConfig({
      fallback: genericPolicyConfig,
      configPath: writeConfig({
        profiles: {
          committer: {
            description:
              "Git commit ruleset profile allowing commits and asking for pushes.",
            extends: ["ruleset:git-commit"],
            ...minimalPaths,
          },
        },
      }),
    });

    expect(
      decideBash("git commit -m test", config.profiles.committer.policy),
    ).toBe("allow");
    expect(
      decideBash("git push origin main", config.profiles.committer.policy),
    ).toBe("ask");
  });

  it("the TypeScript rule-set registry is the same registry JSONC resolves against", () => {
    expect(ruleSetNames()).toEqual(Object.keys(ruleSetRegistry));

    for (const name of ruleSetNames()) {
      const config = loadProfileConfig({
        fallback: genericPolicyConfig,
        configPath: writeConfig({
          profiles: {
            comparison: {
              description:
                "Rule-set registry comparison profile for JSONC resolution.",
              extends: [name],
              ...minimalPaths,
            },
          },
        }),
      });
      const resolved = config.profiles.comparison.policy;
      const registered = ruleSetDefinition({ name });

      expect(resolved.tools.bash ?? []).toEqual(
        registered.policy.tools?.bash ?? [],
      );

      if (registered.policy.readPaths) {
        expect(
          resolved.readPaths.slice(0, registered.policy.readPaths.length),
        ).toEqual(registered.policy.readPaths);
      }
      if (registered.policy.writePaths) {
        expect(
          resolved.writePaths.slice(0, registered.policy.writePaths.length),
        ).toEqual(registered.policy.writePaths);
      }
    }
  });
});
