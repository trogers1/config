import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import type {
  Message,
  UserMessage,
  ToolResultMessage,
  AssistantMessage,
} from "@earendil-works/pi-ai";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { projectRecoveryHistory, type ConversationMessage } from "./reconstruction/index.ts";
import { parseJson, validateJsonObject } from "./validation.ts";
import { ImageBlockSchema, PiConversationSchema } from "./reconstruction/schema.ts";

const MediaType = ImageBlockSchema.properties.source.properties.media_type;
const TextSchema = Type.Object(
  { type: Type.Literal("text"), text: Type.String() },
  { additionalProperties: false },
);
export const HistorySchema = PiConversationSchema;
const ResultSchema = Type.Object(
  {
    toolCallId: Type.String(),
    toolName: Type.String(),
    isError: Type.Boolean(),
    content: Type.Array(
      Type.Union([
        TextSchema,
        Type.Object(
          {
            type: Type.Literal("image"),
            data: ImageBlockSchema.properties.source.properties.data,
            mimeType: MediaType,
          },
          { additionalProperties: false },
        ),
      ]),
    ),
  },
  { additionalProperties: false },
);

/** Complete model-directed request. History is Pi's structured conversation,
 * not a textual checkpoint. Isolation controls are deliberately absent. */
export const PayloadSchema = Type.Object(
  {
    systemPrompt: Type.String(),
    history: HistorySchema,
    content: Type.Array(Type.Union([TextSchema, ImageBlockSchema])),
  },
  { additionalProperties: false },
);
export const DeliverySchema = Type.Object(
  {
    kind: Type.Literal("tool-results"),
    systemPrompt: Type.String(),
    history: HistorySchema,
    results: Type.Array(ResultSchema),
  },
  { additionalProperties: false },
);

export function userContent({
  message,
}: {
  message: UserMessage;
}): SDKUserMessage["message"]["content"] {
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => {
    if (block.type === "text")
      return { type: "text", text: block.text } satisfies Exclude<
        SDKUserMessage["message"]["content"],
        string
      >[number];
    const media_type = parseJson({
      text: JSON.stringify(block.mimeType),
      schema: MediaType,
      source: "image media type",
    });
    return {
      type: "image",
      source: { type: "base64", media_type, data: block.data },
    } satisfies Exclude<SDKUserMessage["message"]["content"], string>[number];
  });
}
export function currentUser({
  source,
  content,
}: {
  source: UserMessage;
  content: Static<typeof PayloadSchema>["content"];
}): UserMessage {
  return {
    ...source,
    content: content.map((block) =>
      block.type === "text"
        ? { type: "text", text: block.text }
        : { type: "image", mimeType: block.source.media_type, data: block.source.data },
    ),
  };
}

/** Hooks can redact structured content, not forge roles, tool IDs or native
 * provenance. Preserve Pi accounting metadata from the validated templates. */
function applyHistory({
  templates,
  history,
}: {
  templates: readonly ConversationMessage[];
  history: Static<typeof HistorySchema>;
}): ConversationMessage[] {
  if (templates.length !== history.length)
    throw new Error("pi-claude: payload history must preserve its message structure");
  return history.map((message, index) => {
    const source = templates[index];
    if (!source || source.role !== message.role || source.timestamp !== message.timestamp)
      throw new Error("pi-claude: payload history changed message identity");
    if (source.role === "user" && message.role === "user")
      return { ...source, content: message.content };
    if (source.role === "toolResult" && message.role === "toolResult") {
      if (source.toolCallId !== message.toolCallId || source.toolName !== message.toolName)
        throw new Error("pi-claude: payload history changed a tool-result identity");
      return { ...source, content: message.content, isError: message.isError };
    }
    if (source.role === "assistant" && message.role === "assistant") {
      if (
        source.model !== message.model ||
        source.responseModel !== message.responseModel ||
        source.provider !== message.provider ||
        source.api !== message.api ||
        source.stopReason !== message.stopReason
      )
        throw new Error("pi-claude: payload history changed assistant provenance");
      const content: AssistantMessage["content"] = message.content.map((block) =>
        block.type === "toolCall"
          ? {
              ...block,
              arguments: validateJsonObject({
                value: block.arguments,
                source: "historical tool arguments",
              }),
            }
          : block,
      );
      const originalTools = source.content.filter((block) => block.type === "toolCall");
      const replacedTools = content.filter((block) => block.type === "toolCall");
      if (
        fingerprint({ value: originalTools.map(({ id, name }) => ({ id, name })) }) !==
        fingerprint({ value: replacedTools.map(({ id, name }) => ({ id, name })) })
      )
        throw new Error("pi-claude: payload history changed tool-call identities");
      return { ...source, content };
    }
    throw new Error("pi-claude: unsupported payload history role");
  });
}
export function prepareHistory({ templates }: { templates: ConversationMessage[] }) {
  const projected = projectRecoveryHistory({ messages: templates });
  const excluded = new Set(
    projected.diagnostics
      .filter((entry) => entry.action === "excluded-empty-attempt")
      .map((entry) => entry.messageIndex),
  );
  const indexes = templates.flatMap((_message, index) => (excluded.has(index) ? [] : [index]));
  if (indexes.length !== projected.messages.length)
    throw new Error("pi-claude: recovery projection changed an unexpected history structure");
  return {
    ...projected,
    apply({ history }: { history: Static<typeof HistorySchema> }) {
      const outbound = applyHistory({ templates: projected.messages, history });
      let offset = 0;
      const aligned = templates.map((message, index) =>
        excluded.has(index) ? message : outbound[offset++],
      );
      return { outbound, aligned };
    },
  };
}

export function deliveryResults({
  results,
  templates,
}: {
  results: Static<typeof DeliverySchema>["results"];
  templates: ToolResultMessage[];
}): ToolResultMessage[] {
  if (results.length !== templates.length)
    throw new Error("pi-claude: payload changed tool-result batch size");
  return results.map((result) => {
    const source = templates.find((entry) => entry.toolCallId === result.toolCallId);
    if (!source || source.toolName !== result.toolName)
      throw new Error("pi-claude: payload changed tool-result identity");
    return { ...source, content: result.content, isError: result.isError };
  });
}

export function fingerprint({ value }: { value: unknown }) {
  function canonical({ item }: { item: unknown }): string {
    if (item === null || typeof item !== "object") return JSON.stringify(item) ?? "null";
    if (Array.isArray(item))
      return `[${item.map((value) => canonical({ item: value })).join(",")}]`;
    return `{${Object.entries(item)
      .filter(([, value]) => value !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonical({ item: value })}`)
      .join(",")}}`;
  }
  return createHash("sha256")
    .update(canonical({ item: value }))
    .digest("hex");
}
export function historyIdentity({ messages }: { messages: readonly Message[] }) {
  return fingerprint({
    value: messages.map((message) => {
      if (message.role === "assistant")
        return {
          role: message.role,
          content: message.content,
          model: message.model,
          responseModel: message.responseModel,
          provider: message.provider,
          api: message.api,
          stopReason: message.stopReason,
        };
      if (message.role === "toolResult")
        return {
          role: message.role,
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          content: message.content,
          isError: message.isError,
        };
      if (message.role === "user") {
        // Pi may retain a string while the effective wire uses text blocks.
        return {
          role: message.role,
          content:
            typeof message.content === "string"
              ? [{ type: "text", text: message.content }]
              : message.content,
        };
      }
      return {
        role: message.role,
        content: message.content,
        sections: message.sections,
        toolsAdded: message.toolsAdded,
        toolsRemoved: message.toolsRemoved,
      };
    }),
  });
}
export type WireState = {
  source: ConversationMessage[];
  wire: ConversationMessage[];
  sourceSystem: string;
  systemPrompt: string;
};
/** Keep one current-prefix ledger, including redactions. A configuration reset
 * must not resurrect original values that were never sent on the wire. */
export function effectiveHistory({
  source,
  state,
}: {
  source: ConversationMessage[];
  state?: WireState;
}): ConversationMessage[] {
  let common = 0;
  while (
    state &&
    common < source.length &&
    common < state.source.length &&
    historyIdentity({ messages: [source[common]] }) ===
      historyIdentity({ messages: [state.source[common]] })
  )
    common++;
  return [...(state?.wire.slice(0, common) ?? []), ...source.slice(common)];
}
