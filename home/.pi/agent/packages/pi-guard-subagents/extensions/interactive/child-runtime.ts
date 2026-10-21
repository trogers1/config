/** Child-only control runtime. Loaded explicitly by guarded panes. */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
	MessageStartEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { recordActivity } from "./activity.ts";
import {
	atomicJsonWrite,
	parseOrThrow,
	QuestionSchema,
	questionPointerPath,
	questionRecordPath,
	readQuestionReply,
	QUESTION_ERRORS,
	QUESTION_REPLY_STATES,
	type Question,
	type Reply,
	SteeringMessageSchema,
	UsageSchema,
	validateLoadout,
} from "./types.ts";

const AgentEndSchema = Type.Object({ messages: Type.Optional(Type.Array(Type.Unknown())) });
const AssistantMessageSchema = Type.Object({
	role: Type.Optional(Type.String()),
	stopReason: Type.Optional(Type.String()),
	errorMessage: Type.Optional(Type.String()),
	content: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
	usage: Type.Optional(UsageSchema),
	model: Type.Optional(Type.String()),
});
type AssistantRecord = Static<typeof AssistantMessageSchema>;
const AskQuestionParameters = Type.Object({ question: Type.String() });
const MessageStartSchema = Type.Object({ message: Type.Unknown() });
const MessageSchema = Type.Object({
	role: Type.Optional(Type.String()),
	provider: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
});
const ToolStartSchema = Type.Object({ toolName: Type.String(), args: Type.Unknown() });
const ToolEndSchema = Type.Object({ toolName: Type.String(), result: Type.Unknown(), isError: Type.Boolean() });
const ToolResultSchema = Type.Object({
	isError: Type.Optional(Type.Boolean()),
	content: Type.Optional(Type.Array(Type.Object({ text: Type.Optional(Type.String()) }))),
});
function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function finalAssistant(event: AgentEndEvent): AssistantRecord | undefined {
	const messages = parseOrThrow(AgentEndSchema, event, "agent_end event").messages ?? [];
	const value = [...messages]
		.reverse()
		.find((entry) => typeof entry === "object" && entry !== null && "role" in entry && entry.role === "assistant");
	return value === undefined ? undefined : parseOrThrow(AssistantMessageSchema, value, "assistant message");
}
function finalText(event: AgentEndEvent): string {
	const message = finalAssistant(event);
	return (message?.content ?? [])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join("\n")
		.trim();
}

export default function childRuntime(pi: ExtensionAPI): void {
	const loadoutPath = process.env.PI_SUBAGENT_LOADOUT;
	if (!loadoutPath) return;
	const loadout = validateLoadout(JSON.parse(fs.readFileSync(loadoutPath, "utf8")));
	const childSessionId = process.env.PI_SUBAGENT_SESSION_ID ?? path.basename(loadoutPath, ".json");
	const attemptId = process.env.PI_SUBAGENT_ATTEMPT_ID ?? loadout.attemptId;
	const root = path.dirname(loadoutPath);
	const activity = path.join(root, `activity-${childSessionId}.json`);
	const terminalFile = `${loadoutPath}.terminal.json`;
	let waiting = false;
	let terminalWritten = false;
	let lastAgentEnd: AgentEndEvent | undefined;
	let steeringTimer: NodeJS.Timeout | undefined;
	const observedPaths: string[] = [];
	const permissionBlocks: Array<Record<string, unknown>> = [];
	const toolCalls: Array<Record<string, unknown>> = [];
	// Current Pi's event overload declarations intentionally expose only a
	// subset of lifecycle events. The runtime dispatches these documented
	// extension events, so use a narrow structural adapter rather than `any`.
	let expanded = false;
	let activeTool = "idle";
	let uiContext: ExtensionContext | undefined;
	const renderWidget = () => {
		if (!uiContext?.ui) return;
		const lines = expanded
			? [
					`${loadout.agent} · ${childSessionId}`,
					`tool: ${activeTool}`,
					`profile: ${loadout.profile ?? "default"}`,
					`scope: ${loadout.writes?.join(", ") ?? "profile policy"}`,
					"(alt+t or ctrl+shift+t to collapse)",
				]
			: [`${loadout.agent} · ${childSessionId} · ${activeTool}`, "(alt+t or ctrl+shift+t to expand tools)"];
		uiContext.ui.setWidget("pi-guard-subagent", lines);
	};

	const terminal = (status: "completed" | "failed", result: string, failure?: string, metadata?: AssistantRecord) => {
		if (terminalWritten) return;
		terminalWritten = true;
		atomicJsonWrite(terminalFile, {
			version: 1,
			attemptId,
			status,
			result,
			failure: failure ?? null,
			observedPaths: [...new Set(observedPaths)],
			permissionBlocks,
			toolCalls,
			...(metadata?.usage ? { usage: metadata.usage } : {}),
			model: metadata?.model ?? "unknown",
			at: new Date().toISOString(),
		});
		recordActivity(activity, status === "completed" ? "complete" : "shutdown", failure ?? result);
	};

	pi.on("session_start", (_event, ctx) => {
		uiContext = ctx;
		recordActivity(activity, "start", `${loadout.agent} on ${os.hostname()}`);
		renderWidget();
		const prefix = `${path.basename(loadoutPath)}.message-`;
		steeringTimer = setInterval(() => {
			for (const entry of fs
				.readdirSync(root)
				.filter((name) => name.startsWith(prefix))
				.sort()) {
				const messageFile = path.join(root, entry);
				try {
					const message = parseOrThrow(
						SteeringMessageSchema,
						JSON.parse(fs.readFileSync(messageFile, "utf8")),
						"steering message",
					);
					if (message.attemptId !== attemptId) {
						fs.unlinkSync(messageFile);
						continue;
					}
					pi.sendUserMessage(message.message, { deliverAs: "steer" });
					fs.unlinkSync(messageFile);
				} catch (error) {
					if (!isMissingFile(error)) terminal("failed", "", `Invalid steering message: ${String(error)}`);
				}
			}
		}, 100);
	});
	for (const shortcut of ["alt+t", "ctrl+shift+t"] as const) {
		pi.registerShortcut(shortcut, {
			description: "Expand or collapse subagent tools",
			handler: async () => {
				expanded = !expanded;
				renderWidget();
			},
		});
	}
	// Provider/model activity is deliberately recorded separately from turn
	// activity: a turn can spend a long time waiting on a provider, and the
	// parent status protocol should still have a useful explanation for that
	// interval. Pi versions expose this at message_start; tolerate the event's
	// optional fields so this remains compatible with providers that omit them.
	pi.on("message_start", (event: MessageStartEvent) => {
		const message = parseOrThrow(MessageStartSchema, event, "message_start event").message;
		const record = parseOrThrow(MessageSchema, message, "message_start message");
		if (record.role !== "assistant") return;
		recordActivity(activity, "turn");
		if (typeof record.provider !== "string" && typeof record.model !== "string") return;
		const provider = typeof record.provider === "string" ? record.provider : "unknown-provider";
		const model = typeof record.model === "string" ? `/${record.model}` : "";
		recordActivity(activity, "provider", `${provider}${model}`);
	});
	pi.on("tool_execution_start", (event: ToolExecutionStartEvent) => {
		const call = parseOrThrow(ToolStartSchema, event, "tool_execution_start event");
		const toolName = call.toolName;
		activeTool = toolName;
		renderWidget();
		const args = parseOrThrow(
			Type.Record(Type.String(), Type.Unknown()),
			call.args && typeof call.args === "object" ? call.args : {},
			"tool arguments",
		);
		toolCalls.push({ toolName, args });
		if (toolName === "write" || toolName === "edit") {
			const target = args.file_path ?? args.path;
			if (typeof target === "string") observedPaths.push(target);
		}
		recordActivity(activity, "tool", toolName);
	});
	pi.on("tool_execution_end", (event: ToolExecutionEndEvent) => {
		activeTool = "idle";
		renderWidget();
		const value = parseOrThrow(ToolEndSchema, event, "tool_execution_end event");
		const result = parseOrThrow(ToolResultSchema, value.result, "tool execution result");
		const text = (result.content ?? []).map((part) => part.text ?? "").join(" ");
		if ((value.isError || result.isError) && text.includes("[⛔️ by pi-guard]"))
			permissionBlocks.push({ toolName: value.toolName, text });
	});
	pi.on("agent_end", (event: AgentEndEvent) => {
		lastAgentEnd = event;
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (waiting || !lastAgentEnd) return;
		const last = finalAssistant(lastAgentEnd);
		const successfulStop = last?.stopReason === "stop";
		const failed = !successfulStop;
		terminal(
			failed ? "failed" : "completed",
			finalText(lastAgentEnd),
			failed ? last?.errorMessage || `Child ended with ${last?.stopReason ?? "unknown"}` : undefined,
			last,
		);
		if (loadout.autoExit) ctx.shutdown();
	});
	pi.on("session_shutdown", () => {
		if (steeringTimer) clearInterval(steeringTimer);
		if (!terminalWritten && !waiting) terminal("failed", "", "Child session shut down before completion");
	});

	pi.registerTool({
		name: "ask_question",
		label: "Ask parent",
		description:
			"Ask the parent a question and wait for its durable reply. Further questions may be asked sequentially.",
		parameters: AskQuestionParameters,
		async execute(_id, params, signal) {
			const question = parseOrThrow(AskQuestionParameters, params, "ask_question parameters").question.trim();
			if (!question) throw new Error("question must not be empty");
			if (waiting) throw new Error(QUESTION_ERRORS.pending);
			const questionFile = questionPointerPath({ loadoutPath });
			try {
				// This is only the discovery pointer; question records and replies
				// have unique paths that are retained across subsequent questions.
				const prior = parseOrThrow(
					QuestionSchema,
					JSON.parse(fs.readFileSync(questionFile, "utf8")),
					"question sidecar",
				);
				if (prior.attemptId === attemptId && !prior.answered) throw new Error(QUESTION_ERRORS.pending);
			} catch (error) {
				if (!isMissingFile(error)) throw error;
			}
			const questionId = randomUUID();
			const recordFile = questionRecordPath({ loadoutPath, questionId });
			const record = {
				version: QuestionSchema.properties.version.const,
				attemptId,
				questionId,
				question,
				answered: false,
				childSessionId,
				at: new Date().toISOString(),
			} satisfies Question;
			waiting = true;
			try {
				recordActivity(activity, "question", question);
				atomicJsonWrite(recordFile, record);
				atomicJsonWrite(questionFile, record);
				const answer = await new Promise<Reply>((resolve, reject) => {
					let settled = false;
					const finish = ({ error, reply }: { error?: Error; reply?: Reply }) => {
						if (settled) return;
						settled = true;
						clearInterval(timer);
						signal?.removeEventListener("abort", onAbort);
						if (error) reject(error);
						else if (reply) resolve(reply);
						else reject(new Error("Question finished without a reply"));
					};
					const timer = setInterval(() => {
						try {
							const state = readQuestionReply({ loadoutPath, question: record });
							if (state.status === QUESTION_REPLY_STATES.answered) finish({ reply: state.reply });
						} catch (error) {
							const failure = error instanceof Error ? error.message : String(error);
							finish({ error: new Error(failure) });
						}
					}, 100);
					const onAbort = () => finish({ error: new Error(QUESTION_ERRORS.cancelled) });
					signal?.addEventListener("abort", onAbort, { once: true });
					if (signal?.aborted) onAbort();
				});
				const answered = { ...record, answered: true, answeredAt: new Date().toISOString() } satisfies Question;
				atomicJsonWrite(recordFile, answered);
				atomicJsonWrite(questionFile, answered);
				return {
					content: [{ type: "text", text: `Parent answered: ${answer.answer}` }],
					details: { questionId },
					isError: false,
				};
			} catch (error) {
				terminal("failed", "", error instanceof Error ? error.message : String(error));
				throw error;
			} finally {
				waiting = false;
			}
		},
	});
}
