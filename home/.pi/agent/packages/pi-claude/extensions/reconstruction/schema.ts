import { Type, type Static } from "typebox";
import type { Message } from "@earendil-works/pi-ai";

export type ConversationMessage = Exclude<Message, { role: "system" }>;

const closed = { additionalProperties: false };
const nonempty = Type.String({ minLength: 1 });
export const UuidSchema = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const timestamp = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
});
const identifier = Type.String({ pattern: "^[a-zA-Z0-9_-]{1,128}$" });
const TextBlockSchema = Type.Object({ type: Type.Literal("text"), text: Type.String() }, closed);
export const ImageBlockSchema = Type.Object(
  {
    type: Type.Literal("image"),
    source: Type.Object(
      {
        type: Type.Literal("base64"),
        media_type: Type.Union([
          Type.Literal("image/png"),
          Type.Literal("image/jpeg"),
          Type.Literal("image/gif"),
          Type.Literal("image/webp"),
        ]),
        data: Type.String({
          minLength: 4,
          pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
        }),
      },
      closed,
    ),
  },
  closed,
);
const thinkingBlock = Type.Object(
  {
    type: Type.Literal("thinking"),
    thinking: Type.String(),
    signature: nonempty,
  },
  closed,
);
const redactedThinkingBlock = Type.Object(
  {
    type: Type.Literal("redacted_thinking"),
    data: nonempty,
  },
  closed,
);
const toolUseBlock = Type.Object(
  {
    type: Type.Literal("tool_use"),
    id: identifier,
    name: identifier,
    input: Type.Record(Type.String(), Type.Unknown()),
  },
  closed,
);
const resultContent = Type.Array(Type.Union([TextBlockSchema, ImageBlockSchema]));
const toolResultBlock = Type.Object(
  {
    type: Type.Literal("tool_result"),
    tool_use_id: identifier,
    content: Type.Union([Type.String(), resultContent]),
    is_error: Type.Optional(Type.Boolean()),
  },
  closed,
);
export const UserContentSchema = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Array(Type.Union([TextBlockSchema, ImageBlockSchema, toolResultBlock]), { minItems: 1 }),
]);
export const AssistantContentSchema = Type.Array(
  Type.Union([TextBlockSchema, thinkingBlock, redactedThinkingBlock, toolUseBlock]),
  { minItems: 1 },
);
const base = {
  uuid: UuidSchema,
  parentUuid: Type.Union([UuidSchema, Type.Null()]),
  sessionId: UuidSchema,
  timestamp,
  isSidechain: Type.Optional(Type.Boolean()),
  cwd: Type.Optional(nonempty),
};
const userMessage = {
  role: Type.Literal("user"),
  content: UserContentSchema,
};
const assistantMessage = {
  id: nonempty,
  type: Type.Literal("message"),
  role: Type.Literal("assistant"),
  model: nonempty,
  content: AssistantContentSchema,
  stop_reason: Type.Union([
    Type.Literal("end_turn"),
    Type.Literal("tool_use"),
    Type.Literal("max_tokens"),
    Type.Null(),
  ]),
  stop_sequence: Type.Union([Type.String(), Type.Null()]),
  usage: Type.Optional(
    Type.Object({
      input_tokens: Type.Number({ minimum: 0 }),
      output_tokens: Type.Number({ minimum: 0 }),
      cache_read_input_tokens: Type.Optional(Type.Number({ minimum: 0 })),
      cache_creation_input_tokens: Type.Optional(Type.Number({ minimum: 0 })),
    }),
  ),
};
/** Exact, minimal records we own. No fabricated Claude version or native snapshots. */
export const WrittenRecordSchema = Type.Union([
  Type.Object(
    { ...base, type: Type.Literal("user"), message: Type.Object(userMessage, closed) },
    closed,
  ),
  Type.Object(
    { ...base, type: Type.Literal("assistant"), message: Type.Object(assistantMessage, closed) },
    closed,
  ),
]);
export type WrittenRecord = Static<typeof WrittenRecordSchema>;
export type AssistantContent = Static<typeof AssistantContentSchema>;
export type UserContent = Static<typeof UserContentSchema>;

/** Native metadata is extensible; content and known record envelopes are checked.
 * Matching means this modeled contract matched, not that Claude can resume it.
 */
export const NativeRecordSchema = Type.Union([
  Type.Object({ ...base, type: Type.Literal("user"), message: Type.Object(userMessage) }),
  Type.Object({ ...base, type: Type.Literal("assistant"), message: Type.Object(assistantMessage) }),
  Type.Object({
    ...base,
    type: Type.Literal("attachment"),
    attachment: Type.Object({ type: nonempty }),
  }),
  Type.Object({
    type: Type.Literal("queue-operation"),
    operation: nonempty,
    sessionId: UuidSchema,
    timestamp,
  }),
  Type.Object({
    type: Type.Literal("last-prompt"),
    sessionId: UuidSchema,
    lastPrompt: Type.String(),
  }),
  Type.Object({ type: Type.Literal("summary"), summary: Type.String(), leafUuid: UuidSchema }),
  Type.Object({
    type: Type.Literal("file-history-snapshot"),
    messageId: UuidSchema,
    snapshot: Type.Object({}),
    isSnapshotUpdate: Type.Boolean(),
  }),
  Type.Object({ type: Type.Literal("progress"), ...base, data: Type.Object({ type: nonempty }) }),
  Type.Object({ type: Type.Literal("system"), ...base, subtype: nonempty }),
]);
export const RecordTypeSchema = Type.Object({
  type: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }),
});

const piText = Type.Object(
  { type: Type.Literal("text"), text: Type.String(), textSignature: Type.Optional(Type.String()) },
  closed,
);
const piImage = Type.Object(
  { type: Type.Literal("image"), data: nonempty, mimeType: nonempty },
  closed,
);
const piThinking = Type.Object(
  {
    type: Type.Literal("thinking"),
    thinking: Type.String(),
    thinkingSignature: Type.Optional(Type.String()),
    redacted: Type.Optional(Type.Boolean()),
  },
  closed,
);
const piJsonValue = Type.Cyclic(
  {
    Value: Type.Union([
      Type.Null(),
      Type.Boolean(),
      Type.Number(),
      Type.String(),
      Type.Array(Type.Ref("Value")),
      Type.Record(Type.String(), Type.Ref("Value")),
    ]),
  },
  "Value",
);
const piUsage = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  totalTokens: Type.Number(),
  cost: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    total: Type.Number(),
  }),
});
const piTool = Type.Object(
  {
    type: Type.Literal("toolCall"),
    id: identifier,
    name: identifier,
    arguments: Type.Record(Type.String(), piJsonValue),
    thoughtSignature: Type.Optional(Type.String()),
    namespace: Type.Optional(Type.String()),
  },
  closed,
);
const failedStopReason = Type.Union([Type.Literal("error"), Type.Literal("aborted")]);
const piAssistantFields = {
  role: Type.Literal("assistant"),
  timestamp: Type.Number(),
  model: nonempty,
  responseModel: Type.Optional(nonempty),
  api: nonempty,
  provider: nonempty,
  usage: piUsage,
};
const piAssistantBlock = Type.Union([piText, piThinking, piTool]);
/** The conversion-bearing projection of actual Pi Message. Host types remain authoritative.
 * Accounting/diagnostics/tool details are Pi metadata, not model conversation content.
 * Only explicitly failed attempts may have no content; recovery reports their removal.
 */
export const PiConversationSchema = Type.Array(
  Type.Union([
    Type.Object({
      role: Type.Literal("user"),
      timestamp: Type.Number(),
      content: Type.Union([Type.String(), Type.Array(Type.Union([piText, piImage]))]),
    }),
    Type.Object({
      ...piAssistantFields,
      stopReason: Type.Union([
        Type.Literal("stop"),
        Type.Literal("length"),
        Type.Literal("toolUse"),
      ]),
      content: Type.Array(piAssistantBlock, { minItems: 1 }),
    }),
    Type.Object({
      ...piAssistantFields,
      stopReason: failedStopReason,
      content: Type.Array(piAssistantBlock),
    }),
    Type.Object({
      role: Type.Literal("toolResult"),
      timestamp: Type.Number(),
      toolCallId: identifier,
      toolName: identifier,
      isError: Type.Boolean(),
      content: Type.Array(Type.Union([piText, piImage])),
    }),
  ]),
);

export const RecoveryDiagnosticSchema = Type.Object(
  {
    messageIndex: Type.Integer({ minimum: 0 }),
    stopReason: failedStopReason,
    action: Type.Union([
      Type.Literal("excluded-empty-attempt"),
      Type.Literal("preserved-interrupted-attempt"),
    ]),
    excludedUnresolvedToolCalls: Type.Integer({ minimum: 0 }),
    retainedToolResults: Type.Integer({ minimum: 0 }),
  },
  closed,
);
export type RecoveryDiagnostic = Static<typeof RecoveryDiagnosticSchema>;
