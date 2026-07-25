import {
  parse,
  type Command,
  type ParseError,
  type Redirect,
  type RedirectOperator,
  type Word,
  type WordPart,
} from "unbash";

export type ShellTokenKind =
  | "ambiguous"
  | "filesystem-reference"
  | "redirection-target"
  | "pattern"
  | "repository-object"
  | "proven-non-path"
  | "dynamic";

type ClassifiedShellToken = {
  kind: ShellTokenKind;
  value: string;
  dynamicRole?: "argument" | "filesystem-reference" | "redirection-target";
  pos: number;
  end: number;
  command?: string;
};

export type ShellClassification = {
  tokens: ClassifiedShellToken[];
  errors: ParseError[];
  cwdChange?: string;
};

const gitObjectSubcommands = new Set([
  "show",
  "diff",
  "log",
  "blame",
  "rev-parse",
  "rev-list",
  "merge-base",
  "cat-file",
  "ls-tree",
  "show-branch",
  "for-each-ref",
  "name-rev",
  "describe",
  "branch",
  "tag",
  "stash",
]);
const readerCommands = new Set([
  "cat",
  "head",
  "tail",
  "sed",
  "nl",
  "sort",
  "wc",
  "file",
]);
const packageManagerCommands = new Set(["npm", "pnpm", "yarn"]);
const fileRedirectOperators = new Set<RedirectOperator>([
  ">",
  ">>",
  "<",
  "<>",
  ">&",
  ">|",
  "&>",
  "&>>",
]);

/**
 * Experimental AST-backed shell operand classifier.
 *
 * This deliberately separates shell syntax from command semantics. Unbash
 * identifies words, nested commands, and redirections; the small adapters
 * below identify arguments whose meaning is specific to Git or ripgrep.
 */
export function classifyShell(command: string): ShellClassification {
  const script = parse(command);
  const tokens: ClassifiedShellToken[] = [];

  walkAst(script, (node) => {
    if (isCommand(node)) tokens.push(...classifyCommandTokens(node));
  });

  return {
    tokens: tokens.sort((left, right) => left.pos - right.pos),
    errors: script.errors ?? [],
    cwdChange: topLevelCdTarget(script.commands[0]?.command),
  };
}

export function classifyCommandTokens(
  command: Command,
): ClassifiedShellToken[] {
  const commandName = staticWordValue(command.name);
  const tokens = command.suffix.map((word) =>
    classifyArgument(word, commandName),
  );
  for (const redirect of command.redirects) {
    const token = classifyRedirect(redirect);
    if (token) tokens.push(token);
  }

  if (commandName === "rg" || commandName === "ripgrep") {
    classifyRipgrepPatterns(command.suffix, tokens);
  }
  if (commandName === "git") classifyGitArguments(command.suffix, tokens);
  if (commandName === "cd") classifyCdTarget(command.suffix, tokens);
  if (commandName && readerCommands.has(commandName)) {
    classifyReaderArguments(commandName, command.suffix, tokens);
  }
  if (commandName && packageManagerCommands.has(commandName)) {
    classifyPackageManagerArguments(command.suffix, tokens);
  }
  if (commandName === "find") classifyFindArguments(command.suffix, tokens);

  return tokens;
}

function classifyArgument(
  word: Word,
  command: string | undefined,
): ClassifiedShellToken {
  const dynamic = isDynamicWord(word);
  const value = dynamic ? word.text : word.value;
  if (value === "--") {
    return {
      kind: "proven-non-path",
      value,
      pos: word.pos,
      end: word.end,
      command,
    };
  }
  return {
    kind: dynamic
      ? "dynamic"
      : /^--[A-Za-z][A-Za-z0-9-]*$/.test(value) || /^-[A-Za-z]$/.test(value)
        ? "proven-non-path"
        : "ambiguous",
    value,
    dynamicRole: undefined,
    pos: word.pos,
    end: word.end,
    command,
  };
}

function classifyCdTarget(words: Word[], tokens: ClassifiedShellToken[]): void {
  const targetIndex = words.findIndex((word, index) => {
    const value = staticWordValue(word);
    return value === undefined
      ? tokens[index]?.kind === "dynamic"
      : !value.startsWith("-");
  });
  if (targetIndex >= 0 && tokens[targetIndex]?.kind === "ambiguous") {
    tokens[targetIndex].kind = "filesystem-reference";
    return;
  }
  if (targetIndex >= 0 && tokens[targetIndex]?.kind === "dynamic") {
    tokens[targetIndex].dynamicRole = "filesystem-reference";
    return;
  }
  if (
    (words[0] && staticWordValue(words[0]) === "-") ||
    words.some((word) => staticWordValue(word) === "-")
  ) {
    const dashIndex = words.findIndex((word) => staticWordValue(word) === "-");
    if (dashIndex >= 0) {
      tokens[dashIndex] = {
        ...tokens[dashIndex],
        kind: "dynamic",
        dynamicRole: "filesystem-reference",
      };
    }
  }
}

function topLevelCdTarget(node: unknown): string | undefined {
  if (!isCommand(node) || staticWordValue(node.name) !== "cd") return undefined;
  for (const word of node.suffix) {
    const value = staticWordValue(word);
    if (value !== undefined && !value.startsWith("-")) return value;
  }
  return "~";
}

function classifyRipgrepPatterns(
  words: Word[],
  tokens: ClassifiedShellToken[],
): void {
  let seenSearchPattern = false;
  for (let index = 0; index < words.length; index++) {
    const value = staticWordValue(words[index]);
    if (!value) continue;

    if (value === "--") {
      seenSearchPattern = true;
      continue;
    }

    if (value === "--ignore-file" || value === "--file" || value === "-f") {
      tokens[index].kind = "proven-non-path";
      const file = tokens[index + 1];
      if (file) {
        if (file.kind === "dynamic") file.dynamicRole = "filesystem-reference";
        else file.kind = "filesystem-reference";
      }
      index++;
      continue;
    }

    const attachedFileOption = ["--ignore-file=", "--file="].find((prefix) =>
      value.startsWith(prefix),
    );
    if (attachedFileOption) {
      tokens[index] = {
        ...tokens[index],
        kind: "filesystem-reference",
        value: value.slice(attachedFileOption.length),
      };
      continue;
    }

    if (value.startsWith("-f") && value !== "-f") {
      tokens[index] = {
        ...tokens[index],
        kind: "filesystem-reference",
        value: value.slice(2),
      };
      continue;
    }

    if (value === "--glob" || value === "-g") {
      const pattern = tokens[index + 1];
      if (pattern) {
        if (pattern.kind === "dynamic") pattern.dynamicRole = "argument";
        pattern.kind = "pattern";
      }
      index++;
      continue;
    }

    if (value === "--regexp" || value === "-e") {
      const pattern = tokens[index + 1];
      if (pattern) {
        if (pattern.kind === "dynamic") pattern.dynamicRole = "argument";
        pattern.kind = "pattern";
      }
      seenSearchPattern = true;
      index++;
      continue;
    }

    if (value.startsWith("--glob=")) {
      tokens[index] = {
        ...tokens[index],
        kind: "pattern",
        value: value.slice("--glob=".length),
      };
      continue;
    }

    if (value.startsWith("-g") && value !== "-g") {
      tokens[index] = {
        ...tokens[index],
        kind: "pattern",
        value: value.slice(2),
      };
      continue;
    }

    if (!value.startsWith("-") && !seenSearchPattern) {
      tokens[index] = {
        ...tokens[index],
        kind: "pattern",
      };
      seenSearchPattern = true;
    }
  }
}

function classifyGitArguments(
  words: Word[],
  tokens: ClassifiedShellToken[],
): void {
  let subcommand: string | undefined;
  let afterDoubleDash = false;
  let diffNoIndex = false;

  for (let index = 0; index < words.length; index++) {
    const value = staticWordValue(words[index]);
    if (!value) {
      if (
        (afterDoubleDash || diffNoIndex) &&
        tokens[index]?.kind === "dynamic"
      ) {
        tokens[index].dynamicRole = "filesystem-reference";
      }
      continue;
    }

    if (value === "--") {
      afterDoubleDash = true;
      continue;
    }

    if (!subcommand && !value.startsWith("-")) {
      subcommand = value;
      tokens[index].kind = "proven-non-path";
      continue;
    }

    if (value === "-c") {
      const configToken = tokens[index + 1];
      if (configToken?.kind === "ambiguous") {
        configToken.kind = "proven-non-path";
      }
      index++;
      continue;
    }

    const detachedGitValueOptions = new Set([
      "--max-count",
      "--format",
      "--pretty",
      "--abbrev",
      "--since",
      "--until",
      "--author",
      "--grep",
      "--sort",
    ]);
    if (detachedGitValueOptions.has(value)) {
      tokens[index].kind = "proven-non-path";
      const optionValue = tokens[index + 1];
      if (optionValue?.kind === "ambiguous") {
        optionValue.kind = "proven-non-path";
      } else if (optionValue?.kind === "dynamic") {
        optionValue.dynamicRole = "argument";
      }
      index++;
      continue;
    }

    if (value === "-C" || value === "--git-dir" || value === "--work-tree") {
      const pathToken = tokens[index + 1];
      if (pathToken?.kind === "ambiguous") {
        pathToken.kind = "filesystem-reference";
      } else if (pathToken?.kind === "dynamic") {
        pathToken.dynamicRole = "filesystem-reference";
      }
      index++;
      continue;
    }

    if (value.startsWith("--git-dir=") || value.startsWith("--work-tree=")) {
      const separator = value.indexOf("=");
      tokens[index] = {
        ...tokens[index],
        kind: "filesystem-reference",
        value: value.slice(separator + 1),
      };
      continue;
    }

    if (
      [
        "--max-count=",
        "--format=",
        "--pretty=",
        "--abbrev=",
        "--since=",
        "--until=",
        "--author=",
        "--grep=",
        "--sort=",
      ].some((prefix) => value.startsWith(prefix))
    ) {
      tokens[index].kind = "proven-non-path";
      continue;
    }

    if (subcommand === "diff" && value === "--no-index") {
      diffNoIndex = true;
      tokens[index].kind = "proven-non-path";
      continue;
    }

    if (afterDoubleDash || diffNoIndex) {
      if (tokens[index].kind === "dynamic") {
        tokens[index].dynamicRole = "filesystem-reference";
      } else if (tokens[index].kind === "ambiguous") {
        tokens[index].kind = "filesystem-reference";
      }
      continue;
    }

    if (
      subcommand &&
      gitObjectSubcommands.has(subcommand) &&
      tokens[index].kind === "ambiguous" &&
      (looksLikeGitObjectSpec(value) || looksLikeGitRevision(value))
    ) {
      tokens[index].kind = "repository-object";
      continue;
    }
  }
}

function classifyReaderArguments(
  command: string,
  words: Word[],
  tokens: ClassifiedShellToken[],
): void {
  let sedProgramSeen = command !== "sed";
  for (let index = 0; index < words.length; index++) {
    const value = staticWordValue(words[index]);
    const token = tokens[index];
    if (!token) continue;

    if (value === "-e" || value === "--expression") {
      const program = tokens[index + 1];
      if (program) program.kind = "proven-non-path";
      sedProgramSeen = true;
      index++;
      continue;
    }
    if (
      command !== "sed" &&
      ["-n", "--lines", "-c", "--bytes"].includes(value ?? "")
    ) {
      const optionValue = tokens[index + 1];
      if (optionValue) optionValue.kind = "proven-non-path";
      index++;
      continue;
    }
    if (value?.startsWith("-")) continue;
    if (!sedProgramSeen) {
      token.kind = "proven-non-path";
      sedProgramSeen = true;
      continue;
    }
    if (token.kind === "dynamic") token.dynamicRole = "filesystem-reference";
    else token.kind = "filesystem-reference";
  }
}

function classifyPackageManagerArguments(
  words: Word[],
  tokens: ClassifiedShellToken[],
): void {
  const commandIndex = words.findIndex((word) => {
    const value = staticWordValue(word);
    return value !== undefined && !value.startsWith("-");
  });
  if (commandIndex >= 0) tokens[commandIndex].kind = "proven-non-path";
}

function classifyFindArguments(
  words: Word[],
  tokens: ClassifiedShellToken[],
): void {
  const pathValueActions = new Set([
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-files0-from",
  ]);
  const provenValuePredicates = new Set([
    "-maxdepth",
    "-mindepth",
    "-type",
    "-xtype",
    "-name",
    "-iname",
    "-path",
    "-ipath",
    "-regex",
    "-iregex",
    "-user",
    "-group",
    "-size",
    "-perm",
  ]);
  let expressionStarted = false;

  for (let index = 0; index < words.length; index++) {
    const value = staticWordValue(words[index]);
    const token = tokens[index];
    if (!token || value === undefined) continue;

    if (value.startsWith("-") || value === "!" || value === "(") {
      expressionStarted = true;
      token.kind = "proven-non-path";
      const operand = tokens[index + 1];
      if (pathValueActions.has(value) && operand) {
        if (operand.kind === "dynamic") {
          operand.dynamicRole = "filesystem-reference";
        } else {
          operand.kind = "filesystem-reference";
        }
        index++;
        if (value === "-fprintf") {
          const format = tokens[index + 1];
          if (format) {
            format.kind = "proven-non-path";
            index++;
          }
        }
      } else if (provenValuePredicates.has(value) && operand) {
        operand.kind = "proven-non-path";
        index++;
      }
      continue;
    }

    if (!expressionStarted) {
      if (token.kind === "dynamic") token.dynamicRole = "filesystem-reference";
      else token.kind = "filesystem-reference";
    }
    // Unknown expression operands remain ambiguous and are path-checked.
  }
}

function classifyRedirect(
  redirect: Redirect,
): ClassifiedShellToken | undefined {
  if (!fileRedirectOperators.has(redirect.operator) || !redirect.target)
    return undefined;

  const value = staticWordValue(redirect.target);
  if (redirect.operator === ">&" && value && /^&?(?:\d+|-)$/.test(value))
    return undefined;

  const dynamic = isDynamicWord(redirect.target);
  return {
    kind: dynamic ? "dynamic" : "redirection-target",
    value: dynamic ? redirect.target.text : redirect.target.value,
    dynamicRole: dynamic ? "redirection-target" : undefined,
    pos: redirect.target.pos,
    end: redirect.target.end,
  };
}

function staticWordValue(word: Word | undefined): string | undefined {
  return word && !isDynamicWord(word) ? word.value : undefined;
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

function looksLikeGitObjectSpec(value: string): boolean {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator >= value.length - 1) return false;
  const leftSide = value.slice(0, separator);
  return looksLikeGitRevision(leftSide) && !isExplicitPathShapedValue(value);
}

function looksLikeGitRevision(value: string): boolean {
  return (
    /^(?:HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD)(?:[~^].*)?$/.test(
      value,
    ) ||
    /^[0-9a-f]{7,40}(?:[~^].*)?$/.test(value) ||
    /^stash@\{\d+\}$/.test(value) ||
    /^[^/:]+@\{[^}]+\}$/.test(value) ||
    /^refs\/.+/.test(value) ||
    /^[^/:]+(?:[~^].*)$/.test(value)
  );
}

function isExplicitPathShapedValue(value: string): boolean {
  const colon = value.indexOf(":");
  const leftSide = colon >= 0 ? value.slice(0, colon) : value;
  return (
    leftSide.startsWith("./") ||
    leftSide.startsWith("../") ||
    leftSide.startsWith("/") ||
    leftSide.startsWith("~/")
  );
}

function isCommand(value: unknown): value is Command {
  return isRecord(value) && value.type === "Command";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function walkAst(
  value: unknown,
  visit: (node: unknown) => void,
  seen = new WeakSet<object>(),
): void {
  if (!isRecord(value) || seen.has(value)) return;
  seen.add(value);
  visit(value);

  // Unbash's Word implementation exposes parsed parts through a prototype
  // getter, so Object.values() alone does not reach nested substitutions.
  const wordParts = Reflect.get(value, "parts");
  if (Array.isArray(wordParts)) {
    for (const part of wordParts) walkAst(part, visit, seen);
  }

  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) walkAst(item, visit, seen);
    } else {
      walkAst(child, visit, seen);
    }
  }
}
