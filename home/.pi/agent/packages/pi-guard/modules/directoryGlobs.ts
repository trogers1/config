import { homedir } from "node:os";
import { Type, type Static } from "typebox";

// Keep the authoring grammar in the generated JSON Schema as well as in the
// semantic validator below. A globstar is a complete segment; all other
// segments may contain bounded `*` and `?` tokens.
const directoryGlobSegmentPattern = String.raw`(?!(?:\.{1,2})(?:/|$))(?!(?:[^/]*\*\*))[^\\/\u0000-\u001f\u007f~\[\]{}()!+|^$]+`;
const directoryGlobCharacterPattern = String.raw`^(?:~|/|(?:~/|/)(?!.*\*{3})(?:\*\*|${directoryGlobSegmentPattern})(?:/(?:\*\*|${directoryGlobSegmentPattern}))*)$`;

export const directoryGlobSchema = Type.String({
  minLength: 1,
  maxLength: 1024,
  pattern: directoryGlobCharacterPattern,
});
type DirectoryGlob = Static<typeof directoryGlobSchema>;

export const directoryGlobsSchema = Type.Array(directoryGlobSchema, {
  minItems: 1,
  maxItems: 128,
  uniqueItems: true,
});
export type DirectoryGlobs = Static<typeof directoryGlobsSchema>;

export type DirectoryGlobDeclaration = readonly [
  profile: string,
  directoryGlobs: readonly DirectoryGlob[],
];

type DirectoryGlobValidationErrorCode =
  | "empty"
  | "too-long"
  | "not-absolute"
  | "invalid-home-prefix"
  | "backslash"
  | "repeated-separator"
  | "trailing-separator"
  | "dot-segment"
  | "control-character"
  | "unsupported-syntax"
  | "too-many-wildcards"
  | "empty-collection"
  | "too-many-globs"
  | "duplicate";

type DirectoryGlobValidationResult =
  | { readonly valid: true; readonly value: DirectoryGlob }
  | {
      readonly valid: false;
      readonly code: DirectoryGlobValidationErrorCode;
      readonly message: string;
    };

type DirectoryGlobsValidationResult =
  | { readonly valid: true; readonly value: DirectoryGlobs }
  | {
      readonly valid: false;
      readonly code: DirectoryGlobValidationErrorCode;
      readonly message: string;
    };

const maxWildcardTokens = 64;
const maxCandidateLength = 4096;

function failure(
  code: DirectoryGlobValidationErrorCode,
  message: string,
): {
  readonly valid: false;
  readonly code: DirectoryGlobValidationErrorCode;
  readonly message: string;
} {
  return { valid: false, code, message };
}

/** Validate a directory glob without consulting the filesystem. */
export function validateDirectoryGlob(
  value: string,
): DirectoryGlobValidationResult {
  if (value.length === 0) return failure("empty", "glob must not be empty");
  if (value.length > 1024)
    return failure("too-long", "glob must be at most 1024 characters");
  if (value.includes("\\"))
    return failure("backslash", "glob must not contain backslashes");
  if (/[\u0000-\u001f\u007f]/u.test(value))
    return failure(
      "control-character",
      "glob must not contain control characters",
    );
  if (value === "~") return { valid: true, value };
  if (value.startsWith("~user"))
    return failure(
      "invalid-home-prefix",
      "~user home prefixes are not supported",
    );
  if (!value.startsWith("/") && value !== "~" && !value.startsWith("~/"))
    return failure("not-absolute", "glob must be absolute or begin with ~");
  if (value.startsWith("~") && value !== "~" && !value.startsWith("~/"))
    return failure(
      "invalid-home-prefix",
      "only a leading ~ or ~/ home prefix is supported",
    );
  if (value.includes("//"))
    return failure(
      "repeated-separator",
      "glob must not contain repeated separators",
    );
  if (/[\[\]{}()!+|^$]/u.test(value))
    return failure("unsupported-syntax", "glob contains unsupported syntax");
  if (value.length > 1 && value.endsWith("/"))
    return failure(
      "trailing-separator",
      "only / may have a trailing separator",
    );

  const body =
    value === "~"
      ? ""
      : value.startsWith("~/")
        ? value.slice(2)
        : value.slice(1);
  const segments = body.split("/");
  if (segments.some((segment) => segment === "." || segment === ".."))
    return failure("dot-segment", "glob must not contain . or .. segments");
  if (segments.some((segment) => segment.includes("~")))
    return failure(
      "invalid-home-prefix",
      "~ is only supported in a leading ~/ home prefix",
    );
  if (segments.some((segment) => segment.includes("**") && segment !== "**"))
    return failure(
      "unsupported-syntax",
      "globstar must occupy an entire path segment",
    );

  let wildcardTokens = 0;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "*") {
      if (value[index + 1] === "*") index++;
      if (value[index + 1] === "*")
        return failure(
          "unsupported-syntax",
          "glob contains an invalid wildcard run",
        );
      wildcardTokens++;
    } else if (character === "?") wildcardTokens++;
    else if (character === "/" || character !== "~") continue;
    else if (value.startsWith("~/") && index === 0) continue;
    else
      return failure("unsupported-syntax", "glob contains unsupported syntax");
  }
  if (wildcardTokens > maxWildcardTokens)
    return failure(
      "too-many-wildcards",
      "glob must contain at most 64 wildcard tokens",
    );
  return { valid: true, value };
}

/** Validate every raw declaration before it is composed into a runtime policy. */
export function validateDirectoryGlobs(
  globs: readonly string[],
): DirectoryGlobsValidationResult {
  if (globs.length < 1)
    return failure("empty-collection", "directory globs must not be empty");
  if (globs.length > 128)
    return failure(
      "too-many-globs",
      "directory globs must contain at most 128 entries",
    );

  const validated: DirectoryGlob[] = [];
  const seen = new Set<string>();
  for (const glob of globs) {
    if (seen.has(glob))
      return failure(
        "duplicate",
        "directory globs must not contain duplicates",
      );
    seen.add(glob);
    const result = validateDirectoryGlob(glob);
    if (!result.valid) return result;
    validated.push(result.value);
  }
  return { valid: true, value: validated };
}

/** Accept only a canonical lexical absolute path; never resolve it on disk. */
function canonicalAbsolutePath(value: string): string | undefined {
  if (
    !value.startsWith("/") ||
    value.length > maxCandidateLength ||
    value.includes("\\") ||
    value.includes("//") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    (value.length > 1 && value.endsWith("/"))
  )
    return undefined;
  const segments = value.slice(1).split("/");
  if (segments.some((segment) => segment === "." || segment === ".."))
    return undefined;
  return value;
}

function expandedGlob(glob: DirectoryGlob, home: string): string {
  return glob === "~"
    ? home
    : glob.startsWith("~/")
      ? `${home === "/" ? "" : home}${glob.slice(1)}`
      : glob;
}

function segmentMatch(pattern: string, candidate: string): boolean {
  const columns = candidate.length + 1;
  let previous = new Uint8Array(columns);
  previous[0] = 1;
  for (const character of pattern) {
    const current = new Uint8Array(columns);
    if (character === "*") {
      for (let index = 0; index < columns; index++)
        current[index] =
          previous[index] === 1 || (index > 0 && current[index - 1] === 1)
            ? 1
            : 0;
    } else {
      for (let index = 1; index < columns; index++)
        current[index] =
          previous[index - 1] === 1 &&
          (character === "?" || character === candidate[index - 1])
            ? 1
            : 0;
    }
    previous = current;
  }
  return previous[columns - 1] === 1;
}

function wildcardMatch(pattern: string, candidate: string): boolean {
  if (
    pattern.length > maxCandidateLength ||
    candidate.length > maxCandidateLength
  )
    return false;
  const patternSegments = pattern.slice(1).split("/");
  const candidateSegments = candidate.slice(1).split("/");
  const memo = new Map<string, boolean>();
  const match = (patternIndex: number, candidateIndex: number): boolean => {
    const key = `${patternIndex}:${candidateIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (patternIndex === patternSegments.length)
      result = candidateIndex === candidateSegments.length;
    else if (patternSegments[patternIndex] === "**")
      result =
        match(patternIndex + 1, candidateIndex) ||
        (candidateIndex < candidateSegments.length &&
          match(patternIndex, candidateIndex + 1));
    else
      result =
        candidateIndex < candidateSegments.length &&
        segmentMatch(
          patternSegments[patternIndex],
          candidateSegments[candidateIndex],
        ) &&
        match(patternIndex + 1, candidateIndex + 1);
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

function literalPrefix(glob: string): number {
  const firstWildcard = glob.search(/[?*]/u);
  return (firstWildcard === -1 ? glob : glob.slice(0, firstWildcard)).length;
}

function lexicalAncestors(cwd: string): string[] {
  const ancestors: string[] = [];
  let current = cwd;
  while (true) {
    ancestors.push(current);
    if (current === "/") return ancestors;
    const separator = current.lastIndexOf("/");
    current = separator === 0 ? "/" : current.slice(0, separator);
  }
}

type DirectoryGlobMatch = {
  readonly profile: string;
  readonly glob: DirectoryGlob;
  readonly declarationIndex: number;
  readonly globIndex: number;
  readonly literalPrefixCharacters: number;
};

type DirectoryGlobMatchOptions = { readonly home?: string };

function pathDepth(path: string): number {
  return path === "/" ? 0 : path.split("/").length - 1;
}

/** Select the most specific profile whose glob root lexically contains the CWD. */
export function matchDirectoryGlobs(
  cwd: string,
  declarations: readonly DirectoryGlobDeclaration[],
  options: DirectoryGlobMatchOptions = {},
): DirectoryGlobMatch | undefined {
  const home = canonicalAbsolutePath(options.home ?? homedir());
  const normalizedCwd = canonicalAbsolutePath(cwd);
  if (home === undefined || normalizedCwd === undefined) return undefined;
  const candidates = lexicalAncestors(normalizedCwd);
  let best: DirectoryGlobMatch | undefined;
  let bestRootDepth = -1;
  for (const [declarationIndex, [profile, globs]] of declarations.entries()) {
    for (const [globIndex, glob] of globs.entries()) {
      const validation = validateDirectoryGlob(glob);
      if (!validation.valid) continue;
      const root = expandedGlob(validation.value, home);
      const rootCandidate = candidates.find((candidate) =>
        wildcardMatch(root, candidate),
      );
      if (rootCandidate === undefined) continue;
      const prefixCharacters = literalPrefix(root);
      const match: DirectoryGlobMatch = {
        profile,
        glob,
        declarationIndex,
        globIndex,
        literalPrefixCharacters: prefixCharacters,
      };
      if (
        best === undefined ||
        prefixCharacters > best.literalPrefixCharacters ||
        (prefixCharacters === best.literalPrefixCharacters &&
          (pathDepth(rootCandidate) > bestRootDepth ||
            (pathDepth(rootCandidate) === bestRootDepth &&
              declarationIndex > best.declarationIndex)))
      ) {
        best = match;
        bestRootDepth = pathDepth(rootCandidate);
      }
    }
  }
  return best;
}
