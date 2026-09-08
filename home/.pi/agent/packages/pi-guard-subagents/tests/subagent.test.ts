import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveChildTools } from "../extensions/index.ts";
import { buildChildCommand } from "../extensions/interactive/launcher.ts";
import {
	atomicJsonWrite,
	parseOrThrow,
	snapshotBackingExtensions,
	validateLoadout,
	type GuardedInteractiveLoadout,
} from "../extensions/interactive/types.ts";
import { Type } from "typebox";
import { makeTmpDir } from "./helpers.ts";

const guard = resolve(process.cwd(), "../pi-guard/extensions/guard.ts");
const runtime = resolve(new URL("../extensions/interactive/child-runtime.ts", import.meta.url).pathname);

function loadout(overrides: Record<string, unknown> = {}): unknown {
	return {
		version: 1,
		attemptId: "attempt-1",
		agent: "worker",
		profile: "builtin:worker",
		writes: ["src"],
		toolAllowlist: ["read", "write", "edit", "ask_question"],
		guardExtensionPath: guard,
		childRuntimePath: runtime,
		backingExtensionPaths: [],
		backingExtensionDigests: [],
		model: null,
		thinking: null,
		systemPromptMode: null,
		identity: null,
		cwd: process.cwd(),
		agentDir: null,
		codingAgentDir: null,
		autoExit: true,
		...overrides,
	};
}

function validLoadout(overrides: Record<string, unknown> = {}): GuardedInteractiveLoadout {
	return validateLoadout(loadout(overrides));
}

describe("interactive child loadout boundary", () => {
	it("fails closed when required runtime paths are unavailable", () => {
		expect(() => validateLoadout(loadout({ guardExtensionPath: "/missing/guard.ts" }))).toThrow(
			/required guard\/runtime path is unavailable/,
		);
	});

	it("fails closed when the child protocol tool is missing", () => {
		expect(() => validateLoadout(loadout({ toolAllowlist: ["read"] }))).toThrow(/missing required security fields/);
	});

	it("adds ask_question exactly once for default and custom child tools", () => {
		for (const tools of [resolveChildTools(undefined), resolveChildTools(["read", "ask_question", "read"])]) {
			expect(tools.tools.filter((tool) => tool === "ask_question")).toHaveLength(1);
			expect(tools.backingExtensionPaths).not.toContain(runtime);
		}
	});

	it("refuses resume after an approved backing extension changes", () => {
		const extension = resolve(makeTmpDir("backing-extension-"), "tool.ts");
		writeFileSync(extension, "export default function approved() {}\n");
		const approved = snapshotBackingExtensions([extension]);
		expect(
			validateLoadout(loadout({ backingExtensionPaths: [extension], backingExtensionDigests: approved })),
		).toBeDefined();
		writeFileSync(extension, "export default function replaced() {}\n");
		expect(() =>
			validateLoadout(loadout({ backingExtensionPaths: [extension], backingExtensionDigests: approved })),
		).toThrow(/backing extension content changed/);
	});

	it("builds a default-deny child command with immutable guard and scope env", () => {
		const command = buildChildCommand(validLoadout(), "child-session", "Inspect src", "/tmp/loadout.json", "pi");
		expect(command).toContain("--no-extensions");
		expect(command).toContain("-e");
		expect(command).toContain("PI_SUBAGENT_PROFILE='builtin:worker'");
		expect(command).toContain("PI_SUBAGENT_PERMISSIBLE_GLOBS='src'");
		expect(command).toContain("PI_SUBAGENT_DEPTH='1'");
		const match = command.match(/'--tools' '([^']+)'/);
		if (!match?.[1]) throw new Error("generated command omitted --tools");
		expect(match[1].split(",").filter((tool) => tool === "ask_question")).toHaveLength(1);
		expect(command).toContain("--session-id");
	});

	it("writes JSON sidecars atomically", () => {
		const dir = makeTmpDir("sidecar-");
		const file = resolve(dir, "nested", "registry.json");
		atomicJsonWrite(file, { version: 1, children: [] });
		expect(existsSync(file)).toBe(true);
		const schema = Type.Object({ version: Type.Literal(1), children: Type.Array(Type.Unknown()) });
		expect(parseOrThrow(schema, JSON.parse(readFileSync(file, "utf8")), "atomic sidecar")).toEqual({
			version: 1,
			children: [],
		});
	});
});
