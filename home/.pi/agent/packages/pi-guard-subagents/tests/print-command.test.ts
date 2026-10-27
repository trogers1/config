import { describe, expect, it } from "vitest";
import { runPrintCommand } from "./support/print-command.ts";

function nodeCommand({ script }: { script: string }) {
	return [process.execPath, "-e", script, "--"];
}

// Real disposable subprocesses exercise the diagnostic boundary without loading
// Pi, reading user configuration, or contacting an installed model/runtime.
describe("print command diagnostics", () => {
	it("reports lifecycle and permission categories even when the subprocess exits successfully", async () => {
		const secret = "/private/example-user/config-and-transcript-sentinel";
		const result = await runPrintCommand({
			command: nodeCommand({
				script: `console.error(${JSON.stringify(`Extension error (${secret}): EPERM: operation not permitted`)}); console.log(${JSON.stringify(secret)});`,
			}),
			cwd: process.cwd(),
		});
		expect(result).toEqual({
			subprocess: "success",
			categories: ["output-permission-denied", "extension-lifecycle-error"],
			stdoutPresent: true,
			stderrPresent: true,
		});
		expect(JSON.stringify(result).includes(secret)).toBe(false);
	});

	it("inspects stdout for initialization markers without retaining arbitrary output", async () => {
		const result = await runPrintCommand({
			command: nodeCommand({ script: 'console.log("Failed to load extension /private/example-user/plugin.ts");' }),
			cwd: process.cwd(),
		});
		expect(result.categories).toEqual(["extension-load-error"]);
		expect(result.subprocess).toBe("success");
		expect(JSON.stringify(result).includes("/private/")).toBe(false);
	});

	it("rejects unsuccessful exits with only sanitized categories", async () => {
		const secret = "/private/example-user/credential-and-transcript-sentinel";
		const error: unknown = await runPrintCommand({
			command: nodeCommand({
				script: `console.error(${JSON.stringify(`Failed to load extension ${secret}`)}); process.exitCode = 7;`,
			}),
			cwd: process.cwd(),
		}).catch((failure: unknown) => failure);
		if (!(error instanceof Error)) throw new Error("Unsuccessful subprocess did not reject with a diagnostic error");
		expect(error.message.includes("nonzero-exit")).toBe(true);
		expect(error.message.includes("extension-load-error")).toBe(true);
		expect(error.message.includes(secret)).toBe(false);
		expect(error.cause).toBeUndefined();
	});

	it("bounds captured output and sanitizes output-limit failures", async () => {
		const secret = "/private/example-user/output-sentinel";
		const error: unknown = await runPrintCommand({
			command: nodeCommand({ script: `process.stdout.write(${JSON.stringify(secret)}.repeat(5000));` }),
			cwd: process.cwd(),
		}).catch((failure: unknown) => failure);
		if (!(error instanceof Error)) throw new Error("Oversized subprocess output did not reject");
		expect(error.message.includes("output-limit")).toBe(true);
		expect(error.message.length).toBeLessThan(512);
		expect(error.message.includes(secret)).toBe(false);
	});
});
