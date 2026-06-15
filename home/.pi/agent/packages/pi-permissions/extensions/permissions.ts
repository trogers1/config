import fs from "node:fs";
import path from "node:path";
import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { policyConfig } from "../policy";

// ─── Types ────────────────────────────────────────────────────────────

const decisionValues = ["allow", "ask", "deny"] as const;
export type Decision = (typeof decisionValues)[number];

type Approval = {
  approved: boolean;
  guidance?: string;
};

export type Rule = {
  pattern: string;
  decision: Decision;
};

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

const profileColorFormatters = {
  black: ansi.black,
  red: ansi.red,
  green: ansi.green,
  yellow: ansi.yellow,
  blue: ansi.blue,
  magenta: ansi.magenta,
  cyan: ansi.cyan,
  white: ansi.white,
} as const;

type ProfileColor = keyof typeof profileColorFormatters;

export type ProfilePolicy = {
  promptFile?: string | null;
  color?: ProfileColor;
  emoji?: string;
  tools: Record<string, Rule[]>;
  bashPathReferences: [Rule, ...Rule[]];
};

export type PolicyConfig<Names extends string = string> = {
  defaultProfile: Names;
  profiles: Record<Names, ProfilePolicy>;
};

const defaultPolicy: ProfilePolicy = {
  tools: {
    bash: [{ pattern: "*", decision: "ask" }],
  },
  bashPathReferences: [{ pattern: "*", decision: "allow" }],
};

// ─── Compile-time helpers ─────────────────────────────────────────────

export function definePolicyConfig<
  Profiles extends Record<string, ProfilePolicy>,
>(config: {
  defaultProfile: keyof Profiles & string;
  profiles: Profiles;
}): PolicyConfig<keyof Profiles & string> {
  return config;
}

// ─── Composition helpers ──────────────────────────────────────────────

export function extendProfile(
  base: ProfilePolicy,
  override: Partial<Omit<ProfilePolicy, "tools">> & {
    tools?: Record<string, Rule[]>;
  },
): ProfilePolicy {
  const mergedTools: Record<string, Rule[]> = structuredClone(base.tools);

  // Append override rules (later rules win by position)
  for (const [tool, rules] of Object.entries(override.tools ?? {})) {
    if (!rules) continue;
    if (rules.length === 0) {
      delete mergedTools[tool];
    } else {
      mergedTools[tool] = [...(mergedTools[tool] ?? []), ...rules];
    }
  }

  return {
    ...base,
    ...override,
    tools: mergedTools,
    bashPathReferences: override.bashPathReferences ?? [
      ...base.bashPathReferences,
    ],
  };
}

const moduleDir = typeof __dirname === "string" ? __dirname : process.cwd();
const profileEntryType = "pi-permissions-profile";
const pathToolNames = ["read", "grep", "find", "ls", "edit", "write"] as const;
const pathToolNameSet: ReadonlySet<string> = new Set(pathToolNames);

type ProfileName = keyof typeof policyConfig.profiles & string;
type PathToolName = (typeof pathToolNames)[number];

function typedKeys<T extends object>(value: T): Array<keyof T & string> {
  return Object.keys(value) as Array<keyof T & string>;
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const property = Reflect.get(value, key);
  return typeof property === "string" ? property : undefined;
}

const profileNames = () => typedKeys(policyConfig.profiles);

function isProfileName(value: unknown): value is ProfileName {
  return typeof value === "string" && value in policyConfig.profiles;
}

function activePolicy(profile: ProfileName): ProfilePolicy {
  return policyConfig.profiles[profile];
}

export default function (pi: ExtensionAPI) {
  const startupCwd = path.resolve(process.cwd());
  let activeProfile: ProfileName = policyConfig.defaultProfile;

  function restoreActiveProfile(ctx: ExtensionContext): void {
    activeProfile = policyConfig.defaultProfile;

    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== profileEntryType)
        continue;
      const profile = readStringProperty(entry.data, "profile");
      if (isProfileName(profile)) {
        activeProfile = profile;
      }
    }
  }

  function setActiveProfile(profile: ProfileName): void {
    activeProfile = profile;
    pi.appendEntry(profileEntryType, { profile, timestamp: Date.now() });
  }

  pi.on("session_start", async (_event, ctx) => {
    restoreActiveProfile(ctx);
    ctx.ui.setStatus("permissions", formatProfileStatus(activeProfile));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
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

  pi.registerCommand("socrates", {
    description: "Switch to the Socrates coaching profile",
    handler: async (_args, ctx) => {
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
    description: "Switch back to the default permissions profile",
    handler: async (_args, ctx) => {
      setActiveProfile(policyConfig.defaultProfile);
      ctx.ui.setStatus("permissions", formatProfileStatus(activeProfile));
      ctx.ui.notify(
        `Socrates profile disabled; active profile: ${activeProfile}`,
        "info",
      );
    },
  });

  pi.on("before_agent_start", async (event) => {
    const policy = activePolicy(activeProfile);
    if (!policy.promptFile) return undefined;

    const promptPath = resolvePolicyRelativePath(policy.promptFile);
    const prompt = fs.readFileSync(promptPath, "utf8").trim();
    return {
      systemPrompt: `${event.systemPrompt}\n\n# Active profile: ${activeProfile}\n\n${prompt}`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    const policy = activePolicy(activeProfile);

    if (isToolCallEventType("bash", event)) {
      return await gateBash(event.input.command ?? "", startupCwd, ctx, policy);
    }

    const rules = policy.tools[event.toolName];
    if (!rules) return undefined;

    const requestedPath = toolPath(event.toolName, event.input);
    const absolutePath = resolveRequestedPath(
      requestedPath,
      ctx.cwd ?? startupCwd,
    );
    const matchPath = policyMatchPath(absolutePath, startupCwd);
    const decision = decideByPattern(
      matchPath,
      rules,
      "allow",
      matchesGlobPattern,
    );

    if (decision === "deny") {
      return {
        block: true,
        reason: `${event.toolName} denied by policy for path: ${displayPath(absolutePath, startupCwd)}`,
      };
    }

    if (decision === "ask") {
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

export async function gateBash(
  command: string,
  startupCwd: string,
  ctx: ExtensionContext,
  activePolicy = defaultPolicy,
) {
  const commands = extractShellCommands(command)
    .map(normalizeCommandForDecision)
    .filter(Boolean);
  const decisions =
    commands.length > 0
      ? commands.map((cmd) => decideBash(cmd, activePolicy))
      : [decideBash("", activePolicy)];

  if (decisions.includes("deny")) {
    return {
      block: true,
      reason: `Command denied by explicit rule.\n\nRaw command:\n${command}\n\nParsed command segments:\n${formatParsedCommands(command, activePolicy)}`,
    };
  }

  const pathDecision = decideBashPathReferences(
    commands,
    startupCwd,
    ctx.cwd ?? startupCwd,
    activePolicy,
  );
  if (pathDecision?.decision === "deny") {
    return {
      block: true,
      reason: `Bash path reference denied by policy.\n\nRaw command:\n${command}\n\nParsed command segments:\n${formatParsedCommands(command, activePolicy)}\n\nPath:\n${pathDecision.path}\n\nMatched policy path:\n${pathDecision.matchPath}`,
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

  if (decisions.includes("ask")) {
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
  return decideByPattern(
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

function formatProfileStatus(profileName: ProfileName): string {
  const profile = activePolicy(profileName);
  const color = profile.color ?? "blue";
  const emoji = profile.emoji ? `${profile.emoji} ` : "";
  const colorize = profileColorFormatters[color];
  return `profile: ${emoji}${colorize(ansi.bold(profileName))}`;
}

export function extractShellCommands(command: string): string[] {
  const commands = splitShellCommands(command);
  for (const substitution of extractCommandSubstitutions(command)) {
    commands.push(...extractShellCommands(substitution));
  }
  return commands;
}

export function splitShellCommands(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const next = command[i + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "single") {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (
        (quote === "single" && char === "'") ||
        (quote === "double" && char === '"')
      )
        quote = undefined;
      continue;
    }

    if (char === "'") {
      quote = "single";
      current += char;
      continue;
    }
    if (char === '"') {
      quote = "double";
      current += char;
      continue;
    }

    if (char === "(") parenDepth++;
    else if (char === ")" && parenDepth > 0) parenDepth--;
    else if (char === "{") braceDepth++;
    else if (char === "}" && braceDepth > 0) braceDepth--;
    else if (char === "[") bracketDepth++;
    else if (char === "]" && bracketDepth > 0) bracketDepth--;

    const atTopLevel =
      parenDepth === 0 && braceDepth === 0 && bracketDepth === 0;
    if (
      atTopLevel &&
      (char === ";" ||
        char === "\n" ||
        char === "|" ||
        (char === "&" && next === "&"))
    ) {
      pushPart(parts, current);
      current = "";
      if ((char === "|" && next === "|") || (char === "&" && next === "&")) i++;
      continue;
    }

    current += char;
  }

  pushPart(parts, current);
  return parts;
}

export function extractCommandSubstitutions(command: string): string[] {
  const substitutions: string[] = [];
  let quote: "single" | "double" | undefined;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    const next = command[i + 1];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }
    if (quote === "single") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (char === '"') quote = undefined;
      // Command substitution is still active inside double quotes.
    } else if (char === "'") {
      quote = "single";
      continue;
    } else if (char === '"') {
      quote = "double";
      continue;
    }

    if (char === "$" && next === "(") {
      const parsed = readBalanced(command, i + 2, "(", ")");
      if (parsed) {
        substitutions.push(parsed.content);
        i = parsed.end;
      }
      continue;
    }

    if (char === "`") {
      const end = readBacktick(command, i + 1);
      if (end) {
        substitutions.push(end.content);
        i = end.end;
      }
    }
  }

  return substitutions;
}

export function normalizeCommandForDecision(command: string): string {
  let normalized = normalizeCommand(command)
    .replace(/^\(?\s*/, "")
    .replace(/\s*\)?$/, "")
    .replace(/^\{\s*/, "")
    .replace(/\s*\}$/, "");

  let changed = true;
  while (changed) {
    changed = false;
    const next = normalized.replace(
      /^(?:if|then|else|elif|do|while|until|time|command|builtin|env|exec|xargs)\s+/,
      "",
    );
    if (next !== normalized) {
      normalized = next;
      changed = true;
    }
  }
  return normalized;
}

export function matchesCommandPattern(
  pattern: string,
  command: string,
): boolean {
  const regex = new RegExp(
    `^${escapeRegExp(normalizeCommand(pattern)).replace(/\\\*/g, ".*")}$`,
  );
  return regex.test(command);
}

export function matchesGlobPattern(pattern: string, value: string): boolean {
  const normalizedPattern = normalizePolicyPath(pattern);
  const normalizedValue = normalizePolicyPath(value);
  const regex = new RegExp(`^${globToRegExpSource(normalizedPattern)}$`);
  return regex.test(normalizedValue);
}

function decideByPattern(
  value: string,
  rules: Rule[],
  defaultDecision: Decision,
  matches: (pattern: string, value: string) => boolean,
): Decision {
  let decision: Decision = defaultDecision;
  for (const rule of rules) {
    if (matches(rule.pattern, value)) decision = rule.decision;
  }
  return decision;
}

function decideBashPathReferences(
  commandSegments: string[],
  startupCwd: string,
  cwd: string,
  activePolicy: ProfilePolicy,
): { decision: Decision; path: string; matchPath: string } | undefined {
  let simulatedCwd = cwd;
  for (const segment of commandSegments) {
    for (const token of shellishTokens(segment)) {
      if (!looksLikePath(token)) continue;
      const absolutePath = resolveRequestedPath(token, simulatedCwd);
      const matchPath = policyMatchPath(absolutePath, startupCwd);
      const decision = decideByPattern(
        matchPath,
        activePolicy.bashPathReferences,
        "allow",
        matchesGlobPattern,
      );
      if (decision !== "allow")
        return { decision, path: absolutePath, matchPath };
    }

    const cdTarget = extractCdTarget(segment);
    if (cdTarget !== undefined) {
      if (cdTarget !== "-") {
        simulatedCwd = resolveRequestedPath(cdTarget, simulatedCwd);
      }
    }
  }
  return undefined;
}

function extractCdTarget(command: string): string | undefined {
  const tokens = shellishTokens(command);
  if (tokens[0] !== "cd") return undefined;
  let arg: string | undefined;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("-")) continue;
    arg = token;
    break;
  }
  return arg ?? "~";
}

function policyMatchPath(absolutePath: string, root: string): string {
  const relative = path.relative(root, absolutePath);
  return normalizePolicyPath(relative || ".");
}

function normalizePolicyPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function globToRegExpSource(pattern: string): string {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      const after = pattern[i + 2];
      if (after === "/") {
        source += "(?:.*?/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegExp(char);
    }
  }
  return source;
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

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function pushPart(parts: string[], value: string): void {
  const trimmed = value.trim();
  if (trimmed) parts.push(trimmed);
}

function readBalanced(
  input: string,
  start: number,
  open: string,
  close: string,
): { content: string; end: number } | undefined {
  let depth = 1;
  let quote: "single" | "double" | undefined;
  let escaped = false;
  let content = "";

  for (let i = start; i < input.length; i++) {
    const char = input[i];
    if (escaped) {
      content += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "single") {
      content += char;
      escaped = true;
      continue;
    }
    if (quote) {
      content += char;
      if (
        (quote === "single" && char === "'") ||
        (quote === "double" && char === '"')
      )
        quote = undefined;
      continue;
    }
    if (char === "'") {
      quote = "single";
      content += char;
      continue;
    }
    if (char === '"') {
      quote = "double";
      content += char;
      continue;
    }
    if (char === open) depth++;
    if (char === close) depth--;
    if (depth === 0) return { content, end: i };
    content += char;
  }
  return undefined;
}

function readBacktick(
  input: string,
  start: number,
): { content: string; end: number } | undefined {
  let escaped = false;
  let content = "";
  for (let i = start; i < input.length; i++) {
    const char = input[i];
    if (escaped) {
      content += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      content += char;
      continue;
    }
    if (char === "`") return { content, end: i };
    content += char;
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.*]/g, "\\$&");
}

function isPathToolName(toolName: string): toolName is PathToolName {
  return pathToolNameSet.has(toolName);
}

function toolPath(toolName: string, input: unknown): string | undefined {
  const requestedPath = readStringProperty(input, "path");
  if (requestedPath) return requestedPath;
  return isPathToolName(toolName) && ["grep", "find", "ls"].includes(toolName)
    ? "."
    : undefined;
}

function resolveRequestedPath(
  requestedPath: string | undefined,
  cwd: string,
): string {
  if (!requestedPath) return path.resolve(cwd);
  return path.resolve(cwd, expandHome(requestedPath));
}

function expandHome(value: string): string {
  if (value === "~") return process.env.HOME ?? value;
  if (value.startsWith("~/"))
    return path.join(process.env.HOME ?? "~", value.slice(2));
  return value;
}

function isOutside(absolutePath: string, root: string): boolean {
  const relative = path.relative(root, absolutePath);
  return relative === ""
    ? false
    : relative.startsWith("..") || path.isAbsolute(relative);
}

function displayPath(absolutePath: string, root: string): string {
  return isOutside(absolutePath, root)
    ? absolutePath
    : path.relative(root, absolutePath) || ".";
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

function shellishTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "single") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (
        (quote === "single" && char === "'") ||
        (quote === "double" && char === '"')
      )
        quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'") {
      quote = "single";
      continue;
    }
    if (char === '"') {
      quote = "double";
      continue;
    }
    if (/\s/.test(char) || char === ";" || char === "|" || char === "&") {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function looksLikePath(token: string): boolean {
  if (!token || token.startsWith("-")) return false;
  if (token === "." || token === ".." || token === "~") return true;
  return (
    token.startsWith("/") ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.startsWith("~/") ||
    token.includes("/")
  );
}
