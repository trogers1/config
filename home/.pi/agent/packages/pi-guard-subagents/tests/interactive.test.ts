import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { recordActivity, readActivity } from "../extensions/interactive/activity.ts";
import { formatStatus } from "../extensions/interactive/status.ts";
import { ensureRegistry, loadRegistry, registryPath, updateChild } from "../extensions/interactive/registry.ts";
import { watchRegistry } from "../extensions/interactive/recovery.ts";
import type { ChildRecord } from "../extensions/interactive/types.ts";
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

	it("retries unacknowledged delivery and stops all polling when requested", async () => {
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
		writeFileSync(
			`${child.loadoutPath}.terminal.json`,
			JSON.stringify({ status: "completed", attemptId: child.attemptId, result: "done" }),
		);
		let attempts = 0;
		const watcher = watchRegistry(
			file,
			() => {
				attempts += 1;
				if (attempts === 1) throw new Error("transient parent delivery failure");
			},
			undefined,
			20,
		);
		const deadline = Date.now() + 2_000;
		while (!loadRegistry(file).children[0]?.delivered && Date.now() < deadline)
			await new Promise((resolve) => setTimeout(resolve, 20));
		expect(attempts).toBe(2);
		expect(loadRegistry(file).children[0]?.delivered).toBe(true);
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

	it("renders only live children in the parent status widget", () => {
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
