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
  decideBashPathReferences,
  displayPath,
  evaluatePathByPattern,
  expandHome,
  matchesGlobPattern,
  resolveRequestedPath,
} from "../modules/shell/pathPolicy";
import {
  injectGrepProtectedPathGlob,
  injectRipgrepProtectedPathGlobs,
  validateRipgrepGlobOverrides,
} from "../modules/shell/searchPolicy";
import { validateReadCommands } from "../modules/shell/readCommands";
import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  assertPolicyConfig,
  assertProfilePolicy,
  definePolicyConfig,
  extendProfile,
  withProtectedPathPatterns,
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
  loadProfileConfig,
  ProfileConfigLoadError,
} from "../modules/profileConfig";
import { policyConfig as genericPolicyConfig } from "../modules/policy";

export {
  assertPolicyConfig,
  assertProfilePolicy,
  definePolicyConfig,
  extendProfile,
  withProtectedPathPatterns,
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
  const profileConfigLoad: {
    config: PolicyConfig;
    error?: ProfileConfigLoadError;
  } = (() => {
    try {
      return {
        config: loadProfileConfig(
          genericPolicyConfig,
          process.env.PI_PERMISSIONS_PROFILE_CONFIG?.trim() || undefined,
        ),
      };
    } catch (error) {
      if (error instanceof ProfileConfigLoadError) {
        return { config: genericPolicyConfig, error };
      }
      throw error;
    }
  })();

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
    return value in policyConfig.profiles;
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

  const startupCwd = path.resolve(process.cwd());
  const subagentProfile = process.env.PI_SUBAGENT_PROFILE?.trim();
  const subagentPermissibleRules = parseSubagentPermissibleRules(
    process.env.PI_SUBAGENT_PERMISSIBLE_GLOBS,
  );
  const profileConfigErrorReason = profileConfigLoad.error?.message;
  let subagentProfileErrorReason: string | undefined;
  let activeProfile: ProfileName = policyConfig.defaultProfile;
  const configurationErrorReason = () =>
    profileConfigErrorReason ?? subagentProfileErrorReason;

  function preserveConfigurationErrorStatus(ctx: ExtensionContext): boolean {
    const errorReason = configurationErrorReason();
    if (!errorReason) return false;
    ctx.ui.setStatus("permissions", "invalid-permissions");
    if (ctx.hasUI) ctx.ui.notify(errorReason, "error");
    return true;
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

  function setActiveProfile(profile: ProfileName): void {
    activeProfile = profile;
    pi.appendEntry(profileEntryType, { profile, timestamp: Date.now() });
  }

  pi.on("session_start", (_event, ctx) => {
    restoreActiveProfile(ctx);

    const errorReason = configurationErrorReason();
    if (errorReason) {
      ctx.ui.setStatus("permissions", "invalid-permissions");
      if (ctx.hasUI) {
        ctx.ui.notify(errorReason, "error");
      }
      return;
    }

    ctx.ui.setStatus("permissions", formatProfileStatus(activeProfile));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("permissions", undefined);
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

      setActiveProfile(requested);
      ctx.ui.setStatus("permissions", formatProfileStatus(activeProfile));
      ctx.ui.notify(`Switched to profile: ${activeProfile}`, "info");
    },
  });

  pi.registerCommand("read-only", {
    description: "Switch to the read-only permissions profile",
    handler: async (_args, ctx) => {
      if (preserveConfigurationErrorStatus(ctx)) return;
      if (!policyConfig.profiles["read-only"]) {
        ctx.ui.notify("No 'read-only' profile is configured", "error");
        return;
      }

      setActiveProfile("read-only");
      ctx.ui.setStatus("permissions", formatProfileStatus(activeProfile));
      ctx.ui.notify("Read-only profile enabled", "info");
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

      setActiveProfile("socrates");
      ctx.ui.setStatus("permissions", formatProfileStatus(activeProfile));
      ctx.ui.notify("Socrates profile enabled", "info");
    },
  });

  pi.registerCommand("socrates-off", {
    description: "Switch back to the configured default permissions profile",
    handler: async (_args, ctx) => {
      if (preserveConfigurationErrorStatus(ctx)) return;
      setActiveProfile(policyConfig.defaultProfile);
      ctx.ui.setStatus("permissions", formatProfileStatus(activeProfile));
      ctx.ui.notify(
        `Socrates profile disabled; active profile: ${activeProfile}`,
        "info",
      );
    },
  });

  pi.on("before_agent_start", (event) => {
    const policy = activePolicy(activeProfile);
    if (!policy.promptFile) return undefined;

    const promptPath = resolvePolicyRelativePath(policy.promptFile);
    const prompt = fs.readFileSync(promptPath, "utf8").trim();
    return {
      systemPrompt: `${event.systemPrompt}\n\n# Active profile: ${activeProfile}\n\n${prompt}`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    const errorReason = configurationErrorReason();
    if (errorReason) {
      return { block: true, reason: errorReason };
    }

    const policy = activePolicy(activeProfile);

    if (isToolCallEventType("bash", event)) {
      const command = event.input.command ?? "";
      const scopeDecision = decideSubagentBashScope(
        command,
        startupCwd,
        ctx.cwd ?? startupCwd,
        policy,
        subagentPermissibleRules,
      );
      if (scopeDecision) return scopeDecision;

      const ripgrepGlobError = validateRipgrepGlobOverrides(
        command,
        policy.protectedPathPatterns ?? [],
        policy.protectedPathExceptions,
      );
      if (ripgrepGlobError) return { block: true, reason: ripgrepGlobError };

      event.input.command = injectRipgrepProtectedPathGlobs(
        command,
        policy.protectedPathPatterns ?? [],
        policy.protectedPathExceptions,
      );
      return await gateBash(event.input.command, startupCwd, ctx, policy);
    }

    if (isToolCallEventType("grep", event)) {
      const reason = injectGrepProtectedPathGlob(
        event.input,
        policy.protectedPathPatterns ?? [],
        policy.protectedPathExceptions,
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
        policy.protectedPathPatterns,
        policy.protectedPathExceptions,
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
      policy.protectedPathPatterns,
      policy.protectedPathExceptions,
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

function parseSubagentPermissibleRules(
  value: string | undefined,
): Rule[] | undefined {
  if (value === undefined) return undefined;

  const scopes = value
    .split(",")
    .map((scope) =>
      scope.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""),
    )
    .filter(Boolean);
  const guidance =
    "This subagent may only access paths in its declared permissible scope.";
  const rules: Rule[] = [{ pattern: "**", decision: "deny", guidance }];

  for (const scope of scopes) {
    if (scope === ".") {
      rules.push({ pattern: "**", decision: "allow" });
      rules.push({ pattern: "..", decision: "deny", guidance });
      rules.push({ pattern: "../**", decision: "deny", guidance });
    } else if (/[*?[]/.test(scope)) {
      rules.push({ pattern: scope, decision: "allow" });
    } else {
      rules.push({ pattern: scope, decision: "allow" });
      rules.push({ pattern: `${scope}/**`, decision: "allow" });
    }
  }
  return rules;
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

function decideSubagentBashScope(
  command: string,
  startupCwd: string,
  cwd: string,
  policy: ProfilePolicy,
  subagentPermissibleRules: Rule[] | undefined,
) {
  if (!subagentPermissibleRules) return undefined;
  const scopedPolicy = {
    ...policy,
    writePaths: subagentPermissibleRules as [Rule, ...Rule[]],
  };
  const decision = decideBashPathReferences(
    pathAnalysisSegments(command),
    startupCwd,
    cwd,
    scopedPolicy,
    policy.protectedPathPatterns,
    policy.protectedPathExceptions,
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

export async function gateBash(
  command: string,
  startupCwd: string,
  ctx: ExtensionContext,
  activePolicy = defaultPolicy,
) {
  const parseErrors = classifyShell(command).errors;
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

  const commands = extractShellCommands(command)
    .map(normalizeCommandForDecision)
    .filter(Boolean);
  const readValidationError = validateReadCommands(command, commands);
  if (readValidationError) {
    return {
      block: true,
      reason: `Shell read command denied: ${readValidationError}\n\nUse Pi's read tool for concrete files, grep for content searches, or find followed by explicit read calls.`,
    };
  }

  const decisions =
    commands.length > 0
      ? commands.map((cmd) => evaluateBash(cmd, activePolicy))
      : [evaluateBash("", activePolicy)];

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

  const pathDecision = decideBashPathReferences(
    pathAnalysisSegments(command),
    startupCwd,
    ctx.cwd ?? startupCwd,
    activePolicy,
    activePolicy.protectedPathPatterns,
    activePolicy.protectedPathExceptions,
  );
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
  let matchedRule: CustomToolRule | undefined;
  for (const rule of rules) {
    if (customToolRuleMatches(rule, input)) matchedRule = rule;
  }
  return { decision: matchedRule?.decision ?? "ask", rule: matchedRule };
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
  let matchedRule: Rule | undefined;
  for (const rule of rules) {
    if (matches(rule.pattern, value)) matchedRule = rule;
  }
  return {
    decision: matchedRule?.decision ?? defaultDecision,
    rule: matchedRule,
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
