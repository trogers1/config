import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildCommand } from "../extensions/interactive/launcher.ts";
import { parseOrThrow, TerminalSignalSchema, type GuardedInteractiveLoadout } from "../extensions/interactive/types.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Real-process availability smoke harness. This deliberately does not mock
 * tmux or Pi: npm test must fail when either runtime is unavailable. It loads
 * the package extension but does not exercise the full public lifecycle matrix.
 */
describe("real Pi/tmux availability smoke", () => {
	const socket = `pi-guard-subagents-${process.pid}`;
	const session = `pi-guard-subagents-${process.pid}`;
	let work: string;
	let parentPane: string;

	beforeAll(() => {
		work = mkdtempSync(join(tmpdir(), "pi-guard-subagents-integration-"));
		execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "-V"], { stdio: "ignore" });
		const marker = join(work, "pi-version.txt");
		execFileSync("pi", ["--version"], { stdio: "ignore" });
		execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "sh"], {
			stdio: "ignore",
		});
		parentPane = execFileSync("tmux", ["-L", socket, "display-message", "-p", "-t", session, "#{pane_id}"], {
			encoding: "utf8",
		}).trim();
		execFileSync("tmux", ["-L", socket, "split-window", "-d", "-t", session, "-h", "sh"], { stdio: "ignore" });
		const childPane = execFileSync("tmux", ["-L", socket, "list-panes", "-t", session, "-F", "#{pane_id}"], {
			encoding: "utf8",
		})
			.trim()
			.split("\n")[1];
		execFileSync("tmux", ["-L", socket, "send-keys", "-t", childPane, `pi --version > ${marker} 2>&1`, "Enter"], {
			stdio: "ignore",
		});
	});

	afterAll(() => {
		try {
			execFileSync("tmux", ["-L", socket, "kill-session", "-t", session], { stdio: "ignore" });
		} catch {
			/* already gone */
		}
		if (work) rmSync(work, { recursive: true, force: true });
	});

	it("starts a real Pi process in a real non-focused tmux pane", () => {
		const panes = execFileSync(
			"tmux",
			["-L", socket, "list-panes", "-t", session, "-F", "#{pane_id} #{pane_active} #{pane_current_command}"],
			{ encoding: "utf8" },
		);
		expect(panes.trim().split("\n")).toHaveLength(2);
		expect(panes).toMatch(new RegExp(`${parentPane} 1 `));
		execFileSync("sleep", ["0.1"]);
		expect(readFileSync(join(work, "pi-version.txt"), "utf8")).toBeDefined();
	});
});

describe("installed Pi guarded child lifecycle", () => {
	it("runs the unchanged generated command in a real tmux pane and writes terminal metadata", async () => {
		const work = mkdtempSync(join(tmpdir(), "pi-guard-subagents-child-"));
		const socket = `pi-guard-child-${process.pid}`;
		const session = `pi-guard-child-${process.pid}`;
		const sessionId = randomUUID();
		const loadoutPath = join(work, "loadout.json");
		const terminalPath = `${loadoutPath}.terminal.json`;
		let providerRequests = 0;
		const server = createServer((_request, response) => {
			providerRequests++;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				[
					`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "deterministic child complete" }, finish_reason: null }] })}`,
					`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
					"data: [DONE]",
					"",
				].join("\n\n"),
			);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("local provider did not bind");
		const agentConfig = join(work, "agent-config");
		mkdirSync(agentConfig, { recursive: true });
		writeFileSync(
			join(agentConfig, "models.json"),
			JSON.stringify({
				providers: {
					local: {
						baseUrl: `http://127.0.0.1:${address.port}/v1`,
						api: "openai-completions",
						apiKey: "local",
						models: [{ id: "deterministic" }],
					},
				},
			}),
		);
		const loadout = {
			version: 1,
			attemptId: randomUUID(),
			agent: "worker",
			profile: "builtin:worker",
			writes: ["src/**"],
			toolAllowlist: ["read", "write", "edit", "bash", "ask_question"],
			guardExtensionPath: join(process.cwd(), "../pi-guard/extensions/guard.ts"),
			childRuntimePath: join(process.cwd(), "extensions/interactive/child-runtime.ts"),
			backingExtensionPaths: [],
			backingExtensionDigests: [],
			model: "local/deterministic",
			thinking: null,
			systemPromptMode: null,
			identity: null,
			cwd: work,
			agentDir: null,
			codingAgentDir: agentConfig,
			autoExit: true,
		} satisfies GuardedInteractiveLoadout;
		writeFileSync(loadoutPath, JSON.stringify(loadout));
		try {
			execFileSync("tmux", ["-L", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "sh"], {
				stdio: "ignore",
			});
			execFileSync("tmux", ["-L", socket, "set-option", "-t", session, "remain-on-exit", "off"], { stdio: "ignore" });
			const command = buildChildCommand(loadout, sessionId, "respond with the deterministic result", loadoutPath);
			const childCommand = `PI_CODING_AGENT_DIR=${shellQuote(join(work, "agent-config"))} OPENAI_API_KEY=${shellQuote("local")} OPENAI_BASE_URL=${shellQuote(`http://127.0.0.1:${address.port}/v1`)} ${command}`;
			const pane = execFileSync(
				"tmux",
				["-L", socket, "split-window", "-d", "-P", "-F", "#{pane_id}", "-t", session, "-h", "sh", "-lc", childCommand],
				{ encoding: "utf8" },
			).trim();
			const until = Date.now() + 5_000;
			while (!fs.existsSync(terminalPath) && Date.now() < until)
				await new Promise((resolve) => setTimeout(resolve, 100));
			if (!fs.existsSync(terminalPath))
				execFileSync("tmux", ["-L", socket, "send-keys", "-t", pane, "C-c"], { stdio: "ignore" });
			const finalUntil = Date.now() + 10_000;
			while (!fs.existsSync(terminalPath) && Date.now() < finalUntil)
				await new Promise((resolve) => setTimeout(resolve, 100));
			if (!fs.existsSync(terminalPath)) {
				const paneOutput = execFileSync("tmux", ["-L", socket, "capture-pane", "-p", "-t", pane], { encoding: "utf8" });
				throw new Error(`child terminal was not written; pane output:\n${paneOutput}`);
			}
			const terminal = parseOrThrow(
				TerminalSignalSchema,
				JSON.parse(readFileSync(terminalPath, "utf8")),
				"real child terminal signal",
			);
			if (terminal.status !== "completed")
				throw new Error(`deterministic child failed: ${terminal.failure ?? "unknown"}`);
			expect(terminal.failure).toBeNull();
			expect(terminal.model).toBe("deterministic");
			if (!terminal.usage) throw new Error("successful child omitted usage metadata");
			expect(terminal.usage.totalTokens).toBeGreaterThan(0);
			expect(providerRequests).toBeGreaterThan(0);
			expect(terminal.result).toBe("deterministic child complete");
			const panes = execFileSync(
				"tmux",
				["-L", socket, "list-panes", "-t", session, "-F", "#{pane_id} #{pane_active} #{pane_dead}"],
				{ encoding: "utf8" },
			).trim();
			const parent = execFileSync("tmux", ["-L", socket, "display-message", "-p", "-t", session, "#{pane_id}"], {
				encoding: "utf8",
			}).trim();
			expect(panes).toContain(`${parent} 1 0`);
			const paneUntil = Date.now() + 5_000;
			let remainingPanes = panes;
			while (remainingPanes.split("\n").some((line) => line.startsWith(`${pane} `)) && Date.now() < paneUntil) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				remainingPanes = execFileSync(
					"tmux",
					["-L", socket, "list-panes", "-t", session, "-F", "#{pane_id} #{pane_active} #{pane_dead}"],
					{ encoding: "utf8" },
				).trim();
			}
			expect(remainingPanes).toBe(`${parent} 1 0`);
		} finally {
			try {
				execFileSync("tmux", ["-L", socket, "kill-session", "-t", session], { stdio: "ignore" });
			} catch {
				/* already gone */
			}
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(work, { recursive: true, force: true });
		}
	}, 20_000);
});

describe("installed Pi extension loading smoke", () => {
	it("loads an extension and produces its initialization marker", () => {
		const work = mkdtempSync(join(tmpdir(), "pi-guard-subagents-extension-"));
		const marker = join(work, "initialized.txt");
		try {
			execFileSync(
				"pi",
				[
					"--mode",
					"rpc",
					"--no-session",
					"-e",
					join(process.cwd(), "extensions/index.ts"),
					"-e",
					join(process.cwd(), "tests/fixtures/init-marker.ts"),
				],
				{
					input: '{"type":"get_state"}\n',
					encoding: "utf8",
					stdio: ["pipe", "ignore", "ignore"],
					env: { ...process.env, PI_GUARD_TEST_INIT_MARKER: marker },
				},
			);
			expect(readFileSync(marker, "utf8")).toContain("initialized");
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});
});
