import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadProfileConfigSnapshot } from "./profileConfig";
import { policyConfig } from "./policy";
import type { PolicyConfig } from "./policyHelpers";

export const startupProfileFlag = {
  name: "guard-profile",
  options: {
    type: "string",
    description: "Initial pi-guard profile (switchable with /profile-select)",
  },
} satisfies {
  name: string;
  options: Parameters<ExtensionAPI["registerFlag"]>[1];
};

/** Validate the launch request against the exact snapshot adopted by the guard. */
export function resolveStartupProfile({
  profile,
  config,
  subagentProfile,
}: {
  readonly profile: ReturnType<ExtensionAPI["getFlag"]>;
  readonly config: PolicyConfig;
  readonly subagentProfile?: string;
}): string | undefined {
  if (profile === undefined) return undefined;
  if (typeof profile !== "string" || !profile || profile !== profile.trim())
    throw new Error(
      `--${startupProfileFlag.name} requires a nonempty exact profile name.`,
    );
  if (!Object.hasOwn(config.profiles, profile))
    throw new Error(
      `Unknown --${startupProfileFlag.name} '${profile}'. Available: ${Object.keys(config.profiles).join(", ")}`,
    );
  const authoritative = subagentProfile?.trim();
  if (authoritative && !Object.hasOwn(config.profiles, authoritative))
    throw new Error(
      `Invalid PI_SUBAGENT_PROFILE '${authoritative}'. Available: ${Object.keys(config.profiles).join(", ")}`,
    );
  if (authoritative && authoritative !== profile)
    throw new Error(
      `--${startupProfileFlag.name} '${profile}' conflicts with authoritative PI_SUBAGENT_PROFILE '${authoritative}'.`,
    );
  return profile;
}

/** Read-only launcher preflight. Does not load extensions, models, or sessions. */
export function validateStartupProfile({
  profile,
  configPath = process.env.PI_GUARD_PROFILE_CONFIG?.trim() || undefined,
  subagentProfile = process.env.PI_SUBAGENT_PROFILE,
}: {
  readonly profile: string;
  readonly configPath?: string;
  readonly subagentProfile?: string;
}): string {
  const { config } = loadProfileConfigSnapshot({
    fallback: policyConfig,
    configPath,
    lintConflicts: false,
  });
  const selected = resolveStartupProfile({ profile, config, subagentProfile });
  if (selected === undefined)
    throw new Error("Startup profile is required for preflight.");
  return selected;
}
