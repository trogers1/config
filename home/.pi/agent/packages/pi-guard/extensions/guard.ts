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
import { askPermissionChoices } from "../modules/profileUpdate";
import {
  createBashTool,
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
  type AgentToolResult,
  type ExtensionHandler,
  type BeforeAgentStartEvent,
  type BeforeAgentStartEventResult,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type ToolCallEvent,
  type ToolCallEventResult,
  type UserBashEvent,
  type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth } from "@earendil-works/pi-tui";
import {
  createProfileAuthoringFlow,
  isProfileAuthoringAbort,
} from "../modules/profileAuthoringFlow";
import {
  ProfilePicker,
  type ProfilePickerItem,
} from "../modules/profilePicker.lib";
import {
  assertPolicyConfig,
  assertProfilePolicy,
  definePolicyConfig,
  extendProfile,
  composeSandboxDeclarations,
  isCompositionFragmentName,
  withProtectedPathRules,
  type CustomToolRule,
  type Decision,
  type PathContext,
  type PathRule,
  type ProfileColor,
  type PolicyConfig,
  type ProfilePolicy,
  profileTransformNames,
  type ProfilePolicyOverride,
  type ProfileTransformName,
  type SandboxConfigOverride,
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
  applyProfileRuleChanges,
  applyProfileAuthoringCommit,
  validateProfileAuthoringCommit,
  validateCustomProfileName,
  loadRawProfileConfig,
  ProfileAuthoringValidationError,
  ProfileConfigConflictError,
  ProfileConfigLockTimeoutError,
  forceRemoveProfileConfigLock,
  type RawProfileConfig,
  type ProfileMutationTarget,
} from "../modules/profileConfig";
import {
  builtinCompositionChains,
  policyConfig as genericPolicyConfig,
} from "../modules/policy";
import {
  createProfileStore,
  isUsableProfileStoreState,
  profileStoreSnapshot,
  profileStoreStatus,
  refreshProfileStore,
  type ProfileStore,
  type ProfileStoreState,
} from "../modules/profileStore";
import { formatProfileColor } from "../modules/profileColors";
import {
  editProfileRuleRows,
  type AskRuleCandidate,
  type EditableRuleRow,
} from "../modules/profileRuleEditor";
import {
  metadataConfirmationTitle,
  metadataSectionPresentation,
  postSaveActivationFailureMessage,
} from "../modules/profileAuthoringPresentation";
import {
  isConservativelyBroadDirectoryActivation,
  summarizeSandboxSecurityExpansion,
} from "../modules/profileMetadataEditor";
import type { EffectiveSandboxAuthoring } from "../modules/profileAuthoring";
import {
  createProfileAuthoringDraft,
  createProfileEditDraft,
} from "../modules/profileAuthoringModel";
import { runProfileAuthoringWizard } from "../modules/profileAuthoringWizard";
import type { OrderedSelectionOption } from "../modules/profileOrderedSelectionEditor";
import {
  matchDirectoryGlobs,
  type DirectoryGlobDeclaration,
} from "../modules/directoryGlobs";
import { ruleSetRegistry } from "../modules/ruleSets.lib";
import { parseSubagentPermissibleRules } from "../modules/subagentScopes";
import { readRuntimePromptFile } from "../modules/profilePromptFile";
import {
  clearSandboxCaches,
  ensureSandboxTemporaryDirectory,
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

/** Test-only observation seam for ordering assertions at the guarded boundary. */
export type GuardOperationObserver = {
  readonly onRefreshRequested?: ({
    toolName,
  }: {
    readonly toolName: string;
  }) => void;
  readonly onRefreshStarted?: ({
    toolName,
  }: {
    readonly toolName: string;
  }) => void;
  readonly onEvaluationStarted?: ({
    toolName,
  }: {
    readonly toolName: string;
  }) => void;
};

let guardOperationObserver: GuardOperationObserver | undefined;

export function setGuardOperationObserverForTesting({
  observer,
}: {
  readonly observer: GuardOperationObserver | undefined;
}): void {
  guardOperationObserver = observer;
}

type Approval = {
  approved: boolean;
  guidance?: string;
  /** Return from the change editor to the permission choice without discarding. */
  back?: boolean;
  /** A profile-update deny already supplied its own inline steering. */
  handledRejection?: boolean;
  /** Profile rules were persisted; the caller must re-evaluate the request. */
  profileUpdated?: boolean;
  /** A policy refresh after a UI await invalidated this prompt's answer. */
  stale?: boolean;
  refreshFailed?: boolean;
};

type RememberDecision = ({
  patterns,
  pathTraces,
}: {
  readonly patterns?: readonly string[];
  readonly pathTraces?: readonly BashPathReferenceTrace[];
}) => Promise<Approval>;
type RefreshAfterUiAwait = () => Promise<"unchanged" | "changed" | "failed">;

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

const defaultPolicy: ProfilePolicy = {
  tools: {
    bash: [{ pattern: "*", decision: "ask" }],
  },
  readPaths: [{ pattern: "*", decision: "allow" }],
  writePaths: [{ pattern: "*", decision: "allow" }],
};

const moduleDir = typeof __dirname === "string" ? __dirname : process.cwd();
const profileEntryType = "pi-guard-profile";
const sandboxEntryType = "pi-guard-sandbox";
/** Exposes the active parent policy to subagent launchers in this Pi process. */
const activeProfileEnvKey = "PI_GUARD_ACTIVE_PROFILE";
const readToolNames = ["read", "grep", "find", "ls"] as const;
const writeToolNames = ["edit", "write"] as const;
const pathToolNames = [...readToolNames, ...writeToolNames] as const;
const pathToolNameSet: ReadonlySet<string> = new Set(pathToolNames);
const readToolNameSet: ReadonlySet<string> = new Set(readToolNames);
const writeToolNameSet: ReadonlySet<string> = new Set(writeToolNames);

type PathToolName = (typeof pathToolNames)[number];

function typedKeys(value: object): string[] {
  return Object.keys(value);
}

function readProperty(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const property = readProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

type SandboxOverride = "inherit" | "enabled" | "disabled";

function isSandboxOverride(value: string): value is SandboxOverride {
  return value === "inherit" || value === "enabled" || value === "disabled";
}

const PERMISSION_BLOCK_PREFIX = "[⛔️ by pi-guard] " as const;
/** A changing policy must not create an unbounded chain of stale prompts. */
const maxOperationEvaluationAttempts = 4;
type RestartOperation = {
  readonly restart: true;
  readonly block?: false;
  readonly reason?: undefined;
};
function restartOperation(): RestartOperation {
  return { restart: true };
}
function isRestartOperation(value: unknown): value is RestartOperation {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, "restart") === true
  );
}

/** Mark every tool-call denial with a machine-readable, stable prefix. */
function markPermissionBlock<
  T extends { block?: boolean; reason?: string } | undefined,
>(result: T): T {
  if (
    result?.block &&
    result.reason &&
    !result.reason.startsWith(PERMISSION_BLOCK_PREFIX)
  ) {
    return {
      ...result,
      reason: `${PERMISSION_BLOCK_PREFIX}${result.reason}`,
    };
  }
  return result;
}

type GuardExtensionAPI = Omit<
  Pick<
    ExtensionAPI,
    | "registerCommand"
    | "registerShortcut"
    | "registerTool"
    | "appendEntry"
    | "getActiveTools"
    | "setActiveTools"
    | "sendUserMessage"
    | "registerFlag"
    | "getFlag"
    | "registerMessageRenderer"
    | "sendMessage"
  >,
  never
> & {
  on(
    event: "session_start",
    handler: ExtensionHandler<SessionStartEvent>,
  ): void;
  on(
    event: "session_shutdown",
    handler: ExtensionHandler<SessionShutdownEvent>,
  ): void;
  on(
    event: "before_agent_start",
    handler: ExtensionHandler<
      BeforeAgentStartEvent,
      BeforeAgentStartEventResult
    >,
  ): void;
  on(
    event: "user_bash",
    handler: ExtensionHandler<UserBashEvent, UserBashEventResult>,
  ): void;
  on(
    event: "tool_call",
    handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>,
  ): void;
  getAllTools(): Array<{ name: string; description?: string }>;
};

export default function (pi: GuardExtensionAPI) {
  const profileConfigPath =
    process.env.PI_GUARD_PROFILE_CONFIG?.trim() || undefined;

  let rawProfileConfig: RawProfileConfig | undefined;
  let profileConfigRevision: string | undefined;
  let directoryGlobDeclarations: readonly DirectoryGlobDeclaration[] = [];
  let policyConfig: PolicyConfig = genericPolicyConfig;
  let profileConfigErrorReason: string | undefined;
  const profileStore: ProfileStore = createProfileStore({
    fallback: genericPolicyConfig,
    configPath: profileConfigPath,
  });

  function adoptProfileSnapshot({
    state,
  }: {
    readonly state: ProfileStoreState;
  }): void {
    const snapshot = profileStoreSnapshot({ state });
    if (!snapshot) return;
    // Policy, raw declarations, revision, and directory metadata are adopted
    // together from the store's single complete file snapshot.
    policyConfig = snapshot.config;
    rawProfileConfig = snapshot.raw;
    profileConfigRevision = snapshot.sourceRevision;
    directoryGlobDeclarations = snapshot.directoryGlobDeclarations;
    profileConfigErrorReason = undefined;
  }

  function profileStoreFailureReason({
    state,
  }: {
    readonly state: ProfileStoreState;
  }): string {
    if (state.status === profileStoreStatus.missing)
      return "pi-guard profile configuration is missing; permissions fail closed until it is restored.";
    if (state.status === profileStoreStatus.invalid)
      return `pi-guard profile configuration is invalid; permissions fail closed until it is fixed. ${state.error?.message ?? ""}`.trim();
    return "pi-guard profile configuration is unavailable; permissions fail closed.";
  }

  const initialProfileStoreState = refreshProfileStore({ store: profileStore });
  adoptProfileSnapshot({ state: initialProfileStoreState });
  if (!isUsableProfileStoreState({ state: initialProfileStoreState })) {
    profileConfigErrorReason = profileStoreFailureReason({
      state: initialProfileStoreState,
    });
  }

  type ProfileName = string;

  const profileNames = () => typedKeys(policyConfig.profiles);

  // Pi's completion callback is synchronous. Refreshing this independent
  // snapshot is synchronous too, so completions never advertise names from a
  // stale adopted policy; failures deliberately expose no config-derived names.
  function freshProfileNames(): readonly string[] {
    const snapshot = profileStoreSnapshot({
      state: refreshProfileStore({ store: profileStore }),
    });
    return snapshot ? typedKeys(snapshot.config.profiles) : [];
  }

  function profileForDirectory(cwd: string): ProfileName | undefined {
    return matchDirectoryGlobs(cwd, directoryGlobDeclarations)?.profile;
  }

  function isProfileName(value: string): boolean {
    return Object.hasOwn(policyConfig.profiles, value);
  }

  function activePolicy(profile: ProfileName): ProfilePolicy {
    return policyConfig.profiles[profile];
  }

  async function showProfilePicker({
    ctx,
  }: {
    readonly ctx: ExtensionContext;
  }): Promise<void> {
    const items: ProfilePickerItem[] = profileNames().map((name) => {
      const profile = activePolicy(name);
      return {
        name,
        emoji: profile.emoji,
        color: profile.color,
        description: `${name === activeProfile ? "Active. " : ""}${profile.description}`,
      };
    });
    const selected = await ctx.ui.custom<string | null>(
      (tui, theme, _keybindings, done) => {
        const picker = new ProfilePicker(items, theme, done, () => done(null));
        return {
          get focused() {
            return picker.focused;
          },
          set focused(value: boolean) {
            picker.focused = value;
          },
          render: (width) => picker.render(width),
          invalidate: () => picker.invalidate(),
          handleInput: (data) => {
            picker.handleInput(data);
            tui.requestRender();
          },
        };
      },
    );

    if (selected) {
      if (!(await refreshOrPreserveConfiguration({ ctx }))) return;
      if (!isProfileName(selected)) {
        ctx.ui.notify(`Profile '${selected}' no longer exists.`, "error");
        return;
      }
      await activateProfile({
        profile: selected,
        ctx,
        message: `Switched to profile: ${selected}`,
      });
    }
  }

  function formatProfileStatus(profileName: ProfileName): string {
    const profile = activePolicy(profileName);
    const color = profile.color ?? "blue";
    const emoji = profile.emoji ? `${profile.emoji} ` : "";
    return `profile: ${emoji}${formatProfileColor(color, ansi.bold(profileName))}`;
  }

  function formatSandboxStatus(policy: ProfilePolicy): string | undefined {
    const sandbox = policy.sandbox;
    if (typeof sandbox !== "object") return undefined;
    return `sandbox: ${sandbox.onUnavailable === "warn" ? "unavailable" : "blocked"} 🔐`;
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
      ? "pi-guard bash override"
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
  // Tool source metadata may change when Pi rebuilds its tool registry. This
  // marker survives those rebuilds and identifies this registered wrapper.
  const packageBashOwnershipMarker = "\n[pi-guard sandbox wrapper]";
  const subagentProfile = process.env.PI_SUBAGENT_PROFILE?.trim();
  const subagentPermissibleRules = parseSubagentPermissibleRules({
    value: process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS,
  });
  // Establish the immutable subagent profile before lifecycle callbacks run.
  // This keeps startup fail-closed even if Pi can begin processing an initial
  // prompt before the asynchronous session_start listener has completed.
  let subagentProfileErrorReason =
    subagentProfile && !isProfileName(subagentProfile)
      ? formatInvalidSubagentProfileReason(subagentProfile)
      : undefined;
  let activeProfile: ProfileName =
    subagentProfile && isProfileName(subagentProfile)
      ? subagentProfile
      : policyConfig.defaultProfile;
  let sandboxOverride: SandboxOverride = "inherit";
  // A refresh publishes a coherent policy/profile pair before it awaits
  // sandbox lifecycle work. Serialize refreshes so another guarded operation
  // cannot evaluate while that lifecycle transition is in progress.
  let profileActivationQueue: Promise<void> = Promise.resolve();
  let profileRefreshQueue: Promise<void> = Promise.resolve();
  let profileRefreshesInFlight = 0;
  // A failed lifecycle disposal can leave the process-level sandbox manager
  // indeterminate. Keep this explicit rather than treating an unchanged
  // source revision as safe to reuse.
  let pendingSandboxTransition:
    { readonly revision: string; readonly profile: ProfileName } | undefined;
  const configurationErrorReason = () =>
    profileConfigErrorReason ?? subagentProfileErrorReason;

  function effectiveSandboxPolicy(profile: ProfileName): ProfilePolicy {
    const policy = activePolicy(profile);
    if (sandboxOverride !== "enabled" || typeof policy.sandbox === "object") {
      return policy;
    }
    // Forced sandboxing retains the profile's resolved filesystem policy but
    // supplies the narrowest network posture when it opted out entirely.
    return { ...policy, sandbox: { network: "deny" } };
  }

  async function resolveActiveSandbox(cwd: string): Promise<SandboxResolution> {
    if (sandboxOverride === "disabled") return { kind: "none" };
    const policy = effectiveSandboxPolicy(activeProfile);
    // SRT otherwise forces TMPDIR=/tmp/claude for every filesystem-sandboxed
    // child, without guaranteeing that directory exists. Give each Pi process
    // its own existing root and grant it only at the kernel sandbox layer;
    // ordinary agent read/write path rules intentionally remain unchanged.
    const sandbox = policy.sandbox;
    const sandboxedPolicy =
      typeof sandbox === "object" && sandbox !== null
        ? {
            ...policy,
            sandbox: {
              ...sandbox,
              extraWritePaths: [
                ...(sandbox.extraWritePaths ?? []),
                ensureSandboxTemporaryDirectory(),
              ],
            },
          }
        : policy;
    return await resolveSandbox({
      profile: activeProfile,
      policy: sandboxedPolicy,
      startupCwd: cwd,
      subagentScopes: subagentPermissibleRules,
      configurationError: configurationErrorReason(),
    });
  }

  async function refreshSandboxStatus(ctx: ExtensionContext): Promise<void> {
    const resolution = await resolveActiveSandbox(ctx.cwd ?? startupCwd);

    if (resolution.kind === "none") {
      ctx.ui.setStatus("sandbox", "sandbox: ❌ off");
      return;
    }

    if (resolution.kind === "unavailable") {
      ctx.ui.setStatus(
        "sandbox",
        formatSandboxStatus(effectiveSandboxPolicy(activeProfile)),
      );
      if (ctx.hasUI) {
        ctx.ui.notify(
          resolution.reason,
          resolution.onUnavailable === "warn" ? "warning" : "error",
        );
      }
      return;
    }

    ctx.ui.setStatus("sandbox", `sandbox: ${resolution.prepared.backend} 🔐`);
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

  type BashToolResult = AgentToolResult<Record<string, unknown>>;
  type BashExecutionResult = AgentToolResult<
    Record<string, unknown> & { exitCode: number }
  >;

  function isBashToolResult(value: unknown): value is BashToolResult {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return false;
    const content = readProperty(value, "content");
    const details = readProperty(value, "details");
    return (
      Array.isArray(content) &&
      content.every(
        (item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          readProperty(item, "type") === "text" &&
          typeof readProperty(item, "text") === "string",
      ) &&
      (details === undefined ||
        (typeof details === "object" &&
          details !== null &&
          !Array.isArray(details)))
    );
  }

  async function executeBashWithExitCode({
    execute,
  }: {
    readonly execute: () => Promise<unknown>;
  }): Promise<BashExecutionResult> {
    try {
      const result = await execute();
      if (!isBashToolResult(result))
        throw new Error("Bash tool returned an invalid execution result");
      const details = result.details ?? {};
      return {
        ...result,
        details: {
          ...details,
          exitCode: typeof details.exitCode === "number" ? details.exitCode : 0,
        },
      };
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
        content: [{ type: "text", text: message }],
        details: { exitCode },
      };
    }
  }

  function isBashToolOwned(): boolean {
    const bashTool = pi.getAllTools().find((tool) => tool.name === "bash");
    return bashTool?.description?.endsWith(packageBashOwnershipMarker) ?? false;
  }

  function ensureBashToolOwnership(): void {
    if (!isBashToolOwned()) {
      throw new Error(
        "pi-guard' bash override no longer owns the effective bash tool; sandboxed execution is blocked",
      );
    }
  }

  function activateProfile({
    profile,
    ctx,
    message,
  }: {
    readonly profile: ProfileName;
    readonly ctx: ExtensionContext;
    readonly message?: string;
  }): Promise<void> {
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

  function persistedSessionProfile({
    ctx,
  }: {
    readonly ctx: ExtensionContext;
  }): ProfileName | undefined {
    let persisted: ProfileName | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== profileEntryType)
        continue;
      const profile = readStringProperty(entry.data, "profile");
      if (profile) persisted = profile;
    }
    return persisted;
  }

  function restoreActiveProfile(ctx: ExtensionContext): void {
    activeProfile = policyConfig.defaultProfile;
    sandboxOverride = "inherit";
    subagentProfileErrorReason = undefined;

    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom") continue;

      if (entry.customType === profileEntryType) {
        const profile = readStringProperty(entry.data, "profile");
        if (profile && isProfileName(profile)) {
          activeProfile = profile;
        }
      }

      if (entry.customType === sandboxEntryType) {
        const override = readStringProperty(entry.data, "override");
        if (override && isSandboxOverride(override)) {
          sandboxOverride = override;
        }
      }
    }

    // Directory selections are intentionally stronger than the persisted
    // session choice: opening or resuming a session in a configured directory
    // must get that directory's policy.
    const directoryProfile = profileForDirectory(startupCwd);
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

  function enterFailedConfiguration({
    ctx,
    reason,
    pendingTransition,
    notify = true,
  }: {
    readonly ctx: ExtensionContext;
    readonly reason: string;
    readonly pendingTransition?: {
      readonly revision: string;
      readonly profile: ProfileName;
    };
    readonly notify?: boolean;
  }): void {
    // Publish fail-closed state before any best-effort cleanup can await or
    // reject. No guarded caller may observe a newly adopted policy paired with
    // a lifecycle whose disposal/initialization did not complete.
    policyConfig = genericPolicyConfig;
    rawProfileConfig = undefined;
    profileConfigRevision = undefined;
    directoryGlobDeclarations = [];
    activeProfile = genericPolicyConfig.defaultProfile;
    delete process.env[activeProfileEnvKey];
    profileConfigErrorReason = reason;
    pendingSandboxTransition = pendingTransition;
    ctx.ui.setStatus("sandbox", "sandbox: blocked (invalid permissions)");
    ctx.ui.setStatus("permissions", "invalid-permissions");
    if (notify && ctx.hasUI) ctx.ui.notify(reason, "error");
  }

  async function adoptFailedConfiguration({
    ctx,
    state,
  }: {
    readonly ctx: ExtensionContext;
    readonly state: ProfileStoreState;
  }): Promise<void> {
    enterFailedConfiguration({
      ctx,
      reason: profileStoreFailureReason({ state }),
    });
    // Validation failures must not turn the typed fail-closed result into a
    // rejected handler merely because stale sandbox cleanup also failed.
    try {
      await clearSandboxCaches();
    } catch {
      // The configuration state above is already fail closed.
    }
  }

  type RefreshSelectionIntent =
    | { readonly kind: "preserve-current" }
    | {
        readonly kind: "post-save";
        readonly intended: ProfileName;
        readonly message: (profile: ProfileName) => string;
      };
  type RefreshProfileResult =
    | {
        readonly kind: "adopted";
        readonly profile: ProfileName;
        readonly changed: boolean;
      }
    | { readonly kind: "failed" };

  /**
   * Queue a refresh so adoption and its sandbox-cache transition are one
   * coherent operation from the perspective of guarded callers.
   */
  function refreshProfileIfChanged({
    ctx,
    selectionIntent,
  }: {
    readonly ctx: ExtensionContext;
    readonly selectionIntent: RefreshSelectionIntent;
  }): Promise<RefreshProfileResult> {
    // Calls that were already waiting behind a failed transition fail with it;
    // only an operation that begins after that queue drains may attempt the
    // explicit recovery transition.
    const allowPendingRecovery = profileRefreshesInFlight === 0;
    profileRefreshesInFlight++;
    const refresh = profileRefreshQueue.then(
      () =>
        refreshProfileIfChangedLocked({
          ctx,
          selectionIntent,
          allowPendingRecovery,
        }),
      () =>
        refreshProfileIfChangedLocked({
          ctx,
          selectionIntent,
          allowPendingRecovery,
        }),
    );
    profileRefreshQueue = refresh.then(
      () => undefined,
      () => undefined,
    );
    void refresh.then(
      () => {
        profileRefreshesInFlight--;
      },
      () => {
        profileRefreshesInFlight--;
      },
    );
    return refresh;
  }

  /** Refresh and atomically adopt one complete persisted policy snapshot. */
  async function refreshProfileIfChangedLocked({
    ctx,
    selectionIntent,
    allowPendingRecovery,
  }: {
    readonly ctx: ExtensionContext;
    readonly selectionIntent: RefreshSelectionIntent;
    readonly allowPendingRecovery: boolean;
  }): Promise<RefreshProfileResult> {
    guardOperationObserver?.onRefreshStarted?.({ toolName: "profile-refresh" });
    if (pendingSandboxTransition && !allowPendingRecovery)
      return { kind: "failed" };
    const previousRevision = profileConfigRevision;
    const previousProfile = activeProfile;
    const state = refreshProfileStore({ store: profileStore });
    const snapshot = profileStoreSnapshot({ state });
    if (!snapshot) {
      await adoptFailedConfiguration({ ctx, state });
      return { kind: "failed" };
    }

    // Resolve and validate authority using exactly this snapshot. No second
    // load occurs between selection and adoption, so revision N's selection
    // can never be combined with revision N+1's policy or declarations.
    if (
      subagentProfile &&
      !Object.hasOwn(snapshot.config.profiles, subagentProfile)
    ) {
      subagentProfileErrorReason =
        formatInvalidSubagentProfileReason(subagentProfile);
      await adoptFailedConfiguration({
        ctx,
        state: {
          status: profileStoreStatus.invalid,
          error: new Error(subagentProfileErrorReason),
        },
      });
      return { kind: "failed" };
    }
    // A durable save's selected user-owned profile takes precedence over
    // directory/session selection in precisely the snapshot it wrote. The
    // only stronger authority is a valid immutable subagent declaration.
    // Ordinary unchanged refreshes continue to preserve explicit selection.
    const selected =
      selectionIntent.kind === "post-save"
        ? (subagentProfile ?? selectionIntent.intended)
        : pendingSandboxTransition?.revision === snapshot.sourceRevision &&
            Object.hasOwn(
              snapshot.config.profiles,
              pendingSandboxTransition.profile,
            )
          ? pendingSandboxTransition.profile
          : state.status === profileStoreStatus.unchanged
            ? activeProfile
            : (subagentProfile ??
              matchDirectoryGlobs(
                startupCwd,
                snapshot.directoryGlobDeclarations,
              )?.profile ??
              persistedSessionProfile({ ctx }) ??
              snapshot.config.defaultProfile);
    if (!Object.hasOwn(snapshot.config.profiles, selected)) {
      await adoptFailedConfiguration({
        ctx,
        state: {
          status: profileStoreStatus.invalid,
          error: new Error(
            `Selected pi-guard profile '${selected}' no longer exists.`,
          ),
        },
      });
      return { kind: "failed" };
    }

    // Commit all configuration-derived state from the same snapshot before
    // publishing the selected profile to child-process environment.
    policyConfig = snapshot.config;
    rawProfileConfig = snapshot.raw;
    profileConfigRevision = snapshot.sourceRevision;
    directoryGlobDeclarations = snapshot.directoryGlobDeclarations;
    activeProfile = selected;
    process.env[activeProfileEnvKey] = activeProfile;
    profileConfigErrorReason = undefined;
    subagentProfileErrorReason = undefined;

    const changed =
      previousProfile !== activeProfile ||
      previousRevision !== profileConfigRevision;
    const needsLifecycleTransition =
      changed || pendingSandboxTransition !== undefined;
    try {
      if (
        selectionIntent.kind === "post-save" ||
        pendingSandboxTransition !== undefined
      )
        ensureReadToolsActive();
      if (needsLifecycleTransition) {
        await clearSandboxCaches();
        await refreshSandboxStatus(ctx);
        ctx.ui.setStatus("permissions", formatProfileStatus(activeProfile));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      enterFailedConfiguration({
        ctx,
        reason: message,
        pendingTransition: {
          revision: snapshot.sourceRevision,
          profile: selected,
        },
        notify: false,
      });
      return { kind: "failed" };
    }
    pendingSandboxTransition = undefined;
    if (selectionIntent.kind === "post-save") {
      pi.appendEntry(profileEntryType, {
        profile: activeProfile,
        timestamp: Date.now(),
      });
      ctx.ui.notify(selectionIntent.message(activeProfile), "info");
    }
    return { kind: "adopted", profile: activeProfile, changed };
  }

  async function refreshOrPreserveConfiguration({
    ctx,
    selectionIntent,
  }: {
    readonly ctx: ExtensionContext;
    readonly selectionIntent?: RefreshSelectionIntent;
  }): Promise<boolean> {
    const intent: RefreshSelectionIntent = selectionIntent ?? {
      kind: "preserve-current",
    };
    const result = await refreshProfileIfChanged({
      ctx,
      selectionIntent: intent,
    });
    return result.kind === "adopted";
  }

  async function refreshAfterPolicyUi({
    ctx,
    revision,
    profile,
  }: {
    readonly ctx: ExtensionContext;
    readonly revision: string | undefined;
    readonly profile: ProfileName;
  }): Promise<"unchanged" | "changed" | "failed"> {
    if (
      (
        await refreshProfileIfChanged({
          ctx,
          selectionIntent: { kind: "preserve-current" },
        })
      ).kind === "failed"
    )
      return "failed";
    return revision === profileConfigRevision && profile === activeProfile
      ? "unchanged"
      : "changed";
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
        `pi-guard requires pi's built-in read tools (${readToolNames.join(", ")}), but not registered: ${unregistered.join(", ")}. ` +
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
    if (!(await refreshOrPreserveConfiguration({ ctx }))) return;

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

  const shippedRuleSetDescriptions: Readonly<Record<string, string>> = {
    "ruleset:shell": "Standard shell command policy.",
    "ruleset:git": "Git inspection and mutation policy.",
    "ruleset:packageManagers": "Package manager command policy.",
    "ruleset:deps-mutations-guard": "Deny dependency mutations.",
    "ruleset:deps-mutations-allow": "Allow dependency mutations.",
    "ruleset:shell-guards": "Guard destructive shell operations.",
    "ruleset:path-guards": "Default read, write, and protected-path policy.",
    "ruleset:read-only-shell": "Read-only shell commands.",
    "ruleset:read-only-path": "Read-only filesystem paths.",
    "ruleset:git-commit": "Permit Git commits.",
    "ruleset:git-refs": "Permit Git reference changes.",
    "ruleset:test-run": "Permit test and build commands.",
    "ruleset:docs-write": "Permit documentation writes.",
    "ruleset:test-write-protection": "Protect test files from writes.",
  };

  const transformDescriptions = {
    "transform:deny-asks": "Turn every ask decision into deny.",
    "transform:allow-asks": "Turn every ask decision into allow.",
    "transform:ask-all": "Turn every allow decision into ask.",
    "transform:deny-all": "Turn every allow and ask decision into deny.",
  } as const satisfies Record<ProfileTransformName, string>;

  function compositionOptions({
    editingProfile,
  }: {
    readonly editingProfile?: string;
  }): readonly OrderedSelectionOption<string>[] {
    const profiles = profileNames()
      .filter((name) => name !== editingProfile)
      .map((name) => {
        const profile = activePolicy(name);
        return {
          value: name,
          description: profile.description ?? "Permissions profile.",
          emoji: profile.emoji ?? "🧩",
        };
      });
    const shipped = Object.keys(ruleSetRegistry).map((name) => ({
      value: name,
      description: shippedRuleSetDescriptions[name] ?? "Shipped rule set.",
      emoji: "🧩",
    }));
    const custom = Object.keys(rawProfileConfig?.rulesets ?? {}).map(
      (name) => ({
        value: `customruleset:${name}`,
        description: `Custom rule set: ${name}`,
        emoji: "🧩",
      }),
    );
    return [...profiles, ...shipped, ...custom];
  }

  function transformOptions(): readonly OrderedSelectionOption<ProfileTransformName>[] {
    return profileTransformNames.map((value) => ({
      value,
      description: transformDescriptions[value],
      emoji: "🔀",
    }));
  }

  function compositionSandboxBaseline({
    composition,
  }: {
    readonly composition: readonly string[];
  }): EffectiveSandboxAuthoring | SandboxConfigOverride {
    let sandbox: SandboxConfigOverride | false | undefined;
    for (const name of composition) {
      const candidate = isProfileName(name)
        ? activePolicy(name).sandbox
        : undefined;
      sandbox = composeSandboxDeclarations(sandbox, candidate);
    }
    return sandbox;
  }

  async function runProfileAuthoringCommand({
    mode,
    ctx,
  }: {
    readonly mode: "create" | "edit";
    readonly ctx: ExtensionContext;
  }): Promise<void> {
    if (!(await refreshOrPreserveConfiguration({ ctx }))) return;
    if (!ctx.hasUI) {
      ctx.ui.notify(
        `/profile-${mode === "create" ? "add" : "edit"} requires an interactive UI`,
        "error",
      );
      return;
    }
    const editableDefinition =
      mode === "edit" ? rawProfileConfig?.profiles[activeProfile] : undefined;
    if (mode === "edit" && editableDefinition === undefined) {
      ctx.ui.notify(
        `/profile-edit can only edit the active user-owned profile ('${activeProfile}' is not editable).`,
        "error",
      );
      return;
    }
    const initial =
      mode === "edit" && editableDefinition !== undefined
        ? createProfileEditDraft({
            name: activeProfile,
            definition: editableDefinition,
          })
        : createProfileAuthoringDraft({
            activeProfile,
            startupCwd,
            existingNames: new Set(
              Object.keys(rawProfileConfig?.profiles ?? {}),
            ),
          });
    const existingDirectories = editableDefinition?.directoryGlobs ?? [];
    // This revision is advanced after a conflict. The next explicit submit
    // therefore validates and commits the retained draft against the snapshot
    // the user is reviewing, rather than being permanently doomed by the
    // revision that opened the wizard.
    let authoringRevision = profileConfigRevision;
    const flow = createProfileAuthoringFlow({ ctx });
    try {
      await runProfileAuthoringWizard({
        ctx,
        flow,
        initial,
        startupCwd,
        compositionOptions: compositionOptions({
          editingProfile: mode === "edit" ? activeProfile : undefined,
        }),
        transformOptions: transformOptions(),
        resolvedParentSandbox: compositionSandboxBaseline,
        validateName: ({ name }) => {
          try {
            validateCustomProfileName({
              name,
              existingNames: new Set(
                Object.keys(rawProfileConfig?.profiles ?? {}),
              ),
              currentName: mode === "edit" ? activeProfile : undefined,
            });
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
          return undefined;
        },
        submit: async ({ draft }) => {
          if (
            draft.mode === "edit" &&
            subagentProfile === draft.originalName &&
            draft.name !== draft.originalName
          )
            return {
              status: "invalid",
              issues: [
                {
                  section: "general",
                  code: "invalid-name",
                  message: `Cannot rename '${draft.originalName}': authoritative PI_SUBAGENT_PROFILE still selects it. Update the parent or launcher and restart first.`,
                },
              ],
            };
          try {
            const prepared = validateProfileAuthoringCommit({
              fallback: genericPolicyConfig,
              configPath: profileConfigPath,
              expectedRevision: authoringRevision,
              draft,
            });
            const candidate =
              prepared.resolvedConfig.profiles[prepared.profile];
            if (!candidate)
              throw new Error(
                `Profile '${prepared.profile}' was prepared but could not be resolved.`,
              );
            const security = summarizeSandboxSecurityExpansion({
              current: activePolicy(activeProfile).sandbox,
              candidate: candidate.sandbox,
            });
            if (security.unsafe) {
              const confirmed = await flow.confirm({
                title: metadataConfirmationTitle({ kind: "sandbox" }),
                message: security.warnings.join("\n"),
              });
              if (isProfileAuthoringAbort(confirmed))
                return { status: "retry" };
              if (!confirmed) return { status: "retry" };
            }
            const candidateDirectories = draft.definition.directoryGlobs ?? [];
            const broad =
              draft.mode === "create"
                ? candidateDirectories.length > 0
                : isConservativelyBroadDirectoryActivation({
                    candidate: candidateDirectories,
                    existing: existingDirectories,
                  });
            if (broad) {
              const confirmed = await flow.confirm({
                title: metadataConfirmationTitle({
                  kind: "directoryGlobs",
                }),
                message:
                  draft.mode === "create"
                    ? `This profile can activate automatically for the configured ${metadataSectionPresentation.directoryGlobs.label}.`
                    : `${metadataSectionPresentation.directoryGlobs.label} activation is broader than its existing declaration.`,
              });
              if (isProfileAuthoringAbort(confirmed))
                return { status: "retry" };
              if (!confirmed) return { status: "retry" };
            }
            if (flow.signal.aborted) return { status: "retry" };
            try {
              applyProfileAuthoringCommit({
                fallback: genericPolicyConfig,
                configPath: profileConfigPath,
                expectedRevision: authoringRevision,
                draft,
              });
            } catch (error) {
              if (!(error instanceof ProfileConfigLockTimeoutError))
                throw error;
              const confirmed = await flow.confirm({
                title: "Force write profile?",
                message: `The profile save is blocked by ${error.lockPath}. Force write compares the timed-out lock first, but a concurrent release and replacement can still cause it to delete a successor lock. A live save may still commit after this action and may later release a successor lock. Force write is an emergency destructive action, not safe serialization. The save will reload and revalidate the revision you reviewed, so it will not overwrite a revision conflict.`,
              });
              if (isProfileAuthoringAbort(confirmed) || !confirmed)
                return { status: "retry" };
              const result = forceRemoveProfileConfigLock({
                configPath: error.configPath,
                observedLockIdentity: error.observedLockIdentity,
              });
              if (result !== "removed") {
                ctx.ui.notify(
                  result === "already-released"
                    ? "The blocking lock was already released; retry the save normally."
                    : "The blocking lock changed; it was not removed. Retry normally.",
                  "info",
                );
                return { status: "retry" };
              }
              // Reacquire normally and prepare from a fresh source. In particular,
              // retain the reviewed revision rather than bypassing conflict checks.
              applyProfileAuthoringCommit({
                fallback: genericPolicyConfig,
                configPath: profileConfigPath,
                expectedRevision: authoringRevision,
                draft,
              });
            }
            try {
              if (
                !(await refreshOrPreserveConfiguration({
                  ctx,
                  selectionIntent: {
                    kind: "post-save",
                    intended: draft.name,
                    message: (profile) =>
                      `${draft.mode === "create" ? "Created and activated" : "Updated"} profile: ${profile}`,
                  },
                }))
              )
                throw new Error(configurationErrorReason());
            } catch (error) {
              ctx.ui.notify(
                postSaveActivationFailureMessage({
                  profile: draft.name,
                  error,
                }),
                "error",
              );
            }
            return { status: "saved" };
          } catch (error) {
            if (error instanceof ProfileConfigConflictError) {
              if (await refreshOrPreserveConfiguration({ ctx })) {
                // Keep the user's draft, but make the next overview/submit a
                // review of the newly adopted source generation.
                authoringRevision = profileConfigRevision;
              }
              return { status: "retry" };
            }
            if (error instanceof ProfileAuthoringValidationError)
              return { status: "invalid", issues: error.issues };
            throw error;
          }
        },
      });
    } finally {
      flow.dispose();
    }
  }

  type PendingRuleChangeDraft =
    | {
        kind: "bash";
        pattern: string;
        replacePattern?: string;
        requestedValue?: string;
        matchedRule?: string;
        matchedPattern?: string;
      }
    | {
        kind: "read" | "write";
        pattern: string;
        contexts?: readonly PathContext[];
        replacePattern?: string;
        requestedValue?: string;
        source?: string;
        matchedRule?: string;
        matchedPattern?: string;
      };

  async function rememberDecisions({
    drafts,
    ctx,
  }: {
    readonly drafts: ReadonlyArray<{
      readonly draft: PendingRuleChangeDraft;
      readonly decision: "allow" | "deny";
      readonly guidance?: string;
    }>;
    readonly ctx: ExtensionContext;
  }): Promise<boolean> {
    const profile = activeProfile;
    try {
      // Persistent decisions may change only the active user-owned source
      // profile. Authoritative built-ins and composed profiles cannot create
      // ineffective children which would immediately lose profile selection.
      const userOwned = Object.hasOwn(
        rawProfileConfig?.profiles ?? {},
        profile,
      );
      if (!userOwned) {
        ctx.ui.notify(
          `Cannot save a permission decision: active profile '${profile}' is not user-owned. Switch to or edit a user-owned profile first.`,
          "error",
        );
        return false;
      }
      const target: ProfileMutationTarget = { mode: "update", profile };

      // The active user-owned profile and its rules are one mutation, so a
      // failed write cannot leave a partial durable permission update behind.
      applyProfileRuleChanges({
        fallback: genericPolicyConfig,
        configPath: profileConfigPath,
        expectedRevision: profileConfigRevision,
        target,
        changes: drafts.map(({ draft, decision, guidance }) =>
          draft.kind === "bash"
            ? {
                kind: draft.kind,
                pattern: draft.pattern,
                replacePattern: draft.replacePattern,
                decision,
                guidance,
              }
            : {
                kind: draft.kind,
                pattern: draft.pattern,
                replacePattern: draft.replacePattern,
                decision,
                guidance,
                contexts: draft.contexts,
              },
        ),
      });
      const effectCounts = new Map<string, number>();
      for (const { draft, decision } of drafts) {
        const layer =
          draft.kind === "bash"
            ? "Bash"
            : draft.kind === "read"
              ? "read-path"
              : "write-path";
        const effect = `${layer} ${decision}`;
        effectCounts.set(effect, (effectCounts.get(effect) ?? 0) + 1);
      }
      const effects = [...effectCounts]
        .map(([effect, count]) => `${count} ${effect}`)
        .join(", ");
      if (
        !(await refreshOrPreserveConfiguration({
          ctx,
          selectionIntent: {
            kind: "post-save",
            intended: profile,
            message: (selectedProfile) =>
              `Saved ${effects} to ${selectedProfile}.`,
          },
        }))
      )
        return false;
      return true;
    } catch (error) {
      if (error instanceof ProfileConfigConflictError)
        await refreshOrPreserveConfiguration({ ctx });
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
      return false;
    }
  }

  function rememberRule({
    draft,
    ctx,
    pathTraces = [],
  }: {
    readonly draft: PendingRuleChangeDraft;
    readonly ctx: ExtensionContext;
    readonly pathTraces?: readonly BashPathReferenceTrace[];
  }): RememberDecision {
    let retainedRows: EditableRuleRow[] | undefined;
    let pruneRetainedOnNextInvocation = false;
    return async ({ patterns, pathTraces: suppliedPathTraces }) => {
      if (!Object.hasOwn(rawProfileConfig?.profiles ?? {}, activeProfile)) {
        ctx.ui.notify(
          `Cannot save a permission decision: active profile '${activeProfile}' is not user-owned. Switch to a user-owned profile first.`,
          "error",
        );
        return { approved: false, handledRejection: true };
      }
      const traces = suppliedPathTraces ?? pathTraces;
      const candidates: AskRuleCandidate[] = [];
      const seen = new Set<string>();
      // Enforcement evaluates ordinary path policy before command policy, so
      // retain that same stable ordering in the combined change set.
      for (const trace of traces) {
        if (trace.decision !== "ask") continue;
        const identity = `${trace.kind}\0${trace.context}\0${trace.path}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        candidates.push({
          kind: trace.kind,
          context: trace.context,
          requestedValue: trace.path,
          initialPattern: displayPath(trace.path, startupCwd),
          currentDecision: "ask",
          matchedRule: trace.pathMatches[0]
            ? `${trace.pathMatches[0].item.pattern} → ${trace.pathMatches[0].item.decision}`
            : undefined,
          matchedPattern: trace.pathMatches[0]?.item.pattern,
          source: { tool: "bash", role: `${trace.context} path reference` },
        });
      }
      for (const pattern of patterns ??
        (draft.kind === "bash" ? [draft.pattern] : [])) {
        const identity = `bash\0${pattern}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        candidates.push({
          kind: "bash",
          requestedValue: pattern,
          initialPattern: pattern,
          currentDecision: "ask",
        });
      }
      if (candidates.length === 0) {
        const kind = draft.kind;
        candidates.push(
          kind === "bash"
            ? {
                kind,
                requestedValue: draft.requestedValue ?? draft.pattern,
                initialPattern: draft.pattern,
                currentDecision: "ask",
                matchedRule: draft.matchedRule,
                matchedPattern: draft.matchedPattern,
              }
            : {
                kind,
                context:
                  draft.contexts?.[0] ?? (kind === "read" ? "read" : "write"),
                requestedValue: draft.requestedValue ?? draft.pattern,
                initialPattern: draft.pattern,
                currentDecision: "ask",
                matchedRule: draft.matchedRule,
                matchedPattern: draft.matchedPattern,
                source: { tool: draft.source ?? kind },
              },
        );
      }
      const userOwned = Object.hasOwn(
        rawProfileConfig?.profiles ?? {},
        activeProfile,
      );
      if (!userOwned) {
        ctx.ui.notify(
          `Cannot save a permission decision: active profile '${activeProfile}' is not user-owned. Switch to a user-owned profile first.`,
          "error",
        );
        return { approved: false };
      }
      const candidateIdentity = (candidate: AskRuleCandidate): string =>
        `${candidate.kind}\0${candidate.kind === "bash" ? "" : candidate.context}\0${candidate.requestedValue}`;
      const rows: EditableRuleRow[] = candidates.map((candidate, index) => ({
        id: `ask-rule-${index}`,
        kind: candidate.kind,
        pattern: candidate.initialPattern,
        decision: "allow",
        contexts: candidate.kind === "bash" ? undefined : [candidate.context],
        request: candidate,
        origin: "request",
      }));
      if (retainedRows && pruneRetainedOnNextInvocation) {
        retainedRows = rows.map((row) => {
          const retained = retainedRows?.find(
            (prior) =>
              prior.request &&
              row.request &&
              candidateIdentity(prior.request) ===
                candidateIdentity(row.request),
          );
          return retained ? { ...retained, request: row.request } : row;
        });
        pruneRetainedOnNextInvocation = false;
      }
      while (true) {
        const editorRevision = profileConfigRevision;
        const editorProfile = activeProfile;
        if (
          (await refreshAfterPolicyUi({
            ctx,
            revision: editorRevision,
            profile: editorProfile,
          })) !== "unchanged"
        )
          return { approved: false, stale: true };
        const edited = await editProfileRuleRows({
          ctx,
          options: {
            mode: "ask",
            title: `Resolve ASK · ${rows.length} profile change${rows.length === 1 ? "" : "s"}`,
            rows: retainedRows ?? rows,
            allowAddRemove: true,
            defaultKind: rows[0]?.kind,
            defaultDecision: "deny",
          },
        });
        retainedRows = edited.rows;
        const editorRefresh = await refreshAfterPolicyUi({
          ctx,
          revision: editorRevision,
          profile: editorProfile,
        });
        if (editorRefresh !== "unchanged") {
          // This callback can survive the outer operation restart. Do not let
          // an edit derived from the old revision reappear if the replacement
          // policy also evaluates this operation to ASK.
          retainedRows = undefined;
          pruneRetainedOnNextInvocation = false;
          ctx.ui.notify(
            "Profile was updated while the rule editor was open; stale edits were discarded.",
            "warning",
          );
          return {
            approved: false,
            stale: true,
            refreshFailed: editorRefresh === "failed",
          };
        }
        if (edited.action === "back") return { approved: false, back: true };
        const selected = edited.rows.filter(
          (row) =>
            row.kind !== "protected" &&
            row.decision !== "skip" &&
            row.pattern.trim().length > 0,
        );
        if (selected.length === 0) return { approved: false, back: true };
        const saved = await rememberDecisions({
          drafts: selected.map((row) => ({
            draft: pendingDraftFromEditableRow({ row }),
            decision: row.decision === "deny" ? "deny" : "allow",
            guidance: row.decision === "deny" ? row.guidance : undefined,
          })),
          ctx,
        });
        if (!saved) return { approved: false, stale: true };
        // A post-save re-check must rebuild from enforcement's remaining ASK
        // candidates. Preserve edits only for request rows explicitly skipped;
        // resolved and additional rows must not leak into the next prompt.
        retainedRows = edited.rows.filter(
          (row) => row.request && row.decision === "skip",
        );
        pruneRetainedOnNextInvocation = true;
        return {
          approved: selected.every((row) => row.decision === "allow"),
          profileUpdated: true,
          handledRejection: selected.some((row) => row.decision === "deny"),
        };
      }
    };
  }

  function pendingDraftFromEditableRow({
    row,
  }: {
    readonly row: EditableRuleRow;
  }): PendingRuleChangeDraft {
    const replacePattern =
      row.origin === "request"
        ? (row.request?.matchedPattern ?? row.request?.initialPattern)
        : undefined;
    if (row.kind === "bash")
      return { kind: "bash", pattern: row.pattern, replacePattern };
    if (row.kind === "read" || row.kind === "write") {
      return {
        kind: row.kind,
        pattern: row.pattern,
        contexts: row.contexts,
        replacePattern,
      };
    }
    throw new Error("A protected path rule cannot be persisted from an ASK.");
  }

  pi.registerCommand("profile-add", {
    description: "Create and activate a custom permissions profile",
    handler: async (_args, ctx) =>
      await runProfileAuthoringCommand({ mode: "create", ctx }),
  });
  pi.registerCommand("profile-edit", {
    description: "Edit raw declarations on the active custom profile",
    handler: async (_args, ctx) =>
      await runProfileAuthoringCommand({ mode: "edit", ctx }),
  });

  pi.registerCommand("profile", {
    description: "Show or switch the active permissions profile",
    getArgumentCompletions: (prefix) =>
      freshProfileNames()
        .filter((profile) => profile.startsWith(prefix))
        .map((profile) => ({
          value: profile,
          label: profile,
          description: profile === activeProfile ? "active" : undefined,
        })),
    handler: async (args, ctx) => {
      if (!(await refreshOrPreserveConfiguration({ ctx }))) return;
      const requested = args.trim();

      if (!requested) {
        await showProfilePicker({ ctx });
        return;
      }

      if (!isProfileName(requested)) {
        ctx.ui.notify(
          `Unknown profile '${requested}'. Available: ${profileNames().join(", ")}`,
          "error",
        );
        return;
      }

      await activateProfile({
        profile: requested,
        ctx,
        message: `Switched to profile: ${requested}`,
      });
    },
  });

  // Ctrl+G opens Pi's external editor, Ctrl+Shift+G navigates fullscreen
  // transcript search results, and Ctrl+Shift+P cycles models. Alt+G remains
  // available where the terminal reports Option as Meta; Ctrl+Shift+I is the
  // macOS-safe fallback that leaves Pi's defaults intact.
  const showProfiles = async (ctx: ExtensionContext): Promise<void> => {
    if (!(await refreshOrPreserveConfiguration({ ctx }))) return;
    await showProfilePicker({ ctx });
  };
  for (const shortcut of [Key.alt("g"), "ctrl+shift+i"] as const) {
    pi.registerShortcut(shortcut, {
      description: "Search and switch permissions profiles",
      handler: showProfiles,
    });
  }

  /** Run a no-argument slash command through Pi's ordinary command dispatcher. */
  const runCommandShortcut = (command: string) => () => {
    pi.sendUserMessage(`/${command}`);
  };

  pi.registerShortcut("ctrl+shift+a", {
    description: "Create and activate a custom permissions profile",
    handler: runCommandShortcut("profile-add"),
  });

  pi.registerCommand("read-only", {
    description: "Switch to the read-only permissions profile",
    handler: async (_args, ctx) => {
      if (!(await refreshOrPreserveConfiguration({ ctx }))) return;
      const readOnlyName = "builtin:read-only";
      if (!policyConfig.profiles[readOnlyName]) {
        ctx.ui.notify("No 'builtin:read-only' profile is configured", "error");
        return;
      }

      await activateProfile({
        profile: readOnlyName,
        ctx,
        message: "Read-only profile enabled",
      });
    },
  });

  async function setSandboxOverride(
    override: SandboxOverride,
    ctx: ExtensionContext,
    message: string,
  ): Promise<void> {
    sandboxOverride = override;
    pi.appendEntry(sandboxEntryType, { override, timestamp: Date.now() });
    await clearSandboxCaches();
    await refreshSandboxStatus(ctx);
    ctx.ui.notify(message, "info");
  }

  pi.registerCommand("sandbox-on", {
    description: "Use the active profile's Bash sandbox configuration",
    handler: async (_args, ctx) => {
      if (!(await refreshOrPreserveConfiguration({ ctx }))) return;
      await setSandboxOverride(
        "inherit",
        ctx,
        "Bash sandboxing now follows the active profile 🔐",
      );
    },
  });

  pi.registerCommand("sandbox-off", {
    description: "Disable Bash sandboxing for this session",
    handler: async (_args, ctx) => {
      if (!(await refreshOrPreserveConfiguration({ ctx }))) return;
      await setSandboxOverride("disabled", ctx, "Bash sandboxing disabled ❌");
    },
  });

  pi.registerCommand("sandbox-on-force", {
    description: "Force a no-network Bash sandbox for this session",
    handler: async (_args, ctx) => {
      if (!(await refreshOrPreserveConfiguration({ ctx }))) return;
      await setSandboxOverride(
        "enabled",
        ctx,
        "Bash sandboxing forced on with network denied 🔐",
      );
    },
  });

  pi.registerCommand("sandbox", {
    description: "Show the active sandbox posture",
    handler: async (_args, ctx) => {
      if (!(await refreshOrPreserveConfiguration({ ctx }))) return;
      const resolution = await resolveActiveSandbox(ctx.cwd ?? startupCwd);

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
    description: `${packageBashTool.description}${packageBashOwnershipMarker}`,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!(await refreshOrPreserveConfiguration({ ctx }))) {
        return sandboxUnavailableResult(
          configurationErrorReason() ?? "Invalid permissions",
        );
      }
      const resolution = await resolveActiveSandbox(ctx.cwd ?? startupCwd);

      if (resolution.kind === "none") {
        return await executeBashWithExitCode({
          execute: () =>
            createBashTool(ctx.cwd ?? startupCwd).execute(
              toolCallId,
              params,
              signal,
              onUpdate,
            ),
        });
      }

      if (resolution.kind === "unavailable") {
        if (resolution.onUnavailable === "warn") {
          if (ctx.hasUI) {
            ctx.ui.notify(resolution.reason, "warning");
          }
          return await executeBashWithExitCode({
            execute: () =>
              createBashTool(ctx.cwd ?? startupCwd).execute(
                toolCallId,
                params,
                signal,
                onUpdate,
              ),
          });
        }

        return sandboxUnavailableResult(resolution.reason);
      }

      ensureBashToolOwnership();
      const sandboxedBash = createBashTool(ctx.cwd ?? startupCwd, {
        operations: resolution.prepared.operations,
      });
      return await executeBashWithExitCode({
        execute: () =>
          sandboxedBash.execute(toolCallId, params, signal, onUpdate),
      });
    },
  });
  pi.registerShortcut("ctrl+shift+b", {
    description: "Show the active sandbox posture",
    handler: runCommandShortcut("sandbox"),
  });
  pi.registerShortcut("ctrl+shift+n", {
    description: "Use the active profile's Bash sandbox configuration",
    handler: runCommandShortcut("sandbox-on"),
  });
  pi.registerShortcut("ctrl+shift+d", {
    description: "Disable Bash sandboxing for this session",
    handler: runCommandShortcut("sandbox-off"),
  });
  pi.registerShortcut("ctrl+shift+x", {
    description: "Force a no-network Bash sandbox for this session",
    handler: runCommandShortcut("sandbox-on-force"),
  });

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
      if (!(await refreshOrPreserveConfiguration({ ctx }))) return;

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
      const explanation = explainPermission({
        policy,
        profileName: activeProfile,
        tool,
        input: evaluatedInput,
        cwd,
        startupCwd,
        rawConfig: rawProfileConfig,
      });
      ctx.ui.notify(formatExplanation(explanation), "info");
    },
  });

  pi.registerShortcut("ctrl+shift+e", {
    description: "Start a permission-decision explanation",
    handler: (ctx) => {
      ctx.ui.setEditorText("/permissions explain ");
      ctx.ui.notify(
        "Specify a tool and input, then submit the command.",
        "info",
      );
    },
  });

  pi.registerCommand("socrates", {
    description: "Switch to the Socrates coaching profile",
    handler: async (_args, ctx) => {
      if (!(await refreshOrPreserveConfiguration({ ctx }))) return;
      if (!policyConfig.profiles.socrates) {
        ctx.ui.notify("No 'socrates' profile is configured", "error");
        return;
      }

      await activateProfile({
        profile: "socrates",
        ctx,
        message: "Socrates profile enabled",
      });
    },
  });

  pi.registerCommand("socrates-off", {
    description: "Switch back to the configured default permissions profile",
    handler: async (_args, ctx) => {
      if (!(await refreshOrPreserveConfiguration({ ctx }))) return;
      await activateProfile({
        profile: policyConfig.defaultProfile,
        ctx,
        message: `Socrates profile disabled; active profile: ${policyConfig.defaultProfile}`,
      });
    },
  });

  pi.registerShortcut("ctrl+shift+c", {
    description: "Switch to the Socrates coaching profile",
    handler: runCommandShortcut("socrates"),
  });
  pi.registerShortcut("ctrl+shift+z", {
    description: "Switch back to the configured default permissions profile",
    handler: runCommandShortcut("socrates-off"),
  });
  pi.registerShortcut("ctrl+shift+r", {
    description: "Switch to the read-only permissions profile",
    handler: runCommandShortcut("read-only"),
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!(await refreshOrPreserveConfiguration({ ctx }))) return undefined;
    const policy = activePolicy(activeProfile);
    const promptSections = [`# Active profile: ${activeProfile}`];
    const resolution = await resolveActiveSandbox(ctx.cwd ?? startupCwd);

    if (resolution.kind === "none") {
      promptSections.push("Bash sandboxing is disabled for this session.");
    } else if (resolution.kind === "active") {
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
      promptSections.push(
        readRuntimePromptFile({
          profile: activeProfile,
          declaredPath: policy.promptFile,
          allowPackageRelative: true,
          packageRoot: path.resolve(moduleDir, ".."),
        }),
      );
    }

    if (promptSections.length === 1) return undefined;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${promptSections.join("\n\n")}`,
    };
  });

  pi.on("user_bash", async (_event, ctx) => {
    if (!(await refreshOrPreserveConfiguration({ ctx }))) {
      const errorReason = configurationErrorReason() ?? "Invalid permissions";
      return {
        result: {
          output: errorReason,
          exitCode: 126,
          cancelled: false,
          truncated: false,
        },
      };
    }
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

    const resolution = await resolveActiveSandbox(ctx.cwd ?? startupCwd);

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
    // Never re-evaluate a rewritten command. Each stale result restarts the
    // complete boundary from the immutable tool input, including scope and
    // protected-search rewriting.
    const originalInput = structuredClone(event.input);
    // A current local save may intentionally leave another request row as ASK.
    // Preserve only that operation's local callback across its top-level retry;
    // external changes return stale before a callback result is accepted.
    let rememberedBashRule: RememberDecision | undefined;
    let rememberedPathRule: RememberDecision | undefined;
    for (let attempt = 0; attempt < maxOperationEvaluationAttempts; attempt++) {
      // Preserve Pi's original event input identity on the first evaluation;
      // only restarted attempts replace the rewritten value from our immutable
      // snapshot.
      if (attempt > 0) event.input = structuredClone(originalInput);
      const result = await (async () => {
        guardOperationObserver?.onRefreshRequested?.({
          toolName: event.toolName,
        });
        if (!(await refreshOrPreserveConfiguration({ ctx }))) {
          return {
            block: true,
            reason: configurationErrorReason() ?? "Invalid permissions",
          };
        }
        const errorReason = configurationErrorReason();
        if (errorReason) {
          return { block: true, reason: errorReason };
        }

        guardOperationObserver?.onEvaluationStarted?.({
          toolName: event.toolName,
        });
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
          const evaluatedRevision = profileConfigRevision;
          const evaluatedProfile = activeProfile;
          const gateResult = await gateBash({
            command: event.input.command,
            startupCwd: effectiveCwd,
            ctx,
            activePolicy: policy,
            remember: (rememberedBashRule ??= rememberRule({
              draft: { kind: "bash", pattern: event.input.command },
              ctx,
            })),
            refreshAfterUiAwait: () =>
              refreshAfterPolicyUi({
                ctx,
                revision: evaluatedRevision,
                profile: evaluatedProfile,
              }),
          });
          if (isRestartOperation(gateResult)) return gateResult;
          if (gateResult) return gateResult;

          const sandboxResolution = await resolveActiveSandbox(effectiveCwd);

          if (sandboxResolution.kind === "active" && !isBashToolOwned()) {
            return {
              block: true,
              reason:
                "pi-guard' bash override no longer owns the effective bash tool; sandboxed execution is blocked",
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
          const evaluatedRevision = profileConfigRevision;
          const evaluatedProfile = activeProfile;
          return await gateCustomTool({
            toolName: event.toolName,
            input: event.input,
            rules: customRules,
            ctx,
            refreshAfterUiAwait: () =>
              refreshAfterPolicyUi({
                ctx,
                revision: evaluatedRevision,
                profile: evaluatedProfile,
              }),
          });
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
          // Keep one editor callback for the complete pending request so Back,
          // failed writes, and partial-save rechecks share the same draft state.
          const pathRule = (rememberedPathRule ??= rememberRule({
            draft: {
              kind: isReadToolName(event.toolName) ? "read" : "write",
              pattern: displayPath(absolutePath, startupCwd),
              contexts: [event.toolName],
              requestedValue: absolutePath,
              source: `${event.toolName} tool`,
              matchedRule: policyDecision.trace?.pathMatches[0]
                ? `${policyDecision.trace.pathMatches[0].item.pattern} → ${policyDecision.trace.pathMatches[0].item.decision}`
                : undefined,
              matchedPattern:
                policyDecision.trace?.pathMatches[0]?.item.pattern,
            },
            ctx,
          }));
          const evaluatedRevision = profileConfigRevision;
          const evaluatedProfile = activeProfile;
          const refreshPathPrompt = () =>
            refreshAfterPolicyUi({
              ctx,
              revision: evaluatedRevision,
              profile: evaluatedProfile,
            });
          const approval = await confirmOrBlock({
            ctx,
            title: `${isReadToolName(event.toolName) ? "Read" : "Write"} path permission request`,
            message: `${event.toolName} wants to access:\n${absolutePath}\n\nMatched policy path:\n${matchPath}`,
            remember: pathRule,
            refreshAfterUiAwait: refreshPathPrompt,
          });
          if (approval.refreshFailed)
            return {
              block: true,
              reason: configurationErrorReason() ?? "Invalid permissions",
            };
          if (approval.stale) rememberedPathRule = undefined;
          if (approval.profileUpdated || approval.stale)
            return restartOperation();
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
      })();
      if (isRestartOperation(result)) continue;
      return markPermissionBlock(result);
    }
    return markPermissionBlock({
      block: true,
      reason:
        "pi-guard policy changed repeatedly while evaluating this operation; permission was not approved.",
    });
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
      readPaths: subagentPermissibleRules,
      writePaths: subagentPermissibleRules,
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
    readPaths: subagentPermissibleRules,
    writePaths: subagentPermissibleRules,
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
  pathTraces: readonly BashPathReferenceTrace[];
  nonAuthorableAsks: readonly string[];
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
  // Keep the decision's short-circuit semantics, but collect the complete
  // concrete trace separately for the request-level ASK editor. This avoids
  // re-analyzing (and potentially resolving relative paths differently) in
  // the UI callback.
  const allPathAnalysis = analyzeBashPathReferences(
    pathSegments,
    startupCwd,
    cwd,
    activePolicy,
    activePolicy.protectedPathRules ?? [],
    false,
  );
  const pathTraces = allPathAnalysis.traces;
  const nonAuthorableAsks = [
    ...new Set([
      ...pathAnalysis.nonAuthorableAsks,
      ...allPathAnalysis.nonAuthorableAsks,
    ]),
  ];

  return {
    parseErrors,
    commands,
    protectedPathDecision,
    readValidationError,
    pathDecision,
    pathTrace,
    pathTraces,
    nonAuthorableAsks,
    commandDecisions,
  };
}

export async function gateBash({
  command,
  startupCwd,
  ctx,
  activePolicy = defaultPolicy,
  remember,
  refreshAfterUiAwait,
}: {
  readonly command: string;
  readonly startupCwd: string;
  readonly ctx: ExtensionContext;
  readonly activePolicy?: ProfilePolicy;
  readonly remember?: RememberDecision;
  readonly refreshAfterUiAwait?: RefreshAfterUiAwait;
}) {
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
    commands,
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
  // Complete command denies before presenting any path ASK. A save flow must
  // never suggest that an unrelated path rule can override this deny.
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

  // Deterministic protected/ordinary/command denies above still win. Once
  // parse uncertainty remains, however, resolve the request exactly once as
  // non-authorable allow-once/deny instead of opening a second ASK prompt.
  if (parseErrors.length > 0) {
    const details = parseErrors
      .map((error) => `- offset ${error.pos}: ${error.message}`)
      .join("\n");
    const approval = await confirmOrBlock({
      ctx,
      title: "Allow Bash command with parse errors?",
      message: `The command could not be classified completely.\n\n${details}\n\nRaw command:\n${command}`,
      refreshAfterUiAwait,
    });
    if (approval.refreshFailed)
      return {
        block: true,
        reason:
          "pi-guard profile configuration became invalid while awaiting approval.",
      };
    if (approval.stale) return restartOperation();
    if (approval.approved) return undefined;
    return {
      block: true,
      reason: appendUserGuidance(
        `Bash command was not approved because it could not be classified completely,\n\n${details}`,
        approval.guidance,
      ),
    };
  }

  if (
    pathDecision?.decision === "ask" ||
    decisions.some(({ decision }) => decision === "ask")
  ) {
    const askPaths = evaluation.pathTraces.filter(
      (trace) => trace.decision === "ask",
    );
    const hasNonAuthorableAsk = evaluation.nonAuthorableAsks.length > 0;
    const approval = await confirmOrBlock({
      ctx,
      title: "Bash permission request",
      message: `Raw command:\n${command}\n\nParsed command segments:\n${formatParsedCommands(command, activePolicy)}${
        askPaths.length > 0
          ? `\n\nGated paths:\n${askPaths
              .map(
                (trace) =>
                  `- ${trace.kind} path · context ${trace.context}: ${trace.path}\n  Matched: ${trace.matchPath}`,
              )
              .join("\n")}`
          : ""
      }${
        hasNonAuthorableAsk
          ? `\n\nNon-authorable path uncertainty:\n${evaluation.nonAuthorableAsks.join("\n")}`
          : ""
      }`,
      remember:
        parseErrors.length === 0 &&
        remember &&
        // Any unresolved opaque/dynamic path is required for this request but
        // cannot be represented truthfully as a durable rule.
        !hasNonAuthorableAsk &&
        (decisions.some(({ decision }) => decision === "ask") ||
          askPaths.length > 0)
          ? () =>
              remember({
                patterns: commands.filter(
                  (_item, index) => decisions[index]?.decision === "ask",
                ),
                pathTraces: askPaths,
              })
          : undefined,
      refreshAfterUiAwait,
    });
    if (approval.refreshFailed)
      return {
        block: true,
        reason:
          "pi-guard profile configuration became invalid while awaiting approval.",
      };
    if (approval.profileUpdated || approval.stale) return restartOperation();
    if (!approval.approved)
      return {
        block: true,
        reason: appendUserGuidance(
          pathDecision?.decision === "ask"
            ? `Bash path reference was not approved: ${pathDecision.path}`
            : `Command was not approved: ${command}`,
          approval.guidance,
        ),
      };
    return undefined;
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
    const approval = await confirmOrBlock({
      ctx,
      title: "Allow bash command?",
      message: `Raw command:\n${command}\n\nParsed command segments:\n${formatParsedCommands(command, activePolicy)}`,
      remember:
        parseErrors.length === 0 && remember
          ? () =>
              remember({
                patterns: commands.filter(
                  (_item, index) => decisions[index]?.decision === "ask",
                ),
                pathTraces: evaluation.pathTraces,
              })
          : undefined,
      refreshAfterUiAwait,
    });
    if (approval.refreshFailed)
      return {
        block: true,
        reason:
          "pi-guard profile configuration became invalid while awaiting approval.",
      };
    if (approval.profileUpdated || approval.stale) return restartOperation();
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

export function explainPermission({
  policy,
  profileName,
  tool,
  input,
  cwd = process.cwd(),
  startupCwd = cwd,
  rawConfig,
}: {
  readonly policy: ProfilePolicy;
  readonly profileName: string;
  readonly tool: string;
  readonly input: string;
  readonly cwd?: string;
  readonly startupCwd?: string;
  readonly rawConfig?: RawProfileConfig;
}): PermissionExplanation {
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
    const context: PathContext = isReadToolName(tool) ? tool : tool;
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
  const definitions = rawConfig?.profiles ?? loadRawProfileConfig({})?.profiles;
  const resolving = new Set<string>();

  const resolve = (name: string): string[] => {
    const builtinChain = builtinCompositionChains[name];
    if (builtinChain) return [...builtinChain];
    if (isCompositionFragmentName({ name })) {
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

async function gateCustomTool({
  toolName,
  input,
  rules,
  ctx,
  refreshAfterUiAwait,
}: {
  readonly toolName: string;
  readonly input: unknown;
  readonly rules: CustomToolRule[];
  readonly ctx: ExtensionContext;
  readonly refreshAfterUiAwait?: RefreshAfterUiAwait;
}) {
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
    const approval = await confirmOrBlock({
      ctx,
      title: `Allow ${toolName}?`,
      message: `${toolName} matched a custom tool policy requiring confirmation.`,
      refreshAfterUiAwait,
    });
    if (approval.refreshFailed) {
      return {
        block: true,
        reason:
          "pi-guard profile configuration became invalid while awaiting approval.",
      };
    }
    if (approval.stale) return restartOperation();
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

async function confirmOrBlock({
  ctx,
  title,
  message: _message,
  remember,
  refreshAfterUiAwait,
}: {
  readonly ctx: ExtensionContext;
  readonly title: string;
  readonly message: string;
  readonly remember?: RememberDecision;
  readonly refreshAfterUiAwait?: RefreshAfterUiAwait;
}): Promise<Approval> {
  if (!ctx.hasUI) return { approved: false };
  // A refresh immediately before display closes the gap between evaluation and
  // modal creation. The same baseline is checked again after every await.
  const beforeDisplay = refreshAfterUiAwait
    ? await refreshAfterUiAwait()
    : "unchanged";
  if (beforeDisplay === "failed")
    return { approved: false, stale: true, refreshFailed: true };
  if (beforeDisplay === "changed") return { approved: false, stale: true };

  // Permission prompts are shown while the agent is otherwise "working".
  // For large ask messages, the animated Working row can force repeated
  // full-screen redraws under the modal, which looks like flicker. Suspend it
  // while waiting for the user's decision, then restore the normal row.
  const setWorkingVisible = ctx.ui.setWorkingVisible?.bind(ctx.ui);
  setWorkingVisible?.(false);
  try {
    const [noChoice, yesChoice, updateProfileChoice] = askPermissionChoices;
    const isBashRequest = /bash/i.test(title);
    const isReadRequest = /read|grep|find|ls/i.test(title);
    const askChoices: ProfilePickerItem[] = [
      {
        name: noChoice,
        description: "Reject this request.",
        emoji: "⛔️",
        color: "red",
      },
      {
        name: yesChoice,
        description: "Allow this request once without changing the profile.",
        emoji: "✅",
        color: "green",
      },
      ...(remember
        ? [
            {
              name: updateProfileChoice,
              description: isBashRequest
                ? "Save the required Bash and ordinary path rule(s) for this request."
                : isReadRequest
                  ? "Save a read-path rule for this request."
                  : "Save a write-path rule for this request.",
              emoji: "📝",
              color: "magenta",
            } satisfies ProfilePickerItem,
          ]
        : []),
    ];
    // Unlike a binary confirm, select() has no separate message parameter.
    // Keep the complete request report in the modal title so users can see
    // the raw command plus its parsed allow/deny/ask breakdown before acting.
    const modalTitle = `${title}\n\n${_message}`;
    const choice = await ctx.ui.custom<string | null>(
      (tui, theme, _keys, done) => {
        const picker = new ProfilePicker(askChoices, theme, done, () =>
          done(null),
        );
        return {
          get focused() {
            return picker.focused;
          },
          set focused(value: boolean) {
            picker.focused = value;
          },
          render: (width) =>
            [
              theme.fg(
                isBashRequest ? "accent" : "warning",
                theme.bold(
                  `${
                    isBashRequest
                      ? "⚙️ Bash command"
                      : isReadRequest
                        ? "📖 Read path"
                        : "✏️ Write path"
                  } permission request`,
                ),
              ),
              ...modalTitle.split("\n").map((line) => theme.fg("dim", line)),
              ...picker.render(width),
            ].map((line) => truncateToWidth(line, width)),
          invalidate: () => picker.invalidate(),
          handleInput: (data) => {
            picker.handleInput(data);
            tui.requestRender();
          },
        };
      },
    );
    const refreshResult = refreshAfterUiAwait
      ? await refreshAfterUiAwait()
      : "unchanged";
    if (refreshResult === "failed")
      return { approved: false, stale: true, refreshFailed: true };
    if (refreshResult === "changed") {
      ctx.ui.notify(
        "Profile was updated while this permission request was open; its rule took precedence. Re-evaluating the request.",
        "warning",
      );
      return { approved: false, stale: true };
    }
    if (choice === yesChoice) return { approved: true };
    if (choice === updateProfileChoice && remember) {
      const result = await remember({});
      if (result.back)
        return await confirmOrBlock({
          ctx,
          title,
          message: _message,
          remember,
          refreshAfterUiAwait,
        });
      if (result.approved || result.handledRejection || result.profileUpdated)
        return result;
      const guidance = await collectDenialGuidance({
        ctx,
        refreshAfterUiAwait,
      });
      if (guidance.stale || guidance.refreshFailed) return guidance;
      return { ...result, guidance: guidance.guidance };
    }

    const guidance = await collectDenialGuidance({
      ctx,
      refreshAfterUiAwait,
    });
    if (guidance.stale || guidance.refreshFailed) return guidance;
    return guidance.guidance
      ? { approved: false, guidance: guidance.guidance }
      : { approved: false };
  } finally {
    setWorkingVisible?.(true);
  }
}

async function collectDenialGuidance({
  ctx,
  refreshAfterUiAwait,
}: {
  readonly ctx: ExtensionContext;
  readonly refreshAfterUiAwait?: RefreshAfterUiAwait;
}): Promise<Approval> {
  return await collectGuidance({
    ctx,
    prompt:
      "Denied permission request — optional steering for the agent. Leave blank or press Esc to skip.",
    refreshAfterUiAwait,
  });
}

async function collectGuidance({
  ctx,
  prompt,
  refreshAfterUiAwait,
}: {
  readonly ctx: ExtensionContext;
  readonly prompt: string;
  readonly refreshAfterUiAwait?: RefreshAfterUiAwait;
}): Promise<Approval> {
  const beforeDisplay = refreshAfterUiAwait
    ? await refreshAfterUiAwait()
    : "unchanged";
  if (beforeDisplay === "failed")
    return { approved: false, stale: true, refreshFailed: true };
  if (beforeDisplay === "changed") return { approved: false, stale: true };
  const input =
    typeof ctx.ui.editor === "function"
      ? await ctx.ui.editor(prompt, "")
      : typeof ctx.ui.input === "function"
        ? await ctx.ui.input(prompt, "")
        : undefined;
  const afterInput = refreshAfterUiAwait
    ? await refreshAfterUiAwait()
    : "unchanged";
  if (afterInput === "failed")
    return { approved: false, stale: true, refreshFailed: true };
  if (afterInput === "changed") return { approved: false, stale: true };
  const guidance = input?.trim();
  return guidance ? { approved: false, guidance } : { approved: false };
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
