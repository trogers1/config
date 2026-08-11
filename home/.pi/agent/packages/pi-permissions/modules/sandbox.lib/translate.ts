import os from "node:os";
import path from "node:path";
import type {
  ProfilePolicy,
  Rule,
  SandboxConfig,
  WritePathRule,
} from "../policyHelpers";
import type { CoverageReport, SandboxPathRule, SandboxSpec } from "./types";

export type SandboxTranslationResult =
  | { kind: "active"; spec: SandboxSpec; report: CoverageReport }
  | { kind: "unavailable"; reason: string; report: CoverageReport };

type CompiledPath = { roots: string[] };

/**
 * Compile paths for SRT's platform backends. A literal `/**` is the runtime's
 * subpath shorthand. When a globbed prefix has that suffix, preserve its
 * descendant match explicitly: SRT otherwise strips the suffix while
 * preparing the platform-specific policy.
 */
function compilePath(
  pattern: string,
  startupCwd: string,
): CompiledPath | { reason: string } {
  if (!pattern.trim()) return { reason: "empty path pattern" };
  const expanded =
    pattern === "~"
      ? os.homedir()
      : pattern.startsWith("~/")
        ? path.join(os.homedir(), pattern.slice(2))
        : pattern;

  // SRT's Linux implementation silently drops globbed write restrictions.
  // A glob deny cannot safely be approximated by its static prefix: it would
  // either expose existing matches or block unrelated future paths. Keep
  // macOS support, where SRT has native glob enforcement, but make Linux
  // profiles fail closed unless the profile explicitly waives that deny.
  if (process.platform === "linux" && /[*?\[\]]/.test(expanded)) {
    return {
      reason:
        "Linux sandbox backend cannot enforce glob path patterns exactly; use a literal path or an explicit protected-path waiver",
    };
  }

  if (expanded === "*" || expanded === "**") return { roots: [startupCwd] };

  const descendantSuffix = "/**";
  const withoutDescendants = expanded.endsWith(descendantSuffix)
    ? expanded.slice(0, -descendantSuffix.length)
    : expanded;
  const hasGlobPrefix = /[*?\[\]]/.test(withoutDescendants);
  const runtimePattern = hasGlobPrefix
    ? expanded.endsWith(descendantSuffix)
      ? `${expanded}/*`
      : expanded
    : withoutDescendants;
  return { roots: [path.resolve(startupCwd, runtimePattern)] };
}

function isCompiledPath(
  value: ReturnType<typeof compilePath>,
): value is CompiledPath {
  return "roots" in value;
}

function emptyReport(): CoverageReport {
  return {
    uncoveredRestrictions: [],
    waivedRestrictions: [],
    untranslatedAllows: [],
    noKernelMeaning: [],
  };
}

function addUncovered(
  report: CoverageReport,
  pattern: string,
  source: string,
  reason: string,
): void {
  report.uncoveredRestrictions.push({ pattern, source, reason });
}

function addUntranslatedAllow(
  report: CoverageReport,
  pattern: string,
  source: string,
  reason: string,
): void {
  report.untranslatedAllows.push({ pattern, source, reason });
}

function isBashWriteRule(rule: WritePathRule): boolean {
  return !rule.contexts?.length || rule.contexts.includes("bash");
}

function normalizeRoots(roots: string[]): string[] {
  return [...new Set(roots.map((root) => path.resolve(root)))].sort();
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/** Return the narrower representable root, or no intersection. */
function intersectRoot(left: string, right: string): string | undefined {
  if (isWithin(left, right)) return left;
  if (isWithin(right, left)) return right;
  return undefined;
}

function intersectWithScopes(
  writableRoots: string[],
  scopeRoots: string[] | undefined,
): string[] {
  if (scopeRoots === undefined) return writableRoots;
  return normalizeRoots(
    writableRoots.flatMap((writable) =>
      scopeRoots.flatMap((scope) => {
        const intersection = intersectRoot(writable, scope);
        return intersection === undefined ? [] : [intersection];
      }),
    ),
  );
}

function isWaived(pattern: string, waivers: readonly string[]): boolean {
  return waivers.includes(pattern);
}

function globMatchesPath(pattern: string, candidate: string): boolean {
  const expression = `^${pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")}$`;
  return new RegExp(expression).test(candidate);
}

function literalCharacterCount(pattern: string): number {
  return pattern.replace(/[?*\[\]]/g, "").length;
}

function hasUnrepresentableProtectedPrecedence(
  rules: ReadonlyArray<
    NonNullable<ProfilePolicy["protectedPathRules"]>[number]
  >,
): boolean {
  return rules.some(
    (deny) =>
      deny.decision === "deny" &&
      rules.some(
        (allow) =>
          allow.decision === "allow" &&
          literalCharacterCount(deny.pattern) >
            literalCharacterCount(allow.pattern) &&
          globMatchesPath(allow.pattern, deny.pattern),
      ),
  );
}

function sandboxConfig(
  value: ProfilePolicy["sandbox"],
): SandboxConfig | undefined {
  return typeof value === "object" && value !== null ? value : undefined;
}

/**
 * Compile only policy facts that have a filesystem meaning for Bash. Any
 * unrepresentable deny/ask is a fail-closed coverage gap; an unrepresentable
 * allow remains denied by the kernel and is reported as a compatibility cost.
 */
export function translatePolicy(
  policy: ProfilePolicy,
  profileName: string,
  startupCwd = process.cwd(),
  subagentScopes: readonly Rule[] = [],
): SandboxTranslationResult {
  const sandbox = sandboxConfig(policy.sandbox);
  const report = emptyReport();
  if (!sandbox) {
    return {
      kind: "unavailable",
      reason: "sandbox is disabled for this profile",
      report,
    };
  }

  const cwd = path.resolve(startupCwd);
  const protectedRules = policy.protectedPathRules ?? [];
  if (hasUnrepresentableProtectedPrecedence(protectedRules)) {
    report.uncoveredRestrictions.push({
      pattern: "protectedPathRules",
      source: "protected",
      reason:
        "a more-specific protected deny falls within a protected allow exception, which the runtime cannot represent safely",
    });
    return {
      kind: "unavailable",
      reason: `sandbox policy for '${profileName}' contains protected-path precedence the backend cannot enforce exactly`,
      report,
    };
  }
  const readDenyRoots: string[] = [];
  const readAllowRoots: string[] = [];
  const writeAllowRoots: string[] = [];
  const writeDenyRoots: string[] = [];
  const readRules: SandboxPathRule[] = [];
  const writeRules: SandboxPathRule[] = [];
  let missingRestriction = false;

  // readPaths governs dedicated tools, not arbitrary Bash process reads.
  if ((policy.readPaths?.length ?? 0) > 0) {
    report.noKernelMeaning.push({
      pattern: "readPaths",
      source: "profile",
      reason:
        "ordinary readPaths apply to dedicated tools; Bash reads are restricted only by protected paths",
    });
  }

  for (const rule of protectedRules) {
    if (
      rule.decision === "deny" &&
      isWaived(rule.pattern, sandbox.kernelUnenforcedProtectedPaths ?? [])
    ) {
      report.waivedRestrictions.push({
        pattern: rule.pattern,
        source: "protected",
      });
      continue;
    }

    const compiled = compilePath(rule.pattern, cwd);
    if (!isCompiledPath(compiled)) {
      if (rule.decision === "allow") {
        addUntranslatedAllow(
          report,
          rule.pattern,
          "protected",
          compiled.reason,
        );
      } else {
        addUncovered(report, rule.pattern, "protected", compiled.reason);
        missingRestriction = true;
      }
      continue;
    }

    if (rule.decision === "deny") {
      readDenyRoots.push(...compiled.roots);
      writeDenyRoots.push(...compiled.roots);
      readRules.push({
        pattern: rule.pattern,
        decision: "deny",
        context: "any",
        source: "protected",
        guidance: rule.guidance,
      });
      writeRules.push({
        pattern: rule.pattern,
        decision: "deny",
        context: "any",
        source: "protected",
        guidance: rule.guidance,
      });
    } else if (rule.decision === "allow") {
      // SRT's read allow exceptions take precedence over deny. A protected
      // allow never grants write access; ordinary Bash write rules must do so.
      readAllowRoots.push(...compiled.roots);
      readRules.push({
        pattern: rule.pattern,
        decision: "allow",
        context: "any",
        source: "protected",
        guidance: rule.guidance,
      });
    }
  }

  for (const rule of policy.writePaths ?? []) {
    if (!isBashWriteRule(rule)) continue;
    const compiled = compilePath(rule.pattern, cwd);
    if (!isCompiledPath(compiled)) {
      if (rule.decision === "allow") {
        addUntranslatedAllow(report, rule.pattern, "profile", compiled.reason);
      } else {
        addUncovered(report, rule.pattern, "profile", compiled.reason);
        missingRestriction = true;
      }
      continue;
    }

    if (rule.decision === "allow") {
      writeAllowRoots.push(...compiled.roots);
    } else {
      // ask is deliberately kernel-denied: v1 never widens containment after
      // a prompt, while deny must remain an unconditional carve-out.
      writeDenyRoots.push(...compiled.roots);
    }
    writeRules.push({
      pattern: rule.pattern,
      decision: rule.decision === "allow" ? "allow" : "deny",
      context: rule.contexts?.includes("bash") ? "bash" : "any",
      source: "profile",
      guidance: rule.guidance,
    });
  }

  for (const pattern of sandbox.extraWritePaths ?? []) {
    const compiled = compilePath(pattern, cwd);
    if (!isCompiledPath(compiled)) {
      addUntranslatedAllow(report, pattern, "sandbox", compiled.reason);
    } else {
      writeAllowRoots.push(...compiled.roots);
      writeRules.push({
        pattern,
        decision: "allow",
        context: "any",
        source: "sandbox",
      });
    }
  }
  for (const pattern of sandbox.extraDenyReadPaths ?? []) {
    const compiled = compilePath(pattern, cwd);
    if (!isCompiledPath(compiled)) {
      addUncovered(report, pattern, "sandbox", compiled.reason);
      missingRestriction = true;
    } else {
      readDenyRoots.push(...compiled.roots);
      readRules.push({
        pattern,
        decision: "deny",
        context: "any",
        source: "sandbox",
      });
    }
  }
  for (const pattern of sandbox.extraDenyWritePaths ?? []) {
    const compiled = compilePath(pattern, cwd);
    if (!isCompiledPath(compiled)) {
      addUncovered(report, pattern, "sandbox", compiled.reason);
      missingRestriction = true;
    } else {
      writeDenyRoots.push(...compiled.roots);
      writeRules.push({
        pattern,
        decision: "deny",
        context: "any",
        source: "sandbox",
      });
    }
  }

  const scopeRoots: string[] | undefined =
    subagentScopes.length === 0 ? undefined : [];
  if (scopeRoots) {
    for (const rule of subagentScopes) {
      if (rule.decision !== "allow") continue;
      const compiled = compilePath(rule.pattern, cwd);
      if (!isCompiledPath(compiled)) {
        addUncovered(report, rule.pattern, "subagent", compiled.reason);
        missingRestriction = true;
      } else {
        scopeRoots.push(...compiled.roots);
      }
    }
  }

  if (missingRestriction) {
    return {
      kind: "unavailable",
      reason: `sandbox policy for '${profileName}' contains restrictions the portable backend cannot enforce exactly`,
      report,
    };
  }

  const writable = intersectWithScopes(
    normalizeRoots(writeAllowRoots),
    scopeRoots && normalizeRoots(scopeRoots),
  );
  // SRT denies override allows. A deny outside an opened root is already
  // covered by default-deny writes, so omit it. A deny inside an opened root
  // is an enforceable carve-out. A descendant allow cannot reopen that deny;
  // preserve the restriction and make the resulting tighter boundary visible.
  const effectiveWriteDenies = normalizeRoots(writeDenyRoots).filter((deny) => {
    const containsOpenedRoot = writable.some((allow) => isWithin(deny, allow));
    if (!containsOpenedRoot) return false;
    for (const allow of writable.filter((allow) => isWithin(allow, deny))) {
      addUntranslatedAllow(
        report,
        allow,
        "profile",
        `SRT deny precedence cannot reopen '${allow}' beneath denied '${deny}'`,
      );
    }
    return true;
  });

  return {
    kind: "active",
    report,
    spec: {
      profile: profileName,
      network: sandbox.network,
      filesystem: {
        startupCwd: cwd,
        readAllowRoots: normalizeRoots(readAllowRoots),
        readDenyRoots: normalizeRoots(readDenyRoots),
        writeAllowRoots: writable,
        writeDenyRoots: effectiveWriteDenies,
        scopeRoots: scopeRoots ? normalizeRoots(scopeRoots) : [],
      },
      readRules,
      writeRules,
    },
  };
}
