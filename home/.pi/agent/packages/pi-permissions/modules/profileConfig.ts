import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { Value } from "typebox/value";
import {
  assertPolicyConfig,
  extendProfile,
  profileConfigFileSchema,
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

    const validationError = Value.Errors(profileConfigFileSchema, parsed)[0];
    if (validationError) {
      throwProfileConfigError(
        configPath,
        `schema validation failed at ${validationError.instancePath || "/"}: ${validationError.message}`,
      );
    }

    const profileFile = parsed as ProfileConfigFile;

    const profiles: Record<string, ProfilePolicy> = {
      ...fallback.profiles,
    };
    const resolving = new Set<string>();

    const resolveProfile = (name: string): ProfilePolicy => {
      if (profiles[name]) return profiles[name];
      const definition = profileFile.profiles[name];
      if (!definition) {
        throwProfileConfigError(
          configPath,
          `/profiles/${name}/extends: unknown inherited profile '${name}'`,
        );
      }
      if (resolving.has(name)) {
        throwProfileConfigError(
          configPath,
          `/profiles/${name}/extends: cyclic profile inheritance detected`,
        );
      }
      resolving.add(name);

      const { extends: inheritedProfile, ...override } = definition;
      if (inheritedProfile) {
        profiles[name] = extendProfile(
          resolveProfile(inheritedProfile),
          override,
        );
      } else {
        profiles[name] = override as ProfilePolicy;
      }
      resolving.delete(name);
      return profiles[name];
    };

    for (const name of Object.keys(profileFile.profiles)) resolveProfile(name);

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
    return config;
  } catch (error) {
    if (error instanceof ProfileConfigLoadError) throw error;
    throwProfileConfigError(
      configPath,
      `failed to read profile config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
