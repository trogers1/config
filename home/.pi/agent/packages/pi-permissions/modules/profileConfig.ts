import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import {
  assertPolicyConfig,
  extendProfile,
  profileConfigFileSchema,
  type PolicyConfig,
  type ProfilePolicy,
} from "./policyHelpers";

const defaultProfileConfigPath = path.join(
  homedir(),
  ".pi",
  "agent",
  "permissions",
  "profiles.jsonc",
);

type ProfileConfigFile = Static<typeof profileConfigFileSchema>;

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
    if (errors.length > 0)
      throw new Error(
        errors.map((error) => printParseErrorCode(error.error)).join(", "),
      );
    const validationError = Value.Errors(profileConfigFileSchema, parsed)[0];
    if (validationError)
      throw new Error(
        `${validationError.instancePath || "/"}: ${validationError.message}`,
      );
    const profileFile = parsed as ProfileConfigFile;

    const profiles: Record<string, ProfilePolicy> = {
      ...fallback.profiles,
    };
    const resolving = new Set<string>();

    const resolveProfile = (name: string): ProfilePolicy => {
      if (profiles[name]) return profiles[name];
      const definition = profileFile.profiles[name];
      if (!definition) throw new Error(`unknown profile '${name}'`);
      if (resolving.has(name))
        throw new Error(`cyclic profile inheritance at '${name}'`);
      resolving.add(name);

      const { extends: inheritedProfile, ...override } = definition;
      if (inheritedProfile) {
        // JSON Schema represents non-empty tuples as arrays. The schema's
        // minItems constraints have already validated these values.
        profiles[name] = extendProfile(
          resolveProfile(inheritedProfile),
          override as Parameters<typeof extendProfile>[1],
        );
      } else {
        // Fully custom profiles must satisfy ProfilePolicy during the final
        // assertPolicyConfig call below.
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
    assertPolicyConfig(config);
    return config;
  } catch (error) {
    console.warn(
      `pi-permissions: ignoring invalid profile config '${configPath}': ${error instanceof Error ? error.message : String(error)}`,
    );
    return fallback;
  }
}
