import {
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
} from "@earendil-works/pi-coding-agent";
import { vi, type Mock } from "vitest";
import permissionsExtension from "../../extensions/permissions";

type CommandRegistration = Omit<RegisteredCommand, "name" | "sourceInfo">;

type SessionEntryInput =
  | SdkSessionEntry
  | (Partial<CustomEntry> & {
      type: "custom";
      customType: string;
    });

type HarnessError =
  | { event: "session_start"; error: unknown }
  | { event: "session_shutdown"; error: unknown }
  | { event: "before_agent_start"; error: unknown };

type HandledEvents = {
  session_start: SessionStartEvent;
  session_shutdown: SessionShutdownEvent;
  before_agent_start: BeforeAgentStartEvent;
  tool_call: ToolCallEvent;
};

type HandlerStore = {
  [K in keyof HandledEvents]: Array<
    ExtensionHandler<
      HandledEvents[K],
      K extends "before_agent_start"
        ? BeforeAgentStartEventResult
        : K extends "tool_call"
          ? ToolCallEventResult
          : void
    >
  >;
};

export function createExtensionHarness(
  options: {
    contextCwd?: string;
    hasUI?: boolean;
    confirm?: boolean;
    editorResult?: string;
    entries?: SessionEntryInput[];
  } = {},
) {
  const contextCwd = options.contextCwd ?? process.cwd();
  const entries = normalizeEntries(options.entries ?? []);
  const errors: HarnessError[] = [];
  const handlers: HandlerStore = {
    session_start: [],
    session_shutdown: [],
    before_agent_start: [],
    tool_call: [],
  };
  const commands = new Map<string, CommandRegistration>();
  let started = false;
  let nextEntryId = entries.length + 1;

  const ui = {
    confirm: vi.fn().mockResolvedValue(options.confirm ?? false),
    editor: vi.fn().mockResolvedValue(options.editorResult),
    input: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWorkingVisible: vi.fn(),
  } satisfies Pick<
    ExtensionContext["ui"],
    | "confirm"
    | "editor"
    | "input"
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
  // Runtime boundary: the harness stores the narrow shape and exposes the SDK context type here.
  const extensionContext = context as unknown as ExtensionCommandContext;

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
    appendEntry(customType: string, data: unknown) {
      entries.push(createCustomEntry(customType, data, nextEntryId++));
    },
  } satisfies Pick<ExtensionAPI, "on" | "registerCommand" | "appendEntry">;

  // Runtime boundary: the real extension factory expects the full SDK API.
  permissionsExtension(pi as unknown as ExtensionAPI);

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

  async function callTool(event: Omit<ToolCallEvent, "type" | "toolCallId">) {
    ensureStarted("callTool");
    return await dispatchToolCall({
      ...event,
      type: "tool_call",
      toolCallId: "test-tool-call",
    });
  }

  return {
    commands,
    context,
    entries,
    errors,
    ui,
    async start(reason: SessionStartEvent["reason"] = "startup") {
      started = true;
      await dispatchSessionStart({ type: "session_start", reason });
    },
    async callTool(event: Omit<ToolCallEvent, "type" | "toolCallId">) {
      return await callTool(event);
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
    async beforeAgent(systemPrompt = "Base system prompt") {
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
    async runCommand(name: string, args = "") {
      ensureStarted("runCommand");
      const command = commands.get(name);
      if (!command) throw new Error(`Command not registered: ${name}`);
      await command.handler(args, extensionContext);
    },
    command(name: string) {
      const command = commands.get(name);
      if (!command) throw new Error(`Command not registered: ${name}`);
      return command;
    },
  };
}

function normalizeEntries(entries: SessionEntryInput[]): SdkSessionEntry[] {
  return entries.map((entry, index) =>
    entry.type === "custom"
      ? createCustomEntry(entry.customType, entry.data, index + 1, entry)
      : entry,
  );
}

function createCustomEntry(
  customType: string,
  data: unknown,
  sequence: number,
  entry: Partial<CustomEntry> = {},
): SdkSessionEntry {
  return {
    type: "custom",
    id: entry.id ?? `custom-entry-${sequence}`,
    parentId: entry.parentId ?? null,
    timestamp: entry.timestamp ?? new Date().toISOString(),
    customType,
    data,
  };
}

export function lastCallArgument(mock: Mock, index: number): unknown {
  return mock.mock.calls.at(-1)?.[index];
}
