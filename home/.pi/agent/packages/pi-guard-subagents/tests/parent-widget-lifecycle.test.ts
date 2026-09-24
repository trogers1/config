import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attachParentRegistry, stopParentRegistryWatchers } from "../extensions/index.ts";
import { addChild, ensureRegistry, updateChild } from "../extensions/interactive/registry.ts";
import { atomicJsonWrite, type ChildRecord } from "../extensions/interactive/types.ts";
import { makeTmpDir } from "./helpers.ts";

function wait({ milliseconds }: { readonly milliseconds: number }): Promise<void> {
	return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

describe("parent subagent widget lifecycle", () => {
	it("never installs a parent widget and stops delivery after shutdown", async () => {
		const cwd = makeTmpDir("parent-widget-lifecycle-");
		const file = join(cwd, "registry.json");
		const sessionId = "parent-session";
		ensureRegistry(file, sessionId);
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
			task: "wait",
			agent: "worker",
			loadoutPath: join(cwd, "loadout.json"),
			state: "active",
		} satisfies ChildRecord;
		writeFileSync(child.loadoutPath, "{}");
		addChild(file, child, sessionId);

		const setWidget = vi.fn();
		const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
		const watchers = new Set<{ stop(): void }>();
		const context = {
			hasUI: true,
			cwd,
			sessionManager: { getSessionId: () => sessionId },
			ui: { notify: vi.fn(), setWidget },
		};
		attachParentRegistry({ file, ctx: context, sendMessage, watchers });

		updateChild(file, child.name, { state: "waiting" });
		await wait({ milliseconds: 300 });
		expect(setWidget).not.toHaveBeenCalled();
		expect(sendMessage).not.toHaveBeenCalled();

		stopParentRegistryWatchers({ watchers });
		updateChild(file, child.name, { state: "active" });
		atomicJsonWrite(`${child.loadoutPath}.terminal.json`, {
			status: "completed",
			attemptId: child.attemptId,
			result: "must not be delivered after shutdown",
		});
		await wait({ milliseconds: 350 });

		expect(sendMessage).not.toHaveBeenCalled();
		expect(setWidget).not.toHaveBeenCalled();
	});
});
