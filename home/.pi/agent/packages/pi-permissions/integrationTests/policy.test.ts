import { describe, expect, it } from "vitest";
import { policyConfig } from "../modules/policy";
import {
  assertPolicyConfig,
  extendProfile,
  withProtectedPathPatterns,
  type ProfilePolicy,
} from "../modules/policyHelpers";

const baseProfile = {
  color: "blue",
  tools: {
    bash: [
      { pattern: "*", decision: "ask" },
      { pattern: "git *", decision: "deny" },
    ],
    read: [{ pattern: "*", decision: "allow" }],
    edit: [{ pattern: "*", decision: "allow" }],
    write: [{ pattern: "*", decision: "allow" }],
  },
  bashPathReferences: [{ pattern: "*", decision: "allow" }],
} satisfies ProfilePolicy;

describe("policy configuration contract", () => {
  it("accepts the production policy", () => {
    expect(() => assertPolicyConfig(policyConfig)).not.toThrow();
  });

  it("applies profile protected path patterns to path tools and Bash", () => {
    const policy = withProtectedPathPatterns({
      ...baseProfile,
      protectedPathPatterns: ["**/.db"],
    });

    expect(policy.tools.read.at(-1)).toMatchObject({
      pattern: "**/.db",
      decision: "deny",
    });
    expect(policy.tools.edit.at(-1)).toMatchObject({
      pattern: "**/.db",
      decision: "deny",
    });
    expect(policy.tools.write.at(-1)).toMatchObject({
      pattern: "**/.db",
      decision: "deny",
    });
    expect(policy.bashPathReferences.at(-1)).toMatchObject({
      pattern: "**/.db",
      decision: "deny",
    });
  });

  it("does not let protected exceptions weaken ordinary profile denies", () => {
    const policy = withProtectedPathPatterns({
      ...baseProfile,
      tools: {
        ...baseProfile.tools,
        edit: [{ pattern: "*", decision: "deny" }],
      },
      protectedPathPatterns: ["**/.env*"],
      protectedPathExceptions: ["**/.env.template"],
    });

    expect(policy.tools.edit.at(-1)).toEqual({
      pattern: "**/.env.template",
      decision: "deny",
    });
  });

  it("reports the path of an invalid decision", () => {
    expect(() =>
      assertPolicyConfig({
        defaultProfile: "default",
        profiles: {
          default: {
            tools: {
              bash: [{ pattern: "*", decision: "sometimes" }],
            },
            bashPathReferences: [{ pattern: "*", decision: "allow" }],
          },
        },
      }),
    ).toThrowError(/Invalid pi-permissions policy at .*decision/);
  });

  it("requires the default profile to exist", () => {
    expect(() =>
      assertPolicyConfig({
        defaultProfile: "missing",
        profiles: { default: baseProfile },
      }),
    ).toThrowError(/defaultProfile.*missing.*not configured/);
  });

  it("requires at least one bash path rule", () => {
    expect(() =>
      assertPolicyConfig({
        defaultProfile: "default",
        profiles: {
          default: {
            tools: {},
            bashPathReferences: [],
          },
        },
      }),
    ).toThrowError(/bashPathReferences/);
  });
});

describe("profile composition", () => {
  it("appends override rules so they take precedence without mutating the base", () => {
    const extended = extendProfile(baseProfile, {
      color: "red",
      tools: {
        bash: [{ pattern: "git status", decision: "allow" }],
      },
    });

    expect(extended.color).toBe("red");
    expect(extended.tools.bash).toEqual([
      ...baseProfile.tools.bash,
      { pattern: "git status", decision: "allow" },
    ]);
    expect(baseProfile.tools.bash).toHaveLength(2);
  });

  it("can remove a tool while inheriting path rules", () => {
    const extended = extendProfile(baseProfile, {
      tools: { read: [] },
    });

    expect(extended.tools.read).toBeUndefined();
    expect(extended.bashPathReferences).toEqual(baseProfile.bashPathReferences);
    expect(extended.bashPathReferences).not.toBe(
      baseProfile.bashPathReferences,
    );
  });
});
