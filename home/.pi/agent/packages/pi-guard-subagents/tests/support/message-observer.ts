import type {
	AssistantMessage,
	ToolResultMessage,
	ToolCall,
	TextContent,
	ThinkingContent,
} from "@earendil-works/pi-ai";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { readSessionSnapshot } from "./session-snapshot.ts";
import { Type, type Static } from "typebox";
import {
	parseOrThrow,
	SubagentMessageParameters,
	CHILD_STATES,
	type ChildRecord,
} from "../../extensions/interactive/types.ts";
import { persistedNotification, MESSAGE_NOTIFICATION_TYPES } from "./message-notifications.ts";
import { SubagentParameters } from "../../extensions/index.ts";

export const LaunchControlsSchema = Type.Required(
	Type.Pick(SubagentParameters, ["agentScope", "confirmProjectAgents"]),
);
type LaunchControls = Static<typeof LaunchControlsSchema>;

export const MESSAGE_OBSERVATION_ERRORS = Object.freeze({
	incomplete: "Owned session contains a failed or incomplete result",
	arguments: "Owned session contains malformed tool arguments",
	identity: "Observed assistant provider/model does not match the requested model",
	launchControls: "Emitted launch does not match explicit fixture controls",
});

// The host exports message types, not runtime schemas. Validate only the
// observation contract; signatures, usage, tool details and other host fields
// remain opaque. The mapped type catches additions to the host's stop reasons.
const stopReasons = {
	pending: "pending",
	stop: "stop",
	length: "length",
	toolUse: "toolUse",
	error: "error",
	aborted: "aborted",
	deferred: "deferred",
} satisfies { [Reason in AssistantMessage["stopReason"]]: Reason };
const contentSchemas = {
	text: Type.Object({ type: Type.Literal("text"), text: Type.String() }),
	thinking: Type.Object({ type: Type.Literal("thinking"), thinking: Type.String() }),
	toolCall: Type.Object({
		type: Type.Literal("toolCall"),
		id: Type.String({ minLength: 1 }),
		name: Type.String({ minLength: 1 }),
		arguments: Type.Record(Type.String(), Type.Unknown()),
		argumentsError: Type.Optional(Type.String()),
	}),
};
const ContentSchema = Type.Union(Object.values(contentSchemas));
const AssistantSchema = Type.Object({
	role: Type.Literal("assistant"),
	content: Type.Array(ContentSchema),
	provider: Type.String({ minLength: 1 }),
	model: Type.String({ minLength: 1 }),
	stopReason: Type.Enum(stopReasons),
});
const ResultSchema = Type.Object({
	role: Type.Literal("toolResult"),
	toolCallId: Type.String({ minLength: 1 }),
	toolName: Type.String({ minLength: 1 }),
	isError: Type.Boolean(),
});
export const OBSERVATION_SCHEMAS = { assistant: AssistantSchema, toolResult: ResultSchema, ...contentSchemas };
type SessionMessage = Extract<ReturnType<SessionManager["getEntries"]>[number], { type: "message" }>["message"];
const roles = {
	system: "system",
	user: "user",
	assistant: "assistant",
	toolResult: "toolResult",
	bashExecution: "bashExecution",
	custom: "custom",
	branchSummary: "branchSummary",
	compactionSummary: "compactionSummary",
} satisfies { [Role in SessionMessage["role"]]: Role };
const EnvelopeSchema = Type.Object({ role: Type.Enum(roles) });
const CustomEnvelopeSchema = Type.Object({
	customType: Type.String(),
	content: Type.Unknown(),
	details: Type.Optional(Type.Unknown()),
});
type ObservedContent =
	| Pick<TextContent, "type" | "text">
	| Pick<ThinkingContent, "type" | "thinking">
	| (Pick<ToolCall, "type" | "id" | "name" | "argumentsError"> & { arguments: Record<string, unknown> });
type ObservedMessage =
	| (Pick<AssistantMessage, "role" | "provider" | "model" | "stopReason"> & { content: ObservedContent[] })
	| Pick<ToolResultMessage, "role" | "toolCallId" | "toolName" | "isError">
	| Pick<Exclude<SessionMessage, AssistantMessage | ToolResultMessage>, "role">;

function observeMessage({ message }: { message: unknown }): ObservedMessage {
	const envelope = parseOrThrow(EnvelopeSchema, message, "owned session message envelope");
	if (envelope.role === "assistant") return parseOrThrow(AssistantSchema, message, "owned assistant observation");
	if (envelope.role === "toolResult") return parseOrThrow(ResultSchema, message, "owned tool-result observation");
	// Preserve explicitly recognized context roles, but don't treat them as
	// execution evidence. An unknown role fails the envelope schema above.
	return { role: envelope.role };
}

/** Read only an explicitly owned session; emitted calls alone never prove execution. */
function readObservation({ file, running = false }: { file: string; running?: boolean }) {
	const snapshot = readSessionSnapshot({ file, running });
	const events = snapshot.entries.flatMap((entry, index) =>
		entry.type === "message" ? [{ index, message: observeMessage({ message: entry.message }) }] : [],
	);
	const messages = events.map((event) => event.message);
	const notifications = snapshot.entries.flatMap((entry, index) => {
		if (entry.type !== "custom_message") return [];
		const envelope = parseOrThrow(CustomEnvelopeSchema, entry, "owned custom notification envelope");
		const notification = persistedNotification({
			customType: envelope.customType,
			content: envelope.content,
			details: envelope.details,
		});
		return notification.kind === "context" ? [] : [{ ...notification, index }];
	});
	const calls = events.flatMap(({ message, index }) =>
		message.role === "assistant"
			? message.content.filter((block) => block.type === "toolCall").map((call) => ({ call, index }))
			: [],
	);
	const executedEvents = ({ name }: { name: string }) =>
		calls.filter(
			({ call, index }) =>
				call.name === name &&
				events.some(
					({ message, index: resultIndex }) =>
						resultIndex > index &&
						message.role === "toolResult" &&
						message.toolCallId === call.id &&
						message.toolName === name &&
						!message.isError,
				),
		);
	return { snapshot, events, messages, notifications, calls, executedEvents };
}

/** Semantic acceptance and diagnostics consume exactly the same validated capture. */
export function observeMessages({
	file,
	running = false,
	diagnostic,
}: {
	file: string;
	running?: boolean;
	diagnostic?: {
		model: string;
		expectedLaunchControls?: LaunchControls;
		failOnLaunchControlMismatch?: boolean;
		capture: (value: Static<typeof MessageDiagnosticSchema>) => void;
	};
}) {
	let observation: ReturnType<typeof readObservation>;
	try {
		observation = readObservation({ file, running });
	} catch (error) {
		diagnostic?.capture(unavailableMessageDiagnostic());
		throw error;
	}
	if (diagnostic) {
		const projection = projectDiagnostic({
			observation,
			model: diagnostic.model,
			expectedLaunchControls: diagnostic.expectedLaunchControls,
		});
		diagnostic.capture(projection);
		if (
			diagnostic.failOnLaunchControlMismatch &&
			diagnostic.expectedLaunchControls &&
			projection.launchControls === "mismatched"
		)
			throw new Error(MESSAGE_OBSERVATION_ERRORS.launchControls);
	}
	const { snapshot, events, messages, notifications, executedEvents } = observation;
	for (const message of messages) {
		if (
			(message.role === "toolResult" && message.isError) ||
			(message.role === "assistant" && message.stopReason !== "stop" && message.stopReason !== "toolUse")
		)
			throw new Error(MESSAGE_OBSERVATION_ERRORS.incomplete);
		if (
			message.role === "assistant" &&
			message.content.some((block) => block.type === "toolCall" && block.argumentsError !== undefined)
		)
			throw new Error(MESSAGE_OBSERVATION_ERRORS.arguments);
	}

	const executed = ({ name }: { name: string }) => executedEvents({ name }).map(({ call }) => call);
	const replyEvents = executedEvents({ name: knownTools.subagent_message }).map(({ call, index }) => ({
		index,
		parameters: parseOrThrow(SubagentMessageParameters, call.arguments, "executed parent reply"),
	}));
	return {
		pending: snapshot.pending,
		events,
		notifications,
		messages,
		launches: executed({ name: knownTools.subagent }),
		replyEvents,
		replies: replyEvents.map((event) => event.parameters),
		questions: executed({ name: knownTools.ask_question }),
		text: messages
			.filter((message) => message.role === "assistant")
			.flatMap((message) => message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])))
			.join("\n"),
	};
}

const DIAGNOSTIC_COUNT_LIMIT = 1_000_000;
const DiagnosticCount = Type.Integer({ minimum: 0, maximum: DIAGNOSTIC_COUNT_LIMIT });
const knownTools = {
	subagent: "subagent",
	subagent_message: "subagent_message",
	ask_question: "ask_question",
} as const;
export const MessageDiagnosticSchema = Type.Object(
	{
		status: Type.Union([Type.Literal("validated"), Type.Literal("unavailable")]),
		modelMatches: Type.Boolean(),
		launchControls: Type.Union([
			Type.Literal("not-checked"),
			Type.Literal("absent"),
			Type.Literal("matched"),
			Type.Literal("mismatched"),
		]),
		stopReasons: Type.Array(
			Type.Object({ reason: Type.Enum(stopReasons), count: DiagnosticCount }, { additionalProperties: false }),
			{ maxItems: Object.keys(stopReasons).length },
		),
		blocks: Type.Array(
			Type.Object(
				{
					kind: Type.Union([
						contentSchemas.text.properties.type,
						contentSchemas.thinking.properties.type,
						contentSchemas.toolCall.properties.type,
					]),
					count: DiagnosticCount,
				},
				{ additionalProperties: false },
			),
			{ maxItems: Object.keys(contentSchemas).length },
		),
		tools: Type.Array(
			Type.Object(
				{
					name: Type.Enum(knownTools),
					results: DiagnosticCount,
					successResults: DiagnosticCount,
					errorResults: DiagnosticCount,
					executed: DiagnosticCount,
				},
				{ additionalProperties: false },
			),
			{ maxItems: Object.keys(knownTools).length },
		),
		otherTool: Type.Boolean(),
	},
	{ additionalProperties: false },
);

/** No source values (including errors) cross this projection boundary. */
export function messageDiagnostic({
	file,
	model,
	expectedLaunchControls,
}: {
	file: string;
	model: string;
	expectedLaunchControls?: LaunchControls;
}): Static<typeof MessageDiagnosticSchema> {
	try {
		return projectDiagnostic({ observation: readObservation({ file }), model, expectedLaunchControls });
	} catch {
		return unavailableMessageDiagnostic();
	}
}

export function unavailableMessageDiagnostic(): Static<typeof MessageDiagnosticSchema> {
	return parseOrThrow(
		MessageDiagnosticSchema,
		{
			status: "unavailable",
			modelMatches: false,
			launchControls: "not-checked",
			stopReasons: [],
			blocks: [],
			tools: [],
			otherTool: false,
		},
		"unavailable diagnostic",
	);
}

function projectDiagnostic({
	observation,
	model,
	expectedLaunchControls,
}: {
	observation: ReturnType<typeof readObservation>;
	model: string;
	expectedLaunchControls?: LaunchControls;
}): Static<typeof MessageDiagnosticSchema> {
	const { messages, calls, executedEvents } = observation;
	const launches = calls.filter(({ call }) => call.name === knownTools.subagent);
	const expected =
		expectedLaunchControls === undefined
			? undefined
			: parseOrThrow(LaunchControlsSchema, expectedLaunchControls, "launch fixture controls");
	const launchControls =
		expected === undefined
			? "not-checked"
			: launches.length === 0
				? "absent"
				: launches.every(
							({ call }) =>
								Object.hasOwn(call.arguments, "agentScope") &&
								Object.hasOwn(call.arguments, "confirmProjectAgents") &&
								call.arguments.agentScope === expected.agentScope &&
								call.arguments.confirmProjectAgents === expected.confirmProjectAgents,
					  )
					? "matched"
					: "mismatched";
	const assistants = messages.filter((message) => message.role === "assistant");
	const bounded = ({ count }: { count: number }) => Math.min(count, DIAGNOSTIC_COUNT_LIMIT);
	return parseOrThrow(
		MessageDiagnosticSchema,
		{
			status: "validated",
			launchControls,
			modelMatches:
				assistants.length > 0 && assistants.every((message) => `${message.provider}/${message.model}` === model),
			stopReasons: Object.values(stopReasons).map((reason) => ({
				reason,
				count: bounded({ count: assistants.filter((message) => message.stopReason === reason).length }),
			})),
			blocks: Object.values(contentSchemas).map((schema) => ({
				kind: schema.properties.type.const,
				count: bounded({
					count: assistants
						.flatMap((message) => message.content)
						.filter((block) => block.type === schema.properties.type.const).length,
				}),
			})),
			tools: Object.values(knownTools).map((name) => ({
				name,
				results: bounded({
					count: messages.filter((message) => message.role === "toolResult" && message.toolName === name).length,
				}),
				successResults: bounded({
					count: messages.filter(
						(message) => message.role === "toolResult" && message.toolName === name && !message.isError,
					).length,
				}),
				errorResults: bounded({
					count: messages.filter(
						(message) => message.role === "toolResult" && message.toolName === name && message.isError,
					).length,
				}),
				executed: bounded({ count: executedEvents({ name }).length }),
			})),
			otherTool:
				calls.some(({ call }) => !Object.values(knownTools).some((name) => name === call.name)) ||
				messages.some(
					(message) =>
						message.role === "toolResult" && !Object.values(knownTools).some((name) => name === message.toolName),
				),
		} satisfies Static<typeof MessageDiagnosticSchema>,
		"message diagnostic",
	);
}

export function assertObservedModel({
	observation,
	model,
}: {
	observation: ReturnType<typeof observeMessages>;
	model: string;
}) {
	const assistants = observation.messages.filter((message) => message.role === "assistant");
	if (!assistants.length || assistants.some((message) => `${message.provider}/${message.model}` !== model))
		throw new Error(MESSAGE_OBSERVATION_ERRORS.identity);
}

export function hasAcknowledgedCompletion({
	observation,
	child,
	marker,
	acknowledgment,
}: {
	observation: ReturnType<typeof observeMessages>;
	child: Pick<ChildRecord, "name" | "sessionId" | "handoffPath">;
	marker: string;
	acknowledgment: string;
}) {
	return observation.notifications.some(
		(notification) =>
			notification.kind === MESSAGE_NOTIFICATION_TYPES.completion &&
			notification.value.name === child.name &&
			notification.value.sessionId === child.sessionId &&
			notification.value.handoffPath === child.handoffPath &&
			notification.value.status === CHILD_STATES.completed &&
			notification.value.result.includes(marker) &&
			observation.events.some(
				(event) =>
					event.index > notification.index &&
					event.message.role === "assistant" &&
					event.message.content.some((block) => block.type === "text" && block.text.includes(acknowledgment)),
			),
	);
}
