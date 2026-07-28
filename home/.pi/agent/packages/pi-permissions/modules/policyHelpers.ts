import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

export const builtinProfilePrefix = "builtin:";

export function isBuiltinProfileName(name: string): boolean {
  return name.startsWith(builtinProfilePrefix);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const customProfileNamePattern = `^(?!${escapeRegExp(builtinProfilePrefix)}).+$`;

export const builtinProfileNames = [
  "builtin:default",
  "builtin:worker",
  "builtin:read-only",
  "builtin:tests-disallowed",
  "builtin:tests-only",
] as const;
export type BuiltinProfileName = (typeof builtinProfileNames)[number];

const readPathContextSchema = Type.Union([
  Type.Literal("read"),
  Type.Literal("grep"),
  Type.Literal("find"),
  Type.Literal("ls"),
]);
const writePathContextSchema = Type.Union([
  Type.Literal("edit"),
  Type.Literal("write"),
  Type.Literal("bash"),
]);
const decisionSchema = Type.Union([
  Type.Literal("allow"),
  Type.Literal("ask"),
  Type.Literal("deny"),
]);
const profileColorSchema = Type.Union([
  Type.Literal("black"),
  Type.Literal("red"),
  Type.Literal("green"),
  Type.Literal("yellow"),
  Type.Literal("blue"),
  Type.Literal("magenta"),
  Type.Literal("cyan"),
  Type.Literal("white"),
]);

const decisionRuleProperties = {
  decision: decisionSchema,
  guidance: Type.Optional(Type.String()),
  alternatives: Type.Optional(Type.Array(Type.String())),
};

const ruleSchema = Type.Object(
  {
    pattern: Type.String(),
    ...decisionRuleProperties,
  },
  { additionalProperties: false },
);

const customToolMatchSchema = Type.Unsafe<Record<string, string>>({
  type: "object",
  patternProperties: {
    "^.+$": { type: "string" },
  },
  additionalProperties: false,
  minProperties: 1,
});

const customToolRuleSchema = Type.Object(
  {
    ...decisionRuleProperties,
    match: Type.Optional(customToolMatchSchema),
  },
  { additionalProperties: false },
);

type ToolPolicies = {
  bash?: Static<typeof ruleSchema>[];
  [toolName: string]:
    | Static<typeof ruleSchema>[]
    | Static<typeof customToolRuleSchema>[]
    | undefined;
};

const toolsSchema = Type.Unsafe<ToolPolicies>({
  type: "object",
  properties: {
    bash: { type: "array", items: ruleSchema },
  },
  patternProperties: {
    "^(?!(?:bash|read|grep|find|ls|edit|write)$).+$": {
      type: "array",
      items: customToolRuleSchema,
    },
  },
  additionalProperties: false,
});

const pathRuleSchema = <ContextSchema extends TSchema>(
  contextSchema: ContextSchema,
) =>
  Type.Object(
    {
      pattern: Type.String(),
      ...decisionRuleProperties,
      contexts: Type.Optional(
        Type.Array(contextSchema, { minItems: 1, uniqueItems: true }),
      ),
    },
    { additionalProperties: false },
  );

const readPathRuleSchema = pathRuleSchema(readPathContextSchema);
const writePathRuleSchema = pathRuleSchema(writePathContextSchema);

const profileProperties = {
  promptFile: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  color: Type.Optional(profileColorSchema),
  emoji: Type.Optional(Type.String()),
  directories: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  // Command and custom-tool policy remain separate from path policy.
  // Dedicated path tools are governed exclusively by readPaths/writePaths.
  tools: toolsSchema,
  readPaths: Type.Array(readPathRuleSchema, { minItems: 1 }),
  writePaths: Type.Array(writePathRuleSchema, { minItems: 1 }),
  protectedPathPatterns: Type.Optional(Type.Array(Type.String())),
  protectedPathExceptions: Type.Optional(Type.Array(Type.String())),
};

const profileSchema = Type.Object(profileProperties, {
  additionalProperties: false,
});

const policyConfigSchema = Type.Object(
  {
    defaultProfile: Type.String(),
    profiles: Type.Record(Type.String(), profileSchema),
  },
  { additionalProperties: false },
);

const profileConfigProfileSchema = Type.Object(
  {
    ...profileProperties,
    extends: Type.Optional(Type.String()),
    tools: Type.Optional(profileProperties.tools),
    readPaths: Type.Optional(profileProperties.readPaths),
    writePaths: Type.Optional(profileProperties.writePaths),
  },
  { additionalProperties: false },
);

export type Decision = Static<typeof decisionSchema>;
export type Rule = Static<typeof ruleSchema>;
export type CustomToolRule = Static<typeof customToolRuleSchema>;
export type ToolPolicy = Static<typeof toolsSchema>;
export type ReadPathContext = Static<typeof readPathContextSchema>;
export type WritePathContext = Static<typeof writePathContextSchema>;
export type PathContext = ReadPathContext | WritePathContext;
export const readPathContexts: readonly ReadPathContext[] =
  readPathContextSchema.anyOf.map((schema) => schema.const);
export const writePathContexts: readonly WritePathContext[] =
  writePathContextSchema.anyOf.map((schema) => schema.const);
export type ReadPathRule = Static<typeof readPathRuleSchema>;
export type WritePathRule = Static<typeof writePathRuleSchema>;
export type PathRule = ReadPathRule | WritePathRule;
export type ProfileColor = Static<typeof profileColorSchema>;
export type ProfilePolicy = Static<typeof profileSchema>;
type PolicyConfigShape = Static<typeof policyConfigSchema>;
export type PolicyConfig<Names extends string = string> = Omit<
  PolicyConfigShape,
  "defaultProfile" | "profiles"
> & {
  defaultProfile: Names;
  profiles: Record<Names, ProfilePolicy>;
};
export type ProfileConfigProfile = Static<typeof profileConfigProfileSchema>;
export type ProfilePolicyOverride = Omit<ProfileConfigProfile, "extends">;

/** JSON Schema source of truth for ~/.pi/agent/permissions/profiles.jsonc. */
export const profileConfigFileSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    defaultProfile: Type.Optional(Type.String()),
    profiles: Type.Unsafe<Record<string, ProfileConfigProfile>>({
      type: "object",
      patternProperties: {
        [customProfileNamePattern]: profileConfigProfileSchema,
      },
      additionalProperties: false,
    }),
  },
  {
    $id: "https://earendil.works/pi-permissions/profiles.schema.json",
    title: "pi-permissions profile configuration",
    additionalProperties: false,
  },
);
export type ProfileConfigFile = Static<typeof profileConfigFileSchema>;

export function assertProfilePolicy(
  policy: unknown,
): asserts policy is ProfilePolicy {
  const validationError = Value.Errors(profileSchema, policy)[0];
  if (validationError) {
    throw new Error(
      `Invalid pi-permissions profile at ${validationError.instancePath || "/"}: ${validationError.message}`,
    );
  }
}

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
  assertPolicyConfig(config);
  return config;
}

export function withProtectedPathPatterns(
  policy: ProfilePolicy,
): ProfilePolicy {
  // Protected-path semantics are now layered at evaluation time so the
  // ordinary ordered decision remains intact.
  return policy;
}

export function extendProfile(
  base: ProfilePolicy,
  override: ProfilePolicyOverride,
): ProfilePolicy {
  const mergedTools: ProfilePolicy["tools"] = structuredClone(base.tools);

  // Append override rules; later rules win only when specificity ties.
  for (const [toolName, overrideRules] of Object.entries(
    override.tools ?? {},
  )) {
    if (!overrideRules) continue;
    if (overrideRules.length === 0) {
      if (toolName === "bash") {
        delete mergedTools[toolName];
      } else {
        mergedTools[toolName] = [];
      }
      continue;
    }
    if (toolName === "bash") {
      const inheritedRules = mergedTools.bash ?? [];
      const bashRules = overrideRules as Rule[];
      warnOnRuleConflicts("bash", inheritedRules, bashRules);
      mergedTools.bash = [...inheritedRules, ...bashRules];
      continue;
    }
    const inheritedRules = (mergedTools[toolName] ?? []) as CustomToolRule[];
    const customRules = overrideRules as CustomToolRule[];
    warnOnCustomToolRuleConflicts(toolName, inheritedRules, customRules);
    mergedTools[toolName] = [...inheritedRules, ...customRules];
  }

  warnOnPathRuleConflicts("readPaths", base.readPaths, override.readPaths);
  warnOnPathRuleConflicts("writePaths", base.writePaths, override.writePaths);

  return {
    ...base,
    ...override,
    tools: mergedTools,
    readPaths: [...base.readPaths, ...(override.readPaths ?? [])],
    writePaths: [...base.writePaths, ...(override.writePaths ?? [])],
  };
}

function warnOnRuleConflicts(
  toolName: string,
  inheritedRules: readonly Rule[],
  overrideRules: readonly Rule[],
): void {
  for (const inheritedRule of inheritedRules) {
    for (const overrideRule of overrideRules) {
      if (
        inheritedRule.pattern !== overrideRule.pattern ||
        inheritedRule.decision === overrideRule.decision
      ) {
        continue;
      }
      console.warn(
        `Conflicting ${toolName} rule pattern '${inheritedRule.pattern}' changes from '${inheritedRule.decision}' to '${overrideRule.decision}' across profile composition.`,
      );
    }
  }
}

type CustomToolRuleLike = {
  decision: Decision;
  match?: Record<string, string>;
};

function warnOnCustomToolRuleConflicts(
  toolName: string,
  inheritedRules: readonly CustomToolRuleLike[],
  overrideRules: readonly CustomToolRuleLike[],
): void {
  for (const inheritedRule of inheritedRules) {
    for (const overrideRule of overrideRules) {
      if (
        customToolRuleKey(inheritedRule) !== customToolRuleKey(overrideRule)
      ) {
        continue;
      }
      if (inheritedRule.decision === overrideRule.decision) continue;
      console.warn(
        `Conflicting custom tool rule for '${toolName}' and match ${customToolRuleKey(overrideRule)} changes from '${inheritedRule.decision}' to '${overrideRule.decision}' across profile composition.`,
      );
    }
  }
}

function warnOnPathRuleConflicts(
  kind: "readPaths" | "writePaths",
  inheritedRules: readonly PathRule[],
  overrideRules: readonly PathRule[] | undefined,
): void {
  if (!overrideRules) return;

  for (const inheritedRule of inheritedRules) {
    for (const overrideRule of overrideRules) {
      if (
        inheritedRule.pattern !== overrideRule.pattern ||
        !pathRuleContextsOverlap(
          inheritedRule.contexts,
          overrideRule.contexts,
        ) ||
        inheritedRule.decision === overrideRule.decision
      ) {
        continue;
      }
      console.warn(
        `Conflicting ${kind} rule pattern '${inheritedRule.pattern}' changes from '${inheritedRule.decision}' to '${overrideRule.decision}' across profile composition.`,
      );
    }
  }
}

function pathRuleContextsOverlap(
  left: readonly PathContext[] | undefined,
  right: readonly PathContext[] | undefined,
): boolean {
  if (!left || !right) return true;
  return left.some((context) => right.includes(context));
}

function customToolRuleKey(rule: CustomToolRuleLike): string {
  return JSON.stringify(canonicalizeMatch(rule.match));
}

function canonicalizeMatch(
  match: Record<string, string> | undefined,
): Record<string, string> | null {
  if (!match) return null;
  return Object.fromEntries(
    Object.keys(match)
      .sort()
      .map((key) => [key, match[key]]),
  );
}
