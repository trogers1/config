import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import permissionsExtension, {
  decideBash,
  decideCustomTool,
  extractShellCommands,
  gateBash,
  matchesGlobPattern,
  splitShellCommands,
} from "../extensions/permissions";
import { policyConfig } from "../modules/policy";
import type { CustomToolRule, ProfilePolicy } from "../modules/policyHelpers";

const parserPolicy = {
  tools: {
    bash: [
      { pattern: "*", decision: "ask" },
      { pattern: "git *", decision: "ask" },
      { pattern: "git status *", decision: "allow" },
      { pattern: "git checkout *", decision: "deny" },
      { pattern: "cd", decision: "allow" },
      { pattern: "cd *", decision: "allow" },
      { pattern: "ls", decision: "allow" },
      { pattern: "ls *", decision: "allow" },
      { pattern: "printf *", decision: "allow" },
    ],
  },
  readPaths: [
    { pattern: "*", decision: "allow" },
    { pattern: "..", decision: "ask" },
    { pattern: "../**", decision: "ask" },
  ],
  writePaths: [
    { pattern: "*", decision: "allow" },
    { pattern: "..", decision: "ask" },
    { pattern: "../**", decision: "ask" },
  ],
} satisfies ProfilePolicy;

function context(cwd: string, confirm = true) {
  return {
    cwd,
    hasUI: true,
    ui: {
      confirm: vi.fn().mockResolvedValue(confirm),
      editor: vi.fn().mockResolvedValue(undefined),
      setWorkingVisible: vi.fn(),
    },
  } as unknown as ExtensionContext;
}

function nonInteractiveContext(cwd: string) {
  return {
    cwd,
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      confirm: vi.fn(),
    },
    sessionManager: {
      getEntries: () => [],
    },
  } as unknown as ExtensionContext;
}

function createExtensionHarness() {
  const handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => unknown
  >();
  const commands = new Map<
    string,
    { handler?: (args: string, ctx: ExtensionContext) => unknown }
  >();
  const api = {
    on(
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) {
      handlers.set(event, handler);
    },
    registerCommand(
      name: string,
      command: { handler?: (args: string, ctx: ExtensionContext) => unknown },
    ) {
      commands.set(name, command);
    },
    appendEntry: vi.fn(),
  } as unknown as Parameters<typeof permissionsExtension>[0];

  return { api, handlers, commands };
}

describe("shell policy parser", () => {
  it("uses the final matching rule", () => {
    expect(decideBash("git status --short", parserPolicy)).toBe("allow");
    expect(decideBash("git checkout main", parserPolicy)).toBe("deny");
    expect(decideBash("python scripts/build.py", parserPolicy)).toBe("ask");
  });

  it("does not split quoted separators", () => {
    expect(
      splitShellCommands('printf "a;b && c || d | e" && git status --short'),
    ).toEqual(['printf "a;b && c || d | e"', "git status --short"]);
  });

  it("finds substitutions while treating single-quoted text as inert", () => {
    expect(
      extractShellCommands(
        "printf '$(git checkout inert)' && echo \"$(git checkout active)\"",
      ),
    ).toContain("git checkout active");
    expect(
      extractShellCommands("printf '$(git checkout inert)'")
        .join(" ")
        .includes("git checkout inert"),
    ).toBe(true);
    // The inert text remains part of printf, but is not emitted as its own command.
    expect(
      extractShellCommands("printf '$(git checkout inert)'").filter(
        (command) => command === "git checkout inert",
      ),
    ).toEqual([]);
  });

  it("fails closed when unbash reports a parse error", async () => {
    const ctx = context(process.cwd(), false);
    const result = await gateBash(
      "git status 'unterminated",
      process.cwd(),
      ctx,
      parserPolicy,
    );

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("could not be classified completely");
    expect(vi.mocked(ctx.ui.confirm)).toHaveBeenCalledWith(
      "Allow Bash command with parse errors?",
      expect.stringContaining("unterminated"),
    );
  });

  it("denies a compound command when any parsed segment is denied", async () => {
    const result = await gateBash(
      "git status --short && git checkout main",
      process.cwd(),
      context(process.cwd()),
      parserPolicy,
    );

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("git checkout main");
  });

  it("denies commands hidden in both substitution syntaxes", async () => {
    for (const command of [
      'echo "$(git checkout main)"',
      "echo `git checkout main`",
    ]) {
      await expect(
        gateBash(command, process.cwd(), context(process.cwd()), parserPolicy),
      ).resolves.toMatchObject({ block: true });
    }
  });

  it("enforces profile-configured protected path patterns for Bash readers", async () => {
    const policy = {
      ...parserPolicy,
      protectedPathPatterns: ["**/.db"],
    } satisfies ProfilePolicy;

    const result = await gateBash(
      "cat .db",
      process.cwd(),
      context(process.cwd()),
      policy,
    );
    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("protected from disclosure and mutation");
  });

  it("simulates cwd changes before evaluating later path references", async () => {
    const startupCwd = path.join(process.cwd(), "project");
    const ctx = context(startupCwd);

    await expect(
      gateBash(
        "cd docs && cd drafts && ls ../../..",
        startupCwd,
        ctx,
        parserPolicy,
      ),
    ).resolves.toBeUndefined();
    expect(vi.mocked(ctx.ui.confirm).mock.calls).toHaveLength(1);
  });

  it("supports root, nested, and outside glob paths", () => {
    expect(matchesGlobPattern("**/.env", ".env")).toBe(true);
    expect(matchesGlobPattern("**/.env", "app/.env")).toBe(true);
    expect(matchesGlobPattern("**/.git/**", ".git/config")).toBe(true);
    expect(matchesGlobPattern("../**", "../other/file.txt")).toBe(true);
  });
});

describe("custom tool policy", () => {
  const rules: CustomToolRule[] = [
    { decision: "ask" },
    {
      decision: "deny",
      match: { environment: "production", "metadata.team": "platform-*" },
      guidance: "Production deployments require approval.",
    },
    {
      decision: "allow",
      match: { environment: "staging" },
    },
  ];

  it("uses property matches and lets later matching rules win", () => {
    expect(
      decideCustomTool(
        { environment: "production", metadata: { team: "platform-api" } },
        rules,
      ),
    ).toMatchObject({
      decision: "deny",
      rule: { guidance: "Production deployments require approval." },
    });
    expect(decideCustomTool({ environment: "staging" }, rules).decision).toBe(
      "allow",
    );
  });

  it("falls back to ask when no custom tool rule matches", () => {
    expect(
      decideCustomTool({ action: "inspect" }, [
        { decision: "deny", match: { action: "delete" } },
      ]).decision,
    ).toBe("ask");
  });
});

describe("default profile bash policy", () => {
  it.each(["default", "read-only"] as const)(
    "allows Pi documentation outside the startup directory in the %s profile",
    async (profile) => {
      const piDocs = path.join(
        homedir(),
        ".nvm",
        "versions",
        "node",
        "vtest",
        "lib",
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "docs",
        "extensions.md",
      );
      const ctx = context(process.cwd());

      await expect(
        gateBash(
          `cat ${piDocs}`,
          process.cwd(),
          ctx,
          policyConfig.profiles[profile],
        ),
      ).resolves.toBeUndefined();
      expect(vi.mocked(ctx.ui.confirm)).not.toHaveBeenCalled();
    },
  );

  it.each(["default", "read-only"] as const)(
    "allows dependencies inside the local Pi packages in the %s profile",
    async (profile) => {
      const ctx = context(process.cwd());
      const packageDependency = path.join(
        process.cwd(),
        "node_modules",
        "vitest",
        "package.json",
      );

      await expect(
        gateBash(
          `cat ${packageDependency}`,
          path.join(process.cwd(), "test-project"),
          ctx,
          policyConfig.profiles[profile],
        ),
      ).resolves.toBeUndefined();
      expect(vi.mocked(ctx.ui.confirm)).not.toHaveBeenCalled();
    },
  );

  it("gates basename, dynamic, and Git object operands under restrictive write paths", async () => {
    const restrictivePolicy = structuredClone(policyConfig.profiles.default);
    restrictivePolicy.writePaths = [
      { pattern: "**", decision: "deny" },
      { pattern: "modules/**", decision: "allow" },
      { pattern: "allowed", decision: "allow" },
      { pattern: "allowed/**", decision: "allow" },
      { pattern: "startup-file", decision: "allow" },
    ];
    const ctx = context(process.cwd(), false);

    await expect(
      gateBash(
        "rg needle modules/allowed.ts",
        process.cwd(),
        ctx,
        restrictivePolicy,
      ),
    ).resolves.toBeUndefined();
    await expect(
      gateBash(
        "rg --glob 'modules/**' needle modules/allowed.ts",
        process.cwd(),
        ctx,
        restrictivePolicy,
      ),
    ).resolves.toBeUndefined();

    for (const command of [
      "rg needle package.json",
      "rg --ignore-file=../blocked needle modules/allowed.ts",
      "rg --file=../blocked needle modules/allowed.ts",
      "rg -f../blocked needle modules/allowed.ts",
      "find modules -fprint ../blocked",
      "cat credentials.txt",
      "git diff package.json other.json",
      "git blame private.txt",
      "git show path:name",
      "git diff --no-index ./allowed ../blocked:name",
      "git log -- path:name",
      "git blame -- path:name",
      "true < input.json",
      'true < "$INPUT"',
      'git diff --no-index "$LEFT" "$RIGHT"',
      'git log > "$OUTPUT"',
    ]) {
      await expect(
        gateBash(command, process.cwd(), ctx, restrictivePolicy),
        command,
      ).resolves.toMatchObject({ block: true });
    }

    await expect(
      gateBash(
        "git show HEAD~3:src/example.ts",
        process.cwd(),
        ctx,
        restrictivePolicy,
      ),
    ).resolves.toBeUndefined();
    await expect(
      gateBash("git show HEAD", process.cwd(), ctx, restrictivePolicy),
    ).resolves.toBeUndefined();
    await expect(
      gateBash("git rev-parse HEAD~3", process.cwd(), ctx, restrictivePolicy),
    ).resolves.toBeUndefined();
  });

  it("preserves cwd for subshells and blocks conditional or dynamic cwd control flow", async () => {
    const restrictivePolicy = structuredClone(policyConfig.profiles.default);
    restrictivePolicy.writePaths = [
      { pattern: "*", decision: "deny" },
      { pattern: "allowed", decision: "allow" },
      { pattern: "allowed/file", decision: "allow" },
      { pattern: "first", decision: "allow" },
      { pattern: "first/**", decision: "allow" },
      { pattern: "second", decision: "allow" },
      { pattern: "second/**", decision: "allow" },
      { pattern: "startup-file", decision: "allow" },
    ];

    await expect(
      gateBash(
        "cd allowed; cat ./file",
        process.cwd(),
        context(process.cwd()),
        restrictivePolicy,
      ),
    ).resolves.toBeUndefined();

    await expect(
      gateBash(
        "(cd allowed; cat ./file); cat ./startup-file",
        process.cwd(),
        context(process.cwd()),
        restrictivePolicy,
      ),
    ).resolves.toBeUndefined();

    await expect(
      gateBash(
        "cd first || cd second; cat ./startup-file",
        process.cwd(),
        nonInteractiveContext(process.cwd()),
        restrictivePolicy,
      ),
    ).resolves.toMatchObject({ block: true });

    await expect(
      gateBash(
        'cd "$TARGET"; cat ./startup-file',
        process.cwd(),
        nonInteractiveContext(process.cwd()),
        restrictivePolicy,
      ),
    ).resolves.toMatchObject({ block: true });
  });

  it("does not allow arbitrary node_modules directories", async () => {
    const ctx = context(process.cwd(), false);
    const unrelatedDependency = path.join(
      homedir(),
      "unrelated",
      "node_modules",
      "package.json",
    );

    await expect(
      gateBash(
        `cat ${unrelatedDependency}`,
        process.cwd(),
        ctx,
        policyConfig.profiles.default,
      ),
    ).resolves.toMatchObject({ block: true });
    expect(vi.mocked(ctx.ui.confirm)).toHaveBeenCalled();
  });

  it.each([
    "git tag --sort=version:refname",
    "git tag --sort version:refname",
    "git tag -l",
    "git tag --list",
    "git tag --contains v1.0.0",
    "git tag --merged main",
  ])("allows %s", (command) => {
    expect(decideBash(command, policyConfig.profiles.default)).toBe("allow");
  });

  it.each([
    "git tag -a v1.0.0",
    "git tag -d v1.0.0",
    "git tag -m 'message' v1.0.0",
    "git tag --delete v1.0.0",
  ])("denies %s", (command) => {
    expect(decideBash(command, policyConfig.profiles.default)).toBe("deny");
  });
});

describe("extension harness custom tool inheritance", () => {
  it("prompts for an inherited empty custom tool and blocks without a UI", async () => {
    const configPath = path.join(
      fs.mkdtempSync(path.join(tmpdir(), "pi-permissions-")),
      "profiles.jsonc",
    );
    fs.writeFileSync(
      configPath,
      `{
        "defaultProfile": "default",
        "profiles": {
          "deployment-base": {
            "extends": "default",
            "tools": {
              "deploy": [
                { "decision": "deny", "match": { "environment": "production" } }
              ]
            }
          },
          "deployment-child": {
            "extends": "deployment-base",
            "tools": {
              "deploy": []
            }
          }
        }
      }`,
    );

    const previousConfigPath = process.env.PI_PERMISSIONS_PROFILE_CONFIG;
    const previousSubagentProfile = process.env.PI_SUBAGENT_PROFILE;
    process.env.PI_PERMISSIONS_PROFILE_CONFIG = configPath;
    process.env.PI_SUBAGENT_PROFILE = "deployment-child";

    try {
      const { api, handlers } = createExtensionHarness();
      permissionsExtension(api);

      const sessionStart = handlers.get("session_start");
      expect(sessionStart).toBeDefined();
      await sessionStart?.({ type: "session_start" }, {
        cwd: process.cwd(),
        hasUI: false,
        ui: {
          setStatus: vi.fn(),
          notify: vi.fn(),
          confirm: vi.fn(),
        },
        sessionManager: { getEntries: () => [] },
      } as unknown as ExtensionContext);

      const toolCall = handlers.get("tool_call");
      expect(toolCall).toBeDefined();
      const ctx = nonInteractiveContext(process.cwd());
      const result = await toolCall?.(
        {
          type: "tool_call",
          toolName: "deploy",
          input: { environment: "production" },
        },
        ctx,
      );

      expect(result).toMatchObject({ block: true });
      expect(String((result as { reason?: string }).reason)).toContain(
        "deploy was not approved",
      );
      expect(vi.mocked(ctx.ui.confirm)).not.toHaveBeenCalled();
    } finally {
      if (previousConfigPath === undefined) {
        delete process.env.PI_PERMISSIONS_PROFILE_CONFIG;
      } else {
        process.env.PI_PERMISSIONS_PROFILE_CONFIG = previousConfigPath;
      }
      if (previousSubagentProfile === undefined) {
        delete process.env.PI_SUBAGENT_PROFILE;
      } else {
        process.env.PI_SUBAGENT_PROFILE = previousSubagentProfile;
      }
    }
  });
});
