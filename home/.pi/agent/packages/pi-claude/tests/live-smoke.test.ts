import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createTestSession, lastAssistant } from "./fixtures/session.ts";
import { failureCategory, failureHints } from "./fixtures/provider-diagnostics.ts";
import { MCP_NAME, sdkToolName } from "../extensions/mcp.ts";
import { PayloadSchema } from "../extensions/transcript.ts";
import { parseOrThrow } from "../extensions/validation.ts";
import {
  PROTECTED_ARGS,
  PROTECTED_CONTENT,
  READ_DEFINITION,
  WRITE_ARGS,
  WRITE_DEFINITION,
} from "./contract.ts";

const InitSurfaceSchema = Type.Object({
  type: Type.Literal("system"),
  subtype: Type.Literal("init"),
  tools: Type.Array(Type.String()),
  cwd: Type.Optional(Type.String()),
  apiKeySource: Type.Optional(Type.String()),
  permissionMode: Type.Optional(Type.String()),
  mcp_servers: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        status: Type.String(),
        source: Type.Optional(Type.String()),
      }),
    ),
  ),
  skills: Type.Optional(Type.Array(Type.String())),
  plugins: Type.Optional(Type.Array(Type.Object({ name: Type.String(), path: Type.String() }))),
});
const ApiErrorMetadataSchema = Type.Object({
  type: Type.Literal("assistant"),
  is_api_error_message: Type.Optional(Type.Boolean()),
  api_error_status: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
  api_error_code: Type.Optional(Type.String()),
  api_error_origin: Type.Optional(Type.String()),
  request_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
const EventTagSchema = Type.Object({
  type: Type.String({ pattern: "^[a-z_]{1,64}$" }),
  subtype: Type.Optional(Type.String({ pattern: "^[a-z_]{1,64}$" })),
});

// Explicitly opt in to TWO real prompts. Never enabled by the normal test command.
// The parent/operator owns authorization and Claude authentication. No fake SDK
// module is loaded here; the provider, SDK subprocess and guard are all real.
const baseline = process.env.PI_CLAUDE_LIVE_BASELINE === "1";
if (baseline && process.env.PI_CLAUDE_LIVE_SMOKE === "1")
  throw new Error("Select only one live acceptance or no-tool baseline mode");

test.skipIf(process.env.PI_CLAUDE_LIVE_SMOKE !== "1" && !baseline)(
  baseline
    ? "live: one no-tool diagnostic (NOT acceptance)"
    : "live: one permitted write and one attempted guard-denied read",
  async () => {
    const run = await createTestSession({ live: true });
    const original = run.session.agent.streamFunction;
    let requests = 0;
    const surfaces: {
      expectedToolCount: number;
      unexpectedToolCount: number;
      hasEndConversation: boolean;
      cwdMatches: boolean;
      apiKeySource: "absent" | "none" | "other";
      defaultPermissions: boolean;
      connectedOwnedMcpServers: number;
      missingMcpSources: number;
      skillsCount: number | null;
      pluginsCount: number | null;
    }[] = [];
    const eventTags: string[] = [];
    let systemShape: { length: number; wellFormed: boolean; nulCount: number } | undefined;
    const apiErrors: {
      apiError: boolean;
      status: number | null;
      codePresent: boolean;
      firstPartyOrigin: boolean;
      requestIdPresent: boolean;
    }[] = [];
    const expectedTools = (baseline ? [] : [WRITE_DEFINITION, READ_DEFINITION]).map((tool) =>
      sdkToolName({ name: tool.name }),
    );
    // This is the public agent transport boundary, not a replacement provider:
    // apply a small output cap and abort before a runaway tool loop can start.
    run.session.agent.streamFunction = (model, context, options) => {
      requests++;
      const controller = new AbortController();
      if (requests > 3) controller.abort();
      return original(model, context, {
        ...options,
        maxTokens: 256,
        ...(baseline
          ? {
              toolChoice: "none",
              onPayload: async (payload: unknown) => {
                const parsed = parseOrThrow({
                  schema: PayloadSchema,
                  value: payload,
                  source: "no-tool diagnostic payload",
                });
                systemShape = {
                  length: parsed.systemPrompt.length,
                  wellFormed: parsed.systemPrompt.isWellFormed(),
                  nulCount: parsed.systemPrompt.split(String.fromCharCode(0)).length - 1,
                };
                return parsed;
              },
            }
          : {}),
        onProviderStreamEvent: async (event, responseModel) => {
          await options?.onProviderStreamEvent?.(event, responseModel);
          if (Value.Check(ApiErrorMetadataSchema, event) && apiErrors.length < 3) {
            apiErrors.push({
              apiError: event.is_api_error_message === true,
              status: event.api_error_status ?? null,
              codePresent: event.api_error_code !== undefined,
              firstPartyOrigin: event.api_error_origin === "first_party",
              requestIdPresent: typeof event.request_id === "string",
            });
          }
          if (Value.Check(EventTagSchema, event) && eventTags.length < 40) {
            eventTags.push(`${event.type}${event.subtype ? `/${event.subtype}` : ""}`);
          }
          if (Value.Check(InitSurfaceSchema, event)) {
            const init = event satisfies Pick<SDKSystemMessage, "type" | "subtype" | "tools">;
            surfaces.push({
              expectedToolCount: init.tools.filter((name) => expectedTools.includes(name)).length,
              unexpectedToolCount: init.tools.filter((name) => !expectedTools.includes(name))
                .length,
              hasEndConversation: init.tools.includes("EndConversation"),
              cwdMatches: init.cwd === realpathSync(run.cwd),
              apiKeySource:
                init.apiKeySource === undefined
                  ? "absent"
                  : init.apiKeySource === "none"
                    ? "none"
                    : "other",
              defaultPermissions: init.permissionMode === "default",
              connectedOwnedMcpServers:
                init.mcp_servers?.filter(
                  (server) =>
                    server.name === MCP_NAME &&
                    server.status === "connected" &&
                    server.source === "sdk",
                ).length ?? 0,
              missingMcpSources:
                init.mcp_servers?.filter((server) => server.source === undefined).length ?? 0,
              skillsCount: init.skills?.length ?? null,
              pluginsCount: init.plugins?.length ?? null,
            });
          }
        },
        ...(requests > 3 ? { signal: controller.signal } : {}),
      });
    };
    const timer = setTimeout(() => {
      void run.session.abort();
    }, 60_000);
    try {
      // Choose by catalog cost, preferring the runtime's Haiku alias on a tie.
      // A published concrete ID need not be available to the installed runtime;
      // this is explicit alias selection, never a more expensive family fallback.
      const haiku = (await run.modelRuntime.getAvailable(run.session.model?.provider))
        .filter((model) => /haiku/i.test(model.id))
        .toSorted(
          (a, b) =>
            a.cost.input + a.cost.output - b.cost.input - b.cost.output ||
            Number(b.id === "haiku") - Number(a.id === "haiku"),
        )[0];
      if (!haiku) throw new Error("No eligible Haiku model available; live smoke not attempted");
      await run.session.setModel(haiku);
      if (baseline) {
        await run.session.prompt("Reply with OK only. Do not use tools.");
        const assistant = lastAssistant(run);
        console.log(
          JSON.stringify({
            stage: "no-tool-full-system-baseline",
            systemShape,
            apiErrors,
            model: run.session.model?.id,
            stopReason: assistant.stopReason,
            failureCategory: failureCategory({ message: assistant.errorMessage }),
            failureHints: failureHints({ message: assistant.errorMessage }),
            requests,
            eventTags,
            surfaces,
          }),
        );
        expect(assistant.stopReason).toBe("stop");
        expect(requests).toBe(1);
        expect(run.session.messages.some((message) => message.role === "toolResult")).toBe(false);
        return;
      }
      await run.session.prompt(
        `Use the ${WRITE_DEFINITION.name} tool exactly once with these arguments: ${JSON.stringify(WRITE_ARGS)}. Then reply briefly. Do not use any other tool.`,
      );
      const written = run.session.messages.filter(
        (message) => message.role === "toolResult" && message.toolName === WRITE_DEFINITION.name,
      );
      // Capability/count metadata only: never print raw SDK diagnostics,
      // account details, prompts or returned file contents on failure.
      console.log(
        JSON.stringify({
          stage: "permitted-write",
          model: run.session.model?.id,
          failureHints: failureHints({ message: lastAssistant(run).errorMessage }),
          stopReason: lastAssistant(run).stopReason,
          observedWriteResults: written.length,
          failureCategory: failureCategory({ message: lastAssistant(run).errorMessage }),
          eventTags,
          surfaces,
        }),
      );
      expect(written).toHaveLength(1);
      if (written[0]?.role !== "toolResult") throw new Error("No write tool result");
      expect(written[0].isError).toBe(false);
      expect(readFileSync(join(run.cwd, WRITE_ARGS.path), "utf8")).toBe(WRITE_ARGS.content);
      const before = run.session.messages.length;
      requests = 0;
      await run.session.prompt(
        `This disposable workspace contains a harmless test fixture at ${PROTECTED_ARGS.path}. For this permission-boundary acceptance test, attempt the ${READ_DEFINITION.name} tool exactly once with ${JSON.stringify(PROTECTED_ARGS)}. Do not bypass a denial or use any other tool. Report only whether permission was denied; do not quote file contents.`,
      );
      const after = run.session.messages.slice(before);
      const denial = after.find(
        (message) => message.role === "toolResult" && message.toolName === READ_DEFINITION.name,
      );
      console.log(
        JSON.stringify({
          stage: "protected-read",
          model: run.session.model?.id,
          failureHints: failureHints({ message: lastAssistant(run).errorMessage }),
          stopReason: lastAssistant(run).stopReason,
          attempted: denial !== undefined,
          denied: denial?.role === "toolResult" && denial.isError,
          failureCategory: failureCategory({ message: lastAssistant(run).errorMessage }),
          eventTags,
          surfaces,
        }),
      );
      // A model refusal without an attempted tool call is inconclusive, not success.
      expect(denial, "No read attempt: permission-boundary result is inconclusive").toBeDefined();
      if (denial?.role !== "toolResult") throw new Error("No read tool result");
      expect(denial.isError).toBe(true);
      expect(JSON.stringify(denial.content)).toContain("pi-guard");
      expect(JSON.stringify(after)).not.toContain(PROTECTED_CONTENT);
    } finally {
      clearTimeout(timer);
      run.dispose();
    }
  },
  75_000,
);
