import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import Value from "typebox/value";

export interface FakePiOptions {
	/** Text the fake worker will output in its final assistant message. If omitted, the fake worker echoes the task. */
	output?: string;
	/** Relative path (to the worker cwd) of a file the fake worker will create before exiting. */
	writeFile?: string;
	/** Path to a JSONL file where each spawn records its argv and permission env vars. */
	recordEnvPath?: string;
	/** Exit code for the fake worker process. */
	exitCode?: number;
	/** Stop reason reported in the final message. */
	stopReason?: string;
	/** Error message reported in the final message. */
	errorMessage?: string;
	/** Model reported in the final message. */
	model?: string;
	/** Replace the normal message_end event, for protocol-boundary tests. */
	rawEvent?: unknown;
}

/**
 * Creates a fake `pi` executable for testing the subagent extension without
 * calling a real model. The script records its invocation and emits a single
 * JSON-mode event stream line, mirroring how the real worker reports results.
 */
export function createFakePi(tmpDir: string, options: FakePiOptions = {}): string {
	const script = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const recordPath = process.env.PI_SUBAGENT_TEST_RECORD;
if (recordPath) {
  fs.appendFileSync(recordPath, JSON.stringify({
    args,
    env: {
      PI_SUBAGENT_PROFILE: process.env.PI_SUBAGENT_PROFILE,
      PI_SUBAGENT_PERMISSIBLE_GLOBS: process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS,
      PI_SUBAGENT_DEPTH: process.env.PI_SUBAGENT_DEPTH,
    }
  }) + '\\n');
}
${options.writeFile ? `fs.writeFileSync(${JSON.stringify(join(tmpDir, options.writeFile))}, 'created by fake pi');` : ""}
const taskArg = args.find(a => a.startsWith('Task: '));
const output = ${JSON.stringify(options.output ?? null)} ?? (taskArg ? taskArg.slice(6) : 'Done');
const event = ${
		options.rawEvent === undefined
			? `{
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: output }],
    api: "fake",
    provider: "fake",
    usage: {
      input: 100,
      output: 50,
      totalTokens: 150,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0.0005, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.001 },
    },
    model: ${JSON.stringify(options.model ?? "fake-model")},
    stopReason: ${JSON.stringify(options.stopReason ?? "stop")},
    timestamp: Date.now(),
    ${options.errorMessage ? `errorMessage: ${JSON.stringify(options.errorMessage)},` : ""}
  },
}`
			: JSON.stringify(options.rawEvent)
	};
console.log(JSON.stringify(event));
process.exit(${options.exitCode ?? 0});
`;
	const filePath = join(tmpDir, "fake-pi.js");
	writeFileSync(filePath, script, { mode: 0o755 });
	return filePath;
}

export function makeTmpDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Fake `pi` for the parent-side compaction cycle. Behavior per spawn (tracked
 * via a counter file, since each spawn is a fresh process):
 *  1. print-mode worker: reports a mid-turn turn_end with a huge context and
 *     stays alive until SIGTERM (the parent kills it for compaction);
 *  2. rpc-mode compactor: answers the compact command with compaction_end;
 *  3. resumed print-mode worker: finishes with a normal stop.
 */
export function createCompactionCycleFakePi(tmpDir: string): string {
	const assistantMessage = (text: string, stopReason: string, totalTokens: number) => `{
  role: "assistant",
  content: [{ type: "text", text: ${JSON.stringify(text)} }],
  api: "fake",
  provider: "fake",
  model: "fake-model",
  usage: {
    input: ${totalTokens}, output: 50, totalTokens: ${totalTokens}, cacheRead: 0, cacheWrite: 0,
    cost: { input: 0.0005, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.001 },
  },
  stopReason: ${JSON.stringify(stopReason)},
  timestamp: Date.now(),
}`;

	const script = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const recordPath = process.env.PI_SUBAGENT_TEST_RECORD;
if (recordPath) {
  fs.appendFileSync(recordPath, JSON.stringify({ args }) + '\\n');
}
const counterFile = ${JSON.stringify(join(tmpDir, "cycle-spawn-count"))};
let count = 0;
try { count = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0; } catch {}
fs.writeFileSync(counterFile, String(count + 1));

const emit = (obj) => console.log(JSON.stringify(obj));
const stayAlive = () => setInterval(() => {}, 1000);

if (args.includes('rpc')) {
  // Compaction one-shot: answer the compact command on stdin, then wait to be killed.
  let stdin = '';
  process.stdin.on('data', (d) => {
    stdin += d;
    if (!stdin.includes('\\n')) return;
    emit({ type: 'compaction_start', reason: 'manual' });
    emit({
      type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false,
      result: { summary: 's', firstKeptEntryId: 'x', tokensBefore: 120100, estimatedTokensAfter: 20000 },
    });
  });
  process.stdin.resume();
  stayAlive();
} else if (count === 0) {
  // First worker spawn: over-threshold context mid-turn; wait to be killed.
  const msg = ${assistantMessage("working on it", "toolUse", 120100)};
  emit({ type: 'message_end', message: msg });
  emit({ type: 'turn_end', message: msg });
  stayAlive();
} else {
  // Resumed worker spawn: finish normally.
  emit({ type: 'message_end', message: ${assistantMessage("done after compaction", "stop", 20100)} });
  process.exit(0);
}
`;
	const filePath = join(tmpDir, "fake-pi-cycle.js");
	writeFileSync(filePath, script, { mode: 0o755 });
	return filePath;
}

export function createFakeExtensionContext(
	cwd: string,
	uiOverrides?: Partial<Pick<ExtensionContext["ui"], "confirm" | "notify">>,
): ExtensionContext {
	const ui = {
		confirm: uiOverrides?.confirm ?? (() => Promise.resolve(false)),
		notify: uiOverrides?.notify ?? (() => {}),
	} satisfies Pick<ExtensionContext["ui"], "confirm" | "notify">;
	const context = {
		cwd,
		hasUI: false,
		// The subagent tool only calls confirm; do not fake unrelated UI behavior.
		ui: ui as ExtensionContext["ui"],
	} satisfies Pick<ExtensionContext, "cwd" | "hasUI" | "ui">;

	// Tool execution only reads this narrow context surface. Keep the partial-runtime
	// cast at this single boundary so SDK changes to the used members remain checked.
	return context as ExtensionContext;
}

type RegisteredTool = ToolDefinition<TSchema, unknown, unknown>;
type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

export interface ExtensionRegistrationRecorder {
	api: ExtensionAPI;
	getRegisteredTools(): readonly RegisteredTool[];
	getEventHandlers(event: string): readonly EventHandler[];
}

export function createExtensionRegistrationRecorder(): ExtensionRegistrationRecorder {
	const tools: RegisteredTool[] = [];
	const eventHandlers = new Map<string, EventHandler[]>();
	const api = {
		registerTool<TParams extends TSchema, TDetails, TState>(tool: ToolDefinition<TParams, TDetails, TState>) {
			// Erasure is confined to storage; invocation validates the retained schema.
			tools.push(tool as RegisteredTool);
		},
		on(event: string, handler: EventHandler) {
			const handlers = eventHandlers.get(event) ?? [];
			handlers.push(handler);
			eventHandlers.set(event, handlers);
		},
	} satisfies Pick<ExtensionAPI, "registerTool"> & Record<"on", unknown>;

	return {
		// Extensions receive the full API in Pi. This extension only uses registerTool and on.
		api: api as ExtensionAPI,
		getRegisteredTools: () => tools,
		getEventHandlers: (event) => eventHandlers.get(event) ?? [],
	};
}

export interface InvokeRegisteredToolOptions<TDetails> {
	toolCallId?: string;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<TDetails>;
}

export function getToolResultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/** Invoke a registered tool with Pi's prepare-then-schema-validation ordering. */
export async function invokeRegisteredTool<TParams extends TSchema, TDetails>(
	tool: ToolDefinition<TParams, TDetails>,
	params: unknown,
	ctx: ExtensionContext,
	options: InvokeRegisteredToolOptions<TDetails> = {},
): Promise<AgentToolResult<TDetails>> {
	const prepared = tool.prepareArguments ? tool.prepareArguments(params) : params;
	Value.Assert(tool.parameters, prepared);
	return tool.execute(options.toolCallId ?? "tc", prepared, options.signal, options.onUpdate, ctx);
}
