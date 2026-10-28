import { describe, expect, it } from "vitest";
import { type Static } from "typebox";
import { parseOrThrow } from "../extensions/interactive/types.ts";
import { MessageOutcomeSchema, runMessageOutcome } from "./support/message-outcome.ts";
import { MessageDiagnosticSchema, unavailableMessageDiagnostic } from "./support/message-observer.ts";

// Shutdown refusal/reporting faults cannot safely be injected into the real
// process controller. Exercise these combinations at the lifecycle runner API.
describe("message lifecycle outcome preservation", () => {
	it.each(["invalid", "extra", "throw", "transient-emit"] as const)(
		"still emits a bounded report after %s reporting fault",
		async (fault) => {
			const reports: Static<typeof MessageOutcomeSchema>[] = [];
			const secret = "PRIVATE_DIAGNOSTIC_REPORTING_SENTINEL";
			const valid = parseOrThrow(MessageDiagnosticSchema, unavailableMessageDiagnostic(), "diagnostic fixture");
			let captures = 0;
			let emits = 0;
			let removed = false;
			let failure: unknown;
			try {
				await runMessageOutcome({
					execute: async () => {
						throw new Error(secret);
					},
					shutdown: async () => {},
					validate: () => {},
					accept: () => {},
					remove: async () => {
						removed = true;
					},
					diagnostics: () => {
						captures++;
						if (fault === "throw") throw new Error(secret);
						if (fault === "invalid") return [{ ...valid, status: secret }];
						if (fault === "extra") return [{ ...valid, unexpected: secret }];
						return [valid];
					},
					emit: (report) => {
						emits++;
						if (fault === "transient-emit" && emits === 1) throw new Error(secret);
						reports.push(parseOrThrow(MessageOutcomeSchema, report, "emitted fault report"));
					},
				});
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(Error);
			expect(String(failure)).toContain("Messaging lifecycle failed: execution");
			expect(String(failure)).toContain('"reporting":"failed"');
			expect(String(failure)).not.toContain(secret);
			expect(JSON.stringify(reports)).not.toContain(secret);
			expect(captures).toBe(1);
			expect(removed).toBe(false);
			expect(reports.length).toBeGreaterThan(0);
			expect(reports.at(-1)).toMatchObject({ primary: "execution", reporting: "failed", deletion: "blocked" });
			if (fault !== "transient-emit") expect(reports[0]?.diagnostics).toEqual([valid]);
		},
	);
	it.each(["passed", "shutdown", "validation", "deletion", "reporting"] as const)(
		"preserves execution failure with %s cleanup",
		async (secondary) => {
			const reports: Static<typeof MessageOutcomeSchema>[] = [];
			let removed = false;
			let validated = false;
			const secret = "PRIVATE_ERROR_CAUSE_STACK_SENTINEL";
			await expect(
				runMessageOutcome({
					execute: async () => {
						throw new Error(secret, { cause: new Error(secret) });
					},
					shutdown: async () => {
						if (secondary === "shutdown") throw new Error(secret);
					},
					validate: () => {
						validated = true;
						if (secondary === "validation") throw new Error(secret);
					},
					accept: () => {
						throw new Error("Acceptance must not be invoked without an execution candidate");
					},
					remove: async () => {
						removed = true;
						if (secondary === "deletion") throw new Error(secret);
					},
					diagnostics: () => [],
					emit: (value) => {
						reports.push(parseOrThrow(MessageOutcomeSchema, structuredClone(value), "failure report fixture"));
						if (secondary === "reporting") throw new Error(secret);
					},
				}),
			).rejects.toThrow("Messaging lifecycle failed: execution");
			expect(validated).toBe(secondary !== "shutdown");
			expect(JSON.stringify(reports)).not.toContain(secret);
			expect(reports[0]?.primary).toBe("execution");
			expect(removed).toBe(secondary === "passed" || secondary === "deletion");
			const last = reports.at(-1);
			expect(last?.shutdown).toBe(secondary === "shutdown" ? "failed" : "passed");
			expect(last?.finalValidation).toBe(
				secondary === "shutdown" ? "blocked" : secondary === "validation" ? "failed" : "passed",
			);
		},
	);
});
