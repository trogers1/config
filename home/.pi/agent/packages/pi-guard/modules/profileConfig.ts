import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  applyEdits,
  modify,
  parse,
  parseTree,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import { Value } from "typebox/value";
import {
  applyPolicyTransforms,
  assertPolicyConfig,
  assertProfilePolicy,
  extendProfile,
  hasPolicyReferencePrefix,
  isBuiltinProfileName,
  policyReferencePrefix,
  profileConfigFileSchema,
  reservedProfilePrefix,
  warnOnPolicyRuleConflicts,
  type CustomRuleSetPolicy,
  type PathContext,
  type PolicyConfig,
  type ProfileConfigFile,
  type ProfileConfigProfile,
  type ProfilePolicy,
  type ProfilePolicyFragment,
  type ProfileTransformName,
} from "./policyHelpers";
import { ruleSetRegistry } from "./ruleSets.lib/index";
import {
  validateDirectoryGlobs,
  type DirectoryGlobDeclaration,
} from "./directoryGlobs";
import {
  decodeSandboxAuthoring,
  serializeDirectoryGlobs,
  serializeSandboxAuthoring,
  type DirectoryGlobsAuthoring,
  type RawSandboxAuthoring,
} from "./profileAuthoring";
import {
  profileAuthoringSectionIds,
  type ProfileAuthoringDraft,
  type ProfileAuthoringSectionId,
  type ProfileAuthoringValidationIssue,
  type ProfileAuthoringValidationIssueCode,
} from "./profileAuthoringModel";
import {
  createMissingPromptFile,
  rollbackCreatedPromptFile,
  validatePromptFile,
  type PromptFileValidation,
} from "./profilePromptFile";

export class ProfileConfigLoadError extends Error {
  readonly configPath: string;
  readonly details: string;
  readonly instancePath: string | undefined;

  constructor(configPath: string, details: string, instancePath?: string) {
    super(`Invalid pi-guard profile config at ${configPath}: ${details}`);
    this.name = "ProfileConfigLoadError";
    Object.setPrototypeOf(this, new.target.prototype);
    this.configPath = configPath;
    this.details = details;
    this.instancePath = instancePath;
  }
}

export class ProfileAuthoringValidationError extends ProfileConfigLoadError {
  readonly issues: readonly ProfileAuthoringValidationIssue[];

  constructor({
    configPath,
    issues,
  }: {
    readonly configPath: string;
    readonly issues: readonly ProfileAuthoringValidationIssue[];
  }) {
    super(configPath, issues.map(({ message }) => message).join("; "));
    this.name = "ProfileAuthoringValidationError";
    this.issues = issues;
  }
}

export type RawProfileConfig = {
  defaultProfile?: string;
  rulesets?: Record<string, CustomRuleSetPolicy>;
  profiles: Record<string, ProfileConfigProfile>;
};

export class ProfileConfigMissingError extends Error {
  readonly configPath: string;
  constructor(configPath: string) {
    super(`Profile config is missing at ${configPath}`);
    this.name = "ProfileConfigMissingError";
    this.configPath = configPath;
  }
}

/** The source changed after an authoring snapshot was reviewed. */
export class ProfileConfigConflictError extends ProfileConfigLoadError {
  constructor(configPath: string) {
    super(
      configPath,
      "configuration changed; reload and review the changes again",
    );
    this.name = "ProfileConfigConflictError";
  }
}

export class ProfileConfigMalformedError extends ProfileConfigLoadError {
  constructor(configPath: string, details: string) {
    super(configPath, details);
    this.name = "ProfileConfigMalformedError";
  }
}

export class ProfileConfigUnreadableError extends ProfileConfigLoadError {
  constructor(configPath: string, details: string) {
    super(configPath, details);
    this.name = "ProfileConfigUnreadableError";
  }
}

/** The source parsed successfully but is not a profile-config document. */
export class ProfileConfigSchemaInvalidError extends ProfileConfigLoadError {
  constructor(configPath: string, details: string) {
    super(configPath, details);
    this.name = "ProfileConfigSchemaInvalidError";
  }
}

function throwProfileConfigError(
  configPath: string,
  details: string,
  instancePath?: string,
): never {
  throw new ProfileConfigLoadError(configPath, details, instancePath);
}

const defaultProfileConfigPath = path.join(
  homedir(),
  ".pi",
  "agent",
  "pi-guard",
  "profiles.jsonc",
);

/** Resolve the user-owned profile file used by the profile loader and mutators. */
export function resolveProfileConfigPath(configPath?: string): string {
  return configPath ?? defaultProfileConfigPath;
}

function isProfileConfigFile(value: unknown): value is ProfileConfigFile {
  return Value.Check(profileConfigFileSchema, value);
}

function isShippedRuleSetName(
  name: string,
): name is keyof typeof ruleSetRegistry {
  return Object.hasOwn(ruleSetRegistry, name);
}

/**
 * Read the raw user-owned profile file without resolving inheritance or
 * transforms. Returns `undefined` when the file is missing or invalid so that
 * callers can fall back to other behavior.
 */
export function loadRawProfileConfig(
  configPath = resolveProfileConfigPath(),
): RawProfileConfig | undefined {
  if (!fs.existsSync(configPath)) return undefined;

  try {
    const errors: ParseError[] = [];
    const parsed: unknown = parse(fs.readFileSync(configPath, "utf8"), errors, {
      allowTrailingComma: true,
    });
    if (errors.length > 0) return undefined;

    const validationError = Value.Errors(profileConfigFileSchema, parsed)[0];
    if (validationError) return undefined;
    if (!isProfileConfigFile(parsed)) return undefined;

    return parsed;
  } catch {
    return undefined;
  }
}

/** A complete, validated raw declaration in source order. */
export type RawProfileDeclaration = {
  readonly profile: string;
  readonly definition: ProfileConfigProfile;
};

function profileNamesInSourceOrder(source: string): readonly string[] {
  const root = parseTree(source, [], { allowTrailingComma: true });
  const profilesProperty = root?.children?.find(
    (property) => property.children?.[0]?.value === "profiles",
  );
  const profiles = profilesProperty?.children?.[1];
  if (profiles?.type !== "object") return [];
  return (
    profiles.children?.flatMap((property) => {
      const name = property.children?.[0];
      return name?.type === "string" && typeof name.value === "string"
        ? [name.value]
        : [];
    }) ?? []
  );
}

/** Return complete validated declarations in source order. */
export function loadRawProfileDeclarations(
  configPath = resolveProfileConfigPath(),
): readonly RawProfileDeclaration[] {
  if (!fs.existsSync(configPath))
    throw new ProfileConfigMissingError(configPath);
  let source: string;
  try {
    source = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    throw new ProfileConfigUnreadableError(
      configPath,
      error instanceof Error ? error.message : String(error),
    );
  }
  try {
    const errors: ParseError[] = [];
    const parsed: unknown = parse(source, errors, {
      allowTrailingComma: true,
    });
    const validationError =
      errors.length > 0
        ? undefined
        : Value.Errors(profileConfigFileSchema, parsed)[0];
    if (errors.length > 0)
      throw new ProfileConfigMalformedError(
        configPath,
        `JSONC parse error: ${errors.map((error) => printParseErrorCode(error.error)).join(", ")}`,
      );
    if (validationError || !isProfileConfigFile(parsed))
      throw new ProfileConfigSchemaInvalidError(
        configPath,
        validationError
          ? `schema validation failed at ${validationError.instancePath || "/"}: ${validationError.message}`
          : "schema validation failed",
      );
    const declarations: RawProfileDeclaration[] = [];
    for (const profile of profileNamesInSourceOrder(source)) {
      const definition = parsed.profiles[profile];
      if (definition.directoryGlobs !== undefined) {
        const result = validateDirectoryGlobs(definition.directoryGlobs);
        if (!result.valid)
          throw new ProfileConfigMalformedError(
            configPath,
            `/profiles/${profile}/directoryGlobs: ${result.message} (${result.code})`,
          );
      }
      declarations.push({ profile, definition });
    }
    return declarations;
  } catch (error) {
    if (error instanceof ProfileConfigLoadError) throw error;
    throw new ProfileConfigMalformedError(
      configPath,
      `failed to read profile config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Derive matcher input from the same strict raw declaration snapshot. */
function directoryDeclaration(
  profile: string,
  globs: ProfileConfigProfile["directoryGlobs"],
): DirectoryGlobDeclaration {
  if (globs === undefined)
    throw new Error("directory declaration requires globs");
  return [profile, globs];
}

export function loadDirectoryGlobDeclarations(
  configPath = resolveProfileConfigPath(),
): readonly DirectoryGlobDeclaration[] {
  return loadRawProfileDeclarations(configPath).flatMap(
    ({ profile, definition }) =>
      definition.directoryGlobs === undefined
        ? []
        : [directoryDeclaration(profile, definition.directoryGlobs)],
  );
}

/** One coherent configuration snapshot for consumers needing policy and metadata. */
export type ProfileConfigSnapshot = {
  /** Opaque content revision for optimistic profile mutations. */
  readonly sourceRevision: string;
  /** Opaque source identity; callers must not interpret its representation. */
  readonly sourceIdentity: string;
  readonly config: PolicyConfig;
  readonly raw: RawProfileConfig | undefined;
  readonly declarations: readonly RawProfileDeclaration[];
  readonly directoryGlobDeclarations: readonly DirectoryGlobDeclaration[];
};

/**
 * Read the file once so startup consumers never combine policy from one write
 * with directory metadata from another. Parse/schema errors retain the strict
 * loader's error distinctions.
 */
export function loadProfileConfigSnapshot(
  fallback: PolicyConfig,
  configPath = resolveProfileConfigPath(),
): ProfileConfigSnapshot {
  if (!fs.existsSync(configPath))
    return {
      sourceRevision: sourceRevision(undefined),
      sourceIdentity: "missing",
      config: fallback,
      raw: undefined,
      declarations: [],
      directoryGlobDeclarations: [],
    };
  let source: string;
  try {
    source = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    throw new ProfileConfigUnreadableError(
      configPath,
      error instanceof Error ? error.message : String(error),
    );
  }
  const errors: ParseError[] = [];
  const parsed: unknown = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0)
    throw new ProfileConfigMalformedError(
      configPath,
      `JSONC parse error: ${errors.map((error) => printParseErrorCode(error.error)).join(", ")}`,
    );
  const config = loadProfileConfigSource(fallback, configPath, source, parsed);
  if (errors.length > 0 || !isProfileConfigFile(parsed))
    throw new ProfileConfigMalformedError(
      configPath,
      "configuration changed while loading snapshot",
    );
  const declarations = profileNamesInSourceOrder(source).map((profile) => ({
    profile,
    definition: parsed.profiles[profile],
  }));
  const identity = fs.statSync(configPath);
  return {
    sourceRevision: sourceRevision(source),
    sourceIdentity: `${identity.dev}:${identity.ino}`,
    config,
    raw: parsed,
    declarations,
    directoryGlobDeclarations: declarations.flatMap(
      ({ profile, definition }) =>
        definition.directoryGlobs === undefined
          ? []
          : [directoryDeclaration(profile, definition.directoryGlobs)],
    ),
  };
}

/**
 * Read user-owned profile data synchronously and resolve inheritance and
 * transforms. Configuration is deliberately JSON-only: loading it must not
 * execute code or delay Pi's startup lifecycle.
 */
export function loadProfileConfig(
  fallback: PolicyConfig,
  configPath = resolveProfileConfigPath(),
): PolicyConfig {
  if (!fs.existsSync(configPath)) return fallback;
  try {
    return loadProfileConfigSource(
      fallback,
      configPath,
      fs.readFileSync(configPath, "utf8"),
    );
  } catch (error) {
    if (error instanceof ProfileConfigLoadError) throw error;
    throwProfileConfigError(
      configPath,
      `failed to read profile config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Validate and resolve a profile document already held in memory. */
function loadProfileConfigSource(
  fallback: PolicyConfig,
  configPath: string,
  source: string,
  parsedSource?: unknown,
): PolicyConfig {
  try {
    const errors: ParseError[] = [];
    const parsed: unknown =
      parsedSource ?? parse(source, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      throwProfileConfigError(
        configPath,
        `JSONC parse error: ${errors
          .map((error) => printParseErrorCode(error.error))
          .join(", ")}`,
      );
    }

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "profiles" in parsed &&
      typeof parsed.profiles === "object" &&
      parsed.profiles !== null
    ) {
      for (const name of Object.keys(parsed.profiles)) {
        const definition: unknown = Object.getOwnPropertyDescriptor(
          parsed.profiles,
          name,
        )?.value;
        const prefix = reservedProfilePrefix({ name });
        if (prefix) {
          throwProfileConfigError(
            configPath,
            `/profiles/${name}: reserved profile name '${name}' begins with '${prefix}'`,
          );
        }
        if (
          typeof definition === "object" &&
          definition !== null &&
          Object.hasOwn(definition, "transforms") &&
          !Object.hasOwn(definition, "extends")
        ) {
          throwProfileConfigError(
            configPath,
            `/profiles/${name}/transforms: transforms require at least one extends target`,
          );
        }
      }
    }

    const validationError = Value.Errors(profileConfigFileSchema, parsed)[0];
    if (validationError) {
      throwProfileConfigError(
        configPath,
        `schema validation failed at ${validationError.instancePath || "/"}: ${validationError.message}`,
      );
    }
    if (!isProfileConfigFile(parsed)) {
      throwProfileConfigError(configPath, "schema validation failed");
    }

    // TypeBox checks the shape, while directoryGlobs has additional semantic
    // constraints shared by directory selection and authoring.
    for (const [profileName, definition] of Object.entries(parsed.profiles)) {
      if (definition.directoryGlobs === undefined) continue;
      const validation = validateDirectoryGlobs(definition.directoryGlobs);
      if (!validation.valid) {
        throwProfileConfigError(
          configPath,
          `/profiles/${profileName}/directoryGlobs: ${validation.message} (${validation.code})`,
        );
      }
    }

    const profileFile = parsed;
    const builtins = fallback.profiles;
    const userDefinitions = profileFile.profiles;
    const customRulesets = profileFile.rulesets ?? {};

    const resolvedUsers = new Map<string, ProfilePolicy>();
    const resolving = new Set<string>();

    const applyTransforms = <T extends ProfilePolicyFragment>(
      policy: T,
      transforms: readonly ProfileTransformName[] | undefined,
    ): T => {
      if (!transforms || transforms.length === 0) return policy;
      return applyPolicyTransforms(policy, transforms);
    };

    const resolveProfile = (
      target: string,
      referrer: string = target,
    ): ProfilePolicyFragment => {
      if (hasPolicyReferencePrefix({ name: target, kind: "transform" })) {
        throwProfileConfigError(
          configPath,
          `/profiles/${referrer}/extends: reserved transform name '${target}' cannot be used as a profile`,
          `/profiles/${referrer}/extends`,
        );
      }
      if (isBuiltinProfileName({ name: target })) {
        const builtin = builtins[target];
        if (!builtin) {
          throwProfileConfigError(
            configPath,
            `/profiles/${referrer}/extends: unknown built-in profile '${target}'`,
            `/profiles/${referrer}/extends`,
          );
        }
        return builtin;
      }
      if (isShippedRuleSetName(target)) {
        return ruleSetRegistry[target];
      }
      if (hasPolicyReferencePrefix({ name: target, kind: "shippedRuleset" })) {
        throwProfileConfigError(
          configPath,
          `/profiles/${referrer}/extends: unknown rule set '${target}'`,
          `/profiles/${referrer}/extends`,
        );
      }
      if (hasPolicyReferencePrefix({ name: target, kind: "customRuleset" })) {
        const name = target.slice(
          policyReferencePrefix({ kind: "customRuleset" }).length,
        );
        const customRuleSet = Object.hasOwn(customRulesets, name)
          ? customRulesets[name]
          : undefined;
        if (!customRuleSet) {
          throwProfileConfigError(
            configPath,
            `/profiles/${referrer}/extends: unknown custom rule set '${target}'`,
            `/profiles/${referrer}/extends`,
          );
        }
        return customRuleSet;
      }

      const cachedProfile = resolvedUsers.get(target);
      if (cachedProfile) return cachedProfile;

      const definition = Object.hasOwn(userDefinitions, target)
        ? userDefinitions[target]
        : undefined;
      if (!definition) {
        const available = [
          ...Object.keys(builtins),
          ...Object.keys(ruleSetRegistry),
          ...Object.keys(userDefinitions),
        ].join(", ");
        const suggestion = isBuiltinProfileName({ name: referrer })
          ? ""
          : ` Did you mean 'builtin:${target}'?`;
        throwProfileConfigError(
          configPath,
          `/profiles/${referrer}/extends: unknown inherited profile '${target}'. Available: ${available}.${suggestion}`,
          `/profiles/${referrer}/extends`,
        );
      }
      if (resolving.has(target)) {
        throwProfileConfigError(
          configPath,
          `/profiles/${target}/extends: cyclic profile inheritance detected`,
          `/profiles/${target}/extends`,
        );
      }
      resolving.add(target);

      const {
        extends: parents = [],
        transforms,
        directoryGlobs: rawDirectoryGlobs,
        ...override
      } = definition;
      void rawDirectoryGlobs;
      let resolved: ProfilePolicyFragment;
      if (parents.length === 0) {
        // Compose even standalone declarations so authoring-only
        // overwritePathArrays never reaches the runtime policy assertion.
        resolved = extendProfile({}, override);
      } else {
        resolved = resolveProfile(parents[0], target);
        for (const parent of parents.slice(1)) {
          resolved = extendProfile(resolved, resolveProfile(parent, target));
        }
        // Transforms normalize the fully composed inherited policy. The
        // declaring profile's own rules are final, explicit overrides.
        resolved = applyTransforms(resolved, transforms);
        resolved = extendProfile(resolved, override);
      }
      // Rule sets may be partial while they are folded, but every named user
      // profile must be complete before it enters the resolved profile map.
      assertProfilePolicy(resolved);
      resolvedUsers.set(target, resolved);
      resolving.delete(target);
      return resolved;
    };

    for (const name of Object.keys(userDefinitions)) resolveProfile(name);

    const resolvedUserProfiles = Object.fromEntries(resolvedUsers);
    const profiles: Record<string, ProfilePolicy> = {
      ...builtins,
      ...resolvedUserProfiles,
    };

    const config: PolicyConfig = {
      defaultProfile: profileFile.defaultProfile ?? fallback.defaultProfile,
      profiles,
    };
    try {
      assertPolicyConfig(config);
    } catch (error) {
      throwProfileConfigError(
        configPath,
        error instanceof Error ? error.message : String(error),
      );
    }
    warnOnPolicyRuleConflicts({ profiles: resolvedUserProfiles });
    return config;
  } catch (error) {
    if (error instanceof ProfileConfigLoadError) throw error;
    throwProfileConfigError(
      configPath,
      `failed to read profile config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export type OrdinaryPathRuleKind = "read" | "write";
export type RuleKind = OrdinaryPathRuleKind | "bash" | "protected";

/** A single validated change to one profile policy collection. */
type BaseProfileRuleChange = {
  pattern: string;
  decision: "allow" | "deny";
  guidance?: string;
  /** Existing request-derived identity to remove when the editor changes its pattern. */
  replacePattern?: string;
};
export type ProfileRuleChange =
  | (BaseProfileRuleChange & { kind: "bash" | "protected"; contexts?: never })
  | (BaseProfileRuleChange & {
      kind: OrdinaryPathRuleKind;
      contexts?: readonly PathContext[];
    });
export type ProfileMutationTarget =
  | { mode: "update"; profile: string }
  | {
      mode: "create-child";
      profile: string;
      extends: readonly [string, ...string[]];
      description: string;
      emoji?: string;
      color?: ProfileConfigProfile["color"];
    };

type ProfileRuleIdentity = {
  readonly kind: RuleKind;
  readonly pattern: string;
  readonly contexts?: readonly PathContext[];
};

/** Reject duplicate/overlapping raw rows before any profile mutation writes. */
function assertUnambiguousProfileRuleIdentities({
  rules,
  configPath,
}: {
  readonly rules: readonly ProfileRuleIdentity[];
  readonly configPath: string;
}): void {
  const prior = new Map<string, Array<Set<string> | undefined>>();
  for (const rule of rules) {
    if (rule.contexts !== undefined && rule.contexts.length === 0)
      throw new ProfileConfigLoadError(
        configPath,
        `contexts for '${rule.pattern}' must not be empty`,
      );
    const normalized =
      rule.contexts === undefined
        ? undefined
        : new Set(rule.contexts.map(String));
    const key = `${rule.kind}\0${rule.pattern}`;
    const existing = prior.get(key) ?? [];
    const overlaps = existing.some(
      (contexts) =>
        contexts === undefined ||
        normalized === undefined ||
        [...contexts].some((context) => normalized.has(context)),
    );
    if (overlaps)
      throw new ProfileConfigLoadError(
        configPath,
        `overlapping ${rule.kind} rule changes '${rule.pattern}'`,
      );
    existing.push(normalized);
    prior.set(key, existing);
  }
}

/** Reject duplicate/overlapping ASK rows before their atomic mutation. */
export function assertUnambiguousProfileRuleChanges({
  changes,
  configPath = resolveProfileConfigPath(),
}: {
  readonly changes: readonly ProfileRuleChange[];
  readonly configPath?: string;
}): void {
  assertUnambiguousProfileRuleIdentities({ rules: changes, configPath });
}

const jsoncFormatting = { insertSpaces: true, tabSize: 2, eol: "\n" };

type MutationDocument = { readonly profiles: Record<string, unknown> };
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isMutationDocument(value: unknown): value is MutationDocument {
  return isRecord(value) && isRecord(value.profiles);
}

function sourceRevision(source: string | undefined): string {
  return createHash("sha256")
    .update(source ?? "")
    .digest("hex");
}

function readMutationSource(configPath: string): string {
  if (!fs.existsSync(configPath)) return '{\n  "profiles": {}\n}\n';
  const source = fs.readFileSync(configPath, "utf8");
  const errors: ParseError[] = [];
  const parsed: unknown = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || typeof parsed !== "object" || parsed === null) {
    const detail =
      errors.length > 0
        ? `JSONC parse error: ${errors.map((error) => printParseErrorCode(error.error)).join(", ")}`
        : "configuration root must be an object";
    throw new ProfileConfigLoadError(configPath, detail);
  }
  const profiles: unknown = Reflect.get(parsed, "profiles");
  if (
    !Object.hasOwn(parsed, "profiles") ||
    typeof profiles !== "object" ||
    profiles === null
  ) {
    throw new ProfileConfigLoadError(
      configPath,
      "configuration must contain a profiles object",
    );
  }
  return source;
}

function atomicallyWriteProfileConfig(
  configPath: string,
  source: string,
  expectedRevision?: string,
): void {
  const directory = path.dirname(configPath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(configPath)}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, source, { encoding: "utf8", flag: "wx" });
    if (fs.existsSync(configPath))
      fs.chmodSync(temporaryPath, fs.statSync(configPath).mode & 0o7777);
    // Filesystems do not offer a portable compare-and-swap rename. This is the
    // latest possible check; a separate process can still race the rename.
    const current = fs.existsSync(configPath)
      ? fs.readFileSync(configPath, "utf8")
      : undefined;
    if (
      expectedRevision !== undefined &&
      sourceRevision(current) !== expectedRevision
    )
      throw new ProfileConfigConflictError(configPath);
    fs.renameSync(temporaryPath, configPath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      /* already renamed */
    }
  }
}

/** Options for one validated, atomic profile-rule mutation. */
export type ApplyProfileRuleChangesOptions = {
  fallback: PolicyConfig;
  configPath?: string;
  /** Revision obtained from the snapshot the user reviewed. */
  expectedRevision?: string;
  target: ProfileMutationTarget;
  changes: readonly ProfileRuleChange[];
};

type RuleSectionEdit<T> =
  { readonly mode: "omit" } | { readonly mode: "set"; readonly value: T };
type BashDeclaration = NonNullable<
  NonNullable<ProfileConfigProfile["tools"]>["bash"]
>;
type ReadPathDeclarations = NonNullable<ProfileConfigProfile["readPaths"]>;
type WritePathDeclarations = NonNullable<ProfileConfigProfile["writePaths"]>;
type ProtectedPathDeclarations = NonNullable<
  ProfileConfigProfile["protectedPathRules"]
>;

/** A narrow raw-declaration edit. Omitted properties are never rewritten. */
type AuthoringDeclarationEdit = {
  readonly sandbox?: RawSandboxAuthoring;
  readonly directoryGlobs?: DirectoryGlobsAuthoring;
  readonly bash?: RuleSectionEdit<BashDeclaration>;
  readonly readPaths?: RuleSectionEdit<ReadPathDeclarations>;
  readonly writePaths?: RuleSectionEdit<WritePathDeclarations>;
  readonly protectedPathRules?: RuleSectionEdit<ProtectedPathDeclarations>;
};
type AuthoringDeclarationCandidateOptions = {
  readonly fallback: PolicyConfig;
  /** Revision obtained from the snapshot the user reviewed. */
  readonly expectedRevision?: string;
  readonly configPath?: string;
  readonly profile: string;
  readonly edit: AuthoringDeclarationEdit;
};
type PreparedAuthoringDeclarationCandidate = {
  readonly configPath: string;
  readonly sourceRevision: string;
  readonly source: string;
  readonly updated: string;
};

function declarationEditIsEmpty(edit: AuthoringDeclarationEdit): boolean {
  return Object.keys(edit).length === 0;
}

/** Reject ambiguous rows submitted by a declaration editor before writing. */
function assertUnambiguousDeclarationRules(
  rules: readonly { pattern: string; contexts?: readonly string[] }[],
  kind: string,
  configPath: string,
): void {
  const prior = new Map<string, Array<Set<string> | undefined>>();
  for (const rule of rules) {
    const contexts = rule.contexts ? new Set(rule.contexts) : undefined;
    const existing = prior.get(rule.pattern) ?? [];
    if (
      existing.some(
        (previous) =>
          previous === undefined ||
          contexts === undefined ||
          [...previous].some((context) => contexts.has(context)),
      )
    )
      throw new ProfileConfigLoadError(
        configPath,
        `overlapping ${kind} rules '${rule.pattern}'`,
      );
    existing.push(contexts);
    prior.set(rule.pattern, existing);
  }
}

/** Prepare a declaration-only UPDATE without writing the configuration. */
function prepareAuthoringDeclarationCandidate(
  options: AuthoringDeclarationCandidateOptions,
  sourceOverride?: string,
): PreparedAuthoringDeclarationCandidate {
  const configPath = resolveProfileConfigPath(options.configPath);
  if (declarationEditIsEmpty(options.edit))
    throw new ProfileConfigLoadError(
      configPath,
      "at least one declaration edit is required",
    );
  if (options.edit.bash?.mode === "set")
    assertUnambiguousDeclarationRules(
      options.edit.bash.value,
      "Bash",
      configPath,
    );
  if (options.edit.readPaths?.mode === "set")
    assertUnambiguousDeclarationRules(
      options.edit.readPaths.value,
      "read-path",
      configPath,
    );
  if (options.edit.writePaths?.mode === "set")
    assertUnambiguousDeclarationRules(
      options.edit.writePaths.value,
      "write-path",
      configPath,
    );
  if (options.edit.protectedPathRules?.mode === "set")
    assertUnambiguousDeclarationRules(
      options.edit.protectedPathRules.value,
      "protected-path",
      configPath,
    );
  const source = sourceOverride ?? readMutationSource(configPath);
  const parsed: unknown = parse(source, [], { allowTrailingComma: true });
  if (
    !isMutationDocument(parsed) ||
    !Object.hasOwn(parsed.profiles, options.profile)
  )
    throw new ProfileConfigLoadError(
      configPath,
      `profile '${options.profile}' does not exist`,
    );
  const profilePath = ["profiles", options.profile] as const;
  let updated = source;
  const apply = (key: string, value: unknown): void => {
    updated = applyEdits(
      updated,
      modify(updated, [...profilePath, key], value, {
        formattingOptions: jsoncFormatting,
      }),
    );
  };
  const applySandboxEdit = (authoring: RawSandboxAuthoring): void => {
    const serialized = serializeSandboxAuthoring({ value: authoring });
    // Omission deletes the declaration as a whole. A customization instead
    // edits only changed members, retaining comments/formatting on every
    // unchanged sandbox setting.
    if (serialized === undefined || serialized === false) {
      apply("sandbox", serialized);
      return;
    }
    const currentDocument: unknown = parse(updated, [], {
      allowTrailingComma: true,
    });
    const currentProfile = isRecord(currentDocument)
      ? currentDocument.profiles
      : undefined;
    const currentProfileDefinition = isRecord(currentProfile)
      ? currentProfile[options.profile]
      : undefined;
    const currentSandbox = isRecord(currentProfileDefinition)
      ? currentProfileDefinition.sandbox
      : undefined;
    const before = isRecord(currentSandbox) ? currentSandbox : {};
    const keys = [
      "network",
      "allowLocalBinding",
      "allowAppleEvents",
      "enableWeakerNetworkIsolation",
      "onUnavailable",
      "extraWritePaths",
      "extraDenyReadPaths",
      "extraDenyWritePaths",
      "kernelUnenforcedProtectedPaths",
      "overwritePathArrays",
    ] as const;
    for (const key of keys) {
      const next = serialized[key];
      if (JSON.stringify(before[key]) !== JSON.stringify(next)) {
        updated = applyEdits(
          updated,
          modify(updated, [...profilePath, "sandbox", key], next, {
            formattingOptions: jsoncFormatting,
          }),
        );
      }
    }
  };
  if (options.edit.sandbox !== undefined)
    applySandboxEdit(options.edit.sandbox);
  if (options.edit.directoryGlobs !== undefined) {
    const serialized = serializeDirectoryGlobs({
      value: options.edit.directoryGlobs,
    });
    if (serialized === undefined) apply("directoryGlobs", undefined);
    else {
      const current: unknown = parse(updated, [], { allowTrailingComma: true });
      const profile = isRecord(current) ? current.profiles : undefined;
      const definition = isRecord(profile)
        ? profile[options.profile]
        : undefined;
      const existing = isRecord(definition)
        ? definition.directoryGlobs
        : undefined;
      if (
        existing !== undefined &&
        (!Array.isArray(existing) ||
          !existing.every((glob) => typeof glob === "string"))
      )
        throw new ProfileConfigLoadError(
          configPath,
          "directoryGlobs must be an array of strings",
        );
      updated = applyDirectoryGlobArrayEdit(
        updated,
        [...profilePath, "directoryGlobs"],
        Array.isArray(existing) ? existing : [],
        serialized,
      );
    }
  }
  const existingRuleArray = (
    location: readonly string[],
  ): readonly Record<string, unknown>[] => {
    const current: unknown = parse(updated, [], { allowTrailingComma: true });
    const value = location.reduce<unknown>(
      (parent, key) => (isRecord(parent) ? parent[key] : undefined),
      current,
    );
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every(isRecord))
      throw new ProfileConfigLoadError(
        configPath,
        `${location.join(".")} must be an array of rule objects`,
      );
    return value;
  };
  const applyRuleSection = (
    location: readonly string[],
    value: readonly unknown[],
  ): void => {
    if (!value.every(isRecord))
      throw new ProfileConfigLoadError(
        configPath,
        `${location.join(".")} must be an array of rule objects`,
      );
    updated = applyRuleArrayEdit(
      updated,
      [...profilePath, ...location],
      existingRuleArray([...profilePath, ...location]),
      value,
    );
  };
  const applySection = (
    key: "bash" | "readPaths" | "writePaths" | "protectedPathRules",
    section: RuleSectionEdit<readonly unknown[]> | undefined,
  ): void => {
    if (section === undefined) return;
    if (key === "bash") {
      const profile = parsed.profiles[options.profile];
      const tools = isRecord(profile) ? profile.tools : undefined;
      const hasCustomToolSibling = isRecord(tools)
        ? Object.keys(tools).some((name) => name !== "bash")
        : false;
      if (section.mode === "omit") {
        updated = applyEdits(
          updated,
          modify(
            updated,
            hasCustomToolSibling
              ? [...profilePath, "tools", "bash"]
              : [...profilePath, "tools"],
            undefined,
            { formattingOptions: jsoncFormatting },
          ),
        );
      } else applyRuleSection(["tools", "bash"], section.value);
      return;
    }
    if (section.mode === "omit") apply(key, undefined);
    else applyRuleSection([key], section.value);
  };
  applySection("bash", options.edit.bash);
  applySection("readPaths", options.edit.readPaths);
  applySection("writePaths", options.edit.writePaths);
  applySection("protectedPathRules", options.edit.protectedPathRules);
  return {
    configPath,
    sourceRevision: sourceRevision(source),
    source,
    updated,
  };
}

type AuthoringGeneralCandidateOptions = {
  readonly fallback: PolicyConfig;
  readonly configPath?: string;
  /** Existing user-owned declaration key. */
  readonly profile: string;
  readonly edit: Pick<ProfileAuthoringDraft, "name"> & {
    readonly emoji?: ProfileAuthoringDraft["definition"]["emoji"];
  };
};
type PreparedAuthoringGeneralCandidate = {
  readonly configPath: string;
  readonly sourceRevision: string;
  readonly source: string;
  readonly updated: string;
  readonly renamed: boolean;
};

/** Validate a profile key against the grammar enforced by profiles.schema.json. */
export function validateCustomProfileName({
  name,
  existingNames,
  currentName,
}: {
  readonly name: string;
  readonly existingNames: ReadonlySet<string>;
  readonly currentName?: string;
}): void {
  if (name.length === 0 || name !== name.trim())
    throw new Error(
      "profile name must be nonempty and have no surrounding whitespace",
    );
  const prefix = reservedProfilePrefix({ name });
  if (prefix)
    throw new Error(
      `profile name '${name}' cannot begin with reserved prefix '${prefix}'`,
    );
  if (existingNames.has(name) && name !== currentName)
    throw new Error(`profile '${name}' already exists`);
}

type SourceTextEdit = {
  readonly offset: number;
  readonly length: number;
  readonly content: string;
};

function propertyNode(
  node: ReturnType<typeof parseTree> | undefined,
  name: string,
) {
  return node?.children?.find(
    (property) => property.children?.[0]?.value === name,
  );
}

function applySourceTextEdits(
  source: string,
  edits: readonly SourceTextEdit[],
): string {
  const ordered = [...edits].sort((left, right) => right.offset - left.offset);
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (current.offset + current.length > previous.offset)
      throw new Error("overlapping JSONC token edits");
  }
  return ordered.reduce(
    (candidate, edit) =>
      `${candidate.slice(0, edit.offset)}${edit.content}${candidate.slice(edit.offset + edit.length)}`,
    source,
  );
}

function prepareAuthoringGeneralCandidate(
  options: AuthoringGeneralCandidateOptions,
  sourceOverride?: string,
): PreparedAuthoringGeneralCandidate {
  const configPath = resolveProfileConfigPath(options.configPath);
  const source = sourceOverride ?? readMutationSource(configPath);
  const parsed: unknown = parse(source, [], { allowTrailingComma: true });
  if (!isMutationDocument(parsed))
    throw new ProfileConfigLoadError(
      configPath,
      "configuration must contain a profiles object",
    );
  try {
    validateCustomProfileName({
      name: options.edit.name,
      existingNames: new Set(Object.keys(parsed.profiles)),
      currentName: options.profile,
    });
  } catch (error) {
    throw new ProfileConfigLoadError(
      configPath,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (
    !Object.hasOwn(parsed.profiles, options.profile) ||
    isBuiltinProfileName({ name: options.profile })
  )
    throw new ProfileConfigLoadError(
      configPath,
      `profile '${options.profile}' does not exist`,
    );

  const root = parseTree(source, [], { allowTrailingComma: true });
  const profilesProperties = (root?.children ?? []).filter(
    (property) => property.children?.[0]?.value === "profiles",
  );
  const profilesProperty = profilesProperties[0];
  const profilesNode = profilesProperty?.children?.[1];
  const declarations = (profilesNode?.children ?? []).filter(
    (property) => property.children?.[0]?.value === options.profile,
  );
  const declaration = declarations[0];
  const key = declaration?.children?.[0];
  const definition = declaration?.children?.[1];
  if (
    profilesProperties.length !== 1 ||
    profilesNode?.type !== "object" ||
    declarations.length !== 1 ||
    key?.type !== "string" ||
    definition?.type !== "object"
  )
    throw new ProfileConfigMalformedError(
      configPath,
      `profile '${options.profile}' has no editable JSONC declaration`,
    );

  const edits: SourceTextEdit[] = [];
  if (options.edit.name !== options.profile)
    edits.push({
      offset: key.offset,
      length: key.length,
      content: JSON.stringify(options.edit.name),
    });
  const defaultProfile = propertyNode(root, "defaultProfile")?.children?.[1];
  if (
    defaultProfile?.type === "string" &&
    defaultProfile.value === options.profile
  )
    edits.push({
      offset: defaultProfile.offset,
      length: defaultProfile.length,
      content: JSON.stringify(options.edit.name),
    });
  for (const profile of profilesNode.children ?? []) {
    const profileDefinition = profile.children?.[1];
    const extendsNode = propertyNode(profileDefinition, "extends")
      ?.children?.[1];
    if (extendsNode?.type !== "array") continue;
    for (const parent of extendsNode.children ?? [])
      if (parent.type === "string" && parent.value === options.profile)
        edits.push({
          offset: parent.offset,
          length: parent.length,
          content: JSON.stringify(options.edit.name),
        });
  }
  let updated = applySourceTextEdits(source, edits);
  const existingDefinition = parsed.profiles[options.profile];
  if (!isRecord(existingDefinition))
    throw new ProfileConfigMalformedError(
      configPath,
      `profile '${options.profile}' is not an object`,
    );
  const existingEmoji = existingDefinition.emoji;
  if (existingEmoji !== options.edit.emoji)
    updated = applyEdits(
      updated,
      modify(
        updated,
        ["profiles", options.edit.name, "emoji"],
        options.edit.emoji,
        {
          formattingOptions: jsoncFormatting,
        },
      ),
    );
  return {
    configPath,
    sourceRevision: sourceRevision(source),
    source,
    updated,
    renamed: options.edit.name !== options.profile,
  };
}

export type ProfileAuthoringCommitOptions = {
  readonly fallback: PolicyConfig;
  readonly draft: ProfileAuthoringDraft;
  readonly configPath?: string;
  readonly expectedRevision?: string;
};

export type PreparedProfileAuthoringCommit = {
  readonly configPath: string;
  readonly sourceRevision: string;
  readonly source: string;
  readonly updated: string;
  readonly profile: string;
  readonly promptFile: PromptFileValidation | undefined;
  readonly resolvedConfig: PolicyConfig;
};

function ruleSectionFromDefinition<T>({
  value,
}: {
  readonly value: T | undefined;
}): RuleSectionEdit<T> {
  return value === undefined ? { mode: "omit" } : { mode: "set", value };
}

function authoringDeclarationEdit({
  definition,
}: {
  readonly definition: ProfileAuthoringDraft["definition"];
}): AuthoringDeclarationEdit {
  return {
    sandbox: decodeSandboxAuthoring({ raw: definition.sandbox }),
    directoryGlobs:
      definition.directoryGlobs === undefined
        ? { mode: "omit" }
        : { mode: "set", value: definition.directoryGlobs },
    bash: ruleSectionFromDefinition({ value: definition.tools?.bash }),
    readPaths: ruleSectionFromDefinition({ value: definition.readPaths }),
    writePaths: ruleSectionFromDefinition({ value: definition.writePaths }),
    protectedPathRules: ruleSectionFromDefinition({
      value: definition.protectedPathRules,
    }),
  };
}

function authoringRuleIdentities({
  definition,
}: {
  readonly definition: ProfileAuthoringDraft["definition"];
}): readonly ProfileRuleIdentity[] {
  return [
    ...(definition.tools?.bash ?? []).map((rule) => ({
      kind: "bash" as const,
      pattern: rule.pattern,
    })),
    ...(definition.readPaths ?? []).map((rule) => ({
      kind: "read" as const,
      pattern: rule.pattern,
      contexts: rule.contexts,
    })),
    ...(definition.writePaths ?? []).map((rule) => ({
      kind: "write" as const,
      pattern: rule.pattern,
      contexts: rule.contexts,
    })),
    ...(definition.protectedPathRules ?? []).map((rule) => ({
      kind: "protected" as const,
      pattern: rule.pattern,
    })),
  ];
}

function ruleSection({
  kind,
}: {
  readonly kind: RuleKind;
}): Extract<
  ProfileAuthoringSectionId,
  "bash" | "read" | "write" | "protected"
> {
  return kind;
}

function profileRuleIdentityIssues({
  definition,
}: {
  readonly definition: ProfileAuthoringDraft["definition"];
}): readonly ProfileAuthoringValidationIssue[] {
  const prior = new Map<string, Array<Set<string> | undefined>>();
  const issues: ProfileAuthoringValidationIssue[] = [];
  for (const rule of authoringRuleIdentities({ definition })) {
    if (rule.contexts !== undefined && rule.contexts.length === 0) {
      issues.push({
        section: ruleSection({ kind: rule.kind }),
        code: "invalid-rule",
        message: `contexts for '${rule.pattern}' must not be empty`,
      });
      continue;
    }
    const normalized =
      rule.contexts === undefined
        ? undefined
        : new Set(rule.contexts.map(String));
    const key = `${rule.kind}\0${rule.pattern}`;
    const existing = prior.get(key) ?? [];
    if (
      existing.some(
        (contexts) =>
          contexts === undefined ||
          normalized === undefined ||
          [...contexts].some((context) => normalized.has(context)),
      )
    )
      issues.push({
        section: ruleSection({ kind: rule.kind }),
        code: "overlapping-rules",
        message: `overlapping ${rule.kind} rules '${rule.pattern}'`,
      });
    existing.push(normalized);
    prior.set(key, existing);
  }
  return issues;
}

function profileDefinitionFromDocument({
  source,
  profile,
  configPath,
}: {
  readonly source: string;
  readonly profile: string;
  readonly configPath: string;
}): Record<string, unknown> {
  const document: unknown = parse(source, [], { allowTrailingComma: true });
  if (!isMutationDocument(document))
    throw new ProfileConfigLoadError(
      configPath,
      "configuration must contain a profiles object",
    );
  const definition = document.profiles[profile];
  if (!isRecord(definition))
    throw new ProfileConfigLoadError(
      configPath,
      `profile '${profile}' does not exist`,
    );
  return definition;
}

function applyProfileScalarEdit({
  source,
  profile,
  key,
  value,
  configPath,
}: {
  readonly source: string;
  readonly profile: string;
  readonly key: "description" | "promptFile" | "color";
  readonly value: unknown;
  readonly configPath: string;
}): string {
  const definition = profileDefinitionFromDocument({
    source,
    profile,
    configPath,
  });
  return JSON.stringify(definition[key]) === JSON.stringify(value)
    ? source
    : applyEdits(
        source,
        modify(source, ["profiles", profile, key], value, {
          formattingOptions: jsoncFormatting,
        }),
      );
}

function applyProfileStringArrayEdit({
  source,
  profile,
  key,
  value,
  configPath,
}: {
  readonly source: string;
  readonly profile: string;
  readonly key: "extends" | "transforms";
  readonly value: readonly string[] | undefined;
  readonly configPath: string;
}): string {
  const definition = profileDefinitionFromDocument({
    source,
    profile,
    configPath,
  });
  const existing = definition[key];
  if (existing === undefined && value === undefined) return source;
  if (
    existing !== undefined &&
    (!Array.isArray(existing) ||
      !existing.every((entry) => typeof entry === "string"))
  )
    throw new ProfileConfigLoadError(
      configPath,
      `${key} must be an array of strings`,
    );
  if (!Array.isArray(existing) || value === undefined)
    return applyEdits(
      source,
      modify(source, ["profiles", profile, key], value, {
        formattingOptions: jsoncFormatting,
      }),
    );
  if (
    existing.length === value.length &&
    existing.every((entry, index) => entry === value[index])
  )
    return source;
  return applyDirectoryGlobArrayEdit(
    source,
    ["profiles", profile, key],
    existing,
    value,
  );
}

function profileSectionFromInstancePath({
  instancePath,
}: {
  readonly instancePath: string;
}): ProfileAuthoringSectionId {
  const segments = instancePath
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (segments[0] !== "profiles" || segments.length < 3) return "general";
  const field = segments[2];
  if (field === "promptFile") return "prompt";
  if (field === "extends") return "composition";
  if (field === "transforms") return "transforms";
  if (field === "tools" && segments[3] === "bash") return "bash";
  if (field === "readPaths") return "read";
  if (field === "writePaths") return "write";
  if (field === "protectedPathRules") return "protected";
  if (field === "sandbox") return "sandbox";
  if (field === "directoryGlobs") return "directoryGlobs";
  return "general";
}

function issueCodeForSection({
  section,
}: {
  readonly section: ProfileAuthoringSectionId;
}): ProfileAuthoringValidationIssueCode {
  const codes = {
    general: "invalid-profile",
    prompt: "invalid-prompt-file",
    composition: "invalid-composition",
    transforms: "invalid-transforms",
    bash: "invalid-rule",
    read: "invalid-rule",
    write: "invalid-rule",
    protected: "invalid-rule",
    sandbox: "invalid-sandbox",
    directoryGlobs: "invalid-directory-globs",
  } as const satisfies Record<
    ProfileAuthoringSectionId,
    ProfileAuthoringValidationIssueCode
  >;
  return codes[section];
}

function orderedUniqueAuthoringIssues({
  issues,
}: {
  readonly issues: readonly ProfileAuthoringValidationIssue[];
}): readonly ProfileAuthoringValidationIssue[] {
  const seen = new Set<string>();
  return profileAuthoringSectionIds.flatMap((section) =>
    issues.filter((issue) => {
      if (issue.section !== section) return false;
      const identity = `${issue.section}\0${issue.code}\0${issue.message}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    }),
  );
}

function throwAuthoringIssues({
  configPath,
  issues,
}: {
  readonly configPath: string;
  readonly issues: readonly ProfileAuthoringValidationIssue[];
}): never {
  throw new ProfileAuthoringValidationError({
    configPath,
    issues: orderedUniqueAuthoringIssues({ issues }),
  });
}

/** Prepare one exact raw CREATE/EDIT candidate without durable side effects. */
export function validateProfileAuthoringCommit({
  fallback,
  draft,
  configPath: requestedConfigPath,
}: ProfileAuthoringCommitOptions): PreparedProfileAuthoringCommit {
  const configPath = resolveProfileConfigPath(requestedConfigPath);
  const source = readMutationSource(configPath);
  const parsed: unknown = parse(source, [], { allowTrailingComma: true });
  if (!isMutationDocument(parsed))
    throw new ProfileConfigLoadError(
      configPath,
      "configuration must contain a profiles object",
    );
  const issues: ProfileAuthoringValidationIssue[] = [
    ...profileRuleIdentityIssues({ definition: draft.definition }),
  ];
  try {
    validateCustomProfileName({
      name: draft.name,
      existingNames: new Set(Object.keys(parsed.profiles)),
      currentName: draft.mode === "edit" ? draft.originalName : undefined,
    });
  } catch (error) {
    const collision =
      Object.hasOwn(parsed.profiles, draft.name) &&
      (draft.mode !== "edit" || draft.name !== draft.originalName);
    issues.push({
      section: "general",
      code: collision ? "profile-exists" : "invalid-name",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (draft.definition.directoryGlobs !== undefined) {
    const validation = validateDirectoryGlobs(draft.definition.directoryGlobs);
    if (!validation.valid)
      issues.push({
        section: "directoryGlobs",
        code: "invalid-directory-globs",
        message: `${validation.message} (${validation.code})`,
      });
  }
  let promptFile: PromptFileValidation | undefined;
  if (typeof draft.definition.promptFile === "string") {
    try {
      promptFile = validatePromptFile({
        profile: draft.name,
        declaredPath: draft.definition.promptFile,
        allowMissing: true,
      });
    } catch (error) {
      issues.push({
        section: "prompt",
        code: "invalid-prompt-file",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (issues.length > 0) throwAuthoringIssues({ configPath, issues });

  let updated = source;
  let profile = draft.name;
  if (draft.mode === "create") {
    if (Object.hasOwn(parsed.profiles, draft.name))
      throw new ProfileConfigLoadError(
        configPath,
        `profile '${draft.name}' already exists`,
      );
    updated = applyEdits(
      updated,
      modify(updated, ["profiles", draft.name], draft.definition, {
        formattingOptions: jsoncFormatting,
      }),
    );
  } else {
    const renamed = prepareAuthoringGeneralCandidate(
      {
        fallback,
        configPath,
        profile: draft.originalName,
        edit: { name: draft.name, emoji: draft.definition.emoji },
      },
      updated,
    );
    updated = renamed.updated;
    profile = draft.name;
    updated = applyProfileScalarEdit({
      source: updated,
      profile,
      key: "description",
      value: draft.definition.description,
      configPath,
    });
    updated = applyProfileScalarEdit({
      source: updated,
      profile,
      key: "promptFile",
      value: draft.definition.promptFile,
      configPath,
    });
    updated = applyProfileScalarEdit({
      source: updated,
      profile,
      key: "color",
      value: draft.definition.color,
      configPath,
    });
    updated = applyProfileStringArrayEdit({
      source: updated,
      profile,
      key: "extends",
      value: draft.definition.extends,
      configPath,
    });
    updated = applyProfileStringArrayEdit({
      source: updated,
      profile,
      key: "transforms",
      value: draft.definition.transforms,
      configPath,
    });
    updated = prepareAuthoringDeclarationCandidate(
      {
        fallback,
        configPath,
        profile,
        edit: authoringDeclarationEdit({ definition: draft.definition }),
      },
      updated,
    ).updated;
  }

  const candidateDocument: unknown = parse(updated, [], {
    allowTrailingComma: true,
  });
  for (const error of Value.Errors(
    profileConfigFileSchema,
    candidateDocument,
  )) {
    const section = profileSectionFromInstancePath({
      instancePath: error.instancePath,
    });
    issues.push({
      section,
      code: issueCodeForSection({ section }),
      message: `schema validation failed at ${error.instancePath || "/"}: ${error.message}`,
    });
  }
  if (issues.length > 0) throwAuthoringIssues({ configPath, issues });

  let resolvedConfig: PolicyConfig;
  try {
    resolvedConfig = loadProfileConfigSource(fallback, configPath, updated);
  } catch (error) {
    if (!(error instanceof ProfileConfigLoadError) || !error.instancePath)
      throw error;
    const section = profileSectionFromInstancePath({
      instancePath: error.instancePath,
    });
    throwAuthoringIssues({
      configPath,
      issues: [
        {
          section,
          code: issueCodeForSection({ section }),
          message: error.details,
        },
      ],
    });
  }
  return {
    configPath,
    sourceRevision: sourceRevision(source),
    source,
    updated,
    profile,
    promptFile,
    resolvedConfig,
  };
}

/** Commit the shared raw draft with one config replacement and prompt rollback. */
export function applyProfileAuthoringCommit(
  options: ProfileAuthoringCommitOptions,
): PreparedProfileAuthoringCommit {
  const prepared = validateProfileAuthoringCommit(options);
  if (
    options.expectedRevision !== undefined &&
    options.expectedRevision !== prepared.sourceRevision
  )
    throw new ProfileConfigConflictError(prepared.configPath);
  if (prepared.updated === prepared.source) return prepared;
  const created = prepared.promptFile
    ? createMissingPromptFile({
        validation: prepared.promptFile,
        profile: prepared.profile,
      })
    : undefined;
  try {
    atomicallyWriteProfileConfig(
      prepared.configPath,
      prepared.updated,
      options.expectedRevision ?? prepared.sourceRevision,
    );
  } catch (error) {
    rollbackCreatedPromptFile({ created });
    throw error;
  }
  return prepared;
}

/**
 * Update directory declarations element-wise. As with rules, identical rows
 * are left as their original JSONC syntax nodes so neighboring comments stay
 * attached when a glob is changed, removed, or inserted.
 */
function longestCommonSubsequence<T>(
  before: readonly T[],
  after: readonly T[],
  equal: (left: T, right: T) => boolean,
): ReadonlyMap<number, number> {
  const lengths = Array.from({ length: before.length + 1 }, () =>
    Array<number>(after.length + 1).fill(0),
  );
  for (let left = before.length - 1; left >= 0; left--)
    for (let right = after.length - 1; right >= 0; right--)
      lengths[left][right] = equal(before[left], after[right])
        ? lengths[left + 1][right + 1] + 1
        : Math.max(lengths[left + 1][right], lengths[left][right + 1]);
  const matches = new Map<number, number>();
  for (let left = 0, right = 0; left < before.length && right < after.length;) {
    if (equal(before[left], after[right])) {
      matches.set(right++, left++);
    } else if (lengths[left + 1][right] >= lengths[left][right + 1]) left++;
    else right++;
  }
  return matches;
}

/**
 * Rebuild an array in candidate order, preserving only LCS-matched source
 * nodes. Insertions/deletions move retained JSONC syntax (and its comments)
 * rather than pairing unrelated old indexes with candidate values.
 */
function insertArrayValue(
  source: string,
  location: readonly (string | number)[],
  index: number,
  value: unknown,
): string {
  let node = parseTree(source, [], { allowTrailingComma: true });
  for (const segment of location) {
    if (typeof segment === "number") node = node?.children?.[segment];
    else {
      const property = node?.children?.find(
        (child) => child.children?.[0]?.value === segment,
      );
      node = property?.children?.[1];
    }
  }
  const child = node?.children?.[index];
  if (!child)
    return applyEdits(
      source,
      modify(source, [...location, index], value, {
        formattingOptions: jsoncFormatting,
      }),
    );
  const lineStart = source.lastIndexOf("\n", child.offset) + 1;
  const indentation =
    source.slice(lineStart, child.offset).match(/^\s*/u)?.[0] ?? "";
  const serialized = JSON.stringify(value, undefined, 2).replace(
    /\n/g,
    `\n${indentation}`,
  );
  return `${source.slice(0, child.offset)}${serialized},\n${indentation}${source.slice(child.offset)}`;
}

function removeArrayValue(
  source: string,
  location: readonly (string | number)[],
  index: number,
): string {
  let node = parseTree(source, [], { allowTrailingComma: true });
  for (const segment of location) {
    if (typeof segment === "number") node = node?.children?.[segment];
    else {
      const property = node?.children?.find(
        (child) => child.children?.[0]?.value === segment,
      );
      node = property?.children?.[1];
    }
  }
  const child = node?.children?.[index];
  if (!child) return source;
  let end = child.offset + child.length;
  // Remove the following delimiter for middle entries. For the final entry,
  // leave a permitted trailing comma so comments before it remain untouched.
  const comma = source.slice(end).match(/^\s*,/u);
  if (comma && index < (node?.children?.length ?? 0) - 1)
    end += comma[0].length;
  return `${source.slice(0, child.offset)}${source.slice(end)}`;
}

function applyOrderedArrayEdit<T>(
  source: string,
  location: readonly (string | number)[],
  before: readonly T[],
  after: readonly T[],
  equal: (left: T, right: T) => boolean,
): string {
  const retained = longestCommonSubsequence(before, after, equal);
  let updated = source;
  let sourceIndex = 0;
  let outputIndex = 0;
  for (const [afterIndex, value] of after.entries()) {
    const retainedSourceIndex = retained.get(afterIndex);
    if (retainedSourceIndex === undefined) {
      updated = insertArrayValue(updated, location, outputIndex, value);
      outputIndex++;
      continue;
    }
    while (sourceIndex < retainedSourceIndex) {
      updated = removeArrayValue(updated, location, outputIndex);
      sourceIndex++;
    }
    sourceIndex++;
    outputIndex++;
  }
  while (sourceIndex < before.length) {
    updated = removeArrayValue(updated, location, outputIndex);
    sourceIndex++;
  }
  return updated;
}

function applyDirectoryGlobArrayEdit(
  source: string,
  location: readonly (string | number)[],
  before: readonly string[],
  after: readonly string[],
): string {
  return applyOrderedArrayEdit(
    source,
    location,
    before,
    after,
    (left, right) => left === right,
  );
}

function removeRuleIdentity(
  rules: Array<Record<string, unknown>>,
  pattern: string,
  contexts: readonly PathContext[] | undefined,
  unscopedKind: boolean,
): Array<Record<string, unknown>> {
  if (unscopedKind || contexts === undefined)
    return rules.filter(
      (rule) => rule.pattern !== pattern || Array.isArray(rule.contexts),
    );
  const removedContexts = new Set(contexts.map(String));
  const retained: Array<Record<string, unknown>> = [];
  for (const existing of rules) {
    if (existing.pattern !== pattern) {
      retained.push(existing);
      continue;
    }
    const old = Array.isArray(existing.contexts)
      ? existing.contexts.map(String)
      : [];
    if (old.length === 0) {
      retained.push(existing);
      continue;
    }
    const remaining = old.filter((context) => !removedContexts.has(context));
    if (remaining.length > 0)
      retained.push({ ...existing, contexts: remaining });
  }
  return retained;
}

/**
 * Apply only the changed array elements. Replacing the whole array with
 * jsonc-parser would discard comments attached to otherwise unchanged rules.
 */
function canonicalRuleSerialization(rule: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(rule).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function applyRuleArrayEdit(
  source: string,
  location: readonly (string | number)[],
  before: readonly Record<string, unknown>[],
  after: readonly Record<string, unknown>[],
): string {
  return applyOrderedArrayEdit(
    source,
    location,
    before,
    after,
    (left, right) =>
      canonicalRuleSerialization(left) === canonicalRuleSerialization(right),
  );
}

type PreparedProfileRuleChanges = {
  readonly configPath: string;
  readonly sourceRevision: string;
  readonly source: string;
  readonly updated: string;
};

/** Build and validate the mutation input before any durable write occurs. */
function prepareProfileRuleChanges(
  options: ApplyProfileRuleChangesOptions,
): PreparedProfileRuleChanges {
  const configPath = resolveProfileConfigPath(options.configPath);
  if (options.changes.length === 0)
    throw new ProfileConfigLoadError(
      configPath,
      "at least one rule or metadata change is required",
    );
  for (const change of options.changes) {
    if (
      (change.kind === "bash" || change.kind === "protected") &&
      Object.hasOwn(change, "contexts") &&
      Reflect.get(change, "contexts") !== undefined
    )
      throw new ProfileConfigLoadError(
        configPath,
        `contexts are not valid for ${change.kind}`,
      );
  }
  assertUnambiguousProfileRuleChanges({
    changes: options.changes,
    configPath,
  });
  for (const change of options.changes)
    if (change.decision !== "allow" && change.decision !== "deny")
      throw new ProfileConfigLoadError(
        configPath,
        `invalid durable decision '${String(change.decision)}' for '${change.pattern}'`,
      );
  const source = readMutationSource(configPath);
  const parsed: unknown = parse(source, [], { allowTrailingComma: true });
  if (!isMutationDocument(parsed))
    throw new ProfileConfigLoadError(
      configPath,
      "configuration must contain a profiles object",
    );
  const targetExists = Object.hasOwn(parsed.profiles, options.target.profile);
  if (options.target.mode === "update" && !targetExists)
    throw new ProfileConfigLoadError(
      configPath,
      `profile '${options.target.profile}' does not exist`,
    );
  if (options.target.mode === "create-child" && targetExists)
    throw new ProfileConfigLoadError(
      configPath,
      `profile '${options.target.profile}' already exists`,
    );

  const profilePath = ["profiles", options.target.profile];
  let updated = source;
  if (options.target.mode === "create-child") {
    if (options.target.extends.length === 0)
      throw new ProfileConfigLoadError(
        configPath,
        "create targets require at least one extends target",
      );
    const child: ProfileConfigProfile = {
      description: options.target.description,
      extends: [...options.target.extends],
    };
    if (options.target.emoji !== undefined) child.emoji = options.target.emoji;
    if (options.target.color !== undefined) child.color = options.target.color;
    updated = applyEdits(
      updated,
      modify(updated, profilePath, child, {
        formattingOptions: jsoncFormatting,
      }),
    );
  }
  const document: unknown = parse(updated, [], { allowTrailingComma: true });
  const locationFor = (kind: RuleKind): Array<string | number> =>
    kind === "bash"
      ? [...profilePath, "tools", "bash"]
      : kind === "protected"
        ? [...profilePath, "protectedPathRules"]
        : [...profilePath, kind === "read" ? "readPaths" : "writePaths"];
  const collections = new Map<
    string,
    {
      location: Array<string | number>;
      before: Array<Record<string, unknown>>;
      after: Array<Record<string, unknown>>;
    }
  >();
  const collectionFor = (kind: RuleKind) => {
    const location = locationFor(kind);
    const key = JSON.stringify(location);
    const known = collections.get(key);
    if (known) return known;
    const current = location.reduce<unknown>(
      (value, segment) =>
        typeof value === "object" && value !== null
          ? Reflect.get(value, segment)
          : undefined,
      document,
    );
    const before: Array<Record<string, unknown>> = [];
    if (Array.isArray(current)) {
      const items: unknown[] = current;
      for (const item of items) {
        if (typeof item !== "object" || item === null || Array.isArray(item))
          continue;
        const record: Record<string, unknown> = {};
        for (const key of Object.keys(item))
          record[key] = Reflect.get(item, key);
        before.push(record);
      }
    }
    const collection = { location, before, after: [...before] };
    collections.set(key, collection);
    return collection;
  };

  // Build every collection's final state in memory before touching JSONC.
  // This keeps pattern swaps independent of submitted row order and lets each
  // array be edited exactly once, preserving unchanged syntax nodes.
  for (const change of options.changes) {
    if (!change.replacePattern || change.replacePattern === change.pattern)
      continue;
    const collection = collectionFor(change.kind);
    collection.after = removeRuleIdentity(
      collection.after,
      change.replacePattern,
      change.contexts,
      change.kind === "bash" || change.kind === "protected",
    );
  }
  for (const change of options.changes) {
    const collection = collectionFor(change.kind);
    const unscopedKind = change.kind === "bash" || change.kind === "protected";
    collection.after = removeRuleIdentity(
      collection.after,
      change.pattern,
      change.contexts,
      unscopedKind,
    );
    const rule: Record<string, unknown> = {
      pattern: change.pattern,
      decision: change.decision,
    };
    if (change.guidance !== undefined) rule.guidance = change.guidance;
    if (!unscopedKind && change.contexts !== undefined)
      rule.contexts = [...new Set(change.contexts)];
    collection.after.push(rule);
  }
  for (const { location, before, after } of collections.values())
    updated = applyRuleArrayEdit(updated, location, before, after);
  // Validate even a byte-identical candidate. An invalid existing source must
  // never be reported as a successful no-op authoring operation.
  return {
    configPath,
    sourceRevision: sourceRevision(source),
    source,
    updated,
  };
}

function commitPreparedProfileRuleChanges(
  fallback: PolicyConfig,
  prepared: PreparedProfileRuleChanges,
  expectedRevision?: string,
): void {
  // Validate before opening a temporary file; this is the same core used by
  // Declaration edits use the same validation-before-write invariant.
  loadProfileConfigSource(fallback, prepared.configPath, prepared.updated);
  if (
    expectedRevision !== undefined &&
    expectedRevision !== prepared.sourceRevision
  )
    throw new ProfileConfigConflictError(prepared.configPath);
  if (prepared.updated === prepared.source) return;
  atomicallyWriteProfileConfig(
    prepared.configPath,
    prepared.updated,
    expectedRevision ?? prepared.sourceRevision,
  );
}

/** Apply a set of rule changes in one validated, atomic mutation. */
export function applyProfileRuleChanges(
  options: ApplyProfileRuleChangesOptions,
): void {
  commitPreparedProfileRuleChanges(
    options.fallback,
    prepareProfileRuleChanges(options),
    options.expectedRevision,
  );
}
