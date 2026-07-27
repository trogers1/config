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
      notify: vi.fn(),
      setStatus: vi.fn(),
      setWorkingVisible: vi.fn(),
    },
    sessionManager: {
      getEntries: () => [],
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
  const registeredTools = [
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
  ];
  const activeTools = new Set(["read", "bash", "edit", "write"]);
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
    getActiveTools: () => [...activeTools],
    getAllTools: () => registeredTools.map((name) => ({ name })),
    setActiveTools(toolNames: string[]) {
      activeTools.clear();
      for (const name of toolNames) {
        if (registeredTools.includes(name)) activeTools.add(name);
      }
    },
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

  it("blocks unbash parse errors without attempting a non-interactive prompt", async () => {
    const ctx = nonInteractiveContext(process.cwd());
    const result = await gateBash(
      "git status 'unterminated",
      process.cwd(),
      ctx,
      parserPolicy,
    );

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("could not be classified completely");
    expect(vi.mocked(ctx.ui.confirm)).not.toHaveBeenCalled();
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

  it("combines and deduplicates steering from every denied segment", async () => {
    const steeringPolicy = {
      ...parserPolicy,
      tools: {
        bash: [
          { pattern: "*", decision: "allow" },
          {
            pattern: "git checkout *",
            decision: "deny",
            guidance: "Switch branches with a dedicated tool instead.",
          },
          {
            pattern: "git reset *",
            decision: "deny",
            guidance: "Avoid history-rewriting resets.",
            alternatives: ["git stash push"],
          },
        ],
      },
    } satisfies ProfilePolicy;

    const combined = await gateBash(
      "git checkout main && git reset --hard",
      process.cwd(),
      context(process.cwd()),
      steeringPolicy,
    );
    expect(combined).toMatchObject({ block: true });
    expect(combined?.reason).toContain(
      "Switch branches with a dedicated tool instead.",
    );
    expect(combined?.reason).toContain("Avoid history-rewriting resets.");
    expect(combined?.reason).toContain("git stash push");

    // Two segments matching the same deny rule must not repeat its steering.
    const duplicated = await gateBash(
      "git checkout main && git checkout feature",
      process.cwd(),
      context(process.cwd()),
      steeringPolicy,
    );
    expect(duplicated).toMatchObject({ block: true });
    const guidance = "Switch branches with a dedicated tool instead.";
    expect(duplicated?.reason?.split(guidance)).toHaveLength(2);
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

  it("requires every property matcher to match before a rule applies", () => {
    const strictRules: CustomToolRule[] = [
      {
        decision: "deny",
        match: { environment: "production", "metadata.team": "platform-*" },
      },
    ];

    // Only one of the two matchers agrees, so the deny rule must not apply
    // and the configured tool falls back to the ask default.
    expect(
      decideCustomTool(
        { environment: "production", metadata: { team: "core" } },
        strictRules,
      ).decision,
    ).toBe("ask");
    // A missing property cannot satisfy its matcher either.
    expect(
      decideCustomTool({ environment: "production" }, strictRules).decision,
    ).toBe("ask");
  });

  it("matches non-string input values by their JSON representation", () => {
    const numericRules: CustomToolRule[] = [
      { decision: "allow" },
      { decision: "deny", match: { retries: "3" } },
    ];
    expect(decideCustomTool({ retries: 3 }, numericRules).decision).toBe(
      "deny",
    );
    expect(decideCustomTool({ retries: 4 }, numericRules).decision).toBe(
      "allow",
    );

    const structuredRules: CustomToolRule[] = [
      {
        decision: "deny",
        match: { flag: "true", "metadata.labels": '["hot"]' },
      },
    ];
    expect(
      decideCustomTool(
        { flag: true, metadata: { labels: ["hot"] } },
        structuredRules,
      ).decision,
    ).toBe("deny");
    expect(
      decideCustomTool(
        { flag: false, metadata: { labels: ["hot"] } },
        structuredRules,
      ).decision,
    ).toBe("ask");
  });
});

describe("default profile bash policy", () => {
  it("does not prompt for a static cd followed by an && command", async () => {
    const repositoryRoot = path.resolve(process.cwd(), "../../../../..");
    const ctx = context(repositoryRoot, false);

    await expect(
      gateBash(
        "cd home/.pi/agent/packages/pi-permissions && npm test",
        repositoryRoot,
        ctx,
        policyConfig.profiles.default,
      ),
    ).resolves.toBeUndefined();
    expect(vi.mocked(ctx.ui.confirm)).not.toHaveBeenCalled();
  });

  it("treats Git's bare -- separator as syntax rather than a path", async () => {
    const repositoryRoot = path.resolve(process.cwd(), "../../../../..");
    const ctx = context(repositoryRoot, false);

    await expect(
      gateBash(
        "git diff --stat -- home/.pi/agent/packages/pi-permissions/integrationTests",
        repositoryRoot,
        ctx,
        policyConfig.profiles.default,
      ),
    ).resolves.toBeUndefined();
    expect(vi.mocked(ctx.ui.confirm)).not.toHaveBeenCalled();
  });

  it("does not treat clustered short flags as gated paths", async () => {
    const ctx = context(process.cwd(), false);

    await expect(
      gateBash(
        "ls -la modules",
        process.cwd(),
        ctx,
        policyConfig.profiles.default,
      ),
    ).resolves.toBeUndefined();
    expect(vi.mocked(ctx.ui.confirm)).not.toHaveBeenCalled();
  });

  it("still gates path-shaped attached option values", async () => {
    const ctx = context(process.cwd(), false);

    const result = await gateBash(
      "ls --output=.env modules",
      process.cwd(),
      ctx,
      policyConfig.profiles.default,
    );
    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("--output=.env");
    expect(vi.mocked(ctx.ui.confirm)).toHaveBeenCalled();
  });

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

  it.each(['inspect "$TARGET"', 'inspect "${ROOT}/credentials"'])(
    "blocks an unresolved dynamic operand for an otherwise-allowed command: %s",
    async (command) => {
      const restrictivePolicy = {
        ...structuredClone(policyConfig.profiles.default),
        tools: {
          ...structuredClone(policyConfig.profiles.default.tools),
          bash: [
            ...(policyConfig.profiles.default.tools.bash ?? []),
            { pattern: "inspect *", decision: "allow" as const },
          ],
        },
        writePaths: [{ pattern: "**", decision: "deny" as const }],
      } satisfies ProfilePolicy;
      const ctx = nonInteractiveContext(process.cwd());
      const result = await gateBash(
        command,
        process.cwd(),
        ctx,
        restrictivePolicy,
      );

      expect(result).toMatchObject({ block: true });
      expect(vi.mocked(ctx.ui.confirm)).not.toHaveBeenCalled();
    },
  );

  it("blocks unresolved dynamic Git diff operands under restrictive writePaths", async () => {
    const restrictivePolicy = structuredClone(policyConfig.profiles.default);
    restrictivePolicy.writePaths = [{ pattern: "**", decision: "deny" }];
    const ctx = nonInteractiveContext(process.cwd());

    const result = await gateBash(
      'git diff "$LEFT" "$RIGHT"',
      process.cwd(),
      ctx,
      restrictivePolicy,
    );

    expect(result).toMatchObject({ block: true });
    expect(vi.mocked(ctx.ui.confirm)).not.toHaveBeenCalled();
  });

  it.each([
    'cat "$TARGET"',
    'cat "${ROOT}/credentials"',
    'git diff --no-index "$LEFT" "$RIGHT"',
    'node < "$INPUT"',
    'git log > "$OUTPUT"',
    'cd "$TARGET"; cat ./file',
  ])(
    "prompts interactively for the unresolved filesystem operand in %s",
    async (command) => {
      const restrictivePolicy = structuredClone(policyConfig.profiles.default);
      restrictivePolicy.writePaths = [{ pattern: "**", decision: "deny" }];
      const ctx = context(process.cwd(), true);

      await expect(
        gateBash(command, process.cwd(), ctx, restrictivePolicy),
      ).resolves.toBeUndefined();
      expect(vi.mocked(ctx.ui.confirm)).toHaveBeenCalledWith(
        "Bash command references a gated path?",
        expect.stringContaining(command),
      );
    },
  );

  it("gates the exact basename and redirection forms from the remediation matrix", async () => {
    const restrictivePolicy = structuredClone(policyConfig.profiles.default);
    restrictivePolicy.writePaths = [{ pattern: "**", decision: "deny" }];

    for (const command of [
      "node < input.json",
      "git log > history.txt",
      'cat "$TARGET"',
      'cat "${ROOT}/credentials"',
    ]) {
      await expect(
        gateBash(
          command,
          process.cwd(),
          nonInteractiveContext(process.cwd()),
          restrictivePolicy,
        ),
        command,
      ).resolves.toMatchObject({ block: true });
    }
  });

  it("treats explicit Git colon paths as paths at the gate", async () => {
    const restrictivePolicy = structuredClone(policyConfig.profiles.default);
    restrictivePolicy.writePaths = [{ pattern: "**", decision: "deny" }];

    for (const operand of [
      "./path:name",
      "../path:name",
      "/tmp/path:name",
      "~/path:name",
    ]) {
      await expect(
        gateBash(
          `git show ${operand}`,
          process.cwd(),
          nonInteractiveContext(process.cwd()),
          restrictivePolicy,
        ),
        operand,
      ).resolves.toMatchObject({ block: true });
    }
  });

  it("proves detached Git option values are non-path values before exempting them", async () => {
    const restrictivePolicy = structuredClone(policyConfig.profiles.default);
    restrictivePolicy.writePaths = [{ pattern: "**", decision: "deny" }];

    await expect(
      gateBash(
        "git tag --sort version:refname",
        process.cwd(),
        nonInteractiveContext(process.cwd()),
        restrictivePolicy,
      ),
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

  it.each([
    "if false; then cd allowed; else inspect ./file; fi",
    'case "$MODE" in allowed) cd allowed ;; *) inspect ./file ;; esac',
  ])(
    "blocks mutually exclusive branch paths instead of flattening cwd state: %s",
    async (command) => {
      const restrictivePolicy = {
        ...structuredClone(policyConfig.profiles.default),
        tools: {
          ...structuredClone(policyConfig.profiles.default.tools),
          bash: [
            ...(policyConfig.profiles.default.tools.bash ?? []),
            { pattern: "false", decision: "allow" as const },
            { pattern: "inspect *", decision: "allow" as const },
          ],
        },
        writePaths: [
          { pattern: "*", decision: "deny" as const },
          { pattern: "allowed", decision: "allow" as const },
          { pattern: "allowed/**", decision: "allow" as const },
        ],
      } satisfies ProfilePolicy;

      await expect(
        gateBash(
          command,
          process.cwd(),
          nonInteractiveContext(process.cwd()),
          restrictivePolicy,
        ),
      ).resolves.toMatchObject({ block: true });
    },
  );

  it("fails conservatively for && cwd uncertainty", async () => {
    const restrictivePolicy = structuredClone(policyConfig.profiles.default);
    restrictivePolicy.writePaths = [
      { pattern: "*", decision: "deny" },
      { pattern: "allowed", decision: "allow" },
      { pattern: "allowed/**", decision: "allow" },
    ];

    await expect(
      gateBash(
        "false && cd allowed; cat ./file",
        process.cwd(),
        nonInteractiveContext(process.cwd()),
        restrictivePolicy,
      ),
    ).resolves.toMatchObject({ block: true });
  });

  it("does not leak command or process substitution cwd into the outer shell", async () => {
    const restrictivePolicy = structuredClone(policyConfig.profiles.default);
    restrictivePolicy.writePaths = [
      { pattern: "*", decision: "deny" },
      { pattern: "allowed", decision: "allow" },
      { pattern: "allowed/**", decision: "allow" },
      { pattern: "startup-file", decision: "allow" },
    ];

    for (const command of [
      'echo "$(cd allowed)"; cat ./startup-file',
      "echo <(cd allowed); cat ./startup-file",
    ]) {
      await expect(
        gateBash(
          command,
          process.cwd(),
          context(process.cwd()),
          restrictivePolicy,
        ),
        command,
      ).resolves.toBeUndefined();
    }
  });

  it("persists cwd changes made by a brace group in the current shell", async () => {
    const restrictivePolicy = structuredClone(policyConfig.profiles.default);
    restrictivePolicy.writePaths = [
      { pattern: "*", decision: "deny" },
      { pattern: "allowed", decision: "allow" },
      { pattern: "allowed/**", decision: "allow" },
    ];

    await expect(
      gateBash(
        "{ cd allowed; cat ./file; }; cat ./file",
        process.cwd(),
        context(process.cwd()),
        restrictivePolicy,
      ),
    ).resolves.toBeUndefined();
  });

  it("allows package manager script names under restrictive writePaths", async () => {
    const restrictivePolicy = structuredClone(policyConfig.profiles.default);
    restrictivePolicy.writePaths = [{ pattern: "**", decision: "deny" }];
    const ctx = context(process.cwd(), false);

    for (const command of ["npm run check:types", "npm test"]) {
      await expect(
        gateBash(command, process.cwd(), ctx, restrictivePolicy),
        command,
      ).resolves.toBeUndefined();
    }
    expect(vi.mocked(ctx.ui.confirm)).not.toHaveBeenCalled();
  });

  it("gates package manager directory options as paths", async () => {
    const restrictivePolicy = structuredClone(policyConfig.profiles.default);
    restrictivePolicy.tools.bash = [
      ...(restrictivePolicy.tools.bash ?? []),
      { pattern: "npm --prefix *", decision: "allow" },
      { pattern: "npm --prefix=*", decision: "allow" },
      { pattern: "pnpm -C *", decision: "allow" },
    ];
    restrictivePolicy.writePaths = [
      { pattern: "**", decision: "deny" },
      { pattern: "pkg", decision: "allow" },
      { pattern: "pkg/**", decision: "allow" },
    ];

    await expect(
      gateBash(
        "npm --prefix pkg run test",
        process.cwd(),
        context(process.cwd(), false),
        restrictivePolicy,
      ),
    ).resolves.toBeUndefined();

    for (const command of [
      "npm --prefix ../blocked test",
      "npm --prefix=../blocked test",
      "pnpm -C ../blocked test",
    ]) {
      await expect(
        gateBash(
          command,
          process.cwd(),
          nonInteractiveContext(process.cwd()),
          restrictivePolicy,
        ),
        command,
      ).resolves.toMatchObject({ block: true });
    }
  });

  // cd gating matrix. cd mutates no files, so the target is never gated
  // against writePaths; but it repositions operand-less readers such as bare
  // `ls`, so the target is gated against readPaths (ls context), and the
  // protected-path overlay still applies. Whatever the destination, every
  // later operand is resolved against the tracked cwd and gated individually.
  // Each test is independent and pins one edge of this matrix.
  describe("cd gating", () => {
    it("allows cd into a write-denied directory, because cd itself cannot write", async () => {
      // Every operand after the cd is still resolved against the tracked cwd
      // and gated individually (see the 'cd project && cat ...' test below), so
      // letting navigation through writePaths cannot enable any write.
      const policy = structuredClone(policyConfig.profiles.default);
      policy.writePaths = [{ pattern: "**", decision: "deny" }];
      const ctx = context(process.cwd(), false);

      await expect(
        gateBash("cd project", process.cwd(), ctx, policy),
      ).resolves.toBeUndefined();
      expect(vi.mocked(ctx.ui.confirm)).not.toHaveBeenCalled();
    });

    it("denies cd into a read-denied directory, because cd repositions readers", async () => {
      // Operand-less commands such as bare `ls` read whatever directory the
      // shell is in, so the cd destination is gated against readPaths.
      const policy = structuredClone(policyConfig.profiles.default);
      policy.readPaths = [{ pattern: "**", decision: "deny" }];

      await expect(
        gateBash(
          "cd project",
          process.cwd(),
          nonInteractiveContext(process.cwd()),
          policy,
        ),
      ).resolves.toMatchObject({ block: true });
    });

    it("still denies cd into protected paths", async () => {
      const result = await gateBash(
        "cd .git",
        process.cwd(),
        context(process.cwd(), false),
        policyConfig.profiles.default,
      );

      expect(result).toMatchObject({ block: true });
      expect(result?.reason).toContain(
        "protected from disclosure and mutation",
      );
    });

    it("still gates operands against the directory tracked through cd", async () => {
      // The follow-up guarantee that makes ungated navigation safe: after
      // `cd project`, relative operands are evaluated against `project`, not
      // the startup directory.
      const restrictivePolicy = structuredClone(policyConfig.profiles.default);
      restrictivePolicy.writePaths = [
        { pattern: "**", decision: "deny" },
        { pattern: "project/allowed", decision: "allow" },
      ];

      await expect(
        gateBash(
          "cd project && cat allowed",
          process.cwd(),
          context(process.cwd(), false),
          restrictivePolicy,
        ),
      ).resolves.toBeUndefined();

      await expect(
        gateBash(
          "cd project && cat secret",
          process.cwd(),
          nonInteractiveContext(process.cwd()),
          restrictivePolicy,
        ),
      ).resolves.toMatchObject({ block: true });
    });
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
    "npm test",
    "npm test -- modules/shell/classify.test.ts",
    "npm run test:watch",
    "npm run check:types",
    "npm run check:prettier",
    "npm start",
    "npm ls",
    "npm ls --depth=0",
    "npm view react version",
    "npm outdated",
    "npm audit",
    "npm config get registry",
    "npm explain typescript",
    "pnpm run build",
    "pnpm test",
    "pnpm ls",
    "yarn run build",
    "yarn test",
    "yarn list",
    "pip list",
    "pip show requests",
    "pip freeze",
    "pip3 list",
    "uv pip list",
    "uv tree",
    "cargo build",
    "cargo test",
    "cargo test -- --nocapture",
    "cargo check",
    "cargo clippy",
    "gem list",
    "bundle list",
    "composer show",
    // go keeps its pre-existing broad allow; only go install/go get are denied.
    "go build ./...",
    "go test ./...",
  ])(
    "allows safe package manager commands without prompting: %s",
    (command) => {
      expect(decideBash(command, policyConfig.profiles.default)).toBe("allow");
    },
  );

  it.each([
    "npm install",
    "npm install lodash",
    "npm i -D typescript",
    "npm ci",
    "npm update",
    "npm uninstall lodash",
    "npm publish",
    "npm exec cowsay",
    "npm link",
    "npm audit fix",
    "npm pkg set name=evil",
    "npm version patch",
    "npm config set registry https://evil.example",
    "npm login",
    "npm token list",
    "pnpm add lodash",
    "pnpm install",
    "pnpm dlx cowsay",
    "pnpm audit --fix",
    "yarn add lodash",
    "yarn install",
    "yarn upgrade",
    "yarn publish",
    "pip install requests",
    "pip uninstall requests",
    "pip3 install requests",
    "uv pip install requests",
    "uv add requests",
    "uv sync",
    "uv lock",
    "cargo install ripgrep",
    "cargo add serde",
    "cargo publish",
    "go install github.com/example/tool@latest",
    "go get github.com/example/module",
    "gem install rails",
    "gem push example.gem",
    "bundle install",
    "bundle update",
    "composer install",
    "composer require vendor/package",
  ])("denies mutating package manager commands: %s", (command) => {
    expect(decideBash(command, policyConfig.profiles.default)).toBe("deny");
  });

  it.each([
    "npm pack",
    "npm dedupe",
    "npm whoami",
    "npm version",
    // Arbitrary execution through the project environment must stay gated.
    "uv run python main.py",
    "uvx cowsay",
    "bundle exec rake db:migrate",
    "cargo fmt",
    "cargo clean",
    "composer outdated",
  ])("asks for uncommon package manager commands: %s", (command) => {
    expect(decideBash(command, policyConfig.profiles.default)).toBe("ask");
  });

  it("steers denied package manager mutations toward asking the user", async () => {
    const result = await gateBash(
      "npm install lodash",
      process.cwd(),
      context(process.cwd(), false),
      policyConfig.profiles.default,
    );

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("Ask the user");
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
    const configDirectory = fs.mkdtempSync(
      path.join(tmpdir(), "pi-permissions-"),
    );
    const configPath = path.join(configDirectory, "profiles.jsonc");
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
      const interactiveHarness = createExtensionHarness();
      permissionsExtension(interactiveHarness.api);
      const interactiveSessionStart =
        interactiveHarness.handlers.get("session_start");
      const interactiveCtx = context(process.cwd(), true);
      await interactiveSessionStart?.(
        { type: "session_start" },
        interactiveCtx,
      );
      const interactiveToolCall = interactiveHarness.handlers.get("tool_call");
      const interactiveResult = await interactiveToolCall?.(
        {
          type: "tool_call",
          toolName: "deploy",
          input: { environment: "production" },
        },
        interactiveCtx,
      );

      expect(interactiveResult).toBeUndefined();
      expect(vi.mocked(interactiveCtx.ui.confirm)).toHaveBeenCalledWith(
        "Allow deploy?",
        "deploy matched a custom tool policy requiring confirmation.",
      );

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
      fs.rmSync(configDirectory, { recursive: true, force: true });
    }
  });

  it("enforces both inherited and appended non-empty custom tool rules", async () => {
    const configDirectory = fs.mkdtempSync(
      path.join(tmpdir(), "pi-permissions-"),
    );
    const configPath = path.join(configDirectory, "profiles.jsonc");
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
              "deploy": [
                { "decision": "allow", "match": { "environment": "staging" } }
              ]
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
      const ctx = nonInteractiveContext(process.cwd());
      await handlers.get("session_start")?.({ type: "session_start" }, ctx);
      const toolCall = handlers.get("tool_call");

      const inheritedDenial = await toolCall?.(
        {
          type: "tool_call",
          toolName: "deploy",
          input: { environment: "production" },
        },
        ctx,
      );
      expect(inheritedDenial).toMatchObject({ block: true });
      expect(String((inheritedDenial as { reason?: string }).reason)).toContain(
        "deploy denied by custom tool policy",
      );

      await expect(
        toolCall?.(
          {
            type: "tool_call",
            toolName: "deploy",
            input: { environment: "staging" },
          },
          ctx,
        ),
      ).resolves.toBeUndefined();
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
      fs.rmSync(configDirectory, { recursive: true, force: true });
    }
  });
});
