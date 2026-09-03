import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  applyEdits,
  modify,
  parse,
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
  type PathRule,
  type PolicyConfig,
  type ProfileConfigFile,
  type ProfileConfigProfile,
  type ProfilePolicy,
  type ProfileTransformName,
  type ProtectedPathRule,
  type SandboxConfig,
} from "./policyHelpers";
import { ruleSetRegistry } from "./ruleSets.lib/index";

export class ProfileConfigLoadError extends Error {
  readonly configPath: string;
  readonly details: string;

  constructor(configPath: string, details: string) {
    super(`Invalid pi-guard profile config at ${configPath}: ${details}`);
    this.name = "ProfileConfigLoadError";
    Object.setPrototypeOf(this, new.target.prototype);
    this.configPath = configPath;
    this.details = details;
  }
}

export type RawProfileConfig = {
  defaultProfile?: string;
  rulesets?: Record<string, CustomRuleSetPolicy>;
  profiles: Record<string, ProfileConfigProfile>;
};

function throwProfileConfigError(configPath: string, details: string): never {
  throw new ProfileConfigLoadError(configPath, details);
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
    const errors: ParseError[] = [];
    const parsed: unknown = parse(fs.readFileSync(configPath, "utf8"), errors, {
      allowTrailingComma: true,
    });
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
        const prefix = reservedProfilePrefix(name);
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

    const profileFile = parsed;
    const builtins = fallback.profiles;
    const userDefinitions = profileFile.profiles;
    const customRulesets = profileFile.rulesets ?? {};

    const resolvedUsers = new Map<string, ProfilePolicy>();
    const resolving = new Set<string>();

    const applyTransforms = (
      policy: Partial<ProfilePolicy>,
      transforms: readonly ProfileTransformName[] | undefined,
    ): Partial<ProfilePolicy> => {
      if (!transforms || transforms.length === 0) return policy;
      return applyPolicyTransforms(policy, transforms);
    };

    const resolveProfile = (
      target: string,
      referrer: string = target,
    ): Partial<ProfilePolicy> => {
      if (hasPolicyReferencePrefix(target, "transform")) {
        throwProfileConfigError(
          configPath,
          `/profiles/${referrer}/extends: reserved transform name '${target}' cannot be used as a profile`,
        );
      }
      if (isBuiltinProfileName(target)) {
        const builtin = builtins[target];
        if (!builtin) {
          throwProfileConfigError(
            configPath,
            `/profiles/${referrer}/extends: unknown built-in profile '${target}'`,
          );
        }
        return builtin;
      }
      if (isShippedRuleSetName(target)) {
        return ruleSetRegistry[target];
      }
      if (hasPolicyReferencePrefix(target, "shippedRuleset")) {
        throwProfileConfigError(
          configPath,
          `/profiles/${referrer}/extends: unknown rule set '${target}'`,
        );
      }
      if (hasPolicyReferencePrefix(target, "customRuleset")) {
        const name = target.slice(
          policyReferencePrefix("customRuleset").length,
        );
        const customRuleSet = Object.hasOwn(customRulesets, name)
          ? customRulesets[name]
          : undefined;
        if (!customRuleSet) {
          throwProfileConfigError(
            configPath,
            `/profiles/${referrer}/extends: unknown custom rule set '${target}'`,
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
        const suggestion = isBuiltinProfileName(referrer)
          ? ""
          : ` Did you mean 'builtin:${target}'?`;
        throwProfileConfigError(
          configPath,
          `/profiles/${referrer}/extends: unknown inherited profile '${target}'. Available: ${available}.${suggestion}`,
        );
      }
      if (resolving.has(target)) {
        throwProfileConfigError(
          configPath,
          `/profiles/${target}/extends: cyclic profile inheritance detected`,
        );
      }
      resolving.add(target);

      const { extends: parents = [], transforms, ...override } = definition;
      let resolved: Partial<ProfilePolicy>;
      if (parents.length === 0) {
        resolved = override;
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

/** Arguments for adding a user-owned profile. */
export type BashRule = {
  pattern: string;
  decision: "allow" | "deny";
  guidance?: string;
};

export type OrdinaryPathRuleKind = "read" | "write";
export type RuleKind = OrdinaryPathRuleKind | "bash" | "protected";

export type CreateCustomProfileOptions = {
  fallback: PolicyConfig;
  name: string;
  description: string;
  emoji?: string;
  extends?: readonly string[];
  transforms?: readonly ProfileTransformName[];
  protectedPaths?: readonly ProtectedPathRule[];
  bashRules?: readonly BashRule[];
  readPathRules?: readonly PathRule[];
  writePathRules?: readonly PathRule[];
  sandboxed?: SandboxConfig | boolean;
  configPath?: string;
};

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
      extends: readonly [string];
      description: string;
      emoji: string;
    };

/** Reject duplicate/overlapping editor rows before either CREATE or ASK writes. */
export function assertUnambiguousProfileRuleChanges(
  changes: readonly ProfileRuleChange[],
  configPath = resolveProfileConfigPath(),
): void {
  const prior = new Map<string, Array<Set<string> | undefined>>();
  for (const change of changes) {
    const suppliedContexts = (change as { contexts?: unknown }).contexts;
    if (
      (change.kind === "bash" || change.kind === "protected") &&
      suppliedContexts !== undefined
    )
      throw new ProfileConfigLoadError(
        configPath,
        `contexts are not valid for ${change.kind} rule '${change.pattern}'`,
      );
    if (change.contexts !== undefined && change.contexts.length === 0)
      throw new ProfileConfigLoadError(
        configPath,
        `contexts for '${change.pattern}' must not be empty`,
      );
    const normalized =
      change.contexts === undefined
        ? undefined
        : new Set(change.contexts.map(String));
    const key = `${change.kind}\0${change.pattern}`;
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
        `overlapping rule changes '${change.pattern}'`,
      );
    existing.push(normalized);
    prior.set(key, existing);
  }
}

const jsoncFormatting = { insertSpaces: true, tabSize: 2, eol: "\n" };

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

function atomicallyWriteValidatedProfileConfig(
  configPath: string,
  source: string,
  fallback: PolicyConfig,
): void {
  const directory = path.dirname(configPath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(configPath)}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, source, { encoding: "utf8", flag: "wx" });
    loadProfileConfig(fallback, temporaryPath);
    if (fs.existsSync(configPath))
      fs.chmodSync(temporaryPath, fs.statSync(configPath).mode & 0o7777);
    fs.renameSync(temporaryPath, configPath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      /* already renamed */
    }
  }
}

/** Create a custom profile while retaining all JSONC comments and formatting. */
export function createCustomProfile(options: CreateCustomProfileOptions): void {
  const configPath = resolveProfileConfigPath(options.configPath);
  const source = readMutationSource(configPath);
  const parsed = parse(source, [], { allowTrailingComma: true }) as {
    profiles: Record<string, unknown>;
  };
  if (Object.hasOwn(parsed.profiles, options.name)) {
    throw new ProfileConfigLoadError(
      configPath,
      `profile '${options.name}' already exists`,
    );
  }
  const profile: Record<string, unknown> = {
    description: options.description,
    // Custom profiles are visually distinct from shipped blue defaults.
    color: "magenta",
  };
  if (options.emoji !== undefined) profile.emoji = options.emoji;
  if (options.extends !== undefined) profile.extends = [...options.extends];
  if (options.transforms !== undefined)
    profile.transforms = [...options.transforms];
  if (options.protectedPaths !== undefined && options.protectedPaths.length > 0)
    profile.protectedPathRules = [...options.protectedPaths];
  if (options.bashRules !== undefined && options.bashRules.length > 0)
    profile.tools = { bash: [...options.bashRules] };
  if (options.readPathRules !== undefined && options.readPathRules.length > 0)
    profile.readPaths = [...options.readPathRules];
  if (options.writePathRules !== undefined && options.writePathRules.length > 0)
    profile.writePaths = [...options.writePathRules];
  if (options.sandboxed !== undefined) {
    profile.sandbox =
      typeof options.sandboxed === "boolean"
        ? options.sandboxed
          ? { network: "deny" }
          : false
        : options.sandboxed;
  }
  const updated = applyEdits(
    source,
    modify(source, ["profiles", options.name], profile, {
      formattingOptions: jsoncFormatting,
    }),
  );
  atomicallyWriteValidatedProfileConfig(configPath, updated, options.fallback);
}

/** Options for one validated, atomic profile-rule mutation. */
export type ApplyProfileRuleChangesOptions = {
  fallback: PolicyConfig;
  configPath?: string;
  target: ProfileMutationTarget;
  changes: readonly ProfileRuleChange[];
};

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
function applyRuleArrayEdit(
  source: string,
  location: readonly (string | number)[],
  before: readonly Record<string, unknown>[],
  after: readonly Record<string, unknown>[],
): string {
  const remainingAfter = after.map((rule) => ({
    rule,
    serialized: JSON.stringify(rule),
  }));
  const retainedBefore = new Set<number>();
  for (const [index, rule] of before.entries()) {
    const match = remainingAfter.findIndex(
      (candidate) => candidate.serialized === JSON.stringify(rule),
    );
    if (match === -1) continue;
    retainedBefore.add(index);
    remainingAfter.splice(match, 1);
  }

  // Rewrite changed nodes in place before adding/removing nodes. Unchanged
  // nodes are never rewritten or shifted into another node, so their JSONC
  // comments and hand formatting remain attached to the same rule.
  let updated = source;
  const changedBefore = before
    .map((_rule, index) => index)
    .filter((index) => !retainedBefore.has(index));
  const paired = Math.min(changedBefore.length, remainingAfter.length);
  for (let index = 0; index < paired; index++) {
    updated = applyEdits(
      updated,
      modify(
        updated,
        [...location, changedBefore[index]],
        remainingAfter[index].rule,
        { formattingOptions: jsoncFormatting },
      ),
    );
  }
  for (let index = changedBefore.length - 1; index >= paired; index--) {
    updated = applyEdits(
      updated,
      modify(updated, [...location, changedBefore[index]], undefined, {
        formattingOptions: jsoncFormatting,
      }),
    );
  }

  for (const { rule } of remainingAfter.slice(paired)) {
    const current: unknown = parse(updated, [], { allowTrailingComma: true });
    const currentRules = location.reduce<unknown>(
      (value, key) =>
        typeof value === "object" && value !== null
          ? Reflect.get(value, key)
          : undefined,
      current,
    );
    const index = Array.isArray(currentRules) ? currentRules.length : 0;
    updated = applyEdits(
      updated,
      modify(updated, [...location, index], rule, {
        formattingOptions: jsoncFormatting,
      }),
    );
  }
  return updated;
}

/** Apply a set of rule changes in one validated, atomic mutation. */
export function applyProfileRuleChanges(
  options: ApplyProfileRuleChangesOptions,
): void {
  const configPath = resolveProfileConfigPath(options.configPath);
  if (options.changes.length === 0)
    throw new ProfileConfigLoadError(
      configPath,
      "at least one rule change is required",
    );
  assertUnambiguousProfileRuleChanges(options.changes, configPath);
  for (const change of options.changes)
    if (change.decision !== "allow" && change.decision !== "deny")
      throw new ProfileConfigLoadError(
        configPath,
        `invalid durable decision '${String(change.decision)}' for '${change.pattern}'`,
      );
  const source = readMutationSource(configPath);
  const parsed = parse(source, [], { allowTrailingComma: true }) as {
    profiles: Record<string, Record<string, unknown>>;
  };
  const targetProfile = parsed.profiles[options.target.profile];
  if (options.target.mode === "update" && !targetProfile)
    throw new ProfileConfigLoadError(
      configPath,
      `profile '${options.target.profile}' does not exist`,
    );
  if (options.target.mode === "create-child" && targetProfile)
    throw new ProfileConfigLoadError(
      configPath,
      `profile '${options.target.profile}' already exists`,
    );

  const profilePath = ["profiles", options.target.profile];
  let updated = source;
  if (options.target.mode === "create-child") {
    const child: Record<string, unknown> = {
      description: options.target.description,
      color: "magenta",
      emoji: options.target.emoji,
      extends: [...options.target.extends],
    };
    updated = applyEdits(
      updated,
      modify(updated, profilePath, child, {
        formattingOptions: jsoncFormatting,
      }),
    );
  }
  const document = parse(updated, [], { allowTrailingComma: true }) as {
    profiles: Record<string, Record<string, unknown>>;
  };
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
    const before = Array.isArray(current)
      ? [...(current as Array<Record<string, unknown>>)]
      : [];
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
  atomicallyWriteValidatedProfileConfig(configPath, updated, options.fallback);
}
