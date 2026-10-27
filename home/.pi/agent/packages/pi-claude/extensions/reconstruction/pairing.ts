import type { ConversationMessage } from "./schema.ts";

/** Exact ordered pairing only; never hoists, drops, or invents results. */
export function assertToolPairing({
  messages,
}: {
  messages: readonly ConversationMessage[];
}): void {
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "toolResult" && pending.size)
      throw new Error("pi-claude: incomplete tool results before next conversation message");
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        if (seen.has(block.id)) throw new Error("pi-claude: duplicate tool use ID");
        seen.add(block.id);
        pending.set(block.id, block.name);
      }
      if (
        message.stopReason !== "error" &&
        message.stopReason !== "aborted" &&
        pending.size > 0 !== (message.stopReason === "toolUse")
      )
        throw new Error("pi-claude: tool calls disagree with assistant stop reason");
    } else if (message.role === "toolResult") {
      if (pending.get(message.toolCallId) !== message.toolName)
        throw new Error("pi-claude: unmatched, duplicate, or wrong-name tool result");
      pending.delete(message.toolCallId);
    }
  }
  if (pending.size) throw new Error("pi-claude: conversation ends with incomplete tool results");
}
