import { describe, expect, it } from "vitest";
import { policyConfig } from "../policy";
import {
  assertPolicyConfig,
  extendProfile,
  type ProfilePolicy,
} from "../policy-helpers";

const baseProfile = {
  color: "blue",
  tools: {
    bash: [
      { pattern: "*", decision: "ask" },
      { pattern: "git *", decision: "deny" },
    ],
    read: [{ pattern: "*", decision: "allow" }],
  },
  bashPathReferences: [{ pattern: "*", decision: "allow" }],
} satisfies ProfilePolicy;

describe("policy configuration contract", () => {
  it("accepts the production policy", () => {
    expect(() => assertPolicyConfig(policyConfig)).not.toThrow();
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
