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
  type Decision,
  type PathContext,
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
  "permissions",
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
export type CreateCustomProfileOptions = {
  fallback: PolicyConfig;
  name: string;
  description: string;
  emoji?: string;
  extends?: readonly string[];
  transforms?: readonly ProfileTransformName[];
  protectedPaths?: readonly ProtectedPathRule[];
  sandboxed?: SandboxConfig | boolean;
  configPath?: string;
};

export type AppendProfileRuleOptions = {
  fallback: PolicyConfig;
  profile: string;
  kind: "bash" | "read" | "write";
  pattern: string;
  decision: Decision;
  guidance?: string;
  contexts?: readonly PathContext[];
  configPath?: string;
};

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
  if (options.protectedPaths !== undefined)
    profile.protectedPathRules = [...options.protectedPaths];
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

/** Append a bash or path rule without coupling callers to a UI or JSONC AST. */
export function appendProfileRule(options: AppendProfileRuleOptions): void {
  const configPath = resolveProfileConfigPath(options.configPath);
  const source = readMutationSource(configPath);
  const parsed = parse(source, [], { allowTrailingComma: true }) as {
    profiles: Record<string, Record<string, unknown>>;
  };
  const profile = parsed.profiles[options.profile];
  if (!profile) {
    throw new ProfileConfigLoadError(
      configPath,
      `profile '${options.profile}' does not exist`,
    );
  }
  const rule: Record<string, unknown> = {
    pattern: options.pattern,
    decision: options.decision,
  };
  if (options.guidance !== undefined) rule.guidance = options.guidance;
  if (options.kind !== "bash" && options.contexts !== undefined)
    rule.contexts = [...options.contexts];
  const location =
    options.kind === "bash"
      ? ["profiles", options.profile, "tools", "bash"]
      : [
          "profiles",
          options.profile,
          options.kind === "read" ? "readPaths" : "writePaths",
        ];
  const existing = location.reduce<unknown>(
    (value, key) =>
      typeof value === "object" && value !== null
        ? Reflect.get(value, key)
        : undefined,
    parsed,
  );
  const rules = Array.isArray(existing)
    ? [...(existing as unknown[]), rule]
    : [rule];
  const updated = applyEdits(
    source,
    modify(source, location, rules, { formattingOptions: jsoncFormatting }),
  );
  atomicallyWriteValidatedProfileConfig(configPath, updated, options.fallback);
}
