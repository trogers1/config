import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { test } from "vitest";
import {
  getCurrentSystemPrompt,
  getCurrentSystemMessage,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import { createTestSession } from "./fixtures/session.ts";
import { createClaudeExecutableResolver } from "../extensions/cli.ts";
import {
  effectiveSdkEnvironment,
  verifyCliAuthRoute,
  verifySdkAccountRoute,
} from "../extensions/auth-route.ts";
import { hasApprovedComponents } from "../extensions/components.ts";
import { SDK_SETTINGS_ISOLATION } from "../extensions/sdk-options.ts";
import { failureCategory, failureHints } from "./fixtures/provider-diagnostics.ts";

// Independent SDK query: no Pi session, bridge stream, MCP transport, or tools.
// This is a separately opted-in diagnostic, never bridge acceptance.
test.skipIf(process.env.PI_CLAUDE_DIRECT_SDK !== "1")(
  "live: direct official SDK simple prompt (NOT bridge acceptance)",
  async () => {
    const fullSystem = process.env.PI_CLAUDE_DIRECT_FULL_SYSTEM === "1";
    const sectionMode = process.env.PI_CLAUDE_DIRECT_SECTIONS;
    const topicRange = process.env.PI_CLAUDE_DIRECT_TOPIC_RANGE;
    if (
      topicRange !== undefined &&
      (!/^\d+:\d+$/.test(topicRange) || sectionMode !== "docs-topics")
    )
      throw new Error("Topic range requires docs-topics and start:end indices");
    if (
      sectionMode !== undefined &&
      ![
        "first-half",
        "second-half",
        "tools",
        "rules",
        "docs",
        "docs-first",
        "docs-second",
        "docs-topics",
      ].includes(sectionMode)
    )
      throw new Error("Unknown diagnostic section selection");
    if (sectionMode && !fullSystem)
      throw new Error("Section selection requires full-system capture");
    const piSession = fullSystem ? await createTestSession({ live: true }) : undefined;
    const cwd =
      piSession?.cwd ?? (await realpath(await mkdtemp(join(tmpdir(), "pi-claude-direct-sdk-"))));
    let systemPrompt = "Answer briefly and do not use tools.";
    let sectionNames: string[] = [];
    const controller = new AbortController();
    const release = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let sdk: ReturnType<typeof query> | undefined;
    let promptCount = 0;
    let initialized = false;
    let completed = false;
    let answeredOk = false;
    let stage = "setup";
    let errorShape:
      | {
          chars: number;
          bareStatus: boolean;
          html: boolean;
          json: boolean;
          nonAscii: boolean;
          replacementCharacters: boolean;
          gzipMagic: boolean;
          controls: boolean;
        }
      | undefined;
    const timer = setTimeout(() => {
      controller.abort();
      release.resolve();
      closed.resolve();
      sdk?.close();
    }, 30_000);
    try {
      if (piSession) {
        let captured = false;
        piSession.session.agent.streamFunction = (_model, context) => {
          systemPrompt = getCurrentSystemPrompt(context.messages);
          if (sectionMode) {
            const system = getCurrentSystemMessage(context.messages);
            if (!system?.sections) throw new Error("Missing structured diagnostic prompt");
            const entries = Object.entries(system.sections).filter(([name]) => name !== "preamble");
            const split = Math.ceil(entries.length / 2);
            const selected =
              sectionMode === "first-half"
                ? entries.slice(0, split)
                : sectionMode === "second-half"
                  ? entries.slice(split)
                  : entries.filter(
                      ([name]) => name === (sectionMode.startsWith("docs-") ? "docs" : sectionMode),
                    );
            if (!selected.length) throw new Error("Missing diagnostic section");
            if (sectionMode.startsWith("docs-")) {
              for (const entry of selected) {
                if (typeof entry[1] !== "string") throw new Error("Missing docs text");
                const lines = entry[1].split("\n");
                const middle = Math.ceil(lines.length / 2);
                entry[1] = (
                  sectionMode === "docs-topics"
                    ? lines.filter((line) => line.startsWith("- When asked about:"))
                    : sectionMode === "docs-first"
                      ? lines.slice(0, middle)
                      : lines.slice(middle)
                ).join("\n");
                if (topicRange) {
                  const [start, end] = topicRange.split(":").map(Number);
                  const topics = entry[1]
                    .replace(/^- When asked about: /, "")
                    .split(/, (?![^()]*\))/);
                  if (
                    start === undefined ||
                    end === undefined ||
                    start < 0 ||
                    end > topics.length ||
                    start >= end
                  )
                    throw new Error("Invalid diagnostic topic range");
                  entry[1] = `- When asked about: ${topics.slice(start, end).join(", ")}`;
                }
                if (!entry[1]) throw new Error("Missing docs diagnostic text");
              }
            }
            sectionNames = selected.map(([name]) => name);
            systemPrompt = getSystemMessageText({
              ...system,
              sections: {
                preamble: system.sections.preamble ?? "",
                ...Object.fromEntries(selected),
              },
            });
          }
          captured = true;
          throw new Error("Direct SDK diagnostic captured Pi prompt without dispatch");
        };
        try {
          await piSession.session.prompt("Reply with OK only. Do not use tools.");
        } catch {
          if (!captured) throw new Error("Unable to capture Pi system prompt");
        }
        if (!captured || !systemPrompt.trim()) throw new Error("Missing Pi system prompt");
      }
      const executable = await createClaudeExecutableResolver().resolve({
        cwd,
        warn: () => undefined,
      });
      const env = effectiveSdkEnvironment({
        ambient: process.env,
        request: undefined,
        claudeConfigDir: resolve(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")),
        maxTokens: 256,
      });
      stage = "cli-auth";
      await verifyCliAuthRoute({
        executable: executable.path,
        cwd,
        env,
        signal: controller.signal,
      });
      async function* input(): AsyncGenerator<SDKUserMessage> {
        await release.promise;
        if (controller.signal.aborted) return;
        promptCount++;
        yield {
          type: "user",
          message: { role: "user", content: "Reply with OK only. Do not use tools." },
          parent_tool_use_id: null,
          client_composed: true,
        };
        await closed.promise;
      }
      stage = "sdk-auth";
      sdk = query({
        prompt: input(),
        options: {
          cwd,
          pathToClaudeCodeExecutable: executable.path,
          env,
          abortController: controller,
          model: "haiku",
          systemPrompt,
          thinking: { type: "disabled" },
          tools: [],
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: [],
          settings: SDK_SETTINGS_ISOLATION,
          plugins: [],
          skills: [],
          agents: {},
          permissionMode: "default",
          canUseTool: async () => ({
            behavior: "deny",
            message: "Direct SDK diagnostic forbids tools",
          }),
          verbatimPrompts: true,
          persistSession: false,
          maxTurns: 1,
        },
      });
      verifySdkAccountRoute({ account: await sdk.accountInfo() });
      if (controller.signal.aborted) throw new Error("Diagnostic timed out");
      stage = "generation";
      release.resolve();
      for await (const event of sdk) {
        if (event.type === "system" && event.subtype === "init") {
          if (
            initialized ||
            event.cwd !== cwd ||
            event.apiKeySource !== "none" ||
            event.permissionMode !== "default" ||
            event.tools.length !== 0 ||
            event.mcp_servers.length !== 0 ||
            !hasApprovedComponents({ value: event })
          )
            throw new Error("Direct SDK initialization boundary rejected");
          initialized = true;
        } else if (event.type === "assistant") {
          if (!initialized) throw new Error("Direct SDK content before initialization");
          if (event.error) {
            const detail = event.message.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("\n");
            errorShape = {
              chars: detail.length,
              bareStatus: /^API Error: 400\s*$/.test(detail),
              html: /<html|<!doctype|<body/i.test(detail),
              json: /[{}]/.test(detail),
              nonAscii: [...detail].some((char) => char.charCodeAt(0) > 127),
              replacementCharacters: detail.includes("\uFFFD"),
              gzipMagic: detail.includes("\u001f\u008b"),
              controls: [...detail].some(
                (char) => char.charCodeAt(0) < 32 && !"\n\r\t".includes(char),
              ),
            };
            throw new Error(`pi-claude: Claude ${event.error}: ${detail}`);
          }
          if (event.message.content.some((block) => block.type === "tool_use"))
            throw new Error("Direct SDK attempted forbidden tool");
        } else if (event.type === "result") {
          if (!initialized || event.subtype !== "success" || event.is_error)
            throw new Error("Direct SDK unsuccessful result");
          answeredOk = event.result.trim() === "OK";
          completed = true;
          break;
        }
      }
      if (!completed || !answeredOk || promptCount !== 1)
        throw new Error("Direct SDK did not complete the expected single response");
      console.log(
        JSON.stringify({
          stage: "direct-sdk",
          sectionNames,
          promptCount,
          initialized,
          completed,
          answeredOk,
          cliVersion: executable.version,
          sdkVersion: executable.sdkVersion,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : undefined;
      console.log(
        JSON.stringify({
          stage,
          errorShape,
          topicRange,
          sectionNames,
          promptCount,
          initialized,
          completed,
          answeredOk,
          failureCategory: failureCategory({ message }),
          failureHints: failureHints({ message }),
        }),
      );
      throw new Error(`Direct SDK diagnostic failed during ${stage}; raw error withheld`);
    } finally {
      clearTimeout(timer);
      controller.abort();
      release.resolve();
      closed.resolve();
      sdk?.close();
      if (piSession) piSession.dispose();
      else await rm(cwd, { recursive: true, force: true });
    }
  },
  40_000,
);
