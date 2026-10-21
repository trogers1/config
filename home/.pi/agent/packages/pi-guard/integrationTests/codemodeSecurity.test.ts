import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { expect, it, vi } from "vitest";
import guard from "../extensions/guard";
import { profileConfigFileSchema } from "../modules/policyHelpers";

it.each(["on", "only"] as const)(
  "enforces Guard for real nested codemode calls (mode: %s)",
  async (mode) => {
    const directory = fs.mkdtempSync(path.join(tmpdir(), "guard-codemode-"));
    const cwd = path.join(directory, "workspace");
    const agentDir = path.join(directory, "agent");
    fs.mkdirSync(cwd);
    fs.mkdirSync(agentDir);
    const configPath = path.join(directory, "profiles.json");
    const marker = path.join(cwd, "denied-marker");
    const editTarget = path.join(cwd, "protected.txt");
    fs.writeFileSync(editTarget, "original\n");
    const config = Value.Parse(profileConfigFileSchema, {
      defaultProfile: "codemode-security",
      profiles: {
        "codemode-security": {
          description: "Real SDK nested tool security regression fixture.",
          sandbox: false,
          tools: {
            bash: [
              { pattern: "*", decision: "deny" },
              { pattern: "printf *", decision: "allow" },
            ],
          },
          readPaths: [{ pattern: "*", decision: "allow" }],
          // Guard roots relative patterns at its process startup directory,
          // which differs from this embedded SDK session's explicit cwd.
          writePaths: [
            { pattern: "**", decision: "allow" },
            { pattern: editTarget, decision: "deny", contexts: ["edit"] },
          ],
        },
      },
    });
    fs.writeFileSync(configPath, JSON.stringify(config));
    vi.stubEnv("PI_GUARD_PROFILE_CONFIG", configPath);
    vi.stubEnv("PI_SUBAGENT_PROFILE", "");
    vi.stubEnv("PI_GUARD_ACTIVE_PROFILE", "");
    const scripts = [
      `return await tools.bash({ command: ${JSON.stringify(`touch '${marker}'`)} });`,
      'return await tools.edit({ path: "protected.txt", edits: [{ oldText: "original", newText: "compromised" }] });',
      'return await tools.bash({ command: "printf codemode-allowed" });',
    ];
    let requests = 0;
    const providerId = "guard-security-fixture";
    const provider = {
      api: "openai-completions",
      apiKey: "local-fixture-not-a-real-key",
      baseUrl: "https://invalid.invalid",
      models: [
        {
          id: "scripted",
          name: "Scripted security fixture",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 1024,
        },
      ],
      streamSimple(model, context) {
        const request = requests++;
        if (request >= scripts.length * 2)
          throw new Error("Unexpected extra model request");
        const stream = createAssistantMessageEventStream();
        const code = scripts[Math.floor(request / 2)];
        if (code === undefined) throw new Error("Missing scripted response");
        const toolCall = request % 2 === 0;
        const declaration = getCurrentTools(context.messages).find(
          (tool) => tool.name === "codemode",
        );
        if (!declaration) throw new Error("Codemode was not declared");
        const args = { code };
        if (!Value.Check(declaration.parameters, args))
          throw new Error(
            "Script fixture does not match codemode input schema",
          );
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [],
          stopReason: "pending",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        };
        stream.push({ type: "start", partial: message });
        if (toolCall) {
          const call = {
            type: "toolCall" as const,
            id: `script-${request}`,
            name: "codemode",
            arguments: args,
          };
          stream.push({
            type: "toolcall_start",
            contentIndex: 0,
            partial: message,
          });
          message.content.push(call);
          stream.push({
            type: "toolcall_end",
            contentIndex: 0,
            toolCall: call,
            partial: message,
          });
        } else {
          stream.push({
            type: "text_start",
            contentIndex: 0,
            partial: message,
          });
          message.content.push({ type: "text", text: "Done." });
          stream.push({
            type: "text_end",
            contentIndex: 0,
            content: "Done.",
            partial: message,
          });
        }
        message.stopReason = toolCall ? "toolUse" : "stop";
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
        return stream;
      },
    } satisfies ProviderConfig;
    let session:
      Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const modelRuntime = await ModelRuntime.create({
        authPath: path.join(agentDir, "auth.json"),
        modelsPath: null,
        modelsStorePath: path.join(agentDir, "models-store.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      modelRuntime.registerProvider(providerId, provider);
      const model = modelRuntime.getModel(providerId, provider.models[0].id);
      if (!model) throw new Error("Scripted model registration failed");
      const settingsManager = SettingsManager.inMemory({
        defaultTools: ["+codemode"],
        retry: { enabled: false },
        compaction: { enabled: false },
      });
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [guard, createCodemodeExtension({ mode })],
      });
      await resourceLoader.reload();
      const created = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        model,
        settingsManager,
        resourceLoader,
        sessionManager: SessionManager.inMemory(cwd),
      });
      session = created.session;
      expect(created.extensionsResult.errors).toEqual([]);
      const extensionErrors: unknown[] = [];
      await session.bindExtensions({
        mode: "json",
        onError: (error) => extensionErrors.push(error),
      });
      expect(session.getActiveToolNames()).toContain("codemode");
      for (const [index, toolName] of ["bash", "edit", "bash"].entries()) {
        await session.prompt(`Run security fixture ${index + 1}.`);
        const results = session.messages.filter(
          (message) =>
            message.role === "toolResult" && message.toolName === "codemode",
        );
        const result = results.at(-1);
        if (!result || result.role !== "toolResult")
          throw new Error("Codemode did not produce a tool result");
        const text = result.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("\n");
        expect(result.nestedCalls?.calls).toEqual([
          expect.objectContaining({
            name: toolName,
            status: index < 2 ? "error" : "ok",
          }),
        ]);
        if (index < 2) {
          expect(result.isError).toBe(true);
          expect(text).toMatch(/pi-guard|denied|blocked/i);
        } else {
          expect(result.isError).toBe(false);
          expect(text).toContain("codemode-allowed");
        }
        expect(fs.existsSync(marker)).toBe(false);
        expect(fs.readFileSync(editTarget, "utf8")).toBe("original\n");
      }
      expect(requests).toBe(scripts.length * 2);
      expect(extensionErrors).toEqual([]);
    } finally {
      session?.dispose();
      vi.unstubAllEnvs();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  30000,
);
