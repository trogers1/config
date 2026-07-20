import {
  type BeforeAgentStartEvent,
  type BeforeAgentStartEventResult,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionEvent,
  type ExtensionHandler,
  type SessionStartEvent,
  type ToolCallEvent,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { vi, type Mock } from "vitest";
import permissionsExtension from "../../extensions/permissions";

type CommandRegistration = {
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
  getArgumentCompletions?: (prefix: string) => Array<{
    value: string;
    label: string;
    description?: string;
  }> | null;
};

type SessionEntry = {
  type: string;
  customType?: string;
  data?: unknown;
};

export function createExtensionHarness(
  options: {
    cwd?: string;
    hasUI?: boolean;
    confirm?: boolean;
    editorResult?: string;
    entries?: SessionEntry[];
  } = {},
) {
  const cwd = options.cwd ?? process.cwd();
  const entries = [...(options.entries ?? [])];
  const handlers = new Map<
    string,
    Array<ExtensionHandler<ExtensionEvent, unknown>>
  >();
  const commands = new Map<string, CommandRegistration>();

  const ui = {
    confirm: vi.fn().mockResolvedValue(options.confirm ?? true),
    editor: vi.fn().mockResolvedValue(options.editorResult),
    input: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWorkingVisible: vi.fn(),
  };

  const context = {
    cwd,
    hasUI: options.hasUI ?? true,
    ui,
    sessionManager: {
      getEntries: () => entries,
    },
  } as unknown as ExtensionCommandContext;

  const pi = {
    on(event: string, handler: ExtensionHandler<ExtensionEvent, unknown>) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, registration: CommandRegistration) {
      commands.set(name, registration);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
  } as unknown as ExtensionAPI;

  permissionsExtension(pi);

  async function emit(event: ExtensionEvent): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of handlers.get(event.type) ?? []) {
      results.push(await handler(event, context));
    }
    return results;
  }

  return {
    commands,
    context,
    entries,
    ui,
    async start(reason: SessionStartEvent["reason"] = "startup") {
      await emit({ type: "session_start", reason });
    },
    async callTool(event: Omit<ToolCallEvent, "type" | "toolCallId">) {
      const [result] = await emit({
        ...event,
        type: "tool_call",
        toolCallId: "test-tool-call",
      });
      return result as ToolCallEventResult | undefined;
    },
    async beforeAgent(systemPrompt = "Base system prompt") {
      const [result] = await emit({
        type: "before_agent_start",
        prompt: "test prompt",
        systemPrompt,
        systemPromptOptions: {},
      } as BeforeAgentStartEvent);
      return result as BeforeAgentStartEventResult | undefined;
    },
    async shutdown() {
      await emit({ type: "session_shutdown", reason: "quit" });
    },
    async runCommand(name: string, args = "") {
      const command = commands.get(name);
      if (!command) throw new Error(`Command not registered: ${name}`);
      await command.handler(args, context);
    },
    command(name: string) {
      const command = commands.get(name);
      if (!command) throw new Error(`Command not registered: ${name}`);
      return command;
    },
  };
}

export function lastCallArgument(mock: Mock, index: number): unknown {
  return mock.mock.calls.at(-1)?.[index];
}
