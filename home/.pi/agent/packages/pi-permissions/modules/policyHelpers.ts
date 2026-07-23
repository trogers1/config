import { Type } from "typebox";
import { Value } from "typebox/value";

export type Decision = "allow" | "ask" | "deny";

export type Rule = {
  pattern: string;
  decision: Decision;
  /** Instructions automatically returned to the model when this rule denies a call. */
  guidance?: string;
  /** Concrete alternatives automatically returned to the model when this rule denies a call. */
  alternatives?: string[];
};

export type ProfilePolicy = {
  promptFile?: string | null;
  color?: ProfileColor;
  emoji?: string;
  /** Directories that automatically select this profile, including descendants. */
  directories?: readonly string[];
  tools: Record<string, Rule[]>;
  /**
   * Gates path-looking tokens inside bash commands (reach: which parts of the
   * filesystem bash may touch). protectedPathPatterns marks sensitive paths
   * across every tool instead.
   */
  bashPathReferences: [Rule, ...Rule[]];
  /** Glob patterns protected from both disclosure and mutation. */
  protectedPathPatterns?: readonly string[];
  /** Narrow allow patterns applied after protectedPathPatterns. */
  protectedPathExceptions?: readonly string[];
  bashOutputRedirections?: [Rule, ...Rule[]];
};

export type PolicyConfig<Names extends string = string> = {
  defaultProfile: Names;
  profiles: Record<Names, ProfilePolicy>;
};

export type ProfileColor =
  "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white";

const decisionSchema = Type.Union([
  Type.Literal("allow"),
  Type.Literal("ask"),
  Type.Literal("deny"),
]);

const ruleSchema = Type.Object(
  {
    pattern: Type.String(),
    decision: decisionSchema,
    guidance: Type.Optional(Type.String()),
    alternatives: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

const profileSchema = Type.Object(
  {
    promptFile: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    color: Type.Optional(
      Type.Union([
        Type.Literal("black"),
        Type.Literal("red"),
        Type.Literal("green"),
        Type.Literal("yellow"),
        Type.Literal("blue"),
        Type.Literal("magenta"),
        Type.Literal("cyan"),
        Type.Literal("white"),
      ]),
    ),
    emoji: Type.Optional(Type.String()),
    directories: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    tools: Type.Record(Type.String(), Type.Array(ruleSchema)),
    bashPathReferences: Type.Array(ruleSchema, { minItems: 1 }),
    protectedPathPatterns: Type.Optional(Type.Array(Type.String())),
    protectedPathExceptions: Type.Optional(Type.Array(Type.String())),
    bashOutputRedirections: Type.Optional(
      Type.Array(ruleSchema, { minItems: 1 }),
    ),
  },
  { additionalProperties: false },
);

const policyConfigSchema = Type.Object(
  {
    defaultProfile: Type.String(),
    profiles: Type.Record(Type.String(), profileSchema),
  },
  { additionalProperties: false },
);

const profileConfigProfileSchema = Type.Object(
  {
    extends: Type.Optional(Type.String()),
    promptFile: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    color: Type.Optional(
      Type.Union([
        Type.Literal("black"),
        Type.Literal("red"),
        Type.Literal("green"),
        Type.Literal("yellow"),
        Type.Literal("blue"),
        Type.Literal("magenta"),
        Type.Literal("cyan"),
        Type.Literal("white"),
      ]),
    ),
    emoji: Type.Optional(Type.String()),
    directories: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    tools: Type.Optional(Type.Record(Type.String(), Type.Array(ruleSchema))),
    bashPathReferences: Type.Optional(Type.Array(ruleSchema, { minItems: 1 })),
    protectedPathPatterns: Type.Optional(Type.Array(Type.String())),
    protectedPathExceptions: Type.Optional(Type.Array(Type.String())),
    bashOutputRedirections: Type.Optional(
      Type.Array(ruleSchema, { minItems: 1 }),
    ),
  },
  { additionalProperties: false },
);

/** JSON Schema source of truth for ~/.pi/agent/permissions/profiles.jsonc. */
export const profileConfigFileSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    defaultProfile: Type.Optional(Type.String()),
    profiles: Type.Record(Type.String(), profileConfigProfileSchema),
  },
  {
    $id: "https://earendil.works/pi-permissions/profiles.schema.json",
    title: "pi-permissions profile configuration",
    additionalProperties: false,
  },
);

export function assertPolicyConfig(
  config: unknown,
): asserts config is PolicyConfig {
  const validationError = Value.Errors(policyConfigSchema, config)[0];
  if (validationError) {
    throw new Error(
      `Invalid pi-permissions policy at ${validationError.instancePath || "/"}: ${validationError.message}`,
    );
  }

  const { defaultProfile, profiles } = config as PolicyConfig;
  if (!(defaultProfile in profiles)) {
    throw new Error(
      `Invalid pi-permissions policy at /defaultProfile: profile '${defaultProfile}' is not configured`,
    );
  }
}

export function definePolicyConfig<
  Profiles extends Record<string, ProfilePolicy>,
>(config: {
  defaultProfile: keyof Profiles & string;
  profiles: Profiles;
}): PolicyConfig<keyof Profiles & string> {
  return config;
}

export function withProtectedPathPatterns(
  policy: ProfilePolicy,
): ProfilePolicy {
  if (
    !policy.protectedPathPatterns ||
    policy.protectedPathPatterns.length === 0
  )
    return policy;

  const denyRules: Rule[] = policy.protectedPathPatterns.map((pattern) => ({
    pattern,
    decision: "deny",
    guidance:
      "This path is protected from disclosure and mutation by the active profile.",
    alternatives: [
      "Use an explicitly approved file instead",
      "Ask the user for a redacted or safe-to-share value",
    ],
  }));
  const tools = structuredClone(policy.tools);
  // Discovery can disclose sensitive names, while edit/write can damage secret
  // material. Keep every path surface aligned with Bash path references.
  for (const tool of ["read", "grep", "find", "ls", "edit", "write"]) {
    const baseRules = tools[tool];
    if (baseRules)
      tools[tool] = [
        ...baseRules,
        ...denyRules,
        ...protectedExceptionRules(policy, baseRules),
      ];
  }

  return {
    ...policy,
    tools,
    bashPathReferences: [
      ...policy.bashPathReferences,
      ...denyRules,
      ...protectedExceptionRules(policy, policy.bashPathReferences),
    ],
  };
}

function protectedExceptionRules(
  policy: ProfilePolicy,
  baseRules: Rule[],
): Rule[] {
  // An exception removes only the generated protection. It must not weaken the
  // profile's ordinary boundary (for example, read-only edit remains denied).
  let fallbackDecision: Decision = "deny";
  for (let index = baseRules.length - 1; index >= 0; index--) {
    const rule = baseRules[index];
    if (rule.pattern === "*") {
      fallbackDecision = rule.decision;
      break;
    }
  }
  return (policy.protectedPathExceptions ?? []).map((pattern) => ({
    pattern,
    decision: fallbackDecision,
  }));
}

export function extendProfile(
  base: ProfilePolicy,
  override: Partial<Omit<ProfilePolicy, "tools">> & {
    tools?: Record<string, Rule[]>;
  },
): ProfilePolicy {
  const mergedTools: Record<string, Rule[]> = structuredClone(base.tools);

  // Append override rules (later rules win by position).
  for (const [tool, rules] of Object.entries(override.tools ?? {})) {
    if (!rules) continue;
    if (rules.length === 0) {
      delete mergedTools[tool];
    } else {
      mergedTools[tool] = [...(mergedTools[tool] ?? []), ...rules];
    }
  }

  return {
    ...base,
    ...override,
    tools: mergedTools,
    bashPathReferences: override.bashPathReferences ?? [
      ...base.bashPathReferences,
    ],
  };
}
