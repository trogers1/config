import {
  parse,
  type Command,
  type CommandExpansionPart,
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

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function isCommand(value: unknown): value is Command {
  return isRecord(value) && value.type === "Command";
}

function isCommandExpansion(value: unknown): value is CommandExpansionPart {
  return isRecord(value) && value.type === "CommandExpansion";
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
