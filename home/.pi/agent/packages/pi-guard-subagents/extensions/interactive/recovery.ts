import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { closePane, paneExists } from "./tmux.ts";
import { claimChild, loadRegistry, updateChild } from "./registry.ts";
import {
	atomicJsonWrite,
	parseOrThrow,
	TerminalSignalSchema,
	QuestionSchema,
	questionPointerPath,
	CHILD_STATES,
	QUESTION_ERRORS,
	QUESTION_REPLY_STATES,
	QuestionDeliverySchema,
	readQuestionReply,
	type QuestionDelivery,
	type ChildRecord,
	type Question,
	type Registry,
	type TerminalSignal,
} from "./types.ts";
const CLAIM_TTL_MS = 60_000;
function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
const terminalPath = (child: ChildRecord) => `${child.loadoutPath}.terminal.json`;
function readCurrentTerminal({ child }: { child: ChildRecord }): TerminalSignal | undefined {
	try {
		const signal = parseOrThrow(
			TerminalSignalSchema,
			JSON.parse(fs.readFileSync(terminalPath(child), "utf8")),
			"terminal signal",
		);
		return signal.attemptId === child.attemptId ? signal : undefined;
	} catch (error) {
		if (isMissingFile(error)) return;
		throw error;
	}
}
export function questionAttemptOpen({ child }: { child: ChildRecord }): boolean {
	const terminal = readCurrentTerminal({ child });
	return (
		child.state !== CHILD_STATES.completed &&
		child.state !== CHILD_STATES.failed &&
		terminal === undefined &&
		(child.paneId === null || paneExists(child.paneId))
	);
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
function claimQuestion({
	file,
	child,
	question,
}: {
	file: string;
	child: ChildRecord;
	question: Question;
}): string | undefined {
	const claimed = claimChild(
		file,
		child.name,
		(current) =>
			current.attemptId === question.attemptId &&
			questionAttemptOpen({ child: current }) &&
			(current.questionId !== question.questionId ||
				(!current.questionDelivered && (!current.questionClaim || stale(current.questionClaim.claimedAt)))),
		{
			state: CHILD_STATES.waiting,
			question: question.question,
			questionId: question.questionId,
			questionAnswered: false,
			questionDelivered: false,
			questionDeliveryFailure: undefined,
			questionClaim: { token: randomUUID(), claimedAt: new Date().toISOString() },
		},
	);
	return claimed?.questionClaim?.token;
}
function ackQuestion({
	file,
	name,
	token,
}: {
	file: string;
	name: ChildRecord["name"];
	token: NonNullable<ChildRecord["questionClaim"]>["token"];
}): void {
	claimChild(file, name, (current) => current.questionClaim?.token === token, {
		questionDelivered: true,
		questionClaim: undefined,
		questionDeliveryFailure: undefined,
	});
}
function releaseQuestionClaim({
	file,
	name,
	token,
	failure,
}: {
	file: string;
	name: ChildRecord["name"];
	token: NonNullable<ChildRecord["questionClaim"]>["token"];
	failure: NonNullable<ChildRecord["questionDeliveryFailure"]>;
}): void {
	claimChild(file, name, (current) => current.questionClaim?.token === token, {
		questionClaim: undefined,
		questionDeliveryFailure: failure,
	});
}

export type WatchRegistryOptions = {
	file: string;
	onCompletion?: (event: { child: ChildRecord; signal: TerminalSignal; registry: Registry }) => void;
	onQuestion?: (event: { child: QuestionDelivery; question: Question["question"]; registry: Registry }) => void;
	intervalMs?: number;
};
/** Watches only children launched by this live parent; there is intentionally no restart/reload reconciler. */
export function watchRegistry({ file, onCompletion, onQuestion, intervalMs = 250 }: WatchRegistryOptions): {
	stop(): void;
} {
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
			const questionFile = questionPointerPath({ loadoutPath: child.loadoutPath });
			let terminal: TerminalSignal | undefined;
			try {
				terminal = readCurrentTerminal({ child });
			} catch (error) {
				terminal = {
					status: CHILD_STATES.failed,
					attemptId: child.attemptId,
					result: "",
					failure: `Invalid terminal sidecar: ${String(error)}`,
				} satisfies TerminalSignal;
				atomicJsonWrite(terminalPath(child), terminal);
			}
			if (!terminal && child.paneId && !paneExists(child.paneId)) {
				terminal = {
					status: CHILD_STATES.failed,
					attemptId: child.attemptId,
					result: "(no output)",
					failure: "Child pane disappeared before completion",
				} satisfies TerminalSignal;
				// Persist pane loss so completion delivery can retry after paneId is cleared.
				atomicJsonWrite(terminalPath(child), terminal);
			}
			try {
				const question = parseOrThrow(
					QuestionSchema,
					JSON.parse(fs.readFileSync(questionFile, "utf8")),
					"question sidecar",
				);
				const replyState = readQuestionReply({ loadoutPath: child.loadoutPath, question });
				if (question.answered && replyState.status !== QUESTION_REPLY_STATES.answered)
					throw new Error(QUESTION_ERRORS.missingReply);
				const replied = question.attemptId === child.attemptId && replyState.status === QUESTION_REPLY_STATES.answered;
				if (!terminal && replied) {
					// Recover a reply persisted before the parent could update its registry.
					claimChild(
						file,
						child.name,
						(current) =>
							current.attemptId === question.attemptId &&
							questionAttemptOpen({ child: current }) &&
							[CHILD_STATES.starting, CHILD_STATES.active, CHILD_STATES.waiting].some(
								(state) => state === current.state,
							) &&
							(current.questionId !== question.questionId || !current.questionAnswered),
						{
							state: CHILD_STATES.active,
							questionId: question.questionId,
							question: undefined,
							questionAnswered: true,
							questionDelivered: true,
							questionDeliveryFailure: undefined,
							questionClaim: undefined,
						},
					);
				} else if (!terminal && question.attemptId === child.attemptId && !question.answered && onQuestion) {
					const token = claimQuestion({ file, child, question });
					if (token) {
						const current = loadRegistry(file);
						try {
							const currentChild = current.children.find((v) => v.name === child.name);
							if (!currentChild) throw new Error(`Question child disappeared: ${child.name}`);
							if (
								currentChild.questionClaim?.token !== token ||
								currentChild.attemptId !== question.attemptId ||
								currentChild.questionId !== question.questionId ||
								!questionAttemptOpen({ child: currentChild })
							)
								throw new Error(QUESTION_ERRORS.claimChanged);
							onQuestion({
								child: parseOrThrow(QuestionDeliverySchema, currentChild, "question delivery child"),
								question: question.question,
								registry: current,
							});
							ackQuestion({ file, name: child.name, token });
						} catch (error) {
							releaseQuestionClaim({ file, name: child.name, token, failure: String(error) });
							/* live claim retries on the next watcher tick */
						}
					}
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
			if (terminal && terminal.attemptId === child.attemptId) {
				if (child.paneId && paneExists(child.paneId)) closePane(child.paneId);
				const claimed = claimCompletion(file, child, terminal);
				if (!claimed?.deliveryClaim) continue;
				const handoffPath = writeHandoff(claimed, terminal);
				updateChild(file, child.name, { handoffPath });
				const delivered = loadRegistry(file).children.find((entry) => entry.name === child.name) ?? claimed;
				try {
					onCompletion?.({ child: delivered, signal: terminal, registry: loadRegistry(file) });
					// A completion is acknowledged only after the required parent
					// delivery callback accepts it.
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
