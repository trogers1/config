import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveChildTools } from "../extensions/index.ts";
import { buildChildCommand } from "../extensions/interactive/launcher.ts";
import {
	atomicJsonWrite,
	parseOrThrow,
	snapshotBackingExtensions,
	validateLoadout,
	REQUIRED_GUARD_EXTENSION_PATH,
	REQUIRED_CHILD_RUNTIME_PATH,
	type GuardedInteractiveLoadout,
} from "../extensions/interactive/types.ts";
import { CLAUDE_BRIDGE_PROVIDER, resolveProviderExtensions } from "../extensions/interactive/provider-extensions.ts";
import { LOCAL_PROVIDER_MODEL_ID } from "./fixtures/local-provider.ts";
import { makeTmpDir } from "./helpers.ts";

function loadout({
	overrides = {},
}: { overrides?: Partial<GuardedInteractiveLoadout> } = {}): GuardedInteractiveLoadout {
	return {
		version: 1,
		attemptId: "attempt-1",
		agent: "worker",
		profile: "builtin:worker",
		writes: ["src"],
		toolAllowlist: ["read", "write", "edit", "ask_question"],
		guardExtensionPath: REQUIRED_GUARD_EXTENSION_PATH,
		childRuntimePath: REQUIRED_CHILD_RUNTIME_PATH,
		backingExtensionPaths: [],
		backingExtensionDigests: [],
		providerExtensions: [],
		model: null,
		thinking: null,
		systemPromptMode: null,
		identity: null,
		cwd: process.cwd(),
		agentDir: null,
		codingAgentDir: null,
		autoExit: true,
		...overrides,
	} satisfies GuardedInteractiveLoadout;
}

describe("interactive child loadout boundary", () => {
	it("requires a live reviewed adapter without changing other models", () => {
		const events = createEventBus();
		expect(resolveProviderExtensions({ model: "unreviewed/model", events })).toEqual([]);
		expect(resolveProviderExtensions({ model: null, events })).toEqual([]);
		const model = `${CLAUDE_BRIDGE_PROVIDER}/${LOCAL_PROVIDER_MODEL_ID}`;
		expect(() => resolveProviderExtensions({ model, events })).toThrow(/active parent-approved adapter/);
		expect(() => validateLoadout({ value: loadout({ overrides: { model } }) })).toThrow(
			/does not match explicit model/,
		);
		expect(() => resolveProviderExtensions({ model: CLAUDE_BRIDGE_PROVIDER, events })).toThrow(/explicit/);
	});

	it("rejects old loadouts instead of supplying an implicit provider approval", () => {
		const { providerExtensions, ...oldLoadout } = loadout();
		expect(providerExtensions).toEqual([]);
		expect(() => validateLoadout({ value: oldLoadout })).toThrow(/Invalid guarded interactive loadout/);
	});

	it("fails closed when required runtime paths are unavailable", () => {
		expect(() =>
			validateLoadout({ value: loadout({ overrides: { guardExtensionPath: "/missing/guard.ts" } }) }),
		).toThrow(/required guard\/runtime path is unavailable/);
	});

	it("fails closed when the child protocol tool is missing", () => {
		expect(() => validateLoadout({ value: loadout({ overrides: { toolAllowlist: ["read"] } }) })).toThrow(
			/missing required security fields/,
		);
	});

	it("adds ask_question exactly once for default and custom child tools", () => {
		for (const tools of [resolveChildTools(undefined), resolveChildTools(["read", "ask_question", "read"])]) {
			expect(tools.tools.filter((tool) => tool === "ask_question")).toHaveLength(1);
			expect(tools.backingExtensionPaths).not.toContain(REQUIRED_CHILD_RUNTIME_PATH);
		}
	});

	it("refuses resume after an approved backing extension changes", () => {
		const extension = resolve(makeTmpDir("backing-extension-"), "tool.ts");
		writeFileSync(extension, "export default function approved() {}\n");
		const value = loadout({
			overrides: {
				backingExtensionPaths: [extension],
				backingExtensionDigests: snapshotBackingExtensions({ paths: [extension] }),
			},
		});
		expect(validateLoadout({ value })).toBeDefined();
		writeFileSync(extension, "export default function replaced() {}\n");
		expect(() => validateLoadout({ value })).toThrow(/backing extension content changed/);
	});

	it("builds a default-deny child command with immutable guard and scope env", () => {
		const task = "Inspect 'quoted' paths; keep $HOME and $(printf literal) unchanged\nsecond line";
		const approved = validateLoadout({ value: loadout() });
		const command = buildChildCommand({
			loadout: approved,
			sessionId: "child-session",
			task,
			loadoutPath: "/tmp/loadout.json",
		});
		expect(command[0]).toBe("/usr/bin/env");
		expect(command).toContain(`PATH=${process.env.PATH}`);
		expect(command).toContain("--no-extensions");
		expect(command).toContain("-e");
		expect(command).toContain(`PI_SUBAGENT_PROFILE=${approved.profile}`);
		expect(command).toContain(`PI_SUBAGENT_PERMISSIBLE_GLOBS=${approved.writes?.join(",")}`);
		expect(command).toContain("PI_SUBAGENT_DEPTH=1");
		expect(command[command.indexOf("--tools") + 1]).toBe(approved.toolAllowlist.join(","));
		expect(command).toContain("--session-id");
		expect(command.at(-1)).toBe(task);
		expect(command.slice(command.indexOf("/bin/zsh"), command.indexOf("/bin/zsh") + 4)).toEqual([
			"/bin/zsh",
			"-c",
			'exec "$@"',
			"pi-subagent",
		]);
		expect(command).not.toContain("-lc");
	});

	it("preserves omitted versus explicitly empty write scope without shell quoting", () => {
		for (const writes of [null, []]) {
			const command = buildChildCommand({
				loadout: loadout({ overrides: { writes } }),
				sessionId: "scope-session",
				task: "Inspect",
				loadoutPath: "/tmp/loadout.json",
			});
			expect(command.includes("PI_SUBAGENT_PERMISSIBLE_GLOBS=")).toBe(writes !== null);
		}
	});

	it("writes JSON sidecars atomically", () => {
		const file = resolve(makeTmpDir("sidecar-"), "nested", "registry.json");
		const schema = Type.Object({ version: Type.Literal(1), children: Type.Array(Type.Unknown()) });
		const value = parseOrThrow(schema, { version: 1, children: [] }, "atomic sidecar fixture");
		atomicJsonWrite(file, value);
		expect(existsSync(file)).toBe(true);
		expect(parseOrThrow(schema, JSON.parse(readFileSync(file, "utf8")), "atomic sidecar")).toEqual(value);
	});
});
