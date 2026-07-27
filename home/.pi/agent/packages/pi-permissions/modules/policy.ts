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

const npmMutationGuidance =
  "Package manager mutations install code, run lifecycle scripts, modify the project, or manage credentials and publishing. Ask the user to run the command directly.";

/** Deny rules for the mutating subcommands of a package manager executable. */
function packageManagerMutationDenials(
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
        pattern: "**/node_modules/.bin/*",
        decision: "deny",
        guidance:
          "Do not invoke packages directly. Use the repository's configured scripts.",
        alternatives: [
          "npm run prettier:write",
          "npm run fix:prettier",
          "npm test",
          "Use the edit tool to add needed scripts to package.json (or equivalent)",
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

      // Package managers: running scripts and read-only inspection are
      // allowed; mutations that install code, run lifecycle scripts, modify
      // the project, or manage credentials and publishing are denied;
      // anything less common asks. Denials follow the allows so they win on
      // overlap (for example `npm audit` vs `npm audit fix`).
      { pattern: "npm *", decision: "ask" },
      { pattern: "npm run *", decision: "allow" },
      { pattern: "npm test", decision: "allow" },
      // Script arguments are forwarded to the script and stay path-gated, so
      // the command form itself is safe to allow.
      { pattern: "npm test *", decision: "allow" },
      { pattern: "npm start", decision: "allow" },
      { pattern: "npm start *", decision: "allow" },
      { pattern: "npm stop", decision: "allow" },
      { pattern: "npm restart", decision: "allow" },
      { pattern: "npm ls", decision: "allow" },
      { pattern: "npm ls *", decision: "allow" },
      { pattern: "npm list", decision: "allow" },
      { pattern: "npm list *", decision: "allow" },
      { pattern: "npm view", decision: "allow" },
      { pattern: "npm view *", decision: "allow" },
      { pattern: "npm info", decision: "allow" },
      { pattern: "npm info *", decision: "allow" },
      { pattern: "npm show", decision: "allow" },
      { pattern: "npm show *", decision: "allow" },
      { pattern: "npm outdated", decision: "allow" },
      { pattern: "npm outdated *", decision: "allow" },
      { pattern: "npm audit", decision: "allow" },
      { pattern: "npm explain", decision: "allow" },
      { pattern: "npm explain *", decision: "allow" },
      { pattern: "npm why", decision: "allow" },
      { pattern: "npm why *", decision: "allow" },
      { pattern: "npm config get *", decision: "allow" },
      { pattern: "npm config list", decision: "allow" },
      { pattern: "npm prefix", decision: "allow" },
      { pattern: "npm root", decision: "allow" },
      { pattern: "npm doctor", decision: "allow" },
      { pattern: "npm help", decision: "allow" },
      { pattern: "npm help *", decision: "allow" },
      ...packageManagerMutationDenials("npm", [
        "install",
        "i",
        "add",
        "ci",
        "update",
        "uninstall",
        "remove",
        "rm",
        "publish",
        "link",
        "login",
        "logout",
        "token",
        "pkg set",
        "config set",
        "config delete",
        "audit fix",
      ]),
      {
        pattern: "npm version *",
        decision: "deny",
        guidance: npmMutationGuidance,
      },

      { pattern: "pnpm *", decision: "ask" },
      { pattern: "pnpm run *", decision: "allow" },
      { pattern: "pnpm test", decision: "allow" },
      { pattern: "pnpm test *", decision: "allow" },
      { pattern: "pnpm start", decision: "allow" },
      { pattern: "pnpm ls", decision: "allow" },
      { pattern: "pnpm ls *", decision: "allow" },
      { pattern: "pnpm list", decision: "allow" },
      { pattern: "pnpm list *", decision: "allow" },
      { pattern: "pnpm outdated", decision: "allow" },
      { pattern: "pnpm outdated *", decision: "allow" },
      { pattern: "pnpm audit", decision: "allow" },
      { pattern: "pnpm why", decision: "allow" },
      { pattern: "pnpm why *", decision: "allow" },
      ...packageManagerMutationDenials("pnpm", [
        "add",
        "install",
        "i",
        "update",
        "remove",
        "rm",
        "uninstall",
        "publish",
        "dlx",
        "link",
      ]),
      {
        pattern: "pnpm audit --fix*",
        decision: "deny",
        guidance: npmMutationGuidance,
      },

      { pattern: "yarn *", decision: "ask" },
      { pattern: "yarn run *", decision: "allow" },
      { pattern: "yarn test", decision: "allow" },
      { pattern: "yarn test *", decision: "allow" },
      { pattern: "yarn start", decision: "allow" },
      { pattern: "yarn list", decision: "allow" },
      { pattern: "yarn list *", decision: "allow" },
      { pattern: "yarn info", decision: "allow" },
      { pattern: "yarn info *", decision: "allow" },
      { pattern: "yarn outdated", decision: "allow" },
      { pattern: "yarn why *", decision: "allow" },
      ...packageManagerMutationDenials("yarn", [
        "add",
        "install",
        "remove",
        "upgrade",
        "publish",
        "dlx",
        "link",
        "config set",
      ]),

      { pattern: "pip *", decision: "ask" },
      { pattern: "pip list", decision: "allow" },
      { pattern: "pip list *", decision: "allow" },
      { pattern: "pip show", decision: "allow" },
      { pattern: "pip show *", decision: "allow" },
      { pattern: "pip freeze", decision: "allow" },
      { pattern: "pip freeze *", decision: "allow" },
      ...packageManagerMutationDenials("pip", ["install", "uninstall"]),

      { pattern: "pip3 *", decision: "ask" },
      { pattern: "pip3 list", decision: "allow" },
      { pattern: "pip3 list *", decision: "allow" },
      { pattern: "pip3 show", decision: "allow" },
      { pattern: "pip3 show *", decision: "allow" },
      { pattern: "pip3 freeze", decision: "allow" },
      { pattern: "pip3 freeze *", decision: "allow" },
      ...packageManagerMutationDenials("pip3", ["install", "uninstall"]),

      // uv: queries are allowed, but `uv run`/`uvx` execute arbitrary
      // commands through the project environment, so they stay at ask.
      { pattern: "uv *", decision: "ask" },
      { pattern: "uv pip list", decision: "allow" },
      { pattern: "uv pip list *", decision: "allow" },
      { pattern: "uv pip show", decision: "allow" },
      { pattern: "uv pip show *", decision: "allow" },
      { pattern: "uv pip freeze", decision: "allow" },
      { pattern: "uv pip freeze *", decision: "allow" },
      { pattern: "uv tree", decision: "allow" },
      { pattern: "uv tree *", decision: "allow" },
      ...packageManagerMutationDenials("uv", [
        "pip install",
        "pip uninstall",
        "add",
        "remove",
        "sync",
        "lock",
        "publish",
        "tool install",
      ]),

      // Cargo: building and testing the current crate is allowed; installing
      // or publishing code is denied; the rest (fmt, clean, run, ...) asks.
      { pattern: "cargo *", decision: "ask" },
      { pattern: "cargo build", decision: "allow" },
      { pattern: "cargo build *", decision: "allow" },
      { pattern: "cargo test", decision: "allow" },
      { pattern: "cargo test *", decision: "allow" },
      { pattern: "cargo check", decision: "allow" },
      { pattern: "cargo check *", decision: "allow" },
      { pattern: "cargo clippy", decision: "allow" },
      { pattern: "cargo clippy *", decision: "allow" },
      { pattern: "cargo doc", decision: "allow" },
      { pattern: "cargo doc *", decision: "allow" },
      ...packageManagerMutationDenials("cargo", [
        "install",
        "add",
        "remove",
        "uninstall",
        "publish",
      ]),

      { pattern: "gem *", decision: "ask" },
      { pattern: "gem list", decision: "allow" },
      { pattern: "gem list *", decision: "allow" },
      ...packageManagerMutationDenials("gem", ["install", "uninstall", "push"]),

      // `bundle exec` runs arbitrary commands, so it stays at ask.
      { pattern: "bundle *", decision: "ask" },
      { pattern: "bundle list", decision: "allow" },
      { pattern: "bundle list *", decision: "allow" },
      ...packageManagerMutationDenials("bundle", ["install", "update", "add"]),

      { pattern: "composer *", decision: "ask" },
      { pattern: "composer show", decision: "allow" },
      { pattern: "composer show *", decision: "allow" },
      ...packageManagerMutationDenials("composer", [
        "install",
        "update",
        "require",
        "remove",
      ]),
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
      ...packageManagerMutationDenials("go", ["install", "get"]),
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
      contexts: ["edit", "write"],
      guidance:
        "This profile may only edit test files. Read the implementation, then make the requested change in tests.",
    },
    {
      pattern: "**",
      decision: "deny",
      contexts: ["bash"],
      guidance:
        "Bash path operands are gated as writes under the tests-only profile. Use the read, grep, find, and ls tools to inspect implementation files; Bash operands and redirections may only target test files and /tmp.",
      alternatives: [
        "Use the read tool for concrete files",
        "Use the grep tool for content searches",
        "Use the find or ls tools for directory discovery",
      ],
    },
    ...testFilePatterns.map((pattern) => ({
      pattern,
      decision: "allow" as const,
    })),
    { pattern: "/tmp", decision: "allow" },
    { pattern: "/tmp/**", decision: "allow" },
    { pattern: "/private/tmp", decision: "allow" },
    { pattern: "/private/tmp/**", decision: "allow" },
  ],
});

// ─── Exported policy config ───────────────────────────────────────────

const configuredPolicy = definePolicyConfig({
  defaultProfile: "builtin:default",

  profiles: {
    "builtin:default": baseProfile,
    "builtin:worker": workerProfile,
    "builtin:read-only": readOnlyProfile,
    "builtin:tests-disallowed": testsDisallowedProfile,
    "builtin:tests-only": testsOnlyProfile,
  },
});

function deepFreeze<T extends object>(value: T): T {
  for (const key of Reflect.ownKeys(value) as (keyof T)[]) {
    const prop = value[key];
    if (prop && typeof prop === "object" && !Object.isFrozen(prop)) {
      deepFreeze(prop);
    }
  }
  return Object.freeze(value);
}

/** Portable profiles shipped by the package. Local profiles live in user config. */
export const policyConfig = deepFreeze(configuredPolicy);
