import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { closePane, paneExists } from "./tmux.ts";
import { claimChild, loadRegistry, updateChild } from "./registry.ts";
import {
	atomicJsonWrite,
	parseOrThrow,
	TerminalSignalSchema,
	QuestionSchema,
	type ChildRecord,
	type Registry,
	type TerminalSignal,
} from "./types.ts";
const CLAIM_TTL_MS = 60_000;
function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
const terminalPath = (child: ChildRecord) => `${child.loadoutPath}.terminal.json`;
function readTerminal(child: ChildRecord): TerminalSignal | undefined {
	try {
		return parseOrThrow(
			TerminalSignalSchema,
			JSON.parse(fs.readFileSync(terminalPath(child), "utf8")),
			"terminal signal",
		);
	} catch (error) {
		if (isMissingFile(error)) return;
		throw error;
	}
}
function terminalPatch(signal: TerminalSignal): Partial<ChildRecord> {
	return {
		state: signal.status,
		result: signal.result,
		failure: signal.failure ?? undefined,
		completedAt: new Date().toISOString(),
		paneId: null,
		usage: signal.usage,
		model: signal.model,
		toolCalls: signal.toolCalls,
	};
}
function stale(claimedAt?: string): boolean {
	return !claimedAt || Date.now() - Date.parse(claimedAt) > CLAIM_TTL_MS;
}
function writeHandoff(child: ChildRecord, signal: TerminalSignal): string {
	const dir = child.handoffDir ?? child.loadoutPath.substring(0, child.loadoutPath.lastIndexOf("/"));
	const file = `${dir}/${child.handoffName ?? `${child.sessionId}.handoff`}.md`;
	fs.mkdirSync(dir, { recursive: true });
	const text = [
		"# Subagent handoff",
		"",
		`- status: ${signal.status}`,
		`- agent: ${child.agent}`,
		`- session: ${child.sessionId}`,
		`- task: ${child.task}`,
		`- model: ${signal.model ?? "unknown"}`,
		"",
		"## Final output",
		"",
		signal.result || "(no output)",
		...(signal.failure ? ["", `Failure: ${signal.failure}`] : []),
		"",
		"## Usage",
		"",
		"```json",
		JSON.stringify(signal.usage ?? {}, null, 2),
		"```",
		"",
		"## Tool calls",
		"",
		"```json",
		JSON.stringify(signal.toolCalls ?? [], null, 2),
		"```",
		...(signal.observedPaths?.length
			? ["", "## Tool-observed write/edit paths", "", ...signal.observedPaths.map((v) => `- ${v}`)]
			: []),
		...(signal.permissionBlocks?.length
			? [
					"",
					"## Pi-guard permission blocks",
					"",
					...signal.permissionBlocks.map((v) => `- ${typeof v === "string" ? v : JSON.stringify(v)}`),
				]
			: []),
		"",
		"Paths in this artifact are runtime-observed only; no Git status or diff was used.",
	].join("\n");
	const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(temporary, text, { mode: 0o600 });
	fs.renameSync(temporary, file);
	return file;
}
function claimCompletion(file: string, child: ChildRecord, signal: TerminalSignal): ChildRecord | undefined {
	return claimChild(
		file,
		child.name,
		(current) => !current.delivered && (!current.deliveryClaim || stale(current.deliveryClaim.claimedAt)),
		{
			...terminalPatch(signal),
			deliveryId: `${child.sessionId}:${child.attemptId}`,
			deliveryClaim: { token: randomUUID(), claimedAt: new Date().toISOString() },
		},
	);
}
function ackCompletion(file: string, name: string, token: string, handoffPath: string): void {
	const current = loadRegistry(file).children.find((v) => v.name === name);
	if (current?.deliveryClaim?.token === token)
		updateChild(file, name, { delivered: true, deliveryClaim: undefined, handoffPath });
}
function releaseCompletionClaim(file: string, name: string, token: string): void {
	const current = loadRegistry(file).children.find((v) => v.name === name);
	if (current?.deliveryClaim?.token === token) updateChild(file, name, { deliveryClaim: undefined });
}
function claimQuestion(file: string, child: ChildRecord, question: string): string | undefined {
	const claimed = claimChild(
		file,
		child.name,
		(current) => !current.questionDelivered && (!current.questionClaim || stale(current.questionClaim.claimedAt)),
		{
			state: "waiting",
			question,
			questionClaim: { token: randomUUID(), claimedAt: new Date().toISOString() },
		},
	);
	return claimed?.questionClaim?.token;
}
function ackQuestion(file: string, name: string, token: string): void {
	const current = loadRegistry(file).children.find((v) => v.name === name);
	if (current?.questionClaim?.token === token)
		updateChild(file, name, { questionDelivered: true, questionClaim: undefined });
}
function releaseQuestionClaim(file: string, name: string, token: string): void {
	const current = loadRegistry(file).children.find((v) => v.name === name);
	if (current?.questionClaim?.token === token) updateChild(file, name, { questionClaim: undefined });
}

/** Watches only children launched by this live parent; there is intentionally no restart/reload reconciler. */
export function watchRegistry(
	file: string,
	onCompletion?: (child: ChildRecord, signal: TerminalSignal, registry: Registry) => void,
	onQuestion?: (child: ChildRecord, question: string, registry: Registry) => void,
	intervalMs = 250,
): { stop(): void } {
	let stopped = false;
	const tick = () => {
		if (stopped || !fs.existsSync(file)) return;
		let registry: Registry;
		try {
			registry = loadRegistry(file);
		} catch {
			return;
		}
		for (const child of registry.children) {
			if ((child.state === "completed" || child.state === "failed") && child.delivered) continue;
			const questionFile = `${child.loadoutPath}.question.json`;
			let terminal: TerminalSignal | undefined;
			try {
				const question = parseOrThrow(
					QuestionSchema,
					JSON.parse(fs.readFileSync(questionFile, "utf8")),
					"question sidecar",
				);
				if (question.attemptId === child.attemptId && !question.answered) {
					const token = claimQuestion(file, child, question.question);
					if (token) {
						const current = loadRegistry(file);
						try {
							const currentChild = current.children.find((v) => v.name === child.name);
							if (!currentChild) throw new Error(`Question child disappeared: ${child.name}`);
							onQuestion?.(currentChild, question.question, current);
							ackQuestion(file, child.name, token);
						} catch {
							releaseQuestionClaim(file, child.name, token);
							/* live claim retries on the next watcher tick */
						}
					}
					continue;
				}
			} catch (error) {
				if (!isMissingFile(error)) {
					terminal = {
						status: "failed",
						attemptId: child.attemptId,
						result: "",
						failure: `Invalid question sidecar: ${String(error)}`,
						observedPaths: [],
						permissionBlocks: [],
						toolCalls: [],
					};
					atomicJsonWrite(terminalPath(child), terminal);
				}
			}
			if (!terminal)
				try {
					terminal = readTerminal(child);
				} catch (error) {
					terminal = {
						status: "failed",
						attemptId: child.attemptId,
						result: "",
						failure: `Invalid terminal sidecar: ${String(error)}`,
						observedPaths: [],
						permissionBlocks: [],
						toolCalls: [],
					};
					atomicJsonWrite(terminalPath(child), terminal);
				}
			if (terminal && terminal.attemptId === child.attemptId) {
				if (child.paneId && paneExists(child.paneId)) closePane(child.paneId);
				const claimed = claimCompletion(file, child, terminal);
				if (!claimed?.deliveryClaim) continue;
				const handoffPath = writeHandoff(claimed, terminal);
				updateChild(file, child.name, { handoffPath });
				const delivered = loadRegistry(file).children.find((entry) => entry.name === child.name) ?? claimed;
				try {
					onCompletion?.(delivered, terminal, loadRegistry(file));
					// A completion is acknowledged only after the required parent
					// delivery callback accepts it.
					ackCompletion(file, child.name, claimed.deliveryClaim.token, handoffPath);
				} catch {
					releaseCompletionClaim(file, child.name, claimed.deliveryClaim.token);
					/* Parent delivery failed; retry on the next watcher tick. */
				}
			} else if (child.paneId && !paneExists(child.paneId)) {
				const signal: TerminalSignal = {
					status: "failed",
					result: "(no output)",
					failure: "Child pane disappeared before completion",
					attemptId: child.attemptId ?? "",
				};
				const claimed = claimCompletion(file, child, signal);
				if (!claimed?.deliveryClaim) continue;
				const handoffPath = writeHandoff(claimed, signal);
				updateChild(file, child.name, { handoffPath });
				const delivered = loadRegistry(file).children.find((entry) => entry.name === child.name) ?? claimed;
				try {
					onCompletion?.(delivered, signal, loadRegistry(file));
					ackCompletion(file, child.name, claimed.deliveryClaim.token, handoffPath);
				} catch {
					releaseCompletionClaim(file, child.name, claimed.deliveryClaim.token);
					/* Parent delivery failed; retry on the next watcher tick. */
				}
			}
		}
	};
	const timer = setInterval(tick, intervalMs);
	tick();
	return {
		stop: () => {
			stopped = true;
			clearInterval(timer);
		},
	};
}
export function pendingChildren(registry: Registry): ChildRecord[] {
	return registry.children.filter((c) => c.state === "starting" || c.state === "active" || c.state === "waiting");
}
