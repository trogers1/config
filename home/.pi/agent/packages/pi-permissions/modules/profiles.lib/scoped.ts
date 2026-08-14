import type { ProfilePolicy } from "../policyHelpers";
import { extendProfile } from "../policyHelpers";
import { ruleSetRegistry } from "../ruleSets.lib/index";
import { baseCompositionChain, baseProfile, bashRules } from "./base";
import { readOnlyCompositionChain, readOnlyProfile } from "./core";

export const reviewerCompositionChain = [
  ...readOnlyCompositionChain,
  "ruleset:test-run",
  "builtin:reviewer",
] as const;

export const scribeOnlyCompositionChain = [
  ...baseCompositionChain,
  "ruleset:docs-write",
  "builtin:scribe-only",
] as const;

export const depsMutatorCompositionChain = [
  "ruleset:shell",
  "ruleset:git",
  "ruleset:packageManagers",
  "ruleset:deps-mutations-allow",
  "ruleset:shell-guards",
  "ruleset:path-guards",
  "builtin:deps-mutator",
] as const;

// no-shell retains default path policy but deliberately replaces, rather than
// extends, default Bash rules; do not report discarded shell rule sets.
export const noShellCompositionChain = [
  "ruleset:path-guards",
  "builtin:no-shell",
] as const;

/** Read code and run tests/builds; writes stay tmp + handoff + progress. */
export const reviewerProfile = extendProfile(readOnlyProfile, {
  ...ruleSetRegistry["ruleset:test-run"],
  description:
    "Reviewer profile: read-only review with test and build commands.",
  color: "cyan",
  emoji: "🧐",
});

/** Writes gated to Markdown documentation, docs/, and /tmp scratch. */
export const scribeOnlyProfile = extendProfile(baseProfile, {
  ...ruleSetRegistry["ruleset:docs-write"],
  description:
    "Docs scribe profile: writes restricted to Markdown, docs, and /tmp.",
  color: "white",
  emoji: "📜",
});

export const depsMutatorProfile: ProfilePolicy = {
  ...baseProfile,
  description: "Dependency mutator profile: allows package-manager mutations.",
  color: "yellow",
  sandbox: { network: "allow" },
  emoji: "📦",
  // Same composition as builtin:default with the dependency-mutation guard
  // rule set swapped for its allow twin.
  tools: {
    bash: bashRules(
      "ruleset:shell",
      "ruleset:git",
      "ruleset:packageManagers",
      "ruleset:deps-mutations-allow",
      "ruleset:shell-guards",
    ),
  },
};

export const noShellProfile: ProfilePolicy = {
  ...baseProfile,
  description:
    "No-shell profile: default path policy with all Bash commands denied.",
  color: "green",
  emoji: "🛡️",
  tools: {
    ...baseProfile.tools,
    // `*` has specificity zero, so a deny fallback must replace the inherited
    // bash rules outright; appending would lose to every more specific allow.
    bash: [
      {
        pattern: "*",
        decision: "deny",
        guidance:
          "The no-shell profile denies all Bash commands. Use Pi's structured tools instead.",
        alternatives: [
          "Use the read tool for concrete files",
          "Use the grep tool for content searches",
          "Use the find or ls tools for directory discovery",
          "Use the edit and write tools for file changes",
        ],
      },
    ],
  },
};
