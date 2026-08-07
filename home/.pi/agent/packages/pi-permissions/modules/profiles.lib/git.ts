import { extendProfile } from "../policyHelpers";
import { ruleSetRegistry } from "../ruleSets.lib/index";
import { baseCompositionChain, baseProfile } from "./base";

export const committerCompositionChain = [
  ...baseCompositionChain,
  "ruleset:git-commit",
  "builtin:committer",
] as const;

export const gitFullCompositionChain = [
  ...committerCompositionChain,
  "ruleset:git-refs",
  "builtin:git-full",
] as const;

/** Local git mutation tier: stage, commit, and rewrite local history. */
export const committerProfile = extendProfile(baseProfile, {
  ...ruleSetRegistry["ruleset:git-commit"],
  color: "red",
  emoji: "⚠️",
});

/** Full git control: the committer tier plus ref and remote mutation. */
export const gitFullProfile = extendProfile(committerProfile, {
  ...ruleSetRegistry["ruleset:git-refs"],
  color: "red",
  emoji: "🔥",
});
