import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { Value } from "typebox/value";
import {
  applyPolicyTransforms,
  assertPolicyConfig,
  assertProfilePolicy,
  builtinProfilePrefix,
  extendProfile,
  isBuiltinProfileName,
  isReservedProfileName,
  profileConfigFileSchema,
  warnOnPolicyRuleConflicts,
  type profileTransformNames,
  type PolicyConfig,
  type ProfileConfigFile,
  type ProfilePolicy,
} from "./policyHelpers";

export class ProfileConfigLoadError extends Error {
  readonly configPath: string;
  readonly details: string;

  constructor(configPath: string, details: string) {
    super(`Invalid pi-permissions profile config at ${configPath}: ${details}`);
    this.name = "ProfileConfigLoadError";
    Object.setPrototypeOf(this, new.target.prototype);
    this.configPath = configPath;
    this.details = details;
  }
}

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

function isProfileConfigFile(value: unknown): value is ProfileConfigFile {
  return Value.Check(profileConfigFileSchema, value);
}

/**
 * Read user-owned profile data synchronously. Configuration is deliberately
 * JSON-only: loading it must not execute code or delay Pi's startup lifecycle.
 */
export function loadProfileConfig(
  fallback: PolicyConfig,
  configPath = defaultProfileConfigPath,
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
        if (!isReservedProfileName(name)) continue;
        const reservedPrefix = isBuiltinProfileName(name)
          ? builtinProfilePrefix
          : "transform:";
        throwProfileConfigError(
          configPath,
          `/profiles/${name}: reserved profile name '${name}' begins with '${reservedPrefix}'`,
        );
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

    const resolvedUsers: Record<string, ProfilePolicy> = {};
    const resolving = new Set<string>();

    const applyTransforms = (
      policy: ProfilePolicy,
      transforms: readonly (typeof profileTransformNames)[number][] | undefined,
    ): ProfilePolicy => {
      if (!transforms || transforms.length === 0) return policy;
      return applyPolicyTransforms(policy, transforms);
    };

    const resolveProfile = (
      target: string,
      referrer: string = target,
    ): ProfilePolicy => {
      if (target.startsWith("transform:")) {
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

      if (resolvedUsers[target]) return resolvedUsers[target];

      const definition = userDefinitions[target];
      if (!definition) {
        const available = [
          ...Object.keys(builtins),
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
      let resolved: ProfilePolicy;
      if (parents.length === 0) {
        assertProfilePolicy(override);
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
      resolvedUsers[target] = resolved;
      resolving.delete(target);
      return resolvedUsers[target];
    };

    for (const name of Object.keys(userDefinitions)) resolveProfile(name);

    const profiles: Record<string, ProfilePolicy> = {
      ...builtins,
      ...resolvedUsers,
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
    warnOnPolicyRuleConflicts({ profiles: resolvedUsers });
    return config;
  } catch (error) {
    if (error instanceof ProfileConfigLoadError) throw error;
    throwProfileConfigError(
      configPath,
      `failed to read profile config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
