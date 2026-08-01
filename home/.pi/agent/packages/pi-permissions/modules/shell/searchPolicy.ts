import { parse } from "unbash";
import { shellCommandWords } from "./parse";
import { pathPatternSpecificity } from "../ruleSpecificity";
import type { ProtectedPathRule } from "../policyHelpers";

// Exceptions are deliberately not injected as positive globs: ripgrep treats
// any positive --glob as a whitelist for implicit searches, which would hide
// every non-exception file. Explicitly named paths bypass glob filtering, so
// exception files remain searchable by naming them directly.
export function injectRipgrepProtectedPathGlobs(
  command: string,
  protectedPathRules: readonly ProtectedPathRule[],
): string {
  const protectedPatterns = protectedPathRules
    .filter((rule) => rule.decision === "deny")
    .map((rule) => rule.pattern);
  if (protectedPatterns.length === 0) return command;

  // Ripgrep applies later globs last, so caller overrides stay intact while
  // policy exclusions are appended after them and cannot be re-included.
  const globArguments = protectedPatterns
    .map((pattern) => `--glob ${shellQuote(`!${pattern}`)}`)
    .join(" ");
  const insertions = collectRipgrepInsertionPoints(command);
  if (insertions.length === 0) return command;

  let output = command;
  for (const insertion of insertions.sort((left, right) => right - left)) {
    output = `${output.slice(0, insertion)} ${globArguments}${output.slice(insertion)}`;
  }
  return output;
}

export function injectGrepProtectedPathGlob(
  input: { path?: string; glob?: string },
  protectedPathRules: readonly ProtectedPathRule[],
): string | undefined {
  const denyRules = protectedPathRules.filter(
    (rule) => rule.decision === "deny",
  );
  if (denyRules.length === 0) return undefined;

  // Pi's built-in grep forwards one --glob to ripgrep. Brace alternation lets
  // that one argument carry every profile-derived exclusion.
  const exclusion = combinedExclusionGlob(denyRules);
  if (!input.glob) {
    input.glob = exclusion;
    return undefined;
  }
  if (
    input.glob === exclusion ||
    isSafeSearchGlob(input.glob, protectedPathRules)
  )
    return undefined;

  return [
    "grep denied because its glob could include a path protected by the active profile.",
    "Pi's built-in grep forwards only one --glob to ripgrep, so a caller glob can re-include protected files. For filtered searches, use Bash + rg instead (for example, rg --glob '**/*.ts' 'PATTERN' .); pi-permissions appends the protected exclusions automatically. Otherwise, search an explicit configured exception or omit glob to apply the profile-derived exclusions automatically.",
  ].join("\n\n");
}

function combinedExclusionGlob(rules: readonly ProtectedPathRule[]): string {
  const patterns = rules
    .filter((rule) => rule.decision === "deny")
    .map((rule) => rule.pattern);
  return patterns.length === 1 ? `!${patterns[0]}` : `!{${patterns.join(",")}}`;
}

function isSafeSearchGlob(
  glob: string,
  rules: readonly ProtectedPathRule[],
): boolean {
  if (glob.startsWith("!") || /[\[\]{}]/.test(glob)) return false;

  const exactAllow = rules.find(
    (rule) => rule.decision === "allow" && rule.pattern === glob,
  );
  if (exactAllow && exactAllowOutranksOverlappingDenies(exactAllow, rules)) {
    return true;
  }

  return !rules.some(
    (rule) =>
      rule.decision === "deny" && globPatternsOverlap(glob, rule.pattern),
  );
}

function exactAllowOutranksOverlappingDenies(
  allowRule: ProtectedPathRule,
  rules: readonly ProtectedPathRule[],
): boolean {
  const allowIndex = rules.indexOf(allowRule);
  const allowScore = pathPatternSpecificity(allowRule.pattern);

  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index];
    if (rule.decision !== "deny") continue;
    if (!globPatternsOverlap(allowRule.pattern, rule.pattern)) continue;

    const denyScore = pathPatternSpecificity(rule.pattern);
    if (compareRulePriority(allowScore, allowIndex, denyScore, index) <= 0) {
      return false;
    }
  }

  return true;
}

function compareRulePriority(
  leftScore: ReturnType<typeof pathPatternSpecificity>,
  leftIndex: number,
  rightScore: ReturnType<typeof pathPatternSpecificity>,
  rightIndex: number,
): number {
  if (leftScore.literalSegments !== rightScore.literalSegments) {
    return leftScore.literalSegments - rightScore.literalSegments;
  }
  if (leftScore.literalCharacters !== rightScore.literalCharacters) {
    return leftScore.literalCharacters - rightScore.literalCharacters;
  }
  return leftIndex - rightIndex;
}

function globPatternsOverlap(left: string, right: string): boolean {
  return pathPatternOverlap(left.replace(/^!/, ""), right.replace(/^!/, ""));
}

function pathPatternOverlap(left: string, right: string): boolean {
  const leftSegments = left.split("/");
  const rightSegments = right.split("/");
  const queue: Array<[number, number]> = [[0, 0]];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const [leftIndex, rightIndex] = queue.pop()!;
    const key = `${leftIndex}:${rightIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (
      leftIndex === leftSegments.length &&
      rightIndex === rightSegments.length
    ) {
      return true;
    }

    const leftSegment = leftSegments[leftIndex];
    const rightSegment = rightSegments[rightIndex];

    if (leftSegment === "**") {
      queue.push([leftIndex + 1, rightIndex]);
      if (rightSegment !== undefined) queue.push([leftIndex, rightIndex + 1]);
      continue;
    }
    if (rightSegment === "**") {
      queue.push([leftIndex, rightIndex + 1]);
      if (leftSegment !== undefined) queue.push([leftIndex + 1, rightIndex]);
      continue;
    }

    if (
      leftSegment !== undefined &&
      rightSegment !== undefined &&
      segmentPatternOverlap(leftSegment, rightSegment)
    ) {
      queue.push([leftIndex + 1, rightIndex + 1]);
    }
  }

  return false;
}

function segmentPatternOverlap(left: string, right: string): boolean {
  const queue: Array<[number, number]> = [[0, 0]];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const [leftIndex, rightIndex] = queue.pop()!;
    const key = `${leftIndex}:${rightIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (leftIndex === left.length && rightIndex === right.length) return true;

    const leftChar = left[leftIndex];
    const rightChar = right[rightIndex];

    if (leftChar === "*") {
      queue.push([leftIndex + 1, rightIndex]);
      if (rightChar !== undefined && rightChar !== "/")
        queue.push([leftIndex, rightIndex + 1]);
      continue;
    }
    if (rightChar === "*") {
      queue.push([leftIndex, rightIndex + 1]);
      if (leftChar !== undefined && leftChar !== "/")
        queue.push([leftIndex + 1, rightIndex]);
      continue;
    }

    if (leftChar === undefined || rightChar === undefined) continue;
    if (leftChar === "?" || rightChar === "?" || leftChar === rightChar) {
      queue.push([leftIndex + 1, rightIndex + 1]);
    }
  }

  return false;
}

function collectRipgrepInsertionPoints(command: string): number[] {
  let script: unknown;
  try {
    script = parse(command);
  } catch {
    return [];
  }

  const insertions: number[] = [];
  walkAst(script, (node) => {
    if (!isCommandNode(node)) return;

    const pos: unknown = Reflect.get(node as object, "pos");
    const end: unknown = Reflect.get(node as object, "end");
    if (typeof pos !== "number" || typeof end !== "number") return;

    const segment = command.slice(pos, end).trim();
    if (!isRipgrepInvocation(segment)) return;
    insertions.push(end);
  });
  return insertions;
}

function isRipgrepInvocation(command: string): boolean {
  try {
    const words = shellCommandWords(command);
    let index = 0;
    while (words[index] === "command") index++;
    return words[index] === "rg" || words[index] === "ripgrep";
  } catch {
    return false;
  }
}

function isCommandNode(value: unknown): boolean {
  return isRecord(value) && value.type === "Command";
}

function walkAst(
  value: unknown,
  visit: (node: unknown) => void,
  seen = new WeakSet<object>(),
): void {
  if (!isRecord(value) || seen.has(value)) return;
  seen.add(value);
  visit(value);

  const wordParts: unknown = Reflect.get(value, "parts");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
