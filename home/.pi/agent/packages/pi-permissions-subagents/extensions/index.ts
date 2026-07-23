/**
 * Subagent — delegate tasks to isolated worker sessions, typically on cheaper models.
 *
 * Forked from pi's examples/extensions/subagent with orchestration additions:
 * - Persistent, named worker sessions (--session-id/--name) recorded in every result
 * - Warm retries: pass a worker's sessionId back to resume it with corrections
 * - runDir: per-worker handoff markdown files (task, files changed, session, usage)
 * - Declared `writes` scopes per task with out-of-scope edit warnings
 * - Nested-delegation guard: workers (PI_SUBAGENT_DEPTH set) cannot spawn workers
 *
 * Supports three modes:
 *   - Single:   { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent, task, writes? }, ...] }
 *   - Chain:    { chain: [{ agent, task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn, execSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getMarkdownTheme,
	SessionManager,
	type ThemeColor,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import Value from "typebox/value";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import {
	checkScopeViolations,
	ensureRunDir,
	extractFilesChanged,
	slugify,
	type UsageStats,
	writeHandoffFile,
} from "./handoff.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

const UsageSchema = Type.Object({
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
const TextContentSchema = Type.Object({
	type: Type.Literal("text"),
	text: Type.String(),
});
const ImageContentSchema = Type.Object({
	type: Type.Literal("image"),
	data: Type.String(),
	mimeType: Type.String(),
});
const AssistantMessageSchema = Type.Object({
	role: Type.Literal("assistant"),
	content: Type.Array(
		Type.Union([
			TextContentSchema,
			Type.Object({
				type: Type.Literal("thinking"),
				thinking: Type.String(),
				thinkingSignature: Type.Optional(Type.String()),
				redacted: Type.Optional(Type.Boolean()),
			}),
			Type.Object({
				type: Type.Literal("toolCall"),
				id: Type.String(),
				name: Type.String(),
				arguments: Type.Record(Type.String(), Type.Unknown()),
				thoughtSignature: Type.Optional(Type.String()),
			}),
		]),
	),
	api: Type.String(),
	provider: Type.String(),
	model: Type.String(),
	responseModel: Type.Optional(Type.String()),
	responseId: Type.Optional(Type.String()),
	usage: UsageSchema,
	stopReason: Type.Union([
		Type.Literal("stop"),
		Type.Literal("length"),
		Type.Literal("toolUse"),
		Type.Literal("error"),
		Type.Literal("aborted"),
	]),
	errorMessage: Type.Optional(Type.String()),
	timestamp: Type.Number(),
});
const ToolResultMessageSchema = Type.Object({
	role: Type.Literal("toolResult"),
	toolCallId: Type.String(),
	toolName: Type.String(),
	content: Type.Array(Type.Union([TextContentSchema, ImageContentSchema])),
	details: Type.Optional(Type.Unknown()),
	usage: Type.Optional(UsageSchema),
	addedToolNames: Type.Optional(Type.Array(Type.String())),
	isError: Type.Boolean(),
	timestamp: Type.Number(),
});
const WorkerEventSchema = Type.Union([
	Type.Object({
		type: Type.Literal("message_end"),
		message: AssistantMessageSchema,
	}),
	Type.Object({
		type: Type.Literal("tool_result_end"),
		message: ToolResultMessageSchema,
	}),
]);

type WorkerEvent =
	{ type: "message_end"; message: AssistantMessage } | { type: "tool_result_end"; message: ToolResultMessage };

function parseWorkerEvent(line: string): WorkerEvent | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!Value.Check(WorkerEventSchema, value)) return undefined;

	// Pi does not currently export its JSON-mode event schema. The local schema
	// above validates every Message field this consumer stores or reads.
	return value as WorkerEvent;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: ThemeColor, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface SingleResult {
	agent: string;
	agentSource: "builtin" | "user" | "project" | "unknown";
	task: string;
	label?: string;
	exitCode: number; // -1 = still running
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	sessionId: string;
	sessionFile?: string;
	handoffPath?: string;
	writes?: string[];
	filesChanged: string[];
	scopeViolations: string[];
	startedAt?: Date;
	endedAt?: Date;
	workerCwd: string;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	runDir?: string;
	results: SingleResult[];
}

function emptyUsage(): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

function shortId(id: string): string {
	return id.slice(0, 8);
}

/** Snapshot of dirty paths from `git status --short`. Best effort; returns [] if not a git repo. */
function gitStatusShort(cwd: string): string[] {
	try {
		const out = execSync("git status --short", {
			cwd,
			encoding: "utf-8",
			timeout: 5000,
		});
		return out
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

function parseGitStatusPath(line: string): string {
	const arrow = line.indexOf(" -> ");
	if (arrow >= 0) return line.slice(arrow + 4).trim();
	return line.slice(3).trim();
}

/** Metadata appended to tool-result text so the orchestrator can audit, resume, and spot conflicts. */
function resultMetaLines(r: SingleResult): string[] {
	const lines: string[] = [];
	lines.push(`session: \`${r.sessionId}\` — inspect/resume: \`pi --session ${r.sessionId}\` (from the worker's cwd)`);
	if (r.handoffPath) lines.push(`handoff: ${r.handoffPath}`);
	if (r.filesChanged.length) {
		const shown = r.filesChanged.slice(0, 10);
		const more = r.filesChanged.length > shown.length ? `, +${r.filesChanged.length - shown.length} more` : "";
		lines.push(`files changed (write/edit + git snapshot): ${shown.join(", ")}${more}`);
	}
	if (r.scopeViolations.length) {
		lines.push(
			`⚠ OUT-OF-SCOPE EDITS (declared writes: ${(r.writes ?? []).join(", ")}): ${r.scopeViolations.join(", ")}`,
		);
	}
	return lines;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({
						type: "toolCall",
						name: part.name,
						args: part.arguments,
					});
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, {
			encoding: "utf-8",
			mode: 0o600,
		});
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	// Test seam: allows tests to point subagent spawns at a fake pi executable.
	if (process.env.PI_SUBAGENT_PI_PATH) {
		return { command: process.env.PI_SUBAGENT_PI_PATH, args };
	}

	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

/** Locate the persisted session file for a worker, by session id. Best effort. */
async function resolveSessionFile(cwd: string, sessionId: string): Promise<string | undefined> {
	try {
		const sessions = await SessionManager.list(cwd);
		return sessions.find((s) => s.path.includes(sessionId))?.path;
	} catch {
		return undefined;
	}
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface RunAgentOptions {
	agentName: string;
	task: string;
	cwd?: string;
	step?: number;
	sessionId?: string;
	label?: string;
	writes?: string[];
	runDir?: string;
	handoffBase?: string;
	/** Git-status bash-edit tracking is unreliable when multiple workers share a cwd. */
	trackBashEdits?: boolean;
}

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	opts: RunAgentOptions,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === opts.agentName);
	const workerCwd = opts.cwd ?? defaultCwd;

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: opts.agentName,
			agentSource: "unknown",
			task: opts.task,
			label: opts.label,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${opts.agentName}". Available agents: ${available}.`,
			usage: emptyUsage(),
			sessionId: opts.sessionId ?? "none",
			filesChanged: [],
			scopeViolations: [],
			workerCwd,
		};
	}

	// Snapshot git state before the worker runs so we can detect bash-based edits
	// that bypass the write/edit tools. Not used for parallel workers sharing a cwd,
	// because their git states interleave and attribution becomes unreliable.
	const preGitStatus = opts.trackBashEdits ? gitStatusShort(workerCwd) : [];

	// Persistent named session: resumable with `pi --session <id>` and warm-retried
	// by passing the same sessionId back to this tool.
	const sessionId = opts.sessionId ?? crypto.randomUUID();
	const sessionLabel = slugify(opts.label ?? opts.task, 24);
	const sessionName = `subagent:${agent.name}:${sessionLabel}:${shortId(sessionId)}`;

	const args: string[] = ["--mode", "json", "-p", "--session-id", sessionId, "--name", sessionName];
	if (agent.model) args.push("--model", agent.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agent.name,
		agentSource: agent.source,
		task: opts.task,
		label: opts.label,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model: agent.model,
		step: opts.step,
		sessionId,
		writes: opts.writes,
		filesChanged: [],
		scopeViolations: [],
		startedAt: new Date(),
		workerCwd,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [
					{
						type: "text",
						text: getFinalOutput(currentResult.messages) || "(running...)",
					},
				],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${opts.task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const spawnEnv: NodeJS.ProcessEnv = {
				...process.env,
				PI_SUBAGENT_DEPTH: "1",
			};
			if (agent.profile) spawnEnv.PI_SUBAGENT_PROFILE = agent.profile;
			if (opts.writes?.length) spawnEnv.PI_SUBAGENT_WRITE_GLOBS = opts.writes.join(",");

			const proc = spawn(invocation.command, invocation.args, {
				cwd: workerCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: spawnEnv,
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				const event = parseWorkerEvent(line);
				if (!event) return;

				if (event.type === "message_end") {
					const msg = event.message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end") {
					currentResult.messages.push(event.message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		currentResult.endedAt = new Date();
		if (wasAborted) throw new Error("Subagent was aborted");

		// Post-run bookkeeping: session file, files changed (tool calls + git snapshot),
		// scope check, handoff file.
		currentResult.sessionFile = await resolveSessionFile(workerCwd, sessionId);
		const toolChangedFiles = extractFilesChanged(currentResult.messages);
		let gitChangedFiles: string[] = [];
		if (opts.trackBashEdits) {
			const preGitPaths = new Set(preGitStatus.map(parseGitStatusPath));
			gitChangedFiles = gitStatusShort(workerCwd)
				.map(parseGitStatusPath)
				.filter((p) => !preGitPaths.has(p));
		}
		currentResult.filesChanged = [...new Set([...toolChangedFiles, ...gitChangedFiles])].sort();
		if (opts.writes?.length) {
			currentResult.scopeViolations = checkScopeViolations(currentResult.filesChanged, opts.writes);
		}
		if (opts.runDir && opts.handoffBase) {
			try {
				currentResult.handoffPath = writeHandoffFile(opts.runDir, {
					fileBase: opts.handoffBase,
					agent: agent.name,
					agentSource: agent.source,
					label: opts.label,
					task: opts.task,
					model: currentResult.model,
					sessionId,
					sessionFile: currentResult.sessionFile,
					status: isFailedResult(currentResult) ? "failed" : "completed",
					stopReason: currentResult.stopReason,
					errorMessage: currentResult.errorMessage,
					startedAt: currentResult.startedAt ?? new Date(),
					endedAt: currentResult.endedAt,
					usage: currentResult.usage,
					writes: opts.writes,
					filesChanged: currentResult.filesChanged,
					scopeViolations: currentResult.scopeViolations,
					finalOutput: getResultOutput(currentResult),
					workerCwd,
				});
			} catch (err) {
				currentResult.stderr += `\nFailed to write handoff file: ${err}`;
			}
		}

		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	writes: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Declared write scope: path prefixes (relative to cwd) this task may modify. Used to plan non-conflicting parallel work; out-of-scope edits are flagged in the result.",
		}),
	),
	sessionId: Type.Optional(
		Type.String({
			description:
				"Resume an existing worker session (from a previous subagent result) so it keeps its context. Use for correction rounds.",
		}),
	),
	label: Type.Optional(
		Type.String({
			description: "Short human label used in the session name and handoff file",
		}),
	),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({
		description: "Task with optional {previous} placeholder for prior output",
	}),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	writes: Type.Optional(
		Type.Array(Type.String(), {
			description: "Declared write scope (path prefixes) for this step",
		}),
	),
	sessionId: Type.Optional(
		Type.String({
			description: "Resume an existing worker session, keeping its context",
		}),
	),
	label: Type.Optional(Type.String({ description: "Short human label" })),
});

const AgentScopeSchema = StringEnum(["builtin", "user", "project", "all"] as const, {
	description:
		'Which agent directories to use. "builtin": package agents only. "user" (default): builtin + ~/.pi/agent/agents. "project": builtin + .pi/agents. "all": builtin + user + project.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(
		Type.String({
			description: "Name of the agent to invoke (for single mode)",
		}),
	),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "Array of {agent, task} for parallel execution",
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description: "Array of {agent, task} for sequential execution",
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "Prompt before running project-local agents. Default: true.",
			default: true,
		}),
	),
	cwd: Type.Optional(
		Type.String({
			description: "Working directory for the agent process (single mode)",
		}),
	),
	writes: Type.Optional(
		Type.Array(Type.String(), {
			description: "Declared write scope (path prefixes) for single mode",
		}),
	),
	sessionId: Type.Optional(
		Type.String({
			description: "Resume an existing worker session (single mode), keeping its context. Use for correction rounds.",
		}),
	),
	label: Type.Optional(Type.String({ description: "Short human label (single mode)" })),
	runDir: Type.Optional(
		Type.String({
			description:
				"Directory for per-worker handoff markdown files (task, files changed, session id, usage, final output). Use .pi/orchestration/<run-name> for orchestrated multi-task runs; that location is auto-gitignored.",
		}),
	),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context windows, typically on cheaper models.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Each worker runs in a persistent named pi session; the result includes its session id.",
			"Pass that sessionId back in a later call to resume the worker with corrections (warm retry, keeps its context).",
			"Set runDir to write per-worker handoff files for auditing; use a shared runDir across an orchestrated run.",
			"Declare `writes` scopes per task to plan non-conflicting parallel work; out-of-scope edits are flagged.",
			"Only delegate self-contained, well-specified tasks — delegation overhead is not worth it for trivial work.",
		].join(" "),
		promptSnippet:
			"Delegate focused tasks to isolated subagent workers (often cheaper models) with resumable sessions and handoff files",
		promptGuidelines: [
			"Use the subagent tool for well-specified, self-contained chunks of work so cheaper worker models carry implementation and recon costs; do trivial tasks directly instead.",
			"When calling the subagent tool with parallel tasks, declare disjoint `writes` scopes per task so workers cannot edit the same files.",
			"When a subagent worker's output needs corrections, call the subagent tool again with that worker's sessionId to resume it with feedback instead of starting a fresh worker.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (process.env.PI_SUBAGENT_DEPTH) {
				return {
					content: [
						{
							type: "text",
							text: "Nested delegation is disabled: this session is itself a subagent worker. Do the work directly with your own tools.",
						},
					],
					details: {
						mode: "single",
						agentScope: "user",
						projectAgentsDir: null,
						results: [],
					} as SubagentDetails,
					isError: true,
				};
			}

			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const runDir = params.runDir ? ensureRunDir(path.resolve(ctx.cwd, params.runDir)) : undefined;

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					runDir,
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			if ((agentScope === "project" || agentScope === "all") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [
								{
									type: "text",
									text: "Canceled: project-local agents not approved.",
								},
							],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						{
							agentName: step.agent,
							task: taskWithContext,
							cwd: step.cwd,
							step: i + 1,
							sessionId: step.sessionId,
							label: step.label,
							writes: step.writes,
							runDir,
							handoffBase: runDir
								? `handoff-step-${i + 1}-${step.agent}-${slugify(step.label ?? step.task)}`
								: undefined,
							trackBashEdits: true,
						},
						signal,
						chainUpdate,
						makeDetails("chain"),
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [
								{
									type: "text",
									text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}\n\n${resultMetaLines(result).join("\n")}`,
								},
							],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				const last = results[results.length - 1];
				const handoffNote = runDir ? `\nhandoffs written to: ${runDir}` : "";
				return {
					content: [
						{
							type: "text",
							text: `${getFinalOutput(last.messages) || "(no output)"}\n\n---\n${resultMetaLines(last).join("\n")}${handoffNote}`,
						},
					],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						label: params.tasks[i].label,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: emptyUsage(),
						sessionId: params.tasks[i].sessionId ?? "(pending)",
						writes: params.tasks[i].writes,
						filesChanged: [],
						scopeViolations: [],
						workerCwd: params.tasks[i].cwd ?? ctx.cwd,
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{
									type: "text",
									text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
								},
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						{
							agentName: t.agent,
							task: t.task,
							cwd: t.cwd,
							sessionId: t.sessionId,
							label: t.label,
							writes: t.writes,
							runDir,
							handoffBase: runDir
								? `handoff-${String(index + 1).padStart(2, "0")}-${t.agent}-${slugify(t.label ?? t.task)}`
								: undefined,
							trackBashEdits: false,
						},
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}\n\n${resultMetaLines(r).join("\n")}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					{
						agentName: params.agent,
						task: params.task,
						cwd: params.cwd,
						sessionId: params.sessionId,
						label: params.label,
						writes: params.writes,
						runDir,
						handoffBase: runDir ? `handoff-${params.agent}-${slugify(params.label ?? params.task)}` : undefined,
						trackBashEdits: true,
					},
					signal,
					onUpdate,
					makeDetails("single"),
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [
							{
								type: "text",
								text: `Agent ${result.stopReason || "failed"}: ${errorMsg}\n\n${resultMetaLines(result).join("\n")}`,
							},
						],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `${getFinalOutput(result.messages) || "(no output)"}\n\n---\n${resultMetaLines(result).join("\n")}`,
						},
					],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [
					{
						type: "text",
						text: `Invalid parameters. Available agents: ${available}`,
					},
				],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					const scopeNote = t.writes?.length ? ` [writes: ${t.writes.join(", ")}]` : "";
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}${theme.fg("muted", scopeNote)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			if (args.sessionId) text += `\n  ${theme.fg("muted", `resume ${shortId(args.sessionId)}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			const sessionLine = (r: SingleResult, full: boolean) => {
				if (!r.sessionId || r.sessionId === "(pending)" || r.sessionId === "none") return "";
				const id = full ? r.sessionId : shortId(r.sessionId);
				let line = theme.fg("dim", `session ${id}`);
				if (full) line += theme.fg("muted", ` · pi --session ${r.sessionId}`);
				if (r.handoffPath) line += theme.fg("dim", ` · handoff: ${r.handoffPath}`);
				return line;
			};

			const violationLine = (r: SingleResult) =>
				r.scopeViolations.length ? theme.fg("warning", `⚠ out-of-scope edits: ${r.scopeViolations.join(", ")}`) : "";

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					const sessionText = sessionLine(r, true);
					if (sessionText) container.addChild(new Text(sessionText, 0, 0));
					const violations = violationLine(r);
					if (violations) container.addChild(new Text(violations, 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					if (r.filesChanged.length) {
						container.addChild(new Spacer(1));
						container.addChild(
							new Text(theme.fg("muted", `Files changed (write/edit): ${r.filesChanged.join(", ")}`), 0, 0),
						);
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const violations = violationLine(r);
				if (violations) text += `\n${violations}`;
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				const sessionText = sessionLine(r, false);
				if (sessionText) text += `\n${sessionText}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					turns: 0,
				};
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						const stepSession = sessionLine(r, true);
						const footer = [stepUsage, stepSession].filter(Boolean).join(theme.fg("dim", " · "));
						if (footer) container.addChild(new Text(theme.fg("dim", footer), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
					const stepSession = sessionLine(r, false);
					if (stepSession) text += `\n${stepSession}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0));
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						const taskSession = sessionLine(r, true);
						const footer = [taskUsage, taskSession].filter(Boolean).join(theme.fg("dim", " · "));
						if (footer) container.addChild(new Text(theme.fg("dim", footer), 0, 0));
						const violations = violationLine(r);
						if (violations) container.addChild(new Text(violations, 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
					const stepSession = sessionLine(r, false);
					if (stepSession) text += `\n${stepSession}`;
					const violations = violationLine(r);
					if (violations) text += `\n${violations}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
