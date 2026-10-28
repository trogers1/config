import { Type, type Static } from "typebox";
import {
	ChildRecordSchema,
	QuestionSchema,
	TerminalSignalSchema,
	QUESTION_REPLY_INSTRUCTION,
	CHILD_STATES,
	parseOrThrow,
} from "../../extensions/interactive/types.ts";

export const MESSAGE_NOTIFICATION_TYPES = Object.freeze({
	question: "subagent_question",
	completion: "subagent_result",
});
const NOTIFICATION_ERRORS = Object.freeze({
	question: "Invalid received question notification",
	completion: "Invalid received completion notification",
	mismatch: "Notification text and metadata disagree",
});
const QuestionFields = Type.Object({
	name: ChildRecordSchema.properties.name,
	question: QuestionSchema.properties.question,
	questionId: QuestionSchema.properties.questionId,
});
const CompletionFields = Type.Object({
	name: ChildRecordSchema.properties.name,
	status: TerminalSignalSchema.properties.status,
	result: TerminalSignalSchema.properties.result,
	sessionId: ChildRecordSchema.properties.sessionId,
	handoffPath: Type.String({ minLength: 1 }),
});
const QuestionDetails = Type.Intersect([QuestionFields, Type.Pick(QuestionSchema, ["attemptId"])]);
const CompletionDetails = Type.Intersect([
	TerminalSignalSchema,
	Type.Required(Type.Pick(ChildRecordSchema, ["sessionId", "handoffPath"])),
]);
const QUESTION_SEPARATOR = " asks: ";
const SESSION_SEPARATOR = "\nsession: ";
const HANDOFF_SEPARATOR = "\nhandoff: ";
const OBSERVED_SEPARATOR = "\nobserved paths: ";
type Notification =
	| { kind: typeof MESSAGE_NOTIFICATION_TYPES.question; value: Static<typeof QuestionFields> }
	| { kind: typeof MESSAGE_NOTIFICATION_TYPES.completion; value: Static<typeof CompletionFields> }
	| { kind: "context" };

/** Decode the received public text, never filling missing identity from disk. */
function receivedNotification({ content }: { content: string }): Notification {
	const questionAt = content.indexOf(QUESTION_SEPARATOR);
	if (questionAt >= 0 && !content.slice(0, questionAt).includes("\n")) {
		const instructionAt = content.lastIndexOf(QUESTION_REPLY_INSTRUCTION);
		if (instructionAt < questionAt) throw new Error(NOTIFICATION_ERRORS.question);
		return {
			kind: MESSAGE_NOTIFICATION_TYPES.question,
			value: parseOrThrow(
				QuestionFields,
				{
					name: content.slice(0, questionAt),
					question: content.slice(questionAt + QUESTION_SEPARATOR.length, instructionAt).trimEnd(),
					questionId: content.slice(instructionAt + QUESTION_REPLY_INSTRUCTION.length).trim(),
				},
				"received question notification",
			),
		};
	}
	const firstLine = content.split("\n", 1)[0];
	const separator = firstLine.lastIndexOf(": ");
	const status = firstLine.slice(separator + 2);
	if (separator >= 0 && (status === CHILD_STATES.completed || status === CHILD_STATES.failed)) {
		const sessionAt = content.lastIndexOf(SESSION_SEPARATOR);
		const handoffAt = content.indexOf(HANDOFF_SEPARATOR, sessionAt + SESSION_SEPARATOR.length);
		const observedAt = content.indexOf(OBSERVED_SEPARATOR, handoffAt + HANDOFF_SEPARATOR.length);
		if (sessionAt < firstLine.length || handoffAt < sessionAt || observedAt < handoffAt)
			throw new Error(NOTIFICATION_ERRORS.completion);
		return {
			kind: MESSAGE_NOTIFICATION_TYPES.completion,
			value: parseOrThrow(
				CompletionFields,
				{
					name: firstLine.slice(0, separator),
					status,
					result: content.slice(firstLine.length + 1, sessionAt),
					sessionId: content.slice(sessionAt + SESSION_SEPARATOR.length, handoffAt),
					handoffPath: content.slice(handoffAt + HANDOFF_SEPARATOR.length, observedAt),
				},
				"received completion notification",
			),
		};
	}
	return { kind: "context" };
}

/** Persisted custom messages additionally bind delivered text to production metadata. */
export function persistedNotification({
	customType,
	content,
	details,
}: {
	customType: string;
	content: unknown;
	details: unknown;
}): Notification {
	if (customType !== MESSAGE_NOTIFICATION_TYPES.question && customType !== MESSAGE_NOTIFICATION_TYPES.completion)
		return { kind: "context" };
	const text = parseOrThrow(Type.String(), content, "notification text");
	const notification = receivedNotification({ content: text });
	if (notification.kind !== customType) throw new Error(NOTIFICATION_ERRORS.mismatch);
	if (notification.kind === MESSAGE_NOTIFICATION_TYPES.question) {
		const value = parseOrThrow(QuestionDetails, details, "question notification metadata");
		if (
			value.name !== notification.value.name ||
			value.questionId !== notification.value.questionId ||
			value.question !== notification.value.question
		)
			throw new Error(NOTIFICATION_ERRORS.mismatch);
	} else if (notification.kind === MESSAGE_NOTIFICATION_TYPES.completion) {
		const value = parseOrThrow(CompletionDetails, details, "completion notification metadata");
		if (
			value.sessionId !== notification.value.sessionId ||
			value.handoffPath !== notification.value.handoffPath ||
			value.status !== notification.value.status ||
			value.result !== notification.value.result
		)
			throw new Error(NOTIFICATION_ERRORS.mismatch);
	}
	return notification;
}

const ReceivedUserSchema = Type.Object({ role: Type.String(), content: Type.Optional(Type.Unknown()) });
const TextPartsSchema = Type.Array(Type.Object({ type: Type.Literal("text"), text: Type.String() }));
export function incomingNotifications({ messages }: { messages: readonly unknown[] }) {
	return messages.flatMap((message) => {
		const envelope = parseOrThrow(ReceivedUserSchema, message, "provider message envelope");
		if (envelope.role !== "user") return []; // Assistant/tool/system text is never incoming delivery evidence.
		const content =
			typeof envelope.content === "string"
				? envelope.content
				: parseOrThrow(TextPartsSchema, envelope.content, "received notification content")
						.map((part) => part.text)
						.join("\n");
		const notification = receivedNotification({ content });
		return notification.kind === "context" ? [] : [notification];
	});
}
