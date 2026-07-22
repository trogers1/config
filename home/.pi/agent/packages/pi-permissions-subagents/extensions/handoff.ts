/**
 * Handoff files: per-worker audit trail written to a run directory.
 *
 * The extension (not the worker) writes these files after each worker exits,
 * capturing what the worker did: task, files changed, session id, usage, and
 * final output. They are an audit artifact for humans and crash recovery —
 * the orchestrator receives results directly via the tool result.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface HandoffRecord {
	fileBase: string; // filename without extension, e.g. "01-worker-add-index"
	agent: string;
	agentSource: string;
	label?: string;
	task: string;
	model?: string;
	sessionId: string;
	sessionFile?: string;
	status: "completed" | "failed";
	stopReason?: string;
	errorMessage?: string;
	startedAt: Date;
	endedAt: Date;
	usage: UsageStats;
	writes?: string[];
	filesChanged: string[];
	scopeViolations: string[];
	finalOutput: string;
	workerCwd: string;
}

export function slugify(text: string, max = 40): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/g, "");
	return slug || "task";
}

/**
 * Files a worker changed via the write/edit tools. Changes made through bash
 * (e.g. `sed -i`, codegen scripts) are not visible here.
 */
export function extractFilesChanged(messages: Message[]): string[] {
	const changed = new Set<string>();
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content as any[]) {
			if (part?.type === "toolCall" && (part.name === "write" || part.name === "edit")) {
				const p = part.arguments?.path ?? part.arguments?.file_path;
				if (typeof p === "string" && p.trim()) changed.add(p);
			}
		}
	}
	return [...changed].sort();
}

function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

/**
 * Advisory scope check. Each `writes` entry is a path prefix relative to the
 * worker's cwd; a trailing `*` makes it a raw prefix match (glob-lite).
 * Returns the changed files that fall outside every declared prefix.
 */
export function checkScopeViolations(filesChanged: string[], writes: string[]): string[] {
	const prefixes = writes.map((w) => {
		const n = normalizePath(w);
		const star = n.endsWith("*");
		return { prefix: star ? n.slice(0, -1) : n, star };
	});
	return filesChanged.filter((f) => {
		const n = normalizePath(f);
		return !prefixes.some(({ prefix, star }) =>
			star ? n.startsWith(prefix) : n === prefix || n.startsWith(`${prefix}/`),
		);
	});
}

/**
 * Create the run directory if needed. If it lives under a `.pi/orchestration`
 * directory, drop a `.gitignore` containing `*` at that orchestration root so
 * run artifacts stay out of git by default.
 */
export function ensureRunDir(runDir: string): string {
	fs.mkdirSync(runDir, { recursive: true });

	const segments = runDir.split(path.sep);
	const orchIndex = segments.lastIndexOf("orchestration");
	if (orchIndex > 0 && segments[orchIndex - 1] === ".pi") {
		const orchRoot = segments.slice(0, orchIndex + 1).join(path.sep);
		const gitignorePath = path.join(orchRoot, ".gitignore");
		if (!fs.existsSync(gitignorePath)) {
			try {
				fs.writeFileSync(gitignorePath, "*\n", "utf-8");
			} catch {
				/* best effort */
			}
		}
	}
	return runDir;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

export function writeHandoffFile(runDir: string, rec: HandoffRecord): string {
	ensureRunDir(runDir);
	const filePath = path.join(runDir, `${rec.fileBase}.md`);
	const durationMs = rec.endedAt.getTime() - rec.startedAt.getTime();

	const lines: string[] = [
		`# Handoff: ${rec.agent}${rec.label ? ` — ${rec.label}` : ""}`,
		"",
		`- **Status**: ${rec.status}${rec.stopReason ? ` (${rec.stopReason})` : ""}`,
		`- **Agent**: ${rec.agent} (${rec.agentSource})`,
		`- **Model**: ${rec.model ?? "(pi default)"}`,
		`- **Worker cwd**: ${rec.workerCwd}`,
		`- **Session**: \`${rec.sessionId}\` — inspect/resume from the worker's project dir: \`pi --session ${rec.sessionId}\``,
	];
	if (rec.sessionFile) lines.push(`- **Session file**: ${rec.sessionFile}`);
	lines.push(
		`- **Started**: ${rec.startedAt.toISOString()}`,
		`- **Duration**: ${(durationMs / 1000).toFixed(1)}s`,
		`- **Usage**: ${rec.usage.turns} turns, ↑${formatTokens(rec.usage.input)} ↓${formatTokens(rec.usage.output)} R${formatTokens(rec.usage.cacheRead)} W${formatTokens(rec.usage.cacheWrite)} $${rec.usage.cost.toFixed(4)}`,
	);
	if (rec.writes?.length) lines.push(`- **Declared write scope**: ${rec.writes.map((w) => `\`${w}\``).join(", ")}`);
	if (rec.filesChanged.length) {
		lines.push(`- **Files changed** (write/edit + git status snapshot): ${rec.filesChanged.map((f) => `\`${f}\``).join(", ")}`);
	} else {
		lines.push(`- **Files changed**: none observed via write/edit or git status snapshot`);
	}
	if (rec.scopeViolations.length) {
		lines.push(`- **⚠ Out-of-scope edits**: ${rec.scopeViolations.map((f) => `\`${f}\``).join(", ")}`);
	}
	if (rec.errorMessage) lines.push(`- **Error**: ${rec.errorMessage}`);

	lines.push("", "## Task", "", rec.task, "", "## Final Output", "", rec.finalOutput || "(no output)", "");

	fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
	return filePath;
}
