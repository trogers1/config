import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import permissionsExtension, { decideBash } from "../extensions/permissions";
import { policyConfig as genericPolicyConfig } from "../modules/policy";
import { builtinProfilePrefix } from "../modules/policyHelpers";
import {
  ProfileConfigLoadError,
  loadProfileConfig,
} from "../modules/profileConfig";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PI_PERMISSIONS_PROFILE_CONFIG;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function writeConfig(contents: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-permissions-"));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "profiles.jsonc");
  fs.writeFileSync(configPath, contents);
  return configPath;
}

describe("profile configuration", () => {
  it("uses the shipped profiles when a guaranteed-missing user configuration is absent", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-permissions-missing-"),
    );
    temporaryDirectories.push(directory);
    const config = loadProfileConfig(
      genericPolicyConfig,
      path.join(directory, "does-not-exist.jsonc"),
    );

    expect(config).toBe(genericPolicyConfig);
  });

  it("lints a from-scratch profile after loading and names it in warnings", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    loadProfileConfig(
      genericPolicyConfig,
      writeConfig(`{
        "profiles": {
          "standalone": {
            "tools": {
              "bash": [
                { "pattern": "deploy *", "decision": "allow" },
                { "pattern": "deploy *", "decision": "deny" }
              ]
            },
            "readPaths": [{ "pattern": "*", "decision": "allow" }],
            "writePaths": [{ "pattern": "*", "decision": "allow" }]
          }
        }
      }`),
    );

    expect(warnSpy).toHaveBeenCalledWith(
      "Profile 'standalone' has conflicting bash rules for pattern 'deploy *': 'allow' conflicts with later 'deny'.",
    );
  });

  it("rejects transforms on a profile without inherited policy", () => {
    const configPath = writeConfig(
      JSON.stringify({
        profiles: {
          standalone: {
            transforms: ["transform:deny-all"],
            tools: { bash: [{ pattern: "*", decision: "allow" }] },
            readPaths: [{ pattern: "**", decision: "allow" }],
            writePaths: [{ pattern: "**", decision: "allow" }],
          },
        },
      }),
    );

    try {
      loadProfileConfig(genericPolicyConfig, configPath);
      throw new Error("expected loadProfileConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileConfigLoadError);
      expect((error as ProfileConfigLoadError).configPath).toBe(configPath);
      expect((error as ProfileConfigLoadError).details).toBe(
        "/profiles/standalone/transforms: transforms require at least one extends target",
      );
    }
  });

  it("lints inherited conflicts against the fully resolved child profile", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    loadProfileConfig(
      genericPolicyConfig,
      writeConfig(`{
        "profiles": {
          "base": {
            "tools": {
              "bash": [{ "pattern": "deploy *", "decision": "allow" }]
            },
            "readPaths": [{ "pattern": "*", "decision": "allow" }],
            "writePaths": [{ "pattern": "*", "decision": "allow" }]
          },
          "child": {
            "extends": ["base"],
            "tools": {
              "bash": [{ "pattern": "deploy *", "decision": "deny" }]
            }
          }
        }
      }`),
    );

    expect(warnSpy).toHaveBeenCalledWith(
      "Profile 'child' has conflicting bash rules for pattern 'deploy *': 'allow' conflicts with later 'deny'.",
    );
  });

  it("parses JSONC and extends a shipped profile", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig(`{
        // Editor JSON Schema directives, comments, and trailing commas are supported.
        "$schema": "https://example.test/profiles.schema.json",
        "profiles": {
          "client-work": {
            "extends": ["builtin:default"],
            "directories": ["/workspace/client",],
            "tools": {
              "bash": [{ "pattern": "client-cli *", "decision": "allow" }],
            },
            "readPaths": [
              {
                "pattern": "vendor/**",
                "decision": "deny",
                "contexts": ["grep"]
              }
            ],
          },
        },
      }`),
    );

    const clientWork = config.profiles["client-work"];
    expect(clientWork.directories).toEqual(["/workspace/client"]);
    expect(clientWork.tools.bash).toEqual(
      expect.arrayContaining([{ pattern: "client-cli *", decision: "allow" }]),
    );
    expect(clientWork.tools.bash?.length).toBeGreaterThan(
      genericPolicyConfig.profiles["builtin:default"].tools.bash?.length ?? 0,
    );
    expect(clientWork.readPaths).toEqual([
      ...genericPolicyConfig.profiles["builtin:default"].readPaths,
      { pattern: "vendor/**", decision: "deny", contexts: ["grep"] },
    ]);
  });

  it("appends non-empty custom tool overrides to inherited rules", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig(`{
        "profiles": {
          "deployment-base": {
            "extends": ["builtin:default"],
            "tools": {
              "deploy": [
                { "decision": "ask" },
                { "decision": "deny", "match": { "environment": "production" } }
              ]
            }
          },
          "deployment-child": {
            "extends": ["deployment-base"],
            "tools": {
              "deploy": [
                { "decision": "allow", "match": { "environment": "staging" } }
              ]
            }
          }
        }
      }`),
    );

    expect(config.profiles["deployment-child"].tools.deploy).toEqual([
      { decision: "ask" },
      { decision: "deny", match: { environment: "production" } },
      { decision: "allow", match: { environment: "staging" } },
    ]);
  });

  it("preserves inherited custom tool rules when a child appends an empty list", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig(`{
        "profiles": {
          "deployment-base": {
            "extends": ["builtin:default"],
            "tools": {
              "deploy": [
                { "decision": "deny", "match": { "environment": "production" } }
              ]
            }
          },
          "deployment-child": {
            "extends": ["deployment-base"],
            "tools": {
              "deploy": []
            }
          }
        }
      }`),
    );

    expect(config.profiles["deployment-child"].tools.deploy).toEqual([
      { decision: "deny", match: { environment: "production" } },
    ]);
  });

  it("preserves inherited Bash rules when a child appends an empty list", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig(
        JSON.stringify({
          profiles: {
            "quiet-bash": { extends: ["builtin:default"], tools: { bash: [] } },
          },
        }),
      ),
    );

    const quietBash = config.profiles["quiet-bash"];
    expect(quietBash.tools.bash).toEqual(
      genericPolicyConfig.profiles["builtin:default"].tools.bash,
    );
    expect(decideBash("git status --short", quietBash)).toBe(
      decideBash(
        "git status --short",
        genericPolicyConfig.profiles["builtin:default"],
      ),
    );
    expect(decideBash("npm test", quietBash)).toBe(
      decideBash("npm test", genericPolicyConfig.profiles["builtin:default"]),
    );
  });

  it("accepts a fully custom profile without extends", () => {
    const standaloneProfile = {
      ...genericPolicyConfig.profiles["builtin:default"],
      emoji: "🧪",
    };
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig(
        JSON.stringify({
          profiles: { standalone: standaloneProfile },
        }),
      ),
    );

    expect(config.profiles.standalone).toMatchObject({ emoji: "🧪" });
  });

  it("throws a typed error for invalid JSONC in an existing file", () => {
    const configPath = writeConfig('{ "profiles": ');

    try {
      loadProfileConfig(genericPolicyConfig, configPath);
      throw new Error("expected loadProfileConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileConfigLoadError);
      expect((error as ProfileConfigLoadError).configPath).toBe(configPath);
      expect((error as Error).message).toContain(configPath);
      expect((error as Error).message).toContain("JSONC parse error");
    }
  });

  it("throws a typed error for a schema-invalid legacy field", () => {
    const configPath = writeConfig(
      JSON.stringify({
        profiles: {
          default: {
            ...genericPolicyConfig.profiles["builtin:default"],
            bashPathReferences: [],
          },
        },
      }),
    );

    try {
      loadProfileConfig(genericPolicyConfig, configPath);
      throw new Error("expected loadProfileConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileConfigLoadError);
      expect((error as ProfileConfigLoadError).configPath).toBe(configPath);
      expect((error as Error).message).toContain(configPath);
      expect((error as Error).message).toContain("schema validation failed");
    }
  });

  it.each([
    {
      label: "unknown parent",
      contents: {
        profiles: {
          default: { extends: ["missing"] },
        },
      },
      message: "unknown inherited profile",
    },
    {
      label: "cycle",
      contents: {
        profiles: {
          default: { extends: ["worker"] },
          worker: { extends: ["default"] },
        },
      },
      message: "cyclic profile inheritance detected",
    },
  ])(
    "rejects an invalid $label definition with custom names resembling former built-ins",
    ({ contents, message }) => {
      const configPath = writeConfig(JSON.stringify(contents));
      expect(() =>
        loadProfileConfig(genericPolicyConfig, configPath),
      ).toThrowError(message);
    },
  );

  it.each([
    { name: "builtin:default" },
    { name: "builtin:worker" },
    { name: "builtin:future" },
    { name: "transform:evil" },
  ])(
    "rejects a user definition named $name as a reserved prefix definition",
    ({ name }) => {
      const configPath = writeConfig(
        JSON.stringify({
          profiles: {
            [name]: { extends: ["builtin:default"] },
          },
        }),
      );

      try {
        loadProfileConfig(genericPolicyConfig, configPath);
        throw new Error("expected loadProfileConfig to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ProfileConfigLoadError);
        expect((error as ProfileConfigLoadError).configPath).toBe(configPath);
        expect((error as Error).message).toContain(configPath);
        expect((error as Error).message).toContain(name);
        expect((error as Error).message).toContain(
          name.startsWith("transform:") ? "transform:" : builtinProfilePrefix,
        );
      }
    },
  );

  it("resolves builtin:* extends to the shipped profile and custom names to user definitions", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig(
        JSON.stringify({
          profiles: {
            "builtin-extends": { extends: ["builtin:default"] },
            default: {
              tools: { bash: [] },
              readPaths: [{ pattern: "*", decision: "allow" }],
              writePaths: [{ pattern: "*", decision: "allow" }],
            },
            "custom-extends": { extends: ["default"] },
          },
        }),
      ),
    );

    expect(config.profiles["builtin-extends"].tools.bash).toEqual(
      genericPolicyConfig.profiles["builtin:default"].tools.bash,
    );
    expect(config.profiles["custom-extends"].tools.bash).toEqual([]);

    const unknownBuiltinPath = writeConfig(
      JSON.stringify({
        profiles: {
          custom: { extends: ["builtin:missing"] },
        },
      }),
    );
    expect(() =>
      loadProfileConfig(genericPolicyConfig, unknownBuiltinPath),
    ).toThrowError("unknown built-in profile 'builtin:missing'");
  });

  it("rejects a custom extends target when no custom profile with that name exists", () => {
    const configPath = writeConfig(
      JSON.stringify({
        profiles: {
          custom: { extends: ["default"] },
        },
      }),
    );

    expect(() =>
      loadProfileConfig(genericPolicyConfig, configPath),
    ).toThrowError("unknown inherited profile 'default'");
  });

  it.each([
    {
      label: "unknown inherited profile",
      contents: JSON.stringify({
        defaultProfile: "client-work",
        profiles: {
          "client-work": {
            ...genericPolicyConfig.profiles["builtin:default"],
            extends: ["missing"],
          },
        },
      }),
      messageFragment: "unknown inherited profile",
    },
    {
      label: "cyclic inheritance",
      contents: JSON.stringify({
        defaultProfile: "first",
        profiles: {
          first: {
            ...genericPolicyConfig.profiles["builtin:default"],
            extends: ["second"],
          },
          second: {
            ...genericPolicyConfig.profiles["builtin:default"],
            extends: ["first"],
          },
        },
      }),
      messageFragment: "cyclic profile inheritance detected",
    },
    {
      label: "missing default profile",
      contents: JSON.stringify({
        defaultProfile: "missing",
        profiles: {
          default: genericPolicyConfig.profiles["builtin:default"],
        },
      }),
      messageFragment: "profile 'missing' is not configured",
    },
    {
      label: "inherited constructor property",
      contents: JSON.stringify({
        defaultProfile: "constructor",
        profiles: {},
      }),
      messageFragment: "profile 'constructor' is not configured",
    },
    {
      label: "__proto__ profile",
      contents: JSON.stringify({
        defaultProfile: "__proto__",
        profiles: Object.fromEntries([
          ["__proto__", genericPolicyConfig.profiles["builtin:default"]],
        ]),
      }),
      messageFragment: "profile '__proto__' is not configured",
    },
  ])("throws a typed error for $label", ({ contents, messageFragment }) => {
    const configPath = writeConfig(contents);

    try {
      loadProfileConfig(genericPolicyConfig, configPath);
      throw new Error("expected loadProfileConfig to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileConfigLoadError);
      expect((error as ProfileConfigLoadError).configPath).toBe(configPath);
      expect((error as Error).message).toContain(configPath);
      expect((error as Error).message).toContain(messageFragment);
    }
  });
});

function createHarness(options: { hasUI: boolean; cwd?: string }) {
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContext) => unknown>
  >();
  const commands: string[] = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const notifications: Array<{
    message: string;
    type?: "info" | "warning" | "error";
  }> = [];

  const ui = {
    confirm: () => Promise.resolve(true),
    input: () => Promise.resolve(undefined),
    notify: (message: string, type?: "info" | "warning" | "error") => {
      notifications.push({ message, type });
    },
    onTerminalInput: () => () => undefined,
    setStatus: (key: string, text: string | undefined) => {
      statuses.push({ key, text });
    },
    setWorkingMessage: () => undefined,
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setWidget: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle: () => undefined,
    custom: () => Promise.resolve(undefined),
    pasteToEditor: () => undefined,
    setEditorText: () => undefined,
    getEditorText: () => "",
    editor: () => Promise.resolve(undefined),
    addAutocompleteProvider: () => undefined,
    setEditorComponent: () => undefined,
    getEditorComponent: () => undefined,
    get theme() {
      return undefined as never;
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: true }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => undefined,
  } as unknown as ExtensionContext["ui"];

  const ctx: ExtensionContext = {
    ui,
    hasUI: options.hasUI,
    cwd: options.cwd ?? path.join(os.tmpdir(), "pi-permissions-cwd"),
    sessionManager: {
      getEntries: () => [],
    } as unknown as ExtensionContext["sessionManager"],
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    model: undefined,
    isIdle: () => true,
    signal: undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
  };

  const api: ExtensionAPI = {
    on(event: string, handler: unknown) {
      handlers.set(event, [
        ...(handlers.get(event) ?? []),
        handler as (event: unknown, ctx: ExtensionContext) => unknown,
      ]);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    getFlag: () => undefined,
    registerMessageRenderer: () => undefined,
    sendMessage: () => undefined,
    appendEntry: () => undefined,
    registerTool: () => undefined,
    getActiveTools: () => ["read", "bash", "edit", "write"],
    getAllTools: () =>
      ["read", "bash", "edit", "write", "grep", "find", "ls"].map((name) => ({
        name,
      })),
    setActiveTools: () => undefined,
  } as unknown as ExtensionAPI;

  permissionsExtension(api);

  return { handlers, commands, statuses, notifications, ctx };
}

async function emitSessionStart(
  harness: ReturnType<typeof createHarness>,
): Promise<void> {
  const handler = harness.handlers.get("session_start")?.[0];
  expect(handler).toBeDefined();
  await handler?.(
    { type: "session_start", reason: "startup" } satisfies SessionStartEvent,
    harness.ctx,
  );
}

async function emitToolCall(harness: ReturnType<typeof createHarness>) {
  const handler = harness.handlers.get("tool_call")?.[0];
  expect(handler).toBeDefined();
  return await handler?.(
    {
      type: "tool_call",
      toolCallId: "tool-1",
      toolName: "read",
      input: { path: "README.md" },
    } satisfies ToolCallEvent,
    harness.ctx,
  );
}

const invalidExtensionConfigCases = [
  {
    label: "invalid JSONC",
    contents: '{ "profiles": ',
    messageFragment: "JSONC parse error",
  },
  {
    label: "schema-invalid legacy field",
    contents: JSON.stringify({
      profiles: {
        default: {
          ...genericPolicyConfig.profiles["builtin:default"],
          bashPathReferences: [],
        },
      },
    }),
    messageFragment: "schema validation failed",
  },
  {
    label: "unknown inherited profile",
    contents: JSON.stringify({
      defaultProfile: "default",
      profiles: {
        "client-work": {
          ...genericPolicyConfig.profiles["builtin:default"],
          extends: ["missing"],
        },
      },
    }),
    messageFragment: "unknown inherited profile",
  },
  {
    label: "reserved-name definition overrides a shipped profile",
    contents: JSON.stringify({
      defaultProfile: "builtin:default",
      profiles: {
        "builtin:default": { extends: ["missing"] },
      },
    }),
    messageFragment: "reserved profile name",
  },
  {
    label: "cyclic inheritance",
    contents: JSON.stringify({
      defaultProfile: "first",
      profiles: {
        first: {
          ...genericPolicyConfig.profiles["builtin:default"],
          extends: ["second"],
        },
        second: {
          ...genericPolicyConfig.profiles["builtin:default"],
          extends: ["first"],
        },
      },
    }),
    messageFragment: "cyclic profile inheritance detected",
  },
  {
    label: "invalid default profile",
    contents: JSON.stringify({
      defaultProfile: "missing",
      profiles: {
        default: genericPolicyConfig.profiles["builtin:default"],
      },
    }),
    messageFragment: "profile 'missing' is not configured",
  },
] as const;

describe("extension harness profile configuration failures", () => {
  it.each(invalidExtensionConfigCases)(
    "keeps registration operational and blocks $label in both UI and non-UI contexts",
    async (testCase) => {
      const configPath = writeConfig(testCase.contents);
      process.env.PI_PERMISSIONS_PROFILE_CONFIG = configPath;

      const uiHarness = createHarness({ hasUI: true });
      expect(uiHarness.commands).toEqual([
        "profile",
        "read-only",
        "permissions",
        "socrates",
        "socrates-off",
      ]);
      expect(uiHarness.handlers.has("tool_call")).toBe(true);

      await emitSessionStart(uiHarness);
      expect(uiHarness.statuses.at(-1)).toEqual({
        key: "permissions",
        text: "invalid-permissions",
      });
      expect(uiHarness.notifications).toHaveLength(1);
      const notification = uiHarness.notifications[0];
      expect(notification?.type).toBe("error");
      expect(notification?.message).toContain(configPath);
      expect(notification?.message).toContain(testCase.messageFragment);

      const uiToolResult = (await emitToolCall(uiHarness)) as
        { block?: boolean; reason?: string } | undefined;
      expect(uiToolResult?.block).toBe(true);
      expect(uiToolResult?.reason).toContain(configPath);
      expect(uiToolResult?.reason).toContain(testCase.messageFragment);

      const nonUiHarness = createHarness({ hasUI: false });
      await emitSessionStart(nonUiHarness);
      expect(nonUiHarness.notifications).toHaveLength(0);
      expect(nonUiHarness.statuses.at(-1)).toEqual({
        key: "permissions",
        text: "invalid-permissions",
      });

      const nonUiToolResult = (await emitToolCall(nonUiHarness)) as
        { block?: boolean; reason?: string } | undefined;
      expect(nonUiToolResult?.block).toBe(true);
      expect(nonUiToolResult?.reason).toContain(configPath);
      expect(nonUiToolResult?.reason).toContain(testCase.messageFragment);
    },
  );

  it("keeps the shipped profiles active when the profile config file is missing", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "pi-permissions-missing-harness-"),
    );
    temporaryDirectories.push(directory);
    const missingConfigPath = path.join(directory, "does-not-exist.jsonc");
    process.env.PI_PERMISSIONS_PROFILE_CONFIG = missingConfigPath;

    const harness = createHarness({ hasUI: true });
    await emitSessionStart(harness);

    expect(harness.notifications).toHaveLength(0);
    expect(harness.statuses.at(-1)).not.toEqual({
      key: "permissions",
      text: "invalid-permissions",
    });
  });
});
