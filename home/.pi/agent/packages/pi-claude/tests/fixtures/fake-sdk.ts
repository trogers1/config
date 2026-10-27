import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  AccountInfo,
  Options,
  Query,
  SDKMessage,
  SDKSystemMessage,
  SDKUserMessage,
  query,
} from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MCP_NAME, sdkToolName } from "../../extensions/mcp.ts";
import { SDK_RUNTIME_METADATA } from "../../extensions/cli.ts";
import { WrittenRecordSchema, type WrittenRecord } from "../../extensions/reconstruction/schema.ts";
import { parseJson } from "../../extensions/validation.ts";
import {
  apiMessage,
  IN_FLIGHT_TEXT,
  SERIALIZED_WRITE_ARGS,
  finish,
  frame,
  READ_ARGS,
  READ_DEFINITION,
  SKILL_READ_ARGS,
  PROTECTED_SKILL_ARGS,
  PROTECTED_ARGS,
  result,
  start,
  textEvents,
  WRITE_ARGS,
  WRITE_DEFINITION,
} from "../contract.ts";

export type ToolRequest = { name: string; arguments: Record<string, unknown>; id: string };
export type Scenario =
  | "text"
  | "empty"
  | "completed-empty-restart"
  | "completed-thinking-restart"
  | "completed-text-restart"
  | "unfinished-restart"
  | "thinking"
  | "progress"
  | "foreign-progress"
  | "subagent-progress"
  | "wrong-session-progress"
  | "wrong-name-progress"
  | "native-task-progress"
  | "native-subagent-progress"
  | "stale-progress"
  | "unexpected-skills"
  | "unexpected-plugins"
  | "no-init"
  | "pre-init-model"
  | "quota-after-tool"
  | "pipeline"
  | "parallel"
  | "skill-files"
  | "denied"
  | "cancel"
  | "parked"
  | "quota"
  | "auth"
  | "malformed"
  | "eof"
  | "throw"
  | "missing-meta"
  | "serialized"
  | "secret-tool"
  | "transient";
export type Observation = {
  options: Options;
  sessionId: string;
  inputs: SDKUserMessage[];
  accountChecked: boolean;
  resumedRecords: WrittenRecord[];
  wireHistory: string[];
  results: { id: string; result: CallToolResult }[];
  deliveredToolIds: string[];
  permissions: Awaited<ReturnType<NonNullable<Options["canUseTool"]>>>[];
  tools: string[];
  closed: boolean;
  interrupted: boolean;
  initContinuationReached: boolean;
};
let scenario: Scenario = "text";
let sequence: Scenario[] = [];
// Sanitized current CLI 2.1.301 / SDK 0.3.293 accountInfo observation:
// firstParty provider is present; the optional apiKeySource is absent.
export const SDK_ACCOUNT_METADATA = {
  apiProvider: "firstParty",
} satisfies AccountInfo;
let accountMetadata: AccountInfo = SDK_ACCOUNT_METADATA;
let accountFailure: "reject" | "pending" | undefined;
let initOverrides: Record<string, unknown> = {};
const nativeSessions = new Map<string, string[]>();
export const observations: Observation[] = [];
export const PAYLOAD_SECRETS = {
  user: "user-boundary-secret",
  tool: "tool-result-boundary-secret",
  redacted: "[redacted-fixture]",
};
export function configureFake({
  next,
  reset = true,
  then = [],
  account = SDK_ACCOUNT_METADATA,
  failAccount,
  rawInit = {},
}: {
  next: Scenario;
  reset?: boolean;
  then?: Scenario[];
  account?: AccountInfo;
  failAccount?: typeof accountFailure;
  rawInit?: Record<string, unknown>;
}) {
  initOverrides = rawInit;
  accountMetadata = account;
  accountFailure = failAccount;
  scenario = next;
  sequence = [...then];
  if (reset) {
    observations.length = 0;
    nativeSessions.clear();
  }
}
const unsupported = async (): Promise<never> => {
  throw new Error("Unexpected SDK control method in owned-provider test");
};

export const fakeQuery: typeof query = ({ prompt, options = {} }) => {
  // Match the real public SDK query() side effect before constructing a query.
  process.env.CLAUDE_AGENT_SDK_VERSION = SDK_RUNTIME_METADATA.version;
  const model = options.model;
  assert(model, "Owned provider must select an SDK model");
  const selected = scenario;
  const metadata = structuredClone(accountMetadata);
  const failure = accountFailure;
  const rawInit = structuredClone(initOverrides);
  scenario = sequence.shift() ?? scenario;
  const sessionId =
    options.sessionId ??
    (options.resume && !isAbsolute(options.resume) ? options.resume : randomUUID());
  const resumedRecords =
    options.resume && isAbsolute(options.resume)
      ? readFileSync(options.resume, "utf8")
          .trim()
          .split("\n")
          .map((text) =>
            parseJson({ text, schema: WrittenRecordSchema, source: "SDK fake resume boundary" }),
          )
      : [];
  if (options.resume && !isAbsolute(options.resume))
    assert(
      nativeSessions.has(options.resume),
      "SDK resume ID must refer to a previously completed native session",
    );
  const observation: Observation = {
    options,
    sessionId,
    inputs: [],
    accountChecked: false,
    resumedRecords,
    wireHistory:
      options.resume && !isAbsolute(options.resume)
        ? [...(nativeSessions.get(options.resume) ?? [])]
        : resumedRecords.map((record) => JSON.stringify(record.message)),
    results: [],
    deliveredToolIds: [],
    permissions: [],
    tools: [],
    closed: false,
    interrupted: false,
    initContinuationReached: false,
  };
  observations.push(observation);
  const stopped = Promise.withResolvers<void>();
  let client: Client | undefined;
  // The real SDK eagerly pulls async input independently of output consumption.
  // Metadata reads must resolve without that input, or the provider deadlocks.
  assert(typeof prompt !== "string", "owned provider must gate async input");
  const firstInput = prompt[Symbol.asyncIterator]()
    .next()
    .then((first) => {
      if (!first.done) {
        assert(observation.accountChecked, "input reached SDK before account metadata validation");
        observation.inputs.push(first.value);
        observation.wireHistory.push(JSON.stringify(first.value.message));
      }
      return first;
    });
  const generator = (async function* (): AsyncGenerator<SDKMessage, void> {
    if (selected === "throw") throw new Error("SDK transport failure");
    // Consume precisely the first input: do not invent a second query at a Pi tool boundary.
    const first = await firstInput;
    assert(!first.done, "SDK must receive a user input");
    assert.equal(first.value.type, "user");
    assert.equal(first.value.message.role, "user");
    const config = options.mcpServers?.[MCP_NAME];
    assert(config?.type === "sdk", "provider must supply only its owned in-process MCP server");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "owned-provider-fake", version: "1.0.0" });
    await config.instance.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    observation.tools = listed.tools.map((tool) => tool.name);
    assert(options.canUseTool, "SDK native execution needs a deny-by-default permission callback");
    const permissionInfo = {
      signal: options.abortController?.signal ?? new AbortController().signal,
      toolUseID: randomUUID(),
      requestId: randomUUID(),
    } satisfies Parameters<NonNullable<Options["canUseTool"]>>[2];
    observation.permissions.push(
      await options.canUseTool("Bash", { command: "never execute this" }, permissionInfo),
      await options.canUseTool(sdkToolName({ name: WRITE_DEFINITION.name }), WRITE_ARGS, {
        ...permissionInfo,
        mcpServer: { name: MCP_NAME, source: "project" },
      }),
      await options.canUseTool(sdkToolName({ name: WRITE_DEFINITION.name }), WRITE_ARGS, {
        ...permissionInfo,
        mcpServer: { name: MCP_NAME, source: "sdk" },
      }),
    );
    if (selected === "no-init") return;
    if (selected === "pre-init-model") {
      yield start({ id: randomUUID(), sessionId, model });
      return;
    }
    const init = {
      type: "system",
      subtype: "init",
      cwd: options.cwd ?? "",
      session_id: sessionId,
      uuid: randomUUID(),
      apiKeySource: "none",
      claude_code_version: "fake",
      tools: listed.tools.map((tool) => sdkToolName({ name: tool.name })),
      mcp_servers: [{ name: MCP_NAME, status: "connected", source: "sdk" }],
      model,
      permissionMode: "default",
      slash_commands: [],
      output_style: "default",
      skills: selected === "unexpected-skills" ? ["unrequested-skill-fixture"] : [],
      plugins:
        selected === "unexpected-plugins"
          ? [{ name: "unrequested-plugin-fixture", path: "fixture-only-plugin-not-executed" }]
          : [],
    } satisfies SDKSystemMessage;
    // Deliberately emulate additive/malformed native JSON beyond SDK typings.
    // The real observer must validate this unknown boundary, never trust types.
    yield Object.assign(init, rawInit);
    observation.initContinuationReached = true;
    if (selected === "cancel") {
      yield start({ id: randomUUID(), sessionId, model });
      yield frame({
        sessionId,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "", citations: null },
        },
      });
      yield frame({
        sessionId,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: IN_FLIGHT_TEXT },
        },
      });
      await stopped.promise;
      return;
    }
    const write = {
      name: WRITE_DEFINITION.name,
      arguments: WRITE_ARGS,
      id: randomUUID(),
    } satisfies ToolRequest;
    const read = {
      name: READ_DEFINITION.name,
      arguments: READ_ARGS,
      id: randomUUID(),
    } satisfies ToolRequest;
    const protectedRead = {
      name: READ_DEFINITION.name,
      arguments: PROTECTED_ARGS,
      id: randomUUID(),
    } satisfies ToolRequest;
    const batches =
      selected === "skill-files"
        ? [
            [{ ...read, arguments: SKILL_READ_ARGS }],
            [{ ...protectedRead, arguments: PROTECTED_SKILL_ARGS }],
          ]
        : selected === "pipeline"
          ? [[write], [read]]
          : selected === "secret-tool"
            ? [[read]]
            : selected === "serialized"
              ? [[write, { ...write, id: randomUUID(), arguments: SERIALIZED_WRITE_ARGS }]]
              : selected === "quota-after-tool" || selected.endsWith("progress")
                ? [[write]]
                : selected === "parallel"
                  ? [
                      [
                        write,
                        {
                          ...write,
                          id: randomUUID(),
                          arguments: { ...WRITE_ARGS, path: "sibling.txt" },
                        },
                        protectedRead,
                      ],
                    ]
                  : selected === "denied"
                    ? [[protectedRead]]
                    : selected === "parked"
                      ? [[write]]
                      : selected === "missing-meta"
                        ? [[write]]
                        : [];
    let latestProgress: Extract<SDKMessage, { type: "tool_progress" }> | undefined;
    for (const batch of batches) {
      const currentClient: Client | undefined = client;
      assert(currentClient);
      const replies = new Map<string, Promise<CallToolResult>>();
      // Reverse dispatch order and delay one request until after the final streamed block.
      const dispatch = ({ call }: { call: ToolRequest }) => {
        const reply = currentClient
          .callTool({
            name: call.name,
            arguments: call.arguments,
            ...(selected === "missing-meta" ? {} : { _meta: { "claudecode/toolUseId": call.id } }),
          })
          .then((value) => {
            const result = CallToolResultSchema.parse(value);
            // MCP transport resolves independently of the paused SDK event
            // iterator (and of Pi's public provider-stream observers).
            observation.deliveredToolIds.push(call.id);
            return result;
          });
        // A malformed dispatch may be rejected before stream normalization notices it.
        void reply.catch(() => undefined);
        replies.set(call.id, reply);
      };
      const delayed = batch[0];
      if (selected !== "serialized") {
        for (const call of batch.toReversed().filter((entry) => entry !== delayed))
          dispatch({ call });
      }
      const id = randomUUID();
      yield start({ id, sessionId, model });
      for (const [index, call] of batch.entries()) {
        const block = {
          type: "tool_use",
          id: call.id,
          name: sdkToolName({ name: call.name }),
          input: call.arguments,
        } satisfies Extract<Parameters<typeof apiMessage>[0]["content"], unknown[]>[number];
        yield frame({
          sessionId,
          event: { type: "content_block_start", index, content_block: { ...block, input: {} } },
        });
        yield frame({
          sessionId,
          event: {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) },
          },
        });
        yield {
          type: "assistant",
          uuid: randomUUID(),
          session_id: sessionId,
          parent_tool_use_id: null,
          message: apiMessage({ id, model, content: [block] }),
        };
        yield frame({ sessionId, event: { type: "content_block_stop", index } });
      }
      assert(delayed);
      // Dispatch asynchronously: real Claude MCP calls and model event delivery are independent.
      queueMicrotask(() => dispatch({ call: delayed }));
      yield* finish({ sessionId, tool: true });
      if (selected.endsWith("progress")) {
        latestProgress = {
          type: "tool_progress",
          tool_use_id: selected === "foreign-progress" ? randomUUID() : delayed.id,
          tool_name: sdkToolName({
            name: selected === "wrong-name-progress" ? READ_DEFINITION.name : delayed.name,
          }),
          parent_tool_use_id: selected === "subagent-progress" ? randomUUID() : null,
          session_id: selected === "wrong-session-progress" ? randomUUID() : sessionId,
          elapsed_time_seconds: 5,
          uuid: randomUUID(),
          ...(selected === "native-task-progress" ? { task_id: randomUUID() } : {}),
          ...(selected === "native-subagent-progress" ? { subagent_type: "native-fixture" } : {}),
        } satisfies SDKMessage;
        yield latestProgress;
      }
      for (const call of selected === "serialized" ? batch : batch.toReversed()) {
        if (selected === "serialized" && call !== delayed) dispatch({ call });
        const reply = replies.get(call.id);
        assert(reply, "fake failed to dispatch its MCP request");
        const received = await reply;
        observation.results.push({ id: call.id, result: received });
        observation.wireHistory.push(JSON.stringify(received));
      }
      if (observation.closed) return;
    }
    if (selected === "quota" || selected === "quota-after-tool") {
      yield {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
        uuid: randomUUID(),
        session_id: sessionId,
      } satisfies SDKMessage;
      yield result({ sessionId, error: "Claude quota exceeded" });
      return;
    }
    if (selected === "transient") {
      yield result({ sessionId, error: "overloaded: temporary service failure" });
      return;
    }
    if (selected === "auth") {
      yield result({ sessionId, error: "authentication_failed: sign in to Claude" });
      return;
    }
    if (selected === "malformed") {
      yield start({ id: randomUUID(), sessionId, model });
      yield frame({
        sessionId,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: randomUUID(),
            name: sdkToolName({ name: WRITE_DEFINITION.name }),
            input: {},
          },
        },
      });
      yield frame({
        sessionId,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{invalid" },
        },
      });
      yield frame({ sessionId, event: { type: "content_block_stop", index: 0 } });
      return;
    }
    if (selected === "completed-empty-restart" || selected === "unfinished-restart") {
      yield start({ id: randomUUID(), sessionId, model });
      yield* finish({ sessionId }).filter(
        (event) => selected === "completed-empty-restart" || event.event.type !== "message_stop",
      );
    }
    if (selected === "completed-thinking-restart" || selected === "completed-text-restart")
      yield* textEvents({
        sessionId,
        model,
        thinking: selected === "completed-thinking-restart",
        text: selected === "completed-text-restart" ? IN_FLIGHT_TEXT : "",
      });
    if (selected === "thinking" || selected === "progress")
      yield {
        type: "system",
        subtype: "thinking_tokens",
        estimated_tokens: 123456,
        estimated_tokens_delta: 123456,
        uuid: randomUUID(),
        session_id: sessionId,
      } satisfies SDKMessage;
    for (const event of textEvents({
      sessionId,
      model,
      thinking: selected === "thinking",
      ...(selected === "empty" ? { text: "" } : {}),
    })) {
      yield event;
      if (
        selected === "stale-progress" &&
        event.type === "stream_event" &&
        event.event.type === "message_start"
      ) {
        assert(latestProgress, "stale progress fixture requires a completed tool batch");
        yield { ...latestProgress, uuid: randomUUID() };
      }
    }
    if (selected !== "eof") {
      nativeSessions.set(sessionId, [...observation.wireHistory]);
      yield result({ sessionId });
    }
  })();
  return Object.assign(generator, {
    interrupt: async () => {
      observation.interrupted = true;
      stopped.resolve();
      return undefined;
    },
    close: () => {
      observation.closed = true;
      stopped.resolve();
      void client?.close();
    },
    setPermissionMode: unsupported,
    setMcpPermissionModeOverride: unsupported,
    setModel: unsupported,
    setMaxThinkingTokens: unsupported,
    applyFlagSettings: unsupported,
    updateSettings: unsupported,
    initializationResult: unsupported,
    reinitialize: unsupported,
    supportedCommands: unsupported,
    supportedModels: unsupported,
    supportedAgents: unsupported,
    mcpServerStatus: unsupported,
    getContextUsage: unsupported,
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: unsupported,
    readFile: unsupported,
    reloadPlugins: unsupported,
    reloadSkills: unsupported,
    reloadOutputStyles: unsupported,
    accountInfo: async () => {
      observation.accountChecked = true;
      if (failure === "pending") await stopped.promise;
      if (failure) throw new Error("dummy-account-initialization-secret");
      return metadata;
    },
    rewindFiles: unsupported,
    seedReadState: unsupported,
    reconnectMcpServer: unsupported,
    toggleMcpServer: unsupported,
    readMcpResource: unsupported,
    setMcpServers: unsupported,
    streamInput: unsupported,
    stopTask: unsupported,
    backgroundTasks: unsupported,
  }) satisfies Query;
};
