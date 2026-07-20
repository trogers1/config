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

export function shellishTokens(command: string): string[] {
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
      escaped = false;
      content += char;
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
