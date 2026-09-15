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

function writeConfig(contents: unknown): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-"));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "profiles.jsonc");
  fs.writeFileSync(configPath, JSON.stringify(contents));
  return configPath;
}

describe("sandbox profile composition", () => {
  it("inherits sandbox configuration through profile extension", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          base: {
            description:
              "Base profile for inherited denied-network sandbox configuration",
            extends: ["builtin:default"],
            sandbox: {
              network: "deny",
              extraWritePaths: ["/tmp"],
            },
          },
          child: {
            description:
              "Child profile inheriting sandbox configuration from its base",
            extends: ["base"],
          },
        },
      }),
    );

    expect(config.profiles.child.sandbox).toEqual(
      expect.objectContaining({
        network: "deny",
        extraWritePaths: ["/tmp"],
      }),
    );
  });

  it("allows a child profile to disable an inherited sandbox explicitly", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          base: {
            description:
              "Base profile for inherited allowed-network sandbox configuration",
            extends: ["builtin:default"],
            sandbox: {
              network: "allow",
              extraWritePaths: ["/tmp"],
            },
          },
          child: {
            description:
              "Child profile explicitly disabling inherited sandbox protection",
            extends: ["base"],
            sandbox: false,
          },
        },
      }),
    );

    expect(config.profiles.child.sandbox).toBe(false);
  });

  it("composes sandbox configuration through profile extension", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          base: {
            description:
              "Base profile for composed sandbox and deny-read metadata",
            extends: ["builtin:default"],
            sandbox: {
              network: "deny",
              extraWritePaths: ["/tmp"],
              extraDenyReadPaths: ["~/.ssh"],
              allowAppleEvents: true,
            },
          },
          child: {
            description:
              "Child profile composing inherited sandbox configuration",
            extends: ["base"],
            sandbox: {
              network: "allow",
              enableWeakerNetworkIsolation: true,
            },
          },
        },
      }),
    );

    expect(config.profiles.child.sandbox).toEqual(
      expect.objectContaining({
        network: "allow",
        extraWritePaths: ["/tmp"],
        extraDenyReadPaths: ["~/.ssh"],
        allowAppleEvents: true,
        enableWeakerNetworkIsolation: true,
      }),
    );
  });

  it("composes sandbox path arrays and permits partial sandbox overrides", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          base: {
            description: "Base profile with a sandbox path exception",
            extends: ["builtin:default"],
            sandbox: {
              network: "deny",
              extraWritePaths: ["/tmp"],
            },
          },
          child: {
            description: "Child profile adding a sandbox path exception",
            extends: ["base"],
            sandbox: {
              extraWritePaths: ["/var/tmp"],
            },
          },
        },
      }),
    );

    expect(config.profiles.child.sandbox).toEqual(
      expect.objectContaining({
        network: "deny",
        extraWritePaths: ["/tmp", "/var/tmp"],
      }),
    );
  });

  it.each([
    "extraWritePaths",
    "extraDenyReadPaths",
    "extraDenyWritePaths",
    "kernelUnenforcedProtectedPaths",
  ] as const)(
    "composes append and both overwrite forms for %s",
    (arrayName) => {
      const basePath =
        arrayName === "kernelUnenforcedProtectedPaths"
          ? "**/.base/**"
          : `/base/${arrayName}`;
      const localPath =
        arrayName === "kernelUnenforcedProtectedPaths"
          ? "**/.local/**"
          : `/local/${arrayName}`;
      const config = loadProfileConfig(
        genericPolicyConfig,
        writeConfig({
          profiles: {
            base: {
              description: "Base sandbox array fixture",
              extends: ["builtin:default"],
              sandbox: { network: "deny", [arrayName]: [basePath] },
              protectedPathRules: [
                { pattern: basePath, decision: "deny" },
                { pattern: localPath, decision: "deny" },
              ],
            },
            appended: {
              description: "Append fixture",
              extends: ["base"],
              sandbox: { [arrayName]: [localPath] },
            },
            overwritten: {
              description: "Non-empty overwrite fixture",
              extends: ["base"],
              sandbox: {
                overwritePathArrays: [arrayName],
                [arrayName]: [localPath],
              },
            },
            cleared: {
              description: "Empty overwrite fixture",
              extends: ["base"],
              sandbox: { overwritePathArrays: [arrayName] },
            },
          },
        }),
      );
      const appended = config.profiles.appended.sandbox;
      const overwritten = config.profiles.overwritten.sandbox;
      const cleared = config.profiles.cleared.sandbox;
      if (!appended || !overwritten || !cleared)
        throw new Error("Expected enabled sandbox declarations");
      expect(appended[arrayName]).toEqual(
        expect.arrayContaining([basePath, localPath]),
      );
      expect(overwritten[arrayName]).toEqual([localPath]);
      expect(cleared[arrayName]).toEqual([]);
    },
  );

  it("allows a child to overwrite inherited sandbox path arrays", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          base: {
            description: "Base profile with broad sandbox capabilities",
            extends: ["builtin:default"],
            sandbox: {
              network: "allow",
              extraWritePaths: ["/tmp"],
              kernelUnenforcedProtectedPaths: ["**/.git/**"],
            },
          },
          child: {
            description: "Child profile narrowing sandbox capabilities",
            extends: ["base"],
            sandbox: {
              overwritePathArrays: [
                "extraWritePaths",
                "kernelUnenforcedProtectedPaths",
              ],
              extraWritePaths: ["/var/tmp"],
            },
          },
        },
      }),
    );

    expect(config.profiles.child.sandbox).toEqual(
      expect.objectContaining({
        extraWritePaths: ["/var/tmp"],
        kernelUnenforcedProtectedPaths: [],
      }),
    );
  });

  it("rejects unknown keys in a partial child sandbox", () => {
    expect(() =>
      loadProfileConfig(
        genericPolicyConfig,
        writeConfig({
          profiles: {
            base: {
              description: "Base profile with an enabled sandbox",
              extends: ["builtin:default"],
              sandbox: { network: "deny" },
            },
            child: {
              description: "Child profile with an invalid sandbox override",
              extends: ["base"],
              sandbox: { allowAppleEventz: true },
            },
          },
        }),
      ),
    ).toThrow(/sandbox/);
  });

  it("leaves sandbox metadata unchanged when transforms rewrite other rules", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          base: {
            description:
              "Base profile preserving sandbox metadata through rule transforms",
            extends: ["builtin:default"],
            transforms: ["transform:deny-asks"],
            sandbox: {
              network: "allow",
              extraDenyReadPaths: ["~/.aws"],
            },
          },
        },
      }),
    );

    expect(config.profiles.base.sandbox).toEqual(
      expect.objectContaining({
        network: "allow",
        extraDenyReadPaths: ["~/.aws"],
      }),
    );
  });
});
