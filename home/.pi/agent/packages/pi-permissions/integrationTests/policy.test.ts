import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { policyConfig } from "../modules/policy";
import {
  assertPolicyConfig,
  extendProfile,
  withProtectedPathPatterns,
  type ProfilePolicy,
} from "../modules/policyHelpers";
import { evaluatePathByPattern } from "../modules/shell/pathPolicy";
import type {
  CustomToolRule,
  PolicyConfig,
  ProfilePolicyOverride,
  ToolPolicy,
} from "taylor-pi-permissions/config";

export type PublicConfigSurface = [
  CustomToolRule,
  ToolPolicy,
  ProfilePolicyOverride,
  PolicyConfig,
];

const startupCwd = "/workspace/project";

const baseProfile = {
  color: "blue",
  tools: {
    bash: [
      { pattern: "*", decision: "ask" },
      { pattern: "git *", decision: "deny" },
    ],
  },
  readPaths: [{ pattern: "*", decision: "allow" }],
  writePaths: [{ pattern: "*", decision: "allow" }],
} satisfies ProfilePolicy;

function evaluateReadProtectedPath(
  policy: ProfilePolicy,
  context: "read" | "grep" | "find" | "ls",
  requestedPath: string,
): ReturnType<typeof evaluatePathByPattern> {
  return evaluatePathByPattern(
    path.resolve(startupCwd, requestedPath),
    startupCwd,
    policy.readPaths,
    "allow",
    context,
    policy.protectedPathPatterns,
    policy.protectedPathExceptions,
  );
}

function evaluateWriteProtectedPath(
  policy: ProfilePolicy,
  context: "edit" | "write" | "bash",
  requestedPath: string,
): ReturnType<typeof evaluatePathByPattern> {
  return evaluatePathByPattern(
    path.resolve(startupCwd, requestedPath),
    startupCwd,
    policy.writePaths,
    "allow",
    context,
    policy.protectedPathPatterns,
    policy.protectedPathExceptions,
  );
}

describe("policy configuration contract", () => {
  it("accepts the production policy", () => {
    expect(() => assertPolicyConfig(policyConfig)).not.toThrow();
  });

  it("rejects empty custom matcher property names at runtime", () => {
    expect(() =>
      assertPolicyConfig({
        defaultProfile: "default",
        profiles: {
          default: {
            ...baseProfile,
            tools: {
              deploy: [{ decision: "deny", match: { "": "value" } }],
            },
          },
        },
      }),
    ).toThrowError(/match|property/);
  });

  it("rejects empty custom matcher property names in the generated schema", () => {
    type SchemaShape = {
      properties: {
        profiles: {
          patternProperties: Record<
            string,
            {
              properties: {
                tools: {
                  patternProperties: Record<
                    string,
                    {
                      items: {
                        properties: {
                          match?: {
                            patternProperties?: Record<
                              string,
                              { type: string }
                            >;
                          };
                        };
                      };
                    }
                  >;
                };
              };
            }
          >;
        };
      };
    };

    const parsed: unknown = JSON.parse(
      fs.readFileSync(
        new URL("../schemas/profiles.schema.json", import.meta.url),
        "utf8",
      ),
    );
    expect(parsed).toBeTruthy();

    const schema = parsed as SchemaShape;
    const profileSchema = schema.properties.profiles.patternProperties["^.*$"];
    if (!profileSchema) {
      throw new Error("missing profile schema fixture");
    }

    const customToolSchema =
      profileSchema.properties.tools.patternProperties[
        "^(?!(?:bash|read|grep|find|ls|edit|write)$).+$"
      ];
    if (!customToolSchema) {
      throw new Error("missing custom tool schema fixture");
    }
    expect(customToolSchema.items.properties.match?.patternProperties).toEqual({
      "^.+$": { type: "string" },
    });
  });

  it("keeps ordinary path decisions when protected exceptions are present", () => {
    const policy = withProtectedPathPatterns({
      ...baseProfile,
      readPaths: [
        ...baseProfile.readPaths,
        { pattern: "private/**", decision: "deny" },
        { pattern: "../**", decision: "ask" },
      ],
      writePaths: [
        ...baseProfile.writePaths,
        { pattern: "private/**", decision: "deny" },
        { pattern: "../**", decision: "ask" },
      ],
      protectedPathPatterns: ["**/.env*"],
      protectedPathExceptions: ["**/.env.template"],
    });

    for (const context of ["read", "grep", "find", "ls"] as const) {
      expect(
        evaluateReadProtectedPath(policy, context, "public/.env.template"),
      ).toMatchObject({ decision: "allow" });
      expect(
        evaluateReadProtectedPath(policy, context, "private/.env.template"),
      ).toMatchObject({
        decision: "deny",
        rule: { pattern: "private/**", decision: "deny" },
      });
      const protectedDecision = evaluateReadProtectedPath(
        policy,
        context,
        "private/.env",
      );
      expect(protectedDecision).toMatchObject({
        decision: "deny",
        rule: { pattern: "**/.env*", decision: "deny" },
      });
      expect(protectedDecision.rule?.guidance).toContain(
        "protected from disclosure and mutation",
      );
      expect(
        evaluateReadProtectedPath(policy, context, "../other/.env.template"),
      ).toMatchObject({ decision: "ask" });
      expect(
        evaluateReadProtectedPath(policy, context, "../other/.env"),
      ).toMatchObject({
        decision: "deny",
        rule: {
          pattern: "**/.env*",
          decision: "deny",
        },
      });
    }

    for (const context of ["edit", "write", "bash"] as const) {
      expect(
        evaluateWriteProtectedPath(policy, context, "public/.env.template"),
      ).toMatchObject({ decision: "allow" });
      expect(
        evaluateWriteProtectedPath(policy, context, "private/.env.template"),
      ).toMatchObject({
        decision: "deny",
        rule: { pattern: "private/**", decision: "deny" },
      });
      const protectedDecision = evaluateWriteProtectedPath(
        policy,
        context,
        "private/.env",
      );
      expect(protectedDecision).toMatchObject({
        decision: "deny",
        rule: { pattern: "**/.env*", decision: "deny" },
      });
      expect(protectedDecision.rule?.guidance).toContain(
        "protected from disclosure and mutation",
      );
      expect(
        evaluateWriteProtectedPath(policy, context, "../other/.env.template"),
      ).toMatchObject({ decision: "ask" });
      expect(
        evaluateWriteProtectedPath(policy, context, "../other/.env"),
      ).toMatchObject({
        decision: "deny",
        rule: {
          pattern: "**/.env*",
          decision: "deny",
        },
      });
    }
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
            readPaths: [{ pattern: "*", decision: "allow" }],
            writePaths: [{ pattern: "*", decision: "allow" }],
          },
        },
      }),
    ).toThrowError(/Invalid pi-permissions policy at .*decision/);
  });

  it("rejects legacy per-tool path rules", () => {
    expect(() =>
      assertPolicyConfig({
        defaultProfile: "default",
        profiles: {
          default: {
            ...baseProfile,
            tools: {
              ...baseProfile.tools,
              read: [{ pattern: "**", decision: "allow" }],
            },
          },
        },
      }),
    ).toThrowError(/tools/);
  });

  it("accepts only contexts that consume the corresponding path array", () => {
    expect(() =>
      assertPolicyConfig({
        defaultProfile: "default",
        profiles: {
          default: {
            ...baseProfile,
            readPaths: [
              {
                pattern: "**",
                decision: "allow",
                contexts: ["bash"],
              },
            ],
          },
        },
      }),
    ).toThrowError(/readPaths.*contexts/);
  });

  it("requires the default profile to exist", () => {
    expect(() =>
      assertPolicyConfig({
        defaultProfile: "missing",
        profiles: { default: baseProfile },
      }),
    ).toThrowError(/defaultProfile.*missing.*not configured/);
  });

  it("requires at least one read and write path rule", () => {
    expect(() =>
      assertPolicyConfig({
        defaultProfile: "default",
        profiles: {
          default: {
            tools: {},
            readPaths: [],
            writePaths: [],
          },
        },
      }),
    ).toThrowError(/readPaths/);
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

  it("preserves empty custom tool overrides so configured tools default to ask", () => {
    const extended = extendProfile(baseProfile, {
      tools: { deploy: [] },
    });

    expect(extended.tools.deploy).toEqual([]);
  });

  it("appends path overrides so custom profiles keep inherited boundaries", () => {
    const override = { pattern: "generated/**", decision: "deny" } as const;
    const extended = extendProfile(baseProfile, { readPaths: [override] });

    expect(extended.readPaths).toEqual([...baseProfile.readPaths, override]);
    expect(baseProfile.readPaths).toHaveLength(1);
  });

  it("can remove inherited bash rules while inheriting path rules", () => {
    const extended = extendProfile(baseProfile, {
      tools: { bash: [] },
    });

    expect(extended.tools.bash).toBeUndefined();
    expect(extended.readPaths).toEqual(baseProfile.readPaths);
    expect(extended.readPaths).not.toBe(baseProfile.readPaths);
    expect(extended.writePaths).toEqual(baseProfile.writePaths);
    expect(extended.writePaths).not.toBe(baseProfile.writePaths);
  });
});
