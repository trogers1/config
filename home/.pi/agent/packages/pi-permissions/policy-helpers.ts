export type Decision = "allow" | "ask" | "deny";

export type Rule = {
  pattern: string;
  decision: Decision;
  /** Instructions automatically returned to the model when this rule denies a call. */
  guidance?: string;
  /** Concrete alternatives automatically returned to the model when this rule denies a call. */
  alternatives?: string[];
};

export type ProfilePolicy = {
  promptFile?: string | null;
  color?: ProfileColor;
  emoji?: string;
  tools: Record<string, Rule[]>;
  bashPathReferences: [Rule, ...Rule[]];
};

export type PolicyConfig<Names extends string = string> = {
  defaultProfile: Names;
  profiles: Record<Names, ProfilePolicy>;
};

export type ProfileColor =
  "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white";

export function definePolicyConfig<
  Profiles extends Record<string, ProfilePolicy>,
>(config: {
  defaultProfile: keyof Profiles & string;
  profiles: Profiles;
}): PolicyConfig<keyof Profiles & string> {
  return config;
}

export function extendProfile(
  base: ProfilePolicy,
  override: Partial<Omit<ProfilePolicy, "tools">> & {
    tools?: Record<string, Rule[]>;
  },
): ProfilePolicy {
  const mergedTools: Record<string, Rule[]> = structuredClone(base.tools);

  // Append override rules (later rules win by position).
  for (const [tool, rules] of Object.entries(override.tools ?? {})) {
    if (!rules) continue;
    if (rules.length === 0) {
      delete mergedTools[tool];
    } else {
      mergedTools[tool] = [...(mergedTools[tool] ?? []), ...rules];
    }
  }

  return {
    ...base,
    ...override,
    tools: mergedTools,
    bashPathReferences: override.bashPathReferences ?? [
      ...base.bashPathReferences,
    ],
  };
}
