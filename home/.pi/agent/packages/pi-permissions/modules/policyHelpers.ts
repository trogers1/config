import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

export const builtinProfilePrefix = "builtin:";

export function isBuiltinProfileName(name: string): boolean {
  return name.startsWith(builtinProfilePrefix);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const reservedProfilePrefixes = [builtinProfilePrefix, "transform:"] as const;

const customProfileNamePattern = `^(?!(?:${reservedProfilePrefixes
  .map((prefix) => escapeRegExp(prefix))
  .join("|")})).+$`;

export const builtinProfileNames = [
  "builtin:default",
  "builtin:worker",
  "builtin:read-only",
  "builtin:tests-hidden",
  "builtin:tests-only",
] as const;
export type BuiltinProfileName = (typeof builtinProfileNames)[number];

export function isReservedProfileName(name: string): boolean {
  return reservedProfilePrefixes.some((prefix) => name.startsWith(prefix));
}

const profileTransformNameSchema = Type.Union([
  Type.Literal("transform:deny-asks"),
  Type.Literal("transform:allow-asks"),
  Type.Literal("transform:ask-all"),
  Type.Literal("transform:deny-all"),
]);
export type ProfileTransformName = Static<typeof profileTransformNameSchema>;
export const profileTransformNames: readonly ProfileTransformName[] =
  profileTransformNameSchema.anyOf.map((schema) => schema.const);

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
  Type.Literal("orange"),
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

const protectedDecisionSchema = Type.Union([
  Type.Literal("allow"),
  Type.Literal("deny"),
]);

const protectedPathRuleSchema = Type.Object(
  {
    pattern: Type.String(),
    decision: protectedDecisionSchema,
    guidance: Type.Optional(Type.String()),
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
  protectedPathRules: Type.Optional(Type.Array(protectedPathRuleSchema)),
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

const profileExtendsSchema = Type.Array(Type.String(), { minItems: 1 });

const profileTransformsSchema = Type.Array(profileTransformNameSchema);

const profileConfigProfileSchema = Type.Object(
  {
    ...profileProperties,
    extends: Type.Optional(profileExtendsSchema),
    transforms: Type.Optional(profileTransformsSchema),
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
export type ProtectedPathRule = Static<typeof protectedPathRuleSchema>;
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
type ProfileConfigProfileShape = Static<typeof profileConfigProfileSchema>;
export type ProfileConfigProfile = Omit<
  ProfileConfigProfileShape,
  "transforms"
> & {
  transforms?: readonly ProfileTransformName[];
};
export type ProfilePolicyOverride = Omit<
  ProfileConfigProfile,
  "extends" | "transforms"
>;

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
type ProfileConfigFileShape = Static<typeof profileConfigFileSchema>;
export type ProfileConfigFile = Omit<ProfileConfigFileShape, "profiles"> & {
  profiles: Record<string, ProfileConfigProfile>;
};

export function assertProfilePolicy(
  policy: unknown,
): asserts policy is ProfilePolicy {
  const validationError = Value.Errors(profileSchema, policy)[0];
  if (validationError) {
    throw new Error(
      `Invalid pi-permissions profile at ${validationError.instancePath || "/"}: ${validationError.message}`,
    );
  }

  if (isProfilePolicyShape(policy)) {
    assertNoProtectedPathRuleConflicts(policy.protectedPathRules ?? []);
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

  if (!isPolicyConfigShape(config)) {
    throw new Error("Invalid pi-permissions policy: schema validation failed");
  }

  for (const profile of Object.values(config.profiles)) {
    assertNoProtectedPathRuleConflicts(profile.protectedPathRules ?? []);
  }

  if (!(config.defaultProfile in config.profiles)) {
    throw new Error(
      `Invalid pi-permissions policy at /defaultProfile: profile '${config.defaultProfile}' is not configured`,
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
  warnOnPolicyRuleConflicts(config);
  return config;
}

function isProfilePolicyShape(policy: unknown): policy is ProfilePolicy {
  return Value.Check(profileSchema, policy);
}

function assertNoProtectedPathRuleConflicts(
  rules: readonly ProtectedPathRule[],
): void {
  forEachConflictingPair(
    rules,
    (rule) => rule.pattern,
    (first, second) => {
      throw new Error(
        `Protected path rules conflict for pattern '${first.pattern}': '${first.decision}' conflicts with later '${second.decision}'.`,
      );
    },
  );
}

export function withProtectedPathRules(policy: ProfilePolicy): ProfilePolicy {
  // Protected-path semantics are now layered at evaluation time so the
  // ordinary ordered decision remains intact.
  return policy;
}

const nonInteractiveGuidance =
  "This non-interactive worker cannot request permission. Use an explicitly allowed command or path.";

const profileTransformRegistry: Record<
  ProfileTransformName,
  (policy: ProfilePolicy) => ProfilePolicy
> = {
  "transform:deny-asks": denyAsksTransform,
  "transform:allow-asks": allowAsksTransform,
  "transform:ask-all": askAllTransform,
  "transform:deny-all": denyAllTransform,
};

function denyAsksTransform(policy: ProfilePolicy): ProfilePolicy {
  return mapProfileRules(policy, (rule) =>
    rule.decision === "ask"
      ? {
          ...rule,
          decision: "deny",
          guidance: rule.guidance ?? nonInteractiveGuidance,
        }
      : rule,
  );
}

function allowAsksTransform(policy: ProfilePolicy): ProfilePolicy {
  return mapProfileRules(policy, (rule) =>
    rule.decision === "ask" ? { ...rule, decision: "allow" } : rule,
  );
}

function askAllTransform(policy: ProfilePolicy): ProfilePolicy {
  return mapProfileRules(policy, (rule) =>
    rule.decision === "allow" ? { ...rule, decision: "ask" } : rule,
  );
}

function denyAllTransform(policy: ProfilePolicy): ProfilePolicy {
  return mapProfileRules(policy, (rule) => ({ ...rule, decision: "deny" }));
}

export function applyPolicyTransforms(
  policy: ProfilePolicy,
  transforms: readonly ProfileTransformName[],
): ProfilePolicy {
  return transforms.reduce(
    (current, transformName) =>
      profileTransformRegistry[transformName](current),
    policy,
  );
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
      assertRuleArray(toolName, overrideRules);
      const inheritedRules = mergedTools.bash ?? [];
      mergedTools.bash = [...inheritedRules, ...overrideRules];
      continue;
    }

    assertCustomToolRuleArray(toolName, overrideRules);
    const inheritedRules = mergedTools[toolName] ?? [];
    assertCustomToolRuleArray(toolName, inheritedRules);
    mergedTools[toolName] = [...inheritedRules, ...overrideRules];
  }

  const mergedProtectedPathRules = [
    ...(base.protectedPathRules ?? []),
    ...(override.protectedPathRules ?? []),
  ];
  assertNoProtectedPathRuleConflicts(mergedProtectedPathRules);

  return {
    ...base,
    ...override,
    tools: mergedTools,
    readPaths: [...base.readPaths, ...(override.readPaths ?? [])],
    writePaths: [...base.writePaths, ...(override.writePaths ?? [])],
    protectedPathRules: mergedProtectedPathRules,
  };
}

function mapProfileRules(
  policy: ProfilePolicy,
  mapRule: <T extends { decision: Decision; guidance?: string }>(rule: T) => T,
): ProfilePolicy {
  return {
    ...policy,
    tools: Object.fromEntries(
      Object.entries(policy.tools).map(([toolName, rules]) => [
        toolName,
        rules?.map(mapRule) ?? [],
      ]),
    ),
    readPaths: policy.readPaths.map(mapRule),
    writePaths: policy.writePaths.map(mapRule),
    protectedPathRules: policy.protectedPathRules,
  };
}

export function warnOnPolicyRuleConflicts(
  policyConfig: Pick<PolicyConfig, "profiles">,
): void {
  for (const [profileName, profile] of Object.entries(policyConfig.profiles)) {
    warnOnProfileRuleConflicts(profileName, profile);
  }
}

export function warnOnProfileRuleConflicts(
  profileName: string,
  profile: ProfilePolicy,
): void {
  warnOnRuleConflicts(profileName, "bash", profile.tools.bash ?? []);

  for (const [toolName, rules] of Object.entries(profile.tools)) {
    if (toolName === "bash" || !rules) continue;
    assertCustomToolRuleArray(toolName, rules);
    warnOnCustomToolRuleConflicts(profileName, toolName, rules);
  }

  warnOnPathRuleConflicts(profileName, "readPaths", profile.readPaths);
  warnOnPathRuleConflicts(profileName, "writePaths", profile.writePaths);
}

function warnOnRuleConflicts(
  profileName: string,
  toolName: string,
  rules: readonly Rule[],
): void {
  forEachConflictingPair(
    rules,
    (rule) => rule.pattern,
    (first, second) => {
      console.warn(
        `Profile '${profileName}' has conflicting ${toolName} rules for pattern '${first.pattern}': '${first.decision}' conflicts with later '${second.decision}'.`,
      );
    },
  );
}

function warnOnCustomToolRuleConflicts(
  profileName: string,
  toolName: string,
  rules: readonly CustomToolRule[],
): void {
  forEachConflictingPair(rules, customToolRuleKey, (first, second) => {
    console.warn(
      `Profile '${profileName}' has conflicting custom-tool rules for '${toolName}' with match ${customToolRuleKey(first)}: '${first.decision}' conflicts with later '${second.decision}'.`,
    );
  });
}

function warnOnPathRuleConflicts(
  profileName: string,
  kind: "readPaths" | "writePaths",
  rules: readonly PathRule[],
): void {
  forEachConflictingPair(
    rules,
    (rule) => rule.pattern,
    (first, second) => {
      if (!pathRuleContextsOverlap(first.contexts, second.contexts)) return;
      console.warn(
        `Profile '${profileName}' has conflicting ${kind} rules for pattern '${first.pattern}': '${first.decision}' conflicts with later '${second.decision}'.`,
      );
    },
  );
}

function forEachConflictingPair<T extends { decision: Decision }>(
  rules: readonly T[],
  conflictKey: (rule: T) => string,
  report: (first: T, second: T) => void,
): void {
  for (let firstIndex = 0; firstIndex < rules.length; firstIndex++) {
    const first = rules[firstIndex];
    for (
      let secondIndex = firstIndex + 1;
      secondIndex < rules.length;
      secondIndex++
    ) {
      const second = rules[secondIndex];
      if (
        conflictKey(first) === conflictKey(second) &&
        first.decision !== second.decision
      ) {
        report(first, second);
      }
    }
  }
}

function assertRuleArray(
  toolName: string,
  rules: Rule[] | CustomToolRule[],
): asserts rules is Rule[] {
  const validationError = Value.Errors(Type.Array(ruleSchema), rules)[0];
  if (validationError) {
    throw new Error(
      `Invalid rules for tool '${toolName}' at ${validationError.instancePath || "/"}: ${validationError.message}`,
    );
  }
}

function assertCustomToolRuleArray(
  toolName: string,
  rules: Rule[] | CustomToolRule[],
): asserts rules is CustomToolRule[] {
  const validationError = Value.Errors(
    Type.Array(customToolRuleSchema),
    rules,
  )[0];
  if (validationError) {
    throw new Error(
      `Invalid custom-tool rules for '${toolName}' at ${validationError.instancePath || "/"}: ${validationError.message}`,
    );
  }
}

function isPolicyConfigShape(config: unknown): config is PolicyConfigShape {
  return Value.Check(policyConfigSchema, config);
}

function pathRuleContextsOverlap(
  left: readonly PathContext[] | undefined,
  right: readonly PathContext[] | undefined,
): boolean {
  if (!left || !right) return true;
  return left.some((context) => right.includes(context));
}

function customToolRuleKey(rule: CustomToolRule): string {
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
