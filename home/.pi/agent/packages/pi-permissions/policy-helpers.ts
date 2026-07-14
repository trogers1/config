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
  tools: Record<string, Rule[]>;
  bashPathReferences: [Rule, ...Rule[]];
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
    tools: Type.Record(Type.String(), Type.Array(ruleSchema)),
    bashPathReferences: Type.Array(ruleSchema, { minItems: 1 }),
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
