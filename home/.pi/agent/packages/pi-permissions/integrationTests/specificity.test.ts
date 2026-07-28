/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decideBash } from "../extensions/permissions";
import { extendProfile } from "../modules/policyHelpers";
import type {
  ProfilePolicy,
  ReadPathRule,
  Rule,
  WritePathRule,
} from "../modules/policyHelpers";
import { evaluatePathByPattern } from "../modules/shell/pathPolicy";
import * as pathPolicy from "../modules/shell/pathPolicy";

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
  it.fails(
    "git branch --list allow beats git branch * deny even when the deny is declared last",
    () => {
      const policy = bashProfile([
        { pattern: "git branch --list", decision: "allow" },
        { pattern: "git branch *", decision: "deny" },
      ]);
      expect(decideBash("git branch --list", policy)).toBe("allow");
    },
  );

  it.fails(
    "npm exec * deny beats npm * ask even when ask is declared last",
    () => {
      const policy = bashProfile([
        { pattern: "npm exec *", decision: "deny" },
        { pattern: "npm *", decision: "ask" },
      ]);
      expect(decideBash("npm exec cowsay", policy)).toBe("deny");
    },
  );

  it.fails(
    "find -delete guard beats find * allow even when allow is declared last",
    () => {
      const policy = bashProfile([
        { pattern: "find * -delete *", decision: "deny" },
        { pattern: "find *", decision: "allow" },
      ]);
      expect(decideBash("find . -delete", policy)).toBe("deny");
    },
  );

  it.fails(
    'echo "---" allow beats echo * deny even when deny is declared last',
    () => {
      const policy = bashProfile([
        { pattern: 'echo "---"', decision: "allow" },
        { pattern: "echo *", decision: "deny" },
      ]);
      expect(decideBash('echo "---"', policy)).toBe("allow");
    },
  );

  it.fails(
    "* is a true fallback that only decides when nothing else matches",
    () => {
      const policy = bashProfile([
        { pattern: "specific", decision: "allow" },
        { pattern: "*", decision: "deny" },
      ]);
      expect(decideBash("specific", policy)).toBe("allow");
      expect(decideBash("other", policy)).toBe("deny");
    },
  );

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

  it.fails(
    "readPaths allow a specific subpath under a broad deny even when the allow is declared first",
    () => {
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
    },
  );

  it.fails(
    "writePaths allow a specific subpath under a broad deny even when the allow is declared first",
    () => {
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
    },
  );

  it.fails(
    "longer literal character count wins when literal token count ties, regardless of order",
    () => {
      const policy = bashProfile([
        { pattern: "git * --short", decision: "deny" },
        { pattern: "git status *", decision: "allow" },
      ]);
      expect(decideBash("git status --short", policy)).toBe("deny");
    },
  );

  it.fails(
    "protected layer short-circuits every stage regardless of ordinary rules",
    () => {
      const policy = bashProfile([]) as ProfilePolicy & {
        protectedPathRules: Rule[];
      };
      policy.protectedPathRules = [
        { pattern: "**/.env*", decision: "deny", guidance: "protected" },
      ];
      expect(
        // @ts-expect-error future protected-path resolution API
        pathPolicy.evaluateProtectedPath(".env", policy).decision,
      ).toBe("deny");
      // Phase 5 TODO: also assert the deny beats ordinary allows for read, edit, write and bash path-operands.
    },
  );
});
