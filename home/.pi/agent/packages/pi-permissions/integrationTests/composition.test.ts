import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decideBash } from "../extensions/permissions";
import { policyConfig as genericPolicyConfig } from "../modules/policy";
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

describe("profile composition", () => {
  it.fails(
    "multi-extends folds left-to-right so the rightmost parent wins on conflicts",
    () => {
      const config = loadProfileConfig(
        genericPolicyConfig,
        writeConfig({
          profiles: {
            left: {
              ...minimalPaths,
              tools: { bash: [{ pattern: "demo", decision: "allow" }] },
            },
            right: {
              ...minimalPaths,
              tools: { bash: [{ pattern: "demo", decision: "deny" }] },
            },
            composed: {
              extends: ["left", "right"],
              ...minimalPaths,
            },
          },
        }),
      );

      expect(decideBash("demo", config.profiles.composed)).toBe("deny");
    },
  );

  it.fails(
    "fold-is-concatenation: extending read-only then default re-opens bash to ask",
    () => {
      const config = loadProfileConfig(
        genericPolicyConfig,
        writeConfig({
          profiles: {
            reopened: {
              extends: ["builtin:read-only", "builtin:default"],
            },
          },
        }),
      );

      expect(
        decideBash("python scripts/build.py", config.profiles.reopened),
      ).toBe("ask");
    },
  );

  it.fails("transform:deny-asks converts every ask to deny", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          "worker-like": {
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

  it.fails("transform:allow-asks converts every ask to allow", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          "auto-approve": {
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

  it.fails("transform:ask-all converts every allow to ask", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          paranoid: {
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

  it.fails(
    "load emits a warning when ordinary rules share a pattern with different decisions",
    () => {
      // Assumption: Phase 4 linting surfaces conflicts through console.warn (or an equivalent diagnostic channel).
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      loadProfileConfig(
        genericPolicyConfig,
        writeConfig({
          profiles: {
            "override-status": {
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
    },
  );
});
