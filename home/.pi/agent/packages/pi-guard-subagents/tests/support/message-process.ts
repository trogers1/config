import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Type, type Static } from "typebox";
import { parseOrThrow } from "../../extensions/interactive/types.ts";

export const MESSAGE_PROCESS_COMMANDS = Object.freeze({ tmux: "tmux", ps: "ps" });
export const MESSAGE_TIMING = Object.freeze({
	executionMs: 60_000,
	shutdownMs: 15_000,
	validationMs: 5_000,
	runnerMarginMs: 10_000,
	commandMs: 2_000,
	pollMs: 50,
	birthBucketMs: 1_000,
	birthMarginMs: 1_000,
	clockSlackMs: 250,
});
export const MESSAGE_TEST_TIMEOUT =
	MESSAGE_TIMING.executionMs + MESSAGE_TIMING.shutdownMs + MESSAGE_TIMING.validationMs + MESSAGE_TIMING.runnerMarginMs;
export const PROCESS_ERRORS = Object.freeze({
	deadline: "Owned command or lifecycle deadline exceeded",
	command: "Owned subprocess failed",
	clock: "Refusing ambiguous process clock",
	identity: "Refusing changed or missing owned process identity",
	ancestry: "Refusing unverified stopped ancestry",
	state: "Refusing process termination before quiescence",
	metadata: "Invalid owned process metadata",
});

export async function runOwnedCommand({
	command,
	args,
	deadline,
	env,
}: {
	command: string;
	args: readonly string[];
	deadline: number;
	env?: ExecFileOptionsWithStringEncoding["env"];
}): Promise<string> {
	const remaining = deadline - performance.now();
	if (remaining <= 0) throw new Error(PROCESS_ERRORS.deadline);
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{
				encoding: "utf8",
				env,
				timeout: Math.max(1, Math.ceil(Math.min(remaining, MESSAGE_TIMING.commandMs))),
				killSignal: "SIGKILL",
			},
			(error, stdout) => {
				if (error) reject(new Error(error.killed ? PROCESS_ERRORS.deadline : PROCESS_ERRORS.command));
				else resolve(stdout);
			},
		);
	});
}

export const messageProcessIO = {
	command: runOwnedCommand,
	signal: ({ pid, signal }: { pid: number; signal: NodeJS.Signals }) => process.kill(pid, signal),
	now: () => performance.now(),
	wall: () => Date.now(),
	wait: async ({ milliseconds }: { milliseconds: number }) => {
		await delay(milliseconds);
	},
};
const ProcessSchema = Type.Object({
	pid: Type.Integer({ minimum: 0 }),
	parent: Type.Integer({ minimum: 0 }),
	state: Type.String({ minLength: 1 }),
	birth: Type.String({ minLength: 1 }),
	birthMs: Type.Number(),
});
type ProcessIdentity = Static<typeof ProcessSchema>;

function birthTime({ value }: { value: string }): number {
	const milliseconds = Date.parse(`${value} UTC`);
	if (!Number.isFinite(milliseconds)) throw new Error(PROCESS_ERRORS.metadata);
	const [weekday, day, month, year, time, zone] = new Date(milliseconds).toUTCString().split(" ");
	if (!weekday || zone !== "GMT" || `${weekday.replace(",", "")} ${month} ${Number(day)} ${time} ${year}` !== value)
		throw new Error(PROCESS_ERRORS.metadata);
	return milliseconds;
}

/** Conservative cleanup of the observed tmux tree, not containment of daemon escape. */
export function createMessageProcessControl({
	socket,
	io = messageProcessIO,
}: {
	socket: string;
	io?: typeof messageProcessIO;
}) {
	const origin = { monotonic: io.now(), wall: io.wall() };
	const identities = new Map<number, ProcessIdentity>();
	const stopped = new Set<number>();
	const terminal = new Set<number>();
	const killed = new Set<number>();
	let root: ProcessIdentity | undefined;
	function checkBudget({ deadline }: { deadline: number }) {
		const now = io.now();
		if (Math.abs(io.wall() - origin.wall - (now - origin.monotonic)) > MESSAGE_TIMING.clockSlackMs)
			throw new Error(PROCESS_ERRORS.clock);
		if (now >= deadline) throw new Error(PROCESS_ERRORS.deadline);
	}
	async function pause({ deadline }: { deadline: number }) {
		checkBudget({ deadline });
		await io.wait({ milliseconds: Math.min(MESSAGE_TIMING.pollMs, deadline - io.now()) });
		checkBudget({ deadline });
	}
	async function table({ deadline }: { deadline: number }) {
		checkBudget({ deadline });
		const output = await io.command({
			command: MESSAGE_PROCESS_COMMANDS.ps,
			args: ["-axo", "pid=,ppid=,stat=,lstart="],
			deadline,
			env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
		});
		checkBudget({ deadline });
		return new Map(
			output
				.trim()
				.split("\n")
				.map((line) => {
					const [pid, parent, state, ...parts] = line.trim().split(/\s+/);
					const birth = parts.join(" ");
					const value = parseOrThrow(
						ProcessSchema,
						{ pid: Number(pid), parent: Number(parent), state, birth, birthMs: birthTime({ value: birth }) },
						"process metadata",
					);
					return [value.pid, value];
				}),
		);
	}
	function currentIdentity({
		identity,
		processes,
	}: {
		identity: ProcessIdentity;
		processes: Map<number, ProcessIdentity>;
	}) {
		const current = processes.get(identity.pid);
		if (!current || current.birth !== identity.birth || current.parent !== identity.parent)
			throw new Error(PROCESS_ERRORS.identity);
		return current;
	}
	function verifyParent({
		identity,
		processes,
	}: {
		identity: ProcessIdentity;
		processes: Map<number, ProcessIdentity>;
	}) {
		if (identity.pid === root?.pid) return;
		const parent = identities.get(identity.parent);
		if (!parent || !stopped.has(parent.pid) || !currentIdentity({ identity: parent, processes }).state.startsWith("T"))
			throw new Error(PROCESS_ERRORS.ancestry);
		verifyParent({ identity: parent, processes });
	}
	function verifyAge({ identity }: { identity: ProcessIdentity }) {
		if (io.wall() - identity.birthMs < MESSAGE_TIMING.birthBucketMs + MESSAGE_TIMING.birthMarginMs)
			throw new Error(PROCESS_ERRORS.identity);
	}
	function verifyTerminal({
		identity,
		processes,
	}: {
		identity: ProcessIdentity;
		processes: Map<number, ProcessIdentity>;
	}) {
		const released = killed.has(identity.parent);
		const current = processes.get(identity.pid);
		if (!current) {
			if (released && terminal.has(identity.pid)) return;
			throw new Error(PROCESS_ERRORS.identity);
		}
		if (current.birth !== identity.birth || (!released && current.parent !== identity.parent))
			throw new Error(PROCESS_ERRORS.identity);
		verifyAge({ identity: current });
		if (!current.state.startsWith("Z")) throw new Error(PROCESS_ERRORS.state);
		if (identity.pid === root?.pid || [...processes.values()].some((value) => value.parent === identity.pid))
			throw new Error(PROCESS_ERRORS.ancestry);
		if (!released) verifyParent({ identity, processes });
		stopped.delete(identity.pid);
		terminal.add(identity.pid);
	}
	function verifyQuiescence({ processes }: { processes: Map<number, ProcessIdentity> }) {
		for (const identity of identities.values()) {
			if (killed.has(identity.pid)) continue;
			if (terminal.has(identity.pid)) {
				verifyTerminal({ identity, processes });
				continue;
			}
			const current = currentIdentity({ identity, processes });
			verifyAge({ identity: current });
			if (current.state.startsWith("Z")) verifyTerminal({ identity, processes });
			else {
				verifyParent({ identity, processes });
				if (!stopped.has(identity.pid) || !current.state.startsWith("T")) throw new Error(PROCESS_ERRORS.state);
			}
		}
	}
	async function socketPid({ deadline }: { deadline: number }) {
		checkBudget({ deadline });
		const result = await io.command({
			command: MESSAGE_PROCESS_COMMANDS.tmux,
			args: ["-S", socket, "display-message", "-p", "#{pid}"],
			deadline,
		});
		checkBudget({ deadline });
		const pid = Number(result.trim());
		if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(PROCESS_ERRORS.metadata);
		return pid;
	}
	async function freeze({ identity, deadline }: { identity: ProcessIdentity; deadline: number }) {
		// Record the first discovered identity. Never adopt a replacement during waits.
		const prior = identities.get(identity.pid);
		if (prior && (prior.birth !== identity.birth || prior.parent !== identity.parent))
			throw new Error(PROCESS_ERRORS.identity);
		identities.set(identity.pid, identity);
		while (true) {
			const processes = await table({ deadline });
			const current = currentIdentity({ identity, processes });
			verifyParent({ identity, processes });
			if (io.wall() - current.birthMs < MESSAGE_TIMING.birthBucketMs + MESSAGE_TIMING.birthMarginMs) {
				if (identity.pid === root?.pid && (await socketPid({ deadline })) !== identity.pid)
					throw new Error(PROCESS_ERRORS.identity);
				await pause({ deadline });
				continue;
			}
			// Reconfirm socket ownership after the age wait, before the server is stopped.
			if (identity.pid === root?.pid && (await socketPid({ deadline })) !== identity.pid)
				throw new Error(PROCESS_ERRORS.identity);
			const fresh = await table({ deadline });
			const target = currentIdentity({ identity, processes: fresh });
			verifyParent({ identity, processes: fresh });
			verifyAge({ identity: target });
			if (target.state.startsWith("Z")) {
				verifyTerminal({ identity, processes: fresh });
				return;
			}
			checkBudget({ deadline });
			io.signal({ pid: identity.pid, signal: "SIGSTOP" });
			break;
		}
		while (true) {
			const processes = await table({ deadline });
			const current = currentIdentity({ identity, processes });
			verifyParent({ identity, processes });
			verifyAge({ identity: current });
			if (current.state.startsWith("T")) {
				stopped.add(identity.pid);
				return;
			}
			if (current.state.startsWith("Z")) {
				verifyTerminal({ identity, processes });
				return;
			}
			await pause({ deadline });
		}
	}
	async function shutdown({ deadline }: { deadline: number }) {
		const pid = await socketPid({ deadline });
		const candidate = (await table({ deadline })).get(pid);
		if (!candidate) throw new Error(PROCESS_ERRORS.identity);
		root = candidate;
		await freeze({ identity: root, deadline });
		let stable = false;
		while (!stable) {
			const processes = await table({ deadline });
			verifyQuiescence({ processes });
			const children = [...processes.values()].filter(
				(value) => identities.has(value.parent) && !identities.has(value.pid),
			);
			if (children.length) {
				for (const child of children) identities.set(child.pid, child);
				for (const child of children) await freeze({ identity: child, deadline });
			} else {
				await pause({ deadline });
				const confirmation = await table({ deadline });
				verifyQuiescence({ processes: confirmation });
				stable = ![...confirmation.values()].some(
					(value) => identities.has(value.parent) && !identities.has(value.pid),
				);
			}
		}
		// Parents were inserted first; kill children first while their ancestors stay stopped.
		for (const identity of [...identities.values()].reverse()) {
			const processes = await table({ deadline });
			verifyQuiescence({ processes });
			if (terminal.has(identity.pid)) continue;
			checkBudget({ deadline });
			io.signal({ pid: identity.pid, signal: "SIGKILL" });
			stopped.delete(identity.pid);
			killed.add(identity.pid);
		}
		while (true) {
			const processes = await table({ deadline });
			verifyQuiescence({ processes });
			let active = false;
			for (const identity of identities.values()) {
				if (terminal.has(identity.pid)) continue;
				if (!killed.has(identity.pid)) throw new Error(PROCESS_ERRORS.state);
				const current = processes.get(identity.pid);
				if (!current) continue; // Expected after our verified SIGKILL, not an ownership fallback.
				if (current.birth !== identity.birth) throw new Error(PROCESS_ERRORS.identity);
				if (!current.state.startsWith("Z")) active = true;
			}
			if (!active) return;
			await pause({ deadline });
		}
	}
	return { shutdown, observedIdentities: () => [...identities.values()] };
}
