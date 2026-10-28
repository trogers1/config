import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  collapseSystemMessages,
  getCurrentSystemPrompt,
  getCurrentTools,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type ToolResultMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createOutput, type Output } from "./stream.ts";
import { createRendezvous, MCP_NAME, sdkToolName } from "./mcp.ts";
import { buildSdkOptions } from "./sdk-options.ts";
import { nativeSystemPrompt, PROMPT_MODE } from "./prompt.ts";
import { hasApprovedComponents } from "./components.ts";
import {
  effectiveSdkEnvironment,
  verifyCliAuthRoute,
  verifySdkAccountRoute,
} from "./auth-route.ts";
import { CLAUDE_EXECUTABLE_ENV, createClaudeExecutableResolver } from "./cli.ts";
import {
  currentUser,
  deliveryResults,
  DeliverySchema,
  effectiveHistory,
  fingerprint,
  historyIdentity,
  HistorySchema,
  PayloadSchema,
  prepareHistory,
  userContent,
  type WireState,
} from "./transcript.ts";
import { parseJson, parseOrThrow } from "./validation.ts";
import { reconstructSession, type ConversationMessage } from "./reconstruction/index.ts";
import type { RecoveryDiagnostic } from "./reconstruction/schema.ts";
import { CLAUDE_BRIDGE_PROVIDER } from "../../pi-guard-subagents/extensions/interactive/provider-extensions.ts";

export type SessionBinding = {
  cwd: string;
  trusted: boolean;
  warn: ({ message }: { message: string }) => void;
};
type Checkpoint = {
  sdkId: string;
  responseModel: string;
  authoritative: string;
  identity: string;
  wire: string;
  systemPrompt: string;
};
type Generation = {
  output: Output | undefined;
  sdk: Query | undefined;
  baseline: Message[];
  wire: ConversationMessage[];
  sourceSystem: string;
  systemPrompt: string;
  identity: string;
  parked: boolean;
  awaitingDispatch: boolean;
  closed: boolean;
  error: Error | undefined;
  detach: () => void;
  close: (options?: { interrupt?: boolean }) => Promise<void>;
  rendezvous: ReturnType<typeof createRendezvous>;
  request: SimpleStreamOptions;
  startupTimer: ReturnType<typeof setTimeout> | undefined;
  correctionTimer: ReturnType<typeof setTimeout> | undefined;
  dispatchComplete: () => void;
};

/** All state belongs to this extension instance. Live queries, a current wire
 * prefix and one verified native checkpoint are bounded by the owning session. */
export function createSessionProvider({
  bindings,
  summarySessions,
  sourceModels,
}: {
  bindings: Map<string, SessionBinding>;
  summarySessions: WeakMap<AbortSignal, string>;
  sourceModels: ReadonlyMap<string, Model<"anthropic-messages">>;
}) {
  const generations = new Map<string, Generation>();
  const checkpoints = new Map<string, Checkpoint>();
  const wires = new Map<string, WireState>();
  const preparing = new Set<string>();
  const executables = createClaudeExecutableResolver();

  async function close({ id }: { id: string }) {
    const generation = generations.get(id);
    if (!generation) return;
    generations.delete(id);
    await generation.close();
  }
  async function forget({ id }: { id: string }) {
    checkpoints.delete(id);
    wires.delete(id);
    preparing.delete(id);
    await close({ id });
  }
  function rememberWire({ key, generation }: { key: string; generation: Generation }) {
    wires.set(key, {
      source: structuredClone(generation.baseline.filter((message) => message.role !== "system")),
      wire: structuredClone(generation.wire),
      sourceSystem: generation.sourceSystem,
      systemPrompt: generation.systemPrompt,
    });
  }

  function stream({
    model,
    context,
    options = {},
  }: {
    model: Model<string>;
    context: TranscriptContext;
    options?: SimpleStreamOptions;
  }) {
    const tools = options.toolChoice === "none" ? [] : getCurrentTools(context.messages);
    const output = createOutput({ model, tools });
    const id = (options.signal && summarySessions.get(options.signal)) ?? options.sessionId;
    const binding = id ? bindings.get(id) : undefined;
    const summary = !!(options.signal && summarySessions.has(options.signal));
    const key = summary ? `${id}:summary` : id;
    const sourceSystem = getCurrentSystemPrompt(context.messages);
    const source = collapseSystemMessages(context).messages.filter(
      (message) => message.role !== "system",
    );
    let owned: Generation | undefined;
    let reserved = false;

    async function run() {
      if (!binding?.trusted || !key)
        throw new Error(
          "pi-claude: Claude delegation requires actual Pi project trust and a bound session",
        );
      if (options.signal?.aborted)
        throw new Error("pi-claude: request aborted before Claude startup");
      if (preparing.has(key))
        throw new Error("pi-claude: concurrent request while Claude request setup is pending");
      preparing.add(key);
      reserved = true;
      const sourceModel = sourceModels.get(model.id);
      if (!sourceModel)
        throw new Error(`pi-claude: no reviewed catalog capabilities for ${model.id}`);
      if (options.env && Object.hasOwn(options.env, CLAUDE_EXECUTABLE_ENV))
        throw new Error(
          `pi-claude: ${CLAUDE_EXECUTABLE_ENV} may only be set in Pi's user-owned process environment, not request/project configuration`,
        );
      const claudeConfigDir = resolve(
        binding.cwd,
        process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), ".claude"),
      );
      const env = effectiveSdkEnvironment({
        ambient: process.env,
        request: options.env,
        claudeConfigDir,
        maxTokens: options.maxTokens,
      });
      const executable = await executables.resolve({ cwd: binding.cwd, warn: binding.warn });
      if (options.signal?.aborted)
        throw new Error("pi-claude: request aborted during Claude executable preflight");
      const identity = fingerprint({
        value: {
          cwd: binding.cwd,
          model,
          promptMode: PROMPT_MODE,
          system: sourceSystem,
          tools,
          executable,
          reasoning: options.reasoning,
          thinkingBudgets: options.thinkingBudgets,
          maxTokens: options.maxTokens,
          env,
        },
      });
      let existing = generations.get(key);
      if (existing?.error) {
        const error = existing.error;
        await close({ id: key });
        existing = undefined;
        if (source.at(-1)?.role !== "user") throw error;
      }
      if (existing && !existing.parked)
        throw new Error("pi-claude: concurrent request for an active Claude session");
      const state = wires.get(key);
      const defaultSystem =
        state?.sourceSystem === sourceSystem ? state.systemPrompt : sourceSystem;
      let history: ConversationMessage[];
      let content: Static<typeof PayloadSchema>["content"];
      let systemPrompt: string;
      let wire: ConversationMessage[];
      const last = source.at(-1);

      const extension = existing ? context.messages.slice(existing.baseline.length) : [];
      const results = extension.filter(
        (message): message is ToolResultMessage => message.role === "toolResult",
      );
      const parkedPrefixMatches =
        existing &&
        existing.identity === identity &&
        historyIdentity({ messages: context.messages.slice(0, existing.baseline.length) }) ===
          historyIdentity({ messages: existing.baseline }) &&
        results.length === extension.length;
      if (existing && parkedPrefixMatches) {
        owned = existing;
        existing.parked = false; // reserve before awaiting an inspection hook
        const prepared = prepareHistory({ templates: [...existing.wire, ...results] });
        const prefixLength = prepared.messages.length - results.length;
        const priorHistory = prepared.messages.slice(0, prefixLength);
        reportRecovery({ binding, diagnostics: prepared.diagnostics });
        const envelope = parseOrThrow({
          schema: DeliverySchema,
          source: "Pi tool-result delivery",
          value: {
            kind: "tool-results",
            systemPrompt: defaultSystem,
            history: structuredClone(priorHistory),
            results: results.map((result) => ({
              toolCallId: result.toolCallId,
              toolName: result.toolName,
              isError: result.isError,
              content: structuredClone(result.content),
            })),
          },
        });
        const replacement = await options.onPayload?.(envelope, model);
        const payload = parseJson({
          text: JSON.stringify(replacement ?? envelope),
          schema: DeliverySchema,
          source: "complete tool-delivery payload",
        });
        const delivered = deliveryResults({ templates: results, results: payload.results });
        const complete = parseOrThrow({
          schema: HistorySchema,
          value: [...payload.history, ...delivered],
          source: "complete Pi tool delivery",
        });
        const { outbound, aligned } = prepared.apply({ history: complete });
        const transformed = outbound.slice(0, prefixLength);
        history = outbound;
        wire = aligned;
        systemPrompt = payload.systemPrompt;
        content = [
          {
            type: "text",
            text: "Continue after the completed Pi tool results in the restored conversation.",
          },
        ];
        // Rewriting already-sent history requires a reset, not pretending that
        // replacing only the new MCP results changes the SDK's earlier context.
        if (
          !existing.closed &&
          systemPrompt === existing.systemPrompt &&
          historyIdentity({ messages: transformed }) === historyIdentity({ messages: priorHistory })
        ) {
          existing.output = output;
          existing.request = options;
          existing.baseline = [...context.messages];
          existing.wire = wire;
          existing.awaitingDispatch = true;
          existing.detach();
          existing.detach = attachAbort({ key, generation: existing, signal: options.signal });
          rememberWire({ key, generation: existing });
          existing.rendezvous.deliver({ results: delivered });
          return;
        }
        await close({ id: key });
      } else {
        // Reserve initial/rebuild setup as well: two overlapping requests must
        // not both inspect a stale checkpoint and start competing SDK queries.
        if (existing) {
          owned = existing;
          existing.parked = false;
        }
        const effective = effectiveHistory({ source, state });
        const templates = last?.role === "user" ? effective.slice(0, -1) : effective;
        const effectiveCurrent = effective.at(-1);
        const prepared = prepareHistory({ templates });
        reportRecovery({ binding, diagnostics: prepared.diagnostics });
        const current =
          effectiveCurrent?.role === "user"
            ? userContent({ message: effectiveCurrent })
            : "Continue after the completed Pi tool results in the restored conversation.";
        const envelope = parseOrThrow({
          schema: PayloadSchema,
          source: "complete Pi request",
          value: {
            systemPrompt: defaultSystem,
            history: structuredClone(prepared.messages),
            content: typeof current === "string" ? [{ type: "text", text: current }] : current,
          },
        });
        const replacement = await options.onPayload?.(envelope, model);
        const payload = parseJson({
          text: JSON.stringify(replacement ?? envelope),
          schema: PayloadSchema,
          source: "complete request payload",
        });
        const { outbound, aligned } = prepared.apply({ history: payload.history });
        history = outbound;
        content = payload.content;
        systemPrompt = payload.systemPrompt;
        wire =
          last?.role === "user" ? [...aligned, currentUser({ source: last, content })] : aligned;
        if (existing) await close({ id: key });
      }
      if (options.signal?.aborted)
        throw new Error("pi-claude: request cancelled before Claude startup");
      const checkpoint = summary ? undefined : checkpoints.get(key);
      const authoritativePrefix = last?.role === "user" ? context.messages.slice(0, -1) : undefined;
      const reusable =
        checkpoint &&
        authoritativePrefix &&
        checkpoint.identity === identity &&
        checkpoint.systemPrompt === systemPrompt &&
        checkpoint.authoritative === historyIdentity({ messages: authoritativePrefix }) &&
        checkpoint.wire === historyIdentity({ messages: history });
      checkpoints.delete(key); // a new/uncertain query must not leave a reusable old checkpoint
      const actualModel = reusable
        ? checkpoint.responseModel
        : [...history]
            .reverse()
            .find(
              (message): message is Extract<ConversationMessage, { role: "assistant" }> =>
                message.role === "assistant" &&
                message.provider === CLAUDE_BRIDGE_PROVIDER &&
                message.model === model.id &&
                !!message.responseModel,
            )?.responseModel;
      const sdkModel = actualModel ?? (history.length ? sourceModel.id : model.id);
      const sdkSourceModel = sourceModels.get(sdkModel);
      if (!sdkSourceModel)
        throw new Error(
          `pi-claude: no reviewed catalog capabilities for resolved native model ${sdkModel}`,
        );
      const controller = new AbortController();
      let releaseInput: (() => void) | undefined;
      const inputClosed = new Promise<void>((resolve) => {
        releaseInput = resolve;
      });
      const inputReady = Promise.withResolvers<void>();
      const rendezvous = createRendezvous({
        tools,
        fail: ({ error }) => failGeneration({ key, generation, error }),
        onComplete: () => generation.dispatchComplete(),
      });
      const generation: Generation = {
        output,
        sdk: undefined,
        baseline: [...context.messages],
        wire,
        sourceSystem,
        systemPrompt,
        identity,
        parked: false,
        awaitingDispatch: false,
        closed: false,
        error: undefined,
        detach: () => {},
        request: options,
        startupTimer: undefined,
        correctionTimer: undefined,
        dispatchComplete: () => {},
        rendezvous,
        async close({ interrupt = true } = {}) {
          if (generation.closed) return;
          generation.closed = true;
          generation.detach();
          clearTimeout(generation.startupTimer);
          clearTimeout(generation.correctionTimer);
          releaseInput?.();
          inputReady.resolve(); // unblock the iterable, but closed queries never yield
          controller.abort();
          await rendezvous.close();
          const sdk = generation.sdk;
          if (sdk) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              if (interrupt)
                await Promise.race([
                  sdk.interrupt(),
                  new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, 500);
                  }),
                ]);
            } finally {
              clearTimeout(timer);
              sdk.close();
            }
          }
        },
      };
      owned = generation;
      generations.set(key, generation);
      generation.detach = attachAbort({ key, generation, signal: options.signal });
      rememberWire({ key, generation });
      await verifyCliAuthRoute({
        executable: executable.path,
        cwd: binding.cwd,
        env,
        signal: controller.signal,
      });
      if (generation.closed)
        throw new Error("pi-claude: request cancelled during Claude auth-status preflight");
      const historicalNames = new Set(
        history.flatMap((message) =>
          message.role === "assistant"
            ? message.content.flatMap((block) => (block.type === "toolCall" ? [block.name] : []))
            : [],
        ),
      );
      const toolNameMap = new Map(
        [...historicalNames].map((name) => [name, sdkToolName({ name })]),
      );
      const reconstructed =
        !reusable && history.length
          ? await reconstructSession({
              messages: history,
              cwd: binding.cwd,
              model: sdkModel,
              claudeConfigDir,
              toolNameMap,
            })
          : undefined;
      if (generation.closed)
        throw new Error("pi-claude: request cancelled during history reconstruction");
      async function* input() {
        await inputReady.promise;
        if (generation.closed) return;
        yield {
          type: "user",
          message: { role: "user", content },
          parent_tool_use_id: null,
          client_composed: true,
        } satisfies SDKUserMessage;
        await inputClosed;
      }
      const sdkOptions = buildSdkOptions({
        cwd: binding.cwd,
        claudeExecutablePath: executable.path,
        env,
        model,
        sourceModel: sdkSourceModel,
        sdkModel,
        systemPrompt: await nativeSystemPrompt({
          messages: context.messages,
          sourceSystem,
          systemPrompt,
          tools,
        }),
        tools,
        rendezvous,
        controller,
        request: options,
        resume: reusable ? checkpoint.sdkId : reconstructed?.filePath,
        forkSession: !!reconstructed,
      });
      generation.sdk = query({ prompt: input(), options: sdkOptions });
      if (generation.closed) {
        generation.sdk.close();
        throw new Error("pi-claude: request cancelled during Claude query startup");
      }
      generation.startupTimer = setTimeout(
        () =>
          failGeneration({
            key,
            generation,
            error: new Error("pi-claude: timed out waiting for Claude SDK initialization"),
          }),
        15_000,
      );
      let account: Awaited<ReturnType<Query["accountInfo"]>>;
      try {
        account = await Promise.race([
          generation.sdk.accountInfo(),
          inputClosed.then(() => {
            throw new Error("Claude initialization closed");
          }),
        ]);
      } catch {
        throw new Error("pi-claude: Claude SDK account initialization failed or was cancelled");
      }
      verifySdkAccountRoute({ account });
      if (generation.closed)
        throw new Error("pi-claude: request cancelled before Claude auth-route validation");
      inputReady.resolve();
      void consume({
        key,
        generation,
        model,
        cwd: binding.cwd,
        forkSourceId: reconstructed?.sessionId,
        resumeId: reusable ? checkpoint.sdkId : undefined,
        summary,
      }).catch((error: unknown) => {
        failGeneration({
          key,
          generation,
          error: error instanceof Error ? error : new Error("pi-claude: SDK consumer failed"),
        });
      });
    }

    async function consume({
      key,
      generation,
      model,
      cwd,
      forkSourceId,
      resumeId,
      summary,
    }: {
      key: string;
      generation: Generation;
      model: Model<string>;
      cwd: string;
      forkSourceId?: string;
      resumeId?: string;
      summary: boolean;
    }) {
      const sdk = generation.sdk;
      if (!sdk) throw new Error("pi-claude: SDK query was not initialized");
      let initialized = false;
      const rejected = new Map<string, string>();
      let rejectionCount = 0;
      let needsCorrection = false;
      let guardedWork = false;
      function correctionDeadline() {
        if (generation.closed || guardedWork || (!needsCorrection && !rejected.size)) {
          clearTimeout(generation.correctionTimer);
          generation.correctionTimer = undefined;
        } else if (!generation.correctionTimer) {
          generation.correctionTimer = setTimeout(
            () =>
              failGeneration({
                key,
                generation,
                error: new Error(
                  "pi-claude: timed out waiting for Claude tool-name correction or rejection evidence",
                ),
              }),
            10_000,
          );
        }
      }
      generation.dispatchComplete = () => {
        guardedWork = false;
        correctionDeadline();
      };
      let sdkId: string | undefined;
      let responseModel: string | undefined;
      for await (const event of sdk) {
        if (generation.closed) return;
        await generation.request.onProviderStreamEvent?.(event, model);
        if (event.type === "system" && event.subtype === "init") {
          if (
            initialized ||
            event.apiKeySource !== "none" ||
            event.cwd !== cwd ||
            !event.session_id ||
            event.session_id === forkSourceId ||
            (resumeId && event.session_id !== resumeId)
          )
            throw new Error(
              "pi-claude: invalid SDK session initialization, resume or fork identity",
            );
          const expected = tools.map((tool) => sdkToolName({ name: tool.name })).sort();
          if (
            fingerprint({ value: [...event.tools].sort() }) !== fingerprint({ value: expected }) ||
            event.mcp_servers.some(
              (server) =>
                server.name !== MCP_NAME ||
                server.status !== "connected" ||
                server.source !== "sdk",
            ) ||
            event.mcp_servers.length !== 1 ||
            event.permissionMode !== "default" ||
            !hasApprovedComponents({ value: event })
          )
            throw new Error(
              "pi-claude: SDK advertised an unexpected native tool, plugin, skill or MCP surface",
            );
          clearTimeout(generation.startupTimer);
          initialized = true;
          sdkId = event.session_id;
          responseModel = event.model;
          continue;
        }
        if (event.type === "auth_status") {
          if (event.error) throw new Error("pi-claude: Claude authentication failed");
          continue;
        }
        if (event.type === "result" && event.subtype !== "success")
          throw sdkFailure({ message: event.errors.join("; "), kind: event.subtype });
        if (!initialized)
          throw new Error("pi-claude: SDK emitted content before session initialization");
        if ("session_id" in event && event.session_id !== sdkId)
          throw new Error("pi-claude: SDK changed session identity");
        if ("parent_tool_use_id" in event && event.parent_tool_use_id !== null)
          throw new Error("pi-claude: native Claude subagent events are not permitted");
        if (event.type === "stream_event") {
          const active = generation.output;
          if (!active)
            throw new Error("pi-claude: SDK continued before Pi supplied its guarded tool results");
          if (event.event.type === "message_start") {
            if (rejected.size)
              throw new Error("pi-claude: Claude continued without rejecting unadvertised tools");
            if (generation.awaitingDispatch) {
              generation.rendezvous.assertComplete();
              generation.awaitingDispatch = false;
            }
            generation.rendezvous.beginAssistantMessage();
          }
          active.event({ event: event.event });
          if (active.message.responseModel) responseModel = active.message.responseModel;
          if (event.event.type === "message_stop") {
            for (const [id, name] of active.rejected) {
              rejected.set(id, name);
              needsCorrection = true;
              if (++rejectionCount > 8)
                throw new Error("pi-claude: too many unadvertised tool attempts");
            }
            correctionDeadline();
            active.rejected.clear();
          }
          if (active.stopped && active.reason === "toolUse" && active.batch().length) {
            const batch = active.batch();
            // A mixed response may await legitimate Pi execution or user approval;
            // never apply the CLI-correction deadline to guarded tool work.
            guardedWork = true;
            needsCorrection = false;
            correctionDeadline();
            generation.rendezvous.expect({ batch });
            if (generation.closed) return;
            active.message.stopReason = "toolUse";
            const completed = structuredClone(active.message);
            generation.baseline = [...generation.baseline, completed];
            generation.wire = [...generation.wire, completed];
            rememberWire({ key, generation });
            generation.parked = true;
            generation.output = undefined;
            active.finish({ reason: "toolUse" });
          }
        } else if (event.type === "user") {
          if (Array.isArray(event.message.content)) {
            for (const block of event.message.content) {
              if (block.type !== "tool_result" || !rejected.has(block.tool_use_id)) continue;
              if (block.is_error !== true)
                throw new Error("pi-claude: unadvertised tool was not rejected by Claude CLI");
              rejected.delete(block.tool_use_id);
              correctionDeadline();
            }
          }
        } else if (event.type === "assistant") {
          if (event.error) {
            const detail = event.message.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("\n");
            throw sdkFailure({ message: detail, kind: event.error });
          }
        } else if (event.type === "result") {
          if (event.is_error)
            throw new Error(`pi-claude: Claude returned an error: ${event.result}`);
          generation.rendezvous.assertComplete();
          if (rejected.size || needsCorrection)
            throw new Error(
              "pi-claude: unadvertised tool attempts ended without a corrected Pi call",
            );
          const active = generation.output;
          if (!active || generation.parked || !sdkId || !responseModel)
            throw new Error(
              "pi-claude: SDK completed with unresolved Pi tools or missing session metadata",
            );
          active.message.stopReason = active.reason;
          const completed = structuredClone(active.message);
          generation.baseline = [...generation.baseline, completed];
          generation.wire = [...generation.wire, completed];
          await generation.close({ interrupt: false });
          rememberWire({ key, generation });
          // Native rejection exchanges are intentionally not executable Pi history.
          // Rebuild from normalized guarded history instead of resuming a divergent prefix.
          if (!summary && !rejectionCount)
            checkpoints.set(key, {
              sdkId,
              responseModel,
              authoritative: historyIdentity({ messages: generation.baseline }),
              identity: generation.identity,
              wire: historyIdentity({
                messages: prepareHistory({ templates: generation.wire }).messages,
              }),
              systemPrompt: generation.systemPrompt,
            });
          generations.delete(key);
          active.finish({ reason: active.reason });
          return;
        } else if (event.type === "tool_progress") {
          if (event.task_id || event.subagent_type || event.subagent_retry)
            throw new Error("pi-claude: native task/subagent tool progress is not permitted");
          generation.rendezvous.assertProgress({
            id: event.tool_use_id,
            name: event.tool_name,
          });
        } else handleNotification({ event });
      }
      if (!generation.closed)
        throw new Error("pi-claude: SDK stream ended without a terminal result");
    }

    void run()
      .catch(async (error: unknown) => {
        const failure = error instanceof Error ? error : new Error("pi-claude: request failed");
        output.fail({ error: failure, aborted: !!options.signal?.aborted });
        if (key && owned && generations.get(key) === owned) {
          checkpoints.delete(key);
          try {
            await close({ id: key });
          } catch (cleanupError) {
            output.fail({ error: cleanupError instanceof Error ? cleanupError : failure });
          }
        }
      })
      .finally(() => {
        if (reserved && key) preparing.delete(key);
      });
    return output.stream;
  }

  function attachAbort({
    key,
    generation,
    signal,
  }: {
    key: string;
    generation: Generation;
    signal?: AbortSignal;
  }) {
    const abort = () =>
      failGeneration({
        key,
        generation,
        error: new Error("pi-claude: request aborted"),
        aborted: true,
      });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    return () => signal?.removeEventListener("abort", abort);
  }
  function failGeneration({
    key,
    generation,
    error,
    aborted = false,
  }: {
    key: string;
    generation: Generation;
    error: Error;
    aborted?: boolean;
  }) {
    checkpoints.delete(key);
    generation.error = error;
    generation.output?.fail({ error, aborted });
    void generation.close().catch(() => {
      generation.error = new Error(`${error.message}; Claude SDK cleanup also failed`);
    });
  }
  return { stream, close, forget };
}

function reportRecovery({
  binding,
  diagnostics,
}: {
  binding: SessionBinding;
  diagnostics: RecoveryDiagnostic[];
}) {
  for (const diagnostic of diagnostics) {
    binding.warn({
      message: `pi-claude: recovery ${diagnostic.action} at history index ${diagnostic.messageIndex} (${diagnostic.stopReason}); excluded unresolved tools: ${diagnostic.excludedUnresolvedToolCalls}; retained tool results: ${diagnostic.retainedToolResults}`,
    });
  }
}

function sdkFailure({ message, kind }: { message: string; kind: string }) {
  const overflow = /^(?:Error: )?(?:prompt is too long|context_length_exceeded)(?:\b|:)/i.test(
    message,
  );
  return new Error(
    `pi-claude: ${overflow ? "context_length_exceeded" : `Claude ${kind}`}${message ? `: ${message}` : ""}`,
  );
}
function handleNotification({ event }: { event: SDKMessage }) {
  if (event.type === "user") return;
  if (event.type === "rate_limit_event") {
    if (event.rate_limit_info.status === "rejected")
      throw new Error("pi-claude: Claude quota exceeded");
    return;
  }
  // Progress estimates are not assistant content or authoritative billed usage.
  if (
    event.type === "system" &&
    (event.subtype === "status" ||
      event.subtype === "api_retry" ||
      event.subtype === "thinking_tokens")
  )
    return;
  throw new Error(
    `pi-claude: unsupported SDK event ${event.type}${"subtype" in event ? `/${event.subtype}` : ""}`,
  );
}
