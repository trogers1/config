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
  Rule,
} from "../policyHelpers";
import {
  pathPatternSpecificity,
  rankMatchingRules,
  type RankedItem,
} from "../ruleSpecificity";
import { classifyCommandTokens, type ShellTokenKind } from "./classify";

export type PolicyDecision = {
  decision: Decision;
  rule?: PathRule;
};

type PathPolicyTrace = {
  protectedMatches: Array<RankedItem<ProtectedPathRule>>;
  pathMatches: Array<RankedItem<PathRule>>;
};

export type PathPolicyDecision = PolicyDecision & {
  matchPath: string;
  trace?: PathPolicyTrace;
};

export type BashPathReferenceTrace = PathPolicyTrace & {
  path: string;
  matchPath: string;
  context: PathContext;
};

export type BashPathReferenceAnalysis = {
  decision?: DecisionWithPath;
  trace?: BashPathReferenceTrace;
};

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

type BashPathTraceSink = {
  first?: BashPathReferenceTrace;
  blocking?: BashPathReferenceTrace;
};

function recordBashPathTrace(
  sink: BashPathTraceSink | undefined,
  trace: BashPathReferenceTrace,
  decision: Decision,
): void {
  if (!sink) return;
  if (!sink.first) sink.first = trace;
  if (decision !== "allow" && !sink.blocking) sink.blocking = trace;
}

function pathTraceFromDecision(
  decision: PathPolicyDecision,
  path: string,
  matchPath: string,
  context: PathContext,
): BashPathReferenceTrace {
  return {
    path,
    matchPath,
    context,
    protectedMatches: decision.trace?.protectedMatches ?? [],
    pathMatches: decision.trace?.pathMatches ?? [],
  };
}

export function analyzeBashPathReferences(
  commandSegments: string[],
  startupCwd: string,
  cwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[] = [],
  stopOnAsk = true,
): BashPathReferenceAnalysis {
  let state: CwdState = { cwd, known: true };
  const traceSink: BashPathTraceSink = {};

  for (const segment of commandSegments) {
    const script = parse(segment);
    const result = analyzeScript(
      script,
      state,
      startupCwd,
      activePolicy,
      protectedPathRules,
      stopOnAsk,
      traceSink,
    );
    state = result.state;
    if (result.decision) {
      return {
        decision: result.decision,
        trace: result.trace ?? traceSink.blocking ?? traceSink.first,
      };
    }
  }

  return { trace: traceSink.blocking ?? traceSink.first };
}

export function decideBashPathReferences(
  commandSegments: string[],
  startupCwd: string,
  cwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[] = [],
  stopOnAsk = true,
): DecisionWithPath | undefined {
  return analyzeBashPathReferences(
    commandSegments,
    startupCwd,
    cwd,
    activePolicy,
    protectedPathRules,
    stopOnAsk,
  ).decision;
}

/** Evaluate only the always-first protected-path stage for Bash operands. */
export function decideProtectedBashPathReferences(
  commandSegments: string[],
  startupCwd: string,
  cwd: string,
  protectedPathRules: readonly ProtectedPathRule[],
): DecisionWithPath | undefined {
  const permissivePolicy: ProfilePolicy = {
    tools: {},
    readPaths: [],
    writePaths: [],
  };
  const decision = decideBashPathReferences(
    commandSegments,
    startupCwd,
    cwd,
    permissivePolicy,
    protectedPathRules,
    false,
  );
  return decision?.decision === "deny" ? decision : undefined;
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
    undefined,
    context,
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
      trace: {
        protectedMatches: protectedDecision.ranked,
        pathMatches: ordinaryDecision.ranked,
      },
    };
  }

  return {
    ...ordinaryDecision,
    trace: {
      protectedMatches: protectedDecision.ranked,
      pathMatches: ordinaryDecision.ranked,
    },
  };
}

export function evaluateProtectedPath(
  requestedPath: string,
  policy: { protectedPathRules?: readonly ProtectedPathRule[] },
  startupCwd = process.cwd(),
): { decision: "allow" | "deny"; rule?: ProtectedPathRule; matchPath: string } {
  const absolutePath = resolveRequestedPath(requestedPath, startupCwd);
  const decision = resolvePathRules(
    absolutePath,
    startupCwd,
    policy.protectedPathRules ?? [],
    "allow",
  );
  return {
    decision: decision.decision,
    rule: decision.rule,
    matchPath: decision.matchPath,
  };
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
  stopOnAsk: boolean,
  traceSink?: BashPathTraceSink,
): {
  state: CwdState;
  decision?: DecisionWithPath;
  trace?: BashPathReferenceTrace;
} {
  let currentState = state;
  let trace: BashPathReferenceTrace | undefined;
  for (const statement of script.commands) {
    const previousState = currentState;
    const result = analyzeStatement(
      statement,
      currentState,
      startupCwd,
      activePolicy,
      protectedPathRules,
      stopOnAsk,
      traceSink,
    );
    currentState = applySimpleCdState(statement, previousState, result.state);
    trace ??= result.trace;
    if (result.decision && shouldStop(result.decision, stopOnAsk)) {
      return { ...result, state: currentState, trace: trace ?? result.trace };
    }
  }
  return { state: currentState, trace };
}

function analyzeStatement(
  statement: Statement,
  state: CwdState,
  startupCwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[],
  stopOnAsk: boolean,
  traceSink?: BashPathTraceSink,
): {
  state: CwdState;
  decision?: DecisionWithPath;
  trace?: BashPathReferenceTrace;
} {
  return analyzeNode(
    statement.command,
    state,
    startupCwd,
    activePolicy,
    protectedPathRules,
    stopOnAsk,
    traceSink,
  );
}

function analyzeNode(
  node: Node,
  state: CwdState,
  startupCwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[],
  stopOnAsk: boolean,
  traceSink?: BashPathTraceSink,
): {
  state: CwdState;
  decision?: DecisionWithPath;
  trace?: BashPathReferenceTrace;
} {
  switch (node.type) {
    case "Statement":
      return analyzeNode(
        node.command,
        state,
        startupCwd,
        activePolicy,
        protectedPathRules,
        stopOnAsk,
        traceSink,
      );
    case "Command":
      return analyzeCommand(
        node,
        state,
        startupCwd,
        activePolicy,
        protectedPathRules,
        stopOnAsk,
        traceSink,
      );
    case "CompoundList":
      return analyzeCompoundList(
        node,
        state,
        startupCwd,
        activePolicy,
        protectedPathRules,
        stopOnAsk,
        traceSink,
      );
    case "BraceGroup":
      return analyzeCompoundList(
        node.body,
        state,
        startupCwd,
        activePolicy,
        protectedPathRules,
        stopOnAsk,
        traceSink,
      );
    case "Subshell": {
      const nested = analyzeCompoundList(
        node.body,
        { ...state },
        startupCwd,
        activePolicy,
        protectedPathRules,
        stopOnAsk,
        traceSink,
      );
      return { state, decision: nested.decision, trace: nested.trace };
    }
    case "Pipeline":
      if (node.commands.length > 1 && containsCwdMutation(node)) {
        if (stopOnAsk) return uncertainCwdDecision(state, "pipeline CWD");
        const unknownState = { ...state, known: false };
        return analyzeNestedNodes(
          node.commands,
          unknownState,
          startupCwd,
          activePolicy,
          protectedPathRules,
          unknownState,
          stopOnAsk,
          traceSink,
        );
      }
      if (node.commands.length === 1) {
        return analyzeNode(
          node.commands[0],
          state,
          startupCwd,
          activePolicy,
          protectedPathRules,
          stopOnAsk,
          traceSink,
        );
      }
      return analyzeNestedNodes(
        node.commands,
        state,
        startupCwd,
        activePolicy,
        protectedPathRules,
        containsCwdMutation(node) ? { ...state, known: false } : state,
        stopOnAsk,
        traceSink,
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
        if (stopOnAsk) return uncertainCwdDecision(state, "conditional CWD");
        const unknownState = { ...state, known: false };
        return analyzeNestedNodes(
          node.commands,
          unknownState,
          startupCwd,
          activePolicy,
          protectedPathRules,
          unknownState,
          stopOnAsk,
          traceSink,
        );
      }
      if (node.commands.length === 1) {
        return analyzeNode(
          node.commands[0],
          state,
          startupCwd,
          activePolicy,
          protectedPathRules,
          stopOnAsk,
          traceSink,
        );
      }
      const andOrResult = analyzeSequentialNodes(
        node.commands,
        state,
        startupCwd,
        activePolicy,
        protectedPathRules,
        stopOnAsk,
        traceSink,
      );
      // Within an && chain a later command only runs when every earlier
      // command succeeded, so static cd tracking is sound inside the chain.
      // The chain itself may stop before its cd commands run, so the cwd
      // afterwards cannot be proven.
      if (containsCwdMutation(node)) {
        return {
          decision: andOrResult.decision,
          state: { ...state, known: false },
          trace: andOrResult.trace,
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
      return analyzeUnsupportedNode(
        node,
        state,
        startupCwd,
        activePolicy,
        protectedPathRules,
        stopOnAsk,
        traceSink,
      );
    case "ArithmeticFor":
      return stopOnAsk
        ? opaqueExpressionDecision(state, "Bash arithmetic for expression")
        : analyzeUnsupportedNode(
            node,
            state,
            startupCwd,
            activePolicy,
            protectedPathRules,
            stopOnAsk,
            traceSink,
          );
    case "TestCommand":
      return opaqueExpressionDecision(state, "Bash [[ ... ]] expression");
    case "ArithmeticCommand":
      return opaqueExpressionDecision(
        state,
        "Bash (( ... )) arithmetic expression",
      );
    default:
      return { state };
  }
}

function opaqueExpressionDecision(
  state: CwdState,
  description: string,
): { state: CwdState; decision: DecisionWithPath } {
  return {
    state,
    decision: {
      decision: "ask",
      path: description,
      matchPath: description,
    },
  };
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
  stopOnAsk: boolean,
  traceSink?: BashPathTraceSink,
): {
  state: CwdState;
  decision?: DecisionWithPath;
  trace?: BashPathReferenceTrace;
} {
  let currentState = state;
  let trace: BashPathReferenceTrace | undefined;
  for (const statement of list.commands) {
    const previousState = currentState;
    const result = analyzeStatement(
      statement,
      currentState,
      startupCwd,
      activePolicy,
      protectedPathRules,
      stopOnAsk,
      traceSink,
    );
    currentState = applySimpleCdState(statement, previousState, result.state);
    trace ??= result.trace;
    if (result.decision && shouldStop(result.decision, stopOnAsk)) {
      return { ...result, state: currentState, trace: trace ?? result.trace };
    }
  }
  return { state: currentState, trace };
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
    if (isDynamicWord(word)) return undefined;
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
  stopOnAsk: boolean,
  traceSink?: BashPathTraceSink,
): {
  state: CwdState;
  decision?: DecisionWithPath;
  trace?: BashPathReferenceTrace;
} {
  let currentState = { ...state };
  let trace: BashPathReferenceTrace | undefined;
  for (const nested of nodes) {
    const result = analyzeNode(
      nested,
      currentState,
      startupCwd,
      activePolicy,
      protectedPathRules,
      stopOnAsk,
      traceSink,
    );
    currentState = result.state;
    trace ??= result.trace;
    if (result.decision && shouldStop(result.decision, stopOnAsk))
      return { ...result, trace: trace ?? result.trace };
  }
  return { state: currentState, trace };
}

function analyzeNestedNodes(
  nodes: readonly Node[],
  state: CwdState,
  startupCwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[],
  finalState: CwdState,
  stopOnAsk: boolean,
  traceSink?: BashPathTraceSink,
): {
  state: CwdState;
  decision?: DecisionWithPath;
  trace?: BashPathReferenceTrace;
} {
  let currentState = { ...state };
  let trace: BashPathReferenceTrace | undefined;
  for (const nested of nodes) {
    const result = analyzeNode(
      nested,
      currentState,
      startupCwd,
      activePolicy,
      protectedPathRules,
      stopOnAsk,
      traceSink,
    );
    currentState = result.state;
    trace ??= result.trace;
    if (result.decision && shouldStop(result.decision, stopOnAsk))
      return { ...result, trace: trace ?? result.trace };
  }
  return { state: finalState, trace };
}

function analyzeUnsupportedNode(
  node: Node,
  state: CwdState,
  startupCwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[],
  stopOnAsk: boolean,
  traceSink?: BashPathTraceSink,
): {
  state: CwdState;
  decision?: DecisionWithPath;
  trace?: BashPathReferenceTrace;
} {
  const hasCwdMutation = containsCwdMutation(node);
  if (hasCwdMutation && stopOnAsk) {
    return uncertainCwdDecision(state, "conditional CWD");
  }
  const nestedNodes = collectNestedNodes(node);
  const analysisState = hasCwdMutation ? { ...state, known: false } : state;
  return analyzeNestedNodes(
    nestedNodes,
    analysisState,
    startupCwd,
    activePolicy,
    protectedPathRules,
    analysisState,
    stopOnAsk,
    traceSink,
  );
}

function analyzeCommand(
  command: Command,
  state: CwdState,
  startupCwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[],
  stopOnAsk: boolean,
  traceSink?: BashPathTraceSink,
): {
  state: CwdState;
  decision?: DecisionWithPath;
  trace?: BashPathReferenceTrace;
} {
  const commandName = staticWordValue(command.name);
  const tokens = classifyCommandTokens(
    command,
    commandName
      ? policyDeclaredSubcommands(commandName, activePolicy.tools.bash ?? [])
      : [],
  );
  const cdTarget = commandName === "cd" ? findCdTarget(command) : undefined;

  if (commandName === "cd" && cdTarget) {
    const cdDecision = evaluateCdTarget(
      cdTarget,
      state,
      startupCwd,
      activePolicy,
      protectedPathRules,
      traceSink,
    );
    if (cdDecision) {
      if (shouldStop(cdDecision, stopOnAsk)) {
        return {
          state,
          decision: cdDecision,
          trace: traceSink?.blocking ?? traceSink?.first,
        };
      }
      // A deny-first pass ignores asks. Static targets still establish an
      // exact CWD for later operands; only dynamic targets make it unknown.
      state =
        cdTarget.kind === "filesystem-reference"
          ? {
              cwd: resolveRequestedPath(cdTarget.value, state.cwd),
              known: true,
            }
          : { ...state, known: false };
    } else {
      state = {
        cwd: resolveRequestedPath(cdTarget.value, state.cwd),
        known: true,
      };
    }
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
      traceSink,
    );
    if (decision && shouldStop(decision, stopOnAsk)) {
      return {
        state,
        decision,
        trace: traceSink?.blocking ?? traceSink?.first,
      };
    }
  }

  for (const nested of collectNestedCommandScripts(command)) {
    const result = analyzeScript(
      nested,
      { ...state },
      startupCwd,
      activePolicy,
      protectedPathRules,
      stopOnAsk,
      traceSink,
    );
    if (result.decision && shouldStop(result.decision, stopOnAsk)) {
      return {
        state,
        decision: result.decision,
        trace: result.trace ?? traceSink?.blocking ?? traceSink?.first,
      };
    }
  }

  const opaqueExpression = opaqueCommandExpression(commandName);
  return opaqueExpression
    ? {
        ...opaqueExpressionDecision(state, opaqueExpression),
        trace: traceSink?.first,
      }
    : { state, trace: traceSink?.first };
}

function policyDeclaredSubcommands(
  commandName: string,
  rules: readonly Rule[],
): string[] {
  const subcommands = new Set<string>();
  for (const { pattern } of rules) {
    const [executable, subcommand] = pattern.trim().split(/\s+/, 3);
    if (executable === commandName && subcommand && !/[?*]/.test(subcommand)) {
      subcommands.add(subcommand);
    }
  }
  return [...subcommands];
}

function opaqueCommandExpression(
  commandName: string | undefined,
): string | null {
  switch (commandName) {
    case "[":
      return "Bash [ ... ] expression";
    case "test":
      return "Bash test expression";
    case "let":
      return "Bash let arithmetic expression";
    default:
      return null;
  }
}

function shouldStop(decision: DecisionWithPath, stopOnAsk: boolean): boolean {
  return decision.decision === "deny" || stopOnAsk;
}

function evaluateToken(
  token: PathToken,
  state: CwdState,
  startupCwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[],
  context: PathContext,
  traceSink?: BashPathTraceSink,
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
    traceSink,
  );
}

function evaluateTokenAsPath(
  token: PathToken,
  state: CwdState,
  startupCwd: string,
  activePolicy: ProfilePolicy,
  protectedPathRules: readonly ProtectedPathRule[],
  context: PathContext,
  traceSink?: BashPathTraceSink,
): DecisionWithPath | undefined {
  if (token.kind === "dynamic") {
    return { decision: "ask", path: token.value, matchPath: token.value };
  }

  if (!state.known && !isAbsoluteLike(token.value)) {
    const protectedDecision = evaluateUncertainRelativeProtectedPath(
      token.value,
      startupCwd,
      protectedPathRules,
      context,
    );
    if (protectedDecision) {
      if (traceSink)
        recordBashPathTrace(
          traceSink,
          pathTraceFromDecision(
            protectedDecision,
            resolveRequestedPath(token.value, startupCwd),
            protectedDecision.matchPath,
            context,
          ),
          protectedDecision.decision,
        );
      return protectedDecision;
    }
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
  if (traceSink) {
    recordBashPathTrace(
      traceSink,
      pathTraceFromDecision(
        decision,
        absolutePath,
        decision.matchPath,
        context,
      ),
      decision.decision,
    );
  }
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
  traceSink?: BashPathTraceSink,
): DecisionWithPath | undefined {
  if (token.kind === "dynamic") {
    return { decision: "ask", path: token.value, matchPath: token.value };
  }

  if (!state.known && !isAbsoluteLike(token.value)) {
    const protectedDecision = evaluateUncertainRelativeProtectedPath(
      token.value,
      startupCwd,
      protectedPathRules,
      "ls",
    );
    if (protectedDecision) {
      if (traceSink)
        recordBashPathTrace(
          traceSink,
          pathTraceFromDecision(
            protectedDecision,
            resolveRequestedPath(token.value, startupCwd),
            protectedDecision.matchPath,
            "ls",
          ),
          protectedDecision.decision,
        );
      return protectedDecision;
    }
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
  if (traceSink) {
    recordBashPathTrace(
      traceSink,
      pathTraceFromDecision(decision, absolutePath, decision.matchPath, "ls"),
      decision.decision,
    );
  }
  if (decision.decision === "allow") return undefined;
  return { ...decision, path: absolutePath };
}

function evaluateUncertainRelativeProtectedPath(
  value: string,
  startupCwd: string,
  protectedPathRules: readonly ProtectedPathRule[],
  context: PathContext,
): DecisionWithPath | undefined {
  // The actual working directory is unknowable after control-flow such as a
  // pipeline containing `cd`. A relative operand can nevertheless name a
  // protected file (notably `.env`) in that directory. Use the startup root
  // solely to apply relative glob rules; no ordinary path rule is evaluated
  // here, because its outcome remains genuinely uncertain.
  const candidate = resolveRequestedPath(value, startupCwd);
  const decision = evaluatePathByPattern(
    candidate,
    startupCwd,
    [],
    "allow",
    context,
    protectedPathRules,
  );
  return decision.decision === "deny"
    ? { ...decision, path: candidate }
    : undefined;
}

function findCdTarget(command: Command): PathToken | undefined {
  for (const word of command.suffix) {
    const value = staticWordValue(word);
    if (value === undefined) {
      if (isDynamicWord(word)) {
        return {
          kind: "dynamic",
          value: word.text,
          dynamicRole: "filesystem-reference",
          pos: word.pos,
          end: word.end,
        };
      }
      continue;
    }
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
  const collectFromWords = (words: readonly Word[]): void => {
    for (const word of words) {
      for (const part of word.parts ?? []) {
        if (!isCommandScriptPart(part) || !part.script) continue;
        scripts.push(part.script);
      }
    }
  };

  collectFromWords(command.suffix);
  // Assignment prefixes execute their expansions before the command itself.
  // Their values are Words too, but are not command suffixes, so they need
  // explicit traversal to prevent `VALUE=$(reader protected-file)` bypasses.
  for (const assignment of command.prefix) {
    if (assignment.value) collectFromWords([assignment.value]);
    if (assignment.array) collectFromWords(assignment.array);
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
export function rankPathRules<
  RuleType extends {
    pattern: string;
    decision: string;
    contexts?: readonly PathContext[];
  },
>(
  absolutePath: string,
  startupCwd: string,
  rules: readonly RuleType[],
  context?: PathContext,
): RankedItem<RuleType>[] {
  const relativeMatchPath = policyMatchPath(absolutePath, startupCwd);
  return rankMatchingRules(
    rules,
    (rule) => {
      if (context && rule.contexts && !rule.contexts.includes(context)) {
        return false;
      }
      const matchPath = rule.pattern.startsWith("/")
        ? normalizePolicyPath(absolutePath)
        : relativeMatchPath;
      return matchesGlobPattern(rule.pattern, matchPath);
    },
    (rule) => pathPatternSpecificity(rule.pattern),
  );
}

function resolvePathRules<
  RuleType extends {
    pattern: string;
    decision: string;
    contexts?: readonly PathContext[];
  },
>(
  absolutePath: string,
  startupCwd: string,
  rules: readonly RuleType[],
  defaultDecision: RuleType["decision"],
  isEligible: (rule: RuleType) => boolean = () => true,
  context?: PathContext,
): {
  decision: RuleType["decision"];
  rule?: RuleType;
  matchPath: string;
  ranked: Array<RankedItem<RuleType>>;
} {
  const relativeMatchPath = policyMatchPath(absolutePath, startupCwd);
  const matchPathFor = (rule: RuleType) =>
    rule.pattern.startsWith("/")
      ? normalizePolicyPath(absolutePath)
      : relativeMatchPath;
  const ranked = rankPathRules(absolutePath, startupCwd, rules, context);
  const winner = ranked.find((rankedRule) => isEligible(rankedRule.item));

  if (!winner) {
    return { decision: defaultDecision, matchPath: relativeMatchPath, ranked };
  }

  return {
    decision: winner.item.decision,
    rule: winner.item,
    matchPath: matchPathFor(winner.item),
    ranked,
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
