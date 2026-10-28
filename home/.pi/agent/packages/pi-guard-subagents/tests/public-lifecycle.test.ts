import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
	cpSync,
	lstatSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { loadRegistry } from "../extensions/interactive/registry.ts";
import {
	parseOrThrow,
	RegistrySchema,
	QuestionSchema,
	ReplySchema,
	TerminalSignalSchema,
	QUESTION_ERRORS,
	QUESTION_REPLY_INSTRUCTION,
	QUESTION_ID_PATTERN,
	CHILD_STATES,
	questionPointerPath,
	questionRecordPath,
	type Question,
	type ChildRecord,
} from "../extensions/interactive/types.ts";
import markerExtension from "./fixtures/marker-extension.ts";
import reloadMarker from "./fixtures/reload-marker.ts";
import { runPrintCommand } from "./support/print-command.ts";
import {
	observeMessages,
	messageDiagnostic,
	type MessageDiagnosticSchema,
	LaunchControlsSchema,
	MESSAGE_OBSERVATION_ERRORS,
	OBSERVATION_SCHEMAS,
	assertObservedModel,
	hasAcknowledgedCompletion,
} from "./support/message-observer.ts";
import { readSessionSnapshot } from "./support/session-snapshot.ts";
import { runMessageOutcome } from "./support/message-outcome.ts";
import {
	createMessageProcessControl,
	runOwnedCommand,
	MESSAGE_PROCESS_COMMANDS,
	MESSAGE_TIMING,
	MESSAGE_TEST_TIMEOUT,
	PROCESS_ERRORS,
} from "./support/message-process.ts";
import { SubagentParameters } from "../extensions/index.ts";
import { incomingNotifications, MESSAGE_NOTIFICATION_TYPES } from "./support/message-notifications.ts";
import { authorityPath } from "../extensions/interactive/launcher.ts";
import {
	CLAUDE_BRIDGE_PROVIDER,
	PROVIDER_DOCUMENTATION_BASENAMES,
} from "../extensions/interactive/provider-extensions.ts";
import type * as Launcher from "../extensions/interactive/launcher.ts";
import type * as LoadoutTypes from "../extensions/interactive/types.ts";
import {
	LOCAL_PROVIDER_MODEL_ID,
	OTHER_EXTENSION_SECTION,
	LocalProviderFixtureSchema,
} from "./fixtures/local-provider.ts";
import {
	ApprovalProbeConfigSchema,
	ApprovalProbeResultSchema,
	REMOVE_PROVIDER_COMMAND,
} from "./fixtures/provider-approval-probe.ts";

const LOCAL_PARENT_MODEL = Object.freeze({ provider: "local", id: "deterministic" });
const ProviderRequestSchema = Type.Object({
	model: Type.String(),
	messages: Type.Array(Type.Object({ role: Type.String() })),
	tools: Type.Optional(Type.Array(Type.Object({ function: Type.Object({ name: Type.String() }) }))),
});

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function messages(body: unknown): readonly unknown[] {
	if (!isRecord(body) || !Array.isArray(body.messages)) throw new Error("provider request omitted messages");
	return body.messages;
}

function toolNames(body: unknown): string[] {
	if (!isRecord(body) || !Array.isArray(body.tools)) return [];
	return body.tools.flatMap((tool) => {
		if (!isRecord(tool) || !isRecord(tool.function) || typeof tool.function.name !== "string") return [];
		return [tool.function.name];
	});
}

function toolResultCount(body: unknown): number {
	return messages(body).filter((message) => isRecord(message) && message.role === "tool").length;
}

function sse(response: ServerResponse, chunks: readonly Record<string, unknown>[]): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	response.end("data: [DONE]\n\n");
}

function toolCall({
	response,
	name,
	args,
	id,
}: {
	response: ServerResponse;
	name: string;
	args: Record<string, unknown> | string;
	id: string;
}): void {
	sse(response, [
		{
			id: "local",
			object: "chat.completion.chunk",
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id,
								type: "function",
								function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
							},
						],
					},
					finish_reason: null,
				},
			],
		},
		{
			id: "local",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: typeof args === "string" ? "length" : "tool_calls" }],
			usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
		},
	]);
}

function text(response: ServerResponse, value: string): void {
	sse(response, [
		{
			id: "local",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: { role: "assistant", content: value }, finish_reason: null }],
		},
		{
			id: "local",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
		},
	]);
}

async function closeProvider(server: ReturnType<typeof createServer>): Promise<void> {
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
		server.closeAllConnections();
	});
}

async function waitFor<T>(read: () => T | undefined, label: string, timeout = 15_000): Promise<T> {
	const deadline = Date.now() + timeout;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const value = read();
			if (value !== undefined) return value;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ""}`);
}

function configureAgentDir(work: string, port: number): string {
	const agentDir = join(work, "agent-config");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				[LOCAL_PARENT_MODEL.provider]: {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "local",
					models: [{ id: LOCAL_PARENT_MODEL.id }],
				},
			},
		}),
	);
	return agentDir;
}

function configureInstalledPackages(agentDir: string): void {
	const packages = join(agentDir, "packages");
	mkdirSync(packages, { recursive: true });
	symlinkSync(process.cwd(), join(packages, "pi-guard-subagents"), "dir");
	symlinkSync(resolve(process.cwd(), "../pi-guard"), join(packages, "pi-guard"), "dir");
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ packages: ["./packages/pi-guard", "./packages/pi-guard-subagents"] }),
	);
}

function configureProjectAgent(work: string): void {
	const directory = join(work, ".pi", "agents");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "worker.md"),
		"---\nname: worker\ndescription: deterministic integration worker\ntools: read, write, edit, bash\nmodel: local/deterministic\nprofile: builtin:worker\n---\nRun the requested integration scenario.\n",
	);
}

function captureQuestionAttempt({ child, questionId }: { child: ChildRecord; questionId: Question["questionId"] }) {
	const recordFile = questionRecordPath({ loadoutPath: child.loadoutPath, questionId });
	return {
		child,
		pointer: readFileSync(questionPointerPath({ loadoutPath: child.loadoutPath }), "utf8"),
		record: readFileSync(recordFile, "utf8"),
		terminal: readFileSync(`${child.loadoutPath}.terminal.json`, "utf8"),
		hasReply: existsSync(`${recordFile}.reply`),
	};
}

async function readProviderRequest({ request }: { request: IncomingMessage }) {
	return parseOrThrow(ProviderRequestSchema, await readJsonBody(request), "local provider request");
}

function configureProviderPackages({ work, port }: { work: string; port: number }) {
	// Node resolves imported modules through real paths (notably /var ->
	// /private/var on macOS). Match the installed module's canonical paths.
	const packages = join(realpathSync(work), "packages");
	const subagents = join(packages, "pi-guard-subagents");
	const guard = join(packages, "pi-guard");
	cpSync(join(process.cwd(), "extensions"), join(subagents, "extensions"), { recursive: true });
	cpSync(join(process.cwd(), "agents"), join(subagents, "agents"), { recursive: true });
	symlinkSync(join(process.cwd(), "node_modules"), join(subagents, "node_modules"), "dir");
	cpSync(resolve(process.cwd(), "../pi-guard"), guard, {
		recursive: true,
		filter: (source) => !source.split("/").includes("node_modules"),
	});
	symlinkSync(resolve(process.cwd(), "../pi-guard/node_modules"), join(guard, "node_modules"), "dir");
	const adapterRoot = join(packages, "pi-claude");
	const adapter = join(adapterRoot, "extensions/index.ts");
	mkdirSync(join(adapterRoot, "extensions"), { recursive: true });
	writeFileSync(
		join(adapterRoot, "package.json"),
		JSON.stringify({
			name: "deterministic-provider-fixture",
			pi: { extensions: [`./${relative(adapterRoot, adapter).split(sep).join("/")}`] },
		}),
	);
	writeFileSync(join(adapterRoot, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));
	const fixtures = join(subagents, "tests/fixtures");
	mkdirSync(fixtures, { recursive: true });
	for (const file of ["local-provider.ts", "provider-approval-probe.ts"]) {
		cpSync(join(process.cwd(), "tests/fixtures", file), join(fixtures, file));
	}
	const config = parseOrThrow(
		LocalProviderFixtureSchema,
		{ baseUrl: `http://127.0.0.1:${port}/v1` },
		"local provider fixture",
	);
	writeFileSync(join(fixtures, "local-provider.json"), JSON.stringify(config));
	const reconstructionDirectory = join(adapterRoot, "extensions/reconstruction");
	mkdirSync(reconstructionDirectory, { recursive: true });
	const reconstructionModule = join(reconstructionDirectory, "identity-fixture.ts");
	writeFileSync(reconstructionModule, "export const reconstructionReady = true;\n");
	const documentationName = PROVIDER_DOCUMENTATION_BASENAMES[0];
	if (!documentationName) throw new Error("Provider documentation allowlist is empty");
	const reconstructionDocumentation = join(reconstructionDirectory, documentationName);
	writeFileSync(reconstructionDocumentation, "# Reconstruction fixture\n");
	writeFileSync(
		adapter,
		[
			'import { reconstructionReady } from "./reconstruction/identity-fixture.ts";',
			'if (!reconstructionReady) throw new Error("Reconstruction fixture unavailable");',
			'export { default } from "../../pi-guard-subagents/tests/fixtures/local-provider.ts";',
			"",
		].join("\n"),
	);
	return {
		subagents,
		guard,
		adapter,
		reconstructionModule,
		reconstructionDirectory,
		reconstructionDocumentation,
		sharedApprovalModule: join(subagents, "extensions/interactive/provider-extensions.ts"),
	};
}

function approvedChildLoadout({
	installed,
	agentDir,
	extensions,
	work,
}: {
	installed: Pick<ReturnType<typeof configureProviderPackages>, "guard" | "subagents">;
	agentDir: string;
	extensions: LoadoutTypes.GuardedInteractiveLoadout["providerExtensions"];
	work: string;
}) {
	return {
		version: 1,
		attemptId: randomUUID(),
		agent: "worker",
		profile: "builtin:worker",
		writes: null,
		toolAllowlist: ["read", "ask_question"],
		guardExtensionPath: join(installed.guard, "extensions/guard.ts"),
		childRuntimePath: join(installed.subagents, "extensions/interactive/child-runtime.ts"),
		backingExtensionPaths: [],
		backingExtensionDigests: [],
		providerExtensions: extensions,
		model: `${CLAUDE_BRIDGE_PROVIDER}/${LOCAL_PROVIDER_MODEL_ID}`,
		thinking: null,
		systemPromptMode: null,
		identity: null,
		cwd: work,
		agentDir: null,
		codingAgentDir: agentDir,
		autoExit: true,
	} satisfies LoadoutTypes.GuardedInteractiveLoadout;
}

function runApprovalProbe({
	subagents,
	adapter,
	agentDir,
	work,
	remove = false,
	sourceChange,
}: {
	subagents: string;
	adapter?: string;
	agentDir: string;
	work: string;
	remove?: boolean;
	sourceChange?: Static<typeof ApprovalProbeConfigSchema>["sourceChange"];
}) {
	const output = join(work, `approval-${randomUUID()}.jsonl`);
	const settings = join(agentDir, "settings.json");
	const config = parseOrThrow(
		ApprovalProbeConfigSchema,
		{
			model: `${CLAUDE_BRIDGE_PROVIDER}/${LOCAL_PROVIDER_MODEL_ID}`,
			output,
			settings,
			...(sourceChange ? { sourceChange } : {}),
		},
		"approval probe config",
	);
	writeFileSync(settings, JSON.stringify({ extensions: adapter ? [adapter] : [] }));
	writeFileSync(join(subagents, "tests/fixtures/provider-approval-probe.json"), JSON.stringify(config));
	const args = ["--no-session", "-e", join(subagents, "tests/fixtures/provider-approval-probe.ts")];
	if (remove) args.push("--print", `/${REMOVE_PROVIDER_COMMAND}`);
	else args.push("--mode", "rpc");
	execFileSync("pi", args, {
		cwd: work,
		input: remove ? "" : '{"type":"get_state"}\n',
		encoding: "utf8",
		timeout: 15_000,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_SUBAGENT_DEPTH: "",
			PI_SUBAGENT_LOADOUT: "",
			PI_SUBAGENT_PROVIDER_EXTENSIONS: JSON.stringify([CLAUDE_BRIDGE_PROVIDER]),
		},
	});
	return readFileSync(output, "utf8")
		.trim()
		.split("\n")
		.map((line) => parseOrThrow(ApprovalProbeResultSchema, JSON.parse(line), "approval probe result"));
}

const MESSAGE_AGENT = "message-smoke";
const MESSAGE_REPLY = "ok";
const MESSAGE_MARKER = "MESSAGE_SMOKE_COMPLETE";
const MESSAGE_ACK = "MESSAGE_SMOKE_ACKNOWLEDGED";

function messageLaunch({ work }: { work: string }) {
	return parseOrThrow(
		SubagentParameters,
		{
			agent: MESSAGE_AGENT,
			task: `Ask the parent to reply only ${MESSAGE_REPLY} via ask_question; after exactly ${MESSAGE_REPLY} finish ${MESSAGE_MARKER}`,
			cwd: work,
			agentScope: "project",
			confirmProjectAgents: false,
		} satisfies Static<typeof SubagentParameters>,
		"message launch fixture",
	);
}

function assertMalformedObservations({ file, work }: { file: string; work: string }) {
	const session = readSessionSnapshot({ file });
	const header = session.header;
	if (!header) throw new Error("Missing owned session header");
	const emittedOnly = join(work, "emitted-without-results.jsonl");
	const withoutResults = session.entries.filter(
		(entry) => entry.type !== "message" || entry.message.role !== "toolResult",
	);
	writeFileSync(emittedOnly, [header, ...withoutResults].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	expect(observeMessages({ file }).launches).toHaveLength(1);
	const unexecuted = observeMessages({ file: emittedOnly });
	expect(unexecuted.launches).toEqual([]);
	expect(unexecuted.replies).toEqual([]);
	const launch = messageLaunch({ work });
	const expectedLaunchControls = parseOrThrow(
		LaunchControlsSchema,
		{ agentScope: launch.agentScope, confirmProjectAgents: launch.confirmProjectAgents },
		"diagnostic fixture controls",
	);
	const controlSecret = "PRIVATE_LAUNCH_CONTROL_ARGUMENT_SENTINEL";
	const controlFile = join(work, "launch-control-variants.jsonl");
	for (const variant of [
		"matched",
		"absent",
		"missing-scope",
		"missing-confirmation",
		"wrong-scope",
		"wrong-confirmation",
		"wrong-confirmation-value",
		"mixed",
	] as const) {
		const entries = withoutResults.map((entry) =>
			entry.type === "message" && entry.message.role === "assistant"
				? {
						...entry,
						message: {
							...entry.message,
							content: entry.message.content.flatMap((block) => {
								if (block.type !== "toolCall" || block.name !== "subagent") return [block];
								if (variant === "absent") return [];
								const args: typeof block.arguments = {
									...block.arguments,
									...expectedLaunchControls,
									task: controlSecret,
									cwd: controlSecret,
								};
								if (variant === "missing-scope") delete args.agentScope;
								if (variant === "missing-confirmation") delete args.confirmProjectAgents;
								if (variant === "wrong-scope") args.agentScope = controlSecret;
								if (variant === "wrong-confirmation") args.confirmProjectAgents = controlSecret;
								if (variant === "wrong-confirmation-value")
									args.confirmProjectAgents = !expectedLaunchControls.confirmProjectAgents;
								const call = { ...block, arguments: args };
								return variant === "mixed"
									? [
											call,
											{
												...call,
												id: `${call.id}-mismatch`,
												arguments: { ...args, confirmProjectAgents: controlSecret },
											},
										]
									: [call];
							}),
						},
					}
				: entry,
		);
		writeFileSync(controlFile, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
		const projected = messageDiagnostic({
			file: controlFile,
			model: `${LOCAL_PARENT_MODEL.provider}/${LOCAL_PARENT_MODEL.id}`,
			expectedLaunchControls,
		});
		expect(projected.status).toBe("validated");
		expect(projected.launchControls).toBe(
			variant === "matched" ? "matched" : variant === "absent" ? "absent" : "mismatched",
		);
		expect(JSON.stringify(projected)).not.toContain(controlSecret);
		let captured: Static<typeof MessageDiagnosticSchema> | undefined;
		const read = () =>
			observeMessages({
				file: controlFile,
				diagnostic: {
					model: `${LOCAL_PARENT_MODEL.provider}/${LOCAL_PARENT_MODEL.id}`,
					expectedLaunchControls,
					failOnLaunchControlMismatch: true,
					capture: (value) => {
						captured = value;
					},
				},
			});
		if (variant === "matched" || variant === "absent") expect(read().launches).toEqual([]);
		else expect(read).toThrow(MESSAGE_OBSERVATION_ERRORS.launchControls);
		expect(captured).toEqual(projected);
		expect(
			observeMessages({
				file: controlFile,
				diagnostic: {
					model: `${LOCAL_PARENT_MODEL.provider}/${LOCAL_PARENT_MODEL.id}`,
					expectedLaunchControls,
					capture: () => {},
				},
			}).launches,
		).toEqual([]);
		expect(
			observeMessages({
				file: controlFile,
				diagnostic: {
					model: `${LOCAL_PARENT_MODEL.provider}/${LOCAL_PARENT_MODEL.id}`,
					failOnLaunchControlMismatch: true,
					capture: () => {},
				},
			}).launches,
		).toEqual([]);
		// No expectation (including child observation) never enables this check.
		expect(
			messageDiagnostic({ file: controlFile, model: `${LOCAL_PARENT_MODEL.provider}/${LOCAL_PARENT_MODEL.id}` })
				.launchControls,
		).toBe("not-checked");
	}
	// The deterministic provider emits no thinking. Add a schema-valid thinking
	// block to copies of its real assistant entries for boundary-only coverage.
	const thinking = {
		type: OBSERVATION_SCHEMAS.thinking.properties.type.const,
		thinking: MESSAGE_REPLY,
	} satisfies Static<typeof OBSERVATION_SCHEMAS.thinking>;
	const fixtures = session.entries.map((entry) =>
		entry.type === "message" && entry.message.role === "assistant"
			? { ...entry, message: { ...entry.message, content: [...entry.message.content, thinking] } }
			: entry,
	);
	const validFixture = join(work, "valid-observation-variants.jsonl");
	writeFileSync(validFixture, [header, ...fixtures].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	expect(observeMessages({ file: validFixture }).launches).toHaveLength(1);
	const knownToolDiagnostic = messageDiagnostic({
		file: validFixture,
		model: `${LOCAL_PARENT_MODEL.provider}/${LOCAL_PARENT_MODEL.id}`,
	});
	expect(knownToolDiagnostic.tools.find((tool) => tool.name === "subagent")).toMatchObject({
		results: 1,
		successResults: 1,
		errorResults: 0,
		executed: 1,
	});
	// Project copies of real public-lifecycle evidence, never a parallel parser.
	const secret = "PRIVATE_TEXT_THINKING_ARGUMENT_RESULT_ERROR_SENTINEL";
	const unexpected = "PRIVATE_IDENTITY_TOOL_RAW_STOP_SENTINEL";
	const diagnosticFile = join(work, "diagnostic-secrets.jsonl");
	const failedResults = fixtures.map((entry) =>
		entry.type === "message" && entry.message.role === "toolResult"
			? { ...entry, message: { ...entry.message, isError: true } }
			: entry,
	);
	writeFileSync(diagnosticFile, [header, ...failedResults].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	const failedResultDiagnostic = messageDiagnostic({
		file: diagnosticFile,
		model: `${LOCAL_PARENT_MODEL.provider}/${LOCAL_PARENT_MODEL.id}`,
	});
	expect(failedResultDiagnostic.tools.find((tool) => tool.name === "subagent")).toMatchObject({
		results: 1,
		successResults: 0,
		errorResults: 1,
		executed: 0,
	});
	const diagnosticEntries = fixtures.map((entry) => {
		if (entry.type !== "message") return entry;
		if (entry.message.role === "assistant")
			return {
				...entry,
				message: {
					...entry.message,
					provider: unexpected,
					model: unexpected,
					rawStopReason: unexpected,
					errorMessage: secret,
					content: entry.message.content.map((block) =>
						block.type === "text"
							? { ...block, text: secret }
							: block.type === "thinking"
								? { ...block, thinking: secret }
								: { ...block, name: unexpected, arguments: { secret }, argumentsError: secret },
					),
				},
			};
		if (entry.message.role === "toolResult")
			return {
				...entry,
				message: {
					...entry.message,
					toolName: unexpected,
					isError: true,
					content: [{ type: "text", text: secret }],
				},
			};
		return entry;
	});
	writeFileSync(diagnosticFile, [header, ...diagnosticEntries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	const diagnostic = messageDiagnostic({
		file: diagnosticFile,
		model: `${LOCAL_PARENT_MODEL.provider}/${LOCAL_PARENT_MODEL.id}`,
	});
	expect(diagnostic.status).toBe("validated");
	expect(diagnostic.modelMatches).toBe(false);
	expect(diagnostic.otherTool).toBe(true);
	let beforeRejection: Static<typeof MessageDiagnosticSchema> | undefined;
	expect(() =>
		observeMessages({
			file: diagnosticFile,
			diagnostic: {
				model: `${LOCAL_PARENT_MODEL.provider}/${LOCAL_PARENT_MODEL.id}`,
				capture: (value) => {
					beforeRejection = value;
				},
			},
		}),
	).toThrow();
	expect(beforeRejection).toEqual(diagnostic);
	expect(JSON.stringify(diagnostic)).not.toContain(secret);
	expect(JSON.stringify(diagnostic)).not.toContain(unexpected);
	const malformedStop = diagnosticEntries.map((entry) =>
		entry.type === "message" && entry.message.role === "assistant"
			? { ...entry, message: { ...entry.message, stopReason: unexpected } }
			: entry,
	);
	writeFileSync(diagnosticFile, [header, ...malformedStop].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	const unavailable = messageDiagnostic({ file: diagnosticFile, model: unexpected });
	expect(unavailable.status).toBe("unavailable");
	expect(JSON.stringify(unavailable)).not.toContain(unexpected);
	for (const schema of Object.values(OBSERVATION_SCHEMAS)) {
		const target = "role" in schema.properties ? schema.properties.role.const : schema.properties.type.const;
		if (!schema.required?.length) throw new Error("Observation schema has no required-field contract");
		for (const field of schema.required) {
			let changed = 0;
			const entries = fixtures.map((entry) => {
				if (entry.type !== "message") return entry;
				const message = entry.message;
				if (message.role === target) {
					const broken: Record<string, unknown> = { ...message };
					delete broken[field];
					changed++;
					return { ...entry, message: broken };
				}
				if (message.role === "assistant")
					return {
						...entry,
						message: {
							...message,
							content: message.content.map((block) => {
								if (block.type !== target) return block;
								const broken: Record<string, unknown> = { ...block };
								delete broken[field];
								changed++;
								return broken;
							}),
						},
					};
				return entry;
			});
			if (!changed) throw new Error(`Real session lacks observation fixture: ${target}.${field}`);
			const malformed = join(work, `missing-${target}-${field}.jsonl`);
			writeFileSync(malformed, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
			expect(() => observeMessages({ file: malformed })).toThrow();
		}
	}
}
const liveDirection = process.env.PI_LIVE_MESSAGE_DIRECTION;
const liveEnabled = process.env.PI_LIVE_MESSAGES === "1";
if (liveEnabled && liveDirection !== "openai-to-claude" && liveDirection !== "claude-to-openai")
	throw new Error("Select exactly one PI_LIVE_MESSAGE_DIRECTION: openai-to-claude or claude-to-openai");

function ownedRegistries({ work }: { work: string }) {
	const root = join(work, ".pi/orchestration");
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.flatMap((entry) => {
			const file = join(root, entry.name, "registry.json");
			return existsSync(file)
				? [parseOrThrow(RegistrySchema, JSON.parse(readFileSync(file, "utf8")), "owned registry")]
				: [];
		});
}

async function cleanMessageAuthority({
	work,
	installed,
}: {
	work: string;
	installed: Pick<ReturnType<typeof configureProviderPackages>, "subagents">;
}) {
	// Validate every candidate before deleting any. Never enumerate global authority.
	const files: string[] = [];
	for (const registry of ownedRegistries({ work }))
		for (const child of registry.children) {
			const launcher: typeof Launcher = await import(
				pathToFileURL(join(installed.subagents, "extensions/interactive/launcher.ts")).href
			);
			const types: typeof LoadoutTypes = await import(
				pathToFileURL(join(installed.subagents, "extensions/interactive/types.ts")).href
			);
			const file = authorityPath(registry.runId, child.name);
			if (child.authorityPath !== file || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
				throw new Error("Refusing nonregular or noncanonical test authority");
			const loadout = launcher.validateResumeLoadout({ file: child.loadoutPath });
			expect(loadout).toEqual(child.loadoutSnapshot);
			const authority: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (!isRecord(authority) || "attemptId" in authority) throw new Error("Invalid immutable authority");
			const validated = types.validateLoadout({ value: { ...authority, attemptId: child.attemptId } });
			expect(validated).toEqual(loadout);
			files.push(file);
		}
	for (const file of files) rmSync(file);
	return files;
}

function ownedSessionFiles({ sessionDir }: { sessionDir: string }) {
	// Startup can fail before any child session exists; this is not success evidence.
	if (!existsSync(sessionDir)) return [];
	return readdirSync(sessionDir, { recursive: true, encoding: "utf8" })
		.filter((file) => file.endsWith(".jsonl"))
		.map((file) => join(sessionDir, file));
}

function ownedChildSession({ sessionDir, sessionId }: { sessionDir: string; sessionId: ChildRecord["sessionId"] }) {
	const files = ownedSessionFiles({ sessionDir });
	const matching = files.filter((file) => readSessionSnapshot({ file }).header?.id === sessionId);
	if (matching.length !== 1) throw new Error("Expected exactly one child session in disposable storage");
	const file = matching[0];
	if (!file) throw new Error("Missing child session path");
	return file;
}

function verifyMessageExchange({
	child,
	sessionFile,
	sessionDir,
	parentModel,
	childModel,
}: {
	child: ChildRecord;
	sessionFile: string;
	sessionDir: string;
} & Pick<Parameters<typeof messageLifecycle>[0], "parentModel" | "childModel">) {
	const parent = observeMessages({ file: sessionFile });
	expect(parent.launches).toHaveLength(1);
	assertObservedModel({ observation: parent, model: parentModel });
	expect(
		hasAcknowledgedCompletion({ observation: parent, child, marker: MESSAGE_MARKER, acknowledgment: MESSAGE_ACK }),
	).toBe(true);
	expect(child.loadoutSnapshot.model).toBe(childModel);
	expect(child.state).toBe(CHILD_STATES.completed);
	const question = parseOrThrow(
		QuestionSchema,
		JSON.parse(readFileSync(questionPointerPath({ loadoutPath: child.loadoutPath }), "utf8")),
		"message question",
	);
	expect(question).toMatchObject({ answered: true, childSessionId: child.sessionId, attemptId: child.attemptId });
	expect(question.question).toContain(MESSAGE_REPLY);
	const reply = parseOrThrow(
		ReplySchema,
		JSON.parse(
			readFileSync(
				`${questionRecordPath({ loadoutPath: child.loadoutPath, questionId: question.questionId })}.reply`,
				"utf8",
			),
		),
		"message reply",
	);
	expect(reply).toMatchObject({ answer: MESSAGE_REPLY, questionId: question.questionId, attemptId: child.attemptId });
	expect(parent.replies).toEqual([{ name: child.name, message: MESSAGE_REPLY, questionId: question.questionId }]);
	const deliveredQuestion = parent.notifications.find(
		(notification) =>
			notification.kind === MESSAGE_NOTIFICATION_TYPES.question &&
			notification.value.name === child.name &&
			notification.value.questionId === question.questionId,
	);
	const replyEvent = parent.replyEvents[0];
	if (!deliveredQuestion || !replyEvent || replyEvent.index <= deliveredQuestion.index)
		throw new Error("Reply did not follow the matching delivered question");
	const terminal = parseOrThrow(
		TerminalSignalSchema,
		JSON.parse(readFileSync(`${child.loadoutPath}.terminal.json`, "utf8")),
		"message terminal",
	);
	expect(terminal).toMatchObject({
		status: CHILD_STATES.completed,
		attemptId: child.attemptId,
		model: childModel.slice(childModel.indexOf("/") + 1),
	});
	expect(terminal.result).toContain(MESSAGE_MARKER);
	expect(terminal.permissionBlocks ?? []).toEqual([]);
	if (!child.handoffPath) throw new Error("Missing message handoff");
	expect(readFileSync(child.handoffPath, "utf8")).toContain(MESSAGE_MARKER);
	const childFile = ownedChildSession({ sessionDir, sessionId: child.sessionId });
	expect(messageDiagnostic({ file: childFile, model: childModel }).launchControls).toBe("not-checked");
	const observed = observeMessages({ file: childFile });
	assertObservedModel({ observation: observed, model: childModel });
	expect(observed.questions).toHaveLength(1);
	expect(observed.text).toContain(MESSAGE_MARKER);
}

async function messageLifecycle({
	parentModel,
	childModel,
	agentDir,
	installed,
	work,
	timeout = MESSAGE_TIMING.executionMs,
	inspectStopped,
	parentExecutable = "pi",
	parentExtension,
}: {
	parentModel: string;
	childModel: string;
	agentDir?: string;
	installed: Pick<ReturnType<typeof configureProviderPackages>, "guard" | "subagents" | "adapter">;
	work: string;
	timeout?: number;
	inspectStopped?: (context: { work: string; sessionFile: string }) => void;
	parentExecutable?: string;
	parentExtension?: string;
}) {
	const deadline = performance.now() + timeout;
	const socket = join(work, "tmux.socket");
	const control = createMessageProcessControl({ socket });
	const sessionFile = join(work, "parent.jsonl");
	const sessionDir = join(work, "sessions");
	mkdirSync(join(work, ".pi/agents"), { recursive: true });
	writeFileSync(
		join(work, ".pi/agents", `${MESSAGE_AGENT}.md`),
		`---\nname: ${MESSAGE_AGENT}\ndescription: messaging smoke\nmodel: ${JSON.stringify(childModel)}\nthinking: off\ntools: read\nprofile: builtin:read-only\n---\nAsk the parent using ask_question to reply only ${MESSAGE_REPLY}. After receiving exactly ${MESSAGE_REPLY}, finish with ${MESSAGE_MARKER}.\n`,
	);
	const launch = messageLaunch({ work });
	const expectedLaunchControls = parseOrThrow(
		LaunchControlsSchema,
		{ agentScope: launch.agentScope, confirmProjectAgents: launch.confirmProjectAgents },
		"explicit fixture controls",
	);
	const prompt = `Call subagent exactly once with ${JSON.stringify(launch)}. You MUST explicitly include agentScope:${JSON.stringify(launch.agentScope)} and confirmProjectAgents:${JSON.stringify(launch.confirmProjectAgents)} in the call. Omitting these fields can pause for human confirmation; do not approve or bypass any confirmation. WAIT after launch. Do not invent question IDs. Await the actual question notification, then call subagent_message with the real name and exact questionId and message ${MESSAGE_REPLY}. WAIT for actual completion and handoff containing ${MESSAGE_MARKER}, then acknowledge with ${MESSAGE_ACK}. Never retry a failure.`;
	const args = [
		parentExecutable,
		"--no-extensions",
		"--no-mcp",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"-e",
		join(installed.guard, "extensions/guard.ts"),
		"-e",
		join(installed.subagents, "extensions/index.ts"),
		"-e",
		installed.adapter,
		...(parentExtension ? ["-e", parentExtension] : []),
		"--tools",
		"subagent,subagent_message",
		"--model",
		parentModel,
		"--thinking",
		"off",
		"--session",
		sessionFile,
		prompt,
	];
	let startupAttempted = false;
	let candidate: ChildRecord | undefined;
	let parentDiagnostic: Static<typeof MessageDiagnosticSchema> | undefined;
	let validationDeadline = 0;
	await runMessageOutcome({
		execute: async () => {
			// Keep a dedicated server alive even if Pi fails during startup. All CLI
			// processes inherit the session-directory/cap environment from this server.
			if (performance.now() >= deadline) throw new Error(PROCESS_ERRORS.deadline);
			startupAttempted = true;
			await runOwnedCommand({
				command: MESSAGE_PROCESS_COMMANDS.tmux,
				args: [
					"-S",
					socket,
					"-f",
					"/dev/null",
					"new-session",
					"-d",
					"-s",
					"message",
					"-c",
					work,
					"/bin/sleep",
					String(Math.ceil(MESSAGE_TEST_TIMEOUT / 1000)),
				],
				deadline,
				env: {
					...process.env,
					...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
					PI_CODING_AGENT_SESSION_DIR: sessionDir,
					CLAUDE_CODE_MAX_OUTPUT_TOKENS: "256",
					PI_OFFLINE: "1",
				},
			});
			await runOwnedCommand({
				command: MESSAGE_PROCESS_COMMANDS.tmux,
				args: ["-S", socket, "set-window-option", "-g", "remain-on-exit", "on"],
				deadline,
			});
			const pane = (
				await runOwnedCommand({
					command: MESSAGE_PROCESS_COMMANDS.tmux,
					args: ["-S", socket, "new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "message", "-c", work, ...args],
					deadline,
				})
			).trim();
			while (performance.now() < deadline) {
				if (
					(
						await runOwnedCommand({
							command: MESSAGE_PROCESS_COMMANDS.tmux,
							args: ["-S", socket, "display-message", "-p", "-t", pane, "#{pane_dead}"],
							deadline,
						})
					).trim() === "1"
				)
					throw new Error("Messaging parent exited before acknowledgment");
				const registries = ownedRegistries({ work });
				const children = registries.flatMap((registry) => registry.children);
				if (children.length > 1) throw new Error("Unexpected extra launch");
				const child = children[0];
				if (
					child?.failure ||
					child?.state === CHILD_STATES.failed ||
					child?.deliveryFailure ||
					child?.questionDeliveryFailure
				)
					throw new Error("Messaging child or delivery failed");
				const parent = existsSync(sessionFile)
					? observeMessages({
							file: sessionFile,
							running: true,
							diagnostic: {
								model: parentModel,
								expectedLaunchControls,
								failOnLaunchControlMismatch: true,
								capture: (value) => {
									parentDiagnostic = value;
								},
							},
						})
					: undefined;
				if (
					child?.delivered &&
					parent &&
					hasAcknowledgedCompletion({ observation: parent, child, marker: MESSAGE_MARKER, acknowledgment: MESSAGE_ACK })
				) {
					candidate = child;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			if (!candidate) throw new Error(PROCESS_ERRORS.deadline);
		},
		shutdown: async () => {
			if (startupAttempted) {
				try {
					await control.shutdown({ deadline: performance.now() + MESSAGE_TIMING.shutdownMs });
				} catch (error) {
					try {
						writeFileSync(join(work, "cleanup-identities.json"), JSON.stringify(control.observedIdentities()));
					} catch {
						// The runner still records shutdown as failed; retain its original failure.
					}
					throw error;
				}
			}
		},
		validate: () => {
			validationDeadline = performance.now() + MESSAGE_TIMING.validationMs;
			inspectStopped?.({ work, sessionFile });
			// Final acceptance is based on fresh, strict reads after verified shutdown.
			if (existsSync(sessionFile)) readSessionSnapshot({ file: sessionFile });
			for (const file of ownedSessionFiles({ sessionDir })) {
				if (performance.now() >= validationDeadline) throw new Error(PROCESS_ERRORS.deadline);
				readSessionSnapshot({ file });
			}
			if (performance.now() >= validationDeadline) throw new Error(PROCESS_ERRORS.deadline);
		},
		accept: () => {
			if (!candidate) throw new Error("Missing message acceptance candidate");
			verifyMessageExchange({ child: candidate, sessionFile, sessionDir, parentModel, childModel });
			if (performance.now() >= validationDeadline) throw new Error(PROCESS_ERRORS.deadline);
		},
		remove: async () => {
			if (performance.now() >= validationDeadline) throw new Error(PROCESS_ERRORS.deadline);
			await cleanMessageAuthority({ work, installed });
			if (performance.now() >= validationDeadline) throw new Error(PROCESS_ERRORS.deadline);
			rmSync(work, { recursive: true, force: true });
		},
		diagnostics: () => [
			parentDiagnostic ?? messageDiagnostic({ file: sessionFile, model: parentModel, expectedLaunchControls }),
			...ownedSessionFiles({ sessionDir })
				.slice(0, 1)
				.map((file) => messageDiagnostic({ file, model: childModel })),
		],
		emit: (report) => console.info(JSON.stringify(report)),
	});
}

const sessions: Array<{ socket: string; session: string }> = [];
afterEach(() => {
	for (const { socket, session } of sessions.splice(0)) {
		try {
			execFileSync("tmux", ["-L", socket, "kill-session", "-t", session], { stdio: "ignore" });
		} catch {
			// The production shutdown path may already have removed it.
		}
	}
});

describe("public bidirectional messaging", () => {
	it.each(["openai-to-claude", "claude-to-openai"].filter((direction) => !liveEnabled || direction === liveDirection))(
		"live %s",
		{ timeout: MESSAGE_TEST_TIMEOUT, retry: 0, skip: !liveEnabled },
		async (direction) => {
			const openai = process.env.PI_LIVE_OPENAI_MODEL;
			const claude = process.env.PI_LIVE_CLAUDE_MODEL;
			if (!openai?.startsWith("openai/") || !claude?.startsWith(`${CLAUDE_BRIDGE_PROVIDER}/`) || !/haiku/i.test(claude))
				throw new Error("Set explicit cheap PI_LIVE_OPENAI_MODEL and PI_LIVE_CLAUDE_MODEL (bridge Haiku)");
			const work = realpathSync(mkdtempSync(join(tmpdir(), "pi-live-message-")));
			await messageLifecycle({
				work,
				parentModel: direction === "openai-to-claude" ? openai : claude,
				childModel: direction === "openai-to-claude" ? claude : openai,
				installed: {
					subagents: process.cwd(),
					guard: resolve(process.cwd(), "../pi-guard"),
					adapter: resolve(process.cwd(), "../pi-claude/extensions/index.ts"),
				},
			});
		},
	);

	it.each([
		"complete",
		"truncated-launch",
		"omitted-confirmation",
		"truncated-final-validation",
		"startup-failure",
		"deadline",
		"authority-mismatch",
		"early-ack",
		"missing-question-id",
		"identity-mismatch",
	])(
		"observes messaging and cleanup offline: %s",
		async (scenario) => {
			const work = realpathSync(mkdtempSync(join(tmpdir(), "pi-offline-message-")));
			let failure: unknown;
			const server = createServer(async (request, response) => {
				try {
					const body = await readProviderRequest({ request });
					if (toolNames(body).includes("subagent")) {
						const received = incomingNotifications({ messages: messages(body) });
						if (scenario === "truncated-launch" || scenario === "truncated-final-validation")
							return toolCall({ response, name: "subagent", args: '{"agent":', id: "incomplete-launch" });
						if (!toolResultCount(body)) {
							const launch = messageLaunch({ work });
							if (scenario === "omitted-confirmation") delete launch.confirmProjectAgents;
							return toolCall({ response, name: "subagent", args: launch, id: "message-launch" });
						}
						const question = received.find((notification) => notification.kind === MESSAGE_NOTIFICATION_TYPES.question);
						if (question && toolResultCount(body) === 1) {
							return toolCall({
								response,
								name: "subagent_message",
								args: { name: question.value.name, questionId: question.value.questionId, message: MESSAGE_REPLY },
								id: "message-reply",
							});
						}
						const completion = received.find(
							(notification) => notification.kind === MESSAGE_NOTIFICATION_TYPES.completion,
						);
						return text(
							response,
							scenario === "early-ack"
								? completion
									? "waiting"
									: MESSAGE_ACK
								: completion?.value.result.includes(MESSAGE_MARKER)
									? MESSAGE_ACK
									: "waiting",
						);
					}
					if (!toolResultCount(body))
						return toolCall({
							response,
							name: "ask_question",
							args: { question: `Reply only ${MESSAGE_REPLY}` },
							id: "message-question",
						});
					return text(response, MESSAGE_MARKER);
				} catch (error) {
					failure = error;
					response.destroy();
				}
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Provider did not bind");
			const installed = configureProviderPackages({ work, port: address.port });
			let restore: { file: string; content: string } | undefined;
			try {
				const executionStarted = performance.now();
				const lifecycle = messageLifecycle({
					work,
					installed,
					agentDir: configureAgentDir(work, address.port),
					parentModel: `${LOCAL_PARENT_MODEL.provider}/${LOCAL_PARENT_MODEL.id}`,
					// Node rejects the Pi-only CLI flags before any provider can run.
					parentExecutable: scenario === "startup-failure" ? process.execPath : undefined,
					parentExtension:
						scenario === "missing-question-id"
							? join(process.cwd(), "tests/fixtures/missing-question-identity.ts")
							: undefined,
					childModel: `${CLAUDE_BRIDGE_PROVIDER}/${LOCAL_PROVIDER_MODEL_ID}`,
					timeout: scenario === "deadline" ? 100 : scenario === "early-ack" ? 8_000 : 25_000,
					inspectStopped: ({ sessionFile }) => {
						const registries = ownedRegistries({ work });
						if (scenario === "complete") assertMalformedObservations({ file: sessionFile, work });
						if (scenario === "omitted-confirmation") {
							expect(performance.now() - executionStarted).toBeLessThan(25_000);
							expect(registries.flatMap((registry) => registry.children)).toEqual([]);
							expect(ownedSessionFiles({ sessionDir: join(work, "sessions") })).toEqual([]);
							const launch = messageLaunch({ work });
							const diagnostic = messageDiagnostic({
								file: sessionFile,
								model: `${LOCAL_PARENT_MODEL.provider}/${LOCAL_PARENT_MODEL.id}`,
								expectedLaunchControls: parseOrThrow(
									LaunchControlsSchema,
									{ agentScope: launch.agentScope, confirmProjectAgents: launch.confirmProjectAgents },
									"omission fixture controls",
								),
							});
							expect(diagnostic).toMatchObject({ status: "validated", launchControls: "mismatched" });
							expect(diagnostic.tools.find((tool) => tool.name === "subagent")).toMatchObject({
								successResults: 0,
								executed: 0,
							});
							const emitted = readSessionSnapshot({ file: sessionFile }).entries.flatMap((entry) =>
								entry.type === "message" && entry.message.role === "assistant"
									? entry.message.content.flatMap((block) =>
											block.type === "toolCall" && block.name === "subagent" ? [block] : [],
										)
									: [],
							);
							expect(emitted.length).toBeGreaterThan(0);
							for (const call of emitted) expect(Object.hasOwn(call.arguments, "confirmProjectAgents")).toBe(false);
						}
						if (scenario === "truncated-launch") {
							expect(registries.flatMap((registry) => registry.children)).toEqual([]);
							expect(() => observeMessages({ file: sessionFile })).toThrow(MESSAGE_OBSERVATION_ERRORS.incomplete);
						}
						if (scenario === "truncated-final-validation") {
							restore = { file: sessionFile, content: readFileSync(sessionFile, "utf8") };
							writeFileSync(sessionFile, restore.content + "\n{invalid-final-json}\n");
						}
						if (scenario === "missing-question-id") {
							const child = registries[0]?.children[0];
							if (!child) throw new Error("Missing child for notification fault assertion");
							const question = parseOrThrow(
								QuestionSchema,
								JSON.parse(readFileSync(questionPointerPath({ loadoutPath: child.loadoutPath }), "utf8")),
								"unanswered question",
							);
							expect(question.answered).toBe(false);
							const snapshot = readSessionSnapshot({ file: sessionFile });
							expect(
								snapshot.entries.filter(
									(entry) =>
										entry.type === "message" &&
										entry.message.role === "toolResult" &&
										entry.message.toolName === "subagent_message" &&
										!entry.message.isError,
								),
							).toEqual([]);
						}
						if (scenario === "identity-mismatch") {
							const child = registries[0]?.children[0];
							if (!child) throw new Error("Missing child for identity fault");
							const file = ownedChildSession({ sessionDir: join(work, "sessions"), sessionId: child.sessionId });
							restore = { file, content: readFileSync(file, "utf8") };
							const snapshot = readSessionSnapshot({ file });
							const entries = snapshot.entries.map((entry) =>
								entry.type === "message" && entry.message.role === "assistant"
									? { ...entry, message: { ...entry.message, provider: `${entry.message.provider}-unexpected` } }
									: entry,
							);
							writeFileSync(
								file,
								[snapshot.header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
							);
						}
						if (scenario === "authority-mismatch") {
							const registry = registries[0];
							const child = registry?.children[0];
							if (!child) throw new Error("Missing test-owned child for cleanup fault");
							const file = authorityPath(registry.runId, child.name);
							restore = { file, content: readFileSync(file, "utf8") };
							const copy = join(work, "authority-copy.json");
							writeFileSync(copy, restore.content);
							rmSync(file);
							symlinkSync(copy, file);
						}
					},
				});
				if (scenario === "complete") await lifecycle;
				else
					await expect(lifecycle).rejects.toThrow(
						scenario === "authority-mismatch"
							? "Messaging lifecycle failed: deletion"
							: scenario === "identity-mismatch"
								? "Messaging lifecycle failed: acceptance"
								: "Messaging lifecycle failed: execution",
					);
				if (scenario === "omitted-confirmation") {
					await expect(lifecycle).rejects.toThrow('"launchControls":"mismatched"');
					for (const phase of ["shutdown", "finalValidation", "deletion"])
						await expect(lifecycle).rejects.toThrow(`"${phase}":"passed"`);
				}
				expect(existsSync(work)).toBe(
					scenario === "authority-mismatch" ||
						scenario === "identity-mismatch" ||
						scenario === "truncated-final-validation",
				);
				if (restore) expect(lstatSync(restore.file).isSymbolicLink()).toBe(scenario === "authority-mismatch");
				if (scenario === "missing-question-id") expect(failure).toBeInstanceOf(Error);
				else if (failure) throw failure;
			} finally {
				await closeProvider(server);
				if (restore) {
					rmSync(restore.file);
					writeFileSync(restore.file, restore.content);
					await cleanMessageAuthority({ work, installed });
					rmSync(work, { recursive: true });
				}
			}
		},
		MESSAGE_TEST_TIMEOUT,
	);
});

describe("installed Pi public orchestration lifecycle", () => {
	it("fails public delegation without a tmux environment and never starts a headless worker", async () => {
		const work = mkdtempSync(join(tmpdir(), "pi-guard-outside-tmux-"));
		configureProjectAgent(work);
		let observedFailure = false;
		const server = createServer(async (request, response) => {
			const body = await readJsonBody(request);
			const serialized = JSON.stringify(messages(body));
			if (toolResultCount(body) === 0)
				return toolCall({
					response,
					name: "subagent",
					args: {
						agent: "worker",
						task: "MUST_NOT_RUN_HEADLESS",
						cwd: work,
						agentScope: "project",
						confirmProjectAgents: false,
					},
					id: "outside-tmux-launch",
				});
			observedFailure =
				serialized.includes("Interactive subagents require tmux") && serialized.includes("tmux new -A -s pi");
			return text(response, observedFailure ? "outside-tmux failure confirmed" : "missing tmux guidance");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("local provider did not bind");
		const agentDir = configureAgentDir(work, address.port);
		const socket = `pi-guard-outside-tmux-${process.pid}`;
		const session = `pi-guard-outside-tmux-${process.pid}`;
		sessions.push({ socket, session });
		const command = [
			`cd ${shellQuote(work)} &&`,
			"env -u TMUX",
			`PI_CODING_AGENT_DIR=${shellQuote(agentDir)}`,
			"pi --no-extensions",
			`-e ${shellQuote(join(process.cwd(), "extensions", "index.ts"))}`,
			"--model local/deterministic --tools subagent,subagent_message",
			shellQuote("PUBLIC_OUTSIDE_TMUX"),
		].join(" ");
		try {
			execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "sh"]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "-l", command]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "Enter"]);
			const pane = await waitFor(() => {
				if (!observedFailure) return undefined;
				const content = execFileSync("tmux", ["-L", socket, "capture-pane", "-p", "-S", "-100", "-t", session], {
					encoding: "utf8",
				});
				return content.includes("outside-tmux failure confirmed") ? content : undefined;
			}, "public outside-tmux rejection");
			expect(pane).toContain("outside-tmux failure confirmed");
			expect(existsSync(join(work, ".pi", "orchestration"))).toBe(false);
		} finally {
			await closeProvider(server);
			rmSync(work, { recursive: true, force: true });
		}
	}, 20_000);

	it("fails closed when a non-UI caller cannot confirm a project agent", async () => {
		const work = mkdtempSync(join(tmpdir(), "pi-guard-project-confirmation-"));
		configureProjectAgent(work);
		let observedDenial = false;
		const server = createServer(async (request, response) => {
			const body = await readJsonBody(request);
			const serialized = JSON.stringify(messages(body));
			if (toolResultCount(body) === 0)
				return toolCall({
					response,
					name: "subagent",
					args: { agent: "worker", task: "MUST_REQUIRE_CONFIRMATION", cwd: work, agentScope: "project" },
					id: "unconfirmed-project-agent",
				});
			observedDenial = serialized.includes("non-UI callers must explicitly set confirmProjectAgents: false");
			return text(response, observedDenial ? "project confirmation denial observed" : "confirmation bypassed");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("local provider did not bind");
		const agentDir = configureAgentDir(work, address.port);
		const socket = `pi-guard-project-confirmation-${process.pid}`;
		const session = `pi-guard-project-confirmation-${process.pid}`;
		sessions.push({ socket, session });
		const command = [
			`cd ${shellQuote(work)} &&`,
			`PI_CODING_AGENT_DIR=${shellQuote(agentDir)}`,
			"pi --print --no-extensions",
			`-e ${shellQuote(join(process.cwd(), "extensions", "index.ts"))}`,
			"--model local/deterministic --tools subagent,subagent_message",
			shellQuote("PUBLIC_PROJECT_CONFIRMATION"),
		].join(" ");
		try {
			execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "sh"]);
			execFileSync("tmux", ["-L", socket, "set-option", "-t", session, "remain-on-exit", "on"]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "-l", command]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "Enter"]);
			await waitFor(() => (observedDenial ? true : undefined), "non-UI project-agent denial");
			expect(existsSync(join(work, ".pi", "orchestration"))).toBe(false);
		} finally {
			await closeProvider(server);
			rmSync(work, { recursive: true, force: true });
		}
	}, 20_000);

	it("loads only a permitted extension tool through its declared backing extension", async () => {
		const work = mkdtempSync(join(tmpdir(), "pi-guard-tool-isolation-"));
		const agentsDir = join(work, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "extension-worker.md"),
			"---\nname: extension-worker\ndescription: extension isolation worker\ntools: integration_marker\nmodel: local/deterministic\nprofile: builtin:worker\n---\nRun the extension isolation scenario.\n",
		);
		const requests: unknown[] = [];
		const server = createServer(async (request, response) => {
			const body = await readJsonBody(request);
			requests.push(body);
			const serialized = JSON.stringify(messages(body));
			if (toolNames(body).includes("subagent")) {
				if (toolResultCount(body) === 0)
					return toolCall({
						response,
						name: "subagent",
						args: {
							agent: "extension-worker",
							task: "CHILD_EXTENSION_ISOLATION",
							cwd: work,
							agentScope: "project",
							confirmProjectAgents: false,
						},
						id: "launch-extension-child",
					});
				return text(response, "parent waiting");
			}
			if (!serialized.includes("CHILD_EXTENSION_ISOLATION")) return text(response, "idle");
			if (toolResultCount(body) === 0)
				return toolCall({
					response,
					name: "integration_marker",
					args: { value: "isolated" },
					id: "permitted-extension-call",
				});
			return text(response, serialized.includes("marker:isolated") ? "extension isolation complete" : "marker failed");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("local provider did not bind");
		const agentDir = configureAgentDir(work, address.port);
		const globalExtensionDir = join(agentDir, "extensions");
		mkdirSync(globalExtensionDir, { recursive: true });
		writeFileSync(
			join(globalExtensionDir, "undeclared.ts"),
			"throw new Error('undeclared global extension loaded');\n",
		);
		expect(markerExtension).toBeTypeOf("function");
		const backing = join(process.cwd(), "tests", "fixtures", "marker-extension.ts");
		const socket = `pi-guard-tool-isolation-${process.pid}`;
		const session = `pi-guard-tool-isolation-${process.pid}`;
		sessions.push({ socket, session });
		const command = [
			`cd ${shellQuote(work)} &&`,
			`PI_CODING_AGENT_DIR=${shellQuote(agentDir)}`,
			`PI_SUBAGENT_TOOL_BACKING=${shellQuote(JSON.stringify({ integration_marker: backing }))}`,
			`PI_GUARD_ACTIVE_PROFILE=${shellQuote("builtin:worker")}`,
			"pi --no-extensions",
			`-e ${shellQuote(join(process.cwd(), "extensions", "index.ts"))}`,
			"--model local/deterministic --tools subagent,subagent_message",
			shellQuote("PUBLIC_EXTENSION_ISOLATION"),
		].join(" ");
		try {
			execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "sh"]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "-l", command]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "Enter"]);
			const completed = await waitFor(() => {
				const root = join(work, ".pi", "orchestration");
				if (!existsSync(root)) return undefined;
				for (const entry of readdirSync(root, { withFileTypes: true })) {
					const candidate = join(root, entry.name, "registry.json");
					if (!entry.isDirectory() || !existsSync(candidate)) continue;
					const child = loadRegistry(candidate).children[0];
					if (child?.state === "completed" && child.delivered) return child;
				}
				return undefined;
			}, "extension-backed child completion");
			expect(completed.result).toBe("extension isolation complete");
			expect(completed.loadoutSnapshot.backingExtensionPaths).toEqual([backing]);
			const childRequests = requests.filter((body) => toolNames(body).includes("integration_marker"));
			expect(childRequests.length).toBeGreaterThan(0);
			for (const body of childRequests) expect(toolNames(body)).toEqual(["integration_marker", "ask_question"]);
		} finally {
			await closeProvider(server);
			rmSync(work, { recursive: true, force: true });
		}
	}, 30_000);

	it("launches in a right-side balanced pane, enforces pi-guard, delivers completion, and writes an audited handoff", async () => {
		const work = mkdtempSync(join(tmpdir(), "pi-guard-public-"));
		mkdirSync(join(work, "src"), { recursive: true });
		configureProjectAgent(work);
		const requests: unknown[] = [];
		const server = createServer(async (request, response) => {
			try {
				const body = await readJsonBody(request);
				requests.push(body);
				const serialized = JSON.stringify(messages(body));
				const tools = toolNames(body);
				if (tools.includes("subagent")) {
					if (!serialized.includes("PUBLIC_SECURITY")) return text(response, "parent idle");
					if (toolResultCount(body) === 0)
						return toolCall({
							response,
							name: "subagent",
							args: {
								agent: "worker",
								task: "CHILD_SECURITY",
								cwd: work,
								writes: ["src/**"],
								agentScope: "project",
								confirmProjectAgents: false,
								runDir: ".pi/orchestration/public-security",
							},
							id: "parent-subagent",
						});
					return text(response, "parent waiting for child");
				}
				if (!serialized.includes("CHILD_SECURITY")) return text(response, "unexpected child scenario");
				const step = toolResultCount(body);
				if (step === 0)
					return toolCall({
						response,
						name: "write",
						args: { path: "src/allowed.txt", content: "allowed\n" },
						id: "allowed-write",
					});
				if (step === 1)
					return toolCall({
						response,
						name: "write",
						args: { path: "outside-write.txt", content: "blocked\n" },
						id: "blocked-write",
					});
				if (step === 2)
					return toolCall({
						response,
						name: "edit",
						args: { path: "outside-edit.txt", edits: [{ oldText: "x", newText: "y" }] },
						id: "blocked-edit",
					});
				if (step === 3)
					return toolCall({ response, name: "bash", args: { command: "cat outside-bash.txt" }, id: "blocked-bash" });
				if (step === 4)
					return toolCall({
						response,
						name: "bash",
						args: { command: "printf blocked > outside-redirection.txt" },
						id: "blocked-redirection",
					});
				if (step === 5)
					return toolCall({
						response,
						name: "subagent",
						args: { agent: "worker", task: "NESTED_CHILD_MUST_NOT_START" },
						id: "nested-delegation-attempt",
					});
				await new Promise((resolve) => setTimeout(resolve, 500));
				return text(response, "security scenario complete");
			} catch (error) {
				response.writeHead(500, { "content-type": "text/plain" });
				response.end(String(error));
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("local provider did not bind");
		const agentDir = configureAgentDir(work, address.port);
		const socket = `pi-guard-public-${process.pid}`;
		const session = `pi-guard-public-${process.pid}`;
		sessions.push({ socket, session });
		const extension = join(process.cwd(), "extensions", "index.ts");
		const command = [
			`cd ${shellQuote(work)} &&`,
			"env -u PI_GUARD_ACTIVE_PROFILE",
			`PI_CODING_AGENT_DIR=${shellQuote(agentDir)}`,
			`OPENAI_API_KEY=${shellQuote("local")}`,
			`OPENAI_BASE_URL=${shellQuote(`http://127.0.0.1:${address.port}/v1`)}`,
			"pi --no-extensions",
			`-e ${shellQuote(extension)}`,
			"--model local/deterministic",
			"--tools subagent,subagent_message",
			shellQuote("PUBLIC_SECURITY"),
		].join(" ");
		let passed = false;
		try {
			execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "sh"]);
			execFileSync("tmux", ["-L", socket, "set-option", "-t", session, "remain-on-exit", "on"]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "-l", command]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "Enter"]);
			const registryFile = await waitFor(() => {
				const root = join(work, ".pi", "orchestration");
				if (!existsSync(root)) return undefined;
				for (const entry of readdirSync(root, { withFileTypes: true })) {
					if (!entry.isDirectory() || entry.name === "public-security") continue;
					const candidate = join(root, entry.name, "registry.json");
					if (existsSync(candidate)) return candidate;
				}
				return undefined;
			}, "public registry");
			const launched = await waitFor(() => {
				const child = loadRegistry(registryFile).children[0];
				return child?.paneId ? child : undefined;
			}, "live launched child");
			const focusedPane = execFileSync("tmux", ["-L", socket, "display-message", "-p", "-t", session, "#{pane_id}"], {
				encoding: "utf8",
			}).trim();
			expect(focusedPane).not.toBe(launched.paneId);
			await waitFor(() => {
				const lines = execFileSync(
					"tmux",
					["-L", socket, "list-panes", "-t", session, "-F", "#{pane_id}:#{pane_left}:#{pane_width}"],
					{ encoding: "utf8" },
				)
					.trim()
					.split("\n");
				const parent = lines.find((line) => line.startsWith(`${focusedPane}:`))?.split(":");
				const child = lines.find((line) => line.startsWith(`${launched.paneId}:`))?.split(":");
				if (!parent?.[1] || !parent[2] || !child?.[1] || !child[2]) return undefined;
				const parentLeft = Number(parent[1]);
				const parentWidth = Number(parent[2]);
				const childLeft = Number(child[1]);
				const childWidth = Number(child[2]);
				return childLeft > parentLeft && Math.abs(parentWidth - childWidth) <= 1 ? true : undefined;
			}, "right-side evenly balanced child pane");
			expect(launched.loadoutSnapshot.profile).toBe("builtin:worker");
			const completed = await waitFor(
				() => {
					const registry = loadRegistry(registryFile);
					const child = registry.children[0];
					return child?.state === "completed" && child.delivered === true && child.handoffPath ? child : undefined;
				},
				"delivered child",
				25_000,
			);
			expect(readFileSync(join(work, "src", "allowed.txt"), "utf8")).toBe("allowed\n");
			for (const file of ["outside-write.txt", "outside-edit.txt", "outside-bash.txt", "outside-redirection.txt"])
				expect(existsSync(join(work, file)), file).toBe(false);
			const terminal = parseOrThrow(
				TerminalSignalSchema,
				JSON.parse(readFileSync(`${completed.loadoutPath}.terminal.json`, "utf8")),
				"public child terminal",
			);
			expect(terminal.permissionBlocks?.length).toBeGreaterThanOrEqual(4);
			expect(terminal.model).toBe("deterministic");
			expect(terminal.usage?.totalTokens).toBeGreaterThan(0);
			const childPane = launched.paneId;
			if (!childPane) throw new Error("launched child omitted pane id");
			await waitFor(() => {
				const panes = execFileSync("tmux", ["-L", socket, "list-panes", "-t", session, "-F", "#{pane_id}"], {
					encoding: "utf8",
				});
				return panes.split("\n").includes(childPane) ? undefined : true;
			}, "natural child pane cleanup");
			const childRequests = requests.filter(
				(body) => JSON.stringify(messages(body)).includes("CHILD_SECURITY") && !toolNames(body).includes("subagent"),
			);
			expect(childRequests.length).toBeGreaterThan(0);
			expect(JSON.stringify(childRequests)).toMatch(/nested-delegation-attempt.*(not found|unknown|unavailable)/i);
			expect(loadRegistry(registryFile).children).toHaveLength(1);
			for (const childRequest of childRequests) {
				const tools = toolNames(childRequest);
				expect(tools).toContain("ask_question");
				expect(tools).not.toContain("subagent");
				expect(tools).not.toContain("subagent_message");
			}
			const handoffPath = completed.handoffPath;
			if (!handoffPath) throw new Error("delivered child omitted handoff path");
			const handoff = readFileSync(handoffPath, "utf8");
			expect(handoff).toContain("security scenario complete");
			expect(handoff).toContain("src/allowed.txt");
			expect(handoff).toContain("Pi-guard permission blocks");
			expect(requests.length).toBeGreaterThan(5);
			passed = true;
		} catch (error) {
			let panes = "tmux session unavailable";
			try {
				const paneIds = execFileSync("tmux", ["-L", socket, "list-panes", "-t", session, "-F", "#{pane_id}"], {
					encoding: "utf8",
				})
					.trim()
					.split("\n")
					.filter(Boolean);
				panes = paneIds
					.map((paneId) => {
						const output = execFileSync("tmux", ["-L", socket, "capture-pane", "-p", "-S", "-200", "-t", paneId], {
							encoding: "utf8",
						});
						return `${paneId}:\n${output}`;
					})
					.join("\n");
			} catch {
				// Preserve the original failure.
			}
			const root = join(work, ".pi", "orchestration");
			const artifacts = existsSync(root) ? readdirSync(root, { recursive: true }).join("\n") : "none";
			throw new Error(`${String(error)}\nparent pane:\n${panes}\nartifacts:\n${artifacts}\nwork: ${work}`);
		} finally {
			await closeProvider(server);
			if (passed) rmSync(work, { recursive: true, force: true });
		}
	}, 35_000);

	it("reattaches after parent /reload and delivers sequential resumed questions without duplicates", async () => {
		const work = mkdtempSync(join(tmpdir(), "pi-guard-question-"));
		configureProjectAgent(work);
		const answeredIds: Array<Question["questionId"]> = [];
		let unscopedReplySent = false;
		let unscopedReplyRejected = false;
		let staleReplySent = false;
		let staleReplyRejected = false;
		let resumeRequested = false;
		const providerRequests: unknown[] = [];
		const server = createServer(async (request, response) => {
			try {
				const body = await readJsonBody(request);
				providerRequests.push(body);
				const serialized = JSON.stringify(messages(body));
				const tools = toolNames(body);
				if (tools.includes("subagent")) {
					if (!serialized.includes("PUBLIC_QUESTION")) return text(response, "parent idle");
					const questionIds = [
						...serialized.matchAll(
							new RegExp(`${QUESTION_REPLY_INSTRUCTION}(${QUESTION_ID_PATTERN.slice(1, -1)})`, "g"),
						),
					];
					const questionId = questionIds.at(-1)?.[1];
					if (questionId && !answeredIds.includes(questionId)) {
						const match = serialized.match(/worker-1-[a-f0-9]+/);
						if (!match) throw new Error("question notification omitted persistent child name");
						if (answeredIds.length === 1 && !staleReplySent) {
							staleReplySent = true;
							return toolCall({
								response,
								name: "subagent_message",
								args: { name: match[0], message: "STALE_ANSWER_MUST_NOT_REACH_CHILD", questionId: answeredIds[0] },
								id: "stale-answer",
							});
						}
						if (staleReplySent) staleReplyRejected = serialized.includes(QUESTION_ERRORS.stale);
						if (answeredIds.length === 2 && !unscopedReplySent) {
							unscopedReplySent = true;
							return toolCall({
								response,
								name: "subagent_message",
								args: { name: match[0], message: "UNSCOPED_ANSWER_MUST_NOT_REACH_CHILD" },
								id: "unscoped-answer",
							});
						}
						if (unscopedReplySent) unscopedReplyRejected = serialized.includes(QUESTION_ERRORS.idRequired);
						await new Promise((resolve) => setTimeout(resolve, 400));
						answeredIds.push(questionId);
						return toolCall({
							response,
							name: "subagent_message",
							args: { name: match[0], message: `approved answer ${answeredIds.length}`, questionId },
							id: `answer-question-${answeredIds.length}`,
						});
					}
					if (serialized.includes("RESUME_AFTER_PARENT_RELOAD") && !resumeRequested) {
						const match = serialized.match(/worker-1-[a-f0-9]+/);
						if (!match) throw new Error("completion omitted persistent child name");
						resumeRequested = true;
						return toolCall({
							response,
							name: "subagent_message",
							args: { name: match[0], message: "CHILD_QUESTION_RESUME" },
							id: "resume-question-child",
						});
					}
					if (serialized.includes("question scenario complete") && !resumeRequested)
						return text(response, "parent ready for reload");
					if (toolResultCount(body) === 0)
						return toolCall({
							response,
							name: "subagent",
							args: {
								agent: "worker",
								task: "CHILD_QUESTION",
								cwd: work,
								writes: ["src/**"],
								agentScope: "project",
								confirmProjectAgents: false,
								runDir: ".pi/orchestration/public-question",
							},
							id: "launch-question-child",
						});
					return text(response, "parent waiting");
				}
				if (!serialized.includes("CHILD_QUESTION")) return text(response, "unexpected child scenario");
				const resumed = serialized.includes("CHILD_QUESTION_RESUME");
				if (toolResultCount(body) < (resumed ? 3 : 2))
					return toolCall({
						response,
						name: "ask_question",
						args: { question: "continue integration?" },
						id: `child-question-${toolResultCount(body)}`,
					});
				if (
					!serialized.includes("approved answer 1") ||
					!serialized.includes("approved answer 2") ||
					serialized.includes("STALE_ANSWER_MUST_NOT_REACH_CHILD") ||
					serialized.includes("UNSCOPED_ANSWER_MUST_NOT_REACH_CHILD")
				)
					return text(response, "wrong answer");
				if (resumed && !serialized.includes("approved answer 3")) return text(response, "wrong resumed answer");
				return text(response, resumed ? "resumed question scenario complete" : "question scenario complete");
			} catch (error) {
				response.writeHead(500, { "content-type": "text/plain" });
				response.end(String(error));
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("local provider did not bind");
		const agentDir = configureAgentDir(work, address.port);
		const socket = `pi-guard-question-${process.pid}`;
		const session = `pi-guard-question-${process.pid}`;
		const reloadMarkerFile = join(work, "parent-reload-events.txt");
		expect(reloadMarker).toBeTypeOf("function");
		sessions.push({ socket, session });
		const extension = join(process.cwd(), "extensions", "index.ts");
		const command = [
			`cd ${shellQuote(work)} &&`,
			`PI_CODING_AGENT_DIR=${shellQuote(agentDir)}`,
			`PI_GUARD_ACTIVE_PROFILE=${shellQuote("builtin:worker")}`,
			`PI_GUARD_TEST_RELOAD_MARKER=${shellQuote(reloadMarkerFile)}`,
			"pi --no-extensions",
			`-e ${shellQuote(extension)}`,
			"--model local/deterministic --tools subagent,subagent_message",
			`-e ${shellQuote(join(process.cwd(), "tests", "fixtures", "reload-marker.ts"))}`,
			shellQuote("PUBLIC_QUESTION"),
		].join(" ");
		let passed = false;
		try {
			execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "sh"]);
			execFileSync("tmux", ["-L", socket, "set-option", "-t", session, "remain-on-exit", "on"]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "-l", command]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "Enter"]);
			const registryFile = await waitFor(() => {
				const root = join(work, ".pi", "orchestration");
				if (!existsSync(root)) return undefined;
				for (const entry of readdirSync(root, { withFileTypes: true })) {
					const candidate = join(root, entry.name, "registry.json");
					if (entry.isDirectory() && existsSync(candidate)) return candidate;
				}
				return undefined;
			}, "question registry");
			await waitFor(() => {
				const child = loadRegistry(registryFile).children[0];
				return child?.state === CHILD_STATES.completed && child.delivered ? child : undefined;
			}, "initial question attempt completion");
			await waitFor(() => {
				const pane = execFileSync("tmux", ["-L", socket, "capture-pane", "-p", "-S", "-100", "-t", session], {
					encoding: "utf8",
				});
				return pane.includes("parent ready for reload") ? true : undefined;
			}, "parent finished its initial completion follow-up");
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "-l", "/reload"]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "Enter"]);
			await waitFor(() => {
				const events = readFileSync(reloadMarkerFile, "utf8");
				return events === "start\nshutdown\nstart\n" ? true : undefined;
			}, "old parent shutdown and fresh extension session start");
			await waitFor(() => {
				const pane = execFileSync("tmux", ["-L", socket, "capture-pane", "-p", "-S", "-100", "-t", session], {
					encoding: "utf8",
				});
				return pane.includes("Reloaded keybindings") ? true : undefined;
			}, "reload finished and parent editor restored");
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "-l", "RESUME_AFTER_PARENT_RELOAD"]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "Enter"]);
			const completed = await waitFor(
				() => {
					const child = loadRegistry(registryFile).children[0];
					return child?.state === CHILD_STATES.completed &&
						child.delivered &&
						child.handoffPath &&
						child.result?.includes("resumed question scenario complete")
						? child
						: undefined;
				},
				"answered and resumed child completion",
				25_000,
			);
			expect(answeredIds).toHaveLength(3);
			expect(new Set(answeredIds).size).toBe(3);
			expect(staleReplyRejected).toBe(true);
			expect(unscopedReplyRejected).toBe(true);
			// Repeated subagent_message calls (resume, rejected unscoped reply,
			// explicit answer) must not install duplicate run watchers or sends.
			await waitFor(() => {
				const parentRequest = [...providerRequests]
					.reverse()
					.find(
						(body) =>
							toolNames(body).includes("subagent") &&
							JSON.stringify(messages(body)).includes("resumed question scenario complete"),
					);
				if (!parentRequest) return undefined;
				const transcript = JSON.stringify(messages(parentRequest));
				expect(transcript.split(QUESTION_REPLY_INSTRUCTION)).toHaveLength(answeredIds.length + 1);
				return true;
			}, "parent transcript with one notification per question");
			expect(completed.questionAnswered).toBe(true);
			const question = parseOrThrow(
				QuestionSchema,
				JSON.parse(readFileSync(questionPointerPath({ loadoutPath: completed.loadoutPath }), "utf8")),
				"latest question",
			);
			expect(question.answered).toBe(true);
			expect(question.questionId).toBe(answeredIds[2]);
			const historyDirectory = `${completed.loadoutPath}.questions`;
			const history = readdirSync(historyDirectory).filter((file) => file.endsWith(".json"));
			expect(history).toHaveLength(3);
			const attempts: Array<Question["attemptId"]> = [];
			for (const [index, questionId] of answeredIds.entries()) {
				const recordFile = questionRecordPath({ loadoutPath: completed.loadoutPath, questionId });
				const record = parseOrThrow(
					QuestionSchema,
					JSON.parse(readFileSync(recordFile, "utf8")),
					"historical question",
				);
				const reply = parseOrThrow(
					ReplySchema,
					JSON.parse(readFileSync(`${recordFile}.reply`, "utf8")),
					"historical reply",
				);
				attempts.push(record.attemptId);
				expect(record).toMatchObject({ questionId, answered: true });
				expect(reply).toMatchObject({
					attemptId: record.attemptId,
					questionId,
					answer: `approved answer ${index + 1}`,
				});
			}
			expect(attempts[0]).toBe(attempts[1]);
			expect(attempts[2]).toBe(completed.attemptId);
			expect(attempts[0]).not.toBe(attempts[2]);
			const handoffPath = completed.handoffPath;
			if (!handoffPath) throw new Error("question child omitted handoff");
			expect(readFileSync(handoffPath, "utf8")).toContain("question scenario complete");
			passed = true;
		} catch (error) {
			let panes = "unavailable";
			try {
				panes = execFileSync(
					"tmux",
					["-L", socket, "list-panes", "-a", "-F", "#{pane_id} #{pane_dead} #{pane_current_command}"],
					{ encoding: "utf8" },
				);
			} catch {
				// Preserve original failure.
			}
			throw new Error(
				`${String(error)}\npanes:\n${panes}\nrequests:\n${JSON.stringify(providerRequests, null, 2)}\nwork: ${work}`,
			);
		} finally {
			await closeProvider(server);
			if (passed) rmSync(work, { recursive: true, force: true });
		}
	}, 35_000);

	it.each(["cancel", "pane loss"])(
		"closes a parked question after %s and safely resumes with a new question",
		async (operation) => {
			const work = mkdtempSync(join(tmpdir(), "pi-guard-closed-question-"));
			configureProjectAgent(work);
			const socket = `pi-guard-closed-question-${operation.replaceAll(" ", "-")}-${process.pid}`;
			const session = socket;
			let registryFile: string | undefined;
			let parkedQuestion: Question | undefined;
			let failureSnapshot: ReturnType<typeof captureQuestionAttempt> | undefined;
			let terminated = false;
			let oldAnswerSent = false;
			let resumed = false;
			let answered = false;
			const server = createServer(async (request, response) => {
				try {
					const body = await readJsonBody(request);
					const serialized = JSON.stringify(messages(body));
					if (toolNames(body).includes("subagent")) {
						if (toolResultCount(body) === 0)
							return toolCall({
								response,
								name: "subagent",
								args: {
									agent: "worker",
									task: "CHILD_CLOSED_QUESTION",
									cwd: work,
									agentScope: "project",
									confirmProjectAgents: false,
								},
								id: "launch-parked-child",
							});
						const file = await waitFor(() => registryFile, "parked child registry");
						const child = loadRegistry(file).children[0];
						if (!child) throw new Error("parked child disappeared");
						if (!terminated && serialized.includes(QUESTION_REPLY_INSTRUCTION)) {
							parkedQuestion = parseOrThrow(
								QuestionSchema,
								JSON.parse(readFileSync(questionPointerPath({ loadoutPath: child.loadoutPath }), "utf8")),
								"parked question",
							);
							if (!child.paneId) throw new Error("parked child has no pane");
							terminated = true;
							if (operation === "cancel")
								execFileSync("tmux", ["-L", socket, "send-keys", "-t", child.paneId, "Escape"]);
							else execFileSync("tmux", ["-L", socket, "kill-pane", "-t", child.paneId]);
							return text(response, "parent awaiting terminal failure");
						}
						if (child.state === CHILD_STATES.failed && child.delivered && !oldAnswerSent) {
							if (!parkedQuestion) throw new Error("failed child omitted its parked question");
							failureSnapshot = captureQuestionAttempt({ child, questionId: parkedQuestion.questionId });
							oldAnswerSent = true;
							return toolCall({
								response,
								name: "subagent_message",
								args: {
									name: child.name,
									message: "must not answer a closed attempt",
									questionId: parkedQuestion.questionId,
								},
								id: "answer-closed-question",
							});
						}
						if (oldAnswerSent && !resumed) {
							if (!parkedQuestion || !failureSnapshot) throw new Error("missing closed-attempt snapshot");
							expect(serialized).toContain(QUESTION_ERRORS.stale);
							expect(captureQuestionAttempt({ child, questionId: parkedQuestion.questionId })).toEqual(failureSnapshot);
							resumed = true;
							return toolCall({
								response,
								name: "subagent_message",
								args: { name: child.name, message: "RESUME_CLOSED_QUESTION" },
								id: "resume-closed-child",
							});
						}
						if (resumed && !answered && child.state === CHILD_STATES.waiting) {
							const question = parseOrThrow(
								QuestionSchema,
								JSON.parse(readFileSync(questionPointerPath({ loadoutPath: child.loadoutPath }), "utf8")),
								"resumed question",
							);
							if (!parkedQuestion) throw new Error("missing original parked question");
							expect(question.attemptId).not.toBe(parkedQuestion.attemptId);
							answered = true;
							return toolCall({
								response,
								name: "subagent_message",
								args: { name: child.name, message: "resume approved", questionId: question.questionId },
								id: "answer-resumed-question",
							});
						}
						return text(response, "parent waiting");
					}
					if (!serialized.includes("CHILD_CLOSED_QUESTION")) throw new Error("unexpected child request");
					if (serialized.includes("resume approved")) return text(response, "closed question resumed successfully");
					return toolCall({
						response,
						name: "ask_question",
						args: { question: "May I continue?" },
						id: `parked-question-${toolResultCount(body)}`,
					});
				} catch (error) {
					response.writeHead(500, { "content-type": "text/plain" });
					response.end(String(error));
				}
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("local provider did not bind");
			const agentDir = configureAgentDir(work, address.port);
			sessions.push({ socket, session });
			const command = [
				`cd ${shellQuote(work)} &&`,
				`PI_CODING_AGENT_DIR=${shellQuote(agentDir)}`,
				`PI_GUARD_ACTIVE_PROFILE=${shellQuote("builtin:worker")}`,
				"pi --no-extensions",
				`-e ${shellQuote(join(process.cwd(), "extensions", "index.ts"))}`,
				"--model local/deterministic --tools subagent,subagent_message",
				shellQuote("PUBLIC_CLOSED_QUESTION"),
			].join(" ");
			try {
				execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "sh"]);
				execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "-l", command]);
				execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "Enter"]);
				registryFile = await waitFor(() => {
					const root = join(work, ".pi", "orchestration");
					if (!existsSync(root)) return undefined;
					for (const entry of readdirSync(root, { withFileTypes: true })) {
						const candidate = join(root, entry.name, "registry.json");
						if (entry.isDirectory() && existsSync(candidate)) return candidate;
					}
					return undefined;
				}, "closed-question registry");
				const file = registryFile;
				const completed = await waitFor(
					() => {
						const child = loadRegistry(file).children[0];
						return child?.state === CHILD_STATES.completed &&
							child.delivered &&
							child.result?.includes("closed question resumed successfully")
							? child
							: undefined;
					},
					"cancelled child warm resume",
					25_000,
				);
				expect(answered).toBe(true);
				if (!parkedQuestion || !failureSnapshot) throw new Error("missing failed-attempt evidence");
				expect(completed.sessionId).toBe(failureSnapshot.child.sessionId);
				const oldRecordFile = questionRecordPath({
					loadoutPath: completed.loadoutPath,
					questionId: parkedQuestion.questionId,
				});
				expect(readFileSync(oldRecordFile, "utf8")).toBe(failureSnapshot.record);
				expect(existsSync(`${oldRecordFile}.reply`)).toBe(false);
			} finally {
				await closeProvider(server);
				rmSync(work, { recursive: true, force: true });
			}
		},
		35_000,
	);

	it("resumes a completed named child through subagent_message with its snapshotted loadout", async () => {
		const work = mkdtempSync(join(tmpdir(), "pi-guard-resume-"));
		configureProjectAgent(work);
		let persistentName: string | undefined;
		let runningMessageSent = false;
		let resumeRequested = false;
		let passed = false;
		const providerRequests: unknown[] = [];
		const server = createServer(async (request, response) => {
			try {
				const body = await readJsonBody(request);
				const serialized = JSON.stringify(messages(body));
				const tools = toolNames(body);
				if (serialized.includes("PUBLIC_RESUME") || serialized.includes("CHILD_RESUME")) providerRequests.push(body);
				if (tools.includes("subagent")) {
					if (!serialized.includes("PUBLIC_RESUME")) return text(response, "parent idle");
					if (!runningMessageSent && toolResultCount(body) > 0) {
						const launched = serialized.match(/worker-1-[a-f0-9]+/);
						if (launched) {
							persistentName = launched[0];
							runningMessageSent = true;
							return toolCall({
								response,
								name: "subagent_message",
								args: { name: launched[0], message: "RUNNING_GUIDANCE" },
								id: "steer-running-child",
							});
						}
					}
					if (serialized.includes("first completion") && !resumeRequested) {
						const match = serialized.match(/worker-1-[a-f0-9]+/);
						if (!match) throw new Error("completion omitted persistent child name");
						persistentName = match[0];
						resumeRequested = true;
						return toolCall({
							response,
							name: "subagent_message",
							args: { name: match[0], message: "CHILD_RESUME_SECOND" },
							id: "resume-child",
						});
					}
					if (toolResultCount(body) === 0)
						return toolCall({
							response,
							name: "subagent",
							args: {
								agent: "worker",
								task: "CHILD_RESUME_FIRST",
								cwd: work,
								writes: ["src/**"],
								agentScope: "project",
								confirmProjectAgents: false,
								runDir: ".pi/orchestration/public-resume",
							},
							id: "launch-resume-child",
						});
					return text(response, "parent waiting");
				}
				if (serialized.includes("CHILD_RESUME_SECOND")) return text(response, "second completion");
				if (serialized.includes("CHILD_RESUME_FIRST") && !serialized.includes("RUNNING_GUIDANCE")) {
					await new Promise((resolve) => setTimeout(resolve, 500));
					return text(response, "awaiting running guidance");
				}
				if (serialized.includes("CHILD_RESUME_FIRST")) return text(response, "first completion");
				return text(response, "unexpected child scenario");
			} catch (error) {
				response.writeHead(500, { "content-type": "text/plain" });
				response.end(String(error));
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("local provider did not bind");
		const agentDir = configureAgentDir(work, address.port);
		const socket = `pi-guard-resume-${process.pid}`;
		const session = `pi-guard-resume-${process.pid}`;
		sessions.push({ socket, session });
		const command = [
			`cd ${shellQuote(work)} &&`,
			`PI_CODING_AGENT_DIR=${shellQuote(agentDir)}`,
			`PI_GUARD_ACTIVE_PROFILE=${shellQuote("builtin:worker")}`,
			"pi --no-extensions",
			`-e ${shellQuote(join(process.cwd(), "extensions", "index.ts"))}`,
			"--model local/deterministic --tools subagent,subagent_message",
			shellQuote("PUBLIC_RESUME"),
		].join(" ");
		try {
			execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "sh"]);
			execFileSync("tmux", ["-L", socket, "set-option", "-t", session, "remain-on-exit", "on"]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "-l", command]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "Enter"]);
			const registryFile = await waitFor(() => {
				const root = join(work, ".pi", "orchestration");
				if (!existsSync(root)) return undefined;
				for (const entry of readdirSync(root, { withFileTypes: true })) {
					const candidate = join(root, entry.name, "registry.json");
					if (entry.isDirectory() && existsSync(candidate)) return candidate;
				}
				return undefined;
			}, "resume registry");
			const initial = await waitFor(() => loadRegistry(registryFile).children[0], "initial resume child");
			const originalSession = initial.sessionId;
			const originalAttempt = initial.attemptId;
			const resumed = await waitFor(
				() => {
					const child = loadRegistry(registryFile).children[0];
					return child?.result === "second completion" && child.delivered ? child : undefined;
				},
				"resumed completion",
				25_000,
			);
			expect(runningMessageSent).toBe(true);
			expect(resumeRequested).toBe(true);
			expect(resumed.name).toBe(persistentName);
			expect(resumed.sessionId).toBe(originalSession);
			expect(resumed.attemptId).not.toBe(originalAttempt);
			expect(resumed.loadoutSnapshot.profile).toBe("builtin:worker");
			expect(resumed.loadoutSnapshot.writes).toEqual(["src/**"]);
			passed = true;
		} catch (error) {
			let panes = "unavailable";
			try {
				panes = execFileSync(
					"tmux",
					["-L", socket, "list-panes", "-a", "-F", "#{pane_id} #{pane_dead} #{pane_current_command}"],
					{ encoding: "utf8" },
				);
			} catch {
				// Preserve original failure.
			}
			const root = join(work, ".pi", "orchestration");
			const registries = existsSync(root)
				? readdirSync(root, { recursive: true }).filter((entry) => String(entry).endsWith("registry.json"))
				: [];
			throw new Error(
				`${String(error)}\npanes:\n${panes}\nregistries: ${JSON.stringify(registries)}\nrequests:\n${JSON.stringify(providerRequests, null, 2)}\nwork: ${work}`,
			);
		} finally {
			await closeProvider(server);
			if (passed) rmSync(work, { recursive: true, force: true });
		}
	}, 35_000);

	it("keeps parallel panes evenly horizontal through staggered exits and advances a chain exactly once", async () => {
		const work = mkdtempSync(join(tmpdir(), "pi-guard-orchestration-"));
		configureProjectAgent(work);
		let chainRequested = false;
		const server = createServer(async (request, response) => {
			try {
				const body = await readJsonBody(request);
				const serialized = JSON.stringify(messages(body));
				if (toolNames(body).includes("subagent")) {
					if (!serialized.includes("PUBLIC_ORCHESTRATION")) return text(response, "parent idle");
					if (serialized.includes("parallel-a") && serialized.includes("parallel-b") && !chainRequested) {
						chainRequested = true;
						return toolCall({
							response,
							name: "subagent",
							args: {
								chain: [
									{ agent: "worker", task: "CHAIN_FIRST", cwd: work, writes: ["src/a/**"] },
									{ agent: "worker", task: "CHAIN_SECOND {previous}", cwd: work, writes: ["src/b/**"] },
								],
								agentScope: "project",
								confirmProjectAgents: false,
							},
							id: "launch-chain",
						});
					}
					if (toolResultCount(body) === 0)
						return toolCall({
							response,
							name: "subagent",
							args: {
								tasks: [
									{ agent: "worker", task: "PARALLEL_A", cwd: work, writes: ["src/a/**"] },
									{ agent: "worker", task: "PARALLEL_B", cwd: work, writes: ["src/b/**"] },
								],
								agentScope: "project",
								confirmProjectAgents: false,
							},
							id: "launch-parallel",
						});
					return text(response, "parent waiting");
				}
				if (serialized.includes("PARALLEL_A")) {
					await new Promise((resolve) => setTimeout(resolve, 2_000));
					return text(response, "parallel-a");
				}
				if (serialized.includes("PARALLEL_B")) {
					await new Promise((resolve) => setTimeout(resolve, 5_000));
					return text(response, "parallel-b");
				}
				if (serialized.includes("CHAIN_SECOND first-value")) return text(response, "chain-final");
				if (serialized.includes("CHAIN_FIRST")) return text(response, "first-value");
				return text(response, "unexpected child scenario");
			} catch (error) {
				response.writeHead(500, { "content-type": "text/plain" });
				response.end(String(error));
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("local provider did not bind");
		const agentDir = configureAgentDir(work, address.port);
		const socket = `pi-guard-orchestration-${process.pid}`;
		const session = `pi-guard-orchestration-${process.pid}`;
		sessions.push({ socket, session });
		const command = [
			`cd ${shellQuote(work)} &&`,
			`PI_CODING_AGENT_DIR=${shellQuote(agentDir)}`,
			`PI_GUARD_ACTIVE_PROFILE=${shellQuote("builtin:worker")}`,
			"pi --no-extensions",
			`-e ${shellQuote(join(process.cwd(), "extensions", "index.ts"))}`,
			"--model local/deterministic --tools subagent,subagent_message",
			shellQuote("PUBLIC_ORCHESTRATION"),
		].join(" ");
		try {
			execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "sh"]);
			execFileSync("tmux", ["-L", socket, "set-option", "-t", session, "remain-on-exit", "on"]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "-l", command]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "Enter"]);
			const activeParallel = await waitFor(() => {
				const root = join(work, ".pi", "orchestration");
				if (!existsSync(root)) return undefined;
				for (const entry of readdirSync(root, { withFileTypes: true })) {
					const candidate = join(root, entry.name, "registry.json");
					if (!entry.isDirectory() || !existsSync(candidate)) continue;
					const registry = loadRegistry(candidate);
					if (
						registry.children.length === 2 &&
						registry.children.every((child) => child.mode === "parallel" && child.paneId)
					)
						return registry;
				}
				return undefined;
			}, "active parallel panes");
			const firstParallelPane = activeParallel.children.find((child) => child.task === "PARALLEL_A")?.paneId;
			const secondParallelPane = activeParallel.children.find((child) => child.task === "PARALLEL_B")?.paneId;
			if (!firstParallelPane || !secondParallelPane) throw new Error("parallel children omitted pane IDs");
			await waitFor(() => {
				const rows = execFileSync(
					"tmux",
					["-L", socket, "list-panes", "-t", session, "-F", "#{pane_id}:#{pane_left}:#{pane_width}"],
					{ encoding: "utf8" },
				)
					.trim()
					.split("\n")
					.map((line) => line.split(":"));
				if (rows.length !== 3 || rows.some((row) => !row[1] || !row[2])) return undefined;
				const widths = rows.map((row) => Number(row[2]));
				const parent = rows.find((row) => row[0] !== firstParallelPane && row[0] !== secondParallelPane);
				const children = rows.filter((row) => row[0] === firstParallelPane || row[0] === secondParallelPane);
				if (!parent?.[1] || children.some((row) => Number(row[1]) <= Number(parent[1]))) return undefined;
				return Math.max(...widths) - Math.min(...widths) <= 1 ? true : undefined;
			}, "even-horizontal parallel layout");
			await waitFor(
				() => {
					const rows = execFileSync(
						"tmux",
						["-L", socket, "list-panes", "-t", session, "-F", "#{pane_id}:#{pane_width}"],
						{ encoding: "utf8" },
					)
						.trim()
						.split("\n")
						.map((line) => line.split(":"));
					if (rows.some((row) => row[0] === firstParallelPane) || !rows.some((row) => row[0] === secondParallelPane))
						return undefined;
					if (rows.length !== 2 || rows.some((row) => !row[1])) return undefined;
					return Math.abs(Number(rows[0]?.[1]) - Number(rows[1]?.[1])) <= 1 ? true : undefined;
				},
				"rebalance after staggered child exit",
				10_000,
			);
			const registries = await waitFor(
				() => {
					const root = join(work, ".pi", "orchestration");
					if (!existsSync(root)) return undefined;
					const files = readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
						const candidate = join(root, entry.name, "registry.json");
						return entry.isDirectory() && existsSync(candidate) ? [candidate] : [];
					});
					if (files.length < 2) return undefined;
					const parsed = files.map(loadRegistry);
					const complete = parsed.every(
						(registry) => registry.children.length === 2 && registry.children.every((child) => child.delivered),
					);
					return complete ? parsed : undefined;
				},
				"parallel and chain delivery",
				25_000,
			);
			const parallel = registries.find((registry) => registry.children.some((child) => child.mode === "parallel"));
			const chain = registries.find((registry) => registry.chain !== undefined);
			if (!parallel || !chain?.chain) throw new Error("missing parallel or chain registry");
			expect(parallel.children).toHaveLength(2);
			expect(new Set(parallel.children.map((child) => child.name)).size).toBe(2);
			expect(parallel.children.map((child) => child.loadoutSnapshot.writes)).toEqual([["src/a/**"], ["src/b/**"]]);
			expect(chain.children).toHaveLength(2);
			expect(chain.chain.progressed).toEqual([true, true]);
			expect(chain.children[1]?.task).toBe("CHAIN_SECOND first-value");
			expect(chain.children[1]?.result).toBe("chain-final");
		} finally {
			await closeProvider(server);
			rmSync(work, { recursive: true, force: true });
		}
	}, 35_000);

	it("keeps an earlier parallel child monitored when a later pane fails to launch", async () => {
		const work = mkdtempSync(join(tmpdir(), "pi-guard-partial-launch-"));
		configureProjectAgent(work);
		let parentObservedLaunchFailure = false;
		const server = createServer(async (request, response) => {
			const body = await readJsonBody(request);
			const serialized = JSON.stringify(messages(body));
			if (toolNames(body).includes("subagent")) {
				if (toolResultCount(body) === 0) {
					execFileSync("tmux", ["-L", socket, "resize-window", "-t", session, "-x", "4", "-y", "24"]);
					return toolCall({
						response,
						name: "subagent",
						args: {
							tasks: [
								{ agent: "worker", task: "PARTIAL_FIRST", cwd: work },
								{ agent: "worker", task: "PARTIAL_MUST_FAIL", cwd: join(work, "missing-cwd") },
							],
							agentScope: "project",
							confirmProjectAgents: false,
						},
						id: "partial-parallel-launch",
					});
				}
				execFileSync("tmux", ["-L", socket, "resize-window", "-t", session, "-x", "80", "-y", "24"]);
				parentObservedLaunchFailure = /split-window|working directory|No such file/i.test(serialized);
				return text(response, "parent handled partial launch");
			}
			if (serialized.includes("PARTIAL_FIRST")) {
				await new Promise((resolve) => setTimeout(resolve, 300));
				return text(response, "first partial child completed");
			}
			return text(response, "unexpected partial child");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("local provider did not bind");
		const agentDir = configureAgentDir(work, address.port);
		const socket = `pi-guard-partial-launch-${process.pid}`;
		const session = `pi-guard-partial-launch-${process.pid}`;
		sessions.push({ socket, session });
		const command = [
			`cd ${shellQuote(work)} &&`,
			`PI_CODING_AGENT_DIR=${shellQuote(agentDir)}`,
			`PI_GUARD_ACTIVE_PROFILE=${shellQuote("builtin:worker")}`,
			"pi --no-extensions",
			`-e ${shellQuote(join(process.cwd(), "extensions", "index.ts"))}`,
			"--model local/deterministic --tools subagent,subagent_message",
			shellQuote("PUBLIC_PARTIAL_LAUNCH"),
		].join(" ");
		try {
			execFileSync("tmux", [
				"-L",
				socket,
				"-f",
				"/dev/null",
				"new-session",
				"-d",
				"-x",
				"80",
				"-y",
				"24",
				"-s",
				session,
				"sh",
			]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "-l", command]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "Enter"]);
			const registry = await waitFor(
				() => {
					const root = join(work, ".pi", "orchestration");
					if (!existsSync(root)) return undefined;
					for (const entry of readdirSync(root, { withFileTypes: true })) {
						const candidate = join(root, entry.name, "registry.json");
						if (!entry.isDirectory() || !existsSync(candidate)) continue;
						const current = loadRegistry(candidate);
						if (current.children.length === 2 && current.children.every((child) => child.delivered)) return current;
					}
					return undefined;
				},
				"monitored partial child",
				25_000,
			);
			expect(parentObservedLaunchFailure).toBe(true);
			expect(registry.children).toHaveLength(2);
			expect(registry.children[0]?.result).toBe("first partial child completed");
			expect(registry.children[0]?.handoffPath).toBeTruthy();
			expect(registry.children[1]?.state).toBe("failed");
			expect(registry.children[1]?.failure).toContain("Child pane launch failed");
		} finally {
			await closeProvider(server);
			rmSync(work, { recursive: true, force: true });
		}
	}, 35_000);

	it("preserves a child-runtime failure reason in a schema-valid terminal outcome", async () => {
		const work = mkdtempSync(join(tmpdir(), "pi-guard-runtime-failure-"));
		configureProjectAgent(work);
		const server = createServer(async (request, response) => {
			const body = await readJsonBody(request);
			const serialized = JSON.stringify(messages(body));
			if (toolNames(body).includes("subagent")) {
				if (toolResultCount(body) === 0)
					return toolCall({
						response,
						name: "subagent",
						args: {
							agent: "worker",
							task: "CHILD_RUNTIME_FAILURE",
							cwd: work,
							agentScope: "project",
							confirmProjectAgents: false,
						},
						id: "launch-runtime-failure",
					});
				return text(response, "parent observed runtime failure");
			}
			if (serialized.includes("CHILD_RUNTIME_FAILURE")) {
				await new Promise<void>((resolve) => request.once("close", resolve));
				return;
			}
			return text(response, "idle");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("local provider did not bind");
		const agentDir = configureAgentDir(work, address.port);
		configureInstalledPackages(agentDir);
		const socket = `pi-guard-runtime-failure-${process.pid}`;
		const session = `pi-guard-runtime-failure-${process.pid}`;
		sessions.push({ socket, session });
		const command = [
			`cd ${shellQuote(work)} &&`,
			`PI_CODING_AGENT_DIR=${shellQuote(agentDir)}`,
			`PI_GUARD_ACTIVE_PROFILE=${shellQuote("builtin:worker")}`,
			"pi --model local/deterministic --tools subagent,subagent_message",
			shellQuote("PUBLIC_RUNTIME_FAILURE"),
		].join(" ");
		try {
			execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "sh"]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "-l", command]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "Enter"]);
			const located = await waitFor(() => {
				const root = join(work, ".pi", "orchestration");
				if (!existsSync(root)) return undefined;
				for (const entry of readdirSync(root, { withFileTypes: true })) {
					const candidate = join(root, entry.name, "registry.json");
					if (!entry.isDirectory() || !existsSync(candidate)) continue;
					const child = loadRegistry(candidate).children[0];
					if (child?.paneId) return { file: candidate, child };
				}
				return undefined;
			}, "live runtime-failure child");
			writeFileSync(`${located.child.loadoutPath}.message-malformed.json`, "{not-json");
			const failed = await waitFor(() => {
				const child = loadRegistry(located.file).children[0];
				return child?.state === "failed" && child.delivered ? child : undefined;
			}, "runtime failure delivery");
			expect(failed.failure).toContain("Invalid steering message");
			expect(failed.failure).not.toContain("Invalid terminal sidecar");
			const terminal = parseOrThrow(
				TerminalSignalSchema,
				JSON.parse(readFileSync(`${failed.loadoutPath}.terminal.json`, "utf8")),
				"runtime failure terminal",
			);
			expect(terminal.failure).toContain("Invalid steering message");
			expect(terminal.usage).toBeUndefined();
		} finally {
			await closeProvider(server);
			rmSync(work, { recursive: true, force: true });
		}
	}, 35_000);

	it("stops a chain and delivers one failure when a real child pane disappears", async () => {
		const work = mkdtempSync(join(tmpdir(), "pi-guard-chain-failure-"));
		configureProjectAgent(work);
		const server = createServer(async (request, response) => {
			try {
				const body = await readJsonBody(request);
				const serialized = JSON.stringify(messages(body));
				if (toolNames(body).includes("subagent")) {
					if (toolResultCount(body) === 0)
						return toolCall({
							response,
							name: "subagent",
							args: {
								chain: [
									{ agent: "worker", task: "CHAIN_PANE_FAILURE", cwd: work },
									{ agent: "worker", task: "MUST_NOT_LAUNCH", cwd: work },
								],
								agentScope: "project",
								confirmProjectAgents: false,
							},
							id: "launch-failing-chain",
						});
					return text(response, "parent observed chain failure");
				}
				if (serialized.includes("CHAIN_PANE_FAILURE"))
					return toolCall({ response, name: "bash", args: { command: "sleep 20" }, id: "long-running-child" });
				if (serialized.includes("MUST_NOT_LAUNCH")) return text(response, "unexpected second chain step");
				return text(response, "idle");
			} catch (error) {
				response.writeHead(500, { "content-type": "text/plain" });
				response.end(String(error));
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("local provider did not bind");
		const agentDir = configureAgentDir(work, address.port);
		const socket = `pi-guard-chain-failure-${process.pid}`;
		const session = `pi-guard-chain-failure-${process.pid}`;
		sessions.push({ socket, session });
		const command = [
			`cd ${shellQuote(work)} &&`,
			`PI_CODING_AGENT_DIR=${shellQuote(agentDir)}`,
			`PI_GUARD_ACTIVE_PROFILE=${shellQuote("builtin:worker")}`,
			"pi --no-extensions",
			`-e ${shellQuote(join(process.cwd(), "extensions", "index.ts"))}`,
			"--model local/deterministic --tools subagent,subagent_message",
			shellQuote("PUBLIC_CHAIN_FAILURE"),
		].join(" ");
		try {
			execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "sh"]);
			execFileSync("tmux", ["-L", socket, "set-option", "-t", session, "remain-on-exit", "on"]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "-l", command]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "Enter"]);
			const registryFile = await waitFor(() => {
				const root = join(work, ".pi", "orchestration");
				if (!existsSync(root)) return undefined;
				for (const entry of readdirSync(root, { withFileTypes: true })) {
					const candidate = join(root, entry.name, "registry.json");
					if (entry.isDirectory() && existsSync(candidate)) return candidate;
				}
				return undefined;
			}, "failing chain registry");
			const running = await waitFor(() => {
				const child = loadRegistry(registryFile).children[0];
				return child?.paneId && child.state !== "failed" ? child : undefined;
			}, "running chain child");
			const failingPane = running.paneId;
			if (!failingPane) throw new Error("running chain child omitted pane id");
			execFileSync("tmux", ["-L", socket, "kill-pane", "-t", failingPane]);
			const failed = await waitFor(() => {
				const registry = loadRegistry(registryFile);
				const child = registry.children[0];
				return child?.state === "failed" && child.delivered ? registry : undefined;
			}, "delivered chain failure");
			await new Promise((resolve) => setTimeout(resolve, 750));
			const stable = loadRegistry(registryFile);
			expect(failed.children).toHaveLength(1);
			expect(stable.children).toHaveLength(1);
			expect(stable.children[0]?.failure).toContain("pane disappeared");
			expect(stable.chain?.progressed).toEqual([false, false]);
		} finally {
			await closeProvider(server);
			rmSync(work, { recursive: true, force: true });
		}
	}, 35_000);

	it("discovers installed resources in a real child without widening its write scope", async () => {
		const fixture = mkdtempSync(join(resolve(process.cwd(), ".."), ".resource-child-"));
		const work = join(fixture, "project");
		const home = join(fixture, "home");
		mkdirSync(join(work, "src"), { recursive: true });
		mkdirSync(home, { recursive: true });
		const agentName = "resource-worker";
		const task = "CHILD_RESOURCE_DISCOVERY";
		const profile = "builtin:worker";
		const writes = ["src/**"];
		const content = "resource reference acceptance evidence";
		const referenceName = "reference.md";
		const operations: Array<Pick<Parameters<typeof toolCall>[0], "name" | "args">> = [];
		const requests: unknown[] = [];
		let observedResults: readonly unknown[] = [];
		const server = createServer(async (request, response) => {
			try {
				const body = await readJsonBody(request);
				requests.push(body);
				if (toolNames(body).includes("subagent")) {
					if (toolResultCount(body) === 0)
						return toolCall({
							response,
							name: "subagent",
							args: { agent: agentName, task, cwd: work, writes, agentScope: "project", confirmProjectAgents: false },
							id: "launch-resource-child",
						});
					return text(response, "parent waiting");
				}
				if (!JSON.stringify(messages(body)).includes(task)) throw new Error("Unexpected resource child request");
				observedResults = messages(body).filter((message) => isRecord(message) && message.role === "tool");
				const step = toolResultCount(body);
				const operation = operations[step];
				if (operation)
					return toolCall({ response, name: operation.name, args: operation.args, id: `resource-${step}` });
				return text(response, "resource scenario complete");
			} catch (error) {
				response.writeHead(500, { "content-type": "text/plain" });
				response.end(String(error));
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Local resource provider did not bind");
		const agentDir = configureAgentDir(fixture, address.port);
		new ProjectTrustStore(agentDir).set(work, true);
		const sharedSkillsRoot = join(home, ".agents", "skills");
		const roots = [sharedSkillsRoot, join(home, ".agents", "snippets"), join(agentDir, "skills")];
		for (const [index, root] of roots.entries()) {
			const source = join(fixture, "source", `resource-${index}`);
			mkdirSync(source, { recursive: true });
			mkdirSync(root, { recursive: true });
			writeFileSync(join(source, referenceName), content);
			symlinkSync(source, join(root, "installed"), "dir");
			operations.push(
				{ name: "ls", args: { path: root } },
				{ name: "find", args: { path: join(root, "installed"), pattern: "**/*.md" } },
				{ name: "read", args: { path: join(root, "installed", referenceName) } },
				{ name: "read", args: { path: join(source, referenceName) } },
			);
		}
		const containedMarker = join("src", "contained-marker");
		operations.push({ name: "bash", args: { command: `touch '${containedMarker}'` } });
		const blockedTarget = join(sharedSkillsRoot, "forbidden.md");
		operations.push({ name: "write", args: { path: blockedTarget, content: "must not be written" } });
		const directory = join(work, ".pi", "agents");
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(directory, `${agentName}.md`),
			`---\nname: ${agentName}\ndescription: resource acceptance worker\ntools: read, ls, find, write, bash\nmodel: local/deterministic\nprofile: ${profile}\n---\nRun the requested resource scenario.\n`,
		);
		const socket = `pi-resource-child-${process.pid}`;
		const session = socket;
		sessions.push({ socket, session });
		const command = [
			`cd ${shellQuote(work)} &&`,
			`HOME=${shellQuote(home)}`,
			`PI_CODING_AGENT_DIR=${shellQuote(agentDir)}`,
			`PI_GUARD_ACTIVE_PROFILE=${shellQuote(profile)}`,
			`PI_GUARD_PROFILE_CONFIG=${shellQuote(join(fixture, "missing-profile.jsonc"))}`,
			"pi --no-extensions",
			`-e ${shellQuote(join(process.cwd(), "extensions", "index.ts"))}`,
			"--model local/deterministic --tools subagent,subagent_message",
			shellQuote("PUBLIC_RESOURCE_DISCOVERY"),
		].join(" ");
		try {
			// Child panes inherit the tmux server environment, not command-local HOME.
			execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "sh"], {
				env: { ...process.env, HOME: home },
				timeout: 5000,
			});
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "-l", command]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "Enter"]);
			const child = await waitFor(
				() => {
					const root = join(work, ".pi", "orchestration");
					if (!existsSync(root)) return undefined;
					for (const entry of readdirSync(root, { withFileTypes: true })) {
						const registry = join(root, entry.name, "registry.json");
						if (!entry.isDirectory() || !existsSync(registry)) continue;
						const candidate = loadRegistry(registry).children[0];
						if (candidate?.delivered) return candidate;
					}
					return undefined;
				},
				"resource child completion",
				25_000,
			);
			const terminal = parseOrThrow(
				TerminalSignalSchema,
				JSON.parse(readFileSync(`${child.loadoutPath}.terminal.json`, "utf8")),
				"resource terminal",
			);
			expect(child.loadoutSnapshot.profile).toBe(profile);
			expect(child.loadoutSnapshot.writes).toEqual(writes);
			expect(terminal.permissionBlocks?.map((block) => block.toolName)).toEqual(["write"]);
			expect(observedResults).toHaveLength(operations.length);
			for (const [index, operation] of operations.entries()) {
				const result = JSON.stringify(observedResults[index]);
				switch (operation.name) {
					case "read":
						expect(result).toContain(content);
						break;
					case "ls":
						expect(result).toContain("installed");
						break;
					case "find":
						expect(result).toContain(referenceName);
						break;
					case "bash":
						expect(existsSync(join(work, containedMarker))).toBe(true);
						break;
					case "write":
						expect(result).toContain("PI_SUBAGENT_PERMISSIBLE_GLOBS");
						break;
					default:
						throw new Error(`Unexpected resource operation: ${operation.name}`);
				}
			}
			expect(existsSync(blockedTarget)).toBe(false);
		} catch (error) {
			const pane = execFileSync("tmux", ["-L", socket, "capture-pane", "-p", "-t", session], {
				encoding: "utf8",
				timeout: 5000,
			});
			throw new Error(`Resource lifecycle failed: ${String(error)}\n${pane}\nProvider requests: ${requests.length}`, {
				cause: error,
			});
		} finally {
			await closeProvider(server);
			rmSync(fixture, { recursive: true, force: true });
		}
	}, 35_000);

	it("does not let a broad write declaration widen an inherited restrictive profile", async () => {
		const work = mkdtempSync(join(resolve(process.cwd(), "../../../../.."), ".pi-guard-restricted-"));
		mkdirSync(join(work, "src"), { recursive: true });
		configureProjectAgent(work);
		const server = createServer(async (request, response) => {
			try {
				const body = await readJsonBody(request);
				const serialized = JSON.stringify(messages(body));
				if (toolNames(body).includes("subagent")) {
					if (toolResultCount(body) === 0)
						return toolCall({
							response,
							name: "subagent",
							args: {
								agent: "worker",
								task: "CHILD_RESTRICTED",
								cwd: work,
								writes: ["**"],
								agentScope: "project",
								confirmProjectAgents: false,
							},
							id: "launch-restricted",
						});
					return text(response, "parent waiting");
				}
				if (!serialized.includes("CHILD_RESTRICTED")) return text(response, "unexpected scenario");
				if (toolResultCount(body) === 0)
					return toolCall({
						response,
						name: "write",
						args: { path: "notes.md", content: "must not exist" },
						id: "profile-write",
					});
				return text(response, "restricted scenario complete");
			} catch (error) {
				response.writeHead(500, { "content-type": "text/plain" });
				response.end(String(error));
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("local provider did not bind");
		const agentDir = configureAgentDir(work, address.port);
		const socket = `pi-guard-restricted-${process.pid}`;
		const session = `pi-guard-restricted-${process.pid}`;
		sessions.push({ socket, session });
		const command = [
			`cd ${shellQuote(work)} &&`,
			`PI_CODING_AGENT_DIR=${shellQuote(agentDir)}`,
			`PI_GUARD_ACTIVE_PROFILE=${shellQuote("builtin:read-only")}`,
			"pi --no-extensions",
			`-e ${shellQuote(join(process.cwd(), "extensions", "index.ts"))}`,
			"--model local/deterministic --tools subagent,subagent_message",
			shellQuote("PUBLIC_RESTRICTED"),
		].join(" ");
		try {
			execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "sh"]);
			execFileSync("tmux", ["-L", socket, "set-option", "-t", session, "remain-on-exit", "on"]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "-l", command]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "Enter"]);
			const completed = await waitFor(
				() => {
					const root = join(work, ".pi", "orchestration");
					if (!existsSync(root)) return undefined;
					for (const entry of readdirSync(root, { withFileTypes: true })) {
						const candidate = join(root, entry.name, "registry.json");
						if (!entry.isDirectory() || !existsSync(candidate)) continue;
						const child = loadRegistry(candidate).children[0];
						if (child?.delivered) return child;
					}
					return undefined;
				},
				"restricted child completion",
				25_000,
			);
			expect(completed.loadoutSnapshot.profile).toBe("builtin:read-only");
			expect(completed.loadoutSnapshot.writes).toEqual(["**"]);
			const terminal = parseOrThrow(
				TerminalSignalSchema,
				JSON.parse(readFileSync(`${completed.loadoutPath}.terminal.json`, "utf8")),
				"restricted child terminal",
			);
			expect(terminal.permissionBlocks?.[0]?.toolName).toBe("write");
			expect(terminal.permissionBlocks?.[0]?.text).not.toContain("PI_SUBAGENT_PERMISSIBLE_GLOBS");
			expect(existsSync(join(work, "notes.md"))).toBe(false);
		} finally {
			await closeProvider(server);
			rmSync(work, { recursive: true, force: true });
		}
	}, 35_000);

	it("requires a live adapter despite inherited approval names, revokes on reload, and binds activation content", () => {
		for (const scenario of [
			"inherited",
			"remove",
			"changed-entry",
			"changed-module",
			"changed-shared-module",
			"changed-documentation",
		]) {
			const work = mkdtempSync(join(tmpdir(), "pi-guard-provider-authority-"));
			try {
				const installed = configureProviderPackages({ work, port: 12345 });
				const agentDir = configureAgentDir(work, 12345);
				const changedFile =
					scenario === "changed-entry"
						? installed.adapter
						: scenario === "changed-module"
							? installed.reconstructionModule
							: scenario === "changed-shared-module"
								? installed.sharedApprovalModule
								: scenario === "changed-documentation"
									? installed.reconstructionDocumentation
									: undefined;
				const results = runApprovalProbe({
					...installed,
					agentDir,
					work,
					adapter: scenario === "inherited" ? undefined : installed.adapter,
					remove: scenario === "remove",
					...(changedFile ? { sourceChange: { kind: "append", file: changedFile } } : {}),
				});
				if (scenario === "changed-documentation") {
					expect(results.map((result) => result.status)).toEqual(["approved"]);
					continue;
				}
				if (scenario === "remove") expect(results.map((result) => result.status)).toEqual(["approved", "refused"]);
				else expect(results.map((result) => result.status)).toEqual(["refused"]);
				const refusal = results.at(-1);
				if (refusal?.status !== "refused") throw new Error("Inactive or changed adapter retained authority");
				expect(refusal.reason).toMatch(
					changedFile ? /changed since parent activation/ : /active parent-approved adapter/,
				);
			} finally {
				rmSync(work, { recursive: true, force: true });
			}
		}
	}, 35_000);

	it("refuses persisted child resume after non-entry production modules change or are added", async () => {
		const work = mkdtempSync(join(tmpdir(), "pi-guard-provider-resume-tree-"));
		try {
			const installed = configureProviderPackages({ work, port: 12345 });
			const agentDir = configureAgentDir(work, 12345);
			const approval = runApprovalProbe({ ...installed, agentDir, work })[0];
			if (approval?.status !== "approved") throw new Error("Live parent adapter did not approve the child provider");
			const launcher: typeof Launcher = await import(
				pathToFileURL(join(installed.subagents, "extensions/interactive/launcher.ts")).href
			);
			const value = approvedChildLoadout({ installed, agentDir, extensions: approval.extensions, work });
			const loadoutPath = join(work, "loadout.json");
			writeFileSync(loadoutPath, JSON.stringify(value));
			expect(launcher.validateResumeLoadout({ file: loadoutPath })).toEqual(value);
			writeFileSync(
				installed.reconstructionDocumentation,
				"# Documentation changed without changing executable code\n",
			);
			expect(launcher.validateResumeLoadout({ file: loadoutPath })).toEqual(value);
			for (const file of [
				installed.reconstructionModule,
				installed.sharedApprovalModule,
				join(installed.reconstructionDirectory, "added-module.ts"),
			]) {
				const original = existsSync(file) ? readFileSync(file, "utf8") : undefined;
				writeFileSync(file, `${original ?? "export const addedModule = true;"}\n// changed after approval\n`);
				expect(() => launcher.validateResumeLoadout({ file: loadoutPath })).toThrow(
					/provider extension content changed/,
				);
				if (original === undefined) rmSync(file);
				else writeFileSync(file, original);
				expect(launcher.validateResumeLoadout({ file: loadoutPath })).toEqual(value);
			}
			const sharedSource = readFileSync(installed.sharedApprovalModule, "utf8");
			const linkedSource = join(work, "shared-source.ts");
			writeFileSync(linkedSource, sharedSource);
			for (const kind of ["symlink", "directory"]) {
				rmSync(installed.sharedApprovalModule);
				if (kind === "symlink") symlinkSync(linkedSource, installed.sharedApprovalModule);
				else mkdirSync(installed.sharedApprovalModule);
				expect(() => launcher.validateResumeLoadout({ file: loadoutPath })).toThrow(/regular non-symlink file/);
				rmSync(installed.sharedApprovalModule, { recursive: true });
				writeFileSync(installed.sharedApprovalModule, sharedSource);
				expect(launcher.validateResumeLoadout({ file: loadoutPath })).toEqual(value);
			}
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}, 20_000);

	it("rejects symlinks and unexpected file types anywhere in the provider production tree", () => {
		for (const scenario of ["file-link", "directory-link", "documentation-link", "unexpected"]) {
			const work = mkdtempSync(join(tmpdir(), "pi-guard-provider-tree-"));
			try {
				const installed = configureProviderPackages({ work, port: 12345 });
				if (scenario === "documentation-link") rmSync(installed.reconstructionDocumentation);
				const sourceChange =
					scenario === "unexpected"
						? ({
								kind: "unexpected-file",
								file: join(installed.reconstructionDirectory, "unexpected.json"),
							} satisfies NonNullable<Static<typeof ApprovalProbeConfigSchema>["sourceChange"]>)
						: ({
								kind: "symlink",
								file:
									scenario === "documentation-link"
										? installed.reconstructionDocumentation
										: join(installed.reconstructionDirectory, "linked.ts"),
								target:
									scenario === "directory-link" ? installed.reconstructionDirectory : installed.reconstructionModule,
							} satisfies NonNullable<Static<typeof ApprovalProbeConfigSchema>["sourceChange"]>);
				const refusal = runApprovalProbe({
					...installed,
					agentDir: configureAgentDir(work, 12345),
					work,
					sourceChange,
				})[0];
				if (refusal?.status !== "refused") throw new Error("Invalid provider production source retained authority");
				expect(refusal.reason).toMatch(/directories and regular non-symlink .ts files/);
			} finally {
				rmSync(work, { recursive: true, force: true });
			}
		}
	}, 35_000);

	it("preserves guard, agent catalog, and other extension prompt sections across real Pi turns", async () => {
		const work = mkdtempSync(join(tmpdir(), "pi-guard-prompt-sections-"));
		const requests: Static<typeof ProviderRequestSchema>[] = [];
		const server = createServer(async (request, response) => {
			requests.push(await readProviderRequest({ request }));
			text(response, "prompt sections received");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("local provider did not bind");
		try {
			const { subagents, guard, adapter } = configureProviderPackages({ work, port: address.port });
			const agentDir = configureAgentDir(work, address.port);
			const sessionId = randomUUID();
			const diagnostics: Awaited<ReturnType<typeof runPrintCommand>>[] = [];
			for (const task of ["first prompt", "second prompt"]) {
				const command = [
					"/usr/bin/env",
					`PI_CODING_AGENT_DIR=${agentDir}`,
					"pi",
					"--no-extensions",
					"-e",
					join(guard, "extensions/guard.ts"),
					"-e",
					join(subagents, "extensions/index.ts"),
					"-e",
					adapter,
					"--model",
					`${CLAUDE_BRIDGE_PROVIDER}/${LOCAL_PROVIDER_MODEL_ID}`,
					"--session-id",
					sessionId,
					"--tools",
					"read",
					task,
				];
				diagnostics.push(await runPrintCommand({ command, cwd: work }));
			}
			const diagnosticContext = JSON.stringify(diagnostics);
			expect(requests.length, diagnosticContext).toBe(2);
			for (const body of requests) {
				const prompt = JSON.stringify(
					messages(body).filter((message) => isRecord(message) && message.role === "system"),
				);
				expect(prompt.includes(OTHER_EXTENSION_SECTION.content), diagnosticContext).toBe(true);
				expect((prompt.match(/# Active profile:/g) ?? []).length, diagnosticContext).toBe(1);
				expect((prompt.match(/<pi_guard_subagents>/g) ?? []).length, diagnosticContext).toBe(1);
			}
		} finally {
			await closeProvider(server);
			rmSync(work, { recursive: true, force: true });
		}
	}, 35_000);

	it("runs an approved provider through the real generated child command without credentials", async () => {
		const work = mkdtempSync(join(tmpdir(), "pi-guard-provider-command-"));
		const requests: Static<typeof ProviderRequestSchema>[] = [];
		const server = createServer(async (request, response) => {
			requests.push(await readProviderRequest({ request }));
			text(response, "local approved provider available");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("local provider did not bind");
		try {
			const { subagents, guard, adapter, reconstructionModule } = configureProviderPackages({
				work,
				port: address.port,
			});
			const launcher: typeof Launcher = await import(
				pathToFileURL(join(subagents, "extensions/interactive/launcher.ts")).href
			);
			const types: typeof LoadoutTypes = await import(
				pathToFileURL(join(subagents, "extensions/interactive/types.ts")).href
			);
			const agentDir = configureAgentDir(work, address.port);
			const approval = runApprovalProbe({ subagents, adapter, agentDir, work })[0];
			if (approval?.status !== "approved") throw new Error("Live parent adapter did not approve the child provider");
			const value = approvedChildLoadout({
				installed: { guard, subagents },
				agentDir,
				extensions: approval.extensions,
				work,
			});
			const loadout = types.validateLoadout({ value });
			const loadoutPath = join(work, "loadout.json");
			writeFileSync(loadoutPath, JSON.stringify(loadout));
			const command = launcher.buildChildCommand({
				loadout,
				sessionId: randomUUID(),
				task: "respond once",
				loadoutPath,
			});
			expect(command).toContain("--no-extensions");
			const diagnostics = await runPrintCommand({ command, cwd: work });
			const diagnosticContext = JSON.stringify({ ...diagnostics, localRequests: requests.length });
			const terminal = parseOrThrow(
				TerminalSignalSchema,
				JSON.parse(readFileSync(`${loadoutPath}.terminal.json`, "utf8")),
				"provider command terminal",
			);
			expect(terminal.status, diagnosticContext).toBe("completed");
			expect(terminal.result === "local approved provider available", diagnosticContext).toBe(true);
			expect(requests.length, diagnosticContext).toBe(1);
			expect(toolNames(requests[0]).sort(), diagnosticContext).toEqual([...loadout.toolAllowlist].sort());
			const prompt = JSON.stringify(messages(requests[0]));
			expect(prompt.includes("# Active profile: builtin:worker"), diagnosticContext).toBe(true);
			expect(prompt.includes(OTHER_EXTENSION_SECTION.content), diagnosticContext).toBe(true);
			for (const file of [adapter, reconstructionModule]) {
				const approvedSource = readFileSync(file, "utf8");
				writeFileSync(file, `${approvedSource}\n// changed after approval\n`);
				expect(() => launcher.validateResumeLoadout({ file: loadoutPath })).toThrow(
					/provider extension content changed/,
				);
				expect(() =>
					launcher.buildChildCommand({ loadout, sessionId: randomUUID(), task: "must not run", loadoutPath }),
				).toThrow(/provider extension content changed/);
				writeFileSync(file, approvedSource);
				expect(launcher.validateResumeLoadout({ file: loadoutPath })).toEqual(loadout);
			}
		} finally {
			await closeProvider(server);
			rmSync(work, { recursive: true, force: true });
		}
	}, 25_000);

	it("loads only the approved provider in a real child and refuses resume after its code changes", async () => {
		const work = realpathSync(mkdtempSync(join(tmpdir(), "pi-guard-approved-provider-")));
		// A disposable installed layout exercises the real canonical mapping without
		// replacing the actual sibling adapter or contacting its billable provider.
		configureProjectAgent(work);
		const agentFile = join(work, ".pi/agents/worker.md");
		writeFileSync(
			agentFile,
			readFileSync(agentFile, "utf8").replace(
				"local/deterministic",
				`${CLAUDE_BRIDGE_PROVIDER}/${LOCAL_PROVIDER_MODEL_ID}`,
			),
		);
		let parentRequests = 0;
		let launchRequested = false;
		let resumeRequested = false;
		let resumeRejected = false;
		let serverFailure: Error | undefined;
		let observedChild: Pick<ChildRecord, "name" | "state" | "failure" | "paneId"> | undefined;
		let approvedTools: string[] = [];
		let approvedProfile: string | null = null;
		const childRequests: Static<typeof ProviderRequestSchema>[] = [];
		const parentPrompts: string[] = [];
		const parentToolResults: unknown[] = [];
		const server = createServer(async (request, response) => {
			try {
				const body = await readProviderRequest({ request });
				if (body.model === LOCAL_PROVIDER_MODEL_ID) {
					childRequests.push(body);
					if (toolResultCount(body) === 0)
						return toolCall({ response, name: "read", args: { path: agentFile }, id: "approved-read" });
					return text(response, "approved provider child complete");
				}
				parentPrompts.push(
					JSON.stringify(messages(body).filter((message) => isRecord(message) && message.role === "system")),
				);
				parentToolResults.push(...messages(body).filter((message) => isRecord(message) && message.role === "tool"));
				parentRequests++;
				if (!launchRequested) {
					launchRequested = true;
					return toolCall({
						response,
						name: "subagent",
						args: {
							agent: "worker",
							task: "read the agent file",
							cwd: work,
							agentScope: "project",
							confirmProjectAgents: false,
						},
						id: "launch-approved-provider",
					});
				}
				if (!resumeRequested) {
					resumeRequested = true;
					const child = await waitFor(() => {
						const root = join(work, ".pi/orchestration");
						if (!existsSync(root)) return undefined;
						for (const entry of readdirSync(root)) {
							const registry = join(root, entry, "registry.json");
							if (!existsSync(registry)) continue;
							// Observe the disposable installation's persisted contract, rather
							// than authorizing it with this installation's canonical paths.
							const record = parseOrThrow(
								RegistrySchema,
								JSON.parse(readFileSync(registry, "utf8")),
								"installed fixture orchestration registry",
							).children[0];
							if (record) {
								observedChild = {
									name: record.name,
									state: record.state,
									failure: record.failure,
									paneId: record.paneId,
								};
							}
							if (record?.state === "completed" || record?.state === "failed") return record;
						}
						return undefined;
					}, "approved provider child completion");
					expect(child.state, child.failure).toBe("completed");
					expect(child.loadoutSnapshot.providerExtensions[0]?.provider).toBe(CLAUDE_BRIDGE_PROVIDER);
					expect(child.loadoutSnapshot.backingExtensionPaths).toEqual([]);
					approvedTools = child.loadoutSnapshot.toolAllowlist;
					approvedProfile = child.loadoutSnapshot.profile;
					writeFileSync(adapter, `${readFileSync(adapter, "utf8")}\n// changed after parent approval\n`);
					return toolCall({
						response,
						name: "subagent_message",
						args: { name: child.name, message: "must not resume changed provider" },
						id: "rejectchangedprovider",
					});
				}
				// Public resume rejects the registry whose saved provider identity
				// changed. Lower-level command tests assert the content-change cause.
				// Correlate the refusal with this resume call, not unrelated turns.
				resumeRejected = messages(body).some((message) => {
					if (!isRecord(message) || message.role !== "tool" || message.tool_call_id !== "rejectchangedprovider")
						return false;
					return message.content === "Invalid interactive orchestration registry";
				});
				return text(response, resumeRejected ? "changed provider resume rejected" : "waiting for child");
			} catch (error) {
				serverFailure = error instanceof Error ? error : new Error(String(error));
				response.destroy();
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("local provider did not bind");
		const agentDir = configureAgentDir(work, address.port);
		const installed = configureProviderPackages({ work, port: address.port });
		const adapter = installed.adapter;
		const { subagents, guard } = installed;
		const socket = `pi-guard-provider-${process.pid}`;
		const session = `pi-guard-provider-${process.pid}`;
		sessions.push({ socket, session });
		const command = [
			`cd ${shellQuote(work)} &&`,
			`PI_CODING_AGENT_DIR=${shellQuote(agentDir)}`,
			"pi --no-extensions",
			`-e ${shellQuote(join(guard, "extensions/guard.ts"))}`,
			`-e ${shellQuote(join(subagents, "extensions/index.ts"))}`,
			`-e ${shellQuote(adapter)}`,
			"--model local/deterministic --tools subagent,subagent_message",
			shellQuote("APPROVED_PROVIDER_LIFECYCLE"),
		].join(" ");
		try {
			execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "sh"]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "-l", command]);
			execFileSync("tmux", ["-L", socket, "send-keys", "-t", session, "Enter"]);
			await waitFor(() => serverFailure ?? (resumeRejected || undefined), "changed provider resume rejection", 25_000);
			if (serverFailure) throw serverFailure;
			expect(childRequests).toHaveLength(2);
			for (const body of childRequests) {
				expect(toolNames(body).sort()).toEqual([...approvedTools].sort());
				const prompt = JSON.stringify(messages(body));
				expect(prompt).toContain(`# Active profile: ${approvedProfile}`);
				expect(prompt).toContain(OTHER_EXTENSION_SECTION.content);
				expect(prompt.match(/# Active profile:/g)).toHaveLength(1);
			}
			for (const prompt of parentPrompts) {
				expect(prompt).toContain("pi_guard_subagents");
				expect(prompt).toContain(OTHER_EXTENSION_SECTION.content);
				expect(prompt.match(/# Active profile:/g)).toHaveLength(1);
			}
		} catch (error) {
			const panes = execFileSync("tmux", ["-L", socket, "list-panes", "-a", "-F", "#{pane_id}"], { encoding: "utf8" })
				.trim()
				.split("\n")
				.map((pane) =>
					execFileSync("tmux", ["-L", socket, "capture-pane", "-p", "-t", pane, "-S", "-40"], {
						encoding: "utf8",
					}).slice(-6000),
				);
			throw new Error(
				`${String(error)}\n${JSON.stringify({ observedChild, parentRequests, childRequests: childRequests.length, parentToolResults: parentToolResults.slice(-4), panes })}`,
			);
		} finally {
			await closeProvider(server);
			rmSync(work, { recursive: true, force: true });
		}
	}, 35_000);
});
