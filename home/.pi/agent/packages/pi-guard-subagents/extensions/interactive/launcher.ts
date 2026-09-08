import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createPane, paneExists, requireTmux } from "./tmux.ts";
import { addChild, loadRegistry, registryPath, updateChild } from "./registry.ts";
import {
	atomicJsonWrite,
	validateLoadout,
	type ChildRecord,
	type GuardedInteractiveLoadout,
	type TerminalSignal,
} from "./types.ts";

interface LaunchChildOptions {
	parentCwd: string;
	runId: string;
	parentSession: string;
	name: string;
	task: string;
	agent: string;
	cwd: string;
	loadout: GuardedInteractiveLoadout;
	piCommand?: string;
	mode?: ChildRecord["mode"];
	sessionId?: string;
	loadoutPath?: string;
	handoffDir?: string;
	handoffName?: string;
	registryFile?: string;
	chainStep?: number;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function safeName(name: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) throw new Error(`Invalid interactive child name: ${name}`);
	return name;
}
function immutableLoadout(loadout: GuardedInteractiveLoadout): Omit<GuardedInteractiveLoadout, "attemptId"> {
	const { attemptId, ...rest } = loadout;
	void attemptId;
	return rest;
}
function digestLoadout(loadout: GuardedInteractiveLoadout): string {
	return createHash("sha256")
		.update(JSON.stringify(immutableLoadout(loadout)))
		.digest("hex");
}
export function authorityPath(runId: string, name: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) throw new Error("Invalid orchestration run ID");
	return path.join(os.homedir(), ".pi", "agent", "pi-guard-subagents-authority", `${runId}-${name}.json`);
}
export function chainAuthorityPath(runId: string, step: number): string {
	return authorityPath(runId, `chain-${step}`);
}
export function persistApprovedChainLoadout(runId: string, step: number, loadout: GuardedInteractiveLoadout): string {
	const file = chainAuthorityPath(runId, step);
	atomicJsonWrite(file, immutableLoadout(loadout));
	return file;
}
export function readApprovedChainLoadout(runId: string, step: number, loadout: GuardedInteractiveLoadout): void {
	const file = chainAuthorityPath(runId, step);
	const trusted = JSON.parse(fs.readFileSync(file, "utf8"));
	if (JSON.stringify(trusted) !== JSON.stringify(immutableLoadout(loadout)))
		throw new Error(`Refusing chain step ${step}: protected loadout authority mismatch`);
}

/** Build a child invocation exclusively from the persisted, validated loadout. */
export function buildChildCommand(
	loadout: GuardedInteractiveLoadout,
	sessionId: string,
	task: string,
	loadoutPath: string,
	pi = "pi",
): string {
	const args = [pi, "--session-id", sessionId, "--no-extensions", "--tools", loadout.toolAllowlist.join(",")];
	for (const extension of [loadout.guardExtensionPath, loadout.childRuntimePath, ...loadout.backingExtensionPaths])
		args.push("-e", extension);
	if (loadout.model) args.push("--model", loadout.model);
	if (loadout.thinking) args.push("--thinking", loadout.thinking);
	if (loadout.systemPromptMode === "append" && loadout.identity) args.push("--append-system-prompt", loadout.identity);
	// Current Pi resolves the agent directory from PI_CODING_AGENT_DIR/configuration;
	// it does not expose an --agent-dir CLI option.
	args.push(task);
	const env: Record<string, string> = {
		PI_SUBAGENT_DEPTH: "1",
		PI_SUBAGENT_SESSION_ID: sessionId,
		PI_SUBAGENT_PROFILE: loadout.profile ?? "",
		PI_SUBAGENT_LOADOUT: loadoutPath,
		PI_SUBAGENT_ATTEMPT_ID: loadout.attemptId,
	};
	if (loadout.codingAgentDir !== null) env.PI_CODING_AGENT_DIR = loadout.codingAgentDir;
	// Omitted scope must not become an empty guard override (deny-all).
	if (loadout.writes !== null) env.PI_SUBAGENT_PERMISSIBLE_GLOBS = loadout.writes.join(",");
	return `${Object.entries(env)
		.map(([key, value]) => `${key}=${shellQuote(value)}`)
		.join(" ")} ${args.map(shellQuote).join(" ")}`;
}
function persistLaunchFailure(loadoutPath: string, attemptId: string, error: unknown): string {
	const failure = `Child pane launch failed: ${String(error)}`;
	atomicJsonWrite(`${loadoutPath}.terminal.json`, {
		version: 1,
		status: "failed",
		attemptId,
		result: "",
		failure,
		at: new Date().toISOString(),
	} satisfies TerminalSignal);
	return failure;
}

export function launchChild(options: LaunchChildOptions): ChildRecord {
	requireTmux();
	const name = safeName(options.name);
	const file = options.registryFile ?? registryPath(options.parentCwd, options.runId);
	if (options.sessionId && options.loadoutPath && fs.existsSync(file)) {
		const existing = loadRegistry(file).children.find((entry) => entry.sessionId === options.sessionId);
		if (existing)
			return resumeChild({
				...options,
				name: existing.name,
				sessionId: existing.sessionId,
				loadoutPath: existing.loadoutPath,
			});
	}
	const root = path.join(options.parentCwd, ".pi", "orchestration", options.runId);
	const sessionId = options.sessionId ?? randomUUID();
	const loadout = options.loadoutPath ? validateResumeLoadout(options.loadoutPath) : validateLoadout(options.loadout);
	const loadoutPath = options.loadoutPath ?? path.join(root, `loadout-${name}-${sessionId}.json`);
	const trustedAuthority = authorityPath(options.runId, name);
	atomicJsonWrite(trustedAuthority, immutableLoadout(loadout));
	atomicJsonWrite(loadoutPath, loadout);
	// Persist the child before creating the pane. A child can start and finish
	// between split-window and the registry write, so the registry must be the
	// first durable record of the launch.
	const child: ChildRecord = {
		name,
		attemptId: loadout.attemptId,
		loadoutDigest: digestLoadout(loadout),
		loadoutSnapshot: loadout,
		authorityPath: trustedAuthority,
		sessionId,
		paneId: null,
		startedAt: new Date().toISOString(),
		task: options.task,
		agent: options.agent,
		loadoutPath,
		state: "starting",
		questionAnswered: false,
		mode: options.mode,
		chainStep: options.chainStep,
		handoffDir: options.handoffDir,
		handoffName: options.handoffName,
	};
	const addResult = addChild(file, child, options.parentSession);
	if (!addResult.added) return addResult.child;
	try {
		const paneId = createPane(
			buildChildCommand(loadout, sessionId, options.task, loadoutPath, options.piCommand),
			options.cwd,
		);
		updateChild(file, name, { paneId, state: "active" });
		child.paneId = paneId;
		child.state = "active";
		return child;
	} catch (error) {
		const failure = persistLaunchFailure(loadoutPath, loadout.attemptId, error);
		updateChild(file, name, { state: "failed", failure, completedAt: new Date().toISOString() });
		throw error;
	}
}

export function resumeChild(options: LaunchChildOptions & { sessionId: string; loadoutPath: string }): ChildRecord {
	requireTmux();
	const loadout = validateResumeLoadout(options.loadoutPath);
	const canonicalAuthority = authorityPath(options.runId, safeName(options.name));
	const file = options.registryFile ?? registryPath(options.parentCwd, options.runId);
	const existingRecord = fs.existsSync(file)
		? loadRegistry(file).children.find((entry) => entry.sessionId === options.sessionId)
		: undefined;
	if (
		existingRecord &&
		(!["completed", "failed"].includes(existingRecord.state) ||
			(existingRecord.paneId !== null && paneExists(existingRecord.paneId)))
	)
		throw new Error(`Refusing resume: session ${options.sessionId} is still active; use subagent_message`);
	if (existingRecord?.loadoutSnapshot && digestLoadout(existingRecord.loadoutSnapshot) !== digestLoadout(loadout))
		throw new Error("Refusing resume: loadout differs from the parent-owned security snapshot");
	if (existingRecord?.loadoutDigest && existingRecord.loadoutDigest !== digestLoadout(loadout))
		throw new Error("Refusing resume: loadout digest does not match the parent-owned security snapshot");
	const attemptId = randomUUID();
	const freshLoadout = { ...loadout, attemptId };
	const child: ChildRecord = {
		name: safeName(options.name),
		attemptId,
		loadoutDigest: digestLoadout(freshLoadout),
		loadoutSnapshot: freshLoadout,
		sessionId: options.sessionId,
		paneId: null,
		startedAt: new Date().toISOString(),
		task: options.task,
		agent: options.agent,
		loadoutPath: options.loadoutPath,
		state: "starting",
		questionAnswered: false,
		mode: options.mode,
		chainStep: options.chainStep,
		authorityPath: canonicalAuthority,
		handoffDir: options.handoffDir,
		handoffName: options.handoffName,
	};
	if (!existingRecord?.authorityPath || existingRecord.authorityPath !== canonicalAuthority) {
		throw new Error("Refusing resume: protected loadout authority path is not canonical");
	}
	try {
		const trusted = JSON.parse(fs.readFileSync(canonicalAuthority, "utf8"));
		if (JSON.stringify(trusted) !== JSON.stringify(immutableLoadout(loadout))) throw new Error("authority mismatch");
	} catch {
		throw new Error("Refusing resume: protected loadout authority is unavailable or mismatched");
	}
	atomicJsonWrite(options.loadoutPath, freshLoadout);
	const existing = Boolean(existingRecord);
	if (existing) {
		updateChild(file, child.name, {
			attemptId,
			loadoutDigest: digestLoadout(loadout),
			loadoutSnapshot: freshLoadout,
			sessionId: options.sessionId,
			task: options.task,
			agent: options.agent,
			mode: options.mode,
			chainStep: options.chainStep,
			startedAt: child.startedAt,
			paneId: null,
			state: "starting",
			questionAnswered: false,
			question: undefined,
			questionDelivered: false,
			questionClaim: undefined,
			delivered: false,
			deliveryClaim: undefined,
			result: undefined,
			failure: undefined,
			completedAt: undefined,
			usage: undefined,
			model: undefined,
			toolCalls: undefined,
			handoffPath: undefined,
		});
		for (const suffix of [".terminal.json", ".question.json", ".question.json.reply"])
			fs.rmSync(`${options.loadoutPath}${suffix}`, { force: true });
	} else addChild(file, child, options.parentSession);
	try {
		const paneId = createPane(
			buildChildCommand(freshLoadout, options.sessionId, options.task, options.loadoutPath, options.piCommand),
			options.cwd,
		);
		updateChild(file, child.name, { paneId, state: "active" });
		child.paneId = paneId;
		child.state = "active";
		return child;
	} catch (error) {
		const failure = persistLaunchFailure(options.loadoutPath, attemptId, error);
		updateChild(file, child.name, {
			state: "failed",
			failure,
			completedAt: new Date().toISOString(),
			paneId: null,
		});
		throw error;
	}
}

export function validateResumeLoadout(file: string): GuardedInteractiveLoadout {
	if (!fs.existsSync(file)) throw new Error(`Refusing resume: loadout is absent: ${file}`);
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		throw new Error(`Refusing resume: malformed loadout: ${file}`);
	}
	return validateLoadout(value);
}
