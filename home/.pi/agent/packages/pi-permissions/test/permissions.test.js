const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { createRequire } = require("node:module");

const piRequire = createRequire(
  path.join(
    path.dirname(process.execPath),
    "..",
    "lib",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "package.json",
  ),
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
      { pattern: "cd", decision: "allow" },
      { pattern: "cd *", decision: "allow" },
      { pattern: "ls", decision: "allow" },
      { pattern: "ls *", decision: "allow" },
      { pattern: "printf *", decision: "allow" },
    ],
  },
  bashPathReferences: [
    { pattern: "*", decision: "allow" },
    { pattern: "..", decision: "ask" },
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
  assert.equal(
    permissions.decideBash("python scripts/build.py", policy),
    "ask",
  );
});

test("quoted separators do not split commands", () => {
  assert.deepEqual(
    permissions.splitShellCommands(
      'printf "a;b && c || d | e" && git status --short',
    ),
    ['printf "a;b && c || d | e"', "git status --short"],
  );
});

test("compound command with denied segment is denied", async () => {
  const result = await permissions.gateBash(
    "git status --short && git checkout main",
    process.cwd(),
    ctx(),
    policy,
  );
  assert.equal(result.block, true);
  assert.match(result.reason, /denied/i);
});

test("command substitution with denied command is denied", async () => {
  const result = await permissions.gateBash(
    'echo "branch $(git checkout main)"',
    process.cwd(),
    ctx(),
    policy,
  );
  assert.equal(result.block, true);
  assert.match(result.reason, /denied/i);
});

test("backtick command substitution with denied command is denied", async () => {
  const result = await permissions.gateBash(
    "echo `git checkout main`",
    process.cwd(),
    ctx(),
    policy,
  );
  assert.equal(result.block, true);
  assert.match(result.reason, /denied/i);
});

test("single quotes are treated as inert text, not command substitution", async () => {
  const result = await permissions.gateBash(
    "printf '$(git checkout main)'",
    process.cwd(),
    ctx(),
    policy,
  );
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
  assert.equal(
    permissions.matchesGlobPattern("**/.git/**", ".git/config"),
    true,
  );
  assert.equal(
    permissions.matchesGlobPattern("../**", "../other/file.txt"),
    true,
  );
});

test("parsed command preview shows numbered colorized decisions", () => {
  const preview = permissions.formatParsedCommands(
    "git status --short && npm publish --dry-run",
    policy,
  );

  assert.match(preview, /1\. \[\x1b\[34mallow\x1b\[0m\] git status --short/);
  assert.match(preview, /2\. \[\x1b\[31mdeny\x1b\[0m\] npm publish --dry-run/);
});

test("denied bash result includes raw command and parsed command preview", async () => {
  const result = await permissions.gateBash(
    "git status --short && npm publish --dry-run",
    process.cwd(),
    ctx(),
    policy,
  );

  assert.equal(result.block, true);
  assert.match(
    result.reason,
    /^Command denied by explicit rule\.\n\nRaw command:\ngit status --short && npm publish --dry-run\n\nParsed command segments:/,
  );
  assert.match(result.reason, /\x1b\[34mallow\x1b\[0m/);
  assert.match(result.reason, /\x1b\[31mdeny\x1b\[0m/);
});

test("explicit deny automatically returns policy guidance and alternatives", async () => {
  const steeringPolicy = {
    ...policy,
    tools: {
      ...policy.tools,
      bash: [
        ...policy.tools.bash,
        {
          pattern: "npx vitest *",
          decision: "deny",
          guidance:
            "Use the repository test script instead of invoking Vitest through npx.",
          alternatives: ["npm test -- <requested test filters>", "npm test"],
        },
      ],
    },
  };

  const result = await permissions.gateBash(
    "npx vitest src/example.test.ts",
    process.cwd(),
    ctx(),
    steeringPolicy,
  );

  assert.equal(result.block, true);
  assert.match(
    result.reason,
    /Policy guidance:\nUse the repository test script/,
  );
  assert.match(
    result.reason,
    /Suggested alternatives:\n- npm test -- <requested test filters>\n- npm test/,
  );
});

test("only the latest matching rule supplies automatic steering", async () => {
  const steeringPolicy = {
    ...policy,
    tools: {
      ...policy.tools,
      bash: [
        { pattern: "*", decision: "deny", guidance: "Generic guidance." },
        {
          pattern: "npx prettier *",
          decision: "deny",
          guidance: "Use the edit tool instead.",
        },
      ],
    },
  };

  const result = await permissions.gateBash(
    "npx prettier --write src/example.ts",
    process.cwd(),
    ctx(),
    steeringPolicy,
  );

  assert.match(result.reason, /Policy guidance:\nUse the edit tool instead\./);
  assert.doesNotMatch(result.reason, /Generic guidance/);
});

test("bash confirmation shows raw command before parsed command preview", async () => {
  const messages = [];
  await permissions.gateBash(
    "python scripts/build.py",
    process.cwd(),
    {
      ...ctx(),
      ui: {
        confirm: async (_title, message) => {
          messages.push(message);
          return false;
        },
      },
    },
    policy,
  );

  assert.match(
    messages[0],
    /^Raw command:\npython scripts\/build\.py\n\nParsed command segments:/,
  );
  assert.match(messages[0], /\x1b\[33mask\x1b\[0m/);
});

test("denied bash confirmation can include optional user steering", async () => {
  const result = await permissions.gateBash(
    "python scripts/build.py",
    process.cwd(),
    {
      ...ctx(),
      ui: {
        confirm: async () => false,
        editor: async (title, prefill) => {
          assert.match(title, /optional steering/i);
          assert.equal(prefill, "");
          return "Use npm test instead; do not run the custom build script.";
        },
      },
    },
    policy,
  );

  assert.equal(result.block, true);
  assert.match(
    result.reason,
    /Command was not approved: python scripts\/build\.py/,
  );
  assert.match(
    result.reason,
    /User steering after denial:\nUse npm test instead; do not run the custom build script\./,
  );
});

test("empty denied bash steering is omitted", async () => {
  const result = await permissions.gateBash(
    "python scripts/build.py",
    process.cwd(),
    {
      ...ctx(),
      ui: {
        confirm: async () => false,
        editor: async () => "   ",
      },
    },
    policy,
  );

  assert.equal(result.block, true);
  assert.match(
    result.reason,
    /Command was not approved: python scripts\/build\.py/,
  );
  assert.doesNotMatch(result.reason, /User steering after denial:/);
});

test("cd to a child directory is allowed without confirmation", async () => {
  const cwd = path.join(process.cwd(), "project");
  let confirmations = 0;
  const result = await permissions.gateBash(
    "cd " + path.join(cwd, "repo"),
    process.cwd(),
    {
      ...ctx({ cwd }),
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

test("cd to a parent directory inside startupCwd is allowed", async () => {
  const cwd = path.join(process.cwd(), "project");
  let confirmations = 0;
  const result = await permissions.gateBash(
    "cd ..",
    process.cwd(),
    {
      ...ctx({ cwd }),
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

test("compound cd chain: child, back, then outside startupCwd asks", async () => {
  const startupCwd = path.join(process.cwd(), "fred");

  // Static analyzer simulates cwd changes across segments:
  // cd docs -> /fred/docs (inside), cd .. -> /fred (inside),
  // cd .. -> /user (outside startupCwd)
  let confirmations = 0;
  const result = await permissions.gateBash(
    "cd docs && cd .. && cd ..",
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
  // Third cd .. resolves outside startupCwd
  assert.equal(result, undefined);
  assert.equal(confirmations, 1);
});

test("compound cd chain child then back is fully allowed", async () => {
  const startupCwd = path.join(process.cwd(), "fred");

  let confirmations = 0;
  const result = await permissions.gateBash(
    "cd docs && cd ..",
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
  assert.equal(result, undefined);
  assert.equal(confirmations, 0);
});

test("compound cd chain with absolute escape asks", async () => {
  const startupCwd = path.join(process.cwd(), "fred");

  let confirmations = 0;
  const result = await permissions.gateBash(
    "cd docs && cd /tmp",
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
  // cd docs is allowed, but cd /tmp references a path outside startupCwd.
  assert.equal(result, undefined);
  assert.equal(confirmations, 1);
});

test("mixed chain: non-cd path references tracked against simulated cwd", async () => {
  const startupCwd = path.join(process.cwd(), "fred");

  // /fred -> cd doc -> /fred/doc -> cd drafts -> /fred/doc/drafts
  // ls ../.. from /fred/doc/drafts -> /fred (inside)
  // ls ../../.. from /fred/doc/drafts -> /fred/.. (outside)
  let confirmations = 0;
  const result = await permissions.gateBash(
    "cd doc && cd drafts && ls ../.. xyz && ls ../../.. xyz",
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
  // Only the last find references a path outside startupCwd
  assert.equal(result, undefined);
  assert.equal(confirmations, 1);
});

test("cd with absolute path outside cwd still asks", async () => {
  const cwd = path.join(process.cwd(), "project");
  let confirmations = 0;
  await permissions.gateBash(
    "cd /tmp",
    process.cwd(),
    {
      ...ctx({ cwd }),
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
  // Command is allowed; only the outside path reference triggers the ask
  assert.equal(confirmations, 1);
});

test("bash path reference outside startupCwd still asks even if inside cwd", async () => {
  const startupCwd = path.join(process.cwd(), "project");
  const cwd = path.dirname(startupCwd);
  let confirmations = 0;
  await permissions.gateBash(
    "ls " + path.join(cwd, "docs"),
    startupCwd,
    {
      ...ctx({ cwd }),
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

test("bash path reference inside cwd still honors explicit deny rules", async () => {
  const startupCwd = path.join(process.cwd(), "project");
  const cwd = path.dirname(startupCwd);
  const result = await permissions.gateBash(
    "ls " + path.join(cwd, ".env"),
    startupCwd,
    {
      ...ctx({ cwd }),
      ui: {
        confirm: async () => true,
        setStatus: () => {},
      },
    },
    policy,
  );
  assert.equal(result.block, true);
  assert.match(result.reason, /denied/i);
});
