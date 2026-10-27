import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import {
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  NonNullableUsage,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";

export const RESPONSE_TEXT = "owned SDK response 💡";
export const IN_FLIGHT_TEXT = "in flight";
export const PROMPT = "Run the requested test scenario.";
export const THINKING_TEXT = "A brief reasoning block";
export const THINKING_SIGNATURE = "opaque-test-signature";
export const SDK_USAGE = {
  input_tokens: 11,
  output_tokens: 7,
  cache_read_input_tokens: 5,
  cache_creation_input_tokens: 3,
} satisfies Pick<
  NonNullableUsage,
  "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens"
>;
const SDK_FULL_USAGE = {
  ...SDK_USAGE,
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: SDK_USAGE.cache_creation_input_tokens,
  },
  fallback_credit: null,
  inference_geo: "global",
  iterations: [],
  output_tokens_details: { thinking_tokens: 0 },
  server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
  service_tier: "standard",
  speed: "standard",
} satisfies NonNullableUsage;
export const WRITE_DEFINITION = createWriteToolDefinition(process.cwd());
export const READ_DEFINITION = createReadToolDefinition(process.cwd());
export const WRITE_ARGS = { path: "handoff.txt", content: "written by Pi" } satisfies Parameters<
  typeof WRITE_DEFINITION.execute
>[1];
export const SERIALIZED_WRITE_ARGS = {
  ...WRITE_ARGS,
  path: "serialized-sibling.txt",
} satisfies Parameters<typeof WRITE_DEFINITION.execute>[1];
export const READ_ARGS = { path: WRITE_ARGS.path } satisfies Parameters<
  typeof READ_DEFINITION.execute
>[1];
export const PROTECTED_ARGS = { path: "protected.txt" } satisfies Parameters<
  typeof READ_DEFINITION.execute
>[1];
export const SKILL_READ_ARGS = { path: "skills/allowed/SKILL.md" } satisfies Parameters<
  typeof READ_DEFINITION.execute
>[1];
export const PROTECTED_SKILL_ARGS = { path: "skills/protected/SKILL.md" } satisfies Parameters<
  typeof READ_DEFINITION.execute
>[1];
export const PROTECTED_CONTENT = "innocuous guard fixture: never return this content";
export const ManifestSchema = Type.Object({
  piCompatibility: Type.Object({
    minimumVersion: Type.String({ pattern: "^\\d+\\.\\d+\\.\\d+$" }),
  }),
});

export function frame({
  event,
  sessionId,
}: {
  event: SDKPartialAssistantMessage["event"];
  sessionId: string;
}): SDKPartialAssistantMessage {
  return {
    type: "stream_event",
    event,
    uuid: randomUUID(),
    session_id: sessionId,
    parent_tool_use_id: null,
  };
}
export function apiMessage({
  id,
  model,
  content = [],
}: {
  id: string;
  model: SDKAssistantMessage["message"]["model"];
  content?: SDKAssistantMessage["message"]["content"];
}): SDKAssistantMessage["message"] {
  return {
    id,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: null,
    stop_sequence: null,
    usage: SDK_FULL_USAGE,
    container: null,
    stop_details: null,
    context_management: null,
    diagnostics: null,
  };
}
export function start({
  id,
  sessionId,
  model,
}: {
  id: string;
  sessionId: string;
  model: SDKAssistantMessage["message"]["model"];
}): SDKPartialAssistantMessage {
  return frame({ sessionId, event: { type: "message_start", message: apiMessage({ id, model }) } });
}
export function finish({
  sessionId,
  tool = false,
}: {
  sessionId: string;
  tool?: boolean;
}): SDKPartialAssistantMessage[] {
  return [
    frame({
      sessionId,
      event: {
        type: "message_delta",
        delta: {
          stop_reason: tool ? "tool_use" : "end_turn",
          stop_sequence: null,
          container: null,
          stop_details: null,
        },
        usage: SDK_FULL_USAGE,
        context_management: null,
      },
    }),
    frame({ sessionId, event: { type: "message_stop" } }),
  ];
}
export function* textEvents({
  sessionId,
  text = RESPONSE_TEXT,
  thinking = false,
  model,
}: {
  model: SDKAssistantMessage["message"]["model"];
  sessionId: string;
  text?: string;
  thinking?: boolean;
}): Generator<SDKMessage> {
  const id = randomUUID();
  yield start({ id, sessionId, model });
  if (thinking) {
    yield frame({
      sessionId,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
    });
    yield frame({
      sessionId,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: THINKING_TEXT, estimated_tokens: null },
      },
    });
    yield frame({
      sessionId,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: THINKING_SIGNATURE },
      },
    });
    yield {
      type: "assistant",
      uuid: randomUUID(),
      session_id: sessionId,
      parent_tool_use_id: null,
      message: apiMessage({
        id,
        model,
        content: [{ type: "thinking", thinking: THINKING_TEXT, signature: THINKING_SIGNATURE }],
      }),
    } satisfies SDKAssistantMessage;
    yield frame({ sessionId, event: { type: "content_block_stop", index: 0 } });
  }
  const index = thinking ? 1 : 0;
  yield frame({
    sessionId,
    event: {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "", citations: null },
    },
  });
  yield frame({
    sessionId,
    event: { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  });
  // Real SDK emits completed blocks before content_block_stop, not only after message_stop.
  yield {
    type: "assistant",
    uuid: randomUUID(),
    session_id: sessionId,
    parent_tool_use_id: null,
    message: apiMessage({ id, model, content: [{ type: "text", text, citations: null }] }),
  } satisfies SDKAssistantMessage;
  yield frame({ sessionId, event: { type: "content_block_stop", index } });
  yield* finish({ sessionId });
}
export function result({ sessionId, error }: { sessionId: string; error?: string }): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: error !== undefined,
    result: error ?? RESPONSE_TEXT,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: SDK_FULL_USAGE,
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: sessionId,
  } satisfies SDKMessage;
}
