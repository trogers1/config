const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { createRequire } = require("node:module");

const piRequire = createRequire(
  "/Users/taylor.rogers/.nvm/versions/node/v24.13.1/lib/node_modules/@earendil-works/pi-coding-agent/package.json",
);
const { createJiti } = piRequire("jiti");
const jiti = createJiti(__dirname + "/");
const permissions = jiti("../extensions/permissions.ts");

const policy = {
  tools: {
    bash: [
      { pattern: "*", decision: "ask" },
      { pattern: "git *", decision: "ask" },
      { pattern: "git status *", decision: "allow" },
      { pattern: "git checkout *", decision: "deny" },
      { pattern: "npm *", decision: "allow" },
      { pattern: "npm publish *", decision: "deny" },
      { pattern: "npx tsc --noEmit", decision: "allow" },
      { pattern: "ls", decision: "allow" },
      { pattern: "ls *", decision: "allow" },
      { pattern: "printf *", decision: "allow" },
    ],
  },
  bashPathReferences: [
    { pattern: "*", decision: "allow" },
    { pattern: "../**", decision: "ask" },
    { pattern: "**/.env", decision: "deny" },
    { pattern: "**/.git/**", decision: "deny" },
  ],
};

function ctx({ confirm = true, cwd = process.cwd() } = {}) {
  return {
    cwd,
    hasUI: true,
    ui: {
      confirm: async () => confirm,
      setStatus: () => {},
    },
  };
}

test("more specific later allow overrides less specific ask", () => {
  assert.equal(permissions.decideBash("git status --short", policy), "allow");
});

test("more specific later deny overrides less specific allow", () => {
  assert.equal(permissions.decideBash("npm publish --dry-run", policy), "deny");
});

test("default ask catches unspecified commands", () => {
  assert.equal(permissions.decideBash("python scripts/build.py", policy), "ask");
});

test("quoted separators do not split commands", () => {
  assert.deepEqual(permissions.splitShellCommands('printf "a;b && c || d | e" && git status --short'), [
    'printf "a;b && c || d | e"',
    "git status --short",
  ]);
});

test("compound command with denied segment is denied", async () => {
  const result = await permissions.gateBash("git status --short && git checkout main", process.cwd(), ctx(), policy);
  assert.equal(result.block, true);
  assert.match(result.reason, /denied/i);
});

test("command substitution with denied command is denied", async () => {
  const result = await permissions.gateBash('echo "branch $(git checkout main)"', process.cwd(), ctx(), policy);
  assert.equal(result.block, true);
  assert.match(result.reason, /denied/i);
});

test("backtick command substitution with denied command is denied", async () => {
  const result = await permissions.gateBash("echo `git checkout main`", process.cwd(), ctx(), policy);
  assert.equal(result.block, true);
  assert.match(result.reason, /denied/i);
});

test("single quotes are treated as inert text, not command substitution", async () => {
  const result = await permissions.gateBash("printf '$(git checkout main)'", process.cwd(), ctx(), policy);
  assert.equal(result, undefined);
});

test("allowed segments with semicolon separators are allowed without confirmation", async () => {
  let confirmations = 0;
  const result = await permissions.gateBash(
    "git status --short; npx tsc --noEmit",
    process.cwd(),
    {
      ...ctx(),
      ui: {
        confirm: async () => {
          confirmations++;
          return true;
        },
        setStatus: () => {},
      },
    },
    policy,
  );
  assert.equal(result, undefined);
  assert.equal(confirmations, 0);
});

test("unknown segment in compound command asks", async () => {
  let confirmations = 0;
  const result = await permissions.gateBash(
    "git status --short && python scripts/build.py",
    process.cwd(),
    {
      ...ctx(),
      ui: {
        confirm: async () => {
          confirmations++;
          return true;
        },
        setStatus: () => {},
      },
    },
    policy,
  );
  assert.equal(result, undefined);
  assert.equal(confirmations, 1);
});

test("outside path in bash asks before running", async () => {
  const startupCwd = path.join(process.cwd(), "project");
  let confirmations = 0;
  await permissions.gateBash(
    "ls ../other",
    startupCwd,
    {
      ...ctx({ cwd: startupCwd }),
      ui: {
        confirm: async () => {
          confirmations++;
          return true;
        },
        setStatus: () => {},
      },
    },
    policy,
  );
  assert.equal(confirmations, 1);
});

test("glob patterns support protected root and nested paths", () => {
  assert.equal(permissions.matchesGlobPattern("**/.env", ".env"), true);
  assert.equal(permissions.matchesGlobPattern("**/.env", "app/.env"), true);
  assert.equal(permissions.matchesGlobPattern("**/.git/**", ".git/config"), true);
  assert.equal(permissions.matchesGlobPattern("../**", "../other/file.txt"), true);
});

test("parsed command preview shows numbered colorized decisions", () => {
  const preview = permissions.formatParsedCommands("git status --short && npm publish --dry-run", policy);

  assert.match(preview, /1\. \[\x1b\[34mallow\x1b\[0m\] git status --short/);
  assert.match(preview, /2\. \[\x1b\[31mdeny\x1b\[0m\] npm publish --dry-run/);
});

test("bash confirmation shows raw command before parsed command preview", async () => {
  const messages = [];
  await permissions.gateBash("python scripts/build.py", process.cwd(), {
    ...ctx(),
    ui: {
      confirm: async (_title, message) => {
        messages.push(message);
        return false;
      },
    },
  }, policy);

  assert.match(messages[0], /^Raw command:\npython scripts\/build\.py\n\nParsed command segments:/);
  assert.match(messages[0], /\x1b\[33mask\x1b\[0m/);
});
