import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decideBash } from "../extensions/guard";
import { policyConfig as genericPolicyConfig } from "../modules/policy";
import type {
  ProfilePolicy,
  ProtectedPathRule,
} from "../modules/policyHelpers";
import { loadProfileConfig } from "../modules/profileConfig";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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

describe("profile composition", () => {
  it("multi-extends folds left-to-right so the rightmost parent wins on conflicts", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          left: {
            description:
              "Left parent profile for composition conflict resolution",
            ...minimalPaths,
            tools: { bash: [{ pattern: "demo", decision: "allow" }] },
          },
          right: {
            description:
              "Right parent profile for composition conflict resolution",
            ...minimalPaths,
            tools: { bash: [{ pattern: "demo", decision: "deny" }] },
          },
          composed: {
            description:
              "Composed profile testing left-to-right inheritance precedence",
            extends: ["left", "right"],
            ...minimalPaths,
          },
        },
      }),
    );

    expect(decideBash("demo", config.profiles.composed)).toBe("deny");
  });

  it("fold-is-concatenation: extending read-only then default re-opens bash to ask", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          reopened: {
            description:
              "Reopened profile testing read-only and default composition",
            extends: ["builtin:read-only", "builtin:default"],
          },
        },
      }),
    );

    expect(
      decideBash("python scripts/build.py", config.profiles.reopened),
    ).toBe("ask");
  });

  it("transform:deny-asks converts every ordinary ask to deny", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          "worker-like": {
            description:
              "Worker profile transforming approval prompts into denials",
            extends: ["builtin:default"],
            transforms: ["transform:deny-asks"],
          },
        },
      }),
    );

    expect(
      decideBash("python scripts/build.py", config.profiles["worker-like"]),
    ).toBe("deny");
  });

  it("transform:allow-asks converts every ordinary ask to allow", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          "auto-approve": {
            description:
              "Auto-approve profile transforming approval prompts into allows",
            extends: ["builtin:default"],
            transforms: ["transform:allow-asks"],
          },
        },
      }),
    );

    expect(
      decideBash("python scripts/build.py", config.profiles["auto-approve"]),
    ).toBe("allow");
  });

  it("transform:ask-all converts every ordinary allow to ask", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          paranoid: {
            description:
              "Paranoid profile transforming ordinary allows into asks",
            extends: ["builtin:default"],
            transforms: ["transform:ask-all"],
          },
        },
      }),
    );

    expect(decideBash("git status --short", config.profiles.paranoid)).toBe(
      "ask",
    );
  });

  it("transform:deny-all converts every ordinary decision to deny", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          paranoid: {
            description:
              "Paranoid profile transforming every decision into denial",
            extends: ["builtin:default"],
            transforms: ["transform:deny-all"],
          },
        },
      }),
    );

    expect(decideBash("ls", config.profiles.paranoid)).toBe("deny");
    expect(decideBash("git status --short", config.profiles.paranoid)).toBe(
      "deny",
    );
    expect(
      decideBash("python scripts/build.py", config.profiles.paranoid),
    ).toBe("deny");
  });

  it.each([
    "transform:deny-asks",
    "transform:allow-asks",
    "transform:ask-all",
    "transform:deny-all",
  ])("%s leaves inherited protected-path rules unchanged", (transform) => {
    const protectedPathRules: ProtectedPathRule[] = [
      { pattern: "safe.env", decision: "allow" },
      { pattern: "**/.env*", decision: "deny" },
    ];
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          parent: {
            description:
              "Parent profile carrying protected paths through transforms",
            tools: { bash: [{ pattern: "*", decision: "ask" }] },
            ...minimalPaths,
            protectedPathRules,
          },
          child: {
            description:
              "Child profile preserving inherited protected path rules",
            extends: ["parent"],
            transforms: [transform],
          },
        },
      }),
    );

    expect(config.profiles.child.protectedPathRules).toEqual(
      protectedPathRules,
    );
  });

  it("empty transforms arrays are accepted as a no-op", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          unchanged: {
            description:
              "Unchanged profile testing an empty transform list no-op",
            extends: ["builtin:default"],
            transforms: [],
          },
        },
      }),
    );

    expect(
      decideBash("python scripts/build.py", config.profiles.unchanged),
    ).toBe("ask");
  });

  it("transform:deny-asks transforms inherited rules but preserves profile overrides to bash, path, and custom-tool rules", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          "worker-like": {
            description:
              "Worker profile preserving deliberate policy overrides after transforms",
            extends: ["builtin:default"],
            transforms: ["transform:deny-asks"],
            tools: {
              bash: [{ pattern: "custom *", decision: "ask" }],
              deploy: [{ decision: "ask" }],
            },
            readPaths: [{ pattern: "docs/**", decision: "ask" }],
            writePaths: [{ pattern: "docs/**", decision: "ask" }],
          },
        },
      }),
    );

    const policy = config.profiles["worker-like"];
    // The inherited default policy is transformed.
    expect(decideBash("python scripts/build.py", policy)).toBe("deny");

    // Rules declared by this profile are deliberate final overrides.
    expect(decideBash("custom build", policy)).toBe("ask");
    expect(
      policy.readPaths.find((rule) => rule.pattern === "docs/**")?.decision,
    ).toBe("ask");
    expect(
      policy.writePaths.find((rule) => rule.pattern === "docs/**")?.decision,
    ).toBe("ask");
    expect(policy.tools.deploy?.[0].decision).toBe("ask");
  });

  it("transform order is applied left-to-right", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          ordered: {
            description:
              "Ordered profile testing left-to-right transform evaluation",
            extends: ["builtin:default"],
            transforms: ["transform:allow-asks", "transform:deny-asks"],
          },
        },
      }),
    );

    expect(decideBash("python scripts/build.py", config.profiles.ordered)).toBe(
      "allow",
    );
  });

  it("unknown transform names fail loudly with a path to the bad entry", () => {
    expect(() =>
      loadProfileConfig(
        genericPolicyConfig,
        writeConfig({
          profiles: {
            invalid: {
              description:
                "Invalid profile testing unknown transform validation errors",
              extends: ["builtin:default"],
              transforms: ["transform:missing"],
            },
          },
        }),
      ),
    ).toThrowError(/\/profiles\/invalid\/transforms\/0/);
  });

  it("empty extends arrays fail validation", () => {
    expect(() =>
      loadProfileConfig(
        genericPolicyConfig,
        writeConfig({
          profiles: {
            invalid: {
              description:
                "Invalid profile testing empty extends validation errors",
              extends: [],
              readPaths: [{ pattern: "*", decision: "allow" }],
              writePaths: [{ pattern: "*", decision: "allow" }],
            },
          },
        }),
      ),
    ).toThrowError(/\/profiles\/invalid\/extends/);
  });

  it("load emits a warning when ordinary rules share a pattern with different decisions", () => {
    // Assumption: Phase 4 linting surfaces conflicts through console.warn (or an equivalent diagnostic channel).
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          "override-status": {
            description:
              "Override profile testing warnings for conflicting Bash rules",
            extends: ["builtin:default"],
            tools: {
              bash: [{ pattern: "git status", decision: "deny" }],
            },
          },
        },
      }),
    );

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
