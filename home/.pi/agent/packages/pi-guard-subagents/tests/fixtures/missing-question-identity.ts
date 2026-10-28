import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { QUESTION_REPLY_INSTRUCTION } from "../../extensions/interactive/types.ts";
import { MESSAGE_NOTIFICATION_TYPES } from "../support/message-notifications.ts";

/** Fault the public context boundary before the deterministic provider receives it. */
export default function missingQuestionIdentity(pi: ExtensionAPI) {
	pi.on("context", (event) => ({
		messages: event.messages.map((message) => {
			if (message.role !== "custom" || message.customType !== MESSAGE_NOTIFICATION_TYPES.question) return message;
			if (typeof message.content !== "string") throw new Error("Question fault fixture requires textual notification");
			const position = message.content.lastIndexOf(QUESTION_REPLY_INSTRUCTION);
			if (position < 0) throw new Error("Question fault fixture did not receive a valid notification");
			return { ...message, content: message.content.slice(0, position).trimEnd() };
		}),
	}));
}
