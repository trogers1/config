import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionServices,
  createCodemodeExtension,
  InteractiveMode,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import type { Terminal } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { expect, it, vi } from "vitest";
import guard from "../extensions/guard";
import { profileConfigFileSchema } from "../modules/policyHelpers";
import { ruleSetDefinition } from "../modules/ruleSets.lib";
import { askPermissionChoices } from "../modules/profileUpdate";

// Only the terminal and provider are fake: rendering, focus, keyboard dispatch,
// Guard's custom component and nested tools are real. No fake ctx.ui is bound.
it.each(["direct", "nested", "parallel"] as const)(
  "renders and answers gated reads in InteractiveMode: %s",
  async (scenario) => {
    const directory = fs.mkdtempSync(
      path.join(tmpdir(), "guard-permission-ui-"),
    );
    const cwd = path.join(directory, "workspace");
    const agentDir = path.join(directory, "agent");
    fs.mkdirSync(cwd);
    fs.mkdirSync(agentDir);
    const gated = [
      path.join(directory, "outside-one.txt"),
      path.join(directory, "outside-two.txt"),
    ];
    const skill = path.join(
      directory,
      ".agents",
      "skills",
      "fixture",
      "SKILL.md",
    );
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    for (const file of [...gated, skill])
      fs.writeFileSync(file, `fixture ${path.basename(file)}\n`);
    const configPath = path.join(directory, "profiles.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        Value.Parse(profileConfigFileSchema, {
          defaultProfile: "permission-ui",
          profiles: {
            "permission-ui": {
              description: "Interactive permission regression fixture",
              sandbox: false,
              writePaths: [{ pattern: "**", decision: "deny" }],
              readPaths: ruleSetDefinition({ name: "ruleset:path-guards" })
                .policy.readPaths,
            },
          },
        }),
      ),
    );
    vi.stubEnv("PI_GUARD_PROFILE_CONFIG", configPath);
    vi.stubEnv("PI_SUBAGENT_PROFILE", "");
    vi.stubEnv("PI_GUARD_ACTIVE_PROFILE", "");
    vi.stubEnv("PI_OFFLINE", "1");
    let input: ((data: string) => void) | undefined;
    let output = "";
    const terminal = {
      columns: 160,
      rows: 60,
      kittyProtocolActive: false,
      start(onInput) {
        input = onInput;
      },
      stop() {
        input = undefined;
      },
      async drainInput() {},
      write(data) {
        output += stripVTControlCharacters(data);
      },
      moveBy() {},
      hideCursor() {},
      showCursor() {},
      clearLine() {},
      clearFromCursor() {},
      clearScreen() {},
      setTitle() {},
      setProgress() {},
      setProgramStatus() {},
    } satisfies Terminal;
    const calls = scenario === "parallel" ? [...gated, skill] : [gated[0]];
    const code = `// @options: {"timeout_ms": 2000}\nreturn await Promise.allSettled(${JSON.stringify(calls)}.map(path => tools.read({path})));`;
    let requests = 0;
    const provider = {
      api: "openai-completions",
      apiKey: "fixture",
      baseUrl: "https://invalid.invalid",
      models: [
        {
          id: "scripted",
          name: "Scripted UI fixture",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 1024,
        },
      ],
      streamSimple(model, context) {
        if (++requests > 2) throw new Error("Unexpected model request");
        const toolName = scenario === "direct" ? "read" : "codemode";
        const args: Extract<
          AssistantMessage["content"][number],
          { type: "toolCall" }
        >["arguments"] = scenario === "direct" ? { path: gated[0] } : { code };
        const declaration = getCurrentTools(context.messages).find(
          (tool) => tool.name === toolName,
        );
        if (!declaration || !Value.Check(declaration.parameters, args))
          throw new Error("Invalid scripted tool input");
        const message: AssistantMessage = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content:
            requests === 1
              ? [
                  {
                    type: "toolCall",
                    id: "fixture-call",
                    name: toolName,
                    arguments: args,
                  },
                ]
              : [{ type: "text", text: "Done." }],
          stopReason: requests === 1 ? "toolUse" : "stop",
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
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        stream.push({
          type: "done",
          reason: requests === 1 ? "toolUse" : "stop",
          message,
        });
        stream.end();
        return stream;
      },
    } satisfies ProviderConfig;
    let runtime: AgentSessionRuntime | undefined;
    let ui: InteractiveMode | undefined;
    let driver: ReturnType<typeof setInterval> | undefined;
    const events: string[] = [];
    try {
      const modelRuntime = await ModelRuntime.create({
        authPath: path.join(agentDir, "auth.json"),
        modelsPath: null,
        modelsStorePath: path.join(agentDir, "models-store.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      modelRuntime.registerProvider("permission-fixture", provider);
      const model = modelRuntime.getModel(
        "permission-fixture",
        provider.models[0].id,
      );
      if (!model) throw new Error("Fixture model not registered");
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        modelRuntime,
        settingsManager: SettingsManager.inMemory({
          defaultTools: ["+codemode"],
          retry: { enabled: false },
          compaction: { enabled: false },
          quietStartup: true,
        }),
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [guard, createCodemodeExtension({ mode: "on" })],
        },
      });
      const created = await createAgentSessionFromServices({
        services,
        model,
        sessionManager: SessionManager.inMemory(cwd),
      });
      expect(created.extensionsResult.errors).toEqual([]);
      runtime = new AgentSessionRuntime(created.session, services, () =>
        Promise.reject(new Error("Unexpected session replacement")),
      );
      ui = new InteractiveMode(runtime, { terminal });
      await ui.init();
      output = "";
      created.session.subscribe((event) => {
        if (event.type.startsWith("tool_execution"))
          events.push(JSON.stringify(event));
      });
      // Answer only newly rendered dialogs, never type into the editor after
      // a dialog disappears. A second request must render its own dialog.
      let answeredThrough = -1;
      driver = setInterval(() => {
        const dialogAt = output.lastIndexOf("Read path permission request");
        if (dialogAt > answeredThrough) {
          answeredThrough = dialogAt;
          input?.(askPermissionChoices[1]);
          input?.("\r");
        }
      }, 150);
      const prompt = created.session.prompt("Run the scripted read fixture.");
      const outcome = await Promise.race([
        prompt.then(() => "settled"),
        delay(4500).then(() => "deadline"),
      ]);
      expect(
        output,
        `No permission dialog rendered; events: ${events.join("\n")}`,
      ).toContain("Read path permission request");
      expect(
        outcome,
        `Prompt hung; terminal tail: ${output.slice(-2000)}; events: ${events.join("\n")}`,
      ).toBe("settled");
      const result = created.session.messages.find(
        (message) => message.role === "toolResult",
      );
      if (!result || result.role !== "toolResult")
        throw new Error("No tool result");
      expect(result.isError, JSON.stringify(result)).toBe(false);
      if (scenario !== "direct") {
        expect(result.nestedCalls?.calls).toHaveLength(calls.length);
        expect(
          result.nestedCalls?.calls.map((call) => ({
            name: call.name,
            status: call.status,
          })),
        ).toEqual(calls.map(() => ({ name: "read", status: "ok" })));
      }
    } finally {
      if (driver) clearInterval(driver);
      ui?.stop();
      // Invalidate contexts without awaiting an unbounded permission promise.
      runtime?.session.dispose();
      vi.unstubAllEnvs();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
  15000,
);
