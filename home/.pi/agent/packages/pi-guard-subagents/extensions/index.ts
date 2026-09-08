/** Guarded interactive subagents. Every child is a real Pi process in a tmux pane. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	ensureRegistry,
	findChildBySessionRegistry,
	findChildRegistry,
	loadRegistry,
	registryPath,
	setChain,
	updateChild,
} from "./interactive/registry.ts";
import {
	launchChild,
	persistApprovedChainLoadout,
	readApprovedChainLoadout,
	resumeChild,
	validateResumeLoadout,
} from "./interactive/launcher.ts";
import { hasTmux, paneExists } from "./interactive/tmux.ts";
import { watchRegistry } from "./interactive/recovery.ts";
import { formatStatus } from "./interactive/status.ts";
import {
	atomicJsonWrite,
	parseOrThrow,
	QuestionSchema,
	REQUIRED_CHILD_RUNTIME_PATH,
	REQUIRED_GUARD_EXTENSION_PATH,
	snapshotBackingExtensions,
	validateLoadout,
	type GuardedInteractiveLoadout,
	type ChildRecord,
	type TerminalSignal,
} from "./interactive/types.ts";
import { discoverAgents, type AgentConfig, type AgentScope } from "./agents.ts";
import { ensureRunDir, slugify } from "./handoff.ts";

export {
	authorityPath,
	buildChildCommand,
	chainAuthorityPath,
	launchChild,
	persistApprovedChainLoadout,
	readApprovedChainLoadout,
	resumeChild,
	validateResumeLoadout,
} from "./interactive/launcher.ts";
export { recordActivity, readActivity } from "./interactive/activity.ts";
export { classifyChild, formatChildStatus, formatStatus } from "./interactive/status.ts";
export { pendingChildren, watchRegistry } from "./interactive/recovery.ts";
export { validateLoadout, atomicJsonWrite, readJson } from "./interactive/types.ts";
export function resolveChildTools(tools: string[] | undefined): { tools: string[]; backingExtensionPaths: string[] } {
	const builtins = new Set(["read", "write", "edit", "bash", "grep", "find", "ls", "ask_question"]);
	const selected = [
		...new Set([...(tools ?? ["read", "write", "edit", "bash", "grep", "find", "ls"]), "ask_question"]),
	].filter((tool) => tool.length > 0);
	let mappings: Record<string, unknown> = {};
	try {
		mappings = JSON.parse(process.env.PI_SUBAGENT_TOOL_BACKING ?? "{}");
	} catch {
		throw new Error("Refusing child tools: PI_SUBAGENT_TOOL_BACKING is malformed");
	}
	const backingExtensionPaths = new Set<string>();
	for (const tool of selected) {
		if (builtins.has(tool)) continue;
		const extension = mappings[tool];
		if (typeof extension !== "string" || !fs.existsSync(extension))
			throw new Error(`Refusing child tool allowlist with no known backing extension: ${tool}`);
		backingExtensionPaths.add(path.resolve(extension));
	}
	return { tools: selected, backingExtensionPaths: [...backingExtensionPaths] };
}
export { requireTmux, tmux, paneExists, createPane, sendKeys, closePane, hasTmux } from "./interactive/tmux.ts";
export { default as childRuntime } from "./interactive/child-runtime.ts";
export { writeHandoffFile, extractFilesChanged, checkScopeViolations } from "./handoff.ts";
export type { UsageStats, PermissionBlock, HandoffRecord } from "./handoff.ts";

const MAX_PARALLEL = 8;
const ASYNC_WAIT_GUIDANCE =
	"Subagents run asynchronously. Do not call sleep or poll the registry. End this turn; Pi will automatically start a follow-up when a child asks a question or reaches a terminal outcome.";
const PARENT_PROFILE = "PI_GUARD_ACTIVE_PROFILE";
const AgentScopes = ["builtin", "user", "project", "all"] satisfies readonly AgentScope[];
const Params = Type.Object({
	agent: Type.Optional(Type.String()),
	task: Type.Optional(Type.String()),
	tasks: Type.Optional(
		Type.Array(
			Type.Object({
				agent: Type.String(),
				task: Type.String(),
				cwd: Type.Optional(Type.String()),
				writes: Type.Optional(Type.Array(Type.String())),
				sessionId: Type.Optional(Type.String()),
				label: Type.Optional(Type.String()),
			}),
		),
	),
	chain: Type.Optional(
		Type.Array(
			Type.Object({
				agent: Type.String(),
				task: Type.String(),
				cwd: Type.Optional(Type.String()),
				writes: Type.Optional(Type.Array(Type.String())),
				sessionId: Type.Optional(Type.String()),
				label: Type.Optional(Type.String()),
			}),
		),
	),
	agentScope: Type.Optional(StringEnum(AgentScopes)),
	confirmProjectAgents: Type.Optional(Type.Boolean()),
	cwd: Type.Optional(Type.String()),
	writes: Type.Optional(Type.Array(Type.String())),
	sessionId: Type.Optional(Type.String()),
	label: Type.Optional(Type.String()),
	runDir: Type.Optional(Type.String()),
});
type ParamsType = Static<typeof Params>;

type Details = { mode: "single" | "parallel" | "chain"; registry?: string; children: ChildRecord[] };
type ParentContext = Pick<ExtensionContext, "hasUI" | "mode" | "cwd" | "sessionManager" | "ui">;
function profile(agent: AgentConfig): string | null {
	return process.env[PARENT_PROFILE]?.trim() || agent.profile || null;
}
function childLoadout(
	agent: AgentConfig,
	request: { cwd?: string; writes?: string[] },
	cwd: string,
	runId: string,
): GuardedInteractiveLoadout {
	const guard = REQUIRED_GUARD_EXTENSION_PATH;
	const runtime = REQUIRED_CHILD_RUNTIME_PATH;
	const childTools = resolveChildTools(agent.tools);
	const tools = childTools.tools;
	const identity = agent.systemPrompt.trim()
		? path.join(cwd, ".pi", "orchestration", runId, `identity-${agent.name}.md`)
		: null;
	if (identity) {
		fs.mkdirSync(path.dirname(identity), { recursive: true });
		fs.writeFileSync(identity, agent.systemPrompt, { mode: 0o600 });
	}
	const value: GuardedInteractiveLoadout = {
		version: 1,
		attemptId: crypto.randomUUID(),
		agent: agent.name,
		profile: profile(agent),
		writes: request.writes ?? null,
		toolAllowlist: tools,
		guardExtensionPath: guard,
		childRuntimePath: runtime,
		backingExtensionPaths: childTools.backingExtensionPaths,
		backingExtensionDigests: snapshotBackingExtensions(childTools.backingExtensionPaths),
		model: agent.model ?? null,
		thinking: null,
		systemPromptMode: identity ? "append" : null,
		identity,
		cwd: request.cwd ?? cwd,
		agentDir: path.dirname(agent.filePath),
		codingAgentDir: process.env.PI_CODING_AGENT_DIR?.trim() || null,
		autoExit: true,
	};
	return validateLoadout(value);
}
function modeOf(p: ParamsType): Details["mode"] {
	return p.chain?.length ? "chain" : p.tasks?.length ? "parallel" : "single";
}
type TaskRequest = NonNullable<ParamsType["tasks"]>[number];
function requireItem<T>(items: readonly T[], index: number, label: string): T {
	const item = items[index];
	if (item === undefined) throw new Error(`Missing ${label} at index ${index}`);
	return item;
}
function requests(p: ParamsType): TaskRequest[] {
	if (p.chain?.length) return [requireItem(p.chain, 0, "chain step")];
	if (p.tasks?.length) return p.tasks;
	return [
		{ agent: p.agent ?? "", task: p.task ?? "", cwd: p.cwd, writes: p.writes, sessionId: p.sessionId, label: p.label },
	];
}

type ChainDeliveryDecision = { notifyParent: boolean; failure?: string };
function sharedChainCompletion(
	file: string,
	child: ChildRecord,
	signal: TerminalSignal,
	ctx: ParentContext,
): ChainDeliveryDecision {
	if (child.mode !== "chain") return { notifyParent: true };
	const chain = loadRegistry(file).chain;
	if (!chain) return { notifyParent: true };
	// A synthesized chain failure is part of the durable delivery payload. On
	// retry after a parent steering failure, the chain is already failed, so
	// return the persisted derived message rather than the original child result.
	if (chain.failed) return { notifyParent: true, failure: child.deliveryResult };
	const finalStep = chain.steps.length - 1;
	if (chain.runningIndex === null && child.chainStep === finalStep && chain.progressed[finalStep])
		return { notifyParent: true };
	if (
		(chain.authorizedAgents && !chain.authorizedAgents.includes(chain.steps[child.chainStep ?? -1]?.agent)) ||
		child.chainStep !== chain.runningIndex ||
		chain.progressed[child.chainStep]
	)
		return { notifyParent: false };
	if (signal.status !== "completed") {
		const failure = `Chain failed at step ${(child.chainStep ?? 0) + 1}: ${(signal.failure ?? signal.result) || "child failed"}`;
		chain.failed = true;
		chain.runningIndex = null;
		updateChild(file, child.name, { result: failure, failure, deliveryResult: failure, deliveryFailure: failure });
		setChain(file, chain, ctx.sessionManager.getSessionId());
		return { notifyParent: true, failure };
	}
	chain.progressed[child.chainStep] = true;
	chain.previous = signal.result;
	if (chain.nextIndex >= chain.steps.length) {
		chain.runningIndex = null;
		updateChild(file, child.name, { deliveryResult: signal.result });
		setChain(file, chain, ctx.sessionManager.getSessionId());
		return { notifyParent: true };
	}
	const nextIndex = chain.nextIndex++;
	chain.runningIndex = nextIndex;
	setChain(file, chain, ctx.sessionManager.getSessionId());
	const step = chain.steps[nextIndex];
	const loadout = chain.authorizedLoadouts?.[nextIndex];
	if (loadout) {
		try {
			readApprovedChainLoadout(loadRegistry(file).runId, nextIndex, loadout);
		} catch (error) {
			const failure = `Chain failed at step ${nextIndex + 1}: protected loadout validation failed (${String(error)})`;
			chain.failed = true;
			chain.runningIndex = null;
			updateChild(file, child.name, { result: failure, failure, deliveryResult: failure, deliveryFailure: failure });
			setChain(file, chain, ctx.sessionManager.getSessionId());
			return { notifyParent: true, failure };
		}
	}
	if (!loadout) {
		const failure = `Chain failed at step ${nextIndex + 1}: no authorized loadout`;
		chain.failed = true;
		chain.runningIndex = null;
		updateChild(file, child.name, { result: failure, failure, deliveryResult: failure, deliveryFailure: failure });
		setChain(file, chain, ctx.sessionManager.getSessionId());
		return { notifyParent: true, failure };
	}
	try {
		const prior = step.sessionId
			? loadRegistry(file).children.find((entry) => entry.sessionId === step.sessionId)
			: undefined;
		if (step.sessionId && !prior) throw new Error(`saved child session ${step.sessionId} is unavailable`);
		const launchOptions = {
			parentCwd: ctx.cwd,
			runId: loadRegistry(file).runId,
			parentSession: ctx.sessionManager.getSessionId(),
			name: prior?.name ?? `${step.agent}-${nextIndex + 1}-${loadRegistry(file).runId.slice(0, 8)}`,
			task: step.task.replace(/\{previous\}/g, signal.result),
			agent: step.agent,
			cwd: loadout.cwd,
			mode: "chain",
			chainStep: nextIndex,
			registryFile: file,
			handoffDir: child.handoffDir,
			handoffName: `handoff-${nextIndex + 1}-${slugify(step.label ?? step.task)}`,
			loadout,
		} satisfies Parameters<typeof launchChild>[0];
		if (prior) {
			resumeChild({
				...launchOptions,
				sessionId: prior.sessionId,
				loadoutPath: prior.loadoutPath,
			});
		} else {
			launchChild(launchOptions);
		}
	} catch (error) {
		const failure = `Chain failed at step ${nextIndex + 1}: launch failed (${String(error)})`;
		chain.failed = true;
		chain.runningIndex = null;
		updateChild(file, child.name, { result: failure, failure, deliveryResult: failure, deliveryFailure: failure });
		setChain(file, chain, ctx.sessionManager.getSessionId());
		return { notifyParent: true, failure };
	}
	return { notifyParent: false };
}

export default function (pi: ExtensionAPI) {
	const watchers = new Set<{ stop(): void }>();
	function isMissingFile(error: unknown): boolean {
		return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
	}
	const notify = (ctx: ParentContext, child: ChildRecord, signal: TerminalSignal) => {
		// This is the required parent delivery. Let sendMessage throw so the
		// registry watcher can retain its claim and retry instead of silently
		// acknowledging a result that never reached the parent.
		pi.sendMessage(
			{
				customType: "subagent_result",
				content: `${child.name}: ${signal.status}\n${signal.result || signal.failure || "(no output)"}\nsession: ${child.sessionId}\nhandoff: ${child.handoffPath ?? "(pending)"}\nobserved paths: ${signal.observedPaths?.join(", ") || "none"}\npermission blocks: ${signal.permissionBlocks?.length ?? 0}`,
				display: true,
				details: {
					...signal,
					sessionId: child.sessionId,
					handoffPath: child.handoffPath,
					deliveryId: child.deliveryId,
				},
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		// UI notification is best effort and must not turn an accepted parent
		// message into a retry.
		if (ctx.hasUI) {
			try {
				ctx.ui.notify(
					`${child.name} ${signal.status}: ${signal.result || signal.failure || "(no output)"}`,
					signal.status === "completed" ? "info" : "error",
				);
			} catch {
				/* UI refresh is not part of delivery acknowledgement. */
			}
		}
	};
	const attach = (file: string, ctx: ParentContext) => {
		const registry = loadRegistry(file);
		if (registry.parentSession !== ctx.sessionManager.getSessionId()) return;
		if (ctx.hasUI && ctx.mode === "tui") {
			if (registry.children.some((child) => ["starting", "active", "waiting"].includes(child.state)))
				ctx.ui.setWidget("pi-guard-subagents", [formatStatus(registry.children)]);
			else ctx.ui.setWidget("pi-guard-subagents", []);
		}
		const watcher = watchRegistry(
			file,
			(child, signal) => {
				// Persist chain advancement before fallible notification/UI work.
				let decision: ChainDeliveryDecision;
				try {
					decision = sharedChainCompletion(file, child, signal, ctx);
				} catch (error) {
					decision = {
						notifyParent: true,
						failure: `Chain processing failed at step ${(child.chainStep ?? 0) + 1}: ${String(error)}`,
					};
				}
				if (decision.notifyParent) {
					const deliveredChild = decision.failure ? { ...child, result: decision.failure } : child;
					const deliveredSignal = decision.failure
						? ({
								...signal,
								status: "failed",
								result: decision.failure,
								failure: decision.failure,
							} satisfies TerminalSignal)
						: signal;
					notify(ctx, deliveredChild, deliveredSignal);
				}
				try {
					if (ctx.hasUI && ctx.mode === "tui") {
						const current = loadRegistry(file).children;
						ctx.ui.setWidget(
							"pi-guard-subagents",
							current.some((entry) => ["starting", "active", "waiting"].includes(entry.state))
								? [formatStatus(current)]
								: [],
						);
					}
				} catch {
					/* Status refresh is best effort. */
				}
			},
			(child, question) => {
				pi.sendMessage(
					{
						customType: "subagent_question",
						content: `${child.name} asks: ${question}`,
						display: true,
						details: { name: child.name, question },
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			},
		);
		const refresh = setInterval(() => {
			try {
				const current = loadRegistry(file).children;
				if (ctx.hasUI && ctx.mode === "tui")
					ctx.ui.setWidget(
						"pi-guard-subagents",
						current.some((entry) => ["starting", "active", "waiting"].includes(entry.state))
							? [formatStatus(current)]
							: [],
					);
			} catch {
				/* registry may be mid-atomic-write */
			}
		}, 1000);
		watchers.add({
			stop: () => {
				watcher.stop();
				clearInterval(refresh);
			},
		});
	};
	pi.on("session_shutdown", () => {
		for (const watcher of watchers) watcher.stop();
		watchers.clear();
	});

	pi.registerTool({
		name: "subagent_message",
		label: "Message subagent",
		description:
			"Message a running child or safely resume a completed child. After delivery, end the turn instead of sleeping or polling; child activity is delivered automatically.",
		parameters: Type.Object({ name: Type.String(), message: Type.String() }),
		async execute(_id, p, _signal, _update, ctx) {
			if (process.env.PI_SUBAGENT_DEPTH)
				return { content: [{ type: "text", text: "Nested delegation is disabled." }], details: {}, isError: true };
			const found = findChildRegistry(ctx.cwd, ctx.sessionManager.getSessionId(), p.name);
			if (!found)
				return {
					content: [{ type: "text", text: `Unknown or unavailable subagent: ${p.name}` }],
					details: {},
					isError: true,
				};
			const child = found.registry.children.find((c) => c.name === p.name);
			if (!child)
				return { content: [{ type: "text", text: `Subagent disappeared: ${p.name}` }], details: {}, isError: true };
			const questionFile = `${child.loadoutPath}.question.json`;
			let answered = false;
			try {
				const question = parseOrThrow(
					QuestionSchema,
					JSON.parse(fs.readFileSync(questionFile, "utf8")),
					"question sidecar",
				);
				if (question.attemptId === child.attemptId && !question.answered) {
					atomicJsonWrite(`${questionFile}.reply`, { attemptId: child.attemptId, answer: p.message });
					atomicJsonWrite(questionFile, { ...question, answered: true, answeredAt: new Date().toISOString() });
					updateChild(found.file, child.name, {
						questionAnswered: true,
						question: undefined,
						state: "active",
					});
					answered = true;
				}
			} catch (error) {
				if (!isMissingFile(error))
					return {
						content: [{ type: "text", text: `Invalid question sidecar for ${p.name}.` }],
						details: {},
						isError: true,
					};
			}
			if (!answered && child.paneId && paneExists(child.paneId)) {
				atomicJsonWrite(`${child.loadoutPath}.message-${crypto.randomUUID()}.json`, {
					version: 1,
					attemptId: child.attemptId,
					message: p.message,
				});
			} else if (!answered) {
				if (!["completed", "failed"].includes(child.state))
					return {
						content: [
							{ type: "text", text: `Subagent ${p.name} is no longer running; wait for its terminal outcome.` },
						],
						details: {},
						isError: true,
					};
				const loadout = validateResumeLoadout(child.loadoutPath);
				resumeChild({
					parentCwd: ctx.cwd,
					runId: found.registry.runId,
					parentSession: ctx.sessionManager.getSessionId(),
					name: child.name,
					task: p.message,
					agent: child.agent,
					cwd: loadout.cwd,
					loadout,
					loadoutPath: child.loadoutPath,
					sessionId: child.sessionId,
					mode: child.mode,
				});
			}
			return {
				content: [{ type: "text", text: `Message delivered to ${p.name}. ${ASYNC_WAIT_GUIDANCE}` }],
				details: {},
			};
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Launch guarded interactive subagents in tmux panes. No headless fallback. Launch is asynchronous: after calling this tool, end the turn instead of sleeping or polling; questions and terminal outcomes are delivered automatically.",
		parameters: Params,
		async execute(_id, p: ParamsType, _signal, _update, ctx) {
			const mode = modeOf(p);
			const req = requests(p);
			if (process.env.PI_SUBAGENT_DEPTH)
				return {
					content: [{ type: "text", text: "Nested delegation is disabled." }],
					details: { mode, children: [] },
					isError: true,
				};
			if ((p.chain?.length ? 1 : 0) + (p.tasks?.length ? 1 : 0) + (p.agent && p.task ? 1 : 0) !== 1)
				return {
					content: [{ type: "text", text: "Invalid parameters. Provide exactly one mode." }],
					details: { mode, children: [] },
				};
			if (!hasTmux() || !process.env.TMUX)
				return {
					content: [
						{
							type: "text",
							text: "Interactive subagents require tmux. Start Pi inside tmux, for example: tmux new -A -s pi 'pi'",
						},
					],
					details: { mode, children: [] },
					isError: true,
				};
			if (req.length > MAX_PARALLEL)
				return {
					content: [{ type: "text", text: `Too many parallel tasks (${req.length}). Max is ${MAX_PARALLEL}.` }],
					details: { mode, children: [] },
					isError: true,
				};
			const scope: AgentScope = p.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, scope);
			if ((scope === "project" || scope === "all") && (p.confirmProjectAgents ?? true)) {
				const project = (modeOf(p) === "chain" && p.chain ? p.chain : req)
					.map((r) => discovery.agents.find((a) => a.name === r.agent))
					.filter((a): a is AgentConfig => a?.source === "project");
				if (project.length && !ctx.hasUI)
					return {
						content: [
							{
								type: "text",
								text: "Project-local agents require interactive confirmation; non-UI callers must explicitly set confirmProjectAgents: false.",
							},
						],
						details: { mode, children: [] },
						isError: true,
					};
				if (
					project.length &&
					!(await ctx.ui.confirm("Run project-local agents?", `Agents: ${project.map((a) => a.name).join(", ")}`))
				)
					return {
						content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
						details: { mode, children: [] },
					};
			}
			// Resolve every requested session before selecting a run. Task and chain
			// entries may resume existing children too; choosing a fresh registry
			// first would make those resumes look absent and fail closed too late.
			const plannedRequests = mode === "chain" && p.chain ? p.chain : req;
			const parentSession = ctx.sessionManager.getSessionId();
			const sessionMatches = plannedRequests
				.filter((request) => request.sessionId)
				.map((request) => {
					const sessionId = request.sessionId;
					if (!sessionId) throw new Error("Session filtering invariant violated");
					return { sessionId, match: findChildBySessionRegistry(ctx.cwd, parentSession, sessionId) };
				});
			const matchedRuns = new Set(sessionMatches.flatMap((entry) => (entry.match ? [entry.match.file] : [])));
			if (matchedRuns.size > 1)
				throw new Error("Refusing resume: requested child sessions belong to incompatible orchestration runs");
			for (const entry of sessionMatches) {
				if (!entry.match)
					throw new Error(`Refusing resume: session ${entry.sessionId} has no saved loadout in this parent`);
				const saved = entry.match.registry.children.find((child) => child.sessionId === entry.sessionId);
				if (!saved || !["completed", "failed"].includes(saved.state) || (saved.paneId && paneExists(saved.paneId)))
					throw new Error(`Refusing resume: session ${entry.sessionId} is still active; use subagent_message`);
			}
			const existing = sessionMatches[0]?.match ?? null;
			const runId = existing?.registry.runId ?? crypto.randomUUID();
			const file = existing?.file ?? registryPath(ctx.cwd, runId);
			// Resolve every agent before creating any registry entry or pane.
			const resolvedAgents = plannedRequests.map((request) => {
				const agent = discovery.agents.find((candidate) => candidate.name === request.agent);
				if (!agent) throw new Error(`Unknown agent: "${request.agent}"`);
				return agent;
			});
			const preflightLoadouts = plannedRequests.map((request, i) => {
				if (request.sessionId) {
					const prior = fs.existsSync(file)
						? loadRegistry(file).children.find((entry) => entry.sessionId === request.sessionId)
						: undefined;
					if (!prior) throw new Error(`Refusing resume: session ${request.sessionId} has no saved loadout`);
					return validateResumeLoadout(prior.loadoutPath);
				}
				return childLoadout(requireItem(resolvedAgents, i, "resolved agent"), request, ctx.cwd, runId);
			});
			if (mode === "chain")
				preflightLoadouts.forEach((loadout, step) => persistApprovedChainLoadout(runId, step, loadout));
			ensureRegistry(file, ctx.sessionManager.getSessionId());
			const runDir = p.runDir
				? ensureRunDir(path.resolve(ctx.cwd, p.runDir))
				: path.join(ctx.cwd, ".pi", "orchestration", runId);
			if (mode === "chain")
				setChain(
					file,
					{
						steps: p.chain ?? [],
						nextIndex: 1,
						previous: "",
						progressed: (p.chain ?? []).map(() => false),
						runningIndex: 0,
						failed: false,
						authorizedAgents: resolvedAgents.map((agent) => agent.name),
						authorizedLoadouts: preflightLoadouts,
					},
					ctx.sessionManager.getSessionId(),
				);
			// Attach before launching so an earlier child remains monitored if a
			// later parallel pane fails to start.
			attach(file, ctx);
			const children: ChildRecord[] = [];
			for (const [i, request] of req.entries()) {
				const agent = requireItem(resolvedAgents, i, "resolved agent");
				const prior = request.sessionId
					? loadRegistry(file).children.find((c) => c.sessionId === request.sessionId)
					: undefined;
				if (request.sessionId && !prior)
					throw new Error(`Refusing resume: session ${request.sessionId} has no saved loadout`);
				const loadout = requireItem(preflightLoadouts, i, "preflight loadout");
				children.push(
					prior
						? resumeChild({
								parentCwd: ctx.cwd,
								runId,
								parentSession: ctx.sessionManager.getSessionId(),
								name: prior.name,
								task: request.task,
								agent: agent.name,
								cwd: loadout.cwd,
								loadout,
								loadoutPath: prior.loadoutPath,
								sessionId: prior.sessionId,
								mode,
								chainStep: mode === "chain" ? i : undefined,
							})
						: launchChild({
								parentCwd: ctx.cwd,
								runId,
								parentSession: ctx.sessionManager.getSessionId(),
								name: `${agent.name}-${i + 1}-${runId.slice(0, 8)}`,
								task: request.task,
								agent: agent.name,
								cwd: loadout.cwd,
								mode,
								chainStep: mode === "chain" ? i : undefined,
								registryFile: file,
								handoffDir: runDir,
								handoffName: `handoff-${i + 1}-${slugify(request.label ?? request.task)}`,
								loadout,
							}),
				);
			}
			return {
				content: [
					{
						type: "text",
						text: `Interactive subagents launched: ${children.map((c) => `${c.name} (${c.paneId})`).join(", ")}\nregistry: ${file}\n\n${ASYNC_WAIT_GUIDANCE}`,
					},
				],
				details: { mode, registry: file, children },
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", args.agent ?? (args.chain ? "chain" : "parallel")),
				0,
				0,
			);
		},
		renderResult(result) {
			return new Text(result.content[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
		},
	});
}
