import fs from "node:fs";
import path from "node:path";
import {
  extractShellCommands,
  matchesCommandPattern,
  normalizeCommandForDecision,
  splitShellCommands,
} from "../modules/shell/parse";
import { classifyShell } from "../modules/shell/classify";
import {
  analyzeBashPathReferences,
  decideBashPathReferences,
  decideProtectedBashPathReferences,
  displayPath,
  evaluatePathByPattern,
  expandHome,
  matchesGlobPattern,
  rankPathRules,
  resolveRequestedPath,
  type BashPathReferenceTrace,
} from "../modules/shell/pathPolicy";
import {
  injectGrepProtectedPathGlob,
  injectRipgrepProtectedPathGlobs,
} from "../modules/shell/searchPolicy";
import { validateReadCommands } from "../modules/shell/readCommands";
import {
  createBashTool,
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  assertPolicyConfig,
  assertProfilePolicy,
  definePolicyConfig,
  extendProfile,
  withProtectedPathRules,
  type CustomToolRule,
  type Decision,
  type PathContext,
  type PathRule,
  type ProfileColor,
  type PolicyConfig,
  type ProfilePolicy,
  type ProfilePolicyOverride,
  type ReadPathContext,
  type Rule,
  type ToolPolicy,
  type WritePathContext,
} from "../modules/policyHelpers";
import {
  chooseMostSpecific,
  commandPatternSpecificity,
  customToolMatchSpecificity,
  pathPatternSpecificity,
  rankMatchingRules,
  type RankedItem,
  type Specificity,
} from "../modules/ruleSpecificity";
import {
  loadProfileConfig,
  loadRawProfileConfig,
  ProfileConfigLoadError,
  type RawProfileConfig,
} from "../modules/profileConfig";
import {
  builtinCompositionChains,
  policyConfig as genericPolicyConfig,
} from "../modules/policy";
import { parseSubagentPermissibleRules } from "../modules/subagentScopes";
import {
  clearSandboxCaches,
  resolveSandbox,
  type SandboxResolution,
} from "../modules/sandbox.lib";

export {
  assertPolicyConfig,
  assertProfilePolicy,
  definePolicyConfig,
  extendProfile,
  withProtectedPathRules,
};
export type {
  CustomToolRule,
  Decision,
  PathContext,
  PathRule,
  ProfileColor,
  PolicyConfig,
  ProfilePolicy,
  ProfilePolicyOverride,
  ReadPathContext,
  Rule,
  ToolPolicy,
  WritePathContext,
};

// ─── Types ────────────────────────────────────────────────────────────

type Approval = {
  approved: boolean;
  guidance?: string;
};

type PolicyDecision = {
  decision: Decision;
  rule?: Rule;
};

export { extractShellCommands, matchesGlobPattern, splitShellCommands };

const ansi = {
  black: (value: string) => `\x1b[30m${value}\x1b[0m`,
  red: (value: string) => `\x1b[31m${value}\x1b[0m`,
  green: (value: string) => `\x1b[32m${value}\x1b[0m`,
  yellow: (value: string) => `\x1b[33m${value}\x1b[0m`,
  blue: (value: string) => `\x1b[34m${value}\x1b[0m`,
  magenta: (value: string) => `\x1b[35m${value}\x1b[0m`,
  cyan: (value: string) => `\x1b[36m${value}\x1b[0m`,
  white: (value: string) => `\x1b[37m${value}\x1b[0m`,
  bold: (value: string) => `\x1b[1m${value}\x1b[0m`,
  dim: (value: string) => `\x1b[2m${value}\x1b[0m`,
} as const;

const profileColorFormatters: Record<ProfileColor, (value: string) => string> =
  {
    black: ansi.black,
    red: ansi.red,
    green: ansi.green,
    yellow: ansi.yellow,
    orange: ansi.yellow,
    blue: ansi.blue,
    magenta: ansi.magenta,
    cyan: ansi.cyan,
    white: ansi.white,
  };

const defaultPolicy: ProfilePolicy = {
  tools: {
    bash: [{ pattern: "*", decision: "ask" }],
  },
  readPaths: [{ pattern: "*", decision: "allow" }],
  writePaths: [{ pattern: "*", decision: "allow" }],
};

const moduleDir = typeof __dirname === "string" ? __dirname : process.cwd();
const profileEntryType = "pi-permissions-profile";
/** Exposes the active parent policy to subagent launchers in this Pi process. */
const activeProfileEnvKey = "PI_PERMISSIONS_ACTIVE_PROFILE";
const readToolNames = ["read", "grep", "find", "ls"] as const;
const writeToolNames = ["edit", "write"] as const;
const pathToolNames = [...readToolNames, ...writeToolNames] as const;
const pathToolNameSet: ReadonlySet<string> = new Set(pathToolNames);
const readToolNameSet: ReadonlySet<string> = new Set(readToolNames);
const writeToolNameSet: ReadonlySet<string> = new Set(writeToolNames);

type PathToolName = (typeof pathToolNames)[number];

function typedKeys<T extends object>(value: T): Array<keyof T & string> {
  return Object.keys(value) as Array<keyof T & string>;
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const property: unknown = Reflect.get(value, key);
  return typeof property === "string" ? property : undefined;
}

export default function (pi: ExtensionAPI) {
  const profileConfigPath =
    process.env.PI_PERMISSIONS_PROFILE_CONFIG?.trim() || undefined;

  const profileConfigLoad: {
    config: PolicyConfig;
    error?: ProfileConfigLoadError;
  } = (() => {
    try {
      return {
        config: loadProfileConfig(genericPolicyConfig, profileConfigPath),
      };
    } catch (error) {
      if (error instanceof ProfileConfigLoadError) {
        return { config: genericPolicyConfig, error };
      }
      throw error;
    }
  })();

  const rawProfileConfig = loadRawProfileConfig(profileConfigPath);

  const policyConfig = profileConfigLoad.config;
  type ProfileName = string;

  const profileNames = () => typedKeys(policyConfig.profiles);

  function profileForDirectory(cwd: string): ProfileName | undefined {
    const resolvedCwd = path.resolve(cwd);
    let match: { profile: ProfileName; length: number } | undefined;

    for (const profile of profileNames()) {
      for (const configuredDirectory of activePolicy(profile).directories ??
        []) {
        const directory = path.resolve(expandHome(configuredDirectory));
        const relative = path.relative(directory, resolvedCwd);
        if (relative === ".." || relative.startsWith(`..${path.sep}`)) continue;

        if (!match || directory.length >= match.length) {
          match = { profile, length: directory.length };
        }
      }
    }

    return match?.profile;
  }

  function isProfileName(value: string): boolean {
    return Object.hasOwn(policyConfig.profiles, value);
  }

  function activePolicy(profile: ProfileName): ProfilePolicy {
    return policyConfig.profiles[profile];
  }

  function formatProfileStatus(profileName: ProfileName): string {
    const profile = activePolicy(profileName);
    const color = profile.color ?? "blue";
    const emoji = profile.emoji ? `${profile.emoji} ` : "";
    const colorize = profileColorFormatters[color];
    return `profile: ${emoji}${colorize(ansi.bold(profileName))}`;
  }

  function formatSandboxStatus(profileName: ProfileName): string | undefined {
    const sandbox = activePolicy(profileName).sandbox;
    if (typeof sandbox !== "object") return undefined;
    return `sandbox: ${sandbox.onUnavailable === "warn" ? "off" : "blocked"}`;
  }

  function formatSandboxReport(
    resolution: Extract<SandboxResolution, { kind: "active" }>,
  ): string {
    const filesystem = resolution.spec.filesystem;
    const report = resolution.report;
    const scopes = filesystem.scopeRoots.length
      ? filesystem.scopeRoots.join(", ")
      : "none";
    const coverage = [
      `uncovered=${report.uncoveredRestrictions.length}`,
      `waived=${report.waivedRestrictions.length}`,
      `untranslated-allows=${report.untranslatedAllows.length}`,
      `no-kernel-meaning=${report.noKernelMeaning.length}`,
    ].join(", ");
    const provenance = isBashToolOwned()
      ? "pi-permissions bash override"
      : "bash tool ownership is not current";
    return [
      `Sandbox active for ${activeProfile}: ${resolution.prepared.backend} 🔒`,
      `network=${resolution.spec.network}`,
      `writable-roots=${filesystem.writeAllowRoots.join(", ") || "none"}`,
      `subagent-scope=${scopes}`,
      `tool=${provenance}`,
      `coverage: ${coverage}`,
    ].join("; ");
  }

  const startupCwd = path.resolve(process.cwd());
  // Capture Pi's standard local Bash implementation once; the registered
  // override delegates to it whenever sandboxing is disabled or explicitly
  // configured to fall back with a warning.
  const packageBashTool = createBashTool(startupCwd);
  const packageBashSource = { key: undefined as string | undefined };
  const subagentProfile = process.env.PI_SUBAGENT_PROFILE?.trim();
  const subagentPermissibleRules = parseSubagentPermissibleRules(
    process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS,
  );
  const profileConfigErrorReason = profileConfigLoad.error?.message;
  let subagentProfileErrorReason: string | undefined;
  let activeProfile: ProfileName = policyConfig.defaultProfile;
  let profileActivationQueue: Promise<void> = Promise.resolve();
  const configurationErrorReason = () =>
    profileConfigErrorReason ?? subagentProfileErrorReason;

  function preserveConfigurationErrorStatus(ctx: ExtensionContext): boolean {
    const errorReason = configurationErrorReason();
    if (!errorReason) return false;
    ctx.ui.setStatus("permissions", "invalid-permissions");
    if (ctx.hasUI) ctx.ui.notify(errorReason, "error");
    return true;
  }

  async function refreshSandboxStatus(ctx: ExtensionContext): Promise<void> {
    const policy = activePolicy(activeProfile);
    const sessionCwd = ctx.cwd ?? startupCwd;
    const resolution = await resolveSandbox({
      profile: activeProfile,
      policy,
      startupCwd: sessionCwd,
      subagentScopes: subagentPermissibleRules,
      configurationError: configurationErrorReason(),
    });

    if (resolution.kind === "none") {
      ctx.ui.setStatus("sandbox", undefined);
      return;
    }

    if (resolution.kind === "unavailable") {
      ctx.ui.setStatus("sandbox", formatSandboxStatus(activeProfile));
      if (ctx.hasUI) {
        ctx.ui.notify(
          resolution.reason,
          resolution.onUnavailable === "warn" ? "warning" : "error",
        );
      }
      return;
    }

    ctx.ui.setStatus("sandbox", `sandbox: ${resolution.prepared.backend} 🔒`);
  }

  function sandboxUnavailableResult(reason: string) {
    return {
      content: [
        { type: "text" as const, text: `Bash sandbox unavailable: ${reason}` },
      ],
      details: {
        exitCode: 126,
        durationMs: 0,
        output: `Bash sandbox unavailable: ${reason}`,
      },
    };
  }

  async function executeBashWithExitCode<T>(
    execute: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = (await execute()) as Record<string, unknown>;
      const details =
        (result.details as Record<string, unknown> | undefined) ?? {};
      return {
        ...result,
        details: {
          ...details,
          ...(typeof details.exitCode === "number" ? {} : { exitCode: 0 }),
        },
      } as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const match = message.match(/Command exited with code (\d+)/);
      const exitCode = match
        ? Number(match[1])
        : /timed out|aborted/i.test(message)
          ? 124
          : undefined;
      if (exitCode === undefined) throw error;
      return {
        content: [{ type: "text" as const, text: message }],
        details: { exitCode },
      } as T;
    }
  }

  function isBashToolOwned(): boolean {
    const bashTool = pi.getAllTools().find((tool) => tool.name === "bash");
    const currentSourceKey = bashTool
      ? JSON.stringify(bashTool.sourceInfo)
      : undefined;
    return Boolean(
      packageBashSource.key && currentSourceKey === packageBashSource.key,
    );
  }

  function ensureBashToolOwnership(): void {
    if (!isBashToolOwned()) {
      throw new Error(
        "pi-permissions' bash override no longer owns the effective bash tool; sandboxed execution is blocked",
      );
    }
  }

  function activateProfile(
    profile: ProfileName,
    ctx: ExtensionContext,
    message?: string,
  ): Promise<void> {
    const activation = profileActivationQueue.then(async () => {
      activeProfile = profile;
      // Subagent launchers inherit this process environment; update it with
      // the committed profile before rebuilding its sandbox state.
      process.env[activeProfileEnvKey] = activeProfile;
      ensureReadToolsActive();
      await clearSandboxCaches();
      pi.appendEntry(profileEntryType, { profile, timestamp: Date.now() });
      await refreshSandboxStatus(ctx);
      ctx.ui.setStatus("permissions", formatProfileStatus(activeProfile));
      if (message) ctx.ui.notify(message, "info");
    });
    profileActivationQueue = activation.catch(() => undefined);
    return activation;
  }

  function formatInvalidSubagentProfileReason(profile: string): string {
    return `Invalid PI_SUBAGENT_PROFILE '${profile}'. Available: ${profileNames().join(", ")}

The permissions gate remains loaded and will fail closed until the profile is corrected.`;
  }

  function restoreActiveProfile(ctx: ExtensionContext): void {
    activeProfile = policyConfig.defaultProfile;
    subagentProfileErrorReason = undefined;

    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== profileEntryType)
        continue;
      const profile = readStringProperty(entry.data, "profile");
      if (profile && isProfileName(profile)) {
        activeProfile = profile;
      }
    }

    // Directory selections are intentionally stronger than the persisted
    // session choice: opening or resuming a session in a configured directory
    // must get that directory's policy.
    const directoryProfile = profileForDirectory(ctx.cwd ?? startupCwd);
    if (directoryProfile) activeProfile = directoryProfile;

    // A subagent's declared profile is authoritative even when resuming a
    // session that previously persisted a different interactive or directory
    // selected profile.
    if (subagentProfile) {
      if (!isProfileName(subagentProfile)) {
        subagentProfileErrorReason =
          formatInvalidSubagentProfileReason(subagentProfile);
        return;
      }
      activeProfile = subagentProfile;
    }
  }

  /**
   * Policy guidance steers agents to the read, grep, find, and ls tools, so
   * the gate assumes they are callable. Pi registers every built-in tool but
   * only activates read/bash/edit/write by default, so activate the read
   * tools additively on session start and on every profile switch. A missing
   * registration means the installed pi version no longer provides a tool
   * this package depends on; fail loudly instead of silently losing the
   * read-only tool surface.
   */
  function ensureReadToolsActive(): void {
    const registeredNames = new Set(pi.getAllTools().map((tool) => tool.name));
    const unregistered = readToolNames.filter(
      (name) => !registeredNames.has(name),
    );
    if (unregistered.length > 0) {
      throw new Error(
        `pi-permissions requires pi's built-in read tools (${readToolNames.join(", ")}), but not registered: ${unregistered.join(", ")}. ` +
          "The installed pi version may be incompatible with this package.",
      );
    }
    const activeTools = pi.getActiveTools();
    const inactive = readToolNames.filter(
      (name) => !activeTools.includes(name),
    );
    if (inactive.length === 0) return;
    // Purely additive: preserve tools enabled by the user or other extensions.
    pi.setActiveTools([...activeTools, ...inactive]);
  }

  pi.on("session_start", async (_event, ctx) => {
    ensureReadToolsActive();
    restoreActiveProfile(ctx);
    process.env[activeProfileEnvKey] = activeProfile;

    const errorReason = configurationErrorReason();
    if (errorReason) {
      ctx.ui.setStatus("permissions", "invalid-permissions");
      if (ctx.hasUI) {
        ctx.ui.notify(errorReason, "error");
      }
      return;
    }

    await refreshSandboxStatus(ctx);
    ctx.ui.setStatus("permissions", formatProfileStatus(activeProfile));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("sandbox", undefined);
    ctx.ui.setStatus("permissions", undefined);
    await clearSandboxCaches();
  });

  pi.registerCommand("profile", {
    description: "Show or switch the active permissions profile",
    getArgumentCompletions: (prefix) => {
      return profileNames()
        .filter((profile) => profile.startsWith(prefix))
        .map((profile) => ({
          value: profile,
          label: profile,
          description: profile === activeProfile ? "active" : undefined,
        }));
    },
    handler: async (args, ctx) => {
      if (preserveConfigurationErrorStatus(ctx)) return;
      const requested = args.trim();

      if (!requested) {
        ctx.ui.notify(
          `Active profile: ${activeProfile}. Available: ${profileNames().join(", ")}`,
          "info",
        );
        return;
      }

      if (!isProfileName(requested)) {
        ctx.ui.notify(
          `Unknown profile '${requested}'. Available: ${profileNames().join(", ")}`,
          "error",
        );
        return;
      }

      await activateProfile(
        requested,
        ctx,
        `Switched to profile: ${activeProfile}`,
      );
    },
  });

  pi.registerCommand("read-only", {
    description: "Switch to the read-only permissions profile",
    handler: async (_args, ctx) => {
      if (preserveConfigurationErrorStatus(ctx)) return;
      const readOnlyName = "builtin:read-only";
      if (!policyConfig.profiles[readOnlyName]) {
        ctx.ui.notify("No 'builtin:read-only' profile is configured", "error");
        return;
      }

      await activateProfile(readOnlyName, ctx, "Read-only profile enabled");
    },
  });

  pi.registerCommand("sandbox", {
    description: "Show the active sandbox posture",
    handler: async (_args, ctx) => {
      if (preserveConfigurationErrorStatus(ctx)) return;
      const resolution = await resolveSandbox({
        profile: activeProfile,
        policy: activePolicy(activeProfile),
        startupCwd: ctx.cwd ?? startupCwd,
        subagentScopes: subagentPermissibleRules,
        configurationError: configurationErrorReason(),
      });

      if (resolution.kind === "none") {
        ctx.ui.notify(`Sandbox: off for ${activeProfile}.`, "info");
        return;
      }

      if (resolution.kind === "unavailable") {
        ctx.ui.notify(
          `Sandbox unavailable for ${activeProfile}: ${resolution.reason}`,
          resolution.onUnavailable === "warn" ? "warning" : "error",
        );
        return;
      }

      ctx.ui.notify(formatSandboxReport(resolution), "info");
    },
  });

  pi.registerTool({
    ...packageBashTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const resolution = await resolveSandbox({
        profile: activeProfile,
        policy: activePolicy(activeProfile),
        startupCwd: ctx.cwd ?? startupCwd,
        subagentScopes: subagentPermissibleRules,
        configurationError: configurationErrorReason(),
      });

      if (resolution.kind === "none") {
        return await executeBashWithExitCode(() =>
          createBashTool(ctx.cwd ?? startupCwd).execute(
            toolCallId,
            params,
            signal,
            onUpdate,
          ),
        );
      }

      if (resolution.kind === "unavailable") {
        if (resolution.onUnavailable === "warn") {
          if (ctx.hasUI) {
            ctx.ui.notify(resolution.reason, "warning");
          }
          return await executeBashWithExitCode(() =>
            createBashTool(ctx.cwd ?? startupCwd).execute(
              toolCallId,
              params,
              signal,
              onUpdate,
            ),
          );
        }

        return sandboxUnavailableResult(resolution.reason);
      }

      ensureBashToolOwnership();
      const sandboxedBash = createBashTool(ctx.cwd ?? startupCwd, {
        operations: resolution.prepared.operations,
      });
      return await executeBashWithExitCode(() =>
        sandboxedBash.execute(toolCallId, params, signal, onUpdate),
      );
    },
  });
  const registeredPackageBash = pi
    .getAllTools()
    .find((tool) => tool.name === "bash");
  packageBashSource.key = registeredPackageBash
    ? JSON.stringify(registeredPackageBash.sourceInfo)
    : undefined;

  pi.registerCommand("permissions", {
    description:
      "Explain which rule decided access: /permissions explain <tool> <input>",
    getArgumentCompletions: (prefix) => {
      const tools = ["bash", "read", "edit", "write", "grep", "find", "ls"];
      const trimmed = prefix.trimStart();
      if (trimmed.startsWith("explain ")) {
        const toolPrefix = trimmed.slice("explain ".length);
        return tools
          .filter((tool) => tool.startsWith(toolPrefix))
          .map((tool) => ({
            value: `explain ${tool}`,
            label: tool,
          }));
      }
      if ("explain".startsWith(trimmed)) {
        return [
          {
            value: "explain",
            label: "explain",
            description: "explain a permission decision",
          },
        ];
      }
      return [];
    },
    handler: async (args, ctx) => {
      if (preserveConfigurationErrorStatus(ctx)) return;

      const trimmed = args.trim();
      if (!trimmed.startsWith("explain ")) {
        ctx.ui.notify("Usage: /permissions explain <tool> <input>", "error");
        return;
      }

      const afterExplain = trimmed.slice("explain ".length).trim();
      const firstSpace = afterExplain.search(/\s/);
      if (firstSpace === -1) {
        ctx.ui.notify("Usage: /permissions explain <tool> <input>", "error");
        return;
      }

      const tool = afterExplain.slice(0, firstSpace);
      const input = afterExplain.slice(firstSpace + 1).trim();
      const policy = activePolicy(activeProfile);
      const cwd = ctx.cwd ?? startupCwd;

      const scopeDecision = explainSubagentScope(
        activeProfile,
        tool,
        input,
        startupCwd,
        cwd,
        policy,
        subagentPermissibleRules,
      );
      if (scopeDecision) {
        ctx.ui.notify(formatExplanation(scopeDecision), "info");
        return;
      }

      const evaluatedInput =
        tool === "bash"
          ? injectRipgrepProtectedPathGlobs(
              input,
              policy.protectedPathRules ?? [],
            )
          : input;
      const explanation = explainPermission(
        policy,
        activeProfile,
        tool,
        evaluatedInput,
        cwd,
        startupCwd,
        rawProfileConfig,
      );
      ctx.ui.notify(formatExplanation(explanation), "info");
    },
  });

  pi.registerCommand("socrates", {
    description: "Switch to the Socrates coaching profile",
    handler: async (_args, ctx) => {
      if (preserveConfigurationErrorStatus(ctx)) return;
      if (!policyConfig.profiles.socrates) {
        ctx.ui.notify("No 'socrates' profile is configured", "error");
        return;
      }

      await activateProfile("socrates", ctx, "Socrates profile enabled");
    },
  });

  pi.registerCommand("socrates-off", {
    description: "Switch back to the configured default permissions profile",
    handler: async (_args, ctx) => {
      if (preserveConfigurationErrorStatus(ctx)) return;
      await activateProfile(
        policyConfig.defaultProfile,
        ctx,
        `Socrates profile disabled; active profile: ${activeProfile}`,
      );
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const policy = activePolicy(activeProfile);
    const promptSections = [`# Active profile: ${activeProfile}`];
    const resolution = await resolveSandbox({
      profile: activeProfile,
      policy,
      startupCwd: ctx.cwd ?? startupCwd,
      subagentScopes: subagentPermissibleRules,
      configurationError: configurationErrorReason(),
    });

    if (resolution.kind === "active") {
      promptSections.push(
        `Bash commands run in a kernel sandbox (${resolution.prepared.backend}). Network is ${resolution.spec.network}.`,
      );
    } else if (resolution.kind === "unavailable") {
      promptSections.push(
        resolution.onUnavailable === "warn"
          ? "Bash sandboxing is unavailable; this profile explicitly permits a visible unsandboxed fallback."
          : "Bash sandboxing is unavailable, so Bash commands are blocked.",
      );
    }

    if (policy.promptFile) {
      const promptPath = resolvePolicyRelativePath(policy.promptFile);
      const prompt = fs.readFileSync(promptPath, "utf8").trim();
      promptSections.push(prompt);
    }

    if (promptSections.length === 1) return undefined;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${promptSections.join("\n\n")}`,
    };
  });

  pi.on("user_bash", async (_event, ctx) => {
    const errorReason = configurationErrorReason();
    if (errorReason) {
      return {
        result: {
          output: errorReason,
          exitCode: 126,
          cancelled: false,
          truncated: false,
        },
      };
    }

    const policy = activePolicy(activeProfile);
    const resolution = await resolveSandbox({
      profile: activeProfile,
      policy,
      startupCwd: ctx.cwd ?? startupCwd,
      subagentScopes: subagentPermissibleRules,
      configurationError: configurationErrorReason(),
    });

    if (resolution.kind === "unavailable") {
      if (resolution.onUnavailable === "warn") {
        if (ctx.hasUI) {
          ctx.ui.notify(resolution.reason, "warning");
        }
        return undefined;
      }

      return {
        result: {
          output: `Bash sandbox unavailable: ${resolution.reason}`,
          exitCode: 126,
          cancelled: false,
          truncated: false,
        },
      };
    }

    if (resolution.kind === "active") {
      return { operations: resolution.prepared.operations };
    }

    return undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    const errorReason = configurationErrorReason();
    if (errorReason) {
      return { block: true, reason: errorReason };
    }

    const policy = activePolicy(activeProfile);

    if (isToolCallEventType("bash", event)) {
      const command = event.input.command ?? "";
      const effectiveCwd = ctx.cwd ?? startupCwd;
      const scopeDecision = decideSubagentBashScope(
        command,
        startupCwd,
        effectiveCwd,
        policy,
        subagentPermissibleRules,
      );
      if (scopeDecision) return scopeDecision;

      event.input.command = injectRipgrepProtectedPathGlobs(
        command,
        policy.protectedPathRules ?? [],
      );
      const gateResult = await gateBash(
        event.input.command,
        effectiveCwd,
        ctx,
        policy,
      );
      if (gateResult) return gateResult;

      const sandboxResolution = await resolveSandbox({
        profile: activeProfile,
        policy,
        startupCwd: effectiveCwd,
        subagentScopes: subagentPermissibleRules,
        configurationError: configurationErrorReason(),
      });

      if (sandboxResolution.kind === "active" && !isBashToolOwned()) {
        return {
          block: true,
          reason:
            "pi-permissions' bash override no longer owns the effective bash tool; sandboxed execution is blocked",
        };
      }

      if (sandboxResolution.kind === "unavailable") {
        if (sandboxResolution.onUnavailable === "warn") {
          if (ctx.hasUI) {
            ctx.ui.notify(sandboxResolution.reason, "warning");
          }
          return undefined;
        }

        return {
          block: true,
          reason: `Bash sandbox unavailable: ${sandboxResolution.reason}`,
        };
      }

      return undefined;
    }

    if (isToolCallEventType("grep", event)) {
      const reason = injectGrepProtectedPathGlob(
        event.input,
        policy.protectedPathRules ?? [],
      );
      if (reason) return { block: true, reason };
    }

    if (!isPathToolName(event.toolName)) {
      const customRules = policy.tools[event.toolName];
      if (!customRules) return undefined;
      return await gateCustomTool(
        event.toolName,
        event.input,
        customRules,
        ctx,
      );
    }

    const rules = isReadToolName(event.toolName)
      ? policy.readPaths
      : isWriteToolName(event.toolName)
        ? policy.writePaths
        : undefined;
    if (!rules) return undefined;

    const requestedPath = toolPath(event.toolName, event.input);
    const absolutePath = resolveRequestedPath(
      requestedPath,
      ctx.cwd ?? startupCwd,
    );
    if (
      (event.toolName === "edit" || event.toolName === "write") &&
      subagentPermissibleRules
    ) {
      const scopeDecision = evaluatePathByPattern(
        absolutePath,
        startupCwd,
        subagentPermissibleRules,
        "deny",
        event.toolName,
        policy.protectedPathRules ?? [],
      );
      if (scopeDecision.decision !== "allow") {
        return {
          block: true,
          reason: appendPolicySteering(
            `${event.toolName} denied: path is outside PI_SUBAGENT_PERMISSIBLE_GLOBS: ${displayPath(absolutePath, startupCwd)}`,
            [scopeDecision.rule],
          ),
        };
      }
    }
    const policyDecision = evaluatePathByPattern(
      absolutePath,
      startupCwd,
      rules,
      "allow",
      event.toolName,
      policy.protectedPathRules ?? [],
    );
    const matchPath = policyDecision.matchPath;

    if (policyDecision.decision === "deny") {
      return {
        block: true,
        reason: appendPolicySteering(
          `${event.toolName} denied by policy for path: ${displayPath(absolutePath, startupCwd)}`,
          [policyDecision.rule],
        ),
      };
    }

    if (policyDecision.decision === "ask") {
      const approval = await confirmOrBlock(
        ctx,
        `Allow ${event.toolName}?`,
        `${event.toolName} wants to access:\n${absolutePath}\n\nMatched policy path:\n${matchPath}`,
      );
      if (!approval.approved)
        return {
          block: true,
          reason: appendUserGuidance(
            `${event.toolName} was not approved: ${absolutePath}`,
            approval.guidance,
          ),
        };
    }

    return undefined;
  });
}

function isOpaqueInterpreterCommand(command: string): boolean {
  // These flags place program source in an argument. Optional interpreter
  // flags (for example `node --input-type=module -e`) remain part of the
  // invocation rather than becoming shell path operands.
  return /^(?:env\s+)?(?:node(?:\s+--?[\w-]+(?:=\S+)?)*\s+(?:-e|--eval|-p|--print)|python(?:3)?(?:\s+--?[\w-]+(?:=\S+)?)*\s+(?:-c|--command)|ruby\s+(?:-e|--eval)|perl\s+(?:-e|--eval))\b/.test(
    command.trim(),
  );
}

/** Detect shell composition while ignoring quoted interpreter source. */
function hasShellControlSyntax(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (
      character === ";" ||
      character === "|" ||
      character === "&" ||
      character === "{" ||
      character === "}" ||
      character === "(" ||
      character === ")" ||
      character === "`" ||
      character === "<" ||
      character === ">"
    ) {
      return true;
    }
  }
  return false;
}

function pathAnalysisSegments(command: string): string[] {
  // A plain semicolon list has unconditional, current-shell CWD semantics.
  // Keep structured constructs intact so the AST analyzer can preserve scope
  // and reject uncertain control flow conservatively. Structured constructs
  // also use semicolons, so detect their keywords as well as their operators.
  const structuredShellKeywords =
    /\b(?:if|then|else|elif|fi|case|esac|for|select|while|until|do|done|function|time|coproc)\b/;
  if (
    command.includes(";") &&
    !/[(){}|&$`]/.test(command) &&
    !structuredShellKeywords.test(command)
  ) {
    return splitShellCommands(command);
  }
  return [command];
}

/**
 * Interpreter source is opaque to the shell path parser, but only for that
 * individual command segment. Later shell commands must still be analyzed.
 */
function effectivePathAnalysisSegments(command: string): string[] {
  return pathAnalysisSegments(command).map((segment) =>
    isOpaqueInterpreterCommand(segment) ? "" : segment,
  );
}

function explainSubagentScope(
  profile: string,
  tool: string,
  input: string,
  startupCwd: string,
  cwd: string,
  policy: ProfilePolicy,
  subagentPermissibleRules: Rule[] | undefined,
): PermissionExplanation | undefined {
  if (!subagentPermissibleRules) return undefined;

  let matchedRule: Rule | undefined;
  if (tool === "bash") {
    const scopedPolicy = {
      ...policy,
      readPaths: subagentPermissibleRules as [Rule, ...Rule[]],
      writePaths: subagentPermissibleRules as [Rule, ...Rule[]],
    };
    const decision = decideBashPathReferences(
      effectivePathAnalysisSegments(input),
      startupCwd,
      cwd,
      scopedPolicy,
      policy.protectedPathRules ?? [],
    );
    if (!decision || decision.decision === "allow") return undefined;
    matchedRule = decision.rule;
  } else if (tool === "edit" || tool === "write") {
    const absolutePath = resolveRequestedPath(input, cwd);
    const decision = evaluatePathByPattern(
      absolutePath,
      startupCwd,
      subagentPermissibleRules,
      "deny",
      tool,
      policy.protectedPathRules ?? [],
    );
    if (decision.decision === "allow") return undefined;
    matchedRule = decision.rule;
  } else {
    return undefined;
  }

  const winner = matchedRule
    ? {
        pattern: matchedRule.pattern,
        decision: matchedRule.decision,
        score: pathPatternSpecificity(matchedRule.pattern),
        index: subagentPermissibleRules.indexOf(matchedRule),
      }
    : undefined;
  return {
    tool,
    input,
    profile,
    compositionChain: [],
    decision: "deny",
    winner,
    matches: winner ? [winner] : [],
    protectedOverride: undefined,
    notes: [
      "PI_SUBAGENT_PERMISSIBLE_GLOBS narrows this subagent to its declared paths and denies this request.",
    ],
    fallback: "deny",
  };
}

function decideSubagentBashScope(
  command: string,
  startupCwd: string,
  cwd: string,
  policy: ProfilePolicy,
  subagentPermissibleRules: Rule[] | undefined,
) {
  if (!subagentPermissibleRules) return undefined;
  // Bash operands are gated by writePaths, while cd targets follow readPaths;
  // replace both so navigation cannot escape the declared scope either.
  const scopedPolicy = {
    ...policy,
    readPaths: subagentPermissibleRules as [Rule, ...Rule[]],
    writePaths: subagentPermissibleRules as [Rule, ...Rule[]],
  };
  const decision = decideBashPathReferences(
    effectivePathAnalysisSegments(command),
    startupCwd,
    cwd,
    scopedPolicy,
    policy.protectedPathRules ?? [],
  );
  if (!decision || decision.decision === "allow") return undefined;

  return {
    block: true,
    reason: appendPolicySteering(
      `Bash path reference denied: path is outside PI_SUBAGENT_PERMISSIBLE_GLOBS.\n\nPath:\n${decision.path}\n\nMatched policy path:\n${decision.matchPath}`,
      [decision.rule],
    ),
  };
}

type BashGateEvaluation = {
  parseErrors: ReturnType<typeof classifyShell>["errors"];
  commands: string[];
  protectedPathDecision: ReturnType<typeof decideProtectedBashPathReferences>;
  readValidationError: string | undefined;
  pathDecision: ReturnType<typeof decideBashPathReferences>;
  pathTrace?: BashPathReferenceTrace;
  commandDecisions: PolicyDecision[];
};

/**
 * Evaluate every policy stage used by Bash enforcement without interacting
 * with the user. Both `gateBash` and `/permissions explain` consume this
 * result so the displayed first gate cannot drift from the real gate.
 */
function evaluateBashGate(
  command: string,
  startupCwd: string,
  cwd: string,
  activePolicy: ProfilePolicy,
): BashGateEvaluation {
  const parseErrors = classifyShell(command).errors;
  const commands = extractShellCommands(command)
    .map(normalizeCommandForDecision)
    .filter(Boolean);
  const pathSegments = effectivePathAnalysisSegments(command);
  const protectedPathDecision = decideProtectedBashPathReferences(
    pathSegments,
    startupCwd,
    cwd,
    activePolicy.protectedPathRules ?? [],
  );
  // Inline interpreter source is not shell syntax and can contain arbitrary
  // filesystem APIs. The kernel sandbox, rather than a brittle source parser,
  // contains it. Mixed shell composition is rejected before this evaluation.
  const readValidationError = isOpaqueInterpreterCommand(command)
    ? undefined
    : validateReadCommands(
        command,
        commands,
        activePolicy.protectedPathRules ?? [],
      );
  // A path-level deny must win over an earlier ask.
  const deniedPathAnalysis = analyzeBashPathReferences(
    pathSegments,
    startupCwd,
    cwd,
    activePolicy,
    activePolicy.protectedPathRules ?? [],
    false,
  );
  const pathAnalysis = deniedPathAnalysis.decision
    ? deniedPathAnalysis
    : analyzeBashPathReferences(
        pathSegments,
        startupCwd,
        cwd,
        activePolicy,
        activePolicy.protectedPathRules ?? [],
      );
  const pathDecision = deniedPathAnalysis.decision ?? pathAnalysis.decision;
  const pathTrace = deniedPathAnalysis.decision
    ? deniedPathAnalysis.trace
    : (pathAnalysis.trace ?? deniedPathAnalysis.trace);
  const commandDecisions =
    commands.length > 0
      ? commands.map((item) => evaluateBash(item, activePolicy))
      : [evaluateBash("", activePolicy)];

  return {
    parseErrors,
    commands,
    protectedPathDecision,
    readValidationError,
    pathDecision,
    pathTrace,
    commandDecisions,
  };
}

export async function gateBash(
  command: string,
  startupCwd: string,
  ctx: ExtensionContext,
  activePolicy = defaultPolicy,
) {
  if (isOpaqueInterpreterCommand(command) && hasShellControlSyntax(command)) {
    return {
      block: true,
      reason:
        "Opaque interpreter commands cannot be combined with shell control syntax; split the interpreter invocation from subsequent shell commands.",
    };
  }

  const evaluation = evaluateBashGate(
    command,
    startupCwd,
    ctx.cwd ?? startupCwd,
    activePolicy,
  );
  const {
    parseErrors,
    protectedPathDecision,
    readValidationError,
    pathDecision,
    commandDecisions: decisions,
  } = evaluation;
  if (protectedPathDecision) {
    return {
      block: true,
      reason: appendPolicySteering(
        `Bash path reference denied by protected-path policy.\n\nRaw command:\n${command}\n\nPath:\n${protectedPathDecision.path}\n\nMatched protected path:\n${protectedPathDecision.matchPath}`,
        [protectedPathDecision.rule],
      ),
    };
  }

  if (parseErrors.length > 0) {
    const details = parseErrors
      .map((error) => `- offset ${error.pos}: ${error.message}`)
      .join("\n");
    const approval = await confirmOrBlock(
      ctx,
      "Allow Bash command with parse errors?",
      `The command could not be classified completely.\n\n${details}\n\nRaw command:\n${command}`,
    );
    if (!approval.approved) {
      return {
        block: true,
        reason: appendUserGuidance(
          `Bash command was not approved because it could not be classified completely.\n\n${details}`,
          approval.guidance,
        ),
      };
    }
  }

  if (readValidationError) {
    return {
      block: true,
      reason: `Shell read command denied: ${readValidationError}\n\nUse Pi's read tool for concrete files, grep for content searches, or find followed by explicit read calls.`,
    };
  }

  if (pathDecision?.decision === "deny") {
    return {
      block: true,
      reason: appendPolicySteering(
        `Bash path reference denied by policy.\n\nRaw command:\n${command}\n\nParsed command segments:\n${formatParsedCommands(command, activePolicy)}\n\nPath:\n${pathDecision.path}\n\nMatched policy path:\n${pathDecision.matchPath}`,
        [pathDecision.rule],
      ),
    };
  }
  if (pathDecision?.decision === "ask") {
    const approval = await confirmOrBlock(
      ctx,
      "Bash command references a gated path?",
      `Raw command:\n${command}\n\nParsed command segments:\n${formatParsedCommands(command, activePolicy)}\n\nPath:\n${pathDecision.path}\n\nMatched policy path:\n${pathDecision.matchPath}`,
    );
    if (!approval.approved)
      return {
        block: true,
        reason: appendUserGuidance(
          `Bash path reference was not approved: ${pathDecision.path}`,
          approval.guidance,
        ),
      };
  }

  if (decisions.some(({ decision }) => decision === "deny")) {
    return {
      block: true,
      reason: appendPolicySteering(
        `Command denied by explicit rule.\n\nRaw command:\n${command}\n\nParsed command segments:\n${formatParsedCommands(command, activePolicy)}`,
        decisions
          .filter(({ decision }) => decision === "deny")
          .map(({ rule }) => rule),
      ),
    };
  }

  if (decisions.some(({ decision }) => decision === "ask")) {
    const approval = await confirmOrBlock(
      ctx,
      "Allow bash command?",
      `Raw command:\n${command}\n\nParsed command segments:\n${formatParsedCommands(command, activePolicy)}`,
    );
    if (!approval.approved)
      return {
        block: true,
        reason: appendUserGuidance(
          `Command was not approved: ${command}`,
          approval.guidance,
        ),
      };
  }

  return undefined;
}

export function decideBash(
  command: string,
  activePolicy = defaultPolicy,
): Decision {
  return evaluateBash(command, activePolicy).decision;
}

export type RuleExplanation = {
  pattern: string;
  decision: Decision;
  score: Specificity;
  index: number;
  tiebreak?: "literal-segments" | "literal-characters" | "composition-order";
};

type DisplayableRule = {
  decision: Decision;
  pattern?: string;
  match?: Record<string, string>;
};

export type PermissionExplanation = {
  tool: string;
  input: string;
  profile: string;
  compositionChain: string[];
  decision: Decision;
  winner?: RuleExplanation;
  matches: RuleExplanation[];
  pathWinner?: RuleExplanation;
  pathMatches?: RuleExplanation[];
  protectedOverride?: {
    decision: "allow" | "deny";
    pattern: string;
    guidance?: string;
  };
  protectedMatches?: RuleExplanation[];
  notes: string[];
  fallback: Decision;
};

function evaluateBash(
  command: string,
  activePolicy: ProfilePolicy,
): PolicyDecision {
  return evaluateByPattern(
    command,
    activePolicy.tools.bash ?? [],
    "ask",
    matchesCommandPattern,
  );
}

export function explainPermission(
  policy: ProfilePolicy,
  profileName: string,
  tool: string,
  input: string,
  cwd: string = process.cwd(),
  startupCwd: string = cwd,
  rawConfig?: RawProfileConfig,
): PermissionExplanation {
  const compositionChain = resolveCompositionChain(profileName, rawConfig);

  if (tool === "bash") {
    return explainBashPermission(
      policy,
      profileName,
      input,
      cwd,
      startupCwd,
      compositionChain,
    );
  }

  if (isPathToolName(tool)) {
    const rules: readonly PathRule[] = isReadToolName(tool)
      ? policy.readPaths
      : isWriteToolName(tool)
        ? policy.writePaths
        : [];
    const context = tool as PathContext;
    const fallback: Decision = "allow";
    const requestedPath = toolPath(tool, { path: input }) ?? input;
    const absolutePath = resolveRequestedPath(requestedPath, cwd);
    const ranked = rankPathRules(absolutePath, startupCwd, rules, context);
    const winner = ranked[0];

    const protectedRanked = rankPathRules(
      absolutePath,
      startupCwd,
      policy.protectedPathRules ?? [],
      context,
    );
    const protectedWinner = protectedRanked[0];
    const protectedOverride:
      PermissionExplanation["protectedOverride"] | undefined = protectedWinner
      ? {
          decision: protectedWinner.item.decision,
          pattern: protectedWinner.item.pattern,
          guidance: protectedWinner.item.guidance,
        }
      : undefined;

    return {
      tool,
      input,
      profile: profileName,
      compositionChain,
      decision:
        protectedOverride?.decision === "deny"
          ? "deny"
          : (winner?.item.decision ?? fallback),
      winner: winner ? ruleExplanation(winner) : undefined,
      matches: ranked.map(ruleExplanation),
      protectedOverride,
      protectedMatches: protectedRanked.map(ruleExplanation),
      notes: [],
      fallback,
    };
  }

  const customRules = policy.tools[tool];
  if (customRules) {
    const ranked = rankCustomToolRules(input, customRules);
    const winner = ranked[0];
    const fallback: Decision = "ask";
    return {
      tool,
      input,
      profile: profileName,
      compositionChain,
      decision: winner?.item.decision ?? fallback,
      winner: winner ? ruleExplanation(winner) : undefined,
      matches: ranked.map(ruleExplanation),
      protectedOverride: undefined,
      notes: [],
      fallback,
    };
  }

  return {
    tool,
    input,
    profile: profileName,
    compositionChain,
    decision: "allow",
    winner: undefined,
    matches: [],
    protectedOverride: undefined,
    notes: [`No policy configured for tool '${tool}'; call proceeds.`],
    fallback: "allow",
  };
}

type BashSegmentExplanation = {
  segment: string;
  command: string;
  decision: Decision;
  winner?: RankedItem<Rule>;
  matches: RankedItem<Rule>[];
};

type BashPathLayerDecision = {
  decision: Decision;
  decidedBy: "protected-path" | "path-rule";
  protectedOverride?: PermissionExplanation["protectedOverride"];
  pathRule?: { decision: Decision; pattern: string; guidance?: string };
};

function explainBashPermission(
  policy: ProfilePolicy,
  profileName: string,
  input: string,
  cwd: string,
  startupCwd: string,
  compositionChain: string[],
): PermissionExplanation {
  const evaluation = evaluateBashGate(input, startupCwd, cwd, policy);
  const commands = evaluation.commands.length > 0 ? evaluation.commands : [""];
  const rules = policy.tools.bash ?? [];
  const fallback: Decision = "ask";
  const {
    parseErrors,
    protectedPathDecision,
    readValidationError,
    pathDecision,
    pathTrace,
  } = evaluation;
  const pathLayer = protectedPathDecision
    ? protectedPathLayerDecision(protectedPathDecision)
    : pathDecision && pathDecision.decision !== "allow"
      ? {
          decision: pathDecision.decision,
          decidedBy: "path-rule" as const,
          pathRule: {
            decision: pathDecision.decision,
            pattern: pathDecision.rule?.pattern ?? pathDecision.matchPath,
            guidance: pathDecision.rule?.guidance,
          },
        }
      : undefined;

  const segmentExplanations: BashSegmentExplanation[] = commands.map(
    (command, index) => {
      const ranked = rankCommandRules(command, rules);
      const winner = ranked[0];
      return {
        segment: command,
        command,
        decision: evaluation.commandDecisions[index]?.decision ?? fallback,
        winner,
        matches: ranked,
      };
    },
  );

  const mostRestrictiveCommand = segmentExplanations.reduce(
    (most, current) =>
      restrictiveness(current.decision) > restrictiveness(most.decision)
        ? current
        : most,
    segmentExplanations[0],
  );

  let finalDecision: Decision = mostRestrictiveCommand.decision;
  let decidedBy:
    | "command-rule"
    | "protected-path"
    | "path-rule"
    | "read-validation"
    | "parse-error" = "command-rule";

  if (
    pathLayer?.decidedBy === "protected-path" &&
    pathLayer.decision === "deny"
  ) {
    finalDecision = "deny";
    decidedBy = "protected-path";
  } else if (parseErrors.length > 0) {
    finalDecision = "ask";
    decidedBy = "parse-error";
  } else if (readValidationError) {
    finalDecision = "deny";
    decidedBy = "read-validation";
  } else if (pathLayer?.decision === "deny") {
    finalDecision = "deny";
    decidedBy = pathLayer.decidedBy;
  } else if (pathLayer?.decision === "ask") {
    finalDecision = "ask";
    decidedBy = pathLayer.decidedBy;
  } else if (mostRestrictiveCommand.decision === "deny") {
    finalDecision = "deny";
    decidedBy = "command-rule";
  }

  const bashPathExplanation = pathTrace
    ? {
        protectedMatches: pathTrace.protectedMatches.map(ruleExplanation),
        pathWinner: pathTrace.pathMatches[0]
          ? ruleExplanation(pathTrace.pathMatches[0])
          : undefined,
        pathMatches: pathTrace.pathMatches.map(ruleExplanation),
        protectedOverride: pathTrace.protectedMatches[0]
          ? {
              decision: pathTrace.protectedMatches[0].item.decision,
              pattern: pathTrace.protectedMatches[0].item.pattern,
              guidance: pathTrace.protectedMatches[0].item.guidance,
            }
          : undefined,
      }
    : {
        protectedMatches: undefined,
        pathWinner: undefined,
        pathMatches: undefined,
        protectedOverride: undefined,
      };

  const notes: string[] = [];
  if (segmentExplanations.length > 1) {
    notes.push(
      `Compound command with ${segmentExplanations.length} segments; showing the most restrictive decision.`,
    );
  }
  if (readValidationError) {
    notes.push(`Shell read validation: ${readValidationError}`);
  }
  if (decidedBy === "path-rule" && pathLayer?.pathRule) {
    notes.push(
      `Bash path-reference rule: [${pathLayer.pathRule.decision}] ${pathLayer.pathRule.pattern}`,
    );
  }

  if (parseErrors.length > 0) {
    notes.push(
      protectedPathDecision
        ? "Shell parse/classification errors were present, but a definite protected-path deny short-circuits approval."
        : "Shell parse/classification errors require approval before policy evaluation of ordinary rules; non-interactive execution blocks.",
    );
  }

  return {
    tool: "bash",
    input,
    profile: profileName,
    compositionChain,
    decision: finalDecision,
    winner:
      decidedBy === "command-rule" && mostRestrictiveCommand.winner
        ? ruleExplanation(mostRestrictiveCommand.winner)
        : undefined,
    matches: mostRestrictiveCommand.matches.map(ruleExplanation),
    protectedOverride:
      pathLayer?.protectedOverride ?? bashPathExplanation.protectedOverride,
    protectedMatches: bashPathExplanation.protectedMatches,
    pathWinner: bashPathExplanation.pathWinner,
    pathMatches: bashPathExplanation.pathMatches,
    notes,
    fallback,
  };
}

function restrictiveness(decision: Decision): number {
  if (decision === "deny") return 2;
  if (decision === "ask") return 1;
  return 0;
}

function resolveCompositionChain(
  profileName: string,
  rawConfig?: RawProfileConfig,
): string[] {
  const definitions = rawConfig?.profiles ?? loadRawProfileConfig()?.profiles;
  const resolving = new Set<string>();

  const resolve = (name: string): string[] => {
    const builtinChain = builtinCompositionChains[name];
    if (builtinChain) return [...builtinChain];
    if (name.startsWith("ruleset:") || name.startsWith("transform:")) {
      return [name];
    }

    const definition = definitions?.[name];
    if (!definition || resolving.has(name)) return [name];

    resolving.add(name);
    const chain = [
      ...(definition.extends ?? []).flatMap(resolve),
      ...(definition.transforms ?? []),
      `custom profile: ${name}`,
    ];
    resolving.delete(name);
    return chain;
  };

  return resolve(profileName);
}

function rankCommandRules(
  command: string,
  rules: readonly Rule[],
): RankedItem<Rule>[] {
  return rankMatchingRules(
    rules,
    (rule) => matchesCommandPattern(rule.pattern, command),
    (rule) => commandPatternSpecificity(rule.pattern),
  );
}

function rankCustomToolRules(
  input: string,
  rules: readonly CustomToolRule[],
): RankedItem<CustomToolRule>[] {
  const parsedInput = safeJsonParse(input) ?? input;
  return rankMatchingRules(
    rules,
    (rule) => customToolRuleMatches(rule, parsedInput),
    (rule) => customToolMatchSpecificity(rule.match),
  );
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function ruleExplanation<T extends DisplayableRule>(
  ranked: RankedItem<T>,
): RuleExplanation {
  return {
    pattern:
      ranked.item.pattern ??
      (ranked.item.match ? JSON.stringify(ranked.item.match) : "(catch-all)"),
    decision: ranked.item.decision,
    score: ranked.score,
    index: ranked.index,
    tiebreak: ranked.tiebreak,
  };
}

function protectedPathLayerDecision(decision: {
  rule?: PathRule;
  matchPath: string;
}): BashPathLayerDecision {
  return {
    decision: "deny",
    decidedBy: "protected-path",
    protectedOverride: {
      decision: "deny",
      pattern: decision.rule?.pattern ?? decision.matchPath,
      guidance: decision.rule?.guidance,
    },
  };
}

export function formatExplanation(explanation: PermissionExplanation): string {
  const lines: string[] = [];
  lines.push(`Profile: ${explanation.profile}`);
  if (explanation.compositionChain.length > 0) {
    lines.push(`Composition: ${explanation.compositionChain.join(" → ")}`);
  }
  lines.push(`Tool: ${explanation.tool}`);
  lines.push(`Input: ${explanation.input}`);
  lines.push(`Decision: ${explanation.decision}`);

  if (explanation.protectedOverride) {
    const label =
      explanation.protectedOverride.decision === "deny"
        ? "Protected-layer override"
        : "Protected-layer winner";
    lines.push(
      `${label}: ${explanation.protectedOverride.decision} (${explanation.protectedOverride.pattern})`,
    );
    if (explanation.protectedOverride.guidance) {
      lines.push(`  guidance: ${explanation.protectedOverride.guidance}`);
    }
  }

  if (explanation.protectedMatches?.length) {
    lines.push("Protected matches:");
    for (const match of explanation.protectedMatches) {
      lines.push(
        `  [${match.decision}] ${match.pattern} (segments=${match.score.literalSegments}, chars=${match.score.literalCharacters}, index=${match.index})`,
      );
    }
  }

  if (explanation.winner) {
    const winner = explanation.winner;
    const tiebreak = winner.tiebreak ? ` (tiebreak: ${winner.tiebreak})` : "";
    lines.push(
      `Winner: [${winner.decision}] ${winner.pattern} (segments=${winner.score.literalSegments}, chars=${winner.score.literalCharacters}, index=${winner.index})${tiebreak}`,
    );
  }

  if (explanation.pathWinner) {
    const winner = explanation.pathWinner;
    lines.push(
      `Path-layer winner: [${winner.decision}] ${winner.pattern} (segments=${winner.score.literalSegments}, chars=${winner.score.literalCharacters}, index=${winner.index})`,
    );
  }

  if (explanation.pathMatches?.length) {
    lines.push("Path matches:");
    for (const match of explanation.pathMatches) {
      lines.push(
        `  [${match.decision}] ${match.pattern} (segments=${match.score.literalSegments}, chars=${match.score.literalCharacters}, index=${match.index})`,
      );
    }
  }

  if (explanation.matches.length > 0) {
    lines.push("Matches:");
    for (const match of explanation.matches) {
      lines.push(
        `  [${match.decision}] ${match.pattern} (segments=${match.score.literalSegments}, chars=${match.score.literalCharacters}, index=${match.index})`,
      );
    }
  } else {
    lines.push(
      `Matches: (none — falling back to default ${explanation.fallback})`,
    );
  }

  if (explanation.notes.length > 0) {
    lines.push("Notes:");
    for (const note of explanation.notes) {
      lines.push(`  - ${note}`);
    }
  }

  return lines.join("\n");
}

export function formatParsedCommands(
  command: string,
  activePolicy = defaultPolicy,
): string {
  const commands = extractShellCommands(command)
    .map(normalizeCommandForDecision)
    .filter(Boolean);
  if (commands.length === 0) return ansi.dim("(no parsed command segments)");

  return commands
    .map((cmd, index) => {
      const decision = decideBash(cmd, activePolicy);
      const label = formatDecision(decision);
      return `${String(index + 1).padStart(2, " ")}. [${label}] ${cmd}`;
    })
    .join("\n");
}

function formatDecision(decision: Decision): string {
  if (decision === "allow") return ansi.blue("allow");
  if (decision === "ask") return ansi.yellow("ask");
  return ansi.red("deny");
}

async function gateCustomTool(
  toolName: string,
  input: unknown,
  rules: CustomToolRule[],
  ctx: ExtensionContext,
) {
  const { decision, rule: matchedRule } = decideCustomTool(input, rules);

  if (decision === "deny") {
    return {
      block: true,
      reason: appendPolicySteering(
        `${toolName} denied by custom tool policy.`,
        [matchedRule],
      ),
    };
  }
  if (decision === "ask") {
    const approval = await confirmOrBlock(
      ctx,
      `Allow ${toolName}?`,
      `${toolName} matched a custom tool policy requiring confirmation.`,
    );
    if (!approval.approved) {
      return {
        block: true,
        reason: appendUserGuidance(
          `${toolName} was not approved.`,
          approval.guidance,
        ),
      };
    }
  }
  return undefined;
}

export function decideCustomTool(
  input: unknown,
  rules: CustomToolRule[],
): { decision: Decision; rule?: CustomToolRule } {
  const winner = chooseMostSpecific(
    rules,
    (rule) => customToolRuleMatches(rule, input),
    (rule) => customToolMatchSpecificity(rule.match),
  );
  return { decision: winner?.item.decision ?? "ask", rule: winner?.item };
}

function customToolRuleMatches(rule: CustomToolRule, input: unknown): boolean {
  if (!rule.match) return true;
  return Object.entries(rule.match).every(([propertyPath, pattern]) => {
    const value = readInputPropertyPath(input, propertyPath);
    return (
      value.found &&
      matchesGlobPattern(pattern, matchableInputValue(value.value))
    );
  });
}

function readInputPropertyPath(
  input: unknown,
  propertyPath: string,
): { found: boolean; value?: unknown } {
  let value = input;
  for (const part of propertyPath.split(".")) {
    if (typeof value !== "object" || value === null || !(part in value))
      return { found: false };
    value = Reflect.get(value, part);
  }
  return { found: true, value };
}

function matchableInputValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function evaluateByPattern(
  value: string,
  rules: Rule[],
  defaultDecision: Decision,
  matches: (pattern: string, value: string) => boolean,
): PolicyDecision {
  const winner = chooseMostSpecific(
    rules,
    (rule) => matches(rule.pattern, value),
    (rule) => commandPatternSpecificity(rule.pattern),
  );
  return {
    decision: winner?.item.decision ?? defaultDecision,
    rule: winner?.item,
  };
}

function resolvePolicyRelativePath(value: string): string {
  const expanded = expandHome(value);
  return path.isAbsolute(expanded)
    ? expanded
    : path.resolve(moduleDir, "..", expanded);
}

export function stripJsonCommentsAndTrailingCommas(input: string): string {
  let output = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];

    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote) {
      output += char;
      escaped = true;
      continue;
    }
    if (quote) {
      output += char;
      if (
        (quote === "single" && char === "'") ||
        (quote === "double" && char === '"')
      )
        quote = undefined;
      continue;
    }
    if (char === '"') {
      quote = "double";
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/"))
        i++;
      i++;
      continue;
    }
    output += char;
  }

  return output.replace(/,\s*([}\]])/g, "$1");
}

function isPathToolName(toolName: string): toolName is PathToolName {
  return pathToolNameSet.has(toolName);
}

function isReadToolName(
  toolName: string,
): toolName is (typeof readToolNames)[number] {
  return readToolNameSet.has(toolName);
}

function isWriteToolName(
  toolName: string,
): toolName is (typeof writeToolNames)[number] {
  return writeToolNameSet.has(toolName);
}

function toolPath(toolName: string, input: unknown): string | undefined {
  const requestedPath = readStringProperty(input, "path");
  if (requestedPath) return requestedPath;
  return isPathToolName(toolName) && ["grep", "find", "ls"].includes(toolName)
    ? "."
    : undefined;
}

async function confirmOrBlock(
  ctx: ExtensionContext,
  title: string,
  message: string,
): Promise<Approval> {
  if (!ctx.hasUI) return { approved: false };

  // Permission prompts are shown while the agent is otherwise "working".
  // For large ask messages, the animated Working row can force repeated
  // full-screen redraws under the modal, which looks like flicker. Suspend it
  // while waiting for the user's decision, then restore the normal row.
  const setWorkingVisible = ctx.ui.setWorkingVisible?.bind(ctx.ui);
  setWorkingVisible?.(false);
  try {
    const approved = await ctx.ui.confirm(title, message);
    if (approved) return { approved: true };

    const guidance = await collectDenialGuidance(ctx);
    return guidance ? { approved: false, guidance } : { approved: false };
  } finally {
    setWorkingVisible?.(true);
  }
}

async function collectDenialGuidance(
  ctx: ExtensionContext,
): Promise<string | undefined> {
  const prompt =
    "Denied permission request — optional steering for the agent. Leave blank or press Esc to skip.";
  const input =
    typeof ctx.ui.editor === "function"
      ? await ctx.ui.editor(prompt, "")
      : typeof ctx.ui.input === "function"
        ? await ctx.ui.input(prompt, "")
        : undefined;
  const trimmed = input?.trim();
  return trimmed || undefined;
}

function appendUserGuidance(
  reason: string,
  guidance: string | undefined,
): string {
  if (!guidance) return reason;
  return `${reason}\n\nUser steering after denial:\n${guidance}`;
}

function appendPolicySteering(
  reason: string,
  rules: Array<Pick<Rule, "guidance" | "alternatives"> | undefined>,
): string {
  const guidance = uniqueNonEmpty(rules.map((rule) => rule?.guidance));
  const alternatives = uniqueNonEmpty(
    rules.flatMap((rule) => rule?.alternatives ?? []),
  );
  if (guidance.length === 0 && alternatives.length === 0) return reason;

  const sections = [reason];
  if (guidance.length > 0) {
    sections.push(`Policy guidance:\n${guidance.join("\n")}`);
  }
  if (alternatives.length > 0) {
    sections.push(
      `Suggested alternatives:\n${alternatives.map((value) => `- ${value}`).join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}
