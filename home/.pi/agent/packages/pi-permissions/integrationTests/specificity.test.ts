import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decideBash, decideCustomTool } from "../extensions/permissions";
import { decideBashPathReferences } from "../modules/shell/pathPolicy";
import { extendProfile } from "../modules/policyHelpers";
import type {
  CustomToolRule,
  ProfilePolicy,
  ReadPathRule,
  Rule,
  WritePathRule,
} from "../modules/policyHelpers";
import { evaluatePathByPattern } from "../modules/shell/pathPolicy";

const startupCwd = "/workspace/project";

function bashProfile(rules: Rule[]): ProfilePolicy {
  return {
    tools: { bash: rules },
    readPaths: [{ pattern: "*", decision: "allow" }],
    writePaths: [{ pattern: "*", decision: "allow" }],
  };
}

function pathProfile(
  readPaths: ReadPathRule[],
  writePaths: WritePathRule[],
): ProfilePolicy {
  return {
    tools: {},
    readPaths,
    writePaths,
  };
}

describe("specificity-first rule resolution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it("git branch --list allow beats git branch * deny even when the deny is declared last", () => {
    const policy = bashProfile([
      { pattern: "git branch --list", decision: "allow" },
      { pattern: "git branch *", decision: "deny" },
    ]);
    expect(decideBash("git branch --list", policy)).toBe("allow");
  });

  it("npm exec * deny beats npm * ask even when ask is declared last", () => {
    const policy = bashProfile([
      { pattern: "npm exec *", decision: "deny" },
      { pattern: "npm *", decision: "ask" },
    ]);
    expect(decideBash("npm exec cowsay", policy)).toBe("deny");
  });

  it("find -delete guard beats find * allow even when allow is declared last", () => {
    const policy = bashProfile([
      { pattern: "find * -delete*", decision: "deny" },
      { pattern: "find *", decision: "allow" },
    ]);
    expect(decideBash("find . -delete", policy)).toBe("deny");
  });

  it('echo "---" allow beats echo * deny even when deny is declared last', () => {
    const policy = bashProfile([
      { pattern: 'echo "---"', decision: "allow" },
      { pattern: "echo *", decision: "deny" },
    ]);
    expect(decideBash('echo "---"', policy)).toBe("allow");
  });

  it("* is a true fallback that only decides when nothing else matches", () => {
    const policy = bashProfile([
      { pattern: "specific", decision: "allow" },
      { pattern: "*", decision: "deny" },
    ]);
    expect(decideBash("specific", policy)).toBe("allow");
    expect(decideBash("other", policy)).toBe("deny");
  });

  it("same-pattern ties resolve by composition order", () => {
    const base = bashProfile([{ pattern: "git commit *", decision: "deny" }]);
    const child = extendProfile(base, {
      tools: { bash: [{ pattern: "git commit *", decision: "allow" }] },
    });
    expect(decideBash("git commit -m test", child)).toBe("allow");
  });

  it("metric ties resolve deterministically by composition order", () => {
    const policy = bashProfile([
      { pattern: "git * --output *", decision: "deny" },
      { pattern: "git checkout *", decision: "allow" },
    ]);
    expect(decideBash("git checkout main --output file", policy)).toBe("allow");
  });

  it("readPaths allow a specific subpath under a broad deny even when the allow is declared first", () => {
    const policy = pathProfile(
      [
        { pattern: "docs/**", decision: "allow" },
        { pattern: "**", decision: "deny" },
      ],
      [{ pattern: "*", decision: "allow" }],
    );
    const absolute = path.resolve(startupCwd, "docs/readme.md");
    expect(
      evaluatePathByPattern(
        absolute,
        startupCwd,
        policy.readPaths,
        "allow",
        "read",
      ),
    ).toMatchObject({ decision: "allow" });
  });

  it("writePaths allow a specific subpath under a broad deny even when the allow is declared first", () => {
    const policy = pathProfile(
      [{ pattern: "*", decision: "allow" }],
      [
        { pattern: "generated/**", decision: "allow" },
        { pattern: "**", decision: "deny" },
      ],
    );
    const absolute = path.resolve(startupCwd, "generated/out.ts");
    expect(
      evaluatePathByPattern(
        absolute,
        startupCwd,
        policy.writePaths,
        "allow",
        "write",
      ),
    ).toMatchObject({ decision: "allow" });
  });

  it("longer literal character count wins when literal token count ties, regardless of order", () => {
    const policy = bashProfile([
      { pattern: "git * --short", decision: "deny" },
      { pattern: "git status *", decision: "allow" },
    ]);
    expect(decideBash("git status --short", policy)).toBe("deny");
  });

  it("command ? matches exactly one non-space character", () => {
    const policy = bashProfile([{ pattern: "echo ?", decision: "allow" }]);
    expect(decideBash("echo x", policy)).toBe("allow");
    expect(decideBash("echo xy", policy)).toBe("ask");
  });

  it("literal brackets count toward command specificity", () => {
    const policy = bashProfile([
      { pattern: "echo [x]*", decision: "allow" },
      { pattern: "echo *ab", decision: "deny" },
    ]);
    expect(decideBash("echo [x]ab", policy)).toBe("allow");
  });

  it("path ? matches exactly one non-separator character", () => {
    const policy = pathProfile(
      [{ pattern: "docs/?.md", decision: "allow" }],
      [{ pattern: "*", decision: "deny" }],
    );
    const exact = path.resolve(startupCwd, "docs/a.md");
    const tooLong = path.resolve(startupCwd, "docs/ab.md");
    expect(
      evaluatePathByPattern(
        exact,
        startupCwd,
        policy.readPaths,
        "deny",
        "read",
      ),
    ).toMatchObject({ decision: "allow" });
    expect(
      evaluatePathByPattern(
        tooLong,
        startupCwd,
        policy.readPaths,
        "deny",
        "read",
      ),
    ).toMatchObject({ decision: "deny" });
  });

  it("literal brackets count toward path specificity", () => {
    const policy = pathProfile(
      [{ pattern: "docs/[x]/**", decision: "allow" }],
      [{ pattern: "docs/*/**", decision: "deny" }],
    );
    const absolute = path.resolve(startupCwd, "docs/[x]/guide.md");
    expect(
      evaluatePathByPattern(
        absolute,
        startupCwd,
        policy.readPaths,
        "deny",
        "read",
      ),
    ).toMatchObject({ decision: "allow" });
  });

  it("custom tool resolution treats bare rules as a fallback", () => {
    const rules: CustomToolRule[] = [
      { decision: "ask" },
      { decision: "deny", match: { action: "deploy" } },
    ];

    expect(decideCustomTool({ action: "deploy" }, rules)).toMatchObject({
      decision: "deny",
    });
    expect(decideCustomTool({ action: "inspect" }, rules)).toMatchObject({
      decision: "ask",
    });
  });

  it("custom tool resolution prefers more constrained match objects", () => {
    const rules: CustomToolRule[] = [
      { decision: "deny", match: { action: "deploy" } },
      {
        decision: "allow",
        match: { action: "deploy", environment: "prod" },
      },
    ];

    expect(
      decideCustomTool({ action: "deploy", environment: "prod" }, rules),
    ).toMatchObject({ decision: "allow" });
  });

  it("custom tool resolution prefers more literal patterns when match shapes tie", () => {
    const rules: CustomToolRule[] = [
      { decision: "allow", match: { action: "deploy" } },
      { decision: "deny", match: { action: "depl?y" } },
    ];

    expect(decideCustomTool({ action: "deploy" }, rules)).toMatchObject({
      decision: "allow",
    });
  });

  it("custom tool resolution breaks ties by composition order", () => {
    const base = {
      tools: { deploy: [{ decision: "deny", match: { action: "deploy" } }] },
      readPaths: [{ pattern: "*", decision: "allow" }],
      writePaths: [{ pattern: "*", decision: "allow" }],
    } satisfies ProfilePolicy;
    const child = extendProfile(base, {
      tools: { deploy: [{ decision: "allow", match: { action: "deploy" } }] },
    });

    expect(
      decideCustomTool({ action: "deploy" }, child.tools.deploy ?? []),
    ).toMatchObject({
      decision: "allow",
    });
  });

  it("warns for ordinary rule conflicts using the single-extends API", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const base = {
      tools: { bash: [{ pattern: "git status", decision: "allow" }] },
      readPaths: [{ pattern: "*", decision: "allow" }],
      writePaths: [{ pattern: "*", decision: "allow" }],
    } satisfies ProfilePolicy;

    extendProfile(base, {
      tools: { bash: [{ pattern: "git status", decision: "deny" }] },
    });

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("warns for semantically identical custom-tool conflicts regardless of property order", () => {
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const base = {
      tools: {
        deploy: [
          {
            decision: "allow",
            match: { action: "deploy", environment: "prod" },
          },
        ],
      },
      readPaths: [{ pattern: "*", decision: "allow" }],
      writePaths: [{ pattern: "*", decision: "allow" }],
    } satisfies ProfilePolicy;

    extendProfile(base, {
      tools: {
        deploy: [
          {
            decision: "deny",
            match: { environment: "prod", action: "deploy" },
          },
        ],
      },
    });

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("protected layer short-circuits read, write, and bash path-operand evaluation regardless of ordinary rules", () => {
    const policy = {
      ...bashProfile([{ pattern: "*", decision: "allow" }]),
      writePaths: [{ pattern: "*", decision: "allow" }],
      protectedPathPatterns: ["**/.env*"],
      protectedPathExceptions: [],
    } as ProfilePolicy & {
      protectedPathPatterns: string[];
      protectedPathExceptions: string[];
    };
    const absolute = path.resolve(startupCwd, ".env");
    expect(
      evaluatePathByPattern(
        absolute,
        startupCwd,
        policy.readPaths,
        "allow",
        "read",
        policy.protectedPathPatterns,
        policy.protectedPathExceptions,
      ),
    ).toMatchObject({ decision: "deny" });
    expect(
      evaluatePathByPattern(
        absolute,
        startupCwd,
        policy.writePaths,
        "allow",
        "write",
        policy.protectedPathPatterns,
        policy.protectedPathExceptions,
      ),
    ).toMatchObject({ decision: "deny" });
    expect(
      decideBashPathReferences(
        ["cat .env"],
        startupCwd,
        startupCwd,
        policy,
        policy.protectedPathPatterns,
        policy.protectedPathExceptions,
      ),
    ).toMatchObject({ decision: "deny" });
  });
});
