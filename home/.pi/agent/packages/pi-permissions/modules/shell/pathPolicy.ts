import path from "node:path";
import {
  parse,
  type CaseItem,
  type Command,
  type CommandExpansionPart,
  type CompoundList,
  type Node,
  type ProcessSubstitutionPart,
  type Script,
  type Statement,
  type Word,
  type WordPart,
} from "unbash";
import type {
  Decision,
  PathContext,
  PathRule,
  ProfilePolicy,
  ProtectedPathRule,
} from "../policyHelpers";
import { chooseMostSpecific, pathPatternSpecificity } from "../ruleSpecificity";
import { classifyCommandTokens, type ShellTokenKind } from "./classify";

export type PolicyDecision = {
  decision: Decision;
  rule?: PathRule;
};

export type PathPolicyDecision = PolicyDecision & { matchPath: string };

type CwdState = {
  cwd: string;
  known: boolean;
};

type DecisionWithPath = PolicyDecision & { path: string; matchPath: string };

type PathToken = {
  kind: ShellTokenKind;
  value: string;
  dynamicRole?: "argument" | "filesystem-reference" | "redirection-target";
  pos: number;
  end: number;
  command?: string;
};

export function decideBashPathReferences(
  commandSegments: string[],
  startupCwd: string,
  cwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[] = [],
): DecisionWithPath | undefined {
  let state: CwdState = { cwd, known: true };

  for (const segment of commandSegments) {
    const script = parse(segment);
    const result = analyzeScript(
      script,
      state,
      startupCwd,
      activePolicy,
      protectedPathRules,
    );
    state = result.state;
    if (result.decision) return result.decision;
  }

  return undefined;
}

export function evaluatePathByPattern(
  absolutePath: string,
  startupCwd: string,
  rules: PathRule[],
  defaultDecision: Decision,
  context: PathContext,
  protectedPathRules: readonly ProtectedPathRule[] = [],
): PathPolicyDecision {
  const ordinaryDecision = resolvePathRules(
    absolutePath,
    startupCwd,
    rules,
    defaultDecision,
    (rule) => {
      const contexts: readonly PathContext[] | undefined = rule.contexts;
      return !contexts || contexts.includes(context);
    },
  );
  const protectedDecision = resolvePathRules(
    absolutePath,
    startupCwd,
    protectedPathRules,
    "allow",
  );
  if (protectedDecision.decision === "deny") {
    return {
      decision: "deny",
      rule: protectedDecision.rule
        ? {
            ...protectedDecision.rule,
            guidance:
              protectedDecision.rule.guidance ??
              "This path is protected from disclosure and mutation by the active profile.",
            alternatives: [
              "Use an explicitly approved file instead",
              "Ask the user for a redacted or safe-to-share value",
            ],
          }
        : {
            pattern: protectedDecision.matchPath,
            decision: "deny",
            guidance:
              "This path is protected from disclosure and mutation by the active profile.",
            alternatives: [
              "Use an explicitly approved file instead",
              "Ask the user for a redacted or safe-to-share value",
            ],
          },
      matchPath: protectedDecision.matchPath,
    };
  }

  return ordinaryDecision;
}

export function evaluateProtectedPath(
  requestedPath: string,
  policy: { protectedPathRules?: readonly ProtectedPathRule[] },
  startupCwd = process.cwd(),
): { decision: "allow" | "deny"; rule?: ProtectedPathRule; matchPath: string } {
  const absolutePath = resolveRequestedPath(requestedPath, startupCwd);
  return resolvePathRules(
    absolutePath,
    startupCwd,
    policy.protectedPathRules ?? [],
    "allow",
  );
}

export function matchesGlobPattern(pattern: string, value: string): boolean {
  const normalizedPattern = normalizePolicyPath(pattern);
  const normalizedValue = normalizePolicyPath(value);
  const regex = new RegExp(`^${globToRegExpSource(normalizedPattern)}$`);
  return regex.test(normalizedValue);
}

function analyzeScript(
  script: Script,
  state: CwdState,
  startupCwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[],
): { state: CwdState; decision?: DecisionWithPath } {
  let currentState = state;
  for (const statement of script.commands) {
    const previousState = currentState;
    const result = analyzeStatement(
      statement,
      currentState,
      startupCwd,
      activePolicy,
      protectedPathRules,
    );
    currentState = applySimpleCdState(statement, previousState, result.state);
    if (result.decision) return { ...result, state: currentState };
  }
  return { state: currentState };
}

function analyzeStatement(
  statement: Statement,
  state: CwdState,
  startupCwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[],
): { state: CwdState; decision?: DecisionWithPath } {
  return analyzeNode(
    statement.command,
    state,
    startupCwd,
    activePolicy,
    protectedPathRules,
  );
}

function analyzeNode(
  node: Node,
  state: CwdState,
  startupCwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[],
): { state: CwdState; decision?: DecisionWithPath } {
  switch (node.type) {
    case "Statement":
      return analyzeNode(
        node.command,
        state,
        startupCwd,
        activePolicy,
        protectedPathRules,
      );
    case "Command":
      return analyzeCommand(
        node,
        state,
        startupCwd,
        activePolicy,
        protectedPathRules,
      );
    case "CompoundList":
      return analyzeCompoundList(
        node,
        state,
        startupCwd,
        activePolicy,
        protectedPathRules,
      );
    case "BraceGroup":
      return analyzeCompoundList(
        node.body,
        state,
        startupCwd,
        activePolicy,
        protectedPathRules,
      );
    case "Subshell": {
      const nested = analyzeCompoundList(
        node.body,
        { ...state },
        startupCwd,
        activePolicy,
        protectedPathRules,
      );
      return { state, decision: nested.decision };
    }
    case "Pipeline":
      if (node.commands.length > 1 && containsCwdMutation(node)) {
        return uncertainCwdDecision(state, "pipeline CWD");
      }
      if (node.commands.length === 1) {
        return analyzeNode(
          node.commands[0],
          state,
          startupCwd,
          activePolicy,
          protectedPathRules,
        );
      }
      return analyzeNestedNodes(
        node.commands,
        state,
        startupCwd,
        activePolicy,
        protectedPathRules,
        containsCwdMutation(node) ? { ...state, known: false } : state,
      );
    case "AndOr": {
      const operators =
        (node as unknown as { operators?: readonly string[] }).operators ?? [];
      // `&&` chains run left-to-right only while each command succeeds, so a
      // static `cd` still determines the cwd of later commands. `||` selects
      // between mutually exclusive branches, so a cwd change anywhere in the
      // chain leaves the effective cwd ambiguous.
      if (
        node.commands.length > 1 &&
        operators.some((operator) => operator === "||") &&
        containsCwdMutation(node)
      ) {
        return uncertainCwdDecision(state, "conditional CWD");
      }
      if (node.commands.length === 1) {
        return analyzeNode(
          node.commands[0],
          state,
          startupCwd,
          activePolicy,
          protectedPathRules,
        );
      }
      const andOrResult = analyzeSequentialNodes(
        node.commands,
        state,
        startupCwd,
        activePolicy,
        protectedPathRules,
      );
      // Within an && chain a later command only runs when every earlier
      // command succeeded, so static cd tracking is sound inside the chain.
      // The chain itself may stop before its cd commands run, so the cwd
      // afterwards cannot be proven.
      if (containsCwdMutation(node)) {
        return {
          decision: andOrResult.decision,
          state: { ...state, known: false },
        };
      }
      return andOrResult;
    }
    case "If":
    case "While":
    case "For":
    case "Select":
    case "Case":
    case "Function":
    case "Coproc":
    case "ArithmeticFor":
    case "TestCommand":
      return analyzeUnsupportedNode(
        node,
        state,
        startupCwd,
        activePolicy,
        protectedPathRules,
      );
    default:
      return { state };
  }
}

function uncertainCwdDecision(
  state: CwdState,
  description: string,
): { state: CwdState; decision: DecisionWithPath } {
  return {
    state: { ...state, known: false },
    decision: {
      decision: "ask",
      path: description,
      matchPath: description,
    },
  };
}

function analyzeCompoundList(
  list: CompoundList,
  state: CwdState,
  startupCwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[],
): { state: CwdState; decision?: DecisionWithPath } {
  let currentState = state;
  for (const statement of list.commands) {
    const previousState = currentState;
    const result = analyzeStatement(
      statement,
      currentState,
      startupCwd,
      activePolicy,
      protectedPathRules,
    );
    currentState = applySimpleCdState(statement, previousState, result.state);
    if (result.decision) return { ...result, state: currentState };
  }
  return { state: currentState };
}

function applySimpleCdState(
  node: Node,
  previousState: CwdState,
  analyzedState: CwdState,
): CwdState {
  const target = simpleStaticCdTarget(node);
  if (!target || target === "-") return analyzedState;
  return {
    cwd: resolveRequestedPath(target, previousState.cwd),
    known: true,
  };
}

function simpleStaticCdTarget(node: Node): string | undefined {
  if (node.type === "Statement") return simpleStaticCdTarget(node.command);
  if (
    (node.type === "Pipeline" || node.type === "AndOr") &&
    node.commands.length === 1
  ) {
    return simpleStaticCdTarget(node.commands[0]);
  }
  if (node.type === "CompoundList" && node.commands.length === 1) {
    return simpleStaticCdTarget(node.commands[0]);
  }
  if (node.type !== "Command" || staticWordValue(node.name) !== "cd") {
    return undefined;
  }
  for (const word of node.suffix) {
    const value = staticWordValue(word);
    if (value !== undefined && !value.startsWith("-")) return value;
  }
  return "~";
}

function analyzeSequentialNodes(
  nodes: readonly Node[],
  state: CwdState,
  startupCwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[],
): { state: CwdState; decision?: DecisionWithPath } {
  let currentState = { ...state };
  for (const nested of nodes) {
    const result = analyzeNode(
      nested,
      currentState,
      startupCwd,
      activePolicy,
      protectedPathRules,
    );
    currentState = result.state;
    if (result.decision) return result;
  }
  return { state: currentState };
}

function analyzeNestedNodes(
  nodes: readonly Node[],
  state: CwdState,
  startupCwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[],
  finalState: CwdState,
): { state: CwdState; decision?: DecisionWithPath } {
  let currentState = { ...state };
  for (const nested of nodes) {
    const result = analyzeNode(
      nested,
      currentState,
      startupCwd,
      activePolicy,
      protectedPathRules,
    );
    currentState = result.state;
    if (result.decision) return result;
  }
  return { state: finalState };
}

function analyzeUnsupportedNode(
  node: Node,
  state: CwdState,
  startupCwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[],
): { state: CwdState; decision?: DecisionWithPath } {
  if (containsCwdMutation(node)) {
    return uncertainCwdDecision(state, "conditional CWD");
  }
  const nestedNodes = collectNestedNodes(node);
  return analyzeNestedNodes(
    nestedNodes,
    state,
    startupCwd,
    activePolicy,
    protectedPathRules,
    state,
  );
}

function analyzeCommand(
  command: Command,
  state: CwdState,
  startupCwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[],
): { state: CwdState; decision?: DecisionWithPath } {
  const commandName = staticWordValue(command.name);
  const tokens = classifyCommandTokens(command);
  const cdTarget = commandName === "cd" ? findCdTarget(command) : undefined;

  if (commandName === "cd" && cdTarget) {
    const cdDecision = evaluateCdTarget(
      cdTarget,
      state,
      startupCwd,
      activePolicy,
      protectedPathRules,
    );
    // evaluateCdTarget returns undefined when the target is allowed; only a
    // concrete ask/deny decision stops the command here.
    if (cdDecision) {
      return { state, decision: cdDecision };
    }
    state = {
      cwd: resolveRequestedPath(cdTarget.value, state.cwd),
      known: true,
    };
  }

  for (const token of tokens) {
    if (
      commandName === "cd" &&
      cdTarget &&
      token.pos === cdTarget.pos &&
      token.end === cdTarget.end
    ) {
      continue;
    }
    const decision = evaluateToken(
      token,
      state,
      startupCwd,
      activePolicy,
      protectedPathRules,
      "bash",
    );
    if (decision) return { state, decision };
  }

  for (const nested of collectNestedCommandScripts(command)) {
    const result = analyzeScript(
      nested,
      { ...state },
      startupCwd,
      activePolicy,
      protectedPathRules,
    );
    if (result.decision) return { state, decision: result.decision };
  }

  return { state };
}

function evaluateToken(
  token: PathToken,
  state: CwdState,
  startupCwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[],
  context: PathContext,
): DecisionWithPath | undefined {
  if (
    token.kind === "pattern" ||
    token.kind === "repository-object" ||
    token.kind === "proven-non-path"
  ) {
    return undefined;
  }

  if (token.kind === "dynamic") {
    if (token.dynamicRole === "argument") return undefined;
    return {
      decision: "ask",
      path: token.value,
      matchPath: token.value,
    };
  }

  // An unrecognized attached option may contain a path-valued operand. The
  // command adapter must extract it before we can resolve it safely.
  if (token.kind === "ambiguous" && token.value.startsWith("-")) {
    return {
      decision: "ask",
      path: token.value,
      matchPath: token.value,
    };
  }

  return evaluateTokenAsPath(
    token,
    state,
    startupCwd,
    activePolicy,
    protectedPathRules,
    context,
  );
}

function evaluateTokenAsPath(
  token: PathToken,
  state: CwdState,
  startupCwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[],
  context: PathContext,
): DecisionWithPath | undefined {
  if (token.kind === "dynamic") {
    return { decision: "ask", path: token.value, matchPath: token.value };
  }

  if (!state.known && !isAbsoluteLike(token.value)) {
    return { decision: "ask", path: token.value, matchPath: token.value };
  }

  const absolutePath = resolveRequestedPath(token.value, state.cwd);
  const decision = evaluatePathByPattern(
    absolutePath,
    startupCwd,
    activePolicy.writePaths,
    "allow",
    context,
    protectedPathRules,
  );
  if (decision.decision === "allow") return undefined;
  return { ...decision, path: absolutePath };
}

/**
 * cd mutates no files, and every later operand is resolved against the
 * tracked cwd and gated individually, so gating the cd target against
 * writePaths would only block navigation, never writes. But cd repositions
 * operand-less readers such as bare `ls`, so the target is gated against
 * readPaths with the `ls` context instead. Dynamic targets and relative
 * targets under an uncertain cwd stay conservative, and protected paths
 * remain off-limits.
 */
function evaluateCdTarget(
  token: PathToken,
  state: CwdState,
  startupCwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[],
): DecisionWithPath | undefined {
  if (token.kind === "dynamic") {
    return { decision: "ask", path: token.value, matchPath: token.value };
  }

  if (!state.known && !isAbsoluteLike(token.value)) {
    return { decision: "ask", path: token.value, matchPath: token.value };
  }

  const absolutePath = resolveRequestedPath(token.value, state.cwd);
  const decision = evaluatePathByPattern(
    absolutePath,
    startupCwd,
    activePolicy.readPaths,
    "allow",
    "ls",
    protectedPathRules,
  );
  if (decision.decision === "allow") return undefined;
  return { ...decision, path: absolutePath };
}

function findCdTarget(command: Command): PathToken | undefined {
  for (const word of command.suffix) {
    const value = staticWordValue(word);
    if (value === undefined) continue;
    if (value === "-") {
      return {
        kind: "dynamic",
        value,
        dynamicRole: "filesystem-reference",
        pos: word.pos,
        end: word.end,
      };
    }
    if (!value.startsWith("-")) {
      const dynamic = isDynamicWord(word);
      return {
        kind: dynamic ? "dynamic" : "filesystem-reference",
        value: dynamic ? word.text : word.value,
        dynamicRole: dynamic ? "filesystem-reference" : undefined,
        pos: word.pos,
        end: word.end,
      };
    }
  }
  return undefined;
}

function collectNestedCommandScripts(command: Command): Script[] {
  const scripts: Script[] = [];
  for (const word of command.suffix) {
    for (const part of word.parts ?? []) {
      if (!isCommandScriptPart(part) || !part.script) continue;
      scripts.push(part.script);
    }
  }
  return scripts;
}

function containsCwdMutation(node: Node): boolean {
  switch (node.type) {
    case "Statement":
      return containsCwdMutation(node.command);
    case "Command":
      return staticWordValue(node.name) === "cd";
    case "Pipeline":
    case "AndOr":
      return node.commands.some((nested) => containsCwdMutation(nested));
    case "Subshell":
    case "BraceGroup":
      return node.body.commands.some((statement) =>
        containsCwdMutation(statement.command),
      );
    case "CompoundList":
      return node.commands.some((statement) =>
        containsCwdMutation(statement.command),
      );
    case "If":
      return (
        containsCwdMutation(node.clause) ||
        containsCwdMutation(node.then) ||
        (node.else ? containsCwdMutation(node.else) : false)
      );
    case "While":
      return containsCwdMutation(node.clause) || containsCwdMutation(node.body);
    case "For":
    case "Select":
    case "ArithmeticFor":
      return containsCwdMutation(node.body);
    case "Case":
      return node.items.some((item) => containsCwdMutation(item.body));
    case "Function":
    case "Coproc":
      return containsCwdMutation(node.body);
    default:
      return false;
  }
}

function collectNestedNodes(node: Node): Node[] {
  switch (node.type) {
    case "Statement":
      return [node.command];
    case "If":
      return [node.clause, node.then, ...(node.else ? [node.else] : [])];
    case "While":
      return [node.clause, node.body];
    case "For":
    case "Select":
    case "ArithmeticFor":
      return [node.body];
    case "Case":
      return node.items.map((item: CaseItem) => item.body);
    case "Function":
    case "Coproc":
      return [node.body];
    case "TestCommand":
      return [];
    default:
      return [];
  }
}

/**
 * Resolve any path-pattern rule set with the shared specificity ordering.
 * Callers supply only their fallback and optional rule eligibility predicate;
 * protected and ordinary path policy intentionally differ only at that edge.
 */
function resolvePathRules<
  RuleType extends { pattern: string; decision: string },
>(
  absolutePath: string,
  startupCwd: string,
  rules: readonly RuleType[],
  defaultDecision: RuleType["decision"],
  isEligible: (rule: RuleType) => boolean = () => true,
): { decision: RuleType["decision"]; rule?: RuleType; matchPath: string } {
  const relativeMatchPath = policyMatchPath(absolutePath, startupCwd);
  const matchPathFor = (rule: RuleType) =>
    rule.pattern.startsWith("/")
      ? normalizePolicyPath(absolutePath)
      : relativeMatchPath;
  const winner = chooseMostSpecific(
    rules,
    (rule) =>
      isEligible(rule) && matchesGlobPattern(rule.pattern, matchPathFor(rule)),
    (rule) => pathPatternSpecificity(rule.pattern),
  );

  if (!winner)
    return { decision: defaultDecision, matchPath: relativeMatchPath };

  return {
    decision: winner.item.decision,
    rule: winner.item,
    matchPath: matchPathFor(winner.item),
  };
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
    // A trailing "/**" matches the directory itself as well as every
    // descendant, so the separator and wildcard are optional together.
    if (
      char === "/" &&
      next === "*" &&
      pattern[i + 2] === "*" &&
      i + 3 === pattern.length
    ) {
      source += "(?:/.*)?";
      i += 2;
      continue;
    }
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
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(char);
    }
  }
  return source;
}

/** True when a literal or glob expression can name a protected path. */
export function isProtectedPathExpression(
  token: string,
  rules: readonly ProtectedPathRule[] = [],
): boolean {
  const normalized = token.replace(/\\/g, "/");
  const candidates = /[?*\[\]]/.test(normalized)
    ? representativeGlobPaths(normalized)
    : [normalized];

  return candidates.some(
    (candidate) =>
      evaluateProtectedPath(candidate, { protectedPathRules: rules })
        .decision === "deny",
  );
}

function representativeGlobPaths(pattern: string): string[] {
  const normalized = pattern.replace(/^!/, "").replace(/\\/g, "/");
  const candidates = ["secret", "secret.txt", "secret.json"];
  return candidates.map((wildcard) =>
    normalized
      .replace(/^\*\*\//, "nested/")
      .replace(/\*\*/g, `nested/${wildcard}`)
      .replace(/\*/g, wildcard)
      .replace(/\?/g, "x"),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.*]/g, "\\$&");
}

function isAbsoluteLike(value: string): boolean {
  return path.isAbsolute(expandHome(value));
}

function staticWordValue(word: Word | undefined): string | undefined {
  if (!word || isDynamicWord(word)) return undefined;
  return word.value;
}

function isDynamicWord(word: Word): boolean {
  return word.parts?.some(isDynamicPart) ?? false;
}

function isDynamicPart(part: WordPart): boolean {
  switch (part.type) {
    case "Literal":
    case "SingleQuoted":
    case "AnsiCQuoted":
      return false;
    case "DoubleQuoted":
    case "LocaleString":
      return part.parts.some(isDynamicPart);
    default:
      return true;
  }
}

function isCommandScriptPart(
  part: WordPart,
): part is CommandExpansionPart | ProcessSubstitutionPart {
  return (
    part.type === "CommandExpansion" || part.type === "ProcessSubstitution"
  );
}
