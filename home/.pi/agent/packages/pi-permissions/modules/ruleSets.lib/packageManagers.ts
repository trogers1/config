import type { Rule } from "../policyHelpers";

export const npmMutationGuidance =
  "Package manager mutations install code, run lifecycle scripts, modify the project, or manage credentials and publishing. Ask the user to run the command directly.";

/** Deny rules for the mutating subcommands of a package manager executable. */
export function packageManagerMutationDenials(
  executable: string,
  subcommands: readonly string[],
): Rule[] {
  return subcommands.flatMap((subcommand) => [
    {
      pattern: `${executable} ${subcommand}`,
      decision: "deny" as const,
      guidance: npmMutationGuidance,
    },
    {
      pattern: `${executable} ${subcommand} *`,
      decision: "deny" as const,
      guidance: npmMutationGuidance,
    },
  ]);
}
