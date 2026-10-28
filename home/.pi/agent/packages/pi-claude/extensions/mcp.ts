import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { parseJson, validateJsonObject } from "./validation.ts";
import { isDeepStrictEqual } from "node:util";

export const MCP_NAME = "pi";
export function sdkToolName({ name }: { name: string }) {
  return `mcp__${MCP_NAME}__${name}`;
}
const ObjectSchema = Type.Object(
  {
    type: Type.Literal("object"),
    properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    required: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true },
);
type Pending = {
  name: string;
  arguments: ReturnType<typeof validateJsonObject>;
  resolve: (result: CallToolResult) => void;
};
type Entry = { block: ToolCall; call?: Pending; result?: CallToolResult; dispatched: boolean };

/** Streamed batches and MCP dispatch are independent. In particular, a
 * mutating MCP client may await A's result before dispatching sibling B. */
export function createRendezvous({
  tools,
  fail,
  onComplete,
}: {
  tools: Tool[];
  fail: ({ error }: { error: Error }) => void;
  onComplete: () => void;
}) {
  const server = new McpServer(
    { name: MCP_NAME, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const definitions = tools.map((tool) => {
    const inputSchema = parseJson({
      text: JSON.stringify(tool.parameters),
      schema: ObjectSchema,
      source: `${tool.name} input schema`,
    });
    for (const key of ["anyOf", "oneOf", "allOf"])
      if (key in inputSchema)
        throw new Error(`pi-claude: ${tool.name} has unsupported root ${key}`);
    return { name: tool.name, description: tool.description, inputSchema };
  });
  const early = new Map<string, Pending>();
  // Ownership outlives result-promise release: an already-received progress
  // event may still be awaiting Pi's observer while tool results are delivered.
  // Retain names/IDs for only this batch, until the next assistant message.
  const progressOwnership = new Map<string, string>();
  let batch: Map<string, Entry> | undefined;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function deadline() {
    clearTimeout(timer);
    timer = setTimeout(
      () => fail({ error: new Error("pi-claude: timed out matching Claude MCP tool dispatch") }),
      10_000,
    );
  }
  function match({ entry, call }: { entry: Entry; call: Pending }) {
    if (
      entry.dispatched ||
      entry.block.name !== call.name ||
      !isDeepStrictEqual(entry.block.arguments, call.arguments)
    )
      throw new Error("pi-claude: SDK MCP dispatch does not match the streamed tool batch");
    entry.dispatched = true;
    entry.call = call;
  }
  function release() {
    if (!batch) return;
    for (const entry of batch.values()) {
      if (entry.call && entry.result) {
        entry.call.resolve(entry.result);
        entry.call = undefined;
      }
    }
    if ([...batch.values()].every((entry) => entry.dispatched && entry.result && !entry.call)) {
      clearTimeout(timer);
      batch = undefined;
      onComplete();
    }
  }
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: definitions }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (closed) throw new Error("pi-claude: MCP query is closed");
      const { name } = request.params;
      if (!tools.some((tool) => tool.name === name))
        throw new Error(`pi-claude: unexpected MCP tool ${name}`);
      const id = request.params._meta?.["claudecode/toolUseId"];
      if (typeof id !== "string" || !id || early.has(id))
        throw new Error("pi-claude: missing or duplicate Claude MCP tool-use ID");
      const args = validateJsonObject({
        value: request.params.arguments,
        source: "MCP tool arguments",
      });
      return await new Promise<CallToolResult>((resolve) => {
        const call = { name, arguments: args, resolve };
        if (batch) {
          const entry = batch.get(id);
          if (!entry) throw new Error("pi-claude: SDK dispatched an unexpected tool-use ID");
          match({ entry, call });
          release();
        } else {
          early.set(id, call);
          deadline();
        }
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("pi-claude: MCP dispatch failed");
      fail({ error: failure });
      throw failure;
    }
  });
  return {
    config: { type: "sdk", name: MCP_NAME, instance: server } satisfies NonNullable<
      Options["mcpServers"]
    >[string],
    expect({ batch: blocks }: { batch: ToolCall[] }) {
      if (closed || batch || progressOwnership.size)
        throw new Error("pi-claude: overlapping MCP tool batches");
      if (!blocks.length || new Set(blocks.map((block) => block.id)).size !== blocks.length)
        throw new Error("pi-claude: empty batch or duplicate SDK tool-use IDs");
      const next = new Map<string, Entry>(
        blocks.map((block) => [block.id, { block, dispatched: false }]),
      );
      for (const [id, call] of early) {
        const entry = next.get(id);
        if (!entry)
          throw new Error("pi-claude: SDK MCP dispatch does not match the streamed tool batch");
        match({ entry, call });
      }
      early.clear();
      clearTimeout(timer);
      batch = next;
      for (const block of blocks) progressOwnership.set(block.id, block.name);
      // Do not wait for handlers: Pi guards execute the complete model batch.
      // No deadline runs while legitimate tool execution/approval is pending.
    },
    deliver({ results }: { results: ToolResultMessage[] }) {
      if (closed || !batch || results.length !== batch.size)
        throw new Error("pi-claude: incomplete Pi tool-result batch");
      const ids = new Set<string>();
      const deliveries = results.map((result) => {
        const entry = batch?.get(result.toolCallId);
        if (
          !entry ||
          entry.result ||
          entry.block.name !== result.toolName ||
          ids.has(result.toolCallId)
        )
          throw new Error("pi-claude: unexpected Pi tool result");
        ids.add(result.toolCallId);
        const content = result.content.map((block) =>
          block.type === "text"
            ? ({ type: "text", text: block.text } satisfies CallToolResult["content"][number])
            : ({
                type: "image",
                data: block.data,
                mimeType: block.mimeType,
              } satisfies CallToolResult["content"][number]),
        );
        return { entry, result: { content, isError: result.isError } satisfies CallToolResult };
      });
      for (const delivery of deliveries) delivery.entry.result = delivery.result;
      deadline();
      release();
    },
    assertProgress({ id, name }: { id: string; name: string }) {
      const pendingName = progressOwnership.get(id) ?? early.get(id)?.name;
      if (!pendingName || name !== sdkToolName({ name: pendingName }))
        throw new Error("pi-claude: SDK tool progress does not belong to a pending Pi tool");
    },
    beginAssistantMessage() {
      progressOwnership.clear();
    },
    assertComplete() {
      if (batch || early.size)
        throw new Error("pi-claude: SDK continued with unresolved MCP dispatch");
    },
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      const cancelled = {
        content: [{ type: "text", text: "Pi cancelled the Claude query" }],
        isError: true,
      } satisfies CallToolResult;
      for (const call of early.values()) call.resolve(cancelled);
      for (const entry of batch?.values() ?? []) entry.call?.resolve(cancelled);
      early.clear();
      progressOwnership.clear();
      batch = undefined;
      await server.close();
    },
  };
}
