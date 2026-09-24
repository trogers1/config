import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isFocusable, type Component } from "@earendil-works/pi-tui";
import permissionsExtension, {
  decideBash,
  decideCustomTool,
  explicitBashPermissionTitle,
  extractShellCommands,
  gateBash,
  matchesGlobPattern,
  parseErrorBashPermissionTitle,
  splitShellCommands,
} from "../extensions/guard";
import { policyConfig } from "../modules/policy";
import { askPermissionChoices } from "../modules/profileUpdate";
import type { CustomToolRule, ProfilePolicy } from "../modules/policyHelpers";
import { loadProfileConfig } from "../modules/profileConfig";
import { defaultProtectedPathRules } from "../modules/protectedPaths";
import { createExtensionHarness as createInteractiveExtensionHarness } from "./support/extensionHarness";

const defaultProtectedRipgrepArguments = defaultProtectedPathRules
  .filter((rule) => rule.decision === "deny")
  .map((rule) => `--glob '!${rule.pattern}'`)
  .join(" ");

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

function customPermissionPicker(confirm: boolean) {
  return vi.fn().mockImplementation((factory: unknown) => {
    let result: unknown = null;
    const theme = {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const component = (
      factory as (
        tui: { requestRender: () => void },
        componentTheme: typeof theme,
        keybindings: undefined,
        done: (value: unknown) => void,
      ) => Component
    )(
      { requestRender: () => undefined },
      theme,
      undefined,
      (value) => (result = value),
    );
    if (isFocusable(component)) component.focused = true;
    for (const character of confirm
      ? askPermissionChoices[1]
      : askPermissionChoices[0])
      component.handleInput?.(character);
    component.handleInput?.("\n");
    return Promise.resolve(result);
  });
}

function context(cwd: string, confirm = true) {
  return {
    cwd,
    hasUI: true,
    ui: {
      custom: customPermissionPicker(confirm),
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
      custom: vi.fn(),
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
  let packageBashTool: { name: string; execute?: unknown } | undefined;
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
    registerShortcut: vi.fn(),
    registerTool: vi.fn((tool: { name: string; execute?: unknown }) => {
      if (tool.name === "bash") packageBashTool = tool;
    }),
    appendEntry: vi.fn(),
    getActiveTools: () => [...activeTools],
    getAllTools: () =>
      registeredTools.map((name) => ({
        name,
        ...(name === "bash" && packageBashTool ? packageBashTool : {}),
      })),
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
    const result = await gateBash({
      command: "git status 'unterminated",
      startupCwd: process.cwd(),
      ctx: ctx,
      activePolicy: parserPolicy,
    });

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("could not be classified completely");
    expect(vi.mocked(ctx.ui.custom)).toHaveBeenCalledOnce();
  });

  it("allows a parse-error ASK with exactly one non-authorable prompt", async () => {
    const ctx = context(process.cwd(), true);
    const result = await gateBash({
      command: "python scripts/build.py 'unterminated",
      startupCwd: process.cwd(),
      ctx: ctx,
      activePolicy: parserPolicy,
    });

    expect(result).toBeUndefined();
    expect(vi.mocked(ctx.ui.custom)).toHaveBeenCalledTimes(1);
  });

  it("preserves a local command ASK when allow-asks resolves parse uncertainty", async () => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), "pi-guard-"));
    const configPath = path.join(directory, "profiles.jsonc");
    const previousConfigPath = process.env.PI_GUARD_PROFILE_CONFIG;
    let harness:
      ReturnType<typeof createInteractiveExtensionHarness> | undefined;
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        defaultProfile: "local-ask",
        profiles: {
          "local-ask": {
            description: "Preserves a local Bash approval rule.",
            extends: ["builtin:default"],
            transforms: ["transform:allow-asks"],
            sandbox: false,
            tools: {
              bash: [{ pattern: "git status *", decision: "ask" }],
            },
          },
        },
      }),
    );
    try {
      const resolved = loadProfileConfig({
        fallback: policyConfig,
        configPath,
      }).profiles["local-ask"];
      const command = "git status --short; 'unterminated";

      expect(resolved.runtime.implicitAskDecision).toBe("allow");
      expect(decideBash(command, resolved.policy)).toBe("ask");
      process.env.PI_GUARD_PROFILE_CONFIG = configPath;
      harness = createInteractiveExtensionHarness({ interactiveUi: true });
      await harness.start();

      const pending = harness.callTool({
        toolName: "bash",
        input: { command },
      });
      const modal = await harness.ui.waitForCustomModal();
      const displayed = modal.render().join("\n");
      expect(displayed).toContain(explicitBashPermissionTitle);
      expect(displayed).not.toContain(parseErrorBashPermissionTitle);
      modal.type(askPermissionChoices[1]);
      modal.press("Enter");
      await expect(pending).resolves.toBeUndefined();
    } finally {
      await harness?.dispose();
      if (previousConfigPath === undefined)
        delete process.env.PI_GUARD_PROFILE_CONFIG;
      else process.env.PI_GUARD_PROFILE_CONFIG = previousConfigPath;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves a local command ASK when deny-asks sets implicit denial", async () => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), "pi-guard-"));
    const configPath = path.join(directory, "profiles.jsonc");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        profiles: {
          "local-ask": {
            description: "Preserves a local Bash approval rule.",
            extends: ["builtin:default"],
            transforms: ["transform:deny-asks"],
            tools: {
              bash: [{ pattern: "git status *", decision: "ask" }],
            },
          },
        },
      }),
    );
    try {
      const resolved = loadProfileConfig({
        fallback: policyConfig,
        configPath,
      }).profiles["local-ask"];
      const ctx = context(process.cwd(), true);

      expect(resolved.runtime.implicitAskDecision).toBe("deny");
      expect(decideBash("git status --short", resolved.policy)).toBe("ask");
      await expect(
        gateBash({
          command: "git status --short",
          startupCwd: process.cwd(),
          ctx,
          activePolicy: resolved.policy,
          implicitAskDecision: resolved.runtime.implicitAskDecision,
        }),
      ).resolves.toBeUndefined();
      expect(vi.mocked(ctx.ui.custom)).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("denies a definite protected path before prompting for parse errors", async () => {
    const policy = {
      ...parserPolicy,
      protectedPathRules: [{ pattern: "**/.env*", decision: "deny" }],
    } satisfies ProfilePolicy;
    const ctx = context(process.cwd());

    const result = await gateBash({
      command: "cat .env 'unterminated",
      startupCwd: process.cwd(),
      ctx: ctx,
      activePolicy: policy,
    });

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("protected-path policy");
    expect(vi.mocked(ctx.ui.custom)).not.toHaveBeenCalled();
  });

  it("blocks unbash parse errors without attempting a non-interactive prompt", async () => {
    const ctx = nonInteractiveContext(process.cwd());
    const result = await gateBash({
      command: "git status 'unterminated",
      startupCwd: process.cwd(),
      ctx: ctx,
      activePolicy: parserPolicy,
    });

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("could not be classified completely");
    expect(vi.mocked(ctx.ui.custom)).not.toHaveBeenCalled();
  });

  it("denies a later compound segment without prompting for an earlier ask", async () => {
    const ctx = context(process.cwd());
    const result = await gateBash({
      command: "git fetch origin && git checkout main",
      startupCwd: process.cwd(),
      ctx,
      activePolicy: parserPolicy,
    });

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("Command denied by explicit rule");
    expect(result?.reason).toContain(
      "[\u001b[31mdeny\u001b[0m] git checkout main",
    );
    expect(vi.mocked(ctx.ui.custom)).not.toHaveBeenCalled();
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

    const combined = await gateBash({
      command: "git checkout main && git reset --hard",
      startupCwd: process.cwd(),
      ctx: context(process.cwd()),
      activePolicy: steeringPolicy,
    });
    expect(combined).toMatchObject({ block: true });
    expect(combined?.reason).toContain(
      "Switch branches with a dedicated tool instead.",
    );
    expect(combined?.reason).toContain("Avoid history-rewriting resets.");
    expect(combined?.reason).toContain("git stash push");

    // Two segments matching the same deny rule must not repeat its steering.
    const duplicated = await gateBash({
      command: "git checkout main && git checkout feature",
      startupCwd: process.cwd(),
      ctx: context(process.cwd()),
      activePolicy: steeringPolicy,
    });
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
        gateBash({
          command: command,
          startupCwd: process.cwd(),
          ctx: context(process.cwd()),
          activePolicy: parserPolicy,
        }),
      ).resolves.toMatchObject({ block: true });
    }
  });

  it("enforces profile-configured protected path patterns for Bash readers", async () => {
    const policy = {
      ...parserPolicy,
      protectedPathRules: [{ pattern: "**/.db", decision: "deny" }],
    } satisfies ProfilePolicy;

    const result = await gateBash({
      command: "cat .db",
      startupCwd: process.cwd(),
      ctx: context(process.cwd()),
      activePolicy: policy,
    });
    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("protected from disclosure and mutation");
  });

  it("simulates cwd changes before evaluating later path references", async () => {
    const startupCwd = path.join(process.cwd(), "project");
    const ctx = context(startupCwd);

    await expect(
      gateBash({
        command: "cd docs && cd drafts && ls ../../..",
        startupCwd: startupCwd,
        ctx: ctx,
        activePolicy: parserPolicy,
      }),
    ).resolves.toBeUndefined();
    expect(vi.mocked(ctx.ui.custom).mock.calls).toHaveLength(1);
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
      gateBash({
        command: "cd home/.pi/agent/packages/pi-guard && npm test",
        startupCwd: repositoryRoot,
        ctx: ctx,
        activePolicy: policyConfig.profiles["builtin:default"].policy,
      }),
    ).resolves.toBeUndefined();
    expect(vi.mocked(ctx.ui.custom)).not.toHaveBeenCalled();
  });

  it("treats Git's bare -- separator as syntax rather than a path", async () => {
    const repositoryRoot = path.resolve(process.cwd(), "../../../../..");
    const ctx = context(repositoryRoot, false);

    await expect(
      gateBash({
        command:
          "git diff --stat -- home/.pi/agent/packages/pi-guard/integrationTests",
        startupCwd: repositoryRoot,
        ctx: ctx,
        activePolicy: policyConfig.profiles["builtin:default"].policy,
      }),
    ).resolves.toBeUndefined();
    expect(vi.mocked(ctx.ui.custom)).not.toHaveBeenCalled();
  });

  it("does not treat clustered short flags as gated paths", async () => {
    const ctx = context(process.cwd(), false);

    await expect(
      gateBash({
        command: "ls -la modules",
        startupCwd: process.cwd(),
        ctx: ctx,
        activePolicy: policyConfig.profiles["builtin:default"].policy,
      }),
    ).resolves.toBeUndefined();
    expect(vi.mocked(ctx.ui.custom)).not.toHaveBeenCalled();
  });

  it("still gates path-shaped attached option values", async () => {
    const ctx = context(process.cwd(), false);

    const result = await gateBash({
      command: "ls --output=.env modules",
      startupCwd: process.cwd(),
      ctx: ctx,
      activePolicy: policyConfig.profiles["builtin:default"].policy,
    });
    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("--output=.env");
    expect(vi.mocked(ctx.ui.custom)).toHaveBeenCalled();
  });

  it.each(["builtin:default", "builtin:read-only"] as const)(
    "allows Pi package and extension documentation outside the startup directory in the %s profile",
    async (profile) => {
      for (const document of ["packages.md", "extensions.md"]) {
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
          document,
        );
        const ctx = context(process.cwd());

        await expect(
          gateBash({
            command: `cat ${piDocs}`,
            startupCwd: process.cwd(),
            ctx: ctx,
            activePolicy: policyConfig.profiles[profile].policy,
          }),
          document,
        ).resolves.toBeUndefined();
        expect(vi.mocked(ctx.ui.custom), document).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["builtin:default", "builtin:read-only"] as const)(
    "allows dependencies inside Pi packages in the %s profile",
    async (profile) => {
      const ctx = context(process.cwd());
      const packageDependency = path.join(
        process.cwd(),
        "node_modules",
        "vitest",
        "package.json",
      );

      await expect(
        gateBash({
          command: `cat ${packageDependency}`,
          startupCwd: path.join(process.cwd(), "test-project"),
          ctx: ctx,
          activePolicy: policyConfig.profiles[profile].policy,
        }),
      ).resolves.toBeUndefined();
      expect(vi.mocked(ctx.ui.custom)).not.toHaveBeenCalled();
    },
  );

  it("gates basename, dynamic, and Git object operands under restrictive write paths", async () => {
    const restrictivePolicy = structuredClone(
      policyConfig.profiles["builtin:default"].policy,
    );
    restrictivePolicy.writePaths = [
      { pattern: "**", decision: "deny" },
      { pattern: "modules/**", decision: "allow" },
      { pattern: "allowed", decision: "allow" },
      { pattern: "allowed/**", decision: "allow" },
      { pattern: "startup-file", decision: "allow" },
    ];
    const ctx = context(process.cwd(), false);

    await expect(
      gateBash({
        command: "rg needle modules/allowed.ts",
        startupCwd: process.cwd(),
        ctx: ctx,
        activePolicy: restrictivePolicy,
      }),
    ).resolves.toBeUndefined();
    await expect(
      gateBash({
        command: "rg --glob 'modules/**' needle modules/allowed.ts",
        startupCwd: process.cwd(),
        ctx: ctx,
        activePolicy: restrictivePolicy,
      }),
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
        gateBash({
          command: command,
          startupCwd: process.cwd(),
          ctx: ctx,
          activePolicy: restrictivePolicy,
        }),
        command,
      ).resolves.toMatchObject({ block: true });
    }

    await expect(
      gateBash({
        command: "git show HEAD~3:src/example.ts",
        startupCwd: process.cwd(),
        ctx: ctx,
        activePolicy: restrictivePolicy,
      }),
    ).resolves.toBeUndefined();
    await expect(
      gateBash({
        command: "git show HEAD",
        startupCwd: process.cwd(),
        ctx: ctx,
        activePolicy: restrictivePolicy,
      }),
    ).resolves.toBeUndefined();
    await expect(
      gateBash({
        command: "git rev-parse HEAD~3",
        startupCwd: process.cwd(),
        ctx: ctx,
        activePolicy: restrictivePolicy,
      }),
    ).resolves.toBeUndefined();
  });

  it("keeps common rg glob searches allowed while appending protections last", async () => {
    const { api, handlers } = createExtensionHarness();
    permissionsExtension(api);
    const sessionStart = handlers.get("session_start");
    const toolCall = handlers.get("tool_call");
    const ctx = nonInteractiveContext(process.cwd());
    await sessionStart?.({ type: "session_start" }, ctx);

    const event = {
      type: "tool_call",
      toolName: "bash",
      input: { command: "rg --glob '**/*.ts' PATTERN" },
    };

    await expect(toolCall?.(event, ctx)).resolves.toBeUndefined();
    expect(event.input.command).toBe(
      `rg --glob '**/*.ts' PATTERN ${defaultProtectedRipgrepArguments}`,
    );
  });

  it.each(['inspect "$TARGET"', 'inspect "${ROOT}/credentials"'])(
    "blocks an unresolved dynamic operand for an otherwise-allowed command: %s",
    async (command) => {
      const restrictivePolicy = {
        ...structuredClone(policyConfig.profiles["builtin:default"].policy),
        tools: {
          ...structuredClone(
            policyConfig.profiles["builtin:default"].policy.tools,
          ),
          bash: [
            ...(policyConfig.profiles["builtin:default"].policy.tools.bash ??
              []),
            { pattern: "inspect *", decision: "allow" as const },
          ],
        },
        writePaths: [{ pattern: "**", decision: "deny" as const }],
      } satisfies ProfilePolicy;
      const ctx = nonInteractiveContext(process.cwd());
      const result = await gateBash({
        command: command,
        startupCwd: process.cwd(),
        ctx: ctx,
        activePolicy: restrictivePolicy,
      });

      expect(result).toMatchObject({ block: true });
      expect(vi.mocked(ctx.ui.custom)).not.toHaveBeenCalled();
    },
  );

  it("applies deny-asks runtime metadata to non-authorable path uncertainty", async () => {
    const ctx = context(process.cwd());
    const worker = policyConfig.profiles["builtin:worker"];

    const result = await gateBash({
      command: "git show --format=fuller --stat --summary $c",
      startupCwd: process.cwd(),
      ctx,
      activePolicy: worker.policy,
      implicitAskDecision: worker.runtime.implicitAskDecision,
    });

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("denies implicit permission requests");
    expect(vi.mocked(ctx.ui.custom)).not.toHaveBeenCalled();
  });

  it("blocks unresolved dynamic Git diff operands under restrictive writePaths", async () => {
    const restrictivePolicy = structuredClone(
      policyConfig.profiles["builtin:default"].policy,
    );
    restrictivePolicy.writePaths = [{ pattern: "**", decision: "deny" }];
    const ctx = nonInteractiveContext(process.cwd());

    const result = await gateBash({
      command: 'git diff "$LEFT" "$RIGHT"',
      startupCwd: process.cwd(),
      ctx: ctx,
      activePolicy: restrictivePolicy,
    });

    expect(result).toMatchObject({ block: true });
    expect(vi.mocked(ctx.ui.custom)).not.toHaveBeenCalled();
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
      const restrictivePolicy = structuredClone(
        policyConfig.profiles["builtin:default"].policy,
      );
      restrictivePolicy.writePaths = [{ pattern: "**", decision: "deny" }];
      const ctx = context(process.cwd(), true);

      await expect(
        gateBash({
          command: command,
          startupCwd: process.cwd(),
          ctx: ctx,
          activePolicy: restrictivePolicy,
        }),
      ).resolves.toBeUndefined();
      expect(vi.mocked(ctx.ui.custom)).toHaveBeenCalledOnce();
    },
  );

  it("gates the exact basename and redirection forms from the remediation matrix", async () => {
    const restrictivePolicy = structuredClone(
      policyConfig.profiles["builtin:default"].policy,
    );
    restrictivePolicy.writePaths = [{ pattern: "**", decision: "deny" }];

    for (const command of [
      "node < input.json",
      "git log > history.txt",
      'cat "$TARGET"',
      'cat "${ROOT}/credentials"',
    ]) {
      await expect(
        gateBash({
          command: command,
          startupCwd: process.cwd(),
          ctx: nonInteractiveContext(process.cwd()),
          activePolicy: restrictivePolicy,
        }),
        command,
      ).resolves.toMatchObject({ block: true });
    }
  });

  it("treats explicit Git colon paths as paths at the gate", async () => {
    const restrictivePolicy = structuredClone(
      policyConfig.profiles["builtin:default"].policy,
    );
    restrictivePolicy.writePaths = [{ pattern: "**", decision: "deny" }];

    for (const operand of [
      "./path:name",
      "../path:name",
      "/tmp/path:name",
      "~/path:name",
    ]) {
      await expect(
        gateBash({
          command: `git show ${operand}`,
          startupCwd: process.cwd(),
          ctx: nonInteractiveContext(process.cwd()),
          activePolicy: restrictivePolicy,
        }),
        operand,
      ).resolves.toMatchObject({ block: true });
    }
  });

  it("proves detached Git option values are non-path values before exempting them", async () => {
    const restrictivePolicy = structuredClone(
      policyConfig.profiles["builtin:default"].policy,
    );
    restrictivePolicy.writePaths = [{ pattern: "**", decision: "deny" }];

    await expect(
      gateBash({
        command: "git tag --sort version:refname",
        startupCwd: process.cwd(),
        ctx: nonInteractiveContext(process.cwd()),
        activePolicy: restrictivePolicy,
      }),
    ).resolves.toBeUndefined();
  });

  it("preserves cwd for subshells and blocks conditional or dynamic cwd control flow", async () => {
    const restrictivePolicy = structuredClone(
      policyConfig.profiles["builtin:default"].policy,
    );
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
      gateBash({
        command: "cd allowed; cat ./file",
        startupCwd: process.cwd(),
        ctx: context(process.cwd()),
        activePolicy: restrictivePolicy,
      }),
    ).resolves.toBeUndefined();

    await expect(
      gateBash({
        command: "(cd allowed; cat ./file); cat ./startup-file",
        startupCwd: process.cwd(),
        ctx: context(process.cwd()),
        activePolicy: restrictivePolicy,
      }),
    ).resolves.toBeUndefined();

    await expect(
      gateBash({
        command: "cd first || cd second; cat ./startup-file",
        startupCwd: process.cwd(),
        ctx: nonInteractiveContext(process.cwd()),
        activePolicy: restrictivePolicy,
      }),
    ).resolves.toMatchObject({ block: true });

    await expect(
      gateBash({
        command: 'cd "$TARGET"; cat ./startup-file',
        startupCwd: process.cwd(),
        ctx: nonInteractiveContext(process.cwd()),
        activePolicy: restrictivePolicy,
      }),
    ).resolves.toMatchObject({ block: true });
  });

  it.each([
    "if false; then cd allowed; else inspect ./file; fi",
    'case "$MODE" in allowed) cd allowed ;; *) inspect ./file ;; esac',
  ])(
    "blocks mutually exclusive branch paths instead of flattening cwd state: %s",
    async (command) => {
      const restrictivePolicy = {
        ...structuredClone(policyConfig.profiles["builtin:default"].policy),
        tools: {
          ...structuredClone(
            policyConfig.profiles["builtin:default"].policy.tools,
          ),
          bash: [
            ...(policyConfig.profiles["builtin:default"].policy.tools.bash ??
              []),
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
        gateBash({
          command: command,
          startupCwd: process.cwd(),
          ctx: nonInteractiveContext(process.cwd()),
          activePolicy: restrictivePolicy,
        }),
      ).resolves.toMatchObject({ block: true });
    },
  );

  it("fails conservatively for && cwd uncertainty", async () => {
    const restrictivePolicy = structuredClone(
      policyConfig.profiles["builtin:default"].policy,
    );
    restrictivePolicy.writePaths = [
      { pattern: "*", decision: "deny" },
      { pattern: "allowed", decision: "allow" },
      { pattern: "allowed/**", decision: "allow" },
    ];

    await expect(
      gateBash({
        command: "false && cd allowed; cat ./file",
        startupCwd: process.cwd(),
        ctx: nonInteractiveContext(process.cwd()),
        activePolicy: restrictivePolicy,
      }),
    ).resolves.toMatchObject({ block: true });
  });

  it("does not leak command or process substitution cwd into the outer shell", async () => {
    const restrictivePolicy = structuredClone(
      policyConfig.profiles["builtin:default"].policy,
    );
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
        gateBash({
          command: command,
          startupCwd: process.cwd(),
          ctx: context(process.cwd()),
          activePolicy: restrictivePolicy,
        }),
        command,
      ).resolves.toBeUndefined();
    }
  });

  it("persists cwd changes made by a brace group in the current shell", async () => {
    const restrictivePolicy = structuredClone(
      policyConfig.profiles["builtin:default"].policy,
    );
    restrictivePolicy.writePaths = [
      { pattern: "*", decision: "deny" },
      { pattern: "allowed", decision: "allow" },
      { pattern: "allowed/**", decision: "allow" },
    ];

    await expect(
      gateBash({
        command: "{ cd allowed; cat ./file; }; cat ./file",
        startupCwd: process.cwd(),
        ctx: context(process.cwd()),
        activePolicy: restrictivePolicy,
      }),
    ).resolves.toBeUndefined();
  });

  it("allows package manager script names under restrictive writePaths", async () => {
    const restrictivePolicy = structuredClone(
      policyConfig.profiles["builtin:default"].policy,
    );
    restrictivePolicy.writePaths = [{ pattern: "**", decision: "deny" }];
    const ctx = context(process.cwd(), false);

    for (const command of ["npm run check:types", "npm test"]) {
      await expect(
        gateBash({
          command: command,
          startupCwd: process.cwd(),
          ctx: ctx,
          activePolicy: restrictivePolicy,
        }),
        command,
      ).resolves.toBeUndefined();
    }
    expect(vi.mocked(ctx.ui.custom)).not.toHaveBeenCalled();
  });

  it("gates package manager directory options as paths", async () => {
    const restrictivePolicy = structuredClone(
      policyConfig.profiles["builtin:default"].policy,
    );
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
      gateBash({
        command: "npm --prefix pkg run test",
        startupCwd: process.cwd(),
        ctx: context(process.cwd(), false),
        activePolicy: restrictivePolicy,
      }),
    ).resolves.toBeUndefined();

    for (const command of [
      "npm --prefix ../blocked test",
      "npm --prefix=../blocked test",
      "pnpm -C ../blocked test",
    ]) {
      await expect(
        gateBash({
          command: command,
          startupCwd: process.cwd(),
          ctx: nonInteractiveContext(process.cwd()),
          activePolicy: restrictivePolicy,
        }),
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
      const policy = structuredClone(
        policyConfig.profiles["builtin:default"].policy,
      );
      policy.writePaths = [{ pattern: "**", decision: "deny" }];
      const ctx = context(process.cwd(), false);

      await expect(
        gateBash({
          command: "cd project",
          startupCwd: process.cwd(),
          ctx: ctx,
          activePolicy: policy,
        }),
      ).resolves.toBeUndefined();
      expect(vi.mocked(ctx.ui.custom)).not.toHaveBeenCalled();
    });

    it("denies cd into a read-denied directory, because cd repositions readers", async () => {
      // Operand-less commands such as bare `ls` read whatever directory the
      // shell is in, so the cd destination is gated against readPaths.
      const policy = structuredClone(
        policyConfig.profiles["builtin:default"].policy,
      );
      policy.readPaths = [{ pattern: "**", decision: "deny" }];

      await expect(
        gateBash({
          command: "cd project",
          startupCwd: process.cwd(),
          ctx: nonInteractiveContext(process.cwd()),
          activePolicy: policy,
        }),
      ).resolves.toMatchObject({ block: true });
    });

    it("still denies cd into protected paths", async () => {
      const result = await gateBash({
        command: "cd .git",
        startupCwd: process.cwd(),
        ctx: context(process.cwd(), false),
        activePolicy: policyConfig.profiles["builtin:default"].policy,
      });

      expect(result).toMatchObject({ block: true });
      expect(result?.reason).toContain(
        "protected from disclosure and mutation",
      );
    });

    it("finds a denied operand after a static cd ask before prompting", async () => {
      const policy = {
        tools: { bash: [{ pattern: "*", decision: "allow" }] },
        readPaths: [
          { pattern: "**", decision: "allow" },
          { pattern: "docs/**", decision: "ask" },
        ],
        writePaths: [
          { pattern: "**", decision: "allow" },
          { pattern: "docs/blocked", decision: "deny" },
        ],
      } satisfies ProfilePolicy;
      const ctx = context(process.cwd());

      const result = await gateBash({
        command: "cd docs && cp source blocked",
        startupCwd: process.cwd(),
        ctx: ctx,
        activePolicy: policy,
      });

      expect(result).toMatchObject({ block: true });
      expect(result?.reason).toContain("Bash path reference denied by policy");
      expect(result?.reason).toContain("docs/blocked");
      expect(vi.mocked(ctx.ui.custom)).not.toHaveBeenCalled();
    });

    it("still gates operands against the directory tracked through cd", async () => {
      // The follow-up guarantee that makes ungated navigation safe: after
      // `cd project`, relative operands are evaluated against `project`, not
      // the startup directory.
      const restrictivePolicy = structuredClone(
        policyConfig.profiles["builtin:default"].policy,
      );
      restrictivePolicy.writePaths = [
        { pattern: "**", decision: "deny" },
        { pattern: "project/allowed", decision: "allow" },
      ];

      await expect(
        gateBash({
          command: "cd project && cat allowed",
          startupCwd: process.cwd(),
          ctx: context(process.cwd(), false),
          activePolicy: restrictivePolicy,
        }),
      ).resolves.toBeUndefined();

      await expect(
        gateBash({
          command: "cd project && cat secret",
          startupCwd: process.cwd(),
          ctx: nonInteractiveContext(process.cwd()),
          activePolicy: restrictivePolicy,
        }),
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
      gateBash({
        command: `cat ${unrelatedDependency}`,
        startupCwd: process.cwd(),
        ctx: ctx,
        activePolicy: policyConfig.profiles["builtin:default"].policy,
      }),
    ).resolves.toMatchObject({ block: true });
    expect(vi.mocked(ctx.ui.custom)).toHaveBeenCalled();
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
      expect(
        decideBash(command, policyConfig.profiles["builtin:default"].policy),
      ).toBe("allow");
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
    expect(
      decideBash(command, policyConfig.profiles["builtin:default"].policy),
    ).toBe("deny");
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
    expect(
      decideBash(command, policyConfig.profiles["builtin:default"].policy),
    ).toBe("ask");
  });

  it("steers denied package manager mutations toward asking the user", async () => {
    const result = await gateBash({
      command: "npm install lodash",
      startupCwd: process.cwd(),
      ctx: context(process.cwd(), false),
      activePolicy: policyConfig.profiles["builtin:default"].policy,
    });

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
    expect(
      decideBash(command, policyConfig.profiles["builtin:default"].policy),
    ).toBe("allow");
  });

  it.each([
    "git tag -a v1.0.0",
    "git tag -d v1.0.0",
    "git tag -m 'message' v1.0.0",
    "git tag --delete v1.0.0",
  ])("denies %s", (command) => {
    expect(
      decideBash(command, policyConfig.profiles["builtin:default"].policy),
    ).toBe("deny");
  });
});

describe("extension harness custom tool inheritance", () => {
  it("preserves inherited custom-tool rules when a child appends an empty list", async () => {
    const configDirectory = fs.mkdtempSync(path.join(tmpdir(), "pi-guard-"));
    const configPath = path.join(configDirectory, "profiles.jsonc");
    fs.writeFileSync(
      configPath,
      `{
        "defaultProfile": "builtin:default",
        "profiles": {
          "deployment-base": {
            "description": "Deployment base profile denying production custom-tool operations.",
            "extends": ["builtin:default"],
            "tools": {
              "deploy": [
                { "decision": "deny", "match": { "environment": "production" } }
              ]
            }
          },
          "deployment-child": {
            "description": "Deployment child profile preserving inherited rules with an empty override.",
            "extends": ["deployment-base"],
            "tools": {
              "deploy": []
            }
          }
        }
      }`,
    );

    const previousConfigPath = process.env.PI_GUARD_PROFILE_CONFIG;
    const previousSubagentProfile = process.env.PI_SUBAGENT_PROFILE;
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
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

      expect(interactiveResult).toMatchObject({ block: true });
      expect(
        String((interactiveResult as { reason?: string }).reason),
      ).toContain("deploy denied by custom tool policy");
      expect(vi.mocked(interactiveCtx.ui.custom)).not.toHaveBeenCalled();

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
        "deploy denied by custom tool policy",
      );
      expect(vi.mocked(ctx.ui.custom)).not.toHaveBeenCalled();
    } finally {
      if (previousConfigPath === undefined) {
        delete process.env.PI_GUARD_PROFILE_CONFIG;
      } else {
        process.env.PI_GUARD_PROFILE_CONFIG = previousConfigPath;
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
    const configDirectory = fs.mkdtempSync(path.join(tmpdir(), "pi-guard-"));
    const configPath = path.join(configDirectory, "profiles.jsonc");
    fs.writeFileSync(
      configPath,
      `{
        "defaultProfile": "builtin:default",
        "profiles": {
          "deployment-base": {
            "description": "Deployment base profile denying production custom-tool operations.",
            "extends": ["builtin:default"],
            "tools": {
              "deploy": [
                { "decision": "deny", "match": { "environment": "production" } }
              ]
            }
          },
          "deployment-child": {
            "description": "Deployment child profile appending staging approval to inherited production denial.",
            "extends": ["deployment-base"],
            "tools": {
              "deploy": [
                { "decision": "allow", "match": { "environment": "staging" } }
              ]
            }
          }
        }
      }`,
    );

    const previousConfigPath = process.env.PI_GUARD_PROFILE_CONFIG;
    const previousSubagentProfile = process.env.PI_SUBAGENT_PROFILE;
    process.env.PI_GUARD_PROFILE_CONFIG = configPath;
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
      expect(vi.mocked(ctx.ui.custom)).not.toHaveBeenCalled();
    } finally {
      if (previousConfigPath === undefined) {
        delete process.env.PI_GUARD_PROFILE_CONFIG;
      } else {
        process.env.PI_GUARD_PROFILE_CONFIG = previousConfigPath;
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
