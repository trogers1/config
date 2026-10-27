import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CLAUDE_BRIDGE_PROVIDER } from "../../../pi-guard-subagents/extensions/interactive/provider-extensions.ts";
import {
  profileConfigFileSchema,
  type ProfileConfigFile,
} from "../../../pi-guard/modules/policyHelpers.ts";
import guard from "../../../pi-guard/extensions/guard.ts";
import piClaude from "../../extensions/index.ts";
import { parseJson } from "../../extensions/validation.ts";
import { createFakeClaudeCli } from "./claude-cli.ts";
import { CLAUDE_EXECUTABLE_ENV } from "../../extensions/cli.ts";
import {
  PROTECTED_ARGS,
  PROTECTED_SKILL_ARGS,
  SKILL_READ_ARGS,
  PROTECTED_CONTENT,
  READ_DEFINITION,
  WRITE_DEFINITION,
  WRITE_ARGS,
} from "../contract.ts";

export function lastAssistant({ session }: { session: AgentSession }): AssistantMessage {
  const message = session.messages.findLast((entry) => entry.role === "assistant");
  if (message?.role !== "assistant") throw new Error("Pi produced no assistant result");
  return message;
}

export async function createTestSession({
  extensions = [],
  live = false,
  trusted = true,
  history,
  settings,
  thinkingLevel = "off",
}: {
  extensions?: ExtensionFactory[];
  live?: boolean;
  trusted?: boolean;
  history?: SessionManager;
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
  thinkingLevel?: NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"];
} = {}) {
  // Use one filesystem identity for Pi, guard policy, and child CLI assertions.
  // macOS may spell the same temporary root as /var or /private/var.
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "owned-pi-claude-")));
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  function restoreEnvironment() {
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
  try {
    if (!live) {
      for (const key of Object.keys(process.env)) {
        if (/^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|AZURE_|PI_SUBAGENT_|PI_GUARD_)/.test(key))
          delete process.env[key];
      }
      process.env.HOME = temp;
      process.env.USERPROFILE = temp;
      process.env.CLAUDE_CONFIG_DIR = join(temp, "claude");
    }
    // Live opt-in keeps the operator's normal Claude auth/config context. Never
    // copy credentials: changing CLAUDE_CONFIG_DIR can select a different macOS
    // keychain service. Non-live sessions above always use disposable state.
    const fakeCli = live ? undefined : createFakeClaudeCli({ directory: join(temp, "cli") });
    if (fakeCli) process.env[CLAUDE_EXECUTABLE_ENV] = fakeCli.executable;
    process.env.PI_CODING_AGENT_DIR = join(temp, "agent");
    process.env.PI_OFFLINE = "1";
    const cwd = join(temp, "workspace");
    const agentDir = join(temp, "agent");
    mkdirSync(cwd);
    // A real Pi CLI starts in its session workspace. Guard captures that process
    // directory when its extension factory runs, independently of session.cwd.
    process.chdir(cwd);
    mkdirSync(agentDir);
    writeFileSync(join(cwd, PROTECTED_ARGS.path), PROTECTED_CONTENT);
    const profile = {
      defaultProfile: "provider-test",
      profiles: {
        "provider-test": {
          description: "Hermetic provider tool boundary",
          extends: ["builtin:default"],
          readPaths: [
            { pattern: join(cwd, PROTECTED_ARGS.path), decision: "deny", contexts: ["read"] },
            { pattern: join(cwd, PROTECTED_SKILL_ARGS.path), decision: "deny", contexts: ["read"] },
            { pattern: join(cwd, SKILL_READ_ARGS.path), decision: "allow", contexts: ["read"] },
            { pattern: join(cwd, WRITE_ARGS.path), decision: "allow", contexts: ["read"] },
          ],
        },
      },
    } satisfies ProfileConfigFile;
    const config = join(temp, "profiles.jsonc");
    const text = JSON.stringify(profile);
    parseJson({ text, schema: profileConfigFileSchema, source: config });
    writeFileSync(config, text);
    // All environment changes are restored by dispose(), including on setup failure.
    process.env.PI_GUARD_PROFILE_CONFIG = config;
    process.env.PI_SUBAGENT_PROFILE = profile.defaultProfile;
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: CLAUDE_BRIDGE_PROVIDER,
      retry: { enabled: false },
      compaction: { enabled: false },
      enableInstallTelemetry: false,
      ...settings,
    });
    settingsManager.setProjectTrusted(trusted);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "models-cache.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [piClaude, guard, ...extensions],
    });
    await loader.reload({ resolveProjectTrust: async () => trusted });
    const errors = loader.getExtensions().errors;
    if (errors.length) throw new Error(`Test extension loading failed: ${JSON.stringify(errors)}`);
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      resourceLoader: loader,
      settingsManager,
      thinkingLevel,
      tools: [WRITE_DEFINITION.name, READ_DEFINITION.name],
      sessionManager: history ?? SessionManager.inMemory(cwd),
    });
    await session.bindExtensions({});
    const available = live
      ? await modelRuntime.getAvailable(CLAUDE_BRIDGE_PROVIDER)
      : modelRuntime.getModels(CLAUDE_BRIDGE_PROVIDER);
    const model = [...available].sort(
      (a, b) => a.cost.input + a.cost.output - b.cost.input - b.cost.output,
    )[0];
    if (!model) throw new Error("Owned provider did not register an eligible chat model");
    await session.setModel(model);
    const events: AgentSessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    return {
      temp,
      cwd,
      agentDir,
      session,
      modelRuntime,
      events,
      claudeExecutable: fakeCli?.executable,
      unexpectedClaudeExecution: fakeCli?.unexpectedExecution,
      cliMetadataRequests: fakeCli?.metadataRequests,
      cliAuthRequests: fakeCli?.authRequests,
      cliAuthResponse: fakeCli?.authResponse,
      dispose() {
        try {
          session.dispose();
        } finally {
          restoreEnvironment();
          rmSync(temp, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    restoreEnvironment();
    rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}
