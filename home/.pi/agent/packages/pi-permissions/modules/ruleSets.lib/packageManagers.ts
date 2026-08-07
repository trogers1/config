import type { Rule } from "../policyHelpers";

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

/**
 * Dependency-mutation subcommands (install/add/update/remove families): the
 * mutations a dependency-work profile performs deliberately. One table
 * generates both the guard (deny) and opener (allow) rule-set variants below,
 * so the two can never drift. Publishing, credential, and one-off-binary
 * mutations are excluded; those live in the base rules and stay denied even
 * for dependency-work profiles.
 */
const dependencyMutationSubcommands: Record<string, readonly string[]> = {
  npm: ["install", "i", "add", "ci", "update", "uninstall", "remove", "rm"],
  pnpm: ["add", "install", "i", "update", "remove", "rm", "uninstall"],
  yarn: ["add", "install", "remove", "upgrade"],
  pip: ["install", "uninstall"],
  pip3: ["install", "uninstall"],
  uv: ["pip install", "pip uninstall", "add", "remove", "sync", "lock"],
  cargo: ["install", "add", "remove", "uninstall"],
  gem: ["install", "uninstall"],
  bundle: ["install", "update", "add"],
  composer: ["install", "update", "require", "remove"],
  go: ["install", "get"],
};

const npmCredentialMutations = [
  "publish",
  "link",
  "login",
  "logout",
  "token",
  "pkg set",
  "config set",
  "config delete",
  "audit fix",
] as const;
const pnpmCredentialMutations = ["publish", "dlx", "link"] as const;
const yarnCredentialMutations = [
  "publish",
  "dlx",
  "link",
  "config set",
] as const;
const uvCredentialMutations = ["publish", "tool install"] as const;

function dependencyMutationRules(decision: "allow" | "deny"): Rule[] {
  return Object.entries(dependencyMutationSubcommands).flatMap(
    ([executable, subcommands]) =>
      subcommands.flatMap((subcommand): Rule[] => [
        {
          pattern: `${executable} ${subcommand}`,
          decision,
          ...(decision === "deny" ? { guidance: npmMutationGuidance } : {}),
        },
        {
          pattern: `${executable} ${subcommand} *`,
          decision,
          ...(decision === "deny" ? { guidance: npmMutationGuidance } : {}),
        },
      ]),
  );
}

/**
 * Guard variant (`ruleset:deps-mutations-guard`): deny dependency
 * mutations. Standard posture; `builtin:default` composes it after
 * `ruleset:packageManagers`.
 */
export const dependencyMutationGuardRules: Rule[] =
  dependencyMutationRules("deny");

/**
 * Opener variant (`ruleset:deps-mutations-allow`): allow dependency
 * mutations. Decision twin of the deny variant; `builtin:deps-mutator`
 * composes it in the deny variant's place.
 */
export const dependencyMutationAllowRules: Rule[] =
  dependencyMutationRules("allow");

/**
 * Test and build invocation allows (`ruleset:test-run`) for read-mostly
 * profiles (`builtin:reviewer`): run the project's checks without opening
 * writes.
 */
export const testRunRules: Rule[] = [
  { pattern: "npm run *", decision: "allow" },
  { pattern: "npm test", decision: "allow" },
  { pattern: "npm test *", decision: "allow" },
  { pattern: "pnpm run *", decision: "allow" },
  { pattern: "pnpm test", decision: "allow" },
  { pattern: "pnpm test *", decision: "allow" },
  { pattern: "yarn run *", decision: "allow" },
  { pattern: "yarn test", decision: "allow" },
  { pattern: "yarn test *", decision: "allow" },
  { pattern: "cargo build", decision: "allow" },
  { pattern: "cargo build *", decision: "allow" },
  { pattern: "cargo test", decision: "allow" },
  { pattern: "cargo test *", decision: "allow" },
  { pattern: "cargo check", decision: "allow" },
  { pattern: "cargo check *", decision: "allow" },
  { pattern: "cargo clippy", decision: "allow" },
  { pattern: "cargo clippy *", decision: "allow" },
  { pattern: "go build", decision: "allow" },
  { pattern: "go build *", decision: "allow" },
  { pattern: "go test", decision: "allow" },
  { pattern: "go test *", decision: "allow" },
  // Keep the existing broad Go posture; explicit build/test rules above also
  // declare the subcommands the path evaluator can recognize as syntax.
  { pattern: "go *", decision: "allow" },
];

/**
 * Base package-manager policy (`ruleset:packageManagers`): unknown commands
 * ask, read-only queries allow, and credential/publishing mutations deny.
 * Contains no dependency-mutation rules; compose it with
 * `ruleset:deps-mutations-guard` (standard posture, as `builtin:default`
 * does) or `ruleset:deps-mutations-allow` (dependency-work posture, as
 * `builtin:deps-mutator` does).
 */
export const packageManagerRules: Rule[] = [
  { pattern: "npm *", decision: "ask" },
  { pattern: "npm run *", decision: "allow" },
  { pattern: "npm test", decision: "allow" },
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
  ...packageManagerMutationDenials("npm", npmCredentialMutations),
  { pattern: "npm version *", decision: "deny", guidance: npmMutationGuidance },

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
  ...packageManagerMutationDenials("pnpm", pnpmCredentialMutations),
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
  ...packageManagerMutationDenials("yarn", yarnCredentialMutations),

  { pattern: "pip *", decision: "ask" },
  { pattern: "pip list", decision: "allow" },
  { pattern: "pip list *", decision: "allow" },
  { pattern: "pip show", decision: "allow" },
  { pattern: "pip show *", decision: "allow" },
  { pattern: "pip freeze", decision: "allow" },
  { pattern: "pip freeze *", decision: "allow" },

  { pattern: "pip3 *", decision: "ask" },
  { pattern: "pip3 list", decision: "allow" },
  { pattern: "pip3 list *", decision: "allow" },
  { pattern: "pip3 show", decision: "allow" },
  { pattern: "pip3 show *", decision: "allow" },
  { pattern: "pip3 freeze", decision: "allow" },
  { pattern: "pip3 freeze *", decision: "allow" },

  { pattern: "uv *", decision: "ask" },
  { pattern: "uv pip list", decision: "allow" },
  { pattern: "uv pip list *", decision: "allow" },
  { pattern: "uv pip show", decision: "allow" },
  { pattern: "uv pip show *", decision: "allow" },
  { pattern: "uv pip freeze", decision: "allow" },
  { pattern: "uv pip freeze *", decision: "allow" },
  { pattern: "uv tree", decision: "allow" },
  { pattern: "uv tree *", decision: "allow" },
  ...packageManagerMutationDenials("uv", uvCredentialMutations),

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
  ...packageManagerMutationDenials("cargo", ["publish"]),

  { pattern: "gem *", decision: "ask" },
  { pattern: "gem list", decision: "allow" },
  { pattern: "gem list *", decision: "allow" },
  ...packageManagerMutationDenials("gem", ["push"]),

  { pattern: "bundle *", decision: "ask" },
  { pattern: "bundle list", decision: "allow" },
  { pattern: "bundle list *", decision: "allow" },

  { pattern: "composer *", decision: "ask" },
  { pattern: "composer show", decision: "allow" },
  { pattern: "composer show *", decision: "allow" },

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
];
