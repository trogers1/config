import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { test } from "vitest";
import { createClaudeExecutableResolver } from "../extensions/cli.ts";
import {
  effectiveSdkEnvironment,
  verifyCliAuthRoute,
  verifySdkAccountRoute,
} from "../extensions/auth-route.ts";
import { createRendezvous } from "../extensions/mcp.ts";
import { buildSdkOptions } from "../extensions/sdk-options.ts";
import { READ_DEFINITION, WRITE_DEFINITION } from "./contract.ts";

// Separate, explicit authorization from the two-prompt acceptance test. This
// probe NEVER yields an SDKUserMessage and cannot request a model turn.
test.skipIf(process.env.PI_CLAUDE_INIT_PROBE !== "1")(
  "live metadata only: inspect initialization without supplying any prompt",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-claude-init-probe-"));
    const controller = new AbortController();
    const closed = Promise.withResolvers<void>();
    const warnings: string[] = [];
    const diagnostics = new Set<string>();
    function classifyDiagnostic({ text }: { text: string }) {
      const exit = /process exited with code (\d+)/i.exec(text)?.[1];
      if (exit) diagnostics.add(`process-exit-${exit}`);
      const option = /unknown option ['"](--[a-z][a-z0-9-]*)['"]/i.exec(text)?.[1];
      if (option) diagnostics.add(`unsupported-option:${option}`);
      for (const [pattern, category] of [
        [/EPERM|EACCES|permission denied|operation not permitted/i, "permission-denied"],
        [/cannot be launched inside|nested.*session/i, "nested-session-refusal"],
        [/invalid.*settings|settings.*invalid/i, "invalid-settings"],
        [/not logged in|authentication.*failed|login.*required/i, "authentication-refusal"],
        [/schema mismatch/i, "metadata-schema-mismatch"],
        [/ENOENT|no such file/i, "missing-file"],
      ] satisfies [RegExp, string][]) {
        if (pattern.test(text)) diagnostics.add(category);
      }
    }
    const tools = [READ_DEFINITION, WRITE_DEFINITION];
    const rendezvous = createRendezvous({
      tools,
      fail: () => controller.abort(),
      onComplete: () => {},
    });
    let sdk: ReturnType<typeof query> | undefined;
    const timer = setTimeout(() => {
      controller.abort();
      closed.resolve();
      sdk?.close();
    }, 15_000);
    let stage = "executable metadata";
    try {
      const executable = await createClaudeExecutableResolver().resolve({
        cwd,
        warn: ({ message }) => warnings.push(message),
      });
      const env = effectiveSdkEnvironment({
        ambient: process.env,
        request: undefined,
        claudeConfigDir: resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")),
        maxTokens: undefined,
      });
      stage = "CLI authentication-route metadata";
      await verifyCliAuthRoute({
        executable: executable.path,
        cwd,
        env,
        signal: controller.signal,
      });
      const model = [...getBuiltinModels("anthropic")]
        .filter((entry) => /haiku/i.test(entry.id))
        .sort((a, b) => a.cost.input + a.cost.output - b.cost.input - b.cost.output)[0];
      if (!model) throw new Error("No Haiku catalog metadata");
      async function* input(): AsyncGenerator<SDKUserMessage> {
        await closed.promise;
        yield* []; // Deliberately no prompt, including during shutdown.
      }
      stage = "SDK initialization";
      sdk = query({
        prompt: input(),
        options: {
          ...buildSdkOptions({
            cwd,
            claudeExecutablePath: executable.path,
            env,
            model,
            sourceModel: model,
            sdkModel: model.id,
            systemPrompt: "Initialization metadata probe; no model turn is requested.",
            tools,
            rendezvous,
            controller,
            request: {},
          }),
          persistSession: false,
          stderr: (text) => classifyDiagnostic({ text }), // Categories only, never raw output.
        },
      });
      const active = sdk;
      let advertisedTools: string[] | undefined;
      let stopping = false;
      let unexpectedModelEvent = false;
      const events = (async () => {
        for await (const event of active) {
          if (event.type === "system" && event.subtype === "init") advertisedTools = event.tools;
          if (event.type === "assistant" || event.type === "stream_event") {
            unexpectedModelEvent = true;
            controller.abort();
            throw new Error("Unexpected model event in a no-input probe");
          }
        }
      })();
      // Attach rejection handling immediately, even while initialization awaits.
      const eventOutcome = events.then(
        () => true,
        () => stopping && !unexpectedModelEvent,
      );
      const account = await active.accountInfo();
      stage = "SDK authentication-route corroboration";
      // Booleans only: account fields are optional in the public SDK contract.
      // Diagnose omission versus disagreement without exposing account data.
      diagnostics.add(`provider-field-present:${account.apiProvider !== undefined}`);
      diagnostics.add(`provider-is-firstParty:${account.apiProvider === "firstParty"}`);
      diagnostics.add(`api-key-source-present:${account.apiKeySource !== undefined}`);
      diagnostics.add(`api-key-source-is-none:${account.apiKeySource === "none"}`);
      verifySdkAccountRoute({ account });
      stage = "SDK MCP capability metadata";
      const servers = await active.mcpServerStatus();
      const report = {
        cliVersion: executable.version,
        sdkVersion: executable.sdkVersion,
        promptCount: 0,
        authenticationRoute: "claude.ai corroborated by SDK firstParty/no API-key source reported",
        advertisedTools: advertisedTools ?? null,
        mcpServers: servers.map((server) => ({ name: server.name, status: server.status })),
        limitation: advertisedTools ? null : "Runtime did not emit system/init without a prompt",
        warnings,
      };
      stopping = true;
      closed.resolve();
      active.close();
      if (!(await eventOutcome)) throw new Error("Initialization event reader failed");
      console.log(JSON.stringify(report));
    } catch (error) {
      if (error instanceof Error) classifyDiagnostic({ text: error.message });
      // verifyCliAuthRoute owns and sanitizes every error, including child
      // stderr/command failures and schema failures. Other SDK errors may
      // contain runtime output, so do not forward those messages.
      const safeReason =
        stage === "CLI authentication-route metadata" && error instanceof Error
          ? `: ${error.message}`
          : "";
      throw new Error(
        `Initialization-only probe failed during ${stage}${safeReason}; diagnostic categories: ${[...diagnostics].join(", ") || "unclassified"}; no user prompt was supplied`,
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
      closed.resolve();
      sdk?.close();
      await rendezvous.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  20_000,
);
