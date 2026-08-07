import {
  applyPolicyTransforms,
  extendProfile,
  type ProfilePolicy,
} from "../policyHelpers";
import { ruleSetRegistry } from "../ruleSets.lib/index";
import { baseCompositionChain, baseProfile } from "./base";

export const workerCompositionChain = [
  ...baseCompositionChain,
  "transform:deny-asks",
  "builtin:worker",
] as const;

export const readOnlyCompositionChain = [
  "ruleset:read-only-path",
  "ruleset:read-only-shell",
  "builtin:read-only",
] as const;

/** The default working posture with every `ask` escalated to `deny`. */
export const workerProfile = applyPolicyTransforms(
  extendProfile(baseProfile, {
    color: "magenta",
    emoji: "⚙️",
  }),
  ["transform:deny-asks"],
);

/**
 * Read-only posture. Composed entirely from the shipped read-only shell and
 * path rule sets; writes stay limited to tmp/handoff/progress.
 */
const readOnlyShellPosture = ruleSetRegistry["ruleset:read-only-shell"];
const readOnlyPathPosture = ruleSetRegistry["ruleset:read-only-path"];

export const readOnlyProfile: ProfilePolicy = {
  color: "green",
  emoji: "🔎",
  tools: readOnlyShellPosture.tools!,
  readPaths: readOnlyPathPosture.readPaths!,
  writePaths: readOnlyPathPosture.writePaths!,
  protectedPathRules: readOnlyPathPosture.protectedPathRules!,
};
