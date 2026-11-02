import type { CustomToolRule, ProfilePolicy } from "../policyHelpers";

// Tool names below are registered by other Pi packages (Pi's codemode and
// pi-guard-subagents). pi-guard cannot import them across package
// boundaries, so each is declared exactly once here.

/**
 * The outer codemode call is allowed because every tool its script runs is
 * authorized individually; approving a script never grants its operations.
 */
export const codemodeToolRules = {
  codemode: [{ decision: "allow" }],
} satisfies ProfilePolicy["tools"];

/** Coordination between a parent agent and the subagents it launched. */
export const subagentToolRules = subagentToolRulesFor({
  rule: { decision: "allow" },
});

/**
 * Composed after `ruleset:subagents`, these equally specific denials win the
 * tie and disable subagents for a profile.
 */
export const subagentOffToolRules = subagentToolRulesFor({
  rule: {
    decision: "deny",
    guidance: "Subagents are disabled for this profile.",
  },
});

function subagentToolRulesFor({ rule }: { readonly rule: CustomToolRule }) {
  return {
    subagent: [{ ...rule }],
    subagent_message: [{ ...rule }],
    ask_question: [{ ...rule }],
  } satisfies ProfilePolicy["tools"];
}
