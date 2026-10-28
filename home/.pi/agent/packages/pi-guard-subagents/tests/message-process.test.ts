import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
	createMessageProcessControl,
	messageProcessIO,
	runOwnedCommand,
	MESSAGE_PROCESS_COMMANDS,
	MESSAGE_TIMING,
	MESSAGE_TEST_TIMEOUT,
	PROCESS_ERRORS,
} from "./support/message-process.ts";

const PIDS = Object.freeze({ server: 41, child: 42 });
const BIRTH = "Wed Jan 1 00:00:00 2020";
const FAULTS = Object.freeze({
	birth: "birth",
	parent: "parent",
	missing: "missing",
	clock: "clock",
	root: "root",
	budget: "budget",
});
const ZOMBIE_PHASES = ["initial", "freeze", "stability", "confirmation", "kill"] as const;
const TERMINAL_FAULTS = ["birth", "parent", "missing", "active", "descendant"] as const;
function fakeProcesses({
	fault,
	young = false,
	zombie,
	terminalFault,
	release,
}: {
	fault?: (typeof FAULTS)[keyof typeof FAULTS];
	young?: boolean;
	zombie?: (typeof ZOMBIE_PHASES)[number];
	terminalFault?: (typeof TERMINAL_FAULTS)[number];
	release?: "reap" | "reparent" | "replace" | "active";
}) {
	let now = 0;
	let wall =
		Date.parse(`${BIRTH} UTC`) +
		(young ? MESSAGE_TIMING.birthBucketMs : MESSAGE_TIMING.birthBucketMs + MESSAGE_TIMING.birthMarginMs);
	const server = { parent: 1, state: "S", birth: BIRTH };
	const processes = new Map<number, typeof server>([
		[PIDS.server, server],
		[PIDS.child, { parent: PIDS.server, state: "S", birth: BIRTH }],
	]);
	const signals: Array<Parameters<typeof messageProcessIO.signal>[0] & { at: number }> = [];
	let socketQueries = 0;
	let childStoppedScans = 0;
	let corruptTerminal = false;
	if (zombie === "initial") {
		const child = processes.get(PIDS.child);
		if (!child) throw new Error("Missing fixture child");
		child.state = "Z";
	}
	const io = {
		now: () => now,
		wall: () => wall,
		wait: async ({ milliseconds }) => {
			if (terminalFault) corruptTerminal = true;
			now += milliseconds;
			wall += milliseconds + (fault === FAULTS.clock ? MESSAGE_TIMING.clockSlackMs + 1 : 0);
		},
		command: async ({ command }) => {
			if (command === MESSAGE_PROCESS_COMMANDS.tmux) {
				socketQueries++;
				return String(fault === FAULTS.root && socketQueries > 1 ? PIDS.child : PIDS.server);
			}
			if (command !== MESSAGE_PROCESS_COMMANDS.ps) throw new Error("Unexpected fake command");
			const child = processes.get(PIDS.child);
			if (child && signals.some(({ pid, signal }) => pid === PIDS.child && signal === "SIGSTOP")) {
				childStoppedScans++;
				const transitionScan = { initial: 0, freeze: 1, stability: 2, confirmation: 3, kill: 4 };
				if (zombie && childStoppedScans === transitionScan[zombie]) child.state = "Z";
			}
			if (child?.state === "Z" && corruptTerminal) {
				if (terminalFault === "birth") child.birth = "Tue Dec 31 23:59:59 2019";
				if (terminalFault === "parent") child.parent = 1;
				if (terminalFault === "missing") processes.delete(PIDS.child);
				if (terminalFault === "active") child.state = "S";
				if (terminalFault === "descendant") processes.set(PIDS.child + 1, { ...child, parent: PIDS.child, state: "S" });
			}
			return (
				[...processes].map(([pid, value]) => `${pid} ${value.parent} ${value.state} ${value.birth}`).join("\n") ||
				`1 0 S ${BIRTH}`
			);
		},
		signal: ({ pid, signal }) => {
			const process = processes.get(pid);
			if (!process) throw new Error("Missing fake process");
			signals.push({ pid, signal, at: now });
			if (signal === "SIGKILL") {
				processes.delete(pid);
				if (pid === PIDS.server) {
					const child = processes.get(PIDS.child);
					if (release === "reap") processes.delete(PIDS.child);
					if (child && release === "reparent") child.parent = 1;
					if (child && release === "replace") child.birth = "Tue Dec 31 23:59:59 2019";
					if (child && release === "active") child.state = "S";
				}
			} else if (signal === "SIGSTOP") {
				process.state = "T";
				if (pid === PIDS.child) {
					if (fault === FAULTS.birth) process.birth = "Tue Dec 31 23:59:59 2019";
					if (fault === FAULTS.parent) process.parent = 1;
					if (fault === FAULTS.missing) processes.delete(pid);
				}
			} else throw new Error("Unexpected fake signal");
			return true;
		},
	} satisfies typeof messageProcessIO;
	return { io, signals, processes };
}

describe("owned process quiescence", () => {
	it("age-gates identities, freezes ancestors first and kills stopped descendants first", async () => {
		const fixture = fakeProcesses({ young: true });
		const control = createMessageProcessControl({ socket: "owned-fixture", io: fixture.io });
		await control.shutdown({ deadline: MESSAGE_TIMING.shutdownMs });
		expect(fixture.signals.map(({ pid, signal }) => ({ pid, signal }))).toEqual([
			{ pid: PIDS.server, signal: "SIGSTOP" },
			{ pid: PIDS.child, signal: "SIGSTOP" },
			{ pid: PIDS.child, signal: "SIGKILL" },
			{ pid: PIDS.server, signal: "SIGKILL" },
		]);
		expect(fixture.signals[0]?.at).toBeGreaterThanOrEqual(MESSAGE_TIMING.birthMarginMs);
		expect(fixture.processes.size).toBe(0);
		expect(control.observedIdentities()).toHaveLength(Object.keys(PIDS).length);
	});

	it.each(Object.values(FAULTS))("refuses ambiguous metadata or budgets: %s", async (fault) => {
		const fixture = fakeProcesses({ fault, young: true });
		const control = createMessageProcessControl({ socket: "owned-fixture", io: fixture.io });
		await expect(
			control.shutdown({ deadline: fault === FAULTS.budget ? 1 : MESSAGE_TIMING.shutdownMs }),
		).rejects.toThrow(
			fault === FAULTS.clock
				? PROCESS_ERRORS.clock
				: fault === FAULTS.budget
					? PROCESS_ERRORS.deadline
					: PROCESS_ERRORS.identity,
		);
		expect(fixture.signals.some(({ signal }) => signal === "SIGKILL")).toBe(false);
	});

	it.each(ZOMBIE_PHASES)("leaves verified terminal leaves unsignaled: %s", async (zombie) => {
		const fixture = fakeProcesses({ zombie });
		const control = createMessageProcessControl({ socket: "owned-fixture", io: fixture.io });
		await control.shutdown({ deadline: MESSAGE_TIMING.shutdownMs });
		expect(fixture.signals.filter(({ pid, signal }) => pid === PIDS.child && signal === "SIGKILL")).toEqual([]);
		if (zombie === "initial") expect(fixture.signals.filter(({ pid }) => pid === PIDS.child)).toEqual([]);
		expect(fixture.processes.get(PIDS.child)?.state).toBe("Z");
	});

	it.each(TERMINAL_FAULTS)("refuses changed terminal leaf evidence: %s", async (terminalFault) => {
		const fixture = fakeProcesses({ zombie: "initial", terminalFault });
		const control = createMessageProcessControl({ socket: "owned-fixture", io: fixture.io });
		await expect(control.shutdown({ deadline: MESSAGE_TIMING.shutdownMs })).rejects.toThrow(
			terminalFault === "active"
				? PROCESS_ERRORS.state
				: terminalFault === "descendant"
					? PROCESS_ERRORS.ancestry
					: PROCESS_ERRORS.identity,
		);
		expect(fixture.signals.some(({ signal }) => signal === "SIGKILL")).toBe(false);
	});

	it.each(["reap", "reparent"] as const)("permits terminal %s only after ancestor termination", async (release) => {
		const fixture = fakeProcesses({ zombie: "initial", release });
		await createMessageProcessControl({ socket: "owned-fixture", io: fixture.io }).shutdown({
			deadline: MESSAGE_TIMING.shutdownMs,
		});
		expect(fixture.signals.map(({ pid, signal }) => ({ pid, signal }))).toEqual([
			{ pid: PIDS.server, signal: "SIGSTOP" },
			{ pid: PIDS.server, signal: "SIGKILL" },
		]);
	});

	it.each(["replace", "active"] as const)("rejects terminal %s even after ancestor termination", async (release) => {
		const fixture = fakeProcesses({ zombie: "initial", release });
		await expect(
			createMessageProcessControl({ socket: "owned-fixture", io: fixture.io }).shutdown({
				deadline: MESSAGE_TIMING.shutdownMs,
			}),
		).rejects.toThrow(release === "replace" ? PROCESS_ERRORS.identity : PROCESS_ERRORS.state);
	});

	it("bounds a hung subprocess without exposing command arguments", async () => {
		const privateArgument = "fixture argument must not appear in diagnostics";
		await expect(
			runOwnedCommand({
				command: process.execPath,
				args: ["-e", "setInterval(() => {}, 1000)", privateArgument],
				deadline: performance.now() + 100,
			}),
		).rejects.toThrow(PROCESS_ERRORS.deadline);
	});

	it(
		"reconciles a server created before its startup client times out",
		async () => {
			const work = mkdtempSync(join(tmpdir(), "pi-startup-timeout-"));
			const socket = join(work, "tmux.socket");
			const ready = join(work, "created");
			const args = [
				"-S",
				socket,
				"-f",
				"/dev/null",
				"new-session",
				"-d",
				"-s",
				"fixture",
				"/bin/sleep",
				String(Math.ceil(MESSAGE_TEST_TIMEOUT / 1000)),
			];
			const script = `require('node:child_process').execFileSync(${JSON.stringify(MESSAGE_PROCESS_COMMANDS.tmux)}, ${JSON.stringify(args)}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'created'); setInterval(() => {}, 1000);`;
			await expect(
				runOwnedCommand({
					command: process.execPath,
					args: ["-e", script],
					deadline: performance.now() + MESSAGE_TIMING.commandMs,
				}),
			).rejects.toThrow(PROCESS_ERRORS.deadline);
			expect(existsSync(ready)).toBe(true);
			const control = createMessageProcessControl({ socket });
			await control.shutdown({ deadline: performance.now() + MESSAGE_TIMING.shutdownMs });
			expect(control.observedIdentities().length).toBeGreaterThanOrEqual(2);
			rmSync(work, { recursive: true });
		},
		MESSAGE_TEST_TIMEOUT,
	);

	it(
		"shuts down a proven unreaped zombie beneath its stopped parent through public control",
		async () => {
			const work = mkdtempSync(join(tmpdir(), "pi-terminal-leaf-"));
			const socket = join(work, "tmux.socket");
			const ready = join(work, "ready");
			// Keep the pane process running while its child self-stops. A pane's
			// startup/job-control behavior must not resume the fixture parent.
			const parentScript = `const fs = require('node:fs'); const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), ${MESSAGE_TIMING.pollMs * 10})'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(ready)}, process.pid + ' ' + child.pid);
process.kill(process.pid, 'SIGSTOP');
setInterval(() => {}, 1000);`;
			const script = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(parentScript)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;
			const deadline = performance.now() + MESSAGE_TIMING.shutdownMs;
			await runOwnedCommand({
				command: MESSAGE_PROCESS_COMMANDS.tmux,
				args: [
					"-S",
					socket,
					"-f",
					"/dev/null",
					"new-session",
					"-d",
					"-s",
					"fixture",
					"-c",
					work,
					process.execPath,
					"-e",
					script,
				],
				deadline,
			});
			while (!existsSync(ready)) {
				if (performance.now() >= deadline) throw new Error(PROCESS_ERRORS.deadline);
				await delay(MESSAGE_TIMING.pollMs);
			}
			const value = readFileSync(ready, "utf8");
			if (!/^\d+ \d+$/.test(value)) throw new Error(PROCESS_ERRORS.metadata);
			const [parent, child] = value.split(" ").map(Number);
			if (!parent || !child || parent <= 1 || child <= 1) throw new Error(PROCESS_ERRORS.metadata);
			while (true) {
				const output = await runOwnedCommand({
					command: MESSAGE_PROCESS_COMMANDS.ps,
					args: ["-axo", "pid=,ppid=,stat="],
					deadline,
				});
				const rows = output
					.trim()
					.split("\n")
					.map((line) => line.trim().split(/\s+/));
				const parentRow = rows.find(([pid]) => Number(pid) === parent);
				const childRow = rows.find(([pid]) => Number(pid) === child);
				if (parentRow?.[2]?.startsWith("T") && Number(childRow?.[1]) === parent && childRow?.[2]?.startsWith("Z"))
					break;
				if (performance.now() >= deadline) throw new Error(PROCESS_ERRORS.deadline);
				await delay(MESSAGE_TIMING.pollMs);
			}
			const signals: Array<Parameters<typeof messageProcessIO.signal>[0]> = [];
			const io = {
				...messageProcessIO,
				signal: (request) => {
					signals.push(request);
					return messageProcessIO.signal(request);
				},
			} satisfies typeof messageProcessIO;
			const control = createMessageProcessControl({ socket, io });
			await control.shutdown({ deadline: performance.now() + MESSAGE_TIMING.shutdownMs });
			expect(control.observedIdentities().some(({ pid }) => pid === child)).toBe(true);
			expect(signals.some(({ pid }) => pid === child)).toBe(false);
			rmSync(work, { recursive: true });
		},
		MESSAGE_TEST_TIMEOUT,
	);

	it(
		"freezes a real spawning tree without executing its spawn-on-TERM handler",
		async () => {
			const work = mkdtempSync(join(tmpdir(), "pi-quiescence-"));
			const socket = join(work, "tmux.socket");
			const ready = join(work, "ready");
			const term = join(work, "term");
			const control = createMessageProcessControl({ socket });
			const script = `const fs = require('node:fs'); const { spawn } = require('node:child_process');
let count = 0;
const child = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(term)}, 'handler executed'); child(); });
const interval = setInterval(() => { child(); count++; if (count === 2) fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); if (count === 8) clearInterval(interval); }, 100);
setInterval(() => {}, 1000);`;
			await runOwnedCommand({
				command: MESSAGE_PROCESS_COMMANDS.tmux,
				args: [
					"-S",
					socket,
					"-f",
					"/dev/null",
					"new-session",
					"-d",
					"-s",
					"fixture",
					"-c",
					work,
					process.execPath,
					"-e",
					script,
				],
				deadline: performance.now() + MESSAGE_TIMING.commandMs,
			});
			const deadline = performance.now() + MESSAGE_TIMING.shutdownMs;
			while (!existsSync(ready)) {
				if (performance.now() >= deadline) throw new Error(PROCESS_ERRORS.deadline);
				await delay(MESSAGE_TIMING.pollMs);
			}
			expect(readFileSync(ready, "utf8")).toBe("ready");
			await control.shutdown({ deadline: performance.now() + MESSAGE_TIMING.shutdownMs });
			expect(control.observedIdentities().length).toBeGreaterThanOrEqual(4);
			expect(existsSync(term)).toBe(false);
			// Refusal intentionally retains the workspace and identities for diagnosis.
			rmSync(work, { recursive: true });
		},
		MESSAGE_TEST_TIMEOUT,
	);
});
