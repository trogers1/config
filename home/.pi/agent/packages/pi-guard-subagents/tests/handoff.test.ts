import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { checkScopeViolations, extractFilesChanged, slugify } from "../extensions/handoff.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

function assistant(content: AssistantMessage["content"]): Message {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	} satisfies AssistantMessage;
}

describe("handoff helpers", () => {
	it("collects only write and edit tool paths", () => {
		const messages = [
			assistant([
				toolCall("write-1", "write", { path: "src/a.ts" }),
				toolCall("edit-1", "edit", { path: "src/b.ts" }),
				toolCall("bash-1", "bash", { command: "sed -i 's/x/y/' src/c.ts" }),
			]),
		] satisfies Message[];
		expect(extractFilesChanged(messages)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("deduplicates repeated paths", () => {
		const messages = [
			assistant([toolCall("write-1", "write", { path: "src/a.ts" }), toolCall("edit-1", "edit", { path: "src/a.ts" })]),
		] satisfies Message[];
		expect(extractFilesChanged(messages)).toEqual(["src/a.ts"]);
	});

	it("reports scope violations without shared-prefix false positives", () => {
		expect(
			checkScopeViolations(["src/auth/a.ts", "src/billing/b.ts", "README.md"], ["src/auth", "src/billing"]),
		).toEqual(["README.md"]);
		expect(checkScopeViolations(["src/auth/a.ts", "src/auth/nested/b.ts"], ["src/auth/*"])).toEqual([]);
		expect(checkScopeViolations(["src/authentication.ts"], ["src/auth/*"])).toEqual(["src/authentication.ts"]);
	});

	it("creates stable slugs", () => {
		expect(slugify("Add Redis caching to the session store!")).toBe("add-redis-caching-to-the-session-store");
		expect(slugify("!!!")).toBe("task");
	});
});
