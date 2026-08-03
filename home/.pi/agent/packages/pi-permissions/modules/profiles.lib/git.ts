import { extendProfile } from "../policyHelpers";
import { ruleSetRegistry } from "../ruleSets.lib/index";
import { baseProfile } from "./base";

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
