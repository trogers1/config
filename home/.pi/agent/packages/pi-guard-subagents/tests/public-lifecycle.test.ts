import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRegistry } from "../extensions/interactive/registry.ts";
import { parseOrThrow, TerminalSignalSchema } from "../extensions/interactive/types.ts";
import markerExtension from "./fixtures/marker-extension.ts";

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

function toolCall(response: ServerResponse, name: string, args: Record<string, unknown>, id: string): void {
	sse(response, [
		{
			id: "local",
			object: "chat.completion.chunk",
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
					},
					finish_reason: null,
				},
			],
		},
		{
			id: "local",
			object: "chat.completion.chunk",
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
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
				local: {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "local",
					models: [{ id: "deterministic" }],
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

describe("installed Pi public orchestration lifecycle", () => {
	it("fails public delegation without a tmux environment and never starts a headless worker", async () => {
		const work = mkdtempSync(join(tmpdir(), "pi-guard-outside-tmux-"));
		configureProjectAgent(work);
		let observedFailure = false;
		const server = createServer(async (request, response) => {
			const body = await readJsonBody(request);
			const serialized = JSON.stringify(messages(body));
			if (toolResultCount(body) === 0)
				return toolCall(
					response,
					"subagent",
					{
						agent: "worker",
						task: "MUST_NOT_RUN_HEADLESS",
						cwd: work,
						agentScope: "project",
						confirmProjectAgents: false,
					},
					"outside-tmux-launch",
				);
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
				return toolCall(
					response,
					"subagent",
					{ agent: "worker", task: "MUST_REQUIRE_CONFIRMATION", cwd: work, agentScope: "project" },
					"unconfirmed-project-agent",
				);
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
					return toolCall(
						response,
						"subagent",
						{
							agent: "extension-worker",
							task: "CHILD_EXTENSION_ISOLATION",
							cwd: work,
							agentScope: "project",
							confirmProjectAgents: false,
						},
						"launch-extension-child",
					);
				return text(response, "parent waiting");
			}
			if (!serialized.includes("CHILD_EXTENSION_ISOLATION")) return text(response, "idle");
			if (toolResultCount(body) === 0)
				return toolCall(response, "integration_marker", { value: "isolated" }, "permitted-extension-call");
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
						return toolCall(
							response,
							"subagent",
							{
								agent: "worker",
								task: "CHILD_SECURITY",
								cwd: work,
								writes: ["src/**"],
								agentScope: "project",
								confirmProjectAgents: false,
								runDir: ".pi/orchestration/public-security",
							},
							"parent-subagent",
						);
					return text(response, "parent waiting for child");
				}
				if (!serialized.includes("CHILD_SECURITY")) return text(response, "unexpected child scenario");
				const step = toolResultCount(body);
				if (step === 0)
					return toolCall(response, "write", { path: "src/allowed.txt", content: "allowed\n" }, "allowed-write");
				if (step === 1)
					return toolCall(response, "write", { path: "outside-write.txt", content: "blocked\n" }, "blocked-write");
				if (step === 2)
					return toolCall(
						response,
						"edit",
						{ path: "outside-edit.txt", edits: [{ oldText: "x", newText: "y" }] },
						"blocked-edit",
					);
				if (step === 3) return toolCall(response, "bash", { command: "cat outside-bash.txt" }, "blocked-bash");
				if (step === 4)
					return toolCall(
						response,
						"bash",
						{ command: "printf blocked > outside-redirection.txt" },
						"blocked-redirection",
					);
				if (step === 5)
					return toolCall(
						response,
						"subagent",
						{ agent: "worker", task: "NESTED_CHILD_MUST_NOT_START" },
						"nested-delegation-attempt",
					);
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

	it("parks for a real child question, answers through subagent_message, and resumes the same child safely", async () => {
		const work = mkdtempSync(join(tmpdir(), "pi-guard-question-"));
		configureProjectAgent(work);
		let questionObserved = false;
		const providerRequests: unknown[] = [];
		const server = createServer(async (request, response) => {
			try {
				const body = await readJsonBody(request);
				providerRequests.push(body);
				const serialized = JSON.stringify(messages(body));
				const tools = toolNames(body);
				if (tools.includes("subagent")) {
					if (!serialized.includes("PUBLIC_QUESTION")) return text(response, "parent idle");
					if (serialized.includes(" asks: ")) {
						questionObserved = true;
						const match = serialized.match(/worker-1-[a-f0-9]+/);
						if (!match) throw new Error("question notification omitted persistent child name");
						await new Promise((resolve) => setTimeout(resolve, 300));
						return toolCall(
							response,
							"subagent_message",
							{ name: match[0], message: "approved answer" },
							"answer-question",
						);
					}
					if (toolResultCount(body) === 0)
						return toolCall(
							response,
							"subagent",
							{
								agent: "worker",
								task: "CHILD_QUESTION",
								cwd: work,
								writes: ["src/**"],
								agentScope: "project",
								confirmProjectAgents: false,
								runDir: ".pi/orchestration/public-question",
							},
							"launch-question-child",
						);
					return text(response, "parent waiting");
				}
				if (!serialized.includes("CHILD_QUESTION")) return text(response, "unexpected child scenario");
				if (toolResultCount(body) === 0)
					return toolCall(response, "ask_question", { question: "continue integration?" }, "child-question");
				if (!serialized.includes("approved answer")) return text(response, "wrong answer");
				return text(response, "question scenario complete");
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
		sessions.push({ socket, session });
		const extension = join(process.cwd(), "extensions", "index.ts");
		const command = [
			`cd ${shellQuote(work)} &&`,
			`PI_CODING_AGENT_DIR=${shellQuote(agentDir)}`,
			`PI_GUARD_ACTIVE_PROFILE=${shellQuote("builtin:worker")}`,
			"pi --no-extensions",
			`-e ${shellQuote(extension)}`,
			"--model local/deterministic --tools subagent,subagent_message",
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
			const completed = await waitFor(
				() => {
					const child = loadRegistry(registryFile).children[0];
					return child?.state === "completed" && child.delivered && child.handoffPath ? child : undefined;
				},
				"answered child completion",
				25_000,
			);
			expect(questionObserved).toBe(true);
			expect(completed.questionAnswered).toBe(true);
			const question = JSON.parse(readFileSync(`${completed.loadoutPath}.question.json`, "utf8"));
			expect(isRecord(question) && question.answered === true).toBe(true);
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
							return toolCall(
								response,
								"subagent_message",
								{ name: launched[0], message: "RUNNING_GUIDANCE" },
								"steer-running-child",
							);
						}
					}
					if (serialized.includes("first completion") && !resumeRequested) {
						const match = serialized.match(/worker-1-[a-f0-9]+/);
						if (!match) throw new Error("completion omitted persistent child name");
						persistentName = match[0];
						resumeRequested = true;
						return toolCall(
							response,
							"subagent_message",
							{ name: match[0], message: "CHILD_RESUME_SECOND" },
							"resume-child",
						);
					}
					if (toolResultCount(body) === 0)
						return toolCall(
							response,
							"subagent",
							{
								agent: "worker",
								task: "CHILD_RESUME_FIRST",
								cwd: work,
								writes: ["src/**"],
								agentScope: "project",
								confirmProjectAgents: false,
								runDir: ".pi/orchestration/public-resume",
							},
							"launch-resume-child",
						);
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
						return toolCall(
							response,
							"subagent",
							{
								chain: [
									{ agent: "worker", task: "CHAIN_FIRST", cwd: work, writes: ["src/a/**"] },
									{ agent: "worker", task: "CHAIN_SECOND {previous}", cwd: work, writes: ["src/b/**"] },
								],
								agentScope: "project",
								confirmProjectAgents: false,
							},
							"launch-chain",
						);
					}
					if (toolResultCount(body) === 0)
						return toolCall(
							response,
							"subagent",
							{
								tasks: [
									{ agent: "worker", task: "PARALLEL_A", cwd: work, writes: ["src/a/**"] },
									{ agent: "worker", task: "PARALLEL_B", cwd: work, writes: ["src/b/**"] },
								],
								agentScope: "project",
								confirmProjectAgents: false,
							},
							"launch-parallel",
						);
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
					return toolCall(
						response,
						"subagent",
						{
							tasks: [
								{ agent: "worker", task: "PARTIAL_FIRST", cwd: work },
								{ agent: "worker", task: "PARTIAL_MUST_FAIL", cwd: join(work, "missing-cwd") },
							],
							agentScope: "project",
							confirmProjectAgents: false,
						},
						"partial-parallel-launch",
					);
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
					return toolCall(
						response,
						"subagent",
						{
							agent: "worker",
							task: "CHILD_RUNTIME_FAILURE",
							cwd: work,
							agentScope: "project",
							confirmProjectAgents: false,
						},
						"launch-runtime-failure",
					);
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
						return toolCall(
							response,
							"subagent",
							{
								chain: [
									{ agent: "worker", task: "CHAIN_PANE_FAILURE", cwd: work },
									{ agent: "worker", task: "MUST_NOT_LAUNCH", cwd: work },
								],
								agentScope: "project",
								confirmProjectAgents: false,
							},
							"launch-failing-chain",
						);
					return text(response, "parent observed chain failure");
				}
				if (serialized.includes("CHAIN_PANE_FAILURE"))
					return toolCall(response, "bash", { command: "sleep 20" }, "long-running-child");
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
						return toolCall(
							response,
							"subagent",
							{
								agent: "worker",
								task: "CHILD_RESTRICTED",
								cwd: work,
								writes: ["**"],
								agentScope: "project",
								confirmProjectAgents: false,
							},
							"launch-restricted",
						);
					return text(response, "parent waiting");
				}
				if (!serialized.includes("CHILD_RESTRICTED")) return text(response, "unexpected scenario");
				if (toolResultCount(body) === 0)
					return toolCall(response, "write", { path: "notes.md", content: "must not exist" }, "profile-write");
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
});
