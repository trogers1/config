import {
  applyPolicyTransforms,
  extendProfile,
  type ProfilePolicy,
} from "../policyHelpers";
import {
  readOnlyPathRules,
  readOnlyShellRules,
  readOnlyWritePathRules,
} from "../ruleSets.lib/index";
import { defaultProtectedPathRules } from "../protectedPaths";
import { baseProfile } from "./base";

/** The default working posture with every `ask` escalated to `deny`. */
export const workerProfile = applyPolicyTransforms(
  extendProfile(baseProfile, {
    color: "magenta",
    emoji: "⚙️",
  }),
  ["transform:deny-asks"],
);

/**
 * Read-only posture. Replaces bash with read-only shell commands and gates
 * writes to tmp/handoff/progress; not derived from baseProfile.
 */
export const readOnlyProfile: ProfilePolicy = {
  color: "green",
  emoji: "🔎",
  tools: { bash: readOnlyShellRules },
  readPaths: readOnlyPathRules,
  writePaths: readOnlyWritePathRules,
  protectedPathRules: defaultProtectedPathRules,
};
