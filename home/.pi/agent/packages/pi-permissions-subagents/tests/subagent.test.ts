import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import subagentExtension, { KNOWN_STOP_REASONS, workerCompactionThreshold } from "../extensions/index.ts";
import {
	createCompactionCycleFakePi,
	createExtensionRegistrationRecorder,
	createFakeExtensionContext,
	createFakePi,
	getToolResultText,
	invokeRegisteredTool,
	makeTmpDir,
	type FakePiOptions,
} from "./helpers.ts";

describe("workerCompactionThreshold", () => {
	it("is 40% of the context window, capped at 150k", () => {
		expect(workerCompactionThreshold(262_144)).toBeCloseTo(104_857.6);
		expect(workerCompactionThreshold(200_000)).toBe(80_000);
		expect(workerCompactionThreshold(1_000_000)).toBe(150_000);
		expect(workerCompactionThreshold(32_000)).toBeCloseTo(12_800);
	});
});

describe("KNOWN_STOP_REASONS", () => {
	it("is derived from the stopReason schema's literal arms", () => {
		// Literal arms of StopReasonSchema are accepted as known (no warning).
		expect(KNOWN_STOP_REASONS.has("stop")).toBe(true);
		expect(KNOWN_STOP_REASONS.has("toolUse")).toBe(true);
		expect(KNOWN_STOP_REASONS.has("pending")).toBe(true);
		// The Type.String() fallback arm contributes no value, and arbitrary
		// strings are not known.
		expect(KNOWN_STOP_REASONS.has("not-a-known-reason")).toBe(false);
	});
});

describe("subagent tool", () => {
	const originalPiPath = process.env.PI_SUBAGENT_PI_PATH;
	const originalRecordPath = process.env.PI_SUBAGENT_TEST_RECORD;

	beforeEach(() => {
		delete process.env.PI_SUBAGENT_PI_PATH;
		delete process.env.PI_SUBAGENT_TEST_RECORD;
		delete process.env.PI_SUBAGENT_DEPTH;
	});

	afterEach(() => {
		process.env.PI_SUBAGENT_PI_PATH = originalPiPath ?? "";
		process.env.PI_SUBAGENT_TEST_RECORD = originalRecordPath ?? "";
		delete process.env.PI_SUBAGENT_DEPTH;
	});

	function loadTool() {
		const recorder = createExtensionRegistrationRecorder();
		subagentExtension(recorder.api);
		const tool = recorder.getRegisteredTools().find((candidate) => candidate.name === "subagent");
		if (!tool) throw new Error("subagent tool not registered");
		return tool;
	}

	function setupProjectDir(): string {
		const projectDir = makeTmpDir("subagent-project-");
		execSync("git init", { cwd: projectDir, stdio: "ignore" });
		mkdirSync(join(projectDir, "src"), { recursive: true });
		return projectDir;
	}

	function spawnRecord(projectDir: string): Array<{ args: string[]; env: Record<string, string | undefined> }> {
		const recordPath = join(projectDir, "spawn-record.jsonl");
		if (!existsSync(recordPath)) return [];
		return readFileSync(recordPath, "utf-8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	}

	async function runSingle(projectDir: string, fakePiOpts: FakePiOptions, params: Record<string, unknown>) {
		const recordPath = join(projectDir, "spawn-record.jsonl");
		const fakePiPath = createFakePi(projectDir, {
			recordEnvPath: recordPath,
			...fakePiOpts,
		});
		process.env.PI_SUBAGENT_PI_PATH = fakePiPath;
		process.env.PI_SUBAGENT_TEST_RECORD = recordPath;

		const tool = loadTool();
		return invokeRegisteredTool(tool, params, createFakeExtensionContext(projectDir));
	}

	it("delegates a single task and returns the worker output with resumable session metadata", async () => {
		const projectDir = setupProjectDir();
		const result = await runSingle(
			projectDir,
			{ output: "Implemented the cache." },
			{
				agent: "worker",
				task: "Add a cache to src/store.ts",
				writes: ["src"],
				label: "add-cache",
			},
		);

		const text = getToolResultText(result);
		expect(text).toContain("Implemented the cache.");
		expect(text).toMatch(/session: `[-0-9a-f]+`/);

		const records = spawnRecord(projectDir);
		expect(records).toHaveLength(1);
		expect(records[0].env.PI_SUBAGENT_PROFILE).toBe("builtin:worker");
		expect(records[0].env.PI_SUBAGENT_PERMISSIBLE_GLOBS).toBe("src");
		expect(records[0].env.PI_SUBAGENT_DEPTH).toBe("1");
	});

	it("validates parameters against the registered TypeBox schema before execution", async () => {
		const tool = loadTool();

		await expect(
			invokeRegisteredTool(tool, { agent: 42, task: "Do something" }, createFakeExtensionContext(process.cwd())),
		).rejects.toThrow();
	});

	it("fails loudly on malformed worker events at the JSON protocol boundary", async () => {
		const projectDir = setupProjectDir();
		const result = await runSingle(
			projectDir,
			{
				rawEvent: {
					type: "message_end",
					message: { role: "assistant", content: "not-an-array" },
				},
			},
			{ agent: "worker", task: "Do something" },
		);

		expect((result as { isError?: boolean }).isError).toBe(true);
		const text = getToolResultText(result);
		expect(text).toContain("failed schema validation");
		// Pinpoints the failing field with a concrete path and shows the payload.
		expect(text).toContain("/message/content");
		expect(text).toContain('"not-an-array"');
	});

	it("warns and continues when a worker event is missing non-essential bookkeeping fields", async () => {
		const projectDir = setupProjectDir();
		const warnings: string[] = [];
		const recordPath = join(projectDir, "spawn-record.jsonl");
		process.env.PI_SUBAGENT_PI_PATH = createFakePi(projectDir, {
			recordEnvPath: recordPath,
			rawEvent: {
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Done despite drift." }],
					// No api/provider/model/usage/stopReason/timestamp.
				},
			},
		});
		process.env.PI_SUBAGENT_TEST_RECORD = recordPath;

		const tool = loadTool();
		const ctx = createFakeExtensionContext(projectDir, {
			notify: (message) => warnings.push(message),
		});
		const result = await invokeRegisteredTool(tool, { agent: "worker", task: "Do something" }, ctx);

		expect((result as { isError?: boolean }).isError).not.toBe(true);
		expect(getToolResultText(result)).toContain("Done despite drift.");
		expect(warnings.some((w) => w.includes("degraded bookkeeping") && w.includes("usage"))).toBe(true);
	});

	it("warns via notify when a worker reports an unrecognized stop reason", async () => {
		const projectDir = setupProjectDir();
		const warnings: string[] = [];
		const recordPath = join(projectDir, "spawn-record.jsonl");
		process.env.PI_SUBAGENT_PI_PATH = createFakePi(projectDir, {
			output: "Did the thing.",
			stopReason: "not-a-known-reason",
			recordEnvPath: recordPath,
		});
		process.env.PI_SUBAGENT_TEST_RECORD = recordPath;

		const tool = loadTool();
		const ctx = createFakeExtensionContext(projectDir, {
			notify: (message) => warnings.push(message),
		});
		const result = await invokeRegisteredTool(tool, { agent: "worker", task: "Do something" }, ctx);

		expect(warnings.some((w) => w.includes("not-a-known-reason"))).toBe(true);
		expect(getToolResultText(result)).toContain("Did the thing.");
	});

	it("writes a handoff file when runDir is provided", async () => {
		const projectDir = setupProjectDir();
		const runDir = join(projectDir, ".pi", "orchestration", "run-1");

		await runSingle(
			projectDir,
			{ output: "Done" },
			{
				agent: "worker",
				task: "Add a cache to src/store.ts",
				runDir,
				label: "add-cache",
			},
		);

		const handoffPath = join(runDir, "handoff-worker-add-cache.md");
		expect(existsSync(handoffPath)).toBe(true);

		const handoff = readFileSync(handoffPath, "utf-8");
		expect(handoff).toContain("Add a cache to src/store.ts");

		const gitignorePath = join(projectDir, ".pi", "orchestration", ".gitignore");
		expect(existsSync(gitignorePath)).toBe(true);
		expect(readFileSync(gitignorePath, "utf-8")).toBe("*\n");
	});

	it("flags out-of-scope edits against declared writes", async () => {
		const projectDir = setupProjectDir();

		const result = await runSingle(
			projectDir,
			{ output: "Done", writeFile: "README.md" },
			{
				agent: "worker",
				task: "Update documentation",
				writes: ["src"],
			},
		);

		const text = getToolResultText(result);
		expect(text).toContain("⚠ OUT-OF-SCOPE EDITS");
		expect(text).toContain("README.md");
	});

	it("tracks bash edits via git snapshot when not running in parallel", async () => {
		const projectDir = setupProjectDir();

		const result = await runSingle(
			projectDir,
			{ output: "Done", writeFile: "bash-created.txt" },
			{
				agent: "worker",
				task: "Run a bash command",
			},
		);

		const text = getToolResultText(result);
		expect(text).toContain("bash-created.txt");
	});

	it("passes a supplied sessionId through to the worker for warm resumes", async () => {
		const projectDir = setupProjectDir();

		const result = await runSingle(
			projectDir,
			{ output: "Fixed." },
			{
				agent: "worker",
				task: "Apply review feedback",
				sessionId: "resume-session-id",
			},
		);

		const text = getToolResultText(result);
		expect(text).toContain("session: `resume-session-id`");

		const records = spawnRecord(projectDir);
		expect(records[0].args).toContain("resume-session-id");
	});

	it("runs parallel tasks and aggregates their results without git-snapshot cross-contamination", async () => {
		const projectDir = setupProjectDir();
		const recordPath = join(projectDir, "spawn-record.jsonl");
		const fakePiPath = createFakePi(projectDir, {
			recordEnvPath: recordPath,
			writeFile: "parallel-bash.txt",
		});
		process.env.PI_SUBAGENT_PI_PATH = fakePiPath;
		process.env.PI_SUBAGENT_TEST_RECORD = recordPath;

		const tool = loadTool();
		const result = await invokeRegisteredTool(
			tool,
			{
				tasks: [
					{ agent: "worker", task: "Task A", writes: ["src/a"], label: "a" },
					{ agent: "worker", task: "Task B", writes: ["src/b"], label: "b" },
				],
			},
			createFakeExtensionContext(projectDir),
		);

		const text = getToolResultText(result);
		expect(text).toContain("Parallel: 2/2 succeeded");
		expect(text).toContain("Task A");
		expect(text).toContain("Task B");
		// parallel-bash.txt is created, but parallel workers do not use git snapshots.
		expect(text).not.toContain("parallel-bash.txt");

		const records = spawnRecord(projectDir);
		expect(records).toHaveLength(2);
		const permissibleGlobs = records.map((r) => r.env.PI_SUBAGENT_PERMISSIBLE_GLOBS).sort();
		expect(permissibleGlobs).toEqual(["src/a", "src/b"]);
	});

	it("chains sequential steps and substitutes the previous output", async () => {
		const projectDir = setupProjectDir();
		const recordPath = join(projectDir, "spawn-record.jsonl");
		const fakePiPath = createFakePi(projectDir, { recordEnvPath: recordPath });
		process.env.PI_SUBAGENT_PI_PATH = fakePiPath;
		process.env.PI_SUBAGENT_TEST_RECORD = recordPath;

		const tool = loadTool();
		const result = await invokeRegisteredTool(
			tool,
			{
				chain: [
					{ agent: "scout", task: "Find the cache logic" },
					{ agent: "planner", task: "Plan changes based on: {previous}" },
				],
			},
			createFakeExtensionContext(projectDir),
		);

		const text = getToolResultText(result);
		expect(text).toContain("Plan changes based on: Find the cache logic");

		const records = spawnRecord(projectDir);
		expect(records).toHaveLength(2);
	});

	it("stops a chain when a step fails", async () => {
		const projectDir = setupProjectDir();

		const result = await runSingle(
			projectDir,
			{ output: "I failed.", exitCode: 1, stopReason: "error" },
			{
				chain: [
					{ agent: "worker", task: "Step one" },
					{ agent: "worker", task: "Step two" },
				],
			},
		);

		const text = getToolResultText(result);
		expect(text).toContain("Chain stopped at step 1");
		expect(text).toContain("I failed.");
		expect(text).not.toContain("Step two");
	});

	it.each(["toolUse", "length"])(
		"treats a clean exit with mid-turn stop reason %s as a failure",
		async (stopReason) => {
			const projectDir = setupProjectDir();

			const result = await runSingle(
				projectDir,
				{ output: "partial work", stopReason },
				{ agent: "worker", task: "Do something" },
			);

			const text = getToolResultText(result);
			expect(text).toContain(`Agent failed (${stopReason})`);
			expect(text).toContain("partial work");
		},
	);

	it("kills an over-threshold worker, compacts its session via RPC, and resumes it", async () => {
		const projectDir = setupProjectDir();
		const recordPath = join(projectDir, "spawn-record.jsonl");
		process.env.PI_SUBAGENT_PI_PATH = createCompactionCycleFakePi(projectDir);
		process.env.PI_SUBAGENT_TEST_RECORD = recordPath;

		const tool = loadTool();
		const result = await invokeRegisteredTool(
			tool,
			{ agent: "worker", task: "Do something long" },
			createFakeExtensionContext(projectDir),
		);

		const text = getToolResultText(result);
		expect(text).toContain("done after compaction");
		expect(text).toContain("compactions: 1");

		const records = spawnRecord(projectDir);
		expect(records).toHaveLength(3);
		expect(records[0].args).toContain("json"); // print-mode worker
		expect(records[1].args).toContain("rpc"); // compaction one-shot
		expect(records[2].args).toContain("json"); // resumed worker
		expect(records[2].args.some((a) => a.includes("Continue the delegated task"))).toBe(true);

		const sessionIdOf = (args: string[]) => args[args.indexOf("--session-id") + 1];
		expect(sessionIdOf(records[1].args)).toBe(sessionIdOf(records[0].args));
		expect(sessionIdOf(records[2].args)).toBe(sessionIdOf(records[0].args));
	});

	it("blocks nested delegation when already inside a worker", async () => {
		const tool = loadTool();
		process.env.PI_SUBAGENT_DEPTH = "1";

		const result = await invokeRegisteredTool(
			tool,
			{ agent: "worker", task: "Do something" },
			createFakeExtensionContext(process.cwd()),
		);

		expect(getToolResultText(result)).toContain("Nested delegation is disabled");
	});

	it("rejects calls that do not specify exactly one mode", async () => {
		const tool = loadTool();

		const result = await invokeRegisteredTool(
			tool,
			{
				agent: "worker",
				task: "Do something",
				tasks: [{ agent: "worker", task: "Other" }],
			},
			createFakeExtensionContext(process.cwd()),
		);

		const text = getToolResultText(result);
		expect(text).toContain("Invalid parameters");
		expect(text).toContain("Available agents");
	});

	it("reports an unknown agent and lists the available agents", async () => {
		const projectDir = setupProjectDir();

		const result = await runSingle(projectDir, {}, { agent: "not-real", task: "Do something" });

		const text = getToolResultText(result);
		expect(text).toContain('Unknown agent: "not-real"');
		expect(text).toContain("worker");
		expect(text).toContain("scout");
	});

	it("prompts for approval before running project-local agents", async () => {
		const projectDir = setupProjectDir();
		const agentsDir = join(projectDir, ".pi", "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(
			join(agentsDir, "custom.md"),
			["---", "name: custom", "description: A project-local agent", "---", "", "You are custom."].join("\n"),
		);

		let confirmCalled = false;
		const context = createFakeExtensionContext(projectDir, {
			confirm: async (_title, _body) => {
				confirmCalled = true;
				return false;
			},
		});
		context.hasUI = true;

		const recordPath = join(projectDir, "spawn-record.jsonl");
		const fakePiPath = createFakePi(projectDir, { recordEnvPath: recordPath });
		process.env.PI_SUBAGENT_PI_PATH = fakePiPath;
		process.env.PI_SUBAGENT_TEST_RECORD = recordPath;

		const tool = loadTool();
		const result = await invokeRegisteredTool(
			tool,
			{ agent: "custom", task: "Do something", agentScope: "project" },
			context,
		);

		expect(confirmCalled).toBe(true);
		expect(getToolResultText(result)).toContain("Canceled");
	});
});
