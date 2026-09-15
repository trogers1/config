import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { directoryGlobsSchema, type DirectoryGlobs } from "./directoryGlobs";

const policyReferencePrefixSchemas = {
  builtinProfile: Type.Literal("builtin:"),
  shippedRuleset: Type.Literal("ruleset:"),
  customRuleset: Type.Literal("customruleset:"),
  transform: Type.Literal("transform:"),
} as const;

export const policyReferencePrefixSchema = Type.Union([
  policyReferencePrefixSchemas.builtinProfile,
  policyReferencePrefixSchemas.shippedRuleset,
  policyReferencePrefixSchemas.customRuleset,
  policyReferencePrefixSchemas.transform,
]);
export type PolicyReferencePrefix = Static<typeof policyReferencePrefixSchema>;
export type PolicyReferenceKind = keyof typeof policyReferencePrefixSchemas;

const reservedProfilePrefixKinds = [
  "builtinProfile",
  "shippedRuleset",
  "customRuleset",
  "transform",
] as const satisfies readonly PolicyReferenceKind[];
const compositionFragmentKinds = [
  "shippedRuleset",
  "customRuleset",
  "transform",
] as const satisfies readonly PolicyReferenceKind[];

export function policyReferencePrefix({
  kind,
}: {
  readonly kind: PolicyReferenceKind;
}): PolicyReferencePrefix {
  return policyReferencePrefixSchemas[kind].const;
}

export function hasPolicyReferencePrefix({
  name,
  kind,
}: {
  readonly name: string;
  readonly kind: PolicyReferenceKind;
}): boolean {
  return name.startsWith(policyReferencePrefix({ kind }));
}

export function isBuiltinProfileName({
  name,
}: {
  readonly name: string;
}): boolean {
  return hasPolicyReferencePrefix({ name, kind: "builtinProfile" });
}

function escapeRegExp({ value }: { readonly value: string }): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const customProfileNamePattern = `^(?!(?:${reservedProfilePrefixKinds
  .map((kind) => escapeRegExp({ value: policyReferencePrefix({ kind }) }))
  .join("|")})).+$`;

export const builtinProfileNames = [
  "builtin:default",
  "builtin:default-with-net",
  "builtin:worker",
  "builtin:read-only",
  "builtin:tests-hidden",
  "builtin:tests-only",
  "builtin:committer",
  "builtin:reviewer",
  "builtin:scribe-only",
  "builtin:deps-mutator",
  "builtin:no-shell",
  "builtin:implementation-only",
  "builtin:git-full",
] as const;
export type BuiltinProfileName = (typeof builtinProfileNames)[number];

export function reservedProfilePrefix({
  name,
}: {
  readonly name: string;
}): PolicyReferencePrefix | undefined {
  const kind = reservedProfilePrefixKinds.find((candidate) =>
    hasPolicyReferencePrefix({ name, kind: candidate }),
  );
  return kind ? policyReferencePrefix({ kind }) : undefined;
}

export function isReservedProfileName({
  name,
}: {
  readonly name: string;
}): boolean {
  return reservedProfilePrefix({ name }) !== undefined;
}

/** True for a non-profile element rendered directly in a composition chain. */
export function isCompositionFragmentName({
  name,
}: {
  readonly name: string;
}): boolean {
  return compositionFragmentKinds.some((kind) =>
    hasPolicyReferencePrefix({ name, kind }),
  );
}

export const profileTransformNameSchema = Type.Union([
  Type.Literal("transform:deny-asks"),
  Type.Literal("transform:allow-asks"),
  Type.Literal("transform:ask-all"),
  Type.Literal("transform:deny-all"),
]);
export type ProfileTransformName = Static<typeof profileTransformNameSchema>;
export const profileTransformNames = profileTransformNameSchema.anyOf.map(
  (schema) => schema.const,
) satisfies readonly ProfileTransformName[];

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
export const profileColorSchema = Type.Union([
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
export type ProfileColor = Static<typeof profileColorSchema>;
export const profileColorNames = profileColorSchema.anyOf.map(
  (schema) => schema.const,
) satisfies readonly ProfileColor[];

const sandboxConfigSchema = Type.Object(
  {
    network: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    extraWritePaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    extraDenyReadPaths: Type.Optional(
      Type.Array(Type.String({ minLength: 1 })),
    ),
    extraDenyWritePaths: Type.Optional(
      Type.Array(Type.String({ minLength: 1 })),
    ),
    kernelUnenforcedProtectedPaths: Type.Optional(
      Type.Array(Type.String({ minLength: 1 })),
    ),
    // See https://github.com/anthropic-experimental/sandbox-runtime#security-limitations
    enableWeakerNetworkIsolation: Type.Optional(
      Type.Boolean({
        description:
          "Permits macOS trustd IPC for Go TLS verification. This weakens network isolation and can permit data exfiltration; see https://github.com/anthropic-experimental/sandbox-runtime#security-limitations.",
      }),
    ),
    // Lets sandboxed tools create local Unix-domain or loopback listeners
    // (for example tsx's IPC socket) without enabling external networking.
    allowLocalBinding: Type.Optional(
      Type.Boolean({
        description:
          "Permits local Unix-domain and loopback socket listeners while network access remains denied.",
      }),
    ),
    // macOS-only escape hatch for GUI/Apple-event handoffs, such as `open`.
    // This does not weaken filesystem restrictions.
    allowAppleEvents: Type.Optional(
      Type.Boolean({
        description:
          "Permits macOS Apple Events and LaunchServices handoffs (for example the open command) from sandboxed Bash.",
      }),
    ),
    onUnavailable: Type.Optional(
      Type.Union([Type.Literal("block"), Type.Literal("warn")]),
    ),
  },
  { additionalProperties: false },
);

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

const sandboxPathArrayNameSchema = Type.Union([
  Type.Literal("extraWritePaths"),
  Type.Literal("extraDenyReadPaths"),
  Type.Literal("extraDenyWritePaths"),
  Type.Literal("kernelUnenforcedProtectedPaths"),
]);
const sandboxConfigOverrideBaseSchema = Type.Partial(sandboxConfigSchema);
const sandboxConfigOverrideSchema = Type.Object(
  {
    ...sandboxConfigOverrideBaseSchema.properties,
    overwritePathArrays: Type.Optional(
      Type.Array(sandboxPathArrayNameSchema, { uniqueItems: true }),
    ),
  },
  { additionalProperties: false },
);

export const userPromptFilePathSchema = Type.String({
  minLength: 2,
  pattern: String.raw`^(?:/.+|~/.+)$`,
  description:
    "An absolute path or a path beginning with ~/. Relative paths are reserved for shipped profiles.",
});
export type UserPromptFilePath = Static<typeof userPromptFilePathSchema>;

const profileProperties = {
  description: Type.Optional(Type.String({ minLength: 1 })),
  promptFile: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  color: Type.Optional(profileColorSchema),
  emoji: Type.Optional(Type.String()),
  // Command and custom-tool policy remain separate from path policy.
  // Dedicated path tools are governed exclusively by readPaths/writePaths.
  tools: toolsSchema,
  readPaths: Type.Array(readPathRuleSchema, { minItems: 1 }),
  writePaths: Type.Array(writePathRuleSchema, { minItems: 1 }),
  protectedPathRules: Type.Optional(Type.Array(protectedPathRuleSchema)),
  sandbox: Type.Optional(
    Type.Union([sandboxConfigSchema, Type.Literal(false)]),
  ),
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

export const profileConfigProfileSchema = Type.Object(
  {
    ...profileProperties,
    directoryGlobs: Type.Optional(directoryGlobsSchema),
    description: Type.String({ minLength: 1 }),
    promptFile: Type.Optional(
      Type.Union([userPromptFilePathSchema, Type.Null()]),
    ),
    extends: Type.Optional(profileExtendsSchema),
    transforms: Type.Optional(profileTransformsSchema),
    tools: Type.Optional(profileProperties.tools),
    readPaths: Type.Optional(Type.Array(readPathRuleSchema)),
    writePaths: Type.Optional(Type.Array(writePathRuleSchema)),
    sandbox: Type.Optional(
      Type.Union([sandboxConfigOverrideSchema, Type.Literal(false)]),
    ),
  },
  {
    additionalProperties: false,
    dependentRequired: { transforms: ["extends"] },
  },
);

/** A user-owned, partial policy fragment for composition through extends. */
const customRuleSetPolicySchema = Type.Object(
  {
    tools: Type.Optional(profileProperties.tools),
    readPaths: Type.Optional(profileProperties.readPaths),
    writePaths: Type.Optional(profileProperties.writePaths),
    protectedPathRules: Type.Optional(profileProperties.protectedPathRules),
  },
  { additionalProperties: false, minProperties: 1 },
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
export type SandboxConfig = Static<typeof sandboxConfigSchema>;
export type SandboxConfigOverride = Static<typeof sandboxConfigOverrideSchema>;
type SandboxPathArrayName = Static<typeof sandboxPathArrayNameSchema>;
export type ProfilePolicy = Static<typeof profileSchema>;
export type CustomRuleSetPolicy = Static<typeof customRuleSetPolicySchema>;
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
  "sandbox" | "transforms" | "directoryGlobs"
> & {
  directoryGlobs?: DirectoryGlobs;
  sandbox?: SandboxConfigOverride | false;
  transforms?: readonly ProfileTransformName[];
};
export type ProfilePolicyOverride = Omit<
  ProfileConfigProfile,
  "description" | "extends" | "transforms" | "directoryGlobs"
> & {
  description?: string;
};

export type ProfilePolicyFragment = Omit<Partial<ProfilePolicy>, "sandbox"> & {
  /** Raw authoring metadata is accepted while resolving, but never runtime policy. */
  directoryGlobs?: DirectoryGlobs;
  sandbox?: SandboxConfigOverride | false;
};

/** JSON Schema source of truth for ~/.pi/agent/pi-guard/profiles.jsonc. */
export const profileConfigFileSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    defaultProfile: Type.Optional(Type.String()),
    rulesets: Type.Optional(
      Type.Unsafe<Record<string, CustomRuleSetPolicy>>({
        type: "object",
        patternProperties: {
          "^.+$": customRuleSetPolicySchema,
        },
        additionalProperties: false,
      }),
    ),
    profiles: Type.Unsafe<Record<string, ProfileConfigProfile>>({
      type: "object",
      patternProperties: {
        [customProfileNamePattern]: profileConfigProfileSchema,
      },
      additionalProperties: false,
    }),
  },
  {
    $id: "https://raw.githubusercontent.com/trogers1/config/main/home/.pi/agent/packages/pi-guard/schemas/profiles.schema.json",
    title: "pi-guard profile configuration",
    additionalProperties: false,
  },
);
type ProfileConfigFileShape = Static<typeof profileConfigFileSchema>;
export type ProfileConfigFile = Omit<
  ProfileConfigFileShape,
  "profiles" | "rulesets"
> & {
  rulesets?: Record<string, CustomRuleSetPolicy>;
  profiles: Record<string, ProfileConfigProfile>;
};

export function parseOrThrow<Schema extends TSchema>({
  unverifiedData,
  schema,
  message,
}: {
  readonly unverifiedData: unknown;
  readonly schema: Schema;
  readonly message: string;
}): Static<Schema> {
  const validationError = Value.Errors(schema, unverifiedData)[0];
  if (validationError)
    throw new Error(
      `${message} at ${validationError.instancePath || "/"}: ${validationError.message}`,
    );
  if (!Value.Check(schema, unverifiedData))
    throw new Error(`${message}: schema validation failed`);
  return unverifiedData;
}

export function assertProfilePolicy(
  policy: unknown,
): asserts policy is ProfilePolicy {
  const validationError = Value.Errors(profileSchema, policy)[0];
  if (validationError) {
    throw new Error(
      `Invalid pi-guard profile at ${validationError.instancePath || "/"}: ${validationError.message}`,
    );
  }

  if (isProfilePolicyShape(policy)) {
    assertNoProtectedPathRuleConflicts(policy.protectedPathRules ?? []);
    assertSandboxConfig(policy);
  }
}

export function assertPolicyConfig(
  config: unknown,
): asserts config is PolicyConfig {
  const validationError = Value.Errors(policyConfigSchema, config)[0];
  if (validationError) {
    throw new Error(
      `Invalid pi-guard policy at ${validationError.instancePath || "/"}: ${validationError.message}`,
    );
  }

  if (!isPolicyConfigShape(config)) {
    throw new Error("Invalid pi-guard policy: schema validation failed");
  }

  for (const profile of Object.values(config.profiles)) {
    assertNoProtectedPathRuleConflicts(profile.protectedPathRules ?? []);
    assertSandboxConfig(profile);
  }

  if (!Object.hasOwn(config.profiles, config.defaultProfile)) {
    throw new Error(
      `Invalid pi-guard policy at /defaultProfile: profile '${config.defaultProfile}' is not configured`,
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

function isSandboxConfig(value: unknown): value is SandboxConfig {
  return typeof value === "object" && value !== null;
}

function assertSandboxConfig(policy: ProfilePolicy): void {
  const sandbox = policy.sandbox;
  if (!isSandboxConfig(sandbox)) return;
  for (const value of [
    ...(sandbox.extraWritePaths ?? []),
    ...(sandbox.extraDenyReadPaths ?? []),
    ...(sandbox.extraDenyWritePaths ?? []),
  ]) {
    assertSandboxPath(value, "sandbox path");
  }

  for (const waiver of sandbox.kernelUnenforcedProtectedPaths ?? []) {
    assertSandboxPath(waiver, "kernel waiver");
    if (
      !(policy.protectedPathRules ?? []).some(
        (rule) => rule.decision === "deny" && rule.pattern === waiver,
      )
    ) {
      throw new Error(
        `Invalid pi-guard profile: sandbox.kernelUnenforcedProtectedPaths entry '${waiver}' does not match an effective protected deny rule`,
      );
    }
  }
}

function assertSandboxPath(value: string, label: string): void {
  if (/\0|\r|\n/.test(value)) {
    throw new Error(
      `Invalid pi-guard profile: ${label} contains a newline or NUL byte`,
    );
  }
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
  (policy: ProfilePolicyFragment) => ProfilePolicyFragment
> = {
  "transform:deny-asks": denyAsksTransform,
  "transform:allow-asks": allowAsksTransform,
  "transform:ask-all": askAllTransform,
  "transform:deny-all": denyAllTransform,
};

function denyAsksTransform(
  policy: ProfilePolicyFragment,
): ProfilePolicyFragment {
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

function allowAsksTransform(
  policy: ProfilePolicyFragment,
): ProfilePolicyFragment {
  return mapProfileRules(policy, (rule) =>
    rule.decision === "ask" ? { ...rule, decision: "allow" } : rule,
  );
}

function askAllTransform(policy: ProfilePolicyFragment): ProfilePolicyFragment {
  return mapProfileRules(policy, (rule) =>
    rule.decision === "allow" ? { ...rule, decision: "ask" } : rule,
  );
}

function denyAllTransform(
  policy: ProfilePolicyFragment,
): ProfilePolicyFragment {
  return mapProfileRules(policy, (rule) => ({ ...rule, decision: "deny" }));
}

export function applyPolicyTransforms<T extends ProfilePolicyFragment>(
  policy: T,
  transforms: readonly ProfileTransformName[],
): T;
export function applyPolicyTransforms(
  policy: ProfilePolicyFragment,
  transforms: readonly ProfileTransformName[],
): ProfilePolicyFragment {
  return transforms.reduce(
    (current, transformName) =>
      profileTransformRegistry[transformName](current),
    policy,
  );
}

/**
 * Compose raw sandbox declarations without leaking `overwritePathArrays` into
 * the effective result. Scalars replace inherited values; path arrays append
 * unless the child explicitly names them in `overwritePathArrays`. `false` is
 * a hard opt-out, while an absent child declaration inherits unchanged.
 */
export function composeSandboxDeclarations(
  base: SandboxConfigOverride | false | undefined,
  override: SandboxConfigOverride | false | undefined,
): SandboxConfigOverride | false | undefined {
  if (override === undefined) return base;
  if (override === false) return false;

  const { overwritePathArrays = [], ...settings } = override;
  if (base === false || base === undefined) return settings;
  const composePathArray = (
    name: SandboxPathArrayName,
    inherited: readonly string[] | undefined,
    local: readonly string[] | undefined,
  ): string[] | undefined =>
    overwritePathArrays.includes(name)
      ? [...(local ?? [])]
      : inherited === undefined && local === undefined
        ? undefined
        : [...(inherited ?? []), ...(local ?? [])];
  const extraWritePaths = composePathArray(
    "extraWritePaths",
    base.extraWritePaths,
    settings.extraWritePaths,
  );
  const extraDenyReadPaths = composePathArray(
    "extraDenyReadPaths",
    base.extraDenyReadPaths,
    settings.extraDenyReadPaths,
  );
  const extraDenyWritePaths = composePathArray(
    "extraDenyWritePaths",
    base.extraDenyWritePaths,
    settings.extraDenyWritePaths,
  );
  const kernelUnenforcedProtectedPaths = composePathArray(
    "kernelUnenforcedProtectedPaths",
    base.kernelUnenforcedProtectedPaths,
    settings.kernelUnenforcedProtectedPaths,
  );

  return {
    ...base,
    ...settings,
    ...(extraWritePaths === undefined ? {} : { extraWritePaths }),
    ...(extraDenyReadPaths === undefined ? {} : { extraDenyReadPaths }),
    ...(extraDenyWritePaths === undefined ? {} : { extraDenyWritePaths }),
    ...(kernelUnenforcedProtectedPaths === undefined
      ? {}
      : { kernelUnenforcedProtectedPaths }),
  };
}

export function extendProfile(
  base: ProfilePolicy,
  override: ProfilePolicyFragment,
): ProfilePolicy;
export function extendProfile(
  base: ProfilePolicyFragment,
  override: ProfilePolicyFragment,
): ProfilePolicyFragment;
export function extendProfile(
  base: ProfilePolicyFragment,
  override: ProfilePolicyFragment,
): ProfilePolicyFragment {
  const mergedTools: ProfilePolicy["tools"] = structuredClone(base.tools ?? {});

  // Append override rules; later rules win only when specificity ties.
  for (const [toolName, overrideRules] of Object.entries(
    override.tools ?? {},
  )) {
    if (!overrideRules) continue;
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

  const {
    sandbox: sandboxOverride,
    directoryGlobs: rawDirectoryGlobs,
    ...otherOverride
  } = override;
  const { directoryGlobs: baseDirectoryGlobs, ...basePolicy } = base;
  // directoryGlobs is declaration-only metadata. Keep both destructures
  // explicit: spreading either raw operand must never retain it.
  void rawDirectoryGlobs;
  void baseDirectoryGlobs;

  return {
    ...basePolicy,
    ...otherOverride,
    sandbox: composeSandboxDeclarations(base.sandbox, sandboxOverride),
    tools: mergedTools,
    readPaths: [...(base.readPaths ?? []), ...(override.readPaths ?? [])],
    writePaths: [...(base.writePaths ?? []), ...(override.writePaths ?? [])],
    protectedPathRules: mergedProtectedPathRules,
  };
}

function mapProfileRules(
  policy: ProfilePolicyFragment,
  mapRule: <T extends { decision: Decision; guidance?: string }>(rule: T) => T,
): ProfilePolicyFragment {
  return {
    ...policy,
    tools: Object.fromEntries(
      Object.entries(policy.tools ?? {}).map(([toolName, rules]) => [
        toolName,
        rules?.map(mapRule) ?? [],
      ]),
    ),
    readPaths: (policy.readPaths ?? []).map(mapRule),
    writePaths: (policy.writePaths ?? []).map(mapRule),
    protectedPathRules: policy.protectedPathRules,
  };
}

function shouldWarnForProfileRuleConflicts(profileName: string): boolean {
  return (
    process.env.DEBUG === "true" ||
    (!profileName.startsWith("builtin:") && !profileName.startsWith("ruleset:"))
  );
}

export function warnOnPolicyRuleConflicts(
  policyConfig: Pick<PolicyConfig, "profiles">,
): void {
  for (const [profileName, profile] of Object.entries(policyConfig.profiles)) {
    if (shouldWarnForProfileRuleConflicts(profileName)) {
      warnOnProfileRuleConflicts(profileName, profile);
    }
  }
}

export function warnOnProfileRuleConflicts(
  profileName: string,
  profile: Partial<ProfilePolicy>,
): void {
  warnOnRuleConflicts(profileName, "bash", profile.tools?.bash ?? []);

  for (const [toolName, rules] of Object.entries(profile.tools ?? {})) {
    if (toolName === "bash" || !rules) continue;
    assertCustomToolRuleArray(toolName, rules);
    warnOnCustomToolRuleConflicts(profileName, toolName, rules);
  }

  warnOnPathRuleConflicts(profileName, "readPaths", profile.readPaths ?? []);
  warnOnPathRuleConflicts(profileName, "writePaths", profile.writePaths ?? []);
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
