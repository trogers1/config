import { execFile } from "node:child_process";

// Output is inspected only for fixed diagnostic markers. Never return captured
// output, commands, error messages/stacks, paths, or an unsanitized error cause.
const outputMarkers = [
	["output-permission-denied", /\b(?:EPERM|EACCES)\b|operation not permitted|permission denied/i],
	[
		"extension-lifecycle-error",
		/extension error\s*\(|(?:session_start|before_agent_start)[^\r\n]{0,120}(?:error|failed)/i,
	],
	["extension-load-error", /failed to load extension|error loading extension/i],
	[
		"guard-configuration-error",
		/pi-guard[^\r\n]{0,160}(?:fail.closed|configuration[^\r\n]{0,40}(?:invalid|unavailable|missing))/i,
	],
] as const;

function diagnostics({ error, stdout, stderr }: { error: unknown; stdout: string; stderr: string }) {
	const categories: string[] = [];
	if (error) {
		categories.push("subprocess-error");
		if (typeof error === "object") {
			if ("code" in error) {
				if (typeof error.code === "number") categories.push("nonzero-exit");
				else if (error.code === "ENOENT") categories.push("executable-not-found");
				else if (error.code === "EPERM" || error.code === "EACCES") categories.push("subprocess-permission-denied");
				else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") categories.push("output-limit");
			}
			if ("killed" in error && error.killed === true) categories.push("subprocess-killed");
			if ("signal" in error && error.signal) categories.push("signal-termination");
		}
	}
	for (const [category, marker] of outputMarkers) {
		if (marker.test(stdout) || marker.test(stderr)) categories.push(category);
	}
	return {
		subprocess: error ? "failed" : "success",
		categories,
		stdoutPresent: stdout.length > 0,
		stderrPresent: stderr.length > 0,
	};
}

export async function runPrintCommand({ command, cwd }: { command: readonly string[]; cwd: string }) {
	const [executable, ...args] = command;
	if (!executable) throw new Error("Print command requires an executable");
	return await new Promise<ReturnType<typeof diagnostics>>((resolve, reject) => {
		try {
			const child = execFile(
				executable,
				[...args, "--print"],
				{ cwd, timeout: 15_000, maxBuffer: 64 * 1024 },
				(error, stdout, stderr) => {
					const context = diagnostics({ error, stdout, stderr });
					if (error) reject(new Error(`Print command failed: ${JSON.stringify(context)}`));
					else resolve(context);
				},
			);
			child.stdin?.end();
		} catch (error) {
			reject(
				new Error(`Print command could not start: ${JSON.stringify(diagnostics({ error, stdout: "", stderr: "" }))}`),
			);
		}
	});
}
