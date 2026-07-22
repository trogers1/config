import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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
const event = {
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: output }],
    usage: {
      input: 100,
      output: 50,
      totalTokens: 150,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0.001 },
    },
    model: ${JSON.stringify(options.model ?? "fake-model")},
    stopReason: ${JSON.stringify(options.stopReason ?? "end")},
    ${options.errorMessage ? `errorMessage: ${JSON.stringify(options.errorMessage)},` : ""}
  },
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

export function createFakeExtensionContext(cwd: string, uiOverrides?: Partial<ExtensionContext["ui"]>): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		mode: "print",
		ui: {
			confirm: () => Promise.resolve(true),
			notify: () => {},
			select: () => Promise.resolve(undefined),
			input: () => Promise.resolve(undefined),
			setStatus: () => {},
			setWidget: () => {},
			setTitle: () => {},
			setEditorText: () => {},
			custom: () => Promise.resolve(undefined),
			...uiOverrides,
		},
		sessionManager: {
			getSessionFile: () => undefined,
		} as unknown as ExtensionContext["sessionManager"],
		signal: undefined,
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		modelRegistry: {} as unknown as ExtensionContext["modelRegistry"],
		model: undefined,
		isProjectTrusted: () => true,
	} as unknown as ExtensionContext;
}

export interface FakeExtensionAPI extends ExtensionAPI {
	getRegisteredTools(): Array<{ name: string; execute: (...args: any[]) => any }>;
}

export function createFakeExtensionAPI(): FakeExtensionAPI {
	const tools: Array<{ name: string; execute: (...args: any[]) => any }> = [];
	return {
		registerTool: (def: any) => {
			tools.push(def);
		},
		getRegisteredTools: () => tools,
		on: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerFlag: () => {},
		setActiveTools: () => {},
		getAllTools: () => tools,
		sendUserMessage: () => {},
		sendMessage: () => {},
		events: {
			on: () => () => {},
			emit: () => {},
		},
	} as unknown as FakeExtensionAPI;
}
