import { shellishTokens } from "./parse";
import { isProtectedPathExpression } from "./pathPolicy";

export type ParsedReadCommand =
  | { status: "safe"; paths: string[] }
  | { status: "stdin-only" }
  | { status: "unknown"; reason: string };

const readers = new Set([
  "cat",
  "head",
  "tail",
  "sed",
  "nl",
  "sort",
  "wc",
  "file",
]);

export function isReadCommand(command: string): boolean {
  return readers.has(executable(command));
}

/** Validates shell-level composition around supported read commands. */
export function validateReadCommands(
  command: string,
  commandSegments: string[],
): string | undefined {
  const hasReader =
    commandSegments.some(isReadCommand) ||
    /\b(?:cat|head|tail|sed|nl|sort|wc|file)\b/.test(command);
  if (!hasReader) return undefined;

  // Do not attempt data-flow analysis across pipelines, loops, interpreters,
  // eval, or xargs: their eventual file inputs cannot be proven statically.
  if (/(^|[^|])\|(?!\|)/.test(command))
    return "piped input is not an approved read source";
  if (/\b(?:eval|xargs)\b/.test(command))
    return "eval and xargs can forward unvalidated filenames";
  if (/\b(?:bash|sh|zsh|dash)\s+-[^\n]*c\b/.test(command))
    return "shell interpreter execution cannot be statically validated";
  if (/\b(?:for|while|until)\b/.test(command))
    return "shell loops can forward computed filenames";

  for (const segment of commandSegments) {
    if (!isReadCommand(segment)) continue;
    const parsed = parseReadCommand(segment);
    if (parsed.status === "unknown") return parsed.reason;
  }
  return undefined;
}

/**
 * Conservatively identifies file operands for the small, read-only command
 * surface we permit. This intentionally is not a shell parser: anything that
 * cannot be established from literal arguments is rejected.
 */
export function parseReadCommand(command: string): ParsedReadCommand {
  const tokens = shellishTokens(command);
  while (tokens[0] === "command") tokens.shift();
  const program = tokens.shift();
  if (!program || !readers.has(program))
    return unknown("not a supported read command");
  if (tokens.some(isDynamic))
    return unknown("dynamic shell input cannot be validated");

  switch (program) {
    case "cat":
      return parseOperands(tokens, new Set());
    case "head":
    case "tail":
      return parseCountReader(tokens);
    case "nl":
      return parseOptions(tokens, new Set(["b", "l", "n", "s", "w", "i"]));
    case "sort":
      return parseSort(tokens);
    case "wc":
      return parseOptions(tokens, new Set());
    case "file":
      return parseFile(tokens);
    case "sed":
      return parseSed(tokens);
    default:
      return unknown("unsupported read command");
  }
}

function parseCountReader(tokens: string[]): ParsedReadCommand {
  return parseOptions(
    tokens,
    new Set(["n", "c", "q"]),
    new Set(["lines", "bytes"]),
  );
}

function parseSort(tokens: string[]): ParsedReadCommand {
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
  );
}

function parseFile(tokens: string[]): ParsedReadCommand {
  if (
    tokens.some((token) => token === "-m" || token.startsWith("--magic-file"))
  ) {
    return unknown("file magic-file options are not permitted");
  }
  return parseOptions(tokens, new Set());
}

function parseSed(tokens: string[]): ParsedReadCommand {
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
  return programSeen ? result(paths) : unknown("sed program is missing");
}

function parseOptions(
  tokens: string[],
  shortWithValue: Set<string>,
  longWithValue = new Set<string>(),
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
  return result(paths);
}

function parseOperands(
  tokens: string[],
  options: Set<string>,
): ParsedReadCommand {
  return parseOptions(tokens, options);
}

function result(paths: string[]): ParsedReadCommand {
  if (
    paths.some(
      (value) =>
        (value.includes("*") || value.includes("?") || value.includes("[")) &&
        !isProtectedPathExpression(value),
    )
  )
    return unknown("glob input cannot be proven safe");
  return paths.length === 0
    ? { status: "stdin-only" }
    : { status: "safe", paths };
}

function executable(command: string): string {
  const tokens = shellishTokens(command);
  while (tokens[0] === "command") tokens.shift();
  return tokens[0] ?? "";
}

function isDynamic(value: string): boolean {
  return (
    value.includes("$") ||
    value.includes("`") ||
    value.includes("{") ||
    value.includes("}")
  );
}

function unknown(reason: string): ParsedReadCommand {
  return { status: "unknown", reason };
}
