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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permissions-"));
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

    expect(config.profiles.child.sandbox).toEqual({
      network: "deny",
      extraWritePaths: ["/tmp"],
    });
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

  it("replaces sandbox configuration instead of deep-merging it", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig({
        profiles: {
          base: {
            description:
              "Base profile for sandbox replacement and deny-read metadata",
            extends: ["builtin:default"],
            sandbox: {
              network: "deny",
              extraWritePaths: ["/tmp"],
              extraDenyReadPaths: ["~/.ssh"],
            },
          },
          child: {
            description:
              "Child profile replacing inherited sandbox configuration",
            extends: ["base"],
            sandbox: {
              network: "allow",
            },
          },
        },
      }),
    );

    expect(config.profiles.child.sandbox).toEqual({ network: "allow" });
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

    expect(config.profiles.base.sandbox).toEqual({
      network: "allow",
      extraDenyReadPaths: ["~/.aws"],
    });
  });
});
