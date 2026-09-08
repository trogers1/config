import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

const interactiveExtensionRoot = path.dirname(fileURLToPath(import.meta.url));
export const REQUIRED_GUARD_EXTENSION_PATH = path.resolve(
	interactiveExtensionRoot,
	"../../../pi-guard/extensions/guard.ts",
);
export const REQUIRED_CHILD_RUNTIME_PATH = path.resolve(interactiveExtensionRoot, "child-runtime.ts");

const NullableString = Type.Union([Type.String(), Type.Null()]);
const ClaimSchema = Type.Object({ token: Type.String(), claimedAt: Type.String() });
const GuardedInteractiveLoadoutSchema = Type.Object({
	version: Type.Literal(1),
	attemptId: Type.String(),
	agent: Type.String(),
	profile: NullableString,
	writes: Type.Union([Type.Array(Type.String()), Type.Null()]),
	toolAllowlist: Type.Array(Type.String()),
	guardExtensionPath: Type.String(),
	childRuntimePath: Type.String(),
	backingExtensionPaths: Type.Array(Type.String()),
	backingExtensionDigests: Type.Array(
		Type.Object({ path: Type.String(), sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }) }),
	),
	model: NullableString,
	thinking: NullableString,
	systemPromptMode: Type.Union([Type.Literal("append"), Type.Null()]),
	identity: NullableString,
	cwd: Type.String(),
	agentDir: NullableString,
	codingAgentDir: NullableString,
	autoExit: Type.Boolean(),
});
export type GuardedInteractiveLoadout = Static<typeof GuardedInteractiveLoadoutSchema>;

const ChildStateSchema = Type.Union([
	Type.Literal("starting"),
	Type.Literal("active"),
	Type.Literal("waiting"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("stalled"),
]);
const ModeSchema = Type.Union([Type.Literal("single"), Type.Literal("parallel"), Type.Literal("chain")]);
const TaskSchema = Type.Object({
	agent: Type.String(),
	task: Type.String(),
	cwd: Type.Optional(Type.String()),
	writes: Type.Optional(Type.Array(Type.String())),
	sessionId: Type.Optional(Type.String()),
	label: Type.Optional(Type.String()),
});
export const ChildRecordSchema = Type.Object({
	name: Type.String(),
	attemptId: Type.String(),
	sessionId: Type.String(),
	paneId: Type.Union([Type.String(), Type.Null()]),
	startedAt: Type.String(),
	task: Type.String(),
	agent: Type.String(),
	loadoutPath: Type.String(),
	loadoutDigest: Type.String(),
	loadoutSnapshot: GuardedInteractiveLoadoutSchema,
	authorityPath: Type.String(),
	state: ChildStateSchema,
	question: Type.Optional(Type.String()),
	questionAnswered: Type.Optional(Type.Boolean()),
	handoffPath: Type.Optional(Type.String()),
	delivered: Type.Optional(Type.Boolean()),
	deliveryClaim: Type.Optional(ClaimSchema),
	deliveryId: Type.Optional(Type.String()),
	questionClaim: Type.Optional(ClaimSchema),
	handoffDir: Type.Optional(Type.String()),
	handoffName: Type.Optional(Type.String()),
	mode: Type.Optional(ModeSchema),
	chainStep: Type.Optional(Type.Integer({ minimum: 0 })),
	result: Type.Optional(Type.String()),
	deliveryResult: Type.Optional(Type.String()),
	deliveryFailure: Type.Optional(Type.String()),
	usage: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	model: Type.Optional(Type.String()),
	toolCalls: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
	failure: Type.Optional(Type.String()),
	completedAt: Type.Optional(Type.String()),
	questionDelivered: Type.Optional(Type.Boolean()),
});
export type ChildState = Static<typeof ChildStateSchema>;
export type ChildRecord = Static<typeof ChildRecordSchema>;
const ChainStateSchema = Type.Object({
	steps: Type.Array(TaskSchema, { minItems: 1 }),
	authorizedAgents: Type.Array(Type.String()),
	authorizedLoadouts: Type.Array(GuardedInteractiveLoadoutSchema),
	nextIndex: Type.Integer({ minimum: 0 }),
	previous: Type.String(),
	progressed: Type.Array(Type.Boolean()),
	runningIndex: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
	failed: Type.Boolean(),
});
export type ChainState = Static<typeof ChainStateSchema>;
export const RegistrySchema = Type.Object({
	version: Type.Literal(1),
	parentSession: Type.String(),
	runId: Type.String(),
	children: Type.Array(ChildRecordSchema),
	chain: Type.Optional(ChainStateSchema),
});
export type Registry = Static<typeof RegistrySchema>;
const PermissionBlockSchema = Type.Object({ toolName: Type.String(), text: Type.String() });
const ObservedToolCallSchema = Type.Object({
	toolName: Type.String(),
	args: Type.Record(Type.String(), Type.Unknown()),
});
export const UsageSchema = Type.Object({
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
	reasoning: Type.Optional(Type.Number()),
	totalTokens: Type.Number(),
	cost: Type.Object({
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		total: Type.Number(),
	}),
});
export const TerminalSignalSchema = Type.Object({
	version: Type.Optional(Type.Literal(1)),
	status: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
	attemptId: Type.String(),
	result: Type.String(),
	failure: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	observedPaths: Type.Optional(Type.Array(Type.String())),
	permissionBlocks: Type.Optional(Type.Array(PermissionBlockSchema)),
	usage: Type.Optional(UsageSchema),
	model: Type.Optional(Type.String()),
	toolCalls: Type.Optional(Type.Array(ObservedToolCallSchema)),
	at: Type.Optional(Type.String()),
});
export type TerminalSignal = Static<typeof TerminalSignalSchema>;
export const QuestionSchema = Type.Object({
	attemptId: Type.String(),
	question: Type.String(),
	answered: Type.Boolean(),
});
export const ReplySchema = Type.Object({ attemptId: Type.String(), answer: Type.String() });
export const SteeringMessageSchema = Type.Object({
	version: Type.Literal(1),
	attemptId: Type.String(),
	message: Type.String(),
});
export const LockOwnerSchema = Type.Object({
	pid: Type.Optional(Type.Integer({ minimum: 1 })),
	startedAt: Type.Number(),
	token: Type.String(),
});
const ActivityKindSchema = Type.Union([
	Type.Literal("start"),
	Type.Literal("turn"),
	Type.Literal("provider"),
	Type.Literal("tool"),
	Type.Literal("question"),
	Type.Literal("complete"),
	Type.Literal("shutdown"),
]);
export type ActivityKind = Static<typeof ActivityKindSchema>;
export const ActivitySchema = Type.Array(
	Type.Object({
		version: Type.Literal(1),
		at: Type.String(),
		kind: ActivityKindSchema,
		detail: Type.Optional(Type.String()),
	}),
);
export type Activity = Static<typeof ActivitySchema>;
export function parseOrThrow<T extends TSchema>(schema: T, value: unknown, label: string): Static<T> {
	if (!Value.Check(schema, value)) throw new Error(`Invalid ${label}`);
	return value as Static<T>;
}
export function readJson<T extends TSchema>(file: string, schema: T, label: string): Static<T> {
	let value: unknown;
	try {
		value = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`Unable to read ${label}: ${String(error)}`);
	}
	return parseOrThrow(schema, value, label);
}

export function snapshotBackingExtensions(
	paths: readonly string[],
): GuardedInteractiveLoadout["backingExtensionDigests"] {
	return paths.map((extension) => ({
		path: path.resolve(extension),
		sha256: crypto.createHash("sha256").update(fs.readFileSync(extension)).digest("hex"),
	}));
}

/* Runtime schemas are the source of truth for all persisted records. */
export function validateLoadout(value: unknown): GuardedInteractiveLoadout {
	const loadout = parseOrThrow(GuardedInteractiveLoadoutSchema, value, "guarded interactive loadout");
	if (!loadout.toolAllowlist.includes("ask_question"))
		throw new Error("Invalid guarded interactive loadout: missing required security fields (ask_question)");
	const guardExtensionPath = loadout.guardExtensionPath;
	const childRuntimePath = loadout.childRuntimePath;
	// A persisted loadout is security-sensitive. Existence alone is not enough:
	// an edited sidecar must not be able to replace pi-guard with an arbitrary
	// extension while retaining the interactive launcher. Keep this check tied
	// to the sibling package used by the launcher, rather than accepting any
	// path that merely happens to contain a directory named pi-guard.
	const isGuardPath = path.resolve(guardExtensionPath) === REQUIRED_GUARD_EXTENSION_PATH;
	const isRuntimePath = path.resolve(childRuntimePath) === REQUIRED_CHILD_RUNTIME_PATH;
	if (
		!path.isAbsolute(guardExtensionPath) ||
		!path.isAbsolute(childRuntimePath) ||
		!isGuardPath ||
		!isRuntimePath ||
		!fs.existsSync(guardExtensionPath) ||
		!fs.existsSync(childRuntimePath)
	)
		throw new Error("Invalid guarded interactive loadout: required guard/runtime path is unavailable");
	if (loadout.backingExtensionPaths.some((extension) => !path.isAbsolute(extension) || !fs.existsSync(extension)))
		throw new Error("Invalid guarded interactive loadout: backing extension path is unavailable");
	const resolvedBackingPaths = loadout.backingExtensionPaths.map((extension) => path.resolve(extension));
	if (
		loadout.backingExtensionDigests.length !== resolvedBackingPaths.length ||
		loadout.backingExtensionDigests.some(
			(identity, index) =>
				identity.path !== resolvedBackingPaths[index] ||
				crypto.createHash("sha256").update(fs.readFileSync(identity.path)).digest("hex") !== identity.sha256,
		)
	)
		throw new Error("Invalid guarded interactive loadout: backing extension content changed");
	if (
		loadout.codingAgentDir !== null &&
		(!path.isAbsolute(loadout.codingAgentDir) || !fs.existsSync(loadout.codingAgentDir))
	)
		throw new Error("Invalid guarded interactive loadout: coding agent directory is unavailable");
	if (loadout.systemPromptMode === "append" && (loadout.identity === null || !fs.existsSync(loadout.identity)))
		throw new Error("Invalid guarded interactive loadout: identity prompt is unavailable");
	return loadout;
}
export function atomicJsonWrite(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
	fs.renameSync(tmp, file);
}
