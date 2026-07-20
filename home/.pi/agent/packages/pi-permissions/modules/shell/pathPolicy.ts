import path from "node:path";
import type { Decision, ProfilePolicy, Rule } from "../policyHelpers";
import { shellishTokens } from "./parse";

export type PolicyDecision = {
  decision: Decision;
  rule?: Rule;
};

export type PathPolicyDecision = PolicyDecision & { matchPath: string };

export function decideBashPathReferences(
  commandSegments: string[],
  startupCwd: string,
  cwd: string,
  activePolicy: ProfilePolicy,
): (PolicyDecision & { path: string; matchPath: string }) | undefined {
  let simulatedCwd = cwd;
  for (const segment of commandSegments) {
    const redirectionsArePolicyGated = Boolean(
      activePolicy.bashOutputRedirections,
    );
    let skipNextOutputRedirectionTarget = false;
    let skipNextGlobPattern = false;
    for (const token of shellishTokens(segment)) {
      if (skipNextOutputRedirectionTarget) {
        skipNextOutputRedirectionTarget = false;
        continue;
      }
      if (skipNextGlobPattern) {
        skipNextGlobPattern = false;
        continue;
      }
      // Ripgrep glob values can contain slashes but are patterns, not paths.
      if (token === "--glob") {
        skipNextGlobPattern = true;
        continue;
      }
      if (token.startsWith("--glob=")) continue;
      if (
        redirectionsArePolicyGated &&
        isStandaloneOutputRedirectionOperator(token)
      ) {
        skipNextOutputRedirectionTarget = true;
        continue;
      }
      if (
        redirectionsArePolicyGated &&
        extractInlineOutputRedirectionTarget(token)
      )
        continue;
      if (!looksLikePath(token)) continue;
      const absolutePath = resolveRequestedPath(token, simulatedCwd);
      const policyDecision = evaluatePathByPattern(
        absolutePath,
        startupCwd,
        activePolicy.bashPathReferences,
        "allow",
      );
      if (policyDecision.decision !== "allow")
        return { ...policyDecision, path: absolutePath };
    }

    const cdTarget = extractCdTarget(segment);
    if (cdTarget !== undefined && cdTarget !== "-") {
      simulatedCwd = resolveRequestedPath(cdTarget, simulatedCwd);
    }
  }
  return undefined;
}

export function decideBashOutputRedirections(
  commandSegments: string[],
  startupCwd: string,
  cwd: string,
  activePolicy: ProfilePolicy,
): (PolicyDecision & { path: string; matchPath: string }) | undefined {
  const rules = activePolicy.bashOutputRedirections;
  if (!rules) return undefined;

  let simulatedCwd = cwd;
  for (const segment of commandSegments) {
    for (const target of extractOutputRedirectionTargets(segment)) {
      const absolutePath = resolveRequestedPath(target, simulatedCwd);
      const policyDecision = evaluatePathByPattern(
        absolutePath,
        startupCwd,
        rules,
        "allow",
      );
      if (policyDecision.decision !== "allow")
        return { ...policyDecision, path: absolutePath };
    }

    const cdTarget = extractCdTarget(segment);
    if (cdTarget !== undefined && cdTarget !== "-") {
      simulatedCwd = resolveRequestedPath(cdTarget, simulatedCwd);
    }
  }
  return undefined;
}

export function evaluatePathByPattern(
  absolutePath: string,
  startupCwd: string,
  rules: Rule[],
  defaultDecision: Decision,
): PathPolicyDecision {
  const relativeMatchPath = policyMatchPath(absolutePath, startupCwd);
  let matchedRule: Rule | undefined;
  let matchedPath = relativeMatchPath;

  for (const rule of rules) {
    const matchPath = rule.pattern.startsWith("/")
      ? normalizePolicyPath(absolutePath)
      : relativeMatchPath;
    if (matchesGlobPattern(rule.pattern, matchPath)) {
      matchedRule = rule;
      matchedPath = matchPath;
    }
  }

  return {
    decision: matchedRule?.decision ?? defaultDecision,
    rule: matchedRule,
    matchPath: matchedPath,
  };
}

export function matchesGlobPattern(pattern: string, value: string): boolean {
  const normalizedPattern = normalizePolicyPath(pattern);
  const normalizedValue = normalizePolicyPath(value);
  const regex = new RegExp(`^${globToRegExpSource(normalizedPattern)}$`);
  return regex.test(normalizedValue);
}

export function resolveRequestedPath(
  requestedPath: string | undefined,
  cwd: string,
): string {
  if (!requestedPath) return path.resolve(cwd);
  return path.resolve(cwd, expandHome(requestedPath));
}

export function expandHome(value: string): string {
  if (value === "~") return process.env.HOME ?? value;
  if (value.startsWith("~/"))
    return path.join(process.env.HOME ?? "~", value.slice(2));
  return value;
}

export function isOutside(absolutePath: string, root: string): boolean {
  const relative = path.relative(root, absolutePath);
  return relative === ""
    ? false
    : relative.startsWith("..") || path.isAbsolute(relative);
}

export function displayPath(absolutePath: string, root: string): string {
  return isOutside(absolutePath, root)
    ? absolutePath
    : path.relative(root, absolutePath) || ".";
}

function extractOutputRedirectionTargets(command: string): string[] {
  const tokens = shellishTokens(command);
  const targets: string[] = [];
  let previousWasOutputRedirection = false;

  for (const token of tokens) {
    if (previousWasOutputRedirection) {
      previousWasOutputRedirection = false;
      if (!isFileDescriptorTarget(token)) targets.push(token);
      continue;
    }

    if (isStandaloneOutputRedirectionOperator(token)) {
      previousWasOutputRedirection = true;
      continue;
    }

    const target = extractInlineOutputRedirectionTarget(token);
    if (target && !isFileDescriptorTarget(target)) targets.push(target);
  }

  return targets;
}

function isStandaloneOutputRedirectionOperator(token: string): boolean {
  return /^(?:\d*>>|\d*>\||\d*>|&>>|&>)$/.test(token);
}

function extractInlineOutputRedirectionTarget(
  token: string,
): string | undefined {
  const match = /(?:\d*>>|\d*>\||\d*>|&>>|&>)(.+)$/.exec(token);
  return match?.[1];
}

function isFileDescriptorTarget(target: string): boolean {
  return /^&(?:\d+|-)$/.test(target);
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

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.*]/g, "\\$&");
}
