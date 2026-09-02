import {
  createSyntheticSourceInfo,
  type BeforeAgentStartEvent,
  type BeforeAgentStartEventResult,
  type CustomEntry,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionHandler,
  type RegisteredCommand,
  type SessionEntry as SdkSessionEntry,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ToolDefinition,
  type UserBashEvent,
  type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { vi, type Mock } from "vitest";
import type { Component } from "@earendil-works/pi-tui";
import permissionsExtension from "../../extensions/guard";
import {
  askPermissionChoices,
  profileUpdateTargets,
  type AskPermissionChoice,
  type ProfileUpdateTarget,
} from "../../modules/profileUpdate";

type CommandRegistration = Omit<RegisteredCommand, "name" | "sourceInfo">;
type ShortcutRegistration = Parameters<ExtensionAPI["registerShortcut"]>[1];

type SessionEntryInput =
  | SdkSessionEntry
  | (Partial<CustomEntry> & {
      type: "custom";
      customType: string;
    });

type InteractiveSelection = {
  title: string;
  options: string[];
  resolve: (value: string | undefined) => void;
  resolved: boolean;
};

type InteractiveCustom = {
  component: Component;
  resolve: (value: unknown) => void;
  resolved: boolean;
};

type HarnessError =
  | { event: "session_start"; error: unknown }
  | { event: "session_shutdown"; error: unknown }
  | { event: "before_agent_start"; error: unknown };

type HandledEvents = {
  session_start: SessionStartEvent;
  session_shutdown: SessionShutdownEvent;
  before_agent_start: BeforeAgentStartEvent;
  tool_call: ToolCallEvent;
  user_bash: UserBashEvent;
};

type HandlerStore = {
  [K in keyof HandledEvents]: Array<
    ExtensionHandler<
      HandledEvents[K],
      K extends "before_agent_start"
        ? BeforeAgentStartEventResult
        : K extends "tool_call"
          ? ToolCallEventResult
          : K extends "user_bash"
            ? UserBashEventResult
            : void
    >
  >;
};

type ToolRegistration = ToolDefinition & {
  sourceInfo?: ReturnType<typeof createSyntheticSourceInfo>;
};

const inheritedSubagentProfile = process.env.PI_SUBAGENT_PROFILE;
const inheritedSubagentPermissibleGlobs =
  process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS;

export function createExtensionHarness(
  options: {
    contextCwd?: string;
    hasUI?: boolean;
    confirm?: boolean;
    editorResult?: string;
    inputResults?: Array<string | undefined>;
    selectResults?: Array<string | undefined>;
    customResults?: Array<unknown>;
    entries?: SessionEntryInput[];
    registeredTools?: string[];
    activeTools?: string[];
    /**
     * When true, UI prompts wait for the typed drivers on `harness.ui`.
     * The default fixture mode remains deterministic and queue-driven.
     */
    interactiveUi?: boolean;
  } = {},
) {
  const contextCwd = options.contextCwd ?? process.cwd();
  const builtInToolNames = [
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
  ];
  const registeredToolNames = new Set(
    options.registeredTools ?? builtInToolNames,
  );
  const activeToolNames = new Set(
    (options.activeTools ?? ["read", "bash", "edit", "write"]).filter((name) =>
      registeredToolNames.has(name),
    ),
  );
  const entries = normalizeEntries(options.entries ?? []);
  const errors: HarnessError[] = [];
  const handlers: HandlerStore = {
    session_start: [],
    session_shutdown: [],
    before_agent_start: [],
    tool_call: [],
    user_bash: [],
  };
  const commands = new Map<string, CommandRegistration>();
  const shortcuts = new Map<string, ShortcutRegistration>();
  const tools = new Map<string, ToolRegistration>();
  let started = false;
  let nextEntryId = entries.length + 1;

  const inputResults = [...(options.inputResults ?? [])];
  const selectResults = [...(options.selectResults ?? [])];
  const customResults = [...(options.customResults ?? [])];
  const customComponents: Component[] = [];
  const pendingSelections: InteractiveSelection[] = [];
  const pendingCustom: InteractiveCustom[] = [];
  const selectionWaiters: Array<(selection: InteractiveSelection) => void> = [];
  const customWaiters: Array<(custom: InteractiveCustom) => void> = [];

  function publishSelection(selection: InteractiveSelection): void {
    pendingSelections.push(selection);
    for (let index = selectionWaiters.length - 1; index >= 0; index--) {
      const waiter = selectionWaiters[index];
      if (waiter) {
        selectionWaiters.splice(index, 1);
        waiter(selection);
      }
    }
  }

  function publishCustom(custom: InteractiveCustom): void {
    pendingCustom.push(custom);
    customWaiters.splice(0).forEach((waiter) => waiter(custom));
  }

  function nextSelection(
    predicate: (selection: InteractiveSelection) => boolean,
  ): Promise<InteractiveSelection> {
    const existing = pendingSelections.find(
      (selection) => !selection.resolved && predicate(selection),
    );
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const waiter = (selection: InteractiveSelection) => {
        if (predicate(selection)) resolve(selection);
        else selectionWaiters.push(waiter);
      };
      selectionWaiters.push(waiter);
    });
  }

  function nextCustom(): Promise<InteractiveCustom> {
    const existing = pendingCustom.find((custom) => !custom.resolved);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => customWaiters.push(resolve));
  }

  function pressKey(component: Component, key: string): void {
    const keys: Record<string, string> = {
      Tab: "\t",
      Enter: "\n",
      Escape: "\x1b",
      ArrowUp: "\x1b[A",
      ArrowDown: "\x1b[B",
      ArrowLeft: "\x1b[D",
      ArrowRight: "\x1b[C",
      CtrlShiftR: "\x1b[114;6u",
    };
    component.handleInput?.(keys[key] ?? key);
  }
  // Custom UI tests only need deterministic plain text styling; Pi's runtime
  // supplies the real Theme and TUI instances.
  const testTheme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const testTui = { requestRender: vi.fn() };
  const ui = {
    confirm: vi.fn().mockResolvedValue(options.confirm ?? false),
    editor: vi.fn().mockResolvedValue(options.editorResult),
    input: vi.fn().mockImplementation(() => inputResults.shift()),
    select: vi
      .fn()
      .mockImplementation(
        (
          title: string,
          selectOptions: string[],
          permissionMessage?: string,
        ) => {
          if (options.interactiveUi) {
            return new Promise<string | undefined>((resolve) =>
              publishSelection({
                title,
                options: selectOptions,
                resolve,
                resolved: false,
              }),
            );
          }
          // ASK prompts now use a three-way select. Existing behavioral tests
          // express their intended response with `confirm`; map that legacy test
          // fixture to Yes/No while retaining the original assertion surface.
          if (selectResults.length > 0) return selectResults.shift();
          if (permissionMessage !== undefined) {
            ui.confirm(title.split("\n\n", 1)[0] ?? title, permissionMessage);
            return (options.confirm ?? false) ? "Yes" : "No (default)";
          }
          return undefined;
        },
      ),
    custom: vi.fn().mockImplementation((factory: unknown) => {
      if (typeof factory === "function") {
        let resolveInteractive: (value: unknown) => void = () => undefined;
        let interactiveCustom: InteractiveCustom | undefined;
        const interactiveResult = options.interactiveUi
          ? new Promise<unknown>((resolve) => {
              resolveInteractive = resolve;
            })
          : undefined;
        const component = (
          factory as (
            tui: typeof testTui,
            theme: typeof testTheme,
            keybindings: unknown,
            done: (value: unknown) => void,
          ) => Component
        )(testTui, testTheme, undefined, (value: unknown) => {
          if (options.interactiveUi) {
            interactiveCustom!.resolved = true;
            resolveInteractive(value);
          }
        });
        customComponents.push(component);
        if (options.interactiveUi) {
          // Pi focuses an opened custom modal. Mirror that lifecycle before
          // driving its public keyboard input surface.
          (component as Component & { focused?: boolean }).focused = true;
          interactiveCustom = {
            component,
            resolve: resolveInteractive,
            resolved: false,
          };
          publishCustom(interactiveCustom);
          return interactiveResult;
        }
      }
      return customResults.shift() ?? null;
    }),
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWorkingVisible: vi.fn(),
  } satisfies Pick<
    ExtensionContext["ui"],
    | "confirm"
    | "editor"
    | "input"
    | "select"
    | "custom"
    | "notify"
    | "setStatus"
    | "setWorkingVisible"
  >;

  const sessionManager = {
    getEntries: () => entries,
  } satisfies Pick<ExtensionContext["sessionManager"], "getEntries">;

  const context = {
    cwd: contextCwd,
    hasUI: options.hasUI ?? true,
    ui,
    sessionManager,
  };
  const extensionContext = context as unknown as ExtensionCommandContext;

  const setActiveToolsMock = vi.fn((toolNames: string[]) => {
    activeToolNames.clear();
    for (const name of toolNames) {
      if (registeredToolNames.has(name)) activeToolNames.add(name);
    }
  });

  const pi = {
    on<E extends keyof HandledEvents>(
      event: E,
      handler: HandlerStore[E][number],
    ) {
      handlers[event].push(handler);
    },
    registerCommand(name: string, registration: CommandRegistration) {
      commands.set(name, registration);
    },
    registerShortcut(shortcut, registration) {
      shortcuts.set(shortcut, registration);
    },
    registerTool: ((tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
      const sourceInfo = createSyntheticSourceInfo(
        `./extensions/${tool.name}.ts`,
        {
          source: "permissions-extension",
          scope: "project",
          origin: "top-level",
        },
      );
      tools.set(tool.name, { ...tool, sourceInfo });
      registeredToolNames.add(tool.name);
    }) as ExtensionAPI["registerTool"],
    appendEntry(customType: string, data: unknown) {
      entries.push(
        createCustomEntry({ customType, data, sequence: nextEntryId++ }),
      );
    },
    getActiveTools: () => [...activeToolNames],
    getAllTools: () =>
      [...registeredToolNames].map((name) => {
        const tool = tools.get(name);
        if (tool) {
          return {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            sourceInfo: tool.sourceInfo,
          };
        }
        return {
          name,
          sourceInfo: createSyntheticSourceInfo(`./builtin/${name}.ts`, {
            source: "builtin",
            scope: "temporary",
            origin: "top-level",
          }),
        };
      }) as unknown as ReturnType<ExtensionAPI["getAllTools"]>,
    setActiveTools: setActiveToolsMock,
  } satisfies Pick<
    ExtensionAPI,
    | "on"
    | "registerCommand"
    | "registerShortcut"
    | "registerTool"
    | "appendEntry"
    | "getActiveTools"
    | "getAllTools"
    | "setActiveTools"
  >;

  const currentSubagentProfile = process.env.PI_SUBAGENT_PROFILE;
  const currentSubagentPermissibleGlobs =
    process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS;
  const clearSubagentProfile =
    currentSubagentProfile === inheritedSubagentProfile;
  const clearSubagentPermissibleGlobs =
    currentSubagentPermissibleGlobs === inheritedSubagentPermissibleGlobs;
  if (clearSubagentProfile) delete process.env.PI_SUBAGENT_PROFILE;
  if (clearSubagentPermissibleGlobs)
    delete process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS;
  permissionsExtension(pi as unknown as ExtensionAPI);
  if (currentSubagentProfile === undefined) {
    delete process.env.PI_SUBAGENT_PROFILE;
  } else {
    process.env.PI_SUBAGENT_PROFILE = currentSubagentProfile;
  }
  if (currentSubagentPermissibleGlobs === undefined) {
    delete process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS;
  } else {
    process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS = currentSubagentPermissibleGlobs;
  }

  function ensureStarted(operation: string): void {
    if (!started) {
      throw new Error(`Harness must be started before ${operation}`);
    }
  }

  function captureError(error: HarnessError): void {
    errors.push(error);
  }

  async function dispatchSessionStart(event: SessionStartEvent): Promise<void> {
    for (const handler of handlers.session_start) {
      try {
        await handler(event, extensionContext);
      } catch (error) {
        captureError({ event: "session_start", error });
      }
    }
  }

  async function dispatchSessionShutdown(
    event: SessionShutdownEvent,
  ): Promise<void> {
    for (const handler of handlers.session_shutdown) {
      try {
        await handler(event, extensionContext);
      } catch (error) {
        captureError({ event: "session_shutdown", error });
      }
    }
  }

  async function dispatchBeforeAgentStart(
    event: BeforeAgentStartEvent,
  ): Promise<BeforeAgentStartEventResult | undefined> {
    let systemPrompt = event.systemPrompt;
    let result: BeforeAgentStartEventResult | undefined;

    for (const handler of handlers.before_agent_start) {
      try {
        const handlerResult = await handler(
          { ...event, systemPrompt },
          extensionContext,
        );
        if (handlerResult?.systemPrompt !== undefined) {
          systemPrompt = handlerResult.systemPrompt;
        }
        if (handlerResult) {
          result = { ...result, ...handlerResult, systemPrompt };
        }
      } catch (error) {
        captureError({ event: "before_agent_start", error });
      }
    }

    return result;
  }

  async function dispatchToolCall(
    event: ToolCallEvent,
  ): Promise<ToolCallEventResult | undefined> {
    let result: ToolCallEventResult | undefined;
    for (const handler of handlers.tool_call) {
      const handlerResult = await handler(event, extensionContext);
      if (handlerResult) {
        result = handlerResult;
        if (result.block) return result;
      }
    }
    return result;
  }

  async function dispatchUserBash(
    event: UserBashEvent,
  ): Promise<UserBashEventResult | undefined> {
    for (const handler of handlers.user_bash) {
      const handlerResult = await handler(event, extensionContext);
      if (handlerResult) return handlerResult;
    }
    return undefined;
  }

  async function callTool(event: Omit<ToolCallEvent, "type" | "toolCallId">) {
    ensureStarted("callTool");
    return await dispatchToolCall({
      ...event,
      type: "tool_call",
      toolCallId: "test-tool-call",
    });
  }

  async function executeRegisteredTool({
    name,
    params,
    options = {},
  }: {
    name: string;
    params: unknown;
    options?: { signal?: AbortSignal };
  }) {
    ensureStarted("executeRegisteredTool");
    const tool = tools.get(name);
    if (!tool) throw new Error(`Tool not registered: ${name}`);
    return await tool.execute(
      "test-tool-call",
      params,
      options.signal,
      undefined,
      extensionContext,
    );
  }

  /** Observe the permission modal created by an in-flight callTool. */
  async function waitForPermissionChoice(): Promise<{
    choose: (choice: AskPermissionChoice) => void;
  }> {
    const selection = await nextSelection((item) =>
      item.options.includes(askPermissionChoices[2]),
    );
    return {
      choose(choice) {
        if (!selection.options.includes(choice))
          throw new Error(`Unknown permission choice: ${choice}`);
        selection.resolved = true;
        selection.resolve(choice);
      },
    };
  }

  /** Observe the profile-rule destination modal created by an in-flight callTool. */
  async function waitForProfileUpdateTarget(): Promise<{
    choose: (target: ProfileUpdateTarget) => void;
  }> {
    const selection = await nextSelection((item) =>
      item.options.includes(profileUpdateTargets[2]),
    );
    return {
      choose(target) {
        if (!selection.options.includes(target))
          throw new Error(`Unknown profile update target: ${target}`);
        selection.resolved = true;
        selection.resolve(target);
      },
    };
  }

  /** Observe a visible rule form and drive it with user-like key and text input. */
  /** Observe any custom modal and drive it through its public UI surface. */
  async function waitForCustomModal(): Promise<{
    render: (width?: number) => string[];
    press: (key: string) => void;
    type: (text: string) => void;
  }> {
    const custom = await nextCustom();
    return {
      render(width = 80) {
        return custom.component.render(width);
      },
      press(key) {
        pressKey(custom.component, key);
      },
      type(text) {
        for (const character of text) pressKey(custom.component, character);
      },
    };
  }

  async function waitForRuleForm(): Promise<{
    render: (width?: number) => string[];
    press: (key: string) => void;
    type: (text: string) => void;
  }> {
    return waitForCustomModal();
  }

  /** Observe a select prompt, including its title and available choices. */
  async function waitForSelection(): Promise<{
    title: string;
    options: string[];
    choose: (choice: string) => void;
  }> {
    const selection = await nextSelection(() => true);
    return {
      title: selection.title,
      options: selection.options,
      choose(choice) {
        if (!selection.options.includes(choice))
          throw new Error(`Unknown selection: ${choice}`);
        selection.resolved = true;
        selection.resolve(choice);
      },
    };
  }

  return {
    commands,
    shortcuts,
    context,
    entries,
    errors,
    ui: {
      ...ui,
      waitForPermissionChoice,
      waitForProfileUpdateTarget,
      waitForCustomModal,
      waitForRuleForm,
      waitForSelection,
    },
    customComponents,
    setActiveToolsMock,
    getActiveTools: () => [...activeToolNames],
    getAllTools: () => pi.getAllTools(),
    onUserBash(handler: HandlerStore["user_bash"][number]) {
      handlers.user_bash.push(handler);
    },
    /** Simulates another extension or the user deactivating a tool mid-session. */
    deactivateTool(nameOrTool: string | { name: string }) {
      const name =
        typeof nameOrTool === "string" ? nameOrTool : nameOrTool.name;
      activeToolNames.delete(name);
    },
    async start({
      reason = "startup",
    }: { reason?: SessionStartEvent["reason"] } = {}) {
      started = true;
      await dispatchSessionStart({ type: "session_start", reason });
    },
    async callTool(event: Omit<ToolCallEvent, "type" | "toolCallId">) {
      return await callTool(event);
    },
    async executeTool(
      nameOrEvent:
        | string
        | {
            name: string;
            params: unknown;
            options?: { signal?: AbortSignal };
          },
      params?: unknown,
      options: { signal?: AbortSignal } = {},
    ) {
      if (typeof nameOrEvent === "string") {
        return await executeRegisteredTool({
          name: nameOrEvent,
          params,
          options,
        });
      }
      return await executeRegisteredTool(nameOrEvent);
    },
    async callUserBash(
      event: Omit<UserBashEvent, "type">,
    ): Promise<UserBashEventResult | undefined> {
      ensureStarted("callUserBash");
      return await dispatchUserBash({ ...event, type: "user_bash" });
    },
    async callToolWithoutPrompt(
      event: Omit<ToolCallEvent, "type" | "toolCallId">,
    ) {
      const confirmCalls = ui.confirm.mock.calls.length;
      const result = await callTool(event);
      if (ui.confirm.mock.calls.length !== confirmCalls) {
        throw new Error(
          `Expected ${event.toolName} to be allowed without prompting, but ui.confirm was invoked`,
        );
      }
      return result;
    },
    async beforeAgent({
      systemPrompt = "Base system prompt",
    }: {
      systemPrompt?: string;
    } = {}) {
      ensureStarted("beforeAgent");
      return await dispatchBeforeAgentStart({
        type: "before_agent_start",
        prompt: "test prompt",
        systemPrompt,
        systemPromptOptions: { cwd: contextCwd },
      });
    },
    async shutdown() {
      ensureStarted("shutdown");
      await dispatchSessionShutdown({
        type: "session_shutdown",
        reason: "quit",
      });
      started = false;
    },
    async runCommand(
      nameOrEvent: string | { name: string; args?: string },
      args = "",
    ) {
      ensureStarted("runCommand");
      const name =
        typeof nameOrEvent === "string" ? nameOrEvent : nameOrEvent.name;
      const commandArgs =
        typeof nameOrEvent === "string" ? args : (nameOrEvent.args ?? "");
      const command = commands.get(name);
      if (!command) throw new Error(`Command not registered: ${name}`);
      await command.handler(commandArgs, extensionContext);
    },
    replaceToolSource(name: string, source: string) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      tool.sourceInfo = createSyntheticSourceInfo(`./extensions/${name}.ts`, {
        source,
        scope: "project",
        origin: "top-level",
      });
    },
    command({ name }: { name: string }) {
      const command = commands.get(name);
      if (!command) throw new Error(`Command not registered: ${name}`);
      return command;
    },
  };
}

function normalizeEntries(entries: SessionEntryInput[]): SdkSessionEntry[] {
  return entries.map((entry, index) =>
    entry.type === "custom"
      ? createCustomEntry({
          customType: entry.customType,
          data: entry.data,
          sequence: index + 1,
          entry,
        })
      : entry,
  );
}

function createCustomEntry({
  customType,
  data,
  sequence,
  entry = {},
}: {
  customType: string;
  data: unknown;
  sequence: number;
  entry?: Partial<CustomEntry>;
}): SdkSessionEntry {
  return {
    type: "custom",
    id: entry.id ?? `custom-entry-${sequence}`,
    parentId: entry.parentId ?? null,
    timestamp: entry.timestamp ?? new Date().toISOString(),
    customType,
    data,
  };
}

export function lastCallArgument({
  mock,
  index,
}: {
  mock: Mock;
  index: number;
}): unknown {
  return mock.mock.calls.at(-1)?.[index];
}
