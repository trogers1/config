import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Decision = "allow" | "ask" | "deny";

type Rule = {
	pattern: string;
	decision: Decision;
};

type Policy = {
	defaultBashDecision: Decision;
	bash: Rule[];
	readDeniedPathParts: string[];
	pathTools: string[];
	readOnlyPathTools: string[];
	writeTools: string[];
	askBeforeExternalDirectoryAccess: boolean;
};

const defaultPolicy: Policy = {
	defaultBashDecision: "ask",
	bash: [{ pattern: "*", decision: "ask" }],
	readDeniedPathParts: [".env", ".git"],
	pathTools: ["read", "write", "edit", "grep", "find", "ls"],
	readOnlyPathTools: ["read", "grep", "find", "ls"],
	writeTools: ["write", "edit"],
	askBeforeExternalDirectoryAccess: true,
};

const moduleDir = typeof __dirname === "string" ? __dirname : process.cwd();
const policy = loadPolicy(path.resolve(moduleDir, "../policy.jsonc"));
const readDeniedPathParts = new Set(policy.readDeniedPathParts);
const pathToolNames = new Set(policy.pathTools);
const readOnlyPathToolNames = new Set(policy.readOnlyPathTools);
const writeToolNames = new Set(policy.writeTools);

export default function (pi: ExtensionAPI) {
	const startupCwd = path.resolve(process.cwd());

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("permissions", "permissions: curated");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("permissions", undefined);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			const command = String((event.input as { command?: unknown }).command ?? "");
			return await gateBash(command, startupCwd, ctx, policy);
		}

		if (!pathToolNames.has(event.toolName)) return undefined;

		const requestedPath = toolPath(event.toolName, event.input);
		const absolutePath = resolveRequestedPath(requestedPath, ctx.cwd ?? startupCwd);

		if (readOnlyPathToolNames.has(event.toolName) && isDeniedReadPath(absolutePath, readDeniedPathParts)) {
			return { block: true, reason: `Reading protected path is denied: ${displayPath(absolutePath, startupCwd)}` };
		}

		if (policy.askBeforeExternalDirectoryAccess && isOutside(absolutePath, startupCwd)) {
			const ok = await confirmOrBlock(
				ctx,
				"Access outside startup directory?",
				`${event.toolName} wants to access:\n${absolutePath}\n\nPi was started in:\n${startupCwd}`,
			);
			if (!ok) return { block: true, reason: `Access outside startup directory was not approved: ${absolutePath}` };
		}

		if (writeToolNames.has(event.toolName)) {
			const ok = await confirmOrBlock(
				ctx,
				`Allow ${event.toolName}?`,
				`${event.toolName} wants to modify:\n${absolutePath}`,
			);
			if (!ok) return { block: true, reason: `${event.toolName} was not approved: ${absolutePath}` };
		}

		return undefined;
	});
}

export async function gateBash(command: string, startupCwd: string, ctx: ExtensionContext, activePolicy = policy) {
	const commands = extractShellCommands(command).map(normalizeCommandForDecision).filter(Boolean);
	const decisions = commands.length > 0 ? commands.map((cmd) => decideBash(cmd, activePolicy)) : [activePolicy.defaultBashDecision];

	if (decisions.includes("deny")) {
		return { block: true, reason: `Command denied by explicit rule: ${command}` };
	}

	const outsidePath = firstOutsidePathReference(command, startupCwd, ctx.cwd ?? startupCwd);
	if (activePolicy.askBeforeExternalDirectoryAccess && outsidePath) {
		const ok = await confirmOrBlock(
			ctx,
			"Bash command references path outside startup directory?",
			`${command}\n\nOutside path:\n${outsidePath}\n\nPi was started in:\n${startupCwd}`,
		);
		if (!ok) return { block: true, reason: `Outside-directory bash path was not approved: ${outsidePath}` };
	}

	if (decisions.includes("ask")) {
		const ok = await confirmOrBlock(ctx, "Allow bash command?", command);
		if (!ok) return { block: true, reason: `Command was not approved: ${command}` };
	}

	return undefined;
}

export function decideBash(command: string, activePolicy = policy): Decision {
	let decision: Decision = activePolicy.defaultBashDecision;
	for (const rule of activePolicy.bash) {
		if (matchesCommandPattern(rule.pattern, command)) decision = rule.decision;
	}
	return decision;
}

export function extractShellCommands(command: string): string[] {
	const commands = splitShellCommands(command);
	for (const substitution of extractCommandSubstitutions(command)) {
		commands.push(...extractShellCommands(substitution));
	}
	return commands;
}

export function splitShellCommands(command: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: "single" | "double" | undefined;
	let escaped = false;
	let parenDepth = 0;
	let braceDepth = 0;
	let bracketDepth = 0;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		const next = command[i + 1];

		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if (char === "\\" && quote !== "single") {
			current += char;
			escaped = true;
			continue;
		}

		if (quote) {
			current += char;
			if ((quote === "single" && char === "'") || (quote === "double" && char === '"')) quote = undefined;
			continue;
		}

		if (char === "'") {
			quote = "single";
			current += char;
			continue;
		}
		if (char === '"') {
			quote = "double";
			current += char;
			continue;
		}

		if (char === "(") parenDepth++;
		else if (char === ")" && parenDepth > 0) parenDepth--;
		else if (char === "{") braceDepth++;
		else if (char === "}" && braceDepth > 0) braceDepth--;
		else if (char === "[") bracketDepth++;
		else if (char === "]" && bracketDepth > 0) bracketDepth--;

		const atTopLevel = parenDepth === 0 && braceDepth === 0 && bracketDepth === 0;
		if (atTopLevel && (char === ";" || char === "\n" || char === "|" || (char === "&" && next === "&"))) {
			pushPart(parts, current);
			current = "";
			if ((char === "|" && next === "|") || (char === "&" && next === "&")) i++;
			continue;
		}

		current += char;
	}

	pushPart(parts, current);
	return parts;
}

export function extractCommandSubstitutions(command: string): string[] {
	const substitutions: string[] = [];
	let quote: "single" | "double" | undefined;
	let escaped = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		const next = command[i + 1];

		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "single") {
			escaped = true;
			continue;
		}
		if (quote === "single") {
			if (char === "'") quote = undefined;
			continue;
		}
		if (quote === "double") {
			if (char === '"') quote = undefined;
			// Command substitution is still active inside double quotes.
		} else if (char === "'") {
			quote = "single";
			continue;
		} else if (char === '"') {
			quote = "double";
			continue;
		}

		if (char === "$" && next === "(") {
			const parsed = readBalanced(command, i + 2, "(", ")");
			if (parsed) {
				substitutions.push(parsed.content);
				i = parsed.end;
			}
			continue;
		}

		if (char === "`") {
			const end = readBacktick(command, i + 1);
			if (end) {
				substitutions.push(end.content);
				i = end.end;
			}
		}
	}

	return substitutions;
}

export function normalizeCommandForDecision(command: string): string {
	let normalized = normalizeCommand(command)
		.replace(/^\(?\s*/, "")
		.replace(/\s*\)?$/, "")
		.replace(/^\{\s*/, "")
		.replace(/\s*\}$/, "");

	let changed = true;
	while (changed) {
		changed = false;
		const next = normalized.replace(/^(?:if|then|else|elif|do|while|until|time|command|builtin|env|exec|xargs)\s+/, "");
		if (next !== normalized) {
			normalized = next;
			changed = true;
		}
	}
	return normalized;
}

export function matchesCommandPattern(pattern: string, command: string): boolean {
	const regex = new RegExp(`^${escapeRegExp(normalizeCommand(pattern)).replace(/\\\*/g, ".*")}$`);
	return regex.test(command);
}

function loadPolicy(policyPath: string): Policy {
	try {
		const parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(fs.readFileSync(policyPath, "utf8"))) as Partial<Policy>;
		return {
			...defaultPolicy,
			...parsed,
			bash: parsed.bash ?? defaultPolicy.bash,
			readDeniedPathParts: parsed.readDeniedPathParts ?? defaultPolicy.readDeniedPathParts,
			pathTools: parsed.pathTools ?? defaultPolicy.pathTools,
			readOnlyPathTools: parsed.readOnlyPathTools ?? defaultPolicy.readOnlyPathTools,
			writeTools: parsed.writeTools ?? defaultPolicy.writeTools,
		};
	} catch (error) {
		throw new Error(`Failed to load pi permissions policy at ${policyPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function stripJsonCommentsAndTrailingCommas(input: string): string {
	let output = "";
	let quote: "single" | "double" | undefined;
	let escaped = false;

	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		const next = input[i + 1];

		if (escaped) {
			output += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote) {
			output += char;
			escaped = true;
			continue;
		}
		if (quote) {
			output += char;
			if ((quote === "single" && char === "'") || (quote === "double" && char === '"')) quote = undefined;
			continue;
		}
		if (char === '"') {
			quote = "double";
			output += char;
			continue;
		}
		if (char === "/" && next === "/") {
			while (i < input.length && input[i] !== "\n") i++;
			output += "\n";
			continue;
		}
		if (char === "/" && next === "*") {
			i += 2;
			while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
			i++;
			continue;
		}
		output += char;
	}

	return output.replace(/,\s*([}\]])/g, "$1");
}

function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

function pushPart(parts: string[], value: string): void {
	const trimmed = value.trim();
	if (trimmed) parts.push(trimmed);
}

function readBalanced(input: string, start: number, open: string, close: string): { content: string; end: number } | undefined {
	let depth = 1;
	let quote: "single" | "double" | undefined;
	let escaped = false;
	let content = "";

	for (let i = start; i < input.length; i++) {
		const char = input[i];
		if (escaped) {
			content += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "single") {
			content += char;
			escaped = true;
			continue;
		}
		if (quote) {
			content += char;
			if ((quote === "single" && char === "'") || (quote === "double" && char === '"')) quote = undefined;
			continue;
		}
		if (char === "'") {
			quote = "single";
			content += char;
			continue;
		}
		if (char === '"') {
			quote = "double";
			content += char;
			continue;
		}
		if (char === open) depth++;
		if (char === close) depth--;
		if (depth === 0) return { content, end: i };
		content += char;
	}
	return undefined;
}

function readBacktick(input: string, start: number): { content: string; end: number } | undefined {
	let escaped = false;
	let content = "";
	for (let i = start; i < input.length; i++) {
		const char = input[i];
		if (escaped) {
			content += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			content += char;
			continue;
		}
		if (char === "`") return { content, end: i };
		content += char;
	}
	return undefined;
}

function escapeRegExp(value: string): string {
	return value.replace(/[|\\{}()[\]^$+?.*]/g, "\\$&");
}

function toolPath(toolName: string, input: unknown): string | undefined {
	const params = input as { path?: unknown };
	if (typeof params.path === "string" && params.path.length > 0) return params.path;
	if (toolName === "grep" || toolName === "find" || toolName === "ls") return ".";
	return undefined;
}

function resolveRequestedPath(requestedPath: string | undefined, cwd: string): string {
	if (!requestedPath) return path.resolve(cwd);
	return path.resolve(cwd, expandHome(requestedPath));
}

function expandHome(value: string): string {
	if (value === "~") return process.env.HOME ?? value;
	if (value.startsWith("~/")) return path.join(process.env.HOME ?? "~", value.slice(2));
	return value;
}

function isDeniedReadPath(absolutePath: string, deniedParts: Set<string>): boolean {
	return path
		.normalize(absolutePath)
		.split(path.sep)
		.some((part) => deniedParts.has(part));
}

function isOutside(absolutePath: string, root: string): boolean {
	const relative = path.relative(root, absolutePath);
	return relative === "" ? false : relative.startsWith("..") || path.isAbsolute(relative);
}

function displayPath(absolutePath: string, root: string): string {
	return isOutside(absolutePath, root) ? absolutePath : path.relative(root, absolutePath) || ".";
}

async function confirmOrBlock(ctx: ExtensionContext, title: string, message: string): Promise<boolean> {
	if (!ctx.hasUI) return false;
	return await ctx.ui.confirm(title, message);
}

function firstOutsidePathReference(command: string, startupCwd: string, cwd: string): string | undefined {
	for (const token of shellishTokens(command)) {
		if (!looksLikePath(token)) continue;
		const absolutePath = resolveRequestedPath(token, cwd);
		if (isOutside(absolutePath, startupCwd)) return absolutePath;
	}
	return undefined;
}

function shellishTokens(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "single" | "double" | undefined;
	let escaped = false;

	for (const char of command) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "single") {
			escaped = true;
			continue;
		}
		if (quote) {
			if ((quote === "single" && char === "'") || (quote === "double" && char === '"')) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'") {
			quote = "single";
			continue;
		}
		if (char === '"') {
			quote = "double";
			continue;
		}
		if (/\s/.test(char) || char === ";" || char === "|" || char === "&") {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

function looksLikePath(token: string): boolean {
	if (!token || token.startsWith("-")) return false;
	if (token === "." || token === ".." || token === "~") return true;
	return (
		token.startsWith("/") ||
		token.startsWith("./") ||
		token.startsWith("../") ||
		token.startsWith("~/") ||
		token.includes("/")
	);
}
