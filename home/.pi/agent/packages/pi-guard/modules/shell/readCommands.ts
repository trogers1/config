import {
  shellCommandWords,
  shellComposition,
  shellExecutable,
  type ShellComposition,
  type ShellExecutable,
  type ShellWords,
} from "./parse";
import { isProtectedPathExpression } from "./pathPolicy";
import type { ProtectedPathRule } from "../policyHelpers";

export type ParsedReadCommand =
  | { status: "safe"; paths: string[] }
  | { status: "stdin-only" }
  | { status: "unknown"; reason: string };

const readerNames = [
  "cat",
  "head",
  "tail",
  "sed",
  "nl",
  "sort",
  "wc",
  "file",
] as const;

type Reader = (typeof readerNames)[number];

export const readCommandDenialReasons = {
  forwarding: "eval and xargs can forward unvalidated filenames",
  interpreter: "shell interpreter execution cannot be statically validated",
  loop: "shell loops can forward computed filenames",
  pipeline: "piped input is not an approved read source",
} as const;

const forwardingCommands = new Set(["eval", "xargs"]);
const shellInterpreters = new Set(["bash", "sh", "zsh", "dash"]);

function readerFor({ executable }: { executable: string }): Reader | undefined {
  return readerNames.find((reader) => reader === executable);
}

function isReadCommand({ command }: { command: string }): boolean {
  const resolved = shellExecutable({ words: shellCommandWords(command) });
  return (
    resolved.status === "resolved" &&
    readerFor({ executable: resolved.executable }) !== undefined
  );
}

function hasReader({
  composition,
}: {
  composition: ShellComposition;
}): boolean {
  return composition.commands.some((words) =>
    executionHasReader({ execution: shellExecutable({ words }) }),
  );
}

function hasUnknownExecutable({
  composition,
}: {
  composition: ShellComposition;
}): boolean {
  return composition.commands.some(
    (words) => shellExecutable({ words }).status === "unknown-executable",
  );
}

function executionHasReader({
  execution,
}: {
  execution: ShellExecutable;
}): boolean {
  if (execution.status === "unknown") return false;
  if (execution.status === "unknown-executable") return true;
  if (execution.status === "not-executable") return false;
  if (readerFor({ executable: execution.executable }) !== undefined)
    return true;

  if (execution.executable === "xargs")
    return xargsTargetHasReader({ arguments_: execution.arguments_ });
  if (execution.executable === "eval")
    return (
      execution.arguments_.some((argument) => argument === undefined) ||
      scriptHasReader({ script: execution.arguments_.join(" ") })
    );
  if (!shellInterpreters.has(execution.executable)) return false;

  const script = interpreterScript({ arguments_: execution.arguments_ });
  // A literal -c option whose source is dynamic can be an arbitrary reader.
  return script === undefined
    ? hasUnvalidatedInterpreterExecution({ arguments_: execution.arguments_ })
    : scriptHasReader({ script });
}

function scriptHasReader({ script }: { script: string }): boolean {
  return hasReader({ composition: shellComposition({ command: script }) });
}

function xargsTargetHasReader({
  arguments_,
}: {
  arguments_: ShellWords;
}): boolean {
  const target = xargsTarget({ arguments_ });
  // An unrecognized xargs invocation or dynamic target could invoke a reader.
  // Treat it as read-relevant rather than letting forwarding evade the gate.
  if (target === undefined || target.status === "unknown") return true;
  return executionHasReader({ execution: target });
}

function xargsTarget({
  arguments_,
}: {
  arguments_: ShellWords;
}): ShellExecutable | undefined {
  let index = 0;
  while (true) {
    const argument = arguments_[index];
    if (argument === undefined)
      return index === arguments_.length
        ? { status: "resolved", executable: "echo", arguments_: [] }
        : undefined;
    if (argument === "--")
      return shellExecutable({ words: arguments_.slice(index + 1) });
    if (["-0", "-r", "-t", "-p", "-x"].includes(argument)) {
      index++;
      continue;
    }
    if (
      ["-E", "-e", "-I", "-i", "-L", "-l", "-n", "-P", "-s", "-d"].includes(
        argument,
      )
    ) {
      if (arguments_[index + 1] === undefined) return undefined;
      index += 2;
      continue;
    }
    if (argument.startsWith("-")) return undefined;
    return shellExecutable({ words: arguments_.slice(index) });
  }
}

function hasForwardingCommand({
  composition,
}: {
  composition: ShellComposition;
}): boolean {
  return composition.commands.some((words) => {
    const execution = shellExecutable({ words });
    return (
      execution.status === "resolved" &&
      forwardingCommands.has(execution.executable)
    );
  });
}

function hasShellInterpreterExecution({
  composition,
}: {
  composition: ShellComposition;
}): boolean {
  return composition.commands.some((words) => {
    const execution = shellExecutable({ words });
    return (
      execution.status === "resolved" &&
      shellInterpreters.has(execution.executable) &&
      hasUnvalidatedInterpreterExecution({ arguments_: execution.arguments_ })
    );
  });
}

function hasUnvalidatedInterpreterExecution({
  arguments_,
}: {
  arguments_: ShellWords;
}): boolean {
  return (
    arguments_.some((argument) => argument === undefined) ||
    interpreterCommandOptionIndex({ arguments_ }) !== undefined
  );
}

function interpreterScript({
  arguments_,
}: {
  arguments_: ShellWords;
}): string | undefined {
  const commandOption = interpreterCommandOptionIndex({ arguments_ });
  return commandOption === undefined
    ? undefined
    : arguments_[commandOption + 1];
}

function interpreterCommandOptionIndex({
  arguments_,
}: {
  arguments_: ShellWords;
}): number | undefined {
  const optionsWithSeparateValues = new Set([
    "-O",
    "-o",
    "--init-file",
    "--rcfile",
  ]);

  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (argument === undefined || argument === "--") return undefined;
    if (!argument.startsWith("-")) return undefined;
    if (/^-[^-]*c/.test(argument)) return index;
    if (optionsWithSeparateValues.has(argument)) {
      if (arguments_[index + 1] === undefined) return undefined;
      index++;
    }
  }
  return undefined;
}

/** Validates shell-level composition around supported read commands. */
export function validateReadCommands({
  command,
  commandSegments,
  protectedPathRules = [],
}: {
  command: string;
  commandSegments: readonly string[];
  protectedPathRules?: readonly ProtectedPathRule[];
}): string | undefined {
  const composition = shellComposition({ command });

  // Do not attempt data-flow analysis across pipelines, loops, interpreters,
  // eval, or xargs when they can execute a reader. Unknown executable-producing
  // wrappers are read-relevant by definition and therefore fail closed.
  const unknownExecutable = hasUnknownExecutable({ composition });
  if (!unknownExecutable && !hasReader({ composition })) return undefined;
  if (hasForwardingCommand({ composition }))
    return readCommandDenialReasons.forwarding;
  if (unknownExecutable || hasShellInterpreterExecution({ composition }))
    return readCommandDenialReasons.interpreter;

  if (composition.hasPipeline) return readCommandDenialReasons.pipeline;
  if (composition.hasLoop) return readCommandDenialReasons.loop;

  for (const segment of commandSegments) {
    if (!isReadCommand({ command: segment })) continue;
    const parsed = parseReadCommand({ command: segment, protectedPathRules });
    if (parsed.status === "unknown") return parsed.reason;
  }
  return undefined;
}

/**
 * Conservatively identifies file operands for the small, read-only command
 * surface we permit. Unbash supplies the shell words; anything whose command
 * semantics cannot be established from literal arguments is rejected.
 */
export function parseReadCommand({
  command,
  protectedPathRules = [],
}: {
  command: string;
  protectedPathRules?: readonly ProtectedPathRule[];
}): ParsedReadCommand {
  const resolved = shellExecutable({ words: shellCommandWords(command) });
  if (resolved.status !== "resolved")
    return unknown("not a supported read command");
  const reader = readerFor({ executable: resolved.executable });
  if (reader === undefined) return unknown("not a supported read command");

  return parseReader({
    reader,
    tokens: [...resolved.arguments_].filter(isDefined),
    protectedPathRules,
  });
}

function parseReader({
  reader,
  tokens,
  protectedPathRules,
}: {
  reader: Reader;
  tokens: string[];
  protectedPathRules: readonly ProtectedPathRule[];
}): ParsedReadCommand {
  switch (reader) {
    case "cat":
      return parseOperands(tokens, new Set(), protectedPathRules);
    case "head":
    case "tail":
      return parseCountReader(tokens, protectedPathRules);
    case "nl":
      return parseOptions(
        tokens,
        new Set(["b", "l", "n", "s", "w", "i"]),
        new Set(),
        protectedPathRules,
      );
    case "sort":
      return parseSort(tokens, protectedPathRules);
    case "wc":
      return parseOptions(tokens, new Set(), new Set(), protectedPathRules);
    case "file":
      return parseFile(tokens, protectedPathRules);
    case "sed":
      return parseSed(tokens, protectedPathRules);
    default:
      return assertNever({ value: reader });
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function assertNever({ value }: { value: never }): never {
  void value;
  throw new Error("Unsupported reader reached exhaustive dispatch");
}

function parseCountReader(
  tokens: string[],
  protectedPathRules: readonly ProtectedPathRule[],
): ParsedReadCommand {
  return parseOptions(
    tokens,
    new Set(["n", "c", "q"]),
    new Set(["lines", "bytes"]),
    protectedPathRules,
  );
}

function parseSort(
  tokens: string[],
  protectedPathRules: readonly ProtectedPathRule[],
): ParsedReadCommand {
  // --output changes the filesystem; --files0-from makes inputs dynamic.
  if (
    tokens.some(
      (token) =>
        token === "-o" ||
        token.startsWith("--output") ||
        token.startsWith("--files0-from"),
    )
  ) {
    return unknown("sort output and file-list options are not permitted");
  }
  return parseOptions(
    tokens,
    new Set(["k", "S", "T", "t"]),
    new Set(["key", "buffer-size", "temporary-directory", "field-separator"]),
    protectedPathRules,
  );
}

function parseFile(
  tokens: string[],
  protectedPathRules: readonly ProtectedPathRule[],
): ParsedReadCommand {
  if (
    tokens.some((token) => token === "-m" || token.startsWith("--magic-file"))
  ) {
    return unknown("file magic-file options are not permitted");
  }
  return parseOptions(tokens, new Set(), new Set(), protectedPathRules);
}

function parseSed(
  tokens: string[],
  protectedPathRules: readonly ProtectedPathRule[],
): ParsedReadCommand {
  const paths: string[] = [];
  let programSeen = false;
  let endOptions = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!endOptions && token === "--") {
      endOptions = true;
      continue;
    }
    if (
      !endOptions &&
      (token === "-i" ||
        token.startsWith("-i") ||
        token === "--in-place" ||
        token.startsWith("--in-place="))
    ) {
      return unknown("sed in-place editing is not permitted");
    }
    if (!endOptions && (token === "-e" || token === "--expression")) {
      if (!tokens[++i]) return unknown("sed expression is missing");
      programSeen = true;
      continue;
    }
    if (
      !endOptions &&
      (token.startsWith("-e") || token.startsWith("--expression="))
    ) {
      programSeen = true;
      continue;
    }
    if (!endOptions && (token === "-f" || token === "--file")) {
      const file = tokens[++i];
      if (!file) return unknown("sed script file is missing");
      paths.push(file);
      programSeen = true;
      continue;
    }
    if (
      !endOptions &&
      (token.startsWith("-f") || token.startsWith("--file="))
    ) {
      paths.push(
        token.startsWith("-f") ? token.slice(2) : token.slice("--file=".length),
      );
      programSeen = true;
      continue;
    }
    if (!endOptions && token.startsWith("-")) {
      if (/^-[nE]$/.test(token)) continue;
      return unknown(`unsupported sed option: ${token}`);
    }
    if (!programSeen) {
      programSeen = true;
      continue;
    }
    paths.push(token);
  }
  return programSeen
    ? result(paths, protectedPathRules)
    : unknown("sed program is missing");
}

function parseOptions(
  tokens: string[],
  shortWithValue: Set<string>,
  longWithValue = new Set<string>(),
  protectedPathRules: readonly ProtectedPathRule[] = [],
): ParsedReadCommand {
  const paths: string[] = [];
  let endOptions = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!endOptions && token === "--") {
      endOptions = true;
      continue;
    }
    if (!endOptions && token.startsWith("--")) {
      const [name, inline] = token.slice(2).split("=", 2);
      if (longWithValue.has(name)) {
        if (inline === undefined && !tokens[++i])
          return unknown(`option --${name} is missing its value`);
      } else if (
        inline !== undefined ||
        !["quiet", "verbose", "zero", "help", "version"].includes(name)
      )
        return unknown(`unsupported option: ${token}`);
      continue;
    }
    if (!endOptions && token.startsWith("-") && token !== "-") {
      const flags = token.slice(1);
      // A count option may be -n20, -n 20, or clustered only with flags.
      const first = flags[0];
      if (shortWithValue.has(first)) {
        if (flags.length === 1 && !tokens[++i])
          return unknown(`option -${first} is missing its value`);
      } else if (![...flags].every((flag) => "abdfhilnqrsuvwc".includes(flag)))
        return unknown(`unsupported option: ${token}`);
      continue;
    }
    paths.push(token);
  }
  return result(paths, protectedPathRules);
}

function parseOperands(
  tokens: string[],
  options: Set<string>,
  protectedPathRules: readonly ProtectedPathRule[],
): ParsedReadCommand {
  return parseOptions(tokens, options, new Set<string>(), protectedPathRules);
}

function result(
  paths: string[],
  protectedPathRules: readonly ProtectedPathRule[],
): ParsedReadCommand {
  if (
    paths.some(
      (value) =>
        (value.includes("*") || value.includes("?") || value.includes("[")) &&
        !isProtectedPathExpression(value, protectedPathRules),
    )
  )
    return unknown("glob input cannot be proven safe");
  return paths.length === 0
    ? { status: "stdin-only" }
    : { status: "safe", paths };
}

function unknown(reason: string): ParsedReadCommand {
  return { status: "unknown", reason };
}
