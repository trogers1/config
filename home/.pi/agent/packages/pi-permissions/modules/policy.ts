import {
  extendProfile,
  definePolicyConfig,
  type ProfilePolicy,
  type Rule,
} from "./policyHelpers";
import {
  defaultProtectedPathExceptions,
  defaultProtectedPathPatterns,
} from "./protectedPaths";

// ─── Shared base profile ──────────────────────────────────────────────
//
// Most profiles build on the same core tool rules. Use the `baseProfile`
// as a common set of permissions so we don't duplicate it everywhere.

// Pi documentation is useful reference material even when it lives outside
// the project.
const piReferencePathRules: Rule[] = [
  {
    pattern: "/**/node_modules/@earendil-works/pi-coding-agent/docs/**",
    decision: "allow",
  },
  {
    pattern: "/**/home/.pi/agent/packages/**/node_modules/**",
    decision: "allow",
  },
];

export const baseProfile: ProfilePolicy = {
  color: "blue",
  emoji: "🛠️",
  protectedPathPatterns: defaultProtectedPathPatterns,
  protectedPathExceptions: defaultProtectedPathExceptions,
  // No promptFile means: keep Pi's normal system prompt unchanged.
  // Tool policies are ordered: later matching rules override earlier ones.
  // For bash, patterns match normalized command segments.
  // For path-based tools, patterns match paths relative to pi's startup directory.
  // Outside paths appear as ../..., so use ../** to gate external access.
  tools: {
    bash: [
      { pattern: "*", decision: "ask" },
      { pattern: "git *", decision: "ask" },

      // Git read-only / semi-destructive commands intentionally allowed.
      { pattern: "git status", decision: "allow" },
      { pattern: "git status *", decision: "allow" },
      { pattern: "git log", decision: "allow" },
      { pattern: "git log *", decision: "allow" },
      { pattern: "git rm *", decision: "allow" },
      { pattern: "git mv *", decision: "allow" },
      { pattern: "git diff", decision: "allow" },
      { pattern: "git diff *", decision: "allow" },
      { pattern: "git pull", decision: "allow" },
      { pattern: "git grep *", decision: "allow" },
      { pattern: "git bisect *", decision: "allow" },
      { pattern: "git show *", decision: "allow" },
      { pattern: "git ls-files", decision: "allow" },
      { pattern: "git ls-files *", decision: "allow" },
      { pattern: "git rev-parse", decision: "allow" },
      { pattern: "git rev-parse *", decision: "allow" },
      { pattern: "git show-ref", decision: "allow" },
      { pattern: "git show-ref *", decision: "allow" },
      { pattern: "git merge-base *", decision: "allow" },
      { pattern: "git blame *", decision: "allow" },
      { pattern: "git rev-list", decision: "allow" },
      { pattern: "git rev-list *", decision: "allow" },
      { pattern: "git ls-tree *", decision: "allow" },
      { pattern: "git cat-file", decision: "allow" },
      { pattern: "git cat-file *", decision: "allow" },
      { pattern: "git for-each-ref", decision: "allow" },
      { pattern: "git for-each-ref *", decision: "allow" },
      { pattern: "git remote", decision: "allow" },
      { pattern: "git remote -v", decision: "allow" },
      { pattern: "git remote show *", decision: "allow" },
      { pattern: "git remote get-url *", decision: "allow" },
      { pattern: "git stash list", decision: "allow" },
      { pattern: "git stash list *", decision: "allow" },
      { pattern: "git stash show *", decision: "allow" },

      // Git destructive / workflow-changing commands.
      { pattern: "git branch *", decision: "deny" },
      { pattern: "git rebase *", decision: "deny" },
      { pattern: "git switch *", decision: "deny" },
      { pattern: "git tag *", decision: "deny" },
      { pattern: "git commit *", decision: "deny" },
      { pattern: "git push *", decision: "deny" },
      { pattern: "git checkout *", decision: "deny" },
      { pattern: "git add *", decision: "deny" },
      { pattern: "git worktree *", decision: "deny" },

      // Safe git branch/tag/worktree listing forms. These appear after the
      // broad branch/tag/worktree denies so they can be used for inspection
      // without opening up mutating forms such as delete, move, or add.
      { pattern: "git branch", decision: "allow" },
      { pattern: "git branch --show-current", decision: "allow" },
      { pattern: "git branch --list", decision: "allow" },
      { pattern: "git branch --list *", decision: "allow" },
      { pattern: "git branch --contains *", decision: "allow" },
      { pattern: "git branch --merged *", decision: "allow" },
      { pattern: "git branch --no-merged *", decision: "allow" },
      { pattern: "git branch --points-at *", decision: "allow" },
      { pattern: "git branch --all", decision: "allow" },
      { pattern: "git branch --remotes", decision: "allow" },
      { pattern: "git branch -a", decision: "allow" },
      { pattern: "git branch -r", decision: "allow" },
      { pattern: "git branch -v", decision: "allow" },
      { pattern: "git branch -vv", decision: "allow" },
      { pattern: "git branch -av", decision: "allow" },
      { pattern: "git branch -avv", decision: "allow" },
      { pattern: "git branch -rv", decision: "allow" },
      { pattern: "git branch -rvv", decision: "allow" },
      { pattern: "git tag", decision: "allow" },
      { pattern: "git tag --list", decision: "allow" },
      { pattern: "git tag --list *", decision: "allow" },
      { pattern: "git tag --contains *", decision: "allow" },
      { pattern: "git tag --merged *", decision: "allow" },
      { pattern: "git tag --no-merged *", decision: "allow" },
      { pattern: "git tag --points-at *", decision: "allow" },
      { pattern: "git tag -l", decision: "allow" },
      { pattern: "git tag -l *", decision: "allow" },
      { pattern: "git tag --sort*", decision: "allow" },
      { pattern: "git worktree list", decision: "allow" },
      { pattern: "git worktree list *", decision: "allow" },

      // Common low-risk commands.
      { pattern: "pwd", decision: "allow" },
      { pattern: "cd", decision: "allow" },
      {
        pattern: "printf",
        decision: "deny",
        guidance:
          'printing can reveal secrets. If you just want a separator use `echo "---"',
      },
      {
        pattern: "echo",
        decision: "deny",
        guidance:
          'echo can reveal secrets. If you just want a separator use `echo "---"',
      },
      { pattern: 'echo "---"', decision: "allow" },
      // Allow changing into child directories; writePaths below still
      // gates bash path arguments and asks/blocks when the target leaves startup cwd.
      { pattern: "cd *", decision: "allow" },
      { pattern: "grep *", decision: "allow" },
      {
        pattern: "npx prettier",
        decision: "deny",
        guidance:
          "Do not invoke Prettier through npx. Use the repository's configured formatter or make targeted edits with Pi's edit tool.",
        alternatives: [
          "npm run prettier:write",
          "npm run fix:prettier",
          "Use the edit tool for targeted changes",
        ],
      },
      {
        pattern: "npx prettier *",
        decision: "deny",
        guidance:
          "Do not invoke Prettier through npx. Use the repository's configured formatter or make targeted edits with Pi's edit tool.",
        alternatives: [
          "npm run prettier:write",
          "npm run fix:prettier",
          "Use the edit tool for targeted changes",
        ],
      },
      {
        pattern: "**/node_modules/.bin/prettier *",
        decision: "deny",
        guidance:
          "Do not invoke Prettier directly. Use the repository's configured formatter script or make targeted edits with Pi's edit tool.",
        alternatives: [
          "npm run prettier:write",
          "npm run fix:prettier",
          "Use the edit tool for targeted changes",
        ],
      },
      {
        pattern: "npx vitest",
        decision: "deny",
        guidance:
          "Do not invoke Vitest through npx. Inspect package.json and use the repository's configured test script instead.",
        alternatives: ["npm test", "npm test -- <requested test filters>"],
      },
      {
        pattern: "npx vitest *",
        decision: "deny",
        guidance:
          "Do not invoke Vitest through npx. Inspect package.json and use the repository's configured test script instead.",
        alternatives: ["npm test -- <requested test filters>"],
      },
      { pattern: "find *", decision: "allow" },
      { pattern: "cat", decision: "allow" },
      { pattern: "cat *", decision: "allow" },
      { pattern: "sort *", decision: "allow" },
      { pattern: "sort", decision: "allow" },
      { pattern: "sed", decision: "allow" },
      { pattern: "sed *", decision: "allow" },
      { pattern: "ls", decision: "allow" },
      { pattern: "ls *", decision: "allow" },
      { pattern: "wc", decision: "allow" },
      { pattern: "wc *", decision: "allow" },
      { pattern: "file", decision: "allow" },
      { pattern: "file *", decision: "allow" },

      // Package managers
      { pattern: "npm *", decision: "ask" },
      { pattern: "npm run *", decision: "allow" },
      { pattern: "npm test", decision: "allow" },
      { pattern: "yarn *", decision: "ask" },
      { pattern: "pnpm *", decision: "ask" },
      { pattern: "pip *", decision: "ask" },
      {
        pattern: "npm exec",
        decision: "deny",
        guidance:
          "Do not run one-off binaries with npm exec. Use the package.json scripts defined for this repository instead.",
        alternatives: [
          "npm run test",
          "npm run test:watch",
          "npm run check:all",
          "npm run check:prettier",
          "npm run fix:prettier",
        ],
      },
      {
        pattern: "npm exec *",
        decision: "deny",
        guidance:
          "Do not run one-off binaries with npm exec. Use the package.json scripts defined for this repository instead.",
        alternatives: [
          "npm run test",
          "npm run test:watch",
          "npm run check:all",
          "npm run check:prettier",
          "npm run fix:prettier",
        ],
      },
      { pattern: "go *", decision: "allow" },
      { pattern: "true", decision: "allow" },
      { pattern: "rg *", decision: "allow" },
      { pattern: "ripgrep *", decision: "allow" },
      { pattern: "terraform fmt *", decision: "allow" },
      { pattern: "terraform validate", decision: "allow" },
      { pattern: "terraform validate *", decision: "allow" },
      { pattern: "terraform -chdir=* validate", decision: "allow" },
      { pattern: "terraform -chdir=* validate *", decision: "allow" },
      { pattern: "nl", decision: "allow" },
      { pattern: "nl *", decision: "allow" },

      // GitLab MR comment skills — read-only via fixed scripts (no direct glab).
      { pattern: "glab *", decision: "deny" },
      {
        pattern: "bash *skills/address-comments/scripts/fetch-open-mr.sh*",
        decision: "allow",
      },
      {
        pattern:
          "bash *skills/address-comments/scripts/fetch-mr-discussions.sh*",
        decision: "allow",
      },
      {
        pattern: "bash *skills/address-comments/scripts/enrich-discussions.sh*",
        decision: "allow",
      },
      {
        pattern: "bash *skills/address-comments/scripts/render-comments-md.sh*",
        decision: "allow",
      },
      {
        pattern:
          "bash *skills/address-comments/scripts/refresh-robot-comments-md.sh*",
        decision: "allow",
      },
      {
        pattern:
          "bash *skills/address-comments/scripts/refresh-all-comments-md.sh*",
        decision: "allow",
      },

      // Guard write-capable flags/forms on otherwise allowed inspection tools.
      {
        pattern: "find * -delete*",
        decision: "deny",
        guidance: "find -delete modifies the filesystem.",
      },
      {
        pattern: "find * -exec *",
        decision: "deny",
        guidance:
          "find -exec can run destructive commands; inspect results first and use targeted tool calls instead.",
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
    ],
  },

  readPaths: [
    { pattern: "*", decision: "allow" },
    { pattern: "..", decision: "ask", contexts: ["read"] },
    {
      pattern: "../**",
      decision: "ask",
      contexts: ["read", "grep", "ls"],
    },
    { pattern: "/tmp/**", decision: "allow" },
    // These exceptions belonged to the dedicated read tool before path rules
    // were consolidated. Keep searches and directory discovery independently gated.
    {
      pattern: "../.pi/agent/skills/**",
      decision: "allow",
      contexts: ["read"],
    },
    {
      pattern: "../**/.pi/agent/skills/**",
      decision: "allow",
      contexts: ["read"],
    },
    {
      pattern: "../**/@earendil-works/pi-coding-agent/docs/*.md",
      decision: "allow",
      contexts: ["read"],
    },
    ...piReferencePathRules.map((rule) => ({
      ...rule,
      contexts: ["read" as const],
    })),
  ],

  writePaths: [
    { pattern: "*", decision: "allow" },
    { pattern: "..", decision: "ask", contexts: ["bash"] },
    { pattern: "../**", decision: "ask" },
    { pattern: "/tmp/**", decision: "allow" },
    // Bash-specific external references retained from the former shell path policy.
    {
      pattern: "../**/.pi/agent/skills/address-comments/scripts/*.sh",
      decision: "allow",
      contexts: ["bash"],
    },
    {
      pattern: "../**/.pi/agent/skills/address-comments/*",
      decision: "allow",
      contexts: ["bash"],
    },
    ...piReferencePathRules.map((rule) => ({
      ...rule,
      contexts: ["bash" as const],
    })),
  ],
};

function denyInteractiveDecisions(policy: ProfilePolicy): ProfilePolicy {
  const denyAsk = <
    PolicyRule extends { decision: Rule["decision"]; guidance?: string },
  >(
    rule: PolicyRule,
  ): PolicyRule =>
    rule.decision === "ask"
      ? {
          ...rule,
          decision: "deny",
          guidance:
            rule.guidance ??
            "This non-interactive worker cannot request permission. Use an explicitly allowed command or path.",
        }
      : { ...rule };

  return {
    ...policy,
    color: "magenta",
    emoji: "⚙️",
    tools: Object.fromEntries(
      Object.entries(policy.tools).map(([tool, rules]) => [
        tool,
        rules?.map((rule) => denyAsk(rule)) ?? [],
      ]),
    ),
    readPaths: policy.readPaths.map(denyAsk),
    writePaths: policy.writePaths.map(denyAsk),
  };
}

const workerProfile = denyInteractiveDecisions(baseProfile);

const readOnlyPathRules: ProfilePolicy["readPaths"] = [
  { pattern: "*", decision: "allow" },
  {
    pattern: "..",
    decision: "deny",
    guidance:
      "The read-only profile can only read inside the startup directory and /tmp.",
  },
  {
    pattern: "../**",
    decision: "deny",
    guidance:
      "The read-only profile can only read inside the startup directory and /tmp.",
  },
  { pattern: "/tmp", decision: "allow" },
  { pattern: "/tmp/**", decision: "allow" },
  { pattern: "/private/tmp", decision: "allow" },
  { pattern: "/private/tmp/**", decision: "allow" },
  ...piReferencePathRules,
];

const readOnlyProfile: ProfilePolicy = {
  color: "green",
  emoji: "🔎",
  protectedPathPatterns: defaultProtectedPathPatterns,
  protectedPathExceptions: defaultProtectedPathExceptions,
  tools: {
    bash: [
      {
        pattern: "*",
        decision: "deny",
        guidance:
          "The read-only profile only permits inspection commands and non-destructive git history queries.",
      },

      // Navigation and read-only shell inspection.
      { pattern: "pwd", decision: "allow" },
      { pattern: "cd", decision: "allow" },
      { pattern: "cd *", decision: "allow" },
      { pattern: "ls", decision: "allow" },
      { pattern: "ls *", decision: "allow" },
      { pattern: "find *", decision: "allow" },
      { pattern: "grep *", decision: "allow" },
      { pattern: "cat", decision: "allow" },
      { pattern: "cat *", decision: "allow" },
      { pattern: "sed", decision: "allow" },
      { pattern: "sed *", decision: "allow" },
      { pattern: "sort", decision: "allow" },
      { pattern: "sort *", decision: "allow" },
      { pattern: "rg *", decision: "allow" },
      { pattern: "ripgrep *", decision: "allow" },
      { pattern: "head", decision: "allow" },
      { pattern: "head *", decision: "allow" },
      { pattern: "tail", decision: "allow" },
      { pattern: "tail *", decision: "allow" },
      { pattern: "nl", decision: "allow" },
      { pattern: "nl *", decision: "allow" },
      { pattern: "wc", decision: "allow" },
      { pattern: "wc *", decision: "allow" },
      { pattern: "file", decision: "allow" },
      { pattern: "file *", decision: "allow" },

      // Non-destructive git commands for inspecting the working tree, refs,
      // objects, and history. Commands that update refs, the index, worktrees,
      // or files are intentionally left denied by the catch-all rule above.
      { pattern: "git", decision: "allow" },
      { pattern: "git version", decision: "allow" },
      { pattern: "git help", decision: "allow" },
      { pattern: "git help *", decision: "allow" },
      { pattern: "git status", decision: "allow" },
      { pattern: "git status *", decision: "allow" },
      { pattern: "git log", decision: "allow" },
      { pattern: "git log *", decision: "allow" },
      { pattern: "git show", decision: "allow" },
      { pattern: "git show *", decision: "allow" },
      { pattern: "git diff", decision: "allow" },
      { pattern: "git diff *", decision: "allow" },
      { pattern: "git grep *", decision: "allow" },
      { pattern: "git blame *", decision: "allow" },
      { pattern: "git annotate *", decision: "allow" },
      { pattern: "git rev-parse", decision: "allow" },
      { pattern: "git rev-parse *", decision: "allow" },
      { pattern: "git rev-list", decision: "allow" },
      { pattern: "git rev-list *", decision: "allow" },
      { pattern: "git show-ref", decision: "allow" },
      { pattern: "git show-ref *", decision: "allow" },
      { pattern: "git merge-base *", decision: "allow" },
      { pattern: "git merge-tree *", decision: "allow" },
      { pattern: "git reflog", decision: "allow" },
      { pattern: "git reflog show", decision: "allow" },
      { pattern: "git reflog show *", decision: "allow" },
      { pattern: "git reflog list", decision: "allow" },
      { pattern: "git reflog list *", decision: "allow" },
      { pattern: "git reflog exists *", decision: "allow" },
      { pattern: "git shortlog", decision: "allow" },
      { pattern: "git shortlog *", decision: "allow" },
      { pattern: "git whatchanged", decision: "allow" },
      { pattern: "git whatchanged *", decision: "allow" },
      { pattern: "git range-diff *", decision: "allow" },
      { pattern: "git cherry", decision: "allow" },
      { pattern: "git cherry *", decision: "allow" },
      { pattern: "git describe", decision: "allow" },
      { pattern: "git describe *", decision: "allow" },
      { pattern: "git name-rev *", decision: "allow" },
      { pattern: "git ls-files", decision: "allow" },
      { pattern: "git ls-files *", decision: "allow" },
      { pattern: "git ls-tree *", decision: "allow" },
      { pattern: "git cat-file", decision: "allow" },
      { pattern: "git cat-file *", decision: "allow" },
      { pattern: "git for-each-ref", decision: "allow" },
      { pattern: "git for-each-ref *", decision: "allow" },
      { pattern: "git branch", decision: "allow" },
      { pattern: "git branch --show-current", decision: "allow" },
      { pattern: "git branch --list", decision: "allow" },
      { pattern: "git branch --list *", decision: "allow" },
      { pattern: "git branch --contains *", decision: "allow" },
      { pattern: "git branch --merged *", decision: "allow" },
      { pattern: "git branch --no-merged *", decision: "allow" },
      { pattern: "git branch --points-at *", decision: "allow" },
      { pattern: "git branch --all", decision: "allow" },
      { pattern: "git branch --remotes", decision: "allow" },
      { pattern: "git branch -a", decision: "allow" },
      { pattern: "git branch -r", decision: "allow" },
      { pattern: "git branch -v", decision: "allow" },
      { pattern: "git branch -vv", decision: "allow" },
      { pattern: "git branch -av", decision: "allow" },
      { pattern: "git branch -avv", decision: "allow" },
      { pattern: "git branch -rv", decision: "allow" },
      { pattern: "git branch -rvv", decision: "allow" },
      { pattern: "git tag", decision: "allow" },
      { pattern: "git tag --list", decision: "allow" },
      { pattern: "git tag --list *", decision: "allow" },
      { pattern: "git tag --contains *", decision: "allow" },
      { pattern: "git tag --merged *", decision: "allow" },
      { pattern: "git tag --no-merged *", decision: "allow" },
      { pattern: "git tag --points-at *", decision: "allow" },
      { pattern: "git tag --sort*", decision: "allow" },
      { pattern: "git tag -l", decision: "allow" },
      { pattern: "git tag -l *", decision: "allow" },
      { pattern: "git remote", decision: "allow" },
      { pattern: "git remote -v", decision: "allow" },
      { pattern: "git remote show *", decision: "allow" },
      { pattern: "git remote get-url *", decision: "allow" },
      { pattern: "git config --get *", decision: "allow" },
      { pattern: "git config --get-regexp *", decision: "allow" },
      { pattern: "git config --list", decision: "allow" },
      { pattern: "git config --list *", decision: "allow" },
      { pattern: "git config * --list", decision: "allow" },
      { pattern: "git config * --list *", decision: "allow" },
      { pattern: "git config -l", decision: "allow" },
      { pattern: "git config -l *", decision: "allow" },
      { pattern: "git stash list", decision: "allow" },
      { pattern: "git stash list *", decision: "allow" },
      { pattern: "git stash show *", decision: "allow" },
      { pattern: "git submodule status", decision: "allow" },
      { pattern: "git submodule status *", decision: "allow" },
      { pattern: "git worktree list", decision: "allow" },
      { pattern: "git worktree list *", decision: "allow" },
      { pattern: "git sparse-checkout list", decision: "allow" },
      { pattern: "git count-objects", decision: "allow" },
      { pattern: "git count-objects *", decision: "allow" },
      { pattern: "git fsck", decision: "allow" },
      { pattern: "git fsck *", decision: "allow" },
      { pattern: "git verify-commit *", decision: "allow" },
      { pattern: "git verify-tag *", decision: "allow" },
      { pattern: "git diff-tree *", decision: "allow" },
      { pattern: "git diff-index *", decision: "allow" },
      { pattern: "git diff-files", decision: "allow" },
      { pattern: "git diff-files *", decision: "allow" },
      { pattern: "git show-branch", decision: "allow" },
      { pattern: "git show-branch *", decision: "allow" },
      { pattern: "git symbolic-ref HEAD", decision: "allow" },
      { pattern: "git symbolic-ref --short HEAD", decision: "allow" },

      // Keep the read-only profile from writing through otherwise-readable
      // commands or through find/git options with write side effects.
      // Shell redirection is gated separately by writePaths.
      {
        pattern: "find * -delete*",
        decision: "deny",
        guidance: "find -delete modifies the filesystem and is not read-only.",
      },
      {
        pattern: "find * -exec *",
        decision: "deny",
        guidance:
          "find -exec can run destructive commands; use Pi's find/read/grep tools for inspection instead.",
      },
      {
        pattern: "find * -execdir *",
        decision: "deny",
        guidance:
          "find -execdir can run destructive commands; use Pi's find/read/grep tools for inspection instead.",
      },
      {
        pattern: "git * --output*",
        decision: "deny",
        guidance:
          "The read-only profile blocks git options that write command output to files.",
      },
      {
        pattern: "git fsck *--lost-found*",
        decision: "deny",
        guidance:
          "git fsck --lost-found writes recovered objects and is not read-only.",
      },
      {
        pattern: "git reflog delete *",
        decision: "deny",
        guidance: "Deleting reflog entries changes repository metadata.",
      },
      {
        pattern: "git reflog drop *",
        decision: "deny",
        guidance: "Dropping reflogs changes repository metadata.",
      },
      {
        pattern: "git reflog expire *",
        decision: "deny",
        guidance: "Expiring reflogs changes repository metadata.",
      },
      {
        pattern: "git branch * -d *",
        decision: "deny",
        guidance: "Deleting branches changes repository refs.",
      },
      {
        pattern: "git branch * -D *",
        decision: "deny",
        guidance: "Deleting branches changes repository refs.",
      },
      {
        pattern: "git branch * --delete *",
        decision: "deny",
        guidance: "Deleting branches changes repository refs.",
      },
      {
        pattern: "git branch * -m *",
        decision: "deny",
        guidance: "Renaming branches changes repository refs.",
      },
      {
        pattern: "git branch * --move *",
        decision: "deny",
        guidance: "Renaming branches changes repository refs.",
      },
      {
        pattern: "git branch * -c *",
        decision: "deny",
        guidance: "Copying branches changes repository refs.",
      },
      {
        pattern: "git branch * --copy *",
        decision: "deny",
        guidance: "Copying branches changes repository refs.",
      },
      {
        pattern: "git tag * -d *",
        decision: "deny",
        guidance: "Deleting tags changes repository refs.",
      },
      {
        pattern: "git tag * --delete *",
        decision: "deny",
        guidance: "Deleting tags changes repository refs.",
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
    ],
  },

  readPaths: readOnlyPathRules,
  writePaths: [
    {
      pattern: "**",
      decision: "deny",
      guidance:
        "The read-only profile only permits writing /tmp, handoff.md, and progress.md.",
    },
    { pattern: "/tmp", decision: "allow" },
    { pattern: "/tmp/**", decision: "allow" },
    { pattern: "/private/tmp", decision: "allow" },
    { pattern: "/private/tmp/**", decision: "allow" },
    { pattern: "handoff.md", decision: "allow" },
    { pattern: "progress.md", decision: "allow" },
    // The command policy permits inspection of these references; make them
    // explicitly available to Bash without broadening the dedicated write tools.
    ...piReferencePathRules.map((rule) => ({
      ...rule,
      contexts: ["bash" as const],
    })),
  ],
};

// ─── Test-focused profiles ───────────────────────────────────────────

const testFilePatterns = [
  "**/test",
  "**/test/**",
  "**/tests",
  "**/tests/**",
  "**/__tests__",
  "**/__tests__/**",
  "**/integrationTests",
  "**/integrationTests/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.*",
  "**/*.cy.*",
] as const;

const testsDisallowedProfile = extendProfile(baseProfile, {
  color: "yellow",
  emoji: "🚫",
  promptFile: "prompts/tests-disallowed.md",
  // Protected patterns also make grep/ripgrep exclude tests during broad
  // searches whose requested path is the repository root.
  protectedPathPatterns: [...defaultProtectedPathPatterns, ...testFilePatterns],
  readPaths: testFilePatterns.map((pattern) => ({
    pattern,
    decision: "deny" as const,
    guidance:
      "You are implementing only. Do not inspect test files; adjust the system from production code and test results instead.",
  })),
  writePaths: testFilePatterns.map((pattern) => ({
    pattern,
    decision: "deny" as const,
    guidance:
      "You are implementing only. Do not alter tests; adjust the system under test instead.",
  })),
});

const testsOnlyProfile = extendProfile(baseProfile, {
  color: "cyan",
  emoji: "🧪",
  promptFile: "prompts/tests-only.md",
  writePaths: [
    {
      pattern: "**",
      decision: "deny",
      guidance:
        "This profile may only edit test files. Read the implementation, then make the requested change in tests.",
    },
    ...testFilePatterns.map((pattern) => ({
      pattern,
      decision: "allow" as const,
    })),
  ],
});

// ─── Exported policy config ───────────────────────────────────────────

const configuredPolicy = definePolicyConfig({
  defaultProfile: "default",

  profiles: {
    default: baseProfile,
    worker: workerProfile,
    "read-only": readOnlyProfile,
    "tests-disallowed": testsDisallowedProfile,
    "tests-only": testsOnlyProfile,

    "performance-review": extendProfile(baseProfile, {
      color: "red",
      emoji: "📋",
      // Specific to performance-review profile only:
      tools: {
        bash: [
          { pattern: "glab *", decision: "allow" },
          { pattern: "gh *", decision: "allow" },
          { pattern: "jq *", decision: "allow" },
        ],
      },
    }),
  },
});

/** Portable profiles shipped by the package. Local profiles live in user config. */
export const policyConfig = configuredPolicy;
