import { describe, expect, it } from "vitest";
import { checkScopeViolations, extractFilesChanged, slugify } from "../extensions/handoff.ts";

/**
 * These tests cover genuinely isolated, branching logic in the handoff helpers.
 * The integration behavior of handoff files and run directories is exercised
 * through the public subagent tool in subagent.test.ts.
 */
describe("handoff helpers", () => {
	describe("extractFilesChanged", () => {
		it("collects paths from write and edit tool calls", () => {
			const messages = [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", name: "write", arguments: { path: "src/a.ts" } },
						{ type: "toolCall", name: "edit", arguments: { path: "src/b.ts" } },
						{ type: "toolCall", name: "bash", arguments: { command: "sed -i 's/x/y/' src/c.ts" } },
					],
				},
			] as any;

			expect(extractFilesChanged(messages)).toEqual(["src/a.ts", "src/b.ts"]);
		});

		it("deduplicates repeated paths", () => {
			const messages = [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", name: "write", arguments: { path: "src/a.ts" } },
						{ type: "toolCall", name: "edit", arguments: { path: "src/a.ts" } },
					],
				},
			] as any;

			expect(extractFilesChanged(messages)).toEqual(["src/a.ts"]);
		});
	});

	describe("checkScopeViolations", () => {
		it("flags files outside declared prefix scopes", () => {
			const violations = checkScopeViolations(
				["src/auth/a.ts", "src/billing/b.ts", "README.md"],
				["src/auth", "src/billing"],
			);
			expect(violations).toEqual(["README.md"]);
		});

		it("supports trailing glob stars for prefix matching", () => {
			const violations = checkScopeViolations(
				["src/auth/a.ts", "src/auth/nested/b.ts"],
				["src/auth/*"],
			);
			expect(violations).toEqual([]);
		});

		it("does not false-positive on shared prefixes", () => {
			const violations = checkScopeViolations(
				["src/authentication.ts"],
				["src/auth/*"],
			);
			expect(violations).toEqual(["src/authentication.ts"]);
		});
	});

	describe("slugify", () => {
		it("produces kebab-case slugs", () => {
			expect(slugify("Add Redis caching to the session store!")).toBe("add-redis-caching-to-the-session-store");
		});

		it("falls back to 'task' for empty input", () => {
			expect(slugify("!!!")).toBe("task");
		});
	});
});
