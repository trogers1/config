import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { policyConfig as genericPolicyConfig } from "../modules/policy";
import { defaultProtectedPathRules } from "../modules/protectedPaths";
import {
  assertPolicyConfig,
  definePolicyConfig,
  extendProfile,
  type ProfilePolicy,
  type ProfilePolicyOverride,
} from "../modules/policyHelpers";
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
  tools: {},
  readPaths: [{ pattern: "*", decision: "allow" }],
  writePaths: [{ pattern: "*", decision: "allow" }],
} satisfies Pick<ProfilePolicy, "tools" | "readPaths" | "writePaths">;

describe("protected-path rules", () => {
  it("schema accepts protectedPathRules with allow and deny decisions", () => {
    const policy = {
      ...minimalPaths,
      protectedPathRules: [{ pattern: "**/.env*", decision: "deny" }],
    } satisfies ProfilePolicy;

    expect(() =>
      assertPolicyConfig({
        defaultProfile: "p",
        profiles: { p: policy },
      }),
    ).not.toThrow();
  });

  it("schema rejects ask decisions in protectedPathRules", () => {
    // Keep this malformed value untyped: asserting it validates the runtime
    // schema boundary, which must reject values that static TypeScript users
    // could not construct as ProfilePolicy.
    const policy = {
      ...minimalPaths,
      protectedPathRules: [{ pattern: "**/.env*", decision: "ask" }],
    };

    expect(() =>
      assertPolicyConfig({
        defaultProfile: "p",
        profiles: { p: policy },
      }),
    ).toThrow(/protected/);
  });

  it("protected rules concatenate under extends like every other rule array", () => {
    const base = {
      ...minimalPaths,
      protectedPathRules: [{ pattern: "**/.env*", decision: "deny" }],
    } satisfies ProfilePolicy;
    const child = extendProfile(base, {
      protectedPathRules: [{ pattern: "**/.git/**", decision: "deny" }],
    } satisfies ProfilePolicyOverride);

    expect(child.protectedPathRules).toHaveLength(2);
  });

  it("a more-specific authored allow weakens an inherited protected deny", () => {
    const base = {
      ...minimalPaths,
      protectedPathRules: [{ pattern: "**/.env*", decision: "deny" }],
    } satisfies ProfilePolicy;
    const child = extendProfile(base, {
      protectedPathRules: [{ pattern: ".env.template", decision: "allow" }],
    } satisfies ProfilePolicyOverride);

    expect(
      pathPolicy.evaluateProtectedPath(".env.template", child).decision,
    ).toBe("allow");
  });

  it("exact-pattern protected conflicts across layers are load errors", () => {
    expect(() =>
      loadProfileConfig(
        genericPolicyConfig,
        writeConfig({
          profiles: {
            conflict: {
              extends: ["builtin:default"],
              protectedPathRules: [{ pattern: "**/.env*", decision: "allow" }],
            },
          },
        }),
      ),
    ).toThrow(/Protected/);
  });

  it("rejects directly defined protected-rule conflicts during config assertion", () => {
    const conflictedProfile = {
      ...minimalPaths,
      protectedPathRules: [
        { pattern: "**/.env*", decision: "deny" },
        { pattern: "**/.env*", decision: "allow" },
      ],
    } satisfies ProfilePolicy;

    expect(() =>
      assertPolicyConfig({
        defaultProfile: "p",
        profiles: { p: conflictedProfile },
      }),
    ).toThrow(/Protected/);

    expect(() =>
      definePolicyConfig({
        defaultProfile: "p",
        profiles: { p: conflictedProfile },
      }),
    ).toThrow(/Protected/);
  });

  it.each([
    ".aws/credentials",
    ".azure/accessTokens.json",
    ".config/gcloud/application_default_credentials.json",
    ".config/gh/hosts.yml",
    ".config/glab-cli/config.yml",
    ".oci/config",
    ".docker/config.json",
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".git-credentials",
    ".ssh/id_ed25519",
    ".gnupg/private-keys-v1.d/key",
    ".kube/config",
    ".vault-token",
    ".password-store/email.gpg",
    ".config/sops/age/keys.txt",
    ".age/keys.txt",
    "terraform.tfvars",
    "terraform.tfstate",
    "terraform.tfstate.backup",
    ".pulumi/credentials.json",
    "tls.key",
    "keystore.p12",
    "keystore.pfx",
    "keystore.jks",
    "app.keystore",
  ])(
    "denies common credential, key, and infrastructure-state path %s",
    (requestedPath) => {
      expect(
        pathPolicy.evaluateProtectedPath(requestedPath, {
          protectedPathRules: defaultProtectedPathRules,
        }).decision,
      ).toBe("deny");
    },
  );

  it.each([
    ".env.template",
    ".env.example",
    ".env.sample",
    "fixtures/.env.example",
  ])(
    "allows conventional dotenv template, example, and sample file %s",
    (requestedPath) => {
      expect(
        pathPolicy.evaluateProtectedPath(requestedPath, {
          protectedPathRules: defaultProtectedPathRules,
        }).decision,
      ).toBe("allow");
    },
  );

  it("former protectedPathExceptions become ordinary allow rules", () => {
    const policy = genericPolicyConfig.profiles["builtin:default"];

    expect(policy.protectedPathRules).toEqual(
      expect.arrayContaining([
        { pattern: "**/.env.template", decision: "allow" },
        { pattern: "**/.env.example", decision: "allow" },
        { pattern: "**/.env.sample", decision: "allow" },
      ]),
    );
  });
});
