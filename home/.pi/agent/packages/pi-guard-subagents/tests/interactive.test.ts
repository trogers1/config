import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { recordActivity, readActivity } from "../extensions/interactive/activity.ts";
import { formatStatus } from "../extensions/interactive/status.ts";
import { ensureRegistry, loadRegistry, registryPath, updateChild } from "../extensions/interactive/registry.ts";
import { watchRegistry, type WatchRegistryOptions } from "../extensions/interactive/recovery.ts";
import {
	atomicJsonWrite,
	parseOrThrow,
	QuestionSchema,
	questionPointerPath,
	questionRecordPath,
	ReplySchema,
	CHILD_STATES,
	QUESTION_ERRORS,
	type ChildRecord,
	type Question,
	type Reply,
	type TerminalSignal,
} from "../extensions/interactive/types.ts";
import { makeTmpDir } from "./helpers.ts";

describe("interactive persistence primitives", () => {
	it("bounds and atomically records child activity", () => {
		const file = join(makeTmpDir("activity-"), "activity.json");
		for (let i = 0; i < 105; i++) recordActivity(file, "tool", `tool-${i}`);
		const events = readActivity(file);
		expect(events).toHaveLength(100);
		expect(events[0].detail).toBe("tool-5");
		expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(100);
	});

	it("persists registry transitions and rejects malformed state", () => {
		const cwd = makeTmpDir("registry-");
		const file = registryPath(cwd, "run-1");
		const registry = ensureRegistry(file, "parent-session");
		expect(registry.children).toEqual([]);
		const child = {
			name: "worker-1",
			attemptId: "attempt-1",
			loadoutDigest: "0".repeat(64),
			loadoutSnapshot: {
				version: 1,
				attemptId: "attempt-1",
				agent: "worker",
				profile: null,
				writes: null,
				toolAllowlist: ["ask_question"],
				guardExtensionPath: resolve("../pi-guard/extensions/guard.ts"),
				childRuntimePath: resolve("../pi-guard-subagents/extensions/interactive/child-runtime.ts"),
				backingExtensionPaths: [],
				backingExtensionDigests: [],
				model: null,
				thinking: null,
				systemPromptMode: null,
				identity: null,
				cwd,
				agentDir: null,
				codingAgentDir: null,
				autoExit: true,
			},
			authorityPath: join(cwd, "authority.json"),
			sessionId: "child-session",
			paneId: null,
			startedAt: new Date().toISOString(),
			task: "inspect",
			agent: "worker",
			loadoutPath: join(cwd, "loadout.json"),
			state: "starting",
		} satisfies ChildRecord;
		writeFileSync(child.loadoutPath, "{}");
		registry.children.push(child);
		writeFileSync(file, JSON.stringify(registry));
		updateChild(file, child.name, { state: "waiting", question: "Which file?" });
		expect(loadRegistry(file).children[0].state).toBe("waiting");
		writeFileSync(file, "{}\n");
		expect(() => loadRegistry(file)).toThrow(/Invalid interactive/);
	});

	it.each([
		{ failureKind: "cancellation", failure: QUESTION_ERRORS.cancelled },
		{ failureKind: "mismatched reply", failure: QUESTION_ERRORS.identityMismatch },
		{ failureKind: "missing question ID", failure: undefined },
		{ failureKind: "missing durable reply", failure: QUESTION_ERRORS.missingReply },
		{ failureKind: "pane loss", failure: undefined },
	])("recovers question delivery per ID and reports $failureKind while parked", async ({ failureKind, failure }) => {
		const cwd = makeTmpDir("watcher-");
		const file = registryPath(cwd, "run-watcher");
		const registry = ensureRegistry(file, "parent-session");
		const child = {
			name: "worker-1",
			attemptId: "attempt-1",
			loadoutDigest: "0".repeat(64),
			loadoutSnapshot: {
				version: 1,
				attemptId: "attempt-1",
				agent: "worker",
				profile: null,
				writes: null,
				toolAllowlist: ["ask_question"],
				guardExtensionPath: resolve("../pi-guard/extensions/guard.ts"),
				childRuntimePath: resolve("../pi-guard-subagents/extensions/interactive/child-runtime.ts"),
				backingExtensionPaths: [],
				backingExtensionDigests: [],
				model: null,
				thinking: null,
				systemPromptMode: null,
				identity: null,
				cwd,
				agentDir: null,
				codingAgentDir: null,
				autoExit: true,
			},
			authorityPath: join(cwd, "authority.json"),
			sessionId: "child-session",
			paneId: null,
			startedAt: new Date().toISOString(),
			task: "inspect",
			agent: "worker",
			loadoutPath: join(cwd, "loadout.json"),
			state: "active",
		} satisfies ChildRecord;
		registry.children.push(child);
		writeFileSync(file, JSON.stringify(registry));
		const questionFile = questionPointerPath({ loadoutPath: child.loadoutPath });
		const publishQuestion = ({ questionId }: Pick<Question, "questionId">) => {
			atomicJsonWrite(
				questionFile,
				parseOrThrow(
					QuestionSchema,
					{
						version: QuestionSchema.properties.version.const,
						attemptId: child.attemptId,
						questionId,
						childSessionId: child.sessionId,
						at: new Date().toISOString(),
						question: "Same question",
						answered: false,
					} satisfies Question,
					"test question",
				),
			);
		};
		const initialQuestionId = randomUUID();
		publishQuestion({ questionId: initialQuestionId });
		// Another attempt's terminal sidecar must not suppress these live questions.
		atomicJsonWrite(`${child.loadoutPath}.terminal.json`, {
			status: CHILD_STATES.failed,
			attemptId: randomUUID(),
			result: "stale attempt",
		} satisfies TerminalSignal);
		let questionAttempts = 0;
		const notificationFailure = "transient question notification failure";
		const deliveredQuestions: Array<Question["questionId"]> = [];
		const onQuestion: NonNullable<WatchRegistryOptions["onQuestion"]> = ({ child: current }) => {
			questionAttempts++;
			if (questionAttempts === 1) throw new Error(notificationFailure);
			deliveredQuestions.push(current.questionId);
		};
		const questionWatcher = watchRegistry({ file, onQuestion, intervalMs: 20 });
		try {
			expect(loadRegistry(file).children[0]?.questionDeliveryFailure).toContain(notificationFailure);
			const deadline = Date.now() + 2_000;
			while (!loadRegistry(file).children[0]?.questionDelivered && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 20));
			expect(deliveredQuestions).toEqual([initialQuestionId]);
			expect(questionAttempts).toBe(2);
		} finally {
			questionWatcher.stop();
		}
		const finalQuestionId = randomUUID();
		const recovered = watchRegistry({ file, onQuestion, intervalMs: 20 });
		try {
			await new Promise((resolve) => setTimeout(resolve, 60));
			expect(deliveredQuestions).toEqual([initialQuestionId]);
			// A new ID must reset the old acknowledgement, even for identical text.
			const questionId = randomUUID();
			const replyFile = `${questionRecordPath({ loadoutPath: child.loadoutPath, questionId })}.reply`;
			const publishReply = ({ replyQuestionId }: { replyQuestionId: Reply["questionId"] }) => {
				atomicJsonWrite(
					replyFile,
					parseOrThrow(
						ReplySchema,
						{
							version: ReplySchema.properties.version.const,
							attemptId: child.attemptId,
							questionId: replyQuestionId,
							answer: "approved",
						} satisfies Reply,
						"test reply",
					),
				);
			};
			publishQuestion({ questionId });
			const deadline = Date.now() + 2_000;
			while (deliveredQuestions.length < 2 && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 20));
			expect(deliveredQuestions).toEqual([initialQuestionId, questionId]);
			expect(loadRegistry(file).children[0]).toMatchObject({
				questionId,
				questionDelivered: true,
				questionAnswered: false,
				state: CHILD_STATES.waiting,
			});
			// Simulate an interrupted parent reply: the reply is durable but no
			// registry update or child acknowledgement has happened yet.
			publishReply({ replyQuestionId: questionId });
			const replyDeadline = Date.now() + 2_000;
			while (!loadRegistry(file).children[0]?.questionAnswered && Date.now() < replyDeadline)
				await new Promise((resolve) => setTimeout(resolve, 20));
			expect(loadRegistry(file).children[0]).toMatchObject({ state: CHILD_STATES.active, questionAnswered: true });
			expect(deliveredQuestions).toEqual([initialQuestionId, questionId]);
			publishQuestion({ questionId: finalQuestionId });
		} finally {
			recovered.stop();
		}
		// A terminal registry record cannot be reclaimed as waiting, even when
		// the only terminal sidecar belongs to a different attempt.
		updateChild(file, child.name, { state: CHILD_STATES.failed });
		let prematureQuestions = 0;
		let prematureCompletions = 0;
		const terminalRegistryWatcher = watchRegistry({
			file,
			onQuestion: () => {
				prematureQuestions++;
			},
			onCompletion: () => {
				prematureCompletions++;
			},
		});
		try {
			expect(prematureQuestions).toBe(0);
			expect(prematureCompletions).toBe(0);
			expect(loadRegistry(file).children[0]?.state).toBe(CHILD_STATES.failed);
		} finally {
			terminalRegistryWatcher.stop();
		}
		updateChild(file, child.name, { state: CHILD_STATES.active });
		// Cancellation can leave an unanswered sidecar behind; terminal failure
		// must take precedence over waiting indefinitely on that question.
		if (failureKind === "cancellation") {
			atomicJsonWrite(`${child.loadoutPath}.terminal.json`, {
				status: CHILD_STATES.failed,
				attemptId: child.attemptId,
				result: "",
				failure,
			});
		} else if (failureKind === "mismatched reply") {
			atomicJsonWrite(`${questionRecordPath({ loadoutPath: child.loadoutPath, questionId: finalQuestionId })}.reply`, {
				version: ReplySchema.properties.version.const,
				attemptId: child.attemptId,
				questionId: initialQuestionId,
				answer: "must not satisfy another question",
			} satisfies Reply);
		} else if (failureKind === "pane loss") {
			updateChild(file, child.name, { paneId: "%2147483647" });
		} else if (failureKind === "missing question ID") {
			const valid = parseOrThrow(QuestionSchema, JSON.parse(readFileSync(questionFile, "utf8")), "test question");
			atomicJsonWrite(questionFile, { ...valid, questionId: undefined });
		} else {
			const valid = parseOrThrow(QuestionSchema, JSON.parse(readFileSync(questionFile, "utf8")), "test question");
			atomicJsonWrite(questionFile, {
				...valid,
				answered: true,
				answeredAt: new Date().toISOString(),
			} satisfies Question);
		}
		let attempts = 0;
		let deadQuestions = 0;
		const watcher = watchRegistry({
			file,
			onQuestion: () => {
				deadQuestions++;
				throw new Error("A terminal attempt must not notify another question");
			},
			onCompletion: ({ child: current }) => {
				expect(current.state).toBe(CHILD_STATES.failed);
				attempts += 1;
				if (attempts === 1) throw new Error("transient parent delivery failure");
			},
			intervalMs: 20,
		});
		expect(loadRegistry(file).children[0]?.state).toBe(CHILD_STATES.failed);
		expect(loadRegistry(file).children[0]?.delivered).not.toBe(true);
		const deadline = Date.now() + 2_000;
		while (!loadRegistry(file).children[0]?.delivered && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 20));
		expect(attempts).toBe(2);
		expect(deadQuestions).toBe(0);
		expect(loadRegistry(file).children[0]?.delivered).toBe(true);
		expect(loadRegistry(file).children[0]?.state).toBe(CHILD_STATES.failed);
		if (failure !== undefined) expect(loadRegistry(file).children[0]?.failure).toContain(failure);
		else expect(loadRegistry(file).children[0]?.failure).toBeTruthy();
		watcher.stop();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(attempts).toBe(2);
	});

	it("renders child provider/tool activity and classifies stale activity", () => {
		const cwd = makeTmpDir("status-activity-");
		const loadoutPath = join(cwd, "loadout.json");
		const activityPath = join(cwd, "activity-a.json");
		writeFileSync(loadoutPath, "{}");
		recordActivity(activityPath, "provider", "openai/gpt-test");
		recordActivity(activityPath, "tool", "write");
		const child = {
			name: "active",
			attemptId: "attempt-active",
			agent: "worker",
			state: "active",
			startedAt: new Date(Date.now() - 10_000).toISOString(),
			sessionId: "a",
			task: "x",
			paneId: "%1",
			loadoutPath,
		} satisfies Pick<
			ChildRecord,
			"name" | "attemptId" | "agent" | "state" | "startedAt" | "sessionId" | "task" | "paneId" | "loadoutPath"
		>;
		expect(formatStatus([child])).toContain("active/worker active");
		expect(formatStatus([child])).toContain("tool:write");
		const staleAt = new Date(Date.now() - 60_000).toISOString();
		writeFileSync(activityPath, JSON.stringify([{ version: 1, at: staleAt, kind: "provider", detail: "old" }]));
		expect(formatStatus([child])).toContain("active/worker stalled");
		expect(formatStatus([{ ...child, name: "waiting", state: "waiting" }])).toContain("waiting/worker waiting");
	});

	it("formats only live child records", () => {
		const now = Date.parse("2026-01-01T00:00:10.000Z");
		expect(
			formatStatus(
				[
					{
						name: "live",
						attemptId: "attempt-live",
						agent: "worker",
						state: "active",
						startedAt: "2026-01-01T00:00:00.000Z",
						sessionId: "a",
						task: "x",
						paneId: "%1",
						loadoutPath: "/tmp/a",
					},
					{
						name: "done",
						attemptId: "attempt-done",
						agent: "worker",
						state: "completed",
						startedAt: "2026-01-01T00:00:00.000Z",
						sessionId: "b",
						task: "x",
						paneId: null,
						loadoutPath: "/tmp/b",
					},
				],
				now,
			),
		).toBe("live/worker active 10s");
	});
});
