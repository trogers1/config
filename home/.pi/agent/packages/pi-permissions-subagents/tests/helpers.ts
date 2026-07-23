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
      PI_SUBAGENT_WRITE_GLOBS: process.env.PI_SUBAGENT_WRITE_GLOBS,
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

export function createFakeExtensionContext(
	cwd: string,
	uiOverrides?: Partial<Pick<ExtensionContext["ui"], "confirm">>,
): ExtensionContext {
	const ui = {
		confirm: uiOverrides?.confirm ?? (() => Promise.resolve(false)),
	} satisfies Pick<ExtensionContext["ui"], "confirm">;
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

export interface ExtensionRegistrationRecorder {
	api: ExtensionAPI;
	getRegisteredTools(): readonly RegisteredTool[];
}

export function createExtensionRegistrationRecorder(): ExtensionRegistrationRecorder {
	const tools: RegisteredTool[] = [];
	const api = {
		registerTool<TParams extends TSchema, TDetails, TState>(tool: ToolDefinition<TParams, TDetails, TState>) {
			// Erasure is confined to storage; invocation validates the retained schema.
			tools.push(tool as RegisteredTool);
		},
	} satisfies Pick<ExtensionAPI, "registerTool">;

	return {
		// Extensions receive the full API in Pi. This extension only uses registerTool.
		api: api as ExtensionAPI,
		getRegisteredTools: () => tools,
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
