import type { Rule } from "../policyHelpers";

export const defaultGuardRules: Rule[] = [
  {
    pattern: "find -delete*",
    decision: "deny",
    guidance: "find -delete modifies the filesystem.",
  },
  {
    pattern: "find * -delete*",
    decision: "deny",
    guidance: "find -delete modifies the filesystem.",
  },
  {
    pattern: "find -exec*",
    decision: "deny",
    guidance:
      "find -exec can run destructive commands; inspect results first and use targeted tool calls instead.",
  },
  {
    pattern: "find * -exec *",
    decision: "deny",
    guidance:
      "find -exec can run destructive commands; inspect results first and use targeted tool calls instead.",
  },
  {
    pattern: "find -execdir*",
    decision: "deny",
    guidance:
      "find -execdir can run destructive commands; inspect results first and use targeted tool calls instead.",
  },
  {
    pattern: "find * -execdir *",
    decision: "deny",
    guidance:
      "find -execdir can run destructive commands; inspect results first and use targeted tool calls instead.",
  },
  {
    pattern: "git * --output*",
    decision: "deny",
    guidance:
      "Git --output writes files. Use shell redirection to /tmp for scratch output, or Pi's write/edit tools for intentional project changes.",
  },
  {
    pattern: "git fsck *--lost-found*",
    decision: "deny",
    guidance: "git fsck --lost-found writes recovered objects.",
  },
  {
    pattern: "git merge-tree --write-tree*",
    decision: "deny",
    guidance:
      "git merge-tree --write-tree can write merged objects to the repository.",
  },
  {
    pattern: "git merge-tree * --write-tree*",
    decision: "deny",
    guidance:
      "git merge-tree --write-tree can write merged objects to the repository.",
  },
  {
    pattern: "grep *",
    decision: "deny",
    guidance:
      "Raw grep cannot be safely augmented with the active profile's protected-path exclusions. Use Pi's grep tool or ripgrep, which apply profile-derived exclusions automatically.",
  },
  {
    pattern: "git grep *",
    decision: "deny",
    guidance:
      "git grep cannot be safely augmented with the active profile's protected-path exclusions. Use Pi's grep tool or ripgrep, which apply profile-derived exclusions automatically.",
  },
];
