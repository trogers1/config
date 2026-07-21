import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  decideBash,
  extractShellCommands,
  gateBash,
  matchesGlobPattern,
  splitShellCommands,
} from "../extensions/permissions";
import { policyConfig } from "../modules/policy";
import type { ProfilePolicy } from "../modules/policyHelpers";

const parserPolicy = {
  tools: {
    bash: [
      { pattern: "*", decision: "ask" },
      { pattern: "git *", decision: "ask" },
      { pattern: "git status *", decision: "allow" },
      { pattern: "git checkout *", decision: "deny" },
      { pattern: "cd", decision: "allow" },
      { pattern: "cd *", decision: "allow" },
      { pattern: "ls", decision: "allow" },
      { pattern: "ls *", decision: "allow" },
      { pattern: "printf *", decision: "allow" },
    ],
  },
  bashPathReferences: [
    { pattern: "*", decision: "allow" },
    { pattern: "..", decision: "ask" },
    { pattern: "../**", decision: "ask" },
  ],
} satisfies ProfilePolicy;

function context(cwd: string, confirm = true) {
  return {
    cwd,
    hasUI: true,
    ui: {
      confirm: vi.fn().mockResolvedValue(confirm),
      editor: vi.fn().mockResolvedValue(undefined),
      setWorkingVisible: vi.fn(),
    },
  } as unknown as ExtensionContext;
}

describe("shell policy parser", () => {
  it("uses the final matching rule", () => {
    expect(decideBash("git status --short", parserPolicy)).toBe("allow");
    expect(decideBash("git checkout main", parserPolicy)).toBe("deny");
    expect(decideBash("python scripts/build.py", parserPolicy)).toBe("ask");
  });

  it("does not split quoted separators", () => {
    expect(
      splitShellCommands('printf "a;b && c || d | e" && git status --short'),
    ).toEqual(['printf "a;b && c || d | e"', "git status --short"]);
  });

  it("finds substitutions while treating single-quoted text as inert", () => {
    expect(
      extractShellCommands(
        "printf '$(git checkout inert)' && echo \"$(git checkout active)\"",
      ),
    ).toContain("git checkout active");
    expect(
      extractShellCommands("printf '$(git checkout inert)'")
        .join(" ")
        .includes("git checkout inert"),
    ).toBe(true);
    // The inert text remains part of printf, but is not emitted as its own command.
    expect(
      extractShellCommands("printf '$(git checkout inert)'").filter(
        (command) => command === "git checkout inert",
      ),
    ).toEqual([]);
  });

  it("denies a compound command when any parsed segment is denied", async () => {
    const result = await gateBash(
      "git status --short && git checkout main",
      process.cwd(),
      context(process.cwd()),
      parserPolicy,
    );

    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("git checkout main");
  });

  it("denies commands hidden in both substitution syntaxes", async () => {
    for (const command of [
      'echo "$(git checkout main)"',
      "echo `git checkout main`",
    ]) {
      await expect(
        gateBash(command, process.cwd(), context(process.cwd()), parserPolicy),
      ).resolves.toMatchObject({ block: true });
    }
  });

  it("enforces profile-configured protected path patterns for Bash readers", async () => {
    const policy = {
      ...parserPolicy,
      protectedPathPatterns: ["**/.db"],
    } satisfies ProfilePolicy;

    const result = await gateBash(
      "cat .db",
      process.cwd(),
      context(process.cwd()),
      policy,
    );
    expect(result).toMatchObject({ block: true });
    expect(result?.reason).toContain("protected from disclosure and mutation");
  });

  it("simulates cwd changes before evaluating later path references", async () => {
    const startupCwd = path.join(process.cwd(), "project");
    const ctx = context(startupCwd);

    await expect(
      gateBash(
        "cd docs && cd drafts && ls ../../..",
        startupCwd,
        ctx,
        parserPolicy,
      ),
    ).resolves.toBeUndefined();
    expect(vi.mocked(ctx.ui.confirm).mock.calls).toHaveLength(1);
  });

  it("supports root, nested, and outside glob paths", () => {
    expect(matchesGlobPattern("**/.env", ".env")).toBe(true);
    expect(matchesGlobPattern("**/.env", "app/.env")).toBe(true);
    expect(matchesGlobPattern("**/.git/**", ".git/config")).toBe(true);
    expect(matchesGlobPattern("../**", "../other/file.txt")).toBe(true);
  });
});

describe("default profile bash policy", () => {
  it.each([
    "git tag --sort=version:refname",
    "git tag --sort version:refname",
    "git tag -l",
    "git tag --list",
    "git tag --contains v1.0.0",
    "git tag --merged main",
  ])("allows %s", (command) => {
    expect(decideBash(command, policyConfig.profiles.default)).toBe("allow");
  });

  it.each([
    "git tag -a v1.0.0",
    "git tag -d v1.0.0",
    "git tag -m 'message' v1.0.0",
    "git tag --delete v1.0.0",
  ])("denies %s", (command) => {
    expect(decideBash(command, policyConfig.profiles.default)).toBe("deny");
  });
});
