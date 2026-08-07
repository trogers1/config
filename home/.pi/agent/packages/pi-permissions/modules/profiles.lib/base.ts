import type { ProfilePolicy, Rule } from "../policyHelpers";
import { ruleSetRegistry, type RuleSetName } from "../ruleSets.lib/index";

/** Bash rules composed from the named rule sets, in composition order. */
export function bashRules(...names: RuleSetName[]): Rule[] {
  return names.flatMap((name) => ruleSetRegistry[name].tools?.bash ?? []);
}

// This is both the construction recipe and the provenance source for the
// standard posture: the explainer cannot drift from its composed inputs.
const baseRuleSetNames = [
  "ruleset:shell",
  "ruleset:git",
  "ruleset:packageManagers",
  "ruleset:deps-mutations-guard",
  "ruleset:shell-guards",
  "ruleset:path-guards",
] as const;

export const baseCompositionChain = [
  ...baseRuleSetNames,
  "builtin:default",
] as const;

/**
 * The standard posture every permissive profile derives from. Composed
 * entirely from rule sets: read-mostly shell/git/package-manager rules,
 * dependency-mutation guards, destructive shell guards, and path guards.
 */
export const baseProfile: ProfilePolicy = {
  color: "blue",
  emoji: "🛠️",
  // No promptFile means: keep Pi's normal system prompt unchanged.
  // Tool policies resolve by specificity first; composition order only breaks ties.
  // For bash, patterns match normalized command segments.
  // For path-based tools, patterns match paths relative to pi's startup directory.
  // Outside paths appear as ../..., so use ../** to gate external access.
  tools: {
    bash: bashRules(...baseRuleSetNames),
  },
  readPaths: [...(ruleSetRegistry["ruleset:path-guards"].readPaths ?? [])],
  writePaths: [...(ruleSetRegistry["ruleset:path-guards"].writePaths ?? [])],
  protectedPathRules: [
    ...(ruleSetRegistry["ruleset:path-guards"].protectedPathRules ?? []),
  ],
};
