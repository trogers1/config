/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unnecessary-type-assertion */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { policyConfig as genericPolicyConfig } from "../modules/policy";
import { assertPolicyConfig, extendProfile } from "../modules/policyHelpers";
import { loadProfileConfig } from "../modules/profileConfig";
import * as pathPolicy from "../modules/shell/pathPolicy";

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

const minimalPaths = {
  readPaths: [{ pattern: "*", decision: "allow" }],
  writePaths: [{ pattern: "*", decision: "allow" }],
};

describe("protected-path rules", () => {
  it.fails(
    "schema accepts protectedPathRules with allow and deny decisions",
    () => {
      const policy = {
        ...minimalPaths,
        protectedPathRules: [{ pattern: "**/.env*", decision: "deny" }],
      } as unknown as any;

      expect(() =>
        assertPolicyConfig({
          defaultProfile: "p",
          profiles: { p: policy },
        }),
      ).not.toThrow();
    },
  );

  it.fails("schema rejects ask decisions in protectedPathRules", () => {
    const policy = {
      ...minimalPaths,
      protectedPathRules: [{ pattern: "**/.env*", decision: "ask" }],
    } as unknown as any;

    expect(() =>
      assertPolicyConfig({
        defaultProfile: "p",
        profiles: { p: policy },
      }),
    ).toThrow(/protected/);
  });

  it.fails(
    "protected rules concatenate under extends like every other rule array",
    () => {
      const base = {
        ...minimalPaths,
        protectedPathRules: [{ pattern: "**/.env*", decision: "deny" }],
      } as unknown as any;
      const child = extendProfile(
        base as any,
        {
          protectedPathRules: [{ pattern: "**/.git/**", decision: "deny" }],
        } as any,
      ) as any;

      expect(child.protectedPathRules).toHaveLength(2);
    },
  );

  it.fails(
    "a more-specific authored allow weakens an inherited protected deny",
    () => {
      const base = {
        ...minimalPaths,
        protectedPathRules: [{ pattern: "**/.env*", decision: "deny" }],
      } as unknown as any;
      const child = extendProfile(
        base as any,
        {
          protectedPathRules: [{ pattern: ".env.template", decision: "allow" }],
        } as any,
      ) as any;

      expect(
        // @ts-expect-error future protected-path resolution API
        pathPolicy.evaluateProtectedPath(".env.template", child).decision,
      ).toBe("allow");
    },
  );

  it.fails(
    "exact-pattern protected conflicts across layers are load errors",
    () => {
      expect(() =>
        loadProfileConfig(
          genericPolicyConfig,
          writeConfig({
            profiles: {
              conflict: {
                extends: ["builtin:default"],
                protectedPathRules: [
                  { pattern: "**/.env*", decision: "allow" },
                ],
              },
            },
          }),
        ),
      ).toThrow(/protected/);
    },
  );

  it.fails("former protectedPathExceptions become ordinary allow rules", () => {
    const policy = genericPolicyConfig.profiles["builtin:default"] as any;

    expect(policy.protectedPathRules).toEqual(
      expect.arrayContaining([
        { pattern: "**/.env.template", decision: "allow" },
      ]),
    );
  });
});
