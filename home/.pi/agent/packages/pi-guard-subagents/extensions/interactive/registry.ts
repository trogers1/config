import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import {
	atomicJsonWrite,
	readJson,
	RegistrySchema,
	ChildRecordSchema,
	parseOrThrow,
	LockOwnerSchema,
	validateLoadout,
	type ChainState,
	type ChildRecord,
	type Registry,
} from "./types.ts";
export function registryPath(cwd: string, runId: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) || runId === "." || runId === "..")
		throw new Error("Invalid orchestration run ID");
	return path.join(cwd, ".pi", "orchestration", runId, "registry.json");
}
function validChild(c: unknown): c is ChildRecord {
	let child: ChildRecord;
	try {
		child = parseOrThrow(ChildRecordSchema, c, "child record");
	} catch {
		return false;
	}
	if (
		typeof child.name !== "string" ||
		typeof child.attemptId !== "string" ||
		typeof child.sessionId !== "string" ||
		typeof child.startedAt !== "string" ||
		typeof child.task !== "string" ||
		typeof child.agent !== "string" ||
		typeof child.loadoutPath !== "string" ||
		!(child.paneId === null || typeof child.paneId === "string") ||
		!["starting", "active", "waiting", "completed", "failed", "stalled"].includes(child.state)
	)
		return false;
	return (
		(child.question === undefined || typeof child.question === "string") &&
		(child.questionAnswered === undefined || typeof child.questionAnswered === "boolean") &&
		(child.questionDelivered === undefined || typeof child.questionDelivered === "boolean") &&
		(child.handoffPath === undefined || typeof child.handoffPath === "string") &&
		(child.delivered === undefined || typeof child.delivered === "boolean") &&
		(child.deliveryId === undefined || typeof child.deliveryId === "string") &&
		(child.deliveryClaim === undefined ||
			(typeof child.deliveryClaim === "object" &&
				child.deliveryClaim !== null &&
				typeof child.deliveryClaim.token === "string" &&
				typeof child.deliveryClaim.claimedAt === "string")) &&
		(child.questionClaim === undefined ||
			(typeof child.questionClaim === "object" &&
				child.questionClaim !== null &&
				typeof child.questionClaim.token === "string" &&
				typeof child.questionClaim.claimedAt === "string")) &&
		(child.handoffDir === undefined || typeof child.handoffDir === "string") &&
		(child.handoffName === undefined || typeof child.handoffName === "string") &&
		(child.result === undefined || typeof child.result === "string") &&
		(child.deliveryResult === undefined || typeof child.deliveryResult === "string") &&
		(child.deliveryFailure === undefined || typeof child.deliveryFailure === "string") &&
		(child.usage === undefined || (typeof child.usage === "object" && child.usage !== null)) &&
		(child.model === undefined || typeof child.model === "string") &&
		(child.toolCalls === undefined || Array.isArray(child.toolCalls)) &&
		(child.failure === undefined || typeof child.failure === "string") &&
		(child.completedAt === undefined || typeof child.completedAt === "string") &&
		(child.mode === undefined || ["single", "parallel", "chain"].includes(child.mode)) &&
		(child.chainStep === undefined || (Number.isInteger(child.chainStep) && child.chainStep >= 0)) &&
		typeof child.loadoutDigest === "string" &&
		/^[a-f0-9]{64}$/.test(child.loadoutDigest) &&
		typeof child.authorityPath === "string" &&
		(() => {
			try {
				validateLoadout(child.loadoutSnapshot);
				return child.attemptId === child.loadoutSnapshot.attemptId;
			} catch {
				return false;
			}
		})()
	);
}
function validChain(chain: ChainState): boolean {
	if (chain.authorizedAgents.length !== chain.steps.length || chain.authorizedLoadouts.length !== chain.steps.length)
		return false;
	if (!validRunningIndex(chain)) return false;
	if (chain.runningIndex !== null)
		return (
			!chain.progressed[chain.runningIndex] &&
			chain.progressed.slice(0, chain.runningIndex).every(Boolean) &&
			chain.progressed.slice(chain.nextIndex).every((v) => !v)
		);
	if (chain.failed && chain.nextIndex > 0 && !chain.progressed[chain.nextIndex - 1])
		return (
			chain.progressed.slice(0, chain.nextIndex - 1).every(Boolean) &&
			chain.progressed.slice(chain.nextIndex).every((v) => !v)
		);
	return chain.progressed.every(Boolean) && chain.nextIndex === chain.steps.length;
}
function validRunningIndex(chain: ChainState): boolean {
	return (
		chain.runningIndex === null ||
		(Number.isInteger(chain.runningIndex) &&
			chain.runningIndex >= 0 &&
			chain.runningIndex < chain.steps.length &&
			chain.runningIndex < chain.nextIndex)
	);
}
function validateRegistry(value: unknown, file: string): Registry {
	if (!value || typeof value !== "object") throw new Error("Invalid interactive orchestration registry");
	const r = parseOrThrow(RegistrySchema, value, "interactive orchestration registry");
	if (
		r.version !== 1 ||
		typeof r.parentSession !== "string" ||
		typeof r.runId !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(r.runId) ||
		r.runId !== path.basename(path.dirname(file)) ||
		!Array.isArray(r.children) ||
		!r.children.every(validChild) ||
		(r.chain !== undefined && !validChain(r.chain))
	)
		throw new Error("Invalid interactive orchestration registry");
	return r;
}
function withRegistryLock<T>(file: string, fn: () => T): T {
	const lock = `${file}.lock`;
	const token = randomUUID();
	let acquired = false;
	for (let attempt = 0; attempt < 100 && !acquired; attempt++) {
		try {
			fs.mkdirSync(lock);
			fs.writeFileSync(path.join(lock, "owner"), JSON.stringify({ pid: process.pid, startedAt: Date.now(), token }), {
				mode: 0o600,
			});
			acquired = true;
		} catch {
			try {
				const age = Date.now() - fs.statSync(lock).mtimeMs;
				const owner = parseOrThrow(
					LockOwnerSchema,
					JSON.parse(fs.readFileSync(path.join(lock, "owner"), "utf8")),
					"registry lock owner",
				);
				let alive = false;
				if (typeof owner.pid === "number") {
					try {
						process.kill(owner.pid, 0);
						alive = true;
					} catch {
						alive = false;
					}
				}
				if (age > 60_000 && !alive && typeof owner.token === "string")
					fs.rmSync(lock, { recursive: true, force: true });
			} catch {
				/* another writer owns or removed it */
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
		}
	}
	if (!acquired) throw new Error(`Timed out waiting for registry lock: ${file}`);
	try {
		return fn();
	} finally {
		try {
			const owner = parseOrThrow(
				LockOwnerSchema,
				JSON.parse(fs.readFileSync(path.join(lock, "owner"), "utf8")),
				"registry lock owner",
			);
			if (owner.token === token) fs.rmSync(lock, { recursive: true, force: true });
		} catch {
			/* stale-lock recovery or another owner won */
		}
	}
}
export function ensureRegistry(file: string, parentSession: string): Registry {
	return fs.existsSync(file) ? loadRegistry(file) : createRegistry(file, parentSession);
}
function createRegistry(file: string, parentSession: string): Registry {
	const r: Registry = { version: 1, parentSession, runId: path.basename(path.dirname(file)), children: [] };
	atomicJsonWrite(file, r);
	return r;
}
export function findChildBySessionRegistry(
	cwd: string,
	parentSession: string,
	sessionId: string,
): { registry: Registry; file: string } | null {
	const root = path.join(cwd, ".pi", "orchestration");
	if (!fs.existsSync(root)) return null;
	const matches: Array<{ registry: Registry; file: string }> = [];
	for (const run of fs.readdirSync(root, { withFileTypes: true })) {
		if (!run.isDirectory()) continue;
		const file = path.join(root, run.name, "registry.json");
		if (!fs.existsSync(file)) continue;
		try {
			const registry = loadRegistry(file);
			if (registry.parentSession === parentSession && registry.children.some((child) => child.sessionId === sessionId))
				matches.push({ registry, file });
		} catch {
			/* ignore unrelated/incomplete registries */
		}
	}
	if (matches.length > 1) throw new Error(`Ambiguous subagent session: ${sessionId}`);
	return matches[0] ?? null;
}

export function findChildRegistry(
	cwd: string,
	parentSession: string,
	name: string,
): { registry: Registry; file: string } | null {
	const root = path.join(cwd, ".pi", "orchestration");
	if (!fs.existsSync(root)) return null;
	const matches: Array<{ registry: Registry; file: string }> = [];
	for (const run of fs.readdirSync(root, { withFileTypes: true })) {
		if (!run.isDirectory()) continue;
		const file = path.join(root, run.name, "registry.json");
		if (!fs.existsSync(file)) continue;
		let registry: Registry;
		try {
			registry = loadRegistry(file);
		} catch (error) {
			// A registry owned by this parent must not silently disappear.
			try {
				const raw = readJson(file, RegistrySchema, "interactive registry");
				if (raw.parentSession === parentSession) throw error;
			} catch (nested) {
				if (nested === error) throw error;
			}
			continue;
		}
		if (registry.parentSession === parentSession && registry.children.some((child) => child.name === name))
			matches.push({ registry, file });
	}
	if (matches.length > 1) throw new Error(`Ambiguous subagent name: ${name}; use a run-qualified identifier`);
	return matches[0] ?? null;
}
export function loadRegistry(file: string): Registry {
	return validateRegistry(readJson(file, RegistrySchema, "interactive registry"), file);
}
export function setChain(file: string, chain: ChainState, parentSession = "unknown"): Registry {
	return withRegistryLock(file, () => {
		const r = ensureRegistry(file, parentSession);
		r.chain = chain;
		atomicJsonWrite(file, r);
		return r;
	});
}
export function addChild(
	file: string,
	child: ChildRecord,
	parentSession = "unknown",
): { added: boolean; child: ChildRecord } {
	return withRegistryLock(file, () => {
		const r = ensureRegistry(file, parentSession);
		if (child.mode === "chain" && child.chainStep !== undefined) {
			const existing = r.children.find((entry) => entry.mode === "chain" && entry.chainStep === child.chainStep);
			if (existing) return { added: false, child: { ...existing } };
		}
		r.children.push(child);
		atomicJsonWrite(file, r);
		return { added: true, child: { ...child } };
	});
}
export function updateChild(file: string, name: string, patch: Partial<ChildRecord>): Registry {
	return withRegistryLock(file, () => {
		const r = loadRegistry(file);
		const c = r.children.find((x) => x.name === name);
		if (!c) throw new Error(`Unknown interactive child: ${name}`);
		Object.assign(c, patch);
		atomicJsonWrite(file, r);
		return r;
	});
}

/** Reload and conditionally update one child while holding the registry lock. */
export function claimChild(
	file: string,
	name: string,
	canClaim: (child: ChildRecord) => boolean,
	patch: Partial<ChildRecord>,
): ChildRecord | undefined {
	return withRegistryLock(file, () => {
		const registry = loadRegistry(file);
		const child = registry.children.find((entry) => entry.name === name);
		if (!child || !canClaim(child)) return undefined;
		Object.assign(child, patch);
		atomicJsonWrite(file, registry);
		return { ...child };
	});
}
