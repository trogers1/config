import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import subagentExtension from "../extensions/index.ts";
import {
	createFakeExtensionAPI,
	createFakeExtensionContext,
	createFakePi,
	makeTmpDir,
	type FakeExtensionAPI,
	type FakePiOptions,
} from "./helpers.ts";

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
		const api = createFakeExtensionAPI();
		subagentExtension(api);
		const tool = api.getRegisteredTools().find((t) => t.name === "subagent");
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

	async function runSingle(
		projectDir: string,
		fakePiOpts: FakePiOptions,
		params: Record<string, unknown>,
	) {
		const recordPath = join(projectDir, "spawn-record.jsonl");
		const fakePiPath = createFakePi(projectDir, { recordEnvPath: recordPath, ...fakePiOpts });
		process.env.PI_SUBAGENT_PI_PATH = fakePiPath;
		process.env.PI_SUBAGENT_TEST_RECORD = recordPath;

		const tool = loadTool();
		return tool.execute("tc", params, undefined, undefined, createFakeExtensionContext(projectDir));
	}

	it("delegates a single task and returns the worker output with resumable session metadata", async () => {
		const projectDir = setupProjectDir();
		const result = await runSingle(projectDir, { output: "Implemented the cache." }, {
			agent: "worker",
			task: "Add a cache to src/store.ts",
			writes: ["src"],
			label: "add-cache",
		});

		expect(result.isError).toBeFalsy();
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Implemented the cache.");
		expect(text).toMatch(/session: `[-0-9a-f]+`/);

		const records = spawnRecord(projectDir);
		expect(records).toHaveLength(1);
		expect(records[0].env.PI_SUBAGENT_PROFILE).toBe("worker");
		expect(records[0].env.PI_SUBAGENT_WRITE_GLOBS).toBe("src");
		expect(records[0].env.PI_SUBAGENT_DEPTH).toBe("1");
	});

	it("writes a handoff file when runDir is provided", async () => {
		const projectDir = setupProjectDir();
		const runDir = join(projectDir, ".pi", "orchestration", "run-1");

		const result = await runSingle(projectDir, { output: "Done" }, {
			agent: "worker",
			task: "Add a cache to src/store.ts",
			runDir,
			label: "add-cache",
		});

		expect(result.isError).toBeFalsy();

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

		const result = await runSingle(projectDir, { output: "Done", writeFile: "README.md" }, {
			agent: "worker",
			task: "Update documentation",
			writes: ["src"],
		});

		expect(result.isError).toBeFalsy();
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("⚠ OUT-OF-SCOPE EDITS");
		expect(text).toContain("README.md");
	});

	it("tracks bash edits via git snapshot when not running in parallel", async () => {
		const projectDir = setupProjectDir();

		const result = await runSingle(projectDir, { output: "Done", writeFile: "bash-created.txt" }, {
			agent: "worker",
			task: "Run a bash command",
		});

		expect(result.isError).toBeFalsy();
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("bash-created.txt");
	});

	it("passes a supplied sessionId through to the worker for warm resumes", async () => {
		const projectDir = setupProjectDir();

		const result = await runSingle(projectDir, { output: "Fixed." }, {
			agent: "worker",
			task: "Apply review feedback",
			sessionId: "resume-session-id",
		});

		expect(result.isError).toBeFalsy();
		const text = result.content[0]?.text ?? "";
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
		const result = await tool.execute(
			"tc",
			{
				tasks: [
					{ agent: "worker", task: "Task A", writes: ["src/a"], label: "a" },
					{ agent: "worker", task: "Task B", writes: ["src/b"], label: "b" },
				],
			},
			undefined,
			undefined,
			createFakeExtensionContext(projectDir),
		);

		expect(result.isError).toBeFalsy();
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Parallel: 2/2 succeeded");
		expect(text).toContain("Task A");
		expect(text).toContain("Task B");
		// parallel-bash.txt is created, but parallel workers do not use git snapshots.
		expect(text).not.toContain("parallel-bash.txt");

		const records = spawnRecord(projectDir);
		expect(records).toHaveLength(2);
		const writeGlobs = records.map((r) => r.env.PI_SUBAGENT_WRITE_GLOBS).sort();
		expect(writeGlobs).toEqual(["src/a", "src/b"]);
	});

	it("chains sequential steps and substitutes the previous output", async () => {
		const projectDir = setupProjectDir();
		const recordPath = join(projectDir, "spawn-record.jsonl");
		const fakePiPath = createFakePi(projectDir, { recordEnvPath: recordPath });
		process.env.PI_SUBAGENT_PI_PATH = fakePiPath;
		process.env.PI_SUBAGENT_TEST_RECORD = recordPath;

		const tool = loadTool();
		const result = await tool.execute(
			"tc",
			{
				chain: [
					{ agent: "scout", task: "Find the cache logic" },
					{ agent: "planner", task: "Plan changes based on: {previous}" },
				],
			},
			undefined,
			undefined,
			createFakeExtensionContext(projectDir),
		);

		expect(result.isError).toBeFalsy();
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Plan changes based on: Find the cache logic");

		const records = spawnRecord(projectDir);
		expect(records).toHaveLength(2);
	});

	it("stops a chain when a step fails", async () => {
		const projectDir = setupProjectDir();

		const result = await runSingle(projectDir, { output: "I failed.", exitCode: 1, stopReason: "error" }, {
			chain: [
				{ agent: "worker", task: "Step one" },
				{ agent: "worker", task: "Step two" },
			],
		});

		expect(result.isError).toBe(true);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Chain stopped at step 1");
		expect(text).toContain("I failed.");
		expect(text).not.toContain("Step two");
	});

	it("blocks nested delegation when already inside a worker", async () => {
		const tool = loadTool();
		process.env.PI_SUBAGENT_DEPTH = "1";

		const result = await tool.execute(
			"tc",
			{ agent: "worker", task: "Do something" },
			undefined,
			undefined,
			createFakeExtensionContext(process.cwd()),
		);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Nested delegation is disabled");
	});

	it("rejects calls that do not specify exactly one mode", async () => {
		const tool = loadTool();

		const result = await tool.execute(
			"tc",
			{ agent: "worker", task: "Do something", tasks: [{ agent: "worker", task: "Other" }] },
			undefined,
			undefined,
			createFakeExtensionContext(process.cwd()),
		);

		expect(result.isError).toBeFalsy();
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("Invalid parameters");
		expect(text).toContain("Available agents");
	});

	it("reports an unknown agent and lists the available agents", async () => {
		const projectDir = setupProjectDir();

		const result = await runSingle(projectDir, {}, { agent: "not-real", task: "Do something" });

		expect(result.isError).toBe(true);
		const text = result.content[0]?.text ?? "";
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
		const result = await tool.execute(
			"tc",
			{ agent: "custom", task: "Do something", agentScope: "project" },
			undefined,
			undefined,
			context,
		);

		expect(confirmCalled).toBe(true);
		expect(result.content[0].text).toContain("Canceled");
	});
});
