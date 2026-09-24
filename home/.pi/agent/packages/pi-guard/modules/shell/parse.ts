import {
  parse,
  type ArithmeticFor,
  type Command,
  type CommandExpansionPart,
  type For,
  type Pipeline,
  type Select,
  type While,
  type Word,
  type WordPart,
} from "unbash";

export function extractShellCommands(command: string): string[] {
  const script = parse(command);
  const commands: Array<{ pos: number; value: string }> = [];
  walkAst(script, (node) => {
    if (isCommand(node)) {
      commands.push({
        pos: node.pos,
        value: command.slice(node.pos, node.end),
      });
    }
  });
  return commands
    .sort((left, right) => left.pos - right.pos)
    .map(({ value }) => value.trim())
    .filter(Boolean);
}

export function splitShellCommands(command: string): string[] {
  return extractShellCommands(command);
}

export function extractCommandSubstitutions(command: string): string[] {
  const script = parse(command);
  const substitutions: Array<{ pos: number; value: string }> = [];
  walkAst(script, (node) => {
    if (isCommandExpansion(node) && node.script) {
      substitutions.push({
        pos: node.script.pos,
        value:
          node.inner ?? command.slice(node.script.pos, node.script.end).trim(),
      });
    }
  });
  return substitutions
    .sort((left, right) => left.pos - right.pos)
    .map(({ value }) => value);
}

export function shellCommandWords(command: string): string[] {
  const script = parse(command);
  const node = script.commands[0]?.command;
  if (!isCommand(node)) return [];
  return [node.name, ...node.suffix]
    .filter((word): word is Word => word !== undefined)
    .map((word) => (isDynamicWord(word) ? word.text : word.value));
}

export type ShellWords = readonly (string | undefined)[];

export type ShellExecutable =
  | { status: "resolved"; executable: string; arguments_: ShellWords }
  | { status: "not-executable" }
  | { status: "unknown" }
  | { status: "unknown-executable" };

export type ShellComposition = ReturnType<typeof collectShellComposition>;

/**
 * Describes shell constructs that change how command inputs are composed.
 * Command words are present only when their value is statically known.
 */
export function shellComposition({
  command,
}: {
  command: string;
}): ShellComposition {
  return collectShellComposition({ script: parse(command) });
}

/** Resolves supported shell wrappers to the executable they invoke. */
export function shellExecutable({
  words,
}: {
  words: ShellWords;
}): ShellExecutable {
  return resolveShellExecutable({ words, index: 0 });
}

function collectShellComposition({ script }: { script: unknown }) {
  const commands: ShellWords[] = [];
  let hasLoop = false;
  let hasPipeline = false;

  walkAst(script, (node) => {
    if (isCommand(node)) {
      commands.push(
        [node.name, ...node.suffix].map((word) =>
          word === undefined ? undefined : staticShellWord({ word }),
        ),
      );
    } else if (isPipeline(node) && node.operators.length > 0) {
      hasPipeline = true;
    } else if (
      isFor(node) ||
      isArithmeticFor(node) ||
      isWhile(node) ||
      isSelect(node)
    ) {
      hasLoop = true;
    }
  });

  return { commands, hasLoop, hasPipeline };
}

function resolveShellExecutable({
  words,
  index,
}: {
  words: ShellWords;
  index: number;
}): ShellExecutable {
  const word = words[index];
  if (word === undefined) return { status: "unknown" };

  switch (executableName({ value: word })) {
    case "command":
      return resolveCommandWrapper({ words, index: index + 1 });
    case "env":
      return resolveEnvWrapper({ words, index: index + 1 });
    case "exec":
      return resolveExecWrapper({ words, index: index + 1 });
    case "builtin":
      return resolveBuiltinWrapper({ words, index: index + 1 });
    default:
      return {
        status: "resolved",
        executable: executableName({ value: word }),
        arguments_: words.slice(index + 1),
      };
  }
}

function resolveCommandWrapper({
  words,
  index,
}: {
  words: ShellWords;
  index: number;
}): ShellExecutable {
  let next = index;
  while (true) {
    const option = words[next];
    if (option === undefined) return { status: "unknown" };
    if (option === "--")
      return shellExecutable({ words: words.slice(next + 1) });
    if (!option.startsWith("-"))
      return shellExecutable({ words: words.slice(next) });
    if (!/^-[p]+$/.test(option)) {
      return /^-[vV]+$/.test(option)
        ? { status: "not-executable" }
        : { status: "unknown" };
    }
    next++;
  }
}

function resolveEnvWrapper({
  words,
  index,
}: {
  words: ShellWords;
  index: number;
}): ShellExecutable {
  let next = index;
  while (true) {
    const option = words[next];
    if (option === undefined) return { status: "unknown-executable" };
    if (option === "--")
      return shellExecutable({ words: words.slice(next + 1) });
    // env performs its own split-string parsing, whose quoting and escaping
    // semantics differ from the shell. Treat every such executable-producing
    // form as unknown rather than approximating it and potentially failing open.
    if (
      ["-S", "--split-string"].includes(option) ||
      option.startsWith("--split-string=") ||
      (option.startsWith("-S") && option !== "-S")
    )
      return { status: "unknown-executable" };
    if (isEnvironmentAssignment({ value: option })) {
      next++;
      continue;
    }
    if (["-i", "--ignore-environment", "-0", "--null"].includes(option)) {
      next++;
      continue;
    }
    if (["-u", "--unset", "-C", "--chdir"].includes(option)) {
      if (words[next + 1] === undefined) return { status: "unknown" };
      next += 2;
      continue;
    }
    if (option.startsWith("-")) return { status: "unknown-executable" };
    return shellExecutable({ words: words.slice(next) });
  }
}

function resolveExecWrapper({
  words,
  index,
}: {
  words: ShellWords;
  index: number;
}): ShellExecutable {
  let next = index;
  while (true) {
    const option = words[next];
    if (option === undefined) return { status: "unknown" };
    if (option === "--")
      return shellExecutable({ words: words.slice(next + 1) });
    if (["-c", "-l"].includes(option)) {
      next++;
      continue;
    }
    if (option === "-a") {
      if (words[next + 1] === undefined) return { status: "unknown" };
      next += 2;
      continue;
    }
    if (option.startsWith("-")) return { status: "unknown" };
    return shellExecutable({ words: words.slice(next) });
  }
}

function resolveBuiltinWrapper({
  words,
  index,
}: {
  words: ShellWords;
  index: number;
}): ShellExecutable {
  const option = words[index];
  if (option === undefined) return { status: "unknown" };
  if (option === "--")
    return shellExecutable({ words: words.slice(index + 1) });
  if (option === "-s")
    return shellExecutable({ words: words.slice(index + 1) });
  return option.startsWith("-")
    ? { status: "unknown" }
    : shellExecutable({ words: words.slice(index) });
}

function executableName({ value }: { value: string }): string {
  const slash = value.lastIndexOf("/");
  return slash === -1 ? value : value.slice(slash + 1);
}

function isEnvironmentAssignment({ value }: { value: string }): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function staticShellWord({ word }: { word: Word }): string | undefined {
  return isDynamicWord(word) ? undefined : word.value;
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
    `^${escapeRegExp(normalizeCommand(pattern))
      .replace(/\\\*/g, ".*")
      .replace(/\\\?/g, "[^\\s]")}$`,
  );
  return regex.test(command);
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function isCommand(value: unknown): value is Command {
  return isRecord(value) && value.type === "Command";
}

function isCommandExpansion(value: unknown): value is CommandExpansionPart {
  return isRecord(value) && value.type === "CommandExpansion";
}

function isPipeline(value: unknown): value is Pipeline {
  return isRecord(value) && value.type === "Pipeline";
}

function isFor(value: unknown): value is For {
  return isRecord(value) && value.type === "For";
}

function isArithmeticFor(value: unknown): value is ArithmeticFor {
  return isRecord(value) && value.type === "ArithmeticFor";
}

function isWhile(value: unknown): value is While {
  return isRecord(value) && value.type === "While";
}

function isSelect(value: unknown): value is Select {
  return isRecord(value) && value.type === "Select";
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
    case "SimpleExpansion":
    case "ParameterExpansion":
    case "CommandExpansion":
    case "ArithmeticExpansion":
    case "ProcessSubstitution":
    case "ExtendedGlob":
    case "BraceExpansion":
      return true;
  }
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

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.*]/g, "\\$&");
}
