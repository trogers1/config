import { extractShellCommands, shellishTokens } from "./parse";
import { expandHome, matchesGlobPattern } from "./pathPolicy";

export function validateRipgrepGlobOverrides(
  command: string,
  protectedPathPatterns: readonly string[],
  protectedPathExceptions: readonly string[] = [],
): string | undefined {
  if (protectedPathPatterns.length === 0) return undefined;

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
      if (
        !isSafeSearchGlob(glob, protectedPathPatterns, protectedPathExceptions)
      ) {
        return [
          "ripgrep denied because its --glob could include a path protected by the active profile.",
          "Use a specific glob that cannot match protected paths, use the built-in grep tool, or omit --glob to apply the profile-derived exclusions automatically.",
        ].join("\n\n");
      }
    }
  }
  return undefined;
}

export function injectRipgrepProtectedPathGlobs(
  command: string,
  protectedPathPatterns: readonly string[],
  protectedPathExceptions: readonly string[] = [],
): string {
  if (protectedPathPatterns.length === 0) return command;
  const globArguments = [
    ...protectedPathPatterns.map(
      (pattern) => `--glob ${shellQuote(`!${pattern}`)}`,
    ),
    ...protectedPathExceptions.map(
      (pattern) => `--glob ${shellQuote(pattern)}`,
    ),
  ].join(" ");

  return command.replace(
    /(^|&&|\|\||[;|\n])(\s*)((?:command\s+)?)(rg|ripgrep)(?=\s|$)/gm,
    (
      _match,
      separator: string,
      spacing: string,
      prefix: string,
      tool: string,
    ) => `${separator}${spacing}${prefix}${tool} ${globArguments}`,
  );
}

export function injectGrepProtectedPathGlob(
  input: { path?: string; glob?: string },
  protectedPathPatterns: readonly string[],
  protectedPathExceptions: readonly string[] = [],
): string | undefined {
  if (protectedPathPatterns.length === 0) return undefined;
  if (isExceptionPath(input.path, protectedPathExceptions)) return undefined;

  // Pi's built-in grep forwards one --glob to ripgrep. Brace alternation lets
  // that one argument carry every profile-derived exclusion.
  const exclusion = combinedExclusionGlob(protectedPathPatterns);
  if (!input.glob) {
    input.glob = exclusion;
    return undefined;
  }
  if (
    input.glob === exclusion ||
    isSafeSearchGlob(input.glob, protectedPathPatterns, protectedPathExceptions)
  )
    return undefined;

  return [
    "grep denied because its glob could include a path protected by the active profile.",
    "Use a specific glob that cannot match protected paths, search an explicit configured exception, or omit glob to apply the profile-derived exclusions automatically.",
  ].join("\n\n");
}

function combinedExclusionGlob(patterns: readonly string[]): string {
  return patterns.length === 1 ? `!${patterns[0]}` : `!{${patterns.join(",")}}`;
}

function isExceptionPath(
  requestedPath: string | undefined,
  exceptions: readonly string[],
): boolean {
  if (!requestedPath) return false;
  const normalized = expandHome(requestedPath).replace(/\\/g, "/");
  return exceptions.some((pattern) => matchesGlobPattern(pattern, normalized));
}

function isSafeSearchGlob(
  glob: string,
  protectedPatterns: readonly string[],
  exceptions: readonly string[],
): boolean {
  if (exceptions.includes(glob)) return true;
  if (glob.startsWith("!") || /[\[\]{}]/.test(glob)) return false;

  const requestedCandidates = representativeGlobPaths(glob);
  return protectedPatterns.every(
    (protectedPattern) =>
      representativeGlobPaths(protectedPattern).every(
        (candidate) => !matchesGlobPattern(glob, candidate),
      ) &&
      requestedCandidates.every(
        (candidate) => !matchesGlobPattern(protectedPattern, candidate),
      ),
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
