/**
 * Agent discovery and configuration.
 *
 * Agents are markdown files with YAML frontmatter:
 *
 *   ---
 *   name: worker
 *   description: What this agent does
 *   tools: read, grep, find, ls   (optional; default = pi defaults)
 *   model: zai/glm-5.2            (optional; default = pi default model)
 *   ---
 *
 *   System prompt body...
 *
 * Discovery precedence (later overrides earlier by name):
 *   1. builtin  - agents shipped inside this package
 *   2. user     - ~/.pi/agent/agents
 *   3. project  - .pi/agents (nearest ancestor; only for scope "project"/"all")
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "builtin" | "user" | "project" | "all";
type AgentSource = "builtin" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	/** Fallback permissions profile when the parent does not expose an active profile. */
	profile?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * Render the discovered agents as prompt-ready delegation guidance. Keeping
 * this next to discovery makes the advertised names follow override precedence
 * instead of drifting from the actual dispatcher.
 */
export function formatAgentCatalog(agents: readonly AgentConfig[], scope: AgentScope): string {
	const entries = [...agents]
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((agent) => {
			const details = [
				`source: ${agent.source}`,
				agent.model ? `model: ${agent.model}` : "model: Pi default",
				agent.profile ? `profile: ${agent.profile}` : "profile: inherited/default",
				agent.tools?.length ? `tools: ${agent.tools.join(", ")}` : "tools: default child allowlist",
			].join("; ");
			return `- \`${agent.name}\` — ${agent.description} (${details})`;
		});

	return [
		"## Available guarded subagents",
		`Use the \`subagent\` tool to delegate. Its default \`agentScope\` is \`${scope}\`; the names below are exactly the names accepted in \`agent\`.`,
		...entries,
		"",
		"Invocation patterns:",
		'- One child: `subagent({ agent: "scout", task: "Map retry handling and report the relevant files." })`.',
		'- Parallel independent work: `subagent({ tasks: [{ agent: "worker", task: "…", writes: ["src/auth"] }, { agent: "reviewer", task: "…" }] })`.',
		'- Ordered work: `subagent({ chain: [{ agent: "scout", task: "…" }, { agent: "planner", task: "Plan from: {previous}" }] })`.',
		'- To include repository-defined agents, set `agentScope: "project"` or `"all"`; project agents require confirmation unless explicitly disabled by the caller.',
		"- Children are interactive tmux panes. Launches return immediately: do not poll or sleep. Child questions and final results arrive automatically. Use `subagent_message({ name, message })` only to steer a running child, answer its question, or resume a completed child.",
	].join("\n");
}

const BUILTIN_AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			profile: frontmatter.profile,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const includeUser = scope === "user" || scope === "all";
	const includeProject = scope === "project" || scope === "all";

	const agentMap = new Map<string, AgentConfig>();

	// Later sources override earlier ones by name.
	for (const agent of loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin")) agentMap.set(agent.name, agent);
	if (includeUser) {
		for (const agent of loadAgentsFromDir(userDir, "user")) agentMap.set(agent.name, agent);
	}
	if (includeProject && projectAgentsDir) {
		for (const agent of loadAgentsFromDir(projectAgentsDir, "project")) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
