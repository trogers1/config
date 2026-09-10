import { describe, expect, it } from "vitest";
import { formatAgentCatalog, type AgentConfig } from "../extensions/agents.ts";

const agents = [
	{
		name: "worker",
		description: "Implements an isolated task",
		model: "openai/gpt-5.6-luna",
		profile: "builtin:worker",
		systemPrompt: "",
		source: "builtin",
		filePath: "/agents/worker.md",
	},
	{
		name: "scout",
		description: "Maps a codebase",
		tools: ["read", "grep"],
		systemPrompt: "",
		source: "user",
		filePath: "/agents/scout.md",
	},
] satisfies AgentConfig[];

describe("subagent catalog prompt", () => {
	it("lists the resolved names and concrete single, parallel, and chain invocation patterns", () => {
		const catalog = formatAgentCatalog(agents, "user");

		expect(catalog).toContain("Available guarded subagents");
		expect(catalog).toContain("`scout` — Maps a codebase (source: user");
		expect(catalog).toContain("`worker` — Implements an isolated task (source: builtin");
		expect(catalog.indexOf("`scout`")).toBeLessThan(catalog.indexOf("`worker`"));
		expect(catalog).toContain('subagent({ agent: "scout", task:');
		expect(catalog).toContain("subagent({ tasks:");
		expect(catalog).toContain("subagent({ chain:");
		expect(catalog).toContain('agentScope: "project"');
		expect(catalog).toContain("subagent_message({ name, message })");
	});
});
