import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
  getSupportedThinkingLevels,
  type Model,
  type SimpleStreamOptions,
  type Tool,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { parseOrThrow } from "./validation.ts";
import { DISABLED_PLUGINS, DISABLED_SKILLS } from "./components.ts";

// Shared verbatim with metadata-only auth status, so both commands see the
// same non-managed settings isolation. Managed policy remains trusted.
export const SDK_SETTINGS_ISOLATION = {
  disableAllHooks: true,
  disableSkillShellExecution: true,
  autoMemoryEnabled: false,
  autoDreamEnabled: false,
  claudeMdExcludes: ["**"],
  disableBundledSkills: true,
  // SDK Settings contract: --settings scopes these to this invocation, hides
  // already-synced surfaces and stops downloads without moving/deleting files.
  // plugins: [] is additive CLI plugin input, not a discovery-disable switch.
  syncClaudeAiSkills: false,
  syncClaudeAiPlugins: false,
  disableClaudeAiConnectors: true,
  disableRemoteControl: true,
  remoteControlAtStartup: false,
  disableWorkflows: true,
  disableArtifact: true,
  enabledPlugins: DISABLED_PLUGINS,
  skillOverrides: DISABLED_SKILLS,
} satisfies NonNullable<Exclude<Options["settings"], string>>;

const EffortSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
function thinkingOptions({
  model,
  sourceModel,
  request,
}: {
  model: Model<string>;
  sourceModel: Model<"anthropic-messages">;
  request: SimpleStreamOptions;
}): Pick<Options, "thinking" | "effort"> {
  const level = request.reasoning;
  const nativeLevels = getSupportedThinkingLevels(sourceModel);
  const supported = getSupportedThinkingLevels(model).filter((level) =>
    nativeLevels.includes(level),
  );
  if (!level) {
    if (!supported.includes("off"))
      throw new Error(`pi-claude: ${model.id} does not support disabled thinking`);
    return { thinking: { type: "disabled" } };
  }
  if (!supported.includes(level))
    throw new Error(`pi-claude: ${model.id} does not support thinking level ${level}`);
  if (sourceModel.compat?.forceAdaptiveThinking) {
    const effort = parseOrThrow({
      schema: EffortSchema,
      value:
        model.thinkingLevelMap?.[level] ??
        sourceModel.thinkingLevelMap?.[level] ??
        (level === "minimal" ? "low" : level),
      source: "catalog thinking-effort mapping",
    });
    return { thinking: { type: "adaptive" }, effort };
  }
  if (level === "xhigh" || level === "max")
    throw new Error(`pi-claude: no fixed-budget mapping for thinking level ${level}`);
  const budgetTokens = request.thinkingBudgets?.[level];
  if (
    budgetTokens !== undefined &&
    (!Number.isInteger(budgetTokens) ||
      budgetTokens <= 0 ||
      budgetTokens >= (request.maxTokens ?? model.maxTokens))
  )
    throw new Error("pi-claude: thinking budget must be a positive integer below the output limit");
  // The official runtime supplies its fixed-budget default when Pi did not
  // provide a budget. Do not invent an adaptive capability or copy Pi defaults.
  return { thinking: { type: "enabled", ...(budgetTokens !== undefined ? { budgetTokens } : {}) } };
}
import { MCP_NAME, sdkToolName, type createRendezvous } from "./mcp.ts";

export function buildSdkOptions({
  cwd,
  claudeExecutablePath,
  model,
  sourceModel,
  sdkModel,
  systemPrompt,
  tools,
  rendezvous,
  controller,
  request,
  resume,
  forkSession,
  env,
}: {
  cwd: string;
  claudeExecutablePath: string;
  env: NonNullable<Options["env"]>;
  model: Model<string>;
  sourceModel: Model<"anthropic-messages">;
  sdkModel: string;
  systemPrompt: Options["systemPrompt"];
  tools: Tool[];
  rendezvous: ReturnType<typeof createRendezvous>;
  controller: AbortController;
  request: SimpleStreamOptions;
  resume?: string;
  forkSession?: boolean;
}): Options {
  for (const key of [
    "fetch",
    "temperature",
    "samplingParams",
    "maxRetries",
    "deferred",
  ] satisfies (keyof SimpleStreamOptions)[]) {
    if (request[key] !== undefined)
      throw new Error(`pi-claude: SDK transport does not support ${key}`);
  }
  if (request.headers && Object.keys(request.headers).length)
    throw new Error("pi-claude: SDK transport does not support custom headers");
  // Pi always supplies timeoutMs/maxRetryDelayMs. They are HTTP-adapter hints,
  // not controls exposed by query(); rejecting them would reject every real
  // Pi session. The SDK owns these limits (documented in the provider contract).
  if (request.transport && request.transport !== "auto")
    throw new Error("pi-claude: SDK owns its transport");
  const names = tools.map((tool) => sdkToolName({ name: tool.name }));
  const thinking = thinkingOptions({ model, sourceModel, request });
  return {
    cwd,
    pathToClaudeCodeExecutable: claudeExecutablePath,
    model: sdkModel,
    systemPrompt,
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: { [MCP_NAME]: rendezvous.config },
    permissionMode: "default",
    includePartialMessages: true,
    verbatimPrompts: true,
    skills: [],
    plugins: [],
    agents: {},
    settings: SDK_SETTINGS_ISOLATION,
    env,
    abortController: controller,
    enableFileCheckpointing: false,
    persistSession: true,
    ...(resume ? { resume, forkSession: forkSession ?? false } : {}),
    ...thinking,
    canUseTool: async (name, input, info) => {
      if (
        names.includes(name) &&
        info.mcpServer?.name === MCP_NAME &&
        info.mcpServer.source === "sdk"
      ) {
        return { behavior: "allow", updatedInput: input };
      }
      return { behavior: "deny", message: "Only Pi's guarded in-process MCP tools are permitted" };
    },
  } satisfies Options;
}
