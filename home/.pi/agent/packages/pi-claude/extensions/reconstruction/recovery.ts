import type { Message } from "@earendil-works/pi-ai";
import { parseOrThrow, validateJsonObject } from "../validation.ts";
import { assertToolPairing } from "./pairing.ts";
import {
  PiConversationSchema,
  RecoveryDiagnosticSchema,
  type ConversationMessage,
  type RecoveryDiagnostic,
} from "./schema.ts";

/** Explicit, content-preserving projection of known failed transport attempts.
 * Caller surfaces diagnostics before using the projected outbound history.
 * No result is invented: missing outcomes remain unknown and are reported.
 */
export function projectRecoveryHistory({
  messages,
}: {
  messages: readonly ConversationMessage[];
}): { messages: ConversationMessage[]; diagnostics: RecoveryDiagnostic[] } {
  parseOrThrow({ schema: PiConversationSchema, value: messages, source: "recovery conversation" });
  const projected: ConversationMessage[] = [];
  const diagnostics: RecoveryDiagnostic[] = [];
  const seenToolIds = new Set<string>();
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role !== "assistant") {
      projected.push(message);
      continue;
    }
    const tools = new Map<
      string,
      Extract<Extract<Message, { role: "assistant" }>["content"][number], { type: "toolCall" }>
    >();
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      if (seenToolIds.has(block.id))
        throw new Error("pi-claude: duplicate tool use ID during recovery");
      seenToolIds.add(block.id);
      validateJsonObject({ value: block.arguments, source: "recovery tool arguments" });
      if (block.thoughtSignature !== undefined || block.namespace !== undefined)
        throw new Error("pi-claude: unsupported signed or namespaced recovery tool call");
      tools.set(block.id, block);
    }
    if (message.stopReason !== "error" && message.stopReason !== "aborted") {
      projected.push(message);
      continue;
    }
    const completed = new Set<string>();
    for (let cursor = messageIndex + 1; tools.size > 0 && cursor < messages.length; cursor++) {
      const result = messages[cursor];
      if (
        result?.role === "assistant" &&
        (result.stopReason === "error" || result.stopReason === "aborted") &&
        !result.content.length
      )
        continue;
      if (result?.role !== "toolResult") break;
      const tool = tools.get(result.toolCallId);
      if (!tool || tool.name !== result.toolName || completed.has(result.toolCallId)) {
        throw new Error(
          "pi-claude: unmatched, duplicate, or wrong-name tool result during recovery",
        );
      }
      completed.add(result.toolCallId);
    }
    const content = message.content.filter(
      (block) => block.type !== "toolCall" || completed.has(block.id),
    );
    const diagnostic = parseOrThrow({
      schema: RecoveryDiagnosticSchema,
      value: {
        messageIndex,
        stopReason: message.stopReason,
        action: content.length ? "preserved-interrupted-attempt" : "excluded-empty-attempt",
        excludedUnresolvedToolCalls: tools.size - completed.size,
        retainedToolResults: completed.size,
      },
      source: "recovery diagnostic",
    });
    diagnostics.push(diagnostic);
    if (content.length) projected.push({ ...message, content });
  }
  assertToolPairing({ messages: projected });
  // Payload hooks may mutate this outbound projection; never hand them Pi's objects.
  return { messages: structuredClone(projected), diagnostics };
}
