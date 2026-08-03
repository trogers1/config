import type { ProfilePolicy, Rule } from "../policyHelpers";
import { ruleSetRegistry, type RuleSetName } from "../ruleSets.lib/index";
import { defaultProtectedPathRules } from "../protectedPaths";

/** Bash rules composed from the named rule sets, in composition order. */
export function bashRules(...names: RuleSetName[]): Rule[] {
  return names.flatMap((name) => ruleSetRegistry[name].tools?.bash ?? []);
}

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
    bash: bashRules(
      "ruleset:shell",
      "ruleset:git",
      "ruleset:packageManagers",
      "ruleset:deps-mutations-guard",
      "ruleset:shell-guards",
    ),
  },
  readPaths: [...(ruleSetRegistry["ruleset:path-guards"].readPaths ?? [])],
  writePaths: [...(ruleSetRegistry["ruleset:path-guards"].writePaths ?? [])],
  protectedPathRules: defaultProtectedPathRules,
};
