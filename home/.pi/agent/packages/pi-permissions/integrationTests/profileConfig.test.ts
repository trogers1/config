import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import permissionsExtension from "../extensions/permissions";
import { policyConfig as genericPolicyConfig } from "../modules/policy";
import {
  ProfileConfigLoadError,
  loadProfileConfig,
} from "../modules/profileConfig";

const temporaryDirectories: string[] = [];

afterEach(() => {
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
  it("uses the shipped profiles when the user configuration is absent", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      path.join(os.tmpdir(), "missing-pi-permissions-profiles.jsonc"),
    );

    expect(config).toBe(genericPolicyConfig);
  });

  it("parses JSONC and extends a shipped profile", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig(`{
        // Editor JSON Schema directives, comments, and trailing commas are supported.
        "$schema": "https://example.test/profiles.schema.json",
        "profiles": {
          "client-work": {
            "extends": "default",
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
      genericPolicyConfig.profiles.default.tools.bash?.length ?? 0,
    );
    expect(clientWork.readPaths).toEqual([
      ...genericPolicyConfig.profiles.default.readPaths,
      { pattern: "vendor/**", decision: "deny", contexts: ["grep"] },
    ]);
  });

  it("appends inherited custom tool rules", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig(`{
        "profiles": {
          "deployment-base": {
            "extends": "default",
            "tools": {
              "deploy": [
                { "decision": "ask" },
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
      }`),
    );

    expect(config.profiles["deployment-child"].tools.deploy).toEqual([
      { decision: "ask" },
      { decision: "deny", match: { environment: "production" } },
      { decision: "allow", match: { environment: "staging" } },
    ]);
  });

  it("preserves empty inherited custom tool arrays", () => {
    const config = loadProfileConfig(
      genericPolicyConfig,
      writeConfig(`{
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
      }`),
    );

    expect(config.profiles["deployment-child"].tools.deploy).toEqual([]);
  });

  it("accepts a fully custom profile without extends", () => {
    const standaloneProfile = {
      ...genericPolicyConfig.profiles.default,
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
            ...genericPolicyConfig.profiles.default,
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

  it("throws a typed error for unknown or cyclic inheritance and invalid defaults", () => {
    const unknownInheritedConfigPath = writeConfig(
      JSON.stringify({
        defaultProfile: "default",
        profiles: {
          "client-work": {
            ...genericPolicyConfig.profiles.default,
            extends: "missing",
          },
        },
      }),
    );
    const cyclicConfigPath = writeConfig(
      JSON.stringify({
        defaultProfile: "first",
        profiles: {
          first: {
            ...genericPolicyConfig.profiles.default,
            extends: "second",
          },
          second: {
            ...genericPolicyConfig.profiles.default,
            extends: "first",
          },
        },
      }),
    );
    const invalidDefaultConfigPath = writeConfig(
      JSON.stringify({
        defaultProfile: "missing",
        profiles: {
          default: genericPolicyConfig.profiles.default,
        },
      }),
    );

    for (const [configPath, messageFragment] of [
      [unknownInheritedConfigPath, "unknown inherited profile"],
      [cyclicConfigPath, "cyclic profile inheritance detected"],
      [invalidDefaultConfigPath, "profile 'missing' is not configured"],
    ] as const) {
      try {
        loadProfileConfig(genericPolicyConfig, configPath);
        throw new Error("expected loadProfileConfig to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ProfileConfigLoadError);
        expect((error as ProfileConfigLoadError).configPath).toBe(configPath);
        expect((error as Error).message).toContain(configPath);
        expect((error as Error).message).toContain(messageFragment);
      }
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

describe("extension harness profile configuration failures", () => {
  it("keeps registration operational and blocks invalid configurations in both UI and non-UI contexts", async () => {
    const cases = [
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
              ...genericPolicyConfig.profiles.default,
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
              ...genericPolicyConfig.profiles.default,
              extends: "missing",
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
              ...genericPolicyConfig.profiles.default,
              extends: "second",
            },
            second: {
              ...genericPolicyConfig.profiles.default,
              extends: "first",
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
            default: genericPolicyConfig.profiles.default,
          },
        }),
        messageFragment: "profile 'missing' is not configured",
      },
    ] as const;

    for (const testCase of cases) {
      const configPath = writeConfig(testCase.contents);
      process.env.PI_PERMISSIONS_PROFILE_CONFIG = configPath;

      const uiHarness = createHarness({ hasUI: true });
      expect(uiHarness.commands).toEqual([
        "profile",
        "read-only",
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
    }
  });

  it("keeps the shipped profiles active when the profile config file is missing", async () => {
    const missingConfigPath = path.join(
      os.tmpdir(),
      `pi-permissions-missing-${Date.now()}.jsonc`,
    );
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
