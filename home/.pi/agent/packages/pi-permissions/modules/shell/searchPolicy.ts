import path from "node:path";
import { extractShellCommands, shellishTokens } from "./parse";
import { expandHome, matchesGlobPattern } from "./pathPolicy";

export function validateRipgrepGlobOverrides(
  command: string,
): string | undefined {
  for (const segment of extractShellCommands(command)) {
    const tokens = shellishTokens(segment);
    const ripgrepIndex = tokens.findIndex(
      (token) => token === "rg" || token === "ripgrep",
    );
    if (ripgrepIndex < 0) continue;

    for (let index = ripgrepIndex + 1; index < tokens.length; index++) {
      const token = tokens[index];
      const glob =
        token === "--glob"
          ? tokens[++index]
          : token.startsWith("--glob=")
            ? token.slice("--glob=".length)
            : undefined;
      if (glob === undefined) continue;
      if (!isSafeGrepGlob(glob)) {
        return [
          "ripgrep denied because its --glob could override the protected .env exclusion.",
          "Use a specific non-.env --glob (for example, '**/*.ts'), use the built-in grep tool, or omit --glob to automatically exclude .env files.",
        ].join("\n\n");
      }
    }
  }
  return undefined;
}

export function injectRipgrepEnvExclusions(command: string): string {
  // Ripgrep accepts multiple --glob options; later include rules preserve the
  // intentionally readable .env.template files while excluding real env files.
  return command.replace(
    /(^|&&|\|\||[;|\n])(\s*)((?:command\s+)?)(rg|ripgrep)(?=\s|$)/gm,
    (
      _match,
      separator: string,
      spacing: string,
      prefix: string,
      tool: string,
    ) =>
      `${separator}${spacing}${prefix}${tool} --glob '!**/.env*' --glob '**/.env.template'`,
  );
}

export function injectGrepEnvExclusion(input: {
  path?: string;
  glob?: string;
}): string | undefined {
  // The built-in grep tool only accepts one glob. With no caller glob, make it
  // a deny glob. A caller-supplied positive glob is retained only when it is
  // demonstrably unable to match protected env files; a second exclusion glob
  // cannot otherwise be added without replacing the built-in tool.
  if (isEnvTemplatePath(input.path)) return undefined;
  if (!input.glob) {
    input.glob = "!**/.env*";
    return undefined;
  }
  if (isSafeGrepGlob(input.glob)) return undefined;

  return [
    "grep denied because its glob could match protected .env files.",
    "Use a specific non-.env glob (for example, '**/*.ts'), search .env.template directly, or omit glob to automatically exclude .env files.",
  ].join("\n\n");
}

function isEnvTemplatePath(requestedPath: string | undefined): boolean {
  if (!requestedPath) return false;
  return path.basename(expandHome(requestedPath)) === ".env.template";
}

function isSafeGrepGlob(glob: string): boolean {
  if (glob === "!**/.env*") return true;
  if (glob === ".env.template" || glob === "**/.env.template") return true;
  // Character classes and brace expansion are intentionally rejected: this
  // matcher cannot prove whether those ripgrep glob forms include .env files.
  if (glob.startsWith("!") || /[\[\]{}]/.test(glob)) return false;

  return ![
    ".env",
    ".env.local",
    ".env.production.local",
    "nested/.env",
    "nested/.env.local",
  ].some((protectedPath) => matchesGlobPattern(glob, protectedPath));
}
